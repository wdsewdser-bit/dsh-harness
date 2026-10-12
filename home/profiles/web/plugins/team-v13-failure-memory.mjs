/** Session-scoped failure memory with bounded deterministic blocking. */

import { createHash } from 'node:crypto'
import { createTelemetry } from './team-v13-mechanism-telemetry.mjs'
import { readDurableJson, updateDurableJsonSync } from './team-v14-durable-store.mjs'
import { resolveIdentity, readProperty } from './team-v14-identity.mjs'

export const FAILURE_MEMORY_VERSION = 2
export const DEFAULT_MEMORY_FILE = 'D:\\dsh-test\\home\\team-control-plane\\v13-failure-memory.json'
export const FAILURE_CLASSES = Object.freeze(['deterministic', 'transient', 'permission', 'stale-state', 'provider'])
export const DEFAULT_FAILURE_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_WINDOW_MS = 10 * 60 * 1000
const DEFAULT_WINDOW_MAX = 32

function stableJson(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}'
}
function digest(value) { return createHash('sha256').update(stableJson(value)).digest('hex') }
function emptyState() { return { version: FAILURE_MEMORY_VERSION, actions: {}, audit: [] } }
function normalizeState(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('failure memory is corrupt')
  if (value.actions !== undefined && (value.actions === null || typeof value.actions !== 'object' || Array.isArray(value.actions))) throw new Error('failure memory actions are corrupt')
  if (value.audit !== undefined && !Array.isArray(value.audit)) throw new Error('failure memory audit is corrupt')
  return { ...value, version: FAILURE_MEMORY_VERSION, actions: value.actions ?? {}, audit: value.audit ?? [] }
}
export function readFailureMemory(file = DEFAULT_MEMORY_FILE) {
  try { return normalizeState(readDurableJson(file, { fallback: emptyState() })) }
  catch (error) { throw new Error('failure memory unavailable; refusing to clear or bypass stored failures: ' + String(error?.message ?? error)) }
}
export function writeFailureMemory(state, file = DEFAULT_MEMORY_FILE) {
  const normalized = normalizeState(state)
  return updateDurableJsonSync(file, (current) => {
    const next = normalizeState(current)
    Object.assign(next, normalized)
    Object.assign(current, next)
    return current
  }, { fallback: emptyState() })
}

