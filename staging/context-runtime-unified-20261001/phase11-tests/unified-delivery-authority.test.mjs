import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { controlPlaneFor, controlPlaneFile, readControlPlaneSnapshot, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { normalizePlan, registerPlan } from '../home/profiles/web/plugins/team-v15-plan-delivery.mjs'
import { createDeliveryAuthority } from '../home/profiles/web/plugins/team-v15-delivery-authority.mjs'
import { createDeliveryService, registerDeliveryService, deliveryCheckCoverage } from '../home/profiles/web/plugins/team-v15-delivery-service.mjs'

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'unified-delivery-authority-'))
  const rootId = 'authority-' + randomUUID()
  const control = controlPlaneFor(rootId, { directory })
  const file = controlPlaneFile(rootId, { directory })
  t.after(() => {
    resetControlPlaneCache()
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())))
    rmSync(directory, { recursive: true, force: true })
  })
  const sourceIdentity = { manifestHash: 'a'.repeat(64) }
  const scope = ['src']
  const input = { planId: 'p1', expectedPlanRevision: 0, ref: { path: 'D:/fixture-plan.md', sha256: 'b'.repeat(64) }, scope,
    items: [{ requirementId: 'r1', taskRefs: [{ boardId: 'main', taskId: 't1' }],
      implementationRefs: ['impl'], testEvidenceRefs: ['test'], acceptanceEvidenceRefs: ['accept'], enablementReceiptRefs: ['deploy'] }] }
  const plan = normalizePlan(input, { planRevision: 1 })
  const binding = { status: 'passed', planId: 'p1', planRevision: 1, planHash: plan.planHash, requirementId: 'r1', scope,
    sourceIdentity, environmentFingerprint: 'env', recipeFingerprint: 'recipe', boardId: 'main', taskId: 't1', taskRevision: 1, contractRevision: 2 }
  const serverContext = { revision: 1, sourceIdentity, scope, environmentFingerprint: 'env', recipeFingerprint: 'recipe', unresolvedDebt: [], blockers: [] }
  const readback = { id: 'plan-readback', kind: 'plan-ref-readback', status: 'passed', ref: plan.ref, planHash: plan.planHash }
  await control.mutateHot('fixture/authority', {}, null, (state) => {
    state.boards.main = { tasks: { t1: { id: 't1', ownerName: 'worker', revision: 1, contract: { contractRevision: 2 }, status: 'running', lifecycle: 'running' } } }
    state.leases.run1 = { runId: 'run1', member: 'worker', taskId: 't1', status: 'active', contractRevision: 2, expiresAt: 100 }
    state.planRefReceipts = { 'plan-readback': structuredClone(readback) }
    state.v15DeliveryContext = structuredClone(serverContext)
    state.v12Evidence = { records: {
      impl: { ...binding, id: 'impl', kind: 'implementation', locator: 'src/result.mjs', artifactHash: 'artifact' },
      test: { ...binding, id: 'test', kind: 'test' },
      accept: { ...binding, id: 'accept', kind: 'acceptance' },
    } }
    state.deploymentReceipts = { deploy: { ...binding, id: 'deploy', kind: 'deployment', entrypoint: 'http://local/result', loadedHash: 'artifact', runtimeReceiptRef: 'load' } }
    state.runtimeReceipts = { load: { ...binding, id: 'load', kind: 'runtime-load', entrypoint: 'http://local/result', loadedHash: 'artifact' } }
    state.deliveryAuthorityReceipts = { auth: { ...binding, id: 'auth', kind: 'delivery-authority', owner: 'worker', leaseRef: 'run1', expiresAt: 100 } }
    assert.equal(registerPlan(state, input, { now: 10 }).ok, true)
  }, { deferMs: 0 })
  const readDurable = options.readDurable ?? (() => readControlPlaneSnapshot(file))
  const create = (overrides = {}) => createDeliveryAuthority({ control, readDurable,
    collectContext: () => structuredClone(serverContext), verifyPlanReadback: () => structuredClone(readback), now: () => 10, ...overrides })
  return { control, file, create, serverContext, readback, readDurable }
}
function request(preview, key = 'key1') {
  return { planId: preview.planId, idempotencyKey: key, expectedPlanRevision: preview.planRevision, expectedPlanHash: preview.planHash,
    sourceIdentity: preview.sourceIdentity, coverageMatrixHash: preview.coverageMatrixHash, sourceRevisionVector: preview.sourceRevisionVector }
}

