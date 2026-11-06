import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, isSerial } from './manifest.mjs';
import { assertOffline, childEnv, digest, openPorts, portOwners, prepareLedger } from './guard.mjs';
import { buildJobApi, interruptLaunchers, killLauncher, preserveSuiteOutput, readMarkers, readSuiteOutput,
  startLauncher, writeSpec } from './job.mjs';
import { KEEP_RUNS, markFinished, pruneRuns, saveFailure, writeOwner, writeRunSummary } from './diagnostics.mjs';

/**
 * WP-1 of docs/refactor-20261026/20-M5-plan.md: the offline runner.
 *
 * The suite list is verification/runner/suites.json (see manifest.mjs); this file only decides HOW a suite runs:
 *
 *   phases    - a plain suite may run beside another one (up to --jobs). A suite that needs a root under runs/ shares
 *               the copied budget ledger, and a suite that binds ports or asserts about the operating system must not
 *               race anything, so those two groups run one at a time after the parallel phase.
 *   timeout   - per suite, from the manifest (DSH_TEST_TIMEOUT_MS overrides every suite, for diagnosis only).
 *   evidence  - success is exit code 0 AND every expect marker in the output ("zero tests, green run" is a failure).
 *   ledger    - runs/real-budget.json is hashed before and after; a change fails the run. Nothing else under runs/ is
 *               touched beyond the .test-scratch-* tree this run creates and removes.
 *   failures  - a bundle under <run>/diagnostics/<suite>/ with the full output, the metadata and the JSON artifacts;
 *               the last five run directories are kept.
 *   deep      - suites marked "deep": true (the mutation sweeps and the long retention runs) are skipped by default so
 *               npm test stays bounded; --only=<id> runs them and npm run test:deep runs only them. The skip is printed
 *               and repeated in the summary (deep_skipped=...), so a green default run never claims to have run them.
 *
 * npm test keeps producing the same evidence the old runner did; run-all.mjs stays for comparison until WP-3.
 */

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const runnerDir = path.join(repoRoot, 'verification', 'runner');
// DSH_TEST_MANIFEST exists for the runner's own acceptance checks (a fixture list); npm test never sets it.
const manifestPath = process.env.DSH_TEST_MANIFEST ?? path.join(runnerDir, 'suites.json');
const runsRoot = path.join(repoRoot, 'runs');
const guardedLedger = path.join(runsRoot, 'real-budget.json');
const scratchBase = path.join(repoRoot, 'verification', '.scratch');
const deepRecordPath = path.join(scratchBase, 'test-deep.json');

const argv = process.argv.slice(2);
const flagValue = name => {
  const hit = argv.find(arg => arg.startsWith(name + '='));
  return hit ? hit.slice(name.length + 1) : null;
};
const KNOWN = new Set(['--list', '--keep', '--print']);
for (const arg of argv) {
  if (arg.startsWith('--jobs=') || arg.startsWith('--only=') || KNOWN.has(arg)) continue;
  console.error('unknown argument ' + arg);
  process.exit(2);
}

const readNumber = (value, fallback, label) => {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    console.error(label + ' must be a positive integer, got ' + value);
    process.exit(2);
  }
  return parsed;
};

const jobs = readNumber(flagValue('--jobs') ?? process.env.DSH_TEST_JOBS ?? null,
  Math.max(1, Math.min(4, os.cpus().length - 1)), 'jobs');
const timeoutOverride = readNumber(process.env.DSH_TEST_TIMEOUT_MS ?? null, null, 'DSH_TEST_TIMEOUT_MS');
const only = flagValue('--only');
const onlyIds = only === null ? null : only.split(',').map(id => id.trim()).filter(Boolean);
const keep = argv.includes('--keep');

let suites;
try {
  suites = loadManifest(manifestPath, repoRoot, { timeoutMs: timeoutOverride });
  assertOffline(suites);
} catch (error) {
  console.error('runner: ' + error.message);
  process.exit(2);
}
// Every declared suite, before the default deep filter: --list shows them, and test:deep selects them by id.
const declared = suites;
const deepIds = declared.filter(suite => suite.deep).map(suite => suite.id);
if (onlyIds) {
  const unknown = onlyIds.filter(id => !suites.some(suite => suite.id === id));
  if (unknown.length > 0) {
    console.error('runner: unknown suite in --only: ' + unknown.join(', '));
    process.exit(2);
  }
  suites = suites.filter(suite => onlyIds.includes(suite.id));
} else {
  // Deep suites (the mutation sweeps and the long retention runs) are not part of npm test. npm run test:deep runs
  // them through this same runner, so the job object, timeout and diagnostics are identical.
  suites = suites.filter(suite => !suite.deep);
}
if (suites.length === 0) {
  console.error('FAIL: the suite list is empty; a run with zero suites is not a passing run');
  process.exit(1);
}
if (argv.includes('--list')) {
  for (const suite of declared) {
    console.log(suite.id.padEnd(34) + suite.layer.padEnd(12) + (suite.timeoutMs / 1000) + 's  ' +
      (suite.resources.length > 0 ? suite.resources.join('+') : '-') + (suite.deep ? '  deep' : ''));
  }
  process.exit(0);
}

