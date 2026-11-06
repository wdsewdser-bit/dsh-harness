import test from 'node:test';
import assert from 'node:assert/strict';
import { profile, until } from '../test-support/profile.mjs';
import { Projection, ownerSessionLive } from '../../projections/index.mjs';
import { view } from '../../projections/index.mjs';

/**
 * What the panel is told about the owner member.
 *
 * The lead member is the team's owner session, not a member agent: the product never writes it a nativeRef, so a
 * row-only projection could only ever answer 'requested' - the panel's "requested", a member that was asked for and
 * never arrived. While the host still routes that owner session the member is in fact running, so the state comes
 * from the binding; once the binding is gone the row-derived answer is the honest one again.
 */
const rows = ({ root = {}, worker = {} } = {}) => new Map([
  ['member:root', { entityId: 'member:root', name: 'member:root', role: 'root', generation: 1, desired: 'active', observed: 'offline', status: 'active',
    revision: 1, ...root }],
  ['member:worker', { entityId: 'member:worker', name: 'member:worker', role: 'worker', generation: 1, desired: 'active', observed: 'offline', status:
    'active', revision: 1, ...worker }],
]);
const status = (options, extra) => Object.fromEntries(view(rows(extra), 'member:root', rows(extra), options).members.map(m => [m.id, m.observed]));

test('the owner member is active while its session is bound and only then', () => {
  // Bound: the lead session is live and driving the team, so the member is active, not "requested".
  assert.deepEqual(status({ ownerSession: true }), { 'member:root': 'active', 'member:worker': 'requested' });
  // Unbound: back to the row-derived answer, which for a member with no execution is 'requested'.
  assert.deepEqual(status({ ownerSession: false }), { 'member:root': 'requested', 'member:worker': 'requested' });
  assert.deepEqual(status(), { 'member:root': 'requested', 'member:worker': 'requested' }, 'the rule is opt-in: without the binding the row decides');
  // The binding never overrides a state the row actually recorded: a stopped or unknown member keeps its own answer.
  assert.equal(status({ ownerSession: true }, { root: { observed: 'stopped' } })['member:root'], 'frozen');
  assert.equal(status({ ownerSession: true }, { root: { status: 'retired', observed: 'stopped' } })['member:root'], 'retired');
  assert.equal(status({ ownerSession: true }, { root: { status: 'unknown' } })['member:root'], 'unknown');
  assert.equal(status({ ownerSession: true }, { root: { observed: 'running' } })['member:root'], 'active');
  // A member that is not the owner is unaffected by the owner binding.
  assert.equal(status({ ownerSession: true }, { worker: { nativeRef: 'session:worker' } })['member:worker'], 'bound');
});

test('the product projection reads the live owner binding and falls back when it is gone', async () => {
  const w = await profile();
  try {
    const r = w.runtime;
    const read = thunk => new Projection({ events: seq => r.store.events(seq), scanEvents: seq => r.store.scanEvents(seq) }, { ownerSession: thunk });
    const live = ownerSessionLive({ host: r.host, router: r.router });
    assert.equal(live(), true, 'the running host routes its own owner session');
    assert.equal(ownerSessionLive({ host: r.host, router: { routeOwner: () => ({ routed: false }) } })(), false);
    assert.equal(ownerSessionLive({})(), false, 'no host, no owner session');
    const rootOf = projection => projection.snapshot('member:root').data.members.find(m => m.id === 'member:root');
    assert(rootOf(read(live)), 'the owner member is in the roster');
    assert.equal(rootOf(read(live)).nativeRef, null, 'the owner session is not a member execution');
    assert.equal(rootOf(read(live)).observed, 'active', 'a bound, live owner session is active');
    assert.equal(rootOf(read(null)).observed, 'requested', 'the same row without the binding is what the panel called "requested"');
    // A real member keeps its own observed state; the owner rule does not reach it.
    r.host.command({ teamId: r.host.teamId, actor: 'root', requestId: 'member', operationId: 'v1:operation:owner-observation-01',
      payload: { command: 'team.member.request', entityId: 'member-intent:w', role: 'worker' } });
    await until(() => r.store.read('member-intent:w')?.status === 'confirmed');
    await until(() => r.store.read('member:w')?.nativeRef);
    const worker = read(live).snapshot('member:root').data.members.find(m => m.id === 'member:w');
    assert.equal(worker.observed, 'active', 'a member execution reports the state its own row recorded');
    assert(worker.nativeRef, 'and it has the execution to prove it');
    // The binding goes: the team's owner session is unregistered, and the roster answer follows the durable row.
    r.router.unregisterTeam(r.host.teamId, { host: r.host });
    assert.equal(live(), false, 'an unregistered team no longer routes its owner session');
    assert.equal(rootOf(read(live)).observed, 'requested');
  } finally { await w.close(); }
});