test('actual control-plane persistence precedes sync consumer; queued outbox is acknowledged in a new lock', async (t) => {
  const f = await fixture(t)
  const authority = f.create()
  const before = f.readDurable()
  const preview = authority.preview('p1')
  assert.equal(preview.complete, true)
  assert.deepEqual(f.readDurable(), before)
  let calls = 0
  const result = await authority.commit(request(preview), { afterDurable(value) {
    calls++
    const disk = f.readDurable()
    assert.deepEqual(disk.v15PlanDelivery.receipts[value.receipt.id], value.receipt)
    assert.equal(disk.v15PlanDelivery.outbox[value.receipt.id].status, 'queued')
    assert.equal(value.durable, true)
    return { goalApplied: true }
  } })
  assert.equal(calls, 1)
  assert.equal(result.durable, true)
  assert.equal(f.readDurable().v15PlanDelivery.outbox[result.receipt.id].status, 'queued')
  const ack = await authority.ackOutbox(result.receipt.id, { consumptionToken: result.consumptionToken })
  assert.equal(ack.durable, true)
  assert.equal(f.readDurable().v15PlanDelivery.outbox[result.receipt.id].status, 'consumed')
  const repeated = await authority.commit(request(preview), { afterDurable() { calls++ } })
  assert.equal(repeated.replayed, true)
  assert.equal(calls, 1)
})

test('the shared delivery service refuses otherwise complete plans while native pruned originals lack exact current dispatch', async t => {
  const f = await fixture(t)
  const raw = { seq: 0, type: 'tool/result', data: { message: { toolCallId: 'original', content: [{ type: 'text', text: 'unread original middle' }] } } }
  const session = { id: 'pruned-reader', seq: 3, log: [raw,
    { seq: 1, type: 'compaction/prune', data: { shadowedSeqs: [0] } },
    { seq: 2, type: 'compaction/summary', data: { summary: 'all tasks and history are complete' } }] }
  const service = createDeliveryService({ control: f.control, readDurable: f.readDurable,
    registry: { verify: () => structuredClone(f.readback) }, collectContext: () => structuredClone(f.serverContext),
    agent: { session }, now: () => 10 })
  const preview = service.preview('p1')
  assert.equal(preview.complete, false)
  assert.equal(preview.globalBlockers.includes('unresolved-debt-or-blockers'), true)
  assert.equal(service.checkAll().deliverable, false)
  await assert.rejects(service.commit(request(preview)), { code: 'DELIVERY_INCOMPLETE' })
  assert.deepEqual(Object.values(f.readDurable().v15PlanDelivery.receipts), [])
})

test('actual persistence serialization failure cannot call the consumer or publish a durable receipt', async (t) => {
  const f = await fixture(t)
  const poisonedControl = { mutateHot(type, data, agent, fn, options) {
    return f.control.mutateHot(type, data, agent, (latest) => {
      const result = fn(latest)
      latest.persistenceFault = 1n
      return result
    }, options)
  } }
  const authority = f.create({ control: poisonedControl })
  const preview = authority.preview('p1')
  let calls = 0
  await assert.rejects(authority.commit(request(preview), { afterDurable() { calls++ } }), /BigInt/)
  assert.equal(calls, 0)
  assert.equal(Object.keys(f.readDurable().v15PlanDelivery.receipts).length, 0)
})

