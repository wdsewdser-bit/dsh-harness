// §3 of the super-agent borrow design (P1): resource threads, thread events and the root-decision intent.
//
// Every case runs offline against a real control store: the shared reducer, the clock, the core entries and the read
// model, with no provider and no host. The core is configured v1 (superagentBorrow 'v1' + intentSemantics
// 'root-decision-v1') so the S1 reducers are exercised as they will run once the protocol can boot; the composition
// root still refuses to activate v1, which the first case pins. The legacy arm keeps its own tests (collab-protocol)
// and this file only asserts that it is still the one a default team runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../index.mjs';
import { handleTool } from '../tools.mjs';
import { unresolvedDecisionThreads } from '../goal-gate.mjs';
import { readThreadEvents, resourceThreadView, threadRetention } from '../thread-events.mjs';
import { coordinationBlock } from '../commands/intents.mjs';
import { implementGateSummary, intentProtocol, intentState } from '../collab.mjs';
import { snapshot } from '../snapshot.mjs';
import { toolCommand } from '../tool-reducer.mjs';
import { cancelMessage } from '../mailbox.mjs';
import { BORROW_IMPLEMENTATION_STAGES, ROOT_DECISION_SEMANTICS, assertProtocolSupported, borrowReadiness,
  superagentBorrowConfig } from '../../contracts/index.mjs';


import { root, REPOSITORIES, future, codeOf, team, openResource, subscribe, unsubscribe, publishWith, publish, deliveries, events, forMember,
  requestCoordination, verdict, resultEffects } from '../test-support/s1-fixtures.mjs';

test('§2/§10: P1 records S1 as installed and still refuses to activate v1', () => {
  assert.equal(BORROW_IMPLEMENTATION_STAGES.s1.status, 'implemented');
  assert.equal(BORROW_IMPLEMENTATION_STAGES.s2.status, 'implemented', 'P2 now implements the role boundary');
  assert.equal(BORROW_IMPLEMENTATION_STAGES.s3.status, 'implemented', 'P3 now implements the input batch');
  assert.equal(BORROW_IMPLEMENTATION_STAGES.s5.status, 'implemented', 'P5 now wires the projection/UI/acceptance');
  assert.equal(BORROW_IMPLEMENTATION_STAGES.s4.status, 'implemented', 'P4 now implements capacity');
  const v1 = superagentBorrowConfig({ superagentBorrow: 'v1', intentSemantics: ROOT_DECISION_SEMANTICS });
  const readiness = borrowReadiness(v1);
  assert.equal(readiness.ready, false, 'one installed mechanism is not a v1 build');
  // P5 is installed, so the only remaining stage blocker is the position itself: activation still requires the
  // public profile/policy path and the v1 model surface, which this build does not accept.
  assert(readiness.blockers.some(blocker => blocker.id === 'v1-not-implemented'));
  assert.equal(readiness.blockers.some(blocker => blocker.id === 's5-projections-not-implemented'), false);
  assert.equal(readiness.blockers.some(blocker => blocker.id === 's4-human-capacity-not-implemented'), false);
  assert.equal(readiness.blockers.some(blocker => blocker.id === 's1-thread-intent-not-implemented'), false);
  assert.equal(readiness.blockers.some(blocker => blocker.id === 's2-root-guard-not-implemented'), false);
  assert.throws(() => assertProtocolSupported(v1), error => error?.code === 'PROTOCOL_UNSUPPORTED');
});

test('§2: an off team still runs M2b, and v1 is selected only by the explicit configuration', () => {
  const t = team('off', { superagentBorrow: 'off', intentSemantics: 'undecided' });
  try {
    assert.equal(intentProtocol(t.core), 'silence-pass-m2b');
    t.core.task('task:probe', 'member:fe');
    const attempt = t.core.schedule(t.op('admit'), 'task:probe').result;
    const refused = codeOf(() => t.core.finish(attempt.attemptId, attempt.fence));
    assert.equal(refused, 'INTENT_REQUIRED', 'off keeps the per-task intent requirement byte for byte');
  } finally { t.close(); }
});

