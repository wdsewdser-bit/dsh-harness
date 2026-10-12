/**
 * Versioned requirements and decisions ledger for context assembly.
 *
 * This module is deliberately independent from the runtime hook.  It accepts
 * a plain object, keeps superseded history, and returns append-only diffs.
 */

console.log('[team-v14-requirements] HMR perf-ledger loaded 2026-09-27')

function objectOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function arrayOf(value) {
  return Array.isArray(value) ? value : []
}

function stringOf(value) {
  return value === undefined || value === null ? '' : String(value)
}

function numberOf(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function snapshotRevision(value) {
  if (!value) return null
  const { history, ...rest } = value
  return clone(rest)
}

function sameRecord(a, b) {
  const ignored = new Set(['history', 'revision', 'changedAt', 'source'])
  const compact = (value) => Object.fromEntries(Object.entries(objectOf(value)).filter(([key]) => !ignored.has(key)))
  return canonical(compact(a)) === canonical(compact(b))
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  return JSON.stringify(value)
}

/** Stable, dependency-free digest for context source manifests. */
export function contextDigest(value) {
  const text = canonical(value)
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function contentRevision(value) {
  return Number.parseInt(contextDigest(value), 16) || 0
}

export function createRequirementLedger(seed = {}) {
  const value = objectOf(seed)
  // Rows are copy-on-write. Mutators replace the one row they change, so the
  // remaining rows can stay shared with the previous snapshot.
  return {
    version: numberOf(value.version, 1),
    revision: numberOf(value.revision, 0),
    requirements: { ...objectOf(value.requirements) },
    decisions: { ...objectOf(value.decisions) },
    events: arrayOf(value.events).slice(),
  }
}

function commit(ledger, event, detail) {
  ledger.revision += 1
  ledger.events.push({ revision: ledger.revision, type: event, ...clone(detail), at: numberOf(detail?.changedAt, Date.now()) })
  if (ledger.events.length > 1000) ledger.events.splice(0, ledger.events.length - 1000)
  return ledger.revision
}

function requirementValue(input, previous, revision) {
  const row = objectOf(input)
  return {
    ...clone(previous),
    history: arrayOf(previous?.history),
    requirementId: stringOf(row.requirementId ?? row.id ?? previous?.requirementId),
    text: stringOf(row.text ?? row.originalText ?? previous?.text),
    quote: stringOf(row.quote ?? row.text ?? previous?.quote),
    scope: stringOf(row.scope ?? previous?.scope),
    taskIds: [...new Set(arrayOf(row.taskIds ?? previous?.taskIds).map(String).filter(Boolean))],
    acceptance: arrayOf(row.acceptance ?? previous?.acceptance).map(String),
    status: stringOf(row.status ?? previous?.status) || 'active',
    revision,
    changedAt: numberOf(row.changedAt, Date.now()),
    supersedes: stringOf(row.supersedes ?? previous?.supersedes) || null,
    supersededBy: stringOf(row.supersededBy ?? previous?.supersededBy) || null,
    sourceMessageId: stringOf(row.sourceMessageId ?? previous?.sourceMessageId) || null,
    source: stringOf(row.source ?? previous?.source) || 'ledger',
  }
}

export function recordRequirement(ledger, input) {
  const value = createRequirementLedger(ledger)
  const row = objectOf(input)
  const id = stringOf(row.requirementId ?? row.id)
  if (!id) return { ok: false, reason: 'requirement-id-required' }
  const existing = value.requirements[id]
  const nextRevision = numberOf(existing?.revision, 0) + 1
  const requirement = requirementValue({ ...row, requirementId: id }, existing, nextRevision)
  if (!requirement.text && !requirement.quote) return { ok: false, reason: 'requirement-text-required' }
  if (existing && sameRecord(existing, requirement)) return { ok: true, deduplicated: true, requirement: clone(existing), revision: value.revision }
  if (existing) requirement.history = [...arrayOf(existing.history), snapshotRevision(existing)].slice(-32)
  value.requirements[id] = requirement
  commit(value, existing ? 'requirement/revised' : 'requirement/recorded', { requirementId: id, changedAt: requirement.changedAt })
  Object.assign(ledger, value)
  return { ok: true, deduplicated: false, requirement: clone(requirement), revision: ledger.revision }
}

export const addRequirement = recordRequirement

export function supersedeRequirement(ledger, requirementId, replacementId, input = {}) {
  const value = createRequirementLedger(ledger)
  const currentId = stringOf(requirementId)
  const replacementKey = stringOf(replacementId)
  const currentSource = value.requirements[currentId]
  if (!currentSource) return { ok: false, reason: 'requirement-not-found' }
  const replacementSource = value.requirements[replacementKey]
  if (!replacementSource) return { ok: false, reason: 'replacement-requirement-not-found' }
  const current = clone(currentSource)
  const replacement = clone(replacementSource)
  if (current.supersededBy === replacement.requirementId || current.status === 'superseded') return { ok: true, deduplicated: true, requirement: clone(current), revision: value.revision }
  current.history = [...arrayOf(current.history), snapshotRevision(current)].slice(-32)
  replacement.history = [...arrayOf(replacement.history), snapshotRevision(replacement)].slice(-32)
  current.status = 'superseded'
  current.supersededBy = replacement.requirementId
  current.revision += 1
  current.changedAt = numberOf(input.changedAt, Date.now())
  replacement.supersedes = current.requirementId
  replacement.revision = numberOf(replacement.revision, 1) + 1
  value.requirements[currentId] = current
  value.requirements[replacementKey] = replacement
  commit(value, 'requirement/superseded', { requirementId: current.requirementId, replacementId: replacement.requirementId, changedAt: current.changedAt })
  Object.assign(ledger, value)
  return { ok: true, deduplicated: false, requirement: clone(current), replacement: clone(replacement), revision: ledger.revision }
}

function decisionValue(input, previous, revision) {
  const row = objectOf(input)
  return {
    ...clone(previous),
    history: arrayOf(previous?.history),
    decisionId: stringOf(row.decisionId ?? row.id ?? previous?.decisionId),
    status: stringOf(row.status ?? previous?.status) || 'proposed',
    choice: stringOf(row.choice ?? row.title ?? previous?.choice),
    rationale: stringOf(row.rationale ?? previous?.rationale),
    scope: stringOf(row.scope ?? previous?.scope),
    taskIds: [...new Set(arrayOf(row.taskIds ?? previous?.taskIds).map(String).filter(Boolean))],
    revision,
    changedAt: numberOf(row.changedAt, Date.now()),
    sourceMessageId: stringOf(row.sourceMessageId ?? previous?.sourceMessageId) || null,
    supersedes: stringOf(row.supersedes ?? previous?.supersedes) || null,
    supersededBy: stringOf(row.supersededBy ?? previous?.supersededBy) || null,
  }
}

export function recordDecision(ledger, input) {
  const value = createRequirementLedger(ledger)
  const row = objectOf(input)
  const id = stringOf(row.decisionId ?? row.id)
  if (!id) return { ok: false, reason: 'decision-id-required' }
  const existing = value.decisions[id]
  const decision = decisionValue({ ...row, decisionId: id }, existing, numberOf(existing?.revision, 0) + 1)
  if (existing && sameRecord(existing, decision)) return { ok: true, deduplicated: true, decision: clone(existing), revision: value.revision }
  if (decision.status === 'confirmed' && stringOf(row.source) !== 'team_room_decide' && stringOf(row.confirmedBy ?? row.decidedBy) === '') {
    return { ok: false, reason: 'explicit-confirmation-required' }
  }
  if (existing) decision.history = [...arrayOf(existing.history), snapshotRevision(existing)].slice(-32)
  value.decisions[id] = decision
  commit(value, existing ? 'decision/revised' : 'decision/recorded', { decisionId: id, changedAt: decision.changedAt })
  Object.assign(ledger, value)
  return { ok: true, deduplicated: false, decision: clone(decision), revision: ledger.revision }
}

export const addDecision = recordDecision

export function confirmDecisionVersion(ledger, decisionId, input = {}) {
  if (!stringOf(input.confirmedBy ?? input.decidedBy)) return { ok: false, reason: 'confirmed-by-required' }
  return recordDecision(ledger, { ...input, decisionId, status: 'confirmed' })
}

export function requirementSnapshot(ledger, options = {}) {
  const value = objectOf(ledger)
  const taskId = stringOf(options.taskId)
  const scope = stringOf(options.scope)
  const requirements = Object.values(objectOf(value.requirements))
    .filter((row) => row?.status === 'active')
    .filter((row) => !taskId || arrayOf(row.taskIds).length === 0 || arrayOf(row.taskIds).includes(taskId))
    .filter((row) => !scope || !row.scope || row.scope === scope)
  const decisions = Object.values(objectOf(value.decisions))
    .filter((row) => row?.status === 'confirmed')
    .filter((row) => !taskId || arrayOf(row.taskIds).length === 0 || arrayOf(row.taskIds).includes(taskId))
    .filter((row) => !scope || !row.scope || row.scope === scope)
  const content = { requirements, decisions }
  return {
    revision: numberOf(value.revision, 0),
    ledgerRevision: numberOf(value.revision, 0),
    contentRevision: contentRevision(content),
    requirements: clone(requirements),
    decisions: clone(decisions),
    digest: contextDigest(content),
  }
}

export const buildRequirementSnapshot = requirementSnapshot

/**
 * Build the model-facing context snapshot without cloning the full ledger.
 *
 * Requirement history is audit-only and is never used by context assembly.
 * The regular requirementSnapshot path clones the complete ledger (including
 * histories) before filtering, which is expensive for long-running teams.
 */
export function contextRequirementSnapshot(seed = {}, options = {}) {
  const value = objectOf(seed)
  const taskId = stringOf(options.taskId)
  const scope = stringOf(options.scope)
  const visible = typeof options.visible === 'function' ? options.visible : () => true
  const sortRecent = options.sortRecent === true
  const limitRequirements = Math.max(0, numberOf(options.limitRequirements, 0))
  const limitDecisions = Math.max(0, numberOf(options.limitDecisions, 0))
  const stripHistory = (row) => {
    const { history, ...rest } = objectOf(row)
    return clone(rest)
  }
  const select = (rows, limit) => {
    if (sortRecent) {
      rows.sort((a, b) => Number(b?.changedAt ?? b?.revision ?? 0) - Number(a?.changedAt ?? a?.revision ?? 0))
    }
    return (limit > 0 ? rows.slice(0, limit) : rows).map(stripHistory)
  }
  const requirements = select(Object.values(objectOf(value.requirements))
    .filter((row) => row?.status === 'active')
    .filter((row) => !taskId || arrayOf(row.taskIds).length === 0 || arrayOf(row.taskIds).includes(taskId))
    .filter((row) => !scope || !row.scope || row.scope === scope)
    .filter(visible), limitRequirements)
  const decisions = select(Object.values(objectOf(value.decisions))
    .filter((row) => row?.status === 'confirmed')
    .filter((row) => !taskId || arrayOf(row.taskIds).length === 0 || arrayOf(row.taskIds).includes(taskId))
    .filter((row) => !scope || !row.scope || row.scope === scope)
    .filter(visible), limitDecisions)
  const content = { requirements, decisions }
  return {
    revision: numberOf(value.revision, 0),
    ledgerRevision: numberOf(value.revision, 0),
    contentRevision: contentRevision(content),
    requirements,
    decisions,
    digest: contextDigest(content),
  }
}

export function diffRequirements(ledger, sinceRevision = 0, options = {}) {
  const value = objectOf(ledger)
  const since = Math.max(0, numberOf(sinceRevision, 0))
  const taskId = stringOf(options.taskId)
  const scope = stringOf(options.scope)
  const changedIds = new Set(arrayOf(value.events).filter((event) => event.revision > since).map((event) => event.requirementId ?? event.decisionId).filter(Boolean))
  const visibleRequirements = Object.values(objectOf(value.requirements))
    .filter((row) => row?.status === 'active')
    .filter((row) => !taskId || arrayOf(row.taskIds).length === 0 || arrayOf(row.taskIds).includes(taskId))
    .filter((row) => !scope || !row.scope || row.scope === scope)
  const visibleDecisions = Object.values(objectOf(value.decisions))
    .filter((row) => row?.status === 'confirmed')
    .filter((row) => !taskId || arrayOf(row.taskIds).length === 0 || arrayOf(row.taskIds).includes(taskId))
    .filter((row) => !scope || !row.scope || row.scope === scope)
  const requirements = visibleRequirements.filter((row) => changedIds.has(row.requirementId))
  const decisions = visibleDecisions.filter((row) => changedIds.has(row.decisionId))
  const content = { requirements: visibleRequirements, decisions: visibleDecisions }
  const changes = { requirements, decisions }
  return {
    ok: true,
    changed: numberOf(value.revision, 0) > since,
    fromRevision: since,
    revision: numberOf(value.revision, 0),
    ledgerRevision: numberOf(value.revision, 0),
    contentRevision: contentRevision(content),
    requirements: clone(requirements),
    decisions: clone(decisions),
    digest: contextDigest(content),
    changesDigest: contextDigest(changes),
    taskId: taskId || null,
    scope: scope || null,
  }
}

export const requirementDiff = diffRequirements

export function contextVersionDiff(previous, ledger, options = {}) {
  const next = diffRequirements(ledger, numberOf(previous?.revision, 0), options)
  const previousDigest = stringOf(previous?.digest)
  const previousContentRevision = numberOf(previous?.contentRevision, 0)
  const changed = previousContentRevision > 0
    ? previousContentRevision !== next.contentRevision
    : previousDigest.length > 0
      ? previousDigest !== next.digest
      : next.changed
  return {
    ...next,
    changed,
    ledgerChanged: next.changed,
    previousDigest: previousDigest || null,
    previousContentRevision: previousContentRevision || null,
  }
}
