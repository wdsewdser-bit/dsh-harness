// Review #2/#3: exercise HTTP -> authenticated profile scope -> projection -> real SessionRouter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionRouter } from '../../host/index.mjs';
import { applyTeamProjections as apply } from '../../profiles/index.mjs';
import { realTeam, ROOT, WORKER } from './review-fixture.mjs';

async function start(t) {
  const team = realTeam();
  const router = new SessionRouter();
  const host = { teamId: 'team-x', ownerSessionId: 'real-owner' };
  router.registerTeam({ teamId: host.teamId, ownerSessionId: host.ownerSessionId, host });
  router.registerTeam({ teamId: 'team-other', ownerSessionId: 'other-owner' });
  router.bindExecution({ teamId: host.teamId, executionSessionId: 'real-worker', memberId: WORKER, generation: 1 });
  router.bindExecution({ teamId: host.teamId, executionSessionId: 'private-worker', memberId: 'member:b', generation: 1 });
  let service; const disposals = [];
  const runtime = { core: team.core, host, router, ready: Promise.resolve(), bindPrincipal: identity => Object.freeze(identity) };
  const ctx = { teamRuntime: runtime, on: (_, fn) => disposals.push(fn), provide: (_, value) => { service = value; } };
  await apply(ctx, { port: 40298, sessions: {
    root: { teamId: host.teamId, memberId: ROOT }, worker: { teamId: host.teamId, memberId: WORKER },
    foreign: { teamId: 'team-other', memberId: ROOT }, viewer: { teamId: host.teamId, memberId: 'member:viewer' },
  } });
  t.after(async () => { for (const dispose of disposals) await dispose(); team.close(); });
  const get = async (token, route) => {
    const response = await fetch('http://127.0.0.1:40298' + route, { headers: { authorization: 'Bearer ' + token, connection: 'close' } });
    return { status: response.status, data: await response.json() };
  };
  return { ...team, router, host, service, get };
}

test('binding first request resolves the real owner without nativeRef, then follows unbind/rebind', async t => {
  const { get, core, put, router, service } = await start(t);
  assert.equal(core.store.read(ROOT).nativeRef, undefined);
  assert.equal(service.projection.seq, service.projection.baseSeq);
  const first = await get('root', '/team/binding?sessionId=real-owner');
  assert.equal(first.status, 200);
  assert.deepEqual(first.data, { teamId: 'team-x', role: 'leader', memberId: ROOT });
  assert.deepEqual((await get('root', '/team/binding?sessionId=real-worker')).data,
    { teamId: 'team-x', role: 'member', memberId: WORKER });
  put('team-goal:team-x', { objective: 'routed goal', openedAt: 100 });
  put('message:intent', { kind: 'intent', sender: ROOT, recipients: [WORKER], status: 'open', createdAt: 100 });
  assert.equal((await get('root', '/team/projection/snapshot')).data.data.team.leaderSessionId, 'real-owner');
  put('member:late', { role: 'worker', group: 'g', generation: 1, desired: 'active' });
  router.bindExecution({ teamId: 'team-x', executionSessionId: 'late-session', memberId: 'member:late', generation: 1 });
  assert.ok(service.projection.seq < core.store.latestEventSeq(), 'new member has not been synchronized');
  assert.equal((await get('root', '/team/binding?sessionId=late-session')).data.memberId, 'member:late');
  assert.equal(service.projection.seq, core.store.latestEventSeq(), 'binding itself synchronizes the new member');
  router.unbindExecution('real-worker');
  assert.equal((await get('root', '/team/binding?sessionId=real-worker')).data, null);
  router.bindExecution({ teamId: 'team-x', executionSessionId: 'real-worker', memberId: 'member:b', generation: 1 });
  assert.equal((await get('root', '/team/binding?sessionId=real-worker')).data.memberId, 'member:b');
  router.unregisterTeam('team-x');
  assert.equal((await get('root', '/team/binding?sessionId=real-owner')).data, null);
  assert.equal((await get('root', '/team/projection/snapshot')).data.data.team.leaderSessionId, null);
});

test('binding rejects invalid tokens, foreign team identities, hidden members and stale generations', async t => {
  const { get, core, put, router } = await start(t);
  put('member:viewer', { role: 'viewer', group: 'g', generation: 1, desired: 'active', observed: 'running' });
  assert.equal((await get('invalid', '/team/binding?sessionId=real-owner')).status, 401);
  assert.equal((await get('foreign', '/team/binding?sessionId=real-owner')).data, null);
  assert.equal((await get('foreign', '/team/projection/snapshot')).data.data, null);
  assert.deepEqual((await get('foreign', '/team/projection/activity')).data.events, []);
  for (const token of ['worker', 'viewer']) {
    assert.equal((await get(token, '/team/binding?sessionId=private-worker')).data, null);
    assert.equal((await get(token, '/team/binding?sessionId=real-owner')).data, null);
    assert.equal((await get(token, '/team/binding?sessionId=other-owner')).data, null);
  }
  assert.equal((await get('worker', '/team/binding?sessionId=real-worker')).data.memberId, WORKER);
  put(WORKER, { ...core.store.read(WORKER), generation: 2 });
  assert.equal((await get('worker', '/team/binding?sessionId=real-worker')).data, null);
  router.bindExecution({ teamId: 'team-x', executionSessionId: 'real-worker', memberId: WORKER, generation: 2 });
  assert.equal((await get('worker', '/team/binding?sessionId=real-worker')).data.memberId, WORKER);
  assert.equal((await get('root', '/team/binding?sessionId=missing')).data, null);
  assert.equal((await get('root', '/team/binding')).data, null);
});

