/**
 * team-v13-compaction-economics
 *
 * Pure decision logic for opportunistic context compaction. Adapted from
 * SoL-Pi's Online Context Compact economics
 * (https://github.com/NVlabs/SoL-Pi, MIT).
 *
 * This module never compacts and never touches a session. It answers one
 * question with an auditable reason: given the observed request horizon, the
 * context size, and the cache economics, would compacting now repay its
 * rewrite cost before the work ends?
 *
 * Mandatory milestone/pressure compaction is intentionally outside this
 * module; callers must keep those paths unconditional.
 *
 * @module team-v13-compaction-economics
 */

export const DEFAULT_COMPACTION_ECONOMICS = Object.freeze({
  /** Scale applied to the observed requests-per-boundary mean. */
  remainingRequestScale: 1,
  /** How many standard deviations to subtract from the mean (0 = mean only). */
  remainingRequestStddevK: 0,
  /** Context tokens kept in reserve for the window-protection gate. */
  windowReserveTokens: 16384,
  /** The first compaction is allowed to look further ahead than later ones. */
  firstCompactionRequestScale: 2,
  /** Later compactions need this much more horizon than the breakeven. */
  subsequentCompactionMargin: 1.5,
})

const MINIMUM_VARIANCE_SAMPLES = 3
const SMALL_SAMPLE_SCALE = 0.5