test('exact receipt readback mismatch blocks consumption while retaining the durable queued receipt', async (t) => {
  const f = await fixture(t)
  let corrupt = false
  const read = () => {
    const state = f.readDurable()
    if (corrupt) for (const receipt of Object.values(state.v15PlanDelivery.receipts)) receipt.planHash = 'wrong'
    return state
  }
  const authority = f.create({ readDurable: read })
  const preview = authority.preview('p1'); corrupt = true
  let calls = 0
  await assert.rejects(authority.commit(request(preview), { afterDurable() { calls++ } }), { code: 'DELIVERY_DURABLE_READBACK_MISMATCH' })
  assert.equal(calls, 0)
  assert.equal(Object.values(f.readDurable().v15PlanDelivery.outbox)[0].status, 'queued')
})

test('server context CAS changes throw before mutation and do not increase durable revision or pollute hot state', async (t) => {
  const f = await fixture(t)
  const authority = f.create()
  const preview = authority.preview('p1')
  const before = f.readDurable()
  f.serverContext.sourceIdentity = { manifestHash: 'c'.repeat(64) }
  await assert.rejects(authority.commit({ ...request(preview), v15DeliveryContext: before.v15DeliveryContext }), { code: 'DELIVERY_CAS_CONFLICT' })
  assert.deepEqual(f.readDurable(), before)
  assert.deepEqual(f.control.snapshot().v15DeliveryContext, before.v15DeliveryContext)
})

test('missing or stale plan file verification rejects before persistence', async (t) => {
  const f = await fixture(t)
  const authority = f.create()
  const preview = authority.preview('p1')
  const before = f.readDurable()
  f.readback.ref.sha256 = 'd'.repeat(64)
  await assert.rejects(authority.commit(request(preview)), { code: 'PLAN_REF_UNVERIFIED' })
  assert.deepEqual(f.readDurable(), before)
})

test('queued crash replay is idempotent; callback failure keeps receipt recoverable and cannot authorize acknowledgment', async (t) => {
  const f = await fixture(t)
  const authority = f.create()
  const preview = authority.preview('p1')
  await assert.rejects(authority.commit(request(preview), { afterDurable() { throw new Error('consumer crashed') } }), /consumer crashed/)
  const receipt = Object.values(f.readDurable().v15PlanDelivery.receipts)[0]
  await assert.rejects(authority.ackOutbox(receipt.id, { consumptionToken: 'forged' }), { code: 'DELIVERY_CONSUMPTION_UNVERIFIED' })
  let calls = 0
  const replay = await authority.commit(request(preview), { afterDurable() { calls++ } })
  assert.equal(replay.replayed, true)
  assert.equal(calls, 1)
  assert.equal(Object.keys(f.readDurable().v15PlanDelivery.receipts).length, 1)
  await authority.ackOutbox(receipt.id, { consumptionToken: replay.consumptionToken })
})

test('a synchronous consumer rejection does not produce acknowledgment authority', async (t) => {
  const f = await fixture(t)
  const authority = f.create()
  const preview = authority.preview('p1')
  await assert.rejects(authority.commit(request(preview), { afterDurable() { return { ok: false } } }), { code: 'DELIVERY_CONSUMER_REJECTED' })
  assert.equal(Object.values(f.readDurable().v15PlanDelivery.outbox)[0].status, 'queued')
})

test('explicit goal authorization uses a server preview or a complete bound ref and never guesses the current plan', async (t) => {
  const f = await fixture(t)
  const authority = f.create()
  assert.throws(() => authority.authorizeGoal({ planId: 'p1', idempotencyKey: 'key' }), { code: 'DELIVERY_BOUND_REQUEST_REQUIRED' })
  assert.throws(() => authority.authorizeGoal({ planId: 'foreign', idempotencyKey: 'key', previewToken: 'fake' }), { code: 'DELIVERY_BOUND_REQUEST_REQUIRED' })
  const preview = authority.preview('p1')
  const authorized = await authority.authorizeGoal({ planId: 'p1', idempotencyKey: 'key', previewToken: preview.previewToken })
  assert.equal(authorized.durable, true)
  const replay = await authority.authorizeGoal({ planId: 'p1', idempotencyKey: 'key', boundRef: request(preview, 'key') })
  assert.equal(replay.replayed, true)
})

