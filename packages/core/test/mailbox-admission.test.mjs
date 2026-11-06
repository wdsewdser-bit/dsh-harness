import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore, submitMailbox } from '../index.mjs';
import { drain } from '../runtime.mjs';

/**
 * F2 ruling A: a mailbox task is a wake, not work.
 *
 * `drain` opens `task:mail-member:<id>` for an idle member with an invisible message. That attempt is not a work slot:
 * when the member's real task is admitted it is released in the same transaction, so the wake can never answer the
 * work with CAPACITY. The wake itself is not lost - what the member has not read stays in its mailbox and the next
 * drain asks for a new one.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../runs');
function team(label) {
  const dir = fs.mkdtempSync(path.join(root, 'mailbox-unit-' + label + '-'));
  const store = new ControlStore(dir);
  const core = new TeamCore(store, {}, { enabled: true });
  core.member('member:root', 'root');
  core.member('member:a', 'worker');
  return { dir, store, core, close() { core.store.close?.(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const wake = (core, summary = 'wake') => core.send('member:root', 'member:a', 'action', summary,
  { expectedOutcome: 'a report', deadline: new Date(Date.now() + 600000).toISOString() }).result.entityId;

test('a live mailbox attempt is released when the work task is admitted, and never answers CAPACITY', () => {
  const t = team('work');
  try {
    wake(t.core);
    drain(t.core);
    const mailbox = t.core.store.list('attempt:').find(row => row.taskId === 'task:mail-member:a' && row.lease === 'active');
    assert.ok(mailbox, 'the wake opened its own attempt');
    t.core.task('task:work', 'member:a', []);
    const admitted = t.core.schedule('admit:work', 'task:work');
    assert.equal(t.core.store.read('task:work').status, 'executing');
    assert.equal(t.core.store.read('task:work').attemptId, admitted.result.attemptId);
    assert.equal(t.core.store.read('task:work').attemptId === mailbox.entityId, false, 'the work has its own attempt');
    const released = t.core.store.read(mailbox.entityId);
    assert.equal(released.lease, 'released');
    assert.equal(released.status, 'cancelled');
    assert.equal(t.core.store.read('task:mail-member:a').status, 'cancelled', 'the wake task closes with its attempt');
  } finally { t.close(); }
});

test('a work task still meets CAPACITY when the live attempt is real work, not a wake', () => {
  const t = team('capacity');
  try {
    t.core.task('task:one', 'member:a', []);
    t.core.schedule('admit:one', 'task:one');
    t.core.task('task:two', 'member:a', []);
    assert.throws(() => t.core.schedule('admit:two', 'task:two'), { code: 'CAPACITY' },
      'the one-live-attempt rule is unchanged for work');
  } finally { t.close(); }
});

test('after a release the next drain asks for a new wake for mail the member has not been woken for', () => {
  const t = team('reask');
  try {
    wake(t.core, 'first');
    drain(t.core);
    const first = t.core.store.list('attempt:').find(row => row.taskId === 'task:mail-member:a');
    t.core.dispatch(first.entityId, 'member:a', { fence: first.fence, status: 'cancelled' },
      { type: 'attempt.release', payload: { attemptId: first.entityId, fence: first.fence, status: 'cancelled' } });
    assert.equal(t.core.store.read(first.entityId).lease, 'released');
    // The ordinary rule: the released wake is not renewed, and the message it already covered is not delivered twice.
    drain(t.core);
    assert.equal(t.core.store.list('attempt:').filter(row => row.taskId === 'task:mail-member:a' && row.lease === 'active').length, 0);
    wake(t.core, 'second');
    drain(t.core);
    const second = t.core.store.list('attempt:').find(row => row.taskId === 'task:mail-member:a' && row.lease === 'active');
    assert.ok(second, 'new mail asks for a new wake');
    assert.notEqual(second.entityId, first.entityId);
    assert.equal(t.core.store.read('task:mail-member:a').status, 'executing');
  } finally { t.close(); }
});


test('a dead-lettered message keeps the audited cancel/rebind admission; closed rows and intents stay refused', () => {
  const t = team('dead-letter');
  try {
    t.core.member('member:b', 'worker');
    t.core.mutate('artifact:evidence', 'root', {}, tx => tx.put('artifact:evidence', { summary: 'cleanup receipt' }));
    const seed = (id, status, kind = 'info') => t.core.mutate(id, 'root', {}, tx => tx.put(id,
      { sender: 'member:root', recipient: 'member:a', recipients: ['member:a'], status, kind, generation: 1 }));
    const submit = (name, id, args) => submitMailbox(t.core, 'member:root',
      { name, target: id, args, expectedRevision: t.store.read(id).revision,
        operationId: 'v1:operation:' + (name === 'mailbox.cancelMessage' ? 'cancel-' : 'rebind-') + id.replace('message:', '') });
    // Status quo (WP-2): dead-letter is not in either audited refusal list, so both writes already land.
    seed('message:dead-cancel', 'dead-letter');
    submit('mailbox.cancelMessage', 'message:dead-cancel', { reason: 'the receipt is lost for good' });
    assert.equal(t.store.read('message:dead-cancel').status, 'cancelled');
    assert.equal(t.store.read('message:dead-cancel').cancellationReason, 'the receipt is lost for good');
    seed('message:dead-rebind', 'dead-letter');
    submit('mailbox.rebind', 'message:dead-rebind',
      { recipient: 'member:b', evidenceRef: 'artifact:evidence', reason: 'hand the lost receipt to another member' });
    const rebound = t.store.read('message:dead-rebind');
    assert.equal(rebound.recipient, 'member:b');
    assert.equal(rebound.status, 'stored', 'a rebind reopens delivery');
    assert.equal(rebound.history.at(-1).recipient, 'member:a');
    assert.equal(rebound.history.at(-1).evidenceRef, 'artifact:evidence');
    // The rest of the audited admission is unchanged: every closed row stays refused, and an intent has its own close.
    for (const status of ['resolved', 'cancelled', 'unknown']) {
      seed('message:' + status, status);
      assert.throws(() => submit('mailbox.cancelMessage', 'message:' + status, { reason: 'try' }), /INVALID_CANCELLATION/);
      assert.throws(() => submit('mailbox.rebind', 'message:' + status,
        { recipient: 'member:b', evidenceRef: 'artifact:evidence' }), /INVALID_REBIND/);
      assert.equal(t.store.read('message:' + status).status, status, status + ': nothing moved');
    }
    seed('message:intent', 'open', 'intent');
    assert.throws(() => submit('mailbox.cancelMessage', 'message:intent', { reason: 'try' }), /INTENT_NOT_CANCELLABLE/);
    assert.throws(() => submit('mailbox.rebind', 'message:intent',
      { recipient: 'member:b', evidenceRef: 'artifact:evidence' }), /INTENT_NOT_REBINDABLE/);
  } finally { t.close(); }
});
