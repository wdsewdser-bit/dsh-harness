/**
 * team-v13-cache-monitor
 *
 * Watches cache-hit share across a session journal and correlates a sharp
 * drop with the most recent mechanism event. It does not mutate context or
 * messages; it only emits a diagnostic record so a cache miss can be
 * distinguished from prefix churn caused by a v13 mechanism.
 *
 * @module team-v13-cache-monitor
 */

import { createTelemetry } from './team-v13-mechanism-telemetry.mjs'
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { readSessionTimeline } from './team-v13-compaction-shadow.mjs'

console.log('[team-v13-cache-monitor] HMR perf38-bounded-anomalies loaded 2026-09-27')

const DEFAULT_DROP = 0.15
const MAX_LAST_ANOMALIES = 256
const lastAnomaly = new Map()

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

/** Cache-hit share for one usage row. */
export function cacheReadShare(row) {
  if (!['inputTokens', 'cacheReadTokens', 'cacheWriteTokens'].every(key => typeof row?.[key] === 'number' && Number.isFinite(row[key]) && row[key] >= 0)) return null
  const total = finite(row?.inputTokens) + finite(row?.cacheReadTokens) + finite(row?.cacheWriteTokens)
  return total > 0 ? finite(row?.cacheReadTokens) / total : null
}

function sameRequestProjection(request, rows) {
  if (typeof request?.requestId !== 'string' || typeof request?.sessionId !== 'string') return null
  const receipt = request.requestProjection ?? (Array.isArray(rows) ? rows : []).find(row => row?.requestId === request.requestId && row?.sessionId === request.sessionId)?.requestProjection
  if (!receipt || receipt.requestId !== request.requestId || receipt.handedToAdapter !== true) return null
  if (receipt.sessionId !== request.sessionId) return null
  const at = Date.parse(request.time)
  const handed = Date.parse(receipt.handedAt)
  if (Number.isFinite(at) && Number.isFinite(handed) && handed > at) return null
  return receipt
}

