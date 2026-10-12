import { createDeliveryAuthority } from './team-v15-delivery-authority.mjs'
import { planDeliveryHash } from './team-v15-plan-delivery.mjs'

const services = new WeakMap()
const same = (a, b) => planDeliveryHash(a) === planDeliveryHash(b)
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
  return { required: plans.length > 0, deliverable: !plans.length,
    plans: plans.map(planId => ({ planId, complete: false, deliverable: false, code: 'DELIVERY_SERVICE_UNAVAILABLE' })) }
}

export function createDeliveryService({ control, readDurable, registry, collectContext, now = Date.now }) {
  const authority = createDeliveryAuthority({ control, readDurable, collectContext,
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
    return { required: plans.length > 0, deliverable: coverage.every(row => row.deliverable), plans: coverage }
  }
  return Object.freeze({ authority, preview: authority.preview, commit: authority.commit, checkAll })
}
