// P9 (docs/decisions/team-autonomy-design.md §10 P9, appendix 9): the P7 blocks in the delta stream, and the two pieces
// of configuration the view could not see (the price table and the effect capability table).
//
// The first case is the byte-identity oracle: a team that wrote none of the autonomy rows must still produce exactly the
// envelope and exactly the delta stream HEAD's index.mjs produced. The digests below were taken from
// `git show HEAD:packages/projections/index.mjs` over the fixed fixture in test-support/p7-rows.mjs, with the current
// view/retention modules behind it -- for those rows the two are byte for byte identical, which the P7 appendix proves
// separately for the view and the ring of rows here contains no audit/decision/usage/group/workspace row at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Projection } from '../../projections/index.mjs';
import { effectCapabilities } from '../../host/index.mjs';
import { hash } from '../../contracts/index.mjs';
import { legacyRows } from '../test-support/p7-rows.mjs';

/** sha256 of HEAD's envelope over legacyRows(): asOfSeq, sourceRevisions, retention, viewer and data. */
const LEGACY_SNAPSHOT_DIGEST = '340cbad3038af3bc08f149b8bc0370afde713ff41ff18390ac5b2e10f9203ee9';
/** sha256 of HEAD's six deltas over the same fixture. */
const LEGACY_DELTA_DIGEST = 'aeb704f8fd0933ac3a82154bc914e4793ea74cb7a1c75196b1cb51788d98f519';
const LEGACY_DELTA_KEYS = ['goal', 'groups', 'removes', 'restrictedMembers', 'schemaVersion', 'seq', 'sourceRevisions',
  'stale', 'upserts', 'viewer'];
const LEGACY_COLLECTIONS = ['approvals', 'members', 'messages', 'tasks', 'threads', 'unknownEffects'];
const LEGACY_DATA_KEYS = [...LEGACY_COLLECTIONS, 'goal', 'groups', 'restrictedMembers', 'approvalsStatus'];

const reader = events => ({ events: seq => events.filter(event => event.seq > seq) });
// The store stamps revision/entityId on every row it writes, so the fixture rows carry them too: sourceRevisions is
// built from the row's own revision, not from the event that carried it.
const asEvents = rows => rows.map((row, index) => ({ seq: row.seq ?? index + 1, entity: row.entityId,
  revision: row.revision ?? 1, payload: { ...row, revision: row.revision ?? 1 } }));
const member = (id, role = 'worker') => ({ entityId: id, revision: 1, role, group: 'default', generation: 1,
  desired: 'active', observed: 'running', status: 'running', nativeRef: 'session:' + id });
const decision = (id, extra = {}) => ({ entityId: id, revision: 1, kind: 'budget-unknown', state: 'open', openedAt: 1000,
  options: ['continue', 'stop'], subject: { type: 'budget', id: 'usage-unknown:member:a' },
  evidence: [{ at: 1, kind: 'usage', ref: 'usage-unknown:member:a', text: 'no measurement' }],
  expiresAt: Date.now() + 600000, openedFor: 'member:root', fallback: 'stay', ...extra });

test('appendix 9: without autonomy rows the envelope and the delta stream are byte for byte what HEAD built', () => {
  const events = asEvents([...legacyRows().values()]);
  const rowMap = new Map(legacyRows());
  const projection = new Projection(reader(events));
  const snapshot = projection.snapshot('member:root');
  assert.equal(JSON.stringify([...projection.rows]), JSON.stringify([...rowMap]), 'the replay reproduced the fixture');
  assert.equal(hash(JSON.stringify(snapshot)), LEGACY_SNAPSHOT_DIGEST, 'the envelope moved');
  // The default production constructor must retain the complete off-team envelope.
  const panel = new Projection(reader(events)).snapshot('member:root');
  assert.deepEqual(Object.keys(panel.data).sort(), LEGACY_DATA_KEYS.sort(), 'off teams omit M6 on the default path');
  assert.equal(JSON.stringify(panel), JSON.stringify(snapshot), 'the default envelope is byte identical');
  const deltas = projection.events('member:root', 0);
  assert.equal(deltas.length, 6);
  assert.equal(hash(JSON.stringify(deltas)), LEGACY_DELTA_DIGEST, 'the delta stream moved');
  for (const delta of deltas) {
    assert.deepEqual(Object.keys(delta).sort(), LEGACY_DELTA_KEYS, 'no new key may appear in a legacy delta');
    assert.deepEqual(Object.keys(delta.upserts).sort(), LEGACY_COLLECTIONS, 'and no new collection either');
    assert.deepEqual(Object.keys(delta.removes).sort(), LEGACY_COLLECTIONS);
  }
});

test('appendix 9: a delta names the P7 blocks when they exist, and repeats only what changed', () => {
  const events = asEvents([
    member('member:root', 'root'),
    decision('decision:d1'),
    { entityId: 'audit:1', revision: 1, kind: 'decision', decisionId: 'decision:d0', option: 'continue', by: 'member:root', at: 900 },
    { entityId: 'team-goal:team', revision: 1, id: 'team-goal:team', objective: 'ship P9', state: 'open', openedAt: 100,
      openedBy: 'member:root', bases: [] },
  ]);
  const projection = new Projection(reader(events));
  const first = projection.snapshot('member:root');
  assert.equal(first.data.decisions.length, 1);
  assert.equal(first.data.auditTrail.length, 1);
  assert.equal(first.data.teamGoal.objective, 'ship P9');
  assert.equal(first.sourceRevisions['decision:d1'], 1, 'a decision row is a source revision of the envelope');
  assert.equal(first.sourceRevisions['audit:1'], 1, 'and so is a verdict');
  events.push({ seq: 5, entity: 'decision:d2', revision: 1, payload: decision('decision:d2') });
  const [add] = projection.events('member:root', first.asOfSeq);
  assert.deepEqual(add.upserts.decisions.map(row => row.id), ['decision:d2'], 'the new inbox item travels');
  assert.deepEqual(add.removes.decisions, []);
  assert.equal('teamGoal' in add, false, 'a block that did not change is not repeated');
  assert.equal('effects' in add, false, 'a block this team does not have is not invented');
  events.push({ seq: 6, entity: 'team-goal:team', revision: 2, payload: { entityId: 'team-goal:team', revision: 2,
    id: 'team-goal:team', objective: 'ship P9 today', state: 'open', openedAt: 100, openedBy: 'member:root', bases: [],
    updatedAt: 2000 } });
  const [move] = projection.events('member:root', 5);
  assert.equal(move.teamGoal.objective, 'ship P9 today', 'the goal block travels as a whole');
  assert.deepEqual(move.upserts.decisions, [], 'and an unchanged collection is still named, empty');
});

