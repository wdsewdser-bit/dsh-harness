/**
 * Agent Team v12 persistence decisions.
 *
 * The module contains no filesystem I/O. It classifies read outcomes, validates
 * state, performs revision/CAS checks, plans recovery and migration, and checks
 * snapshot/audit consistency.
 */
import { createHash } from 'node:crypto'
import { normalizeTaskContract } from './team-v12-contract.mjs'

export const STATE_SCHEMA_VERSION = 2
export const READ_RESULT_KINDS = Object.freeze([
  'ok',
  'empty',
  'transient',
  'corrupt',
])

const TRANSIENT_CODES = new Set([
  'EACCES',
  'EAGAIN',
  'EBUSY',
  'EINTR',
  'EMFILE',
  'ENFILE',
  'ENOTFOUND',
  'EPERM',
  'ETIMEDOUT',
])
const CORE_FIELDS = new Set([
  'version',
  'schemaVersion',
  'rootId',
  'revision',
  'updatedAt',
  'rooms',
  'rounds',
  'plans',
  'dispatches',
  'leases',
  'wakeEpisodes',
  'escalations',
  'privilegeRequests',
  'evidence',
  'packets',
  'boards',
  'provider',
  'providerFailures',
  'frozenMembers',
  'counters',
  'health',
])
const COLLECTION_FIELDS = [
  'rooms',
  'rounds',
  'plans',
  'dispatches',
  'leases',
  'wakeEpisodes',
  'escalations',
  'privilegeRequests',
  'evidence',
  'packets',
  'boards',
  'providerFailures',
  'frozenMembers',
]

const asArray = (value) => Array.isArray(value) ? value : []
const text = (value) => String(value ?? '').trim()

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
  return '{' + Object.keys(value).sort()
    .map((key) => JSON.stringify(key) + ':' + stableJson(value[key]))
    .join(',') + '}'
}

function sha256(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function unwrapState(value) {
  if (value !== null && typeof value === 'object'
    && value.state !== undefined
    && (value.kind !== undefined || value.ok !== undefined)) return value.state
  return value
}

/** Stable state digest. */
export function stateDigest(state) {
  return sha256(state)
}

/**
 * Validate the durable control-plane state shape without changing it.
 * @param {unknown} state Parsed state document.
 * @param {object} [options] Validation options.
 * @returns {{ok: boolean, code: string, errors: object[], warnings: object[], unknownFields: string[], state: unknown}}
 */
export function validateStateSchema(state, options = {}) {
  const errors = []
  const warnings = []
  const add = (code, path, message) => errors.push({ code, path, message })
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    add('state-object-required', '$', 'state must be an object')
    return { ok: false, code: 'invalid-state', errors, warnings, unknownFields: [], state }
  }
  const version = Number(state.version ?? state.schemaVersion)
  if (!Number.isInteger(version) || version < 1) {
    add('schema-version-invalid', 'version', 'schema version must be a positive integer')
  } else if (version > STATE_SCHEMA_VERSION) {
    add('schema-version-newer', 'version', 'state schema is newer than this runtime')
  }
  if (!Number.isInteger(Number(state.revision)) || Number(state.revision) < 0) {
    add('revision-invalid', 'revision', 'revision must be a non-negative integer')
  }
  if (options.requireRootId === true && text(state.rootId) === '') {
    add('root-id-required', 'rootId', 'rootId is required')
  }
  for (const field of COLLECTION_FIELDS) {
    if (state[field] !== undefined
      && (state[field] === null || typeof state[field] !== 'object' || Array.isArray(state[field]))) {
      add('collection-invalid', field, field + ' must be an object')
    }
  }
  const unknownFields = Object.keys(state).filter((key) => !CORE_FIELDS.has(key))
  if (unknownFields.length > 0 && options.rejectUnknownFields === true) {
    for (const field of unknownFields) add('unknown-field', field, 'unknown state field is not allowed')
  } else if (unknownFields.length > 0) {
    warnings.push({
      code: 'unknown-fields-preserved',
      path: '$',
      message: 'unknown fields are preserved: ' + unknownFields.join(', '),
    })
  }
  return {
    ok: errors.length === 0,
    code: errors.length === 0 ? 'valid' : 'invalid-state',
    errors,
    warnings,
    unknownFields,
    state,
  }
}

