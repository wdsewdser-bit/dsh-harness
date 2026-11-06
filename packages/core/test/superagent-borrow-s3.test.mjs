// §5 of the super-agent borrow design (P3): one input model, one arbiter, one bounded batch, one wake edge.
//
// The cases run offline against a real control store. The core is configured v1 so the S3 code paths are exercised as
// they will run once the protocol can boot; the composition root still refuses to activate v1 (pinned below). The
// legacy arm keeps its own tests (preempt.test.mjs, wake-contract) and this file asserts it is still what a default
// team runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from '../../store/index.mjs';
import { createHumanInputGateway } from '../../host/index.mjs';
import { TeamCore, drain } from '../index.mjs';
import { pendingInputs, orderedInputs, INPUT_KINDS, publicBinding, HUMAN_SLOTS } from '../inputs.mjs';
import { batchCandidate, BATCH_TEXT_LIMIT, renderBatchText, payloadDigest } from '../snapshot.mjs';
import { hash } from '../../contracts/index.mjs';
import { batchPreStep, recordBatchInjection, requestBoundaryBatch, advanceThreadWatermark, verifyInputBinding } from '../provenance.mjs';
import { MemberInputArbiter, PreemptWatcher, inputPolicy } from '../preempt.mjs';
import { BORROW_IMPLEMENTATION_STAGES, ROOT_DECISION_SEMANTICS, assertProtocolSupported } from '../../contracts/index.mjs';


import { root, codeOf, bytes, team, send, humanSend, humanCredential, openResource, subscribe, publish, deliveries,
  ports } from '../test-support/s3-fixtures.mjs';

