/** Pure plan/delivery contracts. Call mutations inside the control-plane lock;
 * only the caller can certify filesystem readback, runtime facts and durability. */
import { createHash } from 'node:crypto'

const text = (value) => String(value ?? '').trim()
const list = (value) => Array.isArray(value) ? value : []
const clone = (value) => structuredClone(value)
const DIMENSIONS = ['implemented', 'tested', 'enabled', 'accepted']
function stable(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}'
}
export const planDeliveryHash = (value) => createHash('sha256').update(stable(value)).digest('hex')
const equal = (a, b) => stable(a) === stable(b)
const rows = (store) => Array.isArray(store) ? store : Object.values(store ?? {})
const passed = (row) => row?.status === 'passed' && list(row.staleReasons).length === 0
const fail = (code, detail) => ({ ok: false, code, detail })
function invalid(detail) { throw Object.assign(new Error(detail), { code: 'PLAN_INVALID' }) }
function refs(value) {
  if (!Array.isArray(value) || value.some((ref) => !text(ref))) invalid('proof refs must be arrays of nonempty ids')
  return [...new Set(value.map(text))].sort()
}
function sourceIdentity(value) {
  if (text(value?.commitSha) && text(value?.treeHash)) return { commitSha: text(value.commitSha), treeHash: text(value.treeHash) }
  if (!text(value?.commitSha) && /^[a-f\d]{64}$/i.test(text(value?.manifestHash))) return { manifestHash: text(value.manifestHash).toLowerCase() }
  return null
}
function fileRef(value) {
  if (!text(value?.path) || !/^[a-f\d]{64}$/i.test(text(value?.sha256))) invalid('plan/authorization ref requires path and SHA256')
  return { path: text(value.path), sha256: text(value.sha256).toLowerCase() }
}

export function normalizePlan(input, options = {}) {
  if (!text(input?.planId)) invalid('planId is required')
  const scope = refs(input.scope)
  if (!scope.length) invalid('scope is required')
  const seen = new Set()
  const items = list(input.items).map((item) => {
    const requirementId = text(item.requirementId)
    if (!requirementId || seen.has(requirementId)) invalid('requirement ids must be nonempty and unique')
    seen.add(requirementId)
    const taskRefs = list(item.taskRefs).map((ref) => {
      if (!text(ref.boardId) || !text(ref.taskId)) invalid('task refs require exact boardId and taskId')
      return { boardId: text(ref.boardId), taskId: text(ref.taskId) }
    }).sort((a, b) => stable(a).localeCompare(stable(b)))
    if (!taskRefs.length || new Set(taskRefs.map(stable)).size !== taskRefs.length) invalid('each item requires unique task refs')
    const dimensions = item.requiredDimensions === undefined ? [...DIMENSIONS].sort() : refs(item.requiredDimensions)
    if (!dimensions.length || dimensions.some((dimension) => !DIMENSIONS.includes(dimension))) invalid('required dimensions are invalid')
    const conditional = item.conditional == null ? null : { trigger: text(item.conditional.trigger) }
    if (conditional && !conditional.trigger) invalid('conditional items require an explicit trigger')
    return {
      requirementId, mandatory: item.mandatory !== false, conditional, taskRefs, requiredDimensions: dimensions,
      implementationRefs: refs(item.implementationRefs ?? []), testEvidenceRefs: refs(item.testEvidenceRefs ?? []),
      enablementReceiptRefs: refs(item.enablementReceiptRefs ?? []), acceptanceEvidenceRefs: refs(item.acceptanceEvidenceRefs ?? []),
      notApplicableReceiptRef: text(item.notApplicableReceiptRef) || null,
    }
  }).sort((a, b) => a.requirementId.localeCompare(b.requirementId))
  if (!items.length) invalid('the complete plan must contain items')
  const planRevision = options.planRevision ?? input.planRevision
  if (!Number.isSafeInteger(planRevision) || planRevision < 1) invalid('planRevision must be a positive integer')
  const plan = { planId: text(input.planId), planRevision, ref: fileRef(input.ref), scope, items,
    supplementalRefs: list(input.supplementalRefs).map(fileRef),
    scopeChangeAuthorizationRef: text(input.scopeChangeAuthorizationRef) || null }
  return { ...plan, planHash: planDeliveryHash(plan) }
}

