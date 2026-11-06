/**
 * P7 appendix 8: one fixed row set, so the projection can be compared byte for byte against its pre-P7 self.
 *
 * Every timestamp is a literal: the output of view() carries createdAt/openedAt values straight from the rows, so a
 * fixture built through the store (Date.now() in every tx.put) could never be hashed and compared across runs. These
 * rows are the families the projection knew before P1-P6 -- roster, task, attempt, message -- and nothing else.
 */
export function legacyRows() {
  const rows = new Map();
  const put = (entityId, data, revision = 1) => rows.set(entityId, { ...data, entityId, revision, updatedAt: 1000 });
  put('member:root', { role: 'root', group: 'default', generation: 1, desired: 'active', observed: 'running',
    status: 'running', nativeRef: 'session:root' });
  put('member:a', { role: 'worker', group: 'default', generation: 1, desired: 'active', observed: 'running',
    status: 'running', nativeRef: 'session:a' });
  put('member:qa', { role: 'verifier', group: 'default', generation: 1, desired: 'active', observed: 'offline',
    status: 'created' });
  put('task:a', { owner: 'member:a', status: 'executing', approved: true, worktreeReady: true, contractRevision: 1,
    assignmentEpoch: 1, scopeSet: [], title: 'Task A', attemptId: 'attempt:a', lastFence: 1, deadline: null });
  put('attempt:a', { taskId: 'task:a', owner: 'member:a', status: 'admitted', lease: 'active', fence: 1,
    generation: 1, expiresAt: 2000, scopeSet: [], admittedAt: 1000 });
  put('message:m1', { sender: 'member:a', recipient: 'member:qa', kind: 'info', summary: 'hello', status: 'stored',
    stored: true, visible: false, accepted: false, generation: 1, deadline: null, expectedOutcome: null,
    receiptTimes: { stored: 1000, visible: null, accepted: null } });
  return rows;
}
