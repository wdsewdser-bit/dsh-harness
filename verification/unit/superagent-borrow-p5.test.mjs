// P5 (§3.2, §5, §6, §9, §10 P5): the v1 projection surface, SSE deltas, retention and command authorization.
//
// Every case runs offline against the real control store and the real shared reducers. The projection is built the way
// the composition root builds it (a read-only event reader plus the protocol/capacity facts), and commands go through
// the same UI gateway the browser uses. No provider, no host turn and no second turn driver are involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ControlStore } from '../../packages/store/index.mjs';
import { TeamCore, batchCandidate, recordBatchInjection } from '../../packages/core/index.mjs';
import { Projection } from '../../packages/projections/index.mjs';
import { submit } from '../../packages/projections/commands.mjs';
import { retain } from '../../packages/projections/retention.mjs';
import { serve } from '../../packages/projections/http.mjs';
import { capacityStatusSchema, inputBatchSchema, resourceThreadSchema, roleGuardStatusSchema } from '../../packages/projections/schema.mjs';
import { REPOSITORIES, future, team, projection, openResource, subscribe, publish, legacyThread } from './superagent-borrow-p5-support.mjs';

test('T01/T02 projection: legacy threads stay decision threads, resources become resourceThreads', () => {
  const t = team('discriminant');
  try {
    legacyThread(t);
    const ref = openResource(t, 'member:fe', { kind: 'branch', repositoryKey: 'repo:acme/app', key: 'refs/heads/main' });
    subscribe(t, 'member:fe', ref);
    subscribe(t, 'member:be', ref);
    publish(t, 'member:fe', ref, 'branch moved to 9f2c1e7');
    const snapshot = projection(t).snapshot('member:fe');
    assert.deepEqual(snapshot.data.threads.map(thread => thread.id), ['thread:legacy']);
    assert.equal(snapshot.data.resourceThreads.length, 1);
    const resource = snapshot.data.resourceThreads[0];
    assert.equal(resource.id, ref);
    assert.equal(resource.kind, 'resource');
    assert.equal(resource.status, 'open');
    assert.equal(resource.head, 1);
    assert.equal(resource.lastEvent.summary, 'branch moved to 9f2c1e7');
    assert.equal(resource.pending, 2);
    assert.equal(Object.hasOwn(resource, 'requiredRespondents'), false, 'a resource has no respondents');
    // The owner sees every subscription; a plain subscriber sees only its own.
    assert.deepEqual(resource.subscribers.map(sub => sub.memberId).sort(), ['member:be', 'member:fe']);
    const be = projection(t).snapshot('member:be').data.resourceThreads[0];
    assert.deepEqual(be.subscribers.map(sub => sub.memberId), ['member:be']);
    // An unsubscribed member does not receive the thread identity at all.
    assert.deepEqual(projection(t).snapshot('member:qa').data.resourceThreads, []);
    // Root sees the whole team.
    assert.deepEqual(projection(t).snapshot('member:root').data.resourceThreads[0].subscribers.map(sub => sub.memberId).sort(),
      ['member:be', 'member:fe']);
    for (const field of resourceThreadSchema.required) assert(Object.hasOwn(resource, field), field);
  } finally { t.close(); }
});

// --- T03/T04 SSE: the new collection rides the same in-order delta stream ------------------------------------------------

