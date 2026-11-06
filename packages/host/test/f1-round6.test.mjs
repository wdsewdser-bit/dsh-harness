import test from 'node:test';
import assert from 'node:assert/strict';
import { profile, until } from '../test-support/profile.mjs';

/**
 * F1 round 6: the three blocking findings of the r5 review, on the production profile path.
 *
 *   R6-1  an intent binds its initiator identity in the transaction that opens the window; closeIntent copies that
 *         binding and never re-derives "who is running now". The owner path is selected from the committed member row
 *         (the product's owner tool acts as member:root), not from a literal string or a model-reported kind.
 *   R6-2  dispatch and mailbox share one attempt-level first-dispatch record, so a mailbox wake that got there first
 *         is a legal merge for a delayed dispatch - even across a turn boundary - while later messages still preempt
 *         by their own identity. A refused or failed wake never becomes a success receipt.
 *   R6-3  the execution gate reuses the one lease rule (TeamCore.authority / leaseOf) with the host's trusted clock,
 *         then adds the router/epoch/session binding; an expired lease or an inactive member never reaches the
 *         native wake.
 *
 * The native double distinguishes an idle wake from a running preemption and can refuse or raise on wakeDriver, so a
 * false success receipt cannot hide behind an always-true driver.
 */
function instrumented(options = {}, prepare = null) {
  const control = { wakes: [], preempts: [], wakeMode: 'ok' };
  let counter = 0;
  return profile({ ...options, simulateRequests: true }, async ({ root, ctx, sessions }) => {
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
    if (prepare) await prepare({ root, ctx, sessions, control });
  }).then(w => Object.assign(w, { control }));
}
const command = (w, name, entityId, extra = {}) => w.runtime.host.command({ teamId: w.runtime.host.teamId,
  actor: 'root', requestId: entityId, operationId: 'v1:operation:' + entityId.replaceAll(':', '-').padEnd(20, 'x'),
  payload: { command: name, entityId, ...extra } });
const wakesOf = (w, sessionId) => w.control.wakes.filter(id => id === sessionId).length;
const endTurn = agent => { agent.phase = { kind: 'idle' }; agent.preempted = false; };
const send = (w, to, summary) => w.runtime.host.executeAuthorized('business', () => w.runtime.core.send('member:root', to,
  'action', summary, { expectedOutcome: 'a report', deadline: new Date(Date.now() + 60000).toISOString() }).result.entityId);

/** Delay every pending dispatch effect until the test releases it, so the mailbox half can be driven first. */
function holdDispatches(w) {
  let inside = false;
  w.runtime.store.hooks.afterCommit = () => {
    if (inside) return;
    const effect = w.runtime.store.effects().find(row => row.id.startsWith('dispatch:') && row.status === 'pending' &&
      row.nextDue <= Date.now());
    if (!effect) return;
    inside = true;
    try { w.runtime.store.effect(w.runtime.core.command('effect:' + effect.id, 'scheduler', {}), effect.id,
      row => ({ ...row, nextDue: Date.now() + 600000 })); }
    finally { inside = false; }
  };
  return (id, { kick = true } = {}) => {
    w.runtime.store.hooks.afterCommit = null;
    w.runtime.store.effect(w.runtime.core.command('effect:' + id, 'scheduler', {}), id, row => ({ ...row, nextDue: 0 }));
    if (kick) w.runtime.host.cycle.kick('test');
  };
}
/** Run a lease-damaging mutation and the pump in one synchronous block, so the cycle's own tick cannot converge first. */
const pumpNow = async (w, damage) => {
  await until(() => w.runtime.host.cycle.status().running === false);
  damage();
  w.runtime.runner.pump();
};
async function member(w, id, role = 'worker') {
  command(w, 'team.member.request', 'member-intent:' + id, { role });
  await until(() => w.runtime.store.read('member-intent:' + id)?.status === 'confirmed');
}
async function startedTask(w, taskId, owner) {
  command(w, 'team.task.request', taskId, { owner });
  await until(() => w.runtime.store.list('attempt:').some(row => row.owner === owner && row.taskId === taskId && row.status === 'running'));
  return w.runtime.store.list('attempt:').find(row => row.owner === owner && row.taskId === taskId);
}

