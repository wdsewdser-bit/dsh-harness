import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildJobApi, interruptLaunchers, killLauncher, preserveSuiteOutput, startLauncher, writeSpec } from './job.mjs';
import { processStart, pruneRuns } from './diagnostics.mjs';
import { processTable } from './guard.mjs';

/**
 * The process-leak shapes from the WP-1 review, now that the runner uses Windows job objects instead of sampling.
 *
 *   1. suite -> listener, the suite exits at once: the job still holds the listener;
 *   2. suite -> sleeper, no port involved: a leftover that binds nothing is found just the same;
 *   3. timeout: the runner kills the launcher, KILL_ON_JOB_CLOSE takes the tree with it;
 *   4. interrupt: the handler body closes the job of every active suite;
 *   5. launcher unavailable: the run fails with "reaper unavailable", it does not pass quietly.
 *
 * Cases 1-3 and 5 go through run.mjs (the real runner); case 4 calls interruptLaunchers, the exact function the
 * SIGINT/SIGTERM handler calls, because Windows cannot raise a console control event in another process from Node.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const PORT = 40290;
const fixture = name => path.join(here, 'fixtures', name);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-job-'));
after(() => fs.rmSync(work, { recursive: true, force: true }));

const portOpen = () => new Promise(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port: PORT });
  const settle = open => { socket.destroy(); resolve(open); };
  socket.setTimeout(500);
  socket.once('connect', () => settle(true));
  socket.once('error', () => settle(false));
  socket.once('timeout', () => settle(false));
});

async function until(check, what, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw Error('timed out waiting for ' + what);
}

const fixturePattern = /orphan-listener\.mjs|orphan-port\.mjs|orphan-sleeper-parent\.mjs|interrupt-parent\.mjs|job-launcher\.ps1/;
function leftovers() {
  try {
    return processTable()
      .filter(row => fixturePattern.test(row.command) && !/job-launcher\.ps1/.test(row.command))
      .map(row => row.pid + ': ' + row.command);
  } catch {
    return [];
  }
}

const runManifest = (name, extraEnv = {}) => spawnSync(process.execPath, ['verification/runner/run.mjs', '--jobs=1'], {
  cwd: repoRoot,
  encoding: 'utf8',
  timeout: 180000,
  env: { ...process.env, DSH_TEST_MANIFEST: fixture(name), ...extraEnv }
});
const runFixtureManifest = extraEnv => runManifest('job-manifest.json', extraEnv);

test('leftovers from a suite that exits at once are found in the job and killed', async () => {
  assert.equal(await portOpen(), false, 'port ' + PORT + ' is already taken before the fixtures start');
  const result = runFixtureManifest({});
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /FAILED fixture\/port: left 1 descendant process\(es\) behind: \d+ .*orphan-listener\.mjs/);
  assert.match(output, /FAILED fixture\/sleeper: left 1 descendant process\(es\) behind: \d+ .*setTimeout/);
  assert.match(output, /FAILED fixture\/timeout: timed out after 4000ms/);
  // The inherited pipe stays open for as long as the descendant lives: the leftover check must not wait for EOF.
  assert.match(output, /FAILED fixture\/inherit: left 1 descendant process\(es\) behind: \d+ .*setTimeout/);
  assert.doesNotMatch(output, /FAILED fixture\/inherit: timed out/);
  assert.match(output, /summary: suites=4 passed=0 failed=4/);
  assert.doesNotMatch(output, /still listening after the run/, 'the job must leave no listener behind');
  await until(async () => (await portOpen()) === false, 'port ' + PORT + ' to be released');
  assert.deepEqual(leftovers(), [], 'no fixture process may survive the job');
});

test('an interrupt closes the job of the active suite', async () => {
  assert.equal(await portOpen(), false, 'port ' + PORT + ' is already taken before the fixture starts');
  const dll = path.join(work, 'job-api.dll');
  const built = buildJobApi(dll);
  assert.equal(built.ok, true, built.error ?? 'the job api must build');
  const spec = writeSpec(path.join(work, 'interrupt.json'), {
    command: process.execPath,
    args: [fixture('interrupt-parent.mjs'), String(PORT)],
    cwd: repoRoot,
    stdout: path.join(work, 'interrupt-out.log'),
    stderr: path.join(work, 'interrupt-err.log')
  });
  const child = startLauncher({ dll, spec });
  try {
    await until(portOpen, 'the fixture to bind ' + PORT);
    const active = new Map([['fixture/interrupt', child.pid]]);
    const lines = [];
    const report = interruptLaunchers(active, line => lines.push(line));
    assert.equal(active.size, 0, 'an interrupt leaves no active suite behind');
    assert.equal(report.length, 1);
    assert.equal(report[0].killed, true);
    assert.match(lines[0], /^runner: stopped fixture\/interrupt \(launcher pid \d+\)/);
    assert.match(lines[0], /the job closes with it/);
    await until(async () => (await portOpen()) === false, 'port ' + PORT + ' to be released');
    assert.deepEqual(leftovers(), [], 'no fixture process may survive the interrupt');
  } finally {
    killLauncher(child.pid);
  }
});

test('an interrupted run keeps the suite output outside the scratch tree', () => {
  const scratch = path.join(work, 'scratch');
  fs.mkdirSync(path.join(scratch, 'fixture-port'), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'fixture-port', 'stdout.log'), 'pass 1\nfail 0\n');
  fs.writeFileSync(path.join(scratch, 'fixture-port', 'job.json'), '{}');
  const target = path.join(work, 'interrupted');
  assert.equal(preserveSuiteOutput(scratch, target), target);
  assert.equal(fs.readFileSync(path.join(target, 'fixture-port', 'stdout.log'), 'utf8'), 'pass 1\nfail 0\n');
  assert.ok(fs.existsSync(path.join(target, 'fixture-port', 'job.json')), 'the job spec is kept with the output');
  fs.rmSync(scratch, { recursive: true, force: true });
  assert.ok(fs.existsSync(path.join(target, 'fixture-port', 'stdout.log')), 'the kept copy survives the cleanup');
});

test('an interrupt keeps the running suite output and prints where', () => {
  const result = runFixtureManifest({ DSH_TEST_INTERRUPT_MS: '1500' });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 130, output);
  assert.match(output, /SIGINT received/);
  const kept = output.match(/interrupted output kept in (.+)/);
  assert.ok(kept, 'the runner must say where the interrupted output went');
  const dir = kept[1].trim();
  assert.ok(fs.existsSync(dir), 'the kept directory exists: ' + dir);
  assert.ok(fs.readdirSync(dir).length > 0, 'at least one suite kept its output');
  assert.deepEqual(leftovers(), [], 'the interrupt must leave no fixture process behind');
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeRun(base, name, { age = 0, owner = null, finished = false } = {}) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  if (owner) fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify(owner));
  if (finished) fs.writeFileSync(path.join(dir, 'finished'), new Date().toISOString());
  if (age > 0) {
    const when = new Date(Date.now() - age);
    fs.utimesSync(dir, when, when);
  }
  return dir;
}

test('retention keeps sibling and ancestor runs whose owner is alive', () => {
  const base = path.join(work, 'retention-live');
  const owner = { pid: process.pid, created: processStart() };
  const sibling = makeRun(base, 'run-sibling', { age: 3600000, owner });
  const ancestor = makeRun(base, 'run-ancestor', { age: 3600000, owner });
  assert.deepEqual(pruneRuns(base, 0, [], { graceMs: 0 }), []);
  assert.ok(fs.existsSync(sibling) && fs.existsSync(ancestor), 'a live run is never pruned');
});

test('retention removes finished runs and crashed runs past the grace', () => {
  const base = path.join(work, 'retention-dead');
  const deadPid = spawnSync(process.execPath, ['-e', '0']).pid;
  const finished = makeRun(base, 'run-finished', { finished: true });
  const crashed = makeRun(base, 'run-crashed', { age: 3600000, owner: { pid: deadPid, created: processStart() } });
  const young = makeRun(base, 'run-young', { owner: { pid: deadPid, created: processStart() } });
  const pruned = pruneRuns(base, 0, [], { graceMs: 60000 });
  assert.equal(fs.existsSync(finished), false, 'a finished run is pruned');
  assert.equal(fs.existsSync(crashed), false, 'a crashed run past the grace is pruned');
  assert.ok(fs.existsSync(young), 'a crashed run inside the grace is kept');
  assert.equal(pruned.length, 2);
});

test('a directory that vanishes during retention does not throw', t => {
  const base = path.join(work, 'retention-vanish');
  const vanishing = makeRun(base, 'run-vanishing', { finished: true });
  const other = makeRun(base, 'run-other', { finished: true });
  const realStat = fs.statSync;
  let tripped = false;
  t.mock.method(fs, 'statSync', (target, ...rest) => {
    if (!tripped && String(target) === vanishing) {
      tripped = true;
      const error = new Error('gone');
      error.code = 'ENOENT';
      throw error;
    }
    return realStat(target, ...rest);
  });
  let pruned = null;
  assert.doesNotThrow(() => { pruned = pruneRuns(base, 0, []); });
  assert.ok(tripped, 'the disappearing directory was actually stat-ed');
  assert.ok(Array.isArray(pruned));
  assert.equal(fs.existsSync(other), false, 'the other finished run is still pruned');
});

test('a process list larger than the buffer grows instead of failing', () => {
  const result = runManifest('job-buffer-manifest.json', { DSH_TEST_JOB_SMALL_BUFFER: '1' });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.doesNotMatch(output, /reaper unavailable/, 'ERROR_MORE_DATA must grow the buffer, not fail the query');
  const match = output.match(/left 2 descendant process\(es\) behind: (\d+) .*?\| (\d+) /);
  assert.ok(match, output);
  assert.notEqual(match[1], match[2], 'both descendants are listed');
});

test('a capture that did not finish fails the suite as incomplete', () => {
  const result = runManifest('job-inert-manifest.json', { DSH_TEST_JOB_PUMP_FAULT: '1' });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /FAILED fixture\/inert: output incomplete: .*injected pump failure/);
});

test('a job query that fails is a failed suite, not an empty job', () => {
  const result = runFixtureManifest({ DSH_TEST_JOB_QUERY_FAULT: '1' });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /FAILED fixture\/port: reaper unavailable/);
  assert.doesNotMatch(output, /PASS\s+fixture\//);
});

test('a launcher that cannot be built fails the run instead of passing quietly', () => {
  const result = runFixtureManifest({ DSH_TEST_JOB_LAUNCHER: path.join(work, 'missing-launcher.ps1') });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /reaper unavailable/);
  assert.doesNotMatch(result.stdout, /PASS\s+fixture\//);
});