// --- T01 ----------------------------------------------------------------------------------------------------------------

test('T01: a legacy thread without kind replays as a decision thread, and a resource thread never blocks the goal', () => {
  const t = team('t01');
  try {
    // A row written before the discriminant existed: no kind field at all.
    t.core.mutate('thread:legacy', 'member:fe', {}, tx => tx.put('thread:legacy', { owner: 'member:fe',
      requiredRespondents: ['member:be'], requiredEvidence: [], question: 'ship it?', deadline: future(60000),
      escalationOwner: 'member:root', taskRef: null, proposalRevision: 1, decisionRevision: 0, replies: [],
      status: 'collecting' }));
    const read = handleTool(t.core, { actor: 'member:fe' }, 'team_read', { view: 'thread', ref: 'thread:legacy' });
    assert.equal(read.refs[0].kind, 'decision', 'a legacy row is read as a decision thread');
    assert.equal(t.store.read('thread:legacy').kind, undefined, 'and history is not rewritten to say so');
    t.core.reply('thread:legacy', 'member:be', 1, 'artifact:1:be');
    assert.deepEqual(t.store.read('thread:legacy').missing, []);
    t.core.decide('thread:legacy', 'member:fe', 1, 'artifact:1:fe');
    assert.equal(t.store.read('thread:legacy').status, 'decided');

    const resource = openResource(t, 'member:fe', { kind: 'branch', repositoryKey: 'repo:acme/app', key: 'refs/heads/main' });
    assert.equal(resource.kind, 'resource');
    assert.equal(resource.status, 'open');
    assert.equal(codeOf(() => t.core.decide(resource.entityId, 'member:fe', 1, 'artifact:1:x')), 'WRONG_THREAD_KIND');
    assert.equal(codeOf(() => t.core.reply(resource.entityId, 'member:fe', 1, 'artifact:1:fe')), 'WRONG_THREAD_KIND');
    // And a member who is not part of the resource cannot even reach the kind refusal: the shared reference check refuses
    // first, so an id alone never grants access to somebody else's topic.
    assert.equal(codeOf(() => t.core.reply(resource.entityId, 'member:be', 1, 'artifact:1:be')),
      'REFERENCE_ACL:' + resource.entityId);
    // §3.4: a resource thread that stays open is not an unmet team state, and the goal predicate says so.
    assert.equal(unresolvedDecisionThreads(t.store).length, 0);
    t.core.mutate('thread:legacy', 'member:fe', {}, (tx, row) => tx.put('thread:legacy', { ...row, status: 'collecting' }));
    assert.deepEqual(unresolvedDecisionThreads(t.store).map(row => row.entityId), ['thread:legacy'],
      'only the decision thread blocks');
  } finally { t.close(); }
});

// --- T02 ----------------------------------------------------------------------------------------------------------------

