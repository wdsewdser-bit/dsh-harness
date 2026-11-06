import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { real } from '../test-support/real.mjs';
import { waitFor } from '../test-support/helpers.mjs';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
import { createTeamHost, SessionRouter } from '../index.mjs';
import { createEvidenceMaintenance } from '../src/evidence-maintenance.mjs';
import { evidenceSnapshot, assertEvidenceBatch } from '../test-support/retention-graph.mjs';

/**
 * Gap 1, blocking review 4: a long-running host never restarts, so retention must run from the host's own maintenance
 * clock (driven by the commit backlog), coordinated with the lifecycle. This test writes through the real TeamCore and
 * a real ControlStore, never calls retainEvidence, and waits for the host to collect the evidence by itself.
 */
test('evidence retention runs from the host maintenance clock, without a restart or a manual pass', { timeout: 60000 }, async () => {
  const w = await real({ evidenceRetentionCommitThreshold: 4, evidenceMaintenanceIntervalMs: 10,
    evidenceRetentionLimits: { deliveries: 1, receipts: 2, events: 8 } });
  try {
    // Continuous writes through the real command path: terminal evidence, old journal versions and a reader floor.
    for (let i = 0; i < 6; i++) {
      w.core.mutate('thread-delivery:m' + i, 'adapter', { i }, tx => tx.put('thread-delivery:m' + i,
        { state: 'visible', threadRef: 'thread:m', index: i }));
    }
    w.core.mutate('cursor:m', 'adapter', { at: 1 }, tx => {
      const seq = w.store.latestEventSeq();
      tx.put('cursor:m', { at: 1 }); tx.cursor('dispatch', seq); return null;
    });
    for (let i = 0; i < 5; i++) {
      w.core.mutate('member:root', 'adapter', { beat: i }, tx => tx.put('member:root',
        { role: 'root', desired: 'active', beat: i }));
    }
    await waitFor(() => (w.host.status().evidenceRetention?.runs ?? 0) >= 1, 'host-driven evidence retention');
    const maintenance = w.host.status().evidenceRetention;
    assert(maintenance.runs >= 1, 'the host ran a bounded pass by itself');
    assert.equal(maintenance.lastError, null);
    assert(maintenance.backlog < maintenance.threshold, 'a successful pass clears the backlog');
    const storage = w.store.storageStatus().authoritativeEvidenceRetention;
    assert(storage.runs >= 1);
    assert(storage.status === 'enforced');
    assert(w.store.archivedEvidence().length > 0, 'terminal evidence was collected by the host, not by the test');
    assert(w.store.latestEventSeq() > 0);
  } finally { await w.close(); }
});
/**
 * The product default is on: a host configured with nothing at all must still converge. This writes 600 terminal
 * deliveries through the real command path, never calls retainEvidence, and waits for the host's own maintenance
 * clock to bring the class back inside the default window.
 */
