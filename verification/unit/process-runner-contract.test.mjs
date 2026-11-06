import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcessTree } from '../../packages/profiles/test-support/process-tree.mjs';
import { runS1Process } from '../../packages/core/test-support/s1-process-runner.mjs';

/**
 * One contract, two implementations: the shared profiles runner and the core-local S1 runner (which may not import it
 * across packages, check:deps rule b). Both are driven through the same real child-process cases, so a drift in the
 * unified result fields, in the progress criterion, or in the termination confirmation fails here.
 *
 * A case asserts only the shared contract: status/signal/stalled/timedOut/stopReason/terminated are always present, a
 * stopped tree always reports a status (never undefined), "no progress" (stalled) is never confused with "over the hard
 * cap" (timedOut), and a terminated tree leaves no descendant behind.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = path.join(repoRoot, 'packages/profiles/test-support/borrow-process-tree-fixture.mjs');
const runners = [['shared process-tree', runProcessTree], ['s1 process runner', runS1Process]];
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'runner-contract-'));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const waitGone = async pid => {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
};
// A root stopped by the runner is killed with taskkill /T /F on Windows (no signal) and SIGKILL on POSIX.
const killedSignal = () => (process.platform === 'win32' ? null : 'SIGKILL');

const cases = [
  {
    name: 'a clean exit reports its status and a confirmed termination',
    script: () => ['exit'], options: { timeoutMs: 30000, idleTimeoutMs: 10000 },
    check: result => {
      assert.equal(result.status, 0);
      assert.equal(result.signal, null);
      assert.equal(result.stopReason, 'close');
      assert.equal(result.terminated, true);
      assert.equal(result.stalled, false);
      assert.equal(result.timedOut, false);
    }
  },
  {
    name: 'steady output outlives a short idle budget',
    script: () => ['slow', '800'], options: { timeoutMs: 30000, idleTimeoutMs: 500 },
    check: result => {
      assert.equal(result.status, 0);
      assert.equal(result.signal, null);
      assert.equal(result.stopReason, 'close');
      assert.equal(result.terminated, true);
      assert.equal(result.stalled, false);
      assert.equal(result.timedOut, false);
    }
  },
  {
    name: 'silence is stalled, not timedOut',
    script: () => ['silent', '10000'], options: { timeoutMs: 30000, idleTimeoutMs: 300 },
    check: result => {
      assert.equal(result.stalled, true);
      assert.equal(result.timedOut, false);
      assert.equal(result.stopReason, 'idle');
      assert.equal(result.signal, killedSignal());
      assert.equal(result.terminated, true);
      assert.notEqual(result.status, undefined);
    }
  },
  {
    name: 'a tree that never stops talking hits the hard cap',
    script: () => ['slow', '10000'], options: { timeoutMs: 400, idleTimeoutMs: 10000 },
    check: result => {
      assert.equal(result.timedOut, true);
      assert.equal(result.stalled, false);
      assert.equal(result.stopReason, 'timeout');
      assert.equal(result.signal, killedSignal());
      assert.equal(result.terminated, true);
      assert.notEqual(result.status, undefined);
    }
  },
  {
    name: 'termination reaches the descendants of the root',
    script: root => ['tree', path.join(root, 'grandchild.pid')],
    options: { timeoutMs: 400, idleTimeoutMs: 10000 },
    check: async (result, root) => {
      assert.equal(result.timedOut, true);
      assert.equal(result.stopReason, 'timeout');
      assert.equal(result.terminated, true);
      const pidFile = path.join(root, 'grandchild.pid');
      assert.equal(fs.existsSync(pidFile), true, 'the fixture wrote the grandchild pid');
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      assert(Number.isInteger(pid) && pid > 0, 'a real grandchild pid');
      assert.equal(await waitGone(pid), true, 'the descendant process ' + pid + ' is still alive after termination');
    }
  }
];

for (const [label, run] of runners) {
  test('process-runner contract: ' + label, { timeout: 120000 }, async () => {
    for (const item of cases) {
      const root = temp();
      try {
        const result = await run({ file: fixture, scriptArgs: item.script(root), ...item.options, confirmTimeoutMs: 5000,
          env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root } });
        try {
          await item.check(result, root);
        } catch (error) {
          error.message = item.name + ': ' + error.message + ' ' + JSON.stringify({ status: result.status,
            signal: result.signal, stalled: result.stalled, timedOut: result.timedOut,
            terminated: result.terminated, stopReason: result.stopReason });
          throw error;
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });
}
