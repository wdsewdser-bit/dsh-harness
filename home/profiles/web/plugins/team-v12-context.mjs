/**
 * team-v12-context
 *
 * Pure context-pack assembly for v12.
 *
 * A context source keeps its authoritative ID, revision, access rules,
 * freshness, priority and token estimate until the final pack is assembled.
 * Derived summaries may be selected for a large optional source, but they never
 * replace the source identity or its locator.
 */

export const CONTEXT_PACK_VERSION = 1

export const RETENTION_CLASSES = Object.freeze([
  'permission',
  'task-contract',
  'owner-scope',
  'decision',
  'unread-message',
  'unresolved',
  'evidence-index',
  'recent-work',
  'background',
  'tool-log',
])

const REQUIRED_CLASSES = new Set([
  'permission',
  'task-contract',
  'owner-scope',
  'decision',
  'unread-message',
  'unresolved',
  'evidence-index',
])

const CLASS_ORDER = Object.freeze({
  permission: 0,
  'task-contract': 1,
  'owner-scope': 2,
  decision: 3,
  'unread-message': 4,
  unresolved: 5,
  'evidence-index': 6,
  'recent-work': 7,
  background: 8,
  'tool-log': 9,
})

/** Return a plain object. */
function objectOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** Return an array. */
function arrayOf(value) {
  return Array.isArray(value) ? value : []
}

/** Return a string. */
function stringOf(value) {
  return value === undefined || value === null ? '' : String(value)
}

/** Return a finite number. */
function numberOf(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

/** Stable JSON copy for API results. */
function copyValue(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

/** Structured refusal for expected caller errors. */
function refusal(reason, detail) {
  return detail === undefined
    ? { ok: false, reason }
    : { ok: false, reason, detail }
}

/** Stable FNV-1a content hash used only for deduplication and manifests. */
export function contentHash(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Estimate tokens without pretending to know a provider tokenizer.
 *
 * ASCII text is estimated at four characters per token. Non-ASCII code points
 * are counted as one token each. This is an estimate, not billing truth.
 */
export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  let ascii = 0
  let nonAscii = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code <= 0x7f) {
      ascii += 1
      continue
    }
    nonAscii += 1
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) index += 1
    }
  }
  return Math.max(1, Math.ceil(ascii / 4) + nonAscii)
}

/** Normalize a priority for stable ordering while preserving the caller value. */
function priorityRank(priority) {
  if (typeof priority === 'number' && Number.isFinite(priority)) return priority
  const value = stringOf(priority).toLowerCase()
  if (value === 'critical' || value === 'urgent' || value === 'high') return 300
  if (value === 'low') return 100
  return 200
}

/** Build one normalized context source. */
export function createContextSource(input) {
  const row = objectOf(input)
  const content = typeof row.content === 'string' ? row.content : JSON.stringify(row.content ?? '')
  const summary = stringOf(row.summary)
  const retentionClass = stringOf(row.retentionClass ?? row.category) || 'background'
  return {
    sourceId: stringOf(row.sourceId),
    revision: numberOf(row.revision, 1),
    content,
    summary,
    locator: stringOf(row.locator ?? row.uri),
    contentHash: stringOf(row.contentHash) || contentHash(content),
    teamId: stringOf(row.teamId) || null,
    teamIds: [...new Set(arrayOf(row.teamIds).map(String).filter(Boolean))],
    taskId: stringOf(row.taskId) || null,
    taskIds: [...new Set(arrayOf(row.taskIds).map(String).filter(Boolean))],
    members: [...new Set(arrayOf(row.members ?? row.allowedMembers).map(String).filter(Boolean))],
    requiredPermissions: [...new Set(arrayOf(row.requiredPermissions ?? row.permissions).map(String).filter(Boolean))],
    priority: row.priority ?? 'normal',
    priorityRank: priorityRank(row.priority),
    retentionClass,
    required: row.required === true || REQUIRED_CLASSES.has(retentionClass),
    estimatedTokens: numberOf(row.estimatedTokens, estimateTokens(content)),
    createdAt: numberOf(row.createdAt, 0),
    expiresAt: row.expiresAt === undefined || row.expiresAt === null ? null : numberOf(row.expiresAt, 0),
    maxAgeMs: row.maxAgeMs === undefined || row.maxAgeMs === null ? null : numberOf(row.maxAgeMs, 0),
    freshness: row.freshness ?? null,
    stale: row.stale === true,
    derived: row.derived === true,
    authoritativeSourceId: stringOf(row.authoritativeSourceId) || null,
    inputIndex: numberOf(row.inputIndex, -1),
    metadata: copyValue(objectOf(row.metadata)),
  }
}

