/**
 * v12 evidence reuse and derived scheduling.
 *
 * This module deliberately owns no durable state. It turns task contracts,
 * evidence rows and runtime observations into deterministic views that the
 * control plane can persist or expose. Keeping the queue derived prevents it
 * from becoming a second, conflicting source of task truth.
 */

import { createHash } from 'node:crypto'
import { dependencySatisfied, resolveTaskDependency } from './team-control-plane.mjs'

const TERMINAL_TASKS = new Set(['completed', 'accepted', 'cancelled', 'expired', 'deleted'])
const TERMINAL_EVIDENCE = new Set(['passed', 'failed', 'stale', 'superseded'])
const ACTIVE_MEMBER_STATES = new Set(['active', 'busy', 'executing', 'running', 'thinking', 'working'])

const asArray = (value) => Array.isArray(value) ? value : []
const text = (value) => String(value ?? '').trim()
const unique = (values) => [...new Set(values.map(text).filter(Boolean))]
const lower = (value) => text(value).toLowerCase()

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}'
}

function digest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function overlaps(left, right) {
  const normalize = (scope) => text(scope).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  const a = normalize(left)
  const b = normalize(right)
  if (!a || !b) return false
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/')
}

function taskOwner(task) {
  if (task?.ownerName !== undefined && task?.ownerName !== null) return text(task.ownerName)
  if (task?.ownerName === null) return ''
  if (task?.owner !== undefined && task?.owner !== null) return text(task.owner)
  if (task?.owner === null) return ''
  return text(task?.contract?.owner)
}

function taskScopes(task) {
  const contract = task?.contract ?? task
  return unique(asArray(task?.writeScopes ?? contract?.writeScopes ?? task?.scopes))
}

function taskDependencies(task) {
  const contract = task?.contract ?? task
  return unique(asArray(task?.blockedBy ?? task?.blocked_by ?? contract?.dependencies))
}

function taskDependencyBlocked(task, context) {
  const dependencies = taskDependencies(task)
  if (dependencies.length === 0) return false
  const contract = task?.contract ?? task
  const requiredPhase = text(task?.dependencyPhase ?? contract?.dependencyPhase ?? 'accepted') || 'accepted'
  return dependencies.some((dependency) =>
    !dependencySatisfied(context.taskById.get(dependency), requiredPhase))
}

function taskBoardId(task) {
  return text(task?.board ?? task?.boardId ?? task?.contract?.board ?? task?.contract?.boardId ?? 'global') || 'global'
}

function taskKey(task) {
  return taskBoardId(task) + '\u0000' + text(task?.id ?? task?.taskId)
}

function taskWorktree(task) {
  const contract = task?.contract ?? task
  return text(task?.worktreePath ?? task?.worktree ?? contract?.worktreePath ?? contract?.worktree)
}

function sameWorktree(left, right) {
  const leftWorktree = taskWorktree(left)
  const rightWorktree = taskWorktree(right)
  return leftWorktree === rightWorktree || (!leftWorktree && !rightWorktree)
}

function scopesConflict(left, right) {
  return sameWorktree(left, right)
    && taskScopes(left).some((scope) => taskScopes(right).some((other) => overlaps(scope, other)))
}

export function taskStatus(task) {
  const status = lower(task?.status)
  const lifecycle = lower(task?.lifecycle)
  const phase = lower(task?.phase)
  // A terminal lifecycle must not be revived by a stale board projection.
  if (TERMINAL_TASKS.has(status)) return status
  if (TERMINAL_TASKS.has(lifecycle)) return lifecycle
  if (status) return status === 'in_progress' ? 'running' : status
  if (lifecycle) return lifecycle === 'in_progress' || lifecycle === 'execution' ? 'running' : lifecycle
  return phase === 'execution' ? 'running' : phase
}

function taskHeartbeatAt(task) {
  return Number(task?.heartbeatAt ?? task?.lastProgressAt ?? task?.updatedAt ?? task?.createdAt ?? 0)
}

function leaseIsLive(lease, now, staleExecutionMs) {
  if (lower(lease?.status) !== 'active') return false
  const expiresAt = Number(lease?.expiresAt ?? lease?.heartbeatDeadlineAt ?? 0)
  const heartbeatAt = Number(lease?.heartbeatAt ?? lease?.updatedAt ?? lease?.acquiredAt ?? 0)
  // An explicit lease deadline is authoritative. Heartbeat age is only a
  // fallback for older leases that do not carry an expiry.
  if (expiresAt > 0) {
    if (expiresAt <= now) return false
  } else if (heartbeatAt > 0 && heartbeatAt + staleExecutionMs <= now) {
    return false
  }
  const endedAt = Number(lease?.endedAt ?? lease?.releasedAt ?? 0)
  return endedAt <= 0 || endedAt > now
}

function memberIsLive(member) {
  return ACTIVE_MEMBER_STATES.has(lower(member?.status ?? member?.state))
}

function ownerUnavailable(member) {
  return member?.frozen === true || ['failed', 'frozen', 'inactive', 'stopped', 'terminated'].includes(lower(member?.status ?? member?.state))
}

function taskAcceptance(task) {
  const contract = task?.contract ?? task
  return asArray(contract?.acceptanceCriteria ?? task?.acceptanceCriteria ?? task?.acceptance_criteria)
    .map((item, index) => typeof item === 'string'
      ? { id: 'ac-' + String(index + 1), text: text(item), required: true }
      : {
          id: text(item?.id || 'ac-' + String(index + 1)),
          text: text(item?.text ?? item?.criterion ?? item?.description),
          required: item?.required !== false,
        })
    .filter((item) => item.text.length > 0)
}

