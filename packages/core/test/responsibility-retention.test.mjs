import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore, snapshot, recordInjection, requestBoundary } from '../index.mjs';

function team() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbox-r3-'));
  const store = new ControlStore(dir), core = new TeamCore(store, {}, { enabled: true });
  core.member('member:root', 'root'); core.member('member:a', 'worker');
  return { dir, store, core };
}
const send = (core, text) => core.send('member:root', 'member:a', 'info', text).result.entityId;

test('unread update + actual retention + reopen cannot change immutable FIFO order', () => {
  const w = team(); let store = w.store;
  try {
    const first = send(w.core, 'first unread'), second = send(w.core, 'later unread');
    const ranks = [first, second].map(id => store.mailboxFifoSeq(id));
    assert(ranks[0] < ranks[1]);
    const created = store.events().find(e => e.entity === first && e.revision === 1).seq;
    w.core.mutate(first, 'adapter', {}, tx => tx.put(first, { ...tx.read(first), summary: 'updated while unread' }));
    w.core.mutate('padding:tail', 'adapter', {}, tx => tx.put('padding:tail', { value: 1 }));
    const before = snapshot(w.core, 'member:a').manifest.messageIds;
    assert.deepEqual(before, [first, second]);
    let plannedDeletion = false;
    store.retainEvidence({ limits: { events: 1, receipts: 0 }, hooks: { beforeDelete({ plan }) {
      plannedDeletion = plan.deleteEvents.includes(created);
    } } });
    assert(plannedDeletion, 'the real retention planner must delete the first message creation event');
    assert(!store.events().some(e => e.seq === created), 'retention actually applied its deletion');
    assert.equal(store.read(first).visible, false);
    assert.equal(store.read(second).visible, false);
    const surviving = [first, second].map(id => store.events().find(e => e.entity === id).seq);
    assert(surviving[0] > surviving[1], 'surviving-event order now disagrees with creation order');
    assert.deepEqual([first, second].map(id => store.mailboxFifoSeq(id)), ranks);
    assert.deepEqual(snapshot(w.core, 'member:a').manifest.messageIds, before);
    store.close(); store = new ControlStore(w.dir);
    const reopened = new TeamCore(store, {}, { enabled: true });
    assert.deepEqual([first, second].map(id => store.mailboxFifoSeq(id)), ranks, 'rank survives reopen');
    assert.deepEqual(snapshot(reopened, 'member:a').manifest.messageIds, before);
    const third = send(reopened, 'new after retention');
    assert(store.mailboxFifoSeq(third) > ranks[1], 'new arrivals cannot reuse an earlier FIFO ordinal');
    store.close(); store = ControlStore.openReadOnly(w.dir);
    assert.deepEqual([first, second].map(id => store.mailboxFifoSeq(id)), ranks, 'read-only reopen observes the same persisted ranks');
  } finally { store.close(); fs.rmSync(w.dir, { recursive: true, force: true }); }
});

test('legacy FIFO bootstrap persists once instead of ranking again on each open', () => {
  const w = team(); let store = w.store;
  try {
    const first = send(w.core, 'legacy first'), second = send(w.core, 'legacy second');
    store.close();
    const db = new DatabaseSync(path.join(w.dir, 'state-v2/control.sqlite'));
    try { db.exec('DROP TABLE mailbox_fifo'); } finally { db.close(); }
    store = new ControlStore(w.dir);
    const ranks = [first, second].map(id => store.mailboxFifoSeq(id));
    assert(ranks[0] < ranks[1]);
    const core = new TeamCore(store, {}, { enabled: true });
    core.mutate(first, 'adapter', {}, tx => tx.put(first, { ...tx.read(first), summary: 'legacy unread update' }));
    store.retainEvidence({ limits: { events: 1, receipts: 0 } });
    store.close(); store = new ControlStore(w.dir);
    assert.deepEqual([first, second].map(id => store.mailboxFifoSeq(id)), ranks);
  } finally { store.close(); fs.rmSync(w.dir, { recursive: true, force: true }); }
});

