import { canonical, digest, fail } from '../contracts/index.mjs';

/**
 * Authoritative evidence retention (docs/decisions/superagent-borrow-integration.md, gap 1).
 *
 * One question decides every record: who can still name it? The closure below is a joint work queue over entities,
 * outbox effects, operation receipts and retained journal events. A record pulled in by any of those is walked in
 * turn, so an operation that names another operation that names an entity is protected as a chain, and an event that
 * a reader has not consumed protects both its own entity and every reference in its payload. Nothing is deleted or
 * compacted until the queue reaches a fixed point.
 *
 * What may a compactable record become?
 *
 *   - an operation receipt becomes identity + result digest plus a bounded key summary, keeping the identity hash, so
 *     the same operationId still answers with the same receipt and a different payload under that id still answers
 *     ID_CONFLICT. A receipt that is already compacted is never touched again.
 *   - a terminal evidence row (delivery, outcome, decision, audit, settled effect mirror) moves to the archive, which
 *     keeps a bounded summary, the source id and a digest of the exact stored record, chained to the previous row.
 *
 * The planner is pure. ControlStore applies the plan in one IMMEDIATE transaction, so "archived" and "deleted" are
 * never observable apart.
 */
export const EVIDENCE_RETENTION_VERSION = 1;

/** The permanent, never-compacted evidence: a policy row and a migration/rollback summary are the migration proof. */
export const PERMANENT_EVIDENCE_PREFIXES = Object.freeze(['team-policy:', 'borrow-migration:']);

/**
 * The bounded windows. "keep" is per class; everything older is only compactable once the closure does not name it.
 * receipts/events are journal windows; archive caps the archive table itself (oldest rows fold into a chain checkpoint).
 */
export const RETENTION_LIMITS = Object.freeze({
  receipts: 512,
  events: 4096,
  deliveries: 256,
  outcomes: 256,
  decisions: 256,
  audits: 256,
  outbox: 256,
  archive: 512,
  receiptBytes: 2048,
});

const TERMINAL_OUTBOX = Object.freeze(['confirmed', 'cancelled', 'dead-letter']);

/**
 * Which terminal rows are compactable at all. A row is only ever a candidate when its own state proves it can no
 * longer be executed, reopened or adjudicated; the closure then protects the ones something still names.
 */
const COMPACTABLE_CLASSES = Object.freeze([
  Object.freeze({ kind: 'thread-delivery', prefix: 'thread-delivery:', keep: 'deliveries',
    terminal: row => ['visible', 'superseded', 'failed', 'confirmed', 'cancelled', 'dead-letter'].includes(row.state) }),
  Object.freeze({ kind: 'execution-outcome', prefix: 'execution-outcome:', keep: 'outcomes',
    terminal: row => ['terminated', 'confirmed', 'released', 'failed'].includes(row.state) }),
  Object.freeze({ kind: 'decision', prefix: 'decision:', keep: 'decisions',
    terminal: row => ['decided', 'superseded'].includes(row.state ?? row.status) }),
  // append-only audits: every row but the current pointer is terminal evidence
  Object.freeze({ kind: 'guard-audit', prefix: 'guard-audit:', keep: 'audits',
    terminal: row => row.entityId !== 'guard-audit:latest' }),
  // the entity mirror of a settled outbox row: it is archived together with that row, never alone
  Object.freeze({ kind: 'effect', prefix: 'effect:', keep: 'outbox',
    terminal: row => TERMINAL_OUTBOX.includes(row.status) }),
]);

export function compactableClasses() {
  return COMPACTABLE_CLASSES.map(entry => ({ kind: entry.kind, prefix: entry.prefix }));
}

/** Every string reachable from a value, in a stable order. Arrays and nested objects included on purpose. */
export function rowStrings(row) {
  const out = [];
  const visit = value => {
    if (typeof value === 'string') { out.push(value); return; }
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (value && typeof value === 'object') for (const item of Object.values(value)) visit(item);
  };
  visit(row);
  return out;
}

const utf8Bytes = value => Buffer.byteLength(canonical(value), 'utf8');
const resultKind = value => Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;

