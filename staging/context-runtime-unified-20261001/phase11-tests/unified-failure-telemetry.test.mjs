import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTelemetry,
  dormantVerdict,
  normalizeTelemetryState,
} from '../home/profiles/web/plugins/team-v13-mechanism-telemetry.mjs'

const failureKinds = ['failure-recorded', 'replan-required', 'repeated-failure-block']

test('failure handling events count as live telemetry firings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unified-failure-telemetry-'))
  try {
    const telemetry = createTelemetry('failure-flow', { dir })
    for (const [index, kind] of failureKinds.entries()) {
      telemetry.event(kind, { sessionId: 'failure-session-' + String(index) })
    }
    const state = telemetry.snapshot()
    assert.equal(state.fired, failureKinds.length)
    assert.deepEqual(Object.fromEntries(failureKinds.map((kind) => [kind, state.kinds[kind]])), {
      'failure-recorded': 1,
      'replan-required': 1,
      'repeated-failure-block': 1,
    })
    assert.notEqual(state.lastFiredAt, null)
    assert.equal(dormantVerdict(state), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('legacy failure kinds migrate without resetting fired and no-trigger state stays dormant', () => {
  const derived = normalizeTelemetryState({
    name: 'legacy-unfired',
    events: 11,
    fired: 0,
    kinds: { 'failure-recorded': 2, 'replan-required': 3, 'repeated-failure-block': 1 },
    metrics: { failed: 4 },
  }, 'legacy-unfired')
  assert.equal(derived.fired, 6)
  assert.deepEqual(derived.kinds, {
    'failure-recorded': 2,
    'replan-required': 3,
    'repeated-failure-block': 1,
  })
  assert.equal(derived.events, 11)
  assert.equal(derived.metrics.failed, 4)
  assert.equal(dormantVerdict(derived), false)

  const migrated = normalizeTelemetryState({
    name: 'legacy',
    fired: 8,
    kinds: { 'failure-recorded': 2, 'replan-required': 3, 'repeated-failure-block': 1 },
    lastEvent: { kind: 'replan-required' },
    lastEventAt: '2026-09-30T12:00:00.000Z',
    customField: { preserved: true },
  }, 'legacy')
  assert.equal(migrated.fired, 8)
  assert.equal(migrated.lastFiredAt, migrated.lastEventAt)
  assert.deepEqual(migrated.customField, { preserved: true })
  assert.equal(dormantVerdict(migrated), false)

  const dormant = normalizeTelemetryState({ name: 'no-trigger', fired: 0, kinds: { skipped: 4 } }, 'no-trigger')
  assert.equal(dormant.fired, 0)
  assert.equal(dormantVerdict(dormant), true)
})

test('cache-hit-drop remains a firing kind for old telemetry migration', () => {
  const migrated = normalizeTelemetryState({
    name: 'cache-drop',
    fired: 0,
    kinds: { 'cache-hit-drop': 4 },
    lastEvent: { kind: 'cache-hit-drop' },
    lastEventAt: '2026-09-30T12:00:00.000Z',
  }, 'cache-drop')
  assert.equal(migrated.fired, 4)
  assert.equal(migrated.lastFiredAt, migrated.lastEventAt)
  assert.equal(dormantVerdict(migrated), false)
})
