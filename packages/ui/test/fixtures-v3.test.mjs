// M6 §WP-0: the fixtures every later acceptance step reads. They are data only and must stay additive: the four
// pre-M6 scenarios keep the exact shape the existing suites pin, and each new one differs from `default` in exactly
// the rows its acceptance case needs (15 §9 V-05/V-07, 16 §3.3/§3.4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURES, scenarioDefault, scenarioBorrow, scenarioLongText, scenarioDeadLetter,
  scenarioIntent, scenarioTeamB, MOCK_VIEWER, createMockSource } from '../src/mock.mjs';

const NOW = Date.UTC(2026, 10, 2, 12, 0);
const REQUIRED = ['goal', 'groups', 'members', 'tasks', 'threads', 'messages', 'unknownEffects', 'approvals'];

test('the registry carries the pre-M6 fixtures untouched and the M6 additions', () => {
  assert.deepEqual(Object.keys(FIXTURES).sort(),
    ['borrow', 'deadletter', 'default', 'empty', 'intent', 'long-text', 'stale', 'team-30', 'two-teams', 'unknown+deadletter', 'viewer']);
  const base = scenarioDefault(NOW);
  // The shape later suites depend on: 17 members + 2 restricted, 21 tasks, 4 decision threads, 10 messages.
  assert.equal(base.members.length, 17);
  assert.equal(base.restrictedMembers, 2);
  assert.equal(base.tasks.length, 21);
  assert.equal(base.threads.length, 4);
  assert.equal(base.messages.length, 10);
  for (const key of REQUIRED) assert.ok(key in base, key);
  // v3visual pins scenarioBorrow's shape; this is the cheap guard that a fixture edit cannot move it silently.
  const borrow = scenarioBorrow(NOW);
  assert.equal(borrow.resourceThreads.length, 1);
  assert.equal(borrow.capacity.occupants.length, 1);
});

test('long-text keeps the roster and adds the overflow rows V-07 measures', () => {
  const base = scenarioDefault(NOW), long = scenarioLongText(NOW);
  assert.equal(long.members.length, base.members.length, 'no member is added or dropped');
  assert.equal(long.tasks.length, base.tasks.length);
  assert.ok(long.members.find(m => m.id === 'member:worker-a').name.length > 16, 'a member name longer than the column');
  assert.ok(long.tasks.find(t => t.id === 'task-12').title.length > 100, 'a task title longer than the row');
  assert.equal(long.members.filter(m => m.id === 'member:worker-a').length, 1);
});

test('deadletter separates a message the outbox gave up on from a read-model gap', () => {
  const data = scenarioDeadLetter(NOW);
  const dead = data.messages.filter(m => m.lifecycle === 'dead-letter');
  assert.equal(dead.length, 1);
  assert.equal(dead[0].id, 'msg-90');
  assert.match(dead[0].deadLetter.reason, /receipt-lost/);
  assert.equal(dead[0].deadLetter.suggestedRecipient, 'member:sc-1');
  assert.equal(data.messages.filter(m => m.lifecycle === 'dead-letter').length, 1, 'only the one message gave up');
  assert.equal(data.unknownEffects.length, scenarioDefault(NOW).unknownEffects.length + 1, 'the gap is an added row');
  const gaps = data.unknownEffects.filter(e => e.kind === 'read-model');
  assert.equal(gaps.length, 1, 'the read-model gap is its own row, never an effect verdict');
  assert.equal(gaps[0].id, 'read-model:context:member:worker-p4');
});

test('intent is an open window with one recipient that has not seen it', () => {
  const data = scenarioIntent(NOW);
  const intent = data.messages.find(m => m.kind === 'intent');
  assert.ok(intent, 'the proposal travels as a message row');
  assert.equal(intent.id, 'msg-intent-1');
  assert.equal(intent.recipients.length, 1);
  assert.equal(intent.recipients[0].member, 'member:worker-b');
  assert.equal(intent.recipients[0].delivery, 'stored');
  assert.ok(intent.closesAt > intent.openedAt, 'the window has a closing instant');
  assert.equal(data.messages.length, scenarioDefault(NOW).messages.length + 1);
});

