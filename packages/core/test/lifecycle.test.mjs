// Offline unit tests for the member-lifecycle driver (retire/freeze/resume intents); pure, node --test.
//
// The defect these pin: member-intent rows were written by every lifecycle command and consumed by nothing, so a
// retire stayed at status 'intent' forever and the projection showed desired retired against observed active without
// end. No test here calls the lifecycle preparation step directly — that is the point.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../index.mjs';
import { createLifecycleConsumer } from '../../host/index.mjs';
import { submit } from '../../projections/index.mjs';
import { Projection } from '../../projections/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../runs');

/** One durable team with a root and a worker, in a throwaway store the test removes afterwards. */
function team(label) {
  const dir = fs.mkdtempSync(path.join(root, 'lifecycle-unit-' + label + '-'));
  const store = new ControlStore(dir);
  const port = { stops: 0, dispose: async () => { port.stops += 1; return { stopped: true }; } };
  const core = new TeamCore(store, port, { enabled: true, attach: true });
  core.member('member:root', 'root');
  core.member('member:worker', 'worker');
  return { dir, store, core, port, close() { core.store.close?.(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
/** The command the UI sends: one stable operationId per member and generation. */
const retire = (core, store, operationId = 'v1:operation:ui-retire-member-worker-g1') => submit(core, 'member:root',
  { name: 'organization.retire', target: 'member:worker', expectedRevision: store.read('member:worker').revision,
    args: { reason: 'retire' }, operationId });
const intents = store => store.list('member-intent:');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, label) => {
  for (let attempt = 0; attempt < 600; attempt++) { if (predicate()) return; await sleep(10); }
  assert.fail('timed out waiting for ' + label);
};
const snapshotMember = (store, id = 'member:worker') =>
  new Projection({ events: seq => store.events(seq) }).snapshot('member:root').data.members.find(m => m.id === id);

test('a retire settles through the profile driver alone', async () => {
  const t = team('converge');
  const driver = createLifecycleConsumer(t.core, { root: t.dir, intervalMs: 20, timeoutMs: 60000 });
  try {
    assert.equal(retire(t.core, t.store).status, 'accepted');
    // The command only writes the intent; until the driver runs, the member row has not moved.
    assert.equal(intents(t.store).filter(intent => intent.status === 'intent').length, 1);
    assert.equal(t.port.stops, 0);
    driver.kick();
    await driver.whenSettled();
    await until(() => t.store.read('member:worker').status === 'retired', 'retired');
    const member = t.store.read('member:worker');
    assert.equal(member.desired, 'retired');
    assert.equal(member.observed, 'stopped');
    assert.equal(member.status, 'retired');
    assert.equal(t.port.stops, 1);
    assert.equal(intents(t.store).at(-1).status, 'confirmed');
    // The projection converged too: desired and observed agree, so the panel stops asking for anything.
    const projected = snapshotMember(t.store);
    assert.equal(projected.desired, 'retired');
    assert.equal(projected.observed, 'retired');
    assert.equal(projected.pendingLifecycle, null);
  } finally { await driver.stop(); t.close(); }
});

test('the timer alone also settles a retire, without a kick', async () => {
  const t = team('timer');
  const driver = createLifecycleConsumer(t.core, { root: t.dir, intervalMs: 10, timeoutMs: 60000 });
  try {
    assert.equal(retire(t.core, t.store).status, 'accepted');
    await until(() => t.store.read('member:worker').status === 'retired', 'retired by the timer');
    assert.equal(snapshotMember(t.store).observed, 'retired');
  } finally { await driver.stop(); t.close(); }
});

test('an intent no driver settled is downgraded to the operator by the clock', async () => {
  const t = team('timeout');
  try {
    assert.equal(retire(t.core, t.store).status, 'accepted');
    const intent = intents(t.store)[0];
    assert.equal(intent.status, 'intent');
    const since = intent.createdAt;
    const timeout = t.core.configuration.lifecycleIntentTimeoutMs;
    // Nothing has expired one millisecond before the threshold.
    t.core.tick(since + timeout - 1);
    assert.equal(t.store.read(intent.entityId).status, 'intent');
    assert.equal(snapshotMember(t.store).pendingLifecycle?.op, 'retire');
    t.core.tick(since + timeout + 1);
    const expired = t.store.read(intent.entityId);
    assert.equal(expired.status, 'unknown');
    assert.equal(expired.responsible, 'operator');
    assert.match(expired.reason, /timed out/);
    // The member row is unknown as well, so the panel says "? 待对账" instead of inventing an observation.
    const member = t.store.read('member:worker');
    assert.equal(member.status, 'unknown');
    assert.equal(member.responsible, 'operator');
    const projected = snapshotMember(t.store);
    assert.equal(projected.observed, 'unknown');
    // It is no longer presented as an in-flight retirement: the wait clock is gone.
    assert.equal(projected.pendingLifecycle, null);
    assert.equal(t.port.stops, 0, 'a timed-out intent must not invent a native stop');
  } finally { t.close(); }
});

test('a repeated retire with the same operationId is one durable intent, not a second one', () => {
  const t = team('idempotent');
  try {
    const first = retire(t.core, t.store);
    const second = retire(t.core, t.store);
    assert.deepEqual(second, first);
    assert.equal(intents(t.store).length, 1);
    // The guard is the id itself: a fresh id is a second intent, which is what repeated clicks used to produce.
    assert.equal(retire(t.core, t.store, 'v1:operation:ui-retire-member-worker-g1-other').status, 'accepted');
    assert.equal(intents(t.store).length, 2);
  } finally { t.close(); }
});

test('the driver never runs two cycles at once', async () => {
  const t = team('serial');
  let active = 0;
  let peak = 0;
  t.core.ports.dispose = async () => {
    active += 1; peak = Math.max(peak, active);
    await sleep(30);
    active -= 1; return { stopped: true };
  };
  const driver = createLifecycleConsumer(t.core, { root: t.dir, intervalMs: 1, timeoutMs: 60000 });
  try {
    assert.equal(retire(t.core, t.store).status, 'accepted');
    const first = driver.cycle();
    const second = driver.cycle();
    assert.equal(second, first, 'a re-entrant call gets the in-flight cycle, never a second one');
    await first;
    await driver.whenSettled();
    // A 1 ms timer raced the 30 ms effect for the whole cycle; the guard is what keeps it at one.
    assert.equal(peak, 1);
  } finally { await driver.stop(); t.close(); }
});
