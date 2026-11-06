import fs from 'node:fs';
import { ChildProcess, execFile, spawn, spawnSync } from 'node:child_process';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const execCommand = (file, args, options = {}) => new Promise(resolve => {
  execFile(file, args, options, (error, stdout = '', stderr = '') => resolve({ error, stdout, stderr }));
});

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

/**
 * Query the current process identity asynchronously. { pid, startTime } means a live process with a known creation
 * time; null means the PID is not a live process; { pid, startTime:null, unknown:true } means alive but unverifiable.
 * A PID file is never enough to establish identity.
 */
export async function defaultQueryProcess(pid, { timeoutMs = 5000 } = {}) {
  if (!isPidAlive(pid)) return null;
  const budget = Math.max(1, Math.min(5000, Number.isFinite(timeoutMs) ? timeoutMs : 5000));
  if (process.platform === 'win32') {
    const query = await execCommand('powershell', ['-NoProfile', '-Command',
      '(Get-Process -Id ' + pid + ' -ErrorAction Stop).StartTime.ToUniversalTime().ToString("o")'],
      { encoding: 'utf8', timeout: budget, windowsHide: true });
    if (!query.error && query.stdout.trim()) return { pid, startTime: query.stdout.trim() };
    if (/cannot find|no process|not found/i.test(query.stderr)) return null;
    return { pid, startTime: null, unknown: true };
  }
  const query = await execCommand('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: budget });
  if (!query.error && query.stdout.trim()) return { pid, startTime: query.stdout.trim() };
  return /no such process|not found/i.test(query.stderr) ? null : { pid, startTime: null, unknown: true };
}

/** Private synchronous terminator; never accept a bare PID or a stand-in object. */
function defaultTerminateRoot(child) {
  const pid = child?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, status: null, signal: null, error: Error('no root process') };
  if (process.platform === 'win32') {
    const killed = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'],
      { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const ok = !killed.error && killed.status === 0;
    return { ok, status: killed.status ?? null, signal: killed.signal ?? null,
      error: killed.error ?? (ok ? null : Error('taskkill exited with status ' + killed.status)),
      stdout: killed.stdout ?? '', stderr: killed.stderr ?? '' };
  }
  try { process.kill(-pid, 'SIGKILL'); return { ok: true, status: 0, signal: 'SIGKILL', error: null }; }
  catch (error) { return { ok: false, status: null, signal: null, error }; }
}

/**
 * The single entry for "check the root's exit state, then terminate synchronously". It accepts only a real ChildProcess:
 * a numeric PID or a stand-in object has no HANDLE and cannot carry the Windows identity guarantee.
 *
 * Invariant (reviewed against Node v24.17.0 / bundled libuv): the Windows wait thread only posts a completion
 * notification; the child HANDLE is closed from the owning event loop's exit path (after the exit callback), not by the
 * wait thread. Therefore, until the exit event/exitCode is observed, Windows cannot recycle the PID. This holds only if
 * there is no await, async scheduling, or other action that closes the root handle between the checks below and the
 * synchronous terminate call, and only if terminate stays synchronous (spawnSync taskkill or process.kill(-pgid), never
 * execFile/async). Re-check these conditions when upgrading Node/libuv.
 */
export function terminateRootProcess(child, { exitEventReceived = false, terminate = defaultTerminateRoot } = {}) {
  if (!(child instanceof ChildProcess) || !Number.isInteger(child.pid) || child.pid <= 0) {
    throw TypeError('terminateRootProcess requires a real ChildProcess');
  }
  if (exitEventReceived || child.exitCode !== null || child.signalCode !== null) {
    return { ok: true, status: child.exitCode, signal: child.signalCode, skipped: true, error: null };
  }
  const outcome = terminate(child);
  if (outcome && typeof outcome.then === 'function') throw TypeError('terminateRoot must be synchronous');
  return outcome;
}

/**
 * Write a PID record carrying the writer's own estimated creation time. This value comes from process.uptime() and is
 * not an OS creation time; it is marked estimated and can never be used to prove that a PID now belongs to another
 * process. Only an OS-observed (authoritative) identity can do that.
 */
export function writeProcessIdentity(file, pid = process.pid) {
  const startTime = new Date(Date.now() - process.uptime() * 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify({ pid, startTime, source: 'estimated' }));
}

function pidList(value) {
  if (Number.isInteger(value) && value > 0) return [value];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const one = Number(value.pid);
    return Number.isInteger(one) && one > 0 ? [one] : [];
  }
  return [];
}

