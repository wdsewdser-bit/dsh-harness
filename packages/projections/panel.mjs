// M6 (16 §6 N1–N4, P5/P6/P8–P11): the read blocks the v3 panel renders.
//
// Rule 1 of 13 §2: nothing here is a second source of truth. Every block is a pure function of the rows view() has
// already read, so a cold and a warm projection of the same rows are equal, no block needs a write path, and
// Off teams with no M6 facts keep the pre-M6 bytes on the default production path.

import { capabilitiesFor } from './capabilities.mjs';
import { stopSubjectKey } from './stop-subject.mjs';

/** Human nouns for a wait dependency whose target row is not visible to this reader. */
const WAIT_NOUNS = Object.freeze({ Approval: '合同审批', TaskAccepted: '任务验收', Decision: '一个决定',
  MessageResponsibility: '消息接手', ExternalEvidence: '外部证据' });

/** A stage is "reached" once a task has been through it; the v3 progress bar reads these as a funnel. */
const FUNNEL = Object.freeze({
  produced: ['produced', 'verifying', 'verified', 'integrating', 'merged', 'accepted'],
  verifying: ['verifying', 'verified', 'integrating', 'merged', 'accepted'],
  merged: ['merged', 'accepted'],
  accepted: ['accepted'],
});

const nameOf = (data, id) => (id == null ? null : (data.members.find(member => member.id === id)?.name ?? null));

/**
 * P5: what a member is doing right now, in the three shapes the panel knows.
 *
 * The projection holds no committed "tool" fact and no compaction fact, so those are absent rather than invented.
 * A frozen, retiring or unknown member has no activity: the panel shows the lifecycle instead (15 §3.2).
 */
export function activityOf(member) {
  if (member.observed == null || member.observed === 'unknown') return null;
  if (member.observed === 'frozen' || member.observed === 'retired') return null;
  if (member.desired === 'frozen' || member.desired === 'retired') return null;
  if (member.attempt?.state === 'running') return { kind: 'running', sub: null, since: null };
  return { kind: 'idle', sub: member.wait ? 'waiting' : null, since: null };
}

/** P10: the name of what a member is waiting for, resolved from the dependency's ref when that row is visible. */
export function targetLabelOf(wait, data, rows) {
  if (!wait) return null;
  const ref = rows.get(wait.ref)?.dependency?.ref ?? null;
  if (typeof ref === 'string') {
    if (ref.startsWith('task:')) return data.tasks.find(task => task.id === ref)?.title ?? null;
    if (ref.startsWith('thread:')) return data.threads.find(thread => thread.id === ref)?.question ?? null;
    if (ref.startsWith('message:')) {
      const message = data.messages.find(row => row.id === ref);
      return message ? (message.expectedOutcome || nameOf(data, message.from)) : null;
    }
  }
  if (wait.memberRef) return nameOf(data, wait.memberRef);
  return WAIT_NOUNS[wait.kind] ?? null;
}

/** P11: the last three committed events naming this member. Rows only; an empty history stays empty. */
export function historyOf(member, data) {
  const events = [];
  for (const message of data.messages) {
    if (message.from !== member.id && message.to !== member.id) continue;
    events.push({ at: message.openedAt ?? null, kind: 'message', ref: message.id,
      text: message.expectedOutcome || (message.from === member.id ? '发出消息' : '收到消息') });
  }
  if (member.wait?.openedAt != null) {
    events.push({ at: member.wait.openedAt, kind: 'wait', ref: member.wait.ref,
      text: '开始等待：' + (member.wait.targetLabel ?? member.wait.label ?? '') });
  }
  events.sort((left, right) => (right.at ?? 0) - (left.at ?? 0) || String(left.ref).localeCompare(String(right.ref)));
  return events.slice(0, 3);
}

/** P6: an open or closed proposal window, with what each recipient has seen and answered. */
export function intentOf(row) {
  const answers = row.votes ?? row.answers ?? {};
  const seen = row.seenAtClose ?? null;
  return {
    id: row.entityId,
    from: row.sender ?? null,
    summary: row.summary ?? row.expectedOutcome ?? null,
    openedAt: row.openedAt ?? row.createdAt ?? null,
    closesAt: Number.isFinite(row.closesAt) ? row.closesAt : null,
    state: row.decision ?? (row.status === 'open' ? 'open' : row.status ?? null),
    recipients: (row.recipients ?? []).map(member => ({
      member,
      delivery: row.visibility?.[member] ? 'visible' : 'stored',
      reply: answers[member]?.verdict ?? answers[member]?.reply ?? null,
      reason: answers[member]?.reason ?? null,
      at: answers[member]?.at ?? null,
    })),
    passedAt: row.closedAt ?? null,
    unseenAtPass: seen === null ? [] : Object.keys(seen).filter(member => seen[member] === false),
    revision: row.revision,
  };
}

