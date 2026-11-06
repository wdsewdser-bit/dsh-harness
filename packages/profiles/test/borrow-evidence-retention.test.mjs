import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore, BORROW_STORE_VERSION } from '../../store/index.mjs';
import { digest, canonical, teamPolicyRow } from '../../contracts/index.mjs';
import { initializeBorrowPolicy } from '../borrow-policy.mjs';
import { cleanupOrThrow, withStore } from '../test-support/temp-roots.mjs';
import { runControlled } from '../test-support/controlled-run.mjs';
import { runMutant, firstRunTail } from '../test-support/mutant-policy.mjs';
import { evidenceSnapshot, assertEvidenceBatch, maintenanceFixture as real, waitFor } from '../test-support/retention-graph.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { buildTarget } from '../../adapter-dsh/index.mjs';

/**
 * Gap 1 acceptance: authoritative evidence lifecycle (joint reference closure, idempotent-receipt compaction, atomic
 * archive, repeated passes, archive provenance, multi-process contention). Offline: throwaway control stores only.
 */

import { dirs, fresh, teamId, manifestOf, drift, op, clock, now, entity, seedRows, advanceCursor, SUMMARY_KEYS, summaryValue,
  writeMigration } from '../test-support/retention-fixtures.mjs';

test('retention core: closure keeps referenced evidence, receipts compact and still replay', () => {
  const root = fresh();
  withStore(ControlStore, root, s => {
    const migration = writeMigration(s, op('migrate-001'));
    seedRows(s, { 'member:root': { role: 'root', desired: 'active' },
      'thread:issue-1': { kind: 'resource', status: 'open', owner: 'member:root', eventSeq: 4 } });
    initializeBorrowPolicy(s, teamId, 'v1');
    assert.deepEqual(s.version(), BORROW_STORE_VERSION);

    const batch = seedRows(s, {
      'decision:open': { kind: 'coordination', state: 'open', subject: { id: 'thread:issue-1', deliveryRef: 'thread-delivery:live-ref' }, evidenceRefs: [
        'decision:terminal-ref'] },
      'decision:terminal-ref': { kind: 'review', state: 'decided', evidenceRefs: ['thread-delivery:array-ref'] },
      'thread-delivery:array-ref': { state: 'visible', threadRef: 'thread:issue-1', seq: 2 },
      'thread-delivery:live-ref': { state: 'visible', threadRef: 'thread:issue-1', seq: 3 },
      'thread-delivery:orphan-1': { state: 'visible', threadRef: 'thread:issue-1', seq: 1 },
      'thread-delivery:orphan-2': { state: 'visible', threadRef: 'thread:issue-1', seq: 1 },
      'execution-outcome:orphan': { state: 'terminated', callIdentity: 'call-orphan' },
      'guard-audit:1': { at: 1, code: 'OK', ok: true },
      'guard-audit:2': { at: 2, code: 'OK', ok: true },
    }, op('evidence-batch'));

    entity(s, op('outbox-mint'), 'effect:mint', { minted: true }, { reduce: tx => {
      tx.outbox('effect:terminal', { kind: 'message', messageId: 'message:one' });
      tx.outbox('effect:pending', { kind: 'message', messageId: 'message:two' });
      return null; } });
    s.effect({ entityId: 'effect:terminal', teamId, actor: 'adapter', expectedRevision: s.read('effect:terminal')?.revision ?? 0,
      operationId: op('outbox-confirm'), payload: { status: 'confirmed' }, payloadHash: digest({ status: 'confirmed' }) },
      'effect:terminal', row => ({ ...row, status: 'confirmed' }));

    const heartbeats = [];
    for (let i = 0; i < 5; i++) heartbeats.push(entity(s, op('heartbeat-' + i), 'member:root',
      { role: 'root', desired: 'active', beat: i }));
    advanceCursor(s);

    const eventsBefore = s.events().length, headBefore = s.latestEventSeq();
    const digestOfHeartbeat = digest(heartbeats[0].receipt.result);

    const result = s.retainEvidence({ limits: { deliveries: 0, outcomes: 0, audits: 1, decisions: 1, outbox: 0,
      receipts: 2, events: 2 } });

    assert(s.read('thread-delivery:array-ref'), 'a delivery named by an array inside a retained decision must survive');
    assert(s.read('thread-delivery:live-ref'), 'a delivery named through an object reference must survive');
    assert(s.read('decision:terminal-ref'), 'a decided decision cited by an open one must survive');
    assert(s.read('decision:open'));
    assert.equal(s.read('thread-delivery:orphan-1'), null);
    assert.equal(s.read('thread-delivery:orphan-2'), null);
    assert.equal(s.read('guard-audit:1'), null);
    assert(s.read('guard-audit:2'));
    assert.equal(s.read('execution-outcome:orphan'), null);
    assert(s.read('thread:issue-1'));
    assert(s.read('member:root'));
    assert(result.compacted.entities >= 4);

    const archived = s.archivedEvidence();
    assert.equal(archived.length, result.archive.inserted);
    const summary = archived.find(row => row.kind === 'thread-delivery');
    assert(summary && summary.sourceId.startsWith('thread-delivery:') && summary.digest.length === 64);

    const effects = s.effects().map(row => row.id);
    assert.equal(effects.includes('effect:terminal'), false);
    assert.equal(effects.includes('effect:pending'), true);
    assert(archived.some(row => row.kind === 'outbox'));

    const eventsAfter = s.events();
    assert.equal(s.latestEventSeq(), headBefore);
    assert(eventsAfter.some(event => event.seq === 1));
    assert(eventsAfter.length < eventsBefore);
    assert.equal(eventsAfter.filter(event => event.entity === 'member:root').length, 1);
    assert.equal(result.floor.eventSeq, s.cursor('dispatch'));
    assert.equal(result.floor.source, 'reader-cursor');

    const replay = s.commit(heartbeats[0].command);
    assert.equal(replay.compacted.resultDigest, digestOfHeartbeat);
    assert.equal(replay.result, null);
    assert.deepEqual(s.commit(heartbeats[0].command), replay);
    assert.deepEqual(s.receiptOf(heartbeats[0].command).receipt, replay);
    const different = { role: 'root', desired: 'active', beat: 99 };
    assert.throws(() => s.commit({ ...heartbeats[0].command, payload: different, payloadHash: digest(different) }),
      error => error.code === 'ID_CONFLICT');

    initializeBorrowPolicy(s, teamId, 'v1');
    assert.equal(s.receiptOf(migration.command).receipt.compacted, undefined);
    assert(s.read(migration.migrationRef));

    const retention = s.storageStatus().authoritativeEvidenceRetention;
    assert.equal(retention.mode, 'reference-closure');
    assert.equal(retention.status, 'enforced');
    assert.equal(retention.runs, 1);
    assert(retention.last.compactable.entities > 0);
    assert(retention.compacted.entities >= 4 && retention.compacted.receipts > 0);
    assert(retention.archive.rows > 0 && retention.archive.limit === 512);
    assert.deepEqual(retention.pending.entities, 0);
  });
});

