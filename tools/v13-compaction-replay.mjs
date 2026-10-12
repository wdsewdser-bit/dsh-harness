/**
 * v13-compaction-replay
 *
 * Offline calibration for the v13 opportunistic-compaction gate. Reads existing
 * session journals, rebuilds the per-request prompt-size timeline, treats each
 * completed turn (and explicit milestone/task-completion event) as a subtask
 * boundary, and runs the pure economic decision at every boundary.
 *
 * It never calls a provider, never writes a session, and never compacts.
 *
 * Usage:
 *   node tools/v13-compaction-replay.mjs --limit 20
 *   node tools/v13-compaction-replay.mjs --cacheWriteReadRatio 12.5 --json
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeJournal } from '../home/profiles/web/plugins/team-usage.mjs'
import { decideCompaction, summarizeCacheUsage } from '../home/profiles/web/plugins/team-v13-compaction-economics.mjs'

const DEFAULTS = {
  sessionsRoot: 'D:/dsh-test/home/sessions',
  limit: 20,
  windowTokens: 1_000_000,
  writeTokens: 8_000,
  memoTokens: 2_000,
  cacheWriteReadRatio: null,
  boundaryMode: 'auto',
  minContextGrowthTokens: 50_000,
  minRequestsSinceCompaction: 20,
}

/** Parse `--key value` and boolean `--json` flags. */
function parseArgs(argv) {
  const options = { ...DEFAULTS, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      options.json = true
      continue
    }
    const match = /^--([A-Za-z][A-Za-z0-9]*)(?:=(.*))?$/.exec(arg)
    if (match === null) continue
    const key = match[1]
    const value = match[2] ?? argv[++index]
    if (value === undefined) continue
    if (key === 'sessions' || key === 'sessionsRoot') options.sessionsRoot = value
    else if (key === 'limit') options.limit = Number(value)
    else if (key === 'windowTokens') options.windowTokens = Number(value)
    else if (key === 'writeTokens') options.writeTokens = Number(value)
    else if (key === 'memoTokens') options.memoTokens = Number(value)
    else if (key === 'cacheWriteReadRatio') options.cacheWriteReadRatio = Number(value)
    else if (key === 'boundaryMode') options.boundaryMode = String(value)
    else if (key === 'minContextGrowthTokens') options.minContextGrowthTokens = Number(value)
    else if (key === 'minRequestsSinceCompaction') options.minRequestsSinceCompaction = Number(value)
  }
  return options
}

/** Find session journals under a root, newest first. */
function findJournals(root, limit) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path, depth + 1)
      } else if (entry.name === 'session.v4.jsonl.zstd' || entry.name === 'session.v3.jsonl.zstd') {
        try {
          found.push({ path, mtimeMs: statSync(path).mtimeMs })
        } catch {
          /* skip unreadable */
        }
      }
    }
  }
  walk(root, 0)
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit)
}

/** True when a PTC dispatch marks a completed work unit. */
function isBoundaryDispatch(event) {
  if (event.type !== 'tool/ptc-dispatch') return false
  const name = event.data?.name
  const args = event.data?.arguments
  const text = args === undefined ? '' : JSON.stringify(args)
  if (name === 'team_milestone') return /"action"\s*:\s*"done"/.test(text)
  if (name === 'team_task_update') return /"action"\s*:\s*"complete"/.test(text)
  return false
}

/** Rebuild the request and boundary timeline from one decoded journal. */
export function buildTimeline(text) {
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
        time: event.time,
        inputTokens: Number(usage.inputTokens ?? 0),
        outputTokens: Number(usage.outputTokens ?? 0),
        cacheReadTokens: Number(usage.cacheReadTokens ?? 0),
        cacheWriteTokens: Number(usage.cacheWriteTokens ?? 0),
        promptTokens: Number(usage.inputTokens ?? 0)
          + Number(usage.cacheReadTokens ?? 0)
          + Number(usage.cacheWriteTokens ?? 0),
      })
      continue
    }
    if (event.type === 'turn/end') {
      boundaries.push({ seq: event.seq, time: event.time, kind: 'turn' })
      continue
    }
    if (isBoundaryDispatch(event)) {
      boundaries.push({ seq: event.seq, time: event.time, kind: 'task', name: event.data?.name })
      continue
    }
    if (event.type === 'compaction/start') {
      compactions.push({ seq: event.seq, time: event.time, compactionId: event.data?.compactionId })
    }
  }
  return { requests, boundaries, compactions }
}

/** Average prompt growth per request across the session. */
function averageIncrement(requests) {
  if (requests.length < 2) return null
  let total = 0
  for (let index = 1; index < requests.length; index += 1) {
    total += Math.max(0, requests[index].promptTokens - requests[index - 1].promptTokens)
  }
  return total / (requests.length - 1)
}