const runId = 'run-' + new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15) +
  '-' + Date.now().toString(36).slice(-4);
const runDir = path.join(scratchBase, runId);
const scratchDir = path.join(runDir, 'scratch');
const runsScratch = path.join(runsRoot, '.test-scratch-' + Date.now());
const scratchLedger = path.join(runsScratch, 'real-budget.json');
const jobApiDll = path.join(scratchDir, 'job-api.dll');
// The run directory is created once the pre-flight passes: --list and a refused start must not leave an empty one
// behind, because the five-run retention would otherwise evict a real diagnostics bundle.

/** "test:deep" is recorded by WP-4; until then this only reads and reports what is on disk. */
function deepStatus() {
  if (!fs.existsSync(deepRecordPath)) return { fresh: false, line: 'test:deep: never run on this machine' };
  try {
    const record = JSON.parse(fs.readFileSync(deepRecordPath, 'utf8'));
    const at = Date.parse(record.finishedAt ?? '');
    if (!Number.isFinite(at)) return { fresh: false, line: 'test:deep: last record is unreadable (' + deepRecordPath + ')' };
    const hours = (Date.now() - at) / 3600000;
    const verdict = record.ok ? 'PASS' : 'FAIL';
    return {
      fresh: hours <= 24,
      line: 'test:deep: last run ' + new Date(at).toISOString() + ' ' + verdict + ' (' + hours.toFixed(1) + 'h ago)'
    };
  } catch (error) {
    return { fresh: false, line: 'test:deep: last record is unreadable (' + error.message + ')' };
  }
}

/** The launchers of the suites running right now, so an interrupt can close every job. */
const activeLaunchers = new Map();

