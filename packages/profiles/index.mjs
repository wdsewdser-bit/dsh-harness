import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { digest } from '../contracts/index.mjs';
import { fail, autonomyConfig, superagentBorrowConfig, borrowOptions, assertBorrowPreconditions, assertProtocolSupported } from '../contracts/index.mjs';
import { buildTarget } from '../adapter-dsh/index.mjs';
import { v1BuildCapability } from './borrow-entry-support.mjs';
import { bashPinEntry, resolveBashPath } from './shell-entries.mjs';
export { registerBusinessTool } from './business-tools.mjs';
export { migrateBorrowPolicy } from './borrow-policy.mjs';
export { borrowEntrySupport, v1BuildCapability, BORROW_TRANSPORT_CONTRACT, BORROW_BUILD_VERSION } from './borrow-entry-support.mjs';
export { apply as applyTeamProfile, registerHostVisibility } from './team-plugin.mjs';
export { activateHost as activateTeamHost, assertMemberWorkspace, mainRequestPredicate } from './host-driver.mjs';
export { apply as applyTeamProjections } from './projections-plugin.mjs';

/**
 * The autonomy options a profile patch may carry; design §10 P0.
 *
 * Absent means "the contract defaults", and the keys are then not written at all: a specification that says nothing
 * about autonomy must generate the byte-for-byte profile it generated before this switch existed. When any of them is
 * named, the whole set is validated and resolved first - a patch that carries stopGraceMs: '5s' fails the build here,
 * with INVALID_CONFIG, rather than one command later inside a running team.
 */
const AUTONOMY_KEYS = Object.freeze(['autonomy', 'goalGate', 'stopGraceMs', 'stopProofTimeoutMs', 'decisionTtlMs', 'budget', 'pricing']);
function autonomyOptions(specification) {
  const given = {};
  for (const key of AUTONOMY_KEYS) if (specification[key] !== undefined) given[key] = specification[key];
  if (Object.keys(given).length === 0) return {};
  const resolved = autonomyConfig(given);
  const written = {};
  for (const key of AUTONOMY_KEYS) written[key] = resolved[key];
  return written;
}

/**
 * The borrow-protocol options a profile patch may carry; design §2, §10 P0.
 *
 * Absent means "the protocol is off", and the keys are then not written at all: a specification that says nothing about
 * the borrow keeps generating the byte-for-byte profile it generated before the switch existed (off golden, §2 first
 * bullet). When one is named the whole set is validated here, at build time, instead of one command later in a running
 * team; and a position this build cannot honour (v1, or an owner model before the P2 entry exists) fails the build
 * instead of running the old protocol under a new name.
 */
function borrowOptionsFor(specification) {
  const given = borrowOptions(specification);
  if (Object.keys(given).length === 0) return {};
  const resolved = superagentBorrowConfig(given);
  // P0 rejects unsupported requests consistently, before capability/precondition checks.
  assertProtocolSupported(resolved);
  if (specification.team !== true) fail('INVALID_CONFIG');
  // §2: v1 is one protocol version and only exists on the four capabilities it was designed against. Off is not asked
  // to satisfy them, and an owner model alone is not a protocol position.
  if (resolved.superagentBorrow === 'v1') {
    assertBorrowPreconditions({
      team: specification.team === true, guard: specification.guard === true, goalCheck: specification.goalCheck === true,
      autonomy: specification.autonomy ?? 'off', collab: specification.collab ?? 'off',
    });
  }
  return { superagentBorrow: resolved.superagentBorrow, ownerModel: resolved.ownerModel, intentSemantics: resolved.intentSemantics };
}

