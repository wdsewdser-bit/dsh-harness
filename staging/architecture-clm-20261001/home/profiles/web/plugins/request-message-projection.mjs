import * as profileLlm from '@deepseek-ai/dsh-llm'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const name = 'request-message-projection'
export const inject = ['llm']
export const provide = ['requestMessageProjection']
const METHOD = 'streamWithRegistration'
const ORIGINAL = Symbol.for('cordis.original')
const BRIDGE = Symbol.for('dsh.request-message-projection.bridge')
const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool'])
const moduleHash = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex')
const digest = value => createHash('sha256').update(value).digest('hex')

function measurement(messages) {
  try {
    const text = JSON.stringify(messages)
    return { bytes: Buffer.byteLength(text), sha256: digest(text) }
  } catch { return { bytes: null, sha256: null } }
}

function difference(before, after) {
  try {
    const left = Buffer.from(JSON.stringify(before))
    const right = Buffer.from(JSON.stringify(after))
    let prefix = 0
    while (prefix < Math.min(left.length, right.length) && left[prefix] === right[prefix]) prefix++
    const first = before.findIndex((message, index) => JSON.stringify(message) !== JSON.stringify(after[index]))
    return { commonPrefixBytes: prefix, firstChangedMessageIndex: first >= 0 ? first : before.length === after.length ? null : before.length }
  } catch { return { commonPrefixBytes: null, firstChangedMessageIndex: null } }
}

function failure(code) {
  return Object.assign(new Error(code), { code })
}

function targetOf(llm) {
  return llm?.[ORIGINAL] ?? llm
}

function freezeJson(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) throw failure('CYCLIC_MESSAGE_VALUE')
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw failure('UNKNOWN_MESSAGE_VALUE')
  seen.add(value)
  for (const child of Object.values(value)) freezeJson(child, seen)
  seen.delete(value)
  return Object.freeze(value)
}

function snapshotMessages(messages) {
  const recognizedBlock = block => {
    if (!block || typeof block !== 'object') return false
    if (block.type === 'text' || block.type === 'reasoning') return typeof block.text === 'string'
    if (block.type === 'image' || block.type === 'file') return block.attachment !== null && typeof block.attachment === 'object'
    if (block.type === 'tool-call') return typeof block.id === 'string' && typeof block.name === 'string' && typeof block.arguments === 'string'
    if (block.type === 'tool-addition' || block.type === 'tool-removal') return typeof block.toolName === 'string'
    return false
  }
  if (!Array.isArray(messages) || ![...messages].every(message => message && ROLES.has(message.role)
    && typeof message.id === 'string' && typeof message.source?.kind === 'string'
    && Array.isArray(message.content) && [...message.content].every(recognizedBlock))) throw failure('UNKNOWN_MESSAGES')
  return freezeJson(structuredClone(messages))
}

function metadataSummary(result) {
  try {
    const metadata = Object.fromEntries(Object.entries(result).filter(([key, value]) => key !== 'messages' && typeof value !== 'function'))
    const serialized = JSON.stringify(metadata)
    return Object.freeze({ fields: Object.keys(metadata).length, sha256: digest(serialized) })
  } catch {
    return Object.freeze({ fields: null, sha256: null })
  }
}

export async function officialModuleFor(llm, config = {}) {
  if (typeof config.resolveLlmModule === 'function') {
    const resolved = await config.resolveLlmModule(llm)
    if (resolved?.LlmRuntime && llm instanceof resolved.LlmRuntime) return resolved
  }
  if (llm instanceof profileLlm.LlmRuntime) return profileLlm
  try {
    const app = await import(new URL('../../../../app/node_modules/@deepseek-ai/dsh-llm/lib/index.js', import.meta.url).href)
    if (llm instanceof app.LlmRuntime) return app
  } catch { /* A standalone profile may not have the sibling app copy. */ }
  throw failure('REQUEST_MESSAGE_PROJECTION_LLM_MODULE_UNRESOLVED')
}

