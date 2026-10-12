import { createDeliveryAuthority } from './team-v15-delivery-authority.mjs'
import { planDeliveryHash } from './team-v15-plan-delivery.mjs'

const services = new WeakMap()
const same = (a, b) => planDeliveryHash(a) === planDeliveryHash(b)
export function deliveryPlanRequired(agent) {
  return agent?.session?.log?.some(event => event.type === 'native/goal-policy-required'
    && event.data?.sessionId === agent.session.id && event.data?.requiresPlan === true) === true
}
export function deliveryBackgroundDebt(agent) {
  const jobs = new Map()
  for (const event of agent?.session?.log ?? []) if (event.type === 'native/ptc-job') jobs.set(event.data.rootCallId, event.data)
  return [...jobs.values()].filter(row => row.action !== 'consumed' && (row.detachedAtGeneration !== undefined || row.status === 'unknown'))
    .map(row => 'ptc-job:' + row.jobId)
}
// Cordis plugins have distinct scoped contexts, but share the exact agent.
export function deliveryServiceFor(_ctx, agent) { return services.get(agent) }
export function registerDeliveryService(_ctx, agent, service) {
  services.set(agent, service)
  return () => { if (services.get(agent) === service) services.delete(agent) }
}
export function deliveryCheckCoverage(ctx, agent, durable) {
  const service = deliveryServiceFor(ctx, agent)
  if (service) return service.checkAll()
  const plans = Object.keys(durable?.v15PlanDelivery?.plans ?? {})
  const debt = deliveryBackgroundDebt(agent)
  const required = deliveryPlanRequired(agent) || plans.length > 0 || debt.length > 0
  return { required, deliverable: !required,
    ...(required && !plans.length ? { code: deliveryPlanRequired(agent) ? 'DELIVERY_PLAN_REQUIRED' : 'DELIVERY_BACKGROUND_PENDING' } : {}),
    plans: plans.map(planId => ({ planId, complete: false, deliverable: false, code: 'DELIVERY_SERVICE_UNAVAILABLE' })) }
}

export function createDeliveryService({ control, readDurable, registry, collectContext, now = Date.now, requiresPlan = () => false, agent }) {
  const authority = createDeliveryAuthority({ control, readDurable, collectContext: (state, plan) => {
    const context = collectContext(state, plan)
    return { ...context, unresolvedDebt: [...(context.unresolvedDebt ?? []), ...deliveryBackgroundDebt(agent)] }
  },
    verifyPlanReadback: plan => registry.verify(plan), now })
  function checkAll() {
    const plans = Object.keys(readDurable().v15PlanDelivery?.plans ?? {}).sort()
    const coverage = plans.map(planId => {
      try {
        const preview = authority.preview(planId)
        const receipt = Object.values(readDurable().v15PlanDelivery?.receipts ?? {}).find(row => row.planId === planId
          && row.status === 'validated' && row.planRevision === preview.planRevision && row.planHash === preview.planHash
          && row.coverageMatrixHash === preview.coverageMatrixHash && same(row.sourceRevisionVector, preview.sourceRevisionVector))
        return { ...preview, durableReceiptId: receipt?.id ?? null, deliverable: preview.complete && Boolean(receipt),
          code: !preview.complete ? 'DELIVERY_INCOMPLETE' : !receipt ? 'DELIVERY_RECEIPT_REQUIRED' : null }
      } catch (error) { return { planId, complete: false, deliverable: false, code: error.code ?? 'DELIVERY_UNAVAILABLE' } }
    })
    const debt = deliveryBackgroundDebt(agent), required = requiresPlan() === true || plans.length > 0 || debt.length > 0
    return { required, deliverable: (!required || plans.length > 0) && !debt.length && coverage.every(row => row.deliverable), plans: coverage,
      ...(required && !plans.length ? { code: requiresPlan() === true ? 'DELIVERY_PLAN_REQUIRED' : 'DELIVERY_BACKGROUND_PENDING' } : {}) }
  }
  return Object.freeze({ authority, preview: authority.preview, commit: authority.commit, checkAll })
}
