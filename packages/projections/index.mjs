import { retain } from './retention.mjs';
import { activityEvents } from './activity.mjs';
import { view, canSee } from './view.mjs';
import { pricingConfig } from '../contracts/index.mjs';
export { ownerSessionLive, view } from './view.mjs';
export { serve } from './http.mjs';
// The UI→domain translation, published through the entry: a profile or a suite reaches it here instead of the module
// (check-deps rule b), and the delivery write half arrives as an injected port (see commands.mjs).
export { submit } from './commands.mjs';
export { capabilitiesFor } from './capabilities.mjs';
// The projection payload schemas are the read contract the browser validates against (P4B). Published through the entry
// so ui/test reads them here instead of reaching into projections/schema.mjs (check-deps rule b).
export { certificateBindingSchema, resourceThreadSchema, capacityStatusSchema, roleGuardStatusSchema, inputBatchSchema } from './schema.mjs';
const collections = ['members', 'tasks', 'threads', 'messages', 'unknownEffects', 'approvals'];
// P9 (docs/decisions/team-autonomy-design.md §10 P9, appendix 9): the P7 blocks travel in the delta stream too. They are
// named only when one side of a delta has them, so a team that never wrote an autonomy row streams exactly the six
// collections it streamed before this table existed.
const extraCollections = ['decisions', 'auditTrail', 'stopProofs', 'resourceThreads'];
/** Object-shaped blocks: compared whole, never merged (a goal or a ledger has no id list to diff). */
// M6 (§22-M6-plan WP-1): the panel blocks travel whole. They are derived rows, not collections, so a delta names one
// only when it differs -- and a legacy panel (this list's keys undefined on both sides) streams exactly what it did.
const extraBlocks = ['teamGoal', 'effects', 'budget', 'capacity', 'roleGuard', 'inputs',
  'summary', 'memberSummary', 'delivery', 'escalations', 'intents', 'team', 'viewerRole'];
/**
 * A row as the delta comparison must see it.
 *
 * A decision row publishes two facts derived from the reader's clock (expired, ttlRemainingMs). They move at millisecond
 * granularity with no event behind them, so comparing them would re-send every open decision on every delta forever.
 * The durable state -- which is what "changed" means -- is compared; the client derives the two fields itself from
 * expiresAt, exactly as this envelope does.
 */
