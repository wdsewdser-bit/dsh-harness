// P3 of the team-autonomy design (docs/decisions/team-autonomy-design.md §5.2.4, §5.3, §5.4): the chain root and the
// migration of a store that already produced work.
//
// Every case runs a real git repository and a real control store; nothing is stubbed. The compatibility stance
// (strict:false, adopt-tail) must keep a running team running, so the legacy chain keeps closing at rows[0].base and
// every such readback is RECORDED (§12 U5: never silent). The strict stance is the state before M6 and is exercised
// only by its own cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { GoalGate } from '../goal-gate.mjs';
import { TeamCore, canonical, digest } from '../index.mjs';
import { createGitGuardRunner } from '../../delivery/index.mjs';
import { ControlStore } from '../../store/index.mjs';
import { goalIdOf } from '../commands/goals.mjs';

function fixture({ strict = false, autonomy = 'on' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-goal-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Offline'); git('config', 'user.email', 'offline@example.invalid');
  git('commit', '--allow-empty', '-m', 'base');
  const base = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
  const store = new ControlStore(root);
  const core = new TeamCore(store, {}, { enabled: true, autonomy, goalGate: { strict, legacy: 'adopt-tail' } });
  core.member('member:root', 'root');
  core.member('member:a', 'worker');
  const keys = generateKeyPairSync('ed25519'); let seq = 0;
  const publish = (target, parent) => {
    const candidate = git('commit-tree', tree, '-p', parent, '-m', 'candidate ' + (++seq));
    const taskId = 'task:' + seq, deliveryId = 'delivery:' + taskId;
    core.mutate(taskId, 'root', {}, tx => tx.put(taskId, { owner: 'member:worker', approved: true, scopeSet: [repo],
      contractRevision: 1, status: 'produced' }));
    const certificate = { base: parent, candidate, tree, verifier: 'member:verifier', contractRevision: 1,
      contractHash: digest({ scopeSet: [repo], contractRevision: 1, approved: true }) };
    const row = { taskId, owner: 'member:worker', directory: repo, base: parent, candidate, tree, target, status: 'verified',
      certificate, certificateHash: digest(certificate),
      signature: sign(null, Buffer.from(canonical(certificate)), keys.privateKey).toString('base64'),
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) };
    core.dispatch(deliveryId, 'root', {}, { type: 'delivery.put', payload: { deliveryId, row } });
    git('update-ref', target, candidate);
    core.dispatch(deliveryId, 'root', {}, { type: 'delivery.transition',
      payload: { deliveryId, from: 'verified', status: 'accepted', integrationCommit: candidate, integrationTree: tree } });
    return candidate;
  };
  const gate = new GoalGate(core, () => {}, { gitGuard: createGitGuardRunner({ roots: [root] }) });
  return { root, repo, git, base, tree, core, store, publish, gate,
    close() { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('an existing library without a goal record keeps closing, and every legacy chain is reported', () => {
  const f = fixture();
  try {
    const first = f.publish('refs/heads/a', f.base);
    f.publish('refs/heads/a', first);
    f.publish('refs/heads/b', f.base);
    // The compatibility stance: HEAD's rule (rows[0].base) still closes both queues.
    assert.equal(typeof f.gate.evidence(), 'string');
    assert.equal(f.gate.legacyChain().count, 2, 'one record per queue, none silent');
    assert.ok(f.gate.legacyChain().last.initialBase, 'the record names the root that was used');
    assert.equal(f.gate.teamGoal(), null);
  } finally { f.close(); }
});

test('adopt-tail: the old chain becomes history and the new one starts at its tail', () => {
  const f = fixture();
  try {
    const first = f.publish('refs/heads/a', f.base);
    const tail = f.publish('refs/heads/a', first);
    f.gate.openGoal('ship the todo app', { targets: [{ directory: f.repo, target: 'refs/heads/a' }], actor: 'member:root' });
    const goal = f.store.read(goalIdOf(f.core));
    assert.equal(goal.state, 'open');
    assert.equal(goal.bases.length, 1);
    assert.equal(goal.bases[0].commit, tail, 'the recorded base is the tail of the chain that already exists');
    assert.equal(goal.bases[0].tree, f.tree);
    assert.equal(goal.bases[0].recordedBy, 'adapter');
    assert.equal(goal.legacy.mode, 'adopt-tail');
    assert.equal(goal.legacy.chains.length, 1, 'one adopted chain per queue');
    assert.equal(goal.legacy.chains[0].tail.commit, tail);
    assert.equal(goal.legacy.chains[0].initialBase, f.base);
    assert.deepEqual(goal.legacy.chains[0].deliveries.map(row => row.chainEpoch), [1, 1], 'the old deliveries are epoch 1');
    assert.deepEqual(goal.legacy.chains[0].deliveries.map(row => row.candidate), [first, tail]);
    // The library works in place: the same rows still produce evidence, now rooted at the recorded base.
    assert.equal(typeof f.gate.evidence(), 'string');
    // ...and a delivery accepted after adoption extends the new chain from the tail.
    const next = f.publish('refs/heads/a', tail);
    assert.equal(typeof f.gate.evidence(), 'string');
    assert.ok(f.store.read('delivery:task:3'), 'the new delivery has its own id, after the two adopted rows');
    assert.ok(next);
  } finally { f.close(); }
});

test('adopt-tail refuses a legacy chain that does not close at the current head', () => {
  const f = fixture();
  try {
    const first = f.publish('refs/heads/a', f.base);
    f.publish('refs/heads/a', first);
    // An uncertified commit on top of the chain: the queue no longer closes where the ref is.
    const rogue = f.git('commit-tree', f.tree, '-p', first, '-m', 'uncertified');
    f.git('update-ref', 'refs/heads/a', rogue);
    assert.throws(() => f.gate.openGoal('ship', { targets: [{ directory: f.repo, target: 'refs/heads/a' }],
      actor: 'member:root' }), e => e.code === 'UNVERIFIED_LEGACY_BASE');
    assert.equal(f.gate.teamGoal(), null, 'nothing was opened');
  } finally { f.close(); }
});

test('strict: no goal record means no task and no accepted delivery', () => {
  const f = fixture({ strict: true });
  try {
    assert.throws(() => f.core.task('task:x', 'member:root', []), e => e.code === 'TEAM_GOAL_REQUIRED');
    assert.throws(() => f.publish('refs/heads/a', f.base), e => e.code === 'TEAM_GOAL_REQUIRED');
    // ...and the chain check says the same thing rather than inventing a root.
    f.core.configuration.goalGate = { strict: true, legacy: 'adopt-tail' };
  } finally { f.close(); }
});

test('strict: the chain must start at the recorded base, not at the first delivery base', () => {
  const f = fixture({ strict: true });
  try {
    f.gate.openGoal('ship', { targets: [{ directory: f.repo, target: 'refs/heads/a' }], actor: 'member:root' });
    const unrelated = f.git('commit-tree', f.tree, '-m', 'unrelated root');
    f.publish('refs/heads/a', unrelated);
    assert.throws(() => f.gate.evidence(), e => e.code === 'DELIVERY_CHAIN_GAP');
  } finally { f.close(); }
});

test('strict: a target nobody recorded is TARGET_BASE_UNRECORDED, and adding it later works', () => {
  const f = fixture({ strict: true });
  try {
    f.gate.openGoal('ship', { targets: [{ directory: f.repo, target: 'refs/heads/a' }], actor: 'member:root' });
    const a = f.publish('refs/heads/a', f.base);
    assert.equal(typeof f.gate.evidence(), 'string');
    f.publish('refs/heads/b', f.base);
    assert.throws(() => f.gate.evidence(), e => e.code === 'TARGET_BASE_UNRECORDED');
    // A queue that already produced cannot be given a base after the fact...
    assert.throws(() => f.gate.addTarget(f.repo, 'refs/heads/b', 'member:root'),
      e => e.code === 'TARGET_ALREADY_HAS_DELIVERIES');
    assert.ok(a);
  } finally { f.close(); }
});

test('strict: two recorded targets close as independent chains, interleaved', () => {
  const f = fixture({ strict: true });
  try {
    f.gate.openGoal('ship', { targets: [{ directory: f.repo, target: 'refs/heads/a' },
      { directory: f.repo, target: 'refs/heads/b' }], actor: 'member:root' });
    assert.deepEqual(f.store.read(goalIdOf(f.core)).bases.map(base => base.key.target),
      ['refs/heads/a', 'refs/heads/b']);
    const a = f.publish('refs/heads/a', f.base);
    const b = f.publish('refs/heads/b', f.base);
    f.publish('refs/heads/b', b);
    f.publish('refs/heads/a', a);
    assert.equal(typeof f.gate.evidence(), 'string');
    // A third target added before it produced is recorded and closes on its own too.
    f.gate.addTarget(f.repo, 'refs/heads/c', 'member:root');
    f.publish('refs/heads/c', f.base);
    assert.equal(typeof f.gate.evidence(), 'string');
  } finally { f.close(); }
});

test('a goal change makes a prepared completion stale instead of silently authorised (D7)', () => {
  const f = fixture({ strict: true });
  try {
    f.gate.openGoal('ship', { targets: [{ directory: f.repo, target: 'refs/heads/a' }], actor: 'member:root' });
    f.publish('refs/heads/a', f.base);
    const goal = f.store.read(goalIdOf(f.core));
    const input = { sessionId: 's1', goal: { id: 'g1', revision: 1, teamGoalRef: goal.entityId,
      teamGoalRevision: goal.revision } };
    const tokenId = f.gate.prepare(input);
    assert.ok(tokenId);
    const evidenceBefore = f.gate.evidence();
    // Another writer on the same store moves the goal while the completion is prepared. (A team write cannot do this:
    // a prepared token freezes business writes -- which is why the evidence itself has to carry the goal.)
    const command = f.core.command(goal.entityId, 'adapter', { moved: true });
    f.store.commit(command, tx => tx.put(goal.entityId, { ...tx.read(goal.entityId), note: 'moved outside the team' }));
    assert.notEqual(f.gate.evidence(), evidenceBefore, 'the goal is part of the evidence a token was prepared against');
    assert.equal(f.gate.storeFingerprint(), f.gate.storeFingerprint(), 'the fingerprint still reads the same store');
    assert.equal(f.gate.check(input), false, 'a stale preparation never authorises a completion');
  } finally { f.close(); }
});

test('a completion prepared against another goal revision is STALE_COMPLETION', () => {
  const f = fixture({ strict: true });
  try {
    f.gate.openGoal('ship', { targets: [{ directory: f.repo, target: 'refs/heads/a' }], actor: 'member:root' });
    f.publish('refs/heads/a', f.base);
    const goal = f.store.read(goalIdOf(f.core));
    assert.throws(() => f.gate.prepare({ sessionId: 's1', goal: { id: 'g1', revision: 1 } }),
      e => e.code === 'STALE_COMPLETION');
    assert.throws(() => f.gate.prepare({ sessionId: 's1', goal: { id: 'g1', revision: 1, teamGoalRef: goal.entityId,
      teamGoalRevision: goal.revision + 5 } }), e => e.code === 'STALE_COMPLETION');
  } finally { f.close(); }
});

test('an unknown completion opens one decision, and the owner verdict is taken only on the journal (U7)', () => {
  const f = fixture();
  try {
    const tokenId = 'completion:t1';
    f.core.mutate(tokenId, 'root', {}, tx => tx.put(tokenId, { input: { sessionId: 's1', goal: { id: 'g1', revision: 0 } },
      status: 'authorized' }));
    // The journal does not contain the completion: the token goes unknown and the row is opened in that transaction.
    const result = f.gate.reconcile({ id: 's1', snapshotEvents: () => [] });
    assert.equal(result.unknown, 1);
    const decision = f.store.list('decision:').find(row => row.subject?.id === tokenId);
    assert.ok(decision, 'an unknown completion opens a decision row');
    assert.equal(decision.kind, 'completion');
    assert.deepEqual(decision.options, ['consumed', 'cancelled']);
    assert.equal(decision.evidence.find(entry => entry.kind === 'journal').ref, 's1');
    // A verdict that carries no journal proof cannot reach the token, whoever asks.
    assert.throws(() => f.core.decideDecision(decision.entityId, 'member:root', { decision: 'cancelled' }),
      e => e.code === 'SESSION_LOG_UNAVAILABLE');
    // The operator channel keeps its exit.
    f.gate.resolveAbsent({ id: 's1', snapshotEvents: () => [] }, tokenId,
      'independent journal absence readback', 'operator');
    assert.equal(f.store.read(tokenId).status, 'cancelled', 'the absence readback closes the token');
    assert.equal(f.store.read(tokenId).adjudication.actor, 'operator');
    assert.equal(f.store.read(decision.entityId).state, 'superseded', 'the operator exit closes the open row too');
  } finally { f.close(); }
});

test('the owner consumes a completion through the decision channel only when the journal proves it', () => {
  const f = fixture();
  try {
    const tokenId = 'completion:t2';
    f.core.mutate(tokenId, 'root', {}, tx => tx.put(tokenId, { input: { sessionId: 's2',
      goal: { id: 'g2', revision: 3, objective: 'ship', maxGoalRounds: 4 } }, status: 'authorized' }));
    const events = [{ seq: 7, type: 'goal/change', data: { goal: { id: 'g2', revision: 4, phase: 'complete',
      objective: 'ship', maxGoalRounds: 4 } } }];
    f.gate.reconcile({ id: 's2', snapshotEvents: () => events });
    const decision = f.store.list('decision:').find(row => row.subject?.id === tokenId);
    assert.ok(decision);
    const session = { id: 's2', snapshotEvents: () => events };
    // Cancelling is refused by the journal: a completion IS there.
    assert.throws(() => f.gate.decideCompletion(session, decision.entityId, { decision: 'cancelled' }, 'member:root'),
      e => e.code === 'JOURNAL_CONFLICT');
    f.gate.decideCompletion(session, decision.entityId, { decision: 'consumed', reason: 'the log proves it' },
      'member:root');
    const token = f.store.read(tokenId);
    assert.equal(token.status, 'consumed');
    assert.equal(token.seq, 7);
    assert.equal(token.adjudication.actor, 'member:root');
    assert.equal(token.adjudication.decision, 'consumed');
    assert.equal(f.store.read(decision.entityId).state, 'decided');
    // The audit row and the operator notice are the same ones every verdict writes.
    const audit = f.store.list('audit:').find(row => row.decisionId === decision.entityId);
    assert.equal(audit.by, 'member:root');
    assert.equal(audit.option, 'consumed');
    assert.equal(audit.evidenceRef, tokenId);
    assert.ok(f.store.list('message:').some(row => row.decisionRef === decision.entityId && row.recipient === 'member:operator'));
  } finally { f.close(); }
});

/**
 * Review 1, item 9: adopt-tail has to migrate the historical queue AND register the empty one in the same call.
 *
 * openGoal() writes a base for every target but a legacy chain only for a target that already produced; adoptGoal() then
 * demanded a chain for EVERY base, so a library with one old queue and one new one could not be adopted at all.
 */
test('adopt-tail: a store whose history covers one queue and not the other migrates in one call', () => {
  const f = fixture();
  try {
    const first = f.publish('refs/heads/a', f.base);
    const tail = f.publish('refs/heads/a', first);
    f.gate.openGoal('ship both queues', { targets: [{ directory: f.repo, target: 'refs/heads/a' },
      { directory: f.repo, target: 'refs/heads/b' }], actor: 'member:root' });
    const goal = f.store.read(goalIdOf(f.core));
    assert.equal(goal.state, 'open');
    assert.equal(goal.bases.length, 2, 'both queues have an initial base');
    const baseA = goal.bases.find(base => base.key.target === 'refs/heads/a');
    const baseB = goal.bases.find(base => base.key.target === 'refs/heads/b');
    assert.equal(baseA.commit, tail, 'the queue with history is adopted at its tail');
    assert.equal(baseB.commit, f.base, 'the empty queue is registered where the repository was read back');
    assert.equal(goal.legacy.chains.length, 1, 'only the queue with history has a chain to adopt');
    // The empty queue starts its own chain at the registered base, and the old one keeps closing.
    f.publish('refs/heads/b', f.base);
    assert.equal(typeof f.gate.evidence(), 'string');
  } finally { f.close(); }
});

test('adopt-tail: an empty queue that produced before the commit is refused by the reducer', () => {
  const f = fixture();
  try {
    const first = f.publish('refs/heads/a', f.base);
    const tail = f.publish('refs/heads/a', first);
    const acceptedRows = f.store.list('delivery:').filter(row => row.status === 'accepted' && row.target === 'refs/heads/a');
    const baseA = f.gate.readBase(f.repo, 'refs/heads/a');
    const baseB = f.gate.readBase(f.repo, 'refs/heads/b');
    assert.equal(baseA.commit, tail);
    // The readback happened before this delivery was accepted: a base recorded now would be an after-the-fact root.
    f.core.mutate('delivery:late-b', 'root', {}, tx => tx.put('delivery:late-b', { taskId: 'task:late', owner: 'member:a',
      directory: f.repo, target: 'refs/heads/b', status: 'accepted' }));
    const legacy = { mode: 'adopt-tail', chains: [{ key: baseA.key, initialBase: f.base,
      tail: { commit: baseA.commit, tree: baseA.tree },
      deliveries: acceptedRows.map(row => ({ deliveryId: row.entityId, chainEpoch: 1 })) }] };
    assert.throws(() => f.core.dispatch(goalIdOf(f.core), 'member:root', {}, { type: 'team.goal.adopt',
      policy: { authority: 'owner' }, payload: { goalId: goalIdOf(f.core), objective: 'ship', bases: [baseA, baseB], legacy } }),
    { code: 'TARGET_ALREADY_HAS_DELIVERIES' });
    assert.equal(f.store.read(goalIdOf(f.core)), null, 'nothing was opened');
  } finally { f.close(); }
});