test('T02: one canonical thread per resource; repository identity and key normalisation are enforced', () => {
  const t = team('t02');
  try {
    const branch = { kind: 'branch', repositoryKey: 'repo:acme/app', key: 'refs/heads/main' };
    const first = openResource(t, 'member:fe', branch);
    const second = openResource(t, 'member:be', branch);
    assert.equal(second.entityId, first.entityId, 'the resource index answers the same thread, it does not open a second');
    assert.equal(t.store.list('thread-resource:').length, 1);
    const other = openResource(t, 'member:fe', { ...branch, repositoryKey: 'repo:acme/other' });
    assert.notEqual(other.entityId, first.entityId, 'the same ref in another repository is another resource');
    const pr = openResource(t, 'member:fe', { kind: 'pr', repositoryKey: 'repo:acme/app',
      key: { provider: 'github', repository: 'acme/app', number: 7 } });
    assert.equal(pr.resource.key, 'github/acme/app#7');
    assert.equal(codeOf(() => openResource(t, 'member:fe', { ...branch, repositoryKey: 'repo:forged/x' })),
      'UNKNOWN_REPOSITORY', 'a member cannot name an arbitrary repository');
    for (const key of ['../etc/passwd', '/abs/path', 'C:\\tmp', 'src\\fe', 'src//fe', './src', 'src/../be']) {
      assert.equal(codeOf(() => openResource(t, 'member:fe',
        { kind: 'file-area', repositoryKey: 'repo:acme/app', key })), 'INVALID_RESOURCE', key);
    }
    const area = openResource(t, 'member:fe', { kind: 'file-area', repositoryKey: 'repo:acme/app', key: 'src/fe' });
    assert.equal(area.resource.key, 'src/fe');
    const parent = openResource(t, 'member:fe', { kind: 'file-area', repositoryKey: 'repo:acme/app', key: 'src' });
    assert.notEqual(parent.entityId, area.entityId, 'a containing directory is a different subscription, not one topic');
  } finally { t.close(); }
});

// --- T03 ----------------------------------------------------------------------------------------------------------------

test('T03: subscribe/publish/unsubscribe permutations are decided by commit order, epoch and generation', () => {
  const t = team('t03');
  try {
    const thread = openResource(t, 'member:fe', { kind: 'branch', repositoryKey: 'repo:acme/app', key: 'refs/heads/main' });
    const ref = thread.entityId;
    // Published before anybody subscribed: the host port may report, and it has no audience yet.
    const first = publishWith(t, 'adapter', { issueId: ref, summary: 'delivery 1 accepted', operationId: t.op('host'),
      source: { kind: 'host-evidence', ref: 'delivery:1' }, hostEvidence: true });
    assert.deepEqual(first.result.delivered, []);
    assert.equal(first.result.seq, 1);
    // Subscribing now starts at the head this transaction read: no replay unless it is asked for.
    const feSub = subscribe(t, 'member:fe', ref);
    assert.equal(feSub.startAfterSeq, 1);
    assert.equal(feSub.subscriptionEpoch, 1);
    assert.deepEqual(deliveries(t, ref), []);
    assert.equal(subscribe(t, 'member:fe', ref).subscriptionEpoch, 1, 'the same subscription twice is one subscription');
    // A publisher that subscribes receives its own event; there is no 'I already know' shortcut.
    const reportOp = t.op('publish');
    const second = publishWith(t, 'member:fe', { issueId: ref, summary: 'refactor started', operationId: reportOp });
    assert.equal(second.result.seq, 2);
    assert.equal(second.result.delivered.length, 1);
    // One operationId allocates one sequence: the report can be retried without inflating the thread.
    const replay = publishWith(t, 'member:fe', { issueId: ref, summary: 'refactor started', operationId: reportOp });
    assert.equal(replay.result.seq, 2);
    assert.equal(events(t, ref).length, 2);
    assert.equal(deliveries(t, ref).length, 1);
    assert.equal(codeOf(() => publishWith(t, 'member:fe', { issueId: ref, summary: 'a different report',
      operationId: reportOp })), 'ID_CONFLICT', 'the same id with another payload is another report');

    const beSub = subscribe(t, 'member:be', ref);
    assert.equal(beSub.startAfterSeq, 2);
    const third = publish(t, 'member:fe', ref, 'conflict observed', { eventType: 'conflict-observed' });
    assert.equal(third.result.seq, 3);
    assert.equal(forMember(t, ref, 'member:fe').length, 2);
    assert.equal(forMember(t, ref, 'member:be').length, 1);

    const pendingBefore = forMember(t, ref, 'member:fe').filter(row => row.state === 'pending').length;
    assert.equal(pendingBefore, 2);
    const ended = unsubscribe(t, 'member:fe', ref, { reason: 'handing the area over' });
    assert.equal(ended.state, 'closed');
    assert.equal(ended.superseded, pendingBefore, 'exactly the pending deliveries of that epoch are superseded');
    assert.equal(forMember(t, ref, 'member:fe').filter(row => row.state === 'pending').length, 0);
    assert.equal(forMember(t, ref, 'member:be').filter(row => row.state === 'pending').length, 1);
    assert.equal(codeOf(() => publish(t, 'member:fe', ref, 'late report')), 'NOT_SUBSCRIBED');

    const resub = subscribe(t, 'member:fe', ref);
    assert.equal(resub.subscriptionEpoch, 2, 'a re-subscription is a new audience');
    assert.equal(resub.startAfterSeq, 3, 'and it starts at the current head');
    const replaySub = subscribe(t, 'member:fe', ref, { replayFrom: 1 });
    assert.equal(replaySub.subscriptionEpoch, 3);
    assert.equal(replaySub.startAfterSeq, 0);
    assert.equal(forMember(t, ref, 'member:fe').filter(row => row.subscriptionEpoch === 3).length, 3);

    // A replaced generation is not handed the events of the generation it replaced.
    t.core.mutate('member:be', 'root', {}, (tx, row) => tx.put('member:be', { ...row, generation: 2 }));
    const last = publish(t, 'member:fe', ref, 'after the rebind');
    assert.equal(last.result.seq, 4);
    assert.equal(forMember(t, ref, 'member:be').filter(row => row.seq === 4).length, 0);
    assert.equal(forMember(t, ref, 'member:fe').filter(row => row.seq === 4).length, 1);
  } finally { t.close(); }
});

