// P1 of the team-autonomy design (docs/decisions/team-autonomy-design.md §3): the owner path.
//
// Root is a member row with no attempt. Before P1 that made message.accept impossible for it, because the reducer's
// first line was leaseOf(). These tests pin the replacement: a predicate over the owner row, selected by the trusted
// entry, with the execution path left exactly as it was -- and nothing at all when the autonomy switch is off.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../index.mjs';
import { handleTool } from '../tools.mjs';
import { snapshot } from '../snapshot.mjs';
import { recordInjection } from '../provenance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../runs');
const future = ms => new Date(Date.now() + ms).toISOString();

function team(label, configuration = {}) {
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'autonomy-owner-' + label + '-'));
  const store = new ControlStore(dir);
  const core = new TeamCore(store, {}, { enabled: true, autonomy: 'on', ...configuration });
  core.member('member:root', 'root');
  core.member('member:a', 'worker');
  core.member('member:b', 'worker');
  core.member('member:qa', 'verifier');
  return { dir, store, core, close() { core.store.close?.(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const send = (t, from, to, summary = 'take this responsibility') => t.core.send(from, to, 'action', summary,
  { expectedOutcome: 'a report', deadline: future(600000) }).result.entityId;

/** Put the member's mailbox in one real request and record the manifest the request carried (invariant 8). */
function observe(t, memberId, messageId, requestId = 'request-1') {
  const candidate = snapshot(t.core, memberId, null, 0);
  assert(candidate.manifest.messageIds.includes(messageId), 'the injected page must carry ' + messageId);
  recordInjection(t.core, candidate, 'native:' + requestId, ['seq:' + requestId]);
  return t.core.visible(messageId, { requestId, manifestHash: candidate.manifest.hash, sessionSeq: 1,
    requestedAt: Date.now() }, memberId);
}

test('the owner takes up a responsibility addressed to it, with no attempt and no fabricated lease', () => {
  const t = team('accept');
  try {
    const messageId = send(t, 'member:a', 'member:root');
    observe(t, 'member:root', messageId);
    t.core.acceptAsOwner(messageId, 'member:root');
    const row = t.store.read(messageId);
    assert.equal(row.status, 'accepted');
    assert.equal(row.accepted, true);
    assert.equal(row.attemptId, null, 'the owner has no attempt and none is invented for it');
    assert.deepEqual(row.acceptedBy, { kind: 'owner', attemptId: null, generation: 1 });
    // A checkpoint is an execution fact: the owner writes none, and no row pretends it did.
    assert.equal(t.store.list('checkpoint:').length, 0);
    t.core.resolveAsOwner(messageId, 'member:root', 'artifact:1:root');
    const resolved = t.store.read(messageId);
    assert.equal(resolved.status, 'resolved');
    assert.deepEqual(resolved.resolvedBy, { kind: 'owner', generation: 1 });
  } finally { t.close(); }
});

test('a member accept is unchanged: its lease, its checkpoint and no owner fields at all', () => {
  const t = team('member');
  try {
    t.core.task('task:a', 'member:a', []);
    const attempt = t.core.schedule('admit-a', 'task:a').result;
    const messageId = send(t, 'member:root', 'member:a');
    observe(t, 'member:a', messageId);
    t.core.accept(messageId, attempt.attemptId, attempt.fence, 'checkpoint-1');
    const row = t.store.read(messageId);
    assert.equal(row.status, 'accepted');
    assert.equal(row.attemptId, attempt.attemptId);
    assert.equal(row.checkpointRef, 'checkpoint-1');
    assert.equal(Object.hasOwn(row, 'acceptedBy'), false, 'the execution path writes exactly the row it always wrote');
    assert.equal(t.store.read('checkpoint:checkpoint-1').attemptId, attempt.attemptId);
    // The lease rule is not relaxed for anybody else: a worker naming the owner channel is not an owner.
    assert.throws(() => t.core.acceptAsOwner(messageId, 'member:a'), { code: 'DENIED' });
  } finally { t.close(); }
});

test('a self-addressed responsibility cannot be accepted by the owner (U6)', () => {
  const t = team('self');
  try {
    const messageId = send(t, 'member:root', 'member:root');
    observe(t, 'member:root', messageId);
    assert.throws(() => t.core.acceptAsOwner(messageId, 'member:root'), { code: 'SELF_ADDRESSED' });
    const row = t.store.read(messageId);
    assert.equal(row.status, 'visible', 'the refusal wrote nothing');
    assert.equal(row.accepted, false);
  } finally { t.close(); }
});

test('the owner still cannot accept what was never in a request (B2), nor somebody else responsibility (B3)', () => {
  const t = team('refusals');
  try {
    const invisible = send(t, 'member:a', 'member:root');
    assert.throws(() => t.core.acceptAsOwner(invisible, 'member:root'), { code: 'NOT_VISIBLE' });
    const late = send(t, 'member:b', 'member:a');
    observe(t, 'member:a', late);
    // The code keeps its ref suffix on purpose (fail('LATE_MESSAGE:' + id)); the class is what the entry answers.
    assert.throws(() => t.core.acceptAsOwner(late, 'member:root'),
      error => error.code === 'LATE_MESSAGE' || String(error.code).startsWith('LATE_MESSAGE:'));
  } finally { t.close(); }
});

test('the owner channel is verified against the member row, never taken from the command', () => {
  const t = team('claim');
  try {
    const messageId = send(t, 'member:b', 'member:a');
    observe(t, 'member:a', messageId);
    // A command that names the owner channel is not believed: member:a is not an owner row.
    assert.throws(() => t.core.dispatch(messageId, 'member:a', { messageId },
      { type: 'message.accept', policy: { authority: 'owner' },
        payload: { messageId, attemptId: null, fence: null, checkpointRef: null } }), { code: 'DENIED' });
    // A command that selects nothing keeps the lease rule it has always had (an owner attempt is not invented).
    assert.throws(() => t.core.dispatch(messageId, 'member:a', { messageId },
      { type: 'message.accept', payload: { messageId, attemptId: null, fence: null, checkpointRef: 'c1' } }),
      { code: 'INVALID_LEASE' });
    assert.equal(t.store.read(messageId).status, 'visible');
  } finally { t.close(); }
});

test('with the autonomy switch off the owner entry points do not exist at all', () => {
  const t = team('off', { autonomy: 'off' });
  try {
    const messageId = send(t, 'member:a', 'member:root');
    observe(t, 'member:root', messageId);
    assert.throws(() => t.core.acceptAsOwner(messageId, 'member:root'), { code: 'DENIED' });
    assert.equal(t.store.read(messageId).status, 'visible', 'the refused accept wrote nothing');
    assert.throws(() => handleTool(t.core, { actor: 'member:root' }, 'team_decide',
      { operationId: 'v1:operation:autonomy-off-0001', decisionId: 'decision:x', decision: 'waive' }),
      { code: 'ROLE_DENIED' });
  } finally { t.close(); }
});

test('the decision tool is published to the owner alone, and only while the switch is on', () => {
  const t = team('surface');
  try {
    // The owner reaches the reducer: the row it named does not exist, which the CAS pre-step answers -- that is the
    // shared reducer talking, not ROLE_DENIED from the surface, so the tool really is published to this role.
    assert.throws(() => handleTool(t.core, { actor: 'member:root' }, 'team_decide',
      { operationId: 'v1:operation:autonomy-surface-01', decisionId: 'decision:none', decision: 'waive' }),
      error => String(error.code).startsWith('CAS_CONFLICT'));
    // A worker and a verifier do not have the tool at all: the refusal is the surface's ROLE_DENIED.
    for (const actor of ['member:a', 'member:qa']) {
      assert.throws(() => handleTool(t.core, { actor }, 'team_decide',
        { operationId: 'v1:operation:autonomy-surface-02', decisionId: 'decision:none', decision: 'waive' }),
        { code: 'ROLE_DENIED' }, actor + ' must not see the decision tool');
    }
  } finally { t.close(); }
});

test('§3.2.3: the OWNER real tool path accepts and resolves with no attempt and no fabricated checkpoint', () => {
  const t = team('tool-owner');
  try {
    const messageId = send(t, 'member:a', 'member:root');
    observe(t, 'member:root', messageId);
    t.core.mutate('artifact:1:root', 'root', {}, tx => tx.put('artifact:1:root', { owner: 'member:root', status: 'published' }));
    // The model names the message and the revision it read. It names no attempt and no checkpoint, because an owner has
    // neither -- and the schema published to it no longer demands one.
    handleTool(t.core, { actor: 'member:root' }, 'team_message', { operationId: 'v1:operation:owner-tool-accept-01',
      expectedRevision: t.store.read(messageId).revision, op: 'accept', messageId });
    const accepted = t.store.read(messageId);
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.attemptId, null, 'no attempt is invented for the owner');
    assert.deepEqual(accepted.acceptedBy, { kind: 'owner', attemptId: null, generation: 1 });
    assert.equal(t.store.list('checkpoint:').length, 0, 'and no checkpoint row is written');
    handleTool(t.core, { actor: 'member:root' }, 'team_message', { operationId: 'v1:operation:owner-tool-resolve-01',
      expectedRevision: accepted.revision, op: 'resolve', messageId, resultRef: 'artifact:1:root' });
    const resolved = t.store.read(messageId);
    assert.equal(resolved.status, 'resolved');
    assert.deepEqual(resolved.resolvedBy, { kind: 'owner', generation: 1 });
  } finally { t.close(); }
});

test('§3.2.3: a member tool accept keeps its lease, its checkpoint and its execution authority', () => {
  const t = team('tool-member');
  try {
    t.core.task('task:a', 'member:a', []);
    const attempt = t.core.schedule('admit-tool-a', 'task:a').result;
    const messageId = send(t, 'member:root', 'member:a');
    observe(t, 'member:a', messageId);
    handleTool(t.core, { actor: 'member:a', attemptId: attempt.attemptId, fence: attempt.fence }, 'team_message',
      { operationId: 'v1:operation:member-tool-accept-01', expectedRevision: t.store.read(messageId).revision,
        op: 'accept', messageId, checkpointRef: 'checkpoint:cp-tool' });
    const row = t.store.read(messageId);
    assert.equal(row.status, 'accepted');
    assert.equal(row.attemptId, attempt.attemptId);
    assert.equal(row.checkpointRef, 'checkpoint:cp-tool');
    assert.equal(t.store.read('checkpoint:checkpoint:cp-tool').attemptId, attempt.attemptId);
    assert.equal(Object.hasOwn(row, 'acceptedBy'), false, 'the execution path writes the row it always wrote');
  } finally { t.close(); }
});

test('§3.2.3: the channel cannot be claimed from the request', () => {
  const t = team('tool-claim');
  try {
    const messageId = send(t, 'member:a', 'member:root');
    observe(t, 'member:root', messageId);
    // The published accept branch has no authority field, so a request that carries one is refused as a field error
    // rather than being read as a stronger channel.
    assert.throws(() => handleTool(t.core, { actor: 'member:root' }, 'team_message',
      { operationId: 'v1:operation:owner-tool-claim-01', expectedRevision: t.store.read(messageId).revision,
        op: 'accept', messageId, authority: 'owner' }),
    error => error.code === 'INVALID_TOOL_BRANCH' && /unknown field\(s\) authority/.test(error.message));
    assert.equal(t.store.read(messageId).status, 'visible', 'and nothing was accepted');
  } finally { t.close(); }
});
