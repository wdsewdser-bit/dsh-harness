import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import { normalizePlan, planDeliveryHash } from './team-v15-plan-delivery.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const fail = code => { throw Object.assign(new Error(code), { code }) }
export function readExactPlanFile(ref, { allowedRoots = [], maxBytes = 262144 } = {}) {
  if (typeof ref?.path !== 'string' || !/^[a-f\d]{64}$/i.test(ref?.sha256 ?? '')) fail('RECOVERY_REFERENCE_UNAVAILABLE')
  const physical = realpathSync(ref.path)
  const allowed = allowedRoots.some(root => {
    const delta = relative(realpathSync(root), physical)
    return delta !== '' && !isAbsolute(delta) && delta !== '..' && !delta.startsWith('..\\') && !delta.startsWith('../')
  })
  if (!allowed) fail('RECOVERY_PATH_DENIED')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || statSync(physical).size > maxBytes) fail('RECOVERY_FULL_READ_BUDGET_EXCEEDED')
  const bytes = readFileSync(physical)
  if (bytes.length > maxBytes) fail('RECOVERY_FULL_READ_BUDGET_EXCEEDED')
  if (realpathSync(ref.path) !== physical || hash(bytes) !== ref.sha256.toLowerCase()) fail('RECOVERY_SOURCE_HASH_MISMATCH')
  const text = bytes.toString('utf8')
  if (!Buffer.from(text).equals(bytes)) fail('RECOVERY_SOURCE_ENCODING_UNSUPPORTED')
  return { physical, bytes: bytes.length, text }
}
export function currentTaskPlanRefs(doc, { boardId, taskId }) {
  const task = doc.boards?.[boardId]?.tasks?.[taskId]
  if (!task) fail('RECOVERY_TASK_UNAVAILABLE')
  if (!Number.isSafeInteger(task.revision) || !Number.isSafeInteger(task.contract?.contractRevision)) fail('RECOVERY_TASK_REVISION_UNVERIFIED')
  const planId = doc.v15PlanDelivery?.taskPlanBindings?.[boardId]?.[taskId]?.planId ?? task.planId ?? task.contract?.planId
  const plan = doc.v15PlanDelivery?.plans?.[planId]
  if (!plan) fail('RECOVERY_PLAN_UNREGISTERED')
  if (normalizePlan(plan).planHash !== plan.planHash) fail('RECOVERY_PLAN_HASH_MISMATCH')
  if (!plan.items.some(item => item.taskRefs.some(ref => ref.boardId === boardId && ref.taskId === taskId))) fail('RECOVERY_TASK_PLAN_MISMATCH')
  return { boardId, taskId, taskRevision: task.revision, contractRevision: task.contract?.contractRevision,
    planId, planRevision: plan.planRevision, planHash: plan.planHash,
    refs: [plan.ref, ...(plan.supplementalRefs ?? [])].map((ref, referenceIndex) => ({ ...ref, referenceIndex,
      fetch: { action: 'plan_ref_get', task_id: taskId, input: { referenceIndex,
        expectedPlanRevision: plan.planRevision, expectedPlanHash: plan.planHash } } })) }
}

export function readTaskPlanRef(doc, input, { allowedRoots = [], maxBytes = 262144, sessionId, member, epoch } = {}) {
  if (![sessionId, member, epoch].every(value => typeof value === 'string' && value.length > 0)) fail('RECOVERY_CONTEXT_BINDING_REQUIRED')
  const current = currentTaskPlanRefs(doc, input)
  if (input.expectedPlanRevision !== current.planRevision || input.expectedPlanHash !== current.planHash) fail('RECOVERY_PLAN_CAS_CONFLICT')
  const ref = current.refs[input.referenceIndex]
  if (!Number.isSafeInteger(input.referenceIndex) || !ref) fail('RECOVERY_REFERENCE_UNAVAILABLE')
  const { text, bytes } = readExactPlanFile(ref, { allowedRoots, maxBytes })
  const binding = { ...current, sessionId, member, epoch, refs: undefined, referenceIndex: input.referenceIndex, path: ref.path,
    sha256: ref.sha256.toLowerCase(), bytes }
  delete binding.refs
  return { ok: true, text, readReceipt: { ...binding, id: 'plan-read-' + planDeliveryHash(binding).slice(0, 32),
    status: 'read-complete-awaiting-dispatch', authoritative: true, requiredFetch: true } }
}

export function recordPlanRead(doc, receipt) {
  const current = currentTaskPlanRefs(doc, receipt)
  if (['planId', 'planRevision', 'planHash', 'taskRevision', 'contractRevision'].some(key => current[key] !== receipt[key])) fail('RECOVERY_PLAN_CAS_CONFLICT')
  const ref = current.refs[receipt.referenceIndex]
  if (!ref || ref.path !== receipt.path || ref.sha256.toLowerCase() !== receipt.sha256) fail('RECOVERY_SOURCE_HASH_MISMATCH')
  doc.v15PlanReadReceipts ??= {}
  doc.v15PlanReadReceipts[receipt.id] = structuredClone(receipt)
  return structuredClone(receipt)
}

export function confirmPlanReadDispatch(doc, receiptId, dispatch) {
  const row = doc.v15PlanReadReceipts?.[receiptId]
  if (!row) fail('RECOVERY_READ_RECEIPT_UNAVAILABLE')
  if (!dispatch?.requestId || dispatch.handedToAdapter !== true || dispatch.stage !== 'handed-to-adapter') fail('RECOVERY_DISPATCH_REQUIRED')
  recordPlanRead(doc, row)
  const next = { ...row, status: 'content-fetched', requiredFetch: false,
    modelConsumption: 'unknown', verificationScope: 'exact-full-result-handed-to-adapter',
    dispatch: { requestId: dispatch.requestId, stage: dispatch.stage, handedToAdapter: true } }
  doc.v15PlanReadReceipts[receiptId] = next
  return structuredClone(next)
}

export function installPlanReadDispatchObserver(bridge, { sessionId, pending, onDispatch }) {
  if (typeof bridge?.register !== 'function') return null
  // The agent loop sets no purpose; only an auxiliary request names one.
  const project = options => options?.sessionId === sessionId && (options.purpose === undefined || options.purpose === 'conversation')
    && bridge.isAgentLoopRequest(options) ? { messages: options.messages } : undefined
  return bridge.register('plan-read:' + hash(sessionId).slice(0, 32), project, {
    order: 1001, preview: project,
    onDispatch({ options, receipt }) {
      if (!receipt.handedToAdapter || receipt.stage !== 'handed-to-adapter') return
      return Promise.all((options.messages ?? []).flatMap(message => {
        const expected = pending.get(message.toolCallId)
        const body = (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
        if (message.role !== 'tool' || !expected || hash(body) !== expected.bodyHash) return []
        return [onDispatch(expected.receiptId, receipt)]
      }))
    },
  })
}
export const planReadBodyHash = result => hash(JSON.stringify(result))