test('two-teams is the same team shape under unmistakable names', () => {
  const base = scenarioDefault(NOW), other = scenarioTeamB(NOW);
  assert.equal(other.members.length, base.members.length);
  assert.ok(other.members.every(m => m.name.startsWith('b-')), 'every name is distinct from team A');
  assert.equal(other.goal.id, 'goal-b');
  assert.equal(other.members.find(m => m.role === 'root').id, MOCK_VIEWER, 'the root principal is still the mock viewer');
});

test('viewer and stale fixtures control source identity without changing the default', async () => {
  const readonly = createMockSource({ fixture: 'viewer', now: () => NOW });
  const custom = createMockSource({ viewer: 'viewer:custom', now: () => NOW });
  const normal = createMockSource({ now: () => NOW });
  assert.equal(readonly.source.describe().viewer, 'viewer:readonly');
  assert.equal((await readonly.source.snapshot()).viewer, 'viewer:readonly');
  assert.equal(custom.source.describe().viewer, 'viewer:custom');
  assert.equal((await custom.source.snapshot()).viewer, 'viewer:custom');
  const normalEnvelope = await normal.source.snapshot();
  assert.equal(normalEnvelope.viewer, MOCK_VIEWER);
  // M6 WP-1 publishes the v3 panels on top of the same rows. The split comparison is the original assertion (the data
  // equals the fixture) kept whole, plus the proof that the extra blocks are derived from those rows and not invented.
  const normalSnap = normalEnvelope.data;
  const { summary, memberSummary, delivery, escalations, intents, team, viewerRole, ...fixtureRows } = normalSnap;
  assert.deepEqual(fixtureRows, scenarioDefault(NOW), 'fixture rows unchanged');
  assert.equal(summary.total, fixtureRows.tasks.length, 'N1 total is the task count');
  assert.equal(summary.accepted, fixtureRows.tasks.filter(t => t.state === 'accepted').length);
  assert.equal(summary.working, fixtureRows.members.filter(m => m.activity?.kind === 'running').length);
  assert.equal(['ok', 'root-handling', 'needs-you'].includes(summary.headline.kind), true, 'N1 headline kind');
  assert.match(summary.headline.text, /人/, 'N1 headline text');
  assert.equal(memberSummary.normal + memberSummary.stuck + memberSummary.paused + memberSummary.retiring + memberSummary.idle,
    fixtureRows.members.filter(m => m.role !== 'root').length, 'N3 counts every non-root member exactly once');
  assert.equal(delivery.total, fixtureRows.tasks.filter(t => t.state !== 'cancelled').length);
  assert.equal(delivery.accepted, summary.accepted, 'N4 and N1 agree about accepted work');
  assert.deepEqual(escalations.filter(item => item.subject.type === 'thread').map(item => item.subject.id).sort(),
    fixtureRows.threads.filter(t => t.state === 'escalated' && t.escalationOwner === 'operator').map(t => t.id).sort(),
    'N2 can only name a row that already escalated to the operator');
  assert.equal(escalations.every(item => item.primary === null), true, '§6 #12: the browser renders no verdict button');
  assert.equal(intents.length, fixtureRows.messages.filter(m => m.kind === 'intent').length, 'P6 is derived from the rows');
  assert.equal(team.name, fixtureRows.goal.title, 'P3: the team name is the projection goal, not a UI constant');
  assert.equal(typeof team.createdAt, 'number');
  assert.equal(viewerRole, fixtureRows.members.find(m => m.id === normalEnvelope.viewer).role, 'P4: the role is the projection row');

  const before = await readonly.source.snapshot();
  const receipt = await readonly.gateway.submit({ name: 'organization.requestFreeze', target: 'member:worker-a',
    expectedRevision: 1, args: { reason: 'test' } });
  assert.equal(receipt.status, 'rejected');
  assert.equal(receipt.message, 'ROLE_DENIED');
  assert.deepEqual(await readonly.source.snapshot(), before);
  const stale = createMockSource({ fixture: 'stale', now: () => NOW });
  assert.equal((await stale.source.snapshot()).stale, true);
  stale.control.setStale(false);
  assert.equal((await stale.source.snapshot()).stale, false);
  assert.deepEqual(FIXTURES['unknown+deadletter'](NOW), scenarioDeadLetter(NOW));
});

