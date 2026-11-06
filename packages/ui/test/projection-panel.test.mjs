// M6 §WP-1: the panel projection blocks (16 §6 N1–N4, P4–P11).
//
// Everything here reads the projection's public entry: the blocks are a read contract, not internals. `panel: 'legacy'`
// still yields the pre-M6 envelope (pinned byte for byte by packages/core/test/p7-projection.test.mjs and
// p9-projection-stream.test.mjs); these cases hold the shapes the panel renders and the authority edges it must not cross.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Projection, view } from '../../projections/index.mjs';

const ROOT = 'member:root';
const WORKER = 'member:a';

function fixture() {
  const rows = new Map();
  const put = (entityId, data, revision = 1) => rows.set(entityId, { ...data, entityId, revision, updatedAt: 1000 });
  const member = (id, extra) => put(id, { role: 'worker', group: 'g1', generation: 1, desired: 'active',
    observed: 'running', status: 'running', nativeRef: 'ses-' + id.split(':')[1], ...extra });
  put(ROOT, { role: 'root', group: 'g1', generation: 1, desired: 'active', observed: 'running', status: 'running',
    nativeRef: null });
  member(WORKER, {});
  member('member:b', {});
  member('member:c', { desired: 'frozen', observed: 'frozen', status: 'frozen', nativeRef: 'ses-c' });
  member('member:d', { observed: 'unknown', status: 'unknown', nativeRef: null });
  put('task:t1', { owner: WORKER, status: 'accepted', approved: true, contractRevision: 1, title: '渲染管线迁移' });
  put('task:t2', { owner: 'member:b', status: 'blocked', approved: true, contractRevision: 1, title: '被卡住的任务' });
  put('attempt:t1', { taskId: 'task:t1', owner: WORKER, status: 'admitted', lease: 'active', fence: 1, generation: 1,
    expiresAt: 5000, scopeSet: [], admittedAt: 1000 });
  put('attempt:t2', { taskId: 'task:t2', owner: 'member:b', status: 'blocked', lease: 'active', fence: 1, generation: 1,
    expiresAt: 5000, scopeSet: [], admittedAt: 1000 });
  put('wait:w1', { taskId: 'task:t2', dependency: { kind: 'Decision', ref: 'thread:d1' }, deadline: 9000,
    status: 'pending' });
  put('thread:d1', { kind: 'decision', question: '要不要合并？', owner: WORKER, escalationOwner: ROOT,
    requiredRespondents: ['member:b'], requiredEvidence: [], createdAt: 1500, deadline: 9000, status: 'escalated',
    proposalRevision: 1, replies: [], decisionRevision: null });
  const message = (id, extra) => put(id, { sender: WORKER, recipient: 'member:b', kind: 'action', summary: '请确认',
    createdAt: 1200, deadline: 9000, status: 'stored', stored: true, visible: false, accepted: false, generation: 1,
    expectedOutcome: '确认接口', receiptTimes: { stored: 1200, visible: null, accepted: null }, ...extra });
  message('message:m1', {});
  message('message:m2', { status: 'dead-letter', deadLetter: { reason: 'receipt-lost', at: 1300, suggestedRecipient: ROOT } });
  message('message:m3', { sender: ROOT, recipient: 'member:c', kind: 'info', expectedOutcome: '' });
  put('message:i1', { sender: WORKER, kind: 'intent', recipients: ['member:b'], createdAt: 1400, closesAt: 9000,
    status: 'open', summary: '合入主干', visibility: { 'member:b': null }, seenAtClose: { 'member:b': false },
    stored: true, expectedOutcome: '合入', receiptTimes: { stored: 1400, visible: null, accepted: null } });
  put('effect:merge:1', { payload: { kind: 'merge' }, status: 'unknown', tries: 2, fence: 0, nextDue: 0, createdAt: 1300 });
  put('effect-evidence:merge:1', { effectId: 'effect:merge:1', kind: 'merge', code: 'EFFECT_RETRY_EXHAUSTED',
    message: '回执丢失', attempts: 2, evidence: null, at: 1400 });
  put('read-model:context:member:b', { owner: 'member:b', status: 'unknown', sessionId: 'ses-b', createdAt: 1600 });
  put('team-goal:team', { objective: '迁移渲染管线', openedAt: 1000, openedBy: ROOT, state: 'open', bases: [] });
  return rows;
}
const legacy = rows => view(rows, ROOT, rows, { panel: 'legacy' });
const panel = rows => view(rows, ROOT, rows, { leaderSessionId: 'ses-root' });

