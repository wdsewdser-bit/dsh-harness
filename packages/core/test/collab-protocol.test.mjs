// Offline protocol tests for M2b: the intent window (silence is consent) and the visibility facts it freezes.
//
// Every case runs against a real control store with no provider and no host: only the shared reducer, the clock and the
// published tool surface. The normative sentences are docs/host-protocol.md §4.2–§4.5 and invariant 8; the decision
// record is docs/decisions/M2b-collab-protocol.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../index.mjs';
import { handleTool } from '../tools.mjs';
import { snapshot } from '../snapshot.mjs';
import { recordInjection, requestBoundary } from '../provenance.mjs';
import { hash } from '../../contracts/index.mjs';
import { intentRowAudit } from '../commands/intents.mjs';
import { cancelMessage, rebindMessage } from '../mailbox.mjs';
import { collabSettings, intentState } from '../collab.mjs';


import { root, future, INTENT_WINDOW_MS, team, pick, openIntent, carry, observe, reply, ledger } from '../test-support/collab-protocol-fixtures.mjs';

test('the window closes by itself: silence passes, nobody is escalated, and who really saw it is frozen', () => {
  const t = team('silent-pass');
  try {
    const sent = openIntent(t, ['member:be', 'member:qa']).result;
    const messageId = sent.entityId;
    assert.equal(sent.status, 'open');
    assert(sent.closesAt > Date.now(), 'the server opened a real window');
    // Only the backend was in a request before the close; the verifier never was.
    observe(t, 'member:be', messageId);
    assert.equal(t.core.ready('member:qa'), true, 'an unseen intent makes its recipient ready');
    t.core.tick(sent.closesAt + 1);
    const closed = t.store.read(messageId);
    assert.equal(closed.decision, 'passed', 'silence when the window closes is consent');
    assert.equal(closed.status, 'passed');
    assert.equal(closed.closedAt, sent.closesAt, 'the deadline is the closing instant');
    assert.deepEqual(closed.seenAtClose, { 'member:be': true, 'member:qa': false });
    assert.equal(closed.seenSummary, 'seenPartial');
    // §4.2 rule 6: nothing escalates to the operator, and the initiator is told by a durable effect.
    assert.equal(t.store.list('message:').filter(message => message.status === 'escalated').length, 0);
    assert(t.store.effects().some(effect => effect.payload.kind === 'intent-result' &&
      effect.payload.messageId === messageId && effect.payload.decision === 'passed'));
    assert.equal(t.core.pending('member:qa').length, 0, 'a closed window is no longer work to answer');
    const state = intentState(t.core, 'member:fe');
    assert.equal(state.sent, 1); assert.equal(state.passed, 1); assert.equal(state.passedUnseen, 1);
    assert.equal(state.seenPartial, 1); assert.equal(state.seenNone, 0);
  } finally { t.close(); }
});

test('one objection closes the window at once and blocks that contract revision', () => {
  const t = team('object');
  try {
    const sent = openIntent(t, ['member:be', 'member:qa']).result;
    const messageId = sent.entityId;
    reply(t, 'be', messageId, 'ok');
    assert.equal(t.store.read(messageId).decision, null, 'one ok of two leaves the window open');
    const objected = reply(t, 'qa', messageId, 'object', 'the field is done, not completed').result;
    assert.equal(objected.decision, 'objected');
    assert(Number.isFinite(objected.closedAt), 'the objection is the closing instant');
    assert.equal(t.store.read(messageId).votes['member:qa'].reason, 'the field is done, not completed');
    // The gate language is the same one the reducer raises inside the transaction.
    const refused = (() => { try {
      handleTool(t.core, t.fe, 'team_task', { operationId: t.op('produce'), expectedRevision: t.store.read('task:fe').revision,
        op: 'produce', taskRef: 'task:fe', deliveryRef: 'delivery:1:fe' });
    } catch (error) { return error; } })();
    assert.equal(refused?.code, 'INTENT_OBJECTED');
    assert.match(refused.detail, /new team_message kind=intent/);
    // A concluded revision cannot open a second window; only a new revision can.
    const again = (() => { try { openIntent(t, ['member:be']); } catch (error) { return error; } })();
    assert.equal(again?.code, 'INTENT_CONCLUSION_FIXED');
  } finally { t.close(); }
});

