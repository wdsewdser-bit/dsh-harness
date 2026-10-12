import { createWindowCheckpointAuthority, freezeWindow, windowHash as hash, windowRefuse, syncWindow, windowMessageBytes } from './team-v15-window-checkpoint.mjs'

export const name = 'team-v15-window-projection'
export const inject = ['requestMessageProjection', 'llm']
const bytes = windowMessageBytes
const knownRoles = new Set(['system', 'developer', 'user', 'assistant', 'tool'])
function protocol(messages) {
  const seen = new Set(), calls = new Map(), results = new Set()
  let pending = new Set()
  for (const m of messages) {
    if (!m?.id || seen.has(m.id) || !knownRoles.has(m.role) || typeof m.source?.kind !== 'string' || !Array.isArray(m.content)) windowRefuse('WINDOW_UNKNOWN_MESSAGE')
    seen.add(m.id)
    if (pending.size && m.role !== 'tool') windowRefuse('WINDOW_PENDING_CHAIN')
    for (const b of m.content) {
      if (!['text', 'reasoning', 'tool-call'].includes(b.type)) windowRefuse('WINDOW_UNKNOWN_BLOCK')
      if (b.type === 'text' || b.type === 'reasoning') {
        if (typeof b.text !== 'string') windowRefuse('WINDOW_UNKNOWN_BLOCK')
      } else {
        if (m.role !== 'assistant' || !b.id || !b.name || typeof b.arguments !== 'string' || calls.has(b.id)) windowRefuse('WINDOW_TOOL_CHAIN')
        calls.set(b.id, m.id); pending.add(b.id)
      }
    }
    if (m.role === 'tool') {
      if (!pending.has(m.toolCallId) || results.has(m.toolCallId)) windowRefuse('WINDOW_TOOL_CHAIN')
      results.add(m.toolCallId); pending.delete(m.toolCallId)
    }
  }
  // An in-flight tool chain is always preserved by refusing the entire projection.
  if (pending.size) windowRefuse('WINDOW_PENDING_CHAIN')
  return calls
}

