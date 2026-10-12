/**
 * Reuse one token-meter measurement for the same session revision.
 *
 * `tokenMeter.measure()` reprices and clones the complete model-visible
 * surface. Several Team hooks run in the same agent step, so without this
 * tiny cache one step pays that cost once per plugin. The session sequence is
 * the invalidation key: a new event means a new measurement.
 */
const cache = new WeakMap()

export function measureSessionTokens(meter, session) {
  if (meter === undefined || meter === null || typeof meter.measure !== 'function') return undefined
  if (session === undefined || session === null || typeof session !== 'object') return undefined
  const seq = Number(session.seq)
  const previous = cache.get(session)
  if (previous !== undefined && previous.meter === meter && previous.seq === seq) return previous.value
  const value = meter.measure(session)
  cache.set(session, { meter, seq, value })
  return value
}
