import { isAbsolute, relative, resolve } from 'node:path'
import { planDeliveryHash } from './team-v15-plan-delivery.mjs'

const clone = value => structuredClone(value)
const fail = code => { throw Object.assign(new Error(code), { code }) }
const same = (a, b) => planDeliveryHash(a) === planDeliveryHash(b)
const INPUT_KEYS = new Set(['planId', 'expectedPlanRevision', 'expectedPlanHash', 'requirementId', 'boardId', 'taskId',
  'expectedTaskRevision', 'expectedContractRevision', 'proofRef', 'locator'])
function within(root, path) {
  const delta = relative(root, path)
  return !isAbsolute(delta) && delta !== '..' && !delta.startsWith('../') && !delta.startsWith('..\\')
}
function sync(fn, ...args) {
  if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') fail('IMPLEMENTATION_CALLBACK_INVALID')
  const value = fn(...args)
  if (value?.then) fail('IMPLEMENTATION_CALLBACK_INVALID')
  return value
}

/** Presence of an exact scoped artifact is one dimension only. Test, runtime
 * load and business acceptance cannot be derived from these physical bytes. */
export function createImplementationProofProducer({ control, readDurable, collectContext, verifyPlan, authorize, now = Date.now }) {
  async function prove(input, agent) {
    if (!input || Array.isArray(input) || Object.keys(input).some(key => !INPUT_KEYS.has(key))
      || [...INPUT_KEYS].some(key => input[key] === undefined)) fail('IMPLEMENTATION_PROOF_INPUT_INVALID')
    let durable
    await control.mutateHot('v15/implementation-proven', { planId: input.planId, proofRef: input.proofRef }, agent, latest => {
      if (sync(authorize, latest, input, agent) !== true) fail('IMPLEMENTATION_PROOF_DENIED')
      const plan = latest.v15PlanDelivery?.plans?.[input.planId]
      const task = latest.boards?.[input.boardId]?.tasks?.[input.taskId]
      if (!plan || !task || plan.planRevision !== input.expectedPlanRevision || plan.planHash !== input.expectedPlanHash
        || task.revision !== input.expectedTaskRevision || task.contract?.contractRevision !== input.expectedContractRevision) fail('DELIVERY_CAS_CONFLICT')
      sync(verifyPlan, clone(plan))
      const item = plan.items.find(row => row.requirementId === input.requirementId)
      if (!item?.implementationRefs.includes(input.proofRef)
        || !item.taskRefs.some(ref => ref.boardId === input.boardId && ref.taskId === input.taskId)) fail('IMPLEMENTATION_SLOT_DENIED')
      const at = sync(now)
      const owner = task.ownerName ?? task.owner ?? task.contract?.owner
      const leases = Object.entries(latest.leases ?? {}).filter(([, row]) => row.status === 'active' && row.member === owner
        && row.taskId === input.taskId && row.contractRevision === task.contract.contractRevision && Number.isFinite(row.expiresAt) && row.expiresAt > at)
      if (!owner || !Number.isFinite(at) || leases.length !== 1) fail('IMPLEMENTATION_AUTHORITY_UNVERIFIED')
      const context = sync(collectContext, clone(latest), clone(plan))
      const file = context.sourceManifest?.files?.find(row => row.path === input.locator)
      const root = context.sourceManifest?.root
      const scopes = task.contract?.writeScopes ?? task.writeScopes
      if (!file || !root || !Array.isArray(scopes) || !scopes.some(scope => typeof scope === 'string'
        && within(resolve(root, scope), resolve(root, file.path)))) fail('IMPLEMENTATION_SOURCE_SCOPE_DENIED')
      const binding = { status: 'passed', planId: plan.planId, planRevision: plan.planRevision, planHash: plan.planHash,
        requirementId: item.requirementId, scope: clone(plan.scope), sourceIdentity: clone(context.sourceIdentity),
        environmentFingerprint: context.environmentFingerprint, recipeFingerprint: context.recipeFingerprint,
        boardId: input.boardId, taskId: input.taskId, taskRevision: task.revision, contractRevision: task.contract.contractRevision }
      const proof = { ...binding, id: input.proofRef, kind: 'implementation', locator: file.path, artifactHash: file.sha256,
        provenance: { kind: 'server-physical-source-scan', bytes: file.bytes, physicalPath: file.physicalPath },
        verificationScope: 'physical-source-presence-not-test-or-business-acceptance' }
      const [leaseRef, lease] = leases[0]
      const authority = { ...binding, id: 'authority-' + planDeliveryHash({ plan: plan.planHash, requirement: item.requirementId,
        board: input.boardId, task: input.taskId, leaseRef }).slice(0, 24), kind: 'delivery-authority', owner, leaseRef, expiresAt: lease.expiresAt }
      const prior = latest.v12Evidence?.records?.[proof.id]
      if (prior && (prior.kind !== 'implementation' || prior.planId !== plan.planId || prior.requirementId !== item.requirementId
        || prior.boardId !== input.boardId || prior.taskId !== input.taskId)) fail('IMPLEMENTATION_SLOT_CONFLICT')
      // Cold-reference digests are identity-cached: replace the registry rather
      // than mutating an object whose content hash may already be memoized.
      latest.v12Evidence = clone(latest.v12Evidence ?? { version: 1, revision: 0, records: {} })
      latest.v12Evidence.records ??= {}
      latest.v12Evidence.records[proof.id] = proof
      latest.v12Evidence.revision = Number(latest.v12Evidence.revision ?? 0) + 1
      latest.deliveryAuthorityReceipts = { ...latest.deliveryAuthorityReceipts, [authority.id]: authority }
      return { proof: clone(proof), authority: clone(authority) }
    }, { deferMs: 0, afterDurable(result, locked) {
      const disk = sync(readDurable)
      if (disk.revision !== locked.revision || disk.rootId !== locked.rootId
        || !same(disk.v12Evidence?.records?.[result.proof.id], result.proof)
        || !same(disk.deliveryAuthorityReceipts?.[result.authority.id], result.authority)) {
        const error = Object.assign(new Error('IMPLEMENTATION_DURABLE_READBACK_MISMATCH'), { code: 'IMPLEMENTATION_DURABLE_READBACK_MISMATCH',
          detail: { revision: [disk.revision, locked.revision], root: [disk.rootId, locked.rootId],
            evidencePresent: Boolean(disk.v12Evidence?.records?.[result.proof.id]), authorityPresent: Boolean(disk.deliveryAuthorityReceipts?.[result.authority.id]) } })
        throw error
      }
      const plan = disk.v15PlanDelivery.plans[input.planId]
      sync(verifyPlan, clone(plan))
      const current = sync(collectContext, clone(disk), clone(plan))
      if (!same(current.sourceIdentity, result.proof.sourceIdentity) || current.environmentFingerprint !== result.proof.environmentFingerprint
        || current.recipeFingerprint !== result.proof.recipeFingerprint) fail('DELIVERY_CAS_CONFLICT')
      durable = { ...clone(result), durable: true }
    } })
    if (!durable) fail('IMPLEMENTATION_DURABLE_HOOK_UNAVAILABLE')
    return durable
  }
  return Object.freeze({ prove })
}
