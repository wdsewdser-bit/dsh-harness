import { createHash } from 'node:crypto'

const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object'
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x
const hash = x => createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const sync = (fn, ...args) => {
  const result = fn(...args)
  if (result?.then) fail('WINDOW_ECONOMIC_SYNC_READER_REQUIRED')
  return structuredClone(result)
}

/** Maintenance changes host epoch and nativeBoundaryHash; neither is economic
 * source content. configFingerprint hashes host epoch too, so the host must bind
 * independent policy/config through mandatory readPolicyBinding instead. */
export function economicSourceHash(source) {
  if (!source || typeof source !== 'object' || !source.sessionId || !source.actorId
    || !Array.isArray(source.messages) || !Array.isArray(source.completedSpans)
    || !source.authority || !source.recovery || !source.criticalRevisionVector) fail('WINDOW_ECONOMIC_SOURCE_INCOMPLETE')
  const { events, working, configFingerprint, criticalRevisionVector, ...semantic } = source
  const { host, nativeBoundaryHash, ...critical } = criticalRevisionVector
  return hash({ ...semantic, criticalRevisionVector: critical })
}

/** Host-only boundary guard. Native transition dynamically calls session.append;
 * its existing synchronous validation and durable barrier remain authoritative.
 * No native module, certificate or gate is replaced. */
export function installEconomicCommitGuard({ session, readSource, readPolicyBinding, readRawSafety,
  audit, clock = Date.now } = {}) {
  if (!session?.id || typeof session.append !== 'function'
    || ![readSource, readPolicyBinding, readRawSafety, audit, clock].every(fn => typeof fn === 'function')) fail('WINDOW_ECONOMIC_HOST_CONFIG_REQUIRED')
  const previous = session.append
  const previousDescriptor = Object.getOwnPropertyDescriptor(session, 'append')
  let active = null, disposed = false
  const synchronousAudit = row => { if (audit(row)?.then) fail('WINDOW_ECONOMIC_SYNC_AUDIT_REQUIRED') }
  const check = (permit, options, data) => {
    if (disposed || permit.signal.aborted || active !== permit || clock() >= permit.expiresAt) fail('WINDOW_ECONOMIC_AUTHORIZATION_EXPIRED')
    const current = sync(readSource, { writerToken: options?.writerToken })
    if (current.sessionId !== session.id || current.actorId !== permit.actorId
      || economicSourceHash(current) !== permit.sourceHash || hash(sync(readPolicyBinding)) !== permit.policyHash) fail('WINDOW_ECONOMIC_SOURCE_CHANGED')
    const raw = sync(readRawSafety, { writerToken: options?.writerToken, source: current })
    if (raw?.rawGatePreserved !== true || raw.safeCompactionRequired !== false
      || !Number.isFinite(raw.rawSafetyTokens) || raw.rawSafetyTokens < 0 || !Number.isFinite(raw.safeLimitTokens)
      || raw.safeLimitTokens <= 0 || raw.rawSafetyTokens >= raw.safeLimitTokens) fail('WINDOW_ECONOMIC_RAW_SAFETY_REQUIRED')
    if (data.source.windowCommit.sessionId !== session.id || !options?.writerToken
      || hash(options.sourceEventSeqs) !== permit.selectedHash) fail('WINDOW_ECONOMIC_NATIVE_CANDIDATE_CHANGED')
    if (permit.consumed) fail('WINDOW_ECONOMIC_AUTHORIZATION_CONSUMED')
  }
  function guardedAppend(type, data, options) {
    if (this !== session) fail('WINDOW_ECONOMIC_APPEND_OWNER_CHANGED')
    const permit = active
    if (type === 'user/message' && data?.source?.windowCommit && permit) {
      check(permit, options, data)
      synchronousAudit({ kind: 'w3-durable-commit-authorized', sessionId: session.id, candidateHash: permit.candidateHash,
        economicSourceHash: permit.sourceHash, transitionId: data.source.windowCommit.transitionId })
      // Audit is host code too. Re-read after it, then call append in this stack.
      check(permit, options, data)
      permit.consumed = true
      return Reflect.apply(previous, session, [type, data, options])
    }
    return Reflect.apply(previous, session, [type, data, options])
  }
  Object.defineProperty(session, 'append', { configurable: true, enumerable: previousDescriptor?.enumerable ?? false,
    writable: true, value: guardedAppend })
  return Object.freeze({
    async run({ guard, signal, candidateHash, sourceEventSeqs, expiresAt, actorId }, job) {
      if (disposed || signal?.aborted) fail('WINDOW_ECONOMIC_AUTHORIZATION_EXPIRED')
      if (active || session.append !== guardedAppend) fail('WINDOW_ECONOMIC_GUARD_BUSY_OR_REPLACED')
      if (typeof guard !== 'function' || typeof job !== 'function' || !actorId
        || !/^[a-f0-9]{64}$/.test(candidateHash ?? '') || !Number.isFinite(expiresAt) || expiresAt <= clock()
        || !Array.isArray(sourceEventSeqs) || !sourceEventSeqs.length
        || !sourceEventSeqs.every(n => Number.isSafeInteger(n) && n >= 0)
        || new Set(sourceEventSeqs).size !== sourceEventSeqs.length) fail('WINDOW_ECONOMIC_PERMIT_INCOMPLETE')
      guard()
      const captured = sync(readSource, {})
      if (captured.sessionId !== session.id || captured.actorId !== actorId) fail('WINDOW_ECONOMIC_SOURCE_CHANGED')
      const policy = sync(readPolicyBinding)
      if (!policy || typeof policy !== 'object' || !Object.keys(policy).length) fail('WINDOW_ECONOMIC_POLICY_BINDING_REQUIRED')
      const permit = { signal, actorId, candidateHash, sourceHash: economicSourceHash(captured), policyHash: hash(policy),
        selectedHash: hash(sourceEventSeqs), expiresAt, consumed: false }
      guard()
      active = permit
      try { return await job() }
      finally { if (active === permit) active = null }
    },
    dispose() {
      disposed = true
      // Keep the wrapper while a transaction is pending: it must refuse late append.
      if (!active && session.append === guardedAppend) {
        if (previousDescriptor) Object.defineProperty(session, 'append', previousDescriptor)
        else delete session.append
      }
    },
    stats: () => ({ disposed, armed: active !== null, guarded: session.append === guardedAppend }),
  })
}