// --- T04 ----------------------------------------------------------------------------------------------------------------

test('T04: two subscribers each get one delivery, root gets none, and publishing needs no intent', () => {
  const t = team('t04');
  try {
    const thread = openResource(t, 'member:fe', { kind: 'pr', repositoryKey: 'repo:acme/app',
      key: { provider: 'github', repository: 'acme/app', number: 9 } });
    const ref = thread.entityId;
    subscribe(t, 'member:fe', ref);
    subscribe(t, 'member:be', ref);
    const before = { decisions: t.store.list('decision:').length, messages: t.store.list('message:').length,
      attempts: t.store.list('attempt:').length };
    const published = publish(t, 'member:fe', ref, 'conflict observed', { eventType: 'conflict-observed' });
    assert.equal(published.result.delivered.length, 2);
    const rows = deliveries(t, ref);
    assert.deepEqual(rows.map(row => row.memberId).sort(), ['member:be', 'member:fe']);
    assert(rows.every(row => row.state === 'pending' && row.visibility === null));
    const wakes = t.store.effects().filter(effect => effect.payload.kind === 'wake' && effect.payload.threadRef === ref);
    assert.equal(wakes.length, 2, 'one durable wake per delivery');
    assert.deepEqual(wakes.map(effect => effect.id).sort(),
      rows.map(row => 'wake:' + row.entityId + ':' + row.memberId).sort());
    assert.equal(rows.filter(row => ['member:root', 'member:qa'].includes(row.memberId)).length, 0,
      'nobody who is not subscribed hears it, root included');
    assert.equal(t.store.list('decision:').length, before.decisions, 'a report opens no coordination request');
    assert.equal(t.store.list('message:').length, before.messages);
    assert.equal(t.store.list('attempt:').length, before.attempts);
    assert.equal(intentState(t.core, 'member:fe').sent, 0, 'and no intent: publishing is not a gate in v1');
    const page = readThreadEvents(t.store, { threadRef: ref });
    assert.deepEqual(page.events.map(event => event.seq), [1]);
    assert.deepEqual(readThreadEvents(t.store, { threadRef: ref, afterSeq: 1 }).events, []);
    const view = resourceThreadView(t.store, ref);
    assert.equal(view.head, 1);
    assert.equal(view.subscribers.length, 2);
    assert.equal(view.subscribers.every(sub => sub.pending === 1), true, 'each subscriber sees its pending count');
  } finally { t.close(); }
});
// --- The coordination request helper (the v1 form of team_message kind=intent) -------------------------------------------

