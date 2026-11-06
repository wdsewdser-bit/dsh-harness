// F22 plus the two fences; M1b design §3.6, §7 F22.
//
// The store keeps two identities and this file pins the difference:
//   - the stable external identity (teamId, entityId, actor, operationId, payloadHash) decides idempotency, so a
//     replay after the entity moved on - or after an effect was re-claimed - returns the original receipt;
//   - the attempt fence inside the business payload is part of payloadHash, so attempt.finish {fence:3} replayed as
//     {fence:4} is a different request and conflicts instead of silently writing with a stale authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTeamHost } from '../index.mjs';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
import { digest } from '../../contracts/index.mjs';
import { removeDir, tempDir } from '../test-support/helpers.mjs';

const TEAM = 'team:f22';
const OP = id => 'v1:operation:' + id;

/** One command exactly as the gateway builds it: no now, no fence, no revision in the payload hash. */
const command = (entityId, actor, payload, operationId, expectedRevision) => ({
  teamId: TEAM, entityId, actor, payload, operationId, expectedRevision, payloadHash: digest(payload),
});

/** A reducer that writes one plain entity row, the way every domain reducer ends up. */
const write = (entityId, data) => tx => tx.put(entityId, data);

const conflict = pattern => error => new RegExp(pattern).test(error.code ?? error.message);

test('F22 1-4: success, lost receipt, rebuilt host and a changed entity all return the original receipt', () => {
  const dir = tempDir('identity-f22');
  try {
    const request = command('message:m1', 'member:root', { value: 1 }, OP('f22-success-0001'), 0);
    let store = new ControlStore(dir);
    const receipt = store.commit(request, write('message:m1', { value: 1 }));
    assert.equal(receipt.status, 'confirmed');
    assert.equal(receipt.revision, 1);

    // (2) The same request again: the persisted operation record answers, the reducer does not run twice.
    let reductions = 0;
    const replay = store.commit(request, tx => {
      reductions += 1;
      return tx.put('message:m1', { value: 99 });
    });
    assert.deepEqual(replay, receipt, 'the original receipt comes back unchanged');
    assert.equal(reductions, 0, 'a replayed operation does not re-run its reducer');

    // (3) Receipt lost and the host rebuilt: a new store on the same directory still answers the original receipt.
    store.close();
    store = new ControlStore(dir);
    const afterRebuild = store.commit(request, write('message:m1', { value: 99 }));
    assert.deepEqual(afterRebuild, receipt);

    // (4) The entity moved on (revision 1 -> 2) between the original request and the resend.
    store.commit(command('message:m1', 'member:root', { value: 2 }, OP('f22-other-0001'), 1), write('message:m1', { value: 2 }));
    assert.equal(store.read('message:m1').revision, 2);
    const afterChange = store.commit(command('message:m1', 'member:root', { value: 1 }, OP('f22-success-0001'), 0), write('message:m1', { value: 3 }));
    assert.deepEqual(afterChange, receipt, 'a stale expectedRevision is execution metadata, not identity');
    assert.equal(store.read('message:m1').value, 2, 'the replay wrote nothing');

    // (5) A different actor, and the same actor with a different business payload, are explicit conflicts.
    assert.throws(() => store.commit(command('message:m1', 'member:other', { value: 1 }, OP('f22-success-0001'), 2), write('message:m1', { value: 4 })),
      conflict('OPERATION_CONFLICT|ID_CONFLICT'));
    assert.throws(() => store.commit(command('message:m1', 'member:root', { value: 7 }, OP('f22-success-0001'), 2), write('message:m1', { value: 5 })),
      conflict('OPERATION_CONFLICT|ID_CONFLICT'));
    assert.equal(store.read('message:m1').value, 2, 'a conflicted request wrote nothing');
    store.close();
  } finally {
    removeDir(dir);
  }
});

test('fence 1: the internal claim fence is execution metadata - a replay after a re-claim returns the receipt', () => {
  const dir = tempDir('identity-claim-fence');
  try {
    const store = new ControlStore(dir);
    const effect = 'effect:cancel-attempt-1';
    const settle = (expectedRevision) =>
      command(effect, 'scheduler', { result: 'ok' }, OP('f22-settle-0001'), expectedRevision);
    const receipt = store.commit(settle(0), write(effect, { status: 'confirmed', fence: 3 }));

    // The effect was re-claimed in between: the internal fence moved 3 -> 4 and the entity revision moved with it.
    store.commit(command(effect, 'scheduler', { reclaim: true }, OP('f22-reclaim-0001'), 1),
      write(effect, { status: 'applying', fence: 4 }));
    const replay = store.commit(settle(2), write(effect, { status: 'confirmed', fence: 99 }));
    assert.deepEqual(replay, receipt, 'the same business request returns the same receipt');
    assert.equal(store.read(effect).fence, 4, 'the replay did not touch the re-claimed row');
    store.close();
  } finally {
    removeDir(dir);
  }
});

