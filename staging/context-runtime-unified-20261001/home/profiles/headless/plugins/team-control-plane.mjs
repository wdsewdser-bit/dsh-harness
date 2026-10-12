/**
 * HMR activation marker: 2026-09-24T19:50+08:00.
 *
 * Durable Agent Team control plane.
 *
 * The Agent Team domain owns the roster and its native task board. This module
 * owns the coordination facts that the domain does not model: rooms, turns,
 * plans, dispatch/run leases, escalations, evidence, counters and health.
 *
 * State is written as an atomic JSON snapshot and every mutation is also
 * appended to a sidecar audit log. The snapshot is the recovery path for
 * operator/UI reads; the audit log is the append-only trail for replay and
 * diagnostics. It intentionally does not inject a custom event type into a
 * DSH Session because SessionEventMap is closed and unknown events can
 * invalidate a real history during reload.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { rename as renameAsync, unlink as unlinkAsync, writeFile as writeFileAsync } from 'node:fs/promises'

function syncFileData(file) {
  const fd = openSync(file, 'r+')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function writeSyncedFile(file, body) {
  const fd = openSync(file, 'w')
  try { writeFileSync(fd, body, 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
}

function syncPublishedDirectory(file) {
  // Windows does not expose a portable directory fsync through Node. Data
  // fsync plus exact readback is a process-crash barrier, not a power-loss claim.
  if (process.platform === 'win32') return
  const fd = openSync(dirname(file), 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

export const CONTROL_DURABILITY_SCOPE = Object.freeze({
  fileData: 'fsync-before-publication',
  directoryMetadata: process.platform === 'win32' ? 'unsupported-platform' : 'fsync-after-publication',
  crashModel: process.platform === 'win32' ? 'process-crash-not-power-loss' : 'file-and-directory-fsync',
})
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { readDurableJson } from './team-v14-durable-store.mjs'
import { acquireWindowFileProtection, windowFileProtectionFacts } from './team-v15-window-file-protection.mjs'
import { contractDigest } from './team-v12-contract.mjs'
import { auditConsistencyResult } from './team-v12-persistence.mjs'

console.warn('[team-control-plane] HMR atomic-wake-claim+perf44-prune-fastpath+perf45-reconcile-fastpath+perf56-bounded-inbox-view+perf58-cold-evidence-compaction+perf60-global-completion-reconcile+member-route-persistence+bind-fix+plan-scope-lock loaded 2026-09-27')

const VERSION = 2
const STORE_NAME = 'team-control-plane'
const HISTORY_SUFFIX = '.history.json'
const PANEL_CACHE_SUFFIX = '.panel-cache.json'
const ROOM_TAIL_LIMIT = 50
const EVENT_TAIL_LIMIT = 256
const INBOX_CACHE_LIMIT = 100
const WAKE_ACTIVE_LIMIT = 4096
const WAKE_TERMINAL_LIMIT = 16
const COLD_INBOX_LIMIT = 256
const COLD_INBOX_HYDRATE_LIMIT = 32
const COLD_INBOX_REF_LIMIT = 512
const MAX_PARSED_CACHE_ENTRIES = 4
const MAX_HISTORY_CACHE_ENTRIES = 1
const MAX_LAST_GOOD_ENTRIES = 4
const MAX_PANEL_CACHE_ENTRIES = 8
const PANEL_CACHE_ASYNC_THRESHOLD = 256 * 1024
const MAX_SERVICE_ENTRIES = 16
const MAX_MEMORY_HOT_STATES = 4
const MAX_VERIFIED_COLD_ENTRIES = 4096
const MAX_COLD_RAW_CACHE_BYTES = 64 * 1024 * 1024
const MAX_COLD_RAW_CACHE_ENTRIES = 512
const HOT_TERMINAL_DISPATCH_LIMIT = 200
const HOT_TERMINAL_LEASE_LIMIT = 128
const HOT_TERMINAL_WAKE_LIMIT = 128
const HOT_RECEIPT_LIMIT = 200
const HOT_ARCHIVE_CHUNK_SIZE = 64
const DEFAULT_MUTATION_DEFER_MS = 1000
const DEFAULT_COLD_GC_GRACE_MS = 5 * 60 * 1000
// Cold history is append-only and orphan files are normally a few KB. The old
// five-minute mark-and-sweep walked tens of thousands of files while holding
// the control-plane write lock, causing periodic multi-second stalls. Keep the
// same safety margin but run the expensive sweep much less often.
const DEFAULT_COLD_GC_INTERVAL_MS = 30 * 60 * 1000
const DEFAULT_TEMP_STALE_MS = 24 * 60 * 60 * 1000
const DEFAULT_AUDIT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_AUDIT_MAX_FILES = 4
const DEFAULT_AUDIT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const STORAGE_CACHE_REFRESH_MS = 500
const COLD_DIGEST_RE = /^[a-f0-9]{64}$/
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80]
const NO_CHANGE = Symbol('control-plane-no-change')
const stores = new Map()

/** Merge evidence pointers without allowing a completion to erase prior proof. */
export function mergeEvidenceIds(existing, incoming) {
  return [...new Set([
    ...(Array.isArray(existing) ? existing : []).map(String),
    ...(Array.isArray(incoming) ? incoming : []).map(String),
  ])]
}
const tails = new Map()
/** Last successfully parsed state per control file, used when a read fails. */
const lastGood = new Map()
/** Content-addressed cold files are immutable; verify each digest once per process. */
const verifiedCold = new Set()
/** A bounded hot projection used by panels and pre-step context assembly. */
const panelCache = new Map()
/**
 * Parsed control-plane state is expensive to rebuild because the snapshot can
 * be tens of megabytes and history hydration reads several sidecar files.
 * Cache the normalized state per file and history mode, then invalidate by the
 * file identity/timestamps whenever the atomic writer replaces the snapshot.
 */
const parsedCache = new Map()
/** Full hydrated history is expensive; keep only the most recently used Team. */
const historyCache = new Map()
const requirementsDigestCache = new WeakMap()
const COLD_REF_FIELDS = new Set(['v12Evidence', 'v12Compaction'])
let coldRefDigestCache = new WeakMap()
/** Hot state accepted in memory before its deferred snapshot reaches disk. */
const memoryHotStates = new Map()
/** Compact root-selection index; avoids parsing the full hot snapshot per call. */
const rootIndex = new Map()
/** Raw bytes of immutable cold files. Parsing is cheap compared with rereading
 * and rehashing multi-megabyte histories on every explicit snapshot. */
const coldRawCache = new Map()
let coldRawCacheBytes = 0
/** Reused append handles keep the high-volume audit trail off the open/close path. */
const auditHandles = new Map()
/** Per-file GC timers prevent repeated directory scans during write bursts. */
const storageGcTimers = new Map()
/** Last write timing sample per control-plane file. */
const writeMetrics = new Map()
/** Cold/temp/audit metadata is reused until the containing directory changes. */
const storageInventoryCache = new Map()
/** Full file paths are reused for all control-plane scans until the directory changes. */
const storagePathCache = new Map()
let storagePathGeneration = 0
/** Reachable cold digests are reused until a live snapshot file changes. */
const reachableColdCache = new Map()

function remember(map, key, value, limit) {
  map.delete(key)
  map.set(key, value)
  while (map.size > limit) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
  return value
}

function rememberRootIndex(file, signature, state) {
  if (signature === null || state === null || typeof state !== 'object' || Array.isArray(state)) return
  const activeMembers = new Set()
  for (const request of Object.values(state.privilegeRequests ?? {})) {
    if (request?.status === 'active' && request.member !== undefined) activeMembers.add(String(request.member))
  }
  for (const lease of Object.values(state.leases ?? {})) {
    if (lease?.status === 'active' && lease.member !== undefined) activeMembers.add(String(lease.member))
  }
  remember(rootIndex, file, { signature, activeMembers }, MAX_SERVICE_ENTRIES)
}

async function renameWithRetry(source, target) {
  let lastError
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await renameAsync(source, target)
      return
    } catch (error) {
      lastError = error
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt === RENAME_RETRY_DELAYS_MS.length) break
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]))
    }
  }
  throw lastError
}

function rememberCold(path) {
  verifiedCold.delete(path)
  verifiedCold.add(path)
  while (verifiedCold.size > MAX_VERIFIED_COLD_ENTRIES) {
    const oldest = verifiedCold.values().next().value
    if (oldest === undefined) break
    verifiedCold.delete(oldest)
  }
}

function rememberColdRaw(path, raw, signature) {
  const previous = coldRawCache.get(path)
  if (previous !== undefined) coldRawCacheBytes -= previous.raw.length
  coldRawCache.delete(path)
  coldRawCache.set(path, { raw, signature })
  coldRawCacheBytes += raw.length
  while (coldRawCache.size > MAX_COLD_RAW_CACHE_ENTRIES || coldRawCacheBytes > MAX_COLD_RAW_CACHE_BYTES) {
    const oldest = coldRawCache.keys().next().value
    if (oldest === undefined) break
    const value = coldRawCache.get(oldest)
    coldRawCache.delete(oldest)
    if (value !== undefined) coldRawCacheBytes -= value.raw.length
  }
}

function cacheKeyFor(file, history) {
  return file + '\u0000' + (history ? 'history' : 'hot')
}

function fileSignature(file) {
  let stats
  try {
    stats = statSync(file, { bigint: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  return [
    String(stats.dev),
    String(stats.ino),
    String(stats.size),
    String(stats.mtimeNs),
    String(stats.ctimeNs),
  ].join(':')
}

function invalidateParsedCache(file, { keepHot = false } = {}) {
  parsedCache.delete(cacheKeyFor(file, true))
  if (!keepHot) parsedCache.delete(cacheKeyFor(file, false))
  historyCache.delete(file)
}

function discardUnpublishedMemory(file) {
  memoryHotStates.delete(file)
  invalidateParsedCache(file)
  lastGood.delete(cacheKeyFor(file, true))
  lastGood.delete(cacheKeyFor(file, false))
}

function cloneCachedState(entry) {
  return structuredClone(entry.state)
}

function cloneValue(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function cloneRows(rows) {
  return rows.map((row) => structuredClone(row))
}

/** Block the calling thread briefly; load() is synchronous by contract. */
function pauseSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* best effort */ }
}
const DEFAULT_DELIVERY_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_MAX_ROOM_ROUNDS = 3
const LEGACY_EMPTY_ROOM_GRACE_MS = 5 * 60 * 1000
const ACTIVE_DISPATCH_STATES = new Set([
  'dispatch-created',
  'queued',
  'delivered',
  'turn-started',
  'first-observation',
  'checkpointed',
  'response-recorded',
])
const TERMINAL_DISPATCH_STATES = new Set([
  'completed',
  'delivery-failed',
  'run-failed',
  'timed-out',
  'cancelled',
  'expired',
])
const TERMINAL_WAKE_STATES = new Set([
  'completed',
  'delivery-failed',
  'run-failed',
  'timed-out',
  'cancelled',
  'expired',
  'resolved',
])
export const TASK_PHASES = [
  'draft',
  'room-discussion',
  'plan-proposed',
  'plan-approved',
  'execution',
  'member-check',
  'group-check',
  'verifier-review',
  'integration-ready',
  'integrated',
  'accepted',
  'blocked',
  'rejected',
  'cancelled',
  'expired',
]
export const PLAN_REPLACEMENT_RECOVERY = 'Recovery path A (work can finish under the current scope): '
  + '(1) finish the task and record exact commit_sha plus evidence, '
  + '(2) call team_task_update(action:"complete") while this lease is active, '
  + '(3) release this lease as completed, '
  + '(4) call team_plan_propose with replace_approved:true and replace_reason, '
  + '(5) acquire the replacement lease before editing again. '
  + 'Recovery path B (scope must change while work is in flight): '
  + '(1) release or cancel the active lease, '
  + '(2) call team_plan_propose with replace_approved:true and replace_reason to replace the plan with the corrected scopes, '
  + '(3) acquire the replacement lease before editing again. '
  + 'Use status:"cancelled" only when the work is intentionally abandoned.'
const PHASE_TRANSITIONS = {
  draft: new Set(['room-discussion', 'blocked', 'rejected', 'cancelled', 'expired']),
  'room-discussion': new Set(['plan-proposed', 'blocked', 'rejected', 'cancelled', 'expired']),
  'plan-proposed': new Set(['plan-approved', 'blocked', 'rejected', 'cancelled', 'expired']),
  'plan-approved': new Set(['execution', 'blocked', 'rejected', 'cancelled', 'expired']),
  execution: new Set(['member-check', 'blocked', 'rejected', 'cancelled', 'expired']),
  'member-check': new Set(['group-check', 'execution', 'blocked', 'rejected', 'cancelled', 'expired']),
  'group-check': new Set(['verifier-review', 'execution', 'blocked', 'rejected', 'cancelled', 'expired']),
  'verifier-review': new Set(['integration-ready', 'execution', 'blocked', 'rejected', 'cancelled', 'expired']),
  'integration-ready': new Set(['integrated', 'execution', 'blocked', 'rejected', 'cancelled', 'expired']),
  integrated: new Set(['accepted', 'execution', 'blocked', 'rejected', 'cancelled', 'expired']),
  accepted: new Set(),
  blocked: new Set(['room-discussion', 'plan-proposed', 'execution', 'cancelled', 'expired']),
  rejected: new Set(['room-discussion', 'plan-proposed', 'execution', 'blocked', 'cancelled', 'expired']),
  cancelled: new Set(),
  expired: new Set(),
}
export function canAdvanceTaskPhase(from, to) {
  const current = TASK_PHASES.includes(from) ? from : 'draft'
  const next = String(to || '')
  return TASK_PHASES.includes(next) && (current === next || PHASE_TRANSITIONS[current]?.has(next) === true)
}

/** Expose the phase machine's outgoing edges instead of making callers infer them from refusals. */
export function allowedTaskPhaseTransitions(from) {
  const current = TASK_PHASES.includes(from) ? from : 'draft'
  return [...(PHASE_TRANSITIONS[current] ?? [])]
}

/** Recovery actions are separate from adjacent phase advances. */
export function taskPhaseRecoveryActions(from) {
  const current = TASK_PHASES.includes(from) ? from : 'draft'
  return ['blocked', 'rejected', 'cancelled', 'expired'].includes(current)
    ? ['reopen']
    : []
}

/**
 * Ordinary workflow calls may only move a task forward. Rollback transitions
 * remain available to explicit recovery paths, but must not happen as a side
 * effect of setup or lease acquisition.
 */
export function shouldMoveTaskPhase(from, to, options = {}) {
  const current = TASK_PHASES.includes(from) ? from : 'draft'
  const next = String(to || '')
  if (!TASK_PHASES.includes(next) || current === next) return false
  if (options.allowRollback !== true && TASK_PHASES.indexOf(next) < TASK_PHASES.indexOf(current)) return false
  return canAdvanceTaskPhase(current, next)
}

/**
 * A dependency defaults to release only after its delivery has reached final
 * acceptance. `status=completed` alone can be true while the commit is still
 * only on a member or group branch; releasing on that state lets a downstream
 * task consume an unintegrated generator. Callers may explicitly select
 * `requiredPhase="completed"` when the dependency is content-only and the
 * completed status is the intended release condition.
 */
export function dependencySatisfied(dependency, requiredPhase = 'accepted') {
  if (String(dependency?.status ?? '').toLowerCase() !== 'completed') return false
  const required = String(requiredPhase ?? 'accepted')
  if (required === 'completed') return true
  const requiredIndex = TASK_PHASES.indexOf(required)
  const actualIndex = TASK_PHASES.indexOf(String(dependency?.phase ?? ''))
  if (requiredIndex < 0 || actualIndex < 0) return false
  return actualIndex >= requiredIndex
}

/**
 * Parse a task dependency reference. Unqualified ids remain board-local; a
 * qualified reference uses the first colon as `<boardId>:<taskId>`.
 */
export function parseTaskDependencyReference(value, defaultBoardId = 'global') {
  const raw = String(value ?? '').trim()
  const fallbackBoard = String(defaultBoardId ?? 'global').trim() || 'global'
  if (raw.length === 0) return null
  const separator = raw.indexOf(':')
  if (separator > 0 && separator < raw.length - 1) {
    return {
      raw,
      boardId: raw.slice(0, separator),
      taskId: raw.slice(separator + 1),
      qualified: true,
    }
  }
  return { raw, boardId: fallbackBoard, taskId: raw, qualified: false }
}

/** Resolve a board-local or board-qualified dependency against a board snapshot. */
export function resolveTaskDependency(boards, ownerBoardId, reference) {
  const parsed = parseTaskDependencyReference(reference, ownerBoardId)
  if (parsed === null) return { raw: '', boardId: String(ownerBoardId ?? 'global'), taskId: '', qualified: false, task: undefined, found: false }
  const task = boards?.[parsed.boardId]?.tasks?.[parsed.taskId]
  return { ...parsed, task, found: task !== undefined }
}

/** Whether one dependency reference is satisfied, including cross-board refs. */
export function taskDependencySatisfied(boards, ownerBoardId, reference, requiredPhase = 'accepted') {
  const resolved = resolveTaskDependency(boards, ownerBoardId, reference)
  return resolved.found && dependencySatisfied(resolved.task, requiredPhase)
}

/** Whether every dependency reference is satisfied. */
export function taskDependenciesSatisfied(boards, ownerBoardId, references, requiredPhase = 'accepted') {
  const rows = Array.isArray(references) ? references : []
  return rows.every((reference) => taskDependencySatisfied(boards, ownerBoardId, reference, requiredPhase))
}

function dependencyGraphKey(boardId, taskId) {
  return String(boardId) + '\u0000' + String(taskId)
}

/**
 * Return a cycle path when a proposed dependency set would close a task graph.
 * The check is board-aware and uses the same reference syntax as readiness.
 */
export function dependencyCycle(boards, ownerBoardId, ownerTaskId, references) {
  const graph = new Map()
  for (const [boardId, board] of Object.entries(boards ?? {})) {
    for (const task of Object.values(board?.tasks ?? {})) {
      const taskId = String(task?.id ?? task?.taskId ?? '')
      if (taskId.length === 0) continue
      const rows = boardId === String(ownerBoardId) && taskId === String(ownerTaskId)
        ? references
        : task?.blockedBy
      const targets = (Array.isArray(rows) ? rows : [])
        .map((reference) => resolveTaskDependency(boards, boardId, reference))
        .filter((resolved) => resolved.found)
        .map((resolved) => dependencyGraphKey(resolved.boardId, resolved.taskId))
      graph.set(dependencyGraphKey(boardId, taskId), targets)
    }
  }
  const ownerKey = dependencyGraphKey(ownerBoardId, ownerTaskId)
  if (!graph.has(ownerKey)) graph.set(ownerKey, [])
  const visiting = new Set()
  const visited = new Set()
  const path = []
  const visit = (key) => {
    if (visiting.has(key)) return [...path.slice(path.indexOf(key)), key]
    if (visited.has(key)) return null
    visiting.add(key)
    path.push(key)
    for (const next of graph.get(key) ?? []) {
      const cycle = visit(next)
      if (cycle !== null) return cycle
    }
    path.pop()
    visiting.delete(key)
    visited.add(key)
    return null
  }
  return visit(ownerKey)
}

const now = () => Date.now()
const id = (prefix) => prefix + '-' + randomUUID()
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
}
const hashCanonical = (value) => createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const TASK_EDIT_INPUT_FIELDS = new Set([
  'taskId', 'boardId', 'action', 'expectedRevision', 'actorName', 'actorTier', 'actorGroup',
  'subject', 'description', 'goal', 'deliverable', 'writeScopes', 'workKind',
  'commitSha', 'evidenceIds', 'owner', 'scopeEditRecovery',
])

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/
const DISCUSSION_COMMIT_SENTINEL = 'no-commit:discussion-only-phase'

/**
 * Commit bindings are either one exact 40-character object id or an explicit
 * null. Historical sentinel strings are reported as such instead of being
 * treated as refs.
 */
export function normalizeCommitSha(value) {
  if (value === undefined || value === null || String(value).trim().length === 0) {
    return { ok: true, value: null, raw: null, issue: null }
  }
  const raw = String(value).trim()
  if (raw === DISCUSSION_COMMIT_SENTINEL) {
    return { ok: true, value: null, raw, issue: 'non-commit-sentinel' }
  }
  if (!COMMIT_SHA_RE.test(raw)) {
    return { ok: false, value: null, raw, issue: 'invalid-shape' }
  }
  return { ok: true, value: raw.toLowerCase(), raw, issue: null }
}

export function requireCommitSha(value, label = 'commitSha') {
  const verdict = normalizeCommitSha(value)
  if (verdict.ok !== true) {
    throw new Error(label + ' must be one exact 40-character hexadecimal commit id or null')
  }
  return verdict.value
}

/**
 * Internal control-plane callers also consume legacy fixture and migration
 * rows. Keep public tool validation strict, but preserve internal values here;
 * the load-time normalizer converts historical malformed values to null.
 */
function storedCommitSha(value) {
  if (value === undefined || value === null || String(value).trim().length === 0) return null
  return String(value).trim()
}

export function taskDeleteDependents(boards, boardId, taskId) {
  const found = []
  for (const [dependentBoardId, dependentBoard] of Object.entries(boards ?? {})) {
    for (const dependent of Object.values(dependentBoard?.tasks ?? {})) {
      if (dependent?.status === 'deleted' || !Array.isArray(dependent?.blockedBy)) continue
      const pointsHere = dependent.blockedBy.some((reference) => {
        const resolved = resolveTaskDependency(boards, dependentBoardId, reference)
        return resolved.found && resolved.boardId === String(boardId || 'global') && resolved.taskId === String(taskId)
      })
      if (pointsHere) found.push(String(dependent.id))
    }
  }
  return [...new Set(found)]
}

export function applyTaskDependencies(task, blockedBy) {
  const nextBlockedBy = Array.isArray(blockedBy) ? blockedBy.map(String) : []
  task.blockedBy = nextBlockedBy
  const currentContract = task.contract !== null && typeof task.contract === 'object' && !Array.isArray(task.contract)
    ? task.contract
    : null
  if (currentContract !== null) {
    task.contract = {
      ...currentContract,
      dependencies: nextBlockedBy,
      contractRevision: Number(currentContract.contractRevision ?? 1) + 1,
    }
    task.contractDigest = contractDigest(task.contract)
  }
  return task
}

/**
 * Apply one task edit to both the row projection and its nested contract.
 * Keeping this pure makes the revision -> projection mapping testable.
 */
export function applyTaskEdit(task, input = {}) {
  const unknown = Object.keys(input).filter((key) => !TASK_EDIT_INPUT_FIELDS.has(key))
  if (unknown.length > 0) {
    throw new Error('unknown task edit field(s): ' + unknown.join(', '))
  }
  const previousSubject = String(task.subject ?? '')
  const previousDescription = String(task.description ?? '')
  if (input.subject !== undefined) task.subject = String(input.subject)
  if (input.description !== undefined) task.description = String(input.description)
  if (input.writeScopes !== undefined) task.writeScopes = Array.isArray(input.writeScopes) ? input.writeScopes.map(String) : []
  if (['discussion', 'review', 'edit'].includes(input.workKind)) task.workKind = input.workKind
  if (input.commitSha !== undefined) task.commitSha = storedCommitSha(input.commitSha)
  if (input.evidenceIds !== undefined) task.evidenceIds = Array.isArray(input.evidenceIds) ? input.evidenceIds.map(String) : []

  const ownerProvided = Object.prototype.hasOwnProperty.call(input, 'owner')
  if (ownerProvided) {
    const owner = input.owner === null ? null : String(input.owner)
    if (owner === null) delete task.ownerName
    else task.ownerName = owner
    task.status = owner === null ? 'pending' : 'in_progress'
  }

  const contractTouched = ['subject', 'description', 'goal', 'deliverable', 'writeScopes', 'owner']
    .some((key) => Object.prototype.hasOwnProperty.call(input, key))
  if (contractTouched) {
    const current = task.contract !== null && typeof task.contract === 'object' && !Array.isArray(task.contract)
      ? task.contract
      : {}
    const goal = input.goal !== undefined
      ? String(input.goal)
      : input.subject !== undefined
        ? String(input.subject)
        : String(current.goal ?? task.subject ?? '')
    const deliverable = input.deliverable !== undefined
      ? String(input.deliverable)
      : input.description !== undefined
        ? String(input.description)
        : input.subject !== undefined
          ? String(input.subject)
          : String(current.deliverable ?? task.description ?? task.subject ?? '')
    const nextDefaultText = input.description !== undefined
      ? String(input.description)
      : input.subject !== undefined
        ? String(input.subject)
        : null
    const oldDefaultTexts = new Set([
      previousSubject,
      previousDescription,
      String(current.goal ?? ''),
      String(current.deliverable ?? ''),
    ].filter((value) => value.length > 0))
    const acceptanceCriteria = nextDefaultText !== null && Array.isArray(current.acceptanceCriteria)
      ? current.acceptanceCriteria.map((item) => {
          if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
            return oldDefaultTexts.has(String(item.text ?? item.criterion ?? item.description ?? ''))
              ? { ...item, text: nextDefaultText }
              : item
          }
          return oldDefaultTexts.has(String(item)) ? nextDefaultText : item
        })
      : current.acceptanceCriteria
    task.contract = {
      ...current,
      taskId: task.id,
      goal,
      deliverable,
      ...(input.writeScopes === undefined ? {} : { writeScopes: task.writeScopes }),
      ...(ownerProvided ? { owner: task.ownerName ?? null } : {}),
      ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }),
      contractRevision: Number(current.contractRevision ?? 1) + 1,
    }
    task.contractDigest = contractDigest(task.contract)
  }
  task.updatedAt = now()
  return task
}

function normalizeUnresolvedEntry(item, fallbackId) {
  if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
    const text = String(item.text ?? item.content ?? '').trim()
    if (text.length === 0) return undefined
    const id = String(item.id ?? item.itemId ?? item.unresolvedId ?? fallbackId)
    return {
      id,
      itemId: id,
      text,
      status: item.status === 'resolved' ? 'resolved' : 'open',
      createdAt: item.createdAt ?? null,
      resolvedAt: item.resolvedAt ?? null,
      resolvedBy: item.resolvedBy ?? null,
      resolution: item.resolution ?? null,
    }
  }
  const text = String(item ?? '').trim()
  if (text.length === 0) return undefined
  return {
    id: fallbackId,
    text,
    status: 'open',
    createdAt: null,
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
  }
}

function normalizeUnresolvedList(list, prefix) {
  if (!Array.isArray(list)) return []
  return list
    .map((item, index) => normalizeUnresolvedEntry(item, prefix + '-' + String(index + 1)))
    .filter((item) => item !== undefined)
}

/**
 * A child group round depends on its parent level round whenever a level:1
 * planning room exists and includes the group host. Explicit dependencies may
 * add more parent rooms, but the hierarchy gate is inferred so a model cannot
 * bypass it by omitting a flag.
 */
export function effectiveRoomDependencies(state, room) {
  if (room === null || room === undefined || typeof room !== 'object') return []
  const dependencies = Array.isArray(room.dependsOnRooms)
    ? room.dependsOnRooms.map(String).filter((value) => value.length > 0)
    : []
  if (String(room.kind) === 'group') {
    const parent = state?.rooms?.['level:1']
    const hasLevelRound = parent !== undefined
      && Object.values(state?.rounds ?? {}).some((round) => round?.roomId === 'level:1')
    if (hasLevelRound && Array.isArray(parent.members) && parent.members.includes(room.host)) {
      dependencies.push('level:1')
    }
  }
  return [...new Set(dependencies)]
}

