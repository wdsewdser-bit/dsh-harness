import test from 'node:test';
import assert from 'node:assert/strict';
import { Projection, serve } from '../../projections/index.mjs';
import { maintenanceFixture, waitFor } from '../test-support/retention-graph.mjs';

test('retention projection: host deletes internal seqs, active readers continue, cold state and HTTP/SSE resync recover', { timeout: 30000 }, async () => {
  const w = await maintenanceFixture({ evidenceRetentionCommitThreshold: 1, evidenceMaintenanceIntervalMs: 10,
    evidenceRetentionLimits: { events: 0, receipts: 0, deliveries: 0 } });
  let hot, cold, server; const controllers = [];
  const put = (id, payload) => w.core.mutate(id, 'adapter', payload, tx => tx.put(id, payload));
  try {
    put('member:root', { role: 'root', desired: 'active' });
    put('member:a', { role: 'worker', desired: 'active' });
    put('message:receipt', { kind: 'info', sender: 'member:root', recipient: 'member:a', stored: true, status: 'stored' });
    const storedAt = w.store.read('message:receipt').updatedAt, receiptSeq = w.store.latestEventSeq();
    for (let i = 0; i < 12; i++) put('member:root', { role: 'root', desired: 'active', note: i });
    put('message:receipt', { ...w.store.read('message:receipt'), note: 'updated without changing receipt' });
    hot = new Projection(w.store, { recentLimit: 8 });
    const registered = w.store.readers().find(reader => reader.id === hot.reader.id);
    assert(registered, 'checkpoint capture and consumer registration are one atomic protocol');
    const before = hot.snapshot('member:root').asOfSeq;
    for (let i = 12; i < 36; i++) put('member:root', { role: 'root', desired: 'active', note: i });
    const head = w.store.latestEventSeq();
    await waitFor(() => (w.store.storageStatus().authoritativeEvidenceRetention.compacted.events ?? 0) > 0, 'real host deleted journal events');
    const seqs = w.store.events().map(event => event.seq);
    assert(!seqs.includes(receiptSeq), 'the initial message receipt event really was collected');
    assert(seqs.some((seq, i) => i && seq > seqs[i - 1] + 1), 'maintenance actually removed an INTERNAL seq');
    assert.equal(w.store.events(before).length, head - before, 'active consumer pins every unread event');
    assert.equal(hot.snapshot('member:root').asOfSeq, head, 'existing projection consumes a contiguous suffix after compaction');
    assert.equal(w.store.cursor(hot.reader.id), head);
    assert.equal(hot.rows.get('member:root').note, 35);
    assert.throws(() => hot.events('member:root', before), { code: 'RESYNC_REQUIRED' });
    await waitFor(() => !w.store.retentionWorkPending(), 'host finishes the released history');
    const last = w.store.readers().find(reader => reader.id === hot.reader.id).lastAdvancedAt;
    const runs = w.store.storageStatus().authoritativeEvidenceRetention.runs;
    for (let i = 0; i < 5; i++) hot.snapshot('member:root');
    assert.equal(w.store.retentionWorkPending(), false, 'quiet snapshots do not schedule another full scan');
    assert.equal(w.store.readers().find(reader => reader.id === hot.reader.id).lastAdvancedAt, last);
    assert.equal(w.store.storageStatus().authoritativeEvidenceRetention.runs, runs);

    cold = new Projection(w.store, { recentLimit: 8 });
    const fresh = cold.snapshot('member:root');
    assert.equal(fresh.asOfSeq, head, 'checkpoint state is bound to the journal head');
    assert.equal(cold.rows.get('member:root').note, 35);
    assert.equal(cold.rows.get('message:receipt').receiptTimes.stored, storedAt, 'cold rebuild preserves original receipt time after its event is gone');
    assert.equal(fresh.retention.historicalReplay, 'atomic-checkpoint-and-bounded-tail');
    assert.deepEqual(fresh, hot.snapshot('member:root'), 'cold and hot snapshots of the same authoritative state remain identical');
    assert.throws(() => cold.events('member:root', 0), { code: 'RESYNC_REQUIRED' });
    server = await serve(hot, () => {}, { sessions: new Map([['retention-token', 'member:root']]), port: 40298, heartbeatMs: 20 });
    const base = 'http://127.0.0.1:40298', headers = { authorization: 'Bearer retention-token' };
    const response = await fetch(base + '/team/projection/snapshot', { headers: { ...headers, origin: 'http://127.0.0.1:40291' } });
    assert.equal(response.status, 200); const snapshot = await response.json(); assert.equal(snapshot.asOfSeq, head);
    assert.equal(response.headers.get('access-control-expose-headers'), 'x-projection-replay-after-seq');
    assert.equal(Number(response.headers.get('x-projection-replay-after-seq')), hot.baseSeq,
      'transport advertises its local replay capability separately from canonical state');
    const expired = new AbortController(); controllers.push(expired);
    const old = await fetch(base + '/team/projection/stream?afterSeq=' + before + '&checkpointEpoch=' + snapshot.retention.checkpointEpoch, { headers,
      signal: expired.signal });
    assert.equal(old.status, 409, 'a cursor outside retained replay must explicitly require a new snapshot');
    const refusal = await old.json(); assert.equal(refusal.error, 'RESYNC_REQUIRED'); assert.equal(refusal.resync, true);
    assert(refusal.replayAfterSeq > before);
    const recovered = await (await fetch(base + refusal.snapshot, { headers })).json();
    const active = new AbortController(); controllers.push(active);
    const stream = await fetch(base + '/team/projection/stream?afterSeq=' + recovered.asOfSeq + '&checkpointEpoch=' + recovered.retention.checkpointEpoch, {
      headers, signal: active.signal });
    assert.equal(stream.status, 200); const reader = stream.body.getReader(); const decoder = new TextDecoder(); let frames = '';
    frames += decoder.decode((await reader.read()).value); assert.match(frames, /connected/);
    put('member:root', { role: 'root', desired: 'active', note: 'after-resync' });
    while (!frames.includes('data: ')) frames += decoder.decode((await reader.read()).value);
    const event = JSON.parse(frames.split('\n').find(line => line.startsWith('data: ')).slice(6));
    assert.equal(event.seq, recovered.asOfSeq + 1, 'resynchronized SSE resumes a genuinely contiguous tail');
    assert.equal(hot.rows.get('member:root').note, 'after-resync');
  } finally {
    for (const controller of controllers) controller.abort();
    await server?.close(); cold?.close(); hot?.close();
    if (hot) assert.equal(w.store.readers().some(reader => reader.id === hot.reader.id), false, 'disposed consumers retire explicitly');
    await w.close();
  }
});

