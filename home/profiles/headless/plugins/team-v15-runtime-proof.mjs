import { planDeliveryHash } from './team-v15-plan-delivery.mjs'

const clone = value => structuredClone(value)
const fail = code => { throw Object.assign(new Error(code), { code }) }
const same = (a, b) => planDeliveryHash(a) === planDeliveryHash(b)
const KEYS = ['planId', 'expectedPlanRevision', 'expectedPlanHash', 'requirementId', 'boardId', 'taskId',
  'expectedTaskRevision', 'expectedContractRevision', 'proofRef', 'locator']
function sync(fn, ...args) {
  if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') fail('RUNTIME_PROOF_PROVIDER_UNAVAILABLE')
  const value = fn(...args)
  if (value?.then) fail('RUNTIME_PROOF_PROVIDER_UNAVAILABLE')
  return value
}

/** The runtime provider is installed by the server, never supplied in tool
 * arguments. Its current instance and actual dispatch must match source bytes. */
export function createRuntimeProofProducer({ control, readDurable, collectContext, collectRuntime, verifyPlan, authorize, now = Date.now }) {
  async function prove(input, agent) {
    if (!input || Array.isArray(input) || Object.keys(input).some(key => !KEYS.includes(key))
      || KEYS.some(key => input[key] === undefined)) fail('RUNTIME_PROOF_INPUT_INVALID')
    input = clone(input)
    let durable
    await control.mutateHot('v15/runtime-proven', { planId: input.planId, proofRef: input.proofRef }, agent, latest => {
      if (sync(authorize, latest, input, agent) !== true) fail('RUNTIME_PROOF_DENIED')
      const plan = latest.v15PlanDelivery?.plans?.[input.planId], task = latest.boards?.[input.boardId]?.tasks?.[input.taskId]
      if (!plan || !task || plan.planRevision !== input.expectedPlanRevision || plan.planHash !== input.expectedPlanHash
        || task.revision !== input.expectedTaskRevision || task.contract?.contractRevision !== input.expectedContractRevision) fail('DELIVERY_CAS_CONFLICT')
      sync(verifyPlan, clone(plan))
      const item = plan.items.find(row => row.requirementId === input.requirementId)
      if (!item?.enablementReceiptRefs.includes(input.proofRef)
        || !item.taskRefs.some(ref => ref.boardId === input.boardId && ref.taskId === input.taskId)) fail('RUNTIME_PROOF_SLOT_DENIED')
      const owner = task.ownerName ?? task.owner ?? task.contract?.owner, at = sync(now)
      const leases = Object.entries(latest.leases ?? {}).filter(([, row]) => row.member === owner && row.taskId === input.taskId
        && row.contractRevision === task.contract.contractRevision && row.status === 'active' && Number.isFinite(row.expiresAt) && row.expiresAt > at)
      if (!owner || !Number.isFinite(at) || leases.length !== 1) fail('RUNTIME_PROOF_AUTHORITY_UNVERIFIED')
      const context = sync(collectContext, clone(latest), clone(plan))
      const file = context.sourceManifest?.files?.find(row => row.path === input.locator)
      const implementation = Object.values(latest.v12Evidence?.records ?? {}).find(row => item.implementationRefs.includes(row.id)
        && row.kind === 'implementation' && row.status === 'passed' && row.locator === input.locator && row.artifactHash === file?.sha256
        && row.boardId === input.boardId && row.taskId === input.taskId && row.taskRevision === task.revision
        && row.contractRevision === task.contract.contractRevision && row.planHash === plan.planHash
        && row.requirementId === item.requirementId && row.planId === plan.planId && row.planRevision === plan.planRevision
        && same(row.scope, plan.scope) && !(row.staleReasons?.length)
        && same(row.sourceIdentity, context.sourceIdentity) && row.environmentFingerprint === context.environmentFingerprint
        && row.recipeFingerprint === context.recipeFingerprint)
      if (!file || !implementation) fail('RUNTIME_PROOF_IMPLEMENTATION_UNVERIFIED')
      const facts = sync(collectRuntime, clone(task), agent)
      if (!facts || facts.pid !== process.pid || typeof facts.instanceId !== 'string' || !facts.instanceId
        || facts.entrypoint !== file.physicalPath || facts.moduleHash?.toLowerCase() !== file.sha256
        || facts.loaded !== true || facts.toolRegistered !== true || facts.enabled !== true || facts.consumed !== true
        || !facts.sessionId || facts.dispatch?.sessionId !== facts.sessionId || facts.dispatch?.instanceId !== facts.instanceId
        || facts.dispatch?.handedToAdapter !== true || facts.dispatch.stage !== 'handed-to-adapter' || !facts.dispatch.requestId) fail('RUNTIME_PROOF_NOT_CONSUMED')
      const binding = { status: 'passed', planId: plan.planId, planRevision: plan.planRevision, planHash: plan.planHash,
        requirementId: item.requirementId, scope: clone(plan.scope), sourceIdentity: clone(context.sourceIdentity),
        environmentFingerprint: context.environmentFingerprint, recipeFingerprint: context.recipeFingerprint,
        boardId: input.boardId, taskId: input.taskId, taskRevision: task.revision, contractRevision: task.contract.contractRevision }
      const runtime = { ...binding, id: 'runtime-' + planDeliveryHash({ proofRef: input.proofRef, facts }).slice(0, 32),
        kind: 'runtime-load', entrypoint: facts.entrypoint, loadedHash: file.sha256, runtimeFacts: clone(facts),
        verificationScope: facts.verificationScope, modelUnderstanding: 'unknown' }
      const deployment = { ...binding, id: input.proofRef, kind: 'deployment', entrypoint: facts.entrypoint,
        loadedHash: file.sha256, runtimeReceiptRef: runtime.id }
      const prior = latest.deploymentReceipts?.[input.proofRef]
      if (prior && (prior.kind !== 'deployment' || prior.planId !== plan.planId || prior.requirementId !== item.requirementId
        || prior.boardId !== input.boardId || prior.taskId !== input.taskId)) fail('RUNTIME_PROOF_SLOT_CONFLICT')
      latest.runtimeReceipts = { ...latest.runtimeReceipts, [runtime.id]: runtime }
      latest.deploymentReceipts = { ...latest.deploymentReceipts, [deployment.id]: deployment }
      return { runtime, deployment, observed: clone(facts) }
    }, { deferMs: 0, afterDurable(result, locked) {
      const disk = sync(readDurable)
      if (disk.revision !== locked.revision || disk.rootId !== locked.rootId
        || !same(disk.runtimeReceipts?.[result.runtime.id], result.runtime)
        || !same(disk.deploymentReceipts?.[result.deployment.id], result.deployment)) fail('RUNTIME_PROOF_READBACK_MISMATCH')
      const plan = disk.v15PlanDelivery.plans[input.planId], task = disk.boards[input.boardId].tasks[input.taskId]
      sync(verifyPlan, clone(plan))
      const current = sync(collectContext, clone(disk), clone(plan)), facts = sync(collectRuntime, clone(task), agent)
      if (!same(current.sourceIdentity, result.runtime.sourceIdentity) || current.environmentFingerprint !== result.runtime.environmentFingerprint
        || current.recipeFingerprint !== result.runtime.recipeFingerprint || !same(facts, result.observed)) fail('DELIVERY_CAS_CONFLICT')
      durable = { runtime: clone(result.runtime), deployment: clone(result.deployment), durable: true }
    } })
    if (!durable) fail('RUNTIME_PROOF_DURABILITY_UNAVAILABLE')
    return durable
  }
  return Object.freeze({ prove })
}

export function runtimeProofDebt(state, plan, collectRuntime) {
  const debt = []
  for (const item of plan.items) for (const id of item.enablementReceiptRefs) {
    const deployment = state.deploymentReceipts?.[id]
    if (!deployment || deployment.planId !== plan.planId || deployment.planHash !== plan.planHash) continue
    const runtime = state.runtimeReceipts?.[deployment.runtimeReceiptRef]
    const task = state.boards?.[deployment.boardId]?.tasks?.[deployment.taskId]
    try {
      if (!runtime || !task || runtime.kind !== 'runtime-load' || deployment.kind !== 'deployment'
        || runtime.status !== 'passed' || deployment.status !== 'passed'
        || runtime.planHash !== plan.planHash || runtime.requirementId !== item.requirementId
        || !same(sync(collectRuntime, clone(task)), runtime.runtimeFacts)) debt.push('runtime-proof-stale:' + id)
    } catch { debt.push('runtime-proof-unavailable:' + id) }
  }
  return [...new Set(debt)]
}
