import test from 'node:test';
import { profile, until } from '../test-support/profile.mjs';
import fs from 'node:fs';
import { ArtifactStore } from '../../context/index.mjs';
import assert from 'node:assert/strict';
import { real } from '../test-support/real.mjs';
import { createClock } from '../src/clock.mjs';
import { createEffectRunner } from '../src/effect-runner.mjs';
import { createGarbageCollector } from '../src/gc.mjs';

/**
 * The E package's gc suite: design §6 E ("gc 触发与失败观测"), host-protocol §7.2 rule 1.
 *
 * gc is a real effect kind: the trigger writes an outbox row, the runner claims it, the injected port does the work and
 * the settlement is the effect row. Failure observation therefore has two halves - an emit that the host refused, and
 * an effect that came back unknown or dead-lettered - and both are reported, never swallowed.
 */
test('gc is triggered by the host clock, travels as a gc effect and is settled by the runner', async () => {
  const w = await real(); let runner; try {
    const collector = createGarbageCollector({ access: w.host.coreAccess, clock: w.host.clock, intervalMs: 50 });
    const emitted = collector.trigger('operator');
    assert.equal(emitted.ok, true);
    const effect = w.store.effects().find(row => row.payload?.kind === 'gc');
    assert.equal(effect.id, emitted.effectId);
    assert.equal(effect.status, 'pending');
    let calls = 0;
    runner = createEffectRunner({ access: w.host.coreAccess, clock: w.host.clock,
      ports: { gc: async request => { calls++; assert.equal(request.operationId, effect.id); return { executed: true, receipt: { collected: 0 } }; } } });
    assert.equal(runner.pump().claimed, 1);
    await runner.whenIdle();
    assert.equal(calls, 1);
    assert.equal(w.store.effects().find(row => row.id === effect.id).status, 'confirmed');
    const status = collector.status();
    assert.equal(status.emitted, 1);
    assert.equal(status.effects.confirmed, 1);
    assert.deepEqual(status.failedEffects, []);
  } finally { runner?.stop(); await w.close(); }
});

test('a gc effect that comes back unknown is reported, not retried silently', async () => {
  const w = await real(); let runner; try {
    const collector = createGarbageCollector({ access: w.host.coreAccess, clock: w.host.clock, intervalMs: 50 });
    const emitted = collector.trigger('operator');
    runner = createEffectRunner({ access: w.host.coreAccess, clock: w.host.clock, timeoutMs: 5,
      ports: { gc: () => new Promise(() => {}) } });
    runner.pump();
    await new Promise(resolve => setTimeout(resolve, 25));
    await runner.whenIdle();
    assert.equal(w.store.effects().find(row => row.id === emitted.effectId).status, 'unknown');
    const status = collector.status();
    assert.equal(status.effects.unknown, 1);
    assert.deepEqual(status.failedEffects, [emitted.effectId]);
  } finally { runner?.stop(); await w.close(); }
});

test('a gc trigger the host refuses is counted with its code and writes no effect', async () => {
  const w = await real(); try {
    const failures = [];
    const collector = createGarbageCollector({ access: w.host.coreAccess, clock: w.host.clock, intervalMs: 50,
      onError: failure => failures.push(failure) });
    // The completion fence closes ordinary writes, and gc is an ordinary write: it must report, not pretend.
    w.core.mutate('completion:c', 'scheduler', {}, tx => tx.put('completion:c', { status: 'prepared' }));
    const refused = collector.trigger('operator');
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'COMPLETION_FROZEN');
    assert.equal(w.store.effects().some(row => row.payload?.kind === 'gc'), false);
    const status = collector.status();
    assert.equal(status.failed, 1);
    assert.equal(status.lastError.code, 'COMPLETION_FROZEN');
    assert.equal(failures.length, 1);
    assert.equal(status.observable, true);
  } finally { await w.close(); }
});

