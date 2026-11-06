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

test('managed: a token only closes the entity and actor it was opened for', () => {
  const { core, applied } = realCore();
  const w = world();
  w.ports = createCoreAccess({
    teamId: 'team:ca', core, epoch: () => w.epoch, state: () => w.state, token: () => w.token,
    ownership: () => w.owns, failure: () => w.failed, inflight: w.inflight, now: () => w.at,
  });
  const token = open(w);
  const port = w.ports.managed({ token });
  assert.equal(port.route, 'managed');
  // Its own entity and actor: accepted.
  assert.equal(port.mutate('effect:e1', 'adapter', { v: 1, command: 'effect.settle' }, () => 'ok').status, 'confirmed');
  // Another entity, the same actor: refused.
  assert.equal(codeOf(() => port.mutate('effect:e2', 'adapter', { v: 2 }, () => 'ok')), 'MANAGED_MISMATCH');
  // Its own entity, another actor: refused.
  assert.equal(codeOf(() => port.mutate('effect:e1', 'member:other', { v: 3 }, () => 'ok')), 'MANAGED_MISMATCH');
  // The facts object cannot re-point the token either.
  const rebound = w.ports.managed({ token, facts: { entityId: 'effect:e2' } });
  assert.equal(codeOf(() => rebound.mutate('effect:e2', 'adapter', { v: 4 }, () => 'ok')), 'MANAGED_MISMATCH');
  // Exactly one transaction ran: the four refused calls never reached the core.
  assert.deepEqual(applied.filter(item => item.via === 'mutate').map(item => item.entityId + '/' + item.actor), ['effect:e1/adapter']);
});

test('managed: the drain period accepts receipts and never a new claim', () => {
  const { core } = realCore();
  const w = world();
  w.ports = createCoreAccess({
    teamId: 'team:ca', core, epoch: () => w.epoch, state: () => w.state, token: () => w.token,
    ownership: () => w.owns, failure: () => w.failed, inflight: w.inflight, now: () => w.at,
  });
  const token = open(w);
  const port = w.ports.managed({ token });
  // There is no claim and no lifecycle token on this route: a new claim in the drain window is impossible by shape.
  assert.equal(port.claim, undefined);
  assert.equal(codeOf(() => port.claim?.('effect:e1', 'adapter')), 'no-throw');
  // Existing receipt stays valid after stop begins.
  w.state = 'stopping';
  assert.equal(port.mutate('effect:e1', 'adapter', { v: 1, command: 'effect.settle' }, () => 'ok').status, 'confirmed');
  w.state = 'stopped';
  assert.equal(codeOf(() => port.settle('effect:e1', 1, { executed: true })), 'WRITE_REVOKED');
  // The ordinary route's claim is closed the moment the lifecycle token is revoked.
  const lifecycle = w.ports.lifecycle();
  w.token.revoked = true;
  assert.equal(codeOf(() => lifecycle.claim('effect:e1', 'adapter')), 'WRITE_REVOKED');
});

test('managed: settle only for its own effect, and only while the token is live', () => {
  const { core, applied } = realCore();
  const w = world();
  w.ports = createCoreAccess({
    teamId: 'team:ca', core, epoch: () => w.epoch, state: () => w.state, token: () => w.token,
    ownership: () => w.owns, failure: () => w.failed, inflight: w.inflight, now: () => w.at,
  });
  const token = open(w);
  const port = w.ports.managed({ token });
  w.ports.lifecycle().claim('effect:e1', 'adapter');
  assert.equal(port.settle('effect:e1', 1, { executed: true }).status, 'confirmed');
  assert.equal(codeOf(() => port.settle('effect:other', 3, { executed: true })), 'MANAGED_MISMATCH');
  // A new epoch invalidates the token even while it is still open.
  w.epoch = 8;
  assert.equal(codeOf(() => port.settle('effect:e1', 4, { executed: true })), 'STALE_EPOCH');
  assert.equal(applied.filter(item => item.via === 'settle').length, 1);
});

