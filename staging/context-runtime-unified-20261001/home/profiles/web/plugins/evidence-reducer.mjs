/**
 * evidence-reducer — Agent Team v13
 *
 * Delegates the first reading of a long diagnostic log to a reducer route and
 * accepts the result only when every quoted line can be matched verbatim in
 * the archived source. Adapted from SoL-Pi's Evidence-Preserving Reducer
 * (https://github.com/NVlabs/SoL-Pi, MIT).
 *
 * The main session keeps the full log on disk and receives a compact receipt
 * with an archive path. A reducer failure, timeout, malformed receipt, or
 * unverifiable quotation leaves the original observation untouched.
 *
 * Routing:
 *   route: 'session'                    use the session's latest request route
 *   route: { provider, model, effort? } explicit route
 *
 * Provider/model values come from DSH's own registered providers; this plugin
 * stores no credentials. Remote routes require `remoteAllowed: true` unless the
 * provider is listed in `localProviders`.
 *
 * @module evidence-reducer
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { readJournalTail } from './team-usage.mjs'
import { createTelemetry } from './team-v13-mechanism-telemetry.mjs'
import { readDurableJson, updateDurableJsonSync } from './team-v14-durable-store.mjs'
import {
  hasObservationSource,
  parseObservationSource,
  renderObservationSource,
} from './team-v13-observation-source.mjs'
import { controlPlaneForMember } from './team-control-plane.mjs'
import { createEvidenceRegistry, registerEvidence } from './team-v12-evidence-scheduler.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'evidence-reducer'
/** The reducer needs the LLM service and observes settings updates. */
export const inject = ['llm', 'settings']

export const RECEIPT_MARKER = 'sol_pi_evidence_receipt_v1'
export const RECEIPT_VERSION = 1
export const DEFAULT_SETTINGS_FILE = 'D:\\dsh-test\\home\\evidence-reducer.json'

/**
 * Volatile fields make the reducer route editable in Settings > Plugins.
 * The JSON file remains the runtime document for the command fallback, while
 * settings changes are mirrored into it by the listener below.
 */
export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  settingsFile: z.string().default(DEFAULT_SETTINGS_FILE).volatile(),
  useSettingsFile: z.boolean().default(true).volatile(),
  archiveDir: z.string().default('').volatile(),
  sessionsRoot: z.string().default('').volatile(),
  telemetryDir: z.string().default('').volatile(),
  localProviders: z.array(z.string()).default([]).volatile(),
  tools: z.array(z.string()).default([]).volatile(),
  routeMode: z.string().default('session').volatile(),
  provider: z.string().default('').volatile(),
  model: z.string().default('').volatile(),
  reasoningEffort: z.string().default('').volatile(),
  remoteAllowed: z.boolean().default(false).volatile(),
  thresholdBytes: z.number().step(1).min(1).default(20480).volatile(),
  maxReceiptTokens: z.number().step(1).min(1).default(1500).volatile(),
  timeoutMs: z.number().step(1).min(1).default(60000).volatile(),
  maxQuotes: z.number().step(1).min(1).default(20).volatile(),
  maxInputBytes: z.number().step(1).min(1024).default(262144).volatile(),
  maxInputLines: z.number().step(1).min(10).default(4000).volatile(),
  controlDir: z.string().default('D:\\dsh-test\\home\\team-control-plane').volatile(),
  controlPlaneEnabled: z.boolean().default(true).volatile(),
})

const SESSION_ROUTE_TTL_MS = 30_000

/** sha256 hex for a string. */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** Count lines consistently with the archive. */
function countLines(text) {
  if (text.length === 0) return 0
  let lines = 1
  let index = -1
  while ((index = text.indexOf('\n', index + 1)) !== -1) lines += 1
  return lines
}