test('T03/T04 projection: resourceThreads, capacity, roleGuard and inputs stream as deltas; off has none', () => {
  const t = team('stream');
  try {
    const ref = openResource(t, 'member:fe', { kind: 'pr', repositoryKey: 'repo:acme/app',
      key: { provider: 'github', repository: 'acme/app', number: 7 } });
    subscribe(t, 'member:fe', ref);
    publish(t, 'member:fe', ref, 'review requested');
    const proj = projection(t);
    const before = proj.snapshot('member:fe').asOfSeq;
    publish(t, 'member:fe', ref, 'changes approved');
    const deltas = proj.events('member:fe', before);
    assert(deltas.length >= 1);
    // The event row commits before the thread row that advances its head, so the first delta after a publish can
    // still show the previous head; the next one is the committed head. The final snapshot is what the UI renders.
    const resourceDelta = deltas.find(delta => (delta.upserts?.resourceThreads ?? []).some(thread => thread.head === 2));
    assert(resourceDelta, JSON.stringify(deltas));
    assert.equal(resourceDelta.upserts.resourceThreads[0].head, 2);
    assert.equal(resourceDelta.upserts.resourceThreads[0].lastEvent.summary, 'changes approved');
    const snapshot = proj.snapshot('member:fe');
    for (const key of ['capacity', 'roleGuard', 'inputs']) assert(Object.hasOwn(snapshot.data, key), key);
    // The off position adds no key: the envelope keeps the shape it had before P5.
    const off = new Projection({ events: seq => t.store.events(seq), scanEvents: seq => t.store.scanEvents(seq) });
    const offData = off.snapshot('member:fe').data;
    for (const key of ['resourceThreads', 'capacity', 'roleGuard', 'inputs']) {
      assert.equal(Object.hasOwn(offData, key), false, 'off must not add ' + key);
    }
    assert.deepEqual(offData.threads, [], 'the resource thread is not a decision thread in the off envelope either');
  } finally { t.close(); }
});

// --- H01/H03/H06 read side: N/H, unknown and admission closed ----------------------------------------------------------

test('H01/H03/H06 projection: capacity reports N/H, unknown occupancy and closed admission', () => {
  const t = team('capacity');
  try {
    t.core.task('task:a', 'member:fe');
    t.core.schedule('evt:a', 'task:a');
    const proj = projection(t);
    let capacity = proj.snapshot('member:root').data.capacity;
    assert.equal(capacity.normal.current, 1);
    assert.equal(capacity.normal.limit, 2);
    assert.equal(capacity.human.limit, 1);
    assert.equal(capacity.admissionClosed, false);
    assert.equal(capacity.providerCapacity, 'unknown');
    assert(capacityStatusSchema.required.every(key => Object.hasOwn(capacity, key)));
    t.core.controlFact('effect-io:e1', { state: 'unknown' }, tx => tx.put('effect-io:e1',
      { effectId: 'e1', lane: 'normal', state: 'unknown' }));
    capacity = proj.snapshot('member:root').data.capacity;
    assert(capacity.unknown >= 1);
    assert.equal(capacity.admissionClosed, true, 'an unknown effect closes new admission');
    // Occupant identities stay with root; another member gets only aggregate counts.
    assert.equal(proj.snapshot('member:fe').data.capacity.occupants.length, 0);
    t.core.controlFact('effect-io:e1', { state: 'confirmed' }, tx => tx.put('effect-io:e1',
      { effectId: 'e1', lane: 'normal', state: 'confirmed' }));
    capacity = proj.snapshot('member:root').data.capacity;
    assert.equal(capacity.unknown, 0);
    assert.equal(capacity.admissionClosed, false);
  } finally { t.close(); }
});

// --- R01/R02 read side: root=coordinator-only, installation and denial counts ---------------------------------------------

