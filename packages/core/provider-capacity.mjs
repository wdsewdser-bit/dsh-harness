/**
 * Gap 3 of docs/decisions/superagent-borrow-integration.md (design §11 row "provider 连接池/全局速率限制"): provider
 * capacity is an observation with an expiry, never a promise. The fake-429 matrix already proved that keeping the
 * local H slot on an upstream limit is safe; this module names what the host actually knows, so a person can tell a
 * local queue from an upstream throttle instead of reading one "unknown" for both:
 *
 *   throttled  An observed 429 (with Retry-After, or the default observation window) or a saturated transport pool.
 *              While the window is open no new owner provider call is admitted: no slot is acquired, so nothing is
 *              held and nothing can leak.
 *   available  A provider response was observed and the evidence is still fresh. Only a real response says this.
 *   unknown    No evidence, an elapsed throttle window without an observed recovery, a stale observation, or a
 *              transport failure that does not prove a rate limit. Unknown is fail-closed: it never claims a free
 *              upstream. Only "throttled" defers work; unknown adds no freeze of its own.
 *
 * "local-queued" is deliberately not a provider state: it is what capacityStatus reports when local N/H work waits
 * while the provider is not throttled, so "the queue is ours" is never dressed up as "the provider is slow".
 *
 * Recovery (throttled -> available) needs BOTH: the window ended, and a provider response was observed after it. An
 * elapsed window only downgrades to unknown; a response inside the window does not revoke the announced limit. A
 * durable fact is only written on a state change (or a fresh limit after the window), so a throttled lane cannot
 * grow the journal on every retry.
 */
export const PROVIDER_CAPACITY_ROW = 'provider-capacity:latest';
export const PROVIDER_CAPACITY_STATES = Object.freeze(['unknown', 'available', 'throttled']);
/** Observation window used when the provider announces no Retry-After. */
export const PROVIDER_WINDOW_MS = 60 * 1000;
/** How long one observed provider response stays evidence of availability. */
export const PROVIDER_EVIDENCE_TTL_MS = 5 * 60 * 1000;

const row = (state, reason, observedAt, retryAfterMs = null, windowMs = null, recoveryAt = null) =>
  Object.freeze({ state, reason, observedAt, retryAfterMs, windowMs, recoveryAt });
const unknown = (reason, observedAt = null, recoveryAt = null) => row('unknown', reason, observedAt, null, null, recoveryAt);

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') { try { return headers.get(name); } catch { return null; } }
  if (Array.isArray(headers)) { for (const entry of headers) if (String(entry?.[0] ?? '').toLowerCase() === name) return entry[1]; return null; }
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value;
  return null;
}
/** Retry-After is delta-seconds or an HTTP date; anything unreadable is no header at all. */
function retryAfterMs(value, now) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value * 1000);
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** One provider failure -> one normalized observation, or null when the error says nothing about capacity. */
export function providerFailureObservation(error, now = Date.now()) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? '');
  const retryAfter = retryAfterMs(headerValue(error?.headers ?? error?.response?.headers, 'retry-after'), now);
  if (status === 429) return row('throttled', 'provider-rate-limit', now, retryAfter, PROVIDER_WINDOW_MS);
  if (status === 503 && retryAfter !== null) return row('throttled', 'provider-unavailable-retry-after', now, retryAfter, PROVIDER_WINDOW_MS);
  if (code === 'POOL_EXHAUSTED' || code === 'ERR_POOL_EXHAUSTED' || /\bpool\b[^.]*\b(exhaust|full|drain)/i.test(message))
    return row('throttled', 'transport-pool-exhausted', now, null, PROVIDER_WINDOW_MS);
  // The llm layer hands a finished stream its provider-neutral failure code instead of the HTTP error (finish chunk
  // reason.failure). RATE_LIMIT is the only code that proves a limit; the transport codes prove only that nothing is
  // known, and every other code (AUTH, EMPTY_RESPONSE, QUOTA_EXCEEDED, ...) says nothing about capacity.
  if (code === 'RATE_LIMIT') return row('throttled', 'provider-rate-limit', now,
    retryAfterMs(error?.retryAfterMs ?? error?.retryAfter, now), PROVIDER_WINDOW_MS);
  if (['TRANSPORT', 'TIMEOUT', 'SERVER'].includes(code)) return row('unknown', 'provider-transport-failure', now);
  // A transport failure with no limit in it is evidence of nothing: it must never be read as availability.
  if ([502, 503, 504].includes(status) || ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code))
    return row('unknown', 'provider-transport-failure', now);
  return null;
}

