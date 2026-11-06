import test from 'node:test';
import { profile } from '../test-support/profile.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { GoalGate, RECOVERY_CONTRACT, TeamCore, canonical, createRecoveryScope, digest, recoverFacts } from '../../core/index.mjs';
import { execFileSync, spawnSync as realSpawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createTeamHost } from '../index.mjs';
import { createGoalRecovery } from '../src/goal.mjs';
import { createRecovery } from '../src/recover.mjs';
import { createHostDelivery } from '../src/delivery.mjs';
import { createEffectRunner } from '../src/effect-runner.mjs';
import { openSessionLog } from '../../adapter-dsh/index.mjs';
import { createGitGuardRunner } from '../../delivery/index.mjs';

/**
 * The E package's recovery suite: design §3.5.1, §3.8 and the fault rows F3, F8 (seven sub-cases), F23, F24.
 *
 * Every case drives the real composition - ControlStore, TeamCore, TeamHost, the host's controlled write ports - and
 * seeds durable rows, never only a token or an attempt: a task that is executing, a pending wait, an applying
 * member-intent, an active attempt and an unresolved completion token. The recovery pass is the host's own recoverer,
 * so "start succeeded", "status is readable" and "admission is what the conclusion says" are asserted where they are
 * decided, not on a hand-built object.
 */

import { GOAL, seed, rig, cancelled } from '../test-support/recovery-fixtures.mjs';

test('F8#1 an authorized token and an active attempt: the team starts, status is readable, admission stays closed', async () => {
  const w = await rig({ token: { name: 'one', row: { status: 'authorized' }, goal: GOAL }, journal: () => ({ events: [], complete: true }) });
  try {
    const before = w.store.read(w.state.seeded.attempt.attemptId);
    const status = await w.start();
    assert.equal(status.state, 'running');
    assert.equal(status.admission, false, 'an unresolved completion token closes admission');
    assert.equal(status.recovery.status, 'ok');
    assert.equal(status.recovery.admission, false);
    // The token was downgraded, not silently trusted: it is absent from the durable journal.
    assert.equal(w.store.read('completion:one').status, 'unknown');
    assert.equal(w.store.read('completion:one').responsible, 'operator');
    // §3.5.1 down the line: lease, status, fence, lastEvidence, and the task keeps executing with a new lastFence.
    const after = w.store.read(w.state.seeded.attempt.attemptId);
    assert.equal(after.lease, 'unknown');
    assert.equal(after.status, 'unknown');
    assert.equal(after.fence, before.fence + 1);
    assert.equal(after.lastEvidence, null);
    assert.equal(after.responsible, 'operator');
    assert.equal(w.store.read('task:a').status, 'executing');
    assert.equal(w.store.read('task:a').lastFence, after.fence);
    assert.equal(w.store.read('member-intent:a').status, 'unknown');
    assert.equal(w.store.read('member-intent:a').reason, 'interrupted lifecycle');
    assert.equal(w.store.read('runtime').recovered, true);
    assert.equal(cancelled(w).length, 1, 'one recover-cancel row per converged attempt');
    assert.equal(cancelled(w)[0].payload.attemptId, after.entityId);
  } finally { await w.close(); }
});

test('F8#2 the recovery transaction crosses the completion fence while business writes stay refused', async () => {
  // The journal is unavailable, so the prepared token stays prepared: the fence is still up after the recovery pass.
  const w = await rig({ token: { name: 'one', row: { status: 'prepared' } }, journal: () => null });
  try {
    assert.equal(w.store.read('completion:one').status, 'prepared');
    const status = await w.start();
    assert.equal(status.state, 'running');
    // The recovery writes really landed under the fence.
    assert.equal(w.store.read(w.state.seeded.attempt.attemptId).lease, 'unknown');
    assert.equal(w.store.read('runtime').recovered, true);
    // Business paths are still closed: no new dispatch, no new start/produce effect, no ordinary claim.
    assert.throws(() => w.core.member('member:later', 'worker'), { code: 'COMPLETION_FROZEN' });
    assert.throws(() => w.core.task('task:later', 'member:w'), { code: 'COMPLETION_FROZEN' });
    assert.throws(() => w.host.coreAccess.lifecycle().claim('wake:any', 'adapter'), { code: 'COMPLETION_FROZEN' });
    assert.equal(w.store.list('member:').some(member => member.entityId === 'member:later'), false);
  } finally { await w.close(); }
});

