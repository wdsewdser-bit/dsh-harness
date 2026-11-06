// Semantics fixtures for 09 §8 A8 / A4 / A7 (pure, node --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { scenarioDefault, scenarioLarge, scenarioEmpty, createMockSource, MOCK_VIEWER } from '../src/mock.mjs';
import { memberSeverity, counts, needsYou, pipelineCounts, StableOrder, groupRows, ackSummary, deadlineSeverity, rootMember } from '../src/model.mjs';
import { ProjectionClient, applyEvent, freshness, FRESHNESS, GATE_RATIO } from '../src/projection.mjs';
// The bundle boundary forces ui to state the ratio itself (build.mjs strips imports); this is the pin that keeps the
// display copy equal to the one the server gates with (contracts, re-exported by packages/context).
import { GATE_RATIO as SERVER_GATE_RATIO } from '../../contracts/index.mjs';


import { NOW, data, M, sev } from '../test-support/model-fixtures.mjs';

test('groups: undescribed member groups get a bucket (never dropped); no context → max is null, not 0', () => {
  const d = { ...scenarioEmpty(), groups: [{ id: undefined, label: undefined, lead: null }],
    members: [{ ...data.members[0], group: undefined, context: null }, { ...data.members[3], id: 'member:new', name: 'new', group: 'late-group', context:
      null }] };
  const g = groupRows(d, NOW, new StableOrder());
  assert.equal(g.length, 2);
  assert.deepEqual(g.map(x => x.rows.length), [1, 1]);
  assert.equal(g[0].headless, true);
  assert.equal(g[1].group.undescribed, true);
  assert.equal(g[1].maxCtx, null);
});

// ── left "团队 / 工作区" tab: persistence + edge-triggered auto switch ─────
import { createUiStore, nextSidebarTab, frameTransition } from '../src/store.mjs';
const memStorage = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };
const TEAM_MEMBERS = [{ id: 'member:root', role: 'root', nativeRef: null }, { id: 'member:a', role: 'worker', nativeRef: 'ses-a' }, { id: 'member:b', role:
  'worker', nativeRef: null }];

test('tab edge rule: switch only when the context changes', () => {
  assert.equal(nextSidebarTab('workspace', 'team', 'workspaces'), 'team');
  assert.equal(nextSidebarTab('team', 'workspace', 'team'), 'workspaces');
  assert.equal(nextSidebarTab(null, 'workspace', 'team'), 'workspaces');
  assert.equal(nextSidebarTab('team', 'team', 'workspaces'), 'workspaces'); // manual choice inside the context wins
  assert.equal(nextSidebarTab('workspace', 'workspace', 'team'), 'team');
});

test('frame transition: member-owned session is a Team session; native navigation away leaves it', () => {
  const t = o => frameTransition({ members: TEAM_MEMBERS, ...o });
  assert.deepEqual(t({ prevSessionId: 'ses-x', sessionId: 'ses-a', viewing: null }), { viewing: 'member:a', context: 'team' });
  assert.deepEqual(t({ prevSessionId: 'ses-a', sessionId: 'ses-x', viewing: 'member:a' }), { viewing: null, context: 'workspace' });
  assert.deepEqual(t({ prevSessionId: 'ses-x', sessionId: 'ses-y', viewing: null }), { viewing: null, context: 'workspace' });
  // Team nav to a member without a local session keeps the view while the session is unchanged.
  assert.deepEqual(t({ prevSessionId: 'ses-x', sessionId: 'ses-x', viewing: 'member:b' }), { viewing: 'member:b', context: 'team' });
  // ✕ (viewing cleared, same session) does not get re-entered just because the session is member-owned.
  assert.deepEqual(t({ prevSessionId: 'ses-a', sessionId: 'ses-a', viewing: null }), { viewing: null, context: 'workspace' });
  // First sighting (fresh page) of a member-owned session counts as entering it.
  assert.deepEqual(t({ prevSessionId: undefined, sessionId: 'ses-a', viewing: null }), { viewing: 'member:a', context: 'team' });
});

