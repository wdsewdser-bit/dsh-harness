/**
 * observation-pack — Agent Team v13
 *
 * Archives oversized tool observations, keeps them available by absolute path,
 * and projects them down to a compact handle only after the first
 * `fullSends` native adapter handoffs have carried the full text. Adapted from
 * SoL-Pi's ObservationPack mechanism (https://github.com/NVlabs/SoL-Pi).
 *
 * v2 differences from the Phase 2b implementation:
 *  - byte-based threshold (default 10 KiB) instead of character count
 *  - content-addressed archive with sha256 + size verification on recall
 *  - delayed projection through the request-message projection bridge: the first
 *    `fullSends` requests keep the full text, later requests carry the handle
 *  - fail-open: a spill/verify failure leaves the original observation intact
 *  - error results and evidence-reducer receipts are never packed
 *
 * Hooks
 * -----
 *  - tools/post-execute      archive the result, keep it inline for now
 *  - requestMessageProjection replace text before the native llm/stream waterfall
 *  - tools/ptc-dispatch-log  archive PTC sub-dispatch logs immediately (the
 *                            program already got the value; the model never did)
 *
 * Config
 * ------
 *   maxInlineBytes: 10240
 *   fullSends: 2
 *   previewBytes: 1024
 *   evidenceChars: 1500
 *   spillDir: 'D:\\dsh-test\\home\\spill'
 *   tools: ["bash", "read"]   # optional allow-list; default = every tool
 *
 * @module observation-pack
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTelemetry } from './team-v13-mechanism-telemetry.mjs'
import { hasObservationSource, renderObservationSource } from './team-v13-observation-source.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'observation-pack'
/** Requires the removable pre-stream message projection bridge. */
export const inject = ['llm', 'requestMessageProjection']
console.warn('[observation-pack-v2] HMR perf-lineexcerpt loaded 2026-09-27')

const REDUCER_RECEIPT_MARKER = 'sol_pi_evidence_receipt_v1'
const OBSERVATION_ID = /^obs_[a-f0-9]{24}$/
export const HANDLE_VERSION = 2

/** Default evidence-bearing line pattern: what a reader must not lose. */
const DEFAULT_EVIDENCE = /(error|fail|failed|failure|panic|exception|timeout|timed out|denied|refus|cannot|undefined|null pointer|assert|expected|actual|mismatch|warning|\bwarn\b|✗|✘|×|Traceback|\bat [A-Za-z0-9_$.]+\()/i

/** Total UTF-8 byte size of the text blocks. */
export function textSize(blocks) {
  if (!Array.isArray(blocks)) return 0
  let size = 0
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      size += Buffer.byteLength(block.text, 'utf8')
    }
  }
  return size
}

