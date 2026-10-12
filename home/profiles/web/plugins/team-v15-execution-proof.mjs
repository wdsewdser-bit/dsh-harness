import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { planDeliveryHash } from './team-v15-plan-delivery.mjs'
import { readExactPlanFile } from './team-v15-plan-refs.mjs'

const clone = value => structuredClone(value)
const fail = code => { throw Object.assign(new Error(code), { code }) }
const same = (a, b) => planDeliveryHash(a) === planDeliveryHash(b)
const KEYS = ['planId', 'expectedPlanRevision', 'expectedPlanHash', 'requirementId', 'boardId', 'taskId',
  'expectedTaskRevision', 'expectedContractRevision', 'proofRef', 'recipeId']
function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function sync(fn, ...args) {
  if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') fail('EXECUTION_CALLBACK_INVALID')
  const value = fn(...args)
  if (value?.then) fail('EXECUTION_CALLBACK_INVALID')
  return value
}
function unsafeArguments(args, root) {
  if (Object.keys(args).some(key => !['command', 'description', 'workdir', 'timeoutMs'].includes(key))
    || typeof args.description !== 'string' || !args.description.trim()
    || typeof args.workdir !== 'string' || !Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) return true
  try { return realpathSync(args.workdir) !== root } catch { return true }
}

/** The physical server recipe is the only command and oracle authority.
 * Call prove from a real ToolRuntime tool body with its actual exec object.
 * captureCancellation must retain the original turn cancellation, because
 * the native bridge intentionally drains started effects with a fresh signal. */