test('evidence retention is on by default: an unconfigured host converges without a restart', { timeout: 120000 }, async () => {
  // This long-running host needs a real owner routing identity; maintenance settings remain entirely at defaults.
  const router = new SessionRouter();
  const w = await real({ router, ownerSessionId: 'session:retention-default' });
  const retain = w.store.retainEvidence.bind(w.store);
  w.store.retainEvidence = options => {
    const before = evidenceSnapshot(w.root);
    const result = retain(options);
    assertEvidenceBatch(before, evidenceSnapshot(w.root));
    return result;
  };
  try {
    assert.equal(router.routeOwner('session:retention-default').routed, true);
    assert.deepEqual(router.teamSessions('team:b').executions, [], 'heartbeat has a registered team even without native executions');
    for (let i = 0; i < 1200; i++) {
      w.core.mutate('thread-delivery:d' + i, 'adapter', { i }, tx => tx.put('thread-delivery:d' + i,
        { state: 'visible', threadRef: 'thread:d', index: i }));
    }
    // The team's own dispatch reader moves past the batch, which is the real precondition for collecting history.
    w.core.mutate('cursor:m', 'adapter', { at: 1 }, tx => {
      const seq = tx.latestEventSeq();
      tx.put('cursor:m', { at: 1 }); tx.cursor('dispatch', seq); return null;
    });
    await waitFor(() => (w.host.status().evidenceRetention?.runs ?? 0) >= 1, 'default host-driven evidence retention', 3000);
    const maintenance = w.host.status().evidenceRetention;
    assert(maintenance, 'the default host arms the maintenance clock');
    assert.equal(maintenance.threshold, 256, 'the product default threshold is in force');
    assert(maintenance.runs >= 1, 'the host collected evidence by itself');
    assert.equal(maintenance.lastError, null);
    const storage = w.store.storageStatus().authoritativeEvidenceRetention;
    assert(storage.runs >= 1);
    assert.equal(storage.status, 'enforced');
    // One pass applies its write budget and reports the rest as deferred. Full-store scan/lock time is NOT bounded by it.
    const first = w.store.list('thread-delivery:').length;
    assert.equal(first, 1200 - storage.last.budget.archive, 'one pass archives exactly its budget');
    assert(storage.last.deferred.entities > 0, 'the remainder is reported, not dropped');
    assert(storage.last.metrics.maxStallMs >= 0 && storage.last.metrics.scanRows > 0, 'the pass reports its cost');
    assert(w.store.archivedEvidence().length > 0);
    assert.equal(w.store.commitsSinceRetention(), 0, 'new-commit backlog is separate from pending work');
    assert(w.store.retentionWorkPending(), 'unfinished work is durable, despite the zero new-commit backlog');
    // No more writes: the host must schedule its own continuation, even below the new-commit threshold.
    await assert.doesNotReject(() => waitFor(() => (w.host.status().evidenceRetention?.runs ?? 0) >= 2 && !w.store.retentionWorkPending(),
      'silent automatic convergence', 500), 'pending work must converge without another write');
    assert(w.store.list('thread-delivery:').length < first, 'the second pass moved the same class further down');
    assert.equal(w.store.storageStatus().authoritativeEvidenceRetention.runs >= 2, true);
  } finally { await w.close(); }
});
test('evidence maintenance: a failed pass keeps its code, backs off and retries without new writes', { timeout: 60000 }, async () => {
  const w = await real({ evidenceRetentionCommitThreshold: 4, evidenceMaintenanceIntervalMs: 10, evidenceMaintenanceBackoffMs: 30 });
  try {
    const original = w.store.retainEvidence.bind(w.store);
    let calls = 0;
    const injected = Object.assign(Error('injected maintenance fault'), { code: 'EVIDENCE_RETENTION_ABORTED' });
    w.store.retainEvidence = (...args) => { calls += 1; if (calls === 1) throw injected; return original(...args); };
    for (let i = 0; i < 6; i++) w.core.mutate('thread-delivery:f' + i, 'adapter', {}, tx => tx.put('thread-delivery:f' + i,
      { state: 'visible', threadRef: 'thread:f' }));
    await waitFor(() => w.host.status().evidenceRetention?.lastError?.code === 'EVIDENCE_RETENTION_ABORTED', 'recorded failure');
    assert(w.store.commitsSinceRetention() >= 4, 'a rolled-back pass leaves the backlog for a retry');
    // No new write happens here: the retry comes from the durable backlog and the backoff clock alone.
    w.at += 1000;
    await waitFor(() => (w.host.status().evidenceRetention?.runs ?? 0) >= 1, 'retry after backoff');
    assert.equal(w.host.status().evidenceRetention.lastError, null);
    assert(calls >= 2, 'the same backlog was retried');
  } finally { await w.close(); }
});

test('evidence maintenance: an open transaction and a stopped loop skip the tick', async () => {
  const w = await real({});
  try {
    for (let i = 0; i < 5; i++) w.core.mutate('thread-delivery:t' + i, 'adapter', {}, tx => tx.put('thread-delivery:t' + i,
      { state: 'visible', threadRef: 'thread:t' }));
    const clock = { now: () => Date.now(), every: () => () => {} };
    const maintenance = createEvidenceMaintenance({ store: w.store, clock, threshold: 1, intervalMs: 10 });
    const inTransaction = w.store.inTransaction;
    w.store.inTransaction = () => true;
    const skipped = maintenance.tick();
    assert.equal(skipped.runs, 0, 'never plans inside a caller transaction');
    assert.equal(skipped.skipped >= 1, true);
    w.store.inTransaction = inTransaction;
    assert.equal(maintenance.tick().runs, 1);
    maintenance.stop();
    assert.equal(maintenance.status().stopped, true);
    assert.equal(maintenance.tick().runs, 1, 'a stopped loop never runs again');
  } finally { await w.close(); }
});

