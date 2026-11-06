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
import { drain } from '../../core/index.mjs';
import { certificate } from '../test-support/execution.mjs';


import { world, send, requestMember, mailboxAttempts, emit } from '../test-support/mailbox-fixtures.mjs';

test('review 2 #2: an older turn/end does not consume the wake a newer start opened', async () => {
  const w = await world();
  try {
    await requestMember(w, 'w');
    send(w, 'member:w', 'a wake that arrives while the last turn is still ending');
    await until(() => mailboxAttempts(w).some(row => row.status === 'running'));
    const attempt = mailboxAttempts(w).find(row => row.status === 'running');
    // The turn of the work that just let go of its lease ends AFTER this wake was prepared. It is not this wake's turn.
    await emit(w, 'w', { type: 'turn/end', data: { turn: 1 } });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(w.runtime.store.read(attempt.entityId).lease, 'active', 'the older turn did not close this wake');
    assert.deepEqual(w.runtime.mailboxReleases, [], 'and nothing was refused either: there was simply nothing to do');
    // The turn this wake opened ends: that one releases it, exactly as before.
    await emit(w, 'w', { type: 'turn/start', data: { turn: 2 } });
    await emit(w, 'w', { type: 'turn/end', data: { turn: 2 } });
    await until(() => w.runtime.store.read(attempt.entityId).lease === 'released');
    const released = w.runtime.store.read(attempt.entityId);
    assert.equal(released.status, 'cancelled');
    assert.equal(released.reason, 'mailbox wake ended with its turn');
    assert.equal(w.runtime.store.read(attempt.taskId).status, 'cancelled', 'the wake task is closed with its turn');
  } finally { await w.close(); }
});

test('review 2 #2 / review 3 #2: a wake that merges into a live turn is released by that turn, not by the next one', async () => {
  const w = await world();
  try {
    await requestMember(w, 'w');
    const agent = w.runtime.handles.get('member:w').agent;
    // The member is inside turn 1, so the wake cannot open one of its own: it merges into the turn that is running.
    agent.phase = { kind: 'running' };
    agent.session.snapshotEvents = () => [{ type: 'turn/start', seq: 1, data: { turn: 1 } }];
    send(w, 'member:w', 'a wake that merges into the turn already running');
    await until(() => mailboxAttempts(w).some(row => row.status === 'running'));
    const attempt = mailboxAttempts(w).find(row => row.status === 'running');
    await until(() => w.runtime.store.effects().some(row => row.id === 'dispatch:' + attempt.entityId && row.status === 'confirmed'));
    // An end that names a turn this wake never merged into is another turn's, and releases nothing.
    await emit(w, 'w', { type: 'turn/end', data: { turn: 7 } });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(w.runtime.store.read(attempt.entityId).lease, 'active', 'a foreign turn/end did not close this wake');
    // The turn it merged into does end it.
    await emit(w, 'w', { type: 'turn/end', data: { turn: 1 } });
    await until(() => w.runtime.store.read(attempt.entityId).lease === 'released');
    assert.equal(w.runtime.store.read(attempt.entityId).status, 'cancelled');
  } finally { await w.close(); }
});

test('review 3 #2: a journal that names no turns binds by its own sequence, never by the first end that arrives', async () => {
  const w = await world();
  try {
    await requestMember(w, 'w');
    // A session that names no turns (an older adapter) and is in a live turn: same merge, without the numbers. The
    // sequence alone has to be enough - the end in flight at merge time belongs to the turn the wake merged into.
    w.runtime.handles.get('member:w').agent.phase = { kind: 'running' };
    send(w, 'member:w', 'a wake into a journal without turn numbers');
    await until(() => mailboxAttempts(w).some(row => row.status === 'running'));
    const attempt = mailboxAttempts(w).find(row => row.status === 'running');
    await until(() => w.runtime.store.effects().some(row => row.id === 'dispatch:' + attempt.entityId && row.status === 'confirmed'));
    // No start was seen by this host, so no end may release: an unnumbered end here is not evidence of anything.
    await emit(w, 'w', { type: 'turn/end' });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(w.runtime.store.read(attempt.entityId).lease, 'active', 'an end with no turn to match did not release the wake');
    // The controlled sequence: this host sees the turn start, then its end.
    await emit(w, 'w', { type: 'turn/start' });
    await emit(w, 'w', { type: 'turn/end' });
    await until(() => w.runtime.store.read(attempt.entityId).lease === 'released');
    assert.equal(w.runtime.store.read(attempt.entityId).status, 'cancelled');
  } finally { await w.close(); }
});

