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
export function nextSidebarTab(prevContext, nextContext, currentTab) {
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
export function frameTransition({ prevSessionId, sessionId, viewing, members }) {
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

export function createUiStore(storage, tabStorage) {
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
