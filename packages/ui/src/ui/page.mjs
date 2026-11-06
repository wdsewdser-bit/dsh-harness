// M6 WP-4 (16 §3): the team page. Three subpages over one projection; the inspector is a right rail that only
// exists while something is selected. The page renders the projection's summary verbatim — it never re-derives it.
import { clock, goalInfo } from '../model.mjs';
import { freshness } from '../projection.mjs';
import { VIEWER_ROLE_TEXT } from '../labels.mjs';
import { h, Fragment, useState, useEffect, useRef } from './atoms.mjs';
import { TEAM, useNow, useClient, useUi, cx, isEditable, Glyph } from './atoms.mjs';
import { CommandPalette, readOnlyViewer } from './commands.mjs';
import { NowPage } from './situation.mjs';
import { MembersPage } from './lanes.mjs';
import { RecordsPage } from './records.mjs';
import { Inspector } from './detail.mjs';
// ── page (main keyed "team") ─────────────────────────────
export function useWidth(ref) {
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

export function handleDetailsKey(e) {
  if (e.key !== '.' || e.defaultPrevented || e.repeat || isEditable(e.target) || e.metaKey || e.ctrlKey || e.altKey) return false;
  e.preventDefault(); TEAM.ui.toggleDetails(); return true;
}
export function TeamPage(props = {}) {
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
export function DrawerTrap({ children }) {
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
