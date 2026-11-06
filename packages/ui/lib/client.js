window.__ModuleLoader__.load({
	id: "@dsh-v2/client-team",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const ReactDOM = require("react-dom");
//#region src/projection.mjs
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

const SCHEMA_VERSION = 1;
const FRESHNESS = Object.freeze({ lagMs: 5000, staleMs: 15000 });
/**
 * The 75% hard limit the server reports as `limitRatio` (packages/context/budget.mjs: GATE_RATIO). The client bundle
 * is a concatenation of src/*.mjs with every import stripped (build.mjs) and ui may not reach into the server
 * packages, so the display layer states the ratio once, here, and mock.mjs references it instead of spelling the
 * number. verification/context-budget.test.mjs pins this value equal to the server's GATE_RATIO, so the two copies
 * the bundle boundary forces cannot drift apart silently.
 */
const GATE_RATIO = 0.75;

/**
 * Server command contract (P4B-REPORT §1, packages/projections/commands.mjs). Every command:
 * `{name, target, expectedRevision:<int, current revision of target>, args}`; null/old revision → conflict.
 * Supply a stable operationId for retries; same actor/intent/CAS replays the durable receipt.
 * New administrative writes require operator/root; unknown adjudications require operator itself.
 * decision = effective | not-effective | abandoned, evidenceRef = an existing durable entity.
 * Adjudication records the verdict without clearing unknown or replaying any external effect.
 * Mock and real gateways follow the same table so the UI cannot drift from the server.
 */
const COMMANDS = Object.freeze({
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
const UNSUPPORTED_COMMANDS = Object.freeze({
  'goal-gate.authorizeCompletion': 'UNSUPPORTED_COMMAND：缺少 UI 到原生 guarded complete/flush 的会话绑定协议；不能越过 completion token 和完成栅栏',
});
/** @returns {string|null} why `name` cannot be submitted, or null when the server accepts it. */
function unsupportedReason(name) {
  if (COMMANDS[name]) return null;
  return UNSUPPORTED_COMMANDS[name] ?? `服务端没有 ${name} 命令（UNSUPPORTED_COMMAND）`;
}

/**
 * Runtime source selection. The host half (index.mjs) publishes `globalThis.__DSH_TEAM__` into the
 * natively-authenticated index page only when the team profile configures a real source; otherwise the
 * browser falls back to the mock source (stage-1 behaviour).
 * @typedef {{source:'mock'} | {source:'http', base:string, token:string, viewer:string|null}} TeamSourceConfig
 */
const TEAM_CONFIG_GLOBAL = '__DSH_TEAM__';
/** @returns {TeamSourceConfig} */
function resolveTeamConfig(raw) {
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
function applyEvent(data, event) {
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
class ProjectionClient {
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
function freshness(state, now) {
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

//#endregion
//#region src/authority.mjs
// Identity must be confirmed against this team's members before roles or capabilities can grant a write.
function principalId(viewer, teamId = null) {
  if (typeof viewer === 'string') return viewer;
  if (!viewer || !teamId || viewer.teamId !== teamId) return null;
  return typeof viewer.memberId === 'string' && viewer.memberId.startsWith('member:') ? viewer.memberId : null;
}
function confirmedMember(data, viewer) {
  const id = principalId(viewer, data?.team?.teamId);
  const member = data?.members?.find(m => m.id === id);
  const denied = !id || id.startsWith('viewer:') || ['viewer', 'unknown'].includes(data?.viewerRole) ||
    ['viewer', 'unknown'].includes(member?.role) || (viewer !== 'operator' && !member);
  return { id, member, denied };
}
function viewerReadOnly(data, viewer) {
  const { id, member, denied } = confirmedMember(data, viewer);
  if (denied) return true;
  if (id === 'operator') return false;
  return member.role !== 'root' || (data?.viewerRole != null && !['root', 'operator'].includes(data.viewerRole));
}
function commandObject(data, target) {
  for (const key of ['members', 'tasks', 'threads', 'messages', 'unknownEffects', 'resourceThreads']) {
    const found = data?.[key]?.find(row => row.id === target);
    if (found) return found;
  }
  return data?.members?.map(m => m.attempt).find(a => a?.id === target) ?? null;
}
function commandAdmission(cmd, data, viewer, generation = null) {
  if (!cmd) return '没有可执行的命令';
  const { id, denied } = confirmedMember(data, viewer);
  if (denied) {
    return '只读查看：未确认写入身份，操作由 operator / root 处理';
  }
  if (cmd.principal !== undefined && cmd.principal !== id) return '身份已变化，请重新打开操作';
  if (cmd.scopeGeneration != null && cmd.scopeGeneration !== generation) return '团队会话已切换，请重新打开操作';
  const row = commandObject(data, cmd.target);
  if (row?.capabilities != null) {
    const cap = row.capabilities[cmd.name];
    if (cap?.allowed !== true) return cap?.reasonText ?? '服务端没有授予此操作权限';
  }
  return null;
}

//#endregion
//#region src/human-text.mjs
// Display-only normalization: confirmed references plus two explicit legacy alias contracts, never arbitrary prefixes.
function referenceIds(data, event = null) {
  const ids = new Set();
  const add = value => { if (typeof value === 'string' && value) ids.add(value); };
  for (const key of ['members', 'tasks', 'threads', 'messages', 'decisions', 'intents', 'unknownEffects',
    'approvals', 'resourceThreads', 'auditTrail', 'stopProofs']) {
    for (const row of data?.[key] ?? []) add(row.id);
  }
  for (const member of data?.members ?? []) { add(member.taskId); add(member.attempt?.id); add(member.wait?.ref); }
  add(event?.id); add(event?.subject?.id);
  for (const member of event?.members ?? []) add(member);
  return ids;
}
const COMPAT_REF = /^(?:task|int)-[0-9]+$/;
// Paths, filenames and hyphenated words are whole tokens; URLs (including query/fragment) are never rewritten.
const DISPLAY_TOKEN = /[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+|[A-Za-z0-9_./:-]+/g;
function humanText(value, fallback = '相关对象', references = []) {
  const known = references instanceof Set ? references : new Set(references);
  const text = String(value ?? '').replace(DISPLAY_TOKEN, token => {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(token)) return token;
    if (known.has(token) || COMPAT_REF.test(token)) return '';
    const bare = token.replace(/[.]+$/, '');
    return bare !== token && (known.has(bare) || COMPAT_REF.test(bare)) ? token.slice(bare.length) : token;
  }).replace(/\s+/g, ' ').trim();
  return text || fallback;
}

//#endregion
//#region src/labels.mjs
// The human-language dictionary (15-ui-design-v2.md §3.2). Constants only: WP-4 wires them into the panel; they live
// here from WP-3 so the wording has one home and the split itself changes no rendered text.
const ACTIVITY_TEXT = Object.freeze({
  running: '运行中', idle: '空闲', maintenance: '维护中', missing: '状态未知',
});
const ACTIVITY_COMPACTION_TEXT = '压缩上下文';
const MEMBER_STEP_TEXT = Object.freeze({
  requested: '已登记', creating: '正在创建', bound: '已绑定会话', active: '运行中', freezing: '正在暂停',
  frozen: '已暂停', resuming: '正在恢复', retiring: '正在退役', retired: '已退役', unknown: '状态不明',
});
const LIFECYCLE_TEXT = Object.freeze({
  starting: '正在启动', pausing: '正在暂停…', paused: '已暂停',
  retiring: '退役中…', retired: '已退役', unknown: '状态不明',
});
const TASK_STAGE_TEXT = Object.freeze({
  draft: '待批准', ready: '待开始', executing: '进行中', blocked: '卡住', produced: '已产出',
  verifying: '验证中', verified: '已验证', integrating: '合并中', merged: '已合并',
  accepted: '已验收', cancelled: '已取消',
});
const THREAD_STATE_TEXT = Object.freeze({
  open: '收集答复中', collecting: '收集答复中', deciding: '等待决定', escalated: '已升级',
  decided: '已决定', closed: '已关闭', cancelled: '已取消', superseded: '被新提案取代',
});
const MESSAGE_STEP_TEXT = Object.freeze({ stored: '已送达', visible: '看到', accepted: '接手' });
const MESSAGE_LIFECYCLE_TEXT = Object.freeze({
  resolved: '已办结', cancelled: '已取消', expired: '已过期', 'dead-letter': '死信',
});
const MESSAGE_KIND_TEXT = Object.freeze({
  action: '行动请求', decision: '决定请求', info: '通知', intent: '提议',
});
const INTENT_TEXT = Object.freeze({
  open: '反对窗口进行中', objected: '有反对 · 不会自动通过', passed: '自动通过',
  unseenAtPass: '▲ 通过时还没看到', ok: '同意', object: '反对',
  silent: '看到了 · 没表态', unseen: '已送达 · 还没看到',
});
const VIEWER_ROLE_TEXT = Object.freeze({
  root: '你是组长 · 可操作', operator: 'operator · 可裁决', viewer: '只读查看 · 无写权限',
  member: '成员 · 部分可操作', unknown: '身份未确认 · 暂不可操作',
});
const DELIVERY_TEXT = Object.freeze({
  valid: '证书有效', invalid: '证书失效', prepared: '合并中', confirmed: '合并已确认', unknown: '合并结果不明',
});

//#endregion
//#region src/transport.mjs
/** Browser-only authenticated HTTP transport and command gateway, no store imports; 08 §1.2, §5. */
function createTransport(base, token) {
  const read = async (path, init = {}) => {
    const response = await fetch(base + path, { ...init, headers: { authorization: 'Bearer ' + token, ...init.headers } });
    if (!response.ok) {
      const text = await response.text();
      let details = null; try { details = JSON.parse(text); } catch { /* retain original body in the error */ }
      throw Object.assign(Error('projection HTTP ' + response.status + (details?.error ? ': ' + details.error : '')), {
        status: response.status, code: details?.error ?? null, details, body: text,
      });
    }
    return response;
  };
  const gateway = { submit: async command => (await read('/team/commands', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) })).json() };
  return { read, gateway };
}

//#endregion
//#region src/real-source.mjs
/** SSE comment frame (`: connected`, `: heartbeat <ms>`): liveness only, no id/data, never a business event. */
function commentKind(frame) {
  const lines = frame.split('\n').filter(Boolean);
  if (!lines.length || !lines.every(line => line.startsWith(':'))) return null;
  return lines[0].slice(1).trim().split(/\s+/)[0] || 'comment';
}
/**
 * Real source implements the existing ProjectionSource/CommandGateway seam; 08 §5.
 * The viewer is read from the envelope/events (server-authenticated principal); `viewer` here is only an
 * optional pre-snapshot hint. Known/unknown of goal, context and approvals is read from the data itself.
 * The gateway never invents results: HTTP 4xx means the server refused before executing (rejected);
 * a transport failure is reported as unknown.
 */
function createRealSource({ base = 'http://127.0.0.1:40292', token, viewer = null, retryMs = 100, teamId = null } = {}) {
  const { read, gateway: transportGateway } = createTransport(base, token);
  let authenticatedTeam = teamId;
  let checkpointEpoch = null;
  const gateway = {
    async submit(command) {
      try { return await transportGateway.submit(command); } catch (error) {
        const message = String(error?.message ?? error);
        const status = /HTTP 4\d\d/.test(message) ? 'rejected' : 'unknown';
        return { operationId: command.operationId ?? '—', status, revision: null, entityId: command.target, message };
      }
    },
  };
  return { source: {
    describe: () => ({ kind: 'http', label: base.replace(/^https?:\/\//, ''), viewer, heartbeat: true }),
    snapshot: async view => { const snapshot = await (await read('/team/projection/snapshot?view=' + encodeURIComponent(view))).json();
      if (snapshot.teamId) { if (snapshot.viewer?.teamId !== snapshot.teamId || (authenticatedTeam && authenticatedTeam !== snapshot.teamId)) throw Error('TEAM_IDENTITY_MISMATCH'); authenticatedTeam = snapshot.teamId; }
      checkpointEpoch = snapshot.retention?.checkpointEpoch ?? null;
      return snapshot; },
    // These endpoints return plain objects (binding may be null), not snapshot envelopes.
    binding: async sessionId => {
      if (!sessionId) return null;
      const body = await (await read('/team/binding?sessionId=' + encodeURIComponent(sessionId))).json();
      if (body !== null && (typeof body !== 'object' || typeof body.teamId !== 'string' || typeof body.memberId !== 'string')) {
        throw Error('INVALID_BINDING');
      }
      return body;
    },
    activity: async (query = {}) => {
      const params = new URLSearchParams();
      for (const key of ['kind', 'member', 'from', 'to', 'afterSeq', 'beforeSeq', 'limit']) {
        if (query[key] !== undefined && query[key] !== null) params.set(key, String(query[key]));
      }
      const body = await (await read('/team/projection/activity?' + params.toString())).json();
      if (!body || !Array.isArray(body.events) || !Number.isSafeInteger(body.asOfSeq)) throw Error('INVALID_ACTIVITY');
      return body;
    },
    subscribe(afterSeq, onEvent, onStatus, onActivity = () => {}) {
      const epoch = checkpointEpoch;
      let stopped = false; let cursor = afterSeq; let controller; let timer; let failures = 0;
      const connect = async () => {
        controller = new AbortController();
        try {
          const response = await read('/team/projection/stream?afterSeq=' + cursor + (epoch === null ? '' : '&checkpointEpoch=' + epoch), { signal: controller.signal });
          if (stopped) return; failures = 0; onStatus('open');
          const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
          while (!stopped) {
            const { value, done } = await reader.read(); if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary;
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
              const comment = commentKind(frame);
              if (comment) { onActivity(comment); continue; }
              const data = frame.split('\n').find(line => line.startsWith('data: '));
              if (!data) continue;
              const event = JSON.parse(data.slice(6));
              if (event.error === 'RESYNC_REQUIRED') { onStatus('resync'); return; }
              if (authenticatedTeam && event.teamId !== authenticatedTeam) throw Error('TEAM_IDENTITY_MISMATCH');
              if (event.seq <= cursor) continue;
              if (event.seq !== cursor + 1) throw Error('STREAM_GAP');
              cursor = event.seq; onEvent(event);
            }
          }
        } catch (error) { if (stopped) return; if (error.code === 'RESYNC_REQUIRED') { onStatus('resync'); return; } }
        // Bounded backoff so a down projection service is not polled in a tight loop.
        if (!stopped) { onStatus('closed'); timer = setTimeout(connect, Math.min(5000, retryMs * 2 ** failures++)); }
      };
      connect(); return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
    },
  }, gateway, control: null };
}

//#endregion
//#region src/mock.mjs
// Mock projection source + command gateway for P4 stage 1 (no model, no network).
// Scenario follows the 08 §4.1–4.6 state model; swap for createHttpSource() later.

/** Principal the mock reads as: the operator works through the root principal, like the real token registry. */
const MOCK_VIEWER = 'member:root';
/**
 * Authoritative member ids are `member:*` (core). Fixtures are written with short names for readability;
 * this maps every member reference to the authoritative id (names stay short). 'operator' is the human,
 * who acts as the root principal. Idempotent.
 */
function authorityIds(data) {
  const id = x => x == null || x.startsWith('member:') ? x : x === 'operator' ? MOCK_VIEWER : 'member:' + x;
  return { ...data,
    groups: data.groups.map(g => ({ ...g, lead: id(g.lead) })),
    members: data.members.map(m => ({ ...m, id: id(m.id), wait: m.wait && { ...m.wait, ...(m.wait.memberRef ? { memberRef: id(m.wait.memberRef) } : {}) } })),
    tasks: data.tasks.map(t => ({ ...t, owner: id(t.owner) })),
    threads: data.threads.map(t => ({ ...t, owner: id(t.owner), escalationOwner: id(t.escalationOwner),
      requiredRespondents: t.requiredRespondents.map(r => ({ ...r, member: id(r.member) })), replies: t.replies.map(r => ({ ...r, member: id(r.member) })),
      lateEvidence: t.lateEvidence.map(r => ({ ...r, member: id(r.member) })) })),
    messages: data.messages.map(m => ({ ...m, from: id(m.from), to: id(m.to), escalatedTo: m.escalatedTo && { ...m.escalatedTo, member: id(m.escalatedTo.member) } })),
    approvals: data.approvals.map(a => ({ ...a, member: id(a.member) })),
    ...(data.resourceThreads ? { resourceThreads: data.resourceThreads.map(thread => ({ ...thread,
      owner: id(thread.owner),
      subscribers: thread.subscribers.map(sub => ({ ...sub, memberId: id(sub.memberId) })) })) } : {}) };
}

const S = 1000, M = 60 * S;

function lease(now, sec, state = 'active', fence = 17) { return { state, expiresAt: now + sec * S, fence }; }
/**
 * Fixture context, written as share of the model WINDOW for readability, emitted in the server contract:
 * pct relative to the 75% limit (P4B §7.1). Counters exist here because the mock models a future with
 * committed counters; real sources may omit them (UI shows unknown, never 0).
 */
function ctxUse(windowPct, extra = {}) {
  const window = 128000, limitRatio = GATE_RATIO, limitTokens = window * limitRatio;
  const inputTokens = Math.round(window * windowPct / 100);
  return { pct: Math.round(100 * inputTokens / limitTokens), window, inputTokens, limitRatio, limitTokens, logRevision: 40 + Math.round(windowPct),
    hardGateHits: windowPct >= 75 ? 1 : 0, truncRefs: extra.truncRefs ?? 0,
    fold: { enabled: extra.fold !== undefined, count: extra.fold ?? 0, last: extra.foldLast ?? null }, snapshotTokens: extra.snap ?? 1400 };
}
/**
 * M6 P5 stand-in: what the member is doing now, in the shape the projection publishes. Absent (null) for a session
 * that is paused, retiring or unknown — those show their lifecycle instead, never "空闲".
 */
function memberActivity(o, now) {
  const observed = o.observed ?? 'active', desired = o.desired ?? 'active';
  if (['unknown', 'retired', 'retiring', 'frozen'].includes(observed) || desired === 'frozen') return null;
  if (o.activity) return o.activity;
  if (o.attempt?.state === 'running') return { kind: 'running', sub: '执行任务', since: now - 12 * M, tool: { name: 'bash', elapsed: 6 * M + 12 * S } };
  return { kind: 'idle', sub: null, since: now - 25 * M };
}
function member(now, id, role, group, o = {}) {
  return { id, name: o.name ?? id, role, group, generation: o.gen ?? 1, desired: o.desired ?? 'active', observed: o.observed ?? 'active',
    history: o.history ?? ['requested', 'creating', 'bound', 'active'], attempt: o.attempt ?? null, taskId: o.task ?? null, wait: o.wait ?? null,
    activity: memberActivity(o, now),
    context: o.context === undefined ? ctxUse(30) : o.context,
    contextStatus: (o.context === undefined || o.context) ? { status: 'known', limitRatio: GATE_RATIO } : { status: 'unknown', limitRatio: GATE_RATIO, reason: 'no committed context record' },
    delegation: o.delegation ?? (role === 'worker' ? { scope: `${group}/**`, risk: 'low', budgetUsed: 0.4, budget: 4, expiresAt: now + 4 * 60 * M } : null),
    nativeRef: o.nativeRef ?? `ses-${id}-${(id.length * 7919).toString(16)}`, checkpointAt: o.checkpointAt ?? now - 2 * M, revision: o.revision ?? 3 };
}
function attempt(now, n, state, leaseSec, o = {}) {
  return { id: `att-${o.task ?? 'x'}-${n}`, n, state, lease: leaseSec == null ? null : lease(now, leaseSec, o.leaseState, o.fence),
    worktree: o.worktree ?? `wt-${n + 10}`, superseded: o.superseded ?? [] };
}
function msg(now, id, from, to, kind, o = {}) {
  const at = o.openedAt ?? now - 20 * M;
  const stored = { at, evidence: 'outbox committed' };
  const visible = o.visible ? { at: at + 5 * S, requestId: `r-${3300 + id.length * 13}`, manifest: '9f2c41ab7d', seq: 1203 } : null;
  const accepted = o.accepted ? { at: at + 60 * S, checkpoint: `cp-${12 + id.length}` } : null;
  return { id, from, to, kind, openedAt: at, deadline: o.deadline ?? null,
    lifecycle: o.lifecycle ?? (accepted ? (o.resolved ? 'resolved' : 'accepted') : visible ? 'visible' : 'stored'),
    expectedOutcome: o.expected ?? '', generation: o.gen ?? 1, receipts: { stored, visible, accepted },
    delayReason: o.delay ?? null, escalatedTo: o.escalatedTo ?? null, rebinds: o.rebinds ?? [], revision: o.revision ?? 1 };
}
function task(id, title, state, owner, o = {}) {
  return { id, title, state, owner, contractRevision: o.rev ?? 1, attempts: o.attempts ?? [{ n: 1, state: state === 'executing' ? 'running' : 'produced' }],
    delivery: o.delivery ?? null, revision: o.revision ?? 2 };
}

/** The default 17-member scenario (+2 ACL-restricted members), with authoritative member ids. */
function scenarioDefault(now) { return authorityIds(buildDefault(now)); }
function buildDefault(now) {
  const members = [
    member(now, 'root', 'root', 'root', { context: ctxUse(52, { fold: 1, snap: 2100 }), task: null }),
    member(now, 'sc-1', 'coordinator', 'engine', { context: ctxUse(46, { fold: 0 }) }),
    member(now, 'worker-a', 'worker', 'engine', { gen: 3, task: 'task-12', context: ctxUse(58, { fold: 2, truncRefs: 3, snap: 1900, foldLast: { at: now - 9 * M, masked: 16, revFrom: 38, revTo: 41 } }),
      attempt: attempt(now, 2, 'running', 41, { task: 'task-12', superseded: [{ n: 1, state: 'failed' }], worktree: 'wt-12' }),
      delegation: { scope: 'engine/render/**', risk: 'low', budgetUsed: 1.2, budget: 4, expiresAt: now + 3 * 60 * M } }),
    member(now, 'worker-b', 'worker', 'engine', { gen: 3, task: 'task-14', context: ctxUse(37, { fold: 0 }),
      attempt: attempt(now, 1, 'checkpointed', null, { task: 'task-14' }),
      wait: { kind: 'Decision', ref: 'thr-7', label: 'decision #7 rev2', openedAt: now - 30 * M, deadline: now + 14 * M, state: 'pending' } }),
    member(now, 'verifier-e', 'verifier', 'engine', { task: 'task-9', context: ctxUse(71, { fold: 4, truncRefs: 5, snap: 3100, foldLast: { at: now - 4 * M, masked: 22, revFrom: 51, revTo: 55 } }),
      attempt: attempt(now, 1, 'running', 118, { task: 'task-9' }),
      wait: { kind: 'MessageResponsibility', ref: 'msg-90', label: 'worker-a msg-90', memberRef: 'worker-a', openedAt: now - 23 * M, deadline: now - 3 * M, state: 'pending' } }),
    member(now, 'worker-c', 'worker', 'engine', { task: 'task-15', context: ctxUse(76, { fold: 3, truncRefs: 9, snap: 3900 }),
      activity: { kind: 'maintenance', sub: '压缩上下文', since: now - 40 * S },
      attempt: attempt(now, 1, 'running', 22, { task: 'task-15' }) }),
    member(now, 'sc-2', 'coordinator', 'portals', { context: ctxUse(41, { fold: 0 }) }),
    member(now, 'worker-p1', 'worker', 'portals', { task: 'task-18', context: ctxUse(22),
      wait: { kind: 'Approval', ref: 'apr-3', label: 'scope approval apr-3', openedAt: now - 20 * M, deadline: now + 40 * M, state: 'pending' } }),
    member(now, 'worker-p2', 'worker', 'portals', { task: 'task-19', context: ctxUse(44), attempt: attempt(now, 1, 'running', 52, { task: 'task-19' }) }),
    member(now, 'worker-p3', 'worker', 'portals', { task: 'task-20', desired: 'frozen', observed: 'active', context: ctxUse(33),
      history: ['requested', 'creating', 'bound', 'active', 'freezing'], attempt: attempt(now, 1, 'running', 30, { task: 'task-20', leaseState: 'revoked' }) }),
    member(now, 'worker-p4', 'worker', 'portals', { observed: 'unknown', context: null, history: ['requested', 'creating', 'unknown'], task: null, nativeRef: null }),
    member(now, 'sc-3', 'coordinator', 'gameplay', { context: ctxUse(30) }),
    member(now, 'worker-g1', 'worker', 'gameplay', { task: 'task-22', context: ctxUse(27), attempt: attempt(now, 1, 'running', 33, { task: 'task-22' }) }),
    member(now, 'worker-g2', 'worker', 'gameplay', { task: 'task-23', context: ctxUse(18),
      attempt: attempt(now, 1, 'produced', null, { task: 'task-23' }),
      wait: { kind: 'TaskAccepted', ref: 'task-23', label: 'task-23 delivery r1', openedAt: now - 10 * M, deadline: now + 50 * M, state: 'pending' } }),
    member(now, 'worker-g3', 'worker', 'gameplay', { desired: 'retired', observed: 'retired', context: null, history: ['requested', 'creating', 'bound', 'active', 'retiring', 'retired'] }),
    member(now, 'worker-g4', 'worker', 'gameplay', { task: 'task-24', context: ctxUse(12), attempt: attempt(now, 1, 'running', 47, { task: 'task-24' }) }),
    member(now, 'verifier-final', 'verifier', 'verify', { task: 'task-21', context: ctxUse(35, { fold: 0 }), attempt: attempt(now, 1, 'running', 175, { task: 'task-21' }) }),
  ];
  const valid = { revision: 1, certificate: 'valid', merge: null };
  const tasks = [
    task('task-3', '渲染批处理接口 v2 骨架', 'accepted', 'worker-a', { attempts: [{ n: 1, id: 'attempt:task-3:1', state: 'produced' }], delivery: { revision: 1, certificate: 'valid', merge: 'confirmed',
      // Contract: packages/projections/schema.mjs certificateBindingSchema (complete, attempt bound).
      certificateBinding: { certificateHash: 'c3a91f0e5b7d24c8a1f06e2d9b4c7a3051e8d2f6b9a0c4e7d1f3a5b8c2e6d904', taskId: 'task-3', attemptId: 'attempt:task-3:1',
        verifier: 'member:verifier-e', contractRevision: 1, candidate: '7e21c9a4d0b3f6e8a1c5d2b7f9e0a3c6d8b1f4e2', tree: '4b0d8f1c7a2e5d9b3f6a0c8e1d4b7a2f5c9e3d60',
        deliveryId: 'delivery:task-3', deliveryRevision: 1, status: 'accepted' } } }),
    task('task-4', 'shader 缓存键迁移', 'merged', 'worker-c', { delivery: { revision: 1, certificate: 'valid', merge: 'confirmed' } }),
    task('task-5', 'portals 资源清单生成', 'merged', 'worker-p2', { delivery: { revision: 2, certificate: 'valid', merge: 'confirmed' } }),
    task('task-6', '纹理图集打包脚本', 'verified', 'worker-g1', { delivery: valid }),
    task('task-7', 'gameplay 事件总线适配', 'verified', 'worker-g4', { delivery: valid }),
    task('task-8', 'engine 帧图依赖排序', 'verified', 'worker-b', { delivery: valid }),
    task('task-9', '验收 task-8 帧图依赖排序', 'verifying', 'verifier-e', { delivery: { revision: 1, certificate: null, merge: null } }),
    task('task-10', 'portals 预取策略', 'produced', 'worker-p2', { delivery: { revision: 1, certificate: null, merge: null } }),
    task('task-11', 'HUD 层渲染路径', 'produced', 'worker-g1', { delivery: { revision: 1, certificate: null, merge: null } }),
    task('task-12', '渲染管线 pass 合并', 'executing', 'worker-a', { rev: 2, attempts: [{ n: 1, state: 'failed', supersededBy: 2 }, { n: 2, state: 'running' }] }),
    task('task-13', '后处理链兼容层', 'produced', 'worker-c', { delivery: { revision: 1, certificate: 'invalid', merge: null } }),
    task('task-14', 'portals 加载顺序对接 v2', 'blocked', 'worker-b'),
    task('task-15', 'GPU 资源生命周期重构', 'executing', 'worker-c'),
    task('task-16', '集成 engine 批次 #2', 'integrating', 'root', { delivery: { revision: 1, certificate: 'valid', merge: 'prepared',
      // Legacy certificate: no attemptId (never inferred).
      certificateBinding: { certificateHash: '91d0e6a7c2f4b8330e5a1c9d7b2f4e6a8c0d3b5f7e9a1c2d4b6f8e0a3c5d7b9f', taskId: 'task-16', verifier: 'member:verifier-final',
        contractRevision: 1, candidate: 'a5c3e19b7d2f4a6c8e0b1d3f5a7c9e2b4d6f8a0c', tree: 'e2b4d6f8a0c1e3b5d7f9a2c4e6b8d0f1a3c5e7b9', deliveryId: 'delivery:task-16', deliveryRevision: 1, status: 'verified' } } }),
    task('task-18', 'portals shim（需扩大写域）', 'blocked', 'worker-p1'),
    task('task-19', 'portals 流式加载', 'executing', 'worker-p2'),
    task('task-20', 'portals 遮挡剔除', 'executing', 'worker-p3'),
    task('task-21', '最终验收：集成分支 int-41', 'verifying', 'verifier-final'),
    task('task-22', '角色动画管线迁移', 'executing', 'worker-g1'),
    task('task-23', '物理调试绘制', 'produced', 'worker-g2', { delivery: { revision: 1, certificate: null, merge: null } }),
    task('task-24', '粒子系统批处理', 'executing', 'worker-g4'),
  ];
  const threads = [
    { id: 'thr-7', question: '接口 v2 是否破坏 portals 的加载顺序？', owner: 'sc-1', escalationOwner: 'operator',
      requiredRespondents: [{ member: 'worker-a', revision: 2 }, { member: 'sc-2', revision: 2 }, { member: 'verifier-e', revision: null }],
      openedAt: now - 30 * M, deadline: now + 14 * M, state: 'collecting', proposalRevision: 2, supersededRevisions: [1],
      replies: [{ member: 'worker-a', revision: 2, text: '可以，附测试', artifact: 'art-551' }, { member: 'sc-2', revision: 2, text: '需要 portals 侧 shim', artifact: 'art-553' }],
      lateEvidence: [], affectedTasks: ['task-14', 'task-18'], decisionRevision: null, revision: 6 },
    { id: 'thr-9', question: 'portals shim 是否允许改动 engine/loader 写域？', owner: 'operator', escalationOwner: 'operator',
      requiredRespondents: [{ member: 'sc-1', revision: 1 }, { member: 'sc-2', revision: 1 }, { member: 'worker-p1', revision: null }],
      openedAt: now - 48 * M, deadline: now - 3 * M, state: 'escalated', proposalRevision: 1, supersededRevisions: [],
      replies: [{ member: 'sc-1', revision: 1, text: '只允许 loader/hooks 子目录', artifact: 'art-560' }, { member: 'sc-2', revision: 1, text: '同意，需要回归测试', artifact: 'art-561' }],
      lateEvidence: [], affectedTasks: ['task-18'], decisionRevision: null, revision: 4 },
    { id: 'thr-11', question: '动画重定向放在 gameplay 还是 engine？', owner: 'sc-3', escalationOwner: 'root',
      requiredRespondents: [{ member: 'worker-g1', revision: 1 }, { member: 'sc-1', revision: null }],
      openedAt: now - 5 * M, deadline: now + 35 * M, state: 'collecting', proposalRevision: 1, supersededRevisions: [],
      replies: [{ member: 'worker-g1', revision: 1, text: '倾向 gameplay，接口更窄' }], lateEvidence: [], affectedTasks: ['task-22'], decisionRevision: null, revision: 2 },
    { id: 'thr-5', question: '渲染批次大小默认值取 256 还是 512？', owner: 'sc-1', escalationOwner: 'root',
      requiredRespondents: [{ member: 'worker-a', revision: 1 }, { member: 'worker-c', revision: 1 }],
      openedAt: now - 120 * M, deadline: now - 60 * M, state: 'decided', proposalRevision: 1, supersededRevisions: [],
      replies: [{ member: 'worker-a', revision: 1, text: '256，附基准', artifact: 'art-512' }, { member: 'worker-c', revision: 1, text: '同意 256' }],
      lateEvidence: [{ member: 'worker-g4', text: '粒子批次在 512 下更快（晚到，不覆盖决定）' }], affectedTasks: ['task-3'], decisionRevision: 1, revision: 9 },
  ];
  const messages = [
    msg(now, 'msg-77', 'root', 'worker-b', 'decision', { visible: true, accepted: true, resolved: true, gen: 3, openedAt: now - 70 * M,
      rebinds: [{ from: 2, to: 3, at: now - 65 * M }], expected: '确认 frame graph 排序方案' }),
    msg(now, 'msg-88', 'worker-a', 'worker-b', 'action', { visible: true, openedAt: now - 6 * M, deadline: now + 24 * M, expected: '确认 v2 接口签名' }),
    msg(now, 'msg-90', 'verifier-e', 'worker-a', 'action', { openedAt: now - 23 * M, deadline: now - 3 * M, expected: '提供 task-8 的基准复现脚本',
      delay: '收件人在长工具（bash 6m12s）', escalatedTo: { member: 'sc-1', at: now - 2 * M } }),
    msg(now, 'msg-91', 'sc-1', 'verifier-e', 'decision', { visible: true, openedAt: now - 11 * M, deadline: now + 9 * M, expected: '对 #7 提案 rev2 表态' }),
    msg(now, 'msg-93', 'root', 'verifier-e', 'action', { openedAt: now - 1 * M, deadline: now + 20 * M, expected: '验收完成后报告覆盖率差距' }),
    msg(now, 'msg-95', 'sc-2', 'worker-p2', 'info', { visible: true, openedAt: now - 15 * M, expected: '' }),
    msg(now, 'msg-96', 'worker-g2', 'verifier-final', 'action', { visible: true, accepted: true, openedAt: now - 9 * M, deadline: now + 30 * M, expected: '验收 task-23 交付 r1' }),
    msg(now, 'msg-97', 'root', 'sc-3', 'info', { visible: true, accepted: true, resolved: true, openedAt: now - 50 * M }),
    msg(now, 'msg-98', 'sc-1', 'worker-c', 'action', { visible: true, openedAt: now - 3 * M, deadline: now + 30 * M, expected: '拆分 task-15，控制上下文' }),
    msg(now, 'msg-99', 'sc-2', 'worker-p3', 'action', { lifecycle: 'cancelled', openedAt: now - 8 * M, deadline: now + 12 * M, expected: '暂停遮挡剔除，等待冻结' }),
  ];
  const unknownEffects = [{ id: 'op-91', kind: 'merge', ref: 'int-41 → refs/heads/main', summary: 'merge op-91：目标 ref 已移动、回执丢失', openedAt: now - 6 * M,
    evidence: ['integration intent int-41 已提交（prepared）', 'update-ref 回执缺失（进程在 Git 返回前退出）', 'refs/heads/main 现为 9f2c1e7，期望 old=4ab09d2'], revision: 2 }];
  const approvals = [{ id: 'apr-3', kind: 'scope', member: 'worker-p1', task: 'task-18', summary: 'worker-p1 申请扩大 task-18 写域', openedAt: now - 20 * M,
    diff: ['+ engine/loader/hooks/**（写）', '风险 low → medium', '预算 $2.00 → $3.00'], deadline: now + 40 * M, revision: 1 }];
  return { goal: { id: 'goal-1', title: '迁移渲染管线到 v2', status: 'known', native: { id: 'goal-1', objective: '迁移渲染管线到 v2', revision: 3 },
      source: { sessionId: 'ses-root', seq: 48190 }, gate: { status: 'blocked', revision: 3, evaluatedAt: now - 12 * M, sourceSeq: 48190, semantics: 'last-committed-check' },
      acceptanceGaps: 3, completionToken: 'none' }, approvalsStatus: { status: 'known', source: 'mock' }, restrictedMembers: 2,
    groups: [{ id: 'root', label: 'root', lead: null }, { id: 'engine', label: 'engine', lead: 'sc-1' }, { id: 'portals', label: 'portals', lead: 'sc-2' },
      { id: 'gameplay', label: 'gameplay', lead: 'sc-3' }, { id: 'verify', label: '独立验收', lead: null }],
    members, tasks, threads, messages, unknownEffects, approvals };
}

/** 30 members (root + 3 coordinator groups of 8 + 2 verifiers), ~200 messages (09 §8 A7). */
function scenarioLarge(now) {
  const base = buildDefault(now);
  const members = [member(now, 'root', 'root', 'root', { context: ctxUse(55, { fold: 2 }) })];
  const groups = [{ id: 'root', label: 'root', lead: null }];
  const names = ['engine', 'portals', 'gameplay'];
  let k = 0;
  names.forEach((g, gi) => {
    groups.push({ id: g, label: g, lead: `sc-${gi + 1}` });
    members.push(member(now, `sc-${gi + 1}`, 'coordinator', g, { context: ctxUse(35 + gi * 6) }));
    for (let i = 1; i <= 8; i++) {
      k++;
      const id = `${g.slice(0, 3)}-w${i}`, t = `task-${100 + k}`, o = { task: t, context: ctxUse((k * 17) % 70 + 5), attempt: attempt(now, 1, 'running', 20 + (k * 7) % 50, { task: t }) };
      if (k === 3) Object.assign(o, { wait: { kind: 'MessageResponsibility', ref: 'msg-l3', label: `${g.slice(0, 3)}-w1 msg`, memberRef: `${g.slice(0, 3)}-w1`, openedAt: now - 30 * M, deadline: now - 4 * M, state: 'pending' } });
      if (k === 14) Object.assign(o, { attempt: attempt(now, 1, 'running', -12, { task: t, leaseState: 'expired' }) });
      if (k === 20) Object.assign(o, { observed: 'unknown', context: null });
      if (k === 6 || k === 11) Object.assign(o, { context: ctxUse(k === 6 ? 66 : 77) });
      if (k === 9) Object.assign(o, { desired: 'frozen', observed: 'active' });
      if ([2, 8, 12, 17, 22].includes(k)) Object.assign(o, { wait: { kind: 'Decision', ref: 'thr-7', label: 'decision #7 rev2', openedAt: now - 10 * M, deadline: now + (20 + k) * M, state: 'pending' } });
      if (k === 24) Object.assign(o, { desired: 'frozen', observed: 'frozen', attempt: null });
      members.push(member(now, id, 'worker', g, o));
    }
  });
  groups.push({ id: 'verify', label: '独立验收', lead: null });
  members.push(member(now, 'verifier-1', 'verifier', 'verify', { task: 'task-9', context: ctxUse(48) }));
  members.push(member(now, 'verifier-final', 'verifier', 'verify', { task: 'task-21', context: ctxUse(31) }));
  const messages = [];
  for (let i = 0; i < 200; i++) {
    const to = members[1 + (i * 7) % (members.length - 1)].id, from = members[(i * 3) % members.length].id;
    messages.push(msg(now, `msg-l${i}`, from === to ? 'root' : from, to, i % 5 === 0 ? 'info' : 'action',
      { visible: i % 9 !== 0, accepted: i % 4 !== 0, resolved: i % 4 !== 0 && i % 3 === 0, openedAt: now - (i % 30 + 2) * M, deadline: now + (12 + (i % 9) * 6) * M }));
  }
  const states = ['executing', 'executing', 'executing', 'produced', 'verifying', 'executing', 'blocked', 'executing'];
  const tasks = [...base.tasks, ...members.filter(m => m.taskId && !base.tasks.some(t => t.id === m.taskId))
    .map((m, i) => task(m.taskId, `${m.group} 子任务 ${i + 1}`, m.wait?.kind === 'Decision' ? 'blocked' : states[i % states.length], m.id))];
  return authorityIds({ ...base, members, groups, messages, tasks, restrictedMembers: 0 });
}

function scenarioEmpty() {
  return { goal: { id: 'goal', title: 'unknown', status: 'unknown', native: null, source: null, gate: { status: 'unknown' }, acceptanceGaps: null, completionToken: 'none' },
    approvalsStatus: { status: 'known', source: 'mock' }, restrictedMembers: 0,
    groups: [], members: [], tasks: [], threads: [], messages: [], unknownEffects: [], approvals: [] };
}

/**
 * P5: a team that uses the v1 read states, so the client contract is exercised with real-shaped blocks rather than a
 * comment. Resource threads are a separate collection; capacity shows an unknown occupant (admission closed) and a
 * queued human; the role guard reports denials; one batch was bounded with an omitted item. Nothing here is a second
 * source of truth: the mock only replays the envelope the server would publish.
 */
function scenarioBorrow(now) {
  const base = scenarioDefault(now);
  const resourceThreads = [{
    id: 'thread:res-1', kind: 'resource', status: 'open', owner: 'member:root',
    resource: { kind: 'branch', repositoryKey: 'repo:acme/app', key: 'refs/heads/main' },
    head: 3, retainedFrom: 1, pending: 1, descriptionRef: 'artifact:desc:1',
    subscribers: [
      { memberId: 'member:sc-1', generation: 1, subscriptionEpoch: 1, state: 'active', startAfterSeq: 0, visibleThrough: 2, pending: 1 },
      { memberId: 'member:worker-a', generation: 3, subscriptionEpoch: 2, state: 'active', startAfterSeq: 0, visibleThrough: 3, pending: 0 },
    ],
    lastEvent: { seq: 3, eventType: 'conflict-observed', summary: 'worker-a 报告 main 与 feature 冲突',
      actor: 'member:worker-a', occurredAt: now - 4 * M },
    revision: 7,
  }];
  const latest = { id: 'manifest:borrow-1', memberId: 'member:worker-a', generation: 3, cutoffSeq: 100, items: 2,
    pendingCount: 4, omittedCount: 1, nextCursor: 2, injectedAt: now - 60 * S, revision: 1 };
  return authorityIds({ ...base, resourceThreads,
    capacity: { normal: { current: 5, limit: 8, unknown: 0, queued: 0, oldestAge: null },
      human: { current: 1, limit: 1, unknown: 1, queued: 2, oldestAge: 60 * S },
      unknown: 1, admissionClosed: true, queued: 2, oldestAge: 60 * S,
      blocked: [{ originRef: 'human-input:borrow', recipient: 'member:worker-p1', reason: 'recipient-unavailable' }],
      occupants: [{ ref: 'control-slot:team:borrow', originRef: 'decision:borrow', holderRef: 'owner-call', state: 'unknown', lane: 'human' }],
      providerCapacity: 'unknown', providerWait: 'none', providerRetryAfterMs: null, providerRecoveryAt: null },
    roleGuard: { coordinatorOnly: true,
      policy: { deny: ['opaque', 'write-local', 'execute'], allow: ['read-local', 'coordinate'], unknown: 'deny' },
      installed: true, revoked: false, denials: 3, allows: 9, auditPersistFailed: false,
      declared: ['read', 'team_read'],
      audit: { denied: 3, allowed: 9, byTool: [{ identity: 'bash', allowed: 0, denied: 2 }, { identity: 'read', allowed: 9, denied: 1 }] } },
    inputs: { count: 1, latest, batches: [latest] } });
}
/**
 * M6 (§WP-0): fixtures the v3 panel acceptance needs, composed from the default team so every other row keeps the
 * shape the existing suites already pin. They are data only: a different *viewer* and a *stale* envelope are driven by
 * createMockSource's config/control (viewer via the source config, staleness via control.setStale), not by a fixture.
 */
function scenarioLongText(now) {
  const base = scenarioDefault(now);
  const long = '渲染管线批处理与后处理链在 portals 与 gameplay 之间的跨组适配方案（含回滚路径与灰度开关）';
  return authorityIds({ ...base,
    members: base.members.map(m => m.id === 'member:worker-a' ? { ...m, name: 'worker-a-长名字-0123456789' } : m),
    tasks: base.tasks.map(t => t.id === 'task-12' ? { ...t, title: long.repeat(3) } : t) });
}
/** One message the outbox gave up on, plus one unknown read-model gap: the two rows the records page must separate. */
function scenarioDeadLetter(now) {
  const base = scenarioDefault(now);
  return authorityIds({ ...base,
    messages: base.messages.map(m => m.id === 'msg-90' ? { ...m, lifecycle: 'dead-letter', revision: m.revision + 1,
      deadLetter: { reason: 'receipt-lost: the recipient session ended before the outbox confirmed',
        at: now - 2 * M, suggestedRecipient: 'member:sc-1' } } : m),
    unknownEffects: [...base.unknownEffects, { id: 'read-model:context:member:worker-p4', kind: 'read-model',
      ref: 'read-model:context:member:worker-p4', summary: '上下文读模型缺失', openedAt: now - 4 * M,
      evidence: [], revision: 1 }] });
}
/** An open proposal window with one recipient that has not seen it yet. */
function scenarioIntent(now) {
  const base = scenarioDefault(now);
  const intent = { id: 'msg-intent-1', from: 'member:worker-a', to: 'member:worker-b',
    kind: 'intent', openedAt: now - 4 * M, deadline: now + 6 * M, closesAt: now + 6 * M, lifecycle: 'stored',
    expectedOutcome: '把 feature/render-v2 合入 main', generation: 1, receipts: { stored: null, visible: null, accepted: null },
    delayReason: null, escalatedTo: null, rebinds: [], revision: 1,
    recipients: [{ member: 'member:worker-b', delivery: 'stored', reply: null }],
    seenAtClose: null, summary: 'worker-a 提议：合入 feature/render-v2' };
  return authorityIds({ ...base, messages: [intent, ...base.messages] });
}
/** A second team's rows with unmistakable names: switching sessions must never show one on the other's page. */
function scenarioTeamB(now) {
  const base = scenarioDefault(now);
  return { ...base,
    members: base.members.map(m => ({ ...m, name: 'b-' + m.name })),
    groups: base.groups.map(g => ({ ...g, label: g.label + '-b' })),
    goal: { ...base.goal, id: 'goal-b', title: '团队 B：只为隔离验收存在的目标' } };
}
const FIXTURES = { default: scenarioDefault, 'team-30': scenarioLarge, empty: scenarioEmpty, borrow: scenarioBorrow,
  viewer: scenarioDefault, stale: scenarioDefault, 'unknown+deadletter': scenarioDeadLetter,
  'long-text': scenarioLongText, deadletter: scenarioDeadLetter, intent: scenarioIntent, 'two-teams': scenarioTeamB };


/**
 * M6 stand-in for the projection's v3 panels (N1/N3/N4/N2/P6/P2/P3/P4). The real server computes these in
 * packages/projections/panel.mjs; the client never derives them itself, so the mock must publish the same blocks or
 * the page would have nothing to render. Fixtures stay data; this only adds the panels over them.
 */
function withPanelBlocks(data, viewer, now = Date.now()) {
  const members = data.members ?? [], tasks = data.tasks ?? [];
  const root = members.find(m => m.role === 'root') ?? null;
  const lifecycle = m => {
    if (m.observed === 'unknown' || m.status === 'unknown') return 'stuck';
    if (m.desired === 'retired' || m.observed === 'retiring' || m.observed === 'retired') return 'retiring';
    if (m.desired === 'frozen' || m.observed === 'frozen') return 'paused';
    return m.taskId || m.attempt ? 'normal' : 'idle';
  };
  const memberSummary = { normal: 0, stuck: 0, paused: 0, retiring: 0, idle: 0, stuckHandledBy: null };
  for (const m of members) if (m.role !== 'root') memberSummary[lifecycle(m)]++;
  if (memberSummary.stuck && root) memberSummary.stuckHandledBy = root.id;
  const has = states => tasks.filter(t => states.includes(t.state)).length;
  const total = tasks.filter(t => t.state !== 'cancelled').length;
  const delivery = { produced: has(['produced']), verifying: has(['verifying']), merged: has(['merged', 'integrating']),
    accepted: has(['accepted']), total };
  const working = members.filter(m => m.activity?.kind === 'running').length;
  const escalations = [];
  // N2: only a root -> operator transfer needs a human. The verdict is the operator's, so the row has no button: it is
  // a note saying where it is decided (§6 #12), exactly like the projection's escalationsOf.
  for (const t of data.threads ?? []) {
    if (t.state !== 'escalated' || t.escalationOwner !== 'operator') continue;
    escalations.push({ id: 'escalation:' + t.id, issueKey: t.id, sources: [t.id], question: t.question ?? '需要你决定',
      why: 'root 已把它转交 operator；浏览器没有这项权限', waitingSince: t.escalatedAt ?? t.openedAt ?? null,
      consequence: '确认前相关工作保持现状', primary: null, note: '说明行：由 operator 侧确认，浏览器不提供按钮',
      severity: 'bad', subject: { type: 'thread', id: t.id } });
  }
  // An unknown capacity occupancy is the safety row a person must see (15 §10); it carries the adjudication entry.
  for (const slot of data.capacity?.occupants ?? []) {
    if (slot.state !== 'unknown') continue;
    escalations.push({ id: 'escalation:' + slot.ref, issueKey: slot.ref, sources: [slot.ref],
      question: '容量占用 ' + slot.ref + ' 结果不明', why: '只有 operator 能根据证据确认',
      waitingSince: typeof data.capacity?.oldestAge === 'number' ? now - data.capacity.oldestAge : null,
      consequence: '确认前执行准入保持关闭', primary: null,
      note: '说明行：operator 侧核对 effectId 后记录结论；浏览器不提供按钮', severity: 'bad',
      subject: { type: 'capacity', id: slot.originRef ?? slot.ref } });
  }
  const headline = escalations.length ? 'needs-you' : memberSummary.stuck ? 'root-handling' : 'ok';
  const tail = escalations.length ? '需要你处理 ' + escalations.length + ' 件事'
    : memberSummary.stuck ? 'root 正在处理 ' + memberSummary.stuck + ' 个卡住' : '一切正常';
  const fresh = root ? members.find(m => m.id === root.id) : null;
  return { ...data,
    summary: { working, accepted: delivery.accepted, total, headline: { kind: headline,
      text: working + ' 人在做 · 已验收 ' + delivery.accepted + '/' + total + ' · ' + tail, targetRef: escalations[0]?.subject?.id ?? null } },
    memberSummary, delivery, escalations,
    intents: (data.messages ?? []).filter(m => m.kind === 'intent').map(m => ({ id: m.id, from: m.from ?? null,
      summary: m.summary ?? m.expectedOutcome ?? null, openedAt: m.openedAt ?? null, closesAt: m.closesAt ?? m.deadline ?? null,
      state: m.state ?? m.lifecycle ?? null, recipients: m.recipients ?? [], passedAt: null, unseenAtPass: [],
      revision: m.revision ?? 1 })),
    team: { teamId: 'team:mock', name: data.goal?.title ?? null, leaderSessionId: fresh?.nativeRef ?? 'session-root',
      createdAt: data.goal?.createdAt ?? now - 3600000 },
    viewerRole: viewer?.startsWith('viewer:') ? 'viewer' : (members.find(m => m.id === viewer)?.role ?? 'unknown'),
  };
}


const ACTIVITY_STATE_TEXT = { draft: '等待范围审批', ready: '准备开始', blocked: '正在等待处理', produced: '已产出',
  verifying: '正在验证', verified: '验证通过', integrating: '正在合并', merged: '已合并', accepted: '已验收',
  open: '已发起', collecting: '正在收集意见', deciding: '等待决定', decided: '已作出决定', escalated: '已转交处理',
  stored: '已送达信箱', visible: '已看到', resolved: '已完成', cancelled: '已取消', unknown: '结果尚未确认',
  expired: '等待期限已到', 'dead-letter': '投递未能完成', running: '正在执行', frozen: '已暂停', retired: '已退役' };
const ACTIVITY_CATEGORY_TEXT = { anomaly: '异常', 'needs-you': '需要你', 'root-decision': 'root 裁决',
  delivery: '交付与验收', other: '团队动态' };
/** M6 P12 stand-in: the mock derives the same bounded timeline shape the projection's activity endpoint publishes. */
function mockActivity(data, query = {}, now = Date.now()) {
  const rows = [];
  const add = (id, row, kind, category, name, state, members = []) => rows.push({
    at: row.updatedAt ?? row.openedAt ?? row.createdAt ?? row.acceptedAt ?? row.verifiedAt ?? now,
    kind, category, id, subject: { type: kind, id, name }, members: members.filter(Boolean),
    text: name + '：' + (ACTIVITY_STATE_TEXT[state] ?? '记录已更新'),
    tags: [ACTIVITY_CATEGORY_TEXT[category], ...(row.evidence?.length ? ['证据 ' + row.evidence.length + ' 条'] : [])],
  });
  for (const t of data.threads ?? []) {
    const category = t.state === 'escalated' && t.responsible === 'operator' ? 'needs-you'
      : t.state === 'decided' ? 'root-decision' : 'other';
    add(t.id, t, 'thread', category, t.question ?? t.id, t.state, [t.owner, t.escalatedBy]);
  }
  for (const m of data.messages ?? []) {
    const category = m.lifecycle === 'dead-letter' || m.lifecycle === 'unknown' ? 'anomaly'
      : m.lifecycle === 'resolved' ? 'root-decision' : 'other';
    add(m.id, m, 'message', category, m.summary ?? m.expectedOutcome ?? m.id, m.lifecycle, [m.from, m.to]);
  }
  for (const t of data.tasks ?? []) add(t.id, t, 'task', 'delivery', t.title ?? t.id, t.state, [t.owner]);
  for (const t of data.decisions ?? []) add(t.id, t, 'decision', 'root-decision', t.summary ?? t.id, t.state, [t.openedFor]);
  rows.sort((a, b) => a.at - b.at);
  rows.forEach((row, index) => { row.seq = index + 1; });
  const asOfSeq = rows.length;
  const filter = query.kind ?? null;
  let events = rows.filter(row => (!filter || row.category === filter || row.kind === filter) &&
    (!query.member || row.members.includes(query.member)) &&
    (query.from == null || row.at >= query.from) && (query.to == null || row.at <= query.to));
  const limit = Math.min(Number.isSafeInteger(query.limit) && query.limit > 0 ? query.limit : 500, 500);
  const forward = query.afterSeq != null;
  if (forward) events = events.filter(row => row.seq > query.afterSeq).sort((a, b) => a.seq - b.seq);
  else {
    if (query.beforeSeq != null) events = events.filter(row => row.seq < query.beforeSeq);
    events = events.sort((a, b) => b.seq - a.seq);
  }
  const total = events.length, page = events.slice(0, limit), hasMore = total > page.length;
  const ordered = forward ? [...page].reverse() : page;
  return { events: ordered.map(row => ({ ...row, members: [...row.members] })), total,
    categories: ['anomaly', 'needs-you', 'root-decision', 'delivery'], replayAfterSeq: 0, asOfSeq,
    nextAfterSeq: forward && hasMore ? page.at(-1).seq : asOfSeq,
    nextBeforeSeq: !forward && hasMore ? page.at(-1).seq : null, hasMore };
}

/**
 * In-memory ProjectionSource. Emits ordered events (lease heartbeats, context drift) and
 * reflects accepted commands a little later, the way an authoritative server would.
 * `control` exists only for verification (gap, stream drop, stale flag, fixture switch).
 */
function createMockSource(options = {}) {
  const now = options.now ?? (() => Date.now());
  const tickMs = options.tickMs ?? 2000;
  let fixture = options.fixture ?? 'default';
  const viewer = options.viewer ?? (fixture === 'viewer' ? 'viewer:readonly' : MOCK_VIEWER);
  let data = withPanelBlocks(FIXTURES[fixture](now()), viewer, now());
  let baseline = new Map(data.members.map(m => [m.id, m.context?.pct]));
  let seq = 48211, stale = fixture === 'stale', dropUntil = 0, gapNext = false;
  const subscribers = new Set();
  const revisions = () => ({ organization: 312 + seq % 7, scheduler: 9021 + seq, mailbox: 4410 + seq, threads: 88, delivery: 61 });
  const emit = event => {
    if (now() < dropUntil) return;
    const e = { schemaVersion: SCHEMA_VERSION, seq: gapNext ? seq + 2 : seq + 1, ...event };
    if (gapNext) { gapNext = false; seq += 2; } else seq += 1;
    // Authoritative state advances even when a subscriber is about to resync.
    const { upserts, removes, goal } = event;
    if (goal) data = { ...data, goal };
    // P5: resourceThreads (and any later optional collection) may not exist in an older fixture; an event for it
    // creates the collection instead of failing on undefined.
    for (const key of Object.keys(upserts ?? {})) { const map = new Map((data[key] ?? []).map(x => [x.id, x])); for (const x of upserts[key]) map.set(x.id, x); data = { ...data, [key]: [...map.values()] }; }
    for (const key of Object.keys(removes ?? {})) data = { ...data, [key]: (data[key] ?? []).filter(x => !removes[key].includes(x.id)) };
    const panel = withPanelBlocks(data, viewer, now());
    for (const s of subscribers) s.onEvent({ ...e, summary: panel.summary, memberSummary: panel.memberSummary,
      delivery: panel.delivery, escalations: panel.escalations, intents: panel.intents, team: panel.team,
      viewerRole: panel.viewerRole });
  };
  let tick = 0;
  const heartbeat = () => {
    tick++;
    if (now() < dropUntil) return;
    const t = now();
    const changed = [];
    for (const m of data.members) {
      const a = m.attempt;
      if (!a || a.state !== 'running' || !a.lease || a.lease.state !== 'active') continue;
      let next = m;
      if (a.lease.expiresAt - t < 15 * S) next = { ...next, attempt: { ...a, lease: { ...a.lease, expiresAt: t + 60 * S } }, checkpointAt: t };
      const base = baseline.get(m.id);
      if (m.context && base != null && (tick + m.id.length) % 3 === 0) {
        // Bounded drift around the fixture value so long sessions keep the designed state mix.
        // Relative to the 75% limit: keep each member inside its designed band (ok < 80 ≤ warn < 100 ≤ bad).
        const pct = Math.max(1, Math.min(base >= 100 ? 105 : base >= 80 ? 99 : 77, base + Math.round(Math.sin((tick + m.id.length * 3) / 4) * 3)));
        next = { ...next, context: { ...m.context, pct, inputTokens: Math.round(m.context.limitTokens * pct / 100) } };
      }
      // Lease heartbeats / context usage are scheduler & context facts: they do not bump the organization revision used for CAS.
      if (next !== m) changed.push(next);
    }
    emit({ upserts: changed.length ? { members: changed } : {}, stale });
  };
  let timer = null;
  const ensureTimer = () => { if (!timer && subscribers.size) timer = setInterval(heartbeat, tickMs); if (timer && !subscribers.size) { clearInterval(timer); timer = null; } };
  const later = (ms, fn) => setTimeout(fn, ms);
  const findMember = id => data.members.find(m => m.id === id);
  const source = {
    describe: () => ({ kind: 'mock', label: `模拟投影 · ${fixture}`, viewer, heartbeat: true }),
    async snapshot() {
      await new Promise(r => setTimeout(r, 120));
      return { schemaVersion: SCHEMA_VERSION, teamId: 'team:mock', asOfSeq: seq, sourceRevisions: revisions(),
        stale, viewer, data: structuredClone(data) };
    },
    // M6 P2/P12: which team a session belongs to, and the records timeline. `session:none` is the fixture's
    // "this session has no team" case.
    async binding(sessionId) {
      if (!sessionId || sessionId === 'session:none' || fixture === 'empty') return null;
      const member = [...data.members].find(m => m.nativeRef === sessionId) ?? null;
      return { teamId: 'team:mock', sessionId, memberId: member?.id ?? null, role: member?.role ?? null, name: data.team?.name ?? null };
    },
    async activity(query = {}) { return mockActivity(data, query, now()); },
    subscribe(afterSeq, onEvent, onStatus) {
      const sub = { onEvent, onStatus };
      subscribers.add(sub); ensureTimer();
      setTimeout(() => onStatus(now() < dropUntil ? 'closed' : 'open'), 30);
      return () => { subscribers.delete(sub); ensureTimer(); };
    },
  };
  const control = {
    get fixture() { return fixture; },
    setFixture(name) { fixture = name; data = withPanelBlocks(FIXTURES[name](now()), viewer, now()); baseline = new Map(data.members.map(m => [m.id, m.context?.pct])); seq += 100; for (const s of subscribers) s.onEvent({ schemaVersion: SCHEMA_VERSION, seq: seq + 1000 }); },
    injectGap() { gapNext = true; heartbeat(); },
    dropStream(ms) { dropUntil = now() + ms; for (const s of subscribers) s.onStatus('closed'); setTimeout(() => { for (const s of subscribers) s.onStatus('open'); heartbeat(); }, ms + 50); },
    setStale(value) { stale = value; heartbeat(); },
    seq: () => seq,
  };
  /** Mock command gateway: returns a receipt; state changes arrive only via later projection events. */
  const gateway = {
    async submit(command) {
      await new Promise(r => setTimeout(r, 350));
      const operationId = `op-${Math.random().toString(16).slice(2, 10)}`;
      if (viewer !== MOCK_VIEWER || command.name === 'organization.confirmStopped') return { operationId, status: 'rejected', revision: null,
        entityId: command.target, message: 'ROLE_DENIED' };
      const target = command.target;
      // Same contract as packages/projections/commands.mjs: unknown command → rejected; missing/old revision → conflict.
      if (!COMMANDS[command.name]) return { operationId, status: 'rejected', revision: null, entityId: target, message: 'UNSUPPORTED_COMMAND' };
      // Opening a resource names a new thread id: it has no current row, so it is the one command whose target may
      // legitimately be absent. Everything else is CAS'd against the row the browser read.
      if (command.name === 'threads.openResource') {
        const issueId = target ?? ('thread:' + operationId);
        const thread = { id: issueId, kind: 'resource', status: 'open', owner: command.args.owner ?? MOCK_VIEWER,
          resource: command.args.resource, head: 0, retainedFrom: 1, pending: 0, descriptionRef: command.args.descriptionRef,
          subscribers: [], lastEvent: null, revision: 1 };
        later(300, () => emit({ upserts: { resourceThreads: [thread] } }));
        return { operationId, status: 'accepted', revision: 0, entityId: issueId };
      }
      const current = [...data.members, ...data.threads, ...(data.resourceThreads ?? [])].find(x => x.id === target);
      if (!current || !Number.isSafeInteger(command.expectedRevision) || current.revision !== command.expectedRevision)
        return { operationId, status: 'conflict', revision: null, entityId: target, message: 'CAS_CONFLICT' };
      if (command.name === 'threads.publish' && !(data.resourceThreads ?? []).find(x => x.id === target))
        return { operationId, status: 'rejected', revision: null, entityId: target, message: 'WRONG_THREAD_KIND' };
      if (command.name === 'mailbox.send' && command.target !== command.args.recipient)
        return { operationId, status: 'rejected', revision: null, entityId: target, message: 'TARGET_RECIPIENT_MISMATCH' };
      const t = now();
      switch (command.name) {
        case 'organization.requestFreeze': {
          const m = findMember(target);
          later(1200, () => emit({ upserts: { members: [{ ...findMember(target), desired: 'frozen', history: [...m.history, 'freezing'], revision: m.revision + 1 }] } }));
          later(7000, () => { const cur = findMember(target); emit({ upserts: { members: [{ ...cur, observed: 'frozen', history: [...cur.history, 'frozen'], attempt: cur.attempt && { ...cur.attempt, lease: cur.attempt.lease && { ...cur.attempt.lease, state: 'revoked' } }, revision: cur.revision + 1 }] } }); });
          break;
        }
        case 'organization.requestResume': {
          later(1200, () => { const cur = findMember(target); emit({ upserts: { members: [{ ...cur, desired: 'active', history: [...cur.history, 'resuming'], revision: cur.revision + 1 }] } }); });
          later(5000, () => { const cur = findMember(target); emit({ upserts: { members: [{ ...cur, observed: 'active', history: [...cur.history, 'active'], revision: cur.revision + 1 }] } }); });
          break;
        }
        case 'threads.decide': {
          later(1200, () => { const th = data.threads.find(x => x.id === target); emit({ upserts: { threads: [{ ...th, state: 'decided', decisionRevision: 1, revision: th.revision + 1 }] } }); });
          break;
        }
        case 'threads.subscribe': {
          const thread = data.resourceThreads.find(x => x.id === target);
          const memberId = command.args.memberId ?? MOCK_VIEWER;
          const subscribers = [...thread.subscribers.filter(sub => sub.memberId !== memberId),
            { memberId, generation: 1, subscriptionEpoch: 1, state: 'active', startAfterSeq: thread.head, visibleThrough: 0, pending: 0 }];
          const next = { ...thread, subscribers, revision: thread.revision + 1 };
          later(400, () => emit({ upserts: { resourceThreads: [next] } }));
          break;
        }
        case 'threads.unsubscribe': {
          const thread = data.resourceThreads.find(x => x.id === target);
          const memberId = command.args.memberId ?? MOCK_VIEWER;
          const subscribers = thread.subscribers.map(sub => sub.memberId === memberId ? { ...sub, state: 'closed', pending: 0 } : sub);
          const next = { ...thread, subscribers, revision: thread.revision + 1 };
          later(400, () => emit({ upserts: { resourceThreads: [next] } }));
          break;
        }
        case 'threads.publish': {
          const thread = data.resourceThreads.find(x => x.id === target);
          const seq = thread.head + 1;
          const next = { ...thread, head: seq, revision: thread.revision + 1,
            lastEvent: { seq, eventType: command.args.eventType, summary: command.args.summary, actor: MOCK_VIEWER, occurredAt: t },
            subscribers: thread.subscribers.map(sub => sub.state === 'active' ? { ...sub, pending: sub.pending + 1 } : sub) };
          later(500, () => emit({ upserts: { resourceThreads: [next] } }));
          break;
        }
        case 'threads.closeResource': {
          const thread = data.resourceThreads.find(x => x.id === target);
          const next = { ...thread, status: 'closed', revision: thread.revision + 1 };
          later(400, () => emit({ upserts: { resourceThreads: [next] } }));
          break;
        }
        case 'mailbox.send': {
          const id = `msg-${Math.floor(t / 1000) % 1000}`;
          const m = msg(t, id, MOCK_VIEWER, command.args.recipient, command.args.kind, { openedAt: t, deadline: t + command.args.deadlineMin * M, expected: command.args.expectedOutcome });
          later(900, () => emit({ upserts: { messages: [m] } }));
          later(4000, () => emit({ upserts: { messages: [{ ...m, lifecycle: 'visible', receipts: { ...m.receipts, visible: { at: now(), requestId: 'r-' + id, manifest: 'c0ffee12ab', seq: seq + 1 } }, revision: 2 }] } }));
          break;
        }
        default: break;
      }
      return { operationId, status: 'accepted', revision: current.revision, entityId: target };
    },
  };
  return { source, control, gateway };
}

//#endregion
//#region src/model.mjs
// Pure presentation derivations over a projection snapshot (09 §2.3–2.5). No business inference:
// every value shown comes from a projection field; this only classifies and orders for display.

/** Display bucket for members whose group the projection does not describe (no invented group data). */
const NO_GROUP = '__ungrouped';
const groupKey = group => group ?? NO_GROUP;
/** The root member is found by role, never by a hard-coded id (ids are authoritative `member:*`). */
const rootMember = data => data?.members.find(m => m.role === 'root') ?? null;
/** Display name for an authoritative member id; unknown/restricted ids are shown verbatim. */
function memberName(data, id) { return data?.members.find(m => m.id === id)?.name ?? id; }
/** Severity order (09 §2.5-2): ■ > ? > ▲ > ◔ > ● > ❄ > —. */
const SEVERITY = Object.freeze({
  bad: { rank: 0, glyph: '■', label: '阻塞' },
  unknown: { rank: 1, glyph: '?', label: '未知' },
  warn: { rank: 2, glyph: '▲', label: '需注意' },
  wait: { rank: 3, glyph: '◔', label: '等待' },
  ok: { rank: 4, glyph: '●', label: '推进中' },
  frozen: { rank: 5, glyph: '❄', label: '冻结' },
  retired: { rank: 6, glyph: '—', label: '退役' },
});
/**
 * Context thresholds on `context.pct`, which is relative to the 75% hard limit (100 = at the limit; never divide
 * again). CONTEXT_CAP is the limit as a share of the model window (label only). Warn at 80% of the limit (= 60% window).
 */
const CONTEXT_CAP = 75, CONTEXT_FULL = 100, CONTEXT_WARN = 80;
function ctxLevel(pct) { return pct >= CONTEXT_FULL ? 'bad' : pct >= CONTEXT_WARN ? 'warn' : 'ok'; }
/** Context is shown only when the projection says it is known AND supplies a value; otherwise unknown. */
function contextKnown(member) { return member?.context != null && (member.contextStatus?.status ?? 'known') === 'known'; }
/** Goal read state: `status` absent (older sources) means the fields are authoritative as given. */
function goalInfo(goal) {
  const known = (goal?.status ?? 'known') === 'known';
  const gate = goal?.gate ?? { status: 'unknown' };
  return { known, title: known ? goal.title : null, gaps: known && typeof goal.acceptanceGaps === 'number' ? goal.acceptanceGaps : null,
    gate: { ...gate, known: gate.status === 'allowed' || gate.status === 'blocked' }, token: goal?.completionToken ?? 'none' };
}
function approvalsKnown(data) { return (data?.approvalsStatus?.status ?? 'known') === 'known'; }
const ROLE_ABBR = { root: 'R', coordinator: 'C', worker: 'W', verifier: 'V' };
const ROLE_LABEL = { root: 'Root', coordinator: '子协调者', worker: 'Worker', verifier: 'Verifier' };
const PIPELINE = ['produced', 'verifying', 'verified', 'integrating', 'merged', 'accepted'];

/** Severity of a deadline-bearing wait: overdue → bad; <25% of window left → warn; else wait. */
function deadlineSeverity(openedAt, deadline, now) {
  if (deadline == null) return 'wait';
  if (deadline <= now) return 'bad';
  const window = Math.max(1, deadline - (openedAt ?? deadline - 60 * 60000));
  return (deadline - now) / window < 0.25 ? 'warn' : 'wait';
}

/** Worst unresolved action/decision message for which `memberId` is the recipient (info excluded; 09 §2.4). */
function ackSummary(messages, memberId) {
  const open = messages.filter(m => m.to === memberId && m.kind !== 'info' && !['resolved', 'cancelled', 'expired', 'dead-letter'].includes(m.lifecycle));
  if (!open.length) return null;
  const level = m => m.receipts.accepted ? 3 : m.receipts.visible ? 2 : m.receipts.stored ? 1 : 0;
  const worst = open.reduce((a, b) => level(b) < level(a) ? b : a);
  return { level: level(worst), unaccepted: open.filter(m => !m.receipts.accepted).length, worst, open };
}

function memberSeverity(member, ctx) {
  const { now, messages } = ctx;
  if (member.observed === 'unknown') return 'unknown';
  if (member.observed === 'retired') return 'retired';
  if (member.observed === 'frozen') return 'frozen';
  const lease = member.attempt?.lease;
  if (lease && lease.state === 'expired') return 'bad';
  if (member.wait && member.wait.state === 'timed-out') return 'bad';
  const waitSev = member.wait ? deadlineSeverity(member.wait.openedAt, member.wait.deadline, now) : null;
  if (waitSev === 'bad') return 'bad';
  const overdue = messages.filter(m => m.to === member.id && m.kind !== 'info' && !m.receipts.accepted && m.deadline != null && m.deadline <= now
    && !['resolved', 'cancelled', 'expired', 'dead-letter'].includes(m.lifecycle));
  // Overdue and not yet escalated = breach on this member; once escalated, responsibility moved up → attention only.
  if (overdue.some(m => !m.escalatedTo)) return 'bad';
  if (overdue.length) return 'warn';
  if (member.desired !== member.observed) return 'warn';
  if (contextKnown(member) && member.context.pct >= CONTEXT_WARN) return 'warn';
  if (waitSev === 'warn') return 'warn';
  if (waitSev === 'wait') return 'wait';
  return 'ok';
}

/** Stable ordering memory: rows only move when their severity changes (09 §2.5-2). */
class StableOrder {
  constructor() { this.positions = new Map(); this.severities = new Map(); this.movedAt = new Map(); }
  order(rows, now) {
    const sorted = [...rows].sort((a, b) => {
      const d = SEVERITY[a.severity].rank - SEVERITY[b.severity].rank;
      if (d) return d;
      const pa = this.positions.get(a.member.id), pb = this.positions.get(b.member.id);
      const sameAsBefore = this.severities.get(a.member.id) === a.severity && this.severities.get(b.member.id) === b.severity;
      if (sameAsBefore && pa != null && pb != null) return pa - pb;
      const da = a.member.wait?.deadline ?? Infinity, db = b.member.wait?.deadline ?? Infinity;
      if (da !== db) return da - db;
      return a.member.name.localeCompare(b.member.name);
    });
    sorted.forEach((row, i) => {
      const before = this.severities.get(row.member.id);
      if (before && before !== row.severity) this.movedAt.set(row.member.id, now);
      this.positions.set(row.member.id, i);
      this.severities.set(row.member.id, row.severity);
    });
    return sorted.map(row => ({ ...row, movedAt: this.movedAt.get(row.member.id) ?? 0 }));
  }
}

function counts(data, now, viewer = null) {
  const ctx = { now, messages: data.messages };
  const sev = data.members.map(m => memberSeverity(m, ctx));
  const needs = needsYou(data, now, viewer);
  return {
    members: data.members.length,
    blocked: sev.filter(s => s === 'bad').length,
    unknownMembers: sev.filter(s => s === 'unknown').length,
    unaccepted: data.messages.filter(m => m.kind !== 'info' && !m.receipts.accepted && !['resolved', 'cancelled', 'expired', 'dead-letter'].includes(m.lifecycle)).length,
    unknown: data.unknownEffects.length + sev.filter(s => s === 'unknown').length,
    needsYou: needs.length,
    needsYouUrgent: needs.filter(n => n.severity === 'bad' || n.severity === 'unknown').length,
    redShare: data.members.length ? sev.filter(s => s === 'bad').length / data.members.length : 0,
  };
}

/**
 * One line for an unknown row. The projection publishes a summary when the entity has one (a lost receipt, a moved
 * ref); the read-model rows have none, so their summary is the literal string "unknown" and the list read
 * "unknown unknown". The kind and the id are what actually identify such a row, so they are the label, and the
 * summary is only appended when it says something the id does not.
 */
function unknownLabel(u) {
  const id = String(u?.id ?? '');
  const kind = u?.kind === 'delivery' ? 'delivery' : id.startsWith('read-model:') ? 'read-model' : id.startsWith('message:') ? 'message' : id.startsWith('task:') ? 'task' : (u?.kind ?? 'unknown');
  const detail = id.startsWith('read-model:') ? id.replace(/^read-model:/, '').split(':').slice(0, -1).join(':') + '（' + (u.owner ?? id.split(':').at(-1)) + '）' : shortId(id);
  const summary = typeof u?.summary === 'string' && u.summary !== 'unknown' && u.summary.trim() ? u.summary : null;
  return summary ? `${kind} · ${detail} — ${summary}` : `${kind} · ${detail}`;
}

/**
 * "Needs you": threads owned by / escalating to the viewer principal, unknown effects, approvals,
 * completion tokens; deadline order (09 §2.2-2). Without a viewer no thread is attributed to "you".
 */
function needsYou(data, now, viewer = null) {
  if (viewer && typeof viewer === 'object') viewer = viewer.memberId; // local display comparison inside the authenticated team envelope
  const items = [];
  for (const t of data.threads) {
    // P5: a resource thread is a topic, not a response obligation. Older servers that put one in threads must not
    // turn it into "needs you" (or into requiredRespondents work).
    if (t.kind === 'resource') continue;
    if (['decided', 'closed', 'cancelled', 'superseded'].includes(t.state)) continue;
    if (!viewer || (t.owner !== viewer && t.escalationOwner !== viewer)) continue;
    const sev = t.state === 'escalated' && t.deadline <= now ? 'bad' : deadlineSeverity(t.openedAt, t.deadline, now);
    items.push({ kind: 'thread', id: t.id, ref: t, title: `#${t.id.replace('thr-', '')} ${t.question}`, severity: sev, deadline: t.deadline,
      owner: t.owner === viewer ? 'you' : memberName(data, t.owner), action: '处理' });
  }
  // A verdict on an unknown effect is operator-only (core/mailbox.mjs, delivery/index.mjs): the row is listed
  // because it blocks the team, but its owner is the operator, not the viewer. Saying "you" here was the mismatch the
  // visual acceptance caught -- the panel offered the work as yours and the server refused it with ROLE_DENIED.
  for (const u of data.unknownEffects) items.push({ kind: 'unknown', id: u.id, ref: u, title: unknownLabel(u), severity: 'unknown',
    deadline: u.openedAt, owner: viewer === 'operator' ? 'you' : 'operator', action: viewer === 'operator' ? '裁决' : '查看' });
  // A v1 capacity lane held by an unknown external effect is a safety decision for a person, not queueing: it belongs
  // in "needs you" (v3 §4), its primary action opens the detail (effectId, duration, disposition), and no command is
  // invented for it. The opening time is used only to order the row against the other obligations.
  const capacity = capacityView(data), occupants = unknownOccupants(data);
  for (const occ of occupants) {
    const openedAt = occ.openedAt ?? (typeof occ.durationMs === 'number' ? now - occ.durationMs : null);
    items.push({ kind: 'capacity', id: occ.id, ref: occ.ref, title: '外部效果结果不明：' + (occ.effectId ?? occ.id) + ' 占用' + (occ.lane === 'human' ? '交互' : '执行') + '名额',
      severity: 'unknown', deadline: openedAt, owner: viewer === 'operator' ? 'you' : 'operator', action: '查看详情',
      effectId: occ.effectId, lane: occ.lane });
  }
  // Admission closed without a listed occupant still stops every new execution: the same person has to look at it.
  if (capacity?.admissionClosed && !occupants.length) items.push({ kind: 'capacity', id: 'capacity:admission',
    ref: null, title: '执行准入已关闭：新的执行请求不会被接纳', severity: 'unknown', deadline: null,
    owner: viewer === 'operator' ? 'you' : 'operator', action: '查看详情', effectId: null, lane: null });
  // Approvals may have no deadline (committed contracts without one): they sort last, never get an invented deadline.
  if (approvalsKnown(data)) for (const a of data.approvals) items.push({ kind: 'approval', id: a.id, ref: a, title: a.summary, severity: deadlineSeverity(a.openedAt, a.deadline ?? null, now),
    deadline: a.deadline ?? null, owner: 'you', action: '审阅' });
  if (data.goal.completionToken === 'prepared') items.push({ kind: 'goal', id: data.goal.id, ref: data.goal, title: `授权 goal 完成：${data.goal.title}`, severity: 'warn', deadline: now, owner: 'you', action: '授权' });
  return items.sort((a, b) => (a.deadline ?? Infinity) - (b.deadline ?? Infinity));
}

// ── P5: v1 read states (capacity, role guard, batches, resource threads) ──────────────────
/**
 * The v1 capacity block as the panel reads it. A missing block is no data (an off team), never 0/0: the caller renders
 * nothing rather than inventing an idle team. A missing limit stays null (unknown), again never a fabricated number.
 */
function capacityView(data) {
  const c = data?.capacity;
  if (!c || !c.normal || !c.human) return null;
  const lane = value => ({ current: value.current, limit: typeof value.limit === 'number' ? value.limit : null,
    unknown: value.unknown ?? 0, queued: value.queued ?? null, oldestAge: value.oldestAge ?? null });
  return { normal: lane(c.normal), human: lane(c.human), unknown: c.unknown ?? 0,
    admissionClosed: c.admissionClosed === true, queued: c.queued ?? null, oldestAge: c.oldestAge ?? null,
    blocked: Array.isArray(c.blocked) ? c.blocked : [], occupants: Array.isArray(c.occupants) ? c.occupants : [],
    // Gap 3: an unreadable provider state is 'unknown', never 'available'. The wait says whether the queue is ours.
    providerCapacity: ['unknown', 'available', 'throttled'].includes(c.providerCapacity) ? c.providerCapacity : 'unknown',
    providerWait: ['none', 'local-queued', 'provider-throttled'].includes(c.providerWait) ? c.providerWait : 'none',
    providerRetryAfterMs: typeof c.providerRetryAfterMs === 'number' ? c.providerRetryAfterMs : null,
    providerRecoveryAt: typeof c.providerRecoveryAt === 'number' ? c.providerRecoveryAt : null };
}
/** "current/limit" with an explicit unknown limit; never prints "3/0" for a limit nobody published. */
function laneText(lane) {
  if (!lane) return null;
  return lane.limit == null ? lane.current + '/?' : lane.current + '/' + lane.limit;
}
/**
 * Capacity held by an external effect whose real result is unknown. This is not queueing: the server never releases it
 * on timeout, so only a person can settle it. The occupant is reported with what a person needs (effectId, how long it
 * has held the lane, which lane) and carries no command -- the panel opens a read-only detail instead.
 */
function unknownOccupants(data) {
  const c = capacityView(data);
  if (!c) return [];
  return c.occupants.filter(occupant => occupant && occupant.state === 'unknown').map(occupant => {
    const lane = occupant.lane === 'human' ? c.human : c.normal;
    return {
      id: 'capacity:' + String(occupant.ref ?? occupant.effectId ?? occupant.originRef ?? 'unknown'),
      ref: occupant, lane: occupant.lane ?? null,
      // effectId is the external effect this occupancy belongs to; never invented when the row has none.
      effectId: occupant.effectId ?? occupant.originRef ?? occupant.ref ?? null,
      openedAt: typeof occupant.openedAt === 'number' ? occupant.openedAt : null,
      // An occupant without its own clock borrows the published oldest age of its lane (a duration, not a start time).
      durationMs: typeof occupant.openedAt === 'number' ? null : lane.oldestAge ?? c.oldestAge ?? null,
    };
  });
}
/** The v1 role-guard block. installed=null means the composition did not report it (unknown), not "not installed". */
function roleGuardView(data) {
  const g = data?.roleGuard;
  if (!g) return null;
  return { coordinatorOnly: g.coordinatorOnly === true, installed: typeof g.installed === 'boolean' ? g.installed : null,
    revoked: typeof g.revoked === 'boolean' ? g.revoked : null, denials: g.denials ?? 0, allows: g.allows ?? 0,
    auditPersistFailed: typeof g.auditPersistFailed === 'boolean' ? g.auditPersistFailed : null,
    declared: Array.isArray(g.declared) ? g.declared : null, policy: g.policy ?? null,
    audit: g.audit ?? { denied: 0, allowed: 0, byTool: null } };
}
/** The committed batch manifest as the panel reads it; absent means no batch block was published. */
function inputsView(data) {
  const i = data?.inputs;
  if (!i) return null;
  const latest = i.latest ?? null;
  return { count: i.count ?? 0, latest, items: latest?.items ?? null, pendingCount: latest?.pendingCount ?? null,
    omittedCount: latest?.omittedCount ?? null, nextCursor: latest?.nextCursor ?? null };
}
/** Resource threads the envelope published for this viewer (already ACL-filtered by the server). */
function resourceThreadsOf(data) {
  return Array.isArray(data?.resourceThreads) ? data.resourceThreads.filter(thread => thread?.kind === 'resource') : [];
}

/**
 * The only new states that deserve a line on "now": something needs a person, or the team is not admitting work.
 * Normal capacity is silent (v3 §1: a healthy state takes no space), and nothing here creates a notification.
 */
function borrowAttention(data, viewer = null) {
  const capacity = capacityView(data), guard = roleGuardView(data), inputs = inputsView(data);
  const root = viewer === 'operator' || data?.members?.some(member => member.id === viewer && member.role === 'root');
  const items = [];
  if (capacity) {
    if (capacity.admissionClosed) items.push({ kind: 'capacity', severity: 'bad',
      title: '执行准入已关闭：仍有 ' + capacity.unknown + ' 个 unknown 占用未证明终结' });
    if (capacity.human.unknown > 0) items.push({ kind: 'capacity', severity: 'bad',
      title: '交互名额有 ' + capacity.human.unknown + ' 个 unknown 占用；不会按超时释放' });
    if (root && capacity.human.queued > 0) items.push({ kind: 'human', severity: 'warn',
      title: capacity.human.queued + ' 件人工/协调请求在等 root（H=1，按到达序）' });
    if (!root && capacity.human.queued > 0) items.push({ kind: 'human', severity: 'warn',
      title: '有 ' + capacity.human.queued + ' 件事在等组长决定' });
    if (root && capacity.blocked.length > 0) items.push({ kind: 'capacity', severity: 'warn',
      title: capacity.blocked.length + ' 个人工请求未获放行；越权或不可达的请求保持拒绝，不自动通过' });
  }
  if (guard) {
    if (guard.auditPersistFailed === true) items.push({ kind: 'guard', severity: 'bad',
      title: '角色守卫的拒绝已生效，但审计写入失败（不会因此改为放行）' });
    if (root && guard.denials > 0) items.push({ kind: 'guard', severity: 'warn',
      title: 'root 已拒绝 ' + guard.denials + ' 次执行型工具请求（只协调，不执行）' });
  }
  if (inputs && Number.isSafeInteger(inputs.omittedCount) && inputs.omittedCount > 0) items.push({ kind: 'inputs', severity: 'warn',
    title: '最近一批有 ' + inputs.omittedCount + ' 项未装入，仍在 pending，等待下一步' });
  return items;
}

function pipelineCounts(tasks) {
  const out = Object.fromEntries(PIPELINE.map(k => [k, 0]));
  for (const t of tasks) if (t.state in out) out[t.state]++;
  return out;
}

function groupRows(data, now, order, options = {}) {
  const ctx = { now, messages: data.messages };
  const tasks = new Map(data.tasks.map(t => [t.id, t]));
  const rows = data.members.map(member => ({ member, severity: memberSeverity(member, ctx), task: member.taskId ? tasks.get(member.taskId) ?? null : null,
    ack: ackSummary(data.messages, member.id) }));
  // Groups come from the snapshot; a member whose group is not described (incremental events carry no
  // group metadata yet) still gets a row in a bucket labelled by its own group field — never dropped.
  const groups = new Map(data.groups.map(g => [groupKey(g.id), { ...g, id: groupKey(g.id), label: g.label ?? (g.id == null ? '未分组' : g.id) }]));
  for (const m of data.members) if (!groups.has(groupKey(m.group)))
    groups.set(groupKey(m.group), { id: groupKey(m.group), label: m.group ?? '未分组', lead: null, undescribed: true });
  return [...groups.values()].map(group => {
    const groupRowsRaw = rows.filter(r => groupKey(r.member.group) === group.id);
    const ordered = order.order(groupRowsRaw, now);
    const tally = {};
    for (const r of ordered) tally[r.severity] = (tally[r.severity] ?? 0) + 1;
    const known = ordered.filter(r => contextKnown(r.member)).map(r => r.member.context.pct);
    const maxCtx = known.length ? Math.max(...known) : null; // null = 暂无数据, never 0
    // A group holding only the root member renders without a header row.
    const headless = ordered.length > 0 && ordered.every(r => r.member.role === 'root');
    return { group, rows: ordered, tally, maxCtx, headless, hot: (tally.bad ?? 0) + (tally.unknown ?? 0) > 0 };
  }).filter(g => g.rows.length || options.keepEmpty);
}

/** Follow typed waits from `memberId` (for "only anomalies" + wait-chain highlight). */
function waitChain(data, memberId) {
  const seen = new Set();
  let cur = data.members.find(m => m.id === memberId);
  while (cur?.wait?.memberRef && !seen.has(cur.id)) { seen.add(cur.id); cur = data.members.find(m => m.id === cur.wait.memberRef); }
  if (cur) seen.add(cur.id);
  return seen;
}

/**
 * A deadline that was never committed is not a deadline that has passed.
 *
 * The projection publishes `deadline: null` for an approval whose task carries no deadline (view.mjs passes null), and
 * "0" for the many rows that were committed without one (time(null) is 0). Subtracting the current clock from null/0
 * produced "超期 498106h11m" for a contract that simply has no due date: a fabricated fact, and the most alarming one
 * the panel can display. Both cases are reported as "no deadline" instead, and the caller decides how to phrase it.
 */
function hasDeadline(deadline) { return typeof deadline === 'number' && Number.isFinite(deadline) && deadline > 0; }
function relTime(ms) {
  const abs = Math.abs(ms), m = Math.round(abs / 60000), s = Math.round(abs / 1000);
  const text = abs < 60000 ? `${s}s` : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? String(m % 60).padStart(2, '0') + 'm' : ''}`;
  return ms < 0 ? `超期 ${text}` : text;
}
function utc(ts) { return ts == null ? '' : new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'; }
function clock(ts) { return ts == null ? '—' : new Date(ts).toTimeString().slice(0, 8); }
function shortId(id) { return id && id.length > 12 ? id.slice(0, 7) + '…' : id; }
function truncate(text, n) { return text && text.length > n ? text.slice(0, n - 1) + '…' : text; }

// ── session ↔ member, session-header mini strip, L2 task detail (09 §2.1 L0 mini, §3.2, §5.5) ──
/**
 * The member whose native session is `sessionId`, or — when the conversation frame is showing a member view on
 * this very session (Team nav to a member without a local session) — that member. Anything else is not a Team
 * session: null (the header strip renders nothing).
 */
function sessionMember(data, sessionId, ui = {}) {
  if (!data || sessionId == null) return null;
  const owner = data.members.find(m => m.nativeRef != null && m.nativeRef === sessionId);
  if (owner) return owner;
  if (ui.viewing && ui.frameSession === sessionId) return data.members.find(m => m.id === ui.viewing) ?? null;
  return null;
}
/**
 * Compact status for the session-header mini strip: role, observed status, unread (= inbound action/decision
 * messages not yet accepted) and pending approvals. Unknown stays null; never a fabricated 0.
 */
function miniStatus(data, member) {
  const ack = ackSummary(data.messages ?? [], member.id);
  const pendingKnown = approvalsKnown(data) && Array.isArray(data.approvals);
  return {
    role: member.role, abbr: ROLE_ABBR[member.role] ?? '?',
    status: member.observed === 'unknown' || member.observed == null ? null : member.observed,
    mismatch: member.desired != null && member.observed != null && member.desired !== member.observed ? member.desired : null,
    unread: ack?.unaccepted ?? 0,
    pending: pendingKnown ? data.approvals.filter(a => a.member === member.id).length : null,
    ctxPct: contextKnown(member) ? Math.round(member.context.pct) : null,
  };
}
/** Attempts split for the L2 task card: the live one first, superseded ones behind a disclosure. Unknown → null. */
function taskAttempts(task) {
  if (!Array.isArray(task?.attempts)) return null;
  const superseded = task.attempts.filter(a => a.supersededBy != null);
  const live = task.attempts.filter(a => a.supersededBy == null);
  return { live, superseded, total: task.attempts.length };
}
/**
 * Delivery read state of a task. `delivery: null` is a known "no delivery yet"; `delivery` absent is unknown.
 * `binding` is the parsed `delivery.certificateBinding` (null when the projection omits it = no committed fact).
 */
function deliveryInfo(task, data = null) {
  if (!task || task.delivery === undefined) return { known: false };
  if (task.delivery === null) return { known: true, none: true };
  const d = task.delivery;
  return { known: true, none: false, revision: d.revision ?? null, certificate: d.certificate ?? null, merge: d.merge ?? null,
    binding: certificateBinding(task, data) };
}
const HEX64 = /^[a-f0-9]{64}$/;
const str = v => typeof v === 'string' && v.length > 0 ? v : null;
const posInt = v => Number.isInteger(v) && v >= 1 ? v : null;
/**
 * Parse `tasks[].delivery.certificateBinding` per packages/projections/schema.mjs certificateBindingSchema.
 * Absent → null (no certificate evidence). Each field that is missing or malformed is null (UI: 未知) — never filled in.
 * `attempt` resolves `attemptId` against the task's attempts (and the owner's current attempt):
 *   'none' = the certificate binds no attempt (legacy; never inferred), 'matched' = found, 'unmatched' = id not in this task.
 * The binding is the historical signed certificate, not an authorization; `delivery.certificate` stays the validity flag.
 */
function certificateBinding(task, data = null) {
  const b = task?.delivery?.certificateBinding;
  if (b == null || typeof b !== 'object') return null;
  const hash = typeof b.certificateHash === 'string' && HEX64.test(b.certificateHash) ? b.certificateHash : null;
  const taskId = str(b.taskId);
  let attempt = { state: 'none', id: null, match: null };
  if (b.attemptId !== undefined) {
    const id = str(b.attemptId);
    const owner = data?.members?.find(m => m.id === task.owner);
    const match = id && ((task.attempts ?? []).find(a => a.id === id) ?? (owner?.attempt?.id === id ? owner.attempt : null));
    attempt = { state: match ? 'matched' : 'unmatched', id, match: match ? { n: match.n ?? null, state: match.state ?? null } : null };
  }
  return { hash, hashShort: hash ? hash.slice(0, 12) : null, taskId, taskMatches: taskId == null ? null : taskId === task.id,
    verifier: str(b.verifier), contractRevision: posInt(b.contractRevision), candidate: str(b.candidate), tree: str(b.tree),
    deliveryId: str(b.deliveryId), deliveryRevision: posInt(b.deliveryRevision), status: str(b.status), attempt };
}

//#endregion
//#region src/store.mjs
// Local UI state only: selection, tab, filters, density, collapsed groups, viewed session (09 §3.1).
// Business state lives in the projection; nothing here is written back.

const STORAGE_KEY = 'dsh-v2.team-ui';

/**
 * Left-tab edge rule. `context` is 'team' (Team overview or a member's session) or 'workspace' (any other
 * conversation). The tab only switches when the context changes; inside one context the user's last manual
 * choice wins. The tab is persisted together with the context it belongs to, so a reload into the same
 * context keeps it, while a reload into the other context is an edge.
 * @returns the tab to show after moving from `prevContext` to `nextContext`.
 */
function nextSidebarTab(prevContext, nextContext, currentTab) {
  if (prevContext === nextContext) return currentTab;
  return nextContext === 'team' ? 'team' : 'workspaces';
}

/**
 * Conversation-frame transition when the current Session (or the projection) changes.
 * - Session changed to a member's native session (nativeRef) → view that member (Team session).
 * - Session changed to anything else while viewing a member → leave the Team view.
 * - Session unchanged → keep the explicit view (e.g. Team nav to a member without a local session, or ✕).
 * @returns {{viewing: string|null, context: 'team'|'workspace'}}
 */
function frameTransition({ prevSessionId, sessionId, viewing, members }) {
  const changed = sessionId !== prevSessionId;
  const owner = sessionId ? members.find(m => m.nativeRef === sessionId) : null;
  let next = viewing;
  if (changed && owner) next = owner.id;
  else if (changed && viewing && prevSessionId !== undefined) {
    const viewed = members.find(m => m.id === viewing);
    // Team nav switches to the member's own session; any other switch is a native navigation away.
    if (!viewed || viewed.nativeRef !== sessionId) next = null;
  }
  return { viewing: next, context: next ? 'team' : 'workspace' };
}

function createUiStore(storage, tabStorage) {
  let persisted = {}, tab = {};
  try { persisted = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '{}') ?? {}; } catch {}
  // Per-tab view position (selected / detail / viewed session) survives a hard refresh.
  try { tab = JSON.parse(tabStorage?.getItem(STORAGE_KEY) ?? '{}') ?? {}; } catch {}
  let state = {
    selected: tab.selected ?? null, // member id highlighted in lanes / roster
    page: tab.page ?? 'now', // v3 §3: now | members | records
    inspector: tab.inspector ?? null, // v3 §3.4: {kind:'member'|'record'|'capacity', id} or null (collapsed)
    recordFilter: persisted.recordFilter ?? 'all', // all | anomaly | needs-you | root-decision | delivery
    recordMember: persisted.recordMember ?? null,
    recordRange: persisted.recordRange ?? 'all', // all | today | 7d
    details: persisted.details === true, // '.' toggles the technical-details layer
    toast: null,
    detail: tab.detail ?? { tab: 'member', id: null }, // right panel object
    onlyAnomalies: persisted.onlyAnomalies === true,
    density: persisted.density ?? 'auto', // auto | comfortable | compact
    collapsed: persisted.collapsed ?? {}, // groupId -> boolean (explicit user choice)
    viewing: tab.viewing ?? null, // member id whose native session is in the center (null = not a Team view)
    sidebarTab: persisted.sidebarTab ?? 'team',
    teamContext: persisted.teamContext ?? null, // context the persisted tab was chosen in
    frameSession: tab.frameSession, // last Session seen by the conversation frame (undefined = never)
    stage: null, // pipeline filter
    drawer: null, // 'detail' | null (narrow/mid layouts)
    palette: null, // pending command descriptor
    flash: { id: null, at: 0 },
    messageFilter: persisted.messageFilter ?? { unaccepted: false, actionable: true, mine: false },
    showAllNeeds: false,
    threadKind: persisted.threadKind === 'resource' ? 'resource' : 'decision', // P5: decision vs resource thread list
  };
  const listeners = new Set();
  const persist = () => {
    try { storage?.setItem(STORAGE_KEY, JSON.stringify({ onlyAnomalies: state.onlyAnomalies, density: state.density, collapsed: state.collapsed,
      sidebarTab: state.sidebarTab, teamContext: state.teamContext, messageFilter: state.messageFilter,
      threadKind: state.threadKind, recordFilter: state.recordFilter, recordMember: state.recordMember,
      recordRange: state.recordRange, details: state.details }));
      tabStorage?.setItem(STORAGE_KEY, JSON.stringify({ selected: state.selected, detail: state.detail, viewing: state.viewing,
        page: state.page, inspector: state.inspector,
        ...(state.frameSession === undefined ? {} : { frameSession: state.frameSession }) })); } catch {}
  };
  const set = patch => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; persist(); for (const l of listeners) l(); };
  return {
    getSnapshot: () => state,
    subscribe: l => { listeners.add(l); return () => listeners.delete(l); },
    set,
    resetScope: sessionId => set({ selected: null, viewing: null, frameSession: sessionId, inspector: null,
      detail: { tab: 'member', id: null }, drawer: null, palette: null, recordMember: null, toast: null }),
    select: id => set({ selected: id }),
    openDetail: (tab, id) => set(s => ({ detail: { tab, id: id ?? (tab === 'member' ? s.selected : null) } })),
    setTab: tab => set(s => ({ detail: { tab, id: tab === 'member' || tab === 'context' || tab === 'resource' ? s.selected : null } })),
    setThreadKind: kind => set({ threadKind: kind === 'resource' ? 'resource' : 'decision' }),
    toggleAnomalies: () => set(s => ({ onlyAnomalies: !s.onlyAnomalies })),
    cycleDensity: effective => set({ density: effective === 'compact' ? 'comfortable' : 'compact' }),
    setGroup: (id, collapsed) => set(s => ({ collapsed: { ...s.collapsed, [id]: collapsed } })),
    flash: id => set({ flash: { id, at: Date.now() }, selected: id }),
    setStage: stage => set(s => ({ stage: s.stage === stage ? null : stage })),
    openPalette: command => set({ palette: command }),
    closePalette: () => set({ palette: null }),
    setDrawer: drawer => set({ drawer }),
    setViewing: id => set({ viewing: id }),
    setSidebarTab: tab => set({ sidebarTab: tab }),
    /** Enter a context; switches the tab only on an edge (see nextSidebarTab). No-op inside the same context. */
    enterContext(context) {
      if (state.teamContext === context) return;
      set(s => ({ teamContext: context, sidebarTab: nextSidebarTab(s.teamContext, context, s.sidebarTab) }));
    },
    /**
     * Conversation frame saw `sessionId`. No decision while the projection is not loaded (members null) or while no
     * Session is selected yet (null/undefined: transient during boot and navigation), so a reload does not fake an edge.
     */
    syncFrame(sessionId, members) {
      if (!members || sessionId == null) return;
      const r = frameTransition({ prevSessionId: state.frameSession, sessionId, viewing: state.viewing, members });
      const patch = {};
      if (state.frameSession !== sessionId) patch.frameSession = sessionId;
      if (r.viewing !== state.viewing) Object.assign(patch, { viewing: r.viewing, ...(r.viewing ? { selected: r.viewing } : {}) });
      if (state.teamContext !== r.context) Object.assign(patch, { teamContext: r.context, sidebarTab: nextSidebarTab(state.teamContext, r.context, state.sidebarTab) });
      if (Object.keys(patch).length) set(patch);
    },
    setMessageFilter: patch => set(s => ({ messageFilter: { ...s.messageFilter, ...patch } })),
    toggleAllNeeds: () => set(s => ({ showAllNeeds: !s.showAllNeeds })),
    setPage: page => set({ page: ['now', 'members', 'records'].includes(page) ? page : 'now' }),
    openInspector: (kind, id, extra = {}) => set(s => ({ inspector: { kind, id, ...extra }, ...(kind === 'member' ? { selected: id } : {}) })),
    closeInspector: () => set({ inspector: null, drawer: null }),
    setRecordFilter: filter => set({ recordFilter: filter }),
    setRecordMember: member => set({ recordMember: member }),
    setRecordRange: range => set({ recordRange: range }),
    toggleDetails: () => set(s => ({ details: !s.details })),
    toast: text => set({ toast: { text, at: Date.now() } }),
  };
}

//#endregion
//#region src/scope.mjs
// One stable external store; only this production entry owns client/source replacement.
class TeamScope {
  constructor({ createSource, ui, install = () => {} }) {
    this.createSource = createSource; this.ui = ui; this.install = install;
    this.bindingSource = createSource().source;
    this.listeners = new Set(); this.generation = 0; this.sessionId = undefined;
    this.client = null; this.unlisten = null; this.pending = null;
    this.state = { data: null, viewer: null, status: 'loading', binding: undefined, scopeGeneration: 0 };
  }
  getSnapshot = () => this.state;
  subscribe = fn => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  publish(patch) { this.state = { ...this.state, ...patch }; for (const fn of this.listeners) fn(); }
  start() { return this.switchSession(this.ui.getSnapshot().frameSession, true); }
  stop() {
    this.generation++; this.unlisten?.(); this.client?.stop();
    this.unlisten = null; this.client = null; this.pending = null; this.install(null);
    this.publish({ data: null, viewer: null, status: 'stopped', binding: undefined, error: null,
      retryAt: null, scopeGeneration: this.generation });
  }
  resync(reason) { return this.client ? this.client.resync(reason) : this.switchSession(this.sessionId, true); }
  switchSession(sessionId, force = false) {
    sessionId ??= null;
    if (!force && this.pending && sessionId === this.sessionId) return this.pending;
    if (!force && this.state.status !== 'error' && this.state.binding !== undefined && sessionId === this.sessionId) return Promise.resolve();
    const generation = ++this.generation;
    this.unlisten?.(); this.unlisten = null; this.client?.stop(); this.client = null;
    this.sessionId = sessionId; this.install(null);
    this.ui.resetScope(sessionId);
    this.state = { data: null, viewer: null, status: 'loading', error: null, binding: undefined,
      sessionId, teamId: null, scopeGeneration: generation };
    this.publish({});
    const current = () => generation === this.generation;
    this.pending = (async () => {
      try {
        // The standalone overview has no native session; a selected session always requires binding confirmation.
        const binding = sessionId == null ? 'overview' : await this.bindingSource.binding(sessionId);
        if (!current()) return;
        if (!binding) { this.publish({ status: 'ready', binding: null }); return; }
        const picked = this.createSource(binding === 'overview' ? null : binding);
        const client = new ProjectionClient(picked.source, { teamId: binding.teamId ?? null });
        this.client = client; this.install(picked);
        const update = () => {
          if (!current()) return;
          this.publish({ ...client.getSnapshot(), binding, sessionId, scopeGeneration: generation });
          const cmd = this.ui.getSnapshot().palette;
          if (cmd && commandAdmission(cmd, this.state.data, this.state.viewer, generation)) this.ui.closePalette();
        };
        this.unlisten = client.subscribe(update);
        await client.start();
        if (current()) this.ui.syncFrame(sessionId, client.getSnapshot().data?.members ?? null);
      } catch (error) {
        if (current()) this.publish({ status: 'error', error: String(error?.message ?? error), binding: undefined });
      } finally { if (current()) this.pending = null; }
    })();
    return this.pending;
  }
}

//#endregion
//#region src/activity.mjs
// Request generation covers first pages, older pages, failures and source/team/filter changes alike.
class ActivityPager {
  constructor(initialPage = null) {
    this.state = { page: initialPage, loading: false, error: null };
    this.listeners = new Set(); this.generation = 0; this.key = null; this.source = null;
  }
  getSnapshot = () => this.state;
  subscribe = fn => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  set(patch) { this.state = { ...this.state, ...patch }; for (const fn of this.listeners) fn(); }
  matches(source, query, scope) { return this.source === source && this.key === JSON.stringify([query, scope]); }
  setScope(source, query, scope) {
    if (this.matches(source, query, scope)) return Promise.resolve();
    this.generation++; this.source = source; this.query = query; this.key = JSON.stringify([query, scope]);
    this.set({ page: null, loading: false, error: null });
    return this.load(false);
  }
  dispose() { this.generation++; this.key = null; }
  async load(more = false) {
    if (this.state.loading || !this.source?.activity) return;
    const before = this.state.page;
    if (more && before?.nextBeforeSeq == null) return;
    const generation = this.generation;
    this.set({ loading: true, error: null });
    try {
      const page = await this.source.activity({ ...this.query, ...(more ? { beforeSeq: before.nextBeforeSeq } : {}) });
      if (generation !== this.generation) return;
      const events = more ? [...before.events, ...page.events] : page.events;
      const unique = [...new Map(events.map(event => [event.seq, event])).values()];
      this.set({ page: { ...page, events: unique }, loading: false });
    } catch (error) {
      if (generation === this.generation) this.set({ error: String(error?.message ?? error), loading: false });
    }
  }
}
function recordPresentation(data, event) {
  const id = event?.subject?.id ?? event?.id;
  const row = ['members', 'tasks', 'threads', 'messages', 'decisions', 'intents']
    .flatMap(key => data?.[key] ?? []).find(item => item.id === id);
  const raw = event?.subject?.name;
  const fallback = { task: '任务', thread: '讨论', message: '消息', decision: '决定', intent: '提议', member: '成员' };
  const title = row?.title ?? row?.question ?? row?.summary ?? row?.name ??
    (raw && raw !== id ? raw : fallback[event?.kind] ?? '团队记录');
  let text = event?.text ?? '记录已更新';
  for (const prefix of [raw, id, title].filter(Boolean)) {
    if (text.startsWith(prefix + '：') || text.startsWith(prefix + ':')) { text = text.slice(prefix.length + 1).trim(); break; }
  }
  // References remain available in the technical disclosure, not in the human summary.
  const references = referenceIds(data, event);
  return { title: humanText(title, fallback[event?.kind] ?? '团队记录', references),
    text: humanText(text, '记录已更新', references) };
}

//#endregion
//#region src/styles.mjs
// Team UI stylesheet. Colors inherit the upstream theme aliases (dsh-client-ui-theme); only the
// "unknown" purple has no upstream alias and is defined here for light/dark (09 §2.3).
const CSS = String.raw`
.tm{--tm-fg:var(--dsw-alias-label-primary);--tm-fg2:var(--dsw-alias-label-secondary);--tm-fg3:var(--dsw-alias-label-tertiary);--tm-cap:var(--dsw-alias-label-caption);
--tm-line:var(--dsw-alias-border-l1);--tm-line2:var(--dsw-alias-border-l2);--tm-hover:var(--dsw-alias-interactive-bg-hover);--tm-active:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover));
--tm-bg:var(--dsw-alias-bg-base);--tm-bg1:var(--dsw-alias-bg-layer-1);--tm-bg2:var(--dsw-alias-bg-layer-2);
--tm-ok:var(--dsw-alias-label-secondary);--tm-wait:var(--dsw-static-blue-500,#3b82f6);--tm-warn:var(--dsw-alias-state-warn-primary,#f59e0b);
--tm-bad:var(--dsw-alias-state-error-primary,#ec1313);--tm-unknown:#7c3aed;--tm-idle:var(--dsw-alias-state-idle-primary,#8a8f98);--tm-done:var(--dsw-alias-state-success-primary,#22c55e);
--tm-accent:var(--dsw-alias-state-business-primary,#4176e6);--tm-mono:var(--dsh-font-family-code,var(--dsh-font-family-code-default,ui-monospace,monospace));
color:var(--tm-fg);font-size:13px;line-height:1.45;font-family:var(--dsw-font-family,inherit);-webkit-font-smoothing:antialiased}
body[data-ds-dark-theme] .tm{--tm-unknown:#a78bfa;--tm-wait:var(--dsw-static-blue-400,#60a5fa)}
.tm *{box-sizing:border-box}
.tm .num,.tm .mono{font-family:var(--tm-mono);font-variant-numeric:tabular-nums;font-size:12px;letter-spacing:-.01em}
.tm [data-sev=bad]{--sev:var(--tm-bad)}.tm [data-sev=unknown]{--sev:var(--tm-unknown)}.tm [data-sev=warn]{--sev:var(--tm-warn)}
.tm [data-sev=wait]{--sev:var(--tm-wait)}.tm [data-sev=ok]{--sev:var(--tm-ok)}.tm [data-sev=frozen],.tm [data-sev=retired]{--sev:var(--tm-idle)}.tm [data-sev=done]{--sev:var(--tm-done)}
.tm-glyph{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;color:var(--sev);font-size:11px;line-height:1;font-family:var(--tm-mono)}
.tm-glyph[data-sev=bad]{font-size:10px}.tm-glyph[data-sev=ok]{font-size:9px}
.tm-glyph[data-sev=unknown]{font-weight:700;font-size:10px;width:14px;height:14px;margin:1px;border:1.5px solid var(--sev);border-radius:2px;transform:rotate(45deg)}
.tm-glyph[data-sev=unknown]>span{transform:rotate(-45deg)}
.tm-sevtext{color:var(--sev)}
.tm button{font:inherit;color:inherit}
.tm-btn{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:6px;border:1px solid var(--tm-line2);background:transparent;cursor:pointer;font-size:12px;white-space:nowrap;color:var(--tm-fg)}
.tm-btn:hover{background:var(--tm-hover)}.tm-btn:disabled{opacity:.45;cursor:not-allowed}
.tm-btn[aria-pressed=true]{background:var(--tm-active);border-color:var(--tm-fg3)}
/* Scoped as ".tm .tm-btn-primary" (0,2,0) on purpose: the generic ".tm button" colour rule (0,1,1) is more
   specific than a bare class and silently replaced this text colour with the page foreground -- the label became the
   same colour as its own fill (both #f9fafb in the dark theme). The fill is --tm-fg and the text --tm-bg1, a pair that
   inverts in light (dark on white) and dark (near-white on dark) themes. */
.tm .tm-btn-primary{background:var(--tm-fg);color:var(--tm-bg1);border-color:transparent;font-weight:500}
.tm .tm-btn-primary:hover{background:var(--tm-fg);opacity:.88}
.tm .tm-btn-primary:disabled{background:color-mix(in srgb,var(--tm-fg) 10%,transparent);color:var(--tm-fg3);opacity:1}
.tm-btn-ghost{border-color:transparent}
.tm-kbd{font-family:var(--tm-mono);font-size:10.5px;color:var(--tm-cap);border:1px solid var(--tm-line2);border-radius:4px;padding:0 4px;line-height:15px}
.tm :focus-visible{outline:2px solid var(--tm-accent);outline-offset:1px;border-radius:4px}
.tm-cap{color:var(--tm-cap)}.tm-fg2{color:var(--tm-fg2)}.tm-fg3{color:var(--tm-fg3)}
.tm-section-title{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--tm-fg3);margin:0 0 6px;height:22px}
.tm-section-title .tm-spacer{flex:1}
.tm-badge{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 6px;border-radius:9px;font-size:11px;border:1px solid var(--tm-line2);color:var(--tm-fg2);white-space:nowrap}
.tm-badge[data-sev]{color:var(--sev);border-color:color-mix(in srgb,var(--sev) 40%,transparent);background:color-mix(in srgb,var(--sev) 8%,transparent)}
.tm-mock{border-style:dashed;color:var(--tm-fg3)}

/* ── page ─────────────────────────────────────────── */
.tm-page{position:relative;height:100%;min-height:0;display:flex;flex-direction:column;container-type:inline-size;container-name:tmpage;background:var(--tm-bg1);outline:none}
.tm-situation{flex:none;height:40px;display:flex;align-items:center;gap:2px;padding:0 12px 0 16px;border-bottom:1px solid var(--tm-line2);overflow:hidden;white-space:nowrap}
.tm-situation[data-fresh=lagging]{box-shadow:inset 0 0 0 1.5px var(--tm-warn)}
.tm-situation[data-fresh=stale],.tm-situation[data-fresh=error]{box-shadow:inset 0 0 0 1.5px var(--tm-unknown)}
.tm-goal{display:flex;align-items:center;gap:8px;min-width:0;margin-right:10px}
.tm-goal-tag{font-size:11px;font-weight:700;letter-spacing:.08em;color:var(--tm-fg3)}
.tm-goal-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;max-width:220px}
.tm-metric{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 8px;border-radius:6px;color:var(--tm-fg2);font-size:12px;border:0;background:none;cursor:default}
button.tm-metric{cursor:pointer}button.tm-metric:hover{background:var(--tm-hover)}
.tm-metric b{font-family:var(--tm-mono);font-variant-numeric:tabular-nums;font-weight:600;color:var(--tm-fg);font-size:12.5px}
.tm-metric[data-sev] b{color:var(--sev)}
.tm-metric[data-hot=true]{background:color-mix(in srgb,var(--tm-bad) 10%,transparent);color:var(--tm-bad)}
.tm-metric[data-hot=true] b{color:var(--tm-bad)}
.tm-sep{width:1px;height:16px;background:var(--tm-line2);margin:0 4px;flex:none}
.tm-fresh{margin-left:auto;display:inline-flex;align-items:center;gap:8px;color:var(--tm-fg3);font-size:12px}
.tm-fresh[data-level=lagging]{color:var(--tm-warn)}.tm-fresh[data-level=stale],.tm-fresh[data-level=error]{color:var(--tm-unknown)}
/* 15 §9 V-23: green is reserved for accepted work; a live connection is not an acceptance (it uses the wait token). */
.tm-dot{width:6px;height:6px;border-radius:50%;background:var(--tm-wait);flex:none}
.tm-fresh[data-level=lagging] .tm-dot{background:var(--tm-warn)}.tm-fresh[data-level=stale] .tm-dot,.tm-fresh[data-level=error] .tm-dot{background:var(--tm-unknown)}
.tm-body{flex:1;min-height:0;display:flex}
.tm-center{flex:1;min-width:0;overflow:auto;padding:14px 16px 24px;display:flex;flex-direction:column;gap:18px;scrollbar-gutter:stable}
.tm-stale-veil .tm-count-box{outline:1px dashed var(--tm-unknown);outline-offset:2px;text-decoration:line-through}
.tm-alert{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;font-size:12px;border:1px solid color-mix(in srgb,var(--sev) 35%,transparent);background:color-mix(in srgb,var(--sev) 7%,transparent);color:var(--tm-fg)}
.tm-alert .tm-spacer{flex:1}

/* needs you */
.tm-needs{border:1px solid var(--tm-line2);border-radius:10px;overflow:hidden;background:var(--tm-bg1)}
.tm-need{position:relative;display:grid;grid-template-columns:18px minmax(0,1fr) auto auto auto;align-items:center;gap:10px;height:38px;padding:0 10px 0 14px;border-top:1px solid var(--tm-line)}
.tm-need:first-child{border-top:0}
.tm-need:before{content:"";position:absolute;left:0;top:7px;bottom:7px;width:3px;border-radius:0 2px 2px 0;background:var(--sev)}
.tm-need[data-sev=wait]:before,.tm-need[data-sev=ok]:before{opacity:.5}
.tm-need-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;border:0;background:none;padding:0;text-align:left}
.tm-need-title:hover{text-decoration:underline;text-underline-offset:3px}
.tm-need-kind{font-size:11px;color:var(--tm-fg3);margin-right:6px}
.tm-need-when{min-width:64px;text-align:right}
.tm-empty{padding:14px;color:var(--tm-fg3);font-size:12.5px}
.tm-more{width:100%;text-align:left;border:0;border-top:1px solid var(--tm-line);background:none;padding:8px 14px;color:var(--tm-fg3);font-size:12px;cursor:pointer}
.tm-more:hover{background:var(--tm-hover)}

/* lanes */
.tm-lanes{--row:32px;border:1px solid var(--tm-line2);border-radius:10px;overflow:hidden;background:var(--tm-bg1)}
.tm-lanes[data-density=compact]{--row:24px}
.tm-lane-grid{display:grid;grid-template-columns:20px minmax(112px,.85fr) minmax(136px,1fr) minmax(176px,1.35fr) 56px 126px 30px 56px;align-items:center;column-gap:4px}
.tm-lane-head{height:30px;padding:0 10px;border-bottom:1px solid var(--tm-line2);font-size:11px;color:var(--tm-fg3);position:sticky;top:0;background:var(--tm-bg1);z-index:1}
.tm-lane-head>div{overflow:hidden;white-space:nowrap}
.tm-group{display:flex;align-items:center;gap:8px;height:30px;padding:0 10px;border-top:1px solid var(--tm-line);background:color-mix(in srgb,var(--tm-fg) 2.5%,transparent);cursor:pointer;user-select:none;width:100%;border-left:0;border-right:0;border-bottom:0;text-align:left;font-size:12px}
.tm-group:hover{background:var(--tm-hover)}
.tm-group .tm-caret{width:14px;color:var(--tm-fg3);font-size:10px;transition:transform .15s}
.tm-group[aria-expanded=false] .tm-caret{transform:rotate(-90deg)}
.tm-group-name{font-weight:600}
.tm-group-sum{display:flex;align-items:center;gap:8px;color:var(--tm-fg3);font-size:12px;margin-left:4px}
.tm-tally{display:inline-flex;align-items:center;gap:2px}
.tm-row{height:var(--row);padding:0 10px;border-top:1px solid var(--tm-line);cursor:default;position:relative;transition:background .15s}
.tm-row:hover{background:var(--tm-hover)}
.tm-row[aria-selected=true]{background:color-mix(in srgb,var(--tm-accent) 9%,transparent)}
.tm-row[aria-selected=true]:before{content:"";position:absolute;left:0;top:4px;bottom:4px;width:2px;background:var(--tm-accent);border-radius:0 2px 2px 0}
.tm-row[data-sev=bad]{background-image:linear-gradient(90deg,color-mix(in srgb,var(--tm-bad) 7%,transparent),transparent 40%)}
.tm-row[data-sev=unknown]{background-image:linear-gradient(90deg,color-mix(in srgb,var(--tm-unknown) 8%,transparent),transparent 40%)}
.tm-row[data-sev=frozen],.tm-row[data-sev=retired]{opacity:.55}
.tm-row[data-flash=true]{animation:tm-flash 2s ease-out}
@keyframes tm-flash{0%,30%{box-shadow:inset 0 0 0 1.5px var(--tm-accent);background-color:color-mix(in srgb,var(--tm-accent) 14%,transparent)}100%{box-shadow:inset 0 0 0 0 transparent}}
.tm-row>div{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;min-width:0}
.tm-name{display:flex;align-items:baseline;gap:6px}
.tm-name strong{font-weight:500;overflow:hidden;text-overflow:ellipsis}
.tm-role{font-family:var(--tm-mono);font-size:10.5px;color:var(--tm-fg3);border:1px solid var(--tm-line2);border-radius:3px;padding:0 3px;line-height:14px;flex:none}
.tm-task{display:flex;gap:6px;align-items:baseline}
.tm-task-state{color:var(--tm-fg3);font-size:12px}
.tm-task-state[data-sev]{color:var(--sev)}
.tm-wait{display:flex;align-items:baseline;gap:5px;color:var(--tm-fg2)}
.tm-wait[data-sev] .tm-wait-left{color:var(--sev)}
.tm-link{border:0;background:none;padding:0;color:var(--tm-fg);text-decoration:underline;text-decoration-color:var(--tm-line2);text-underline-offset:3px;cursor:pointer}
.tm-link:hover{text-decoration-color:currentColor}
.tm-ack{display:flex;align-items:center;gap:6px}
.tm-dots{display:inline-flex;gap:2px}
.tm-dots i{width:6px;height:6px;border-radius:50%;border:1.2px solid var(--tm-fg3);display:block}
.tm-dots i[data-on=true]{background:var(--tm-fg2);border-color:var(--tm-fg2)}
.tm-dots[data-sev=bad] i[data-on=false]{border-color:var(--tm-bad)}
.tm-ctx{display:flex;align-items:center;gap:6px}
.tm-bar{position:relative;width:64px;height:6px;border-radius:3px;background:color-mix(in srgb,var(--tm-fg) 9%,transparent);flex:none;overflow:visible}
.tm-bar-fill{position:absolute;left:0;top:0;bottom:0;border-radius:3px;background:var(--tm-fg3)}
.tm-bar[data-level=warn] .tm-bar-fill{background:var(--tm-warn)}
.tm-bar[data-level=bad] .tm-bar-fill{background:var(--tm-bad)}
.tm-bar-tick{position:absolute;top:-2px;bottom:-2px;width:1.5px;left:80%;background:var(--tm-warn);opacity:.9;border-radius:1px}
.tm-ctx-pct{min-width:28px;text-align:right}
.tm-ctx[data-level=bad] .tm-ctx-pct{color:var(--tm-bad)}.tm-ctx[data-level=warn] .tm-ctx-pct{color:var(--tm-warn)}
.tm-capped{font-size:10px;color:var(--tm-bad);border:1px solid color-mix(in srgb,var(--tm-bad) 45%,transparent);border-radius:3px;padding:0 3px;line-height:13px}
.tm-fold-off{color:var(--tm-fg3);opacity:.7}
.tm-lease-bad{color:var(--tm-bad)}
.tm-restricted{display:flex;align-items:center;gap:8px;height:28px;padding:0 12px;border-top:1px solid var(--tm-line);color:var(--tm-fg3);font-size:12px}
.tm-toolbar{display:flex;align-items:center;gap:6px}

/* pipeline */
.tm-pipe{display:flex;align-items:stretch;gap:0}
.tm-stage{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;padding:9px 12px;border:1px solid var(--tm-line2);margin-left:-1px;background:var(--tm-bg1);cursor:pointer;text-align:left;position:relative}
.tm-stage:first-child{border-radius:10px 0 0 10px;margin-left:0}.tm-stage:last-child{border-radius:0 10px 10px 0}
.tm-stage:hover{background:var(--tm-hover)}
.tm-stage[aria-pressed=true]{background:color-mix(in srgb,var(--tm-accent) 10%,transparent);border-color:color-mix(in srgb,var(--tm-accent) 50%,transparent);z-index:1}
.tm-stage-label{font-size:11.5px;color:var(--tm-fg3);display:flex;align-items:center;gap:5px}
.tm-stage-count{font-family:var(--tm-mono);font-variant-numeric:tabular-nums;font-size:20px;font-weight:600;line-height:1.15}
.tm-stage[data-end=produced] .tm-stage-label:before{content:"";width:8px;height:8px;border-radius:2px;border:1.5px dashed var(--tm-fg3)}
.tm-stage[data-end=accepted]{background:color-mix(in srgb,var(--tm-done) 8%,var(--tm-bg1))}
.tm-stage[data-end=accepted] .tm-stage-count,.tm-stage[data-end=accepted] .tm-stage-label{color:var(--tm-done)}
.tm-stage-arrow{position:absolute;right:-7px;top:50%;transform:translateY(-50%);width:12px;height:12px;z-index:2;color:var(--tm-fg3);font-size:11px;line-height:12px;text-align:center;background:var(--tm-bg1);border-radius:50%}

/* detail */
.tm-detail{flex:none;width:344px;border-left:1px solid var(--tm-line2);display:flex;flex-direction:column;min-height:0;background:var(--tm-bg1)}
.tm-tabs{flex:none;display:flex;gap:2px;height:40px;align-items:flex-end;padding:0 10px;border-bottom:1px solid var(--tm-line2)}
.tm-tab{border:0;background:none;padding:0 9px;height:34px;font-size:12.5px;color:var(--tm-fg3);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.tm-tab:hover{color:var(--tm-fg)}
.tm-tab[aria-selected=true]{color:var(--tm-fg);border-bottom-color:var(--tm-fg);font-weight:500}
.tm-detail-body{flex:1;min-height:0;overflow:auto;padding:14px 16px 20px;display:flex;flex-direction:column;gap:14px}
.tm-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tm-card-head h3{margin:0;font-size:14px;font-weight:600}
.tm-kv{display:grid;grid-template-columns:76px minmax(0,1fr);gap:6px 10px;font-size:12.5px;align-items:baseline}
.tm-kv>dt{color:var(--tm-fg3);margin:0}.tm-kv>dd{margin:0;min-width:0;overflow-wrap:anywhere}
.tm-hr{height:1px;background:var(--tm-line2);border:0;margin:0}
.tm-actions{display:flex;flex-wrap:wrap;gap:6px}
.tm-sub{font-size:12px;color:var(--tm-fg3)}
.tm-list{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}
.tm-li{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;cursor:pointer;font-size:12.5px;border:0;background:none;width:100%;text-align:left}
.tm-li:hover{background:var(--tm-hover)}.tm-li[aria-current=true]{background:var(--tm-active)}
.tm-li .tm-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tm-history{display:flex;flex-wrap:wrap;gap:3px;align-items:center;font-size:11.5px;color:var(--tm-fg3)}
.tm-history b{font-weight:500;color:var(--tm-fg)}
.tm-dl-bar{position:relative;height:4px;border-radius:2px;background:color-mix(in srgb,var(--tm-fg) 9%,transparent);margin-top:4px;overflow:hidden}
.tm-dl-bar>i{position:absolute;left:0;top:0;bottom:0;background:var(--sev);border-radius:2px}
.tm-resp{display:flex;flex-wrap:wrap;gap:6px}
.tm-reply{border-left:2px solid var(--tm-line2);padding:2px 0 2px 10px;font-size:12.5px}
.tm-reply q{quotes:"“" "”"}
.tm-quote-src{font-size:11px;color:var(--tm-fg3)}
.tm-msg{border:1px solid var(--tm-line2);border-radius:8px;padding:9px 11px;display:flex;flex-direction:column;gap:6px;font-size:12.5px}
.tm-msg[data-sev=bad]{border-color:color-mix(in srgb,var(--tm-bad) 45%,transparent)}
.tm-msg-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.tm-receipts{display:grid;grid-template-columns:62px 12px 64px minmax(0,1fr);gap:3px 6px;align-items:center;font-size:12px}
.tm-receipts .tm-r-dot{width:7px;height:7px;border-radius:50%;border:1.2px solid var(--tm-fg3)}
.tm-receipts .tm-r-dot[data-on=true]{background:var(--tm-fg2);border-color:var(--tm-fg2)}
.tm-filters{display:flex;gap:6px;flex-wrap:wrap}
.tm-chip{height:24px;padding:0 9px;border-radius:12px;border:1px solid var(--tm-line2);background:none;font-size:12px;cursor:pointer;color:var(--tm-fg2)}
.tm-chip[aria-pressed=true]{background:var(--tm-fg);color:var(--tm-bg1);border-color:transparent}
.tm-ctx-big .tm-bar{width:100%;height:8px}
.tm-fold-rec{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:12px;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--tm-fg) 3%,transparent)}
.tm-mut{color:var(--tm-fg3);font-size:12px}
.tm-note{font-size:11.5px;color:var(--tm-fg3);line-height:1.5}

/* drawers & responsive */
.tm-scrim{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.25));z-index:20}
.tm-drawer{position:absolute;top:0;bottom:0;right:0;width:min(380px,92%);z-index:21;box-shadow:var(--dsw-elevation-prominent);border-left:1px solid var(--tm-line2)}
.tm-bottom{display:none}
.tm-only-narrow{display:none}
@container tmpage (max-width:1099px){.tm-detail.tm-inline{display:none}.tm-only-mid{display:inline-flex}}
@container tmpage (min-width:1100px){.tm-only-mid{display:none}}
@container tmpage (max-width:760px){
 .tm-lane-grid{grid-template-columns:22px minmax(90px,1fr) minmax(90px,1fr) 82px}
 .tm-col-task,.tm-col-ack,.tm-col-fold,.tm-col-lease{display:none!important}
 .tm-bar{width:40px}
 .tm-situation{padding:0 8px;gap:0}.tm-goal-title,.tm-goal-tag,.tm-situation .tm-sep{display:none}.tm-goal{margin-right:2px}
 .tm-metric{padding:0 5px;gap:3px}.tm-metric-long{display:none}
 .tm-fresh-text,.tm-mock-label,.tm-gate{display:none}.tm-capped{display:none}
 .tm-center{padding:10px 10px 64px}
 .tm-pipe{flex-wrap:wrap}.tm-stage{flex:1 1 30%;border-radius:0!important;margin:-1px 0 0 -1px}
 .tm-bottom{display:flex;position:absolute;left:0;right:0;bottom:0;height:52px;align-items:center;justify-content:space-between;padding:0 12px;border-top:1px solid var(--tm-line2);background:var(--tm-bg1);z-index:5}
 .tm-only-narrow{display:inline-flex}
 .tm-need{grid-template-columns:18px minmax(0,1fr) auto auto;gap:8px}.tm-need-owner{display:none}
}

/* palette (portal, outside .tm-page) */
.tm-modal-scrim{position:fixed;inset:0;z-index:1000;background:var(--dsw-alias-bg-mask-2,rgba(0,0,0,.35));display:flex;align-items:flex-start;justify-content:center;padding-top:10vh}
.tm-modal{width:min(560px,calc(100vw - 24px));max-height:80vh;display:flex;flex-direction:column;border-radius:14px;background:var(--dsw-alias-bg-layer-2,var(--tm-bg1));box-shadow:var(--dsw-elevation-prominent);border:1px solid var(--tm-line2);overflow:hidden}
.tm-modal-head{display:flex;align-items:center;gap:10px;padding:14px 18px 10px}
.tm-modal-head h2{font-size:15px;margin:0;font-weight:600;flex:1}
.tm-modal-body{padding:4px 18px 14px;overflow:auto;display:flex;flex-direction:column;gap:12px}
.tm-cmd{font-family:var(--tm-mono);font-size:12.5px;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--tm-fg) 5%,transparent);overflow-wrap:anywhere}
.tm-field{display:flex;flex-direction:column;gap:5px;font-size:12.5px}
.tm-field>span{color:var(--tm-fg2)}
.tm-field>span em{color:var(--tm-bad);font-style:normal;margin-left:3px}
.tm-input{font:inherit;font-size:13px;color:var(--tm-fg);background:var(--tm-bg1);border:1px solid var(--tm-line2);border-radius:8px;padding:7px 9px;outline:none;width:100%}
.tm-input:focus{border-color:var(--tm-accent)}
textarea.tm-input{min-height:64px;resize:vertical}
.tm-radio{display:flex;gap:8px;align-items:flex-start;padding:7px 9px;border:1px solid var(--tm-line2);border-radius:8px;cursor:pointer;font-size:12.5px}
.tm-radio[data-checked=true]{border-color:var(--tm-accent);background:color-mix(in srgb,var(--tm-accent) 6%,transparent)}
.tm-warnbox{font-size:12px;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--tm-warn) 10%,transparent);color:var(--tm-fg)}
.tm-modal-foot{display:flex;align-items:center;gap:8px;padding:12px 18px;border-top:1px solid var(--tm-line2)}
.tm-modal-foot .tm-spacer{flex:1}
.tm-receipt{display:grid;grid-template-columns:96px 1fr;gap:4px 10px;font-size:12.5px;padding:10px 12px;border-radius:8px;border:1px solid var(--tm-line2)}
.tm-receipt[data-status=conflict]{border-color:var(--tm-warn)}.tm-receipt[data-status=unknown]{border-color:var(--tm-unknown)}