test('review 1 #4: a start registered against a real revision settles as cancelled when its attempt is released first', async () => {
  const w = await real();
  try {
    w.core.member('member:w', 'worker');
    w.core.mutate('mailbox', 'scheduler', {}, tx => {
      tx.put('task:mail-member:w', { owner: 'member:w', mailboxOnly: true, status: 'executing', approved: true,
        attemptId: 'attempt:wake', contractRevision: 1 });
      return tx.put('attempt:wake', { owner: 'member:w', taskId: 'task:mail-member:w', lease: 'active',
        status: 'running', fence: 1, generation: 1, expiresAt: w.at + 600000, scopeSet: [] });
    });
    w.core.mutate('outbox', 'scheduler', {}, tx => {
      tx.outbox('attempt:wake', { kind: 'start', attemptId: 'attempt:wake', owner: 'member:w', generation: 1, fence: 1 });
      return null;
    });
    const access = w.host.coreAccess.lifecycle();
    const claim = access.claim('attempt:wake', 'adapter');
    // The registration the runner makes: the revisions it stores are the REAL ones, taken from the rows.
    const managed = access.registerEffect('attempt:wake', claim.result.fence);
    const registeredAttempt = w.store.read('attempt:wake').revision;
    // The hand-over the product performs in the transaction that admits the work task.
    const payload = { attemptId: 'attempt:wake', fence: 1, status: 'cancelled',
      reason: 'mailbox wake released so the member can take its work task' };
    access.dispatch('attempt:wake', 'member:w', payload, { type: 'attempt.release', payload });
    assert.equal(w.store.read('attempt:wake').lease, 'released');
    assert.notEqual(w.store.read('attempt:wake').revision, registeredAttempt, 'the release really moved the revision');
    // Without the narrow release rule this throws STALE_EFFECT_SUBJECT (the reviewed failure) and the start stays applying.
    managed.complete({ executed: true, receipt: { prepared: true, executionSessionId: 'session:w' } });
    managed.close();
    assert.equal(w.store.effects().find(row => row.id === 'attempt:wake').status, 'cancelled');
    assert.equal(w.store.read('attempt:wake').lease, 'released', 'the close-out did not revive the released attempt');
  } finally { await w.close(); }
});

test('ownership A: work alreadyLive cannot leave a merge for the next mailbox start', async () => {
  const w = await world();
  try {
    await requestMember(w, 'w');
    const agent = w.runtime.handles.get('member:w').agent;
    const events = [{ type: 'turn/start', data: { turn: 1 } }];
    agent.session.snapshotEvents = () => events;
    agent.phase = { kind: 'running' };
    w.runtime.host.command({ teamId: w.runtime.host.teamId, actor: 'root', requestId: 'task:work',
      operationId: 'v1:operation:' + 'ownership-work'.padEnd(20, 'x'),
      payload: { command: 'team.task.request', entityId: 'task:work', owner: 'member:w' } });
    await until(() => w.runtime.store.effects().some(e => e.payload?.kind === 'dispatch' && e.status === 'confirmed'));
    const work = w.runtime.store.list('attempt:').find(a => a.taskId === 'task:work');
    assert.equal(w.runtime.store.read('attempt-dispatch:' + work.entityId).by, 'live');
    const payload = { attemptId: work.entityId, fence: work.fence, status: 'cancelled' };
    w.runtime.host.coreAccess.lifecycle().dispatch(work.entityId, work.owner, payload, { type: 'attempt.release', payload });
    events.push({ type: 'turn/end', data: { turn: 1 } });
    await emit(w, 'w', events.at(-1));
    // Hold dispatch in maintenance; start must not consume the completed work's merge.
    agent.phase = { kind: 'maintenance' };
    send(w, 'member:w', 'new mailbox execution after the work ended');
    await until(() => mailboxAttempts(w).some(a => a.status === 'running'));

    const mail = mailboxAttempts(w).find(a => a.status === 'running');
    await w.runtime.host.cycle.run();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(w.runtime.store.read(mail.entityId).lease, 'active', 'new start owns no old merge');
    assert.equal(w.runtime.store.read('attempt-dispatch:' + mail.entityId), null);
    agent.phase = { kind: 'idle' };
    await until(() => w.runtime.store.read('attempt-dispatch:' + mail.entityId));
    await emit(w, 'w', { type: 'turn/start', data: { turn: 2 } });
    await emit(w, 'w', { type: 'turn/end', data: { turn: 2 } });
    await until(() => w.runtime.store.read(mail.entityId).lease === 'released');
  } finally { await w.close(); }
});