test('the legacy shape is unchanged and the default shape adds exactly the panel blocks', () => {
  const rows = fixture();
  const before = legacy(rows);
  for (const key of ['summary', 'memberSummary', 'delivery', 'escalations', 'intents', 'team', 'viewerRole']) {
    assert.equal(key in before, false, key + ' is absent from the legacy shape');
  }
  const data = panel(rows);
  for (const key of ['summary', 'memberSummary', 'delivery', 'escalations', 'intents', 'team', 'viewerRole']) {
    assert.ok(key in data, key + ' is published');
  }
  assert.deepEqual(data.members.map(m => m.id), before.members.map(m => m.id), 'no member row moves');
  assert.equal(data.viewerRole, 'root');
  assert.equal(data.team.name, '迁移渲染管线');
  assert.equal(data.team.createdAt, 1000);
  assert.equal(data.team.leaderSessionId, 'ses-root');
});

test('N1: the one-line status counts work, acceptance and the most urgent thing', () => {
  const data = panel(fixture());
  assert.equal(data.summary.working, 1, 'only the member with a running attempt is "在做"');
  assert.equal(data.summary.accepted, 1);
  assert.equal(data.summary.total, 2, 'the denominator is the number of tasks (2026-11-01 decision)');
  assert.equal(data.summary.headline.kind, 'needs-you');
  assert.match(data.summary.headline.text, /需要你决定/);
  assert.ok(data.summary.headline.targetRef, 'the headline names the object to open');
});

test('N2: escalations are the owner\'s, derived from escalated rows; a safety row carries no action', () => {
  const rows = fixture();
  const data = panel(rows);
  assert.deepEqual(data.escalations.map(row => row.subject.type).sort(), ['effect']);
  const effect = data.escalations.find(row => row.subject.type === 'effect');
  assert.equal(effect.primary, null, 'the operator owns this verdict');
  assert.match(effect.note, /core.store.adjudicate/);
  const thread = data.threads.find(row => row.id === 'thread:d1');
  assert.equal(thread.capabilities['threads.decide'].allowed, false, 'escalated cannot be decided');
  assert.equal(thread.question, '要不要合并？');
  assert.deepEqual(view(rows, WORKER, rows).escalations, [], 'a member is not the owner');
});

test('N3/N4: roster summary and the delivery funnel', () => {
  const data = panel(fixture());
  assert.equal(data.memberSummary.stuck, 1, 'one blocked task');
  assert.equal(data.memberSummary.idle, 0, 'the owner supervises, it is not idle');
  assert.equal(data.memberSummary.paused, 1, 'the frozen member is paused');
  assert.equal(data.memberSummary.stuckHandledBy, ROOT);
  assert.equal(data.memberSummary.normal + data.memberSummary.stuck + data.memberSummary.idle +
    data.memberSummary.paused + data.memberSummary.retiring, data.members.length, 'every member lands in one bucket');
  // A funnel: a task that reached a later stage counts in every earlier one, so the bar never goes backwards.
  assert.deepEqual(data.delivery, { produced: 1, verifying: 1, merged: 1, accepted: 1, total: 2 });
});

test('P5/P10/P11: activity, the wait target name and the member history', () => {
  const data = panel(fixture());
  const running = data.members.find(m => m.id === WORKER);
  assert.deepEqual(running.activity, { kind: 'running', sub: null, since: null });
  const waiting = data.members.find(m => m.id === 'member:b');
  assert.deepEqual(waiting.activity, { kind: 'idle', sub: 'waiting', since: null });
  assert.equal(waiting.wait.targetLabel, '要不要合并？', 'the wait names the decision, not the dependency kind');
  assert.equal(data.members.find(m => m.id === 'member:c').activity, null, 'a frozen member has no activity');
  assert.equal(data.members.find(m => m.id === 'member:d').activity, null, 'unknown state is absent, never an idle');
  assert.equal(running.history.length, 3, 'at most three events');
  assert.deepEqual(running.history.map(entry => entry.kind), ['message', 'message', 'message']);
  assert.ok(running.history[0].at >= running.history[1].at, 'newest first');
});