test('B01/B04: forty mixed inputs become one bounded batch, and an unchanged payload is not injected twice', () => {
  const t = team('batch');
  try {
    for (let index = 0; index < 40; index += 1) {
      send(t, 'member:root', 'member:be', index % 4 === 0 ? 'info' : 'action', 'input ' + index);
    }
    const pending = pendingInputs(t.core, 'member:be');
    assert.equal(pending.pendingCount, 40, 'every durable message is an input');
    assert.equal(pending.bindings.every(item => item.kind === 'message'), true);
    assert.equal(new Set(pending.bindings.map(item => item.ref)).size, 40);
    // Priority, not arrival: the oldest input is an info note, and an action still leads the batch.
    // Priority, not arrival: every action precedes every info note, whatever the ids happen to sort like.
    const kinds = orderedInputs(pending.bindings).map(item => item.messageKind);
    const firstInfo = kinds.indexOf('info');
    assert(firstInfo > 0, 'the batch has both an action and an info note');
    assert(kinds.slice(firstInfo).every(kind => kind === 'info'), 'action/decision precede every info note');
    for (const item of pending.bindings) {
      for (const key of ['kind', 'ref', 'revision', 'memberId', 'generation', 'bindingEpoch', 'sourceSeq', 'priority', 'bodyRef']) {
        assert(Object.hasOwn(item, key), 'inputBinding names ' + key);
      }
      assert(INPUT_KINDS.includes(item.kind), item.kind + ' is a typed input');
    }
    const candidate = batchCandidate(t.core, 'member:be');
    assert.equal(candidate.batch.version, 2);
    assert.equal(candidate.batch.pendingCount, 40);
    assert.equal(candidate.batch.omittedCount, 40 - candidate.batch.nextCursor);
    assert(candidate.manifest.inputBindings.length === candidate.batch.nextCursor);
    assert.deepEqual(candidate.manifest.inputBindings.map(item => item.ref), candidate.payload.detailRefs);
    assert.deepEqual(candidate.manifest.messageIds, candidate.manifest.inputBindings.map(item => item.ref));
    assert(bytes(candidate.text) <= BATCH_TEXT_LIMIT, 'the published 4096 budget is unchanged');
    assert.match(candidate.text, /^<team_batch version="2" rev="/);
    // Deterministic: the same inputs build the same batch, byte for byte.
    const again = batchCandidate(t.core, 'member:be');
    assert.equal(again.manifest.hash, candidate.manifest.hash);
    assert.equal(again.text, candidate.text);
    // The same payload is not injected twice.
    const previous = { revision: candidate.manifest.revision, payloadHash: candidate.manifest.payloadHash };
    assert.equal(batchCandidate(t.core, 'member:be', { previous }), null);
  } finally { t.close(); }
});

test('B02: the cutoff holds, a generation change refuses the old batch, and a late input waits for the next one', async () => {
  const t = team('cutoff');
  try {
    send(t, 'member:root', 'member:be', 'action', 'first');
    const candidate = batchCandidate(t.core, 'member:be');
    assert.equal(candidate.batch.pendingCount, 1);
    // An input committed after the candidate was built is not in it.
    send(t, 'member:root', 'member:be', 'action', 'second');
    assert.equal(candidate.payload.batch.pendingCount, 1);
    assert.equal(pendingInputs(t.core, 'member:be').pendingCount, 2);
    // A generation change between prepare and record refuses the candidate instead of binding it to the new one.
    t.core.mutate('member:be', 'root', { generation: 2 }, (tx, row) =>
      tx.put('member:be', { ...row, generation: (row.generation ?? 1) + 1 }));
    const error = codeOf(() => recordBatchInjection(t.core, candidate, 'native:stale', ['seq:stale']));
    assert.equal(error, 'STALE_MESSAGE_BINDING');
    assert.equal(t.store.read('manifest:' + candidate.manifest.hash), null, 'a refused batch leaves no manifest');
    // The unread old-generation input is not carried into the new generation; a new input is.
    assert.equal(batchCandidate(t.core, 'member:be'), null, 'a stale input is not carried across a rebind');
    send(t, 'member:root', 'member:be', 'action', 'after rebind');
    const fresh = batchCandidate(t.core, 'member:be');
    assert.equal(fresh.batch.generation, t.core.store.read('member:be').generation);
    assert.equal(fresh.batch.pendingCount, 1);
    recordBatchInjection(t.core, fresh, 'native:fresh', ['seq:fresh']);
    assert(t.store.read('manifest:' + fresh.manifest.hash));
  } finally { t.close(); }
});

test('B03: every visible item traces back to its real row, and only carried items become evidence', async () => {
  const t = team('evidence');
  try {
    const thread = openResource(t, 'member:be', { kind: 'file-area', repositoryKey: 'repo:acme/app', key: 'src' });
    subscribe(t, 'member:be', thread.entityId);
    for (let index = 0; index < 3; index += 1) publish(t, 'member:be', thread.entityId, 'change ' + index);
    send(t, 'member:root', 'member:be', 'action', 'please review');
    const candidate = batchCandidate(t.core, 'member:be');
    assert(candidate.manifest.inputBindings.some(item => item.kind === 'thread-delivery'));
    assert(candidate.manifest.inputBindings.some(item => item.kind === 'message'));
    // A resource event never enters the legacy message collection.
    assert.deepEqual(candidate.manifest.messageIds.filter(ref => ref.startsWith('thread-delivery')), []);
    // A forged manifest that puts a delivery into messageIds is refused before anything is written.
    const forged = { ...candidate, manifest: { ...candidate.manifest,
      messageIds: [...candidate.manifest.messageIds, candidate.manifest.inputBindings.find(item => item.kind === 'thread-delivery').ref] } };
    assert.equal(codeOf(() => recordBatchInjection(t.core, forged, 'native:forged', ['seq:forged'])), 'INVALID_MANIFEST');
    // Every binding can be rebuilt from its row; a tampered epoch cannot.
    for (const binding of candidate.manifest.inputBindings) {
      assert(verifyInputBinding(id => t.store.read(id), binding, 'member:be'));
    }
    const delivery = candidate.manifest.inputBindings.find(item => item.kind === 'thread-delivery');
    assert.equal(codeOf(() => verifyInputBinding(id => t.store.read(id), { ...delivery, bindingEpoch: delivery.bindingEpoch + 9 }, 'member:be')),
      'STALE_MESSAGE_BINDING');
    recordBatchInjection(t.core, candidate, 'native:batch', ['seq:batch']);
    const carried = candidate.manifest.messageIds;
    const omitted = pendingInputs(t.core, 'member:be').bindings.filter(item => !candidate.payload.detailRefs.includes(item.ref));
    const result = requestBoundaryBatch(t.core, candidate.manifest.hash,
      { requestId: 'request-1', sessionSeq: 1, requestedAt: 1000, generation: candidate.batch.generation });
    assert.equal(result.confirmed.length, candidate.payload.detailRefs.length);
    for (const id of carried) assert.equal(t.store.read(id).visible, true, id + ' is visible because it was carried');
    for (const item of omitted) {
      const row = t.store.read(item.ref);
      if (row == null) continue;
      if (item.kind === 'thread-delivery') assert.notEqual(row.state, 'visible', 'not carried, not visible');
      else if (row.kind !== 'intent') assert.notEqual(row.visible, true, 'not carried, not visible: ' + item.ref);
    }
    for (const binding of candidate.manifest.inputBindings.filter(item => item.kind === 'thread-delivery')) {
      assert.equal(t.store.read(binding.ref).state, 'visible');
    }
    // A retried transmission is consumed idempotently: nothing is accepted twice.
    const retry = requestBoundaryBatch(t.core, candidate.manifest.hash,
      { requestId: 'request-2', sessionSeq: 2, requestedAt: 2000, generation: candidate.batch.generation });
    assert.deepEqual(retry.confirmed, []);
    assert.equal(retry.skipped.length, result.confirmed.length);
    // A boundary without request evidence records nothing.
    assert.equal(codeOf(() => requestBoundaryBatch(t.core, candidate.manifest.hash, { generation: candidate.batch.generation })),
      'MISSING_REQUEST_EVIDENCE');
  } finally { t.close(); }
});

test('B04: the budget trims, one oversized item fails loudly and stays pending, and a human flood cannot starve resource input', () => {
  const t = team('budget');
  try {
    // Human control fills the batch, but one resource input is always carried.
    const thread = openResource(t, 'member:be', { kind: 'file-area', repositoryKey: 'repo:acme/app', key: 'src' });
    subscribe(t, 'member:be', thread.entityId);
    publish(t, 'member:be', thread.entityId, 'an old change');
    for (let index = 0; index < 40; index += 1) humanSend(t, 'human ' + index);
    const ordered = orderedInputs(pendingInputs(t.core, 'member:be').bindings, { rotation: 0 });
    assert.equal(ordered[0].kind, 'human-control');
    const resourceAt = ordered.findIndex(item => item.kind === 'thread-delivery');
    assert(resourceAt >= 0 && resourceAt <= HUMAN_SLOTS, 'the reserved resource slot survives the human block');
    const candidate = batchCandidate(t.core, 'member:be');
    assert(candidate.manifest.inputBindings.some(item => item.kind === 'thread-delivery'), 'carried, not starved');
    // Rotation changes which resource event leads once more than one is pending.
    publish(t, 'member:be', thread.entityId, 'a newer change');
    const other = openResource(t, 'member:be', { kind: 'file-area', repositoryKey: 'repo:acme/app', key: 'other' });
    subscribe(t, 'member:be', other.entityId); publish(t, 'member:be', other.entityId, 'other resource');
    const pendingDeliveries = pendingInputs(t.core, 'member:be').bindings.filter(item => item.kind === 'thread-delivery');
    const rotated = orderedInputs(pendingInputs(t.core, 'member:be').bindings, { rotation: 1 })
      .filter(item => item.kind === 'thread-delivery');
    assert.notDeepEqual(rotated.map(item => item.ref), pendingDeliveries.map(item => item.ref));
    // A large body is carried as a bounded summary plus its bodyRef, never as the whole text.
    const huge = 'x'.repeat(5000);
    send(t, 'member:root', 'member:qa', 'action', huge);
    const bounded = batchCandidate(t.core, 'member:qa');
    assert.equal(bounded.payload.inputs[0].summary.length <= 160, true, 'the body is a bounded summary');
    assert.equal(bounded.payload.inputs[0].bodyRef.startsWith('message:'), true, 'the full body stays addressable');
    assert(bytes(bounded.text) <= BATCH_TEXT_LIMIT);
    // An item that cannot fit even alone (a tighter budget) is a loud refusal and stays pending.
    assert.equal(codeOf(() => batchCandidate(t.core, 'member:qa', { limit: 100 })), 'BATCH_ITEM_TOO_LARGE');
    assert.equal(pendingInputs(t.core, 'member:qa').pendingCount, 1, 'the oversized input is still pending');
  } finally { t.close(); }
});

test('B04: the watermark stops at the first hole and reopening the store rebuilds the same batch', () => {
  const t = team('retain');
  try {
    const thread = openResource(t, 'member:be', { kind: 'file-area', repositoryKey: 'repo:acme/app', key: 'src' });
    subscribe(t, 'member:be', thread.entityId);
    for (let index = 0; index < 3; index += 1) publish(t, 'member:be', thread.entityId, 'e' + index);
    const rows = deliveries(t, thread.entityId).filter(row => row.memberId === 'member:be').sort((a, b) => a.seq - b.seq);
    assert.equal(rows.length, 3);
    // Only the last delivery is visible: the walk cannot step over the two holes in front of it.
    t.core.mutate(rows[2].entityId, 'adapter', {}, tx => tx.put(rows[2].entityId, { ...tx.read(rows[2].entityId), state: 'visible' }));
    advanceThreadWatermark(t.core, thread.entityId, 'member:be');
    const subId = 'thread-subscription:' + thread.entityId + ':member:be';
    assert.equal(t.store.read(subId).visibleThrough, 0, 'a later confirmation never crosses an earlier hole');
    t.core.mutate(rows[0].entityId, 'adapter', {}, tx => tx.put(rows[0].entityId, { ...tx.read(rows[0].entityId), state: 'visible' }));
    advanceThreadWatermark(t.core, thread.entityId, 'member:be');
    assert.equal(t.store.read(subId).visibleThrough, rows[0].seq, 'the contiguous prefix advances to the first hole');
  } finally { t.close(); }
});

test('B05/B07: the arbiter latches a running member, wakes an idle one once, defers maintenance, and there is no fallback', () => {
  const t = team('arbiter');
  try {
    assert.equal(inputPolicy(t.core), 'queue', 'v1 selects the queue strategy once');
    const wakes = [];
    const agent = { phase: { kind: 'running' }, preemptStep() { throw Error('v1 never preempts a step'); },
      wakeDriver() { wakes.push(Date.now()); this.phase = { kind: 'running' }; return true; } };
    const arbiter = new MemberInputArbiter(t.core);
    arbiter.bind('member:be', agent);
    for (let index = 0; index < 40; index += 1) send(t, 'member:root', 'member:be', 'action', 'burst ' + index);
    const queued = arbiter.onMail('member:be', t.core.pending('member:be')[0].entityId);
    assert.equal(queued.fired, false);
    assert.equal(arbiter.snapshot().preempts, 0, 'the v1 arbiter never asks for a step preemption');
    assert.equal(arbiter.snapshot().coalesced, 0, 'there is no window to coalesce into');
    assert.equal(arbiter.snapshot().queued >= 1, true);
    // Idle: the one idle edge opens the turn, and a second delivery in the same idle window does not open a second.
    agent.phase = { kind: 'idle' };
    const first = arbiter.deliverMail('member:be', t.core.pending('member:be')[0].entityId);
    assert.equal(first.wake, 'woke');
    assert.equal(arbiter.snapshot().idleWakes, 1);
    assert.equal(wakes.length, 1, 'one wake, never two');
    // Maintenance: neither queued nor executed, and the caller is told to defer rather than spend a retry.
    agent.phase = { kind: 'maintenance' };
    const deferred = arbiter.deliverMail('member:be', t.core.pending('member:be')[0].entityId);
    assert.equal(deferred.wake, 'notExecuting');
    assert.equal(deferred.defer, true);
    assert.equal(arbiter.snapshot().deferred, 1);
    // A phase the driver does not publish is 'unknown', never a guess of busy.
    agent.phase = {};
    const unknown = arbiter.deliverMail('member:be', t.core.pending('member:be')[0].entityId);
    assert.equal(unknown.wake, 'unknown');
    // The owner path: a coordination request addressed to root is an input for root, with no attempt and no member scope.
    const intent = send(t, 'member:be', 'member:root', 'intent', 'need a ruling',
      { reason: 'conflict', evidenceRefs: ['task:be'], taskRef: 'task:be', contractRevision: 1,
        expectedOutcome: 'pick one' });
    const rootInputs = pendingInputs(t.core, 'member:root');
    assert(rootInputs.bindings.some(item => item.ref === intent.result.entityId));
    assert.equal(t.store.list('attempt:').filter(row => row.owner === 'member:root').length, 0, 'the owner wakes without an attempt');
    const rootAgent = { phase: { kind: 'idle' }, wakeDriver() { return true; } };
    const rootArbiter = new MemberInputArbiter(t.core);
    rootArbiter.bind('member:root', rootAgent);
    const woke = rootArbiter.deliverMail('member:root', intent.result.entityId);
    assert.equal(woke.wake, 'woke');
    const candidate = batchCandidate(t.core, 'member:root');
    assert.equal(candidate.payload.self.attemptRef, null, 'the owner batch is not an attempt');
    assert(candidate.manifest.inputBindings.some(item => item.ref === intent.result.entityId));
  } finally { t.close(); }
});

test('B06: v1 has no step seam, and a team without v1 still runs the legacy preemption unchanged', () => {
  const legacy = team('legacy', { superagentBorrow: 'off', intentSemantics: 'undecided' });
  try {
    assert.equal(inputPolicy(legacy.core), 'preempt');
    assert.equal(PreemptWatcher, MemberInputArbiter, 'the compatibility export is the same class');
    send(legacy, 'member:root', 'member:be', 'action', 'work');
    legacy.core.ready = () => true;
    const agent = { phase: { kind: 'running' }, steps: 0, preemptStep() { this.steps += 1; return true; } };
    const watcher = new PreemptWatcher(legacy.core, { now: () => 0 });
    watcher.bind('member:be', agent);
    const first = watcher.onMail('member:be', legacy.core.pending('member:be')[0].entityId);
    assert.equal(first.fired, true, 'a legacy team still preempts the live step');
    assert.equal(agent.steps, 1);
    assert.equal(watcher.snapshot().preempts, 1);
    assert.equal(watcher.policy, 'preempt');
    assert.deepEqual(Object.keys(watcher.snapshot()).sort(), ['coalesced','dispatched','notExecuting','notLive','preempts','refused','woke']);
  } finally { legacy.close(); }
  // The protocol stays fail-closed: S3 is recorded, the build is still not a v1 build.
  assert.equal(BORROW_IMPLEMENTATION_STAGES.s3.status, 'implemented');
  assert.equal(BORROW_IMPLEMENTATION_STAGES.s4.status, 'implemented');
  assert.equal(BORROW_IMPLEMENTATION_STAGES.s5.status, 'implemented', 'P5 now wires the projection/UI/acceptance');
  assert.throws(() => assertProtocolSupported({ superagentBorrow: 'v1', intentSemantics: ROOT_DECISION_SEMANTICS }),
    error => error?.code === 'PROTOCOL_UNSUPPORTED');
});