test('R01/R02 projection: roleGuard shows coordinator-only, installation and refused tools without arguments', () => {
  const t = team('guard');
  try {
    t.core.mutate('guard-audit:a', 'adapter', {}, tx => tx.put('guard-audit:a',
      { decision: 'deny', reason: 'CAPABILITY_DENIED', toolIdentity: 'bash', principalKind: 'owner', role: 'root' }));
    t.core.mutate('guard-audit:b', 'adapter', {}, tx => tx.put('guard-audit:b',
      { decision: 'allow', toolIdentity: 'read', principalKind: 'owner', role: 'root' }));
    const proj = projection(t, { roleGuard: () => ({ installed: true, revoked: false, denials: 2, allows: 5,
      auditPersistFailed: true, declared: ['read', 'team_read'] }) });
    const guard = proj.snapshot('member:root').data.roleGuard;
    assert.equal(guard.coordinatorOnly, true);
    assert.equal(guard.installed, true);
    assert.equal(guard.denials, 2);
    assert.equal(guard.allows, 5);
    assert.equal(guard.auditPersistFailed, true);
    assert.deepEqual(guard.declared, ['read', 'team_read']);
    assert.equal(guard.audit.denied, 1);
    assert.equal(guard.audit.allowed, 1);
    assert.deepEqual(guard.audit.byTool.map(entry => entry.identity), ['bash', 'read']);
    assert(guard.policy.deny.includes('execute') && guard.policy.deny.includes('opaque'));
    assert.equal(roleGuardStatusSchema.required.every(key => Object.hasOwn(guard, key)), true);
    assert.equal(proj.snapshot('member:be').data.roleGuard.audit.byTool, null, 'per-tool detail stays with root');
  } finally { t.close(); }
});

// --- B01/B04 read side: the committed batch manifest is the only batch truth ----------------------------------------------

test('B01/B04 projection: inputs publishes the committed manifest, its pending and omitted counts', () => {
  const t = team('inputs');
  try {
    t.core.send('member:root', 'member:fe', 'action', 'check the interface', { deadline: future(600000), expectedOutcome: 'confirm' });
    const candidate = batchCandidate(t.core, 'member:fe');
    assert(candidate, 'the addressed message must be pending for the member');
    recordBatchInjection(t.core, candidate, 'native:s5-batch', [candidate.manifest.revision]);
    const fe = projection(t).snapshot('member:fe').data.inputs;
    assert.equal(fe.count, 1);
    assert.equal(fe.latest.memberId, 'member:fe');
    assert(fe.latest.items >= 1);
    assert.equal(Number.isSafeInteger(fe.latest.pendingCount), true);
    assert.equal(Number.isSafeInteger(fe.latest.omittedCount), true);
    assert.equal(inputBatchSchema.required.every(key => Object.hasOwn(fe, key)), true);
    assert.equal(projection(t).snapshot('member:qa').data.inputs.count, 0, 'another member does not see the batch');
    assert.equal(projection(t).snapshot('member:root').data.inputs.count, 1);
  } finally { t.close(); }
});

// --- §3.2/§5 command gateway: a viewer cannot write, and a member cannot borrow another's authority -----------------------