/**
 * N2: the things that need the owner, derived from the rows that already escalated.
 *
 * Only root reads this block: an escalation is addressed to the owner by definition. A safety row whose verdict is
 * the operator's carries no primary action (the browser never holds that authority), only the note saying where it
 * is decided -- the 2026-11-05 decision on §3 #12.
 */
export function escalationsOf(data, me, all = [], now = Date.now()) {
  if (me.role !== 'root') return [];
  const rows = new Map(all.map(row => [row.entityId, row]));
  const escalations = [], incidents = new Map();
  // Exact gateway entry, identical to what projections/commands.mjs admits (§6 #12).
  const stopEntry = ref => 'organization.confirmStopped(target=' + ref + ', args:{evidenceRef}, expectedRevision=<row revision>)';
  const add = (id, type, question, since, entry) => {
    const issueKey = stopSubjectKey(id, rows) ?? id;
    const existing = incidents.get(issueKey);
    if (existing) { if (!existing.sources.includes(id)) existing.sources.push(id); return; }
    const waitingMs = Number.isFinite(since) ? Math.max(0, now - since) : null;
    const item = { id: 'escalation:' + issueKey, issueKey, sources: [id], question,
      why: '需要 operator 根据证据确认', waitingSince: since ?? null, waitingMs,
      consequence: '确认前不会释放占用或推进相关工作', primary: null,
      note: question + '；' + (waitingMs === null ? '等待起点未记录' : '已等待 ' + waitingMs + ' 毫秒') +
        '；operator 入口：' + entry,
      severity: 'bad', subject: { type, id } };
    incidents.set(issueKey, item); escalations.push(item);
  };
  for (const thread of data.threads) {
    const raw = rows.get(thread.id);
    // An escalation *to root* is ordinary root work. Only an explicit root -> operator transfer needs a human.
    if (thread.state !== 'escalated' || rows.get(raw?.escalatedBy)?.role !== 'root' ||
        raw?.responsible !== 'operator') continue;
    add(thread.id, 'thread', thread.question, raw.escalatedAt, 'threads.escalate 已转交 operator；查看 ' + thread.id);
  }
  for (const effect of data.unknownEffects) {
    if (effect.class !== 'effect' || !/^(effect|delivery|message):/.test(effect.id)) continue;
    const entry = effect.id.startsWith('message:') ? 'mailbox.resolveUnknown(target=' + effect.id + ', decision, evidenceRef)'
      : effect.id.startsWith('delivery:') ? 'delivery.reconcile(target=' + effect.id + ', decision, evidenceRef)'
        : 'core.store.adjudicate(command, effectId=' + effect.id.slice(7) + ', evidence, decision)';
    add(effect.id, 'effect', '「' + effect.id + '」的结果不明', effect.openedAt, entry);
  }
  const pendingStops = all.filter(row => row.kind === 'stuck-member');
  const latestStop = new Map(pendingStops.map(row => [row.subject?.id, row]));
  for (const decision of latestStop.values()) {
    const subject = rows.get(decision.subject?.id);
    if (subject?.E && rows.get('execution-scope:' + subject.E.executionEpoch)?.state === 'RELEASED') continue;
    // A wait verdict/TTL acknowledges responsibility; it is not evidence that the session stopped.
    if (subject && (subject.observed === 'stopped' || ['retired', 'cancelled'].includes(subject.status) ||
        subject.stopState === 'verified' || subject.state === 'RELEASED')) continue;
    if (!['open', 'expired'].includes(decision.state) && subject?.status !== 'unknown' &&
        subject?.stopState !== 'unverified') continue;
    const memberId = subject?.E?.memberId ?? subject?.owner ?? subject?.memberId ?? decision.subject?.id;
    const member = rows.get(memberId);
    const attempt = subject?.entityId?.startsWith('attempt:') ? subject :
      all.find(row => row.entityId.startsWith('attempt:') && row.owner === memberId && row.lease === 'unknown');
    const object = subject?.E?.executionSessionId ?? member?.nativeRef ?? memberId;
    add(decision.entityId, 'member', '会话 ' + object + ' 停止尚未确认', decision.openedAt,
      attempt ? stopEntry(attempt.entityId)
        : 'core.decideDecision("' + decision.entityId + '", "operator", {decision:"wait", reason}, "operator")（确认接手，不释放占用）');
  }
  for (const slot of data.capacity?.occupants ?? []) {
    if (slot.state !== 'unknown') continue;
    const raw = rows.get(slot.ref);
    const target = slot.holderRef ?? slot.originRef ?? slot.ref;
    const attempt = rows.get(target);
    const entry = attempt?.entityId.startsWith('attempt:')
      ? stopEntry(target)
      : raw?.holderKind === 'owner-request'
        ? 'settleOwnerControl(tx, {slotRef:"' + slot.ref + '", callIdentity:"' + raw.callIdentity +
          '", hostEpoch:' + raw.hostEpoch + ', terminal:true, evidenceRef, now})（operator 事务，须独立终止证据）'
        : 'core.store.adjudicate(command, effectId=' + String(target).replace(/^effect:/, '') + ', evidence, decision)';
    add(slot.ref, 'capacity', '容量占用 ' + slot.ref + '（对象 ' + target + '）结果不明',
      raw?.startedAt ?? raw?.createdAt ?? raw?.updatedAt, entry);
  }
  for (const attempt of all.filter(row => row.entityId.startsWith('attempt:') && row.lease === 'unknown')) {
    const session = rows.get(attempt.owner)?.nativeRef ?? attempt.owner;
    add(attempt.entityId, 'capacity', '会话 ' + session + ' 的执行占用 ' + attempt.entityId + ' 停止未确认',
      attempt.admittedAt ?? attempt.createdAt ?? attempt.updatedAt,
      stopEntry(attempt.entityId));
  }
  for (const io of all.filter(row => row.entityId.startsWith('effect-io:') && row.state === 'unknown')) {
    add(io.entityId, 'capacity', '外部效果 ' + io.effectId + ' 的 IO 占用 ' + io.entityId + ' 结果不明',
      io.startedAt, 'effectRunner.reclaim("' + io.effectId + '", evidenceRef, {fence:' + io.fence +
      '})（operator 侧；证据必须匹配 team/hostEpoch/startedAt，超时不能释放）');
  }
  return escalations;
}