/**
 * Classify a read error as empty, transient, or corrupt.
 * @param {unknown} error Error or error-like object.
 * @returns {{kind: string, ok: boolean, retryable: boolean, code: string, message: string}}
 */
export function classifyStateReadFailure(error) {
  const code = text(error?.code)
  const message = text(error?.message ?? error)
  if (code === 'ENOENT') {
    return { kind: 'empty', ok: true, retryable: false, code: 'missing', message: message || 'state file does not exist' }
  }
  if (error instanceof SyntaxError || error?.name === 'SyntaxError' || code === 'ERR_JSON_PARSE') {
    return { kind: 'corrupt', ok: false, retryable: false, code: 'invalid-json', message: message || 'state JSON is invalid' }
  }
  if (TRANSIENT_CODES.has(code)) {
    return { kind: 'transient', ok: false, retryable: true, code: code || 'read-failed', message: message || 'state read failed' }
  }
  return {
    kind: 'corrupt',
    ok: false,
    retryable: false,
    code: code || 'read-failed',
    message: message || 'state cannot be trusted',
  }
}

/**
 * Parse and validate one state read without filesystem access.
 * @param {unknown} input JSON text, parsed state, or {text|state|error}.
 * @param {object} [options] Parsing options.
 * @returns {{ok: boolean, kind: string, code: string, state?: object, error?: object, validation?: object}}
 */
export function readStateSnapshot(input, options = {}) {
  if (input === undefined || input === null) {
    if (options.allowMissing === true) {
      return { ok: true, kind: 'empty', code: 'missing' }
    }
    return { ok: false, kind: 'corrupt', code: 'missing-not-explicit' }
  }
  if (input !== null && typeof input === 'object' && input.error !== undefined) {
    const failure = classifyStateReadFailure(input.error)
    if (failure.kind === 'empty' && options.allowMissing === true) {
      return { ok: true, kind: 'empty', code: failure.code }
    }
    return { ok: false, ...failure }
  }
  let state = input
  if (typeof input === 'string') {
    if (input.trim().length === 0) {
      return { ok: false, kind: 'corrupt', code: 'empty-document', error: { message: 'empty JSON document' } }
    }
    try {
      state = JSON.parse(input)
    } catch (error) {
      const failure = classifyStateReadFailure(error)
      return { ok: false, ...failure }
    }
  } else if (input !== null && typeof input === 'object' && input.state !== undefined) {
    state = input.state
  }
  const validation = validateStateSchema(state, options)
  if (!validation.ok) {
    return {
      ok: false,
      kind: 'corrupt',
      code: validation.code,
      error: { message: validation.errors.map((row) => row.message).join('; ') },
      validation,
    }
  }
  return { ok: true, kind: 'ok', code: 'valid', state, validation }
}

/** Alias used by recovery code that calls the read classifier a verdict. */
export const classifyStateRead = classifyStateReadFailure
export const validateState = validateStateSchema

function flattenDiff(left, right, path, output) {
  if (Object.is(left, right)) return
  const leftObject = left !== null && typeof left === 'object'
  const rightObject = right !== null && typeof right === 'object'
  if (!leftObject || !rightObject || Array.isArray(left) !== Array.isArray(right)) {
    output.push({ path, kind: left === undefined ? 'added' : right === undefined ? 'removed' : 'changed', current: left, snapshot: right })
    return
  }
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    const child = path === '$' ? '$.' + key : path + '.' + key
    flattenDiff(left[key], right[key], child, output)
  }
}

/**
 * Compare the current state and a recovery snapshot.
 * @param {unknown} current Current state or read result.
 * @param {unknown} snapshot Snapshot state or read result.
 * @param {object} [options] Diff options.
 * @returns {{ok: boolean, equal: boolean, currentRevision: number, snapshotRevision: number, differences: object[], truncated: boolean, recoverable: boolean}}
 */