test('§3.2/§5 commands: viewer writes are refused; proxy, publish and close follow the actor', () => {
  const t = team('commands');
  try {
    const ref = openResource(t, 'member:fe', { kind: 'file-area', repositoryKey: 'repo:acme/app', key: 'src/team' });
    assert(t.store.read(ref).kind === 'resource');
    const revision = t.store.read(ref).revision;
    const rejected = (actor, command) => submit(t.core, actor, command);
    const viewerWrite = rejected('viewer', { name: 'threads.subscribe', target: ref, expectedRevision: revision,
      operationId: t.op('viewer'), args: {} });
    assert.equal(viewerWrite.status, 'rejected');
    assert.match(viewerWrite.message, /ROLE_DENIED|UNKNOWN_ACTOR/);
    const proxy = rejected('member:qa', { name: 'threads.subscribe', target: ref, expectedRevision: revision,
      operationId: t.op('proxy'), args: { memberId: 'member:be' } });
    assert.equal(proxy.status, 'rejected');
    assert.equal(proxy.message, 'ROLE_DENIED');
    const notSubscribed = rejected('member:qa', { name: 'threads.publish', target: ref, expectedRevision: revision,
      operationId: t.op('not-sub'), args: { eventType: 'change-reported', summary: 'hello' } });
    assert.equal(notSubscribed.status, 'rejected');
    assert.match(notSubscribed.message, /^NOT_SUBSCRIBED/);
    const notOwner = rejected('member:qa', { name: 'threads.closeResource', target: ref, expectedRevision: revision,
      operationId: t.op('not-owner'), args: { reason: 'done' } });
    assert.equal(notOwner.status, 'rejected');
    assert.match(notOwner.message, /^DENIED/);
    // A non-subscriber never reaches the kind refusal (the shared reference check refuses first); the owner does,
    // and the reducer answers with the thread-family refusal.
    const outsiderDecide = rejected('member:qa', { name: 'threads.decide', target: ref, expectedRevision: revision,
      operationId: t.op('outsider-decide'), args: { proposalRevision: 1, conclusionRef: 'artifact:1:qa' } });
    assert.match(outsiderDecide.message, /^REFERENCE_ACL/);
    // The tool entry checks that the conclusion artifact exists before the reducer; create one so the resource-kind
    // refusal itself is what the command reports.
    t.core.mutate('artifact:1:root', 'adapter', {}, tx => tx.put('artifact:1:root', { cycle: 1, actor: 'member:root' }));
    const wrongKind = rejected('member:root', { name: 'threads.decide', target: ref, expectedRevision: revision,
      operationId: t.op('decide'), args: { proposalRevision: 1, conclusionRef: 'artifact:1:root' } });
    assert.equal(wrongKind.status, 'rejected');
    assert.match(wrongKind.message, /^WRONG_THREAD_KIND/);
    // The owner may subscribe itself; root may subscribe a member; then that member may report.
    const ownerSub = rejected('member:fe', { name: 'threads.subscribe', target: ref, expectedRevision: revision,
      operationId: t.op('owner-sub'), args: {} });
    assert.equal(ownerSub.status, 'accepted');
    const rootSub = rejected('member:root', { name: 'threads.subscribe', target: ref,
      expectedRevision: t.store.read(ref).revision, operationId: t.op('root-sub'), args: { memberId: 'member:qa' } });
    assert.equal(rootSub.status, 'accepted');
    const published = publish(t, 'member:qa', ref, 'saw a change');
    assert.equal(published.status, 'accepted');
    const closed = rejected('member:qa', { name: 'threads.closeResource', target: ref,
      expectedRevision: t.store.read(ref).revision, operationId: t.op('close-denied'), args: { reason: 'done' } });
    assert.match(closed.message, /^DENIED/);
    const ownerClose = rejected('member:fe', { name: 'threads.closeResource', target: ref,
      expectedRevision: t.store.read(ref).revision, operationId: t.op('close'), args: { reason: 'merged' } });
    assert.equal(ownerClose.status, 'accepted');
    const afterClose = rejected('member:qa', { name: 'threads.publish', target: ref,
      expectedRevision: t.store.read(ref).revision, operationId: t.op('after-close'), args: { eventType: 'x', summary: 'y' } });
    assert.equal(afterClose.status, 'rejected');
    assert.match(afterClose.message, /^THREAD_CLOSED/);
  } finally { t.close(); }
});

// --- §3.4 retention: pending deliveries and cited evidence outlive their summaries -------------------------------------

