// Offline feature tests for ownership; docs/host-protocol.md §1.1 invariant 1 (F1) and the epoch rules.
// The defect these pin: a lock file plus a pid-liveness check is not an exclusion primitive - two starters could take
// over the same stale file, and a corrupt epoch fell back to 1, so an old receipt could pass the epoch check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { acquireOwnership, canonicalTeamDir, createTeamHost, OwnershipRegistry } from '../index.mjs';
import { startWorker } from '../test-support/helpers.mjs';
import { epochPath, readJson, recordPath, removeDir, tempDir } from '../test-support/helpers.mjs';

test('a second mount of one directory is refused atomically and leaves nothing behind (F1)', async () => {
  const dir = tempDir('dup');
  let loserStoreOpens = 0;
  const winner = createTeamHost({ teamId: 'team:winner', root: dir, ownerSessionId: 'session:owner-winner' });
  const loser = createTeamHost({
    teamId: 'team:loser',
    root: dir,
    ownerSessionId: 'session:owner-loser',
    openStore: () => {
      loserStoreOpens += 1;
      return { close() {} };
    },
  });
  try {
    await winner.start();
    const epochBefore = readJson(epochPath(dir));
    const recordBefore = readJson(recordPath(dir));
    await assert.rejects(loser.start(), error => error.code === 'OWNERSHIP_HELD');
    assert.equal(loserStoreOpens, 0, 'a refused mount must not open a business store');
    assert.equal(loser.status().epoch, null);
    assert.equal(loser.status().failed.code, 'OWNERSHIP_HELD');
    assert.equal(loser.status().ownership.held, false);
    assert.deepEqual(readJson(epochPath(dir)), epochBefore, 'a refused mount must not bump the epoch');
    assert.deepEqual(readJson(recordPath(dir)), recordBefore, 'a refused mount must not touch the owner record');
    assert.equal(winner.status().ownership.held, true);
    await loser.stop();
    assert.equal(loser.status().state, 'stopped');
    assert.equal(winner.status().state, 'running');
    await winner.stop();
    assert.equal(fs.existsSync(recordPath(dir)), false, 'release removes the diagnostic record');
  } finally {
    await winner.stop().catch(() => {});
    removeDir(dir);
  }
});

test('path aliases of one directory still yield exactly one owner', async () => {
  const base = tempDir('alias');
  const dir = path.join(base, 'Team');
  fs.mkdirSync(dir);
  const aliases = [dir, base + path.sep + '.' + path.sep + 'Team', base + path.sep + 'missing' + path.sep + '..' + path.sep + 'Team'];
  if (process.platform === 'win32') aliases.push(base + path.sep + 'team');
  try {
    for (const alias of aliases) assert.equal(canonicalTeamDir(alias), canonicalTeamDir(dir), 'alias not normalised: ' + alias);
    const winner = createTeamHost({ teamId: 'team:alias-winner', root: aliases[0], ownerSessionId: 'session:alias-winner' });
    await winner.start();
    try {
      for (const [index, alias] of aliases.entries()) {
        const loser = createTeamHost({ teamId: 'team:alias-' + index, root: alias, ownerSessionId: 'session:alias-' + index });
        await assert.rejects(loser.start(), error => error.code === 'OWNERSHIP_HELD', 'alias should be refused: ' + alias);
        await loser.stop();
      }
      assert.equal(winner.status().epoch, 1);
    } finally {
      await winner.stop();
    }
  } finally {
    removeDir(base);
  }
});

test('a live holder in another process blocks the mount without disturbing its epoch', async () => {
  const dir = tempDir('live');
  const holder = startWorker(['hold', dir, '0', '0']);
  let storeOpens = 0;
  try {
    const ready = await holder.next();
    assert.equal(ready.ok, true, holder.stderr());
    const epochBefore = readJson(epochPath(dir));
    const host = createTeamHost({
      teamId: 'team:live',
      root: dir,
      ownerSessionId: 'session:live',
      openStore: () => {
        storeOpens += 1;
        return { close() {} };
      },
    });
    await assert.rejects(host.start(), error => error.code === 'OWNERSHIP_HELD');
    assert.equal(storeOpens, 0);
    assert.deepEqual(readJson(epochPath(dir)), epochBefore, 'a refused mount must not bump the epoch');
    await host.stop();
    assert.equal(host.status().state, 'stopped');
  } finally {
    holder.child.kill();
    removeDir(dir);
  }
});