/** Requests between consecutive boundaries. */
function requestsPerBoundary(requests, boundaries) {
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

/** Run the economic decision at each boundary of one session. */
export function replaySession(timeline, options) {
  const { requests, compactions } = timeline
  const explicit = timeline.boundaries.filter((boundary) => boundary.kind === 'task')
  const turns = timeline.boundaries.filter((boundary) => boundary.kind === 'turn')
  const mode = options.boundaryMode ?? 'auto'
  const boundaries = mode === 'explicit'
    ? explicit
    : mode === 'turn'
      ? turns
      : explicit.length >= 5
        ? explicit
        : turns
  const counts = requestsPerBoundary(requests, boundaries)
  const decisions = []
  const increment = averageIncrement(requests)
  let lastRequestIndex = -1
  let priorCompactions = 0
  let carriedDebtTokens = 0
  let lastCompactionSeq = -1
  let lastCompactionContextTokens = null
  const ratio = Number.isFinite(options.cacheWriteReadRatio) ? options.cacheWriteReadRatio : null
  for (let index = 0; index < boundaries.length; index += 1) {
    const boundary = boundaries[index]
    while (lastRequestIndex + 1 < requests.length && requests[lastRequestIndex + 1].seq < boundary.seq) {
      lastRequestIndex += 1
    }
    const contextTokens = lastRequestIndex >= 0 ? requests[lastRequestIndex].promptTokens : 0
    while (priorCompactions < compactions.length && compactions[priorCompactions].seq < boundary.seq) {
      priorCompactions += 1
      lastCompactionSeq = compactions[priorCompactions - 1].seq
      lastCompactionContextTokens = contextTokens
      carriedDebtTokens += ratio === null ? 0 : options.writeTokens * Math.max(0, ratio - 1)
    }
    let requestsSinceCompaction = 0
    if (lastCompactionSeq >= 0) {
      requestsSinceCompaction = requests.filter((request) => request.seq > lastCompactionSeq && request.seq < boundary.seq).length
      const savingPerRequest = Math.max(0, contextTokens - options.memoTokens)
      carriedDebtTokens = Math.max(0, carriedDebtTokens - savingPerRequest * requestsSinceCompaction)
    }
    const priorCounts = counts.slice(0, index)
    if (priorCounts.length === 0 || contextTokens <= 0) continue
    const decision = decideCompaction({
      writeTokens: options.writeTokens,
      archiveTokens: Math.max(0, contextTokens - options.memoTokens),
      memoTokens: options.memoTokens,
      contextTokens,
      completedBoundaryRequestCounts: priorCounts,
      remainingBoundaries: boundaries.length - index,
      averageContextTokenIncrement: increment,
      contextWindowTokens: options.windowTokens,
      priorCompactionCount: priorCompactions,
      carriedDebtTokens,
      cacheDebtRepaymentTokens: 0,
      cacheWriteReadRatio: ratio,
      minContextGrowthTokens: options.minContextGrowthTokens,
      minRequestsSinceCompaction: options.minRequestsSinceCompaction,
      requestsSinceCompaction,
      lastCompactionContextTokens,
    })
    decisions.push({
      boundaryIndex: index,
      boundaryKind: boundary.kind,
      boundaryName: boundary.name ?? '',
      contextTokens,
      compact: decision.compact,
      reason: decision.reason,
      breakevenRequests: decision.breakevenRequests,
      expectedRemainingRequests: decision.expectedRemainingRequests,
    })
  }
  return {
    requests: requests.length,
    boundaries: boundaries.length,
    compactions: compactions.length,
    firstPromptTokens: requests.length > 0 ? requests[0].promptTokens : 0,
    lastPromptTokens: requests.length > 0 ? requests[requests.length - 1].promptTokens : 0,
    averageContextTokenIncrement: increment,
    cache: summarizeCacheUsage(requests),
    decisions,
  }
}

/** Compact reason histogram. */
function histogram(decisions) {
  const result = {}
  for (const decision of decisions) {
    result[decision.reason] = (result[decision.reason] ?? 0) + 1
  }
  return result
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const journals = findJournals(options.sessionsRoot, options.limit)
  const sessions = []
  for (const journal of journals) {
    let text
    try {
      text = decodeJournal(readFileSync(journal.path))
    } catch {
      continue
    }
    const timeline = buildTimeline(text)
    if (timeline.requests.length === 0) continue
    const replay = replaySession(timeline, options)
    sessions.push({ path: journal.path, ...replay })
  }
  const allDecisions = sessions.flatMap((session) => session.decisions)
  const summary = {
    sessions: sessions.length,
    decisions: allDecisions.length,
    compact: allDecisions.filter((decision) => decision.compact).length,
    defer: allDecisions.filter((decision) => !decision.compact).length,
    reasons: histogram(allDecisions),
    boundaryMode: options.boundaryMode,
    cacheWriteReadRatio: Number.isFinite(options.cacheWriteReadRatio) ? options.cacheWriteReadRatio : null,
    note: Number.isFinite(options.cacheWriteReadRatio)
      ? 'cache ratio supplied; decisions are economic'
      : 'no cache ratio supplied; economic compaction must stay deferred (cache_ratio_unavailable)',
  }
  const report = { generatedAt: new Date().toISOString(), options, summary, sessions }
  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    return
  }
  console.log(JSON.stringify(summary, null, 2))
  for (const session of sessions.slice(0, 10)) {
    console.log('\n' + session.path)
    console.log('  requests=' + session.requests
      + ' boundaries=' + session.boundaries
      + ' compactions=' + session.compactions
      + ' prompt=' + session.firstPromptTokens + '->' + session.lastPromptTokens
      + ' cacheReadShare=' + (session.cache.cacheReadShare === null ? 'n/a' : session.cache.cacheReadShare.toFixed(3)))
    const compact = session.decisions.filter((decision) => decision.compact).length
    console.log('  decisions compact=' + compact + ' defer=' + (session.decisions.length - compact))
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
