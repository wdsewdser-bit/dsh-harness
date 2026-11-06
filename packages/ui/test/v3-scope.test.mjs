// M6 WP-4 acceptance (15 §2.1-2, 16 §3): the session/team scope. An incremental SSE frame must land exactly where a
// fresh snapshot would, a frame from the previous team must never paint the new one, and a session that no member owns
// must not be described as a member session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectionClient, applyEvent } from '../src/projection.mjs';
import { createMockSource, scenarioDefault, scenarioTeamB, MOCK_VIEWER, withPanelBlocks } from '../src/mock.mjs';
import { sessionMember } from '../src/model.mjs';
import { NOW, installReact, loadUi, wire, textOf } from '../test-support/v3-tree.mjs';

installReact();
const { TEAM, TeamPaneTab, SessionMini } = await loadUi();
const panel = (fixture, viewer = MOCK_VIEWER) => withPanelBlocks(fixture(NOW), viewer, NOW);
const waitFor = async (predicate, label) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 4000) throw Error('timeout waiting for ' + label);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
/** A projection source with one team id, whose frames the test can deliver by hand. */
const teamSource = (teamId, data) => {
  const frames = [];
  return {
    describe: () => ({ kind: 'http', label: 'test', viewer: MOCK_VIEWER, heartbeat: true }),
    snapshot: async () => ({ schemaVersion: 1, teamId, asOfSeq: 10, sourceRevisions: {}, stale: false,
      viewer: MOCK_VIEWER, data }),
    subscribe: (afterSeq, onEvent, onStatus) => { frames.push(onEvent); onStatus('open'); return () => {}; },
    deliver: event => frames.forEach(frame => frame(event)),
  };
};

test('M6 §WP-4: a whole-block SSE frame lands exactly where a fresh snapshot of the same state would', async () => {
  const mock = createMockSource({ fixture: 'borrow', now: () => NOW, tickMs: 600000 });
  const client = new ProjectionClient(mock.source, { now: () => NOW });
  await client.start();
  try {
    const before = client.getSnapshot().data;
    const thread = before.resourceThreads[0];
    assert.equal(thread.subscribers.length, 2, 'the fixture starts with two subscribers');
    const receipt = await mock.gateway.submit({ name: 'threads.subscribe', target: thread.id,
      expectedRevision: thread.revision, args: { memberId: 'member:verifier-e' } });
    assert.equal(receipt.status, 'accepted', JSON.stringify(receipt));
    await waitFor(() => (client.getSnapshot().data.resourceThreads[0].subscribers ?? []).length === 3, 'the subscribe frame');
    const merged = client.getSnapshot().data;
    const fresh = (await mock.source.snapshot()).data;
    assert.deepEqual(merged, fresh, 'the incremental path and the snapshot agree row for row');
    for (const key of ['summary', 'memberSummary', 'delivery', 'escalations', 'intents', 'team', 'viewerRole']) {
      assert.deepEqual(merged[key], fresh[key], key + ' is a whole block, never a field merge');
    }
    assert.equal(merged.summary.escalations === undefined, true, 'the summary stays the projection value');
    const cleared = applyEvent(merged, { escalations: [], summary: null });
    assert.deepEqual(cleared.escalations, [], 'an empty block replaces the old one');
    assert.equal(cleared.summary, null, 'null clears the block instead of keeping the stale one');
  } finally { client.stop(); }
});

test('15 §2.1-2: after a session switch, a frame that belongs to the previous team paints nothing', async () => {
  const a = teamSource('team:a', panel(scenarioDefault));
  const b = teamSource('team:b', panel(scenarioTeamB));
  const clientA = new ProjectionClient(a, { now: () => NOW });
  await clientA.start();
  assert.equal(clientA.getSnapshot().teamId, 'team:a', 'the envelope names the team');
  // The switch: the old client is stopped, the new session's team gets its own client.
  clientA.stop();
  const client = new ProjectionClient(b, { now: () => NOW });
  await client.start();
  const before = client.getSnapshot();
  assert.equal(before.teamId, 'team:b');
  assert.ok(before.data.members.every(member => member.name.startsWith('b-')), 'team B rows only');
  b.deliver({ schemaVersion: 1, teamId: 'team:a', seq: before.asOfSeq + 1,
    upserts: { members: [{ ...before.data.members[1], id: 'member:ghost', name: 'team-a ghost' }] } });
  assert.equal(client.getSnapshot().asOfSeq, before.asOfSeq, 'the stale frame does not advance the cursor');
  assert.equal(client.getSnapshot().data.members.some(member => member.id === 'member:ghost'), false,
    'and paints no row from team A');
  b.deliver({ schemaVersion: 1, teamId: 'team:b', seq: before.asOfSeq + 1,
    upserts: { members: [{ ...before.data.members[1], name: 'b-live' }] } });
  assert.equal(client.getSnapshot().asOfSeq, before.asOfSeq + 1, 'a frame of the current team still applies');
  assert.ok(client.getSnapshot().data.members.some(member => member.name === 'b-live'), 'so the guard is a filter');
  client.stop();
});

test('16 §3 / 09 §2.1: a member session and a session that is not in the team never share a member', () => {
  const data = panel(scenarioDefault);
  const worker = data.members.find(member => member.id === 'member:worker-a');
  assert.ok(worker.nativeRef, 'the fixture binds a native session');
  assert.equal(sessionMember(data, worker.nativeRef, {}).id, 'member:worker-a', 'a member session resolves to its member');
  assert.equal(sessionMember(data, 'ses-not-a-team-session', {}), null, 'a session no member owns is not a team session');
  assert.equal(sessionMember(data, worker.nativeRef, { viewing: 'member:worker-b', frameSession: worker.nativeRef }).id,
    'member:worker-a', 'the native binding wins over whatever the frame is showing');
  assert.equal(sessionMember(data, 'ses-other', { viewing: 'member:worker-b', frameSession: 'ses-other' }).id,
    'member:worker-b', 'a Team view on a session without a binding follows the frame');
  assert.equal(sessionMember(data, 'ses-other', { viewing: 'member:worker-b', frameSession: 'ses-different' }), null,
    'but only for the session the frame is actually on');
  const state = wire(TEAM, data, MOCK_VIEWER);
  assert.ok(state);
  const pane = TeamPaneTab({ sessionId: worker.nativeRef });
  assert.equal(pane.props['data-team-pane'], 'member:worker-a', 'the sidebar opens on the member that owns that session');
  const other = TeamPaneTab({ sessionId: 'ses-not-a-team-session' });
  assert.equal(other.props['data-team-pane'], 'none', 'a non-team session gets no member');
  assert.match(textOf(other), /当前会话不属于 Team 成员/, 'and says so instead of showing someone else');
  assert.equal(SessionMini({ sessionId: 'ses-not-a-team-session' }), null, 'the header strip renders nothing outside the team');
  assert.equal(SessionMini({ sessionId: worker.nativeRef }).props['data-team-mini'], 'member:worker-a');
});
