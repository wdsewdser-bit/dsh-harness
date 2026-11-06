// Split of the former src/ui.mjs (M6 WP-3): commands. Pure move, no behaviour change.
/* global React, ReactDOM */
import { ROLE_LABEL, ackSummary, memberName, relTime, capacityView, roleGuardView, inputsView } from '../model.mjs';
import { freshness, unsupportedReason } from '../projection.mjs';
import { principalId, viewerReadOnly, commandAdmission, commandObject } from '../authority.mjs';
import { h, useState, useEffect, useRef } from './atoms.mjs';
import { RECEIPT_STATUS_TEXT, receiptSeverity, TEAM, useNow, useClient, useUi, viewerOf, dataOf, kname, UNKNOWN, num, Field } from './atoms.mjs';
export const TASK_SEV = { blocked: 'warn', failed: 'bad', cancelled: 'frozen', accepted: 'done' };
export function TaskCell({ task, member }) {
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
export const SUMMARY_MAX = 2000;
/**
 * Administrative writes (retire, escalation, mailbox cancel/rebind/adjudication, contract approval, delivery
 * verdict) are operator/root only on the server. The UI never decides authority: it disables the control with
 * the reason so a viewer that is not the operator is not misled (09 §3.3). The operator works through the root
 * principal (projection.mjs), so "operator" or the root member both count.
 */
export const ADMIN_ONLY = '只有 operator / root 能执行这个命令（由服务端按身份判定）';
/**
 * The two unknown verdicts are operator-only in the strict sense: the server admits the literal 'operator' principal and
 * refuses every member, root included (core/mailbox.mjs and delivery/index.mjs pass operatorOnly). That is the
 * design, not a bug: an unknown external effect is adjudicated by the operator, and root is a team role. A browser can
 * only authenticate as a member, so the panel must never offer the command as if it were yours -- it shows the row and
 * says who owns the verdict. ADJUDICATOR mirrors the server rule in one place instead of being re-derived per call.
 */
export const ADJUDICATOR = 'operator';
export const ADJUDICATION_ONLY = '未知效果的裁决只属于 operator：服务端按身份拒绝 root 与所有成员（ROLE_DENIED）。这里只展示对象与证据，' +
  '裁决请由 operator 侧提交；不要通过放宽授权绕过它。';
/**
 * A prepared/authorized completion token freezes the control plane: the server refuses every write outside
 * completion:/inconsistency: with COMPLETION_FROZEN (core/index.mjs, operator-command.mjs, tools.mjs). The UI has to
 * say that before the click instead of letting the operator fill a form and be refused, so every administrative write
 * asks this first. It is a committed projection fact (goal.completionToken), not a guess.
 */
export const FROZEN_TOKEN_STATES = ['prepared', 'authorized', 'unknown'];
export function frozenReason(data) {
  const token = (data ?? dataOf())?.goal?.completionToken;
  return FROZEN_TOKEN_STATES.includes(token)
    ? `完成 token 处于 ${token} 状态：控制面已冻结（COMPLETION_FROZEN），除 completion/inconsistency 外的写命令都会被拒绝。先由原生侧完成或撤销该 token。`
    : null;
}
/** Server refusal codes, in the words the operator needs; the raw code stays visible beside it. */
export const ERROR_TEXT = {
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
export function explainError(message) {
  const text = String(message ?? '');
  const code = text.match(/[A-Z][A-Z0-9_]{2,}/)?.[0] ?? null;
  return { code, explanation: code ? ERROR_TEXT[code] ?? null : null, raw: text };
}
export function canAdminister(data, viewer = viewerOf()) {
  return !viewerReadOnly(data ?? dataOf(), viewer);
}
/**
 * v3 §4 "viewer 只读": an authenticated viewer that is a team member but neither the operator principal nor root.
 * An absent/unknown principal is not described as read-only (nothing can be asserted about its permissions).
 */
export function readOnlyViewer(data, viewer = viewerOf()) {
  if (!data || !viewer) return false;
  const id = principalId(viewer, data.team?.teamId);
  const known = data.viewerRole ?? data.members?.find(m => m.id === id)?.role;
  return known ? viewerReadOnly(data, viewer) : false;
}
/**
 * The P5 v1 read states (capacity / role guard / batch manifest) are published only by a v1 projection. Off teams
 * carry none of them, which is what keeps the off surface's rendering exactly HEAD's until the M6 page rewrite.
 */
export const v1ReadStates = data => !!(capacityView(data) || roleGuardView(data) || inputsView(data));
/** Why `name` cannot be submitted as this viewer, and whether that must hard-disable the button (not just a note). */
export function gateOf(name, data, viewer) {
  const unsupported = unsupportedReason(name);
  if (unsupported) return { reason: unsupported, hard: true };
  // Permission first, then the freeze: a viewer who could never run the command must not be told the reason is a
  // completion token it cannot see (read-model rows are root's).
  if (!canAdminister(data, viewer)) return { reason: ADMIN_ONLY, hard: true };
  const frozen = frozenReason(data);
  return frozen ? { reason: frozen, hard: true } : { reason: null, hard: false };
}
/** A verdict must be chosen explicitly: no default, the operator records what the evidence shows. */
export const DECISION_OPTIONS = [['effective', 'effective（外部效果确实生效）'], ['not-effective', 'not-effective（外部效果未生效）'],
  ['abandoned', 'abandoned（放弃该对象，保留 quarantine）']];
export const decisionField = () => ({ key: 'decision', label: '裁决结论', type: 'radio', required: true, value: '', options: DECISION_OPTIONS });
export const evidenceField = () => ({ key: 'evidenceRef', label: '证据引用（evidenceRef）', type: 'text', required: true, value: '',
  validate: v => /^[a-z][a-z-]*:\S+$/i.test(v) ? null : '需要 <kind>:<id> 形式的已存在实体（如 artifact:…）' });
/** A retire is one intent, not one per click: the id is derived from member + generation so a repeat is a replay. */
export function retireOperationId(m) {
  // The server publishes operationId ^v1:operation:[A-Za-z0-9._-]{8,128}$, so a projected id (member:worker) is
  // flattened rather than pasted: one stable, publishable id per member and generation.
  return 'v1:operation:ui-retire-' + String(m.id).replace(/[^A-Za-z0-9._-]/g, '-') + '-g' + (m.generation ?? 1);
}
/** While the retirement is in flight the button is disabled and reports how long it has waited (09 §5.5). */
export function retireAction(m, now) {
  if (!(m.desired === 'retired' && m.observed !== 'retired')) return { disabled: false, label: '退役…', waited: null };
  const since = m.pendingLifecycle?.since ?? null;
  const waited = typeof since === 'number' && since > 0 ? Math.max(0, now - since) : null;
  return { disabled: true, waited, label: waited === null ? '退役请求中 · 等待原生确认' : '退役请求中 · 已等待 ' + relTime(waited) };
}
/** Each palette is a new observation; keep its id for retry, but never collide after reload or in another client. */
export function resourceOperationId() {
  return 'v1:operation:ui-publish-' + globalThis.crypto.randomUUID();
}
/**
 * P5: which resource-thread actions this viewer may see. The rule mirrors the server (self only, root may proxy by
 * name, only owner/root closes) and is used to render nothing rather than a disabled button. The server remains the
 * authority: a forged request gets ROLE_DENIED/DENIED, and an unauthorized request nobody handles stays refused.
 */
export function resourceActions(data, thread, viewer = viewerOf()) {
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

export function commandFor(kind, obj, data, viewer = viewerOf()) {
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
export { CommandPalette } from './palette.mjs';

