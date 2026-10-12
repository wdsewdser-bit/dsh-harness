import test from 'node:test'
import assert from 'node:assert/strict'
import {
  contractDigest,
  createLeaseBinding,
  detectScopeConflicts,
  evaluateReadyGate,
  migrateTaskContract,
  normalizeTaskContract,
  reviseTaskContract,
  transitionTaskLifecycle,
  validateLeaseBinding,
  validateTaskContract,
} from '../home/profiles/web/plugins/team-v12-contract.mjs'
import {
  applyStateMigration,
  auditConsistencyResult,
  classifyStateReadFailure,
  commitStateCas,
  compareStateSnapshots,
  planStateMigration,
  planStateRecovery,
  readStateSnapshot,
  validateStateSchema,
} from '../home/profiles/web/plugins/team-v12-persistence.mjs'
import {
  advanceMergedTask,
  evaluateMergePostcondition,
  prepareMergeOperation,
  recoverMergeOperation,
  verifyMergeOperation,
} from '../home/profiles/web/plugins/team-v12-integration.mjs'

function contract(overrides = {}) {
  return normalizeTaskContract({
    taskId: 'task-1',
    goal: 'Implement persistence',
    owner: 'member-a',
    writeScopes: ['src/persistence'],
    worktreeId: 'wt-a',
    dependencies: [],
    acceptanceCriteria: [{ id: 'ac-1', text: 'node --test passes' }],
    risk: { level: 'low', rationale: 'isolated module' },
    contractRevision: 1,
    lifecycle: 'proposed',
    ...overrides,
  })
}

function state(revision = 1, overrides = {}) {
  return {
    version: 2,
    rootId: 'root',
    revision,
    updatedAt: 100,
    rooms: {},
    rounds: {},
    plans: {},
    dispatches: {},
    leases: {},
    wakeEpisodes: {},
    escalations: {},
    privilegeRequests: {},
    evidence: {},
    packets: {},
    boards: {},
    providerFailures: {},
    frozenMembers: {},
    ...overrides,
  }
}

function mergeOperation(overrides = {}) {
  return {
    operationId: 'op-1',
    sourceRef: 'team/a',
    targetRef: 'main',
    sourceSha: 'source-1',
    sourceTree: 'tree-source',
    baseTargetSha: 'base-1',
    baseTargetTree: 'tree-base',
    strategy: 'merge',
    worktreeId: 'wt-main',
    worktreePath: 'D:/repo',
    owner: 'lead-a',
    leaseId: 'lease-1',
    writeScopes: ['src'],
    taskId: 'task-1',
    idempotencyKey: 'merge-task-1',
    state: 'prepared',
    ...overrides,
  }
}

test('contract normalizes legacy fields, migrates idempotently, and preserves unknown fields', () => {
  const migrated = migrateTaskContract({
    id: 'legacy-1',
    subject: 'Legacy task',
    ownerName: 'member-a',
    blockedBy: ['task-0'],
    write_scopes: ['src/a\\b'],
    acceptance_criteria: ['test passes'],
    riskLevel: 'medium',
    phase: 'plan-approved',
    futureField: { keep: true },
  })
  assert.equal(migrated.ok, true)
  assert.equal(migrated.changed, true)
  assert.equal(migrated.contract.lifecycle, 'ready')
  assert.deepEqual(migrated.contract.writeScopes, ['src/a/b'])
  assert.equal(migrated.contract.futureField.keep, true)
  assert.equal(migrateTaskContract(migrated.contract).changed, false)
})

test('ready gate rejects incomplete contracts and unmet dependencies', () => {
  const incomplete = evaluateReadyGate(contract({
    owner: null,
    writeScopes: [],
    acceptanceCriteria: [],
    risk: { level: 'unknown' },
  }))
  assert.equal(incomplete.ok, false)
  assert.equal(incomplete.reasons.includes('owner-required'), true)
  assert.equal(incomplete.reasons.includes('scope-required'), true)
  assert.equal(incomplete.reasons.includes('acceptance-required'), true)
  assert.equal(incomplete.reasons.includes('risk-required'), true)

  const unmet = evaluateReadyGate(contract({ dependencies: ['task-0'] }), {
    tasks: [{ id: 'task-0', lifecycle: 'running' }],
  })
  assert.equal(unmet.ok, false)
  assert.equal(unmet.reasons.includes('dependency-unmet'), true)
})

test('ready gate rejects dependency cycles', () => {
  const result = evaluateReadyGate(contract({ dependencies: ['task-2'] }), {
    tasks: [{
      id: 'task-2',
      lifecycle: 'ready',
      owner: 'member-b',
      writeScopes: ['src/b'],
      dependencies: ['task-1'],
    }],
  })
  assert.equal(result.ok, false)
  assert.equal(result.reasons.includes('dependency-cycle'), true)
})

