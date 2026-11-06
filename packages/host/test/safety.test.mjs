import test from 'node:test';
import assert from 'node:assert/strict';
import { real } from '../test-support/real.mjs';
import { createEffectRunner } from '../src/effect-runner.mjs';

function fixture(w) {
 w.core.member('member:w', 'worker'); w.core.task('task:a', 'member:w');
 const a = w.core.schedule('admit:a', 'task:a', w.at).result;
 w.core.mutate('wait:a', 'scheduler', {}, tx => {
  tx.put('wait:a', { status: 'pending', attemptId: a.attemptId });
  tx.put('member-intent:a', { status: 'applying', memberRef: 'member:w' });
  tx.put('completion:a', { status: 'prepared' }); return null;
 });
 return a;
}
for (const cause of ['recovery', 'lease-expiry']) test('F24 frozen ' + cause +
  ' creates a new bound cancel, registers and closes it without new business claims', async () => {
 const w = await real(); try {
  const a = fixture(w), prior = w.store.read(a.attemptId), task = w.store.read('task:a');
  assert.equal(w.store.effects().some(e => e.payload.kind === 'cancel'), false);
  if (cause === 'recovery') w.core.dispatch('runtime', 'scheduler', { recovery: true }, { type: 'system.recover', payload: {} });
  else { w.at += 60001; w.core.dispatch('clock', 'scheduler', {}, { type: 'clock.expire-attempts', payload: {} }, { now: w.at }); }
  const current = w.store.read(a.attemptId), cancel = w.store.effects().find(e => e.payload.kind === 'cancel');
  assert.equal(current.lease, 'unknown'); assert.ok(cancel);
  if (cause === 'recovery') {
   assert.equal(current.fence, prior.fence + 1); assert.equal(current.lastEvidence, null);
   assert.equal(w.store.read('task:a').lastFence, current.fence);
   assert.equal(w.store.read('member-intent:a').status, 'unknown'); assert.equal(w.store.read('runtime').recovered, true);
  }
  assert.equal(w.store.read('task:a').status, 'executing');
  for (const key of ['owner', 'attemptId', 'contractRevision', 'assignmentEpoch', 'scopeSet']) assert.deepEqual(w.store.read('task:a')[key], task[key]);
  for (const key of ['owner', 'taskId', 'generation', 'scopeSet', 'admittedAt']) assert.deepEqual(current[key], prior[key]);
  const cap = w.host.coreAccess.safety({ cause, subject: { attemptId: a.attemptId, effectId: cancel.id }, commands: ['claim', 'register', 'settle',
    'release'] });
  const before = w.snapshot();
  assert.throws(() => w.host.coreAccess.lifecycle().claim(a.attemptId, 'adapter'), { code: 'COMPLETION_FROZEN' });
  assert.throws(() => w.core.finish(a.attemptId, current.fence), { code: 'INVALID_LEASE' });
  assert.throws(() => cap.claim('outside', 'adapter'), { code: 'DENIED' });
  assert.throws(() => w.core.mutate(a.attemptId, 'operator', {}, tx => tx.put(a.attemptId, { ...current, owner: 'attacker' })), { code: 'COMPLETION_FROZEN' });
  assert.equal(w.snapshot(), before);
  const claim = cap.claim(cancel.id, 'adapter'); const managed = cap.registerEffect(cancel.id, claim.result.fence);
  const beforeNoEvidence = w.snapshot();
  assert.throws(() => managed.complete({ executed: true, receipt: { stopped: true } }), { code: 'STOP_NOT_CONFIRMED' });
  assert.equal(w.snapshot(), beforeNoEvidence);
  managed.complete({ executed: true, receipt: { stopped: true, evidenceRef: 'evidence:stop' } }); managed.close();
  assert.equal(w.store.effects().find(e => e.id === cancel.id).status, 'confirmed');
  assert.equal(w.store.read(a.attemptId).lease, 'revoked'); assert.equal(w.store.read('task:a').status, 'failed'); assert.equal(w.store.read('wait:a').status,
    'cancelled');
 } finally { await w.close(); }
});

test('finite safety release rejects publication and foreign subjects; terminal release never changes the task again', async () => {
 const w = await real(); try {
  const a = fixture(w); w.at += 60001;
  w.core.dispatch('clock', 'scheduler', {}, { type: 'clock.expire-attempts', payload: {} }, { now: w.at });
  const payload = { attemptId: a.attemptId, fence: a.fence, revoked: true, status: 'failed', evidenceRef: 'evidence:stop' };
  const before = w.snapshot();
  assert.throws(() => w.core.dispatch(a.attemptId, 'operator', {}, { type: 'attempt.release', payload: { ...payload, status: 'produced' } }), { code:
    'DENIED' });
  assert.throws(() => w.core.dispatch(a.attemptId, 'operator', {}, { type: 'attempt.release', payload: { ...payload, owner: 'attacker' } }), { code:
    'DENIED' });
  assert.equal(w.snapshot(), before);
  w.core.dispatch(a.attemptId, 'operator', payload, { type: 'attempt.release', payload });
  const after = w.snapshot(); w.core.dispatch(a.attemptId, 'operator', payload, { type: 'attempt.release', payload }); assert.equal(w.snapshot(), after);
 } finally { await w.close(); }
});