test('T05: produce, verify, thread.decide and the API finish reach the same coordination conclusion', () => {
  const t = team('t05');
  try {
    const taskFe = 'task:fe-work', taskQa = 'task:qa-work';
    t.core.task(taskFe, 'member:fe');
    t.core.task(taskQa, 'member:qa');
    const deliveryRef = 'delivery:1:fe';
    // A delivery is addressed to the verifier that reviews it; without that fact the shared reference check refuses the
    // read, and the coordination gate would never be reached.
    t.core.mutate(deliveryRef, 'root', {}, tx => tx.put(deliveryRef, { taskId: taskFe, owner: 'member:fe',
      contractRevision: 1, acl: ['member:qa'] }));
    const issueId = 'thread:' + t.op('issue');
    t.core.mutate(issueId, 'member:fe', {}, tx => tx.put(issueId, { kind: 'decision', owner: 'member:fe',
      requiredRespondents: [], requiredEvidence: [], question: 'ship this revision?', deadline: future(60000),
      escalationOwner: 'member:root', taskRef: taskFe, proposalRevision: 1, decisionRevision: 0, replies: [],
      status: 'collecting' }));
    const feAttempt = t.core.schedule(t.op('admit-fe'), taskFe).result;
    const qaAttempt = t.core.schedule(t.op('admit-qa'), taskQa).result;
    const produce = () => handleTool(t.core, { actor: 'member:fe', attemptId: feAttempt.attemptId, fence: feAttempt.fence },
      'team_task', { operationId: t.op('produce'), expectedRevision: t.store.read(taskFe).revision, op: 'produce',
        taskRef: taskFe, deliveryRef });
    const verify = () => handleTool(t.core, { actor: 'member:qa', attemptId: qaAttempt.attemptId, fence: qaAttempt.fence },
      'team_verify', { operationId: t.op('verify'), deliveryRef, contractRevision: 1, verdict: 'pass',
        evidenceRefs: [deliveryRef], reason: 'the evidence is complete' });
    const decide = () => t.core.decide(issueId, 'member:fe', 1, 'artifact:1:conclusion');
    const finish = () => t.core.finish(feAttempt.attemptId, feAttempt.fence);

    // Two explicit requests: one on the producer's revision, one on the verifier's own task.
    const producerRequest = requestCoordination(t, 'member:be', { taskRef: taskFe });
    const verifierRequest = requestCoordination(t, 'member:be', { taskRef: taskQa });
    const blocked = { produce: codeOf(produce), verify: codeOf(verify), decide: codeOf(decide), finish: codeOf(finish) };
    for (const [name, code] of Object.entries(blocked)) assert.equal(code, 'COORDINATION_PENDING', name);
    assert.equal(t.store.read(taskFe).status, 'executing', 'a refused publish wrote nothing');
    assert.equal(t.store.read(issueId).status, 'collecting');
    assert.equal(t.store.list('verification-evidence:').length, 0);

    // Root clears both revisions: every entry proceeds, and nothing else was required of the members.
    verdict(t, producerRequest.decisionId, 'approve');
    verdict(t, verifierRequest.decisionId, 'approve');
    assert.equal(codeOf(produce), null, 'produce publishes with no intent at all');
    assert.equal(codeOf(verify), null);
    assert.equal(codeOf(decide), null);
    assert.equal(t.store.read(taskFe).status, 'produced');
    assert.equal(t.store.read(issueId).status, 'decided');
    // The same block applies to the API finish: a fresh task, an explicit request, a refusal, then root clears it.
    t.core.task('task:fe-finish', 'member:fe');
    const finishAttempt = t.core.schedule(t.op('admit-finish'), 'task:fe-finish').result;
    const finishRequest = requestCoordination(t, 'member:qa', { taskRef: 'task:fe-finish' });
    assert.equal(codeOf(() => t.core.finish(finishAttempt.attemptId, finishAttempt.fence)), 'COORDINATION_PENDING');
    verdict(t, finishRequest.decisionId, 'approve');
    assert.equal(codeOf(() => t.core.finish(finishAttempt.attemptId, finishAttempt.fence)), null);
    assert.equal(t.store.read('task:fe-finish').status, 'produced');
  } finally { t.close(); }
});

