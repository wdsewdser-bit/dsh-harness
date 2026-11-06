import test from 'node:test';
import assert from 'node:assert/strict';
import { real } from '../test-support/real.mjs';
import { createEffectRunner } from '../src/effect-runner.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
import { createTeamHost } from '../index.mjs';
const seed = (w, id, payload = { kind: 'wake' }) => w.core.mutate('seed:' + id, 'scheduler', {}, tx => { tx.outbox(id, payload); return null; });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('runner is inactive until explicitly pumped; a claim has a durable restricted registration before IO', async () => {
 const w = await real(); let runner; let calls = 0;
 try {
  seed(w, 'wake:a');
  runner = createEffectRunner({ access: w.host.coreAccess, clock: w.host.clock, ports: { wake: payload => {
   calls++; assert.equal(payload.operationId, 'wake:a'); assert.equal(payload.core, undefined);
   assert.equal(w.store.effects()[0].status, 'applying');
   const ledger = w.store.read('effect-ledger:wake:a'); assert.equal(ledger.fence, 1); assert.equal(ledger.epoch, w.host.status().epoch);
   return { executed: true, receipt: { accepted: true } };
  } } });
  assert.equal(calls, 0); assert.equal(w.store.effects()[0].status, 'pending');
  assert.equal(runner.pump().claimed, 1); await runner.whenIdle();
  assert.equal(w.store.effects()[0].status, 'confirmed'); assert.equal(calls, 1);
  assert.equal(runner.pump().claimed, 0);
 } finally { runner?.stop(); await w.close(); }
});

test('F4/F21 competing pumps dispatch once and a stale generation never commits a domain transition', async () => {
 const w = await real(); const io = deferred(); let a, b; let calls = 0;
 try {
  w.core.member('member:w', 'worker');
  seed(w, 'native:a', { kind: 'dispose', memberId: 'member:w', generation: 1 });
  const options = { access: w.host.coreAccess, clock: w.host.clock, ports: { dispose: () => { calls++; return io.promise; } } };
  a = createEffectRunner(options); b = createEffectRunner(options);
  assert.equal(a.pump().claimed, 1); assert.equal(b.pump().claimed, 0);
  await new Promise(resolve => setImmediate(resolve));
  w.core.mutate('member:w', 'scheduler', {}, tx => tx.put('member:w', { ...tx.read('member:w'), generation: 2 }));
  const before = w.snapshot(); io.resolve({ executed: true, receipt: { stopped: true } }); await a.whenIdle();
  assert.equal(w.snapshot(), before); assert.equal(calls, 1);
  assert.equal(a.status().audit[0].code, 'STALE_EFFECT_SUBJECT');
 } finally { io.resolve({ unknown: true }); a?.stop(); b?.stop(); await w.close(); }
});

test('F20 hung IO consumes bounded capacity but does not hold the scheduling cycle', async () => {
 const w = await real(); const io = deferred(); let runner;
 try {
  seed(w, 'wake:a'); seed(w, 'wake:b');
  runner = createEffectRunner({ access: w.host.coreAccess, clock: w.host.clock, capacity: 1, ports: { wake: () => io.promise } });
  assert.equal(runner.pump().claimed, 1); assert.equal(runner.pump().skipped, 1);
  await w.host.cycle.run(); assert.equal(w.host.cycle.status().rounds, 1);
  assert.equal(w.store.effects().filter(e => e.status === 'pending').length, 1);
  io.resolve({ executed: true, receipt: {} }); await runner.whenIdle();
  assert.equal(runner.pump().claimed, 1); await runner.whenIdle();
  assert.ok(w.store.effects().every(e => e.status === 'confirmed'));
 } finally { io.resolve({ unknown: true }); runner?.stop(); await w.close(); }
});