test('late committed pre-deadline carrying evidence corrects an already-invalidated receipt without a retry', () => {
  const w = team();
  try {
    const requestedAt = Date.now(), deadline = requestedAt + 1000;
    const id = w.core.send('member:root', 'member:a', 'action', 'request already in flight',
      { deadline: new Date(deadline).toISOString(), expectedOutcome: 'ack' }).result.entityId;
    const candidate = snapshot(w.core, 'member:a'), key = 'wake-receipt:' + id + ':member:a';
    w.core.mutate(key, 'adapter', {}, tx => tx.put(key,
      { generation: 1, delivered: false, invalidated: true, reason: 'expired', dispatched: false, closedAt: deadline + 1 }));
    assert.equal(w.store.read(key).delivered, false);
    assert.equal(w.store.read(id).visible, false);
    recordInjection(w.core, candidate, 'native:late-request', ['seq:late-request'], { generation: 1 });
    requestBoundary(w.core, candidate.manifest.hash, { generation: 1, requestId: 'request:late', sessionSeq: 1, requestedAt });
    const receipt = w.store.read(key);
    assert.equal(w.store.read(id).visible, true);
    assert.equal(receipt.delivered, true, 'correction is written at visibility commit, without calling the delivery port');
    assert.equal(receipt.invalidated, true, 'scheduling stays stopped');
    assert.equal(receipt.reason, 'expired', 'keep the historical invalidation reason');
    assert.equal(receipt.deliveryCorrected, true);
    assert.equal(receipt.deliveryEvidence.manifestHash, candidate.manifest.hash);
    assert.equal(receipt.deliveryEvidence.requestedAt, requestedAt);
    assert(receipt.closedAt > receipt.deliveryEvidence.requestedAt, 'the carrying request started before invalidation');
  } finally { w.store.close(); fs.rmSync(w.dir, { recursive: true, force: true }); }
});

for (const status of ['expired', 'cancelled']) test('terminal ' + status + ' commits before historical carrying evidence without reopening', () => {
  const w = team();
  try {
    const requestedAt = Date.now(), terminalAt = requestedAt + 1000;
    const deadline = status === 'expired' ? terminalAt : terminalAt + 1000;
    const id = w.core.send('member:root', 'member:a', 'action', 'already sent before terminal',
      { deadline: new Date(deadline).toISOString(), expectedOutcome: 'ack' }).result.entityId;
    const candidate = snapshot(w.core, 'member:a'), key = 'wake-receipt:' + id + ':member:a';
    if (status === 'cancelled') {
      w.core.dispatch(id, 'member:root', { reason: 'withdraw after send' },
        { type: 'message.cancel', payload: { messageId: id, reason: 'withdraw after send' } }, { now: terminalAt });
      assert.equal(w.store.read(id).cancelledAt, terminalAt);
    } else {
      w.core.mutate(id, 'scheduler', {}, tx => tx.put(id, { ...tx.read(id), status: 'expired' }));
    }
    w.core.mutate(key, 'adapter', {}, tx => tx.put(key,
      { generation: 1, delivered: false, invalidated: true, reason: status, dispatched: false, closedAt: terminalAt }));
    const effectsBefore = w.store.effects();
    assert.equal(w.core.pending('member:a').length, 0);
    recordInjection(w.core, candidate, 'native:terminal-late-' + status, ['seq:terminal-late'], { generation: 1 });
    const observe = (time, requestId) => requestBoundary(w.core, candidate.manifest.hash,
      { generation: 1, requestId, sessionSeq: 1, requestedAt: time });
    // The same carrying manifest must not let a request begun at/after terminal claim delivery.
    for (const late of [terminalAt, terminalAt + 1]) {
      const before = JSON.stringify({ rows: w.store.list(), events: w.store.events(), effects: w.store.effects() });
      assert.throws(() => observe(late, 'request:too-late-' + late), { code: 'LATE_MESSAGE' });
      assert.equal(JSON.stringify({ rows: w.store.list(), events: w.store.events(), effects: w.store.effects() }), before);
      assert.equal(w.store.read(key).delivered, false);
    }
    observe(requestedAt, 'request:historical-' + status);
    const row = w.store.read(id), receipt = w.store.read(key);
    assert.equal(row.status, status, 'recording delivery must not revive terminal responsibility');
    assert.equal(row.visible, false, 'historical delivery is not a new live visible obligation');
    assert.equal(row.accepted, false);
    assert.equal(row.observation.historical, true);
    assert.equal(row.observation.requestedAt, requestedAt);
    assert.equal(receipt.delivered, true);
    assert.equal(receipt.invalidated, true, 'notification scheduling remains stopped');
    assert.equal(receipt.deliveryEvidence.manifestHash, candidate.manifest.hash);
    assert.equal(receipt.deliveryEvidence.historical, true);
    assert.equal(w.core.pending('member:a').length, 0);
    assert.deepEqual(w.store.effects(), effectsBefore, 'late evidence must not emit a new wake or change effect scheduling');
    observe(requestedAt, 'request:historical-' + status);
    assert.equal(w.store.read(id).status, status);
    assert.equal(w.store.read(key).delivered, true);
  } finally { w.store.close(); fs.rmSync(w.dir, { recursive: true, force: true }); }
});

