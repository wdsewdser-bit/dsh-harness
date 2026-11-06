import { principalId } from './authority.mjs';
// Consumer-side projection contract and client (09 §3.1, 08 §5).
// ui depends only on this shape; it never imports server stores (08 §1.2).

/**
 * @typedef {'root'|'coordinator'|'worker'|'verifier'} Role
 * @typedef {'requested'|'creating'|'bound'|'active'|'freezing'|'frozen'|'resuming'|'retiring'|'retired'|'unknown'} MemberState
 * @typedef {{state:'active'|'released'|'expired'|'revoked', expiresAt:number, fence:number}} Lease
 * @typedef {{id:string, n:number, state:'queued'|'admitted'|'starting'|'running'|'checkpointed'|'produced'|'cancelled'|'failed'|'unknown',
 *   lease:Lease|null, worktree:string|null, superseded:Array<{n:number,state:string}>, capabilities?:Record<string,Capability>}} Attempt
 * @typedef {{kind:'Approval'|'TaskAccepted'|'ArtifactPublished'|'MessageResponsibility'|'Decision'|'ExternalEvidence',
 *   ref:string, label:string, memberRef?:string, openedAt:number, deadline:number, state:'pending'|'satisfied'|'timed-out'}} WaitDependency
 * Context usage. `pct` is RELATIVE TO THE 75% HARD LIMIT (100 = at the limit): pct = 100·inputTokens/limitTokens,
 * limitTokens = limitRatio·window (P4B §7.1). Never divide by GATE_RATIO again. The counters below are optional: they
 * exist only when committed facts exist; absent means unknown (never 0).
 * @typedef {{pct:number, window:number, inputTokens:number, limitRatio?:number, limitTokens?:number, logRevision?:number|null,
 *   hardGateHits?:number, truncRefs?:number, snapshotTokens?:number,
 *   fold?:{enabled:boolean, count:number, last:null|{at:number, masked:number, revFrom:number, revTo:number}}}} ContextUsage
 * @typedef {{status:'known'|'unknown', limitRatio:number, reason?:string|null}} ContextStatus
 * @typedef {{id:string, name:string, role:Role, group:string, generation:number, desired:MemberState, observed:MemberState,
 *   history:Array<string|{at:number|null, kind:string, ref:string|null, text:string}>, attempt:Attempt|null, taskId:string|null,
 *   wait:(WaitDependency&{targetLabel?:string|null})|null, context:ContextUsage|null, contextStatus?:ContextStatus,
 *   activity?:MemberActivity|null, capabilities?:Record<string,Capability>,
 *   delegation:{scope:string, risk:string, budgetUsed:number, budget:number, expiresAt:number}|null, nativeRef:string|null,
 *   checkpointAt:number|null, revision:number}} Member
 * @typedef {{id:string, label:string, lead:string|null}} Group
 * @typedef {{id:string, title:string, state:'draft'|'ready'|'blocked'|'executing'|'produced'|'verifying'|'verified'|'integrating'|'merged'|'accepted'|'cancelled'|'failed',
 *   owner:string, contractRevision:number, attempts:Array<{n:number,state:string,supersededBy?:number}>,
 *   delivery:null|{revision:number, certificate:'valid'|'invalid'|null, merge:'prepared'|'confirmed'|'stale'|'unknown'|null}, revision:number,
 *   capabilities?:Record<string,Capability>}} Task
 * @typedef {{id:string, question:string, owner:string, escalationOwner:string, requiredRespondents:Array<{member:string, revision:number|null}>,
 *   openedAt:number, deadline:number, state:'open'|'collecting'|'deciding'|'decided'|'escalated'|'closed'|'cancelled'|'superseded',
 *   proposalRevision:number, supersededRevisions:number[], replies:Array<{member:string, revision:number, text:string, artifact?:string}>,
 *   lateEvidence:Array<{member:string, text:string}>, affectedTasks:string[], decisionRevision:number|null, revision:number,
 *   kind?:'decision'}} Thread
 * P5: resource threads are a separate collection, never a Thread row with empty respondents.
 * @typedef {{memberId:string, generation:number, subscriptionEpoch:number, state:'active'|'paused'|'closed',
 *   startAfterSeq?:number, visibleThrough?:number, pending:number}} ResourceSubscription
 * @typedef {{id:string, threadRef?:string, kind:'resource', status:'open'|'closed', owner:string,
 *   resource:{kind:'branch'|'pr'|'file-area', repositoryKey:string, key:any}, head:number, retainedFrom:number,
 *   pending?:number, descriptionRef?:string|null, subscribers:ResourceSubscription[],
 *   lastEvent:null|{seq:number, eventType:string, summary:string, actor:string, occurredAt:number|null}, revision:number}} ResourceThread
 * @typedef {{normal:{current:number, limit:number|null, unknown?:number, queued?:number, oldestAge?:number|null},
 *   human:{current:number, limit:1, unknown?:number, queued?:number, oldestAge?:number|null}, unknown:number,
 *   admissionClosed:boolean, queued?:number, oldestAge?:number|null,
 *   blocked?:Array<{originRef:string, recipient?:string, reason:string}>,
 *   occupants?:Array<{ref:string, originRef?:string, holderRef?:string, state:string, lane:string}>,
 *   providerCapacity:'unknown'|'available'|'throttled', providerWait?:'none'|'local-queued'|'provider-throttled',
 *   providerRetryAfterMs?:number|null, providerRecoveryAt?:number|null}} CapacityStatus
 * @typedef {{coordinatorOnly:true, policy:{deny:string[], allow:string[], unknown:'deny'},
 *   installed:boolean|null, revoked:boolean|null, denials:number, allows:number, auditPersistFailed:boolean|null,
 *   declared:string[]|null, audit:{denied:number, allowed:number,
 *     byTool:Array<{identity:string, allowed:number, denied:number}>|null}}} RoleGuardStatus
 * @typedef {{id:string, memberId:string|null, generation:number|null, cutoffSeq:number|null, items:number,
 *   pendingCount:number|null, omittedCount:number|null, nextCursor:number|null, injectedAt:number|null,
 *   revision:number|null}} InputBatch
 * @typedef {{batches:InputBatch[], latest:InputBatch|null, count:number}} InputBatchStatus
 * @typedef {{at:number, evidence?:string}} Receipt
 * M6 (16 §6): what one command means for this reader. `allowed` decides rendering; `reasonText` is the sentence
 * for diagnostics only: v3 hides disallowed actions instead of showing disabled controls.
 * @typedef {{allowed:boolean, reasonCode:string|null, reasonText:string|null}} Capability
 * M6 P5: what a member is doing now. Absent for a frozen, retiring or unknown member (the lifecycle is shown instead).
 * @typedef {{kind:'running'|'idle'|'maintenance', sub:string|null, since:number|null,
 *   tool?:{name:string, elapsed:number}}} MemberActivity
 * M6 P6: a proposal window, with each recipient's delivery, answer and whether it was seen when the window closed.
 * @typedef {{id:string, from:string|null, summary:string|null, openedAt:number|null, closesAt:number|null,
 *   state:string|null, recipients:Array<{member:string, delivery:'stored'|'visible', reply:string|null, reason:string|null,
 *   at:number|null}>, passedAt:number|null, unseenAtPass:string[], revision:number}} Intent
 * M6 N2: one thing the owner must decide. `primary` is null when the verdict belongs to the operator, and `note` then
 * says where it is decided: the browser never renders a button it cannot submit.
 * @typedef {{id:string, issueKey?:string, sources?:string[], question:string, why:string,
 *   waitingSince:number|null, waitingMs?:number|null, consequence:string,
 *   primary:null|{command:string, label:string}, note?:string, severity:'warn'|'bad',
 *   subject:{type:string, id:string|null}}} Escalation
 * @typedef {{id:string, from:string, to:string, kind:'info'|'action'|'decision'|'intent', openedAt:number, deadline:number|null,
 *   lifecycle:'stored'|'pending-visible'|'visible'|'accepted'|'resolved'|'cancelled'|'expired'|'dead-letter'|'unknown',
 *   expectedOutcome:string, generation:number, receipts:{stored:Receipt|null, visible:(Receipt&{requestId:string, manifest:string, seq:number})|null, accepted:(Receipt&{checkpoint:string})|null},
 *   delayReason:string|null, escalatedTo:null|{member:string, at:number}, rebinds:Array<{from:number,to:number,at:number}>, revision:number}} Message
 * @typedef {{id:string, kind:'merge'|'external'|'delivery'|'read-model', ref:string, summary:string,
 *   evidence:Array<{at:number|null, text:string|null, ref:string}>, openedAt:number, revision:number,
 *   class?:'effect'|'read-model', effectKind?:string|null, capabilities?:Record<string,Capability>}} UnknownEffect
 * @typedef {{id:string, kind:'scope', member:string, task:string, summary:string, diff:string[], deadline:number|null, openedAt?:number,
 *   contractRevision?:number, revision:number}} ApprovalRequest
 * Goal gate = the LAST COMMITTED completion check (semantics 'last-committed-check'); it is history, not an authorization.
 * @typedef {{status:'allowed'|'blocked'|'unknown', revision?:number, evaluatedAt?:number, sourceSeq?:number, semantics?:'last-committed-check'}} GoalGate
 * @typedef {{id:string, title:string, status?:'known'|'unknown', native?:object|null, source?:{sessionId:string, seq:number}|null, gate?:GoalGate,
 *   acceptanceGaps:number|null, completionToken:'none'|'prepared'|'authorized'|'consumed'}} Goal
 * M6 (16 §6 N1/N3/N4): the three summaries the panel renders verbatim. Computed by the projection so two panels never
 * disagree about what is most urgent.
 * @typedef {{working:number, accepted:number, total:number,
 *   headline:{kind:'ok'|'root-handling'|'needs-you', text:string, targetRef:string|null}}} PanelSummary
 * @typedef {{normal:number, stuck:number, paused:number, retiring:number, idle:number, stuckHandledBy:string|null}} MemberSummary
 * @typedef {{produced:number, verifying:number, merged:number, accepted:number, total:number}} DeliveryProgress
 * @typedef {{goal:Goal, restrictedMembers:number, groups:Group[], members:Member[], tasks:Task[], threads:Thread[], messages:Message[],
 *   unknownEffects:UnknownEffect[], approvals:ApprovalRequest[], approvalsStatus?:{status:'known'|'unknown', source?:string},
 *   summary?:PanelSummary, memberSummary?:MemberSummary, delivery?:DeliveryProgress, escalations?:Escalation[],
 *   intents?:Intent[], team?:{name:string|null, leaderSessionId:string|null, createdAt:number|null}|null,
 *   viewerRole?:Role|'viewer',
 *   resourceThreads?:ResourceThread[], capacity?:CapacityStatus, roleGuard?:RoleGuardStatus,
 *   inputs?:InputBatchStatus}} TeamView
 * @typedef {{schemaVersion:number, asOfSeq:number, sourceRevisions:Record<string,number>, stale:boolean, viewer?:string, data:TeamView}} Envelope
 * P12 initial pages show the latest retained commits first; nextBeforeSeq/beforeSeq walk toward older commits.
 * afterSeq remains a separate forward incremental cursor. Do not combine beforeSeq and afterSeq.
 * An expired cursor returns RESYNC_REQUIRED with replayAfterSeq.
 * @typedef {{seq:number, at:number, kind:string, category:string, id:string, text:string, tags:string[],
 *   subject:{type:string,id:string,name:string}, members:string[]}} ActivityEvent
 * @typedef {{events:ActivityEvent[], total:number, categories:string[], replayAfterSeq:number, asOfSeq:number,
 *   nextAfterSeq:number, nextBeforeSeq:number|null, hasMore:boolean}} ActivityPage
 * WP-1 publishes M6 replacements in ProjectionEvent. The pre-WP-4 ProjectionClient below does not yet apply those
 * new blocks: the WP-1 HTTP/SSE contract test uses an explicit whole-block reducer, not a claim of UI rendering.
 * Events carry entity upserts/removes plus whole-value replacements of goal, groups, restrictedMembers,
 * sourceRevisions and viewer when present (P4B §7.1).
 * @typedef {{schemaVersion:number, seq:number, upserts?:Partial<Record<'members'|'tasks'|'threads'|'messages'|'unknownEffects'|'approvals'|'resourceThreads', any[]>>,
 *   removes?:Partial<Record<string,string[]>>, goal?:Goal, groups?:Group[], restrictedMembers?:number,
 *   capacity?:CapacityStatus, roleGuard?:RoleGuardStatus, inputs?:InputBatchStatus,
 *   summary?:PanelSummary|null, memberSummary?:MemberSummary|null, delivery?:DeliveryProgress|null, escalations?:Escalation[]|null,
 *   intents?:Intent[]|null, team?:TeamView['team']|null, viewerRole?:Role|'viewer',
 *   sourceRevisions?:Record<string,number>, viewer?:string, stale?:boolean}} ProjectionEvent
 *
 * A ProjectionSource is the only seam the UI reads through: mock.mjs (default) or
 * real-source.mjs (`GET /team/projection/snapshot?view=team` + SSE `/team/projection/stream?afterSeq=`).
 * `onActivity` reports non-business liveness (SSE comment frames such as `: connected` / `: heartbeat`): it only
 * refreshes the connection-health clock, never data or seq. `describe().heartbeat === false` declares a source
 * without such a channel (then a quiet stream is not evidence of lag). The viewer comes from the envelope/events.
 * @typedef {{
 *   snapshot(view:string): Promise<Envelope>,
 *   subscribe(afterSeq:number, onEvent:(e:ProjectionEvent)=>void, onStatus:(s:'open'|'closed'|'resync')=>void, onActivity?:(kind:string)=>void): ()=>void,
 *   describe(): {kind:'mock'|'http', label:string, viewer?:string|null, heartbeat?:boolean}
 * }} ProjectionSource
 *
 * Commands never mutate local state: the gateway returns a receipt and the projection
 * later reflects (or not) the server's decision (09 §3.3).
 * @typedef {{operationId:string, status:'accepted'|'rejected'|'conflict'|'unknown', revision:number|null, entityId:string, message?:string}} CommandReceipt
 * @typedef {{submit(command:{name:string, target:string, expectedRevision:number|null, args:Record<string,unknown>}): Promise<CommandReceipt>}} CommandGateway
 */