test('a reply is idempotent, overridable before the close, and audit-only after it', () => {
  const t = team('reply-idempotent');
  try {
    const messageId = openIntent(t, ['member:be', 'member:qa']).result.entityId;
    const operationId = t.op('reply-once');
    const args = { operationId, op: 'reply', messageId, verdict: 'ok' };
    const first = handleTool(t.core, t.be, 'team_message', args);
    assert.equal(first.result.votes['member:be'].verdict, 'ok');
    const before = ledger(t);
    const replay = handleTool(t.core, t.be, 'team_message', args);
    assert.deepEqual(replay, first, 'the same operation replays its receipt');
    assert.equal(ledger(t), before, 'and writes nothing again');
    // A different intent under the same operation id is a conflict, not a second vote.
    const conflict = (() => { try { handleTool(t.core, t.be, 'team_message', { ...args, verdict: 'object' }); }
      catch (error) { return error; } })();
    assert.equal(conflict?.code, 'ID_CONFLICT');
    // Before the close the same member may change its vote.
    reply(t, 'be', messageId, 'object', 'changed my mind');
    assert.equal(t.store.read(messageId).decision, 'objected', 'the changed vote is the one that decides');
    // After the close nothing moves: the reply is audited only.
    const late = reply(t, 'qa', messageId, 'ok').result;
    assert.equal(late.decision, 'objected', 'the conclusion survives a later reply');
    assert.equal(late.lateReplies.at(-1).recipient, 'member:qa');
    assert.equal(late.votes['member:qa'], undefined, 'a reply after the close is not a vote');
    assert.equal(t.store.read(messageId).decision, 'objected');
  } finally { t.close(); }
});

test('the four visibility classes: at close, late, after close, stale binding', () => {
  const t = team('visibility-classes');
  try {
    const sent = openIntent(t, ['member:be', 'member:qa']).result;
    const messageId = sent.entityId;
    // 1. evidence committed before the close -> counted in seenAtClose.
    observe(t, 'member:be', messageId, { requestId: 'before-close', requestedAt: Date.now() - 10 });
    // The verifier's request carried the intent too, but its evidence lands after the close: the page is built while
    // the message is still in the mailbox, which is what a real request would have carried.
    const carriedQa = carry(t, 'member:qa', messageId, { requestId: 'qa-request' });
    t.core.tick(sent.closesAt + 1);
    assert.equal(t.store.read(messageId).seenAtClose['member:be'], true);
    const frozen = t.store.read(messageId);
    // 2. a request that started before the close but whose evidence lands after it -> late evidence, never retroactive.
    t.core.visible(messageId, { requestId: 'late', manifestHash: carriedQa.hash, sessionSeq: 1,
      requestedAt: frozen.closedAt - 500 }, 'member:qa');
    /** 3. a request that started after the close -> looked at later, a separate count. */
    t.core.visible(messageId, { requestId: 'qa-late-request', manifestHash: carriedQa.hash, sessionSeq: 1,
      requestedAt: frozen.closedAt + 500 }, 'member:qa');
    const after = t.store.read(messageId);
    assert.deepEqual(after.seenAtClose, frozen.seenAtClose, 'seenAtClose is frozen at the close');
    assert.equal(after.seenSummary, 'seenPartial', 'a later look cannot rewrite the summary');
    assert.equal(after.lateEvidence.length, 1);
    assert.equal(after.lateEvidence[0].requestId, 'late');
    assert.equal(after.visibilityAfterClose.length, 1);
    assert.equal(after.visibilityAfterClose[0].requestId, 'qa-late-request');
    assert.equal(after.decision, 'passed', 'no visibility fact moves the conclusion');
    // 4. evidence bound to a member that has since been replaced is refused and counted nowhere (§4.4 class 4).
    //    The member is really replaced here: the intent row and the manifest both still say generation 1, so comparing
    //    those two old rows would accept the evidence -- only the live member row knows the binding is gone.
    // A new revision is what may open a new window (the previous conclusion is terminal).
    t.core.mutate('task:fe', 'root', {}, (tx, row) => tx.put('task:fe', { ...row, contractRevision: 2 }));
    const stale = openIntent(t, ['member:be'], { summary: 'revised interface', contractRevision: 2 }).result;
    const staleId = stale.entityId;
    const candidate = carry(t, 'member:be', staleId, { requestId: 'stale' });
    t.core.mutate('member:be', 'operator', {}, (tx, row) => tx.put('member:be', { ...row,
      generation: (row.generation ?? 1) + 1 }));
    const refused = (() => { try { t.core.visible(staleId, { requestId: 'stale', manifestHash: candidate.hash,
      sessionSeq: 1, requestedAt: Date.now() }, 'member:be'); } catch (error) { return error; } })();
    assert.equal(refused?.code, 'STALE_MESSAGE_BINDING');
    const row = t.store.read(staleId);
    assert.deepEqual(row.visibility, {}, 'a stale binding is neither seen nor looked at later');
    assert.equal(row.lateEvidence.length, 0);
    assert.equal(row.visibilityAfterClose.length, 0);
  } finally { t.close(); }
});