export function registerPlan(doc, input, options = {}) {
  const previous = doc?.v15PlanDelivery?.plans?.[text(input?.planId)]
  if (previous) {
    try {
      if (normalizePlan(previous).planHash !== previous.planHash) return fail('PLAN_INVALID', 'previous registered plan contract was mutated')
    } catch { return fail('PLAN_INVALID', 'previous registered plan contract is invalid') }
  }
  if (!Number.isSafeInteger(input?.expectedPlanRevision) || input.expectedPlanRevision !== (previous?.planRevision ?? 0)) {
    return fail('DELIVERY_CAS_CONFLICT', 'expectedPlanRevision does not match the registered plan')
  }
  let plan
  try { plan = normalizePlan(input, { planRevision: (previous?.planRevision ?? 0) + 1 }) }
  catch (error) { return fail(error.code ?? 'PLAN_INVALID', error.message) }
  const readback = rows(doc.planRefReceipts).find((row) => passed(row) && row.kind === 'plan-ref-readback'
    && equal(row.ref, plan.ref) && row.planHash === plan.planHash)
  if (!readback) return fail('PLAN_REF_UNVERIFIED', 'the server must read back the plan file and record its exact SHA256')
  const weakened = previous ? previous.items.filter((item) => item.mandatory && (() => {
    const next = plan.items.find((row) => row.requirementId === item.requirementId)
    return !next || !next.mandatory || (!item.conditional && next.conditional)
      || !equal(item.conditional, next.conditional)
      || !equal(item.taskRefs, next.taskRefs)
      || item.requiredDimensions.some((dimension) => !next.requiredDimensions.includes(dimension))
  })()).map((item) => item.requirementId).sort() : []
  if (previous && (weakened.length || !equal(previous.scope, plan.scope))) {
    const authorization = rows(doc.planScopeAuthorizations).find((row) => text(row.id) === plan.scopeChangeAuthorizationRef)
    if (!passed(authorization) || authorization.kind !== 'plan-scope-change'
      || authorization.planId !== plan.planId || authorization.fromPlanRevision !== previous.planRevision
      || authorization.fromPlanHash !== previous.planHash || authorization.toPlanHash !== plan.planHash
      || !equal(authorization.weakenedRequirements, weakened) || !text(authorization.reason)) {
      return fail('PLAN_SCOPE_CHANGE_UNAUTHORIZED', 'mandatory scope changes require an exact server authorization receipt')
    }
    try { fileRef(authorization.authorizationRef) } catch { return fail('PLAN_SCOPE_CHANGE_UNAUTHORIZED', 'authorization source is missing') }
  }
  const state = doc.v15PlanDelivery ?? { version: 1, plans: {}, receipts: {}, outbox: {} }
  state.plans ??= {}; state.receipts ??= {}; state.outbox ??= {}
  state.plans[plan.planId] = { ...plan, registeredAt: Number(options.now ?? Date.now()), readbackReceiptId: readback.id }
  doc.v15PlanDelivery = state
  return { ok: true, plan: clone(state.plans[plan.planId]) }
}

function proofStores(doc) {
  return { evidence: [...rows(doc.evidence), ...rows(doc.v12Evidence?.records)],
    deployment: rows(doc.deploymentReceipts), runtime: rows(doc.runtimeReceipts),
    authority: rows(doc.deliveryAuthorityReceipts), applicability: rows(doc.applicabilityReceipts),
    authorization: rows(doc.planScopeAuthorizations) }
}
function exactProof(proof, expected) {
  return passed(proof) && Object.entries(expected).every(([key, value]) => equal(proof[key], value))
}
function activeAuthority(proof, expected, doc, task, now) {
  const lease = doc.leases?.[text(proof?.leaseRef)]
  const owner = text(task?.ownerName ?? task?.owner ?? task?.contract?.owner)
  return exactProof(proof, expected) && proof.kind === 'delivery-authority'
    && Number.isFinite(proof.expiresAt) && proof.expiresAt > now && owner && proof.owner === owner
    && lease?.status === 'active' && Number.isFinite(lease.expiresAt) && lease.expiresAt > now
    && lease.member === owner && lease.taskId === expected.taskId
    && lease.contractRevision === expected.contractRevision
}

