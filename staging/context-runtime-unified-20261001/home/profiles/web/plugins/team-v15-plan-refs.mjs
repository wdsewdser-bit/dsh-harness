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

const readBindingKeys = ['boardId', 'taskId', 'taskRevision', 'contractRevision', 'planId', 'planRevision', 'planHash',
  'sessionId', 'member', 'epoch', 'referenceIndex', 'path', 'sha256', 'bytes', 'id', 'authoritative']
const confirmedRead = row => row?.status === 'content-fetched' && row.requiredFetch === false
  && row.authoritative === true && row.verificationScope === 'exact-full-result-handed-to-adapter'
  && row.dispatch?.handedToAdapter === true && row.dispatch.stage === 'handed-to-adapter'
  && typeof row.dispatch.requestId === 'string' && row.dispatch.requestId.length > 0

export function recordPlanRead(doc, receipt) {
  const current = currentTaskPlanRefs(doc, receipt)
  if (['planId', 'planRevision', 'planHash', 'taskRevision', 'contractRevision'].some(key => current[key] !== receipt[key])) fail('RECOVERY_PLAN_CAS_CONFLICT')
  const ref = current.refs[receipt.referenceIndex]
  if (!ref || ref.path !== receipt.path || ref.sha256.toLowerCase() !== receipt.sha256) fail('RECOVERY_SOURCE_HASH_MISMATCH')
  doc.v15PlanReadReceipts ??= {}
  const existing = doc.v15PlanReadReceipts[receipt.id]
  if (existing && readBindingKeys.some(key => existing[key] !== receipt[key])) fail('RECOVERY_CONTEXT_CAS_CONFLICT')
  if (confirmedRead(existing)) return structuredClone(existing)
  doc.v15PlanReadReceipts[receipt.id] = structuredClone(receipt)
  return structuredClone(receipt)
}

export function confirmPlanReadDispatch(doc, receiptId, dispatch) {
  const row = doc.v15PlanReadReceipts?.[receiptId]
  if (!row) fail('RECOVERY_READ_RECEIPT_UNAVAILABLE')
  if (!dispatch?.requestId || dispatch.handedToAdapter !== true || dispatch.stage !== 'handed-to-adapter') fail('RECOVERY_DISPATCH_REQUIRED')
  const current = recordPlanRead(doc, row)
  // Historical tool results may recur in later requests without new authority.
  if (confirmedRead(current)) return current
  const next = { ...row, status: 'content-fetched', requiredFetch: false,
    modelConsumption: 'unknown', verificationScope: 'exact-full-result-handed-to-adapter',
    dispatch: { requestId: dispatch.requestId, stage: dispatch.stage, handedToAdapter: true } }
  doc.v15PlanReadReceipts[receiptId] = next
  return structuredClone(next)
}

export function installPlanReadDispatchObserver(bridge, { sessionId, pending, onDispatch }) {
  if (typeof bridge?.register !== 'function') return null
  const projected = new WeakSet()
  // The agent loop sets no purpose; only an auxiliary request names one.
  const conversation = options => options?.sessionId === sessionId
    && (options.purpose === undefined || options.purpose === 'conversation') && !options.signal?.aborted
  const project = options => {
    if (!conversation(options) || !bridge.isAgentLoopRequest(options)) return undefined
    const result = { messages: options.messages }
    projected.add(result)
    return result
  }
  return bridge.register('plan-read:' + hash(sessionId).slice(0, 32), project, {
    order: 1001, preview: project,
    onDispatch({ options, inputOptions, result, receipt }) {
      if (!projected.has(result) || !conversation(inputOptions) || !bridge.isAgentLoopRequest(inputOptions)
        || !conversation(options) || !receipt?.requestId || !receipt.handedToAdapter || receipt.stage !== 'handed-to-adapter') return
      const operations = [], confirmed = new Set()
      for (const message of options.messages ?? []) {
        if (message.role !== 'tool' || message.isError === true || message.content?.length !== 1
          || message.content[0].type !== 'text' || typeof message.content[0].text !== 'string') continue
        const bodyHash = hash(message.content[0].text)
        for (const [callId, expected] of pending) {
          const native = !expected.rootCallId && message.toolCallId === callId && bodyHash === expected.bodyHash
          const outer = expected.rootCallId && message.toolCallId === expected.rootCallId && expected.rootBodyHashes?.includes(bodyHash)
          if ((!native && !outer) || confirmed.has(expected.receiptId)) continue
          confirmed.add(expected.receiptId)
          operations.push(onDispatch(expected.receiptId, receipt))
        }
      }
      return Promise.all(operations)
    },
  })
}
export const planReadBodyHash = result => hash(JSON.stringify(result))

export function createPlanReadDispatchCandidate(result, exec) {
  const encoded = JSON.stringify(result)
  const rootCallId = exec.parent !== undefined && typeof exec.rootCallId === 'string'
    && exec.rootCallId.length > 0 && exec.rootCallId !== exec.callId ? exec.rootCallId : null
  // Match only the exact native serializers and their fixed outer sandbox suffix.
  const bodies = rootCallId ? [encoded, JSON.stringify(result, null, 2)] : []
  return { receiptId: result.readReceipt.id, rootCallId, bodyHash: hash(encoded),
    rootBodyHashes: bodies.flatMap(body => [hash(body), hash(body + '\nFile sandbox enforcement is partial on this host.')]) }
}
