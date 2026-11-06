// Offline feature tests for the command gateway; docs/host-protocol.md §2.4, invariants 3 and 7 (F22).
// The defects these pin: the command class came from the caller (so a business write could be disguised as operator),
// the idempotency key ignored the actor, and the reducer received the raw payload while the identity hashed a
// normalised one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandGateway, createTeamHost } from '../index.mjs';
import { commands, fakeCore, removeDir, tempDir, waitFor } from '../test-support/helpers.mjs';

const request = (overrides = {}) => ({
  requestId: 'req-1',
  teamId: 'team:gw',
  actor: 'member:root',
  operationId: 'v1:operation:host-gateway-0001',
  payload: { entityId: 'message:m1', command: 'host.ping', text: 'hi', meta: { a: 1, b: 2 } },
  ...overrides,
});

async function openHost(dir, overrides = {}) {
  const core = overrides.core ?? fakeCore();
  const host = createTeamHost({
    teamId: 'team:gw',
    root: dir,
    ownerSessionId: 'session:gw',
    commands,
    recoverer: async () => ({ status: 'ok', admission: true }),
    ...overrides,
    core,
  });
  await host.start();
  return { host, core };
}

test('a closed admission refuses business commands even though the host is running', async () => {
  const dir = tempDir('gateway-admission');
  const core = fakeCore();
  const host = createTeamHost({ teamId: 'team:gw', root: dir, ownerSessionId: 'session:gw', core, commands });
  try {
    await host.start();
    assert.equal(host.status().state, 'running');
    assert.equal(host.status().admission, false);
    assert.throws(() => host.command(request()), error => error.code === 'ADMISSION_CLOSED');
    assert.equal(core.calls.length, 0, 'a closed admission means no write reaches the store');
    // An operator-class command stays available while admission is closed (spec invariant 7 rule 3).
    const observer = request({ operationId: 'v1:operation:operator-0001', actor: 'operator', payload: { entityId: 'runtime:team', command: 'host.observe' } });
    const receipt = host.command(observer);
    assert.equal(receipt.class, 'operator');
    assert.equal(receipt.result.revision, 1);
  } finally {
    await host.stop();
    removeDir(dir);
  }
});

test('the caller cannot reclassify a business command as operator', async () => {
  const dir = tempDir('gateway-masquerade');
  const core = fakeCore();
  const host = createTeamHost({ teamId: 'team:gw', root: dir, ownerSessionId: 'session:gw', core, commands });
  try {
    await host.start();
    assert.throws(() => host.command(request(), { kind: 'operator' }), error => error.code === 'INVALID_COMMAND');
    assert.throws(() => host.command(request(), { kind: 'recovery' }), error => error.code === 'INVALID_COMMAND');
    // Without the disguise the same request is classified as business and refused by the closed admission.
    assert.throws(() => host.command(request()), error => error.code === 'ADMISSION_CLOSED');
    assert.equal(core.calls.length, 0);
  } finally {
    await host.stop();
    removeDir(dir);
  }
});

test('an operator command works while the team runs normally, and only for its principal', async () => {
  const dir = tempDir('gateway-operator');
  const { host } = await openHost(dir);
  try {
    assert.equal(host.status().state, 'running');
    assert.equal(host.status().admission, true);
    const observer = request({ actor: 'operator', payload: { entityId: 'runtime:team', command: 'host.observe' } });
    const receipt = host.command(observer);
    assert.equal(receipt.class, 'operator', 'a local unknown must be actionable without freezing the team');
    // The operator principal is required, and the admission state is not a substitute for it.
    const impersonation = request({
      operationId: 'v1:operation:operator-0002',
      actor: 'member:root',
      payload: { entityId: 'runtime:team', command: 'host.observe' },
    });
    assert.throws(() => host.command(impersonation), error => error.code === 'ACTOR_NOT_AUTHORIZED');
  } finally {
    await host.stop();
    removeDir(dir);
  }
});

test('an unknown command is refused as unimplemented on a healthy host', async () => {
  const dir = tempDir('gateway-unknown');
  const { host, core } = await openHost(dir);
  try {
    assert.throws(
      () => host.command(request({ payload: { entityId: 'message:m1', command: 'host.nothing' } })),
      error => error.code === 'UNIMPLEMENTED_COMMAND',
    );
    assert.equal(core.calls.length, 0);
  } finally {
    await host.stop();
    removeDir(dir);
  }
});

test('the same operationId, actor and business payload returns the stored receipt (F22)', async () => {
  const dir = tempDir('gateway-replay');
  const { host, core } = await openHost(dir);
  try {
    const first = host.command(request());
    const replay = host.command(request({ requestId: 'req-2', payload: { entityId: 'message:m1', command: 'host.ping', meta: { b: 2, a: 1 }, text: 'hi' } }));
    assert.equal(replay, first, 'a replay returns the stored receipt object');
    assert.equal(core.calls.length, 1, 'a replay must not reach the store twice');
    assert.equal(first.result.revision, 1);
    assert.equal(first.class, 'business');
  } finally {
    await host.stop();
    removeDir(dir);
  }
});

