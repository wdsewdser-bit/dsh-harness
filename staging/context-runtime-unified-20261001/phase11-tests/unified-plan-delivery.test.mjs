import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePlan, registerPlan, evaluatePlanDelivery, commitPlanDelivery } from '../home/profiles/web/plugins/team-v15-plan-delivery.mjs'

const now = { now: 10 }
const scope = ['src']
const sourceIdentity = { manifestHash: 'a'.repeat(64) }
function fixture(count = 1, proven = count) {
  const input = { planId: 'plan-1', expectedPlanRevision: 0,
    ref: { path: 'D:/plans/full-plan.md', sha256: 'b'.repeat(64) }, scope,
    items: Array.from({ length: count }, (_, index) => ({ requirementId: 'r-' + index,
      taskRefs: [{ boardId: 'main', taskId: 't-' + index }], mandatory: true,
      implementationRefs: ['implementation-' + index], testEvidenceRefs: ['test-' + index],
      acceptanceEvidenceRefs: ['acceptance-' + index], enablementReceiptRefs: ['deployment-' + index] })) }
  const normalized = normalizePlan(input, { planRevision: 1 })
  const doc = { boards: { main: { tasks: {} } }, leases: {}, evidence: {}, v12Evidence: { records: {} },
    deploymentReceipts: {}, runtimeReceipts: {}, deliveryAuthorityReceipts: {},
    planRefReceipts: { ref1: { id: 'ref1', kind: 'plan-ref-readback', status: 'passed', ref: normalized.ref, planHash: normalized.planHash } },
    v15DeliveryContext: { revision: 1, sourceIdentity, scope,
      environmentFingerprint: 'env-1', recipeFingerprint: 'recipe-1', unresolvedDebt: [], blockers: [] } }
  assert.equal(registerPlan(doc, input, now).ok, true)
  for (let index = 0; index < count; index++) {
    doc.boards.main.tasks['t-' + index] = { id: 't-' + index, ownerName: 'worker', revision: 4,
      contract: { contractRevision: 3 }, status: 'completed' }
    doc.leases['lease-' + index] = { runId: 'lease-' + index, status: 'active', member: 'worker',
      taskId: 't-' + index, contractRevision: 3, expiresAt: 100 }
    const base = { status: 'passed', planId: 'plan-1', planRevision: 1, planHash: normalized.planHash,
      requirementId: 'r-' + index, scope, sourceIdentity, environmentFingerprint: 'env-1', recipeFingerprint: 'recipe-1',
      boardId: 'main', taskId: 't-' + index, taskRevision: 4, contractRevision: 3 }
    doc.deliveryAuthorityReceipts['authority-' + index] = { ...base, id: 'authority-' + index, kind: 'delivery-authority',
      leaseRef: 'lease-' + index, owner: 'worker', expiresAt: 100 }
    if (index >= proven) continue
    for (const kind of ['implementation', 'test', 'acceptance']) {
      const id = kind + '-' + index
      doc.v12Evidence.records[id] = { ...base, id, kind, locator: 'src/result-' + index + '.mjs', artifactHash: 'artifact-' + index }
    }
    doc.deploymentReceipts['deployment-' + index] = { ...base, id: 'deployment-' + index, kind: 'deployment',
      entrypoint: 'http://local/task/' + index, loadedHash: 'artifact-' + index, runtimeReceiptRef: 'runtime-' + index }
    doc.runtimeReceipts['runtime-' + index] = { ...base, id: 'runtime-' + index, kind: 'runtime-load',
      entrypoint: 'http://local/task/' + index, loadedHash: 'artifact-' + index }
  }
  return { doc, input }
}
const evaluate = (doc, options = now) => evaluatePlanDelivery(doc, 'plan-1', options)
function request(preview, key = 'delivery-1') {
  return { planId: preview.planId, expectedPlanRevision: preview.planRevision, expectedPlanHash: preview.planHash,
    sourceIdentity: preview.sourceIdentity, coverageMatrixHash: preview.coverageMatrixHash,
    sourceRevisionVector: preview.sourceRevisionVector, idempotencyKey: key }
}
function reregister(doc, input) {
  const plan = normalizePlan(input, { planRevision: input.expectedPlanRevision + 1 })
  doc.planRefReceipts['ref-next'] = { id: 'ref-next', status: 'passed', kind: 'plan-ref-readback', ref: plan.ref, planHash: plan.planHash }
  return registerPlan(doc, input, now)
}

