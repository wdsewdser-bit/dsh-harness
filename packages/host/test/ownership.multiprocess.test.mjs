// Real multi-process ownership tests: two child processes contend for one team directory.
// The old skeleton could not pass these - a lock file plus pid liveness allowed two starters to take over one file.
// The OS name is dropped when the owner's last handle closes, including on process exit; system cleanup may lag, so
// the post-kill takeover retries with a bound. Nothing here deletes or steals a name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireOwnership } from '../index.mjs';
import { startWorker } from '../test-support/helpers.mjs';
import { removeDir, tempDir } from '../test-support/helpers.mjs';

/** Bounded retry: the OS may need a moment to drop the name of a dead owner; no takeover protocol is involved. */
async function acquireEventually(root, attempts = 100) {
  const startedAt = Date.now();
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return { handle: await acquireOwnership({ root }), elapsed: Date.now() - startedAt, attempts: attempt + 1 };
    } catch (error) {
      if (error.code !== 'OWNERSHIP_HELD') throw error;
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}

test('two processes racing for one directory: exactly one gets the OS lock', async () => {
  const dir = tempDir('race');
  const startAt = Date.now() + 400;
  const workers = ['a', 'b'].map(() => startWorker(['race', dir, String(startAt), '1200']));
  try {
    const reports = await Promise.all(workers.map(worker => worker.next()));
    const winners = reports.filter(item => item.ok);
    const losers = reports.filter(item => !item.ok);
    assert.equal(winners.length, 1, 'exactly one process may hold the lock: ' + JSON.stringify(reports) + ' ' + workers.map(w => w.stderr()).join('|'));
    assert.equal(losers.length, 1, 'the other process must be refused: ' + JSON.stringify(reports));
    assert.equal(losers[0].code, 'OWNERSHIP_HELD');
    assert.equal(winners[0].epoch, 1, 'a fresh team starts at epoch 1');
    assert.equal(winners[0].kind, process.platform === 'win32' ? 'pipe' : 'abstract');
    const exits = await Promise.all(workers.map(worker => worker.exited));
    assert.deepEqual(exits.map(exit => exit.code).sort(), [0, 1]);
  } finally {
    for (const worker of workers) worker.child.kill();
    removeDir(dir);
  }
});

test('the kernel releases the lock when the holder dies; the next holder gets the next epoch', async () => {
  const dir = tempDir('kill');
  const holder = startWorker(['hold', dir, '0', '0']);
  try {
    const ready = await holder.next();
    assert.equal(ready.ok, true, holder.stderr());
    const intruder = startWorker(['race', dir, '0', '0']);
    const refused = await intruder.next();
    assert.equal(refused.ok, false, 'a live holder keeps other processes out');
    assert.equal(refused.code, 'OWNERSHIP_HELD');
    await intruder.exited;
    holder.child.kill();
    await holder.exited;
    const { handle, elapsed, attempts } = await acquireEventually(dir);
    try {
      assert.equal(handle.epoch, ready.epoch + 1);
      assert.equal(handle.owns(), true);
      assert.ok(elapsed < 3000, 'the takeover waited ' + elapsed + 'ms over ' + attempts + ' attempt(s)');
    } finally {
      await handle.release();
    }
  } finally {
    holder.child.kill();
    removeDir(dir);
  }
});

test('a fifth process cannot slip in while the winner holds the lock', async () => {
  const dir = tempDir('hold-out');
  const holder = startWorker(['hold', dir, '0', '0']);
  const latecomers = [];
  try {
    const ready = await holder.next();
    assert.equal(ready.ok, true, holder.stderr());
    for (let index = 0; index < 3; index++) latecomers.push(startWorker(['race', dir, '0', '0']));
    const reports = await Promise.all(latecomers.map(worker => worker.next()));
    for (const report of reports) {
      assert.equal(report.ok, false);
      assert.equal(report.code, 'OWNERSHIP_HELD');
    }
    await Promise.all(latecomers.map(worker => worker.exited));
  } finally {
    for (const worker of [...latecomers]) worker.child.kill();
    holder.child.kill();
    removeDir(dir);
  }
});
