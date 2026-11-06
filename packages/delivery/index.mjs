import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { verify as verifySignature } from 'node:crypto';
import { canonical, digest, fail, failWith } from '../contracts/index.mjs';

/**
 * The delivery IO port: readback evidence only, never a writable core; design §3.7.
 *
 * What lives here is the half that touches the outside world: Git, worktrees and the verifier subprocess. None of it
 * blocks the event loop (spawn + a configurable timeout, never spawnSync on the readback path), and none of it decides
 * a domain transition: every entry returns evidence - { ok, value } / { ok: false, code } / { ok: false, unknown: true }
 * - and the host applies the state that evidence supports through the `delivery.transition` reducer.
 *
 * A timeout or an unparsable answer is `unknown`, never a guessed success or a retry: "the command did not finish"
 * is not "the command did not run".
 */

/** Git readback budget for the non-blocking path; design §8.2.1 (60 s by default, configured). */
const DEFAULT_GIT_TIMEOUT_MS = 60000;

/**
 * The budget of the *synchronous* completion-guard readback; review finding 6.
 *
 * The guard runs on the event loop (the upstream policy is synchronous), so its worst case is a stall of everything
 * else: cycle, heartbeat and visibility. Five seconds turns a slow disk into GIT_TIMEOUT quickly, which the gate
 * reports as a missing capability instead of freezing the host for the 60 s a batch readback may take.
 */
const DEFAULT_GATE_GIT_TIMEOUT_MS = 5000;

/**
 * The one trusted scope for Git: the repository's own runs/ tree. It is a default, not a hard-coded rule - a host
 * configuration supplies gitRoots and this list is what the offline suites keep working with.
 */
const DEFAULT_GIT_ROOTS = Object.freeze([path.resolve(fileURLToPath(new URL('../../runs', import.meta.url)))]);

const normalisePath = value => {
  const text = String(value).replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? text.toLowerCase() : text;
};

/**
 * Normalise a gitRoots configuration: every root must exist, be a directory, and resolve through realpath. A root that
 * only looks right (a symlink, a relative path, a drive-case difference) is refused here, once, instead of silently
 * matching nothing on the first call.
 */
export function resolveGitRoots(roots = DEFAULT_GIT_ROOTS) {
  if (!Array.isArray(roots) || roots.length === 0) failWith('INVALID_CONFIG', 'gitRoots must be a non-empty array of directories');
  const resolved = [];
  for (const root of roots) {
    if (typeof root !== 'string' || !root) failWith('INVALID_CONFIG', 'gitRoots must contain non-empty paths, got ' + JSON.stringify(root));
    let real;
    try {
      real = fs.realpathSync(root);
    } catch (error) {
      failWith('INVALID_GIT_ROOT', String(root) + ' is not an existing directory (' + (error.code ?? error.message) + ')');
    }
    if (!fs.statSync(real).isDirectory()) failWith('INVALID_GIT_ROOT', String(root) + ' is not a directory');
    resolved.push(normalisePath(real));
  }
  return Object.freeze([...new Set(resolved)]);
}

/** The per-call containment check: the target, after realpath, must be one of the roots or inside one. */
function assertGitTarget(target, roots) {
  let ancestor = path.resolve(target);
  const suffix = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) fail('GIT_SCOPE');
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  const real = path.join(fs.realpathSync(ancestor), ...suffix);
  const normalised = normalisePath(real);
  if (!roots.some(allowed => normalised === allowed || normalised.startsWith(allowed + '/'))) fail('GIT_SCOPE');
  return real;
}

function assertGitRoot(root, roots) {
  if (typeof root !== 'string' || !root) failWith('GIT_SCOPE', 'a git call needs a directory');
  let real;
  try {
    real = fs.realpathSync(root);
  } catch {
    fail('GIT_SCOPE');
  }
  const normalised = normalisePath(real);
  if (!roots.some(allowed => normalised === allowed || normalised.startsWith(allowed + '/'))) fail('GIT_SCOPE');
  return real;
}

/**
 * One synchronous git readback, shared by the runner's `runSync` and the gate runner: same result vocabulary, so a
 * caller never has to guess whether a missing answer means "failed" or "could not tell".
 */