test('F8#3a a prepared token the journal cannot evidence is withdrawn safely and admission opens', async () => {
  const w = await rig({ token: { name: 'one', row: { status: 'prepared' } }, journal: () => ({ events: [], complete: true }) });
  try {
    const status = await w.start();
    assert.equal(w.store.read('completion:one').status, 'cancelled');
    assert.match(w.store.read('completion:one').reason, /never authorized/);
    assert.equal(status.admission, true, 'nothing is left unresolved, so the team is not frozen');
    assert.deepEqual(w.recovery.status().last.tokens.unresolved, []);
  } finally { await w.close(); }
});

test('F8#3b a prepared token the journal shows as completed becomes unknown, not cancelled', async () => {
  const events = [{ seq: 7, type: 'goal/change', data: { goal: { ...GOAL, revision: 2, phase: 'complete' } } }];
  const w = await rig({ token: { name: 'one', row: { status: 'prepared' }, goal: GOAL }, journal: () => ({ events, complete: true }) });
  try {
    const status = await w.start();
    const token = w.store.read('completion:one');
    assert.equal(token.status, 'unknown');
    assert.match(token.reason, /never authorized/);
    assert.equal(token.responsible, 'operator');
    assert.equal(token.lastEvidence.sessionId, 'session:e');
    assert.equal(status.admission, false);
    // The unauthorized completion is on the record as an inconsistency, and it is not written twice.
    assert.equal(w.store.list('inconsistency:').length, 1);
  } finally { await w.close(); }
});

test('F8#4 an unreadable journal is a missing capability: unknown, admission closed, tokens untouched', async () => {
  const w = await rig({ token: { name: 'one', row: { status: 'authorized' } }, journal: () => null });
  try {
    const status = await w.start();
    assert.equal(status.state, 'running');
    assert.equal(status.recovery.status, 'unknown');
    assert.equal(status.recovery.capability, 'session-log-unavailable');
    assert.equal(status.admission, false, 'a missing capability never opens admission');
    assert.equal(w.store.read('completion:one').status, 'authorized', 'the token is not adjudicated without evidence');
  } finally { await w.close(); }
});

test('F8#5 a corrupted journal read leaves the same conclusion and writes no completion fact twice', async () => {
  const w = await rig({ token: { name: 'one', row: { status: 'authorized' } },
    journal: () => { throw Error('JSON_DECODE_FAILED'); } });
  try {
    const beforeTokens = JSON.stringify(w.store.list('completion:'));
    const status = await w.start();
    assert.equal(status.recovery.status, 'unknown');
    assert.equal(status.recovery.capability, 'session-log-unavailable');
    assert.equal(status.admission, false);
    assert.equal(JSON.stringify(w.store.list('completion:')), beforeTokens);
    assert.equal(w.store.list('inconsistency:').length, 0);
    assert.equal(w.store.list('read-model:goal:session:e').length, 0);
  } finally { await w.close(); }
});

test('F8#6 operator adjudication then a restart: stable conclusion, admission opens, no second verdict', async () => {
  const w = await rig({ token: { name: 'one', row: { status: 'authorized' } }, journal: () => ({ events: [], complete: true }) });
  try {
    await w.start();
    assert.equal(w.store.read('completion:one').status, 'unknown');
    const adjudicated = w.goal.gate.resolveAbsent({ id: 'session:e', snapshotEvents: () => [] }, 'completion:one',
      'independent journal absence readback', 'operator');
    assert.equal(adjudicated.result.status, 'cancelled');
    const revision = w.store.read('completion:one').revision;
    const status = await w.restart();
    assert.equal(status.state, 'running');
    assert.equal(status.admission, true);
    assert.equal(w.store.read('completion:one').status, 'cancelled');
    assert.equal(w.store.read('completion:one').revision, revision, 'the verdict is not re-applied');
  } finally { await w.close(); }
});