test('accept still needs the responsibility to have been in a request, and an intent is never accepted', () => {
  const t = team('accept-visible');
  try {
    const messageId = t.core.send('member:fe', 'member:be', 'action', 'review the contract',
      { expectedOutcome: 'accept and produce', deadline: future(300000) }).result.entityId;
    const before = ledger(t);
    const refused = (() => { try { handleTool(t.core, t.be, 'team_message', { operationId: t.op('accept'),
      expectedRevision: t.store.read(messageId).revision, op: 'accept', messageId, checkpointRef: 'checkpoint:1' });
    } catch (error) { return error; } })();
    assert.equal(refused?.code, 'NOT_VISIBLE');
    assert.match(refused.detail, /request context/);
    assert.equal(ledger(t), before, 'a refused accept writes nothing');
    assert.equal(t.store.read(messageId).accepted, false);
    // A fabricated manifest hash is not evidence either (invariant 8: no fabrication).
    const forged = (() => { try { t.core.visible(messageId, { requestId: 'x', manifestHash: 'f'.repeat(64), sessionSeq: 1,
      requestedAt: Date.now() }); } catch (error) { return error; } })();
    assert.equal(forged?.code, 'MISSING_SOURCE');
    observe(t, 'member:be', messageId);
    const accepted = handleTool(t.core, t.be, 'team_message', { operationId: t.op('accept'),
      expectedRevision: t.store.read(messageId).revision, op: 'accept', messageId, checkpointRef: 'checkpoint:1' });
    assert.equal(accepted.result.status, 'accepted');
    // An intent is answered by reply, never accepted.
    const intentId = openIntent(t, ['member:be']).result.entityId;
    const notAccept = (() => { try { handleTool(t.core, t.be, 'team_message', { operationId: t.op('accept-intent'),
      expectedRevision: t.store.read(intentId).revision, op: 'accept', messageId: intentId, checkpointRef: 'checkpoint:2' });
    } catch (error) { return error; } })();
    assert.equal(notAccept?.code, 'INTENT_NEEDS_REPLY');
  } finally { t.close(); }
});

test('a non-intent responsibility still escalates at its deadline, and an intent does not', () => {
  const t = team('escalation');
  try {
    const action = t.core.send('member:fe', 'member:be', 'action', 'needs an owner',
      { expectedOutcome: 'accept it', deadline: future(60000) }).result.entityId;
    const intentId = openIntent(t, ['member:qa']).result.entityId;
    const closesAt = t.store.read(intentId).closesAt;
    // Advance past both the intent window and the responsibility deadline, without expiring the attempt leases.
    t.core.tick(Math.max(closesAt + 1, Date.parse(t.store.read(action).deadline) + 1));
    assert.equal(t.store.read(action).status, 'escalated', 'an unaccepted responsibility still escalates');
    assert.equal(t.store.read(action).responsible, 'operator');
    assert.equal(t.store.read(intentId).decision, 'passed', 'the intent passed instead of escalating');
    assert.equal(intentState(t.core, 'member:fe').passedUnseen, 1, 'nobody saw the window that passed');
  } finally { t.close(); }
});