/** Whether a source is visible to the target member and task. */
export function contextVisibilityVerdict(source, target = {}, now = Date.now()) {
  const teamId = stringOf(target.teamId)
  const taskId = stringOf(target.taskId)
  const memberId = stringOf(target.memberId)
  const sourceTeams = new Set([source.teamId, ...arrayOf(source.teamIds)].filter(Boolean).map(String))
  if (teamId.length > 0 && sourceTeams.size > 0 && !sourceTeams.has(teamId)) {
    return refusal('wrong-team')
  }
  const sourceTasks = new Set([source.taskId, ...arrayOf(source.taskIds)].filter(Boolean).map(String))
  if (taskId.length > 0 && sourceTasks.size > 0 && !sourceTasks.has(taskId)) {
    return refusal('wrong-task')
  }
  if (source.members.length > 0 && !source.members.includes(memberId)) {
    return refusal('member-scope')
  }
  const held = new Set(arrayOf(target.permissions).map(String))
  const missing = source.requiredPermissions.filter((permission) => !held.has(permission))
  if (missing.length > 0) return refusal('permission-denied', { missing })
  const freshness = objectOf(source.freshness)
  if (source.stale === true || stringOf(freshness.status).toLowerCase() === 'stale') {
    return refusal('stale')
  }
  if (source.expiresAt !== null && source.expiresAt <= now) return refusal('expired')
  if (source.maxAgeMs !== null && source.maxAgeMs > 0 && source.createdAt > 0 && now - source.createdAt > source.maxAgeMs) {
    return refusal('stale-age')
  }
  if (freshness.status !== undefined && stringOf(freshness.status).toLowerCase() !== 'fresh') {
    return refusal('stale-freshness')
  }
  return { ok: true }
}

/** Return a manifest row for one input source. */
function manifestRow(source, patch = {}) {
  return {
    sourceId: source.sourceId,
    revision: source.revision,
    retentionClass: source.retentionClass,
    required: source.required,
    priority: source.priority,
    estimatedTokens: source.estimatedTokens,
    contentHash: source.contentHash,
    locator: source.locator || null,
    ...patch,
  }
}

/** Compare two versions of the same logical source. */
function betterVersion(a, b) {
  if (a.required !== b.required) return a.required ? a : b
  if (a.revision !== b.revision) return a.revision > b.revision ? a : b
  if (a.priorityRank !== b.priorityRank) return a.priorityRank > b.priorityRank ? a : b
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? a : b
  return a.inputIndex <= b.inputIndex ? a : b
}

/** Compare candidates after visibility and dedupe. */
function compareCandidates(a, b) {
  if (a.required !== b.required) return a.required ? -1 : 1
  if (a.priorityRank !== b.priorityRank) return b.priorityRank - a.priorityRank
  const classDelta = numberOf(CLASS_ORDER[a.retentionClass], 99) - numberOf(CLASS_ORDER[b.retentionClass], 99)
  if (classDelta !== 0) return classDelta
  if (a.revision !== b.revision) return b.revision - a.revision
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt
  return a.sourceId.localeCompare(b.sourceId)
}

/** Resolve budget options and distinguish an absent budget from a zero budget. */
function budgetOf(request) {
  const budget = objectOf(request.budget)
  const maxValue = request.maxTokens ?? budget.maxTokens
  const maxTokens = maxValue === undefined || maxValue === null ? null : Math.max(0, numberOf(maxValue, 0))
  const reserved = Math.max(0, numberOf(request.reservedOutputTokens ?? budget.reservedOutputTokens, 0))
  const availableTokens = maxTokens === null ? null : Math.max(0, maxTokens - reserved)
  return { maxTokens, reservedOutputTokens: reserved, availableTokens }
}

