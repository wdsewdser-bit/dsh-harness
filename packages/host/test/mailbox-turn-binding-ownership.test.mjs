// Review 2 #2 (the turn) and review 1 #4 / review 2 #3 (the revision race) of the mailbox hand-over.
//
// Two orderings the product really creates:
//
//   1. A wake is prepared while the turn of the attempt it replaces is still ending. The old turn/end used to close the
//      NEW wake (the release was recorded and replayed on the new start's receipt), the new dispatch was cancelled, and
//      the message was already in the mailbox task's dedup set - a message nothing would wake for again.
//   2. The wake's start effect is registered against the attempt row, and the hand-over releases that attempt before the
//      close-out runs. The revision the registration froze necessarily moved, so the strict check answered
//      STALE_EFFECT_SUBJECT and left the start applying.
//
// Both are driven through the real path here: the profile's own turn listener, and core-access registerEffect() with the
// revisions it really stored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { profile, until } from '../test-support/profile.mjs';
import { real } from '../test-support/real.mjs';
import { certificate } from '../test-support/execution.mjs';


import { world, send, requestMember, mailboxAttempts, emit } from '../test-support/mailbox-fixtures.mjs';

async function uncertainWake(autonomy = 'on') {
  const w = await world({ autonomy });
  try {
    await requestMember(w, 'w');
    const agent = w.runtime.handles.get('member:w').agent;
    agent.phase = { kind: 'maintenance' };
    send(w, 'member:w', 'prepare uncertain execution');
    await until(() => mailboxAttempts(w).some(a => a.status === 'running'));

    const attempt = mailboxAttempts(w).find(a => a.status === 'running');
    let starts = 0;
    agent.wakeDriver = () => {
      starts++;
      for (const fn of [...w.listeners.get('session/event')]) fn(agent.session, { type: 'turn/start' });
      agent.phase = { kind: 'running' };
      throw Error('wake failed after start');
    };
    agent.phase = { kind: 'idle' };
    await until(() => w.runtime.store.effects().some(e => ['dispatch','message','wake'].includes(e.payload?.kind) && e.status === 'unknown'));
    const uncertain=w.runtime.store.effects().find(e=>['dispatch','message','wake'].includes(e.payload?.kind)&&e.status==='unknown');
    return { w, agent, attempt,effectId:uncertain.id,initialTries:uncertain.tries, get starts() { return starts; } };
  } catch (error) { await w.close();throw error; }
}

test('autonomy on start then throw stays unknown and never opens another turn', async () => {
  const u = await uncertainWake('on'), { w, agent, attempt } = u;
  try {
    await emit(w, 'w', { type: 'turn/end' }); agent.phase = { kind: 'idle' };
    send(w, 'member:w', 'another message cannot reuse the uncertain execution');
    for (let n = 0; n < 4; n++) { await w.runtime.host.cycle.run(); await w.runtime.runner.whenIdle(); }
    const effect = w.runtime.store.effects().find(e => e.id === u.effectId);
    assert.equal(effect.status, 'unknown'); assert.equal(effect.tries, u.initialTries);
    assert.equal(u.starts, 1);
    assert.equal(w.runtime.store.read(attempt.entityId).lease, 'active');
    assert.ok(w.runtime.store.list('decision:').some(d => d.kind === 'unknown-effect'));
  } finally { await w.close(); }
});

test('unknown dispatch with active lease blocks work without a stop proof', async () => {
  const { w, attempt } = await uncertainWake('off');
  try {
    w.runtime.host.command({ teamId: w.runtime.host.teamId, actor: 'root', requestId: 'task:uncertain-work',
      operationId: 'v1:operation:' + 'uncertain-work'.padEnd(20, 'x'),
      payload: { command: 'team.task.request', entityId: 'task:uncertain-work', owner: 'member:w' } });
    for (let n = 0; n < 4; n++) await w.runtime.host.cycle.run();
    assert.equal(w.runtime.store.read(attempt.entityId).lease, 'active', 'no evidence permits the handover release');
    assert.equal(w.runtime.store.read('task:uncertain-work').status, 'ready');
    assert.equal(w.runtime.store.list('attempt:').some(a => a.taskId === 'task:uncertain-work'), false);
    assert.equal(w.runtime.store.effects().find(e => e.id === 'dispatch:' + attempt.entityId).status, 'unknown');
    assert.equal(w.runtime.status().executionBindings, 1, 'retain the exact execution while it remains uncertain');
  } finally { await w.close(); }
});