test('the gate is checked in the same transaction as the publish', () => {
  const t = team('gate-transaction');
  try {
    t.core.mutate('delivery:1:fe', 'root', {}, tx => tx.put('delivery:1:fe', { taskId: 'task:fe', owner: 'member:fe' }));
    const produce = () => handleTool(t.core, t.fe, 'team_task', { operationId: t.op('produce'),
      expectedRevision: t.store.read('task:fe').revision, op: 'produce', taskRef: 'task:fe', deliveryRef: 'delivery:1:fe' });
    const before = ledger(t);
    const refused = (() => { try { produce(); } catch (error) { return error; } })();
    assert.equal(refused?.code, 'INTENT_REQUIRED');
    assert.equal(ledger(t), before, 'a refused publish leaves no attempt or task write behind');
    const sent = openIntent(t, ['member:be']).result;
    assert.equal((() => { try { produce(); } catch (error) { return error; } })().code, 'INTENT_WINDOW_OPEN');
    t.core.tick(sent.closesAt + 1);
    const produced = produce();
    assert.equal(produced.result.status, 'produced', 'a passed window publishes');
    // The window belongs to the server: no configuration, no window.
    assert.equal(collabSettings(t.core).intentWindowMs, INTENT_WINDOW_MS);
  } finally { t.close(); }
});
// --- The direct entries, the two replies, and the evidence rules of the review round (M2b §10) ---------------------

test('the direct entries gate the publish, and only a thread is a thread', () => {
  const t = team('direct-entries');
  try {
    // A thread that names a task is a publishing entry. The tool path gates it; so must the class method, or the
    // same decision could be published by calling the API instead (host-protocol §4.2 rule 5: every public entry).
    const opened = handleTool(t.core, t.fe, 'team_thread', { operationId: t.op('thread'), op: 'open',
      owner: 'member:fe', requiredRespondents: [], requiredEvidence: [], question: 'ship this revision?',
      deadline: future(60000), taskRef: 'task:fe' }).result;
    const issueId = opened.entityId;
    const decide = () => t.core.decide(issueId, 'member:fe', 1, 'conclusion:1');
    const code = () => { try { decide(); return null; } catch (error) { return error.code; } };
    assert.equal(code(), 'INTENT_REQUIRED', 'the direct entry is gated exactly like the tool path');
    const sent = openIntent(t, ['member:be']).result;
    assert.equal(code(), 'INTENT_WINDOW_OPEN');
    reply(t, 'be', sent.entityId, 'object', 'the shape breaks the consumer');
    assert.equal(code(), 'INTENT_OBJECTED', 'an objection blocks the revision through either entry');
    // A new revision is the only way out, and once its window passes the decision is allowed.
    t.core.mutate('task:fe', 'root', {}, (tx, row) => tx.put('task:fe', { ...row, contractRevision: 2 }));
    const second = openIntent(t, ['member:be'], { contractRevision: 2, summary: 'revised interface' }).result;
    t.core.tick(second.closesAt + 1);
    decide();
    assert.equal(t.store.read(issueId).status, 'decided', 'a passed window publishes the decision');
    assert.equal(t.store.read(issueId).decisionRevision, 1);
    // A declared task that no longer exists is not "no gate": the decision would publish against a contract nobody
    // can resolve, so it is refused instead of skipping the check.
    const orphan = handleTool(t.core, t.fe, 'team_thread', { operationId: t.op('thread-orphan'), op: 'open',
      owner: 'member:fe', requiredRespondents: [], requiredEvidence: [], question: 'and this one?',
      deadline: future(60000), taskRef: 'task:fe' }).result;
    t.core.mutate(orphan.entityId, 'operator', {}, (tx, row) => tx.put(orphan.entityId, { ...row, taskRef: 'task:ghost' }));
    const orphanCode = (() => { try { t.core.decide(orphan.entityId, 'member:fe', 1, 'conclusion:2'); return null; }
      catch (error) { return error.code; } })();
    assert.match(String(orphanCode), /^UNKNOWN_TASK:task:ghost/, 'a missing task is refused, not silently ungated');
  } finally { t.close(); }
});

