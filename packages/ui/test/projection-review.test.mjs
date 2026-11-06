// M6 review #1/#4/#5/#6 and mutually-exclusive roster regressions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Projection, view } from '../../projections/index.mjs';

const ROOT = 'member:root', WORKER = 'member:a', VIEWER = 'member:viewer';
function fixture() {
  const rows = new Map();
  const put = (id, data) => rows.set(id, { revision: 1, updatedAt: 1000,
    acl: [WORKER, VIEWER], ...data, entityId: id });
  for (const [id, role] of [[ROOT, 'root'], [WORKER, 'worker'], [VIEWER, 'viewer']]) {
    put(id, { role, group: 'g', desired: 'active', observed: 'running', generation: 1 });
  }
  put('message:intent', { kind: 'intent', sender: ROOT, recipients: [WORKER], status: 'open',
    summary: 'visible proposal', createdAt: 100, closesAt: 9000, receiptTimes: {} });
  return { rows, put };
}
const panel = (rows, actor = ROOT, policy = rows) => view(rows, actor, policy, { protocol: 'v1', now: 5000 });
const eventsOf = rows => [...rows.values()].map((payload, i) => ({ seq: i + 1, entity: payload.entityId, payload }));

test('review #1: hidden goal/evidence never become panel inputs for member or viewer', () => {
  const { rows, put } = fixture();
  put('team-goal:private', { objective: 'SECRET-GOAL', openedAt: 100, acl: [] });
  put('effect:x', { status: 'unknown', createdAt: 100, payload: { kind: 'merge' } });
  put('effect-evidence:private', { effectId: 'effect:x', message: 'SECRET-EVIDENCE', at: 200, acl: [] });
  for (const actor of [WORKER, VIEWER]) {
    const data = panel(rows, actor);
    assert.equal(data.team, undefined);
    assert.deepEqual(data.unknownEffects.find(row => row.id === 'effect:x').evidence, []);
    assert.equal(JSON.stringify(data).includes('SECRET'), false);
  }
  put('team-goal:public', { objective: 'public goal', openedAt: 100 });
  put(ROOT, { ...rows.get(ROOT), acl: [] });
  for (const actor of [WORKER, VIEWER]) {
    const data = view(rows, actor, rows, { protocol: 'v1', leaderSessionId: 'hidden-owner-session' });
    assert.equal(data.team.name, 'public goal');
    assert.equal(data.team.leaderSessionId, null, 'metadata cannot bypass the hidden root binding');
  }
});

test('review #1: replay uses current policy after intent permission is revoked', () => {
  for (const actor of [WORKER, VIEWER]) {
    const { rows, put } = fixture();
    put('message:secret', { kind: 'intent', sender: 'member:other', recipients: ['member:other'],
      summary: 'REVOKED-SECRET', createdAt: 100, status: 'open', receiptTimes: {} });
    const historical = new Map(rows);
    put('message:secret', { ...rows.get('message:secret'), acl: [], revision: 2 });
    const data = panel(historical, actor, rows);
    assert.equal(data.messages.some(row => row.id === 'message:secret'), false);
    assert.equal(data.intents.some(row => row.id === 'message:secret'), false);
    assert.equal(JSON.stringify(data).includes('REVOKED-SECRET'), false);
    const events = eventsOf(historical);
    events.push({ seq: events.length + 1, entity: 'message:secret', payload: rows.get('message:secret') });
    const projection = new Projection({ events: seq => events.filter(event => event.seq > seq) }, { protocol: 'v1' });
    assert.equal(JSON.stringify(projection.events(actor, 0)).includes('REVOKED-SECRET'), false);
    assert.equal(JSON.stringify(projection.activity(actor)).includes('REVOKED-SECRET'), false);
    projection.close();
  }
});

