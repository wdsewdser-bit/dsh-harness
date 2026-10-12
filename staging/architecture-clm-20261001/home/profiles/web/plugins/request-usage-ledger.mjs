import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { measureSessionTokens } from './team-token-meter-cache.mjs'

export const name = 'request-usage-ledger'
export const inject = ['llm']
const DEFAULT_DIRECTORY = 'D:\\dsh-test\\home\\usage-ledger'
const DEFAULT_MANIFEST = 'D:\\dsh-test\\docs\\usage-audit-20261001\\history-identities.json'
const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens']
const CATEGORIES = ['system', 'toolSchema', 'ordinaryUser', 'developer', 'teamInjected', 'nonTeamInjected', 'unknownInjected', 'assistantReasoning', 'assistantText', 'assistantToolCall', 'toolResult', 'observationHandle', 'reducerReceipt', 'other']
const TEAM_SOURCE_KINDS = new Set(['team-message'])
const NON_TEAM_SOURCE_KINDS = new Set(['time-context', 'runtime-context', 'tmux-context'])
const MAX_LINEAGE_DEPTH = 64
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null
const machine = value => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,100}$/.test(value) ? value : null
const safely = (fn, fallback = null) => { try { return fn() ?? fallback } catch { return fallback } }

/** Canonical DSH counters are disjoint; reasoning is already part of output. */
export function normalizeUsage(usage) {
  const result = Object.fromEntries(TOKEN_KEYS.map(key => [key, numeric(usage?.[key])]))
  const components = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']
  result.componentSum = components.every(key => result[key] !== null)
    ? components.reduce((sum, key) => sum + result[key], 0) : null
  result.totalConsistent = result.totalTokens !== null && result.componentSum !== null
    ? result.totalTokens === result.componentSum : null
  result.totalSource = result.totalTokens === null ? 'unknown' : 'adapter-reported'
  return result
}

/** Payload estimates describe the hook input, never tokenizer or wire counts. */
export function measureRequest(options = {}) {
  const buckets = new Map(CATEGORIES.map(key => [key, { bytes: 0, utf16Units: 0, items: 0, hash: createHash('sha256') }]))
  const sourceKinds = new Map()
  const nonTeamSourceKinds = new Map()
  const unknownSourceKinds = new Map()
  let unmeasurableItems = 0
  const add = (category, value) => {
    let text
    try { text = typeof value === 'string' ? value : JSON.stringify(value) } catch { unmeasurableItems++; return }
    if (typeof text !== 'string') return
    const item = buckets.get(category)
    item.bytes += Buffer.byteLength(text, 'utf8')
    item.utf16Units += text.length
    item.items++
    // Length framing prevents concatenation collisions between distinct items.
    item.hash.update(String(Buffer.byteLength(text, 'utf8')) + ':').update(text)
  }
  if (typeof options.system === 'string') add('system', options.system)
  for (const tool of options.tools ?? []) add('toolSchema', tool)
  for (const message of options.messages ?? []) {
    const kind = machine(message?.source?.kind)
    let inputCategory = message?.role === 'developer' ? 'developer' : 'ordinaryUser'
    if (message?.role === 'user' || message?.role === 'developer') {
      if (TEAM_SOURCE_KINDS.has(kind)) inputCategory = 'teamInjected'
      else if (NON_TEAM_SOURCE_KINDS.has(kind)) inputCategory = 'nonTeamInjected'
      else if (message.source !== undefined && kind !== 'user') inputCategory = 'unknownInjected'
      const counts = inputCategory === 'teamInjected' ? sourceKinds : inputCategory === 'nonTeamInjected' ? nonTeamSourceKinds
        : inputCategory === 'unknownInjected' ? unknownSourceKinds : null
      if (counts) counts.set(kind ?? 'unknown', (counts.get(kind ?? 'unknown') ?? 0) + 1)
    }
    const content = typeof message?.content === 'string' ? [{ type: 'text', text: message.content }] : message?.content ?? []
    for (const block of content) {
      const text = typeof block?.text === 'string' ? block.text : null
      let category = 'other'
      if (message?.role === 'system') category = 'system'
      else if (message?.role === 'assistant') category = block?.type === 'reasoning' ? 'assistantReasoning'
        : block?.type === 'text' ? 'assistantText' : block?.type === 'tool-call' ? 'assistantToolCall' : 'other'
      else if (message?.role === 'tool') category = text?.includes('sol_pi_evidence_receipt_v1') ? 'reducerReceipt'
        : text?.includes('sol_pi_observation_source_v1') || text?.startsWith('[large tool result replaced after its first ') ? 'observationHandle' : 'toolResult'
      else if (message?.role === 'user' || message?.role === 'developer') category = inputCategory
      add(category, text ?? block)
    }
  }
  const categories = Object.fromEntries([...buckets].map(([key, value]) => [key, {
    bytes: value.bytes, utf16Units: value.utf16Units, items: value.items,
    estimatedTokens: Math.ceil(value.utf16Units / 4), sha256: value.hash.digest('hex'),
  }]))
  return {
    measurementSource: 'llm/stream-hook-input', estimateMethod: 'ceil(UTF16-units/4); not real tokens; not wire bytes',
    categories, teamSourceKinds: Object.fromEntries(sourceKinds), nonTeamSourceKinds: Object.fromEntries(nonTeamSourceKinds),
    unknownSourceKinds: Object.fromEntries(unknownSourceKinds), unmeasurableItems,
    bytes: Object.values(categories).reduce((sum, value) => sum + value.bytes, 0),
    utf16Units: Object.values(categories).reduce((sum, value) => sum + value.utf16Units, 0),
  }
}

