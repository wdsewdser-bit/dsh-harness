import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { profile, until } from '../test-support/profile.mjs';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
import { TeamManager } from '../index.mjs';

/**
 * F1 round 5: the three blocking findings of the r4 review, on the production profile path.
 *
 *   R5-1  a registry owner is an existing identity: cold start never mints an empty Session under its id, so the
 *         offline log port reads the durable journal instead of a live session that proves nothing.
 *   R5-2  a successful start produces a durable first dispatch bound to its attempt, executed by the one wake
 *         consumer, and an ordinary message effect always closes with a receipt (never a missing adapter port).
 *   R5-3  an intent result addresses the execution that opened the intent; a released or superseded execution leaves
 *         the result in the journal and never wakes whatever agent happens to be bound now.
 *
 * Every case drives the production composition root (applyTeamProfile -> prepareHost -> activateHost -> the host's
 * own runner and pump). The native agent double distinguishes the two edges a consumer may take: an idle driver is
 * woken (one new turn) and a running driver is preempted at most once per step - it never answers true unconditionally.
 */
function instrumented(prepare = null) {
  const control = { wakes: [], preempts: [] };
  let counter = 0;
  return profile({ simulateRequests: true }, async ({ root, ctx, sessions }) => {
    ctx.agents.create = async options => {
      const sessionId = options?.sessionId ?? 'session:agent-' + (++counter);
      const agent = {
        session: { id: sessionId, seq: 0, snapshotEvents: () => [] },
        phase: { kind: 'idle' },
        preempted: false,
        wakeDriver() { control.wakes.push(sessionId); agent.phase = { kind: 'running' }; agent.preempted = false; },
        preemptStep() {
          control.preempts.push(sessionId);
          if (agent.phase.kind !== 'running' || agent.preempted) return false;
          agent.preempted = true;
          return true;
        },
        cancel() {}, async whenIdle() {},
        ctx: { tools: { register() {}, restrict() {}, guard() {} } },
      };
      sessions.set(sessionId, agent.session);
      return { agent, dispose: async () => {} };
    };
    if (prepare) await prepare({ root, ctx, sessions });
  }).then(w => Object.assign(w, { control }));
}
const command = (w, name, entityId, extra = {}) => w.runtime.host.command({ teamId: w.runtime.host.teamId,
  actor: 'root', requestId: entityId, operationId: 'v1:operation:' + entityId.replaceAll(':', '-').padEnd(20, 'x'),
  payload: { command: name, entityId, ...extra } });
const wakesOf = (w, sessionId) => w.control.wakes.filter(id => id === sessionId).length;

test('R5-1 cold start reads the persistent journal of an existing owner instead of minting an empty session', async () => {
  // A completion published in the durable journal (goal revision 1 -> 2, phase complete) while the token stayed
  // prepared. Reading it must reach 'unknown' (evidence for the operator exit), never 'cancelled' on an empty view.
  const events = [{ seq: 7, type: 'goal/change', data: { goal: { id: 'goal:cold', revision: 2, objective: 'done', maxGoalRounds: 3, phase: 'complete' } } }];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r5-cold-'));
  let opened = 0; let minted = 0;
  const w = await profile({ root }, async ({ ctx, sessions }) => {
    const store = new ControlStore(root), core = new TeamCore(store, {}, { enabled: true });
    core.mutate('completion:cold', 'root', {}, tx => tx.put('completion:cold', { status: 'prepared',
      input: { sessionId: 'session:owner', goal: { id: 'goal:cold', revision: 1, objective: 'done', maxGoalRounds: 3 } } }));
    store.close();
    // The owner is already registered: this is a restart of an existing team, not a new one.
    const manager = new TeamManager({ ctx, home: root, singleTeam: true });
    await manager.open();
    manager.registry.reserve({ ownerSessionId: 'session:owner', dir: root });
    await manager.close();
    // Its session is not live yet, and the durable journal is the only complete record of it.
    sessions.delete('session:owner');
    const create = ctx.sessions.create;
    ctx.sessions.create = async (...args) => { minted++; return create(...args); };
    ctx.sessionPersistence = { async open(id) {
      assert.equal(id, 'session:owner');
      opened++;
      return { async read() { return { events, complete: true }; }, async close() {} };
    } };
  });
  try {
    assert.equal(w.runtime.host.ownerSessionId, 'session:owner', 'the registry owner is reused, not replaced');
    assert.equal(minted, 0, 'no empty Session was created under an existing owner id');
    assert.equal(w.ctx.sessions.get('session:owner'), undefined, 'the owner stays unloaded');
    assert.equal(opened, 1, 'recovery read the persistent journal exactly once');
    assert.equal(w.runtime.store.read('completion:cold').status, 'unknown',
      'a complete journal is evidence for the operator, never a withdrawal of the preparation');
    assert.equal(w.runtime.host.status().admission, false, 'an unresolved completion still holds admission closed');
  } finally { await w.close(); }
});