test('R6-1 an intent opened by execution A is not handed to execution B that started after A ended', async () => {
  const w = await instrumented();
  try {
    await member(w, 'a'); await member(w, 'b');
    const attemptA = await startedTask(w, 'task:a', 'member:a');
    const agent = w.runtime.handles.get('member:a').agent;
    await until(() => wakesOf(w, agent.session.id) === 1);
    endTurn(agent);
    const intent = w.runtime.host.executeAuthorized('business', () => w.runtime.core.send('member:a', ['member:b'], 'intent',
      'plan', { taskRef: 'task:a', contractRevision: 1 }).result.entityId);
    const opened = w.runtime.store.read(intent);
    assert.equal(opened.initiator.kind, 'execution', 'the window records the execution that opened it');
    assert.equal(opened.initiator.attemptId, attemptA.entityId);
    assert.equal(opened.initiator.generation, attemptA.generation);
    assert.equal(opened.initiator.fence, attemptA.fence);
    // A ends, B starts, and only then does the window close.
    w.runtime.host.executeAuthorized('business', () => w.runtime.core.finish(attemptA.entityId, attemptA.fence, 'cancelled'));
    const attemptB = await startedTask(w, 'task:b', 'member:a');
    assert.notEqual(attemptB.entityId, attemptA.entityId);
    await until(() => w.runtime.store.list('attempt:').find(row => row.entityId === attemptB.entityId)?.status === 'running');
    await until(() => wakesOf(w, agent.session.id) === 2, 'B got its own first dispatch');
    const before = wakesOf(w, agent.session.id);
    w.runtime.host.executeAuthorized('business', () => w.runtime.core.replyIntent(intent, 'member:b', 'object'));
    const result = w.runtime.store.effects().find(row => row.id === 'intent-result:' + intent);
    assert.equal(result.payload.initiator.attemptId, attemptA.entityId, 'the result keeps the open-time binding, not B');
    await until(() => (result.tries ?? 0) > 0 || w.runtime.store.effects().find(row => row.id === 'intent-result:' + intent).tries > 0);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(wakesOf(w, agent.session.id), before, 'B was never woken by an intent it did not open');
    assert.notEqual(w.runtime.store.effects().find(row => row.id === 'intent-result:' + intent).status, 'confirmed');
    assert.equal(w.runtime.store.read('intent-result-receipt:' + intent), null);
  } finally { await w.close(); }
});

test('R6-1 an intent opened from the owner team_message entry confirms on the owner path instead of dead-lettering', async () => {
  const w = await instrumented({ collab: 'on' });
  try {
    await member(w, 'w');
    await startedTask(w, 'task:w', 'member:w');
    const agent = w.runtime.handles.get('member:w').agent;
    await until(() => wakesOf(w, agent.session.id) === 1);
    endTurn(agent);
    w.ctx.agents.currentInitiator = () => ({ session: { id: w.runtime.host.ownerSessionId } });
    const receipt = w.globalTools.get('team_message').execute({ operationId: 'v1:operation:r6-owner-0001', op: 'send',
      kind: 'intent', to: ['member:w'], summary: 'the interface', taskRef: 'task:w', contractRevision: 1 });
    const intent = receipt.result.entityId;
    const row = w.runtime.store.read(intent);
    assert.equal(row.sender, 'member:root', 'the production owner tool acts as the root member');
    assert.deepEqual({ kind: row.initiator.kind, memberId: row.initiator.memberId },
      { kind: 'owner', memberId: 'member:root' }, 'the owner path comes from the committed member row, not a literal');
    const before = wakesOf(w, agent.session.id);
    w.runtime.host.executeAuthorized('business', () => w.runtime.core.replyIntent(intent, 'member:w', 'object'));
    await until(() => w.runtime.store.effects().find(row => row.id === 'intent-result:' + intent)?.status === 'confirmed');
    const result = w.runtime.store.effects().find(row => row.id === 'intent-result:' + intent);
    assert.equal(result.status, 'confirmed', 'the owner result is delivered by its durable row, not a dead letter');
    assert.equal(result.lastEvidence.receipt.owner, 'member:root');
    assert.equal(wakesOf(w, agent.session.id), before, 'F1 does not drive the owner session');
    assert.equal(w.runtime.store.effects().filter(row => ['unknown', 'dead-letter'].includes(row.status)).length, 0);
  } finally { await w.close(); }
});

