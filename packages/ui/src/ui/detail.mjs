import { humanText, referenceIds } from '../human-text.mjs';
// Split of the former src/ui.mjs (M6 WP-3): detail. Pure move, no behaviour change.
import {
  contextKnown, ROLE_ABBR, ROLE_LABEL, ackSummary, deadlineSeverity, rootMember, memberSeverity, relTime, utc, clock, shortId, truncate, taskAttempts,
  deliveryInfo, hasDeadline, resourceThreadsOf
} from '../model.mjs';
import { unsupportedReason } from '../projection.mjs';
import { MEMBER_STEP_TEXT } from '../labels.mjs';
import { recordPresentation } from '../activity.mjs';
import { h, Fragment } from './atoms.mjs';
import {
  TEAM, cx, memberById, viewerOf, dataOf, kname, UNKNOWN, WHY, num, counter, Glyph, pctText, CtxBar, Lease, WaitCell, CmdButton
} from './atoms.mjs';
import { TASK_SEV, readOnlyViewer, retireAction, resourceActions, commandFor } from './commands.mjs';
import { RuntimeStates, CapacityDetail } from './situation.mjs';
import { memberDoing, memberStatus } from './lanes.mjs';
// ── details (L2) ─────────────────────────────────────────
export const TABS = [['member', '成员'], ['task', '任务'], ['thread', '线程'], ['resource', '资源'], ['message', '消息'], ['context', '上下文']];
export function Detail({ data, now, ui, onOpen, className }) {
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
export function History({ items }) {
  if (!items?.length) return h('span', { className: 'tm-cap', title: '投影没有已提交的生命周期记录' }, UNKNOWN);
  const words = s => typeof s === 'string' ? s : s?.text ?? UNKNOWN;
  const chain = h('div', { className: 'tm-history' }, items.map((step, i) => { const s = words(step); return h(Fragment, { key: i }, i ? h('span', null, '→') : null, i === items.length - 1 ? h('b', null, s) : h('span', null, s)); }));
  if (items.length === 1) return chain;
  return h('details', { className: 'tm-disclose', 'data-l2': 'history' }, h('summary', null, h('b', null, words(items[items.length - 1])), h('span', { className: 'tm-fg3' }, `  ▸ 历史 ${items.length} 步`)), chain);
}
/** Generic L2 disclosure: a one-line summary that expands to the evidence (native <details>, keyboard accessible). */
export function Disclose({ id, summary, children }) {
  return h('details', { className: 'tm-disclose', 'data-l2': id }, h('summary', null, summary), h('div', { className: 'tm-disclose-body' }, children));
}
export function MemberDetail({ data, now, id, onOpen, v3 = false }) {
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
export function MemberActions({ data, now, id, onOpen }) {
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
export const unknownCap = why => h('span', { className: 'tm-cap', title: why }, UNKNOWN);
export const attemptRow = a => h('div', { key: a.n, className: a.supersededBy ? 'tm-fg3' : undefined }, h('span', { className: 'num' }, `#${a.n}`), ` ${a.state}`, a.supersededBy ? `（已被 #${a.supersededBy} 取代）` : '');
/** L2 task card (09 §3.2 右栏·任务): contract, attempts (superseded kept behind a disclosure), delivery, certificate binding, merge. */
export function TaskCard({ task }) {
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
export function BindingView({ b, task }) {
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
export function TaskView({ data, ui, id }) {
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
export const THREAD_SEV = { open: 'wait', collecting: 'wait', deciding: 'warn', escalated: 'bad', decided: 'ok', closed: 'frozen', cancelled: 'frozen', superseded: 'frozen' };

// ── v3 §3.4 inspector (right rail / drawer) ─────────────
function recordRow(data, id) {
  for (const key of ['tasks', 'threads', 'messages', 'decisions']) {
    const row = (data?.[key] ?? []).find(item => item.id === id);
    if (row) return row;
  }
  return null;
}

export function RecordDetail({ data, now, event, id, ui }) {
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
export function MemberInspector({ data, now, id, ui, onOpen }) {
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

export function Inspector({ data, now, ui, onOpen }) {
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

export function ThreadView({ data, now, id }) {
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
export const RESOURCE_ACTION_LABEL = { subscribeResource: '订阅…', unsubscribeResource: '退订…',
  publishResource: '发布报告…', closeResource: '关闭资源线程…' };
export function resourceKeyText(resource) {
  const key = resource?.key;
  if (key && typeof key === 'object') return [key.provider, key.repository, key.number == null ? null : '#' + key.number].filter(Boolean).join('/');
  return String(key ?? '');
}
export function resourceLabel(thread) {
  return (thread.resource?.kind ?? 'resource') + ' · ' + truncate(resourceKeyText(thread.resource), 48);
}
/**
 * P5: resource threads are shown beside decision threads, never inside them. The panel renders only the actions this
 * viewer may take (v3 §1: no disabled permission buttons) and never creates a notification; the list is read on the
 * resource tab. Subscription/authorization is still the server's, this is only what the viewer can see.
 */
export function ResourceView({ data, now, id }) {
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
export function Receipts({ m }) {
  const r = m.receipts;
  const row = (name, rec, text) => [h('span', { key: name + 'n', className: 'tm-fg3' }, name), h('span', { key: name + 'd', className: 'tm-r-dot', 'data-on': String(!!rec) }),
    h('span', { key: name + 't', className: 'num' }, rec ? clock(rec.at) : '—'), h('span', { key: name + 'e', className: cx(!rec && 'tm-fg3'), style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, text)];
  return h('div', { className: 'tm-receipts' },
    row('stored', r.stored, r.stored?.evidence ?? ''),
    row('visible', r.visible, r.visible ? `req ${r.visible.requestId} · manifest ${shortId(r.visible.manifest)} · seq ${r.visible.seq}` : m.kind === 'info' ? '（info 不要求接责）' : '（尚未进入受观测请求）'),
    row('accepted', r.accepted, r.accepted ? `checkpoint ${r.accepted.checkpoint}` : m.kind === 'info' ? '' : '（等待 ackResponsibility）'));
}
export function MessagesView({ data, now, ui }) {
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
export function ContextView({ data, now, id }) {
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