/** What the durable observation means *now*. Absence, staleness and an elapsed window are unknown, never available. */
export function providerCapacity(store, now = Date.now()) {
  let current = null;
  try { current = store?.read?.(PROVIDER_CAPACITY_ROW) ?? null; } catch { current = null; }
  if (!current) return unknown('no-observation');
  const observedAt = Number.isFinite(current.observedAt) ? current.observedAt : null;
  if (observedAt === null) return unknown('unrecognized-observation');
  const retryAfter = Number.isFinite(current.retryAfterMs) ? current.retryAfterMs : null;
  if (current.state === 'throttled') {
    const windowMs = retryAfter ?? (Number.isFinite(current.windowMs) ? current.windowMs : PROVIDER_WINDOW_MS);
    const recoveryAt = observedAt + windowMs;
    if (now < recoveryAt) return row('throttled', current.reason ?? 'provider-rate-limit', observedAt, retryAfter, windowMs, recoveryAt);
    // The provider's own window ended, but nothing has been observed since: no claim of availability.
    return unknown('throttle-window-elapsed-awaiting-observation', observedAt, recoveryAt);
  }
  if (current.state === 'available') {
    const expiresAt = observedAt + PROVIDER_EVIDENCE_TTL_MS;
    if (now <= expiresAt) return row('available', current.reason ?? 'provider-response-observed', observedAt, null, null, expiresAt);
    return unknown('stale-observation', observedAt, expiresAt);
  }
  return unknown(current.reason ?? 'unrecognized-observation', observedAt);
}

/** The wait a person sees. An upstream limit wins over a merely full local lane. */
export function providerWait(provider, localQueued = false) {
  if (provider?.state === 'throttled') return 'provider-throttled';
  if (localQueued) return 'local-queued';
  return 'none';
}

/** Write the observation only when it changes what the host knows; returns the durable row or null. */
export function recordProviderObservation(core, observation, now = Date.now()) {
  if (!observation || !PROVIDER_CAPACITY_STATES.includes(observation.state)) return null;
  const toWrite = Object.freeze({ state: observation.state, reason: observation.reason ?? null,
    retryAfterMs: Number.isFinite(observation.retryAfterMs) ? observation.retryAfterMs : null,
    windowMs: Number.isFinite(observation.windowMs) ? observation.windowMs : null,
    observedAt: Number.isFinite(observation.observedAt) ? observation.observedAt : now });
  const current = providerCapacity(core.store, now);
  if (toWrite.state === 'throttled') {
    // One open window is one fact: repeated in-flight limits inside it must not grow the journal.
    if (current.state === 'throttled' && current.reason === toWrite.reason && now < current.recoveryAt) return null;
  } else if (toWrite.state === 'available' && current.state === 'available') return null;
  else if (toWrite.state === 'unknown' && current.state === 'unknown') return null;
  // Nothing but a fresh limit may overwrite an open, announced window: a response inside it or an unproven failure
  // does not revoke the provider's own Retry-After (see the module comment).
  if (current.state === 'throttled' && now < current.recoveryAt) return null;
  return core.controlFact(PROVIDER_CAPACITY_ROW, toWrite, tx => tx.put(PROVIDER_CAPACITY_ROW, toWrite));
}

/** One provider outcome -> one observation: a thrown error, a finished stream failure, or a clean finish. */
export function providerOutcome({ error = null, failure = null } = {}, now = Date.now()) {
  if (error) return providerFailureObservation(error, now);
  if (failure) return providerFailureObservation(failure, now);
  return row('available', 'provider-response-observed', now);
}

/**
 * The one adapter between the provider call path and the durable fact: `(null, null)` means a provider response was
 * observed, an error or a finish failure is classified. Recording a fact never turns a successful call into a failure,
 * and a failed recording leaves the previous state (possibly unknown) intact rather than inventing availability.
 */
export function providerObserver(core, now = Date.now) {
  return (error = null, failure = null) => {
    const observation = providerOutcome({ error, failure }, now());
    if (!observation) return null;
    try { return recordProviderObservation(core, observation, now()); } catch { return null; }
  };
}
