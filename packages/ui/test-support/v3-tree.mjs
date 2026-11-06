// M6 WP-4 offline render helpers: the React stub the other ui suites use, plus the tree walkers the v3 acceptance needs.
// No DOM is created. "Visible text" follows <details open>: a closed disclosure shows only its summary, which is
// exactly what a person can read without expanding it (15 §9 V-05/V-06).
import { createUiStore } from '../src/store.mjs';

export const NOW = Date.UTC(2026, 10, 2, 12, 0);
/** 15 §9 V-05: identifiers and state-machine words that must never be visible in the default view. */
export const HUMAN_RE = /(member|task|thread|message|attempt|delivery):|\b(admitted|collecting|stored|visible|desired|observed|fence)\b|att#|L✓|F\d/;

export function installReact() {
  globalThis.React = { createElement: (type, props, ...children) => ({ type, props, children }), Fragment: Symbol('Fragment'),
    useState: value => [typeof value === 'function' ? value() : value, () => {}], useEffect: () => {},
    useRef: value => ({ current: value }), useSyncExternalStore: (_sub, get) => get(), useMemo: x => x, useCallback: x => x };
  globalThis.ReactDOM = { createPortal: () => null };
}

export const loadUi = () => import('../src/ui.mjs');

export function snapshotOf(data, viewer) {
  return { data, viewer, status: 'live', asOfSeq: 100, sourceRevisions: {}, sourceKind: 'mock', lastEventAt: NOW,
    lastSnapshotAt: NOW, lastActivityAt: NOW, lastActivityKind: 'event', streamOpen: true, serverStale: false };
}

/** Wire the module singletons the plugin would set, and return the fresh UI store. */
export function wire(TEAM, data, viewer, options = {}) {
  const state = createUiStore(options.storage ?? null, options.tabStorage ?? null);
  const snapshot = options.snapshot ?? snapshotOf(data, viewer);
  const client = { subscribe: () => () => {}, getSnapshot: () => snapshot, resync() {} };
  Object.assign(TEAM, { client, scope: null, ui: state, gateway: null, source: options.source ?? null,
    nav: { openRoot() {}, openMember() {}, hasPane: () => false, showTeam() {}, leaveTeamView() {} } });
  return state;
}

/** Expand the element tree (function components included) and collect every element node. */
export function nodes(node, out = []) {
  if (node == null || typeof node === 'boolean') return out;
  if (Array.isArray(node)) { for (const child of node) nodes(child, out); return out; }
  if (typeof node !== 'object') return out;
  if (!Object.hasOwn(node, 'type')) throw Error('Objects are not valid as a React child');
  if (typeof node.type === 'function') return nodes(node.type({ ...node.props, children: node.children }), out);
  if (node.type === React.Fragment) return nodes(node.children, out);
  out.push(node);
  for (const child of node.children ?? []) nodes(child, out);
  return out;
}

/** Every string in the tree, closed disclosures included (the DOM keeps their text too). */
export function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node !== 'object') return String(node);
  if (typeof node.type === 'function') return textOf(node.type({ ...node.props, children: node.children }));
  if (node.type === React.Fragment) return textOf(node.children);
  return textOf(node.children);
}

/** Only what is on screen: a <details> without `open` contributes its summary, not its body. */
export function visibleText(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(visibleText).join(' ');
  if (typeof node !== 'object') return String(node);
  if (typeof node.type === 'function') return visibleText(node.type({ ...node.props, children: node.children }));
  if (node.type === React.Fragment) return visibleText(node.children);
  if (node.type === 'details' && node.props?.open === undefined) return visibleText(node.children?.[0] ?? []);
  return visibleText(node.children);
}

export const buttons = node => nodes(node).filter(n => n.type === 'button');
export const byProp = (node, key, value) => nodes(node).filter(n => n.props?.[key] === value);
export const rowsOf = tree => nodes(tree).map(n => n.props?.['data-member']).filter(Boolean);