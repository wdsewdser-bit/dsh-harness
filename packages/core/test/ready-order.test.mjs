import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore, drain } from '../index.mjs';
import { digest } from '../../contracts/index.mjs';
import { backfillReadyOrder } from '../runtime.mjs';
import { DatabaseSync } from 'node:sqlite';

/**
 * v1 FIFO after evidence compaction (gap 1, blocking review 3): the queue position of the current ready episode is
 * persisted on the task row, so the drain no longer depends on a journal transition that retention may collect.
 *
 * The scenario is the review's own: A enters ready, B enters ready, then A is updated while still ready. The order
 * must stay A then B both before and after a retention pass that removes A's old ready event.
 */
function team(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-order-' + label + '-'));
  const store = new ControlStore(dir);
  const core = new TeamCore(store, {}, { enabled: true, autonomy: 'on', teamId: 'team:order', maxRuns: 4,
    superagentBorrow: 'v1', intentSemantics: 'root-decision-v1', collab: 'on' });
  core.member('member:root', 'root');
  core.member('member:w1', 'worker');
  core.member('member:w2', 'worker');
  return { dir, store, core,
    close() { try { store.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); } } };
}

function scenario(t) {
  t.core.task('task:a', 'member:w1', []);
  t.core.task('task:b', 'member:w2', []);
  // Update A while it is still ready: unrelated fields change, queue age must not.
  t.core.task('task:a', 'member:w1', [], { note: 'updated while ready' });
  const head = t.store.latestEventSeq();
  t.core.mutate('cursor:order', 'scheduler', { seq: head }, tx => { tx.cursor('dispatch', head); return null; });
  return head;
}

const orderOf = (t, outcomes) => outcomes.map(outcome => t.store.read(outcome.attemptId)?.taskId);

test('drain order: the persisted ready sequence survives evidence compaction', () => {
  const before = team('before'), after = team('after');
  try {
    scenario(before);
    assert.deepEqual(orderOf(before, drain(before.core)), ['task:a', 'task:b'], 'baseline queue order');
    const head = scenario(after);
    const a = after.store.read('task:a');
    assert(Number.isSafeInteger(a.readySeq), 'the ready episode has a durable queue position');
    assert(after.store.read('task:b').readySeq > a.readySeq);
    const result = after.store.retainEvidence({ limits: { receipts: 2, events: 4 } });
    assert(result.compacted.events > 0, 'the pass collected old versions of the ready rows');
    const retained = after.store.read('task:a');
    assert.equal(retained.readySeq, a.readySeq, 'a retained update keeps the same queue position');
    assert.equal(after.store.latestEventSeq(), head);
    assert.deepEqual(orderOf(after, drain(after.core)), ['task:a', 'task:b'], 'compaction must not reorder the queue');
  } finally { before.close(); after.close(); }
});
/**
 * Blocking review 2: a store written before readySeq existed, then switched from off to v1. The queue positions must be
 * recovered from retained history in one unit before the first drain; createdAt milliseconds must never be compared
 * with journal seqs (a new task would otherwise jump every old one).
 */
test('drain order: legacy ready rows recover their position from history before the first v1 drain', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-order-legacy-'));
  let store = new ControlStore(dir);
  try {
    new TeamCore(store, {}, { enabled: true, autonomy: 'on', teamId: 'team:order', maxRuns: 4 });
    const legacy = (id, owner, index) => store.commit({ entityId: id, teamId: 'team:order', actor: 'scheduler',
      operationId: 'v1:operation:legacy-' + index, expectedRevision: 0, payload: { legacy: index }, payloadHash: digest({ legacy: index }) },
      tx => tx.put(id, { owner, status: 'ready', contractRevision: 1, assignmentEpoch: 1, approved: true, worktreeReady: true, scopeSet: [] }));
    legacy('task:l1', 'member:w1', 1);
    legacy('task:l2', 'member:w2', 2);
    assert.equal(store.read('task:l1').readySeq, undefined, 'the store predates queue positions');
    // off -> v1: a fresh core on the same store, plus one task created after the switch.
    const v1 = new TeamCore(store, {}, { enabled: true, autonomy: 'on', teamId: 'team:order', maxRuns: 4,
      superagentBorrow: 'v1', intentSemantics: 'root-decision-v1', collab: 'on' });
    v1.member('member:root', 'root'); v1.member('member:w1', 'worker'); v1.member('member:w2', 'worker');
    v1.member('member:w3', 'worker');
    v1.task('task:new', 'member:w3', []);
    const head = store.latestEventSeq();
    v1.mutate('cursor:order', 'scheduler', { seq: head }, tx => { tx.cursor('dispatch', head); return null; });
    const outcomes = drain(v1);
    assert.deepEqual(outcomes.map(outcome => store.read(outcome.attemptId)?.taskId), ['task:l1', 'task:l2', 'task:new'],
      'legacy rows keep their history order and the new task joins the tail');
    const l1 = store.read('task:l1'), l2 = store.read('task:l2'), fresh = store.read('task:new');
    assert(Number.isSafeInteger(l1.readySeq) && l1.readySeq < l2.readySeq && l2.readySeq < fresh.readySeq,
      'every position is a journal seq, never a createdAt millisecond');
    const recovered = { l1: l1.readySeq, l2: l2.readySeq };
    // Reopening the store keeps the recovered positions; nothing is reassigned on a second drain.
    store.close();
    store = new ControlStore(dir);
    const reopened = new TeamCore(store, {}, { enabled: true, autonomy: 'on', teamId: 'team:order', maxRuns: 4,
      superagentBorrow: 'v1', intentSemantics: 'root-decision-v1', collab: 'on' });
    assert.equal(store.read('task:l1').readySeq, recovered.l1);
    assert.equal(store.read('task:l2').readySeq, recovered.l2);
    void reopened;
  } finally { try { store.close(); } catch { /* already closed */ } fs.rmSync(dir, { recursive: true, force: true }); }
});
function legacyWrite(store, id, status, serial, extra = {}) {
  const payload = { status, ...extra };
  return store.commit({ entityId: id, teamId: 'team:order', actor: 'scheduler',
    operationId: 'v1:operation:episode-' + serial, expectedRevision: store.read(id)?.revision ?? 0,
    payload, payloadHash: digest(payload) }, tx => tx.put(id, payload));
}

