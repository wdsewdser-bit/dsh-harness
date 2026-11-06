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

test('retention contention: two real processes either apply atomically or fail closed', { timeout: 120000 }, async () => {
  const repo = fileURLToPath(new URL('../../..', import.meta.url));
  const worker = path.join(repo, 'packages/profiles/test-support/borrow-retention-worker.mjs');
  const root = fresh();
  withStore(ControlStore, root, s => {
    seedRows(s, { 'member:root': { role: 'root', desired: 'active' } });
    for (let i = 0; i < 10; i++) entity(s, op('contend-' + i), 'thread-delivery:' + i, { state: 'visible', threadRef: 'thread:c' });
    advanceCursor(s, op('contend-cursor'));
  });
  // Two openers race the same old-schema upgrade. Both must recheck ALTER under the migration lock.
  const oldSchema = new DatabaseSync(path.join(root, 'state-v2/control.sqlite'));
  try { oldSchema.exec('ALTER TABLE cursors DROP COLUMN updatedAt'); } finally { oldSchema.close(); }
  const runOne = async label => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'borrow-retention-contend-'));
    const pidFile = path.join(temp, 'worker.pid');
    const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp, BORROW_WORKER_PID_FILE: pidFile };
    delete env.NODE_TEST_CONTEXT;
    const result = await runControlled({ tempRoot: temp, file: worker, args: [], scriptArgs: [root, label], cwd: repo, env,
      timeoutMs: 60000, pidFiles: [pidFile] });
    assert.equal(fs.existsSync(temp), false, 'the worker temp root is removed');
    return { result, temp };
  };
  const [a, b] = await Promise.all([runOne('a'), runOne('b')]);
  for (const { result } of [a, b]) {
    assert.equal(result.terminated, true, 'both workers exited');
    assert([0, 3].includes(result.status), 'worker status: ' + result.status + ' ' + result.stdout + result.stderr);
    const line = result.stdout.trim().split('\n').filter(Boolean).at(-1);
    if (result.status === 3) {
      const parsed = JSON.parse(line);
      assert.equal(parsed.ok, false);
      assert.match(parsed.code, /SQLITE_BUSY|RETENTION_INVARIANT|ERROR/, 'a losing pass reports its own failure');
    }
  }
  withStore(ControlStore, root, s => {
    assert(s.cursor('dispatch') > 0, 'concurrent schema upgrade preserves the old cursor');
    const archived = s.archivedEvidence();
    assert.equal(new Set(archived.map(row => row.sourceId)).size, archived.length, 'no evidence is archived twice');
    const consistency = s.retainEvidence({ limits: { deliveries: 1, receipts: 2 } });
    // The retention window keeps the newest delivery; every other one is archived exactly once, by one process.
    const remaining = s.list('thread-delivery:').length;
    assert.equal(archived.length + consistency.archive.inserted + remaining, 10);
    assert.equal(archived.length, 9);
    assert.equal(s.storageStatus().authoritativeEvidenceRetention.archive.rows, 9);
  });
});