test('session disposal synchronously revokes watcher without another event', async () => {
  const w = await world();
  try {
    await requestMember(w, 'w');
    const agent = w.runtime.handles.get('member:w').agent;
    agent.phase = { kind: 'maintenance' };
    const base = w.listeners.get('session/event').size;
    send(w, 'member:w', 'prepare watcher for disposal');
    await until(() => mailboxAttempts(w).some(a => a.status === 'running'));

    assert.equal(w.listeners.get('session/event').size, base + 1);
    await w.ctx.emit('session/disposed', agent.session);
    assert.equal(w.runtime.router.routeExecution(agent.session.id).routed, false);
    assert.equal(w.listeners.get('session/event').size, base, 'unbind itself detached the watcher');
  } finally { await w.close(); }
});

test('completed mailbox execution bindings do not accumulate', async () => {
  const w = await world();
  try {
    await requestMember(w, 'w');
    const agent = w.runtime.handles.get('member:w').agent;
    for (let n = 0; n < 12; n++) {
      agent.phase = { kind: 'idle' };
      send(w, 'member:w', 'bounded execution history ' + n);
      await until(() => mailboxAttempts(w).some(a => a.lease === 'active' && a.status === 'running'));
      const a = mailboxAttempts(w).find(a => a.lease === 'active' && a.status === 'running');
      await until(() => w.runtime.store.read('attempt-dispatch:' + a.entityId));
      assert.equal(w.runtime.status().executionBindings, 1);
      await emit(w, 'w', { type: 'turn/start' }); await emit(w, 'w', { type: 'turn/end' });
      await until(() => w.runtime.store.read(a.entityId).lease === 'released');
      await w.runtime.host.cycle.run();
      assert.equal(w.runtime.status().executionBindings, 0, 'terminal execution ' + n + ' was retired');
    }
  } finally { await w.close(); }
});