test('drain order: backfill proves the current episode and preserves original seq with mixed queues', () => {
  const w = team('episodes');
  try {
    legacyWrite(w.store, 'task:a', 'ready', 1);
    const aSeq = w.store.latestEventSeq();
    w.core.task('task:existing', 'member:w1', []);
    const existingSeq = w.store.read('task:existing').readySeq;
    legacyWrite(w.store, 'task:b', 'ready', 2);
    const bSeq = w.store.latestEventSeq();
    legacyWrite(w.store, 'task:a', 'ready', 3, { note: 'not a new episode' });
    assert.equal(backfillReadyOrder(w.core), 2);
    assert.equal(w.store.read('task:a').readySeq, aSeq);
    assert.equal(w.store.read('task:b').readySeq, bSeq);
    assert(aSeq < existingSeq && existingSeq < bSeq);
    legacyWrite(w.store, 'task:c', 'ready', 4);
    legacyWrite(w.store, 'task:c', 'blocked', 5);
    legacyWrite(w.store, 'task:c', 'ready', 6);
    const reentry = w.store.latestEventSeq();
    legacyWrite(w.store, 'task:c', 'ready', 7);
    assert.equal(backfillReadyOrder(w.core), 1);
    assert.equal(w.store.read('task:c').readySeq, reentry);
  } finally { w.close(); }
});

test('drain order: missing episode history, including a sole latest ready snapshot, refuses atomically', () => {
  for (const gap of [1, 2]) {
    const w = team('gap-' + gap);
    try {
      legacyWrite(w.store, 'task:a', 'ready', 1);
      legacyWrite(w.store, 'task:a', 'ready', 2);
      legacyWrite(w.store, 'task:a', 'ready', 3);
      const db = new DatabaseSync(path.join(w.dir, 'state-v2/control.sqlite'));
      try { db.prepare('DELETE FROM events WHERE entity=? AND revision<=?').run('task:a', gap); } finally { db.close(); }
      const before = w.store.read('task:a');
      assert.throws(() => backfillReadyOrder(w.core), { code: 'READY_ORDER_UNRECOVERABLE' });
      assert.deepEqual(w.store.read('task:a'), before);
    } finally { w.close(); }
  }
});

test('drain order: concurrent admission before the backfill lock cannot be overwritten', () => {
  const w = team('race');
  const other = new ControlStore(w.dir);
  try {
    legacyWrite(w.store, 'task:a', 'ready', 1);
    const original = w.core.mutate.bind(w.core);
    let raced = false;
    w.core.mutate = (...args) => {
      if (args[0] === 'ready-order-backfill' && !raced) {
        raced = true;
        // A separate writer wins admission after the preflight but before BEGIN IMMEDIATE.
        legacyWrite(other, 'task:a', 'executing', 2, { attemptId: 'attempt:concurrent' });
      }
      return original(...args);
    };
    assert.equal(backfillReadyOrder(w.core), 0);
    assert.equal(w.store.read('task:a').status, 'executing');
    assert.equal(w.store.read('task:a').attemptId, 'attempt:concurrent');
    assert.equal(w.store.read('task:a').revision, 2);
  } finally { other.close(); w.close(); }
});

