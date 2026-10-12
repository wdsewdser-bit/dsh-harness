import { createHash } from 'node:crypto'
import { readDurableJson, updateDurableJsonSync } from './team-v14-durable-store.mjs'

export const HYPOTHESIS_MEMORY_VERSION = 1
export const DEFAULT_HYPOTHESIS_MEMORY_LIMITS = Object.freeze({
  maxKeys: 256,
  maxAttempts: 5,
  maxNoProgressAttempts: 3,
  maxDurationMs: 15 * 60 * 1000,
  auditLimit: 1024,
  smallerProbeMaxSteps: 3,
  smallerProbeMaxDurationMs: 60 * 1000,
  lockTimeoutMs: 10 * 1000,
})

const MAX_HARD_KEYS = 8192
const MAX_HARD_ATTEMPTS = 32
const MAX_HARD_AUDIT = 10000
const MAX_IDENTITY_TEXT = 256
const MAX_HYPOTHESIS_TEXT = 1200
const MAX_PROBE_TEXT = 240
const MAX_EVIDENCE_REF = 1024
const MAX_SOURCE_IDENTITY_BYTES = 4096

function fail(code, message = code) {
  throw Object.assign(new Error(message), { code })
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function stableJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) {
    if (seen.has(value)) fail('HYPOTHESIS_MEMORY_INVALID_VALUE')
    seen.add(value)
    const result = '[' + value.map(item => stableJson(item, seen)).join(',') + ']'
    seen.delete(value)
    return result
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) fail('HYPOTHESIS_MEMORY_INVALID_VALUE')
    seen.add(value)
    const result = '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key], seen)).join(',') + '}'
    seen.delete(value)
    return result
  }
  fail('HYPOTHESIS_MEMORY_INVALID_VALUE')
}

function hash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex')
}

function requiredText(value, field, max = MAX_IDENTITY_TEXT) {
  if (typeof value !== 'string') fail('HYPOTHESIS_MEMORY_INPUT_INVALID', field + ' must be a non-empty string')
  const text = value.normalize('NFKC').trim()
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    fail('HYPOTHESIS_MEMORY_INPUT_INVALID', field + ' must be a non-empty bounded string')
  }
  if (['unknown', 'undefined', 'null', 'n/a', 'na'].includes(text.toLowerCase())) {
    fail('HYPOTHESIS_MEMORY_INPUT_INVALID', field + ' cannot be an unknown sentinel')
  }
  return text
}

function normalizeScope(value) {
  if (!isPlainObject(value)) fail('HYPOTHESIS_MEMORY_INPUT_INVALID', 'identity is required')
  const contractRevision = value.contractRevision
  if (!Number.isSafeInteger(contractRevision) || contractRevision < 0) {
    fail('HYPOTHESIS_MEMORY_INPUT_INVALID', 'contractRevision must be a non-negative safe integer')
  }
  return Object.freeze({
    sessionId: requiredText(value.sessionId, 'sessionId'),
    rootTeamId: requiredText(value.rootTeamId, 'rootTeamId'),
    taskId: requiredText(value.taskId, 'taskId'),
    contractRevision,
  })
}

function normalizeKeyInput(input) {
  if (!isPlainObject(input)) fail('HYPOTHESIS_MEMORY_INPUT_INVALID', 'attempt input is required')
  const identity = normalizeScope(input.identity)
  const hypothesisId = requiredText(input.hypothesisId, 'hypothesisId')
  const rawCause = requiredText(input.failureCause, 'failureCause', 180)
  const failureCause = rawCause.toLowerCase().replace(/\s+/g, ' ')
  const dimensions = { ...identity, hypothesisId, failureCause }
  return { identity, hypothesisId, failureCause, key: hash(dimensions) }
}

function normalizeProbe(value, limits) {
  if (!isPlainObject(value)) fail('HYPOTHESIS_MEMORY_INPUT_INVALID', 'probe details are required')
  const kind = value.kind ?? 'standard'
  if (!['standard', 'smallerProbe'].includes(kind)) fail('HYPOTHESIS_MEMORY_INPUT_INVALID', 'unknown probe kind')
  const probe = { kind, method: requiredText(value.method, 'probe.method', MAX_PROBE_TEXT) }
  if (kind === 'smallerProbe') {
    if (!Number.isSafeInteger(value.maxSteps) || value.maxSteps < 1 || value.maxSteps > limits.smallerProbeMaxSteps
      || !Number.isSafeInteger(value.maxDurationMs) || value.maxDurationMs < 1 || value.maxDurationMs > limits.smallerProbeMaxDurationMs) {
      fail('HYPOTHESIS_MEMORY_SMALLER_PROBE_UNBOUNDED')
    }
    probe.maxSteps = value.maxSteps
    probe.maxDurationMs = value.maxDurationMs
  }
  return Object.freeze(probe)
}

