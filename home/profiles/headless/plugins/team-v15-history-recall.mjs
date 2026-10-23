import { createHash } from 'node:crypto'
import { planDeliveryHash } from './team-v15-plan-delivery.mjs'
import { committedContextEpoch } from './team-v14-context-delivery.mjs'

const clone = value => structuredClone(value)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const same = (a, b) => planDeliveryHash(a) === planDeliveryHash(b)
const fail = code => { throw Object.assign(new Error(code), { code }) }
const text = value => typeof value === 'string' && value.length > 0
function sync(fn, ...args) {
  if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') fail('HISTORY_CALLBACK_INVALID')
  const result = fn(...args)
  if (result?.then) fail('HISTORY_CALLBACK_INVALID')
  return result
}
function raw(event, seq) {
  if (!event || event.seq !== seq || typeof event.type !== 'string' || !Object.hasOwn(event, 'data')) fail('HISTORY_RAW_EVENT_UNVERIFIED')
  return clone(event)
}
const rawHash = event => hash(Buffer.from(JSON.stringify(event), 'utf8'))

/** Query already owns the raw journal and tracing. This ledger stores only
 * exact references and page hashes, never another FTS index or original log.
 * Cross-session authorization is a host callback over current locked state;
 * absence of that callback grants only the invoking agent's own session. */