export function evaluatePlanDelivery(doc, planId, options = {}) {
  const plan = doc?.v15PlanDelivery?.plans?.[text(planId)]
  if (!plan) return fail('PLAN_NOT_FOUND', 'register the complete plan before evaluating delivery')
  const now = Number(options.now ?? Date.now())
  const context = doc.v15DeliveryContext ?? {}
  const source = sourceIdentity(context.sourceIdentity)
  const stores = proofStores(doc)
  const globalBlockers = []
  const evidenceIds = new Map()
  for (const row of stores.evidence) {
    if (evidenceIds.has(row.id) && !equal(evidenceIds.get(row.id), row)) globalBlockers.push('conflicting-evidence-id:' + row.id)
    evidenceIds.set(row.id, row)
  }
  if (!Number.isFinite(now)) globalBlockers.push('invalid-time')
  if (!source || !Number.isSafeInteger(context.revision) || context.revision < 1) globalBlockers.push('current-source-unverified')
  if (!equal(context.scope, plan.scope)) globalBlockers.push('current-scope-unverified')
  if (!text(context.environmentFingerprint) || !text(context.recipeFingerprint)) globalBlockers.push('current-environment-or-recipe-unverified')
  for (const key of ['sourceIdentity', 'environmentFingerprint', 'recipeFingerprint']) {
    if (options[key] !== undefined && !equal(options[key], context[key])) globalBlockers.push('expected-' + key + '-changed')
  }
  if (!Array.isArray(context.unresolvedDebt) || !Array.isArray(context.blockers)) globalBlockers.push('debt-or-blockers-unverified')
  else if (context.unresolvedDebt.length || context.blockers.length) globalBlockers.push('unresolved-debt-or-blockers')
  const readback = rows(doc.planRefReceipts).find((row) => row.id === plan.readbackReceiptId)
  if (!passed(readback) || !equal(readback.ref, plan.ref) || readback.planHash !== plan.planHash) globalBlockers.push('plan-ref-readback-stale')
  try {
    if (normalizePlan(plan).planHash !== plan.planHash) globalBlockers.push('registered-plan-contract-mutated')
  } catch { globalBlockers.push('registered-plan-contract-invalid') }
  const taskSnapshots = []
  const matrix = plan.items.map((item) => {
    const problems = []
    const dimensions = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, true]))
    const matchedProofIds = []
    const base = { planId: plan.planId, planRevision: plan.planRevision, planHash: plan.planHash,
      requirementId: item.requirementId, scope: plan.scope, sourceIdentity: source,
      environmentFingerprint: context.environmentFingerprint, recipeFingerprint: context.recipeFingerprint }
    let notApplicable = false
    if (item.conditional && item.notApplicableReceiptRef) {
      const receipt = stores.applicability.find((row) => row.id === item.notApplicableReceiptRef)
      const authorization = stores.authorization.find((row) => row.id === receipt?.authorizationRef)
      const review = stores.evidence.find((row) => row.id === receipt?.reviewEvidenceRef)
      notApplicable = exactProof(receipt, base) && receipt.kind === 'not-applicable'
        && receipt.trigger === item.conditional.trigger && receipt.triggered === false && text(receipt.reason)
        && exactProof(authorization, base) && authorization.kind === 'applicability-authorization'
        && authorization.trigger === item.conditional.trigger && authorization.triggered === false
        && text(authorization.authorizationSourceRef)
        && exactProof(review, base) && review.kind === 'applicability-review'
      if (notApplicable) matchedProofIds.push(receipt.id, authorization.id, review.id)
      else problems.push('not-applicable-unverified')
    }
    for (const ref of item.taskRefs) {
      const task = doc.boards?.[ref.boardId]?.tasks?.[ref.taskId]
      taskSnapshots.push({ ...ref, task: task ?? null })
      if (!task) { problems.push('task-missing:' + ref.boardId + ':' + ref.taskId); for (const key of DIMENSIONS) dimensions[key] = false; continue }
      if (!Number.isSafeInteger(task.revision) || !Number.isSafeInteger(task.contract?.contractRevision)) problems.push('task-or-contract-revision-unverified:' + ref.taskId)
      const expected = { ...base, ...ref, taskRevision: task.revision, contractRevision: task.contract?.contractRevision }
      const authority = stores.authority.find((row) => activeAuthority(row, expected, doc, task, now))
      if (!authority) problems.push('current-owner-lease-scope-unverified:' + ref.taskId)
      else matchedProofIds.push(authority.id)
      if (notApplicable) continue
      const candidates = {
        implemented: stores.evidence.filter((row) => item.implementationRefs.includes(row.id) && row.kind === 'implementation'
          && text(row.locator) && text(row.artifactHash) && exactProof(row, expected)),
        tested: stores.evidence.filter((row) => item.testEvidenceRefs.includes(row.id) && row.kind === 'test' && exactProof(row, expected)),
        accepted: stores.evidence.filter((row) => item.acceptanceEvidenceRefs.includes(row.id) && row.kind === 'acceptance' && exactProof(row, expected)),
      }
      candidates.enabled = stores.deployment.filter((row) => item.enablementReceiptRefs.includes(row.id)
        && row.kind === 'deployment' && text(row.entrypoint) && text(row.loadedHash) && exactProof(row, expected)
        && candidates.implemented.some((implementation) => implementation.artifactHash === row.loadedHash)
        && stores.runtime.some((runtime) => runtime.id === row.runtimeReceiptRef && runtime.kind === 'runtime-load'
          && exactProof(runtime, expected) && runtime.entrypoint === row.entrypoint && runtime.loadedHash === row.loadedHash))
      for (const dimension of DIMENSIONS) {
        if (!candidates[dimension].length) dimensions[dimension] = false
        matchedProofIds.push(...candidates[dimension].map((row) => row.id))
      }
    }
    if (notApplicable) for (const dimension of DIMENSIONS) dimensions[dimension] = null
    else for (const dimension of item.requiredDimensions) if (!dimensions[dimension]) problems.push('missing-' + dimension)
    const covered = problems.length === 0 && globalBlockers.length === 0
    return { requirementId: item.requirementId, mandatory: item.mandatory, covered,
      applicability: notApplicable ? 'not-applicable' : item.conditional ? 'requires-verification' : 'applicable',
      dimensions, proofIds: [...new Set(matchedProofIds)].sort(), remaining: [...new Set(problems)] }
  })
  const sourceRevisionVector = { planRevision: plan.planRevision, planHash: plan.planHash,
    contextHash: planDeliveryHash(context), taskHash: planDeliveryHash(taskSnapshots),
    proofHash: planDeliveryHash(stores), leaseHash: planDeliveryHash(doc.leases ?? {}), readbackHash: planDeliveryHash(readback ?? null) }
  const coverageMatrixHash = planDeliveryHash({ planId, matrix, globalBlockers, sourceRevisionVector })
  const remaining = matrix.filter((row) => !row.covered).map((row) => row.requirementId)
  const delivered = matrix.filter((row) => row.covered).map((row) => row.requirementId)
  return { ok: true, planId: plan.planId, planRevision: plan.planRevision, planHash: plan.planHash,
    sourceIdentity: source, scope: clone(plan.scope), matrix, globalBlockers, coverageMatrixHash, sourceRevisionVector,
    complete: !globalBlockers.length && matrix.every((row) => !row.mandatory || row.covered),
    status: remaining.length ? 'partial' : globalBlockers.length ? 'blocked' : 'covered', deliveredScope: delivered, remainingScope: remaining,
    requiredIntegration: ['server-source-and-plan-file-readback', 'current-owner-lease-scope-receipts', 'runtime-entrypoint-loaded-hash-receipts', 'locked-durable-commit-and-outbox'] }
}

