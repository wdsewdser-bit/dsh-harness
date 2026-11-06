// Review 2 #4: an unknown mailbox attempt is out of the WORK budget, but it still holds the owner's run slot.
//
// run_slots has UNIQUE(owner) and an unknown lease keeps its row, so admitting a work attempt over an unknown wake
// passed every domain check and then failed inside the store ("UNIQUE constraint failed: run_slots.owner"). The drain
// does not classify that as a scheduling answer, so it ended the candidate scan and the failure repeated while the safe
// cancellation was still pending. The isolation is a normal domain refusal now: the same owner (or the same task) waits.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore, drain } from '../index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../runs');

function team(label) {
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'mailbox-unknown-' + label + '-'));
  const store = new ControlStore(dir);
  const core = new TeamCore(store, {}, { enabled: true, autonomy: 'on' });
  core.member('member:root', 'root');
  core.member('member:w1', 'worker');
  core.member('member:w2', 'worker');
  return { dir, store, core, close() { core.store.close?.(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('review 2 #4: an unknown wake answers BLOCKED for its owner instead of hitting the run-slot constraint', () => {
  const t = team('blocked');
  try {
    t.core.task('task:mail', 'member:w1', [], { mailboxOnly: true });
    const wake = t.core.schedule('wake:1', 'task:mail').result;
    // The wake's lease was lost (expiry or a recovery): nothing proves it stopped, so its slot stays taken.
    t.core.mutate(wake.attemptId, 'scheduler', {}, tx => tx.put(wake.attemptId,
      { ...tx.read(wake.attemptId), lease: 'unknown', status: 'unknown' }));
    assert.equal(t.store.read(wake.attemptId).lease, 'unknown');
    t.core.task('task:work', 'member:w1');
    // The drain must not throw: BLOCKED is a scheduling answer, counted and skipped.
    const outcomes = drain(t.core);
    assert.equal(outcomes.rejected, 1, 'the owner was refused by the domain, not by the store');
    assert.equal(outcomes.length, 0);
    assert.equal(t.store.read('task:work').status, 'ready', 'the work task was left untouched');
    assert.equal(t.store.list('attempt:').filter(row => row.taskId === 'task:work').length, 0, 'no attempt was written');
    // Another member is unaffected: the isolation is about the owner whose slot is still held.
    t.core.task('task:other', 'member:w2');
    drain(t.core);
    assert.equal(t.store.read('task:other').status, 'executing');
  } finally { t.close(); }
});

for (const kind of ['dispatch', 'wake', 'message']) test('active mailbox isolates unknown ' + kind, () => {
  const t = team(kind);
  try {
    t.core.task('task:mail', 'member:w1', [], { mailboxOnly: true });
    const wake = t.core.schedule('wake:1', 'task:mail').result;
    const attempt = t.store.read(wake.attemptId);
    t.core.mutate('message:uncertain', 'adapter', {}, tx => tx.put('message:uncertain', { recipient: attempt.owner, generation: attempt.generation }));
    const payload = kind === 'dispatch' ? { kind, attemptId: wake.attemptId } :
      { kind, recipient: attempt.owner, generation: attempt.generation, messageId: 'message:uncertain' };
    t.core.mutate('seed:uncertain', 'adapter', {}, tx => { tx.outbox('uncertain', payload); return null; });
    t.store.effect(t.core.command('effect:uncertain', 'adapter', {}), 'uncertain', row => ({ ...row, status: 'unknown' }));
    t.core.task('task:work', 'member:w1');
    assert.throws(() => t.core.schedule('work:1', 'task:work'), { code: 'BLOCKED' });
    assert.equal(t.store.read(wake.attemptId).lease, 'active');
    assert.equal(t.store.read('task:work').status, 'ready');
    t.core.task('task:other', 'member:w2');
    t.core.schedule('other:1', 'task:other');
    assert.equal(t.store.read('task:other').status, 'executing');
    // A decisive readback/adjudication lifts effect uncertainty; ordinary handover can then proceed.
    t.store.effect(t.core.command('effect:uncertain', 'adapter', {}), 'uncertain', row => ({ ...row, status: 'confirmed' }));
    t.core.schedule('work:2', 'task:work');
    assert.equal(t.store.read(wake.attemptId).lease, 'released');
    assert.equal(t.store.read('task:work').status, 'executing');
  } finally { t.close(); }
});

test('recovered unknown outbox blocks admission even when its mirror is applying', () => {
  const t = team('recovered');
  try {
    t.core.task('task:mail', 'member:w1', [], { mailboxOnly: true });
    const wake = t.core.schedule('wake:1', 'task:mail').result;
    t.core.mutate('seed:crash', 'adapter', {}, tx => { tx.outbox('crash', { kind: 'dispatch', attemptId: wake.attemptId }); return null; });
    t.store.claim(t.core.command('effect:crash', 'adapter', {}), 'crash', 'adapter', Date.now(), 1);
    t.store.reconcile(t.core.command('recovery:crash', 'scheduler', {}), Date.now() + 1000);
    assert.equal(t.store.effects().find(e => e.id === 'crash').status, 'unknown');
    assert.equal(t.store.read('effect:crash').status, 'applying', 'mirror was deliberately not updated by recovery');
    t.core.task('task:work', 'member:w1');
    assert.throws(() => t.core.schedule('work:1', 'task:work'), { code: 'BLOCKED' });
    assert.equal(t.store.read(wake.attemptId).lease, 'active');
  } finally { t.close(); }
});

for (const kind of ['dispatch', 'wake', 'message']) test('' + kind + ' blocks handover before it becomes unknown', () => {
  const t = team('applying-' + kind);
  try {
    t.core.task('task:mail', 'member:w1', [], { mailboxOnly: true });
    const wake = t.core.schedule('wake:1', 'task:mail').result;
    const attempt = t.store.read(wake.attemptId);
    t.core.mutate('seed:applying', 'adapter', {}, tx => {
      tx.outbox('held', { kind, attemptId: attempt.entityId, recipient: attempt.owner, generation: attempt.generation }); return null;
    });
    t.store.claim(t.core.command('effect:held', 'adapter', {}), 'held', 'adapter', Date.now());
    t.core.task('task:work', 'member:w1');
    assert.throws(() => t.core.schedule('work:applying', 'task:work'), { code: 'BLOCKED' });
    assert.equal(t.store.read(attempt.entityId).lease, 'active');
    t.store.effect(t.core.command('effect:held', 'adapter', {}), 'held', row => ({ ...row, status: 'unknown' }));
    assert.throws(() => t.core.schedule('work:unknown', 'task:work'), { code: 'BLOCKED' });
    assert.equal(t.store.read('task:work').status, 'ready');
    assert.equal(t.store.read(attempt.entityId).lease, 'active');
    t.store.effect(t.core.command('effect:held', 'adapter', {}), 'held', row => ({ ...row, status: 'confirmed' }));
    t.core.schedule('work:confirmed', 'task:work');
    assert.equal(t.store.read(attempt.entityId).lease, 'released', 'a decisive answer lifts the applying/unknown barrier');
  } finally { t.close(); }
});