test('legacy compression BEFORE first FIFO migration establishes a stable post-migration order, not lost creation order', () => {
  const w = team(); let store = w.store;
  try {
    const first = send(w.core, 'first before legacy compression'), second = send(w.core, 'second before legacy compression');
    const created = store.events().find(event => event.entity === first && event.revision === 1).seq;
    w.core.mutate(first, 'adapter', {}, tx => tx.put(first, { ...tx.read(first), summary: 'first updated while unread' }));
    w.core.mutate('padding:legacy', 'adapter', {}, tx => tx.put('padding:legacy', { value: 1 }));
    store.retainEvidence({ limits: { events: 1, receipts: 0 } });
    assert(!store.events().some(event => event.seq === created));
    const surviving = [first, second].map(id => store.events().find(event => event.entity === id).seq);
    assert(surviving[0] > surviving[1], 'compression has already erased the original creation order');
    store.close();
    const db = new DatabaseSync(path.join(w.dir, 'state-v2/control.sqlite'));
    try { db.exec('DROP TABLE mailbox_fifo'); } finally { db.close(); }
    // This is now an already-compressed legacy database with no FIFO metadata.
    store = new ControlStore(w.dir);
    const ranks = [first, second].map(id => store.mailboxFifoSeq(id));
    assert(ranks[0] > ranks[1], 'one-time bootstrap follows surviving history, not an invented creation order');
    let core = new TeamCore(store, {}, { enabled: true });
    const order = snapshot(core, 'member:a').manifest.messageIds;
    assert.deepEqual(order, [second, first]);
    core.mutate(second, 'adapter', {}, tx => tx.put(second, { ...tx.read(second), summary: 'new update after migration' }));
    core.mutate('padding:after-migration', 'adapter', {}, tx => tx.put('padding:after-migration', { value: 2 }));
    store.retainEvidence({ limits: { events: 1, receipts: 0 } });
    store.close(); store = new ControlStore(w.dir); core = new TeamCore(store, {}, { enabled: true });
    assert.deepEqual([first, second].map(id => store.mailboxFifoSeq(id)), ranks);
    assert.deepEqual(snapshot(core, 'member:a').manifest.messageIds, order, 'post-migration order survives updates, retention and reopen');
  } finally { store.close(); fs.rmSync(w.dir, { recursive: true, force: true }); }
});