function normalizeObservation(value, expectedIdentity, at) {
  if (!isPlainObject(value)) fail('HYPOTHESIS_MEMORY_INPUT_INVALID', 'serverObservation is required')
  const identity = normalizeScope(value.identity)
  if (stableJson(identity) !== stableJson(expectedIdentity)) fail('HYPOTHESIS_MEMORY_OBSERVATION_SCOPE_MISMATCH')
  if (!['passed', 'failed', 'blocked', 'unknown'].includes(value.status)) {
    fail('HYPOTHESIS_MEMORY_INPUT_INVALID', 'serverObservation.status is invalid')
  }
  const observation = { identity, status: value.status, observedAt: at }
  if (value.errorCode !== undefined && value.errorCode !== null && value.errorCode !== '') {
    if (typeof value.errorCode !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(value.errorCode)) {
      fail('HYPOTHESIS_MEMORY_INPUT_INVALID', 'serverObservation.errorCode must be a stable code')
    }
    observation.errorCode = value.errorCode.toUpperCase()
  }
  if (value.errorFingerprint !== undefined && value.errorFingerprint !== null) {
    if (typeof value.errorFingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(value.errorFingerprint)) {
      fail('HYPOTHESIS_MEMORY_INPUT_INVALID', 'serverObservation.errorFingerprint must be SHA-256')
    }
    observation.errorFingerprint = value.errorFingerprint.toLowerCase()
  }
  if (value.progress !== undefined && typeof value.progress !== 'boolean') {
    fail('HYPOTHESIS_MEMORY_INPUT_INVALID', 'serverObservation.progress must be boolean')
  }
  if (value.progress === true) observation.progress = true
  if (value.detailHash !== undefined && value.detailHash !== null) {
    if (typeof value.detailHash !== 'string' || !/^[a-f0-9]{64}$/i.test(value.detailHash)) {
      fail('HYPOTHESIS_MEMORY_INPUT_INVALID', 'serverObservation.detailHash must be SHA-256')
    }
    observation.detailHash = value.detailHash.toLowerCase()
  }
  if (value.observedAt !== undefined) {
    if (!Number.isSafeInteger(value.observedAt) || value.observedAt < 0) fail('HYPOTHESIS_MEMORY_INPUT_INVALID', 'serverObservation.observedAt is invalid')
    observation.observedAt = value.observedAt
  }
  if (Buffer.byteLength(stableJson(observation), 'utf8') > 2048) fail('HYPOTHESIS_MEMORY_INPUT_LIMIT')
  return Object.freeze(observation)
}

function emptyState() {
  return { version: HYPOTHESIS_MEMORY_VERSION, entries: {}, audit: [] }
}

function isSafeTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function normalizeStoredAttempt(value) {
  if (!isPlainObject(value) || typeof value.attemptId !== 'string' || !value.attemptId
    || !/^[a-f0-9]{64}$/.test(value.requestHash ?? '') || !isSafeTimestamp(value.at)
    || !Number.isSafeInteger(value.attemptNo) || value.attemptNo < 1
    || !Number.isSafeInteger(value.noProgressStreak) || value.noProgressStreak < 0
    || !['continue', 'replan/upgrade-required'].includes(value.decision)) {
    fail('HYPOTHESIS_MEMORY_CORRUPT', 'stored attempt is malformed')
  }
  return value
}

