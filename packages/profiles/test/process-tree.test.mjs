import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { defaultQueryProcess, isPidAlive, runProcessTree, terminateRootProcess, writeProcessIdentity } from '../test-support/process-tree.mjs';
import { runControlled } from '../test-support/controlled-run.mjs';
import { isInfrastructureFailure, runMutant } from '../test-support/mutant-policy.mjs';
import { cleanupOrThrow } from '../test-support/temp-roots.mjs';

const fixture = fileURLToPath(new URL('../test-support/borrow-process-tree-fixture.mjs', import.meta.url));
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'borrow-process-tree-'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitGone = async pid => { for (let i = 0; i < 100 && isPidAlive(pid); i += 1) await wait(25); };

test('controlled run: terminated:false fails before cleanup and retains the root', async () => {
  const calls = [];
  await assert.rejects(runControlled({ tempRoot: 'retained', spawnTree: async () => ({ terminated: false, failure: 'test unconfirmed' }),
    cleanup: dirs => calls.push(dirs) }), error => error.code === 'TERMINATION_UNCONFIRMED' && /unconfirmed/.test(error.message));
  assert.deepEqual(calls, []);
  const cleaned = [];
  assert.deepEqual(await runControlled({ tempRoot: 'cleaned', spawnTree: async () => ({ terminated: true }),
    cleanup: dirs => cleaned.push(dirs) }), { terminated: true });
  assert.deepEqual(cleaned, [['cleaned']]);
});

test('process tree: never-ready uses ready deadline and controlled termination', async () => {
  const root = temp();
  try {
    const result = await runProcessTree({ file: fixture, scriptArgs: ['hang'], readyFile: path.join(root, 'never-ready'),
      readyTimeoutMs: 150, confirmTimeoutMs: 5000, timeoutMs: 10000,
      env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root } });
    assert.match(result.error?.message ?? '', /ready file was not created/);
    assert.equal(result.timedOut, false);
    assert.equal(result.terminated, true, JSON.stringify(result));
    assert.equal(result.termination?.ok, true);
  } finally { cleanupOrThrow([root]); }
});

test('process tree: a failed termination command is reported and an unconfirmed exit stays unconfirmed', async () => {
  const root = temp();
  let result;
  let failedChild = null;
  try {
    result = await runProcessTree({ file: fixture, scriptArgs: ['hang'], timeoutMs: 100, confirmTimeoutMs: 150,
      terminateRoot: child => { failedChild = child; return { ok: false, status: 7, signal: null, error: Error('taskkill failed') }; },
      env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root } });
    assert.equal(result.terminated, false);
    assert.equal(result.termination?.status, 7);
    assert.match(result.termination?.error?.message ?? '', /taskkill failed/);
    assert.equal(result.failure, '终止未确认: timeout');
  } finally {
    if (!failedChild) console.error('清理未确认: no captured ChildProcess; retaining ' + root);
    else {
      terminateRootProcess(failedChild);
      await waitGone(failedChild.pid);
      cleanupOrThrow([root]);
    }
  }
});

test('process tree: exit confirmation deadline reports pending records and does not claim termination', async () => {
  const root = temp();
  const pidFile = path.join(root, 'ghost.pid');
  try {
    const result = await runProcessTree({ file: fixture, scriptArgs: ['ghost', pidFile], timeoutMs: 100, confirmTimeoutMs: 150,
      pidFiles: [pidFile], queryProcess: pid => pid === 777777 ? { pid, startTime: 'old' } : defaultQueryProcess(pid),
      env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root } });
    assert.equal(result.terminated, false);
    assert.equal(result.failure, '终止未确认: timeout');
    assert(result.pending.some(record => record.pid === 777777), JSON.stringify(result.pending));
  } finally { cleanupOrThrow([root]); }
});

test('process tree: a reused PID is treated as exited and is never a termination target', async () => {
  const root = temp();
  const pidFile = path.join(root, 'reused.pid');
  const terminated = [];
  try {
    const result = await runProcessTree({ file: fixture, scriptArgs: ['ghost', pidFile], timeoutMs: 100, confirmTimeoutMs: 5000,
      pidFiles: [pidFile], terminateRoot: child => { terminated.push(child.pid); return terminateRootProcess(child); },
      queryProcess: pid => pid === 777777 ? { pid, startTime: 'new' } : defaultQueryProcess(pid),
      env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root } });
    assert.equal(result.terminated, true, JSON.stringify(result));
    assert.deepEqual(terminated, [result.pid]);
    assert.equal(terminated.includes(777777), false);
  } finally { cleanupOrThrow([root]); }
});

