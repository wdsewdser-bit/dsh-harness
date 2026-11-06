import test from 'node:test';
import assert from 'node:assert/strict';
import { TeamScope } from '../src/scope.mjs';
import { ActivityPager } from '../src/activity.mjs';
import { createUiStore } from '../src/store.mjs';
import { scenarioDefault, scenarioTeamB, withPanelBlocks, MOCK_VIEWER } from '../src/mock.mjs';
import { installReact, wire, textOf, NOW } from '../test-support/v3-tree.mjs';
installReact();
const { TEAM, MemberFrame, TeamPage } = await import('../src/ui.mjs');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject }; };
const envelope = (teamId, data) => ({ teamId, schemaVersion: 1, asOfSeq: 1, viewer: MOCK_VIEWER, data });
const page = (seq, nextBeforeSeq = null) => ({ events: [{ seq, id: 'event-' + seq }], asOfSeq: 100, nextBeforeSeq });

test('production switchSession stops the old client, clears every surface, rebuilds by binding and ignores late callbacks', async () => {
  const ui = createUiStore(null, null), binds = { B: deferred(), outside: deferred() }, snapshots = { B: deferred() };
  const dataA = withPanelBlocks(scenarioDefault(NOW), MOCK_VIEWER, NOW);
  const dataB = withPanelBlocks(scenarioTeamB(NOW), MOCK_VIEWER, NOW);
  const installed = []; const sources = [];
  const createSource = binding => {
    const teamId = binding?.teamId ?? 'A'; let deliver; let closes = 0;
    const source = { describe: () => ({}), binding: sid => binds[sid]?.promise ?? Promise.resolve({ teamId: sid }),
      snapshot: () => snapshots[teamId]?.promise ?? Promise.resolve(envelope(teamId, dataA)),
      subscribe: (_seq, fn) => { deliver = fn; return () => { closes++; }; } };
    const item = { source, teamId, deliver: event => deliver?.(event), closes: () => closes };
    sources.push(item); return { source, gateway: {} };
  };
  const scope = new TeamScope({ ui, createSource, install: picked => installed.push(picked) });
  try {
    await scope.switchSession('A');
    const sourceA = sources.at(-1), oldClient = scope.client;
    assert.equal(scope.getSnapshot().teamId, 'A');
    ui.openInspector('member', dataA.members[0].id); ui.openPalette({ name: 'old' }); ui.setDrawer('detail');
    const pendingB = scope.switchSession('B');
    assert.equal(sourceA.closes(), 1, 'the production switch, not the test, stops the old subscription');
    assert.equal(scope.getSnapshot().data, null);
    assert.equal(scope.getSnapshot().viewer, null);
    assert.equal(scope.getSnapshot().binding, undefined);
    for (const field of ['inspector', 'palette', 'selected', 'viewing', 'drawer']) assert.equal(ui.getSnapshot()[field], null);
    assert.equal(installed.at(-1), null, 'no gateway/source remains installed during binding');
    sourceA.deliver({ schemaVersion: 1, seq: 2, teamId: 'A', upserts: { members: [{ id: 'ghost', name: 'A ghost' }] } });
    assert.equal(oldClient.getSnapshot().asOfSeq, 1);
    binds.B.resolve({ teamId: 'B' }); await Promise.resolve(); await Promise.resolve();
    assert.notEqual(scope.client, oldClient);
    assert.equal(sources.at(-1).teamId, 'B');
    assert.equal(scope.getSnapshot().data, null, 'snapshot has not completed yet');
    snapshots.B.resolve(envelope('B', dataB)); await pendingB;
    assert.equal(scope.getSnapshot().teamId, 'B');
    assert.ok(scope.getSnapshot().data.members.every(m => m.name.startsWith('b-')));
    const before = scope.getSnapshot();
    sourceA.deliver({ schemaVersion: 1, seq: 2, teamId: 'A', upserts: { members: [{ id: 'ghost' }] } });
    assert.equal(scope.getSnapshot(), before);
    const outside = scope.switchSession('outside'); binds.outside.resolve(null); await outside;
    assert.equal(scope.getSnapshot().binding, null); assert.equal(scope.getSnapshot().data, null);
  } finally { scope.stop(); }
});

test('late binding success/failure and wrong-team snapshot never reinstall another session', async () => {
  for (const reject of [false, true]) {
    const late = deferred(), ui = createUiStore(null, null);
    const scope = new TeamScope({ ui, createSource: binding => ({ source: { describe: () => ({}),
      binding: sid => sid === 'late' ? late.promise : Promise.resolve(null),
      snapshot: async () => envelope(binding?.teamId ?? 'A', scenarioDefault(NOW)), subscribe: () => () => {} } }) });
    const old = scope.switchSession('late'); await scope.switchSession('outside');
    if (reject) late.reject(Error('late failure')); else late.resolve({ teamId: 'A' });
    await old;
    assert.equal(scope.getSnapshot().sessionId, 'outside'); assert.equal(scope.getSnapshot().data, null);
    assert.equal(scope.getSnapshot().error, null); scope.stop();
  }
  const scope = new TeamScope({ ui: createUiStore(null, null), createSource: () => ({ source: { describe: () => ({}),
    binding: async () => ({ teamId: 'B' }), snapshot: async () => envelope('A', scenarioDefault(NOW)), subscribe: () => () => {} } }) });
  await scope.switchSession('B');
  assert.equal(scope.getSnapshot().data, null); assert.match(scope.getSnapshot().error, /TEAM_IDENTITY_MISMATCH/); scope.stop();
});

