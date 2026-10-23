import { realpathSync, statSync } from 'node:fs'
import { controlPlaneForMember, readControlPlaneSnapshot } from './team-control-plane.mjs'
import { policyFor } from './team-policy.mjs'
import { currentTaskPlanRefs } from './team-v15-plan-refs.mjs'
import { installToolReferences } from './team-v16-tool-references.mjs'
import { installSdkCatalog } from './team-v16-sdk-catalog.mjs'
import { createContextEpisodes } from './team-v16-context-episodes.mjs'
import { clone, fail } from './team-v16-capability-common.mjs'
export const name = 'team-v16-capabilities-runtime'
export const inject = ['tools', 'agents', 'agentTeams', 'requestMessageProjection']
export const provide = ['teamV16Capabilities', 'teamToolReferences', 'teamSdkCatalog', 'teamContextEpisodes']
const serviceOf = (ctx, name) => { try { return ctx.get?.(name) ?? ctx[name] } catch { return undefined } }

export function createNativeCapabilityActorResolver(ctx, { controlDir, now = Date.now } = {}) {
  return agent => {
    if (!agent || !ctx.agents.list().includes(agent)) fail('V16_ACTOR_NOT_LIVE')
    const membership = ctx.agentTeams.tryMembership(agent)
    if (!membership?.id || !membership.name || !agent.session?.id) fail('V16_MEMBERSHIP_REQUIRED')
    const policy = policyFor(membership.id).get(membership.name)
    if (!policy || policy.frozen === true || ![0, 1, 2].includes(Number(policy.tier))) fail('V16_POLICY_IDENTITY_REQUIRED')
    const control = controlPlaneForMember(ctx, agent, { directory: controlDir })
    if (!control || control.rootId !== membership.id) fail('V16_CONTROL_IDENTITY_MISMATCH')
    const state = readControlPlaneSnapshot(control.file)
    if (state.rootId !== membership.id) fail('V16_CONTROL_IDENTITY_MISMATCH')
    const at = now(), matches = []
    if (!Number.isFinite(at)) fail('V16_CLOCK_UNAVAILABLE')
    for (const [boardId, board] of Object.entries(state.boards ?? {})) for (const task of Object.values(board.tasks ?? {})) {
      if (!task?.id || task.status !== 'in_progress' || task.phase !== 'execution'
        || (task.ownerName ?? task.owner ?? task.contract?.owner) !== membership.name) continue
      matches.push({ boardId, task })
    }
    // Duplicated global/group cards are ambiguous unless the host has one exact live task occurrence.
    if (matches.length !== 1) fail('V16_UNIQUE_ACTIVE_TASK_REQUIRED')
    const { boardId, task } = matches[0], approved = state.plans?.[task.id]
    if (approved?.state !== 'plan-approved' || !approved.approvedBy || !Number.isFinite(approved.approvedAt)
      || !Number.isSafeInteger(approved.revision) || !approved.members?.includes(membership.name)) fail('V16_APPROVED_TASK_PLAN_REQUIRED')
    const leases = Object.entries(state.leases ?? {}).filter(([, lease]) => lease.status === 'active'
      && lease.member === membership.name && lease.taskId === task.id
      && lease.contractRevision === task.contract?.contractRevision && Number.isFinite(lease.expiresAt) && lease.expiresAt > at)
    if (leases.length !== 1) fail('V16_CURRENT_OWNER_LEASE_REQUIRED')
    const [leaseRef, lease] = leases[0], registered = currentTaskPlanRefs(state, { boardId, taskId: task.id })
    const nativeCwd = agent.session.header?.cwd
    if (typeof nativeCwd !== 'string' || !nativeCwd) fail('V16_WORKSPACE_REQUIRED')
    const workspace = realpathSync.native(nativeCwd)
    if (!statSync(workspace).isDirectory()) fail('V16_WORKSPACE_REQUIRED')
    return clone({ role: Number(policy.tier) === 0 ? 'root' : policy.group === 'verifier' ? 'verifier' : Number(policy.tier) === 1 ? 'lead' : 'member',
      workspace, task: boardId + ':' + task.id, taskRevision: registered.taskRevision,
      plan: registered.planId, planRevision: registered.planRevision,
      authority: { boardId, taskId: task.id, contractRevision: registered.contractRevision,
        planHash: registered.planHash, approvedPlanRevision: approved.revision, approvedBy: approved.approvedBy, approvedAt: approved.approvedAt,
        leaseRef, runId: lease.runId ?? leaseRef,
        identity: { tier: Number(policy.tier), group: policy.group ?? null, parent: policy.parent ?? null, frozen: policy.frozen === true } } })
  }
}