function evidenceEnvironment(row) {
  return stableJson({
    profile: row?.profile ?? row?.environment?.profile,
    runtime: row?.runtime ?? row?.environment?.runtime,
    platform: row?.platform ?? row?.environment?.platform,
    dependencies: row?.dependencies ?? row?.environment?.dependencies ?? [],
  })
}

export function evidenceFingerprint(row) {
  return digest({
    requirementId: text(row?.requirementId ?? row?.requirement_id),
    recipeId: text(row?.recipeId ?? row?.recipe_id),
    recipeFingerprint: text(row?.recipeFingerprint ?? row?.recipe_fingerprint),
    commitSha: text(row?.commitSha ?? row?.commit_sha),
    treeHash: text(row?.treeHash ?? row?.tree_hash),
    command: text(row?.command),
    fixtureHash: text(row?.fixtureHash ?? row?.fixture_hash),
    environment: evidenceEnvironment(row),
  })
}

export function createEvidenceRegistry(rows = []) {
  const registry = { version: 1, records: {} }
  for (const row of rows) registerEvidence(registry, row)
  return registry
}

export function registerEvidence(registry, input) {
  if (!registry || typeof registry !== 'object') throw new Error('evidence registry is required')
  if (!registry.records || typeof registry.records !== 'object') registry.records = {}
  const row = { ...input }
  const id = text(row.id) || 'evidence-' + evidenceFingerprint(row).slice(0, 16)
  const fingerprint = evidenceFingerprint(row)
  const existing = registry.records[id]
  const status = text(row.status) || (row.result === false ? 'failed' : 'passed')
  const record = {
    ...existing,
    ...row,
    id,
    fingerprint,
    status,
    recordedAt: Number(row.recordedAt ?? Date.now()),
    evidenceRef: row.evidenceRef ?? row.evidence_ref ?? null,
    staleReasons: unique([...(existing?.staleReasons ?? []), ...(row.staleReasons ?? [])]),
  }
  registry.records[id] = record
  return record
}

export function invalidateEvidence(registry, change) {
  if (!registry || !registry.records) return []
  const taskId = text(change?.taskId)
  const commitSha = text(change?.commitSha)
  const treeHash = text(change?.treeHash)
  const profile = text(change?.profile)
  const dependencies = stableJson(change?.dependencies ?? [])
  const changed = []
  for (const row of Object.values(registry.records)) {
    if (TERMINAL_EVIDENCE.has(lower(row.status)) && lower(row.status) !== 'passed') continue
    const reasons = []
    if (taskId && text(row.taskId) === taskId && commitSha && text(row.commitSha) !== commitSha) reasons.push('commit-changed')
    if (taskId && text(row.taskId) === taskId && treeHash && text(row.treeHash) !== treeHash) reasons.push('tree-changed')
    if (profile && text(row.profile) && text(row.profile) !== profile) reasons.push('profile-changed')
    if (dependencies !== '[]' && evidenceEnvironment(row) !== dependencies) reasons.push('environment-changed')
    if (reasons.length === 0) continue
    row.status = 'stale'
    row.staleReasons = unique([...(row.staleReasons ?? []), ...reasons])
    changed.push(row)
  }
  return changed
}

export function queryEvidence(registry, query = {}) {
  if (!registry || !registry.records) return []
  const exact = query.exact === true
  const wanted = evidenceFingerprint(query)
  const id = query.id ?? query.evidenceId ?? query.evidence_id
  const taskId = query.taskId ?? query.task_id
  const taskIds = query.taskIds ?? query.task_ids
  if (taskIds !== undefined && (!Array.isArray(taskIds) || taskIds.some((id) => typeof id !== 'string'))) throw new Error('taskIds must be an array of exact task ids')
  if (query.changed_since !== undefined && (!Number.isSafeInteger(query.changed_since) || query.changed_since < 0)) throw new Error('changed_since must be a non-negative timestamp in milliseconds')
  const requirementId = query.requirementId ?? query.requirement_id
  const recipeId = query.recipeId ?? query.recipe_id
  const recipeFingerprint = query.recipeFingerprint ?? query.recipe_fingerprint
  const commitSha = query.commitSha ?? query.commit_sha
  const treeHash = query.treeHash ?? query.tree_hash
  const status = query.status
  const kind = query.kind
  const hasFilter = exact || taskIds !== undefined || query.changed_since !== undefined || [id, taskId, requirementId, recipeId, recipeFingerprint, commitSha, treeHash, status, kind]
    .some((value) => text(value).length > 0)
  if (!hasFilter) return []
  const limit = Math.max(1, Math.min(1000, Number(query.limit) || 100))
  return Object.values(registry.records)
    .filter((row) => {
      if (taskIds !== undefined && !taskIds.includes(String(row.taskId))) return false
      if (query.changed_since !== undefined && Number(row.updatedAt ?? row.recordedAt ?? 0) <= query.changed_since) return false
      if (exact) return row.fingerprint === wanted
      if (id && text(row.id) !== text(id) && text(row.evidenceId) !== text(id)) return false
      if (taskId && text(row.taskId) !== text(taskId)) return false
      if (requirementId && text(row.requirementId) !== text(requirementId)) return false
      if (recipeId && text(row.recipeId) !== text(recipeId)) return false
      if (recipeFingerprint && text(row.recipeFingerprint) !== text(recipeFingerprint)) return false
      if (commitSha && text(row.commitSha) !== text(commitSha)) return false
      if (treeHash && text(row.treeHash) !== text(treeHash)) return false
      if (status && text(row.status) !== text(status)) return false
      if (kind && text(row.kind) !== text(kind)) return false
      return true
    })
    .sort((left, right) => Number(left.recordedAt ?? 0) - Number(right.recordedAt ?? 0))
    .slice(-limit)
    .map((row) => ({ ...row }))
}

/**
 * Resolve an evidence id without collapsing malformed, missing, unique-prefix
 * and ambiguous-prefix cases into the same empty result.
 */