test('retention projection: a declared complete-log reader still refuses an unexplained EVENT_GAP', () => {
  const projection = new Projection({ events: () => [
    { seq: 1, entity: 'member:root', payload: { entityId: 'member:root', role: 'root' } },
    { seq: 3, entity: 'member:root', payload: { entityId: 'member:root', role: 'root' } },
  ] });
  assert.throws(() => projection.snapshot('member:root'), /EVENT_GAP/);
});

test('retention projection: archival without new journal events changes checkpoint epoch and invalidates the old stream', { timeout: 30000 }, async () => {
  const w = await maintenanceFixture({ evidenceRetentionCommitThreshold: 1, evidenceMaintenanceIntervalMs: 10,
    evidenceRetentionLimits: { events: 0, receipts: 0, decisions: 0 } });
  let projection, server; const abort = new AbortController();
  let holdMaintenance = true; const actualTransaction = w.store.inTransaction.bind(w.store);
  w.store.inTransaction = () => holdMaintenance || actualTransaction();
  try {
    w.core.mutate('member:root', 'adapter', {}, tx => tx.put('member:root', { role: 'root', desired: 'active' }));
    w.core.mutate('decision:old', 'adapter', {}, tx => tx.put('decision:old', { state: 'decided', kind: 'review' }));
    w.core.mutate('member:root', 'adapter', { tick: 1 }, (tx, row) => tx.put('member:root', { ...row, tick: 1 }));
    projection = new Projection(w.store);
    const before = projection.snapshot('member:root');
    server = await serve(projection, () => {}, { sessions: new Map([['token', 'member:root']]), port: 40297, heartbeatMs: 20 });
    const headers = { authorization: 'Bearer token' };
    const response = await fetch('http://127.0.0.1:40297/team/projection/stream?afterSeq=' + before.asOfSeq + '&checkpointEpoch=' +
      before.retention.checkpointEpoch,
      { headers, signal: abort.signal });
    assert.equal(response.status, 200); const reader = response.body.getReader(); const decoder = new TextDecoder(); let frames = '';
    holdMaintenance = false; // the actual host clock can now archive, after SSE definitely connected
    while (!frames.includes('data: ')) { const chunk = await reader.read(); if (chunk.done) break; frames += decoder.decode(chunk.value); }
    assert.match(frames, /event: resync/);
    assert.match(frames, /RESYNC_REQUIRED/);
    const after = projection.snapshot('member:root');
    assert.equal(after.asOfSeq, before.asOfSeq, 'archival itself does not invent a journal event');
    assert(after.retention.checkpointEpoch > before.retention.checkpointEpoch);
    assert.equal(projection.rows.has('decision:old'), false);
    assert.throws(() => projection.events('member:root', before.asOfSeq, { checkpointEpoch: before.retention.checkpointEpoch }), { code: 'RESYNC_REQUIRED' });
    assert.deepEqual(projection.events('member:root', after.asOfSeq, { checkpointEpoch: after.retention.checkpointEpoch }), []);
  } finally { abort.abort(); await server?.close(); projection?.close(); await w.close(); }
});


test('retention projection: checkpoint state and hot projection preserve the same folded usage after an update', async () => {
  const w = await maintenanceFixture({ evidenceMaintenanceIntervalMs: 10 });
  let hot, cold;
  try {
    w.core.mutate('member:root', 'adapter', {}, tx => tx.put('member:root', { role: 'root' }));
    for (let i = 0; i < 12; i++) w.core.mutate('usage:' + i, 'adapter', { i }, tx => tx.put('usage:' + i,
      { memberId: 'member:root', sessionId: 'session:one', input: 1, output: 1, turns: 1 }));
    hot = new Projection(w.store, { recentLimit: 4 }); hot.snapshot('member:root');
    w.core.mutate('usage:11', 'adapter', { update: true }, (tx, row) => tx.put('usage:11', { ...row, input: 2, turns: 2 }));
    hot.snapshot('member:root'); cold = new Projection(w.store, { recentLimit: 4 }); cold.snapshot('member:root');
    assert.equal(hot.rows.get('usage:11').turns, 13, 'an update cannot overwrite the folded checkpoint with only its own turn count');
    assert.deepEqual([...hot.rows], [...cold.rows], 'hot and cold state reductions use the same authoritative checkpoint semantics');
  } finally { cold?.close(); hot?.close(); await w.close(); }
});