/** Join the text blocks of one tool result. */
export function textOf(blocks) {
  const parts = []
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

const IMPORTANT_LINE = /(error|fail|failed|failure|panic|exception|timeout|timed out|denied|refus|assert|expected|actual|mismatch|warning|\bwarn\b|traceback|\bat [A-Za-z0-9_$.]+\()/i
const TIME_LINE = /\b(?:\d{4}-\d\d-\d\d[T ][0-2]\d:[0-5]\d:[0-6]\d|[0-2]\d:[0-5]\d:[0-6]\d(?:\.\d+)?)\b/

/** Select a bounded, line-numbered head/tail/error/time sample from a log. */
export function buildBoundedInput(text, options = {}) {
  const maxBytes = Number.isFinite(options.maxInputBytes) ? Math.max(1, Math.floor(options.maxInputBytes)) : 262144
  const maxLines = Number.isFinite(options.maxInputLines) ? Math.max(1, Math.floor(options.maxInputLines)) : 4000
  const lines = String(text ?? '').split(/\r?\n/)
  const selected = new Map()
  let usedBytes = 0
  const add = (index) => {
    if (index < 0 || index >= lines.length || selected.has(index) || selected.size >= maxLines) return false
    const rendered = 'L' + String(index + 1) + ': ' + lines[index]
    const bytes = Buffer.byteLength(rendered, 'utf8') + (selected.size > 0 ? 1 : 0)
    if (usedBytes + bytes > maxBytes) return false
    selected.set(index, rendered)
    usedBytes += bytes
    return true
  }
  const important = []
  const timed = []
  for (let index = 0; index < lines.length; index += 1) {
    if (selected.has(index)) continue
    if (IMPORTANT_LINE.test(lines[index])) important.push(index)
    else if (TIME_LINE.test(lines[index])) timed.push(index)
  }
  for (const index of important) add(index)
  const edge = Math.max(1, Math.floor(maxLines / 4))
  for (let index = 0; index < Math.min(edge, lines.length); index += 1) add(index)
  for (let index = Math.max(0, lines.length - edge); index < lines.length; index += 1) add(index)
  for (const index of timed) add(index)
  const indices = [...selected.keys()].sort((a, b) => a - b)
  const chunks = []
  for (const index of indices) {
    const last = chunks[chunks.length - 1]
    if (last && last.endExclusive === index) last.endExclusive = index + 1
    else chunks.push({ startLine: index + 1, endExclusive: index + 1 })
  }
  return {
    text: indices.map(index => selected.get(index)).join('\n'),
    scannedRanges: chunks.map(range => ({ startLine: range.startLine, endLine: range.endExclusive })),
    fallbackReason: selected.size < lines.length ? 'bounded-input-truncated' : null,
    scannedLines: selected.size,
    scannedBytes: usedBytes,
    totalLines: lines.length,
  }
}

/** Archive one log under a content-addressed path. */
export function archiveText(text, archiveDir) {
  const digest = sha256(text)
  const objectDir = join(archiveDir, 'objects')
  const filePath = join(objectDir, digest + '.txt')
  try {
    mkdirSync(objectDir, { recursive: true })
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, 'utf8')
      if (existing !== text) return undefined
    } else {
      writeFileSync(filePath, text, { encoding: 'utf8', mode: 0o600 })
    }
  } catch {
    return undefined
  }
  return { id: 'evr_' + digest.slice(0, 24), filePath, sha256: digest, bytes: Buffer.byteLength(text, 'utf8'), lines: countLines(text) }
}

/** Extract the first JSON object from a model response. */
export function parseReceipt(text) {
  if (typeof text !== 'string') return undefined
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/**
 * Verify a receipt against the archived source. Every quotation must match the
 * named source line verbatim (substring match tolerates trimmed indentation).
 */
export function verifyReceipt(receipt, sourceText, options = {}) {
  const reasons = []
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { ok: false, reasons: ['receipt-not-object'] }
  }
  if (receipt.version !== RECEIPT_VERSION) reasons.push('receipt-version')
  if (typeof receipt.summary !== 'string' || receipt.summary.trim().length === 0) reasons.push('summary-missing')
  const maxChars = Number.isFinite(options.maxReceiptTokens) ? options.maxReceiptTokens * 4 : 6000
  if (typeof receipt.summary === 'string' && receipt.summary.length > maxChars) reasons.push('summary-too-long')
  if (!Array.isArray(receipt.quotes) || receipt.quotes.length === 0) {
    reasons.push('quotes-missing')
    return { ok: false, reasons }
  }
  const sourceLines = String(sourceText ?? '').split(/\r?\n/)
  for (const [index, quote] of receipt.quotes.entries()) {
    if (quote === null || typeof quote !== 'object') {
      reasons.push('quote-' + String(index) + '-not-object')
      continue
    }
    const line = Number(quote.line)
    if (!Number.isInteger(line) || line < 1 || line > sourceLines.length) {
      reasons.push('quote-' + String(index) + '-line-out-of-range')
      continue
    }
    if (typeof quote.text !== 'string' || quote.text.length === 0 || quote.text.length > 500) {
      reasons.push('quote-' + String(index) + '-text-invalid')
      continue
    }
    if (!sourceLines[line - 1].includes(quote.text)) {
      reasons.push('quote-' + String(index) + '-mismatch')
    }
  }
  if (receipt.unresolved !== undefined && !Array.isArray(receipt.unresolved)) reasons.push('unresolved-invalid')
  return { ok: reasons.length === 0, reasons }
}