export function resolveEvidenceId(registry, rawId) {
  const requested = text(rawId)
  if (requested.length === 0) {
    return {
      status: 'not-requested',
      form: 'none',
      accepted: true,
      query: requested,
      candidateCount: 0,
      matchedIds: [],
      rows: [],
    }
  }
  const records = registry && registry.records ? Object.values(registry.records) : []
  const ids = unique(records.flatMap((row) => [
    text(row?.id),
    text(row?.evidenceId),
  ]).filter((value) => value.length > 0))
  const lower = requested.toLowerCase()
  const exact = ids.filter((id) => id.toLowerCase() === lower)
  if (exact.length === 1) {
    const resolvedId = exact[0]
    return {
      status: 'resolved',
      form: 'full-id',
      accepted: true,
      query: requested,
      resolvedId,
      candidateCount: 1,
      matchedIds: [resolvedId],
      rows: queryEvidence(registry, { id: resolvedId }),
    }
  }

  const prefixMatches = ids.filter((id) => id.toLowerCase().startsWith(lower))
  if (prefixMatches.length === 1) {
    const resolvedId = prefixMatches[0]
    return {
      status: 'resolved-prefix',
      form: 'prefix',
      accepted: true,
      query: requested,
      resolvedId,
      candidateCount: 1,
      matchedIds: [resolvedId],
      rows: queryEvidence(registry, { id: resolvedId }),
    }
  }
  if (prefixMatches.length > 1) {
    const candidates = prefixMatches.slice(0, 20)
    return {
      status: 'ambiguous',
      form: 'prefix',
      accepted: true,
      query: requested,
      candidateCount: prefixMatches.length,
      matchedIds: [],
      candidates,
      detail: 'evidence id prefix "' + requested + '" matches ' + String(prefixMatches.length)
        + ' records; use a longer prefix or the full id',
      rows: [],
    }
  }

  const prefixLike = /^(?:evidence-)?[0-9a-f]{4,36}(?:-[0-9a-f]{1,12}){0,4}$/i.test(requested)
  if (prefixLike) {
    return {
      status: 'not-found',
      form: 'prefix',
      accepted: true,
      query: requested,
      candidateCount: 0,
      matchedIds: [],
      detail: 'no evidence id starts with "' + requested + '"',
      rows: [],
    }
  }

  const detail = 'evidence id must be a full id or an unambiguous id prefix'
  return {
    status: 'invalid-id',
    form: 'invalid',
    accepted: false,
    query: requested,
    candidateCount: 0,
    matchedIds: [],
    formRejected: {
      code: 'evidence-id-form',
      detail,
      expected: 'evidence-<uuid> or an unambiguous prefix',
      actual: requested,
    },
    detail,
    rows: [],
  }
}

export function buildAcceptanceMatrix(task, evidenceRegistry) {
  const criteria = taskAcceptance(task)
  const rows = criteria.map((criterion) => {
    const matches = queryEvidence(evidenceRegistry, {
      exact: false,
      requirementId: criterion.id,
    })
    const usable = matches.filter((row) => lower(row.status) === 'passed')
    return {
      requirementId: criterion.id,
      criterion: criterion.text,
      required: criterion.required,
      covered: usable.length > 0,
      evidence: usable,
      staleEvidence: matches.filter((row) => lower(row.status) === 'stale'),
    }
  })
  const uncovered = rows.filter((row) => row.required && !row.covered).map((row) => row.requirementId)
  return {
    taskId: task?.id ?? task?.taskId ?? null,
    revision: Number(task?.revision ?? task?.contract?.revision ?? 0),
    rows,
    covered: uncovered.length === 0,
    uncovered,
  }
}

export function buildReviewPackage(tasks, evidenceRegistry) {
  const deduped = new Map()
  const matrices = []
  for (const task of asArray(tasks)) {
    const matrix = buildAcceptanceMatrix(task, evidenceRegistry)
    matrices.push(matrix)
    for (const criterion of matrix.rows) {
      for (const evidence of criterion.evidence) {
        const key = evidence.id
        const existing = deduped.get(key) ?? { ...evidence, requirements: [], tasks: [] }
        existing.requirements = unique([...existing.requirements, criterion.requirementId])
        existing.tasks = unique([...existing.tasks, text(task.id ?? task.taskId)])
        deduped.set(key, existing)
      }
    }
  }
  return {
    tasks: asArray(tasks).map((task) => text(task.id ?? task.taskId)),
    matrices,
    evidence: [...deduped.values()].sort((a, b) => a.id.localeCompare(b.id)),
    complete: matrices.every((matrix) => matrix.covered),
    blockers: matrices.flatMap((matrix) => matrix.uncovered.map((id) => ({ taskId: matrix.taskId, requirementId: id }))),
  }
}

