import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Windows job objects for the offline runner.
 *
 * A suite is started by job-launcher.ps1, which joins a fresh job object (KILL_ON_JOB_CLOSE) and then starts the suite
 * command. Membership is inherited by every descendant at creation, so it does not depend on pids, creation times or
 * how often anything is sampled: a grandchild of a process that exited milliseconds ago is still in the job.
 *
 *   - when the suite's main process exits, the launcher reads the job's process list. Whatever is left is a leftover:
 *     it prints the pid and command line, terminates the job, and reports through a marker on stderr.
 *   - when the runner kills the launcher (timeout, interrupt), the job closes with it and the kernel kills the tree.
 *   - when the launcher cannot be built or used, the suite fails with "reaper unavailable"; there is no fallback.
 *
 * DSH_TEST_JOB_LAUNCHER exists only for the runner's own acceptance checks (a missing launcher is case 5).
 */

export const ORPHAN_MARKER = '##JOB-ORPHANS## ';
export const UNAVAILABLE_MARKER = '##JOB-UNAVAILABLE## ';
export const INCOMPLETE_MARKER = '##OUTPUT-INCOMPLETE## ';
export const EXIT_ORPHANS = 97;
export const EXIT_UNAVAILABLE = 98;

const POWERSHELL = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];

export const launcherScript = () => process.env.DSH_TEST_JOB_LAUNCHER ??
  fileURLToPath(new URL('./job-launcher.ps1', import.meta.url));

/** Compile the job API once per run; every launcher then loads the assembly instead of compiling again. */
export function buildJobApi(dll) {
  fs.mkdirSync(path.dirname(dll), { recursive: true });
  const result = spawnSync('powershell', [...POWERSHELL, launcherScript(), '-Build', dll], { encoding: 'utf8' });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    const text = String(result.stderr ?? '').trim() || String(result.stdout ?? '').trim();
    return { ok: false, error: text === '' ? 'launcher build exit ' + result.status : text };
  }
  if (!fs.existsSync(dll)) return { ok: false, error: 'the launcher wrote no assembly' };
  return { ok: true, error: null };
}

/** Win32 command-line quoting, the same rules node uses when it builds a child command line. */
export function quoteArg(arg) {
  if (arg === '') return '""';
  if (!/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const char of arg) {
    if (char === '\\') {
      slashes += 1;
      continue;
    }
    if (char === '"') {
      out += '\\'.repeat(slashes * 2 + 1) + '"';
      slashes = 0;
      continue;
    }
    out += '\\'.repeat(slashes) + char;
    slashes = 0;
  }
  return out + '\\'.repeat(slashes * 2) + '"';
}

export const commandLine = args => args.map(quoteArg).join(' ');

/** The launcher reads the command as JSON: no PowerShell argument parsing, no quoting surprises. */
export function writeSpec(file, { command, args, cwd, stdout, stderr }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ command, commandLine: commandLine(args), cwd, stdout, stderr }, null, 2));
  return file;
}

/**
 * An interrupted run keeps what the launchers had already written: copy each suite's output out of the scratch tree
 * before it is removed, so an interrupt does not throw the evidence away. Returns the directory, or null.
 */
export function preserveSuiteOutput(scratchDir, targetDir) {
  try {
    if (!fs.existsSync(scratchDir)) return null;
    fs.mkdirSync(targetDir, { recursive: true });
    for (const slug of fs.readdirSync(scratchDir)) {
      const from = path.join(scratchDir, slug);
      if (!fs.statSync(from).isDirectory()) continue;
      const to = path.join(targetDir, slug);
      fs.mkdirSync(to, { recursive: true });
      for (const name of ['stdout.log', 'stderr.log', 'job.json']) {
        if (fs.existsSync(path.join(from, name))) fs.copyFileSync(path.join(from, name), path.join(to, name));
      }
    }
    return targetDir;
  } catch {
    return null;
  }
}

/** The launcher copies the suite's output into these files; the runner reads them back after the suite ends. */
export function readSuiteOutput(spec) {
  const read = file => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  };
  try {
    const parsed = JSON.parse(fs.readFileSync(spec, 'utf8'));
    return read(parsed.stdout) + read(parsed.stderr);
  } catch {
    return '';
  }
}

export function startLauncher({ dll, spec }, options = {}) {
  return spawn('powershell', [...POWERSHELL, launcherScript(), '-Run', spec, '-Dll', dll], {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
}

/** Killing the launcher closes its job: KILL_ON_JOB_CLOSE is what terminates the tree. */
export function killLauncher(pid) {
  if (!pid) return true;
  const result = spawnSync('taskkill', ['/pid', String(pid), '/F'], { stdio: 'ignore' });
  return result.status === 0 || result.status === 128;
}

export function readMarkers(output) {
  const orphans = [];
  const unavailable = [];
  const incomplete = [];
  for (const line of output.split('\n')) {
    if (line.startsWith(ORPHAN_MARKER)) {
      try {
        const parsed = JSON.parse(line.slice(ORPHAN_MARKER.length));
        for (const row of Array.isArray(parsed) ? parsed : [parsed]) orphans.push(row);
      } catch {
        orphans.push({ pid: 0, command: '(unreadable marker) ' + line.slice(ORPHAN_MARKER.length) });
      }
    } else if (line.startsWith(UNAVAILABLE_MARKER)) {
      unavailable.push(line.slice(UNAVAILABLE_MARKER.length));
    } else if (line.startsWith(INCOMPLETE_MARKER)) {
      incomplete.push(line.slice(INCOMPLETE_MARKER.length));
    }
  }
  return { orphans, unavailable, incomplete };
}

/** Interrupt: kill each launcher; the job object does the rest. */
export function interruptLaunchers(active, log = () => {}) {
  const report = [];
  for (const [suiteId, pid] of active) {
    const killed = killLauncher(pid);
    report.push({ suiteId, pid, killed });
    log('runner: stopped ' + suiteId + ' (launcher pid ' + pid + ')' +
      (killed ? ' - the job closes with it' : ' - taskkill failed'));
  }
  active.clear();
  return report;
}