/** Whether every explicit or inferred parent room has completed a round. */
export function roomDependencyVerdict(state, room) {
  const dependencies = effectiveRoomDependencies(state, room)
  for (const dependency of dependencies) {
    const parent = state?.rooms?.[dependency]
    if (parent === undefined) {
      return { ok: false, dependencies, reason: 'required parent room "' + dependency + '" does not exist' }
    }
    const open = parent.currentRoundId === null || parent.currentRoundId === undefined
      ? undefined
      : state?.rounds?.[parent.currentRoundId]
    if (open?.status === 'open') {
      return {
        ok: false,
        dependencies,
        reason: 'parent room "' + dependency + '" still has open round "' + open.roundId + '"',
      }
    }
    const hasClosedRound = Object.values(state?.rounds ?? {})
      .some((round) => round?.roomId === dependency && round.status === 'closed')
    if (!hasClosedRound) {
      return {
        ok: false,
        dependencies,
        reason: 'parent room "' + dependency + '" has not completed a round yet',
      }
    }
  }
  return { ok: true, dependencies }
}

function safeRoot(rootId) {
  return String(rootId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_')
}

function defaultState(rootId) {
  return {
    version: VERSION,
    schemaVersion: VERSION,
    rootId: String(rootId || 'default'),
    revision: 0,
    updatedAt: now(),
    rooms: {},
    rounds: {},
    plans: {},
    dispatches: {},
    leases: {},
    wakeEpisodes: {},
    messageOperations: {},
    escalations: {},
    privilegeRequests: {},
    evidence: {},
    packets: {},
    boards: {},
    provider: {
      status: 'unknown',
      lastFailure: null,
      updatedAt: now(),
    },
    providerFailures: {},
    providerSafety: {},
    frozenMembers: {},
    memberRoutes: {},
    memberParents: {},
    v12RoomWake: { version: 1, rooms: {}, inbox: {}, wakes: {}, stopEpisodes: {}, sequence: {}, revision: 0 },
    v12Compaction: { version: 1, milestones: {}, jobs: {}, sequence: {}, revision: 0 },
    v12Evidence: { version: 1, records: {} },
    v12MergeOperations: { version: 1, operations: {} },
    v12Requirements: { version: 1, revision: 0, requirements: {}, decisions: {}, events: [] },
    v12Events: [],
    v12Capabilities: {},
    roomTails: {},
    v12Migration: {
      status: 'pending',
      fromVersion: 1,
      toVersion: VERSION,
      checkedAt: null,
      appliedAt: null,
    },
    counters: {
      activeSlots: 0,
      lifetimeCreates: 0,
      tokenBudget: null,
      tokenUsed: 0,
      retries: 0,
      contextRefusals: 0,
    },
    health: {
      status: 'healthy',
      reasons: [],
      updatedAt: now(),
    },
  }
}

function normalizeRound(round) {
  if (round === null || typeof round !== 'object') return round
  const spoken = Array.isArray(round.spoken) ? [...new Set(round.spoken.map(String))] : []
  const mainSpoken = Array.isArray(round.mainSpoken)
    ? [...new Set(round.mainSpoken.map(String))]
    : [...spoken]
  round.spoken = spoken
  round.mainSpoken = mainSpoken
  round.clarified = Array.isArray(round.clarified) ? [...new Set(round.clarified.map(String))] : []
  round.queuedCount = Number(round.queuedCount || 0)
  if (round.nextSpeaker === undefined) round.nextSpeaker = null
  return round
}

function nextEligibleSpeaker(state, round, startIndex = 0) {
  const order = Array.isArray(round?.order) ? round.order.map(String) : []
  const spoken = new Set(Array.isArray(round?.mainSpoken) ? round.mainSpoken.map(String) : [])
  const start = Math.max(0, Number(startIndex) || 0)
  return order.slice(start).find((member) =>
    !spoken.has(member) && state?.frozenMembers?.[member]?.frozen !== true) ?? null
}

/** Latest closed round carrying a useful summary, or undefined. */
export function latestClosedRound(state, roomOrId) {
  const roomId = typeof roomOrId === 'string' ? roomOrId : roomOrId?.roomId
  if (typeof roomId !== 'string' || roomId.length === 0) return undefined
  return Object.values(state?.rounds ?? {})
    .filter((round) => round?.roomId === roomId && round.status === 'closed')
    .sort((left, right) => Number(right.closedAt || right.openedAt || 0) - Number(left.closedAt || left.openedAt || 0))
    .find((round) => typeof round.summary === 'string' && round.summary.trim().length > 0)
}

/** Human-facing activity state; room.status remains the durable lifecycle flag. */
export function roomActivity(state, room) {
  if (room?.status !== 'open') return 'closed'
  const round = room.currentRoundId === null || room.currentRoundId === undefined
    ? undefined
    : state?.rounds?.[room.currentRoundId]
  if (round?.status === 'open') return round.nextSpeaker === null ? 'awaiting-close' : 'discussing'
  if ((Array.isArray(room.unresolved) ? room.unresolved : []).some((item) => item?.status !== 'resolved')) return 'blocked'
  return 'idle'
}

/**
 * Remove fields that older task rows wrote outside the task contract and make
 * the stored lifecycle agree with the authoritative status/phase fields.
 */
export function normalizeStoredTask(task) {
  if (task === null || typeof task !== 'object' || Array.isArray(task)) return task
  const legacyApproved = task.approved === true
  if (Object.prototype.hasOwnProperty.call(task, 'approved')) delete task.approved
  if (Object.prototype.hasOwnProperty.call(task, 'commitSha')) {
    const commit = normalizeCommitSha(task.commitSha)
    if (commit.raw !== null && commit.issue !== null) {
      task.commitSha = null
      task.commitShaRaw = commit.raw
      task.commitShaIssue = commit.issue
    } else {
      task.commitSha = commit.value
      delete task.commitShaRaw
      delete task.commitShaIssue
    }
  }
  const status = String(task.status ?? '').toLowerCase()
  const phase = String(task.phase ?? '').toLowerCase()
  let lifecycle = 'proposed'
  if (['completed', 'accepted', 'deleted'].includes(status)) lifecycle = 'completed'
  else if (['cancelled', 'expired'].includes(status)) lifecycle = 'cancelled'
  else if (['member-check', 'group-check', 'verifier-review', 'integration-ready', 'integrated'].includes(phase)) lifecycle = 'review'
  else if (['blocked', 'rejected', 'cancelled', 'expired'].includes(phase)) lifecycle = phase === 'blocked' ? 'blocked' : 'cancelled'
  else if (['in_progress', 'running'].includes(status)) lifecycle = 'running'
  else if (['execution', 'plan-approved'].includes(phase) || legacyApproved || task.lifecycle === 'ready') lifecycle = 'ready'
  else if (phase === 'accepted') lifecycle = 'completed'
  if (!TASK_PHASES.includes(task.phase)) task.phase = 'draft'
  task.lifecycle = lifecycle
  if (task.contract !== null && typeof task.contract === 'object' && !Array.isArray(task.contract)) {
    task.contract.lifecycle = lifecycle
  }
  return task
}

function normalizeState(rootId, parsed) {
  const base = defaultState(rootId)
  if (parsed === null || typeof parsed !== 'object') return base
  const state = { ...base, ...parsed }
  for (const key of ['rooms', 'rounds', 'plans', 'dispatches', 'leases', 'wakeEpisodes', 'escalations', 'privilegeRequests', 'evidence', 'packets', 'boards', 'providerFailures', 'providerSafety', 'frozenMembers', 'memberRoutes', 'memberParents', 'v12RoomWake', 'v12Compaction', 'v12Evidence', 'v12MergeOperations', 'v12Requirements', 'v12Capabilities', 'roomTails', 'coldArchive']) {
    if (state[key] === null || typeof state[key] !== 'object' || Array.isArray(state[key])) state[key] = {}
  }
  if (!Array.isArray(state.v12Events)) state.v12Events = []
  state.v12Migration = {
    ...base.v12Migration,
    ...(state.v12Migration && typeof state.v12Migration === 'object' ? state.v12Migration : {}),
    fromVersion: Number(state.schemaVersion ?? state.version ?? 1),
    toVersion: VERSION,
    checkedAt: state.v12Migration?.checkedAt ?? now(),
    ...(Number(state.schemaVersion ?? state.version ?? 1) < VERSION
      ? {}
      : {
          status: 'current',
          appliedAt: state.v12Migration?.appliedAt ?? now(),
        }),
  }
  state.schemaVersion = VERSION
  state.provider = { ...base.provider, ...(state.provider && typeof state.provider === 'object' ? state.provider : {}) }
  state.counters = { ...base.counters, ...(state.counters && typeof state.counters === 'object' ? state.counters : {}) }
  state.health = { ...base.health, ...(state.health && typeof state.health === 'object' ? state.health : {}) }
  for (const board of Object.values(state.boards)) {
    if (board === null || typeof board !== 'object' || board.tasks === null || typeof board.tasks !== 'object') continue
    for (const task of Object.values(board.tasks)) {
      normalizeStoredTask(task)
    }
  }
  for (const room of Object.values(state.rooms)) {
    if (room === null || typeof room !== 'object') continue
    room.members = Array.isArray(room.members) ? [...new Set(room.members.map(String))] : []
    room.messages = Array.isArray(room.messages) ? room.messages : []
    room.decisions = Array.isArray(room.decisions) ? room.decisions : []
    room.dependsOnRooms = Array.isArray(room.dependsOnRooms)
      ? [...new Set(room.dependsOnRooms.map(String).filter((value) => value.length > 0))]
      : []
    room.unresolved = normalizeUnresolvedList(room.unresolved, 'unresolved-' + room.roomId)
    room.latestSummary = room.latestSummary && typeof room.latestSummary === 'object' ? room.latestSummary : null
    room.lastMessageAt = Number(room.lastMessageAt || 0)
    if (room.lastMessageAt <= 0 && Array.isArray(room.messages) && room.messages.length > 0) {
      room.lastMessageAt = room.messages.reduce((latest, message) => Math.max(latest, Number(message?.createdAt || 0)), 0)
    }
    if (room.lastMessageAt <= 0) room.lastMessageAt = Number(room.createdAt || 0)
  }
  for (const round of Object.values(state.rounds)) {
    normalizeRound(round)
    round.unresolved = normalizeUnresolvedList(round.unresolved, 'unresolved-' + round.roundId)
  }
  // Older builds opened task/root/level rounds without a host. Those rounds were
  // never actionable: nobody could close them, and an empty one kept the panel
  // showing a permanent "next speaker" even though no turn had started. Repair
  // only that legacy shape; a legitimately active round has a host and is left
  // untouched.
  for (const room of Object.values(state.rooms)) {
    if (room === null || typeof room !== 'object') continue
    const missingHost = room.host === null || room.host === undefined || room.host === ''
    if (!missingHost || room.currentRoundId === null || room.currentRoundId === undefined) continue
    if (Number(room.createdAt || 0) > now() - LEGACY_EMPTY_ROOM_GRACE_MS) continue
    const round = state.rounds?.[room.currentRoundId]
    if (round === null || typeof round !== 'object' || round.status !== 'open') continue
    const messages = Array.isArray(room.messages) ? room.messages : []
    const hasTurn = messages.some((message) => message?.roundId === round.roundId && message.turn === true)
    const mainSpoken = Array.isArray(round.mainSpoken) ? round.mainSpoken : []
    if (hasTurn || mainSpoken.length > 0) continue
    round.status = 'closed'
    round.closedAt = round.closedAt ?? now()
    round.unresolved = Array.isArray(round.unresolved) ? round.unresolved : []
    room.currentRoundId = null
  }
  // Task rooms were auto-created by older builds even though task creation does
  // not imply a discussion. Remove the empty, closed, hostless leftovers so the
  // room panel only shows actionable or historically meaningful rooms.
  for (const [roomId, room] of Object.entries(state.rooms)) {
    if (room === null || typeof room !== 'object' || room.kind !== 'task') continue
    const missingHost = room.host === null || room.host === undefined || room.host === ''
    const hasMessages = Array.isArray(room.messages) && room.messages.length > 0
    const hasOpenRound = room.currentRoundId !== null && room.currentRoundId !== undefined
    if (!missingHost || hasMessages || hasOpenRound) continue
    if (Number(room.createdAt || 0) > now() - LEGACY_EMPTY_ROOM_GRACE_MS) continue
    delete state.rooms[roomId]
  }
  for (const row of Object.values(state.dispatches)) {
    if (row === null || typeof row !== 'object') continue
    row.attempt = Number(row.attempt || 0)
    row.mergedCount = Number(row.mergedCount || 0)
    row.messageHashes = Array.isArray(row.messageHashes) ? row.messageHashes.map(String) : []
    row.escalationIds = Array.isArray(row.escalationIds) ? row.escalationIds.map(String) : []
    // A quiet notice has no target run to track. Older builds nevertheless left
    // successfully delivered rows active forever, which blocked the delivery gate
    // and showed a permanently aging dashboard entry.
    if (row.wakeup !== true && row.status === 'delivered'
      && Number(row.createdAt || 0) <= now() - LEGACY_EMPTY_ROOM_GRACE_MS) {
      row.status = 'completed'
      row.resolvedAt = row.resolvedAt ?? row.createdAt ?? now()
    }
  }
  for (const episode of Object.values(state.wakeEpisodes)) {
    if (episode === null || typeof episode !== 'object') continue
    episode.mergedCount = Number(episode.mergedCount || 0)
    episode.escalationIds = Array.isArray(episode.escalationIds) ? episode.escalationIds.map(String) : []
    if (episode.kind === undefined) episode.kind = episode.escalationIds.length > 0 ? 'escalation' : 'control'
  }
  state.rootId = String(rootId || state.rootId || 'default')
  state.version = VERSION
  state.schemaVersion = VERSION
  return state
}

/**
 * Apply deterministic timeout/lease recovery to one snapshot.
 *
 * This is deliberately a pure state transition function so a timer, an
 * operator command and a test all reconcile the same rows without depending on
 * one process staying alive. The returned changes are the work a transport
 * layer may retry; terminal rows are never silently re-opened.
 */
export function reconcileState(state, options = {}, at = now()) {
  const changes = []
  const deliveryTimeoutMs = Math.max(1, Number(options.deliveryTimeoutMs || DEFAULT_DELIVERY_TIMEOUT_MS))
  const runTimeoutMs = Math.max(1, Number(options.runTimeoutMs || DEFAULT_RUN_TIMEOUT_MS))
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 3))

  for (const lease of Object.values(state.leases ?? {})) {
    if (lease === null || typeof lease !== 'object' || lease.status !== 'active') continue
    const deadline = Number(lease.expiresAt || lease.heartbeatAt + runTimeoutMs)
    if (deadline > at) continue
    lease.status = 'expired'
    lease.endedAt = at
    lease.error = 'run lease heartbeat expired'
    changes.push({ kind: 'lease-expired', leaseId: lease.runId, member: lease.member, dispatchId: lease.dispatchId ?? null })
    if (lease.dispatchId !== null && lease.dispatchId !== undefined) {
      const dispatch = state.dispatches?.[lease.dispatchId]
      if (dispatch !== undefined && ACTIVE_DISPATCH_STATES.has(dispatch.status)) {
        dispatch.status = 'expired'
        dispatch.lastError = lease.error
        dispatch.resolvedAt = at
        changes.push({ kind: 'dispatch-expired', dispatchId: dispatch.dispatchId, target: dispatch.target })
      }
    }
  }

  // A privilege grant is a one-turn escape hatch. If the granted turn never
  // starts (or the process dies before it ends), expire it after the lease-like
  // timeout instead of leaving a durable bypass behind.
  for (const request of Object.values(state.privilegeRequests ?? {})) {
    if (request === null || typeof request !== 'object' || request.status !== 'active') continue
    const deadline = Number(request.expiresAt || request.activatedAt + runTimeoutMs)
    if (deadline > at) continue
    request.status = 'expired'
    request.endedAt = at
    request.endReason = 'privilege grant expired without a turn end'
    changes.push({ kind: 'privilege-expired', requestId: request.requestId, member: request.member })
  }

  for (const row of Object.values(state.dispatches ?? {})) {
    if (row === null || typeof row !== 'object' || TERMINAL_DISPATCH_STATES.has(row.status)) continue
    // A quiet Team notice is durable as soon as it is recorded. It has no target
    // turn to acknowledge, so applying the wake-delivery deadline to it produces a
    // false `timed-out` wall in the console and blocks the delivery gate. Close it
    // as completed instead of retrying a delivery that was never expected to wake.
    if (row.wakeup !== true && ['queued', 'delivered'].includes(row.status)) {
      row.status = 'completed'
      row.lastError = null
      row.resolvedAt = row.resolvedAt ?? at
      changes.push({ kind: 'dispatch-completed', dispatchId: row.dispatchId, target: row.target })
      continue
    }
    const linkedLease = row.runId === null || row.runId === undefined ? undefined : state.leases?.[row.runId]
    if (linkedLease?.status === 'expired' || linkedLease?.status === 'failed' || linkedLease?.status === 'cancelled') {
      row.status = 'expired'
      row.lastError = 'linked run lease ended as ' + linkedLease.status
      row.resolvedAt = at
      changes.push({ kind: 'dispatch-expired', dispatchId: row.dispatchId, target: row.target })
      continue
    }

    const explicitDeadline = row.deadlineAt === null || row.deadlineAt === undefined ? undefined : Number(row.deadlineAt)
    const ageBase = Number(row.createdAt || at)
    const ageDeadline = ['queued', 'delivered'].includes(row.status) ? ageBase + deliveryTimeoutMs : ageBase + runTimeoutMs
    const deadline = explicitDeadline === undefined ? ageDeadline : Math.min(explicitDeadline, ageDeadline)
    if (deadline > at) continue

    if (['queued', 'delivered'].includes(row.status) && row.attempt < maxAttempts) {
      row.attempt += 1
      row.status = 'queued'
      row.deadlineAt = at + deliveryTimeoutMs
      row.lastError = 'delivery deadline expired; retry queued'
      row.resolvedAt = null
      for (const message of Array.isArray(row.pendingMessages) ? row.pendingMessages : []) {
        if (['handled', 'rejected'].includes(String(message?.status ?? ''))) continue
        message.status = 'queued'
        message.updatedAt = at
      }
      changes.push({ kind: 'dispatch-retry', dispatchId: row.dispatchId, target: row.target, wakeup: row.wakeup === true, attempt: row.attempt })
      continue
    }

    row.status = ['queued', 'delivered'].includes(row.status) ? 'timed-out' : 'expired'
    row.lastError = 'dispatch deadline expired'
    row.resolvedAt = at
    for (const message of Array.isArray(row.pendingMessages) ? row.pendingMessages : []) {
      if (['handled', 'rejected'].includes(String(message?.status ?? ''))) continue
      message.status = row.status === 'timed-out' ? 'delivery-failed' : row.status
      message.updatedAt = at
    }
    changes.push({
      kind: row.status === 'timed-out' ? 'dispatch-timeout' : 'dispatch-expired',
      dispatchId: row.dispatchId,
      target: row.target,
    })
  }

  if (changes.length > 0) state.updatedAt = at
  return changes
}

export function reconcileHasWork(state, options = {}, at = now()) {
  const deliveryTimeoutMs = Math.max(1, Number(options.deliveryTimeoutMs || DEFAULT_DELIVERY_TIMEOUT_MS))
  const runTimeoutMs = Math.max(1, Number(options.runTimeoutMs || DEFAULT_RUN_TIMEOUT_MS))

  for (const lease of Object.values(state?.leases ?? {})) {
    if (lease === null || typeof lease !== 'object' || lease.status !== 'active') continue
    const deadline = Number(lease.expiresAt || lease.heartbeatAt + runTimeoutMs)
    if (!(deadline > at)) return true
  }

  for (const request of Object.values(state?.privilegeRequests ?? {})) {
    if (request === null || typeof request !== 'object' || request.status !== 'active') continue
    const deadline = Number(request.expiresAt || request.activatedAt + runTimeoutMs)
    if (!(deadline > at)) return true
  }

  for (const row of Object.values(state?.dispatches ?? {})) {
    if (row === null || typeof row !== 'object' || TERMINAL_DISPATCH_STATES.has(row.status)) continue
    if (row.wakeup !== true && ['queued', 'delivered'].includes(row.status)) return true

    const linkedLease = row.runId === null || row.runId === undefined ? undefined : state.leases?.[row.runId]
    if (linkedLease?.status === 'expired' || linkedLease?.status === 'failed' || linkedLease?.status === 'cancelled') {
      return true
    }

    const explicitDeadline = row.deadlineAt === null || row.deadlineAt === undefined ? undefined : Number(row.deadlineAt)
    const ageBase = Number(row.createdAt || at)
    const ageDeadline = ['queued', 'delivered'].includes(row.status) ? ageBase + deliveryTimeoutMs : ageBase + runTimeoutMs
    const deadline = explicitDeadline === undefined ? ageDeadline : Math.min(explicitDeadline, ageDeadline)
    if (!(deadline > at)) return true
  }

  return false
}

function fileFor(rootId, config = {}) {
  const home = typeof config.home === 'string' && config.home.length > 0
    ? config.home
    : process.env.DSH_HOME ?? process.cwd()
  const directory = typeof config.directory === 'string' && config.directory.length > 0
    ? config.directory
    : join(home, STORE_NAME)
  return join(directory, safeRoot(rootId) + '.json')
}

function historyFileFor(file, revision) {
  return file + '.history-' + String(revision) + '.json'
}

function coldFileFor(file, digest) {
  return file + '.cold-' + digest + '.json'
}

function panelCacheFile(file) {
  return file + PANEL_CACHE_SUFFIX
}

function coldDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function requirementsDigest(value) {
  const revision = Number(value?.revision)
  const cached = requirementsDigestCache.get(value)
  if (cached !== undefined && Number.isFinite(revision) && cached.revision === revision) return cached.digest
  const digest = coldDigest(value)
  if (Number.isFinite(revision)) requirementsDigestCache.set(value, { revision, digest })
  return digest
}

function coldRefDigest(value) {
  const cached = coldRefDigestCache.get(value)
  if (cached !== undefined) return cached
  const digest = coldDigest(value)
  coldRefDigestCache.set(value, digest)
  return digest
}

function storagePolicy(config = {}) {
  const number = (value, fallback, minimum = 0) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback
  }
  return {
    coldGcGraceMs: number(config.coldGcGraceMs, DEFAULT_COLD_GC_GRACE_MS),
    coldGcIntervalMs: number(config.coldGcIntervalMs, DEFAULT_COLD_GC_INTERVAL_MS, 1),
    tempStaleMs: number(config.tempStaleMs, DEFAULT_TEMP_STALE_MS),
    auditMaxBytes: number(config.auditMaxBytes, DEFAULT_AUDIT_MAX_BYTES, 1),
    auditMaxFiles: number(config.auditMaxFiles, DEFAULT_AUDIT_MAX_FILES, 0),
    auditMaxAgeMs: number(config.auditMaxAgeMs, DEFAULT_AUDIT_MAX_AGE_MS),
  }
}

function storagePathPredicate(file, kind) {
  if (kind === 'cold') {
    return (path) => path.startsWith(file + '.cold-') && path.endsWith('.json')
  }
  if (kind === 'temp') {
    return (path) => path.startsWith(file + '.') && path.includes('.tmp-')
  }
  if (kind === 'audit') {
    return (path) => path === file + '.audit.jsonl'
      || (path.startsWith(file + '.audit-') && path.endsWith('.jsonl'))
  }
  const includeAudit = kind === 'roots-audit'
  return (path) => {
    if (path.includes('.tmp-')) return false
    if (path.startsWith(file + '.cold-')) return false
    if (path === panelCacheFile(file)) return false
    if (path.startsWith(file + '.audit') && path.endsWith('.jsonl')) return includeAudit
    return path === file
      || (path.startsWith(file + '.') && path.endsWith('.json'))
  }
}

function controlPlaneFiles(file, kind) {
  const directory = dirname(file)
  const signature = storageDirectorySignature(file)
  if (signature === null) {
    storagePathCache.delete(directory)
    storageInventoryCache.delete(file)
    return []
  }
  const cached = storagePathCache.get(directory)
  let entry
  if (cached !== undefined
    && sameStorageDirectorySignature(cached.signature, signature)
    && now() - cached.checkedAt < STORAGE_CACHE_REFRESH_MS) {
    entry = cached
  } else {
    const names = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
    if (cached !== undefined && sameStorageNameList(cached.names, names)) {
      cached.signature = signature
      cached.checkedAt = now()
      entry = cached
    } else {
      entry = {
        signature,
        names,
        paths: names.map((name) => join(directory, name)),
        categories: new Map(),
        checkedAt: now(),
        generation: ++storagePathGeneration,
      }
    }
    storagePathCache.set(directory, entry)
  }
  const category = entry.categories.get(kind)
  if (category !== undefined) return category
  const paths = entry.paths.filter(storagePathPredicate(file, kind))
  entry.categories.set(kind, paths)
  return paths
}

function coldFilesFor(file) {
  return controlPlaneFiles(file, 'cold')
}

function tempFilesFor(file) {
  return controlPlaneFiles(file, 'temp')
}

function auditFilesFor(file) {
  return controlPlaneFiles(file, 'audit')
}

function readAuditTail(path, maxBytes) {
  let fd
  try {
    fd = openSync(path, 'r')
    const stats = statSync(path)
    const start = Math.max(0, stats.size - maxBytes)
    const length = stats.size - start
    const buffer = Buffer.alloc(length)
    let offset = 0
    while (offset < length) {
      const count = readSync(fd, buffer, offset, length - offset, start + offset)
      if (count <= 0) break
      offset += count
    }
    let text = buffer.subarray(0, offset).toString('utf8')
    if (start > 0) {
      const newline = text.indexOf('\n')
      text = newline >= 0 ? text.slice(newline + 1) : ''
    }
    return { text, truncated: start > 0 }
  } catch (error) {
    if (error?.code === 'ENOENT') return { text: '', truncated: false }
    throw error
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch {}
    }
  }
}

/**
 * Read a bounded, newest-first audit tail. The returned `events` are in
 * chronological order within the retained window; `truncated` makes it clear
 * that older rows were intentionally not loaded.
 */
export function readAuditEvents(file, options = {}) {
  const maxBytes = Math.max(1024, Number(options.maxBytes) || 2 * 1024 * 1024)
  const maxEvents = Math.max(1, Number(options.maxEvents) || 8192)
  const files = auditFilesFor(file)
    .map((path) => ({ path, stats: storageFileStat(path) }))
    .filter((row) => row.stats !== null)
    .sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs)
  const chunks = []
  const malformed = []
  let truncated = false
  for (const row of files) {
    const tail = readAuditTail(row.path, maxBytes)
    truncated = truncated || tail.truncated
    const parsed = []
    for (const line of tail.text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        const event = JSON.parse(trimmed)
        if (event !== null && typeof event === 'object' && !Array.isArray(event)) parsed.push(event)
        else malformed.push({ path: row.path, line: trimmed.slice(0, 200), reason: 'not-an-object' })
      } catch (error) {
        malformed.push({ path: row.path, line: trimmed.slice(0, 200), reason: String(error?.message ?? error) })
      }
    }
    chunks.push(parsed)
  }
  const events = chunks.reverse().flat()
  return {
    events: events.slice(-maxEvents),
    files: files.map((row) => row.path),
    truncated: truncated || events.length > maxEvents,
    malformed,
  }
}

/** Read the real audit tail and classify it against the observed snapshot. */
export function auditStatusFor(file, state, options = {}) {
  const audit = readAuditEvents(file, options)
  const versioned = audit.events.filter((event) =>
    Number.isInteger(Number(event?.revision ?? event?.toRevision ?? event?.stateRevision)))
  const revisions = versioned
    .map((event) => Number(event.revision ?? event.toRevision ?? event.stateRevision))
    .filter(Number.isInteger)
  const trackedFromRevision = revisions.length === 0 ? Number(state?.revision ?? 0) : Math.min(...revisions)
  const base = auditConsistencyResult(state, versioned, { ...options, trackedFromRevision })
  const legacy = audit.events.length - versioned.length
  const legacyOnly = versioned.length === 0 && Number(state?.revision ?? 0) > 0
  return {
    ...base,
    ...(legacyOnly ? {
      ok: false,
      consistent: false,
      code: 'audit-legacy-unversioned',
    } : {}),
    auditEventsRead: audit.events.length,
    versionedAuditEvents: versioned.length,
    legacyAuditEvents: legacy,
    auditFilesRead: audit.files.length,
    auditTruncated: audit.truncated,
    malformedAuditLines: audit.malformed.length,
  }
}

