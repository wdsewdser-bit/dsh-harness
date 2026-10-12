import { randomUUID } from 'node:crypto'
import { windowHash as hash, freezeWindow, syncWindow } from './team-v15-window-checkpoint.mjs'
const fail = code => { throw Object.assign(new Error(code), { code }) }
const commitOf = event => event.type === 'user/message' ? event.data?.source?.windowCommit : null
const DOMAIN = ['authority', 'identity', 'lease', 'plan', 'config', 'input-claim']
const proposalPlacement = p => p.ranges === undefined ? { message: p.message, range: p.range } : { message: p.message, ranges: p.ranges }
const proposalOperation = p => p.ranges === undefined ? { op: 'replace', ...p.range } : { op: 'replace-many', ranges: p.ranges }
function selectedNodes(nodes, proposal) {
  const multiple = proposal.ranges !== undefined
  if (multiple && (proposal.range !== undefined || !Array.isArray(proposal.ranges) || proposal.ranges.length < 2)) fail('WINDOW_INVALID_SURFACE_PROPOSAL')
  const ranges = multiple ? proposal.ranges : [proposal.range], selected = []
  let previousEnd = -1
  for (const range of ranges) {
    if (!range || Object.keys(range).length !== 2 || !Number.isSafeInteger(range.startSeq) || range.startSeq < 0 || Object.is(range.startSeq, -0)
      || !Number.isSafeInteger(range.endSeq) || range.endSeq < 0 || Object.is(range.endSeq, -0)) fail('WINDOW_INVALID_SURFACE_PROPOSAL')
    const first = nodes.indexOf(range.startSeq), last = nodes.indexOf(range.endSeq)
    if (first <= previousEnd || first < 0 || last < first) fail('WINDOW_INVALID_SURFACE_PROPOSAL')
    selected.push(...nodes.slice(first, last + 1)); previousEnd = last
  }
  if (multiple && hash(selected) !== hash(proposal.sourceEventSeqs)) fail('WINDOW_INVALID_SURFACE_PROPOSAL')
  return selected
}

/** No default production enablement. The external participating-writer service holds its REAL control-plane fence
 * (authority/identity/lease/plan) across both fsyncs. The host (config) domain is not locked: it is bound by revision
 * and re-checked at the commit append, which has no await between the checks and the append. A conflict there writes
 * the ABORTED resolution in that same step, so the session is readable again without recover(). */
