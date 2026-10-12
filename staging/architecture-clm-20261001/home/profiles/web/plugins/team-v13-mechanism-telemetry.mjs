/**
 * team-v13-mechanism-telemetry
 *
 * Small, crash-safe per-mechanism counters for the v13 context-economy
 * plugins. Each plugin writes its own JSON file, so there is no shared lock or
 * cross-plugin write contention. A dormant mechanism is visible instead of
 * being silently counted as a benefit.
 *
 * @module team-v13-mechanism-telemetry
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readDurableJson, updateDurableJsonSync } from './team-v14-durable-store.mjs'

console.log('[team-v13-mechanism-telemetry] HMR perf40-bounded-sessions loaded 2026-09-27')

export const TELEMETRY_VERSION = 1
const DEFAULT_DIR = 'D:\\dsh-test\\home\\team-control-plane'
const TELEMETRY_READ_CACHE_MS = 10_000
const MAX_TELEMETRY_SESSIONS = 256
const telemetryReadCache = new Map()
const FIRED_KINDS = new Set([
  'fired',
  'archived',
  'replaced',
  'reduced',
  'compacted',
  'would_compact',
  'deferred',
  'cache-hit-drop',
])
const METRIC_KEYS = Object.freeze([
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'savedTokens',
  'overheadTokens',
  'toolMs',
  'waitMs',
  'modelTurns',
  'toolCalls',
  'passed',
  'failed',
  'timeout',
  'qualityPassed',
  'qualityFailed',
])

function emptyMetrics() {
  return Object.fromEntries(METRIC_KEYS.map((key) => [key, 0]))
}

function emptyState(name) {
  return {
    version: TELEMETRY_VERSION,
    name,
    enabled: null,
    events: 0,
    fired: 0,
    lastFiredAt: null,
    lastEventAt: null,
    lastEvent: null,
    kinds: {},
    skipped: {},
    sessions: {},
    metrics: emptyMetrics(),
    dormantSessions: 0,
    lastSessionId: null,
    sessionsSeen: 0,
  }
}

/** Keep the per-session diagnostic tail bounded without changing totals. */
function rememberSession(state, id, row) {
  state.sessions ??= {}
  delete state.sessions[id]
  state.sessions[id] = row
  let count = Object.keys(state.sessions).length
  while (count > MAX_TELEMETRY_SESSIONS) {
    const oldest = Object.keys(state.sessions)[0]
    if (oldest === undefined) break
    delete state.sessions[oldest]
    count -= 1
  }
}

/** Normalize old telemetry documents without discarding unknown fields. */
export function normalizeTelemetryState(state, name) {
  const value = state !== null && typeof state === 'object' && !Array.isArray(state)
    ? { ...state }
    : emptyState(name)
  value.version = TELEMETRY_VERSION
  value.name = name
  value.enabled = typeof value.enabled === 'boolean' ? value.enabled : null
  value.events = Number.isFinite(value.events) ? value.events : 0
  value.kinds = value.kinds !== null && typeof value.kinds === 'object' ? value.kinds : {}
  value.skipped = value.skipped !== null && typeof value.skipped === 'object' ? value.skipped : {}
  value.sessions = value.sessions !== null && typeof value.sessions === 'object' && !Array.isArray(value.sessions)
    ? value.sessions
    : {}
  const sessionEntries = Object.entries(value.sessions)
  if (sessionEntries.length > MAX_TELEMETRY_SESSIONS) {
    value.sessions = Object.fromEntries(sessionEntries.slice(-MAX_TELEMETRY_SESSIONS))
  }
  value.metrics = { ...emptyMetrics(), ...(value.metrics ?? {}) }
  value.dormantSessions = Number.isFinite(value.dormantSessions) ? value.dormantSessions : 0
  value.lastSessionId = typeof value.lastSessionId === 'string' ? value.lastSessionId : null
  value.sessionsSeen = Number.isFinite(value.sessionsSeen) ? value.sessionsSeen : 0
  value.lastEventAt = typeof value.lastEventAt === 'string' ? value.lastEventAt : null
  value.lastFiredAt = typeof value.lastFiredAt === 'string' ? value.lastFiredAt : null
  // Older telemetry files were written before cache-hit-drop was treated as a
  // firing kind. Recompute the counter from the durable kind histogram so an
  // already-active mechanism is not reported as dormant after an upgrade.
  const derivedFired = Object.entries(value.kinds).reduce((sum, [kind, count]) => {
    const numeric = Number(count)
    return FIRED_KINDS.has(kind) && Number.isFinite(numeric)
      ? sum + Math.max(0, numeric)
      : sum
  }, 0)
  value.fired = Math.max(Number.isFinite(value.fired) ? value.fired : 0, derivedFired)
  if (
    value.lastFiredAt === null
    && value.lastEventAt !== null
    && value.lastEvent !== null
    && typeof value.lastEvent === 'object'
    && FIRED_KINDS.has(String(value.lastEvent.kind))
  ) {
    value.lastFiredAt = value.lastEventAt
  }
  return value
}

