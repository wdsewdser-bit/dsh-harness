import { aggregateWindowUsage, evaluateWindowEconomics } from './team-v15-window-economics.mjs'
import { observeStream, resolveProjection } from './request-usage-ledger.mjs'

export const name = 'team-v15-window-economics-runtime'
export const inject = ['llm', 'agents', 'requestMessageProjection']
export const provide = ['windowEconomics']

const MAX_RECORDS = 100_000
const MAX_SESSIONS = 4096
const TOKEN_FIELDS = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens', 'totalTokens']

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 160 ? value.trim() : null
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const safely = (fn, fallback = null) => { try { return fn() ?? fallback } catch { return fallback } }

function service(ctx, key) { return safely(() => ctx.get?.(key) ?? ctx[key]) }
function sessionId(agent) { return text(agent?.session?.id) ?? text(agent?.id) }

function measurement(value) {
  if (!object(value)) return null
  const hash = typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(value.sha256) ? value.sha256 : null
  return { bytes: numeric(value.bytes), sha256: hash }
}

function receiptSnapshot(value) {
  if (!object(value)) return null
  return {
    requestId: text(value.requestId), sessionId: text(value.sessionId),
    stage: text(value.stage), handedToAdapter: value.handedToAdapter === true,
    providerReceipt: text(value.providerReceipt) ?? 'unknown',
    before: measurement(value.before), after: measurement(value.after),
    adapterPayload: measurement(value.adapterPayload),
  }
}

function boundedLimit(value) {
  const requested = Number(value)
  return Number.isInteger(requested) ? Math.max(1, Math.min(MAX_RECORDS, requested)) : 4096
}

function toolFor(agent, ownerSessionId, readSession) {
  return {
    name: 'window_economics',
    description: "Read this session's observed window receipt and provider usage in shadow mode.",
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: true,
    async execute(_args, exec) {
      const callerSessionId = sessionId(exec?.agent)
      if (exec !== undefined && callerSessionId !== ownerSessionId) {
        return { ok: false, code: 'WINDOW_ECONOMICS_SCOPE_DENIED' }
      }
      return readSession(agent)
    },
  }
}

