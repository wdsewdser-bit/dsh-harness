import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyTeamProfile as apply, activateTeamHost as activateHost, generate } from '../../profiles/index.mjs';
export function context() {
  const listeners = new Map();
  return { listeners, goals: { registerCompletionGuard: () => () => {} }, tools: { register() {} }, agents: {},
    sessions: { get: () => undefined, async create(id) { return {id,seq:0,snapshotEvents:()=>[]}; } }, llm: { isAgentLoopRequest: () => true },
    get(name) { return this[name]; }, provide(name, value) { this[name] = value; }, emit() {},
    on(name, fn) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); return () => set.delete(fn); } };
}
// F2a: the F1 driver switch is deleted. A configuration that still names one is refused before the mount creates
// anything - no second driver shape, no second set of timers, no store on disk.
test('profile driver the host driver is the only one, and naming a driver is refused', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-profile-')); const ctx = context();
  const refusedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-profile-refused-')); const refused = context();
  try {
    // f2a-allow-removed-driver: this is the negative case - the removed value must be refused.
    assert.throws(() => apply(refused, { root: refusedRoot, driver: 'harness' }), error => error.code === 'INVALID_CONFIG');
    assert.equal(refused.teamRuntime, undefined, 'a refused configuration publishes no runtime');
    assert.equal(refused.listeners.size, 0, 'and registers no hook');
    assert.equal(fs.existsSync(refusedRoot + '/state-v2'), false, 'and never opens a store');
    apply(ctx, { root }); await ctx.teamRuntime.ready;
    const runtime = ctx.teamRuntime;
    assert.equal(runtime.driver, undefined, 'there is no driver field any more');
    assert.equal(runtime.host.state, 'running'); assert(runtime.host.cycle);
    assert(runtime.host.cycle.status().installed.includes('pump'));
    assert(runtime.host.cycle.status().installed.includes('intents'));
    assert.equal(runtime.gc.status().armed, true);
    // Every ctx-level consumer is registered exactly once, by the only driver there is.
    for (const hook of ['agent/pre-step', 'llm/stream', 'llm/dispatch', 'tools/pre-execute']) assert.equal(ctx.listeners.get(hook).size, 1);
    assert.equal(runtime.core.notifyDelivery, undefined);
    // The harness-only lifecycle outlet is gone with it.
    assert.equal(runtime.lifecycle, undefined);
  } finally {
    if (ctx.teamRuntime?.stop) await ctx.teamRuntime.stop();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(refusedRoot, { recursive: true, force: true });
  }
});
// P0 of team-autonomy: the switch is a contract and it is resolved before the mount creates anything. Its defaults
// are the configuration this profile has always produced, so a patch that says nothing about autonomy is unchanged.
test('a refused autonomy value fails the profile before the mount creates anything', () => {
  const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-refused-')); const refused = context();
  try {
    assert.throws(() => apply(refused, { root: badRoot, stopGraceMs: '5s' }), error => error.code === 'INVALID_CONFIG');
    assert.throws(() => apply(refused, { root: badRoot, goalGate: { legacy: 'refuse' } }), error => error.code === 'INVALID_CONFIG');
    assert.throws(() => apply(refused, { root: badRoot, pricing: { currency: 'USD' } }), error => error.code === 'INVALID_CONFIG');
    assert.equal(refused.teamRuntime, undefined, 'a refused configuration publishes no runtime');
    assert.equal(refused.listeners.size, 0, 'and registers no hook');
    assert.equal(fs.existsSync(badRoot + '/state-v2'), false, 'and never opens a store');
  } finally { fs.rmSync(badRoot, { recursive: true, force: true }); }
});
test('the autonomy switch defaults to off and is published as a frozen contract', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-default-')); const ctx = context();
  try {
    apply(ctx, { root }); await ctx.teamRuntime.ready;
    const autonomy = ctx.teamRuntime.autonomy;
    assert.equal(autonomy.autonomy, 'off', 'off is today\'s behaviour');
    assert.deepEqual(autonomy.goalGate, { strict: false, legacy: 'adopt-tail' }, 'the goal gate keeps its F2 status');
    assert.equal(autonomy.decisionTtlMs, 900000);
    assert.equal(autonomy.pricing, null);
    assert(Object.isFrozen(autonomy) && Object.isFrozen(autonomy.goalGate), 'the resolved contract cannot be edited later');
  } finally { if (ctx.teamRuntime?.stop) await ctx.teamRuntime.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('a generated profile forwards the autonomy options it names, and none when it names none', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-profile-'));
  try {
    const plain = generate(root + '/plain', { team: true, guard: true, goalCheck: true });
    assert.deepEqual(Object.keys(plain.entries.find(entry => entry.id === 'team-runtime').config), ['root'],
      'a specification that says nothing about autonomy generates the profile it always generated');
    const named = generate(root + '/named', { team: true, guard: true, goalCheck: true, autonomy: 'on', stopGraceMs: 1000 });
    const config = named.entries.find(entry => entry.id === 'team-runtime').config;
    assert.equal(config.autonomy, 'on'); assert.equal(config.stopGraceMs, 1000);
    assert.deepEqual(config.goalGate, { strict: false, legacy: 'adopt-tail' }, 'the switch is resolved against the contract defaults');
    assert.throws(() => generate(root + '/bad', { team: true, guard: true, goalCheck: true, autonomy: 'maybe' }),
      error => error.code === 'INVALID_CONFIG');
    assert.equal(fs.existsSync(root + '/bad/cordis.patch.yml'), false, 'a refused specification writes no profile');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('new consumer cannot activate until old IO acknowledges stopped', async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-switch-')); const ctx = context();
 let release; let stopped = false;
 const drained = new Promise(resolve => { release = () => { stopped = true; resolve(); }; });
 const previous = { async stop() {}, whenSettled: () => drained, status: () => ({ stopped }) };
 try {
  apply(ctx, { root, previousDriver: previous });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ctx.teamRuntime.host, undefined);
  assert.equal(ctx.listeners.get('llm/dispatch')?.size ?? 0, 0);
  release(); await ctx.teamRuntime.ready;
  assert.equal(ctx.teamRuntime.host.state, 'running');
  await assert.rejects(activateHost({ previous: { async stop() {}, async whenSettled() {}, status: () => ({ stopped: false }) }, configuration: {} }),
    /DRIVER_NOT_STOPPED/);
 } finally { release(); await ctx.teamRuntime.ready; await ctx.teamRuntime.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
