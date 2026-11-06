import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
import { id, operationIdPattern } from '../../contracts/index.mjs';
import assert from 'node:assert/strict';
import { createCoreAccess, createRestrictedTx } from '../src/core-access.mjs';
import { createTeamHost } from '../index.mjs';
import { InflightRegistry } from '../src/inflight.mjs';

/**
 * Counterexamples for the controlled write ports (design §3.4, §3.5): a route that can be talked into another
 * route's work is the bug these tests exist to catch, so every test here asserts a refusal and then asserts that the
 * refused transaction left nothing behind.
 */


import { rule, cleanups, realCore, world, open, codeOf } from '../test-support/core-access-fixtures.mjs';

function attached(core, state = 'running') {
  const w = world({ state });
  w.ports = createCoreAccess({ core, teamId: 'team:ca', epoch: () => w.epoch, state: () => w.state,
    token: () => w.token, ownership: () => w.owns, inflight: w.inflight, now: () => w.at });
  return w;
}

function snapshot(store) { return { rows: store.list(), effects: store.effects(), events: store.events() }; }

test('real safety/recovery patches preserve omitted fields and rollback every unauthorized write', () => {
  const { core } = realCore({ 'attempt:a1': { lease: 'active', fence: 2, status: 'active', owner: 'member:1', taskId: 'task:t1' } });
  const w = attached(core);
  const input = { ...rule };
  const cap = w.ports.safety({ cause: 'operator-stop', subject: input, commands: ['close'],
    fields: { '*': ['status'] }, outboxKinds: ['cancel'] });
  assert.throws(() => cap.fields['*'].push('owner'), TypeError);
  input.attemptId = 'attempt:outside';
  const run = reducer => cap.mutate('attempt:a1', 'operator', { command: 'close' }, reducer);
  run(tx => tx.put('attempt:a1', { status: 'cancelled' }));
  assert.equal(core.store.read('attempt:a1').owner, 'member:1');
  assert.equal(core.store.read('attempt:a1').lease, 'active');
  for (const bad of [
    tx => tx.put('attempt:a1', { owner: 'attacker' }),
    tx => tx.put('attempt:a1', { owner: undefined }),
    tx => tx.put('attempt:outside', { status: 'cancelled' }),
    tx => tx.outbox('effect:outside', { kind: 'cancel', attemptId: 'attempt:a1' }),
    tx => tx.outbox(rule.effectId, { kind: 'cancel', attemptId: 'attempt:outside' }),
    tx => tx.outbox(rule.effectId, { kind: 'cancel', attemptId: 'attempt:a1', owner: 'member:outside' }),
    tx => tx.outbox(rule.effectId, { kind: 'cancel', attemptId: 'attempt:a1', taskId: 'task:outside' }),
    tx => tx.outbox(rule.effectId, { kind: 'cancel', attemptId: 'attempt:a1', entityId: 'member:outside' }),
  ]) {
    const before = snapshot(core.store);
    assert.throws(() => run(tx => { tx.put('attempt:a1', { status: 'failed' }); bad(tx); return null; }), { code: 'DENIED' });
    assert.deepEqual(snapshot(core.store), before);
  }
  w.state = 'recovering';
  const recovery = w.ports.recovery({ entities: ['attempt:a1'], fields: { '*': ['status'] }, outboxKinds: ['cancel'] });
  assert.throws(() => recovery.fields['*'].push('owner'), TypeError);
  const before = snapshot(core.store);
  assert.throws(() => recovery.mutate('attempt:a1', 'scheduler', {}, tx => {
    tx.put('attempt:a1', { status: 'unknown' });
    tx.outbox('recover-cancel:attempt:a1:2', { kind: 'cancel', attemptId: 'attempt:outside' });
  }), { code: 'DENIED' });
  assert.deepEqual(snapshot(core.store), before);
});