test('store: manual tab survives re-renders in a context, flips on edges, persists across reload', () => {
  const local = memStorage(), tab = memStorage();
  let ui = createUiStore(local, tab);
  ui.syncFrame('ses-x', TEAM_MEMBERS); // ordinary session
  assert.equal(ui.getSnapshot().sidebarTab, 'workspaces');
  ui.setSidebarTab('team'); // manual choice inside the workspace context
  for (let i = 0; i < 5; i++) ui.syncFrame('ses-x', TEAM_MEMBERS); // re-renders do not override it
  ui.enterContext('workspace');
  assert.equal(ui.getSnapshot().sidebarTab, 'team');
  ui.enterContext('team'); ui.setSidebarTab('workspaces'); ui.enterContext('team'); // Team overview: manual wins inside
  assert.equal(ui.getSnapshot().sidebarTab, 'workspaces');
  ui.syncFrame('ses-y', TEAM_MEMBERS); // leaving Team context → edge
  assert.equal(ui.getSnapshot().sidebarTab, 'workspaces');
  ui.syncFrame('ses-a', TEAM_MEMBERS); // opening member:a's session → edge into Team
  assert.equal(ui.getSnapshot().sidebarTab, 'team'); assert.equal(ui.getSnapshot().viewing, 'member:a');
  ui.setSidebarTab('workspaces');
  ui = createUiStore(local, tab); // reload
  ui.syncFrame(null, TEAM_MEMBERS); ui.syncFrame(undefined, TEAM_MEMBERS); // boot transient: no session selected yet
  assert.equal(ui.getSnapshot().sidebarTab, 'workspaces');
  ui.syncFrame('ses-a', TEAM_MEMBERS); // same session, same context after reload → manual choice kept
  assert.equal(ui.getSnapshot().sidebarTab, 'workspaces');
  ui.syncFrame('ses-y', TEAM_MEMBERS);
  assert.equal(ui.getSnapshot().sidebarTab, 'workspaces'); assert.equal(ui.getSnapshot().viewing, null);
  ui.syncFrame(null, null); // projection not loaded: no decision
  assert.equal(ui.getSnapshot().teamContext, 'workspace');
});

// ── P4 L2 right pane + session-header mini strip ──────────────────────
import { sessionMember, miniStatus, taskAttempts, deliveryInfo, certificateBinding } from '../src/model.mjs';
import { COMMANDS, UNSUPPORTED_COMMANDS, unsupportedReason, resolveTeamConfig } from '../src/projection.mjs';
import { createRealSource, commentKind } from '../src/real-source.mjs';
import { goalInfo, contextKnown, approvalsKnown, ctxLevel, CONTEXT_WARN, CONTEXT_FULL } from '../src/model.mjs';

test('mini strip: only member-owned (or Team-framed) sessions are Team sessions', () => {
  const a = data.members.find(m => m.id === M('worker-a'));
  assert.equal(sessionMember(data, a.nativeRef, {}).id, a.id);
  assert.equal(sessionMember(data, 'ses-ordinary', {}), null, 'ordinary session → nothing rendered');
  assert.equal(sessionMember(data, null, {}), null);
  assert.equal(sessionMember(null, a.nativeRef, {}), null, 'projection not loaded → no claim');
  // Team nav to a member without a local session frames the current session as that member's view.
  assert.equal(sessionMember(data, 'ses-x', { viewing: M('worker-p4'), frameSession: 'ses-x' }).id, M('worker-p4'));
  assert.equal(sessionMember(data, 'ses-y', { viewing: M('worker-p4'), frameSession: 'ses-x' }), null, 'another session is not framed');
  // A member whose binding is unknown (nativeRef null) never matches a null-ish session id.
  assert.equal(sessionMember({ members: [{ id: 'member:z', nativeRef: null }] }, 'null', {}), null);
});

