import { spawn, spawnSync } from 'node:child_process';

/**
 * The S1 mutation suite lives in packages/core and may not import packages/profiles/test-support (check:deps rule b).
 * This is the same controlled-runner contract kept beside that suite; verification/unit/process-runner-contract.test.mjs
 * drives both implementations through the same cases, so they cannot drift apart silently.
 *
 * Two independent budgets, both explicit (no implicit wall-clock default):
 *   idleTimeoutMs - stop the tree when it stops producing output;
 *   timeoutMs     - hard ceiling for a tree that never stops producing output.
 * A stopped tree settles only after its root is confirmed gone, with the same result fields as the shared runner:
 * status, signal, stalled, timedOut, stopReason, terminated, pending, termination, pid, error.
 */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function runS1Process(options = {}) {
  return attempt(options, 0);
}

/**
 * Windows refuses CreateProcess with EBUSY while another process holds the image. The retry is a NEW attempt: the first
 * promise has already settled, so its later 'close' cannot resolve anything a second time, and the retry's own error is
 * what the caller receives if it fails too.
 */
async function attempt(options, attemptIndex) {
  const result = await runOnce(options);
  if (result.error?.code === 'EBUSY' && result.status === null && attemptIndex < 3) {
    await sleep(250 * (attemptIndex + 1));
    return attempt(options, attemptIndex + 1);
  }
  return result;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

/** Synchronous terminator: taskkill /T /F on Windows, the process group on POSIX. Never async, never a bare PID. */
function terminateTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: true, skipped: true, error: null };
  if (process.platform === 'win32') {
    const killed = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const ok = !killed.error && killed.status === 0;
    return { ok, skipped: false, error: killed.error ?? (ok ? null : Error('taskkill exited with status ' + killed.status)) };
  }
  try { process.kill(-pid, 'SIGKILL'); return { ok: true, skipped: false, error: null }; }
  catch (error) { return { ok: false, skipped: false, error }; }
}

function runOnce({ file, args = [], scriptArgs = [], cwd, env, timeoutMs = null, idleTimeoutMs = null,
  confirmTimeoutMs = 15000, maxBuffer = 8 * 1024 * 1024, spawnChild = spawn } = {}) {
  return new Promise(resolve => {
    const child = spawnChild(process.execPath, [...args, file, ...scriptArgs],
      { cwd, env, windowsHide: true, detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let stopping = false;
    let timeoutTimer = null;
    let idleTimer = null;
    let rootStatus;
    let rootSignal;
    let exitEventReceived = false;
    let childError = null;

    const settle = fields => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (idleTimer) clearTimeout(idleTimer);
      resolve({ ...fields, pid: child.pid ?? null, stdout, stderr });
    };
    const armIdle = () => {
      if (!(idleTimeoutMs > 0) || settled || stopping) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { void stop('idle', { stalled: true }); }, idleTimeoutMs);
    };
    const confirmGone = async pid => {
      const deadline = Date.now() + confirmTimeoutMs;
      while (Date.now() < deadline) {
        if (!pidAlive(pid)) return { confirmed: true, pending: [] };
        await sleep(50);
      }
      return { confirmed: false, pending: Number.isInteger(pid) ? [{ pid }] : [] };
    };
    const stop = async (reason, { timedOut = false, stalled = false, error = null } = {}) => {
      if (settled || stopping) return;
      stopping = true;
      let termination = { ok: true, skipped: true, error: null };
      try {
        if (!exitEventReceived) termination = terminateTree(child.pid);
        const confirmation = await confirmGone(child.pid);
        // The exit status is known only once the 'exit' event is dispatched; wait for it for a bounded moment so a
        // stopped run reports a status instead of undefined.
        if (!exitEventReceived) {
          const deadline = Date.now() + Math.min(500, Math.max(50, confirmTimeoutMs));
          while (!exitEventReceived && Date.now() < deadline) await sleep(20);
        }
        const confirmed = confirmation.confirmed && (termination.ok || exitEventReceived);
        settle({ status: rootStatus ?? null, signal: rootSignal ?? null, error: error ?? childError,
          timedOut, stalled, stopReason: reason, terminated: confirmed, pending: confirmation.pending, termination,
          failure: confirmed ? null : '终止未确认: ' + reason });
      } catch (failure) {
        settle({ status: rootStatus ?? null, signal: rootSignal ?? null, error: failure, timedOut, stalled,
          stopReason: reason, terminated: false, pending: [], termination, failure: '终止未确认: ' + reason });
      }
    };

    child.once('exit', (status, signal) => { exitEventReceived = true; rootStatus = status; rootSignal = signal; });
    child.stdout?.on('data', chunk => { stdout = (stdout + chunk).slice(-maxBuffer); armIdle(); });
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-maxBuffer); armIdle(); });
    child.once('error', spawnError => {
      childError = spawnError;
      if (stopping || settled) return;
      if (!Number.isInteger(child.pid)) {
        // CreateProcess failed (EBUSY): no tree exists, so there is nothing to terminate or confirm. Settle once; a
        // later 'close' for this failed spawn finds settled=true and is ignored.
        settle({ status: null, signal: null, error: spawnError, timedOut: false, stalled: false, stopReason: 'error',
          terminated: true, pending: [], termination: { ok: true, skipped: true, error: null }, failure: null });
        return;
      }
      void stop('error', { error: spawnError });
    });
    child.once('close', (status, signal) => {
      if (rootStatus === undefined) rootStatus = status;
      if (rootSignal === undefined) rootSignal = signal;
      // A close that arrives while a timeout/idle stop is running is evidence only; it must not settle first.
      if (!stopping && !settled) void stop('close');
    });

    if (timeoutMs > 0 && !settled && !stopping) timeoutTimer = setTimeout(() => { void stop('timeout', { timedOut: true }); }, timeoutMs);
    armIdle();
  });
}