function safeFailure(error) {
  return { type: machine(error?.name) ?? 'unknown', code: machine(error?.code), httpStatus: numeric(error?.status) }
}

/** Wrap a canonical stream while preserving chunk identity and iterator results. */
export function observeStream(options, next, observer = {}) {
  const now = observer.now ?? Date.now
  const signal = options?.signal
  const started = now()
  const requestId = identifier(observer.requestId) ?? (observer.uuid ?? randomUUID)()
  let usage = normalizeUsage(null)
  let usageSnapshots = 0
  let providerRequestId = null
  let finishReason = null
  let failure = null
  let exitIntent = null
  let settled = false
  let iterator
  let source
  const emit = record => {
    try {
      const result = observer.record?.(record)
      if (result && typeof result.catch === 'function') result.catch(() => {})
    } catch { /* Observation may never veto generation. */ }
  }
  const metadata = () => safely(() => typeof observer.metadata === 'function' ? observer.metadata() : observer.metadata, {})
  const base = {
    version: 1, requestId, sessionId: identifier(options?.sessionId), provider: identifier(options?.provider),
    model: identifier(options?.model), reasoningEffort: machine(options?.reasoningEffort),
    purpose: machine(options?.purpose) ?? 'conversation', mechanism: machine(options?.purpose) ?? 'conversation',
    startedAt: new Date(started).toISOString(), payload: safely(() => measureRequest(options)),
  }
  const terminal = (status, error = null, complete = true) => {
    if (settled) return
    settled = true
    if (error) {
      failure = safeFailure(error)
      providerRequestId = identifier(error.requestId) ?? providerRequestId
    }
    const ended = now()
    emit({ ...base, ...metadata(), event: 'terminal', status, complete,
      endedAt: new Date(ended).toISOString(), latencyMs: Math.max(0, ended - started),
      usage, usageSnapshots, usageSource: usageSnapshots > 0 ? 'dsh-adapter-usage-last-snapshot' : 'unknown',
      providerRequestId, finishReason, failure,
    })
    safely(() => observer.onTerminal?.(requestId))
  }
  emit({ ...base, ...metadata(), event: 'start', status: 'started', usage: normalizeUsage(null), usageSource: 'unknown' })
  const control = { requestId }
  safely(() => observer.onStart?.(control))
  try { source = next() } catch (error) { terminal(signal?.aborted ? 'aborted' : 'error', error); throw error }
  const getIterator = () => iterator ??= source[Symbol.asyncIterator]()
  const note = chunk => {
    if (settled) return
    if (chunk?.type === 'usage') { usage = normalizeUsage(chunk.usage); usageSnapshots++ }
    providerRequestId = identifier(chunk?.providerRequestId) ?? identifier(chunk?.requestId) ?? providerRequestId
    if (chunk?.type === 'finish') {
      finishReason = machine(chunk.reason?.kind)
      const detail = chunk.reason?.failure
      if (detail) { failure = safeFailure(detail); providerRequestId = identifier(detail.requestId) ?? providerRequestId }
    }
  }
  const stream = {
    [Symbol.asyncIterator]() { return this },
    async next(value) {
      try {
        const result = await getIterator().next(value)
        if (result.done) terminal(finishReason === 'error' ? 'error' : finishReason === 'aborted' || signal?.aborted ? 'aborted' : exitIntent ?? 'success', null, exitIntent === null)
        else { try { note(result.value) } catch { /* Malformed observer input still passes through. */ } }
        return result
      } catch (error) { terminal(signal?.aborted || error?.name === 'AbortError' ? 'aborted' : 'error', error); throw error }
    },
    async return(value) {
      exitIntent = 'consumer-return'
      try {
        const target = getIterator()
        const result = target.return ? await target.return(value) : { done: true, value }
        if (result.done) terminal(signal?.aborted ? 'aborted' : 'consumer-return', null, false)
        else { try { note(result.value) } catch {} }
        return result
      } catch (error) { terminal(signal?.aborted || error?.name === 'AbortError' ? 'aborted' : 'error', error); throw error }
    },
    async throw(error) {
      try {
        const target = getIterator()
        if (!target.throw) { if (target.return) await target.return(); throw error }
        const result = await target.throw(error)
        if (result.done) terminal('consumer-throw', error, false)
        else { try { note(result.value) } catch {} }
        return result
      } catch (caught) { terminal(signal?.aborted || caught?.name === 'AbortError' ? 'aborted' : 'error', caught); throw caught }
    },
  }
  return stream
}

