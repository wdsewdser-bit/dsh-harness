// v3 visual acceptance (P5 review), offline render assertions over the projected tree.
// 1) the v1 read states (capacity N/H, role guard, batch manifest) are on-demand detail, never a standing alert;
// 2) "needs you" folds past three rows into "还有 n 条";
// 3) an unknown capacity occupancy is a person's safety row with a detail (effectId, duration, disposition), no command;
// 4) a viewer that is a member but not operator/root is read-only: badge, no write buttons, count-only needs you.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createUiStore } from '../src/store.mjs';
import { scenarioBorrow, scenarioDefault, MOCK_VIEWER, withPanelBlocks } from '../src/mock.mjs';
import { needsYou } from '../src/model.mjs';
import { CSS } from '../src/styles.mjs';

globalThis.React = { createElement: (type, props, ...children) => ({ type, props, children }), Fragment: Symbol('Fragment'),
  useState: value => [typeof value === 'function' ? value() : value, () => {}], useEffect: () => {},
  useRef: value => ({ current: value }), useSyncExternalStore: (_sub, get) => get(), useMemo: x => x, useCallback: x => x };
globalThis.ReactDOM = { createPortal: () => null };
const uiModule = await import('../src/ui.mjs');
const { TEAM, TeamPage, Detail, NeedsYou, RuntimeStates, readOnlyViewer, commandFor } = uiModule;
const { Inspector } = await import('../src/ui/detail.mjs');

const NOW = Date.UTC(2026, 10, 2, 12, 0);
const WORKER = 'member:worker-a';
const store = () => createUiStore({ storage: null, tabStorage: null });
const snapshot = (data, viewer) => ({ data, viewer, status: 'live', asOfSeq: 100, sourceRevisions: {}, sourceKind: 'mock',
  lastEventAt: NOW, lastSnapshotAt: NOW, lastActivityAt: NOW, lastActivityKind: 'event', streamOpen: true, serverStale: false });
/** Wire the module singletons the plugin would set, and return a fresh UI store. */
const wire = (data, viewer) => {
  const state = store();
  const client = { subscribe: () => () => {}, getSnapshot: () => snapshot(data, viewer), resync() {} };
  Object.assign(TEAM, { client, ui: state, gateway: null, nav: { openRoot() {}, openMember() {}, hasPane: () => false, showTeam() {} } });
  return state;
};
/** Expand the element tree (function components included) and collect every element node. */
function nodes(node, out = []) {
  if (node == null || typeof node === 'boolean') return out;
  if (Array.isArray(node)) { for (const child of node) nodes(child, out); return out; }
  if (typeof node !== 'object') return out;
  if (typeof node.type === 'function') return nodes(node.type({ ...node.props, children: node.children }), out);
  if (node.type === React.Fragment) return nodes(node.children, out);
  out.push(node);
  for (const child of node.children ?? []) nodes(child, out);
  return out;
}
const textOf = node => {
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node !== 'object') return String(node);
  if (typeof node.type === 'function') return textOf(node.type({ ...node.props, children: node.children }));
  if (node.type === React.Fragment) return textOf(node.children);
  return textOf(node.children);
};
const buttons = node => nodes(node).filter(n => n.type === 'button');

test('v3 §3.4: capacity N/H, role guard denials and the batch manifest are a closed on-demand disclosure', () => {
  const data = scenarioBorrow(NOW);
  const tree = RuntimeStates({ data, now: NOW });
  assert.equal(tree.type, 'details');
  assert.equal(tree.props['data-l2'], 'runtime');
  assert.equal(tree.props.open, undefined, 'collapsed by default');
  const body = textOf(tree);
  assert.match(body, /普通 5\/8/, 'normal lane N/H');
  assert.match(body, /交互 1\/1/, 'human lane N/H');
  assert.match(body, /拒绝 3/, 'role-guard denials are shown, as data');
  assert.match(body, /pending 4/);
  assert.match(body, /omitted 1/);
  assert.equal(nodes(tree).filter(n => String(n.props?.className ?? '').includes('tm-alert')).length, 0, 'not an alert');
  assert.equal(nodes(tree).filter(n => n.props?.['data-sev'] === 'bad').length, 0, 'busy counts never become alarms');
  // No block published (off team) → nothing at all, which keeps the off rendering HEAD's.
  assert.equal(RuntimeStates({ data: scenarioDefault(NOW), now: NOW }), null);
  // Reachable from every tab of the right pane, still closed.
  wire(data, MOCK_VIEWER);
  for (const tab of ['member', 'task', 'thread', 'resource', 'message', 'context']) {
    const state = store(); state.setTab(tab);
    const detail = Detail({ data, now: NOW, ui: state.getSnapshot(), onOpen: () => {} });
    const runtimes = nodes(detail).filter(n => n.props?.['data-l2'] === 'runtime');
    assert.equal(runtimes.length, 1, tab);
    assert.equal(runtimes[0].props.open, undefined, tab);
  }
});

