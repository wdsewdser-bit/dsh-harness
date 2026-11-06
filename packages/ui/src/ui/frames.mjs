// Split of the former src/ui.mjs (M6 WP-3): frames. Pure move, no behaviour change.
import {
  SEVERITY, ctxLevel, contextKnown, ROLE_ABBR, ROLE_LABEL, StableOrder, counts, deadlineSeverity, groupRows, rootMember, memberName, memberSeverity,
  needsYou, relTime, truncate, sessionMember, miniStatus
} from '../model.mjs';
import { h, Fragment, useEffect, useRef } from './atoms.mjs';
import { TEAM, useNow, useClient, useUi, cx, memberById, UNKNOWN, num, Glyph, CtxBar, CmdButton } from './atoms.mjs';
import { readOnlyViewer, commandFor, CommandPalette } from './commands.mjs';
import { isCollapsed, Tally } from './lanes.mjs';
import { Detail } from './detail.mjs';
import { DrawerTrap } from './page.mjs';
function scopedSessionMember(data, sessionId, ui, state) {
  if (TEAM.scope && (state.sessionId !== sessionId || !state.binding)) return null;
  return sessionMember(data, sessionId, ui) ?? (TEAM.scope && state.binding?.memberId
    ? memberById(data, state.binding.memberId) : null);
}
// ── left roster (sidebar.body.wrapper, C2-a/b) ───────────
export function RosterWrapper({ collapsed, children }) {
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
export function MemberFrame({ children, sessionId }) {
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
export function TeamPaneTab({ sessionId }) {
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
export function TeamPaneTitle({ sessionId }) {
  const st = useClient(), ui = useUi();
  const owner = scopedSessionMember(st.data, sessionId, ui, st);
  return h(Fragment, null, h(TeamIcon, { size: 14 }), owner ? ` Team · ${truncate(owner.name, 16)}` : ' Team 详情');
}

// ── session-header mini strip (conversation.session.header.actions, 09 §2.1 L0 mini / §3.2 会话头部条) ──
/** Compact Team status beside a member session's title: role, status, unread (未接责) and pending approvals. Non-Team sessions: nothing. */
export function SessionMini({ sessionId, teamSessionId }) {
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

export function TeamIcon({ size = 16 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('circle', { cx: 12, cy: 7, r: 3 }), h('circle', { cx: 5, cy: 10, r: 2.2 }), h('circle', { cx: 19, cy: 10, r: 2.2 }),
    h('path', { d: 'M6.5 20c0-3.3 2.5-6 5.5-6s5.5 2.7 5.5 6' }), h('path', { d: 'M1.5 19c0-2.2 1.5-4 3.5-4.2M22.5 19c0-2.2-1.5-4-3.5-4.2' }));
}
