/**
 * HMR activation marker: 2026-09-24T19:50+08:00.
 *
 * Agent Team v12 task-contract primitives.
 *
 * This module is deliberately pure: it normalizes, validates and evaluates
 * task contracts, but it does not read or write control-plane state.
 */
import { createHash } from 'node:crypto'

export const TASK_CONTRACT_SCHEMA_VERSION = 2
export const LIFECYCLE_STATES = Object.freeze([
  'proposed',
  'ready',
  'running',
  'blocked',
  'review',
  'completed',
  'cancelled',
  'invalidated',
])
export const TERMINAL_LIFECYCLE_STATES = Object.freeze([
  'completed',
  'cancelled',
  'invalidated',
])
export const RISK_LEVELS = Object.freeze([
  'unknown',
  'low',
  'medium',
  'high',
  'critical',
])

const LIFECYCLE_TRANSITIONS = Object.freeze({
  proposed: new Set(['ready', 'cancelled', 'invalidated']),
  ready: new Set(['proposed', 'running', 'blocked', 'cancelled', 'invalidated']),
  running: new Set(['blocked', 'review', 'completed', 'cancelled']),
  blocked: new Set(['proposed', 'ready', 'review', 'cancelled', 'invalidated']),
  review: new Set(['running', 'blocked', 'completed', 'cancelled', 'invalidated']),
  completed: new Set(['proposed', 'ready']),
  cancelled: new Set(['proposed', 'ready']),
  invalidated: new Set(['proposed', 'ready']),
})

const ACTIVE_CONFLICT_STATES = new Set(['ready', 'running', 'blocked', 'review'])
const EXECUTION_KEYS = new Set([
  'owner',
  'writeScopes',
  'worktreeId',
  'dependencies',
  'acceptanceCriteria',
  'risk',
])

const asArray = (value) => Array.isArray(value) ? value : []
const text = (value) => String(value ?? '').trim()
const lower = (value) => text(value).toLowerCase()
const unique = (values) => [...new Set(values.map(text).filter(Boolean))]

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

function normalizeScope(value) {
  let scope = text(value).replace(/\\/g, '/').replace(/^\.\//, '')
  while (scope.includes('//')) scope = scope.replace(/\/\//g, '/')
  if (scope.length > 1) scope = scope.replace(/\/+$/, '')
  return scope
}

function normalizeAcceptance(value) {
  return asArray(value).map((item, index) => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      return {
        ...item,
        id: text(item.id || item.requirementId || 'ac-' + String(index + 1)),
        text: text(item.text ?? item.criterion ?? item.description),
        required: item.required !== false,
      }
    }
    return {
      id: 'ac-' + String(index + 1),
      text: text(item),
      required: true,
    }
  }).filter((item) => item.text.length > 0)
}

function normalizeRisk(value, source = {}) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const level = lower(value.level ?? value.riskLevel ?? source.riskLevel)
    return {
      ...value,
      level: RISK_LEVELS.includes(level) ? level : 'unknown',
      rationale: text(value.rationale ?? value.reason ?? source.riskRationale),
    }
  }
  const level = lower(value ?? source.riskLevel)
  return {
    level: RISK_LEVELS.includes(level) ? level : 'unknown',
    rationale: text(source.riskRationale),
  }
}

function normalizeLifecycle(value) {
  const state = lower(value)
  const legacy = {
    draft: 'proposed',
    pending: 'proposed',
    'plan-proposed': 'proposed',
    'room-discussion': 'proposed',
    approved: 'ready',
    'plan-approved': 'ready',
    'in_progress': 'running',
    in_progress: 'running',
    execution: 'running',
    active: 'running',
    'member-check': 'review',
    'group-check': 'review',
    'verifier-review': 'review',
    'integration-ready': 'review',
    integrated: 'completed',
    accepted: 'completed',
    done: 'completed',
    canceled: 'cancelled',
    rejected: 'invalidated',
    expired: 'invalidated',
  }
  const normalized = legacy[state] ?? state
  return LIFECYCLE_STATES.includes(normalized) ? normalized : 'proposed'
}

function scopeHash(scopes) {
  return digest(unique(scopes.map(normalizeScope)))
}

function taskIdentity(task) {
  return text(task?.taskId ?? task?.id ?? task?.contractId)
}

