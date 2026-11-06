// P2 of the team-autonomy design (§4.2.2/§4.2.3, appendix 7): the workspace fence, driven through the real profile.
//
// The reducer half is pinned in packages/core/test/p2-workspace.test.mjs. What only this file can prove is the path
// safety: a real junction pointing out of the team root is refused, a directory that is swapped for one between the
// assignment and the create is refused by the SECOND check, and the first check alone (strings, prefixes) is not enough.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { profile, until } from '../test-support/profile.mjs';
import { handleTool } from '../../core/index.mjs';

const temp = label => fs.mkdtempSync(path.join(os.tmpdir(), 'p2-workspace-' + label + '-'));
const lower = value => String(value).toLowerCase();
let counter = 0;
const op = label => 'v1:operation:p2-' + label + '-' + String(++counter).padStart(4, '0');

const provision = (core, args, actor = 'member:root') => handleTool(core, { actor }, 'team_member',
  { operationId: op('provision'), op: 'provision', role: 'worker', ...args });

/**
 * A junction to a directory outside the team root. Junctions are the interesting case on Windows: creating one needs no
 * privilege, so it is the escape a deployment actually has; a platform that refuses it is reported, not faked.
 */
function junction(linkPath, target, t) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    fs.symlinkSync(target, linkPath, 'junction');
    return true;
  } catch (error) {
    t.skip('this platform refused to create a junction (' + (error.code ?? error.message) + '); the escape case is untested here');
    return false;
  }
}

const dropJunction = linkPath => { try { fs.unlinkSync(linkPath); } catch { /* already gone */ } };

// §10 P0: provision and group are the autonomy package's branches, so the fixtures that drive them mount the profile
// with the switch on (a default profile does not publish them at all).
test('C1/§4.2.2: root assigns work/w1 and the session cwd is that directory under the team root', async () => {
  const root = temp('assign');
  const w = await profile({ root, autonomy: 'on' });
  try {
    const r = w.runtime;
    const operationId = op('c1');
    provision(r.core, { group: 'g1', workspace: 'work/w1' , operationId });
    await until(() => r.store.read('member-intent:' + operationId)?.status === 'confirmed');
    const memberId = 'member:' + operationId;
    const record = r.store.read('member.workspace:' + memberId);
    assert.equal(record.relPath, 'work/w1');
    assert.equal(lower(record.base), lower(fs.realpathSync(root)), 'the base is the team root, resolved once');
    assert.equal(lower(record.resolved), lower(path.join(fs.realpathSync(root), 'work', 'w1')));
    assert.notEqual(record.lockedAt, null, '§4.2.4: the first successful create locks the assignment');
    assert.equal(r.store.read(memberId).group, 'g1', 'C8: the roster row carries the group in the same provisioning');
    assert.equal(r.store.read('group:g1').name, 'g1');
    assert.equal(w.agentMetas.length, 1);
    // The directory does not exist yet (the port is what creates it), so the comparison is on the resolved path the
    // fence produced: realpath of the team root plus the segments still to be created.
    assert.equal(lower(path.resolve(w.agentMetas[0].cwd)), lower(path.join(fs.realpathSync(root), 'work', 'w1')),
      'C1: the session cwd is the assigned directory');
  } finally { await w.close(); }
});

test('C2/§4.2.3: absolute, UNC, drive and dot-dot paths are INVALID_WORKSPACE and create nothing', async () => {
  const root = temp('refuse');
  const w = await profile({ root, autonomy: 'on' });
  try {
    const r = w.runtime;
    for (const workspace of ['../escape', 'work/../../escape', '/absolute', 'C:\\Windows', '\\\\server\\share', 'a\\b']) {
      assert.throws(() => provision(r.core, { workspace }), { code: 'INVALID_WORKSPACE' }, JSON.stringify(workspace));
    }
    assert.equal(w.agentMetas.length, 0, 'no session was created');
    assert.equal(fs.existsSync(path.join(root, '..', 'escape')), false, 'nothing was created beside the root');
    assert.equal(r.store.list('member.workspace:').length, 0, 'no assignment was recorded');
  } finally { await w.close(); }
});

