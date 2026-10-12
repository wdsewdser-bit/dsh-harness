import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTelemetry,
  normalizeTelemetryState,
} from '../home/profiles/web/plugins/team-v13-mechanism-telemetry.mjs'

test('mechanism telemetry bounds persisted session details', () => {
  const sessions = {}
  for (let index = 0; index < 300; index += 1) {
    sessions['session-' + String(index)] = { events: index + 1 }
  }
  const normalized = normalizeTelemetryState({ name: 'fixture', sessions }, 'fixture')
  const keys = Object.keys(normalized.sessions)
  assert.equal(keys.length, 256)
  assert.equal(keys[0], 'session-44')
  assert.equal(keys.at(-1), 'session-299')

  const root = mkdtempSync(join(tmpdir(), 'v14-telemetry-lru-'))
  try {
    const telemetry = createTelemetry('fixture-live', { dir: root, bufferSkips: 1000 })
    for (let index = 0; index < 300; index += 1) {
      telemetry.skipped('fixture', { sessionId: 'live-' + String(index) })
    }
    const live = telemetry.snapshot()
    assert.equal(Object.keys(live.sessions).length, 256)
    assert.equal(live.sessions['live-0'], undefined)
    assert.equal(live.sessions['live-44'] !== undefined, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