test('gap 3: the capacity detail names the provider state, so a local queue is not read as an upstream limit', () => {
  const data = scenarioBorrow(NOW), capacity = data.capacity;
  const line = extra => textOf(nodes(RuntimeStates({ data: { ...data, capacity: { ...capacity, ...extra } }, now: NOW }))
    .find(node => node.props?.['data-runtime'] === 'provider'));
  assert.match(line({ providerCapacity: 'available', providerWait: 'local-queued' }), /provider 可用[\s\S]*本地排队/);
  assert.match(line({ providerCapacity: 'throttled', providerWait: 'provider-throttled', providerRecoveryAt: NOW + 45000 }),
    /provider 限流（throttled）[\s\S]*上游 429\/限流[\s\S]*45s后重新观察/);
  const unknown = line({ providerCapacity: 'unknown', providerWait: 'none', providerRecoveryAt: null });
  assert.match(unknown, /provider 状态未知/);
  assert.doesNotMatch(unknown, /可用/, 'an unknown provider is never rendered as available');
});

test('v3 §3.1: more than three needs-you rows fold into 还有 n 条', () => {
  const data = scenarioBorrow(NOW);
  const state = wire(data, MOCK_VIEWER);
  const items = needsYou(data, NOW, MOCK_VIEWER);
  assert.ok(items.length > 3, 'the fixture has more obligations than the v3 fold');
  const view = () => NeedsYou({ data, now: NOW, ui: state.getSnapshot(), st: { viewer: MOCK_VIEWER } });
  const tree = view();
  const rows = buttons(tree).filter(n => n.props?.['data-need-action']);
  assert.equal(rows.length, 3, 'three rows are expanded by default');
  const more = buttons(tree).find(n => n.props?.className === 'tm-more');
  assert.ok(more, 'a fold control exists');
  assert.equal(textOf(more), '还有 ' + (items.length - 3) + ' 条');
  state.toggleAllNeeds();
  const expanded = buttons(view()).filter(n => n.props?.['data-need-action']);
  assert.equal(expanded.length, items.length, '展开后全部显示');
  // Nothing is folded when there is nothing more to show.
  const small = { ...data, approvals: [], goal: { ...data.goal, completionToken: 'none' }, unknownEffects: [], capacity: { ...data.capacity, admissionClosed:
    false, occupants: [] } };
  const smallTree = NeedsYou({ data: small, now: NOW, ui: store().getSnapshot(), st: { viewer: MOCK_VIEWER } });
  assert.equal(buttons(smallTree).some(n => n.props?.className === 'tm-more'), false);
});