function storageFileStat(path) {
  try {
    return statSync(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function storageDirectorySignature(file) {
  try {
    const stats = statSync(dirname(file), { bigint: true })
    return { mtimeNs: String(stats.mtimeNs), ctimeNs: String(stats.ctimeNs) }
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function sameStorageDirectorySignature(left, right) {
  return left !== null && right !== null
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function sameStorageNameList(left, right) {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function invalidateStorageInventory(file) {
  storageInventoryCache.delete(file)
  storagePathCache.delete(dirname(file))
}

function rememberStoragePath(file, path, kind) {
  const directory = dirname(file)
  const entry = storagePathCache.get(directory)
  if (entry === undefined) return
  if (!entry.paths.includes(path)) {
    entry.paths.push(path)
    entry.names.push(path.slice(directory.length + 1))
    entry.generation = ++storagePathGeneration
  }
  const category = entry.categories.get(kind)
  if (category !== undefined && !category.includes(path)) category.push(path)
  entry.checkedAt = now()
}

function storageInventoryFor(file) {
  const signature = storageDirectorySignature(file)
  if (signature === null) return { signature, coldRows: [] }

  const coldPaths = coldFilesFor(file)
  const pathEntry = storagePathCache.get(dirname(file))
  const generation = pathEntry?.generation ?? 0
  const cached = storageInventoryCache.get(file)
  if (cached !== undefined && cached.generation === generation) return cached
  const coldRows = coldPaths.map((path) => ({ path, digest: coldDigestFromPath(file, path), stats: storageFileStat(path) }))
    .filter((row) => row.digest !== null && row.stats !== null)

  // A concurrent writer can remove a file between readdir and stat. Do not
  // publish a partial inventory; the next caller will rescan it.
  if (coldRows.length !== coldPaths.length) {
    return { signature, coldRows }
  }
  const inventory = { signature, coldRows, checkedAt: now(), generation }
  storageInventoryCache.set(file, inventory)
  return inventory
}

function coldDigestFromPath(file, path) {
  const prefix = file + '.cold-'
  if (!path.startsWith(prefix) || !path.endsWith('.json')) return null
  const digest = path.slice(prefix.length, -'.json'.length)
  return COLD_DIGEST_RE.test(digest) ? digest : null
}

function invalidateColdPathCache(path) {
  verifiedCold.delete(path)
  const cached = coldRawCache.get(path)
  if (cached === undefined) return
  coldRawCache.delete(path)
  coldRawCacheBytes = Math.max(0, coldRawCacheBytes - cached.raw.length)
}

function collectReachableColdDigests(file, { includeAudit = false } = {}) {
  // Audit rows are history, not live state. Treating every digest ever
  // mentioned by an audit event as reachable made cold storage append-only:
  // an orphan could never age out because its own diagnostic trail kept it
  // alive. Current snapshots and recovery snapshots are the authoritative
  // roots; audits are deliberately excluded unless a caller asks for them.
  const candidates = controlPlaneFiles(file, includeAudit ? 'roots-audit' : 'roots-live')
  const signature = candidates
    .map((path) => path + '\u0000' + String(fileSignature(path)))
    .join('\u0001')
  const cacheKey = file + '\u0000' + (includeAudit ? 'audit' : 'live')
  const cached = reachableColdCache.get(cacheKey)
  if (cached !== undefined && cached.signature === signature) return cached.digests

  const digests = new Set()
  for (const path of candidates) {
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    for (const digest of text.match(/[a-f0-9]{64}/g) ?? []) digests.add(digest)
  }
  reachableColdCache.set(cacheKey, { signature, digests })
  return digests
}

function recordWriteTiming(file, values, { sample = false } = {}) {
  const prior = writeMetrics.get(file) ?? { samples: 0, last: null }
  writeMetrics.set(file, {
    samples: prior.samples + (sample ? 1 : 0),
    last: {
      ...(prior.last ?? {}),
      ...values,
      updatedAt: now(),
    },
  })
}

function writeTimingFor(file) {
  const value = writeMetrics.get(file)
  return value === undefined
    ? { samples: 0, last: null }
    : { samples: value.samples, last: value.last === null ? null : structuredClone(value.last) }
}

function inspectControlPlaneStorage(file, options = {}) {
  const policy = storagePolicy(options)
  const { coldRows } = storageInventoryFor(file)
  const tempRows = tempFilesFor(file).map((path) => ({ path, stats: storageFileStat(path) }))
    .filter((row) => row.stats !== null)
  const auditRows = auditFilesFor(file).map((path) => ({ path, stats: storageFileStat(path) }))
    .filter((row) => row.stats !== null)
  const sumBytes = (rows) => rows.reduce((total, row) => total + Number(row.stats.size || 0), 0)
  const oldestAge = (rows) => rows.reduce((oldest, row) =>
    Math.max(oldest, Math.max(0, now() - row.stats.mtimeMs)), 0)

  let reachable = null
  let reachabilityError = null
  try {
    reachable = collectReachableColdDigests(file)
  } catch (error) {
    reachabilityError = String(error?.message ?? error)
  }
  const orphanRows = reachable === null
    ? []
    : coldRows.filter((row) => row.digest !== null && !reachable.has(row.digest))
  const orphanPaths = new Set(orphanRows.map((row) => row.path))
  const reclaimableRows = orphanRows.filter((row) => Math.max(0, now() - row.stats.mtimeMs) >= policy.coldGcGraceMs)

  return {
    coldFiles: coldRows.length,
    coldBytes: sumBytes(coldRows),
    reachableColdFiles: reachable === null ? null : coldRows.length - orphanRows.length,
    reachableColdBytes: reachable === null ? null : sumBytes(coldRows.filter((row) => !orphanPaths.has(row.path))),
    orphanFiles: reachable === null ? null : orphanRows.length,
    orphanBytes: reachable === null ? null : sumBytes(orphanRows),
    reclaimableFiles: reachable === null ? null : reclaimableRows.length,
    reclaimableBytes: reachable === null ? null : sumBytes(reclaimableRows),
    tempFiles: tempRows.length,
    tempBytes: sumBytes(tempRows),
    auditFiles: auditRows.length,
    auditBytes: sumBytes(auditRows),
    oldestColdAgeMs: oldestAge(coldRows),
    oldestTempAgeMs: oldestAge(tempRows),
    oldestAuditAgeMs: oldestAge(auditRows),
    coldGcGraceMs: policy.coldGcGraceMs,
    reachabilityError,
    write: writeTimingFor(file),
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function cleanupControlPlaneTempFiles(file, options = {}) {
  const policy = storagePolicy(options)
  let deleted = 0
  let bytes = 0
  for (const path of tempFilesFor(file)) {
    const stats = storageFileStat(path)
    if (stats === null) continue
    const match = /\.tmp-(\d+)-/.exec(path)
    const pid = match === null ? null : Number(match[1])
    const ageMs = Math.max(0, now() - stats.mtimeMs)
    const ownedByCurrentProcess = pid === process.pid
    const ownerIsDead = pid !== null && !isProcessAlive(pid)
    if (!ownedByCurrentProcess && !ownerIsDead && ageMs < policy.tempStaleMs) continue
    try {
      unlinkSync(path)
      deleted += 1
      bytes += Number(stats.size || 0)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return { deleted, bytes }
}

export async function gcControlPlaneStorage(file, options = {}) {
  const policy = storagePolicy(options)
  const allowDelete = options.allowDelete !== false
  // Inventory outside the write lock. The old implementation held the lock
  // while statting every cold file, so a large history directory blocked all
  // Team mutations for the duration of the sweep. The digest set is re-read
  // under the lock below; immutable content-addressed paths make the inventory
  // safe to collect before locking.
  const temp = cleanupControlPlaneTempFiles(file, policy)
  if (temp.deleted > 0) invalidateStorageInventory(file)
  const rows = storageInventoryFor(file).coldRows
  return withFileLock(file, async () => {
    const reachable = collectReachableColdDigests(file)
    const reclaimable = []
    let deleted = 0
    let bytes = 0
    for (const row of rows) {
      if (reachable.has(row.digest)) continue
      if (Math.max(0, now() - row.stats.mtimeMs) < policy.coldGcGraceMs) continue
      reclaimable.push(row)
      if (!allowDelete) continue
      try {
        unlinkSync(row.path)
        invalidateColdPathCache(row.path)
        invalidateStorageInventory(file)
        deleted += 1
        bytes += Number(row.stats.size || 0)
      } catch (error) {
        discardUnpublishedMemory(file)
        if (error?.code !== 'ENOENT') throw error
      }
    }
    return {
      scannedColdFiles: rows.length,
      reachableColdFiles: rows.length - deleted,
      reclaimableColdFiles: reclaimable.length,
      reclaimableColdBytes: reclaimable.reduce((total, row) => total + Number(row.stats.size || 0), 0),
      deletedColdFiles: deleted,
      deletedColdBytes: bytes,
      deletedTempFiles: temp.deleted,
      deletedTempBytes: temp.bytes,
      deletionSuppressed: !allowDelete,
      graceMs: policy.coldGcGraceMs,
    }
  })
}

export function controlPlaneStorageHealth(file, options = {}) {
  return inspectControlPlaneStorage(file, options)
}

const windowFreshReads = new Map()
function readCold(file, digest) {
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error('invalid control-plane cold reference for ' + file)
  }
  const path = coldFileFor(file, digest)
  const fresh=windowFreshReads.get(file)
  if(fresh) {
    const raw=fresh(path)
    if(createHash('sha256').update(raw).digest('hex')!==digest)throw new Error('control-plane cold history hash mismatch at '+path)
    return JSON.parse(raw.toString('utf8'))
  }
  let raw
  const cached = coldRawCache.get(path)
  if (cached !== undefined) {
    if (fileSignature(path) === cached.signature) {
      raw = cached.raw
      coldRawCache.delete(path)
      coldRawCache.set(path, cached)
    } else {
      coldRawCache.delete(path)
      coldRawCacheBytes -= cached.raw.length
    }
  }
  if (raw === undefined) {
    try { raw = readFileSync(path) } catch (error) {
      throw new Error('control-plane cold history missing or corrupt at ' + path + ': ' + String(error?.message ?? error))
    }
    if (createHash('sha256').update(raw).digest('hex') !== digest) {
      throw new Error('control-plane cold history hash mismatch at ' + path)
    }
    const signature = fileSignature(path)
    if (signature === null) {
      throw new Error('control-plane cold history missing or corrupt at ' + path)
    }
    rememberColdRaw(path, raw, signature)
  }
  // Cold files are written as the exact JSON.stringify bytes whose SHA-256
  // names them. Hash those bytes directly; reparsing and reserializing a
  // 25-30 MB event history for every read was a multi-second synchronous
  // stall on the DSH event loop.
  let value
  try { value = JSON.parse(raw.toString('utf8')) } catch (error) {
    throw new Error('control-plane cold history missing or corrupt at ' + path + ': ' + String(error?.message ?? error))
  }
  rememberCold(path)
  return value
}

function readRoomHistory(file, ref) {
  if (typeof ref === 'string') return readCold(file, ref)
  if (ref === null || typeof ref !== 'object' || Array.isArray(ref) || ref.version !== 2) {
    throw new Error('invalid control-plane room history reference for ' + file)
  }
  const base = readCold(file, ref.base)
  if (!Array.isArray(base)) throw new Error('invalid control-plane room history base for ' + file)
  const appended = Array.isArray(ref.appended) ? ref.appended : []
  const messages = [...base]
  for (const digest of appended) {
    const rows = readCold(file, digest)
    if (!Array.isArray(rows)) throw new Error('invalid control-plane appended room history for ' + file)
    messages.push(...rows)
  }
  return messages
}

function historyRefCount(file, ref) {
  if (typeof ref === 'string') {
    const rows = readCold(file, ref)
    if (!Array.isArray(rows)) throw new Error('control-plane cold history is not an array at ' + file)
    return rows.length
  }
  if (ref !== null && typeof ref === 'object' && !Array.isArray(ref) && ref.version === 2) {
    const count = Number(ref.count)
    if (Number.isInteger(count) && count >= 0) return count
    return readRoomHistory(file, ref).length
  }
  return 0
}

/**
 * Append only the rows that are not already represented by a cold reference.
 * The count is persisted so the next hot append does not have to rehydrate the
 * entire historical array just to discover its length.
 */
function appendHistoryRef(file, ref, rows, { chunkSize = 64, full = false } = {}) {
  const all = Array.isArray(rows) ? rows : []
  const previous = historyRefCount(file, ref)
  const delta = full ? all.slice(Math.max(0, previous)) : all
  const appended = []
  for (let offset = 0; offset < delta.length; offset += chunkSize) {
    appended.push(writeCold(file, delta.slice(offset, offset + chunkSize)))
  }
  const count = previous + delta.length
  if (typeof ref === 'string') return { version: 2, base: ref, appended, count }
  if (ref !== null && typeof ref === 'object' && !Array.isArray(ref) && ref.version === 2) {
    return {
      ...ref,
      appended: [...(Array.isArray(ref.appended) ? ref.appended : []), ...appended],
      count,
    }
  }
  return { version: 2, base: writeCold(file, []), appended, count }
}

function historyRefTail(file, ref) {
  if (typeof ref === 'string') {
    const rows = readCold(file, ref)
    if (!Array.isArray(rows)) throw new Error('control-plane cold history is not an array at ' + file)
    return rows.length === 0 ? undefined : rows[rows.length - 1]
  }
  if (ref !== null && typeof ref === 'object' && !Array.isArray(ref) && ref.version === 2) {
    const appended = Array.isArray(ref.appended) ? ref.appended : []
    if (appended.length > 0) {
      const rows = readCold(file, appended[appended.length - 1])
      if (!Array.isArray(rows)) throw new Error('control-plane cold history is not an array at ' + file)
      return rows.length === 0 ? undefined : rows[rows.length - 1]
    }
    const rows = readCold(file, ref.base)
    if (!Array.isArray(rows)) throw new Error('control-plane cold history is not an array at ' + file)
    return rows.length === 0 ? undefined : rows[rows.length - 1]
  }
  return undefined
}

/**
 * Preserve append-only history without rewriting the full array. A same-length
 * or shortened update is treated as a rewrite and falls back to a full blob.
 */
function appendOrRewriteHistoryRef(file, ref, rows, options = {}) {
  const all = Array.isArray(rows) ? rows : []
  if (ref === undefined || ref === null || options.compact === true) return writeCold(file, all)
  const previous = historyRefCount(file, ref)
  if (all.length < previous) return writeCold(file, all)
  if (all.length === previous) {
    const existing = readRoomHistory(file, ref)
    if (JSON.stringify(existing) === JSON.stringify(all)) return ref
    return writeCold(file, all)
  }
  if (previous > 0) {
    const previousTail = historyRefTail(file, ref)
    if (JSON.stringify(previousTail) !== JSON.stringify(all[previous - 1])) return writeCold(file, all)
  }
  return appendHistoryRef(file, ref, all, { full: true, ...options })
}

function appendRoomHistoryRef(file, ref, messages) {
  return appendHistoryRef(file, ref, messages, { full: false })
}

function readPanelCache(file) {
  const cached = panelCache.get(file)
  if (cached !== undefined) return cached
  try {
    const parsed = JSON.parse(readFileSync(panelCacheFile(file), 'utf8'))
    const value = {
      version: 1,
      revision: Number(parsed?.revision ?? 0),
      fingerprint: typeof parsed?.fingerprint === 'string' ? parsed.fingerprint : null,
      rooms: parsed?.rooms !== null && typeof parsed?.rooms === 'object' && !Array.isArray(parsed.rooms)
        ? parsed.rooms
        : {},
      transcripts: parsed?.transcripts !== null && typeof parsed?.transcripts === 'object' && !Array.isArray(parsed.transcripts)
        ? parsed.transcripts
        : {},
      inbox: boundedInbox(parsed?.inbox),
    }
    remember(panelCache, file, value, MAX_PANEL_CACHE_ENTRIES)
    return value
  } catch {
    const value = { version: 1, revision: 0, fingerprint: null, rooms: {}, transcripts: {}, inbox: {} }
    remember(panelCache, file, value, MAX_PANEL_CACHE_ENTRIES)
    return value
  }
}

function boundedInbox(inbox) {
  const entries = Object.entries(inbox !== null && typeof inbox === 'object' && !Array.isArray(inbox) ? inbox : {})
  const normalized = []
  for (const [key, row] of entries) {
    const candidate = String(row?.messageId ?? key)
    if (candidate.length === 0 || candidate.length > 200 || /[\r\n]/.test(candidate)) continue
    normalized.push([candidate, { ...row, messageId: candidate }])
  }
  if (normalized.length <= INBOX_CACHE_LIMIT) return Object.fromEntries(normalized)
  const archived = []
  const active = []
  for (const entry of normalized) {
    const status = String(entry[1]?.status ?? '')
    const injected = status !== 'queued'
      && (String(entry[1]?.injectionReceipt ?? '').length > 0 || Number(entry[1]?.injectedAt) > 0)
    if (['handled', 'rejected'].includes(status) || injected) archived.push(entry)
    else active.push(entry)
  }
  archived.sort((left, right) => Number(right[1]?.updatedAt ?? right[1]?.injectedAt ?? right[1]?.createdAt ?? 0)
    - Number(left[1]?.updatedAt ?? left[1]?.injectedAt ?? left[1]?.createdAt ?? 0))
  const keptArchived = archived.slice(0, Math.max(0, INBOX_CACHE_LIMIT - active.length))
  return Object.fromEntries([...active, ...keptArchived.reverse()])
}

function boundedRoomInjections(roomInjections) {
  const rooms = {}
  for (const [roomId, members] of Object.entries(roomInjections ?? {})) {
    const nextMembers = {}
    for (const [member, entries] of Object.entries(members ?? {})) {
      const rows = Object.entries(entries ?? {})
        .sort((left, right) => Number(left[1]?.lastInjectedAt ?? left[1]?.injectedAt ?? 0) - Number(right[1]?.lastInjectedAt ?? right[1]?.injectedAt ?? 0))
      nextMembers[member] = Object.fromEntries(rows.slice(-ROOM_TAIL_LIMIT))
    }
    rooms[roomId] = nextMembers
  }
  return rooms
}

function boundedWakes(wakes) {
  const rows = Object.entries(wakes ?? {})
  const active = rows.filter(([, row]) => !['handled', 'rejected'].includes(String(row?.status ?? '')))
    .sort((left, right) => Number(right[1]?.updatedAt ?? right[1]?.createdAt ?? 0) - Number(left[1]?.updatedAt ?? left[1]?.createdAt ?? 0))
    .slice(0, WAKE_ACTIVE_LIMIT)
  const terminal = rows.filter(([, row]) => ['handled', 'rejected'].includes(String(row?.status ?? '')))
    .sort((left, right) => Number(left[1]?.updatedAt ?? left[1]?.createdAt ?? 0) - Number(right[1]?.updatedAt ?? right[1]?.createdAt ?? 0))
  return Object.fromEntries([...terminal.slice(-WAKE_TERMINAL_LIMIT), ...active])
}

function rowTimestamp(row) {
  return Number(row?.resolvedAt ?? row?.updatedAt ?? row?.endedAt ?? row?.createdAt ?? row?.at ?? 0)
}

function archiveColdRows(file, refs, rows) {
  const next = Array.isArray(refs) ? [...refs] : []
  for (let offset = 0; offset < rows.length; offset += HOT_ARCHIVE_CHUNK_SIZE) {
    next.push(writeCold(file, rows.slice(offset, offset + HOT_ARCHIVE_CHUNK_SIZE)))
  }
  return next
}

function pruneMapRows(map, { limit, active, protectedIds }) {
  const cutoff = Math.max(0, Number(limit) || 0)
  const entries = Object.entries(map ?? {})
  if (entries.length <= cutoff) return []
  const terminal = []
  for (const entry of entries) {
    const key = String(entry[0])
    const row = entry[1]
    if (active(row) || protectedIds?.has(key)) continue
    terminal.push(entry)
  }
  terminal.sort((left, right) => rowTimestamp(right[1]) - rowTimestamp(left[1]))
  const prunedEntries = terminal.slice(cutoff)
  for (const [key] of prunedEntries) delete map[key]
  return prunedEntries.map(([, row]) => row)
}

function pruneArrayRows(state, field, limit) {
  const rows = Array.isArray(state?.[field]) ? state[field] : []
  const keep = Math.max(0, Number(limit) || 0)
  if (rows.length <= keep) return []
  const pruned = rows.slice(0, rows.length - keep)
  state[field] = rows.slice(-keep)
  return pruned
}

function pruneControlPlaneArchive(file, state) {
  const prior = state?.coldArchive !== null && typeof state?.coldArchive === 'object' && !Array.isArray(state.coldArchive)
    ? state.coldArchive
    : {}
  const archive = { version: 1, ...prior }
  const append = (field, rows) => {
    if (!Array.isArray(rows) || rows.length === 0) return
    archive[field] = archiveColdRows(file, archive[field], rows)
  }

  const protectedDispatches = new Set()
  for (const episode of Object.values(state.wakeEpisodes ?? {})) {
    if (episode?.dispatchId && !TERMINAL_WAKE_STATES.has(String(episode.status))) {
      protectedDispatches.add(String(episode.dispatchId))
    }
  }
  for (const lease of Object.values(state.leases ?? {})) {
    if (String(lease?.status) === 'active' && lease.dispatchId) {
      protectedDispatches.add(String(lease.dispatchId))
    }
  }
  append('dispatches', pruneMapRows(state.dispatches, {
    limit: HOT_TERMINAL_DISPATCH_LIMIT,
    active: (row) => !TERMINAL_DISPATCH_STATES.has(String(row?.status)),
    protectedIds: protectedDispatches,
  }))

  const protectedLeases = new Set()
  for (const dispatch of Object.values(state.dispatches ?? {})) {
    if (dispatch?.runId && !TERMINAL_DISPATCH_STATES.has(String(dispatch.status))) {
      protectedLeases.add(String(dispatch.runId))
    }
  }
  append('leases', pruneMapRows(state.leases, {
    limit: HOT_TERMINAL_LEASE_LIMIT,
    active: (row) => String(row?.status) === 'active',
    protectedIds: protectedLeases,
  }))

  append('wakeEpisodes', pruneMapRows(state.wakeEpisodes, {
    limit: HOT_TERMINAL_WAKE_LIMIT,
    active: (row) => !TERMINAL_WAKE_STATES.has(String(row?.status)),
  }))
  append('v14Receipts', pruneArrayRows(state, 'v14Receipts', HOT_RECEIPT_LIMIT))
  append('v14DeliveryReceipts', pruneArrayRows(state, 'v14DeliveryReceipts', HOT_RECEIPT_LIMIT))

  if (Object.keys(archive).length > 1) state.coldArchive = archive
}

function panelCacheFingerprint(value) {
  const compactRows = (rows) => {
    const list = Array.isArray(rows) ? rows : []
    const last = list.length === 0 ? undefined : list[list.length - 1]
    return [
      list.length,
      String(last?.messageId ?? last?.id ?? ''),
      Number(last?.createdAt ?? last?.updatedAt ?? 0),
    ]
  }
  const rooms = Object.fromEntries(Object.entries(value.rooms ?? {})
    .map(([roomId, rows]) => [roomId, compactRows(rows)])
    .sort(([left], [right]) => left.localeCompare(right)))
  const transcripts = Object.fromEntries(Object.entries(value.transcripts ?? {})
    .map(([roomId, rows]) => [roomId, compactRows(rows)])
    .sort(([left], [right]) => left.localeCompare(right)))
  const inbox = Object.fromEntries(Object.entries(value.inbox ?? {})
    .map(([messageId, row]) => [messageId, [
      String(row?.status ?? ''),
      Number(row?.updatedAt ?? row?.injectedAt ?? 0),
      String(row?.injectionReceipt ?? ''),
      row?.wakeRequested === true,
    ]])
    .sort(([left], [right]) => left.localeCompare(right)))
  return createHash('sha256').update(JSON.stringify({ rooms, transcripts, inbox })).digest('hex')
}

function panelCacheValue(file, state, { historyHydrated = false, roomAppend, roomAppends } = {}) {
  const prior = readPanelCache(file)
  const rooms = {}
  for (const [roomId, room] of Object.entries(state?.rooms ?? {})) {
    const messages = Array.isArray(room?.messages) ? room.messages : []
    if (messages.length > 0) rooms[roomId] = messages.slice(-ROOM_TAIL_LIMIT)
  }
  for (const [roomId, messages] of Object.entries(prior.rooms ?? {})) {
    if (rooms[roomId] === undefined) rooms[roomId] = Array.isArray(messages) ? messages.slice(-ROOM_TAIL_LIMIT) : []
  }
  const appendByRoom = new Map()
  if (roomAppends !== null && typeof roomAppends === 'object' && !Array.isArray(roomAppends)) {
    for (const [roomId, messages] of Object.entries(roomAppends)) {
      if (Array.isArray(messages) && messages.length > 0) appendByRoom.set(String(roomId), messages)
    }
  }
  if (roomAppend?.roomId !== undefined && Array.isArray(roomAppend.messages)) {
    const roomId = String(roomAppend.roomId)
    appendByRoom.set(roomId, [...(appendByRoom.get(roomId) ?? []), ...roomAppend.messages])
  }
  for (const [roomId, messages] of appendByRoom) {
    const previous = Array.isArray(rooms[roomId]) ? rooms[roomId] : []
    rooms[roomId] = [...previous, ...messages].slice(-ROOM_TAIL_LIMIT)
  }
  const stateInbox = state?.v12RoomWake?.inbox
  const transcripts = {}
  for (const [roomId, rows] of Object.entries(state?.v12RoomWake?.transcripts ?? {})) {
    if (Array.isArray(rows) && rows.length > 0) transcripts[roomId] = rows.slice(-ROOM_TAIL_LIMIT)
  }
  for (const [roomId, rows] of Object.entries(prior.transcripts ?? {})) {
    if (transcripts[roomId] === undefined) transcripts[roomId] = Array.isArray(rows) ? rows.slice(-ROOM_TAIL_LIMIT) : []
  }
  const inbox = boundedInbox(historyHydrated
    ? (stateInbox !== null && typeof stateInbox === 'object' && !Array.isArray(stateInbox) ? stateInbox : {})
    : { ...(prior.inbox ?? {}), ...(stateInbox !== null && typeof stateInbox === 'object' && !Array.isArray(stateInbox) ? stateInbox : {}) })
  const value = {
    version: 1,
    revision: Number(state?.revision ?? 0),
    rooms,
    transcripts,
    inbox,
  }
  value.fingerprint = panelCacheFingerprint(value)
  remember(panelCache, file, value, MAX_PANEL_CACHE_ENTRIES)
  return value
}

function writePanelCacheSync(file, state, options = {}) {
  const prior = readPanelCache(file)
  const value = panelCacheValue(file, state, options)
  if (prior.fingerprint !== null && prior.fingerprint === value.fingerprint && existsSync(panelCacheFile(file))) {
    return value
  }
  const temp = panelCacheFile(file) + '.tmp-' + process.pid + '-' + randomUUID()
  try {
    writeFileSync(temp, JSON.stringify(value), 'utf8')
    renameSync(temp, panelCacheFile(file))
  } finally {
    try {
      if (existsSync(temp)) unlinkSync(temp)
    } catch {}
  }
  return value
}

async function writePanelCacheAsync(file, state, options = {}) {
  const prior = readPanelCache(file)
  const value = panelCacheValue(file, state, options)
  if (prior.fingerprint !== null && prior.fingerprint === value.fingerprint && existsSync(panelCacheFile(file))) {
    return value
  }
  const text = JSON.stringify(value)
  const target = panelCacheFile(file)
  if (Buffer.byteLength(text) <= PANEL_CACHE_ASYNC_THRESHOLD) {
    const temp = target + '.tmp-' + process.pid + '-' + randomUUID()
    try {
      writeFileSync(temp, text, 'utf8')
      renameSync(temp, target)
    } finally {
      try {
        if (existsSync(temp)) unlinkSync(temp)
      } catch {}
    }
    return value
  }
  try {
    const temp = target + '.tmp-' + process.pid + '-' + randomUUID()
    try {
      await writeFileAsync(temp, text, 'utf8')
      await renameWithRetry(temp, target)
    } finally {
      try {
        if (existsSync(temp)) await unlinkAsync(temp)
      } catch {}
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return
    console.warn('[team-control-plane] panel cache write failed for ' + file + ': ' + String(error?.message ?? error))
  }
  return value
}

function writeCold(file, value) {
  const serialized = JSON.stringify(value)
  const digest = createHash('sha256').update(serialized).digest('hex')
  const path = coldFileFor(file, digest)
  if (existsSync(path)) {
    if (!verifiedCold.has(path)) readCold(file, digest)
    syncFileData(path)
    return digest
  }
  const temp = path + '.tmp-' + process.pid + '-' + randomUUID()
  try {
    writeSyncedFile(temp, serialized)
    renameSync(temp, path)
    syncPublishedDirectory(path)
  } finally {
    try {
      if (existsSync(temp)) unlinkSync(temp)
    } catch {}
  }
  rememberCold(path)
  return digest
}

function hydrateHistory(parsed, file) {
  if (parsed.coldHistory !== undefined) {
    const refs = parsed.coldHistory
    if (refs?.version !== 1 || refs.rooms === null || typeof refs.rooms !== 'object' || Array.isArray(refs.rooms)) {
      throw new Error('invalid control-plane cold manifest for ' + file)
    }
    for (const key of ['transcripts', 'inbox']) {
      if (refs[key] !== undefined && (refs[key] === null || typeof refs[key] !== 'object' || Array.isArray(refs[key]))) {
        throw new Error('invalid control-plane cold manifest ' + key + ' for ' + file)
      }
    }
    if (refs.inboxBatch !== undefined && (typeof refs.inboxBatch !== 'string' || !/^[a-f0-9]{64}$/.test(refs.inboxBatch))) {
      throw new Error('invalid control-plane cold manifest inboxBatch for ' + file)
    }
    for (const [roomId, room] of Object.entries(parsed.rooms ?? {})) {
      if (!Object.hasOwn(refs.rooms, roomId)) throw new Error('missing control-plane room history reference for ' + roomId)
      const messages = readRoomHistory(file, refs.rooms[roomId])
      if (!Array.isArray(messages)) throw new Error('invalid control-plane room history at ' + roomId)
      room.messages = messages
    }
    const events = readRoomHistory(file, refs.v12Events)
    const wakeEvents = readRoomHistory(file, refs.v12RoomWakeEvents)
    if (!Array.isArray(events) || !Array.isArray(wakeEvents)) throw new Error('invalid control-plane event history for ' + file)
    const hotEvents = Array.isArray(parsed.v12Events) ? parsed.v12Events : []
    const eventKeys = new Set(events.map((row) => String(row?.eventId ?? row?.callId ?? row?.id ?? row?.at ?? '')))
    parsed.v12Events = [...events, ...hotEvents.filter((row) => {
      const key = String(row?.eventId ?? row?.callId ?? row?.id ?? row?.at ?? '')
      return key.length === 0 || !eventKeys.has(key)
    })].slice(-20000)
    const transcripts = { ...(refs.transcripts === undefined ? parsed.v12RoomWake?.transcripts ?? {} : {}) }
    const hotInbox = parsed.v12RoomWake?.inbox !== null && typeof parsed.v12RoomWake?.inbox === 'object' && !Array.isArray(parsed.v12RoomWake.inbox)
      ? parsed.v12RoomWake.inbox
      : {}
    const inbox = { ...hotInbox }
    for (const [roomId, digest] of Object.entries(refs.transcripts ?? {})) transcripts[roomId] = readCold(file, digest)
    if (refs.inboxBatch !== undefined) {
      const batch = readCold(file, refs.inboxBatch)
      if (batch === null || typeof batch !== 'object' || Array.isArray(batch)) {
        throw new Error('invalid control-plane inbox batch for ' + file)
      }
      Object.assign(inbox, batch)
    }
    // Full inbox history is not needed to assemble current context. Keeping
    // this bounded prevents hundreds of tiny cold reads from blocking a turn.
    // Per-row refs are the newer overlay; read them after the legacy batch so
    // a changed row can never be overwritten by its old batch value.
    for (const [messageId, digest] of Object.entries(refs.inbox ?? {}).slice(-COLD_INBOX_REF_LIMIT)) {
      inbox[messageId] = readCold(file, digest)
    }
    // Hot inbox rows are newer than their cold copies; keep them authoritative.
    parsed.v12RoomWake = { ...(parsed.v12RoomWake ?? {}), events: wakeEvents, transcripts, inbox: { ...inbox, ...hotInbox } }
    return parsed
  }
  const revisionPath = historyFileFor(file, Number(parsed.revision || 0))
  const history = readDurableJson(revisionPath, { fallback: undefined })
    ?? readDurableJson(file + HISTORY_SUFFIX, { fallback: undefined })
  if (history === undefined) return parsed
  if (history === null || typeof history !== 'object' || Array.isArray(history)) {
    throw new Error('control-plane history is corrupt for ' + file)
  }
  if (history.revision !== undefined && Number(history.revision) !== Number(parsed.revision || 0)) {
    throw new Error('control-plane history revision mismatch for ' + file)
  }
  for (const [roomId, messages] of Object.entries(history.rooms ?? {})) {
    const room = parsed.rooms?.[roomId]
    if (room !== undefined && Array.isArray(messages)) room.messages = messages
  }
  if (Array.isArray(history.v12Events)) parsed.v12Events = history.v12Events
  if (Array.isArray(history.v12RoomWakeEvents)) {
    parsed.v12RoomWake = { ...(parsed.v12RoomWake ?? {}), events: history.v12RoomWakeEvents }
  }
  return parsed
}

function hydrateRequirements(parsed, file) {
  const ref = parsed?.v12RequirementsRef
  if (ref === undefined || ref === null) return parsed
  if (ref.version !== 1 || typeof ref.digest !== 'string' || !/^[a-f0-9]{64}$/.test(ref.digest)) {
    throw new Error('invalid control-plane requirements reference for ' + file)
  }
  if (parsed.v12Requirements !== null && typeof parsed.v12Requirements === 'object' && !Array.isArray(parsed.v12Requirements)) {
    return parsed
  }
  const value = readCold(file, ref.digest)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid control-plane requirements payload for ' + file)
  }
  parsed.v12Requirements = value
  return parsed
}

function hydrateColdRefs(parsed, file) {
  const refs = parsed?.v12ColdRefs
  if (refs === undefined) return parsed
  if (refs === null || typeof refs !== 'object' || Array.isArray(refs)) {
    throw new Error('invalid control-plane cold field references for ' + file)
  }
  for (const [field, ref] of Object.entries(refs)) {
    if (!COLD_REF_FIELDS.has(field)) {
      throw new Error('invalid control-plane cold field reference for ' + field + ' in ' + file)
    }
    if (ref?.version !== 1 || typeof ref.digest !== 'string' || !/^[a-f0-9]{64}$/.test(ref.digest)) {
      throw new Error('invalid control-plane cold field reference for ' + field + ' in ' + file)
    }
    if (parsed[field] !== undefined) continue
    const value = readCold(file, ref.digest)
    parsed[field] = value
    if (value !== null && typeof value === 'object') coldRefDigestCache.set(value, ref.digest)
  }
  return parsed
}

export function readControlPlaneSnapshot(file) {
  try {
    return hydrateRequirements(hydrateColdRefs(hydrateHistory(JSON.parse(readFileSync(file, 'utf8')), file), file), file)
  } catch (error) {
    invalidateParsedCache(file)
    throw error
  }
}

function readWindowSnapshot(file, protection) {
  const reader=protection ? path=>protection.readFile(path) : path=>readFileSync(path)
  const parsed=JSON.parse(reader(file).toString('utf8'))
  if(!parsed.coldHistory || parsed.coldHistory.version!==1)throw new Error('WINDOW_CANONICAL_COLD_MANIFEST_REQUIRED')
  if(windowFreshReads.has(file))throw new Error('WINDOW_CANONICAL_READ_REENTRANT')
  windowFreshReads.set(file,reader)
  try {return hydrateRequirements(hydrateColdRefs(hydrateHistory(parsed,file),file),file)}
  finally {windowFreshReads.delete(file)}
}

function protectWindowReferences(file, protection, sourceFiles) {
  const hot=JSON.parse(protection.readFile(file).toString('utf8')),digests=new Set()
  if(!hot.coldHistory || hot.coldHistory.version!==1)throw new Error('WINDOW_CANONICAL_COLD_MANIFEST_REQUIRED')
  function visit(value) {
    if(typeof value==='string' && /^[a-f0-9]{64}$/.test(value))digests.add(value)
    else if(value && typeof value==='object')for(const child of Object.values(value))visit(child)
  }
  for(const refs of [hot.coldHistory,hot.v12RequirementsRef,hot.v12ColdRefs])visit(refs)
  const files=[...digests].map(digest=>coldFileFor(file,digest))
  if(files.length)protection.add(files)
  const extra=typeof sourceFiles==='function' ? sourceFiles(protection) : sourceFiles
  if(extra?.then || extra!==undefined && !Array.isArray(extra))throw new Error('WINDOW_FILE_PROTECTION_SYNC_SOURCES_REQUIRED')
  if(extra?.length)protection.add(extra)
}

export function readControlPlanePanelCache(file) {
  return structuredClone(readPanelCache(file))
}

export function readControlPlaneRoomHistory(file, ref) {
  return readRoomHistory(file, ref)
}

export function readControlPlaneColdValue(file, digest) {
  return readCold(file, digest)
}

function load(rootId, config, { history = true, clone = true } = {}) {
  const file = fileFor(rootId, config)
  const cacheKey = cacheKeyFor(file, history)
  let lastError
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const before = fileSignature(file)
      if (before === null) {
        const memory = memoryHotStates.get(file)
        if (memory !== undefined && memory.signature === null) {
          return clone ? cloneCachedState({ state: memory.state }) : memory.state
        }
        invalidateParsedCache(file)
        lastGood.delete(cacheKey)
        return defaultState(rootId)
      }
      const memory = history ? undefined : memoryHotStates.get(file)
      if (memory !== undefined && memory.signature === before) {
        return clone ? cloneCachedState({ state: memory.state }) : memory.state
      }
      const cachedHistory = history && clone ? historyCache.get(file) : undefined
      if (cachedHistory?.signature === before) {
        remember(historyCache, file, cachedHistory, MAX_HISTORY_CACHE_ENTRIES)
        return clone ? cloneCachedState(cachedHistory) : cachedHistory.state
      }
      const cached = history ? undefined : parsedCache.get(cacheKey)
      if (cached?.signature === before) {
        if (!history) remember(lastGood, cacheKey, cached.state, MAX_LAST_GOOD_ENTRIES)
        return clone ? cloneCachedState(cached) : cached.state
      }
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const after = fileSignature(file)
      if (after !== before) {
        pauseSync(10 + attempt * 15)
        continue
      }
      const hydrated = history ? hydrateHistory(parsed, file) : parsed
      const state = normalizeState(rootId, hydrateRequirements(hydrateColdRefs(hydrated, file), file))
      if (!history) rememberRootIndex(file, after, state)
      const cache = readPanelCache(file)
      if (!history) {
        state.roomTails = { ...(cache.rooms ?? {}) }
        state.roomTranscriptTails = { ...(cache.transcripts ?? {}) }
        if (state.v12RoomWake?.inbox === undefined) {
          state.v12RoomWake = { ...(state.v12RoomWake ?? {}), inbox: { ...(cache.inbox ?? {}) } }
        }
      } else if (state.v12RoomWake !== undefined && state.v12RoomWake !== null) {
        state.v12RoomWake = {
          ...state.v12RoomWake,
          inbox: { ...(state.v12RoomWake.inbox ?? {}), ...(cache.inbox ?? {}) },
        }
      }
      const entry = { signature: after, state }
      if (history && clone) {
        remember(historyCache, file, entry, MAX_HISTORY_CACHE_ENTRIES)
      } else {
        remember(parsedCache, cacheKey, entry, MAX_PARSED_CACHE_ENTRIES)
        remember(lastGood, cacheKey, state, MAX_LAST_GOOD_ENTRIES)
      }
      return clone ? cloneCachedState(entry) : entry.state
    } catch (error) {
      if (/control-plane (cold|room history reference|event history|history revision)/.test(String(error?.message ?? error))) throw error
      lastError = error
      // A missing file is a real empty Team; anything else may be a transient
      // read/rename collision, so retry before treating the Team as empty.
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
        invalidateParsedCache(file)
        lastGood.delete(cacheKey)
        return defaultState(rootId)
      }
      pauseSync(10 + attempt * 15)
    }
  }
  const reason = lastError && lastError.message ? String(lastError.message) : String(lastError)
  const cached = lastGood.get(cacheKey)
  if (cached !== undefined) {
    console.warn('[team-control-plane] read failed; serving the last good state for ' + file + ': ' + reason)
    const degraded = structuredClone(cached)
    degraded.readStatus = {
      status: 'degraded',
      reason,
      at: now(),
      source: 'last-good',
    }
    return degraded
  }
  throw new Error('control-plane read failed for ' + file + ': ' + reason)
}

function prepareControlPlaneSnapshot(file, state, {
  beforePublish,
  historyHydrated = true,
  roomAppend,
  roomAppends,
  historyAppends = [],
} = {}) {
  mkdirSync(dirname(file), { recursive: true })
  pruneControlPlaneArchive(file, state)
  const priorRefs = state.coldHistory
  if (!historyHydrated && (priorRefs?.version !== 1 || priorRefs.rooms === null || typeof priorRefs.rooms !== 'object')) {
    throw new Error('hot-only persistence requires a cold manifest')
  }
  const appendByRoom = new Map()
  if (roomAppends !== null && typeof roomAppends === 'object' && !Array.isArray(roomAppends)) {
    for (const [roomId, messages] of Object.entries(roomAppends)) {
      if (Array.isArray(messages) && messages.length > 0) appendByRoom.set(String(roomId), messages)
    }
  }
  if (roomAppend?.roomId !== undefined && Array.isArray(roomAppend.messages) && roomAppend.messages.length > 0) {
    const roomId = String(roomAppend.roomId)
    appendByRoom.set(roomId, [...(appendByRoom.get(roomId) ?? []), ...roomAppend.messages])
  }
  const hot = { ...state, rooms: {}, coldHistory: { version: 1, rooms: {}, transcripts: {}, inbox: {} } }
  for (const [roomId, room] of Object.entries(state.rooms ?? {})) {
    hot.rooms[roomId] = { ...room, messages: [] }
    const messages = Array.isArray(room?.messages) ? room.messages : []
    const pendingMessages = appendByRoom.get(roomId)
    hot.coldHistory.rooms[roomId] = pendingMessages !== undefined
      ? appendRoomHistoryRef(file, priorRefs?.rooms?.[roomId], pendingMessages)
      : historyHydrated
        ? appendOrRewriteHistoryRef(file, priorRefs?.rooms?.[roomId], messages)
        : priorRefs?.rooms?.[roomId] ?? writeCold(file, [])
  }
  const appendRows = new Map((Array.isArray(historyAppends) ? historyAppends : [])
    .filter((row) => row !== null && typeof row === 'object' && Array.isArray(row.rows) && row.rows.length > 0)
    .map((row) => [String(row.field), row.rows]))
  const appendField = (field, priorRef, fullRows) => {
    const delta = appendRows.get(field)
    if (delta !== undefined) return appendHistoryRef(file, priorRef, delta, { full: false })
    return historyHydrated ? appendOrRewriteHistoryRef(file, priorRef, fullRows) : priorRef
  }
  hot.coldHistory.v12Events = appendField('v12Events', priorRefs?.v12Events, state.v12Events)
  hot.coldHistory.v12RoomWakeEvents = appendField(
    'v12RoomWake.events',
    priorRefs?.v12RoomWakeEvents,
    state.v12RoomWake?.events,
  )
  const wake = state.v12RoomWake ?? {}
  const inboxRows = Object.entries(wake.inbox ?? {}).slice(-COLD_INBOX_LIMIT)
  if (historyHydrated) {
    for (const [roomId, rows] of Object.entries(wake.transcripts ?? {})) {
      hot.coldHistory.transcripts[roomId] = appendOrRewriteHistoryRef(file, priorRefs?.transcripts?.[roomId], rows)
    }
  } else {
    hot.coldHistory.transcripts = { ...(priorRefs.transcripts ?? {}) }
  }
  const nextInbox = { ...(priorRefs?.inbox ?? {}) }
  for (const [messageId, row] of inboxRows) {
    const digest = coldDigest(row)
    if (nextInbox[messageId] !== digest) nextInbox[messageId] = writeCold(file, row)
  }
  hot.coldHistory.inbox = Object.fromEntries(Object.entries(nextInbox).slice(-COLD_INBOX_REF_LIMIT))
  if (priorRefs?.inboxBatch !== undefined) {
    hot.coldHistory.inboxBatch = priorRefs.inboxBatch
  } else if (inboxRows.length > 0) {
    // One legacy baseline is enough. Subsequent changes are per-row overlays,
    // so an inbox transition no longer rewrites the complete bounded inbox.
    hot.coldHistory.inboxBatch = writeCold(file, Object.fromEntries(inboxRows))
  }
  hot.v12Events = Array.isArray(state.v12Events) ? state.v12Events.slice(-EVENT_TAIL_LIMIT) : []
  delete hot.roomTails
  delete hot.roomTranscriptTails
  if (hot.v12RoomWake && typeof hot.v12RoomWake === 'object') {
    hot.v12RoomWake = { ...hot.v12RoomWake }
    delete hot.v12RoomWake.events
    delete hot.v12RoomWake.transcripts
    delete hot.v12RoomWake.inbox
    hot.v12RoomWake.roomInjections = boundedRoomInjections(hot.v12RoomWake.roomInjections)
    hot.v12RoomWake.wakes = boundedWakes(hot.v12RoomWake.wakes)
  }
  const requirements = state.v12Requirements
  if (requirements !== null && typeof requirements === 'object' && !Array.isArray(requirements)) {
    const digest = requirementsDigest(requirements)
    const prior = state.v12RequirementsRef
    hot.v12RequirementsRef = prior?.version === 1 && prior.digest === digest
      ? prior
      : { version: 1, digest: writeCold(file, requirements) }
    delete hot.v12Requirements
  } else {
    delete hot.v12RequirementsRef
  }
  const priorColdRefs = state.v12ColdRefs !== null && typeof state.v12ColdRefs === 'object' && !Array.isArray(state.v12ColdRefs)
    ? state.v12ColdRefs
    : {}
  const coldRefs = {}
  for (const field of COLD_REF_FIELDS) {
    const value = state[field]
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const digest = coldRefDigest(value)
    const prior = priorColdRefs[field]
    coldRefs[field] = prior?.version === 1 && prior.digest === digest
      ? prior
      : { version: 1, digest: writeCold(file, value) }
    delete hot[field]
  }
  if (Object.keys(coldRefs).length > 0) hot.v12ColdRefs = coldRefs
  else delete hot.v12ColdRefs
  beforePublish?.(hot)
  return hot
}

function rememberPublishedHotState(file, state, hot, historyHydrated) {
  invalidateParsedCache(file, { keepHot: true })
  memoryHotStates.delete(file)
  const hotSignature = fileSignature(file)
  if (hotSignature === null) return
  rememberRootIndex(file, hotSignature, state)
  const cachedHot = {
    ...hot,
    v12Requirements: state.v12Requirements,
    v12Evidence: state.v12Evidence,
    v12Compaction: state.v12Compaction,
    roomTails: historyHydrated
      ? Object.fromEntries(Object.entries(state.rooms ?? {}).flatMap(([roomId, room]) => {
          const messages = Array.isArray(room?.messages) ? room.messages : []
          return messages.length === 0 ? [] : [[roomId, messages.slice(-ROOM_TAIL_LIMIT)]]
        }))
      : { ...(state.roomTails ?? {}) },
    roomTranscriptTails: historyHydrated
      ? Object.fromEntries(Object.entries(state.v12RoomWake?.transcripts ?? {}).flatMap(([roomId, rows]) =>
          Array.isArray(rows) && rows.length > 0 ? [[roomId, rows.slice(-ROOM_TAIL_LIMIT)]] : []))
      : { ...(state.roomTranscriptTails ?? {}) },
    v12RoomWake: {
      ...(hot.v12RoomWake ?? {}),
      inbox: { ...(state.v12RoomWake?.inbox ?? {}) },
    },
  }
  remember(parsedCache, cacheKeyFor(file, false), { signature: hotSignature, state: cachedHot }, MAX_PARSED_CACHE_ENTRIES)
  remember(lastGood, cacheKeyFor(file, false), cachedHot, MAX_LAST_GOOD_ENTRIES)
}

function rememberInMemoryHotState(file, state) {
  historyCache.delete(file)
  const signature = fileSignature(file)
  remember(memoryHotStates, file, { signature, state }, MAX_MEMORY_HOT_STATES)
  rememberRootIndex(file, signature, state)
  if (signature !== null) {
    remember(parsedCache, cacheKeyFor(file, false), { signature, state }, MAX_PARSED_CACHE_ENTRIES)
  }
  remember(lastGood, cacheKeyFor(file, false), state, MAX_LAST_GOOD_ENTRIES)
}

function persistOwnedSnapshot(file, state, options, assertOwner) {
  assertOwner()
  const { historyHydrated = true, roomAppend, roomAppends, panelCache = false } = options
  const startedAt = now()
  const started = performance.now()
  const prepareStarted = performance.now()
  const hot = prepareControlPlaneSnapshot(file, state, options)
  const prepareMs = performance.now() - prepareStarted
  const serializeStarted = performance.now()
  const text = JSON.stringify(hot)
  const serializeMs = performance.now() - serializeStarted
  const temp = file + '.tmp-' + process.pid + '-' + randomUUID()
  let writeMs = 0
  let renameMs = 0
  let panelCacheMs = 0
  try {
    const writeStarted = performance.now()
    writeSyncedFile(temp, text)
    writeMs = performance.now() - writeStarted
    const renameStarted = performance.now()
    assertOwner()
    renameSync(temp, file)
    syncPublishedDirectory(file)
    renameMs = performance.now() - renameStarted
  } finally {
    try {
      if (existsSync(temp)) unlinkSync(temp)
    } catch {}
  }
  if (panelCache === true || historyHydrated || roomAppend !== undefined) {
    const panelStarted = performance.now()
    try {
      writePanelCacheSync(file, state, { historyHydrated, roomAppend, roomAppends })
    } catch (error) {
      console.warn('[team-control-plane] panel cache write failed for ' + file + ': ' + String(error?.message ?? error))
    }
    panelCacheMs = performance.now() - panelStarted
  }
  recordWriteTiming(file, {
    prepareMs,
    serializeMs,
    writeMs,
    renameMs,
    panelCacheMs,
    totalMs: performance.now() - started,
    bytes: Buffer.byteLength(text),
    startedAt,
  }, { sample: true })
  rememberPublishedHotState(file, state, hot, historyHydrated)
}

async function persistOwnedSnapshotAsync(file, state, options, assertOwner) {
  assertOwner()
  const { historyHydrated = true, roomAppend, roomAppends, panelCache = false } = options
  const startedAt = now()
  const started = performance.now()
  const prepareStarted = performance.now()
  const hot = prepareControlPlaneSnapshot(file, state, options)
  const prepareMs = performance.now() - prepareStarted
  const serializeStarted = performance.now()
  const text = JSON.stringify(hot)
  const serializeMs = performance.now() - serializeStarted
  const temp = file + '.tmp-' + process.pid + '-' + randomUUID()
  let writeMs = 0
  let renameMs = 0
  let panelCacheMs = 0
  try {
    const writeStarted = performance.now()
    await writeFileAsync(temp, text, 'utf8')
    syncFileData(temp)
    writeMs = performance.now() - writeStarted
    const renameStarted = performance.now()
    assertOwner()
    await renameWithRetry(temp, file)
    syncPublishedDirectory(file)
    renameMs = performance.now() - renameStarted
  } finally {
    try {
      if (existsSync(temp)) await unlinkAsync(temp)
    } catch {}
  }
  if (panelCache === true || historyHydrated || roomAppend !== undefined) {
    const panelStarted = performance.now()
    try {
      await writePanelCacheAsync(file, state, { historyHydrated, roomAppend, roomAppends })
    } catch (error) {
      console.warn('[team-control-plane] panel cache write failed for ' + file + ': ' + String(error?.message ?? error))
    }
    panelCacheMs = performance.now() - panelStarted
  }
  recordWriteTiming(file, {
    prepareMs,
    serializeMs,
    writeMs,
    renameMs,
    panelCacheMs,
    totalMs: performance.now() - started,
    bytes: Buffer.byteLength(text),
    startedAt,
  }, { sample: true })
  rememberPublishedHotState(file, state, hot, historyHydrated)
}

function validateCooperativeSnapshot(file, state, options) {
  if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0) {
    throw new Error('CONTROL_WRITER_CAS_REQUIRED')
  }
  const revision = existsSync(file) ? readControlPlaneSnapshot(file).revision : 0
  if (revision !== options.expectedRevision) throw new Error('CONTROL_WRITER_CAS_CONFLICT')
  if (state?.revision !== revision + 1) throw new Error('CONTROL_WRITER_REVISION_INVALID')
}

export function persistControlPlaneSnapshot(file, state, options = {}) {
  // A synchronous cooperative writer must reject before doing work if busy.
  const lock = acquireFileLockSync(file)
  try {
    validateCooperativeSnapshot(file, state, options)
    return persistOwnedSnapshot(file, state, options, lock.assertOwner)
  } finally { lock.releaseSync() }
}

export async function persistControlPlaneSnapshotAsync(file, state, options = {}) {
  return withFileLock(file, async assertOwner => {
    validateCooperativeSnapshot(file, state, options)
    return persistOwnedSnapshotAsync(file, state, options, assertOwner)
  })
}

function closeAuditHandle(path) {
  const handle = auditHandles.get(path)
  if (handle === undefined) return
  auditHandles.delete(path)
  try { closeSync(handle) } catch {}
}

function closeAuditHandles(file) {
  for (const path of [...auditHandles.keys()]) {
    if (file === undefined || path === file + '.audit.jsonl') closeAuditHandle(path)
  }
}

function pruneAuditRotations(file, policy) {
  const active = file + '.audit.jsonl'
  const rotated = auditFilesFor(file)
    .filter((path) => path !== active)
    .map((path) => ({ path, stats: storageFileStat(path) }))
    .filter((row) => row.stats !== null)
    .sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs)
  for (let index = 0; index < rotated.length; index += 1) {
    const row = rotated[index]
    const ageMs = Math.max(0, now() - row.stats.mtimeMs)
    if (index < policy.auditMaxFiles && ageMs < policy.auditMaxAgeMs) continue
    try { unlinkSync(row.path) } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

function rotateAuditIfNeeded(file, incomingBytes, policy) {
  const path = file + '.audit.jsonl'
  let stats
  try {
    stats = statSync(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  const ageMs = Math.max(0, now() - stats.mtimeMs)
  if (stats.size + incomingBytes <= policy.auditMaxBytes && ageMs < policy.auditMaxAgeMs) return false
  closeAuditHandle(path)
  if (stats.size === 0) {
    try { unlinkSync(path) } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    pruneAuditRotations(file, policy)
    return true
  }
  const rotated = file + '.audit-' + now() + '-' + randomUUID() + '.jsonl'
  renameSync(path, rotated)
  rememberStoragePath(file, rotated, 'audit')
  pruneAuditRotations(file, policy)
  return true
}

function appendAudit(file, payload, options = {}) {
  const path = file + '.audit.jsonl'
  const line = JSON.stringify(payload) + '\n'
  const policy = storagePolicy(options)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      rotateAuditIfNeeded(file, Buffer.byteLength(line), policy)
      let handle = auditHandles.get(path)
      if (handle === undefined) {
        handle = openSync(path, 'a')
        auditHandles.set(path, handle)
      }
      writeSync(handle, line, null, 'utf8')
      rememberStoragePath(file, path, 'audit')
      return true
    } catch (error) {
      closeAuditHandle(path)
      if (attempt === 0 && ['EBADF', 'ENOENT', 'EPERM', 'EACCES'].includes(error?.code)) continue
      return { ok: false, error: String(error?.message ?? error) }
    }
  }
  return { ok: false, error: 'audit append retry exhausted' }
}

/**
 * Serialize mutations across processes as well as within one process. The
 * in-memory queue prevents re-entrancy in one runtime, while this lock keeps
 * two DSH workers from loading the same revision and overwriting each other's
 * durable state. Stale locks are recoverable after an owner crash.
 */
function acquireFileLockSync(file) {
  const lock = file + '.lock'
  mkdirSync(dirname(file), { recursive: true })
  const token = process.pid + ':' + randomUUID()
  let fd
  try {
    fd = openSync(lock, 'wx')
  } catch (error) {
    if (['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw new Error('CONTROL_WRITER_BUSY')
    throw error
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, token, acquiredAt: now() }), 'utf8')
  } catch (error) {
    closeSync(fd)
    unlinkSync(lock)
    throw error
  }
  closeSync(fd)
  const assertOwner = () => {
    const owner = JSON.parse(readFileSync(lock, 'utf8'))
    if (owner.token !== token || owner.pid !== process.pid) throw new Error('control-plane lock ownership changed for ' + file)
  }
  return { assertOwner, releaseSync() { assertOwner(); unlinkSync(lock) } }
}

async function acquireFileLock(file) {
  const lock = file + '.lock'
  mkdirSync(dirname(file), { recursive: true })
  const deadline = now() + 10_000
  const token = process.pid + ':' + randomUUID()
  let acquired = false
  while (!acquired) {
    let fd
    try {
      fd = openSync(lock, 'wx')
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token, acquiredAt: now() }), 'utf8')
      closeSync(fd)
      fd = undefined
      let verified
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try { verified = JSON.parse(readFileSync(lock, 'utf8')); break } catch (error) {
          if (!['EPERM', 'EACCES'].includes(error?.code) || attempt === 9) throw error
          await wait(10)
        }
      }
      if (verified.token !== token || verified.pid !== process.pid) throw new Error('control-plane lock ownership verification failed')
      acquired = true
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd) } catch {}
      }
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error
      try {
        const age = now() - statSync(lock).mtimeMs
        if (age > 30_000) {
          const owner = JSON.parse(readFileSync(lock, 'utf8'))
          let alive = true
          try { process.kill(owner.pid, 0) } catch (probe) {
            if (probe?.code === 'ESRCH') alive = false
          }
          if (Number.isInteger(owner.pid) && owner.pid > 0 && !alive) unlinkSync(lock)
        }
      } catch {}
      if (now() >= deadline) {
        throw new Error(controlPlaneLockTimeoutMessage(file))
      }
      await wait(20)
    }
  }
  const assertOwner = () => {
    let owner
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { owner = JSON.parse(readFileSync(lock, 'utf8')); break } catch (error) {
        if (!['EPERM', 'EACCES'].includes(error?.code) || attempt === 9) throw error
        pauseSync(10)
      }
    }
    if (owner.token !== token || owner.pid !== process.pid) throw new Error('control-plane lock ownership changed for ' + file)
  }
  const release = async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      assertOwner()
      try { unlinkSync(lock); return } catch (error) {
        if (!['EPERM', 'EACCES'].includes(error?.code) || attempt === 9) throw error
        await wait(10)
      }
    }
  }
  return { assertOwner, release }
}