test('production activity pager rejects old first/older pages and failures after filters or team/source change', async () => {
  for (const failure of [false, true]) {
    const first = deferred(), older = deferred(), newer = deferred(); const queries = [];
    const source = { activity: query => { queries.push(query);
      return query.kind === 'anomaly' ? newer.promise : query.beforeSeq ? older.promise : first.promise; } };
    const pager = new ActivityPager();
    const initial = pager.setScope(source, { kind: 'all' }, 1); first.resolve(page(90, 90)); await initial;
    const pending = pager.load(true); const duplicate = pager.load(true); await duplicate;
    assert.equal(queries.length, 2, 'double clicking older records issues one request');
    assert.equal(queries[1].beforeSeq, 90);
    const nextSource = { activity: () => newer.promise };
    const next = pager.setScope(failure ? nextSource : source, { kind: 'anomaly' }, failure ? 2 : 1);
    assert.equal(pager.getSnapshot().page, null, 'new scope clears the old rows synchronously');
    newer.resolve(page(99)); await next;
    if (failure) older.reject(Error('old page failed')); else older.resolve(page(80));
    await pending;
    assert.deepEqual(pager.getSnapshot().page.events, page(99).events);
    assert.equal(pager.getSnapshot().error, null); assert.equal(pager.getSnapshot().loading, false);
    pager.dispose();
  }
  const late = deferred(), pager = new ActivityPager();
  const pending = pager.setScope({ activity: () => late.promise }, {}, 'A');
  await pager.setScope({ activity: async () => page(2) }, {}, 'B'); late.resolve(page(1)); await pending;
  assert.equal(pager.getSnapshot().page.events[0].seq, 2);
  pager.dispose();
});

test('late snapshot success and failure cannot replace the new production scope', async () => {
  for (const fail of [false, true]) {
    const late = deferred();
    const scope = new TeamScope({ ui: createUiStore(null, null), createSource: binding => ({ source: {
      describe: () => ({}), binding: async sid => ({ teamId: sid }),
      snapshot: () => binding?.teamId === 'A' ? late.promise : Promise.resolve(envelope('B', scenarioTeamB(NOW))),
      subscribe: () => () => {} } }) });
    try {
      const old = scope.switchSession('A'); await Promise.resolve();
      await scope.switchSession('B');
      if (fail) late.reject(Error('old snapshot failed')); else late.resolve(envelope('A', scenarioDefault(NOW)));
      await old;
      assert.equal(scope.getSnapshot().teamId, 'B'); assert.equal(scope.getSnapshot().error, null);
      assert.ok(scope.getSnapshot().data.members.every(m => m.name.startsWith('b-')));
    } finally { scope.stop(); }
  }
});

test('confirmed owner binding drives the frame even though a real root has no nativeRef', () => {
  const data = withPanelBlocks(scenarioDefault(NOW), MOCK_VIEWER, NOW);
  wire(TEAM, data, MOCK_VIEWER);
  data.members.find(m => m.id === MOCK_VIEWER).nativeRef = null;
  TEAM.scope = { switchSession() {} }; TEAM.client = { subscribe: () => () => {}, getSnapshot: () => ({
    data, viewer: MOCK_VIEWER, sessionId: 'owner-native', binding: { teamId: 'A', memberId: MOCK_VIEWER, role: 'leader' } }) };
  TEAM.nav.hasNative = () => true;
  const tree = MemberFrame({ sessionId: 'owner-native', children: 'native owner' });
  assert.match(textOf(tree), /Team · root/); assert.match(textOf(tree), /native owner/);
  TEAM.scope = null;
});

test('a non-team frame first render never pairs the previous member with the new native conversation', () => {
  const data = withPanelBlocks(scenarioDefault(NOW), MOCK_VIEWER, NOW), ui = wire(TEAM, data, MOCK_VIEWER);
  const member = data.members.find(m => m.nativeRef);
  ui.set({ viewing: member.id, frameSession: member.nativeRef });
  const native = React.createElement('div', null, 'B native conversation');
  const first = MemberFrame({ sessionId: 'outside-B', children: native });
  assert.equal(first, native); assert.doesNotMatch(textOf(first), new RegExp(member.name));
  TEAM.scope = { switchSession() {} }; TEAM.client = { subscribe: () => () => {},
    getSnapshot: () => ({ data, viewer: MOCK_VIEWER, sessionId: 'A', binding: { teamId: 'A' } }) };
  assert.equal(MemberFrame({ sessionId: 'outside-B', children: native }), native);
  assert.doesNotMatch(textOf(TeamPage({ sessionId: 'outside-B' })), new RegExp(member.name));
  TEAM.scope = null;
});