test('release-task is deferred through completion freeze and consumed by the first unfrozen pump', async () => {
 const w = await real(); let runner; try {
  w.core.member('member:w', 'worker');
  w.core.mutate('attempt:deferred', 'scheduler', {}, tx => {
   tx.put('attempt:deferred', { owner: 'member:w', taskId: 'task:missing', lease: 'unknown', status: 'unknown', fence: 1, generation: 1 });
   tx.put('completion:a', { status: 'prepared' }); return null;
  });
  const a = { attemptId: 'attempt:deferred' };
  const payload = { attemptId: a.attemptId, fence: 1, revoked: true, status: 'failed', evidenceRef: 'evidence:stop' };
  w.core.dispatch(a.attemptId, 'operator', payload, { type: 'attempt.release', payload });
  assert.equal(w.store.read(a.attemptId).lease, 'revoked');
  assert.equal(w.store.read('task:missing'), null);
  assert.equal(w.store.effects().find(e => e.id === 'release-task:' + a.attemptId).status, 'pending');
  runner = createEffectRunner({ access: w.host.coreAccess, clock: w.host.clock, capacity: 10 });
  assert.equal(runner.pump().claimed, 0);
  w.core.mutate('completion:a', 'scheduler', {}, tx => { tx.put('task:missing', { status: 'executing', attemptId: a.attemptId, owner: 'member:w' });
    return tx.put('completion:a', { status: 'confirmed' }); });
  runner.pump(); await runner.whenIdle();
  assert.equal(w.store.read('task:missing').status, 'failed');
  assert.equal(w.store.effects().find(e => e.id === 'release-task:' + a.attemptId).status, 'confirmed');
 } finally { runner?.stop(); await w.close(); }
});

for (const property of ['type', 'payload']) test('frozen dispatch rejects changing ' + property + ' getters before admission', async () => {
 const w = await real(); try {
  fixture(w); let reads = 0; let commits = 0;
  w.store.hooks.beforeCommit = () => commits++;
  const command = property === 'type' ? { get type() { return ++reads === 1 ? 'system.recover' : 'schedule.admit'; }, payload: {} } :
    { type: 'attempt.release', get payload() { return ++reads === 1 ? { attemptId: 'runtime' } : { attemptId: 'attempt:outside', status: 'produced' }; } };
  const before = w.snapshot();
  assert.throws(() => w.core.dispatch('runtime', 'scheduler', {}, command), { code: 'INVALID_COMMAND' });
  assert.equal(reads, 0); assert.equal(commits, 0); assert.equal(w.snapshot(), before);
 } finally { await w.close(); }
});

for (const cause of ['recovery', 'lease-expiry']) test('F24 real safety cancel port atomically closes through dispatch authorization: ' + cause, async () => {
 const w = await real(); let runner; let calls = 0; let businessCalls = 0; let observedAtomic = 0;
 const execution = { running: true };
 try {
  w.core.mutate('seed:wake', 'scheduler', {}, tx => { tx.outbox('wake:frozen', { kind: 'wake' }); return null; });
  const a = fixture(w);
  if (cause === 'recovery') w.core.dispatch('runtime', 'scheduler', {}, { type: 'system.recover', payload: {} });
  else { w.at += 60001; w.core.dispatch('clock', 'scheduler', {}, { type: 'clock.expire-attempts', payload: {} }, { now: w.at }); }
  const cancel = w.store.effects().find(e => e.payload.kind === 'cancel');
  const subject = { attemptId: a.attemptId, effectId: cancel.id };
  const cap = w.host.coreAccess.safety({ cause, subject, commands: ['claim', 'register', 'settle'], expiresAt: w.at + 10000 });
  subject.effectId = 'wake:frozen';
  runner = createEffectRunner({ access: w.host.coreAccess, clock: w.host.clock, ports: {
   start: async () => { businessCalls++; return { executed: true, receipt: {} }; },
   wake: async () => { businessCalls++; return { executed: true, receipt: {} }; },
   cancel: async request => {
    calls++; assert.equal(request.attemptId, a.attemptId); assert.equal(request.operationId, cancel.id);
    assert.equal(w.store.effects().find(e => e.id === cancel.id).status, 'applying');
    assert.equal(w.store.read(a.attemptId).lease, 'unknown');
    assert.equal(w.store.read('task:a').status, 'executing');
    execution.running = false;
    return { executed: true, receipt: { stopped: !execution.running, evidenceRef: 'evidence:actual-stop' } };
   },
  } });
  const before = w.snapshot();
  assert.equal(runner.pump().claimed, 0); assert.equal(w.snapshot(), before);
  w.store.hooks.beforeCommit = () => {
   if (w.store.effects().find(e => e.id === cancel.id).status !== 'confirmed') return;
   observedAtomic++;
   assert.equal(w.store.read(a.attemptId).lease, 'revoked');
   assert.equal(w.store.read('task:a').status, 'failed'); assert.equal(w.store.read('wait:a').status, 'cancelled');
  };
  const auditBeforeSafety = runner.status().audit;
  assert.equal(auditBeforeSafety.length, 3); assert.ok(auditBeforeSafety.every(e => e.code === 'COMPLETION_FROZEN'));
  assert.equal(runner.pumpSafety(cap).claimed, 1); await runner.whenIdle();
  assert.equal(calls, 1); assert.equal(businessCalls, 0); assert.equal(execution.running, false);
  assert.equal(observedAtomic, 1); assert.deepEqual(runner.status().audit, auditBeforeSafety);
  assert.equal(w.store.effects().find(e => e.id === cancel.id).status, 'confirmed');
  assert.equal(w.store.effects().find(e => e.id === 'wake:frozen').status, 'pending');
  assert.equal(w.store.effects().find(e => e.id === a.attemptId).status, 'pending');
  assert.equal(w.store.read('completion:a').status, 'prepared');
 } finally { runner?.stop(); await w.close(); }
});