test('R5-2 a plain task created through the public entry dispatches its first attempt once, from idle', async () => {
  const w = await instrumented();
  try {
    command(w, 'team.member.request', 'member-intent:w', { role: 'worker' });
    await until(() => w.runtime.store.read('member-intent:w')?.status === 'confirmed');
    const agent = w.runtime.handles.get('member:w').agent;
    assert.equal(agent.phase.kind, 'idle', 'a new member is idle until something dispatches it');
    command(w, 'team.task.request', 'task:w', { owner: 'member:w' });
    await until(() => w.runtime.store.list('attempt:').some(row => row.status === 'running'));
    const attempt = w.runtime.store.list('attempt:').find(row => row.owner === 'member:w');
    await until(() => wakesOf(w, agent.session.id) === 1);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(wakesOf(w, agent.session.id), 1, 'the first dispatch opened the idle driver exactly once');
    assert.equal(w.control.preempts.length, 0, 'nothing was preempted: there was no live step to interrupt');
    assert.equal(agent.phase.kind, 'running', 'the native agent left idle through the only edge that may open a turn');
    const dispatch = w.runtime.store.effects().filter(effect => effect.id === 'dispatch:' + attempt.entityId);
    assert.equal(dispatch.length, 1, 'one dispatch fact per attempt, with a stable identity');
    assert.equal(dispatch[0].status, 'confirmed');
    assert.equal(dispatch[0].payload.attemptId, attempt.entityId);
    assert.equal(dispatch[0].payload.recipient, 'member:w');
    const record = w.runtime.store.read('attempt-dispatch:' + attempt.entityId);
    assert.equal(record?.by, 'dispatch', 'the shared attempt-level dispatch record is written by the dispatch itself');
    assert.equal(w.runtime.store.effects().filter(effect => effect.id === attempt.entityId).length, 1, 'the start effect stays the only other fact');
  } finally { await w.close(); }
});

test('R5-2 a real team_message send is consumed by the wake contract and leaves no unknown message effect', async () => {
  const w = await instrumented();
  try {
    command(w, 'team.member.request', 'member-intent:w', { role: 'worker' });
    await until(() => w.runtime.store.read('member-intent:w')?.status === 'confirmed');
    command(w, 'team.task.request', 'task:w', { owner: 'member:w' });
    await until(() => w.runtime.store.list('attempt:').some(row => row.status === 'running'));
    const agent = w.runtime.handles.get('member:w').agent;
    await until(() => wakesOf(w, agent.session.id) === 1);
    // The member's first turn ended; it is between turns when the message arrives.
    agent.phase = { kind: 'idle' }; agent.preempted = false;
    w.ctx.agents.currentInitiator = () => ({ session: { id: w.runtime.host.ownerSessionId } });
    const receipt = w.globalTools.get('team_message').execute({ operationId: 'v1:operation:r5-message-0001',
      op: 'send', to: 'member:w', kind: 'action', summary: 'report the task state', expectedOutcome: 'a report',
      deadline: new Date(Date.now() + 60000).toISOString() });
    const messageId = receipt.result.entityId;
    assert(messageId.startsWith('message:'));
    await until(() => w.runtime.store.effects().find(effect => effect.id === messageId)?.status === 'confirmed');
    await new Promise(resolve => setTimeout(resolve, 150));
    const effects = w.runtime.store.effects().filter(effect => effect.id === messageId);
    assert.equal(effects.length, 1);
    assert.equal(effects[0].payload.kind, 'message', 'the ordinary message produced its own delivery notice');
    assert.equal(effects[0].status, 'confirmed', 'the message effect is consumed by the wake contract, not a missing port');
    assert.equal(wakesOf(w, agent.session.id), 2, 'the delivered message opened the idle turn exactly once');
    assert.equal(w.runtime.store.effects().filter(effect => effect.status === 'unknown').length, 0, 'no effect is left unknown');
  } finally { await w.close(); }
});

async function intentFixture() {
  const w = await instrumented();
  command(w, 'team.member.request', 'member-intent:a', { role: 'worker' });
  command(w, 'team.member.request', 'member-intent:b', { role: 'worker' });
  await until(() => w.runtime.store.read('member-intent:a')?.status === 'confirmed' && w.runtime.store.read('member-intent:b')?.status === 'confirmed');
  command(w, 'team.task.request', 'task:a', { owner: 'member:a' });
  await until(() => w.runtime.store.list('attempt:').some(row => row.owner === 'member:a' && row.status === 'running'));
  const attempt = w.runtime.store.list('attempt:').find(row => row.owner === 'member:a');
  const agent = w.runtime.handles.get('member:a').agent;
  await until(() => wakesOf(w, agent.session.id) === 1);
  agent.phase = { kind: 'idle' }; agent.preempted = false;
  const intent = w.runtime.host.executeAuthorized('business', () =>
    w.runtime.core.send('member:a', ['member:b'], 'intent', 'plan', { taskRef: 'task:a', contractRevision: 1 }).result.entityId);
  return { w, attempt, agent, intent };
}
const closeIntent = (w, intent) => w.runtime.host.executeAuthorized('business', () => w.runtime.core.replyIntent(intent, 'member:b', 'object'));