function taskLifecycle(task) {
  return normalizeLifecycle(task?.lifecycle ?? task?.status ?? task?.phase ?? task?.contract?.lifecycle)
}

function dependencyReferenceMatches(reference, taskId) {
  const wanted = text(taskId)
  const value = text(reference)
  return wanted.length > 0 && (value === wanted || value.endsWith(':' + wanted))
}

/**
 * Normalize one task contract while preserving unknown fields.
 * @param {object} input Legacy task row or a v12 task contract.
 * @returns {object} Normalized contract.
 */
export function normalizeTaskContract(input = {}) {
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const nested = source.contract !== null && typeof source.contract === 'object' && !Array.isArray(source.contract)
    ? source.contract
    : {}
  const merged = { ...source, ...nested }
  const scopeValue = merged.writeScopes ?? merged.write_scopes ?? merged.scope
  const scopeObject = scopeValue !== null && typeof scopeValue === 'object' && !Array.isArray(scopeValue)
    ? scopeValue
    : {}
  const scopes = Array.isArray(scopeValue)
    ? scopeValue
    : typeof scopeValue === 'string'
      ? [scopeValue]
      : asArray(scopeObject.writeScopes ?? scopeObject.paths)
  const goal = text(merged.goal ?? merged.deliverable ?? merged.subject ?? merged.description)
  const deliverable = text(merged.deliverable ?? merged.goal ?? merged.subject ?? merged.description)
  const acceptance = merged.acceptanceCriteria
    ?? merged.acceptance_criteria
    ?? merged.acceptance
    ?? merged.doneWhen
    ?? merged.done_when
  const dependencies = merged.dependencies
    ?? merged.blockedBy
    ?? merged.blocked_by
    ?? merged.dependsOn
    ?? merged.depends_on
  const revisionValue = Number(merged.contractRevision ?? merged.contract_revision ?? merged.revision ?? 1)
  const contractRevision = Number.isInteger(revisionValue) && revisionValue > 0 ? revisionValue : 1
  const normalized = {
    ...source,
    ...merged,
    schemaVersion: Number(merged.schemaVersion ?? merged.contractVersion ?? TASK_CONTRACT_SCHEMA_VERSION),
    contractId: text(merged.contractId ?? merged.taskId ?? merged.id) || null,
    taskId: text(merged.taskId ?? merged.id ?? merged.contractId) || null,
    goal,
    deliverable,
    owner: text(merged.owner ?? merged.ownerName ?? merged.owner_name) || null,
    writeScopes: unique(scopes.map(normalizeScope)),
    worktreeId: text(merged.worktreeId ?? merged.worktree_id ?? scopeObject.worktreeId ?? scopeObject.worktree_id) || null,
    dependencies: unique(asArray(dependencies)),
    acceptanceCriteria: normalizeAcceptance(acceptance),
    risk: normalizeRisk(merged.risk, merged),
    contractRevision,
    lifecycle: normalizeLifecycle(merged.lifecycle ?? merged.status ?? merged.phase),
    lease: merged.lease !== null && typeof merged.lease === 'object' && !Array.isArray(merged.lease)
      ? { ...merged.lease }
      : null,
    createdAt: merged.createdAt ?? merged.created_at ?? null,
    updatedAt: merged.updatedAt ?? merged.updated_at ?? null,
  }
  if (normalized.schemaVersion <= 0) normalized.schemaVersion = TASK_CONTRACT_SCHEMA_VERSION
  return normalized
}

/**
 * Stable digest of a normalized contract's semantic fields.
 * @param {object} contract Task contract.
 * @returns {string} SHA-256 digest.
 */
export function contractDigest(contract) {
  const value = normalizeTaskContract(contract)
  return digest({
    schemaVersion: value.schemaVersion,
    contractId: value.contractId,
    taskId: value.taskId,
    goal: value.goal,
    deliverable: value.deliverable,
    owner: value.owner,
    writeScopes: value.writeScopes,
    worktreeId: value.worktreeId,
    dependencies: value.dependencies,
    acceptanceCriteria: value.acceptanceCriteria,
    risk: value.risk,
    contractRevision: value.contractRevision,
    lifecycle: value.lifecycle,
  })
}