test('ready gate checks revision, owner, coordination and scope conflicts', () => {
  const result = evaluateReadyGate(contract({ risk: { level: 'high' } }), {
    expectedRevision: 2,
    members: [{ name: 'member-a', frozen: false }],
    tasks: [{
      id: 'task-2',
      lifecycle: 'running',
      owner: 'member-b',
      writeScopes: ['src/persistence/state'],
      worktreeId: 'wt-a',
    }],
  })
  assert.equal(result.ok, false)
  assert.equal(result.reasons.includes('contract-revision-conflict'), true)
  assert.equal(result.reasons.includes('risk-requires-coordination'), true)
  assert.equal(result.reasons.includes('scope-conflict'), true)
  assert.equal(result.conflicts.length, 1)
})

test('scope conflict detection isolates distinct worktrees', () => {
  const candidate = contract()
  const other = {
    id: 'task-2',
    lifecycle: 'running',
    owner: 'member-b',
    writeScopes: ['src/persistence/state'],
    worktreeId: 'wt-b',
  }
  assert.equal(detectScopeConflicts([other], candidate).length, 0)
  assert.equal(detectScopeConflicts([{ ...other, worktreeId: 'wt-a' }], candidate).length, 1)
  assert.equal(detectScopeConflicts([other], candidate, { worktreeIsolation: false }).length, 1)
})

test('lifecycle transitions enforce the ready and lease gates', () => {
  const ready = transitionTaskLifecycle(contract(), 'ready', { expectedRevision: 1 })
  assert.equal(ready.ok, true)
  assert.equal(ready.contract.lifecycle, 'ready')
  assert.equal(ready.contract.contractRevision, 2)

  const noLease = transitionTaskLifecycle(ready.contract, 'running', { expectedRevision: 2 })
  assert.equal(noLease.ok, false)
  assert.equal(noLease.code, 'lease-required')

  const lease = {
    runId: 'run-1',
    owner: 'member-a',
    status: 'active',
    contractRevision: 2,
    writeScopes: ['src/persistence'],
    worktreeId: 'wt-a',
    expiresAt: 500,
  }
  const binding = createLeaseBinding(ready.contract, lease, { now: 100 })
  assert.equal(binding.ok, true)
  assert.equal(validateLeaseBinding(ready.contract, binding.binding, { lease, now: 100 }).ok, true)
  const running = transitionTaskLifecycle(ready.contract, 'running', {
    expectedRevision: 2,
    lease,
    binding: binding.binding,
    now: 100,
  })
  assert.equal(running.ok, true)
  assert.equal(running.contract.lifecycle, 'running')
  assert.equal(transitionTaskLifecycle(running.contract, 'review', { expectedRevision: 3 }).ok, true)
  assert.equal(transitionTaskLifecycle(contract(), 'completed').ok, false)
})

test('contract revision is CAS protected and active leases must reconfirm execution changes', () => {
  const current = contract({
    lifecycle: 'running',
    lease: {
      runId: 'run-1',
      owner: 'member-a',
      status: 'active',
      contractRevision: 1,
    },
  })
  const stale = reviseTaskContract(current, { goal: 'changed' }, { expectedRevision: 2, actor: 'member-a' })
  assert.equal(stale.code, 'contract-revision-conflict')

  const needsConfirmation = reviseTaskContract(current, { writeScopes: ['src/persistence', 'src/contract'] }, {
    expectedRevision: 1,
    actor: 'member-a',
  })
  assert.equal(needsConfirmation.code, 'lease-confirmation-required')

  const revised = reviseTaskContract(current, { writeScopes: ['src/persistence', 'src/contract'] }, {
    expectedRevision: 1,
    actor: 'member-a',
    leaseConfirmation: { runId: 'run-1', owner: 'member-a', contractRevision: 1 },
  })
  assert.equal(revised.ok, true)
  assert.equal(revised.contract.contractRevision, 2)
  assert.notEqual(revised.contract.lease.binding.scopeHash, createLeaseBinding(current, current.lease).binding?.scopeHash)
})

test('state schema validation preserves unknown fields and classifies read failures', () => {
  const valid = validateStateSchema(state(0, { future: true }))
  assert.equal(valid.ok, true)
  assert.deepEqual(valid.unknownFields, ['future'])
  assert.equal(valid.warnings[0].code, 'unknown-fields-preserved')
  assert.equal(validateStateSchema({ version: 2, revision: -1 }).ok, false)
  assert.equal(classifyStateReadFailure({ code: 'EAGAIN' }).kind, 'transient')
  assert.equal(classifyStateReadFailure(new SyntaxError('bad json')).kind, 'corrupt')
  assert.equal(readStateSnapshot('{"version":2,"revision":1}').ok, true)
  assert.equal(readStateSnapshot('{broken').kind, 'corrupt')
})

