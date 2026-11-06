import { failWith } from '../../../contracts/index.mjs';

/**
 * External hooks mark dirty only; they never dispatch wake or write visibility.
 *
 * The session id and the host are two explicit arguments. An earlier shape took the host alone, which made the one
 * obvious call site — markDirty(sessionId) — kick nothing at all through an optional chain: the tool-gap dirty mark
 * silently stopped working and F16 lost its cycle wake (D review #7). Both arguments are checked, and a caller that
 * passes only one of them is refused here instead of no-oping.
 */
export function visibilityDirty(sessionId, host) {
  if (typeof sessionId !== 'string' || !sessionId) {
    failWith('INVALID_SESSION', 'visibilityDirty takes the session id first; got ' + JSON.stringify(sessionId ?? null));
  }
  const cycle = host && typeof host === 'object' ? host.cycle : null;
  if (!cycle || typeof cycle.kick !== 'function') {
    failWith('INVALID_HOST', 'visibilityDirty takes the host second and needs host.cycle.kick; got ' +
      (host === null || host === undefined ? String(host) : typeof host));
  }
  cycle.kick('visibility-hook');
}

/**
 * The dirty hook is a pair, and the pair is checked once at registration.
 *
 * markDirty is visibilityDirty, so a hook wired without its host could only throw on every call it makes. Checking the
 * pair inside tools/pre-execute would trade "the tool gap is never marked" for "every tool call fails after its result
 * was produced"; checking it here fails a mis-wiring once, before any hook runs (review 2 #2). No dirty hook at all is
 * a valid wiring and returns false.
 */
export function assertDirtyWiring(markDirty, host) {
  if (markDirty === undefined || markDirty === null) return false;
  if (typeof markDirty !== 'function') {
    failWith('INVALID_CONFIG', 'markDirty must be a function (visibilityDirty); got ' + typeof markDirty);
  }
  const cycle = host && typeof host === 'object' ? host.cycle : null;
  if (!cycle || typeof cycle.kick !== 'function') {
    failWith('INVALID_CONFIG', 'markDirty needs the host as well: markDirty(sessionId, host) is visibilityDirty, and a ' +
      'host-less mark could only fail on every tool call');
  }
  return true;
}

/**
 * Mark dirty from a hook: a failing mark is an audit-side side effect and never breaks the tool call that triggered it.
 * The caller gets false, the tool's own decision stands, and the next committed boundary still runs (review 2 #2).
 */
export function markDirtySafely(markDirty, sessionId, host) {
  if (typeof markDirty !== 'function') return false;
  try { markDirty(sessionId, host); return true; } catch { return false; }
}