test('evidence maintenance: the backlog accumulates across restarts', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-restart-'));
  const boot = () => {
    const store = new ControlStore(dir);
    const at = Date.now();
    const core = new TeamCore(store, {}, { enabled: true, attach: true, teamId: 'team:b', now: () => at });
    const host = createTeamHost({ root: dir, teamId: 'team:b', core, now: () => at, cycleIntervalMs: 1000000,
      recoverer: async () => ({ status: 'ok', admission: true }), openStore: () => ({ close() {} }),
      evidenceMaintenanceIntervalMs: 10 });
    return { store, core, host };
  };
  try {
    const first = boot();
    await first.host.start();
    for (let i = 0; i < 200; i++) first.core.mutate('thread-delivery:a' + i, 'adapter', { i },
      tx => tx.put('thread-delivery:a' + i, { state: 'visible', threadRef: 'thread:a' }));
    assert.equal(first.store.commitsSinceRetention(), 200);
    await first.host.stop();
    first.store.close();
    // A new process image on the same store: the backlog written by the previous one is still there.
    const second = boot();
    await second.host.start();
    assert.equal(second.store.commitsSinceRetention(), 200, 'the backlog survives the restart');
    assert.equal(second.host.status().evidenceRetention?.runs ?? 0, 0, 'below the threshold nothing runs yet');
    for (let i = 0; i < 60; i++) second.core.mutate('thread-delivery:b' + i, 'adapter', { i },
      tx => tx.put('thread-delivery:b' + i, { state: 'visible', threadRef: 'thread:b' }));
    await waitFor(() => (second.host.status().evidenceRetention?.runs ?? 0) >= 1, 'cross-restart backlog crosses the threshold');
    await second.host.stop();
    second.store.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('evidence maintenance: unfinished batches resume after restart with zero new commits', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-pending-'));
  let active = null;
  const boot = async interval => {
    const store = new ControlStore(dir);
    const core = new TeamCore(store, {}, { enabled: true, attach: true, teamId: 'team:b' });
    const host = createTeamHost({ root: dir, teamId: 'team:b', core, cycleIntervalMs: 1000000,
      recoverer: async () => ({ status: 'ok', admission: true }), openStore: () => ({ close() {} }),
      evidenceMaintenanceIntervalMs: interval });
    active = { store, core, host };
    await host.start();
    return active;
  };
  try {
    const first = await boot(1000);
    for (let i = 0; i < 1200; i++) first.core.mutate('thread-delivery:p' + i, 'adapter', { i },
      tx => tx.put('thread-delivery:p' + i, { state: 'visible' }));
    first.store.registerReader('audit', first.store.latestEventSeq());
    await waitFor(() => first.host.status().evidenceRetention.runs >= 1, 'first bounded pass', 3000);
    assert(first.store.retentionWorkPending());
    assert.equal(first.store.commitsSinceRetention(), 0);
    const count = first.store.list('thread-delivery:').length;
    await first.host.stop(); first.store.close(); active = null;
    const second = await boot(10);
    assert.equal(second.store.commitsSinceRetention(), 0);
    assert(second.store.retentionWorkPending(), 'pending is not process-local');
    await waitFor(() => second.host.status().evidenceRetention.runs >= 1 && !second.store.retentionWorkPending(),
      'restart continuation without new writes', 500);
    assert(second.store.list('thread-delivery:').length < count);
    assert.equal(second.host.status().evidenceRetention.lastError, null);
  } finally {
    if (active) { await active.host.stop(); active.store.close(); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('evidence maintenance: reader advancement and retirement replan without any new operations', { timeout: 60000 }, async () => {
  const w = await real({ evidenceRetentionCommitThreshold: 4, evidenceMaintenanceIntervalMs: 10,
    evidenceRetentionLimits: { deliveries: 0, receipts: 0, events: 0 } });
  try {
    w.store.registerReader('audit', 0);
    for (let i = 0; i < 20; i++) w.core.mutate('thread-delivery:r' + i, 'adapter', { i },
      tx => tx.put('thread-delivery:r' + i, { state: 'visible' }));
    const seq = w.store.latestEventSeq();
    await waitFor(() => w.host.status().evidenceRetention.runs >= 1 && !w.store.retentionWorkPending(), 'pinned planning');
    assert.equal(w.store.commitsSinceRetention(), 0);
    assert.equal(w.store.list('thread-delivery:').length, 20);
    const firstRuns = w.host.status().evidenceRetention.runs;
    w.store.registerReader('audit', Math.floor(seq / 2));
    await waitFor(() => w.host.status().evidenceRetention.runs > firstRuns && !w.store.retentionWorkPending(), 'reader advancement replan');
    const partiallyKept = w.store.list('thread-delivery:').length;
    assert(partiallyKept < 20 && partiallyKept > 1);
    assert.equal(w.store.commitsSinceRetention(), 0);
    const nextRuns = w.host.status().evidenceRetention.runs;
    w.store.retireReader('audit');
    await waitFor(() => w.host.status().evidenceRetention.runs > nextRuns && !w.store.retentionWorkPending(), 'reader retirement replan');
    assert(w.store.list('thread-delivery:').length < partiallyKept);
    assert.equal(w.host.status().evidenceRetention.lastError, null);
  } finally { await w.close(); }
});


test('evidence maintenance: persisted pending dispatch does not require new commits and stops when pending is drained', () => {
  // Isolate the dispatch rule from unrelated host heartbeat timers: restart/backlog durability has separate real-store tests.
  let at = 0, onTick = null, pending = true, passes = 0;
  const clock = { now: () => at, every(interval, work) { assert.equal(interval, 1000); onTick = work; return () => {}; } };
  const store = { commitsSinceRetention: () => 0, retentionWorkPending: () => pending, inTransaction: () => false,
    retainEvidence() { passes++; if (passes === 2) pending = false; }, setRetentionMaintenance() {} };
  const maintenance = createEvidenceMaintenance({ store, clock, threshold: 256 });
  try {
    maintenance.arm();
    for (let i = 0; i < 2; i++) { at += 1000; onTick(); }
    assert.equal(passes, 2, 'clock-driven pending work must run even with zero newly committed operations');
    assert.equal(maintenance.status().runs, 2); assert.equal(maintenance.status().backlog, 0);
    assert.equal(maintenance.status().lastError, null); assert.equal(pending, false);
    at += 1000; onTick();
    assert.equal(passes, 2, 'a drained pending flag must not create an unconditional maintenance loop');
  } finally { maintenance.stop(); }
});