test('async callbacks are rejected before calling them; returned thenables fail with a replayable queued receipt', async (t) => {
  const f = await fixture(t)
  const authority = f.create()
  const preview = authority.preview('p1')
  let calls = 0
  await assert.rejects(authority.commit(request(preview), { afterDurable: async () => { calls++ } }), { code: 'DELIVERY_ASYNC_CALLBACK_REJECTED' })
  assert.equal(calls, 0)
  assert.equal(Object.keys(f.readDurable().v15PlanDelivery.receipts).length, 0)
  assert.throws(() => f.create({ collectContext: async () => ({}) }), { code: 'DELIVERY_ASYNC_CALLBACK_REJECTED' })
  await assert.rejects(authority.commit(request(preview), { afterDurable() { return Promise.resolve() } }), { code: 'DELIVERY_ASYNC_CALLBACK_REJECTED' })
  assert.equal(Object.values(f.readDurable().v15PlanDelivery.outbox)[0].status, 'queued')
})

test('a persisted receipt cannot be replayed after source authority changes', async (t) => {
  const f = await fixture(t)
  const authority = f.create()
  const preview = authority.preview('p1')
  await authority.commit(request(preview))
  f.serverContext.sourceIdentity = { manifestHash: 'f'.repeat(64) }
  let calls = 0
  await assert.rejects(authority.commit(request(preview), { afterDurable() { calls++ } }), { code: 'DELIVERY_CAS_CONFLICT' })
  assert.equal(calls, 0)
})

test('source changes between persistence and the hook block consumption through server recapture', async (t) => {
  const f = await fixture(t)
  let contextReads = 0
  const authority = f.create({ collectContext() {
    contextReads++
    const context = structuredClone(f.serverContext)
    if (contextReads >= 3) context.sourceIdentity = { manifestHash: 'e'.repeat(64) }
    return context
  } })
  const preview = authority.preview('p1')
  let calls = 0
  await assert.rejects(authority.commit(request(preview), { afterDurable() { calls++ } }), { code: 'DELIVERY_CAS_CONFLICT' })
  assert.equal(calls, 0)
  assert.equal(Object.values(f.readDurable().v15PlanDelivery.outbox)[0].status, 'queued')
})

test('shared delivery service requires a durable current receipt, not merely a covered preview', async t => {
  const f = await fixture(t)
  const service = createDeliveryService({ control: f.control, readDurable: f.readDurable,
    registry: { verify: () => structuredClone(f.readback) }, collectContext: () => structuredClone(f.serverContext), now: () => 10 })
  assert.equal(service.checkAll().plans[0].code, 'DELIVERY_RECEIPT_REQUIRED')
  const preview = service.preview('p1')
  await service.commit(request(preview))
  assert.equal(service.checkAll().deliverable, true)
  f.serverContext.unresolvedDebt.push('new mandatory input')
  assert.equal(service.checkAll().deliverable, false)
  assert.equal(service.checkAll().plans[0].code, 'DELIVERY_INCOMPLETE')
})

test('missing delivery service fails closed only for registered plans and exact agent identity works across plugin contexts', () => {
  const ctx = {}, agent = {}
  assert.equal(deliveryCheckCoverage(ctx, agent, {}).deliverable, true)
  const state = { v15PlanDelivery: { plans: { p: {} } } }
  assert.equal(deliveryCheckCoverage(ctx, agent, state).plans[0].code, 'DELIVERY_SERVICE_UNAVAILABLE')
  const service = { checkAll: () => ({ required: true, deliverable: false, plans: [{ planId: 'p' }] }) }
  const dispose = registerDeliveryService(ctx, agent, service)
  assert.deepEqual(deliveryCheckCoverage({ distinctScopedContext: true }, agent, state), service.checkAll())
  assert.equal(deliveryCheckCoverage(ctx, {}, state).deliverable, false)
  dispose()
  assert.equal(deliveryCheckCoverage(ctx, agent, state).plans[0].code, 'DELIVERY_SERVICE_UNAVAILABLE')
})