test('C3/§4.2.3 rule 3: a junction that points out of the team root is refused by realpath', async t => {
  const root = temp('junction');
  const outside = temp('junction-target');
  const w = await profile({ root, autonomy: 'on' });
  try {
    const link = path.join(root, 'work', 'j');
    if (!junction(link, outside, t)) return;
    const r = w.runtime;
    assert.throws(() => provision(r.core, { workspace: 'work/j' }), { code: 'INVALID_WORKSPACE' },
      'the string prefix looks inside the root; the realpath does not');
    assert.equal(w.agentMetas.length, 0, 'no session was created');
    assert.equal(r.store.list('member.workspace:').length, 0);
  } finally { dropJunction(path.join(root, 'work', 'j')); await w.close(); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('§4.2.3 rule 4: a directory swapped for a junction after the assignment is caught by the second check', async t => {
  const root = temp('toctou');
  const outside = temp('toctou-target');
  // No automatic lifecycle cycle: the create must happen after the swap, not before it.
  const w = await profile({ root, autonomy: 'on', lifecycleIntervalMs: 100000 });
  try {
    const r = w.runtime;
    const operationId = op('toctou');
    provision(r.core, { workspace: 'work/t1', operationId });
    assert.equal(r.store.read('member-intent:' + operationId)?.status, 'intent', 'assigned, not created yet');
    const link = path.join(root, 'work', 't1');
    if (!junction(link, outside, t)) return;
    // The host asks the fence again before it creates anything; the recorded path is now a door out of the root.
    r.kickLifecycle();
    await until(() => r.store.read('member-intent:' + operationId)?.status !== 'intent');
    assert.notEqual(r.store.read('member-intent:' + operationId).status, 'confirmed');
    assert.equal(w.agentMetas.length, 0, 'no session was created in a directory nobody reviewed');
  } finally { dropJunction(path.join(root, 'work', 't1')); await w.close(); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('C7/§4.2.4: re-assigning a workspace to a live member is WORKSPACE_LOCKED', async () => {
  const root = temp('locked');
  const w = await profile({ root, autonomy: 'on' });
  try {
    const r = w.runtime;
    const operationId = op('c7');
    provision(r.core, { workspace: 'work/a', operationId });
    await until(() => r.store.read('member-intent:' + operationId)?.status === 'confirmed');
    const memberRef = 'member:' + operationId;
    assert.throws(() => provision(r.core, { memberRef, workspace: 'work/b' }), { code: 'WORKSPACE_LOCKED' });
    assert.equal(r.store.read('member.workspace:' + memberRef).relPath, 'work/a', 'the original assignment stands');
  } finally { await w.close(); }
});

test('§4.2.1: the host command entry assigns a group and a workspace too, and refuses the same bad paths', async () => {
  const root = temp('host-command');
  const w = await profile({ root });
  try {
    const r = w.runtime;
    r.host.command({ teamId: r.host.teamId, actor: 'root', requestId: 'p2-host-command',
      operationId: 'v1:operation:p2-host-command-0001',
      payload: { command: 'team.member.request', entityId: 'member-intent:hc', role: 'worker', group: 'hgroup',
        workspaceRel: 'work/hc' } });
    await until(() => r.store.read('member-intent:hc')?.status === 'confirmed');
    assert.equal(r.store.read('member-intent:hc').group, 'hgroup');
    assert.equal(r.store.read('member.workspace:member:hc').relPath, 'work/hc');
    assert.equal(r.store.read('member:hc').group, 'hgroup');
    assert.equal(lower(path.resolve(w.agentMetas[0].cwd)), lower(path.join(fs.realpathSync(root), 'work', 'hc')));
    assert.throws(() => r.host.command({ teamId: r.host.teamId, actor: 'root', requestId: 'p2-host-bad',
      operationId: 'v1:operation:p2-host-command-0002',
      payload: { command: 'team.member.request', entityId: 'member-intent:hb', role: 'worker', workspaceRel: '../bad' } }),
      { code: 'INVALID_WORKSPACE' });
  } finally { await w.close(); }
});