test('v3 §4: an unknown capacity occupancy is a safety row whose primary action opens its detail (no command)', () => {
  const data = scenarioBorrow(NOW);
  const state = wire(data, MOCK_VIEWER);
  const items = needsYou(data, NOW, MOCK_VIEWER);
  const row = items.find(item => item.kind === 'capacity');
  assert.ok(row, 'the unknown occupant is in "needs you", not just an alert');
  assert.equal(row.owner, 'operator', 'adjudication is the operator\'s, not "you" for root');
  assert.equal(row.effectId, 'decision:borrow');
  const tree = NeedsYou({ data, now: NOW, ui: state.getSnapshot(), st: { viewer: MOCK_VIEWER } });
  const action = buttons(tree).find(n => n.props?.['data-need-action'] === row.id);
  assert.ok(action, 'the row is among the expanded rows');
  assert.equal(textOf(action).trim(), '查看详情');
  action.props.onClick();
  assert.deepEqual(state.getSnapshot().detail, { tab: 'capacity', id: row.id }, 'opens the detail');
  assert.equal(state.getSnapshot().palette, null, 'no server command is opened');
  const detail = Detail({ data, now: NOW, ui: state.getSnapshot(), onOpen: () => {} });
  const body = textOf(detail);
  assert.match(body, /effectId/);
  assert.match(body, /decision:borrow/);
  assert.match(body, /已持续 1m/, 'the published oldest age is the duration, not an invented one');
  assert.match(body, /处置说明/);
  assert.match(body, /不会按超时释放/);
  assert.equal(commandFor('capacity', {}, data), null, 'the client invents no command for it');
  // Admission closed is still a safety row when no occupant is listed.
  const closed = { ...data, capacity: { ...data.capacity, occupants: [] } };
  const admission = needsYou(closed, NOW, MOCK_VIEWER).find(item => item.id === 'capacity:admission');
  assert.ok(admission);
  assert.match(admission.title, /执行准入已关闭/);
});

test('v3 §4: a member viewer that is not operator/root is read-only — badge, no write buttons, count-only needs you', () => {
  const data = scenarioBorrow(NOW);
  assert.ok(data.members.some(m => m.id === WORKER));
  assert.equal(readOnlyViewer(data, WORKER), true);
  assert.equal(readOnlyViewer(data, MOCK_VIEWER), false, 'root is not read-only');
  assert.equal(readOnlyViewer(data, 'operator'), false);
  assert.equal(readOnlyViewer(data, 'member:nobody'), false, 'an unknown principal is not described as read-only');

  let state = wire(data, WORKER);
  state.setTab('message');
  const page = TeamPage();
  assert.equal(nodes(page).filter(n => n.props?.['data-readonly'] === 'viewer').length, 1, 'the title row carries the 只读 badge');
  const pageText = textOf(page);
  assert.equal(pageText.includes('取消…'), false, 'the cancel write button is hidden, not disabled');
  assert.equal(pageText.includes('改投…'), false, 'the rebind write button is hidden, not disabled');
  assert.match(pageText, /有 \d+ 件事在等组长决定/);
  assert.equal(buttons(page).filter(n => n.props?.['data-need-action']).length, 0, 'no needs-you action button');
  const needs = NeedsYou({ data, now: NOW, ui: state.getSnapshot(), st: { viewer: WORKER } });
  assert.equal(buttons(needs).length, 0, 'the needs-you section has no buttons at all');

  // M6 WP-4: the cancel/rebind writes left the page (they now live in the message tab of the right pane), so the
  // read-only viewer is checked where they moved to, and the v3 inspector offers no write at all.
  state.setTab('message');
  const messageText = textOf(Detail({ data, now: NOW, ui: state.getSnapshot(), onOpen: () => {} }));
  assert.equal(messageText.includes('取消…'), false, 'the cancel write is absent from the right pane too');
  assert.equal(messageText.includes('改投…'), false, 'the rebind write is absent from the right pane too');
  state.openInspector('member', WORKER);
  const inspectorText = textOf(Inspector({ data, now: NOW, ui: state.getSnapshot(), onOpen: () => {} }));
  assert.equal(inspectorText.includes('发话…'), false, 'the inspector has no message write for a read-only viewer');
  assert.equal(inspectorText.includes('退役…'), false, 'and no retire write');

  // Other right-pane write areas are hidden too.
  state.setTab('thread');
  const threadText = textOf(Detail({ data, now: NOW, ui: state.getSnapshot(), onOpen: () => {} }));
  assert.equal(threadText.includes('以 owner 身份决定…'), false);
  assert.equal(threadText.includes('升级 / 转交…'), false);
  state.setTab('member');
  const memberText = textOf(Detail({ data, now: NOW, ui: state.getSnapshot(), onOpen: () => {} }));
  assert.equal(memberText.includes('发话…'), false);
  assert.equal(memberText.includes('退役…'), false);

  // The root viewer keeps the work and the write buttons, in their new homes: the needs-you rows on the page (the
  // read-only viewer only ever gets their count) and the mailbox writes in the right pane.
  const panelData = withPanelBlocks(scenarioBorrow(NOW), MOCK_VIEWER, NOW);
  state = wire(panelData, MOCK_VIEWER);
  assert.equal(nodes(TeamPage()).filter(n => n.props?.['data-readonly'] === 'viewer').length, 0);
  assert.ok(panelData.escalations.length > 0, 'the projection publishes something that needs the owner');
  assert.equal(nodes(TeamPage()).filter(n => n.props?.['data-escalation']).length, panelData.escalations.length,
    'the root still gets the needs-you rows');
  state = wire(panelData, WORKER);
  assert.equal(nodes(TeamPage()).filter(n => n.props?.['data-escalation']).length, 0, 'the read-only viewer gets no row');
  assert.match(textOf(TeamPage()), new RegExp('有 ' + panelData.escalations.length + ' 件事在等组长决定'));
  state = wire(data, MOCK_VIEWER);
  state.setTab('message');
  const rootPane = textOf(Detail({ data, now: NOW, ui: state.getSnapshot(), onOpen: () => {} }));
  assert.ok(rootPane.includes('取消…'), 'the root keeps the cancel write where it now lives');
  assert.ok(rootPane.includes('改投…'), 'and the rebind write');
  state.openInspector('member', WORKER);
  const rootInspector = buttons(Inspector({ data, now: NOW, ui: state.getSnapshot(), onOpen: () => {} }));
  assert.ok(rootInspector.some(button => textOf(button).includes('发话…')), 'the inspector keeps the member actions for root');
});