test('the gc interval is one host-clock timer, armed on demand and removed by stop', async () => {
  const callbacks = new Map();
  const at = Date.now();
  const timers = { setInterval(fn, ms) { const handle = { unref() {} }; callbacks.set(handle, { fn, ms }); return handle; },
    setTimeout(fn, ms) { const handle = { unref() {} }; callbacks.set(handle, { fn, ms }); return handle; },
    clearInterval(handle) { callbacks.delete(handle); }, clearTimeout(handle) { callbacks.delete(handle); } };
  const clock = createClock({ now: () => at, timers });
  const w = await real({ clock }); try {
    const collector = createGarbageCollector({ access: w.host.coreAccess, clock, intervalMs: 60000 });
    assert.equal(collector.status().armed, false);
    collector.arm();
    const armed = [...callbacks.values()].filter(entry => entry.ms === 60000);
    assert.equal(armed.length, 1, 'exactly one 60 s timer');
    assert.equal(collector.status().armed, true);
    armed[0].fn();
    assert.equal(w.store.effects().filter(row => row.payload?.kind === 'gc').length, 1);
    assert.equal(collector.status().triggered, 1);
    assert.equal(collector.stop(), true);
    assert.equal(collector.status().armed, false);
    collector.arm();
    await w.host.stop({ timeoutMs: 2000 });
    assert.equal(callbacks.size, 0, 'host stop removes every timer the clock armed');
  } finally { await w.close(); }
});
test('review 7: the failure report is bounded, exact in its count, and says when it is truncated', () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({ id: 'gc:failed:' + index, status: index % 2 ? 'dead-letter' : 'unknown', payload: { kind: 'gc' } }));
  const access = { lifecycle: () => ({ mutate() {}, effects: () => rows }) };
  const collector = createGarbageCollector({ access, intervalMs: 1000, now: () => 1, failedEffectsLimit: 2 });
  const status = collector.status();
  assert.deepEqual(status.failedEffects, ['gc:failed:0', 'gc:failed:1']);
  assert.equal(status.failedEffectCount, 5);
  assert.equal(status.failedEffectsTruncated, true);
  const whole = createGarbageCollector({ access, intervalMs: 1000, now: () => 1 });
  assert.equal(whole.status().failedEffectCount, 5);
  assert.equal(whole.status().failedEffectsTruncated, false, 'the default limit holds all five');
  assert.throws(() => createGarbageCollector({ access, intervalMs: 1000, failedEffectsLimit: -1 }), { code: 'INVALID_CONFIG' });
});

test('review 7: arming a stopped clock is a no-op, and any other arming failure still surfaces', () => {
  const access = { lifecycle: () => ({ mutate() {}, effects: () => [] }) };
  const stopped = { every() { throw Object.assign(Error('the clock was stopped; gc cannot be armed'), { code: 'CLOCK_STOPPED' }); } };
  const collector = createGarbageCollector({ access, clock: stopped, intervalMs: 1000, now: () => 1 });
  assert.equal(collector.arm(), null);
  assert.equal(collector.status().armed, false);
  const broken = { every() { throw new TypeError('the timer port is broken'); } };
  const other = createGarbageCollector({ access, clock: broken, intervalMs: 1000, now: () => 1 });
  assert.throws(() => other.arm(), /the timer port is broken/);
});

// Installing the gc timer in the production profile and reporting it from host.status() belongs to the consumer switch.
test('production profile gc timer runs the real artifact backend and reports failed effects', async () => {
 let content;
 const w = await profile({ gcIntervalMs: 15 }, ({root})=>{ const artifacts=new ArtifactStore(root); const item=artifacts.publish('call:expired',
   'expired content',{session:'s',agent:'a'});content=root+'/artifacts/'+item.sha256;artifacts.terminal(item.artifactRef,0);artifacts.close();assert.equal(
   fs.existsSync(content),true); });
 try {
  await until(() => w.runtime.status().gc.effects.confirmed > 0);
  assert.equal(w.runtime.status().gc.armed, true);
  assert.equal(fs.existsSync(content),false);
  assert.equal(w.runtime.status().gc.failedEffectCount, 0);
  assert(w.runtime.status().effects.activeIO === 0 || w.runtime.status().effects.occupants.every(row=>row.effectId.startsWith('gc:')));
 } finally { await w.close(); }
 const bad = await profile({ gcIntervalMs: 15, gc: async()=>{ throw Error('collector failed'); } });
 try { await until(()=>bad.runtime.status().gc.failedEffectCount > 0); assert.equal(bad.runtime.status().gc.effects.unknown, 1); }
 finally { await bad.close(); }
});