test('mini strip: role/status/unread/pending — unknown stays unknown, never 0', () => {
  const b = data.members.find(m => m.id === M('worker-b'));
  const s = miniStatus(data, b);
  assert.equal(s.abbr, 'W'); assert.equal(s.status, 'active');
  assert.equal(s.unread, ackSummary(data.messages, b.id)?.unaccepted ?? 0);
  const p1 = data.members.find(m => m.id === M('worker-p1'));
  assert.equal(miniStatus(data, p1).pending, data.approvals.filter(a => a.member === p1.id).length);
  assert.ok(miniStatus(data, p1).pending > 0);
  assert.equal(miniStatus({ ...data, approvalsStatus: { status: 'unknown' } }, p1).pending, null, 'approvals unknown → ?');
  const p4 = data.members.find(m => m.id === M('worker-p4'));
  assert.equal(miniStatus(data, p4).status, null, 'observed unknown → ?');
  assert.equal(miniStatus(data, p4).ctxPct, null);
  const p3 = data.members.find(m => m.id === M('worker-p3'));
  assert.equal(miniStatus(data, p3).mismatch, 'frozen', 'desired ≠ observed is flagged, observed is not replaced');
  assert.equal(miniStatus(data, p3).status, 'active');
});

test('L2 task card: superseded attempts kept apart; delivery/binding known vs unknown', () => {
  const t12 = data.tasks.find(t => t.id === 'task-12');
  const at = taskAttempts(t12);
  assert.deepEqual(at.live.map(a => a.n), [2]); assert.deepEqual(at.superseded.map(a => a.n), [1]);
  assert.equal(taskAttempts({ id: 'x' }), null, 'no attempts field → unknown');
  assert.deepEqual(taskAttempts({ attempts: [] }), { live: [], superseded: [], total: 0 });
  assert.deepEqual(deliveryInfo({ delivery: null }), { known: true, none: true });
  assert.deepEqual(deliveryInfo({ id: 'x' }), { known: false });
  const t3 = deliveryInfo(data.tasks.find(t => t.id === 'task-3'), data);
  assert.equal(t3.binding.hashShort, 'c3a91f0e5b7d'); assert.equal(t3.certificate, 'valid');
  const t6 = deliveryInfo(data.tasks.find(t => t.id === 'task-6'), data);
  assert.equal(t6.certificate, 'valid'); assert.equal(t6.binding, null, 'valid certificate without a binding summary → unknown, not invented');
  // Real projection shape (P4B): delivery null, attempts present.
  const real = { id: 'task:a', state: 'executing', owner: 'member:a', contractRevision: 1, attempts: [{ n: 1, state: 'cancelled' }], delivery: null };
  assert.equal(taskAttempts(real).live.length, 1); assert.equal(deliveryInfo(real).none, true);
});

test('certificateBinding contract: mock fixtures satisfy packages/projections/schema.mjs certificateBindingSchema', async () => {
  const { certificateBindingSchema: S } = await import('../../projections/index.mjs');
  const bound = data.tasks.filter(t => t.delivery?.certificateBinding);
  assert.ok(bound.length >= 2);
  for (const t of bound) {
    const b = t.delivery.certificateBinding;
    for (const k of S.required) assert.ok(k in b, `${t.id} missing ${k}`);
    for (const k of Object.keys(b)) assert.ok(k in S.properties, `${t.id} extra ${k}`);
    assert.match(b.certificateHash, new RegExp(S.properties.certificateHash.pattern));
    assert.equal(b.taskId, t.id);
  }
});

