import test from 'node:test';
import assert from 'node:assert/strict';
import { profile, until } from '../test-support/profile.mjs';

/**
 * F1 round 7: the two mailbox findings of the r6 review.
 *
 *   R7-1  the mailbox wake's own outcome reaches the port: a driver that refused is notExecuted, a driver that raised
 *         is unknown, and neither writes a consumed-delivery receipt nor confirms the effect. A later successful
 *         retry really dispatches.
 *   R7-2  the coalescing window merges into a live turn, never into a timestamp: an idle member inside the window is
 *         woken instead of being confirmed as "merged" into a turn that already ended, while several notifications
 *         inside one live turn still buy only one request.
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
          // Only a request the live step actually accepts is a preemption; a refused call is not one.
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

test('R7-1 a refused or failing mailbox wake is never confirmed as a consumed delivery', async () => {
  const w = await instrumented();
  try {
    const agent = await started(w);
    endTurn(agent);
    // The driver refuses the turn.
    w.control.wakeMode = 'refuse';
    const refused = send(w, 'member:w', 'delivery the driver refuses');
    await until(() => (effectOf(w, refused)?.tries ?? 0) > 0);
    await new Promise(resolve => setTimeout(resolve, 120));
    let notice = effectOf(w, refused);
    assert.notEqual(notice.status, 'confirmed', 'a refused wake is not a consumed delivery');
    assert.equal(notice.lastEvidence.notExecuted, true);
    assert.equal(receiptOf(w, refused), null, 'no consumed-delivery receipt was written');
    assert.equal(wakesOf(w, agent.session.id), 1, 'nothing was woken');
    // The driver accepts again: the bounded retry really opens the turn and only then writes the receipt.
    w.control.wakeMode = 'ok';
    await until(() => effectOf(w, refused)?.status === 'confirmed');
    assert.equal(wakesOf(w, agent.session.id), 2, 'the retry dispatched the delivery');
    assert.equal(receiptOf(w, refused)?.dispatched, true, 'the receipt now records a real dispatch');
    // The driver raises: the outcome is unknown, still no receipt and no confirmation.
    endTurn(agent);
    w.control.wakeMode = 'throw';
    const failed = send(w, 'member:w', 'delivery that raises');
    await until(() => effectOf(w, failed)?.status === 'unknown');
    notice = effectOf(w, failed);
    assert.equal(notice.status, 'unknown');
    assert.equal(notice.lastEvidence.unknown, true);
    assert.equal(receiptOf(w, failed), null, 'an unknown wake is not a consumed delivery either');
    assert.equal(wakesOf(w, agent.session.id), 2);
  } finally { await w.close(); }
});

test('R7-2 a delivery inside the merge window gets its own turn once the previous turn has ended', async () => {
  const w = await instrumented();
  try {
    const agent = await started(w);
    assert.equal(agent.phase.kind, 'running', 'the first dispatch opened a live turn');
    // M1 arrives while that turn is live: a preemption, which starts the merge window.
    const first = send(w, 'member:w', 'M1 while the turn is live');
    await until(() => w.control.preempts.length === 1);
    // A second notification inside the same live turn is a legal merge: one request, no second dispatch.
    const merged = send(w, 'member:w', 'M2 inside the same live turn');
    await until(() => effectOf(w, merged)?.status === 'confirmed');
    assert.equal(w.control.preempts.length, 1, 'one request per live turn');
    assert.equal(wakesOf(w, agent.session.id), 1, 'a merge never opens a second turn');
    assert.equal(effectOf(w, merged).lastEvidence.receipt.wake, 'coalesced');
    assert.equal(effectOf(w, merged).lastEvidence.receipt.dispatched, true, 'the merge target was still live');
    assert.equal(effectOf(w, first)?.status, 'confirmed');
    // The turn ends immediately. M3 arrives well inside the same 2s window and must still get its own turn.
    endTurn(agent);
    const startedAt = Date.now();
    const late = send(w, 'member:w', 'M3 after the turn ended');
    await until(() => wakesOf(w, agent.session.id) === 2);
    assert.ok(Date.now() - startedAt < 2000, 'the dispatch happened inside the merge window, not after it');
    assert.equal(effectOf(w, late).status, 'confirmed');
    assert.equal(effectOf(w, late).lastEvidence.receipt.dispatched, true);
    assert.equal(effectOf(w, late).lastEvidence.receipt.wake, 'woke', 'an idle member is woken, never merged');
    assert.equal(w.control.preempts.length, 1, 'the late delivery was not a preemption of a dead turn');
  } finally { await w.close(); }
});