/** Synchronous pause: a signal handler cannot await, and the pumps need a moment to flush what they have. */
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function interruptCleanup() {
  interruptLaunchers(activeLaunchers, line => console.error(line));
  // The scratch tree is deleted below: keep the suites' output and job specs first, and say where they went.
  pause(500);
  const kept = preserveSuiteOutput(scratchDir, path.join(runDir, 'interrupted'));
  if (kept) console.error('runner: interrupted output kept in ' + kept);
  markFinished(runDir);
  try {
    fs.rmSync(scratchDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    fs.rmSync(runsScratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch { /* best effort during shutdown */ }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.error('');
    console.error('runner: ' + signal + ' received; stopping ' + activeLaunchers.size + ' suite(s)');
    interruptCleanup();
    process.exit(130);
  });
}

// Test seam for the interrupt path, like DSH_TEST_MANIFEST: Windows cannot raise a real SIGINT in another process, so
// the runner raises its own and the handler body runs exactly as it would on Ctrl+C.
if (process.env.DSH_TEST_INTERRUPT_MS) {
  // The delay is measured from the first running suite, not from process start: a loaded machine can spend longer than
  // the delay in pre-flight, and an interrupt before any suite has written its job spec has no output to keep.
  const delay = Number(process.env.DSH_TEST_INTERRUPT_MS);
  const arm = () => {
    if (activeLaunchers.size === 0) { setTimeout(arm, 50); return; }
    setTimeout(() => process.emit('SIGINT'), delay);
  };
  setTimeout(arm, 0);
}

function layout(suite) {
  const slug = suite.id.replaceAll('/', '-');
  const base = suite.root === 'runs-scratch' ? runsScratch : scratchDir;
  return { slug, root: path.join(base, slug, 'root'), report: path.join(base, slug, 'report.json') };
}

async function runSuite(suite) {
  const startedAt = Date.now();
  const { slug, root, report } = layout(suite);
  const fill = value => value.replaceAll('{root}', root).replaceAll('{report}', report);
  const args = suite.entry.map(fill);
  const cwd = path.resolve(repoRoot, suite.cwd);
  const env = childEnv(process.env, {
    ledger: suite.root === 'runs-scratch' ? scratchLedger : null,
    runId
  });
  if (suite.root) fs.mkdirSync(path.dirname(root), { recursive: true });
  if (suite.root === 'runs-scratch') prepareLedger(guardedLedger, scratchLedger);

  const fail = (reason, extra = {}) => {
    const diagnostics = saveFailure({
      runDir,
      suiteId: suite.id,
      output: extra.output ?? reason,
      metadata: { reason, args, cwd, seconds: (Date.now() - startedAt) / 1000, ...extra.metadata },
      roots: [root]
    });
    return { id: suite.id, ok: false, reason: reason + '; diagnostics=' + diagnostics, exitCode: null,
      seconds: (Date.now() - startedAt) / 1000, diagnostics };
  };
  if (!fs.existsSync(cwd)) return fail('missing suite directory ' + suite.cwd);

  // The launcher joins a fresh job object and then starts the suite, so every descendant is in the job at creation.
  const spec = writeSpec(path.join(scratchDir, slug, 'job.json'), {
    command: process.execPath,
    args,
    cwd,
    stdout: path.join(scratchDir, slug, 'stdout.log'),
    stderr: path.join(scratchDir, slug, 'stderr.log')
  });
  let child;
  try {
    child = startLauncher({ dll: jobApiDll, spec }, { env });
  } catch (error) {
    return fail('synchronous spawn failure', { metadata: { spawnError: error.message } });
  }

  const launcherPid = child.pid;
  if (launcherPid) activeLaunchers.set(suite.id, launcherPid);
  let launcherOutput = '';
  child.stdout?.on('data', chunk => { launcherOutput += chunk; });
  child.stderr?.on('data', chunk => { launcherOutput += chunk; });
  let timedOut = false;
  let killStatus = 0;
  let drainTimer = null;
  // Killing the launcher closes its job; KILL_ON_JOB_CLOSE terminates everything the suite started.
  const timer = setTimeout(() => {
    timedOut = true;
    if (!killLauncher(launcherPid)) killStatus = 1;
  }, suite.timeoutMs);
  const exitCode = await new Promise(resolve => {
    child.once('error', error => { launcherOutput += 'SPAWN_ERROR: ' + error.message; });
    child.once('exit', code => {
      drainTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve(code);
      }, 2000);
    });
    child.once('close', code => {
      if (drainTimer) clearTimeout(drainTimer);
      resolve(code);
    });
  });
  clearTimeout(timer);
  child.stdout?.destroy();
  child.stderr?.destroy();
  if (launcherPid) activeLaunchers.delete(suite.id);
  if (timedOut) await new Promise(resolve => setTimeout(resolve, 1000));
  // The suite's own output was copied to files by the launcher; the launcher's stderr carries the markers.
  const output = readSuiteOutput(spec) + launcherOutput;
  const markers = readMarkers(output);

  const seconds = (Date.now() - startedAt) / 1000;
  const reasons = [];
  if (timedOut) reasons.push('timed out after ' + suite.timeoutMs + 'ms (job terminated)');
  if (killStatus !== 0) reasons.push('could not stop the launcher');
  if (markers.unavailable.length > 0) reasons.push('reaper unavailable: ' + markers.unavailable.join('; '));
  if (markers.orphans.length > 0) {
    const detail = markers.orphans.map(row => row.pid + ' ' + (row.command || '(unknown)')).join(' | ');
    reasons.push('left ' + markers.orphans.length + ' descendant process(es) behind: ' + detail +
      ' (terminated with the job)');
  }
  if (markers.incomplete.length > 0) reasons.push('output incomplete: ' + markers.incomplete.join('; '));
  if (markers.unavailable.length === 0 && markers.orphans.length === 0 && !timedOut && exitCode !== 0) {
    reasons.push('exit code ' + exitCode);
  }
  if (!output.trim()) reasons.push('no output at all');
  else if (!suite.expect.every(pattern => pattern.test(output))) {
    reasons.push('no pass evidence in output (expected ' + suite.expect.map(String).join(' + ') + ')');
  }
  if (reasons.length > 0) {
    return fail(reasons.join('; '), {
      output,
      metadata: { exitCode, timedOut, expect: suite.expect.map(String) }
    });
  }
  return { id: suite.id, ok: true, reason: '', exitCode, seconds, diagnostics: null };
}

async function runPhase(list, concurrency, results) {
  if (list.length === 0) return;
  let index = 0;
  const workers = [];
  for (let worker = 0; worker < Math.max(1, Math.min(concurrency, list.length)); worker += 1) {
    workers.push((async () => {
      while (index < list.length) {
        const suite = list[index];
        index += 1;
        const result = await runSuite(suite);
        results.push(result);
        const label = (result.ok ? 'PASS' : 'FAIL') + '  ' + suite.id.padEnd(32);
        console.log(label + result.seconds.toFixed(1) + 's' + (result.ok ? '' : '  ' + result.reason));
      }
    })());
  }
  await Promise.all(workers);
}

