import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Projection } from '../../projections/index.mjs';
import { realTeam, ROOT, WORKER } from './review-fixture.mjs';
import { createRealSource } from '../src/real-source.mjs';
import { applyEvent, ProjectionClient } from '../src/projection.mjs';
import { installReact, wire, nodes, textOf, visibleText, NOW } from '../test-support/v3-tree.mjs';
installReact();
const { TEAM, TeamPage, Detail } = await import('../src/ui.mjs');
const { Inspector, History } = await import('../src/ui/detail.mjs');
const { recordPresentation } = await import('../src/activity.mjs');

test('actual transport/real-source decodes plain binding, null and committed activity; errors stay errors', async () => {
  const team = realTeam();
  team.put('task:wire', { owner: WORKER, title: '核对传输结果', status: 'ready' });
  const projection = new Projection(team.store, { protocol: 'v1', readerIdentity: { teamId: 'team-x', memberId: ROOT },
    routeSession: sid => sid === 'owner' ? { routed: true, teamId: 'team-x', kind: 'owner' } : null,
    leaderSession: () => ({ teamId: 'team-x', sessionId: 'owner' }) });
  const expectedBinding = projection.binding(ROOT, 'owner'), expectedActivity = projection.activity(ROOT, { limit: 2 });
  let mode = 'ok'; const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, token: req.headers.authorization });
    res.setHeader('content-type', 'application/json'); res.setHeader('connection', 'close');
    if (mode === 'error') { res.statusCode = 403; res.end(JSON.stringify({ error: 'ROLE_DENIED' })); return; }
    if (mode === 'bad') { res.end(JSON.stringify({ data: expectedBinding })); return; }
    const url = new URL(req.url, 'http://localhost');
    const body = url.pathname === '/team/binding' ? projection.binding(ROOT, url.searchParams.get('sessionId'))
      : projection.activity(ROOT, { limit: Number(url.searchParams.get('limit')) || 2 });
    res.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const source = createRealSource({ base: 'http://127.0.0.1:' + server.address().port, token: 'authenticated' }).source;
  try {
    assert.deepEqual(await source.binding('owner'), expectedBinding);
    assert.deepEqual(expectedBinding, { teamId: 'team-x', role: 'leader', memberId: ROOT });
    assert.equal(await source.binding('outside'), null);
    assert.deepEqual(await source.activity({ limit: 2 }), expectedActivity);
    assert.ok(expectedActivity.events.length > 0);
    assert.equal(requests.every(req => req.token === 'Bearer authenticated'), true);
    mode = 'error'; await assert.rejects(source.binding('owner'), /ROLE_DENIED/);
    await assert.rejects(source.activity(), /ROLE_DENIED/);
    mode = 'bad'; await assert.rejects(source.binding('owner'), /INVALID_BINDING/);
    await assert.rejects(source.activity(), /INVALID_ACTIVITY/);
  } finally { await new Promise(resolve => server.close(resolve)); team.close(); }
});

test('real projection shape renders workspace/history in the page and expanded member inspector', () => {
  const team = realTeam();
  try {
    team.put(WORKER, { ...team.store.read(WORKER), nativeRef: 'native-a' });
    team.put('member.workspace:a', { memberId: WORKER, relPath: 'work/a', base: 'repo', resolved: 'repo/work/a' });
    team.put('member-intent:a', { memberId: WORKER, phase: 'requested', openedAt: 100, status: 'open' });
    const projection = new Projection(team.store, { protocol: 'v1' });
    const data = projection.snapshot(ROOT).data;
    // Use the published shape; the strict walker rejects plain objects as children.
    const member = data.members.find(m => m.id === WORKER);
    assert.equal(typeof member.workspace, 'object');
    const ui = wire(TEAM, data, { teamId: 'team-x', memberId: ROOT });
    ui.openInspector('member', WORKER); ui.toggleDetails();
    assert.doesNotThrow(() => nodes(TeamPage()));
    assert.doesNotThrow(() => nodes(Inspector({ data, now: NOW, ui: ui.getSnapshot(), onOpen() {} })));
    assert.match(textOf(Inspector({ data, now: NOW, ui: ui.getSnapshot(), onOpen() {} })), /work[/]a/);
    assert.doesNotThrow(() => nodes(Detail({ data, now: NOW, ui: ui.getSnapshot(), onOpen() {} })));
    assert.match(textOf(History({ items: [{ at: 10, kind: 'bound', ref: 'x', text: '已绑定会话' }, 'active'] })), /已绑定会话/);
    assert.throws(() => nodes(React.createElement('dd', null, { relPath: 'bad' })), /not valid/);
  } finally { team.close(); }
});

