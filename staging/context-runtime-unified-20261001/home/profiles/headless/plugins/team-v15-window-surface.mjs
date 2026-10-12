import { randomUUID } from 'node:crypto'
import { installNativeSessionBridge, nativeSessionBridge } from '../../../../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { createWindowProjection } from './team-v15-window-projection.mjs'
import { createWindowTransition } from './team-v15-window-transition.mjs'
import { freezeWindow, windowHash as hash, windowMessageBytes } from './team-v15-window-checkpoint.mjs'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const clone = value => structuredClone(value)

/** Host-only exact-session API. Proposals and checkpoint authority never come
 * from tool arguments. Current request admission is separate from old commits. */
export async function createServerWindowSurface(ctx, { collector, sessionId, routes, proveReasoningSpan,
  maxPayloadBytes = 262144, maxRequestBytes, minReductionRatio = 0, fault, clock = Date.now, retry = {}, onDecision }) {
  // maxPayloadBytes bounds what this surface adds to a request (the authority message). The conversation after a
  // fold is bounded separately: by default with the same number, as the isolated trials were, and by a host that
  // serves real sessions with something the size of its model window.
  const requestLimit = maxRequestBytes ?? maxPayloadBytes
  if (!Number.isFinite(minReductionRatio) || minReductionRatio < 0 || minReductionRatio >= 1) fail('WINDOW_REDUCTION_RATIO_INVALID')
  const bytesOf = value => Buffer.byteLength(JSON.stringify(value))
  // What a model needs from a checkpoint: the authority and what it is bound to by name. The revision vector, the
  // fingerprints and the event references are the host's own binding; they stay in the message source.
  const modelView = checkpoint => ({ checkpointId: checkpoint.checkpointId, windowId: checkpoint.windowId, authority: checkpoint.authority,
    planRef: checkpoint.planRef, planRevision: checkpoint.planRevision, identityVersion: checkpoint.identityVersion, recovery: checkpoint.recovery })
  // Changes between two authority objects, down to single records: { changed: { key: <nested> | { set } }, removed: [keys] }.
  function authorityDelta(before, after, depth = 3) {
    if (hash(before ?? null) === hash(after ?? null)) return undefined
    const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    if (depth === 0 || !isObject(before) || !isObject(after)) return { set: after }
    const changed = {}, removed = Object.keys(before).filter(key => !Object.hasOwn(after, key))
    for (const key of Object.keys(after)) {
      const delta = Object.hasOwn(before, key) ? authorityDelta(before[key], after[key], depth - 1) : { set: after[key] }
      if (delta) changed[key] = delta
    }
    return { ...(Object.keys(changed).length ? { changed } : {}), ...(removed.length ? { removed } : {}) }
  }
  // The message that states what is true now. Against the checkpoint still in the conversation it says only what
  // changed; with no such checkpoint (a summary fold took it) it carries the authority itself. When even that does
  // not fit, the request is not refused: the model is told to read the state before acting on it.
  function currentAuthorityMessage(checkpoint, baseline) {
    const head = { kind: 'current-server-window-authority', authoritative: true, checkpointId: checkpoint.checkpointId, windowId: checkpoint.windowId,
      controlRevision: checkpoint.criticalRevisionVector?.controlRevision ?? null, planRef: checkpoint.planRef, planRevision: checkpoint.planRevision,
      recovery: checkpoint.recovery, previousNativeWindowCheckpoints: 'historical-only-not-current-authority' }
    const build = body => freezeWindow({ id: 'current-native-window-' + checkpoint.checkpointId, role: 'user',
      source: { kind: 'runtime', nativeWindowAuthority: checkpoint.checkpointIntegrityHash },
      content: [{ type: 'text', text: JSON.stringify({ ...head, ...body }) }] })
    const full = build({ authority: checkpoint.authority })
    let message = full
    if (baseline?.authority) {
      const delta = authorityDelta(baseline.authority, checkpoint.authority)
      const relative = build(delta === undefined
        ? { baselineCheckpointId: baseline.checkpointId, authority: 'unchanged-since-that-checkpoint' }
        : { baselineCheckpointId: baseline.checkpointId, authorityChanges: delta,
          howToRead: 'apply authorityChanges to the authority of that checkpoint: "set" replaces a value, "removed" lists keys that no longer exist' })
      if (bytesOf(relative) < bytesOf(full) * 0.6) message = relative
    }
    if (bytesOf(message) <= maxPayloadBytes) return message
    return build({ authority: { oversize: true, domains: Object.fromEntries(Object.entries(checkpoint.authority).map(([key, value]) =>
        [key, { entries: value && typeof value === 'object' ? Object.keys(value).length : 1, sha256: hash(value) }])) },
      requiredRead: 'The current Team state is too large to restate here. Read the Team board, your tasks and their contracts with the Team tools before acting on Team state.' })
  }
  // The last statement of the authority that is still in the conversation: a committed checkpoint, or the baseline
  // a host put back after a summary fold took the checkpoint away.
  const baselineOf = messages => { const message = messages.findLast(row => row.source?.nativeWindowCheckpoint || row.source?.nativeWindowBaseline)
    return message?.source.nativeWindowCheckpoint ?? message?.source.nativeWindowBaseline }
  const runtime = ctx.get?.('teamWindowRuntime'), projection = ctx.get?.('requestMessageProjection')
  const agents = ctx.agents.list().filter(agent => agent.session?.id === sessionId)
  if (agents.length !== 1 || runtime?.facts(agents[0]).exactIsolatedOptIn !== true
    || projection?.supportsAdapterValidation !== true || !collector?.authorityForSurface) fail('WINDOW_SERVER_SURFACE_NOT_ALLOWED')
  const agent = agents[0], session = agent.session
  const backend = ctx.get?.('sessionPersistence')
  if (typeof backend?.windowBarrierFor !== 'function') fail('WINDOW_REAL_LIVE_WRITER_REQUIRED')
  const barrier = await backend.windowBarrierFor(session, { isolated: true, sessionId })
  const bridge = nativeSessionBridge(session) ?? installNativeSessionBridge(session, { isolated: true, sessionId,
    flush: async () => { const result = await barrier.persist(); return result.durable === true } })
  const participation = runtime.participation(agent,{sourceFiles:protection=>maintenance?.recovery===true
    ? [] : collector.protectionFiles(sessionId,protection)}), prepared = new Map()
  const initialCertificate = participation.certificate()
  if (participation.verifyCertificate(initialCertificate) !== true) throw Object.assign(new Error('WINDOW_PARTICIPATION_UNVERIFIED'), { code:'WINDOW_PARTICIPATION_UNVERIFIED', blockers:initialCertificate.blockers })
  let maintenance, disposed = false
  function live() {
    if (disposed || !ctx.agents.list().includes(agent) || ctx.sessions.get(sessionId) !== session
      || runtime.facts(agent).exactIsolatedOptIn !== true) fail('WINDOW_SERVER_SURFACE_OWNER_CHANGED')
    if (participation.verifyCertificate(participation.certificate()) !== true) fail('WINDOW_PARTICIPATION_UNVERIFIED')
  }
  function boundary() {
    live()
    return maintenance && agent.phase === maintenance.phase && agent.phase.kind === 'maintenance'
      && !maintenance.signal.aborted && bridge.activeEffects === 0
  }
  function validate(proposal, _session, _critical, access) {
    live()
    if(boundary()!==true)fail('WINDOW_UNSAFE_BOUNDARY')
    const initial = prepared.get(hash(proposal))
    if (!initial) fail('WINDOW_SERVER_PROPOSAL_REQUIRED')
    const authority = collector.authorityForSurface(sessionId, access ? { writerToken: access.writerToken } : {})
    if (!access) { authority.validate(proposal.checkpoint); return true }
    const intent = access.intent, latest = authority.capture(sessionId).source
    if (hash(intent.proposal) !== hash(proposal) || intent.boundarySeq !== initial.events.length - 1
      || hash(latest.events.slice(0, initial.events.length)) !== hash(initial.events)) fail('WINDOW_SOURCE_CAS_CONFLICT')
    const suffix = latest.events.slice(initial.events.length)
    if (suffix[0]?.type !== 'native/window-intent' || hash(suffix[0].data) !== hash(intent)
      || suffix.slice(1).some(event => event.surfaceOp !== undefined
        || !(event.type === 'native/input-accepted' || event.type === 'agent/inbox/spliced' && !event.data.removedCount))) fail('WINDOW_SOURCE_CAS_CONFLICT')
    const queued = [...latest.authority.pendingAcceptanceRefs.inbox.nextStep, ...latest.authority.pendingAcceptanceRefs.inbox.nextTurn]
    for(const target of ['nextStep','nextTurn']) {
      const original=initial.authority.pendingAcceptanceRefs.inbox[target]
      if(hash(latest.authority.pendingAcceptanceRefs.inbox[target].slice(0,original.length))!==hash(original))fail('WINDOW_PENDING_SOURCE_CHANGED')
    }
    if (queued.some(message => proposal.sourceEventSeqs.some(seq => session.deriveEventMessage(session.eventAt(seq))?.id === message.id))) fail('WINDOW_PENDING_SOURCE_COLLISION')
    // Only the verified own intent and append-only inbox suffix are tolerated.
    // All current CP, identity, lease, plan, config and surface fields stay CAS-bound.
    const comparable = clone(latest)
    comparable.events = clone(initial.events)
    comparable.authority.pendingAcceptanceRefs = clone(initial.authority.pendingAcceptanceRefs)
    comparable.pendingMessageIds = clone(initial.pendingMessageIds)
    comparable.criticalRevisionVector.pendingHash = initial.criticalRevisionVector.pendingHash
    comparable.criticalRevisionVector.authorityHash = hash(comparable.authority)
    comparable.criticalRevisionVector.nativeBoundaryHash = initial.criticalRevisionVector.nativeBoundaryHash
    if (hash(comparable) !== hash(initial)) fail('WINDOW_SOURCE_CAS_CONFLICT')
    for (const span of latest.completedSpans) authority.verifySpan(latest, span)
    return true
  }
  const coordinator = createWindowTransition({ session, bridge, barrier, participation, isolated: true, sessionId,
    validateProposal: validate, safeBoundary: boundary, fault })
  function makeProposal() {
    live()
    const authority = collector.authorityForSurface(sessionId), captured = authority.capture(sessionId)
    const options = { ...agent.options, sessionId, actorId: agent.id, purpose: 'conversation',
      signal: maintenance.signal, messages: captured.source.messages }
    const result = createWindowProjection({ authority, mode: 'W1', sessions: [sessionId], routes,
      maxPayloadBytes: requestLimit, proveReasoningSpan,
      checkpointContent: (checkpoint, source) => [{ type: 'text', text: JSON.stringify({ kind: 'historical-window-checkpoint', authoritative: false,
        currentAuthorityRequired: true, checkpoint: modelView(checkpoint),
        foldedEvents: (refs => ({ count: refs.length, firstSeq: refs[0]?.seq ?? null, lastSeq: refs.at(-1)?.seq ?? null, sha256: hash(refs) }))(
          source.completedSpans.flatMap(span => span.eventRefs)) }) }] }).plan(options)
    if (result.status !== 'projected') throw Object.assign(new Error(result.blockedReason ?? 'WINDOW_SERVER_PROPOSAL_UNAVAILABLE'),
      { code: result.blockedReason ?? 'WINDOW_SERVER_PROPOSAL_UNAVAILABLE', ...(result.blockedDetail ? { detail: result.blockedDetail } : {}) })
    const excluded = new Set(result.excluded.map(row => row.id)), nodes = [...session.surface.nodes]
    const selected = nodes.filter(seq => excluded.has(session.deriveEventMessage(session.eventAt(seq))?.id))
    if (!selected.length) fail('WINDOW_CONTIGUOUS_SURFACE_REQUIRED')
    const ranges = []
    let run
    for (const seq of nodes) {
      if (selected.includes(seq)) {
        if (run) run.endSeq = seq
        else { run = { startSeq: seq, endSeq: seq }; ranges.push(run) }
      } else run = undefined
    }
    const placement = ranges.length === 1 ? { range: ranges[0] } : { ranges }
    const bootstrap = result.candidateMessages.find(message => message.source?.windowCheckpoint)
    const route = routes.find(row => row.provider === options.provider && row.model === options.model)
    const message = { ...bootstrap, id: 'native-window-' + randomUUID(),
      source: { kind: 'runtime', nativeWindowCheckpoint: result.checkpoint, authorityMode: 'historical-snapshot-current-authority-required' },
      content: bootstrap.content }
    // A fold whose own baseline could not be restated in full afterwards is not worth committing: every later
    // request would have to send the model to the tools for its state.
    for (const [label, candidate] of [['checkpoint', message], ['authority', currentAuthorityMessage(result.checkpoint, undefined)]]) {
      // What counts is what a model is sent: the text. The copy in the message source is the host's own record.
      if (windowMessageBytes([candidate]) > maxPayloadBytes || JSON.parse(candidate.content[0].text).authority?.oversize === true) throw Object.assign(new Error('WINDOW_COLLECTOR_CHECKPOINT_BUDGET'),
        { code: 'WINDOW_COLLECTOR_CHECKPOINT_BUDGET', detail: { part: label, bytes: windowMessageBytes([candidate]), limitBytes: maxPayloadBytes, authorityBytes: bytesOf(result.checkpoint.authority),
          authorityParts: Object.fromEntries(Object.entries(result.checkpoint.authority ?? {}).map(([key, value]) => [key, bytesOf(value)]).sort((x, y) => y[1] - x[1]).slice(0, 6)) } })
    }
    const proposal = freezeWindow({ checkpoint: result.checkpoint, message, ...placement, sourceEventSeqs: selected,
      protocolCertificate: route.certificateHash, transformFingerprint: hash({ kind: 'server-native-surface-v2', excluded: result.excluded, message, ...placement }) })
    const nativeAfter = windowMessageBytes(result.candidateMessages.map(row => row.id === bootstrap.id ? message : row))
    // A fold that commits and leaves the request as large as before is a loss: the prefix cache is rewritten for
    // nothing. What a request carries afterwards is the conversation that is left, the checkpoint, and the
    // current-authority message every request gets from then on; a host may ask for a minimum share to be freed.
    const everyRequest = windowMessageBytes([currentAuthorityMessage(result.checkpoint, result.checkpoint)])
    if (nativeAfter + everyRequest > requestLimit || nativeAfter + everyRequest > result.estimated.beforeBytes * (1 - minReductionRatio)) throw Object.assign(new Error('WINDOW_NO_BOUNDED_REDUCTION'), { code: 'WINDOW_NO_BOUNDED_REDUCTION',
      detail: { beforeBytes: result.estimated.beforeBytes, afterBytes: nativeAfter, checkpointBytes: windowMessageBytes([message]), removedMessages: excluded.size,
        everyRequestBytes: everyRequest, minReductionRatio, limitBytes: requestLimit,
        unit: result.estimated.unit, providerWireBytes: 'unknown',
        authorityParts: Object.fromEntries(Object.entries(result.checkpoint.authority ?? {}).map(([key, value]) => [key, bytesOf(value)]).sort((x, y) => y[1] - x[1]).slice(0, 6)) } })
    prepared.set(hash(proposal), captured.source)
    return proposal
  }
  const dispatch = new WeakMap()
  const unregister = projection.register('native-window-admission-' + sessionId, options => {
    if (options.sessionId !== sessionId) return { messages: options.messages }
    const result = { messages: options.messages }
    try {
      live(); bridge.assertWindowReadable()
      const authority = collector.authorityFor(options), captured = authority.capture(sessionId)
      if(captured.checkpoint.recovery.memoryDebt.some(row=>row.kind==='unavailable-domain')
        ||captured.checkpoint.recovery.requiredRereads.some(row=>row.kind==='server-domain'))fail('WINDOW_CURRENT_AUTHORITY_REQUIRED')
      const nativeCheckpoints=options.messages.filter(message=>message.source?.nativeWindowCheckpoint)
      let currentMessage
      // The journal says whether this session holds a window, not the messages: a summary fold may have taken the
      // checkpoint message out of the conversation, and the request still needs its current authority.
      if(nativeCheckpoints.length || captured.checkpoint.windowId>0) {
        currentMessage=currentAuthorityMessage(captured.checkpoint,baselineOf(options.messages))
        result.messages=[...options.messages,currentMessage]
      }
      dispatch.set(result, { authority, checkpoint: captured.checkpoint,nativeCheckpoints,currentMessage,refreshes:0 })
    } catch(error) {result.admissionDenied=error.code ?? error.message ?? 'WINDOW_CURRENT_AUTHORITY_REQUIRED'}
    return result
  }, { order: 3, refreshAdapter({ inputOptions, options, result }) {
    // The current-authority message states what is true now. Task, lease, inbox and native-effect movement since
    // prepare is ordinary on a busy host: restate it instead of failing the turn. Anything that says the window
    // itself, the identity, the plan or the host changed is not ours to paper over and stays a refusal below.
    const bound = dispatch.get(result)
    if (inputOptions.sessionId !== sessionId || !bound?.currentMessage || result.admissionDenied) return
    let latest
    try { latest = bound.authority.capture(sessionId).checkpoint } catch { return }
    if (hash(latest) === hash(bound.checkpoint)) return
    const structural = checkpoint => ({ windowId: checkpoint.windowId, surfaceRevision: checkpoint.surfaceRevision,
      identityVersion: checkpoint.identityVersion, identityHashes: checkpoint.identityHashes, configFingerprint: checkpoint.configFingerprint,
      planRef: checkpoint.planRef, planRevision: checkpoint.planRevision, planHash: checkpoint.planHash,
      surfaceHash: checkpoint.criticalRevisionVector?.surfaceHash, host: checkpoint.criticalRevisionVector?.host })
    if (hash(structural(latest)) !== hash(structural(bound.checkpoint))
      || latest.recovery.memoryDebt.some(row=>row.kind==='unavailable-domain')
      || latest.recovery.requiredRereads.some(row=>row.kind==='server-domain')) return
    const index = options.messages.findIndex(message => message.id === bound.currentMessage.id)
    if (index < 0 || hash(options.messages[index]) !== hash(bound.currentMessage)) return
    const currentMessage = currentAuthorityMessage(latest, baselineOf(options.messages))
    const messages = options.messages.map((message, at) => at === index ? currentMessage : message)
    bound.checkpoint = latest; bound.currentMessage = currentMessage; bound.refreshes++
    return { ...options, messages }
  }, validateAdapter({ inputOptions, options, result }) {
    if (inputOptions.sessionId !== sessionId) return
    live(); bridge.assertWindowReadable()
    if(result.admissionDenied)fail(result.admissionDenied)
    if (options.sessionId !== sessionId || options.actorId !== undefined && options.actorId !== agent.id) fail('WINDOW_DISPATCH_BINDING_MISMATCH')
    const bound = dispatch.get(result)
    if (!bound) fail('WINDOW_CURRENT_AUTHORITY_REQUIRED')
    if(hash(options.messages.filter(message=>message.source?.nativeWindowCheckpoint))!==hash(bound.nativeCheckpoints)
      ||bound.currentMessage && hash(options.messages.find(message=>message.id===bound.currentMessage.id))!==hash(bound.currentMessage))fail('WINDOW_CURRENT_AUTHORITY_DROPPED_OR_CHANGED')
    // Before the first committed window the request carries nothing of ours: it is the caller's own request, so a
    // source that moved since prepare cannot make it wrong and must not fail the turn.
    if(!bound.nativeCheckpoints.length && !bound.currentMessage && bound.checkpoint.windowId===0)return
    bound.authority.validate(bound.checkpoint)
  } })
  async function reserved(job, recovery=false) {
    if (maintenance) fail('WINDOW_TRANSITION_BUSY')
    return agent.runMaintenance(async signal => {
      maintenance = { signal, phase: agent.phase,recovery }
      try {
        live()
        // Settling the control plane is the only wait before the proposal. A host that changed across it is busy right
        // now: skip this boundary before anything is written, rather than prepare a commit that will abort.
        const hostBefore = recovery ? undefined : participation.read().host?.epoch
        await participation.settle(); live()
        if (!recovery && participation.read().host?.epoch !== hostBefore) fail('WINDOW_HOST_BUSY_AT_BOUNDARY')
        return await job()
      }
      finally { maintenance = undefined; prepared.clear() }
    })
  }
  // One attempt per call, and a bound on attempts that cost journal space. A commit that loses its CAS after the
  // intent was written leaves an intent and an ABORTED record behind; on a host that keeps changing that could repeat
  // without end. So a fold demand gets a fixed number of such aborts, spaced out, and is then given up: the hard
  // context cap still compacts. Refusals before the intent cost nothing and are not counted.
  const maxDurableAborts = Number.isSafeInteger(retry.maxDurableAborts) && retry.maxDurableAborts > 0 ? retry.maxDurableAborts : 2
  const backoffMs = Array.isArray(retry.backoffMs) && retry.backoffMs.length && retry.backoffMs.every(ms => Number.isFinite(ms) && ms >= 0) ? retry.backoffMs : [30000, 120000]
  const attempts = { durableAborts: 0, notBefore: 0, deferred: false }
  const refuse = (code, extra) => { throw Object.assign(new Error(code), { code, retryable: code === 'WINDOW_COMMIT_BACKOFF', ...extra }) }
  async function commit() {
    if (attempts.deferred) refuse('W2_DEFERRED_HOST_BUSY', { durableAborts: attempts.durableAborts })
    if (clock() < attempts.notBefore) refuse('WINDOW_COMMIT_BACKOFF', { retryAt: attempts.notBefore })
    try {
      const receipt = await reserved(() => coordinator.transition(makeProposal()))
      attempts.durableAborts = 0; attempts.notBefore = 0
      return receipt
    } catch (error) {
      if (error?.transitionAborted !== true) throw error
      attempts.durableAborts++
      if (attempts.durableAborts >= maxDurableAborts) {
        attempts.deferred = true
        onDecision?.(Object.freeze({ kind: 'W2_DEFERRED_HOST_BUSY', sessionId, durableAborts: attempts.durableAborts, at: clock(),
          cause: error.code ?? error.message }))
        error.retryable = false
      } else {
        attempts.notBefore = clock() + backoffMs[Math.min(attempts.durableAborts, backoffMs.length) - 1]
        error.retryAt = attempts.notBefore
      }
      throw error
    }
  }
  return Object.freeze({
    // What a baseline message has to carry, or null when the conversation still has one (or the session holds no window).
    missingBaseline() {
      live()
      const captured = collector.authorityForSurface(sessionId).capture(sessionId)
      if (!(captured.checkpoint.windowId > 0) || baselineOf(captured.source.messages)) return null
      const view = modelView(captured.checkpoint)
      return bytesOf(view) > maxPayloadBytes ? null : view
    },
    commit,
    // A new fold demand (for example after the hard cap compacted) starts with a fresh allowance.
    resetDemand() { attempts.durableAborts = 0; attempts.notBefore = 0; attempts.deferred = false },
    attempts: () => ({ ...attempts, maxDurableAborts }),
    recover: () => reserved(() => coordinator.recover(),true), status: coordinator.status,
    dispose({ handover = false } = {}) {
      // A fenced session may still be handed over: its successor installs fenced too and recovers.
      if (maintenance || (!handover && coordinator.status().paused)) fail('WINDOW_RECOVERY_REQUIRED')
      // handover skips only the committed-window guard, for an immediate same-process reinstall
      // (the wiring plugin reloaded, or requestMessageProjection was rebuilt). It is not a safe way
      // to end a session's window: the new install must be up before the next request is admitted.
      if(!handover && coordinator.status().windowId>0 && ctx.agents.list().includes(agent))fail('WINDOW_CURRENT_AUTHORITY_REQUIRED')
      coordinator.detach()
      disposed = true; unregister()
    } })
}

// The loaded-code certificate reads this module's own source hash from here (see team-v15-window-loaded.mjs).
import { registerLoadedModule } from './team-v15-window-loaded.mjs'
registerLoadedModule(import.meta.url)