/**
 * Validate the required v12 task-contract shape.
 * @param {object} input Task contract.
 * @param {object} [options] Validation options.
 * @returns {{ok: boolean, errors: object[], contract: object}}
 */
export function validateTaskContract(input, options = {}) {
  const contract = normalizeTaskContract(input)
  const errors = []
  const add = (code, path, message) => errors.push({ code, path, message })
  if (contract.goal.length === 0) add('goal-required', 'goal', 'goal or deliverable is required')
  const claimOwner = text(options.claimOwner)
  if (contract.owner === null && claimOwner.length === 0) add('owner-required', 'owner', 'a unique owner is required')
  if (contract.owner === null && claimOwner.length > 0) contract.owner = claimOwner
  const readOnly = ['discussion', 'review'].includes(lower(contract.kind ?? contract.workKind))
  const emptyWriteScopesAllowed = options.allowEmptyWriteScopes === true
  if (contract.writeScopes.length === 0
    && !(readOnly && options.allowReadOnly === true)
    && emptyWriteScopesAllowed !== true) {
    add('scope-required', 'writeScopes', 'at least one write scope is required')
  }
  if (!contract.acceptanceCriteria.some((item) => item.required)) {
    add('acceptance-required', 'acceptanceCriteria', 'at least one required acceptance criterion is required')
  }
  if (!RISK_LEVELS.includes(contract.risk.level) || contract.risk.level === 'unknown') {
    add('risk-required', 'risk.level', 'risk must be assessed as low, medium, high or critical')
  }
  if (!Number.isInteger(contract.contractRevision) || contract.contractRevision < 1) {
    add('contract-revision-invalid', 'contractRevision', 'contract revision must be a positive integer')
  }
  if (!LIFECYCLE_STATES.includes(contract.lifecycle)) {
    add('lifecycle-invalid', 'lifecycle', 'unknown lifecycle state')
  }
  return { ok: errors.length === 0, errors, contract }
}

/**
 * Migrate a legacy task row to a v12 contract without mutating the input.
 * @param {object} input Legacy task row or contract.
 * @param {number} [targetVersion] Target schema version.
 * @returns {{ok: boolean, changed: boolean, fromVersion: number, toVersion: number, contract?: object, code?: string, warnings: string[]}}
 */
export function migrateTaskContract(input, targetVersion = TASK_CONTRACT_SCHEMA_VERSION) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const fromVersion = Number(source.schemaVersion ?? source.contractVersion ?? source.version ?? 1)
  if (targetVersion < fromVersion) {
    return {
      ok: false,
      changed: false,
      fromVersion,
      toVersion: targetVersion,
      code: 'schema-downgrade-unsupported',
      warnings: [],
    }
  }
  const contract = normalizeTaskContract(source)
  contract.schemaVersion = targetVersion
  const warnings = []
  if (fromVersion < 2) warnings.push('legacy-task-contract-normalized')
  const changed = stableJson(source) !== stableJson(contract)
  return { ok: true, changed, fromVersion, toVersion: targetVersion, contract, warnings }
}

/** Whether a lifecycle transition is explicitly allowed. */
export function canTransitionLifecycle(from, to) {
  const current = normalizeLifecycle(from)
  const next = normalizeLifecycle(to)
  return current === next || LIFECYCLE_TRANSITIONS[current]?.has(next) === true
}

/** Return normalized scope overlap, or null when scopes cannot conflict. */
export function normalizeContractScope(scope) {
  const value = normalizeScope(scope)
  return value.length === 0 ? null : value
}

/** Whether two normalized workspace-relative scopes overlap. */
export function scopesOverlap(left, right) {
  const a = normalizeContractScope(left)
  const b = normalizeContractScope(right)
  if (a === null || b === null) return false
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/')
}

function taskRows(tasks) {
  if (Array.isArray(tasks)) return tasks
  if (tasks !== null && typeof tasks === 'object') return Object.values(tasks)
  return []
}

/**
 * Detect write-scope conflicts with other active tasks.
 * Different non-empty worktree IDs are isolated unless worktreeIsolation is false.
 * @param {object[]|object} tasks Active tasks.
 * @param {object} candidate Candidate task contract.
 * @param {object} [options] Conflict options.
 * @returns {object[]} Conflict rows.
 */
