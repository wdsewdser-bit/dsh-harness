import test from 'node:test';
import assert from 'node:assert/strict';
import { profile, until } from '../test-support/profile.mjs';

/**
 * F1 round 8: the maintenance finding of the r7 review.
 *
 *   R8-1  a delivery that lands while the native agent is in maintenance (upstream runMaintenance: no turn is
 *         executing, the phase returns to idle when the job ends, and the team store never starts one) has no merge
 *         target. Inside the 2s window it must not be confirmed as 'coalesced', and outside it must not be confirmed as
 *         'live': both are notExecuted, write no consumption receipt and no new first-dispatch fact. Once maintenance
 *         ends the agent is idle and the bounded retry dispatches exactly once.
 *   R8-2  the same outside the window and with no preemption at all: the maintenance phase is not even asked to preempt
 *         a step, and the delivery waits for a real turn instead of being confirmed against the job.
 *
 * The double mirrors the native rule the patch implements: only a live, armed step accepts a preemption, and a
 * maintenance phase refuses it on purpose so the background job is never cut in half.
 */
function instrumented(options = {}) {
  const control = { wakes: [], preempts: [], wakeMode: 'ok' };
  let counter = 0;
  return profile({ ...options, simulateRequests: true }, async ({ ctx, sessions }) => {
    ctx.agents.create = async opts => {
      const sessionId = opts?.sessionId ?? 'session:agent-' + (++counter);
      const agent = {
        session: { id: sessionId, seq: 0, snapshotEvents: () => [] },
        phase: { kind: 'idle' },
        preempted: false,
        wakeDriver() {
          if (control.wakeMode === 'refuse') return false;
          if (control.wakeMode === 'throw') throw Error('DRIVER_WAKING_DOWN');
          control.wakes.push(sessionId);
          agent.phase = { kind: 'running' };
          agent.preempted = false;
        },
        preemptStep() {
          // Upstream (dsh-agent-loop preemptStep): only a running, armed step accepts; maintenance always refuses.
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
const attemptOf = w => w.runtime.store.list('attempt:').find(row => row.status === 'running');
async function started(w) {
  command(w, 'team.member.request', 'member-intent:w', { role: 'worker' });
  await until(() => w.runtime.store.read('member-intent:w')?.status === 'confirmed');
  command(w, 'team.task.request', 'task:w', { owner: 'member:w' });
  await until(() => w.runtime.store.list('attempt:').some(row => row.status === 'running'));
  const agent = w.runtime.handles.get('member:w').agent;
  await until(() => wakesOf(w, agent.session.id) === 1);
  return agent;
}

test('R8-1 a delivery inside the merge window is not confirmed while the agent is in maintenance', async () => {
  const w = await instrumented();
  try {
    const agent = await started(w);
    assert.equal(agent.phase.kind, 'running', 'the first dispatch opened a live turn');
    // M0 preempts that live turn, so the 2s merge window is open when the maintenance delivery arrives.
    const live = send(w, 'member:w', 'M0 while the turn is live');
    await until(() => w.control.preempts.length === 1);
    assert.equal(effectOf(w, live)?.status, 'confirmed');
    const dispatchFact = w.runtime.store.read('attempt-dispatch:' + attemptOf(w).entityId);
    assert.equal(dispatchFact.by, 'dispatch');
    enterMaintenance(agent);
    const inside = send(w, 'member:w', 'M1 inside the window, during maintenance');
    await until(() => (effectOf(w, inside)?.defers ?? 0) > 0);
    await new Promise(resolve => setTimeout(resolve, 150));
    const notice = effectOf(w, inside);
    assert.notEqual(notice.status, 'confirmed', 'a maintenance phase never confirms a delivery');
    // R9 raised the bar here: the wait is a deferred schedule, so the effect stays claimable and spends no try at all.
    assert.equal(notice.lastEvidence.deferred, true, 'the wait is deferred, never a failed execution');
    assert.equal(notice.lastEvidence.notExecuted, undefined, 'a maintenance wait is not a bounded failure');
    assert.equal(notice.tries, 0, 'waiting for maintenance spends no try');
    assert.equal(notice.status, 'retryable', 'the delivery is still waiting, not dead-lettered');
    assert.match(notice.lastEvidence.reason, /deferred/, 'the row records why it did not run');
    assert.equal(notice.lastEvidence.receipt, undefined, 'no success receipt of any wake was produced');
    assert.equal(receiptOf(w, inside), null, 'no consumption receipt was written');
    assert.deepEqual(w.runtime.store.read('attempt-dispatch:' + attemptOf(w).entityId), dispatchFact,
      'no new first-dispatch fact was written');
    assert.equal(wakesOf(w, agent.session.id), 1, 'no turn was opened into the job');
    assert.equal(w.control.preempts.length, 1, 'a maintenance phase is never asked to preempt a step');
    assert.equal(w.runtime.preempt.snapshot().coalesced, 0, 'nothing was merged into the turn that is gone');
    assert.ok(notice.defers >= 1, 'the delivery is on the deferred schedule');
    // The job ends: upstream returns the agent to idle, and the bounded retry is what opens its turn - exactly once.
    endTurn(agent);
    await until(() => effectOf(w, inside)?.status === 'confirmed');
    assert.equal(effectOf(w, inside).lastEvidence.receipt.wake, 'woke', 'the retry opened the member own idle edge');
    assert.equal(effectOf(w, inside).lastEvidence.receipt.dispatched, true);
    assert.equal(wakesOf(w, agent.session.id), 2, 'the retry dispatched the delivery once');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(wakesOf(w, agent.session.id), 2, 'and only once');
    assert.equal(agent.phase.kind, 'running', 'the retried delivery opened a real turn');
  } finally { await w.close(); }
});

test('R8-2 a delivery into maintenance outside the window is not reported as a live turn', async () => {
  const w = await instrumented();
  try {
    const agent = await started(w);
    assert.equal(agent.phase.kind, 'running', 'the first dispatch opened a live turn');
    // No preemption ever happened, so the merge window is nowhere near: the old code reported this as 'live' after the
    // driver refused the step, because "not idle" was read as "has a live turn".
    endTurn(agent);
    enterMaintenance(agent);
    const outside = send(w, 'member:w', 'M2 outside any window, during maintenance');
    await until(() => (effectOf(w, outside)?.defers ?? 0) > 0);
    await new Promise(resolve => setTimeout(resolve, 150));
    const notice = effectOf(w, outside);
    assert.notEqual(notice.status, 'confirmed', 'maintenance is not a live turn');
    assert.equal(notice.lastEvidence.deferred, true, 'the maintenance wait is deferred, not a failure');
    assert.equal(notice.tries, 0, 'waiting for maintenance spends no try');
    assert.match(notice.lastEvidence.reason, /deferred/);
    assert.equal(receiptOf(w, outside), null, 'no consumption receipt was written');
    assert.equal(wakesOf(w, agent.session.id), 1, 'no turn was woken');
    assert.equal(w.control.preempts.length, 0, 'the maintenance phase was not even asked to preempt a step');
    // Maintenance ends; the retry is the one dispatch, and only one.
    endTurn(agent);
    await until(() => effectOf(w, outside)?.status === 'confirmed');
    assert.equal(effectOf(w, outside).lastEvidence.receipt.wake, 'woke');
    assert.equal(receiptOf(w, outside)?.dispatched, true, 'the receipt now records a real dispatch');
    assert.equal(wakesOf(w, agent.session.id), 2);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(wakesOf(w, agent.session.id), 2, 'the delivery was dispatched exactly once');
    assert.equal(w.control.preempts.length, 0, 'still no preemption of a job');
  } finally { await w.close(); }
});