/* roster (sidebar.body.wrapper) */
.tm-roster-wrap{display:flex;flex-direction:column;min-height:0;flex:1}
.tm-seg{display:flex;gap:2px;margin:4px 12px 6px 8px;padding:2px;border-radius:8px;background:color-mix(in srgb,var(--tm-fg) 5%,transparent)}
.tm-seg button{flex:1;height:26px;border:0;border-radius:6px;background:none;font-size:12.5px;color:var(--tm-fg3);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px}
.tm-seg button[aria-selected=true]{background:var(--tm-bg1);color:var(--tm-fg);box-shadow:var(--dsw-elevation-panel,0 1px 2px rgba(0,0,0,.08))}
.tm-roster{flex:1;min-height:0;overflow:auto;padding:0 10px 10px 4px}
.tm-roster-top{display:flex;align-items:center;gap:6px;padding:4px 6px 8px;font-size:12px;color:var(--tm-fg3);flex-wrap:wrap}
.tm-rgroup{display:flex;align-items:center;gap:6px;width:100%;height:26px;padding:0 6px;border:0;background:none;border-radius:6px;cursor:pointer;font-size:12px;color:var(--tm-fg2);text-align:left}
.tm-rgroup:hover{background:var(--tm-hover)}
.tm-rgroup .tm-caret{font-size:9px;width:10px;color:var(--tm-fg3);transition:transform .15s}
.tm-rgroup[aria-expanded=false] .tm-caret{transform:rotate(-90deg)}
.tm-rgroup .tm-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.tm-rrow{position:relative;display:flex;align-items:center;gap:7px;width:100%;height:28px;padding:0 6px 0 18px;border:0;background:none;border-radius:6px;cursor:pointer;font-size:13px;text-align:left;color:var(--tm-fg)}
.tm-rrow:hover{background:var(--tm-hover)}
.tm-rrow[aria-current=true]{background:var(--dsw-specific-sidebar-nav-item-active-accent,var(--tm-active))}
.tm-rrow[aria-current=true]:before{content:"";position:absolute;left:4px;top:6px;bottom:6px;width:3px;border-radius:2px;background:var(--tm-accent)}
.tm-rrow[data-sev=frozen],.tm-rrow[data-sev=retired]{opacity:.55}
.tm-rrow .tm-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tm-rrow .num{color:var(--tm-fg3);font-size:11px}
.tm-rrow .num[data-level=warn]{color:var(--tm-warn)}.tm-rrow .num[data-level=bad]{color:var(--tm-bad)}
.tm-hidden{display:none!important}