test('F8#7 acceptance is "start + readable + closed + opens after the verdict", never an automatic unfreeze', async () => {
  const w = await rig({ token: { name: 'one', row: { status: 'authorized' } }, journal: () => ({ events: [], complete: true }) });
  try {
    const status = await w.start();
    assert.equal(status.state, 'running');
    assert.equal(status.admission, false);
    const again = await w.restart();
    assert.equal(again.admission, false, 'a restart alone must not unfreeze the team');
    assert.equal(w.store.read('completion:one').status, 'unknown');
    w.goal.gate.resolveAbsent({ id: 'session:e', snapshotEvents: () => [] }, 'completion:one', 'evidence:absence', 'operator');
    const opened = await w.restart();
    assert.equal(opened.admission, true);
  } finally { await w.close(); }
});

test('F3 a claim left applying survives the restart as unknown and the domain rows are untouched', async () => {
  const w = await rig({ attempt: false, journal: () => ({ events: [], complete: true }) });
  try {
    w.core.mutate('seed:wake', 'scheduler', {}, tx => { tx.outbox('wake:a', { kind: 'wake' }); return null; });
    w.store.claim(w.core.command('effect:wake:a', 'adapter', {}), 'wake:a', 'adapter', w.at, 60000);
    assert.equal(w.store.effects()[0].status, 'applying');
    const rowsBefore = JSON.stringify(w.store.list('member:'));
    const status = await w.start();
    assert.equal(status.state, 'running');
    assert.equal(w.store.effects()[0].status, 'unknown');
    assert.equal(w.store.effects()[0].reason, 'claim interrupted');
    assert.equal(JSON.stringify(w.store.list('member:')), rowsBefore);
  } finally { await w.close(); }
});

