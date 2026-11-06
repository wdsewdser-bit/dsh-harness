// Offline feature tests for session routing and team isolation; docs/host-protocol.md §2.3 and invariant 11 (F12).
// The defect these pin: one instance held one store and one identity, a command's team field was the literal 'team',
// and the goal guard was registered for the whole context, so two sessions could not coexist without mixing data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionRouter, createTeamHost } from '../index.mjs';
import { removeDir, tempDir } from '../test-support/helpers.mjs';

function twoTeams(router) {
  const dirA = tempDir('team-a');
  const dirB = tempDir('team-b');
  const a = createTeamHost({ teamId: 'team:a', root: dirA, ownerSessionId: 'session:owner-a', router });
  const b = createTeamHost({ teamId: 'team:b', root: dirB, ownerSessionId: 'session:owner-b', router });
  return { a, b, dirA, dirB, async close() { await a.stop(); await b.stop(); removeDir(dirA); removeDir(dirB); } };
}

test('two teams keep their session maps apart and never share a binding', async () => {
  const router = new SessionRouter();
  const teams = twoTeams(router);
  try {
    await teams.a.start();
    await teams.b.start();
    router.bindExecution({ executionSessionId: 'session:exec-a', teamId: 'team:a', memberId: 'member:worker', generation: 1 });
    router.bindExecution({ executionSessionId: 'session:exec-b', teamId: 'team:b', memberId: 'member:worker', generation: 1 });
    assert.equal(router.route('session:owner-a').teamId, 'team:a');
    assert.equal(router.route('session:owner-b').teamId, 'team:b');
    assert.equal(router.routeExecution('session:exec-a').teamId, 'team:a');
    assert.equal(router.routeExecution('session:exec-b').teamId, 'team:b');
    assert.deepEqual(router.teamSessions('team:a').executions.map(item => item.sessionId), ['session:exec-a']);
    assert.deepEqual(router.teamSessions('team:b').executions.map(item => item.sessionId), ['session:exec-b']);
    assert.equal(router.teamSessions('team:a').ownerSessionId, 'session:owner-a');
    assert.throws(
      () => router.bindExecution({ executionSessionId: 'session:exec-a', teamId: 'team:b', memberId: 'member:worker', generation: 2 }),
      error => error.code === 'EXECUTION_SESSION_CONFLICT',
    );
    assert.throws(
      () => router.registerTeam({ teamId: 'team:other', ownerSessionId: 'session:owner-a' }),
      error => error.code === 'OWNER_ALREADY_BOUND',
    );
    assert.throws(
      () => router.registerTeam({ teamId: 'team:a', ownerSessionId: 'session:owner-other' }),
      error => error.code === 'TEAM_ALREADY_OWNED',
    );
  } finally {
    await teams.close();
  }
});

test('an execution session ending detaches one binding; the owner session ending stops the team (F12)', async () => {
  const router = new SessionRouter();
  const teams = twoTeams(router);
  try {
    await teams.a.start();
    await teams.b.start();
    router.bindExecution({ executionSessionId: 'session:exec-a1', teamId: 'team:a', memberId: 'member:worker', generation: 1 });
    router.bindExecution({ executionSessionId: 'session:exec-a2', teamId: 'team:a', memberId: 'member:reviewer', generation: 1 });
    const ended = await router.handleSessionEnd({ sessionId: 'session:exec-a1' });
    assert.equal(ended.action, 'binding-ended');
    assert.equal(ended.teamId, 'team:a');
    assert.equal(teams.a.status().state, 'running', 'a member execution session ending must not stop the team');
    assert.equal(router.routeExecution('session:exec-a1').routed, false);
    assert.equal(router.routeExecution('session:exec-a2').routed, true, 'other members keep their binding');
    assert.equal(router.route('session:owner-b').routed, true, 'the other team is untouched');
    const ownerEnded = await router.handleSessionEnd({ sessionId: 'session:owner-a', timeoutMs: 1000 });
    assert.equal(ownerEnded.action, 'team-stopped');
    assert.equal(teams.a.status().state, 'stopped');
    assert.equal(teams.b.status().state, 'running');
    assert.equal(router.routeOwner('session:owner-a').routed, false);
    assert.equal(router.routeOwner('session:owner-b').routed, true);
  } finally {
    await teams.close();
  }
});

test('an unmapped session is unrouted instead of broadcast', async () => {
  const router = new SessionRouter();
  assert.deepEqual(router.route('session:stranger'), { routed: false, reason: 'unmapped', sessionId: 'session:stranger' });
  assert.equal(router.routeOwner('session:stranger').routed, false);
  assert.equal(router.routeExecution('session:stranger').routed, false);
  const ended = await router.handleSessionEnd({ sessionId: 'session:stranger' });
  assert.equal(ended.routed, false);
  assert.equal(ended.reason, 'unmapped');
  assert.equal(ended.action, 'none');
});

test('a new member generation replaces the old mapping and the stale generation stops routing', async () => {
  const router = new SessionRouter();
  const teams = twoTeams(router);
  try {
    await teams.a.start();
    router.bindExecution({ executionSessionId: 'session:exec-a', teamId: 'team:a', memberId: 'member:worker', generation: 1 });
    router.bindExecution({ executionSessionId: 'session:exec-a', teamId: 'team:a', memberId: 'member:worker', generation: 2 });
    assert.equal(router.routeExecution('session:exec-a').generation, 2);
    assert.equal(router.unbindExecution('session:exec-a', { generation: 1 }), false, 'a stale generation cannot unbind');
    assert.equal(router.unbindExecution('session:exec-a', { generation: 2 }), true);
    assert.equal(router.routeExecution('session:exec-a').routed, false);
  } finally {
    await teams.close();
  }
});