/* member frame (main.conversation.frame) */
.tm-frame{display:flex;flex-direction:column;height:100%;min-height:0;position:relative}
.tm-frame-body{flex:1;min-height:0;display:flex;flex-direction:column;position:relative}
.tm-frame-body>[data-slot]{display:contents}
.tm-frame[data-readonly=true] [data-slot="conversation.composer.bar"]{display:none!important}
.tm-strip{flex:none;display:flex;align-items:center;gap:8px;height:40px;padding:0 10px 0 12px;border-bottom:1px solid var(--tm-line2);background:var(--tm-bg1);white-space:nowrap;overflow:hidden;font-size:12.5px}
.tm-strip .tm-sep{margin:0 2px}
.tm-strip-who{display:flex;align-items:center;gap:6px;min-width:0}
.tm-strip-who strong{font-weight:600}
.tm-strip-task{color:var(--tm-fg2);overflow:hidden;text-overflow:ellipsis;min-width:0}
.tm-strip .tm-spacer{flex:1}
.tm-pill{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:11px;font-size:11.5px;background:color-mix(in srgb,var(--tm-fg) 6%,transparent);color:var(--tm-fg2)}
.tm-readonly-bar{flex:none;display:flex;align-items:center;gap:10px;margin:0 auto 14px;width:min(760px,calc(100% - 32px));padding:10px 12px 10px 14px;border-radius:14px;border:1px dashed var(--tm-line2);background:var(--tm-bg1);font-size:12.5px;color:var(--tm-fg2)}
.tm-readonly-bar .tm-spacer{flex:1}
.tm-frame-note{flex:none;margin:8px 12px 0;font-size:11.5px;color:var(--tm-fg3)}
@container tmframe (max-width:640px){.tm-strip-task,.tm-strip-hide{display:none}}
.tm-frame{container-type:inline-size;container-name:tmframe}
/* L2 disclosures (09 §5.5 展开态) */
.tm-disclose>summary{cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:4px;border-radius:4px}
.tm-disclose>summary::-webkit-details-marker{display:none}
.tm-disclose>summary:focus-visible{outline:2px solid var(--tm-focus,currentColor);outline-offset:1px}
.tm-disclose[open]>summary .tm-fg3{color:var(--tm-fg2)}
.tm-disclose-body{margin-top:4px;padding-left:10px;border-left:2px solid var(--tm-line2);display:flex;flex-direction:column;gap:2px}
/* v3 §3.4 on-demand detail: the v1 read states sit at the bottom of the right pane, closed by default. */
.tm-runtime{flex:none;padding:8px 16px 12px;border-top:1px solid var(--tm-line2);background:var(--tm-bg1)}
.tm-runtime>summary{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--tm-fg3)}
.tm-runtime>.tm-disclose-body{gap:6px;margin-top:6px}
.tm-l2{display:flex;flex-direction:column;gap:8px}
.tm-kv.tm-kv-sub{grid-template-columns:64px minmax(0,1fr);gap:3px 8px;font-size:12px}
/* right sidebar tab (sidebar.right.pane.tab) */
.tm-pane{height:100%;display:flex;flex-direction:column;min-height:0;background:var(--tm-bg1)}
.tm-pane .tm-detail.tm-pane-detail{width:auto;flex:1;border-left:0;background:transparent}
.tm-pane-note{padding:8px 16px 0}
/* session-header mini strip (conversation.session.header.actions) */
.tm-mini{display:inline-flex;align-items:center;gap:6px;height:24px;max-width:100%;padding:0 8px;margin-left:8px;border-radius:12px;border:1px solid var(--tm-line2);background:transparent;color:var(--tm-fg2);font:inherit;font-size:12px;white-space:nowrap;overflow:hidden;cursor:pointer}
.tm-mini:hover{background:color-mix(in srgb,var(--tm-fg) 5%,transparent)}
.tm-mini:focus-visible{outline:2px solid var(--tm-focus,currentColor);outline-offset:1px}
.tm-mini-name{color:var(--tm-fg);font-weight:500;overflow:hidden;text-overflow:ellipsis}
.tm-mini-sep{width:1px;height:12px;background:var(--tm-line2)}
.tm-mini [data-sev=warn]{color:var(--tm-warn)}.tm-mini [data-sev=unknown]{color:var(--tm-unknown)}
/* v3 pages (16 §3): now / members / records + the inspector rail */
.tm-v3{display:flex;flex-direction:column;min-height:0;height:100%}
.tm-v3-top{flex:none;height:56px;display:flex;align-items:center;gap:12px;padding:0 32px;border-bottom:1px solid var(--tm-line2)}
.tm-v3-team{margin:0;font-size:16px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tm-v3-tabs{display:flex;gap:4px;margin-left:24px}
.tm-v3-tab{padding:6px 14px;border-radius:8px;border:0;background:none;color:var(--tm-fg3);cursor:pointer}
.tm-v3-tab.on{background:var(--tm-bg2);color:var(--tm-fg)}
.tm-v3-badge{font-size:12px;padding:2px 9px;border-radius:20px;border:1px solid var(--tm-line2);color:var(--tm-fg2);white-space:nowrap}
.tm-v3-details{border:1px solid var(--tm-line2);background:none;border-radius:8px;padding:4px 10px;font-size:12px;color:var(--tm-fg2);cursor:pointer}
.tm-v3-details.on{background:var(--tm-bg2);color:var(--tm-fg)}
.tm-v3-body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr);overflow:auto}
.tm-v3-body.has-ins{grid-template-columns:minmax(0,1fr) 380px}
.tm-v3-main{min-width:0;padding:40px 32px}
.tm-v3-col{max-width:860px;margin:0 auto;min-width:0}
.tm-v3-status{margin:0 0 6px;font-size:22px;font-weight:600;letter-spacing:-.01em;display:flex;align-items:baseline;gap:12px;overflow-wrap:anywhere}
.tm-v3-status .tm-v3-dot{flex:none;width:10px;height:10px;border-radius:50%;background:var(--sev,var(--tm-fg2))}
.tm-v3-sub{margin:0 0 34px;color:var(--tm-fg3);overflow-wrap:anywhere}
.tm-v3-sec{margin-bottom:36px}
.tm-v3-sec h2{margin:0 0 12px;font-size:13px;font-weight:600;color:var(--tm-fg3);letter-spacing:.02em}
.tm-v3-empty{border:1px dashed var(--tm-line2);border-radius:12px;padding:22px 24px;display:flex;align-items:flex-start;gap:14px;color:var(--tm-fg2);min-width:0}
.tm-v3-empty .tm-fg3{overflow-wrap:anywhere}
.tm-v3-ok{flex:none;width:28px;height:28px;border-radius:50%;border:2px solid var(--tm-fg3);display:inline-flex;align-items:center;justify-content:center;color:var(--tm-fg2);font-size:14px}
.tm-v3-ask{display:flex;align-items:center;gap:18px;border:1px solid var(--tm-line2);border-left:3px solid var(--sev,var(--tm-warn));border-radius:12px;padding:16px 20px;background:var(--tm-bg1);margin-bottom:10px;min-width:0}
.tm-v3-ask-q{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.tm-v3-ask-q b{font-weight:600;overflow-wrap:anywhere}
.tm-v3-ask-q span{font-size:13px;color:var(--tm-fg3);overflow-wrap:anywhere}
.tm-v3-prog{height:8px;border-radius:6px;background:var(--tm-bg2);overflow:hidden;margin:6px 0 8px}
.tm-v3-prog i{display:block;height:100%;background:var(--tm-done);border-radius:6px}
.tm-v3-plab{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--tm-fg3);font-size:13px}
.tm-v3-link{border:0;background:none;color:var(--tm-fg3);padding:2px 0}
.tm-v3-stages{display:flex;flex-wrap:wrap;gap:16px;margin-top:8px;color:var(--tm-fg3);font-size:13px}
.tm-v3-stage b{margin-left:6px;color:var(--tm-fg2)}
.tm-v3-sum{display:flex;align-items:center;gap:12px;width:100%;text-align:left;border:1px solid var(--tm-line2);border-radius:12px;padding:14px 20px;background:var(--tm-bg1);cursor:pointer;min-width:0}
.tm-v3-sum>span:nth-child(2){min-width:0;overflow-wrap:anywhere}
.tm-v3-chev{flex:none;color:var(--tm-fg3)}
.tm-v3-table{width:100%;border-collapse:collapse;margin-top:8px;table-layout:fixed}
.tm-v3-table th,.tm-v3-table td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--tm-line2);vertical-align:top;min-width:0}
.tm-v3-table th{font-size:12px;font-weight:500;color:var(--tm-fg3)}
.tm-v3-table tbody tr{cursor:pointer}
.tm-v3-table tbody tr:hover{background:var(--tm-bg2)}
.tm-v3-table tr[data-selected=true] td{background:var(--tm-bg2)}
.tm-v3-name{min-width:110px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tm-v3-what{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.tm-v3-st{display:inline-flex;align-items:center;gap:7px;white-space:nowrap}
.tm-v3-st:before{content:"";width:8px;height:8px;border-radius:50%;background:var(--sev,var(--tm-idle));flex:none}
.tm-v3-group td{font-size:12px;color:var(--tm-fg3);background:var(--tm-bg1);font-weight:500}
.tm-v3-chips{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:18px}
.tm-v3-chip{border:1px solid var(--tm-line2);border-radius:20px;padding:4px 14px;font-size:13px;color:var(--tm-fg2);background:none;cursor:pointer}
.tm-v3-chip.on{background:var(--tm-bg2);color:var(--tm-fg);border-color:var(--tm-fg3)}
.tm-v3-select{border:1px solid var(--tm-line2);border-radius:20px;padding:4px 10px;font-size:13px;background:transparent;color:var(--tm-fg2);max-width:180px}
.tm-v3-day{margin-top:8px}
.tm-v3-daylabel{font-size:12px;color:var(--tm-fg3);margin:16px 0 4px}
.tm-v3-tl{list-style:none;margin:0;padding:0}
.tm-v3-tl li{display:grid;grid-template-columns:64px 18px minmax(0,1fr);gap:10px;align-items:baseline;padding:10px 0;border-bottom:1px solid var(--tm-line2);cursor:pointer;min-width:0}
.tm-v3-tl li:hover{background:var(--tm-bg2)}
.tm-v3-tl .tm-v3-dot{width:8px;height:8px;border-radius:50%;background:var(--sev,var(--tm-idle));margin-top:6px}
.tm-v3-tl li>div{min-width:0;overflow-wrap:anywhere}
.tm-v3-time{font-size:12px;color:var(--tm-fg3)}
.tm-v3-who{font-weight:600}
.tm-v3-tags{font-size:12px;color:var(--tm-fg3)}
.tm-v3-more{margin-top:14px}
.tm-v3-ins{border-left:1px solid var(--tm-line2);background:var(--tm-bg1);padding:22px 24px;overflow:auto;display:flex;flex-direction:column;gap:18px;min-width:0}
.tm-v3-ins-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.tm-v3-ins-head h3{margin:0;font-size:17px}
.tm-v3-ins-note{border:1px solid var(--tm-line2);border-radius:10px;padding:12px 14px;font-size:13px;overflow-wrap:anywhere;min-width:0}
.tm-v3-ins-note[data-sev]{border-left:3px solid var(--sev,var(--tm-line2))}
.tm-v3-raw{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;max-height:240px;overflow:auto;margin:8px 0 0}
.tm-v3-broken{flex:none;display:flex;align-items:center;gap:10px;margin:12px 32px 0;padding:10px 14px;border-radius:10px;border:1px solid var(--tm-line2);border-left:3px solid var(--tm-unknown);background:var(--tm-bg1);font-size:13px}
.tm-v3-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);padding:8px 16px;border-radius:20px;background:var(--tm-bg2);border:1px solid var(--tm-line2);font-size:13px;z-index:40}
/* 16 §4 narrow: the inspector is a full-screen sheet whose top row is «← 返回»; Esc closes it the same way. */
.tm-v3-sheet{position:fixed;inset:0;z-index:70;display:flex;flex-direction:column;background:var(--tm-bg1);min-width:0;overflow:hidden}
.tm-v3-sheet-top{flex:none;display:flex;align-items:center;gap:10px;height:52px;padding:0 12px;border-bottom:1px solid var(--tm-line2)}
.tm-v3-back{border:0;background:none;color:var(--tm-fg2);font-size:14px;padding:8px 6px;cursor:pointer;white-space:nowrap}
.tm-v3-back:hover{color:var(--tm-fg)}
.tm-v3-sheet-body{flex:1;min-height:0;overflow:auto;padding:16px}
.tm-v3-sheet-body .tm-v3-ins{border-left:0;background:none;padding:0;overflow:visible}
@media (max-width:760px){
  .tm-v3-top{padding:0 16px;height:52px}
  .tm-v3-tabs{margin-left:auto}
  .tm-v3-tab{padding:6px 10px}
  .tm-v3-main{padding:24px 16px}
  .tm-v3-body.has-ins{grid-template-columns:minmax(0,1fr)}
  .tm-v3-status{font-size:18px}
  .tm-v3-ask{flex-wrap:wrap;padding:14px 16px;gap:10px}
  .tm-v3-ask-q{flex-basis:100%}
  .tm-v3-ask .tm-btn{margin-left:auto}
  .tm-v3-table{display:table}
  .tm-v3-table th:first-child{width:110px!important}
}
`;

//#endregion
//#region src/ui/atoms.mjs
// Split of the former src/ui.mjs (M6 WP-3): atoms. Pure move, no behaviour change.
/* global React, ReactDOM */
const { createElement: h, Fragment, useState, useEffect, useRef, useSyncExternalStore, useMemo, useCallback } = React;

/**
 * What each command receipt status means to an operator, and how severe it is. `compacted` is the evidence-governance
 * answer: the operation did commit once, its result body was collected afterwards, replaying the same operationId is a
 * typed refusal (RECEIPT_COMPACTED), and re-running the business action under a new id is exactly what must not happen.
 */
const RECEIPT_STATUS_TEXT = Object.freeze({
  accepted: '已受理 · 等待投影对账（未在本地改写任何状态）',
  conflict: '状态已变化 · 已重新读取投影，请复核后重试',
  rejected: '被服务端拒绝',
  unknown: '结果未知 · 等待投影对账',
  compacted: '已压缩 · 该操作此前已提交，结果正文已被证据治理收集；原样重放会以 RECEIPT_COMPACTED 拒绝，请不要换新 operationId 重跑同一业务操作',
});
function receiptSeverity(status) {
  if (status === 'conflict' || status === 'compacted') return 'warn';
  if (status === 'unknown') return 'unknown';
  if (status === 'rejected') return 'bad';
  return 'ok';
}

/** Wiring set once by the plugin (single Team instance per client). */
const TEAM = { client: null, ui: null, gateway: null, nav: null, source: null, control: null };

const clockStore = (() => {
  let now = Date.now(), timer = null; const ls = new Set();
  return { get: () => now, sub(l) { ls.add(l); if (!timer) timer = setInterval(() => { now = Date.now(); ls.forEach(f => f()); }, 1000);
    return () => { ls.delete(l); if (!ls.size) { clearInterval(timer); timer = null; } }; } };
})();
const useNow = () => useSyncExternalStore(clockStore.sub, clockStore.get);
const useClient = () => useSyncExternalStore(TEAM.client.subscribe, TEAM.client.getSnapshot);
const useUi = () => useSyncExternalStore(TEAM.ui.subscribe, TEAM.ui.getSnapshot);
const cx = (...names) => names.filter(Boolean).join(' ');
const memberById = (data, id) => data?.members.find(m => m.id === id) ?? null;
const isEditable = el => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
// Identity: the viewer is the authoritative principal the source reads as (member:*), never a UI constant.
const viewerOf = () => { const st = TEAM.client?.getSnapshot();
  return principalId(st?.viewer, st?.teamId ?? st?.data?.team?.teamId); };
const dataOf = () => TEAM.client?.getSnapshot().data ?? null;
const kname = id => id == null ? '—' : id === viewerOf() ? `${memberName(dataOf(), id)}（你）` : memberName(dataOf(), id);
// Known/unknown comes from the projection itself (goal.status, member.contextStatus, approvalsStatus): no hard-coded gaps.
const UNKNOWN = '未知';
const NO_DATA = UNKNOWN;
const WHY = { context: '没有已提交的 context 计量（不显示为 0%）', counter: '没有已提交的计数（不补 0）', goal: '投影未给出原生 goal（goal.status = unknown）',
  gate: '没有已提交的完成门禁检查', approvals: '投影未给出 scope approval 读视图（approvalsStatus = unknown）' };
const num = v => typeof v === 'number' && Number.isFinite(v);
/** Optional committed counter: value or 未知 (never 0 for "absent"). */
const counter = (v, fmt = x => String(x)) => num(v) ? fmt(v) : h('span', { className: 'tm-cap', title: WHY.counter }, UNKNOWN);

// ── atoms ──────────────────────────────────────────────
function Glyph({ sev, title }) {
  const s = SEVERITY[sev] ?? SEVERITY.ok;
  return h('span', { className: 'tm-glyph', 'data-sev': sev, title: title ?? s.label, role: 'img', 'aria-label': title ?? s.label },
    sev === 'unknown' ? h('span', null, '?') : s.glyph);
}
/** context.pct is already relative to the 75% hard limit (100 = full bar); it is shown as-is, never re-divided. */
const pctText = p => `${Math.round(p)}%`;
function CtxBar({ context, member, big }) {
  if (member?.observed === 'retired') return h('span', { className: 'tm-cap' }, '—');
  if (!contextKnown({ context, contextStatus: member?.contextStatus })) return h('span', { className: 'tm-ctx tm-cap', 'data-ctx': 'unknown',
    title: `上下文${UNKNOWN}：${member?.contextStatus?.reason ?? WHY.context}`, style: { fontSize: 11.5 } }, UNKNOWN);
  const level = ctxLevel(context.pct);
  const limit = num(context.limitTokens) ? context.limitTokens : null;
  return h('div', { className: cx('tm-ctx', big && 'tm-ctx-big'), 'data-level': level, 'data-ctx': 'known',
    title: `已用 75% 硬上限的 ${pctText(context.pct)} · ${context.inputTokens.toLocaleString()}${limit ? ` / ${Math.round(limit).toLocaleString()}` : ''} tok（窗口 ${context.window.toLocaleString()}）· ${CONTEXT_WARN}% 处为琥珀刻度` },
  h('div', { className: 'tm-bar', 'data-level': level, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': CONTEXT_FULL, 'aria-valuenow': Math.round(context.pct), 'aria-label': '上下文占 75% 上限' },
    h('i', { className: 'tm-bar-fill', style: { width: `${Math.min(100, context.pct)}%` } }), h('i', { className: 'tm-bar-tick' })),
  h('span', { className: 'num tm-ctx-pct' }, pctText(context.pct)),
  context.pct >= CONTEXT_FULL && !big && num(context.hardGateHits) && context.hardGateHits > 0 ? h('span', { className: 'tm-capped', title: `已兜底压缩（75% 硬门命中 ${context.hardGateHits} 次）` }, '兜底') : null);
}
function AckDots({ ack, now }) {
  if (!ack) return h('span', { className: 'tm-cap' }, '—');
  const overdue = ack.worst.deadline != null && ack.worst.deadline <= now && !ack.worst.receipts.accepted;
  const names = ['stored', 'visible', 'accepted'];
  return h('div', { className: 'tm-ack', title: `最差一条 ${ack.worst.id}：${names.map((n, i) => `${n} ${ack.level > i ? '✓' : '✗'}`).join(' · ')}` },
    h('span', { className: 'tm-dots', 'data-sev': overdue ? 'bad' : undefined, 'aria-label': `确认级别 ${ack.level}/3` },
      names.map((n, i) => h('i', { key: n, 'data-on': String(ack.level > i) }))),
    ack.unaccepted ? h('span', { className: cx('num', overdue && 'tm-lease-bad') }, ack.unaccepted) : null);
}
function Lease({ attempt, now }) {
  const l = attempt?.lease;
  if (!l) return h('span', { className: 'tm-cap' }, '—');
  if (l.state !== 'active') return h('span', { className: 'num tm-lease-bad', title: `lease ${l.state} · fence ${l.fence}` }, 'L✗');
  const left = l.expiresAt - now;
  if (left <= 0) return h('span', { className: 'num tm-lease-bad', title: '到期，等待对账（不代表进程已停）' }, 'L? 0s');
  return h('span', { className: 'num', title: `active · fence ${l.fence} · 到期 ${utc(l.expiresAt)}` }, `L✓ ${relTime(left)}`);
}
function Fold({ context }) {
  if (!context) return h('span', { className: 'tm-cap' }, '—');
  if (!context.fold) return h('span', { className: 'tm-cap', title: `折叠：${WHY.counter}` }, '?');
  if (!context.fold.enabled) return h('span', { className: 'num tm-fold-off', title: '第二层折叠未启用' }, 'off');
  return h('span', { className: 'num', title: `第二层折叠 ${context.fold.count} 次` }, `F${context.fold.count}`);
}
function WaitCell({ wait, now, onJump }) {
  if (!wait) return h('span', { className: 'tm-cap' }, '—');
  const sev = hasDeadline(wait.deadline) ? deadlineSeverity(wait.openedAt, wait.deadline, now) : null;
  const target = wait.memberRef
    ? h(Fragment, null, h('button', { className: 'tm-link', onClick: e => { e.stopPropagation(); onJump?.(wait.memberRef); }, title: `跳到 ${wait.memberRef}` }, memberName(dataOf(), wait.memberRef)),
      h('span', { className: 'tm-fg3' }, ' msg'))
    : h('span', { title: `${wait.kind} · ${wait.ref}` }, wait.label);
  return h('div', { className: 'tm-wait', 'data-sev': sev, title: `${wait.kind} · deadline ${hasDeadline(wait.deadline) ? utc(wait.deadline) : '无截止时间'}` },
    h('span', { className: 'tm-fg3' }, '⇢'), target, h('span', { className: 'num tm-wait-left' }, hasDeadline(wait.deadline) ? `(${relTime(wait.deadline - now)})` : '(无截止时间)'));
}
function CmdButton({ cmd, label, disabled, title }) {
  const admission = commandAdmission(cmd, dataOf(), viewerOf(), TEAM.scope?.generation);
  if (cmd?.hidden || admission) {
    return commandObject(dataOf(), cmd?.target)?.capabilities ? h('div', { className: 'tm-note', role: 'note',
      'data-capability-refusal': cmd?.name }, admission ?? cmd.disabledReason) : null;
  }
  const why = cmd?.disabledReason && (cmd.hardDisabled || unsupportedReason(cmd.name)) ? cmd.disabledReason : null;
  return h('button', { className: 'tm-btn', disabled: !!(disabled || why), title: why ?? title, 'data-unsupported': why ? 'true' : undefined,
    onClick: () => TEAM.ui.openPalette(cmd) }, label);
}

function Field({ field, value, onChange, id }) {
  const label = h('span', null, field.label, field.required ? h('em', null, '*') : null);
  if (field.type === 'radio') return h('div', { className: 'tm-field', role: 'radiogroup', 'aria-label': field.label }, label,
    field.options.map(([v, text]) => h('label', { key: v, className: 'tm-radio', 'data-checked': String(value === v) },
      h('input', { type: 'radio', name: id, value: v, checked: value === v, onChange: () => onChange(v) }), h('span', null, text))));
  if (field.type === 'choice') return h('label', { className: 'tm-field' }, label,
    h('select', { className: 'tm-input', value, 'aria-label': field.label, onChange: e => onChange(e.target.value) }, field.options.map(([v, text]) => h('option', { key: v, value: v }, text))));
  if (field.type === 'textarea') return h('label', { className: 'tm-field' }, label, h('textarea', { className: 'tm-input', value, 'aria-label': field.label, onChange: e => onChange(e.target.value) }));
  return h('label', { className: 'tm-field' }, label, h('input', { className: 'tm-input', 'aria-label': field.label, type: field.type === 'number' ? 'number' : 'text', value, min: 1,
    onChange: e => onChange(field.type === 'number' ? Number(e.target.value) : e.target.value) }));
}


//#endregion
//#region src/ui/commands.mjs
// Split of the former src/ui.mjs (M6 WP-3): commands. Pure move, no behaviour change.
/* global React, ReactDOM */
const TASK_SEV = { blocked: 'warn', failed: 'bad', cancelled: 'frozen', accepted: 'done' };
function TaskCell({ task, member }) {
  if (member.observed === 'unknown') return h('span', { className: 'tm-sevtext', 'data-sev': 'unknown', title: '外部回执不确定；不沿用上次状态' }, 'observed ? · 待对账');
  if (member.desired !== member.observed && member.observed !== 'retired')
    return h('div', { className: 'tm-task', title: `desired ${member.desired} · observed ${member.observed}` }, h('span', { className: 'tm-sevtext', 'data-sev': 'warn' }, `${member.desired === 'frozen' ? '冻结' : member.desired} 请求中`),
      task ? h('span', { className: 'num tm-fg3' }, task.id.replace('task-', 't-')) : null);
  if (!task) return h('span', { className: 'tm-cap' }, member.role === 'root' || member.role === 'coordinator' ? '监督（无写锁）' : '—');
  const n = member.attempt?.n;
  return h('div', { className: 'tm-task', title: `${task.id} · ${task.title}` },
    h('span', { className: 'num' }, task.id.replace('task-', 't-')),
    h('span', { className: 'tm-task-state', 'data-sev': TASK_SEV[task.state] }, task.state),
    n > 1 ? h('span', { className: 'num tm-fg3' }, `att#${n}`) : null);
}

