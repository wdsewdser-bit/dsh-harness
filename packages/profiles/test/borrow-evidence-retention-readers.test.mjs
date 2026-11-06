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

test('retention timing: whole monotonic call and actual lock holding include hooks and COMMIT', () => {
  const root = fresh();
  const block = () => { const end = performance.now() + 15; while (performance.now() < end) {} };
  withStore(ControlStore, root, s => {
    seedRows(s, { 'member:root': { role: 'root' } });
    const begin = performance.now();
    const result = s.retainEvidence({ hooks: { beforeDelete: block, beforeCommit: block, afterCommit: block } });
    const elapsed = performance.now() - begin;
    assert(result.metrics.durationMs >= 45);
    assert(result.metrics.lockHeldMs >= 30);
    assert(result.metrics.durationMs - result.metrics.lockHeldMs >= 15);
    assert(result.metrics.durationMs <= elapsed);
    assert.equal(result.metrics.maxStallMs, result.metrics.durationMs);
    assert.deepEqual(s.storageStatus().authoritativeEvidenceRetention.last.metrics, result.metrics);
  });
});


test('retention readers: repeated same-position register and tx.cursor preserve timestamps and do not replan', () => {
  withStore(ControlStore, fresh(), s => {
    seedRows(s, { 'member:root': { role: 'root' } }, op('same-root'));
    s.registerReader('same', s.latestEventSeq()); s.retainEvidence();
    const before = s.readers().find(reader => reader.id === 'same');
    s.registerReader('same', before.seq);
    assert.deepEqual(s.readers().find(reader => reader.id === 'same'), before);
    assert.equal(s.retentionWorkPending(), false);
    entity(s, op('same-cursor'), 'metadata:test', {}, { reduce: tx => { tx.cursor('same', before.seq); return null; } });
    assert.deepEqual(s.readers().find(reader => reader.id === 'same'), before);
    assert.equal(s.retentionWorkPending(), false);
  });
});

test('retention migration: rollback and close errors never replace the original migration failure', () => {
  const root = fresh();
  const primary = Object.assign(Error('migration failed'), { code: 'PRIMARY_MIGRATION' });
  const rollback = Error('rollback cleanup'), close = Error('close cleanup');
  const exec = DatabaseSync.prototype.exec, originalClose = DatabaseSync.prototype.close;
  DatabaseSync.prototype.exec = function(sql) { if (sql === 'ROLLBACK') throw rollback; return exec.call(this, sql); };
  DatabaseSync.prototype.close = function() { originalClose.call(this); throw close; };
  try {
    assert.throws(() => new ControlStore(root, { beforeMigrationCommit: () => { throw primary; } }), error => {
      assert.equal(error, primary); assert.deepEqual(error.cleanupErrors, [rollback, close]); return true;
    });
  } finally { DatabaseSync.prototype.exec = exec; DatabaseSync.prototype.close = originalClose; }
  withStore(ControlStore, root, s => assert.equal(s.inTransaction(), false));
});


test('retention projection metadata: new messages do not scan historical events on the write path', () => {
  withStore(ControlStore, fresh(), s => {
    seedRows(s, { 'member:root': { role: 'root' } }, op('metadata-root'));
    const prepare = DatabaseSync.prototype.prepare; let historyScans = 0;
    DatabaseSync.prototype.prepare = function(sql) {
      if (sql === 'SELECT revision,payload FROM events WHERE entity=? ORDER BY seq') historyScans++;
      return prepare.call(this, sql);
    };
    try {
      entity(s, op('metadata-message'), 'message:new', { kind: 'info', stored: true });
      entity(s, op('metadata-update'), 'message:new', { kind: 'info', stored: true, visible: true });
      assert.equal(historyScans, 0, 'new and already-materialized message receipts use no full history query');
    } finally { DatabaseSync.prototype.prepare = prepare; }
  });
});


test('retention old schema: readonly status never writes; locked writable migration preserves cursor', () => {
  const root = fresh();
  withStore(ControlStore, root, s => { seedRows(s, { 'member:root': { role: 'root' } }); s.registerReader('legacy', 1); });
  const filename = path.join(root, 'state-v2/control.sqlite');
  const db = new DatabaseSync(filename);
  try { db.exec('ALTER TABLE cursors DROP COLUMN updatedAt'); } finally { db.close(); }
  const before = fs.readFileSync(filename), mtime = fs.statSync(filename).mtimeMs;
  const ro = ControlStore.openReadOnly(root);
  try {
    const reader = ro.storageStatus().authoritativeEvidenceRetention.readers.find(r => r.id === 'legacy');
    assert.equal(reader.seq, 1); assert.equal(reader.lastAdvancedAt, null);
  } finally { ro.close(); }
  assert.deepEqual(fs.readFileSync(filename), before);
  assert.equal(fs.statSync(filename).mtimeMs, mtime);
  withStore(ControlStore, root, s => {
    assert.equal(s.cursor('legacy'), 1);
    assert.equal(s.readers().find(r => r.id === 'legacy').lastAdvancedAt, null);
    s.registerReader('legacy', 1);
    assert.equal(s.readers().find(r => r.id === 'legacy').lastAdvancedAt, null, 'same-position legacy registration is not advancement');
    entity(s, op('legacy-upgrade-advance'), 'member:root', { role: 'root', desired: 'active' });
    s.registerReader('legacy', s.latestEventSeq());
    assert.equal(typeof s.readers().find(r => r.id === 'legacy').lastAdvancedAt, 'number');
  });
});


