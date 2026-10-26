import { createHash } from 'node:crypto'

const text = x => typeof x === 'string' && x.trim().length > 0 && x.length <= 256
const number = x => typeof x === 'number' && Number.isFinite(x) && x >= 0
const hashText = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x)
const routeKeys = ['provider', 'model', 'protocol', 'priceVersion']
const sameRoute = (a, b) => routeKeys.every(k => text(a?.[k]) && a[k] === b?.[k])
const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object'
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x
const hash = x => createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex')
const freeze = x => { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x) }; return x }
const defer = (reason, extra = {}) => ({ action: 'defer', reason, ...extra })

function candidateEconomics(e, c, now) {
  if (!['W1', 'W2'].includes(c?.kind) || !text(c.id) || !hashText(c.candidateHash)) return defer('candidate-invalid')
  if (c.kind === 'W2' && (e.live?.idle !== true || e.live.effectsInFlight !== 0)) return defer('live-boundary-not-idle')
  if (c.kind === 'W1' && (e.live?.certifiedRequestBoundary !== true || e.live.adapterValidation !== true
    || !text(e.live.requestId) || e.live.effectsInFlight !== 0)) return defer('certified-request-boundary-required')
  const cert = c.certification
  if (cert?.verified !== true || !hashText(cert.certificateHash) || !number(cert.expiresAt) || cert.expiresAt <= now
    || cert.sessionId !== e.sessionId || cert.actorId !== e.actorId || cert.sourceHash !== e.sourceHash
    || cert.candidateHash !== c.candidateHash || !sameRoute(cert.route, e.route)) return defer('candidate-uncertified-or-unbound')
  const p = c.pricing
  if (p?.known !== true || !['relative-estimate', 'provider-price'].includes(p.kind) || !text(p.source)
    || !text(p.unit) || p.priceVersion !== e.route.priceVersion) return defer('price-unknown-or-unbound')
  if (p.kind === 'relative-estimate' && p.unit !== 'relative-cost') return defer('relative-price-unit-invalid')
  const u = c.usage
  if (u?.status !== 'known' || !text(u.source) || !text(u.requestId)
    || !['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens'].every(k => number(u[k]))) return defer('usage-unknown')
  const q = c.qualityRisk
  if (q?.verified !== true || q.acceptable !== true || !number(q.score) || !text(q.evidenceRef)) return defer('quality-unverified')
  const h = c.remainingTurns
  if (!number(h?.estimate) || !number(h.uncertainty) || !text(h.source)) return defer('horizon-unknown')
  const names = ['checkpointCost', 'firstColdPenalty', 'expectedRecallCost', 'stableOldCost', 'stableNewCost']
  if (!names.every(k => number(c.costs?.[k]?.amount) && c.costs[k].unit === p.unit && text(c.costs[k].source))) return defer('cost-unknown-or-unit-mismatch')
  const transition = names.slice(0, 3).reduce((sum, k) => sum + c.costs[k].amount, 0)
  const benefit = c.costs.stableOldCost.amount - c.costs.stableNewCost.amount
  const horizon = Math.max(0, h.estimate - h.uncertainty)
  const breakEvenTurns = benefit > 0 ? transition / benefit : null
  const netBenefit = horizon * benefit - transition
  if (![transition, benefit, netBenefit].every(Number.isFinite) || !Number.isFinite(breakEvenTurns)) return defer('economics-unreliable')
  if (benefit <= 0 || horizon < breakEvenTurns || netBenefit <= 0) return defer('benefit-insufficient')
  return { action: c.kind, reason: 'economic-transition-approved', candidateId: c.id, candidateHash: c.candidateHash,
    pricingKind: p.kind, unit: p.unit, estimated: true, realFeeClaim: false,
    transitionCost: transition, warmBenefitPerTurn: benefit, breakEvenTurns, conservativeHorizon: horizon, netBenefit }
}