function listedPids(files) {
  const pids = [];
  for (const file of files) {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const pid of pidList(value)) pids.push(pid);
    } catch { /* not yet written */ }
  }
  return [...new Set(pids)];
}

function readPidFiles(files, records) {
  for (const file of files) {
    let value;
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { continue; }
    for (const pid of pidList(value)) {
      if (records.has(pid)) continue;
      const expectedStart = typeof value?.startTime === 'string' ? value.startTime : null;
      const source = value?.source === 'authoritative' ? 'authoritative' : 'estimated';
      records.set(pid, { pid, startTime: expectedStart, source, identityUnknown: expectedStart === null });
    }
  }
}

/** Same identity semantics used by exit confirmation; never treat a bare live PID as the recorded process. */
export async function isRecordAlive(record, queryProcess = defaultQueryProcess, timeoutMs = 5000) {
  if (!(timeoutMs > 0)) return true; // no budget left: conservatively treat the record as possibly alive
  const current = await Promise.resolve(queryProcess(record.pid, { timeoutMs }));
  if (!current) return false;
  if (current.startTime == null) return true; // alive, identity unknown
  if (record.source === 'authoritative' && record.startTime != null) return record.startTime === current.startTime;
  // Estimated or missing identity: the first OS observation becomes the authoritative baseline. An estimated mismatch
  // is never evidence of exit, because the estimate has no bounded error; keep the record conservatively alive.
  record.startTime = current.startTime;
  record.source = 'authoritative';
  record.identityUnknown = false;
  return true;
}

/**
 * Run a controlled process tree. Only the root handle we spawned is terminated (Windows taskkill /T /F or POSIX
 * kill(-pgid)); PID files are diagnostics for exit confirmation, never authorization to kill. A timed-out or failed
 * termination is only settled as terminated:true after every identified descendant is confirmed gone.
 *
 * Two independent budgets, both explicit -- there is no implicit wall-clock default (the old 60s total cap silently
 * killed callers that configured only idleTimeoutMs, which is how a healthy mutation run under load died):
 *   idleTimeoutMs - stop the tree when it stops producing output (progress, not wall clock);
 *   timeoutMs     - hard ceiling for a tree that never stops producing output. Callers pass a budget well above the
 *                   slowest healthy run (at least 3x the old per-run budget).
 * A stopped tree reports stalled and timedOut separately, so "no progress" and "over the hard cap" are never confused.
 */
export function runProcessTree(options = {}) {
  return attemptTree(options, 0);
}

/**
 * Windows refuses CreateProcess with EBUSY while another process holds the image or the machine is at a creation peak;
 * it is transient and says nothing about the run. Retry the same run a bounded number of times instead of failing a
 * mutation sweep on it. Nothing else is retried: a real exit, a timeout or a stalled run is returned as it is.
 */
async function attemptTree(options, attempt) {
  const result = await runProcessTreeOnce(options);
  if (result.error?.code === 'EBUSY' && result.status === null && attempt < 3) {
    await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    return attemptTree(options, attempt + 1);
  }
  return result;
}

