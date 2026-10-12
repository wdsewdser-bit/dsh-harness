/**
 * team-usage — total tokens burned by every agent of one Team, not just the Lead.
 *
 * Why this reads the journals directly: a session projection is per-session, and the
 * runtime exposes no cross-session aggregate. The Lead's own UsagePill therefore shows
 * roughly a seventh of the real spend. The session journals are the one place every
 * agent's usage is durably recorded, so this sums them.
 */
import { closeSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const USAGE_SETTLE_MS = 1_000
const USAGE_CACHE_VERSION = 1
const MAX_USAGE_CACHE_ENTRIES = 256
const MAX_WORKSPACE_CACHE_ENTRIES = 128
const USAGE_CACHE_FILE = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'cache', 'team-usage-cache.json')
  : undefined
const usageCache = new Map()
const workspaceCache = new Map()
let usageCacheLoaded = false
let usageCacheTimer
let usageCacheDirty = false

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

/**
 * Decompress a multi-frame zstd session log.
 * Each append is its own frame, and the one-shot decompressor stops at the first, so
 * frames are located by magic and decoded one by one.
 */
export function decodeJournal(buffer) {
  const parts = []
  let index = 0
  while ((index = buffer.indexOf(MAGIC, index)) !== -1) {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(index)))
    } catch {
      /* Not a real frame boundary: the magic bytes occur inside compressed data. */
    }
    index += 1
  }
  return Buffer.concat(parts).toString('utf8')
}

/**
 * Decode only the newest frames of a multi-frame zstd session log.
 *
 * Session journals append one frame per write, so callers that only need the
 * recent request/boundary tail can avoid inflating the full history. Magic
 * bytes can occur inside compressed data, so candidates are tried newest-first
 * and only successfully decompressed JSON frames are kept.
 */
function decodeJournalTailParts(buffer, maxFrames = 128) {
  const limit = Math.max(1, Math.floor(Number(maxFrames) || 128))
  const starts = []
  let index = 0
  while ((index = buffer.indexOf(MAGIC, index)) !== -1) {
    starts.push(index)
    index += 1
  }
  const parts = []
  for (let cursor = starts.length - 1; cursor >= 0 && parts.length < limit; cursor -= 1) {
    try {
      const part = zstdDecompressSync(buffer.subarray(starts[cursor]))
      if (part.length > 0 && part[0] !== 0x7b && part[0] !== 0x5b) continue
      parts.push(part)
    } catch {
      /* Not a real frame boundary: the magic bytes occur inside compressed data. */
    }
  }
  parts.reverse()
  return parts
}

export function decodeJournalTail(buffer, maxFrames = 128) {
  return Buffer.concat(decodeJournalTailParts(buffer, maxFrames)).toString('utf8')
}

/**
 * Read only the newest complete frames from an append-only journal file.
 * A small tail is tried first and expanded geometrically when a frame is
 * unusually large, so callers never need to read the whole journal.
 */
export function readJournalTail(file, maxFrames = 128, initialBytes = 1_048_576, maxBytes = 8_388_608) {
  const stat = statSync(file)
  if (stat.size === 0) return ''
  const first = Math.max(1, Math.floor(Number(initialBytes) || 1_048_576))
  const ceiling = Math.max(first, Math.floor(Number(maxBytes) || 8_388_608))
  let length = Math.min(stat.size, first)
  for (;;) {
    const buffer = readRange(file, stat.size - length, length)
    const parts = decodeJournalTailParts(buffer, maxFrames)
    if (parts.length >= maxFrames || length >= stat.size || length >= ceiling) {
      return Buffer.concat(parts).toString('utf8')
    }
    length = Math.min(stat.size, Math.max(length * 4, Math.min(ceiling, length + 1_048_576)))
  }
}