/** A key summary that is itself bounded: at most 32 keys, 64 code units each, 256 UTF-8 bytes in total. */
function boundedKeys(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
  const keys = [];
  let bytes = 0;
  for (const key of Object.keys(result).sort()) {
    const bounded = String(key).slice(0, 64);
    const cost = Buffer.byteLength(bounded, 'utf8') + 3; // quotes and comma
    if (keys.length >= 32 || bytes + cost > 256) break;
    keys.push(bounded); bytes += cost;
  }
  return keys;
}

/**
 * The compacted receipt. Bounded by real UTF-8 bytes, not string length. Returns null when the identity alone cannot
 * fit the budget: the caller then leaves the receipt intact instead of writing an unbounded or truncated identity.
 *
 * A receipt that is already compacted is never recompressed: recomputing from result:null would destroy the original
 * result digest and make replay across maintenance passes disagree with itself.
 */
export function compactReceipt(receipt, at, maxBytes = RETENTION_LIMITS.receiptBytes) {
  if (!receipt || receipt.compacted) return null;
  const result = receipt.result;
  const value = result === undefined ? null : result;
  const digestValue = digest(value);
  const base = { operationId: receipt.operationId, entityId: receipt.entityId, revision: receipt.revision,
    status: receipt.status ?? 'confirmed', evidenceRefs: [], result: null };
  const full = { version: EVIDENCE_RETENTION_VERSION, at, resultDigest: digestValue, resultKind: resultKind(value),
    resultBytes: utf8Bytes(value), resultKeys: boundedKeys(value) };
  const candidates = [
    { ...base, compacted: full },
    { ...base, compacted: { ...full, resultKeys: [] } },
    { ...base, compacted: { version: EVIDENCE_RETENTION_VERSION, at, resultDigest: digestValue } },
  ];
  for (const candidate of candidates) if (utf8Bytes(candidate) <= maxBytes) return candidate;
  return null;
}

function archiveSummary(kind, row) {
  let summary;
  if (kind === 'thread-delivery') summary = { state: row.state, threadRef: row.threadRef ?? null, seq: row.seq ?? null,
    recipient: row.recipient ?? null };
  else if (kind === 'execution-outcome') summary = { state: row.state, callIdentity: row.callIdentity ?? null,
    controlSlotRef: row.controlSlotRef ?? null, originRef: row.originRef ?? null };
  else if (kind === 'decision') summary = { kind: row.kind ?? null, state: row.state ?? row.status ?? null,
    subject: row.subject?.id ?? null };
  else if (kind === 'guard-audit') summary = { at: row.at ?? null, code: row.code ?? null, ok: row.ok ?? null };
  else if (kind === 'outbox') summary = { status: row.status ?? null, tries: row.tries ?? null,
    kind: row.payload?.kind ?? null, messageId: row.payload?.messageId ?? null };
  else if (kind === 'effect') summary = { status: row.status ?? null, effectId: row.effectId ?? null };
  else summary = {};
  const bounded = JSON.parse(JSON.stringify(summary));
  return canonical(bounded).length <= 512 ? bounded : { truncated: true, digestOnly: true };
}

/**
 * Compute the retention plan from a snapshot. Pure: no I/O, no clock beyond the passed now, no mutation of input.
 *
 * snapshot = {
 *   entities: [{sourceId, raw, record}], events: [{seq, entity, operationId, payload}],
 *   operations: [{position, id, receipt}], outbox: [{sourceId, record}], cursors: [{id, seq}]
 * }
 * The digest of an archived record is taken over its exact stored JSON (record), never over a scan position.
 */
