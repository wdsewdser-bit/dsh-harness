import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { generate } from '../../packages/profiles/index.mjs';
import { BASH_PIN_ID, bashPinEntry } from '../../packages/profiles/shell-entries.mjs';
import { buildTarget } from '../../packages/adapter-dsh/build-target.mjs';

/**
 * The native capability set the collaboration stage adds to the team host.
 *
 * The experiment asks members to write code and run commands in their own workspaces, so the host has to publish
 * the same file and shell tools a normal deployment has. These are separate Loader entries, not a change to the team
 * profile: generate() is called exactly as before, and the entries are appended to the generated patch file. The
 * default profile and the control arm never load this module at all, which is why the C1 capability hash and the
 * published tool catalogue of the default profile cannot move.
 */
const nativeEntryList = (workspaceRoot, defaultDirectory, platform = process.platform) => [
  { id: 'native-fs', name: '@deepseek-ai/dsh-fs-local' },
  { id: 'native-sandbox', name: '@deepseek-ai/dsh-sandbox-local' },
  { id: 'native-attachment', name: '@deepseek-ai/dsh-attachment-local' },
  { id: 'native-tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
  // The deployment fallback is the stage root; each member session still carries its own workspace as its header cwd,
  // which is what the working-directory service and the sandbox policy derive the per-member boundary from.
  { id: 'native-working-directory', name: '@deepseek-ai/dsh-working-directory', config: { defaultDirectory } },
  { id: 'native-sandbox-policy', name: '@deepseek-ai/dsh-sandbox-policy', config: { mode: 'workspace-write', workspaceRoot } },
  { id: 'native-subprocess', name: '@deepseek-ai/dsh-subprocess-local' },
  { id: 'native-shell-env', name: '@deepseek-ai/dsh-shell-env' },
  // WP-D: on Windows the shell provider is the pinned Git Bash (shell-bash-pin.mjs), never pwsh and never a sandbox.
  // Other platforms keep the upstream executor byte for byte.
  platform === 'win32' ? bashPinEntry(platform) : { id: 'native-bash-local', name: '@deepseek-ai/dsh-bash-local' },
  { id: 'native-tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
  { id: 'native-jobs', name: '@deepseek-ai/dsh-jobs-local' },
];

/**
 * P9 (docs/decisions/team-autonomy-design.md §10 P9, appendix 9): the entry the profile takes over when the switch is on.
 *
 * With autonomy on, the profile owns the subprocess provider: installRuntime() subclasses the local provider so every
 * spawn can be attributed to a member and reaped for the stop proof (§7.2.2), and it mounts that subclass only when
 * nothing else already provides `subprocess` ("one provider per context"). Loading the upstream package here as well
 * would therefore do both wrong things at once - register a second provider for the same service name, and, when the
 * entry wins the mount, leave the stop proof with no recorded handles at all. So the two are never loaded together.
 */
const TAKEN_OVER_BY_PROFILE = 'native-subprocess';

/**
 * The native entries for a specification: unchanged with the switch off, minus the taken-over one with it on.
 *
 * WP-D adds a second rule of the same shape: exactly one shell provider. A profile generated with shell:'git-bash'
 * already carries the pinned executor, so the native list drops its own copy instead of mounting a second provider for
 * the same service name. The platform is a parameter so the suites can assert both branches on one machine.
 */
export const nativeEntries = (workspaceRoot, defaultDirectory, { autonomy = 'off', platform = process.platform, shell } = {}) => {
  const entries = nativeEntryList(workspaceRoot, defaultDirectory, platform)
    .filter(entry => !(shell === 'git-bash' && entry.id === BASH_PIN_ID));
  return autonomy === 'on' ? entries.filter(entry => entry.id !== TAKEN_OVER_BY_PROFILE) : entries;
};

/** What bootNativeProfile adds for a specification. The switch is read from the same specification generate() validates. */
export const nativeEntriesFor = (specification, workspaceRoot, defaultDirectory) =>
  nativeEntries(workspaceRoot, defaultDirectory, { autonomy: specification?.autonomy, shell: specification?.shell });

/**
 * The optional live observer (verification/real/collab-watch.mjs).
 *
 * The collaboration stage boots its team in this process, so this process is the only one that can expose that team's
 * projection: the read-only gateway is mounted here, not in the viewer's web host. Off unless COLLAB_WATCH_TOKEN is
 * set, which is why every existing run keeps exactly the entries it had. The token is the projection bearer; the
 * viewer host's origin is the one origin the gateway answers CORS for.
 */
export const watchEntries = (environment = process.env) => {
  const token = environment.COLLAB_WATCH_TOKEN;
  if (!token) return [];
  if (token.length < 16) throw Error('COLLAB_WATCH_TOKEN_TOO_SHORT');
  const port = Number(environment.COLLAB_WATCH_PORT ?? 40298);
  const viewerPort = Number(environment.COLLAB_WATCH_VIEWER_PORT ?? 40299);
  return [{ id: 'collab-watch', name: new URL('../../packages/profiles/projections-plugin.mjs', import.meta.url).href,
    config: { port, sessions: { [token]: environment.COLLAB_WATCH_VIEWER ?? 'member:root' },
      origins: ['http://127.0.0.1:' + viewerPort] } }];
};

/**
 * Boot the team profile plus the native capability set through the official Loader.
 *
 * bootProfile() is left untouched: it is the control arm's boot path and its whitelist is the audit p3b-tests pins. Here
 * the same audit is repeated over the extended set, so an entry that is neither in the generated whitelist nor in this
 * module's own list still fails before any plugin code runs.
 *
 * The tool executor is not part of this set: generate() already put exactly one in the profile, chosen from the release
 * the selected build contains (native, or the candidate's own preempting executor). setExecutor admits one per scope,
 * so adding a second one here would fail — and on the candidate it would also replace the preempting executor with an
 * executor that has no tool-stage halt.
 */
export async function bootNativeProfile(hostRoot, specification, { workspaceRoot, defaultDirectory }) {
  process.env.DSH_HOME = hostRoot;
  const profile = generate(hostRoot, specification);
  const extra = [...nativeEntriesFor(specification, workspaceRoot, defaultDirectory), ...watchEntries()];
  const allowed = new Set([...profile.whitelist, ...extra.map(entry => entry.name)]);
  fs.writeFileSync(hostRoot + '/cordis.patch.yml', JSON.stringify([{ insert: [...profile.entries, ...extra] }]));
  const { base } = buildTarget();
  const { boot, loadOverlayPatches } = await import(pathToFileURL(base + 'dsh-app-boot/lib/index.js').href);
  const ctx = await boot('p3b', hostRoot + '/cordis.yml', loadOverlayPatches('p3b', hostRoot + '/cordis.patch.yml'),
    undefined, pathToFileURL(base + 'dsh/package.json').href);
  const actual = [...ctx.loader.entries()].map(entry => entry.options.name);
  if (actual.some(name => !allowed.has(name))) {
    await ctx.fiber.dispose();
    throw Error('UNTRUSTED_PLUGIN');
  }
  await ctx.teamRuntime.ready;
  return { ctx, actual, profile, extra: extra.map(entry => entry.name) };
}
