// When to fold a session's context, and with which mechanism. Pure: it reads nothing and changes nothing, so it can
// run in shadow next to the real triggers and be compared with what they did.
//
// The rule it encodes:
//   - at or above the hard cap (autoCompactRatio of the model window) the context must be folded now, finished phase
//     or not. That cap is the existing safety limit and is not this function's to move;
//   - below `minFoldTokens` nothing is folded: the model attends best there and the prefix is cached, so rewriting it
//     costs more than it saves;
//   - between `minFoldTokens` and `proactiveTokens` a fold needs a reason: a finished large phase (milestone), or a
//     cache that is already cold, in which case the rewrite costs nothing extra;
//   - at or above `proactiveTokens` attention degrades and every turn is expensive, so fold at the next safe boundary.
// Mechanism: a durable window (W2) keeps the originals retrievable and needs no summary call, so it is preferred where
// it is allowed and not backing off; everywhere else the native compaction is used.

export const WINDOW_DECISION_DEFAULTS = Object.freeze({
  minFoldTokens: 200000, proactiveTokens: 500000, hardCapRatio: 0.75,
  // Measured on the production usage ledger (2026-09-30..10-06, 2974 request gaps): the median cache-hit share stays
  // above 97% for gaps up to an hour and drops to 3% beyond it. Treating a warm cache as cold wastes a rewrite, the
  // opposite only delays a fold, so the idle test waits for the far side of that cliff.
  cacheIdleMs: 3600000,
})

const count = value => Number.isFinite(value) && value >= 0 ? value : null
const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback

/**
 * @param input.contextTokens        tokens the next request would carry
 * @param input.windowTokens         the model's context window
 * @param input.milestoneDone        a large phase was ticked and has not been folded yet
 * @param input.safeBoundary         the agent is idle between turns with no tool effect in flight
 * @param input.lastRequestAt        time of the last model request (ms), for the idle test
 * @param input.window               { eligible, deferred, retryAt } for W2 on this session
 * @param input.now                  current time (ms)
 */
export function decideWindowAction(input = {}, settings = {}) {
  const minFoldTokens = positive(settings.minFoldTokens, WINDOW_DECISION_DEFAULTS.minFoldTokens)
  const proactiveTokens = Math.max(minFoldTokens, positive(settings.proactiveTokens, WINDOW_DECISION_DEFAULTS.proactiveTokens))
  const hardCapRatio = positive(settings.hardCapRatio, WINDOW_DECISION_DEFAULTS.hardCapRatio)
  const cacheIdleMs = positive(settings.cacheIdleMs, WINDOW_DECISION_DEFAULTS.cacheIdleMs)
  const contextTokens = count(input.contextTokens), windowTokens = count(input.windowTokens), now = count(input.now)
  const facts = { contextTokens, windowTokens, minFoldTokens, proactiveTokens,
    hardCapTokens: windowTokens === null ? null : Math.floor(windowTokens * hardCapRatio) }
  const decide = (action, reason, extra = {}) => Object.freeze({ action, reason, mechanism: null, ...extra, facts: Object.freeze(facts) })
  if (contextTokens === null) return decide('none', 'context-size-unknown')

  // Cold cache: the provider said so, or nothing was sent for long enough that the cached prefix has expired.
  const last = count(input.lastRequestAt)
  const idleMs = now !== null && last !== null ? Math.max(0, now - last) : null
  // Only elapsed time says the cache is cold now. The last request's own hit share does not: a request that missed
  // (the first one after a fold, for instance) has just written the prefix back, so the cache is warm again. On the
  // first long production run that share triggered eleven false "cold" verdicts, each right after a compaction.
  const cacheCold = idleMs !== null && idleMs >= cacheIdleMs
  facts.cacheCold = cacheCold; facts.idleMs = idleMs

  const window = input.window ?? {}
  const backingOff = window.deferred === true || (Number.isFinite(window.retryAt) && now !== null && now < window.retryAt)
  const mechanism = window.eligible === true && !backingOff ? 'window' : 'compaction'
  const fold = (reason, urgent = false) => input.safeBoundary === true || urgent
    ? decide('fold', reason, { mechanism: urgent ? 'compaction' : mechanism })
    : decide('wait-for-boundary', reason, { mechanism })

  // The hard cap does not wait for a boundary and always uses the mechanism that cannot be refused by a busy host.
  if (facts.hardCapTokens !== null && contextTokens >= facts.hardCapTokens) return fold('hard-cap', true)
  if (contextTokens < minFoldTokens) return decide('none', input.milestoneDone === true ? 'milestone-below-floor' : 'below-floor')
  if (contextTokens >= proactiveTokens) return fold('proactive-size')
  if (input.milestoneDone === true) return fold('milestone')
  if (cacheCold) return fold('cache-cold')
  return decide('none', 'cache-warm-phase-open')
}

// The loaded-code certificate reads this module's own source hash from here (see team-v15-window-loaded.mjs).
import { registerLoadedModule } from './team-v15-window-loaded.mjs'
registerLoadedModule(import.meta.url)