export function apply(ctx, config = {}) {
  const maxBufferRecords = boundedLimit(config.maxBufferRecords)
  const records = []
  const terminalKeys = new Map()
  const owners = new Map()
  const listeners = []
  let attemptSequence = 0
  let droppedRecords = 0
  let duplicateTerminalRecords = 0
  let disposed = false
  let disposePromise
  let unprovide

  function stats() {
    return {
      mode: 'shadow', automaticActionsEnabled: false,
      bufferedRecords: records.length, maxBufferRecords,
      droppedRecords, duplicateTerminalRecords, sessions: owners.size, disposed,
    }
  }

  function readSession(agent) {
    if (disposed) return { ok: false, code: 'WINDOW_ECONOMICS_DISPOSED' }
    const id = sessionId(agent)
    const owner = id === null ? null : owners.get(id)
    if (!owner || owner.agent !== agent) return { ok: false, code: 'WINDOW_ECONOMICS_SCOPE_DENIED' }
    const scopedRecords = records.filter(row => row.sessionId === id)
    const aggregate = aggregateWindowUsage(scopedRecords, { memberSessionIds: [id] })
    const usage = {
      membership: aggregate.membership, activity: aggregate.activity, purposes: aggregate.purposes,
      tokens: aggregate.usage.tokens, bytes: aggregate.usage.bytes, fees: aggregate.usage.fees,
      dedup: aggregate.dedup,
    }
    const latest = scopedRecords.at(-1) ?? null
    const route = latest ? {
      provider: latest.provider, model: latest.model, protocol: latest.protocol,
    } : { provider: null, model: null, protocol: null }
    const receipt = latest?.requestProjection ?? null
    const estimates = receipt ? {
      current: receipt.before ? { ...receipt.before, unit: 'bytes', source: 'request-message-JSON; not provider tokens' } : null,
      projected: receipt.after ? { ...receipt.after, unit: 'bytes', source: 'request-message-JSON; not provider tokens' } : null,
    } : {}
    const economics = evaluateWindowEconomics({
      route, estimates, pricing: { known: false }, priceKnown: false,
    })
    return {
      ok: true, mode: 'shadow',
      window: {
        sessionId: id, requestId: latest?.requestId ?? null,
        attemptId: latest?.attemptId ?? null, purpose: latest?.purpose ?? null,
        route, receipt, terminalReceipt: latest?.terminalReceipt ?? null,
      },
      usage,
      economics,
    }
  }

  function readSnapshot(agent) { return readSession(agent) }

  function terminalKey(record) {
    return `${record.sessionId}\u0000${record.requestId}\u0000${record.attemptId}\u0000${record.terminalId}`
  }

  function acceptTerminal(record) {
    if (disposed || !object(record) || record.event !== 'terminal') return
    const id = text(record.sessionId)
    const owner = id === null ? null : owners.get(id)
    const receipt = receiptSnapshot(record.requestProjection)
    if (!owner || receipt?.handedToAdapter !== true || receipt.stage !== 'handed-to-adapter') return

    const requestId = text(record.requestId) ?? receipt.requestId
    const attemptId = text(record.attemptId)
    if (requestId === null || attemptId === null) return
    const terminalId = text(record.providerRequestId) ?? `${requestId}:${attemptId}:terminal`
    const normalized = {
      version: 1, event: 'terminal', status: text(record.status) ?? 'unclassified',
      complete: record.complete === true,
      requestId, attemptId, terminalId, sessionId: id,
      provider: text(record.provider), model: text(record.model), protocol: text(record.protocol),
      requestProjection: { ...receipt, requestId },
      providerRequestId: text(record.providerRequestId),
      terminalReceipt: {
        terminalId, terminalIdSource: text(record.providerRequestId) === null ? 'runtime-observer' : 'adapter',
        status: text(record.status) ?? 'unclassified', complete: record.complete === true,
        providerRequestId: text(record.providerRequestId), finishReason: text(record.finishReason),
        usageSource: text(record.usageSource) ?? 'unknown',
        usageFinal: typeof record.usageFinal === 'boolean' ? record.usageFinal : null,
        reportedUsage: Object.fromEntries(TOKEN_FIELDS.map(key => [key, numeric(record.reportedUsage?.[key])])),
        usageSnapshots: numeric(record.usageSnapshots), endedAt: text(record.endedAt),
        latencyMs: numeric(record.latencyMs),
      },
      usage: Object.fromEntries(TOKEN_FIELDS.map(key => [key, numeric(record.usage?.[key])])),
      usageFinal: typeof record.usageFinal === 'boolean' ? record.usageFinal : null,
      reportedUsage: Object.fromEntries(TOKEN_FIELDS.map(key => [key, numeric(record.reportedUsage?.[key])])),
      payloadBytes: numeric(receipt.adapterPayload?.bytes),
    }
    if (text(record.purpose) !== null) normalized.purpose = text(record.purpose)
    const key = terminalKey(normalized)
    if (terminalKeys.has(key)) {
      duplicateTerminalRecords++
      return
    }
    if (records.length >= maxBufferRecords) {
      const evicted = records.shift()
      terminalKeys.delete(terminalKey(evicted))
      droppedRecords++
    }
    records.push(normalized)
    terminalKeys.set(key, true)
  }

  function installAgent(agent) {
    if (disposed || !agent) return
    const id = sessionId(agent)
    const tools = agent.ctx?.tools ?? agent.tools
    if (id === null || typeof tools?.register !== 'function') return
    const existing = owners.get(id)
    if (existing?.agent === agent) return
    if (existing) {
      safely(() => existing.unregister?.())
      owners.delete(id)
    }
    if (owners.size >= MAX_SESSIONS) return
    const tool = toolFor(agent, id, readSession)
    try {
      const unregister = tools.register(tool)
      owners.set(id, { agent, unregister: typeof unregister === 'function' ? unregister : null })
    } catch { /* Session tool registration is best-effort during agent startup. */ }
  }

  function removeAgent(agent) {
    const id = sessionId(agent)
    const existing = id === null ? null : owners.get(id)
    if (!existing || existing.agent !== agent) return
    safely(() => existing.unregister?.())
    owners.delete(id)
    const retained = records.filter(row => row.sessionId !== id)
    if (retained.length !== records.length) {
      records.length = 0
      for (const row of retained) records.push(row)
      terminalKeys.clear()
      for (const row of records) terminalKeys.set(terminalKey(row), true)
    }
  }

  const bridge = service(ctx, 'requestMessageProjection')
  if (typeof ctx.on === 'function') {
    const listen = (event, handler, options) => {
      const unregister = ctx.on(event, handler, options)
      if (typeof unregister === 'function') listeners.push(unregister)
    }
    listen('llm/stream', (options, next) => {
      if (disposed) return next()
      const id = text(options?.sessionId)
      if (id === null || !owners.has(id)) return next()
      const initialProjection = safely(() => resolveProjection(ctx, options))
      const projectionRequestId = text(initialProjection?.requestId)
      const readReceipt = safely(() => bridge?.capture?.(options))
      const attemptId = `observer-${++attemptSequence}`
      const metadata = () => {
        const projection = safely(() => resolveProjection(ctx, options, projectionRequestId, readReceipt))
        return {
          sessionId: id, requestProjection: projection,
          provider: text(options?.provider), model: text(options?.model), protocol: text(options?.protocol),
          purpose: text(options?.purpose), attemptId,
        }
      }
      return observeStream(options, next, {
        requestId: projectionRequestId,
        metadata,
        record: acceptTerminal,
      })
    }, { global: true })
    listen('agent/created', ({ agent } = {}) => installAgent(agent), { global: true })
    listen('agent/disposed', ({ agent } = {}) => removeAgent(agent), { global: true })
  }

  try {
    const agents = service(ctx, 'agents')
    for (const agent of safely(() => agents?.list?.(), []) ?? []) installAgent(agent)
  } catch { /* Agent roster can be unavailable during plugin initialization. */ }

  const runtimeService = Object.freeze({
    mode: 'shadow', automaticActionsEnabled: false,
    readSnapshot, stats,
  })
  try {
    if (typeof ctx.provide === 'function') unprovide = ctx.provide('windowEconomics', runtimeService)
    else {
      ctx.windowEconomics = runtimeService
      unprovide = () => { if (ctx.windowEconomics === runtimeService) delete ctx.windowEconomics }
    }
  } catch (error) {
    for (const owner of owners.values()) safely(() => owner.unregister?.())
    owners.clear()
    for (const unregister of listeners) safely(unregister)
    throw error
  }

  const dispose = () => {
    if (disposePromise) return disposePromise
    disposed = true
    for (const unregister of listeners.splice(0)) safely(unregister)
    for (const owner of owners.values()) safely(() => owner.unregister?.())
    owners.clear()
    records.length = 0
    terminalKeys.clear()
    disposePromise = Promise.resolve().then(() => unprovide?.())
    return disposePromise
  }
  if (typeof ctx.on === 'function') {
    const unregister = ctx.on('dispose', dispose)
    if (typeof unregister === 'function') listeners.push(unregister)
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
  dispose.service = runtimeService
  return dispose
}