test('review #4: ok -> root-handling -> needs-you; ordinary approval/thread never asks a human', () => {
  const { rows, put } = fixture();
  assert.equal(panel(rows).summary.headline.kind, 'ok');
  put('task:blocked', { owner: WORKER, status: 'blocked', approved: true, contractRevision: 1 });
  assert.equal(panel(rows).summary.headline.kind, 'root-handling');
  put('task:draft', { owner: WORKER, status: 'draft', approved: false, contractRevision: 1 });
  put('thread:normal', { owner: WORKER, escalationOwner: ROOT, responsible: ROOT, escalatedBy: ROOT,
    status: 'escalated', question: 'ordinary root work', createdAt: 200,
    requiredRespondents: [], replies: [], proposalRevision: 1, decisionRevision: 0 });
  assert.deepEqual(panel(rows).escalations, []);
  assert.equal(panel(rows).summary.headline.kind, 'root-handling');
  put('thread:human', { ...rows.get('thread:normal'), responsible: 'operator', escalatedBy: ROOT, escalatedAt: 1000 });
  const data = panel(rows);
  assert.equal(data.summary.headline.kind, 'needs-you');
  assert.equal(data.escalations.length, 1);
  assert.equal(data.escalations[0].subject.id, 'thread:human');
  assert.equal(data.escalations[0].primary, null, 'escalated thread has no impossible decide button');
  assert.equal(data.escalations[0].waitingMs, 4000);
});

test('review #4/#7: safety notes name the object, elapsed wait, and the exact operator entry, with no buttons', () => {
  const { rows, put } = fixture();
  put('member:stuck', { role: 'worker', group: 'g', generation: 1, desired: 'frozen',
    observed: 'unknown', status: 'unknown', nativeRef: 'real-stuck-session' });
  put('attempt:stuck', { owner: 'member:stuck', taskId: 'task:stuck', status: 'unknown', lease: 'unknown', fence: 1 });
  put('decision:stuck', { kind: 'stuck-member', state: 'open', openedAt: 1000,
    subject: { type: 'member', id: 'member:stuck', revision: 1 }, options: ['wait'], evidence: [] });
  put('control-slot:x', { state: 'unknown', lane: 'human', holderKind: 'owner-request',
    holderRef: 'call:x', callIdentity: 'call:x', hostEpoch: 3, startedAt: 2000 });
  put('effect-io:x:1', { effectId: 'x', fence: 1, state: 'unknown', startedAt: 3000 });
  put('delivery:x', { status: 'unknown', createdAt: 1000, taskId: 'task:x' });
  put('message:unknown', { kind: 'info', sender: ROOT, recipient: WORKER,
    status: 'unknown', createdAt: 1000, receiptTimes: {} });
  const escalations = panel(rows).escalations;
  const stuck = escalations.find(row => row.subject.id === 'decision:stuck');
  assert.match(stuck.note, /real-stuck-session.*4000.*confirmStopped.*attempt:stuck/);
  assert.ok(stuck.note.endsWith('operator 入口：organization.confirmStopped(target=attempt:stuck, args:{evidenceRef}, expectedRevision=<row revision>)'),
    'the note names the exact gateway entry, including the revision the operator must send');
  const capacity = escalations.find(row => row.subject.id === 'control-slot:x');
  assert.match(capacity.note, /control-slot:x.*call:x.*3000.*settleOwnerControl.*hostEpoch:3/);
  assert.match(escalations.find(row => row.subject.id === 'effect-io:x:1').note, /2000.*effectRunner.reclaim.*fence:1/);
  assert.match(escalations.find(row => row.subject.id === 'delivery:x').note, /delivery.reconcile/);
  assert.match(escalations.find(row => row.subject.id === 'message:unknown').note, /mailbox.resolveUnknown/);
  assert.ok(escalations.every(row => row.primary === null));
  assert.ok(escalations.every(row => !row.secondary));
  assert.equal(panel(rows).summary.headline.kind, 'needs-you');
});

test('roster buckets are exclusive even when frozen/retiring members own blocked tasks', () => {
  const { rows, put } = fixture();
  put('member:frozen', { role: 'worker', group: 'g', desired: 'frozen', observed: 'frozen', generation: 1 });
  put('member:retiring', { role: 'worker', group: 'g', desired: 'retired', observed: 'running', generation: 1 });
  for (const id of ['frozen', 'retiring']) put('task:' + id, { owner: 'member:' + id, status: 'blocked' });
  const data = panel(rows), counts = data.memberSummary;
  assert.equal(counts.paused, 1);
  assert.equal(counts.retiring, 1);
  assert.equal(counts.stuck, 0);
  assert.equal(counts.normal + counts.stuck + counts.paused + counts.retiring + counts.idle, data.members.length);
});

