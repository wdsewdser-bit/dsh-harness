import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore, capacityStatus, providerObserver, PROVIDER_WINDOW_MS } from '../../core/index.mjs';
import { createOwnerControl, installLlmExecutionEntries } from '../llm-execution.mjs';

/**
 * Gap 3 (docs/decisions/superagent-borrow-integration.md): the fake transport below is the only "provider" in this
 * file. It never opens a socket, never contacts 127.0.0.1:8317/<gateway-port> and bills nothing; it returns a real 429 shape,
 * a real Retry-After header and a real pool-exhaustion error so the classification and the recovery rule run against
 * the same llm/stream entry the product uses.
 */
function fixture(now = () => 1_000_000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-throttle-'));
  const store = new ControlStore(dir);
  const core = new TeamCore(store, {}, { enabled: true, attach: true, teamId: 'team:p', maxRuns: 2,
    superagentBorrow: 'v1', intentSemantics: 'root-decision-v1' });
  core.member('member:root', 'root');
  core.mutate('decision:d1', 'adapter', {}, tx => tx.put('decision:d1',
    { kind: 'coordination', state: 'open', openedFor: 'member:root', options: ['approve'] }));
  let listener = null;
  const ctx = { on(name, handler) { if (name === 'llm/stream') listener = handler; return () => {}; },
    llm: { executionPermitContract: 'execution-permit/1', registration: () => ({ adapter: null }) } };
  const module = { withExecutionCall: (call, work) => work(), isExecutionTargetTrusted: () => true };
  installLlmExecutionEntries({ ctx, scopes: { resolve: () => null, current: () => null }, memberOfSession: () => false,
    sessionId: () => 'owner', authorizeHost: work => work(), moduleReady: Promise.resolve(module), autonomy: false,
    transportReady: () => true, hostSessionAuthorized: () => true, ownerControl: null,
    observeProvider: providerObserver(core, now) });
  const binding = { teamId: 'team:p', kind: 'owner', memberId: 'member:root', routed: true,
    ownerSessionId: 'owner', sessionId: 'owner', epoch: 'epoch:1',
    generation: store.read('member:root').generation };
  const control = () => createOwnerControl({ core, ctx: { on: () => () => {} }, teamId: 'team:p',
    ownerSessionId: 'owner', epoch: 'epoch:1', now });
  const stream = async next => {
    const items = [];
    for await (const item of listener({ sessionId: 'owner', provider: 'offline' }, next)) items.push(item);
    return items;
  };
  return { dir, store, core, binding, control, stream,
    close() { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const finish = () => (async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; })();
const throttle = (retryAfter = '2') => {
  const error = Object.assign(Error('fake provider throttled'), { status: 429, headers: { 'retry-after': retryAfter } });
  return () => (async function* () { throw error; })();
};
const poolFull = () => {
  const error = Object.assign(Error('connection pool exhausted'), { code: 'POOL_EXHAUSTED' });
  return () => (async function* () { throw error; })();
};

test('gap 3 fake transport: a 429 with Retry-After is throttled, occupies no H slot and defers new owner work', async () => {
  const clock = { t: 1_000_000 };
  const f = fixture(() => clock.t);
  try {
    const next = throttle('2');
    const thrown = await f.stream(next).then(() => null, error => error);
    assert.equal(thrown?.status, 429, 'the observation never swallows the provider error');
    let status = capacityStatus(f.core, clock.t);
    assert.equal(status.providerCapacity, 'throttled');
    assert.equal(status.providerRetryAfterMs, 2000);
    assert.equal(status.providerRecoveryAt, clock.t + 2000);
    assert.equal(status.providerWait, 'provider-throttled');
    assert.equal(f.store.list('control-slot:').length, 0, 'nothing was held to classify the limit');
    assert.equal(f.store.list('attempt:').length, 0);

    const control = f.control();
    const deferred = await control.run(f.binding, async () => ({ executed: true }), { originRef: 'decision:d1' });
    assert.deepEqual(deferred, { deferred: true, reason: 'PROVIDER_THROTTLED' });
    assert.equal(f.store.list('control-slot:').length, 0, 'a throttled window holds no local H slot');
    assert.equal(f.store.list('execution-outcome:').length, 0, 'and leaves no partial outcome behind');

    // A response inside the announced window does not revoke the provider's own Retry-After.
    clock.t += 500;
    await f.stream(finish);
    status = capacityStatus(f.core, clock.t);
    assert.equal(status.providerCapacity, 'throttled');
    assert.equal((await control.run(f.binding, async () => ({ executed: true }), { originRef: 'decision:d1' })).reason,
      'PROVIDER_THROTTLED');

    // The window ends and a real response arrives: only that pair is a recovery.
    clock.t += 1500;
    assert.equal(capacityStatus(f.core, clock.t).providerCapacity, 'unknown', 'an elapsed window alone is not a recovery');
    await f.stream(finish);
    assert.equal(capacityStatus(f.core, clock.t).providerCapacity, 'available');
    const admitted = await control.run(f.binding, async () => ({ executed: true }), { originRef: 'decision:d1' });
    assert.equal(admitted.executed, true, JSON.stringify(admitted));
    assert.equal(f.store.list('control-slot:').length, 1, 'recovery admits owner work again');
    control.stop();
  } finally { f.close(); }
});

test('gap 3 fake transport: a saturated pool is throttled with the default observation window, not unknown', async () => {
  const clock = { t: 2_000_000 };
  const f = fixture(() => clock.t);
  try {
    await f.stream(poolFull()).then(() => null, error => error);
    const status = capacityStatus(f.core, clock.t);
    assert.equal(status.providerCapacity, 'throttled');
    assert.equal(status.providerRetryAfterMs, null);
    assert.equal(status.providerRecoveryAt, clock.t + PROVIDER_WINDOW_MS);
    assert.equal(status.providerWait, 'provider-throttled');
    assert.equal((await f.control().run(f.binding, async () => ({ executed: true }), { originRef: 'decision:d1' })).reason,
      'PROVIDER_THROTTLED');
    clock.t += PROVIDER_WINDOW_MS;
    assert.equal(capacityStatus(f.core, clock.t).providerCapacity, 'unknown');
  } finally { f.close(); }
});

test('gap 3 evidence missing: an unclassifiable transport error stays unknown and never defers as if throttled', async () => {
  const clock = { t: 3_000_000 };
  const f = fixture(() => clock.t);
  try {
    const next = () => (async function* () { throw Error('stream exploded'); })();
    const thrown = await f.stream(next).then(() => null, error => error);
    assert.match(thrown.message, /stream exploded/);
    const status = capacityStatus(f.core, clock.t);
    assert.equal(status.providerCapacity, 'unknown', 'no evidence is unknown, never available');
    // The one queued coordination decision is a local wait; an unknown provider adds no claim and no freeze.
    assert.equal(status.providerWait, 'local-queued');
    assert.equal(f.store.list('provider-capacity:').length, 0, 'an unclassifiable error writes no fact');
    const result = await f.control().run(f.binding, async () => ({ executed: true }), { originRef: 'decision:d1' });
    assert.equal(result.executed, true, 'unknown adds no freeze of its own');
    assert.equal(f.store.list('control-slot:').length, 1);
  } finally { f.close(); }
});

test('gap 3 success path: a completed response is evidence of availability and is written once', async () => {
  const clock = { t: 4_000_000 };
  const f = fixture(() => clock.t);
  try {
    assert.equal(capacityStatus(f.core, clock.t).providerCapacity, 'unknown');
    await f.stream(finish);
    assert.equal(capacityStatus(f.core, clock.t).providerCapacity, 'available');
    const writes = () => f.store.events().filter(event => event.entity === 'provider-capacity:latest').length;
    assert.equal(writes(), 1);
    await f.stream(finish);
    assert.equal(writes(), 1, 'a steady provider does not grow the journal per call');
  } finally { f.close(); }
});