// ── commands (09 §3.3: palette only, never one-click) ──────────────────
// Shapes follow the server contract in projection.mjs COMMANDS; anything else is shown disabled with the reason.
const SUMMARY_MAX = 2000;
/**
 * Administrative writes (retire, escalation, mailbox cancel/rebind/adjudication, contract approval, delivery
 * verdict) are operator/root only on the server. The UI never decides authority: it disables the control with
 * the reason so a viewer that is not the operator is not misled (09 §3.3). The operator works through the root
 * principal (projection.mjs), so "operator" or the root member both count.
 */
const ADMIN_ONLY = '只有 operator / root 能执行这个命令（由服务端按身份判定）';
/**
 * The two unknown verdicts are operator-only in the strict sense: the server admits the literal 'operator' principal and
 * refuses every member, root included (core/mailbox.mjs and delivery/index.mjs pass operatorOnly). That is the
 * design, not a bug: an unknown external effect is adjudicated by the operator, and root is a team role. A browser can
 * only authenticate as a member, so the panel must never offer the command as if it were yours -- it shows the row and
 * says who owns the verdict. ADJUDICATOR mirrors the server rule in one place instead of being re-derived per call.
 */
const ADJUDICATOR = 'operator';
const ADJUDICATION_ONLY = '未知效果的裁决只属于 operator：服务端按身份拒绝 root 与所有成员（ROLE_DENIED）。这里只展示对象与证据，' +
  '裁决请由 operator 侧提交；不要通过放宽授权绕过它。';
