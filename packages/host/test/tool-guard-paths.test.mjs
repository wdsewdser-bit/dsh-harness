import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ToolGuard, effectTargets } from '../index.mjs';

/**
 * F2: the ordinary-effect fence meets a real native file tool.
 *
 * The guard shipped with F1 round 11 reads a pre-shaped `targets` array. A model does not send one: it calls the file
 * tools with `file_path` (and `source`/`destination` for a move), relative to its own session workspace. The fence
 * therefore refused every genuine write with MISSING_TARGETS before any scope was compared - the collaboration stage
 * found it the moment its members were given native tools, and it would have refused the same write in production.
 * These cases pin the mapping, the workspace resolution and the classes that are not effects at all.
 */
const workspace = path.resolve('runs/f2-guard/ws/be');
const lease = { scopeSet: [workspace] };
const authority = () => lease;
const records = [];
const guard = new ToolGuard(authority, record => records.push(record));

test('a relative file_path is resolved against the session workspace, not the process directory', () => {
  assert.deepEqual(effectTargets('write', { file_path: 'server.mjs', content: 'x' }, workspace), [path.join(workspace, 'server.mjs')]);
  assert.deepEqual(effectTargets('edit', { file_path: 'src/a.js' }, workspace), [path.join(workspace, 'src', 'a.js')]);
  // The caller hands the guard the call's real arguments and the directory the tool resolves them against; the target
  // list itself is derived inside the guard (review 2 #1).
  const record = guard.authorize({ tool: 'write', args: { file_path: 'server.mjs' }, cwd: workspace }, 'attempt:1', 1);
  assert.equal(record.decision, 'allow');
  const audit = records.at(-1);
  assert.equal(audit.decision, 'allow');
  assert.equal(audit.effect.targets[0], path.join(workspace, 'server.mjs'));
});

test('a move names both ends, and an absolute path outside the lease is refused', () => {
  assert.deepEqual(effectTargets('move', { source: 'a', destination: 'b' }, workspace),
    [path.join(workspace, 'a'), path.join(workspace, 'b')]);
  assert.throws(() => guard.authorize({ tool: 'write', args: { file_path: '/elsewhere/x.js' }, cwd: workspace }, 'attempt:1', 1),
    { code: 'OUT_OF_SCOPE' });
  assert.equal(records.at(-1).decision, 'deny');
});

test('a call that names no path still fails closed, and an unknown tool is not an effect', () => {
  assert.deepEqual(effectTargets('write', {}, workspace), []);
  assert.throws(() => guard.authorize({ tool: 'write', args: {} }, 'attempt:1', 1), { code: 'MISSING_TARGETS' });
  assert.throws(() => guard.authorize({ tool: 'delete-everything', args: {} }, 'attempt:1', 1), { code: 'UNKNOWN_EFFECT' });
});

test('reading is not an effect, a shell stays an audited accepted risk, and the lease is still required', () => {
  const read = guard.authorize({ tool: 'read', args: {} }, 'attempt:1', 1);
  assert.equal(read.decision, 'allow');
  assert.equal(read.readOnly, true);
  const shell = guard.authorize({ tool: 'bash', command: 'ls' }, 'attempt:1', 1);
  assert.equal(shell.risk, 'accepted-risk');
  assert.equal(shell.opaque, true);
  const expired = new ToolGuard(() => { throw Object.assign(Error('revoked'), { code: 'INVALID_LEASE' }); }, () => {});
  assert.throws(() => expired.authorize({ tool: 'read' }, 'attempt:1', 1), { code: 'INVALID_LEASE' },
    'a read still needs a live lease: the class decides what the fence records, never whether authority is checked');
});
