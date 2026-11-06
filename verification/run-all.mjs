import fs from 'node:fs';
import { saveFailure, spawnFailure } from './failure-diagnostics.mjs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import net from 'node:net';

/**
 * M0: one offline test entrance for the whole repository.
 *
 * Every suite below is a subprocess. Nothing here talks to a provider: the live gateway
 * (http://127.0.0.1:<gateway-port>) is never contacted, an inherited CLOSEOUT_PROVIDER_KEY is stripped before every
 * child starts, and every suite in the list is a fake/dry/in-process check that has been inspected as offline.
 *
 * The list is hard-coded on purpose. Discovery by filename could silently pick up a live experiment, so the
 * set of suites is a reviewed constant, and a suite file that disappears fails the run instead of shrinking it.
 */

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Per-suite wall clock. Override with DSH_TEST_TIMEOUT_MS (milliseconds). */
const timeoutMs = Number(process.env.DSH_TEST_TIMEOUT_MS ?? 600000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
  console.error('DSH_TEST_TIMEOUT_MS must be a positive integer number of milliseconds');
  process.exit(2);
}

/**
 * Scratch roots live inside the workspace because several suites assert write scope:
 * verification/real/scope.mjs (scopedRoot) and verification/run.mjs both refuse an absolute root outside
 * <path-to-dsh-v2.> They are created under verification/.scratch and removed at the end, so runs/ and
 * reports/ (the authoritative evidence of earlier phases) are never written to by this runner.
 */
const scratchRoot = path.resolve(
  process.env.DSH_TEST_SCRATCH ?? path.join(repoRoot, 'verification', '.scratch', 'run-all-' + Date.now()),
);

/**
 * The main regressions need a root under runs/, because the product code enforces it: packages/delivery git()
 * raises GIT_SCOPE outside runs/, verification/p4-run.mjs raises WRITE_SCOPE, and the P4 and real-provider
 * suites assert the same prefix themselves. They get one dedicated scratch tree, runs/.test-scratch-<timestamp>/,
 * which is the only thing this runner ever creates under runs/ and which it removes when the run ends. Nothing
 * else in runs/ is opened, written, renamed or deleted.
 *
 * runs/real-budget.json is the authoritative live budget ledger and must not change. Fake runs already write
 * <root>/fake-budget.json (verification/real/worker.mjs); dry runs only read. So the ledger is copied byte for
 * byte into the scratch and DSH_BUDGET_LEDGER points every child at that copy (a test-only override, honoured
 * only for non-live modes). The real file's sha256 is taken before the run and re-checked after it.
 */
const runsRoot = path.join(repoRoot, 'runs');
const runsScratch = path.join(runsRoot, '.test-scratch-' + Date.now());
const guardedLedger = path.join(runsRoot, 'real-budget.json');
const scratchLedger = path.join(runsScratch, 'real-budget.json');
let runsScratchReady = false;

function ledgerDigest() {
  try {
    return createHash('sha256').update(fs.readFileSync(guardedLedger)).digest('hex');
  } catch (error) {
    return error.code === 'ENOENT' ? 'missing' : 'unreadable:' + error.code;
  }
}

function prepareRunsScratch() {
  if (runsScratchReady) return;
  fs.mkdirSync(runsScratch, { recursive: true });
  if (fs.existsSync(guardedLedger)) fs.copyFileSync(guardedLedger, scratchLedger);
  runsScratchReady = true;
}

import { suites } from './runner/run-all-suites.mjs';


const keepScratch = process.env.DSH_TEST_KEEP_SCRATCH === '1';

/** Collect output, keeping a bounded tail so one noisy suite cannot exhaust memory. */
function collector() {
  let text = '';
  return {
    write(chunk) {
      text += chunk;
      // Full output is retained for the durable failure bundle, never just the summary tail.
    },
    get value() {
      return text;
    },
  };
}

/**
 * Kill a suite and everything it started. On Windows a plain child.kill() leaves grandchildren (hosts,
 * workers, listeners) alive and holding ports, so the tree is killed with taskkill /T /F; elsewhere the child
 * is spawned detached and its process group is signalled.
 */
function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