// --- T06 ----------------------------------------------------------------------------------------------------------------

test('T06a: a v1 intent asks root alone and has neither a downstream set nor a window nor votes', () => {
  const t = team('t06a');
  try {
    t.core.task('task:fe', 'member:fe');
    const send = payload => t.core.dispatch('message:' + t.op('intent'), 'member:fe', payload,
      { type: 'message.send', payload });
    const base = { kind: 'intent', summary: 'interface change', taskRef: 'task:fe', contractRevision: 1,
      expectedOutcome: 'root rules', reason: 'the shape of the response has to change', evidenceRefs: ['task:fe'] };
    assert.equal(codeOf(() => send({ ...base, messageId: 'message:' + t.op('x'), to: ['member:be'] })),
      'COORDINATE_VIA_ROOT', 'a downstream set is M2b window semantics');
    assert.equal(codeOf(() => send({ ...base, messageId: 'message:' + t.op('x'), to: 'member:be' })),
      'COORDINATE_VIA_ROOT', 'a member addresses root, not another member');
    assert.equal(codeOf(() => send({ ...base, messageId: 'message:' + t.op('x'), to: 'member:root', windowMs: 1000 })),
      'WRONG_INTENT_PROTOCOL', 'there is no window to open');
    assert.equal(codeOf(() => send({ ...base, messageId: 'message:' + t.op('x'), to: 'member:root', reason: '' })),
      'MISSING_RESPONSIBILITY');
    assert.equal(codeOf(() => send({ ...base, messageId: 'message:' + t.op('x'), to: 'member:root', evidenceRefs: [] })),
      'MISSING_EVIDENCE');
    assert.equal(codeOf(() => send({ ...base, messageId: 'message:' + t.op('x'), to: 'member:root', evidenceRefs: ['task:ghost'] })),
      'MISSING_REFERENCE:task:ghost');

    const request = requestCoordination(t, 'member:fe', { taskRef: 'task:fe' });
    const intent = t.store.read(request.messageId);
    assert.equal(intent.protocol, 'root-decision-v1');
    assert.equal(intent.openedFor, 'member:root');
    assert.equal(intent.decisionRef, request.decisionId);
    assert.deepEqual(intent.recipients, ['member:root']);
    assert.equal(intent.closesAt, null, 'no window exists, so nothing can pass by silence');
    assert.equal(intent.reason, 'the commitment this revision binds has to change');
    assert.deepEqual(intent.evidenceRefs, ['task:fe']);
    const decision = t.store.read(request.decisionId);
    assert.equal(decision.kind, 'coordination');
    assert.deepEqual(decision.options, ['approve', 'reject', 'request-revision']);
    assert.equal(decision.state, 'open');
    assert.deepEqual(decision.binding, { taskRef: 'task:fe', contractRevision: 1, intentRef: request.messageId,
      requestedBy: 'member:fe', requestSeq: 1, interestedMemberIds: ['member:fe', 'member:fe'] });
    assert.equal(decision.openedFor, 'member:root', 'the request is in the owner inbox, not beside it');
    assert(decision.expiresAt > decision.openedAt, 'a decision has a TTL; the intent has no window');
    // Root's mailbox carries it, and the M2b statistics do not count it as a window.
    assert.deepEqual(t.core.pending('member:root').map(row => row.entityId), [request.messageId]);
    assert.equal(intentState(t.core, 'member:fe').sent, 0);
    // The M2b vote surface is not a second adjudication protocol.
    assert.equal(codeOf(() => handleTool(t.core, { actor: 'member:root' }, 'team_message',
      { operationId: t.op('reply'), op: 'reply', messageId: request.messageId, verdict: 'ok' })), 'WRONG_INTENT_PROTOCOL');
    assert.equal(codeOf(() => t.core.replyIntent(request.messageId, 'member:root', 'object', 'no')), 'WRONG_INTENT_PROTOCOL');
    // Nor is it cancelled or rebound: the two ways out are root's verdict and an expiry that keeps the block.
    assert.equal(codeOf(() => cancelMessage(t.core, request.messageId, 'member:fe', 'withdraw')), 'INTENT_NOT_CANCELLABLE');
  } finally { t.close(); }
});

