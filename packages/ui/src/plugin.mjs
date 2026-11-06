// Browser entry: registers Team surfaces on existing slots + the two optional C2 seats.
/* global React */
import { ProjectionClient, resolveTeamConfig, TEAM_CONFIG_GLOBAL } from './projection.mjs';
import { createMockSource } from './mock.mjs';
import { TeamScope } from './scope.mjs';
import { createRealSource } from './real-source.mjs';
import { rootMember } from './model.mjs';
import { createUiStore } from './store.mjs';
import { CSS } from './styles.mjs';
import { TEAM, TeamPage, TeamIcon, RosterWrapper, MemberFrame, TeamPaneTab, TeamPaneTitle, SessionMini } from './ui.mjs';

export const PANEL_ID = 'team';
/** Right-sidebar tab type (09 §4.1 sidebar.right.pane.tab): `id` keys the body/title seats, `kind` is what openTab names. */
export const PANE_TAB = Object.freeze({ id: '@dsh-v2/client-team/detail', kind: 'teamDetail', priority: 'extension', title: () => 'Team 详情' });
/** Services this browser plugin needs from the DSH client context. */
export const inject = ['slots', 'layout', 'uiWorkspace', 'sessions'];

/**
 * Runtime source/gateway injection point. `config` comes from `globalThis.__DSH_TEAM__`, which the host half
 * (index.mjs) publishes into the natively-authenticated index page only when the team profile configures
 * `source: 'http'`. No config → mock source (stage-1 behaviour). Returns `{source, gateway, control}`.
 * @param {import('./projection.mjs').TeamSourceConfig} config
 */
export function createTeamSource(config, binding = null) {
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
export function apply(ctx) {
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
