import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cacheMonitorStats,
  rememberCacheAnomaly,
  resetCacheMonitor,
} from '../home/profiles/web/plugins/team-v13-cache-monitor.mjs'

test('cache monitor anomaly fingerprints are bounded and least-recently-used', () => {
  try {
    resetCacheMonitor()
    for (let index = 0; index < 300; index += 1) {
      assert.equal(rememberCacheAnomaly('session-' + String(index), 'fp-' + String(index)), true)
    }
    assert.equal(cacheMonitorStats().lastAnomaly, 256)
    assert.equal(cacheMonitorStats().oldestSession, 'session-44')

    assert.equal(rememberCacheAnomaly('session-44', 'fp-44'), false)
    assert.equal(rememberCacheAnomaly('session-300', 'fp-300'), true)
    assert.equal(cacheMonitorStats().lastAnomaly, 256)
    assert.equal(cacheMonitorStats().oldestSession, 'session-46')
  } finally {
    resetCacheMonitor()
  }
})
