import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { evaluateTimeline, resetShadowCaches } from '../home/profiles/web/plugins/team-v13-compaction-shadow.mjs'
import { COMPACTION_PRESSURE_RATIO, shouldCompact } from '../home/profiles/web/plugins/team-milestone-v2.mjs'

function timeline() {
  return {
    requests: Array.from({ length: 10 }, (_, index) => ({
      seq: index + 1,
      promptTokens: 100000 + index * 12000,
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 90000 + index * 12000,
      cacheWriteTokens: 9000,
    })),
    boundaries: [{ seq: 3 }, { seq: 6 }, { seq: 9 }],
    compactions: [],
  }
}

const config = {
  windowTokens: 1_000_000,
  writeTokens: 8000,
  memoTokens: 2000,
  cacheWriteReadRatio: 12.5,
  minContextGrowthTokens: 0,
  minRequestsSinceCompaction: 0,
  telemetryDir: '',
}

test('shadow economics emits a compact decision without touching the session', () => {
  resetShadowCaches()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v13-shadow-'))
  try {
    const result = evaluateTimeline('session-test', timeline(), { ...config, telemetryDir: dir }, 200000)
    assert.equal(result.decision.compact, true)
    assert.equal(result.decision.reason, 'economic')
    assert.equal(result.recorded, true)
    const telemetry = JSON.parse(readFileSync(join(dir, 'mechanism-telemetry-compaction-economics.json'), 'utf8'))
    assert.equal(telemetry.kinds.would_compact, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('identical idle evaluations do not inflate telemetry counters', () => {
  resetShadowCaches()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v13-shadow-'))
  try {
    const first = evaluateTimeline('session-dedupe', timeline(), { ...config, telemetryDir: dir }, 200000)
    const second = evaluateTimeline('session-dedupe', timeline(), { ...config, telemetryDir: dir }, 200000)
    assert.equal(first.recorded, true)
    assert.equal(second.recorded, false)
    const telemetry = JSON.parse(readFileSync(join(dir, 'mechanism-telemetry-compaction-economics.json'), 'utf8'))
    assert.equal(telemetry.events, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('missing cache ratio defers rather than guessing', () => {
  resetShadowCaches()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v13-shadow-'))
  try {
    const result = evaluateTimeline('session-no-ratio', timeline(), {
      ...config,
      telemetryDir: dir,
      cacheWriteReadRatio: null,
    }, 200000)
    assert.equal(result.decision.compact, false)
    assert.equal(result.decision.reason, 'cache_ratio_unavailable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pressure-assisted compaction exposes pressure and the measured ratio', () => {
  const verdict = shouldCompact(undefined, COMPACTION_PRESSURE_RATIO, COMPACTION_PRESSURE_RATIO)
  assert.equal(verdict.yes, true)
  assert.equal(verdict.reason, 'pressure')
  assert.equal(verdict.ratio, COMPACTION_PRESSURE_RATIO)
})