test('real managed reducer is scoped, requires command, and persists the bound operation identity', () => {
  const { core } = realCore({ 'effect:e1': { status: 'applying', owner: 'adapter' } });
  const w = attached(core), token = open(w), port = w.ports.managed({ token });
  const call = (tx, payload = { command: 'effect.settle' }) => port.mutate('effect:e1', 'adapter', payload, tx);
  for (const bad of [
    tx => tx.put('effect:other', { status: 'confirmed' }),
    tx => tx.put('effect:e1', { owner: 'attacker' }),
    tx => tx.put('effect:e1', { owner: undefined }),
    tx => tx.outbox('start:other', { kind: 'start', attemptId: 'attempt:other' }),
    tx => tx.put('effect:e1', { status: 'produced' }),
  ]) {
    const before = snapshot(core.store);
    assert.throws(() => call(tx => { tx.put('effect:e1', { status: 'confirmed' }); bad(tx); return null; }), { code: 'DENIED' });
    assert.deepEqual(snapshot(core.store), before);
  }
  const before = snapshot(core.store);
  assert.throws(() => call(() => null, {}), { code: 'MANAGED_MISMATCH' });
  assert.deepEqual(snapshot(core.store), before);
  const receipt = call(tx => tx.put('effect:e1', { status: 'confirmed' }));
  assert.equal(receipt.operationId, token.operationId);
  assert.equal(core.store.events().at(-1).operationId, token.operationId);
  assert.deepEqual(call(() => { throw Error('must replay'); }), receipt);
});

test('real internal operation ids are valid and unique even with a constant clock', () => {
  const { core } = realCore();
  const w = attached(core), port = w.ports.lifecycle();
  const beforeIdle = snapshot(core.store);
  assert.equal(port.reconcile(), null);
  assert.equal(port.reconcile(), null);
  assert.deepEqual(snapshot(core.store), beforeIdle, 'no expired claim means no journal or operation');
  const claim = port.claim('effect:e1', 'adapter');
  const safety = w.ports.safety({ cause: 'operator-stop', subject: rule, commands: ['claim', 'settle'] });
  const c = safety.claim(rule.effectId, 'operator');
  const d = safety.settle(rule.effectId, 1, { executed: true });
  const ids = core.store.events().slice(1).map(e => e.operationId);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(value => operationIdPattern.test(value)));
  assert.ok(operationIdPattern.test(claim.operationId));
  assert.notEqual(c.operationId, d.operationId);
  const before = snapshot(core.store);
  assert.throws(() => port.claim('effect:e1', 'adapter'), { code: 'NOT_CLAIMABLE' });
  assert.deepEqual(snapshot(core.store), before);
});

