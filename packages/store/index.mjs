import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { canonical, digest } from '../contracts/index.mjs';
import { fail, operationIdPattern, effectSettlementFields, hasEffectSettlementFields } from '../contracts/index.mjs';
import { planRetention, compactReceipt, assertRetentionClosure, retentionDescriptor, RETENTION_LIMITS } from './retention.mjs';

export const TEAM_STORE_VERSION = Object.freeze({ format: 1, driver: 'm1b-1' });
// A permanent reader floor, including after rollback: HEAD must never reinterpret v1 history.
export const BORROW_STORE_VERSION = Object.freeze({ format: 1, driver: 'm1b-borrow-v1' });

/**
 * R9: the delay policy for an effect that is due but must not run yet (its member is in a maintenance phase).
 *
 * Waiting is a scheduling question, never an execution that failed, so a deferral spends no try. The delay doubles with
 * the number of times the same effect has waited - a short job is retried quickly - and is capped, so the delivery
 * resumes within a bounded time after the job ends instead of drifting to minutes. The ledger owns both numbers; a
 * driver can ask to wait, never to wait longer than this.
 */
export const DEFER_BASE_MS = 1000;
export const DEFER_CAP_MS = 10000;
const deferDelay = defers => Math.min(DEFER_CAP_MS, Math.max(DEFER_BASE_MS, DEFER_BASE_MS * 2 ** Math.min(defers, 8)));
const VERSION_KEY = 'team-store-version';

function storedVersion(db) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='driver_metadata'").get()) return null;
  const row = db.prepare('SELECT value FROM driver_metadata WHERE key=?').get(VERSION_KEY);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return { invalid: true }; }
}
function inspectWritable(db) {
  const version = storedVersion(db);
  if (version !== null) {
    if (![TEAM_STORE_VERSION, BORROW_STORE_VERSION].some(v => canonical(version) === canonical(v))) fail('INCOMPATIBLE_TEAM_STORE');
    return;
  }
  // Only an actually empty database can acquire a version. Probe through a read-only connection first:
  // no schema creation, WAL mode change, ownership file or automatic migration may precede this refusal.
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  for (const { name } of tables) {
    const quoted = '"' + name.replaceAll('"', '""') + '"';
    if (db.prepare('SELECT 1 FROM ' + quoted + ' LIMIT 1').get()) fail('INCOMPATIBLE_TEAM_STORE');
  }
}