export function planRetention({ entities = [], events = [], operations = [], outbox = [], cursors = [],
  now = Date.now(), limits = {}, budget = {} } = {}) {
  const lim = Object.freeze({ ...RETENTION_LIMITS, ...limits });
  const bud = Object.freeze({ archive: 512, compact: 512, events: 4096, ...budget });
  for (const [name, value] of [...Object.entries(lim), ...Object.entries(bud)]) {
    if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_RETENTION_BUDGET', name);
  }
  const entityById = new Map(entities.map(row => [row.sourceId, row]));
  const operationById = new Map(operations.map(row => [row.id, row]));
  const outboxById = new Map(outbox.map(row => [row.sourceId, row]));
  const eventBySeq = new Map(events.map(event => [event.seq, event]));
  const latestEvent = new Map();
  for (const event of events) latestEvent.set(event.entity, Math.max(latestEvent.get(event.entity) ?? 0, event.seq));
  const latestSeq = events.length ? events[events.length - 1].seq : 0;
  const genesisSeq = events.length ? events[0].seq : null;
  // The reader floor: what a durable reader has not consumed yet is never dropped. With no registered reader the
  // floor is the journal window, so the log still has a bound instead of growing forever.
  const floor = cursors.length ? Math.min(...cursors.map(row => row.seq)) : Math.max(0, latestSeq - lim.events);

  // 1. candidates: terminal rows outside their class's newest-keep window (a candidate is only archived if the
  //    fixed-point closure below never names it).
  const candidates = new Map();
  for (const spec of COMPACTABLE_CLASSES) {
    const rows = entities.filter(row => row.sourceId.startsWith(spec.prefix) && spec.terminal(row.record))
      .sort((a, b) => (latestEvent.get(b.sourceId) ?? 0) - (latestEvent.get(a.sourceId) ?? 0) ||
        a.sourceId.localeCompare(b.sourceId));
    for (const row of rows.slice(lim[spec.keep])) candidates.set(row.sourceId, spec.kind);
  }
  const terminalOutbox = outbox.filter(row => TERMINAL_OUTBOX.includes(row.record.status))
    .sort((a, b) => (b.position ?? 0) - (a.position ?? 0));
  const outboxCandidates = new Set(terminalOutbox.slice(lim.outbox).map(row => row.sourceId));

  // 2. the joint work queue. Seeds are the things that are evidence by their own state: live/permanent rows, the
  //    newest outbox window, the newest receipts window plus every receipt that carries a migration reference, and
  //    the journal segments a reader can still need.
  const retained = { entity: new Set(), outbox: new Set(), operation: new Set(), event: new Set() };
  const queued = { entity: new Set(), outbox: new Set(), operation: new Set(), event: new Set() };
  const queue = [];
  const enqueue = (type, id) => {
    if (id === null || id === undefined || queued[type].has(id)) return;
    queued[type].add(id); queue.push({ type, id });
  };
  const reference = value => {
    if (entityById.has(value)) enqueue('entity', value);
    if (operationById.has(value)) enqueue('operation', value);
    if (outboxById.has(value)) enqueue('outbox', value);
  };
  const walk = value => { for (const item of rowStrings(value)) reference(item); };

  const drain = () => {
    while (queue.length) {
      const { type, id } = queue.pop();
      retained[type].add(id);
      if (type === 'entity') { const row = entityById.get(id); if (row) walk(row.record); }
      else if (type === 'outbox') { const row = outboxById.get(id); if (row) walk(row.record); }
      else if (type === 'operation') { const row = operationById.get(id); if (row) walk(row.receipt); }
      else if (type === 'event') {
        const event = eventBySeq.get(id);
        // A retained event protects its own entity, the operation that produced it and every reference in its payload:
        // a journal segment must never outlive the row it describes, and an unread event is the only name an operation
        // may still have once its receipt left the receipts window.
        if (event) { enqueue('entity', event.entity); reference(event.operationId); walk(event.payload); }
      }
    }
  };

  for (const row of entities) {
    if (!candidates.has(row.sourceId)) enqueue('entity', row.sourceId);
    else if (PERMANENT_EVIDENCE_PREFIXES.some(prefix => row.sourceId.startsWith(prefix))) enqueue('entity', row.sourceId);
  }
  // every team keeps at least one durable row, so "the team has no history" is never created by compaction
  const teamOf = new Map(entities.map(row => [row.sourceId, row.record.teamId ?? null]));
  const coveredTeams = new Set(entities.filter(row => !candidates.has(row.sourceId)).map(row => row.record.teamId ?? null));
  for (const team of new Set(entities.map(row => row.record.teamId ?? null))) {
    if (coveredTeams.has(team)) continue;
    const newest = [...candidates.keys()].filter(id => teamOf.get(id) === team)
      .sort((a, b) => (latestEvent.get(b) ?? 0) - (latestEvent.get(a) ?? 0))[0];
    if (newest) enqueue('entity', newest);
  }
  for (const row of outbox) if (!outboxCandidates.has(row.sourceId)) enqueue('outbox', row.sourceId);
  for (const row of [...operations].sort((a, b) => (b.position ?? 0) - (a.position ?? 0)).slice(0, lim.receipts)) {
    enqueue('operation', row.id);
  }
  for (const row of operations) {
    if (row.id.startsWith('v1:operation:initial-policy-')) enqueue('operation', row.id);
    const migrationRef = row.receipt?.result?.migrationRef;
    if (typeof migrationRef === 'string' && migrationRef.startsWith('borrow-migration:')) enqueue('operation', row.id);
  }
  for (const row of entities) {
    if (!row.sourceId.startsWith('borrow-migration:')) continue;
    const operationId = row.sourceId.slice('borrow-migration:'.length);
    if (operationById.has(operationId)) enqueue('operation', operationId);
  }
  for (const event of events) {
    if (event.seq === genesisSeq || event.seq === latestSeq || event.seq > floor) enqueue('event', event.seq);
  }
  for (const row of operations) {
    if (!row.receipt?.compacted && !compactReceipt(row.receipt, now, lim.receiptBytes)) enqueue('operation', row.id);
  }
  drain();

  // 3. fixed point: a retained entity keeps its newest event (a cold rebuild reconstructs it), and that event keeps
  //    its own references. Newly retained entities may in turn retain newer events, so this repeats until stable.
  for (;;) {
    let added = false;
    for (const id of retained.entity) {
      const seq = latestEvent.get(id);
      if (seq !== undefined && !retained.event.has(seq)) { enqueue('event', seq); added = true; }
    }
    if (!added) break;
    drain();
  }

  const candidateEntities = [...candidates.keys()].filter(id => !retained.entity.has(id)).sort();
  const candidateOutbox = [...outboxCandidates].filter(id => !retained.outbox.has(id)).sort();
  const allCompact = [];
  let uncompactable = 0;
  for (const row of operations) {
    if (row.receipt?.compacted) continue; // never recompress: the original result digest is not recoverable
    const compacted = compactReceipt(row.receipt, now, lim.receiptBytes);
    if (!compacted) { uncompactable += 1; continue; }
    if (retained.operation.has(row.id)) continue;
    allCompact.push({ operationId: row.id, receipt: compacted });
  }
  const allDeleteEvents = events.filter(event => !retained.event.has(event.seq)).map(event => event.seq);

  // Budget dependency groups, never independent slices. Removing a target requires deleting/rewriting ALL of its
  // surviving referrers in this batch. Deleting a retained row's latest snapshot likewise requires deleting that row.
  // A group that cannot fit is skipped (not partially applied); later independent groups can still make progress.
  const key = (type, id) => JSON.stringify([type, id]);
  const actions = new Map();
  const add = (type, id, cost) => actions.set(key(type, id), { type, id, cost, needs: new Set(), blocked: false });
  allDeleteEvents.forEach(id => add('event', id, 'events'));
  allCompact.forEach(row => add('operation', row.operationId, 'compact'));
  candidateEntities.forEach(id => add('entity', id, 'archive'));
  candidateOutbox.forEach(id => add('outbox', id, 'archive'));
  const requireSource = (target, type, id) => {
    const source = key(type, id);
    if (actions.has(source)) target.needs.add(source);
    else target.blocked = true;
  };
  const link = (type, id, values) => {
    for (const value of values) {
      for (const targetType of ['entity', 'outbox', 'operation']) {
        const target = actions.get(key(targetType, value));
        if (target) requireSource(target, type, id);
      }
    }
  };
  for (const row of entities) link('entity', row.sourceId, rowStrings(row.record));
  for (const row of outbox) link('outbox', row.sourceId, rowStrings(row.record));
  // Compacted identity/digest fields are replay metadata, not live evidence references.
  for (const row of operations) if (!row.receipt?.compacted) link('operation', row.id, rowStrings(row.receipt));
  for (const event of events) {
    link('event', event.seq, [event.entity, event.operationId, ...rowStrings(event.payload)]);
    const action = actions.get(key('event', event.seq));
    if (action && entityById.has(event.entity) && latestEvent.get(event.entity) === event.seq) {
      requireSource(action, 'entity', event.entity);
    }
  }
  const selected = new Set(), used = { archive: 0, compact: 0, events: 0 };
  for (const start of actions.keys()) {
    if (selected.has(start)) continue;
    const group = new Set(), stack = [start], cost = { archive: 0, compact: 0, events: 0 };
    let fits = true;
    while (stack.length && fits) {
      const id = stack.pop();
      if (selected.has(id) || group.has(id)) continue;
      const action = actions.get(id);
      group.add(id);
      cost[action.cost] += 1;
      if (action.blocked || used[action.cost] + cost[action.cost] > bud[action.cost]) { fits = false; break; }
      stack.push(...action.needs);
    }
    if (!fits) continue;
    for (const id of group) selected.add(id);
    for (const name of Object.keys(used)) used[name] += cost[name];
  }
  const picked = (type, id) => selected.has(key(type, id));
  const archivedEntities = new Set(candidateEntities.filter(id => picked('entity', id)));
  const archivedOutbox = new Set(candidateOutbox.filter(id => picked('outbox', id)));
  const compact = allCompact.filter(row => picked('operation', row.operationId));
  const deleteEvents = allDeleteEvents.filter(id => picked('event', id));

  // Actual survivors, including every deferred candidate, are protection roots for this batch's closure.
  for (const row of entities) if (!picked('entity', row.sourceId)) enqueue('entity', row.sourceId);
  for (const row of outbox) if (!picked('outbox', row.sourceId)) enqueue('outbox', row.sourceId);
  for (const row of operations) if (!picked('operation', row.id) && !row.receipt?.compacted) enqueue('operation', row.id);
  for (const event of events) if (!picked('event', event.seq)) enqueue('event', event.seq);
  drain();

  const archive = [];
  for (const id of archivedEntities) {
    const row = entityById.get(id);
    archive.push({ kind: candidates.get(id), sourceId: id, seq: latestEvent.get(id) ?? null,
      digest: digest(row.record), summary: archiveSummary(candidates.get(id), row.record) });
  }
  for (const id of archivedOutbox) {
    const row = outboxById.get(id);
    archive.push({ kind: 'outbox', sourceId: id, seq: null, digest: digest(row.record),
      summary: archiveSummary('outbox', row.record) });
  }

  const byClass = {};
  for (const id of archivedEntities) {
    const kind = candidates.get(id);
    byClass[kind] = (byClass[kind] ?? 0) + 1;
  }
  byClass.outbox = archivedOutbox.size;
  const compactable = { receipts: compact.length, entities: archivedEntities.size,
    events: deleteEvents.length, outbox: archivedOutbox.size, byClass, uncompactable };
  const found = { receipts: allCompact.length, entities: candidateEntities.length, events: allDeleteEvents.length,
    outbox: candidateOutbox.length };
  const deferred = { receipts: found.receipts - compact.length, entities: found.entities - archivedEntities.size,
    events: found.events - deleteEvents.length, outbox: found.outbox - archivedOutbox.size };

  return Object.freeze({
    now,
    limits: lim,
    floor: Object.freeze({ eventSeq: floor, source: cursors.length ? 'reader-cursor' : 'journal-window' }),
    closure: Object.freeze({ entities: Object.freeze([...retained.entity].sort()),
      operations: Object.freeze([...retained.operation].sort()),
      outbox: Object.freeze([...retained.outbox].sort()),
      events: Object.freeze([...retained.event].sort((a, b) => a - b)) }),
    archive: Object.freeze(archive),
    deleteEntities: Object.freeze([...archivedEntities].sort()),
    deleteEvents: Object.freeze(deleteEvents),
    deleteOutbox: Object.freeze([...archivedOutbox].sort()),
    compact: Object.freeze(compact),
    metrics: Object.freeze({
      before: Object.freeze({ entities: entities.length, events: events.length, operations: operations.length, outbox: outbox.length }),
      compactable: Object.freeze(compactable),
      found: Object.freeze(found),
      deferred: Object.freeze(deferred),
      budget: Object.freeze({ archive: bud.archive, compact: bud.compact, events: bud.events }),
      closure: Object.freeze({ entities: retained.entity.size, operations: retained.operation.size,
        outbox: retained.outbox.size, events: retained.event.size }),
    }),
  });
}