test('R6-2 a mailbox wake that dispatched the attempt first makes the delayed dispatch a legal merge', async () => {
  const w = await instrumented();
  try {
    const release = holdDispatches(w);
    await member(w, 'w');
    const attempt = await startedTask(w, 'task:w', 'member:w');
    const agent = w.runtime.handles.get('member:w').agent;
    const held = 'dispatch:' + attempt.entityId;
    await until(() => w.runtime.store.effects().find(row => row.id === held)?.nextDue > Date.now() + 1000);
    assert.equal(wakesOf(w, agent.session.id), 0, 'the dispatch is still pending, so nothing has been dispatched');
    // The mailbox gets there first, exactly as the review's failure case describes.
    send(w, 'member:w', 'first delivery');
    await until(() => wakesOf(w, agent.session.id) === 1);
    await until(() => w.runtime.store.effects().filter(row => row.payload?.kind === 'message').every(row => row.status === 'confirmed'));
    assert.equal(w.runtime.store.read('attempt-dispatch:' + attempt.entityId)?.by, 'mailbox');
    // The turn ends; only then does the delayed dispatch run.
    endTurn(agent);
    release(held);
    await until(() => w.runtime.store.effects().find(row => row.id === held)?.status === 'confirmed');
    const dispatch = w.runtime.store.effects().find(row => row.id === held);
    assert.equal(dispatch.lastEvidence.receipt.dispatched, false, 'the delayed dispatch merged instead of opening a turn');
    assert.equal(dispatch.lastEvidence.receipt.by, 'mailbox');
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(wakesOf(w, agent.session.id), 1, 'no second turn was opened after the idle transition');
    // A later message is a new input: the shared record must not swallow it.
    send(w, 'member:w', 'second delivery');
    await until(() => wakesOf(w, agent.session.id) === 2);
  } finally { await w.close(); }
});

test('R6-2 a dispatch that went first still lets later messages preempt the live turn and wake the next one', async () => {
  const w = await instrumented();
  try {
    await member(w, 'w');
    await startedTask(w, 'task:w', 'member:w');
    const agent = w.runtime.handles.get('member:w').agent;
    await until(() => wakesOf(w, agent.session.id) === 1);
    assert.equal(agent.phase.kind, 'running');
    send(w, 'member:w', 'while running');
    await until(() => w.control.preempts.length === 1);
    assert.equal(wakesOf(w, agent.session.id), 1, 'a live turn is preempted, never woken a second time');
    endTurn(agent);
    // R7-2: no waiting for the merge window - an idle member is never "coalesced" into a turn that already ended.
    send(w, 'member:w', 'after the turn ended');
    await until(() => wakesOf(w, agent.session.id) === 2);
  } finally { await w.close(); }
});