/** Evidence is supplied by the trusted host, never tool/model arguments. No side effects here. */
export function selectWindowAction(e, { sessionId, now = Date.now(), maxEvidenceAgeMs = 5000, onlyKind = null } = {}) {
  if (!number(now) || !number(maxEvidenceAgeMs)) return defer('clock-invalid')
  if (!text(sessionId) || e?.sessionId !== sessionId || !text(e.actorId) || !hashText(e.sourceHash)
    || !Number.isSafeInteger(e.revision) || e.revision < 0 || !routeKeys.every(k => text(e.route?.[k]))) return defer('identity-route-source-unbound')
  if (!number(e.observedAt) || !number(e.expiresAt) || e.observedAt > now || e.expiresAt <= now
    || now - e.observedAt > maxEvidenceAgeMs) return defer('evidence-stale')
  const s = e.hardSafety
  if (s?.rawGatePreserved !== true || !number(s.rawSafetyTokens) || !number(s.safeLimitTokens) || s.safeLimitTokens <= 0
    || typeof s.safeCompactionRequired !== 'boolean') return defer('raw-safety-unknown')
  if (s.safeCompactionRequired || s.rawSafetyTokens >= s.safeLimitTokens) return defer('native-hard-safety-required', { nativeSafetyRequired: true })
  if (!Array.isArray(e.candidates) || e.candidates.length > 32) return defer('candidates-invalid')
  if (new Set(e.candidates.map(c => c?.id)).size !== e.candidates.length) return defer('candidate-identity-ambiguous')
  const evaluated = e.candidates.map(c => onlyKind && c?.kind !== onlyKind ? defer('other-action-surface') : candidateEconomics(e, c, now))
  const eligible = evaluated.filter(x => x.action !== 'defer')
  // Costs in different units cannot be ranked against each other.
  if (new Set(eligible.map(x => x.unit)).size > 1) return defer('candidate-units-incomparable')
  eligible.sort((a, b) => b.netBenefit - a.netBenefit || a.action.localeCompare(b.action) || a.candidateId.localeCompare(b.candidateId))
  return eligible[0] ?? defer('no-eligible-candidate', { candidates: evaluated.map((x, i) => ({ candidateId: e.candidates[i]?.id ?? null, reason: x.reason })) })
}

function binding(e, decision) {
  return hash({ sessionId: e.sessionId, actorId: e.actorId, route: e.route, sourceHash: e.sourceHash, revision: e.revision,
    live: e.live, hardSafety: e.hardSafety, candidate: e.candidates.find(c => c.id === decision.candidateId && c.candidateHash === decision.candidateHash) })
}