export function commitPlanDelivery(doc, input, options = {}) {
  if (!text(input?.idempotencyKey)) return fail('DELIVERY_INVALID', 'idempotencyKey is required')
  const evaluation = evaluatePlanDelivery(doc, input.planId, options)
  if (!evaluation.ok) return evaluation
  if (input.expectedPlanRevision !== evaluation.planRevision || input.expectedPlanHash !== evaluation.planHash
    || !equal(input.sourceIdentity, evaluation.sourceIdentity)
    || input.coverageMatrixHash !== evaluation.coverageMatrixHash
    || !equal(input.sourceRevisionVector, evaluation.sourceRevisionVector)) {
    const missing = ['expectedPlanRevision', 'expectedPlanHash', 'sourceIdentity', 'coverageMatrixHash', 'sourceRevisionVector']
      .filter(key => input[key] === undefined || input[key] === null)
    if (missing.length) return fail('DELIVERY_CAS_CONFLICT', 'Missing current commit bindings: ' + missing.join(', ')
      + '. Copy expectedPlanRevision from preview.planRevision, expectedPlanHash from preview.planHash, '
      + 'and sourceIdentity, coverageMatrixHash, sourceRevisionVector directly from a fresh plan_delivery_preview. '
      + 'Use sourceRevisionVector (not expectedSourceRevisionVector); previewToken alone does not bind a normal plan_delivery_commit.')
    return fail('DELIVERY_CAS_CONFLICT', 'plan, source or coverage changed since preview')
  }
  if (!evaluation.complete) return { ...fail('DELIVERY_INCOMPLETE', 'mandatory requirements or authority facts remain uncovered'), evaluation }
  const requestHash = planDeliveryHash({ planId: input.planId, expectedPlanRevision: input.expectedPlanRevision,
    expectedPlanHash: input.expectedPlanHash, sourceIdentity: input.sourceIdentity,
    coverageMatrixHash: input.coverageMatrixHash, sourceRevisionVector: input.sourceRevisionVector })
  const state = doc.v15PlanDelivery
  const existing = rows(state.receipts).find((row) => row.planId === input.planId && row.idempotencyKey === input.idempotencyKey)
  if (existing) return existing.requestHash === requestHash
    ? { ok: true, replayed: true, receipt: clone(existing) }
    : fail('DELIVERY_CAS_CONFLICT', 'idempotencyKey was already used for different content')
  const id = 'delivery-' + planDeliveryHash({ planId: input.planId, key: input.idempotencyKey }).slice(0, 24)
  const receipt = { id, idempotencyKey: input.idempotencyKey, requestHash, status: 'validated',
    planId: input.planId, planRevision: evaluation.planRevision, planHash: evaluation.planHash,
    sourceIdentity: evaluation.sourceIdentity, scope: evaluation.scope, coverageMatrixHash: evaluation.coverageMatrixHash,
    sourceRevisionVector: evaluation.sourceRevisionVector, deliveredScope: evaluation.deliveredScope,
    remainingScope: evaluation.remainingScope, coverageMatrix: clone(evaluation.matrix),
    runtimeReceiptRefs: rows(doc.deploymentReceipts).filter((row) => evaluation.matrix.some((item) => item.proofIds.includes(row.id)))
      .map((row) => row.runtimeReceiptRef).filter(Boolean).sort(),
    unresolvedDebt: [], blockers: [], validatedAt: Number(options.now ?? Date.now()) }
  state.receipts[id] = clone(receipt)
  state.outbox[id] = { id, receiptId: id, planId: input.planId, status: 'queued', event: 'delivery-validated' }
  return { ok: true, replayed: false, receipt: clone(receipt), durability: 'caller-must-persist-under-control-plane-lock' }
}