function normalizeState(value) {
  if (!isPlainObject(value)) fail('HYPOTHESIS_MEMORY_CORRUPT', 'hypothesis memory must be an object')
  if (value.version !== HYPOTHESIS_MEMORY_VERSION) fail('HYPOTHESIS_MEMORY_UNSUPPORTED_VERSION', 'unsupported hypothesis memory version')
  for (const key of Object.keys(value)) if (!['version', 'revision', 'entries', 'audit'].includes(key)) fail('HYPOTHESIS_MEMORY_CORRUPT', 'unknown hypothesis memory field')
  if (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || value.revision < 0)) fail('HYPOTHESIS_MEMORY_CORRUPT', 'invalid durable revision')
  if (!isPlainObject(value.entries) || Object.keys(value.entries).length > MAX_HARD_KEYS) fail('HYPOTHESIS_MEMORY_CORRUPT', 'invalid hypothesis entries')
  if (!Array.isArray(value.audit) || value.audit.length > MAX_HARD_AUDIT) fail('HYPOTHESIS_MEMORY_CORRUPT', 'invalid hypothesis audit')
  const entries = Object.create(null)
  const attemptIds = new Set()
  for (const [key, entry] of Object.entries(value.entries)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !isPlainObject(entry)) fail('HYPOTHESIS_MEMORY_CORRUPT', 'invalid hypothesis entry key')
    let normalizedKey
    try { normalizedKey = normalizeKeyInput({ identity: entry.identity, hypothesisId: entry.hypothesisId, failureCause: entry.failureCause }) } catch {
      fail('HYPOTHESIS_MEMORY_CORRUPT', 'hypothesis entry identity is malformed')
    }
    if (normalizedKey.key !== key || !Array.isArray(entry.attempts) || entry.attempts.length > MAX_HARD_ATTEMPTS
      || !Array.isArray(entry.errorCodes) || entry.errorCodes.length > MAX_HARD_ATTEMPTS
      || !Array.isArray(entry.evidenceRefs) || entry.evidenceRefs.length > MAX_HARD_ATTEMPTS
      || !isSafeTimestamp(entry.firstAttemptAt) || !isSafeTimestamp(entry.lastAttemptAt)
      || !Number.isSafeInteger(entry.noProgressStreak) || entry.noProgressStreak < 0
      || typeof entry.smallerProbeUsed !== 'boolean') {
      fail('HYPOTHESIS_MEMORY_CORRUPT', 'hypothesis entry is malformed')
    }
    for (let index = 0; index < entry.attempts.length; index += 1) {
      const row = normalizeStoredAttempt(entry.attempts[index])
      if (row.key !== key || row.attemptNo !== index + 1 || attemptIds.has(row.attemptId)) {
        fail('HYPOTHESIS_MEMORY_CORRUPT', 'attempt identity or ordering is inconsistent')
      }
      attemptIds.add(row.attemptId)
    }
    for (const evidence of entry.evidenceRefs) {
      if (!isPlainObject(evidence) || typeof evidence.ref !== 'string' || !evidence.ref
        || !/^[a-f0-9]{64}$/.test(evidence.hash ?? '') || !/^[a-f0-9]{64}$/.test(evidence.sourceIdentityHash ?? '')) {
        fail('HYPOTHESIS_MEMORY_CORRUPT', 'stored evidence identity is malformed')
      }
    }
    entries[key] = entry
  }
  for (const row of value.audit) {
    if (!isPlainObject(row) || !['attempt-recorded', 'attempt-budget-denied'].includes(row.event)
      || typeof row.key !== 'string' || !Object.hasOwn(entries, row.key) || !isSafeTimestamp(row.at)) {
      fail('HYPOTHESIS_MEMORY_CORRUPT', 'hypothesis audit row is malformed')
    }
  }
  return { version: HYPOTHESIS_MEMORY_VERSION, ...(value.revision === undefined ? {} : { revision: value.revision }), entries, audit: value.audit }
}

function durableRead(file) {
  try {
    return normalizeState(readDurableJson(file, { fallback: emptyState() }))
  } catch (error) {
    if (String(error?.code ?? '').startsWith('HYPOTHESIS_MEMORY_')) throw error
    fail('HYPOTHESIS_MEMORY_UNAVAILABLE', 'hypothesis memory unavailable: ' + String(error?.message ?? error))
  }
}

function findAttempt(state, attemptId) {
  for (const [key, entry] of Object.entries(state.entries)) {
    const row = entry.attempts.find(candidate => candidate.attemptId === attemptId)
    if (row) return { key, row }
  }
  return undefined
}

function checkDuplicate(found, key, requestHash) {
  if (!found) return undefined
  if (found.key !== key || found.row.requestHash !== requestHash) fail('HYPOTHESIS_MEMORY_ATTEMPT_ID_CONFLICT')
  return { ...structuredClone(found.row), idempotent: true }
}

