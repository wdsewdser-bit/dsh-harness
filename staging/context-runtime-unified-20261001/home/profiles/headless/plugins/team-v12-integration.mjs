/**
 * Agent Team v12 merge-operation state machine.
 *
 * Git postconditions are authoritative. A tool's merged:true flag is evidence
 * input only and is never sufficient to advance a task.
 */
import { createHash } from 'node:crypto'

export const MERGE_OPERATION_STATES = Object.freeze([
  'prepared',
  'merging',
  'verified',
  'task-advanced',
  'blocked',
  'recovery-needed',
])
export const MERGE_STRATEGIES = Object.freeze(['merge', 'fast-forward', 'squash'])
export const MERGE_TERMINAL_STATES = Object.freeze(['task-advanced'])

const MERGE_TRANSITIONS = Object.freeze({
  prepared: new Set(['merging', 'blocked', 'recovery-needed']),
  merging: new Set(['verified', 'blocked', 'recovery-needed']),
  verified: new Set(['task-advanced', 'recovery-needed']),
  'task-advanced': new Set([]),
  blocked: new Set(['prepared', 'merging', 'verified', 'recovery-needed']),
  'recovery-needed': new Set(['prepared', 'merging', 'verified', 'blocked']),
})

const asArray = (value) => Array.isArray(value) ? value : []
const text = (value) => String(value ?? '').trim()
const lower = (value) => text(value).toLowerCase()

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
  return '{' + Object.keys(value).sort()
    .map((key) => JSON.stringify(key) + ':' + stableJson(value[key]))
    .join(',') + '}'
}

function digest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function unique(values) {
  return [...new Set(asArray(values).map(text).filter(Boolean))]
}

/**
 * Normalize a durable merge operation without losing unknown fields.
 * @param {object} input Merge operation input.
 * @returns {object} Normalized operation.
 */
export function normalizeMergeOperation(input = {}) {
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const strategy = lower(source.strategy ?? source.mergeStrategy ?? 'merge')
  const state = lower(source.state ?? source.status ?? 'prepared')
  return {
    ...source,
    operationId: text(source.operationId ?? source.operation_id ?? source.id) || null,
    state: MERGE_OPERATION_STATES.includes(state) ? state : 'prepared',
    revision: Number.isInteger(Number(source.revision)) && Number(source.revision) > 0
      ? Number(source.revision)
      : 1,
    sourceRef: text(source.sourceRef ?? source.source_ref ?? source.sourceBranch) || null,
    targetRef: text(source.targetRef ?? source.target_ref ?? source.targetBranch) || null,
    sourceSha: text(source.sourceSha ?? source.source_sha ?? source.commitSha) || null,
    sourceTree: text(source.sourceTree ?? source.source_tree) || null,
    baseTargetSha: text(source.baseTargetSha ?? source.base_target_sha ?? source.targetShaBefore) || null,
    baseTargetTree: text(source.baseTargetTree ?? source.base_target_tree) || null,
    strategy: MERGE_STRATEGIES.includes(strategy) ? strategy : 'merge',
    worktreeId: text(source.worktreeId ?? source.worktree_id) || null,
    worktreePath: text(source.worktreePath ?? source.worktree_path) || null,
    owner: text(source.owner ?? source.ownerName) || null,
    leaseId: text(source.leaseId ?? source.lease_id ?? source.runId) || null,
    writeScopes: unique(source.writeScopes ?? source.write_scopes),
    taskId: text(source.taskId ?? source.task_id) || null,
    idempotencyKey: text(source.idempotencyKey ?? source.idempotency_key) || null,
    attempt: Number.isInteger(Number(source.attempt)) ? Number(source.attempt) : 0,
    createdAt: source.createdAt ?? source.created_at ?? null,
    updatedAt: source.updatedAt ?? source.updated_at ?? null,
    postcondition: source.postcondition ?? null,
    taskAdvance: source.taskAdvance ?? null,
    blockedReason: source.blockedReason ?? source.blocked_reason ?? null,
  }
}

