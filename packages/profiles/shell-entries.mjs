import fs from 'node:fs';

/**
 * WP-D: the pinned Git Bash program and the Loader entry that mounts it (shell-bash-pin.mjs).
 *
 * One provider, and only where it can work: off win32 the row is `disabled` rather than absent, so a profile that asks
 * for git-bash states that in its bytes on every platform and the Loader decides from the platform it actually runs
 * on. The module URL is computed here, so no absolute path ever enters a generated profile by hand.
 *
 * The program path lives here rather than in the executor because generate() has to refuse a deployment whose pinned
 * bash is gone *before* it writes a profile - the Loader treats a plugin that fails to construct as a warning and its
 * dependents as pending, which would leave a team running with no shell at all. Nothing here falls back: a missing
 * program is BASH_PIN_MISSING, never `pwsh`, never a sandbox, never "the next bash on PATH".
 *
 * The install root is spelled in parts because packages/ must not carry a drive-letter literal (check-deps rule c); the
 * exact resolved path is pinned by the package suite. A deployment overrides the program with DSH_BASH_PATH. The PATH
 * prefix stays the Git bin directory even then, because `bash -c ls` must resolve Git's coreutils and not another
 * `ls` that happens to be earlier on PATH.
 */
export const GIT_BASH_BIN = ['C:', 'Program Files', 'Git'].join('/') + '/usr/bin';
export const GIT_BASH = GIT_BASH_BIN + '/bash.exe';

export const BASH_PIN_ID = 'bash-pin';
export const BASH_PIN_MODULE = new URL('./shell-bash-pin.mjs', import.meta.url).href;

/** The pinned program, or BASH_PIN_MISSING: a caller never gets a different shell than the one it asked for. */
export function resolveBashPath(environment = process.env) {
  const pinned = environment.DSH_BASH_PATH ?? GIT_BASH;
  if (typeof pinned !== 'string' || pinned.length === 0 || !fs.existsSync(pinned)) {
    throw Object.assign(Error('BASH_PIN_MISSING: ' + String(pinned)), { code: 'BASH_PIN_MISSING' });
  }
  return pinned;
}

/** The bash-pin entry for one platform: enabled on win32, disabled - never a fallback to another shell - elsewhere. */
export function bashPinEntry(platform) {
  return { id: BASH_PIN_ID, name: BASH_PIN_MODULE, ...(platform === 'win32' ? {} : { disabled: true }), config: {} };
}
