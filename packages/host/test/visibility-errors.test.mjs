import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisibility } from '../src/visibility/dispatch.mjs';

/**
 * F2b: a throw inside the dispatch boundary must keep its own identity in the audit.
 *
 * The old catch wrote every throw as 'invalid-event', which hid a real wiring defect ("sessions.get is not a function")
 * for a whole round: the event was well formed, the failure happened after validation. A classified contract error still
 * maps to invalid-event; anything else keeps its code, name and message.
 */
const host = { clock: { now: () => 1000, every: () => () => {} }, epoch: 1, teamId: 'team:t', observeVisibility: () => {}, coreAccess: { lifecycle: () => ({
  mutate: () => {} }) } };
const routeExecution = () => ({ routed: true, teamId: 'team:t', memberId: 'member:a', generation: 1 });
const sessions = { get: () => ({ seq: 1, snapshotEvents: () => [] }) };
const event = { contract: 'team-dispatch/2', phase: 'prepared', attempt: 'dispatch:a', sessionId: 'session:a', kind: 'main', purpose: null };

test('a non-contract throw keeps its name and message in the audit instead of being flattened into invalid-event', () => {
  const ledger = { leaseMs: 30000, observe() { throw new TypeError('sessions.get is not a function'); },
    slot: () => null, consumable: () => [], expire() {}, missing: () => [], status: () => ({}) };
  const api = createVisibility({ host, core: { store: { read: () => null, list: () => [] } }, routeExecution, sessions, isMain: () => true, leaseMs: 30000,
    ledger });
  api.dispatch(event, 'other');
  const entry = api.audit().at(-1);
  assert.equal(entry.type, 'evidenceMissing');
  assert.equal(entry.reason, 'dispatch-failed', 'a throw without a contract code is not a validation failure');
  assert.equal(entry.name, 'TypeError');
  assert.match(entry.message, /sessions\.get is not a function/);
  api.stop?.();
});

test('a contract validation error is still reported as invalid-event', () => {
  const ledger = { leaseMs: 30000, observe() { throw new TypeError('never reached'); },
    slot: () => null, consumable: () => [], expire() {}, missing: () => [], status: () => ({}) };
  const api = createVisibility({ host, core: { store: { read: () => null, list: () => [] } }, routeExecution, sessions, isMain: () => true, leaseMs: 30000,
    ledger });
  api.dispatch({ ...event, attempt: '' }, 'other');
  const entry = api.audit().at(-1);
  assert.equal(entry.reason, 'invalid-event');
  assert.equal(entry.name, 'Error');
  assert.match(entry.message, /attempt/);
  api.stop?.();
});
