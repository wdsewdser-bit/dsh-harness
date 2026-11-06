import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { generate, bootProfile } from '../profile-host.mjs';

/**
 * Switch-off proof for the instant-preempt candidate (case P), run against the real Loader.
 *
 * Two claims are checked here, and neither can be checked from the driver probe:
 *  1. The default profile is byte-identical to the upstream configuration: it never passes instantInterrupt, so a
 *     default-profile load cannot arm a latch no matter which build is on disk.
 *  2. DSH_UPSTREAM_BUILD is the whole switch: with it unset the team profile still runs C1, where the driver has
 *     no preemption surface at all; with it set to C2 the same profile gets one, and preemptStep refuses outside
 *     a step instead of throwing.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] ?? '');
assert(root, 'a run directory is required');
fs.mkdirSync(root, { recursive: true });

const C1 = '<path-to-dsh-c1-build-0.2.2>';
const C2 = '<path-to-dsh-c2-build-0.2.2>';
/** The exact upstream agent-loop configuration; the default profile must never add a key to it. */
const UPSTREAM_DEFAULT = { agents: [] };
const agentLoop = entries => entries.find(entry => entry.name === '@deepseek-ai/dsh-agent-loop');

const evidence = { profiles: {} };

// ---- 1. Generation is pure: the default profile carries the upstream config verbatim.
{
  const plain = generate(root + '/generate-default', { team: false });
  const team = generate(root + '/generate-team', { team: true, guard: true, goalCheck: true });
  assert.deepEqual(agentLoop(plain.entries).config, UPSTREAM_DEFAULT, 'P: the default profile must not enable the flag');
  assert.equal(agentLoop(plain.entries).config.instantInterrupt, undefined);
  assert.deepEqual(agentLoop(team.entries).config, { agents: [], instantInterrupt: true },
    'P: the team profile is the only one that enables step-scoped preemption');
  assert(!plain.entries.some(entry => /team-plugin/.test(entry.name)), 'P: the default profile loads no Team plugin');
  evidence.profiles.generated = { default: agentLoop(plain.entries).config, team: agentLoop(team.entries).config };
}

// ---- 2. With the switch unset the team profile still boots C1, where preemption does not exist.
{
  delete process.env.DSH_UPSTREAM_BUILD;
  const home = root + '/boot-c1-team';
  fs.mkdirSync(home, { recursive: true });
  const host = await bootProfile(home, { team: true, guard: true, goalCheck: true });
  try {
    assert.equal(host.ctx.agentLoop.config.instantInterrupt, undefined, 'P: C1 has no instantInterrupt config');
    assert(host.ctx.teamRuntime, 'P: the baseline Team plugin must actually activate');
    const handle = await host.ctx.agents.create({ sessionId: 'c1-team-probe',
      agentOptions: { provider: 'offline', model: 'model' }, meta: { cwd: home } });
    assert.equal(handle.agent.preemptStep, undefined, 'P: a C1 agent has no preemption surface');
    await handle.dispose();
    evidence.profiles.c1Team = { config: host.ctx.agentLoop.config, preemptStep: typeof handle.agent.preemptStep ?? null };
  } finally { await host.ctx.fiber.dispose(); }
}

// ---- 3. The default profile on the candidate build is still the upstream configuration.
{
  process.env.DSH_UPSTREAM_BUILD = C2;
  const home = root + '/boot-c2-default';
  fs.mkdirSync(home, { recursive: true });
  const host = await bootProfile(home, { team: false });
  try {
    // The candidate schema defaults the flag to false; the point is that a default-profile load never turns it on.
    assert.equal(host.ctx.agentLoop.config.instantInterrupt, false,
      'P: loading the candidate build through the default profile must not enable preemption');
    assert.deepEqual(host.ctx.agentLoop.config.agents, []);
    assert(!host.actual.some(name => /team-plugin/.test(name)), 'P: no Team plugin is loaded');
    evidence.profiles.c2Default = { config: { agents: host.ctx.agentLoop.config.agents,
      instantInterrupt: host.ctx.agentLoop.config.instantInterrupt }, loaded: host.actual };
  } finally { await host.ctx.fiber.dispose(); }
}

// ---- 4. The switch alone gives the same team profile the preemption surface.
{
  process.env.DSH_UPSTREAM_BUILD = C2;
  const home = root + '/boot-c2-team';
  fs.mkdirSync(home, { recursive: true });
  const host = await bootProfile(home, { team: true, guard: true, goalCheck: true });
  try {
    assert.equal(host.ctx.agentLoop.config.instantInterrupt, true, 'P: the switch enables the flag for the team profile');
    assert(host.ctx.teamRuntime, 'P: the candidate Team plugin must actually activate');
    const handle = await host.ctx.agents.create({ sessionId: 'c2-team-probe',
      agentOptions: { provider: 'offline', model: 'model' }, meta: { cwd: home } });
    assert.equal(typeof handle.agent.preemptStep, 'function', 'P: a C2 agent exposes preemptStep');
    assert.equal(handle.agent.preemptStep('idle-probe'), false, 'P: preemptStep refuses outside a step');
    assert.equal(handle.agent.preemptSignal, undefined, 'P: there is no live signal outside a step');
    assert.equal(handle.agent.preemptStats.fired, 0);
    await handle.dispose();
    evidence.profiles.c2Team = { config: host.ctx.agentLoop.config, preemptStep: true };
  } finally { await host.ctx.fiber.dispose(); delete process.env.DSH_UPSTREAM_BUILD; }
}

fs.writeFileSync(root + '/profiles.json', JSON.stringify(evidence, null, 2));
console.log('PASS profile switch: C1 Team has no preemption; C2 default stays off; C2 Team enables preemption');