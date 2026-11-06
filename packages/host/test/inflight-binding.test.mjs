// Offline feature tests for managed in-flight tokens; docs/host-protocol.md §2.1 rule 3 and §2.4.
// The defect these pin: a token was a licence for any business command. It ignored admission when it was minted and
// never checked that the incoming receipt was the operation the token belonged to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamHost } from '../index.mjs';
import { commands, fakeCore, removeDir, tempDir } from '../test-support/helpers.mjs';

const TEAM = 'team:inflight';

const receipt = (operationId, command = 'host.ping', entityId = 'message:m1', actor = 'member:root') => ({
  requestId: 'req-' + operationId.slice(-4),
  teamId: TEAM,
  actor,
  operationId,
  payload: { entityId, command },
});

const operation = (operationId, command = 'host.ping', entityId = 'message:m1', actor = 'member:root') => ({ operationId, command, entityId, actor });

function makeHost(dir, extra = {}) {
  return createTeamHost({
    teamId: TEAM,
    root: dir,
    ownerSessionId: 'session:inflight',
    commands,
    core: fakeCore(),
    recoverer: async () => ({ status: 'ok', admission: true }),
    ...extra,
  });
}

test('a closed admission cannot mint an in-flight token', async () => {
  const dir = tempDir('inflight-closed');
  const core = fakeCore();
  const host = createTeamHost({ teamId: TEAM, root: dir, ownerSessionId: 'session:inflight', commands, core });
  try {
    await host.start();
    assert.equal(host.status().admission, false);
    assert.throws(() => host.openInflight(operation('v1:operation:mint-0001')), error => error.code === 'ADMISSION_CLOSED');
    assert.equal(host.status().inflight.opened, 0, 'no token was minted');
    assert.equal(core.calls.length, 0);
  } finally {
    await host.stop();
    removeDir(dir);
  }
});

test('a token can only carry its own operation, command, target and actor', async () => {
  const dir = tempDir('inflight-bound');
  const core = fakeCore();
  const host = makeHost(dir, { core });
  let managed = null;
  try {
    await host.start();
    // One token, nothing submitted yet. Each refusal below changes exactly one field of the token's own request and
    // keeps the other three identical, so removing any single check fails a test.
    managed = host.openInflight(operation('v1:operation:bound-0001'));
    const refused = (request, label) => assert.throws(
      () => host.command(request, { inflight: managed.token }),
      error => error.code === 'INFLIGHT_MISMATCH',
      label,
    );
    refused(receipt('v1:operation:bound-0009'), 'another operation');
    refused(receipt('v1:operation:bound-0001', 'host.audit'), 'another command');
    refused(receipt('v1:operation:bound-0001', 'host.ping', 'message:m2'), 'another target');
    refused(receipt('v1:operation:bound-0001', 'host.ping', 'message:m1', 'member:other'), 'another actor');
    assert.equal(core.calls.length, 0, 'no refused receipt reached the store');

    // Only now the receipt the token actually belongs to.
    const accepted = host.command(receipt('v1:operation:bound-0001'), { inflight: managed.token });
    assert.equal(accepted.result.revision, 1);
    assert.equal(core.calls.length, 1, 'exactly the bound receipt reached the store');

    // A command without the in-flight channel is refused before any authorization detail matters.
    assert.throws(
      () => host.command(receipt('v1:operation:bound-0011', 'host.plain'), { inflight: managed.token }),
      error => error.code === 'INVALID_INFLIGHT',
    );
  } finally {
    if (managed) managed.close();
    await host.stop();
    removeDir(dir);
  }
});

test('only a command the registry marks for the in-flight channel can be opened as a managed operation', async () => {
  const dir = tempDir('inflight-mint');
  const host = makeHost(dir);
  try {
    await host.start();
    const invalid = (spec, code) => assert.throws(() => host.openInflight(spec), error => error.code === code);
    invalid(operation('v1:operation:mint-0003', 'host.plain'), 'INVALID_INFLIGHT');
    invalid(operation('v1:operation:mint-0004', 'host.observe', 'runtime:team', 'operator'), 'INVALID_INFLIGHT');
    invalid({ operationId: 'v1:operation:mint-0005', command: 'host.ping', entityId: 'message:m1' }, 'INVALID_INFLIGHT');
    invalid(operation('v1:operation:mint-0006', 'host.missing'), 'UNIMPLEMENTED_COMMAND');
    assert.equal(host.status().inflight.opened, 0);
  } finally {
    await host.stop();
    removeDir(dir);
  }
});

test('minting a token runs the same command preflight as dispatch', async () => {
  const dir = tempDir('inflight-preflight');
  const core = fakeCore();
  const host = makeHost(dir, { core });
  let managed = null;
  try {
    await host.start();
    // host.probe declares actor: 'adapter'; the wrong principal is refused before a token exists.
    assert.throws(() => host.openInflight(operation('v1:operation:probe-0001', 'host.probe')), error => error.code === 'ACTOR_NOT_AUTHORIZED');
    assert.equal(host.status().inflight.opened, 0, 'a refused preflight must not mint a token');
    // The same rule refuses the dispatch path.
    assert.throws(
      () => host.command(receipt('v1:operation:probe-0002', 'host.probe')),
      error => error.code === 'ACTOR_NOT_AUTHORIZED',
    );
    assert.equal(core.calls.length, 0);

    // The declared principal can mint, and close with its own receipt.
    managed = host.openInflight(operation('v1:operation:probe-0001', 'host.probe', 'message:m1', 'adapter'));
    assert.equal(host.status().inflight.opened, 1);
    const closed = host.command(receipt('v1:operation:probe-0001', 'host.probe', 'message:m1', 'adapter'), { inflight: managed.token });
    assert.equal(closed.result.revision, 1);
    assert.equal(core.calls.length, 1);
  } finally {
    if (managed) managed.close();
    await host.stop();
    removeDir(dir);
  }
});