/**
 * Validate the durable operation shape.
 * @param {object} input Merge operation.
 * @returns {{ok: boolean, errors: object[], operation: object}}
 */
export function validateMergeOperation(input) {
  const operation = normalizeMergeOperation(input)
  const errors = []
  const add = (code, path, message) => errors.push({ code, path, message })
  if (operation.operationId === null) add('operation-id-required', 'operationId', 'operation id is required')
  if (operation.sourceRef === null) add('source-ref-required', 'sourceRef', 'source ref is required')
  if (operation.targetRef === null) add('target-ref-required', 'targetRef', 'target ref is required')
  if (operation.sourceSha === null) add('source-sha-required', 'sourceSha', 'source SHA is required')
  if (operation.baseTargetSha === null) add('base-target-sha-required', 'baseTargetSha', 'base target SHA is required')
  if (operation.owner === null) add('owner-required', 'owner', 'merge owner is required')
  if (operation.leaseId === null) add('lease-required', 'leaseId', 'owner lease is required')
  if (operation.writeScopes.length === 0) add('scope-required', 'writeScopes', 'merge scope is required')
  if (!MERGE_STRATEGIES.includes(operation.strategy)) add('strategy-invalid', 'strategy', 'unknown merge strategy')
  return { ok: errors.length === 0, errors, operation }
}

/**
 * Stable digest of immutable merge intent fields.
 * @param {object} input Merge operation.
 * @returns {string} Intent digest.
 */
export function mergeOperationDigest(input) {
  const operation = normalizeMergeOperation(input)
  return digest({
    operationId: operation.operationId,
    sourceRef: operation.sourceRef,
    targetRef: operation.targetRef,
    sourceSha: operation.sourceSha,
    sourceTree: operation.sourceTree,
    baseTargetSha: operation.baseTargetSha,
    baseTargetTree: operation.baseTargetTree,
    strategy: operation.strategy,
    worktreeId: operation.worktreeId,
    worktreePath: operation.worktreePath,
    owner: operation.owner,
    leaseId: operation.leaseId,
    writeScopes: operation.writeScopes,
    taskId: operation.taskId,
    idempotencyKey: operation.idempotencyKey,
  })
}

/** Alias for intent-idempotency checks. */
export const operationIntentDigest = mergeOperationDigest

/**
 * Prepare an idempotent merge operation.
 * @param {object} input Operation input.
 * @param {object} [existing] Existing operation with the same id, when present.
 * @returns {{ok: boolean, code: string, operation?: object, deduplicated: boolean}}
 */
export function prepareMergeOperation(input, existing) {
  const validation = validateMergeOperation(input)
  if (!validation.ok) {
    return { ok: false, code: 'invalid-merge-operation', operation: validation.operation, deduplicated: false, errors: validation.errors }
  }
  const operation = { ...validation.operation, state: 'prepared' }
  if (existing !== undefined && existing !== null) {
    const prior = normalizeMergeOperation(existing)
    if (prior.operationId !== operation.operationId) {
      return { ok: false, code: 'operation-id-conflict', operation: prior, deduplicated: false }
    }
    if (mergeOperationDigest(prior) !== mergeOperationDigest(operation)) {
      return { ok: false, code: 'operation-intent-conflict', operation: prior, deduplicated: false }
    }
    return { ok: true, code: 'already-prepared', operation: prior, deduplicated: true }
  }
  return { ok: true, code: 'prepared', operation, deduplicated: false }
}

/** Whether a merge-operation transition is allowed. */
export function canTransitionMergeOperation(from, to) {
  const current = normalizeMergeOperation({ state: from }).state
  const next = normalizeMergeOperation({ state: to }).state
  return current === next || MERGE_TRANSITIONS[current]?.has(next) === true
}

/**
 * Apply a CAS-protected merge-operation state transition.
 * @param {object} input Current operation.
 * @param {string} to Next state.
 * @param {object} [context] CAS and transition evidence.
 * @returns {{ok: boolean, code: string, operation: object}}
 */