/**
 * A prepared/authorized completion token freezes the control plane: the server refuses every write outside
 * completion:/inconsistency: with COMPLETION_FROZEN (core/index.mjs, operator-command.mjs, tools.mjs). The UI has to
 * say that before the click instead of letting the operator fill a form and be refused, so every administrative write
 * asks this first. It is a committed projection fact (goal.completionToken), not a guess.
 */
const FROZEN_TOKEN_STATES = ['prepared', 'authorized', 'unknown'];
function frozenReason(data) {
  const token = (data ?? dataOf())?.goal?.completionToken;
  return FROZEN_TOKEN_STATES.includes(token)
    ? `完成 token 处于 ${token} 状态：控制面已冻结（COMPLETION_FROZEN），除 completion/inconsistency 外的写命令都会被拒绝。先由原生侧完成或撤销该 token。`
    : null;
}
/** Server refusal codes, in the words the operator needs; the raw code stays visible beside it. */
const ERROR_TEXT = {
  COMPLETION_FROZEN: '控制面被冻结：已提交的完成 token 未结束，写命令一律拒绝',
  ROLE_DENIED: '身份不允许这个命令：它只对 operator / root 开放',
  UNSUPPORTED_COMMAND: '服务端没有这个命令',
  CAS_CONFLICT: '对象已被改动（revision 不符）：刷新投影后复核再提交',
  INVALID_ADJUDICATION: '裁决参数不完整，或对象已不是 unknown 状态',
  MISSING_EVIDENCE: '裁决的证据引用不存在',
  DELIVERIES_NOT_VERIFIED: '还有未验收的交付，不能整合',
  REVIEWS_INCOMPLETE: '评审线程没有记录每个交付的答复',
  NOT_DRAFT: '任务已不是 draft，不能再次批合同',
};
/** Split a server message into its leading code and the explanation the panel shows first. */
function explainError(message) {
  const text = String(message ?? '');
  const code = text.match(/[A-Z][A-Z0-9_]{2,}/)?.[0] ?? null;
  return { code, explanation: code ? ERROR_TEXT[code] ?? null : null, raw: text };
}
function canAdminister(data, viewer = viewerOf()) {
  return !viewerReadOnly(data ?? dataOf(), viewer);
}
/**
 * v3 §4 "viewer 只读": an authenticated viewer that is a team member but neither the operator principal nor root.
 * An absent/unknown principal is not described as read-only (nothing can be asserted about its permissions).
 */
function readOnlyViewer(data, viewer = viewerOf()) {
  if (!data || !viewer) return false;
  const id = principalId(viewer, data.team?.teamId);
  const known = data.viewerRole ?? data.members?.find(m => m.id === id)?.role;
  return known ? viewerReadOnly(data, viewer) : false;
}
/**
 * The P5 v1 read states (capacity / role guard / batch manifest) are published only by a v1 projection. Off teams
 * carry none of them, which is what keeps the off surface's rendering exactly HEAD's until the M6 page rewrite.
 */
const v1ReadStates = data => !!(capacityView(data) || roleGuardView(data) || inputsView(data));
/** Why `name` cannot be submitted as this viewer, and whether that must hard-disable the button (not just a note). */
function gateOf(name, data, viewer) {
  const unsupported = unsupportedReason(name);
  if (unsupported) return { reason: unsupported, hard: true };
  // Permission first, then the freeze: a viewer who could never run the command must not be told the reason is a
  // completion token it cannot see (read-model rows are root's).
  if (!canAdminister(data, viewer)) return { reason: ADMIN_ONLY, hard: true };
  const frozen = frozenReason(data);
  return frozen ? { reason: frozen, hard: true } : { reason: null, hard: false };
}
/** A verdict must be chosen explicitly: no default, the operator records what the evidence shows. */
const DECISION_OPTIONS = [['effective', 'effective（外部效果确实生效）'], ['not-effective', 'not-effective（外部效果未生效）'],
  ['abandoned', 'abandoned（放弃该对象，保留 quarantine）']];
const decisionField = () => ({ key: 'decision', label: '裁决结论', type: 'radio', required: true, value: '', options: DECISION_OPTIONS });
const evidenceField = () => ({ key: 'evidenceRef', label: '证据引用（evidenceRef）', type: 'text', required: true, value: '',
  validate: v => /^[a-z][a-z-]*:\S+$/i.test(v) ? null : '需要 <kind>:<id> 形式的已存在实体（如 artifact:…）' });
/** A retire is one intent, not one per click: the id is derived from member + generation so a repeat is a replay. */
function retireOperationId(m) {
  // The server publishes operationId ^v1:operation:[A-Za-z0-9._-]{8,128}$, so a projected id (member:worker) is
  // flattened rather than pasted: one stable, publishable id per member and generation.
  return 'v1:operation:ui-retire-' + String(m.id).replace(/[^A-Za-z0-9._-]/g, '-') + '-g' + (m.generation ?? 1);
}
/** While the retirement is in flight the button is disabled and reports how long it has waited (09 §5.5). */
function retireAction(m, now) {
  if (!(m.desired === 'retired' && m.observed !== 'retired')) return { disabled: false, label: '退役…', waited: null };
  const since = m.pendingLifecycle?.since ?? null;
  const waited = typeof since === 'number' && since > 0 ? Math.max(0, now - since) : null;
  return { disabled: true, waited, label: waited === null ? '退役请求中 · 等待原生确认' : '退役请求中 · 已等待 ' + relTime(waited) };
}
/** Each palette is a new observation; keep its id for retry, but never collide after reload or in another client. */
function resourceOperationId() {
  return 'v1:operation:ui-publish-' + globalThis.crypto.randomUUID();
}
/**
 * P5: which resource-thread actions this viewer may see. The rule mirrors the server (self only, root may proxy by
 * name, only owner/root closes) and is used to render nothing rather than a disabled button. The server remains the
 * authority: a forged request gets ROLE_DENIED/DENIED, and an unauthorized request nobody handles stays refused.
 */
function resourceActions(data, thread, viewer = viewerOf()) {
  if (!thread || thread.kind !== 'resource') return [];
  viewer = principalId(viewer);
  const member = (data?.members ?? []).find(candidate => candidate.id === viewer) ?? null;
  if (!member || member.desired !== 'active' || !['root', 'worker', 'verifier', 'coordinator'].includes(member.role)) return [];
  const root = member.role === 'root';
  const subscribed = (thread.subscribers ?? []).some(sub => sub.memberId === viewer && sub.state === 'active' &&
    sub.generation === (member.generation ?? 1));
  const actions = [];
  if (thread.status === 'open' && member && member.desired === 'active' && !subscribed) actions.push('subscribeResource');
  if (thread.status === 'open' && subscribed) actions.push('publishResource');
  if (subscribed) actions.push('unsubscribeResource');
  if (thread.status === 'open' && (thread.owner === viewer || root)) actions.push('closeResource');
  return actions;
}

function commandFor(kind, obj, data, viewer = viewerOf()) {
  viewer = principalId(viewer, data?.team?.teamId);
  const cmd = buildCommand(kind, obj, data, viewer);
  if (!cmd) return cmd;
  const cap = commandObject(data, cmd.target)?.capabilities?.[cmd.name];
  const reason = commandAdmission(cmd, data, viewer, TEAM.scope?.generation);
  return { ...cmd, principal: viewer, scopeGeneration: TEAM.scope?.generation ?? null,
    ...(cap?.allowed === true ? { disabledReason: null, hardDisabled: false } : {}),
    ...(reason ? { disabledReason: cap ? reason : cmd.disabledReason ?? reason, hardDisabled: true, hidden: true } : {}) };
}
function buildCommand(kind, obj, data, viewer) {
  const m = obj;
  const off = name => unsupportedReason(name);
  switch (kind) {
    case 'send': return { name: 'mailbox.send', title: `向 ${m.name} 发话`, target: m.id, expectedRevision: m.revision, args: { recipient: m.id },
      disabledReason: frozenReason(data) ?? (viewer ? null : '未取得 viewer 身份，无法以你的身份发话'), hardDisabled: !!frozenReason(data),
      impact: [`收件人 ${m.name}（${m.name !== m.id ? m.id + ' · ' : ''}${ROLE_LABEL[m.role] ?? m.role} · gen ${m.generation}）`, `expectedRevision = 收件人当前 revision ${m.revision}；期间被改动会返回 conflict`,
        '服务端生成 messageId；需要收件人 ackResponsibility 接责', 'deadline 到期未接责 → 升级给其协调者 / root'],
      notes: ['成员会话只读：发话只通过 mailbox，不写入原生会话输入框（09 §7-2）。', `长正文 / 附件的 bodyRef 协议未定：正文作为 summary 发送（≤ ${SUMMARY_MAX} 字）。`],
      fields: [{ key: 'kind', label: '类型', type: 'choice', options: [['action', 'action（需执行）'], ['decision', 'decision（需表态）']], value: 'action' },
        { key: 'expectedOutcome', label: '期望结果', type: 'text', required: true, value: '' },
        { key: 'deadlineMin', label: 'deadline（分钟）', type: 'number', required: true, value: 30 },
        { key: 'summary', label: '正文（summary）', type: 'textarea', required: true, value: '', validate: v => v.length > SUMMARY_MAX ? `正文超过 ${SUMMARY_MAX} 字` : null }] };
    case 'decide': {
      const absent = m.requiredRespondents.filter(r => r.revision !== m.proposalRevision).map(r => memberName(data, r.member));
      const allowed = viewer && (m.owner === viewer || (m.escalationOwner === viewer && ['escalated', 'deciding'].includes(m.state)));
      const frozen = frozenReason(data);
      return { name: 'threads.decide', title: `决策 #${m.id.replace('thr-', '')}`, target: m.id, expectedRevision: m.revision,
        args: { proposalRevision: m.proposalRevision },
        hardDisabled: !!frozen,
        disabledReason: frozen ?? (!viewer ? '未取得 viewer 身份' : allowed ? null : '仅当你是 owner，或线程已升级给你时可用'),
        impact: [`问题：${m.question}`, `采纳提案 rev ${m.proposalRevision}${m.supersededRevisions.length ? `（rev ${m.supersededRevisions.join(',')} 已被取代）` : ''}`,
          `缺席者：${absent.length ? absent.join('、') : '无'}`, `受影响任务：${m.affectedTasks.join('、') || '无'}（决定后需重新授权）`],
        notes: ['服务端合同只接收 proposalRevision + conclusionRef：驳回意见与缺席理由请写进该 artifact，面板不单独提交这些字段。'],
        fields: [{ key: 'conclusionRef', label: '结论 artifact 引用（你可访问的 artifact:*）', type: 'text', required: true, value: '',
          validate: v => /^artifact:\S+$/.test(v) ? null : '需要 artifact:<id> 形式的引用' }] };
    }
    case 'escalate': {
      const g = gateOf('threads.escalate', data, viewer);
      return { name: 'threads.escalate', title: `转交决策 #${m.id.replace('thr-', '')}`, target: m.id, expectedRevision: m.revision, args: {},
        disabledReason: g.reason, hardDisabled: g.hard,
        impact: [`当前 owner ${kname(m.owner)} · 升级责任人 ${kname(m.escalationOwner)}`, `state ${m.state} · expectedRevision = 线程当前 revision ${m.revision}`],
        notes: ['升级只转移责任，不代替决定；已记录的答复与提案版本不变。'],
        fields: g.hard ? [] : [{ key: 'reason', label: '转交理由', type: 'text', required: true, value: '' }] };
    }
    case 'freeze': case 'resume': case 'retire': {
      const name = { freeze: 'organization.requestFreeze', resume: 'organization.requestResume', retire: 'organization.retire' }[kind];
      const open = ackSummary(data?.messages ?? [], m.id);
      // Retire is an administrative write (operator/root); freeze/resume keep their existing wiring and gate. All three
      // are control-plane writes, so a frozen completion token disables them exactly as the server would refuse them.
      const g = kind === 'retire' ? gateOf(name, data, viewer) : { reason: off(name) ?? frozenReason(data), hard: !!off(name) || !!frozenReason(data) };
      return { name, title: `${{ freeze: '冻结', resume: '恢复', retire: '退役' }[kind]} ${m.name}`, target: m.id, expectedRevision: m.revision, args: {},
        ...(kind === 'retire' ? { operationId: retireOperationId(m) } : {}),
        disabledReason: g.reason, hardDisabled: g.hard,
        impact: [`持有 lease：${m.attempt?.lease ? `${m.attempt.id} · fence ${m.attempt.lease.fence} · ${m.attempt.lease.state}` : '无'}`, `未接责消息：${open?.unaccepted ?? 0}`,
          `expectedRevision = 成员当前 revision ${m.revision}`,
          kind === 'retire' ? '退役不可逆；运行容量在原生停止确认后释放' : '状态将显示为“请求中 · 等待原生停止确认”，确认前不显示为 frozen'],
        fields: g.reason ? [] : [{ key: 'reason', label: '理由', type: 'text', required: true, value: '' }] };
    }
    case 'cancelMessage': {
      const g = gateOf('mailbox.cancelMessage', data, viewer);
      return { name: 'mailbox.cancelMessage', title: `取消 ${m.id}`, target: m.id, expectedRevision: m.revision, args: {},
        disabledReason: g.reason, hardDisabled: g.hard,
        impact: [`${kname(m.from)} → ${kname(m.to)} · ${m.kind} · ${m.lifecycle}`, `expectedRevision = 消息当前 revision ${m.revision}`],
        notes: ['取消不撤销已经发生的副作用：已 visible / accepted 的投递轨迹与回执保留。'],
        fields: g.hard ? [] : [{ key: 'reason', label: '取消理由', type: 'text', required: true, value: '' }] };
    }
    case 'rebind': {
      const g = gateOf('mailbox.rebind', data, viewer);
      const choices = (data?.members ?? []).filter(x => x.observed !== 'retired' && x.id !== m.to);
      return { name: 'mailbox.rebind', title: `改投 ${m.id}`, target: m.id, expectedRevision: m.revision, args: {},
        disabledReason: g.reason, hardDisabled: g.hard,
        impact: [`当前收件人 ${kname(m.to)}（gen ${m.generation}）`, `expectedRevision = 消息当前 revision ${m.revision}`,
          '新收件人的 generation 写入投递轨迹；同一 messageId 保留旧轨迹'],
        notes: ['改投只把责任绑定到新的收件人，不重放已经发生的副作用。'],
        fields: g.hard ? [] : [
          { key: 'recipient', label: '新收件人', type: 'choice', required: true, value: choices[0]?.id ?? '',
            options: choices.map(x => [x.id, `${x.name}（${ROLE_LABEL[x.role] ?? x.role} · gen ${x.generation}）`]) },
          evidenceField()] };
    }
    case 'unknown': {
      // The verdict command follows the adjudicated entity id: delivery:* → delivery.reconcile,
      // message:* → mailbox.resolveUnknown (the server rejects any other target). expectedRevision is that row's.
      const id = String(m.id ?? '');
      const name = id.startsWith('delivery:') ? 'delivery.reconcile' : id.startsWith('message:') ? 'mailbox.resolveUnknown' : null;
      // Adjudication is operator-only on the server, so a member viewer -- the only kind a browser can be -- always gets
      // the reason instead of a form. This is checked before the general admin gate so the message names the real rule.
      const adjudication = viewer === ADJUDICATOR ? null : ADJUDICATION_ONLY;
      const g = name ? (adjudication ? { reason: adjudication, hard: true } : gateOf(name, data, viewer))
        : { reason: `投影里的未知对象 ${m.id} 不是 delivery:* / message:* 实体，没有对应的裁决命令`, hard: true };
      return { name, title: `裁决 ${m.id}`, target: m.id, expectedRevision: m.revision, args: {},
        disabledReason: g.reason, hardDisabled: g.hard,
        impact: [m.summary, `对象 ${m.ref}`, `expectedRevision = 该对象当前 revision ${m.revision}`,
          name === 'delivery.reconcile' ? '裁决 delivery 的未知效果；验收仍以独立证书读回为准'
            : name === 'mailbox.resolveUnknown' ? '裁决 message 的未知效果；对象保持 quarantine' : `对象 ${m.id}：投影没有给出可裁决的实体类型`],
        evidence: m.evidence,
        notes: ['unknown 不会自动消失。裁决只记录 operator 的结论：不会变成“已认证验收”，也不会重放外部效果。'],
        fields: g.hard ? [] : [decisionField(), evidenceField()] };
    }
    // P5 §3.2: resource-thread writes. The UI never offers one the server would refuse; the palette is still the
    // only entry, so a click never writes directly.
    case 'subscribeResource': {
      const permitted = resourceActions(data, m, viewer).includes('subscribeResource');
      const frozen = frozenReason(data);
      const allowed = permitted && !frozen;
      return { name: 'threads.subscribe', title: '订阅 ' + (m.resource?.key ?? m.id), target: m.id, expectedRevision: m.revision,
        args: {}, disabledReason: frozen ?? (permitted ? null : '只有活跃成员可以订阅资源线程；越权请求由服务端直接拒绝'),
        hardDisabled: !allowed,
        impact: ['默认只接订阅之后的新事件；要补历史必须显式给出 replayFrom（且不低于保留水位）',
          'expectedRevision = 资源线程当前 revision ' + m.revision, '订阅不是响应义务，也不授予写权限'],
        notes: ['订阅只影响你收到哪些资源事件；root 代订会记录 by。'], fields: [] };
    }
    case 'unsubscribeResource': {
      const permitted = resourceActions(data, m, viewer).includes('unsubscribeResource');
      const frozen = frozenReason(data);
      const allowed = permitted && !frozen;
      return { name: 'threads.unsubscribe', title: '退订 ' + (m.resource?.key ?? m.id), target: m.id, expectedRevision: m.revision,
        args: {}, disabledReason: frozen ?? (permitted ? null : '只有当前订阅者可以退订自己的订阅'), hardDisabled: !allowed,
        impact: ['提交后该 epoch 的 pending 投递标记为 superseded', '已经发送的批次保留为该旧 epoch 的历史',
          'expectedRevision = 资源线程当前 revision ' + m.revision],
        notes: ['退订不是删除：资源线程与已有事件仍由保留策略管理。'],
        fields: allowed ? [{ key: 'reason', label: '退订理由', type: 'text', required: true, value: '' }] : [] };
    }
    case 'publishResource': {
      const permitted = resourceActions(data, m, viewer).includes('publishResource');
      const frozen = frozenReason(data);
      const allowed = permitted && !frozen;
      const operationId = resourceOperationId(m);
      return { name: 'threads.publish', title: '发布资源报告', target: m.id, expectedRevision: m.revision,
        operationId, args: { operationId }, disabledReason: frozen ?? (permitted ? null : '只有当前活跃订阅者可以发布资源事件'),
        hardDisabled: !allowed,
        impact: ['一次发布是一个事件：seq、订阅扇出与 wake 在同一事务提交', '发布是观察/报告，不改任务 owner、合同或写域',
          'expectedRevision = 资源线程当前 revision ' + m.revision],
        notes: ['同一 operationId 重试只分配一次 seq；不同内容复用同一 id 会被拒绝（ID_CONFLICT）。'],
        fields: allowed ? [
          { key: 'eventType', label: '事件类型', type: 'choice', required: true, value: 'change-reported',
            options: [['change-reported', 'change-reported（变更）'], ['conflict-observed', 'conflict-observed（发现冲突）'],
              ['conflict-resolved', 'conflict-resolved（冲突已解决）']] },
          { key: 'summary', label: '摘要', type: 'textarea', required: true, value: '',
            validate: v => v.length > 1024 ? '摘要超过 1024 字' : null },
          { key: 'bodyRef', label: '正文引用（可选）', type: 'text', required: false, value: '' }] : [] };
    }
    case 'closeResource': {
      const permitted = resourceActions(data, m, viewer).includes('closeResource');
      const frozen = frozenReason(data);
      const allowed = permitted && !frozen;
      return { name: 'threads.closeResource', title: '关闭资源线程', target: m.id, expectedRevision: m.revision,
        args: {}, disabledReason: frozen ?? (permitted ? null : '只有资源 owner 或 root 可以关闭资源线程'), hardDisabled: !allowed,
        impact: ['停止新事件与新订阅，保留已有投递直至可见或显式封存', '不套 decision readiness，也没有 deadline 自动升级',
          'expectedRevision = 资源线程当前 revision ' + m.revision],
        notes: ['关闭不是删除；资源身份与历史仍按保留策略处理。'],
        fields: allowed ? [{ key: 'reason', label: '关闭理由', type: 'text', required: true, value: '' }] : [] };
    }
    case 'approval': {
      // scheduler.approveContract is CAS'd on the TASK entity (target), never on the approval row.
      const g = gateOf('scheduler.approveContract', data, viewer);
      const task = (data?.tasks ?? []).find(t => t.id === m.task) ?? null;
      const revision = task && num(task.revision) ? task.revision : null;
      const contractRevision = task && num(task.contractRevision) ? task.contractRevision : null;
      const reason = g.reason ?? (!task ? `投影里没有任务 ${m.task ?? '（审批没有给出 task）'}，无法取 expectedRevision`
        : revision == null ? '投影未给出该任务的 revision' : contractRevision == null ? '投影未给出该任务的合同 revision' : null);
      return { name: 'scheduler.approveContract', title: m.summary, target: m.task ?? m.id, expectedRevision: revision,
        args: contractRevision == null ? {} : { contractRevision }, disabledReason: reason, hardDisabled: reason != null,
        diff: m.diff, impact: [`成员 ${kname(m.member)} · 任务 ${m.task}`, `expectedRevision = 任务当前 revision ${revision ?? UNKNOWN}`,
          `合同 revision ${contractRevision ?? UNKNOWN}：必须与任务当前合同一致，否则服务端返回 conflict`],
        fields: reason ? [] : [{ key: 'contractRevision', label: '合同 revision', type: 'number', required: true, value: contractRevision,
          validate: v => v === contractRevision ? null : `合同 revision 已变化（当前 ${contractRevision}），请刷新投影后重试` }] };
    }
    case 'goal': return { name: 'goal-gate.authorizeCompletion', title: `授权 goal 完成`, target: m.id, expectedRevision: null, args: {},
      disabledReason: off('goal-gate.authorizeCompletion'), impact: [`goal ${m.title}`, 'token 绑定输入与证据 hash'], fields: [] };
    default: return null;
  }
}


//#endregion
//#region src/ui/palette.mjs
// Command form lifecycle is independent from command descriptor construction.
/* global ReactDOM */
/**
 * Action button; commands the server does not support, and commands this viewer may not run (hardDisabled:
 * role or a missing fact), render disabled with the reason as tooltip. Soft reasons stay in the palette.
 */
function CommandPalette() {
  const ui = useUi(), st = useClient(), now = useNow();
  const cmd = ui.palette;
  const admission = commandAdmission(cmd, st.data, st.viewer, TEAM.scope?.generation);
  useEffect(() => { if (cmd && admission) TEAM.ui.closePalette(); }, [cmd, admission]);
  const [form, setForm] = useState({});
  const [phase, setPhase] = useState({ kind: 'edit' });
  const boxRef = useRef(null), restoreRef = useRef(null);
  useEffect(() => {
    if (!cmd) return;
    restoreRef.current = document.activeElement;
    setForm(Object.fromEntries((cmd.fields ?? []).map(f => [f.key, f.value])));
    setPhase({ kind: 'edit' });
    const t = setTimeout(() => (boxRef.current?.querySelector('.tm-modal-body input,.tm-modal-body textarea,.tm-modal-body select') ?? boxRef.current?.querySelector('.tm-modal-foot button'))?.focus(), 30);
    return () => { clearTimeout(t); const r = restoreRef.current; if (r && document.contains(r)) r.focus?.(); };
  }, [cmd]);
  useEffect(() => {
    if (!cmd) return;
    const onEsc = e => { if (e.key === 'Escape') { e.stopPropagation(); TEAM.ui.closePalette(); } };
    document.addEventListener('keydown', onEsc, true);
    return () => document.removeEventListener('keydown', onEsc, true);
  }, [cmd]);
  useEffect(() => { if (phase.kind === 'receipt') boxRef.current?.querySelector('.tm-modal-foot button')?.focus(); }, [phase.kind]);
  if (!cmd || admission) return null;
  const fresh = freshness(st, now);
  const stale = fresh.level === 'stale' || fresh.level === 'error';
  const missing = (cmd.fields ?? []).filter(f => f.required && (form[f.key] === '' || form[f.key] == null || Number.isNaN(form[f.key])));
  const invalid = (cmd.fields ?? []).map(f => form[f.key] != null && form[f.key] !== '' && f.validate?.(form[f.key])).filter(Boolean);
  const blocked = admission || cmd.disabledReason || stale || missing.length > 0 || invalid.length > 0 || phase.kind === 'sending';
  const close = () => TEAM.ui.closePalette();
  const submit = async () => {
    const current = TEAM.client.getSnapshot();
    if (blocked || TEAM.ui.getSnapshot().palette !== cmd ||
        commandAdmission(cmd, current.data, current.viewer, TEAM.scope?.generation)) return;
    const generation = TEAM.scope?.generation;
    setPhase({ kind: 'sending' });
    const receipt = await TEAM.gateway.submit({ ...(cmd.operationId ? { operationId: cmd.operationId } : {}), name: cmd.name, target: cmd.target,
      expectedRevision: cmd.expectedRevision, args: { ...cmd.args, ...form } })
      .catch(error => ({ operationId: '—', status: 'unknown', revision: null, entityId: cmd.target, message: String(error?.message ?? error) }));
    if (generation !== TEAM.scope?.generation || TEAM.ui.getSnapshot().palette !== cmd) return;
    if (receipt.status === 'conflict') TEAM.client.resync('conflict');
    setPhase({ kind: 'receipt', receipt });
  };
  const onKeyDown = e => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') {
      const nodes = [...boxRef.current.querySelectorAll('button,input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(n => !n.disabled);
      if (!nodes.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    e.stopPropagation();
  };
  const receipt = phase.kind === 'receipt' ? phase.receipt : null;
  const errText = explainError;
  const statusText = RECEIPT_STATUS_TEXT;
  const body = h('div', { className: 'tm tm-modal-scrim', onMouseDown: e => { if (e.target === e.currentTarget) close(); } },
    h('div', { className: 'tm-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tm-modal-title', ref: boxRef, onKeyDown },
      h('div', { className: 'tm-modal-head' }, h('h2', { id: 'tm-modal-title' }, cmd.title),
        h('span', { className: 'tm-badge' }, '命令面板'),
        h('button', { className: 'tm-btn tm-btn-ghost', onClick: close, 'aria-label': '关闭' }, '✕')),
      h('div', { className: 'tm-modal-body' },
        h('div', { className: 'tm-cmd' }, `${cmd.name}(${cmd.target}${cmd.expectedRevision != null ? `, expectedRevision=${cmd.expectedRevision}` : ''})`),
        h('dl', { className: 'tm-kv' }, h('dt', null, '影响范围'), h('dd', null, h('ul', { className: 'tm-list', style: { gap: 3 } }, cmd.impact.map((t, i) => h('li', { key: i }, t))))),
        cmd.diff ? h('div', { className: 'tm-cmd' }, cmd.diff.map((d, i) => h('div', { key: i }, d))) : null,
        cmd.evidence ? h('dl', { className: 'tm-kv' }, h('dt', null, '证据'), h('dd', null, h('ul', { className: 'tm-list', style: { gap: 3 } }, cmd.evidence.map((t, i) => h('li', { key: i }, '· ', t))))) : null,
        (cmd.notes ?? []).map((n, i) => h('div', { key: i, className: 'tm-warnbox' }, n)),
        receipt ? null : (cmd.fields ?? []).map(f => h(Field, { key: f.key, id: `tm-f-${f.key}`, field: f, value: form[f.key] ?? '', onChange: v => setForm(s => ({ ...s, [f.key]: v })) })),
        receipt ? h('div', { className: 'tm-receipt', 'data-status': receipt.status, role: 'status' },
          h('span', { className: 'tm-fg3' }, 'operationId'), h('span', { className: 'mono' }, receipt.operationId),
          h('span', { className: 'tm-fg3' }, 'status'), h('span', { className: 'tm-sevtext', 'data-sev': receiptSeverity(receipt.status) }, `${receipt.status} — ${statusText[receipt.status]}`),
          h('span', { className: 'tm-fg3' }, 'revision'), h('span', { className: 'mono' }, receipt.revision ?? '—'),
          receipt.message ? h('span', { className: 'tm-fg3' }, 'message') : null,
          // A refusal is shown as what it means first, with the server's own code kept beside it: COMPLETION_FROZEN says
          // nothing to the operator, "控制面被冻结" does, and the code is still what a bug report needs.
          receipt.message ? h('span', { className: 'mono', title: receipt.message }, errText(receipt.message).explanation ?? receipt.message) : null,
          receipt.message && errText(receipt.message).code ? h('span', { className: 'mono tm-fg3' }, errText(receipt.message).code) : null) : null),
      h('div', { className: 'tm-modal-foot' },
        h('span', { className: 'tm-note' }, cmd.disabledReason ?? (stale ? '投影过期：需先刷新再提交' : missing.length && !receipt ? `还缺：${missing.map(f => f.label).join('、')}` : invalid.length && !receipt ? invalid.join('；') : 'Esc 取消 · 提交前不会改变任何状态')),
        h('span', { className: 'tm-spacer' }),
        stale && !receipt ? h('button', { className: 'tm-btn', onClick: () => TEAM.client.resync('manual') }, '刷新投影') : null,
        h('button', { className: 'tm-btn', onClick: close }, receipt ? '关闭' : '取消'),
        receipt ? null : h('button', { className: 'tm-btn tm-btn-primary', disabled: !!blocked, onClick: submit },
          phase.kind === 'sending' ? '提交中…' : stale ? '需先刷新' : '确认提交'))));
  return ReactDOM.createPortal(body, document.body);
}

//#endregion
//#region src/ui/situation.mjs
// Split of the former src/ui.mjs (M6 WP-3): situation. Pure move, no behaviour change.
// ── situation bar ────────────────────────────────────────
function MockMenu() {
  const [open, setOpen] = useState(false);
  if (!TEAM.control) return null;
  const item = (label, fn) => h('button', { className: 'tm-li', onClick: () => { fn(); setOpen(false); } }, label);
  return h('span', { style: { position: 'relative' } },
    h('button', { className: 'tm-badge tm-mock', style: { cursor: 'pointer', background: 'none' }, onClick: () => setOpen(!open), 'aria-expanded': open, title: '模拟投影源（P4 第一阶段，未接真实模型）' },
      '模拟', h('span', { className: 'tm-mock-label' }, ` · ${TEAM.control.fixture}`), ' ▾'),
    open ? h('div', { className: 'tm-modal', style: { position: 'absolute', right: 0, top: 26, width: 220, zIndex: 30, padding: 6, maxHeight: 'none' } },
      item('夹具：default（17 人）', () => TEAM.control.setFixture('default')),
      item('夹具：team-30（30 人 / 200 消息）', () => TEAM.control.setFixture('team-30')),
      item('夹具：empty', () => TEAM.control.setFixture('empty')),
      h('hr', { className: 'tm-hr' }),
      item('注入跳号事件', () => TEAM.control.injectGap()),
      item('断流 20 秒', () => TEAM.control.dropStream(20000)),
      item('服务端 stale 切换', () => TEAM.control.setStale(!TEAM.client.getSnapshot().serverStale))) : null);
}
/** Real-source badge: which projection service and which principal this page reads as. */
function SourceBadge({ st }) {
  if (st.sourceKind === 'mock') return null;
  const label = TEAM.source?.describe().label ?? st.sourceKind;
  return h('span', { className: 'tm-badge', 'data-source': st.sourceKind, title: `投影 ${label} · viewer ${st.viewer ?? UNKNOWN}（来自投影 envelope / 事件的认证 principal）` },
    '投影', h('span', { className: 'tm-mock-label' }, ` · ${st.viewer ? memberName(st.data, st.viewer) : '无 viewer'}`));
}
/**
 * Connection health from the activity clock: the newest business event OR liveness comment (SSE `: heartbeat`).
 * Heartbeats never advance seq or data; they only prove the stream is alive.
 */
function healthOf(st, fresh, now) {
  const last = Math.max(st.lastEventAt ?? 0, st.lastActivityAt ?? 0);
  const agoMs = last ? Math.max(0, now - last) : null;
  const level = fresh.level === 'error' ? 'error' : fresh.level === 'stale' ? 'stale' : !st.streamOpen ? (st.streamClosedAt != null ? 'reconnecting' : 'connecting')
    : fresh.level === 'lagging' ? 'lagging' : 'healthy';
  const text = { healthy: '连接健康', lagging: '心跳延迟', reconnecting: '重连中', connecting: '连接中', stale: '投影过期', error: '连接错误' }[level];
  return { level, text, agoMs, heartbeat: fresh.heartbeat !== false };
}
function Health({ st, fresh }) {
  const now = useNow();
  const hl = healthOf(st, fresh, now);
  const ago = hl.agoMs == null ? '' : ` · 活动 ${hl.agoMs < 1000 ? '<1' : Math.round(hl.agoMs / 1000)}s 前`;
  return h('span', { className: 'num tm-fresh-text', 'data-health': hl.level,
    title: `最后业务事件 ${clock(st.lastEventAt)} · 最后心跳 ${st.lastActivityAt ? `${clock(st.lastActivityAt)}（${st.lastActivityKind}）` : '—'}${hl.heartbeat ? '' : ' · 该源没有心跳通道'}；心跳只更新活动时间，不推进 seq` },
    `${hl.text}${ago}`);
}
function Situation({ data, st, now, fresh, c, onDetail }) {
  const ui = useUi();
  const g = goalInfo(data.goal);
  const gate = g.gate;
  return h('header', { className: 'tm-situation', 'data-fresh': fresh.level, role: 'region', 'aria-label': 'Team 态势' },
    h('div', { className: 'tm-goal' }, h('span', { className: 'tm-goal-tag' }, 'TEAM'),
      g.known ? h('span', { className: 'tm-goal-title', 'data-goal': 'known', title: `原生 goal ${data.goal.id}${data.goal.source ? ` · 会话 ${data.goal.source.sessionId} · seq ${data.goal.source.seq}` : ''}` }, g.title)
        : h('span', { className: 'tm-goal-title tm-cap', 'data-goal': 'unknown', title: WHY.goal }, `goal ${UNKNOWN}`),
      h('span', { className: 'tm-badge', title: g.gaps == null ? `验收差距${UNKNOWN}` : '验收差距（未 accepted 的任务）' }, h('span', { className: 'tm-metric-label' }, '差距 '), h('b', { className: 'num' }, g.gaps ?? UNKNOWN)),
      // Gate = the last committed completion check: history, NOT an authorization (completion still needs the token + C1 check).
      h('span', { className: 'tm-badge tm-gate', 'data-gate': gate.status, 'data-sev': gate.status === 'blocked' ? 'warn' : undefined,
        title: gate.known ? `最后一次已提交的检查：${gate.status} · goal rev ${gate.revision ?? '?'} · ${utc(gate.evaluatedAt)} · seq ${gate.sourceSeq ?? '?'}（历史结果，不是完成授权）` : WHY.gate },
        h('span', { className: 'tm-metric-label' }, '最后检查 '), gate.known ? h('b', null, gate.status === 'allowed' ? '通过' : '阻止') : h('span', { className: 'tm-cap' }, UNKNOWN))),
    h('span', { className: 'tm-sep' }),
    h('span', { className: 'tm-metric tm-count-box', 'data-sev': c.needsYou ? 'bad' : undefined, 'data-hot': String(c.needsYouUrgent > 0), title: '需要你处理' },
      h(Glyph, { sev: c.needsYou ? 'bad' : 'ok' }), h('span', { className: 'tm-metric-label tm-metric-long' }, '需要你'), h('b', null, c.needsYou)),
    h('button', { className: 'tm-metric tm-count-box', 'data-sev': c.blocked ? 'bad' : undefined, onClick: () => TEAM.ui.set({ onlyAnomalies: true }), title: '阻塞成员（点击：只看异常）' },
      h('span', { className: 'tm-metric-label' }, '阻塞'), h('b', null, c.blocked)),
    h('span', { className: 'tm-metric tm-count-box', title: '未接责的 action/decision 消息' }, h('span', { className: 'tm-metric-label' }, '未接', h('span', { className: 'tm-metric-long' }, '责')), h('b', null, c.unaccepted)),
    h('span', { className: 'tm-metric tm-count-box', 'data-sev': c.unknown ? 'unknown' : undefined, title: 'unknown：外部回执不确定或成员状态未知' },
      h(Glyph, { sev: 'unknown' }), h('span', { className: 'tm-metric-label tm-metric-long' }, 'unknown'), h('b', null, c.unknown)),
    h('div', { className: 'tm-fresh', 'data-level': fresh.level, title: `asOfSeq ${st.asOfSeq} · 源版本 ${Object.entries(st.sourceRevisions).map(([k, v]) => `${k}@${v}`).join(' ')}` },
      // v3 §4: the title row carries "只读" only for a viewer that is a member but not operator/root.
      readOnlyViewer(data, st.viewer) ? h('span', { className: 'tm-badge', 'data-readonly': 'viewer', title: '当前 viewer 不是 operator / root：只读查看，写操作不显示' }, '只读') : null,
      h(MockMenu), h(SourceBadge, { st }),
      h('span', { className: 'tm-dot' }),
      h('span', { className: 'num' }, `seq ${st.asOfSeq}`),
      h(Health, { st, fresh }),
      h('button', { className: 'tm-btn tm-only-mid', onClick: onDetail, 'aria-pressed': ui.drawer === 'detail' }, '详情 ▸')));
}

// ── needs you ────────────────────────────────────────────
function NeedsYou({ data, now, ui, st }) {
  const items = needsYou(data, now, st.viewer);
  // §4 viewer 只读: the viewer sees how many things are waiting, never the work itself and never a button.
  const readOnly = readOnlyViewer(data, st.viewer);
  // §3.1: more than three rows fold into "还有 n 条". The off surface keeps HEAD's five-row rendering until M6, so the
  // v3 fold is carried by the v1 read states the borrow surface publishes.
  const limit = v1ReadStates(data) ? 3 : 5;
  const shown = ui.showAllNeeds ? items : items.slice(0, limit);
  const act = item => {
    // A capacity safety row has no command to submit (the server settles it elsewhere): its primary action is the detail.
    if (item.kind === 'capacity') { TEAM.ui.openDetail('capacity', item.id); TEAM.ui.setDrawer('detail'); return; }
    if (item.kind === 'thread') {
      const cmd = commandFor('decide', item.ref, data);
      if (cmd.disabledReason) { TEAM.ui.openDetail('thread', item.id); TEAM.ui.setDrawer('detail'); return; }
      return TEAM.ui.openPalette(cmd);
    }
    const cmd = commandFor(item.kind === 'unknown' ? 'unknown' : item.kind, item.ref, data);
    // No usable command (unsupported, not the operator, or no verdict command for this row): show the object, not a palette.
    if (!cmd || cmd.hardDisabled || !cmd.name) { TEAM.ui.openDetail(item.kind === 'approval' ? 'task' : 'message', item.ref?.task ?? item.id); TEAM.ui.setDrawer('detail'); return; }
    TEAM.ui.openPalette(cmd);
  };
  // A hard-disabled command (not supported, or this viewer may not run it) must not look usable in the needs list.
  const why = item => {
    if (item.kind === 'capacity') return null;
    const cmd = commandFor(item.kind === 'unknown' ? 'unknown' : item.kind, item.ref, data);
    return cmd?.hardDisabled ? cmd.disabledReason : null;
  };
  const label = item => item.kind === 'capacity' ? item.action
    : why(item) ? '查看' : item.kind === 'thread' && commandFor('decide', item.ref, data).disabledReason ? '查看' : item.action;
  const kindLabel = { thread: '决策', unknown: 'unknown', approval: '合同', goal: 'goal', capacity: '安全' };
  return h('section', { 'aria-label': '需要你处理' },
    h('div', { className: 'tm-section-title' }, 'Needs you', h('span', { className: 'tm-badge num' }, items.length),
      readOnly ? null : h('span', { className: 'tm-spacer' }),
      readOnly ? null : h('span', { className: 'tm-cap', style: { textTransform: 'none', letterSpacing: 0, fontWeight: 400 } }, '按 deadline · ', h('span', { className: 'tm-kbd' }, 'n'), ' 下一项')),
    h('div', { className: 'tm-needs' },
      readOnly ? h('div', { className: 'tm-empty', 'data-readonly': 'needs' }, items.length ? `有 ${items.length} 件事在等组长决定` : '没有在等组长决定的事')
        : items.length === 0 ? h('div', { className: 'tm-empty' }, '没有需要你处理的事项') : shown.map(item => h('div', { key: item.id, className: 'tm-need', 'data-sev': item.severity },
          h(Glyph, { sev: item.severity }),
          h('button', { className: 'tm-need-title', onClick: () => item.kind === 'thread' ? (TEAM.ui.openDetail('thread', item.id), TEAM.ui.setDrawer('detail')) : act(item), title: item.title },
            h('span', { className: 'tm-need-kind' }, kindLabel[item.kind]), item.title),
          h('span', { className: 'tm-fg3 tm-need-owner', style: { fontSize: 12 } }, `owner=${item.owner}`),
          h('span', { className: cx('num tm-need-when', 'tm-sevtext'), 'data-sev': item.kind === 'unknown' || item.kind === 'capacity' ? 'unknown' : item.severity === 'ok' ? undefined : item.severity },
            // An unknown/capacity row has an opening time, not a deadline; an approval may have neither, and a missing
            // one is reported as missing instead of being measured against the clock (see hasDeadline in model.mjs).
            item.kind === 'unknown' || item.kind === 'capacity' ? (hasDeadline(item.deadline) ? `${relTime(now - item.deadline)} 前` : '—')
              : hasDeadline(item.deadline) ? relTime(item.deadline - now) : '无截止时间'),
          h('button', { className: cx('tm-btn', item.kind === 'capacity' && 'tm-btn-primary'), 'data-need-action': item.id, disabled: !!why(item), title: why(item) ?? undefined, onClick: () => act(item) }, label(item), item.kind === 'capacity' ? null : ' …'))),
      readOnly ? null : items.length > limit ? h('button', { className: 'tm-more', onClick: TEAM.ui.toggleAllNeeds }, ui.showAllNeeds ? '收起' : limit === 3 ? `还有 ${items.length - limit} 条` : `再看 ${items.length - limit} 项`) : null,
      readOnly ? null : h('div', { className: 'tm-note', 'data-approvals': approvalsKnown(data) ? 'known' : 'unknown', style: { padding: '4px 10px' } },
        approvalsKnown(data) ? `scope approval：待批 ${data.approvals.length}${data.approvalsStatus?.source ? `（来源 ${data.approvalsStatus.source}）` : ''}` : `scope approval：${UNKNOWN}（${WHY.approvals}）`,
        ` · goal 完成授权 token：${data.goal.completionToken ?? 'none'}`),
      readOnly || st.viewer ? null : h('div', { className: 'tm-note', style: { padding: '4px 10px' } }, '未取得 viewer 身份：不把任何线程归为“你”。')));
}

/**
 * P5: the v1 states that need a person. Healthy capacity, a quiet guard and a complete batch render nothing, so the
 * default view keeps its size (v3 §1). There is no button here that a viewer lacks permission for, and nothing is
 * pushed anywhere: the line exists only while the page is open.
 */
function BorrowStatus({ data, st }) {
  // Queueing, refused tools and omitted batch items are handled by the product/root, not by the human.
  // Keep them available in details without turning normal automation into a standing alert.
  // A capacity unknown occupancy / closed admission is a person's safety row in "needs you" now, so it is not repeated
  // here as a buttonless alert; the rest of the v1 states live behind the runtime disclosure.
  const items = borrowAttention(data, st.viewer).filter(item => item.severity === 'bad' && item.kind !== 'capacity' && item.kind !== 'human');
  if (!items.length) return null;
  const severity = items.some(item => item.severity === 'bad') ? 'bad' : 'warn';
  const resources = resourceThreadsOf(data).length;
  return h('section', { 'aria-label': 'super-agent 协议状态' },
    h('div', { className: 'tm-alert', 'data-sev': severity },
      h(Glyph, { sev: severity }),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } }, items.map((item, index) => h('span', { key: index }, item.title))),
      h('span', { className: 'tm-spacer' }),
      resources ? h('button', { className: 'tm-btn', onClick: () => TEAM.ui.setTab('resource') }, '资源线程 ' + resources) : null));
}

