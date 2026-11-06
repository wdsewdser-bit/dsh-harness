// Offline feature tests for draining managed in-flight work; docs/host-protocol.md §2.1 rule 3, invariant 9.
// The defect these pin: stop() only waited for start and hooks, so a real managed effect never delayed the store
// closing - the earlier "draining" test only passed because an unrelated hook happened to be busy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamHost } from '../index.mjs';
import { commands, fakeCore, removeDir, tempDir, waitFor } from '../test-support/helpers.mjs';

const admissionOpen = async () => ({ status: 'ok', admission: true });

const operation = (operationId) => ({
  operationId,
  command: 'host.ping',
  entityId: 'message:m1',
  actor: 'member:root',
  label: 'wake',
});

const receiptRequest = (operationId) => ({
  requestId: 'req-' + operationId.slice(-4),
  teamId: 'team:drain',
  actor: 'member:root',
  operationId,
  payload: { entityId: 'message:m1', command: 'host.ping' },
});

function drainHost(dir, extra = {}) {
  let closes = 0;
  const host = createTeamHost({
    teamId: 'team:drain',
    root: dir,
    ownerSessionId: 'session:drain',
    commands,
    core: fakeCore(),
    recoverer: admissionOpen,
    openStore: () => ({
      close() {
        closes += 1;
      },
    }),
    ...extra,
  });
  return { host, closes: () => closes };
}

test('stop waits for a managed operation and accepts its receipt before closing', async () => {
  const dir = tempDir('drain-settled');
  const { host, closes } = drainHost(dir);
  try {
    await host.start();
    const managed = host.openInflight(operation('v1:operation:drain-settled-0001'));
    assert.equal(host.status().inflight.active, 1);
    const stopping = host.stop({ timeoutMs: 1000 });
    await waitFor(() => host.status().state === 'stopping', 'stopping');
    assert.equal(closes(), 0, 'the store stays open while the managed operation is pending');
    const receipt = host.command(receiptRequest('v1:operation:drain-settled-0001'), { inflight: managed.token });
    assert.equal(receipt.result.revision, 1, 'the pending receipt commits during the drain');
    managed.close();
    const result = await stopping;
    assert.equal(result.drain, 'settled');
    assert.deepEqual(result.inflight, { opened: 1, completed: 1, withheld: 0 });
    assert.equal(result.store, 'closed');
    assert.equal(result.ownership, 'released');
    assert.equal(result.timedOut, false);
    assert.equal(closes(), 1, 'the store is closed exactly once');
    assert.equal(host.status().inflight.active, 0);
    assert.throws(
      () => host.command(receiptRequest('v1:operation:drain-settled-0002'), { inflight: managed.token }),
      error => ['OWNERSHIP_LOST', 'INFLIGHT_UNKNOWN', 'HOST_NOT_RUNNING'].includes(error.code),
    );
  } finally {
    await host.stop();
    removeDir(dir);
  }
});

test('stop isolates a managed operation that never finishes and reports it as withheld', async () => {
  const dir = tempDir('drain-hung');
  const { host, closes } = drainHost(dir);
  let managed = null;
  try {
    await host.start();
    managed = host.openInflight(operation('v1:operation:drain-hung-0001'));
    const at = Date.now();
    const result = await host.stop({ timeoutMs: 150 });
    assert.equal(result.drain, 'isolated');
    assert.deepEqual(result.inflight, { opened: 1, completed: 0, withheld: 1 });
    assert.equal(result.timedOut, true);
    assert.equal(result.isolated, true);
    assert.equal(result.ownership, 'released', 'the lock is released even with a hung operation');
    assert.equal(result.state, 'stopped');
    assert.ok(Date.now() - at < 700, 'stop returned in ' + (Date.now() - at) + 'ms');
    assert.equal(host.status().inflight.active, 0, 'the token lost its write eligibility');
    assert.throws(
      () => host.command(receiptRequest('v1:operation:drain-hung-0001'), { inflight: managed.token }),
      error => ['OWNERSHIP_LOST', 'INFLIGHT_UNKNOWN', 'HOST_NOT_RUNNING'].includes(error.code),
    );
    assert.equal(closes(), 1);
  } finally {
    if (managed) managed.close();
    await host.stop();
    removeDir(dir);
  }
});