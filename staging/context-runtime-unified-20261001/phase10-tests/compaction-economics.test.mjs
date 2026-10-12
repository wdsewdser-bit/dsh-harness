import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decideCompaction,
  estimateRemainingRequests,
  summarizeCacheUsage,
} from '../home/profiles/web/plugins/team-v13-compaction-economics.mjs'

const base = {
  writeTokens: 8000,
  archiveTokens: 120000,
  memoTokens: 2000,
  contextTokens: 200000,
  completedBoundaryRequestCounts: [10, 12, 14, 16],
  remainingBoundaries: 10,
  averageContextTokenIncrement: 2000,
  contextWindowTokens: 1_000_000,
  priorCompactionCount: 1,
  carriedDebtTokens: 0,
  cacheDebtRepaymentTokens: 0,
  cacheWriteReadRatio: 12.5,
  minContextGrowthTokens: 0,
  minRequestsSinceCompaction: 0,
}

test('remaining requests uses the observed per-boundary mean', () => {
  const estimate = estimateRemainingRequests({
    completedBoundaryRequestCounts: [10, 12, 14, 16],
    remainingBoundaries: 10,
    scale: 1,
    standardDeviationK: 0,
    contextTokens: 200000,
    contextWindowTokens: 1_000_000,
    averageContextTokenIncrement: 2000,
  })
  assert.equal(estimate.requestsPerBoundaryMean, 13)
  assert.equal(estimate.unboundedExpectedRemainingRequests, 131)
  assert.equal(estimate.windowRequestUpperBound, 400)
  assert.equal(estimate.expectedRemainingRequests, 131)
})

test('a missing cache ratio defers instead of guessing', () => {
  const decision = decideCompaction({ ...base, cacheWriteReadRatio: null })
  assert.equal(decision.compact, false)
  assert.equal(decision.reason, 'cache_ratio_unavailable')
  assert.equal(decision.breakevenRequests, null)
})

test('window protection compacts even without an economic ratio', () => {
  const decision = decideCompaction({
    ...base,
    cacheWriteReadRatio: null,
    contextTokens: 990_000,
  })
  assert.equal(decision.compact, true)
  assert.equal(decision.reason, 'window_protection')
})

test('economic compaction fires when the horizon repays the rewrite', () => {
  const decision = decideCompaction(base)
  assert.equal(decision.compact, true)
  assert.equal(decision.reason, 'economic')
  assert.ok(decision.breakevenRequests > 0)
  assert.ok(decision.expectedRemainingRequests >= decision.breakevenRequests)
})

test('growth and cooldown gates defer an otherwise economic compaction', () => {
  const growth = decideCompaction({
    ...base,
    minContextGrowthTokens: 50_000,
    lastCompactionContextTokens: 180_000,
  })
  assert.equal(growth.compact, false)
  assert.equal(growth.reason, 'deferred_growth')

  const cooldown = decideCompaction({
    ...base,
    minRequestsSinceCompaction: 20,
    requestsSinceCompaction: 3,
  })
  assert.equal(cooldown.compact, false)
  assert.equal(cooldown.reason, 'deferred_cooldown')
})

test('non-positive saving is reported explicitly', () => {
  const decision = decideCompaction({ ...base, archiveTokens: 1000, memoTokens: 2000 })
  assert.equal(decision.compact, false)
  assert.equal(decision.reason, 'non_positive_saving')
})

test('cache usage summarizes the cached prompt share', () => {
  const summary = summarizeCacheUsage([
    { inputTokens: 1000, cacheReadTokens: 9000, outputTokens: 100 },
    { inputTokens: 2000, cacheReadTokens: 8000, outputTokens: 200 },
  ])
  assert.equal(summary.requests, 2)
  assert.equal(summary.promptTokens, 20000)
  assert.equal(summary.cacheReadShare, 0.85)
})