/** A bounded serial queue; enqueue never waits for filesystem I/O. */
export function createLedgerWriter({ directory, instanceId, logger, maxPending = 4096, io = { appendFile, mkdir } }) {
  const file = join(directory, `requests-${process.pid}-${instanceId}.jsonl`)
  const runtimeFile = join(directory, `runtime-status-${process.pid}-${instanceId}.jsonl`)
  let pending = 0
  let failures = 0
  let warns = 0
  let tail = Promise.resolve()
  let ready
  const failed = () => {
    failures++
    if (warns < 8 && (failures === 1 || (failures & (failures - 1)) === 0)) {
      warns++
      safely(() => logger?.warn?.(`[request-usage-ledger] persistence failures=${failures}; records may be missing`))
    }
  }
  const enqueue = (record, runtime = false) => {
    if (pending >= maxPending) { failed(); return false }
    let line
    try { line = JSON.stringify(record) + '\n' } catch { failed(); return false }
    pending++
    tail = tail.then(async () => {
      try {
        ready ??= Promise.resolve().then(() => io.mkdir(directory, { recursive: true })).catch(error => { ready = undefined; throw error })
        await ready
        await io.appendFile(runtime ? runtimeFile : file, line, 'utf8')
      } catch { failed() } finally { pending-- }
    })
    return true
  }
  return { file, runtimeFile, enqueue, flush: () => tail, stats: () => ({ pending, failures, warns }) }
}

function service(ctx, key) { return safely(() => ctx.get?.(key) ?? ctx[key]) }

