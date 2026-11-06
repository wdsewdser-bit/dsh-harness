import { certificateBinding } from './certificate-binding.mjs';
// P9 (appendix 9): the effect capability table is configuration, not rows, and it now lives in contracts (§WP-C 2), so
// the view reads it at the bottom of the graph -- never through packages/host (projections may not depend on the host).
import { effectCapabilities } from '../contracts/index.mjs';
// P7 §8.2.2: the delegation budget is the sum of its members usage rows, and that sum has exactly one implementation.
import { usageOf, capacityStatus, resourceThreadView } from '../core/index.mjs';
import { ROOT_TOOL_POLICY, GATE_RATIO } from '../contracts/index.mjs';
import { panelBlocks } from './panel.mjs';
const time = value => typeof value === 'number' ? value : Date.parse(value) || 0;
/**
 * The owner member's observed state, from the one live fact that is not a store row: the team's owner session is
 * registered with the router while the host runs, and the host drops that registration when it stops.
 *
 * The owner session is the real lead session, not a member agent, so the product never writes it a nativeRef and the
 * row-derived chain below can only answer 'requested' - which the panel renders as "requested", a member that was
 * asked for and never arrived. That is false while the owner session is bound and live, and true only once the
 * binding is gone. So the binding decides: bound -> the member is active (there is a running session driving it),
 * unbound -> back to the row-derived answer.
 */
export function ownerSessionLive({ host = null, router = null } = {}) {
  return () => {
    const sessionId = host?.ownerSessionId ?? null;
    return typeof sessionId === 'string' && sessionId !== '' && router?.routeOwner?.(sessionId)?.routed === true;
  };
}
/**
 * P7 (docs/decisions/team-autonomy-design.md §10 P7, appendix 8): the rows the autonomy packages added, projected for
 * the owner panel.
 *
 * The blocks appear only for the reader who may see them (root sees the team; a member sees the rows that name it) and
 * only when the team actually holds those facts. A team that never used P1-P6 therefore produces exactly the envelope it
 * produced before this function existed: the absence is structural, not a switch somebody has to remember to check.
 * Appendix 8 records what is NOT here and why (the static effect-capability table and the price table are
 * configuration, not rows, and this module only receives rows).
 */