test('evidence mutants: closure, replay, atomicity, error preservation, repeats, receipts and FIFO are killed', { timeout: 600000 }, async () => {
  const repo = fileURLToPath(new URL('../../..', import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'borrow-retention-mut-'));
  dirs.push(root);
  fs.cpSync(path.join(repo, 'packages'), path.join(root, 'packages'),
    { recursive: true, filter: source => !['node_modules', '.scratch'].includes(path.basename(source)) });
  fs.mkdirSync(path.join(root, 'runs'));
  // The build roots are configuration (build/builds.json); a source copy must carry it, or buildTarget() cannot name
  // the pristine install the adapter composes.
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'build', 'builds.json'), path.join(root, 'build', 'builds.json'));
  const run = async (pattern = '^retention|drain order|^evidence retention is on by default|^evidence maintenance: persisted pending dispatch') => {
    const temp = fs.mkdtempSync(path.join(root, 'run-tmp-'));
    const env = { ...process.env, DSH_UPSTREAM_BUILD: buildTarget().build, TEMP: temp, TMP: temp, TMPDIR: temp, FORCE_COLOR: '0' };
    delete env.NODE_TEST_CONTEXT;
    const result = await runControlled({ tempRoot: temp,
      file: 'packages/profiles/test/borrow-evidence-retention.test.mjs',
      args: ['--test', '--test-concurrency=1', '--test-reporter=tap',
        '--test-name-pattern=' + pattern,
        'packages/core/test/ready-order.test.mjs', 'packages/host/test/evidence-maintenance.test.mjs',
        'packages/profiles/test/borrow-projection-retention.test.mjs', 'packages/profiles/test/borrow-projection-lifecycle.test.mjs',
        'packages/profiles/test/borrow-evidence-retention-readers.test.mjs',
        'packages/profiles/test/borrow-evidence-retention-mutants.test.mjs',
        'packages/host/test/projection-maintenance-status.test.mjs'],
      cwd: root, env, idleTimeoutMs: 120000, timeoutMs: 540000 });
    assert.equal(fs.existsSync(temp), false);
    // No verdict here: a stalled or capped first run must reach runMutant(), which is the only place that may retry it.
    // The baseline and the final mutant verdict assert stalled/timedOut/terminated themselves.
    return result;
  };
  const baselineFiles = manifestOf(path.join(root, 'packages'));
  const baseline = await run();
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  assert.match(baseline.stdout, /# pass [1-9]\d*/);
  assert.match(baseline.stdout, /# fail 0/);
  assert.equal(baseline.stalled ?? false, false, 'the baseline made no progress: ' + baseline.stopReason);
  assert.equal(baseline.timedOut ?? false, false, 'the baseline hit its 540s hard cap: ' + baseline.stopReason);
  assert.equal(baseline.terminated, true, 'the baseline tree was not confirmed gone');
  const mutants = [
    ['packages/store/retention.mjs',
      'if (Array.isArray(value)) { for (const item of value) visit(item); return; }', 'if (Array.isArray(value)) { return; }'],
    ['packages/store/index.mjs',
      "if (previous.hash !== identity) fail('ID_CONFLICT');", '/* mutant: replay ignores identity */'],
    ['packages/store/index.mjs', 'hooks.beforeDelete?.({ plan });',
      "this.#db.exec('COMMIT'); hooks.beforeDelete?.({ plan }); this.#db.exec('BEGIN IMMEDIATE');"],
    ['packages/store/index.mjs', '      throw error;\n    }\n  }\n  /**\n   * Commits completed since',
      '      return { skipped: true };\n    }\n  }\n  /**\n   * Commits completed since'],
    // Recompression needs both guards removed: the planner's skip and the helper's own null on an already-compacted receipt.
    [{ file: 'packages/store/retention.mjs',
      oldText: "    if (row.receipt?.compacted) continue; // never recompress: the original result digest is not recoverable",
      newText: '    /* mutant: recompress already compacted receipts */' },
     { file: 'packages/store/retention.mjs',
      oldText: '  if (!receipt || receipt.compacted) return null;', newText: '  if (!receipt) return null;' }],
    ['packages/store/retention.mjs',
      "      else if (type === 'operation') { const row = operationById.get(id); if (row) walk(row.receipt); }",
      "      else if (type === 'operation') { /* mutant: receipts are never walked */ }"],
    // Blocking 2: legacy rows keep no recovered position and fall back to created-at milliseconds, a different unit
    // from the journal seq a new task writes.
    [{ file: 'packages/core/runtime.mjs', oldText: '    backfillReadyOrder(core);\n',
      newText: '    /* mutant: legacy rows keep no queue position */\n' },
     { file: 'packages/core/runtime.mjs',
      oldText:
        "      if(!Number.isSafeInteger(row?.readySeq))fail('READY_ORDER_UNRECOVERABLE', 'ready task without "+
        "a queue position: '+id);\n      return row.readySeq;",
      newText: "      if(!Number.isSafeInteger(row?.readySeq))return typeof row?.createdAt==='number'?row.createdAt:Infinity;\n      return row.readySeq;" }],
    // Blocking 1: a retained event stops naming the operation that produced it.
    ['packages/store/retention.mjs', 'reference(event.operationId); walk(event.payload);', 'walk(event.payload);'],
    // Blocking 3: the backlog base is written and committed before the pass can fail, so a rollback loses it.
    ['packages/store/index.mjs',
      "      const backlogBase = Number(this.#db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM operations').get().n);",
      "      this.#db.prepare('INSERT OR REPLACE INTO retention_state VALUES(?,?)').run('borrow-evidence-re"+
        "tention', canonical({ ...prior, backlogBase: Number(this.#db.prepare('SELECT COALESCE(MAX(rowid), 0)"+
        " AS n FROM operations').get().n) }));\n      this.#db.exec('COMMIT'); this.#db.exec('BEGIN IMMEDIATE'"+
        ");\n      const backlogBase = Number(this.#db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM opera"+"tions').get().n);"],
    ['packages/store/retention.mjs', "Buffer.byteLength(canonical(value), 'utf8')", 'canonical(value).length'],
    ['packages/store/retention.mjs', 'const picked = (type, id) => selected.has(key(type, id));',
      "const picked = (type, id) => type === 'entity' ? candidateEntities.indexOf(id) < bud.archive : type "+
        "=== 'outbox' ? candidateOutbox.indexOf(id) < Math.max(0, bud.archive - candidateEntities.length) : t"+
        "ype === 'operation' ? allCompact.findIndex(r => r.operationId === id) < bud.compact : allDeleteEvent"+"s.indexOf(id) < bud.events;"],
    ['packages/core/runtime.mjs', '        entry = event;', '        if (!entry) entry = event;'],
    ['packages/host/src/evidence-maintenance.mjs', 'backlog() < threshold && !store.retentionWorkPending?.()', 'backlog() < threshold'],
    ['packages/projections/index.mjs', 'if (this.managed && (checkpointEpoch !== this.epoch || after < this.baseSeq))',
      'if (this.managed && checkpointEpoch !== this.epoch)'],
    ['packages/profiles/projections-plugin.mjs',
      '    try { await dispose(); } catch (failure) { error.cleanupErrors = [...(error.cleanupErrors ?? []), failure]; }',
      '    /* mutant: leave the failed service reader and transport alive */'],
    ['packages/projections/index.mjs', "      if (event.seq !== this.seq + 1) throw Error('EVENT_GAP');",
      "      if (event.seq !== this.seq + 1) throw Error('EVENT_GAP');\n      if (this.managed) this.reader."+
      "advance(event.seq); // mutant: acknowledge before successful application"],
  ];
  for (const mutant of mutants) {
    // A mutant is one edit or a coordinated set of edits (a defect that needs two guards removed at once).
    const raw = Array.isArray(mutant) && typeof mutant[0] === 'string' ? [mutant] : mutant;
    const edits = raw.map(item => Array.isArray(item) ? { file: item[0], oldText: item[1], newText: item[2] } : item);
    const originals = new Map(), working = new Map();
    for (const edit of edits) {
      const target = path.join(root, edit.file);
      if (!originals.has(edit.file)) { const source = fs.readFileSync(target, 'utf8'); originals.set(edit.file, source); working.set(edit.file, source); }
      const current = working.get(edit.file);
      assert.equal(current.split(edit.oldText).length, 2, 'exactly one mutant anchor in ' + edit.file + ': ' + edit.oldText.slice(0, 80));
      working.set(edit.file, current.replace(edit.oldText, edit.newText));
      fs.writeFileSync(target, working.get(edit.file));
    }
    let attempt;
    try {
      // Run the behavioral proof of this defect, not unrelated host recovery under a deliberately broken store.
      const source = edits.map(e => e.oldText).join(' ');
      const pattern = source.includes('never recompress') ? '^retention repeats'
        : source.includes('Buffer.byteLength') ? '^retention receipt bound'
        : source.includes('const picked') ? '^retention batch'
        : source.includes('entry = event') ? 'drain order'
        : source.includes('backlog() < threshold') ? '^evidence maintenance: persisted pending dispatch'
        : source.includes('after < this.baseSeq') ? '^retention projection'
        : source.includes('await dispose()') ? '^retention projection lifecycle: initialization'
        : source.includes('event.seq !==') ? '^retention projection lifecycle: (tail|advance)'
        : '^retention|drain order';
      // Only an identified infrastructure failure is retried (spawn EBUSY, stalled, killed by signal). A first run that
      // exits 0 is a survivor and is judged immediately; NOT_ROUTED and assertion/import failures are never retried.
      attempt = await runMutant(() => run(pattern), { maxAttempts: 2 });
    }
    finally { for (const [file, original] of originals) fs.writeFileSync(path.join(root, file), original); }
    const result = attempt.result;
    const text = result.stdout + result.stderr;
    const label = edits.map(edit => edit.oldText.slice(0, 60)).join(' + ');
    const evidence = ' (' + attempt.evidence + ')';
    console.log('evidence mutation result: ' + label + '; ' + attempt.evidence);
    assert.equal(result.signal, null, label + evidence + '\n' + text.slice(-4000));
    assert.equal(result.error, null, label + evidence + '\n' + text.slice(-4000));
    assert.equal(result.terminated, true, 'the controlled tree was not confirmed gone: ' + label + evidence);
    assert.equal(result.stalled ?? false, false, 'the mutant run stalled: ' + label + evidence);
    assert.equal(result.timedOut ?? false, false, 'the mutant run hit its hard cap: ' + label + evidence);
    assert.equal(attempt.history[0].status === 0, false,
      'the first run already survived; retrying would launder it: ' + label + '\n' + (attempt.history[0].stdout + attempt.history[0].stderr).slice(-4000));
    assert.equal(result.status, 1, 'mutant must exit through a behavioral failure: ' + label + evidence +
      (attempt.retried ? '\nfirst run:\n' + firstRunTail(attempt.history[0]) : '') + '\n' + text.slice(-1500));
    assert.match(text, /ERR_ASSERTION/, label + evidence);
    assert.doesNotMatch(text, /SyntaxError|ERR_MODULE_NOT_FOUND|does not provide an export/);
  }
  // The sha256 manifest proves that the SOURCE is restored to the bytes that produced the green baseline; it is not a
  // second run and does not prove the run is green. It holds because the build stays external (build/builds.json names
  // the pristine install and the copy carries the same file), the isolated runs/ directory is never written by a
  // mutation run, and the environment (DSH_UPSTREAM_BUILD, TEMP/TMP/TMPDIR inside the copy) is the same for baseline
  // and mutants. A drift names every file that was not restored.
  const restoredFiles = manifestOf(path.join(root, 'packages'));
  const changed = drift(baselineFiles, restoredFiles);
  assert.deepEqual(changed, [], 'the source was not restored to the baseline bytes: ' +
    changed.slice(0, 5).join(', '));
  assert.equal(restoredFiles.size, baselineFiles.size, 'the restored source keeps every baseline file');
  console.log('evidence mutants: ' + mutants.length + '/' + mutants.length +
    ' killed; nonzero green baseline; source restored: the tree is byte-identical to the ' +
    baselineFiles.size + '-file baseline (same external build, runs/ and environment), so its evidence is reused');
});
/**
 * Should-fix review 2 #2: a large store is collected in bounded slices. The closure is still computed over the whole
 * store (that is what makes a capped pass safe), but each pass archives at most its budget, reports the remainder and
 * publishes what it cost: duration, rows scanned, lock wait and the longest blocking segment.
 */