export const SCHEMA_VERSION = 1;
export const FRESHNESS = Object.freeze({ lagMs: 5000, staleMs: 15000 });
/**
 * The 75% hard limit the server reports as `limitRatio` (packages/context/budget.mjs: GATE_RATIO). The client bundle
 * is a concatenation of src/*.mjs with every import stripped (build.mjs) and ui may not reach into the server
 * packages, so the display layer states the ratio once, here, and mock.mjs references it instead of spelling the
 * number. verification/context-budget.test.mjs pins this value equal to the server's GATE_RATIO, so the two copies
 * the bundle boundary forces cannot drift apart silently.
 */
export const GATE_RATIO = 0.75;

/**
 * Server command contract (P4B-REPORT §1, packages/projections/commands.mjs). Every command:
 * `{name, target, expectedRevision:<int, current revision of target>, args}`; null/old revision → conflict.
 * Supply a stable operationId for retries; same actor/intent/CAS replays the durable receipt.
 * New administrative writes require operator/root; unknown adjudications require operator itself.
 * decision = effective | not-effective | abandoned, evidenceRef = an existing durable entity.
 * Adjudication records the verdict without clearing unknown or replaying any external effect.
 * Mock and real gateways follow the same table so the UI cannot drift from the server.
 */
export const COMMANDS = Object.freeze({
  'organization.requestFreeze': { target: 'member', args: ['reason'] },
  'organization.requestResume': { target: 'member', args: ['reason'] },
  'organization.retire': { target: 'member', args: ['reason'] },
  // Operator-only stop close-out (§6 #12 of the M6 plan): the browser never offers it and the server answers every
  // non-operator actor with ROLE_DENIED. It is listed because this table mirrors the server bridge, not because a
  // logged-in viewer may submit it; the target is the ambiguous attempt row, and evidenceRef names the stop evidence.
  'organization.confirmStopped': { target: 'attempt', args: ['evidenceRef'] },
  'threads.escalate': { target: 'thread', args: ['reason'] },
  'mailbox.cancelMessage': { target: 'message', args: ['reason'] },
  'mailbox.rebind': { target: 'message', args: ['recipient', 'evidenceRef'] },
  // Operator-only adjudication annotation; unknown remains quarantined, with no replay.
  'mailbox.resolveUnknown': { target: 'message', args: ['decision', 'evidenceRef'] },
  'scheduler.approveContract': { target: 'task', args: ['contractRevision'] },
  // Operator verdict only; unknown is not converted into certified acceptance or retryable work.
  'delivery.reconcile': { target: 'delivery', args: ['decision', 'evidenceRef'] },
  'threads.decide': { target: 'thread', args: ['proposalRevision', 'conclusionRef'] },
  // P5 (§3.2): resource threads are read and written through the same thread id space. A viewer may act for itself;
  // root/operator may name another member, and the server rechecks subscription/ownership inside the transaction.
  'threads.openResource': { target: 'thread', args: ['resource', 'descriptionRef', 'owner', 'taskRef'] },
  'threads.subscribe': { target: 'thread', args: ['memberId', 'replayFrom'] },
  'threads.unsubscribe': { target: 'thread', args: ['memberId', 'reason'] },
  'threads.publish': { target: 'thread', args: ['eventType', 'summary', 'bodyRef'] },
  'threads.closeResource': { target: 'thread', args: ['reason'] },
  // target === args.recipient; expectedRevision = recipient member revision; summary carries the body.
  'mailbox.send': { target: 'member', args: ['recipient', 'kind', 'summary', 'deadlineMin', 'expectedOutcome'] },
});
/** Commands the UI knows about but the server answers with UNSUPPORTED_COMMAND: shown disabled, with the reason. */
export const UNSUPPORTED_COMMANDS = Object.freeze({
  'goal-gate.authorizeCompletion': 'UNSUPPORTED_COMMAND：缺少 UI 到原生 guarded complete/flush 的会话绑定协议；不能越过 completion token 和完成栅栏',
});
/** @returns {string|null} why `name` cannot be submitted, or null when the server accepts it. */
export function unsupportedReason(name) {
  if (COMMANDS[name]) return null;
  return UNSUPPORTED_COMMANDS[name] ?? `服务端没有 ${name} 命令（UNSUPPORTED_COMMAND）`;
}

