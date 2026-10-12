import { normalizePlan, planDeliveryHash, registerPlan } from './team-v15-plan-delivery.mjs'
import { readExactPlanFile } from './team-v15-plan-refs.mjs'

const clone = value => structuredClone(value)
const same = (a, b) => planDeliveryHash(a) === planDeliveryHash(b)
const fail = (code, detail = code) => { throw Object.assign(new Error(detail), { code }) }
const SOURCE_KEYS = new Set(['kind', 'version', 'planId', 'scope', 'items', 'supplementalRefs', 'scopeChangeAuthorizationRef'])
const INPUT_KEYS = new Set(['planId', 'ref', 'expectedPlanRevision'])
const ITEM_KEYS = new Set(['requirementId', 'mandatory', 'conditional', 'taskRefs', 'requiredDimensions',
  'implementationRefs', 'testEvidenceRefs', 'enablementReceiptRefs', 'acceptanceEvidenceRefs', 'notApplicableReceiptRef'])
function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.has(key))
}
function synchronous(fn, name, ...args) {
  if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') fail('PLAN_REGISTRY_CALLBACK_INVALID', name)
  const result = fn(...args)
  if (result && typeof result.then === 'function') fail('PLAN_REGISTRY_CALLBACK_INVALID', name)
  return result
}

/** A single explicit contract owns the requirement inventory. Free prose is
 * still read in full, but cannot silently become a partial machine contract. */