function autonomyBlocks(rows, all, me, actor, data, now, pricing = null) {
  // P9 (appendix 9): the price table is configuration, not a row, so it arrives as an option. A malformed table is no
  // table: the projection then answers exactly what it answered before the option existed (no cost at all).
  const price = (() => {
    if (!pricing || typeof pricing !== 'object') return null;
    const currency = typeof pricing.currency === 'string' && pricing.currency ? pricing.currency : null;
    const perInputToken = Number(pricing.perInputToken);
    const perOutputToken = Number(pricing.perOutputToken);
    if (currency === null || !Number.isFinite(perInputToken) || !Number.isFinite(perOutputToken)) return null;
    return { currency, perInputToken, perOutputToken };
  })();
  const root = me.role === 'root';
  const mine = row => root || row.entityId === actor || row.memberId === actor || row.owner === actor;
  const pick = prefix => all.filter(row => row.entityId.startsWith(prefix) && mine(row));
  const decisions = pick('decision:');
  const audits = pick('audit:');
  const goals = pick('team-goal:');
  const proofs = pick('stop-proof:');
  const tickets = pick('effect-evidence:');
  const groupRows = pick('group:');
  const workspaces = pick('member.workspace:');
  const budgeted = pick('delegation:').filter(row => row.budget && row.budget.tokens);
  if (!decisions.length && !audits.length && !goals.length && !proofs.length && !tickets.length &&
    !groupRows.length && !workspaces.length && !budgeted.length) return null;
  const at = Number.isFinite(now) ? now : Date.now();
  const by = (left, right, key) => (left[key] ?? 0) - (right[key] ?? 0) || left.id.localeCompare(right.id);
  const block = {};
  if (decisions.length) {
    block.decisions = decisions.map(row => ({
      id: row.entityId, kind: row.kind, state: row.state,
      // §2.2.6: an open row whose TTL has passed changes nothing; the UI must be able to say so before the clock
      // marks it, and the durable state is kept beside the derived one.
      expired: row.state === 'open' && Number.isFinite(row.expiresAt) && row.expiresAt <= at,
      subject: row.subject ?? null, options: row.options ?? [], evidence: row.evidence ?? [],
      openedAt: row.openedAt ?? null, expiresAt: row.expiresAt ?? null,
      ttlRemainingMs: Number.isFinite(row.expiresAt) ? Math.max(0, row.expiresAt - at) : null,
      openedFor: row.openedFor ?? null, fallback: row.fallback ?? null, verdict: row.verdict ?? null,
      revision: row.revision })).sort((a, b) => by(a, b, 'openedAt'));
  }
  if (audits.length) {
    block.auditTrail = audits.map(row => ({ id: row.entityId, kind: row.kind ?? null,
      decisionId: row.decisionId ?? null, subject: row.subject ?? null, option: row.option ?? null,
      evidenceRef: row.evidenceRef ?? null, by: row.by ?? null, byKind: row.byKind ?? null, at: row.at ?? null,
      applied: row.applied ?? null, priorRevision: row.priorRevision ?? null, revision: row.revision }))
      .sort((a, b) => by(a, b, 'at'));
  }
  if (goals.length) {
    const goal = goals.at(-1);
    block.teamGoal = { id: goal.entityId, objective: goal.objective ?? null, state: goal.state ?? null,
      openedAt: goal.openedAt ?? null, openedBy: goal.openedBy ?? null,
      // §5.2.2: the initial base of every (directory, target) queue, as the host read it back.
      bases: (goal.bases ?? []).map(base => ({ target: base.target ?? base.key?.target ?? null,
        realCommonDir: base.key?.realCommonDir ?? null, directory: base.directory ?? null,
        commit: base.commit ?? null, tree: base.tree ?? null, recordedAt: base.recordedAt ?? null })),
      // §5.2.4: an adopted store says so, with the chains that were proved -- the hint the UI shows instead of
      // pretending a fresh goal was opened.
      legacy: goal.legacy ? { mode: goal.legacy.mode ?? null,
        chains: (goal.legacy.chains ?? []).map(chain => ({ target: chain.key?.target ?? null,
          tail: chain.tail ?? null, deliveries: (chain.deliveries ?? []).length })) } : null,
      completionTokenRef: goal.completionTokenRef ?? null, revision: goal.revision };
  }
  if (proofs.length) {
    block.stopProofs = proofs.map(row => ({ id: row.entityId, subject: row.subject ?? null,
      verified: row.verified === true, method: row.method ?? null, confidence: row.confidence ?? null,
      writtenBy: row.writtenBy ?? null, at: row.at ?? null, roots: (row.roots ?? []).length,
      polls: row.polls ?? null, reason: row.reason ?? null, revision: row.revision }))
      .sort((a, b) => by(a, b, 'at'));
  }
  if (tickets.length) {
    const effects = all.filter(row => row.entityId.startsWith('effect:'));
    block.effects = {
      // §6.2/§6.3: what the capability layer could not decide, with the code it decided that with.
      tickets: tickets.map(row => ({ id: row.entityId, effectId: row.effectId ?? null, kind: row.kind ?? null,
        code: row.code ?? null, message: row.message ?? null, attempts: row.attempts ?? null,
        evidenceRef: row.evidence ?? null, at: row.at ?? null, revision: row.revision })).sort((a, b) => by(a, b, 'at')),
      unknown: effects.filter(row => row.status === 'unknown').map(row => ({ id: row.entityId,
        effectId: row.effectId ?? null, kind: row.payload?.kind ?? null, status: row.status, tries: row.tries ?? 0,
        code: tickets.find(ticket => ticket.effectId === row.effectId)?.code ?? null, revision: row.revision })),
      kinds: [...new Set(effects.map(row => row.payload?.kind).filter(Boolean))].sort().map(kind => {
        const ofKind = effects.filter(row => row.payload?.kind === kind);
        return { kind, effects: ofKind.length, unknown: ofKind.filter(row => row.status === 'unknown').length };
      }),
      // P9: the declaration itself (readback / safe retry / neither, and the attempt cap). Before this the panel could
      // only show effects that had already gone wrong; now it can say what each kind would do.
      capabilities: effectCapabilities(),
    };
  }
  if (budgeted.length) {
    // §8.2.2: the delegation ledger is the sum of its members' usage rows; usageOf is the one implementation of that
    // sum (P6), asked here with a view over the projection's own rows.
    const readable = { read: id => rows.get(id) ?? null,
      list: prefix => all.filter(row => row.entityId.startsWith(prefix)) };
    block.budget = { delegations: budgeted.map(delegation => {
      const tasks = all.filter(row => row.entityId.startsWith('task:') && row.delegationRef === delegation.entityId);
      const running = all.filter(row => row.entityId.startsWith('attempt:') && ['active', 'unknown'].includes(row.lease) &&
        tasks.some(task => task.entityId === row.taskId)).length;
      const usage = usageOf(readable, { delegationRef: delegation.entityId });
      const tokens = delegation.budget.tokens ?? {};
      return { id: delegation.entityId, owner: delegation.owner ?? null,
        tasks: { used: tasks.length, limit: delegation.budget.tasks ?? null },
        concurrency: { running, limit: delegation.budget.concurrency ?? null },
        tokens: { input: usage.input, output: usage.output, counted: usage.counted, unknown: usage.unknown,
          inputLimit: Number.isSafeInteger(tokens.inputLimit) ? tokens.inputLimit : null,
          outputLimit: Number.isSafeInteger(tokens.outputLimit) ? tokens.outputLimit : null,
          // P9: the amount exists only when a price table was configured, and it is computed exactly the way core's
          // usageProjection computes it - same inputs, same formula, so the panel and the budget gate never disagree.
          ...(price === null ? {} : { cost: { currency: price.currency,
            amount: usage.input * price.perInputToken + usage.output * price.perOutputToken } }) },
        expiresAt: delegation.expiresAt ?? null, revision: delegation.revision };
    }) };
  }
  if (groupRows.length) {
    // The derived list keeps its shape; a group row adds what only the row knows (who created it, when, and a lead
    // for a group that has no members yet).
    const known = new Map(groupRows.map(row => [row.name, row]));
    const merged = data.groups.map(group => {
      const row = known.get(group.id);
      known.delete(group.id);
      return row ? { ...group, lead: row.lead ?? group.lead, createdAt: row.createdAt ?? null, by: row.by ?? null } : group;
    });
    for (const row of known.values()) {
      merged.push({ id: row.name, label: row.name, lead: row.lead ?? null, createdAt: row.createdAt ?? null,
        by: row.by ?? null });
    }
    block.groups = merged;
  }
  if (workspaces.length) {
    // §4.2.2: the assignment is the member's, so it rides on the member row the UI already lists.
    const known = new Map(workspaces.map(row => [row.memberId, row]));
    block.members = data.members.map(member => {
      const row = known.get(member.id);
      return row ? { ...member, workspace: { relPath: row.relPath ?? null, base: row.base ?? null,
        resolved: row.resolved ?? null, recordedAt: row.recordedAt ?? null, lockedAt: row.lockedAt ?? null } } : member;
    });
  }
  return block;
}