test('R6-2 a refused or failing first wake never becomes a success receipt', async () => {
  const w = await instrumented();
  try {
    const release = holdDispatches(w);
    await member(w, 'w');
    const attempt = await startedTask(w, 'task:w', 'member:w');
    const agent = w.runtime.handles.get('member:w').agent;
    const held = 'dispatch:' + attempt.entityId;
    await until(() => w.runtime.store.effects().find(row => row.id === held)?.nextDue > Date.now() + 1000);
    // The driver refuses the turn: the effect must stay open and no dispatch may be recorded.
    w.control.wakeMode = 'refuse';
    release(held);
    await until(() => (w.runtime.store.effects().find(row => row.id === held)?.tries ?? 0) > 0);
    let dispatch = w.runtime.store.effects().find(row => row.id === held);
    assert.notEqual(dispatch.status, 'confirmed', 'a refused wake is not a dispatch');
    assert.equal(w.runtime.store.read('attempt-dispatch:' + attempt.entityId), null);
    assert.equal(dispatch.lastEvidence.notExecuted, true);
    // The driver raises: the outcome is unknown, still never a confirmed dispatch.
    w.control.wakeMode = 'throw';
    await until(() => w.runtime.store.effects().find(row => row.id === held)?.status === 'unknown');
    dispatch = w.runtime.store.effects().find(row => row.id === held);
    assert.equal(dispatch.lastEvidence.unknown, true);
    assert.equal(w.runtime.store.read('attempt-dispatch:' + attempt.entityId), null);
    assert.equal(wakesOf(w, agent.session.id), 0);
  } finally { await w.close(); }
});

test('R6-2 an intent result whose wake is refused keeps its effect open instead of confirming', async () => {
  const w = await instrumented();
  try {
    await member(w, 'a'); await member(w, 'b');
    const attempt = await startedTask(w, 'task:a', 'member:a');
    const agent = w.runtime.handles.get('member:a').agent;
    await until(() => wakesOf(w, agent.session.id) === 1);
    endTurn(agent);
    const intent = w.runtime.host.executeAuthorized('business', () => w.runtime.core.send('member:a', ['member:b'], 'intent',
      'plan', { taskRef: 'task:a', contractRevision: 1 }).result.entityId);
    w.control.wakeMode = 'refuse';
    w.runtime.host.executeAuthorized('business', () => w.runtime.core.replyIntent(intent, 'member:b', 'ok'));
    await until(() => (w.runtime.store.effects().find(row => row.id === 'intent-result:' + intent)?.tries ?? 0) > 0);
    await new Promise(resolve => setTimeout(resolve, 120));
    const result = w.runtime.store.effects().find(row => row.id === 'intent-result:' + intent);
    assert.notEqual(result.status, 'confirmed');
    assert.equal(result.lastEvidence.notExecuted, true);
    assert.equal(w.runtime.store.read('intent-result-receipt:' + intent), null);
    assert.equal(wakesOf(w, agent.session.id), 1);
    assert.equal(w.runtime.store.read(attempt.entityId).status, 'running');
  } finally { await w.close(); }
});

test('R6-3 an expired lease or an inactive member keeps the dispatch away from the native wake', async () => {
  for (const kind of ['expired-lease', 'inactive-member']) {
    const w = await instrumented();
    try {
      const release = holdDispatches(w);
      await member(w, 'w');
      const attempt = await startedTask(w, 'task:w', 'member:w');
      const agent = w.runtime.handles.get('member:w').agent;
      const held = 'dispatch:' + attempt.entityId;
      await until(() => w.runtime.store.effects().find(row => row.id === held)?.nextDue > Date.now() + 1000);
      await pumpNow(w, () => {
        release(held, { kick: false });
        // The row still says active/running; only the trusted clock or the member's own desired state has moved.
        if (kind === 'expired-lease') {
          w.runtime.core.mutate(attempt.entityId, 'scheduler', {}, tx => tx.put(attempt.entityId,
            { ...tx.read(attempt.entityId), expiresAt: w.runtime.host.clock.now() - 1 }));
        } else {
          w.runtime.core.mutate('member:w', 'scheduler', {}, tx => tx.put('member:w', { ...tx.read('member:w'), desired: 'frozen' }));
        }
      });
      const row = w.runtime.store.read(attempt.entityId);
      assert.equal(row.lease, 'active', kind + ': the row still looks active');
      assert.equal(row.status, 'running', kind + ': the row still looks running');
      await until(() => w.runtime.store.effects().find(row => row.id === held)?.status !== 'applying');
      const dispatch = w.runtime.store.effects().find(row => row.id === held);
      assert.notEqual(dispatch.status, 'confirmed', kind + ': the dispatch is not a success');
      assert.equal(dispatch.lastEvidence.notExecuted, true, kind + ': it is reported as not executed');
      assert.match(String(dispatch.lastEvidence.reason), /lease/, kind + ': the lease rule refused it');
      assert.equal(w.runtime.store.read('attempt-dispatch:' + attempt.entityId), null, kind + ': nothing was dispatched');
      assert.equal(wakesOf(w, agent.session.id), 0, kind + ': the native wake was never reached');
    } finally { await w.close(); }
  }
});