test('retention stress: a large store is collected in bounded slices with measured cost', { timeout: 180000 }, async () => {
  const w = await real({ evidenceMaintenanceIntervalMs: 10 });
  const s = w.store;
  try {
    seedRows(s, { 'member:root': { role: 'root', desired: 'active' } });
    for (let i = 0; i < 2000; i++) entity(s, op('stress-' + i), 'thread-delivery:st' + i, { state: 'visible', threadRef: 'thread:st' });
    advanceCursor(s, op('stress-cursor'));
    let previousPending = Infinity, passes = 0;
    const timings = [], original = s.retainEvidence.bind(s);
    s.retainEvidence = options => {
      const before = evidenceSnapshot(w.root);
      const result = original({ ...options, budget: { archive: 512, compact: 512, events: 1024 } });
      assertEvidenceBatch(before, evidenceSnapshot(w.root));
      passes += 1;
      assert(result.compacted.entities <= 512, 'a pass never archives more than its budget');
      assert(result.metrics.scanRows >= 2000, 'the plan saw the whole store');
      assert(result.metrics.durationMs >= 0 && result.metrics.lockWaitMs >= 0);
      assert(result.metrics.maxStallMs >= 0 && result.metrics.maxStallMs < 5000,
        'the whole call stays within the measured 2000-row test envelope: ' + result.metrics.maxStallMs + 'ms');
      const pending = result.pending.entities;
      assert(pending <= previousPending, 'each pass leaves no more work than the one before');
      previousPending = pending;
      timings.push(result.metrics);
      return result;
    };
    // No further writes, and no manual retention/tick: the host clock alone consumes durable pending work.
    await waitFor(() => passes >= 2 && !s.retentionWorkPending(), 'automatic stress convergence', 10000);
    assert.equal(w.host.status().evidenceRetention.lastError, null);
    assert(passes >= 2, 'the work did not fit in one pass');
    assert(passes <= 10, 'convergence retains the original ten-pass ceiling');
    assert(previousPending === 0, 'repeated passes converge: nothing is left pending');
    const kept = s.list('thread-delivery:').length;
    assert(kept >= 256 && kept <= 512,
      'repeated passes converge to the bound, not to zero and not to the original size: ' + kept);
    console.log('retention stress measured: ' + JSON.stringify({ passes, kept,
      maxDurationMs: Math.max(...timings.map(m => m.durationMs)), maxLockHeldMs: Math.max(...timings.map(m => m.lockHeldMs)) }));
  } finally { await w.close(); }
});
test('retention backlog: a rollback keeps every commit counted and a restart keeps the durable base', () => {
  const root = fresh();
  let before = 0;
  withStore(ControlStore, root, s => {
    seedRows(s, { 'member:root': { role: 'root', desired: 'active' } });
    for (let i = 0; i < 5; i++) entity(s, op('backlog-' + i), 'thread-delivery:bl' + i, { state: 'visible', threadRef: 'thread:bl' });
    before = s.commitsSinceRetention();
    assert(before >= 6);
    const injected = Object.assign(Error('injected commit fault'), { code: 'EVIDENCE_RETENTION_ABORTED' });
    assert.throws(() => s.retainEvidence({ limits: { deliveries: 1 }, hooks: { beforeCommit: () => { throw injected; } } }),
      error => error === injected && error.code === 'EVIDENCE_RETENTION_ABORTED');
    assert.equal(s.commitsSinceRetention(), before, 'a rolled-back pass leaves the backlog exactly where it was');
    s.retainEvidence({ limits: { deliveries: 1 } });
    assert.equal(s.commitsSinceRetention(), 0, 'a committed pass moves the durable base in the same transaction');
  });
  withStore(ControlStore, root, s => {
    assert.equal(s.commitsSinceRetention(), 0, 'the base survives a restart');
    entity(s, op('backlog-after'), 'thread-delivery:after', { state: 'visible', threadRef: 'thread:bl' });
    assert.equal(s.commitsSinceRetention(), 1, 'writes from a new connection count against the same base');
  });
});
test('retention closure: a retained event keeps the operation it names, and that receipt keeps its evidence', () => {
  const root = fresh();
  withStore(ControlStore, root, s => {
    seedRows(s, { 'member:root': { role: 'root', desired: 'active' } });
    entity(s, op('chain-old'), 'thread-delivery:chain-old', { state: 'visible', threadRef: 'thread:chain' });
    // The only name this operation has after the pass is the retained event of the live row it wrote: no receipt
    // window covers it, and its result is the only reference to the old delivery.
    const writer = entity(s, op('chain-writer'), 'member:root', { role: 'root' },
      { reduce: tx => { tx.put('member:root', { role: 'root', desired: 'active', chain: 1 }); return { ref: 'thread-delivery:chain-old' }; } });
    advanceCursor(s, op('chain-cursor'));
    const result = s.retainEvidence({ limits: { receipts: 1, deliveries: 0, events: 0 } });
    assert.equal(result.compacted.receipts, 0, 'the event reference protects the operation receipt');
    assert(s.receiptOf(writer.command).receipt.result, 'the receipt still carries its result');
    assert(s.read('thread-delivery:chain-old'), 'operation -> result -> old entity is walked to the fixed point');
  });
});