/** Return a finite number, or the fallback. */
function finiteOr(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

/**
 * Estimate how many provider requests remain, using completed subtask
 * boundaries as the sample. Mirrors SoL-Pi's `estimateRemainingRequests`.
 */
export function estimateRemainingRequests(input) {
  const samples = Array.isArray(input.completedBoundaryRequestCounts)
    ? input.completedBoundaryRequestCounts.filter((value) => Number.isFinite(value) && value >= 0)
    : []
  const mean = samples.reduce((total, count) => total + count, 0) / Math.max(1, samples.length)
  let lowerBound = mean
  if (finiteOr(input.standardDeviationK, 0) !== 0) {
    if (samples.length < MINIMUM_VARIANCE_SAMPLES) {
      lowerBound *= SMALL_SAMPLE_SCALE
    } else {
      const variance = samples.reduce((total, count) => total + (count - mean) ** 2, 0)
      const deviation = Math.sqrt(variance / (samples.length - 1))
      lowerBound = Math.max(0, mean - finiteOr(input.standardDeviationK, 0) * deviation)
    }
  }

  const remainingBoundaries = Math.max(0, finiteOr(input.remainingBoundaries, 0))
  const unboundedExpectedRemainingRequests =
    1 + Math.floor(lowerBound * remainingBoundaries * finiteOr(input.scale, 1))

  const contextWindowTokens = Number.isFinite(input.contextWindowTokens) ? input.contextWindowTokens : null
  const averageContextTokenIncrement = Number.isFinite(input.averageContextTokenIncrement)
    ? input.averageContextTokenIncrement
    : null
  const windowRequestUpperBound =
    contextWindowTokens === null || averageContextTokenIncrement === null || averageContextTokenIncrement <= 0
      ? null
      : Math.max(0, Math.floor((contextWindowTokens - finiteOr(input.contextTokens, 0)) / averageContextTokenIncrement))

  return {
    completedBoundaryRequestCounts: [...samples],
    requestsPerBoundaryMean: mean,
    requestsPerBoundaryLowerBound: lowerBound,
    unboundedExpectedRemainingRequests,
    averageContextTokenIncrement,
    windowRequestUpperBound,
    expectedRemainingRequests: windowRequestUpperBound === null
      ? unboundedExpectedRemainingRequests
      : Math.min(unboundedExpectedRemainingRequests, windowRequestUpperBound),
  }
}

/**
 * Decide whether one opportunistic compaction repays its rewrite cost.
 * Mirrors SoL-Pi's `decideCompaction`, including the cache-debt gates.
 */
export function decideCompaction(input) {
  const economics = { ...DEFAULT_COMPACTION_ECONOMICS, ...(input.economics ?? {}) }
  const writeTokens = Math.max(0, finiteOr(input.writeTokens, 0))
  const archiveTokens = Math.max(0, finiteOr(input.archiveTokens, 0))
  const memoTokens = Math.max(0, finiteOr(input.memoTokens, 0))
  const contextTokens = Math.max(0, finiteOr(input.contextTokens, 0))
  const contextWindowTokens = Number.isFinite(input.contextWindowTokens) ? input.contextWindowTokens : null
  const averageContextTokenIncrement = Number.isFinite(input.averageContextTokenIncrement)
    ? input.averageContextTokenIncrement
    : null
  const priorCompactionCount = Math.max(0, finiteOr(input.priorCompactionCount, 0))
  const carriedDebtTokens = Math.max(0, finiteOr(input.carriedDebtTokens, 0))
  const cacheDebtRepaymentTokens = Math.max(0, finiteOr(input.cacheDebtRepaymentTokens, 0))
  const cacheWriteReadRatio = Number.isFinite(input.cacheWriteReadRatio) ? input.cacheWriteReadRatio : null
  const minContextGrowthTokens = Math.max(0, finiteOr(input.minContextGrowthTokens, 0))
  const minRequestsSinceCompaction = Math.max(0, finiteOr(input.minRequestsSinceCompaction, 0))
  const requestsSinceCompaction = Math.max(0, finiteOr(input.requestsSinceCompaction, 0))
  const lastCompactionContextTokens = Number.isFinite(input.lastCompactionContextTokens)
    ? input.lastCompactionContextTokens
    : null

  const completedBoundaryRequestCounts = Array.isArray(input.completedBoundaryRequestCounts)
    ? input.completedBoundaryRequestCounts
    : null
  const horizon = completedBoundaryRequestCounts === null
    ? null
    : estimateRemainingRequests({
        completedBoundaryRequestCounts,
        remainingBoundaries: input.remainingBoundaries,
        scale: economics.remainingRequestScale,
        standardDeviationK: economics.remainingRequestStddevK,
        contextTokens,
        contextWindowTokens,
        averageContextTokenIncrement,
      })

  const savingTokens = archiveTokens - memoTokens
  const incrementalCacheCostRatio = cacheWriteReadRatio === null ? null : Math.max(0, cacheWriteReadRatio - 1)
  const breakevenRequests = savingTokens > 0 && incrementalCacheCostRatio !== null
    ? (writeTokens * incrementalCacheCostRatio) / savingTokens
    : null
  const combinedBreakevenRequests = savingTokens > 0 && incrementalCacheCostRatio !== null
    ? (carriedDebtTokens + writeTokens * incrementalCacheCostRatio) / savingTokens
    : null
  const firstCompaction = priorCompactionCount === 0
  const effectiveHorizonRequests = horizon === null
    ? null
    : firstCompaction
      ? Math.min(
          horizon.expectedRemainingRequests * economics.firstCompactionRequestScale,
          horizon.windowRequestUpperBound ?? Number.POSITIVE_INFINITY,
        )
      : horizon.expectedRemainingRequests
  const windowProtection = contextWindowTokens !== null
    && contextTokens >= contextWindowTokens - economics.windowReserveTokens
  const baseEconomic = horizon !== null
    && horizon.expectedRemainingRequests > 0
    && breakevenRequests !== null
    && breakevenRequests <= horizon.expectedRemainingRequests
  const firstEconomic = firstCompaction
    && effectiveHorizonRequests !== null
    && effectiveHorizonRequests > 0
    && breakevenRequests !== null
    && breakevenRequests <= effectiveHorizonRequests
  const subsequentMarginOpen = !firstCompaction
    && horizon !== null
    && breakevenRequests !== null
    && breakevenRequests * economics.subsequentCompactionMargin <= horizon.expectedRemainingRequests
  const carriedDebtGateOpen = !firstCompaction
    && horizon !== null
    && combinedBreakevenRequests !== null
    && combinedBreakevenRequests <= horizon.expectedRemainingRequests
  const economic = firstCompaction
    ? firstEconomic
    : baseEconomic && subsequentMarginOpen && carriedDebtGateOpen
  const growthGateOpen = minContextGrowthTokens === 0
    || lastCompactionContextTokens === null
    || contextTokens - lastCompactionContextTokens >= minContextGrowthTokens
  const cooldownGateOpen = minRequestsSinceCompaction === 0
    || requestsSinceCompaction >= minRequestsSinceCompaction
  const compressible = savingTokens > 0
  const compact = compressible && (windowProtection || (economic && growthGateOpen && cooldownGateOpen))

  let reason
  if (!compressible) reason = 'non_positive_saving'
  else if (windowProtection) reason = 'window_protection'
  else if (economic && growthGateOpen && cooldownGateOpen) reason = 'economic'
  else if (horizon === null) reason = 'horizon_unavailable'
  else if (breakevenRequests === null) reason = 'cache_ratio_unavailable'
  else if (!firstCompaction && baseEconomic && !subsequentMarginOpen) reason = 'deferred_subsequent_margin'
  else if (!firstCompaction && baseEconomic && !carriedDebtGateOpen) reason = 'deferred_carried_debt'
  else if (!growthGateOpen) reason = 'deferred_growth'
  else if (!cooldownGateOpen) reason = 'deferred_cooldown'
  else reason = 'deferred_economic'

  return {
    writeTokens,
    archiveTokens,
    memoTokens,
    contextTokens,
    completedBoundaryRequestCounts: horizon === null ? null : horizon.completedBoundaryRequestCounts,
    requestsPerBoundaryMean: horizon === null ? null : horizon.requestsPerBoundaryMean,
    requestsPerBoundaryLowerBound: horizon === null ? null : horizon.requestsPerBoundaryLowerBound,
    unboundedExpectedRemainingRequests: horizon === null ? null : horizon.unboundedExpectedRemainingRequests,
    averageContextTokenIncrement,
    windowRequestUpperBound: horizon === null ? null : horizon.windowRequestUpperBound,
    expectedRemainingRequests: horizon === null ? null : horizon.expectedRemainingRequests,
    breakevenRequests,
    combinedBreakevenRequests,
    effectiveHorizonRequests,
    cacheWriteReadRatio,
    incrementalCacheCostRatio,
    priorCompactionCount,
    carriedDebtTokens,
    cacheDebtRepaymentTokens,
    minContextGrowthTokens,
    minRequestsSinceCompaction,
    requestsSinceCompaction,
    lastCompactionContextTokens,
    growthGateOpen,
    cooldownGateOpen,
    compact,
    reason,
  }
}

/**
 * Summarize cache behavior from per-request usage samples.
 * Usage counts are disjoint: `inputTokens` is uncached input,
 * `cacheReadTokens` is cache-hit input, and `cacheWriteTokens` is newly written
 * cache input. Prompt size is their sum.
 */
export function summarizeCacheUsage(samples) {
  const rows = Array.isArray(samples) ? samples : []
  let input = 0
  let cacheRead = 0
  let cacheWrite = 0
  let output = 0
  let requests = 0
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    input += finiteOr(row.inputTokens, 0)
    cacheRead += finiteOr(row.cacheReadTokens, 0)
    cacheWrite += finiteOr(row.cacheWriteTokens, 0)
    output += finiteOr(row.outputTokens, 0)
    requests += 1
  }
  const prompt = input + cacheRead + cacheWrite
  return {
    requests,
    inputTokens: input,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
    promptTokens: prompt,
    cacheReadShare: prompt > 0 ? cacheRead / prompt : null,
    cacheWriteShare: prompt > 0 ? cacheWrite / prompt : null,
  }
}
