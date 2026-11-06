// Offline feature tests for the races around stop; docs/host-protocol.md §2.1 rules 3-4 and invariant 9.
// The defects these pin: a reentrant stop started a second shutdown, a cancelled start could still take the lock and
// write an epoch after stop returned, and status claimed "released" while the close was still running.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { acquireOwnership, createTeamHost } from '../index.mjs';
import { epochPath, recordPath, removeDir, tempDir, waitFor } from '../test-support/helpers.mjs';

test('a listener that calls stop during stopping joins the same run', async () => {
  const dir = tempDir('reentrant-stop');
  let closes = 0;
  const host = createTeamHost({
    teamId: 'team:reentrant',
    root: dir,
    ownerSessionId: 'session:reentrant',
    openStore: () => ({
      close() {
        closes += 1;
      },
    }),
  });
  let inner = null;
  host.onStateChange(step => {
    if (step.to === 'stopping' && !inner) inner = host.stop({ timeoutMs: 1000 });
  });
  try {
    await host.start();
    const outer = host.stop({ timeoutMs: 1000 });
    assert.equal(inner, outer, 'a reentrant stop returns the same promise');
    const [first, second] = await Promise.all([outer, inner]);
    assert.equal(first, second, 'and the same result object');
    assert.equal(closes, 1, 'resources are closed exactly once');
    assert.equal(host.status().history.filter(step => step.to === 'stopping').length, 1, 'one stopping transition');
  } finally {
    await host.stop();
    removeDir(dir);
  }
});

test('stop that expires during ownership acquisition leaves no lock, epoch or record behind', async () => {
  const dir = tempDir('acquire-cancel');
  let openGate = null;
  const gate = new Promise(resolve => {
    openGate = resolve;
  });
  let acquisitions = 0;
  const acquire = async context => {
    acquisitions += 1;
    await gate;
    return acquireOwnership(context);
  };
  const host = createTeamHost({ teamId: 'team:acquire-cancel', root: dir, ownerSessionId: 'session:acquire-cancel', acquire });
  try {
    const started = host.start();
    const failure = started.then(() => null, error => error);
    const result = await host.stop({ timeoutMs: 80 });
    assert.equal(result.state, 'stopped');
    assert.equal(result.ownership, 'none', 'nothing was ever held');
    assert.equal(result.drain, 'isolated');
    assert.equal(acquisitions, 1, 'the acquisition was still in flight');
    assert.equal(fs.existsSync(epochPath(dir)), false, 'no epoch was allocated for a cancelled acquisition');
    openGate();
    const error = await failure;
    assert.equal(error.code, 'HOST_STOPPED');
    assert.equal(host.status().failed, null, 'a start cancelled by stop is not a failure');
    assert.equal(fs.existsSync(epochPath(dir)), false);
    assert.equal(fs.existsSync(recordPath(dir)), false, 'no owner record was published');
    const handle = await acquireOwnership({ root: dir });
    assert.equal(handle.epoch, 1, 'the directory is free and still on its first epoch');
    await handle.release();
  } finally {
    openGate();
    await host.stop();
    removeDir(dir);
  }
});
test('a release that outlives the stop budget reports releasing, then released once confirmed', async () => {
  const dir = tempDir('release-delay');
  let confirm = null;
  const gate = new Promise(resolve => {
    confirm = resolve;
  });
  const acquire = async context => {
    const handle = await acquireOwnership(context);
    let releasing = null;
    return {
      epoch: handle.epoch,
      kind: handle.kind,
      name: handle.name,
      recordPath: handle.recordPath,
      owns: () => handle.owns(),
      verify: () => handle.verify(),
      release: () => {
        if (!releasing) releasing = gate.then(() => handle.release());
        return releasing;
      },
    };
  };
  const host = createTeamHost({ teamId: 'team:release-delay', root: dir, ownerSessionId: 'session:release-delay', acquire });
  try {
    await host.start();
    const held = host.status().ownership;
    assert.deepEqual(
      { phase: held.phase, released: held.released, eligibility: held.writeEligibility },
      { phase: 'held', released: false, eligibility: 'granted' },
    );
    const result = await host.stop({ timeoutMs: 150 });
    assert.equal(result.ownership, 'isolated', 'stop did not see the close finish');
    assert.equal(result.timedOut, true);
    const during = host.status().ownership;
    assert.equal(during.phase, 'releasing');
    assert.equal(during.released, false, 'status must not claim a release nobody confirmed');
    assert.equal(during.held, true, 'the handle still holds the name until the close lands');
    assert.equal(during.writeEligibility, 'revoked');
    await assert.rejects(acquireOwnership({ root: dir }), error => error.code === 'OWNERSHIP_HELD');
    confirm();
    await waitFor(() => host.status().ownership.phase === 'released', 'the background confirmation');
    const after = host.status().ownership;
    assert.equal(after.released, true);
    assert.equal(after.held, false);
    const handle = await acquireOwnership({ root: dir });
    assert.equal(handle.epoch, 2);
    await handle.release();
  } finally {
    confirm();
    await host.stop();
    removeDir(dir);
  }
});

test('a release that confirms false after the budget is not reported as released', async () => {
  const dir = tempDir('release-false');
  let confirm = null;
  const gate = new Promise(resolve => {
    confirm = resolve;
  });
  let real = null;
  const acquire = async context => {
    real = await acquireOwnership(context);
    const handle = real;
    return {
      epoch: handle.epoch,
      kind: handle.kind,
      name: handle.name,
      recordPath: handle.recordPath,
      owns: () => handle.owns(),
      verify: () => handle.verify(),
      release: async () => {
        await gate;
        return false;
      },
    };
  };
  const host = createTeamHost({ teamId: 'team:release-false', root: dir, ownerSessionId: 'session:release-false', acquire });
  try {
    await host.start();
    const result = await host.stop({ timeoutMs: 120 });
    assert.equal(result.ownership, 'isolated');
    assert.equal(host.status().ownership.phase, 'releasing');
    confirm();
    await waitFor(() => host.status().ownership.phase === 'release-failed', 'the failed confirmation');
    const status = host.status().ownership;
    assert.equal(status.released, false, 'a release that settles false is a failure, never a release');
    assert.equal(status.held, true, 'the handle was not cleared');
    assert.equal(status.error.code, 'RELEASE_FAILED');
  } finally {
    confirm();
    if (real) await real.release();
    await host.stop();
    removeDir(dir);
  }
});

test('a start failure that already released keeps the released phase through stop', async () => {
  const dir = tempDir('release-after-failure');
  const host = createTeamHost({
    teamId: 'team:release-failure',
    root: dir,
    ownerSessionId: 'session:release-failure',
    openStore: async () => ({ close() {} }),
  });
  try {
    await assert.rejects(host.start(), error => error.code === 'INVALID_STORE_PORT');
    assert.equal(host.status().ownership.phase, 'released');
    const result = await host.stop({ timeoutMs: 500 });
    assert.equal(result.state, 'stopped');
    assert.equal(host.status().ownership.phase, 'released', 'a second, empty cleanup must not erase a confirmed release');
    assert.equal(host.status().ownership.released, true);
    const handle = await acquireOwnership({ root: dir });
    assert.equal(handle.epoch, 2, 'the lock really was released by the failed start');
    await handle.release();
  } finally {
    await host.stop();
    removeDir(dir);
  }
});