test('R5-3 an intent result queued before the initiator was cancelled never wakes the retired execution', async () => {
  const { w, attempt, agent, intent } = await intentFixture();
  try {
    const before = wakesOf(w, agent.session.id);
    // Close the window and release the execution in the same turn: the result is durable but the initiator is gone.
    closeIntent(w, intent);
    w.runtime.host.executeAuthorized('business', () => w.runtime.core.finish(attempt.entityId, attempt.fence, 'cancelled'));
    assert.equal(w.runtime.store.read(attempt.entityId).lease, 'released');
    await until(() => (w.runtime.store.effects().find(effect => effect.id === 'intent-result:' + intent)?.tries ?? 0) > 0);
    await new Promise(resolve => setTimeout(resolve, 150));
    const effect = w.runtime.store.effects().find(row => row.id === 'intent-result:' + intent);
    assert.notEqual(effect.status, 'confirmed', 'a retired execution cannot confirm its result as dispatched');
    assert.notEqual(effect.status, 'unknown', 'the result is kept for a legal consumption, not lost');
    assert.equal(wakesOf(w, agent.session.id), before, 'the released execution was never woken');
    assert.equal(w.runtime.store.read('intent-result-receipt:' + intent), null, 'nothing was executed, so no receipt exists');
  } finally { await w.close(); }
});

test('R5-3 an intent result queued before a generation change wakes neither the old nor the new agent', async () => {
  const { w, attempt, agent, intent } = await intentFixture();
  try {
    const next = await w.ctx.agents.create({ sessionId: 'session:a2' });
    const before = wakesOf(w, agent.session.id);
    closeIntent(w, intent);
    // The member moved on: the old execution ended, and a new generation, attempt and agent now hold member:a.
    w.runtime.host.executeAuthorized('business', () => w.runtime.core.finish(attempt.entityId, attempt.fence, 'cancelled'));
    const generation = w.runtime.store.read('member:a').generation + 1;
    w.runtime.core.mutate('member:a', 'root', {}, tx => tx.put('member:a', { ...tx.read('member:a'), generation, nativeRef: 'session:a2' }));
    w.runtime.core.mutate('attempt:r5-next', 'root', {}, tx => tx.put('attempt:r5-next', { owner: 'member:a', taskId: 'task:a',
      status: 'running', lease: 'active', fence: attempt.fence + 1, generation, expiresAt: Date.now() + 60000, scopeSet: [] }));
    w.runtime.handles.set('member:a', next);
    w.runtime.preempt.bind('member:a', next.agent);
    w.runtime.router.bindExecution({ executionSessionId: 'session:a2', teamId: w.runtime.host.teamId, memberId: 'member:a',
      generation, attemptId: 'attempt:r5-next', fence: attempt.fence + 1, epoch: w.runtime.host.epoch });
    await until(() => (w.runtime.store.effects().find(effect => effect.id === 'intent-result:' + intent)?.tries ?? 0) > 0);
    await new Promise(resolve => setTimeout(resolve, 150));
    const effect = w.runtime.store.effects().find(row => row.id === 'intent-result:' + intent);
    assert.notEqual(effect.status, 'confirmed');
    assert.equal(wakesOf(w, agent.session.id), before, 'the superseded execution was never woken');
    assert.equal(wakesOf(w, 'session:a2'), 0, 'the new execution did not open this result');
    assert.equal(w.runtime.store.read('intent-result-receipt:' + intent), null, 'nothing was executed, so no receipt exists');
  } finally { await w.close(); }
});

test('R5-5 team_read stays open while a pending adjudication holds admission closed', async () => {
  const w = await profile({}, ({ root }) => {
    const store = new ControlStore(root), core = new TeamCore(store, {}, { enabled: true });
    core.member('member:root', 'root');
    core.mutate('completion:frozen', 'operator', {}, tx => tx.put('completion:frozen', { status: 'unknown',
      input: { sessionId: 'session:gone', goal: { id: 'goal:frozen', revision: 1 } } }));
    store.close();
  });
  try {
    assert.equal(w.runtime.host.status().admission, false);
    w.ctx.agents.currentInitiator = () => ({ session: { id: w.runtime.host.ownerSessionId } });
    const read = w.globalTools.get('team_read').execute({ view: 'team' });
    assert.equal(read.view, 'team', 'an authorized query still answers while the team is frozen');
    assert.throws(() => w.globalTools.get('team_message').execute({ operationId: 'v1:operation:r5-frozen-0001',
      op: 'send', to: 'member:root', kind: 'info', summary: 'x' }), error => error.code === 'ADMISSION_CLOSED',
    'a business write is still refused by the same freeze');
  } finally { await w.close(); }
});
