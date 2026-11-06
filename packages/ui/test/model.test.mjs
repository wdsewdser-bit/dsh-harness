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

test('default scenario covers the required states with >10 members', () => {
  assert.ok(data.members.length > 10);
  const all = new Set(data.members.map(m => memberSeverity(m, { now: NOW, messages: data.messages })));
  for (const s of ['bad', 'unknown', 'warn', 'wait', 'ok', 'retired']) assert.ok(all.has(s), s);
  assert.equal(sev('verifier-e'), 'bad');          // overdue typed wait
  assert.equal(sev('worker-b'), 'wait');           // decision pending, not near deadline
  assert.equal(sev('worker-c'), 'warn');           // context >= 60 (76%)
  assert.equal(sev('worker-p4'), 'unknown');       // observed unknown
  assert.ok(data.tasks.some(t => t.state === 'verifying'));
});

test('A8: produced/merged are never "done"; only accepted counts as accepted', () => {
  const p = pipelineCounts(data.tasks);
  assert.deepEqual(p, { produced: 4, verifying: 2, verified: 3, integrating: 1, merged: 2, accepted: 1 });
});

test('A8: visible without responsibility is not accepted; info excluded from ACK', () => {
  const ack = ackSummary(data.messages, M('worker-b'));
  assert.equal(ack.level, 2);
  assert.equal(ack.unaccepted, 1);
  assert.equal(ackSummary(data.messages, M('worker-p2')), null); // only an info message
});

test('A8: freeze request is not shown as frozen before native stop confirmation', () => {
  const p3 = data.members.find(m => m.id === M('worker-p3'));
  assert.equal(p3.desired, 'frozen');
  assert.notEqual(sev('worker-p3'), 'frozen');
  assert.equal(sev('worker-p3'), 'warn');
});

test('A8: unknown effects stay until an explicit resolution event', () => {
  const later = NOW + 24 * 3600e3;
  assert.ok(needsYou(data, later, MOCK_VIEWER).some(i => i.kind === 'unknown'));
  const resolved = applyEvent(data, { removes: { unknownEffects: ['op-91'] } });
  assert.ok(!needsYou(resolved, later, MOCK_VIEWER).some(i => i.kind === 'unknown'));
});

test('A8: missing context projection is null, never 0', () => {
  assert.equal(data.members.find(m => m.id === M('worker-p4')).context, null);
});

test('needs-you ordering by deadline; counts', () => {
  // The operator acts as the root principal (member:root), so threads escalating to root are "yours" (thr-11).
  const items = needsYou(data, NOW, MOCK_VIEWER);
  assert.deepEqual(items.map(i => i.id), ['op-91', 'thr-9', 'thr-7', 'thr-11', 'apr-3']);
  // Without a viewer nothing is attributed to "you".
  assert.ok(!needsYou(data, NOW, null).some(i => i.kind === 'thread'));
  const c = counts(data, NOW, MOCK_VIEWER);
  assert.equal(c.blocked, 1);
  assert.ok(c.redShare <= 0.1);
});

test('deadline severity thresholds', () => {
  assert.equal(deadlineSeverity(0, 100, 101), 'bad');
  assert.equal(deadlineSeverity(0, 100, 80), 'warn');
  assert.equal(deadlineSeverity(0, 100, 10), 'wait');
});

test('A7: stable order only moves a row when its severity changes', () => {
  const big = scenarioLarge(NOW);
  assert.equal(big.members.length, 30);
  assert.ok(big.messages.length >= 200);
  const order = new StableOrder();
  const ids = () => groupRows(big, NOW, order).flatMap(g => g.rows.map(r => r.member.id));
  const first = ids();
  let cur = big;
  for (let i = 0; i < 100; i++) {
    const m = cur.members[1 + (i % 29)];
    if (!m.context || m.context.pct >= 55) continue;
    cur = applyEvent(cur, { upserts: { members: [{ ...m, context: { ...m.context, pct: m.context.pct + 1 + (i % 3) }, revision: m.revision + 1 }] } });
    cur = { ...cur, members: [...cur.members].sort((a, b) => (a.id.length * 31 + i) % 7 - (b.id.length * 31) % 7) }; // server order is not display order
    assert.deepEqual(groupRows(cur, NOW, order).flatMap(g => g.rows.map(r => r.member.id)), first, 'row order jittered at update ' + i);
  }
  const order2 = ids();
  for (let i = 0; i < 100; i++) assert.deepEqual(groupRows(cur, NOW, order).flatMap(g => g.rows.map(r => r.member.id)), order2);
  assert.deepEqual(first, order2);
});