test('CAS rejects concurrent revision conflicts and accepts one writer', () => {
  const current = state(3)
  const first = commitStateCas(current, { ...current, revision: 4, rooms: { r: {} } }, 3)
  const second = commitStateCas(first.state, { ...current, revision: 4, rooms: { other: {} } }, 3)
  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.equal(second.code, 'revision-conflict')
  const staleAgain = commitStateCas(first.state, { ...first.state, revision: 5 }, 3)
  assert.equal(staleAgain.code, 'revision-conflict')
})

test('snapshot differences and recovery require explicit root confirmation', () => {
  const current = state(4, { rooms: { r: { status: 'open' } } })
  const snapshot = state(3, { rooms: {} })
  const diff = compareStateSnapshots(current, snapshot)
  assert.equal(diff.equal, false)
  assert.equal(diff.recoverable, true)
  assert.ok(diff.differences.some((row) => row.path === '$.rooms.r'))

  const plan = planStateRecovery({ current, snapshot }, { targetRevision: 3 })
  assert.equal(plan.action, 'keep-current')
  const confirmed = planStateRecovery({ current, snapshot }, { targetRevision: 3, confirm: true })
  assert.equal(confirmed.action, 'restore-snapshot')
  assert.equal(confirmed.mutationAllowed, true)
  assert.equal(confirmed.backupRequired, true)
})

test('corrupt current state is never replaced automatically', () => {
  const plan = planStateRecovery({
    current: { error: new SyntaxError('bad json') },
    snapshot: state(7),
  })
  assert.equal(plan.action, 'restore-snapshot')
  assert.equal(plan.mutationAllowed, false)
  assert.equal(plan.requiresConfirmation, true)
  const transient = planStateRecovery({ current: { error: { code: 'EAGAIN', message: 'busy' } }, snapshot: state(7) })
  assert.equal(transient.action, 'retry-read')
  assert.equal(transient.mutationAllowed, false)
})

test('migration dry-run is explicit, idempotent, and keeps unknown fields', () => {
  const legacy = {
    version: 1,
    rootId: 'root',
    revision: 1,
    boards: {
      global: {
        tasks: {
          t1: {
            id: 't1',
            subject: 'legacy',
            ownerName: 'member-a',
            writeScopes: ['src/a'],
            acceptanceCriteria: ['passes'],
            riskLevel: 'low',
            future: true,
          },
        },
      },
    },
  }
  const dryRun = planStateMigration(legacy)
  assert.equal(dryRun.ok, true)
  assert.equal(dryRun.dryRun, true)
  assert.equal(dryRun.writes, 0)
  assert.equal(legacy.boards.global.tasks.t1.contract, undefined)
  const applied = applyStateMigration(legacy)
  assert.equal(applied.ok, true)
  assert.equal(applied.state.version, 2)
  assert.equal(applied.state.boards.global.tasks.t1.contract.lifecycle, 'proposed')
  assert.equal(applied.state.boards.global.tasks.t1.future, true)
  assert.equal(applyStateMigration(applied.state).changed, false)
})

test('audit consistency detects gaps, duplicates and write failures', () => {
  const consistent = auditConsistencyResult(state(2), [{ revision: 1 }, { revision: 2 }])
  assert.equal(consistent.consistent, true)
  const gap = auditConsistencyResult(state(3), [{ revision: 1 }, { revision: 3 }])
  assert.equal(gap.consistent, false)
  assert.deepEqual(gap.missingRevisions, [2])
  const duplicate = auditConsistencyResult(state(1), [{ revision: 1 }, { revision: 1 }])
  assert.deepEqual(duplicate.duplicateRevisions, [1])
  const failed = auditConsistencyResult(state(1), [], { auditError: new Error('disk full') })
  assert.equal(failed.code, 'audit-write-failed')
})

test('merge operation preparation is idempotent and intent conflicts are rejected', () => {
  const prepared = prepareMergeOperation(mergeOperation())
  assert.equal(prepared.ok, true)
  assert.equal(prepared.operation.state, 'prepared')
  const duplicate = prepareMergeOperation(mergeOperation(), prepared.operation)
  assert.equal(duplicate.ok, true)
  assert.equal(duplicate.deduplicated, true)
  const conflict = prepareMergeOperation(mergeOperation({ sourceSha: 'source-2' }), prepared.operation)
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, 'operation-intent-conflict')
})