/** Construct once in the host. tick accepts only a session ID, no callbacks or evidence. */
export function createWindowAutoEngine({ enabled = false, adapter, audit = () => {}, clock = Date.now,
  maxEvidenceAgeMs = 5000, maxSessions = 128, maxAttemptsPerSession = 4096 } = {}) {
  if (typeof adapter?.readEvidence !== 'function' || typeof audit !== 'function' || typeof clock !== 'function'
    || !number(maxEvidenceAgeMs) || ![maxSessions, maxAttemptsPerSession].every(x => Number.isSafeInteger(x) && x > 0)) throw new TypeError('WINDOW_AUTO_HOST_CONFIG_INVALID')
  // Capture functions so later object mutation cannot replace the trusted adapter.
  const read = adapter.readEvidence.bind(adapter)
  const executors = Object.freeze(Object.fromEntries(['W1', 'W2'].map(kind => [kind,
    typeof adapter['execute' + kind] === 'function' ? adapter['execute' + kind].bind(adapter) : null])))
  if (adapter.executeW1?.constructor?.name === 'AsyncFunction') throw new TypeError('WINDOW_AUTO_SYNC_W1_REQUIRED')
  const sessions = new Map()
  const abort = new AbortController()
  let disposed = false
  let sequence = 0
  function emit(sessionId, result) {
    const row = freeze({ sequence: ++sequence, mode: 'auto', automaticActionsEnabled: enabled === true && !disposed,
      sessionId, ...result })
    // Audit is mandatory: an unavailable sink stops dispatch before an action.
    const ret = audit(row)
    if (ret?.then) throw new TypeError('WINDOW_AUTO_SYNC_AUDIT_REQUIRED')
    return row
  }
  function snapshot(sessionId) {
    const e = read(sessionId)
    if (e?.then) throw new TypeError('WINDOW_AUTO_SYNC_EVIDENCE_REQUIRED')
    return structuredClone(e)
  }
  function run(sessionId, state, { onlyKind = null, synchronous = false } = {}) {
    if (disposed || enabled !== true) return emit(sessionId, defer(disposed ? 'disposed' : 'auto-disabled'))
    let e, decision
    try { e = snapshot(sessionId); decision = selectWindowAction(e, { sessionId, now: clock(), maxEvidenceAgeMs, onlyKind }) }
    catch (error) { return emit(sessionId, defer('evidence-reader-failed', { error: error.code ?? error.message })) }
    if (decision.action === 'defer') return emit(sessionId, decision)
    const execute = executors[decision.action]
    if (!execute) return emit(sessionId, defer('trusted-executor-unavailable'))
    const key = hash({ sourceHash: e.sourceHash, actorId: e.actorId, route: e.route, kind: decision.action,
      requestId: decision.action === 'W1' ? e.live.requestId : null, candidateHash: decision.candidateHash })
    if (state.attempted.has(key)) return emit(sessionId, defer('already-attempted', { candidateId: decision.candidateId }))
    if (state.attempted.size >= maxAttemptsPerSession) return emit(sessionId, defer('attempt-history-capacity'))
    const expected = binding(e, decision)
    let active = true, guarded = false
    const guard = () => {
      if (!active || disposed || abort.signal.aborted) throw Object.assign(new Error('WINDOW_AUTO_DISPOSED_OR_EXPIRED'), { code: 'WINDOW_AUTO_DISPOSED_OR_EXPIRED' })
      const latest = snapshot(sessionId)
      const selected = selectWindowAction(latest, { sessionId, now: clock(), maxEvidenceAgeMs, onlyKind })
      if (selected.action !== decision.action || selected.candidateId !== decision.candidateId || selected.candidateHash !== decision.candidateHash
        || binding(latest, selected) !== expected) throw Object.assign(new Error('WINDOW_AUTO_STALE_EVIDENCE'), { code: 'WINDOW_AUTO_STALE_EVIDENCE' })
      guarded = true
      return true
    }
    try {
      guard()
      emit(sessionId, { ...decision, outcome: 'dispatch-intent', sourceHash: e.sourceHash, revision: e.revision })
      // The audit callback may run host code; check again after it and before dispatch.
      guard()
      state.attempted.add(key)
      guarded = false
      const candidate = freeze(structuredClone(e.candidates.find(c => c.id === decision.candidateId && c.candidateHash === decision.candidateHash)))
      const result = execute({ sessionId, actorId: e.actorId, route: freeze(structuredClone(e.route)),
        sourceHash: e.sourceHash, revision: e.revision, candidate, guard, signal: abort.signal })
      const finish = receipt => {
        active = false
        if (!guarded) return emit(sessionId, defer('executor-guard-contract-violated'))
        if (receipt?.applied !== true) return emit(sessionId, { ...decision, outcome: 'native-refused', reason: receipt?.reason ?? 'native-result-unconfirmed' })
        return emit(sessionId, { ...decision, outcome: 'applied', receiptId: text(receipt.receiptId) ? receipt.receiptId : null,
          completedAfterDispose: disposed })
      }
      const fail = error => {
        active = false
        return emit(sessionId, defer(error.code ?? 'trusted-executor-failed', { error: error.message, candidateId: decision.candidateId }))
      }
      if (synchronous && result?.then) {
        active = false
        Promise.resolve(result).catch(() => {})
        return emit(sessionId, defer('synchronous-W1-executor-required'))
      }
      return result?.then ? Promise.resolve(result).then(finish, fail) : finish(result)
    } catch (error) {
      active = false
      return emit(sessionId, defer(error.code ?? 'trusted-executor-failed', { error: error.message, candidateId: decision.candidateId }))
    }
  }
  return Object.freeze({
    mode: 'auto',
    dispatchW1(sessionId) {
      if (!text(sessionId)) return emit(null, defer('session-invalid'))
      if (disposed || enabled !== true) return emit(sessionId, defer(disposed ? 'disposed' : 'auto-disabled'))
      let state = sessions.get(sessionId)
      if (!state) {
        if (sessions.size >= maxSessions) return emit(sessionId, defer('session-capacity'))
        sessions.set(sessionId, state = { flight: null, attempted: new Set() })
      }
      if (state.flight) return emit(sessionId, defer('session-action-inflight'))
      const marker = Promise.resolve()
      state.flight = marker
      try { return run(sessionId, state, { onlyKind: 'W1', synchronous: true }) }
      finally { if (state.flight === marker) state.flight = null }
    },
    tick(sessionId) {
      if (!text(sessionId)) return Promise.resolve(emit(null, defer('session-invalid')))
      if (disposed || enabled !== true) return Promise.resolve(emit(sessionId, defer(disposed ? 'disposed' : 'auto-disabled')))
      let state = sessions.get(sessionId)
      if (!state) {
        if (sessions.size >= maxSessions) return Promise.resolve(emit(sessionId, defer('session-capacity')))
        sessions.set(sessionId, state = { flight: null, attempted: new Set() })
      }
      if (state.flight) return state.flight
      // Defer startup one microtask so reentrant tick calls also see the same flight.
      const flight = Promise.resolve().then(() => run(sessionId, state, { onlyKind: 'W2' })).finally(() => { if (state.flight === flight) state.flight = null })
      state.flight = flight
      return flight
    },
    stats: () => ({ mode: 'auto', automaticActionsEnabled: enabled === true && !disposed, disposed, sessions: sessions.size,
      inflight: [...sessions.values()].filter(s => s.flight).length, attempted: [...sessions.values()].reduce((n, s) => n + s.attempted.size, 0) }),
    async dispose() {
      disposed = true
      abort.abort()
      await Promise.allSettled([...sessions.values()].map(s => s.flight).filter(Boolean))
    },
  })
}