/** One session's own usage, plus who it belongs to. */
export function readSessionUsage(id, text, initial = {}) {
  let parent = typeof initial.parent === 'string' ? initial.parent : ''
  let label = typeof initial.label === 'string' ? initial.label : ''
  let provider = typeof initial.provider === 'string' ? initial.provider : ''
  let model = typeof initial.model === 'string' ? initial.model : ''
  let input = Number.isFinite(initial.input) ? initial.input : 0
  let output = Number.isFinite(initial.output) ? initial.output : 0
  let cached = Number.isFinite(initial.cached) ? initial.cached : 0
  let total = Number.isFinite(initial.total) ? initial.total : 0
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'session') {
      if (typeof event.parentSession === 'string') parent = event.parentSession
      if (typeof event.provider === 'string') provider = event.provider
      continue
    }
    if (event.type === 'subagent/descriptor') {
      const data = event.data === undefined ? {} : event.data
      if (typeof data.label === 'string') label = data.label
      if (typeof data.agentModel === 'string') model = data.agentModel
      continue
    }
    const usage = event.data === undefined ? undefined : event.data.usage
    if (usage === undefined || typeof usage.inputTokens !== 'number') continue
    input += usage.inputTokens
    output += usage.outputTokens === undefined ? 0 : usage.outputTokens
    cached += usage.cacheReadTokens === undefined ? 0 : usage.cacheReadTokens
    total += usage.totalTokens === undefined ? 0 : usage.totalTokens
  }
  return { id, parent, label, provider, model, input, output, cached, total }
}

function readRange(file, start, length) {
  const buffer = Buffer.allocUnsafe(length)
  const fd = openSync(file, 'r')
  try {
    let offset = 0
    while (offset < length) {
      const read = readSync(fd, buffer, offset, length - offset, start + offset)
      if (read <= 0) break
      offset += read
    }
    return buffer.subarray(0, offset)
  } finally {
    closeSync(fd)
  }
}

function loadUsageCache() {
  if (usageCacheLoaded) return
  usageCacheLoaded = true
  if (USAGE_CACHE_FILE === undefined) return
  try {
    const doc = JSON.parse(readFileSync(USAGE_CACHE_FILE, 'utf8'))
    if (doc?.version !== USAGE_CACHE_VERSION || doc.sessions === null || typeof doc.sessions !== 'object') return
    const loaded = []
    for (const [id, entry] of Object.entries(doc.sessions)) {
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.file !== 'string' || !Number.isFinite(entry.size) || !Number.isFinite(entry.mtimeMs)) continue
      if (entry.row === null || typeof entry.row !== 'object') continue
      loaded.push([id, {
        file: entry.file,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        row: entry.row,
      }])
    }
    loaded.sort((left, right) => Number(right[1].mtimeMs) - Number(left[1].mtimeMs))
    for (const [id, entry] of loaded.slice(0, MAX_USAGE_CACHE_ENTRIES)) {
      usageCache.set(id, entry)
    }
  } catch {
    /* A cache miss must never prevent usage collection. */
  }
}

function persistUsageCache() {
  if (USAGE_CACHE_FILE === undefined) return
  const sessions = {}
  for (const [id, entry] of usageCache) sessions[id] = entry
  const temp = USAGE_CACHE_FILE + '.' + process.pid + '.tmp'
  try {
    writeFileSync(temp, JSON.stringify({ version: USAGE_CACHE_VERSION, sessions }))
    renameSync(temp, USAGE_CACHE_FILE)
  } catch {
    /* Cache persistence is best effort. */
  }
}

function scheduleUsageCacheWrite() {
  if (USAGE_CACHE_FILE === undefined) return
  usageCacheDirty = true
  if (usageCacheTimer !== undefined) return
  usageCacheTimer = setTimeout(() => {
    usageCacheTimer = undefined
    if (!usageCacheDirty) return
    usageCacheDirty = false
    persistUsageCache()
  }, 250)
  if (typeof usageCacheTimer.unref === 'function') usageCacheTimer.unref()
}

/** Force the pending durable usage cache to disk. Tests use this. */
export function flushUsageCache() {
  if (usageCacheTimer !== undefined) {
    clearTimeout(usageCacheTimer)
    usageCacheTimer = undefined
  }
  if (usageCacheDirty) {
    usageCacheDirty = false
    persistUsageCache()
  }
}