const VERIFICATION_RECIPES = Object.freeze([
  {
    id: 'api-state-machine',
    title: 'API and state-machine contract',
    match: /(api|http|rpc|state|machine|transition|lifecycle|contract|schema)/i,
    checks: [
      { id: 'happy-path', text: 'Exercise the documented success path and assert the observable contract.' },
      { id: 'invalid-input', text: 'Exercise invalid input and assert a stable refusal/error shape.' },
      { id: 'illegal-transition', text: 'Attempt at least one illegal or stale transition and assert no partial mutation.' },
      { id: 'idempotency', text: 'Repeat the mutating call and verify idempotency or an explicit conflict result.' },
    ],
  },
  {
    id: 'persistence-migration',
    title: 'Persistence and migration safety',
    match: /(migration|migrate|persist|storage|database|sqlite|journal|schema-version|durable)/i,
    checks: [
      { id: 'old-format-read', text: 'Load a representative old-format fixture and assert a lossless migration.' },
      { id: 'replay-idempotent', text: 'Replay the migration and assert stable output and no duplicate records.' },
      { id: 'interrupted-write', text: 'Simulate interruption around the write boundary and assert recovery.' },
      { id: 'roundtrip', text: 'Read back the migrated state and assert the durable postcondition.' },
    ],
  },
  {
    id: 'rust-library',
    title: 'Rust library and crate behavior',
    match: /(rust|cargo|crate|library|lib\.rs|module|trait|struct|enum)/i,
    checks: [
      { id: 'focused-cargo-check', text: 'Run the narrowest cargo check/test command for the changed crate or module.' },
      { id: 'behavior-boundary', text: 'Exercise the changed behavior at its public boundary and assert the observable result.' },
      { id: 'negative-case', text: 'Exercise an invalid, boundary or failure case and assert a stable result.' },
      { id: 'postcondition', text: 'Read back the durable or user-visible postcondition after the operation.' },
    ],
  },
  {
    id: 'ui-visual',
    title: 'UI behavior and visual state',
    match: /(ui|panel|browser|render|visual|screen|layout|css|component|frontend)/i,
    checks: [
      { id: 'primary-flow', text: 'Complete the primary user flow in the real consuming surface.' },
      { id: 'empty-error-loading', text: 'Verify empty, loading, error and disabled states.' },
      { id: 'responsive', text: 'Verify the target desktop and mobile viewport without clipping or overlap.' },
      { id: 'screenshot', text: 'Capture a screenshot or pixel check for the claimed visual result.' },
    ],
  },
  {
    id: 'build-integration',
    title: 'Build and integration boundary',
    match: /(build|compile|integration|merge|package|bundle|link|dependency|release)/i,
    checks: [
      { id: 'focused-build', text: 'Run the narrowest build/compile check that exercises the changed boundary.' },
      { id: 'focused-tests', text: 'Run focused tests against the changed module or contract.' },
      { id: 'integration-smoke', text: 'Run an integration smoke test through the real entry point.' },
      { id: 'artifact-hash', text: 'Record the artifact, revision or exact SHA used by the evidence.' },
    ],
  },
  {
    id: 'generic-verification',
    title: 'Generic change verification',
    match: /.*/,
    checks: [
      { id: 'focused-check', text: 'Run a focused check that can fail if the claimed behavior is wrong.' },
      { id: 'negative-case', text: 'Exercise one negative or boundary case.' },
      { id: 'postcondition', text: 'Read back the user-visible or durable postcondition.' },
    ],
  },
])

function taskChangeText(task) {
  const contract = task?.contract ?? task
  return [
    task?.changeType,
    task?.change_type,
    task?.workKind,
    task?.kind,
    contract?.kind,
    task?.subject,
    task?.title,
    contract?.deliverable,
    ...taskScopes(task),
    ...taskAcceptance(task).map((item) => item.text),
  ].map(text).filter(Boolean).join(' ')
}

export function selectVerificationRecipe(task) {
  const source = taskChangeText(task)
  const recipe = VERIFICATION_RECIPES.find((row) => row.match.test(source)) ?? VERIFICATION_RECIPES.at(-1)
  return { ...recipe, checks: recipe.checks.map((row) => ({ ...row })) }
}

export function recipeFingerprint(task, recipe = selectVerificationRecipe(task)) {
  return digest({
    taskId: text(task?.id ?? task?.taskId),
    revision: Number(task?.revision ?? task?.contract?.revision ?? 0),
    acceptance: taskAcceptance(task),
    scopes: taskScopes(task),
    riskLevel: text(task?.riskLevel ?? task?.risk_level ?? task?.contract?.riskLevel),
    recipeId: text(recipe?.id),
    recipeVersion: Number(recipe?.version ?? 1),
    checks: asArray(recipe?.checks).map((row) => ({ id: text(row.id), text: text(row.text) })),
  })
}

export function buildVerificationPlan(task, options = {}) {
  const recipe = options.recipe ?? selectVerificationRecipe(task)
  const fingerprint = recipeFingerprint(task, recipe)
  const taskIdValue = text(task?.id ?? task?.taskId)
  const checks = asArray(recipe.checks).map((row, index) => ({
    requirementId: text(row.id) || 'check-' + String(index + 1),
    text: text(row.text),
    required: row.required !== false,
    evidenceRequirement: text(taskIdValue) + ':' + (text(row.id) || 'check-' + String(index + 1)),
  }))
  return {
    taskId: taskIdValue,
    revision: Number(task?.revision ?? task?.contract?.revision ?? 0),
    recipeId: text(recipe.id),
    recipeTitle: text(recipe.title),
    recipeFingerprint: fingerprint,
    checks,
    exactShaRequired: options.exactShaRequired !== false,
    generatedAt: Number(options.now ?? Date.now()),
  }
}

export function reuseEvidenceForPlan(plan, registry, options = {}) {
  const commitSha = text(options.commitSha ?? plan?.commitSha)
  const treeHash = text(options.treeHash ?? plan?.treeHash)
  const rows = asArray(plan?.checks).map((check) => {
    const matches = queryEvidence(registry, {
      exact: false,
      requirementId: check.evidenceRequirement,
      recipeId: plan.recipeId,
      recipeFingerprint: plan.recipeFingerprint,
      commitSha,
    })
    const reusable = matches.filter((row) => lower(row.status) === 'passed'
      && (!commitSha || text(row.commitSha) === commitSha)
      && (!treeHash || text(row.treeHash) === treeHash))
    return {
      requirementId: check.requirementId,
      evidenceRequirement: check.evidenceRequirement,
      required: check.required,
      reusable: reusable.length > 0,
      evidence: reusable,
      staleEvidence: matches.filter((row) => lower(row.status) === 'stale'),
    }
  })
  return {
    taskId: plan?.taskId ?? null,
    recipeId: plan?.recipeId ?? null,
    recipeFingerprint: plan?.recipeFingerprint ?? null,
    commitSha: commitSha || null,
    treeHash: treeHash || null,
    checks: rows,
    complete: rows.every((row) => !row.required || row.reusable),
    missing: rows.filter((row) => row.required && !row.reusable).map((row) => row.requirementId),
  }
}

