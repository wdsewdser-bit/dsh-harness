import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore, DEFER_BASE_MS, DEFER_CAP_MS } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
import { evidenceOf } from '../src/effects/protocol.mjs';
import { createClock } from '../src/clock.mjs';
import { profile, until } from '../test-support/profile.mjs';

/**
 * F1 round 9: the r8 finding about the retry budget.
 *
 *   R9-0  deferred is its own durable outcome: normalization recognises it, the protected close-out refunds exactly the
 *         try this claim took (fence stays monotonic, tries are never cleared) and schedules a positive, capped backoff.
 *   R9-1  a delivery that waits out a 30s+ maintenance is deferred, never confirmed, never dead-lettered and never
 *         wakes the native agent; when the job ends the product cycle dispatches it exactly once - no operator command,
 *         no extra team.wake.
 *   R9-2  the wait is discovered after the claim too (maintenance begins between the pre-claim check and the port): the
 *         same deferred close-out applies and the try is given back.
 *   R9-3/4/5  stop, a completion freeze and a generation change during the wait never wake the member; a refused wake
 *         is still bounded (dead-letter on the fifth try) and a raising driver is still unknown - deferred never
 *         becomes a licence for unlimited automatic retries.
 *
 * The clock is the host's own: real timers, controlled now(), so "thirty seconds of maintenance" is thirty seconds of
 * host decisions across many cycles, without waiting for them.
 */
function instrumented(options = {}) {
  const control = { wakes: [], preempts: [], wakeMode: 'ok', maintenanceOnPreemptStep: false, startInMaintenance: false };
  const base = Date.now();
  let offset = 0;
  const clock = createClock({ now: () => base + offset });
  control.clock = { advance(ms) { offset += ms; }, get at() { return base + offset; } };
  let counter = 0;
  return profile({ ...options, clock, simulateRequests: true }, async ({ ctx, sessions }) => {
    ctx.agents.create = async opts => {
      const sessionId = opts?.sessionId ?? 'session:agent-' + (++counter);
      const agent = {
        session: { id: sessionId, seq: 0, snapshotEvents: () => [] },
        phase: { kind: control.startInMaintenance ? 'maintenance' : 'idle' },
        preempted: false,
        wakeDriver() {
          if (control.wakeMode === 'refuse') return false;
          if (control.wakeMode === 'throw') throw Error('DRIVER_WAKING_DOWN');
          control.wakes.push(sessionId);
          agent.phase = { kind: 'running' };
          agent.preempted = false;
        },
        preemptStep() {
          // The race R9-2 needs: the maintenance phase begins after the pre-claim check, while the port is deciding.
          if (control.maintenanceOnPreemptStep) { control.maintenanceOnPreemptStep = false; agent.phase = { kind: 'maintenance' }; return false; }
          if (agent.phase.kind !== 'running' || agent.preempted) return false;
          control.preempts.push(sessionId);
          agent.preempted = true;
          return true;
        },
        cancel() {}, async whenIdle() {},
        ctx: { tools: { register() {}, restrict() {}, guard() {} } },
      };
      sessions.set(sessionId, agent.session);
      return { agent, dispose: async () => {} };
    };
  }).then(w => Object.assign(w, { control }));
}
const command = (w, name, entityId, extra = {}) => w.runtime.host.command({ teamId: w.runtime.host.teamId,
  actor: 'root', requestId: entityId, operationId: 'v1:operation:' + entityId.replaceAll(':', '-').padEnd(20, 'x'),
  payload: { command: name, entityId, ...extra } });
const wakesOf = (w, sessionId) => w.control.wakes.filter(id => id === sessionId).length;
const endTurn = agent => { agent.phase = { kind: 'idle' }; agent.preempted = false; };
const enterMaintenance = agent => { agent.phase = { kind: 'maintenance' }; };
const send = (w, to, summary) => w.runtime.host.executeAuthorized('business', () => w.runtime.core.send('member:root', to,
  'action', summary, { expectedOutcome: 'a report', deadline: new Date(Date.now() + 60000).toISOString() }).result.entityId);