export function detectScopeConflicts(tasks, candidate, options = {}) {
  const next = normalizeTaskContract(candidate)
  next.lifecycle = taskLifecycle(candidate)
  const nextId = taskIdentity(next)
  const conflicts = []
  const leases = options.leases === undefined || options.leases === null
    ? undefined
    : Array.isArray(options.leases)
      ? options.leases
      : Object.values(options.leases)
  const activeLeaseTaskIds = leases === undefined
    ? undefined
    : new Set(leases
      .filter((lease) => lower(lease?.status) === 'active')
      .map((lease) => text(lease?.taskId))
      .filter(Boolean))
  for (const task of taskRows(tasks)) {
    if (lower(task?.status) === 'deleted') continue
    const other = normalizeTaskContract(task)
    // The top-level board row is the live projection. A nested contract can
    // contain a stale lifecycle copied at creation time; it must not make a
    // completed task look active and trigger a false scope conflict.
    other.lifecycle = taskLifecycle(task)
    const otherId = taskIdentity(other)
    if (nextId !== '' && nextId === otherId) continue
    // A task that declares the candidate as an unmet dependency cannot be
    // in flight. Treating it as an active scope owner creates the exact
    // A-needs-B-to-yield / B-depends-on-A deadlock B-228 describes.
    if (taskLifecycle(next) !== 'completed'
      && other.dependencies.some((dependency) => dependencyReferenceMatches(dependency, nextId))) {
      continue
    }
    if (!ACTIVE_CONFLICT_STATES.has(other.lifecycle)) continue
    // A blocked task still owns its write scope only while it holds an active
    // run lease. Once the lease is released, the card remains blocked but its
    // write claim is no longer a live exclusion.
    if (other.lifecycle === 'blocked'
      && activeLeaseTaskIds !== undefined
      && !activeLeaseTaskIds.has(otherId)) continue
    if (options.worktreeIsolation !== false
      && next.worktreeId !== null
      && other.worktreeId !== null
      && next.worktreeId !== other.worktreeId) continue
    for (const left of next.writeScopes) {
      for (const right of other.writeScopes) {
        if (!scopesOverlap(left, right)) continue
        conflicts.push({
          taskId: otherId || null,
          owner: other.owner,
          left,
          right,
          sameOwner: next.owner !== null && next.owner === other.owner,
          worktreeId: other.worktreeId,
        })
      }
    }
  }
  return conflicts
}

/**
 * Find dependency cycles reachable from the candidate task.
 * @param {object[]|object} tasks Task rows.
 * @param {object} candidate Candidate contract.
 * @returns {string[][]} Cycles, each ending with the repeated task id.
 */
export function detectDependencyCycles(tasks, candidate) {
  const rows = taskRows(tasks).map(normalizeTaskContract)
  const next = normalizeTaskContract(candidate)
  const byId = new Map(rows.map((row) => [taskIdentity(row), row]))
  if (taskIdentity(next) !== '') byId.set(taskIdentity(next), next)
  const cycles = []
  const seenCycles = new Set()
  const visit = (id, path, active) => {
    const index = path.indexOf(id)
    if (index >= 0) {
      const cycle = [...path.slice(index), id]
      const key = cycle.join('>')
      if (!seenCycles.has(key)) {
        seenCycles.add(key)
        cycles.push(cycle)
      }
      return
    }
    if (active.has(id)) return
    const row = byId.get(id)
    if (row === undefined) return
    active.add(id)
    for (const dependency of row.dependencies) visit(dependency, [...path, id], active)
    active.delete(id)
  }
  for (const id of byId.keys()) visit(id, [], new Set())
  return cycles
}

function memberFor(context, owner) {
  const members = Array.isArray(context.members)
    ? context.members
    : context.members !== null && typeof context.members === 'object'
      ? Object.values(context.members)
      : []
  return members.find((member) => text(member?.name ?? member?.id) === owner)
}

function dependencyState(context, dependency) {
  const tasks = Array.isArray(context.tasks)
    ? context.tasks
    : context.tasks !== null && typeof context.tasks === 'object'
      ? Object.values(context.tasks)
      : []
  const row = tasks.find((task) => taskIdentity(task) === dependency)
  return row === undefined ? null : taskLifecycle(row)
}