/** Render a verified receipt as the model-facing observation. */
export function renderReceipt(receipt, archive, coverage = {}) {
  const lines = [
    RECEIPT_MARKER,
    renderObservationSource({
      processor: 'evidence-reducer',
      result: 'verified-receipt',
      sha256: archive.sha256,
      archiveId: archive.id,
      archivePath: archive.filePath,
      bytes: archive.bytes,
      lineNumbers: receipt.quotes.map((quote) => Number(quote.line)),
    }),
    'summary: ' + receipt.summary.trim(),
    'scanned_ranges: ' + JSON.stringify(coverage.scannedRanges ?? []),
    'fallback_reason: ' + String(coverage.fallbackReason ?? 'none'),
    'quotes:',
  ]
  for (const quote of receipt.quotes) {
    lines.push('- L' + String(quote.line) + ': ' + quote.text)
  }
  if (Array.isArray(receipt.unresolved) && receipt.unresolved.length > 0) {
    lines.push('unresolved:')
    for (const item of receipt.unresolved) lines.push('- ' + String(item))
  }
  lines.push('archive: ' + archive.filePath)
  lines.push('archive_sha256: ' + archive.sha256)
  lines.push('original_bytes: ' + String(archive.bytes))
  lines.push('original_lines: ' + String(archive.lines))
  lines.push('read the archive path for the complete log; the receipt is a verified index, not a replacement for evidence.')
  return lines.join('\n')
}

/** Prompt for the reducer route. */
export function buildReducerPrompt(text, archive, options) {
  const maxQuotes = Number.isFinite(options.maxQuotes) ? options.maxQuotes : 20
  return [
    'Read the diagnostic log below and return only one JSON object.',
    'Schema:',
    '{"version":1,"summary":"short summary","quotes":[{"line":<1-based line number>,"text":"exact substring of that line"}],"unresolved":["..."]}',
    'Rules:',
    '- Input lines are prefixed L<number>; every quote.line must use that original number.',
    '- Every quote.text must be copied verbatim from the named line; no paraphrase.',
    '- Include only lines that change the next decision: errors, failures, warnings, failing assertions, or the decisive result.',
    '- At most ' + String(maxQuotes) + ' quotes.',
    '- Do not invent line numbers or content.',
    'Archive: ' + archive.filePath,
    '--- LOG START ---',
    text,
    '--- LOG END ---',
  ].join('\n')
}

/** Find the session directory for one session id. */
function findSessionDir(root, sessionId, depth = 0) {
  if (depth > 4) return undefined
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name)
    if (entry.name === sessionId) return path
    const nested = findSessionDir(path, sessionId, depth + 1)
    if (nested !== undefined) return nested
  }
  return undefined
}

/** Read the latest request route from a session journal. */
export function resolveSessionRoute(agent, sessionsRoot) {
  const sessionId = agent?.session?.id ?? agent?.id
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  const dir = findSessionDir(sessionsRoot, sessionId)
  if (dir === undefined) return undefined
  for (const name of ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd']) {
    const file = join(dir, name)
    if (!existsSync(file)) continue
    let text
    try {
      text = readJournalTail(file, 32, 524_288, 4_194_304)
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index].length === 0) continue
      let event
      try {
        event = JSON.parse(lines[index])
      } catch {
        continue
      }
      if (event.type !== 'request/header') continue
      const config = event.data?.header?.config
      if (config === undefined) continue
      return {
        provider: config.provider,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
      }
    }
  }
  return undefined
}