export function estimateTaskEffort(task, history = [], options = {}) {
  const category = text(task?.changeType ?? task?.kind ?? task?.contract?.kind ?? 'generic').toLowerCase()
  const samples = asArray(history).filter((row) => {
    const sampleCategory = text(row?.changeType ?? row?.kind ?? row?.contract?.kind ?? 'generic').toLowerCase()
    return sampleCategory === category && Number(row?.durationMs ?? row?.elapsedMs ?? row?.effortMs) > 0
  })
  const values = samples.map((row) => Number(row.durationMs ?? row.elapsedMs ?? row.effortMs))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right)
  if (values.length === 0) {
    return {
      estimateMs: null,
      confidence: 'unknown',
      basis: 'no comparable historical tasks',
      sampleCount: 0,
    }
  }
  const middle = Math.floor(values.length / 2)
  const estimateMs = values.length % 2 === 1 ? values[middle] : (values[middle - 1] + values[middle]) / 2
  return {
    estimateMs: Math.round(estimateMs),
    confidence: values.length >= 5 ? 'high' : values.length >= 2 ? 'medium' : 'low',
    basis: 'median of comparable historical tasks',
    sampleCount: values.length,
    sourceTaskIds: samples.map((row) => text(row.id ?? row.taskId)).filter(Boolean).slice(0, 10),
    category,
    now: Number(options.now ?? Date.now()),
  }
}

function independentFanOutParts(task) {
  const contract = task?.contract ?? task
  return asArray(task?.children ?? task?.subtasks ?? contract?.children ?? contract?.subtasks)
    .map((row) => {
      const value = typeof row === 'string' ? { id: row } : row
      const childContract = value?.contract ?? value
      return {
        id: text(value?.id ?? value?.taskId),
        owner: text(value?.owner ?? value?.ownerName ?? childContract?.owner),
        deliverable: text(value?.deliverable ?? childContract?.deliverable),
        acceptance: asArray(value?.acceptanceCriteria ?? childContract?.acceptanceCriteria),
        scopes: taskScopes(value),
      }
    })
    .filter((row) => row.id)
}

export function checkFanOut(task, options = {}) {
  const parts = independentFanOutParts(task)
  const reasons = []
  if (parts.length < 2) reasons.push('fewer-than-two-child-deliverables')
  if (parts.some((row) => !row.owner)) reasons.push('child-owner-missing')
  if (parts.some((row) => !row.deliverable)) reasons.push('independent-deliverable-missing')
  if (parts.some((row) => row.acceptance.length === 0)) reasons.push('child-acceptance-missing')
  for (let left = 0; left < parts.length; left += 1) {
    for (let right = left + 1; right < parts.length; right += 1) {
      if (parts[left].scopes.some((a) => parts[right].scopes.some((b) => overlaps(a, b)))) {
        reasons.push('child-scope-conflict:' + parts[left].id + ',' + parts[right].id)
      }
    }
  }
  const baseEffort = estimateTaskEffort(task, options.history ?? [], options)
  const parallelEffort = baseEffort.estimateMs === null
    ? null
    : Math.round(baseEffort.estimateMs / Math.max(1, parts.length))
  const coordinationCost = {
    additionalHandoffs: Math.max(0, parts.length - 1),
    integrationPoints: parts.length,
    confidence: baseEffort.confidence,
  }
  const recommend = reasons.length === 0
  return {
    taskId: text(task?.id ?? task?.taskId),
    recommend,
    reasons: recommend ? ['independent-deliverables-with-disjoint-scopes'] : [...new Set(reasons)],
    parts,
    baseEffort,
    estimatedParallelEffortMs: parallelEffort,
    coordinationCost,
    comparison: baseEffort.estimateMs === null
      ? 'parallel benefit unknown until comparable history exists'
      : 'compare serial estimate with parallel estimate plus coordination/integration cost',
  }
}