function syncReadback(directory, args, { timeoutMs, spawnSync: spawnSyncImpl }) {
  const result = spawnSyncImpl('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
  if (result.error) {
    const timedOut = result.error.code === 'ETIMEDOUT' || Boolean(result.signal);
    return { ok: false, unknown: true, code: timedOut ? 'GIT_TIMEOUT' : 'GIT_UNAVAILABLE', reason: result.error.message };
  }
  if (result.signal) return { ok: false, unknown: true, code: 'GIT_TIMEOUT', reason: 'git was killed after ' + timeoutMs + 'ms' };
  if (result.status !== 0) return { ok: false, code: 'GIT_FAILED', reason: String(result.stderr ?? 'git failed').trim() };
  return { ok: true, value: String(result.stdout ?? '').trim() };
}

/**
 * One git runner bound to one set of roots. `run` never throws for a git failure: a proved failure is
 * { ok: false, code: 'GIT_FAILED' }, an unfinished or unreadable one is { ok: false, unknown: true }.
 */
function createGitRunner({ roots = DEFAULT_GIT_ROOTS, timeoutMs = DEFAULT_GIT_TIMEOUT_MS, spawn: spawnImpl = spawn,
  spawnSync: spawnSyncImpl = spawnSync } = {}) {
  const allowed = resolveGitRoots(roots);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) failWith('INVALID_CONFIG', 'a git timeout must be a non-negative finite number of milliseconds');
  if (typeof spawnImpl !== 'function') failWith('INVALID_CONFIG', 'a git runner needs a spawn function');
  if (typeof spawnSyncImpl !== 'function') failWith('INVALID_CONFIG', 'a git runner needs a synchronous spawn function');
  const run = (root, args = []) => new Promise((resolve, reject) => {
    let directory;
    try {
      directory = assertGitRoot(root, allowed);
    } catch (error) {
      reject(error);
      return;
    }
    let child;
    try {
      child = spawnImpl('git', ['-C', directory, ...args], { windowsHide: true });
    } catch (error) {
      resolve({ ok: false, unknown: true, code: 'GIT_UNAVAILABLE', reason: error.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* the child is already gone */
      }
      finish({ ok: false, unknown: true, code: 'GIT_TIMEOUT', reason: 'git did not finish within ' + timeoutMs + 'ms' });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on?.('data', chunk => {
      stdout += chunk;
    });
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on?.('data', chunk => {
      stderr += chunk;
    });
    child.once?.('error', error => finish({ ok: false, unknown: true, code: 'GIT_UNAVAILABLE', reason: error.message }));
    child.once?.('close', code => finish(code === 0 ? { ok: true, value: stdout.trim() }
      : { ok: false, code: 'GIT_FAILED', reason: (stderr || 'git failed').trim() }));
  });
  /**
   * The synchronous variant, for the one caller that cannot await (the completion guard). Same roots, same budget:
   * a timeout or a killed child is { ok: false, unknown: true, code: 'GIT_TIMEOUT' }, a proved failure is GIT_FAILED.
   * GIT_SCOPE is not a readback result - it is a configuration violation and throws.
   */
  const runSync = (root, args = []) => syncReadback(assertGitRoot(root, allowed), args, { timeoutMs, spawnSync: spawnSyncImpl });
  return Object.freeze({ roots: allowed, timeoutMs, run, runSync });
}

const defaultRunner = createGitRunner();

/** Readback with the default roots: the value, or a thrown typed failure. Never `unknown` by accident. */
export async function git(root, ...args) {
  const result = await defaultRunner.run(root, args);
  if (result.unknown) throw Object.assign(Error(result.code + ': ' + (result.reason ?? '')), { code: result.code, unknown: true });
  if (!result.ok) throw Object.assign(Error(result.reason || 'git failed'), { code: result.code ?? 'GIT_FAILED' });
  return result.value;
}

/**
 * The gate's own runner: the synchronous readback with its own roots and its own (short) budget; review findings 1, 6.
 *
 * package @deepseek-ai/dsh's goal completion guard is a *synchronous*, read-only policy (`registerCompletionGuard`
 * documents "one synchronous policy"): a promise cannot authorize completion. The goal gate therefore owns one
 * `runSync` runner instead of reaching for the module-level default roots, so a team repository outside the shipped
 * `runs/` tree is a configuration choice, not a GIT_SCOPE dead end.
 */
export function createGitGuardRunner({ roots = DEFAULT_GIT_ROOTS, timeoutMs = DEFAULT_GATE_GIT_TIMEOUT_MS, spawnSync: spawnSyncImpl = spawnSync } = {}) {
  const allowed = resolveGitRoots(roots);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) failWith('INVALID_CONFIG', 'a git guard timeout must be positive');
  if (typeof spawnSyncImpl !== 'function') failWith('INVALID_CONFIG', 'a git guard runner needs a synchronous spawn function');
  return Object.freeze({ roots: allowed, timeoutMs,
    run: (root, args = []) => syncReadback(assertGitRoot(root, allowed), args, { timeoutMs, spawnSync: spawnSyncImpl }) });
}

/** Run the independent verifier in its own process; a timeout or an unparsable answer is `unknown`. */
function runVerifier({ directory, request, timeoutMs, spawn: spawnImpl }) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawnImpl(process.execPath, [fileURLToPath(new URL('./verifier.mjs', import.meta.url)), directory, JSON.stringify(request)], { windowsHide: true });
    } catch (error) {
      resolve({ ok: false, unknown: true, code: 'VERIFIER_UNAVAILABLE', reason: error.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* the child is already gone */
      }
      finish({ ok: false, unknown: true, code: 'VERIFIER_TIMEOUT', reason: 'the verifier did not finish within ' + timeoutMs + 'ms' });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on?.('data', chunk => {
      stdout += chunk;
    });
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on?.('data', chunk => {
      stderr += chunk;
    });
    child.once?.('error', error => finish({ ok: false, unknown: true, code: 'VERIFIER_UNAVAILABLE', reason: error.message }));
    child.once?.('close', code => {
      if (code !== 0) {
        finish({ ok: false, code: 'VERIFIER_FAILED', reason: (stderr || 'the verifier failed').trim() });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        finish({ ok: false, unknown: true, code: 'VERIFIER_UNREADABLE', reason: 'the verifier output is not JSON' });
        return;
      }
      const { certificate, signature, publicKey } = parsed ?? {};
      if (!certificate || !signature || !publicKey) {
        finish({ ok: false, unknown: true, code: 'VERIFIER_UNREADABLE', reason: 'the verifier output is incomplete' });
        return;
      }
      finish({ ok: true, certificate, signature, publicKey, certificateHash: digest(certificate) });
    });
  });
}

