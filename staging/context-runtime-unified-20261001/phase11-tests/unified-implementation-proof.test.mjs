import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { controlPlaneFor, readControlPlaneSnapshot, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { createPlanRegistry } from '../home/profiles/web/plugins/team-v15-plan-registry.mjs'
import { collectDeliveryContext } from '../home/profiles/web/plugins/team-v15-delivery-source.mjs'
import { createImplementationProofProducer } from '../home/profiles/web/plugins/team-v15-implementation-proof.mjs'

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'implementation-proof-'))
  t.after(() => { resetControlPlaneCache(); rmSync(root, { recursive: true, force: true }) })
  const ref = (name, text) => { const path = join(root, name); writeFileSync(path, text); return { path, sha256: createHash('sha256').update(text).digest('hex') } }
  const file = ref('source.mjs', 'export const implemented = true\n')
  const source = { kind: 'dsh-plan-contract', version: 1, planId: 'p', scope: ['source.mjs'],
    items: [{ requirementId: 'r', taskRefs: [{ boardId: 'global', taskId: 't' }], implementationRefs: ['impl'] }] }
  const planRef = ref('plan.json', JSON.stringify(source, null, 2))
  const control = controlPlaneFor('proof-team', { directory: join(root, 'control') })
  const readDurable = () => readControlPlaneSnapshot(control.file)
  const registry = createPlanRegistry({ control, readDurable, authorize: () => true, allowedRoots: [root] })
  await control.mutateHot('fixture/tasks', {}, null, state => {
    state.boards = { global: { tasks: { t: { id: 't', revision: 1, ownerName: 'alice', contract: { contractRevision: 2, writeScopes: ['source.mjs'] } } } } }
    state.leases.l = { member: 'alice', taskId: 't', contractRevision: 2, status: 'active', expiresAt: 100 }
  }, { deferMs: 0 })
  const registered = await registry.register({ planId: 'p', ref: planRef, expectedPlanRevision: 0 })
  const policy = { workspaceRoot: root, allowedRoots: [root], environmentRefs: [ref('env.json', '{}')], recipeRef: ref('recipe.json', '{}'),
    collectAuthorityDebt: () => ({ unresolvedDebt: [], blockers: [] }) }
  const collectContext = (state, plan) => collectDeliveryContext(state, plan, policy)
  const producer = createImplementationProofProducer({ control, readDurable, collectContext, verifyPlan: plan => registry.verify(plan), authorize: () => true, now: () => 10 })
  const request = { planId: 'p', expectedPlanRevision: 1, expectedPlanHash: registered.plan.planHash,
    requirementId: 'r', boardId: 'global', taskId: 't', expectedTaskRevision: 1, expectedContractRevision: 2, proofRef: 'impl', locator: 'source.mjs' }
  return { root, file, planRef, producer, request, control, readDurable }
}

test('server source scan writes exact implementation and live authority proofs with independent durable readback', async t => {
  const f = await fixture(t), result = await f.producer.prove(f.request)
  const disk = f.readDurable()
  assert.equal(result.durable, true)
  assert.equal(result.proof.artifactHash, f.file.sha256)
  assert.deepEqual(disk.v12Evidence.records.impl, result.proof)
  assert.deepEqual(disk.deliveryAuthorityReceipts[result.authority.id], result.authority)
  assert.equal(result.proof.verificationScope, 'physical-source-presence-not-test-or-business-acceptance')
  assert.equal(result.authority.leaseRef, 'l')
  assert.equal(result.proof.environmentFingerprint.length, 64)
  assert.equal(result.proof.recipeFingerprint.length, 64)
})

test('caller passed fields, foreign slots, stale contracts and expired leases cannot manufacture proof', async t => {
  const f = await fixture(t)
  await assert.rejects(f.producer.prove({ ...f.request, status: 'passed' }), { code: 'IMPLEMENTATION_PROOF_INPUT_INVALID' })
  await assert.rejects(f.producer.prove({ ...f.request, proofRef: 'test' }), { code: 'IMPLEMENTATION_SLOT_DENIED' })
  await assert.rejects(f.producer.prove({ ...f.request, expectedContractRevision: 1 }), { code: 'DELIVERY_CAS_CONFLICT' })
  await f.control.mutateHot('fixture/lease-expired', {}, null, state => { state.leases.l.expiresAt = 9 }, { deferMs: 0 })
  await assert.rejects(f.producer.prove(f.request), { code: 'IMPLEMENTATION_AUTHORITY_UNVERIFIED' })
  assert.equal(f.readDurable().v12Evidence.records.impl, undefined)
})

test('source outside current task write scope and stale plan bytes are rejected without proof', async t => {
  const f = await fixture(t)
  await f.control.mutateHot('fixture/scope', {}, null, state => { state.boards.global.tasks.t.contract.writeScopes = ['other'] }, { deferMs: 0 })
  await assert.rejects(f.producer.prove(f.request), { code: 'IMPLEMENTATION_SOURCE_SCOPE_DENIED' })
  assert.equal(f.readDurable().v12Evidence.records.impl, undefined)
  writeFileSync(f.planRef.path, 'changed source plan')
  await assert.rejects(f.producer.prove(f.request), { code: 'RECOVERY_SOURCE_HASH_MISMATCH' })
})