export function buildSchedulerAdvice(tasks, members = [], leases = [], options = {}) {
  const history = asArray(options.history)
  const queue = buildReadyQueue(tasks, members, leases, options)
  const enriched = {
    ...queue,
    ready: queue.ready.map((row) => {
      const task = asArray(tasks).find((candidate) => text(candidate?.id ?? candidate?.taskId) === row.id) ?? row
      const effort = estimateTaskEffort(task, history, options)
      const fanOut = checkFanOut(task, { history, now: options.now })
      return { ...row, effort, fanOut }
    }),
  }
  const activeCount = queue.counts.active
  const readyGroups = []
  for (const row of enriched.ready) {
    const group = readyGroups.find((candidate) => candidate.every((other) =>
      !row.scopes.some((left) => other.scopes.some((right) => overlaps(left, right)))))
    if (group) group.push(row)
    else readyGroups.push([row])
  }
  const cap = Math.max(1, Number(options.maxConcurrency ?? options.cap ?? 8))
  const minimum = Math.max(0, Number(options.minConcurrency ?? 1))
  const rawTarget = Math.max(minimum, Math.min(cap, activeCount + enriched.ready.length))
  const current = Number(options.currentConcurrency ?? activeCount)
  const hysteresis = Math.max(0, Number(options.hysteresis ?? 1))
  const cooldownMs = Math.max(0, Number(options.cooldownMs ?? 60000))
  const lastChangeAt = Number(options.lastChangeAt ?? 0)
  const cooledDown = Number(options.now ?? Date.now()) - lastChangeAt >= cooldownMs
  const changed = cooledDown && Math.abs(rawTarget - current) >= Math.max(1, hysteresis)
  const targetConcurrency = changed ? rawTarget : current
  const mode = options.apply === true ? 'apply' : 'shadow'
  const stalledTasks = queue.blocked
    .filter((row) => row.stalled === true || row.executionState === 'stalled')
    .map((row) => ({
      taskId: row.id,
      owner: row.owner || null,
      executionState: row.executionState,
      reasons: [...row.reasons],
    }))
  return {
    generatedAt: Number(options.now ?? Date.now()),
    mode,
    queueRevision: enriched.revision,
    activeCount,
    readyGroups: readyGroups.map((group) => group.map((row) => row.id)),
    currentConcurrency: current,
    targetConcurrency,
    proposedConcurrency: rawTarget,
    changed,
    cooldownMs,
    hysteresis,
    reasons: [
      'active=' + String(activeCount),
      'ready-groups=' + String(readyGroups.length),
      'stalled=' + String(queue.counts.stalled),
      'blocked=' + String(queue.counts.blocked),
      'cap=' + String(cap),
      changed ? 'target-change-passed-cooldown-and-hysteresis' : 'target-held-stable',
    ],
    fanOut: enriched.ready.map((row) => row.fanOut),
    executorInactive: stalledTasks.length > 0,
    stalledTasks,
    criticalPath: enriched.ready.map((row) => ({
      id: row.id,
      criticality: row.criticality,
      unlocks: row.unlocks,
      estimateMs: row.effort.estimateMs,
      confidence: row.effort.confidence,
    })),
    applyAllowed: options.apply === true,
    manualOverride: options.manualOverride === true,
  }
}

export function createReadyQueueContext(tasks, members = [], leases = [], options = {}) {
  const taskRows = asArray(tasks)
  const now = Number(options.now ?? Date.now())
  const staleExecutionMs = Math.max(1000, Number(options.staleExecutionMs ?? 15 * 60 * 1000))
  const completed = new Set(taskRows.filter((task) => dependencySatisfied(task)).map((task) => text(task.id ?? task.taskId)))
  const memberRows = new Map(asArray(members).map((member) => [text(member.name ?? member.id), member]))
  const taskById = new Map()
  const boards = {}
  for (const task of taskRows) {
    const boardId = taskBoardId(task)
    const taskId = text(task.id ?? task.taskId)
    boards[boardId] ??= { boardId, tasks: {} }
    boards[boardId].tasks[taskId] = task
    if (!taskById.has(taskId)) taskById.set(taskId, task)
  }
  const planRows = options.planByTask instanceof Map
    ? options.planByTask
    : new Map(Object.entries(options.plans ?? {}).map(([taskId, plan]) => [text(taskId), plan]))
  const activeLeases = new Map()
  const activeLeasesByTask = new Map()
  for (const lease of asArray(leases).filter((row) => leaseIsLive(row, now, staleExecutionMs))) {
    const memberName = text(lease.member)
    const taskIdValue = text(lease.taskId)
    if (memberName) activeLeases.set(memberName, lease)
    if (taskIdValue) activeLeasesByTask.set(taskIdValue, lease)
  }
  const activeTaskIds = new Set()
  for (const task of taskRows) {
    if (taskStatus(task) !== 'running') continue
    const id = text(task.id ?? task.taskId)
    const ownerName = taskOwner(task)
    const lease = activeLeasesByTask.get(id) ?? activeLeases.get(ownerName)
    if (lease && !ownerUnavailable(memberRows.get(ownerName))) {
      activeTaskIds.add(id)
      continue
    }
    const heartbeatAt = taskHeartbeatAt(task)
    if (heartbeatAt > 0 && heartbeatAt + staleExecutionMs > now && memberIsLive(memberRows.get(ownerName))) {
      activeTaskIds.add(id)
    }
  }
  const running = taskRows.filter((task) => activeTaskIds.has(text(task.id ?? task.taskId)))
  const statusRunning = taskRows.filter((task) => taskStatus(task) === 'running')
  const executionState = new Map()
  const stalled = []
  for (const task of statusRunning) {
    const id = text(task.id ?? task.taskId)
    const ownerName = taskOwner(task)
    const owner = memberRows.get(ownerName)
    if (activeTaskIds.has(id)) {
      executionState.set(id, 'active')
      continue
    }
    const liveLease = activeLeasesByTask.get(id) ?? activeLeases.get(ownerName)
    if (liveLease) {
      executionState.set(id, 'suspended-between-rounds')
      continue
    }
    if (!ownerName || (memberRows.size > 0 && !owner)) {
      executionState.set(id, 'needs-owner')
      continue
    }
    const ageMs = Math.max(0, now - taskHeartbeatAt(task))
    if (ownerUnavailable(owner) || ageMs >= staleExecutionMs) {
      executionState.set(id, 'stalled')
      stalled.push(task)
    } else {
      executionState.set(id, 'idle-resume')
    }
  }
  const dependencyCounts = new Map()
  for (const task of taskRows) {
    for (const dependency of taskDependencies(task)) {
      const resolved = resolveTaskDependency(boards, taskBoardId(task), dependency)
      const key = resolved.found
        ? resolved.boardId + '\u0000' + resolved.taskId
        : taskBoardId(task) + '\u0000' + dependency
      dependencyCounts.set(key, Number(dependencyCounts.get(key) ?? 0) + 1)
    }
  }
  return {
    tasks: taskRows,
    taskById,
    boards,
    planByTask: planRows,
    completed,
    memberRows,
    activeLeases,
    activeLeasesByTask,
    activeTaskIds,
    running,
    statusRunning,
    executionState,
    stalled,
    now,
    staleExecutionMs,
    dependencyCounts,
  }
}