/** Validate the actual post-apply graph, not only the planner's pre-budget protected set. */
export function assertRetentionClosure(before, after) {
  const removed = new Set();
  for (const [rows, kept, id] of [[before.entities, after.entities, 'sourceId'],
    [before.outbox, after.outbox, 'sourceId'], [before.operations, after.operations, 'id']]) {
    const live = new Set(kept.map(row => row[id]));
    for (const row of rows) if (!live.has(row[id])) removed.add(row[id]);
  }
  const check = value => { if (rowStrings(value).some(ref => removed.has(ref))) fail('RETENTION_INVARIANT'); };
  for (const row of after.entities) check(row.record);
  for (const row of after.outbox) check(row.record);
  for (const row of after.operations) if (!row.receipt?.compacted) check(row.receipt);
  for (const event of after.events) check([event.entity, event.operationId, event.payload]);
}

/** Compact status for storageStatus(): bounded counts, the reader floor and the archive's own bound. */
export function retentionDescriptor(state, counts, archive, readerRows = []) {
  const readers = Object.freeze(readerRows.map(row => Object.freeze({ id: row.id, seq: row.seq, lag: row.lag,
    lastAdvancedAt: row.lastAdvancedAt ?? null, ...(row.identity ? { identity: Object.freeze({ ...row.identity }) } : {}), blocking: false })));
  const floorSeq = readers.length ? Math.min(...readers.map(row => row.seq)) : null;
  const blockingReaders = floorSeq === null ? [] : readers.filter(row => row.seq === floorSeq).map(row => row.id);
  const marked = Object.freeze(readers.map(row => Object.freeze({ ...row, blocking: row.seq === floorSeq })));
  const window = state?.limits?.events ?? RETENTION_LIMITS.events;
  const warnings = readers.filter(row => row.lag > window).map(row => Object.freeze({
    code: 'READER_PINNING_HISTORY', reader: row.id, lag: row.lag,
    message: 'reader ' + row.id + ' is ' + row.lag + ' events behind and pins more than the journal window (' + window + ')' }));
  if (state?.budgetBlocked) warnings.push(Object.freeze({ code: 'RETENTION_BUDGET_BLOCKED',
    message: 'pending dependency group cannot fit the current budget; raise budget or release references' }));
  if ((state?.last?.metrics?.durationMs ?? 0) > 1000) warnings.push(Object.freeze({
    code: 'RETENTION_SLOW', durationMs: state.last.metrics.durationMs,
    message: 'full evidence maintenance exceeded 1000ms; full-store scan has no latency bound' }));
  return Object.freeze({
    mode: 'reference-closure',
    status: state?.runs ? 'enforced' : 'enforced-not-yet-run',
    runs: state?.runs ?? 0,
    lastRunAt: state?.lastRunAt ?? null,
    floor: state?.floor ?? { eventSeq: 0, source: 'none' },
    last: state?.last ?? null,
    compactable: state?.last?.compactable ?? null,
    pending: state?.last?.pending ?? null,
    needsContinuation: state?.needsContinuation ?? false,
    replan: state?.replan ?? false,
    maintenance: state?.maintenance ?? null,
    compacted: state?.compacted ?? { receipts: 0, entities: 0, events: 0, outbox: 0 },
    archive: Object.freeze({ rows: archive?.rows ?? 0, bytes: archive?.bytes ?? 0,
      checkpoint: archive?.checkpoint ?? null, limit: state?.limits?.archive ?? RETENTION_LIMITS.archive }),
    counts: Object.freeze(counts ?? {}),
    limits: Object.freeze(state?.limits ?? RETENTION_LIMITS),
    readers: marked,
    blockingReader: blockingReaders.length ? blockingReaders : null,
    warnings: Object.freeze(warnings),
  });
}
