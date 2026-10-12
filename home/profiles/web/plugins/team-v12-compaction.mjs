/**
 * team-v12-compaction
 *
 * Pure state machines for v12 milestones and compaction handoff.
 *
 * Milestones and compaction jobs are deliberately separate maps. `done` is a
 * synchronous, idempotent transaction over the in-memory document: it marks one
 * milestone complete and creates one deterministic job. It never invokes a
 * compaction engine and never ends the caller's turn.
 */

export const COMPACTION_DOC_VERSION = 1
export const COMPACTION_RECOVERY_FIRST_ACTION = '恢复当前任务：读取有效任务契约和登记的计划/文档引用，核对版本、未完成项及下一操作；仅平台施工任务读取其平台计划。'

export const MILESTONE_STATUSES = Object.freeze(['active', 'done'])
export const COMPACTION_STATUSES = Object.freeze([
  'queued',
  'waiting_for_handoff',
  'ready',
  'running',
  'completed',
  'failed',
])

const COMPACTION_TRANSITIONS = Object.freeze({
  queued: new Set(['waiting_for_handoff', 'ready']),
  waiting_for_handoff: new Set(['ready']),
  ready: new Set(['running']),
  running: new Set(['completed', 'failed']),
  completed: new Set(),
  failed: new Set(['queued']),
})

/** Return a plain mutable object. */
function objectOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** Return an array without changing the caller's value. */
function arrayOf(value) {
  return Array.isArray(value) ? value : []
}

/** Return a string value. */
function stringOf(value) {
  return value === undefined || value === null ? '' : String(value)
}