test('ownership B: synchronous unnumbered start inside wake is confirmed, pre-window start is not', async () => {
  const w = await world();
  try {
    await requestMember(w, 'w');
    const agent = w.runtime.handles.get('member:w').agent;
    const bind = w.runtime.bindAgent.bind(w.runtime);
    w.runtime.bindAgent = (...args) => {
      const result = bind(...args);
      // Emit straight through listeners to model a synchronous native journal (ctx.emit is async in this fixture).
      for (const fn of [...w.listeners.get('session/event')]) fn(agent.session, { type: 'turn/start' });
      return result;
    };
    agent.wakeDriver = () => {
      for (const fn of [...w.listeners.get('session/event')]) fn(agent.session, { type: 'turn/end' });
      for (const fn of [...w.listeners.get('session/event')]) fn(agent.session, { type: 'turn/start' });
      agent.phase = { kind: 'running' };
    };
    send(w, 'member:w', 'synchronous start');
    await until(() => mailboxAttempts(w).some(a => a.status === 'running'));

    const mail = mailboxAttempts(w).find(a => a.status === 'running');
    await until(() => w.runtime.store.read('attempt-dispatch:' + mail.entityId));
    assert.equal(w.runtime.store.read(mail.entityId).lease, 'active', 'the old end preceding this window start cannot release');
    await emit(w, 'w', { type: 'turn/end' });
    await until(() => w.runtime.store.read(mail.entityId).lease === 'released');
    assert.deepEqual(w.runtime.mailboxReleases, []);
  } finally { await w.close(); }
});


