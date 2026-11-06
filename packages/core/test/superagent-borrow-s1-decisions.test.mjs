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

test('T06c: expiry keeps the block, a requester cannot approve itself, the result keeps its binding, a revision supersedes', () => {
  const t = team('t06c');
  try {
    t.core.task('task:fe', 'member:fe');
    // TTL expiry: the intent becomes expired-unresolved, the revision stays blocked and nothing is approved.
    const expiring = requestCoordination(t, 'member:fe', { taskRef: 'task:fe' });
    const row = t.store.read(expiring.decisionId);
    t.core.dispatch('clock', 'scheduler', { now: row.expiresAt }, { type: 'decision.expire', payload: { now: row.expiresAt } },
      { now: row.expiresAt });
    assert.equal(t.store.read(expiring.decisionId).state, 'expired');
    const expiredIntent = t.store.read(expiring.messageId);
    assert.equal(expiredIntent.status, 'expired-unresolved');
    assert.equal(expiredIntent.coordination.state, 'expired-unresolved');
    assert.equal(coordinationBlock(t.store, { taskRef: 'task:fe', contractRevision: 1 }).code, 'COORDINATION_PENDING',
      'an expiry is not an approval');
    assert.equal(resultEffects(t, expiring.messageId).at(-1).payload.decision, 'expired-unresolved');
    assert.equal(codeOf(() => verdict(t, expiring.decisionId, 'approve')), 'DECISION_STALE',
      'root cannot revive the expired row; a new request names it');
    const reAsked = requestCoordination(t, 'member:fe', { taskRef: 'task:fe', previousDecisionId: expiring.decisionId });
    assert.equal(t.store.read(reAsked.decisionId).binding.previousDecisionId, expiring.decisionId,
      'the new request links the row it re-asks, and the old one stays expired');
    assert.equal(t.store.read(expiring.decisionId).state, 'expired');

    // A principal that is the requesting party cannot approve its own request; the operator channel can.
    t.core.task('task:be-root', 'member:be');
    const selfRequest = requestCoordination(t, 'member:root', { taskRef: 'task:be-root' });
    assert.equal(codeOf(() => verdict(t, selfRequest.decisionId, 'approve')), 'SELF_JUDGE_DENIED');
    verdict(t, selfRequest.decisionId, 'approve', { actor: 'operator', entry: 'operator' });
    assert.equal(t.store.read(selfRequest.messageId).status, 'approved');

    // The result carries the binding frozen when the request opened, execution identity included.
    t.core.task('task:be-e', 'member:be');
    const attempt = t.core.schedule(t.op('admit-be'), 'task:be-e').result;
    t.core.mutate(attempt.attemptId, 'root', {}, (tx, current) => {
      tx.put(attempt.attemptId, { ...current, status: 'running' });
      return tx.put('execution-current:' + attempt.attemptId, { E: { executionEpoch: 'E-old' } });
    });
    const withE = requestCoordination(t, 'member:be', { taskRef: 'task:be-e' });
    assert.equal(withE.intent.initiator.kind, 'execution');
    assert.deepEqual(withE.intent.initiator.E, { executionEpoch: 'E-old' });
    verdict(t, withE.decisionId, 'approve');
    assert.deepEqual(resultEffects(t, withE.messageId)[0].payload.initiator, withE.intent.initiator,
      'the result reaches the execution that asked, not whichever one runs later');

    // A new contract revision supersedes the older open request, and a fresh revision inherits no approval.
    t.core.task('task:fe-rev', 'member:fe');
    const onRev1 = requestCoordination(t, 'member:fe', { taskRef: 'task:fe-rev', contractRevision: 1 });
    t.core.mutate('task:fe-rev', 'root', {}, (tx, current) => tx.put('task:fe-rev', { ...current, contractRevision: 2 }));
    const onRev2 = requestCoordination(t, 'member:fe', { taskRef: 'task:fe-rev', contractRevision: 2 });
    assert.equal(t.store.read(onRev1.decisionId).state, 'superseded', 'the older revision is history');
    assert.equal(coordinationBlock(t.store, { taskRef: 'task:fe-rev', contractRevision: 1 }), null,
      'and a superseded request grants nothing either');
    assert.equal(coordinationBlock(t.store, { taskRef: 'task:fe-rev', contractRevision: 2 }).code, 'COORDINATION_PENDING');
    verdict(t, onRev2.decisionId, 'approve');
    t.core.mutate('task:fe-rev', 'root', {}, (tx, current) => tx.put('task:fe-rev', { ...current, contractRevision: 3 }));
    assert.equal(coordinationBlock(t.store, { taskRef: 'task:fe-rev', contractRevision: 3 }), null, 'a new revision starts unanswered');
    requestCoordination(t, 'member:fe', { taskRef: 'task:fe-rev', contractRevision: 3 });
    assert.equal(coordinationBlock(t.store, { taskRef: 'task:fe-rev', contractRevision: 3 }).code, 'COORDINATION_PENDING',
      'the approval of revision 2 is not inherited by revision 3');
  } finally { t.close(); }
});