test('certificateBinding: complete with attemptId / without attemptId / field absent / partial', () => {
  const t3 = data.tasks.find(t => t.id === 'task-3');
  // 1) Complete binding with attemptId → every field parsed, attempt matched against the task's attempts.
  const full = certificateBinding(t3, data);
  assert.equal(full.hash.length, 64); assert.equal(full.hashShort, full.hash.slice(0, 12));
  assert.equal(full.taskId, 'task-3'); assert.equal(full.taskMatches, true);
  assert.equal(full.verifier, 'member:verifier-e'); assert.equal(full.contractRevision, 1);
  assert.ok(full.candidate && full.tree); assert.equal(full.deliveryId, 'delivery:task-3'); assert.equal(full.deliveryRevision, 1); assert.equal(full.status,
    'accepted');
  assert.deepEqual(full.attempt, { state: 'matched', id: 'attempt:task-3:1', match: { n: 1, state: 'produced' } });
  // attemptId bound to an attempt the task does not have → flagged, not silently matched.
  const foreign = certificateBinding({ ...t3, delivery: { ...t3.delivery, certificateBinding: { ...t3.delivery.certificateBinding, attemptId:
    'attempt:other' } } }, data);
  assert.equal(foreign.attempt.state, 'unmatched'); assert.equal(foreign.attempt.match, null);
  // Owner's committed attempt (member projection carries attempt ids) also counts.
  const owner = data.members.find(m => m.id === t3.owner);
  const viaOwner = certificateBinding({ ...t3, attempts: [], delivery: { ...t3.delivery, certificateBinding: { ...t3.delivery.certificateBinding, attemptId:
    owner.attempt.id } } }, data);
  assert.equal(viaOwner.attempt.state, 'matched'); assert.equal(viaOwner.attempt.match.n, owner.attempt.n);
  // 2) No attemptId (legacy certificate) → 'none'; never inferred from the task's attempts.
  const legacy = certificateBinding(data.tasks.find(t => t.id === 'task-16'), data);
  assert.deepEqual(legacy.attempt, { state: 'none', id: null, match: null });
  assert.equal(legacy.status, 'verified'); assert.equal(legacy.verifier, 'member:verifier-final');
  // 3) Whole field absent → null (UI 未知), delivery itself still known.
  const t6 = data.tasks.find(t => t.id === 'task-6');
  assert.equal('certificateBinding' in t6.delivery, false);
  assert.equal(certificateBinding(t6, data), null);
  assert.equal(deliveryInfo(t6, data).binding, null); assert.equal(deliveryInfo(t6, data).known, true);
  // Missing / malformed individual fields → null each (UI 未知), never filled in; short hashes are rejected.
  const partial = certificateBinding({ id: 'task-x', delivery: { certificateBinding: { certificateHash: 'c3a91f0e5b7d24c8', taskId: 'task-y',
    contractRevision: 0 } } }, data);
  assert.equal(partial.hash, null); assert.equal(partial.hashShort, null);
  assert.equal(partial.taskMatches, false); assert.equal(partial.contractRevision, null);
  for (const k of ['verifier', 'candidate', 'tree', 'deliveryId', 'deliveryRevision', 'status']) assert.equal(partial[k], null, k);
  assert.equal(partial.attempt.state, 'none');
});

test('plugin: L2 pane and header mini strip are registered only by the Team plugin (default profile untouched)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/plugin.mjs', import.meta.url), 'utf8');
  assert.match(src, /name: 'conversation\.session\.header\.actions', id: 'team-mini'/);
  assert.match(src, /'sidebar\.right\.pane\.tab', key: PANE_TAB\.id/);
  assert.match(src, /'sidebar\.right\.pane\.tab\.title', key: PANE_TAB\.id/);
  // Registrations live inside apply(): nothing at module scope touches slots.
  const top = src.slice(0, src.indexOf('export function apply'));
  assert.ok(!/slots\.(inject|register)/.test(top));
  const host = fs.readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');
  assert.ok(!/header|sidebar\.right/.test(host), 'host half adds no browser seats');
});

test('the display layer renders the same hard limit the server gates with', () => {
  // packages/context/budget.mjs re-exports contracts' GATE_RATIO; the browser bundle cannot reach it, so ui keeps the
  // one copy it is allowed to have and this assertion is what stops the two from drifting apart.
  assert.equal(GATE_RATIO, SERVER_GATE_RATIO, 'ui GATE_RATIO must equal the server hard limit');
  assert.equal(scenarioDefault(NOW).members[0].context.limitRatio, SERVER_GATE_RATIO, 'mock fixtures carry the same ratio');
});