const effectOf = (w, id) => w.runtime.store.effects().find(row => row.id === id);
const receiptOf = (w, id) => w.runtime.store.read('wake-receipt:' + id + ':member:w');
async function started(w) {
  command(w, 'team.member.request', 'member-intent:w', { role: 'worker' });
  await until(() => w.runtime.store.read('member-intent:w')?.status === 'confirmed');
  command(w, 'team.task.request', 'task:w', { owner: 'member:w' });
  await until(() => w.runtime.store.list('attempt:').some(row => row.status === 'running'));
  const agent = w.runtime.handles.get('member:w').agent;
  await until(() => wakesOf(w, agent.session.id) === 1);
  return agent;
}
/** Let the host's own cycles run for a controlled span of logical time. */
async function waitThrough(w, ms, step = 2000) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    w.control.clock.advance(step);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('R9-0 deferred is its own durable outcome: one try refunded, capped backoff, fence kept', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r9-defer-'));
  const store = new ControlStore(root);
  const core = new TeamCore(store, {}, { enabled: true });
  try {
    assert.deepEqual(evidenceOf({ deferred: true, reason: 'maintenance' }), { deferred: true, reason: 'maintenance' });
    assert.equal(evidenceOf({ deferred: true, executed: true }).unknown, true, 'deferred is never combined with another state');
    core.mutate('seed', 'root', {}, tx => tx.outbox('effect:d', { kind: 'wake' }));
    const claim = at => store.claim(core.command('effect:d', 'scheduler', { effectId: 'effect:d' }), 'effect:d', 'adapter', at);
    const settle = (fence, at) => store.settle(core.command('effect:d', 'adapter', { effectId: 'effect:d' }), 'effect:d', fence,
      { deferred: true, reason: 'maintenance' }, null, at);
    let row = claim(1000);
    assert.equal(row.result.tries, 1);
    let next = settle(row.result.fence, 1000);
    assert.equal(next.result.status, 'retryable');
    assert.equal(next.result.tries, 0, 'exactly this claim\'s try was refunded');
    assert.equal(next.result.fence, row.result.fence, 'the fence stays monotonic');
    assert.equal(next.result.defers, 1);
    assert.equal(next.result.nextDue, 1000 + DEFER_BASE_MS, 'a positive delay is persisted');
    assert.equal(store.read('effect:d').tries, 0, 'the durable row carries the refund');
    // A second wait doubles the delay and keeps the same accounting; the cap bounds it.
    const again = claim(5000);
    next = settle(again.result.fence, 5000);
    assert.equal(next.result.tries, 0);
    assert.equal(next.result.fence, again.result.fence);
    assert.equal(next.result.nextDue, 5000 + DEFER_BASE_MS * 2);
    for (let i = 0; i < 12; i++) {
      const c = claim(100000 + i * 100000);
      next = settle(c.result.fence, 100000 + i * 100000);
      assert.ok(next.result.nextDue - (100000 + i * 100000) <= DEFER_CAP_MS, 'the delay is capped');
    }
    assert.ok(next.result.defers > 2);
    // The failure path is unchanged: a proven non-execution still spends a try and still dead-letters.
    const failing = claim(9000000);
    assert.equal(failing.result.tries, 1);
    const failed = store.settle(core.command('effect:d', 'adapter', { effectId: 'effect:d' }), 'effect:d', failing.result.fence, { notExecuted: true,
      reason: 'refused' }, null, 9000000);
    assert.equal(failed.result.status, 'retryable');
    assert.equal(failed.result.tries, 1, 'a refusal keeps its try');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('R9-1 a delivery waits out a 30s+ maintenance without spending tries, then the cycle dispatches it once', async () => {
  const w = await instrumented();
  try {
    const agent = await started(w);
    endTurn(agent);
    enterMaintenance(agent);
    const messageId = send(w, 'member:w', 'M1 during a long maintenance');
    await until(() => (effectOf(w, messageId)?.defers ?? 0) >= 1);
    const first = effectOf(w, messageId);
    assert.equal(first.tries, 0, 'the wait was decided before the claim: no try was spent');
    assert.match(first.lastEvidence.reason, /cannot run yet/, 'the wait was decided before the claim, not refunded after it');
    assert.equal(first.status, 'retryable');
    assert.ok(first.nextDue > w.control.clock.at, 'a positive delay is persisted');
    // 32 logical seconds across many host cycles; the job is still running the whole time.
    await waitThrough(w, 32000);
    const waited = effectOf(w, messageId);
    assert.notEqual(waited.status, 'confirmed', 'a maintenance wait is never confirmed');
    assert.notEqual(waited.status, 'dead-letter', 'a maintenance wait never exhausts the retry budget');
    assert.equal(waited.tries, 0, 'thirty seconds of waiting spent no try');
    assert.ok(waited.defers >= 2, 'the delivery was deferred repeatedly');
    assert.equal(receiptOf(w, messageId), null, 'no consumption receipt was written');
    assert.equal(wakesOf(w, agent.session.id), 1, 'the native wake was never called');
    assert.equal(w.control.preempts.length, 0, 'no step was preempted either');
    // The job ends and upstream returns the agent to idle by itself. Nothing else touches the message: the product's
    // own cycle has to dispatch it.
    endTurn(agent);
    w.control.clock.advance(12000);
    await until(() => effectOf(w, messageId)?.status === 'confirmed');
    const done = effectOf(w, messageId);
    assert.equal(done.lastEvidence.receipt.wake, 'woke');
    assert.equal(done.lastEvidence.receipt.dispatched, true);
    assert.equal(wakesOf(w, agent.session.id), 2, 'the cycle dispatched the delivery once');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(wakesOf(w, agent.session.id), 2, 'and only once');
    assert.equal(agent.phase.kind, 'running', 'the retried delivery opened a real turn');
  } finally { await w.close(); }
});

test('R9-2 a maintenance that begins after the claim refunds the try it took', async () => {
  const w = await instrumented();
  try {
    const agent = await started(w);
    endTurn(agent);
    // The pre-claim check sees an idle agent; the port then finds the maintenance phase, so the wait is discovered after
    // the claim and the protected close-out has to give the try back.
    w.control.maintenanceOnPreemptStep = true;
    const messageId = send(w, 'member:w', 'M2 maintenance begins mid-decision');
    await until(() => (effectOf(w, messageId)?.defers ?? 0) >= 1);
    const deferred = effectOf(w, messageId);
    assert.equal(deferred.lastEvidence.deferred, true, 'the port reported a deferral, not a failure');
    assert.equal(deferred.tries, 0, 'the claim\'s one try was refunded, not cleared to a new budget');
    assert.equal(deferred.status, 'retryable');
    assert.notEqual(deferred.fence, undefined, 'the fence row is still there and monotonic');
    assert.equal(receiptOf(w, messageId), null);
    assert.equal(wakesOf(w, agent.session.id), 1);
    // The job ends: the next cycle finishes the delivery.
    endTurn(agent);
    w.control.clock.advance(12000);
    await until(() => effectOf(w, messageId)?.status === 'confirmed');
    assert.equal(wakesOf(w, agent.session.id), 2);
  } finally { await w.close(); }
});

test('R9-3 a stop during the wait never wakes the member afterwards', async () => {
  const w = await instrumented();
  try {
    const agent = await started(w);
    endTurn(agent);
    enterMaintenance(agent);
    const messageId = send(w, 'member:w', 'M3 stopped while waiting');
    await until(() => (effectOf(w, messageId)?.defers ?? 0) >= 1);
    await w.runtime.host.stop();
    endTurn(agent);
    await waitThrough(w, 20000);
    assert.equal(wakesOf(w, agent.session.id), 1, 'a stopped host never wakes anyone');
    assert.notEqual(effectOf(w, messageId).status, 'confirmed');
    assert.equal(receiptOf(w, messageId), null);
  } finally { await w.close(); }
});

test('R9-4a a completion freeze during the wait keeps the wake away, and lifting it finishes the delivery', async () => {
  const w = await instrumented();
  try {
    const agent = await started(w);
    endTurn(agent);
    enterMaintenance(agent);
    const messageId = send(w, 'member:w', 'M4a frozen while waiting');
    await until(() => (effectOf(w, messageId)?.defers ?? 0) >= 1);
    w.runtime.host.executeAuthorized('business', () => w.runtime.core.mutate('completion:r9', 'root', {}, tx => tx.put('completion:r9', { status:
      'prepared' })));
    endTurn(agent);
    await waitThrough(w, 20000);
    assert.equal(wakesOf(w, agent.session.id), 1, 'no wake crosses the completion fence');
    assert.equal(receiptOf(w, messageId), null);
    assert.notEqual(effectOf(w, messageId).status, 'confirmed');
    w.runtime.host.executeAuthorized('business', () => w.runtime.core.mutate('completion:r9', 'root', {}, tx => tx.put('completion:r9', { status:
      'confirmed' })));
    w.control.clock.advance(12000);
    await until(() => effectOf(w, messageId)?.status === 'confirmed');
    assert.equal(wakesOf(w, agent.session.id), 2);
  } finally { await w.close(); }
});

test('R9-4b a generation change during the wait is a non-delivery, never a wake', async () => {
  const w = await instrumented();
  try {
    const agent = await started(w);
    endTurn(agent);
    enterMaintenance(agent);
    const messageId = send(w, 'member:w', 'M4b regenerated while waiting');
    await until(() => (effectOf(w, messageId)?.defers ?? 0) >= 1);
    w.runtime.host.executeAuthorized('business', () => w.runtime.core.mutate('member:w', 'scheduler', {},
      (tx, member) => tx.put('member:w', { ...member, generation: member.generation + 1 })));
    endTurn(agent);
    w.control.clock.advance(12000);
    await until(() => effectOf(w, messageId)?.status === 'confirmed');
    assert.equal(effectOf(w, messageId).lastEvidence.receipt.delivered, false, 'the stale generation is a notice, not a delivery');
    assert.equal(wakesOf(w, agent.session.id), 1, 'nothing was woken for the old generation');
    assert.equal(receiptOf(w, messageId), null);
  } finally { await w.close(); }
});

test('R9-6 the dispatch and wake edges defer too: nothing is dispatched into a maintenance phase', async () => {
  const w = await instrumented();
  try {
    // The agent is created already in maintenance: every producer of the attempt's first turn meets the job, not a turn.
    w.control.startInMaintenance = true;
    command(w, 'team.member.request', 'member-intent:w', { role: 'worker' });
    await until(() => w.runtime.store.read('member-intent:w')?.status === 'confirmed');
    command(w, 'team.task.request', 'task:w', { owner: 'member:w' });
    await until(() => w.runtime.store.list('attempt:').some(row => row.status === 'running'));
    const attempt = w.runtime.store.list('attempt:').find(row => row.status === 'running');
    const agent = w.runtime.handles.get('member:w').agent;
    assert.equal(agent.phase.kind, 'maintenance');
    const dispatchId = 'dispatch:' + attempt.entityId;
    await until(() => (effectOf(w, dispatchId)?.defers ?? 0) >= 1);
    assert.equal(effectOf(w, dispatchId).tries, 0, 'the dispatch wait spent no try');
    assert.equal(w.runtime.store.read('attempt-dispatch:' + attempt.entityId), null, 'no first-dispatch fact while the job owns the agent');
    assert.equal(wakesOf(w, agent.session.id), 0, 'the native wake was never called');
    // The wake port on a real message shares the same edge and must defer the same way.
    const messageId = send(w, 'member:w', 'M6 message for the wake port');
    command(w, 'team.wake', 'signal:r9', { messageId, recipient: 'member:w' });
    const wakeId = 'wake:' + messageId + ':member:w';
    await until(() => (effectOf(w, wakeId)?.defers ?? 0) >= 1);
    assert.equal(effectOf(w, wakeId).lastEvidence.deferred, true);
    assert.equal(wakesOf(w, agent.session.id), 0);
    // The job ends: the product cycle dispatches the attempt once and confirms every deferred effect.
    endTurn(agent);
    w.control.clock.advance(12000);
    await until(() => w.runtime.store.read('attempt-dispatch:' + attempt.entityId) !== null);
    await until(() => effectOf(w, wakeId)?.status === 'confirmed' && effectOf(w, messageId)?.status === 'confirmed');
    assert.equal(wakesOf(w, agent.session.id), 1, 'exactly one wake for the whole recovery');
  } finally { await w.close(); }
});

test('R9-5 a refused wake is still bounded and a raising driver is still unknown', async () => {
  const w = await instrumented();
  try {
    const agent = await started(w);
    endTurn(agent);
    w.control.wakeMode = 'refuse';
    const refused = send(w, 'member:w', 'M5 the driver refuses');
    for (let i = 0; i < 10 && effectOf(w, refused)?.status !== 'dead-letter'; i++) {
      w.control.clock.advance(2000);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    const dead = effectOf(w, refused);
    assert.equal(dead.status, 'dead-letter', 'a refusal keeps the bounded retry contract');
    assert.equal(dead.tries, 5);
    assert.equal(dead.defers ?? 0, 0, 'a refusal is never shelved as a maintenance wait');
    assert.equal(receiptOf(w, refused), null);
    assert.equal(wakesOf(w, agent.session.id), 1, 'a refusal never wakes');
    w.control.wakeMode = 'throw';
    const failed = send(w, 'member:w', 'M6 the driver raises');
    await until(() => effectOf(w, failed)?.status === 'unknown');
    assert.equal(effectOf(w, failed).lastEvidence.unknown, true);
    assert.equal(effectOf(w, failed).lastEvidence.deferred, undefined, 'an uncertain action is never deferred');
    assert.equal(receiptOf(w, failed), null);
  } finally { await w.close(); }
});