export function transitionMergeOperation(input, to, context = {}) {
  const operation = normalizeMergeOperation(input)
  const nextState = normalizeMergeOperation({ state: to }).state
  if (context.expectedRevision !== undefined && Number(context.expectedRevision) !== operation.revision) {
    return { ok: false, code: 'operation-revision-conflict', operation }
  }
  const recovery = context.recovery === true
  if (!canTransitionMergeOperation(operation.state, nextState)
    && !(recovery && ['prepared', 'blocked', 'recovery-needed'].includes(operation.state) && nextState === 'verified')) {
    return { ok: false, code: 'invalid-merge-transition', operation }
  }
  if (nextState === 'verified') {
    const postcondition = context.postcondition ?? operation.postcondition
    if (postcondition?.ok !== true) return { ok: false, code: 'merge-postcondition-required', operation }
  }
  if (nextState === 'task-advanced') {
    const advance = context.taskAdvance ?? operation.taskAdvance
    if (advance?.ok !== true && advance?.alreadyAdvanced !== true) {
      return { ok: false, code: 'task-advance-evidence-required', operation }
    }
  }
  const next = {
    ...operation,
    state: nextState,
    revision: operation.revision + 1,
    updatedAt: context.now ?? operation.updatedAt,
    blockedReason: ['blocked', 'recovery-needed'].includes(nextState)
      ? text(context.reason ?? operation.blockedReason) || null
      : null,
  }
  if (context.postcondition !== undefined) next.postcondition = context.postcondition
  if (context.taskAdvance !== undefined) next.taskAdvance = context.taskAdvance
  if (nextState === 'merging') next.attempt = operation.attempt + 1
  return { ok: true, code: 'transitioned', operation: next }
}

function shaEqual(actual, expected) {
  return text(actual) !== '' && text(actual) === text(expected)
}

/**
 * Evaluate Git's actual postcondition. toolResult.merged is intentionally ignored.
 * @param {object} input Merge operation.
 * @param {object} actual Git observations.
 * @returns {{ok: boolean, code: string, verified: boolean, evidence: object}}
 */
export function evaluateMergePostcondition(input, actual = {}) {
  const operation = normalizeMergeOperation(input)
  const evidence = {
    strategy: operation.strategy,
    sourceSha: text(actual.sourceSha) || null,
    targetBeforeSha: text(actual.targetBeforeSha ?? actual.baseTargetSha) || null,
    targetSha: text(actual.targetSha ?? actual.headSha) || null,
    targetTree: text(actual.targetTree ?? actual.treeHash) || null,
    targetRefSha: text(actual.targetRefSha ?? actual.refSha) || null,
    containsSource: actual.containsSource === true || actual.ancestor === true,
    sourceTreeInTarget: actual.sourceTreeInTarget === true,
    patchEquivalent: actual.patchEquivalent === true,
    fastForward: actual.fastForward === true,
    worktreeClean: actual.worktreeClean !== false,
    mergeInProgress: actual.mergeInProgress === true,
  }
  const fail = (code, extra = {}) => ({
    ok: false,
    code,
    verified: false,
    evidence: { ...evidence, ...extra },
  })
  if (actual.error !== undefined) return fail('git-inspection-failed', { error: text(actual.error?.message ?? actual.error) })
  if (evidence.mergeInProgress) return fail('merge-in-progress')
  if (actual.conflict === true || asArray(actual.conflictFiles).length > 0) {
    return fail('merge-conflict', { conflictFiles: asArray(actual.conflictFiles).map(text) })
  }
  if (!evidence.worktreeClean || asArray(actual.dirtyFiles).length > 0) {
    return fail('worktree-dirty', { dirtyFiles: asArray(actual.dirtyFiles).map(text) })
  }
  if (evidence.sourceSha === null) return fail('source-sha-missing')
  if (!shaEqual(evidence.sourceSha, operation.sourceSha)) return fail('source-sha-changed')
  if (text(actual.sourceTree) !== '' && !shaEqual(actual.sourceTree, operation.sourceTree)) {
    return fail('source-tree-changed')
  }
  if (evidence.targetBeforeSha !== null && evidence.targetBeforeSha !== operation.baseTargetSha) {
    return fail('target-base-changed')
  }
  if (evidence.targetSha === null) return fail('target-sha-missing')
  if (evidence.targetRefSha !== null && evidence.targetRefSha !== evidence.targetSha) {
    return fail('target-ref-mismatch')
  }
  if (operation.strategy === 'squash') {
    if (!evidence.patchEquivalent && !evidence.sourceTreeInTarget) {
      return fail('tool-false-positive', { reason: 'squash has no source ancestry and no tree/patch equivalence evidence' })
    }
  } else {
    if (!evidence.containsSource) return fail('tool-false-positive', { reason: 'source commit is not contained by target' })
    if (operation.strategy === 'fast-forward'
      && (actual.fastForward !== true || evidence.targetSha !== operation.sourceSha)) {
      return fail('not-fast-forward', { expectedTargetSha: operation.sourceSha })
    }
  }
  return {
    ok: true,
    code: 'verified',
    verified: true,
    evidence: {
      ...evidence,
      sourceSha: operation.sourceSha,
      baseTargetSha: operation.baseTargetSha,
      targetSha: evidence.targetSha,
      toolReportedMerged: actual.merged === true,
    },
  }
}