/**
 * P5 v1 read states as on-demand detail (v3 §3.4 "按需展开"): capacity N/H, the role guard and the last committed batch
 * manifest. Healthy or merely busy states (queueing, a denial count, an omitted batch item) are facts, not alarms: the
 * block is a closed disclosure, it is never an alert line, and it renders nothing when no such block was published.
 */
function RuntimeStates({ data, now }) {
  const capacity = capacityView(data), guard = roleGuardView(data), inputs = inputsView(data);
  if (!capacity && !guard && !inputs) return null;
  const rows = [];
  if (capacity) {
    const lane = (key, label, value) => h('div', { className: 'tm-sub num', 'data-runtime': 'lane', 'data-lane': key },
      `${label} ${laneText(value)}`, value.unknown ? ` · unknown ${value.unknown}` : null, value.queued != null ? ` · 排队 ${value.queued}` : null);
    rows.push(h('div', { key: 'capacity', 'data-runtime': 'capacity' },
      h('div', { className: 'tm-sub' }, '容量 ', h('span', { className: 'tm-cap' }, capacity.admissionClosed ? '· 准入已关闭' : '· 准入开放'),
        typeof capacity.oldestAge === 'number' ? ` · 最早等待 ${relTime(capacity.oldestAge)}` : null),
      lane('normal', '普通', capacity.normal), lane('human', '交互', capacity.human),
      h('div', { className: 'tm-sub num', 'data-runtime': 'provider', 'data-provider': capacity.providerCapacity },
        `provider ${capacity.providerCapacity === 'throttled' ? '限流（throttled）' : capacity.providerCapacity === 'available' ? '可用' : '状态未知'}`,
        capacity.providerWait === 'local-queued' ? ' · 本地排队' : capacity.providerWait === 'provider-throttled' ? ' · 上游 429/限流' : '',
        capacity.providerCapacity === 'throttled' && typeof capacity.providerRecoveryAt === 'number'
          ? ` · ${relTime(Math.max(0, capacity.providerRecoveryAt - now))}后重新观察` : null),
      capacity.occupants.length ? h('div', { className: 'tm-sub', 'data-runtime': 'occupants' }, `占用 ${capacity.occupants.length}：`,
        capacity.occupants.map(o => `${o.ref ?? o.effectId ?? UNKNOWN}（${o.lane ?? UNKNOWN} · ${o.state ?? UNKNOWN}）`).join('、')) : null));
  }
  if (guard) rows.push(h('div', { key: 'guard', 'data-runtime': 'guard' },
    h('div', { className: 'tm-sub' }, `角色守卫 ${guard.installed === true ? '已安装' : guard.installed === false ? '未安装' : UNKNOWN}`,
      guard.coordinatorOnly ? ' · 仅协调者' : null, ` · 拒绝 ${guard.denials} / 放行 ${guard.allows}`,
      guard.auditPersistFailed ? ' · 审计写入失败' : null),
    guard.policy ? h('div', { className: 'tm-sub' }, `策略 拒绝 ${(guard.policy.deny ?? []).join('、') || '—'} · 允许 ${(guard.policy.allow ?? []).join('、') || '—'}`) : null));
  if (inputs) rows.push(h('div', { key: 'inputs', 'data-runtime': 'inputs' },
    h('div', { className: 'tm-sub' }, `批次 ${inputs.count}`, inputs.latest ? ` · 最近 ${inputs.latest.id}` : null),
    inputs.latest ? h('div', { className: 'tm-sub num' }, `items ${inputs.items ?? UNKNOWN} · pending ${inputs.pendingCount ?? UNKNOWN} · omitted ${inputs.omittedCount ?? UNKNOWN} · nextCursor ${inputs.nextCursor ?? '—'}`) : null));
  return h('details', { className: 'tm-disclose tm-runtime', 'data-l2': 'runtime' },
    h('summary', null, h('span', null, '运行状态'), h('span', { className: 'tm-fg3' }, ' · 容量 / 角色守卫 / 批次（按需展开）')),
    h('div', { className: 'tm-disclose-body' }, rows));
}
/**
 * The detail behind a capacity safety row: which external effect the occupancy belongs to, how long it has held the
 * lane, and what a person has to do. It is a read view: there is no server command to submit, so it shows no action.
 */

// ── v3 §3.1 now page ─────────────────────────────────────
const waitedText = ms => (ms == null ? null : '已等 ' + relTime(Math.max(0, ms)));

/** One row per escalation. A row without a primary action is a note, never a disabled button (§6 #12). */
function EscalationRow({ item, onOpen }) {
  const line = [item.why, waitedText(item.waitingMs), item.consequence].filter(Boolean).join(' · ');
  const primary = item.primary && item.primary.label ? item.primary : null;
  return h('div', { className: 'tm-v3-ask', 'data-sev': item.severity, 'data-escalation': item.id },
    h('div', { className: 'tm-v3-ask-q' }, h('b', null, item.question),
      h('span', null, primary ? line : (item.note ?? line))),
    primary ? h('button', { className: 'tm-btn tm-btn-primary', type: 'button', 'data-escalation-action': item.id,
      onClick: () => onOpen(item) }, primary.label) : null);
}

function EscalationList({ data, ui, readOnly }) {
  const items = data.escalations ?? [];
  if (readOnly) {
    return h('div', { className: 'tm-v3-empty', 'data-empty': 'readonly' }, h('span', { className: 'tm-v3-ok' }, 'i'),
      h('div', null, h('b', null, '有 ' + items.length + ' 件事在等组长决定'),
        h('div', { className: 'tm-fg3' }, '你是查看者，这里只显示状态，不提供操作。')));
  }
  if (!items.length) {
    return h('div', { className: 'tm-v3-empty', 'data-empty': 'none' }, h('span', { className: 'tm-v3-ok' }, '✓'),
      h('div', null, h('b', null, '不需要你'),
        h('div', { className: 'tm-fg3' }, '日常决定由 root 处理；有需要你拍板的事会出现在这里。')));
  }
  const shown = ui?.showAllNeeds ? items : items.slice(0, 3);
  const open = item => {
    const type = item.subject?.type === 'member' ? 'member' : item.subject?.type === 'capacity' ? 'capacity' : 'record';
    TEAM.ui.openInspector(type, item.subject?.id ?? item.id, { escalation: item });
    TEAM.ui.setDrawer('detail');
  };
  return h('div', { 'data-escalations': String(items.length) },
    shown.map(item => h(EscalationRow, { key: item.id, item, onOpen: open })),
    items.length > 3 ? h('button', { className: 'tm-btn tm-more', type: 'button', onClick: () => TEAM.ui.toggleAllNeeds() },
      '还有 ' + (items.length - 3) + ' 条') : null);
}

/** N4: the progress bar is per task; the stage detail is a disclosure, not a second funnel. */
function DeliveryProgress({ delivery }) {
  const [open, setOpen] = useState(false);
  if (!delivery) return h('section', { className: 'tm-v3-sec', 'data-v3': 'progress' }, h('h2', null, '进度'),
    h('div', { className: 'tm-fg3' }, '读不到交付进度'));
  const total = delivery.total || 0, accepted = delivery.accepted || 0;
  const pct = total ? Math.round((accepted / total) * 100) : 0;
  return h('section', { className: 'tm-v3-sec', 'data-v3': 'progress' },
    h('h2', null, '进度'),
    h('div', { className: 'tm-v3-prog' }, h('i', { style: { width: pct + '%' } })),
    h('div', { className: 'tm-v3-plab' }, h('span', { className: 'num' }, '已验收 ' + accepted + '/' + total),
      h('button', { className: 'tm-btn tm-v3-link', type: 'button', 'aria-expanded': open,
        onClick: () => setOpen(!open) }, open ? '收起明细' : '阶段明细')),
    open ? h('div', { className: 'tm-v3-stages' },
      ['produced', 'verifying', 'merged', 'accepted'].map(key => h('span', { key, className: 'tm-v3-stage' },
        DELIVERY_TEXT[key] ?? TASK_STAGE_TEXT[key] ?? key, h('b', { className: 'num' }, delivery[key] ?? 0)))) : null);
}

/** N3: one line for the roster; the whole row opens the members page. */
function MemberSummaryLine({ summary, onOpen }) {
  if (!summary) return null;
  const total = summary.normal + summary.stuck + summary.paused + summary.retiring + summary.idle;
  const parts = [];
  if (summary.normal) parts.push(summary.normal + ' 正常');
  if (summary.stuck) parts.push(summary.stuck + ' 卡住' + (summary.stuckHandledBy ? '（root 在处理）' : ''));
  if (summary.paused) parts.push(summary.paused + ' 暂停');
  if (summary.retiring) parts.push(summary.retiring + ' 退役中');
  if (summary.idle) parts.push(summary.idle + ' 空闲');
  const text = parts.length === 0 || parts.length === 1 && summary.normal === total ? total + ' 人都正常'
    : total + ' 人：' + parts.join('、');
  return h('button', { className: 'tm-v3-sum', type: 'button', 'data-v3': 'member-summary', onClick: onOpen },
    h('span', { className: 'tm-v3-chev' }, '▸'), h('span', null, text),
    h('span', { className: 'tm-spacer' }), h('span', { className: 'tm-fg3' }, '展开'));
}

function NowPage({ data, st, now }) {
  const ui = useUi();
  const readOnly = readOnlyViewer(data, st.viewer);
  const summary = data.summary ?? null;
  const headline = summary?.headline ?? null;
  const kind = headline?.kind ?? 'ok';
  const sev = kind === 'needs-you' ? 'bad' : kind === 'root-handling' ? 'warn' : 'ok';
  const goal = goalInfo(data.goal);
  return h('div', { className: 'tm-v3-col', 'data-page': 'now' },
    h('p', { className: 'tm-v3-status', 'data-headline': kind },
      h('span', { className: 'tm-v3-dot', 'data-sev': sev }), headline?.text ?? '读不到团队状态'),
    h('p', { className: 'tm-v3-sub' }, goal.known ? '目标：' + goal.title : '还没有设定目标'),
    h('section', { className: 'tm-v3-sec', 'data-v3': 'needs-you' }, h('h2', null, '需要你的事'),
      h(EscalationList, { data, ui, readOnly })),
    h(DeliveryProgress, { delivery: data.delivery ?? null }),
    h(MemberSummaryLine, { summary: data.memberSummary ?? null, onOpen: () => TEAM.ui.setPage('members') }));
}

function CapacityDetail({ data, now, id }) {
  const occupants = unknownOccupants(data), capacity = capacityView(data);
  const occ = occupants.find(item => item.id === id) ?? occupants[0] ?? null;
  if (!occ) return h('div', { className: 'tm-empty' }, capacity?.admissionClosed ? '执行准入已关闭：unknown 占用尚未证明终结' : '该占用已不在投影里');
  const duration = occ.openedAt != null ? now - occ.openedAt : occ.durationMs;
  return h(Fragment, null,
    h('div', { className: 'tm-card-head' }, h(Glyph, { sev: 'unknown' }), h('h3', null, `外部效果结果不明 · ${occ.effectId ?? UNKNOWN}`),
      h('span', { className: 'tm-badge', 'data-sev': 'unknown' }, '安全')),
    h('dl', { className: 'tm-kv' },
      h('dt', null, 'effectId'), h('dd', { className: 'num', 'data-effect-id': String(occ.effectId ?? '') }, occ.effectId ?? UNKNOWN),
      h('dt', null, '占用槽'), h('dd', { className: 'num' }, occ.ref?.ref ?? UNKNOWN),
      h('dt', null, '名额'), h('dd', null, occ.lane === 'human' ? '交互 H' : '执行 N',
        capacity ? h('span', { className: 'num tm-fg3' }, ` · ${laneText(occ.lane === 'human' ? capacity.human : capacity.normal)}`) : null),
      h('dt', null, '持续时间'), h('dd', { 'data-duration': duration == null ? 'unknown' : String(duration) },
        duration == null ? h('span', { className: 'tm-cap' }, `${UNKNOWN}（投影未给出占用起始时间）`) : `已持续 ${relTime(duration)}`),
      h('dt', null, '准入'), h('dd', null, capacity?.admissionClosed ? '已关闭：新的执行请求不会被接纳' : '开放'),
      h('dt', null, '状态'), h('dd', null, occ.ref?.state ?? UNKNOWN),
      occ.ref?.holderRef ? h('dt', null, '持有') : null, occ.ref?.holderRef ? h('dd', { className: 'num' }, occ.ref.holderRef) : null),
    h('div', { className: 'tm-note', 'data-disposition': 'unknown-occupant' },
      '处置说明：这类占用不会按超时释放，也不会自动消失；重放外部效果或放宽授权都不能把它变成已知。' +
      '请先在宿主侧核对 effectId 对应的外部结果，再由 operator 记录结论；在证明终结之前，执行准入保持关闭。' +
      '这里没有提交命令。'));
}


//#endregion
//#region src/ui/lanes.mjs
// Split of the former src/ui.mjs (M6 WP-3): lanes. Pure move, no behaviour change.
// ── lanes ────────────────────────────────────────────────
function effectiveDensity(ui, n) { return ui.density === 'auto' ? (n > 16 ? 'compact' : 'comfortable') : ui.density; }
function isCollapsed(ui, g, memberCount) { return g.headless ? false : ui.collapsed[g.group.id] ?? (memberCount > 10 ? !g.hot : false); }
function Tally({ tally }) {
  const keys = ['bad', 'unknown', 'warn', 'wait'];
  const parts = keys.filter(k => tally[k]).map(k => h('span', { key: k, className: 'tm-tally tm-sevtext', 'data-sev': k }, h('span', { className: 'num' }, tally[k]), SEVERITY[k].glyph));
  return parts.length ? h('span', { className: 'tm-tally', style: { gap: 6 } }, parts) : h('span', { className: 'tm-cap' }, '全部正常');
}
function laneModel(data, now, ui, order) {
  const groups = groupRows(data, now, order);
  const n = data.members.length;
  const anomalies = new Set();
  if (ui.onlyAnomalies) for (const g of groups) for (const r of g.rows) if (r.severity !== 'ok') for (const id of waitChain(data, r.member.id)) anomalies.add(id);
  const visible = [];
  const shaped = groups.map(g => {
    let rows = g.rows;
    if (ui.onlyAnomalies) rows = rows.filter(r => anomalies.has(r.member.id));
    if (ui.stage) rows = rows.filter(r => r.task?.state === ui.stage);
    const collapsed = isCollapsed(ui, g, n);
    if (!collapsed) for (const r of rows) visible.push(r.member.id);
    return { ...g, shownRows: rows, collapsed };
  }).filter(g => !(ui.onlyAnomalies || ui.stage) || g.shownRows.length);
  return { groups: shaped, visible, density: effectiveDensity(ui, n) };
}
function Lanes({ data, now, ui, model, onOpen }) {
  const flashing = ui.flash.id && now - ui.flash.at < 2200 ? ui.flash.id : null;
  const jump = id => {
    const m = memberById(data, id);
    if (!m) return;
    TEAM.ui.setGroup(groupKey(m.group), false); TEAM.ui.flash(id); TEAM.ui.openDetail('member', id);
  };
  useEffect(() => { if (ui.flash.id) document.querySelector(`.tm-row[data-member="${ui.flash.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [ui.flash.at]);
  const rowCount = model.groups.reduce((a, g) => a + 1 + (g.collapsed ? 0 : g.shownRows.length), 1);
  return h('section', { 'aria-label': '成员泳道' },
    h('div', { className: 'tm-section-title' }, '成员', h('span', { className: 'tm-badge num' }, data.members.length),
      ui.stage ? h('button', { className: 'tm-badge', style: { cursor: 'pointer', background: 'none' }, onClick: () => TEAM.ui.setStage(ui.stage) }, `任务 ${ui.stage} ✕`) : null,
      h('span', { className: 'tm-spacer' }),
      h('div', { className: 'tm-toolbar', style: { textTransform: 'none', letterSpacing: 0, fontWeight: 400 } },
        h('button', { className: 'tm-btn', 'aria-pressed': ui.onlyAnomalies, onClick: TEAM.ui.toggleAnomalies, title: '只显示非 ● 的行与其等待链对象' }, '只看异常 ', h('span', { className: 'tm-kbd' }, 'x')),
        h('button', { className: 'tm-btn', 'aria-pressed': model.density === 'compact', onClick: () => TEAM.ui.cycleDensity(model.density), title: '舒适 32px / 紧凑 24px' },
          model.density === 'compact' ? '紧凑' : '舒适', ' ', h('span', { className: 'tm-kbd' }, 'd')))),
    h('div', { className: 'tm-lanes', 'data-density': model.density, role: 'grid', 'aria-rowcount': rowCount, 'aria-label': '成员泳道：状态、任务、等待、确认、上下文、折叠、租约' },
      h('div', { className: 'tm-lane-grid tm-lane-head', role: 'row' },
        ['', '成员', '当前任务', '等待 → 对象', 'ACK', '上下文 / 上限', 'F', '租约'].map((t, i) =>
          h('div', { key: i, role: 'columnheader', className: ['', '', 'tm-col-task', '', 'tm-col-ack', '', 'tm-col-fold', 'tm-col-lease'][i] }, t))),
      data.members.length === 0 ? h('div', { className: 'tm-empty' }, '还没有成员：root 会按目标创建') : null,
      model.groups.map(g => h(Fragment, { key: g.group.id },
        g.headless ? null : h('button', { className: 'tm-group', role: 'row', 'aria-expanded': String(!g.collapsed), onClick: () => TEAM.ui.setGroup(g.group.id, !g.collapsed) },
          h('span', { className: 'tm-caret' }, '▾'),
          h('span', { className: 'tm-group-name', title: g.group.undescribed ? '该组不在投影的 groups 列表中（按成员自身 group 字段归组）' : undefined }, g.group.label),
          g.group.lead ? h('span', { className: 'tm-cap' }, `子协调者 ${memberName(data, g.group.lead)}`) : null,
          h('span', { className: 'tm-group-sum' }, h('span', { className: 'num' }, `${g.rows.length} 人`), h(Tally, { tally: g.tally }),
            h('span', null, '上下文最高 ', g.maxCtx == null ? h('span', { className: 'tm-cap', title: WHY.context }, UNKNOWN)
              : h('span', { className: 'num tm-sevtext', 'data-sev': g.maxCtx >= CONTEXT_FULL ? 'bad' : g.maxCtx >= CONTEXT_WARN ? 'warn' : undefined }, pctText(g.maxCtx))))),
        g.collapsed ? null : g.shownRows.map(r => {
          const m = r.member;
          return h('div', { key: m.id, className: 'tm-lane-grid tm-row', role: 'row', 'data-member': m.id, 'data-sev': r.severity, 'aria-selected': String(ui.selected === m.id),
            'data-flash': String(flashing === m.id || (r.movedAt && now - r.movedAt < 2000)),
            onClick: () => { TEAM.ui.select(m.id); TEAM.ui.openDetail('member', m.id); }, onDoubleClick: () => onOpen(m.id) },
          h('div', { role: 'gridcell' }, h(Glyph, { sev: r.severity })),
          h('div', { role: 'gridcell', className: 'tm-name', title: `${m.name} · ${ROLE_LABEL[m.role]}` }, h('strong', null, truncate(m.name, 16)), h('span', { className: 'tm-role', title: ROLE_LABEL[m.role] }, ROLE_ABBR[m.role])),
          h('div', { role: 'gridcell', className: 'tm-col-task' }, h(TaskCell, { task: r.task, member: m })),
          h('div', { role: 'gridcell' }, h(WaitCell, { wait: m.wait, now, onJump: jump })),
          h('div', { role: 'gridcell', className: 'tm-col-ack' }, h(AckDots, { ack: r.ack, now })),
          h('div', { role: 'gridcell' }, h(CtxBar, { context: m.context, member: m })),
          h('div', { role: 'gridcell', className: 'tm-col-fold' }, h(Fold, { context: m.context })),
          h('div', { role: 'gridcell', className: 'tm-col-lease' }, h(Lease, { attempt: m.attempt, now })));
        }))),
      data.restrictedMembers ? h('div', { className: 'tm-restricted', role: 'row' }, h('span', { className: 'tm-glyph', 'data-sev': 'frozen' }, '⊘'),
        `受限成员 ×${data.restrictedMembers}（服务端 ACL 过滤，不显示名称）`) : null));
}


// ── v3 §3.2 members page ─────────────────────────────────
/** Five states, in the order the page sorts by importance (§3.2). */
function memberStatus(member) {
  if (member.observed === 'unknown' || member.status === 'unknown') return { key: 'stuck', text: '卡住 · root 在处理', sev: 'warn' };
  if (member.observed === 'retired') return { key: 'retired', text: '已退役', sev: 'idle' };
  if (member.desired === 'retired' || member.observed === 'retiring') return { key: 'retiring', text: '退役中…', sev: 'idle' };
  if (member.observed === 'frozen') return { key: 'paused', text: '已暂停', sev: 'idle' };
  if (member.desired === 'frozen') return { key: 'pausing', text: '正在暂停…', sev: 'warn' };
  const activity = member.activity ?? null;
  if (activity?.kind === 'running') return { key: 'running', text: '正常', sev: 'ok' };
  if (activity?.kind === 'maintenance') return { key: 'maintenance', text: '维护中', sev: 'warn' };
  return { key: 'idle', text: '空闲', sev: 'idle' };
}

/** The "what is it doing" column: one sentence, never a status-machine word. */
function memberDoing(member, data) {
  const references = referenceIds(data);
  const activity = member.activity ?? null;
  const task = member.taskId ? (data.tasks ?? []).find(t => t.id === member.taskId) : null;
  if (task) return humanText(task.title, '正在处理任务', references);
  if (activity?.kind === 'maintenance') return humanText(activity.sub, '维护中', references) + (activity.since ? ' · ' + relTime(Date.now() - activity.since) : '');
  if (activity?.kind === 'running') {
    if (activity.tool) return '正在处理任务 · 已用 ' + relTime(activity.tool.elapsed);
    return humanText(activity.sub, activity.since ? relTime(Date.now() - activity.since) : '运行中', references);
  }
  if (member.wait) return '在等 ' + humanText(member.wait.targetLabel, '外部输入', references);
  return '没有进行中的任务';
}

function MembersPage({ data, now }) {
  const ui = useUi();
  const groups = data.groups ?? [];
  const members = data.members ?? [];
  const references = referenceIds(data);
  const row = member => {
    const status = memberStatus(member);
    return h('tr', { key: member.id, 'data-member': member.id, 'data-group': groupKey(member.group), 'data-selected': String(ui.selected === member.id),
      onClick: () => { TEAM.ui.select(member.id); TEAM.ui.openInspector('member', member.id); TEAM.ui.setDrawer('detail'); } },
      h('td', { className: 'tm-v3-name', title: humanText(member.name, '成员', references) }, humanText(memberName(data, member.id), '成员', references)),
      h('td', { className: 'tm-v3-what fg2', title: memberDoing(member, data) }, memberDoing(member, data)),
      h('td', null, h('span', { className: 'tm-v3-st', 'data-sev': status.sev, 'data-status': status.key }, status.text)));
  };
  const grouped = groups.length > 1 && members.length > 6;
  const body = [];
  if (grouped) {
    for (const group of groups) {
      const rows = members.filter(m => groupKey(m.group) === group.id);
      if (!rows.length) continue;
      body.push(h('tr', { key: 'g:' + group.id, className: 'tm-v3-group', 'data-group-header': group.id }, h('td', { colSpan: 3 }, group.label ?? group.id)));
      for (const member of rows) body.push(row(member));
    }
    const ungrouped = members.filter(m => !groups.some(g => g.id === groupKey(m.group)));
    if (ungrouped.length) body.push(h('tr', { key: 'ungrouped', className: 'tm-v3-group', 'data-group-header': '__ungrouped' },
      h('td', { colSpan: 3 }, '未分组')));
    for (const member of ungrouped) body.push(row(member));
  } else for (const member of members) body.push(row(member));
  return h('div', { className: 'tm-v3-col', 'data-page': 'members' },
    h(MemberSummaryLine, { summary: data.memberSummary ?? null, onOpen: () => TEAM.ui.setPage('members') }),
    h('table', { className: 'tm-v3-table' },
      h('thead', null, h('tr', null, h('th', { style: { width: '24%' } }, '名字'), h('th', null, '在做什么'),
        h('th', { style: { width: '26%' } }, '状态'))),
      h('tbody', null, body)));
}

function Pipeline({ data, ui }) {
  const c = pipelineCounts(data.tasks);
  const label = { produced: 'produced', verifying: 'verifying', verified: 'verified', integrating: 'integrating', merged: 'merged', accepted: '✓ accepted' };
  return h('section', { 'aria-label': '交付管线' },
    h('div', { className: 'tm-section-title' }, '交付管线', h('span', { className: 'tm-spacer' }),
      h('span', { className: 'tm-cap', style: { textTransform: 'none', letterSpacing: 0, fontWeight: 400 } }, 'produced ≠ accepted：只有 accepted 用绿色')),
    h('div', { className: 'tm-pipe' }, PIPELINE.map((k, i) => h('button', { key: k, className: 'tm-stage', 'data-end': k === 'produced' || (k === 'accepted' && c[k] > 0) ? k : undefined,
      'aria-pressed': ui.stage === k, onClick: () => { TEAM.ui.setStage(k); TEAM.ui.setTab('task'); } },
    h('span', { className: 'tm-stage-label' }, label[k]), h('span', { className: 'tm-stage-count' }, c[k]),
    i < PIPELINE.length - 1 ? h('span', { className: 'tm-stage-arrow', 'aria-hidden': true }, '›') : null))));
}


//#endregion
//#region src/ui/records.mjs
// M6 WP-4 (16 §3.3): the records page. A filtered timeline read through the P12 endpoint; the page never invents
// events. Newest first, grouped by day. The five chips are the projection's categories.

const RECORD_CHIPS = Object.freeze([
  ['all', '全部'], ['anomaly', '只看异常'], ['needs-you', '需要你'],
  ['root-decision', 'root 的裁决'], ['delivery', '交付与验收'],
]);
const RECORD_RANGES = Object.freeze([['all', '全部时间'], ['today', '今天'], ['7d', '最近 7 天']]);
// 15 §9 V-23: --tm-done belongs to accepted work only. A record's dot marks its category, not an acceptance: the
// delivery timeline also carries produced/verifying rows, so it uses the in-progress token and never turns green.
const SEV = Object.freeze({ anomaly: 'bad', 'needs-you': 'warn', 'root-decision': 'ok', delivery: 'wait', other: 'idle' });
const DAY = 86400000;

function dayKey(at, now) {
  const date = new Date(at);
  const today = new Date(now);
  const startOf = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(date)) / DAY);
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  return (date.getMonth() + 1) + ' 月 ' + date.getDate() + ' 日';
}

function groupByDay(events, now) {
  const groups = [];
  for (const event of events) {
    const key = dayKey(event.at, now);
    let group = groups.find(item => item.key === key);
    if (!group) { group = { key, events: [] }; groups.push(group); }
    group.events.push(event);
  }
  return groups;
}

function RecordRow({ event, onOpen, data }) {
  const { title: name, text } = recordPresentation(data, event);
  return h('li', { 'data-sev': SEV[event.category] ?? 'idle', 'data-record': event.id, 'data-category': event.category, role: 'button', tabIndex: 0,
    onClick: e => { e?.currentTarget?.focus?.({ preventScroll: true }); onOpen(event); },
    onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } } },
    h('span', { className: 'tm-v3-time num' }, clock(event.at)),
    h('span', { className: 'tm-v3-dot' }),
    h('div', null, h('b', { className: 'tm-v3-who', title: name }, name), ' ', text,
      (event.tags ?? []).length ? h('span', { className: 'tm-v3-tags' }, ' · ' + event.tags.map(tag => humanText(tag, '', referenceIds(data, event))).filter(Boolean).join(' · ')) : null));
}

function RecordsPage({ data, now, initialPage = null }) {
  const ui = useUi();
  const st = useClient(), source = TEAM.source;
  const ref = useRef(null);
  if (!ref.current) ref.current = new ActivityPager(initialPage);
  const pager = ref.current;
  const from = ui.recordRange === 'all' ? null : new Date(now).setHours(0, 0, 0, 0) - (ui.recordRange === '7d' ? 7 * DAY : 0);
  const query = { kind: ui.recordFilter === 'all' ? null : ui.recordFilter, member: ui.recordMember, from, limit: 20 };
  const scope = st.scopeGeneration ?? 0, key = JSON.stringify([query, scope]);
  const state = useSyncExternalStore(pager.subscribe, pager.getSnapshot);
  const active = !source?.activity || pager.matches(source, query, scope);
  const page = active ? state.page : null, loading = !active || state.loading, error = active ? state.error : null;
  useEffect(() => { pager.setScope(source, query, scope); return () => pager.dispose(); }, [source, key]);
  const more = () => pager.load(true);
  const clear = () => { TEAM.ui.setRecordFilter('all'); TEAM.ui.setRecordMember(null); TEAM.ui.setRecordRange('all'); };
  const members = data?.members ?? [];
  const events = page?.events ?? [];
  return h('div', { className: 'tm-v3-col', 'data-page': 'records' },
    h('div', { className: 'tm-v3-chips' },
      RECORD_CHIPS.map(([value, label]) => h('button', { key: value, type: 'button', className: cx('tm-v3-chip', ui.recordFilter === value && 'on'),
        'data-chip': value, 'aria-pressed': String(ui.recordFilter === value), onClick: () => TEAM.ui.setRecordFilter(value) }, label)),
      h('span', { className: 'tm-spacer' }),
      h('select', { className: 'tm-v3-select', 'aria-label': '按成员筛选', value: ui.recordMember ?? '',
        onChange: e => TEAM.ui.setRecordMember(e.target.value || null) },
        h('option', { value: '' }, '成员：全部'), members.map(m => h('option', { key: m.id, value: m.id }, '成员：' + (m.name ?? m.id)))),
      h('select', { className: 'tm-v3-select', 'aria-label': '按时间筛选', value: ui.recordRange,
        onChange: e => TEAM.ui.setRecordRange(e.target.value) },
        RECORD_RANGES.map(([value, label]) => h('option', { key: value, value }, label)))),
    error ? h('div', { className: 'tm-v3-empty', 'data-error': 'records' }, h('b', null, '连不上记录'),
      h('div', { className: 'tm-fg3' }, error), h('button', { className: 'tm-btn', type: 'button', onClick: () => pager.load(false) }, '重试'))
      : loading && !events.length ? h('div', { className: 'tm-v3-empty' }, '正在读取记录…')
      : !events.length ? h('div', { className: 'tm-v3-empty', 'data-empty': 'records' }, h('b', null, '这个筛选下没有记录'),
        h('button', { className: 'tm-btn', type: 'button', onClick: clear }, '清除筛选'))
      : h(Fragment, null,
        groupByDay(events, now).map(group => h('section', { key: group.key, className: 'tm-v3-day' },
          h('div', { className: 'tm-v3-daylabel' }, group.key),
          h('ul', { className: 'tm-v3-tl' }, group.events.map(event => h(RecordRow, { key: event.id + ':' + event.seq, event, data,
            onOpen: item => { TEAM.ui.openInspector('record', item.id, { event: item }); TEAM.ui.setDrawer('detail'); } }))))),
        page?.nextBeforeSeq != null ? h('button', { className: 'tm-btn tm-v3-more', type: 'button', disabled: loading, onClick: more }, '更早的记录') : null));
}

//#endregion
//#region src/ui/detail.mjs
// Split of the former src/ui.mjs (M6 WP-3): detail. Pure move, no behaviour change.
// ── details (L2) ─────────────────────────────────────────
const TABS = [['member', '成员'], ['task', '任务'], ['thread', '线程'], ['resource', '资源'], ['message', '消息'], ['context', '上下文']];
function Detail({ data, now, ui, onOpen, className }) {
  const tab = ui.detail.tab;
  return h('aside', { className: cx('tm-detail', className), 'aria-label': 'L2 详情' },
    h('div', { className: 'tm-tabs', role: 'tablist' }, TABS.filter(([k]) => k !== 'resource' || Object.hasOwn(data, 'resourceThreads')).map(([k, label]) => h('button', { key: k, role: 'tab', className: 'tm-tab', 'aria-selected': String(tab === k), onClick: () => TEAM.ui.setTab(k) }, label)),
      ui.drawer === 'detail' ? h('button', { className: 'tm-btn tm-btn-ghost', style: { marginLeft: 'auto', marginBottom: 6 }, onClick: () => TEAM.ui.setDrawer(null), 'aria-label': '关闭详情' }, '✕') : null),
    h('div', { className: 'tm-detail-body', role: 'tabpanel' },
      tab === 'member' ? h(MemberDetail, { data, now, id: ui.detail.id ?? ui.selected ?? rootMember(data)?.id, onOpen }) : null,
      tab === 'task' ? h(TaskView, { data, ui, id: ui.detail.id ?? memberById(data, ui.selected)?.taskId ?? null }) : null,
      tab === 'thread' ? h(ThreadView, { data, now, id: ui.detail.id }) : null,
      tab === 'resource' ? h(ResourceView, { data, now, id: ui.detail.id }) : null,
      tab === 'message' ? h(MessagesView, { data, now, ui }) : null,
      // Opened from a capacity safety row in "needs you"; it is not a tab of its own (tabs stay as they are until M6).
      tab === 'capacity' ? h(CapacityDetail, { data, now, id: ui.detail.id }) : null,
      tab === 'context' ? h(ContextView, { data, now, id: ui.detail.id ?? ui.selected ?? rootMember(data)?.id }) : null),
    h(RuntimeStates, { data, now }));
}
/** Lifecycle (09 §5.5): collapsed shows the current state, "▸ 历史" expands the committed chain. No history → unknown. */
function History({ items }) {
  if (!items?.length) return h('span', { className: 'tm-cap', title: '投影没有已提交的生命周期记录' }, UNKNOWN);
  const words = s => typeof s === 'string' ? s : s?.text ?? UNKNOWN;
  const chain = h('div', { className: 'tm-history' }, items.map((step, i) => { const s = words(step); return h(Fragment, { key: i }, i ? h('span', null, '→') : null, i === items.length - 1 ? h('b', null, s) : h('span', null, s)); }));
  if (items.length === 1) return chain;
  return h('details', { className: 'tm-disclose', 'data-l2': 'history' }, h('summary', null, h('b', null, words(items[items.length - 1])), h('span', { className: 'tm-fg3' }, `  ▸ 历史 ${items.length} 步`)), chain);
}
/** Generic L2 disclosure: a one-line summary that expands to the evidence (native <details>, keyboard accessible). */
function Disclose({ id, summary, children }) {
  return h('details', { className: 'tm-disclose', 'data-l2': id }, h('summary', null, summary), h('div', { className: 'tm-disclose-body' }, children));
}
function MemberDetail({ data, now, id, onOpen, v3 = false }) {
  const m = memberById(data, id);
  if (!m) return h('div', { className: 'tm-empty' }, data.members.length ? '该成员受限或不存在' : '还没有成员：root 会按目标创建');
  const sev = memberSeverity(m, { now, messages: data.messages });
  const task = data.tasks.find(t => t.id === m.taskId);
  const ack = ackSummary(data.messages, m.id);
  const waitingOthers = data.messages.filter(x => x.from === m.id && x.kind !== 'info' && !x.receipts.accepted && !['cancelled', 'resolved'].includes(x.lifecycle)).length;
  const c = m.context;
  const retire = retireAction(m, now);
  const head = h('div', { className: 'tm-card-head' }, h(Glyph, { sev }), h('h3', null, m.name), h('span', { className: 'tm-role' }, ROLE_ABBR[m.role]),
    h('span', { className: 'tm-cap', title: m.id }, `${ROLE_LABEL[m.role] ?? m.role} · 组 ${m.group ?? '未分组'} · gen ${m.generation ?? UNKNOWN}`));
  const facts = h('dl', { className: 'tm-kv' },
      h('dt', null, '状态'), h('dd', null, `desired ${m.desired} · observed ${m.observed === 'unknown' ? '?' : m.observed}`,
        m.desired !== m.observed ? h('div', { className: 'tm-sevtext', 'data-sev': m.observed === 'unknown' ? 'unknown' : 'warn', style: { fontSize: 12 } },
          m.observed === 'unknown' ? '? 外部回执不确定，未沿用上次状态' : m.desired === 'retired' ? `▲ ${retire.label} · 等待原生停止确认` : m.desired === 'frozen' ? '▲ 冻结请求中 · 等待原生停止确认' : `▲ desired ${m.desired} ≠ observed ${m.observed} · 等待原生状态对账`) : null),
      h('dt', null, '生命周期'), h('dd', null, h(History, { items: m.history })),
      h('dt', null, 'attempt'), h('dd', null, m.attempt ? h(Fragment, null, h('span', { className: 'num' }, `#${m.attempt.n} ${m.attempt.state}`), ' · ',
        m.attempt.lease ? h(Fragment, null, h('span', { className: 'num' }, `fence ${m.attempt.lease.fence}`), ' · ', h(Lease, { attempt: m.attempt, now })) : '无 lease',
        m.attempt.worktree ? h('span', { className: 'num tm-fg3' }, ` · ${m.attempt.worktree}`) : null,
        m.attempt.superseded?.length ? h(Disclose, { id: 'superseded', summary: h('span', { className: 'tm-fg3' }, `▸ ${m.attempt.superseded.length} 个被取代的 attempt`) },
          m.attempt.superseded.map(s => h('div', { key: s.n, className: 'tm-sub' }, `#${s.n} ${s.state}（被 #${m.attempt.n} 取代）`))) : null) : h('span', { className: 'tm-cap' }, '—')),
      h('dt', null, '任务'), h('dd', null, task ? h('button', { className: 'tm-link', onClick: () => TEAM.ui.openDetail('task', task.id) }, `${task.id} ${task.title}`) : h('span', { className: 'tm-cap' }, '—'),
        task ? h('span', { className: 'tm-task-state', 'data-sev': TASK_SEV[task.state] }, ` · ${task.state}`) : null),
      h('dt', null, '等待'), h('dd', null, m.wait ? h(Fragment, null, h(WaitCell, { wait: m.wait, now, onJump: jid => { TEAM.ui.flash(jid); TEAM.ui.openDetail('member', jid); } }),
        h('div', { className: 'tm-sub num' }, `deadline ${clock(m.wait.deadline)} · ${m.wait.kind}`)) : h('span', { className: 'tm-cap' }, '—')),
      h('dt', null, '上下文'), h('dd', null, h(CtxBar, { context: c, member: m }),
        contextKnown(m) ? h('div', { className: 'tm-sub' }, '兜底压缩 ', counter(c.hardGateHits), ' · 截断引用 ', counter(c.truncRefs), ' · 折叠 ',
          !c.fold ? counter(null) : c.fold.enabled ? `F${c.fold.count}` : h('span', { className: 'tm-fold-off' }, 'off'),
          ' · 快照 ', counter(c.snapshotTokens, v => `${(v / 1000).toFixed(1)}k / 4096 tok`),
          c.fold?.last ? h(Disclose, { id: 'fold', summary: h('span', { className: 'tm-fg3' }, '▸ 最近折叠') },
            `${clock(c.fold.last.at)} 遮蔽 ${c.fold.last.masked} 节点（snapshot rev ${c.fold.last.revFrom}→${c.fold.last.revTo}）`) : null) : null),
      h('dt', null, 'delegation'), h('dd', null, m.delegation ? h(Fragment, null, h('span', { className: 'mono' }, m.delegation.scope),
        ` · 风险 ${m.delegation.risk} · 预算 $${m.delegation.budgetUsed.toFixed(2)}/$${m.delegation.budget} · 到期 ${clock(m.delegation.expiresAt)}`) : h('span', { className: 'tm-cap' }, '—')),
      h('dt', null, '消息'), h('dd', null, `收件未接责 ${ack?.unaccepted ?? 0} · 发件等待他人 ${waitingOthers}`),
      h('dt', null, 'checkpoint'), h('dd', null, m.checkpointAt ? `${relTime(now - m.checkpointAt)} 前` : '—'));
  const actions = h(MemberActions, { data, now, id, onOpen });
  // v3 §3.4: the inspector folds the technical table into 运行细节; the permitted actions are pinned to its bottom.
  if (v3) return h('details', { className: 'tm-disclose', 'data-ins': 'runtime-detail' }, h('summary', null, '运行细节'),
    h('div', { className: 'tm-disclose-body' }, head, facts));
  return h(Fragment, null, head, facts, h('hr', { className: 'tm-hr' }), actions);
}
/**
 * The member action area on its own (v3 §3.4 "底部操作：仅显示有权限的"): the inspector renders it last, after the
 * disclosures, while the L2 pane keeps it inside MemberDetail exactly where it always was.
 */
