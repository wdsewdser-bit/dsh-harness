import { planDeliveryHash as hash } from './team-v15-plan-delivery.mjs'

export const windowHash = hash
// Host provenance is not model input. Assistant replay metadata can carry signed provider content, so retain it
// in this conservative budget. This is a Harness payload measure, not provider HTTP bytes or token usage.
export const windowMessagePayload = messages => messages.map(message => ({ role: message.role, content: message.content,
  ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
  ...(message.role === 'assistant' && message.source?.replayState !== undefined ? { replayState: message.source.replayState } : {}) }))
export const windowMessageBytes = messages => Buffer.byteLength(JSON.stringify(windowMessagePayload(messages)))
export const authorityKeys = ['activeTaskIds', 'taskRevisions', 'contractRevisions', 'requirementRefs', 'decisionRefs', 'ownerScopeLeaseRefs', 'phaseRefs', 'pendingAcceptanceRefs', 'waitingRefs', 'wakeInboxRefs', 'planCoverageStates', 'evidenceRefs']
export const freezeWindow = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeWindow(child)
    Object.freeze(value)
  }
  return value
}
export const windowRefuse = code => { throw Object.assign(new Error(code), { code }) }
export function syncWindow(fn, ...args) {
  if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') windowRefuse('WINDOW_SERVER_READER_REQUIRED')
  const result = fn(...args)
  if (result?.then) windowRefuse('WINDOW_ASYNC_READER_REJECTED')
  return result
}

/** Only server callbacks can supply authority and original event recovery. */
export function createWindowCheckpointAuthority({ readSource, verifyRecovery }) {
  function read(sessionId) {
    const s = structuredClone(syncWindow(readSource, sessionId))
    if (!s || s.sessionId !== sessionId || !s.actorId || !s.rootTeamId || !Number.isSafeInteger(s.windowId)
      || !Number.isSafeInteger(s.surfaceRevision) || !s.criticalRevisionVector || !s.identityVersion
      || !s.identityHashes || !s.configFingerprint || !s.planRef?.path || !/^[a-f0-9]{64}$/.test(s.planRef.sha256 ?? '') || !Number.isSafeInteger(s.planRevision)
      || !/^[a-f0-9]{64}$/.test(s.planHash ?? '') || !Array.isArray(s.messages) || !Array.isArray(s.events)
      || !Array.isArray(s.recentTailIds) || !s.recentTailIds.length || !Array.isArray(s.pendingMessageIds)
      || !Array.isArray(s.completedSpans) || authorityKeys.some(k => !Object.hasOwn(s.authority ?? {}, k) || !s.authority[k] || typeof s.authority[k] !== 'object')
      || !Array.isArray(s.recovery?.memoryDebt) || !Array.isArray(s.recovery?.requiredRereads)
      || !Array.isArray(s.recovery?.activeJobs)) windowRefuse('WINDOW_AUTHORITY_INCOMPLETE')
    return freezeWindow(s)
  }
  // Fixed algorithm over declared request history and critical bindings, not raw journal bytes.
  function sourceHash(s) {
    const { events, working, ...binding } = s
    return hash({ algorithm: 'window-source-v1', binding, eventRefs: s.completedSpans.flatMap(span => span.eventRefs ?? []) })
  }
  function capture(sessionId) {
    const s = read(sessionId)
    const source = sourceHash(s)
    const cp = { schemaVersion: 1, checkpointId: 'window-' + source, sessionId, rootTeamId: s.rootTeamId,
      actorId: s.actorId, windowId: s.windowId, planRef: s.planRef, planRevision: s.planRevision, planHash: s.planHash,
      authority: s.authority, working: { kind: 'non-authoritative-observation', value: s.working ?? {} },
      recovery: s.recovery, sourceRange: s.completedSpans.flatMap(span => span.eventRefs ?? []).map(ref => ref.seq),
      sourceHash: source, surfaceRevision: s.surfaceRevision, criticalRevisionVector: s.criticalRevisionVector,
      identityVersion: s.identityVersion, identityHashes: s.identityHashes, configFingerprint: s.configFingerprint }
    cp.checkpointIntegrityHash = hash(cp)
    return freezeWindow({ source: s, checkpoint: cp })
  }
  function verifySpan(s, span) {
    if (span.status !== 'completed' || !Array.isArray(span.messageIds) || !span.messageIds.length
      || !Array.isArray(span.eventRefs) || span.eventRefs.length !== span.messageIds.length
      || !span.retentionReceipt || span.memoryDebtCovered !== true) windowRefuse('WINDOW_SPAN_UNPROVEN')
    for (const [index, ref] of span.eventRefs.entries()) {
      const event = s.events.find(e => e.seq === ref.seq)
      const original = event?.type === 'user/message' ? event.data : event?.data?.message
      if (!event || ref.sha256 !== hash(event) || original?.id !== span.messageIds[index]
        || hash(original) !== hash(s.messages.find(m => m.id === span.messageIds[index]))) windowRefuse('WINDOW_EVENT_REF_MISMATCH')
    }
    if (syncWindow(verifyRecovery, structuredClone(s), structuredClone(span)) !== true) windowRefuse('WINDOW_RECOVERY_UNAVAILABLE')
  }
  function validate(checkpoint) {
    const { checkpointIntegrityHash, ...body } = checkpoint
    if (hash(body) !== checkpointIntegrityHash) windowRefuse('WINDOW_CHECKPOINT_INTEGRITY')
    const latest = capture(checkpoint.sessionId)
    if (hash(latest.checkpoint) !== hash(checkpoint)) {
      // Field names only: which bindings moved, for the audit trail of a refused dispatch.
      const moved = (a, b) => [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].filter(key => hash(a?.[key]) !== hash(b?.[key]))
      throw Object.assign(new Error('WINDOW_SOURCE_CAS_CONFLICT'), { code: 'WINDOW_SOURCE_CAS_CONFLICT',
        changed: moved(checkpoint, latest.checkpoint).filter(key => !['checkpointId', 'sourceHash', 'checkpointIntegrityHash'].includes(key)),
        changedRevisions: moved(checkpoint.criticalRevisionVector, latest.checkpoint.criticalRevisionVector) })
    }
    for (const span of latest.source.completedSpans) verifySpan(latest.source, span)
    return latest
  }
  return Object.freeze({ capture, validate, verifySpan })
}

// The loaded-code certificate reads this module's own source hash from here (see team-v15-window-loaded.mjs).
import { registerLoadedModule } from './team-v15-window-loaded.mjs'
registerLoadedModule(import.meta.url)
