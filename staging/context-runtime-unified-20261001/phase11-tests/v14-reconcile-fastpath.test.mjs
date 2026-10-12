import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  controlPlaneFor,
  reconcileHasWork,
  resetControlPlaneCache,
} from '../home/profiles/web/plugins/team-control-plane.mjs'

test('idle dispatch reconciliation stays read-only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-reconcile-fastpath-'))
  try {
    resetControlPlaneCache()
    const cp = controlPlaneFor('reconcile-fastpath', { directory: dir })
    await cp.mutate('fixture/seed', {}, null, state => {
      state.counters.activeSlots = 1
    }, { deferMs: 0 })
    await cp.flush()

    const before = cp.snapshot().revision
    const result = await cp.reconcileDispatches({
      deliveryTimeoutMs: 60_000,
      runTimeoutMs: 60_000,
      maxAttempts: 3,
    })

    assert.deepEqual(result.changes, [])
    assert.equal(cp.snapshot().revision, before)
  } finally {
    resetControlPlaneCache()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reconcile work detection mirrors due leases and dispatches', () => {
  assert.equal(reconcileHasWork({
    leases: { active: { status: 'active', expiresAt: 20_000 } },
    privilegeRequests: {},
    dispatches: {},
  }, { runTimeoutMs: 1_000 }, 10_000), false)

  assert.equal(reconcileHasWork({
    leases: { due: { status: 'active', expiresAt: 9_999 } },
    privilegeRequests: {},
    dispatches: {},
  }, { runTimeoutMs: 1_000 }, 10_000), true)

  assert.equal(reconcileHasWork({
    leases: {},
    privilegeRequests: {},
    dispatches: {
      quiet: { status: 'queued', wakeup: false, createdAt: 10_000 },
    },
  }, { deliveryTimeoutMs: 60_000 }, 10_001), true)
})
