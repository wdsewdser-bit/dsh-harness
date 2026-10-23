import { binding, clone, digest, fail } from './team-v16-capability-common.mjs'
import { windowHash } from './team-v15-window-checkpoint.mjs'
export const name = 'team-v16-context-episodes'
export const inject = ['tools', 'agentTeams', 'windowCheckpointRuntime']
export const provide = ['teamContextEpisodes']
export function createContextEpisodes(ctx, { collector, resolveActor, maxEpisodes = 64 } = {}) {
  const entries = new Map()
  let closed = false
  const actor = agent => { if (closed || !collector) fail('EPISODE_AUTHORITY_REQUIRED'); return binding(ctx, agent, resolveActor) }
  // Live call/step boundaries change on every read. Bind retained observations
  // to current authority and exact retained sources, not that transient surface.
  const authorityHash = source => digest({ sessionId: source.sessionId, actorId: source.actorId,
    rootTeamId: source.rootTeamId, identityVersion: source.identityVersion, identityHashes: source.identityHashes,
    configFingerprint: source.configFingerprint, planRef: source.planRef, planRevision: source.planRevision,
    planHash: source.planHash, authority: source.authority })
  function snapshot(agent) {
    const acl = actor(agent), authority = collector.authorityForSurface(acl.session)
    const captured = authority.capture(acl.session)
    authority.validate(captured.checkpoint)
    const { source, checkpoint } = captured
    const pending = source.authority?.pendingAcceptanceRefs
    if (source.sessionId !== acl.session || source.rootTeamId !== acl.team || !Array.isArray(source.pendingMessageIds)
      || source.pendingMessageIds.length || !Array.isArray(source.recovery?.memoryDebt) || source.recovery.memoryDebt.length
      || !Array.isArray(source.recovery.activeJobs) || source.recovery.activeJobs.length
      || source.recovery.requiredRereads?.length || Object.values(pending?.input ?? {}).some(value => typeof value === 'number' && value > 0)
      || (pending?.inbox?.nextStep?.length ?? 0) > 0 || (pending?.inbox?.nextTurn?.length ?? 0) > 0) fail('EPISODE_RECOVERY_PENDING')
    return { acl, source, checkpoint, authorityHash: authorityHash(source) }
  }
  function exact(agent, id) {
    const latest = snapshot(agent), row = entries.get(id)
    if (!row || row.revoked || digest(row.acl) !== digest(latest.acl)) fail('EPISODE_DENIED')
    if (row.authorityHash !== latest.authorityHash) fail('EPISODE_STALE')
    const events = collector.readRecovery(latest.acl.session, row.receipt)
    if (windowHash(events) !== row.receipt.eventsHash || digest(events) !== row.eventsHash) fail('EPISODE_SOURCE_CHANGED')
    return { row, events }
  }
  return Object.freeze({
    async collect(agent) {
      const before = actor(agent)
      await collector.retainCompletedTurns(before.session)
      const latest = snapshot(agent)
      if (digest(before) !== digest(latest.acl)) fail('EPISODE_ACTOR_CHANGED')
      const ids = []
      for (const span of latest.source.completedSpans) {
        if (span.status !== 'completed' || span.memoryDebtCovered !== true) fail('EPISODE_SPAN_UNPROVEN')
        const receipt = span.retentionReceipt, events = collector.readRecovery(before.session, receipt)
        if (windowHash(events) !== receipt.eventsHash) fail('EPISODE_SOURCE_CHANGED')
        const eventsHash = digest(events), id = 'episode-' + digest({ acl: before, receipt: receipt.id, authorityHash: latest.authorityHash })
        if (entries.get(id)?.revoked) continue
        if (!entries.has(id) && entries.size >= maxEpisodes) fail('EPISODE_LIMIT')
        entries.set(id, { id, acl: before, receipt: clone(receipt), checkpointHash: latest.checkpoint.checkpointIntegrityHash,
          authorityHash: latest.authorityHash, eventsHash, revoked: false })
        ids.push(id)
      }
      return { ids, authority: 'non-authoritative-completed-observation' }
    },
    list(agent) {
      const latest = snapshot(agent)
      return [...entries.values()].filter(row => !row.revoked && digest(row.acl) === digest(latest.acl) && row.authorityHash === latest.authorityHash)
        .map(row => ({ id: row.id, sourceHash: row.eventsHash, checkpointHash: row.checkpointHash, authority: 'non-authoritative-completed-observation' }))
    },
    read(agent, id) { const { row, events } = exact(agent, id); return { id, events: clone(events), sourceHash: row.eventsHash, checkpointHash: row.checkpointHash } },
    summarize(agent, id, { maxChars = 1200 } = {}) {
      if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 8192) fail('EPISODE_SUMMARY_LIMIT')
      const { row, events } = exact(agent, id)
      const original = events.flatMap(event => {
        const message = event.type === 'user/message' ? event.data : event.data?.message
        return (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text)
      }).join('\n')
      return { id, kind: 'non-authoritative-extractive-observation', text: original.slice(0, maxChars), sourceHash: row.eventsHash, exactRead: { id }, truncated: original.length > maxChars }
    },
    revoke(agent, id) { const { row } = exact(agent, id); row.revoked = true; return { revoked: true } },
    dispose() { closed = true; entries.clear() },
  })
}
export function apply(ctx, config = {}) {
  const service = createContextEpisodes(ctx, { ...config, collector: config.collector ?? ctx.windowCheckpointRuntime })
  const stop = ctx.provide('teamContextEpisodes', service)
  // Collection is server initiated: models cannot nominate completed turns or receipts.
  const stopTool = ctx.tools.register({ name: 'context_episode', description: 'Read retained completed context observations, with original event recovery.',
    parameters: { type: 'object', properties: { operation: { type: 'string', enum: ['list', 'read', 'summarize'] }, id: { type: 'string' } }, required: ['operation'], additionalProperties: false },
    output: { schema: {}, render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute(args, exec) { return args.operation === 'list' ? service.list(exec.agent) : service[args.operation](exec.agent, args.id) } })
  return () => { service.dispose(); stopTool(); stop?.() }
}