test('retention readers: per-reader lag is reported, the floor binds, and retiring is explicit only', () => {
  const root = fresh();
  withStore(ControlStore, root, s => {
    seedRows(s, { 'member:root': { role: 'root', desired: 'active' } });
    for (let i = 0; i < 4; i++) entity(s, op('reader-' + i), 'thread-delivery:r' + i, { state: 'visible', threadRef: 'thread:r' });
    const held = s.registerReader('audit', 2);
    assert.equal(held, 2);
    assert.throws(() => s.registerReader('audit', s.latestEventSeq() + 10), error => error?.code === 'INVALID_READER');
    const audit = s.readers().find(row => row.id === 'audit');
    assert(audit && audit.lag > 0 && Number.isSafeInteger(audit.lastAdvancedAt));
    // A stalled reader pins the floor; the pass reports it and does not quietly drop it.
    const kept = s.retainEvidence({ limits: { deliveries: 0, receipts: 0, events: 2 } });
    assert.equal(kept.floor.eventSeq, 2);
    const status = s.storageStatus().authoritativeEvidenceRetention;
    assert.deepEqual(status.blockingReader, ['audit']);
    assert(status.readers.find(row => row.id === 'audit').blocking === true);
    assert(status.warnings.some(w => w.code === 'READER_PINNING_HISTORY' && w.reader === 'audit'),
      'a reader far behind the journal window is warned about, not silently tolerated');
    assert(s.read('thread-delivery:r3'), 'evidence above a stalled reader is kept');
    assert.equal(s.readers().some(row => row.id === 'audit'), true, 'a stalled reader is never removed automatically');
    assert.throws(() => s.registerReader('late', kept.floor.eventSeq - 1), error => error?.code === 'READER_HISTORY_UNAVAILABLE',
      'a position whose events were already collected is refused');
    // A stalled reader that catches up stops blocking: the floor moves with it.
    const moved = s.registerReader('audit', s.latestEventSeq());
    const caughtUp = s.storageStatus().authoritativeEvidenceRetention;
    assert.equal(caughtUp.readers.find(row => row.id === 'audit').lag, 0);
    assert.deepEqual(caughtUp.warnings, [], 'a reader that advanced no longer pins the journal');
    // Explicit retirement is the only way out, and then the floor moves.
    advanceCursor(s, op('reader-cursor'));
    const retired = s.retireReader('audit');
    assert.equal(retired.seq, moved);
    assert.equal(s.readers().some(row => row.id === 'audit'), false);
    const after = s.retainEvidence({ limits: { deliveries: 0, receipts: 0, events: 0 } });
    assert(after.compacted.entities > 0, 'retiring the reader lets the floor advance');
  });
});