test('the intent answer and the thread answer are two methods, and a thread reducer refuses a non-thread', () => {
  const t = team('reply-names');
  try {
    const intentId = openIntent(t, ['member:be']).result.entityId;
    // The class method, not only the tool: the earlier name collision meant this call ran the thread reducer.
    const voted = t.core.replyIntent(intentId, 'member:be', 'ok', 'workable');
    assert.equal(voted.status, 'confirmed');
    assert.equal(t.store.read(intentId).votes['member:be'].verdict, 'ok');
    const wrong = (() => { try { t.core.reply(intentId, 'member:be', 1, 'artifact:1:be'); } catch (error) { return error; } })();
    assert.equal(wrong?.code, 'NOT_A_THREAD', 'a message id is not a thread');
    assert.deepEqual(t.store.read(intentId).replies ?? [], [], 'nothing was appended to the message row');
    assert.equal(t.store.read(intentId).readyToDecide, undefined, 'and no thread readiness was mixed in');
    // The thread API keeps its contract.
    const thread = handleTool(t.core, t.fe, 'team_thread', { operationId: t.op('thread'), op: 'open',
      owner: 'member:fe', requiredRespondents: ['member:be'], requiredEvidence: [], question: 'ok?',
      deadline: future(60000), taskRef: 'task:fe' }).result;
    t.core.reply(thread.entityId, 'member:be', 1, 'artifact:1:be');
    assert.equal(t.store.read(thread.entityId).replies.length, 1);
  } finally { t.close(); }
});

test('a reply at or after the close is audit only, even before the clock has run', () => {
  const t = team('late-reply');
  try {
    const sent = openIntent(t, ['member:be', 'member:qa']).result;
    const id = sent.entityId;
    // The window has elapsed; the clock has not committed the close yet (F17: the deadline decides, not the tick).
    t.core.mutate(id, 'adapter', {}, (tx, row) => tx.put(id, { ...row, closesAt: Date.now() - 1 }));
    reply(t, 'be', id, 'object', 'breaks the consumer');
    const afterObject = t.store.read(id);
    assert.equal(afterObject.decision, 'passed', 'silence inside the window passed it');
    assert.deepEqual(afterObject.votes, {}, 'a vote that arrived after the close is not a vote');
    assert.equal(afterObject.lateReplies.length, 1);
    assert.equal(afterObject.visibilityAfterClose.length, 0);
    reply(t, 'qa', id, 'ok', 'fine');
    const afterOk = t.store.read(id);
    assert.deepEqual(afterOk.votes, {}, 'the second late reply does not touch the table either');
    assert.equal(afterOk.lateReplies.length, 2);
    // An on-time reply is a vote, not an audit entry.
    t.core.mutate('task:fe', 'root', {}, (tx, row) => tx.put('task:fe', { ...row, contractRevision: 2 }));
    const other = openIntent(t, ['member:qa'], { summary: 'another interface', contractRevision: 2 }).result;
    reply(t, 'qa', other.entityId, 'ok');
    assert.equal(t.store.read(other.entityId).votes['member:qa'].verdict, 'ok');
    assert.equal(t.store.read(other.entityId).lateReplies ?? undefined, undefined);
  } finally { t.close(); }
});

test('evidence is binned by when the request started, not by whether the clock has closed', () => {
  const t = team('binning');
  try {
    const sent = openIntent(t, ['member:be']).result;
    const id = sent.entityId;
    // (3) a request that started at the closing instant is already outside the window, although the row still says open
    const atClose = carry(t, 'member:be', id, { requestId: 'at-close' });
    t.core.visible(id, { requestId: 'at-close', manifestHash: atClose.hash, sessionSeq: 1,
      requestedAt: sent.closesAt }, 'member:be');
    const row = t.store.read(id);
    assert.deepEqual(row.visibility, {}, 'a request at the close is not "seen at the close"');
    assert.equal(row.visibilityAfterClose.length, 1, 'it is a look after the window, its own class');
    // (1) one millisecond earlier is inside the window
    const inside = carry(t, 'member:be', id, { requestId: 'inside' });
    t.core.visible(id, { requestId: 'inside', manifestHash: inside.hash, sessionSeq: 2,
      requestedAt: sent.closesAt - 1 }, 'member:be');
    assert(t.store.read(id).visibility['member:be'], 'an in-window request is visible before the close');
    // No request time, no bin: the trusted entry refuses it...
    const missing = (() => { try { t.core.visible(id, { requestId: 'none', manifestHash: inside.hash, sessionSeq: 3 }); }
      catch (error) { return error; } })();
    assert.equal(missing?.code, 'MISSING_REQUEST_EVIDENCE');
    // ...and the reducer keeps such a fact in its own bucket, never as seen and never as a late request.
    t.core.dispatch(id, 'adapter', {}, { type: 'message.visible', payload: { messageId: id, recipient: 'member:be',
      evidence: { requestId: 'unknown-time', manifestHash: inside.hash, sessionSeq: 4 } } });
    assert.equal(t.store.read(id).timeUnknown.length, 1);
    assert.deepEqual(t.store.read(id).visibility, { ...t.store.read(id).visibility });
    assert(t.store.read(id).visibility['member:be'].requestId === 'inside', 'the unknown-time write changed nothing');
    // Only the request boundary writes visibility at all.
    const denied = (() => { try { t.core.dispatch(id, 'member:fe', {}, { type: 'message.visible', payload: {
      messageId: id, recipient: 'member:be', evidence: { requestId: 'r', manifestHash: inside.hash, sessionSeq: 5,
        requestedAt: Date.now() } } }); } catch (error) { return error; } })();
    assert.equal(denied?.code, 'DENIED');
    t.core.tick(sent.closesAt + 1);
    const closed = t.store.read(id);
    assert.equal(closed.seenAtClose['member:be'], true, 'the in-window request is the only source of seenAtClose');
    assert.equal(closed.visibilityAfterClose.length, 1, 'the after-window request stayed in its own bucket');
    assert.equal(closed.lateEvidence.length, 0);
    assert.equal(closed.timeUnknown.length, 1);
  } finally { t.close(); }
});

