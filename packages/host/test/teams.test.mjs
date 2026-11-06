// F1: one host mount per context and one mount per canonical team directory; M1b design §4.1-§4.3.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertSingleMount, TeamManager } from '../src/manager.mjs';
import { newTeamId, TeamRegistry } from '../src/registry.mjs';
import { removeDir, tempDir } from '../test-support/helpers.mjs';

/** A stand-in host: the manager's job is the mount table, the registry and the alias rule, not another lifecycle. */
function fakeHost(spec) {
  const host = {
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
  return host;
}

test('F1: a second apply on one context is refused with TEAM_HOST_MOUNTED', () => {
  const ctx = { teamRuntime: { core: null } };
  assert.throws(() => assertSingleMount(ctx), error => error.code === 'TEAM_HOST_MOUNTED');
  // A fresh context mounts normally.
  assert.equal(assertSingleMount({}), true);
});

test('F1: one canonical directory mounts once, whichever spelling is used', async () => {
  const home = tempDir('teams-home');
  const teamDir = tempDir('teams-dir');
  const manager = new TeamManager({ home, createHost: fakeHost });
  try {
    await manager.open();
    const first = await manager.mount({ teamId: 'team:' + 'a'.repeat(16), root: teamDir, ownerSessionId: 'session:lead' });
    assert.equal(manager.size, 1);
    assert.equal(first.spec.root, fs.realpathSync.native(teamDir));
    // The same directory spelled differently (trailing separator, a ".." detour) is the same mount key.
    for (const alias of [teamDir + path.sep, path.join(teamDir, '.')]) {
      await assert.rejects(manager.mount({ teamId: 'team:' + 'b'.repeat(16), root: alias, ownerSessionId: 'session:other' }),
        error => error.code === 'TEAM_ALIAS_TAKEN');
    }
    assert.equal(manager.size, 1, 'the alias attempts did not create a second host');
  } finally {
    await manager.close();
    removeDir(home);
    removeDir(teamDir);
  }
});

test('F12/F13: one owner reserves one team, and a second registry on the same home is REGISTRY_LOCKED', async () => {
  const home = tempDir('teams-registry');
  const registry = new TeamRegistry({ home });
  try {
    await registry.open();
    const teamId = newTeamId();
    assert.match(teamId, /^team-[0-9a-f]{32}$/);
    const first = registry.reserve({ ownerSessionId: 'session:lead', teamId });
    assert.equal(first.status, 'creating');
    const again = registry.reserve({ ownerSessionId: 'session:lead' });
    assert.equal(again.teamId, teamId, 'the same owner gets the same team back');
    assert.equal(again.reused, true);
    registry.markReady(teamId);
    assert.equal(registry.entry(teamId).status, 'ready');
    const other = registry.reserve({ ownerSessionId: 'session:second' });
    assert.notEqual(other.teamId, teamId);
    registry.markReady(other.teamId);

    // A crashed 'creating' row for a team that never got an epoch is dropped by the next manager.
    registry.reserve({ ownerSessionId: 'session:lost', dir: path.join(home, 'teams', newTeamId()) });
    const dropped = registry.recoverCreating({ hasEpoch: () => false });
    assert.equal(dropped.length, 1);

    const bytesBefore = fs.readFileSync(registry.file, 'utf8');
    const second = new TeamRegistry({ home });
    await assert.rejects(second.open(), error => error.code === 'REGISTRY_LOCKED');
    assert.equal(fs.readFileSync(registry.file, 'utf8'), bytesBefore, 'a refused manager did not touch the registry');
    assert.equal(second.held, false);
  } finally {
    await registry.close();
    removeDir(home);
  }
});