export function createWindowProjection({ authority, mode = 'W0', sessions = [], routes = [], maxPayloadBytes = 262144, now = Date.now, proveReasoningSpan, checkpointContent }) {
  if (!['W0', 'W1'].includes(mode) || !Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 1) windowRefuse('WINDOW_INVALID_CONFIG')
  const allowlist = new Set(sessions)
  const routePolicy = freezeWindow(structuredClone(routes))
  function validateRoute(options, s) {
    const route = routePolicy.find(r => r.provider === options.provider && r.model === options.model)
    const time = syncWindow(now)
    if (!Number.isFinite(time) || !route || !['dsh-v1', 'deepseek-dsh-v1'].includes(route.protocol) || !route.certificateHash || !Number.isFinite(route.expiresAt) || route.expiresAt <= time) windowRefuse('WINDOW_PROTOCOL_UNCERTIFIED')
    if (route.certificateHash !== s.protocolCertificateHash || s.configFingerprint !== route.configFingerprint) windowRefuse('WINDOW_PROTOCOL_UNCERTIFIED')
    return route
  }
  function validateDispatch(options, cp) {
    if (!allowlist.has(options.sessionId) || options.sessionId !== cp.sessionId || options.actorId !== cp.actorId) windowRefuse('WINDOW_DISPATCH_BINDING_MISMATCH')
    if (options.purpose && options.purpose !== 'conversation') windowRefuse('WINDOW_PURPOSE_NOT_ALLOWED')
    const latest = authority.validate(cp)
    validateRoute(options, latest.source)
    protocol(options.messages)
  }
  function plan(options) {
    const before = bytes(options.messages)
    try {
      if (options.purpose && options.purpose !== 'conversation') windowRefuse('WINDOW_PURPOSE_NOT_ALLOWED')
      if (!allowlist.has(options.sessionId)) windowRefuse('WINDOW_SESSION_NOT_ALLOWED')
      if (mode === 'W1' && !(options.signal instanceof AbortSignal)) windowRefuse('WINDOW_REQUEST_SIGNAL_REQUIRED')
      const { source: s, checkpoint } = authority.capture(options.sessionId)
      if (s.actorId !== options.actorId) windowRefuse('WINDOW_ACTOR_MISMATCH')
      const route = validateRoute(options, s)
      if (hash(s.messages) !== hash(options.messages)) windowRefuse('WINDOW_SOURCE_REQUEST_MISMATCH')
      const calls = protocol(options.messages)
      const protectedIds = new Set([...s.recentTailIds, ...s.pendingMessageIds,
        ...options.messages.filter(m => ['system', 'developer'].includes(m.role)).map(m => m.id)])
      if ([...protectedIds].some(id => !options.messages.some(m => m.id === id))) windowRefuse('WINDOW_TAIL_UNPROVEN')
      const removed = new Set()
      for (const span of s.completedSpans) {
        authority.verifySpan(s, span)
        const hasReasoning = options.messages.some(message => span.messageIds.includes(message.id) && message.content.some(block => block.type === 'reasoning'))
        if (hasReasoning && (route.protocol !== 'deepseek-dsh-v1' || route.reasoningPolicy !== 'whole-completed-turn-v1'
          || typeof proveReasoningSpan !== 'function' || syncWindow(proveReasoningSpan, s, span, options) !== true)) windowRefuse('WINDOW_REASONING_RETENTION_REQUIRED')
        const indices = span.messageIds.map(id => options.messages.findIndex(m => m.id === id))
        if (indices.some((index, i) => index < 0 || (i && index !== indices[i - 1] + 1))) windowRefuse('WINDOW_SPAN_ORDER')
        const group = options.messages.filter(m => span.messageIds.includes(m.id))
        // A whole turn runs from the user's input to the final answer. A step range inside a completed turn runs
        // from an assistant message with tool calls to the last result of its last step; the pairing check below
        // holds for both.
        if (span.scope === 'steps' ? (group[0]?.role !== 'assistant' || group.at(-1)?.role !== 'tool')
          : (group[0]?.role !== 'user' || group.at(-1)?.role !== 'assistant')) windowRefuse('WINDOW_SPAN_BOUNDARY')
        for (const m of group) {
          if (protectedIds.has(m.id) || removed.has(m.id)) windowRefuse('WINDOW_PROTECTED_MESSAGE')
          if (m.role === 'tool' && !span.messageIds.includes(calls.get(m.toolCallId))) windowRefuse('WINDOW_SPLIT_TOOL_PAIR')
          for (const call of m.content.filter(b => b.type === 'tool-call')) {
            if (!group.some(result => result.role === 'tool' && result.toolCallId === call.id)) windowRefuse('WINDOW_SPLIT_TOOL_PAIR')
          }
          removed.add(m.id)
        }
      }
      if (!removed.size) {
        // Say why nothing can be folded: an open debt clears every span, which looks the same as "nothing to fold".
        throw Object.assign(new Error('WINDOW_NO_COMPLETED_SPAN'), { code: 'WINDOW_NO_COMPLETED_SPAN', detail: {
          spans: s.completedSpans.length, messages: options.messages.length,
          debts: [...new Set((s.recovery?.memoryDebt ?? []).map(row => row.kind + (row.source ? ':' + row.source : row.memberName ? ':' + row.memberName : '')))].slice(0, 12),
          requiredRereads: (s.recovery?.requiredRereads ?? []).length } })
      }
      const bootstrap = { id: checkpoint.checkpointId, role: 'user', source: { kind: 'runtime', windowCheckpoint: checkpoint },
        content: [{ type: 'text', text: JSON.stringify({ kind: 'server-context-checkpoint', authority: checkpoint.authority,
          planRef: checkpoint.planRef, planRevision: checkpoint.planRevision, planHash: checkpoint.planHash,
          identityVersion: checkpoint.identityVersion, identityHashes: checkpoint.identityHashes,
          working: checkpoint.working, recovery: checkpoint.recovery,
          originalEventRefs: s.completedSpans.flatMap(span => span.eventRefs) }) }] }
      // The native surface's checkpoint has a smaller model body than W1's request-only checkpoint. Budget that
      // actual body before deciding whether the projection is worth committing, using a host-owned builder.
      if (checkpointContent !== undefined) bootstrap.content = syncWindow(checkpointContent, checkpoint, s)
      const candidate = []
      let inserted = false
      for (const m of options.messages) {
        if (removed.has(m.id)) { if (!inserted) { candidate.push(bootstrap); inserted = true } }
        else candidate.push(m)
      }
      protocol(candidate)
      const after = bytes(candidate)
      if (!candidate.length || after > maxPayloadBytes || after >= before) {
        // Sizes only: enough to tell "the checkpoint is bigger than what it replaces" from "still over the limit".
        throw Object.assign(new Error('WINDOW_NO_BOUNDED_REDUCTION'), { code: 'WINDOW_NO_BOUNDED_REDUCTION', detail: {
          beforeBytes: before, afterBytes: after, limitBytes: maxPayloadBytes, checkpointBytes: bytes([bootstrap]),
          authorityParts: Object.fromEntries(Object.entries(checkpoint.authority ?? {}).map(([key, value]) => [key, Buffer.byteLength(JSON.stringify(value))]).sort((x, y) => y[1] - x[1]).slice(0, 6)),
          removedMessages: removed.size, keptMessages: candidate.length - 1 } })
      }
      authority.validate(checkpoint)
      const candidateMessages = freezeWindow(structuredClone(candidate))
      const metadata = freezeWindow({ candidateMessages, checkpoint,
        status: mode === 'W1' ? 'projected' : 'shadow', blockedReason: null,
        retained: options.messages.filter(m => !removed.has(m.id)).map(m => ({ id: m.id, reason: protectedIds.has(m.id) ? 'protected-current-context' : 'outside-completed-span' })),
        excluded: [...removed].map(id => ({ id, reason: 'completed-span-exact-event-recovery' })),
        estimated: { beforeBytes: before, candidateBytes: after, unit: 'model-visible-Harness-JSON-bytes', providerWireBytes: 'unknown', providerTokens: 'unknown' } })
      return Object.freeze({ ...metadata, messages: mode === 'W1' ? candidateMessages : options.messages })
    } catch (error) {
      return { messages: options.messages, status: 'blocked', blockedReason: error.code ?? 'WINDOW_SOURCE_UNAVAILABLE',
        ...(error.detail ? { blockedDetail: error.detail } : {}),
        estimated: { beforeBytes: before, candidateBytes: before, unit: 'model-visible-Harness-JSON-bytes', providerWireBytes: 'unknown', providerTokens: 'unknown' } }
    }
  }
  return Object.freeze({ plan, validateDispatch, mode })
}