test('retention repeats: a second pass never recompresses a receipt', () => {
  const root = fresh();
  withStore(ControlStore, root, s => {
    seedRows(s, { 'member:root': { role: 'root', desired: 'active' } });
    const beats = [];
    for (let i = 0; i < 6; i++) beats.push(entity(s, op('repeat-' + i), 'member:root', { role: 'root', beat: i }));
    advanceCursor(s);
    const first = s.retainEvidence({ limits: { receipts: 1, deliveries: 0, events: 2 } });
    assert(first.compacted.receipts > 0, 'the first pass compacts old receipts');
    const sample = beats[0].command;
    const stored = s.receiptOf(sample).receipt;
    assert(stored.compacted, 'the sample receipt is compacted');
    const before = canonical(stored);
    // A second pass at a different time must not touch it: no new digest from result:null, no rewritten metadata.
    const second = s.retainEvidence({ now: now() + 999999, limits: { receipts: 1, deliveries: 0, events: 2 } });
    assert.equal(second.compacted.receipts, 0, 'already-compacted receipts are not compactable again');
    assert.equal(canonical(s.receiptOf(sample).receipt), before, 'the compacted receipt is byte-identical');
    assert.equal(s.receiptOf(sample).receipt.compacted.resultDigest, digest(beats[0].receipt.result));
    const third = s.retainEvidence({ limits: { receipts: 1, deliveries: 0, events: 2 } });
    assert.equal(third.compacted.receipts, 0);
    assert.equal(canonical(s.receiptOf(sample).receipt), before);
  });
});