/**
 * Runtime source selection. The host half (index.mjs) publishes `globalThis.__DSH_TEAM__` into the
 * natively-authenticated index page only when the team profile configures a real source; otherwise the
 * browser falls back to the mock source (stage-1 behaviour).
 * @typedef {{source:'mock'} | {source:'http', base:string, token:string, viewer:string|null}} TeamSourceConfig
 */
export const TEAM_CONFIG_GLOBAL = '__DSH_TEAM__';
/** @returns {TeamSourceConfig} */
export function resolveTeamConfig(raw) {
  if (!raw || raw.source !== 'http') return { source: 'mock',
    ...(raw?.fixture ? { fixture: raw.fixture } : {}), ...(raw?.viewer ? { viewer: raw.viewer } : {}) };
  if (typeof raw.base !== 'string' || !/^https?:\/\/[^/]+$/.test(raw.base)) throw Error('client-team: config.base must be an origin');
  if (typeof raw.token !== 'string' || !raw.token) throw Error('client-team: config.token missing');
  const viewer = typeof raw.viewer === 'object' && raw.viewer?.teamId && raw.viewer?.memberId ? raw.viewer
    : typeof raw.viewer === 'string' && raw.viewer.startsWith('member:') ? raw.viewer : null;
  return { source: 'http', base: raw.base, token: raw.token, viewer };
}
const COLLECTIONS = ['members', 'tasks', 'threads', 'messages', 'unknownEffects', 'approvals', 'resourceThreads',
  'decisions', 'auditTrail', 'stopProofs'];

