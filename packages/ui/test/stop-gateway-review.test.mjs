// WP-2 review: CAS/operation identity and mock/real admission must agree with the existing core transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { submit } from '../../projections/index.mjs';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
import { createMockSource, MOCK_VIEWER } from '../src/mock.mjs';
import { realTeam, ROOT, WORKER } from './review-fixture.mjs';

const TARGET = 'attempt:review-stop';
const NAME = 'organization.confirmStopped';
function seed(team) {
  team.put('task:review-stop', { owner: WORKER, status: 'executing', attemptId: TARGET, contractRevision: 1 });
  team.put(TARGET, { owner: WORKER, taskId: 'task:review-stop', lease: 'unknown', status: 'unknown',
    fence: 1, generation: 1 });
}
const request = (team, operationId) => ({ name: NAME, operationId, target: TARGET,
  expectedRevision: team.store.read(TARGET).revision, args: { evidenceRef: 'artifact:review-stop' } });

for (const stage of ['before-mutate', 'before-commit']) {
  test('a second connection changes the fence after gateway pre-read: ' + stage, () => {
    const team = realTeam(); let peer;
    const mutate = team.core.mutate.bind(team.core), commit = team.store.commit.bind(team.store);
    try {
      seed(team);
      peer = new ControlStore(team.dir);
      const command = request(team, 'v1:operation:stop-cas-' + stage), initial = team.store.read(TARGET);
      let raced = false;
      const race = () => {
        raced = true;
        const input = team.core.command(TARGET, 'adapter', { race: stage }, 'v1:operation:stop-race-' + stage);
        peer.commit(input, tx => tx.put(TARGET, { ...tx.read(TARGET), fence: 2 }));
      };
      if (stage === 'before-mutate') {
        team.core.mutate = (...args) => { team.core.mutate = mutate; race(); return mutate(...args); };
      } else {
        team.store.commit = (input, reduce) => {
          if (input.operationId === command.operationId && !raced) race();
          return commit(input, reduce);
        };
      }
      const result = submit(team.core, 'operator', command);
      assert.equal(raced, true);
      assert.equal(result.status, 'conflict');
      assert.equal(result.message, 'CAS_CONFLICT');
      assert.equal(team.store.read(TARGET).revision, initial.revision + 1);
      assert.equal(team.store.read(TARGET).fence, 2);
      assert.equal(team.store.read(TARGET).lease, 'unknown');
      assert.equal(team.store.read('task:review-stop').status, 'executing');
      assert.equal(team.store.list('break-glass:').length, 0);
      assert.equal(team.store.events(0).filter(event => event.operationId === command.operationId).length, 0);
      assert.equal(team.store.receiptOf(team.core.command(TARGET, 'operator',
        { evidenceRef: command.args.evidenceRef }, command.operationId)), null);
    } finally {
      team.core.mutate = mutate; team.store.commit = commit; peer?.close(); team.close();
    }
  });
}

test('the external operationId replays the durable receipt before old revision and NOT_UNKNOWN admission', () => {
  const team = realTeam(); let peer;
  try {
    seed(team);
    const command = request(team, 'v1:operation:stop-idempotent');
    const first = submit(team.core, 'operator', command);
    assert.equal(first.status, 'accepted');
    assert.equal(first.operationId, command.operationId);
    assert.equal(team.store.read(TARGET).lease, 'revoked');
    const head = team.store.latestEventSeq();
    assert.ok(team.store.events(0).some(event => event.operationId === command.operationId));
    const probe = team.core.command(TARGET, 'operator', { evidenceRef: command.args.evidenceRef }, command.operationId);
    assert.equal(team.store.receiptOf(probe).receipt.operationId, command.operationId);
    assert.deepEqual(submit(team.core, 'operator', command), first);
    assert.equal(team.store.latestEventSeq(), head, 'same-instance retry writes nothing');
    peer = new ControlStore(team.dir);
    const restarted = new TeamCore(peer, {}, { enabled: true, attach: true, teamId: 'team-x' });
    assert.deepEqual(submit(restarted, 'operator', command), first, 'fresh connection/core sees the persisted receipt');
    assert.equal(peer.latestEventSeq(), head);
    // Even after another update, return the durable acknowledgement revision, not a fresh post-read prediction.
    team.put(TARGET, { ...team.store.read(TARGET), note: 'later observation' });
    const laterHead = peer.latestEventSeq();
    assert.ok(peer.read(TARGET).revision > first.revision);
    assert.deepEqual(submit(restarted, 'operator', command), first);
    assert.equal(peer.latestEventSeq(), laterHead);
    assert.equal(team.store.list('break-glass:').length, 1);
  } finally { peer?.close(); team.close(); }
});

test('reusing an operationId with other evidence or another target is ID_CONFLICT and cannot close again', () => {
  const team = realTeam();
  try {
    seed(team);
    const command = request(team, 'v1:operation:stop-payload-identity');
    assert.equal(submit(team.core, 'operator', command).status, 'accepted');
    team.put('attempt:other-stop', { owner: 'member:b', taskId: 'task:other-stop', lease: 'unknown',
      status: 'unknown', generation: 1, fence: 1 });
    const head = team.store.latestEventSeq();
    for (const changed of [{ ...command, args: { evidenceRef: 'artifact:different-stop' } },
      { ...command, target: 'attempt:other-stop', expectedRevision: team.store.read('attempt:other-stop').revision }]) {
      const result = submit(team.core, 'operator', changed);
      assert.equal(result.status, 'rejected');
      assert.equal(result.message, 'ID_CONFLICT');
      assert.equal(team.store.latestEventSeq(), head);
    }
    assert.equal(team.store.read('attempt:other-stop').lease, 'unknown');
    assert.equal(team.store.list('break-glass:').length, 1);
    assert.equal(team.store.read(TARGET).evidenceRef, command.args.evidenceRef);
  } finally { team.close(); }
});

test('root/member/viewer mock refusals match the real gateway before target lookup, argument validation or CAS', async () => {
  const team = realTeam();
  const read = team.store.read.bind(team.store);
  try {
    const cases = [
      { label: 'root', viewer: MOCK_VIEWER, actor: ROOT },
      { label: 'member', viewer: WORKER, actor: WORKER },
      { label: 'viewer', viewer: 'viewer:readonly', actor: 'viewer:readonly' },
    ];
    for (const identity of cases) {
      const mock = createMockSource({ viewer: identity.viewer, now: () => 2000 });
      const before = await mock.source.snapshot();
      const root = before.data.members.find(member => member.id === MOCK_VIEWER);
      const commands = [
        { name: NAME, target: root.id, expectedRevision: root.revision, args: { evidenceRef: 'artifact:stop' } },
        { name: NAME, target: 'attempt:missing', expectedRevision: -1, args: {} },
        { name: NAME, target: 'member:missing', get expectedRevision() { throw Error('CAS_WAS_READ'); },
          get args() { throw Error('ARGS_WERE_READ'); } },
      ];
      team.store.read = () => { throw Error('TARGET_WAS_READ'); };
      for (const command of commands) {
        const real = submit(team.core, identity.actor, command);
        const simulated = await mock.gateway.submit(command);
        assert.equal(real.status, 'rejected', identity.label);
        assert.equal(real.message, 'ROLE_DENIED');
        assert.equal(simulated.status, real.status);
        assert.equal(simulated.message, real.message);
        assert.equal(simulated.revision, real.revision);
        assert.equal(simulated.entityId, real.entityId);
      }
      team.store.read = read;
      assert.deepEqual(await mock.source.snapshot(), before, 'mock refusals do not alter the projection');
    }
  } finally { team.store.read = read; team.close(); }
});
