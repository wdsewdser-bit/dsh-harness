import { randomUUID } from 'node:crypto'
import { commitPlanDelivery, evaluatePlanDelivery, planDeliveryHash } from './team-v15-plan-delivery.mjs'

const clone = (value) => structuredClone(value)
const same = (left, right) => planDeliveryHash(left) === planDeliveryHash(right)
function refuse(code, detail) { throw Object.assign(new Error(detail), { code }) }
function requireSync(fn, label) {
  if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') refuse('DELIVERY_ASYNC_CALLBACK_REJECTED', label + ' must be a synchronous server callback')
}
function callSync(fn, label, ...args) {
  requireSync(fn, label)
  const result = fn(...args)
  if (result && typeof result.then === 'function') refuse('DELIVERY_ASYNC_CALLBACK_REJECTED', label + ' returned a thenable')
  return result
}
function boundRequest(preview, idempotencyKey) {
  return { planId: preview.planId, idempotencyKey, expectedPlanRevision: preview.planRevision,
    expectedPlanHash: preview.planHash, sourceIdentity: clone(preview.sourceIdentity),
    coverageMatrixHash: preview.coverageMatrixHash, sourceRevisionVector: clone(preview.sourceRevisionVector) }
}

/** The injected callbacks are server-owned. A tool request supplies only CAS
 * bindings; it cannot provide context, proof records, or a durable reader. */