test('retention closure: receipts, operation chains and unread events protect evidence', () => {
  const root = fresh();
  withStore(ControlStore, root, s => {
    seedRows(s, { 'member:root': { role: 'root', desired: 'active' } });
    // Terminal evidence that is old by the time the floor advances.
    for (const name of ['by-receipt', 'by-chain', 'by-event', 'orphan']) {
      entity(s, op('old-' + name), 'thread-delivery:' + name, { state: 'visible', threadRef: 'thread:closure' });
    }
    advanceCursor(s, op('closure-cursor'));
    // op-mid is NOT in the newest receipt window; only chain-head's result names it. op-mid's receipt names by-chain.
    entity(s, op('chain-mid'), 'thread-delivery:by-chain', { state: 'visible', threadRef: 'thread:closure' });
    const mid = s.read('thread-delivery:by-chain');
    const chainHead = entity(s, op('chain-head'), 'audit:chain', { at: 1 },
      { reduce: tx => { tx.put('audit:chain', { at: 1 }); return { ref: 'thread-delivery:by-receipt', next: op('chain-mid') }; } });
    // An unread journal event (above the floor) whose payload names by-event.
    entity(s, op('by-event-update'), 'thread-delivery:by-event', { state: 'visible', threadRef: 'thread:closure', touched: 1 });
    const result = s.retainEvidence({ limits: { deliveries: 0, receipts: 2, events: 4, audits: 0 } });
    assert(chainHead.receipt.result, 'the chain head returned a result');
    assert(s.read('thread-delivery:by-receipt'), 'evidence named only by a retained receipt must survive');
    assert(s.read('thread-delivery:by-chain'), 'operation -> operation -> entity must be walked to the fixed point');
    assert(s.read('thread-delivery:by-event'), 'evidence named only by an unread journal event must survive');
    assert.equal(s.read('thread-delivery:orphan'), null, 'unreferenced terminal evidence is still collected');
    assert(result.compacted.entities >= 1);
  });
});

test('retention archive: source identity, canonical digest and a verifiable chain', () => {
  const root = fresh();
  withStore(ControlStore, root, s => {
    seedRows(s, { 'member:root': { role: 'root', desired: 'active' } });
    const originals = new Map();
    for (let i = 0; i < 5; i++) {
      entity(s, op('arch-' + i), 'thread-delivery:arch-' + i, { state: 'visible', threadRef: 'thread:arch', index: i });
      originals.set('thread-delivery:arch-' + i, canonical(s.read('thread-delivery:arch-' + i)));
    }
    advanceCursor(s, op('arch-cursor'));
    // receipts: 0 so no retained receipt result names a delivery; otherwise the newest receipt protects the row it wrote.
    const result = s.retainEvidence({ limits: { deliveries: 0, receipts: 0, events: 0 } });
    assert(result.archive.inserted >= 5);
    const archived = s.archivedEvidence().filter(row => row.kind === 'thread-delivery');
    let previous = 'genesis';
    for (const row of archived) {
      // The digest is over the stored record, not over a scan position or the injected id column.
      assert.equal(row.digest, digest(JSON.parse(originals.get(row.sourceId))));
      assert.equal(row.prevChain, previous, 'each row links to the previous chain head');
      assert.equal(row.chainDigest, digest({ prev: previous, kind: row.kind, sourceId: row.sourceId, digest: row.digest }));
      assert.equal(canonical(row.summary).length <= 512, true);
      previous = row.chainDigest;
    }
    assert.equal(archived.length, 5);
  });
});