function loadState(file, name) {
  try {
    const parsed = readDurableJson(file, { fallback: emptyState(name) })
    if (parsed !== null && typeof parsed === 'object' && parsed.name === name) return normalizeTelemetryState(parsed, name)
  } catch (error) {
    // A corrupt telemetry document must remain observable; do not overwrite it
    // as an empty state during startup.
    return { ...emptyState(name), loadError: String(error?.message ?? error) }
  }
  return emptyState(name)
}

/**
 * Create one mechanism's counter.
 * @param {string} name
 * @param {{ dir?: string }} [options]
 */
export function createTelemetry(name, options = {}) {
  const dir = typeof options.dir === 'string' && options.dir.length > 0 ? options.dir : DEFAULT_DIR
  const bufferSkips = Number.isFinite(options.bufferSkips) ? Math.max(1, options.bufferSkips) : 20
  const file = join(dir, 'mechanism-telemetry-' + String(name).replace(/[^a-z0-9_-]/gi, '_') + '.json')
  const state = loadState(file, name)
  let persisted = JSON.parse(JSON.stringify(state))
  let sinceFlush = 0
  const flush = () => {
    try {
      updateDurableJsonSync(file, (current) => {
        const merged = normalizeTelemetryState(current, name)
        const addDelta = (key) => {
          const delta = Number(state[key] ?? 0) - Number(persisted[key] ?? 0)
          merged[key] = Number(merged[key] ?? 0) + Math.max(0, delta)
        }
        for (const key of ['events', 'fired', 'dormantSessions', 'sessionsSeen']) addDelta(key)
        for (const key of Object.keys(state.kinds ?? {})) {
          const delta = Number(state.kinds[key] ?? 0) - Number(persisted.kinds?.[key] ?? 0)
          merged.kinds[key] = Number(merged.kinds[key] ?? 0) + Math.max(0, delta)
        }
        for (const key of Object.keys(state.skipped ?? {})) {
          const delta = Number(state.skipped[key] ?? 0) - Number(persisted.skipped?.[key] ?? 0)
          merged.skipped[key] = Number(merged.skipped[key] ?? 0) + Math.max(0, delta)
        }
        for (const key of Object.keys(state.metrics ?? {})) {
          const delta = Number(state.metrics[key] ?? 0) - Number(persisted.metrics?.[key] ?? 0)
          merged.metrics[key] = Number(merged.metrics[key] ?? 0) + Math.max(0, delta)
        }
        merged.lastEventAt = state.lastEventAt ?? merged.lastEventAt
        merged.lastEvent = state.lastEvent ?? merged.lastEvent
        merged.lastFiredAt = state.lastFiredAt ?? merged.lastFiredAt
        merged.lastSessionId = state.lastSessionId ?? merged.lastSessionId
        for (const [id, row] of Object.entries(state.sessions ?? {})) {
          const currentRow = merged.sessions[id] ?? {}
          const delta = Number(row.events ?? 0) - Number(persisted.sessions?.[id]?.events ?? 0)
          merged.sessions[id] = {
            ...currentRow,
            ...row,
            firstSeenAt: currentRow.firstSeenAt ?? row.firstSeenAt,
            fired: currentRow.fired === true || row.fired === true,
            events: Number(currentRow.events ?? 0) + Math.max(0, delta),
          }
        }
        persisted = JSON.parse(JSON.stringify(merged))
        Object.assign(current, merged)
        Object.assign(state, merged)
        return current
      }, { fallback: emptyState(name) })
    } catch {
      /* telemetry must never break the mechanism */
    }
  }
  if (typeof options.enabled === 'boolean' && state.enabled !== options.enabled) {
    state.enabled = options.enabled
  }
  if (!existsSync(file)) flush()
  const addMetrics = (metrics) => {
    for (const key of METRIC_KEYS) {
      const value = Number(metrics?.[key])
      if (Number.isFinite(value)) state.metrics[key] += value
    }
  }
  const recordSession = (sessionId, fired) => {
    const id = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null
    if (id === null) return
    state.sessions ??= {}
    const previousId = state.lastSessionId
    if (previousId !== null && previousId !== id && state.sessions[previousId]?.fired !== true) {
      // The previous session is now closed. Only a full session with no
      // firing event contributes to the consecutive-dormant counter.
      state.dormantSessions += 1
    }
    if (previousId !== id) {
      state.sessionsSeen += 1
      state.lastSessionId = id
    }
    const previous = state.sessions[id]
    const row = previous !== null && typeof previous === 'object'
      ? previous
      : {
          firstSeenAt: state.lastEventAt,
          fired: false,
          events: 0,
        }
    row.events = Number(row.events ?? 0) + 1
    row.lastEventAt = state.lastEventAt
    row.kind = fired ? 'fired' : 'skipped'
    row.reason = fired ? null : state.lastEvent?.reason ?? null
    row.contextTokens = state.lastEvent?.contextTokens ?? null
    if (fired) row.fired = true
    rememberSession(state, id, row)
    if (fired) {
      state.dormantSessions = 0
    }
  }
  return {
    setEnabled(enabled) {
      state.enabled = enabled === true
      flush()
    },
    event(kind, detail = {}, metrics = {}) {
      const key = String(kind)
      state.events += 1
      state.kinds[key] = (state.kinds[key] ?? 0) + 1
      state.lastEventAt = new Date().toISOString()
      state.lastEvent = { kind: key, ...detail }
      addMetrics(metrics)
      recordSession(detail.sessionId, true)
      if (FIRED_KINDS.has(key)) {
        state.fired += 1
        state.lastFiredAt = state.lastEventAt
      }
      flush()
      sinceFlush = 0
    },
    skipped(reason, detail = {}, metrics = {}) {
      const key = String(reason)
      state.events += 1
      state.skipped[key] = (state.skipped[key] ?? 0) + 1
      state.lastEventAt = new Date().toISOString()
      state.lastEvent = { kind: 'skipped', reason: key, ...detail }
      addMetrics(metrics)
      recordSession(detail.sessionId, false)
      sinceFlush += 1
      if (sinceFlush >= bufferSkips) {
        flush()
        sinceFlush = 0
      }
    },
    snapshot() {
      return JSON.parse(JSON.stringify(state))
    },
  }
}