test('A4: gap and schema change trigger a full snapshot re-read; freshness levels', async () => {
  const mock = createMockSource({ tickMs: 50 });
  let t = Date.now();
  const client = new ProjectionClient(mock.source, { now: () => t });
  await client.start();
  const seq0 = client.getSnapshot().asOfSeq;
  await new Promise(r => setTimeout(r, 140));
  assert.ok(client.getSnapshot().asOfSeq > seq0);
  mock.control.injectGap();
  await new Promise(r => setTimeout(r, 200));
  assert.equal(client.getSnapshot().lastResyncReason, 'gap');
  assert.equal(client.getSnapshot().asOfSeq >= mock.control.seq() - 1, true);
  const s = client.getSnapshot();
  assert.equal(freshness(s, t).level, 'fresh');
  assert.equal(freshness({ ...s, lastEventAt: t - FRESHNESS.lagMs - 1 }, t).level, 'lagging');
  assert.equal(freshness({ ...s, streamOpen: false, streamClosedAt: t - FRESHNESS.staleMs - 1 }, t).level, 'stale');
  assert.equal(freshness({ ...s, serverStale: true }, t).level, 'stale');
  mock.control.dropStream(120);
  await new Promise(r => setTimeout(r, 400));
  assert.equal(client.getSnapshot().lastResyncReason, 'reconnect');
  assert.equal(client.getSnapshot().streamOpen, true);
  client.stop();
});