test('review #6: repeated committed updates retain seq/time, paginate without duplicates, and include delivery/needs-you', () => {
  const { rows, put } = fixture();
  put('task:x', { owner: WORKER, status: 'draft', title: 'commit one', updatedAt: 2000 });
  const events = eventsOf(rows);
  for (const [status, updatedAt] of [['produced', 3000], ['accepted', 4000]]) {
    events.push({ seq: events.length + 1, entity: 'task:x',
      payload: { ...rows.get('task:x'), status, revision: events.length, updatedAt } });
  }
  put('thread:human', { owner: ROOT, responsible: 'operator', status: 'escalated', escalatedBy: ROOT,
    question: 'human decision', requiredRespondents: [], replies: [], updatedAt: 5000 });
  events.push({ seq: events.length + 1, entity: 'thread:human', payload: rows.get('thread:human') });
  const reader = { events: seq => events.filter(event => event.seq > seq) };
  const projection = new Projection(reader);
  const deliveries = projection.activity(ROOT, { kind: 'delivery' });
  assert.equal(deliveries.events.length, 3);
  assert.deepEqual(deliveries.events.map(event => event.at), [4000, 3000, 2000]);
  assert.equal(new Set(deliveries.events.map(event => event.seq)).size, 3);
  assert.ok(deliveries.events.every(event => event.tags.length && event.subject.name === 'commit one'));
  assert.equal(projection.activity(ROOT, { kind: 'needs-you' }).events.length, 1);
  assert.ok(deliveries.events.every(event => !/draft|accepted|produced/.test(event.text)), 'timeline text uses human labels');
  assert.ok(projection.activity(ROOT, { member: WORKER }).events.some(event => event.id === WORKER),
    'member lifecycle commits participate in the member filter');
  const empty = projection.activity(ROOT, { kind: 'delivery', from: 9000 });
  assert.equal(empty.events.length, 0);
  assert.equal(empty.nextAfterSeq, events.length, 'empty filtered pages still advance through the committed log');
  assert.equal(projection.activity(ROOT, { kind: 'delivery', member: WORKER, from: 3000, to: 4000 }).events.length, 2);
  const seqs = []; let afterSeq = 0;
  for (;;) {
    const page = projection.activity(ROOT, { afterSeq, limit: 2 });
    seqs.push(...page.events.map(event => event.seq));
    assert.ok(page.events.every(event => event.seq > afterSeq));
    afterSeq = page.nextAfterSeq;
    if (!page.hasMore) break;
  }
  assert.equal(new Set(seqs).size, events.length);
  assert.equal(seqs.length, events.length);
  assert.equal(projection.activity(ROOT, { afterSeq }).events.length, 0);
  assert.throws(() => projection.activity(ROOT, { afterSeq: -1 }), /INVALID_CURSOR/);
  const bounded = new Projection(reader, { recentLimit: 2 });
  assert.equal(bounded.activity(ROOT).events.length, 2);
  assert.throws(() => bounded.activity(ROOT, { afterSeq: 0 }), { code: 'RESYNC_REQUIRED' });
  assert.equal(bounded.activity(ROOT).replayAfterSeq, events.length - 2);
  projection.close(); bounded.close();
});