/** The lock timeout is indeterminate: never tell callers a retry is safe. */
export function controlPlaneLockTimeoutMessage(file) {
  return 'control-plane lock timeout for ' + file
    + '; this call did not acquire the lock, so the mutation outcome is unknown'
    + '; query the durable effect before retrying, because a previous writer may have committed it'
}

async function withFileLock(file, operation) {
  const lock = await acquireFileLock(file)
  try {
    return await operation(lock.assertOwner)
  } finally {
    await lock.release()
  }
}

function queue(queueKey, operation) {
  const prior = tails.get(queueKey) ?? Promise.resolve()
  const run = prior.then(operation, operation)
  const tail = run.then(() => undefined, () => undefined)
  tails.set(queueKey, tail)
  return run.finally(() => {
    if (tails.get(queueKey) === tail) tails.delete(queueKey)
  })
}

function noChange(value) {
  return { [NO_CHANGE]: true, value }
}

/**
 * Cheap fingerprint for the fields that require cold-history persistence.
 * Ordinary board/plan mutations stay on the hot path; a callback that changes
 * a Room transcript, wake event, or inbox row is retried once against the
 * hydrated state so the append-only history remains lossless.
 */
function historyFingerprint(state) {
  const rooms = Object.values(state?.rooms ?? {})
    .map((room) => Array.isArray(room?.messages) ? room.messages.length : 0)
    .join(',')
  const wake = state?.v12RoomWake ?? {}
  const transcripts = Object.entries(wake.transcripts ?? {})
    .map(([roomId, rows]) => roomId + ':' + (Array.isArray(rows) ? rows.length : 0))
    .sort()
    .join(',')
  return [
    rooms,
    Array.isArray(wake.events) ? wake.events.length : 0,
    transcripts,
    Object.keys(wake.inbox ?? {}).length,
  ].join('|')
}