test('safety: the subject is an exact id, not a substring and not a prefix', () => {
  const { core, applied } = realCore();
  const w = world();
  w.ports = createCoreAccess({
    teamId: 'team:ca', core, epoch: () => w.epoch, state: () => w.state, token: () => w.token,
    ownership: () => w.owns, failure: () => w.failed, inflight: w.inflight, now: () => w.at,
  });
  const capability = w.ports.safety({
    cause: 'operator-stop', subject: rule, commands: ['cancel-attempt', 'settle'],
    fields: { '*': ['status', 'reason'] }, outboxKinds: ['cancel'],
  });
  const write = () => capability.mutate('attempt:a1', 'operator', { command: 'cancel-attempt' }, tx => tx.put('attempt:a1', { status: 'cancelled', reason:
    'stop' }));
  assert.equal(write().status, 'confirmed');
  // An id that merely contains or extends the subject is a different row.
  for (const outside of ['attempt:a1-extra', 'x-attempt:a1', 'attempt:a1:suffix', 'attempt:a']) {
    assert.equal(codeOf(() => capability.mutate(outside, 'operator', { command: 'cancel-attempt' }, () => 'ok')), 'DENIED', outside);
  }
  assert.equal(applied.filter(item => item.via === 'write').length, 1);
});

test('safety: expiry, stop, revocation and epoch are re-checked on every call', () => {
  const { core } = realCore();
  const w = world({ at: 1000 });
  w.ports = createCoreAccess({
    teamId: 'team:ca', core, epoch: () => w.epoch, state: () => w.state, token: () => w.token,
    ownership: () => w.owns, failure: () => w.failed, inflight: w.inflight, now: () => w.at,
  });
  const mint = () => w.ports.safety({
    cause: 'operator-stop', subject: rule, commands: ['settle'], fields: { '*': ['status'] },
    expiresAt: 2000,
  });
  const expired = mint();
  w.at = 2001;
  assert.equal(codeOf(() => expired.settle('effect:cancel-a1', 1, { executed: true })), 'SAFETY_EXPIRED');
  w.at = 1000;

  const stopped = mint();
  w.state = 'stopping';
  assert.equal(codeOf(() => stopped.settle('effect:cancel-a1', 1, { executed: true })), 'WRITE_REVOKED');
  w.state = 'running';

  const revoked = mint();
  revoked.revoke();
  assert.equal(codeOf(() => revoked.settle('effect:cancel-a1', 1, { executed: true })), 'WRITE_REVOKED');
  assert.equal(revoked.revoked, true);

  const stale = mint();
  w.epoch = 8;
  assert.equal(codeOf(() => stale.settle('effect:cancel-a1', 1, { executed: true })), 'STALE_EPOCH');
  w.epoch = 7;

  const unowned = mint();
  w.owns = false;
  assert.equal(codeOf(() => unowned.settle('effect:cancel-a1', 1, { executed: true })), 'OWNERSHIP_LOST');
});

test('safety: empty or violated whitelists reject inside the transaction', () => {
  const { core, rows, applied } = realCore({ 'attempt:a1': { status: 'active', reason: 'old', owner: 'member:1' } });
  const w = world();
  w.ports = createCoreAccess({
    teamId: 'team:ca', core, epoch: () => w.epoch, state: () => w.state, token: () => w.token,
    ownership: () => w.owns, failure: () => w.failed, inflight: w.inflight, now: () => w.at,
  });
  // Empty command whitelist: every safety write is refused, even with a valid subject.
  const noCommands = w.ports.safety({ cause: 'operator-stop', subject: rule, fields: { '*': ['status'] } });
  assert.equal(codeOf(() => noCommands.mutate('attempt:a1', 'operator', { command: 'settle' }, () => 'ok')), 'DENIED');
  // Empty field whitelist: the entity may be written but no field is allowed.
  const noFields = w.ports.safety({ cause: 'operator-stop', subject: rule, commands: ['settle'] });
  assert.equal(codeOf(() => noFields.mutate('attempt:a1', 'operator', { command: 'settle' }, tx => tx.put('attempt:a1', { status: 'cancelled' }))), 'DENIED');
  // A field outside the whitelist is refused by the transaction, and the permitted field is not written either.
  const scoped = w.ports.safety({ cause: 'operator-stop', subject: rule, commands: ['settle'], fields: { '*': ['status'] } });
  assert.equal(codeOf(() => scoped.mutate('attempt:a1', 'operator', { command: 'settle' },
    tx => tx.put('attempt:a1', { status: 'cancelled', owner: 'operator' }))), 'DENIED');
  assert.equal(rows.get('attempt:a1').owner, 'member:1');
  assert.equal(rows.get('attempt:a1').status, 'active');
  // An outbox kind outside the whitelist is refused as well.
  assert.equal(codeOf(() => scoped.mutate('attempt:a1', 'operator', { command: 'settle' },
    tx => tx.outbox('cancel:attempt:a1', { kind: 'produce' }))), 'DENIED');
  assert.equal(applied.filter(item => item.via === 'write').length, 0);
});