/** N1: the one line the "现在" page shows, computed here so two panels never disagree on the priority. */
export function summaryOf(data, members, escalations) {
  const working = members.filter(member => member.activity?.kind === 'running').length;
  const accepted = data.tasks.filter(task => task.state === 'accepted').length;
  const handling = data.threads.filter(thread => thread.state === 'escalated').length + data.approvals.length +
    data.tasks.filter(task => task.state === 'blocked').length +
    (data.panelDecisions ?? []).filter(decision => decision.state === 'open').length;
  const headline = escalations.length
    ? { kind: 'needs-you', text: `有 ${escalations.length} 件事需要你决定`,
      targetRef: escalations[0]?.subject?.id ?? null }
    : handling
      ? { kind: 'root-handling', text: `组长正在处理 ${handling} 件事`, targetRef: null }
      : { kind: 'ok', text: '一切正常', targetRef: null };
  return { working, accepted, total: data.tasks.length, headline };
}

/**
 * N3: the one-line roster summary (16 §3.1's "9 人：7 正常、1 卡住、1 暂停").
 *
 * "Stuck" is a blocked task, not a passed deadline: a deadline comparison would make the block depend on the
 * reader's clock, and a cold and a warm projection of the same rows must be equal.
 */
export function memberSummaryOf(data, members) {
  const blocked = new Set(data.tasks.filter(task => task.state === 'blocked').map(task => task.id));
  const counts = { normal: 0, stuck: 0, paused: 0, retiring: 0, idle: 0 };
  for (const member of members) {
    const bucket = member.desired === 'retired' && member.observed !== 'retired' ? 'retiring'
      : member.observed === 'frozen' || member.desired === 'frozen' ? 'paused'
        : blocked.has(member.taskId) ? 'stuck'
          : member.activity?.kind === 'idle' && !['root', 'coordinator'].includes(member.role) ? 'idle' : 'normal';
    counts[bucket]++;
  }
  const root = members.find(member => member.role === 'root')?.id ?? null;
  return { ...counts, stuckHandledBy: counts.stuck ? root : null };
}