test('merge postcondition verifies actual Git ancestry instead of merged:true', () => {
  const operation = mergeOperation({ state: 'merging' })
  const falsePositive = evaluateMergePostcondition(operation, {
    merged: true,
    sourceSha: 'source-1',
    targetBeforeSha: 'base-1',
    targetSha: 'target-1',
    ancestor: false,
  })
  assert.equal(falsePositive.ok, false)
  assert.equal(falsePositive.code, 'tool-false-positive')

  const verified = verifyMergeOperation(operation, {
    merged: false,
    sourceSha: 'source-1',
    targetBeforeSha: 'base-1',
    targetSha: 'target-1',
    targetRefSha: 'target-1',
    ancestor: true,
  })
  assert.equal(verified.ok, true)
  assert.equal(verified.operation.state, 'verified')
})

test('merge verification blocks dirty worktrees and target base races', () => {
  const operation = mergeOperation({ state: 'merging' })
  const dirty = verifyMergeOperation(operation, {
    sourceSha: 'source-1',
    targetBeforeSha: 'base-1',
    targetSha: 'target-1',
    ancestor: true,
    worktreeClean: false,
    dirtyFiles: ['src/a'],
  })
  assert.equal(dirty.code, 'worktree-dirty')
  assert.equal(dirty.operation.state, 'blocked')
  const raced = verifyMergeOperation(operation, {
    sourceSha: 'source-1',
    targetBeforeSha: 'base-2',
    targetSha: 'target-2',
    ancestor: true,
  })
  assert.equal(raced.code, 'target-base-changed')
  assert.equal(raced.operation.state, 'recovery-needed')
})

test('merge postcondition supports fast-forward, squash and explicit conflicts', () => {
  const fastForward = evaluateMergePostcondition(mergeOperation({ strategy: 'fast-forward' }), {
    sourceSha: 'source-1',
    targetBeforeSha: 'base-1',
    targetSha: 'source-1',
    ancestor: true,
    fastForward: true,
  })
  assert.equal(fastForward.ok, true)

  const squash = evaluateMergePostcondition(mergeOperation({ strategy: 'squash' }), {
    sourceSha: 'source-1',
    targetBeforeSha: 'base-1',
    targetSha: 'squash-1',
    ancestor: false,
    patchEquivalent: true,
  })
  assert.equal(squash.ok, true)

  const conflict = evaluateMergePostcondition(mergeOperation({ state: 'merging' }), {
    sourceSha: 'source-1',
    targetBeforeSha: 'base-1',
    targetSha: 'target-1',
    ancestor: false,
    conflict: true,
    conflictFiles: ['src/a'],
  })
  assert.equal(conflict.code, 'merge-conflict')
  assert.equal(conflict.ok, false)
})

test('merge crash recovery recognizes applied Git state and advances task idempotently', () => {
  const operation = mergeOperation({ state: 'merging' })
  const recovered = recoverMergeOperation(operation, {
    sourceSha: 'source-1',
    targetBeforeSha: 'base-1',
    targetSha: 'target-1',
    targetRefSha: 'target-1',
    ancestor: true,
  })
  assert.equal(recovered.action, 'mark-verified')
  assert.equal(recovered.operation.state, 'verified')
  assert.equal(recovered.repeatMerge, false)

  const advanced = advanceMergedTask(recovered.operation, {
    ok: true,
    idempotencyKey: 'merge-task-1',
  })
  assert.equal(advanced.ok, true)
  assert.equal(advanced.operation.state, 'task-advanced')
  const repeated = advanceMergedTask(advanced.operation, { ok: true })
  assert.equal(repeated.ok, true)
  assert.equal(repeated.deduplicated, true)
  assert.equal(repeated.operation.state, 'task-advanced')
})

test('merge recovery does not repeat an unapplied merge and flags uncertain targets', () => {
  const prepared = mergeOperation()
  const safe = recoverMergeOperation(prepared, {
    sourceSha: 'source-1',
    targetBeforeSha: 'base-1',
    targetSha: 'base-1',
    ancestor: false,
  })
  assert.equal(safe.action, 'resume')
  assert.equal(safe.repeatMerge, false)

  const uncertain = recoverMergeOperation(mergeOperation({ state: 'merging' }), {
    sourceSha: 'source-1',
    targetBeforeSha: 'base-1',
    targetSha: 'target-2',
    ancestor: false,
  })
  assert.equal(uncertain.action, 'manual-review')
  assert.equal(uncertain.operation.state, 'recovery-needed')
  assert.equal(uncertain.repeatMerge, false)
})
