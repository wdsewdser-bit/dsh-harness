import assert from 'node:assert/strict';
import { ControlStore } from '../../packages/store/index.mjs';
import { TeamCore } from '../../packages/core/index.mjs';
import { drain } from '../../packages/core/runtime.mjs';
import { applyLifecycle } from '../../packages/core/native.mjs';
import { handleTool } from '../../packages/core/tools.mjs';
import { id } from '../../packages/contracts/index.mjs';

/** Verify readiness survives busy/frozen edges and reference denial is enforced; 08 §7.2 B/E/K. */
export async function edgeCases(root) {
  const store = new ControlStore(root);
  const core = new TeamCore(store, { cancel: async () => ({ stopped: true }), resume: async () => ({ nativeRef: 'native:a' }) }, { enabled: true });
  core.member('member:root', 'root');
  core.member('member:a', 'worker');
  core.task('task:first', 'member:a');
  assert.throws(() => core.schedule('stale-version', 'task:first', Date.now(), { assignmentEpoch: 0 }), /STALE_ASSIGNMENT/);
  const first = core.schedule('first', 'task:first').result;
  const message = core.send('member:root', 'member:a', 'action', 'busy arrival', {
    deadline: new Date(Date.now() + 60000).toISOString(), expectedOutcome: 'process' }).result;
  drain(core);
  core.finish(first.attemptId, first.fence);
  drain(core);
  const second = store.list('attempt:').find(a => a.lease === 'active');
  assert(second && second.entityId !== first.attemptId);
  await assert.rejects(() => applyLifecycle(core, 'member:a', 'resume'), /STOP_REQUIRED/);
  await applyLifecycle(core, 'member:a', 'cancel');
  drain(core);
  assert(!store.list('attempt:').some(a => a.lease === 'active'));
  await applyLifecycle(core, 'member:a', 'resume');
  // The old recipient generation is not implicitly rebound by resume.
  assert.throws(() => core.accept(message.entityId, second.entityId, second.fence, 'late'), /INVALID_LEASE/);
  core.mutate('artifact:secret', 'root', {}, tx => tx.put('artifact:secret', { owner: 'member:root' }));
  core.task('task:acl', 'member:a');
  const attempt = core.schedule('acl', 'task:acl').result;
  assert.throws(() => handleTool(core, { actor: 'member:a', ...attempt }, 'team_message', {
    op: 'send', operationId: id('operation'), expectedRevision: 0, to: 'member:root', kind: 'info', summary: 'leak', bodyRef: 'artifact:secret',
  }), /REFERENCE_ACL/);
  const visible = handleTool(core, { actor: 'member:a' }, 'team_read', { view: 'evidence', ref: 'artifact:secret' });
  assert.equal(visible.refs.length, 0);
  const replacement = core.command('replacement', 'adapter', { committed: true });
  const receipt = store.commit(replacement, tx => tx.put('replacement', { committed: true }));
  assert.deepEqual(store.commit(replacement, () => assert.fail('replayed effect')), receipt);
  assert.throws(() => store.commit({ ...replacement, operationId: id('operation') }, () => {}), /CAS_CONFLICT/);
  store.close();
  return { busyEdgeRetained: true, frozenNoAdmission: true, liveResumeDenied: true,
    modelReferenceAclDenied: true, committedReplacementReceiptOnly: true };
}