test('R6-3 an intent result does not wake an expired lease or an inactive member', async () => {
  for (const kind of ['expired-lease', 'inactive-member']) {
    const w = await instrumented();
    try {
      await member(w, 'a'); await member(w, 'b');
      const attempt = await startedTask(w, 'task:a', 'member:a');
      const agent = w.runtime.handles.get('member:a').agent;
      await until(() => wakesOf(w, agent.session.id) === 1);
      endTurn(agent);
      const intent = w.runtime.host.executeAuthorized('business', () => w.runtime.core.send('member:a', ['member:b'], 'intent',
        'plan', { taskRef: 'task:a', contractRevision: 1 }).result.entityId);
      const before = wakesOf(w, agent.session.id);
      await pumpNow(w, () => {
        // Close the window and damage the execution in the same turn: the open-time binding is already durable.
        w.runtime.host.executeAuthorized('business', () => w.runtime.core.replyIntent(intent, 'member:b', 'ok'));
        if (kind === 'expired-lease') {
          w.runtime.core.mutate(attempt.entityId, 'scheduler', {}, tx => tx.put(attempt.entityId,
            { ...tx.read(attempt.entityId), expiresAt: w.runtime.host.clock.now() - 1 }));
        } else {
          w.runtime.core.mutate('member:a', 'scheduler', {}, tx => tx.put('member:a', { ...tx.read('member:a'), desired: 'frozen' }));
        }
      });
      await until(() => w.runtime.store.effects().find(row => row.id === 'intent-result:' + intent)?.status !== 'applying');
      const result = w.runtime.store.effects().find(row => row.id === 'intent-result:' + intent);
      assert.notEqual(result.status, 'confirmed', kind + ': the result is not a success');
      assert.equal(result.lastEvidence.notExecuted, true, kind + ': it is reported as not executed');
      assert.match(String(result.lastEvidence.reason), /lease/, kind + ': the lease rule refused it');
      assert.equal(w.runtime.store.read('intent-result-receipt:' + intent), null, kind + ': no receipt');
      assert.equal(wakesOf(w, agent.session.id), before, kind + ': the initiator was never woken');
    } finally { await w.close(); }
  }
});

test('R6 a message delivered with no live execution is picked up by the scheduler mailbox task and dispatched once', async () => {
  const w = await instrumented();
  try {
    await member(w, 'w');
    const agent = w.runtime.handles.get('member:w').agent;
    assert.equal(w.runtime.store.list('attempt:').length, 0, 'the member has no execution yet');
    const messageId = send(w, 'member:w', 'work that arrives before the execution');
    await until(() => w.runtime.store.effects().find(row => row.id === messageId)?.status === 'confirmed');
    const notice = w.runtime.store.effects().find(row => row.id === messageId);
    assert.equal(notice.lastEvidence.receipt.delivered, false, 'there was no execution to wake at delivery time');
    await until(() => w.runtime.store.read('task:mail-member:w') !== null);
    await until(() => wakesOf(w, agent.session.id) === 1);
    const attempt = w.runtime.store.list('attempt:').find(row => row.owner === 'member:w' && row.status === 'running');
    assert.equal(w.runtime.store.read('task:mail-member:w').status, 'executing');
    assert.equal(w.runtime.store.read('attempt-dispatch:' + attempt.entityId)?.by, 'dispatch');
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(wakesOf(w, agent.session.id), 1, 'the scheduler mailbox task dispatched the attempt exactly once');
  } finally { await w.close(); }
});