/** The single bridge owns transformation. This guard changes no messages and
 * checks the source immediately around native forAdapter's synchronous boundary. */
export function installWindowProjection({ projection, llm, authority, authorityFor, ...config }) {
  if (authorityFor !== undefined && typeof authorityFor !== 'function') windowRefuse('WINDOW_SERVER_READER_REQUIRED')
  const planner = authorityFor ? null : createWindowProjection({ authority, ...config })
  function bind(options) {
    if (!authorityFor) return { planner, authority, options }
    const current = syncWindow(authorityFor, options)
    const captured = current.capture(options.sessionId)
    // Actor identity comes from the collector's native registry, not call args.
    if (options.actorId !== undefined && options.actorId !== captured.checkpoint.actorId) windowRefuse('WINDOW_ACTOR_MISMATCH')
    return { authority: current, planner: createWindowProjection({ authority: current, ...config }),
      options: { ...options, actorId: captured.checkpoint.actorId } }
  }
  const preview = options => {
    try { const bound = bind(options); return bound.planner.plan(bound.options) }
    catch (error) { return { messages: options.messages, status: 'blocked', blockedReason: error.code ?? 'WINDOW_SOURCE_UNAVAILABLE' } }
  }
  if (!llm || projection?.supportsAdapterValidation !== true) windowRefuse('WINDOW_DISPATCH_BOUNDARY_UNAVAILABLE')
  const audits = []
  const dispatchBindings = new WeakMap()
  const guard = function({options,result}) {
    const cp = options.messages?.find(m => m.source?.windowCheckpoint)?.source.windowCheckpoint
    const bound = dispatchBindings.get(result)
    const projected = result.status === 'projected'
    if (projected && (!bound || !cp || hash(cp) !== hash(result.checkpoint))) windowRefuse('WINDOW_CHECKPOINT_DROPPED_OR_CHANGED')
    if (cp && !projected) windowRefuse('WINDOW_UNBOUND_CHECKPOINT')
    const dispatchOptions = bound ? { ...options, actorId: options.actorId ?? bound.options.actorId } : options
    if (cp) bound.planner.validateDispatch(dispatchOptions, cp)
  }
  const transform = options => {
    try {
      const bound = bind(options), result = bound.planner.plan(bound.options)
      if (result.checkpoint) dispatchBindings.set(result, bound)
      return result
    } catch (error) { return { messages: options.messages, status: 'blocked', blockedReason: error.code ?? 'WINDOW_SOURCE_UNAVAILABLE' } }
  }
  const unregister = projection.register('window-v15', transform, { order: 5, preview, validateAdapter:guard,
    onDispatch({ inputOptions, options, result, receipt }) {
      let postSource = 'unchanged'
      if (result.checkpoint) {
        try { dispatchBindings.get(result).authority.validate(result.checkpoint) } catch (error) { postSource = error.code ?? 'unknown' }
      }
      audits.push(freezeWindow({ sessionId: receipt.sessionId, status: result.status, blockedReason: result.blockedReason,
        estimated: result.estimated, actual: { handedToAdapter: receipt.handedToAdapter, payload: receipt.adapterPayload,
          modelPayload: { bytes: windowMessageBytes(options.messages), unit: 'model-visible-Harness-JSON-bytes', providerWireBytes: 'unknown' },
          providerReceipt: receipt.providerReceipt, requestId: receipt.requestId }, postSource }))
      if (audits.length > 64) audits.shift()
    } })
  return Object.freeze({ preview, audit: () => Object.freeze([...audits]), dispose() {
    unregister()
  } })
}

export function apply(ctx, config = {}) {
  const authority = config.authority ?? createWindowCheckpointAuthority(config)
  const service = installWindowProjection({ projection: ctx.requestMessageProjection, llm: ctx.llm, authority, ...config })
  ctx.effect?.(() => () => service.dispose())
  return service
}

// The loaded-code certificate reads this module's own source hash from here (see team-v15-window-loaded.mjs).
import { registerLoadedModule } from './team-v15-window-loaded.mjs'
registerLoadedModule(import.meta.url)