export function createWindowTransition({ session, bridge, barrier, participation, isolated, sessionId,
  validateProposal, safeBoundary, fault = () => {} }) {
  if (isolated !== true || sessionId !== session.id || bridge?.options?.sessionId !== session.id) fail('WINDOW_EXACT_ISOLATED_OPT_IN_REQUIRED')
  if (!participation || ['certificate', 'verifyCertificate', 'read', 'acquire', 'assertHeld', 'release'].some(k => typeof participation[k] !== 'function')) fail('WINDOW_PARTICIPATION_REQUIRED')
  if (barrier?.kind !== 'native-jsonl-fsync-readback-v1' || barrier.sessionId !== session.id || typeof validateProposal !== 'function' || typeof safeBoundary !== 'function') fail('WINDOW_NATIVE_BARRIER_AND_VALIDATORS_REQUIRED')
  let active, paused = false, running = false, releaseError = null
  const certificate = () => {
    const c = syncWindow(participation.certificate)
    if (c?.kind !== 'participating-writers-v1' || c.sessionId !== session.id || DOMAIN.some(d => !c.domains?.includes(d))
      || syncWindow(participation.verifyCertificate, c) !== true) fail('WINDOW_PARTICIPATION_UNVERIFIED')
    return c
  }
  certificate()
  const intents = () => session.snapshotEvents().filter(e => e.type === 'native/window-intent')
  const terminal = id => session.snapshotEvents().find(e => commitOf(e)?.transitionId === id || e.type === 'native/window-aborted' && e.data.transitionId === id)
  active = intents().findLast(e => !session.snapshotEvents().some(t => t.type === 'native/window-aborted' && t.data.transitionId === e.data.transitionId))?.data
  paused = !!active
  const gate = {
    isPaused: () => paused,
    assertReadable() { if (paused) fail('WINDOW_READ_PAUSED') },
    assertCompactionAllowed() { if (active || paused) fail('WINDOW_COMPACTION_FENCED') },
    checkAppend(type, data, opts) {
      if (!paused) return
      if (type === 'native/input-accepted') return
      if (type === 'agent/inbox/spliced' && !data?.removedCount) return
      if (!opts?.writerToken) fail('WINDOW_WRITER_FENCED')
    },
  }
  bridge.bindWindowGate(gate)
  function verifyIntent(intent) {
    const { integrityHash, ...body } = intent
    if (!integrityHash || hash(body) !== integrityHash || intent.sessionId !== session.id
      || intent.checkpointHash!==hash(intent.proposal?.checkpoint) || intent.oldSurfaceHash!==hash(intent.oldSurfaceNodes)
      || intent.proposedSurfaceHash!==hash(proposalPlacement(intent.proposal ?? {}))
      || ![1, 2].includes(intent.schemaVersion) || (intent.proposal?.ranges !== undefined && intent.schemaVersion !== 2)
      || !Number.isSafeInteger(intent.fromWindowId) || !Number.isSafeInteger(intent.toWindowId)
      || intent.toWindowId<=intent.fromWindowId || !Array.isArray(intent.oldSurfaceNodes)
      || hash(intent.originalEventRefs?.map(ref=>ref.seq))!==hash(intent.oldSurfaceNodes)) fail('WINDOW_RECOVERY_REQUIRED')
    try { if (!selectedNodes(intent.oldSurfaceNodes, intent.proposal).length) fail('WINDOW_RECOVERY_REQUIRED') }
    catch { fail('WINDOW_RECOVERY_REQUIRED') }
  }
  function currentWindow() { return session.snapshotEvents().filter(e => commitOf(e)).at(-1)?.data.source.windowCommit.toWindowId ?? 0 }
  function verifyOld(intent) {
    for (const ref of intent.originalEventRefs) if (hash(session.eventAt(ref.seq)) !== ref.sha256) fail('WINDOW_RECOVERY_REQUIRED')
  }
  function verifyCommit(event, intent) {
    const c = commitOf(event), p = intent.proposal
    const expectedMessage = { ...p.message, source: { ...p.message.source, windowCommit: c } }
    if (!c || c.transitionId !== intent.transitionId || event.seq <= intent.boundarySeq + 1
      || c.fencingEpoch !== intent.fencingEpoch || c.intentHash !== intent.integrityHash || c.checkpointHash !== intent.checkpointHash
      || c.sessionId !== session.id || c.fromWindowId !== intent.fromWindowId || c.toWindowId !== intent.toWindowId
      || hash(c.consumedInputIds) !== hash([]) || c.pendingInputCutoff !== intent.pendingInputCutoff
      || hash(event.data) !== hash(expectedMessage) || hash(event.surfaceOp) !== hash(proposalOperation(p))
      || hash(event.sourceEventSeqs) !== hash(p.sourceEventSeqs)) fail('WINDOW_RECOVERY_REQUIRED')
  }
  function verifyJournal(disk) {
    const live = session.snapshotEvents(), seen = new Set()
    let lastTo=0,lastCommit=0,previous
    if (!Array.isArray(disk) || disk.length > live.length || hash(live.slice(0, disk.length)) !== hash(disk)) fail('WINDOW_RECOVERY_REQUIRED')
    for (const event of intents()) {
      const intent = event.data
      verifyIntent(intent); verifyOld(intent)
      if (seen.has(intent.transitionId) || event.seq !== intent.boundarySeq + 1
        || intent.fromWindowId!==lastCommit || intent.toWindowId!==lastTo+1
        || previous && !live.some(e=>e.seq<event.seq && (commitOf(e)?.transitionId===previous || e.type==='native/window-aborted' && e.data.transitionId===previous))) fail('WINDOW_RECOVERY_REQUIRED')
      lastTo=intent.toWindowId;previous=intent.transitionId
      seen.add(intent.transitionId)
      const resolutions = live.filter(e => commitOf(e)?.transitionId === intent.transitionId || e.type === 'native/window-aborted' && e.data.transitionId === intent.transitionId)
      if (resolutions.length > 1) fail('WINDOW_RECOVERY_REQUIRED')
      for (const resolution of resolutions) {
        if (resolution.seq <= event.seq) fail('WINDOW_RECOVERY_REQUIRED')
        if (commitOf(resolution)) {verifyCommit(resolution, intent);lastCommit=intent.toWindowId}
        else if (resolution.data.intentHash !== intent.integrityHash) fail('WINDOW_RECOVERY_REQUIRED')
      }
    }
    for (const event of live.filter(e => commitOf(e) || e.type === 'native/window-aborted')) {
      if (!seen.has(commitOf(event)?.transitionId ?? event.data.transitionId)) fail('WINDOW_RECOVERY_REQUIRED')
    }
  }
  function receipt(event) { return freezeWindow({ ...commitOf(event), state: 'COMMITTED', durable: true, commitSeq: event.seq,
    commitAuthority: 'single user/message replacement source.windowCommit record in native JSONL journal' }) }
  async function transition(proposal, { transitionId = randomUUID() } = {}) {
    if (running || paused) fail('WINDOW_TRANSITION_BUSY')
    running = true
    let writer, criticalToken, appended = false, thrown
    try {
      const prior = terminal(transitionId)
      if (prior) {
        if (!commitOf(prior)) fail('WINDOW_TRANSITION_ALREADY_ABORTED')
        const disk = await barrier.read(); verifyJournal(disk)
        if (hash(disk[prior.seq]) !== hash(prior)) { paused = true; fail('WINDOW_RECOVERY_REQUIRED') }
        return receipt(prior)
      }
      certificate()
      if (bridge.activeEffects || syncWindow(safeBoundary, session) !== true) fail('WINDOW_UNSAFE_BOUNDARY')
      const p = freezeWindow(structuredClone(proposal)), nodes = [...session.surface.nodes]
      if (syncWindow(validateProposal, p, session, participation.read()) !== true) fail('WINDOW_PROPOSAL_UNVERIFIED')
      const selected = selectedNodes(nodes, p)
      if (!selected.length || !p.message?.id || p.message.role !== 'user' || !p.protocolCertificate || !p.transformFingerprint
        || selected.some(seq => !p.sourceEventSeqs?.includes(seq))) fail('WINDOW_INVALID_SURFACE_PROPOSAL')
      if (selected.includes(nodes.at(-1))) fail('WINDOW_PROTECTED_TAIL')
      const expectedCritical = structuredClone(syncWindow(participation.read))
      criticalToken = await participation.acquire(expectedCritical)
      if (syncWindow(participation.assertHeld, criticalToken, expectedCritical) !== true) fail('WINDOW_CRITICAL_CAS_CONFLICT')
      writer = bridge.acquireWriter(bridge.surfaceRevision)
      paused = true
      const intent = { schemaVersion: p.ranges === undefined ? 1 : 2, transitionId, sessionId, state: 'PREPARED', fromWindowId: currentWindow(),
        toWindowId: Math.max(currentWindow(), ...intents().map(e => e.data.toWindowId), 0) + 1,
        expectedSurfaceRevision: bridge.surfaceRevision, expectedCritical, pendingInputCutoff: bridge.inputCursor,
        consumedInputIds: [], boundarySeq: session.seq - 1, fencingEpoch: writer.epoch, proposal: p,
        checkpointHash: hash(p.checkpoint), oldSurfaceNodes: nodes, oldSurfaceHash: hash(nodes),
        originalEventRefs: nodes.map(seq => ({ seq, sha256: hash(session.eventAt(seq)) })),
        proposedSurfaceHash: hash(proposalPlacement(p)), certificateHash: hash(certificate()), preparedAt: Date.now() }
      intent.integrityHash = hash(intent); active = freezeWindow(intent)
      await fault('before-prepare')
      session.append('native/window-intent', active, { writerToken: writer })
      await barrier.persist(); await fault('prepared-durable')
      await fault('before-commit')
      verifyIntent(active); verifyOld(active)
      let conflict, refused = false
      try {
        certificate()
        if (syncWindow(validateProposal, active.proposal, session, syncWindow(participation.read), { writerToken: writer, intent: active }) !== true) fail('WINDOW_PROPOSAL_UNVERIFIED')
        if (bridge.surfaceRevision !== active.expectedSurfaceRevision || hash(certificate()) !== active.certificateHash
          || syncWindow(participation.assertHeld, criticalToken, active.expectedCritical) !== true) fail('WINDOW_COMMIT_CAS_CONFLICT')
      } catch (error) { refused = true; conflict = error }
      if (refused) {
        // Something this commit was bound to moved (another session's install on the host, the plan, a lease). The old
        // surface is untouched, so resolve the intent here rather than leaving the session fenced until recover().
        // An unexpected surface is not a conflict but damage: that stays fenced for recovery to judge.
        // A defect in a validator is not a conflict either: it must stay loud, not become a quiet retry.
        if (!(conflict instanceof Error) || conflict instanceof TypeError || conflict instanceof ReferenceError || conflict instanceof RangeError
          || bridge.surfaceRevision !== active.expectedSurfaceRevision || hash(bridge.readWindowSurface(writer).nodes) !== active.oldSurfaceHash) throw conflict
        session.append('native/window-aborted', { transitionId, reason: 'commit-cas-conflict', intentHash: active.integrityHash }, { writerToken: writer })
        await barrier.persist()
        paused = false; active = undefined
        throw Object.assign(new Error(conflict.message, { cause: conflict }), { code: conflict.code ?? conflict.message, transitionAborted: true, retryable: true })
      }
      const commit = { transitionId, sessionId, fromWindowId: active.fromWindowId, toWindowId: active.toWindowId,
        intentHash: active.integrityHash, checkpointHash: active.checkpointHash, fencingEpoch: writer.epoch,
        pendingInputCutoff: active.pendingInputCutoff, consumedInputIds: [], windowStart: true }
      const message = { ...p.message, source: { ...p.message.source, windowCommit: commit } }
      const event = session.append('user/message', message, { writerToken: writer, expectedSurfaceRevision: active.expectedSurfaceRevision,
        surfaceOp: proposalOperation(p), sourceEventSeqs: [...p.sourceEventSeqs] })
      appended = true
      await fault('commit-appended'); await barrier.persist(); await fault('commit-durable'); await fault('before-publish')
      paused = false; active = undefined
      return receipt(event)
    } catch (error) {
      // Any indeterminate durable write leaves admission/reads fenced until recovery.
      if (!appended && active && !intents().some(e => e.data.transitionId === active.transitionId)) { active = undefined; paused = false }
      thrown = error
      throw error
    } finally {
      // A failing release must not replace the outcome: neither a durable commit receipt nor the abort marker the
      // caller counts. It is kept on the error, or in status() when the transition itself succeeded.
      let failedRelease
      try { if (writer) bridge.releaseWriter(writer) } catch (error) { failedRelease = error }
      try { if (criticalToken) await participation.release(criticalToken) } catch (error) { failedRelease ??= error }
      running = false
      if (failedRelease) {
        releaseError = failedRelease.code ?? failedRelease.message ?? String(failedRelease)
        if (thrown instanceof Error && Object.isExtensible(thrown)) thrown.releaseError = failedRelease
      }
    }
  }
  async function recover() {
    if (running) fail('WINDOW_RECOVERY_BUSY')
    running = true
    let writer, token
    try {
      certificate()
      let disk = await barrier.read()
      verifyJournal(disk)
      const pending = intents().filter(e => !session.snapshotEvents().some(t => t.type === 'native/window-aborted' && t.data.transitionId === e.data.transitionId))
      const intentEvent = active ? intents().find(e => e.data.transitionId === active.transitionId) : pending.findLast(e => !terminal(e.data.transitionId))
      if (!intentEvent) {
        if (active || session.snapshotEvents().some(e=>(commitOf(e)||e.type==='native/window-aborted') && hash(disk[e.seq])!==hash(e))) fail('WINDOW_RECOVERY_REQUIRED')
        paused = false; return { state: 'clean' }
      }
      active = intentEvent.data; paused = true
      verifyIntent(active); verifyOld(active)
      const currentCritical = structuredClone(syncWindow(participation.read))
      token = await participation.acquire(currentCritical, { recovery: true })
      if (syncWindow(participation.assertHeld, token, currentCritical) !== true) fail('WINDOW_CRITICAL_CAS_CONFLICT')
      writer = bridge.acquireWriter(bridge.surfaceRevision)
      disk = await barrier.read(); verifyJournal(disk)
      const committed = session.snapshotEvents().find(e => commitOf(e)?.transitionId === active.transitionId)
      if (committed) {
        const c = commitOf(committed)
        verifyCommit(committed, active)
        if (c.intentHash !== active.integrityHash || c.checkpointHash !== active.checkpointHash) fail('WINDOW_RECOVERY_REQUIRED')
        const diskCommit = disk.find(e => commitOf(e)?.transitionId === active.transitionId)
        if (!diskCommit || hash(diskCommit) !== hash(committed)) fail('WINDOW_RECOVERY_REQUIRED')
        paused = false; active = undefined
        return { state: 'committed', receipt: receipt(committed) }
      }
      const aborted=session.snapshotEvents().find(e=>e.type==='native/window-aborted' && e.data.transitionId===active.transitionId)
      if(aborted) {
        if(hash(disk[aborted.seq])!==hash(aborted))fail('WINDOW_RECOVERY_REQUIRED')
        paused=false;active=undefined;return {state:'aborted'}
      }
      if (bridge.surfaceRevision !== active.expectedSurfaceRevision || hash(bridge.readWindowSurface(writer).nodes) !== active.oldSurfaceHash) fail('WINDOW_RECOVERY_REQUIRED')
      session.append('native/window-aborted', { transitionId: active.transitionId, reason: 'conservative-prepared-recovery', intentHash: active.integrityHash }, { writerToken: writer })
      await barrier.persist(); paused = false; active = undefined
      return { state: 'aborted' }
    } catch (error) { paused = true; throw error }
    finally {
      try { if (writer) bridge.releaseWriter(writer) }
      finally { try { if (token) await participation.release(token) } finally { running = false } }
    }
  }
  // Releases the session's gate so a successor coordinator can bind. Refused mid-transition.
  function detach() {
    if (running) fail('WINDOW_TRANSITION_BUSY')
    if (typeof bridge.unbindWindowGate !== 'function') fail('WINDOW_COORDINATOR_RELEASE_UNAVAILABLE')
    bridge.unbindWindowGate(gate)
  }
  return Object.freeze({ transition, recover, detach, status: () => ({ paused, running, activeTransitionId: active?.transitionId ?? null, windowId: currentWindow(), releaseError }) })
}

// The loaded-code certificate reads this module's own source hash from here (see team-v15-window-loaded.mjs).
import { registerLoadedModule } from './team-v15-window-loaded.mjs'
registerLoadedModule(import.meta.url)