/**
 * Evaluate the hard gate before a task may become ready.
 * @param {object} input Candidate task contract.
 * @param {object} [context] Members, tasks, leases, coordination and expected revisions.
 * @returns {{ok: boolean, code: string, reasons: string[], conflicts: object[], dependencyCycles: string[][], contract: object}}
 */
export function evaluateReadyGate(input, context = {}) {
  const contract = normalizeTaskContract(input)
  const claimOwner = text(context.claimOwner)
  if (contract.owner === null && claimOwner.length > 0) contract.owner = claimOwner
  const reasons = []
  const validation = validateTaskContract(contract, context)
  for (const error of validation.errors) reasons.push(error.code)
  const expectedRevision = context.expectedRevision ?? context.expectedContractRevision
  if (expectedRevision !== undefined && Number(expectedRevision) !== contract.contractRevision) {
    reasons.push('contract-revision-conflict')
  }
  if (contract.owner === null) {
    reasons.push('owner-required')
  } else if (Array.isArray(context.members) || (context.members !== null && typeof context.members === 'object')) {
    const owner = memberFor(context, contract.owner)
    if (owner === undefined) reasons.push('owner-unknown')
    else if (owner.frozen === true) reasons.push('owner-frozen')
  }
  for (const dependency of contract.dependencies) {
    const state = dependencyState(context, dependency)
    if (state === null) reasons.push('dependency-missing')
    else if (!TERMINAL_LIFECYCLE_STATES.includes(state) || state !== 'completed') {
      reasons.push('dependency-unmet')
    }
  }
  const dependencyCycles = detectDependencyCycles(context.tasks ?? [], contract)
    .filter((cycle) => cycle.includes(taskIdentity(contract)))
  if (dependencyCycles.length > 0) reasons.push('dependency-cycle')
  const coordinated = context.coordinated === true
    || text(context.roomId ?? contract.roomId).length > 0
  if (['high', 'critical'].includes(contract.risk.level) && !coordinated) {
    reasons.push('risk-requires-coordination')
  }
  const conflicts = detectScopeConflicts(context.tasks ?? [], contract, context)
  if (conflicts.length > 0) reasons.push('scope-conflict')
  const leases = Array.isArray(context.leases)
    ? context.leases
    : context.leases !== null && typeof context.leases === 'object'
      ? Object.values(context.leases)
      : []
  for (const lease of leases) {
    if (lower(lease?.status) !== 'active') continue
    if (text(lease?.taskId) !== taskIdentity(contract)) continue
    if (text(lease?.owner ?? lease?.member) !== contract.owner) reasons.push('lease-owner-mismatch')
    if (Number(lease?.contractRevision ?? lease?.revision) !== contract.contractRevision) {
      reasons.push('lease-revision-mismatch')
    }
  }
  const uniqueReasons = unique(reasons)
  return {
    ok: uniqueReasons.length === 0,
    code: uniqueReasons.length === 0 ? 'ready' : 'not-ready',
    reasons: uniqueReasons,
    conflicts,
    dependencyCycles,
    contract,
  }
}

/** Alias for callers that treat the ready check as a named gate. */
export const readyGate = evaluateReadyGate
export const contractReadyGate = evaluateReadyGate
export const normalizeContract = normalizeTaskContract
export const migrateContract = migrateTaskContract
export const validateContract = validateTaskContract

function activeLeaseFor(contract, options) {
  const lease = options.activeLease ?? contract.lease
  if (lease === null || typeof lease !== 'object') return null
  return lower(lease.status ?? 'active') === 'active' ? lease : null
}

/**
 * Create a lease binding to one exact contract revision and execution scope.
 * @param {object} input Task contract.
 * @param {object} lease Run lease.
 * @param {object} [options] Clock and actor options.
 * @returns {{ok: boolean, code: string, binding?: object}}
 */