test('retention receipt bound: the compacted receipt is bounded by real UTF-8 bytes', () => {
  const root = fresh();
  withStore(ControlStore, root, s => {
    seedRows(s, { 'member:root': { role: 'root', desired: 'active' } });
    const longKey = '键'.repeat(40);
    const value = { 结果: '中文结果'.repeat(30), [longKey]: '值'.repeat(50), ['k' + 'x'.repeat(200)]: 1 };
    // The operation writes a terminal delivery: once its event is below the reader floor nothing names the receipt,
    // so it can compact. A live row would keep its newest event, and (blocking 1) that event keeps its operation.
    const wrote = entity(s, op('bound-0001'), 'thread-delivery:bounded', { state: 'visible', threadRef: 'thread:bounded' },
      { reduce: tx => { tx.put('thread-delivery:bounded', { state: 'visible', threadRef: 'thread:bounded' }); return value; } });
    advanceCursor(s, op('bound-cursor'));
    const result = s.retainEvidence({ limits: { receipts: 0, deliveries: 0, events: 0, receiptBytes: 400 } });
    const receipt = s.receiptOf(wrote.command)?.receipt;
    assert(receipt?.compacted, 'the receipt was compacted within the byte budget');
    assert(Buffer.byteLength(canonical(receipt), 'utf8') <= 400, 'the bound is UTF-8 bytes, not string length: ' + canonical(receipt).length);
    assert.equal(receipt.compacted.resultDigest, digest(value));
    assert.equal(receipt.compacted.resultKind, 'object');
    assert.equal(receipt.compacted.resultBytes, Buffer.byteLength(canonical(value), 'utf8'), 'result byte metadata uses actual UTF-8');
    assert(receipt.compacted.resultKeys.every(key => Buffer.byteLength(key, 'utf8') <= 64 * 3));
    assert(result.compacted.uncompactable === 0);
    // A fresh receipt that cannot fit an impossible budget is counted, not silently skipped or truncated.
    const fresh = entity(s, op('bound-0002'), 'thread-delivery:bounded-2', { state: 'visible', threadRef: 'thread:bounded' },
      { reduce: tx => { tx.put('thread-delivery:bounded-2', { state: 'visible', threadRef: 'thread:bounded' }); return value; } });
    advanceCursor(s, op('bound-cursor-2'));
    const tight = s.retainEvidence({ limits: { receipts: 0, deliveries: 0, events: 0, receiptBytes: 10 } });
    assert.equal(tight.compacted.receipts, 0);
    assert(tight.compacted.uncompactable >= 1, 'every receipt whose identity cannot fit the budget is reported');
    assert.equal(s.receiptOf(fresh.command).receipt.compacted, undefined, 'the impossible budget leaves the new receipt intact');
    assert.equal(s.receiptOf(wrote.command).receipt.compacted.version, 1, 'the earlier compacted receipt is untouched');
  });
});

test('retention archive window: the oldest summaries fold into one chain checkpoint', () => {
  const root = fresh();
  withStore(ControlStore, root, s => {
    seedRows(s, { 'member:root': { role: 'root', desired: 'active' } });
    for (let i = 0; i < 9; i++) entity(s, op('fold-' + i), 'thread-delivery:fold-' + i, { state: 'visible', threadRef: 'thread:fold' });
    advanceCursor(s, op('fold-cursor'));
    const result = s.retainEvidence({ limits: { deliveries: 0, receipts: 2, events: 0, archive: 3 } });
    assert(result.archive.folded > 0, 'the archive window folded its oldest rows');
    const rows = s.archivedEvidence();
    const checkpoint = rows.find(row => row.kind === 'checkpoint');
    const kept = rows.filter(row => row.kind !== 'checkpoint');
    assert(checkpoint, 'a single checkpoint carries the folded chain');
    assert.equal(checkpoint.summary.count, result.archive.folded);
    assert.equal(kept.length, 3);
    for (let i = 1; i < kept.length; i++) assert.equal(kept[i].prevChain, kept[i - 1].chainDigest);
    assert(s.storageStatus().authoritativeEvidenceRetention.archive.rows === 3);
  });
});