export function createHistoryRecall({ sessionQuery, control, readDurable, authorizeSession,
  pageBytes = 4096, maxArtifactBytes = 4194304, maxPairEvents = 16, projection, agentForSession, ownSessionId, peek }) {
  // Each agent registers its own observer, and all of them see every request of the host. Without these two checks
  // each of them would read the whole control plane from disk on every request: `ownSessionId` leaves a request to
  // its own session's observer, and `peek` (the in-memory state, never behind the disk) says when that session has
  // nothing waiting to be confirmed.
  const nothingWaiting = sessionId => {
    if (typeof peek !== 'function') return false
    let store
    try { store = peek()?.v15HistoryRecall } catch { return false }
    return !Object.values(store?.returnedPages ?? {}).some(row => row?.readerSessionId === sessionId)
      && !Object.values(store?.returnedArtifacts ?? {}).some(row => row?.readerSessionId === sessionId)
  }
  const projected = new WeakSet(), pendingDispatches = new Set()
  if (!Number.isSafeInteger(pageBytes) || pageBytes < 128 || pageBytes > 65536
    || !Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < pageBytes
    || !Number.isSafeInteger(maxPairEvents) || maxPairEvents < 1 || maxPairEvents > 64) fail('HISTORY_CONFIG_INVALID')
  const authorize = (state, agent, sessionId) => {
    if (!text(agent?.session?.id) || !text(sessionId)) fail('HISTORY_CONTEXT_REQUIRED')
    if (sessionId !== agent.session.id && (!authorizeSession || sync(authorizeSession, clone(state), agent, sessionId) !== true)) fail('HISTORY_SCOPE_DENIED')
  }
  const readerId = agent => agent.session.id
  const contextEpoch = agent => committedContextEpoch(agent.session)?.compactionId ?? 'initial'
  async function mutate(type, agent, fn) {
    let durable
    await control.mutateHot(type, {}, agent, state => {
      const store = clone(state.v15HistoryRecall ?? { version: 1, descriptors: {}, reads: {}, debts: {} })
      if (store.version !== 1 || !store.descriptors || !store.reads || !store.debts) fail('HISTORY_LEDGER_INVALID')
      const result = fn(state, store)
      state.v15HistoryRecall = store
      return result
    }, { deferMs: 0, afterDurable(result, locked) {
      const disk = sync(readDurable)
      if (disk.rootId !== locked.rootId || disk.revision !== locked.revision || !same(disk.v15HistoryRecall, locked.v15HistoryRecall)) fail('HISTORY_DURABLE_READBACK_MISMATCH')
      durable = { ...clone(result), durable: true }
    } })
    if (!durable) fail('HISTORY_DURABLE_HOOK_UNAVAILABLE')
    return durable
  }
  async function debt(agent, sourceRef, reason) {
    const id = 'history-debt-' + planDeliveryHash({ reader: readerId(agent), sourceRef }).slice(0, 32)
    return mutate('v15/history-recall-debt', agent, (state, store) => {
      if (sourceRef.sessionId) authorize(state, agent, sourceRef.sessionId)
      const row = { id, readerSessionId: readerId(agent), sourceRef: clone(sourceRef), status: 'required', reason }
      store.debts[id] = row
      if (sourceRef.locator && reason !== 'HISTORY_SOURCE_CAS_CONFLICT' && store.reads[sourceRef.locator]) {
        store.reads[sourceRef.locator] = { pageHashes: {}, receipt: null }
        if (store.debts['history-debt-' + sourceRef.locator]) store.debts['history-debt-' + sourceRef.locator].status = 'required'
      }
      return { ok: false, code: reason, debt: row }
    })
  }
  async function artifact(agent, sessionId, seq, signal, expectedNeighborSeqs) {
    authorize(sync(readDurable), agent, sessionId)
    if (typeof sessionQuery?.readEvent !== 'function' || typeof sessionQuery?.traceEvent !== 'function') fail('HISTORY_EXACT_PROVIDER_UNAVAILABLE')
    signal?.throwIfAborted()
    const observation = await sessionQuery.readEvent({ sessionId, seq, before: 1, after: 1 }, signal)
    const target = raw(observation.target, seq)
    if (observation.session?.id !== sessionId) fail('HISTORY_RAW_EVENT_UNVERIFIED')
    const trace = await sessionQuery.traceEvent({ sessionId, seq }, signal)
    const neighbors = (observation.events ?? []).filter(event => event.seq !== seq
      && (expectedNeighborSeqs === undefined || expectedNeighborSeqs.includes(event.seq))).map(event => raw(event, event.seq))
    if (expectedNeighborSeqs && !same(neighbors.map(event => event.seq), expectedNeighborSeqs)) fail('HISTORY_SOURCE_CHANGED')
    const pairedEvents = [], pairIds = new Set()
    let pairingComplete = true
    if (target.type === 'tool/call' || target.type === 'tool/result') {
      const candidateSeqs = target.type === 'tool/call' ? trace.derivedEventSeqs : trace.sourceEventSeqs
      if (!Array.isArray(candidateSeqs) || candidateSeqs.length > maxPairEvents) fail('HISTORY_TOOL_PAIR_BUDGET_EXCEEDED')
      for (const pairSeq of candidateSeqs) {
        const pair = raw((await sessionQuery.readEvent({ sessionId, seq: pairSeq, before: 0, after: 0 }, signal)).target, pairSeq)
        if ((target.type === 'tool/call' && pair.type === 'tool/result' && pair.sourceEventSeqs?.includes(seq)
            && text(target.data.callId) && target.data.callId === (pair.data.message?.toolCallId ?? pair.data.callId))
          || (target.type === 'tool/result' && pair.type === 'tool/call' && target.sourceEventSeqs?.includes(pairSeq)
            && text(pair.data.callId) && pair.data.callId === (target.data.message?.toolCallId ?? target.data.callId))) {
          if (!pairIds.has(pairSeq)) { pairedEvents.push(pair); pairIds.add(pairSeq) }
        }
      }
      pairingComplete = pairedEvents.length === 1
    }
    // A second raw observation rejects providers that changed the target while
    // constructing context. Future reads always revalidate the same source hash.
    const readback = raw((await sessionQuery.readEvent({ sessionId, seq, before: 0, after: 0 }, signal)).target, seq)
    if (rawHash(target) !== rawHash(readback)) fail('HISTORY_SOURCE_CHANGED')
    signal?.throwIfAborted()
    authorize(sync(readDurable), agent, sessionId)
    const bytes = Buffer.from(JSON.stringify({ target, neighbors, pairedEvents, trace }), 'utf8')
    if (bytes.length > maxArtifactBytes) fail('HISTORY_ARTIFACT_BUDGET_EXCEEDED')
    return { bytes, sourceHash: rawHash(target), artifactHash: hash(bytes), pairingComplete, neighborSeqs: neighbors.map(event => event.seq) }
  }
  async function recall(input, exec) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !text(exec?.agent?.session?.id)) fail('HISTORY_INPUT_INVALID')
    const request = clone(input), agent = exec.agent
    const allowed = request.action === 'locate' ? ['action', 'sessionId', 'seq']
      : request.action === 'read' ? ['action', 'locator', 'expectedRevision', 'expectedSourceHash', 'offset']
        : request.action === 'assemble' ? ['action', 'locator', 'expectedRevision', 'expectedSourceHash'] : []
    if (!allowed.length || Object.keys(request).some(key => !allowed.includes(key))) fail('HISTORY_INPUT_INVALID')
    if (request.action === 'locate') {
      const sessionId = request.sessionId ?? readerId(agent)
      authorize(sync(readDurable), agent, sessionId)
      if (!Number.isSafeInteger(request.seq) || request.seq < 0) return debt(agent, { sessionId, seq: Number.isSafeInteger(request.seq) ? request.seq : null }, 'HISTORY_EVENT_UNAVAILABLE')
      let source
      try { source = await artifact(agent, sessionId, request.seq, exec.signal) }
      catch (error) {
        if (error.code === 'HISTORY_SCOPE_DENIED' || exec.signal?.aborted) throw error
        return debt(agent, { sessionId, seq: request.seq }, error.code ?? 'HISTORY_EXACT_READ_FAILED')
      }
      const sourceRef = { sessionId, seq: request.seq, sourceRevision: request.seq, revisionKind: 'immutable-raw-event-seq',
        sourceHash: source.sourceHash, artifactHash: source.artifactHash }
      const locator = 'history-raw-' + planDeliveryHash({ reader: readerId(agent), sourceRef }).slice(0, 40)
      return mutate('v15/history-recall-located', agent, (state, store) => {
        authorize(state, agent, sessionId)
        const descriptor = { locator, readerSessionId: readerId(agent), sourceRef, encoding: 'utf8-json',
          bytes: source.bytes.length, pageBytes, pages: Math.ceil(source.bytes.length / pageBytes), pairingComplete: source.pairingComplete,
          neighborSeqs: source.neighborSeqs, retention: 'provider-owned-source-revalidated-on-every-page' }
        const prior = store.descriptors[locator]
        if (prior && !same(prior, descriptor)) fail('HISTORY_LOCATOR_CONFLICT')
        store.descriptors[locator] = descriptor
        for (const row of Object.values(store.debts)) {
          if (row.readerSessionId === readerId(agent) && row.sourceRef.sessionId === sessionId && row.sourceRef.seq === request.seq
            && row.sourceRef.artifactHash !== source.artifactHash) row.status = 'superseded'
        }
        const debtId = 'history-debt-' + locator
        if (store.reads[locator]?.receipt?.status !== 'full-fetched') store.debts[debtId] = {
          id: debtId, readerSessionId: readerId(agent), sourceRef, status: 'required', reason: source.pairingComplete ? 'HISTORY_PAGES_REQUIRED' : 'HISTORY_TOOL_PAIR_INCOMPLETE' }
        return { ok: true, descriptor, receipt: store.reads[locator]?.receipt ?? null }
      })
    }
    const disk = sync(readDurable), descriptor = disk.v15HistoryRecall?.descriptors?.[request.locator]
    if (!descriptor) return debt(agent, { locator: text(request.locator) ? request.locator : null }, 'HISTORY_LOCATOR_UNAVAILABLE')
    if (descriptor.readerSessionId !== readerId(agent)) fail('HISTORY_SCOPE_DENIED')
    authorize(disk, agent, descriptor.sourceRef.sessionId)
    if (request.expectedRevision !== descriptor.sourceRef.sourceRevision || request.expectedSourceHash !== descriptor.sourceRef.sourceHash) {
      return debt(agent, { locator: descriptor.locator, ...descriptor.sourceRef }, 'HISTORY_SOURCE_CAS_CONFLICT')
    }
    if (request.action === 'read' && (!Number.isSafeInteger(request.offset) || request.offset < 0
      || request.offset >= descriptor.bytes || request.offset % pageBytes !== 0)) fail('HISTORY_PAGE_RANGE_INVALID')
    let source
    try { source = await artifact(agent, descriptor.sourceRef.sessionId, descriptor.sourceRef.seq, exec.signal, descriptor.neighborSeqs) }
    catch (error) {
      if (error.code === 'HISTORY_SCOPE_DENIED' || exec.signal?.aborted) throw error
      return debt(agent, { locator: descriptor.locator, ...descriptor.sourceRef }, error.code ?? 'HISTORY_EXACT_READ_FAILED')
    }
    if (source.sourceHash !== descriptor.sourceRef.sourceHash || source.artifactHash !== descriptor.sourceRef.artifactHash || source.bytes.length !== descriptor.bytes) {
      return debt(agent, { locator: descriptor.locator, ...descriptor.sourceRef }, 'HISTORY_SOURCE_CHANGED')
    }
    if (request.action === 'assemble') return mutate('v15/history-artifact-assembled', agent, (state, store) => {
      authorize(state, agent, descriptor.sourceRef.sessionId)
      if (!same(store.descriptors[descriptor.locator], descriptor)) fail('HISTORY_LOCATOR_CONFLICT')
      exec.signal?.throwIfAborted()
      const progress = store.reads[descriptor.locator]
      const pageHashes = Array.from({length:descriptor.pages},(_,i)=>hash(source.bytes.subarray(i*pageBytes,
        Math.min((i+1)*pageBytes,descriptor.bytes))))
      if (progress?.receipt?.status !== 'full-fetched' || !descriptor.pairingComplete
        || pageHashes.some((sha,i)=>progress.pageHashes[i*pageBytes]!==sha)) {
        return {ok:false,partial:true,code:'HISTORY_ASSEMBLY_PAGES_INCOMPLETE'}
      }
      if (!text(exec.callId)) fail('HISTORY_EXECUTION_ID_REQUIRED')
      const rootCallId = exec.parent !== undefined && text(exec.rootCallId) && exec.rootCallId !== exec.callId ? exec.rootCallId : null
      const id = 'history-artifact-' + planDeliveryHash({reader:readerId(agent),locator:descriptor.locator,
        callId:exec.callId,rootCallId,sourceRef:descriptor.sourceRef}).slice(0,40)
      const packet = {ok:true,kind:'history-raw-artifact-v1',descriptor:clone(descriptor),pageHashes,
        receipt:clone(progress.receipt),artifact:JSON.parse(source.bytes.toString('utf8')),
        deliveryCandidate:{id,callId:exec.callId,status:'returned-awaiting-dispatch'}}
      const encoded = JSON.stringify({...packet,durable:true})
      store.returnedArtifacts ??= {}
      store.returnedArtifacts[id] = {id,callId:exec.callId,rootCallId,locator:descriptor.locator,
        readerSessionId:readerId(agent),sourceRef:clone(descriptor.sourceRef),status:'returned-awaiting-dispatch',
        exactOutputHash:hash(Buffer.from(encoded)),outerOutputHash:hash(Buffer.from(encoded+'\nFile sandbox enforcement is partial on this host.'))}
      return packet
    })
    const chunk = source.bytes.subarray(request.offset, Math.min(request.offset + pageBytes, source.bytes.length))
    return mutate('v15/history-recall-page', agent, (state, store) => {
      authorize(state, agent, descriptor.sourceRef.sessionId)
      if (!same(store.descriptors[descriptor.locator], descriptor)) fail('HISTORY_LOCATOR_CONFLICT')
      exec.signal?.throwIfAborted()
      const progress = store.reads[descriptor.locator] ?? { pageHashes: {}, receipt: null }
      progress.pageHashes[request.offset] = hash(chunk)
      const complete = descriptor.pairingComplete && Array.from({ length: descriptor.pages }, (_, index) => {
        const offset = index * pageBytes
        return progress.pageHashes[offset] === hash(source.bytes.subarray(offset, Math.min(offset + pageBytes, descriptor.bytes)))
      }).every(Boolean)
      if (complete) {
        progress.receipt = { id: 'history-read-' + descriptor.locator, readerSessionId: readerId(agent), sourceRef: clone(descriptor.sourceRef),
          status: 'full-fetched', bytes: descriptor.bytes, pageCount: descriptor.pages, encoding: descriptor.encoding,
          pairingComplete: true, modelConsumption: 'unknown', verificationScope: 'all-exact-raw-pages-server-readback' }
        store.debts['history-debt-' + descriptor.locator] = { ...store.debts['history-debt-' + descriptor.locator],
          status: delivered(progress, agent) ? 'resolved' : 'returned-awaiting-dispatch' }
        for (const row of Object.values(store.debts)) {
          if (row.readerSessionId === readerId(agent) && row.sourceRef.locator === descriptor.locator
            && row.sourceRef.sourceHash === descriptor.sourceRef.sourceHash && row.sourceRef.artifactHash === descriptor.sourceRef.artifactHash)
            row.status = delivered(progress, agent) ? 'resolved' : 'returned-awaiting-dispatch'
        }
      }
      store.reads[descriptor.locator] = progress
      const page = { ok: true, locator: descriptor.locator, offset: request.offset, bytes: chunk.length,
        dataBase64: chunk.toString('base64'), pageHash: hash(chunk), nextOffset: request.offset + chunk.length < descriptor.bytes ? request.offset + chunk.length : null,
        complete, receipt: progress.receipt }
      if (text(exec.callId)) {
        const canonicalPageHash = hash(Buffer.from(JSON.stringify(page)))
        const id = 'history-page-' + planDeliveryHash({ reader: readerId(agent), locator: descriptor.locator,
          offset: request.offset, callId: exec.callId, canonicalPageHash }).slice(0, 40)
        page.deliveryCandidate = { id, status: 'returned-awaiting-dispatch', canonicalPageHash }
        store.returnedPages ??= {}
        store.returnedPages[id] = { ...page.deliveryCandidate, locator: descriptor.locator, readerSessionId: readerId(agent),
          callId: exec.callId, offset: request.offset, pageHash: page.pageHash, sourceRef: clone(descriptor.sourceRef),
          exactOutputHash: hash(Buffer.from(JSON.stringify({ ...page, durable: true }))) }
      }
      return page
    })
  }
  function candidates(options) {
    if (projection?.isAgentLoopRequest(options) !== true || !text(options.sessionId)) return []
    const store = sync(readDurable).v15HistoryRecall
    return Object.values(store?.returnedPages ?? {}).filter(candidate => candidate.readerSessionId === options.sessionId
      && (options.messages ?? []).some(message => exactMessage(message, candidate)))
  }
  function exactMessage(message, candidate) {
    return message?.role === 'tool' && message.toolCallId === candidate.callId && message.isError !== true
      && Array.isArray(message.content) && message.content.length === 1 && message.content[0].type === 'text'
      && hash(Buffer.from(message.content[0].text ?? '')) === candidate.exactOutputHash
  }
  function delivered(progress, agent) {
    return [progress?.modelDeliveryReceipt, progress?.artifactDeliveryReceipt].some(receipt =>
      ['full-dispatched', 'full-artifact-dispatched'].includes(receipt?.status) && receipt.contextEpoch === contextEpoch(agent))
  }
  function resolveMatchingDebts(store,descriptor) {
    for (const row of Object.values(store.debts)) {
      if (row.readerSessionId===descriptor.readerSessionId
        && (row.id==='history-debt-'+descriptor.locator || row.sourceRef.locator===descriptor.locator
          && row.sourceRef.sourceHash===descriptor.sourceRef.sourceHash && row.sourceRef.artifactHash===descriptor.sourceRef.artifactHash)) row.status='resolved'
    }
  }
  // A PTC child result is not model-visible. Only an exact server packet under
  // its native root call may use the outer renderer's known sandbox suffix.
  function exactArtifactMessage(message,candidate) {
    if (message?.role !== 'tool' || message.isError === true || message.content?.length !== 1
      || message.content[0].type !== 'text') return false
    const sameCall = message.toolCallId === candidate.callId, outer = text(candidate.rootCallId) && message.toolCallId === candidate.rootCallId
    if (!sameCall && !outer) return false
    const output = hash(Buffer.from(message.content[0].text ?? ''))
    return output === candidate.exactOutputHash || outer && output === candidate.outerOutputHash
  }
  function project(options) {
    if (projection?.isAgentLoopRequest(options) !== true) return undefined
    if (text(ownSessionId) && options.sessionId !== ownSessionId) return undefined
    if (nothingWaiting(options.sessionId)) return undefined
    const store = sync(readDurable).v15HistoryRecall
    const agent = sync(agentForSession, options.sessionId), epoch = contextEpoch(agent)
    const latestPrune = (agent.session.log ?? []).findLast(event => event.type === 'compaction/prune')?.seq ?? -1
    const result = { messages: options.messages, candidates: candidates(options).map(row => clone(row)),
      contextEpoch: epoch,
      artifacts:Object.values(store?.returnedArtifacts ?? {}).filter(candidate=>candidate.readerSessionId===options.sessionId
        && (candidate.status === 'returned-awaiting-dispatch'
          || store.reads?.[candidate.locator]?.artifactDeliveryReceipt?.contextEpoch !== epoch
          || store.reads?.[candidate.locator]?.artifactDeliveryReceipt?.observedSessionSeq <= latestPrune)
        && options.messages.some(message=>exactArtifactMessage(message,candidate))).map(clone) }
    projected.add(result)
    return result
  }
  async function confirmDispatch({ options, inputOptions, result, receipt }) {
    if (!projected.has(result) || projection?.isAgentLoopRequest(inputOptions) !== true || inputOptions.signal?.aborted
      || options?.signal?.aborted || !text(inputOptions.sessionId) || options.sessionId !== inputOptions.sessionId
      || receipt?.handedToAdapter !== true || receipt.stage !== 'handed-to-adapter' || !text(receipt.requestId)) return { confirmed: [] }
    const agent = sync(agentForSession, options.sessionId)
    if (agent?.session?.id !== options.sessionId) fail('HISTORY_SCOPE_DENIED')
    const epoch = contextEpoch(agent), observedSessionSeq = agent.session.seq
    if (result.contextEpoch !== epoch) return { confirmed: [] }
    const confirmed = []
    for (const candidate of result.candidates) {
      if (candidate.readerSessionId !== options.sessionId || !(options.messages ?? []).some(message => exactMessage(message, candidate))) continue
      const state = sync(readDurable), descriptor = state.v15HistoryRecall?.descriptors?.[candidate.locator]
      if (!descriptor || !same(state.v15HistoryRecall.returnedPages?.[candidate.id], candidate)
        || !same(descriptor.sourceRef, candidate.sourceRef)) continue
      let source
      try { source = await artifact(agent, descriptor.sourceRef.sessionId, descriptor.sourceRef.seq, options.signal, descriptor.neighborSeqs) }
      catch (error) {
        if (error.code === 'HISTORY_SCOPE_DENIED' || options.signal?.aborted) continue
        await debt(agent, { locator: descriptor.locator, ...descriptor.sourceRef }, error.code ?? 'HISTORY_EXACT_READ_FAILED')
        continue
      }
      if (source.sourceHash !== candidate.sourceRef.sourceHash || source.artifactHash !== candidate.sourceRef.artifactHash) {
        await debt(agent, { locator: descriptor.locator, ...descriptor.sourceRef }, 'HISTORY_SOURCE_CHANGED'); continue
      }
      await mutate('v15/history-page-dispatched', agent, (latest, store) => {
        authorize(latest, agent, descriptor.sourceRef.sessionId)
        if (!same(store.returnedPages?.[candidate.id], candidate) || !same(store.descriptors[candidate.locator], descriptor)) fail('HISTORY_LOCATOR_CONFLICT')
        options.signal?.throwIfAborted(); inputOptions.signal?.throwIfAborted()
        if (contextEpoch(agent) !== epoch) fail('HISTORY_CONTEXT_CHANGED')
        const progress = store.reads[candidate.locator]
        progress.handedPages ??= {}
        progress.handedPages[candidate.offset] = { pageHash: candidate.pageHash, candidateId: candidate.id, requestId: receipt.requestId, contextEpoch: epoch }
        store.returnedPages[candidate.id] = { ...candidate, status: 'handed-to-adapter', requestId: receipt.requestId }
        const complete = descriptor.pairingComplete && Array.from({ length: descriptor.pages }, (_, index) => {
          const offset = index * pageBytes
          return progress.handedPages[offset]?.contextEpoch === epoch
            && progress.handedPages[offset]?.pageHash === hash(source.bytes.subarray(offset, Math.min(offset + pageBytes, descriptor.bytes)))
        }).every(Boolean)
        if (complete) {
          progress.modelDeliveryReceipt = { id: 'history-dispatch-' + descriptor.locator, readerSessionId: readerId(agent), contextEpoch: epoch, observedSessionSeq,
            sourceRef: clone(descriptor.sourceRef), status: 'full-dispatched', pageCount: descriptor.pages,
            modelUnderstanding: 'unknown', verificationScope: 'all-exact-canonical-page-results-handed-to-adapter' }
          resolveMatchingDebts(store,descriptor)
        }
        return { confirmed: candidate.id, complete }
      })
      confirmed.push(candidate.id)
    }
    for (const candidate of result.artifacts ?? []) {
      if (candidate.readerSessionId !== options.sessionId || !options.messages.some(message=>exactArtifactMessage(message,candidate))) continue
      const state = sync(readDurable), descriptor = state.v15HistoryRecall?.descriptors?.[candidate.locator]
      if (!descriptor || !same(state.v15HistoryRecall.returnedArtifacts?.[candidate.id],candidate)
        || !same(descriptor.sourceRef,candidate.sourceRef)) continue
      let source
      try { source = await artifact(agent,descriptor.sourceRef.sessionId,descriptor.sourceRef.seq,options.signal,descriptor.neighborSeqs) }
      catch (error) {
        if (error.code === 'HISTORY_SCOPE_DENIED' || options.signal?.aborted) continue
        await debt(agent,{locator:descriptor.locator,...descriptor.sourceRef},error.code ?? 'HISTORY_EXACT_READ_FAILED'); continue
      }
      if (source.sourceHash !== candidate.sourceRef.sourceHash || source.artifactHash !== candidate.sourceRef.artifactHash) {
        await debt(agent,{locator:descriptor.locator,...descriptor.sourceRef},'HISTORY_SOURCE_CHANGED'); continue
      }
      await mutate('v15/history-artifact-dispatched',agent,(latest,store)=>{
        authorize(latest,agent,descriptor.sourceRef.sessionId)
        if (!same(store.returnedArtifacts?.[candidate.id],candidate) || !same(store.descriptors[candidate.locator],descriptor)) fail('HISTORY_LOCATOR_CONFLICT')
        options.signal?.throwIfAborted(); inputOptions.signal?.throwIfAborted()
        if (contextEpoch(agent) !== epoch) fail('HISTORY_CONTEXT_CHANGED')
        const progress = store.reads[candidate.locator]
        if (progress?.receipt?.status !== 'full-fetched' || !descriptor.pairingComplete) fail('HISTORY_ASSEMBLY_PAGES_INCOMPLETE')
        const complete = Array.from({length:descriptor.pages},(_,i)=>progress.pageHashes[i*pageBytes]
          === hash(source.bytes.subarray(i*pageBytes,Math.min((i+1)*pageBytes,descriptor.bytes)))).every(Boolean)
        if (!complete) fail('HISTORY_ASSEMBLY_PAGES_INCOMPLETE')
        progress.artifactDeliveryReceipt = {id:'history-artifact-dispatch-'+candidate.id,readerSessionId:readerId(agent),contextEpoch:epoch,observedSessionSeq,
          sourceRef:clone(descriptor.sourceRef),status:'full-artifact-dispatched',pageCount:descriptor.pages,bytes:descriptor.bytes,
          callId:candidate.rootCallId ?? candidate.callId,assemblyCallId:candidate.callId,requestId:receipt.requestId,
          modelUnderstanding:'unknown',verificationScope:'complete-exact-server-assembled-artifact-handed-to-adapter'}
        store.returnedArtifacts[candidate.id] = {...candidate,status:'handed-to-adapter',requestId:receipt.requestId}
        resolveMatchingDebts(store,descriptor)
        return {confirmed:candidate.id,complete:true}
      })
      confirmed.push(candidate.id)
    }
    return { confirmed }
  }
  function onDispatch(args) {
    const pending = confirmDispatch(args)
    pendingDispatches.add(pending)
    pending.then(() => pendingDispatches.delete(pending), () => pendingDispatches.delete(pending))
    return pending
  }
  function collectDebt(state, agent) {
    const store = state.v15HistoryRecall ?? {}, reader = readerId(agent)
    const debts = Object.values(store.debts ?? {}).filter(row => row.readerSessionId === reader && ['required', 'returned-awaiting-dispatch'].includes(row.status)).map(clone)
    for (const descriptor of Object.values(store.descriptors ?? {})) {
      if (descriptor.readerSessionId !== reader) continue
      if (!delivered(store.reads?.[descriptor.locator], agent) && !debts.some(row => row.id === 'history-debt-' + descriptor.locator)) {
        debts.push({ id: 'history-debt-' + descriptor.locator, readerSessionId: reader,
          sourceRef: clone(descriptor.sourceRef), status: 'required', reason: 'HISTORY_CURRENT_EPOCH_DISPATCH_REQUIRED' })
      }
      try { authorize(state, agent, descriptor.sourceRef.sessionId) }
      catch { debts.push({ id: 'history-acl-' + descriptor.locator, readerSessionId: reader,
        sourceRef: clone(descriptor.sourceRef), status: 'required', reason: 'HISTORY_SCOPE_DENIED' }) }
    }
    return debts
  }
  return Object.freeze({ recall, project, onDispatch, collectDebt, drainDispatch: () => Promise.all([...pendingDispatches]) })
}