/** One bounded reducer call; returns text plus provider usage or throws. */
const SKIP_MESSAGE_TIME = Symbol.for('dsh.team-message-time.skip-response')

export async function callReducer(llm, route, prompt, options) {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  const signals = [controller.signal]
  if (options.signal !== undefined) signals.push(options.signal)
  const signal = typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : controller.signal
  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: options.maxReceiptTokens,
      signal,
      [SKIP_MESSAGE_TIME]: true,
    })
    let text = ''
    let usage
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      if (chunk?.type === 'usage' && chunk.usage !== undefined) usage = chunk.usage
      if (chunk?.type === 'finish' && chunk.reason?.kind !== 'stop') {
        throw new Error('reducer finish: ' + String(chunk.reason?.kind))
      }
    }
    return { text, usage, ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

/** Normalize the route fields shared by settings and the JSON fallback. */
function normalizeReducerConfig(config) {
  const next = { ...config }
  if (next.routeMode === 'session') {
    next.route = 'session'
  } else if (next.routeMode === 'off') {
    next.enabled = false
  } else if (next.routeMode === 'explicit'
    && typeof next.provider === 'string' && next.provider.length > 0
    && typeof next.model === 'string' && next.model.length > 0) {
    next.route = {
      provider: next.provider,
      model: next.model,
      ...typeof next.reasoningEffort === 'string' && next.reasoningEffort.length > 0
        ? { reasoningEffort: next.reasoningEffort }
        : {},
    }
  } else if (next.routeMode === 'explicit') {
    delete next.route
  }
  return next
}

/** Read the optional JSON settings file and merge it over static config. */
export function effectiveConfig(config) {
  if (config.useSettingsFile === false) return normalizeReducerConfig(config)
  const file = typeof config.settingsFile === 'string' && config.settingsFile.length > 0
    ? config.settingsFile
    : DEFAULT_SETTINGS_FILE
  try {
    if (existsSync(file)) {
      return normalizeReducerConfig({ ...config, ...JSON.parse(readFileSync(file, 'utf8')) })
    }
  } catch {
    /* malformed settings must not break the plugin */
  }
  return normalizeReducerConfig(config)
}

/** Read the operator-editable reducer settings document. */
export function readReducerSettings(file = DEFAULT_SETTINGS_FILE) {
  const parsed = readDurableJson(file, { fallback: {} })
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('reducer settings document is corrupt: ' + file)
  }
  return parsed
}

/** Merge and persist a settings patch. Returns the resulting document. */
export function writeReducerSettings(patch, file = DEFAULT_SETTINGS_FILE) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('reducer settings patch must be an object')
  }
  return updateDurableJsonSync(file, (current) => {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      throw new Error('reducer settings document is corrupt: ' + file)
    }
    Object.assign(current, patch)
    return current
  }, { fallback: {} })
}

/** Return whether one resolved route may receive the observation. */
export function routeAllowed(route, config = {}) {
  if (route === undefined || route === null) return false
  const provider = typeof route.provider === 'string' ? route.provider : ''
  if (provider.length === 0) return false
  const localProviders = new Set(Array.isArray(config.localProviders) ? config.localProviders : [])
  if (localProviders.has(provider)) return true
  return config.remoteAllowed === true
}