/** Apply one in-order server event: entity replacement by id, never field merging or local inference. */
export function applyEvent(data, event) {
  const next = { ...data };
  if (event.goal) next.goal = event.goal;
  // Whole-value metadata replacements (not merges): groups and the restricted-member count.
  if (Array.isArray(event.groups)) next.groups = event.groups;
  if (typeof event.restrictedMembers === 'number') next.restrictedMembers = event.restrictedMembers;
  // P5: capacity/roleGuard/inputs are whole blocks read from committed facts; they are never merged field by field.
  if (event.capacity !== undefined) next.capacity = event.capacity;
  if (event.roleGuard !== undefined) next.roleGuard = event.roleGuard;
  if (event.inputs !== undefined) next.inputs = event.inputs;
  // M6 N1/N3/N4/N2/P6/P2/P3/P4: these blocks are computed by the projection as a whole. An event replaces the value
  // (null clears it); the client never merges them field by field and never re-derives the summary itself.
  for (const key of ['summary', 'memberSummary', 'delivery', 'escalations', 'intents', 'team']) {
    if (event[key] !== undefined) next[key] = event[key];
  }
  if (event.viewerRole !== undefined) next.viewerRole = event.viewerRole;
  for (const key of COLLECTIONS) {
    const up = event.upserts?.[key], rm = event.removes?.[key];
    if (!up && !rm) continue;
    // resourceThreads is absent on an off envelope; an event for it always carries the upserts it needs.
    const byId = new Map((data[key] ?? []).map(item => [item.id, item]));
    for (const id of rm ?? []) byId.delete(id);
    for (const item of up ?? []) byId.set(item.id, item);
    if (['decisions', 'auditTrail', 'stopProofs'].includes(key) && byId.size === 0) delete next[key];
    else next[key] = [...byId.values()];
  }
  return next;
}