test('an armed watcher cannot release the lease after an unknown message', async () => {
  const w = await world();
  try {
    await requestMember(w, 'w');
    send(w, 'member:w', 'successful initial wake');
    await until(() => mailboxAttempts(w).some(a => a.status === 'running'));

    const attempt = mailboxAttempts(w).find(a => a.status === 'running');
    await until(() => w.runtime.store.read('attempt-dispatch:' + attempt.entityId));
    await emit(w, 'w', { type: 'turn/start' });
    w.runtime.preempt.deliverMail = () => { throw Error('message delivery is uncertain'); };
    const id = send(w, 'member:w', 'unknown message while the watcher is armed');
    await until(() => w.runtime.store.effects().some(e => e.payload?.messageId === id && e.status === 'unknown'));
    const effect = w.runtime.store.effects().find(e => e.payload?.messageId === id && e.status === 'unknown');
    assert.equal(w.runtime.store.read('effect-execution:' + effect.id).attemptId, attempt.entityId);
    await emit(w, 'w', { type: 'turn/end' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(w.runtime.store.read(attempt.entityId).lease, 'active', 'an unrelated turn end is not stop evidence for the unknown send');
    assert.equal(w.runtime.status().executionBindings, 1);
  } finally { await w.close(); }
});

test('unknown binding retains the original agent until verified cancel completes', async () => {
  const { w, agent, attempt } = await uncertainWake('on');
  try {
    assert.equal(w.runtime.status().executionBindings, 1);
    w.runtime.handles.get('member:w').agent = { ...agent, session: { ...agent.session, id: 'session:replacement' } };
    let proven = false;
    w.runtime.core.ports.stopProof = async ({ subject, agent: actual }) => {
      assert.strictEqual(actual, agent, 'cancellation must use the exact old execution, not the replacement');
      proven = true;
      w.runtime.executionScopes.get(agent.session.id)?.seal();
      return { ...certificate(w.runtime.core,subject,{attemptId:attempt.entityId}),kind: 'stop-proof', subject, method: 'in-process-session', roots: [],
        verified: true,
        writtenBy: 'adapter', switch: 'on', at: Date.now(), confidence: 'medium', error: null,
        checks: { llm: { sessionId: agent.session.id } } };
    };
    w.runtime.host.coreAccess.lifecycle().mutate('seed:cancel-retained', 'scheduler', {}, tx => {
      tx.put(attempt.entityId, { ...tx.read(attempt.entityId), lease: 'unknown', status: 'unknown' });
      tx.outbox('cancel:' + attempt.entityId, { kind: 'cancel', attemptId: attempt.entityId }); return null;
    });
    await until(() => w.runtime.store.read(attempt.entityId).lease === 'revoked');
    assert.equal(proven, true);
    await w.runtime.host.cycle.run();
    assert.equal(w.runtime.status().executionBindings, 0, 'the verified terminal execution no longer needs its cached agent');
  } finally { await w.close(); }
});

async function heldDelivery(numbered = false) {
  const w = await world({ autonomy: 'on' });
  try {
    await requestMember(w, 'w');
    const initial = send(w, 'member:w', 'initial confirmed wake');
    await until(() => mailboxAttempts(w).some(a => a.status === 'running'));

    const attempt = mailboxAttempts(w).find(a => a.status === 'running');
    await until(() => w.runtime.store.read('attempt-dispatch:' + attempt.entityId));
    // whenIdle joins applying jobs, not a delivery still in durable retry backoff before E was installed.
    await until(() => w.runtime.store.effects().some(e => e.payload?.messageId === initial && e.status === 'confirmed'));
    await w.runtime.runner.whenIdle();
    const agent = w.runtime.handles.get('member:w').agent;
    await emit(w, 'w', { type: 'turn/start', ...(numbered ? { data: { turn: 1 } } : {}) });
    let resume, waiting = false;
    agent.whenIdle = () => { waiting = true; return new Promise(resolve => { resume = resolve; }); };
    // Info still uses the real delivery effect, but cannot request a fresh mailbox task after this one retires.
    const id = w.runtime.host.executeAuthorized('business', () => w.runtime.core.send('member:root', 'member:w',
      'info', 'delivery waits for a native step or idle').result.entityId);
    await until(() => waiting && w.runtime.store.effects().some(e => e.payload?.messageId === id && e.status === 'applying'));
    const effect = () => w.runtime.store.effects().find(e => e.payload?.messageId === id);
    return { w, agent, attempt, effect, resume: () => resume?.(), fail() {
      agent.phase = { kind: 'idle' };
      w.runtime.preempt.deliverMail = () => { throw Error('idle fallback failed after the pending delivery'); };
      resume();
    } };
  } catch (error) { await w.close();throw error; }
}
async function cancelHeldExecution(h) {
  const { w, agent, attempt } = h;
  let exact = false;
  w.runtime.core.ports.stopProof = async ({ subject, agent: actual }) => {
    assert.strictEqual(actual, agent, 'the original execution, not a newer handle, must be cancelled');
    exact = true;
    w.runtime.executionScopes.get(agent.session.id)?.seal();
    return { ...certificate(w.runtime.core,subject,{attemptId:attempt.entityId}),kind: 'stop-proof', subject, method: 'in-process-session', roots: [],
      verified: true,
      writtenBy: 'adapter', switch: 'on', at: Date.now(), confidence: 'medium', error: null,
      checks: { llm: { sessionId: agent.session.id } } };
  };
  w.runtime.host.coreAccess.lifecycle().mutate('seed:held-cancel', 'scheduler', {}, tx => {
    tx.put(attempt.entityId, { ...tx.read(attempt.entityId), lease: 'unknown', status: 'unknown' });
    tx.outbox('cancel:' + attempt.entityId, { kind: 'cancel', attemptId: attempt.entityId }); return null;
  });
  await until(() => w.runtime.store.read(attempt.entityId).lease === 'revoked');
  assert.equal(exact, true);
}

test('delivery pending, handover refused, later unknown still has exact cancellable execution', async () => {
  const h = await heldDelivery(), { w, attempt } = h;
  try {
    assert.equal(h.effect().status, 'applying');
    w.runtime.host.command({ teamId: w.runtime.host.teamId, actor: 'root', requestId: 'task:held-work',
      operationId: 'v1:operation:' + 'held-work'.padEnd(20, 'x'),
      payload: { command: 'team.task.request', entityId: 'task:held-work', owner: 'member:w' } });
    await w.runtime.host.cycle.run();
    assert.equal(h.effect().status, 'applying', 'the delivery has not answered yet');
    assert.equal(w.runtime.store.read(attempt.entityId).lease, 'active');
    assert.equal(w.runtime.store.read('task:held-work').status, 'ready');
    assert.equal(w.runtime.store.list('attempt:').some(a => a.taskId === 'task:held-work'), false);
    assert.equal(w.runtime.status().executionBindings, 1);
    h.fail(); await until(() => h.effect().status === 'unknown');
    await w.runtime.host.cycle.run();
    assert.equal(w.runtime.store.read(attempt.entityId).lease, 'active');
    assert.equal(w.runtime.status().executionBindings, 1);
    await cancelHeldExecution(h);
  } finally { h.resume(); await w.close(); }
});

test('a terminal lease cannot retire an applying or unknown native call', async () => {
  const h = await heldDelivery(), { w, attempt } = h;
  try {
    // Model a pre-fix/externally recorded release: retention must independently preserve the native call.
    const payload = { attemptId: attempt.entityId, fence: attempt.fence, status: 'cancelled' };
    assert.throws(()=>w.runtime.host.coreAccess.lifecycle().dispatch(attempt.entityId, attempt.owner, payload, { type: 'attempt.release', payload }),{code:
      'EXECUTION_REQUIRES_CLOSEOUT'});
    await w.runtime.host.cycle.run();
    assert.equal(h.effect().status, 'applying');
    assert.equal(w.runtime.status().executionBindings, 1, 'applying still owns the exact agent');
    h.fail(); await until(() => h.effect().status === 'unknown');
    await w.runtime.host.cycle.run();
    assert.equal(w.runtime.status().executionBindings, 1, 'unknown cannot discard that agent either');
    await cancelHeldExecution(h);
    await w.runtime.host.cycle.run();
    assert.equal(w.runtime.status().executionBindings, 0, 'verified stop is sufficient to retire it');
  } finally { h.resume(); await w.close(); }
});

for (const outcome of ['confirmed', 'unknown']) test('turn end during applying waits for ' + outcome + ' closeout', async () => {
  const h = await heldDelivery(), { w, attempt } = h;
  try {
    await emit(w, 'w', { type: 'turn/end' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.effect().status, 'applying');
    assert.equal(w.runtime.store.read(attempt.entityId).lease, 'active', 'no release before the pending call has an outcome');
    if (outcome === 'unknown') h.fail(); else h.resume();
    await until(() => h.effect().status === outcome);
    if (outcome === 'confirmed') {
      await until(() => w.runtime.store.read(attempt.entityId).lease === 'revoked');
      assert.equal(w.runtime.status().executionBindings, 0, 'the domain reducer consumed the completed execution certificate');
    } else {
      await w.runtime.host.cycle.run();
      assert.equal(w.runtime.store.read(attempt.entityId).lease, 'active');
      assert.equal(w.runtime.status().executionBindings, 1);
      await cancelHeldExecution(h);
    }
  } finally { h.resume(); await w.close(); }
});

for (const numbered of [false, true]) test('deferred T1 end cannot release fallback T2, numbered=' + numbered, async () => {
  const h = await heldDelivery(numbered), { w, agent, attempt } = h;
  try {
    const event = (type, n) => ({ type, ...(numbered ? { data: { turn: n } } : {}) });
    agent.phase = { kind: 'idle' };
    await emit(w, 'w', event('turn/end', 1));
    // Native wake opens the replacement turn synchronously inside fallback.
    const nativeDeliverMail = w.runtime.preempt.deliverMail.bind(w.runtime.preempt);
    w.runtime.preempt.deliverMail = (...args) => {
      // A late delivery into live T2 merges; only the idle fallback may open T2.
      if (agent.phase.kind !== 'idle') return nativeDeliverMail(...args);
      agent.phase = { kind: 'running' };
      for (const fn of [...w.listeners.get('session/event')]) fn(agent.session, event('turn/start', 2));
      return { wake: 'woke', dispatched: true };
    };
    h.resume(); await until(() => h.effect().status === 'confirmed');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(agent.phase.kind, 'running');
    assert.equal(w.runtime.store.read(attempt.entityId).lease, 'active', 'T1 deferred release cannot revoke T2');
    assert.equal(w.runtime.status().executionBindings, 1);
    // More receipts cannot replay the discarded T1 release either.
    for (let n = 0; n < 3; n++) {
      w.runtime.host.coreAccess.lifecycle().mutate('seed:receipt:' + n, 'scheduler', {}, tx => {
        tx.outbox('gc:receipt:' + n, { kind: 'gc' }); return null;
      });
      await w.runtime.host.cycle.run(); await w.runtime.runner.whenIdle();
      assert.equal(w.runtime.store.read(attempt.entityId).lease, 'active');
    }
    await emit(w, 'w', event('turn/end', 2));
    await until(() => w.runtime.store.read(attempt.entityId).lease === 'revoked');
    assert.equal(w.runtime.status().executionBindings, 0);
  } finally { h.resume(); await w.close(); }
});

test('stop racing multiple pending receipt releases cannot release a later turn', async () => {
  const h = await heldDelivery(), { w, agent, attempt } = h;
  let resumeSecond;
  try {
    // Two applying deliveries own separate observations of T1.
    agent.whenIdle = () => new Promise(resolve => { resumeSecond = resolve; });
    const id = w.runtime.host.executeAuthorized('business', () => w.runtime.core.send('member:root', 'member:w', 'info', 'second delivery').result.entityId);
    await until(() => resumeSecond && w.runtime.store.effects().some(e => e.payload?.messageId === id && e.status === 'applying'));
    agent.phase = { kind: 'idle' };
    await emit(w, 'w', { type: 'turn/end' });
    const nativeDeliverMail = w.runtime.preempt.deliverMail.bind(w.runtime.preempt);
    w.runtime.preempt.deliverMail = (...args) => {
      if (agent.phase.kind !== 'idle') return nativeDeliverMail(...args);
      agent.phase = { kind: 'running' };
      for (const fn of [...w.listeners.get('session/event')]) fn(agent.session, { type: 'turn/start' });
      return { wake: 'woke', dispatched: true };
    };
    h.resume(); await until(() => h.effect().status === 'confirmed');
    assert.equal(w.runtime.store.read(attempt.entityId).lease, 'active');
    let stopping;
    resumeSecond();
    // stop() changes host state before the remaining receipt can replay release.
    stopping = w.runtime.host.stop();
    await w.runtime.runner.whenIdle();
    await stopping;
    assert.equal(w.runtime.store.read(attempt.entityId).lease, 'active');
    assert.deepEqual(w.runtime.mailboxReleases, []);
  } finally { resumeSecond?.(); h.resume(); await w.close(); }
});

