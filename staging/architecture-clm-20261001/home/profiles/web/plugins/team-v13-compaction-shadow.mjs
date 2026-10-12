/**
 * team-v13-compaction-shadow
 *
 * Runtime shadow input for opportunistic compaction. It rebuilds the current
 * session's request/boundary samples from the existing journal, runs the pure
 * economic decision, and records the outcome. It never compacts; the caller
 * decides whether `opportunisticCompaction: 'on'` may act.
 *
 * Journal decoding is cached per session with a short TTL because the files can
 * be tens of megabytes and idle events can be frequent.
 *
 * @module team-v13-compaction-shadow
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readJournalTail } from './team-usage.mjs'
import { decideCompaction, summarizeCacheUsage } from './team-v13-compaction-economics.mjs'
import { createTelemetry } from './team-v13-mechanism-telemetry.mjs'
import { updateDurableJsonSync } from './team-v14-durable-store.mjs'

const CACHE_TTL_MS = 2_000
const TAIL_FRAME_LIMIT = 128
const SESSION_DIR_CACHE_MS = 30_000
const MAX_TIMELINE_CACHE_ENTRIES = 32
const MAX_SESSION_DIR_ENTRIES = 128
const MAX_SESSION_ROOT_ENTRIES = 8
const MAX_LAST_EVALUATION_ENTRIES = 128
const cache = new Map()
const sessionDirs = new Map()
const sessionDirIndexes = new Map()
const lastEvaluation = new Map()
export const DEFAULT_DEBT_FILE = 'D:\\dsh-test\\home\\team-control-plane\\v13-compaction-debt.json'

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

function debtForSession(sessionId, timeline, cfg, contextTokens) {
  const file = typeof cfg.debtFile === 'string' && cfg.debtFile.length > 0 ? cfg.debtFile : undefined
  const calculate = (prior) => {
    const writeTokens = Number.isFinite(cfg.writeTokens) ? cfg.writeTokens : 8000
    const memoTokens = Number.isFinite(cfg.memoTokens) ? cfg.memoTokens : 2000
    const ratio = Number.isFinite(cfg.cacheWriteReadRatio) ? cfg.cacheWriteReadRatio : null
    let lastCompactionSeq = Number.isFinite(prior.lastCompactionSeq) ? prior.lastCompactionSeq : -1
    let lastCompactionContextTokens = Number.isFinite(prior.lastCompactionContextTokens)
      ? prior.lastCompactionContextTokens
      : null
    let carriedDebtTokens = Math.max(0, Number(prior.carriedDebtTokens ?? 0))
    const newCompactions = timeline.compactions.filter((row) => Number(row.seq) > lastCompactionSeq)
    if (newCompactions.length > 0) {
      carriedDebtTokens += newCompactions.length * (ratio === null ? 0 : writeTokens * Math.max(0, ratio - 1))
      lastCompactionSeq = Number(newCompactions[newCompactions.length - 1].seq)
      lastCompactionContextTokens = contextTokens
    }
    const requestsSinceCompaction = lastCompactionSeq < 0
      ? timeline.requests.length
      : timeline.requests.filter((row) => Number(row.seq) > lastCompactionSeq).length
    const lastProcessedRequestSeq = Math.max(lastCompactionSeq, Number(prior.lastProcessedRequestSeq ?? lastCompactionSeq))
    if (lastCompactionSeq >= 0) {
      const newRequests = timeline.requests.filter((row) => Number(row.seq) > lastProcessedRequestSeq).length
      const savedPerRequest = Math.max(0, contextTokens - memoTokens)
      carriedDebtTokens = Math.max(0, carriedDebtTokens - savedPerRequest * newRequests)
    }
    return {
      lastCompactionSeq,
      lastCompactionContextTokens,
      carriedDebtTokens,
      requestsSinceCompaction,
      lastProcessedRequestSeq: timeline.requests.reduce((max, row) => Math.max(max, Number(row.seq)), lastProcessedRequestSeq),
      updatedAt: Date.now(),
    }
  }
  if (!file) return calculate({})
  return updateDurableJsonSync(file, (doc) => {
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc) || doc.sessions === null || (doc.sessions !== undefined && typeof doc.sessions !== 'object')) {
      throw new Error('compaction debt document is corrupt: ' + file)
    }
    doc.version = 1
    doc.sessions ??= {}
    const next = calculate(doc.sessions[String(sessionId)] ?? {})
    doc.sessions[String(sessionId)] = next
    return next
  }, { fallback: { version: 1, sessions: {} } })
}

function buildSessionDirIndex(root, depth, index) {
  if (depth > 4) return
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name)
    index.set(entry.name, path)
    buildSessionDirIndex(path, depth + 1, index)
  }
}

function sessionDirIndex(root, force = false) {
  const cached = sessionDirIndexes.get(root)
  if (!force && cached !== undefined && Date.now() - cached.at < SESSION_DIR_CACHE_MS) return cached.dirs
  const dirs = new Map()
  buildSessionDirIndex(root, 0, dirs)
  remember(sessionDirIndexes, root, { at: Date.now(), dirs }, MAX_SESSION_ROOT_ENTRIES)
  return dirs
}

/** Find the session directory for one id from a short-lived directory index. */
function findSessionDir(root, sessionId) {
  let dirs = sessionDirIndex(root)
  const found = dirs.get(sessionId)
  if (found !== undefined) return found
  dirs = sessionDirIndex(root, true)
  return dirs.get(sessionId)
}

