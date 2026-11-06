// Round 2 #2/#3/#4: production view/snapshot contracts against committed facts and actual command entries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Projection, view, submit } from '../../projections/index.mjs';
import { realTeam, ROOT, WORKER } from './review-fixture.mjs';

const COORD = 'member:coord';
const rowsOf = team => new Map(team.store.list().map(row => [row.entityId, row]));
function setupThread(team) {
  team.put('artifact:conclusion', { acl: [COORD], summary: 'public conclusion' });
  team.put('task:private-gate', { owner: WORKER, acl: [COORD], status: 'ready', contractRevision: 1 });
  team.put('thread:coord', { owner: COORD, question: 'visible coordination', status: 'collecting',
    proposalRevision: 1, decisionRevision: 0, taskRef: 'task:private-gate', createdAt: 100,
    deadline: new Date(Date.now() + 600000).toISOString(), requiredRespondents: [], requiredEvidence: [], replies: [] });
}
function compareProduction(team, projection, expected, code = null) {
  const rows = rowsOf(team);
  const direct = view(rows, COORD, rows, { protocol: 'v1' });
  const snapshot = projection.snapshot(COORD);
  for (const data of [direct, snapshot.data]) {
    const capability = data.threads.find(row => row.id === 'thread:coord').capabilities['threads.decide'];
    assert.equal(capability.allowed, expected);
    if (code) assert.equal(capability.reasonCode, code);
    assert.equal(JSON.stringify(data).includes('SECRET-GATE'), false);
    assert.equal(JSON.stringify(data).includes('decision:hidden'), false);
  }
  assert.equal('completion:hidden' in snapshot.sourceRevisions, false);
  const result = submit(team.core, COORD, { name: 'threads.decide', target: 'thread:coord',
    expectedRevision: team.store.read('thread:coord').revision,
    args: { proposalRevision: 1, conclusionRef: 'artifact:conclusion' } });
  assert.equal(result.status === 'accepted', expected);
  return result;
}

test('private completion freezes the visible coordinator thread through both view and managed snapshot', () => {
  const team = realTeam(); let projection;
  try {
    setupThread(team);
    projection = new Projection(team.store, { protocol: 'v1' });
    team.put('completion:hidden', { status: 'prepared', reason: 'SECRET-GATE' });
    const result = compareProduction(team, projection, false, 'COMPLETION_FROZEN');
    assert.match(result.message, /COMPLETION_FROZEN/);
    assert.equal(team.store.read('thread:coord').status, 'collecting');
    team.put('completion:hidden', { status: 'consumed', reason: 'SECRET-GATE' });
    assert.equal(compareProduction(team, projection, true).status, 'accepted');
  } finally { projection?.close(); team.close(); }
});

test('private coordination gates and their hidden approval predecessors match actual submit through production snapshots', () => {
  const team = realTeam({ collab: 'on', autonomy: 'on', superagentBorrow: 'v1', intentSemantics: 'root-decision-v1' });
  let projection;
  try {
    setupThread(team);
    projection = new Projection(team.store, { protocol: 'v1', recentLimit: 1 });
    for (const [state, option] of [['open', null], ['expired', null], ['decided', 'reject']]) {
      team.put('decision:hidden', { kind: 'coordination', state, summary: 'SECRET-GATE',
        verdict: option ? { option } : null, binding: { taskRef: 'task:private-gate', contractRevision: 1 } });
      assert.match(compareProduction(team, projection, false, 'COORDINATION_PENDING').message, /COORDINATION_/);
    }
    team.put('decision:hidden', { ...team.store.read('decision:hidden'), state: 'expired', verdict: null });
    team.put('decision:approval', { kind: 'coordination', state: 'decided', verdict: { option: 'approve' },
      binding: { taskRef: 'task:private-gate', contractRevision: 1, previousDecisionId: 'decision:hidden' } });
    assert.equal(compareProduction(team, projection, true).status, 'accepted');
  } finally { projection?.close(); team.close(); }
});