function identityFor(exec, options = {}) {
  const supplied = options.identity ?? options.context ?? options
  const identity = resolveIdentity(exec, supplied, options.config ?? {})
  return {
    sessionId: identity.sessionId,
    teamId: identity.teamId,
    workspaceId: identity.workspaceId,
    profile: identity.profile,
    commit: String(exec?.commit ?? exec?.commitHash ?? exec?.treeHash
      ?? readProperty(supplied, 'commit') ?? readProperty(supplied, 'commitHash')
      ?? readProperty(supplied, 'treeHash') ?? 'shared'),
  }
}
export function actionFingerprint(exec, options = {}) {
  return digest({
    identity: identityFor(exec, options),
    tool: String(exec?.name ?? exec?.tool?.name ?? ''),
    arguments: exec?.arguments ?? exec?.args ?? {},
  })
}
function resultText(result) {
  if (typeof result?.text === 'string') return result.text
  if (!Array.isArray(result?.content)) return String(result?.message ?? result?.error?.message ?? '')
  return result.content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n')
}
function isInboxAckAccountingAction(exec) {
  const tool = String(exec?.name ?? exec?.tool?.name ?? '').toLowerCase()
  const args = exec?.arguments ?? exec?.args ?? {}
  return tool === 'team_v12' && String(args?.action ?? '').toLowerCase() === 'inbox_ack'
}
export function classifyFailure(result, exec) {
  const text = resultText(result).toLowerCase()
  const code = String(result?.code ?? result?.error?.code ?? result?.status ?? '').toLowerCase()
  if (isInboxAckAccountingAction(exec)) {
    if (/timeout|timed out|econnreset|econnrefused|enotfound|temporar|rate.?limit|429|5\d\d|provider|overloaded|unavailable/.test(text + ' ' + code)) {
      return /provider|429|5\d\d|overloaded/.test(text + ' ' + code) ? 'provider' : 'transient'
    }
    return 'stale-state'
  }
  if (/permission|forbidden|eacces|eperm|not authorized|access denied/.test(text + ' ' + code)) return 'permission'
  if (/stale|revision conflict|etag|version conflict|already changed|not found.*(state|revision)/.test(text + ' ' + code)) return 'stale-state'
  if (/timeout|timed out|econnreset|econnrefused|enotfound|temporar|rate.?limit|429|5\d\d|provider|overloaded|unavailable/.test(text + ' ' + code)) return /provider|429|5\d\d|overloaded/.test(text + ' ' + code) ? 'provider' : 'transient'
  return 'deterministic'
}
export function failureFingerprint(exec, result, options = {}) {
  return digest({
    action: actionFingerprint(exec, options),
    classification: classifyFailure(result, exec),
    code: result?.code ?? result?.exitCode ?? result?.error?.code ?? null,
    error: resultText(result).replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 800),
  })
}
function activeFailures(entry, now, ttlMs, windowMs) {
  const failures = Array.isArray(entry?.failures) ? entry.failures : []
  return failures.filter((row) => now - Number(row.at) <= ttlMs && now - Number(row.at) <= windowMs)
}
export function recordFailure(exec, result, options = {}) {
  const file = options.file ?? DEFAULT_MEMORY_FILE
  const now = Number(options.now ?? Date.now())
  const action = actionFingerprint(exec, options)
  const classification = classifyFailure(result, exec)
  const failure = failureFingerprint(exec, result, options)
  let resultEntry
  let matchingCount = 0
  updateDurableJsonSync(file, (raw) => {
    const state = normalizeState(raw)
    const prior = state.actions[action] ?? { failures: [], firstSeenAt: now }
    const failures = activeFailures(prior, now, options.ttlMs ?? DEFAULT_FAILURE_TTL_MS, options.windowMs ?? DEFAULT_WINDOW_MS)
    const row = { fingerprint: failure, classification, at: now, code: result?.code ?? result?.exitCode ?? result?.error?.code ?? null, error: resultText(result).slice(0, 800) }
    if (classification === 'deterministic') failures.push(row)
    const bounded = failures.slice(-(Number.isFinite(options.windowMax) ? Math.max(1, options.windowMax) : DEFAULT_WINDOW_MAX))
    matchingCount = bounded.filter((item) => item.fingerprint === failure).length
    resultEntry = { ...prior, classification, count: bounded.length, failures: bounded, firstSeenAt: Number(prior.firstSeenAt ?? now), lastSeenAt: now, lastError: row.error, lastFailure: failure }
    state.actions[action] = resultEntry
    Object.assign(raw, state)
    return raw
  }, { fallback: emptyState() })
  return { ...resultEntry, failure: { count: matchingCount, classification }, failureFingerprint: failure }
}
function summarizeFailures(entry, options = {}) {
  const now = Number(options.now ?? Date.now())
  const failures = entry
    ? activeFailures(entry, now, options.ttlMs ?? DEFAULT_FAILURE_TTL_MS, options.windowMs ?? DEFAULT_WINDOW_MS)
    : []
  const threshold = Number.isFinite(options.threshold) ? Math.max(1, options.threshold) : 3
  const counts = new Map()
  let count = 0
  let failureFingerprint = null
  for (const row of failures) {
    if (row.classification !== 'deterministic') continue
    const next = (counts.get(row.fingerprint) ?? 0) + 1
    counts.set(row.fingerprint, next)
    if (next > count) {
      count = next
      failureFingerprint = row.fingerprint
    }
  }
  return {
    blocked: count >= threshold,
    threshold,
    count,
    failureFingerprint,
    activeCount: failures.length,
  }
}

export function actionFailureSummary(action, options = {}) {
  const fingerprint = String(action ?? '').trim()
  const state = readFailureMemory(options.file ?? DEFAULT_MEMORY_FILE)
  const entry = state.actions[fingerprint]
  const summary = summarizeFailures(entry, options)
  return {
    actionFingerprint: fingerprint,
    blocked: summary.blocked,
    threshold: summary.threshold,
    count: summary.count,
    activeCount: summary.activeCount,
    failureFingerprint: summary.failureFingerprint,
    classification: entry?.classification ?? null,
    lastError: entry?.lastError ?? null,
    lastSeenAt: entry?.lastSeenAt ?? null,
  }
}
export function shouldBlockAction(exec, options = {}) {
  return actionFailureSummary(actionFingerprint(exec, options), options).blocked
}