export function createExecutionProofProducer({ control, readDurable, collectContext, verifyPlan, authorize,
  toolRuntime, recipeRef, allowedRoots, captureCancellation, now = Date.now }) {
  async function prove(input, exec) {
    if (!exact(input, KEYS)) fail('EXECUTION_PROOF_INPUT_INVALID')
    const request = clone(input)
    if (!exec?.agent || typeof exec.token !== 'symbol' || !exec.callId || !exec.signal
      || typeof toolRuntime?.execute !== 'function') fail('EXECUTION_CONTEXT_REQUIRED')
    // This is a host callback, never a field in model-supplied arguments.
    const cancellation = sync(captureCancellation, exec)
    if (!cancellation?.signal || typeof cancellation.isCancelled !== 'function') fail('EXECUTION_CANCELLATION_UNAVAILABLE')
    const checkCancellation = () => {
      if (exec.signal.aborted || cancellation.signal.aborted || sync(cancellation.isCancelled) !== false) fail('EXECUTION_CANCELLED')
    }
    function capture(state) {
      checkCancellation()
      if (sync(authorize, state, request, exec.agent) !== true) fail('EXECUTION_PROOF_DENIED')
      const plan = state.v15PlanDelivery?.plans?.[request.planId]
      const task = state.boards?.[request.boardId]?.tasks?.[request.taskId]
      if (!plan || !task || plan.planRevision !== request.expectedPlanRevision || plan.planHash !== request.expectedPlanHash
        || task.revision !== request.expectedTaskRevision || task.contract?.contractRevision !== request.expectedContractRevision) fail('DELIVERY_CAS_CONFLICT')
      sync(verifyPlan, clone(plan))
      const file = readExactPlanFile(recipeRef, { allowedRoots })
      let document
      try { document = JSON.parse(file.text) } catch { fail('EXECUTION_RECIPE_INVALID') }
      if (!exact(document, ['schema', 'recipes']) || document.schema !== 'dsh-execution-recipes-v1'
        || !Array.isArray(document.recipes) || JSON.stringify(document, null, 2) !== file.text.trim().replaceAll('\r\n', '\n')) fail('EXECUTION_RECIPE_INVALID')
      const matches = document.recipes.filter(row => row.id === request.recipeId)
      if (matches.length !== 1) fail('EXECUTION_RECIPE_DENIED')
      const recipe = matches[0]
      if (!exact(recipe, ['id', 'kind', 'toolName', 'arguments', 'checks', 'slots'])
        || !['test', 'acceptance'].includes(recipe.kind) || recipe.toolName !== 'bash'
        || !recipe.arguments || typeof recipe.arguments.command !== 'string' || !recipe.arguments.command.trim()
        || !Array.isArray(recipe.checks) || !recipe.checks.length || recipe.checks.some(id => typeof id !== 'string' || !id)
        || new Set(recipe.checks).size !== recipe.checks.length || !Array.isArray(recipe.slots)) fail('EXECUTION_RECIPE_INVALID')
      const item = plan.items.find(row => row.requirementId === request.requirementId)
      const refs = recipe.kind === 'test' ? item?.testEvidenceRefs : item?.acceptanceEvidenceRefs
      const slot = { planId: request.planId, requirementId: request.requirementId, boardId: request.boardId,
        taskId: request.taskId, proofRef: request.proofRef }
      if (!refs?.includes(request.proofRef) || !item.taskRefs.some(ref => ref.boardId === request.boardId && ref.taskId === request.taskId)
        || !recipe.slots.some(row => exact(row, Object.keys(slot)) && same(row, slot))) fail('EXECUTION_SLOT_DENIED')
      const at = sync(now)
      const owner = task.ownerName ?? task.owner ?? task.contract?.owner
      const leases = Object.entries(state.leases ?? {}).filter(([, lease]) => lease.status === 'active' && lease.member === owner
        && lease.taskId === request.taskId && lease.contractRevision === task.contract.contractRevision
        && Number.isFinite(lease.expiresAt) && lease.expiresAt > at)
      if (!owner || !Number.isFinite(at) || leases.length !== 1) fail('EXECUTION_AUTHORITY_UNVERIFIED')
      const context = sync(collectContext, clone(state), clone(plan))
      if (!context.sourceManifest?.files?.length || !context.sourceIdentity?.manifestHash
        || !/^[a-f\d]{64}$/i.test(context.environmentFingerprint ?? '')
        || unsafeArguments(recipe.arguments, context.sourceManifest.root)
        || context.recipeFingerprint !== planDeliveryHash({ ref: recipeRef, physicalPath: file.physical })) fail('EXECUTION_CONTEXT_UNVERIFIED')
      const [leaseRef, lease] = leases[0]
      const binding = { planId: plan.planId, planRevision: plan.planRevision, planHash: plan.planHash,
        requirementId: item.requirementId, scope: clone(plan.scope), sourceIdentity: clone(context.sourceIdentity),
        environmentFingerprint: context.environmentFingerprint, recipeFingerprint: context.recipeFingerprint,
        boardId: request.boardId, taskId: request.taskId, taskRevision: task.revision, contractRevision: task.contract.contractRevision }
      return { rootId: state.rootId, binding, task: clone(task), leaseRef, lease: clone(lease), recipe: clone(recipe), owner }
    }
    let before
    await control.mutateHot('v15/execution-started', { planId: request.planId, proofRef: request.proofRef }, exec.agent,
      state => { before = capture(state); return { recipeId: request.recipeId } }, { deferMs: 0 })
    if (!before) fail('EXECUTION_START_UNAVAILABLE')
    checkCancellation()
    const callId = 'execution-proof-' + randomUUID()
    const result = await toolRuntime.execute({ name: before.recipe.toolName, arguments: clone(before.recipe.arguments),
      callId, rootCallId: exec.rootCallId ?? exec.callId, parent: exec.token, agent: exec.agent, signal: cancellation.signal })
    checkCancellation()
    const value = result?.value
    if (result?.isError !== false || value?.kind !== 'foreground' || value.exitCode !== 0 || value.signal !== null
      || value.timedOut !== false || value.aborted !== false || value.stopped !== undefined
      || value.stdout?.truncated !== false || value.stderr?.truncated !== false
      || typeof value.stdout?.text !== 'string' || value.stdout.text.length > 262144
      || typeof value.stderr?.text !== 'string' || value.stderr.text.trim() || value.sandbox?.runnerFailed) fail('EXECUTION_RESULT_UNVERIFIED')
    let quality
    try { quality = JSON.parse(value.stdout.text) } catch { fail('EXECUTION_QUALITY_UNVERIFIED') }
    if (!exact(quality, ['schema', 'recipeId', 'kind', 'checks']) || quality.schema !== 'dsh-execution-quality-v1'
      || quality.recipeId !== before.recipe.id || quality.kind !== before.recipe.kind || !Array.isArray(quality.checks)
      || quality.checks.length !== before.recipe.checks.length
      || quality.checks.some(row => !exact(row, ['id', 'passed']) || row.passed !== true)
      || !same(quality.checks.map(row => row.id).sort(), [...before.recipe.checks].sort())) fail('EXECUTION_QUALITY_UNVERIFIED')
    let durable, candidate
    try {
      await control.mutateHot('v15/execution-proven', { planId: request.planId, proofRef: request.proofRef }, exec.agent, state => {
      const current = capture(state)
      if (!same(before, current)) fail('DELIVERY_CAS_CONFLICT')
      const proof = { ...before.binding, id: request.proofRef, kind: before.recipe.kind, status: 'passed',
        artifactHash: planDeliveryHash(quality), provenance: { kind: 'server-tool-runtime-quality-oracle', callId,
          parentCallId: exec.callId, recipeId: before.recipe.id, recipeHash: planDeliveryHash(before.recipe), quality: clone(quality) },
        verificationScope: 'declared-server-recipe-exact-quality-checks' }
      const prior = state.v12Evidence?.records?.[proof.id]
      if (prior && (prior.kind !== proof.kind || prior.planId !== proof.planId || prior.requirementId !== proof.requirementId
        || prior.boardId !== proof.boardId || prior.taskId !== proof.taskId)) fail('EXECUTION_SLOT_CONFLICT')
      const authority = { ...before.binding, id: 'authority-' + planDeliveryHash({ plan: proof.planHash, requirement: proof.requirementId,
        board: proof.boardId, task: proof.taskId, leaseRef: before.leaseRef }).slice(0, 24), kind: 'delivery-authority',
        status: 'passed', owner: before.owner, leaseRef: before.leaseRef, expiresAt: before.lease.expiresAt }
      checkCancellation()
      state.v12Evidence = clone(state.v12Evidence ?? { version: 1, revision: 0, records: {} })
      state.v12Evidence.records ??= {}
      state.v12Evidence.records[proof.id] = proof
      state.v12Evidence.revision = Number(state.v12Evidence.revision ?? 0) + 1
      state.deliveryAuthorityReceipts = { ...state.deliveryAuthorityReceipts, [authority.id]: authority }
      candidate = { proof: clone(proof), authority: clone(authority) }
      return { proof, authority }
    }, { deferMs: 0, afterDurable(result, locked) {
      const disk = sync(readDurable)
      if (disk.revision !== locked.revision || disk.rootId !== locked.rootId
        || !same(disk.v12Evidence?.records?.[result.proof.id], result.proof)
        || !same(disk.deliveryAuthorityReceipts?.[result.authority.id], result.authority)) fail('EXECUTION_DURABLE_READBACK_MISMATCH')
      if (!same(before, capture(disk))) fail('DELIVERY_CAS_CONFLICT')
      durable = { ...clone(result), durable: true }
    } })
    } catch (error) {
      // Readback occurs after asynchronous persistence. If that window fails,
      // invalidate only this run's exact row; never leave it reusable as passed.
      if (candidate) {
        try {
          await control.mutateHot('v15/execution-invalidated', { proofRef: request.proofRef, callId }, exec.agent, state => {
            if (!same(state.v12Evidence?.records?.[candidate.proof.id], candidate.proof)) return { invalidated: false }
            state.v12Evidence = clone(state.v12Evidence)
            state.v12Evidence.records[candidate.proof.id] = { ...candidate.proof, status: 'invalidated', staleReasons: [error.code ?? 'EXECUTION_COMMIT_FAILED'] }
            state.v12Evidence.revision = Number(state.v12Evidence.revision ?? 0) + 1
            if (same(state.deliveryAuthorityReceipts?.[candidate.authority.id], candidate.authority)) {
              state.deliveryAuthorityReceipts = { ...state.deliveryAuthorityReceipts,
                [candidate.authority.id]: { ...candidate.authority, status: 'invalidated' } }
            }
            return { invalidated: true }
          }, { deferMs: 0 })
        } catch (invalidationError) {
          error.invalidationError = String(invalidationError)
        }
      }
      throw error
    }
    if (!durable) fail('EXECUTION_DURABLE_HOOK_UNAVAILABLE')
    return durable
  }
  return Object.freeze({ prove })
}