export function createLeaseBinding(input, lease, options = {}) {
  const contract = normalizeTaskContract(input)
  const owner = text(lease?.owner ?? lease?.member)
  if (lease === null || typeof lease !== 'object') return { ok: false, code: 'lease-required' }
  if (lower(lease.status ?? 'active') !== 'active') return { ok: false, code: 'lease-not-active' }
  if (text(lease.runId ?? lease.leaseId) === '') return { ok: false, code: 'lease-id-required' }
  if (owner !== contract.owner) return { ok: false, code: 'lease-owner-mismatch' }
  if (Number(lease.contractRevision ?? lease.revision ?? contract.contractRevision) !== contract.contractRevision) {
    return { ok: false, code: 'lease-revision-mismatch' }
  }
  const leaseScope = lease.writeScopes ?? lease.scope
  if (Array.isArray(leaseScope) && digest(unique(leaseScope.map(normalizeScope))) !== scopeHash(contract.writeScopes)) {
    return { ok: false, code: 'lease-scope-mismatch' }
  }
  if (lease.worktreeId !== undefined && text(lease.worktreeId) !== contract.worktreeId) {
    return { ok: false, code: 'lease-worktree-mismatch' }
  }
  return {
    ok: true,
    code: 'bound',
    binding: {
      runId: text(lease.runId ?? lease.leaseId),
      taskId: taskIdentity(contract),
      owner: contract.owner,
      contractRevision: contract.contractRevision,
      contractDigest: contractDigest(contract),
      scopeHash: scopeHash(contract.writeScopes),
      worktreeId: contract.worktreeId,
      pendingReviewSha: text(lease.pendingReviewSha ?? lease.pending_review_sha) || null,
      boundAt: Number(options.now ?? lease.boundAt ?? lease.acquiredAt ?? 0),
    },
  }
}

/**
 * Validate a lease binding against the current contract and lease state.
 * @param {object} input Task contract.
 * @param {object} binding Lease binding.
 * @param {object} [context] Current lease and clock.
 * @returns {{ok: boolean, code: string}}
 */
export function validateLeaseBinding(input, binding, context = {}) {
  const contract = normalizeTaskContract(input)
  const lease = context.lease ?? contract.lease
  if (binding === null || typeof binding !== 'object') return { ok: false, code: 'lease-binding-required' }
  if (lease !== null && typeof lease === 'object' && lower(lease.status ?? 'active') !== 'active') {
    return { ok: false, code: 'lease-not-active' }
  }
  if (lease !== null && typeof lease === 'object' && Number(lease.expiresAt ?? Infinity) <= Number(context.now ?? Date.now())) {
    return { ok: false, code: 'lease-expired' }
  }
  if (text(binding.taskId) !== taskIdentity(contract)) return { ok: false, code: 'lease-task-mismatch' }
  if (text(binding.owner) !== contract.owner) return { ok: false, code: 'lease-owner-mismatch' }
  if (Number(binding.contractRevision) !== contract.contractRevision) {
    return { ok: false, code: 'lease-revision-mismatch' }
  }
  if (text(binding.contractDigest) !== contractDigest(contract)) {
    return { ok: false, code: 'lease-contract-mismatch' }
  }
  if (text(binding.scopeHash) !== scopeHash(contract.writeScopes)) {
    return { ok: false, code: 'lease-scope-mismatch' }
  }
  if (text(binding.worktreeId) !== contract.worktreeId) {
    return { ok: false, code: 'lease-worktree-mismatch' }
  }
  if (lease !== null && typeof lease === 'object'
    && text(lease.runId ?? lease.leaseId) !== text(binding.runId)) {
    return { ok: false, code: 'lease-run-mismatch' }
  }
  return { ok: true, code: 'bound' }
}

/** Aliases kept stable for control-plane callers. */
export const bindLeaseToContract = createLeaseBinding
export const leaseBindingVerdict = validateLeaseBinding
export const bindLease = createLeaseBinding

function patchRequiresLeaseConfirmation(current, next) {
  return [...EXECUTION_KEYS].some((key) => stableJson(current[key]) !== stableJson(next[key]))
}

/**
 * Revise a contract with a CAS revision check and active-lease protection.
 * @param {object} input Current task contract.
 * @param {object} patch Replacement fields.
 * @param {object} [options] Actor, expected revision and lease confirmation.
 * @returns {{ok: boolean, code: string, contract?: object, previousRevision?: number, requiresLeaseReconfirmation?: boolean}}
 */
