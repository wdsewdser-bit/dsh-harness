/** Shared process-local foreground root used by Team observers. */

console.log('[team-armed-roots] HMR perf40-single-root-focus loaded 2026-09-27')

const ARMED_ROOTS_KEY = Symbol.for('dsh.agent-team.armed-roots.v2')
const BACKGROUND_WAKES_KEY = Symbol.for('dsh.agent-team.background-wakes.v1')
const DEFAULT_BACKGROUND_WAKE_TTL_MS = 60_000

/** Return the process-wide armed-root Set shared by Team observers. */
export function armedRoots() {
  if (!(globalThis[ARMED_ROOTS_KEY] instanceof Set)) globalThis[ARMED_ROOTS_KEY] = new Set()
  return globalThis[ARMED_ROOTS_KEY]
}

/**
 * Make one root the only root eligible for background observer wakes.
 *
 * DSH does not expose which browser session is currently foreground. The safest
 * approximation is that the root whose own turn started most recently owns the
 * observers. Member activity and observer-generated wakes must never replace it.
 */
export function focusRoot(set, rootId) {
  const key = String(rootId ?? '')
  if (key.length === 0) return false
  set.clear()
  set.add(key)
  return true
}

/** Backward-compatible alias; observer call sites should use focusRoot. */
export function armRoot(set, rootId) {
  return focusRoot(set, rootId)
}

/** Remove one root from the observer focus. */
export function disarmRoot(set, rootId) {
  const key = String(rootId ?? '')
  return key.length > 0 && set.delete(key)
}

/** Check whether this root currently owns background observer wakes. */
export function isArmed(set, rootId) {
  return set.has(String(rootId ?? ''))
}

/**
 * Restore the observer focus after a process restart without guessing between
 * multiple idle roots. An already-focused root is authoritative. If no root is
 * active, only a single candidate is safe: arming one of several idle roots
 * could wake an old conversation.
 */
export function focusBootstrapRoot(set, candidates) {
  if (!(set instanceof Set) || set.size > 0) return false
  const roots = Array.isArray(candidates)
    ? candidates.filter((candidate) => candidate && String(candidate.key ?? '').length > 0)
    : []
  if (roots.length === 0) return false
  const active = roots.filter((candidate) =>
    candidate.status === 'running' || candidate.status === 'provisioning')
  if (active.length > 0) {
    active.sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0))
    return focusRoot(set, active[0].key)
  }
  return roots.length === 1 ? focusRoot(set, roots[0].key) : false
}

function backgroundWakes() {
  if (!(globalThis[BACKGROUND_WAKES_KEY] instanceof Map)) globalThis[BACKGROUND_WAKES_KEY] = new Map()
  return globalThis[BACKGROUND_WAKES_KEY]
}

function pruneBackgroundWakes(now = Date.now()) {
  const entries = backgroundWakes()
  for (const [key, entry] of entries) {
    if (!entry || Number(entry.expiresAt ?? 0) <= now) entries.delete(key)
  }
  while (entries.size > 256) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
  }
}

/** Mark the next own-turn transition as observer-generated, not foreground user activity. */
export function markBackgroundWake(rootId, ttlMs = DEFAULT_BACKGROUND_WAKE_TTL_MS) {
  const key = String(rootId ?? '')
  if (key.length === 0) return false
  const now = Date.now()
  pruneBackgroundWakes(now)
  const current = backgroundWakes().get(key)
  const remaining = current && Number(current.expiresAt ?? 0) > now ? Number(current.remaining ?? 0) : 0
  backgroundWakes().set(key, {
    remaining: Math.min(32, remaining + 1),
    expiresAt: now + Math.max(1, Number(ttlMs) || DEFAULT_BACKGROUND_WAKE_TTL_MS),
  })
  return true
}

/** Consume one observer-generated turn marker for this root. */
export function consumeBackgroundWake(rootId) {
  const key = String(rootId ?? '')
  if (key.length === 0) return false
  const now = Date.now()
  pruneBackgroundWakes(now)
  const current = backgroundWakes().get(key)
  if (!current || Number(current.expiresAt ?? 0) <= now || Number(current.remaining ?? 0) <= 0) return false
  current.remaining = Number(current.remaining) - 1
  if (current.remaining <= 0) backgroundWakes().delete(key)
  else backgroundWakes().set(key, current)
  return true
}

/** Test/diagnostic hook; production callers do not need to clear this state. */
export function clearBackgroundWakes() {
  backgroundWakes().clear()
}
