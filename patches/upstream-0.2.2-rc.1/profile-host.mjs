import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { digest } from '../../packages/contracts/team.mjs';
import { fail } from '../../packages/contracts/index.mjs';
import { C1 } from './paths.mjs';

/** Define the two release capability combinations from one source; 08 §1.3. */
export const ProfileSpec = Object.freeze({
  default: Object.freeze({ team: false, guard: false, goalCheck: false }),
  team: Object.freeze({ team: true, guard: true, goalCheck: true }),
});

/** Generate a single capability-checked official Loader profile; 08 §1.3. */
export function generate(root, specification) {
  const team = specification.team === true;
  if (team && (!specification.guard || !specification.goalCheck)) fail('UNSAFE_PROFILE');
  const modules = ['dsh-session-projection', 'dsh-session', 'dsh-llm', 'dsh-tools', 'dsh-tool-executor-native', 'dsh-system-prompt',
    'dsh-agent', 'dsh-token-meter', 'dsh-session-persistence-jsonl', 'dsh-agent-loop', 'dsh-goal'];
  // The team profile is the only one that enables step-scoped preemption; the default profile stays byte-for-byte
  // the upstream configuration so a load of it cannot execute a line of the candidate.
  const entries = modules.map((name, index) => ({ id: 'core-' + index, name: '@deepseek-ai/' + name,
    config: name === 'dsh-agent-loop' ? (team ? { agents: [], instantInterrupt: true } : { agents: [] }) :
      name === 'dsh-session-persistence-jsonl' ? { root: root + '/sessions', compression: 'none', listConcurrency: 4 } : {} }));
  const build = process.env.DSH_UPSTREAM_BUILD ?? C1;
  if (fs.existsSync(build + '/node_modules/@deepseek-ai/dsh-tool-executor-preempt/package.json')) {
    const executor = entries.find(e => e.name === '@deepseek-ai/dsh-tool-executor-native');
    executor.name = '@deepseek-ai/dsh-tool-executor-preempt';
    executor.config = {};
  }
  // The collaboration switch is a property of the configuration, never of the build: team:false cannot ask for it.
  if (team && specification.collab !== undefined && specification.collab !== 'off') {
    entries.push({ id: 'team-runtime', name: new URL('../../packages/profiles/team-plugin.mjs', import.meta.url).href,
      config: { root, collab: specification.collab, ...(specification.decisionLimit === undefined ? {} : { decisionLimit: specification.decisionLimit }),
        ...(specification.assumptionDeadline === undefined ? {} : { assumptionDeadline: specification.assumptionDeadline }) } });
  } else if (team) entries.push({ id: 'team-runtime', name: new URL('../../packages/profiles/team-plugin.mjs', import.meta.url).href, config: { root } });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(root + '/cordis.yml', '[]');
  fs.writeFileSync(root + '/cordis.patch.yml', JSON.stringify([{ insert: entries }]));
  // capabilityHash deliberately covers only the three capability flags: it is the identity p3b-tests pins, and the
  // collaboration switch is not a capability of the product but a position of one experiment. The switch is visible
  // in the entry config above and in the published role contract version (p3a-v3 vs p3a-v3-collab).
  return { entries, whitelist: ['cordis:include', ...entries.map(e => e.name)],
    capabilityHash: digest({ team, guard: !!specification.guard, goalCheck: !!specification.goalCheck }) };
}

/** Boot the C1 copy via official Loader and audit its actual loaded tree; 08 §1.3, I09. */
export async function bootProfile(root, specification, injectedEntries = [], { boot: bootOverride } = {}) {
  process.env.DSH_HOME = root;
  const profile = generate(root, specification);
  // Audit before boot as well: rejected plugin code must never execute.
  if (injectedEntries.some(entry => !profile.whitelist.includes(entry.name))) fail('UNTRUSTED_PLUGIN');
  // The one hardcoded build root in the repository, and therefore the one switch. DSH_UPSTREAM_BUILD selects the
  // build; the default stays C1 so an unset environment reproduces every existing result exactly.
  const build = process.env.DSH_UPSTREAM_BUILD ?? C1;
  const base = build.replace(/[/\\]+$/, '') + '/node_modules/@deepseek-ai/';
  // `boot` is a test seam for the refusal path (profile-host-ready.test.mjs); no composition root passes it.
  const { boot, loadOverlayPatches } = bootOverride
    ? { boot: bootOverride, loadOverlayPatches: () => [] }
    : await import(pathToFileURL(base + 'dsh-app-boot/lib/index.js'));
  const ctx = await boot('p3b', root + '/cordis.yml', loadOverlayPatches('p3b', root + '/cordis.patch.yml'),
    undefined, pathToFileURL(base + 'dsh/package.json').href);
  const actual = [...ctx.loader.entries()].map(entry => entry.options.name);
  if (actual.some(name => !profile.whitelist.includes(name))) {
    await ctx.fiber.dispose();
    fail('UNTRUSTED_PLUGIN');
  }
  if (specification.team === true) {
    if (!ctx.teamRuntime) throw Object.assign(Error('TEAM_RUNTIME_MISSING'), { code: 'TEAM_RUNTIME_MISSING' });
    // The Team plugin fills the runtime (core, preempt, host) in its own initialize(), after the Loader returns.
    // Awaiting it here makes a refused host fail at boot with its own error; without this line bootProfile hands back
    // a ctx whose teamRuntime.core is still undefined, and the caller fails one dereference later with no cause.
    await ctx.teamRuntime.ready;
  }
  return { ctx, actual, profile };
}