test('A9: no write path except the command gateway', async () => {
  const fs = await import('node:fs');
  const dir = new URL('../src/', import.meta.url);
  const writers = [];
  // M6 WP-3: src/ui/ is a directory of the same panel source; scan its parts under the same rules.
  const files = [];
  for (const name of fs.readdirSync(dir)) {
    if (fs.statSync(new URL(name, dir)).isDirectory()) {
      for (const sub of fs.readdirSync(new URL(name + '/', dir))) {
        files.push([name + '/' + sub, fs.readFileSync(new URL(name + '/' + sub, dir), 'utf8')]);
      }
    } else files.push([name, fs.readFileSync(new URL(name, dir), 'utf8')]);
  }
  for (const [f, src] of files) {
    if (/method:\s*['"](POST|PUT|PATCH|DELETE)/i.test(src)) writers.push(f);
    // projection.mjs and transport.mjs are the two HTTP leaves; neither may be reached for anything but the gateway.
    if (!['projection.mjs', 'transport.mjs'].includes(f)) assert.ok(!/\bfetch\(/.test(src), `${f} calls fetch`);
  }
  // §WP-C 4 moved the browser transport into ui/src/transport.mjs. The rule it must keep is unchanged: the command
  // gateway is the only write path, and it writes to exactly one endpoint.
  assert.deepEqual(writers, ['transport.mjs'], 'only the command gateway has a write request');
  const transport = fs.readFileSync(new URL('transport.mjs', dir), 'utf8');
  assert.equal((transport.match(/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/gi) ?? []).length, 1, 'one write request');
  assert.match(transport, /'\/team\/commands'/, 'and it is the command gateway endpoint');
});

// ── P4 stage-2 consumer contract ──────────────────────────────────────
import { COMMANDS, UNSUPPORTED_COMMANDS, unsupportedReason, resolveTeamConfig } from '../src/projection.mjs';
import { createRealSource, commentKind } from '../src/real-source.mjs';
import { goalInfo, contextKnown, approvalsKnown, ctxLevel, CONTEXT_WARN, CONTEXT_FULL } from '../src/model.mjs';
import { createUiStore, nextSidebarTab, frameTransition } from '../src/store.mjs';
import { sessionMember, miniStatus, taskAttempts, deliveryInfo, certificateBinding } from '../src/model.mjs';

test('identity: every member reference in fixtures is an authoritative member:* id', () => {
  for (const d of [data, scenarioLarge(NOW)]) {
    const refs = [...d.members.map(m => m.id), ...d.members.map(m => m.wait?.memberRef).filter(Boolean), ...d.tasks.map(t => t.owner),
      ...d.threads.flatMap(t => [t.owner, t.escalationOwner, ...t.requiredRespondents.map(r => r.member), ...t.replies.map(r => r.member)]),
      ...d.messages.flatMap(m => [m.from, m.to, m.escalatedTo?.member].filter(Boolean)), ...d.approvals.map(a => a.member), ...d.groups.map(g =>
        g.lead).filter(Boolean)];
    for (const r of refs) assert.match(r, /^member:\S+$/, r);
    assert.equal(rootMember(d).id, 'member:root');
  }
  assert.equal(MOCK_VIEWER, 'member:root');
  assert.ok(!JSON.stringify(data).includes('"operator"'));
});

test('command contract: client table matches the server bridge (packages/projections/commands.mjs)', async () => {
  const fs = await import('node:fs');
  const server = fs.readFileSync(new URL('../../projections/commands.mjs', import.meta.url), 'utf8');
  const serverNames = new Set([...server.matchAll(/command\.name === '([^']+)'/g)].map(m => m[1]));
  assert.deepEqual([...serverNames].sort(), Object.keys(COMMANDS).sort());
  for (const name of Object.keys(UNSUPPORTED_COMMANDS)) { assert.ok(!serverNames.has(name)); assert.ok(unsupportedReason(name)); }
  assert.equal(unsupportedReason('mailbox.send'), null);
});

test('mock gateway follows the server contract (CAS, unsupported, recipient)', async () => {
  const mock = createMockSource();
  const env = await mock.source.snapshot('team');
  const p2 = env.data.members.find(m => m.id === M('worker-p2'));
  const send = { name: 'mailbox.send', target: p2.id, args: { recipient: p2.id, kind: 'action', summary: 'x', deadlineMin: 5, expectedOutcome: 'y' } };
  assert.equal((await mock.gateway.submit({ ...send, expectedRevision: null })).status, 'conflict');
  assert.equal((await mock.gateway.submit({ ...send, expectedRevision: p2.revision + 1 })).status, 'conflict');
  assert.equal((await mock.gateway.submit({ ...send, expectedRevision: p2.revision, args: { ...send.args, recipient: M('sc-2') } })).status, 'rejected');
  assert.equal((await mock.gateway.submit({ name: 'goal-gate.authorizeCompletion', target: p2.id, expectedRevision: p2.revision, args: {} })).message,
    'UNSUPPORTED_COMMAND');
  assert.equal((await mock.gateway.submit({ ...send, expectedRevision: p2.revision })).status, 'accepted');
});

test('runtime injection: default is mock; http config is validated', () => {
  assert.deepEqual(resolveTeamConfig(undefined), { source: 'mock' });
  assert.deepEqual(resolveTeamConfig({ source: 'mock' }), { source: 'mock' });
  assert.throws(() => resolveTeamConfig({ source: 'http', base: 'http://127.0.0.1:40292/x', token: 't' }));
  assert.throws(() => resolveTeamConfig({ source: 'http', base: 'http://127.0.0.1:40292' }));
  assert.deepEqual(resolveTeamConfig({ source: 'http', base: 'http://127.0.0.1:40292', token: 't', viewer: 'root' }),
    { source: 'http', base: 'http://127.0.0.1:40292', token: 't', viewer: null });
});

test('real source: heartbeat channel declared, no hard-coded missing list; legacy no-heartbeat sources still not lagging; 4xx is rejected', async () => {
  const real = createRealSource({ base: 'http://127.0.0.1:1', token: 't', viewer: 'member:root' });
  const caps = real.source.describe();
  assert.equal(caps.heartbeat, true); assert.equal(caps.viewer, 'member:root');
  assert.equal(caps.missing, undefined);
  const t = Date.now();
  const st = { status: 'ready', heartbeat: false, serverStale: false, streamOpen: true, streamClosedAt: null, lastEventAt: t - 10 * FRESHNESS.staleMs };
  assert.equal(freshness(st, t).level, 'fresh');
  assert.equal(freshness({ ...st, streamOpen: false, streamClosedAt: t - FRESHNESS.staleMs - 1 }, t).level, 'stale');
  const http = await import('node:http');
  const server = http.createServer((req, res) => { res.writeHead(401); res.end('{}'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const denied = createRealSource({ base: 'http://127.0.0.1:' + server.address().port, token: 'bad' });
    const receipt = await denied.gateway.submit({ name: 'mailbox.send', target: 'member:a', expectedRevision: 1, args: {} });
    assert.equal(receipt.status, 'rejected'); assert.match(receipt.message, /401/);
  } finally { server.close(); }
  const down = await real.gateway.submit({ name: 'mailbox.send', target: 'member:a', expectedRevision: 1, args: {} });
  assert.equal(down.status, 'unknown');
});

// ── P4 stage-4: new projection fields ─────────────────────────────────
function fakeSource(env) {
  const h = {};
  return { h, source: { describe: () => ({ kind: 'http', heartbeat: true }), snapshot: async () => structuredClone(env),
    subscribe: (after, onEvent, onStatus, onActivity) => { Object.assign(h, { onEvent, onStatus, onActivity }); onStatus('open'); return () => {}; } } };
}

test('(1) deltas replace groups/restrictedMembers wholesale; sourceRevisions and viewer follow envelope/events', async () => {
  const base = scenarioDefault(NOW);
  const next = applyEvent(base, { seq: 2, groups: [{ id: 'g-new', label: 'New', lead: null }], restrictedMembers: 0 });
  assert.deepEqual(next.groups, [{ id: 'g-new', label: 'New', lead: null }]);
  assert.equal(next.restrictedMembers, 0);
  assert.equal(base.restrictedMembers, 2, 'input not mutated');
  const untouched = applyEvent(base, { seq: 2, upserts: {} });
  assert.equal(untouched.groups, base.groups); assert.equal(untouched.restrictedMembers, 2);
  let t = 1000;
  const { h, source } = fakeSource({ schemaVersion: 1, asOfSeq: 1, sourceRevisions: { org: 1 }, stale: false, viewer: 'member:root', data: base });
  const client = new ProjectionClient(source, { now: () => t });
  assert.equal(client.getSnapshot().viewer, null, 'no config viewer: identity comes from the projection');
  await client.start();
  assert.equal(client.getSnapshot().viewer, 'member:root');
  t = 2000;
  h.onEvent({ schemaVersion: 1, seq: 2, sourceRevisions: { org: 2, messages: 7 }, groups: [], restrictedMembers: 5 });
  const s = client.getSnapshot();
  assert.deepEqual(s.sourceRevisions, { org: 2, messages: 7 });
  assert.deepEqual(s.data.groups, []); assert.equal(s.data.restrictedMembers, 5);
  h.onEvent({ schemaVersion: 1, seq: 3 });
  assert.deepEqual(client.getSnapshot().sourceRevisions, { org: 2, messages: 7 }, 'absent field keeps the last value');
  assert.equal(client.getSnapshot().viewer, 'member:root');
  client.stop();
});

test('(2) goal/gate/context/approvals: known vs unknown, no invented zeros, pct not divided twice', () => {
  const known = goalInfo(data.goal);
  assert.equal(known.known, true); assert.equal(known.gaps, 3);
  assert.equal(known.gate.status, 'blocked'); assert.equal(known.gate.known, true); assert.equal(known.gate.semantics, 'last-committed-check');
  assert.equal(known.token, 'none', 'a passing/blocked gate is never a completion authorization');
  const unknown = goalInfo({ id: 'goal', title: 'unknown', status: 'unknown', native: null, gate: { status: 'unknown' }, acceptanceGaps: null,
    completionToken: 'none' });
  assert.equal(unknown.known, false); assert.equal(unknown.title, null); assert.equal(unknown.gaps, null); assert.equal(unknown.gate.known, false);
  assert.equal(goalInfo({ status: 'known', title: 'x', acceptanceGaps: null, gate: { status: 'allowed' } }).gaps, null,
    'known goal without gaps → unknown, not 0');
  // context.pct is already relative to the 75% limit: 100 = at the limit.
  assert.equal(ctxLevel(CONTEXT_FULL), 'bad'); assert.equal(ctxLevel(CONTEXT_WARN), 'warn'); assert.equal(ctxLevel(79), 'ok');
  const m = { ...data.members[1], context: { inputTokens: 72000, window: 128000, limitRatio: 0.75, limitTokens: 96000, pct: 75 }, contextStatus: { status:
    'known', limitRatio: 0.75 } };
  assert.equal(memberSeverity(m, { now: NOW, messages: [] }), memberSeverity({ ...m, context: null, contextStatus: { status: 'unknown' } }, { now: NOW,
    messages: [] }), '75% of limit is ok (would be 100 if divided again)');
  assert.equal(ctxLevel(m.context.pct), 'ok');
  assert.equal(contextKnown(m), true);
  assert.equal(contextKnown({ ...m, contextStatus: { status: 'unknown', limitRatio: 0.75 } }), false, 'status unknown wins over a stale value');
  assert.equal(contextKnown({ ...m, context: null }), false);
  // Counters the server does not commit stay absent (UI: unknown), never 0.
  assert.equal(m.context.fold, undefined); assert.equal(m.context.hardGateHits, undefined);
  // Approvals: unknown read view contributes nothing; null deadline sorts last, never invented.
  assert.equal(approvalsKnown(data), true);
  const noDl = { ...data, approvals: [{ ...data.approvals[0], id: 'apr-nodl', deadline: null }] };
  const items = needsYou(noDl, NOW, MOCK_VIEWER);
  assert.equal(items.at(-1).id, 'apr-nodl'); assert.equal(items.at(-1).deadline, null);
  assert.ok(!needsYou({ ...data, approvalsStatus: { status: 'unknown' } }, NOW, MOCK_VIEWER).some(i => i.kind === 'approval'));
});

test('(3) SSE comments update only the activity clock; freshness uses it; seq/data untouched', async () => {
  assert.equal(commentKind(': heartbeat 1730000000000'), 'heartbeat');
  assert.equal(commentKind(': connected'), 'connected');
  assert.equal(commentKind('id: 3\ndata: {}'), null);
  assert.equal(commentKind(': x\ndata: {}'), null, 'a frame with data is a business event');
  let t = 10_000;
  const { h, source } = fakeSource({ schemaVersion: 1, asOfSeq: 7, sourceRevisions: {}, stale: false, viewer: 'member:root', data });
  const client = new ProjectionClient(source, { now: () => t });
  await client.start();
  const before = client.getSnapshot();
  t += FRESHNESS.lagMs + 1;
  assert.equal(freshness(client.getSnapshot(), t).level, 'lagging', 'a silent stream without heartbeats lags');
  h.onActivity('heartbeat');
  const after = client.getSnapshot();
  assert.equal(after.asOfSeq, 7); assert.equal(after.data, before.data); assert.equal(after.lastEventAt, before.lastEventAt);
  assert.equal(after.lastActivityAt, t); assert.equal(after.lastActivityKind, 'heartbeat');
  assert.equal(freshness(after, t).level, 'fresh');
  t += FRESHNESS.staleMs + 1;
  assert.equal(freshness(client.getSnapshot(), t).level, 'stale', 'heartbeats stopped → stale');
  client.stop();
  // End to end over a real SSE socket: comments reach onActivity, never onEvent.
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': connected\n\n'); res.write(': heartbeat 1\n\n');
    res.write('id: 8\nevent: projection\ndata: ' + JSON.stringify({ schemaVersion: 1, seq: 8 }) + '\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const seen = { events: [], activity: [] };
  const real = createRealSource({ base: 'http://127.0.0.1:' + server.address().port, token: 'x'.repeat(16) });
  const stop = real.source.subscribe(7, e => seen.events.push(e.seq), () => {}, k => seen.activity.push(k));
  for (let i = 0; i < 50 && seen.events.length === 0; i++) await new Promise(r => setTimeout(r, 20));
  stop(); server.closeAllConnections?.(); server.close();
  assert.deepEqual(seen.activity, ['connected', 'heartbeat']);
  assert.deepEqual(seen.events, [8]);
});