/** Alias for callers that inspect rather than mutate. */
export const inspectMergePostcondition = evaluateMergePostcondition

/**
 * Verify and persist a merge operation's postcondition.
 * @param {object} input Current operation.
 * @param {object} actual Git observations.
 * @param {object} [options] CAS options.
 * @returns {{ok: boolean, code: string, operation: object, postcondition: object}}
 */
export function verifyMergeOperation(input, actual, options = {}) {
  const operation = normalizeMergeOperation(input)
  const postcondition = evaluateMergePostcondition(operation, actual)
  if (!postcondition.ok) {
    const nextState = ['tool-false-positive', 'target-base-changed', 'target-ref-mismatch', 'git-inspection-failed']
      .includes(postcondition.code) ? 'recovery-needed' : 'blocked'
    const transition = transitionMergeOperation(operation, nextState, {
      ...options,
      reason: postcondition.code,
      postcondition,
    })
    return {
      ok: false,
      code: postcondition.code,
      operation: transition.ok ? transition.operation : operation,
      postcondition,
    }
  }
  const transition = transitionMergeOperation(operation, 'verified', {
    ...options,
    postcondition,
  })
  return {
    ok: transition.ok,
    code: transition.code === 'transitioned' ? 'verified' : transition.code,
    operation: transition.operation,
    postcondition,
  }
}

/**
 * Advance task state after merge verification, idempotently.
 * @param {object} input Current operation.
 * @param {object} taskAdvance Task CAS result.
 * @param {object} [options] CAS options.
 * @returns {{ok: boolean, code: string, operation: object, deduplicated: boolean}}
 */
export function advanceMergedTask(input, taskAdvance, options = {}) {
  const operation = normalizeMergeOperation(input)
  if (operation.state === 'task-advanced') {
    return { ok: true, code: 'already-task-advanced', operation, deduplicated: true }
  }
  if (operation.state !== 'verified') {
    return { ok: false, code: 'merge-not-verified', operation, deduplicated: false }
  }
  if (taskAdvance?.alreadyAdvanced === true) {
    const transition = transitionMergeOperation(operation, 'task-advanced', {
      ...options,
      taskAdvance: { ...taskAdvance, ok: true },
    })
    return {
      ok: transition.ok,
      code: transition.ok ? 'already-task-advanced' : transition.code,
      operation: transition.operation,
      deduplicated: transition.ok,
    }
  }
  if (taskAdvance?.ok !== true) {
    return { ok: false, code: 'task-advance-failed', operation, deduplicated: false }
  }
  if (operation.idempotencyKey !== null
    && taskAdvance.idempotencyKey !== undefined
    && text(taskAdvance.idempotencyKey) !== operation.idempotencyKey) {
    return { ok: false, code: 'idempotency-key-mismatch', operation, deduplicated: false }
  }
  const transition = transitionMergeOperation(operation, 'task-advanced', {
    ...options,
    taskAdvance,
  })
  return {
    ok: transition.ok,
    code: transition.ok ? 'task-advanced' : transition.code,
    operation: transition.operation,
    deduplicated: false,
  }
}