test('ownership B: a pre-window unnumbered start cannot authorize a later end', async () => {
  const w = await world();
  try {
    await requestMember(w, 'w');
    const agent = w.runtime.handles.get('member:w').agent;
    agent.phase = { kind: 'maintenance' };
    send(w, 'member:w', 'wait before wake');
    await until(() => mailboxAttempts(w).some(a => a.status === 'running'));

    const mail = mailboxAttempts(w).find(a => a.status === 'running');
    await emit(w, 'w', { type: 'turn/start' });
    agent.phase = { kind: 'idle' };
    await until(() => w.runtime.store.read('attempt-dispatch:' + mail.entityId));
    await emit(w, 'w', { type: 'turn/end' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(w.runtime.store.read(mail.entityId).lease, 'active');
    await emit(w, 'w', { type: 'turn/start' });
    await emit(w, 'w', { type: 'turn/end' });
    await until(() => w.runtime.store.read(mail.entityId).lease === 'released');
  } finally { await w.close(); }
});

test('ownership A: asynchronous delivery refuses a superseded execution binding', async () => {
  const w = await world({ simulateRequests: false });
  let resume;
  try {
    await requestMember(w, 'w');
    const agent = w.runtime.handles.get('member:w').agent;
    agent.phase = { kind: 'running' };
    agent.session.snapshotEvents = () => [{ type: 'turn/start', data: { turn: 1 } }];
    w.runtime.host.command({ teamId: w.runtime.host.teamId, actor: 'root', requestId: 'task:work',
      operationId: 'v1:operation:' + 'async-ownership'.padEnd(20, 'x'),
      payload: { command: 'team.task.request', entityId: 'task:work', owner: 'member:w' } });
    await until(() => w.runtime.store.effects().some(e => e.payload?.kind === 'dispatch' && e.status === 'confirmed'));
    const work = w.runtime.store.list('attempt:').find(a => a.taskId === 'task:work');
    let waiting = false;
    agent.whenIdle = () => { waiting = true; return new Promise(resolve => { resume = resolve; }); };
    const id = send(w, 'member:w', 'delivery to the old work execution');
    await until(() => waiting);
    const payload = { attemptId: work.entityId, fence: work.fence, status: 'cancelled' };
    w.runtime.host.coreAccess.lifecycle().dispatch(work.entityId, work.owner, payload, { type: 'attempt.release', payload });
    agent.phase = { kind: 'maintenance' };
    await until(() => mailboxAttempts(w).some(a => a.status === 'running'));

    const mail = mailboxAttempts(w).find(a => a.status === 'running');
    resume();
    await until(() => w.runtime.store.effects().some(e => e.payload?.messageId === id && e.status === 'unknown'));
    assert.equal(w.runtime.store.read('wake-receipt:' + id + ':member:w'), null);
    assert.equal(w.runtime.store.read(mail.entityId).lease, 'active');
    assert.equal(w.runtime.store.read('attempt-dispatch:' + mail.entityId), null);
  } finally { resume?.(); await w.close(); }
});


test('direct deliverMail throw always detaches its step listener', async () => {
  const w = await world();
  try {
    await requestMember(w, 'w');
    w.runtime.host.command({ teamId: w.runtime.host.teamId, actor: 'root', requestId: 'task:throw-work',
      operationId: 'v1:operation:' + 'throw-work'.padEnd(20, 'x'),
      payload: { command: 'team.task.request', entityId: 'task:throw-work', owner: 'member:w' } });
    await until(() => w.runtime.store.effects().some(e => e.payload?.kind === 'dispatch' && e.status === 'confirmed'));
    const count = w.listeners.get('session/event').size;
    w.runtime.preempt.deliverMail = () => { throw Error('preemptStep threw directly'); };
    const id = send(w, 'member:w', 'direct throw must not retain step listener');
    await until(() => w.runtime.store.effects().some(e => e.payload?.messageId === id && e.status === 'unknown'));
    assert.equal(w.listeners.get('session/event').size, count, 'exception finally removed step observer');
  } finally { await w.close(); }
});

test('rebinding a member removes its previous mailbox listener without old events', async () => {
  const w = await world();
  try {
    await requestMember(w, 'w');
    const agent = w.runtime.handles.get('member:w').agent;
    agent.phase = { kind: 'maintenance' };
    const base = w.listeners.get('session/event').size;
    send(w, 'member:w', 'create a watcher without arming it');
    await until(() => mailboxAttempts(w).some(a => a.status === 'running'));

    assert.equal(w.listeners.get('session/event').size, base + 1);
    const mail = mailboxAttempts(w).find(a => a.status === 'running');
    const payload = { attemptId: mail.entityId, fence: mail.fence, status: 'cancelled' };
    w.runtime.host.coreAccess.lifecycle().dispatch(mail.entityId, mail.owner, payload, { type: 'attempt.release', payload });
    w.runtime.host.command({ teamId: w.runtime.host.teamId, actor: 'root', requestId: 'task:rebind-work',
      operationId: 'v1:operation:' + 'rebind-work'.padEnd(20, 'x'),
      payload: { command: 'team.task.request', entityId: 'task:rebind-work', owner: 'member:w' } });
    await until(() => w.runtime.store.list('attempt:').some(a => a.taskId === 'task:rebind-work' && a.status === 'running'));
    assert.equal(w.listeners.get('session/event').size, base, 'no old session event was needed to revoke observer');
  } finally { await w.close(); }
});

test('wake start then throw retains unknown execution, not a false release', async () => {
  const w = await world();
  try {
    await requestMember(w, 'w');
    const agent = w.runtime.handles.get('member:w').agent;
    agent.phase = { kind: 'maintenance' };
    const base = w.listeners.get('session/event').size;
    send(w, 'member:w', 'prepare before the uncertain wake');
    await until(() => mailboxAttempts(w).some(a => a.status === 'running'));

    const mail = mailboxAttempts(w).find(a => a.status === 'running');
    w.runtime.preempt.wakeIdle = () => ({ fired: false, reason: 'notExecuting', defer: true });
    w.runtime.preempt.deliverMail = () => {
      for (const fn of [...w.listeners.get('session/event')]) fn(agent.session, { type: 'turn/start' });
      throw Error('driver failed after opening a turn');
    };
    const id = send(w, 'member:w', 'wake throws after start');
    agent.phase = { kind: 'idle' };
    await until(() => w.runtime.store.effects().some(e => e.payload?.messageId === id && e.status === 'unknown'));
    await emit(w, 'w', { type: 'turn/end' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(w.listeners.get('session/event').size, base, 'both step observer and unconfirmed wake observer detached');
    assert.equal(w.runtime.store.read(mail.entityId).lease, 'active', 'no stop proof exists, so lease is not released');
    assert.equal(w.runtime.store.read('wake-receipt:' + id + ':member:w'), null);
    assert.deepEqual(w.runtime.mailboxReleases, []);
  } finally { await w.close(); }
});

test('concurrent delivery A pending B refused start A confirms end releases', async () => {
  const w = await world(); let idle;
  try {
    await requestMember(w, 'w');
    const agent = w.runtime.handles.get('member:w').agent;
    agent.phase = { kind: 'maintenance' };
    send(w, 'member:w', 'prepare mailbox, hold dispatch');
    await until(() => mailboxAttempts(w).some(a => a.status === 'running'));

    const mail = mailboxAttempts(w).find(a => a.status === 'running');
    let a, b, waiting = false, bClosed = false;
    agent.whenIdle = () => { waiting = true; return new Promise(resolve => { idle = resolve; }); };
    w.runtime.preempt.wakeIdle = () => ({ fired: false, reason: 'notExecuting', defer: true });
    w.runtime.preempt.deliverMail = (_member, id) => {
      if (id === a) return { wake: 'live' };
      if (id === b) { bClosed = true; return { wake: 'refused' }; }
      return { wake: 'notExecuting', defer: true };
    };
    a = send(w, 'member:w', 'A waits for native step');
    b = send(w, 'member:w', 'B refuses and closes only its own window');
    agent.phase = { kind: 'running' };
    await until(() => waiting && bClosed);
    await emit(w, 'w', { type: 'turn/start' });
    await emit(w, 'w', { type: 'step/start', seq: 100 });
    await until(() => w.runtime.store.read('wake-receipt:' + a + ':member:w'));
    await emit(w, 'w', { type: 'turn/end' });
    await until(() => w.runtime.store.read(mail.entityId).lease === 'released');
  } finally { idle?.(); await w.close(); }
});


test('dispatch wake emits start then throws without claiming a stop', async () => {
  const w = await world();
  try {
    await requestMember(w, 'w');
    const agent = w.runtime.handles.get('member:w').agent;
    agent.phase = { kind: 'maintenance' };
    const base = w.listeners.get('session/event').size;
    send(w, 'member:w', 'dispatch wake will throw');
    await until(() => mailboxAttempts(w).some(a => a.status === 'running'));

    const mail = mailboxAttempts(w).find(a => a.status === 'running');
    agent.wakeDriver = () => {
      for (const fn of [...w.listeners.get('session/event')]) fn(agent.session, { type: 'turn/start' });
      throw Error('wakeDriver threw after start');
    };
    agent.phase = { kind: 'idle' };
    await until(() => w.runtime.store.effects().some(e => e.id === 'dispatch:' + mail.entityId && e.status === 'unknown'));
    await emit(w, 'w', { type: 'turn/end' });
    assert.equal(w.listeners.get('session/event').size, base);
    assert.equal(w.runtime.store.read(mail.entityId).lease, 'active');
    assert.equal(w.runtime.store.read('attempt-dispatch:' + mail.entityId), null);
    assert.deepEqual(w.runtime.mailboxReleases, []);
  } finally { await w.close(); }
});