export function reviseTaskContract(input, patch, options = {}) {
  const current = normalizeTaskContract(input)
  const expected = options.expectedRevision ?? options.expectedContractRevision
  if (expected !== undefined && Number(expected) !== current.contractRevision) {
    return { ok: false, code: 'contract-revision-conflict' }
  }
  if (options.actor !== undefined && current.owner !== null
    && text(options.actor) !== current.owner
    && options.canCoordinate !== true) {
    return { ok: false, code: 'revision-actor-not-owner' }
  }
  const next = normalizeTaskContract({ ...current, ...(patch ?? {}) })
  next.contractRevision = current.contractRevision + 1
  const lease = activeLeaseFor(current, options)
  const requiresLeaseReconfirmation = lease !== null && patchRequiresLeaseConfirmation(current, next)
  if (requiresLeaseReconfirmation) {
    const confirmation = options.leaseConfirmation
    const confirmed = confirmation !== null && typeof confirmation === 'object'
      && text(confirmation.runId) === text(lease.runId ?? lease.leaseId)
      && Number(confirmation.contractRevision) === current.contractRevision
      && text(confirmation.owner ?? confirmation.member) === current.owner
    if (!confirmed) return { ok: false, code: 'lease-confirmation-required' }
    const rebound = createLeaseBinding(next, { ...lease, contractRevision: next.contractRevision }, options)
    if (!rebound.ok) return { ok: false, code: rebound.code }
    next.lease = { ...lease, contractRevision: next.contractRevision, binding: rebound.binding }
  } else if (lease !== null) {
    const rebound = createLeaseBinding(next, { ...lease, contractRevision: next.contractRevision }, options)
    if (!rebound.ok) return { ok: false, code: rebound.code }
    next.lease = { ...lease, contractRevision: next.contractRevision, binding: rebound.binding }
  }
  return {
    ok: true,
    code: 'revised',
    contract: next,
    previousRevision: current.contractRevision,
    requiresLeaseReconfirmation,
  }
}

/** Alias for callers using the shorter name. */
export const reviseContract = reviseTaskContract
export const findScopeConflicts = detectScopeConflicts

/**
 * Apply a lifecycle transition after its gate checks.
 * @param {object} input Current contract.
 * @param {string} to Next lifecycle state.
 * @param {object} [context] Ready gate and lease context.
 * @returns {{ok: boolean, code: string, contract: object, gate?: object}}
 */
export function transitionTaskLifecycle(input, to, context = {}) {
  const current = normalizeTaskContract(input)
  const nextState = normalizeLifecycle(to)
  if (!canTransitionLifecycle(current.lifecycle, nextState)) {
    return { ok: false, code: 'invalid-lifecycle-transition', contract: current }
  }
  if (context.expectedRevision !== undefined
    && Number(context.expectedRevision) !== current.contractRevision) {
    return { ok: false, code: 'contract-revision-conflict', contract: current }
  }
  let gate
  if (nextState === 'ready') {
    gate = evaluateReadyGate(current, context)
    if (!gate.ok) return { ok: false, code: 'ready-gate-failed', gate, contract: current }
  }
  if (nextState === 'running') {
    const lease = context.lease ?? current.lease
    if (lease === null || lease === undefined) {
      return { ok: false, code: 'lease-required', contract: current }
    }
    const binding = context.binding ?? lease.binding
    const verdict = validateLeaseBinding(current, binding, { ...context, lease })
    if (!verdict.ok) return { ok: false, code: verdict.code, contract: current }
  }
  const next = normalizeTaskContract(current)
  next.lifecycle = nextState
  next.contractRevision = context.incrementRevision === false
    ? current.contractRevision
    : current.contractRevision + 1
  next.updatedAt = context.now ?? next.updatedAt
  return { ok: true, code: 'transitioned', contract: next, gate }
}

/** Return a deterministic, non-mutating migration summary. */
export function contractMigrationPlan(input, targetVersion = TASK_CONTRACT_SCHEMA_VERSION) {
  const migrated = migrateTaskContract(input, targetVersion)
  if (!migrated.ok) return migrated
  return {
    ok: true,
    dryRun: true,
    changed: migrated.changed,
    fromVersion: migrated.fromVersion,
    toVersion: migrated.toVersion,
    warnings: migrated.warnings,
    contract: migrated.contract,
  }
}
