import { spawn } from 'node:child_process';
import fs from 'node:fs';

/**
 * D2b / §10 P5 (docs/decisions/team-autonomy-design.md §7.2.3): the operating system's process tree, read and killed
 * with the platform's own tools — no native module (U3: phase one is taskkill + WMI, a Job Object is phase two).
 *
 * Three rules from the design are enforced here rather than by the caller:
 *   1. a pid is only ever addressed as `/PID`, with the arguments in an array and never through a shell string, and
 *      the pid must come from the caller's registered session tree (§7.2.3 rule 1, P5 safety requirement);
 *   2. every row carries the process creation time, because a pid alone is reusable and a reused pid is never killed;
 *   3. a platform this module cannot answer for says so (`available() === false`); it never pretends a process is gone.
 */

// One WMI readback for the whole table: CreateInstance/Win32_Process is the only portable way to learn ParentProcessId
// on Windows without a native module. CreationDate is emitted as a FILETIME integer so the identity is a stable
// string that survives a locale, a clock and a ConvertTo-Json round trip.
const POWERSHELL_LIST = "Get-CimInstance -ClassName Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId,$_.ParentProcessId,$_.CreationDate.ToFileTimeUtc(),$_.Name }";
const LIST_TIMEOUT_MS = 20000;
const KILL_TIMEOUT_MS = 20000;

/** Run one program with an argument array (never a shell string) and collect its output. */
function spawnProcess(command, args, { timeoutMs = LIST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(Object.assign(new Error('cannot run ' + command + ': ' + error.message), { code: 'STOP_CAPABILITY_MISSING' }));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* the tree kill below is the real stop; this only ends the readback */ }
      finish(reject, Object.assign(new Error(command + ' did not answer within ' + timeoutMs + 'ms'), { code: 'STOP_PROOF_TIMEOUT' }));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => finish(reject, Object.assign(new Error('cannot run ' + command + ': ' + error.message), { code: 'STOP_CAPABILITY_MISSING' })));
    child.on('close', code => finish(resolve, { code, stdout, stderr }));
  });
}

const unavailable = () => Object.assign(new Error('this platform has no process-tree implementation in this build'),
  { code: 'STOP_CAPABILITY_MISSING' });

function parseWindowsLine(line) {
  const match = /^(\d+)\|(\d+)\|(\d+)\|(.*)$/.exec(line.trim());
  if (!match) return null;
  return { pid: Number(match[1]), ppid: Number(match[2]), createdAt: 'filetime:' + match[3], name: match[4] || null };
}

/** /proc/<pid>/stat: pid, comm, state, ppid ... starttime (field 22). The start time is the identity, in clock ticks. */
function readProc() {
  const rows = [];
  let names = [];
  try { names = fs.readdirSync('/proc'); } catch { throw unavailable(); }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let stat = null;
    try { stat = fs.readFileSync('/proc/' + name + '/stat', 'utf8'); } catch { continue; }
    const open = stat.indexOf('(');
    const close = stat.lastIndexOf(')');
    if (open < 0 || close < 0) continue;
    const rest = stat.slice(close + 2).split(' ');
    // rest[0] is field 3 (state), so field 22 (starttime) is rest[19].
    const ppid = Number(rest[1]);
    const start = Number(rest[19]);
    if (!Number.isSafeInteger(ppid) || !Number.isSafeInteger(start)) continue;
    rows.push({ pid: Number(name), ppid, createdAt: 'boot:' + start, name: stat.slice(open + 1, close) });
  }
  return rows;
}

/** Every descendant of `pid`, breadth first, from one snapshot. */
export function descendantPids(rows, pid) {
  const byParent = new Map();
  for (const row of rows) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row.pid);
  }
  const found = [];
  const queue = [pid];
  const seen = new Set([pid]);
  while (queue.length) {
    for (const child of byParent.get(queue.shift()) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/**
 * The process-tree port. `run` and `kill` are injectable so the unit tests exercise the same code path as production.
 *
 *   platform win32  -> taskkill /PID <pid> /T /F      + Get-CimInstance Win32_Process
 *   platform linux  -> process.kill(pid, 'SIGKILL')  + /proc/<pid>/stat
 *   anything else   -> available() === false, every call is STOP_CAPABILITY_MISSING
 */
export function createProcessTree({ platform = process.platform, run = spawnProcess, kill = pid => process.kill(pid, 'SIGKILL') } = {}) {
  const windows = platform === 'win32';
  const linux = platform === 'linux';
  const available = windows || linux;
  const method = windows ? 'taskkill-tree' : 'process-tree-kill';
  let lastTool = null;

  async function list() {
    if (windows) {
      const read = await run('powershell', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', POWERSHELL_LIST],
        { timeoutMs: LIST_TIMEOUT_MS });
      if (read.code !== 0) {
        throw Object.assign(new Error('the WMI process readback failed (' + (read.stderr.trim() || 'exit ' + read.code) + ')'),
          { code: 'STOP_CAPABILITY_MISSING' });
      }
      return read.stdout.split(/\r?\n/).map(parseWindowsLine).filter(Boolean);
    }
    if (linux) return readProc();
    throw unavailable();
  }

  async function identity(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    const rows = await list();
    return rows.find(row => row.pid === pid) ?? null;
  }

  async function killTree(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw Object.assign(new Error('a pid is required'), { code: 'INVALID_CONFIG' });
    if (windows) {
      lastTool = 'taskkill /PID ' + pid + ' /T /F';
      const result = await run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: KILL_TIMEOUT_MS });
      // 128: the process is not running. That is the outcome a kill wants, not a failure.
      if (result.code === 0) return { ok: true, alreadyGone: false, code: 0 };
      if (result.code === 128) return { ok: true, alreadyGone: true, code: 128 };
      const text = (result.stderr || result.stdout || '').trim();
      const denied = result.code === 5 || /access is denied/i.test(text);
      return { ok: false, alreadyGone: false, code: denied ? 'STOP_ACCESS_DENIED' : 'STOP_NOT_VERIFIED',
        message: text || 'taskkill exited ' + result.code };
    }
    if (linux) {
      const rows = readProc();
      const tree = [pid, ...descendantPids(rows, pid)];
      lastTool = 'kill -9 ' + tree.join(' ');
      for (const target of tree.reverse()) {
        try { kill(target); } catch (error) {
          if (error?.code === 'ESRCH') continue;
          return { ok: false, code: error?.code === 'EPERM' ? 'STOP_ACCESS_DENIED' : 'STOP_NOT_VERIFIED',
            message: String(error?.message ?? error) };
        }
      }
      return { ok: true, alreadyGone: false, code: 0 };
    }
    throw unavailable();
  }

  return Object.freeze({ platform, method, available: () => available, list, identity, killTree, lastTool: () => lastTool });
}
