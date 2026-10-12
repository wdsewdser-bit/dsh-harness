import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCostAttributionReport,
  compareMechanismRuns,
  summarizeMechanismCost,
} from '../home/profiles/web/plugins/team-v13-cost-attribution.mjs'

test('cost attribution reports token and quality deltas without hiding regressions', () => {
  const comparison = compareMechanismRuns(
    {
      id: 'before',
      metrics: { inputTokens: 1000, outputTokens: 100, savedTokens: 0, qualityPassed: 2 },
      quality: { passed: 2, failed: 0 },
    },
    {
      id: 'after',
      metrics: { inputTokens: 400, outputTokens: 80, savedTokens: 520, qualityPassed: 2 },
      quality: { passed: 2, failed: 0 },
    },
  )
  assert.equal(comparison.verdict, 'keep')
  assert.equal(comparison.delta.totalTokens, -620)
  assert.equal(comparison.qualityRegression, false)
})

test('a mechanism with five dormant sessions is excluded from benefit claims', () => {
  const rows = summarizeMechanismCost([{
    name: 'observation-pack',
    enabled: true,
    fired: 0,
    events: 3,
    dormantSessions: 5,
    metrics: { savedTokens: 100 },
  }])
  assert.equal(rows[0].dormant, true)
  const report = buildCostAttributionReport({
    telemetryRows: [{
      name: 'observation-pack',
      enabled: true,
      fired: 0,
      dormantSessions: 5,
      metrics: { savedTokens: 100 },
    }],
    sourceHash: 'sha256:fixture',
    model: 'offline-fixture',
    fixtureVersion: 'v13-mechanism-ab',
  })
  assert.equal(report.binding.sourceHash, 'sha256:fixture')
  assert.equal(report.binding.model, 'offline-fixture')
  assert.equal(report.mechanisms[0].dormant, true)
})