/**
 * P5 (§3.2, §5, §6, §10 P5): the v1 read surface, present only while the protocol is on.
 *
 * Nothing is derived twice. Resource threads come from the domain's own resourceThreadView (so the projection and
 * team_read cannot disagree about a subscriber or a head), capacity comes from the one control-capacity reducer, and
 * the batch block reads the manifests the input arbiter committed. An off team gets none of these keys, so its
 * envelope keeps the exact shape -- and bytes -- it had before this package (design §2, off golden).
 *
 * Visibility is the thread's own ACL: the owner, a subscriber and root see a resource thread; nobody else gets its
 * identity, its subscription list or its last event. A subscriber sees only its own subscription unless it owns the
 * resource or reads as root, which is the design's "unauthorized viewer receives no hidden member subscriptions".
 */
function borrowBlocks(rows, all, me, actor, policy, protocol, maxRuns, roleGuard, now) {
  if (protocol !== 'v1') return null;
  const root = me.role === 'root';
  const canSee = row => {
    const current = policy.get(row.entityId);
    return !!current && (root || current.owner === actor || current.entityId === actor || current.acl?.includes(actor));
  };
  // The reader the domain view expects: rows only, never a write handle. A missing row is null, never an empty object.
  const store = { read: entityId => rows.get(entityId) ?? null,
    list: prefix => all.filter(row => row.entityId.startsWith(prefix)) };
  const resourceThreads = all.filter(row => row.entityId.startsWith('thread:') && row.kind === 'resource' && canSee(row))
    .map(row => resourceThreadView(store, row.entityId,
      memberId => root || policy.get(row.entityId)?.owner === actor || memberId === actor))
    .filter(Boolean)
    .map(thread => ({ id: thread.entityId, threadRef: thread.threadRef, kind: 'resource', status: thread.status,
      owner: thread.owner, resource: thread.resource, head: thread.head, retainedFrom: thread.retainedFrom,
      descriptionRef: thread.descriptionRef, subscribers: thread.subscribers,
      pending: thread.subscribers.reduce((total, sub) => total + (sub.pending ?? 0), 0),
      lastEvent: thread.lastEvent, revision: thread.revision }))
    .sort((left, right) => left.id.localeCompare(right.id));
  // §6: N/H, unknown and admission are read from the same reducer the allocator uses. Aggregate counts are readable by
  // the team; occupant identities and blocked origins stay with root, because they name other members' work.
  const capacity = capacityStatus({ store, configuration: { maxRuns } }, now);
  const visibleCapacity = root ? capacity : { ...capacity, occupants: [],
    blocked: (capacity.blocked ?? []).filter(entry => entry.recipient === actor) };
  // §4.2: root is coordinator-only. Installation and counters are live runtime facts when the composition supplies
  // them; the persisted guard-audit rows are the same ledger and fill in what the status cannot (and survive a restart).
  const live = typeof roleGuard === 'function' ? roleGuard() : roleGuard;
  const audits = all.filter(row => row.entityId.startsWith('guard-audit:') && row.entityId !== 'guard-audit:latest');
  const denied = audits.filter(row => row.decision === 'deny').length;
  const allowed = audits.filter(row => row.decision === 'allow').length;
  const byTool = new Map();
  for (const row of audits) {
    const identity = row.toolIdentity ?? 'unknown';
    const entry = byTool.get(identity) ?? { identity, allowed: 0, denied: 0 };
    if (row.decision === 'deny') entry.denied += 1;
    else if (row.decision === 'allow') entry.allowed += 1;
    byTool.set(identity, entry);
  }
  const guard = {
    coordinatorOnly: true,
    policy: { deny: [...ROOT_TOOL_POLICY.deny], allow: [...ROOT_TOOL_POLICY.allow], unknown: ROOT_TOOL_POLICY.unknown },
    installed: typeof live?.installed === 'boolean' ? live.installed : null,
    revoked: typeof live?.revoked === 'boolean' ? live.revoked : null,
    denials: Number.isSafeInteger(live?.denials) ? live.denials : denied,
    allows: Number.isSafeInteger(live?.allows) ? live.allows : allowed,
    auditPersistFailed: typeof live?.auditPersistFailed === 'boolean' ? live.auditPersistFailed : null,
    declared: root && Array.isArray(live?.declared) ? [...live.declared].sort() : null,
    audit: { denied, allowed,
      byTool: root ? [...byTool.values()].sort((left, right) => left.identity.localeCompare(right.identity)) : null },
  };
  // §5: the last manifests are the batch truth; pendingCount/omittedCount are the batch's own numbers, never inferred.
  const manifests = all.filter(row => row.entityId.startsWith('manifest:') && row.batch)
    .filter(row => root || row.memberId === actor)
    .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0) || left.entityId.localeCompare(right.entityId));
  const batches = manifests.slice(-20).map(row => ({
    id: row.entityId, memberId: row.memberId ?? null,
    generation: row.batch.generation ?? row.generation ?? null,
    cutoffSeq: row.batch.cutoffSeq ?? null,
    items: Array.isArray(row.inputBindings) ? row.inputBindings.length
      : Array.isArray(row.batch.bindings) ? row.batch.bindings.length : 0,
    pendingCount: Number.isSafeInteger(row.batch.pendingCount) ? row.batch.pendingCount : null,
    omittedCount: Number.isSafeInteger(row.batch.omittedCount) ? row.batch.omittedCount : null,
    nextCursor: row.batch.nextCursor ?? null, injectedAt: row.createdAt ?? null, revision: row.revision ?? null,
  }));
  return { resourceThreads, capacity: visibleCapacity, roleGuard: guard,
    inputs: { batches, latest: batches.at(-1) ?? null, count: manifests.length } };
}

