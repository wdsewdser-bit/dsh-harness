import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { profile, until } from '../test-support/profile.mjs';
import { assertMemberWorkspace } from '../../profiles/index.mjs';

/**
 * Where a member's native execution works.
 *
 * The public command surface carries no directory on purpose, so a deployment that needs per-member workspaces
 * (the collaboration arm gives every member its own) supplies a profile hook. The profile validates the answer
 * before any session exists: absolute, and inside the configured workspace roots after resolving symlinks.
 */
const temp = label => fs.mkdtempSync(path.join(os.tmpdir(), 'member-workspace-' + label + '-'));

test('the workspace hook answer must be an absolute path inside the configured roots', () => {
  const root = temp('validator');
  try {
    const inside = path.join(root, 'members', 'a');
    assert.equal(assertMemberWorkspace(inside, [root]), inside, 'a directory under the root is accepted as given');
    assert.equal(assertMemberWorkspace(root, [root]), root, 'the root itself is inside the root');
    assert.throws(() => assertMemberWorkspace(path.join(root, '..', 'elsewhere'), [root]), { code: 'INVALID_CONFIG' }, 'escaping the root is refused');
    assert.throws(() => assertMemberWorkspace('members/a', [root]), { code: 'INVALID_CONFIG' }, 'a relative answer is refused');
    assert.throws(() => assertMemberWorkspace(undefined, [root]), { code: 'INVALID_CONFIG' });
    assert.throws(() => assertMemberWorkspace(inside, []), { code: 'INVALID_CONFIG' }, 'no root means nothing can be validated');
    // A path that does not exist yet is judged by its deepest existing ancestor, so "create it later" is not an escape.
    assert.equal(assertMemberWorkspace(path.join(root, 'a', 'b', 'c'), [root]), path.join(root, 'a', 'b', 'c'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the profile hands the hook the member it is creating and uses its answer as the session cwd', async () => {
  const root = temp('profile');
  const seen = [];
  const w = await profile({ root, workspaceRoot: root,
    memberWorkspace: ({ teamId, memberId, request }) => { seen.push({ teamId, memberId, kind: request.kind ?? null }); return path.join(root, 'members',
      memberId.replaceAll(':', '-')); } });
  try {
    const r = w.runtime;
    r.host.command({ teamId: r.host.teamId, actor: 'root', requestId: 'member', operationId: 'v1:operation:member-workspace-01',
      payload: { command: 'team.member.request', entityId: 'member-intent:w', role: 'worker' } });
    await until(() => r.store.read('member-intent:w')?.status === 'confirmed');
    assert.deepEqual(seen[0], { teamId: r.host.teamId, memberId: 'member:w', kind: 'create' }, 'the hook is asked about the member that is being created');
    assert.equal(w.agentMetas.length, 1);
    assert.equal(w.agentMetas[0].cwd, path.join(root, 'members', 'member-w'), 'the answer is the session cwd');
    assert.equal(r.store.read('member:w').nativeRef, 'session:worker', 'the execution really exists');
  } finally { await w.close(); }
});

test('an answer outside the workspace root creates nothing', async () => {
  const root = temp('outside');
  const outside = temp('outside-target');
  const w = await profile({ root, workspaceRoot: path.join(root, 'workspace'),
    memberWorkspace: () => path.join(outside, 'member') });
  try {
    const r = w.runtime;
    r.host.command({ teamId: r.host.teamId, actor: 'root', requestId: 'member', operationId: 'v1:operation:member-workspace-02',
      payload: { command: 'team.member.request', entityId: 'member-intent:x', role: 'worker' } });
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.notEqual(r.store.read('member-intent:x')?.status, 'confirmed', 'the intent never confirms');
    assert.equal(r.store.read('member:x')?.nativeRef ?? null, null, 'no native execution was bound');
    assert.equal(w.agentMetas.length, 0, 'and no session was created at all');
    // The refusal is the configured code, visible in the effect's own report rather than as a generic failure.
    const failed = r.store.effects().filter(e => e.payload?.memberId === 'member:x');
    assert(failed.length > 0, 'the lifecycle effect exists');
    assert.match(JSON.stringify(failed), /INVALID_CONFIG/);
  } finally { await w.close(); fs.rmSync(outside, { recursive: true, force: true }); }
});