test('retention failure: the transaction rolls back, the original error code survives and the next pass works', () => {
  const root = fresh();
  withStore(ControlStore, root, s => {
    seedRows(s, { 'member:root': { role: 'root', desired: 'active' } });
    const deliveries = [];
    for (let i = 0; i < 12; i++) deliveries.push(entity(s, op('delivery-' + i), 'thread-delivery:' + i, { state: 'visible', threadRef: 'thread:x' }));
    const beats = [];
    for (let i = 0; i < 6; i++) beats.push(entity(s, op('heartbeat-' + i), 'member:root', { role: 'root', desired: 'active', beat: i }));
    advanceCursor(s, op('fault-cursor'));
    const sample = beats[0].command;
    const snapshot = () => canonical({ entities: s.list(), effects: s.effects(), events: s.events(),
      receipt: s.receiptOf(sample), archive: s.archivedEvidence() });
    const before = snapshot();
    const injected = Object.assign(Error('injected retention fault'), { code: 'EVIDENCE_RETENTION_ABORTED' });
    assert.throws(() => s.retainEvidence({ limits: { deliveries: 2, receipts: 1 },
      hooks: { beforeDelete: () => { throw injected; } } }),
      error => error === injected && error.code === 'EVIDENCE_RETENTION_ABORTED');
    assert.deepEqual(snapshot(), before, 'a failed pass changes no entity, event, effect, receipt or archive row');
    assert.equal(s.archivedEvidence().length, 0);
    assert.equal(s.receiptOf(sample).receipt.compacted, undefined);
    const ok = s.retainEvidence({ limits: { deliveries: 2, receipts: 1 } });
    assert(ok.archive.inserted > 0);
    assert(s.archivedEvidence().length === ok.archive.inserted);
    assert(s.receiptOf(sample).receipt.compacted, 'the older receipt is compacted in place, the newest one is kept whole');
  });
});

test('retention crash: a real process exit at each transaction cut point leaves a complete, resumable store', { timeout: 120000 }, async () => {
  const repo = fileURLToPath(new URL('../../..', import.meta.url));
  const worker = path.join(repo, 'packages/profiles/test-support/borrow-retention-crash.mjs');
  for (const point of ['beforeCommit', 'afterCommit']) {
    const root = fresh();
    const seeded = withStore(ControlStore, root, s => {
      seedRows(s, { 'member:root': { role: 'root', desired: 'active' } });
      for (let i = 0; i < 8; i++) entity(s, op('delivery-' + i), 'thread-delivery:' + i, { state: 'visible', threadRef: 'thread:crash' });
      const beats = [];
      for (let i = 0; i < 6; i++) beats.push(entity(s, op('heartbeat-' + i), 'member:root', { role: 'root', desired: 'active', beat: i }));
      advanceCursor(s, op('crash-cursor'));
      const sample = beats[0].command;
      return { rows: s.list().map(row => row.entityId).sort(), events: s.events().length, head: s.latestEventSeq(),
        receipt: canonical(s.receiptOf(sample)), sample, digestOf: digest(beats[0].receipt.result) };
    });
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'borrow-retention-crash-'));
    const pidFile = path.join(temp, 'worker.pid');
    const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp, BORROW_WORKER_PID_FILE: pidFile };
    delete env.NODE_TEST_CONTEXT;
    const result = await runControlled({ tempRoot: temp, file: worker, args: [], scriptArgs: [root, point],
      cwd: repo, env, timeoutMs: 60000, pidFiles: [pidFile] });
    assert.equal(result.status, 71, point + ': ' + result.stdout + result.stderr);
    assert.equal(fs.existsSync(temp), false);

    withStore(ControlStore, root, s => {
      if (point === 'beforeCommit') {
        assert.equal(s.archivedEvidence().length, 0);
        assert.deepEqual(s.list().map(row => row.entityId).sort(), seeded.rows);
        assert.equal(s.events().length, seeded.events);
        assert.equal(s.storageStatus().authoritativeEvidenceRetention.runs, 0);
        assert.equal(canonical(s.receiptOf(seeded.sample)), seeded.receipt, 'no receipt moved either');
      } else {
        assert(s.archivedEvidence().length > 0);
        assert.equal(s.read('thread-delivery:0'), null);
        assert.equal(s.latestEventSeq(), seeded.head);
        assert.equal(s.storageStatus().authoritativeEvidenceRetention.runs, 1);
        const receipt = s.receiptOf(seeded.sample).receipt;
        assert(receipt.compacted, 'the committed pass compacted receipts too');
        assert.equal(receipt.compacted.resultDigest, seeded.digestOf);
      }
      const before = s.archivedEvidence().length;
      const resumed = s.retainEvidence({ limits: { deliveries: 1, receipts: 2 } });
      assert.equal(s.archivedEvidence().length, before + resumed.archive.inserted);
      assert.equal(s.storageStatus().authoritativeEvidenceRetention.runs >= 1, true);
    });
  }
});

