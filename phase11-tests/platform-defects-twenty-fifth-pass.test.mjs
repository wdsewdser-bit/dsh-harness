import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  controlPlaneFile,
  controlPlaneFor,
  resetControlPlaneCache,
} from '../home/profiles/web/plugins/team-control-plane.mjs'

const tempDirs = []
afterEach(() => {
  resetControlPlaneCache()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('D-new-16: acquire persists the active lease before returning its receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-d16-durable-lease-'))
  tempDirs.push(root)
  const rootId = 'd16-durable-lease'
  const config = { directory: root }
  const cp = controlPlaneFor(rootId, config)
  const lease = await cp.leaseAcquire({
    member: 'member-a',
    taskId: 'task-a',
    contractRevision: 7,
    expiresAt: Date.now() + 60_000,
  }, {})

  const file = controlPlaneFile(rootId, config)
  assert.equal(existsSync(file), true)
  const durable = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(durable.leases[lease.runId].status, 'active')
  assert.equal(durable.leases[lease.runId].taskId, 'task-a')
  assert.equal(durable.leases[lease.runId].contractRevision, 7)

  resetControlPlaneCache()
  const reloaded = controlPlaneFor(rootId, config)
  assert.equal(reloaded.leaseGet(lease.runId).status, 'active')
  const heartbeat = await reloaded.leaseHeartbeat({
    runId: lease.runId,
    checkpoint: 'post-acquire-proof',
    contractRevision: 7,
  }, {})
  assert.equal(heartbeat.runId, lease.runId)
  assert.equal(heartbeat.checkpoint.value, 'post-acquire-proof')
})
