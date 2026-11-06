// P7 (docs/decisions/team-autonomy-design.md §10 P7, appendix 8): what the projection may forget.
//
// The rule stays one sentence - an archived row may go, a live one may not - and this file pins the three families P7
// had to decide about: an audit row is never dropped, a decision only once it can no longer be decided, and usage is
// aggregated instead of deleted so the number a budget reads never shrinks. It also pins the two lifecycle reclaims:
// a retired member's workspace and a group whose members have all retired.
//
// Retention is driven through the projection itself (packages/projections/index.mjs), because that is the only way the
// host ever applies it: the replay loop retains after every event, so what follows is the rule as a running projection
// meets it, not one call on a finished map. That is also why every fixture is written in the order a run would write
// it - a group row arrives after the intent that keeps it alive, a workspace row after the member that owns it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Projection } from '../../projections/index.mjs';
import { usageOf } from '../index.mjs';

let stamp = 1000;
const row = (entityId, data) => ({ ...data, entityId, revision: 1, updatedAt: data.updatedAt ?? (stamp += 1) });
/** Replay the rows as a one-row-per-seq event log and hand back the projection's map after its own retention ran. */
const replay = (list, recentLimit) => {
  const events = list.map((entry, index) => ({ seq: index + 1, entity: entry.entityId, revision: entry.revision,
    payload: entry }));
  const projection = new Projection({ events: seq => events.filter(event => event.seq > seq) }, { recentLimit });
  projection.sync();
  return projection.rows;
};
const readable = map => ({ read: id => map.get(id) ?? null,
  list: prefix => [...map.values()].filter(item => item.entityId.startsWith(prefix)) });
const kept = (map, prefix) => [...map.values()].filter(item => item.entityId.startsWith(prefix));

test('appendix 8: an audit row is never archived, however much else is', () => {
  const audits = Array.from({ length: 5 }, (_, index) => row('audit:' + index, { kind: 'decision', option: 'continue' }));
  const noise = Array.from({ length: 40 }, (_, index) => row('checkpoint:' + index, { progressRef: 'p' + index }));
  const map = replay([...audits, ...noise], 5);
  assert.equal(audits.filter(audit => map.has(audit.entityId)).length, 5, 'every verdict record survived');
  assert(map.size <= 5 + 5, 'and the archive still trimmed the noise: ' + map.size);
});

test('appendix 8: a decision is archived only once it can no longer be decided', () => {
  const open = row('decision:open', { kind: 'objection', state: 'open', options: ['waive'], subject: {} });
  const decided = row('decision:done', { kind: 'objection', state: 'decided', options: ['waive'], subject: {} });
  const expired = row('decision:late', { kind: 'objection', state: 'expired', options: ['waive'], subject: {} });
  const noise = Array.from({ length: 20 }, (_, index) => row('tool-intent:' + index, { status: 'confirmed' }));
  const map = replay([open, decided, expired, ...noise], 2);
  assert(map.has('decision:open'), 'an inbox item nobody answered stays');
  assert.equal(map.has('decision:done') && map.has('decision:late'), false, 'closed rows give way to the limit');
});

test('appendix 8: usage is folded, never dropped - the number a budget reads does not move', () => {
  const list = Array.from({ length: 20 }, (_, index) => row('usage:member:a:s1:' + index, {
    memberId: 'member:a', sessionId: 's1', input: index + 1, output: 1, turns: 0, source: 'usage-event',
    approximate: false, unknown: false, totalInput: (index + 1) * (index + 2) / 2, totalOutput: index + 1 }));
  const sum = list.reduce((total, entry) => total + entry.input, 0);
  const map = replay(list, 5);
  const after = usageOf(readable(map), { memberId: 'member:a' });
  const remaining = kept(map, 'usage:');
  assert(remaining.length <= 5, 'the family stays inside the limit: ' + remaining.length);
  const folded = remaining.find(entry => entry.aggregated > 0);
  assert(folded, 'the fold happened: sixteen rows are one');
  assert.equal(folded.aggregated, 15, 'and it says how many rows it folded');
  assert.equal(folded.input, 136, 'the newest cumulative reading at the fold IS the sum of the group');
  assert.equal(after.input, sum, 'the sum is unchanged (' + sum + ')');
  assert.equal(after.output, 20);
});

test('appendix 8: without cumulative readings the fold sums the increments it replaces', () => {
  const list = Array.from({ length: 10 }, (_, index) => row('usage:member:b:s2:' + index, {
    memberId: 'member:b', sessionId: 's2', input: 3, output: 2, turns: 1, source: 'delta', approximate: true,
    unknown: false, totalInput: null, totalOutput: null }));
  const map = replay(list, 2);
  const remaining = kept(map, 'usage:');
  assert.equal(remaining.length, 2, 'the family stays inside the limit');
  const folded = remaining.find(entry => entry.aggregated > 0);
  assert.equal(folded.aggregated, 8, 'the count survives being folded one event at a time');
  assert.equal(folded.input, 27, 'nine rows of three tokens');
  assert.equal(folded.output, 18);
  const after = usageOf(readable(map), { memberId: 'member:b' });
  assert.equal(after.input, 30, 'ten rows of three tokens are one row of thirty');
  assert.equal(after.output, 20);
  assert.equal(after.turns, 10);
});

test('appendix 8: a retired member workspace is reclaimed; an unknown one is kept for the re-assignment', () => {
  const map = replay([
    row('member:gone', { role: 'worker', group: 'g1', status: 'retired' }),
    row('member.workspace:member:gone', { memberId: 'member:gone', relPath: 'work/gone', lockedAt: 1000 }),
    row('member:stuck', { role: 'worker', group: 'g2', status: 'unknown' }),
    row('member.workspace:member:stuck', { memberId: 'member:stuck', relPath: 'work/stuck', lockedAt: 1000 }),
    row('member.workspace:member:pending', { memberId: 'member:pending', relPath: 'work/pending', lockedAt: null }),
  ], 100);
  assert.equal(map.has('member.workspace:member:gone'), false, 'the binding is over');
  assert.equal(map.has('member.workspace:member:stuck'), true, '§4.3 re-assigns an unknown member in place');
  assert.equal(map.has('member.workspace:member:pending'), true, 'an assignment precedes its member row');
});

test('appendix 8: a group whose members all retired is reclaimed; a plan for a group is not', () => {
  const map = replay([
    row('member-intent:p', { status: 'intent', op: 'request', group: 'waiting' }),
    row('member:g1', { role: 'worker', group: 'done', status: 'retired' }),
    row('group:done', { name: 'done', lead: null }),
    row('member:g2', { role: 'worker', group: 'live', status: 'running' }),
    row('group:live', { name: 'live', lead: null }),
    row('group:planned', { name: 'planned', lead: null }),
    row('member:g3', { role: 'worker', group: 'waiting', status: 'retired' }),
    row('group:waiting', { name: 'waiting', lead: null }),
  ], 100);
  assert.equal(map.has('group:done'), false, 'the last member retired');
  assert.equal(map.has('group:live'), true, 'a live member keeps its group');
  assert.equal(map.has('group:planned'), true, 'a group created ahead of its members is a plan, not a leftover');
  assert.equal(map.has('group:waiting'), true, 'a pending provisioning intent keeps it alive');
});