test('activity HTTP reads afterSeq and committed timestamps rather than repeating the first page', async t => {
  const { get, put } = await start(t);
  put('task:x', { owner: WORKER, title: 'delivery timeline', contractRevision: 1, status: 'draft' });
  put('task:x', { owner: WORKER, title: 'delivery timeline', contractRevision: 1, status: 'accepted' });
  const first = (await get('root', '/team/projection/activity?kind=delivery&limit=1&afterSeq=0')).data;
  const next = (await get('root', '/team/projection/activity?kind=delivery&limit=1&afterSeq=' + first.nextAfterSeq)).data;
  assert.equal(first.events.length, 1);
  assert.equal(next.events.length, 1);
  assert.ok(next.events[0].seq > first.events[0].seq);
  assert.ok(Number.isFinite(first.events[0].at));
  assert.match(first.events[0].text, /等待范围审批/);
  assert.match(next.events[0].text, /已验收/);
  const latest = (await get('root', '/team/projection/activity?kind=delivery&limit=1')).data;
  assert.equal(latest.events[0].seq, next.events[0].seq, 'initial HTTP page is newest, not oldest');
  const older = (await get('root', '/team/projection/activity?kind=delivery&limit=1&beforeSeq=' + latest.nextBeforeSeq)).data;
  assert.equal(older.events[0].seq, first.events[0].seq);
  assert.equal(older.hasMore, false);
  assert.equal((await get('invalid', '/team/projection/activity')).status, 401);
  assert.equal((await get('root', '/team/projection/activity?afterSeq=-1')).status, 400);
});

test('snapshot plus actual HTTP SSE whole-block replacements converges to the latest snapshot', async t => {
  const { get, put } = await start(t);
  put('message:intent', { kind: 'intent', sender: ROOT, recipients: [WORKER], status: 'open', createdAt: 100 });
  const initial = (await get('root', '/team/projection/snapshot')).data;
  const merged = structuredClone(initial.data);
  const controller = new AbortController();
  const response = await fetch('http://127.0.0.1:40298/team/projection/stream?afterSeq=' + initial.asOfSeq +
    '&checkpointEpoch=' + initial.retention.checkpointEpoch, {
    headers: { authorization: 'Bearer root', connection: 'close' }, signal: controller.signal,
  });
  const timeout = setTimeout(() => controller.abort(), 5000);
  const reader = response.body.getReader();
  try {
    assert.equal(response.status, 200);
    put('task:sse', { title: 'SSE delivery', owner: WORKER, status: 'accepted', approved: true, contractRevision: 1 });
    let text = '', delta;
    while (!delta) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      text += new TextDecoder().decode(chunk.value);
      const line = text.split('\n').find(line => line.startsWith('data: '));
      if (line) delta = JSON.parse(line.slice(6));
    }
    for (const [key, additions] of Object.entries(delta.upserts)) {
      const list = (merged[key] ?? []).filter(row => !(delta.removes[key] ?? []).includes(row.id));
      for (const row of additions) {
        const i = list.findIndex(previous => previous.id === row.id);
        if (i < 0) list.push(row); else list[i] = row;
      }
      merged[key] = list;
    }
    for (const key of ['summary', 'memberSummary', 'delivery', 'escalations', 'intents', 'team', 'viewerRole',
      'goal', 'groups', 'restrictedMembers']) if (key in delta) merged[key] = delta[key];
    assert.equal(delta.summary.accepted, 1);
    assert.equal(delta.delivery.accepted, 1);
    assert.deepEqual(merged, (await get('root', '/team/projection/snapshot')).data.data);
  } finally {
    clearTimeout(timeout); controller.abort(); await reader.cancel().catch(() => {});
  }
});


test('owner re-registered by another team is absent from both binding and the old team metadata', async t => {
  const { get, put, router } = await start(t);
  put('team-goal:team-x', { objective: 'local goal', openedAt: 100 });
  put('message:intent', { kind: 'intent', sender: ROOT, recipients: [WORKER], openedAt: 100, status: 'open' });
  assert.equal((await get('root', '/team/projection/snapshot')).data.data.team.leaderSessionId, 'real-owner');
  router.unregisterTeam('team-x'); router.unregisterTeam('team-other');
  router.registerTeam({ teamId: 'team-other', ownerSessionId: 'real-owner' });
  assert.equal(router.routeOwner('real-owner').teamId, 'team-other');
  assert.equal((await get('root', '/team/binding?sessionId=real-owner')).data, null);
  assert.equal((await get('root', '/team/projection/snapshot')).data.data.team.leaderSessionId, null);
});