export function identityFromManifest(manifest, sessionId) {
  const rows = Array.isArray(manifest) ? manifest : manifest?.sessions ?? manifest?.identities ?? manifest?.records ?? []
  const row = Array.isArray(rows) ? rows.find(item => item?.sessionId === sessionId || item?.id === sessionId) : rows?.[sessionId]
  const resolved = row?.lineageStatus === undefined || row.lineageStatus === 'resolved'
  const rootId = resolved ? identifier(row?.rootTeamId) : null
  return row ? {
    rootTeamId: rootId, rootSessionId: rootId === null ? null : identifier(row.rootSessionId ?? row.rootId) ?? rootId,
    parentId: identifier(row.parentId ?? row.parentSessionId ?? row.parentSession), workspace: identifier(row.workspace ?? row.cwd), identitySource: 'history-manifest',
  } : null
}

export function resolveIdentity(ctx, sessionId, manifest = null, cached = null, observedAgent = null, knownIdentities = null) {
  const agents = service(ctx, 'agents')
  const lookup = id => {
    const found = safely(() => agents?.get?.(id))
    return found?.id === id ? found : null
  }
  const manifestIdentity = identityFromManifest(manifest, sessionId)
  const stored = manifestIdentity ?? cached
  const agent = observedAgent ?? lookup(sessionId)
  const membership = agent ? safely(() => service(ctx, 'agentTeams')?.tryMembership?.(agent)) : null
  const meta = agent ? safely(() => agent.session?.header) : null
  const parentId = identifier(meta?.parentSession) ?? stored?.parentId
    ?? (membership?.role === 'teammate' ? identifier(membership.root?.id) : null)
  let rootId = manifestIdentity?.rootTeamId ?? cached?.rootTeamId ?? null
  let rootSessionId = rootId === null ? null : manifestIdentity?.rootSessionId ?? cached?.rootSessionId ?? rootId
  let globalRootSource = manifestIdentity?.rootTeamId ? 'history-manifest' : rootId ? 'event-cache' : 'unknown'
  let globalRootStatus = rootId ? 'resolved' : 'unknown'
  let lineageDepth = 0
  // Follow only bounded in-memory parent/header facts; never enumerate journals.
  if (rootId === null && identifier(sessionId) !== null) {
    const seen = new Set()
    let currentId = sessionId
    let currentAgent = agent
    for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth++) {
      lineageDepth = depth
      if (seen.has(currentId)) { globalRootStatus = 'cycle'; break }
      seen.add(currentId)
      const historical = identityFromManifest(manifest, currentId)
      const remembered = currentId === sessionId ? cached : knownIdentities?.get?.(currentId)
      const knownRoot = historical?.rootTeamId ?? remembered?.rootTeamId
      if (knownRoot) {
        rootId = knownRoot
        rootSessionId = historical?.rootSessionId ?? remembered?.rootSessionId ?? knownRoot
        globalRootSource = historical?.rootTeamId ? 'history-manifest-ancestor' : 'event-cache-ancestor'
        globalRootStatus = 'resolved'
        break
      }
      const header = currentAgent ? safely(() => currentAgent.session?.header) : null
      const parent = identifier(header?.parentSession) ?? historical?.parentId ?? remembered?.parentId
        ?? (depth === 0 ? parentId : null)
      if (parent === null) {
        if (header && header.origin !== 'subagent') {
          rootId = currentId
          rootSessionId = currentId
          globalRootSource = 'live-parent-chain'
          globalRootStatus = 'resolved'
        }
        break
      }
      currentId = parent
      currentAgent = lookup(parent) ?? (membership?.root?.id === parent ? membership.root : null)
      if (depth === MAX_LINEAGE_DEPTH - 1) globalRootStatus = 'depth-limit'
    }
  }
  return {
    rootTeamId: rootId, rootSessionId,
    immediateTeamId: identifier(membership?.id) ?? cached?.immediateTeamId ?? null,
    immediateTeamRootId: identifier(membership?.root?.id) ?? cached?.immediateTeamRootId ?? null,
    parentId,
    workspace: identifier(meta?.cwd) ?? stored?.workspace ?? null,
    identitySource: membership ? 'live-agentTeams' : agent ? 'live-agent-and-manifest' : stored?.identitySource ?? 'unknown',
    globalRootSource, globalRootStatus, lineageDepth,
  }
}