test('two registries in one process are still mutually exclusive through the OS lock', async () => {
  const dir = tempDir('registries');
  const first = createTeamHost({ teamId: 'team:r1', root: dir, ownerSessionId: 'session:r1', registry: new OwnershipRegistry() });
  const second = createTeamHost({ teamId: 'team:r2', root: dir, ownerSessionId: 'session:r2', registry: new OwnershipRegistry() });
  try {
    await first.start();
    await assert.rejects(second.start(), error => error.code === 'OWNERSHIP_HELD');
    assert.equal(second.status().ownership.held, false);
    await second.stop();
    assert.equal(first.status().state, 'running');
  } finally {
    await first.stop().catch(() => {});
    removeDir(dir);
  }
});

test('a late release from an old handle cannot free the new holder', async () => {
  const dir = tempDir('late-release');
  try {
    const first = await acquireOwnership({ root: dir });
    await first.release();
    const second = await acquireOwnership({ root: dir });
    try {
      assert.equal(second.epoch, first.epoch + 1);
      await first.release();
      assert.equal(second.owns(), true, 'the old handle released only its own server');
      assert.equal(readJson(recordPath(dir)).epoch, second.epoch, 'the record still names the live holder');
      await assert.rejects(acquireOwnership({ root: dir }), error => error.code === 'OWNERSHIP_HELD');
    } finally {
      await second.release();
    }
  } finally {
    removeDir(dir);
  }
});

test('a corrupt or out-of-range epoch file refuses the start instead of reusing an epoch', async () => {
  const dir = tempDir('epoch-corrupt');
  try {
    fs.writeFileSync(epochPath(dir), 'not json at all');
    const host = createTeamHost({ teamId: 'team:epoch', root: dir, ownerSessionId: 'session:epoch' });
    await assert.rejects(host.start(), error => error.code === 'EPOCH_UNREADABLE');
    assert.equal(host.status().failed.code, 'EPOCH_UNREADABLE');
    assert.equal(host.status().epoch, null);
    await host.stop();
    // The OS lock was released again: once the epoch is repaired a mount succeeds with the next value.
    fs.writeFileSync(epochPath(dir), JSON.stringify({ epoch: 4 }) + '\n');
    const handle = await acquireOwnership({ root: dir });
    assert.equal(handle.epoch, 5);
    await handle.release();
  } finally {
    removeDir(dir);
  }

  const shaped = tempDir('epoch-shape');
  try {
    for (const value of [JSON.stringify({ epoch: 0 }), JSON.stringify({ epoch: '4' }), JSON.stringify({ epoch: 4.5 }), JSON.stringify({})]) {
      fs.writeFileSync(epochPath(shaped), value);
      await assert.rejects(acquireOwnership({ root: shaped }), error => error.code === 'EPOCH_UNREADABLE', value);
    }
  } finally {
    removeDir(shaped);
  }
});

test('an epoch at the safe-integer boundary is refused instead of wrapping', async () => {
  const dir = tempDir('epoch-overflow');
  try {
    fs.writeFileSync(epochPath(dir), JSON.stringify({ epoch: Number.MAX_SAFE_INTEGER }) + '\n');
    await assert.rejects(acquireOwnership({ root: dir }), error => error.code === 'EPOCH_EXHAUSTED');
    assert.equal(readJson(epochPath(dir)).epoch, Number.MAX_SAFE_INTEGER, 'the refused start must not rewrite the epoch');
    // Nothing is left held: a corrected file can be mounted immediately.
    fs.writeFileSync(epochPath(dir), JSON.stringify({ epoch: 9 }) + '\n');
    const handle = await acquireOwnership({ root: dir });
    assert.equal(handle.epoch, 10);
    await handle.release();
  } finally {
    removeDir(dir);
  }
});

test('an acquisition cancelled after binding releases its own name and publishes nothing', async () => {
  const dir = tempDir('acquire-signal');
  try {
    const controller = new AbortController();
    const acquisition = acquireOwnership({ root: dir, signal: controller.signal });
    // Abort synchronously: the name binds on a later tick, so the barrier after listen sees the cancellation.
    controller.abort();
    await assert.rejects(acquisition, error => error.code === 'HOST_STOPPED');
    assert.equal(fs.existsSync(epochPath(dir)), false, 'no epoch was allocated for a cancelled acquisition');
    assert.equal(fs.existsSync(recordPath(dir)), false, 'no owner record was published');
    const handle = await acquireOwnership({ root: dir });
    assert.equal(handle.epoch, 1, 'the name was released again');
    await handle.release();
  } finally {
    removeDir(dir);
  }
});

test('ownership.verify() confirms the holder and stops confirming after release', async () => {
  const dir = tempDir('verify');
  const host = createTeamHost({ teamId: 'team:verify', root: dir, ownerSessionId: 'session:verify' });
  try {
    await host.start();
    assert.deepEqual(host.ownership.verify(), { ok: true });
    assert.equal(host.status().ownership.held, true);
    await host.stop();
    assert.equal(host.ownership, null);
    assert.equal(host.status().ownership.released, true);
  } finally {
    await host.stop();
    removeDir(dir);
  }
});