test('real intent send/reply rows expose openedAt and votes to sender/recipients, never to an unrelated member', () => {
  const team = realTeam({ collab: 'on', autonomy: 'on', intentWindowMs: 60000 }); let projection;
  try {
    team.put('task:intent', { owner: ROOT, status: 'ready', contractRevision: 1 });
    const id = team.core.send(ROOT, [WORKER, 'member:b'], 'intent', 'real proposal',
      { taskRef: 'task:intent', contractRevision: 1 }).result.entityId;
    const sent = team.store.read(id);
    assert.equal(sent.recipient, undefined);
    assert.equal(sent.acl, undefined, 'no artificial visibility ACL');
    assert.ok(Number.isFinite(sent.openedAt));
    team.core.replyIntent(id, WORKER, 'ok', 'workable');
    team.core.replyIntent(id, 'member:b', 'object', 'needs revision');
    const committed = team.store.read(id);
    projection = new Projection(team.store);
    for (const actor of [ROOT, WORKER, 'member:b']) {
      projection.sync();
      const rows = new Map(projection.rows);
      for (const data of [view(rows, actor, rows), projection.snapshot(actor).data]) {
        const intent = data.intents.find(row => row.id === id);
        assert.ok(intent, actor + ' can read its committed intent');
        assert.equal(intent.openedAt, sent.openedAt);
        assert.deepEqual(intent.recipients.map(row => ({ member: row.member, reply: row.reply, reason: row.reason, at: row.at })),
          [WORKER, 'member:b'].map(member => ({ member, reply: committed.votes[member].verdict,
            reason: committed.votes[member].reason, at: committed.votes[member].at })));
        assert.equal(data.messages.find(row => row.id === id).openedAt, sent.createdAt ?? sent.openedAt,
          'legacy message timestamp stays unchanged; intents use their authoritative openedAt');
      }
    }
    const unrelated = projection.snapshot(COORD).data;
    assert.equal(unrelated.messages.some(row => row.id === id), false);
    assert.equal((unrelated.intents ?? []).some(row => row.id === id), false);
    const historical = new Map(projection.rows), policy = new Map(historical);
    policy.set(id, { ...policy.get(id), recipients: [] });
    const revoked = view(historical, WORKER, policy, { protocol: 'v1' });
    assert.equal(revoked.messages.some(row => row.id === id), false);
    assert.equal(revoked.intents.some(row => row.id === id), false, 'historical recipient membership cannot bypass current policy');
  } finally { projection?.close(); team.close(); }
});

test('one stop subject unifies decision/attempt/slot/alert while independent execution incidents stay separate', () => {
  const team = realTeam(); let projection;
  try {
    team.put(WORKER, { ...team.store.read(WORKER), status: 'unknown', observed: 'unknown', nativeRef: 'session:a' });
    team.put('attempt:a', { owner: WORKER, taskId: 'task:a', lease: 'unknown', status: 'unknown',
      generation: 1, executionEpoch: 'epoch-a', admittedAt: 1000 });
    projection = new Projection(team.store, { protocol: 'v1' });
    const initialId = projection.snapshot(ROOT).data.escalations[0].id;
    team.put('decision:stop', { kind: 'stuck-member', state: 'open', options: ['wait'], evidence: [],
      subject: { type: 'member', id: WORKER }, openedAt: 2000 });
    team.put('control-slot:a', { holderRef: 'attempt:a', holderKind: 'execution', state: 'unknown', lane: 'normal', startedAt: 1000 });
    team.put('execution-alert:a', { E: { executionEpoch: 'epoch-a', memberId: WORKER,
      executionSessionId: 'session:a' }, stopState: 'unverified' });
    team.put('decision:alert', { kind: 'stuck-member', state: 'open', options: ['wait'], evidence: [],
      subject: { type: 'execution-alert', id: 'execution-alert:a' }, openedAt: 2000 });
    let data = projection.snapshot(ROOT).data;
    assert.equal(data.escalations.length, 1);
    assert.equal(data.escalations[0].id, initialId, 'adding evidence does not mint another incident identity');
    assert.deepEqual(data.escalations[0].sources.sort(), ['attempt:a', 'control-slot:a', 'decision:alert', 'decision:stop']);
    assert.match(data.summary.headline.text, /1 件/);
    assert.equal(data.escalations[0].primary, null);
    team.put('member:b', { ...team.store.read('member:b'), status: 'unknown', observed: 'unknown', nativeRef: 'session:b' });
    team.put('attempt:b', { owner: 'member:b', taskId: 'task:b', lease: 'unknown', status: 'unknown',
      generation: 1, executionEpoch: 'epoch-b', admittedAt: 3000 });
    team.put('decision:stop-b', { kind: 'stuck-member', state: 'open', options: ['wait'], evidence: [],
      subject: { type: 'attempt', id: 'attempt:b' }, openedAt: 3000 });
    data = projection.snapshot(ROOT).data;
    assert.equal(data.escalations.length, 2);
    assert.equal(new Set(data.escalations.map(row => row.issueKey)).size, 2);
    assert.match(data.summary.headline.text, /2 件/);
  } finally { projection?.close(); team.close(); }
});