/** Build the v12 evidence record for a verified reducer receipt. */
export function buildReceiptEvidenceRecord(exec, receipt, archive, route) {
  return {
    id: 'reducer-' + archive.id,
    taskId: exec?.arguments?.task_id ?? exec?.arguments?.taskId ?? null,
    requirementId: exec?.arguments?.requirement_id ?? exec?.arguments?.requirementId ?? 'evidence-reducer',
    commitSha: exec?.arguments?.commit_sha ?? exec?.arguments?.commitSha ?? null,
    command: 'evidence-reducer:' + String(route?.provider ?? '') + '/' + String(route?.model ?? ''),
    status: 'passed',
    evidenceRef: archive.filePath,
    archiveId: archive.id,
    archiveSha256: archive.sha256,
    archivePath: archive.filePath,
    sourceTool: exec?.name,
    sourceSha256: archive.sha256,
    sourceBytes: archive.bytes,
    sourceLines: archive.lines,
    lineNumbers: Array.isArray(receipt?.quotes)
      ? receipt.quotes.map((quote) => Number(quote.line)).filter(Number.isInteger)
      : [],
    scannedRanges: Array.isArray(receipt?.scannedRanges) ? receipt.scannedRanges : [],
    fallbackReason: receipt?.fallbackReason ?? null,
    provider: route?.provider ?? null,
    model: route?.model ?? null,
    fixtureVersion: exec?.arguments?.fixture_version ?? exec?.arguments?.fixtureVersion ?? null,
  }
}