test('F23 stop during recovery: a hung journal read settles inside the budget and the next host takes a new epoch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e-f23-'));
  let store = new ControlStore(root);
  const at = Date.now();
  let core = new TeamCore(store, {}, { enabled: true, attach: true, teamId: 'team:f', now: () => at });
  seed(core, at, { token: { name: 'one', row: { status: 'authorized' } } });
  let release;
  const hung = () => new Promise(resolve => { release = resolve; });
  let host = null;
  try {
    const goal = createGoalRecovery({ core, sessionLog: hung, readTimeoutMs: 600000 });
    const recovery = createRecovery({ core, access: null, allowDirectCore: true, goal });
    host = createTeamHost({ root, teamId: 'team:f', core, now: () => at, cycleIntervalMs: 1000000,
      openStore: () => ({ close() {} }), recoverer: context => recovery.recover(context) });
    const starting = host.start();
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(host.state, 'recovering');
    const started = Date.now();
    const stopping = host.stop({ timeoutMs: 2000 });
    await assert.rejects(() => starting, { code: 'HOST_STOPPED' });
    const stopped = await stopping;
    assert.ok(Date.now() - started < 2000, 'the stop finishes inside its budget');
    assert.equal(stopped.isolated, false, 'the hung read did not have to be isolated');
    assert.equal(stopped.state, 'stopped');
    release?.(null);
    const epoch = host.epoch;
    store.close();
    store = new ControlStore(root);
    core = new TeamCore(store, {}, { enabled: true, attach: true, teamId: 'team:f', now: () => at });
    host = createTeamHost({ root, teamId: 'team:f', core, now: () => at, cycleIntervalMs: 1000000,
      openStore: () => ({ close() {} }), recoverer: async () => ({ status: 'ok', admission: true }) });
    const status = await host.start();
    assert.ok(status.epoch > epoch, 'a restart is a new epoch');
  } finally {
    try { await host?.stop({ timeoutMs: 2000 }); } catch { /* already stopped */ }
    try { store.close(); } catch { /* already closed */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('F24 recovery mints a causally bound safety capability for the cancel it created, and only that subject', async () => {
  const w = await rig({ token: { name: 'one', row: { status: 'prepared' } }, journal: () => ({ events: [], complete: true }) });
  let runner = null;
  try {
    // Keep the token unresolved so the completion fence stays in place during the close-out.
    w.state.port = () => null;
    await w.start();
    assert.equal(w.host.status().admission, false);
    const capabilities = w.recovery.safetyCapabilities();
    assert.equal(capabilities.length, 1);
    const capability = capabilities[0];
    const attemptId = w.state.seeded.attempt.attemptId;
    assert.equal(capability.subject.attemptId, attemptId);
    assert.equal(capability.subject.effectId, cancelled(w)[0].id);
    // A normal business claim is refused by the fence ...
    assert.throws(() => w.host.coreAccess.lifecycle().claim(capability.subject.effectId, 'adapter'), { code: 'COMPLETION_FROZEN' });
    // ... while the bound capability can claim, register and close exactly that cancel.
    runner = createEffectRunner({ access: w.host.coreAccess, clock: w.host.clock, capacity: 4,
      ports: { cancel: async request => ({ executed: true, receipt: { stopped: true, evidenceRef: 'evidence:stop:' + request.attemptId } }) } });
    assert.equal(runner.pumpSafety(capability).claimed, 1);
    await runner.whenIdle();
    assert.equal(w.store.effects().find(effect => effect.id === capability.subject.effectId).status, 'confirmed');
    assert.equal(w.store.read(attemptId).lease, 'revoked');
    assert.equal(w.store.read('task:a').status, 'failed');
    assert.equal(w.store.read('wait:a').status, 'cancelled');
  } finally { runner?.stop(); await w.close(); }
});

test('the recovery conclusion carries the delivery readback and the deferred release-task rows it found', async () => {
  const calls = [];
  const w = await rig({ journal: () => ({ events: [], complete: true }),
    delivery: { async reconcileApplying(options) { calls.push(options); return { inspected: 1, accepted: 1, unknown: 0, skipped: 0, failed: [] }; } } });
  try {
    w.core.mutate('seed:release', 'scheduler', {}, tx => {
      tx.outbox('release-task:attempt:x', { kind: 'release-task', attemptId: 'attempt:x', taskId: 'task:x', status: 'failed' });
      return null;
    });
    const status = await w.start();
    assert.equal(status.state, 'running');
    assert.equal(calls.length, 1, 'the cold start re-reads rows left applying');
    const last = w.recovery.status().last;
    assert.equal(last.steps.delivery.accepted, 1);
    assert.deepEqual(last.deferred.releaseTask, ['release-task:attempt:x']);
  } finally { await w.close(); }
});

test('the offline session log port reads a live session, a durable read handle, or reports unavailable', async () => {
  const events = [{ seq: 1, type: 'goal/change', data: { goal: { ...GOAL, revision: 2, phase: 'complete' } } }];
  const live = await openSessionLog({ sessionId: 'session:live', context: { sessions: { get: id => id === 'session:live' ? { seq: 1, snapshotEvents: () =>
    events } : undefined } } });
  assert.equal(live.events.length, 1);
  assert.equal(live.complete, true, 'a live session view is the committed journal by construction');
  assert.equal(await openSessionLog({ sessionId: 'session:missing', context: { sessions: { get: () => undefined } } }), null);
  const opened = [];
  const context = { sessions: { get: () => undefined }, sessionPersistence: { async open(id) {
    opened.push(id);
    return { async read() { return { events }; }, async close() { opened.push('closed'); } };
  } } };
  const durable = await openSessionLog({ sessionId: 'session:durable', context });
  assert.equal(durable.sessionId, 'session:durable');
  assert.equal(durable.seq, 1);
  assert.equal(durable.complete, false, 'a handle that declares nothing proves nothing about the rest of the journal');
  const counted = await openSessionLog({ sessionId: 'session:counted', context: { sessions: { get: () => undefined },
    sessionPersistence: { async open() { return { async read() { return { events, eventCount: 2 }; }, async close() {} }; } } } });
  assert.equal(counted.complete, false, 'a count larger than what arrived is a truncated read');
  const whole = await openSessionLog({ sessionId: 'session:whole', context: { sessions: { get: () => undefined },
    sessionPersistence: { async open() { return { async read() { return { events, eventCount: 1 }; }, async close() {} }; } } } });
  assert.equal(whole.complete, true, 'a matching count proves the read was whole');
  assert.deepEqual(opened, ['session:durable', 'closed'], 'a read handle never takes ownership and is always closed');
  const broken = await openSessionLog({ sessionId: 'session:broken', context: { sessions: { get: () => undefined },
    sessionPersistence: { async open() { throw Error('NOT_FOUND'); } } } });
  assert.equal(broken, null);
  // The host side turns a hung port into a missing capability rather than waiting forever.
  const store = new ControlStore(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e-log-')));
  try {
    const core = new TeamCore(store, {}, { enabled: true, attach: true, teamId: 'team:log' });
    const goal = createGoalRecovery({ core, sessionLog: () => new Promise(() => {}), readTimeoutMs: 5 });
    const conclusion = await goal.reconcileAll({ sessionIds: ['session:slow'] });
    assert.equal(conclusion.status, 'unknown');
    assert.equal(conclusion.capability, 'session-log-unavailable');
  } finally { store.close(); }
});
// --- review findings 1-6: the guard's own readback, non-escaping steps, an explicit write port, a complete journal,
// --- and a contract that is enforced rather than described.

test('review 3: a write port without a recovery route is refused, and the direct-core path must be declared', async () => {
  const w = await rig({ attempt: false });
  try {
    assert.throws(() => createRecovery({ core: w.core }), { code: 'INVALID_CONFIG' }, 'no port at all is not a licence');
    assert.throws(() => createRecovery({ core: w.core, access: null }), { code: 'INVALID_CONFIG' }, 'the fallback must be declared');
    assert.throws(() => createRecovery({ core: w.core, access: { lifecycle: () => ({}) } }), { code: 'INVALID_CONFIG' },
      'a port that exists but cannot recover is a configuration defect, not a fallback');
    const declared = createRecovery({ core: w.core, access: null, allowDirectCore: true });
    const conclusion = await declared.recover({});
    assert.equal(conclusion.status, 'ok', 'the declared direct path still converges');
    assert.equal(conclusion.steps.recover.status, 'confirmed');
    assert.equal(conclusion.admission, true);
  } finally { await w.close(); }
});

test('review 2: a step that throws is recorded, the host still starts, and admission stays closed', async () => {
  const explode = code => async () => { throw Object.assign(Error(code.toLowerCase() + ' exploded'), { code }); };
  const control = await rig({ attempt: false });
  try {
    assert.equal((await control.start()).admission, true, 'the control pass opens admission, so the next case proves the failure');
  } finally { await control.close(); }
  const goalRig = await rig({ attempt: false });
  try {
    goalRig.state.recovery = createRecovery({ core: goalRig.core, access: goalRig.state.host.coreAccess,
      goal: { reconcileAll: explode('JOURNAL_EXPLODED') } });
    const status = await goalRig.start();
    assert.equal(status.state, 'running', 'host.start() finished: the exception never escaped');
    assert.equal(status.admission, false);
    const last = goalRig.recovery.status().last;
    assert.equal(last.status, 'unknown');
    assert.equal(last.capability, 'JOURNAL_EXPLODED');
    assert.deepEqual({ ...last.steps.goal }, { status: 'unknown', failed: true, code: 'JOURNAL_EXPLODED', message: 'journal_exploded exploded' });
  } finally { await goalRig.close(); }
  const deliveryRig = await rig({ attempt: false });
  try {
    deliveryRig.state.recovery = createRecovery({ core: deliveryRig.core, access: deliveryRig.state.host.coreAccess,
      delivery: { reconcileApplying: explode('READBACK_EXPLODED') } });
    const status = await deliveryRig.start();
    assert.equal(status.state, 'running');
    assert.equal(status.admission, false);
    const last = deliveryRig.recovery.status().last;
    assert.equal(last.capability, 'READBACK_EXPLODED');
    assert.equal(last.steps.delivery.failed, true);
  } finally { await deliveryRig.close(); }
});

test('review 4: a truncated journal is unreadable and cannot cancel a prepared completion', async () => {
  const w = await rig({ token: { name: 'one', row: { status: 'prepared' } }, journal: () => ({ events: [], complete: false }) });
  try {
    const status = await w.start();
    assert.equal(status.state, 'running');
    assert.equal(status.admission, false);
    assert.equal(w.store.read('completion:one').status, 'prepared', 'a partial read never withdraws a completion');
    const last = w.recovery.status().last;
    assert.equal(last.status, 'unknown');
    assert.equal(last.capability, 'session-log-truncated');
    assert.equal(last.steps.goal.sessions[0].capability, 'session-log-truncated');
  } finally { await w.close(); }
});

test('review 5: the recovery contract is enforced on the transaction itself, and reported in the receipt', () => {
  const task = { entityId: 'task:t1', status: 'accepted', lastFence: 1 };
  const writes = [];
  const tx = { list: () => [task], read: id => id === 'task:t1' ? task : null,
    put: (id, row) => { writes.push([id, row]); return row; },
    outbox: (id, payload) => { writes.push([id, payload]); return payload; } };
  const scope = createRecoveryScope(tx);
  assert.throws(() => scope.put('task:t1', { ...task, status: 'cancelled' }), { code: 'RECOVERY_GRANT_VIOLATION' },
    'task.status is published state, not recovery state');
  assert.throws(() => scope.put('delivery:d1', { status: 'accepted' }), { code: 'RECOVERY_GRANT_VIOLATION' },
    'an entity outside the contract has no whitelist at all');
  assert.throws(() => scope.outbox('recover-cancel:attempt:a:2', { kind: 'publish', attemptId: 'attempt:a' }),
    { code: 'RECOVERY_GRANT_VIOLATION' });
  assert.throws(() => scope.outbox('gc:1:1', { kind: 'gc' }), { code: 'RECOVERY_GRANT_VIOLATION' });
  scope.put('task:t1', { ...task, lastFence: 2 });
  assert.equal(writes.length, 1, 'the refusals wrote nothing; the allowed write went exactly once');

  const rows = new Map([
    ['attempt:a', { entityId: 'attempt:a', lease: 'active', status: 'admitted', fence: 1, taskId: 'task:a' }],
    ['task:a', { entityId: 'task:a', status: 'accepted' }],
    ['member-intent:i', { entityId: 'member-intent:i', status: 'applying' }],
  ]);
  const live = [];
  const realTx = { list: prefix => [...rows.values()].filter(row => row.entityId.startsWith(prefix)),
    read: id => rows.get(id) ?? null,
    put: (id, row) => { live.push([id, row]); rows.set(id, row); },
    outbox: (id, payload) => { live.push([id, payload]); } };
  const receipt = recoverFacts(realTx, 1000);
  assert.deepEqual(receipt.writes.map(write => write.entityId),
    ['attempt:a', 'recover-cancel:attempt:a:2', 'task:a', 'member-intent:i', 'runtime']);
  const allowed = new Set([...Object.values(RECOVERY_CONTRACT.entityKinds).flat(), ...RECOVERY_CONTRACT.outboxFields]);
  for (const write of receipt.writes) {
    for (const field of write.fields) assert.ok(allowed.has(field), field + ' is outside the contract');
  }
});

