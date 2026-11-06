import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
import { createClock } from '../src/clock.mjs';
import { profile, until } from '../test-support/profile.mjs';

/**
 * F1 round 10: the r9 finding about the completion fence on the pre-claim deferral, plus its observability.
 *
 *   R10-1  the deferral is an ordinary scheduling write: while a completion is pending it writes nothing at all -
 *          not nextDue, not defers, not the evidence, not the ledger - and the refusal is visible in the runner audit.
 *          Unfreezing resumes the same wait, and the delivery still ends in exactly one dispatch.
 *   R10-2  the same fence cannot refund the same wait twice: a second deferred close-out for an already closed claim is
 *          rejected and leaves tries/defers/deferredSince untouched.
 *   R10-3  a long wait is observable: the capability report names the effect and member, the cumulative deferral count,
 *          the first moment of the wait and its age, and flags it past a configurable threshold. No hard limit is added.
 */
function instrumented(options = {}) {
  const control = { wakes: [], preempts: [], wakeMode: 'ok', startInMaintenance: false };
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
const completion = (w, status) => w.runtime.host.executeAuthorized('business', () => w.runtime.core.mutate('completion:r10', 'root', {},
  tx => tx.put('completion:r10', { status })));
async function started(w) {
  command(w, 'team.member.request', 'member-intent:w', { role: 'worker' });
  await until(() => w.runtime.store.read('member-intent:w')?.status === 'confirmed');
  command(w, 'team.task.request', 'task:w', { owner: 'member:w' });
  await until(() => w.runtime.store.list('attempt:').some(row => row.status === 'running'));
  const agent = w.runtime.handles.get('member:w').agent;
  await until(() => wakesOf(w, agent.session.id) === 1);
  return agent;
}
async function waitThrough(w, ms, step = 2000) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    w.control.clock.advance(step);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('R10-1 a pending completion stops the maintenance deferral from writing anything', async () => {
  const w = await instrumented();
  try {
    const agent = await started(w);
    endTurn(agent);
    enterMaintenance(agent);
    const messageId = send(w, 'member:w', 'M1 waiting while the team freezes');
    await until(() => (effectOf(w, messageId)?.defers ?? 0) >= 1);
    const before = effectOf(w, messageId);
    const ledgerBefore = w.runtime.store.read('effect:' + messageId);
    assert.ok(before.deferredSince !== undefined && before.deferredSince !== null, 'the wait has a start');
    completion(w, 'prepared');
    // Several backoff periods, with the agent still in maintenance the whole time: the freeze must hold the write.
    await waitThrough(w, 30000);
    const after = effectOf(w, messageId);
    assert.equal(after.defers, before.defers, 'a frozen team records no deferral');
    assert.equal(after.nextDue, before.nextDue, 'nextDue does not move');
    assert.equal(after.tries, before.tries, 'tries do not move');
    assert.equal(after.fence, before.fence, 'the fence does not move');
    assert.deepEqual(w.runtime.store.read('effect:' + messageId), ledgerBefore, 'the ledger row is untouched');
    assert.ok(w.runtime.runner.status().audit.some(row => row.code === 'COMPLETION_FROZEN'), 'the refusal is observable');
    assert.equal(receiptOf(w, messageId), null);
    assert.equal(wakesOf(w, agent.session.id), 1, 'nothing was woken while frozen');
    // Unfreeze: the same effect resumes its wait, and the delivery still ends in exactly one dispatch.
    completion(w, 'confirmed');
    await waitThrough(w, 12000);
    assert.ok(effectOf(w, messageId).defers > before.defers, 'the deferral resumes after the freeze');
    endTurn(agent);
    w.control.clock.advance(12000);
    await until(() => effectOf(w, messageId)?.status === 'confirmed');
    assert.equal(wakesOf(w, agent.session.id), 2, 'the cycle dispatched the delivery once');
  } finally { await w.close(); }
});

test('R10-2 the same fence cannot refund the same wait twice', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r10-defer-'));
  const store = new ControlStore(root);
  const core = new TeamCore(store, {}, { enabled: true });
  try {
    core.mutate('seed', 'root', {}, tx => tx.outbox('effect:d', { kind: 'wake', recipient: 'member:w' }));
    const claim = store.claim(core.command('effect:d', 'scheduler', { effectId: 'effect:d' }), 'effect:d', 'adapter', 1000).result;
    assert.equal(claim.tries, 1);
    const settle = (at, evidence = { deferred: true, reason: 'maintenance' }) => store.settle(
      core.command('effect:d', 'adapter', { effectId: 'effect:d' }), 'effect:d', claim.fence, evidence, null, at);
    const first = settle(1000).result;
    assert.equal(first.tries, 0, 'the claim try was refunded once');
    assert.equal(first.defers, 1);
    assert.equal(first.deferredSince, 1000, 'the first wait is the earliest wait');
    assert.throws(() => settle(1200), { code: 'STALE_FENCE' });
    const after = store.effects()[0];
    assert.equal(after.tries, 0, 'the second close-out refunded nothing');
    assert.equal(after.defers, 1, 'and added no deferral');
    assert.equal(after.fence, claim.fence, 'the fence is unchanged');
    assert.equal(after.deferredSince, 1000);
    // A real execution clears the wait episode; the cumulative deferral count stays as history.
    const next = store.claim(core.command('effect:d', 'scheduler', { effectId: 'effect:d' }), 'effect:d', 'adapter', 5000).result;
    const done = store.settle(core.command('effect:d', 'adapter', { effectId: 'effect:d' }), 'effect:d', next.fence,
      { executed: true, receipt: {} }, null, 5000).result;
    assert.equal(done.status, 'confirmed');
    assert.equal(done.deferredSince, null, 'a completed effect is no longer waiting');
    assert.equal(done.defers, 1, 'the history of the wait is kept');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('R10-3 a long maintenance wait is visible with its effect, member and age', async () => {
  const w = await instrumented({ deferAlertMs: 5000 });
  try {
    const agent = await started(w);
    endTurn(agent);
    enterMaintenance(agent);
    const messageId = send(w, 'member:w', 'M3 the observable wait');
    await until(() => (effectOf(w, messageId)?.defers ?? 0) >= 1);
    await waitThrough(w, 6000, 2000);
    const report = w.runtime.runner.status().deferrals;
    assert.equal(report.alertAfterMs, 5000, 'the threshold is configurable');
    assert.ok(report.waiting >= 1);
    assert.ok(report.totalDefers >= 1);
    const entry = report.effects.find(item => item.effectId === messageId);
    assert.ok(entry, 'the waiting effect is named');
    assert.equal(entry.memberId, 'member:w', 'the member the wait is about is named');
    assert.equal(entry.kind, 'message');
    assert.equal(entry.defers, effectOf(w, messageId).defers);
    assert.equal(entry.deferredSince, effectOf(w, messageId).deferredSince, 'the first moment of the wait is kept');
    assert.ok(entry.waitingMs >= 5000, 'the age is measured from that first moment');
    assert.equal(entry.alerting, true, 'past the threshold the wait is flagged');
    assert.ok(report.alerting >= 1);
    assert.equal(report.earliestDeferredSince, entry.deferredSince);
    // The same surface through the profile capability, which is what an operator sees.
    const capability = w.runtime.status();
    assert.equal(capability.effects.deferrals.waiting, report.waiting);
    assert.equal(capability.effects.deferrals.alerting, report.alerting);
    // There is no hard limit: the wait is still the same episode, not a dead letter.
    assert.equal(effectOf(w, messageId).status, 'retryable');
    assert.equal(effectOf(w, messageId).tries, 0);
  } finally { await w.close(); }
});
