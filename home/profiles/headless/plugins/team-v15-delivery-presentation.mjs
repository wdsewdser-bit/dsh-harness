import { planDeliveryHash } from './team-v15-plan-delivery.mjs'

// Raw assistant prose remains a statement. Only the existing delivery
// authority supplies this separately rendered, timestamped verification.
export function deliveryPresentation(agent, service, turn) {
  const coverage = service.checkAll()
  if (!coverage.required) return null
  const plans = coverage.plans.map(plan => ({ planId: plan.planId, planRevision: plan.planRevision ?? null,
    planHash: plan.planHash ?? null, complete: plan.complete === true, receiptId: plan.durableReceiptId ?? null,
    remainingScope: plan.remainingScope ?? [], code: plan.code ?? null }))
  const accepted = coverage.deliverable === true && plans.length > 0 && plans.every(plan => plan.complete && plan.receiptId)
  return { version: 1, sessionId: agent.session.id, ...(Number.isSafeInteger(turn) ? { turn } : {}),
    status: accepted ? 'accepted' : 'partial', plans,
    ...(!plans.length && ['DELIVERY_PLAN_REQUIRED', 'DELIVERY_BACKGROUND_PENDING'].includes(coverage.code) ? { code: coverage.code } : {}) }
}

export function installDeliveryPresentation(ctx, agent, service, flush) {
  function publish(turn) {
    const value = deliveryPresentation(agent, service, turn)
    if (!value) return null
    const previous = agent.session.log.findLast(event => event.type === 'native/delivery-status')
    if (previous && planDeliveryHash({ ...previous.data, checkedAt: undefined }) === planDeliveryHash({ ...value, checkedAt: undefined })) return previous
    return agent.session.append('native/delivery-status', { ...value, checkedAt: Date.now() })
  }
  const stop = ctx.on('agent/turn-stopping', async event => {
    if (event.agent !== agent) return
    publish(event.turn)
    if (await flush() !== true) throw Object.assign(new Error('NATIVE_DURABILITY_UNAVAILABLE'), { code: 'NATIVE_DURABILITY_UNAVAILABLE' })
  })
  // GoalService flushes its whole canonical suffix after the synchronous
  // completion commit, including this receipt-backed presentation event.
  const goal = ctx.on('session/event', (session, event) => {
    if (session === agent.session && event.type === 'goal/change' && event.data.operation === 'complete') publish()
  })
  return { publish, dispose() { goal(); stop() } }
}