/** Return a finite number. */
function numberOf(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

/** Stable JSON copy for API results and snapshots. */
function copyValue(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

/** Structured refusal for expected business errors. */
function refusal(reason, detail) {
  return detail === undefined
    ? { ok: false, reason }
    : { ok: false, reason, detail }
}

/** Append a bounded audit event. */
function audit(state, kind, detail) {
  if (!Array.isArray(state.events)) state.events = []
  state.events.push({ kind, at: numberOf(detail?.at, numberOf(state.now, Date.now())), ...objectOf(detail) })
  if (state.events.length > 2000) state.events.splice(0, state.events.length - 2000)
}

/** Bump document revision after a successful mutation. */
function touch(state, detail) {
  state.revision = numberOf(state.revision, 0) + 1
  audit(state, detail?.kind ?? 'state', { revision: state.revision, ...objectOf(detail) })
  return state.revision
}

/** Normalize a persisted v12 compaction document. */
export function normalizeCompactionState(state) {
  const value = objectOf(state)
  value.version = numberOf(value.version, COMPACTION_DOC_VERSION)
  value.revision = numberOf(value.revision, 0)
  value.milestones = objectOf(value.milestones)
  value.jobs = objectOf(value.jobs)
  value.events = arrayOf(value.events)
  return value
}

/** Create a fresh, empty v12 milestone and compaction document. */
export function createCompactionState() {
  return normalizeCompactionState({
    version: COMPACTION_DOC_VERSION,
    revision: 0,
    milestones: {},
    jobs: {},
    events: [],
  })
}

/** Find a job and return the usual structured error when it is absent. */
function jobOf(state, jobId) {
  const id = stringOf(jobId)
  const job = state.jobs[id]
  return job === undefined ? { ok: false, reason: 'compaction-job-not-found' } : { ok: true, job }
}

/** Find a milestone and return the usual structured error when it is absent. */
function milestoneOf(state, milestoneId) {
  const id = stringOf(milestoneId)
  const milestone = state.milestones[id]
  return milestone === undefined ? { ok: false, reason: 'milestone-not-found' } : { ok: true, milestone }
}

/** Deterministic job ID makes the done operation idempotent. */
export function compactionJobId(milestoneId) {
  return 'compact:' + stringOf(milestoneId)
}

/**
 * Create a new milestone record.
 *
 * A completed milestone ID is immutable. A caller that needs the next stage
 * must create a new ID; this is what makes `done -> set` safe in one turn.
 */
export function setMilestone(state, input) {
  const doc = normalizeCompactionState(state)
  const row = objectOf(input)
  const milestoneId = stringOf(row.milestoneId)
  if (milestoneId.length === 0) return refusal('milestone-id-required')
  const existing = doc.milestones[milestoneId]
  if (existing !== undefined) {
    const same = stringOf(existing.goal) === stringOf(row.goal)
      && stringOf(existing.owner) === stringOf(row.owner)
    return same
      ? { ok: true, deduplicated: true, milestone: copyValue(existing) }
      : refusal('milestone-id-conflict', { milestoneId, status: existing.status })
  }
  const goal = stringOf(row.goal ?? row.stage)
  if (goal.length === 0) return refusal('milestone-goal-required')
  const milestone = {
    milestoneId,
    owner: stringOf(row.owner),
    scope: stringOf(row.scope) || null,
    taskId: stringOf(row.taskId) || null,
    goal,
    acceptance: arrayOf(row.acceptance).map(String),
    dependencies: arrayOf(row.dependencies).map(String),
    firstStep: stringOf(row.firstStep),
    contextRevision: numberOf(row.contextRevision, numberOf(doc.revision, 0)),
    status: 'active',
    revision: 1,
    createdAt: numberOf(row.createdAt, numberOf(doc.now, Date.now())),
    doneAt: null,
    nextMilestoneId: null,
    explicitNone: false,
  }
  doc.milestones[milestoneId] = milestone
  touch(doc, { kind: 'milestone/set', milestoneId, owner: milestone.owner })
  return { ok: true, deduplicated: false, milestone: copyValue(milestone) }
}

/** Alias used by callers that prefer a create verb. */
export const createMilestone = setMilestone

/**
 * Atomically mark one milestone done and create its compaction job.
 *
 * The result explicitly tells the model that it may still set the next
 * milestone in this turn. Repeating the call returns the same job.
 */
export function doneMilestone(state, input) {
  const doc = normalizeCompactionState(state)
  const row = objectOf(input)
  const found = milestoneOf(doc, row.milestoneId)
  if (found.ok !== true) return found
  const jobId = stringOf(row.jobId) || compactionJobId(found.milestone.milestoneId)
  const existingJob = doc.jobs[jobId]
  if (found.milestone.status === 'done') {
    return {
      ok: true,
      deduplicated: true,
      milestone: copyValue(found.milestone),
      job: copyValue(existingJob),
      created: false,
      maySetNextMilestone: true,
      message: 'milestone already done; the existing compaction job was reused',
    }
  }
  found.milestone.status = 'done'
  found.milestone.doneAt = numberOf(row.doneAt, numberOf(doc.now, Date.now()))
  found.milestone.contextRevision = numberOf(row.contextRevision, found.milestone.contextRevision)
  found.milestone.revision = numberOf(found.milestone.revision, 1) + 1
  const job = existingJob ?? {
    jobId,
    milestoneId: found.milestone.milestoneId,
    trigger: 'milestone',
    reason: 'milestone',
    contextRevision: found.milestone.contextRevision,
    status: 'queued',
    attempts: 0,
    handoff: null,
    handoff_pending: false,
    createdAt: numberOf(row.doneAt, numberOf(doc.now, Date.now())),
    updatedAt: numberOf(row.doneAt, numberOf(doc.now, Date.now())),
    startedAt: null,
    completedAt: null,
    failedAt: null,
    lastError: null,
  }
  doc.jobs[jobId] = job
  touch(doc, { kind: 'milestone/done', milestoneId: found.milestone.milestoneId, jobId })
  return {
    ok: true,
    deduplicated: false,
    milestone: copyValue(found.milestone),
    job: copyValue(job),
    created: existingJob === undefined,
    maySetNextMilestone: true,
    message: 'milestone done; compaction is queued and this turn may continue',
  }
}

/** Alias matching the v12 plan wording. */
export const done = doneMilestone

/** Read one compaction job. */
export function getCompactionJob(state, jobId) {
  const doc = normalizeCompactionState(state)
  const found = jobOf(doc, jobId)
  return found.ok === true
    ? { ok: true, job: copyValue(found.job) }
    : found
}

/** Move a queued job to the handoff waiting state. */
export function waitForHandoff(state, jobId, input = {}) {
  const doc = normalizeCompactionState(state)
  const found = jobOf(doc, jobId)
  if (found.ok !== true) return found
  if (found.job.status !== 'queued') return refusal('invalid-transition', { from: found.job.status, to: 'waiting_for_handoff' })
  found.job.status = 'waiting_for_handoff'
  found.job.updatedAt = numberOf(input.updatedAt, numberOf(doc.now, Date.now()))
  found.job.waitingReason = stringOf(input.reason) || 'waiting for the next milestone or explicit none'
  touch(doc, { kind: 'compaction/waiting-for-handoff', jobId: found.job.jobId })
  return { ok: true, status: found.job.status, job: copyValue(found.job) }
}

/** Validate the explicit next-stage gate without mutating state. */
export function handoffGateVerdict(state, jobId, input = {}) {
  const doc = normalizeCompactionState(state)
  const found = jobOf(doc, jobId)
  if (found.ok !== true) return found
  const row = objectOf(input)
  const nextMilestoneId = row.nextMilestoneId === null || row.nextMilestoneId === undefined
    ? ''
    : stringOf(row.nextMilestoneId)
  const explicitNone = row.none === true
    || row.noNextMilestone === true
    || row.explicitNone === true
    || (row.nextMilestoneId === null && row.explicitNone === true)
  if (explicitNone) return { ok: true, mode: 'none', nextMilestoneId: null }
  if (nextMilestoneId.length === 0) return refusal('handoff-gate')
  if (nextMilestoneId === found.job.milestoneId) return refusal('handoff-gate', { reason: 'next milestone must be a new record' })
  const next = doc.milestones[nextMilestoneId]
  if (next === undefined) return refusal('handoff-gate', { reason: 'next milestone does not exist', nextMilestoneId })
  return { ok: true, mode: 'milestone', nextMilestoneId }
}

/**
 * Complete the handoff gate and make a compaction job ready to run.
 *
 * A job cannot become ready until a new milestone is durable or the caller
 * explicitly records that there is no next milestone.
 */
export function markHandoffReady(state, jobId, input = {}) {
  const doc = normalizeCompactionState(state)
  const found = jobOf(doc, jobId)
  if (found.ok !== true) return found
  if (found.job.status !== 'waiting_for_handoff') {
    return refusal('invalid-transition', { from: found.job.status, to: 'ready' })
  }
  const verdict = handoffGateVerdict(doc, jobId, input)
  if (verdict.ok !== true) return verdict
  const row = objectOf(input)
  const handoff = {
    status: 'complete',
    mode: verdict.mode,
    nextMilestoneId: verdict.nextMilestoneId,
    none: verdict.mode === 'none',
    contextRevision: numberOf(row.contextRevision, found.job.contextRevision),
    decisions: copyValue(arrayOf(row.decisions)),
    unresolved: copyValue(arrayOf(row.unresolved)),
    cursors: copyValue(objectOf(row.cursors)),
    firstStep: stringOf(row.firstStep),
    acceptance: arrayOf(row.acceptance).map(String),
    dependencies: arrayOf(row.dependencies).map(String),
    owner: stringOf(row.owner),
    scope: stringOf(row.scope),
    evidenceRefs: arrayOf(row.evidenceRefs).map(String),
    completedAt: numberOf(row.updatedAt, numberOf(doc.now, Date.now())),
  }
  found.job.handoff = handoff
  found.job.handoff_pending = false
  found.job.status = 'ready'
  found.job.contextRevision = handoff.contextRevision
  found.job.updatedAt = handoff.completedAt
  touch(doc, { kind: 'compaction/handoff-ready', jobId: found.job.jobId, nextMilestoneId: handoff.nextMilestoneId })
  return { ok: true, status: found.job.status, handoff: copyValue(handoff), job: copyValue(found.job) }
}

/** Move a ready job to running and count the attempt. */
export function startCompaction(state, jobId, input = {}) {
  const doc = normalizeCompactionState(state)
  const found = jobOf(doc, jobId)
  if (found.ok !== true) return found
  if (found.job.status !== 'ready') return refusal('invalid-transition', { from: found.job.status, to: 'running' })
  found.job.status = 'running'
  found.job.attempts = numberOf(found.job.attempts, 0) + 1
  found.job.startedAt = numberOf(input.startedAt, numberOf(doc.now, Date.now()))
  found.job.updatedAt = found.job.startedAt
  touch(doc, { kind: 'compaction/running', jobId: found.job.jobId, attempt: found.job.attempts })
  return { ok: true, status: found.job.status, job: copyValue(found.job) }
}

/** Complete a running compaction exactly once. */
export function completeCompaction(state, jobId, input = {}) {
  const doc = normalizeCompactionState(state)
  const found = jobOf(doc, jobId)
  if (found.ok !== true) return found
  if (found.job.status === 'completed') return { ok: true, deduplicated: true, status: 'completed', job: copyValue(found.job) }
  if (found.job.status !== 'running') return refusal('invalid-transition', { from: found.job.status, to: 'completed' })
  found.job.status = 'completed'
  found.job.completedAt = numberOf(input.completedAt, numberOf(doc.now, Date.now()))
  found.job.updatedAt = found.job.completedAt
  found.job.lastError = null
  touch(doc, { kind: 'compaction/completed', jobId: found.job.jobId })
  return { ok: true, deduplicated: false, status: 'completed', job: copyValue(found.job) }
}

/** Fail a running compaction while retaining the retryable job and context. */
export function failCompaction(state, jobId, input = {}) {
  const doc = normalizeCompactionState(state)
  const found = jobOf(doc, jobId)
  if (found.ok !== true) return found
  if (found.job.status === 'failed') return { ok: true, deduplicated: true, status: 'failed', job: copyValue(found.job) }
  if (found.job.status !== 'running') return refusal('invalid-transition', { from: found.job.status, to: 'failed' })
  found.job.status = 'failed'
  found.job.failedAt = numberOf(input.failedAt, numberOf(doc.now, Date.now()))
  found.job.updatedAt = found.job.failedAt
  found.job.lastError = stringOf(input.error?.message ?? input.error)
  touch(doc, { kind: 'compaction/failed', jobId: found.job.jobId })
  return { ok: true, deduplicated: false, status: 'failed', retryable: true, job: copyValue(found.job) }
}

/** Retry a failed job by putting it back at the queued state. */
export function retryCompaction(state, jobId, input = {}) {
  const doc = normalizeCompactionState(state)
  const found = jobOf(doc, jobId)
  if (found.ok !== true) return found
  if (found.job.status !== 'failed') return refusal('compaction-not-retryable', { status: found.job.status })
  found.job.status = 'queued'
  found.job.updatedAt = numberOf(input.updatedAt, numberOf(doc.now, Date.now()))
  found.job.lastError = null
  found.job.retryCount = numberOf(found.job.retryCount, 0) + 1
  touch(doc, { kind: 'compaction/retry-queued', jobId: found.job.jobId, retryCount: found.job.retryCount })
  return { ok: true, status: found.job.status, job: copyValue(found.job) }
}

/**
 * Persist an economic compaction decision without pretending it was a fold.
 *
 * Shadow mode records the same job shape as an enabled decision so the panel
 * and post-compaction audits can explain `economic` versus `deferred_*`
 * without changing the mandatory milestone/pressure state machine.
 */
export function recordCompactionDecision(state, input = {}) {
  const doc = normalizeCompactionState(state)
  const row = objectOf(input)
  const owner = stringOf(row.owner) || 'unknown'
  const sessionId = stringOf(row.sessionId) || 'session'
  const reason = stringOf(row.reason) || 'economic'
  const contextBucket = Math.floor(Math.max(0, numberOf(row.contextTokens, 0)) / 10000)
  const suffix = String(owner + ':' + sessionId + ':' + contextBucket + ':' + reason)
    .replace(/[^A-Za-z0-9_.:-]/g, '_')
  const jobId = stringOf(row.jobId) || 'economic:' + suffix
  const existing = doc.jobs[jobId]
  const now = numberOf(row.at, numberOf(doc.now, Date.now()))
  const job = existing ?? {
    jobId,
    milestoneId: row.milestoneId ?? null,
    trigger: 'economic',
    reason,
    status: 'completed',
    attempts: 0,
    handoff: null,
    handoff_pending: false,
    createdAt: now,
  }
  job.owner = owner
  job.sessionId = sessionId
  job.decision = row.decision === 'compact' ? 'compact' : 'defer'
  job.applied = row.applied === true
  job.reason = reason
  job.contextTokens = numberOf(row.contextTokens, 0)
  job.breakevenRequests = row.breakevenRequests ?? null
  job.estimatedRemainingRequests = row.estimatedRemainingRequests ?? null
  job.carriedDebtTokens = numberOf(row.carriedDebtTokens, 0)
  job.updatedAt = now
  job.completedAt = now
  doc.jobs[jobId] = job
  touch(doc, {
    kind: 'compaction/economic-decision',
    jobId,
    decision: job.decision,
    reason: job.reason,
    applied: job.applied,
  })
  return { ok: true, job: copyValue(job) }
}

/**
 * Allow emergency pressure compaction to bypass the ordinary handoff gate.
 *
 * The bypass never hides the missing handoff: `handoff_pending` stays true and
 * recovery must ask the owner to persist the next milestone or explicit none.
 */
export function bypassHandoffForPressure(state, jobId, input = {}) {
  const doc = normalizeCompactionState(state)
  const found = jobOf(doc, jobId)
  if (found.ok !== true) return found
  if (['completed', 'rejected'].includes(String(found.job.status))) {
    return refusal('invalid-transition', { from: found.job.status, to: 'ready' })
  }
  const row = objectOf(input)
  found.job.status = 'ready'
  found.job.trigger = 'pressure'
  found.job.reason = stringOf(row.reason) || 'context-pressure'
  found.job.handoff_pending = true
  found.job.handoffBypassedAt = numberOf(row.updatedAt, numberOf(doc.now, Date.now()))
  found.job.updatedAt = found.job.handoffBypassedAt
  found.job.handoff = found.job.handoff ?? {
    status: 'pending',
    mode: 'pressure-bypass',
    nextMilestoneId: null,
    none: false,
    contextRevision: found.job.contextRevision,
    decisions: [],
    unresolved: [],
    cursors: {},
    firstStep: '',
    acceptance: [],
    dependencies: [],
    owner: '',
    scope: '',
    evidenceRefs: [],
    completedAt: null,
  }
  touch(doc, { kind: 'compaction/handoff-bypassed', jobId: found.job.jobId, reason: found.job.reason })
  return { ok: true, status: found.job.status, handoff_pending: true, job: copyValue(found.job) }
}

/** Generic checked transition, useful to persistence adapters. */
export function transitionCompaction(state, jobId, nextStatus, input = {}) {
  const doc = normalizeCompactionState(state)
  const found = jobOf(doc, jobId)
  if (found.ok !== true) return found
  const from = String(found.job.status)
  const to = String(nextStatus)
  const allowed = COMPACTION_TRANSITIONS[from]
  if (allowed === undefined || !allowed.has(to)) return refusal('invalid-transition', { from, to })
  if (to === 'waiting_for_handoff') return waitForHandoff(doc, jobId, input)
  if (to === 'ready') return markHandoffReady(doc, jobId, input)
  if (to === 'running') return startCompaction(doc, jobId, input)
  if (to === 'completed') return completeCompaction(doc, jobId, input)
  if (to === 'failed') return failCompaction(doc, jobId, input)
  if (to === 'queued') return retryCompaction(doc, jobId, input)
  return refusal('invalid-transition', { from, to })
}

/**
 * Build the durable recovery payload after compaction.
 *
 * Recovery follows the current task, never an unrelated platform plan.
 */
export function buildCompactionResumeContext(state, input = {}) {
  const doc = normalizeCompactionState(state)
  const row = objectOf(input)
  const found = jobOf(doc, row.jobId)
  if (found.ok !== true) return found
  const milestone = doc.milestones[found.job.milestoneId]
  const nextMilestoneId = found.job.handoff?.nextMilestoneId ?? null
  const nextMilestone = nextMilestoneId === null ? null : doc.milestones[nextMilestoneId] ?? null
  const handoff = objectOf(found.job.handoff)
  return {
    ok: true,
    jobId: found.job.jobId,
    milestoneId: found.job.milestoneId,
    trigger: found.job.trigger,
    reason: found.job.reason,
    firstAction: COMPACTION_RECOVERY_FIRST_ACTION,
    requiredReads: milestone?.taskId ? [{ action: 'task_contract_get', task_id: milestone.taskId }] : [],
    recoveryDebt: milestone?.taskId ? [] : ['current-task-reference-unavailable'],
    planRecovery: copyValue(row.planRecovery ?? null),
    handoff_pending: found.job.handoff_pending === true,
    nextMilestoneId,
    nextMilestone: copyValue(nextMilestone),
    explicitNone: handoff.none === true,
    owner: handoff.owner || milestone?.owner || '',
    scope: handoff.scope || milestone?.scope || null,
    taskId: milestone?.taskId ?? null,
    goal: nextMilestone?.goal ?? milestone?.goal ?? '',
    acceptance: copyValue(arrayOf(handoff.acceptance).length > 0 ? handoff.acceptance : nextMilestone?.acceptance ?? milestone?.acceptance),
    dependencies: copyValue(arrayOf(handoff.dependencies).length > 0 ? handoff.dependencies : nextMilestone?.dependencies ?? milestone?.dependencies),
    firstStep: handoff.firstStep || nextMilestone?.firstStep || milestone?.firstStep || '',
    decisions: copyValue(arrayOf(handoff.decisions)),
    unresolved: copyValue(arrayOf(handoff.unresolved)),
    cursors: copyValue(objectOf(handoff.cursors)),
    evidenceRefs: copyValue(arrayOf(handoff.evidenceRefs)),
    contextRevision: numberOf(handoff.contextRevision, found.job.contextRevision),
    recoveryNote: found.job.handoff_pending === true
      ? 'handoff_pending: persist the next milestone or explicit none before treating recovery as complete'
      : null,
  }
}

/** Return a compact list of jobs that still need an execution boundary. */
export function pendingCompactions(state, options = {}) {
  const doc = normalizeCompactionState(state)
  const owner = stringOf(options.owner)
  const jobs = Object.values(doc.jobs)
    .filter((job) => !['completed', 'rejected'].includes(String(job.status)))
    .filter((job) => owner.length === 0 || doc.milestones[job.milestoneId]?.owner === owner)
    .sort((a, b) => numberOf(a.createdAt, 0) - numberOf(b.createdAt, 0))
    .map(copyValue)
  return { ok: true, jobs }
}