/** Read and cache one session's request/boundary timeline. */
export function readSessionTimeline(sessionId, sessionsRoot) {
  const key = String(sessionId)
  const cached = cache.get(key)
  if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) return cached.value
  const dir = sessionDirs.get(key) ?? findSessionDir(sessionsRoot, key)
  if (dir === undefined) {
    remember(cache, key, { at: Date.now(), value: undefined }, MAX_TIMELINE_CACHE_ENTRIES)
    return undefined
  }
  remember(sessionDirs, key, dir, MAX_SESSION_DIR_ENTRIES)
  let file
  let signature
  for (const name of ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd']) {
    const candidate = join(dir, name)
    if (!existsSync(candidate)) continue
    try {
      const stat = statSync(candidate)
      file = candidate
      signature = String(stat.size) + ':' + String(stat.mtimeMs)
      break
    } catch {
      /* try the next format */
    }
  }
  if (file === undefined || signature === undefined) {
    remember(cache, key, { at: Date.now(), value: undefined }, MAX_TIMELINE_CACHE_ENTRIES)
    return undefined
  }
  if (cached !== undefined && cached.file === file && cached.signature === signature) {
    cached.at = Date.now()
    return cached.value
  }
  let text
  try {
    text = readJournalTail(file, TAIL_FRAME_LIMIT)
  } catch {
    remember(cache, key, { at: Date.now(), value: undefined, file, signature }, MAX_TIMELINE_CACHE_ENTRIES)
    return undefined
  }

  const requests = []
  const boundaries = []
  const compactions = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const usage = event.data?.usage
    if (event.type === 'assistant/message' && usage !== undefined) {
      requests.push({
        seq: event.seq,
        promptTokens: Number(usage.inputTokens ?? 0)
          + Number(usage.cacheReadTokens ?? 0)
          + Number(usage.cacheWriteTokens ?? 0),
        inputTokens: Number(usage.inputTokens ?? 0),
        outputTokens: Number(usage.outputTokens ?? 0),
        cacheReadTokens: Number(usage.cacheReadTokens ?? 0),
        cacheWriteTokens: Number(usage.cacheWriteTokens ?? 0),
      })
      continue
    }
    if (event.type === 'turn/end') {
      boundaries.push({ seq: event.seq })
      continue
    }
    if (event.type === 'compaction/start') compactions.push({ seq: event.seq })
  }
  const value = { requests, boundaries, compactions }
  remember(cache, key, { at: Date.now(), value, file, signature }, MAX_TIMELINE_CACHE_ENTRIES)
  return value
}

/** Requests between consecutive boundaries. */
function requestCounts(requests, boundaries) {
  const counts = []
  let cursor = 0
  for (const boundary of boundaries) {
    let count = 0
    while (cursor < requests.length && requests[cursor].seq < boundary.seq) {
      count += 1
      cursor += 1
    }
    counts.push(count)
  }
  return counts
}

/** Average prompt growth per request. */
function averageIncrement(requests) {
  if (requests.length < 2) return null
  let total = 0
  for (let index = 1; index < requests.length; index += 1) {
    total += Math.max(0, requests[index].promptTokens - requests[index - 1].promptTokens)
  }
  return total / (requests.length - 1)
}

