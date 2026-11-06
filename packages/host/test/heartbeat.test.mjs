import test from 'node:test';
import assert from 'node:assert/strict';
import { real } from '../test-support/real.mjs';
import { createClock } from '../src/clock.mjs';
import { SessionRouter } from '../index.mjs';
for (const kind of ['frozen', 'expired', 'fence', 'epoch', 'completion', 'generation']) test('F5 heartbeat rejects ' + kind + ' without changing the database',
  async () => {
 const w = await real();
 try {
  w.core.member('member:w', 'worker'); w.core.task('task:t', 'member:w');
  const a = w.core.schedule('event:seed', 'task:t', w.at).result;
  const port = w.host.coreAccess.lifecycle();
  assert.equal(port.heartbeat(a.attemptId, a.fence, w.host.status().epoch, w.at).status, 'confirmed');
  if (kind === 'frozen' || kind === 'generation') w.core.mutate('member:w', 'scheduler', {}, tx => { const m = tx.read('member:w'); return tx.put('member:w',
    { ...m, ...(kind === 'frozen' ? { desired: 'frozen' } : { generation: m.generation + 1 }) }); });
  if (kind === 'completion') w.core.mutate('completion:c', 'scheduler', {}, tx => tx.put('completion:c', { status: 'prepared' }));
  if (kind === 'expired') w.at += 60000;
  const before = w.snapshot();
  assert.throws(() => port.heartbeat(a.attemptId, a.fence + (kind === 'fence' ? 1 : 0), w.host.status().epoch + (kind === 'epoch' ? 1 : 0), w.at),
    { code: kind === 'completion' ? 'COMPLETION_FROZEN' : kind === 'epoch' ? 'STALE_EPOCH' : 'INVALID_LEASE' });
  assert.equal(w.snapshot(), before);
  if (kind === 'frozen') { w.at += 60001; await w.host.cycle.run(); assert.equal(w.store.read(a.attemptId).lease, 'unknown'); }
  await w.host.stop();
  assert.throws(() => port.heartbeat(a.attemptId, a.fence, w.host.status().epoch, w.at), { code: 'WRITE_REVOKED' });
 } finally { await w.close(); }
});

test('host timer renews only the exact routed execution and stop removes all timers', async () => {
 const callbacks = new Map(); let at = Date.now();
 const timers = { setInterval(fn, ms) { const h = { unref() {} }; callbacks.set(h, { fn, ms }); return h; },
   setTimeout(fn, ms) { const h = { unref() {} }; callbacks.set(h, { fn, ms }); return h; },
   clearInterval(h) { callbacks.delete(h); }, clearTimeout(h) { callbacks.delete(h); } };
 const clock = createClock({ now: () => at, timers }); const router = new SessionRouter();
 const w = await real({ clock, router, ownerSessionId: 'session:owner' });
 try {
  for (const m of ['a', 'b']) { w.core.member('member:' + m, 'worker'); w.core.task('task:' + m, 'member:' + m); }
  const a = w.core.schedule('a', 'task:a', at).result, b = w.core.schedule('b', 'task:b', at).result;
  const epoch = w.host.status().epoch;
  router.bindExecution({ executionSessionId: 'session:a', teamId: 'team:b', memberId: 'member:a', generation: 1, attemptId: a.attemptId, fence: a.fence,
    epoch });
  router.bindExecution({ executionSessionId: 'session:b', teamId: 'team:b', memberId: 'member:b', generation: 1, attemptId: b.attemptId, fence: b.fence + 1,
    epoch });
  const expiry = w.store.read(b.attemptId).expiresAt;
  at += 20000;
  const heartbeat = [...callbacks.values()].find(c => c.ms === 20000);
  heartbeat.fn();
  assert.equal(w.store.read(a.attemptId).expiresAt, at + 60000);
  assert.equal(w.store.read(b.attemptId).expiresAt, expiry);
  router.unbindExecution('session:a'); at += 20000;
  const before = w.snapshot(); heartbeat.fn(); assert.equal(w.snapshot(), before);
  await w.host.stop(); assert.equal(callbacks.size, 0);
  heartbeat.fn(); // A queued timer callback must be harmless after stop.
  assert.equal(w.snapshot(), before);
 } finally { await w.close(); }
});

test('review 2 #5: the timer renews a work attempt and never a mailbox-only wake, even across periods', async () => {
 const callbacks = new Map(); let at = Date.now();
 const timers = { setInterval(fn, ms) { const h = { unref() {} }; callbacks.set(h, { fn, ms }); return h; },
   setTimeout(fn, ms) { const h = { unref() {} }; callbacks.set(h, { fn, ms }); return h; },
   clearInterval(h) { callbacks.delete(h); }, clearTimeout(h) { callbacks.delete(h); } };
 const clock = createClock({ now: () => at, timers }); const router = new SessionRouter();
 const w = await real({ clock, router, ownerSessionId: 'session:owner' });
 try {
  for (const m of ['a', 'b']) w.core.member('member:' + m, 'worker');
  w.core.task('task:a', 'member:a');
  // The production shape of a wake: a mailbox task, created by the same call the runtime uses.
  w.core.task('task:mail', 'member:b', [], { mailboxOnly: true });
  const work = w.core.schedule('a', 'task:a', at).result, wake = w.core.schedule('mail', 'task:mail', at).result;
  const epoch = w.host.status().epoch;
  router.bindExecution({ executionSessionId: 'session:a', teamId: 'team:b', memberId: 'member:a', generation: 1, attemptId: work.attemptId, fence: work.fence,
    epoch });
  router.bindExecution({ executionSessionId: 'session:b', teamId: 'team:b', memberId: 'member:b', generation: 1, attemptId: wake.attemptId, fence: wake.fence,
    epoch });
  const mailbox = w.store.read(wake.attemptId);
  const heartbeat = [...callbacks.values()].find(c => c.ms === 20000);
  for (const period of [1, 2]) {
   at += 20000;
   heartbeat.fn();
   assert.equal(w.store.read(work.attemptId).expiresAt, at + 60000, 'a work attempt is renewed');
   // Ruling A: the wake lives for one turn and is never renewed, so a turn that hangs cannot hold the lease forever.
   assert.deepEqual(w.store.read(wake.attemptId), mailbox, 'the mailbox wake is not renewed in period ' + period);
  }
 } finally { await w.close(); }
});

