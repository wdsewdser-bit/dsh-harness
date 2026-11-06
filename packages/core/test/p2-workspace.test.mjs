// P2 of the team-autonomy design (§4.2.1-§4.2.4, appendix 7): the group and the workspace root assigns.
//
// The reducer half: what root may say, what it may never say (an absolute path, a drive, a UNC path, '..', the team root
// itself), that one member holds one workspace and no two members share or nest, that the assignment locks when the
// member exists, and that a provision without a host fence is refused rather than recorded on faith. The host half --
// realpath, junctions, the second check before a session exists -- is pinned in packages/host/test/p2-workspace.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore, handleTool } from '../index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../runs');

function team(label, withFence = true) {
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'p2-workspace-' + label + '-'));
  const store = new ControlStore(dir);
  // §10 P0/§4.2.1: provision and group are the autonomy package's branches, so the fixture that drives them runs with
  // the switch on (a default core does not publish them at all).
  const core = new TeamCore(store, {}, { enabled: true, attach: true, autonomy: 'on' });
  // The real fence lives in the profile (it owns the team root). Here it is a stand-in that answers the same shape, so
  // these tests pin the reducer's own rules; the realpath rules are pinned against real junctions in the host suite.
  if (withFence) core.ports.workspaceFence = ({ relPath }) => ({ relPath, base: '/team', resolved: '/team/' + relPath });
  core.member('member:root', 'root');
  core.member('member:w0', 'worker');
  return { dir, store, core, close() { store.close?.(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

let counter = 0;
const op = label => 'v1:operation:p2-' + label + '-' + String(++counter).padStart(4, '0');
const provision = (t, args, actor = 'member:root') => handleTool(t.core, { actor }, 'team_member',
  { operationId: op('provision'), op: 'provision', role: 'worker', ...args });

test('§4.2.2/§4.2.4: provision records the assignment, and the roster row takes its group from the pending intent', () => {
  const t = team('assign');
  try {
    const operationId = op('assign');
    const intent = handleTool(t.core, { actor: 'member:root' }, 'team_member', { operationId, op: 'provision',
      role: 'worker', group: 'g1', workspace: 'work/w1' }).result;
    assert.equal(intent.entityId, 'member-intent:' + operationId);
    assert.equal(intent.group, 'g1');
    assert.equal(intent.workspaceRel, 'work/w1');
    assert.equal(intent.op, 'request', 'the lifecycle consumer creates a member only for op=request (appendix 7)');
    assert.equal(intent.status, 'intent');
    const record = t.store.read('member.workspace:member:' + operationId);
    assert.ok(record, 'the assignment is its own durable row');
    assert.deepEqual({ relPath: record.relPath, base: record.base, resolved: record.resolved, lockedAt: record.lockedAt },
      { relPath: 'work/w1', base: '/team', resolved: '/team/work/w1', lockedAt: null }, 'assigned, not yet locked');
    assert.equal(t.store.read('group:g1').name, 'g1', 'provisioning into a new group creates the group row');
    const member = t.core.member('member:' + operationId, 'worker').result;
    assert.equal(member.group, 'g1', 'the roster row carries the group root assigned');
    assert.notEqual(t.store.read('member.workspace:member:' + operationId).lockedAt, null, '§4.2.4: creating the member locks it');
  } finally { t.close(); }
});

test('§4.2.2/§4.2.3: every absolute, UNC, drive and dot-dot form is INVALID_WORKSPACE and writes nothing', () => {
  const t = team('refusals');
  try {
    const bad = ['../escape', 'work/../x', 'work/..', '..', '/abs/root', 'C:\\Windows', '\\\\server\\share', 'a\\b', '.', './'];
    for (const workspace of bad) {
      const operationId = op('bad');
      assert.throws(() => handleTool(t.core, { actor: 'member:root' }, 'team_member', { operationId, op: 'provision',
        role: 'worker', workspace }), { code: 'INVALID_WORKSPACE' }, JSON.stringify(workspace) + ' must be refused');
      assert.equal(t.store.read('member-intent:' + operationId), null, 'no intent for ' + JSON.stringify(workspace));
      assert.equal(t.store.list('member.workspace:').length, 0, 'no workspace row for ' + JSON.stringify(workspace));
    }
  } finally { t.close(); }
});

test('§4.2.3 rule 3: two members never share a workspace and never nest inside each other', () => {
  const t = team('nesting');
  try {
    provision(t, { workspace: 'work/a' });
    assert.throws(() => provision(t, { workspace: 'work/a' }), { code: 'INVALID_WORKSPACE' }, 'the same path again');
    assert.throws(() => provision(t, { workspace: 'work/a/b' }), { code: 'INVALID_WORKSPACE' }, 'a path below it');
    assert.throws(() => provision(t, { workspace: 'work' }), { code: 'INVALID_WORKSPACE' }, 'a path above it');
    assert.ok(provision(t, { workspace: 'work/ab' }).result, 'siblings are free: work/ab is not work/a');
    assert.ok(provision(t, { workspace: 'other/a' }).result, 'another tree is free');
  } finally { t.close(); }
});

test('§4.2.4: a created member locks its workspace; a member whose create failed may be re-assigned', () => {
  const t = team('locked');
  try {
    const operationId = op('locked');
    handleTool(t.core, { actor: 'member:root' }, 'team_member', { operationId, op: 'provision', role: 'worker', workspace: 'work/l1' });
    t.core.member('member:' + operationId, 'worker');
    const memberRef = 'member:' + operationId;
    assert.throws(() => provision(t, { memberRef, workspace: 'work/l2' }), { code: 'WORKSPACE_LOCKED' });
    // §4.3: a member whose create failed is exactly the case root has to be able to re-assign.
    t.core.mutate(memberRef, 'root', {}, (tx, row) => tx.put(memberRef, { ...row, status: 'unknown' }));
    const reassigned = provision(t, { memberRef, workspace: 'work/l2' }).result;
    assert.equal(reassigned.group, 'default', 'a re-assignment writes the member row, not a lifecycle intent');
    assert.equal(t.store.read('member.workspace:' + memberRef).relPath, 'work/l2');
  } finally { t.close(); }
});

test('§4.2.1: groups are rows; a live member cannot be moved, a member that never started can', () => {
  const t = team('groups');
  try {
    assert.equal(handleTool(t.core, { actor: 'member:root' }, 'team_member',
      { operationId: op('group'), op: 'group', group: 'g2', mode: 'create' }).result.name, 'g2');
    const again = handleTool(t.core, { actor: 'member:root' }, 'team_member',
      { operationId: op('group'), op: 'group', group: 'g2', mode: 'create' }).result;
    assert.equal(again.entityId, 'group:g2', 'replaying the same plan is not a conflict');
    const idle = t.core.member('member:idle', 'worker').result;
    const moved = handleTool(t.core, { actor: 'member:root' }, 'team_member',
      { operationId: op('assign'), op: 'group', group: 'g2', mode: 'assign', memberRef: 'member:idle' }).result;
    assert.equal(moved.group, 'g2', 'a member that never started takes a new group');
    t.core.mutate('member:idle', 'root', {}, (tx, row) => tx.put('member:idle', { ...row, status: 'running' }));
    assert.throws(() => handleTool(t.core, { actor: 'member:root' }, 'team_member',
      { operationId: op('assign'), op: 'group', group: 'g2', mode: 'assign', memberRef: 'member:idle' }),
      { code: 'GROUP_LOCKED' }, '§4.2.4: a live member changes group only in a new generation');
    assert.throws(() => handleTool(t.core, { actor: 'member:root' }, 'team_member',
      { operationId: op('group'), op: 'group', group: 'bad name', mode: 'create' }), { code: 'INVALID_GROUP' });
    // A memberRef is also the call's CAS target, so naming a member that does not exist is refused before the reducer:
    // the tool refuses the row it cannot read, and the reducer's own UNKNOWN_MEMBER guards the direct entry.
    assert.throws(() => handleTool(t.core, { actor: 'member:root' }, 'team_member',
      { operationId: op('assign'), op: 'group', group: 'g2', mode: 'assign', memberRef: 'member:nobody' }),
      { code: 'CAS_CONFLICT:member:nobody' });
    assert.equal(idle.group, 'default');
  } finally { t.close(); }
});

test('§4.2.3 rule 1: provision and group are the root’s alone; another role does not even hold the tool', () => {
  const t = team('roles');
  try {
    assert.throws(() => handleTool(t.core, { actor: 'member:w0' }, 'team_member',
      { operationId: op('worker'), op: 'provision', role: 'worker', workspace: 'work/no' }), { code: 'ROLE_DENIED' });
    assert.throws(() => handleTool(t.core, { actor: 'member:w0' }, 'team_member',
      { operationId: op('worker'), op: 'group', group: 'gx', mode: 'create' }), { code: 'ROLE_DENIED' });
    assert.equal(t.store.list('member.workspace:').length, 0);
  } finally { t.close(); }
});

test('§4.2.2: a provision without a host fence is refused, never recorded on faith', () => {
  const t = team('nofence', false);
  try {
    assert.throws(() => handleTool(t.core, { actor: 'member:root' }, 'team_member',
      { operationId: op('bare'), op: 'provision', role: 'worker', workspace: 'work/x' }),
      { code: 'INVALID_WORKSPACE' }, 'a core that cannot prove where a path lands does not record one');
    assert.equal(t.store.list('member.workspace:').length, 0);
  } finally { t.close(); }
});

test('§4.2.1 C6/C9: the group capacity rules are unchanged, and a request with no group still lands in default', () => {
  const t = team('capacity');
  try {
    for (let index = 0; index < 8; index++) t.core.member('member:g' + index, 'worker', 'g1');
    assert.throws(() => t.core.member('member:g9', 'worker', 'g1'), { code: 'CAPACITY' }, 'the ninth worker in one group');
    assert.equal(t.store.list('member:').filter(m => m.group === 'g1').length, 8);
    const operationId = op('request');
    // The request branch keeps its published shape, expectedRevision included (§4.2.1: its semantics do not change).
    const intent = handleTool(t.core, { actor: 'member:root' }, 'team_member', { operationId, op: 'request',
      expectedRevision: 0, role: 'worker', subgoalRef: 'goal:child', reason: 'capacity' }).result;
    assert.equal(intent.group, undefined, 'an old-style request names no group');
    const member = t.core.member('member:' + operationId, 'worker').result;
    assert.equal(member.group, 'default', 'and the roster row keeps the default placement');
  } finally { t.close(); }
});