test('T06b: reject, request-revision and approve each have one outcome, and a replay decides nothing twice', () => {
  const t = team('t06b');
  try {
    t.core.task('task:fe', 'member:fe');
    const gate = () => codeOf(() => handleTool(t.core, { actor: 'member:root' }, 'team_read', { view: 'team' })) === null
      ? coordinationBlock(t.store, { taskRef: 'task:fe', contractRevision: 1 })?.code ?? null
      : 'unreachable';
    const rejected = requestCoordination(t, 'member:fe', { taskRef: 'task:fe' });
    verdict(t, rejected.decisionId, 'reject');
    assert.equal(t.store.read(rejected.messageId).status, 'rejected');
    assert.equal(gate(), 'COORDINATION_REJECTED');
    // A new request on the same revision is a new decision; the rejected one still blocks until root answers it.
    const revised = requestCoordination(t, 'member:fe', { taskRef: 'task:fe' });
    assert.equal(gate(), 'COORDINATION_PENDING');
    verdict(t, revised.decisionId, 'request-revision');
    assert.equal(gate(), 'COORDINATION_REVISION_REQUESTED');
    // Approve: the only option that clears a revision. The verdict runs on its own operation id, and replaying that id
    // answers the stored receipt instead of deciding twice or dispatching a second result.
    const third = requestCoordination(t, 'member:fe', { taskRef: 'task:fe' });
    const thirdPayload = { decisionId: third.decisionId, decision: 'approve', reason: 'root cleared it', evidenceRef: null };
    const thirdCommand = { type: 'decision.decide', policy: { authority: 'owner' }, payload: thirdPayload };
    const approveOp = t.op('approve');
    const decided = t.core.dispatch(third.decisionId, 'member:root', thirdPayload, thirdCommand, { operationId: approveOp });
    assert.equal(decided.result.state, 'decided');
    const counts = { effects: t.store.effects().length, audits: t.store.list('audit:').length };
    t.core.dispatch(third.decisionId, 'member:root', thirdPayload, thirdCommand, { operationId: approveOp });
    assert.equal(t.store.effects().length, counts.effects, 'a replayed verdict dispatches nothing');
    assert.equal(t.store.list('audit:').length, counts.audits, 'and writes no second audit row');
    assert.equal(t.store.read(third.messageId).status, 'approved');
    assert.equal(resultEffects(t, third.messageId).length, 1, 'one result effect for one request');
    // Another operation on the same row is a second verdict on a decided row, which is never allowed.
    assert.equal(codeOf(() => verdict(t, third.decisionId, 'approve')), 'DECISION_STALE');
    assert.equal(codeOf(() => verdict(t, rejected.decisionId, 'approve')), 'DECISION_STALE',
      'a decided request is never revived; root opens a new one');
    // An approval of one request never clears another: the older revision request still blocks the revision, and the
    // gate names the newest outstanding answer.
    assert.equal(gate(), 'COORDINATION_REVISION_REQUESTED', 'an approval elsewhere does not overrule a rejection');
  } finally { t.close(); }
});