/**
 * The readback half of Delivery, bound to one repository and one gitRoots configuration.
 *
 * It holds no core and returns no receipts: `worktreeAdd` proves the checkout, `revParse`/`dirty`/`ancestor` read the
 * state the host then commits, `verify` returns the signed certificate the host stores. `worktreePath` is the only
 * derived name, so the on-disk layout does not depend on the caller.
 */
export function createDeliveryPort({ repository = null, gitRoots = DEFAULT_GIT_ROOTS, timeoutMs = DEFAULT_GIT_TIMEOUT_MS, spawn: spawnImpl = null } = {}) {
  const runner = createGitRunner({ roots: gitRoots, timeoutMs, ...(spawnImpl ? { spawn: spawnImpl } : {}) });
  if (repository !== null && (typeof repository !== 'string' || !repository)) failWith('INVALID_CONFIG', 'a delivery repository is a directory path');
  const git = (root, ...args) => runner.run(root, args);
  return Object.freeze({
    repository,
    roots: runner.roots,
    timeoutMs,
    git,
    revParse: (root, ref) => git(root, 'rev-parse', ref),
    dirty: root => git(root, 'status', '--porcelain'),
    tree: (root, ref) => git(root, 'rev-parse', ref + '^{tree}'),
    ancestor: (root, base, candidate) => git(root, 'merge-base', '--is-ancestor', base, candidate),
    updateRef: (root, ref, next, expected) => git(root, 'update-ref', ref, next, expected),
    worktreePath: taskId => assertGitTarget(path.join(repository, '..', 'work-' + digest(taskId).slice(0, 12)), runner.roots),
    /** Create the detached worktree from the recorded base and prove the checkout really is that commit. */
    async worktreeAdd(directory, base) {
      assertGitTarget(directory, runner.roots);
      const added = await git(this.repository, 'worktree', 'add', '--detach', directory, base);
      if (!added.ok) return added;
      const head = await git(directory, 'rev-parse', 'HEAD');
      if (!head.ok) return head;
      if (head.value !== base) fail('WORKTREE_MISMATCH');
      return { ok: true, value: base };
    },
    verify: ({ directory, request }) => runVerifier({ directory: assertGitRoot(directory, runner.roots), request, timeoutMs: runner.timeoutMs, spawn: spawnImpl ?? spawn }),
  });
}

/**
 * Record an operator verdict only. Acceptance still requires independent certified Git readback.
 *
 * "Operator" is literal here, exactly as for mailbox.resolveUnknown: root is a team role, not the operator, and the
 * verdict on an unknown external effect belongs to the operator (see the comment on submitMailbox). This one entry
 * keeps its core argument because it is the operator command translator, not the delivery IO port.
 */

/** The certificate check the host repeats before storing a verifier answer; exported so the gate and the host agree. */
export function certificateIsSigned(certificate, signature, publicKey) {
  try {
    return verifySignature(null, Buffer.from(canonical(certificate)), publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}
