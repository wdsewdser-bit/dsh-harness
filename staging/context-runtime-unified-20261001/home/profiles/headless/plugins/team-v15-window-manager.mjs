// team-v15-window-manager — a read-only shadow observer for the window fold rule.
//
// It answers one question at every finished main request: "what would the fold rule choose right now, and why?" and
// appends that verdict to a JSONL log. It folds nothing, registers no tool, mutates no message and never vetoes a
// request, so its log can be compared against the real triggers before any of them is switched on. Recording only
// transitions (action+reason+mechanism that changed) keeps a long session from filling the file with one repeated line.

import { appendFile, mkdir } from 'node:fs/promises'
import { readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { decideWindowAction } from './team-v15-window-decision.mjs'
import { observeStream } from './request-usage-ledger.mjs'

export const name = 'team-v15-window-manager'
// `llm` owns the stream waterfall we observe; `agents` resolves the live idle state of a session's agent.
export const inject = ['llm', 'agents']

const VERSION = 1
const MAX_SESSIONS = 4096
const DEFAULT_WINDOW_TOKENS = 1048576
const DEFAULT_MAX_RECORDS_PER_FILE = 20000

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 512 ? value.trim() : null
const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback
const safely = (fn, fallback = null) => { try { return fn() ?? fallback } catch { return fallback } }
const service = (ctx, key) => safely(() => ctx.get?.(key) ?? ctx[key])

/** The live idle signal: the harness publishes `agent.status`, and the real fold engine accepts a fold only at idle. */
function boundaryOf(agents, sessionId) {
  const agent = safely(() => agents?.get?.(sessionId))
  if (!object(agent)) return { safeBoundary: false, boundaryKnown: false }
  const status = text(agent.status ?? agent.state)
  if (status === null) return { safeBoundary: false, boundaryKnown: false }
  return { safeBoundary: status.toLowerCase() === 'idle', boundaryKnown: true }
}

export function apply(ctx, config = {}) {
  const source = object(config) ? config : {}
  const mode = source.mode === 'shadow' ? 'shadow' : 'off'
  const directory = text(source.directory)
  const settings = object(source.settings) ? source.settings : {}
  const windowTokens = positive(Number(source.windowTokens), DEFAULT_WINDOW_TOKENS)
  const maxRecordsPerFile = Math.max(1, Math.floor(positive(Number(source.maxRecordsPerFile), DEFAULT_MAX_RECORDS_PER_FILE)))

  let warned = false
  const warnOnce = error => {
    if (warned) return
    warned = true
    safely(() => ctx.logger?.warn?.('team-v15-window-manager: ' + String(error?.message ?? error)))
  }

  // off, or shadow without a destination: install nothing. Shadow must be told where to write, or it would silently
  // run without leaving the evidence that is its whole purpose.
  if (mode !== 'shadow' || directory === null) {
    if (mode === 'shadow') warnOnce(new Error('shadow mode requires a `directory`'))
    const empty = () => Promise.resolve()
    empty.idleDecision = () => null
    empty.flush = () => Promise.resolve()
    return empty
  }

  const lastTerminals = new Map()
  const lastVerdicts = new Map()
  const listeners = []
  let disposed = false
  let settingsHashComputed = false
  let settingsHash = null
  let writeTail = Promise.resolve()
  let directoryReady = false
  let fileSeq = 0
  let recordsInFile = 0
  const agents = service(ctx, 'agents')
  const milestonePath = text(source.milestonePath)
  let milestoneCache = { mtimeMs: -1, doc: null }

  // "A large phase was ticked and has not been folded yet", read from the milestone file the fold engine itself uses.
  // Unknown (no path, no Team membership, unreadable file) is reported as unknown, never guessed.
  const milestoneOf = sessionId => {
    if (milestonePath === null) return { milestoneKnown: false }
    try {
      const agent = agents?.get?.(sessionId)
      const membership = service(ctx, 'agentTeams')?.tryMembership?.(agent)
      const team = text(membership?.id), member = text(membership?.name)
      if (team === null || member === null) return { milestoneKnown: false }
      const mtimeMs = statSync(milestonePath).mtimeMs
      if (mtimeMs !== milestoneCache.mtimeMs) milestoneCache = { mtimeMs, doc: JSON.parse(readFileSync(milestonePath, 'utf8')) }
      const scope = milestoneCache.doc?.teams?.[team]
      if (!object(scope)) return { milestoneKnown: false }
      const record = scope.members?.[member]
      return { milestoneKnown: true, milestoneDone: object(record) && record.done === true && record.compactedAt === undefined }
    } catch { return { milestoneKnown: false } }
  }

  // Settings are hashed lazily so a malformed config can fail inside the observer instead of during apply.
  const hashSettings = () => {
    if (settingsHashComputed) return settingsHash
    settingsHashComputed = true
    try {
      settingsHash = createHash('sha256').update(JSON.stringify(settings, Object.keys(settings).sort())).digest('hex')
    } catch { settingsHash = null }
    return settingsHash
  }

  const filePath = () => join(directory, `window-decisions-${process.pid}-${String(fileSeq).padStart(4, '0')}.jsonl`)

  const appendLine = async line => {
    if (!directoryReady) {
      await mkdir(directory, { recursive: true })
      directoryReady = true
    }
    // The cap bounds a single file so a long-lived process never grows one unbounded log.
    if (recordsInFile >= maxRecordsPerFile) { fileSeq++; recordsInFile = 0 }
    await appendFile(filePath(), line, 'utf8')
    recordsInFile++
  }

  // Writing is queued behind a single tail so appends stay ordered without ever blocking the request that produced them.
  const enqueue = row => {
    const line = JSON.stringify(row) + '\n'
    writeTail = writeTail.then(() => appendLine(line)).catch(warnOnce)
    return writeTail
  }

  const remember = (sessionId, summary) => {
    if (lastTerminals.has(sessionId)) lastTerminals.delete(sessionId)
    lastTerminals.set(sessionId, summary)
    while (lastTerminals.size > MAX_SESSIONS) {
      const oldest = lastTerminals.keys().next().value
      lastTerminals.delete(oldest)
      lastVerdicts.delete(oldest)
    }
  }

  const decide = (sessionId, input) => {
    const summary = lastTerminals.get(sessionId)
    if (summary === undefined) return null
    return decideWindowAction({
      contextTokens: summary.contextTokens,
      windowTokens,
      milestoneDone: milestoneOf(sessionId).milestoneDone,
      window: { eligible: false },
      // The idle clock runs from the end of the last request; no hit ratio is passed, so that clock decides.
      lastRequestAt: summary.endedAt,
      ...input,
    }, settings)
  }

  const acceptTerminal = record => {
    try {
      if (disposed || !object(record) || record.event !== 'terminal') return
      if (record.status !== 'success') return
      const sessionId = text(record.sessionId)
      if (sessionId === null || text(record.purpose) !== 'conversation') return
      const usage = object(record.usage) ? record.usage : {}
      const inputTokens = positive(usage.inputTokens, 0)
      const cacheReadTokens = positive(usage.cacheReadTokens, 0)
      const cacheWriteTokens = positive(usage.cacheWriteTokens, 0)
      // The three counts are disjoint, so their sum is the request's context size.
      const contextTokens = inputTokens + cacheReadTokens + cacheWriteTokens
      if (contextTokens <= 0) return
      const cacheHitRatio = cacheReadTokens / contextTokens
      const endedAt = Date.parse(record.endedAt)
      const now = Number.isFinite(endedAt) ? endedAt : Date.now()
      const at = new Date(now).toISOString()
      const boundary = boundaryOf(agents, sessionId), milestone = milestoneOf(sessionId)
      // A terminal has just fired, so the idle clock is zero here; the cache signal comes from the reported ratio.
      const decision = decideWindowAction({
        contextTokens,
        windowTokens,
        now,
        lastRequestAt: now,
        lastCacheHitRatio: cacheHitRatio,
        safeBoundary: boundary.safeBoundary,
        milestoneDone: milestone.milestoneDone,
        window: { eligible: false },
      }, settings)
      remember(sessionId, { contextTokens, cacheHitRatio, endedAt: now, safeBoundary: boundary.safeBoundary })
      const verdict = `${decision.action}\u0000${decision.reason}\u0000${decision.mechanism ?? 'none'}`
      if (lastVerdicts.get(sessionId) === verdict) return
      lastVerdicts.set(sessionId, verdict)
      enqueue({
        version: VERSION, at, sessionId, requestId: text(record.requestId),
        action: decision.action, reason: decision.reason, mechanism: decision.mechanism ?? null,
        contextTokens, cacheHitRatio,
        milestoneKnown: milestone.milestoneKnown, boundaryKnown: boundary.boundaryKnown,
        settingsHash: hashSettings(),
      })
    } catch (error) {
      // The observer may never reach the request stream.
      warnOnce(error)
    }
  }

  if (typeof ctx.on === 'function') {
    const listen = (event, handler, options) => {
      const unregister = safely(() => ctx.on(event, handler, options))
      if (typeof unregister === 'function') listeners.push(unregister)
    }
    listen('llm/stream', (options, next) => {
      if (disposed) return next()
      const sessionId = text(options?.sessionId)
      // Only main requests are in scope; auxiliary and compaction calls are skipped before they are wrapped.
      if (sessionId === null) return next()
      // The agent loop's own requests carry no purpose; only auxiliary calls (compaction, titles) name one.
      if ((text(options?.purpose) ?? 'conversation') !== 'conversation') return next()
      // observeStream reports usage and timing only; which session and purpose it was has to be supplied here.
      return observeStream(options, next, { metadata: () => ({ sessionId, purpose: 'conversation' }), record: acceptTerminal })
    }, { global: true })
  }

  const idleDecision = (sessionId, now = Date.now()) => {
    const id = text(sessionId)
    if (id === null) return null
    return safely(() => {
      const boundary = boundaryOf(agents, id)
      return decide(id, {
        now: Number.isFinite(Number(now)) ? Number(now) : Date.now(),
        safeBoundary: boundary.safeBoundary,
      })
    })
  }

  const dispose = () => {
    if (disposed) return writeTail
    disposed = true
    for (const unregister of listeners.splice(0)) safely(unregister)
    return writeTail
  }
  const flush = () => writeTail

  if (typeof ctx.on === 'function') {
    const unregister = ctx.on('dispose', dispose)
    if (typeof unregister === 'function') listeners.push(unregister)
  }
  if (typeof ctx.effect === 'function') safely(() => ctx.effect(() => dispose))

  dispose.idleDecision = idleDecision
  dispose.flush = flush
  return dispose
}

// The loaded-code certificate reads this module's own source hash from here (see team-v15-window-loaded.mjs).
import { registerLoadedModule } from './team-v15-window-loaded.mjs'
registerLoadedModule(import.meta.url)