test('v3 §3.1: the capacity primary button uses a theme-inverting colour pair that beats .tm button color:inherit', () => {
  const data = scenarioBorrow(NOW);
  const state = wire(data, MOCK_VIEWER);
  const row = needsYou(data, NOW, MOCK_VIEWER).find(item => item.kind === 'capacity');
  const view = NeedsYou({ data, now: NOW, ui: state.getSnapshot(), st: { viewer: MOCK_VIEWER } });
  const button = buttons(view).find(n => n.props?.['data-need-action'] === row.id);
  assert.ok(button, 'the capacity row renders its primary action');
  assert.ok(button.props.className.split(' ').includes('tm-btn-primary'), 'it is the primary variant');
  // The regression: `.tm button{color:inherit}` (0,1,1) beat a bare `.tm-btn-primary` (0,1,0), so the label took the
  // page foreground while the fill stayed --tm-fg — identical colours, an invisible label in both themes.
  const specificity = selector => {
    const classes = (selector.match(/\.[\w-]+/g) ?? []).length;
    const ids = (selector.match(/#[\w-]+/g) ?? []).length;
    const pseudos = (selector.match(/::?[\w-]+(\([^)]*\))?/g) ?? []).length;
    const elements = (selector.replace(/#[\w-]+|\.[\w-]+|::?[\w-]+(\([^)]*\))?/g, ' ')
      .match(/[a-z][\w-]*/gi) ?? []).length;
    return [ids, classes + pseudos, elements];
  };
  const beats = (a, b) => { const x = specificity(a), y = specificity(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
  const rules = [...CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, body]) => ({ selector: selector.trim(), body }));
  const primary = rules.find(rule => rule.selector.endsWith('.tm-btn-primary') && /color:var\(--tm-bg1\)/.test(rule.body));
  assert.ok(primary, 'the primary rule sets an explicit text colour');
  assert.ok(beats(primary.selector, '.tm button') > 0, primary.selector + ' must win over .tm button{color:inherit}');
  assert.match(primary.body, /background:var\(--tm-fg\)/, 'filled with the page foreground');
  assert.match(primary.body, /color:var\(--tm-bg1\)/, 'text uses the page background token');
  // Light: --tm-fg = label-primary (dark) on --tm-bg1 = bg-layer-1 (white). Dark: near-white on dark. Theme-inverted.
  assert.match(CSS, /--tm-fg:var\(--dsw-alias-label-primary\)/);
  assert.match(CSS, /--tm-bg1:var\(--dsw-alias-bg-layer-1\)/);
  // The disabled variant must keep the text readable too.
  const disabled = rules.find(rule => rule.selector.endsWith('.tm-btn-primary:disabled'));
  assert.ok(disabled && beats(disabled.selector, primary.selector) > 0, 'disabled beats the base rule');
  assert.match(disabled.body, /color:var\(--tm-fg3\)/);
});