/** Read every per-mechanism telemetry file in one directory. */
export function readTelemetry(dir = DEFAULT_DIR) {
  const now = Date.now()
  const cached = telemetryReadCache.get(dir)
  if (cached !== undefined && now - cached.at < TELEMETRY_READ_CACHE_MS) {
    return structuredClone(cached.rows)
  }
  const rows = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return rows
  }
  for (const entry of entries) {
    if (!entry.startsWith('mechanism-telemetry-') || !entry.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(join(dir, entry), 'utf8'))
      if (parsed !== null && typeof parsed === 'object') rows.push(normalizeTelemetryState(parsed, String(parsed.name ?? entry)))
    } catch {
      /* skip unreadable */
    }
  }
  const value = rows.sort((a, b) => String(a.name).localeCompare(String(b.name)))
  telemetryReadCache.set(dir, { at: now, rows: value })
  return structuredClone(value)
}

/** Clear the bounded directory-read cache in tests or after an operator reset. */
export function resetTelemetryReadCache() {
  telemetryReadCache.clear()
}

/**
 * Mark a mechanism dormant after a run of sessions with no firing event.
 * A mechanism that has never fired is dormant immediately.
 */
export function dormantVerdict(state, options = {}) {
  if (state === null || typeof state !== 'object') return true
  if (Number(state.fired ?? 0) === 0) return true
  const threshold = Number.isFinite(options.threshold) ? Math.max(1, options.threshold) : 5
  return Number(state.dormantSessions ?? 0) >= threshold
}