/** Join text blocks in order. */
export function textOf(blocks) {
  const parts = []
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** Hash one string as lowercase sha256 hex. */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** Count lines the same way for archived and recalled text. */
function countLines(text) {
  if (text.length === 0) return 0
  let lines = text.endsWith('\n') ? 0 : 1
  let index = -1
  while ((index = text.indexOf('\n', index + 1)) !== -1) lines += 1
  return lines
}

/** Match one complete LF-delimited line without splitting the full text. */
function hasExactLine(text, marker) {
  let start = 0
  while (start <= text.length) {
    const end = text.indexOf('\n', start)
    const lineEnd = end === -1 ? text.length : end
    if (lineEnd - start === marker.length && text.startsWith(marker, start)) return true
    if (end === -1) return false
    start = end + 1
  }
  return false
}

/** Keep the decisive lines of a long observation inside a character budget. */
function selectEvidence(text, pattern, budget) {
  if (budget <= 0) return { text: '', lineNumbers: [] }
  const seen = new Set()
  const kept = []
  let used = 0
  let start = 0
  let lineNumber = 1
  const lineNumbers = []
  while (start <= text.length) {
    const newline = text.indexOf('\n', start)
    const end = newline === -1 ? text.length : newline
    const rawLine = text.slice(start, end)
    const quote = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const line = quote.trim()
    if (line.length > 0 && line.length <= 400 && pattern.test(line) && !seen.has(line)) {
      const rendered = 'L' + String(lineNumber) + ': ' + quote
      if (used + rendered.length + 1 > budget) break
      seen.add(line)
      used += rendered.length + 1
      kept.push(rendered)
      lineNumbers.push(lineNumber)
    }
    if (newline === -1) break
    start = newline + 1
    lineNumber += 1
  }
  return { text: kept.join('\n'), lineNumbers }
}

/** Complete-line excerpt from the head or the tail. */
function lineExcerpt(text, budgetBytes, fromEnd) {
  if (budgetBytes <= 0 || text.length === 0) return ''
  let used = 0
  if (fromEnd) {
    let end = text.length
    while (end > 0) {
      const previousNewline = end >= 2 ? text.lastIndexOf('\n', end - 2) : -1
      const start = previousNewline === -1 ? 0 : previousNewline + 1
      const bytes = Buffer.byteLength(text.slice(start, end), 'utf8')
      if (used + bytes > budgetBytes) break
      used += bytes
      end = start
    }
    return text.slice(end)
  }
  let end = 0
  while (end < text.length) {
    const newline = text.indexOf('\n', end)
    const next = newline === -1 ? text.length : newline + 1
    const bytes = Buffer.byteLength(text.slice(end, next), 'utf8')
    if (used + bytes > budgetBytes) break
    used += bytes
    end = next
  }
  return text.slice(0, end)
}

/**
 * Create and archive one observation. Returns undefined when the content is
 * small, already a receipt, or cannot be written to disk.
 */
export function createObservation({
  toolName,
  callId,
  blocks,
  spillDir,
  previewBytes,
  evidenceChars,
  evidencePattern = DEFAULT_EVIDENCE,
}) {
  const text = textOf(blocks)
  if (text.length === 0) return undefined
  if (hasExactLine(text, REDUCER_RECEIPT_MARKER)) return undefined
  const bytes = Buffer.byteLength(text, 'utf8')
  const contentHash = sha256(text)
  const id = 'obs_' + contentHash.slice(0, 24)
  const objectDir = join(spillDir, 'objects')
  const filePath = join(objectDir, id + '.txt')
  try {
    mkdirSync(objectDir, { recursive: true })
    if (existsSync(filePath)) {
      if (lstatSync(filePath).isSymbolicLink()) return undefined
      const existing = readFileSync(filePath)
      if (existing.length !== bytes || sha256(existing.toString('utf8')) !== contentHash) return undefined
    } else {
      writeFileSync(filePath, text, { encoding: 'utf8', mode: 0o600 })
      if (lstatSync(filePath).isSymbolicLink()) return undefined
    }
  } catch {
    return undefined
  }
  return {
    id,
    toolName: String(toolName ?? 'tool'),
    callId: callId === undefined || callId === null || String(callId).length === 0
      ? 'generated:' + randomUUID()
      : String(callId),
    contentHash,
    filePath,
    text,
    bytes,
    lines: countLines(text),
    tokens: Math.ceil(text.length / 4),
    sentCount: 0,
    replaced: false,
    previewBytes,
    evidenceChars,
    evidencePattern,
  }
}

/** Render the compact handle for one archived observation. */
export function renderHandle(observation, text = observation.text) {
  const headBudget = Math.floor(observation.previewBytes / 2)
  const tailBudget = observation.previewBytes - headBudget
  const head = lineExcerpt(text, headBudget, false)
  const tail = lineExcerpt(text, tailBudget, true)
  const evidence = selectEvidence(text, observation.evidencePattern, observation.evidenceChars)
  return [
    '[large tool result replaced after its first '
      + String(observation.fullSends ?? 0)
      + ' provider requests]',
    'id: ' + observation.id,
    'handle_version: ' + String(HANDLE_VERSION),
    'tool: ' + observation.toolName,
    'session_id: ' + String(observation.sessionId ?? 'session:unknown'),
    'call_id: ' + String(observation.callId ?? ''),
    'original_bytes: ' + String(observation.bytes),
    'original_lines: ' + String(observation.lines),
    'estimated_tokens: ' + String(observation.tokens),
    'retrieve: read ' + observation.filePath,
    renderObservationSource({
      processor: 'observation-pack',
      result: 'archived-handle',
      sha256: observation.contentHash,
      archiveId: observation.id,
      archivePath: observation.filePath,
      bytes: observation.bytes,
      lineNumbers: evidence.lineNumbers,
    }),
    '[first complete lines, up to ' + String(headBudget) + ' bytes]',
    head,
    '[middle omitted; last complete lines, up to ' + String(tailBudget) + ' bytes]',
    tail,
    evidence.text.length > 0 ? '--- evidence lines (L<number> is the original 1-based log line) ---\n' + evidence.text : '',
    '[' + String(observation.bytes) + ' original bytes omitted]',
  ].filter((part) => part.length > 0).join('\n')
}

/** Verify the archive still matches the recorded hash and size. */
export function verifyArchive(observation) {
  try {
    if (lstatSync(observation.filePath).isSymbolicLink()) return false
    const stats = statSync(observation.filePath)
    if (!stats.isFile() || stats.size !== observation.bytes) return false
    const content = readFileSync(observation.filePath)
    return sha256(content.toString('utf8')) === observation.contentHash
  } catch {
    return false
  }
}

function archiveSignature(observation) {
  try {
    if (lstatSync(observation.filePath).isSymbolicLink()) return null
    const stats = statSync(observation.filePath)
    if (!stats.isFile() || stats.size !== observation.bytes) return null
    return [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(':')
  } catch {
    return null
  }
}

function renderVerifiedHandle(observation) {
  const before = archiveSignature(observation)
  if (before === null) return undefined
  if (observation.verifiedSignature === before && observation.cachedHandleVersion === HANDLE_VERSION && typeof observation.cachedHandle === 'string') {
    return observation.cachedHandle
  }
  try {
    const content = readFileSync(observation.filePath)
    const text = content.toString('utf8')
    if (sha256(text) !== observation.contentHash) return undefined
    const after = archiveSignature(observation)
    if (after === null || after !== before) return undefined
    observation.verifiedSignature = after
    observation.cachedHandle = renderHandle(observation, text)
    observation.cachedHandleVersion = HANDLE_VERSION
    delete observation.text
    return observation.cachedHandle
  } catch {
    return undefined
  }
}

/**
 * Replace matching current tool and legacy toolResult messages. Returns
 * the number of messages changed. Legacy direct callers may consume their own
 * send counter; the runtime bridge always uses consume:false and commits at dispatch.
 */
export function projectMessages(messages, observations, sessionId = '', { consume = true } = {}) {
  if (!Array.isArray(messages) || observations.size === 0) return { messages, changed: 0, savedTokens: 0 }
  let copy = messages
  let changed = 0
  let savedTokens = 0
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (!message || (message.role !== 'tool' && message.role !== 'toolResult') || message.isError === true || !Array.isArray(message.content)) continue
    if (message.content.length === 0 || !message.content.every(block => block?.type === 'text' && typeof block.text === 'string')) continue
    // v13 keyed entries by call ID only. Keep reading that shape so old
    // fixtures and an already-live in-memory map remain usable while new
    // entries use the session+call key to prevent cross-session collisions.
    const observation = observations.get(observationKey(sessionId, message.toolCallId))
      ?? observations.get(String(message.toolCallId))
    if (observation === undefined) continue
    if (consume) observation.sentCount += 1
    if (consume ? observation.sentCount <= observation.fullSends : observation.sentCount < observation.fullSends) continue
    let handle
    if (consume) handle = renderVerifiedHandle(observation)
    else {
      try {
        const signature = archiveSignature(observation)
        if (signature === null) continue
        if (observation.verifiedSignature === signature && observation.cachedHandleVersion === HANDLE_VERSION && typeof observation.cachedHandle === 'string') handle = observation.cachedHandle
        else {
          const text = readFileSync(observation.filePath, 'utf8')
          if (sha256(text) === observation.contentHash && archiveSignature(observation) === signature) handle = renderHandle(observation, text)
        }
      } catch { /* Missing or changed archives retain the original request. */ }
    }
    if (handle === undefined) continue
    if (copy === messages) copy = messages.slice()
    copy[index] = { ...message, content: [{ type: 'text', text: handle }] }
    changed += 1
    savedTokens += Math.max(0, observation.tokens - Math.ceil(handle.length / 4))
  }
  return { messages: copy, changed, savedTokens }
}

function observationKey(sessionId, callId) {
  return String(sessionId || 'session:unknown') + '\0' + String(callId)
}

/**
 * Register the archive, projection and PTC listeners.
 * @param ctx - cordis plugin context.
 * @param config - this plugin row's config.
 */
export function apply(ctx, config = {}) {
  const maxInlineBytes = Number.isFinite(config.maxInlineBytes)
    ? config.maxInlineBytes
    : Number.isFinite(config.maxInlineChars)
      ? config.maxInlineChars
      : 10240
  const fullSends = Number.isFinite(config.fullSends) ? Math.max(0, config.fullSends) : 2
  const previewBytes = Number.isFinite(config.previewBytes)
    ? config.previewBytes
    : Number.isFinite(config.previewChars)
      ? config.previewChars
      : 1024
  const evidenceChars = Number.isFinite(config.evidenceChars) ? config.evidenceChars : 1500
  const stateTtlMs = Number.isFinite(config.stateTtlMs) ? Math.max(1000, config.stateTtlMs) : 30 * 60 * 1000
  const maxTracked = Number.isFinite(config.maxTracked) ? Math.max(1, Math.floor(config.maxTracked)) : 2048
  const spillDir = typeof config.spillDir === 'string' && config.spillDir.length > 0
    ? config.spillDir
    : join(process.env.TEMP || process.env.TMPDIR || '.', 'dsh-observations')
  const evidencePattern = typeof config.evidencePattern === 'string' && config.evidencePattern.length > 0
    ? new RegExp(config.evidencePattern, 'i')
    : DEFAULT_EVIDENCE
  const allowed = Array.isArray(config.tools) && config.tools.length > 0 ? new Set(config.tools) : undefined
  const wanted = (label) => allowed === undefined || allowed.has(label)

  const observations = new Map()
  const telemetry = createTelemetry('observation-pack', { dir: config.telemetryDir, enabled: true })
  const sessionIdOf = (value) => String(value?.agent?.session?.id ?? value?.sessionId ?? value?.session?.id ?? value?.agent?.id ?? 'session:unknown')
  const stats = {
    archived: 0,
    replaced: 0,
    verifyFailures: 0,
    skippedSmall: 0,
    skippedError: 0,
    skippedReceipt: 0,
    projectionUnavailable: 0,
  }

  const pruneObservations = (now = Date.now()) => {
    for (const [key, observation] of observations) {
      if (now - observation.lastAccessAt > stateTtlMs) observations.delete(key)
    }
    while (observations.size > maxTracked) observations.delete(observations.keys().next().value)
  }
  const archive = (toolName, callId, blocks, sessionId) => {
    pruneObservations()
    const effectiveCallId = callId === undefined || callId === null || String(callId).length === 0
      ? 'generated:' + randomUUID()
      : String(callId)
    const observation = createObservation({
      toolName,
      callId: effectiveCallId,
      blocks,
      spillDir,
      previewBytes,
      evidenceChars,
      evidencePattern,
    })
    if (observation === undefined) return undefined
    observation.sessionId = String(sessionId || 'session:unknown')
    observation.lastAccessAt = Date.now()
    observation.fullSends = fullSends
    observations.set(observationKey(observation.sessionId, observation.callId), observation)
    pruneObservations()
    stats.archived += 1
    telemetry.event('archived', {
      id: observation.id,
      callId: observation.callId,
      sessionId: observation.sessionId,
      bytes: observation.bytes,
      tool: observation.toolName,
    }, {
      toolCalls: 1,
    })
    return observation
  }

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (downstream.kind === 'block') return downstream
    if (!exec || !wanted(exec.name)) return downstream
    if (!result || result.isError === true) {
      stats.skippedError += 1
      telemetry.skipped('error-result', { sessionId: sessionIdOf(exec) })
      return downstream
    }
    const text = textOf(result.content)
    if (hasExactLine(text, REDUCER_RECEIPT_MARKER)) {
      stats.skippedReceipt += 1
      telemetry.skipped('reducer-receipt', { sessionId: sessionIdOf(exec) })
      return downstream
    }
    if (hasObservationSource(text)) {
      stats.skippedReceipt += 1
      telemetry.skipped('already-observed', { sessionId: sessionIdOf(exec) })
      return downstream
    }
    if (textSize(result.content) <= maxInlineBytes) {
      stats.skippedSmall += 1
      telemetry.skipped('below-threshold', { sessionId: sessionIdOf(exec) })
      return downstream
    }
    archive(exec.name, exec.callId, result.content, sessionIdOf(exec))
    return downstream
  })

  const project = (options) => {
    try {
      if (options && Array.isArray(options.messages)) {
        const sessionId = sessionIdOf(options)
        const projection = projectMessages(options.messages, observations, sessionId, { consume: false })
        return { messages: projection.messages, changed: projection.changed, savedTokens: projection.savedTokens }
      }
    } catch { /* Pure preview and preparation fail open. */ }
    return undefined
  }
  const unregisterProjection = ctx.requestMessageProjection.register('observation-pack', project, {
    order: 20,
    preview: project,
    onDispatch({ options, result, receipt }) {
      try {
        const sessionId = sessionIdOf(options)
        const counted = new Set()
        for (const message of options.messages) {
          if (message?.role !== 'tool' && message?.role !== 'toolResult') continue
          if (message.isError === true || !message.content?.length || !message.content.every(block => block?.type === 'text')) continue
          const observation = observations.get(observationKey(sessionId, message.toolCallId)) ?? observations.get(String(message.toolCallId))
          if (!observation || counted.has(observation)) continue
          counted.add(observation)
          observation.lastAccessAt = Date.now()
          if (sha256(textOf(message.content)) === observation.contentHash) observation.sentCount += 1
          if (observation.sentCount >= observation.fullSends) renderVerifiedHandle(observation)
        }
        stats.replaced += result.changed
        if (result.changed > 0) {
          telemetry.event('replaced', {
            count: result.changed, sessionId, requestId: receipt.requestId, stage: receipt.stage,
          }, {
            savedTokens: result.savedTokens,
            toolCalls: result.changed,
          })
        }
        pruneObservations()
      } catch {
        stats.projectionUnavailable += 1
      }
    },
  })
  // Cordis unload tears down registered effects; older focused fixtures expose
  // only a `dispose` event. One idempotent disposer supports both lifecycles.
  let projectionDisposed = false
  const disposeProjection = () => {
    if (projectionDisposed) return
    projectionDisposed = true
    try { unregisterProjection?.() } catch { /* teardown is best effort */ }
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => disposeProjection)
  if (typeof ctx.on === 'function') ctx.on('dispose', disposeProjection)

  ctx.on('tools/ptc-dispatch-log', async (dispatch, next) => {
    const blocks = await next()
    if (!dispatch || dispatch.isError === true || !wanted(dispatch.name)) return blocks
    if (textSize(blocks) <= maxInlineBytes) return blocks
    const observation = archive(dispatch.name, dispatch.subCallId, blocks, sessionIdOf(dispatch))
    if (observation === undefined) return blocks
    const handle = renderVerifiedHandle(observation)
    if (handle === undefined) {
      stats.verifyFailures += 1
      telemetry.skipped('archive-verify-failed', { id: observation.id, sessionId: sessionIdOf(dispatch) })
      return blocks
    }
    stats.replaced += 1
    telemetry.event('replaced', {
      count: 1,
      kind: 'ptc',
      sessionId: sessionIdOf(dispatch),
    }, {
      savedTokens: Math.max(0, observation.tokens - Math.ceil(handle.length / 4)),
      toolCalls: 1,
    })
    return [{ type: 'text', text: handle }]
  })

  /** Test/diagnostic snapshot; never mutates state. */
  try {
    ctx.observationPackStats = () => ({ ...stats, tracked: observations.size, stateTtlMs, maxTracked })
  } catch {
    /* diagnostics are best effort */
  }
}