function cachedUsage(name, file, stat) {
  const cached = usageCache.get(name)
  if (cached === undefined || cached.file !== file) return undefined
  if (cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return { row: cached.row, unchanged: true }
  if (stat.size < cached.size) return undefined
  return { cached, row: cached.row, unchanged: false }
}

function refreshUsage(name, file, stat) {
  const prior = cachedUsage(name, file, stat)
  if (prior?.unchanged === true) return prior.row

  const settled = Date.now() - stat.mtimeMs >= USAGE_SETTLE_MS
  if (prior !== undefined && prior.cached !== undefined && stat.size > prior.cached.size) {
    if (!settled) return prior.row
    const delta = readRange(file, prior.cached.size, stat.size - prior.cached.size)
    const text = decodeJournal(delta)
    if (text.length === 0) return prior.row
    const row = readSessionUsage(name, text, prior.row)
    remember(usageCache, name, { file, size: stat.size, mtimeMs: stat.mtimeMs, row }, MAX_USAGE_CACHE_ENTRIES)
    scheduleUsageCacheWrite()
    return row
  }

  const row = readSessionUsage(name, decodeJournal(readFileSync(file)))
  if (settled) {
    remember(usageCache, name, { file, size: stat.size, mtimeMs: stat.mtimeMs, row }, MAX_USAGE_CACHE_ENTRIES)
    scheduleUsageCacheWrite()
  }
  return row
}

/**
 * Every session of one Team, found by walking the parent chain from the root.
 * @param sessionsRoot - a directory holding one directory per session id.
 * @param rootId - the Team's root session id.
 * @returns usage rows, root first.
 */
export function collectTeamUsage(sessionsRoot, rootId) {
  const rows = []
  loadUsageCache()
  let entries
  try { entries = readdirSync(sessionsRoot, { withFileTypes: true }) } catch { return rows }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const name = entry.name
    const dir = join(sessionsRoot, name)
    const file = join(dir, 'session.v3.jsonl.zstd')
    let stat
    try { stat = statSync(file) } catch { continue }
    let row
    try { row = refreshUsage(name, file, stat) } catch { continue }
    rows.push({ ...row, dir })
  }
  const wanted = new Set([rootId])
  for (let grew = true; grew;) {
    grew = false
    for (const row of rows) {
      if (wanted.has(row.id) || row.parent === '' || !wanted.has(row.parent)) continue
      wanted.add(row.id)
      grew = true
    }
  }
  return rows.filter((row) => wanted.has(row.id)).sort((a, b) => b.total - a.total)
}

/**
 * Find the workspace directory that holds one root session.
 * The store is laid out as <base>/<encoded-cwd>/<sessionId>/, and deriving the encoded
 * name from a path is brittle, so the directory is found by looking for the session.
 * @returns the workspace path, or undefined when the session is not stored here.
 */
export function locateWorkspace(base, rootId) {
  const key = String(base) + '\0' + String(rootId)
  const cached = workspaceCache.get(key)
  if (cached !== undefined) return cached
  let names
  try { names = readdirSync(base) } catch { return undefined }
  for (const name of names) {
    try {
      if (statSync(join(base, name, rootId)).isDirectory()) {
        const workspace = join(base, name)
        remember(workspaceCache, key, workspace, MAX_WORKSPACE_CACHE_ENTRIES)
        return workspace
      }
    } catch {
      /* Not this workspace. */
    }
  }
  return undefined
}

/** Clear process-local usage caches. Tests use this; runtime callers do not. */
export function resetUsageCaches() {
  if (usageCacheTimer !== undefined) {
    clearTimeout(usageCacheTimer)
    usageCacheTimer = undefined
  }
  usageCacheDirty = false
  usageCache.clear()
  workspaceCache.clear()
  usageCacheLoaded = false
}

/** Current process-local cache sizes. Tests and diagnostics use this. */
export function usageCacheStats() {
  return {
    usage: usageCache.size,
    workspaces: workspaceCache.size,
  }
}

/** The Team's totals, and what the Lead alone accounts for. */
export function summarizeTeamUsage(rows, rootId) {
  const sum = (list, key) => list.reduce((acc, row) => acc + row[key], 0)
  const lead = rows.filter((row) => row.id === rootId)
  const others = rows.filter((row) => row.id !== rootId)
  return {
    agents: rows.length,
    total: sum(rows, 'total'),
    input: sum(rows, 'input'),
    output: sum(rows, 'output'),
    cached: sum(rows, 'cached'),
    leadTotal: sum(lead, 'total'),
    otherTotal: sum(others, 'total'),
    rows,
  }
}