test('§3.3: the snapshot tells a v1 member what it owes, and it is not an intent', () => {
  const t = team('t06d');
  try {
    t.core.task('task:fe', 'member:fe');
    const clear = implementGateSummary(t.core, 'member:fe');
    assert.equal(clear.open, true);
    assert.equal(clear.state, 'clear');
    assert.equal(clear.passedUnseen, undefined, 'v1 reports no M2b statistic');
    assert.match(clear.nextAction, /needs no intent/);
    const request = requestCoordination(t, 'member:fe', { taskRef: 'task:fe' });
    const blocked = implementGateSummary(t.core, 'member:fe');
    assert.equal(blocked.open, false);
    assert.equal(blocked.state, 'open');
    assert.equal(blocked.coordination, 1);
    assert.match(blocked.nextAction, new RegExp(request.decisionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const candidate = snapshot(t.core, 'member:fe');
    assert.equal(candidate.payload.collab.gate.open, false, 'the member reads the block in the same message as the task');
  } finally { t.close(); }
});

// --- T07 ----------------------------------------------------------------------------------------------------------------

test('T07: notices never route through root, execution requests do, and a ruling starts nothing', () => {
  const t = team('t07');
  try {
    t.core.task('task:fe', 'member:fe');
    const decisionsBefore = t.store.list('decision:').length;
    t.core.send('member:fe', 'member:be', 'info', 'the interface is stable',
      { expectedOutcome: 'none', deadline: future(60000) });
    assert.equal(t.store.list('decision:').length, decisionsBefore, 'a directed notice is not a coordination request');
    assert.equal(codeOf(() => t.core.send('member:fe', 'member:be', 'action', 'change your contract',
      { expectedOutcome: 'change it', deadline: future(60000) })), 'COORDINATE_VIA_ROOT');
    const toRoot = t.core.send('member:fe', 'member:root', 'action', 'please rule on this',
      { expectedOutcome: 'a ruling', deadline: future(60000) });
    assert.equal(toRoot.status, 'confirmed', 'root stays the coordination channel');
    assert.equal(t.store.read(toRoot.result.entityId).kind, 'action');

    const request = requestCoordination(t, 'member:fe', { taskRef: 'task:fe' });
    const before = { attempts: t.store.list('attempt:').length, effects: t.store.effects().length };
    verdict(t, request.decisionId, 'approve');
    assert.equal(t.store.list('attempt:').length, before.attempts, 'an approval grants no lease and opens no turn');
    assert.equal(t.store.effects().filter(effect => ['start', 'dispatch'].includes(effect.payload.kind)).length, 0,
      'root never executes: no shell, no tool, no started attempt');
    assert.deepEqual(t.store.effects().slice(before.effects).map(effect => effect.payload.kind).sort(),
      ['intent-result', 'message'], 'one result to the initiator and the operator notice');
    assert.equal(t.store.read('task:fe').status, 'ready', 'the verdict changed the decision, not the work');
  } finally { t.close(); }
});

// --- T08 ----------------------------------------------------------------------------------------------------------------

test('T08: a full backlog refuses without a half event, reserved events stay, and a restart keeps pending deliveries', () => {
  const t = team('t08', { threadEventLimit: 2 });
  try {
    const thread = openResource(t, 'member:fe', { kind: 'branch', repositoryKey: 'repo:acme/app', key: 'refs/heads/release' });
    const ref = thread.entityId;
    const host = n => publishWith(t, 'adapter', { issueId: ref, summary: 'host fact ' + n, operationId: t.op('host-' + n),
      source: { kind: 'host-evidence', ref: 'delivery:' + n }, hostEvidence: true });
    host(1); host(2);
    const before = { seq: t.store.read(ref).eventSeq, events: events(t, ref).length };
    assert.equal(codeOf(() => host(3)), 'THREAD_BACKLOG_FULL');
    assert.equal(t.store.read(ref).eventSeq, before.seq, 'a refused publish burns no sequence');
    assert.equal(events(t, ref).length, before.events, 'and writes no half event');
    assert.deepEqual(threadRetention(t.store, ref).collectable, [1, 2], 'with no audience the history is collectable');

    // A pending delivery reserves its event: it is an input somebody has not received yet.
    subscribe(t, 'member:be', ref);
    subscribe(t, 'member:be', ref, { replayFrom: 1 });
    const plan = threadRetention(t.store, ref);
    assert.deepEqual(plan.protected, [1, 2]);
    assert.match(plan.protectedReasons[1].join(' '), /pending delivery/);
    const retain = (threadRef, throughSeq) => t.core.dispatch('thread-op:' + t.op('retain'), 'member:root',
      { issueId: threadRef, throughSeq }, { type: 'thread.retain', payload: { issueId: threadRef, throughSeq } });
    assert.equal(codeOf(() => retain(ref, 1)), 'THREAD_RETENTION_BLOCKED');

    // A decision that cites an event reserves it as well, and the watermark below it is what rejects a replay.
    const second = openResource(t, 'member:fe', { kind: 'file-area', repositoryKey: 'repo:acme/app', key: 'src/team' });
    const citedRef = second.entityId;
    publishWith(t, 'adapter', { issueId: citedRef, summary: 'host fact 1', operationId: t.op('host-a'),
      source: { kind: 'host-evidence', ref: 'delivery:a' }, hostEvidence: true });
    publishWith(t, 'adapter', { issueId: citedRef, summary: 'host fact 2', operationId: t.op('host-b'),
      source: { kind: 'host-evidence', ref: 'delivery:b' }, hostEvidence: true });
    const cited = events(t, citedRef)[1];
    t.core.task('task:fe', 'member:fe');
    requestCoordination(t, 'member:fe', { taskRef: 'task:fe', evidenceRef: cited.entityId });
    assert.deepEqual(threadRetention(t.store, citedRef).protected, [2]);
    assert.equal(codeOf(() => retain(citedRef, 2)), 'THREAD_RETENTION_BLOCKED');
    assert.equal(retain(citedRef, 1).result.retainedFrom, 2, 'the un-reserved prefix is collected');
    assert.equal(codeOf(() => subscribe(t, 'member:be', citedRef, { replayFrom: 1 })), 'THREAD_REPLAY_UNAVAILABLE');
    assert.equal(codeOf(() => subscribe(t, 'member:be', citedRef, { replayFrom: 2 })), null);

    // Restart: the deliveries and their wakes are durable facts, not an in-memory audience.
    const pendingBefore = deliveries(t, ref).filter(delivery => delivery.state === 'pending').length;
    const wakesBefore = t.store.effects().filter(effect => effect.payload.kind === 'wake' && effect.payload.threadRef === ref).length;
    assert.equal(pendingBefore, 2);
    t.core.store.close();
    const reopened = new ControlStore(t.dir);
    try {
      assert.equal(reopened.list('thread-delivery:' + ref + ':').filter(delivery => delivery.state === 'pending').length,
        pendingBefore, 'a restart resumes the same durable deliveries');
      assert.equal(reopened.effects().filter(effect => effect.payload.kind === 'wake' && effect.payload.threadRef === ref).length,
        wakesBefore, 'and the same wake effects, so nothing is replayed into a second audience');
      assert.equal(reopened.read(ref).eventSeq, 2);
    } finally { reopened.close(); }
  } finally { t.close(); }
});
// --- §3.2: the translator and the read side ---------------------------------------------------------------------------

test('§3.2: the team_thread resource branches translate to the thread-events reducers, and the read side shows them', () => {
  const translate = args => toolCommand({ role: 'worker' }, { attemptId: null, fence: null }, 'team_thread', args, {}).command;
  const resource = { kind: 'branch', repositoryKey: 'repo:acme/app', key: 'refs/heads/main' };
  const open = translate({ operationId: 'v1:operation:translate-0001', op: 'open-resource', resource,
    descriptionRef: 'artifact:desc:1' });
  assert.equal(open.type, 'thread.open-resource');
  assert.equal(open.payload.issueId, 'thread:v1:operation:translate-0001');
  assert.equal(translate({ operationId: 'v1:operation:translate-0002', op: 'subscribe', issueId: 'thread:t' }).type,
    'thread.subscribe');
  assert.equal(translate({ operationId: 'v1:operation:translate-0003', op: 'unsubscribe', issueId: 'thread:t',
    reason: 'handing it over' }).type, 'thread.unsubscribe');
  const published = translate({ operationId: 'v1:operation:translate-0004', op: 'publish', issueId: 'thread:t',
    eventType: 'conflict-observed', summary: 'the schema clashes', bodyRef: 'artifact:1:fe' });
  assert.equal(published.type, 'thread.publish');
  assert.equal(published.payload.operationId, 'v1:operation:translate-0004');
  assert.equal(translate({ operationId: 'v1:operation:translate-0005', op: 'close-resource', issueId: 'thread:t',
    reason: 'merged' }).type, 'thread.close-resource');
  // The v1 message send carries the ruling fields the legacy window ignores.
  const send = toolCommand({ role: 'worker' }, {}, 'team_message', { operationId: 'v1:operation:translate-0006', op: 'send',
    to: 'member:root', kind: 'intent', summary: 'shape change', taskRef: 'task:fe', contractRevision: 1,
    expectedOutcome: 'a ruling', reason: 'the caller cannot change it alone', evidenceRefs: ['task:fe'] }, {}).command;
  assert.equal(send.type, 'message.send');
  assert.equal(send.payload.reason, 'the caller cannot change it alone');
  assert.deepEqual(send.payload.evidenceRefs, ['task:fe']);
});

test('review: direct send, stale task adjudication, interested root and linked TTL renewal', () => {
  const t = team('review-decisions');
  try {
    t.core.task('task:fe', 'member:fe');
    const direct = t.core.send('member:fe', 'member:root', 'intent', 'rule please', {
      taskRef: 'task:fe', contractRevision: 1, expectedOutcome: 'a ruling', reason: 'conflict', evidenceRefs: ['task:fe'] });
    assert.equal(direct.result.protocol, ROOT_DECISION_SEMANTICS);
    const d = t.store.read(direct.result.decisionRef);
    t.core.dispatch('clock', 'scheduler', {}, { type: 'decision.expire', payload: { now: d.expiresAt } }, { now: d.expiresAt });
    assert.equal(codeOf(() => requestCoordination(t, 'member:fe', { taskRef: 'task:fe' })), 'DECISION_STALE',
      'an expired question cannot be silently re-asked without its historical link');
    const renewal = requestCoordination(t, 'member:fe', { taskRef: 'task:fe', previousDecisionId: d.entityId });
    verdict(t, renewal.decisionId, 'approve');
    assert.equal(t.store.read(d.entityId).state, 'expired', 'renewal never revives history');
    assert.equal(coordinationBlock(t.store, { taskRef: 'task:fe', contractRevision: 1 }), null,
      'an explicit linked approval actually resolves the expired question');
    t.core.task('task:stale', 'member:be');
    const stale = requestCoordination(t, 'member:fe', { taskRef: 'task:stale' });
    t.core.mutate('task:stale', 'root', {}, (tx, row) => tx.put(row.entityId, { ...row, contractRevision: 2 }));
    assert.equal(codeOf(() => verdict(t, stale.decisionId, 'approve')), 'DECISION_STALE');
    t.core.task('task:root-interest', 'member:root');
    const interest = requestCoordination(t, 'member:be', { taskRef: 'task:root-interest' });
    assert.equal(codeOf(() => verdict(t, interest.decisionId, 'approve')), 'SELF_JUDGE_DENIED');
    verdict(t, interest.decisionId, 'approve', { actor: 'operator', entry: 'operator' });
  } finally { t.close(); }
});

test('review: stale publishers and replaced epochs cannot keep a pending audience alive', () => {
  const t = team('review-epochs');
  try {
    const ref = openResource(t, 'member:fe', {kind:'branch',repositoryKey:REPOSITORIES[0],key:'refs/heads/epochs'}).entityId;
    subscribe(t, 'member:fe', ref); subscribe(t, 'member:be', ref);
    publish(t, 'member:fe', ref, 'first');
    subscribe(t, 'member:be', ref, {replayFrom:1});
    assert.equal(forMember(t, ref, 'member:be').filter(d => d.subscriptionEpoch === 1 && d.state === 'pending').length, 0);
    t.core.mutate('member:fe', 'root', {}, (tx, row) => tx.put(row.entityId, {...row, generation:2}));
    assert.equal(codeOf(() => publish(t, 'member:fe', ref, 'stale generation')), 'NOT_SUBSCRIBED');
    subscribe(t, 'member:fe', ref);
    t.core.mutate('member:be', 'root', {}, (tx, row) => tx.put(row.entityId, {...row, desired:'retired'}));
    const next = publish(t, 'member:fe', ref, 'after retirement');
    assert.equal(next.result.delivered.length, 1, 'retired recipients receive no new input');
  } finally { t.close(); }
});

test('review: retention bounds and all decision evidence, including the fifth reference', () => {
  const t = team('review-retention');
  try {
    const ref = openResource(t, 'member:fe', {kind:'branch',repositoryKey:REPOSITORIES[0],key:'refs/heads/retain'}).entityId;
    subscribe(t, 'member:fe', ref);
    const retain = n => t.core.dispatch('retain:' + t.op('retain'), 'member:root', {},
      {type:'thread.retain',payload:{issueId:ref,throughSeq:n}});
    assert.equal(codeOf(() => retain(50)), 'INVALID_RESOURCE', 'cannot discard future events');
    const ev = publish(t, 'member:fe', ref, 'evidence').result.entityId;
    unsubscribe(t, 'member:fe', ref, {reason:'done'});
    t.core.task('task:fe', 'member:fe');
    const messageId = 'message:' + t.op('five-refs');
    const payload = {messageId,to:'member:root',kind:'intent',summary:'question',expectedOutcome:'ruling',reason:'conflict',
      taskRef:'task:fe',contractRevision:1,evidenceRefs:['task:fe','member:fe','member:root',ref,ev]};
    t.core.dispatch(messageId, 'member:fe', payload, {type:'message.send',payload});
    assert.deepEqual(threadRetention(t.store, ref).protected, [1]);
    assert.equal(codeOf(() => retain(1)), 'THREAD_RETENTION_BLOCKED');
    const other = openResource(t, 'member:fe', {kind:'branch',repositoryKey:REPOSITORIES[0],key:'refs/heads/free'}).entityId;
    subscribe(t, 'member:fe', other); publish(t, 'member:fe', other, 'old'); unsubscribe(t, 'member:fe', other, {reason:'done'});
    t.core.dispatch('retain:' + t.op('free'), 'member:root', {}, {type:'thread.retain',payload:{issueId:other,throughSeq:1}});
    assert.equal(codeOf(() => readThreadEvents(t.store, {threadRef:other,afterSeq:0})), 'THREAD_REPLAY_UNAVAILABLE');
    assert.deepEqual(readThreadEvents(t.store, {threadRef:other,afterSeq:1}).events, []);
  } finally { t.close(); }
});

test('review: fanout/outbox rollback and off cannot dispatch resource commands', () => {
  const t = team('review-atomic');
  try {
    const ref = openResource(t, 'member:fe', {kind:'branch',repositoryKey:REPOSITORIES[0],key:'refs/heads/atomic'}).entityId;
    subscribe(t, 'member:fe', ref); subscribe(t, 'member:be', ref);
    const commit = t.store.commit.bind(t.store);
    t.store.commit = (cmd, reduce) => commit(cmd, (tx, row) => reduce(new Proxy(tx, {get(target, key) {
      if (key === 'outbox') return () => { throw Error('FAULT_OUTBOX'); };
      return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    }}), row));
    assert.throws(() => publish(t, 'member:fe', ref, 'rollback'), /FAULT_OUTBOX/);
    t.store.commit = commit;
    assert.equal(t.store.read(ref).eventSeq, 0); assert.equal(events(t, ref).length, 0); assert.equal(deliveries(t, ref).length, 0);
    assert.equal(publish(t, 'member:fe', ref, 'retry').result.delivered.length, 2);
  } finally { t.close(); }
  const off = team('review-off', {superagentBorrow:'off'});
  try { assert.equal(codeOf(() => openResource(off, 'member:fe', {kind:'branch',repositoryKey:REPOSITORIES[0],key:'refs/heads/off'})),
    'PROTOCOL_UNSUPPORTED'); } finally { off.close(); }
});

test('review: a real no-intent path publishes and raw gate=false cannot bypass coordination', () => {
  const t = team('review-no-intent');
  try {
    t.core.task('task:fe', 'member:fe'); t.core.task('task:qa', 'member:qa');
    const fe = t.core.schedule(t.op('admit-fe'), 'task:fe').result;
    const qa = t.core.schedule(t.op('admit-qa'), 'task:qa').result;
    t.core.mutate('delivery:test', 'root', {}, tx => tx.put('delivery:test', {owner:'member:fe',contractRevision:1,acl:['member:qa']}));
    const thread = t.core.thread('member:fe', [], 'ship?', future(60000), 'member:root').result;
    t.core.mutate(thread.entityId, 'root', {}, (tx,row) => tx.put(row.entityId,{...row,taskRef:'task:fe'}));
    const binding = {actor:'member:qa',attemptId:qa.attemptId,fence:qa.fence};
    handleTool(t.core,binding,'team_verify',{operationId:t.op('verify'),deliveryRef:'delivery:test',contractRevision:1,
      verdict:'pass',evidenceRefs:['delivery:test'],reason:'independent evidence'});
    t.core.decide(thread.entityId, 'member:fe', 1, 'artifact:conclusion');
    handleTool(t.core,{actor:'member:fe',attemptId:fe.attemptId,fence:fe.fence},'team_task',{
      operationId:t.op('produce'),op:'produce',expectedRevision:t.store.read('task:fe').revision,taskRef:'task:fe',deliveryRef:'delivery:test'});
    assert.equal(t.store.read('task:fe').status,'produced');
    t.core.finish(qa.attemptId,qa.fence);
    assert.equal(t.store.list('message:').filter(row=>row.kind==='intent').length,0,'NO approval was needed, not merely an approved intent');
    assert.equal(t.store.list('verification-evidence:').length,1);
    t.core.task('task:blocked','member:be');
    const be = t.core.schedule(t.op('admit-be'),'task:blocked').result;
    requestCoordination(t,'member:fe',{taskRef:'task:blocked'});
    const p={attemptId:be.attemptId,fence:be.fence,status:'produced',gate:false};
    assert.equal(codeOf(()=>t.core.dispatch(be.attemptId,'member:be',p,{type:'attempt.finish',payload:p})),'COORDINATION_PENDING');
    assert.equal(t.store.read('task:blocked').status,'executing');
  } finally { t.close(); }
});

test('review: publication retry binds the actor and the complete source, and survives resource closure', () => {
  const t = team('review-retry');
  try {
    const ref=openResource(t,'member:fe',{kind:'branch',repositoryKey:REPOSITORIES[0],key:'refs/heads/retry'}).entityId;
    subscribe(t,'member:fe',ref); subscribe(t,'member:be',ref);
    const op=t.op('report'); const report={issueId:ref,summary:'report',operationId:op};
    publishWith(t,'member:fe',report);
    assert.equal(codeOf(()=>publishWith(t,'member:be',report)),'ID_CONFLICT');
    assert.equal(codeOf(()=>publishWith(t,'member:fe',{...report,source:{kind:'host-evidence',ref:'delivery:fake'}})),'DENIED');
    t.core.dispatch(ref,'member:fe',{}, {type:'thread.close-resource',payload:{issueId:ref,reason:'done'}});
    assert.equal(publishWith(t,'member:fe',report).result.seq,1);
    assert.equal(events(t,ref).length,1); assert.equal(deliveries(t,ref).length,2);
  } finally { t.close(); }
});

test('review: question mutation is stale but visibility-only revision changes are not', () => {
  const t=team('review-subject');
  try {
    t.core.task('task:fe','member:fe');
    const changed=requestCoordination(t,'member:fe',{taskRef:'task:fe'});
    t.core.mutate(changed.messageId,'root',{},(tx,row)=>tx.put(row.entityId,{...row,summary:'a different question'}));
    assert.equal(codeOf(()=>verdict(t,changed.decisionId,'approve')),'DECISION_STALE');
    const visible=requestCoordination(t,'member:fe',{taskRef:'task:fe'});
    t.core.mutate(visible.messageId,'root',{},(tx,row)=>tx.put(row.entityId,{...row,visible:true,visibility:{root:{request:'read'}}}));
    assert.equal(codeOf(()=>verdict(t,visible.decisionId,'approve')),null);
  } finally { t.close(); }
});

test('review: file-area aliases and junction escapes are rejected against the registered physical root', () => {
  const t=team('review-paths');
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'borrow-outside-'));
  const link=path.join(t.dir,'escape');
  try {
    fs.symlinkSync(outside,link,'junction');
    const base={kind:'file-area',repositoryKey:REPOSITORIES[0]};
    for(const key of ['src/secret:stream','src/alias.','src/alias ','src/NUL','src/'+String.fromCharCode(0),
      path.relative(root,link).replaceAll('\\','/')+'/outside']) {
      assert.equal(codeOf(()=>openResource(t,'member:fe',{...base,key})),'INVALID_RESOURCE',JSON.stringify(key));
    }
    assert.equal(codeOf(()=>openResource(t,'member:fe',{...base,key:'src'}, {repositories:['forged']})),null,
      'payload fields cannot choose the trusted repository registry');
  } finally { fs.rmSync(link,{force:true,recursive:true}); fs.rmSync(outside,{force:true,recursive:true}); t.close(); }
});