function limitsFor(options) {
  const limits = {}
  for (const key of Object.keys(DEFAULT_HYPOTHESIS_MEMORY_LIMITS)) {
    const value = options[key] ?? DEFAULT_HYPOTHESIS_MEMORY_LIMITS[key]
    if (!Number.isSafeInteger(value) || value < 1) fail('HYPOTHESIS_MEMORY_CONFIG_INVALID', key + ' must be a positive safe integer')
    limits[key] = value
  }
  if (limits.maxKeys > MAX_HARD_KEYS || limits.maxAttempts > MAX_HARD_ATTEMPTS
    || limits.maxNoProgressAttempts > limits.maxAttempts || limits.auditLimit > MAX_HARD_AUDIT
    || limits.smallerProbeMaxSteps > 100 || limits.smallerProbeMaxDurationMs > 10 * 60 * 1000) {
    fail('HYPOTHESIS_MEMORY_CONFIG_INVALID', 'hypothesis memory limits exceed hard bounds')
  }
  return Object.freeze(limits)
}

function validateEvidence(value, requestedRef, identity) {
  if (!isPlainObject(value)) return { status: 'unavailable' }
  if (value.ref !== requestedRef) return { status: 'rejected:ref-mismatch' }
  if (typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/i.test(value.hash)) return { status: 'rejected:invalid-hash' }
  if (value.status !== 'passed') return { status: 'rejected:not-passed' }
  if (!isPlainObject(value.sourceIdentity)) return { status: 'rejected:missing-source-identity' }
  let sourceBytes
  try { sourceBytes = Buffer.byteLength(stableJson(value.sourceIdentity), 'utf8') } catch { return { status: 'rejected:invalid-source-identity' } }
  if (sourceBytes > MAX_SOURCE_IDENTITY_BYTES) return { status: 'rejected:source-identity-too-large' }
  let evidenceIdentity
  try { evidenceIdentity = normalizeScope(value.sourceIdentity) } catch { return { status: 'rejected:invalid-source-identity' } }
  if (stableJson(evidenceIdentity) !== stableJson(identity)) return { status: 'rejected:identity-mismatch' }
  return {
    status: 'verified',
    evidence: {
      ref: requestedRef,
      hash: value.hash.toLowerCase(),
      status: 'passed',
      sourceIdentity: structuredClone(value.sourceIdentity),
    },
  }
}

function validateScopeFilter(value) {
  if (value === undefined || value === null) return undefined
  if (!isPlainObject(value)) fail('HYPOTHESIS_MEMORY_INPUT_INVALID', 'snapshot scope must be an identity object')
  return normalizeScope(value.identity ?? value)
}

function hardBudgetReason(entry, at, limits) {
  if (entry.attempts.length >= limits.maxAttempts) return 'attempt-budget'
  if (at - entry.firstAttemptAt >= limits.maxDurationMs) return 'time-budget'
  return null
}

function replanResult(key, entry, reason) {
  return {
    key,
    decision: 'replan/upgrade-required',
    reason,
    attemptCount: entry?.attempts.length ?? 0,
    noProgressStreak: entry?.noProgressStreak ?? 0,
  }
}

function decisionFor(key, entry, at, probe, limits, keyCapacityAvailable = true) {
  if (!entry) return keyCapacityAvailable
    ? { key, decision: 'continue', reason: 'new-hypothesis', attemptCount: 0, noProgressStreak: 0 }
    : replanResult(key, undefined, 'key-budget')
  const hardReason = hardBudgetReason(entry, at, limits)
  if (hardReason) return replanResult(key, entry, hardReason)
  if (entry.noProgressStreak >= limits.maxNoProgressAttempts) {
    if (probe?.kind === 'smallerProbe' && entry.smallerProbeUsed !== true) {
      return { key, decision: 'continue', reason: 'bounded-smaller-probe-available', attemptCount: entry.attempts.length, noProgressStreak: entry.noProgressStreak }
    }
    return replanResult(key, entry, 'no-progress-limit')
  }
  return { key, decision: 'continue', reason: 'within-budget', attemptCount: entry.attempts.length, noProgressStreak: entry.noProgressStreak }
}

/**
 * Durable task-scoped working hypotheses. Identity intentionally excludes tool names,
 * argument payloads, wrapper paths and probe descriptions; those belong to attempt rows.
 * readEvidence must be a server reader returning {ref, hash, status, sourceIdentity}.
 */
