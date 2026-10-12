import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readRuntimeDeliveryMilestones } from '../home/profiles/web/plugins/team-v15-delivery-debt.mjs'

test('runtime-owned configured writer path must match the strict delivery source, not any clean alternate file', t => {
  const root = mkdtempSync(join(tmpdir(), 'milestone-source-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'actual.json'), alternate = join(root, 'clean.json')
  for (const file of [path, alternate]) writeFileSync(file, JSON.stringify({ version: 3, teams: {} }))
  const options = { allowedRoots: [root] }
  const facts = { pid: process.pid, instanceId: 'current-runtime', moduleHash: 'a'.repeat(64), loaded: true,
    configuredPath: path, physicalPath: realpathSync(path) }
  const service = { runtimeFacts: () => facts }
  assert.equal(readRuntimeDeliveryMilestones(path, service, options).runtimeIdentity.instanceId, 'current-runtime')
  assert.throws(() => readRuntimeDeliveryMilestones(alternate, service, options), { code: 'DELIVERY_MILESTONE_RUNTIME_UNVERIFIED' })
  assert.throws(() => readRuntimeDeliveryMilestones(path, undefined, options), { code: 'DELIVERY_MILESTONE_RUNTIME_UNAVAILABLE' })
  facts.loaded = false
  assert.throws(() => readRuntimeDeliveryMilestones(path, service, options), { code: 'DELIVERY_MILESTONE_RUNTIME_UNVERIFIED' })
  facts.loaded = true; facts.configuredPath = alternate
  assert.throws(() => readRuntimeDeliveryMilestones(path, service, options), { code: 'DELIVERY_MILESTONE_RUNTIME_MISMATCH' })
})