/**
 * Assemble one auditable context pack.
 *
 * Sources are filtered by team/task/member/permission and freshness, deduped by
 * source revision and content hash, then admitted in priority order. Required
 * material that cannot fit blocks the pack instead of returning a partial pack.
 */
export function buildContextPack(request) {
  const input = Array.isArray(request) ? { sources: request } : objectOf(request)
  const target = objectOf(input.target)
  const now = numberOf(input.now ?? target.now, Date.now())
  const sources = arrayOf(input.sources).map((source, inputIndex) => createContextSource({ ...objectOf(source), inputIndex }))
  if (sources.length === 0) return refusal('context-sources-required')
  const missingId = sources.find((source) => source.sourceId.length === 0)
  if (missingId !== undefined) return refusal('source-id-required', { inputIndex: missingId.inputIndex })

  const budget = budgetOf(input)
  const manifest = new Map()
  const candidates = []
  const filtered = []

  for (const source of sources) {
    const verdict = contextVisibilityVerdict(source, target, now)
    if (verdict.ok !== true) {
      manifest.set(source.inputIndex, manifestRow(source, { included: false, reason: verdict.reason, detail: verdict.detail ?? null }))
      filtered.push({ sourceId: source.sourceId, revision: source.revision, reason: verdict.reason })
      continue
    }
    candidates.push(source)
  }

  const bySourceId = new Map()
  for (const source of candidates) {
    const group = bySourceId.get(source.sourceId) ?? []
    group.push(source)
    bySourceId.set(source.sourceId, group)
  }

  const selected = []
  const duplicates = []
  for (const [sourceId, group] of bySourceId) {
    const sorted = [...group].sort((a, b) => betterVersion(b, a) === a ? -1 : 1)
    const winner = sorted[0]
    selected.push(winner)
    for (const source of sorted.slice(1)) {
      const sameRevision = source.revision === winner.revision
      const reason = sameRevision ? 'revision-conflict' : 'superseded-revision'
      manifest.set(source.inputIndex, manifestRow(source, {
        included: false,
        reason,
        duplicateOf: winner.sourceId,
        duplicateRevision: winner.revision,
      }))
      duplicates.push({ sourceId, revision: source.revision, duplicateOf: winner.sourceId, reason })
    }
  }

  const byHash = new Map()
  const unique = []
  for (const source of selected.sort(compareCandidates)) {
    const existing = byHash.get(source.contentHash)
    if (existing === undefined) {
      byHash.set(source.contentHash, source)
      unique.push(source)
      continue
    }
    const winner = betterVersion(existing, source)
    const loser = winner === existing ? source : existing
    if (winner !== existing) {
      const position = unique.indexOf(existing)
      unique[position] = winner
      byHash.set(source.contentHash, winner)
      manifest.set(existing.inputIndex, manifestRow(existing, {
        included: false,
        reason: 'duplicate-content',
        duplicateOf: winner.sourceId,
      }))
    }
    manifest.set(loser.inputIndex, manifestRow(loser, {
      included: false,
      reason: 'duplicate-content',
      duplicateOf: winner.sourceId,
    }))
    duplicates.push({
      sourceId: loser.sourceId,
      revision: loser.revision,
      duplicateOf: winner.sourceId,
      contentHash: source.contentHash,
      reason: 'duplicate-content',
    })
  }

  const ordered = [...unique].sort(compareCandidates)
  const required = ordered.filter((source) => source.required)
  const requiredTokens = required.reduce((sum, source) => sum + source.estimatedTokens, 0)
  const availableTokens = budget.availableTokens
  if (availableTokens !== null && requiredTokens > availableTokens) {
    for (const source of ordered) {
      manifest.set(source.inputIndex, manifestRow(source, {
        included: false,
        reason: source.required ? 'required-over-budget' : 'blocked-by-required-budget',
      }))
    }
    const requiredItems = required.map((source) => ({
      ...copyValue(source),
      content: source.content,
      omitted: true,
    }))
    return {
      ok: false,
      version: CONTEXT_PACK_VERSION,
      status: 'context-budget-blocked',
      blocked: true,
      items: [],
      requiredItems,
      maxTokens: budget.maxTokens,
      reservedOutputTokens: budget.reservedOutputTokens,
      availableTokens,
      requiredTokens,
      estimatedTokens: 0,
      overBy: requiredTokens - availableTokens,
      manifest: {
        version: CONTEXT_PACK_VERSION,
        entries: [...manifest.values()],
        included: [],
        excluded: [...manifest.values()],
        filtered,
        duplicates,
        trimmed: [],
        totalEstimatedTokens: 0,
        requiredEstimatedTokens: requiredTokens,
        availableTokens,
      },
    }
  }

  let remaining = availableTokens === null ? Infinity : availableTokens
  const items = []
  const trimmed = []
  for (const source of ordered) {
    if (source.estimatedTokens <= remaining) {
      const item = copyValue(source)
      item.clipped = false
      item.originalEstimatedTokens = source.estimatedTokens
      items.push(item)
      remaining -= source.estimatedTokens
      manifest.set(source.inputIndex, manifestRow(source, { included: true, reason: 'included' }))
      continue
    }
    if (!source.required && source.summary.length > 0) {
      const summaryTokens = estimateTokens(source.summary)
      if (summaryTokens <= remaining) {
        const item = {
          ...copyValue(source),
          content: source.summary,
          summary: '',
          clipped: true,
          originalEstimatedTokens: source.estimatedTokens,
          estimatedTokens: summaryTokens,
        }
        items.push(item)
        remaining -= summaryTokens
        manifest.set(source.inputIndex, manifestRow(source, {
          included: true,
          reason: 'summary-clipped',
          estimatedTokens: summaryTokens,
          originalEstimatedTokens: source.estimatedTokens,
        }))
        trimmed.push({
          sourceId: source.sourceId,
          revision: source.revision,
          reason: 'budget-summary',
          originalEstimatedTokens: source.estimatedTokens,
          selectedEstimatedTokens: summaryTokens,
        })
        continue
      }
    }
    manifest.set(source.inputIndex, manifestRow(source, {
      included: false,
      reason: source.required ? 'required-over-budget' : 'budget-exceeded',
    }))
    if (!source.required) {
      trimmed.push({
        sourceId: source.sourceId,
        revision: source.revision,
        reason: 'budget-exceeded',
        estimatedTokens: source.estimatedTokens,
      })
    }
  }

  const estimatedTokens = items.reduce((sum, item) => sum + item.estimatedTokens, 0)
  const entries = [...manifest.values()]
  return {
    ok: true,
    version: CONTEXT_PACK_VERSION,
    status: 'ready',
    blocked: false,
    items,
    maxTokens: budget.maxTokens,
    reservedOutputTokens: budget.reservedOutputTokens,
    availableTokens,
    requiredTokens,
    estimatedTokens,
    manifest: {
      version: CONTEXT_PACK_VERSION,
      entries,
      included: entries.filter((entry) => entry.included === true),
      excluded: entries.filter((entry) => entry.included !== true),
      filtered,
      duplicates,
      trimmed,
      totalEstimatedTokens: estimatedTokens,
      requiredEstimatedTokens: requiredTokens,
      availableTokens,
    },
  }
}

/** Render a pack without changing its source labels or revision metadata. */
export function renderContextPack(pack) {
  if (pack?.ok !== true || !Array.isArray(pack.items)) return ''
  return pack.items.map((item) => {
    const marker = '[' + item.sourceId + '@' + String(item.revision)
      + (item.clipped ? ' clipped' : '') + ']'
    const locator = item.locator ? '\nlocator: ' + item.locator : ''
    return marker + locator + '\n' + item.content
  }).join('\n\n')
}