test('process tree: exit check and termination share one synchronous fragment', async () => {
  const root = temp();
  const calls = [];
  try {
    const result = await runProcessTree({ file: fixture, scriptArgs: ['exit-soon'], timeoutMs: 1, confirmTimeoutMs: 5000,
      terminateRoot: child => { calls.push({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode });
        return terminateRootProcess(child); },
      env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root } });
    assert.equal(calls.length, 1, JSON.stringify(result));
    assert.equal(calls[0].pid, result.pid);
    assert.equal(calls[0].exitCode, null, 'the exit event must not be dispatched before termination');
    assert.equal(calls[0].signalCode, null);
    assert.equal(result.terminated, true, JSON.stringify(result));
  } finally { cleanupOrThrow([root]); }
});

test('process tree: a root that already exited is never a termination target', async () => {
  const root = temp();
  let calls = 0;
  try {
    const result = await runProcessTree({ file: fixture, scriptArgs: ['exit'], timeoutMs: 5000, confirmTimeoutMs: 5000,
      terminateRoot: () => { calls += 1; return { ok: true, status: 0, signal: null, error: null }; },
      env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root } });
    assert.equal(calls, 0, 'a root that already exited must not be terminated by PID');
    assert.equal(result.termination?.skipped, true, JSON.stringify(result));
    assert.equal(result.terminated, true, JSON.stringify(result));
  } finally { cleanupOrThrow([root]); }
});

test('process tree: progress keeps a slow run alive, silence stops it, and every stop reports a status', async () => {
  const root = temp();
  try {
    // 1.5s of output with a 0.5s idle budget: progress resets the watchdog, so a slow run is never mistaken for a hung one.
    const slow = await runProcessTree({ file: fixture, scriptArgs: ['slow', '1500'], idleTimeoutMs: 500, confirmTimeoutMs: 5000,
      env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root } });
    assert.equal(slow.status, 0, JSON.stringify(slow));
    assert.equal(slow.stalled, false);
    // The same tree, stopped on purpose: the status is still reported instead of an undefined "launcher never answered".
    const killed = await runProcessTree({ file: fixture, scriptArgs: ['slow', '5000'], timeoutMs: 200, confirmTimeoutMs: 5000,
      env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root } });
    assert.equal(killed.timedOut, true, JSON.stringify(killed));
    assert.notEqual(killed.status, undefined, 'a stopped run reports a status, never undefined');
    // No output at all: the idle criterion stops it and says so.
    const silent = await runProcessTree({ file: fixture, scriptArgs: ['silent', '10000'], idleTimeoutMs: 300, confirmTimeoutMs: 5000,
      env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root } });
    assert.equal(silent.stalled, true, JSON.stringify(silent));
    assert.equal(silent.terminated, true, JSON.stringify(silent));
    assert.notEqual(silent.status, undefined, 'a stalled run reports a status, never undefined');
  } finally { cleanupOrThrow([root]); }
});

test('process tree: a pid file carries the writer creation time', async () => {
  const root = temp();
  const file = path.join(root, 'self.pid');
  try {
    writeProcessIdentity(file);
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(value.pid, process.pid);
    assert.equal(typeof value.startTime, 'string');
    assert(value.startTime.length > 0);
    assert.equal(value.source, 'estimated');
  } finally { cleanupOrThrow([root]); }
});

test('process tree: confirmation queries receive the remaining budget', async () => {
  const root = temp();
  const pidFile = path.join(root, 'ghost.pid');
  const budgets = [];
  const started = Date.now();
  try {
    const result = await runProcessTree({ file: fixture, scriptArgs: ['ghost', pidFile], timeoutMs: 100, confirmTimeoutMs: 120,
      pidFiles: [pidFile],
      queryProcess: async (pid, options = {}) => {
        if (pid !== 777777) return { pid, startTime: 'root' };
        budgets.push(options.timeoutMs);
        await wait(80);
        return { pid, startTime: 'old' };
      },
      env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root } });
    assert.equal(result.terminated, false);
    assert(result.pending.some(record => record.pid === 777777), JSON.stringify(result.pending));
    assert(budgets.length >= 1);
    for (const budget of budgets) { assert(Number.isFinite(budget)); assert(budget > 0); assert(budget <= 120); }
    assert(Date.now() - started < 800, 'each query must consume the remaining confirmation budget');
  } finally { cleanupOrThrow([root]); }
});

test('process tree: an estimated start time mismatch never proves exit', async () => {
  const root = temp();
  const pidFile = path.join(root, 'estimated.pid');
  let cleaned = 0;
  try {
    await assert.rejects(runControlled({
      tempRoot: root, file: fixture, scriptArgs: ['ghost-estimated', pidFile],
      timeoutMs: 100, confirmTimeoutMs: 200, pidFiles: [pidFile],
      queryProcess: pid => pid === 777777 ? { pid, startTime: '2026-11-03T13:00:00.000Z' } : null,
      cleanup: () => { cleaned += 1; }
    }), error => error.code === 'TERMINATION_UNCONFIRMED');
    assert.equal(cleaned, 0, 'an unconfirmed identity must not release the temp root');
    assert.equal(fs.existsSync(root), true);
  } finally { cleanupOrThrow([root]); }
});