export function compareStateSnapshots(current, snapshot, options = {}) {
  const currentState = unwrapState(current)
  const snapshotState = unwrapState(snapshot)
  const currentValidation = validateStateSchema(currentState)
  const snapshotValidation = validateStateSchema(snapshotState)
  if (!currentValidation.ok || !snapshotValidation.ok) {
    return {
      ok: false,
      equal: false,
      currentRevision: Number(currentState?.revision ?? -1),
      snapshotRevision: Number(snapshotState?.revision ?? -1),
      differences: [],
      truncated: false,
      recoverable: false,
    }
  }
  const all = []
  flattenDiff(currentState, snapshotState, '$', all)
  const limit = Number.isInteger(options.limit) && options.limit >= 0 ? options.limit : all.length
  const differences = all.slice(0, limit)
  return {
    ok: true,
    equal: all.length === 0,
    currentRevision: Number(currentState.revision),
    snapshotRevision: Number(snapshotState.revision),
    differences,
    truncated: differences.length < all.length,
    recoverable: Number(snapshotState.revision) <= Number(currentState.revision),
  }
}

/** Alias used by diagnostic views. */
export const diffStateSnapshots = compareStateSnapshots
export const compareSnapshots = compareStateSnapshots

/**
 * Build an explicit recovery plan. It never applies the plan.
 * @param {object} input Current and snapshot read results.
 * @param {object} [options] Explicit recovery confirmation.
 * @returns {{ok: boolean, action: string, mutationAllowed: boolean, requiresRoot: boolean, requiresConfirmation: boolean, backupRequired: boolean, auditRequired: boolean, reasons: string[], diff?: object}}
 */
export function planStateRecovery(input = {}, options = {}) {
  const current = input.current ?? input.currentResult ?? input
  const snapshot = input.snapshot ?? input.snapshotResult
  const currentRead = readStateSnapshot(current, { allowMissing: true })
  const snapshotRead = snapshot === undefined ? null : readStateSnapshot(snapshot)
  const base = {
    mutationAllowed: false,
    requiresRoot: true,
    requiresConfirmation: true,
    backupRequired: true,
    auditRequired: true,
    reasons: [],
  }
  if (currentRead.kind === 'transient') {
    return {
      ...base,
      ok: false,
      action: 'retry-read',
      reasons: ['current state is temporarily unreadable', 'state mutations must remain disabled'],
    }
  }
  if (currentRead.kind === 'corrupt') {
    if (snapshotRead?.ok === true) {
      return {
        ...base,
        ok: true,
        action: 'restore-snapshot',
        mutationAllowed: options.confirm === true,
        requiresConfirmation: options.confirm !== true,
        reasons: ['current state is corrupt', 'last valid snapshot is available', 'recovery must be explicit'],
        diff: {
          currentRevision: null,
          snapshotRevision: Number(snapshotRead.state.revision),
        },
      }
    }
    return {
      ...base,
      ok: false,
      action: 'manual-review',
      reasons: ['current state is corrupt', 'no valid recovery snapshot is available'],
    }
  }
  if (currentRead.kind === 'empty') {
    return {
      ...base,
      ok: options.initializeEmpty === true,
      action: options.initializeEmpty === true ? 'initialize-empty' : 'manual-review',
      mutationAllowed: options.initializeEmpty === true && options.confirm === true,
      requiresConfirmation: options.confirm !== true,
      reasons: ['missing state is not treated as an implicit empty state'],
    }
  }
  if (snapshotRead?.ok !== true) {
    return {
      ...base,
      ok: true,
      action: 'keep-current',
      mutationAllowed: true,
      requiresConfirmation: false,
      backupRequired: false,
      reasons: ['current state is valid', 'no valid snapshot requires recovery'],
    }
  }
  const diff = compareStateSnapshots(currentRead.state, snapshotRead.state)
  const requested = options.targetRevision ?? input.targetRevision
  const wantsSnapshot = requested !== undefined && Number(requested) === diff.snapshotRevision
  if (wantsSnapshot && options.confirm === true) {
    return {
      ...base,
      ok: true,
      action: 'restore-snapshot',
      mutationAllowed: true,
      requiresConfirmation: false,
      reasons: ['root explicitly selected the snapshot revision'],
      diff,
    }
  }
  return {
    ...base,
    ok: true,
    action: 'keep-current',
    mutationAllowed: true,
    requiresConfirmation: false,
    backupRequired: false,
    reasons: ['current state is valid', 'automatic rollback is disabled'],
    diff,
  }
}

