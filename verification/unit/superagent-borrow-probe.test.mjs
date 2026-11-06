// §11 probes of the super-agent borrow design, runnable and honest: each one either confirms a claim the design makes
// about HEAD, refutes it, or records that this offline environment cannot answer it. Nothing here activates a consumer;
// the probes only read the composition that exists today.
//
//   probe A (§4.1, §4.2)  where the final tool-execution hook is, and whether the owner session reaches it
//   probe B (§5.4, §11)   whether the wake edge survives the step-abort latch being off
//
// The two remaining §11 rows this package could touch - the owner's control-slot transport termination and the
// authenticity chain of native human input - are reported in docs/host-protocol.md §8.7. Existing owner host-control
// transport is not evidence of durable control-slot termination/recovery; these probes do not establish that binding
// or an authenticated human-origin minting chain. Inventing a fake endpoint would not prove either.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { profile } from '../../packages/host/test-support/profile.mjs';
import { host } from '../../packages/adapter-dsh/index.mjs';
import { buildTarget } from '../../packages/adapter-dsh/build-target.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every .mjs under packages/, so a claim about "the only installer of X" is checked against the tree, not a guess. */
function packageSources(dir = path.join(repo, 'packages'), out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') packageSources(full, out); }
    else if (entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

test('probe A (§11): repository owner wiring bypasses the member guard (profile test context)', async () => {
  // A1. The only tools.guard() call site in the product is the one bindAgent installs for a MEMBER agent. The owner
  //     session never passes through bindAgent, so no guard of this kind is installed for it.
  const installers = packageSources().filter(file => /tools\.guard\(/.test(fs.readFileSync(file, 'utf8')))
    .map(file => path.relative(repo, file).replaceAll('\\', '/'));
  assert.deepEqual(installers, ['packages/profiles/runtime.mjs'],
    'tools.guard is installed in exactly one place; a second installer would be a second security boundary');

  // A2. With autonomy off there is no context-level execution hook at all: the tools/execute wrapper is registered only
  //     while the autonomy switch is on, and it is the only "final execution point" HEAD has.
  const off = await profile({ autonomy: 'off' });
  const offHooks = [...(off.listeners.get('tools/execute') ?? [])];
  await off.close();
  assert.equal(offHooks.length, 0, 'autonomy off installs no tools/execute hook; nothing sits at the final execution point');

  // A3. With autonomy on the hook exists, but it decides from the MEMBER execution scope: a session with no scope (the
  //     owner's) is passed straight to the tool. That is the gap §4.1 asks P2 to close, and it is why "hide the schema"
  //     cannot be the boundary.
  const on = await profile({ autonomy: 'on' });
  try {
    const hooks = [...(on.listeners.get('tools/execute') ?? [])];
    assert.equal(hooks.length, 1, 'one tools/execute hook while the autonomy switch is on');
    let reached = 0;
    const answer = await hooks[0]({ agent: { session: { id: 'session:owner' } }, callId: 'probe-owner-1', name: 'bash' },
      () => { reached++; return 'executed'; });
    assert.equal(reached, 1, 'an unscoped owner session reaches the tool: the hook only fences member executions');
    assert.equal(answer, 'executed');
    assert.equal(on.agentGuards.get('session:owner'), undefined,
      'and no per-agent guard was installed for the owner session');
  } finally {
    await on.close();
  }
});

test('probe B (§11): with the step-abort latch off, the wake edge still owns the turn atomically', async () => {
  const target = buildTarget();
  const loop = fs.readFileSync(path.join(target.base, 'dsh-agent-loop', 'lib', 'index.js'), 'utf8');
  const section = (start, end) => {
    const from = loop.indexOf(start);
    const to = loop.indexOf(end, from + start.length);
    assert(from >= 0 && to > from, 'the prepared build must still contain ' + start);
    return loop.slice(from, to);
  };
  // B1. Source fact: the wake edge and the step-abort latch are separate mechanisms. wakeDriver never reads the latch
  //     switch; beginPreempt is the only reader, and it is what arming a preemptable step depends on.
  const wakeBody = section('wakeDriver(wakeAfterAbort = false)', 'async whenIdle()');
  assert(!/instantInterrupt/.test(wakeBody), 'wakeDriver is not gated by instantInterrupt');
  const beginBody = section('beginPreempt()', 'endPreempt(guard)');
  assert(/instantInterrupt !== true/.test(beginBody), 'beginPreempt is where the latch switch is read');
  const preemptBody = section('preemptStep(reason = "preempted")', 'get preemptSignal()');
  assert(/guard\.armed/.test(preemptBody), 'preemptStep only acts on an armed step latch');

  // B2. Dynamic fact: boot the prepared host (its agent-loop keeps the default, instantInterrupt false) and hold the
  //     underlying kick open, so the driver's own bookkeeping is what is being observed.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'borrow-wake-probe-'));
  const stack = await host(root, { prepared: true });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let opens = 0;
  try {
    const h = await stack.create({ sessionId: 'borrow-wake-probe', agentOptions: { provider: 'offline', model: 'model' },
      meta: { cwd: root } });
    const agent = h.agent;
    assert.equal(agent.phase.kind, 'idle');
    agent.kick = () => { opens++; return gate; };
    agent.wakeDriver();
    assert.equal(agent.phase.kind, 'running', 'an idle wake synchronously owns the running phase');
    const phase = agent.phase, activity = agent.activityDone;
    for (let n = 0; n < 8; n++) agent.wakeDriver(n % 2 === 0);
    assert.equal(opens, 1, 'a busy wake never opens a second turn');
    assert.equal(agent.phase, phase, 'and neither aborts nor replaces the current turn');
    assert.equal(agent.activityDone, activity);
    // The latch itself is off in this composition: no step was armed, so a preempt request is refused rather than
    // aborting the turn. That refusal is the "step-abort is off" half of the probe, not a wake failure.
    assert.equal(agent.preemptStep('probe'), false, 'the step latch refuses while the composition has no armed step');
    let latchSetting = 'unknown';
    try {
      const service = stack.ctx.get?.('agentLoop') ?? stack.ctx.agentLoop;
      if (typeof service?.config?.instantInterrupt === 'boolean') {
        latchSetting = service.config.instantInterrupt ? 'on' : 'off';
      }
    } catch { latchSetting = 'unknown'; }
    assert.equal(latchSetting, 'off', 'unknown is not evidence: the step-abort latch must be observed off');
    release();
    await agent.whenIdle();
    await h.dispose();
  } finally {
    release();
    await stack.ctx.fiber.dispose();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