function MemberActions({ data, now, id, onOpen }) {
  const m = memberById(data, id);
  if (!m) return null;
  const retire = retireAction(m, now);
  const readOnly = readOnlyViewer(data);
  const retireWhy = m.role !== 'root' && m.observed !== 'retired' ? unsupportedReason('organization.retire') : null;
  return h(Fragment, null,
    readOnly ? h('div', { className: 'tm-note', 'data-readonly': 'actions' }, '只读查看：没有可执行的操作。',
      h('button', { className: 'tm-btn', onClick: () => onOpen(m.id) }, '打开会话')) : h('div', { className: 'tm-actions' },
      h('button', { className: 'tm-btn', onClick: () => onOpen(m.id), disabled: !m.nativeRef && m.role !== 'root', title: m.nativeRef ? `原生会话 ${m.nativeRef}` : '绑定未知' }, '打开会话 ', h('span', { className: 'tm-kbd' }, '↵')),
      m.role !== 'root' && m.observed !== 'retired' ? h(CmdButton, { cmd: commandFor('send', m, data), label: '发话…' }) : null,
      m.observed === 'frozen' ? h(CmdButton, { cmd: commandFor('resume', m, data), label: '恢复…' })
        : m.role !== 'root' && m.observed !== 'retired' ? h(CmdButton, { cmd: commandFor('freeze', m, data), disabled: m.desired === 'frozen', label: m.desired === 'frozen' ? '冻结请求中' : '冻结…' }) : null,
      m.role !== 'root' && m.observed !== 'retired' ? h(CmdButton, { cmd: commandFor('retire', m, data), disabled: retire.disabled,
        title: retire.disabled ? '同一成员的退役请求已提交；' + retire.label : undefined, label: retire.label }) : null),
    readOnly || !retireWhy ? null : h('div', { className: 'tm-note' }, `退役：${retireWhy}`));
}
const unknownCap = why => h('span', { className: 'tm-cap', title: why }, UNKNOWN);
const attemptRow = a => h('div', { key: a.n, className: a.supersededBy ? 'tm-fg3' : undefined }, h('span', { className: 'num' }, `#${a.n}`), ` ${a.state}`, a.supersededBy ? `（已被 #${a.supersededBy} 取代）` : '');
/** L2 task card (09 §3.2 右栏·任务): contract, attempts (superseded kept behind a disclosure), delivery, certificate binding, merge. */
function TaskCard({ task }) {
  const at = taskAttempts(task), dv = deliveryInfo(task, dataOf());
  return h('section', { className: 'tm-l2', 'data-l2-task': task.id },
    h('div', { className: 'tm-card-head' }, h('h3', null, task.id), h('span', { className: 'tm-badge', 'data-sev': task.state === 'accepted' ? 'done' : TASK_SEV[task.state] }, task.state)),
    h('div', null, task.title),
    h('dl', { className: 'tm-kv' },
      h('dt', null, 'owner'), h('dd', null, task.owner ? h('button', { className: 'tm-link', title: task.owner, onClick: () => TEAM.ui.openDetail('member', task.owner) }, kname(task.owner)) : unknownCap('投影未给出 owner')),
      h('dt', null, '合同'), h('dd', { className: 'num' }, num(task.contractRevision) ? `revision ${task.contractRevision}` : unknownCap('投影未给出合同 revision')),
      h('dt', null, 'attempts'), h('dd', null, !at ? unknownCap('投影未给出 attempt 列表') : at.total === 0 ? '—' : h(Fragment, null,
        at.live.map(attemptRow),
        at.superseded.length ? h(Disclose, { id: 'task-superseded', summary: h('span', { className: 'tm-fg3' }, `▸ ${at.superseded.length} 个已被取代（返工保留）`) }, at.superseded.map(attemptRow)) : null)),
      h('dt', null, '交付'), h('dd', null, !dv.known ? unknownCap('投影未给出交付读视图') : dv.none ? h('span', { className: 'tm-cap' }, '— 尚无交付') : h(Fragment, null,
        h('span', { className: 'num' }, dv.revision != null ? `r${dv.revision}` : 'r?'), ' · 证书 ',
        h('span', { className: 'tm-sevtext', 'data-sev': dv.certificate === 'valid' ? 'ok' : dv.certificate === 'invalid' ? 'bad' : undefined }, dv.certificate ?? '未签'))),
      h('dt', null, '证书绑定'), h('dd', null, !dv.known ? unknownCap('投影未给出交付读视图') : dv.none ? h('span', { className: 'tm-cap' }, '—')
        : dv.binding ? h(BindingView, { b: dv.binding, task }) : unknownCap('没有已提交的证书绑定事实（certificateBinding 未输出）')),
      h('dt', null, 'merge'), h('dd', null, !dv.known ? unknownCap('投影未给出交付读视图') : dv.none ? '—'
        : h('span', { className: 'tm-sevtext', 'data-sev': dv.merge === 'confirmed' && task.state === 'accepted' ? 'done' : dv.merge === 'unknown' ? 'unknown' : undefined }, dv.merge ?? '—'))),
    task.state !== 'accepted' && ['produced', 'verified', 'merged'].includes(task.state) ? h('div', { className: 'tm-note' }, `${task.state} ≠ accepted：业务完成以独立验收 accepted 为准。`) : null);
}
/** certificateBinding (packages/projections/schema.mjs): short hash in the summary, every committed field when expanded; missing → 未知. */
function BindingView({ b, task }) {
  const v = (x, fmt = y => y) => x == null ? h('span', { className: 'tm-cap' }, UNKNOWN) : fmt(x);
  const sha = x => h('span', { className: 'num', title: x }, x.length > 12 ? `${x.slice(0, 12)}…` : x);
  const attempt = b.attempt.state === 'none' ? h('span', { className: 'tm-cap', title: '证书未签入 attempt（旧证书不做推断）' }, '未绑定 attempt')
    : b.attempt.state === 'matched' ? h('span', { 'data-binding-attempt': 'matched' }, `#${b.attempt.match.n ?? '?'} ${b.attempt.match.state ?? ''}`, h('span', { className: 'tm-fg3' }, '（与任务 attempt 对上）'))
      : h('span', { className: 'tm-sevtext', 'data-sev': 'warn', 'data-binding-attempt': 'unmatched', title: b.attempt.id ?? '' }, `▲ ${b.attempt.id ? shortId(b.attempt.id) : UNKNOWN} 不在该任务的 attempt 中`);
  return h(Disclose, { id: 'binding', summary: h('span', { className: 'num', title: b.hash ?? '证书 hash 未知或格式不符' }, b.hash ? `hash ${b.hashShort}… ▸` : `hash ${UNKNOWN} ▸`) },
    h('dl', { className: 'tm-kv tm-kv-sub', title: '历史签发的证书绑定，不是授权；当前有效性看“证书”一栏' },
      h('dt', null, 'hash'), h('dd', { className: 'num', style: { wordBreak: 'break-all' } }, v(b.hash)),
      h('dt', null, 'task'), h('dd', null, v(b.taskId, x => b.taskMatches ? x : h('span', { className: 'tm-sevtext', 'data-sev': 'warn' }, `▲ ${x}（≠ ${task.id}）`))),
      h('dt', null, 'attempt'), h('dd', null, attempt),
      h('dt', null, 'verifier'), h('dd', null, v(b.verifier, x => h('span', { title: x }, kname(x)))),
      h('dt', null, '合同'), h('dd', { className: 'num' }, v(b.contractRevision, x => `revision ${x}`)),
      h('dt', null, 'candidate'), h('dd', null, v(b.candidate, sha)),
      h('dt', null, 'tree'), h('dd', null, v(b.tree, sha)),
      h('dt', null, 'delivery'), h('dd', { className: 'num' }, v(b.deliveryId), ' · ', v(b.deliveryRevision, x => `r${x}`)),
      h('dt', null, 'status'), h('dd', null, v(b.status))));
}
function TaskView({ data, ui, id }) {
  const task = id && data.tasks.find(t => t.id === id);
  const list = ui.stage ? data.tasks.filter(t => t.state === ui.stage) : data.tasks;
  return h(Fragment, null,
    task ? h(Fragment, null, h(TaskCard, { task }), h('hr', { className: 'tm-hr' }))
      : id ? h(Fragment, null, h('div', { className: 'tm-empty' }, `任务 ${id} 受限或不存在`), h('hr', { className: 'tm-hr' })) : null,
    h('div', { className: 'tm-section-title' }, ui.stage ? `任务 · ${ui.stage}` : '全部任务', h('span', { className: 'tm-badge num' }, list.length)),
    list.length ? h('ul', { className: 'tm-list' }, list.map(t => h('li', { key: t.id }, h('button', { className: 'tm-li', 'aria-current': String(t.id === id), onClick: () => TEAM.ui.openDetail('task', t.id) },
      h('span', { className: 'num tm-fg3', style: { width: 56 } }, t.id), h('span', { className: 'tm-grow' }, t.title),
      h('span', { className: 'tm-task-state', 'data-sev': t.state === 'accepted' ? 'done' : TASK_SEV[t.state] }, t.state))))) : h('div', { className: 'tm-empty' }, '没有任务'));
}
const THREAD_SEV = { open: 'wait', collecting: 'wait', deciding: 'warn', escalated: 'bad', decided: 'ok', closed: 'frozen', cancelled: 'frozen', superseded: 'frozen' };

// ── v3 §3.4 inspector (right rail / drawer) ─────────────
function recordRow(data, id) {
  for (const key of ['tasks', 'threads', 'messages', 'decisions']) {
    const row = (data?.[key] ?? []).find(item => item.id === id);
    if (row) return row;
  }
  return null;
}

function RecordDetail({ data, now, event, id, ui }) {
  const row = recordRow(data, event?.subject?.id ?? event?.id ?? id);
  const readable = recordPresentation(data, event ?? { id });
  const at = event?.at ?? null;
  return h(Fragment, null,
    h('div', { className: 'tm-v3-ins-note' }, event ? readable.text : '读不到这条记录的正文'),
    h('dl', { className: 'tm-kv' },
      h('dt', null, '时间'), h('dd', { className: 'num' }, at == null ? UNKNOWN : utc(at) + ' · ' + relTime(Math.max(0, now - at)) + '前'),
      h('dt', null, '对象'), h('dd', null, readable.title),
      h('dt', null, '分类'), h('dd', null, humanText((event?.tags ?? []).join(' · '), UNKNOWN, referenceIds(data, event))),
      event?.members?.length ? h('dt', null, '相关成员') : null,
      event?.members?.length ? h('dd', null, event.members.map(member => kname(member)).join('、')) : null,
      row?.evidence?.length ? h('dt', null, '证据') : null,
      row?.evidence?.length ? h('dd', null, row.evidence.map(e => e.ref ?? e.text ?? UNKNOWN).join('、')) : null),
    row ? h('details', { className: 'tm-disclose', open: undefined },
      h('summary', null, '原始记录'), h('pre', { className: 'tm-v3-raw' }, JSON.stringify(row, null, 1))) : null,
    h('details', { className: 'tm-disclose', 'data-ins': 'technical', open: ui?.details ? true : undefined },
      h('summary', null, '技术细节'),
      h('dl', { className: 'tm-kv' },
        h('dt', null, 'id'), h('dd', { className: 'num', 'data-tech': 'id' }, event?.id ?? id ?? UNKNOWN),
        h('dt', null, 'seq'), h('dd', { className: 'num' }, event?.seq == null ? UNKNOWN : String(event.seq)),
        h('dt', null, '原始文案'), h('dd', null, event?.text ?? UNKNOWN),
        h('dt', null, 'kind'), h('dd', null, event?.kind ?? UNKNOWN))));
}

/** The member detail behind a selected row; the technical layer follows the global '.' switch. */
function MemberInspector({ data, now, id, ui, onOpen }) {
  const member = (data?.members ?? []).find(m => m.id === id);
  const references = referenceIds(data);
  if (!member) return h('div', { className: 'tm-v3-empty' }, '这个成员不在投影里');
  const status = member.observed === 'unknown' ? '会话状态不明，root 正在处理'
    : member.desired === 'frozen' || member.observed === 'frozen' ? '已暂停，恢复需要 root 的操作'
    : member.desired === 'retired' || member.observed === 'retiring' ? '退役中，完成前不会接新任务'
    : member.activity?.kind === 'running' ? '正在工作' : '当前空闲';
  const next = member.observed === 'unknown' ? '下一步：等 root 确认会话已停止' : '下一步：root 按需分派任务';
  const group = (data.groups ?? []).find(item => item.id === member.group);
  // v3 §3.4 "最近 3 条": the committed lifecycle, in words; a step with no wording is dropped, never printed raw.
  const recent = (member.history ?? []).slice(-3).reverse()
    .map(step => step && typeof step === 'object' ? step.text : MEMBER_STEP_TEXT[step]).filter(Boolean).map(text => humanText(text, '相关对象', references));
  return h(Fragment, null,
    h('div', { className: 'tm-v3-ins-note', 'data-ins': 'status', 'data-sev': memberStatus(member).sev },
      h('b', null, status), h('div', { className: 'tm-fg3' }, next)),
    h('dl', { className: 'tm-kv' },
      h('dt', null, '在做'), h('dd', { 'data-ins': 'doing' }, memberDoing(member, data)),
      h('dt', null, '任务'), h('dd', null, humanText((data.tasks ?? []).find(task => task.id === member.taskId)?.title, '没有进行中的任务', references)),
      h('dt', null, '所在组'), h('dd', null, humanText(group?.label ?? member.group, UNKNOWN, references)),
      member.workspace ? h('dt', null, '工作区') : null,
      member.workspace ? h('dd', { className: 'num' }, typeof member.workspace === 'string' ? member.workspace
        : member.workspace.relPath ?? member.workspace.resolved ?? member.workspace.base ?? UNKNOWN) : null,
      recent.length ? h('dt', null, '最近') : null,
      recent.length ? h('dd', null, recent.join(' → ')) : null),
    h(MemberDetail, { data, now, id, onOpen, v3: true }),
    h(RuntimeStates, { data, now }),
    h('details', { className: 'tm-disclose', 'data-ins': 'technical', open: ui?.details ? true : undefined },
      h('summary', null, '技术细节'),
      h('dl', { className: 'tm-kv' },
        h('dt', null, '任务原文'), h('dd', null, (data.tasks ?? []).find(task => task.id === member.taskId)?.title ?? UNKNOWN),
        h('dt', null, '成员 id'), h('dd', { className: 'num', 'data-tech': 'id' }, member.id),
        h('dt', null, 'desired / observed'), h('dd', { className: 'num' }, member.desired + ' / ' + member.observed),
        h('dt', null, 'generation'), h('dd', { className: 'num' }, String(member.generation)),
        h('dt', null, 'revision'), h('dd', { className: 'num' }, String(member.revision)),
        h('dt', null, '原生会话'), h('dd', { className: 'num' }, member.nativeRef ?? UNKNOWN))),
    h(MemberActions, { data, now, id, onOpen }));
}

function Inspector({ data, now, ui, onOpen }) {
  const ins = ui?.inspector;
  if (!ins) return null;
  const close = () => TEAM.ui.closeInspector();
  // v3 §3.4: the rail is titled with the object a person selected, not with the word "detail".
  const selected = ins.kind === 'member' ? (data?.members ?? []).find(m => m.id === ins.id) : null;
  const title = ins.kind === 'member' ? humanText(selected?.name, '成员详情', referenceIds(data))
    : ins.kind === 'capacity' ? '安全详情' : recordPresentation(data, ins.event ?? { id: ins.id }).title;
  let body;
  if (ins.kind === 'member') body = h(MemberInspector, { data, now, id: ins.id, ui, onOpen });
  else if (ins.kind === 'capacity') body = h(CapacityDetail, { data, now, id: ins.id });
  else body = h(RecordDetail, { data, now, event: ins.event ?? null, id: ins.id, ui });
  return h('aside', { className: 'tm-v3-ins', 'data-inspector': ins.kind, 'aria-label': title },
    h('div', { className: 'tm-v3-ins-head' }, h('h3', null, title),
      h('button', { className: 'tm-btn tm-v3-close', type: 'button', 'aria-label': '收起详情', onClick: close }, '✕')),
    body);
}

function ThreadView({ data, now, id }) {
  // P5: resource threads live in their own collection; filter defensively so an older/mixed server cannot feed one
  // into requiredRespondents/replies.
  const decisions = data.threads.filter(thread => thread.kind !== 'resource');
  const open = decisions.filter(t => !['closed', 'cancelled', 'superseded'].includes(t.state));
  const t = decisions.find(x => x.id === id) ?? open[0] ?? decisions[0];
  if (!t) return h('div', { className: 'tm-empty' }, '该任务没有决策线程');
  const sev = t.state === 'escalated' ? 'bad' : ['collecting', 'open', 'deciding'].includes(t.state)
    ? hasDeadline(t.deadline) ? deadlineSeverity(t.openedAt, t.deadline, now) : 'wait' : THREAD_SEV[t.state];
  const elapsed = hasDeadline(t.deadline) ? Math.min(1, Math.max(0, (now - t.openedAt) / Math.max(1, t.deadline - t.openedAt))) : 0;
  const cmd = commandFor('decide', t, data);
  const escalateWhy = unsupportedReason('threads.escalate');
  const readOnly = readOnlyViewer(data);
  const num = t.id.replace('thr-', '');
  return h(Fragment, null,
    h('ul', { className: 'tm-list' }, decisions.map(x => h('li', { key: x.id }, h('button', { className: 'tm-li', 'aria-current': String(x.id === t.id), onClick: () => TEAM.ui.openDetail('thread', x.id) },
      h(Glyph, { sev: x.state === 'escalated' ? 'bad' : THREAD_SEV[x.state] }), h('span', { className: 'num tm-fg3' }, `#${x.id.replace('thr-', '')}`),
      h('span', { className: 'tm-grow' }, x.question), h('span', { className: 'num tm-fg3' },
        ['decided', 'closed'].includes(x.state) ? x.state : hasDeadline(x.deadline) ? relTime(x.deadline - now) : '无截止时间'))))),
    h('hr', { className: 'tm-hr' }),
    h('div', { className: 'tm-card-head' }, h('h3', null, `决策 #${num}`), h('span', { style: { flex: 1 } }),
      h('span', { className: 'tm-badge', 'data-sev': sev }, h(Glyph, { sev }), `state: ${t.state}`)),
    h('div', { style: { fontSize: 14, fontWeight: 500 } }, t.question),
    h('dl', { className: 'tm-kv' },
      h('dt', null, 'owner'), h('dd', null, kname(t.owner), h('span', { className: 'tm-fg3' }, ` · 升级责任人 ${kname(t.escalationOwner)}`)),
      // A thread committed without a deadline has 0 here, not "long ago": saying 无截止时间 is the fact.
      h('dt', null, 'deadline'), h('dd', { 'data-sev': hasDeadline(t.deadline) ? sev : undefined }, h('span', { className: 'num', title: hasDeadline(t.deadline) ? utc(t.deadline) : '无截止时间' }, hasDeadline(t.deadline) ? clock(t.deadline) : '—'),
        h('span', { className: 'tm-sevtext num' }, hasDeadline(t.deadline) ? ` · ${t.deadline > now ? '剩余 ' : ''}${relTime(t.deadline - now)}` : ' · 无截止时间'),
        ['decided', 'closed'].includes(t.state) ? null : h('div', { className: 'tm-dl-bar', 'data-sev': sev }, h('i', { style: { width: `${elapsed * 100}%` } }))),
      h('dt', null, '提案'), h('dd', null, h('span', { className: 'num' }, `rev ${t.proposalRevision}`), t.supersededRevisions.length ? h('span', { className: 'tm-fg3' }, `（rev ${t.supersededRevisions.join(',')} 已被取代）`) : null,
        t.decisionRevision ? h('span', null, ` · 决定 rev ${t.decisionRevision}`) : null),
      h('dt', null, '必答人'), h('dd', null, h('div', { className: 'tm-resp' }, t.requiredRespondents.map(r => {
        const ok = r.revision === t.proposalRevision;
        return h('span', { key: r.member, className: 'tm-badge', 'data-sev': ok ? 'ok' : r.revision ? 'warn' : 'wait', title: ok ? `已就 rev ${r.revision} 答复` : r.revision ? `答复针对旧 rev ${r.revision}` : '未答' },
          ok ? '✓' : '◔', ` ${kname(r.member)}`, h('span', { className: 'num' }, r.revision ? ` rev${r.revision}` : ' 未答'));
      }))),
      h('dt', null, '答复'), h('dd', null, t.replies.length ? t.replies.map((r, i) => h('div', { key: i, className: 'tm-reply' },
        h('div', { className: 'tm-quote-src' }, `来自成员 ${kname(r.member)} · rev ${r.revision}（成员原话，仅作证据）`), h('q', null, r.text), r.artifact ? h('span', { className: 'num tm-fg3' }, ` ▸ ${r.artifact}`) : null)) : h('span', { className: 'tm-cap' }, '暂无')),
      h('dt', null, '晚到证据'), h('dd', null, t.lateEvidence.length ? t.lateEvidence.map((e, i) => h('div', { key: i, className: 'tm-reply' }, h('div', { className: 'tm-quote-src' }, kname(e.member)), e.text)) : h('span', { className: 'tm-cap' }, '（无）')),
      h('dt', null, '被影响任务'), h('dd', null, t.affectedTasks.map(id2 => { const tk = data.tasks.find(x => x.id === id2);
        return h('button', { key: id2, className: 'tm-link', style: { marginRight: 8 }, onClick: () => TEAM.ui.openDetail('task', id2) }, `${id2}${tk ? ` (${tk.state})` : ''}`); }))),
    h('hr', { className: 'tm-hr' }),
    ['decided', 'closed', 'cancelled', 'superseded'].includes(t.state) ? h('div', { className: 'tm-note' }, '已决定：修改结论会创建新的 decisionRevision，并通知受影响任务重新授权。') :
      readOnly ? h('div', { className: 'tm-note', 'data-readonly': 'actions' }, '只读查看：决策与升级由组长处理。') :
      h(Fragment, null, h('div', { className: 'tm-actions' },
        cmd.hidden ? null : h('button', { className: 'tm-btn', disabled: !!cmd.disabledReason, title: cmd.disabledReason ?? undefined, onClick: () => TEAM.ui.openPalette(cmd) }, '以 owner 身份决定…'),
        h(CmdButton, { cmd: commandFor('escalate', t, data), label: '升级 / 转交…' })),
      h('div', { className: 'tm-note' }, cmd.disabledReason ?? `→ threads.decide(${t.id}, expectedRevision=${t.revision}, proposalRevision=${t.proposalRevision}, conclusionRef)`),
      h('div', { className: 'tm-note' }, escalateWhy ?? `→ threads.escalate(${t.id}, expectedRevision=${t.revision}, reason)`)));
}
const RESOURCE_ACTION_LABEL = { subscribeResource: '订阅…', unsubscribeResource: '退订…',
  publishResource: '发布报告…', closeResource: '关闭资源线程…' };
function resourceKeyText(resource) {
  const key = resource?.key;
  if (key && typeof key === 'object') return [key.provider, key.repository, key.number == null ? null : '#' + key.number].filter(Boolean).join('/');
  return String(key ?? '');
}
function resourceLabel(thread) {
  return (thread.resource?.kind ?? 'resource') + ' · ' + truncate(resourceKeyText(thread.resource), 48);
}
/**
 * P5: resource threads are shown beside decision threads, never inside them. The panel renders only the actions this
 * viewer may take (v3 §1: no disabled permission buttons) and never creates a notification; the list is read on the
 * resource tab. Subscription/authorization is still the server's, this is only what the viewer can see.
 */
