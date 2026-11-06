// Split of the former src/ui.mjs (M6 WP-3): situation. Pure move, no behaviour change.
import {
  goalInfo, approvalsKnown, memberName, needsYou, relTime, utc, clock, hasDeadline, borrowAttention, capacityView, laneText, roleGuardView,
  inputsView, resourceThreadsOf, unknownOccupants
} from '../model.mjs';
import { h, Fragment, useState } from './atoms.mjs';
import { TEAM, useNow, useUi, cx, UNKNOWN, WHY, num, Glyph } from './atoms.mjs';
import { TASK_STAGE_TEXT, DELIVERY_TEXT, MESSAGE_LIFECYCLE_TEXT } from '../labels.mjs';
import { readOnlyViewer, v1ReadStates, commandFor } from './commands.mjs';
// ── situation bar ────────────────────────────────────────
export function MockMenu() {
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
export function SourceBadge({ st }) {
  if (st.sourceKind === 'mock') return null;
  const label = TEAM.source?.describe().label ?? st.sourceKind;
  return h('span', { className: 'tm-badge', 'data-source': st.sourceKind, title: `投影 ${label} · viewer ${st.viewer ?? UNKNOWN}（来自投影 envelope / 事件的认证 principal）` },
    '投影', h('span', { className: 'tm-mock-label' }, ` · ${st.viewer ? memberName(st.data, st.viewer) : '无 viewer'}`));
}
/**
 * Connection health from the activity clock: the newest business event OR liveness comment (SSE `: heartbeat`).
 * Heartbeats never advance seq or data; they only prove the stream is alive.
 */
export function healthOf(st, fresh, now) {
  const last = Math.max(st.lastEventAt ?? 0, st.lastActivityAt ?? 0);
  const agoMs = last ? Math.max(0, now - last) : null;
  const level = fresh.level === 'error' ? 'error' : fresh.level === 'stale' ? 'stale' : !st.streamOpen ? (st.streamClosedAt != null ? 'reconnecting' : 'connecting')
    : fresh.level === 'lagging' ? 'lagging' : 'healthy';
  const text = { healthy: '连接健康', lagging: '心跳延迟', reconnecting: '重连中', connecting: '连接中', stale: '投影过期', error: '连接错误' }[level];
  return { level, text, agoMs, heartbeat: fresh.heartbeat !== false };
}
export function Health({ st, fresh }) {
  const now = useNow();
  const hl = healthOf(st, fresh, now);
  const ago = hl.agoMs == null ? '' : ` · 活动 ${hl.agoMs < 1000 ? '<1' : Math.round(hl.agoMs / 1000)}s 前`;
  return h('span', { className: 'num tm-fresh-text', 'data-health': hl.level,
    title: `最后业务事件 ${clock(st.lastEventAt)} · 最后心跳 ${st.lastActivityAt ? `${clock(st.lastActivityAt)}（${st.lastActivityKind}）` : '—'}${hl.heartbeat ? '' : ' · 该源没有心跳通道'}；心跳只更新活动时间，不推进 seq` },
    `${hl.text}${ago}`);
}
export function Situation({ data, st, now, fresh, c, onDetail }) {
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
export function NeedsYou({ data, now, ui, st }) {
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
export function BorrowStatus({ data, st }) {
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
export function RuntimeStates({ data, now }) {
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
export function EscalationRow({ item, onOpen }) {
  const line = [item.why, waitedText(item.waitingMs), item.consequence].filter(Boolean).join(' · ');
  const primary = item.primary && item.primary.label ? item.primary : null;
  return h('div', { className: 'tm-v3-ask', 'data-sev': item.severity, 'data-escalation': item.id },
    h('div', { className: 'tm-v3-ask-q' }, h('b', null, item.question),
      h('span', null, primary ? line : (item.note ?? line))),
    primary ? h('button', { className: 'tm-btn tm-btn-primary', type: 'button', 'data-escalation-action': item.id,
      onClick: () => onOpen(item) }, primary.label) : null);
}

export function EscalationList({ data, ui, readOnly }) {
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
export function DeliveryProgress({ delivery }) {
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
export function MemberSummaryLine({ summary, onOpen }) {
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

export function NowPage({ data, st, now }) {
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

export function CapacityDetail({ data, now, id }) {
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