export function parsePlanSource(text) {
  let body = text.trim()
  if (!body.startsWith('{')) {
    const blocks = [...text.matchAll(/^```dsh-plan-contract\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)]
    if (blocks.length !== 1) fail('PLAN_SOURCE_CONTRACT_REQUIRED')
    body = blocks[0][1].trim()
  }
  let source
  try { source = JSON.parse(body) } catch { fail('PLAN_SOURCE_CONTRACT_INVALID') }
  if (!source || Array.isArray(source) || source.kind !== 'dsh-plan-contract' || source.version !== 1
    || Object.keys(source).some(key => !SOURCE_KEYS.has(key))) fail('PLAN_SOURCE_CONTRACT_INVALID')
  if (!Array.isArray(source.items) || source.items.some(item => !exactKeys(item, ITEM_KEYS)
    || (item.mandatory !== undefined && typeof item.mandatory !== 'boolean')
    || (item.conditional != null && !exactKeys(item.conditional, new Set(['trigger'])))
    || !Array.isArray(item.taskRefs) || item.taskRefs.some(ref => !exactKeys(ref, new Set(['boardId', 'taskId']))))
    || (source.supplementalRefs !== undefined && (!Array.isArray(source.supplementalRefs)
      || source.supplementalRefs.some(ref => !exactKeys(ref, new Set(['path', 'sha256'])))))) fail('PLAN_SOURCE_CONTRACT_INVALID')
  // Canonical serialization rejects duplicate keys and ambiguous alternate
  // declarations without a second permissive JSON parser.
  if (JSON.stringify(source, null, 2) !== body.replace(/\r\n/g, '\n')) fail('PLAN_SOURCE_NONCANONICAL')
  const { kind, version, ...contract } = source
  return contract
}

export function readSourcePlan(input, options = {}) {
  if (!exactKeys(input, INPUT_KEYS) || !exactKeys(input.ref, new Set(['path', 'sha256'])) || !input.planId
    || !Number.isSafeInteger(input.expectedPlanRevision) || input.expectedPlanRevision < 0) fail('PLAN_REGISTRATION_INPUT_INVALID')
  const file = readExactPlanFile(input.ref, options)
  const source = parsePlanSource(file.text)
  if (source.planId !== input.planId) fail('PLAN_SOURCE_ID_MISMATCH')
  const plan = normalizePlan({ ...source, ref: input.ref }, { planRevision: input.expectedPlanRevision + 1 })
  const receipt = { id: 'plan-source-' + plan.planHash, kind: 'plan-ref-readback', status: 'passed',
    ref: clone(plan.ref), planHash: plan.planHash, contractHash: planDeliveryHash(source),
    sourceBytes: file.bytes, verificationScope: 'full-source-exact-contract', physicalPath: file.physical }
  return { plan, receipt }
}

export function verifyRegisteredPlanSource(plan, options = {}) {
  const current = readSourcePlan({ planId: plan.planId, ref: plan.ref, expectedPlanRevision: plan.planRevision - 1 }, options)
  if (current.plan.planHash !== plan.planHash || current.receipt.id !== plan.readbackReceiptId) fail('PLAN_REF_UNVERIFIED')
  return current.receipt
}

function bindTasks(state, plan) {
  const bindings = clone(state.taskPlanBindings ?? {})
  for (const tasks of Object.values(bindings)) {
    for (const [id, row] of Object.entries(tasks)) if (row.planId === plan.planId) delete tasks[id]
  }
  for (const item of plan.items) for (const ref of item.taskRefs) {
    bindings[ref.boardId] ??= {}
    const previous = bindings[ref.boardId][ref.taskId]
    if (previous && previous.planId !== plan.planId) fail('PLAN_TASK_ALREADY_BOUND')
    bindings[ref.boardId][ref.taskId] = { planId: plan.planId, planRevision: plan.planRevision, planHash: plan.planHash }
  }
  state.taskPlanBindings = bindings
}

export function createPlanRegistry({ control, readDurable, authorize, allowedRoots = [], maxBytes = 262144, now = Date.now }) {
  if (typeof control?.mutateHot !== 'function') fail('PLAN_REGISTRY_CONTROL_REQUIRED')
  const options = { allowedRoots, maxBytes }
  async function register(input, agent) {
    let durable
    await control.mutateHot('v15/plan-registered', { planId: input?.planId }, agent, latest => {
      const current = readSourcePlan(input, options)
      if (synchronous(authorize, 'authorize', clone(latest), clone(current.plan), agent) !== true) fail('PLAN_REGISTRATION_DENIED')
      const work = clone(latest)
      work.planRefReceipts ??= {}
      work.planRefReceipts[current.receipt.id] = current.receipt
      const timestamp = synchronous(now, 'now')
      if (!Number.isFinite(timestamp)) fail('PLAN_REGISTRY_CLOCK_INVALID')
      const result = registerPlan(work, { ...current.plan, expectedPlanRevision: input.expectedPlanRevision }, { now: timestamp })
      if (!result.ok) fail(result.code, result.detail)
      bindTasks(work.v15PlanDelivery, result.plan)
      latest.planRefReceipts = work.planRefReceipts
      latest.v15PlanDelivery = work.v15PlanDelivery
      return { ok: true, plan: clone(result.plan), sourceReceipt: clone(current.receipt) }
    }, { deferMs: 0, afterDurable(result, locked) {
      const disk = synchronous(readDurable, 'readDurable')
      if (disk?.revision !== locked.revision || disk?.rootId !== locked.rootId
        || !same(disk.v15PlanDelivery, locked.v15PlanDelivery)
        || !same(disk.planRefReceipts?.[result.sourceReceipt.id], result.sourceReceipt)) fail('PLAN_DURABLE_READBACK_MISMATCH')
      const stored = disk.v15PlanDelivery?.plans?.[result.plan.planId]
      if (!same(stored, result.plan)) fail('PLAN_DURABLE_READBACK_MISMATCH')
      verifyRegisteredPlanSource(stored, options)
      durable = { ...clone(result), durable: true }
    } })
    if (!durable) fail('PLAN_DURABLE_HOOK_UNSUPPORTED')
    return durable
  }
  return Object.freeze({ register, verify: plan => verifyRegisteredPlanSource(plan, options) })
}

// The loaded-code certificate reads this module's own source hash from here (see team-v15-window-loaded.mjs).
import { registerLoadedModule } from './team-v15-window-loaded.mjs'
registerLoadedModule(import.meta.url)