async function runSuite(suite) {
  const startedAt = Date.now();
  const slug = suite.id.replaceAll('/', '-');
  const base = suite.rootBase === 'runs' ? runsScratch : scratchRoot;
  if (suite.rootBase === 'runs') prepareRunsScratch();
  const paths = {
    root: path.join(base, slug, 'root'),
    report: path.join(base, slug, 'report.json'),
  };
  const fill = value => value.replaceAll('{root}', paths.root).replaceAll('{report}', paths.report);
  const args = suite.args.map(fill);
  if (args.includes('--test') && !args.some(a => a.startsWith('--test-concurrency='))) args.splice(1, 0, '--test-concurrency=1');
  const cwd = suite.cwd ? path.join(repoRoot, suite.cwd) : repoRoot;
  const env = { ...process.env };
  // Offline guarantee: no suite may pick up a live provider key from the caller's environment.
  delete env.CLOSEOUT_PROVIDER_KEY;
  // Suites that boot the real harness read the budget ledger: point them at the scratch copy, never the original.
  if (suite.rootBase === 'runs') env.DSH_BUDGET_LEDGER = scratchLedger;

  const fail = (reason,error=null) => ({ id: suite.id, ok: false, reason, exitCode: null, seconds: 0, tail: '',
    diagnostics:saveFailure({label:suite.id,output:reason,error,metadata:{args,cwd,reason},roots:[paths.root]}) });

  if (!fs.existsSync(cwd)) return fail('missing suite directory ' + cwd);
  const script = suite.args[0];
  if (script.endsWith('.mjs') && !fs.existsSync(path.join(repoRoot, script))) return fail('missing suite file ' + script);

  if (suite.needsRoot) fs.mkdirSync(path.dirname(paths.root), { recursive: true });

  let child;
  try {child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });}catch(error){return fail('synchronous spawn failure',error);}
  const output = collector();
  child.stdout?.on('data', chunk => output.write(String(chunk)));
  child.stderr?.on('data', chunk => output.write(String(chunk)));

  let timedOut = false, spawnError = null;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, timeoutMs);

  let incompleteOutput=false;
  const exitCode = await new Promise(resolve => {
    let drainTimer;
    child.once('error', error => { spawnError=error;output.write('SPAWN_ERROR: '+JSON.stringify(spawnFailure(error))); });
    child.once('exit', code => {
      drainTimer=setTimeout(()=>{
        incompleteOutput=true;killTree(child);child.stdout?.destroy();child.stderr?.destroy();resolve(code);
      },2000);
    });
    child.once('close',code=>{clearTimeout(drainTimer);resolve(code);});
  });
  clearTimeout(timer);
  // A killed tree may still have a grandchild holding the pipes; do not wait on stream close.
  child.stdout?.destroy();
  child.stderr?.destroy();

  const seconds = (Date.now() - startedAt) / 1000;
  const text = output.value;
  const reasons = [];
  if(incompleteOutput)reasons.push('output pipes did not close after exit: capture incomplete');
  if (timedOut) reasons.push('timed out after ' + timeoutMs + 'ms (process tree killed)');
  if (exitCode !== 0) reasons.push('exit code ' + exitCode);
  if (!text.trim()) reasons.push('no output at all');
  else if (!suite.expect.every(pattern => pattern.test(text))) {
    reasons.push('no pass evidence in output (expected ' + suite.expect.map(String).join(' + ') + ')');
  }

  return {
    id: suite.id,
    ok: reasons.length === 0,
    reason: reasons.join('; '),
    exitCode,
    seconds,
    diagnostics: reasons.length ? saveFailure({ label: suite.id, output: text, error: spawnError, metadata: { exitCode, reasons, args, cwd }, roots: [paths
          .root] }) : null,
    tail: text.trim().split(/\r?\n/).slice(-12).join('\n'),
  };
}