function recoverToVerified(operation, postcondition, options) {
  const transition = transitionMergeOperation(operation, 'verified', {
    ...options,
    recovery: true,
    postcondition,
  })
  return {
    ok: transition.ok,
    action: 'mark-verified',
    code: transition.ok ? 'verified' : transition.code,
    operation: transition.operation,
    idempotent: true,
    repeatMerge: false,
  }
}

/**
 * Decide how to recover from a crash without repeating an already-applied merge.
 * @param {object} input Persisted operation.
 * @param {object} actual Git observations.
 * @param {object} [options] Recovery options.
 * @returns {{ok: boolean, action: string, code: string, operation: object, idempotent: boolean, repeatMerge: boolean}}
 */
export function recoverMergeOperation(input, actual = {}, options = {}) {
  const operation = normalizeMergeOperation(input)
  const postcondition = evaluateMergePostcondition(operation, actual)
  if (operation.state === 'task-advanced') {
    return { ok: true, action: 'none', code: 'already-task-advanced', operation, idempotent: true, repeatMerge: false }
  }
  if (operation.state === 'verified') {
    if (actual.taskAdvanced === true || options.taskAdvanced === true) {
      const transition = transitionMergeOperation(operation, 'task-advanced', {
        ...options,
        taskAdvance: { ok: true, alreadyAdvanced: true, idempotencyKey: operation.idempotencyKey },
      })
      return {
        ok: transition.ok,
        action: 'mark-task-advanced',
        code: transition.ok ? 'task-advanced' : transition.code,
        operation: transition.operation,
        idempotent: true,
        repeatMerge: false,
      }
    }
    return {
      ok: true,
      action: 'advance-task',
      code: 'verified',
      operation,
      idempotent: true,
      repeatMerge: false,
    }
  }
  if (postcondition.ok) return recoverToVerified(operation, postcondition, options)
  if (postcondition.code === 'merge-in-progress') {
    return {
      ok: false,
      action: 'wait',
      code: postcondition.code,
      operation,
      idempotent: true,
      repeatMerge: false,
    }
  }
  const targetUnchanged = text(actual.targetSha ?? actual.headSha) === operation.baseTargetSha
  const sourceAbsent = !postcondition.evidence.containsSource
    && !postcondition.evidence.sourceTreeInTarget
    && !postcondition.evidence.patchEquivalent
  if (operation.state === 'prepared' && targetUnchanged && sourceAbsent && postcondition.code === 'tool-false-positive') {
    return {
      ok: true,
      action: 'resume',
      code: 'safe-to-start',
      operation,
      idempotent: true,
      repeatMerge: false,
    }
  }
  if (operation.state === 'merging' && targetUnchanged && sourceAbsent && postcondition.code === 'tool-false-positive') {
    return {
      ok: true,
      action: 'resume-merge',
      code: 'merge-not-applied',
      operation,
      idempotent: true,
      repeatMerge: false,
    }
  }
  const nextState = ['worktree-dirty', 'merge-in-progress'].includes(postcondition.code)
    ? 'blocked'
    : 'recovery-needed'
  const transition = transitionMergeOperation(operation, nextState, {
    ...options,
    recovery: true,
    reason: postcondition.code,
    postcondition,
  })
  return {
    ok: false,
    action: 'manual-review',
    code: postcondition.code,
    operation: transition.ok ? transition.operation : operation,
    idempotent: true,
    repeatMerge: false,
  }
}

/** Alias for callers treating recovery as a decision function. */
export const recoveryDecision = recoverMergeOperation
export const prepareMerge = prepareMergeOperation
export const verifyMerge = verifyMergeOperation
export const advanceMergeTask = advanceMergedTask
export const recoverMerge = recoverMergeOperation

/** Whether an operation has reached its terminal task-advanced state. */
export function isMergeOperationTerminal(input) {
  return MERGE_TERMINAL_STATES.includes(normalizeMergeOperation(input).state)
}