export function installCapabilitiesRuntime(ctx, config = {}) {
  const resolveActor = createNativeCapabilityActorResolver(ctx, config)
  const references = installToolReferences(ctx, { ...config.references, resolveActor })
  let catalog
  try { catalog = installSdkCatalog(ctx, { ...config.catalog, isolated: config.sdkCoreProjection === true,
    projectCore: config.sdkCoreProjection === true }) } catch (error) { references.dispose(); throw error }
  const episodeInstances = new Map()
  let closed = false
  function currentEpisodes() {
    if (closed) fail('V16_CAPABILITIES_CLOSED')
    const collector = serviceOf(ctx, 'windowCheckpointRuntime')
    if (!collector || typeof collector.authorityForSurface !== 'function' || typeof collector.readRecovery !== 'function'
      || typeof collector.retainCompletedTurns !== 'function') fail('V16_AUTHORIZED_COLLECTOR_UNAVAILABLE')
    for (const [previous, service] of episodeInstances) if (previous !== collector) { service.dispose(); episodeInstances.delete(previous) }
    if (!episodeInstances.has(collector)) episodeInstances.set(collector, createContextEpisodes(ctx, {
      ...config.episodes, collector, resolveActor,
    }))
    return episodeInstances.get(collector)
  }
  const episodes = Object.freeze(Object.fromEntries(['collect', 'list', 'read', 'summarize', 'revoke']
    .map(operation => [operation, (...args) => currentEpisodes()[operation](...args)])))
  let stopTool
  try {
    stopTool = ctx.tools.register({ name: 'context_episode', description: 'Read retained completed context observations with exact original event recovery.',
      parameters: { type: 'object', properties: { operation: { type: 'string', enum: ['list', 'read', 'summarize'] }, id: { type: 'string' } }, required: ['operation'], additionalProperties: false },
      output: { schema: {}, render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute(args, exec) { return args.operation === 'list' ? episodes.list(exec.agent) : episodes[args.operation](exec.agent, args.id) } })
  } catch (error) { references.dispose(); catalog.dispose(); throw error }
  const runtime = Object.freeze({ resolveActor, references: references.service, catalog: catalog.service, episodes,
    runtimeFacts: () => ({ loaded: !closed, sdkCoreProjection: config.sdkCoreProjection === true,
      collectorAvailable: Boolean(serviceOf(ctx, 'windowCheckpointRuntime')), collectorScopeChanged: false,
      authority: 'live-native-membership-policy-durable-control-plane-approved-plan-and-owner-lease' }) })
  const stops = []
  try {
    for (const [key, value] of [['teamV16Capabilities', runtime], ['teamToolReferences', references.service], ['teamSdkCatalog', catalog.service], ['teamContextEpisodes', episodes]]) stops.push(ctx.provide(key, value))
  } catch (error) { references.dispose(); catalog.dispose(); stopTool(); for (const stop of stops.reverse()) stop?.(); throw error }
  return { service: runtime, dispose() {
    if (closed) return
    closed = true
    for (const service of episodeInstances.values()) service.dispose()
    episodeInstances.clear(); stopTool(); catalog.dispose(); references.dispose()
    for (const stop of stops.reverse()) stop?.()
  } }
}
export function apply(ctx, config = {}) { return installCapabilitiesRuntime(ctx, config).dispose }