test('WP-1 server contract: snapshot + all registered SSE blocks converges (WP-4 client wiring remains separate)', () => {
  const { rows, put } = fixture();
  const events = eventsOf(rows);
  const projection = new Projection({ events: seq => events.filter(event => event.seq > seq) });
  const merged = structuredClone(projection.snapshot(ROOT).data);
  put('task:new', { owner: WORKER, title: 'new delivery', status: 'accepted', approved: true });
  events.push({ seq: events.length + 1, entity: 'task:new', payload: rows.get('task:new') });
  put('message:intent', { ...rows.get('message:intent'), status: 'closed', decision: 'passed', revision: 2 });
  events.push({ seq: events.length + 1, entity: 'message:intent', payload: rows.get('message:intent') });
  for (const delta of projection.events(ROOT, events.length - 2)) {
    for (const [key, upserts] of Object.entries(delta.upserts)) {
      const current = (merged[key] ?? []).filter(row => !(delta.removes[key] ?? []).includes(row.id));
      for (const row of upserts) {
        const i = current.findIndex(old => old.id === row.id);
        if (i < 0) current.push(row); else current[i] = row;
      }
      merged[key] = current;
    }
    for (const key of ['summary', 'memberSummary', 'delivery', 'escalations', 'intents', 'team', 'viewerRole',
      'goal', 'groups', 'restrictedMembers']) if (key in delta) merged[key] = delta[key];
  }
  const latest = projection.snapshot(ROOT).data;
  for (const key of Object.keys(merged)) assert.deepEqual(merged[key], latest[key], key);
  assert.equal(merged.summary.accepted, 1);
  assert.equal(merged.intents[0].state, 'passed');
  projection.close();
});

test('safety survives wait/TTL and an unknown attempt without any control-slot row', () => {
  const { rows, put } = fixture();
  put('member:stuck', { role: 'worker', group: 'g', desired: 'frozen', status: 'unknown',
    observed: 'unknown', nativeRef: 'session:stuck', generation: 1 });
  put('attempt:stuck', { owner: 'member:stuck', taskId: 'task:x', lease: 'unknown', status: 'unknown', admittedAt: 2000 });
  put('decision:stuck', { kind: 'stuck-member', state: 'decided', verdict: { option: 'wait' },
    subject: { type: 'member', id: 'member:stuck' }, openedAt: 1000, evidence: [], options: ['wait'] });
  let data = panel(rows);
  assert.equal(data.capacity.admissionClosed, true);
  assert.match(data.escalations.find(row => row.subject.id === 'decision:stuck').note,
    /session:stuck.*4000.*confirmStopped.*attempt:stuck/);
  assert.ok(data.escalations.find(row => row.subject.id === 'decision:stuck').note.endsWith(
    'operator 入口：organization.confirmStopped(target=attempt:stuck, args:{evidenceRef}, expectedRevision=<row revision>)'));
  assert.deepEqual(data.escalations[0].sources.sort(), ['attempt:stuck', 'decision:stuck']);
  assert.equal(data.escalations.length, 1, 'one stop, not separate decision and attempt incidents');
  assert.match(data.summary.headline.text, /1 件/);
  put('decision:stuck', { ...rows.get('decision:stuck'), state: 'expired' });
  assert.ok(panel(rows).escalations.some(row => row.subject.id === 'decision:stuck'));
  put('member:stuck', { ...rows.get('member:stuck'), observed: 'stopped', status: 'frozen' });
  put('attempt:stuck', { ...rows.get('attempt:stuck'), lease: 'revoked', status: 'cancelled' });
  data = panel(rows);
  assert.equal(data.escalations.some(row => row.subject.id === 'decision:stuck'), false);
  assert.equal(data.escalations.some(row => row.subject.id === 'attempt:stuck'), false);
});


test('execution-alert safety uses the real E.executionSessionId and clears only on released scope evidence', () => {
  const { rows, put } = fixture();
  put('execution-alert:x', { E: { memberId: WORKER, executionSessionId: 'actual-execution-session',
    executionEpoch: 'epoch-x', attemptId: 'attempt:x' }, stopState: 'unverified' });
  put('decision:alert', { kind: 'stuck-member', state: 'open', openedAt: 1000, options: ['wait'], evidence: [],
    subject: { type: 'execution-alert', id: 'execution-alert:x' } });
  assert.match(panel(rows).escalations.find(row => row.subject.id === 'decision:alert').note,
    /actual-execution-session.*4000.*core.decideDecision.*operator.*不释放占用/);
  put('execution-scope:epoch-x', { state: 'RELEASED' });
  assert.equal(panel(rows).escalations.some(row => row.subject.id === 'decision:alert'), false);
});