/**
 * Snapshot + ordered stream client. Gap, schema change or reconnect drops local state and
 * re-GETs the snapshot (09 §3.1). Freshness is derived from wall clock, not inferred data.
 */
export class ProjectionClient {
  constructor(source, options = {}) {
    this.source = source;
    this.view = options.view ?? 'team';
    this.expectedTeam = options.teamId ?? null;
    this.now = options.now ?? (() => Date.now());
    const caps = source.describe?.() ?? {};
    this.state = { status: 'loading', schemaVersion: null, asOfSeq: null, sourceRevisions: {}, serverStale: false,
      streamOpen: false, streamClosedAt: null, lastEventAt: null, lastActivityAt: null, data: null, error: null, resyncs: 0, retryAt: null,
      // Viewer: authoritative principal from the envelope/events; describe().viewer is only a pre-snapshot hint.
      sourceKind: caps.kind ?? 'mock', viewer: caps.viewer ?? null, heartbeat: caps.heartbeat !== false,
      // M6 §WP-4 / 15 §2.1-2: which team this stream belongs to, as the envelope declared it.
      teamId: null };
    this.listeners = new Set();
    this.unsubscribe = null;
    this.generation = 0;
  }
  getSnapshot = () => this.state;
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  set(patch) { this.state = { ...this.state, ...patch }; for (const l of this.listeners) l(); }
  async start() { await this.resync('start'); }
  stop() { this.generation++; clearTimeout(this.retryTimer); this.unsubscribe?.(); this.unsubscribe = null; }
  async resync(reason) {
    const generation = ++this.generation;
    clearTimeout(this.retryTimer);
    this.unsubscribe?.(); this.unsubscribe = null;
    try {
      const env = await this.source.snapshot(this.view);
      if (generation !== this.generation) return;
      const teamId = env.teamId ?? env.data?.team?.teamId ?? null;
      if (this.expectedTeam && teamId !== this.expectedTeam) throw Error('TEAM_IDENTITY_MISMATCH');
      this.set({ status: 'ready', principal: env.viewer ?? null,
        viewer: env.viewer === undefined ? this.state.viewer : principalId(env.viewer, teamId), schemaVersion: env.schemaVersion, asOfSeq: env.asOfSeq, sourceRevisions: env.sourceRevisions,
        teamId: env.teamId ?? env.data?.team?.teamId ?? null,
        serverStale: env.stale, data: env.data, error: null, lastEventAt: this.now(), retryAt: null, streamClosedAt: null,
        resyncs: this.state.resyncs + (reason === 'start' ? 0 : 1), lastResyncReason: reason });
      this.unsubscribe = this.source.subscribe(env.asOfSeq, event => this.onEvent(event, generation), status => this.onStatus(status, generation),
        kind => this.onActivity(kind, generation));
    } catch (error) {
      if (generation !== this.generation) return;
      const retryAt = this.now() + 5000;
      // Keep the last good asOfSeq visible in the error state (09 §3.2 situation bar error).
      this.set({ status: this.state.data ? 'ready' : 'error', error: String(error?.message ?? error), retryAt, serverStale: true });
      this.retryTimer = setTimeout(() => { if (generation === this.generation) this.resync('retry'); }, 5000);
    }
  }
  onEvent(event, generation) {
    if (generation !== this.generation) return;
    // Switching sessions: an event that still carries the previous team's id is dropped before it can advance seq or
    // paint team A's rows on team B. Not a gap (that would resync the wrong stream), just a stale frame.
    if (event.teamId != null && this.state.teamId != null && event.teamId !== this.state.teamId) return;
    if (event.schemaVersion !== this.state.schemaVersion) return void this.resync('schema');
    if (event.seq !== this.state.asOfSeq + 1) return void this.resync('gap');
    this.set({ asOfSeq: event.seq, data: applyEvent(this.state.data, event), lastEventAt: this.now(),
      sourceRevisions: event.sourceRevisions ?? this.state.sourceRevisions,
      principal: event.viewer === undefined ? this.state.principal : event.viewer,
      viewer: event.viewer === undefined ? this.state.viewer : principalId(event.viewer, this.state.teamId),
      serverStale: event.stale ?? this.state.serverStale });
  }
  /** Liveness only (heartbeat/connected comments): updates the activity clock, never data, seq or lastEventAt. */
  onActivity(kind, generation) {
    if (generation !== this.generation) return;
    this.set({ lastActivityAt: this.now(), lastActivityKind: kind });
  }
  onStatus(status, generation) {
    if (generation !== this.generation) return;
    if (status === 'resync') return void this.resync('retention');
    // Reconnect after a drop: never trust the gap, re-read the snapshot (09 §3.1).
    if (status === 'open' && this.state.streamClosedAt != null) return void this.resync('reconnect');
    if (status === 'open') this.set({ streamOpen: true, streamClosedAt: null });
    else this.set({ streamOpen: false, streamClosedAt: this.now() });
  }
}

