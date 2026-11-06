import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore, snapshot, recordInjection, requestBoundary } from '../index.mjs';

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'responsibility-snapshot-'));
  const store = new ControlStore(dir), core = new TeamCore(store, {}, { enabled: true });
  core.member('member:root', 'root'); core.member('member:a', 'worker'); core.member('member:b', 'worker');
  return { core, store, send(n, kind = 'action') {
    return core.send('member:b', 'member:a', kind, 'responsibility ' + n,
      { expectedOutcome: 'acknowledge ' + n, deadline: new Date(Date.now() + 600000 + n * 1000).toISOString() }).result.entityId;
  }, close() { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('snapshot carries multiple pending responsibilities and the request makes exactly those visible', () => {
  const w = world();
  try {
    const ids = [w.send(1), w.send(2), w.send(3)];
    const candidate = snapshot(w.core, 'member:a');
    assert(candidate.manifest.messageIds.length >= 2, 'two responsibilities must fit together');
    assert.deepEqual(candidate.manifest.messageIds, ids.slice(0, candidate.manifest.messageIds.length));
    assert(Buffer.byteLength(candidate.text) * 2 <= 4096);
    recordInjection(w.core, candidate, 'native:multi', ['seq:multi'], { generation: 1 });
    requestBoundary(w.core, candidate.manifest.hash, { generation: 1, requestId: 'request:multi', sessionSeq: 1, requestedAt: Date.now() });
    for (const id of ids) assert.equal(w.store.read(id).visible === true, candidate.manifest.messageIds.includes(id));
  } finally { w.close(); }
});

test('budget overflow is a deterministic prefix with explicit more count and lossless next offsets', () => {
  const w = world();
  try {
    const ids = Array.from({ length: 12 }, (_, i) => w.send(i));
    const seen = []; let offset = 0;
    do {
      const candidate = snapshot(w.core, 'member:a', null, offset), page = candidate.payload.responsibilityPage;
      assert(Buffer.byteLength(candidate.text) * 2 <= 4096);
      assert.deepEqual(snapshot(w.core, 'member:a', null, offset), candidate);
      assert.deepEqual(candidate.manifest.messageIds, ids.slice(offset, offset + candidate.manifest.messageIds.length));
      seen.push(...candidate.manifest.messageIds);
      assert.equal(page.omittedCount, ids.length - seen.length);
      if (page.omittedCount) {
        assert.equal(page.nextPage, seen.length);
        assert(candidate.text.includes('omittedCount'), 'the model sees that responsibilities remain');
      } else assert.equal(page.nextPage, null);
      offset = page.nextPage;
    } while (offset !== null);
    assert.deepEqual(seen, ids);
  } finally { w.close(); }
});

test('unread FIFO precedes kind and deadline; observed work retains deterministic deadline order', () => {
  const w = world();
  try {
    const info = w.send(0, 'info'), later = w.send(4), earlier = w.send(1);
    const unread = snapshot(w.core, 'member:a').manifest.messageIds;
    assert.equal(unread[0], info, 'unread info must not lose to later actions');
    assert.equal(unread[1], later, 'FIFO rank precedes the later arrival with an earlier deadline');
    for (const id of [info, later, earlier]) w.core.mutate(id, 'adapter', {}, tx => tx.put(id, { ...tx.read(id), visible: true }));
    const ordered = snapshot(w.core, 'member:a').manifest.messageIds;
    assert.equal(ordered[0], earlier); assert.equal(ordered[1], later);
    const pending = w.core.pending.bind(w.core);
    w.core.pending = member => pending(member).reverse();
    assert.deepEqual(snapshot(w.core, 'member:a').manifest.messageIds, ordered);
    assert(!ordered.includes(info) || ordered.indexOf(info) > ordered.indexOf(later));
    w.core.mutate(earlier, 'adapter', {}, tx => tx.put(earlier, { ...tx.read(earlier), deadline: tx.read(later).deadline,
      createdAt: tx.read(later).createdAt }));
    const tied = snapshot(w.core, 'member:a').manifest.messageIds;
    assert.deepEqual(tied.slice(0, 2), [earlier, later].sort((a, b) => a.localeCompare(b)));
  } finally { w.close(); }
});
// The bug's second-cycle form: old accepted roots remain pending while fresh peer actions arrive.
test('budget pressure cannot hide new or not-yet-accepted responsibility behind already accepted roots', () => {
  const w = world();
  try {
    const roots = Array.from({ length: 8 }, (_, i) => w.send(i));
    for (const id of roots) w.core.mutate(id, 'adapter', {}, tx => tx.put(id,
      { ...tx.read(id), visible: true, accepted: true, status: 'accepted' }));
    const action = w.send(100), first = snapshot(w.core, 'member:a');
    assert.equal(first.manifest.messageIds[0], action, 'a later-deadline new action outranks accepted old work');
    assert(first.payload.responsibilityPage.omittedCount > 0);
    recordInjection(w.core, first, 'native:fresh', ['seq:fresh'], { generation: 1 });
    requestBoundary(w.core, first.manifest.hash, { generation: 1, requestId: 'request:fresh', sessionSeq: 1, requestedAt: Date.now() });
    assert.equal(w.store.read(action).visible, true);
    assert.equal(snapshot(w.core, 'member:a').manifest.messageIds[0], action,
      'a visible but unaccepted action stays available for the model to accept on its next request');
  } finally { w.close(); }
});

test('successive request boundaries expose all unread items even while older visible work stays pending', () => {
  const w = world();
  try {
    const ids = Array.from({ length: 12 }, (_, i) => w.send(i));
    const seen = new Set();
    for (let step = 0; seen.size < ids.length; step++) {
      assert(step < ids.length, 'unread responsibilities must make progress');
      const candidate = snapshot(w.core, 'member:a');
      assert(candidate.manifest.messageIds.some(id => !seen.has(id)));
      recordInjection(w.core, candidate, 'native:drain-' + step, ['seq:drain-' + step], { generation: 1 });
      requestBoundary(w.core, candidate.manifest.hash,
        { generation: 1, requestId: 'request:drain-' + step, sessionSeq: step, requestedAt: Date.now() });
      for (const id of candidate.manifest.messageIds) seen.add(id);
    }
    assert.equal(w.core.pending('member:a').length, ids.length, 'visibility does not drop responsibility');
    assert.deepEqual([...seen].sort(), [...ids].sort());
  } finally { w.close(); }
});

test('13 unread items including info have a 13-boundary bound despite new urgent arrivals and accepted action backlog', () => {
  const w = world();
  try {
    const ids = Array.from({ length: 12 }, (_, i) => w.send(i));
    const info = w.send(12, 'info'); ids.push(info);
    // Equal/backwards clocks and UUID order do not let later arrivals overtake journal FIFO.
    for (const id of ids) w.core.mutate(id, 'adapter', {}, tx => tx.put(id, { ...tx.read(id), createdAt: 123 }));
    const rank = w.store.mailboxFifoSeq(info), seen = new Set();
    for (let step = 0; step < ids.length && seen.size < ids.length; step++) {
      const fresh = w.send(-1000 - step);
      w.core.mutate(fresh, 'adapter', {}, tx => tx.put(fresh, { ...tx.read(fresh), createdAt: 0 }));
      const candidate = snapshot(w.core, 'member:a');
      assert(Buffer.byteLength(candidate.text) * 2 <= 4096);
      assert(candidate.manifest.messageIds.some(id => !w.store.read(id).visible), 'at least one unread item per boundary');
      recordInjection(w.core, candidate, 'native:fair-' + step, ['seq:fair-' + step], { generation: 1 });
      requestBoundary(w.core, candidate.manifest.hash,
        { generation: 1, requestId: 'request:fair-' + step, sessionSeq: step, requestedAt: Date.now() });
      for (const id of candidate.manifest.messageIds) {
        if (ids.includes(id)) seen.add(id);
        if (w.store.read(id).kind === 'action') w.core.mutate(id, 'adapter', {}, tx => tx.put(id,
          { ...tx.read(id), accepted: true, status: 'accepted' }));
      }
    }
    assert.equal(seen.size, 13, 'all original unread responsibilities must be seen within U=13 boundaries');
    assert(w.store.read(info).visible, 'info is not starved by visible accepted actions');
    assert.equal(w.store.mailboxFifoSeq(info), rank, 'visibility changes do not change FIFO rank');
    assert.equal(w.core.pending('member:a').filter(row => row.accepted && ids.includes(row.entityId)).length, 12, 'accepted backlog is still present');
  } finally { w.close(); }
});