test('a genuine text with a substituted carrying relation is refused at the injection entry', () => {
  const t = team('injection');
  try {
    const sent = openIntent(t, ['member:be']).result;
    const candidate = snapshot(t.core, 'member:be');
    assert(candidate.manifest.messageIds.includes(sent.entityId));
    const reject = (value, extra) => { try { recordInjection(t.core, value, 'native:forged', ['seq'], extra); return null; }
      catch (error) { return error; } };
    // Text and both hashes untouched; only the binding metadata is replaced.
    const bindingForged = { ...candidate, manifest: { ...candidate.manifest,
      messageBindings: candidate.manifest.messageBindings.map(row => ({ ...row, generation: (row.generation ?? 1) + 1 })) } };
    assert.equal(reject(bindingForged)?.code, 'INVALID_MANIFEST');
    // A message that the text never carried cannot be added to the manifest.
    const idForged = { ...candidate, manifest: { ...candidate.manifest,
      messageIds: [...candidate.manifest.messageIds, 'message:ghost'] } };
    assert.equal(reject(idForged)?.code, 'INVALID_MANIFEST');
    // A caller may not add provenance of its own over the injected candidate.
    assert.equal(reject(candidate, { text: 'other' })?.code, 'INVALID_MANIFEST');
    // The untouched candidate is still accepted, and its binding is what the store holds.
    const manifest = recordInjection(t.core, candidate, 'native:real', ['seq']);
    assert.equal(t.store.read('manifest:' + manifest.hash).messageBindings[0].messageId, sent.entityId);
  } finally { t.close(); }
});

test('a replaced member cannot certify what the live one has seen, at either entry', () => {
  const t = team('replacement');
  try {
    const sent = openIntent(t, ['member:be']).result;
    const candidate = snapshot(t.core, 'member:be');
    const manifest = recordInjection(t.core, candidate, 'native:before', ['seq'], { generation: 1 });
    const before = t.store.read(sent.entityId);
    assert.equal(before.generations['member:be'], 1);
    // The member is really replaced: message row and manifest both still say 1, so comparing those two rows agrees.
    t.core.mutate('member:be', 'operator', {}, (tx, row) => tx.put('member:be', { ...row,
      generation: (row.generation ?? 1) + 1 }));
    const boundary = (() => { try { requestBoundary(t.core, manifest.hash, { generation: 1, requestId: 'after',
      sessionSeq: 2, requestedAt: Date.now() }); } catch (error) { return error; } })();
    assert.equal(boundary?.code, 'STALE_MESSAGE_BINDING', 'the request boundary checks the live binding');
    const direct = (() => { try { t.core.visible(sent.entityId, { requestId: 'after', manifestHash: manifest.hash,
      sessionSeq: 2, requestedAt: Date.now() }, 'member:be'); } catch (error) { return error; } })();
    assert.equal(direct?.code, 'STALE_MESSAGE_BINDING', 'and so does the visibility write');
    const row = t.store.read(sent.entityId);
    assert.deepEqual(row.visibility, {}, 'a replaced member is counted neither as seen nor as looked at later');
    assert.equal(row.lateEvidence.length, 0);
    assert.equal(row.visibilityAfterClose.length, 0);
  } finally { t.close(); }
});