test('appendix 9: a configured price table prices the delegation, and without one there is no cost at all', () => {
  const price = { currency: 'USD', perInputToken: 0.000003, perOutputToken: 0.000015 };
  const rows = [
    member('member:root', 'root'),
    { entityId: 'member:a', revision: 1, role: 'worker', group: 'default', status: 'running', nativeRef: 'session:a' },
    { entityId: 'delegation:d1', revision: 1, owner: 'member:a', budget: { tasks: 2, concurrency: 1,
      tokens: { inputLimit: 1000, outputLimit: 1000 } }, expiresAt: Date.now() + 600000 },
    { entityId: 'task:a', revision: 1, owner: 'member:a', status: 'executing', delegationRef: 'delegation:d1', title: 'Task A' },
    { entityId: 'usage:member:a:s1:1', revision: 1, memberId: 'member:a', sessionId: 's1', input: 100, output: 10, turns: 1,
      source: 'usage-event', approximate: false, unknown: false },
  ];
  const events = asEvents(rows);
  const priced = new Projection(reader(events), { pricing: price });
  const tokens = priced.snapshot('member:root').data.budget.delegations[0].tokens;
  assert.equal(tokens.input, 100);
  assert.equal(tokens.output, 10);
  assert.deepEqual(tokens.cost, { currency: 'USD', amount: 100 * price.perInputToken + 10 * price.perOutputToken });
  const plain = new Projection(reader(events));
  const free = plain.snapshot('member:root').data.budget.delegations[0].tokens;
  assert.equal('cost' in free, false, 'no price table, no amount');
  assert.equal(plain.pricing, null);
  // P10: the projection refuses the same tables the profile contract refuses (INVALID_CONFIG), instead of accepting a
  // shape autonomyConfig() would have rejected.
  assert.throws(() => new Projection(reader(events), { pricing: { currency: 'USD' } }), { code: 'INVALID_CONFIG' });
});

test('appendix 9: the effect capability table reaches the view through the host entry, read-only', () => {
  const events = asEvents([
    member('member:root', 'root'),
    { entityId: 'effect:start:1', revision: 1, effectId: 'start:1', payload: { kind: 'start' }, status: 'unknown', tries: 2, fence: 0 },
    { entityId: 'effect-evidence:start:1', revision: 1, effectId: 'start:1', kind: 'start', code: 'EFFECT_RETRY_EXHAUSTED',
      message: 'the safe retry cap was reached', attempts: 2, evidence: null, at: 6000 },
  ]);
  const data = new Projection(reader(events)).snapshot('member:root').data;
  const published = effectCapabilities();
  assert.deepEqual(data.effects.capabilities, published, 'the view shows exactly the published table');
  assert.deepEqual(data.effects.capabilities.start, { readback: null, retry: 'unsafe', maxTries: 1 });
  assert.deepEqual(data.effects.capabilities.delivery, { readback: 'git', retry: 'safe', maxTries: 3 });
  assert.equal(Object.isFrozen(data.effects.capabilities), true);
  assert.throws(() => { data.effects.capabilities.start.retry = 'safe'; }, TypeError, 'a reader cannot edit the table');
  assert.equal(effectCapabilities().start.retry, 'unsafe', 'and never leaves another reader a changed copy');
});

/**
 * Review 1, item 10: the projection's price table is the contract's price table, and it is a copy.
 *
 * autonomyConfig() refuses an empty currency, a negative rate and a partial table; the projection accepted all three and
 * also kept the caller's object, so an entry-configured or later-mutated table could move an amount no event reported.
 */
test('appendix 9 / §8.2.4: the projection refuses what the contract refuses and keeps its own frozen copy', () => {
  const reader = { events: () => [], scanEvents: () => [] };
  const source = { currency: 'USD', perInputToken: 0.000003, perOutputToken: 0.000015 };
  const projection = new Projection(reader, { pricing: source });
  assert.notEqual(projection.pricing, source, 'the projection does not keep the caller object');
  assert.equal(Object.isFrozen(projection.pricing), true);
  source.perInputToken = 1000;
  assert.equal(projection.pricing.perInputToken, 0.000003, 'editing the object afterwards cannot move an amount');
  assert.throws(() => new Projection(reader, { pricing: { currency: '', perInputToken: 1, perOutputToken: 1 } }),
    { code: 'INVALID_CONFIG' }, 'an empty currency is not a currency');
  assert.throws(() => new Projection(reader, { pricing: { currency: 'USD', perInputToken: -1, perOutputToken: 1 } }),
    { code: 'INVALID_CONFIG' }, 'a negative rate is not a rate');
  assert.throws(() => new Projection(reader, { pricing: { currency: 'USD', perInputToken: 1 } }),
    { code: 'INVALID_CONFIG' }, 'a partial table is refused, never priced as zero');
});