test('P4/P8/P9: capabilities, dead letters and the two unknown classes', () => {
  const data = panel(fixture());
  const task = data.tasks.find(row => row.id === 'task:t2');
  assert.equal(task.capabilities['scheduler.approveContract'].allowed, false, 'blocked is not an unapproved draft');
  const effect = data.unknownEffects.find(row => row.id === 'effect:merge:1');
  assert.equal(effect.class, 'effect');
  assert.equal(effect.effectKind, 'merge');
  assert.deepEqual(effect.evidence, [{ at: 1400, text: '回执丢失', ref: 'effect-evidence:merge:1' }]);
  assert.equal(effect.capabilities['mailbox.resolveUnknown'].reasonCode, 'OPERATOR_ONLY');
  assert.equal(data.unknownEffects.find(row => row.id.startsWith('read-model:')).class, 'read-model');
  assert.equal(data.messages.find(row => row.id === 'message:m1').deadLetter, null);
  assert.equal(data.messages.find(row => row.id === 'message:m2').deadLetter.reason, 'receipt-lost');
});

test('P4: a member never gets a root-only capability, and an inactive member gets none at all', () => {
  const rows = fixture();
  const worker = view(rows, WORKER, rows);
  const own = worker.members.find(m => m.id === WORKER);
  assert.equal(own.capabilities['organization.retire'].allowed, false);
  assert.equal(own.capabilities['organization.retire'].reasonCode, 'ROLE_DENIED');
  assert.equal(worker.threads.find(row => row.id === 'thread:d1').capabilities['threads.decide'].allowed, false,
    'an escalated worker thread cannot be decided by the browser');
  const frozen = view(rows, 'member:c', rows, { protocol: 'v1' });
  const inbound = frozen.messages.find(row => row.id === 'message:m3');
  assert.equal(inbound.capabilities['mailbox.send'].reasonCode, 'TARGET_RECIPIENT_MISMATCH');
  assert.equal(frozen.members.find(m => m.id === 'member:c').capabilities['mailbox.send'].reasonCode, 'MEMBER_INACTIVE');
});

test('P6: an intent window carries each recipient\'s delivery, reply and unseen-at-pass fact', () => {
  const data = panel(fixture());
  assert.equal(data.intents.length, 1);
  const [intent] = data.intents;
  assert.equal(intent.summary, '合入主干');
  assert.equal(intent.state, 'open');
  assert.deepEqual(intent.recipients, [{ member: 'member:b', delivery: 'stored', reply: null, reason: null, at: null }]);
  assert.deepEqual(intent.unseenAtPass, ['member:b']);
  assert.equal(intent.closesAt, 9000);
});

test('P12/P2: the records timeline reads rows, and a session resolves to its team', () => {
  const rows = fixture();
  const events = [...rows.values()].map((row, index) => ({ seq: index + 1, entity: row.entityId,
    revision: row.revision, payload: row }));
  const projection = new Projection({ events: seq => events.filter(event => event.seq > seq) },
    { readerIdentity: { teamId: 'team-x' }, routeSession: sessionId => ({
      routed: ['ses-root', 'ses-a'].includes(sessionId), teamId: 'team-x',
      kind: sessionId === 'ses-root' ? 'owner' : 'execution', memberId: WORKER, generation: 1 }) });
  const timeline = projection.activity(ROOT, {});
  assert.ok(timeline.events.length >= 5);
  assert.deepEqual(timeline.events.map(event => event.at), [...timeline.events.map(event => event.at)].sort((a, b) => b - a));
  assert.ok(timeline.events.every(event => Number.isFinite(event.at)), 'no entry without a committed time');
  assert.ok(timeline.events.some(event => event.kind === 'task'),
    'task transitions use the committed updatedAt timestamp');
  const anomalies = projection.activity(ROOT, { kind: 'anomaly' });
  assert.ok(anomalies.events.some(event => event.id === 'message:m2'), 'a dead letter is an anomaly');
  assert.ok(anomalies.events.every(event => event.category === 'anomaly'));
  assert.equal(projection.activity(ROOT, { kind: 'delivery' }).events.length, 2);
  assert.deepEqual(projection.activity(ROOT, { from: 9000 }).events, []);
  assert.equal(projection.activity(ROOT, { limit: 2 }).events.length, 2);
  assert.deepEqual(projection.binding(ROOT, 'ses-a'), { teamId: 'team-x', role: 'member', memberId: WORKER });
  assert.deepEqual(projection.binding(ROOT, 'ses-root'), { teamId: 'team-x', role: 'leader', memberId: ROOT });
  assert.equal(projection.binding(ROOT, 'ses-unknown'), null);
  assert.equal(projection.binding(ROOT, null), null);
});

test('the panel option refuses a value it does not know', () => {
  assert.throws(() => new Projection({ events: () => [] }, { panel: 'v4' }), { message: 'INVALID_PANEL' });
});