/**
 * Compare-and-set a state document by revision.
 * @param {object} current Current state.
 * @param {object} next Proposed state.
 * @param {number} expectedRevision Revision read by the writer.
 * @returns {{ok: boolean, code: string, state?: object, previousRevision?: number, revision?: number}}
 */
export function commitStateCas(current, next, expectedRevision) {
  const validation = validateStateSchema(current)
  if (!validation.ok) return { ok: false, code: 'current-state-invalid' }
  if (!Number.isInteger(expectedRevision)) return { ok: false, code: 'expected-revision-invalid' }
  if (Number(current.revision) !== expectedRevision) {
    return {
      ok: false,
      code: 'revision-conflict',
      previousRevision: Number(current.revision),
      revision: Number(current.revision),
    }
  }
  const state = structuredClone(next)
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    return { ok: false, code: 'next-state-invalid' }
  }
  const proposedRevision = Number(state.revision ?? expectedRevision + 1)
  if (proposedRevision !== expectedRevision + 1) return { ok: false, code: 'next-revision-invalid' }
  state.revision = proposedRevision
  state.version = Number(state.version ?? current.version)
  const nextValidation = validateStateSchema(state)
  if (!nextValidation.ok) return { ok: false, code: 'next-state-invalid' }
  return {
    ok: true,
    code: 'committed',
    state,
    previousRevision: expectedRevision,
    revision: proposedRevision,
  }
}

/** Alias matching the persistence plan wording. */
export const compareAndSwapState = commitStateCas
export const stateCas = commitStateCas

/**
 * Apply a synchronous mutation through CAS.
 * @param {object} current Current state.
 * @param {(draft: object) => unknown} mutation Mutation function.
 * @param {number} expectedRevision CAS precondition.
 * @param {object} [options] Reserved options.
 * @returns {{ok: boolean, code: string, state?: object, result?: unknown}}
 */
export function applyStateMutation(current, mutation, expectedRevision, options = {}) {
  if (typeof mutation !== 'function') return { ok: false, code: 'mutation-required' }
  const draft = structuredClone(current)
  const result = mutation(draft)
  const committed = commitStateCas(current, draft, expectedRevision)
  if (!committed.ok) return committed
  return { ...committed, result, options }
}

/**
 * Check whether the snapshot revision and audit trail agree.
 * @param {object} state Durable state.
 * @param {object[]} auditEvents Audit rows.
 * @param {object} [options] Audit options.
 * @returns {{ok: boolean, consistent: boolean, code: string, stateRevision: number, lastAuditRevision: number, missingRevisions: number[], duplicateRevisions: number[]}}
 */
export function auditConsistencyResult(state, auditEvents = [], options = {}) {
  if (options.auditError !== undefined) {
    return {
      ok: false,
      consistent: false,
      code: 'audit-write-failed',
      stateRevision: Number(state?.revision ?? -1),
      lastAuditRevision: -1,
      missingRevisions: [],
      duplicateRevisions: [],
      error: text(options.auditError?.message ?? options.auditError),
    }
  }
  const validation = validateStateSchema(state)
  if (!validation.ok) {
    return {
      ok: false,
      consistent: false,
      code: 'state-invalid',
      stateRevision: Number(state?.revision ?? -1),
      lastAuditRevision: -1,
      missingRevisions: [],
      duplicateRevisions: [],
    }
  }
  const revisions = asArray(auditEvents)
    .map((event) => Number(event?.revision ?? event?.toRevision ?? event?.stateRevision))
    .filter(Number.isInteger)
  const uniqueRevisions = [...new Set(revisions)].sort((a, b) => a - b)
  const duplicates = revisions.filter((revision, index) => revisions.indexOf(revision) !== index)
  const duplicateRevisions = [...new Set(duplicates)]
  const stateRevision = Number(state.revision)
  const lastAuditRevision = uniqueRevisions.length === 0 ? 0 : uniqueRevisions[uniqueRevisions.length - 1]
  const trackedFromRevision = Number.isInteger(options.trackedFromRevision)
    ? Math.max(1, Number(options.trackedFromRevision))
    : 1
  const missingRevisions = []
  for (let revision = trackedFromRevision; revision <= stateRevision; revision += 1) {
    if (!uniqueRevisions.includes(revision)) missingRevisions.push(revision)
  }
  const consistent = missingRevisions.length === 0
    && duplicateRevisions.length === 0
    && lastAuditRevision === stateRevision
  return {
    ok: consistent,
    consistent,
    code: consistent ? 'consistent' : missingRevisions.length > 0 ? 'audit-gap' : 'audit-inconsistent',
    stateRevision,
    lastAuditRevision,
    trackedFromRevision,
    missingRevisions,
    duplicateRevisions,
  }
}