/** N4: the funnel behind the progress bar. Denominator is the number of tasks (2026-11-01 decision). */
export function deliveryOf(tasks) {
  const count = states => tasks.filter(task => states.includes(task.state)).length;
  return { produced: count(FUNNEL.produced), verifying: count(FUNNEL.verifying), merged: count(FUNNEL.merged),
    accepted: count(FUNNEL.accepted), total: tasks.length };
}

/** P3: the title row's team metadata, carried by the goal row this team committed. */
export function teamOf(all, leaderSessionId) {
  const goal = all.filter(row => row.entityId.startsWith('team-goal:')).at(-1) ?? null;
  if (!goal) return null;
  const visibleLeader = all.some(row => row.entityId.startsWith('member:') && row.role === 'root');
  return { name: goal.objective ?? null, leaderSessionId: visibleLeader ? leaderSessionId : null,
    createdAt: goal.openedAt ?? null };
}

/**
 * P8: a delivery the outbox gave up on. The committed row is the source (the projected message keeps only the
 * lifecycle), and a row that carries no reason stays null rather than being given a sentence nobody wrote.
 */
export function deadLetterOf(message, row = null) {
  const committed = row?.deadLetter ?? message.deadLetter ?? null;
  if (committed) return committed;
  if (message.lifecycle !== 'dead-letter') return null;
  return { reason: row?.reason ?? null, at: message.receipts?.stored?.at ?? null, suggestedRecipient: null };
}

/** Build every M6 block on top of the legacy envelope. `canSee` is view.mjs's one visibility predicate. */
export function panelBlocks(data, { all, me, actor, allowed, now, leaderSessionId, commandPolicy, authorityRows }) {
  // Every raw input (including lookups) uses the current policy, never the historical row ACL.
  all = all.filter(allowed);
  const rows = new Map(all.map(row => [row.entityId, row]));
  const caps = (kind, object) => capabilitiesFor(kind, object, me, actor,
    // Internal gates may depend on private facts. They yield only a boolean and a static, safe reason.
    // Never merge authorityRows into the display inputs above.
    { ...commandPolicy, rows: authorityRows });
  const messages = data.messages.map(message => ({ ...message, deadLetter: deadLetterOf(message, rows.get(message.id)),
    capabilities: caps('message', message) }));
  const unknownEffects = data.unknownEffects.map(effect => {
    const tickets = all.filter(row => row.entityId.startsWith('effect-evidence:') && row.effectId === effect.id);
    const shaped = { ...effect,
      class: String(effect.id).startsWith('read-model:') ? 'read-model' : 'effect',
      effectKind: all.find(row => row.entityId === effect.id)?.payload?.kind ?? null,
      evidence: tickets.map(ticket => ({ at: ticket.at ?? null, text: ticket.message ?? null, ref: ticket.entityId }))
        .sort((left, right) => (left.at ?? 0) - (right.at ?? 0)) };
    return { ...shaped, capabilities: caps('unknownEffect', shaped) };
  });
  const base = { ...data, messages, unknownEffects,
    panelDecisions: all.filter(row => row.entityId.startsWith('decision:')) };
  const members = base.members.map(member => {
    const wait = member.wait ? { ...member.wait, targetLabel: targetLabelOf(member.wait, base, rows) } : null;
    const attempt = member.attempt ? { ...member.attempt, capabilities: caps('attempt', member.attempt) } : null;
    const next = { ...member, attempt, activity: activityOf(member), wait };
    return { ...next, history: historyOf(next, base), capabilities: caps('member', next) };
  });
  const shaped = { ...base, members,
    tasks: base.tasks.map(task => ({ ...task, capabilities: caps('task', task) })),
    threads: base.threads.map(thread => ({ ...thread, capabilities: caps('thread', thread) })) };
  const intents = all.filter(row => row.entityId.startsWith('message:') && row.kind === 'intent')
    .map(intentOf);
  const escalations = escalationsOf(shaped, me, all, now);
  const team = teamOf(all, leaderSessionId);
  const blocks = {
    members: shaped.members,
    tasks: shaped.tasks,
    threads: shaped.threads,
    messages,
    unknownEffects,
    intents,
    escalations,
    summary: summaryOf(shaped, members, escalations),
    memberSummary: memberSummaryOf(shaped, members),
    delivery: deliveryOf(shaped.tasks),
    viewerRole: me.role === 'subCoordinator' ? 'coordinator' : me.role,
  };
  // A team that never committed a goal row has no title metadata: the block stays absent, not empty.
  if (team !== null) blocks.team = team;
  return blocks;
}