function historyRows(state, field) {
  if (field === 'v12Events') return Array.isArray(state?.v12Events) ? state.v12Events : []
  if (field === 'v12RoomWake.events') {
    return Array.isArray(state?.v12RoomWake?.events) ? state.v12RoomWake.events : []
  }
  return []
}

function historyRowKey(row) {
  const value = row?.eventId ?? row?.callId ?? row?.id ?? row?.messageId ?? row?.wakeId ?? row?.at
  if (value !== undefined && value !== null && String(value).length > 0) return String(value)
  return ''
}

function appendedHistoryRows(before, after) {
  const current = Array.isArray(after) ? after : []
  const known = new Set((Array.isArray(before) ? before : []).map(historyRowKey))
  return current.filter((row) => {
    const key = historyRowKey(row)
    return key.length === 0 || !known.has(key)
  })
}

function service(rootId, config = {}) {
  const key = String(rootId || 'default')
  const file = fileFor(key, config)
  const serviceKey = key + '|' + file
  let current = stores.get(serviceKey)
  if (current !== undefined) return current
  const storageOptions = storagePolicy(config)
  try {
    cleanupControlPlaneTempFiles(file, storageOptions)
  } catch (error) {
    console.warn('[team-control-plane] startup temp cleanup failed for ' + file + ': ' + String(error?.message ?? error))
  }
  const emit = (_agent, type, data, revision) => {
    const eventPayload = {
      controlVersion: VERSION,
      rootId: key,
      type,
      data,
      ...(Number.isInteger(revision) ? { revision } : {}),
      at: now(),
    }
    const audit = appendAudit(file, eventPayload, storageOptions)
    if (audit !== true) {
      throw new Error('control-plane audit write failed for ' + file + ': ' + String(audit?.error ?? 'unknown'))
    }
  }
  const pendingPersist = {
    latest: null,
    options: null,
    timer: null,
    lock: null,
    writing: null,
    enqueuedAt: null,
  }
  let writeChain = Promise.resolve()
  const scheduleColdGc = () => {
    if (storageGcTimers.has(file)) return
    const timer = setTimeout(() => {
      storageGcTimers.delete(file)
      // Automatic maintenance observes and reports reclaimable storage, but
      // does not delete it. Explicit operator cleanup can pass allowDelete:true.
      void gcControlPlaneStorage(file, { ...storageOptions, allowDelete: false })
        .catch((error) => console.warn('[team-control-plane] cold GC failed for ' + file + ': ' + String(error?.message ?? error)))
    }, storageOptions.coldGcIntervalMs)
    timer.unref?.()
    storageGcTimers.set(file, timer)
  }
  const enqueuePersistWithLock = (latest, options, lock) => {
    const run = async () => {
      try {
        lock.assertOwner()
        const enqueuedAt = Number(options?.__enqueuedAt ?? now())
        recordWriteTiming(file, { queueWaitMs: Math.max(0, now() - enqueuedAt) })
        await persistOwnedSnapshotAsync(file, latest, options, lock.assertOwner)
        // A newer mutation may have arrived while this checkpoint was being
        // written. Restore the in-memory authority so its reads cannot fall
        // back to the just-published older snapshot.
        if (pendingPersist.latest !== null) rememberInMemoryHotState(file, pendingPersist.latest)
        scheduleColdGc()
      } catch (error) {
        discardUnpublishedMemory(file)
        throw error
      } finally {
        if (pendingPersist.lock === lock) pendingPersist.lock = null
        try {
          await lock.release()
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
      }
    }
    writeChain = writeChain.then(run, run)
    return writeChain
  }
  const releaseUnusedLock = async () => {
    if (pendingPersist.lock === null || pendingPersist.latest !== null || pendingPersist.writing !== null) return
    const lock = pendingPersist.lock
    pendingPersist.lock = null
    await lock.release()
  }
  const startPendingPersist = () => {
    if (pendingPersist.writing !== null) return pendingPersist.writing
    if (pendingPersist.latest === null || pendingPersist.options === null || pendingPersist.lock === null) return null
    const latest = pendingPersist.latest
    const options = { ...pendingPersist.options, __enqueuedAt: pendingPersist.enqueuedAt ?? now() }
    const lock = pendingPersist.lock
    if (pendingPersist.timer !== null) clearTimeout(pendingPersist.timer)
    pendingPersist.latest = null
    pendingPersist.options = null
    pendingPersist.timer = null
    pendingPersist.enqueuedAt = null
    const promise = enqueuePersistWithLock(latest, options, lock)
    pendingPersist.writing = promise
    promise.catch((error) => {
      if (error?.code === 'ENOENT') return
      console.warn('[team-control-plane] deferred persist failed for ' + file + ': ' + String(error?.message ?? error))
    }).finally(() => {
      if (pendingPersist.writing === promise) pendingPersist.writing = null
    })
    return promise
  }
  const flushPending = async () => {
    if (pendingPersist.writing !== null) await pendingPersist.writing
    const pending = startPendingPersist()
    if (pending !== null) await pending
    await releaseUnusedLock()
  }
  const mergeRoomAppends = (left, right) => {
    const merged = new Map()
    for (const source of [left, right]) {
      if (source === null || typeof source !== 'object' || Array.isArray(source)) continue
      for (const [roomId, messages] of Object.entries(source)) {
        if (!Array.isArray(messages) || messages.length === 0) continue
        const key = String(roomId)
        merged.set(key, [...(merged.get(key) ?? []), ...messages])
      }
    }
    return Object.fromEntries(merged)
  }
  const schedulePersist = (latest, options, delayMs, lock) => {
    const prior = pendingPersist.options
    const roomAppends = mergeRoomAppends(prior?.roomAppends, options.roomAppends)
    const merged = {
      ...(prior ?? {}),
      ...options,
      ...(Object.keys(roomAppends).length === 0 ? {} : { roomAppends }),
      panelCache: prior?.panelCache === true || options.panelCache === true,
      historyHydrated: prior?.historyHydrated === true || options.historyHydrated === true,
    }
    pendingPersist.latest = latest
    pendingPersist.options = merged
    pendingPersist.lock = lock
    pendingPersist.enqueuedAt = now()
    rememberInMemoryHotState(file, latest)
    if (pendingPersist.timer !== null) clearTimeout(pendingPersist.timer)
    pendingPersist.timer = setTimeout(startPendingPersist, Math.max(1, Number(delayMs) || 1))
  }
  const commit = (type, data, agent, fn, options = {}) => queue(serviceKey, async () => {
    const deferMs = Math.max(0, Number(options.deferMs) || 0)
    if (options.afterDurable !== undefined && (deferMs !== 0
      || typeof options.afterDurable !== 'function'
      || options.afterDurable.constructor?.name === 'AsyncFunction')) {
      throw Object.assign(new Error('afterDurable requires a synchronous callback and deferMs:0'),
        { code: 'DURABLE_CALLBACK_INVALID' })
    }
    if (deferMs <= 0) {
      await flushPending()
      return withFileLock(file, async (assertOwner) => {
        const historyMode = options.history ?? 'auto'
        let historyHydrated = historyMode === true
        // The deferred path owns the mutation queue and keeps this state as
        // the in-memory authority until the coalesced snapshot lands. Cloning
        // the full multi-megabyte state here made every room/wake transition
        // pay a second full-state copy before doing any useful work.
        let latest = load(key, config, { history: historyHydrated, clone: false })
        if (!historyHydrated && (latest.coldHistory?.version !== 1
          || latest.coldHistory.rooms === null || typeof latest.coldHistory.rooms !== 'object')) {
          historyHydrated = true
          latest = load(key, config)
        }
        const beforeHistory = historyMode === 'auto' ? historyFingerprint(latest) : undefined
        const beforeAppendRows = {
          v12Events: historyRows(latest, 'v12Events'),
          'v12RoomWake.events': historyRows(latest, 'v12RoomWake.events'),
        }
        let outcome = fn(latest)
        if (!historyHydrated && historyMode === 'auto' && historyFingerprint(latest) !== beforeHistory) {
          historyHydrated = true
          latest = load(key, config, { history: true })
          outcome = fn(latest)
        }
        const unchanged = outcome !== null && typeof outcome === 'object' && outcome[NO_CHANGE] === true
        const result = unchanged ? outcome.value : outcome
        if (unchanged) return result
        latest.revision = Number(latest.revision || 0) + 1
        latest.updatedAt = now()
        if (options.roomAppend?.roomId !== undefined && result !== undefined && result !== null) {
          const roomId = String(options.roomAppend.roomId)
          const previous = Array.isArray(latest.roomTails?.[roomId]) ? latest.roomTails[roomId] : []
          latest.roomTails = {
            ...(latest.roomTails ?? {}),
            [roomId]: [...previous, result].slice(-ROOM_TAIL_LIMIT),
          }
        }
        const historyAppends = historyHydrated ? [] : Object.entries(beforeAppendRows)
          .map(([field, before]) => ({
            field,
            rows: appendedHistoryRows(before, historyRows(latest, field)),
          }))
          .filter((row) => row.rows.length > 0)
        const persistOptions = {
          historyHydrated,
          roomAppends: options.roomAppend === undefined
            ? undefined
            : { [String(options.roomAppend.roomId)]: [result] },
          panelCache: options.panelCache === true,
          historyAppends,
        }
        assertOwner()
        rememberInMemoryHotState(file, latest)
        try {
          await persistOwnedSnapshotAsync(file, latest, persistOptions, assertOwner)
        } catch (error) {
          discardUnpublishedMemory(file)
          throw error
        }
        if (options.afterDurable !== undefined) {
          assertOwner()
          // Cross-store consumers may act only after readback, while this lock
          // still excludes competing control-plane writers.
          const durable = readControlPlaneSnapshot(file)
          if (Number(durable.revision) !== Number(latest.revision)) {
            throw Object.assign(new Error('durable control revision differs from the locked commit'),
              { code: 'DURABLE_READBACK_MISMATCH' })
          }
          const consumed = options.afterDurable(result, durable)
          if (consumed !== null && typeof consumed === 'object' && typeof consumed.then === 'function') {
            throw Object.assign(new Error('afterDurable must not yield; receipt remains replayable'),
              { code: 'DURABLE_CALLBACK_INVALID' })
          }
        }
        scheduleColdGc()
        emit(agent, type, data ?? result, latest.revision)
        return result
      })
    }
    if (pendingPersist.writing !== null) await pendingPersist.writing
    if (pendingPersist.lock === null) pendingPersist.lock = await acquireFileLock(file)
    const lock = pendingPersist.lock
    try {
      const historyMode = options.history ?? 'auto'
      let historyHydrated = historyMode === true
      let latest = load(key, config, { history: historyHydrated, clone: false })
      if (!historyHydrated && (latest.coldHistory?.version !== 1
        || latest.coldHistory.rooms === null || typeof latest.coldHistory.rooms !== 'object')) {
        historyHydrated = true
        latest = load(key, config)
      }
      const beforeHistory = historyMode === 'auto' ? historyFingerprint(latest) : undefined
      const beforeAppendRows = {
        v12Events: historyRows(latest, 'v12Events'),
        'v12RoomWake.events': historyRows(latest, 'v12RoomWake.events'),
      }
      let outcome = fn(latest)
      if (!historyHydrated && historyMode === 'auto' && historyFingerprint(latest) !== beforeHistory) {
        historyHydrated = true
        latest = load(key, config, { history: true })
        outcome = fn(latest)
      }
      const unchanged = outcome !== null && typeof outcome === 'object' && outcome[NO_CHANGE] === true
      const result = unchanged ? outcome.value : outcome
      if (unchanged) {
        await releaseUnusedLock()
        return result
      }
      latest.revision = Number(latest.revision || 0) + 1
      latest.updatedAt = now()
      if (options.roomAppend?.roomId !== undefined && result !== undefined && result !== null) {
        const roomId = String(options.roomAppend.roomId)
        const previous = Array.isArray(latest.roomTails?.[roomId]) ? latest.roomTails[roomId] : []
        latest.roomTails = {
          ...(latest.roomTails ?? {}),
          [roomId]: [...previous, result].slice(-ROOM_TAIL_LIMIT),
        }
      }
      const historyAppends = historyHydrated ? [] : Object.entries(beforeAppendRows)
        .map(([field, before]) => ({
          field,
          rows: appendedHistoryRows(before, historyRows(latest, field)),
        }))
        .filter((row) => row.rows.length > 0)
      const persistOptions = {
        historyHydrated,
        roomAppends: options.roomAppend === undefined
          ? undefined
          : { [String(options.roomAppend.roomId)]: [result] },
        panelCache: options.panelCache === true,
        historyAppends,
      }
      lock.assertOwner()
      rememberInMemoryHotState(file, latest)
      schedulePersist(latest, persistOptions, deferMs, lock)
      emit(agent, type, data ?? result, latest.revision)
      return result
    } catch (error) {
      await releaseUnusedLock()
      throw error
    }
  })
  const mutate = (type, data, agent, fn, options = {}) => {
    const durableControlMutation = String(type).startsWith('plan/')
      || String(type).startsWith('board/')
      || type === 'v12/room-legacy-migration'
    return commit(type, data, agent, fn, {
      ...options,
      history: options.history ?? 'auto',
      // Keep lifecycle transitions durable and coalesce high-volume ordinary
      // mutations behind a bounded checkpoint.
      deferMs: options.deferMs ?? (!durableControlMutation && existsSync(file) ? DEFAULT_MUTATION_DEFER_MS : 0),
    })
  }
  const mutateHot = (type, data, agent, fn, options = {}) => commit(type, data, agent, fn, {
    ...options,
    history: false,
    // Hot state is authoritative in memory and the audit append is already
    // synchronous. Persisting the multi-megabyte snapshot on every room join
    // or wake transition serialized message delivery behind disk I/O; use the
    // same bounded coalescing window as other hot mutations.
    deferMs: options.deferMs ?? DEFAULT_MUTATION_DEFER_MS,
  })
  const mutateRoomAppend = (type, data, agent, fn, roomId, options = {}) => commit(type, data, agent, fn, {
    ...options,
    history: false,
    roomAppend: { roomId },
    deferMs: options.deferMs ?? DEFAULT_MUTATION_DEFER_MS,
  })
  const flush = async () => {
    await flushPending()
    await writeChain
    await (tails.get(serviceKey) ?? Promise.resolve())
  }
  const bindMessageDispatch = (s, input, dispatch, episode) => {
    if (input.messageOperationKey === undefined) return
    const operation = s.messageOperations?.[input.messageOperationKey]
    if (!operation) throw new Error('message operation reservation missing')
    operation.receipt = { ...operation.receipt, dispatchId: dispatch.dispatchId,
      ...(episode === undefined ? {} : { episodeId: episode.episodeId }), messageHash: dispatch.messageHash }
    operation.status = 'dispatch-recorded'
    operation.revision = Number(operation.revision ?? 0) + 1
  }
  let windowProtection
  current = {
    rootId: key,
    file,
    windowFenceFacts: () => {
      const state = readWindowSnapshot(file,windowProtection)
      return { kind: 'control-plane-file-lock-v1', rootId: key, file,
        domains: ['authority', 'lease', 'plan'], binding: { revision: state.revision, snapshotHash: hash(state) },
        externalWriters: ['out-of-process file replacement'], fileProtection: windowFileProtectionFacts() }
    },
    acquireWindowFence: (expected, options = {}) => queue(serviceKey, async () => {
      if (options.isolated !== true || !options.sessionId) throw new Error('WINDOW_EXACT_ISOLATED_OPT_IN_REQUIRED')
      await flushPending()
      const lock = await acquireFileLock(file)
      let released = false
      let protection
      const assertHeld = binding => {
        if (released) throw new Error('WINDOW_CONTROL_STALE_FENCE')
        lock.assertOwner()
        protection?.assertHeld()
        const state = readWindowSnapshot(file,protection)
        if (hash({ revision: state.revision, snapshotHash: hash(state) }) !== hash(binding)) throw new Error('WINDOW_CONTROL_CAS_CONFLICT')
        return true
      }
      try {
        assertHeld(expected)
        if(options.protectFiles===true) {
          protection=acquireWindowFileProtection([file])
          protectWindowReferences(file,protection,options.sourceFiles)
          assertHeld(expected)
          windowProtection=protection
        }
      } catch (error) { try{await protection?.release()}finally{await lock.release()} throw error }
      return Object.freeze({ kind: 'control-plane-file-lock-v1', rootId: key, file, sessionId: options.sessionId,
        assertHeld, fileProtection:protection?.receipt ?? null,
        async release() { if (released) throw new Error('WINDOW_CONTROL_STALE_FENCE'); released = true; windowProtection=undefined; try{await protection?.release()}finally{await lock.release()} } })
    }),
    get: () => load(key, config, { history: false, clone: false }),
    reload: () => load(key, config, { history: false, clone: false }),
    flush,
    checkpoint: flush,
    gc: async (options = {}) => {
      await flush()
      return gcControlPlaneStorage(file, { ...storageOptions, ...options })
    },
    storageHealth: (options = {}) => inspectControlPlaneStorage(file, { ...storageOptions, ...options }),
    // Hot reads are the common case. Callers that need hydrated room/wake
    // transcripts must opt in with `{ history: true }`.
    snapshot: ({ history = false, copy = true } = {}) => load(key, config, { history, clone: copy }),
    // Window authority consumes only durable canonical sources, never the
    // UI panel-cache overlay or a stale hot/history/cold cache fallback.
    windowSnapshot: () => normalizeState(key,readWindowSnapshot(file,windowProtection)),
    view: ({ history = false } = {}) => load(key, config, { history, clone: false }),
    activityDigestRecord: (input) => commit('activity/digest-delivered', input, undefined, (s) => {
      if (s.activityDigest?.factsHash === input.factsHash) return noChange(s.activityDigest)
      s.activityDigest = { factsHash: input.factsHash, sequence: Number(s.activityDigest?.sequence ?? 0) + 1, deliveredAt: now() }
      return { ...s.activityDigest }
    }, { history: false }),
    messageOperationGet: (operationKey) => cloneValue(load(key, config, { history: false, clone: false }).messageOperations?.[String(operationKey)]),
    messageOperationRecover: (input, agent) => commit('message/operation-recovered', { key: input.key, recovery: input.recovery }, agent, (s) => {
      const row = s.messageOperations?.[input.key]
      if (!row || row.sender !== input.sender || row.operationId !== input.operationId || row.payloadHash !== input.payloadHash) throw new Error('message-operation-conflict: recovery must name the exact sender operation and payload')
      const expected = input.recovery?.expected_revision
      const reason = String(input.recovery?.reason ?? '').trim()
      if (!Number.isSafeInteger(expected) || expected !== Number(row.revision)) throw new Error('message-operation-revision-conflict: current revision=' + row.revision)
      if (!reason) throw new Error('message-operation-recovery-reason: an explicit recovery reason is required')
      if (row.status === 'completed') return noChange(cloneValue(row))
      if (row.ownerPid && row.ownerPid !== process.pid) {
        let alive = true
        try { process.kill(row.ownerPid, 0) } catch (error) { alive = error?.code !== 'ESRCH' }
        if (alive) throw new Error('message-operation-inflight: original process still exists; recovery is refused')
      }
      const dispatch = row.receipt?.dispatchId ? s.dispatches?.[row.receipt.dispatchId] : undefined
      const confirmed = dispatch && dispatch.sender === row.sender && dispatch.target === row.target && (row.taskId === null || String(dispatch.taskId) === String(row.taskId)) && ['delivered', 'completed'].includes(dispatch.status)
      if (confirmed) {
        row.receipt = { ...row.receipt, externalAttempted: false, externalConfirmed: true, status: 'delivered' }
        row.status = 'completed'
      } else if (row.receipt?.externalAttempted === true) throw new Error('message-operation-recovery-unconfirmed: external outcome has no confirmed matching dispatch receipt; existing receipt=' + JSON.stringify(row.receipt))
      else row.status = 'partial-failed'
      row.recovery = { reason, at: now(), actor: String(agent?.id ?? ''), fromRevision: expected }
      row.ownerPid = process.pid
      row.revision = Number(row.revision) + 1
      row.updatedAt = now()
      return cloneValue(row)
    }, { history: false }),
    messageOperationBegin: (input, agent) => commit('message/operation-reserved', input, agent, (s) => {
      s.messageOperations ??= {}
      const prior = Object.values(s.messageOperations).find((row) => row.sender === input.sender && row.operationId === input.operationId)
      if (prior !== undefined) {
        if (prior.key !== input.key || prior.payloadHash !== input.payloadHash) {
          const error = new Error('message-operation-conflict: operation_id already binds a different payload or delivery scope; existing receipt=' + JSON.stringify(prior.receipt))
          error.receipt = cloneValue(prior.receipt)
          throw error
        }
        if (prior.status === 'partial-failed' && prior.receipt?.externalAttempted !== true) {
          prior.status = 'reserved'
          prior.ownerPid = process.pid
          prior.revision = Number(prior.revision ?? 0) + 1
          prior.updatedAt = now()
          return { claimed: true, operation: cloneValue(prior), resumed: true }
        }
        return noChange({ claimed: false, operation: cloneValue(prior) })
      }
      if (input.taskSnapshot !== undefined) {
        const task = Object.values(s.boards ?? {}).map((board) => board.tasks?.[input.taskSnapshot.taskId]).find(Boolean)
        if (!task || Number(task.revision) !== input.taskSnapshot.revision || String(task.phase ?? '') !== input.taskSnapshot.phase) throw new Error('instruction-stale: task advanced before operation reservation')
      }
      const operation = { ...input, status: 'reserved', ownerPid: process.pid, revision: 1, createdAt: now(), updatedAt: now(), receipt: input.receipt }
      s.messageOperations[input.key] = operation
      return { claimed: true, operation: cloneValue(operation) }
    }, { history: false }),
    messageOperationUpdate: (input, agent) => commit('message/operation-checkpoint', input, agent, (s) => {
      const row = s.messageOperations?.[input.key]
      if (!row || row.payloadHash !== input.payloadHash) throw new Error('message-operation-conflict: missing or changed reservation')
      row.receipt = { ...row.receipt, ...input.receipt }
      row.status = input.status ?? 'partial'
      row.revision = Number(row.revision ?? 0) + 1
      row.updatedAt = now()
      return cloneValue(row)
    }, { history: false }),
    // Hydrate only one Room's cold transcript. Room recovery is scoped to a
    // single room, so paying for every historical room (and every cold blob)
    // is unnecessary and can add seconds to a routine room snapshot.
    roomSnapshot: (roomId) => {
      const state = load(key, config, { history: false, clone: false })
      const refs = state.coldHistory
      const roomKey = String(roomId ?? '')
      const room = state.rooms?.[roomKey]
      if (room === undefined || refs?.version !== 1 || refs.rooms?.[roomKey] === undefined) return state
      const messages = readRoomHistory(file, refs.rooms[roomKey])
      const next = {
        ...state,
        rooms: {
          ...(state.rooms ?? {}),
          [roomKey]: { ...room, messages },
        },
      }
      const transcriptRef = refs.transcripts?.[roomKey]
      if (transcriptRef !== undefined) {
        const transcripts = readRoomHistory(file, transcriptRef)
        next.v12RoomWake = {
          ...(state.v12RoomWake ?? {}),
          transcripts: {
            ...(state.v12RoomWake?.transcripts ?? {}),
            [roomKey]: transcripts,
          },
        }
      }
      return next
    },
    mutate,
    mutateHot,
    mutateRoomAppend,
    roomOpen: (input, agent) => mutateHot('room/open', input, agent, (s) => {
      const roomId = String(input.roomId || id('room'))
      if (s.rooms[roomId] !== undefined) {
        const current = s.rooms[roomId]
        let changed = false
        if (input.kind !== undefined && String(input.kind) !== current.kind) {
          throw new Error('room "' + roomId + '" already exists with kind "' + current.kind + '"')
        }
        if (Array.isArray(input.dependsOnRooms)) {
          current.dependsOnRooms = [...new Set([
            ...(Array.isArray(current.dependsOnRooms) ? current.dependsOnRooms : []),
            ...input.dependsOnRooms.map(String).filter((value) => value.length > 0),
          ])]
          current.revision += 1
          changed = true
        }
        if (input.replaceHost === true && input.host) {
          const nextHost = String(input.host)
          if (!current.members.includes(nextHost)) current.members.push(nextHost)
          current.host = nextHost
          current.revision += 1
          changed = true
        }
        // Reopening repairs legacy rooms created by builds that omitted host.
        // A real host is never overwritten by a later caller.
        if (input.replaceHost !== true && (current.host === null || current.host === undefined || current.host === '') && input.host) {
          current.host = String(input.host)
          current.revision += 1
          changed = true
        }
        return changed ? current : noChange(current)
      }
      const room = {
        roomId,
        kind: String(input.kind || 'task'),
        title: String(input.title || roomId),
        host: input.host ?? null,
        members: Array.isArray(input.members) ? [...new Set(input.members.map(String))] : [],
        status: 'open',
        createdAt: now(),
        revision: 1,
        currentRoundId: null,
        messages: [],
        decisions: [],
        unresolved: [],
        dependsOnRooms: Array.isArray(input.dependsOnRooms)
          ? [...new Set(input.dependsOnRooms.map(String).filter((value) => value.length > 0))]
          : [],
        summary: '',
        latestRoundId: null,
        latestSummary: null,
        lastMessageAt: now(),
      }
      s.rooms[roomId] = room
      return room
    }),
    roomJoin: (roomId, member, agent) => mutateHot('room/member-added', { roomId, member }, agent, (s) => {
      const room = s.rooms[roomId]
      if (room === undefined) throw new Error('unknown room "' + roomId + '"')
      if (room.status !== 'open') throw new Error('room "' + roomId + '" is closed')
      if (room.members.includes(member)) return noChange(room)
      room.members.push(member)
      room.revision += 1
      return room
    }),
    roomPost: (input, agent) => mutateRoomAppend('room/message', input, agent, (s) => {
      const room = s.rooms[input.roomId]
      if (room === undefined) throw new Error('unknown room "' + input.roomId + '"')
      if (room.status !== 'open') throw new Error('room "' + input.roomId + '" is closed')
      const roundId = input.roundId ?? room.currentRoundId
      if (roundId === null || roundId === undefined) throw new Error('room "' + input.roomId + '" has no active round')
      const round = s.rounds[roundId]
      if (round === undefined || round.status !== 'open') throw new Error('round "' + roundId + '" is not open')
      if (!room.members.includes(input.author)) throw new Error('member "' + input.author + '" has not joined room "' + input.roomId + '"')
      const content = String(input.content || '').trim()
      if (content.length === 0) throw new Error('room messages cannot be empty')
      const kind = String(input.kind || 'fact')
      const clarification = kind === 'clarification'
      if (clarification) {
        if (!round.mainSpoken.includes(input.author)) {
          throw new Error('member "' + input.author + '" must make its main speech before a clarification')
        }
        if (round.clarified.includes(input.author)) {
          throw new Error('member "' + input.author + '" already used its one clarification in round "' + roundId + '"')
        }
        if (content.length > Number(input.clarificationMaxLength || 800)) {
          throw new Error('room clarification exceeds the configured length limit')
        }
      } else {
        if (round.mainSpoken.includes(input.author)) {
          throw new Error('member "' + input.author + '" already used its one main speech in round "' + roundId + '"')
        }
        if (round.nextSpeaker !== null && s.frozenMembers?.[round.nextSpeaker]?.frozen === true) {
          round.nextSpeaker = nextEligibleSpeaker(s, round, round.order.indexOf(round.nextSpeaker))
        }
        if (round.nextSpeaker !== input.author) {
          throw new Error('round "' + roundId + '" expects "' + round.nextSpeaker + '" to speak next')
        }
      }
      if (content.length > Number(input.maxLength || 4000)) throw new Error('room message exceeds the configured length limit')
      const message = {
        messageId: id('msg'),
        roomId: input.roomId,
        roundId,
        author: input.author,
        kind,
        content,
        references: Array.isArray(input.references) ? input.references.map(String) : [],
        replyTo: input.replyTo ?? null,
        turn: !clarification,
        createdAt: now(),
      }
      room.lastMessageAt = message.createdAt
      if (clarification) {
        round.clarified.push(input.author)
      } else {
        round.spoken.push(input.author)
        round.mainSpoken.push(input.author)
        const index = round.order.indexOf(input.author)
        round.nextSpeaker = nextEligibleSpeaker(s, round, index + 1)
      }
      round.revision += 1
      room.revision += 1
      return message
    }, input.roomId),
    roomNotice: (input, agent) => mutateRoomAppend('room/notice', input, agent, (s) => {
      const room = s.rooms[input.roomId]
      if (room === undefined) throw new Error('unknown room "' + input.roomId + '"')
      if (room.status !== 'open') throw new Error('room "' + input.roomId + '" is closed')
      if (!room.members.includes(input.author)) throw new Error('member "' + input.author + '" has not joined room "' + input.roomId + '"')
      const content = String(input.content || '').trim()
      if (content.length === 0) throw new Error('room notices cannot be empty')
      if (content.length > Number(input.maxLength || 4000)) throw new Error('room notice exceeds the configured length limit')
      const message = {
        messageId: id('msg'),
        roomId: input.roomId,
        roundId: input.roundId ?? room.currentRoundId ?? null,
        author: input.author,
        kind: 'notice',
        content,
        references: Array.isArray(input.references) ? input.references.map(String) : [],
        replyTo: input.replyTo ?? null,
        turn: false,
        createdAt: now(),
      }
      if (input.messageOperationKey !== undefined) {
        const operation = s.messageOperations?.[input.messageOperationKey]
        if (!operation) throw new Error('message operation reservation missing')
        operation.receipt = { ...operation.receipt, messageId: message.messageId, roomId: message.roomId,
          ...(message.roundId === null ? {} : { roundId: message.roundId }) }
        operation.status = 'notice-recorded'
        operation.revision = Number(operation.revision ?? 0) + 1
      }
      room.lastMessageAt = message.createdAt
      room.revision += 1
      return message
    }, input.roomId),
    roomNext: (input, agent) => mutateHot('room/round-start', input, agent, (s) => {
      const room = s.rooms[input.roomId]
      if (room === undefined) throw new Error('unknown room "' + input.roomId + '"')
      if (room.status !== 'open') throw new Error('room "' + input.roomId + '" is closed')
      const dependency = roomDependencyVerdict(s, room)
      if (!dependency.ok) {
        throw new Error('room dependency: room "' + room.roomId + '" cannot start a round because '
          + dependency.reason + '; wait for the parent round to close')
      }
      if (room.currentRoundId !== null) {
        const current = s.rounds[room.currentRoundId]
        if (current?.status === 'open') throw new Error('room "' + room.roomId + '" already has open round "' + current.roundId + '"')
      }
      const maxRoomRounds = Number.isFinite(Number(config.maxRoomRounds)) && Number(config.maxRoomRounds) > 0
        ? Math.floor(Number(config.maxRoomRounds))
        : DEFAULT_MAX_ROOM_ROUNDS
      const roundsUsed = Object.values(s.rounds).filter((row) => row?.roomId === room.roomId).length
      if (roundsUsed >= maxRoomRounds) {
        throw new Error('room round budget: room "' + room.roomId + '" has used ' + String(roundsUsed)
          + '/' + String(maxRoomRounds) + ' rounds; record unresolved items and escalate instead of reopening it')
      }
      const members = Array.isArray(input.members) && input.members.length > 0
        ? [...new Set(input.members.map(String))]
        : [...room.members]
      if (members.length === 0) throw new Error('round requires at least one member')
      const notJoined = members.find((member) => !room.members.includes(member))
      if (notJoined !== undefined) throw new Error('round member "' + notJoined + '" has not joined room "' + room.roomId + '"')
      const roundId = id('round')
      const nextSpeaker = nextEligibleSpeaker(s, { order: members, mainSpoken: [] })
      const round = {
        roundId,
        roomId: input.roomId,
        topic: String(input.topic || ''),
        order: members,
        spoken: [],
        mainSpoken: [],
        clarified: [],
        queuedCount: 0,
        nextSpeaker,
        status: 'open',
        revision: 1,
        openedAt: now(),
        closedAt: null,
      }
      s.rounds[roundId] = round
      room.currentRoundId = roundId
      room.revision += 1
      return round
    }),
    roomClose: (input, agent) => mutateHot('room/round-close', input, agent, (s) => {
      const room = s.rooms[input.roomId]
      const round = s.rounds[input.roundId || room?.currentRoundId]
      if (room === undefined || round === undefined) throw new Error('unknown room or round')
      if (round.roomId !== room.roomId) throw new Error('round "' + round.roundId + '" does not belong to room "' + room.roomId + '"')
      if (round.status !== 'open') throw new Error('round "' + round.roundId + '" is not open')
      const summary = String(input.summary || '').trim()
      if (summary.length === 0) throw new Error('room round close requires a summary')
        const missingSpeakers = round.order.filter((member) => !round.mainSpoken.includes(member))
        if (missingSpeakers.length > 0) {
          const waivedMembers = Array.isArray(input.waivedMembers) ? [...new Set(input.waivedMembers.map(String))] : []
          // The tool layer supplies the members it has proven ineligible (frozen
          // or impossible to seat in this room kind). Default stays frozen-only
          // so other callers cannot widen the waiver on their own.
          const waivableMembers = Array.isArray(input.waivableMembers)
            ? [...new Set(input.waivableMembers.map(String))]
            : missingSpeakers.filter((member) => s.frozenMembers?.[member]?.frozen === true)
          const forceCloseReason = String(input.forceCloseReason || '').trim()
          const unwaived = missingSpeakers.filter((member) => !waivedMembers.includes(member))
          const invalidWaivers = waivedMembers.filter((member) => !missingSpeakers.includes(member)
            || !waivableMembers.includes(member))
          if (input.forceClose !== true || forceCloseReason.length === 0) {
            throw new Error('round "' + round.roundId + '" cannot close before every participant has made one main speech; missing: '
              + missingSpeakers.join(', ')
              + '. Tier 0 may retry with forceClose:true, waivedMembers:[...] and forceCloseReason when every missing speaker is frozen or cannot be seated in this room.')
          }
          if (unwaived.length > 0) {
            throw new Error('forced room close cannot waive active participants; still missing: ' + unwaived.join(', '))
          }
          if (invalidWaivers.length > 0) {
            throw new Error('forced room close may waive only frozen or unseatable missing participants; invalid waivers: ' + invalidWaivers.join(', '))
          }
        round.waivedMembers = missingSpeakers
        round.forceClosedBy = String(input.forceClosedBy || agent?.name || '')
        round.forceCloseReason = forceCloseReason
        round.forceClosedAt = now()
      }
      round.status = 'closed'
      round.closedAt = now()
      round.summary = summary
      round.summaryAt = round.closedAt
      round.unresolved = normalizeUnresolvedList(
        Array.isArray(input.unresolved) ? input.unresolved : [],
        'unresolved-' + round.roundId,
      )
      round.revision += 1
      room.summary = summary
      room.unresolved = round.unresolved
      room.latestRoundId = round.roundId
      room.latestSummary = { roundId: round.roundId, text: summary, closedAt: round.closedAt }
      room.currentRoundId = null
      room.revision += 1
      return { room, round }
    }),
    roomResolveUnresolved: (input, agent) => mutateHot('room/unresolved-resolved', input, agent, (s) => {
      const room = s.rooms[input.roomId]
      if (room === undefined) throw new Error('unknown room "' + input.roomId + '"')
      const targetId = input.unresolvedId === undefined || input.unresolvedId === null
        ? ''
        : String(input.unresolvedId)
      const targetText = String(input.text || '').trim()
      if (targetId.length === 0 && targetText.length === 0) {
        throw new Error('resolving an unresolved item requires unresolvedId or text')
      }
      const resolution = String(input.resolution || '').trim()
      if (resolution.length === 0) throw new Error('resolving an unresolved item requires a resolution')
      let resolved
      const resolveList = (list, prefix) => normalizeUnresolvedList(list, prefix).map((item) => {
        const normalizedItemText = String(item.text ?? '').replace(/\s+/g, ' ').trim()
        const normalizedTargetText = targetText.replace(/\s+/g, ' ').trim()
        const matches = targetId.length > 0
          ? item.id === targetId
          : normalizedItemText === normalizedTargetText
        if (!matches) return item
        const next = {
          ...item,
          status: 'resolved',
          resolvedAt: now(),
          resolvedBy: String(input.resolvedBy || agent?.name || ''),
          resolution,
        }
        if (resolved === undefined) resolved = next
        return next
      })
      room.unresolved = resolveList(room.unresolved, 'unresolved-' + room.roomId)
      for (const round of Object.values(s.rounds)) {
        if (round?.roomId !== room.roomId) continue
        round.unresolved = resolveList(round.unresolved, 'unresolved-' + round.roundId)
      }
      if (resolved === undefined) {
        const available = normalizeUnresolvedList(room.unresolved, 'unresolved-' + room.roomId)
          .filter((item) => item.status !== 'resolved')
          .map((item) => item.id + ' :: ' + String(item.text ?? '').slice(0, 160))
        throw new Error('unknown unresolved item "' + (targetId || targetText) + '" in room "' + room.roomId
          + '"' + (available.length === 0 ? '; no open unresolved items remain' : '; available: ' + available.join(' | ')))
      }
      room.revision += 1
      return { room, item: resolved }
    }),
    roomDecision: (input, agent) => mutateHot('room/decision', input, agent, (s) => {
      const room = s.rooms[input.roomId]
      if (room === undefined) throw new Error('unknown room "' + input.roomId + '"')
      if (room.status !== 'open') throw new Error('room "' + room.roomId + '" is closed')
      if (input.roundId !== undefined && input.roundId !== null) {
        const round = s.rounds[String(input.roundId)]
        if (round === undefined || round.roomId !== room.roomId) {
          throw new Error('round "' + input.roundId + '" does not belong to room "' + room.roomId + '"')
        }
      }
      const requiredConfirmations = [...new Set((Array.isArray(input.requiredConfirmations)
        ? input.requiredConfirmations
        : Array.isArray(input.required_confirmations) ? input.required_confirmations : [])
        .map((value) => String(value || '').trim()).filter(Boolean))]
      const confirmations = (Array.isArray(input.confirmations) ? input.confirmations : [])
        .map((row) => typeof row === 'string'
          ? { member: String(row), at: now(), rationale: '', evidenceLinks: [] }
          : {
              member: String(row?.member ?? row?.confirmedBy ?? row?.by ?? '').trim(),
              at: Number(row?.at ?? row?.confirmedAt ?? now()),
              rationale: String(row?.rationale ?? ''),
              evidenceLinks: Array.isArray(row?.evidenceLinks) ? row.evidenceLinks.map(String) : [],
            })
        .filter((row) => row.member.length > 0)
      const decidedBy = String(input.decidedBy ?? '').trim()
      if (requiredConfirmations.length === 1 && confirmations.length === 0 && decidedBy.length > 0) {
        confirmations.push({ member: decidedBy, at: now(), rationale: String(input.rationale ?? ''), evidenceLinks: [] })
      }
      const missingConfirmations = requiredConfirmations
        .filter((member) => !confirmations.some((row) => row.member === member))
      const fullyConfirmed = requiredConfirmations.length <= 1 || missingConfirmations.length === 0
      const decision = {
        decisionId: id('decision'),
        roomId: input.roomId,
        roundId: input.roundId ?? null,
        status: fullyConfirmed ? 'confirmed' : 'proposed',
        title: String(input.title || ''),
        choice: String(input.choice || ''),
        rationale: String(input.rationale || ''),
        references: Array.isArray(input.references) ? input.references.map(String) : [],
        decidedBy: input.decidedBy ?? null,
        requiredConfirmations,
        confirmations,
        missingConfirmations,
        confirmedBy: fullyConfirmed ? String(confirmations[0]?.member ?? decidedBy ?? '') || null : null,
        confirmedAt: fullyConfirmed ? now() : null,
        createdAt: now(),
      }
      room.decisions.push(decision)
      room.revision += 1
      return decision
    }),
    roomDecisionConfirm: (input, agent) => mutateHot('room/decision-confirm', input, agent, (s) => {
      const room = s.rooms[input.roomId]
      if (room === undefined) throw new Error('unknown room "' + input.roomId + '"')
      const decision = (Array.isArray(room.decisions) ? room.decisions : [])
        .find((row) => String(row?.decisionId) === String(input.decisionId))
      if (decision === undefined) throw new Error('unknown decision "' + input.decisionId + '" in room "' + room.roomId + '"')
      if (decision.status === 'confirmed') return decision
      if (['superseded', 'revoked'].includes(String(decision.status))) throw new Error('decision "' + decision.decisionId + '" is ' + decision.status)
      const member = String(input.confirmedBy ?? input.member ?? input.by ?? '').trim()
      if (member.length === 0) throw new Error('confirmedBy is required')
      const requiredConfirmations = [...new Set((Array.isArray(decision.requiredConfirmations) ? decision.requiredConfirmations : [])
        .map((value) => String(value || '').trim()).filter(Boolean))]
      if (requiredConfirmations.length > 1 && !requiredConfirmations.includes(member)) {
        throw new Error('member "' + member + '" is not a required confirmer for decision "' + decision.decisionId + '"')
      }
      const confirmations = Array.isArray(decision.confirmations) ? [...decision.confirmations] : []
      const prior = confirmations.find((row) => String(row?.member) === member)
      if (prior === undefined) confirmations.push({
        member,
        at: Number(input.confirmedAt ?? now()),
        rationale: String(input.rationale ?? ''),
        evidenceLinks: Array.isArray(input.evidenceLinks) ? input.evidenceLinks.map(String) : [],
      })
      const missingConfirmations = requiredConfirmations
        .filter((required) => !confirmations.some((row) => String(row?.member) === required))
      const fullyConfirmed = requiredConfirmations.length <= 1 || missingConfirmations.length === 0
      Object.assign(decision, {
        status: fullyConfirmed ? 'confirmed' : 'proposed',
        confirmations,
        missingConfirmations,
        confirmedBy: fullyConfirmed ? String(confirmations[0]?.member ?? member) : null,
        confirmedAt: fullyConfirmed ? Number(input.confirmedAt ?? now()) : null,
        revision: Number(decision.revision ?? 0) + 1,
        updatedAt: now(),
      })
      room.revision += 1
      return decision
    }),
    planPropose: (input, agent) => mutate('plan/proposed', input, agent, (s) => {
      const taskId = String(input.taskId)
      const plan = {
        taskId,
        state: 'plan-proposed',
        revision: 1,
        requirementId: String(input.requirementId || taskId),
        goal: String(input.goal || ''),
        members: Array.isArray(input.members) ? input.members.map(String) : [],
        writeScopes: Array.isArray(input.writeScopes) ? input.writeScopes.map(String) : [],
        dependencies: Array.isArray(input.dependencies) ? input.dependencies.map(String) : [],
        options: Array.isArray(input.options) ? input.options : [],
        selectedOption: input.selectedOption ?? null,
        checks: input.checks && typeof input.checks === 'object' ? structuredClone(input.checks) : {},
        risks: Array.isArray(input.risks) ? input.risks : [],
        rollback: String(input.rollback || ''),
        proposedBy: String(input.proposedBy || ''),
        approvedBy: null,
        approvedAt: null,
        replacedState: null,
        replaceReason: null,
        createdAt: now(),
        updatedAt: now(),
      }
      const hasWriteScopes = Array.isArray(input.writeScopes)
      if (!plan.goal || plan.members.length === 0 || !hasWriteScopes
        || Object.keys(plan.checks).length === 0 || !plan.rollback) {
        throw new Error('plan requires goal, members, writeScopes, checks and rollback')
      }
      const globScope = plan.writeScopes.find((scope) => /[*?\[\]]/.test(String(scope)))
      if (globScope !== undefined) {
        throw new Error('[plan-scope-glob-unsupported] write scope "' + globScope
          + '" contains glob syntax, but write scopes are literal path prefixes; declare a directory prefix such as "docs/groups/rig" instead')
      }
      // A proposed plan is still review material. Re-proposing before approval
      // replaces it in place. After approval, replacement requires an explicit
      // replaceApproved flag and is forbidden while the task holds an active lease.
      const prior = s.plans[taskId]
      const explicitReplacement = input.replaceApproved === true
      const replaceable = prior !== undefined && ['plan-approved', 'rejected', 'blocked'].includes(prior.state)
      if (prior !== undefined && prior.state !== 'plan-proposed' && !(explicitReplacement && replaceable)) {
        throw new Error('plan "' + taskId + '" is already ' + prior.state
          + '; recovery: if the work can finish under the current scope, complete it while its lease is active, '
          + 'release the lease as completed, then call team_plan_propose with replace_approved:true and replace_reason. '
          + 'If the scope must change while work is in flight, release or cancel the active lease first, '
          + 'call team_plan_propose with replace_approved:true and replace_reason, then acquire the replacement lease before editing again')
      }
      if (explicitReplacement && replaceable) {
        const activeLease = Object.values(s.leases ?? {}).find((lease) =>
          String(lease?.taskId ?? '') === taskId && lease?.status === 'active')
        if (activeLease !== undefined) {
          throw new Error('plan "' + taskId + '" cannot be replaced while run lease "' + String(activeLease.runId)
            + '" is active. ' + PLAN_REPLACEMENT_RECOVERY)
        }
        const reason = String(input.replaceReason || '').trim()
        if (reason.length === 0) throw new Error('approved-plan replacement requires replaceReason')
        plan.revision = Number(prior.revision || 1) + 1
        plan.replacedState = prior.state
        plan.replaceReason = reason
      }
      if (prior !== undefined) plan.createdAt = prior.createdAt
      const linkedTask = Object.values(s.boards ?? {})
        .map((board) => board?.tasks?.[taskId])
        .find((task) => task !== undefined)
      if (linkedTask !== undefined) {
        const nextScopes = plan.writeScopes.map(String)
        const previousScopes = Array.isArray(linkedTask.writeScopes) ? linkedTask.writeScopes.map(String) : []
        const scopesChanged = JSON.stringify(previousScopes) !== JSON.stringify(nextScopes)
        if (scopesChanged) linkedTask.writeScopes = nextScopes
        linkedTask.workKind = 'edit'
        if (linkedTask.contract !== null && typeof linkedTask.contract === 'object' && !Array.isArray(linkedTask.contract)) {
          linkedTask.contract = {
            ...linkedTask.contract,
            writeScopes: nextScopes,
            contractRevision: Number(linkedTask.contract.contractRevision ?? 1) + 1,
          }
        }
        if (scopesChanged || linkedTask.contract !== undefined) {
          linkedTask.revision = Number(linkedTask.revision ?? 0) + 1
        }
      }
      s.plans[taskId] = plan
      return plan
    }),
    planApprove: (input, agent) => mutate('plan/approved', input, agent, (s) => {
      const plan = s.plans[input.taskId]
      if (plan === undefined) throw new Error('no plan exists for task "' + input.taskId + '"')
      if (plan.state !== 'plan-proposed') throw new Error('plan "' + input.taskId + '" is not awaiting approval')
      if (!input.approvedBy) throw new Error('plan approval requires approvedBy')
      plan.state = 'plan-approved'
      plan.approvedBy = String(input.approvedBy || '')
      plan.approvedAt = now()
      plan.updatedAt = now()
      const linkedTask = Object.values(s.boards ?? {})
        .map((board) => board?.tasks?.[input.taskId])
        .find((task) => task !== undefined)
      if (linkedTask !== undefined) {
        const nextScopes = plan.writeScopes.map(String)
        const previousScopes = Array.isArray(linkedTask.writeScopes) ? linkedTask.writeScopes.map(String) : []
        const scopesChanged = JSON.stringify(previousScopes) !== JSON.stringify(nextScopes)
        if (scopesChanged) linkedTask.writeScopes = nextScopes
        linkedTask.workKind = 'edit'
        if (linkedTask.contract !== null && typeof linkedTask.contract === 'object' && !Array.isArray(linkedTask.contract)) {
          linkedTask.contract = {
            ...linkedTask.contract,
            writeScopes: nextScopes,
            contractRevision: Number(linkedTask.contract.contractRevision ?? 1) + 1,
          }
        }
        if (scopesChanged || linkedTask.contract !== undefined) {
          linkedTask.revision = Number(linkedTask.revision ?? 0) + 1
        }
      }
      return plan
    }),
    planRemove: (input, agent) => mutate('plan/removed', input, agent, (s) => {
      const taskId = String(input.taskId)
      const prior = s.plans[taskId]
      if (prior === undefined) return undefined
      delete s.plans[taskId]
      return prior
    }),
    planState: (taskId) => cloneValue(load(key, config, { history: false, clone: false }).plans[String(taskId)]),
    planList: () => cloneRows(Object.values(load(key, config, { history: false, clone: false }).plans)),
    planRequireApproved: (taskId) => {
      const plan = load(key, config, { history: false, clone: false }).plans[String(taskId)]
      if (plan === undefined || plan.state !== 'plan-approved') {
        throw new Error('task "' + taskId + '" requires a plan-approved record before execution; current plan state: '
          + (plan === undefined ? 'missing' : String(plan.state)))
      }
      return cloneValue(plan)
    },
    boardCreate: (input, agent) => mutate('board/task-created', input, agent, (s) => {
      const boardId = String(input.boardId || 'global')
      const board = s.boards[boardId] ?? { boardId, seq: 0, tasks: {} }
      board.seq += 1
      const taskId = String(input.taskId || boardId + '-t' + board.seq)
      if (board.tasks[taskId] !== undefined) return board.tasks[taskId]
      const blockedBy = Array.isArray(input.blockedBy) ? input.blockedBy.map(String) : []
      const dependencyPhase = String(input.dependencyPhase ?? 'accepted')
      const candidateBoards = {
        ...s.boards,
        [boardId]: {
          ...(s.boards[boardId] ?? { boardId, tasks: {} }),
          tasks: {
            ...(s.boards[boardId]?.tasks ?? {}),
            [taskId]: { id: taskId, board: boardId, blockedBy },
          },
        },
      }
      const cycle = dependencyCycle(candidateBoards, boardId, taskId, blockedBy)
      if (cycle !== null) {
        throw new Error('task dependency cycle includes ' + cycle.map((key) => key.replace('\u0000', ':')).join(' -> '))
      }
      const ownerName = typeof input.ownerName === 'string' && input.ownerName.trim().length > 0
        ? input.ownerName.trim()
        : undefined
      const ready = taskDependenciesSatisfied(s.boards, boardId, blockedBy, dependencyPhase)
      const task = {
        id: taskId,
        revision: 1,
        subject: String(input.subject || ''),
        description: String(input.description || ''),
        status: ownerName === undefined || !ready ? 'pending' : 'in_progress',
        phase: TASK_PHASES.includes(input.phase) ? input.phase : 'draft',
        blockedBy,
        dependencyPhase,
        writeScopes: Array.isArray(input.writeScopes) ? input.writeScopes.map(String) : [],
        worktreePath: typeof input.worktreePath === 'string' ? input.worktreePath : null,
        workKind: ['discussion', 'review', 'edit'].includes(input.workKind) ? input.workKind : undefined,
        commitSha: input.commitSha ?? null,
        evidenceIds: Array.isArray(input.evidenceIds) ? input.evidenceIds.map(String) : [],
        ready,
        writeScopeWarnings: Array.isArray(input.writeScopeWarnings) ? input.writeScopeWarnings.map(String) : [],
        board: boardId,
        createdAt: now(),
        updatedAt: now(),
      }
      if (ownerName !== undefined) task.ownerName = ownerName
      if (task.workKind === undefined) delete task.workKind
      board.tasks[taskId] = task
      s.boards[boardId] = board
      return task
    }),
    boardList: (boardId) => {
      const board = load(key, config, { history: false, clone: false }).boards[String(boardId || 'global')]
      return board === undefined ? [] : cloneRows(Object.values(board.tasks).filter((task) => task.status !== 'deleted'))
    },
    boardGet: (boardId, taskId) => {
      const board = load(key, config, { history: false, clone: false }).boards[String(boardId || 'global')]
      return cloneValue(board?.tasks?.[String(taskId)])
    },
    boardSnapshot: () => structuredClone(load(key, config, { history: false, clone: false }).boards),
    boardUpdate: (input, agent) => mutate('board/task-updated', input, agent, (s) => {
      const board = s.boards[String(input.boardId || 'global')]
      const task = board?.tasks?.[String(input.taskId)]
      if (task === undefined) throw new Error('unknown task "' + input.taskId + '" on board "' + input.boardId + '"')
      if (task.revision !== input.expectedRevision) {
        throw new Error('stale revision for "' + input.taskId + '": expected ' + input.expectedRevision + ', current ' + task.revision)
      }
      switch (input.action) {
        case 'claim':
          if (task.ownerName !== undefined && task.ownerName !== input.actorName) throw new Error('"' + input.taskId + '" is already owned by ' + task.ownerName)
          task.ownerName = input.actorName
          task.status = 'in_progress'
          break
        case 'advance_phase': {
          const currentPhase = TASK_PHASES.includes(task.phase) ? task.phase : 'draft'
          const nextPhase = String(input.phase || '')
          if (!TASK_PHASES.includes(nextPhase)) throw new Error('unsupported task phase "' + nextPhase + '"')
          const directCompletedReadOnlyAccept = input.allowDirectAccept === true
            && nextPhase === 'accepted'
            && task.status === 'completed'
            && ['discussion', 'review'].includes(task.workKind)
          if (!canAdvanceTaskPhase(currentPhase, nextPhase) && !directCompletedReadOnlyAccept) {
            const allowed = allowedTaskPhaseTransitions(currentPhase)
            const recovery = taskPhaseRecoveryActions(currentPhase)
            throw new Error('invalid task phase transition "' + currentPhase + '" -> "' + nextPhase + '"'
              + '; allowed next phases: ' + (allowed.length > 0 ? allowed.join(', ') : '(none)')
              + (recovery.length > 0 ? '; recovery action: ' + recovery.join(', ') : ''))
          }
          task.phase = nextPhase
          break
        }
        case 'recover_phase': {
          const recoveredPhase = String(input.phase || '')
          if (!TASK_PHASES.includes(recoveredPhase)) throw new Error('unsupported task phase "' + recoveredPhase + '"')
          task.phase = recoveredPhase
          break
        }
        case 'release':
          {
            if (task.status === 'deleted') {
              throw new Error('cannot release deleted task "' + input.taskId
                + '"; deletion already releases its write-scope occupancy, and release must not resurrect it')
            }
            const boardId = String(input.boardId || 'global')
            const group = String(input.actorGroup || '')
            const activeLease = Object.values(s.leases ?? {}).some((lease) =>
              String(lease?.taskId ?? '') === String(input.taskId) && lease?.status === 'active')
            const leadRecovery = Number(input.actorTier) === 1
              && group.length > 0
              && boardId === 'group-' + group
              && activeLease !== true
            if (task.ownerName !== input.actorName && !leadRecovery) {
              throw new Error('only the owner may release "' + input.taskId
                + '"; a group lead may release an inactive task on its own group board only when no active lease exists')
            }
          }
          delete task.ownerName
          task.status = 'pending'
          break
        case 'complete':
          if (task.ownerName !== undefined && task.ownerName !== input.actorName
            && !(String(input.boardId || 'global') === 'global' && Number(input.actorTier) === 0)) {
            throw new Error('only the owner may complete "' + input.taskId + '"')
          }
          task.ownerName = task.ownerName ?? input.actorName
          task.status = 'completed'
          if (task.phase === 'execution') task.phase = 'member-check'
          if (input.commitSha !== undefined) task.commitSha = storedCommitSha(input.commitSha)
          if (input.evidenceIds !== undefined) task.evidenceIds = mergeEvidenceIds(task.evidenceIds, input.evidenceIds)
          break
        case 'bind_fix':
          if (task.status !== 'completed') {
            throw new Error('bind_fix requires completed task "' + input.taskId + '"; current status is ' + String(task.status))
          }
          if (String(input.bindFixReason || '').trim().length === 0) {
            throw new Error('bind_fix requires bindFixReason')
          }
          if (!Object.prototype.hasOwnProperty.call(input, 'commitSha')) {
            throw new Error('bind_fix requires commitSha (pass null when the completed card has no commit)')
          }
          const commitSha = storedCommitSha(input.commitSha)
          if (!Array.isArray(input.evidenceIds) || input.evidenceIds.length === 0) {
            throw new Error('bind_fix requires evidenceIds')
          }
          // A binding repair changes only the ledger pointers. It deliberately
          // preserves status, phase, owner and readiness.
          task.commitSha = commitSha
          task.evidenceIds = input.evidenceMode === 'replace'
            ? [...new Set(input.evidenceIds.map(String).filter((value) => value.length > 0))]
            : mergeEvidenceIds(task.evidenceIds, input.evidenceIds)
          break
        case 'reconcile_complete':
          // The shipped Team domain is authoritative for task lifecycle. When
          // its completion committed but the local projection write failed,
          // mirror that durable result without replaying the owner-only
          // transition or fabricating a second completion.
          task.status = 'completed'
          if (input.ownerName !== undefined) task.ownerName = String(input.ownerName)
          if (task.phase === 'execution') task.phase = 'member-check'
          if (input.commitSha !== undefined) task.commitSha = storedCommitSha(input.commitSha)
          if (input.evidenceIds !== undefined) task.evidenceIds = mergeEvidenceIds(task.evidenceIds, input.evidenceIds)
          break
        case 'reopen':
          task.status = 'pending'
          if (typeof input.reopenReason === 'string' && input.reopenReason.trim().length > 0) {
            task.lastReopenReason = input.reopenReason.trim()
            task.lastReopenAt = now()
          }
          break
        case 'delete':
          {
            const dependents = taskDeleteDependents(s.boards, input.boardId, input.taskId)
            if (dependents.length > 0) {
              throw new Error('task-delete-dependents: task "' + input.taskId
                + '" is referenced by dependents: ' + [...new Set(dependents)].join(', '))
            }
          }
          task.status = 'deleted'
          if (typeof input.deleteReason === 'string' && input.deleteReason.trim().length > 0) {
            task.deletionReason = input.deleteReason.trim()
          }
          break
        case 'edit':
          if (input.writeScopes !== undefined) {
            const plan = s.plans?.[String(input.taskId)]
            const boardId = String(input.boardId || 'global')
            const actorGroup = String(input.actorGroup ?? '')
            const activeLease = Object.values(s.leases ?? {}).some((lease) =>
              lease?.status === 'active' && String(lease.taskId ?? '') === String(input.taskId))
            const scopes = Array.isArray(input.writeScopes) ? input.writeScopes.map(String) : []
            const recoveryAllowed = input.scopeEditRecovery === true
              && plan === undefined
              && Number(input.actorTier) === 1
              && actorGroup.length > 0
              && boardId === 'group-' + actorGroup
              && String(task.ownerName ?? '').trim().length > 0
              && !['completed', 'deleted'].includes(String(task.status ?? ''))
              && !activeLease
              && scopes.length > 0
              && scopes.every((scope) => scope.trim().length > 0)
            if (!recoveryAllowed) {
              throw new Error(input.scopeEditRecovery === true
                ? '[task-write-scopes-recovery-scope] task "' + input.taskId
                  + '" is not eligible for the inactive-owner scope recovery path'
                : 'task "' + input.taskId + '" writeScopes are controlled by its plan when one exists; '
                  + (plan === undefined
                    ? 'No plan exists yet: call team_plan_propose with the intended write_scopes.'
                    : 'replace the plan instead of editing the task row. Recovery: (1) finish the task and record exact commit_sha plus evidence, '
                      + '(2) call team_task_update(action:"complete") while the lease is active, '
                      + '(3) release the lease as completed, '
                      + '(4) call team_plan_propose with replace_approved:true and replace_reason, '
                      + '(5) acquire a new run lease before editing again.'))
            }
          }
          applyTaskEdit(task, input)
          break
        case 'set_dependencies':
          {
            const nextBlockedBy = Array.isArray(input.blockedBy) ? input.blockedBy.map(String) : []
            const cycle = dependencyCycle(
              s.boards,
              String(input.boardId || 'global'),
              task.id,
              nextBlockedBy,
            )
            if (cycle !== null) {
              throw new Error('task dependency cycle includes ' + cycle.map((key) => key.replace('\u0000', ':')).join(' -> '))
            }
            applyTaskDependencies(task, nextBlockedBy)
          }
          if (input.dependencyPhase !== undefined) task.dependencyPhase = String(input.dependencyPhase)
          task.ready = taskDependenciesSatisfied(
            s.boards,
            String(input.boardId || 'global'),
            task.blockedBy,
            task.dependencyPhase ?? 'accepted',
          )
          break
        case 'set_worktree':
          task.worktreePath = typeof input.worktreePath === 'string' && input.worktreePath.length > 0
            ? input.worktreePath
            : null
          break
        case 'reassign': {
          const previousOwner = typeof task.ownerName === 'string' ? task.ownerName : ''
          const nextOwner = input.owner === undefined || input.owner === null ? '' : String(input.owner)
          if (previousOwner && previousOwner !== nextOwner) {
            const tickets = s.v14Waiting?.tickets
            if (tickets && typeof tickets === 'object') {
              const closedAt = now()
              for (const ticket of Object.values(tickets)) {
                if (!ticket || String(ticket.taskId ?? '') !== String(input.taskId)
                  || String(ticket.owner ?? '') !== previousOwner
                  || String(ticket.status ?? 'open').toLowerCase() !== 'open') continue
                ticket.status = 'resolved'
                ticket.resolution = 'auto:reassigned'
                ticket.closedReason = 'reassigned'
                ticket.closedAt = closedAt
                ticket.closedBy = String(input.actorName || 'team-control-plane')
                ticket.updatedAt = closedAt
                if (nextOwner) ticket.reassignedTo = nextOwner
                else delete ticket.reassignedTo
              }
            }
          }
          if (input.owner === undefined || input.owner === null) delete task.ownerName
          else task.ownerName = String(input.owner)
          // A reassignment invalidates the previous owner's worktree binding.
          // The tool layer rebinds an edit task to the replacement owner.
          task.worktreePath = null
          task.status = input.owner === undefined || input.owner === null || task.ready === false
            ? 'pending'
            : 'in_progress'
          const plan = s.plans?.[String(input.taskId)]
          if (nextOwner && plan !== undefined && Array.isArray(plan.members) && !plan.members.includes(nextOwner)) {
            plan.members.push(nextOwner)
            plan.revision = Number(plan.revision || 1) + 1
            plan.updatedAt = now()
          }
          break
        }
        default:
          throw new Error('unsupported action "' + String(input.action) + '"')
      }
      task.updatedAt = now()
      task.revision += 1
      // Completing/reopening/deleting a dependency changes readiness for every
      // task that points at it. Recompute those rows in the same atomic
      // mutation so a later scheduler read cannot observe stale `ready=false`.
      if (['complete', 'reconcile_complete', 'reopen', 'delete'].includes(input.action)) {
        for (const [dependentBoardId, dependentBoard] of Object.entries(s.boards ?? {})) {
          for (const dependent of Object.values(dependentBoard?.tasks ?? {})) {
            if (dependent === task || !Array.isArray(dependent.blockedBy)) continue
            const dependsOnTask = dependent.blockedBy.some((reference) => {
              const resolved = resolveTaskDependency(s.boards, dependentBoardId, reference)
              return resolved.found
                && resolved.boardId === String(input.boardId || 'global')
                && resolved.taskId === task.id
            })
            if (!dependsOnTask) continue
            const ready = taskDependenciesSatisfied(
              s.boards,
              dependentBoardId,
              dependent.blockedBy,
              dependent.dependencyPhase ?? 'accepted',
            )
            if (dependent.ready !== ready) {
              dependent.ready = ready
              dependent.revision += 1
            }
          }
        }
      }
      return structuredClone(task)
    }),
    boardSetWorktree: (input, agent) => mutateHot('board/task-worktree', input, agent, (s) => {
      const taskId = String(input.taskId || '')
      const worktreePath = typeof input.worktreePath === 'string' && input.worktreePath.length > 0
        ? input.worktreePath
        : null
      for (const board of Object.values(s.boards ?? {})) {
        const task = board?.tasks?.[taskId]
        if (task === undefined) continue
        task.worktreePath = worktreePath
        task.updatedAt = now()
        task.revision += 1
        return structuredClone(task)
      }
      throw new Error('unknown task "' + taskId + '" while setting worktree')
    }),
  dispatchCreate: (input, agent) => mutateHot('dispatch/created', input, agent, (s) => {
    const dispatchId = String(input.dispatchId || id('dispatch'))
    if (s.dispatches[dispatchId] !== undefined) return s.dispatches[dispatchId]
    const requestedStatus = String(input.status || 'dispatch-created')
    const status = ['dispatch-created', 'queued', 'delivered', 'completed'].includes(requestedStatus)
      ? requestedStatus
      : 'dispatch-created'
    const row = {
        dispatchId,
        rootId: key,
        roomId: input.roomId ?? null,
        taskId: input.taskId ?? null,
        sender: String(input.sender || ''),
        target: String(input.target || ''),
        messageHash: String(input.messageHash || hash(input.message || '')),
        createdAt: now(),
        deadlineAt: input.deadlineAt ?? null,
        wakeup: input.wakeup === true,
      status,
      attempt: status === 'completed' ? 1 : 0,
        runId: null,
        firstCheckpoint: null,
        lastCheckpoint: null,
        lastError: null,
      resolvedAt: status === 'completed' ? now() : null,
        mergedCount: 0,
        messageHashes: [],
        escalationIds: [],
      }
      s.dispatches[dispatchId] = row
      bindMessageDispatch(s, input, row)
      return row
    }, { deferMs: DEFAULT_MUTATION_DEFER_MS }),
    dispatchTransition: (input, agent) => mutateHot('dispatch/' + input.status, input, agent, (s) => {
      const row = s.dispatches[input.dispatchId]
      if (row === undefined) throw new Error('unknown dispatch "' + input.dispatchId + '"')
      const transitions = {
        'dispatch-created': new Set(['queued', 'delivery-failed', 'cancelled']),
        queued: new Set(['delivered', 'delivery-failed', 'timed-out', 'cancelled', 'expired']),
        delivered: new Set(['turn-started', 'completed', 'delivery-failed', 'timed-out', 'cancelled', 'expired']),
        'turn-started': new Set(['first-observation', 'checkpointed', 'response-recorded', 'completed', 'run-failed', 'timed-out', 'cancelled', 'expired']),
        'first-observation': new Set(['checkpointed', 'response-recorded', 'completed', 'run-failed', 'timed-out', 'cancelled', 'expired']),
        checkpointed: new Set(['response-recorded', 'completed', 'run-failed', 'timed-out', 'cancelled', 'expired']),
        'response-recorded': new Set(['completed', 'run-failed', 'timed-out', 'cancelled', 'expired']),
        completed: new Set(),
        'delivery-failed': new Set(['cancelled']),
        'run-failed': new Set(['cancelled']),
        'timed-out': new Set(['cancelled', 'expired']),
        cancelled: new Set(),
        expired: new Set(['cancelled']),
      }
      if (!Object.prototype.hasOwnProperty.call(transitions, input.status)) throw new Error('unsupported dispatch state "' + input.status + '"')
      if (row.status === input.status) return row
      if (input.ignoreTerminal === true && !transitions[row.status]?.size) return row
      if (!transitions[row.status]?.has(input.status)) {
        throw new Error('invalid dispatch transition "' + row.status + '" -> "' + input.status + '"')
      }
      row.status = input.status
      if (input.runId !== undefined) row.runId = input.runId
      if (input.error !== undefined) row.lastError = String(input.error)
      if (input.checkpoint !== undefined) {
        row.lastCheckpoint = { value: String(input.checkpoint), at: now() }
        if (row.firstCheckpoint === null) row.firstCheckpoint = row.lastCheckpoint
      }
      if (['completed', 'delivery-failed', 'run-failed', 'timed-out', 'cancelled', 'expired'].includes(input.status)) row.resolvedAt = now()
      if (input.status === 'queued') {
        if (row.attempt === 0) row.attempt = 1
        if (row.deadlineAt === null || row.deadlineAt === undefined) row.deadlineAt = now() + DEFAULT_DELIVERY_TIMEOUT_MS
      }
      return row
    }, { deferMs: DEFAULT_MUTATION_DEFER_MS }),
    dispatchRetry: (input, agent) => mutateHot('dispatch/retry', input, agent, (s) => {
      const row = s.dispatches[input.dispatchId]
      if (row === undefined) throw new Error('unknown dispatch "' + input.dispatchId + '"')
      if (!['delivery-failed', 'timed-out', 'expired'].includes(row.status)) {
        throw new Error('dispatch "' + row.dispatchId + '" is not retryable from state "' + row.status + '"')
      }
      const maxAttempts = Math.max(1, Number(input.maxAttempts || 3))
      if (row.attempt >= maxAttempts) throw new Error('dispatch "' + row.dispatchId + '" exhausted ' + row.attempt + ' attempts')
      row.status = 'queued'
      row.attempt += 1
      row.deadlineAt = now() + Math.max(1, Number(input.deliveryTimeoutMs || DEFAULT_DELIVERY_TIMEOUT_MS))
      row.lastError = input.error === undefined ? null : String(input.error)
      row.resolvedAt = null
      return row
    }, { deferMs: DEFAULT_MUTATION_DEFER_MS }),
    dispatchGet: (dispatchId) => cloneValue(load(key, config, { history: false, clone: false }).dispatches[String(dispatchId)]),
    dispatchList: () => cloneRows(Object.values(load(key, config, { history: false, clone: false }).dispatches)),
    dispatchFind: (predicate) => cloneRows(Object.values(load(key, config, { history: false, clone: false }).dispatches).filter(predicate)),
    reconcileDispatches: (input, agent) => {
      const at = now()
      const preview = load(key, config, { history: false, clone: false })
      if (!reconcileHasWork(preview, input, at)) {
        return { changes: [], reconcile: preview.reconcile ?? null }
      }
      return mutateHot('dispatch/reconciled', input, agent, (s) => {
        const changes = reconcileState(s, input, at)
        if (changes.length === 0) return noChange({ changes, reconcile: s.reconcile ?? null })
        s.reconcile = {
          at,
          changes: changes.length,
          retry: changes.filter((row) => row.kind === 'dispatch-retry').length,
          terminal: changes.filter((row) => row.kind === 'dispatch-timeout' || row.kind === 'dispatch-expired').length,
        }
        return { changes, reconcile: s.reconcile }
      })
    },
    leaseAcquire: (input, agent) => mutateHot('lease/acquired', input, agent, (s) => {
      const member = String(input.member)
      const existing = Object.values(s.leases).find((lease) => lease.member === member && lease.status === 'active')
      if (existing !== undefined) {
        if (Number(existing.expiresAt) <= now()) {
          existing.status = 'expired'
          existing.endedAt = now()
        } else {
          throw new Error('member "' + member + '" already has active run "' + existing.runId + '"')
        }
      }
      const runId = String(input.runId || id('run'))
      const lease = {
        runId,
        member,
        taskId: input.taskId ?? null,
        dispatchId: input.dispatchId ?? null,
        status: 'active',
        acquiredAt: now(),
        heartbeatAt: now(),
        expiresAt: Number(input.expiresAt || (now() + 30 * 60 * 1000)),
        contractRevision: Number.isInteger(Number(input.contractRevision))
          && Number(input.contractRevision) >= 1
          ? Number(input.contractRevision)
          : null,
        checkpoint: null,
      }
      s.leases[runId] = lease
      return structuredClone(lease)
    }, { deferMs: 0 }),
    leaseHeartbeat: (input, agent) => mutateHot('lease/heartbeat', input, agent, (s) => {
      const lease = s.leases[input.runId]
      if (lease === undefined) throw new Error('unknown run lease "' + input.runId + '"')
      if (lease.status !== 'active') throw new Error('run lease "' + input.runId + '" is not active')
      const heartbeatAt = now()
      lease.heartbeatAt = heartbeatAt
      if (input.checkpoint !== undefined) lease.checkpoint = { value: String(input.checkpoint), at: heartbeatAt }
      if (input.contractRevision !== undefined && input.contractRevision !== null) {
        const contractRevision = Number(input.contractRevision)
        if (!Number.isInteger(contractRevision) || contractRevision < 1) {
          throw new Error('lease heartbeat contractRevision must be a positive integer')
        }
        lease.contractRevision = contractRevision
      }
      lease.expiresAt = input.expiresAt === undefined || input.expiresAt === null
        ? heartbeatAt + DEFAULT_RUN_TIMEOUT_MS
        : Number(input.expiresAt)
      return lease
    }),
    leaseRelease: (input, agent) => mutateHot('lease/' + input.status, input, agent, (s) => {
      const lease = s.leases[input.runId]
      if (lease === undefined) throw new Error('unknown run lease "' + input.runId + '"')
      if (!['completed', 'blocked', 'cancelled', 'expired', 'failed'].includes(input.status)) throw new Error('invalid lease terminal state')
      lease.status = input.status
      lease.endedAt = now()
      if (input.error !== undefined) lease.error = String(input.error)
      return lease
    }),
    leaseGet: (runId) => cloneValue(load(key, config, { history: false, clone: false }).leases[String(runId)]),
    leaseList: () => cloneRows(Object.values(load(key, config, { history: false, clone: false }).leases)),
    escalate: (input, agent) => mutateHot('room/escalation', input, agent, (s) => {
      const urgency = input.urgency || 'normal'
      if (urgency !== 'critical' && input.roundId === undefined) throw new Error('escalation requires a completed room round')
      if (input.roundId !== undefined) {
        const round = s.rounds[String(input.roundId)]
        if (round === undefined) throw new Error('unknown escalation round "' + input.roundId + '"')
        if (input.roomId !== undefined && input.roomId !== null && round.roomId !== String(input.roomId)) {
          throw new Error('escalation round "' + input.roundId + '" does not belong to room "' + input.roomId + '"')
        }
        if (urgency !== 'critical' && round.status !== 'closed') throw new Error('escalation round "' + input.roundId + '" must be closed')
      }
      if (urgency !== 'critical' && (!Array.isArray(input.references) || input.references.length === 0)) throw new Error('escalation requires at least one evidence reference')
      if (urgency !== 'critical' && (!Array.isArray(input.options) || input.options.length === 0)
        && (typeof input.noOptionsReason !== 'string' || input.noOptionsReason.trim().length === 0)) {
        throw new Error('escalation requires options or an explicit noOptionsReason')
      }
      const escalation = {
        escalationId: id('esc'),
        category: String(input.category || 'blocked'),
        summary: String(input.summary || ''),
        decisionNeeded: String(input.decisionNeeded || ''),
        target: input.target === undefined || input.target === null ? null : String(input.target),
        roomId: input.roomId ?? null,
        roundId: input.roundId ?? null,
        options: Array.isArray(input.options) ? input.options : [],
        noOptionsReason: input.noOptionsReason === undefined ? null : String(input.noOptionsReason),
        references: Array.isArray(input.references) ? input.references.map(String) : [],
        dispatchId: null,
        wakeEpisodeId: null,
        urgency,
        status: 'queued',
        createdAt: now(),
        resolvedAt: null,
      }
      s.escalations[escalation.escalationId] = escalation
      return escalation
    }),
    escalationBind: (input, agent) => mutateHot('room/escalation-bound', input, agent, (s) => {
      const escalation = s.escalations[String(input.escalationId)]
      if (escalation === undefined) throw new Error('unknown escalation "' + input.escalationId + '"')
      if (input.dispatchId !== undefined && input.dispatchId !== null) escalation.dispatchId = String(input.dispatchId)
      if (input.wakeEpisodeId !== undefined && input.wakeEpisodeId !== null) escalation.wakeEpisodeId = String(input.wakeEpisodeId)
      return escalation
    }),
    escalationResolve: (input, agent) => mutateHot('room/escalation-resolved', input, agent, (s) => {
      const escalation = s.escalations[String(input.escalationId)]
      if (escalation === undefined) throw new Error('unknown escalation "' + input.escalationId + '"')
      escalation.status = String(input.status || 'resolved')
      escalation.resolution = String(input.resolution || '')
      escalation.resolvedBy = String(input.resolvedBy || '')
      escalation.resolvedAt = now()
      const episodeId = escalation.wakeEpisodeId
      if (episodeId !== null && episodeId !== undefined) {
        const pending = Object.values(s.escalations).filter((row) =>
          row.wakeEpisodeId === episodeId && !['resolved', 'cancelled'].includes(row.status))
        if (pending.length === 0) {
          const episode = s.wakeEpisodes[episodeId]
          if (episode !== undefined) {
            episode.status = 'resolved'
            episode.resolvedAt = now()
            episode.updatedAt = now()
          }
          const dispatch = s.dispatches[episode?.dispatchId ?? '']
          if (dispatch !== undefined && !TERMINAL_DISPATCH_STATES.has(dispatch.status)) {
            if (['queued', 'delivered'].includes(dispatch.status)) dispatch.status = 'turn-started'
            if (['turn-started', 'first-observation', 'checkpointed'].includes(dispatch.status)) {
              dispatch.status = 'response-recorded'
            }
            if (dispatch.status === 'response-recorded') dispatch.status = 'completed'
            dispatch.resolvedAt = now()
          }
        }
      }
      return escalation
    }),
    escalationList: (status) => cloneRows(Object.values(load(key, config, { history: false, clone: false }).escalations).filter((row) => status === undefined || row.status === status)),
    privilegeRequest: (input, agent) => mutateHot('privilege/requested', input, agent, (s) => {
      const member = String(input.member || '')
      if (member.length === 0) throw new Error('privilege request requires a member')
      const reason = String(input.reason || '').trim()
      const blockedAction = String(input.blockedAction || '').trim()
      const evidence = Array.isArray(input.evidence) ? input.evidence.map(String).filter((row) => row.trim().length > 0) : []
      if (reason.length === 0) throw new Error('privilege request requires a reason')
      if (blockedAction.length === 0) throw new Error('privilege request requires the blocked action')
      if (evidence.length === 0) throw new Error('privilege request requires at least one evidence reference')
      const duplicate = Object.values(s.privilegeRequests).find((row) => row.member === member && row.status === 'pending')
      if (duplicate !== undefined) return duplicate
      const request = {
        requestId: id('privilege'), member, requestedBy: String(input.requestedBy || member),
        taskId: input.taskId === undefined || input.taskId === null ? null : String(input.taskId),
        blockedAction, reason, evidence,
        requestedScope: input.requestedScope === undefined || input.requestedScope === null ? null : String(input.requestedScope),
        status: 'pending', approvedBy: null, approvedAt: null, rejectedBy: null, rejectedAt: null,
        rejectionReason: null, activatedAt: null, endedAt: null, endReason: null, expiresAt: null,
        createdAt: now(), updatedAt: now(),
      }
      s.privilegeRequests[request.requestId] = request
      return request
    }),
    privilegeApprove: (input, agent) => mutateHot('privilege/approved', input, agent, (s) => {
      const request = s.privilegeRequests[String(input.requestId)]
      if (request === undefined) throw new Error('unknown privilege request "' + input.requestId + '"')
      if (request.status !== 'pending') throw new Error('privilege request "' + request.requestId + '" is not pending')
      if (!input.approvedBy) throw new Error('privilege approval requires approvedBy')
      request.status = 'approved'
      request.approvedBy = String(input.approvedBy)
      request.approvedAt = now()
      request.updatedAt = now()
      return request
    }),
    privilegeReject: (input, agent) => mutateHot('privilege/rejected', input, agent, (s) => {
      const request = s.privilegeRequests[String(input.requestId)]
      if (request === undefined) throw new Error('unknown privilege request "' + input.requestId + '"')
      if (request.status !== 'pending' && request.status !== 'approved') throw new Error('privilege request "' + request.requestId + '" cannot be rejected from ' + request.status)
      if (!input.rejectedBy) throw new Error('privilege rejection requires rejectedBy')
      request.status = 'rejected'
      request.rejectedBy = String(input.rejectedBy)
      request.rejectedAt = now()
      request.rejectionReason = String(input.reason || '')
      request.updatedAt = now()
      return request
    }),
    privilegeActivate: (input, agent) => mutateHot('privilege/activated', input, agent, (s) => {
      const member = String(input.member || '')
      const request = Object.values(s.privilegeRequests)
        .filter((row) => row.member === member && row.status === 'approved')
        .sort((left, right) => Number(left.approvedAt || 0) - Number(right.approvedAt || 0))[0]
      if (request === undefined) return noChange(undefined)
      request.status = 'active'
      request.activatedAt = now()
      request.expiresAt = Number(input.expiresAt || (now() + DEFAULT_RUN_TIMEOUT_MS))
      request.updatedAt = now()
      return request
    }),
    privilegeEnd: (input, agent) => mutateHot('privilege/ended', input, agent, (s) => {
      const member = String(input.member || '')
      const active = Object.values(s.privilegeRequests).filter((row) => row.member === member && row.status === 'active')
      if (active.length === 0) return noChange([])
      for (const request of active) {
        request.status = input.status === 'cancelled' ? 'cancelled' : 'expired'
        request.endedAt = now()
        request.endReason = String(input.reason || 'turn ended')
        request.updatedAt = now()
      }
      return active
    }),
    privilegeActive: (member) => Object.values(load(key, config, { history: false, clone: false }).privilegeRequests)
      .find((row) => row.member === String(member) && row.status === 'active') ?? null,
    privilegeList: (status) => Object.values(load(key, config, { history: false, clone: false }).privilegeRequests)
      .filter((row) => status === undefined || row.status === status),
    evidencePut: (input, agent) => mutateHot('evidence/recorded', input, agent, (s) => {
      const evidenceId = String(input.evidenceId || id('evidence'))
      const row = {
        evidenceId,
        taskId: input.taskId ?? null,
        commitSha: input.commitSha ?? null,
        requirementId: input.requirementId ?? null,
        recordedBy: input.recordedBy === undefined || input.recordedBy === null ? null : String(input.recordedBy),
        kind: String(input.kind || 'test'),
        command: input.command ?? null,
        expected: input.expected ?? null,
        actual: input.actual ?? null,
        output: input.output ?? null,
        paths: Array.isArray(input.paths) ? input.paths.map(String) : [],
        classification: input.classification ?? null,
        status: input.status || 'recorded',
        createdAt: now(),
      }
      s.evidence[evidenceId] = row
      if (row.taskId !== null && row.taskId !== undefined) {
        for (const board of Object.values(s.boards ?? {})) {
          const task = Object.values(board?.tasks ?? {}).find((candidate) =>
            String(candidate?.id ?? candidate?.taskId ?? '') === String(row.taskId))
          if (task === undefined) continue
          task.evidenceIds = [...new Set([...(Array.isArray(task.evidenceIds) ? task.evidenceIds : []).map(String), evidenceId])]
          task.revision = Number(task.revision ?? 0) + 1
          task.updatedAt = now()
          break
        }
      }
      return row
    }),
    packetPut: (input, agent) => mutateHot('packet/recorded', input, agent, (s) => {
      const requestedPacketId = String(input.packetId || id('packet'))
      let packetId = requestedPacketId
      let revision = 1
      let supersedes = null
      if (s.packets?.[packetId] !== undefined) {
        let candidate = requestedPacketId
        let suffixRevision = 1
        while (s.packets[candidate] !== undefined) {
          supersedes = candidate
          suffixRevision += 1
          candidate = requestedPacketId + '-r' + String(suffixRevision)
        }
        packetId = candidate
        revision = suffixRevision
      }
      const metaInput = input.meta !== null && typeof input.meta === 'object' && !Array.isArray(input.meta)
        ? structuredClone(input.meta)
        : {}
      const packetPayload = {
        kind: String(input.kind || 'group-acceptance'),
        group: input.group ?? null,
        taskIds: Array.isArray(input.taskIds) ? input.taskIds.map(String) : [],
        commitSha: input.commitSha ?? null,
        requirements: Array.isArray(input.requirements) ? input.requirements.map(String) : [],
        checks: Array.isArray(input.checks) ? structuredClone(input.checks) : [],
        files: Array.isArray(input.files) ? input.files.map(String) : [],
        screenshots: Array.isArray(input.screenshots) ? input.screenshots.map(String) : [],
        resourceScan: input.resourceScan ?? null,
        risks: Array.isArray(input.risks) ? structuredClone(input.risks) : [],
        blockers: Array.isArray(input.blockers) ? structuredClone(input.blockers) : [],
        meta: metaInput,
      }
      const contentDigest = hashCanonical(packetPayload)
      const row = {
        packetId,
        ...packetPayload,
        submittedBy: String(input.submittedBy || ''),
        meta: {
          ...metaInput,
          packetVersion: 2,
          revision,
          supersedes,
          contentDigest,
          contentDigestVersion: 2,
          metaInput,
        },
        createdAt: now(),
      }
      s.packets[packetId] = row
      return row
    }),
    packetList: (kind) => cloneRows(Object.values(load(key, config, { history: false, clone: false }).packets).filter((row) => kind === undefined || row.kind === kind)),
    frozenSet: (input, agent) => mutateHot('member/frozen', input, agent, (s) => {
      const member = String(input.member || '').trim()
      if (member.length === 0) throw new Error('frozen member name is required')
      const frozen = input.frozen === true
      const previous = s.frozenMembers[member]?.frozen === true
      if (frozen) {
        s.frozenMembers[member] = {
          member,
          frozen: true,
          updatedAt: now(),
          updatedBy: input.updatedBy === undefined || input.updatedBy === null ? null : String(input.updatedBy),
        }
      } else {
        delete s.frozenMembers[member]
      }
      return { member, frozen, previous }
    }),
    frozenMembers: () => cloneRows(Object.values(load(key, config, { history: false, clone: false }).frozenMembers)),
    frozenNames: () => Object.values(load(key, config, { history: false, clone: false }).frozenMembers).filter((row) => row?.frozen === true).map((row) => String(row.member)),
    frozenIs: (member) => load(key, config, { history: false, clone: false }).frozenMembers[String(member)]?.frozen === true,
    memberRouteSet: (input, agent) => mutate('member/route-set', input, agent, (s) => {
      const member = String(input.member || '').trim()
      if (member.length === 0) throw new Error('route member name is required')
      const route = input.route ?? input
      const provider = String(route.provider || '').trim()
      const model = String(route.model || '').trim()
      if (provider.length === 0) throw new Error('route provider is required')
      if (model.length === 0) throw new Error('route model is required')
      const reasoningEffort = route.reasoningEffort === undefined || route.reasoningEffort === null
        ? undefined
        : String(route.reasoningEffort)
      const previous = s.memberRoutes[member]
      if (previous?.provider === provider
        && previous?.model === model
        && previous?.reasoningEffort === reasoningEffort) return noChange(previous)
      const row = {
        member,
        provider,
        model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        updatedAt: now(),
        updatedBy: input.updatedBy === undefined || input.updatedBy === null ? null : String(input.updatedBy),
      }
      s.memberRoutes[member] = row
      return row
    }, { history: false, deferMs: 0 }),
    memberRoute: (member) => cloneValue(load(key, config, { history: false, clone: false }).memberRoutes[String(member)]),
    memberRoutes: () => cloneRows(Object.values(load(key, config, { history: false, clone: false }).memberRoutes)),
    memberParentSet: (input, agent) => mutate('member/parent-set', input, agent, (s) => {
      const member = String(input.member || '').trim()
      const parent = String(input.parent || '').trim()
      if (member.length === 0) throw new Error('parent override member name is required')
      if (parent.length === 0) throw new Error('parent override parent name is required')
      const previous = s.memberParents[member]?.parent ?? null
      const row = {
        member,
        parent,
        reason: String(input.reason || '').trim(),
        updatedAt: now(),
        updatedBy: input.updatedBy === undefined || input.updatedBy === null ? null : String(input.updatedBy),
      }
      s.memberParents[member] = row
      return { ...row, previous }
    }, { history: false, deferMs: 0 }),
    memberParent: (member) => cloneValue(load(key, config, { history: false, clone: false }).memberParents[String(member)]),
    memberParents: () => structuredClone(load(key, config, { history: false, clone: false }).memberParents ?? {}),
    countersUpdate: (input, agent) => mutateHot('counters/updated', input, agent, (s) => {
      let changed = false
      for (const key of ['activeSlots', 'lifetimeCreates', 'tokenUsed', 'retries', 'contextRefusals']) {
        if (input[key] !== undefined) {
          const next = Math.max(0, Number(input[key]))
          if (s.counters[key] !== next) {
            s.counters[key] = next
            changed = true
          }
        }
      }
      if (input.tokenBudget !== undefined) {
        const next = input.tokenBudget === null ? null : Math.max(0, Number(input.tokenBudget))
        if (s.counters.tokenBudget !== next) {
          s.counters.tokenBudget = next
          changed = true
        }
      }
      return changed ? s.counters : noChange(s.counters)
    }),
    counters: () => structuredClone(load(key, config, { history: false, clone: false }).counters),
    healthSet: (input, agent) => mutateHot('health/updated', input, agent, (s) => {
      // A provider failure is a terminal control-plane condition. Health observers may
      // still report their own plugin status afterwards, but they must not silently
      // turn a blocked Team back to healthy.
      if (s.provider?.status === 'blocked' && input.status === 'healthy') return s.health
      const status = ['healthy', 'degraded', 'disabled'].includes(input.status) ? input.status : 'degraded'
      const reasons = Array.isArray(input.reasons) ? input.reasons.map(String) : []
      const same = s.health?.status === status
        && JSON.stringify(Array.isArray(s.health?.reasons) ? s.health.reasons : []) === JSON.stringify(reasons)
      if (same) return noChange(s.health)
      s.health = { status, reasons, updatedAt: now() }
      return s.health
    }, { deferMs: 0 }),
    healthStatus: () => {
      const state = load(key, config, { history: false, clone: false })
      return {
        status: state.health?.status,
        reasons: Array.isArray(state.health?.reasons) ? [...state.health.reasons] : [],
        updatedAt: state.health?.updatedAt,
      }
    },
    health: () => {
      const currentState = load(key, config, { history: false, clone: false })
      const currentHealth = structuredClone(currentState.health)
      const storage = inspectControlPlaneStorage(file, storageOptions)
      return {
        ...currentHealth,
        providerSafety: structuredClone(currentState.providerSafety ?? {}),
        ...storage,
        storage,
        write: storage.write,
      }
    },
    providerState: () => structuredClone(load(key, config, { history: false, clone: false }).provider),
    providerSafety: (member) => {
      const name = member === undefined || member === null ? '' : String(member)
      if (!name) return null
      const row = load(key, config, { history: false, clone: false }).providerSafety?.[name]
      if (row === undefined || row === null || Number(row.expiresAt ?? 0) <= now()) return null
      return structuredClone(row)
    },
    providerSafetyClear: (input, agent) => mutateHot('provider/safety-clear', input, agent, (s) => {
      const member = String(input.member || '')
      if (!member || s.providerSafety?.[member] === undefined) return undefined
      delete s.providerSafety[member]
      return { member, cleared: true }
    }),
    providerFailure: (input, agent) => mutateHot('provider/failure', input, agent, (s) => {
      const category = String(input.category || 'provider-error')
      const summary = String(input.summary || input.error || 'provider request failed')
      const provider = input.provider === undefined || input.provider === null ? null : String(input.provider)
      const safety = input.safety === true || category === 'provider-safety'
      const fingerprint = String(input.fingerprint || hash({
        category,
        summary,
        provider,
        status: input.status ?? null,
      }))
      const previous = s.providerFailures[fingerprint]
      if (previous !== undefined) return { deduplicated: true, failure: previous }

      const failure = {
        fingerprint,
        category,
        summary,
        provider,
        status: input.status ?? null,
        member: input.member === undefined || input.member === null ? null : String(input.member),
        safety,
        requestBytes: Number.isFinite(Number(input.requestBytes)) ? Number(input.requestBytes) : null,
        requestTokens: Number.isFinite(Number(input.requestTokens)) ? Number(input.requestTokens) : null,
        contextPack: input.contextPack === undefined || input.contextPack === null ? null : String(input.contextPack).slice(0, 8000),
        providerResponse: input.providerResponse === undefined || input.providerResponse === null
          ? null
          : String(input.providerResponse).slice(0, 2000),
        createdAt: now(),
      }
      s.providerFailures[fingerprint] = failure
      if (safety) {
        const member = failure.member
        if (member) {
          const previousSafety = s.providerSafety?.[member] ?? {}
          s.providerSafety[member] = {
            member,
            reason: summary,
            category,
            requestBytes: failure.requestBytes,
            requestTokens: failure.requestTokens,
            contextPack: failure.contextPack,
            providerResponse: failure.providerResponse,
            attempts: Number(previousSafety.attempts ?? 0) + 1,
            createdAt: previousSafety.createdAt ?? now(),
            updatedAt: now(),
            expiresAt: now() + Math.max(60_000, Number(input.fallbackMs ?? 5 * 60 * 1000)),
          }
        }
        return { deduplicated: false, failure, fallback: member ? s.providerSafety[member] : null }
      }
      s.provider = { status: 'blocked', lastFailure: failure, updatedAt: now() }

      const healthReasons = Array.isArray(s.health?.reasons) ? s.health.reasons.map(String) : []
      const reason = 'provider failure [' + category + ']: ' + summary
      s.health = {
        status: 'disabled',
        reasons: [...new Set([...healthReasons, reason])],
        updatedAt: now(),
      }

      const terminalDispatches = new Set(['completed', 'delivery-failed', 'run-failed', 'timed-out', 'cancelled', 'expired'])
      const executionDispatches = new Set(['turn-started', 'first-observation', 'checkpointed', 'response-recorded'])
      for (const row of Object.values(s.dispatches)) {
        if (row === null || typeof row !== 'object' || terminalDispatches.has(row.status)) continue
        row.lastError = summary
        row.resolvedAt = now()
        row.status = executionDispatches.has(row.status) ? 'run-failed' : 'cancelled'
      }
      for (const lease of Object.values(s.leases)) {
        if (lease === null || typeof lease !== 'object' || lease.status !== 'active') continue
        lease.status = 'failed'
        lease.error = summary
        lease.endedAt = now()
      }
      for (const board of Object.values(s.boards)) {
        if (board === null || typeof board !== 'object' || board.tasks === null || typeof board.tasks !== 'object') continue
        for (const task of Object.values(board.tasks)) {
          if (task === null || typeof task !== 'object' || task.status === 'completed' || task.status === 'deleted') continue
          task.phase = 'blocked'
          task.blockedReason = reason
          task.revision = Number(task.revision || 0) + 1
        }
      }
      const escalationId = 'provider-' + fingerprint.slice(0, 24)
      s.escalations[escalationId] = {
        escalationId,
        category: 'provider-blocked',
        summary: reason,
        decisionNeeded: 'Restore provider credentials or quota, then explicitly resume the blocked Team.',
        roomId: null,
        roundId: null,
        options: ['restore-provider', 'cancel-team'],
        references: [fingerprint],
        urgency: 'critical',
        status: 'queued',
        createdAt: now(),
        resolvedAt: null,
      }
      return { deduplicated: false, failure }
    }),
    providerResume: (input, agent) => mutateHot('provider/resumed', input, agent, (s) => {
      if (s.provider?.status !== 'blocked') return { resumed: false, provider: s.provider }
      const remainingReasons = (Array.isArray(s.health?.reasons) ? s.health.reasons : [])
        .map(String)
        .filter((reason) => !reason.startsWith('provider failure'))
      s.provider = { status: 'unknown', lastFailure: s.provider.lastFailure ?? null, updatedAt: now() }
      s.health = {
        status: remainingReasons.length === 0 ? 'healthy' : 'degraded',
        reasons: remainingReasons,
        updatedAt: now(),
      }
      return { resumed: true, provider: s.provider, health: s.health }
    }),
    wakeClaim: (input, agent) => {
      const { pendingMessage, ...auditInput } = input
      return mutateHot('wake/claimed', auditInput, agent, (s) => {
      const episodeId = String(input.episodeId)
      const existingEpisode = s.wakeEpisodes[episodeId]
      const existing = existingEpisode === undefined ? undefined : s.dispatches[existingEpisode.dispatchId]
      const appendPendingMessage = (dispatch, episode) => {
        if (pendingMessage === null || typeof pendingMessage !== 'object' || Array.isArray(pendingMessage)) return false
        const hash = String(pendingMessage.messageHash ?? input.messageHash ?? '')
        const id = String(pendingMessage.messageId ?? dispatch.dispatchId + ':' + hash.slice(0, 16))
        const rows = Array.isArray(dispatch.pendingMessages) ? dispatch.pendingMessages : []
        let added = false
        if (!rows.some((row) => row?.messageHash === hash || row?.messageId === id)) {
          const createdAt = Number(pendingMessage.createdAt ?? now())
          rows.push({
            messageId: id,
            messageHash: hash,
            text: String(pendingMessage.text ?? '').slice(0, 8000),
            status: String(pendingMessage.status ?? 'queued'),
            createdAt,
          })
          added = true
        }
        dispatch.pendingMessages = rows.slice(-16)
        episode.pendingMessages = dispatch.pendingMessages
        episode.latestMessageId = id
        episode.latestMessageHash = hash
        episode.updatedAt = Number(pendingMessage.createdAt ?? now())
        bindMessageDispatch(s, input, dispatch, episode)
        return added
      }
      if (existingEpisode !== undefined && !['resolved', 'cancelled'].includes(existingEpisode.status)
        && existing !== undefined && !TERMINAL_DISPATCH_STATES.has(existing.status)) {
        existingEpisode.mergedCount += 1
        existing.mergedCount = Number(existing.mergedCount || 0) + 1
        existingEpisode.updatedAt = now()
        const messageHash = String(input.messageHash || '')
        if (messageHash.length > 0 && !existing.messageHashes.includes(messageHash)) existing.messageHashes.push(messageHash)
        if (input.escalationId !== undefined && input.escalationId !== null) {
          const escalationId = String(input.escalationId)
          if (!existing.escalationIds.includes(escalationId)) existing.escalationIds.push(escalationId)
          if (!existingEpisode.escalationIds.includes(escalationId)) existingEpisode.escalationIds.push(escalationId)
        }
        const pendingAdded = appendPendingMessage(existing, existingEpisode)
        return { claimed: false, dispatch: existing, episode: existingEpisode, pendingAdded }
      }
      const dispatch = {
        dispatchId: 'wake:' + episodeId,
        rootId: key,
        roomId: input.roomId ?? null,
        taskId: input.taskId ?? null,
        sender: String(input.sender || ''),
        target: String(input.target || ''),
        messageHash: String(input.messageHash || ''),
        createdAt: now(),
        deadlineAt: null,
        wakeup: true,
        status: 'queued',
        attempt: 1,
        runId: null,
        firstCheckpoint: null,
        lastCheckpoint: null,
        lastError: null,
        resolvedAt: null,
        mergedCount: 0,
        messageHashes: input.messageHash === undefined ? [] : [String(input.messageHash)],
        escalationIds: input.escalationId === undefined ? [] : [String(input.escalationId)],
      }
      s.dispatches[dispatch.dispatchId] = dispatch
      s.wakeEpisodes[episodeId] = {
        episodeId,
        dispatchId: dispatch.dispatchId,
        kind: String(input.kind || (input.escalationId === undefined || input.escalationId === null ? 'control' : 'escalation')),
        target: String(input.target || ''),
        sender: String(input.sender || ''),
        roomId: input.roomId ?? null,
        status: 'queued',
        mergedCount: 0,
        escalationIds: input.escalationId === undefined ? [] : [String(input.escalationId)],
        createdAt: now(),
        updatedAt: now(),
        resolvedAt: null,
      }
      const pendingAdded = appendPendingMessage(dispatch, s.wakeEpisodes[episodeId])
      return { claimed: true, dispatch, episode: s.wakeEpisodes[episodeId], pendingAdded }
      }, { deferMs: DEFAULT_MUTATION_DEFER_MS })
    },
    wakeAcknowledge: (input, agent) => mutateHot('wake/acknowledged', input, agent, (s) => {
      const episodeId = String(input.episodeId)
      const episode = s.wakeEpisodes[episodeId]
      if (episode === undefined) throw new Error('unknown wake episode "' + episodeId + '"')
      const dispatch = s.dispatches[episode.dispatchId]
      if (dispatch === undefined) throw new Error('unknown wake dispatch "' + episode.dispatchId + '"')
      const status = String(input.status || 'turn-started')
      if (TERMINAL_DISPATCH_STATES.has(dispatch.status)) {
        episode.status = dispatch.status
        episode.updatedAt = now()
        if (dispatch.status === 'completed' && episode.resolvedAt === null) episode.resolvedAt = now()
        return { episode, dispatch }
      }
      const wakeStates = ['queued', 'delivered', 'turn-started', 'first-observation', 'checkpointed', 'response-recorded', 'completed']
      if (!wakeStates.includes(status)) {
        if (!['delivery-failed', 'run-failed', 'timed-out', 'cancelled', 'expired'].includes(status)) {
          throw new Error('unsupported wake acknowledgement state "' + status + '"')
        }
        dispatch.status = status
        dispatch.resolvedAt = now()
        episode.status = status
        episode.resolvedAt = now()
        episode.updatedAt = now()
        return { episode, dispatch }
      }
      const currentIndex = wakeStates.indexOf(dispatch.status)
      const targetIndex = wakeStates.indexOf(status)
      const previousDispatchStatus = dispatch.status
      const previousEpisodeStatus = episode.status
      if (currentIndex >= 0 && targetIndex > currentIndex) dispatch.status = status
      if (status === 'turn-started' && episode.kind === 'control') {
        dispatch.status = 'completed'
        dispatch.resolvedAt = now()
      }
      episode.status = dispatch.status
      const updatedAt = now()
      const unchanged = previousDispatchStatus === dispatch.status
        && previousEpisodeStatus === episode.status
        && Number(episode.updatedAt || 0) > 0
      if (!unchanged) {
        episode.updatedAt = updatedAt
        if (dispatch.status === 'completed') episode.resolvedAt = updatedAt
      }
      if (unchanged) return noChange({ episode, dispatch })
      return { episode, dispatch }
    }, { deferMs: DEFAULT_MUTATION_DEFER_MS }),
  }
  scheduleColdGc()
  remember(stores, serviceKey, current, MAX_SERVICE_ENTRIES)
  return current
}

export function controlPlaneFor(rootId, config = {}) {
  return service(rootId, config)
}

/**
 * Return every stable Team root key a runtime variant may expose for an Agent.
 *
 * The current Team domain uses membership.id (a TeamId), while older fixtures and
 * adapters sometimes only expose the root Agent session/id. Trying the explicit TeamId
 * first preserves isolation; the fallbacks only matter when a persisted control plane
 * already exists under the adapter's root identity.
 */
export function teamRootIdCandidates(ctx, agent) {
  const values = []
  try {
    const membership = ctx?.agentTeams?.tryMembership?.(agent)
    values.push(
      membership?.id,
      membership?.teamId,
      membership?.root?.session?.id,
      membership?.root?.id,
    )
  } catch {
    // An agent outside a Team has no candidates.
  }
  return [...new Set(values
    .filter((value) => value !== undefined && value !== null && String(value).length > 0)
    .map(String))]
}

/**
 * Resolve the control plane that already contains an active lease for this member.
 * This prevents a root-id mismatch from silently creating a fresh empty control plane.
 */
export function controlPlaneForMember(ctx, agent, config = {}) {
  const candidates = teamRootIdCandidates(ctx, agent)
  const name = agent?.name || agent?.id
  let existingRootId
  for (const rootId of candidates) {
    const file = fileFor(rootId, config)
    const cached = stores.get(rootId + '|' + file)
    if (cached !== undefined) {
      if (existingRootId === undefined) existingRootId = rootId
      const hot = cached.view({ history: false })
      if (name !== undefined && (Object.values(hot?.leases ?? {})
        .some((lease) => lease?.member === String(name) && lease.status === 'active')
        || Object.values(hot?.privilegeRequests ?? {})
          .some((request) => request?.member === String(name) && request.status === 'active'))) {
        return cached
      }
    }
    if (!existsSync(file)) continue
    // Inspect only the compact active-member index while choosing a Team root.
    // A cache miss falls back to the raw file, so corruption still fails closed.
    const signature = fileSignature(file)
    const indexed = rootIndex.get(file)
    if (indexed?.signature === signature) {
      if (existingRootId === undefined) existingRootId = rootId
      if (name !== undefined && indexed.activeMembers.has(String(name))) {
        return controlPlaneFor(rootId, config)
      }
      continue
    }
    const hot = readDurableJson(file)
    rememberRootIndex(file, signature, hot)
    if (hot === null || typeof hot !== 'object' || Array.isArray(hot)
      || (hot.rootId !== undefined && String(hot.rootId) !== rootId)) {
      throw new Error('invalid control-plane root candidate at ' + file)
    }
    if (existingRootId === undefined) existingRootId = rootId
    if (name !== undefined && Object.values(hot.privilegeRequests ?? {})
      .some((request) => request?.member === String(name) && request.status === 'active')) {
      return controlPlaneFor(rootId, config)
    }
    if (name !== undefined && Object.values(hot.leases ?? {})
      .some((lease) => lease?.member === String(name) && lease.status === 'active')) {
      return controlPlaneFor(rootId, config)
    }
  }
  return existingRootId !== undefined ? controlPlaneFor(existingRootId, config)
    : candidates.length > 0 ? controlPlaneFor(candidates[0], config) : undefined
}

export function resetControlPlaneCache() {
  closeAuditHandles()
  for (const timer of storageGcTimers.values()) clearTimeout(timer)
  storageGcTimers.clear()
  stores.clear()
  tails.clear()
  parsedCache.clear()
  historyCache.clear()
  coldRefDigestCache = new WeakMap()
  memoryHotStates.clear()
  rootIndex.clear()
  lastGood.clear()
  panelCache.clear()
  verifiedCold.clear()
  coldRawCache.clear()
  coldRawCacheBytes = 0
  storageInventoryCache.clear()
  storagePathCache.clear()
  reachableColdCache.clear()
  writeMetrics.clear()
}

export function hashControlValue(value) {
  return hash(value)
}

export function controlPlaneFile(rootId, config = {}) {
  return fileFor(rootId, config)
}

export function controlPlaneStoreExists(rootId, config = {}) {
  return existsSync(fileFor(rootId, config))
}

// The loaded-code certificate reads this module's own source hash from here (see team-v15-window-loaded.mjs).
import { registerLoadedModule } from './team-v15-window-loaded.mjs'
registerLoadedModule(import.meta.url)
