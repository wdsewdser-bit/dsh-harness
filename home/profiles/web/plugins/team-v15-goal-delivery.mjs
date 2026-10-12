import { planDeliveryHash } from './team-v15-plan-delivery.mjs'

const clone = value => structuredClone(value)
const same = (a, b) => planDeliveryHash(a) === planDeliveryHash(b)
const fail = code => { throw Object.assign(new Error(code), { code }) }

export function createGoalOutboxRecovery(gate, sessionId) {
  let lastKey
  return Object.freeze({
    onEvent(session, event) {
      if (session?.id === sessionId && event?.type === 'native/delivery-consumed') lastKey = undefined
    },
    async beforeStep(state) {
      const pending = Object.values(state.v15PlanDelivery?.outbox ?? {})
        .filter(row => row.status === 'queued' && row.consumer?.sessionId === sessionId)
        .sort((a, b) => String(a.receiptId).localeCompare(String(b.receiptId)))
      if (!pending.length) { lastKey = undefined; return null }
      const key = planDeliveryHash(pending)
      if (key === lastKey) return null
      lastKey = key
      return gate.recover()
    },
  })
}
function sync(fn, ...args) {
  if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') fail('GOAL_DELIVERY_CALLBACK_INVALID')
  const result = fn(...args)
  if (result?.then) fail('GOAL_DELIVERY_CALLBACK_INVALID')
  return result
}

export async function bindGoalDeliveryPlan({ control, readDurable, getGoal, agent, input, registry, flush }) {
  if (!input || Object.keys(input).some(key => !['planId', 'expectedGoalId', 'expectedGoalRevision'].includes(key))) fail('GOAL_PLAN_BINDING_INVALID')
  if (typeof flush !== 'function') fail('GOAL_BINDING_DURABILITY_UNAVAILABLE')
  const currentGoal = sync(getGoal), currentPlan = sync(readDurable).v15PlanDelivery?.plans?.[input.planId]
  if (!currentGoal || currentGoal.phase === 'complete' || currentGoal.id !== input.expectedGoalId
    || currentGoal.revision !== input.expectedGoalRevision) fail('GOAL_STALE_REVISION')
  if (!currentPlan) fail('PLAN_NOT_FOUND')
  registry.verify(currentPlan)
  const requirement = { version: 1, sessionId: agent.session.id, goalId: currentGoal.id,
    goalObjectiveHash: planDeliveryHash(currentGoal.objective), boundAtGoalRevision: currentGoal.revision,
    planId: currentPlan.planId, planRevision: currentPlan.planRevision, planHash: currentPlan.planHash }
  function verifyRebinding(doc) {
    const prior = doc.v15GoalBindings?.[agent.session.id]?.[currentGoal.id]
    if (!prior) return
    if (prior.planId !== requirement.planId) fail('GOAL_PLAN_REBIND_DENIED')
    if (prior.goalObjectiveHash !== requirement.goalObjectiveHash && prior.planHash === requirement.planHash) fail('GOAL_PLAN_STALE')
  }
  verifyRebinding(sync(readDurable))
  const previous = agent.session.log.findLast(event => event.type === 'native/delivery-required' && event.data?.goalId === currentGoal.id)
  // Persist the fail-closed requirement first. A crash between domains may
  // leave an unbound goal, but must never restore an unguarded completion.
  if (!same(previous?.data, requirement)) agent.session.append('native/delivery-required', requirement)
  if (await flush() !== true) fail('GOAL_BINDING_DURABILITY_UNAVAILABLE')
  let durable
  await control.mutateHot('v15/goal-plan-bound', { planId: input.planId, sessionId: agent.session.id }, agent, latest => {
    const goal = sync(getGoal)
    if (!goal || goal.phase === 'complete' || goal.id !== input.expectedGoalId || goal.revision !== input.expectedGoalRevision) fail('GOAL_STALE_REVISION')
    const plan = latest.v15PlanDelivery?.plans?.[input.planId]
    if (!plan) fail('PLAN_NOT_FOUND')
    registry.verify(plan)
    verifyRebinding(latest)
    if (plan.planRevision !== requirement.planRevision || plan.planHash !== requirement.planHash
      || planDeliveryHash(goal.objective) !== requirement.goalObjectiveHash) fail('DELIVERY_CAS_CONFLICT')
    const marker = agent.session.log.findLast(event => event.type === 'native/delivery-required' && event.data?.goalId === goal.id)
    if (!same(marker?.data, requirement)) fail('GOAL_BINDING_SUPERSEDED')
    const row = clone(requirement)
    latest.v15GoalBindings ??= {}
    latest.v15GoalBindings[row.sessionId] ??= {}
    latest.v15GoalBindings[row.sessionId][row.goalId] = row
    return row
  }, { deferMs: 0, afterDurable(row, locked) {
    const disk = sync(readDurable)
    if (disk?.revision !== locked.revision || !same(disk.v15GoalBindings?.[row.sessionId]?.[row.goalId], row)) fail('GOAL_BINDING_READBACK_MISMATCH')
    durable = { ok: true, durable: true, binding: clone(row) }
  } })
  if (!durable) fail('GOAL_BINDING_DURABILITY_UNAVAILABLE')
  return durable
}