test('another actor with the same operationId gets a conflict, never somebody else receipt', async () => {
  const dir = tempDir('gateway-actor');
  const { host, core } = await openHost(dir);
  try {
    host.command(request());
    assert.throws(() => host.command(request({ requestId: 'req-3', actor: 'member:other' })), error => error.code === 'OPERATION_CONFLICT');
    assert.equal(core.calls.length, 1);
  } finally {
    await host.stop();
    removeDir(dir);
  }
});

test('the same actor and operationId with a different payload is an explicit conflict', async () => {
  const dir = tempDir('gateway-conflict');
  const { host, core } = await openHost(dir);
  try {
    host.command(request());
    assert.throws(
      () => host.command(request({ requestId: 'req-4', payload: { entityId: 'message:m1', command: 'host.ping', text: 'changed' } })),
      error => error.code === 'OPERATION_CONFLICT',
    );
    assert.equal(core.calls.length, 1);
  } finally {
    await host.stop();
    removeDir(dir);
  }
});

test('a command that belongs to another team is unrouted, never broadcast', async () => {
  const dir = tempDir('gateway-team');
  const { host, core } = await openHost(dir);
  try {
    assert.throws(() => host.command(request({ teamId: 'team:other' })), error => error.code === 'NOT_ROUTED');
    assert.equal(core.calls.length, 0);
  } finally {
    await host.stop();
    removeDir(dir);
  }
});

test('only strict JSON is accepted, and the reducer sees the same snapshot the identity was built from', async () => {
  const dir = tempDir('gateway-json');
  const { host, core } = await openHost(dir);
  try {
    const cyclic = { entityId: 'message:m9', command: 'host.ping' };
    cyclic.self = cyclic;
    for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, new Date(0), () => 1, 1n, cyclic]) {
      assert.throws(
        () => host.command(request({ operationId: 'v1:operation:bad-payload-0001', payload: bad })),
        error => error.code === 'INVALID_PAYLOAD',
        'payload should be refused: ' + String(bad),
      );
    }
    assert.equal(core.calls.length, 0);

    const payload = JSON.parse('{"entityId":"message:m7","command":"host.ping","__proto__":{"a":1}}');
    const receipt = host.command(request({ operationId: 'v1:operation:proto-0001', payload }));
    const seen = core.calls[0].payload;
    assert.equal(Object.getPrototypeOf(seen), null, 'the reducer receives a null-prototype snapshot');
    assert.ok(Object.prototype.hasOwnProperty.call(seen, '__proto__'), 'a "__proto__" key survives normalisation');
    assert.equal(Object.keys(seen).join(','), ['__proto__', 'command', 'entityId'].sort().join(','));
    const without = host.command(request({ operationId: 'v1:operation:proto-0002', payload: { entityId: 'message:m7', command: 'host.ping' } }));
    assert.notEqual(receipt.payloadHash, without.payloadHash, 'the "__proto__" key changes the identity');
  } finally {
    await host.stop();
    removeDir(dir);
  }
});

test('an in-flight receipt may commit while the host drains; business commands may not', async () => {
  const dir = tempDir('gateway-inflight');
  const { host } = await openHost(dir);
  const spec = { operationId: 'v1:operation:inflight-0001', command: 'host.ping', entityId: 'message:m1', actor: 'member:root', label: 'wake' };
  const managed = host.openInflight(spec);
  try {
    const stopping = host.stop({ timeoutMs: 500 });
    await waitFor(() => host.status().state === 'stopping', 'stopping');
    const receipt = host.command(request({ operationId: 'v1:operation:inflight-0001' }), { inflight: managed.token });
    assert.equal(receipt.result.revision, 1);
    assert.throws(
      () => host.command(request({ operationId: 'v1:operation:inflight-0002' }), { inflight: { epoch: host.epoch } }),
      error => error.code === 'INFLIGHT_UNKNOWN',
    );
    assert.throws(
      () => host.command(request({ operationId: 'v1:operation:inflight-0003' }), { inflight: managed.token }),
      error => error.code === 'INFLIGHT_MISMATCH',
      'the token only carries its own operation',
    );
    assert.throws(() => host.command(request({ operationId: 'v1:operation:business-0001' })), error => error.code === 'HOST_NOT_RUNNING');
    managed.close();
    const result = await stopping;
    assert.equal(result.state, 'stopped');
    assert.equal(result.drain, 'settled');
  } finally {
    await host.stop();
    removeDir(dir);
  }
});

test('a gateway built without an authorization check refuses everything', () => {
  const gateway = new CommandGateway({ teamId: 'team:bare', core: fakeCore(), commands });
  assert.throws(() => gateway.command(request({ teamId: 'team:bare' })), error => error.code === 'AUTHORIZATION_NOT_CONFIGURED');
});

test('status marks receipts as instance-scoped, with no cross-restart idempotency', async () => {
  const dir = tempDir('gateway-scope');
  const { host } = await openHost(dir);
  try {
    assert.deepEqual(host.status().capabilities, {
      receipts: 'memory-only',
      receiptScope: 'instance',
      crossRestartIdempotency: false,
      durableWritePort: 'none',
      persistence: 'M2',
    });
  } finally {
    await host.stop();
    removeDir(dir);
  }
});