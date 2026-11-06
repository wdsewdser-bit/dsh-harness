import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore, capacityStatus, capacityUsage, providerFailureObservation, providerOutcome, providerWait,
  recordProviderObservation, PROVIDER_CAPACITY_ROW, PROVIDER_EVIDENCE_TTL_MS, PROVIDER_WINDOW_MS } from '../index.mjs';

const team = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-capacity-'));
  const store = new ControlStore(dir);
  const core = new TeamCore(store, {}, { enabled: true, attach: true, teamId: 'team:p', maxRuns: 2,
    superagentBorrow: 'v1', intentSemantics: 'root-decision-v1' });
  return { dir, store, core, writes: () => store.events().filter(event => event.entity === PROVIDER_CAPACITY_ROW).length,
    close() { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
};
const queueWork = (core, id) => core.mutate(id, 'adapter', {}, tx => tx.put(id, { status: 'ready' }));

test('gap 3 classification: 429/Retry-After and a saturated pool are throttled, transport failures are unknown', () => {
  const now = 1_000_000;
  const limited = providerFailureObservation(Object.assign(Error('fake provider throttled'), { status: 429 }), now);
  assert.equal(limited.state, 'throttled');
  assert.equal(limited.reason, 'provider-rate-limit');
  assert.equal(limited.retryAfterMs, null, 'no Retry-After means the default observation window, not "no limit"');
  assert.equal(limited.windowMs, PROVIDER_WINDOW_MS);

  const seconds = providerFailureObservation(Object.assign(Error('429'), { status: 429, headers: { 'retry-after': '7' } }), now);
  assert.equal(seconds.retryAfterMs, 7000);
  const mapped = providerFailureObservation(Object.assign(Error('429'), { statusCode: 429,
    headers: { get: name => name === 'retry-after' ? '3' : null } }), now);
  assert.equal(mapped.retryAfterMs, 3000, 'a Headers-like object is read through get()');
  const dated = providerFailureObservation(Object.assign(Error('429'), { status: 429,
    headers: { 'Retry-After': new Date(now + 5000).toUTCString() } }), now);
  assert.equal(dated.retryAfterMs, 5000, 'an HTTP date is an absolute instant, not a duration');

  const pool = providerFailureObservation(Object.assign(Error('connection pool exhausted'), { code: 'POOL_EXHAUSTED' }), now);
  assert.equal(pool.state, 'throttled');
  assert.equal(pool.reason, 'transport-pool-exhausted');
  assert.equal(pool.retryAfterMs, null);
  assert.equal(providerFailureObservation(Error('the connection pool is full'), now).reason, 'transport-pool-exhausted');

  // The llm layer reports a finished stream as a provider-neutral failure code, not as an HTTP error.
  const neutral = providerFailureObservation({ code: 'RATE_LIMIT', message: 'fake provider throttled' }, now);
  assert.equal(neutral.state, 'throttled');
  assert.equal(neutral.reason, 'provider-rate-limit');
  assert.equal(providerFailureObservation({ code: 'TRANSPORT', message: 'socket closed' }, now).state, 'unknown');
  assert.equal(providerFailureObservation({ code: 'AUTH', message: 'bad key' }, now), null, 'a rejected key says nothing about capacity');
  assert.equal(providerOutcome({}, now).state, 'available', 'only a clean finish is availability evidence');

  const unavailable = providerFailureObservation(Object.assign(Error('upstream 503'), { status: 503 }), now);
  assert.equal(unavailable.state, 'unknown', 'a 503 without Retry-After proves no limit and no availability');
  assert.equal(providerFailureObservation(Object.assign(Error('unauthorized'), { status: 401 }), now), null,
    'an auth error says nothing about capacity');
  assert.equal(providerFailureObservation(Error('stream exploded'), now), null);
});

test('gap 3 fail-closed: missing, stale and elapsed-window evidence stay unknown; only a later response says available', () => {
  const t = team();
  try {
    const initial = capacityStatus(t.core, 1000);
    assert.equal(initial.providerCapacity, 'unknown');
    assert.equal(initial.providerWait, 'none');
    assert.equal(initial.providerRetryAfterMs, null);
    assert.equal(initial.providerRecoveryAt, null);
    assert.equal(t.writes(), 0, 'reading status never invents a fact');

    const now = 10_000;
    recordProviderObservation(t.core, { state: 'throttled', reason: 'provider-rate-limit', retryAfterMs: 2000,
      windowMs: PROVIDER_WINDOW_MS, observedAt: now }, now);
    const open = capacityStatus(t.core, now + 1999);
    assert.equal(open.providerCapacity, 'throttled');
    assert.equal(open.providerRetryAfterMs, 2000);
    assert.equal(open.providerRecoveryAt, now + 2000);
    assert.equal(capacityStatus(t.core, now + 2000).providerCapacity, 'unknown',
      'an elapsed window is not a recovery: no response has been observed since');
    assert.equal(t.writes(), 1);

    const later = now + 5000;
    recordProviderObservation(t.core, { state: 'available', reason: 'provider-response-observed', observedAt: later }, later);
    assert.equal(capacityStatus(t.core, later).providerCapacity, 'available');
    assert.equal(capacityStatus(t.core, later + PROVIDER_EVIDENCE_TTL_MS).providerCapacity, 'available');
    assert.equal(capacityStatus(t.core, later + PROVIDER_EVIDENCE_TTL_MS + 1).providerCapacity, 'unknown',
      'stale evidence is unknown, never a standing availability claim');
  } finally { t.close(); }
});

test('gap 3 status: an upstream limit and a local queue are different waits, and a limit acquires nothing', () => {
  const t = team();
  try {
    queueWork(t.core, 'task:queued');
    const local = capacityStatus(t.core, 1000);
    assert.equal(local.providerCapacity, 'unknown');
    assert.equal(local.providerWait, 'local-queued', 'the queue is ours until the provider says otherwise');
    assert.equal(local.normal.queued, 1);

    const now = 2000, before = JSON.stringify(capacityUsage(t.store));
    recordProviderObservation(t.core, { state: 'throttled', reason: 'provider-rate-limit', retryAfterMs: 4000,
      windowMs: PROVIDER_WINDOW_MS, observedAt: now }, now);
    const throttled = capacityStatus(t.core, now + 10);
    assert.equal(throttled.providerCapacity, 'throttled');
    assert.equal(throttled.providerWait, 'provider-throttled', 'an upstream limit wins over the local queue');
    assert.equal(JSON.stringify(capacityUsage(t.store)), before, 'classification occupies no N/H slot');
    assert.equal(t.store.list('control-slot:').length, 0);
    assert.equal(t.store.list('effect-io:').length, 0);

    const later = now + 4000;
    recordProviderObservation(t.core, { state: 'available', reason: 'provider-response-observed', observedAt: later }, later);
    const recovered = capacityStatus(t.core, later);
    assert.equal(recovered.providerCapacity, 'available');
    assert.equal(recovered.providerWait, 'local-queued', 'after recovery the remaining wait is the local one again');
  } finally { t.close(); }
});

test('gap 3 journal: one open window is one fact; a response inside it does not revoke it', () => {
  const t = team();
  try {
    const now = 3000, limit = { state: 'throttled', reason: 'provider-rate-limit', retryAfterMs: 5000,
      windowMs: PROVIDER_WINDOW_MS, observedAt: now };
    recordProviderObservation(t.core, limit, now);
    recordProviderObservation(t.core, { ...limit, observedAt: now + 100 }, now + 100);
    assert.equal(t.writes(), 1, 'repeated limits inside one window do not grow the journal');
    recordProviderObservation(t.core, { state: 'unknown', reason: 'provider-transport-failure', observedAt: now + 150 }, now + 150);
    assert.equal(capacityStatus(t.core, now + 150).providerCapacity, 'throttled',
      'a later unproven failure does not erase the open limit');
    recordProviderObservation(t.core, { state: 'available', reason: 'provider-response-observed', observedAt: now + 200 }, now + 200);
    assert.equal(capacityStatus(t.core, now + 200).providerCapacity, 'throttled',
      'a response inside the announced Retry-After window cannot clear it');
    assert.equal(t.writes(), 1);
    recordProviderObservation(t.core, { ...limit, observedAt: now + 6000 }, now + 6000);
    assert.equal(t.writes(), 2, 'a fresh limit after the window is new evidence');
    assert.equal(capacityStatus(t.core, now + 6000).providerCapacity, 'throttled');
  } finally { t.close(); }
});

test('gap 3 unknown is not a limit: providerWait stays none for an unknown provider with no local queue', () => {
  const t = team();
  try {
    const now = 4000;
    recordProviderObservation(t.core, { state: 'unknown', reason: 'provider-transport-failure', observedAt: now }, now);
    const status = capacityStatus(t.core, now);
    assert.equal(status.providerCapacity, 'unknown');
    assert.equal(status.providerWait, 'none');
    assert.equal(providerWait({ state: 'unknown' }, true), 'local-queued');
    assert.equal(providerWait(null, false), 'none');
    assert.equal(providerWait({ state: 'available' }, false), 'none');
  } finally { t.close(); }
});
