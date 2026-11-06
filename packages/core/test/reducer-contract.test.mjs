// Offline unit tests for the shared reducer's entry contracts (M2a review fixes); pure, node --test.
//
// Every case here pins a contract that HEAD 8e7439b had and that the merge must keep: which entry may do what
// (docs/decisions/M2a-shared-reducer.md "审查修订"), what a refusal writes (nothing), and what a receipt and the
// journal look like. The rules are shared; the policies are chosen by the trusted entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../index.mjs';
import { handleTool } from '../tools.mjs';
import { toolCommand } from '../tool-reducer.mjs';
import { snapshot } from '../snapshot.mjs';
import { recordInjection } from '../provenance.mjs';
import { cancelMessage, rebindMessage, submitMailbox } from '../mailbox.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../runs');
const future = () => new Date(Date.now() + 120000).toISOString();

/** One durable team with a root and two workers, in a throwaway store the test removes afterwards. */
function team(label, configuration = {}) {
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'reducer-contract-' + label + '-'));
  const store = new ControlStore(dir);
  const core = new TeamCore(store, {}, { enabled: true, ...configuration });
  core.member('member:root', 'root');
  core.member('member:a', 'worker', 'a');
  core.member('member:b', 'worker', 'b');
  return { dir, store, core, close() { core.store.close?.(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/**
 * Everything a refusal is not allowed to leave behind: rows, journal events, queued effects, and the two bookkeeping
 * tables a command writes outside the entity store — the scheduler cursor and the operations (replay) rows.
 */
const ledger = t => JSON.stringify({ rows: t.store.list(), events: t.store.events(), effects: t.store.effects(),
  cursors: ['scheduler', 'dispatch'].map(id => [id, t.store.cursor(id)]) });

/**
 * Record that a message was really in one of this member's requests: the evidence names the injected manifest, which
 * is the only source a visible fact may come from (invariant 8). Follow the current offsets: observing a message can
 * reorder the unread prefix before the next request.
 */
const observe = (t, memberId, messageId, page) => {
  let candidate = snapshot(t.core, memberId);
  while (!candidate.manifest.messageIds.includes(messageId) && candidate.payload.responsibilityPage.nextPage !== null) {
    candidate = snapshot(t.core, memberId, null, candidate.payload.responsibilityPage.nextPage);
  }
  assert(candidate.manifest.messageIds.includes(messageId), 'the observed page must carry the message');
  recordInjection(t.core, candidate, 'native:observe-' + page, ['test-seq']);
  return t.core.visible(messageId, { requestId: 'request-' + page, manifestHash: candidate.manifest.hash,
    sessionSeq: page + 1, requestedAt: Date.now() });
};

/** One admitted attempt on task:a, plus the task row it owns. */
const admitted = t => {
  t.core.task('task:a', 'member:a');
  return t.core.schedule('event:a', 'task:a').result;
};

test('a resolve cannot resurrect a cancelled responsibility, and the refusal writes nothing', () => {
  const t = team('resolve-cancelled');
  try {
    const binding = admitted(t);
    const first = t.core.send('member:b', 'member:a', 'action', 'fix the parser',
      { expectedOutcome: 'green suite', deadline: future() }).result.entityId;
    const second = t.core.send('member:b', 'member:a', 'action', 'fix the lexer',
      { expectedOutcome: 'green suite', deadline: future() }).result.entityId;
    // Accepting needs the responsibility to have been in a real request first (§4.2 rule 9).
    observe(t, 'member:a', first, 0);
    observe(t, 'member:a', second, 1);
    t.core.accept(first, binding.attemptId, binding.fence, 'checkpoint:ack-1');
    t.core.accept(second, binding.attemptId, binding.fence, 'checkpoint:ack-2');
    t.core.mutate('artifact:result', 'operator', {}, tx => tx.put('artifact:result', { value: 1, owner: 'member:a' }));
    t.core.mutate('artifact:other', 'operator', {}, tx => tx.put('artifact:other', { value: 2, owner: 'member:a' }));
    const operationOf = messageId => 'v1:operation:review-resolve-' + messageId.slice(-6);
    const resolve = (messageId, resultRef = 'artifact:result') => handleTool(t.core,
      { actor: 'member:a', attemptId: binding.attemptId, fence: binding.fence },
      'team_message', { operationId: operationOf(messageId),
        expectedRevision: t.store.read(messageId).revision, op: 'resolve', messageId, resultRef });
    // Positive control: an accepted, open responsibility still resolves through the same shared reducer.
    resolve(second);
    assert.equal(t.store.read(second).status, 'resolved');
    // accept -> cancel: the row keeps accepted=true and its attemptId, which is exactly why the status guard matters.
    submitMailbox(t.core, 'operator', { name: 'mailbox.cancelMessage', target: first,
      args: { reason: 'operator withdrew the assignment' }, expectedRevision: t.store.read(first).revision,
      operationId: 'v1:operation:review-cancel-0001' });
    assert.equal(t.store.read(first).status, 'cancelled');
    assert.equal(t.store.read(first).accepted, true);
    const before = ledger(t);
    assert.throws(() => resolve(first), /LATE_MESSAGE/);
    assert.equal(ledger(t), before, 'a refused resolve must leave no row, event, effect, cursor or operation');
    assert.equal(t.store.read(first).status, 'cancelled');
    // No receipt either: the same operation id with different arguments must reach the business rule again. A stored
    // operations row would answer ID_CONFLICT instead of the domain refusal.
    assert.throws(() => resolve(first, 'artifact:other'), /LATE_MESSAGE/);
    assert.equal(ledger(t), before);
  } finally { t.close(); }
});

test('the audited UI rebind keeps evidence and unknown admission; the helper keeps its label contract', () => {
  const t = team('rebind-policy');
  try {
    t.core.mutate('artifact:evidence', 'operator', {}, tx => tx.put('artifact:evidence', { status: 'evidence', owner: 'member:a' }));
    const rebind = (actor, messageId, recipient, evidenceRef, operationId) => submitMailbox(t.core, actor,
      { name: 'mailbox.rebind', target: messageId, args: { recipient, evidenceRef },
        expectedRevision: t.store.read(messageId).revision, operationId });
    // 1. an unknown row is quarantined: only the operator adjudication path may move it, not a rebind.
    const unknown = t.core.send('member:b', 'member:a', 'info', 'unroutable').result.entityId;
    t.core.mutate(unknown, 'operator', {}, (tx, row) => tx.put(unknown, { ...row, status: 'unknown' }));
    let before = ledger(t);
    assert.throws(() => rebind('root', unknown, 'member:b', 'artifact:evidence', 'v1:operation:review-rebind-unknown-01'),
      /INVALID_REBIND/);
    assert.equal(ledger(t), before, 'root must not be able to reset an unknown row by rebinding it');
    assert.equal(t.store.read(unknown).status, 'unknown');
    // 2. the UI needs material evidence, not an external label.
    const labelled = t.core.send('member:b', 'member:a', 'info', 'second').result.entityId;
    before = ledger(t);
    assert.throws(() => rebind('root', labelled, 'member:b', 'artifact:missing', 'v1:operation:review-rebind-missing-01'),
      /INVALID_REBIND/);
    assert.equal(ledger(t), before, 'a UI rebind naming a row that does not exist writes nothing');
    // 3. positive control: a stored row and a real evidence row still rebind.
    const moved = rebind('root', labelled, 'member:b', 'artifact:evidence', 'v1:operation:review-rebind-ok-0001');
    assert.equal(moved.entityId, labelled);
    assert.equal(moved.status, 'confirmed');
    assert.equal(t.store.read(labelled).recipient, 'member:b');
    assert.equal(t.store.read(labelled).bindingGeneration, 1);
    // 4. the helper keeps its own contract: an evidence tag does not have to be a row.
    const tagged = t.core.send('member:b', 'member:a', 'info', 'third').result.entityId;
    rebindMessage(t.core, tagged, 'member:b', 'renew binding');
    assert.equal(t.store.read(tagged).recipient, 'member:b');
    assert.equal(t.store.read(tagged).history.at(-1).evidenceRef, 'renew binding');
    // 5. the member: prefix is a UI rule, not a rule of the write: HEAD's helper rebinds to any existing recipient row.
    t.core.mutate('team-ops', 'operator', {}, tx => tx.put('team-ops', { role: 'worker', generation: 7 }));
    const toOps = t.core.send('member:b', 'member:a', 'info', 'fourth').result.entityId;
    rebindMessage(t.core, toOps, 'team-ops', 'shared label');
    assert.equal(t.store.read(toOps).recipient, 'team-ops');
    assert.equal(t.store.read(toOps).generation, 7);
    // 6. HEAD's helper answered a missing message with INVALID_REBIND.
    assert.throws(() => rebindMessage(t.core, 'message:absent', 'member:b', 'label'), /INVALID_REBIND/);
  } finally { t.close(); }
});

test('core.finish keeps its { status } receipt and its attempt -> task -> waits order', () => {
  const t = team('finish-core');
  try {
    const binding = admitted(t);
    t.core.task('task:b', 'member:b');
    const waits = ['one', 'two'].map(() => t.core.wait('task:a', binding.attemptId,
      { kind: 'TaskAccepted', taskId: 'task:b', deliveryRevision: 1 }, future()).result.entityId);
    const receipt = t.core.finish(binding.attemptId, binding.fence);
    assert.deepEqual(receipt.result, { status: 'produced' });
    assert.equal(t.store.read(binding.attemptId).lease, 'released');
    assert.equal(t.store.read('task:a').status, 'produced');
    assert(waits.every(id => t.store.read(id).status === 'cancelled'));
    // Every tx.put appends an event, so the order is observable: the task row moves before the waits are cancelled.
    const tail = t.store.events().slice(-4).map(event => event.entity);
    assert.deepEqual(tail, [binding.attemptId, 'task:a', ...t.store.list('wait:').map(wait => wait.entityId)]);
  } finally { t.close(); }
});

test('the tool produce keeps its task-row result and its attempt -> waits -> task order', () => {
  const t = team('finish-tool');
  try {
    const binding = admitted(t);
    t.core.task('task:b', 'member:b');
    t.core.mutate('delivery:a', 'operator', {}, tx => tx.put('delivery:a', { owner: 'member:a' }));
    const waits = ['one', 'two'].map(() => t.core.wait('task:a', binding.attemptId,
      { kind: 'TaskAccepted', taskId: 'task:b', deliveryRevision: 1 }, future()).result.entityId);
    const receipt = handleTool(t.core, { actor: 'member:a', attemptId: binding.attemptId, fence: binding.fence }, 'team_task',
      { operationId: 'v1:operation:review-produce-0001', expectedRevision: t.store.read('task:a').revision,
        op: 'produce', taskRef: 'task:a', deliveryRef: 'delivery:a' });
    assert.equal(receipt.result.entityId, 'task:a');
    assert.equal(receipt.result.status, 'produced');
    assert.equal(receipt.result.deliveryRef, 'delivery:a');
    // attempt, the cancelled waits, then the task row, and the tool-intent row the caller writes after the reducer.
    const tail = t.store.events().slice(-5).map(event => event.entity);
    assert.deepEqual(tail, [binding.attemptId, ...t.store.list('wait:').map(wait => wait.entityId), 'task:a',
      'tool-intent:v1:operation:review-produce-0001']);
    assert(waits.every(id => t.store.read(id).status === 'cancelled'));
  } finally { t.close(); }
});

test('the scheduler cursor records the journal head as the admission transaction sees it', () => {
  const t = team('cursor');
  try {
    t.core.task('task:a', 'member:a');
    t.core.schedule('event:a', 'task:a');
    const events = t.store.events();
    assert.equal(events.at(-1).entity, 'scheduler');
    assert.equal(events.at(-2).entity, 'task:a');
    // HEAD read latestEventSeq() inside the transaction, after its own attempt and task writes: the recorded head is
    // this admission's last write, not the head the store had before BEGIN.
    assert.equal(t.store.cursor('scheduler'), events.at(-2).seq);
  } finally { t.close(); }
});

test('a schedule command with a stale CAS writes nothing and produces no start effect', () => {
  const t = team('schedule-cas');
  try {
    t.core.task('task:a', 'member:a');
    const payload = { eventId: 'event:a', taskId: 'task:a', now: Date.now(), expected: {}, maxRuns: 30 };
    const before = ledger(t);
    assert.throws(() => t.core.dispatch('scheduler', 'scheduler', payload, { type: 'schedule.admit', payload,
      cas: { ref: 'task:a', revision: t.store.read('task:a').revision - 1 } }), /CAS_CONFLICT:task:a/);
    assert.equal(ledger(t), before, 'a refused admission leaves no event, no cursor and no start effect');
    assert.equal(t.store.effects().filter(effect => effect.payload.kind === 'start').length, 0);
    // Positive control: the same command with the current revision admits.
    const admittedAgain = t.core.dispatch('scheduler', 'scheduler', payload, { type: 'schedule.admit', payload,
      cas: { ref: 'task:a', revision: t.store.read('task:a').revision } });
    assert(admittedAgain.result.attemptId);
    assert.equal(t.store.effects().filter(effect => effect.payload.kind === 'start').length, 1);
  } finally { t.close(); }
});

test('the direct entry keeps its original legality rules', () => {
  const t = team('entries-direct');
  try {
    // HEAD's core.send wrote a self-addressed intent: the direct entry has no implement gate to open, and the
    // self-addressed refusal stays a tool policy (the intent now also has to name the contract revision it binds).
    t.core.task('task:a', 'member:a');
    const intent = t.core.send('member:a', 'member:a', 'intent', 'the interface I implement',
      { expectedOutcome: 'ack', taskRef: 'task:a', contractRevision: 1 });
    assert.equal(intent.status, 'confirmed');
    // An intent row names its recipient set and carries the window the server computed.
    assert.deepEqual(t.store.read(intent.result.entityId).recipients, ['member:a']);
    assert(t.store.read(intent.result.entityId).closesAt > Date.now(), 'the server opened a real window');
    // HEAD's core.thread wrote a thread for whatever owner string it was handed.
    const thread = t.core.thread('operator', [], 'who reviews this', future());
    assert.equal(t.store.read(thread.result.entityId).owner, 'operator');
    // HEAD's core.task answered a missing owner with SUPERVISION_SCOPE, not UNKNOWN_OWNER.
    assert.throws(() => t.core.task('task:ghost', 'member:ghost'), /SUPERVISION_SCOPE/);
    assert.equal(t.store.read('task:ghost'), null);
  } finally { t.close(); }
});

test('the model path keeps the stricter rules it always had', () => {
  const t = team('entries-collab', { collab: 'on' });
  try {
    const binding = admitted(t);
    const before = ledger(t);
    // A self-addressed intent is refused on the tool path, where the intent is the implement gate.
    assert.throws(() => handleTool(t.core, { actor: 'member:a', attemptId: binding.attemptId, fence: binding.fence },
      'team_message', { operationId: 'v1:operation:review-self-intent-01',
        expectedRevision: t.store.read('task:a').revision, op: 'send',
        to: ['member:a'], kind: 'intent', summary: 'x', expectedOutcome: 'ack', taskRef: 'task:a', contractRevision: 1 }),
      /INTENT_NEEDS_A_DOWNSTREAM/);
    assert.equal(ledger(t), before, 'the refusal happens inside the transaction and writes nothing');
    // The tool may not open a thread for an owner that does not exist.
    assert.throws(() => handleTool(t.core, { actor: 'member:root' }, 'team_thread',
      { operationId: 'v1:operation:review-thread-ghost-01', expectedRevision: t.store.read('task:a').revision,
        op: 'open', owner: 'member:ghost',
        requiredRespondents: [], requiredEvidence: [], question: 'q', deadline: future(), taskRef: 'task:a' }),
      /UNKNOWN_OWNER/);
  } finally { t.close(); }
});

test('the helper cancel overrides any status; the UI cancel still refuses a closed row', () => {
  const t = team('cancel-policy');
  try {
    const messageId = t.core.send('member:b', 'member:a', 'info', 'still relevant').result.entityId;
    t.core.mutate(messageId, 'operator', {}, (tx, row) => tx.put(messageId, { ...row, status: 'resolved' }));
    // HEAD's helper: the sender (or the operator) with a non-empty reason overrides the cancellation, whatever the status.
    cancelMessage(t.core, messageId, 'member:b', 'superseded by a later assignment');
    assert.equal(t.store.read(messageId).status, 'cancelled');
    assert.equal(t.store.read(messageId).cancellationReason, 'superseded by a later assignment');
    // The audited UI path keeps its own refusal for a row that is already closed.
    const before = ledger(t);
    assert.throws(() => submitMailbox(t.core, 'operator', { name: 'mailbox.cancelMessage', target: messageId,
      args: { reason: 'again' }, expectedRevision: t.store.read(messageId).revision,
      operationId: 'v1:operation:review-ui-cancel-01' }), /INVALID_CANCELLATION/);
    assert.equal(ledger(t), before);
  } finally { t.close(); }
});

test('a gate wait does not require an attempt row, and a plain wait still does', () => {
  const t = team('wait-gate');
  try {
    t.core.task('task:a', 'member:a');
    t.core.task('task:b', 'member:b');
    const dependency = { kind: 'TaskAccepted', taskId: 'task:b', deliveryRevision: 1 };
    const gated = t.core.wait('task:a', 'attempt:ghost', dependency, future(), 'gate:review').result;
    assert.equal(gated.attemptId, null);
    assert.equal(gated.postCompletionGateId, 'gate:review');
    assert.equal(t.store.read(gated.entityId).attemptId, null);
    assert.throws(() => t.core.wait('task:a', 'attempt:ghost', dependency, future()), /UNKNOWN_ATTEMPT/);
  } finally { t.close(); }
});

test('the CAS refusal keeps its documented message on every entry', () => {
  const t = team('cas-message');
  try {
    const binding = admitted(t);
    t.core.mutate('artifact:result', 'operator', {}, tx => tx.put('artifact:result', { value: 1, owner: 'member:a' }));
    const payload = { eventId: 'event:b', taskId: 'task:a', now: Date.now(), expected: {}, maxRuns: 30 };
    // The shared reducer names the row it refused.
    assert.throws(() => t.core.dispatch('scheduler', 'scheduler', payload, { type: 'schedule.admit', payload,
      cas: { ref: 'task:a', revision: 0 } }), error => {
      assert.equal(error.message, 'CAS_CONFLICT:task:a');
      return true;
    });
    // The model tool path keeps HEAD's ref-suffixed code.
    const messageId = t.core.send('member:b', 'member:a', 'info', 'hello').result.entityId;
    assert.throws(() => handleTool(t.core, { actor: 'member:a', attemptId: binding.attemptId, fence: binding.fence },
      'team_message', { operationId: 'v1:operation:review-cas-tool-01', expectedRevision: 0, op: 'resolve',
        messageId, resultRef: 'artifact:result' }), error => {
      assert.match(error.message, /^CAS_CONFLICT:message:/);
      return true;
    });
    // The browser-facing projection entry keeps HEAD's bare code; that contract is asserted where the entry lives
    // (verification/p4-commands.mjs), so this package test needs no cross-package import
    // (docs/decisions/M2a-shared-reducer.md §7-9).
  } finally { t.close(); }
});

test('the helper cancel authorizes against the row it cancels, not against an earlier read', () => {
  const t = team('cancel-interleave');
  try {
    // A caller reads the row and sees member:b as the sender.
    const messageId = t.core.send('member:b', 'member:a', 'info', 'please handle this').result.entityId;
    assert.equal(t.store.read(messageId).sender, 'member:b');
    // Between that read and the cancel, the binding moves: member:a is the sender now and member:b is the recipient,
    // so member:b still passes the general reference authorization (it is the addressee).
    t.core.mutate(messageId, 'operator', {}, (tx, row) => tx.put(messageId, { ...row, sender: 'member:a', recipient: 'member:b' }));
    const before = ledger(t);
    assert.throws(() => cancelMessage(t.core, messageId, 'member:b', 'stale permission'), /DENIED/);
    assert.equal(t.store.read(messageId).status, 'stored', 'the old sender must not cancel the moved responsibility');
    assert.equal(ledger(t), before, 'a refused helper cancel writes nothing');
    // The sender the row actually names may cancel.
    cancelMessage(t.core, messageId, 'member:a', 'the current sender withdraws it');
    assert.equal(t.store.read(messageId).status, 'cancelled');
  } finally { t.close(); }
});

test('a resolve from another generation is refused as late, not as unaccepted', () => {
  const t = team('resolve-generation');
  try {
    const binding = admitted(t);
    const generation = t.store.read(binding.attemptId).generation;
    // A row whose accepted/attemptId both point at this attempt but whose generation is not this attempt's: without the
    // generation guard the resolve below would succeed.
    const messageId = 'message:other-generation';
    t.core.mutate(messageId, 'operator', {}, tx => tx.put(messageId, { sender: 'member:b', recipient: 'member:a',
      kind: 'info', summary: 'stale binding', generation: generation + 1, status: 'accepted', stored: true, visible: true,
      accepted: true, attemptId: binding.attemptId }));
    t.core.mutate('artifact:result', 'operator', {}, tx => tx.put('artifact:result', { value: 1, owner: 'member:a' }));
    const before = ledger(t);
    assert.throws(() => handleTool(t.core, { actor: 'member:a', attemptId: binding.attemptId, fence: binding.fence },
      'team_message', { operationId: 'v1:operation:review-resolve-generation-01',
        expectedRevision: t.store.read(messageId).revision, op: 'resolve', messageId, resultRef: 'artifact:result' }),
      /LATE_MESSAGE/);
    assert.equal(t.store.read(messageId).status, 'accepted', 'a stale generation must not close the responsibility');
    assert.equal(ledger(t), before);
  } finally { t.close(); }
});

test('a request cannot loosen the admission its entry selected', () => {
  const t = team('policy-injection');
  try {
    t.core.mutate('artifact:evidence', 'operator', {}, tx => tx.put('artifact:evidence', { status: 'evidence', owner: 'member:a' }));
    // The audited UI writes its policy after the request args, so a request field of the same name is dead weight.
    const unknown = t.core.send('member:b', 'member:a', 'info', 'unroutable').result.entityId;
    t.core.mutate(unknown, 'operator', {}, (tx, row) => tx.put(unknown, { ...row, status: 'unknown' }));
    assert.throws(() => submitMailbox(t.core, 'root', { name: 'mailbox.rebind', target: unknown,
      args: { recipient: 'member:b', evidenceRef: 'artifact:evidence',
        policy: { admission: 'helper', rejectUnknownRow: false, requireEvidenceRow: false } },
      expectedRevision: t.store.read(unknown).revision, operationId: 'v1:operation:review-inject-rebind-01' }),
      /INVALID_REBIND/);
    const resolved = t.core.send('member:b', 'member:a', 'info', 'done').result.entityId;
    t.core.mutate(resolved, 'operator', {}, (tx, row) => tx.put(resolved, { ...row, status: 'resolved' }));
    assert.throws(() => submitMailbox(t.core, 'operator', { name: 'mailbox.cancelMessage', target: resolved,
      args: { reason: 'again', policy: { admission: 'helper', rejectClosedRow: false, validateReason: false } },
      expectedRevision: t.store.read(resolved).revision, operationId: 'v1:operation:review-inject-cancel-01' }),
      /INVALID_CANCELLATION/);
    assert.equal(t.store.read(resolved).status, 'resolved');
    // The tool entry: an undeclared policy/entry field is refused by the published schema...
    assert.throws(() => handleTool(t.core, { actor: 'member:root' }, 'team_thread',
      { operationId: 'v1:operation:review-inject-tool-01', expectedRevision: 0, op: 'open', owner: 'member:a',
        requiredRespondents: [], requiredEvidence: [], question: 'q', deadline: future(), taskRef: 'task:a',
        policy: { requireOwnerRow: false }, entry: 'core' }), /INVALID_TOOL/);
    // ...and the translator only ever emits the policy it declares itself.
    const translated = toolCommand({ role: 'worker' }, { attemptId: 'attempt:x', fence: 1 }, 'team_message',
      { op: 'send', to: 'member:a', kind: 'intent', summary: 'x', expectedOutcome: 'ack', deadline: future(),
        policy: { rejectSelfIntent: false } });
    assert.deepEqual(translated.command.payload.policy, { rejectSelfIntent: true },
      'a caller policy must never reach the reducer');
  } finally { t.close(); }
});