test('recovery: empty whitelists deny everything and outside entities never reach the reducer', () => {
  const { core, applied } = realCore({ 'attempt:a1': { lease: 'active', fence: 2 }, 'task:t1': { lastFence: 2 } });
  const w = world({ state: 'recovering' });
  w.ports = createCoreAccess({
    teamId: 'team:ca', core, epoch: () => w.epoch, state: () => w.state, token: () => w.token,
    ownership: () => w.owns, failure: () => w.failed, inflight: w.inflight, now: () => w.at,
  });
  const empty = w.ports.recovery();
  assert.equal(codeOf(() => empty.mutate('attempt:a1', 'scheduler', { recovery: true }, () => 'ok')), 'DENIED');
  const scoped = w.ports.recovery({
    entities: ['attempt:*', 'task:*'], fields: { 'attempt:*': ['lease', 'fence'], 'task:*': ['lastFence'] },
    outboxKinds: ['cancel'],
  });
  // Outside the whitelist entirely.
  assert.equal(codeOf(() => scoped.mutate('member:m1', 'scheduler', { recovery: true }, () => 'ok')), 'DENIED');
  // A field the transition does not own (task status is not part of the recovery contract).
  assert.equal(codeOf(() => scoped.mutate('task:t1', 'scheduler', { recovery: true }, tx => tx.put('task:t1', { lastFence: 3, status: 'failed' }))), 'DENIED');
  // A write to a row that passes the entity filter but was not the call's target is still filtered.
  assert.equal(codeOf(() => scoped.mutate('attempt:a1', 'scheduler', { recovery: true }, tx => tx.put('member:m1', { role: 'root' }))), 'DENIED');
  // The legitimate transition lands, including its cancel row.
  const receipt = scoped.mutate('attempt:a1', 'scheduler', { recovery: true }, tx => {
    tx.put('attempt:a1', { lease: 'unknown', fence: 3 });
    tx.put('task:t1', { lastFence: 3 });
    tx.outbox('recover-cancel:attempt:a1:3', { kind: 'cancel', attemptId: 'attempt:a1' });
  });
  assert.equal(receipt.status, 'confirmed');
  assert.equal(applied.filter(item => item.via === 'write').length, 3);
  // Closed outside the recovering window.
  w.state = 'running';
  assert.equal(codeOf(() => scoped.mutate('attempt:a1', 'scheduler', { recovery: true }, () => 'ok')), 'RECOVERY_WINDOW_CLOSED');
});

test('restricted transactions never expose the raw channel', () => {
  const seen = [];
  const raw = {
    read: () => null, list: () => [], latestEventSeq: () => 0,
    put: (...args) => seen.push(['put', ...args]), outbox: (...args) => seen.push(['outbox', ...args]),
    inbox: (...args) => seen.push(['inbox', ...args]), cursor: (...args) => seen.push(['cursor', ...args]),
  };
  const tx = createRestrictedTx(raw, { entities: ['attempt:a1'], fields: { 'attempt:a1': ['status'] }, outboxKinds: ['cancel'] });
  assert.deepEqual(Object.keys(tx).sort(), ['cursor', 'inbox', 'latestEventSeq', 'list', 'outbox', 'put', 'read']);
  assert.equal(codeOf(() => tx.inbox('src', 'e1')), 'DENIED');
  assert.equal(codeOf(() => tx.cursor('c1', 3)), 'DENIED');
  assert.equal(codeOf(() => tx.put('attempt:a1', { status: 'unknown', owner: 'x' })), 'DENIED');
  assert.equal(codeOf(() => tx.put('attempt:a2', { status: 'unknown' })), 'DENIED');
  assert.equal(codeOf(() => tx.outbox('row', { kind: 'start' })), 'DENIED');
  assert.equal(seen.length, 0);
  tx.put('attempt:a1', { status: 'unknown' });
  assert.deepEqual(seen, [['put', 'attempt:a1', { status: 'unknown' }]]);
});