test('ten requirements with six proven cannot complete; preview reports accurate partial scope without writes', () => {
  const { doc } = fixture(10, 6)
  const before = structuredClone(doc)
  const preview = evaluate(doc)
  assert.equal(preview.complete, false)
  assert.equal(preview.status, 'partial')
  assert.deepEqual(preview.deliveredScope, ['r-0', 'r-1', 'r-2', 'r-3', 'r-4', 'r-5'])
  assert.deepEqual(preview.remainingScope, ['r-6', 'r-7', 'r-8', 'r-9'])
  assert.equal(commitPlanDelivery(doc, request(preview), now).code, 'DELIVERY_INCOMPLETE')
  assert.deepEqual(doc, before)
})

test('missing tasks, implemented but untested, tested but not enabled, and old packets stay uncovered', () => {
  const cases = [
    (doc) => { delete doc.boards.main.tasks['t-0'] },
    (doc) => { delete doc.v12Evidence.records['test-0'] },
    (doc) => { delete doc.deploymentReceipts['deployment-0'] },
    (doc) => { doc.packets = { integrated: { status: 'integrated', implemented: true, tested: true, enabled: true, accepted: true } }; doc.v12Evidence.records = {} },
  ]
  for (const change of cases) {
    const { doc } = fixture(); change(doc)
    assert.equal(evaluate(doc).complete, false)
  }
})

test('task completed, model flags and evidence inserted only into commit input cannot authorize delivery', () => {
  const { doc } = fixture(1, 0)
  doc.boards.main.tasks['t-0'].implemented = true
  const preview = evaluate(doc)
  const accepted = commitPlanDelivery(doc, { ...request(preview), goalComplete: true, implemented: true, evidence: fixture().doc.v12Evidence.records }, now)
  assert.equal(accepted.code, 'DELIVERY_INCOMPLETE')
  assert.equal(Object.keys(doc.v15PlanDelivery.receipts).length, 0)
})

test('complete delivery validates a bound receipt and queues exactly one outbox event; replay is idempotent', () => {
  const { doc } = fixture(10)
  const preview = evaluate(doc)
  assert.equal(preview.complete, true)
  const first = commitPlanDelivery(doc, request(preview), now)
  assert.equal(first.ok, true)
  assert.equal(first.receipt.status, 'validated')
  assert.equal(first.receipt.runtimeReceiptRefs.length, 10)
  const second = commitPlanDelivery(doc, request(preview), { now: 11 })
  assert.equal(second.ok, true)
  assert.equal(second.replayed, true)
  assert.deepEqual(second.receipt, first.receipt)
  assert.equal(Object.keys(doc.v15PlanDelivery.receipts).length, 1)
  assert.equal(Object.keys(doc.v15PlanDelivery.outbox).length, 1)
  assert.equal(Object.values(doc.v15PlanDelivery.outbox)[0].status, 'queued')
  assert.equal(doc.goalComplete, undefined)
})

test('plan/tree/contract/task/evidence/runtime/lease/debt changes after preview conflict before any write', () => {
  const changes = [
    (doc, input) => { assert.equal(reregister(doc, { ...input, expectedPlanRevision: 1, ref: { ...input.ref, sha256: 'c'.repeat(64) } }).ok, true) },
    (doc) => { doc.v15DeliveryContext.sourceIdentity = { manifestHash: 'changed-tree' } },
    (doc) => { doc.boards.main.tasks['t-0'].contract.contractRevision++ },
    (doc) => { doc.boards.main.tasks['t-0'].revision++ },
    (doc) => { doc.v12Evidence.records['test-0'].status = 'stale' },
    (doc) => { doc.runtimeReceipts['runtime-0'].loadedHash = 'other' },
    (doc) => { doc.leases['lease-0'].status = 'expired' },
    (doc) => { doc.v15DeliveryContext.unresolvedDebt.push('required-context') },
  ]
  for (const change of changes) {
    const { doc, input } = fixture()
    const preview = evaluate(doc); change(doc, input)
    const before = structuredClone(doc)
    assert.equal(commitPlanDelivery(doc, request(preview), now).code, 'DELIVERY_CAS_CONFLICT')
    assert.deepEqual(doc, before)
  }
})

test('missing commit bindings name exact required fields without weakening current-vector CAS', () => {
  for (const field of ['sourceIdentity', 'sourceRevisionVector', 'coverageMatrixHash']) {
    const { doc } = fixture(), preview = evaluate(doc), input = request(preview)
    delete input[field]
    input.expectedSourceRevisionVector = preview.sourceRevisionVector
    input.previewToken = 'server-preview-token-is-not-a-normal-commit-binding'
    const before = structuredClone(doc), result = commitPlanDelivery(doc, input, now)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'DELIVERY_CAS_CONFLICT')
    assert.match(result.detail, new RegExp('Missing current commit bindings:.*' + field))
    assert.match(result.detail, /sourceRevisionVector.*not expectedSourceRevisionVector/)
    assert.deepEqual(doc, before)
    const accepted = commitPlanDelivery(doc, request(evaluate(doc)), now)
    assert.equal(accepted.ok, true)
    assert.equal(accepted.receipt.status, 'validated')
  }
})