test('process tree: the termination entry rejects a bare PID stand-in', () => {
  let calls = 0;
  assert.throws(() => terminateRootProcess({ pid: 99999999 }, { terminate: () => { calls += 1; } }),
    /real ChildProcess/);
  assert.equal(calls, 0);
});

test('process tree: failed cleanup after the root exited sends no termination command', async () => {
  const root = temp();
  const child = spawn(process.execPath, [fixture, 'exit'], { stdio: 'ignore', windowsHide: true,
    detached: process.platform !== 'win32', env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root } });
  try {
    await once(child, 'exit');
    let calls = 0;
    const result = terminateRootProcess(child, { terminate: () => { calls += 1; return { ok: true, status: 0, signal: null, error: null }; } });
    assert.equal(calls, 0, 'an already exited root must not be terminated again');
    assert.equal(result.skipped, true);
    assert.equal(result.status, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    cleanupOrThrow([root]);
  }
});

test('process tree: continuous output outlives the old budget, and stalled/timedOut stay separate', async () => {
  const root = temp();
  try {
    // 2.5s of steady output with a 0.5s idle budget and a generous hard cap: this is the regression for the removed
    // implicit 60s total cap. The run lasts far longer than the idle budget and still completes with its own status.
    const started = Date.now();
    const slow = await runProcessTree({ file: fixture, scriptArgs: ['slow', '2500'], idleTimeoutMs: 500, timeoutMs: 30000,
      confirmTimeoutMs: 5000, env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root } });
    const elapsed = Date.now() - started;
    assert.equal(slow.status, 0, JSON.stringify(slow));
    assert.equal(slow.stalled, false);
    assert.equal(slow.timedOut, false);
    assert.equal(slow.terminated, true);
    assert(elapsed >= 2400, 'the run outlived the old idle budget: ' + elapsed + 'ms');
    // A tree that never stops producing output is stopped by the hard cap and says timedOut -- never stalled.
    const capped = await runProcessTree({ file: fixture, scriptArgs: ['slow', '10000'], timeoutMs: 400, confirmTimeoutMs: 5000,
      env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root } });
    assert.equal(capped.timedOut, true, JSON.stringify(capped));
    assert.equal(capped.stalled, false);
    assert.equal(capped.terminated, true);
    assert.notEqual(capped.status, undefined, 'a capped run reports a status, never undefined');
  } finally { cleanupOrThrow([root]); }
});

test('mutant retry policy: a survivor is never retried, and only identified infrastructure failures are', async () => {
  const survivor = { status: 0, signal: null, stdout: '# pass 1\n# fail 0', stderr: '', stalled: false, timedOut: false, terminated: true };
  let calls = 0;
  const first = await runMutant(async () => { calls += 1; return survivor; });
  assert.equal(calls, 1, 'status 0 is a surviving mutant, not an infrastructure accident');
  assert.equal(first.result, survivor);
  assert.equal(first.attempts, 1);

  // Positive: an identified infrastructure failure is retried once, and the retried outcome decides.
  calls = 0;
  const busy = { status: null, signal: null, error: Object.assign(Error('spawn EBUSY'), { code: 'EBUSY' }), stalled: false, timedOut: false, terminated: true };
  const killed = { status: 1, signal: null, error: null, stdout: 'not ok 1\nAssertionError', stderr: '', stalled: false, timedOut: false, terminated: true };
  const retried = await runMutant(async () => { calls += 1; return calls === 1 ? busy : killed; });
  assert.equal(retried.attempts, 2);
  assert.equal(retried.result, killed);
  assert.match(retried.evidence, /attempts=2/);
  assert.match(retried.evidence, /run1\[status=null/, 'the first-run evidence is kept');

  // A stalled run is infrastructure; the retry is judged on its own, including when the retry survives.
  calls = 0;
  const stalled = { status: null, signal: null, error: null, stalled: true, timedOut: false, terminated: true };
  const green = { status: 0, signal: null, stdout: '# pass 1', stderr: '', stalled: false, timedOut: false, terminated: true };
  const rechecked = await runMutant(async () => { calls += 1; return calls === 1 ? stalled : green; });
  assert.equal(rechecked.attempts, 2);
  assert.equal(rechecked.result.status, 0, 'a green retry after a stall is a survivor, and the sweep must fail on it');
  assert.match(rechecked.evidence, /stalled=true/);

  // Negative: NOT_ROUTED is a verdict about the tree under test, so it is never retried.
  calls = 0;
  const notRouted = { status: 1, signal: null, error: null, stdout: 'Error: NOT_ROUTED team:x is not hosted in this process', stderr: '', stalled: false,
    timedOut: false, terminated: true };
  assert.equal(isInfrastructureFailure(notRouted), false);
  const unrouted = await runMutant(async () => { calls += 1; return notRouted; });
  assert.equal(calls, 1);
  assert.equal(unrouted.attempts, 1);
});