test('compressed legacy repeated cancellation never uses updatedAt as first cancellation authority', () => {
  const w = team(); let store = w.store;
  const at = (time, action) => {
    const original = Date.now;
    try { Date.now = () => time; return action(); } finally { Date.now = original; }
  };
  try {
    const id = at(500, () => w.core.send('member:root', 'member:a', 'action', 'legacy in-flight request',
      { deadline: new Date(5000).toISOString(), expectedOutcome: 'ack' }).result.entityId);
    const candidate = snapshot(w.core, 'member:a'), key = 'wake-receipt:' + id + ':member:a';
    // Exact legacy row shape: old cancellation writes changed status/updatedAt but did not record cancelledAt.
    at(1000, () => w.core.mutate(id, 'member:root', { reason: 'legacy first cancel' }, tx => tx.put(id,
      { ...tx.read(id), status: 'cancelled', cancellationReason: 'legacy first cancel' })));
    const firstCancellation = store.events().filter(event => event.entity === id).at(-1).seq;
    at(2000, () => w.core.mutate(id, 'member:root', { reason: 'legacy repeat cancel' }, tx => tx.put(id,
      { ...tx.read(id), status: 'cancelled', cancellationReason: 'legacy repeat cancel' })));
    assert.equal(store.read(id).updatedAt, 2000);
    assert.equal(Object.hasOwn(store.read(id), 'cancelledAt'), false);
    w.core.mutate(key, 'adapter', {}, tx => tx.put(key,
      { generation: 1, invalidated: true, delivered: false, reason: 'cancelled', dispatched: false }));
    store.retainEvidence({ limits: { events: 1, receipts: 0 } });
    assert(!store.events().some(event => event.seq === firstCancellation), 'actual compaction removed first-cancel evidence');
    store.close(); store = new ControlStore(w.dir);
    const core = new TeamCore(store, {}, { enabled: true });
    recordInjection(core, candidate, 'native:legacy-cancelled', ['seq:legacy-cancelled'], { generation: 1 });
    const rejectHistorical = () => {
      const before = JSON.stringify({ rows: store.list(), events: store.events(), effects: store.effects() });
      // 1500 is before updatedAt=2000, but AFTER the true first cancellation at 1000. Even 900 must be refused:
      // with the actual first cancellation gone, the legacy row cannot prove either request preceded it.
      for (const requestedAt of [1500, 900]) assert.throws(() => requestBoundary(core, candidate.manifest.hash,
        { generation: 1, requestId: 'request:legacy-' + requestedAt, sessionSeq: 1, requestedAt }), { code: 'LATE_MESSAGE' });
      assert.equal(JSON.stringify({ rows: store.list(), events: store.events(), effects: store.effects() }), before);
      assert.equal(store.read(key).delivered, false);
      assert.equal(store.read(id).observation, undefined);
      assert.equal(Object.hasOwn(store.read(id), 'cancelledAt'), false, 'rejecting evidence must not backfill a guessed time');
    };
    rejectHistorical();
    // Exercise the current REAL cancellation reducer against that compressed legacy row.
    at(3000, () => core.dispatch(id, 'member:root', { reason: 'new repeat of legacy cancellation' },
      { type: 'message.cancel', payload: { messageId: id, reason: 'new repeat of legacy cancellation' } }, { now: 3000 }));
    assert.equal(store.read(id).updatedAt, 3000);
    assert.equal(Object.hasOwn(store.read(id), 'cancelledAt'), false, 'repeat cancel must not promote updatedAt or now into first-cancel time');
    rejectHistorical();
  } finally { store.close(); fs.rmSync(w.dir, { recursive: true, force: true }); }
});

test('new repeated cancellation preserves its known first time, so requests after it stay rejected', () => {
  const w = team();
  try {
    const id = send(w.core, 'new cancellation'), candidate = snapshot(w.core, 'member:a');
    const cancel = now => w.core.dispatch(id, 'member:root', { reason: 'repeat-' + now },
      { type: 'message.cancel', payload: { messageId: id, reason: 'repeat-' + now } }, { now });
    cancel(1000); cancel(2000);
    assert.equal(w.store.read(id).cancelledAt, 1000);
    recordInjection(w.core, candidate, 'native:known-cancel', ['seq:known-cancel'], { generation: 1 });
    assert.throws(() => requestBoundary(w.core, candidate.manifest.hash,
      { generation: 1, requestId: 'request:after-first-cancel', sessionSeq: 1, requestedAt: 1500 }), { code: 'LATE_MESSAGE' });
    assert.equal(w.store.read(id).cancelledAt, 1000);
    assert.equal(w.store.read(id).observation, undefined);
  } finally { w.store.close(); fs.rmSync(w.dir, { recursive: true, force: true }); }
});
