// P3 of the team-autonomy design (docs/decisions/team-autonomy-design.md §5, §10): the team-level goal record.
//
// The record is the before-the-fact chain root: one row per team, one initial base per (directory, target), written
// once, before the first task, by the owner. These tests pin the ordering rule, the per-target bases, the absence of
// any rebase path and the fingerprint that has to cover the row (§5.2.3).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../index.mjs';
import { GoalGate } from '../goal-gate.mjs';
import { createGitGuardRunner } from '../../delivery/index.mjs';
import { commandReducers } from '../commands/index.mjs';
import { goalIdOf } from '../commands/goals.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../runs');

function team(label, configuration = {}) {
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'team-goal-' + label + '-'));
  const store = new ControlStore(dir);
  const core = new TeamCore(store, {}, { enabled: true, autonomy: 'on', ...configuration });
  core.member('member:root', 'root');
  core.member('member:a', 'worker');
  const gate = new GoalGate(core, () => {}, { gitGuard: createGitGuardRunner({ roots: [dir] }) });
  return { dir, store, core, gate, close() { core.store.close?.(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** One base the host would have read back (§5.2.2: root never reports it). */
const readBack = (target, overrides = {}) => ({ key: { realCommonDir: 'c:/repo', target }, directory: 'C:/repo',
  commit: 'a'.repeat(40), tree: 'b'.repeat(40), recordedAt: Date.now(), recordedBy: 'adapter',
  evidence: { method: 'git rev-parse --path-format=absolute', raw: 'x', at: Date.now(), gitExit: 0 }, ...overrides });

const open = (t, bases, { objective = 'ship the todo app', actor = 'member:root' } = {}) => t.core.dispatch(goalIdOf(t.core),
  actor, { objective, bases: bases.length }, { type: 'team.goal.open', policy: { authority: 'owner' },
    payload: { goalId: goalIdOf(t.core), objective, bases } });

const addTarget = (t, base, { actor = 'member:root' } = {}) => t.core.dispatch(goalIdOf(t.core), actor, { base: base.key.target },
  { type: 'team.goal.addTarget', policy: { authority: 'owner' }, payload: { goalId: goalIdOf(t.core), base } });

test('the owner records one initial base per target, before the first task', () => {
  const t = team('open');
  try {
    open(t, [readBack('refs/heads/a'), readBack('refs/heads/b')]);
    const goal = t.store.read(goalIdOf(t.core));
    assert.equal(goal.state, 'open');
    assert.equal(goal.openedBy, 'member:root');
    assert.equal(goal.completionTokenRef, null);
    assert.deepEqual(goal.bases.map(base => base.key.target), ['refs/heads/a', 'refs/heads/b'], 'bases is an array, one per target');
    assert.deepEqual(goal.bases[0].key, { realCommonDir: 'c:/repo', target: 'refs/heads/a' });
    assert.equal(goal.bases[0].recordedBy, 'adapter', 'the readback is the host\'s, not root\'s');
    assert.equal(goal.bases[0].commit, 'a'.repeat(40));
    assert.equal(goal.legacy, undefined, 'a fresh goal has no legacy block');
  } finally { t.close(); }
});

test('a goal opened after the first task is TEAM_GOAL_TOO_LATE and changes nothing', () => {
  const t = team('late');
  try {
    t.core.task('task:a', 'member:a', []);
    assert.throws(() => open(t, [readBack('refs/heads/a')]), { code: 'TEAM_GOAL_TOO_LATE' });
    assert.equal(t.store.list('team-goal:').length, 0, 'no row was written');
    assert.equal(t.store.read(goalIdOf(t.core)), null);
  } finally { t.close(); }
});

test('a base is written once: there is no rebase path and no second open', () => {
  const t = team('rebase');
  try {
    open(t, [readBack('refs/heads/a')]);
    const first = t.store.read(goalIdOf(t.core));
    // A second open would be the only way to move the recorded base, and it is refused outright.
    assert.throws(() => open(t, [readBack('refs/heads/a', { commit: 'c'.repeat(40) })]), { code: 'TEAM_GOAL_TOO_LATE' });
    // ...and no reducer claims to rebase one.
    assert.equal(Object.hasOwn(commandReducers, 'team.goal.rebase'), false);
    assert.equal(Object.hasOwn(commandReducers, 'team.goal.setBase'), false);
    assert.throws(() => t.core.dispatch(goalIdOf(t.core), 'member:root', {}, { type: 'team.goal.rebase',
      payload: { goalId: goalIdOf(t.core) } }), { code: 'UNKNOWN_COMMAND:team.goal.rebase' });
    assert.equal(t.store.read(goalIdOf(t.core)).bases[0].commit, first.bases[0].commit, 'the base is still the one read back');
  } finally { t.close(); }
});

test('the owner row decides who may write a base, not the actor name', () => {
  const t = team('owner');
  try {
    // Neither the bare principal nor a worker row is an owner: the policy is selected by the entry and proved by rows.
    assert.throws(() => open(t, [readBack('refs/heads/a')], { actor: 'root' }), { code: 'DENIED' });
    assert.throws(() => open(t, [readBack('refs/heads/a')], { actor: 'member:a' }), { code: 'DENIED' });
    assert.equal(t.store.list('team-goal:').length, 0);
    // With the autonomy switch off the record does not exist as a command at all.
    const off = team('off', { autonomy: 'off' });
    try {
      assert.throws(() => open(off, [readBack('refs/heads/a')]), { code: 'DENIED' });
      assert.equal(off.store.list('team-goal:').length, 0);
    } finally { off.close(); }
  } finally { t.close(); }
});

test('a base nobody read back is refused: a malformed proof never becomes a row', () => {
  const t = team('malformed');
  try {
    assert.throws(() => open(t, [{ key: { realCommonDir: 'c:/repo', target: 'refs/heads/a' }, directory: 'C:/repo',
      commit: '', tree: 'b'.repeat(40) }]), { code: 'INVALID_CONFIG' });
    assert.equal(t.store.list('team-goal:').length, 0);
  } finally { t.close(); }
});

test('addTarget records a new queue, and refuses one that already produced', () => {
  const t = team('add-target');
  try {
    open(t, [readBack('refs/heads/a')]);
    addTarget(t, readBack('refs/heads/b', { commit: 'c'.repeat(40) }));
    assert.deepEqual(t.store.read(goalIdOf(t.core)).bases.map(base => base.key.target), ['refs/heads/a', 'refs/heads/b']);
    // The same key again: the base is never rewritten.
    assert.throws(() => addTarget(t, readBack('refs/heads/b', { commit: 'd'.repeat(40) })), { code: 'TEAM_GOAL_TOO_LATE' });
    // A queue that already produced has its chain root: the first delivery, not a base recorded now.
    t.core.mutate('delivery:1:a', 'root', {}, tx => tx.put('delivery:1:a', { taskId: 'task:a', owner: 'member:a',
      directory: 'C:/repo', target: 'refs/heads/c', status: 'accepted' }));
    assert.throws(() => addTarget(t, readBack('refs/heads/c')), { code: 'TARGET_ALREADY_HAS_DELIVERIES' });
  } finally { t.close(); }
});

test('the store fingerprint covers the team goal, so a moved base can never look like the same evidence', () => {
  const t = team('fingerprint');
  try {
    const empty = t.gate.storeFingerprint();
    open(t, [readBack('refs/heads/a')]);
    const opened = t.gate.storeFingerprint();
    assert.notEqual(opened, empty, 'opening the goal is a store change the fingerprint must see');
    addTarget(t, readBack('refs/heads/b', { commit: 'c'.repeat(40) }));
    const added = t.gate.storeFingerprint();
    assert.notEqual(added, opened, 'a second base is a different fingerprint, not the same evidence');
    // The same rows twice are the same fingerprint: the check is a fact about the store, not about call order.
    assert.equal(t.gate.storeFingerprint(), added);
  } finally { t.close(); }
});

test('a task written under a goal names the goal and its revision', () => {
  const t = team('task-binding');
  try {
    open(t, [readBack('refs/heads/a')]);
    t.core.task('task:a', 'member:a', []);
    const task = t.store.read('task:a');
    assert.equal(task.teamGoalRef, goalIdOf(t.core));
    assert.equal(task.teamGoalRevision, t.store.read(goalIdOf(t.core)).revision);
  } finally { t.close(); }
});