function sanitizedEndpoint(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.origin + url.pathname
  } catch { return null }
}

/** Only explicit configuration facts are reported; catalog/wire defaults stay unknown. */
export function resolveRoute(ctx, options, config = {}) {
  const settings = service(ctx, 'settings')
  const description = safely(() => settings?.describe?.())
  const rows = Array.isArray(description) ? description : description?.namespaces
  const snapshot = Array.isArray(rows) ? rows.find(row => row?.ns === 'llm-pi-ai')?.value : null
  const live = snapshot?.providers?.[options.provider]
  const route = live ?? config.providerConfig?.providers?.[options.provider]
  const model = route?.models?.find?.(row => row.id === options.model)
  return {
    endpoint: sanitizedEndpoint(model?.baseURL ?? route?.baseURL),
    protocol: machine(model?.api ?? route?.api),
    routeSource: live ? 'live-settings:llm-pi-ai.providers' : route ? 'plugin-config:providerConfig' : 'unknown',
    routeEvidence: 'explicit-config-only; resolved wire route is not exposed by llm/stream',
  }
}

export function resolveProjection(ctx, options, requestId, readReceipt) {
  const bridge = service(ctx, 'requestMessageProjection')
  if (!bridge) return null
  const stats = safely(() => bridge.stats?.())
  const receipt = safely(() => readReceipt ? readReceipt() : bridge.audit?.(options, requestId))
  const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value : null
  return {
    pid: numeric(stats?.pid), moduleHash: sha(stats?.moduleHash), installed: stats?.installed === true,
    call: numeric(receipt?.call), changed: receipt?.changed === true,
    requestId: identifier(receipt?.requestId), stage: machine(receipt?.stage),
    sessionId: identifier(receipt?.sessionId),
    handedToAdapter: receipt?.handedToAdapter === true, handedAt: identifier(receipt?.handedAt),
    providerReceipt: machine(receipt?.providerReceipt) ?? 'unknown',
    before: receipt?.before ?? null, after: receipt?.after ?? null,
    adapterPayload: receipt?.adapterPayload ?? null,
    firstChangedMessageIndex: numeric(receipt?.firstChangedMessageIndex), commonPrefixBytes: numeric(receipt?.commonPrefixBytes),
    turnId: identifier(receipt?.turnId), taskId: identifier(receipt?.taskId), workflowId: identifier(receipt?.workflowId),
    preparedGeneration: machine(receipt?.preparedGeneration), preparedConfig: receipt?.preparedConfig ?? null,
    transforms: (Array.isArray(receipt?.transforms) ? receipt.transforms : []).slice(0, 32).map(row => ({
      id: machine(row.id), status: machine(row.status), order: numeric(row.order),
      beforeMessages: numeric(row.beforeMessages), afterMessages: numeric(row.afterMessages),
      metadataHash: sha(row.metadata?.sha256),
    })),
  }
}

/** The raw safety meter remains authoritative; economic estimates cannot relax rejection. */
export function observeRequestBudget(ctx, options, requestId, readReceipt) {
  const projection = resolveProjection(ctx, options, requestId, readReceipt)
  const rawSafety = safely(() => {
    const agent = service(ctx, 'agents')?.get?.(options?.sessionId)
    const meter = service(ctx, 'tokenMeter')
    return agent?.session && typeof meter?.measure === 'function' ? measureSessionTokens(meter, agent.session) : null
  })
  const payload = safely(() => measureRequest(options))
  return {
    requestId: projection?.requestId ?? null,
    rawSafetyTokens: numeric(rawSafety?.totalTokens), safetySource: rawSafety ? 'unchanged-session-token-meter' : 'unknown',
    rawRequestBytes: numeric(projection?.before?.bytes), projectedRequestBytes: numeric(projection?.after?.bytes),
    projectedContentEstimateTokens: payload ? Math.ceil(payload.utf16Units / 4) : null,
    economicSource: 'final-request-message-JSON-and-content-estimate; not provider tokens',
    imagePricing: 'unchanged-conservative-native-meter', routeTokenizerPricing: 'unknown',
    controlsSafetyRejection: false,
  }
}