/**
 * Freshness classification shared by every Team view (09 §3.1). Without a heartbeat channel
 * (`state.heartbeat === false`) a quiet stream is not evidence of lag, so only the connection
 * state and the server stale flag decide; `heartbeat:false` is reported so the UI can say so.
 */
export function freshness(state, now) {
  if (state.status === 'loading') return { level: 'loading', lagMs: 0 };
  if (state.status === 'error') return { level: 'error', lagMs: 0 };
  // Connection health: the latest business event OR liveness comment, whichever is newer.
  const lastSeen = Math.max(state.lastEventAt ?? 0, state.lastActivityAt ?? 0) || now;
  const lagMs = Math.max(0, now - lastSeen);
  const closedFor = state.streamOpen ? 0 : now - (state.streamClosedAt ?? now);
  if (state.heartbeat === false) {
    // A stream that has not delivered its first byte yet is "connecting", not dropped: only a recorded close counts.
    if (state.serverStale || closedFor > FRESHNESS.staleMs) return { level: 'stale', lagMs, heartbeat: false };
    return { level: !state.streamOpen && state.streamClosedAt != null ? 'lagging' : 'fresh', lagMs, heartbeat: false };
  }
  if (state.serverStale || closedFor > FRESHNESS.staleMs || lagMs > FRESHNESS.staleMs) return { level: 'stale', lagMs };
  if (lagMs > FRESHNESS.lagMs) return { level: 'lagging', lagMs };
  return { level: 'fresh', lagMs };
}
