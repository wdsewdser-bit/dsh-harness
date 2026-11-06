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

export const dirs = [];
export const fresh = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'borrow-retention-')); dirs.push(root); return root; };
export const teamId = 'team:retention';
test.after(() => cleanupOrThrow(dirs));

/** Per-file sha256 of an isolated source tree, and the files that differ between two of them. */
export const manifestOf = root => { const out = new Map();
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile()) out.set(path.relative(root, full).split(path.sep).join('/'),
      createHash('sha256').update(fs.readFileSync(full)).digest('hex')); } };
  walk(root); return out; };
export const drift = (before, after) => [...new Set([...before.keys(), ...after.keys()])]
  .filter(file => before.get(file) !== after.get(file)).sort();
export const op = name => 'v1:operation:retention-' + name;
export let clock = 0;
export const now = () => 1800000000000 + (++clock);

export function entity(store, operationId, entityId, payload, { reduce = null } = {}) {
  const command = { entityId, teamId, actor: 'adapter', expectedRevision: store.read(entityId)?.revision ?? 0,
    operationId, payload, payloadHash: digest(payload) };
  return { command, receipt: store.commit(command, reduce ?? (tx => tx.put(entityId, payload))) };
}
export function seedRows(store, rows, operationId = op('seed')) {
  return entity(store, operationId, 'seed:batch', { rows: Object.keys(rows).sort() },
    { reduce: tx => { for (const [id, row] of Object.entries(rows)) tx.put(id, row); return null; } });
}
export function advanceCursor(store, operationId = op('cursor')) {
  return entity(store, operationId, 'cursor:dispatch', { seq: store.latestEventSeq() },
    { reduce: tx => { const seq = tx.latestEventSeq(); tx.put('cursor:dispatch', { at: 1 }); tx.cursor('dispatch', seq); return null; } });
}

export const SUMMARY_KEYS = ['version', 'from', 'to', 'reason', 'cutoffSeq', 'externalStopProof', 'archived', 'hostStopped', 'admissionStopped'];
export const summaryValue = row => Object.fromEntries(SUMMARY_KEYS.map(key => [key, row[key]]));
/** The durable shape the real migration writes (summary + reader floor + policy + authenticated receipt). */
export function writeMigration(store, operationId, reason = 'retention acceptance') {
  const policyId = 'team-policy:' + teamId, migrationRef = 'borrow-migration:' + operationId;
  const payload = { to: 'v1', reason };
  const command = { entityId: policyId, teamId, actor: 'adapter', expectedRevision: store.read(policyId)?.revision ?? 0,
    operationId, payload, payloadHash: digest(payload) };
  const receipt = store.commit(command, tx => {
    const summary = { version: 1, from: 'off', to: 'v1', reason, cutoffSeq: tx.latestEventSeq(),
      externalStopProof: 'external:verified-stop', archived: [], hostStopped: true, admissionStopped: true };
    tx.requireBorrowReader();
    tx.put(migrationRef, summary);
    tx.put(policyId, teamPolicyRow(teamId, { superagentBorrow: 'v1', activatedAt: new Date(now()).toISOString(), migrationRef }));
    return { migrationRef, from: 'off', to: 'v1', archived: 0, summaryDigest: digest(summaryValue(summary)) };
  });
  return { command, receipt, migrationRef, operationId };
}