export function registerHistoryRecall(ctx, options) {
  const projection = options.projection ?? ctx.requestMessageProjection
  const service = createHistoryRecall({ agentForSession: sessionId => {
    const matches = ctx.agents.list().filter(agent => agent.session?.id === sessionId)
    if (matches.length !== 1) fail('HISTORY_SCOPE_DENIED')
    return matches[0]
  }, ...options, projection, sessionQuery: ctx.sessionQuery })
  const stopTool = ctx.tools.register({ name: 'history_recall', description: 'Read exact authorized raw journal events and source trace in bounded pages.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      action: { type: 'string', enum: ['locate', 'read', 'assemble'] }, sessionId: { type: 'string' }, seq: { type: 'integer' },
      locator: { type: 'string' }, expectedRevision: { type: 'integer' }, expectedSourceHash: { type: 'string' }, offset: { type: 'integer' } }, required: ['action'] },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: (input, exec) => service.recall(input, exec) })
  const stopProjection = projection?.register?.('history-recall:' + planDeliveryHash(options.registrationId ?? 'default').slice(0, 24),
    service.project, { order: 1100, preview: service.project, onDispatch: service.onDispatch })
  // Preserve the callable disposer API; expose the observer and debt helpers.
  return Object.assign(() => { stopProjection?.(); stopTool() }, { service, drainDispatch: service.drainDispatch })
}