test('effect timeout is unknown and a late successful IO result never overwrites it', async () => {
 const w = await real(); const io = deferred(); let runner;
 try {
  seed(w, 'wake:a'); runner = createEffectRunner({ access: w.host.coreAccess, clock: w.host.clock, timeoutMs: 5, ports: { wake: () => io.promise } });
  runner.pump();
  await new Promise(resolve => setTimeout(resolve, 20)); await runner.whenIdle();
  assert.equal(w.store.effects()[0].status, 'unknown'); const before = w.snapshot();
  io.resolve({ executed: true, receipt: {} }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(w.snapshot(), before);
 } finally { io.resolve({ unknown: true }); runner?.stop(); await w.close(); }
});

test('F10 host stop admits an existing runner receipt within budget and forbids a new claim', async () => {
 const w = await real(); const io = deferred(); let runner;
 try {
  seed(w, 'wake:a'); seed(w, 'wake:b');
  runner = createEffectRunner({ access: w.host.coreAccess, clock: w.host.clock, capacity: 1, ports: { wake: () => io.promise } });
  runner.pump(); await new Promise(resolve => setImmediate(resolve));
  const stopping = w.host.stop({ timeoutMs: 1000 });
  assert.equal(runner.pump().claimed, 0);
  io.resolve({ executed: true, receipt: {} }); await runner.whenIdle(); await stopping;
  assert.equal(w.store.effects()[0].status, 'confirmed'); assert.equal(w.store.effects()[1].status, 'pending');
 } finally { io.resolve({ unknown: true }); runner?.stop(); await w.close(); }
});

test('stop isolation prevents a late port result from committing against a released host', async () => {
 const w = await real(); const io = deferred(); let runner;
 try {
  seed(w, 'wake:a'); runner = createEffectRunner({ access: w.host.coreAccess, clock: w.host.clock, ports: { wake: () => io.promise } });
  runner.pump(); await new Promise(resolve => setImmediate(resolve)); await w.host.stop({ timeoutMs: 0 });
  const before = w.snapshot(); io.resolve({ executed: true, receipt: {} }); await runner.whenIdle();
  assert.equal(w.snapshot(), before); assert.equal(runner.status().audit[0].code, 'WRITE_REVOKED');
 } catch(error){w.recordError(error);throw error;} finally { io.resolve({ unknown: true }); runner?.stop(); const cleanup=await w.close({expectIsolated:true});
   assert.equal(cleanup.removed,false);assert.equal(cleanup.expectedIsolation,true); }
});

test('F24 ordinary runner cannot claim start or wake through a completion fence', async () => {
 const w = await real(); let runner;
 try {
  seed(w, 'start:a', { kind: 'start', attemptId: 'attempt:a', fence: 1, generation: 1 });
  seed(w, 'wake:a'); w.core.mutate('completion:a', 'scheduler', {}, tx => tx.put('completion:a', { status: 'prepared' }));
  runner = createEffectRunner({ access: w.host.coreAccess, clock: w.host.clock });
  const before = w.snapshot(); assert.equal(runner.pump().claimed, 0); assert.equal(w.snapshot(), before);
  assert.ok(runner.status().audit.every(a => a.code === 'COMPLETION_FROZEN'));
 } finally { runner?.stop(); await w.close(); }
});

test('inactive lifecycle dispatcher only emits work; the runner commits lifecycle facts and effect atomically', async () => {
 const w = await real(); let runner; let calls = 0;
 try {
  w.core.member('member:w', 'worker'); w.core.mutate('member-intent:a', 'scheduler', {}, tx => tx.put('member-intent:a', { memberRef: 'member:w', op:
    'retire', status: 'intent' }));
  assert.equal(w.host.coreAccess.lifecycle().prepareLifecycle().dispatched, 1);
  assert.equal(w.host.coreAccess.lifecycle().prepareLifecycle().dispatched, 0);
  runner = createEffectRunner({ access: w.host.coreAccess, clock: w.host.clock, ports: { dispose: () => { calls++; return { executed: true, receipt: {
    stopped: true } }; } } });
  assert.equal(calls, 0); runner.pump(); await runner.whenIdle();
  assert.equal(w.store.read('member:w').status, 'retired'); assert.equal(w.store.read('member-intent:a').status, 'confirmed');
  assert.equal(w.store.effects()[0].status, 'confirmed'); assert.equal(calls, 1);
 } finally { runner?.stop(); await w.close(); }
});

test('F3 registered claim survives host reconstruction as unknown; old epoch receipt cannot write', async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runner-restart-'));
 let store, host;
 try {
  store = new ControlStore(root); let core = new TeamCore(store, {}, { enabled: true, attach: true });
  host = createTeamHost({ root, teamId: 'team:restart', core, recoverer: async () => ({ status: 'ok', admission: true }), openStore: () => ({ close() {} }) });
  await host.start(); core.mutate('seed', 'scheduler', {}, tx => { tx.outbox('wake:a', { kind: 'wake' }); return null; });
  host.coreAccess.lifecycle().claim('wake:a', 'adapter');
  const receipt = host.coreAccess.lifecycle().registerEffect('wake:a', 1);
  const epoch = host.status().epoch; receipt.close(); await host.stop({ timeoutMs: 1000 }); store.close();
  store = new ControlStore(root); core = new TeamCore(store, {}, { enabled: true });
  host = createTeamHost({ root, teamId: 'team:restart', core, recoverer: async () => ({ status: 'ok', admission: true }), openStore: () => ({ close() {} }) });
  await host.start(); assert.ok(host.status().epoch > epoch); assert.equal(store.effects()[0].status, 'unknown');
  const before = JSON.stringify({ rows: store.list(), effects: store.effects(), events: store.events() });
  assert.throws(() => receipt.complete({ executed: true, receipt: {} }), { code: 'WRITE_REVOKED' });
  assert.equal(JSON.stringify({ rows: store.list(), effects: store.effects(), events: store.events() }), before);
 } finally { await host?.stop(); store?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('F6 unknown lease reserves capacity until explicit operator stop evidence releases it', async () => {
 const w = await real(); let runner;
 try {
  w.core.member('member:w', 'worker'); w.core.task('task:a', 'member:w');
  const a = w.core.schedule('admit:a', 'task:a', w.at).result;
  w.at += 60001; await w.host.cycle.run();
  w.core.task('task:b', 'member:w'); assert.throws(() => w.core.schedule('admit:b', 'task:b', w.at), { code: 'CAPACITY' });
  // Pump only the cancellation effect; stale starts are intentionally not dispatched by this fixture.
  const claim = w.host.coreAccess.lifecycle().claim('cancel:' + a.attemptId, 'adapter');
  const managed = w.host.coreAccess.lifecycle().registerEffect('cancel:' + a.attemptId, claim.result.fence);
  const before = w.snapshot();
  assert.throws(() => managed.complete({ executed: true, receipt: { stopped: true } }), { code: 'STOP_NOT_CONFIRMED' });
  assert.equal(w.snapshot(), before);
  managed.complete({ executed: true, receipt: { stopped: true, evidenceRef: 'evidence:stop' } }); managed.close();
  assert.equal(w.store.read(a.attemptId).lease, 'revoked'); assert.equal(w.store.read('task:a').status, 'failed');
  assert.equal(w.core.schedule('admit:b2', 'task:b', w.at).status, 'confirmed');
 } finally { runner?.stop(); await w.close(); }
});

test('F7 claim retry limit becomes dead-letter on the fifth proven not-executed receipt', async () => {
 const w = await real(); let runner;
 try {
  seed(w, 'wake:a'); runner = createEffectRunner({ access: w.host.coreAccess, clock: w.host.clock, ports: { wake: () => ({ notExecuted: true }) } });
  for (let i = 1; i <= 5; i++) {
   assert.equal(runner.pump().claimed, 1); await runner.whenIdle();
   const e = w.store.effects()[0]; assert.equal(e.tries, i); assert.equal(e.status, i === 5 ? 'dead-letter' : 'retryable');
   w.at = Date.now() + 10000 + i;
  }
  assert.equal(runner.pump().claimed, 0);
 } finally { runner?.stop(); await w.close(); }
});

test('lifecycle timeout revokes the revision binding; its late native receipt is audit-only', async () => {
 const w = await real(); const io = deferred(); let runner;
 try {
  w.core.member('member:w', 'worker'); w.core.mutate('member-intent:a', 'scheduler', {}, tx => tx.put('member-intent:a', { memberRef: 'member:w', op:
    'retire', status: 'intent' }));
  w.host.coreAccess.lifecycle().prepareLifecycle();
  runner = createEffectRunner({ access: w.host.coreAccess, clock: w.host.clock, ports: { dispose: () => io.promise } });
  runner.pump(); await new Promise(resolve => setImmediate(resolve));
  w.at = w.store.read('member-intent:a').createdAt + w.core.configuration.lifecycleIntentTimeoutMs + 1; await w.host.cycle.run();
  assert.equal(w.store.read('member-intent:a').status, 'unknown'); const before = w.snapshot();
  io.resolve({ executed: true, receipt: { stopped: true } }); await runner.whenIdle();
  assert.equal(w.snapshot(), before); assert.ok(runner.status().audit.some(e => e.code === 'STALE_FENCE' || e.code === 'STALE_EFFECT_SUBJECT'));
 } finally { io.resolve({ unknown: true }); runner?.stop(); await w.close(); }
});

test('runner stop drains its own ledger without waiting for a permanently hung port', async () => {
 const w = await real(); const io = deferred(); let runner;
 try {
  seed(w, 'wake:a'); runner = createEffectRunner({ access: w.host.coreAccess, clock: w.host.clock, ports: { wake: () => io.promise } });
  runner.pump(); await new Promise(resolve => setImmediate(resolve));
  runner.stop(); await runner.whenIdle();
  assert.equal(runner.status().pending, 0); assert.equal(w.store.effects()[0].status, 'unknown');
  const before = w.snapshot(); io.resolve({ executed: true, receipt: {} }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(w.snapshot(), before);
 } finally { io.resolve({ unknown: true }); runner?.stop(); await w.close(); }
});

test('capacity counts actual IO after repeated logical timeouts', async () => {
 const w = await real(); const io = deferred(); let runner; let calls = 0;
 try {
  for (let i = 0; i < 6; i++) seed(w, 'wake:capacity-' + i);
  runner = createEffectRunner({ access: w.host.coreAccess, clock: w.host.clock, capacity: 1, timeoutMs: 5, ports: { wake: () => { calls++; return io.promise;
    } } });
  assert.equal(runner.pump().claimed, 1);
  for (let i = 0; i < 5; i++) {
   await new Promise(resolve => setTimeout(resolve, 12)); await runner.whenIdle();
   assert.equal(runner.status().pending, 0); assert.equal(runner.status().activeIO, 1);
   assert.equal(runner.pump().claimed, 0); assert.equal(calls, 1);
  }
  assert.equal(w.store.effects().filter(e => e.status === 'unknown').length, 1);
  assert.equal(w.store.effects().filter(e => e.status === 'pending').length, 5);
  io.resolve({ executed: true, receipt: {} }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(runner.status().activeIO, 0);
  assert.equal(runner.pump().claimed, 1); await runner.whenIdle(); assert.equal(calls, 2);
 } finally { io.resolve({ unknown: true }); runner?.stop(); await w.close(); }
});

test('an expired pending start never calls its external port', async () => {
 const w = await real(); let runner; let calls = 0;
 try {
  w.core.member('member:w', 'worker'); w.core.task('task:expired', 'member:w');
  const a = w.core.schedule('expired:start', 'task:expired', w.at).result;
  w.at = w.store.read(a.attemptId).expiresAt;
  runner = createEffectRunner({ access: w.host.coreAccess, clock: w.host.clock, ports: { start: () => { calls++; return { executed: true, receipt: { prepared:
    true, executionSessionId: 'session:bad' } }; } } });
  runner.pump(); await runner.whenIdle();
  assert.equal(calls, 0); assert.equal(w.store.read(a.attemptId).status, 'admitted');
  // Review 2 #3 (N1): the refusal comes from the dispatch authorization, which runs BEFORE the port, so this effect
  // provably did not execute. It is classified as that (notExecuted -> retryable, and dead-letter after the bounded
  // retries) instead of "unknown", which claimed an execution nobody could account for when nothing was called.
  assert.equal(w.store.effects().find(e => e.id === a.attemptId).status, 'retryable');
 } finally { runner?.stop(); await w.close(); }
});

test('pump followed synchronously by host stop cannot begin IO in a later microtask', async () => {
 const w = await real(); let runner; let calls = 0;
 try {
  seed(w, 'wake:stop-boundary');
  runner = createEffectRunner({ access: w.host.coreAccess, clock: w.host.clock, ports: { wake: () => { calls++; return { executed: true, receipt: {} }; } } });
  assert.equal(runner.pump().claimed, 1);
  const stopping = w.host.stop({ timeoutMs: 1000 });
  await runner.whenIdle(); await stopping;
  assert.equal(calls, 0); assert.equal(runner.status().activeIO, 0);
  // Same rule one step earlier: the write revocation refused the dispatch check, so the port was never entered and the
  // effect did not run. "Not executed" is what the ledger records; the bounded retry is what a restart resumes.
  assert.equal(w.store.effects()[0].status, 'retryable');
 } finally { runner?.stop(); await w.close(); }
});