export function createDeliveryAuthority({ control, readDurable, collectContext, verifyPlanReadback, now = Date.now }) {
  if (typeof control?.mutateHot !== 'function') refuse('DELIVERY_AUTHORITY_INVALID', 'control.mutateHot is required')
  for (const [label, fn] of Object.entries({ readDurable, collectContext, verifyPlanReadback, now })) requireSync(fn, label)
  const previews = new Map()
  const consumptionTokens = new Map()
  function at() {
    const value = callSync(now, 'now')
    if (!Number.isFinite(value)) refuse('DELIVERY_AUTHORITY_INVALID', 'server clock is invalid')
    return value
  }
  function collect(snapshot, planId) {
    const work = clone(snapshot)
    const plan = work.v15PlanDelivery?.plans?.[planId]
    if (!plan) refuse('PLAN_NOT_FOUND', 'the exact registered plan is required')
    const context = callSync(collectContext, 'collectContext', clone(work), clone(plan))
    if (!context || typeof context !== 'object' || Array.isArray(context)) refuse('DELIVERY_CONTEXT_UNVERIFIED', 'server context collection failed')
    const receipt = callSync(verifyPlanReadback, 'verifyPlanReadback', clone(plan), clone(work))
    if (!receipt || receipt.id !== plan.readbackReceiptId || receipt.kind !== 'plan-ref-readback'
      || receipt.status !== 'passed' || !same(receipt.ref, plan.ref) || receipt.planHash !== plan.planHash
      || (Array.isArray(receipt.staleReasons) && receipt.staleReasons.length)) {
      refuse('PLAN_REF_UNVERIFIED', 'server plan readback must match the exact registered file and full contract')
    }
    work.v15DeliveryContext = clone(context)
    work.planRefReceipts = { ...work.planRefReceipts, [receipt.id]: clone(receipt) }
    return work
  }
  function preview(planId) {
    const snapshot = callSync(readDurable, 'readDurable')
    const work = collect(snapshot, planId)
    const evaluation = evaluatePlanDelivery(work, planId, { now: at() })
    if (!evaluation.ok) refuse(evaluation.code, evaluation.detail)
    const previewToken = randomUUID()
    previews.set(previewToken, clone(evaluation))
    if (previews.size > 256) previews.delete(previews.keys().next().value)
    return { ...clone(evaluation), previewToken }
  }
  async function commit(input, options = {}) {
    if (options.afterDurable !== undefined) requireSync(options.afterDurable, 'afterDurable')
    const request = clone(input)
    let durableResult
    let hookRan = false
    await control.mutateHot('v15/delivery-validated', { planId: request.planId, idempotencyKey: request.idempotencyKey }, options.agent, (latest) => {
      const work = collect(latest, request.planId)
      const result = commitPlanDelivery(work, request, { now: at() })
      if (!result.ok) refuse(result.code, result.detail)
      if (options.consumer !== undefined) {
        const consumer = clone(options.consumer)
        if (consumer.kind !== 'goal-completion' || !consumer.sessionId || !consumer.goalId
          || !Number.isSafeInteger(consumer.goalRevision) || consumer.goalRevision < 1) refuse('DELIVERY_CONSUMER_INVALID', 'invalid server goal binding')
        const event = work.v15PlanDelivery.outbox[result.receipt.id]
        if (result.replayed && !same(event.consumer, consumer)) refuse('DELIVERY_CAS_CONFLICT', 'the durable outbox is bound to a different consumer')
        event.consumer = consumer
      }
      latest.v15DeliveryContext = work.v15DeliveryContext
      latest.planRefReceipts = work.planRefReceipts
      latest.v15PlanDelivery = work.v15PlanDelivery
      return clone(result)
    }, { deferMs: 0, afterDurable(result, lockedDurable) {
      hookRan = true
      const disk = callSync(readDurable, 'readDurable')
      const stored = disk?.v15PlanDelivery?.receipts?.[result.receipt.id]
      if (disk?.revision !== lockedDurable?.revision || disk?.rootId !== lockedDurable?.rootId
        || !same(stored, result.receipt) || !same(disk?.v15PlanDelivery, lockedDurable?.v15PlanDelivery)) {
        refuse('DELIVERY_DURABLE_READBACK_MISMATCH', 'durable snapshot or exact delivery receipt does not match the locked commit')
      }
      const current = collect(disk, request.planId)
      const replay = commitPlanDelivery(current, request, { now: at() })
      if (!replay.ok || !same(replay.receipt, stored)) refuse(replay.code ?? 'DELIVERY_DURABLE_READBACK_MISMATCH', replay.detail ?? 'current source authority changed after persistence')
      const event = disk.v15PlanDelivery.outbox?.[stored.id]
      if (!event || event.receiptId !== stored.id || !['queued', 'consumed'].includes(event.status)) refuse('DELIVERY_OUTBOX_INVALID', 'the durable outbox event is missing or invalid')
      durableResult = { ...clone(result), durable: true, outboxStatus: event.status }
      if (options.afterDurable && event.status === 'queued') {
        const consumption = callSync(options.afterDurable, 'afterDurable', clone(durableResult), clone(disk))
        if (consumption === false || consumption?.ok === false) refuse('DELIVERY_CONSUMER_REJECTED', 'the synchronous durable consumer rejected delivery')
        const consumptionToken = randomUUID()
        consumptionTokens.set(consumptionToken, { receiptId: stored.id, requestHash: stored.requestHash,
          receiptHash: planDeliveryHash(stored), consumerHash: planDeliveryHash(event.consumer ?? null) })
        durableResult.consumptionToken = consumptionToken
        if (consumption !== undefined) durableResult.consumption = clone(consumption)
      }
    } })
    if (!hookRan || !durableResult) refuse('DELIVERY_DURABLE_HOOK_UNSUPPORTED', 'control did not execute the synchronous durable hook')
    return durableResult
  }
  function authorizeGoal(input, options = {}) {
    let request
    if (input?.previewToken) {
      const cached = previews.get(input.previewToken)
      if (!cached || cached.planId !== input.planId) refuse('DELIVERY_BOUND_REQUEST_REQUIRED', 'server preview token does not bind this registered plan')
      request = boundRequest(cached, input.idempotencyKey)
    } else if (input?.boundRef && input.boundRef.planId === input.planId) {
      request = { ...clone(input.boundRef), idempotencyKey: input.idempotencyKey }
    } else refuse('DELIVERY_BOUND_REQUEST_REQUIRED', 'goal completion requires an exact boundRef or server preview token')
    return commit(request, options)
  }
  async function ackOutbox(receiptId, options = {}) {
    const consumed = consumptionTokens.get(options.consumptionToken)
    if (!consumed || consumed.receiptId !== receiptId) refuse('DELIVERY_CONSUMPTION_UNVERIFIED', 'only a successful synchronous durable consumer can acknowledge the outbox')
    let acknowledged
    await control.mutateHot('v15/delivery-outbox-acknowledged', { receiptId }, options.agent, (latest) => {
      const state = clone(latest.v15PlanDelivery)
      const receipt = state?.receipts?.[receiptId]
      const event = state?.outbox?.[receiptId]
      if (!receipt || receipt.requestHash !== consumed.requestHash || planDeliveryHash(receipt) !== consumed.receiptHash
        || !event || event.receiptId !== receiptId || planDeliveryHash(event.consumer ?? null) !== consumed.consumerHash
        || !['queued', 'consumed'].includes(event.status)) refuse('DELIVERY_OUTBOX_INVALID', 'receipt or outbox changed before acknowledgment')
      event.status = 'consumed'
      event.consumedAt ??= at()
      latest.v15PlanDelivery = state
      return { receiptId, event: clone(event) }
    }, { deferMs: 0, afterDurable(result, lockedDurable) {
      const disk = callSync(readDurable, 'readDurable')
      if (disk?.revision !== lockedDurable?.revision || disk?.rootId !== lockedDurable?.rootId
        || planDeliveryHash(disk.v15PlanDelivery?.receipts?.[receiptId]) !== consumed.receiptHash
        || !same(disk.v15PlanDelivery?.outbox?.[receiptId], result.event)) refuse('DELIVERY_DURABLE_READBACK_MISMATCH', 'outbox acknowledgment was not read back exactly')
      acknowledged = { ok: true, durable: true, ...clone(result) }
    } })
    if (!acknowledged) refuse('DELIVERY_DURABLE_HOOK_UNSUPPORTED', 'control did not verify durable outbox acknowledgment')
    consumptionTokens.delete(options.consumptionToken)
    return acknowledged
  }
  async function ackRecoveredOutbox(receiptId, { agent, verifyDurableEffect } = {}) {
    requireSync(verifyDurableEffect, 'verifyDurableEffect')
    let durable
    await control.mutateHot('v15/delivery-outbox-recovered', { receiptId }, agent, latest => {
      const work = clone(latest.v15PlanDelivery)
      const receipt = work?.receipts?.[receiptId], event = work?.outbox?.[receiptId]
      if (!receipt || receipt.status !== 'validated' || !event || event.receiptId !== receiptId
        || event.consumer?.kind !== 'goal-completion' || !['queued', 'consumed'].includes(event.status)) refuse('DELIVERY_OUTBOX_INVALID', 'a canonical goal outbox is required')
      const proof = callSync(verifyDurableEffect, 'verifyDurableEffect', clone(receipt), clone(event.consumer))
      if (proof?.kind !== 'durable-goal-effect' || proof.receiptId !== receiptId || !same(proof.consumer, event.consumer)) {
        refuse('DELIVERY_CONSUMPTION_UNVERIFIED', 'the exact durable goal effect must be recovered from the server session')
      }
      event.status = 'consumed'
      event.consumedAt ??= at()
      event.recoveryProof = clone(proof)
      latest.v15PlanDelivery = work
      return { receiptId, event: clone(event) }
    }, { deferMs: 0, afterDurable(result, locked) {
      const disk = callSync(readDurable, 'readDurable')
      if (disk?.revision !== locked.revision || disk?.rootId !== locked.rootId
        || !same(disk.v15PlanDelivery?.outbox?.[receiptId], result.event)) refuse('DELIVERY_DURABLE_READBACK_MISMATCH', 'recovered outbox acknowledgment was not read back exactly')
      durable = { ok: true, durable: true, ...clone(result) }
    } })
    if (!durable) refuse('DELIVERY_DURABLE_HOOK_UNSUPPORTED', 'recovery requires durable control-plane readback')
    return durable
  }
  return Object.freeze({ preview, commit, authorizeGoal, ackOutbox, ackRecoveredOutbox })
}