test('well-formed stale commit retains state-change conflict and never suggests missing fields', () => {
  const { doc } = fixture(), preview = evaluate(doc), input = request(preview)
  input.sourceRevisionVector.contextHash = 'stale-context'
  const before = structuredClone(doc), result = commitPlanDelivery(doc, input, now)
  assert.equal(result.code, 'DELIVERY_CAS_CONFLICT')
  assert.equal(result.detail, 'plan, source or coverage changed since preview')
  assert.deepEqual(doc, before)
})

test('old, wrong-scope or mismatched evidence cannot provide any current-plan coverage', () => {
  for (const field of ['planId', 'planRevision', 'planHash', 'requirementId', 'boardId', 'taskId', 'taskRevision', 'contractRevision',
    'scope', 'sourceIdentity', 'environmentFingerprint', 'recipeFingerprint']) {
    const { doc } = fixture()
    doc.v12Evidence.records['test-0'][field] = 'wrong'
    assert.equal(evaluate(doc).complete, false, field)
  }
})

test('actual entrypoint/load receipt and artifact hash are mandatory enablement facts', () => {
  for (const mutate of [
    (doc) => { delete doc.runtimeReceipts['runtime-0'] },
    (doc) => { doc.deploymentReceipts['deployment-0'].entrypoint = '' },
    (doc) => { doc.deploymentReceipts['deployment-0'].loadedHash = 'other' },
    (doc) => { doc.runtimeReceipts['runtime-0'].environmentFingerprint = 'production' },
  ]) { const { doc } = fixture(); mutate(doc); assert.equal(evaluate(doc).complete, false) }
})

test('mandatory deletion, optionalization, conditionalization, dimension removal and task remapping require exact authorization', () => {
  const updates = [
    (input) => { input.items.pop() },
    (input) => { input.items[0].mandatory = false },
    (input) => { input.items[0].conditional = { trigger: 'never' } },
    (input) => { input.items[0].requiredDimensions = ['implemented'] },
    (input) => { input.items[0].taskRefs = [{ boardId: 'main', taskId: 't-1' }] },
    (input) => { input.scope = ['other'] },
  ]
  for (const update of updates) {
    const { doc, input } = fixture(2); const next = { ...structuredClone(input), expectedPlanRevision: 1 }; update(next)
    assert.equal(reregister(doc, next).code, 'PLAN_SCOPE_CHANGE_UNAUTHORIZED')
    assert.equal(doc.v15PlanDelivery.plans['plan-1'].items.length, 2)
  }
  const { doc, input } = fixture(2)
  const previous = doc.v15PlanDelivery.plans['plan-1']
  const next = { ...input, expectedPlanRevision: 1, items: [input.items[0]], scopeChangeAuthorizationRef: 'scope-auth' }
  const normalized = normalizePlan(next, { planRevision: 2 })
  doc.planScopeAuthorizations = { 'scope-auth': { id: 'scope-auth', kind: 'plan-scope-change', status: 'passed', planId: 'plan-1',
    fromPlanRevision: 1, fromPlanHash: previous.planHash, toPlanHash: normalized.planHash,
    weakenedRequirements: ['r-1'], reason: 'User approved reduced scope', authorizationRef: { path: 'D:/user-request.md', sha256: 'd'.repeat(64) } } }
  assert.equal(reregister(doc, next).ok, true)
  assert.equal(doc.v15PlanDelivery.plans['plan-1'].planRevision, 2)
})

test('file readback alone cannot certify an incomplete registration contract', () => {
  const { doc, input } = fixture(2)
  const fresh = { ...doc, v15PlanDelivery: undefined }
  assert.equal(registerPlan(fresh, { ...input, items: [input.items[0]] }, now).code, 'PLAN_REF_UNVERIFIED')
  assert.equal(registerPlan(doc, { ...input, expectedPlanRevision: 0 }, now).code, 'DELIVERY_CAS_CONFLICT')
  const bad = { ...input, planId: 'bad', items: [{ requirementId: 'r', taskRefs: [] }] }
  assert.equal(registerPlan(doc, bad, now).code, 'PLAN_INVALID')
})