export function clearActionByFingerprint(action, options = {}) {
  const reason = String(options.reason ?? '').trim()
  const evidence = String(options.evidence ?? '').trim()
  if (!reason || !evidence) throw new Error('failure-memory clear requires reason and evidence')
  const fingerprint = String(action ?? '').trim()
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('failure-memory clear requires a valid action fingerprint')
  const file = options.file ?? DEFAULT_MEMORY_FILE
  const identity = identityFor(options.identitySource ?? {}, options)
  // Successful tool calls are the common path. Do not take the durable lock,
  // rewrite and fsync the whole memory document when there is nothing to
  // clear; this used to happen for every successful tool call.
  if (readFailureMemory(file).actions[fingerprint] === undefined) return false
  let cleared = false
  updateDurableJsonSync(file, (raw) => {
    const state = normalizeState(raw)
    const previous = state.actions[fingerprint]
    if (previous) {
      delete state.actions[fingerprint]
      state.audit.push({ event: 'unblock', action: fingerprint, priorFailure: previous.lastFailure ?? null, identity, reason, evidence, operator: String(options.operator ?? identity.agentName ?? 'unknown'), at: Number(options.now ?? Date.now()) })
      state.audit = state.audit.slice(-500)
      cleared = true
    }
    Object.assign(raw, state)
    return raw
  }, { fallback: emptyState() })
  return cleared
}
export function clearAction(exec, options = {}) {
  return clearActionByFingerprint(actionFingerprint(exec, options), { ...options, identitySource: exec })
}
export const unblockAction = clearAction

export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  const file = typeof config.memoryFile === 'string' && config.memoryFile.length ? config.memoryFile : DEFAULT_MEMORY_FILE
  const threshold = Number.isFinite(config.threshold) ? Math.max(1, config.threshold) : 3
  const telemetry = createTelemetry('failure-memory', { dir: config.telemetryDir, enabled: true })
  const options = { file, config, identity: config.identity ?? ctx, ttlMs: config.ttlMs, windowMs: config.windowMs, windowMax: config.windowMax }
  ctx.on('tools/pre-execute', async (exec, next) => {
    const action = actionFingerprint(exec, options)
    const summary = actionFailureSummary(action, { ...options, threshold })
    if (summary.blocked) {
      telemetry.event('repeated-failure-block', { action, sessionId: identityFor(exec, options).sessionId })
      throw new Error('failure-memory denied: deterministic failure threshold reached in this session/workspace; '
        + 'count=' + summary.count + '/' + summary.threshold + '; actionFingerprint=' + action + '; '
        + 'clear with team_v12(action:"failure_memory_clear", input:{action_fingerprint:"' + action
        + '",reason:"<why retry is safe>",evidence:"<new validation evidence>"}).')
    }
    return typeof next === 'function' ? next() : { kind: 'allow' }
  })
  ctx.on('tools/post-execute', async (exec, result, next) => {
    let downstream
    let downstreamError
    try { downstream = await next() } catch (error) { downstreamError = error }
    const blocked = downstream?.kind === 'block'
    if (result?.isError === true || result?.kind === 'error' || blocked) {
      const failureResult = blocked && result?.isError !== true
        ? { isError: true, content: [{ type: 'text', text: String(downstream.feedback ?? 'post-execute blocked') }] }
        : result
      const entry = recordFailure(exec, failureResult, options)
      telemetry.event('failure-recorded', { action: actionFingerprint(exec, options), failure: entry.failureFingerprint, classification: entry.classification, count: entry.failure.count, sessionId: identityFor(exec, options).sessionId })
      if (entry.classification === 'deterministic' && Number(entry.failure.count) >= threshold) telemetry.event('replan-required', { action: actionFingerprint(exec, options), failure: entry.failureFingerprint, count: entry.failure.count, sessionId: identityFor(exec, options).sessionId })
    } else if (!downstreamError && result?.isError === false) clearAction(exec, { ...options, reason: 'successful identical action', evidence: 'post-execute reported isError=false', operator: identityFor(exec, options).agentName })
    if (downstreamError) throw downstreamError
    return downstream
  })
}