/** Own all control-plane commits, CAS, journals and recovery; 08 §2. */
export class ControlStore {
  #db;
  #readOnly = false;
  #hasMailboxFifo = false;
  #filename;
  #maintenance = null;
  #retentionMetrics = null;
  #projectionReaders = new Set();
  static preflight(root) {
    const filename = path.join(root, 'state-v2/control.sqlite');
    if (!fs.existsSync(filename)) return;
    const probe = new DatabaseSync(filename, { readOnly: true });
    probe.exec('PRAGMA busy_timeout=10000'); // connection-local: safe even for no-write preflight
    try { inspectWritable(probe); } finally { probe.close(); }
  }
  static openReadOnly(root) { return new ControlStore(root, {}, { readOnly: true }); }
  constructor(root, hooks = {}, { readOnly = false } = {}) {
    this.hooks = hooks;
    this.#readOnly = readOnly;
    const filename = this.#filename = path.join(root, 'state-v2/control.sqlite');
    if (readOnly) {
      this.#db = new DatabaseSync(filename, { readOnly: true });
      this.#db.exec('PRAGMA busy_timeout=10000'); // connection-local; never changes the observed database
      this.#hasMailboxFifo = Boolean(this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mailbox_fifo'").get());
      return; // P5 reads never install schema, change journal mode or write a version.
    }
    if (fs.existsSync(filename)) {
      const probe = new DatabaseSync(filename, { readOnly: true });
      probe.exec('PRAGMA busy_timeout=10000'); // schema migration in another opener may hold the lock
      try { inspectWritable(probe); } finally { probe.close(); }
    }
    fs.mkdirSync(path.join(root, 'state-v2'), { recursive: true });
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`PRAGMA busy_timeout=10000;
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS entities(id TEXT PRIMARY KEY, revision INTEGER, data TEXT);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, hash TEXT, receipt TEXT);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT,
        revision INTEGER, operationId TEXT, schema INTEGER, payload TEXT);
      CREATE INDEX IF NOT EXISTS events_entity_seq ON events(entity, seq);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, data TEXT);
      CREATE TABLE IF NOT EXISTS inbox(source TEXT, eventId TEXT, PRIMARY KEY(source,eventId));
      CREATE TABLE IF NOT EXISTS cursors(id TEXT PRIMARY KEY, seq INTEGER, updatedAt INTEGER);
      CREATE TABLE IF NOT EXISTS run_slots(attempt TEXT PRIMARY KEY, owner TEXT UNIQUE, task TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS evidence_archive(id TEXT PRIMARY KEY, kind TEXT NOT NULL, sourceId TEXT,
        digest TEXT NOT NULL, summary TEXT NOT NULL, archivedAt INTEGER NOT NULL, seq INTEGER,
        prevChain TEXT, chainDigest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projection_readers(id TEXT PRIMARY KEY, identity TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projection_receipt_times(entity TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS retention_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    if (this.#db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') { this.#db.close(); fail('CORRUPT_STORE'); }
    // Serialize schema inspection and ALTER, then recheck under the migration write lock.
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const archiveColumns = new Set(this.#db.prepare('PRAGMA table_info(evidence_archive)').all().map(row => row.name));
      for (const [name, type] of [['sourceId', 'TEXT'], ['prevChain', 'TEXT']]) {
        if (!archiveColumns.has(name)) this.#db.exec('ALTER TABLE evidence_archive ADD COLUMN ' + name + ' ' + type);
      }
      const cursorColumns = new Set(this.#db.prepare('PRAGMA table_info(cursors)').all().map(row => row.name));
      if (!cursorColumns.has('updatedAt')) this.#db.exec('ALTER TABLE cursors ADD COLUMN updatedAt INTEGER');
      this.#db.exec('CREATE TABLE IF NOT EXISTS driver_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      this.#db.prepare('INSERT OR IGNORE INTO driver_metadata VALUES(?,?)').run(VERSION_KEY, canonical(TEAM_STORE_VERSION));
      // FIFO is independent of disposable journal history AFTER this migration. Legacy stores already compacted
      // may have lost their creation order: MIN(surviving events.seq) is only a one-time bootstrap, not a recovery
      // of that order. FIFO and its U+1 bound start at migration; updates, retention and reopen cannot change it.
      this.#db.exec('CREATE TABLE IF NOT EXISTS mailbox_fifo(seq INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL UNIQUE)');
      this.#db.exec("DELETE FROM mailbox_fifo WHERE NOT EXISTS (SELECT 1 FROM entities WHERE entities.id=mailbox_fifo.entity)");
      this.#db.exec("INSERT INTO mailbox_fifo(entity) SELECT e.id FROM entities e WHERE e.id >= 'message:' AND e.id < 'message;' " +
        'AND NOT EXISTS (SELECT 1 FROM mailbox_fifo f WHERE f.entity=e.id) ' +
        'ORDER BY COALESCE((SELECT MIN(seq) FROM events WHERE entity=e.id),0), e.id');
      this.hooks.beforeMigrationCommit?.();
      this.#db.exec('COMMIT');
      this.#hasMailboxFifo = true;
    } catch (error) {
      for (const cleanup of [() => this.#db.exec('ROLLBACK'), () => this.#db.close()]) {
        try { cleanup(); } catch (failure) { error.cleanupErrors = [...(error.cleanupErrors ?? []), failure]; }
      }
      throw error;
    }
  }
  version() { return storedVersion(this.#db); }
  /**
   * Bounded-memory observation, including the authoritative journal, not just the disposable projection.
   *
   * authoritativeEvidenceRetention is the real state of the closure compactor (gap 1), not a promise: how often it ran,
   * what the last run found compactable and what it actually archived/compacted, the reader floor, and the archive's
   * own bound. counts and limits stay observable whether or not retention has ever run.
   */
  storageStatus() {
    const count = table => { try { return Number(this.#db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n); }
      catch (error) { if (/no such table/.test(error.message)) return 0; throw error; } };
    const prefixCount = prefix => Number(this.#db.prepare('SELECT COUNT(*) AS n FROM entities WHERE id>=? AND id<?').get(prefix, prefix.slice(0,-1) + ';').n);
    const bytes = filename => { try { return fs.statSync(filename).size; } catch (e) { if (e.code === 'ENOENT') return 0; throw e; } };
    const archiveRows = (() => { try { return Number(this.#db.prepare("SELECT COUNT(*) AS n FROM evidence_archive WHERE kind <> 'checkpoint'").get().n); }
      catch (error) { if (/no such table/.test(error.message)) return 0; throw error; } })();
    const archiveBytes = (() => { try { return Number(this.#db.prepare("SELECT COALESCE(SUM(LENGTH(summary) + LENGTH(digest) + 64), 0) AS n FROM evidence_archive").get().n); }
      catch (error) { if (/no such table/.test(error.message)) return 0; throw error; } })();
    const checkpoint = (() => { try { const row = this.#db.prepare("SELECT summary FROM evidence_archive WHERE kind='checkpoint'").get();
      return row ? JSON.parse(row.summary) : null; } catch (error) { if (/no such table/.test(error.message)) return null; throw error; } })();
    const counts = { entities: count('entities'), events: count('events'), operations: count('operations'), outbox: count('outbox'),
      inbox: count('inbox'), resources: prefixCount('thread-resource:'), resourceEvents: prefixCount('thread-event:'),
      deliveries: prefixCount('thread-delivery:'), subscriptions: prefixCount('thread-subscription:'),
      manifests: prefixCount('manifest:'), outcomes: prefixCount('execution-outcome:'), guardAudits: prefixCount('guard-audit:'),
      decisions: prefixCount('decision:') };
    const retention = this.#retentionState();
    if (this.#retentionMetrics?.runs === retention.runs && retention.last) {
      retention.last.metrics = this.#retentionMetrics.metrics;
    }
    return { databaseBytes: bytes(this.#filename), walBytes: bytes(this.#filename + '-wal'), counts,
      limits: { resources: 1000, eventsPerResource: 1000 },
      authoritativeEvidenceRetention: retentionDescriptor({ ...retention, maintenance: this.#maintenance }, counts,
        { rows: archiveRows, bytes: archiveBytes, checkpoint }, this.readers()) };
  }
  assertWritableDriver() {
    if (this.#readOnly) fail('READ_ONLY_TEAM_STORE');
    inspectWritable(this.#db);
  }
  read(id) {
    if (typeof id !== 'string') return null;
    const row = this.#db.prepare('SELECT * FROM entities WHERE id=?').get(id);
    return row ? { ...JSON.parse(row.data), entityId: id, revision: row.revision } : null;
  }
  /**
   * Every entity under a prefix, in id order. The range predicate keeps the scan inside that prefix instead of
   * scanning and re-reading the whole entity table: a mailbox read must cost its own messages, not the history.
   */
  list(prefix = '') {
    const decode = row => ({ ...JSON.parse(row.data), entityId: row.id, revision: row.revision });
    if (!prefix) return this.#db.prepare('SELECT * FROM entities ORDER BY id').all().map(decode);
    const upper = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
    return this.#db.prepare('SELECT * FROM entities WHERE id >= ? AND id < ? ORDER BY id').all(prefix, upper).map(decode);
  }
  /**
   * Newest journal sequence, optionally ignoring entities under the given prefixes. Callers only ever need the
   * sequence, and events() parses every row to hand it over: on the 43-cycle soak database that was ~86 ms of a
   * ~93 ms schedule(), which is why ready-to-admitted latency grew with history. The primary key answers it in O(log n).
   */
  latestEventSeq(exclude = []) {
    const filters = exclude.map(() => "entity NOT LIKE ? ESCAPE '\\'").join(' AND ');
    const params = exclude.map(prefix => prefix.replace(/[\\%_]/g, '\\$&') + '%');
    const row = this.#db.prepare('SELECT seq FROM events' + (filters ? ' WHERE ' + filters : '') +
      ' ORDER BY seq DESC LIMIT 1').get(...params);
    return row?.seq ?? 0;
  }
  /** Immutable admission rank, allocated in the message-creation transaction, not recomputed from retained events.
   * A legacy read-only observer cannot migrate storage: open it writable once before requesting FIFO snapshots. */
  mailboxFifoSeq(entityId) {
    if (!this.#hasMailboxFifo) fail('MAILBOX_FIFO_MIGRATION_REQUIRED');
    const row = this.#db.prepare('SELECT seq FROM mailbox_fifo WHERE entity=?').get(entityId);
    if (!row) fail('MISSING_MAILBOX_FIFO');
    return row.seq;
  }

  /** Pure bounded journal read, including commits older than a projection's initial checkpoint.
   * One SELECT snapshot; no cursor registration/advance, compaction, or checkpoint mutation.
   * throughSeq pins the upper boundary to the caller's already synchronized authoritative state.
   */
  readEventTail({ limit = 256, throughSeq = this.latestEventSeq() } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 ||
        !Number.isSafeInteger(throughSeq) || throughSeq < 0) fail('INVALID_CURSOR');
    const candidates = this.#db.prepare('SELECT * FROM events WHERE seq<=? ORDER BY seq DESC LIMIT ?')
      .all(throughSeq, limit);
    const events = [];
    let replayAfterSeq = throughSeq;
    // Genesis/reference closure may survive before an interior hole. Promise only a suffix ending at throughSeq.
    // A missing requested head means there is no such suffix, even if older events still exist.
    for (const row of candidates) {
      if (row.seq !== replayAfterSeq) break;
      events.push({ ...row, payload: JSON.parse(row.payload) });
      replayAfterSeq--;
    }
    return { events: events.reverse(), replayAfterSeq, asOfSeq: throughSeq };
  }
  events(after = 0) {
    return this.#db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq').all(after)
      .map(row => ({ ...row, payload: JSON.parse(row.payload) }));
  }
  *scanEvents(after = 0) {
    for (const row of this.#db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq').iterate(after)) yield {...row,payload:JSON.parse(row.payload)};
  }
  cursor(id) {
    return this.#db.prepare('SELECT seq FROM cursors WHERE id=?').get(id)?.seq ?? 0;
  }
  /**
   * Register (or move) a durable reader position. Retention's floor is the minimum over every registered reader, so a
   * consumer that reads the journal after the fact -- the real-run verifier recomputes attempt timing from events --
   * registers here before it starts reading: retention then keeps every event above that position instead of inferring
   * "no one needs this" from cursors that only describe the team's own dispatch. A reader that never advances pins the
   * floor, which is the guarantee an auditor asks for; a finite run's position dies with its store.
   */
  registerReader(id, seq = null) {
    if (this.#readOnly) fail('READ_ONLY_TEAM_STORE');
    if (typeof id !== 'string' || !id) fail('INVALID_READER');
    // The head is read after BEGIN IMMEDIATE: a writer in another connection cannot advance the journal between the
    // position we promise and the row we write.
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const head = this.latestEventSeq();
      const oldest = this.#db.prepare('SELECT MIN(seq) AS seq FROM events').get()?.seq ?? null;
      const position = seq === null ? head : seq;
      if (!Number.isSafeInteger(position) || position < 0 || position > head) fail('INVALID_READER');
      // A reader is promised every event after its position. If retention already collected any of them, the position
      // cannot be served completely and the registration is refused instead of silently handing over a gap.
      const surviving = Number(this.#db.prepare('SELECT COUNT(*) AS n FROM events WHERE seq > ?').get(position).n);
      if (oldest !== null && (position < oldest - 1 || surviving !== head - position)) fail('READER_HISTORY_UNAVAILABLE');
      this.#writeCursor(id, position);
      this.#db.exec('COMMIT');
      return position;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch (rollback) { error.cleanupErrors = [...(error.cleanupErrors ?? []), rollback]; }
      throw error;
    }
  }
  /**
   * End a reader's registration explicitly. Nothing retires a stalled reader on its own: a quiet reader still holds
   * the floor, and silently dropping it would delete the history it said it still needs.
   */
  retireReader(id) {
    if (this.#readOnly) fail('READ_ONLY_TEAM_STORE');
    if (typeof id !== 'string' || !id) fail('INVALID_READER');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#db.prepare('SELECT id, seq, updatedAt FROM cursors WHERE id=?').get(id) ?? null;
      if (row) { this.#db.prepare('DELETE FROM cursors WHERE id=?').run(id); this.#markRetentionReplan(); }
      this.#db.prepare('DELETE FROM projection_readers WHERE id=?').run(id);
      this.#db.exec('COMMIT');
      return row;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch (rollback) { error.cleanupErrors = [...(error.cleanupErrors ?? []), rollback]; }
      throw error;
    }
  }
  /** Every registered reader with how far behind it is and when it last moved. */
  readers() {
    const head = this.latestEventSeq();
    const hasTimestamp = this.#db.prepare('PRAGMA table_info(cursors)').all().some(row => row.name === 'updatedAt');
    const hasIdentities = this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projection_readers'").get();
    const identities = new Map(hasIdentities ? this.#db.prepare('SELECT id, identity FROM projection_readers').all().map(row => [row.id, JSON.parse(row.identity)]) : []);
    return this.#db.prepare('SELECT id, seq, ' + (hasTimestamp ? 'updatedAt' : 'NULL AS updatedAt') + ' FROM cursors ORDER BY id').all()
      .map(row => ({ id: row.id, seq: row.seq, lag: Math.max(0, head - row.seq), lastAdvancedAt: row.updatedAt ?? null,
        ...(identities.has(row.id) ? { identity: identities.get(row.id) } : {}) }));
  }
  commit(command, reduce) {
    if (this.#readOnly) fail('READ_ONLY_TEAM_STORE');
    if (!operationIdPattern.test(command.operationId) || !command.actor ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 ||
      command.payloadHash !== digest(command.payload)) fail('INVALID_COMMAND');
    // Two identities, never one (M1b design §3.6):
    //   stable external identity - (teamId, entityId, actor, operationId, payloadHash). payloadHash covers only the
    //     normalised business payload: a replay after expectedRevision, now, the internal claim fence or the epoch
    //     changed still resolves to the original receipt instead of a false conflict.
    //   the attempt fence inside the payload is business data and stays in payloadHash: attempt.finish {fence:3}
    //     replayed as {fence:4} is a different request and must conflict.
    const identity = digest({
      teamId: command.teamId ?? 'team', entityId: command.entityId, actor: command.actor,
      operationId: command.operationId, payloadHash: command.payloadHash,
    });
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.#db.prepare('SELECT * FROM operations WHERE id=?').get(command.operationId);
      if (previous) {
        if (previous.hash !== identity) fail('ID_CONFLICT');
        this.#db.exec('COMMIT');
        return JSON.parse(previous.receipt);
      }
      const current = this.read(command.entityId);
      if ((current?.revision ?? 0) !== command.expectedRevision) fail('CAS_CONFLICT');
      const tx = {
        read: id => this.read(id), list: prefix => this.list(prefix),
        effects: () => this.effects(), // the authoritative outbox, read inside this transaction
        runSlots: () => this.runSlots(), // an orphan SQL occupant is not proof of a drained execution
        // The journal head as this transaction sees it: writes made above are uncommitted but visible on this
        // connection, which is exactly what the admission cursor records (docs/decisions/M2a-shared-reducer.md §7-4).
        latestEventSeq: exclude => this.latestEventSeq(exclude),
        scanEvents: after => this.scanEvents(after),
        isPristine: () => ['entities','events','operations','outbox','inbox','cursors','run_slots'].every(table => !this.#db.prepare('SELECT 1 FROM ' + table + ' LIMIT 1').get()),
        requireBorrowReader: () => this.#db.prepare('UPDATE driver_metadata SET value=? WHERE key=?').run(canonical(BORROW_STORE_VERSION), VERSION_KEY),
        put: (id, data) => {
          if (id.startsWith('attempt:')) {
            this.#db.prepare('DELETE FROM run_slots WHERE attempt=?').run(id);
            if (['active', 'unknown'].includes(data.lease)) {
              this.#db.prepare('INSERT INTO run_slots VALUES(?,?,?)').run(id, data.owner, data.taskId);
            }
          }
          const prior = this.read(id);
          if (id.startsWith('message:') && !prior) this.#db.prepare('INSERT INTO mailbox_fifo(entity) VALUES(?)').run(id);
          const revision = (prior?.revision ?? 0) + 1;
          const value = { schemaVersion: 1, teamId: command.teamId, createdAt: prior?.createdAt ?? Date.now(),
            ...data, entityId: id, revision, updatedAt: Date.now() };
          if (id.startsWith('message:')) {
            // A new row has no prior receipt to recover: never scan growing history on message creation.
            const previousTimes = prior ? this.#messageReceiptTimes(id) : {};
            const times = Object.fromEntries(['stored', 'visible', 'accepted'].map(level =>
              [level, value[level] ? prior?.[level] ? previousTimes[level] : value.updatedAt : null]));
            this.#db.prepare('INSERT OR REPLACE INTO projection_receipt_times VALUES(?,?)').run(id, canonical(times));
          }
          this.#db.prepare('INSERT OR REPLACE INTO entities VALUES(?,?,?)').run(id, revision, canonical(value));
          this.#db.prepare('INSERT INTO events(entity,revision,operationId,schema,payload) VALUES(?,?,?,?,?)')
            .run(id, revision, command.operationId, 1, canonical(value));
          if (id.startsWith('attempt:') && data.capacityLane === 'human') {
            // Same transaction as run_slots/attempt/task, including restricted certificate closeout. No new admission.
            for (const slot of this.list('control-slot:')) if (slot.holderKind === 'mailbox-attempt' && slot.holderRef === id && slot.state !== 'released') {
              const state = data.lease === 'unknown' ? 'unknown' : data.lease === 'active' ? 'held' : 'released';
              if(slot.state !== state) tx.put(slot.entityId,{...slot,state});
            }
          }
          return value;
        },
        outbox: (id, payload) => this.#db.prepare('INSERT INTO outbox VALUES(?,?)')
          .run(id, canonical({ id, payload, status: 'pending', fence: 0, tries: 0, nextDue: 0 })),
        inbox: (source, eventId) => this.#db.prepare('INSERT OR IGNORE INTO inbox VALUES(?,?)')
          .run(source, eventId).changes > 0,
        cursor: (id, seq) => {
          this.#writeCursor(id, seq);
        },
      };
      const result = reduce(tx, current);
      if (result?.then) fail('ASYNC_TRANSACTION');
      const receipt = { operationId: command.operationId, entityId: command.entityId,
        revision: this.read(command.entityId)?.revision ?? 0, status: 'confirmed', evidenceRefs: [], result };
      this.#db.prepare('INSERT INTO operations VALUES(?,?,?)').run(command.operationId, identity, canonical(receipt));
      this.hooks.beforeCommit?.();
      this.#db.exec('COMMIT');
      this.hooks.afterCommit?.();
      return receipt;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  runSlots() { return this.#db.prepare('SELECT attempt, owner, task FROM run_slots ORDER BY attempt').all(); }
  effects() {
    return this.#db.prepare('SELECT data FROM outbox').all().map(row => JSON.parse(row.data));
  }
  effect(command, effectId, transition) {
    return this.commit(command, tx => {
      const effect = this.effects().find(item => item.id === effectId);
      if (!effect) fail('UNKNOWN_EFFECT');
      const next = transition(effect, tx);
      this.#db.prepare('UPDATE outbox SET data=? WHERE id=?').run(canonical(next), effectId);
      tx.put(command.entityId, { effectId, ...next });
      return next;
    });
  }
  /**
   * The durable receipt of an operation, if this exact command already committed (review 1 #5).
   *
   * A read-only probe over the operations table, with the identity hash commit() itself compares: a receipt is only
   * answered for the command that earned it, and a different payload under the same operationId answers
   * { conflict: true } so the caller raises the same ID_CONFLICT commit() would -- without a transaction, and without
   * a CAS on a row it is not going to write. It exists so a caller that must do external IO before its transaction
   * (a completion verdict reading the session journal) can find its own committed answer first instead of failing the
   * replay on IO it no longer needs.
   */
  receiptOf(command) {
    if (!command || typeof command.operationId !== 'string' || !command.operationId) return null;
    const row = this.#db.prepare('SELECT * FROM operations WHERE id=?').get(command.operationId);
    if (!row) return null;
    const identity = digest({
      teamId: command.teamId ?? 'team', entityId: command.entityId, actor: command.actor,
      operationId: command.operationId, payloadHash: command.payloadHash,
    });
    return row.hash === identity ? { receipt: JSON.parse(row.receipt) } : { conflict: true };
  }

  claim(command, effectId, owner, now, ttl = 60000, claimIndex = null) {
    return this.effect(command, effectId, (effect, tx) => {
      if (!['pending', 'retryable'].includes(effect.status) || effect.nextDue > now || effect.tries >= 5) fail('NOT_CLAIMABLE');
      const next = { ...effect, status: 'applying', owner, expiry: now + ttl, fence: effect.fence + 1, tries: effect.tries + 1 };
      // The claim and its IO occupancy index commit together: a crash cannot leave an indexed claim without identity or a
      // claimed effect without an index, so recovery never has to invent startedAt/epoch for a real claim.
      if (typeof claimIndex === 'function') claimIndex(tx, next);
      return next;
    });
  }
  /**
   * defer(command, effectId, now): an effect that is due but must wait (its member is in a maintenance phase).
   *
   * The row stays claimable and only nextDue moves: no claim, no fence step, no try, no evidence. This is the pre-claim
   * form; settle() applies the same rule when the wait is discovered after the claim.
   */
  defer(command, effectId, now) {
    return this.effect(command, effectId, effect => {
      if (!['pending', 'retryable'].includes(effect.status)) fail('NOT_DEFERRABLE');
      const defers = effect.defers ?? 0;
      const reason = 'deferred: the subject cannot run yet';
      // R10: deferredSince is the first moment of the *current* wait, so an operator can see how long this effect has
      // been waiting; defers is the cumulative count. Neither is a limit - a wait is observed, not timed out.
      return { ...effect, status: 'retryable', defers: defers + 1, nextDue: now + deferDelay(defers),
        deferredSince: effect.deferredSince ?? now, reason, lastEvidence: { deferred: true, reason } };
    });
  }
  /**
   * settle(command, effectId, fence, evidence, close = null, now = Date.now()).
   *
   * R9: evidence.deferred is its own outcome, never a failure. The protected close-out keeps the fence monotonic (it
   * never moves back), refunds exactly the one try this claim took - tries are not cleared, only this non-execution is
   * given back - and schedules the same capped backoff defer() uses. Nothing is confirmed, nothing is dead-lettered.
   */
  settle(command, effectId, fence, evidence, close = null, now = Date.now()) {
    return this.effect(command, effectId, (effect, tx) => {
      if (effect.fence !== fence || effect.status !== 'applying') fail('STALE_FENCE');
      const outcome = close ? close(tx, effect) : null;
      const facts=effectSettlementFields(evidence,{tries:effect.tries});
      if (evidence?.deferred === true) {
        const defers = effect.defers ?? 0;
        return { ...effect, status: 'retryable', fence: effect.fence, tries: Math.max(effect.tries - 1, 0),
          ...facts,
          defers: defers + 1, deferredSince: effect.deferredSince ?? now,
          reason: evidence.reason ?? 'deferred', lastEvidence: evidence,
          nextReviewAt: now + 60000, responsible: 'operator', nextDue: now + deferDelay(defers) };
      }
      return { ...effect, status: outcome?.cancelled ? 'cancelled' : evidence.executed ? 'confirmed' : evidence.retryPolicy === 'allowed' ? 'retryable' :
          evidence.retryPolicy === 'exhausted' && evidence.notExecuted ? 'dead-letter' :
          evidence.retryPolicy ? 'unknown' : evidence.notExecuted && effect.tries < 5 ? 'retryable' : evidence.notExecuted ? 'dead-letter' : 'unknown',
        // A real execution ends the wait episode; a bounded failure keeps it visible until the effect is settled.
        ...facts,
        deferredSince: evidence.executed ? null : (effect.deferredSince ?? null),
        reason: evidence.reason ?? 'receipt uncertain', lastEvidence: evidence, nextReviewAt: Date.now() + 60000,
        responsible: 'operator', nextDue: Date.now() + 1000 };
    });
  }
  reconcile(command, now) {
    if (!this.effects().some(e => e.status === 'applying' && e.expiry <= now)) return null;
    return this.commit(command, tx => {
      for (const effect of this.effects()) {
        if (effect.status === 'applying' && effect.expiry <= now) {
          const next = { ...effect, status: 'unknown', reason: 'claim interrupted', lastEvidence: null,
            ...(hasEffectSettlementFields(effect)?effectSettlementFields({unknown:true},{tries:effect.tries}):{}),
            nextReviewAt: now + 60000, responsible: 'operator' };
          this.#db.prepare('UPDATE outbox SET data=? WHERE id=?').run(canonical(next), effect.id);
        }
      }
      tx.put(command.entityId, { reconciledAt: now });
      return this.effects().filter(effect => effect.status === 'unknown');
    });
  }
  adjudicate(command, effectId, evidence, decision) {
    if (command.actor !== 'operator' || !evidence || !['confirmed', 'retryable', 'cancelled', 'dead-letter'].includes(decision)) fail('DENIED');
    return this.effect(command, effectId, effect => {
      if (effect.status !== 'unknown') fail('NOT_UNKNOWN');
      return { ...effect, status: decision, lastEvidence: evidence,
        ...(hasEffectSettlementFields(effect)||hasEffectSettlementFields(evidence)?effectSettlementFields(evidence,{tries:effect.tries}):{}) };
    });
  }
  /** Durable retention state; {} until the first run (and on a read-only store that never had one). */
  #retentionState() {
    try {
      const row = this.#db.prepare('SELECT value FROM retention_state WHERE key=?').get('borrow-evidence-retention');
      return row ? JSON.parse(row.value) : {};
    } catch (error) { if (/no such table/.test(error.message)) return {}; throw error; }
  }
  /** One consistent read of everything the pure planner needs. Never writes. */
  #retentionSnapshot() {
    return {
      entities: this.#db.prepare('SELECT id, data FROM entities ORDER BY id').all()
        .map(row => ({ sourceId: row.id, raw: row.data, record: JSON.parse(row.data) })),
      events: this.#db.prepare('SELECT seq, entity, operationId, payload FROM events ORDER BY seq').all()
        .map(row => ({ ...row, payload: JSON.parse(row.payload) })),
      operations: this.#db.prepare('SELECT rowid AS position, id, receipt FROM operations ORDER BY rowid').all()
        .map(row => ({ position: row.position, id: row.id, receipt: JSON.parse(row.receipt) })),
      outbox: this.#db.prepare('SELECT rowid AS position, id, data FROM outbox ORDER BY rowid').all()
        .map(row => ({ sourceId: row.id, position: row.position, record: JSON.parse(row.data) })),
      cursors: this.#db.prepare('SELECT id, seq, updatedAt FROM cursors ORDER BY id').all(),
    };
  }
  /** Fold the archive's oldest summaries into one chain checkpoint so the archive table itself stays bounded. */
  #pruneArchive(limit) {
    const cap = Number.isSafeInteger(limit) && limit >= 0 ? limit : RETENTION_LIMITS.archive;
    const total = Number(this.#db.prepare("SELECT COUNT(*) AS n FROM evidence_archive WHERE kind <> 'checkpoint'").get().n);
    if (total <= cap) return 0;
    const rows = this.#db.prepare("SELECT id, chainDigest FROM evidence_archive WHERE kind <> 'checkpoint' ORDER BY rowid LIMIT ?").all(total - cap);
    const remove = this.#db.prepare('DELETE FROM evidence_archive WHERE id=?');
    for (const row of rows) remove.run(row.id);
    const prior = this.#db.prepare("SELECT summary FROM evidence_archive WHERE kind='checkpoint'").get();
    const before = prior ? JSON.parse(prior.summary) : { count: 0, chainDigest: 'genesis' };
    const last = rows.at(-1);
    const chainDigest = digest({ prev: before.chainDigest, count: before.count + rows.length, lastChain: last.chainDigest });
    const summary = canonical({ count: before.count + rows.length, chainDigest });
    this.#db.prepare('INSERT OR REPLACE INTO evidence_archive(id,kind,sourceId,digest,summary,archivedAt,seq,prevChain,chainDigest) ' +
      "VALUES('evidence-archive:checkpoint','checkpoint','evidence-archive:checkpoint',?,?,?,NULL,?,?)")
      .run(chainDigest, summary, Date.now(), before.chainDigest, chainDigest);
    return rows.length;
  }
  /**
   * Compact and archive authoritative evidence in ONE transaction (gap 1: reference closure + safe compaction).
   *
   * The plan is computed inside the same IMMEDIATE transaction that applies it, so no commit can slip between "what is
   * still referenced" and "what is deleted". Archive insert, deletion of the original rows and receipt compaction are
   * therefore never observable apart: a process that dies at any point either has all of it (after COMMIT) or none of
   * it (SQLite rolls the transaction back). Failures roll back and rethrow the original error and code; nothing is
   * swallowed and no admission state is invented. hooks.beforeDelete is a fault-injection seam for the acceptance
   * suite, and it sits between the archive insert and the deletes precisely because those must be atomic.
   */
  retainEvidence({ now = Date.now(), limits = {}, budget = {}, hooks = this.hooks ?? {} } = {}) {
    if (this.#readOnly) fail('READ_ONLY_TEAM_STORE');
    const lim = { ...RETENTION_LIMITS, ...limits };
    const startedAt = performance.now();
    this.#db.exec('BEGIN IMMEDIATE');
    const lockAcquiredAt = performance.now();
    const lockWaitMs = lockAcquiredAt - startedAt;
    try {
      const planStart = performance.now();
      const snapshot = this.#retentionSnapshot();
      const plan = planRetention({ ...snapshot, now, limits, budget });
      const planMs = performance.now() - planStart;
      const applyStart = performance.now();
      const prior = this.#retentionState();
      let prevChain = prior.chainDigest ?? 'genesis';
      const insert = this.#db.prepare('INSERT INTO evidence_archive(id,kind,sourceId,digest,summary,archivedAt,seq,prevChain,chainDigest) VALUES(?,?,?,?,?,?,?,?,?)');
      for (const row of plan.archive) {
        const chainDigest = digest({ prev: prevChain, kind: row.kind, sourceId: row.sourceId, digest: row.digest });
        const key = 'archive:' + digest({ prev: prevChain, kind: row.kind, sourceId: row.sourceId, seq: row.seq ?? null, at: now });
        insert.run(key, row.kind, row.sourceId, row.digest, canonical(row.summary), now, row.seq ?? null, prevChain, chainDigest);
        prevChain = chainDigest;
      }
      hooks.beforeDelete?.({ plan });
      const removeEntity = this.#db.prepare('DELETE FROM entities WHERE id=?');
      const removeFifo = this.#db.prepare('DELETE FROM mailbox_fifo WHERE entity=?');
      for (const id of plan.deleteEntities) { removeEntity.run(id); removeFifo.run(id); }
      const removeEvent = this.#db.prepare('DELETE FROM events WHERE seq=?');
      for (const seq of plan.deleteEvents) removeEvent.run(seq);
      const removeOutbox = this.#db.prepare('DELETE FROM outbox WHERE id=?');
      for (const id of plan.deleteOutbox) removeOutbox.run(id);
      const rewrite = this.#db.prepare('UPDATE operations SET receipt=? WHERE id=?');
      for (const item of plan.compact) rewrite.run(canonical(item.receipt), item.operationId);
      const folded = this.#pruneArchive(lim.archive);

      // Post-conditions inside the transaction: the closure survived and no protected receipt changed shape.
      const exists = this.#db.prepare('SELECT 1 FROM entities WHERE id=?');
      const missing = plan.closure.entities.filter(id => !exists.get(id));
      const before = new Map(snapshot.operations.map(row => [row.id, canonical(row.receipt)]));
      const receiptOfId = this.#db.prepare('SELECT receipt FROM operations WHERE id=?');
      const changed = plan.closure.operations.filter(id => {
        const row = receiptOfId.get(id);
        return !row || (before.has(id) && canonical(JSON.parse(row.receipt)) !== before.get(id));
      });
      const archived = plan.deleteEntities.length + plan.deleteOutbox.length;
      if (missing.length || changed.length || plan.archive.length !== archived) fail('RETENTION_INVARIANT');
      const afterSnapshot = this.#retentionSnapshot();
      assertRetentionClosure(snapshot, afterSnapshot);
      const after = planRetention({ ...afterSnapshot, now, limits, budget });
      const compacted = prior.compacted ?? { receipts: 0, entities: 0, events: 0, outbox: 0 };
      // The backlog is a durable fact, not a counter in this process: the position of the last operation this pass
      // has seen survives a restart and is visible to every connection. It is written in the same transaction as the
      // work, so a rollback (including a failing beforeCommit hook) leaves the backlog exactly where it was.
      const backlogBase = Number(this.#db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM operations').get().n);
      const applyMs = performance.now() - applyStart;
      const pending = after.metrics.found;
      const needsContinuation = ['receipts', 'entities', 'events', 'outbox'].some(name => after.metrics.compactable[name] > 0);
      const budgetBlocked = !needsContinuation && Object.values(pending).some(count => count > 0);
      const state = { version: 1, lastRunAt: now, runs: (prior.runs ?? 0) + 1, chainDigest: prevChain, floor: plan.floor,
        limits: plan.limits, backlogBase, needsContinuation, budgetBlocked, replan: false,
        projectionEpoch: (prior.projectionEpoch ?? 0) + (plan.deleteEntities.length ? 1 : 0),
        compacted: { receipts: compacted.receipts + plan.compact.length, entities: compacted.entities + plan.deleteEntities.length,
          events: compacted.events + plan.deleteEvents.length, outbox: compacted.outbox + plan.deleteOutbox.length },
        last: { at: now, compactable: plan.metrics.compactable, pending, deferred: plan.metrics.deferred,
          found: plan.metrics.found, budget: plan.metrics.budget, closure: plan.metrics.closure, folded,
          // COMMIT duration cannot be known inside its own transaction. Exact whole-call/lock timings are published
          // after COMMIT in memory; durable stage timings explicitly do not claim to include COMMIT.
          metrics: { durationMs: null, lockHeldMs: null, maxStallMs: null, planMs, applyMs, lockWaitMs,
            scanRows: snapshot.entities.length + snapshot.events.length + snapshot.operations.length + snapshot.outbox.length,
            scanned: plan.metrics.before } } };
      this.#db.prepare('INSERT OR REPLACE INTO retention_state VALUES(?,?)')
        .run('borrow-evidence-retention', canonical(state));
      hooks.beforeCommit?.();
      this.#db.exec('COMMIT');
      const lockHeldMs = performance.now() - lockAcquiredAt;
      hooks.afterCommit?.();
      const durationMs = performance.now() - startedAt;
      const metrics = { ...state.last.metrics, durationMs, lockHeldMs, maxStallMs: durationMs };
      this.#retentionMetrics = { runs: state.runs, metrics };
      return { at: now, floor: plan.floor, compacted: plan.metrics.compactable, pending,
        archive: { inserted: plan.archive.length, folded }, closure: plan.metrics.closure, limits: plan.limits,
        deferred: plan.metrics.deferred, budget: plan.metrics.budget,
        metrics };
    } catch (error) {
      if (this.#db.isTransaction) {
        // A failed ROLLBACK must never replace the primary failure: attach it and rethrow the original error/code.
        try { this.#db.exec('ROLLBACK'); }
        catch (rollbackError) { error.cleanupErrors = [...(error.cleanupErrors ?? []), rollbackError]; }
      }
      throw error;
    }
  }
  /**
   * Commits completed since the last successful retention pass. Read from durable state, so a restart, another
   * connection's writes and a rolled-back pass all report the true backlog.
   */
  commitsSinceRetention() {
    const base = Number(this.#retentionState().backlogBase ?? 0);
    return Number(this.#db.prepare('SELECT COUNT(*) AS n FROM operations WHERE rowid > ?').get(base).n);
  }
  #writeCursor(id, seq) {
    const prior = this.#db.prepare('SELECT seq FROM cursors WHERE id=?').get(id);
    if (prior && prior.seq === seq) return false;
    this.#db.prepare('INSERT OR REPLACE INTO cursors(id, seq, updatedAt) VALUES(?,?,?)').run(id, seq, Date.now());
    this.#markRetentionReplan();
    return true;
  }
  #messageReceiptTimes(id) {
    const saved = this.#db.prepare('SELECT data FROM projection_receipt_times WHERE entity=?').get(id);
    if (saved) return JSON.parse(saved.data);
    // Upgrade legacy state without inventing timestamps when its transition history is already gone.
    let previous = null;
    const times = { stored: null, visible: null, accepted: null };
    for (const event of this.#db.prepare('SELECT revision,payload FROM events WHERE entity=? ORDER BY seq').iterate(id)) {
      const row = JSON.parse(event.payload);
      const contiguous = previous ? event.revision === previous.revision + 1 : event.revision === 1;
      for (const level of Object.keys(times)) {
        if (!row[level]) times[level] = null;
        else if (!previous?.[level] || !contiguous) times[level] = contiguous ? row.updatedAt : null;
      }
      previous = row;
    }
    return times;
  }
  /** Atomic authoritative-state checkpoint AND reader registration. No prefix replay across collected journal holes. */
  openProjectionReader(id = 'projection:' + randomUUID(), metadata = {}) {
    if (this.#readOnly) fail('READ_ONLY_TEAM_STORE');
    if (typeof id !== 'string' || !id.startsWith('projection:')) fail('INVALID_READER');
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('INVALID_READER');
    const identity = Object.freeze({ hostId: metadata.hostId ?? os.hostname() + ':' + process.pid,
      instanceId: metadata.instanceId ?? randomUUID(), pid: process.pid, createdAt: Date.now(),
      teamId: metadata.teamId ?? null, serviceId: metadata.serviceId ?? null });
    for (const name of ['hostId', 'instanceId', 'teamId', 'serviceId']) {
      if (identity[name] !== null && (typeof identity[name] !== 'string' || !identity[name] || identity[name].length > 512)) fail('INVALID_READER');
    }
    let closed = false, registered = false;
    const checkpoint = () => {
      if (closed) fail('PROJECTION_CLOSED');
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        if (!registered && this.#db.prepare('SELECT 1 FROM cursors WHERE id=?').get(id)) fail('READER_ALREADY_REGISTERED');
        const seq = this.latestEventSeq(), epoch = this.#retentionState().projectionEpoch ?? 0;
        const rows = this.list().map(row => {
          if (!row.entityId.startsWith('message:')) return row;
          const receiptTimes = this.#messageReceiptTimes(row.entityId);
          this.#db.prepare('INSERT OR REPLACE INTO projection_receipt_times VALUES(?,?)').run(row.entityId, canonical(receiptTimes));
          return { ...row, receiptTimes };
        });
        this.#writeCursor(id, seq);
        this.#db.prepare('INSERT OR IGNORE INTO projection_readers VALUES(?,?)').run(id, canonical(identity));
        this.#db.exec('COMMIT');
        registered = true;
        return { seq, epoch, rows };
      } catch (error) {
        try { this.#db.exec('ROLLBACK'); } catch (failure) { error.cleanupErrors = [...(error.cleanupErrors ?? []), failure]; }
        throw error;
      }
    };
    const initial = checkpoint();
    this.#projectionReaders.add(id);
    return { id, identity, initial, checkpoint,
      events: after => this.events(after),
      epoch: () => this.#retentionState().projectionEpoch ?? 0,
      advance: seq => this.registerReader(id, seq),
      close: () => { if (!closed) { if (this.#projectionReaders.has(id)) this.retireReader(id); this.#projectionReaders.delete(id); closed = true; } },
    };
  }
  #markRetentionReplan() {
    const state = this.#retentionState();
    this.#db.prepare('INSERT OR REPLACE INTO retention_state VALUES(?,?)')
      .run('borrow-evidence-retention', canonical({ ...state, replan: true }));
  }
  retentionWorkPending() {
    const state = this.#retentionState();
    return state.replan === true || state.needsContinuation === true;
  }
  /** True while this connection has an open transaction; a maintenance pass must never re-enter one. */
  inTransaction() { return this.#db.isTransaction === true; }
  /** Last maintenance outcome as the host reports it (last failure and backoff); owned by the host driver. */
  setRetentionMaintenance(state) { this.#maintenance = state ?? null; }
  retentionMaintenance() { return this.#maintenance; }
  /** Archived evidence summaries, oldest first. Read-only; the originals are gone by design. */
  archivedEvidence() {
    try {
      return this.#db.prepare('SELECT id, kind, sourceId, digest, summary, archivedAt, seq, prevChain, chainDigest FROM evidence_archive ORDER BY rowid').all()
        .map(row => ({ ...row, summary: JSON.parse(row.summary) }));
    } catch (error) { if (/no such table/.test(error.message)) return []; throw error; }
  }
  close() {
    let primary = null;
    for (const id of this.#projectionReaders) {
      try { this.retireReader(id); } catch (error) { if (!primary) primary = error; else primary.cleanupErrors = [...(primary.cleanupErrors ?? []), error]; }
    }
    this.#projectionReaders.clear();
    try { this.#db.close(); } catch (error) { if (!primary) primary = error; else primary.cleanupErrors = [...(primary.cleanupErrors ?? []), error]; }
    if (primary) throw primary;
  }
}