/**
 * Evaluate one idle point in shadow mode.
 * @returns {{ decision: object, inputs: object } | undefined}
 */
export function evaluateShadow(agent, cfg, contextTokens) {
  const sessionId = agent?.session?.id ?? agent?.id
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  const sessionsRoot = typeof cfg.sessionsRoot === 'string' && cfg.sessionsRoot.length > 0
    ? cfg.sessionsRoot
    : join(process.env.DSH_HOME ?? process.cwd(), 'sessions')
  const timeline = readSessionTimeline(sessionId, sessionsRoot)
  if (timeline === undefined || timeline.requests.length < 2 || timeline.boundaries.length === 0) return undefined
  return evaluateTimeline(sessionId, timeline, cfg, contextTokens)
}

/**
 * Evaluate a decoded timeline. This is pure apart from telemetry, which makes
 * the runtime path testable without constructing a compressed session journal.
 */
export function evaluateTimeline(sessionId, timeline, cfg, contextTokens) {
  const counts = requestCounts(timeline.requests, timeline.boundaries)
  const priorCompactions = timeline.compactions.length
  const debt = debtForSession(sessionId, timeline, cfg, contextTokens)
  const decision = decideCompaction({
    writeTokens: Number.isFinite(cfg.writeTokens) ? cfg.writeTokens : 8000,
    archiveTokens: Math.max(0, contextTokens - (Number.isFinite(cfg.memoTokens) ? cfg.memoTokens : 2000)),
    memoTokens: Number.isFinite(cfg.memoTokens) ? cfg.memoTokens : 2000,
    contextTokens,
    completedBoundaryRequestCounts: counts.length >= 2 ? counts : null,
    remainingBoundaries: Math.max(1, counts.length),
    averageContextTokenIncrement: averageIncrement(timeline.requests),
    contextWindowTokens: cfg.windowTokens,
    priorCompactionCount: priorCompactions,
    carriedDebtTokens: debt.carriedDebtTokens,
    cacheDebtRepaymentTokens: 0,
    cacheWriteReadRatio: Number.isFinite(cfg.cacheWriteReadRatio) ? cfg.cacheWriteReadRatio : null,
    minContextGrowthTokens: Number.isFinite(cfg.minContextGrowthTokens) ? cfg.minContextGrowthTokens : 50000,
    minRequestsSinceCompaction: Number.isFinite(cfg.minRequestsSinceCompaction) ? cfg.minRequestsSinceCompaction : 20,
    requestsSinceCompaction: debt.requestsSinceCompaction,
    lastCompactionContextTokens: debt.lastCompactionContextTokens,
  })
  const fingerprint = JSON.stringify({
    requests: timeline.requests.length,
    boundaries: timeline.boundaries.length,
    compactions: priorCompactions,
    reason: decision.reason,
    contextBucket: Math.floor(Math.max(0, Number(contextTokens) || 0) / 10000),
  })
  const previous = lastEvaluation.get(String(sessionId))
  const duplicate = previous === fingerprint
  if (!duplicate) remember(lastEvaluation, String(sessionId), fingerprint, MAX_LAST_EVALUATION_ENTRIES)
  const telemetry = createTelemetry('compaction-economics', { dir: cfg.telemetryDir })
  if (!duplicate) {
    if (decision.compact) telemetry.event('would_compact', { reason: decision.reason, contextTokens, sessionId: String(sessionId) })
    else telemetry.event('deferred', { reason: decision.reason, contextTokens, sessionId: String(sessionId) })
  }
  return {
    decision,
    recorded: !duplicate,
    inputs: {
      requests: timeline.requests.length,
      boundaries: timeline.boundaries.length,
      compactions: priorCompactions,
      requestsSinceCompaction: debt.requestsSinceCompaction,
      debt: {
        carriedDebtTokens: debt.carriedDebtTokens,
        lastCompactionSeq: debt.lastCompactionSeq,
        lastCompactionContextTokens: debt.lastCompactionContextTokens,
      },
      cache: summarizeCacheUsage(timeline.requests),
    },
  }
}

/** Clear process-local shadow caches. Tests use this; runtime callers do not. */
export function resetShadowCaches() {
  cache.clear()
  sessionDirs.clear()
  sessionDirIndexes.clear()
  lastEvaluation.clear()
}
