/**
 * Pure mechanism-level cost attribution for v13 telemetry and A/B reports.
 *
 * The runtime writes measured counters into each mechanism's telemetry file.
 * This module turns those counters into comparable rows and computes the
 * before/after delta without pretending that a cheaper estimate is a measured
 * provider bill.
 *
 * @module team-v13-cost-attribution
 */

const METRIC_KEYS = Object.freeze([
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'savedTokens',
  'overheadTokens',
  'toolMs',
  'waitMs',
  'modelTurns',
  'toolCalls',
  'passed',
  'failed',
  'timeout',
  'qualityPassed',
  'qualityFailed',
])

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizedMetrics(value) {
  const row = value !== null && typeof value === 'object' ? value : {}
  return Object.fromEntries(METRIC_KEYS.map((key) => [key, number(row[key])]))
}

/** Return one compact row per mechanism. */
export function summarizeMechanismCost(telemetryRows, options = {}) {
  const dormantThreshold = Number.isFinite(options.dormantSessions) ? options.dormantSessions : 5
  return (Array.isArray(telemetryRows) ? telemetryRows : [])
    .map((row) => {
      const metrics = normalizedMetrics(row?.metrics)
      const totalTokens = metrics.inputTokens + metrics.outputTokens + metrics.cacheReadTokens + metrics.cacheWriteTokens
      return {
        name: String(row?.name ?? 'unknown'),
        enabled: row?.enabled === true,
        fired: number(row?.fired),
        events: number(row?.events),
        lastFiredAt: row?.lastFiredAt ?? null,
        totalTokens,
        netSavedTokens: metrics.savedTokens - metrics.overheadTokens,
        metrics,
        skipped: row?.skipped ?? {},
        dormantSessions: number(row?.dormantSessions),
        dormant: number(row?.fired) === 0 || number(row?.dormantSessions) >= dormantThreshold,
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

function normalizedRun(run) {
  const metrics = normalizedMetrics(run?.metrics)
  const quality = run?.quality ?? {}
  return {
    id: String(run?.id ?? 'run'),
    metrics,
    qualityPassed: number(quality.passed ?? run?.qualityPassed ?? metrics.qualityPassed),
    qualityFailed: number(quality.failed ?? run?.qualityFailed ?? metrics.qualityFailed),
    fixtureVersion: run?.fixtureVersion ?? null,
    commitSha: run?.commitSha ?? null,
    model: run?.model ?? null,
  }
}

/**
 * Compare two measured runs. `qualityRegression` is the only gate exposed here;
 * token/cost improvements never override a quality regression.
 */
export function compareMechanismRuns(before, after) {
  const left = normalizedRun(before)
  const right = normalizedRun(after)
  const metrics = {}
  for (const key of METRIC_KEYS) {
    metrics[key] = right.metrics[key] - left.metrics[key]
  }
  const beforeTotal = left.metrics.inputTokens + left.metrics.outputTokens
    + left.metrics.cacheReadTokens + left.metrics.cacheWriteTokens
  const afterTotal = right.metrics.inputTokens + right.metrics.outputTokens
    + right.metrics.cacheReadTokens + right.metrics.cacheWriteTokens
  const qualityRegression = right.qualityFailed > left.qualityFailed
    || right.qualityPassed < left.qualityPassed
  return {
    before: { ...left, totalTokens: beforeTotal },
    after: { ...right, totalTokens: afterTotal },
    delta: {
      totalTokens: afterTotal - beforeTotal,
      netSavedTokens: metrics.savedTokens - metrics.overheadTokens,
      toolMs: metrics.toolMs,
      waitMs: metrics.waitMs,
      modelTurns: metrics.modelTurns,
      toolCalls: metrics.toolCalls,
    },
    metrics,
    qualityRegression,
    verdict: qualityRegression
      ? 'reject-quality-regression'
      : afterTotal <= beforeTotal
        ? 'keep'
        : 'reject-cost-regression',
  }
}

/** Format a report suitable for a v12 evidence record. */
export function buildCostAttributionReport({
  telemetryRows = [],
  before,
  after,
  now = Date.now(),
  dormantSessions = 5,
  sourceHash = null,
  config = null,
  model = null,
  fixtureVersion = null,
} = {}) {
  const rows = summarizeMechanismCost(telemetryRows, { dormantSessions })
  const comparison = before === undefined || after === undefined ? null : compareMechanismRuns(before, after)
  return {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    binding: {
      sourceHash,
      config,
      model,
      fixtureVersion,
    },
    mechanisms: rows,
    comparison,
    policy: 'quality-first; dormant mechanisms contribute no benefit',
  }
}