function cleanup() {
  if (keepScratch) {
    console.log('scratch kept at ' + scratchRoot + (runsScratchReady ? ' and ' + runsScratch : ''));
    return;
  }
  try {
    fs.rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    const parent = path.dirname(scratchRoot);
    if (parent !== repoRoot && fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
  } catch (error) {
    console.log('scratch cleanup failed (' + error.message + '); remove ' + scratchRoot);
  }
  if (runsScratchReady) {
    // Never let a cleanup path escape the one directory this runner created under runs/.
    if (!runsScratch.startsWith(path.join(runsRoot, '.test-scratch-'))) {
      console.log('refusing to remove unexpected path ' + runsScratch);
      return;
    }
    try {
      fs.rmSync(runsScratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      console.log('runs scratch cleanup failed (' + error.message + '); remove ' + runsScratch);
    }
  }
}

/** Ports the P4 and collaboration harnesses may bind; every one must be closed after the run. */
async function openPorts() {
  const ports = Array.from({ length: 10 }, (_, offset) => 40290 + offset);
  const results = await Promise.all(ports.map(port => new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const settle = open => { socket.destroy(); resolve(open ? port : null); };
    socket.setTimeout(1000);
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.once('timeout', () => settle(false));
  })));
  return results.filter(port => port !== null);
}

async function main() {
  if (suites.length === 0) {
    console.error('FAIL: the offline suite list is empty; a run with zero suites is not a passing run');
    process.exit(1);
  }
  fs.mkdirSync(scratchRoot, { recursive: true });
  console.log('offline suites: ' + suites.length + ' (timeout ' + timeoutMs + 'ms each, scratch ' + scratchRoot + ')');

  const ledgerBefore = ledgerDigest();
  console.log('guarded ledger runs/real-budget.json sha256 before: ' + ledgerBefore);

  const results = [];
  try {
    for (const suite of suites) {
      process.stdout.write('running ' + suite.id + ' ... ');
      const result = await runSuite(suite);
      if (result.ok && suite.ports) {
        const open = await openPorts();
        if (open.length > 0) {
          result.ok = false;
          result.reason = 'ports still listening after the suite: ' + open.join(',');
        }
      }
      if(!result.ok && !result.diagnostics)result.diagnostics=saveFailure({label:result.id,output:result.tail??'',metadata:{reason:result.reason,exitCode:result
            .exitCode}});
      results.push(result);
      console.log((result.ok ? 'PASS' : 'FAIL') + ' (' + result.seconds.toFixed(1) + 's)');
    }
  } finally {
    cleanup();
  }

  const ledgerAfter = ledgerDigest();
  console.log('guarded ledger runs/real-budget.json sha256 after:  ' + ledgerAfter);
  if (ledgerAfter !== ledgerBefore) {
    results.push({
      id: 'runs/real-budget.json',
      ok: false,
      reason: 'guarded ledger changed during the run (' + ledgerBefore + ' -> ' + ledgerAfter + ')',
      exitCode: null,
      seconds: 0,
      tail: '',
    });
  }
  const stillOpen = await openPorts();
  if (stillOpen.length > 0) {
    results.push({
      id: 'ports 40290-40299',
      ok: false,
      reason: 'still listening after the run: ' + stillOpen.join(','),
      exitCode: null,
      seconds: 0,
      tail: '',
    });
  }

  const idWidth = Math.max(5, ...results.map(r => r.id.length)) + 2;
  const exitWidth = 6;
  const secondWidth = 9;
  const pad = (value, width) => String(value).padEnd(width);
  console.log('');
  console.log(pad('SUITE', idWidth) + pad('EXIT', exitWidth) + pad('SECONDS', secondWidth) + 'STATUS');
  for (const r of results) {
    console.log(
      pad(r.id, idWidth) + pad(r.exitCode === null ? '-' : r.exitCode, exitWidth) +
      pad(r.seconds.toFixed(1), secondWidth) + (r.ok ? 'PASS' : 'FAIL'),
    );
  }
  const failed = results.filter(r => !r.ok);
  for(const result of failed)if(!result.diagnostics)result.diagnostics=saveFailure({label:result.id,output:result.tail??'',metadata:{reason:result.reason,
        exitCode:result.exitCode}});
  for (const r of failed) {
    console.log('');
    console.log('FAILED ' + r.id + ': ' + r.reason + (r.diagnostics ? '; diagnostics=' + r.diagnostics : ''));
    if (r.tail) console.log(r.tail.split('\n').map(line => '    ' + line).join('\n'));
  }
  console.log('');
  console.log('summary: suites=' + results.length + ' passed=' + (results.length - failed.length) + ' failed=' + failed.length);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

await main();