test('retention long run: authoritative evidence stays bounded and status reports the bound', () => {
  const root = fresh();
  withStore(ControlStore, root, s => {
    seedRows(s, { 'member:root': { role: 'root', desired: 'active' } });
    const commands = []; let commits = 1;
    const put = (operationId, entityId, payload, extra) => { commits += 1; const made = entity(s, operationId, entityId, payload, extra); commands.push(
      made.command); return made; };
    for (let round = 0; round < 80; round++) {
      put(op('delivery-' + round), 'thread-delivery:' + round, { state: 'visible', threadRef: 'thread:long', seq: round });
      put(op('outcome-' + round), 'execution-outcome:' + round, { state: 'terminated', callIdentity: 'call-' + round });
      put(op('audit-' + round), 'guard-audit:' + round, { at: round, code: 'OK', ok: true });
      put(op('decision-' + round), 'decision:' + round, { kind: 'review', state: 'decided' });
      put(op('beat-' + round), 'member:root', { role: 'root', desired: 'active', beat: round });
      if (round % 5 === 4) put(op('dispatch-' + round), 'cursor:dispatch', { at: round },
        { reduce: tx => { tx.put('cursor:dispatch', { at: round }); tx.cursor('dispatch', tx.latestEventSeq()); return null; } });
      if (round % 10 === 9) s.retainEvidence({ limits: { deliveries: 4, outcomes: 4, audits: 4, decisions: 4, outbox: 4, receipts: 8, events: 16 } });
    }
    const status = s.storageStatus(), retention = status.authoritativeEvidenceRetention, counts = status.counts;
    assert.equal(retention.status, 'enforced');
    assert(retention.runs >= 8);
    assert(retention.compacted.entities > 0 && retention.compacted.events > 0 && retention.compacted.receipts > 0);
    assert(counts.deliveries <= 4);
    assert(counts.outcomes <= 4);
    assert(counts.decisions <= 4);
    assert(counts.guardAudits <= 4);
    assert(counts.events <= counts.entities + 16 + 8);
    assert(counts.operations <= commits);
    assert(retention.archive.rows <= retention.archive.limit);
    assert(retention.floor.eventSeq > 0 && retention.floor.source === 'reader-cursor');
    assert.deepEqual(retention.pending.entities, 0);
    assert.equal(retention.pending.receipts, 0, 'no receipt stays compactable after a pass (and none is recompacted)');
    for (const index of [0, 7, 23]) {
      const replay = s.commit(commands[index]);
      assert(replay.compacted);
      assert.deepEqual(s.commit(commands[index]), replay);
    }
    const again = s.retainEvidence({ limits: { deliveries: 4, outcomes: 4, audits: 4, decisions: 4, outbox: 4, receipts: 8, events: 16 } });
    assert.equal(again.compacted.receipts, 0, 'a repeated pass compacts no receipt twice');
    assert.equal(counts.operations, commits);
  });
});