test('§3.4 retention: pending deliveries and decision evidence are never collected; terminal history is', () => {
  const rows = new Map();
  const put = (id, row) => rows.set(id, { entityId: id, updatedAt: 1, ...row });
  put('thread:t1', { kind: 'resource', status: 'open', retainedFrom: 3 });
  put('thread-event:t1:000001', { threadRef: 'thread:t1', seq: 1, summary: 'old' });
  put('thread-event:t1:000002', { threadRef: 'thread:t1', seq: 2, summary: 'cited' });
  put('thread-event:t1:000003', { threadRef: 'thread:t1', seq: 3, summary: 'pending' });
  put('thread-event:t1:000004', { threadRef: 'thread:t1', seq: 4, summary: 'batch body' });
  put('thread-event:t1:000005', { threadRef: 'thread:t1', seq: 5, summary: 'cited batch body' });
  put('thread-event:t1:000006', { threadRef: 'thread:t1', seq: 6, summary: 'above watermark' });
  put('thread-delivery:t1:000001:member:be:1', { threadRef: 'thread:t1', seq: 1, memberId: 'member:be',
    state: 'superseded', eventRef: 'thread-event:t1:000001' });
  put('thread-delivery:t1:000003:member:be:1', { threadRef: 'thread:t1', seq: 3, memberId: 'member:be',
    state: 'pending', eventRef: 'thread-event:t1:000003' });
  put('thread-delivery:t1:000005:member:be:1', { threadRef: 'thread:t1', seq: 5, memberId: 'member:be',
    state: 'visible', eventRef: 'thread-event:t1:000005' });
  put('decision:d1', { state: 'open', subject: { id: 'thread-event:t1:000002' } });
  // A committed batch is evidence of what a request carried: its binding body and its detail delivery both protect the body.
  put('manifest:m1', { updatedAt: 100, inputBindings: [{ kind: 'thread-delivery', bodyRef: 'thread-event:t1:000004' }],
    detailRefs: ['thread-delivery:t1:000005:member:be:1'] });
  put('thread-subscription:t1:member:be', { threadRef: 'thread:t1', memberId: 'member:be', state: 'active' });
  put('thread-subscription:t1:member:qa', { threadRef: 'thread:t1', memberId: 'member:qa', state: 'closed' });
  put('thread-resource:index1', { threadRef: 'thread:t1' });
  // Keep the newest manifest (updatedAt 100) so its references stay in scope for the watermark test below.
  retain(rows, 1, { protocol: 'v1' });
  assert.equal(rows.has('thread-event:t1:000001'), false, 'below the watermark and unreserved is collectable');
  assert.equal(rows.has('thread-delivery:t1:000001:member:be:1'), false, 'its terminal delivery follows the event');
  assert(rows.has('thread-event:t1:000002'), 'a decision cites this event');
  assert(rows.has('thread-event:t1:000003'), 'a pending delivery reserves this event');
  assert(rows.has('thread-delivery:t1:000003:member:be:1'), 'a pending delivery is never archived');
  assert(rows.has('thread-event:t1:000004'), 'a committed batch binding reserves this event');
  assert(rows.has('thread-event:t1:000005'), 'a manifest detail delivery reserves the event it carried');
  assert(rows.has('thread-delivery:t1:000005:member:be:1'), 'a delivery whose body is still retained stays');
  assert(rows.has('thread-event:t1:000006'), 'above the retention watermark');
  assert(rows.has('thread:t1'), 'the resource thread row itself is history');
  assert(rows.has('thread-resource:index1'), 'the resource index must survive for the same resource to reopen');
  assert(rows.has('thread-subscription:t1:member:be'), 'an active subscription stays');
  assert(rows.has('thread-subscription:t1:member:qa'), 'a closed subscription is durable history, not garbage');
  // Once the delivery is visible and the citation gone, the event and the delivery may go.
  rows.get('thread-delivery:t1:000003:member:be:1').state = 'visible';
  rows.delete('decision:d1');
  rows.get('thread:t1').retainedFrom = 7;
  retain(rows, 1, { protocol: 'v1' });
  assert.equal(rows.has('thread-event:t1:000002'), false);
  assert.equal(rows.has('thread-event:t1:000003'), false);
  assert.equal(rows.has('thread-delivery:t1:000003:member:be:1'), false);
  assert(rows.has('thread-event:t1:000004'), 'the committed batch still reserves its body');
  assert(rows.has('thread-event:t1:000005'), 'the committed batch still reserves its detail delivery body');
  // The batch evidence itself is retained; once it is gone, its events are ordinary candidates.
  rows.delete('manifest:m1');
  retain(rows, 0, { protocol: 'v1' });
  assert.equal(rows.has('thread-event:t1:000004'), false);
  assert.equal(rows.has('thread-event:t1:000005'), false);
  assert.equal(rows.has('thread-delivery:t1:000005:member:be:1'), false);
});