/** The permit exists only inside the authority's synchronous durable hook. A
 * tool, model, or mere receipt id cannot call GoalService's completion commit. */
export function createGoalDeliveryGate({ agent, authority, readDurable, getGoal, flush, required = () => true }) {
  const permits = new WeakMap()
  function binding(ref) {
    const doc = sync(readDurable)
    const row = doc.v15GoalBindings?.[agent.session.id]?.[ref.id]
    const plan = doc.v15PlanDelivery?.plans?.[row?.planId]
    if (!row || row.sessionId !== agent.session.id || row.goalId !== ref.id || !plan) fail('GOAL_PLAN_UNBOUND')
    if (row.planRevision !== plan.planRevision || row.planHash !== plan.planHash) fail('DELIVERY_CAS_CONFLICT')
    return row
  }
  async function authorize({ agent: caller, ref, commit }) {
    if (caller !== agent) fail('GOAL_DELIVERY_AGENT_MISMATCH')
    const row = binding(ref)
    const current = sync(getGoal)
    if (current?.id !== ref.id || current.revision !== ref.revision) fail('GOAL_STALE_REVISION')
    if (row.goalObjectiveHash !== planDeliveryHash(current.objective)) fail('GOAL_PLAN_STALE')
    const marker = agent.session.log.findLast(event => event.type === 'native/delivery-required' && event.data?.goalId === ref.id)
    if (!same(marker?.data, row)) fail('GOAL_PLAN_UNBOUND')
    const preview = authority.preview(row.planId)
    const consumer = { kind: 'goal-completion', sessionId: agent.session.id, goalId: ref.id, goalRevision: ref.revision }
    const key = 'goal-' + planDeliveryHash({ consumer, planHash: preview.planHash, vector: preview.sourceRevisionVector })
    return authority.authorizeGoal({ planId: row.planId, previewToken: preview.previewToken, idempotencyKey: key }, { agent, consumer,
      afterDurable(result) {
        const receipt = result.receipt
        permits.set(receipt, { id: ref.id, revision: ref.revision })
        try {
          const view = sync(commit, receipt)
          agent.session.append('native/delivery-consumed', { receiptId: receipt.id, consumer,
            planId: receipt.planId, planRevision: receipt.planRevision, planHash: receipt.planHash, resultingGoalRevision: view.revision })
          return { goalId: view.id, goalRevision: view.revision }
        } finally { permits.delete(receipt) }
      } })
  }
  function verifyReceipt(receipt, { agent: caller, ref }) {
    return caller === agent && receipt?.status === 'validated' && same(permits.get(receipt), ref)
  }
  async function afterGoalDurable({ receipt: result }) {
    if (!result?.consumptionToken || !result?.receipt?.id) fail('DELIVERY_CONSUMPTION_UNVERIFIED')
    return authority.ackOutbox(result.receipt.id, { agent, consumptionToken: result.consumptionToken })
  }
  async function recover() {
    if (await flush() !== true) fail('NATIVE_DURABILITY_UNAVAILABLE')
    const doc = sync(readDurable), acknowledgments = [], pending = []
    for (const event of Object.values(doc.v15PlanDelivery?.outbox ?? {})) {
      if (event.status !== 'queued' || event.consumer?.sessionId !== agent.session.id) continue
      const consumer = event.consumer
      const effect = agent.session.log?.find(row => row.type === 'native/delivery-consumed'
        && row.data?.receiptId === event.receiptId && same(row.data.consumer, consumer))
      const goalEvent = agent.session.log?.find(row => row.type === 'goal/change' && row.data?.operation === 'complete'
        && row.data?.goal?.id === consumer.goalId && row.data?.goal?.revision === consumer.goalRevision + 1)
      if (!effect || !goalEvent || goalEvent.data.goal.phase !== 'complete' || effect.seq <= goalEvent.seq) {
        pending.push({ receiptId: event.receiptId, code: 'GOAL_EFFECT_NOT_DURABLY_PROVEN' })
        continue
      }
      const ack = await authority.ackRecoveredOutbox(event.receiptId, { agent, verifyDurableEffect(receipt, target) {
        if (!same(target, consumer) || effect.data.resultingGoalRevision !== consumer.goalRevision + 1
          || effect.data.planId !== receipt.planId || effect.data.planRevision !== receipt.planRevision || effect.data.planHash !== receipt.planHash) fail('DELIVERY_CONSUMPTION_UNVERIFIED')
        return { kind: 'durable-goal-effect', receiptId: receipt.id, consumer: clone(target),
          goalEventSeq: goalEvent.seq, effectEventSeq: effect.seq, resultingGoalRevision: consumer.goalRevision + 1 }
      } })
      acknowledgments.push(ack.receiptId)
    }
    return { ok: true, acknowledged: acknowledgments, pending }
  }
  async function requireDurable() {
    if (await flush() !== true) fail('NATIVE_DURABILITY_UNAVAILABLE')
  }
  return Object.freeze({ isBound: caller => caller === agent && sync(required) === true,
    authorize, verifyReceipt, requireDurable, afterGoalDurable, recover })
}