/**
 * Project run leases through the caller's visibility boundary.
 *
 * A member needs to answer whether it currently holds a lease; tier 0 may
 * inspect the full table. The projection deliberately keeps taskId and runId
 * visible so the caller can avoid retrying a write whose lock is still live.
 */
export function projectLeasesForMember(leases, options = {}) {
  const member = text(options.member)
  const taskId = text(options.taskId)
  const status = lower(options.status)
  const tier = Number(options.tier)
  return asArray(leases)
    .filter((lease) => {
      if (tier === 0 && member.length === 0) return true
      return text(lease?.member) === member
    })
    .filter((lease) => taskId.length === 0 || text(lease?.taskId) === taskId)
    .filter((lease) => status.length === 0 || lower(lease?.status) === status)
    .map((lease) => ({
      runId: text(lease?.runId ?? lease?.leaseId) || null,
      member: text(lease?.member ?? lease?.owner) || null,
      taskId: text(lease?.taskId) || null,
      status: lower(lease?.status) || 'unknown',
      acquiredAt: Number(lease?.acquiredAt ?? 0) || null,
      expiresAt: Number(lease?.expiresAt ?? lease?.heartbeatDeadlineAt ?? 0) || null,
      endedAt: Number(lease?.endedAt ?? 0) || null,
    }))
    .sort((left, right) => Number(right.acquiredAt ?? 0) - Number(left.acquiredAt ?? 0))
}

/**
 * Evaluate one task against a precomputed queue context.
 *
 * Continuation recovery needs the same eligibility rules for many candidate
 * views. Building the context once avoids rescanning and re-hashing the full
 * task/member/lease set for every candidate.
 */
export function evaluateReadyTask(task, context, options = {}) {
  const status = lower(options.status ?? taskStatus(task))
  if (TERMINAL_TASKS.has(status)) return null
  const id = text(task.id ?? task.taskId)
  const boardId = taskBoardId(task)
  const contract = task.contract ?? task
  const owner = taskOwner(task)
  const dependencies = taskDependencies(task)
  const requiredPhase = text(task.dependencyPhase ?? contract.dependencyPhase ?? 'accepted') || 'accepted'
  const dependencyGate = dependencies.map((dependency) => {
    const resolved = resolveTaskDependency(context.boards, boardId, dependency)
    const blocker = resolved.task
    return {
      id: dependency,
      requiredPhase,
      status: lower(blocker?.status ?? ''),
      phase: lower(blocker?.phase ?? ''),
      satisfied: dependencySatisfied(blocker, requiredPhase),
      ...(resolved.qualified ? {
        boardId: resolved.boardId,
        taskId: resolved.taskId,
        qualified: true,
      } : {}),
    }
  })
  const unmet = dependencyGate.filter((dependency) => dependency.satisfied !== true)
    .map((dependency) => dependency.id)
  const reasons = []
  const executionState = context.executionState?.get(id) ?? (status === 'running' ? 'idle-resume' : null)
  if (status === 'running' && executionState === 'active') reasons.push('already-running')
  const lifecycle = lower(task.lifecycle ?? contract.lifecycle)
  const phase = lower(task.phase ?? contract.phase)
  if (lifecycle === 'blocked' || phase === 'blocked') reasons.push('blocked-phase')
  const approvalRequired = lower(task.lifecycle ?? '') === 'proposed'
    && !['plan-approved', 'execution'].includes(lower(task.phase))
    && task.approved !== true
  const plan = context.planByTask?.get(id)
  const approvalReason = approvalRequired
    ? (plan === undefined ? 'no-plan' : lower(plan.state) === 'plan-approved' ? null : 'plan-not-approved')
    : null
  if (approvalReason !== null) reasons.push(approvalReason)
  if (!owner) reasons.push('no-owner')
  if (owner && context.memberRows.size > 0 && !context.memberRows.has(owner)) reasons.push('owner-unavailable')
  if (owner && context.activeLeases.get(owner) && text(context.activeLeases.get(owner).taskId) !== id) reasons.push('owner-busy')
  if (unmet.length > 0) reasons.push('dependencies-unmet')
  if (!asArray(contract.acceptanceCriteria ?? contract.acceptance_criteria).length) reasons.push('no-acceptance')
  const explicitEmptyPlan = lower(plan?.state) === 'plan-approved'
    && Array.isArray(plan.writeScopes)
    && plan.writeScopes.length === 0
  if (lower(contract.kind) === 'edit' && taskScopes(task).length === 0 && !explicitEmptyPlan) {
    reasons.push('no-write-scope')
  }
  const running = asArray(options.running ?? context.running)
  for (const active of running) {
    if (text(active.id ?? active.taskId) === id) continue
    if (taskDependencyBlocked(active, context)) continue
    if (scopesConflict(active, task)) {
      reasons.push('scope-conflict:' + text(active.id ?? active.taskId))
      break
    }
  }
  const row = {
    id,
    boardId,
    owner,
    status,
    executionState,
    ...(() => {
      const taskLease = context.activeLeasesByTask.get(id)
      const memberLease = taskLease === undefined ? context.activeLeases.get(owner) : undefined
      const activeLease = taskLease ?? memberLease
      const leaseExpiresAt = (lease) => Number(lease?.expiresAt ?? lease?.heartbeatDeadlineAt ?? 0) || null
      return {
        leaseScope: taskLease ? 'task' : memberLease ? 'member' : null,
        leaseTaskId: text(taskLease?.taskId) || null,
        leaseMember: text(activeLease?.member ?? activeLease?.owner) || null,
        taskLeaseActive: Boolean(taskLease),
        taskLeaseExpiresAt: leaseExpiresAt(taskLease),
        memberLeaseActive: Boolean(memberLease),
        memberLeaseExpiresAt: leaseExpiresAt(memberLease),
        leaseActive: Boolean(activeLease),
        leaseExpiresAt: leaseExpiresAt(activeLease),
      }
    })(),
    stale: executionState === 'stalled'
      && !Boolean(context.activeLeasesByTask.get(id) ?? context.activeLeases.get(owner)),
    worktree: taskWorktree(task),
    lifecycle: text(task.lifecycle ?? ''),
    approvalGate: {
      required: approvalRequired,
      satisfied: approvalReason === null,
      reason: approvalReason,
      planState: plan === undefined ? null : text(plan.state) || null,
    },
    priority: Number(task.priority ?? contract.priority ?? 0),
    dependencies,
    dependencyGate,
    unmet,
    scopes: taskScopes(task),
    reasons,
    eligible: reasons.length === 0,
  }
  if (row.eligible) {
    row.unlocks = Number(context.dependencyCounts.get(taskKey(task)) ?? 0)
    row.criticality = row.unlocks * 1000 + row.priority
  }
  return row
}