/** Register the reducer listener. */
export function apply(ctx, rawConfig = {}) {
  // Settings are canonical. The JSON file remains a compatibility fallback for
  // operator commands; merge it first, then apply the live settings section.
  const readSettings = () => {
    try {
      const rows = ctx.get('settings')?.describe?.()
      const section = Array.isArray(rows)
        ? rows.find((row) => row?.ns === 'evidence-reducer')?.value
        : undefined
      return section !== undefined && section !== null && typeof section === 'object' && !Array.isArray(section)
        ? section
        : undefined
    } catch {
      return undefined
    }
  }
  const readConfig = () => {
    const config = effectiveConfig(rawConfig)
    const live = readSettings()
    return live === undefined ? config : normalizeReducerConfig({ ...config, ...live })
  }
  const initial = readConfig()
  const routeCache = new Map()
  const telemetry = createTelemetry('evidence-reducer', {
    dir: initial.telemetryDir,
    enabled: initial.enabled === true,
  })

  // Settings writes the profile config and reloads the plugin. Mirror the
  // resolved volatile section into the JSON document so the operator command
  // and the settings page cannot diverge.
  try {
    const section = readSettings()
    if (section !== undefined) writeReducerSettings(section, section.settingsFile || rawConfig.settingsFile || DEFAULT_SETTINGS_FILE)
    ctx.on('settings/document-updated', (namespace) => {
      if (namespace !== 'evidence-reducer') return
      try {
        const current = readSettings()
        if (current !== undefined) writeReducerSettings(current, current.settingsFile || rawConfig.settingsFile || DEFAULT_SETTINGS_FILE)
      } catch (error) {
        // Live Settings remains authoritative; surface a mirror failure instead of
        // making the JSON compatibility file look like the accepted write.
        ctx.logger?.warn?.(`[evidence-reducer] settings mirror failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  } catch {
    /* settings is optional; the command/file path remains available */
  }

  const resolveRoute = (agent, config) => {
    if (typeof config.route === 'object' && config.route !== null) {
      return config.route
    }
    if (config.route !== 'session') return undefined
    const sessionsRoot = typeof config.sessionsRoot === 'string' && config.sessionsRoot.length > 0
      ? config.sessionsRoot
      : join(process.env.DSH_HOME ?? process.cwd(), 'sessions')
    const sessionId = agent?.session?.id ?? agent?.id
    const cached = routeCache.get(String(sessionId))
    if (cached !== undefined && Date.now() - cached.at < SESSION_ROUTE_TTL_MS) return cached.route
    const route = resolveSessionRoute(agent, sessionsRoot)
    if (route !== undefined) routeCache.set(String(sessionId), { route, at: Date.now() })
    return route
  }

  const registerReceiptEvidence = async (exec, config, receipt, archive, route) => {
    if (config.controlPlaneEnabled === false) return undefined
    try {
      const control = controlPlaneForMember(ctx, exec.agent, { directory: config.controlDir })
      if (control === undefined) return undefined
      const result = await control.mutate('v13/reducer-evidence', {
        archiveId: archive.id,
        archiveSha256: archive.sha256,
      }, exec.agent, (latest) => {
        const registry = createEvidenceRegistry(Object.values(latest.v12Evidence?.records ?? {}))
        const record = registerEvidence(registry, buildReceiptEvidenceRecord(exec, receipt, archive, route))
        latest.v12Evidence = registry
        return record
      })
      return result
    } catch {
      return undefined
    }
  }

  if (initial.enabled !== true) {
    telemetry.skipped('disabled')
    try {
      ctx.logger?.info?.('[evidence-reducer] disabled')
    } catch {
      /* logging is best effort */
    }
  }

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    const config = readConfig()
    if (config.enabled !== true || downstream.kind === 'block') return downstream
    const thresholdBytes = Number.isFinite(config.thresholdBytes) ? config.thresholdBytes : 20480
    const maxReceiptTokens = Number.isFinite(config.maxReceiptTokens) ? config.maxReceiptTokens : 1500
    const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 60000
    const maxQuotes = Number.isFinite(config.maxQuotes) ? config.maxQuotes : 20
    const maxInputBytes = Number.isFinite(config.maxInputBytes) ? config.maxInputBytes : 262144
    const maxInputLines = Number.isFinite(config.maxInputLines) ? config.maxInputLines : 4000
    const archiveDir = typeof config.archiveDir === 'string' && config.archiveDir.length > 0
      ? config.archiveDir
      : join(process.env.DSH_HOME ?? process.cwd(), 'evidence-archive')
    const allowed = Array.isArray(config.tools) && config.tools.length > 0 ? new Set(config.tools) : undefined
    const wanted = (label) => allowed === undefined || allowed.has(label)
    const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id
    if (!exec || !wanted(exec.name)) return downstream
    if (!result || result.isError === true) return downstream
    const text = textOf(result.content)
    if (text.split('\n').some((line) => line === RECEIPT_MARKER)) {
      telemetry.skipped('already-reduced', { sessionId })
      return downstream
    }
    if (hasObservationSource(text)) {
      const source = parseObservationSource(text)
      if (source?.processor === 'observation-pack') {
        telemetry.skipped('already-packed', { sessionId, archiveId: source.archiveId ?? null })
        return downstream
      }
    }
    if (Buffer.byteLength(text, 'utf8') <= thresholdBytes) {
      telemetry.skipped('below-threshold', { sessionId })
      return downstream
    }

    const archive = archiveText(text, archiveDir)
    if (archive === undefined) {
      telemetry.skipped('archive-failed', { sessionId })
      return downstream
    }
    const route = resolveRoute(exec.agent, config)
    if (!routeAllowed(route, config)) {
      telemetry.skipped('route-not-allowed', { sessionId, provider: route?.provider ?? null })
      return downstream
    }

    const bounded = buildBoundedInput(text, { maxInputBytes, maxInputLines })
    let raw
    try {
      raw = await callReducer(ctx.llm, route, buildReducerPrompt(bounded.text, archive, { maxQuotes }), {
        maxReceiptTokens,
        timeoutMs,
        signal: exec.signal,
      })
    } catch {
      telemetry.skipped('reducer-failed', { sessionId })
      return downstream
    }
    const receipt = parseReceipt(raw.text)
    const verification = verifyReceipt(receipt, text, { maxReceiptTokens })
    if (!verification.ok) {
      telemetry.skipped('receipt-unverified', { sessionId, reasons: verification.reasons.slice(0, 5) })
      return downstream
    }
    receipt.scannedRanges = bounded.scannedRanges
    receipt.fallbackReason = bounded.fallbackReason
    await registerReceiptEvidence(exec, config, receipt, archive, route)
    telemetry.event('reduced', { archiveId: archive.id, bytes: archive.bytes, sessionId }, {
      inputTokens: raw.usage?.inputTokens,
      outputTokens: raw.usage?.outputTokens,
      cacheReadTokens: raw.usage?.cacheReadTokens,
      cacheWriteTokens: raw.usage?.cacheWriteTokens,
      savedTokens: Math.max(0, Math.ceil(archive.bytes / 4) - Math.ceil(JSON.stringify(receipt).length / 4)),
      toolMs: raw.ms,
      waitMs: raw.ms,
      modelTurns: 1,
      qualityPassed: 1,
    })
    return { ...downstream, content: [{ type: 'text', text: renderReceipt(receipt, archive, bounded) }] }
  })
}