const comparableRow = row => {
  if (!row || typeof row !== 'object' || !('ttlRemainingMs' in row)) return row;
  const { expired, ttlRemainingMs, ...rest } = row;
  return rest;
};
const reduce = (rows, event, reader) => {
  let previous = rows.get(event.entity);
  // A late update may resurrect an archived message: recover original receipt
  // timestamps from durable facts, rather than stamping them with update time.
  if (!previous && reader && event.entity.startsWith('message:') && event.payload.revision > 1) {
    const recovered = new Map();
    for (const old of (reader.scanEvents?.(0) ?? reader.events(0))) {
      if(old.seq >= event.seq) break;
      if(old.entity === event.entity) reduce(recovered,old);
    }
    previous = recovered.get(event.entity);
  }
  const row = { ...event.payload };
  if (event.entity.startsWith('message:')) row.receiptTimes = Object.fromEntries(['stored', 'visible', 'accepted'].map(level =>
    [level, row[level] ? previous?.[level] ? previous.receiptTimes[level] : row.updatedAt : null]));
  rows.set(event.entity, row);
};
/** Atomic checkpoint + bounded contiguous tail for managed stores; legacy complete-log readers may replay from zero. */
export class Projection {
  // ownerSession is the one live (non-row) fact a member row is derived against: whether this host still routes the
  // team's owner session. It is a thunk, so every snapshot reads the binding at that moment rather than at construction.
  //
  // P9: pricing is the price table the composition configured, or null. It is configuration, not a row, and it is the
  // only way a cost can appear in the envelope; with null the projection answers exactly what it answered before this
  // option existed.
  //
  // P5: protocol/maxRuns/roleGuard are the v1 read facts a Projection cannot derive from rows alone. They default to
  // the off position, so every existing constructor call produces the same envelope it produced before P5.
  constructor(reader, { recentLimit = 256, ownerSession = null, pricing = null, protocol = 'off', maxRuns = null,
    roleGuard = null, readerIdentity = null, panel = 'v3', routeSession = null, leaderSession = null, commandPolicy = {} } = {}) {
    if (!['v3', 'legacy'].includes(panel)) throw Error('INVALID_PANEL');
    if(!Number.isSafeInteger(recentLimit)||recentLimit<1)throw Error('INVALID_RETENTION');
    if(ownerSession !== null && typeof ownerSession !== 'function') throw Error('INVALID_OWNER_SESSION');
    if(!['off','v1'].includes(protocol)) throw Error('INVALID_PROTOCOL');
    if(maxRuns !== null && (!Number.isSafeInteger(maxRuns) || maxRuns < 0)) throw Error('INVALID_MAX_RUNS');
    if(roleGuard !== null && typeof roleGuard !== 'function' && typeof roleGuard !== 'object') throw Error('INVALID_ROLE_GUARD');
    // P9/§10 P0: the table is checked by the same contract the profile resolved (INVALID_CONFIG: an empty currency or a
    // negative rate is refused), and the projection keeps its own frozen copy. A plugin entry may configure this class
    // without going through autonomyConfig(), and a caller that edits its own object after construction must not move
    // an amount no event reported.
    const table = pricing === null ? null : pricingConfig(pricing);
    if (readerIdentity !== null && (typeof readerIdentity !== 'object' || Array.isArray(readerIdentity))) throw Error('INVALID_READER');
    this.eventLog = reader;
    this.recentLimit=recentLimit; this.reader = reader; this.ownerSession = ownerSession; this.pricing = table;
    // Default production reads add panel blocks only with visible M6 facts or protocol v1.
    // Off/no-fact teams keep the P7/P9 byte oracles without selecting a compatibility branch.
    this.panel = panel; this.identity = readerIdentity ?? null;
    this.routeSession = routeSession; this.leaderSession = leaderSession;
    this.commandPolicy = { intentProtocol: protocol === 'v1' ? 'root-decision-v1' : null, ...commandPolicy };
    this.protocol = protocol; this.maxRuns = maxRuns; this.roleGuard = roleGuard;
    this.rows = new Map(); this.seq = 0; this.history = []; this.latency = [];
    this.managed = typeof reader.openProjectionReader === 'function';
    this.closed = false;
    if (this.managed) {
      this.reader = reader.openProjectionReader(undefined, readerIdentity ?? {});
      this.reset(this.reader.initial);
    }
  }
  reset(checkpoint) {
    this.sourceRows = new Map(checkpoint.rows.map(row => [row.entityId, row]));
    this.baseRows = new Map(this.sourceRows); this.baseSeq = checkpoint.seq; this.epoch = checkpoint.epoch;
    this.rows = new Map(this.sourceRows); this.seq = checkpoint.seq; this.history = []; this.latency = [];
    retain(this.rows, this.recentLimit, { protocol: this.protocol });
  }
  close() { if (!this.closed) { this.reader.close?.(); this.closed = true; } }
  replayBoundary() { return { replayAfterSeq: this.managed ? this.baseSeq : 0, checkpointEpoch: this.managed ? this.epoch : null }; }
  stats() { return { seq:this.seq, rows:this.rows.size, history:this.history.length, latency:this.latency.length, recentLimit:this.recentLimit }; }
  sync() {
    if (this.closed) throw Error('PROJECTION_CLOSED');
    if (this.managed && this.reader.epoch() !== this.epoch) this.reset(this.reader.checkpoint());
    for (const event of (this.reader.scanEvents?.(this.seq) ?? this.reader.events(this.seq))) {
      if (event.seq !== this.seq + 1) throw Error('EVENT_GAP');
      if (this.managed) {
        // Keep checkpoint state separate from the trimmed presentation: resurrection retains original receipt times.
        reduce(this.sourceRows, event);
        this.rows = new Map(this.sourceRows);
      } else reduce(this.rows, event, this.reader);
      this.seq = event.seq;
      this.history.push(event); this.latency.push(Math.max(0, Date.now() - event.payload.updatedAt));
      if (this.history.length > this.recentLimit) {
        const oldest = this.history.shift();
        if (this.managed) { reduce(this.baseRows, oldest); this.baseSeq = oldest.seq; }
      }
      if(this.latency.length>this.recentLimit)this.latency.shift();
      retain(this.rows,this.recentLimit,{protocol:this.protocol});
    }
    if (this.managed) {
      // Advance only after strict contiguous application. Unread events were pinned until this point.
      this.reader.advance(this.seq);
      if (this.reader.epoch() !== this.epoch) this.reset(this.reader.checkpoint());
    }
  }
  envelope(actor, rows = this.rows, seq = this.seq) {
    const data = view(rows, actor, this.rows, { ownerSession: this.ownerSession ? this.ownerSession() === true : false,
      pricing: this.pricing, protocol: this.protocol, maxRuns: this.maxRuns, roleGuard: this.roleGuard, now: Date.now(),
      panel: this.panel, leaderSessionId: this.leaderSession?.() ?? null, commandPolicy: this.commandPolicy,
      authorityRows: this.managed ? this.sourceRows : this.rows });
    const ids = new Set(collections.flatMap(k => data[k].map(r => r.id)));
    // P9: a row only the new blocks carry is a source revision as well, so a panel that watches revisions sees the
    // decision it is looking at change. Nothing is added for a team without those rows.
    for (const key of extraCollections) for (const row of (Array.isArray(data[key]) ? data[key] : [])) ids.add(row.id);
     for (const row of rows.values()) if (row.entityId.startsWith("read-model:") && (this.rows.get(actor)?.role === "root" || row.owner === actor)) ids.add(row.entityId);
    return { schemaVersion: 1, asOfSeq: seq, sourceRevisions: Object.fromEntries([...rows].filter(([id]) => ids.has(id)).map(([id, row]) => [id, row.revision])), stale: false, viewer: actor, retention: this.managed ? { recentLimit:this.recentLimit, historicalReplay:"atomic-checkpoint-and-bounded-tail", checkpointEpoch:this.epoch } : { recentLimit:this.recentLimit, historicalReplay:"durable-event-log" }, data };
  }
  snapshot(actor) { this.sync(); return this.envelope(actor); }
  events(actor, after, {limit = Infinity, checkpointEpoch = null} = {}) {
    this.sync();
    if (!Number.isSafeInteger(after) || after < 0 || after > this.seq) throw Error('INVALID_CURSOR');
    if (this.managed && (checkpointEpoch !== this.epoch || after < this.baseSeq)) throw Object.assign(Error('RESYNC_REQUIRED'), {
      code: 'RESYNC_REQUIRED', resync: true, checkpointEpoch: this.epoch, replayAfterSeq: this.baseSeq, asOfSeq: this.seq,
    });
    if(after===this.seq)return [];
    const rows = new Map(this.managed ? this.baseRows : []);
    const visible = raw => { const kept = this.managed ? new Map(raw) : raw; retain(kept,this.recentLimit,{protocol:this.protocol}); return kept; };
    const initial = this.managed ? visible(rows) : rows;
    let previous = this.managed && initial.has(actor) ? this.envelope(actor, initial, this.baseSeq).data : null;
    const result = [];
    for (const e of (this.managed ? this.history : (this.reader.scanEvents?.(0) ?? this.reader.events(0)))) {
      reduce(rows, e, this.managed ? null : this.reader);
      const displayed = visible(rows);
      if (e.seq < after) continue;
      const current = displayed.has(actor) ? this.envelope(actor, displayed, e.seq).data : null;
      if (e.seq === after) { previous = current; continue; }
      const delta = { schemaVersion: 1, seq: e.seq, upserts: {}, removes: {}, stale: false };
      if (current) {
        for (const key of collections) {
          const before = new Map((previous?.[key] ?? []).map(r => [r.id, r]));
          delta.upserts[key] = current[key].filter(r => JSON.stringify(comparableRow(r)) !== JSON.stringify(comparableRow(before.get(r.id))));
          delta.removes[key] = [...before.keys()].filter(id => !current[key].some(r => r.id === id));
        }
        for (const key of extraCollections) {
          if (current?.[key] === undefined && previous?.[key] === undefined) continue;
          // P5: a v1 envelope always carries resourceThreads (possibly empty); do not stream two empty arrays on every
          // unrelated event. The comparison stays exact when either side has a row.
          if (!(current?.[key] ?? []).length && !(previous?.[key] ?? []).length) continue;
          const before = new Map((previous?.[key] ?? []).map(r => [r.id, r]));
          const now = current?.[key] ?? [];
          // The P7 blocks are compared with the same clock-free view as the legacy collections: their rows carry
          // ttlRemainingMs/expired, which change every millisecond and would report an untouched decision as changed.
          delta.upserts[key] = now.filter(r => JSON.stringify(comparableRow(r)) !== JSON.stringify(comparableRow(before.get(r.id))));
          delta.removes[key] = [...before.keys()].filter(id => !now.some(r => r.id === id));
        }
        for (const key of extraBlocks) {
          const was = previous?.[key];
          const now = current?.[key];
          if (was === undefined && now === undefined) continue;
          if (JSON.stringify(now) !== JSON.stringify(was)) delta[key] = now ?? null;
        }
        delta.goal = current.goal;
         delta.groups = current.groups; delta.restrictedMembers = current.restrictedMembers;
         const env = this.envelope(actor, displayed, e.seq); delta.sourceRevisions = env.sourceRevisions; delta.viewer = actor;
      }
      result.push(delta); previous = current; if(result.length>=limit)break;
    }
    return result;
  }
  /**
   * P12: the records timeline for this reader, translated from the bounded committed-event tail.
   * Query: kind (anomaly|needs-you|root-decision|delivery), member, from, to, afterSeq, limit.
   */
  activity(actor, query = {}) {
    this.sync();
    const me = this.rows.get(actor);
    if (!me) throw Error('UNKNOWN_ACTOR');
    const allowed = row => canSee(this.rows.get(row.entityId), me, actor);
    // Checkpoint replay history is not the journal: startup/reset must not erase retained activity.
    const tail = this.eventLog.readEventTail?.({ limit: this.recentLimit, throughSeq: this.seq });
    const events = tail?.events ?? this.history;
    const replayAfterSeq = tail?.replayAfterSeq ?? (events.length ? events[0].seq - 1 : this.seq);
    const visibleRows = new Map([...this.rows].filter(([, row]) => allowed(row)));
    return activityEvents(events, { ...query, allowed, rows: visibleRows, replayAfterSeq, asOfSeq: this.seq });
  }
  /**
   * P2: resolve the live router first, then the synchronized member row under the caller's current visibility.
   * Owner conversations are not nativeRef values. No router port means no authenticated binding answer.
   */
  binding(actor, sessionId) {
    this.sync();
    const me = this.rows.get(actor);
    if (!me || typeof sessionId !== 'string' || !sessionId || !this.routeSession) return null;
    const route = this.routeSession(sessionId);
    if (!route?.routed || route.teamId !== this.identity?.teamId) return null;
    const row = route.kind === 'owner'
      ? [...this.rows.values()].find(row => row.entityId.startsWith('member:') && row.role === 'root')
      : this.rows.get(route.memberId);
    if (!row || !canSee(row, me, actor) || (route.kind !== 'owner' && row.generation !== route.generation)) return null;
    return { teamId: route.teamId, role: route.kind === 'owner' ? 'leader' : 'member', memberId: row.entityId };
  }
}
