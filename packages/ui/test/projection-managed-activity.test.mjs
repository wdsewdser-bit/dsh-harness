// Round 2 #1: real managed stores start at the latest checkpoint, not an empty event replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Projection } from '../../projections/index.mjs';
import { ControlStore } from '../../store/index.mjs';
import { realTeam, ROOT, WORKER } from './review-fixture.mjs';

const commit = (team, state) => team.put('task:timeline', {
  owner: WORKER, title: 'retained delivery', contractRevision: 1, status: state });

test('managed cold start/restart/reset reads retained commits and initial pages are newest first', () => {
  const team = realTeam(); let projection;
  try {
    for (const state of ['draft', 'produced', 'accepted']) commit(team, state);
    const expected = team.store.events(0).filter(event => event.entity === 'task:timeline').map(event => event.seq).reverse();
    projection = new Projection(team.store);
    assert.equal(projection.history.length, 0);
    assert.equal(projection.seq, team.store.latestEventSeq(), 'production checkpoint is already at the log head');
    const first = projection.activity(ROOT, { kind: 'delivery', limit: 1 });
    assert.deepEqual(first.events.map(event => event.seq), [expected[0]]);
    assert.match(first.events[0].text, /已验收/);
    assert.equal(first.nextBeforeSeq, expected[0]);
    const older = projection.activity(ROOT, { kind: 'delivery', beforeSeq: first.nextBeforeSeq, limit: 1 });
    assert.deepEqual(older.events.map(event => event.seq), [expected[1]]);
    assert.match(older.events[0].text, /已产出/);
    const oldest = projection.activity(ROOT, { kind: 'delivery', beforeSeq: older.nextBeforeSeq, limit: 1 });
    assert.deepEqual(oldest.events.map(event => event.seq), [expected[2]]);
    assert.equal(oldest.hasMore, false);
    assert.equal(oldest.nextBeforeSeq, null);
    assert.equal(new Set([...first.events, ...older.events, ...oldest.events].map(event => event.seq)).size, 3);
    const readersBefore = team.store.readers().length, seqBefore = team.store.latestEventSeq();
    const cursorBefore = team.store.cursor(projection.reader.id);
    const tail = team.store.readEventTail({ limit: 2, throughSeq: expected[1] });
    assert.equal(tail.events.at(-1).seq, expected[1]);
    assert.equal(tail.events.length, 2);
    assert.equal(team.store.latestEventSeq(), seqBefore, 'read-only tail appends no event');
    assert.equal(team.store.cursor(projection.reader.id), cursorBefore, 'read-only tail never moves a cursor');
    assert.equal(team.store.readers().length, readersBefore, 'read-only tail registers no reader');
    projection.reset(projection.reader.checkpoint());
    assert.equal(projection.history.length, 0);
    assert.deepEqual(projection.activity(ROOT, { kind: 'delivery' }).events.map(event => event.seq), expected);
    projection.close();
    projection = new Projection(team.store);
    assert.deepEqual(projection.activity(ROOT, { kind: 'delivery' }).events.map(event => event.seq), expected);
    commit(team, 'merged');
    const incremental = projection.activity(ROOT, { kind: 'delivery', afterSeq: first.nextAfterSeq });
    assert.equal(incremental.events.length, 1);
    assert.ok(incremental.events[0].seq > first.asOfSeq);
    assert.match(incremental.events[0].text, /已合并/);
    assert.throws(() => projection.activity(ROOT, { afterSeq: 0, beforeSeq: 1 }), /INVALID_CURSOR/);
    assert.throws(() => team.store.readEventTail({ limit: 0 }), /INVALID_CURSOR/);
  } finally { projection?.close(); team.close(); }
});

test('epoch-driven managed checkpoint reset preserves bounded journal tail and exposes its cursor boundary', () => {
  const team = realTeam(); let projection;
  try {
    for (const state of ['draft', 'produced', 'accepted']) commit(team, state);
    let epoch = 0;
    const reader = {
      readEventTail: options => team.store.readEventTail(options),
      openProjectionReader(id, metadata) {
        const actual = team.store.openProjectionReader(id, metadata);
        return { ...actual, epoch: () => epoch,
          checkpoint: () => ({ ...actual.checkpoint(), epoch }), initial: { ...actual.initial, epoch } };
      },
    };
    projection = new Projection(reader, { recentLimit: 2 });
    const before = projection.activity(ROOT, { kind: 'delivery' });
    assert.equal(before.events.length, 2);
    assert.deepEqual(before.events.map(event => event.seq),
      team.store.events(0).slice(-2).map(event => event.seq).reverse());
    epoch++;
    const after = projection.activity(ROOT, { kind: 'delivery' });
    assert.equal(projection.epoch, epoch);
    assert.equal(projection.history.length, 0, 'sync actually reset the checkpoint');
    assert.deepEqual(after.events, before.events);
    assert.equal(after.replayAfterSeq, before.events.at(-1).seq - 1);
    assert.throws(() => projection.activity(ROOT, { afterSeq: 0 }), { code: 'RESYNC_REQUIRED' });
    assert.throws(() => projection.activity(ROOT, { beforeSeq: after.replayAfterSeq }), { code: 'RESYNC_REQUIRED' });
    commit(team, 'merged');
    const moved = projection.activity(ROOT, { kind: 'delivery' });
    assert.ok(moved.replayAfterSeq > after.replayAfterSeq);
    assert.equal(moved.events.length, 2, 'the tail stays bounded after another commit');
  } finally { projection?.close(); team.close(); }
});

