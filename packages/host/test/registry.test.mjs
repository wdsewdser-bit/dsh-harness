// The registry lock and the persistent owner -> team mapping; M1b design §4.1, §4.2, §4.3.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TeamManager } from '../src/manager.mjs';
import { newTeamId, TeamRegistry } from '../src/registry.mjs';
import { removeDir, tempDir } from '../test-support/helpers.mjs';

const codeOf = async fn => {
  try {
    await fn();
  } catch (error) {
    return error.code ?? error.message;
  }
  return 'no-throw';
};

const syncCodeOf = fn => {
  try {
    fn();
  } catch (error) {
    return error.code ?? error.message;
  }
  return 'no-throw';
};

/** A stand-in host: these tests are about the registry and the mount table, not another lifecycle. */
function fakeHost(spec) {
  return {
    spec,
    root: spec.root,
    stopped: 0,
    async start() {
      return this.status();
    },
    async stop() {
      this.stopped += 1;
      return { state: 'stopped' };
    },
    status() {
      return { state: 'running', admission: true, epoch: 1, lastCycle: null };
    },
  };
}

test('a registry that holds no lock reads and writes nothing', async () => {
  const home = tempDir('registry-unopened');
  const registry = new TeamRegistry({ home });
  try {
    for (const [name, call] of [
      ['read', () => registry.read()],
      ['list', () => registry.list()],
      ['entry', () => registry.entry('team-' + 'a'.repeat(32))],
      ['reserve', () => registry.reserve({ ownerSessionId: 'session:lead' })],
      ['markReady', () => registry.markReady('team-' + 'a'.repeat(32))],
      ['markUnmounted', () => registry.markUnmounted('team-' + 'a'.repeat(32))],
      ['archive', () => registry.archive('team-' + 'a'.repeat(32))],
      ['destroy', () => registry.destroy('team-' + 'a'.repeat(32))],
      ['recoverCreating', () => registry.recoverCreating()],
      ['write', () => registry.write({ teams: [] })],
    ]) {
      assert.equal(syncCodeOf(call), 'REGISTRY_NOT_OPEN', name + ' is refused without the lock');
    }
    assert.equal(fs.existsSync(registry.file), false, 'nothing was created on disk');
    // After close (even of a registry that never opened) every entry point is closed, not merely unlocked.
    await registry.close();
    assert.equal(syncCodeOf(() => registry.read()), 'REGISTRY_CLOSED');
    assert.equal(syncCodeOf(() => registry.reserve({ ownerSessionId: 'session:lead' })), 'REGISTRY_CLOSED');
  } finally {
    await registry.close().catch(() => {});
    removeDir(home);
  }
});

test('a manager whose open() was refused cannot touch the file the holder owns', async () => {
  const home = tempDir('registry-refused');
  const holder = new TeamRegistry({ home });
  try {
    await holder.open();
    holder.reserve({ ownerSessionId: 'session:lead', teamId: newTeamId() });
    const before = fs.readFileSync(holder.file, 'utf8');

    const refused = new TeamRegistry({ home });
    assert.equal(await codeOf(() => refused.open()), 'REGISTRY_LOCKED');
    assert.equal(refused.held, false);
    assert.equal(syncCodeOf(() => refused.read()), 'REGISTRY_NOT_OPEN', 'a refused open leaves no read right either');
    assert.equal(syncCodeOf(() => refused.reserve({ ownerSessionId: 'session:other' })), 'REGISTRY_NOT_OPEN');
    assert.equal(syncCodeOf(() => refused.destroy('whatever')), 'REGISTRY_NOT_OPEN');
    assert.equal(fs.readFileSync(holder.file, 'utf8'), before, 'the refused registry wrote nothing');
    // The holder is unaffected.
    assert.equal(holder.list().length, 1);
  } finally {
    await holder.close();
    removeDir(home);
  }
});

test('unmount and stopAll keep the owner -> team mapping; a restart reads it back', async () => {
  const home = tempDir('registry-restart');
  const teamDir = tempDir('registry-team');
  const teamId = newTeamId();
  const manager = new TeamManager({ home, createHost: fakeHost });
  try {
    await manager.open();
    manager.registry.reserve({ ownerSessionId: 'session:lead', teamId, dir: teamDir });
    manager.registry.markReady(teamId);
    await manager.mount({ teamId, root: teamDir, ownerSessionId: 'session:lead' });
    const stopped = await manager.unmount(teamId);
    assert.equal(stopped.state, 'stopped');
    const row = manager.registry.entry(teamId);
    assert.ok(row, 'the row survives an unmount');
    assert.equal(row.ownerSessionId, 'session:lead');
    assert.equal(row.status, 'ready');
    assert.ok(row.unmountedAt > 0, 'the unmount is recorded, not applied as a deletion');
    // stopAll is the same rule: it stops hosts and keeps rows.
    await manager.mount({ teamId, root: teamDir, ownerSessionId: 'session:lead' });
    await manager.stopAll();
    assert.ok(manager.registry.entry(teamId), 'a full shutdown does not forget the owner');
    assert.equal(manager.size, 0);
  } finally {
    await manager.close();
  }
  // A fresh manager on the same home (the restart) still resolves the owner to the same team.
  const restarted = new TeamRegistry({ home });
  try {
    await restarted.open();
    const rows = restarted.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].teamId, teamId);
    assert.equal(rows[0].ownerSessionId, 'session:lead');
  } finally {
    await restarted.close();
    removeDir(home);
    removeDir(teamDir);
  }
});

test('only an explicit archive or destroy removes or retires the mapping', async () => {
  const home = tempDir('registry-archive');
  const teamDir = tempDir('registry-archive-team');
  const teamId = newTeamId();
  const manager = new TeamManager({ home, createHost: fakeHost });
  try {
    await manager.open();
    manager.registry.reserve({ ownerSessionId: 'session:lead', teamId, dir: teamDir });
    manager.registry.markReady(teamId);
    await manager.mount({ teamId, root: teamDir, ownerSessionId: 'session:lead' });

    const archived = await manager.archive(teamId);
    assert.equal(archived.status, 'archived');
    assert.ok(archived.archivedAt > 0);
    assert.ok(manager.registry.entry(teamId), 'an archived team keeps its row and its owner');
    assert.equal(manager.size, 1, 'archiving does not stop the host by itself');

    assert.equal(await manager.destroy(teamId), true);
    assert.equal(manager.registry.entry(teamId), null, 'destroy is the only operation that removes the row');
    assert.equal(manager.size, 0, 'destroy stops the mounted host first');
  } finally {
    await manager.close();
    removeDir(home);
    removeDir(teamDir);
  }
});

test('two managers can never hold the same home at once', async () => {
  const home = tempDir('registry-exclusive');
  const first = new TeamRegistry({ home });
  const second = new TeamRegistry({ home });
  try {
    await first.open();
    assert.equal(first.held, true);
    assert.equal(await codeOf(() => second.open()), 'REGISTRY_LOCKED');
    await first.close();
    // Once the holder releases the name, the second manager opens normally.
    await second.open();
    assert.equal(second.held, true);
    assert.equal(syncCodeOf(() => second.reserve({ ownerSessionId: 'session:second' })), 'no-throw');
  } finally {
    await second.close().catch(() => {});
    removeDir(home);
  }
});