function ResourceView({ data, now, id }) {
  const threads = resourceThreadsOf(data);
  const selected = threads.find(thread => thread.id === id) ?? threads[0] ?? null;
  const list = threads.length ? h('ul', { className: 'tm-list' }, threads.map(thread => h('li', { key: thread.id },
    h('button', { className: 'tm-li', 'aria-current': String(thread.id === selected?.id), onClick: () => TEAM.ui.openDetail('resource', thread.id) },
      h(Glyph, { sev: thread.status === 'closed' ? 'frozen' : 'ok' }),
      h('span', { className: 'tm-grow' }, resourceLabel(thread)),
      h('span', { className: 'num tm-fg3' }, 'head ' + thread.head + (thread.pending ? ' · 待投递 ' + thread.pending : ''))))))
    : h('div', { className: 'tm-empty' }, '没有可见的资源线程');
  if (!selected) return list;
  const actions = resourceActions(data, selected, viewerOf());
  // §4 viewer 只读: resource writes are hidden outright, not shown as disabled buttons.
  const buttons = readOnlyViewer(data) ? [] : actions.map(kind => h(CmdButton, { key: kind, cmd: commandFor(kind, selected, data), label: RESOURCE_ACTION_LABEL[kind] }));
  return h(Fragment, null, list, h('hr', { className: 'tm-hr' }),
    h('div', { className: 'tm-card-head' }, h('h3', null, '资源线程'), h('span', { style: { flex: 1 } }),
      h('span', { className: 'tm-badge' }, 'state: ' + selected.status)),
    h('div', { style: { fontSize: 14, fontWeight: 500 } }, resourceLabel(selected)),
    h('dl', { className: 'tm-kv' },
      h('dt', null, '资源'), h('dd', null, (selected.resource?.kind ?? UNKNOWN) + ' · ' + (selected.resource?.repositoryKey ?? UNKNOWN) + ' · ' + resourceKeyText(selected.resource)),
      h('dt', null, 'owner'), h('dd', null, kname(selected.owner)),
      h('dt', null, 'head'), h('dd', null, h('span', { className: 'num' }, 'head ' + selected.head + ' · retainedFrom ' + selected.retainedFrom)),
      h('dt', null, '最后事件'), h('dd', null, selected.lastEvent
        ? h(Fragment, null, h('span', { className: 'num' }, '#' + selected.lastEvent.seq + ' ' + selected.lastEvent.eventType + ' · ' + clock(selected.lastEvent.occurredAt)),
          h('div', null, selected.lastEvent.summary))
        : h('span', { className: 'tm-cap' }, '（没有已提交事件）')),
      h('dt', null, '订阅'), h('dd', null, selected.subscribers?.length ? selected.subscribers.map(sub => h('div', { key: sub.memberId + ':' + sub.subscriptionEpoch },
        h('span', { className: 'tm-badge', 'data-sev': sub.state === 'active' ? 'ok' : 'frozen' }, sub.state), ' ', kname(sub.memberId),
        h('span', { className: 'num tm-fg3' }, ' gen' + sub.generation + '/epoch' + sub.subscriptionEpoch + ' · pending ' + sub.pending + ' · visibleThrough ' + (sub.visibleThrough ?? 0))))
        : h('span', { className: 'tm-cap' }, '（没有订阅）'))),
    h('hr', { className: 'tm-hr' }),
    buttons.length ? h('div', { className: 'tm-actions' }, buttons) : h('div', { className: 'tm-note' }, '没有你可执行的操作（只读查看）。'),
    h('div', { className: 'tm-note' }, '资源事件是观察/报告，不是写权限；订阅也不代表响应义务。'),
    h('div', { className: 'tm-note' }, '越权请求由服务端直接拒绝：不会转成任何人的待办，也不会自动通过。'));
}
function Receipts({ m }) {
  const r = m.receipts;
  const row = (name, rec, text) => [h('span', { key: name + 'n', className: 'tm-fg3' }, name), h('span', { key: name + 'd', className: 'tm-r-dot', 'data-on': String(!!rec) }),
    h('span', { key: name + 't', className: 'num' }, rec ? clock(rec.at) : '—'), h('span', { key: name + 'e', className: cx(!rec && 'tm-fg3'), style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, text)];
  return h('div', { className: 'tm-receipts' },
    row('stored', r.stored, r.stored?.evidence ?? ''),
    row('visible', r.visible, r.visible ? `req ${r.visible.requestId} · manifest ${shortId(r.visible.manifest)} · seq ${r.visible.seq}` : m.kind === 'info' ? '（info 不要求接责）' : '（尚未进入受观测请求）'),
    row('accepted', r.accepted, r.accepted ? `checkpoint ${r.accepted.checkpoint}` : m.kind === 'info' ? '' : '（等待 ackResponsibility）'));
}
function MessagesView({ data, now, ui }) {
  const f = ui.messageFilter;
  const sel = ui.selected;
  const viewer = viewerOf();
  const readOnly = readOnlyViewer(data);
  const cancelWhy = unsupportedReason('mailbox.cancelMessage');
  const terminal = x => ['resolved', 'cancelled', 'expired', 'dead-letter'].includes(x.lifecycle);
  let list = data.messages.filter(x => (!f.unaccepted || (!x.receipts.accepted && !terminal(x))) && (!f.actionable || x.kind !== 'info')
    && (!f.mine || !viewer || x.from === viewer || x.to === viewer) && (!f.member || !sel || x.from === sel || x.to === sel));
  const rank = x => terminal(x) ? 3 : x.receipts.accepted ? 2 : hasDeadline(x.deadline) && x.deadline <= now ? 0 : 1;
  list = list.sort((a, b) => rank(a) - rank(b) || (a.deadline ?? Infinity) - (b.deadline ?? Infinity)).slice(0, 60);
  const chip = (key, label) => h('button', { className: 'tm-chip', 'aria-pressed': !!f[key], onClick: () => TEAM.ui.setMessageFilter({ [key]: !f[key] }) }, label);
  return h(Fragment, null,
    h('div', { className: 'tm-filters' }, chip('unaccepted', '未接责'), chip('actionable', 'action + decision'), viewer ? chip('mine', '我相关') : null, sel ? chip('member', `成员 ${kname(sel)}`) : null),
    list.length === 0 ? h('div', { className: 'tm-empty' }, '没有消息') : list.map(m => {
      const overdue = hasDeadline(m.deadline) && m.deadline <= now && !m.receipts.accepted && !terminal(m);
      return h('article', { key: m.id, className: 'tm-msg', 'data-sev': overdue ? 'bad' : undefined },
        h('div', { className: 'tm-msg-head' }, h('span', { className: 'num', style: { fontWeight: 600 } }, m.id), h('span', null, `${kname(m.from)} → ${kname(m.to)}`),
          h('span', { className: 'tm-badge' }, m.kind), h('span', { style: { flex: 1 } }),
          hasDeadline(m.deadline) ? h('span', { className: 'num tm-sevtext', 'data-sev': overdue ? 'bad' : terminal(m) || m.receipts.accepted ? undefined : deadlineSeverity(m.openedAt, m.deadline, now) },
            terminal(m) || m.receipts.accepted ? `截止 ${clock(m.deadline)}` : `${relTime(m.deadline - now)}${overdue ? ' ■' : ''}`)
            : h('span', { className: 'num tm-fg3' }, '无截止时间')),
        h(Receipts, { m }),
        h('div', { className: 'tm-sub' }, `lifecycle: ${m.lifecycle}`, m.expectedOutcome ? ` · 期望结果：“${m.expectedOutcome}”` : '', m.lifecycle === 'resolved' ? ' · resolved ✓' : ''),
        m.delayReason ? h('div', { className: 'tm-sub' }, `延迟原因：${m.delayReason}`) : null,
        m.escalatedTo ? h('div', { className: 'tm-sub tm-sevtext', 'data-sev': 'warn' }, `→ 已由 scheduler 升级给 ${kname(m.escalatedTo.member)}（${clock(m.escalatedTo.at)}）`) : null,
        m.rebinds.length ? h('div', { className: 'tm-sub' }, `rebind ${m.rebinds.map(r => `gen${r.from}→gen${r.to}`).join(' · ')}（同一 messageId 保留旧投递轨迹）`) : null,
        // §4: a read-only viewer gets no write button at all (cancel/rebind used to render disabled).
        terminal(m) || readOnly ? null : h('div', { className: 'tm-actions' },
          h(CmdButton, { cmd: commandFor('cancelMessage', m, data), label: '取消…' }),
          h(CmdButton, { cmd: commandFor('rebind', m, data), label: '改投…' })));
    }),
    h('div', { className: 'tm-note' }, cancelWhy ?? '取消不撤销已经发生的副作用；改投只绑定新的责任人，旧投递轨迹保留。'),
    h('div', { className: 'tm-note' }, 'visible 只表示进入了受观测的模型请求，不等于“已读 / 已处理”。'));
}
function ContextView({ data, now, id }) {
  const m = memberById(data, id);
  const top = data.members.filter(contextKnown).sort((a, b) => b.context.pct - a.context.pct).slice(0, 6);
  const c = contextKnown(m) ? m.context : null;
  return h(Fragment, null,
    m ? h('div', { className: 'tm-card-head' }, h('h3', null, `上下文 · ${m.name}`)) : null,
    !m ? h('div', { className: 'tm-empty' }, '该成员受限或不存在')
      : !c ? h('div', { className: 'tm-alert', 'data-sev': 'unknown' }, h(Glyph, { sev: 'unknown' }), m.observed === 'retired' ? '成员已退役，无上下文'
        : `上下文${UNKNOWN}：${m.contextStatus?.reason ?? WHY.context}`)
        : h(Fragment, null,
          h(CtxBar, { context: c, member: m, big: true }),
          h('dl', { className: 'tm-kv' },
            h('dt', null, '占上限'), h('dd', { className: 'num' }, `${pctText(c.pct)} of 75% 硬上限（${c.inputTokens.toLocaleString()}${num(c.limitTokens) ? ` / ${Math.round(c.limitTokens).toLocaleString()}` : ''} tok · 窗口 ${c.window.toLocaleString()}）`),
            num(c.logRevision) ? h('dt', null, '来源') : null, num(c.logRevision) ? h('dd', { className: 'num' }, `已提交 context log rev ${c.logRevision}`) : null,
            h('dt', null, '75% 硬门'), h('dd', null, num(c.hardGateHits) ? h(Fragment, null, h('span', { className: cx('num', c.hardGateHits && 'tm-lease-bad') }, `命中 ${c.hardGateHits} 次`), c.hardGateHits ? ' · 已兜底压缩' : '') : counter(null)),
            h('dt', null, '第一层'), h('dd', null, num(c.truncRefs) ? `截断引用 ${c.truncRefs}（全文已存，可按引用召回）` : counter(null)),
            h('dt', null, '第二层'), h('dd', null, !c.fold ? counter(null) : c.fold.enabled ? `折叠 F${c.fold.count}` : h('span', { className: 'tm-fold-off' }, 'off（未启用）')),
            h('dt', null, '快照'), h('dd', { className: 'num' }, counter(c.snapshotTokens, v => `最新 team_snapshot ${v.toLocaleString()} / 4096 tok`))),
          c.fold?.last ? h('div', { className: 'tm-fold-rec' }, h('span', { className: 'tm-fg3' }, '最近折叠'), h('span', { className: 'num' }, clock(c.fold.last.at)),
            h('span', { className: 'tm-fg3' }, '遮蔽'), h('span', null, `${c.fold.last.masked} 个节点（sourceEventSeqs）`),
            h('span', { className: 'tm-fg3' }, '快照'), h('span', { className: 'num' }, `rev ${c.fold.last.revFrom} → ${c.fold.last.revTo}`)) : null),
    h('hr', { className: 'tm-hr' }),
    h('div', { className: 'tm-section-title' }, '离 75% 最近'),
    top.length ? h('ul', { className: 'tm-list' }, top.map(x => h('li', { key: x.id }, h('button', { className: 'tm-li', 'aria-current': String(x.id === id), onClick: () => { TEAM.ui.select(x.id); TEAM.ui.openDetail('context', x.id); } },
      h('span', { className: 'tm-grow' }, x.name), h(CtxBar, { context: x.context, member: x }))))) : h('div', { className: 'tm-empty', title: WHY.context }, `所有成员上下文${UNKNOWN}`)
  );
}


//#endregion
//#region src/ui/page.mjs
// M6 WP-4 (16 §3): the team page. Three subpages over one projection; the inspector is a right rail that only
// exists while something is selected. The page renders the projection's summary verbatim — it never re-derives it.
// ── page (main keyed "team") ─────────────────────────────
function useWidth(ref) {
  const [w, setW] = useState(1200);
  useEffect(() => { const el = ref.current; if (!el) return; const ro = new ResizeObserver(([e]) => setW(e.contentRect.width)); ro.observe(el); return () => ro.disconnect(); }, []);
  return w;
}
const PAGE_TABS = [['now', '现在'], ['members', '成员'], ['records', '记录']];
const ROLE_TEXT = role => VIEWER_ROLE_TEXT[role] ?? VIEWER_ROLE_TEXT.unknown;

function Header({ data, st, ui, now, fresh, mode }) {
  const readOnly = readOnlyViewer(data, st.viewer);
  const team = data.team ?? null;
  const goal = goalInfo(data.goal);
  const name = team?.name ?? (goal.known ? goal.title : '未命名团队');
  const stale = fresh.level === 'stale' || fresh.level === 'error' || fresh.level === 'lagging';
  return h('header', { className: 'tm-v3-top', 'data-mode': mode },
    h('h1', { className: 'tm-v3-team', title: team?.leaderSessionId ? '组长会话：' + team.leaderSessionId : '' }, name),
    h('nav', { className: 'tm-v3-tabs', role: 'tablist', 'aria-label': '团队视图' },
      PAGE_TABS.map(([key, label]) => h('button', { key, role: 'tab', type: 'button', className: cx('tm-v3-tab', ui.page === key && 'on'),
        'aria-selected': String(ui.page === key), 'data-tab': key, onClick: () => TEAM.ui.setPage(key) }, label))),
    h('span', { className: 'tm-spacer' }),
    readOnly ? h('span', { className: 'tm-v3-badge', 'data-readonly': 'viewer', title: '当前 viewer 不是 operator / root：只读查看，写操作不显示' }, '只读') : null,
    stale ? h('span', { className: 'tm-v3-badge', 'data-fresh': fresh.level, title: '最后业务事件 ' + clock(st.lastEventAt) }, '数据不新鲜') : null,
    h('button', { className: cx('tm-v3-details', ui.details && 'on'), type: 'button', 'aria-pressed': String(!!ui.details),
      title: '技术细节开关（.）', onClick: () => TEAM.ui.toggleDetails() }, '技术细节'));
}

function handleDetailsKey(e) {
  if (e.key !== '.' || e.defaultPrevented || e.repeat || isEditable(e.target) || e.metaKey || e.ctrlKey || e.altKey) return false;
  e.preventDefault(); TEAM.ui.toggleDetails(); return true;
}
function TeamPage(props = {}) {
  const st = useClient(), ui = useUi(), now = useNow();
  const ref = useRef(null);
  const width = useWidth(ref);
  const mode = width >= 1100 ? 'wide' : width > 760 ? 'mid' : 'narrow';
  const sessionId = props.sessionId ?? ui.frameSession ?? null;
  const scope = TEAM.scope;
  const pendingScope = scope && st.sessionId !== sessionId;
  const binding = pendingScope ? undefined : scope ? st.binding : 'bound';
  useEffect(() => { ref.current?.focus({ preventScroll: true }); TEAM.ui.enterContext('team'); }, []);
  useEffect(() => { scope?.switchSession(sessionId); }, [scope, sessionId]);
  useEffect(() => {
    // A timeline click can leave focus on body or move it into the drawer; the visible Team page owns one capture handler.
    const hotkey = e => {
      if (!ref.current?.isConnected || !ref.current.getClientRects().length) return;
      if (handleDetailsKey(e)) e.stopPropagation();
    };
    document.addEventListener('keydown', hotkey, true);
    return () => document.removeEventListener('keydown', hotkey, true);
  }, []);
  const onKeyDown = e => {
    if (isEditable(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (handleDetailsKey(e)) return;
    if (e.key === 'a') { e.preventDefault(); TEAM.ui.toast(ROLE_TEXT(st.data?.viewerRole ?? (st.viewer ? 'member' : 'unknown'))); return; }
    if (e.key === 'Escape') { TEAM.ui.closeInspector(); }
  };
  const data = binding == null || pendingScope ? null : st.data;
  let content;
  if (st.status === 'error' && !data) content = h('div', { className: 'tm-empty', role: 'alert' },
    '投影不可用：' + st.error,
    h('button', { className: 'tm-btn', type: 'button', onClick: () => TEAM.client.resync('manual') }, '重试'));
  else if (binding === undefined) content = h('div', { className: 'tm-empty' }, '正在确认这个会话属于哪个团队…');
  else if (binding === null && st.status !== 'error') content = h('div', { className: 'tm-v3-col' },
    h('div', { className: 'tm-v3-empty', 'data-empty': 'no-team' }, h('b', null, '这个会话没有团队'),
      h('div', { className: 'tm-fg3' }, '团队的成员、任务和记录会显示在这里；当前会话还没有绑定团队。')));
  else if (st.status === 'loading' || !data) content = h('div', { className: 'tm-empty', style: { padding: 24 } },
    '正在读取 Team 投影…');
  else {
    const fresh = freshness(st, now);
    const broken = st.status === 'error' || fresh.level === 'error';
    const page = ui.page === 'members' ? h(MembersPage, { data, now })
      : ui.page === 'records' ? h(RecordsPage, { data, now })
      : h(NowPage, { data, st, now });
    const inline = mode === 'wide' && ui.inspector;
    const drawer = mode !== 'wide' && ui.drawer === 'detail' && ui.inspector;
    const onOpen = id => TEAM.nav.openMember(id);
    content = h(Fragment, null,
      broken ? h('div', { className: 'tm-v3-broken', role: 'alert' }, h(Glyph, { sev: 'unknown' }),
        '连不上团队状态 · 上次更新 ' + clock(st.lastEventAt),
        h('span', { className: 'tm-spacer' }),
        h('button', { className: 'tm-btn', type: 'button', onClick: () => TEAM.client.resync('manual') }, '重试')) : null,
      h('div', { className: cx('tm-v3-body', inline && 'has-ins', broken && 'tm-stale-veil') },
        h('div', { className: 'tm-v3-main' }, page),
        inline ? h(Inspector, { data, now, ui, onOpen }) : null),
      // 16 §4: a phone gets a full-screen sheet with «← 返回» at the top; the mid layout keeps the 380px drawer.
      drawer ? (mode === 'narrow'
        ? h(DrawerTrap, null, h('section', { className: 'tm-v3-sheet', role: 'dialog', 'aria-modal': 'true',
          'aria-label': '详情' },
        h('div', { className: 'tm-v3-sheet-top' },
          h('button', { className: 'tm-v3-back', type: 'button', onClick: () => TEAM.ui.closeInspector() }, '← 返回')),
        h('div', { className: 'tm-v3-sheet-body' }, h(Inspector, { data, now, ui: { ...ui, drawer: null }, onOpen }))))
        : h(Fragment, null, h('div', { className: 'tm-scrim', onClick: () => TEAM.ui.setDrawer(null) }),
          h(DrawerTrap, null, h(Inspector, { data, now, ui, onOpen })))) : null);
  }
  return h('div', { className: 'tm tm-page tm-v3', ref, tabIndex: -1, onKeyDown, 'data-mode': mode, 'aria-label': 'Team' },
    data ? h(Header, { data, st, ui, now, fresh: freshness(st, now), mode }) : null,
    h('div', { key: st.teamId ?? 'unbound', style: { display: 'contents' } }, content),
    ui.toast ? h('div', { className: 'tm-v3-toast', role: 'status' }, ui.toast.text) : null,
    data ? h(CommandPalette) : null);
}
/** Focus trap for drawers: Tab stays inside; Esc closes and returns focus (09 §5.6). */
function DrawerTrap({ children }) {
  const ref = useRef(null);
  useEffect(() => { const prev = document.activeElement; ref.current?.querySelector('button')?.focus(); return () => prev?.focus?.(); }, []);
  const onKeyDown = e => {
    if (e.key === 'Escape') { e.stopPropagation(); TEAM.ui.closeInspector(); return; }
    if (e.key !== 'Tab') return;
    const nodes = [...ref.current.querySelectorAll('button,input,select,textarea')].filter(n => !n.disabled);
    if (!nodes.length) return;
    if (e.shiftKey && document.activeElement === nodes[0]) { e.preventDefault(); nodes[nodes.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === nodes[nodes.length - 1]) { e.preventDefault(); nodes[0].focus(); }
  };
  return h('div', { ref, onKeyDown, style: { display: 'contents' } }, children);
}

//#endregion
//#region src/ui/frames.mjs
// Split of the former src/ui.mjs (M6 WP-3): frames. Pure move, no behaviour change.
function scopedSessionMember(data, sessionId, ui, state) {
  if (TEAM.scope && (state.sessionId !== sessionId || !state.binding)) return null;
  return sessionMember(data, sessionId, ui) ?? (TEAM.scope && state.binding?.memberId
    ? memberById(data, state.binding.memberId) : null);
}
// ── left roster (sidebar.body.wrapper, C2-a/b) ───────────
function RosterWrapper({ collapsed, children }) {
  const ui = useUi(), st = useClient(), now = useNow();
  const orderRef = useRef(null);
  if (!orderRef.current) orderRef.current = new StableOrder();
  if (TEAM.scope && (!st.binding || !st.data)) return children;
  if (collapsed) return children; // collapsed rail: native behaviour
  const data = st.data;
  const tab = ui.sidebarTab;
  const groups = data ? groupRows(data, now, orderRef.current) : [];
  const c = data ? counts(data, now, st.viewer) : null;
  const current = ui.viewing ?? ui.selected;
  return h('div', { className: 'tm tm-roster-wrap' },
    h('div', { className: 'tm-seg', role: 'tablist', 'aria-label': '侧栏内容' },
      h('button', { role: 'tab', 'aria-selected': String(tab === 'team'), onClick: () => TEAM.ui.setSidebarTab('team') }, '团队', data ? h('span', { className: 'num tm-fg3' }, data.members.length) : null),
      h('button', { role: 'tab', 'aria-selected': String(tab === 'workspaces'), onClick: () => TEAM.ui.setSidebarTab('workspaces') }, '工作区')),
    h('div', { style: { display: tab === 'workspaces' ? 'contents' : 'none' } }, children),
    tab === 'team' ? h('nav', { className: 'tm-roster', 'aria-label': '团队花名册' },
      !data ? h('div', { className: 'tm-empty' }, st.status === 'error' ? '投影不可用' : '正在读取…') : h(Fragment, null,
        h('div', { className: 'tm-roster-top' },
          h('button', { className: 'tm-btn', onClick: () => TEAM.nav.showTeam(), title: 'Team 总览（g t）' }, '总览'),
          c.needsYou ? h('span', { className: 'tm-badge', 'data-sev': 'bad' }, `需要你 ${c.needsYou}`) : null,
          c.blocked ? h('span', { className: 'tm-badge', 'data-sev': 'bad' }, `■ ${c.blocked}`) : null,
          c.unknown ? h('span', { className: 'tm-badge', 'data-sev': 'unknown' }, `? ${c.unknown}`) : null),
        data.members.length === 0 ? h('div', { className: 'tm-empty' }, '还没有成员') : null,
        groups.map(g => {
          const col = isCollapsed(ui, g, data.members.length);
          return h('div', { key: g.group.id, role: 'group', 'aria-label': g.group.label },
            g.headless ? null : h('button', { className: 'tm-rgroup', 'aria-expanded': String(!col), onClick: () => TEAM.ui.setGroup(g.group.id, !col) },
              h('span', { className: 'tm-caret' }, '▾'), h('span', { className: 'tm-grow' }, g.group.label, g.group.lead ? h('span', { className: 'tm-fg3', style: { fontWeight: 400 } }, `  ${memberName(data, g.group.lead)}`) : null),
              h(Tally, { tally: g.tally })),
            col ? null : g.rows.map(r => {
              const m = r.member, pct = contextKnown(m) ? Math.round(m.context.pct) : null;
              return h('button', { key: m.id, className: 'tm-rrow', 'data-sev': r.severity, 'aria-current': String(current === m.id), onClick: () => TEAM.nav.openMember(m.id),
                style: g.headless ? { paddingLeft: 8 } : undefined, title: `${m.name} · ${m.id} · ${ROLE_LABEL[m.role] ?? m.role} · ${SEVERITY[r.severity].label}` },
              h(Glyph, { sev: r.severity }), h('span', { className: 'tm-grow' }, m.name), h('span', { className: 'tm-role' }, ROLE_ABBR[m.role]),
              h('span', { className: 'num', 'data-level': pct == null ? undefined : ctxLevel(pct), title: pct == null && m.observed !== 'retired' ? `上下文${UNKNOWN}` : '占上限（75% 窗口）的百分比' }, pct == null ? '—' : `${pct}%`));
            }));
        }),
        data.restrictedMembers ? h('div', { className: 'tm-roster-top' }, `受限成员 ×${data.restrictedMembers}`) : null,
        h('div', { className: 'tm-roster-top' }, h('span', { className: 'tm-badge tm-mock', title: st.viewer ? `viewer ${st.viewer}` : '未取得 viewer 身份' },
          st.sourceKind === 'mock' ? TEAM.source?.describe().label ?? '' : `投影 · ${TEAM.source?.describe().label ?? ''}`)))) : null);
}

// ── conversation frame (main.conversation.frame, C2-c/d) ─
function MemberFrame({ children, sessionId }) {
  const ui = useUi(), st = useClient(), now = useNow();
  // `sessionId` is the conversation's current Session (session-maybe standard prop). Session changes decide whether
  // this is a Team session (owned by a member) and drive the left-tab edge switch; see store.syncFrame.
  const members = st.data?.members ?? null;
  useEffect(() => { TEAM.ui.syncFrame(sessionId ?? null, members); }, [sessionId, members, ui.viewing]);
  useEffect(() => { TEAM.scope?.switchSession(sessionId ?? null); }, [sessionId]);
  // The very first render must use this session, not a selection from the previous render's effect.
  if (TEAM.scope && (st.sessionId !== (sessionId ?? null) || !st.binding)) return children;
  const data = st.data;
  const m = scopedSessionMember(data, sessionId, ui, st);
  if (!m) return children;
  const isRoot = m?.role === 'root';
  // §4: a read-only viewer gets no mailbox write here either, in the strip or on the frame bar.
  const readOnly = readOnlyViewer(data, st.viewer);
  const sev = m ? memberSeverity(m, { now, messages: data.messages }) : 'unknown';
  const task = m && data.tasks.find(t => t.id === m.taskId);
  const bound = m && TEAM.nav.hasNative(m);
  return h('div', { className: 'tm tm-frame', 'data-readonly': String(!isRoot) },
    h('div', { className: 'tm-strip', role: 'region', 'aria-label': 'Team 会话条带' },
      isRoot ? h('span', { className: 'tm-pill' }, 'Team · root') : h('button', { className: 'tm-btn', onClick: () => TEAM.nav.openRoot(), title: '回到 root（g r）' }, '◀ root'),
      h('span', { className: 'tm-sep' }),
      m ? h(Fragment, null,
        h('span', { className: 'tm-strip-who' }, h(Glyph, { sev }), h('strong', null, m.name), h('span', { className: 'tm-role' }, ROLE_ABBR[m.role])),
        h('span', { className: 'tm-strip-task' }, task ? `${task.id} ${task.state}` : m.role === 'root' ? '主会话' : '—',
          m.wait ? h('span', { className: 'tm-sevtext num', 'data-sev': deadlineSeverity(m.wait.openedAt, m.wait.deadline, now) }, `  ⇢ ${m.wait.memberRef ? memberName(data, m.wait.memberRef) : m.wait.label} (${relTime(m.wait.deadline - now)})`) : null),
        h('span', { className: 'tm-sep tm-strip-hide' }),
        h('span', { className: 'tm-strip-hide' }, h(CtxBar, { context: m.context, member: m })))
        : h('span', { className: 'tm-sevtext', 'data-sev': 'unknown' }, '? 绑定未知'),
      h('span', { className: 'tm-spacer' }),
      h('span', { className: 'tm-pill' }, isRoot ? '可输入（主入口）' : '只读查看'),
      !readOnly && !isRoot && m ? h(CmdButton, { cmd: commandFor('send', m, data), label: '发话…' }) : null,
      m ? h('button', { className: 'tm-btn', onClick: () => { TEAM.ui.openDetail('member', m.id); if (TEAM.nav.hasPane?.()) TEAM.nav.openPane(); else TEAM.ui.setDrawer(ui.drawer === 'frame' ? null : 'frame'); }, 'aria-pressed': ui.drawer === 'frame' }, '详情') : null,
      h('button', { className: 'tm-btn tm-strip-hide', onClick: () => TEAM.nav.showTeam(), title: 'Team 总览（g t）' }, '总览'),
      h('button', { className: 'tm-btn tm-btn-ghost', onClick: () => TEAM.nav.leaveTeamView(), title: '退出 Team 视图', 'aria-label': '退出 Team 视图' }, '✕')),
    m && !bound ? h('div', { className: 'tm-frame-note' }, `${st.sourceKind === 'mock' ? '模拟投影：' : ''}${m.name} 的原生会话 ${m.nativeRef ?? '（投影未给出绑定）'} 不在本机会话列表，下方是当前原生会话视图（原生组件未改动）。`) : null,
    h('div', { className: 'tm-frame-body' }, children),
    !isRoot && m ? h('div', { className: 'tm-readonly-bar', role: 'note' }, h('span', null, '成员会话只读 · 向 ', h('strong', null, m.name), ' 发话走 mailbox（带 deadline 与接责）'),
      h('span', { className: 'tm-spacer' }), readOnly ? null : h(CmdButton, { cmd: commandFor('send', m, data), label: '发送 action / decision…' })) : null,
    ui.drawer === 'frame' && m ? h(Fragment, null, h('div', { className: 'tm-scrim', onClick: () => TEAM.ui.setDrawer(null) }),
      h(DrawerTrap, null, h(Detail, { data, now, ui: { ...ui, drawer: 'detail' }, onOpen: id => TEAM.nav.openMember(id), className: 'tm-drawer' }))) : null,
    h(CommandPalette));
}

// ── right sidebar L2 tab (sidebar.right.pane.tab, 09 §2.1/§4.1) ─────
/**
 * The native right sidebar's "Team 详情" tab. It follows the on-screen session: in a member's session it opens on that
 * member (09 §2.2 "默认停在成员"); elsewhere it shows the Team selection with a note. Same L2 cards as the overview.
 */
function TeamPaneTab({ sessionId }) {
  const st = useClient(), ui = useUi(), now = useNow();
  const data = TEAM.scope && (st.sessionId !== sessionId || !st.binding) ? null : st.data;
  const owner = scopedSessionMember(data, sessionId, ui, st);
  useEffect(() => { if (owner) TEAM.ui.set(s => ({ selected: owner.id, detail: { tab: s.detail.tab === 'task' ? 'task' : 'member', id: s.detail.tab === 'task' ? owner.taskId ?? null : owner.id } })); }, [owner?.id]);
  if (!data) return h('div', { className: 'tm tm-pane' }, h('div', { className: 'tm-empty', style: { padding: 16 } }, st.status === 'error' ? `投影不可用：${st.error}` : '正在读取 Team 投影…'));
  const fallback = owner?.id ?? ui.selected ?? rootMember(data)?.id;
  const paneUi = { ...ui, drawer: null, detail: { tab: ui.detail.tab, id: ui.detail.id ?? (ui.detail.tab === 'member' || ui.detail.tab === 'context' ? fallback : null) } };
  return h('div', { className: 'tm tm-pane', 'data-team-pane': owner?.id ?? 'none' },
    owner ? null : h('div', { className: 'tm-note tm-pane-note' }, '当前会话不属于 Team 成员；下面是 Team 中选中的对象。'),
    h(Detail, { data, now, ui: paneUi, onOpen: id => TEAM.nav.openMember(id), className: 'tm-pane-detail' }),
    // The conversation frame owns the palette while a Team view is on screen; otherwise this tab does.
    ui.viewing ? null : h(CommandPalette));
}
function TeamPaneTitle({ sessionId }) {
  const st = useClient(), ui = useUi();
  const owner = scopedSessionMember(st.data, sessionId, ui, st);
  return h(Fragment, null, h(TeamIcon, { size: 14 }), owner ? ` Team · ${truncate(owner.name, 16)}` : ' Team 详情');
}

// ── session-header mini strip (conversation.session.header.actions, 09 §2.1 L0 mini / §3.2 会话头部条) ──
/** Compact Team status beside a member session's title: role, status, unread (未接责) and pending approvals. Non-Team sessions: nothing. */
function SessionMini({ sessionId, teamSessionId }) {
  const st = useClient(), ui = useUi(), now = useNow();
  const sid = sessionId ?? teamSessionId;
  const data = st.data;
  const m = scopedSessionMember(data, sid, ui, st);
  if (!m) {
    // Binding is only "unknown" for a session this tab is showing as a Team view while the projection is unavailable.
    if (!data && ui.viewing && ui.frameSession === sid) return h('span', { className: 'tm tm-mini', 'data-team-mini': 'unknown', title: '投影不可用，无法确认绑定' }, h(Glyph, { sev: 'unknown' }), '绑定未知');
    return null;
  }
  const sev = memberSeverity(m, { now, messages: data.messages });
  const s = miniStatus(data, m);
  const stSev = s.status == null ? 'unknown' : s.mismatch ? 'warn' : undefined;
  return h('button', { className: 'tm tm-mini', 'data-team-mini': m.id, 'data-sev': sev, onClick: () => { TEAM.ui.openDetail('member', m.id); TEAM.nav.openPane?.(); },
    title: `Team 成员 ${m.name}（${m.id}）· ${ROLE_LABEL[m.role] ?? m.role} · desired ${m.desired ?? '?'} / observed ${m.observed ?? '?'} · 未接责 ${s.unread} · 待批 ${s.pending ?? UNKNOWN}${s.ctxPct == null ? ' · 上下文未知' : ` · 上下文 ${s.ctxPct}% 上限`}（点击打开右栏详情）` },
    h(Glyph, { sev }), h('span', { className: 'tm-role' }, s.abbr), h('span', { className: 'tm-mini-name' }, truncate(m.name, 16)),
    h('span', { className: 'tm-mini-st tm-sevtext', 'data-sev': stSev }, s.status ?? '?', s.mismatch ? ` ▲→${s.mismatch}` : ''),
    h('span', { className: 'tm-mini-sep' }),
    h('span', { className: 'num', 'data-mini': 'unread', 'data-sev': s.unread ? 'warn' : undefined }, `未接 ${s.unread}`),
    h('span', { className: 'num', 'data-mini': 'pending', 'data-sev': s.pending == null ? 'unknown' : s.pending ? 'warn' : undefined }, `待批 ${s.pending ?? '?'}`));
}

function TeamIcon({ size = 16 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('circle', { cx: 12, cy: 7, r: 3 }), h('circle', { cx: 5, cy: 10, r: 2.2 }), h('circle', { cx: 19, cy: 10, r: 2.2 }),
    h('path', { d: 'M6.5 20c0-3.3 2.5-6 5.5-6s5.5 2.7 5.5 6' }), h('path', { d: 'M1.5 19c0-2.2 1.5-4 3.5-4.2M22.5 19c0-2.2-1.5-4-3.5-4.2' }));
}

//#endregion
//#region src/ui.mjs
// The team UI surface. Every component moved to src/ui/* in M6 WP-3; this file keeps the import path and
// exports the exact set it exported before the split (the bundler in build.mjs strips these re-exports).

//#endregion
//#region src/plugin.mjs
// Browser entry: registers Team surfaces on existing slots + the two optional C2 seats.
/* global React */

const PANEL_ID = 'team';
/** Right-sidebar tab type (09 §4.1 sidebar.right.pane.tab): `id` keys the body/title seats, `kind` is what openTab names. */
const PANE_TAB = Object.freeze({ id: '@dsh-v2/client-team/detail', kind: 'teamDetail', priority: 'extension', title: () => 'Team 详情' });
/** Services this browser plugin needs from the DSH client context. */
const inject = ['slots', 'layout', 'uiWorkspace', 'sessions'];

/**
 * Runtime source/gateway injection point. `config` comes from `globalThis.__DSH_TEAM__`, which the host half
 * (index.mjs) publishes into the natively-authenticated index page only when the team profile configures
 * `source: 'http'`. No config → mock source (stage-1 behaviour). Returns `{source, gateway, control}`.
 * @param {import('./projection.mjs').TeamSourceConfig} config
 */
function createTeamSource(config, binding = null) {
  if (config.source === 'http') return createRealSource({ ...config, teamId: binding?.teamId ?? null, retryMs: 500 });
  // The native shell removes its login query with replaceState before loading plugins; navigation keeps the original URL.
  const entry = globalThis.performance?.getEntriesByType?.('navigation')?.[0]?.name;
  const original = new URLSearchParams(entry ? new URL(entry).search : '');
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  for (const key of ['teamFixture', 'teamViewer']) if (!params.has(key) && original.has(key)) params.set(key, original.get(key));
  return createMockSource({ ...config, fixture: params.get('teamFixture') ?? config.fixture,
    viewer: params.get('teamViewer') ?? config.viewer });
}

/** @param ctx - DSH client Context. */
function apply(ctx) {
  let config;
  try { config = resolveTeamConfig(globalThis[TEAM_CONFIG_GLOBAL]); } catch (error) {
    // A malformed real-source config must not silently fall back to mock data.
    console.error(error); config = { source: 'http', base: 'invalid:', token: '', viewer: null };
  }
  const ui = createUiStore(globalThis.localStorage, globalThis.sessionStorage);
  const client = new TeamScope({ ui, createSource: binding => createTeamSource(config, binding),
    install: picked => Object.assign(TEAM, { source: picked?.source ?? null, gateway: picked?.gateway ?? null, control: picked?.control ?? null }) });
  Object.assign(TEAM, { client, scope: client, ui, source: null, gateway: null, control: null });
  if (typeof window !== 'undefined') window.__dshTeam = { client, get control() { return TEAM.control; }, ui, source: config.source };

  let pane = null; // ctx.sidebarRight once available (optional service)
  const knownSession = ref => {
    if (!ref) return false;
    try {
      // SessionListState (dsh-api-session-controller): { ids: SessionId[], byId: Record<SessionId, SessionSummary>, ... }.
      const list = ctx.sessions?.list?.getSnapshot?.();
      return !!(list?.ids?.includes(ref) || (list?.byId && Object.hasOwn(list.byId, ref)));
    } catch { return false; }
  };
  TEAM.nav = {
    showTeam: () => ctx.layout.selectPanel(PANEL_ID),
    hasNative: m => m.role === 'root' || knownSession(m.nativeRef),
    /** Root is found by role in the projection (authoritative id is member:*). */
    openRoot: () => { const root = rootMember(client.getSnapshot().data); if (root) TEAM.nav.openMember(root.id); else ctx.layout.selectPanel(null); },
    /** Switch the centre to a member's native session. Never creates agents or starts turns (09 §5.2). */
    openMember(id) {
      const data = client.getSnapshot().data;
      const m = data?.members.find(x => x.id === id);
      TEAM.ui.set({ viewing: id, selected: id, drawer: null });
      if (m && m.role !== 'root' && knownSession(m.nativeRef)) ctx.uiWorkspace.openSession(m.nativeRef);
      ctx.layout.selectPanel(null);
    },
    leaveTeamView: () => TEAM.ui.set({ viewing: null, drawer: null }),
    /** Open an EXISTING native session (never creates one, never starts a turn); used by acceptance capture. */
    openKnownSession: ref => { if (!knownSession(ref)) return false; ctx.uiWorkspace.openSession(ref); return true; },
    hasPane: () => pane != null,
    /** Reveal the native right sidebar on the Team L2 tab (falls back to the frame drawer when the sidebar service is absent). */
    openPane: () => { if (pane) pane.openTab(PANE_TAB.kind); else TEAM.ui.setDrawer('frame'); },
  };
  if (typeof window !== 'undefined') window.__dshTeam.nav = TEAM.nav;

  const style = document.createElement('style');
  style.id = 'dsh-v2-team-ui';
  style.textContent = CSS;
  document.head.appendChild(style);
  ctx.effect(() => () => style.remove(), 'client-team: styles');
  ctx.effect(() => { client.start(); return () => client.stop(); }, 'client-team: projection');

  // g t / g r chords; ignored inside editable fields and when a modifier is held.
  ctx.effect(() => {
    let armed = 0;
    const onKey = e => {
      const t = e.target;
      if (e.metaKey || e.ctrlKey || e.altKey || (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) return;
      if (e.key === 'g') { armed = Date.now(); return; }
      if (Date.now() - armed > 900) return;
      armed = 0;
      if (e.key === 't') { e.preventDefault(); TEAM.nav.showTeam(); }
      else if (e.key === 'r') { e.preventDefault(); TEAM.nav.openRoot(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, 'client-team: chords');

  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, TeamPage));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 5, label: () => 'Team' }, TeamIcon));
  // C2 seats: only declared on the patched build; on an unpatched build these waits never fire (graceful).
  ctx.slots.inject('sidebar.body.wrapper', () => ctx.slots.register({ name: 'sidebar.body.wrapper' }, RosterWrapper));
  ctx.slots.inject('main.conversation.frame', () => ctx.slots.register({ name: 'main.conversation.frame' }, MemberFrame));

  // L0 mini strip beside the session title (09 §2.1). A list seat: renders null for non-Team sessions, and with the
  // plugin unregistered (default profile) the native header is untouched.
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: 'team-mini', order: 50,
    inject: sessionId => ({ teamSessionId: sessionId }) }, SessionMini));

  // L2 detail in the native right sidebar (09 §4.1). Optional services: without them the frame keeps its drawer.
  ctx.inject(['slots', 'sidebarRight', 'sidebarRightTabs'], sub => {
    pane = sub.sidebarRight;
    sub.effect(() => () => { pane = null; }, 'client-team: pane service');
    sub.effect(() => sub.sidebarRightTabs.register(PANE_TAB), 'client-team: pane tab type');
    sub.slots.inject('sidebar.right.pane.tab', () => sub.slots.register({ name: 'sidebar.right.pane.tab', key: PANE_TAB.id }, TeamPaneTab));
    sub.slots.inject('sidebar.right.pane.tab.title', () => sub.slots.register({ name: 'sidebar.right.pane.tab.title', key: PANE_TAB.id }, TeamPaneTitle));
  });
}

//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