test('journal tail also works on a separate genuinely read-only store connection', () => {
  const team = realTeam(); let readonly;
  try {
    commit(team, 'accepted');
    const seq = team.store.latestEventSeq(), readers = team.store.readers().length;
    readonly = ControlStore.openReadOnly(team.dir);
    const result = readonly.readEventTail({ limit: 1, throughSeq: seq });
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].seq, seq);
    assert.equal(result.events[0].payload.status, 'accepted');
    assert.equal(result.replayAfterSeq, seq - 1);
    assert.equal(team.store.latestEventSeq(), seq);
    assert.equal(team.store.readers().length, readers);
  } finally { readonly?.close(); team.close(); }
});


// Round 3: retention keeps genesis/reference closure and can delete an interior journal segment.
test('real retention holes expose only the contiguous tail and reject cursors inside the missing segment', () => {
  const team = realTeam(); let projection, readonly;
  try {
    for (let step = 0; step < 8; step++) team.put('task:timeline', {
      owner: WORKER, title: 'retained revision ' + step, contractRevision: 1, status: 'accepted', step });
    const genesis = team.store.events(0)[0].seq, head = team.store.latestEventSeq();
    const collected = team.store.retainEvidence({ limits: { receipts: 0, events: 2 } });
    assert.ok(collected.compacted.events > 0, 'real retainEvidence deleted events');
    const survivors = team.store.events(0).map(event => event.seq);
    assert.ok(survivors.includes(genesis), 'the real genesis event survived');
    assert.ok(survivors.includes(head - 1) && survivors.includes(head));
    assert.equal(survivors.includes(head - 2), false, 'the journal really has a hole before its tail');
    const tail = team.store.readEventTail({ limit: 256, throughSeq: head });
    assert.deepEqual(tail.events.map(event => event.seq), [head - 1, head]);
    assert.equal(tail.replayAfterSeq, head - 2);
    assert.equal(tail.asOfSeq, head);
    projection = new Projection(team.store);
    assert.throws(() => projection.activity(ROOT, { afterSeq: head - 4 }), error => {
      assert.equal(error.replayAfterSeq, head - 2);
      assert.equal(error.asOfSeq, head);
      return error.code === 'RESYNC_REQUIRED';
    });
    assert.throws(() => projection.activity(ROOT, { beforeSeq: head - 3 }), { code: 'RESYNC_REQUIRED' });
    const increment = projection.activity(ROOT, { afterSeq: head - 2, limit: 1 });
    assert.deepEqual(increment.events.map(event => event.seq), [head - 1]);
    assert.equal(increment.hasMore, true);
    const next = projection.activity(ROOT, { afterSeq: increment.nextAfterSeq, limit: 1 });
    assert.deepEqual(next.events.map(event => event.seq), [head]);
    assert.equal(next.hasMore, false);
    assert.equal(projection.activity(ROOT, { afterSeq: next.nextAfterSeq }).events.length, 0);
    const newest = projection.activity(ROOT, { limit: 1 });
    assert.deepEqual(newest.events.map(event => event.seq), [head]);
    const older = projection.activity(ROOT, { beforeSeq: newest.nextBeforeSeq, limit: 1 });
    assert.deepEqual(older.events.map(event => event.seq), [head - 1]);
    assert.equal(older.hasMore, false);
    assert.equal(older.nextBeforeSeq, null);
    const readersBefore = team.store.readers(), cursorBefore = team.store.cursor(projection.reader.id);
    const recordsBefore = JSON.stringify([team.store.events(0), team.store.list(), team.store.archivedEvidence()]);
    const databaseBytes = () => ['control.sqlite', 'control.sqlite-wal'].map(name => {
      const filename = path.join(team.dir, 'state-v2', name);
      return fs.existsSync(filename) ? fs.readFileSync(filename) : null;
    });
    const bytesBefore = databaseBytes();
    readonly = ControlStore.openReadOnly(team.dir);
    assert.deepEqual(readonly.readEventTail({ throughSeq: head }).events.map(event => event.seq), [head - 1, head]);
    assert.deepEqual(readonly.readEventTail({ limit: 1, throughSeq: head }).events.map(event => event.seq), [head]);
    assert.equal(readonly.readEventTail({ limit: 1, throughSeq: head }).replayAfterSeq, head - 1);
    // A requested head inside a collected gap cannot borrow an unrelated older surviving prefix.
    for (const throughSeq of [head - 2, head + 1]) {
      const missingHead = readonly.readEventTail({ throughSeq });
      assert.deepEqual(missingHead.events, []);
      assert.equal(missingHead.replayAfterSeq, throughSeq);
      assert.equal(missingHead.asOfSeq, throughSeq);
    }
    assert.deepEqual(readonly.readEventTail({ throughSeq: 0 }), { events: [], replayAfterSeq: 0, asOfSeq: 0 });
    assert.deepEqual(readonly.readEventTail({ throughSeq: genesis }).events.map(event => event.seq), [genesis]);
    readonly.close(); readonly = null;
    assert.deepEqual(databaseBytes(), bytesBefore, 'neither database nor WAL bytes changed during tail reads');
    assert.equal(JSON.stringify([team.store.events(0), team.store.list(), team.store.archivedEvidence()]), recordsBefore);
    assert.equal(team.store.latestEventSeq(), head);
    assert.equal(team.store.cursor(projection.reader.id), cursorBefore);
    assert.deepEqual(team.store.readers(), readersBefore, 'tail reads neither register nor advance a reader');
  } finally { readonly?.close(); projection?.close(); team.close(); }
});