/** Install on one real runtime instance; never replace its class prototype. */
export function installRequestMessageProjection(llm, officialLlm, config = {}) {
  const target = targetOf(llm)
  const original = target?.[METHOD]
  if (typeof original !== 'function') throw failure('REQUEST_MESSAGE_PROJECTION_BOUNDARY_UNAVAILABLE')
  if (typeof officialLlm?.isAgentLoopRequest !== 'function' || typeof officialLlm?.markAgentLoopRequest !== 'function') throw failure('REQUEST_MESSAGE_PROJECTION_BRAND_UNAVAILABLE')
  if (typeof officialLlm.LlmRuntime !== 'function' || !(target instanceof officialLlm.LlmRuntime)) throw failure('REQUEST_MESSAGE_PROJECTION_LLM_MODULE_MISMATCH')
  if (original[BRIDGE]) throw failure('REQUEST_MESSAGE_PROJECTION_ALREADY_INSTALLED')
  const descriptor = Object.getOwnPropertyDescriptor(target, METHOD)
  if ((!descriptor && !Object.isExtensible(target)) || (descriptor && !descriptor.configurable && !descriptor.writable)) throw failure('REQUEST_MESSAGE_PROJECTION_BOUNDARY_IMMUTABLE')
  const registrations = new Map()
  const receipts = new WeakMap()
  const plans = new WeakMap()
  const recent = []
  const limit = Number.isSafeInteger(config.maxAuditRecords) && config.maxAuditRecords > 0 ? Math.min(config.maxAuditRecords, 1024) : 64
  let serial = 0
  let calls = 0
  let disposed = false

  const publish = (plan) => {
    const receipt = freezeJson(structuredClone(plan.receipt))
    if (plan.input && typeof plan.input === 'object') receipts.set(plan.input, receipt)
    if (plan.options && typeof plan.options === 'object') receipts.set(plan.options, receipt)
    if (plan.adapterOptions) receipts.set(plan.adapterOptions, receipt)
    const existing = recent.findIndex(row => row.requestId === receipt.requestId)
    if (existing >= 0) recent[existing] = receipt
    else recent.push(receipt)
    if (recent.length > limit) recent.shift()
    return receipt
  }
  const envelope = (options, messages, readonly = false) => {
    const properties = Object.getOwnPropertyDescriptors(options)
    properties.messages = { value: messages, writable: true, configurable: true, enumerable: properties.messages?.enumerable ?? true }
    if (readonly) {
      for (const key of ['tools', 'toolHistory']) {
        if (properties[key] && 'value' in properties[key] && properties[key].value !== undefined) {
          properties[key] = { ...properties[key], value: freezeJson(structuredClone(properties[key].value)) }
        }
      }
    }
    const projected = Object.create(Object.getPrototypeOf(options), properties)
    if (officialLlm.isAgentLoopRequest(options)) officialLlm.markAgentLoopRequest(projected)
    return readonly || Object.isFrozen(options) ? Object.freeze(projected) : projected
  }
  function build(options, preview = false) {
    let projected = options
    const rows = []
    const results = []
    if (!disposed && registrations.size && options && typeof options === 'object') {
      let messages
      try { messages = snapshotMessages(options.messages) } catch { rows.push({ status: 'skipped-unrecognized-request' }) }
      if (messages) {
        for (const registration of [...registrations.values()].sort((a, b) => a.order - b.order || a.serial - b.serial)) {
          const row = { id: registration.id, order: registration.order, beforeMessages: messages.length }
          try {
            const input = envelope(options, messages, true)
            const transform = preview ? registration.preview : registration.transform
            if (!transform) {
              row.status = 'skipped-no-pure-preview'
              row.afterMessages = messages.length
              rows.push(row)
              continue
            }
            const result = transform(input)
            if (result && typeof result.then === 'function') {
              Promise.resolve(result).catch(() => {})
              row.status = 'skipped-async-transform'
            } else if (!result || typeof result !== 'object' || !Array.isArray(result.messages)) {
              row.status = 'skipped-invalid-result'
            } else {
              row.metadata = metadataSummary(result)
              if (result.messages === messages) row.status = 'unchanged'
              else {
                const nextMessages = snapshotMessages(result.messages)
                const nextOptions = envelope(options, nextMessages)
                messages = nextMessages
                projected = nextOptions
                row.status = 'applied'
              }
              results.push({ registration, result, inputOptions: input })
            }
          } catch { row.status = 'failed-open' }
          row.afterMessages = messages.length
          rows.push(row)
        }
      }
    }
    const receipt = {
      version: 2, pid: process.pid, requestId: preview ? null : randomUUID(), call: null,
      stage: preview ? 'preview' : 'prepared', sessionId: typeof options?.sessionId === 'string' ? options.sessionId : null,
      provider: typeof options?.provider === 'string' ? options.provider : null,
      model: typeof options?.model === 'string' ? options.model : null,
      purpose: typeof options?.purpose === 'string' ? options.purpose : 'conversation',
      turnId: typeof options?.turnId === 'string' ? options.turnId : null,
      taskId: typeof options?.taskId === 'string' ? options.taskId : null,
      workflowId: typeof options?.workflowId === 'string' ? options.workflowId : null,
      before: measurement(options?.messages), after: measurement(projected?.messages),
      ...difference(options?.messages, projected?.messages), transforms: rows, changed: projected !== options,
      handedToAdapter: false, providerReceipt: 'unknown',
      preparedSnapshot: false,
      measurementSource: 'request-message-JSON; not wire bytes or provider tokens',
    }
    return { input: options, options: projected, receipt, results, adopted: false }
  }
  function wrapped(options, prepared) {
    let plan = plans.get(options)
    if (!plan || plan.adopted) plan = build(options)
    plan.adopted = true
    plan.receipt.call = ++calls
    plan.receipt.stage = 'attempted'
    plan.receipt.preparedGeneration = prepared ? 'retained-native-prepared-registration' : 'native-resolution-at-dispatch'
    plan.receipt.preparedConfig = prepared?.config ? measurement(prepared.config) : null
    plans.set(plan.options, plan)
    publish(plan)
    // Cordis supplies a caller-specific shadow receiver; retain it as well as
    // the prepared registration and the original stream/iterator behavior.
    return original.call(this, plan.options, prepared)
  }
  const nativeAdapterStream = target.adapterStream
  const adapterDescriptor = Object.getOwnPropertyDescriptor(target, 'adapterStream')
  if (typeof nativeAdapterStream !== 'function' || typeof target.forAdapter !== 'function') throw failure('REQUEST_MESSAGE_PROJECTION_ADAPTER_BOUNDARY_UNAVAILABLE')
  if ((!adapterDescriptor && !Object.isExtensible(target)) || (adapterDescriptor && !adapterDescriptor.configurable && !adapterDescriptor.writable)) throw failure('REQUEST_MESSAGE_PROJECTION_ADAPTER_BOUNDARY_IMMUTABLE')
  function adapterWrapped(options, prepared) {
    const plan = plans.get(options)
    const receiver = Object.create(this)
    const nativeForAdapter = this.forAdapter
    Object.defineProperty(receiver, 'forAdapter', { value: function(finalOptions, adapter) {
      if (finalOptions.signal?.aborted) throw Object.assign(new Error('request aborted before adapter'), { code: 'ABORTED' })
      const forwarded = nativeForAdapter.call(this, finalOptions, adapter)
      if (plan && !plan.receipt.handedToAdapter) {
        plan.adapterOptions = forwarded
        plan.receipt.stage = 'handed-to-adapter'
        plan.receipt.handedToAdapter = true
        plan.receipt.handedAt = new Date().toISOString()
        plan.receipt.adapterPayload = measurement(forwarded.messages)
        const receipt = publish(plan)
        for (const { registration, result, inputOptions } of plan.results) {
          try {
            const observed = registration.onDispatch?.({ options: forwarded, inputOptions, result, receipt })
            if (observed && typeof observed.catch === 'function') observed.catch(() => {})
          } catch { /* Observers cannot veto dispatch. */ }
        }
      }
      return forwarded
    }, configurable: true })
    return nativeAdapterStream.call(receiver, options, prepared)
  }
  Object.defineProperty(wrapped, BRIDGE, { value: true })
  Object.defineProperty(target, METHOD, descriptor && !descriptor.configurable
    ? { ...descriptor, value: wrapped }
    : { value: wrapped, writable: true, configurable: true, enumerable: descriptor?.enumerable ?? false })
  Object.defineProperty(target, 'adapterStream', adapterDescriptor && !adapterDescriptor.configurable
    ? { ...adapterDescriptor, value: adapterWrapped }
    : { value: adapterWrapped, writable: true, configurable: true, enumerable: adapterDescriptor?.enumerable ?? false })
  const service = {
    isAgentLoopRequest(options) { return officialLlm.isAgentLoopRequest(options) },
    register(id, transform, { order = 0, preview, onDispatch } = {}) {
      if (disposed) throw failure('REQUEST_MESSAGE_PROJECTION_DISPOSED')
      if (typeof id !== 'string' || !/^[A-Za-z0-9_.:/-]{1,100}$/.test(id) || typeof transform !== 'function' || !Number.isFinite(order)) throw failure('REQUEST_MESSAGE_PROJECTION_INVALID_REGISTRATION')
      if (registrations.has(id)) throw failure('REQUEST_MESSAGE_PROJECTION_DUPLICATE_ID')
      if ((preview !== undefined && typeof preview !== 'function') || (onDispatch !== undefined && typeof onDispatch !== 'function')) throw failure('REQUEST_MESSAGE_PROJECTION_INVALID_REGISTRATION')
      const registration = { id, transform, preview, onDispatch, order, serial: ++serial }
      registrations.set(id, registration)
      return () => { if (registrations.get(id) === registration) registrations.delete(id) }
    },
    preview(options) {
      const plan = build(options, true)
      return Object.freeze({ options: plan.options, receipt: freezeJson(plan.receipt) })
    },
    prepare(options) {
      if (disposed) throw failure('REQUEST_MESSAGE_PROJECTION_DISPOSED')
      const plan = build(options)
      try {
        plan.options = envelope(plan.options, snapshotMessages(plan.options.messages), true)
        plan.receipt.preparedSnapshot = true
        plans.set(plan.options, plan)
      } catch {
        plan.options = options
        plan.results = []
        plan.receipt.stage = 'unprepared-fail-open'
        plan.receipt.changed = false
        plan.receipt.after = measurement(options?.messages)
        Object.assign(plan.receipt, difference(options?.messages, options?.messages))
        plan.receipt.transforms = plan.receipt.transforms.map(row => row.status === 'applied' ? { ...row, status: 'failed-open-unlocked-plan' } : row)
      }
      const receipt = publish(plan)
      return Object.freeze({ options: plan.options, receipt })
    },
    audit(options, requestId) {
      if (requestId) return recent.find(row => row.requestId === requestId) ?? null
      return options ? receipts.get(options) ?? null : Object.freeze([...recent])
    },
    capture(options) {
      const plan = plans.get(options)
      return plan ? () => freezeJson(structuredClone(plan.receipt)) : () => null
    },
    stats() { return Object.freeze({ version: 2, pid: process.pid, moduleHash, boundary: `llm.${METHOD}+adapterStream.forAdapter`, registrations: registrations.size, calls, disposed, installed: Object.getOwnPropertyDescriptor(target, METHOD)?.value === wrapped && Object.getOwnPropertyDescriptor(target, 'adapterStream')?.value === adapterWrapped }) },
    resetRegistrations() { if (disposed) throw failure('REQUEST_MESSAGE_PROJECTION_DISPOSED'); registrations.clear() },
    dispose() {
      if (disposed) return
      disposed = true
      registrations.clear()
      if (Object.getOwnPropertyDescriptor(target, 'adapterStream')?.value === adapterWrapped) {
        if (adapterDescriptor) Object.defineProperty(target, 'adapterStream', adapterDescriptor)
        else delete target.adapterStream
      }
      if (Object.getOwnPropertyDescriptor(target, METHOD)?.value !== wrapped) return
      if (descriptor) Object.defineProperty(target, METHOD, descriptor)
      else delete target[METHOD]
    },
  }
  return Object.freeze(service)
}

export async function apply(ctx, config = {}) {
  const llm = targetOf(ctx.llm)
  if (typeof llm?.[METHOD] !== 'function') throw failure('REQUEST_MESSAGE_PROJECTION_BOUNDARY_UNAVAILABLE')
  const officialLlm = await officialModuleFor(llm, config)
  const service = installRequestMessageProjection(llm, officialLlm, config)
  let unprovide
  try { unprovide = ctx.provide('requestMessageProjection', service) } catch (error) { service.dispose(); throw error }
  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    service.dispose()
    await unprovide?.()
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
  dispose.service = service
  return dispose
}