test('fence 2: the attempt fence is business payload - the same operationId with fence 4 conflicts', () => {
  const dir = tempDir('identity-attempt-fence');
  try {
    const store = new ControlStore(dir);
    const attempt = 'attempt:a1';
    const finish = (fence, expectedRevision) =>
      command(attempt, 'member:root', { fence, status: 'produced' }, OP('f22-finish-0001'), expectedRevision);
    const receipt = store.commit(finish(3, 0), write(attempt, { lease: 'released', status: 'produced' }));
    assert.equal(receipt.status, 'confirmed');
    assert.throws(() => store.commit(finish(4, 1), write(attempt, { lease: 'released', status: 'produced' })),
      conflict('OPERATION_CONFLICT|ID_CONFLICT'),
      'a different attempt fence under one operationId is another request');
    assert.equal(store.read(attempt).revision, 1, 'the conflicting write did not land');
    store.close();
  } finally {
    removeDir(dir);
  }
});
// ----------------------------------------------------------------------------------------------------------------
// F22 through the real stack: gateway -> TeamCore -> ControlStore. The store-level cases above prove the reducer;
// these prove the operation id the caller supplied actually reaches the durable operation record.
const COMMANDS = Object.freeze({
  'task.write': {
    kind: 'business',
    reduce: (tx, current, payload) => tx.put(payload.entityId, { value: payload.value, writtenBy: payload.writtenBy ?? null }),
  },
});

async function openGatewayHost(dir, store) {
  const core = new TeamCore(store, {}, { enabled: true, attach: true, teamId: 'team:gw' });
  const host = createTeamHost({
    teamId: 'team:gw', root: dir, ownerSessionId: 'session:gw', commands: COMMANDS, core,
    recoverer: async () => ({ status: 'ok', admission: true }),
    openStore: () => store,
  });
  await host.start();
  return host;
}

const gatewayRequest = (operationId, payload, actor = 'root') => ({
  requestId: 'req-' + operationId.slice(-4), teamId: 'team:gw', actor, operationId,
  payload: { entityId: 'task:x', command: 'task.write', ...payload },
});

test('F22 (gateway): the caller operationId is the durable identity across a rebuilt host', async () => {
  const dir = tempDir('identity-gateway');
  const storeDir = path.join(dir, 'store');
  try {
    let store = new ControlStore(storeDir);
    let host = await openGatewayHost(dir, store);
    const request = gatewayRequest(OP('gw-write-0001'), { value: 1 });
    const first = host.command(request);
    assert.equal(first.operationId, OP('gw-write-0001'), 'the receipt carries the caller operationId');
    assert.equal(host.status().state, 'running');
    assert.equal(store.read('task:x').revision, 1);
    // stop() closes the store port; the durable operation row is what the rebuilt host will read.
    await host.stop();

    // Rebuilt host, new epoch, new in-memory receipts: the durable operation record still answers.
    store = new ControlStore(storeDir);
    host = await openGatewayHost(dir, store);
    const replay = host.command({ ...request, requestId: 'req-replay' });
    assert.deepEqual(replay.result, first.result, 'the rebuilt host returns the original result');
    assert.equal(store.read('task:x').revision, 1, 'the replay wrote nothing');
    await host.stop();
  } finally {
    removeDir(dir);
  }
});

test('F22 (gateway): an entity changed between requests does not turn a replay into a conflict', async () => {
  const dir = tempDir('identity-gateway-changed');
  const storeDir = path.join(dir, 'store');
  try {
    const store = new ControlStore(storeDir);
    const host = await openGatewayHost(dir, store);
    const first = host.command(gatewayRequest(OP('gw-changed-0001'), { value: 1 }));
    host.command(gatewayRequest(OP('gw-changed-0002'), { value: 2 }));
    assert.equal(store.read('task:x').revision, 2, 'the entity moved on');
    const replay = host.command(gatewayRequest(OP('gw-changed-0001'), { value: 1 }));
    assert.deepEqual(replay.result, first.result);
    assert.equal(store.read('task:x').value, 2, 'the replay wrote nothing');
    await host.stop();
  } finally {
    removeDir(dir);
  }
});

test('F22 (gateway): a different actor or a different payload under one operationId is OPERATION_CONFLICT', async () => {
  const dir = tempDir('identity-gateway-conflict');
  const storeDir = path.join(dir, 'store');
  try {
    const store = new ControlStore(storeDir);
    const host = await openGatewayHost(dir, store);
    host.command(gatewayRequest(OP('gw-conflict-0001'), { value: 1 }));
    // In this process the in-memory receipt answers first; the durable record is the same answer after a rebuild.
    // "adapter" is a different principal that core authorization admits, so the conflict comes from the durable
    // identity and not from the reference check in front of it.
    assert.throws(() => host.command(gatewayRequest(OP('gw-conflict-0001'), { value: 1 }, 'adapter')),
      error => error.code === 'OPERATION_CONFLICT');
    assert.throws(() => host.command(gatewayRequest(OP('gw-conflict-0001'), { value: 2 })),
      error => error.code === 'OPERATION_CONFLICT');
    await host.stop();

    // Rebuilt host: no in-memory receipt, so the durable record decides - and the answer is still OPERATION_CONFLICT,
    // not the store's internal ID_CONFLICT. (stop() already closed the first store.)
    const rebuilt = new ControlStore(storeDir);
    const second = await openGatewayHost(dir, rebuilt);
    try {
      assert.throws(() => second.command(gatewayRequest(OP('gw-conflict-0001'), { value: 1 }, 'adapter')),
        error => error.code === 'OPERATION_CONFLICT');
      assert.throws(() => second.command(gatewayRequest(OP('gw-conflict-0001'), { value: 2 })),
        error => error.code === 'OPERATION_CONFLICT');
      assert.equal(rebuilt.read('task:x').value, 1, 'a conflicted request wrote nothing');
    } finally {
      await second.stop();
    }
    // stop() closed the port; a read now proves the handle is gone before the temp directory is removed.
    assert.throws(() => rebuilt.read('task:x'), error => error.code === 'ERR_INVALID_STATE');
  } finally {
    removeDir(dir);
  }
});