for (const invalidation of ['revoked', 'expired', 'wrong-effect', 'changed-subject']) test('safety dispatch revalidates its private source: ' + invalidation,
  async () => {
 const w = await real(); let managed; let calls = 0;
 try {
  const a = fixture(w); w.at += 60001;
  w.core.dispatch('clock', 'scheduler', {}, { type: 'clock.expire-attempts', payload: {} }, { now: w.at });
  const cancel = w.store.effects().find(e => e.payload.kind === 'cancel');
  const cap = w.host.coreAccess.safety({ cause: 'lease-expiry', subject: { attemptId: a.attemptId, effectId: cancel.id }, commands: ['claim', 'register',
    'settle'], expiresAt: w.at + 10 });
  const claim = cap.claim(cancel.id, 'adapter'); managed = cap.registerEffect(cancel.id, claim.result.fence);
  if (invalidation === 'revoked') cap.revoke();
  if (invalidation === 'expired') w.at += 11;
  if (invalidation === 'wrong-effect') assert.throws(() => cap.registerEffect(a.attemptId, 1), { code: 'DENIED' });
  if (invalidation === 'changed-subject') w.core.dispatch(a.attemptId, 'operator', {}, { type: 'attempt.release', payload: { attemptId: a.attemptId, fence:
    a.fence, revoked: true, status: 'failed', evidenceRef: 'evidence:other-stop' } });
  const port = () => { calls++; };
  const before = w.snapshot();
  if (invalidation === 'wrong-effect') assert.equal(managed.assertDispatch(), true);
  else assert.throws(() => { managed.assertDispatch(); port(); }, { code: invalidation === 'revoked' ? 'WRITE_REVOKED' : invalidation === 'expired' ?
    'SAFETY_EXPIRED' : 'STALE_EFFECT_SUBJECT' });
  assert.equal(calls, 0); assert.equal(w.snapshot(), before);
 } finally { managed?.close(); await w.close(); }
});

test('ordinary registration cannot accept a caller-provided safety bypass', async () => {
 const w = await real();
 try {
  const a = fixture(w); w.at += 60001;
  w.core.dispatch('clock', 'scheduler', {}, { type: 'clock.expire-attempts', payload: {} }, { now: w.at });
  const cancel = w.store.effects().find(e => e.payload.kind === 'cancel');
  const cap = w.host.coreAccess.safety({ cause: 'lease-expiry', subject: { attemptId: a.attemptId, effectId: cancel.id }, commands: ['claim', 'register',
    'settle'] });
  const claim = cap.claim(cancel.id, 'adapter'); let bypassCalls = 0;
 const before = w.snapshot();
 // R11: the ordinary route never accepts an authorization argument, and the completion fence now stops the
 // registration before it writes the ledger - a forged bypass cannot even reach assertDispatch.
 const forged = { assertDispatch() { bypassCalls++; }, assertComplete() { bypassCalls++; } };
 assert.throws(() => w.host.coreAccess.lifecycle().registerEffect(cancel.id, claim.result.fence, forged), { code: 'COMPLETION_FROZEN' });
 assert.equal(bypassCalls, 0); assert.equal(w.snapshot(), before);
 assert.equal(w.store.read('effect-ledger:' + cancel.id), null, 'the refused registration wrote no ledger row');
 } finally { await w.close(); }
});