export function buildReadyQueue(tasks, members = [], leases = [], options = {}) {
  const nowValue = Number(options.now ?? Date.now())
  const taskRows = asArray(tasks)
  const context = createReadyQueueContext(taskRows, members, leases, { ...options, now: nowValue })
  const ready = []
  const blocked = []

  for (const task of taskRows) {
    const row = evaluateReadyTask(task, context)
    if (!row) continue
    if (row.eligible) ready.push(row)
    else blocked.push(row)
  }

  // Pending/new work must win a scope conflict over a stale in-progress row.
  // The stale row is still exposed in `blocked`, but it cannot monopolize the
  // scope merely because its board projection still says in_progress.
  const executionRank = (row) => row.executionState === 'stalled' ? 1 : 0
  ready.sort((a, b) => executionRank(a) - executionRank(b)
    || b.criticality - a.criticality || a.id.localeCompare(b.id))
  const selected = []
  for (const row of ready) {
    const conflict = selected.find((active) => scopesConflict(active, row))
    if (conflict) {
      blocked.push({
        ...row,
        reasons: [...row.reasons, 'runnable-scope-conflict:' + conflict.id],
        eligible: false,
        executionState: 'candidate-blocked',
      })
      continue
    }
    selected.push(row)
  }
  ready.splice(0, ready.length, ...selected)
  const counts = {
    runnable: ready.length,
    active: context.activeTaskIds.size,
    stalled: context.stalled.length,
    blocked: blocked.length,
  }
  return {
    generatedAt: nowValue,
    revision: options.digest === false ? '' : digest({ tasks, members, leases }),
    counts,
    ...counts,
    ready,
    blocked,
    criticalPath: ready.filter((row) => row.unlocks > 0).map((row) => row.id),
  }
}

export function classifyStall(input) {
  const nowValue = Number(input?.now ?? Date.now())
  const lastProgressAt = Number(input?.lastProgressAt ?? input?.lastProgress ?? nowValue)
  const quietMs = Math.max(0, nowValue - lastProgressAt)
  const state = lower(input?.state)
  if (lower(input?.dependencyState) === 'waiting') return { class: 'waiting-dependency', retry: false, escalate: false }
  if (input?.externalWait === true) return { class: 'waiting-external', retry: false, escalate: false }
  if (input?.queuedWake === true) return { class: 'waiting-wake', retry: false, escalate: false }
  if (input?.permissionBlocked === true || input?.scopeBlocked === true) {
    return { class: 'permission-or-scope-blocked', retry: false, escalate: true }
  }
  const repeatedFailures = Number(input?.repeatedFailures ?? 0)
  if (repeatedFailures >= Number(input?.failureThreshold ?? 3)) {
    return { class: 'repeated-failure', retry: false, escalate: true }
  }
  if (input?.toolHung === true || quietMs >= Number(input?.hangMs ?? 30 * 60 * 1000)) {
    return { class: 'suspected-hang', retry: false, escalate: true }
  }
  if (state === 'running') return { class: 'working', retry: false, escalate: false }
  return { class: 'idle-no-progress', retry: false, escalate: false }
}

export function computeTaskCost(events = []) {
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    waitMs: 0,
    toolMs: 0,
    retries: 0,
    duplicateTests: 0,
    evidenceCount: 0,
    newEvidenceCount: 0,
  }
  for (const event of asArray(events)) {
    totals.inputTokens += Number(event.inputTokens ?? event.usage?.inputTokens ?? 0)
    totals.outputTokens += Number(event.outputTokens ?? event.usage?.outputTokens ?? 0)
    totals.cachedTokens += Number(event.cachedTokens ?? event.usage?.cachedTokens ?? 0)
    totals.waitMs += Number(event.waitMs ?? 0)
    totals.toolMs += Number(event.toolMs ?? 0)
    if (event.retry === true || lower(event.kind) === 'retry') totals.retries += 1
    if (event.duplicate === true || lower(event.kind) === 'duplicate-test') totals.duplicateTests += 1
    if (event.evidenceId) totals.evidenceCount += 1
    if (event.newEvidence === true) totals.newEvidenceCount += 1
  }
  return totals
}

export function costGuard(input) {
  const totals = computeTaskCost(input?.events)
  const progress = Number(input?.progressCount ?? totals.newEvidenceCount)
  const threshold = Number(input?.threshold ?? 20)
  const spend = totals.inputTokens + totals.outputTokens + totals.toolMs / 100 + totals.waitMs / 1000 + totals.retries * 1000
  const alert = spend >= threshold && progress === 0
  return {
    ...totals,
    progress,
    spendScore: Math.round(spend),
    alert,
    action: alert ? 'replan-or-request-approval' : 'continue',
    reason: alert ? '投入持续增加但没有新的可验证证据' : 'progress-or-budget-ok',
  }
}

export const __private = { digest, overlaps, stableJson }