test('missing source identity, environment, recipe, owner lease, debt snapshot or readback fail closed', () => {
  for (const change of [
    (doc) => { delete doc.v15DeliveryContext.sourceIdentity },
    (doc) => { doc.v15DeliveryContext.sourceIdentity = { commitSha: 'commit-without-tree' } },
    (doc) => { delete doc.v15DeliveryContext.environmentFingerprint },
    (doc) => { delete doc.v15DeliveryContext.recipeFingerprint },
    (doc) => { delete doc.v15DeliveryContext.unresolvedDebt },
    (doc) => { doc.deliveryAuthorityReceipts = {} },
    (doc) => { doc.planRefReceipts.ref1.status = 'stale' },
    (doc) => { doc.boards.main.tasks['t-0'].ownerName = 'new-owner' },
  ]) { const { doc } = fixture(); change(doc); assert.equal(evaluate(doc).complete, false) }
  assert.equal(evaluate(fixture().doc, { now: 100 }).complete, false)
  assert.equal(evaluate(fixture().doc, { now: 10, sourceIdentity: { manifestHash: 'wrong' } }).complete, false)
})

test('conditional requirements need explicit current not-applicable authorization and review evidence', () => {
  const { doc, input } = fixture(1, 0)
  const next = { ...input, expectedPlanRevision: 1, items: [{ ...input.items[0], conditional: { trigger: 'long-running-job-needed' }, notApplicableReceiptRef: 'na' }], scopeChangeAuthorizationRef: 'conditional-auth' }
  const normalized = normalizePlan(next, { planRevision: 2 })
  doc.planScopeAuthorizations = { 'conditional-auth': { id: 'conditional-auth', kind: 'plan-scope-change', status: 'passed',
    planId: 'plan-1', fromPlanRevision: 1, fromPlanHash: doc.v15PlanDelivery.plans['plan-1'].planHash,
    toPlanHash: normalized.planHash, weakenedRequirements: ['r-0'], reason: 'User approved explicit condition',
    authorizationRef: { path: 'D:/condition.md', sha256: 'd'.repeat(64) } } }
  assert.equal(reregister(doc, next).ok, true)
  const base = { status: 'passed', planId: 'plan-1', planRevision: 2, planHash: normalized.planHash,
    requirementId: 'r-0', scope, sourceIdentity, environmentFingerprint: 'env-1', recipeFingerprint: 'recipe-1' }
  Object.assign(doc.deliveryAuthorityReceipts['authority-0'], base)
  assert.equal(evaluate(doc).complete, false)
  doc.applicabilityReceipts = { na: { ...base, id: 'na', kind: 'not-applicable', trigger: 'long-running-job-needed', triggered: false,
    reason: 'No qualifying job observed', authorizationRef: 'na-auth', reviewEvidenceRef: 'na-review' } }
  doc.planScopeAuthorizations['na-auth'] = { ...base, id: 'na-auth', kind: 'applicability-authorization',
    trigger: 'long-running-job-needed', triggered: false, authorizationSourceRef: 'user-request:condition' }
  doc.evidence['na-review'] = { ...base, id: 'na-review', kind: 'applicability-review' }
  assert.equal(evaluate(doc).complete, true)
  assert.equal(evaluate(doc).matrix[0].applicability, 'not-applicable')
  assert.equal(evaluate(doc).matrix[0].dimensions.implemented, null)
  delete doc.evidence['na-review']
  assert.equal(evaluate(doc).complete, false)
})

test('mutating a registered plan without revision does not become accepted authority', () => {
  const { doc, input } = fixture(2)
  doc.v15PlanDelivery.plans['plan-1'].items.pop()
  assert.equal(evaluate(doc).complete, false)
  assert.equal(registerPlan(doc, { ...input, expectedPlanRevision: 1 }, now).code, 'PLAN_INVALID')
})

test('conflicting durable evidence mirrors fail closed even if one copy claims passed', () => {
  const { doc } = fixture()
  doc.evidence['test-0'] = { ...doc.v12Evidence.records['test-0'], status: 'stale' }
  assert.equal(evaluate(doc).complete, false)
})

test('an idempotency key cannot be reused for a newer request or revive a stale receipt', () => {
  const { doc } = fixture()
  const original = evaluate(doc)
  assert.equal(commitPlanDelivery(doc, request(original), now).ok, true)
  doc.v15DeliveryContext.revision++
  assert.equal(commitPlanDelivery(doc, request(original), now).code, 'DELIVERY_CAS_CONFLICT')
  const fresh = evaluate(doc)
  assert.equal(fresh.complete, true)
  assert.equal(commitPlanDelivery(doc, request(fresh), now).code, 'DELIVERY_CAS_CONFLICT')
})
