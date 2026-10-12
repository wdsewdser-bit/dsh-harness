import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyProviderFailure } from '../home/profiles/web/plugins/team-runtime-guard.mjs'
import { controlPlaneFor } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { suppressForControlPlane } from '../home/profiles/web/plugins/team-idle-watch-v6.mjs'
import { suppressForControlPlane as suppressActivityDigest } from '../home/profiles/web/plugins/team-activity-digest.mjs'
import { panelHealth } from '../home/profiles/web/plugins/team-operator-v5.mjs'

test('safety refusals are classified separately from permanent auth failures', () => {
  const safety = classifyProviderFailure({
    status: 403,
    error: { message: 'content did not pass safety review: request illegal' },
  })
  assert.equal(safety.safety, true)
  assert.equal(safety.permanent, false)
  assert.equal(safety.category, 'provider-safety')

  const auth = classifyProviderFailure({
    status: 401,
    error: { message: 'invalid api key' },
  })
  assert.equal(auth.safety, undefined)
  assert.equal(auth.permanent, true)
  assert.equal(auth.category, 'provider-auth')
})

test('safety refusal records request evidence and activates a bounded fallback without blocking the provider', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-provider-safety-'))
  try {
    const control = controlPlaneFor('provider-safety-team', { directory: dir })
    const result = await control.providerFailure({
      category: 'provider-safety',
      safety: true,
      summary: 'content did not pass safety review: request illegal',
      member: 'lead',
      requestBytes: 123456,
      requestTokens: 30864,
      contextPack: '[team-context-pack] bounded evidence',
      providerResponse: '403 upstream: request illegal',
      fallbackMs: 60_000,
    }, { name: 'lead' })

    assert.equal(result.deduplicated, false)
    assert.equal(result.failure.safety, true)
    assert.equal(result.failure.requestBytes, 123456)
    assert.equal(result.failure.requestTokens, 30864)
    assert.equal(result.failure.contextPack, '[team-context-pack] bounded evidence')
    assert.equal(control.providerState().status, 'unknown')
    const fallback = control.providerSafety('lead')
    assert.equal(fallback.member, 'lead')
    assert.equal(fallback.requestBytes, 123456)
    assert.equal(fallback.contextPack, '[team-context-pack] bounded evidence')
    assert.ok(fallback.expiresAt > Date.now())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('idle watch prefers lightweight health status and keeps the legacy fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-health-status-'))
  try {
    const control = controlPlaneFor('health-status-team', { directory: dir })
    await control.healthSet({
      status: 'disabled',
      reasons: ['provider failure: test'],
    }, { name: 'lead' })

    const summary = control.healthStatus()
    assert.equal(summary.status, 'disabled')
    assert.deepEqual(summary.reasons, ['provider failure: test'])
    assert.equal('storage' in summary, false)
    assert.equal(suppressForControlPlane(control), true)

    let legacyHealthCalls = 0
    const legacy = {
      providerState: () => ({ status: 'unknown' }),
      health: () => {
        legacyHealthCalls += 1
        return { status: 'disabled', reasons: ['provider failure: legacy'] }
      },
    }
    assert.equal(suppressForControlPlane(legacy), true)
    assert.equal(legacyHealthCalls, 1)

    let activityHealthCalls = 0
    const activityControl = {
      providerState: () => ({ status: 'unknown' }),
      healthStatus: () => ({ status: 'disabled', reasons: ['provider failure: digest'] }),
      health: () => {
        activityHealthCalls += 1
        return { status: 'disabled', reasons: ['provider failure: digest'] }
      },
    }
    assert.equal(suppressActivityDigest(activityControl), true)
    assert.equal(activityHealthCalls, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('operator panel prefers lightweight health status and keeps the legacy fallback', () => {
  let fullHealthCalls = 0
  const current = {
    healthStatus: () => ({ status: 'healthy', reasons: [], updatedAt: 1 }),
    health: () => {
      fullHealthCalls += 1
      return { status: 'healthy', storage: { coldFiles: 1 } }
    },
  }
  assert.deepEqual(panelHealth(current), { status: 'healthy', reasons: [], updatedAt: 1 })
  assert.equal(fullHealthCalls, 0)

  const legacy = {
    health: () => {
      fullHealthCalls += 1
      return { status: 'degraded', reasons: ['legacy'] }
    },
  }
  assert.deepEqual(panelHealth(legacy), { status: 'degraded', reasons: ['legacy'] })
  assert.equal(fullHealthCalls, 1)
  assert.equal(panelHealth({}), null)
})