test('retention batch: asymmetric budgets keep deferred entities, outbox, events and full receipts closed', () => {
  for (const budget of [{ archive: 1, compact: 0, events: 0 }, { archive: 1, compact: 1, events: 0 },
    { archive: 1, compact: 0, events: 10 }, { archive: 0, compact: 1, events: 1 }, { archive: 1, compact: 1, events: 1 },
    { archive: 2, compact: 2, events: 10 }]) {
    const root = fresh();
    withStore(ControlStore, root, s => {
      seedRows(s, { 'member:root': { role: 'root' } }, op('batch-root'));
      seedRows(s, { 'decision:a': { state: 'decided' },
        'decision:z': { state: 'decided', refs: ['decision:a'] } }, op('batch-dependent'));
      entity(s, op('batch-outbox'), 'effect:batch', {}, { reduce: tx => {
        tx.outbox('effect:dependent', { target: 'decision:a' }); return { target: 'decision:a' };
      } });
      const db = new DatabaseSync(path.join(root, 'state-v2/control.sqlite'));
      try { db.prepare("UPDATE outbox SET data=json_set(data, '$.status', 'confirmed')").run(); } finally { db.close(); }
      advanceCursor(s, op('batch-floor'));
      const limits = { decisions: 0, outbox: 0, receipts: 0, events: 0 };
      for (let round = 0; round < 4; round++) {
        const before = evidenceSnapshot(root);
        let result;
        assert.doesNotThrow(() => { result = s.retainEvidence({ limits, budget }); }, 'every budget must commit a safe batch');
        assertEvidenceBatch(before, evidenceSnapshot(root));
        assert(result.compacted.entities + result.compacted.outbox <= budget.archive);
        assert(result.compacted.receipts <= budget.compact);
        assert(result.compacted.events <= budget.events);
      }
      if (budget.archive === 1 && budget.events === 0) {
        assert(s.read('decision:a'), 'a delayed terminal referrer must keep its target');
        assert(s.read('decision:z'), 'dependency groups are never split to meet a one-row budget');
      }
    });
  }
});


test('retention budgets: reject negative, fractional, nonfinite and unsafe values', () => {
  withStore(ControlStore, fresh(), s => {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      for (const name of ['archive', 'compact', 'events']) {
        assert.throws(() => s.retainEvidence({ budget: { [name]: value } }), { code: 'INVALID_RETENTION_BUDGET' });
        assert.equal(s.inTransaction(), false);
      }
    }
    assert.doesNotThrow(() => s.retainEvidence({ budget: { archive: 0, compact: 0, events: 0 } }));
  });
});