async function main() {
  // Ports 40290-40299 belong to the P4 and collaboration stages: if one is taken the run cannot be trusted at all.
  // Only a manifest that declares a port-using suite is checked; a fixture manifest (ports: false everywhere) neither
  // binds nor asserts those ports, so another suite holding them must not stop it from running.
  const usesPorts = suites.some(suite => suite.ports === true);
  // A socket of the suite that just finished can still be listening for a moment; a real service keeps listening.
  // Waiting a bounded ten seconds for the window to close is not a timeout on the run, and a taken port still refuses.
  const portDeadline = Date.now() + 10000;
  let occupied = usesPorts ? portOwners() : [];
  let accepting = usesPorts ? await openPorts() : [];
  while (usesPorts && (occupied.length > 0 || accepting.length > 0) && Date.now() < portDeadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
    occupied = portOwners();
    accepting = await openPorts();
  }
  if (occupied.length > 0 || accepting.length > 0) {
    console.error('runner: ports 40290-40299 are in use; refusing to start');
    for (const owner of occupied) {
      console.error('  ' + owner.port + '  pid ' + owner.pid + '  ' + owner.command);
    }
    for (const port of accepting.filter(port => !occupied.some(owner => owner.port === port))) {
      console.error('  ' + port + '  pid (unknown, no listening socket found by netstat)');
    }
    process.exit(1);
  }
  fs.mkdirSync(scratchDir, { recursive: true });
  writeOwner(runDir);
  const built = buildJobApi(jobApiDll);
  if (!built.ok) {
    console.error('runner: reaper unavailable: ' + built.error);
    process.exit(1);
  }
  console.log('runner: ' + suites.length + ' suites, jobs=' + jobs + ', run=' + runId +
    (deepIds.length > 0 && !onlyIds ? ', deep skipped: ' + deepIds.join(',') : ''));
  console.log('guarded ledger runs/real-budget.json sha256 before: ' + digest(guardedLedger));
  fs.mkdirSync(runsScratch, { recursive: true });
  const ledgerBefore = digest(guardedLedger);
  const results = [];
  const startedAt = Date.now();
  try {
    await runPhase(suites.filter(suite => !isSerial(suite)), jobs, results);
    await runPhase(suites.filter(isSerial), 1, results);
  } finally {
    if (!keep) {
      fs.rmSync(scratchDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      fs.rmSync(runsScratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }

  const ledgerAfter = digest(guardedLedger);
  console.log('guarded ledger runs/real-budget.json sha256 after:  ' + ledgerAfter);
  if (ledgerAfter !== ledgerBefore) {
    results.push({ id: 'runs/real-budget.json', ok: false, exitCode: null, seconds: 0,
      reason: 'guarded ledger changed during the run (' + ledgerBefore + ' -> ' + ledgerAfter + ')' });
  }
  const open = usesPorts ? await openPorts() : [];
  if (open.length > 0) {
    results.push({ id: 'ports 40290-40299', ok: false, exitCode: null, seconds: 0,
      reason: 'still listening after the run: ' + open.join(',') });
  }

  const order = new Map(suites.map((suite, index) => [suite.id, index]));
  results.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
  const width = Math.max(5, ...results.map(result => result.id.length)) + 2;
  console.log('');
  console.log('SUITE'.padEnd(width) + 'EXIT'.padEnd(6) + 'SECONDS'.padEnd(9) + 'STATUS');
  for (const result of results) {
    console.log(result.id.padEnd(width) + String(result.exitCode ?? '-').padEnd(6) +
      result.seconds.toFixed(1).padEnd(9) + (result.ok ? 'PASS' : 'FAIL'));
  }
  const failed = results.filter(result => !result.ok);
  for (const result of failed) console.log('FAILED ' + result.id + ': ' + result.reason);

  const deep = deepStatus();
  console.log('');
  console.log(deep.line + (deep.fresh ? '' : '  <- run npm run test:deep'));
  console.log('summary: suites=' + results.length + ' passed=' + (results.length - failed.length) +
    ' failed=' + failed.length + ' jobs=' + jobs + ' seconds=' + ((Date.now() - startedAt) / 1000).toFixed(1) +
    (deepIds.length > 0 && !onlyIds ? ' deep_skipped=' + deepIds.join(',') : ''));

  writeRunSummary(runDir, {
    runId,
    jobCount: jobs,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    ledger: { before: ledgerBefore, after: ledgerAfter },
    results: results.map(({ id, ok, seconds, exitCode, reason }) => ({ id, ok, seconds, exitCode, reason }))
  });
  // The run is over before anything is pruned: its own directory is finished, and a suite that started its own runner
  // handed that runner our id, so neither of us can delete the other.
  markFinished(runDir);
  pruneRuns(scratchBase, KEEP_RUNS, [runId, process.env.DSH_TEST_RUN_ID]);
  process.exitCode = failed.length === 0 ? 0 : 1;
  if (failed.length > 0) console.log('diagnostics: ' + path.join(runDir, 'diagnostics'));
}

await main();