function runProcessTreeOnce({ file, args = [], scriptArgs = [], cwd, env, timeoutMs = null, idleTimeoutMs = null,
  readyFile = null, readyTimeoutMs = 30000, confirmTimeoutMs = 15000, pidFiles = [], maxBuffer = 8 * 1024 * 1024,
  queryProcess = defaultQueryProcess, terminateRoot = defaultTerminateRoot } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [...args, file, ...scriptArgs], { cwd, env, windowsHide: true,
      detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let stopping = false;
    let timeoutTimer = null;
    let idleTimer = null;
    let readyTimer = null;
    let rootStatus;
    let rootSignal;
    let exitEventReceived = false;
    let markExited;
    const exited = new Promise(resolve => { markExited = resolve; });
    let childError = null;
    const records = new Map();
    const rootRecord = child.pid ? { pid: child.pid, startTime: null, source: 'authoritative' } : null;
    if (rootRecord) records.set(rootRecord.pid, rootRecord);
    const rootIdentity = rootRecord
      ? Promise.resolve(queryProcess(rootRecord.pid)).then(observed => { rootRecord.startTime = observed?.startTime ?? null; })
        .catch(() => { rootRecord.startTime = null; })
      : Promise.resolve();

    const settle = fields => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (readyTimer) clearTimeout(readyTimer);
      const ids = [...new Set([...records.keys(), ...listedPids(pidFiles)])];
      resolve({ ...fields, pid: child.pid, pids: ids, records: [...records.values()], stdout, stderr });
    };

    const confirmExited = async () => {
      const deadline = Date.now() + confirmTimeoutMs;
      await rootIdentity;
      for (;;) {
        readPidFiles(pidFiles, records);
        const pending = [];
        for (const record of records.values()) {
          const remaining = deadline - Date.now();
          if (!(remaining > 0) || await isRecordAlive(record, queryProcess, remaining)) pending.push(record);
        }
        if (!pending.length) return { confirmed: true, pending: [] };
        if (Date.now() >= deadline) return { confirmed: false, pending };
        await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
      }
    };

    const stop = async (reason, { timedOut = false, stalled = false, error = null } = {}) => {
      if (settled || stopping) return;
      stopping = true;
      let termination;
      try { termination = terminateRootProcess(child, { exitEventReceived, terminate: terminateRoot }); }
      catch (failure) { termination = { ok: false, status: null, signal: null, error: failure }; }
      const confirmation = await confirmExited();
      const confirmed = confirmation.confirmed;
      // The exit status is only known once the 'exit' event has been dispatched. A stopped run waits for it for a
      // bounded moment instead of settling with an undefined status, which reads as "the launcher never answered".
      if (!exitEventReceived) await Promise.race([exited, sleep(Math.min(500, Math.max(50, confirmTimeoutMs)))]);
      settle({ status: rootStatus ?? null, signal: rootSignal ?? null, error: error ?? childError,
        timedOut, stalled, stopReason: reason, terminated: confirmed, pending: confirmation.pending,
        termination: termination ?? { ok: false, status: null, error: Error('no termination result') },
        failure: confirmed ? null : '终止未确认: ' + reason });
    };

    const startTimeout = () => {
      if (timeoutMs > 0 && !timeoutTimer && !settled && !stopping) timeoutTimer = setTimeout(() => { void stop('timeout', { timedOut: true }).catch(
        error => settle({ status: rootStatus ?? null, signal: rootSignal ?? null, error, timedOut: true, terminated: false, failure: '终止未确认: timeout' })); },
        timeoutMs);
      armIdle();
    };
    // A run is stopped when it stops making progress, not when it is merely slow: every output chunk resets this
    // watchdog, so a loaded machine that keeps producing test results is never mistaken for a hung tree.
    const armIdle = () => {
      if (!(idleTimeoutMs > 0) || settled || stopping) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { void stop('idle', { stalled: true }).catch(error => settle({ status: rootStatus ?? null, signal: rootSignal ?? null,
        error, stalled: true, terminated: false, failure: '终止未确认: idle' })); }, idleTimeoutMs);
    };
    const waitReady = () => {
      const deadline = Date.now() + readyTimeoutMs;
      const poll = async () => {
        if (settled || stopping) return;
        if (fs.existsSync(readyFile)) { startTimeout(); return; }
        if (Date.now() >= deadline) { await stop('ready-timeout', { error: Error('ready file was not created: ' + readyFile) }).catch(error => settle({
          status: rootStatus, signal: rootSignal, error, timedOut: false, terminated: false, failure: '终止未确认: ready-timeout' })); return; }
        await sleep(20);
        void poll();
      };
      void poll();
    };

    child.once('exit', (status, signal) => { exitEventReceived = true; rootStatus = status; rootSignal = signal; markExited(); });
    child.stdout?.on('data', chunk => { stdout = (stdout + chunk).slice(-maxBuffer); armIdle(); });
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-maxBuffer); armIdle(); });
    child.once('error', error => {
      childError = error;
      if (!stopping && !settled) void stop('error', { error }).catch(failure => settle({ status: rootStatus, signal: rootSignal, error: failure, timedOut:
        false, terminated: false, failure: '终止未确认: error' }));
    });
    child.once('close', (status, signal) => {
      if (rootStatus === undefined) rootStatus = status;
      if (rootSignal === undefined) rootSignal = signal;
      markExited();
      // Close while a timeout/ready stop is already running is evidence only; it must not settle the run first.
      if (!stopping && !settled) void stop('close').catch(error => settle({ status: rootStatus, signal: rootSignal, error, timedOut: false, terminated:
        false, failure: '终止未确认: close' }));
    });
    if (readyFile) waitReady(); else startTimeout();
  });
}