/**
 * Build a non-mutating migration plan for an old state document.
 * @param {object} state Current state.
 * @param {object} [options] Target schema.
 * @returns {{ok: boolean, dryRun: boolean, changed: boolean, fromVersion: number, toVersion: number, writes: number, backupRequired: boolean, changes: object[], planDigest: string, state: object, code?: string}}
 */
export function planStateMigration(state, options = {}) {
  const source = unwrapState(state)
  const validation = validateStateSchema(source)
  if (!validation.ok) {
    return {
      ok: false,
      dryRun: true,
      changed: false,
      fromVersion: Number(source?.version ?? 0),
      toVersion: Number(options.targetVersion ?? STATE_SCHEMA_VERSION),
      writes: 0,
      backupRequired: true,
      changes: [],
      planDigest: sha256({ invalid: true }),
      state: source,
      code: 'state-invalid',
    }
  }
  const fromVersion = Number(source.version ?? 1)
  const toVersion = Number(options.targetVersion ?? STATE_SCHEMA_VERSION)
  if (toVersion < fromVersion) {
    return {
      ok: false,
      dryRun: true,
      changed: false,
      fromVersion,
      toVersion,
      writes: 0,
      backupRequired: true,
      changes: [],
      planDigest: sha256({ downgrade: true, fromVersion, toVersion }),
      state: source,
      code: 'schema-downgrade-unsupported',
    }
  }
  const next = structuredClone(source)
  const changes = []
  if (fromVersion < toVersion) {
    next.version = toVersion
    next.schemaVersion = toVersion
    changes.push({ code: 'set-schema-version', from: fromVersion, to: toVersion })
  }
  for (const board of Object.values(next.boards ?? {})) {
    for (const task of Object.values(board?.tasks ?? {})) {
      if (task?.contract !== undefined) continue
      task.contract = normalizeTaskContract(task)
      changes.push({ code: 'add-task-contract', taskId: text(task.id ?? task.taskId) || null })
    }
  }
  return {
    ok: true,
    dryRun: true,
    changed: changes.length > 0,
    fromVersion,
    toVersion,
    writes: 0,
    backupRequired: true,
    changes,
    planDigest: sha256(changes),
    state: next,
  }
}

/** Alias for the explicit dry-run API. */
export const migrationDryRun = planStateMigration
export const migrateStateDryRun = planStateMigration

/**
 * Apply a migration in memory. The caller remains responsible for backup and
 * atomic persistence.
 * @param {object} state Current state.
 * @param {object} [options] Target schema.
 * @returns {{ok: boolean, changed: boolean, fromVersion: number, toVersion: number, state: object, code?: string}}
 */
export function applyStateMigration(state, options = {}) {
  const plan = planStateMigration(state, options)
  if (!plan.ok) return plan
  return {
    ok: true,
    changed: plan.changed,
    fromVersion: plan.fromVersion,
    toVersion: plan.toVersion,
    state: plan.state,
  }
}

/** Return the missing revision range between a snapshot and current state. */
export function recoveryRevisionRange(current, snapshot) {
  const currentRevision = Number(unwrapState(current)?.revision)
  const snapshotRevision = Number(unwrapState(snapshot)?.revision)
  if (!Number.isInteger(currentRevision) || !Number.isInteger(snapshotRevision)) {
    return { ok: false, code: 'revision-invalid' }
  }
  return {
    ok: true,
    fromRevision: Math.min(currentRevision, snapshotRevision),
    toRevision: Math.max(currentRevision, snapshotRevision),
    direction: snapshotRevision < currentRevision ? 'rollback' : snapshotRevision > currentRevision ? 'forward' : 'same',
  }
}

/** Stable aliases for control-plane integration. */
export const readStateEnvelope = readStateSnapshot
export const planRecovery = planStateRecovery
export const auditConsistency = auditConsistencyResult
