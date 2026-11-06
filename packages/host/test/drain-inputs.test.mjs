import test from 'node:test';
import assert from 'node:assert/strict';
import { real } from '../test-support/real.mjs';
import { createEffectRunner } from '../index.mjs';
function lifecycleConsumer(w) {
 const runner = createEffectRunner({ access: w.host.coreAccess, clock: w.host.clock,
  ports: { dispose: async request => ({ executed: true, receipt: await w.core.ports.dispose(request) }) } });
 let running = null;
 return { cycle() { if (running) return running; running = (async () => {
  w.host.coreAccess.lifecycle().prepareLifecycle(); runner.pump(); await runner.whenIdle();
 })().finally(() => { running = null; }); return running; }, stop() { runner.stop(); } };
}
test('drain schedules multi-recipient intent exactly once per member and keeps unknown occupancy', async () => {
 const w = await real(); try {
  for (const m of ['s', 'a', 'b']) w.core.member('member:' + m, m === 's' ? 'root' : 'worker');
  w.core.mutate('task:plan', 'scheduler', {}, tx => tx.put('task:plan', { status: 'draft', owner: 'member:s', contractRevision: 1 }));
  w.core.send('member:s', ['member:a', 'member:b'], 'intent', 'plan', { taskRef: 'task:plan', contractRevision: 1 });
  await w.host.cycle.run();
  assert.equal(w.store.list('attempt:').length, 2);
  assert.equal(w.store.list('task:mail-').length, 2);
  for (let i = 0; i < 20; i++) await w.host.cycle.run();
  assert.equal(w.store.list('attempt:').length, 2);
  w.at += 60001; await w.host.cycle.run();
  assert.ok(w.store.list('attempt:').every(a => a.lease === 'unknown'));
  await w.host.cycle.run(); assert.equal(w.store.list('attempt:').length, 2);
 } finally { await w.close(); }
});
test('B cycle and retained lifecycle driver never duplicate member-intent IO', async () => {
 const w = await real(); let stops = 0; let driver;
 try {
  w.core.member('member:w', 'worker');
  w.core.ports.dispose = async () => { stops++; return { stopped: true }; };
  w.core.mutate('member-intent:i', 'scheduler', {}, tx => tx.put('member-intent:i', { op: 'retire', memberRef: 'member:w', status: 'intent' }));
  driver = lifecycleConsumer(w);
  await Promise.all([driver.cycle(), w.host.cycle.run()]);
  for (let i = 0; i < 5; i++) { await driver.cycle(); await w.host.cycle.run(); }
  assert.equal(stops, 1); assert.equal(w.store.read('member-intent:i').status, 'confirmed');
 } finally { driver?.stop(); await w.close(); }
});

test('a finished mailbox attempt does not readmit the same still-open intent', async () => {
 const w = await real(); try {
  w.core.member('member:s', 'root'); w.core.member('member:a', 'worker');
  w.core.mutate('task:plan', 'scheduler', {}, tx => tx.put('task:plan', { status: 'draft', owner: 'member:s', contractRevision: 1 }));
  w.core.send('member:s', ['member:a'], 'intent', 'plan', { taskRef: 'task:plan', contractRevision: 1 });
  await w.host.cycle.run(); const a = w.store.list('attempt:')[0];
  w.core.finish(a.entityId, a.fence, 'cancelled');
  await w.host.cycle.run(); const before = w.snapshot();
  for (let i = 0; i < 20; i++) await w.host.cycle.run();
  assert.equal(w.store.list('attempt:').length, 1); assert.equal(w.snapshot(), before);
 } finally { await w.close(); }
});

test('legacy lifecycle IO cannot hold up the new clock/admission cycle', async () => {
 const w = await real(); let driver; let release; let stopped = 0;
 const io = new Promise(resolve => { release = resolve; });
 let legacy;
 try {
  w.core.member('member:w', 'worker');
  w.core.ports.dispose = async () => { stopped++; return io; };
  w.core.mutate('member-intent:hung', 'scheduler', {}, tx => tx.put('member-intent:hung', { op: 'retire', memberRef: 'member:w', status: 'intent' }));
  driver = lifecycleConsumer(w); legacy = driver.cycle();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, 1);
  const round = w.host.cycle.run();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(w.host.cycle.status().running, false); assert.equal(w.host.cycle.status().rounds, 1);
  assert.equal(w.store.read('member-intent:hung').status, 'applying');
  await round;
  release({ stopped: true }); await legacy;
  assert.equal(w.store.read('member-intent:hung').status, 'confirmed'); assert.equal(stopped, 1);
 } finally { release({ stopped: true }); await legacy; driver?.stop(); await w.close(); }
});