export function createHypothesisMemory({
  file,
  readEvidence,
  now = Date.now,
  maxKeys,
  maxAttempts,
  maxNoProgressAttempts,
  maxDurationMs,
  auditLimit,
  smallerProbeMaxSteps,
  smallerProbeMaxDurationMs,
  lockTimeoutMs,
} = {}) {
  if (typeof file !== 'string' || !file.trim()) fail('HYPOTHESIS_MEMORY_CONFIG_INVALID', 'file is required')
  if (typeof readEvidence !== 'function') fail('HYPOTHESIS_MEMORY_CONFIG_INVALID', 'readEvidence must be the server evidence reader')
  if (typeof now !== 'function' && !Number.isSafeInteger(now)) fail('HYPOTHESIS_MEMORY_CONFIG_INVALID', 'now must be a clock function or timestamp')
  const limits = limitsFor({ maxKeys, maxAttempts, maxNoProgressAttempts, maxDurationMs, auditLimit, smallerProbeMaxSteps, smallerProbeMaxDurationMs, lockTimeoutMs })
  const clock = () => {
    const at = typeof now === 'function' ? now() : now
    if (!isSafeTimestamp(at)) fail('HYPOTHESIS_MEMORY_CLOCK_INVALID')
    return at
  }

  function checkAttempt(input) {
    const target = normalizeKeyInput(input)
    const probe = input.probe === undefined ? undefined : normalizeProbe(input.probe, limits)
    const at = clock()
    const state = durableRead(file)
    const entry = state.entries[target.key]
    return Object.freeze(decisionFor(target.key, entry, at, probe, limits, Object.keys(state.entries).length < limits.maxKeys))
  }

  async function recordAttempt(input) {
    const target = normalizeKeyInput(input)
    const attemptId = requiredText(input.attemptId, 'attemptId', 160)
    const hypothesisText = requiredText(input.hypothesis, 'hypothesis', MAX_HYPOTHESIS_TEXT)
    const probe = normalizeProbe(input.probe, limits)
    const at = clock()
    const observation = normalizeObservation(input.serverObservation, target.identity, at)
    if (input.newEvidenceRef !== undefined && input.newEvidenceRef !== null && typeof input.newEvidenceRef !== 'string') {
      fail('HYPOTHESIS_MEMORY_INPUT_INVALID', 'newEvidenceRef must be a string')
    }
    const requestedRef = input.newEvidenceRef === undefined || input.newEvidenceRef === null || input.newEvidenceRef.trim() === ''
      ? null : requiredText(input.newEvidenceRef, 'newEvidenceRef', MAX_EVIDENCE_REF)
    const requestHash = hash({ key: target.key, attemptId, hypothesisText, probe, observation: {
      identity: observation.identity, status: observation.status, errorCode: observation.errorCode ?? null,
      errorFingerprint: observation.errorFingerprint ?? null, progress: observation.progress === true,
      detailHash: observation.detailHash ?? null,
    }, newEvidenceRef: requestedRef })

    const existing = checkDuplicate(findAttempt(durableRead(file), attemptId), target.key, requestHash)
    if (existing) return existing

    let evidenceResult = { status: 'none' }
    if (requestedRef !== null) {
      try {
        evidenceResult = validateEvidence(await readEvidence(requestedRef, target.identity), requestedRef, target.identity)
      } catch (error) {
        evidenceResult = { status: 'unavailable', errorCode: /^[A-Za-z0-9_.:-]{1,120}$/.test(String(error?.code ?? '')) ? String(error.code) : 'READ_FAILED' }
      }
    }

    let result
    try {
      updateDurableJsonSync(file, raw => {
        const state = normalizeState(raw)
        const duplicate = checkDuplicate(findAttempt(state, attemptId), target.key, requestHash)
        if (duplicate) { result = duplicate; return raw }
        let entry = state.entries[target.key]
        if (!entry && Object.keys(state.entries).length >= limits.maxKeys) fail('HYPOTHESIS_MEMORY_KEY_LIMIT')
        const attemptAt = Math.max(at, entry?.lastAttemptAt ?? at)
        const hardReason = entry ? hardBudgetReason(entry, attemptAt, limits) : null
        if (hardReason) fail('HYPOTHESIS_MEMORY_' + hardReason.replace('-', '_').toUpperCase())

        let evidenceStatus = evidenceResult.status
        let verifiedEvidence = evidenceResult.evidence
        let isNewEvidence = false
        if (verifiedEvidence) {
          const sourceIdentityHash = hash(verifiedEvidence.sourceIdentity)
          const previous = entry?.evidenceRefs.find(row => row.ref === verifiedEvidence.ref
            || (row.hash === verifiedEvidence.hash && row.sourceIdentityHash === sourceIdentityHash))
          if (previous) {
            evidenceStatus = previous.ref === verifiedEvidence.ref ? 'verified-repeat' : 'verified-unchanged'
            verifiedEvidence = undefined
          } else {
            isNewEvidence = true
            verifiedEvidence.sourceIdentityHash = sourceIdentityHash
          }
        }
        const errorCode = observation.status === 'failed' || observation.status === 'blocked' ? observation.errorCode : undefined
        const isNewError = typeof errorCode === 'string' && !entry?.errorCodes.includes(errorCode)
        const explicitProgress = observation.progress === true
        const smallerProbeGranted = Boolean(entry && entry.noProgressStreak >= limits.maxNoProgressAttempts
          && probe.kind === 'smallerProbe' && entry.smallerProbeUsed !== true)
        const newInformation = isNewEvidence || isNewError || explicitProgress

        if (!entry) {
          entry = {
            identity: target.identity,
            hypothesisId: target.hypothesisId,
            failureCause: target.failureCause,
            firstAttemptAt: attemptAt,
            lastAttemptAt: attemptAt,
            noProgressStreak: 0,
            smallerProbeUsed: false,
            errorCodes: [],
            evidenceRefs: [],
            attempts: [],
          }
          state.entries[target.key] = entry
        }
        if (isNewError) entry.errorCodes.push(errorCode)
        if (isNewEvidence) entry.evidenceRefs.push({ ref: verifiedEvidence.ref, hash: verifiedEvidence.hash, sourceIdentityHash: verifiedEvidence.sourceIdentityHash })
        if (smallerProbeGranted) entry.smallerProbeUsed = true
        entry.noProgressStreak = newInformation ? 0 : entry.noProgressStreak + 1
        entry.lastAttemptAt = attemptAt

        const attempt = {
          key: target.key,
          attemptId,
          requestHash,
          at: attemptAt,
          attemptNo: entry.attempts.length + 1,
          noProgressStreak: entry.noProgressStreak,
          hypothesis: { text: hypothesisText, epistemicStatus: 'working-hypothesis' },
          probe,
          serverObservation: structuredClone(observation),
          evidence: verifiedEvidence ? structuredClone(verifiedEvidence) : { status: evidenceStatus, ...(evidenceResult.errorCode ? { errorCode: evidenceResult.errorCode } : {}) },
          newInformation: { evidence: isNewEvidence, error: isNewError, progress: explicitProgress, boundedSmallerProbe: smallerProbeGranted },
          decision: 'continue',
          decisionReason: 'within-budget',
        }
        entry.attempts.push(attempt)
        const postAttemptDecision = decisionFor(target.key, entry, attemptAt, undefined, limits, true)
        attempt.decision = postAttemptDecision.decision
        attempt.decisionReason = postAttemptDecision.reason
        state.audit.push({ event: 'attempt-recorded', key: target.key, attemptId, at: attemptAt, decision: attempt.decision, evidenceStatus })
        if (state.audit.length > limits.auditLimit) state.audit = state.audit.slice(-limits.auditLimit)
        Object.assign(raw, state)
        result = structuredClone(attempt)
        return raw
      }, { fallback: emptyState(), lockTimeoutMs: limits.lockTimeoutMs })
    } catch (error) {
      if (String(error?.code ?? '').startsWith('HYPOTHESIS_MEMORY_')) throw error
      fail('HYPOTHESIS_MEMORY_UNAVAILABLE', 'hypothesis memory update failed: ' + String(error?.message ?? error))
    }
    return result
  }

  function snapshot(scope) {
    const identity = validateScopeFilter(scope)
    const state = durableRead(file)
    const rows = Object.entries(state.entries)
      .filter(([, entry]) => identity === undefined || stableJson(entry.identity) === stableJson(identity))
      .map(([key, entry]) => ({ key, ...structuredClone(entry) }))
    const keys = new Set(rows.map(row => row.key))
    return Object.freeze({
      version: state.version,
      revision: state.revision ?? 0,
      entries: rows,
      audit: structuredClone(state.audit.filter(row => identity === undefined || keys.has(row.key))),
    })
  }

  return Object.freeze({ recordAttempt, checkAttempt, snapshot })
}