/**
 * The one visibility predicate: a row is readable by root, by the entity itself, or by a principal the row names
 * (owner, sender, recipient, a required respondent, an ACL entry). Exported so the M6 panel blocks and the records
 * timeline read the same rule instead of each carrying a copy of it.
 */
export function canSee(row, me, actor) {
  return !!row && (me.role === 'root' || row.entityId === actor || row.owner === actor || row.sender === actor ||
    row.recipient === actor || row.recipients?.includes(actor) || row.requiredRespondents?.includes(actor) || row.acl?.includes(actor));
}

/** Derive consumer rows solely from event-reduced facts; 08 §1.2, §5. */
export function view(rows, actor, policy = rows, { ownerSession = false, pricing = null, protocol = 'off',
  maxRuns = null, roleGuard = null, now = Date.now(), panel = 'v3', leaderSessionId = null, commandPolicy = {}, authorityRows = policy } = {}) {
  const all = [...rows.values()];
  const me = policy.get(actor);
  if (!me) throw Error('UNKNOWN_ACTOR');
  const allowed = row => canSee(policy.get(row.entityId), me, actor);
  const list = prefix => all.filter(r => r.entityId.startsWith(prefix) && allowed(r));
  const attempts = list('attempt:');
  const tasks = list('task:');
  const members = list('member:').map(m => {
    const intent = all.filter(r => r.entityId.startsWith('member-intent:') && r.memberRef === m.entityId && ['intent', 'applying'].includes(r.status)).at(-1);
    const a = attempts.filter(a => a.owner === m.entityId).at(-1);
    const wait = list('wait:').find(w => w.taskId === a?.taskId && w.status === 'pending');
    return { id: m.entityId, name: m.name ?? m.entityId, role: m.role === 'subCoordinator' ? 'coordinator' : m.role,
      group: m.group, generation: m.generation, pendingLifecycle: intent ? { op: intent.op, since: time(intent.createdAt) } : null, desired: intent?.op === 'retire' || m.desired === 'retired' ? 'retired' : intent?.op === 'freeze' || m.desired === 'frozen' ? 'frozen' : 'active',
      observed: m.status === 'unknown' ? 'unknown' : m.status === 'retired' && m.observed === 'stopped' ? 'retired' : m.observed === 'stopped' ? 'frozen' : m.observed === 'running' ? 'active' : m.role === 'root' && ownerSession ? 'active' : m.nativeRef ? 'bound' : 'requested',
      history: [], attempt: a ? { id: a.entityId, n: 1, state: a.lease === 'unknown' ? 'unknown' : a.status === 'admitted' ? 'running' : a.status ?? 'admitted',
        lease: a.lease === 'unknown' ? null : { state: a.lease, expiresAt: a.expiresAt ?? 0, fence: a.fence }, worktree: null, superseded: [] } : null,
      taskId: tasks.find(t => t.owner === m.entityId)?.entityId ?? null,
      wait: wait ? { kind: wait.dependency.kind, ref: wait.entityId, label: wait.dependency.kind, openedAt: wait.createdAt, deadline: time(wait.deadline), state: wait.status } : null,
      context: list('read-model:context:').find(c => c.owner === m.entityId && c.sessionId === m.nativeRef)?.context ?? null, contextStatus: { status: list('read-model:context:').find(c => c.owner === m.entityId && c.sessionId === m.nativeRef)?.status ?? 'unknown', limitRatio: GATE_RATIO }, delegation: null, nativeRef: m.nativeRef ?? null, checkpointAt: null, revision: m.revision };
  });
  const threads = list('thread:').filter(t => t.kind !== 'resource').map(t => ({ id: t.entityId, question: t.question, owner: t.owner, escalationOwner: t.escalationOwner,
    requiredRespondents: t.requiredRespondents.map(member => ({ member, revision: t.replies.find(r => r.actor === member)?.proposalRevision ?? null })),
    requiredEvidence: (t.requiredEvidence ?? []).map(ref => ({ ref, revision: t.replies.find(r => r.bodyRef === ref)?.proposalRevision ?? null })),
    openedAt: t.createdAt, deadline: time(t.deadline), state: t.status, proposalRevision: t.proposalRevision, supersededRevisions: [],
    replies: t.replies.filter(r => !r.late).map(r => ({ member: r.actor, revision: r.proposalRevision, text: r.bodyRef })),
    lateEvidence: t.replies.filter(r => r.late).map(r => ({ member: r.actor, text: r.bodyRef })), affectedTasks: t.taskRef ? [t.taskRef] : [], decisionRevision: t.decisionRevision, revision: t.revision }));
  const token = list('completion:').at(-1);
  const rootSession = all.find(r => r.entityId.startsWith('member:') && r.role === 'root')?.nativeRef;
  const native = list('read-model:goal:').filter(r => !rootSession || r.sessionId === rootSession).sort((a, b) => a.updatedAt - b.updatedAt).at(-1);
  const goal = native?.goal;
  const gate = list('read-model:gate:').find(g => g.sessionId === native?.sessionId && g.goalId === goal?.id && (g.goalRevision === goal?.revision || token?.expectedRevision === goal?.revision));
  const approvals = tasks.filter(t => !t.approved && t.status === 'draft').map(t => ({ id: t.entityId, kind: 'scope', member: t.owner, task: t.entityId, summary: 'Unapproved task scope contract', status: t.scopeApproval?.status === 'requested' ? 'requested' : 'unknown', requestedAt: t.scopeApproval?.status === 'requested' ? t.scopeApproval.requestedAt ?? null : null, diff: t.scopeSet ?? [], deadline: t.deadline ? time(t.deadline) : null, revision: t.revision, contractRevision: t.contractRevision }));
  const data = { goal: { id: goal?.id ?? 'goal', title: goal?.objective ?? 'unknown', status: goal ? 'known' : 'unknown', native: goal ?? null, source: native ? { sessionId: native.sessionId, seq: native.sourceSeq } : null, gate: gate ? { status: gate.result, revision: gate.goalRevision, evaluatedAt: gate.evaluatedAt, sourceSeq: gate.sourceSeq, semantics: 'last-committed-check' } : { status: 'unknown' }, acceptanceGaps: goal ? tasks.filter(t => !['accepted', 'cancelled'].includes(t.status)).length : null,
    completionToken: ['prepared', 'authorized', 'consumed'].includes(token?.status) ? token.status : 'none' },
    restrictedMembers: all.filter(r => r.entityId.startsWith('member:')).length - members.length,
    groups: [...new Set(members.map(m => m.group))].map(id => ({ id, label: id, lead: members.find(m => m.group === id && m.role === 'coordinator')?.id ?? null })), members,
    tasks: tasks.map(t => ({ id: t.entityId, title: t.title ?? t.entityId, state: t.status, owner: t.owner, contractRevision: t.contractRevision,
      attempts: attempts.filter(a => a.taskId === t.entityId).map((a, i) => ({ n: i + 1, state: a.lease === 'unknown' ? 'unknown' : a.status === 'admitted' ? 'running' : a.status })),
      delivery: (() => { const d = list('delivery:').find(d => d.taskId === t.entityId); return d ? { revision: d.revision, ...(certificateBinding(d, t, rows) ? { certificateBinding: certificateBinding(d, t, rows) } : {}),
        certificate: d.certificate ? d.certificate.contractRevision === t.contractRevision && d.certificate.candidate === d.candidate && d.certificate.tree === d.tree && ['verified', 'applying', 'accepted'].includes(d.status) ? 'valid' : 'invalid' : null,
        merge: d.status === 'accepted' ? 'confirmed' : d.status === 'applying' ? 'prepared' : d.status === 'unknown' ? 'unknown' : null } : null; })(), revision: t.revision })), threads,
    messages: list('message:').map(m => ({ id: m.entityId, from: m.sender, to: m.recipient ?? (m.recipients ?? []).join('+'), kind: m.kind, openedAt: m.createdAt,
      deadline: m.deadline ? time(m.deadline) : Number.isFinite(m.closesAt) ? new Date(m.closesAt).toISOString() : null,
      lifecycle: m.status, expectedOutcome: m.expectedOutcome ?? '', generation: m.generation,
      receipts: { stored: m.stored ? { at: m.receiptTimes.stored } : null, visible: m.visible ? { at: m.receiptTimes.visible, requestId: m.observation?.requestId, manifest: m.observation?.manifestHash, seq: m.observation?.sessionSeq } : null,
        accepted: m.accepted ? { at: m.receiptTimes.accepted, checkpoint: m.checkpointRef } : null }, delayReason: null, escalatedTo: null, rebinds: [], revision: m.revision })),
    unknownEffects: all.filter(r => allowed(r) && (r.status === 'unknown' || r.lease === 'unknown')).map(r => ({ id: r.entityId, kind: r.entityId.startsWith('delivery:') ? 'delivery' : 'external', ref: r.entityId, summary: r.reason ?? 'unknown', evidence: [], openedAt: r.createdAt, revision: r.revision })), approvals, approvalsStatus: { status: 'known', source: 'committed-task-contracts' } };
  // P7: the autonomy facts, added only when this team holds them (appendix 8). With none of them the object returned
  // here is the one this function returned before P7 existed -- same keys, same order, same bytes.
  const extra = autonomyBlocks(rows, all, me, actor, data, now, pricing);
  const base = extra === null ? data : { ...data, ...extra };
  // P5: the v1 blocks are structurally absent while the protocol is off (design §2, off golden); nothing below
  // changes a key this function returned before this package existed.
  const borrow = borrowBlocks(rows, all, me, actor, policy, protocol, maxRuns, roleGuard, now);
  const envelope = borrow === null ? base : { ...base, ...borrow };
  // No M6 facts and protocol off: preserve the production envelope, including key order and row values.
  const visible = all.filter(allowed);
  const m6 = protocol === 'v1' || visible.some(row => row.kind === 'intent' || row.deadLetter != null);
  if (panel === 'legacy' || !m6) return envelope;
  return { ...envelope, ...panelBlocks(envelope, { all, me, actor, allowed, now, leaderSessionId, authorityRows,
    commandPolicy: { intentProtocol: protocol === 'v1' ? 'root-decision-v1' : null, ...commandPolicy } }) };
}