/** Generate a single capability-checked official Loader profile; 08 §1.3. */
export function generate(root, specification) {
  const team = specification.team === true;
  // WP-D: the shell is a deployment position, and the only one this build can honour is the pinned Git Bash. A value
  // this file does not understand fails here rather than generating a profile that silently runs whatever comes first.
  if (specification.shell !== undefined && specification.shell !== 'git-bash') fail('INVALID_CONFIG');
  const borrow = borrowOptionsFor(specification);
  if (team && (!specification.guard || !specification.goalCheck)) fail('UNSAFE_PROFILE');
  const autonomy = autonomyOptions(specification);
  const modules = ['dsh-session-projection', 'dsh-session', 'dsh-llm', 'dsh-tools', 'dsh-system-prompt',
    'dsh-agent', 'dsh-token-meter', 'dsh-session-persistence-jsonl', 'dsh-agent-loop', 'dsh-goal'];
  // The build decides how tools are executed, never the profile: 0.2.2 removed dsh-tools' own mode and requires exactly
  // one executor plugin in the scope. Every supported release ships dsh-tool-executor-native and buildTarget() refuses a
  // build without it, so the executor row is always written and dsh-tools itself carries no configuration.
  //
  // setExecutor admits exactly one executor per scope, so this is a choice and never a pair. Only the team profile can
  // preempt anything, so only the team profile takes the candidate's own executor; the default profile keeps the
  // upstream one. buildTarget rejects an incomplete candidate rather than falling back. Pairing the wrong executor is the
  // failure both ways: a preempting team on the native executor loses the tool-stage halt, and a non-preempting default
  // profile has no reason to load a line of the candidate.
  const boundary = borrow.superagentBorrow === 'v1';
  // v1 is written with the native executor package (no step preemption) and needs the execution-permit/1 layer, the
  // boundary-wake latch and the instantInterrupt loop surface. One shared check answers this for generate, the direct
  // apply and every recovery start; none of them may admit a build the others refuse.
  const target = boundary ? v1BuildCapability(undefined) : buildTarget(undefined);
  const executor = team && !boundary ? target.preemptExecutor : target.nativeExecutor;
  if (executor !== null) modules.splice(modules.indexOf('dsh-tools') + 1, 0, executor);
  // The team profile is the only one that enables step-scoped preemption; the default profile stays byte-for-byte
  // the upstream configuration so a load of it cannot execute a line of the candidate.
  const entries = modules.map((name, index) => ({ id: 'core-' + index, name: '@deepseek-ai/' + name,
    config: name === 'dsh-agent-loop' ? (team ? { agents: [], instantInterrupt: !boundary } : { agents: [] }) :
      name === 'dsh-session-persistence-jsonl' ? { root: root + '/sessions', compression: 'none', listConcurrency: 4 } : {} }));
  // WP-D: a deployment that names git-bash gets the one shell provider this build runs commands through. The row sits
  // with the modules, before the runtime: it is a capability of the deployment, not of the team. Absent shell means
  // absent row, which is why every profile generated before this switch existed keeps its bytes.
  if (specification.shell === 'git-bash' && process.platform === 'win32') {
    // Fail closed before the write, not at mount: the Loader degrades a plugin that cannot construct to a warning and
    // leaves its consumers pending, so a profile written for a missing program would boot a team with no shell at all.
    // The row is win32-only: off Windows the profile gains no entry at all, so its bytes stay what they were.
    resolveBashPath();
    entries.push(bashPinEntry(process.platform));
  }
  // The collaboration switch is a property of the configuration, never of the build: team:false cannot ask for it.
  // The member-workspace hook travels as JSON (module + export), never as a function: this file is written to
  // cordis.patch.yml. A deployment that needs per-member directories names the module; the profile imports it.
  const workspace = { ...(boundary ? { repositories: specification.repositories ?? [], ...(specification.threadEventLimit === undefined ? {} : { threadEventLimit: specification.threadEventLimit }) } : {}), ...(specification.memberWorkspace === undefined ? {} : { memberWorkspace: specification.memberWorkspace }), ...(specification.repository === undefined ? {} : { repository: specification.repository }), ...(specification.gitRoots === undefined ? {} : { gitRoots: specification.gitRoots }) };
  if (team && specification.collab !== undefined && specification.collab !== 'off') {
    entries.push({ id: 'team-runtime', name: new URL('./team-plugin.mjs', import.meta.url).href,
      config: { root, collab: specification.collab, ...(specification.decisionLimit === undefined ? {} : { decisionLimit: specification.decisionLimit }),
        ...(specification.assumptionDeadline === undefined ? {} : { assumptionDeadline: specification.assumptionDeadline }),
        ...(specification.intentWindowMs === undefined ? {} : { intentWindowMs: specification.intentWindowMs }), ...workspace, ...autonomy, ...borrow } });
  } else if (team) entries.push({ id: 'team-runtime', name: new URL('./team-plugin.mjs', import.meta.url).href,
    config: { root, ...(specification.gitRoots === undefined ? {} : { gitRoots: specification.gitRoots }), ...workspace, ...autonomy, ...borrow } });
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
export async function bootProfile(root, specification, injectedEntries = []) {
  process.env.DSH_HOME = root;
  const profile = generate(root, specification);
  // Audit before boot as well: rejected plugin code must never execute.
  if (injectedEntries.some(entry => !profile.whitelist.includes(entry.name))) fail('UNTRUSTED_PLUGIN');
  // The one build switch in the repository (packages/adapter-dsh/build-target.mjs): the roots live in
  // build/builds.json, never in code. DSH_UPSTREAM_BUILD selects the build; the default is the C1 build recorded there,
  // and an older release's result is reproduced by naming that release's build root. The wiring of the profile follows
  // the release the selected build actually contains, never a version string in this file.
  const { base } = buildTarget();
  const { boot, loadOverlayPatches } = await import(pathToFileURL(base + 'dsh-app-boot/lib/index.js'));
  const ctx = await boot('p3b', root + '/cordis.yml', loadOverlayPatches('p3b', root + '/cordis.patch.yml'),
    undefined, pathToFileURL(base + 'dsh/package.json').href);
  if (specification.team) await ctx.teamRuntime.ready;
  const actual = [...ctx.loader.entries()].map(entry => entry.options.name);
  if (actual.some(name => !profile.whitelist.includes(name))) {
    await ctx.fiber.dispose();
    fail('UNTRUSTED_PLUGIN');
  }
  return { ctx, actual, profile };
}