export function readLedgerRequests(sessionId, directory) {
  const requests = new Map()
  try {
    const files = readdirSync(directory).filter(name => /^requests-.*\.jsonl$/.test(name))
      .map(name => ({ path: join(directory, name), at: statSync(join(directory, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at).slice(0, 16)
    for (const file of files) {
      const fd = openSync(file.path, 'r')
      try {
        const size = statSync(file.path).size
        const start = Math.max(0, size - 1024 * 1024)
        const buffer = Buffer.alloc(size - start)
        const read = readSync(fd, buffer, 0, buffer.length, start)
        const text = buffer.subarray(0, read).toString('utf8')
        for (const line of (start ? text.slice(text.indexOf('\n') + 1) : text).split('\n')) {
          let row
          try { row = JSON.parse(line) } catch { continue }
          if (row.event !== 'terminal' || row.sessionId !== sessionId || typeof row.requestId !== 'string' || row.usageSnapshots < 1) continue
          requests.set(row.requestId, { ...row.usage, requestId: row.requestId, sessionId, time: row.endedAt,
            seq: row.requestProjection?.call ?? null, requestProjection: row.requestProjection })
        }
      } finally { closeSync(fd) }
    }
  } catch { /* Missing or incomplete ledger attribution remains unknown. */ }
  return [...requests.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time)).slice(-256)
}

/** Record one session fingerprint with LRU eviction. */
export function rememberCacheAnomaly(sessionId, fingerprint) {
  const key = String(sessionId)
  if (lastAnomaly.get(key) === fingerprint) {
    lastAnomaly.delete(key)
    lastAnomaly.set(key, fingerprint)
    return false
  }
  lastAnomaly.delete(key)
  lastAnomaly.set(key, fingerprint)
  while (lastAnomaly.size > MAX_LAST_ANOMALIES) {
    const oldest = lastAnomaly.keys().next().value
    if (oldest === undefined) break
    lastAnomaly.delete(oldest)
  }
  return true
}

/** Process-local cache-monitor counters for diagnostics and focused tests. */
export function cacheMonitorStats() {
  return {
    lastAnomaly: lastAnomaly.size,
    oldestSession: lastAnomaly.keys().next().value ?? null,
  }
}

/**
 * Find sharp cache-hit drops and associate each with the nearest earlier
 * mechanism event. Requests must be ordered by `seq`.
 */
export function detectCacheAnomalies(requests, mechanismRows, options = {}) {
  const rows = Array.isArray(requests) ? requests : []
  const threshold = Number.isFinite(options.dropThreshold)
    ? Math.max(0.01, options.dropThreshold)
    : DEFAULT_DROP
  const anomalies = []
  let previous = rows.length > 0 ? cacheReadShare(rows[0]) : null
  for (let index = 1; index < rows.length; index += 1) {
    const current = cacheReadShare(rows[index])
    if (previous !== null && current !== null && previous - current >= threshold) {
      const receipt = sameRequestProjection(rows[index], mechanismRows)
      const transforms = receipt?.transforms?.filter(row => row.status === 'applied' || row.status === 'unchanged') ?? []
      anomalies.push({
        requestId: rows[index].requestId ?? null,
        seq: rows[index].seq ?? null,
        time: rows[index].time ?? null,
        previousCacheReadShare: previous,
        cacheReadShare: current,
        drop: previous - current,
        mechanism: transforms.filter(row => row.status === 'applied').map(row => row.id).join(',') || null,
        mechanismKind: receipt ? 'same-request-projection-receipt' : null,
        mechanismReason: null,
        mechanismAt: receipt?.handedAt ?? null,
        projection: receipt,
        attribution: receipt ? 'same-request-observation; causal-effect-unproven' : 'unknown',
        prefixChurnSummary: receipt ? 'cache hit dropped on a request with an exact projection receipt; causality unproven'
          : 'cache hit dropped; same-request projection receipt unavailable',
      })
    }
    previous = current
  }
  return anomalies
}

/** Evaluate one session and emit only new anomaly fingerprints. */
export function evaluateCacheMonitor(agent, cfg) {
  const sessionId = agent?.session?.id ?? agent?.id
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  const ledger = readLedgerRequests(sessionId, cfg.usageLedgerDir ?? 'D:/dsh-test/home/usage-ledger')
  const requests = ledger.length >= 2 ? ledger : readSessionTimeline(sessionId, cfg.sessionsRoot)?.requests
  if (!requests || requests.length < 2) return undefined
  const anomalies = detectCacheAnomalies(requests, [], {
    dropThreshold: cfg.dropThreshold,
  })
  const telemetry = createTelemetry('cache-prefix', {
    dir: cfg.telemetryDir,
    enabled: true,
  })
  const latest = anomalies.length > 0 ? anomalies[anomalies.length - 1] : undefined
  if (latest === undefined) return { anomalies, recorded: [] }
  const fingerprint = String(sessionId) + '|' + String(latest.seq) + '|' + latest.drop.toFixed(4)
  if (!rememberCacheAnomaly(sessionId, fingerprint)) return { anomalies, recorded: [] }
  telemetry.event('cache-hit-drop', { ...latest, sessionId })
  const recorded = [latest]
  return { anomalies, recorded }
}

/** Clear process-local dedupe state. */
export function resetCacheMonitor() {
  lastAnomaly.clear()
}

/** Install the idle observer. */
export function apply(ctx, config = {}) {
  const cfg = {
    enabled: config.enabled !== false,
    sessionsRoot: typeof config.sessionsRoot === 'string' && config.sessionsRoot.length > 0
      ? config.sessionsRoot
      : 'D:\\dsh-test\\home\\sessions',
    telemetryDir: typeof config.telemetryDir === 'string' && config.telemetryDir.length > 0
      ? config.telemetryDir
      : 'D:\\dsh-test\\home\\team-control-plane',
    dropThreshold: config.dropThreshold,
    usageLedgerDir: config.usageLedgerDir,
  }
  if (!cfg.enabled) return
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle' || agent === undefined || agent === null) return
    try {
      evaluateCacheMonitor(agent, cfg)
    } catch (error) {
      ctx.logger?.warn?.('[cache-monitor] ' + String(error?.message ?? error))
    }
  })
}