test('real protocol collections replace/remove exactly like a fresh snapshot, including clears and principal changes', async () => {
  const team = realTeam();
  try {
    const p = new Projection(team.store, { protocol: 'v1' });
    const before = p.snapshot(ROOT).data;
    const rows = { decisions: [{ id: 'decision:a', state: 'decided' }], auditTrail: [{ id: 'audit:a', text: '已审计' }],
      stopProofs: [{ id: 'stop-proof:a', status: 'verified' }] };
    const blocks = { summary: { headline: { kind: 'ok', text: '已处理' } }, escalations: [], delivery: null, intents: [] };
    assert.deepEqual(applyEvent(before, { upserts: rows, ...blocks }), { ...before, ...rows, ...blocks });
    const removed = Object.fromEntries(Object.entries(rows).map(([key, value]) => [key, value.map(r => r.id)]));
    const cleared = applyEvent(applyEvent(before, { upserts: rows }), { removes: removed, summary: null, team: null });
    for (const key of Object.keys(rows)) assert.equal(Object.hasOwn(cleared, key), false);
    assert.equal(cleared.summary, null); assert.equal(cleared.team, null);
    let deliver;
    const source = { describe: () => ({}), snapshot: async () => ({ schemaVersion: 1, asOfSeq: 1, teamId: 'team-x',
      viewer: { teamId: 'team-x', memberId: ROOT }, data: before }), subscribe: (_seq, fn) => { deliver = fn; return () => {}; } };
    const client = new ProjectionClient(source); await client.start();
    assert.equal(client.getSnapshot().viewer, ROOT);
    deliver({ schemaVersion: 1, seq: 2, teamId: 'team-x', viewer: { teamId: 'team-x', memberId: WORKER }, upserts: rows });
    assert.equal(client.getSnapshot().viewer, WORKER);
    assert.deepEqual(client.getSnapshot().data.decisions, rows.decisions);
    deliver({ schemaVersion: 1, seq: 3, viewer: null, removes: removed });
    assert.equal(client.getSnapshot().viewer, null);
    assert.equal(Object.hasOwn(client.getSnapshot().data, 'stopProofs'), false);
    client.stop();
  } finally { team.close(); }
});

test('actual Projection.events updates and removes the published decision/audit/proof collections exactly like snapshot', () => {
  const team = realTeam();
  try {
    team.put('member.workspace:a', { memberId: WORKER, relPath: 'work/a' });
    team.put('decision:delta', { owner: WORKER, kind: 'coordination', state: 'open', openedAt: 100 });
    const p = new Projection(team.store, { protocol: 'v1' });
    let env = p.snapshot(WORKER), merged = env.data;
    team.put('decision:delta', { ...team.store.read('decision:delta'), state: 'decided', verdict: { option: 'approve' } });
    team.put('audit:delta', { owner: WORKER, kind: 'coordination', decisionId: 'decision:delta', at: 101 });
    team.put('stop-proof:delta', { owner: WORKER, verified: true, at: 102, subject: { kind: 'attempt', id: 'attempt:x' } });
    for (const event of p.events(WORKER, env.asOfSeq, { checkpointEpoch: env.retention.checkpointEpoch })) merged = applyEvent(merged, event);
    let fresh = p.snapshot(WORKER);
    assert.deepEqual(merged, fresh.data);
    assert.equal(merged.decisions[0].state, 'decided');
    assert.equal(merged.auditTrail.length, 1); assert.equal(merged.stopProofs[0].verified, true);
    for (const id of ['decision:delta', 'audit:delta', 'stop-proof:delta']) {
      team.put(id, { ...team.store.read(id), owner: 'member:b' });
    }
    const events = p.events(WORKER, fresh.asOfSeq, { checkpointEpoch: fresh.retention.checkpointEpoch });
    assert.ok(events.some(e => e.removes.decisions?.includes('decision:delta')));
    for (const event of events) merged = applyEvent(merged, event);
    fresh = p.snapshot(WORKER);
    assert.deepEqual(merged, fresh.data);
    for (const key of ['decisions', 'auditTrail', 'stopProofs']) assert.equal(Object.hasOwn(merged, key), false);
  } finally { team.close(); }
});

test('record titles resolve task/int IDs to words, appear once, and IDs stay in technical details', () => {
  const data = { tasks: [{ id: 'task-8', title: '核对交付' }], intents: [{ id: 'int-41', summary: '确认合入范围' }] };
  for (const [id, kind, title] of [['task-8', 'task', '核对交付'], ['int-41', 'intent', '确认合入范围']]) {
    const event = { id, kind, seq: 3, at: NOW, subject: { id, name: id }, text: id + '：已完成', tags: [] };
    assert.deepEqual(recordPresentation(data, event), { title, text: '已完成' });
    wire(TEAM, data, ROOT); TEAM.ui.openInspector('record', id, { event });
    const render = () => Inspector({ data, now: NOW, ui: TEAM.ui.getSnapshot(), onOpen() {} });
    assert.doesNotMatch(visibleText(render()), /task-8|int-41/);
    TEAM.ui.toggleDetails();
    assert.equal(nodes(render()).find(n => n.props?.['data-ins'] === 'technical').props.open, true);
    assert.match(visibleText(render()), new RegExp(id));
  }
});