export function apply(ctx, config = {}) {
  const instanceId = randomUUID()
  const startedAt = new Date().toISOString()
  const writer = createLedgerWriter({ directory: config.directory ?? DEFAULT_DIRECTORY, instanceId, logger: ctx.logger, maxPending: config.maxPending })
  const inflight = new Map()
  const identities = new Map()
  const disposers = []
  let manifest = null
  let disposed = false
  const manifestPath = config.identityManifestPath ?? DEFAULT_MANIFEST
  const manifestReady = readFile(manifestPath, 'utf8').then(text => { manifest = JSON.parse(text) }).catch(() => {})
  const moduleHashReady = readFile(new URL(import.meta.url)).then(bytes => createHash('sha256').update(bytes).digest('hex')).catch(() => null)
  const runtime = async event => writer.enqueue({ version: 1, event, pid: process.pid, instanceId, startedAt,
    at: new Date().toISOString(), moduleHash: await moduleHashReady, profile: machine(config.profile) ?? 'web',
    manifestPath, inflight: inflight.size, persistence: writer.stats(), hook: 'llm/stream',
  }, true)
  void runtime('loaded')
  const mirror = ({ agent } = {}) => {
    if (!agent?.id) return
    const identity = resolveIdentity(ctx, agent.id, manifest, identities.get(agent.id), agent, identities)
    identities.set(agent.id, identity)
    while (identities.size > 4096) identities.delete(identities.keys().next().value)
  }
  if (typeof ctx.on === 'function') {
    disposers.push(ctx.on('agent/created', mirror, { global: true }))
    disposers.push(ctx.on('agent/status', mirror, { global: true }))
    disposers.push(ctx.on('llm/stream', (options, next) => {
      if (disposed) return next()
      const projectionRequestId = resolveProjection(ctx, options)?.requestId
      const readReceipt = safely(() => service(ctx, 'requestMessageProjection')?.capture?.(options))
      const routingOptions = { sessionId: options.sessionId, provider: options.provider, model: options.model }
      let metadataSnapshot
      const metadata = () => {
        if (!disposed) metadataSnapshot = {
          ...resolveIdentity(ctx, routingOptions.sessionId, manifest, identities.get(routingOptions.sessionId), null, identities),
          ...resolveRoute(ctx, routingOptions, config),
          requestProjection: resolveProjection(ctx, options, projectionRequestId, readReceipt),
          requestBudget: observeRequestBudget(ctx, options, projectionRequestId, readReceipt),
        }
        return metadataSnapshot ?? {}
      }
      return observeStream(options, next, {
        requestId: projectionRequestId,
        record: record => writer.enqueue({ ...record, pid: process.pid, instanceId, profile: machine(config.profile) ?? 'web' }),
        metadata,
        onStart: control => inflight.set(control.requestId, { ...control, freezeMetadata: metadata }),
        onTerminal: requestId => inflight.delete(requestId),
      })
    }, { global: true }))
  }
  const dispose = async () => {
    if (disposed) return writer.flush()
    for (const control of inflight.values()) safely(control.freezeMetadata)
    disposed = true
    for (const unregister of disposers) safely(() => unregister?.())
    // Existing streams retain the writer and frozen attribution until their real terminal.
    identities.clear()
    await runtime('disposed')
    await writer.flush()
  }
  if (typeof ctx.on === 'function') disposers.push(ctx.on('dispose', dispose))
  dispose.flush = writer.flush
  dispose.ready = Promise.all([manifestReady, moduleHashReady]).then(() => writer.flush())
  dispose.stats = () => ({ ...writer.stats(), inflight: inflight.size, disposed, file: writer.file, runtimeFile: writer.runtimeFile, instanceId })
  return dispose
}