test('a real async port returns after stop begins and settles within the drain, never claims', async () => {
  const { core } = realCore();
  const w = attached(core);
  w.ports.lifecycle().claim('effect:e1', 'adapter');
  const token = open(w), port = w.ports.managed({ token });
  let release;
  const transport = new Promise(resolve => { release = resolve; });
  const result = transport.then(evidence => port.settle('effect:e1', 1, evidence));
  w.state = 'stopping'; w.token.revoked = true;
  const before = snapshot(core.store);
  assert.throws(() => w.ports.lifecycle().claim(rule.effectId, 'adapter'), { code: 'WRITE_REVOKED' });
  assert.deepEqual(snapshot(core.store), before);
  release({ executed: true });
  assert.equal((await result).operationId, token.operationId);
  assert.equal(core.store.effects().find(e => e.id === 'effect:e1').status, 'confirmed');
  w.inflight.clear();
  const after = snapshot(core.store);
  assert.throws(() => port.settle('effect:e1', 1, { executed: true }), { code: 'INFLIGHT_UNKNOWN' });
  assert.deepEqual(snapshot(core.store), after);
  w.state = 'isolated';
  assert.throws(() => port.settle('effect:e1', 1, { executed: true }), { code: 'WRITE_REVOKED' });
  assert.deepEqual(snapshot(core.store), after);
});
test('TeamHost.stop drains a real transport receipt through CA and rejects all new claims', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-real-stop-'));
  const store = new ControlStore(root);
  const core = new TeamCore(store, {}, { enabled: true, attach: true, teamId: 'team:ca' });
  core.mutate('seed', 'scheduler', {}, tx => {
    tx.outbox('cancel:attempt:a1', { kind: 'cancel', attemptId: 'attempt:a1' });
    tx.outbox('cancel:attempt:a2', { kind: 'cancel', attemptId: 'attempt:a2' });
    return null;
  });
  const host = createTeamHost({ root, teamId: 'team:ca', core, ownerSessionId: 'session:ca',
    commands: { 'effect.settle': { kind: 'business', completion: 'inflight', actor: 'adapter', reduce: () => null } },
    recoverer: async () => ({ status: 'ok', admission: true }), openStore: () => ({ close() {} }),
  });
  try {
    await host.start();
    host.coreAccess.lifecycle().claim('cancel:attempt:a1', 'adapter');
    const managed = host.openInflight({ operationId: id('operation'), command: 'effect.settle', entityId: 'cancel:attempt:a1', actor: 'adapter' });
    const port = host.coreAccess.managed({ token: managed.token });
    let reply;
    const transport = new Promise(resolve => { reply = resolve; });
    const receipt = transport.then(evidence => port.settle('cancel:attempt:a1', 1, evidence));
    const stopping = host.stop({ timeoutMs: 1000 });
    assert.equal(host.status().state, 'stopping');
    const before = snapshot(store);
    assert.throws(() => host.coreAccess.lifecycle().claim('cancel:attempt:a2', 'adapter'), { code: 'WRITE_REVOKED' });
    assert.throws(() => host.openInflight({ operationId: id('operation'), command: 'effect.settle', entityId: 'cancel:attempt:a2', actor: 'adapter' }), {
      code: 'HOST_NOT_RUNNING' });
    assert.deepEqual(snapshot(store), before);
    reply({ executed: true });
    assert.equal((await receipt).operationId, managed.token.operationId);
    managed.close();
    assert.equal((await stopping).drain, 'settled');
    assert.equal(store.effects().find(e => e.id === 'cancel:attempt:a1').status, 'confirmed');
    assert.equal(store.effects().find(e => e.id === 'cancel:attempt:a2').status, 'pending');
    const after = snapshot(store);
    assert.throws(() => port.settle('cancel:attempt:a1', 1, { executed: true }), { code: 'WRITE_REVOKED' });
    assert.deepEqual(snapshot(store), after);
  } finally { await host.stop(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('managed drain budget expiry rejects even a still-registered token with complete rollback', () => {
  const { core } = realCore();
  const w = world(); let withinBudget = true;
  const ports = createCoreAccess({ core, teamId: 'team:ca', state: () => w.state, epoch: () => w.epoch,
    ownership: () => true, token: () => w.token, inflight: w.inflight, drainWritable: () => withinBudget });
  ports.lifecycle().claim('effect:e1', 'adapter');
  const token = open(w), port = ports.managed({ token });
  w.state = 'stopping'; withinBudget = false;
  assert.equal(w.inflight.has(token), true);
  const before = snapshot(core.store);
  assert.throws(() => port.settle('effect:e1', 1, { executed: true }), { code: 'WRITE_REVOKED' });
  assert.deepEqual(snapshot(core.store), before);
});

test('real recovery rolls back authorized writes before every unauthorized field/entity/effect mutation', () => {
  const { core } = realCore({ 'attempt:a1': { lease: 'active', fence: 2, status: 'active' }, 'task:t1': { lastFence: 2, status: 'executing' } });
  const w = attached(core, 'recovering');
  const port = w.ports.recovery({ entities: ['attempt:a1', 'task:t1'],
    fields: { 'attempt:a1': ['lease', 'fence', 'status'], 'task:t1': ['lastFence'] }, outboxKinds: ['cancel'] });
  for (const bad of [
    tx => tx.put('attempt:a1', { owner: 'attacker' }),
    tx => tx.put('attempt:a1', { owner: undefined }),
    tx => tx.put('task:t1', { status: 'failed' }),
    tx => tx.put('member:other', { status: 'active' }),
    tx => tx.outbox('cancel:attempt:a1', { kind: 'cancel', attemptId: 'attempt:a1' }),
    tx => tx.outbox('recover-cancel:attempt:a1:3', { kind: 'cancel', attemptId: 'attempt:outside' }),
    tx => tx.outbox('recover-cancel:attempt:a1:999', { kind: 'cancel', attemptId: 'attempt:a1' }),
    tx => tx.outbox('recover-cancel:attempt:a1:3', { kind: 'cancel', attemptId: 'attempt:a1', owner: 'member:outside' }),
  ]) {
    const before = snapshot(core.store);
    assert.throws(() => port.mutate('attempt:a1', 'scheduler', {}, tx => {
      tx.put('attempt:a1', { lease: 'unknown', status: 'unknown', fence: 3 });
      tx.put('task:t1', { lastFence: 3 });
      bad(tx); return null;
    }), { code: 'DENIED' });
    assert.deepEqual(snapshot(core.store), before);
  }
});
test('safety claim and settle cannot treat another subject row as an effect', () => {
  const { core } = realCore();
  core.mutate('seed2', 'scheduler', {}, tx => { tx.outbox('attempt:a1', { kind: 'start', attemptId: 'attempt:a1' }); return null; });
  const w = attached(core);
  const cap = w.ports.safety({ cause: 'operator-stop', subject: rule, commands: ['claim', 'settle'] });
  const before = snapshot(core.store);
  assert.throws(() => cap.claim('attempt:a1', 'operator'), { code: 'DENIED' });
  assert.throws(() => cap.settle('attempt:a1', 1, { executed: true }), { code: 'DENIED' });
  assert.deepEqual(snapshot(core.store), before);
  cap.claim(rule.effectId, 'operator');
  cap.settle(rule.effectId, 1, { executed: true });
  assert.equal(core.store.effects().find(e => e.id === rule.effectId).status, 'confirmed');
});
test('real restricted patches retain run-slot occupancy and rollback newly inserted outbox rows', () => {
  const { core } = realCore({ 'attempt:a1': { lease: 'active', status: 'active', fence: 2 } });
  const w = attached(core);
  const subject = { attemptId: 'attempt:a1', effectId: 'cancel:attempt:a1' };
  const cap = w.ports.safety({ cause: 'operator-stop', subject, commands: ['close'],
    fields: { 'attempt:a1': ['status'] }, outboxKinds: ['cancel'] });
  const before = snapshot(core.store);
  assert.throws(() => cap.mutate('attempt:a1', 'operator', { command: 'close' }, tx => {
    tx.outbox(subject.effectId, { kind: 'cancel', attemptId: subject.attemptId });
    tx.put(subject.attemptId, { owner: 'attacker' });
    return null;
  }), { code: 'DENIED' });
  assert.deepEqual(snapshot(core.store), before);
  cap.mutate(subject.attemptId, 'operator', { command: 'close' }, tx => {
    tx.put(subject.attemptId, { status: 'unknown' });
    tx.outbox(subject.effectId, { kind: 'cancel', attemptId: subject.attemptId });
    return null;
  });
  assert.ok(core.store.effects().some(e => e.id === subject.effectId));
  assert.equal(core.store.read(subject.attemptId).lease, 'active');
  const occupied = snapshot(core.store);
  assert.throws(() => core.mutate('attempt:other', 'scheduler', {}, tx => tx.put('attempt:other', {
    lease: 'active', owner: 'member:1', taskId: 'task:other', fence: 1,
  })), /UNIQUE constraint/);
  assert.deepEqual(snapshot(core.store), occupied);
});

for (const timeoutMs of [0, 1000]) {
  test('TeamHost stopping listener enforces the published drain deadline: budget ' + timeoutMs, async () => {
    const { core } = realCore();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-stop-listener-'));
    const host = createTeamHost({ root, teamId: 'team:ca', core, ownerSessionId: 'session:listener',
      commands: { 'effect.settle': { kind: 'business', completion: 'inflight', actor: 'adapter', reduce: () => null } },
      recoverer: async () => ({ status: 'ok', admission: true }), openStore: () => ({ close() {} }),
    });
    try {
      await host.start();
      host.coreAccess.lifecycle().claim('effect:e1', 'adapter');
      const managed = host.openInflight({ operationId: id('operation'), command: 'effect.settle', entityId: 'effect:e1', actor: 'adapter' });
      const port = host.coreAccess.managed({ token: managed.token });
      const before = snapshot(core.store);
      let called = false, error = null, receipt;
      host.onStateChange(({ to }) => {
        if (to !== 'stopping') return;
        called = true;
        // Capture failures outside the listener: the machine deliberately isolates listener exceptions.
        try { receipt = port.settle('effect:e1', 1, { executed: true }); } catch (e) { error = e; }
        managed.close();
      });
      await host.stop({ timeoutMs });
      assert.equal(called, true);
      if (timeoutMs === 0) {
        assert.equal(error?.code, 'WRITE_REVOKED');
        assert.equal(receipt, undefined);
        assert.deepEqual(snapshot(core.store), before);
      } else {
        assert.equal(error, null);
        assert.equal(receipt.operationId, managed.token.operationId);
        assert.equal(core.store.effects().find(e => e.id === 'effect:e1').status, 'confirmed');
      }
    } finally { await host.stop(); fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test('real managed settle replays the original receipt after an effect is claimed with a new fence', () => {
  const { core } = realCore();
  const w = attached(core), lifecycle = w.ports.lifecycle();
  lifecycle.claim('effect:e1', 'adapter');
  const token = open(w), port = w.ports.managed({ token });
  // Successful receipt recording, but external IO was not executed: effect becomes retryable.
  const receipt = port.settle('effect:e1', 1, { notExecuted: true });
  assert.equal(receipt.status, 'confirmed');
  assert.equal(receipt.result.status, 'retryable');
  w.inflight.clear();
  w.at = Date.now() + 2000;
  lifecycle.claim('effect:e1', 'adapter');
  const current = core.store.effects().find(e => e.id === 'effect:e1');
  assert.equal(current.status, 'applying');
  assert.equal(current.fence, 2);
  const replayToken = open(w, { operationId: token.operationId });
  const replay = w.ports.managed({ token: replayToken });
  const before = snapshot(core.store);
  assert.deepEqual(replay.settle('effect:e1', 2, { notExecuted: true }), receipt);
  assert.deepEqual(snapshot(core.store), before);
});

test('real managed business payload fences remain part of the stable identity', () => {
  const { core } = realCore();
  const w = attached(core), port = w.ports.managed({ token: open(w) });
  const receipt = port.mutate('effect:e1', 'adapter', { command: 'effect.settle', fence: 3 }, () => null);
  assert.equal(receipt.status, 'confirmed');
  const before = snapshot(core.store);
  assert.throws(() => port.mutate('effect:e1', 'adapter', { command: 'effect.settle', fence: 4 }, () => null), { code: 'ID_CONFLICT' });
  assert.deepEqual(snapshot(core.store), before);
});

test('real restricted patches snapshot getters and reject nested, array, own __proto__ and undefined changes', () => {
  const seed = { status: 'active', metadata: { nested: { owner: 'member:1' } }, items: [{ owner: 'member:1' }] };
  const { core } = realCore({ 'attempt:a1': seed });
  const w = attached(core);
  const cap = w.ports.safety({ cause: 'operator-stop', subject: rule, commands: ['close'], fields: { '*': ['status'] } });
  const run = data => cap.mutate('attempt:a1', 'operator', { command: 'close' }, tx => { tx.put('attempt:a1', data); return null; });
  let reads = 0;
  run({ get status() { return ++reads === 1 ? 'cancelled' : 'produced'; }, metadata: structuredClone(seed.metadata), items: structuredClone(seed.items) });
  assert.equal(reads, 1);
  const row = core.store.read('attempt:a1');
  assert.equal(row.status, 'cancelled');
  assert.deepEqual(row.metadata, seed.metadata);
  assert.deepEqual(row.items, seed.items);
  assert.equal(row.owner, 'member:1');
  assert.equal(row.taskId, 'task:t1');
  for (const data of [
    { status: 'failed', metadata: { nested: { owner: 'attacker' } } },
    { status: 'failed', items: [{ owner: 'attacker' }] },
    JSON.parse('{"status":"failed","__proto__":{"polluted":true}}'),
    { status: 'failed', metadata: undefined },
    { status: undefined },
  ]) {
    const before = snapshot(core.store);
    assert.throws(() => run(data), { code: Object.hasOwn(data, 'status') && data.status === undefined ? 'INVALID_JSON' : 'DENIED' });
    assert.deepEqual(snapshot(core.store), before);
  }
  assert.equal({}.polluted, undefined);
});


