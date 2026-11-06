import path from 'node:path';
import { loadBuild } from '../adapter-dsh/index.mjs';
import { GIT_BASH_BIN, resolveBashPath } from './shell-entries.mjs';

/**
 * WP-D: the one shell a Windows deployment runs, pinned to Git for Windows' own bash.
 *
 * bash-local hard-codes its argv (`['bash', '-c', command]`, dsh-bash-local lib/index.js:140-146) and its Config has
 * no path field, so executeArgv is the extension point. This subclass uses exactly that: the upstream lifecycle,
 * deadlines, output budgets and termination stay untouched, and only the program that runs the command is pinned.
 * The pinned path and its BASH_PIN_MISSING rule live in shell-entries.mjs, because generate() refuses a deployment
 * whose program is missing before it writes the profile; this executor enforces the same rule at mount and per run.
 */
export { GIT_BASH, GIT_BASH_BIN, resolveBashPath } from './shell-entries.mjs';

// The build's own dsh-bash-local instance: the same module the Loader mounts, so executeArgv shares the mounted
// subprocess service. The adapter's pristine copy would be a different class against a different service.
const loaded = await loadBuild('dsh-bash-local');
const LocalBashExecutor = loaded.LocalBashExecutor ?? loaded.default;

export default class BashPinExecutor extends LocalBashExecutor {
  constructor(ctx, config) {
    super(ctx, config);
    // Fail closed at mount as well: a deployment that lost the program between generate() and load gets the same
    // error, not a shell that runs something else.
    this.assertPinned();
  }

  /** The program this executor runs; throws BASH_PIN_MISSING rather than returning a substitute. */
  get bashPath() { return resolveBashPath(); }

  assertPinned() { return this.bashPath; }

  /** The upstream spawn with Git's bin directory first on PATH, so the command's own `ls`/`grep` are Git's. */
  spawnSpec(spec, argv, stdoutMaxBytes, signal) {
    const spawn = super.spawnSpec(spec, argv, stdoutMaxBytes, signal);
    const environment = { ...spawn.env };
    const inherited = environment.PATH ?? environment.Path ?? process.env.PATH ?? '';
    delete environment.Path;
    environment.PATH = GIT_BASH_BIN + path.delimiter + inherited;
    return { ...spawn, env: environment };
  }

  /** The public command, re-pointed at the pinned program; executeArgv keeps every other upstream semantic. */
  async execute(spec) { return this.executeArgv(spec, [this.bashPath, '-c', spec.command]); }
}
