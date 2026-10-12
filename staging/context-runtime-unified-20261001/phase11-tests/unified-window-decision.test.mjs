import test from 'node:test'
import assert from 'node:assert/strict'
import { decideWindowAction, WINDOW_DECISION_DEFAULTS } from '../home/profiles/web/plugins/team-v15-window-decision.mjs'

const base = { windowTokens: 1048576, safeBoundary: true, now: 100_000_000, lastRequestAt: 100_000_000 - 5000 }
const decide = (input, settings) => decideWindowAction({ ...base, ...input }, settings)

test('below 200k nothing is folded, even when a milestone was ticked or the cache is cold', () => {
  assert.deepEqual([decide({ contextTokens: 60000 }).action, decide({ contextTokens: 60000 }).reason], ['none', 'below-floor'])
  assert.equal(decide({ contextTokens: 199999, milestoneDone: true }).reason, 'milestone-below-floor')
  assert.equal(decide({ contextTokens: 150000, lastRequestAt: 0 }).action, 'none')
})

test('between 200k and 500k a fold needs a finished phase or a cold cache', () => {
  assert.equal(decide({ contextTokens: 300000 }).reason, 'cache-warm-phase-open')
  assert.equal(decide({ contextTokens: 300000 }).action, 'none')
  assert.deepEqual([decide({ contextTokens: 300000, milestoneDone: true }).action, decide({ contextTokens: 300000, milestoneDone: true }).reason], ['fold', 'milestone'])
  const idle = decide({ contextTokens: 300000, lastRequestAt: base.now - WINDOW_DECISION_DEFAULTS.cacheIdleMs })
  assert.deepEqual([idle.action, idle.reason, idle.facts.cacheCold], ['fold', 'cache-cold', true])
  assert.equal(decide({ contextTokens: 300000, lastRequestAt: base.now - WINDOW_DECISION_DEFAULTS.cacheIdleMs + 1 }).action, 'none')
})

test('only elapsed time makes the cache cold; the hit share of the last request does not', () => {
  // A request that just missed the cache has rewritten the prefix: the cache is warm, whatever its hit share was.
  assert.equal(decide({ contextTokens: 300000, lastCacheHitRatio: 0 }).reason, 'cache-warm-phase-open')
  assert.equal(decide({ contextTokens: 300000, lastCacheHitRatio: 0.99, lastRequestAt: 0 }).reason, 'cache-cold')
})

test('from 500k a fold is due at the next safe boundary without any other reason', () => {
  assert.deepEqual([decide({ contextTokens: 500000 }).action, decide({ contextTokens: 500000 }).reason], ['fold', 'proactive-size'])
  const busy = decide({ contextTokens: 600000, safeBoundary: false })
  assert.deepEqual([busy.action, busy.reason], ['wait-for-boundary', 'proactive-size'])
})

test('the hard cap is 75% of the model window, does not wait for a boundary and always compacts', () => {
  const cap = Math.floor(1048576 * 0.75)
  assert.equal(decide({ contextTokens: cap - 1 }).reason, 'proactive-size')
  const over = decide({ contextTokens: cap, safeBoundary: false, window: { eligible: true } })
  assert.deepEqual([over.action, over.reason, over.mechanism], ['fold', 'hard-cap', 'compaction'])
  // A small-window model reaches its cap below the 200k floor: the cap still wins.
  assert.equal(decide({ contextTokens: 100000, windowTokens: 128000 }).reason, 'hard-cap')
})

test('a durable window is chosen only where it is allowed and not backing off', () => {
  const due = { contextTokens: 300000, milestoneDone: true }
  assert.equal(decide(due).mechanism, 'compaction')
  assert.equal(decide({ ...due, window: { eligible: true } }).mechanism, 'window')
  assert.equal(decide({ ...due, window: { eligible: true, deferred: true } }).mechanism, 'compaction')
  assert.equal(decide({ ...due, window: { eligible: true, retryAt: base.now + 1 } }).mechanism, 'compaction')
  assert.equal(decide({ ...due, window: { eligible: true, retryAt: base.now } }).mechanism, 'window')
})

test('unknown inputs never produce a fold; settings are honoured and never invert the bands', () => {
  assert.equal(decideWindowAction({}).reason, 'context-size-unknown')
  assert.equal(decideWindowAction({ contextTokens: 300000 }).action, 'none', 'no clock and no ratio means the cache is not known to be cold')
  assert.equal(decide({ contextTokens: 120000, milestoneDone: true }, { minFoldTokens: 100000 }).action, 'fold')
  assert.equal(decide({ contextTokens: 250000 }, { minFoldTokens: 300000, proactiveTokens: 100 }).action, 'none')
  assert.ok(Object.isFrozen(decide({ contextTokens: 1 })))
})
