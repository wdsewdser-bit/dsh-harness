// Offline unit tests for step-level preemption (instant-preempt, phase 1); pure, node --test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../index.mjs';
import { handleTool } from '../tools.mjs';
import { admit, classify, PreemptWatcher, installPreempt } from '../preempt.mjs';
import { snapshot } from '../snapshot.mjs';
import { recordInjection } from '../provenance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../runs');

/** One durable team with two members, in a throwaway store the test removes afterwards. */
function team(label) {
  const dir = fs.mkdtempSync(path.join(root, 'preempt-unit-' + label + '-'));
  const store = new ControlStore(dir);
  const core = new TeamCore(store, {}, { enabled: true });
  core.member('member:root', 'root');
  core.member('member:a', 'worker');
  core.member('member:b', 'worker');
  const deliveries = [];
  core.notifyDelivery = (memberId, messageId) => deliveries.push({ memberId, messageId });
  return { dir, store, core, deliveries, close() { core.store.close?.(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const operation = suffix => 'v1:operation:preempt-' + suffix;

/**
 * A stand-in for the driver: the only two methods the watcher is allowed to use. `phase` decides whether the
 * driver is idle (a delivery can open a turn) or running (a delivery can only preempt a live step).
 */
function driver(script = [true, true], options = {}) {
  const calls = [];
  const wakes = [];
  const agent = { calls, wakes, phase: { kind: options.phase ?? 'idle' },
    preemptStep(reason) { calls.push(reason); const answer = script.length > 1 ? script.shift() : script[0]; return answer; } };
  if (options.surface !== false) agent.wakeDriver = () => wakes.push(Date.now());
  if (options.wakeThrows) agent.wakeDriver = () => { wakes.push(Date.now()); throw Error('DRIVER_WAKING_DOWN'); };
  return agent;
}
/** A driver from a build without the candidate: no preemptStep at all, so nothing may wake it either. */
function plainDriver() { return { phase: { kind: 'idle' } }; }

test('a delivery is announced only after its commit, and a refused send announces nothing', () => {
  const t = team('delivery');
  try {
    const receipt = t.core.send('member:a', 'member:b', 'info', 'hello');
    assert.equal(t.deliveries.length, 1);
    assert.equal(t.deliveries[0].memberId, 'member:b');
    // The row the listener reads is the committed one, not a pending value: that is what makes a preemption safe.
    const stored = t.store.read(t.deliveries[0].messageId);
    assert.equal(stored.status, 'stored');
    assert.equal(receipt.result.entityId, t.deliveries[0].messageId);
    assert.throws(() => t.core.send('member:a', 'member:ghost', 'info', 'x'), /UNKNOWN_MEMBER/);
    assert.equal(t.deliveries.length, 1, 'a rolled-back send must never wake anyone');
  } finally { t.close(); }
});

test('the model tool path announces a send too, and only once the transaction returned', () => {
  const t = team('tool');
  try {
    t.core.task('task:a', 'member:a');
    const binding = t.core.schedule('event:a', 'task:a').result;
    const receipt = handleTool(t.core, { actor: 'member:a', ...binding }, 'team_message',
      { operationId: operation('tool-send'), expectedRevision: 0, op: 'send', to: 'member:b', kind: 'info', summary: 'x' });
    assert.equal(t.deliveries.length, 1);
    assert.equal(t.deliveries[0].messageId, receipt.result.entityId);
    assert.equal(t.store.read(receipt.result.entityId).status, 'stored');
    assert.throws(() => handleTool(t.core, { actor: 'member:a', ...binding }, 'team_message',
      { operationId: operation('tool-send-ghost'), expectedRevision: 0, op: 'send', to: 'member:ghost', kind: 'info', summary: 'x' }),
      /UNKNOWN_MEMBER/);
    assert.equal(t.deliveries.length, 1);
  } finally { t.close(); }
});

test('admit refuses every state in which a preemption must not happen', () => {
  const t = team('admit');
  try {
    const message = t.core.send('member:root', 'member:b', 'info', 'ping').result;
    assert.deepEqual(admit(t.core, 'member:b', message), { ok: true, reason: null });
    assert.equal(admit(t.core, 'member:ghost', message).reason, 'notMember');
    // A non-member sender cannot move a member: only peers, root and operator can.
    assert.equal(admit(t.core, 'member:b', { sender: 'external:thing' }).reason, 'notMemberMessage');
    // The three accepted classes are explicit, and a scheduler tick is none of them.
    assert.equal(classify(t.core, message), 'memberMessage');
    assert.equal(classify(t.core, { plugin: 'team-tools-v2-r10', form: 'action' }), 'teamWake');
    assert.equal(classify(t.core, { role: 'user', source: { kind: 'user' } }), 'userInput');
    assert.equal(classify(t.core, { kind: 'admission', sender: 'scheduler' }), null);
    assert.equal(admit(t.core, 'member:b', { plugin: 'team-tools-v2-r10', form: 'action' }).ok, true);
    assert.equal(admit(t.core, 'member:b', { role: 'user', source: { kind: 'user' } }).ok, true);
    t.core.mutate('member:b', 'root', {}, (tx, member) => tx.put('member:b', { ...member, desired: 'frozen' }));
    assert.equal(admit(t.core, 'member:b', message).reason, 'notActive');
    t.core.mutate('member:b', 'root', {}, (tx, member) => tx.put('member:b', { ...member, desired: 'active' }));
    assert.deepEqual(admit(t.core, 'member:b', message), { ok: true, reason: null });
    // A completion freeze stops every write in the team, so the extra request would be spent on a frozen turn.
    t.core.mutate('completion:c1', 'root', {}, tx => tx.put('completion:c1', { status: 'prepared' }));
    assert.equal(admit(t.core, 'member:b', message).reason, 'frozen');
  } finally { t.close(); }
});

test('admit refuses an exhausted budget and counts the refusal', () => {
  const t = team('budget');
  try {
    const message = t.core.send('member:root', 'member:b', 'info', 'ping').result;
    t.core.configuration.budgetExhausted = true;
    assert.equal(admit(t.core, 'member:b', message).reason, 'budget');
    const watcher = new PreemptWatcher(t.core, { now: () => 0 });
    watcher.bind('member:b', driver());
    assert.deepEqual(watcher.onMail('member:b', message.entityId), { fired: false, reason: 'budget' });
    assert.equal(watcher.snapshot().refused.budget, 1);
  } finally { t.close(); }
});

test('one preemption per step, and two triggers inside the window produce one request', () => {
  const t = team('coalesce');
  try {
    const first = t.core.send('member:root', 'member:b', 'info', 'one').result;
    const second = t.core.send('member:root', 'member:b', 'info', 'two').result;
    let clock = 10000;
    const watcher = new PreemptWatcher(t.core, { now: () => clock });
    // R7-2: the merge window is a property of a live turn, so this fixture is a running driver - an idle one would
    // (correctly) go to the idle edge instead of folding the delivery into a turn that no longer exists.
    const agent = driver([true, false, true], { phase: 'running' });
    watcher.bind('member:b', agent);
    assert.deepEqual(watcher.onMail('member:b', first.entityId), { fired: true, reason: null });
    // Same instant: the second delivery is folded into the request the first one already bought.
    assert.deepEqual(watcher.onMail('member:b', second.entityId), { fired: false, reason: 'coalesced' });
    clock = 13000;
    // The driver says no here (a step already preempted, or the member is idle); the message stays queued and
    // is counted as notLive, never folded into a request that does not exist. Both messages are kind info, so
    // the mailbox never becomes "ready" and no wake is attempted: this isolates the coalesce rule.
    assert.deepEqual(watcher.onMail('member:b', first.entityId), { fired: false, reason: 'notLive' });
    assert.equal(watcher.snapshot().woke, 0, 'an info delivery has nothing to wake a member for');
    clock = 16000;
    assert.deepEqual(watcher.onMail('member:b', second.entityId), { fired: true, reason: null });
    const counts = watcher.snapshot();
    assert.equal(counts.preempts, 2);
    assert.equal(counts.coalesced, 1, 'only the delivery inside the 2s window is folded');
    assert.equal(counts.notLive, 1, 'a delivery with no live step is not a coalesce');
    assert.equal(agent.calls.length, 3, 'the driver is asked once per delivery, never per retry');
    assert.deepEqual(agent.calls, ['team-message', 'team-message', 'team-message']);
  } finally { t.close(); }
});

test('the watcher reads committed state, so a delivery that arrives while idle is not lost', () => {
  const t = team('idle');
  try {
    const watcher = new PreemptWatcher(t.core, { now: () => 0 });
    const agent = driver([false, true]);
    watcher.bind('member:b', agent);
    const message = t.core.send('member:root', 'member:b', 'info', 'while idle').result;
    // Nothing is live: the delivery is counted as notLive, but it is still durable and the next delivery fires.
    assert.equal(watcher.onMail('member:b', message.entityId).fired, false);
    assert.equal(watcher.snapshot().notLive, 1);
    assert.equal(watcher.snapshot().coalesced, 0);
    assert.equal(watcher.onMail('member:b', message.entityId).fired, true);
    // A message id that no longer exists cannot move anyone: the check is against the store, not the argument.
    assert.equal(watcher.onMail('member:b', 'message:not-there').fired, false);
    assert.equal(watcher.snapshot().refused.notMemberMessage, 1);
  } finally { t.close(); }
});

test('a real delivery to an idle member opens its next turn instead of waiting for an outside boundary', () => {
  const t = team('wake');
  try {
    // An action message is what makes the recipient ready: an info note would spend a request on nothing.
    const message = t.core.send('member:root', 'member:b', 'action', 'do the thing',
      { expectedOutcome: 'produce the artifact', deadline: new Date(Date.now() + 300000).toISOString() }).result;
    assert.equal(t.core.ready('member:b'), true, 'an invisible action message is a readiness the member must act on');
    const watcher = new PreemptWatcher(t.core, { now: () => 0 });
    const agent = driver([false], { phase: 'idle' });
    watcher.bind('member:b', agent);
    // No live step, so no preemption: the old code stopped here and the member sat on the message until its
    // harness happened to start a turn. That wait is exactly the 5-6s the real c2 run measured.
    assert.deepEqual(watcher.onMail('member:b', message.entityId), { fired: false, reason: 'woke' });
    assert.equal(agent.calls.length, 1, 'the driver was still asked first, so a live step keeps its preemption');
    assert.equal(agent.wakes.length, 1, 'the idle driver was woken exactly once');
    assert.equal(watcher.snapshot().woke, 1);
    assert.equal(watcher.snapshot().notLive, 1, 'notLive still counts every delivery that had no live step');
    assert.equal(watcher.snapshot().preempts, 0, 'a wake is not a preemption and must never be reported as one');
    // The delivery stays durable and still invisible until the woken turn reaches its own request boundary.
    assert.equal(t.store.read(message.entityId).status, 'stored');
    assert.equal(t.core.ready('member:b'), true);
  } finally { t.close(); }
});

test('an idle delivery is not woken when there is nothing to wake for, or when the driver is running', () => {
  const t = team('wake-guard');
  try {
    const info = t.core.send('member:root', 'member:b', 'info', 'just so you know').result;
    const watcher = new PreemptWatcher(t.core, { now: () => 0 });
    const idle = driver([false], { phase: 'idle' });
    watcher.bind('member:b', idle);
    assert.deepEqual(watcher.onMail('member:b', info.entityId), { fired: false, reason: 'notLive' });
    assert.equal(idle.wakes.length, 0, 'an info note is not a reason to spend a request');
    // A running driver is never woken: its wake would be a latch, and the step it belongs to already refused.
    const action = t.core.send('member:root', 'member:b', 'action', 'real work',
      { expectedOutcome: 'produce', deadline: new Date(Date.now() + 300000).toISOString() }).result;
    const running = driver([false], { phase: 'running' });
    const second = new PreemptWatcher(t.core, { now: () => 0 });
    second.bind('member:b', running);
    assert.deepEqual(second.onMail('member:b', action.entityId), { fired: false, reason: 'notLive' });
    assert.equal(running.wakes.length, 0, 'a running phase is preempted, never woken');
    assert.equal(second.snapshot().notLive, 1);
    assert.equal(second.snapshot().woke, 0);
  } finally { t.close(); }
});

test('a maintenance phase is neither a live turn nor an idle edge', () => {
  const t = team('maintenance');
  try {
    // Upstream's third phase (runMaintenance): no turn is executing, the phase returns to idle by itself, and a message
    // in the team store never starts one. It is neither "running" nor "idle", and both wrong readings confirm a
    // delivery against an activity that never consumes it.
    const action = t.core.send('member:root', 'member:b', 'action', 'real work',
      { expectedOutcome: 'produce', deadline: new Date(Date.now() + 300000).toISOString() }).result;
    const watcher = new PreemptWatcher(t.core, { now: () => 10000 });
    const agent = driver([false], { phase: 'maintenance' });
    watcher.bind('member:b', agent);
    const outcome = watcher.deliverMail('member:b', action.entityId);
    assert.equal(outcome.wake, 'notExecuting', 'maintenance has no merge target');
    assert.equal(outcome.dispatched, false, 'and nothing may claim a dispatch');
    assert.equal(outcome.phase, 'maintenance', 'the reason names the upstream phase');
    assert.equal(agent.calls.length, 0, 'a maintenance phase is never asked to preempt a step');
    assert.equal(agent.wakes.length, 0, 'the background job owns the agent: it is never woken');
    assert.equal(watcher.snapshot().notExecuting, 1);
    assert.equal(watcher.snapshot().coalesced, 0, 'nothing is merged into a turn that does not exist');
    assert.equal(watcher.snapshot().notLive, 0, 'a non-executing phase is counted apart from a missed live step');
    // A dispatch or an intent result must not be confirmed against the job either.
    const wake = watcher.wakeIdle('member:b');
    assert.equal(wake.fired, false);
    assert.equal(wake.reason, 'notExecuting');
    assert.equal(agent.wakes.length, 0);
    // The job ends and upstream returns the agent to idle: the same delivery is then a real wake.
    agent.phase = { kind: 'idle' };
    const late = watcher.deliverMail('member:b', action.entityId);
    assert.equal(late.wake, 'woke');
    assert.equal(late.dispatched, true);
    assert.equal(agent.wakes.length, 1, 'the delivery is woken by its own retry once the job is over');
  } finally { t.close(); }
});

test('a build without the preemption surface is never woken, and a failed wake loses nothing', () => {
  const t = team('wake-surface');
  try {
    const action = t.core.send('member:root', 'member:b', 'action', 'real work',
      { expectedOutcome: 'produce', deadline: new Date(Date.now() + 300000).toISOString() }).result;
    const watcher = new PreemptWatcher(t.core, { now: () => 0 });
    // A C1 agent has no preemptStep and no candidate wake path, so its behaviour must stay exactly as before.
    watcher.bind('member:b', plainDriver());
    assert.deepEqual(watcher.onMail('member:b', action.entityId), { fired: false, reason: 'noPreemptSurface' });
    assert.equal(watcher.snapshot().notLive, 0, 'C1 must not acquire the new counter');
    assert.equal(watcher.snapshot().woke, 0);
    // A driver that throws while shutting down must not turn a delivery into a lost message.
    const throwing = driver([false], { phase: 'idle', wakeThrows: true });
    watcher.bind('member:b', throwing);
    assert.deepEqual(watcher.onMail('member:b', action.entityId), { fired: false, reason: 'notLive' });
    assert.equal(throwing.wakes.length, 1);
    assert.equal(watcher.snapshot().woke, 0, 'a failed wake is not counted as a wake');
    assert.equal(watcher.snapshot().notLive, 1);
    assert.equal(t.store.read(action.entityId).status, 'stored', 'the message is still durable and still claimable');
    assert.equal(t.core.ready('member:b'), true);
  } finally { t.close(); }
});

test('the wake port is the driver"s own idle edge, and it is only called when the mailbox is ready', () => {
  const t = team('wake-port');
  try {
    const woken = [];
    const watcher = new PreemptWatcher(t.core, { now: () => 0, wake: agent => { woken.push(agent); return true; } });
    const agent = driver([false], { phase: 'idle' });
    watcher.bind('member:b', agent);
    const action = t.core.send('member:root', 'member:b', 'action', 'real work',
      { expectedOutcome: 'produce', deadline: new Date(Date.now() + 300000).toISOString() }).result;
    watcher.onMail('member:b', action.entityId);
    assert.deepEqual(woken, [agent], 'the injected wake port replaced the driver call entirely');
    assert.equal(agent.wakes.length, 0);
    // Once the recipient has already observed the message, there is nothing to wake for. A visible fact needs the
    // source the request really carried (invariant 8), so the evidence names the injected manifest.
    const candidate = snapshot(t.core, 'member:b');
    recordInjection(t.core, candidate, 'native:preempt-wake', ['test-seq']);
    t.core.visible(action.entityId, { requestId: 'request-1', manifestHash: candidate.manifest.hash, sessionSeq: 1,
      requestedAt: Date.now() });
    assert.equal(t.core.ready('member:b'), false);
    assert.deepEqual(watcher.onMail('member:b', action.entityId), { fired: false, reason: 'notLive' });
    assert.equal(woken.length, 1);
  } finally { t.close(); }
});

test('installPreempt owns the delivery hook and unbinds with the agent', () => {
  const t = team('install');
  try {
    const watcher = installPreempt(undefined, t.core);
    assert.equal(t.core.preempt, watcher);
    assert.equal(typeof t.core.notifyDelivery, 'function');
    const agent = driver([true]);
    watcher.bind('member:b', agent);
    t.core.send('member:root', 'member:b', 'info', 'wake');
    assert.equal(watcher.snapshot().preempts, 1);
    watcher.unbind('member:b');
    t.core.send('member:root', 'member:b', 'info', 'after dispose');
    assert.equal(watcher.snapshot().preempts, 1, 'a disposed member is never preempted');
    assert.deepEqual(watcher.onMail('member:b', 'message:x'), { fired: false, reason: 'notBound' });
  } finally { t.close(); }
});
