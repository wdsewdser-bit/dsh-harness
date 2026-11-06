// Pure presentation derivations over a projection snapshot (09 §2.3–2.5). No business inference:
// every value shown comes from a projection field; this only classifies and orders for display.

/** Display bucket for members whose group the projection does not describe (no invented group data). */
export const NO_GROUP = '__ungrouped';
export const groupKey = group => group ?? NO_GROUP;
/** The root member is found by role, never by a hard-coded id (ids are authoritative `member:*`). */
export const rootMember = data => data?.members.find(m => m.role === 'root') ?? null;
/** Display name for an authoritative member id; unknown/restricted ids are shown verbatim. */
export function memberName(data, id) { return data?.members.find(m => m.id === id)?.name ?? id; }
/** Severity order (09 §2.5-2): ■ > ? > ▲ > ◔ > ● > ❄ > —. */
export const SEVERITY = Object.freeze({
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
export const CONTEXT_CAP = 75, CONTEXT_FULL = 100, CONTEXT_WARN = 80;
export function ctxLevel(pct) { return pct >= CONTEXT_FULL ? 'bad' : pct >= CONTEXT_WARN ? 'warn' : 'ok'; }
/** Context is shown only when the projection says it is known AND supplies a value; otherwise unknown. */
export function contextKnown(member) { return member?.context != null && (member.contextStatus?.status ?? 'known') === 'known'; }
/** Goal read state: `status` absent (older sources) means the fields are authoritative as given. */
export function goalInfo(goal) {
  const known = (goal?.status ?? 'known') === 'known';
  const gate = goal?.gate ?? { status: 'unknown' };
  return { known, title: known ? goal.title : null, gaps: known && typeof goal.acceptanceGaps === 'number' ? goal.acceptanceGaps : null,
    gate: { ...gate, known: gate.status === 'allowed' || gate.status === 'blocked' }, token: goal?.completionToken ?? 'none' };
}
export function approvalsKnown(data) { return (data?.approvalsStatus?.status ?? 'known') === 'known'; }
export const ROLE_ABBR = { root: 'R', coordinator: 'C', worker: 'W', verifier: 'V' };
export const ROLE_LABEL = { root: 'Root', coordinator: '子协调者', worker: 'Worker', verifier: 'Verifier' };
export const PIPELINE = ['produced', 'verifying', 'verified', 'integrating', 'merged', 'accepted'];

/** Severity of a deadline-bearing wait: overdue → bad; <25% of window left → warn; else wait. */
export function deadlineSeverity(openedAt, deadline, now) {
  if (deadline == null) return 'wait';
  if (deadline <= now) return 'bad';
  const window = Math.max(1, deadline - (openedAt ?? deadline - 60 * 60000));
  return (deadline - now) / window < 0.25 ? 'warn' : 'wait';
}

/** Worst unresolved action/decision message for which `memberId` is the recipient (info excluded; 09 §2.4). */
export function ackSummary(messages, memberId) {
  const open = messages.filter(m => m.to === memberId && m.kind !== 'info' && !['resolved', 'cancelled', 'expired', 'dead-letter'].includes(m.lifecycle));
  if (!open.length) return null;
  const level = m => m.receipts.accepted ? 3 : m.receipts.visible ? 2 : m.receipts.stored ? 1 : 0;
  const worst = open.reduce((a, b) => level(b) < level(a) ? b : a);
  return { level: level(worst), unaccepted: open.filter(m => !m.receipts.accepted).length, worst, open };
}

export function memberSeverity(member, ctx) {
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
export class StableOrder {
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

export function counts(data, now, viewer = null) {
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
export function unknownLabel(u) {
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
export function needsYou(data, now, viewer = null) {
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
export function capacityView(data) {
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
export function laneText(lane) {
  if (!lane) return null;
  return lane.limit == null ? lane.current + '/?' : lane.current + '/' + lane.limit;
}
/**
 * Capacity held by an external effect whose real result is unknown. This is not queueing: the server never releases it
 * on timeout, so only a person can settle it. The occupant is reported with what a person needs (effectId, how long it
 * has held the lane, which lane) and carries no command -- the panel opens a read-only detail instead.
 */
export function unknownOccupants(data) {
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
export function roleGuardView(data) {
  const g = data?.roleGuard;
  if (!g) return null;
  return { coordinatorOnly: g.coordinatorOnly === true, installed: typeof g.installed === 'boolean' ? g.installed : null,
    revoked: typeof g.revoked === 'boolean' ? g.revoked : null, denials: g.denials ?? 0, allows: g.allows ?? 0,
    auditPersistFailed: typeof g.auditPersistFailed === 'boolean' ? g.auditPersistFailed : null,
    declared: Array.isArray(g.declared) ? g.declared : null, policy: g.policy ?? null,
    audit: g.audit ?? { denied: 0, allowed: 0, byTool: null } };
}
/** The committed batch manifest as the panel reads it; absent means no batch block was published. */
export function inputsView(data) {
  const i = data?.inputs;
  if (!i) return null;
  const latest = i.latest ?? null;
  return { count: i.count ?? 0, latest, items: latest?.items ?? null, pendingCount: latest?.pendingCount ?? null,
    omittedCount: latest?.omittedCount ?? null, nextCursor: latest?.nextCursor ?? null };
}
/** Resource threads the envelope published for this viewer (already ACL-filtered by the server). */
export function resourceThreadsOf(data) {
  return Array.isArray(data?.resourceThreads) ? data.resourceThreads.filter(thread => thread?.kind === 'resource') : [];
}

/**
 * The only new states that deserve a line on "now": something needs a person, or the team is not admitting work.
 * Normal capacity is silent (v3 §1: a healthy state takes no space), and nothing here creates a notification.
 */
export function borrowAttention(data, viewer = null) {
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

export function pipelineCounts(tasks) {
  const out = Object.fromEntries(PIPELINE.map(k => [k, 0]));
  for (const t of tasks) if (t.state in out) out[t.state]++;
  return out;
}

export function groupRows(data, now, order, options = {}) {
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
export function waitChain(data, memberId) {
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
export function hasDeadline(deadline) { return typeof deadline === 'number' && Number.isFinite(deadline) && deadline > 0; }
export function relTime(ms) {
  const abs = Math.abs(ms), m = Math.round(abs / 60000), s = Math.round(abs / 1000);
  const text = abs < 60000 ? `${s}s` : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? String(m % 60).padStart(2, '0') + 'm' : ''}`;
  return ms < 0 ? `超期 ${text}` : text;
}
export function utc(ts) { return ts == null ? '' : new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'; }
export function clock(ts) { return ts == null ? '—' : new Date(ts).toTimeString().slice(0, 8); }
export function shortId(id) { return id && id.length > 12 ? id.slice(0, 7) + '…' : id; }
export function truncate(text, n) { return text && text.length > n ? text.slice(0, n - 1) + '…' : text; }

// ── session ↔ member, session-header mini strip, L2 task detail (09 §2.1 L0 mini, §3.2, §5.5) ──
/**
 * The member whose native session is `sessionId`, or — when the conversation frame is showing a member view on
 * this very session (Team nav to a member without a local session) — that member. Anything else is not a Team
 * session: null (the header strip renders nothing).
 */
export function sessionMember(data, sessionId, ui = {}) {
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
export function miniStatus(data, member) {
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
export function taskAttempts(task) {
  if (!Array.isArray(task?.attempts)) return null;
  const superseded = task.attempts.filter(a => a.supersededBy != null);
  const live = task.attempts.filter(a => a.supersededBy == null);
  return { live, superseded, total: task.attempts.length };
}
/**
 * Delivery read state of a task. `delivery: null` is a known "no delivery yet"; `delivery` absent is unknown.
 * `binding` is the parsed `delivery.certificateBinding` (null when the projection omits it = no committed fact).
 */
export function deliveryInfo(task, data = null) {
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
export function certificateBinding(task, data = null) {
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
