/** Event-driven continuation of approved Team tasks, with a recovery scan. */
import { controlPlaneForMember, hashControlValue } from './team-control-plane.mjs'
import { createReadyQueueContext, evaluateReadyTask, taskStatus } from './team-v12-evidence-scheduler.mjs'
import { reconcileWaitingTickets, waitingTicketActive } from './team-v14-waiting.mjs'
import {
  armedRoots,
  consumeBackgroundWake,
  focusRoot,
  isArmed,
  markBackgroundWake,
} from './team-armed-roots.mjs'

export const name = 'team-v14-event-continuation'
export const inject = ['agents', 'agentTeams']

console.log('[team-v14-event-continuation] HMR perf61-inactive-guard loaded 2026-09-27')

const text = (value) => String(value ?? '').trim()
const lower = (value) => text(value).toLowerCase()
const rows = (value) => Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : []
const taskId = (task) => text(task?.id ?? task?.taskId)
const taskRows = (state) => Object.values(state?.boards ?? {}).flatMap((board) => Object.values(board?.tasks ?? {}))
const taskOwner = (task) => text(task?.ownerName ?? task?.owner ?? task?.contract?.owner)

// Cordis service reads throw once a plugin context is inactive. Timers and
// late async callbacks must never take the whole harness down with them.
function teamsOf(ctx) {
  try { return ctx?.agentTeams } catch { return undefined }
}

function safeWarn(ctx, message) {
  try { ctx?.logger?.warn?.(message) } catch { /* plugin context may already be inactive */ }
}

function agentsOf(ctx) {
  try { return ctx?.agents?.list?.() ?? [] } catch { return [] }
}

function paused(task, owner) {
  return task?.manualPause === true || task?.paused === true || task?.background === true
    || task?.externalWait === true || task?.waitingExternal === true
    || owner?.frozen === true || owner?.paused === true || owner?.manualPause === true
    || ['paused', 'waiting-human', 'waiting-approval', 'background'].includes(lower(task?.status))
}

function waitingForRoom(state, task) {
  const roomId = text(task?.roomId ?? task?.contract?.roomId) || 'task:' + taskId(task)
  const room = state?.rooms?.[roomId]
  const round = room?.currentRoundId == null ? undefined : state?.rounds?.[room.currentRoundId]
  if (round?.status === 'open') return true
  if (lower(task?.phase) !== 'room-discussion') return false
  return room?.status === 'open'
}

function editTask(task) {
  const scopes = task?.writeScopes ?? task?.contract?.writeScopes
  return lower(task?.workKind ?? task?.contract?.kind) === 'edit'
    || (Array.isArray(scopes) && scopes.length > 0)
}

function scopeOverlap(left, right) {
  const normalize = (scope) => text(scope).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  const a = normalize(left)
  const b = normalize(right)
  return !!a && !!b && (a === b || a.startsWith(b + '/') || b.startsWith(a + '/'))
}

function candidateTiming(task, now, options = {}) {
  const rawCreatedAt = task?.createdAt ?? task?.updatedAt
  const rawUpdatedAt = task?.updatedAt ?? task?.createdAt
  const createdAt = rawCreatedAt !== undefined && rawCreatedAt !== null && Number.isFinite(Number(rawCreatedAt))
    ? Number(rawCreatedAt)
    : Number(now)
  const updatedAt = rawUpdatedAt !== undefined && rawUpdatedAt !== null && Number.isFinite(Number(rawUpdatedAt))
    ? Number(rawUpdatedAt)
    : Number(now)
  const ageMs = Math.max(0, Number(now) - Math.min(createdAt, updatedAt))
  const stepMs = Math.max(1000, Number(options.agingStepMs ?? 15 * 60 * 1000))
  const maxBoost = Math.max(0, Number(options.agingMaxBoost ?? 1000))
  const priority = Number(task?.priority ?? task?.contract?.priority ?? 0)
  const ageBoost = Math.min(maxBoost, Math.floor(ageMs / stepMs))
  return { createdAt, updatedAt, ageMs, ageBoost, effectivePriority: priority + ageBoost }
}

function reviewWait(ticket) {
  const condition = ticket?.unblockCondition ?? {}
  return /verifier|review|reviewer|audit|复验|裁决/i.test([
    ticket?.reason,
    ticket?.responsible,
    condition.who,
    condition.what,
    condition.detail,
    condition.action,
    condition.note,
  ].map(text).filter(Boolean).join(' '))
}

function escalationTarget(ticket, task, memberMap, members) {
  const condition = ticket?.unblockCondition ?? {}
  const named = [ticket?.responsible, ticket?.owner, condition.who, condition.approver, condition.by]
    .map(text).find((name) => memberMap.has(name))
  if (named) return { target: named, fallback: false }
  const verifier = rows(members).find((member) => /verifier|reviewer|auditor/i.test(
    [member.name, member.id, member.role, member.kind].map(text).join(' ')))
  if (verifier) return { target: text(verifier.name ?? verifier.id), fallback: false }
  const owner = taskOwner(task)
  const ownerRow = memberMap.get(owner)
  const parent = text(ownerRow?.parent ?? ownerRow?.parentName)
  if (parent && memberMap.has(parent)) return { target: parent, fallback: true }
  return owner ? { target: owner, fallback: true } : { target: '', fallback: true }
}

/** Pending starts and idle in-progress recovery are separate, read-only decisions. */
export function continuationCandidates(state, members = [], now = Date.now(), options = {}) {
  const tasks = taskRows(state)
  const memberMap = new Map(rows(members).map((member) => [text(member.name ?? member.id), member]))
  const leases = Object.values(state?.leases ?? {})
  const queueContext = createReadyQueueContext(tasks, members, leases, {
    now,
    staleExecutionMs: options.staleExecutionMs,
  })
  const baseRows = new Map(tasks.map((task) => [taskId(task), evaluateReadyTask(task, queueContext)]))
  const candidates = tasks.flatMap((task) => {
    const status = taskStatus(task)
    const mode = status === 'pending' || status === 'approved' ? 'first-start'
      : status === 'running' && lower(task.status) === 'in_progress' ? 'idle-resume' : null
    if (!mode) return []
    const row = mode === 'idle-resume'
      ? evaluateReadyTask(task, queueContext, {
          status: 'pending',
          running: queueContext.running.filter((active) => active !== task),
        })
      : baseRows.get(taskId(task))
    if (!row?.eligible) return []
    const ownerName = taskOwner(task)
    const owner = memberMap.get(ownerName)
    const waits = Object.values(state?.v14Waiting?.tickets ?? {})
      .filter((ticket) => text(ticket?.taskId) === taskId(task) && text(ticket?.owner) === ownerName)
    if (waits.some((ticket) => waitingTicketActive(ticket, state, now))) return []
    if (!owner || !['idle', 'inactive'].includes(lower(owner.status ?? owner.state)) || paused(task, owner)) return []
    if (waitingForRoom(state, task)) return []
    const liveLease = queueContext.activeLeasesByTask.get(taskId(task))
      ?? queueContext.activeLeases.get(ownerName)
    if (liveLease && (text(liveLease.member) === ownerName || text(liveLease.taskId) === row.id)) return []
    if (editTask(task) && (row.scopes.length === 0 || state?.plans?.[row.id]?.state !== 'plan-approved')) return []
    if (mode === 'first-start' && !['ready', 'approved', 'plan-approved', 'execution'].includes(lower(task.lifecycle))
      && !['plan-approved', 'execution'].includes(lower(task.phase))
      && lower(task.status) !== 'approved' && task.approved !== true) return []
    if (state?.frozenMembers?.[ownerName]?.frozen === true) return []
    const discussion = lower(task.workKind ?? task.contract?.kind) === 'discussion'
    if (mode === 'idle-resume' && lower(task.phase) !== 'execution'
      && !(discussion && lower(task.phase) === 'room-discussion')) return []
    const timing = candidateTiming(task, now, options)
    return [{ ...row, ...timing, mode, revision: Number(task.revision ?? 0), phase: text(task.phase),
      ownerStatus: lower(owner.status ?? owner.state), target: ownerName }]
  }).sort((left, right) => (left.mode === 'first-start' ? 0 : 1) - (right.mode === 'first-start' ? 0 : 1)
    || right.effectivePriority - left.effectivePriority
    || right.ageMs - left.ageMs || left.id.localeCompare(right.id))
  const selected = []
  for (const candidate of candidates) {
    const conflict = selected.find((other) => candidate.worktree === other.worktree
      && candidate.scopes.some((scope) => other.scopes.some((otherScope) => scopeOverlap(scope, otherScope))))
    if (!conflict) selected.push(candidate)
  }
  return selected
}

/** Dynamic batch plan: expand only when the actionable backlog exceeds the base. */
export function continuationBatchSize(candidates, options = {}) {
  const count = Array.isArray(candidates) ? candidates.length : 0
  const base = Math.max(1, Number(options.baseLimit ?? options.maxPerScan ?? 4) || 4)
  const ceiling = Math.max(base, Number(options.ceiling ?? options.maxPerScanCeiling ?? 16) || 16)
  const backlog = count > base
  return {
    candidates: count,
    base,
    ceiling,
    backlog,
    limit: Math.min(ceiling, backlog ? count : base),
  }
}

/**
 * Review/verifier waits older than their SLA become explicit escalation wakes.
 * The task owner remains responsible when no verifier or parent can be named.
 */
export function continuationSlaCandidates(state, members = [], options = {}) {
  const now = Number(options.now ?? Date.now())
  const slaMs = Math.max(1000, Number(options.verifierSlaMs ?? 30 * 60 * 1000))
  const memberMap = new Map(rows(members).map((member) => [text(member.name ?? member.id), member]))
  return Object.values(state?.v14Waiting?.tickets ?? {}).flatMap((ticket) => {
    if (!waitingTicketActive(ticket, state, now) || !reviewWait(ticket)) return []
    const nextCheckAt = Number(ticket.nextCheckAt)
    if (Number.isFinite(nextCheckAt) && nextCheckAt > now) return []
    const task = taskRows(state).find((row) => taskId(row) === text(ticket.taskId))
    if (!task) return []
    const ageMs = Math.max(0, now - Number(ticket.createdAt ?? ticket.updatedAt ?? now))
    if (ageMs < slaMs) return []
    const timing = candidateTiming(task, now, options)
    const escalation = escalationTarget(ticket, task, memberMap, members)
    if (!escalation.target) return []
    return [{
      id: taskId(task),
      owner: escalation.target,
      target: escalation.target,
      mode: 'sla-escalation',
      revision: Number(task.revision ?? 0),
      priority: timing.effectivePriority,
      effectivePriority: timing.effectivePriority + 10000,
      ageMs,
      createdAt: timing.createdAt,
      updatedAt: timing.updatedAt,
      ticketId: text(ticket.ticketId),
      responsible: text(ticket.responsible),
      reason: text(ticket.reason),
      slaMs,
      escalationFallback: escalation.fallback,
    }]
  }).sort((left, right) => right.effectivePriority - left.effectivePriority
    || right.ageMs - left.ageMs || left.id.localeCompare(right.id))
}

export function continuationEpisodeId(candidate) {
  return 'continuation:' + encodeURIComponent(String(candidate?.id)) + ':r'
    + String(Number(candidate?.revision ?? 0)) + ':' + encodeURIComponent(String(candidate?.owner))
}

export function continuationText(candidate) {
  if (candidate.mode === 'sla-escalation') {
    return '[team continuation] 复核等待已超过 SLA ' + String(candidate.id) + '。target=' + String(candidate.owner)
      + ' ticket=' + String(candidate.ticketId) + ' responsible=' + String(candidate.responsible)
      + '。请立即给出 CLEARED/blocker 裁决或记录新的明确责任人与期限。'
  }
  const verb = candidate.mode === 'idle-resume' ? '恢复已领取任务 ' : '开始已批准任务 '
  return '[team continuation] ' + verb + String(candidate.id) + '。owner=' + String(candidate.owner)
    + ' revision=' + String(candidate.revision) + '。先重读任务、plan 与 lease；只处理这一项。'
}

function providerBlocked(control) {
  const state = control.view({ history: false })
  return state?.provider?.status === 'blocked' || state?.health?.status === 'disabled'
}

/** Returns an attempt only when the durable episode has not been sent already. */
export function continuationAttempt(state, candidate, now = Date.now(), maxAttempts = 2, retryDelayMs = 30000) {
  const base = continuationEpisodeId(candidate)
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const episodeId = base + ':a' + attempt
    const row = state?.wakeEpisodes?.[episodeId]
    if (!row) return { episodeId, attempt }
    if (row.status !== 'delivery-failed') return null
    if (Number(now) - Number(row.updatedAt ?? row.createdAt ?? now) < retryDelayMs) return null
  }
  return null
}

async function deliver(ctx, teams, root, control, candidate, config) {
  const attempt = continuationAttempt(control.view({ history: false }), candidate, Date.now(), config.maxAttempts, config.retryDelayMs)
  if (!attempt) return { status: 'already-handled', taskId: candidate.id }
  const message = continuationText(candidate)
  const claimed = await control.wakeClaim({
    episodeId: attempt.episodeId, kind: 'control', taskId: candidate.id,
    sender: name, target: candidate.target, messageHash: hashControlValue(message),
  }, root)
  if (claimed?.claimed !== true) return { status: 'coalesced', taskId: candidate.id }
  try {
    markBackgroundWake(control.rootId)
    const result = await teams.sendMessage(root, {
      target: candidate.target, content: [{ type: 'text', text: message }],
      signal: config.signal ?? new AbortController().signal,
    })
    if (!['accepted', 'queued'].includes(result?.status) || !result.messageId) {
      throw new Error('Team mailbox returned no durable message receipt')
    }
    await control.wakeAcknowledge({ episodeId: attempt.episodeId, status: 'delivered' }, root)
    return { status: 'delivered', taskId: candidate.id, target: candidate.target,
      dispatchId: claimed.dispatch?.dispatchId, messageId: result.messageId }
  } catch (error) {
    try { await control.wakeAcknowledge({ episodeId: attempt.episodeId, status: 'delivery-failed' }, root) } catch (ackError) {
      safeWarn(ctx, 'team-v14 continuation failure receipt failed: ' + String(ackError?.message ?? ackError))
    }
    safeWarn(ctx, 'team-v14 continuation delivery failed: ' + String(error?.message ?? error))
    return { status: 'delivery-failed', taskId: candidate.id, owner: candidate.owner,
      attempt: attempt.attempt, error: String(error?.message ?? error) }
  }
}

function successfulTool(exec, result) {
  if (result?.isError === true || result?.kind === 'error') return false
  const tool = text(exec?.tool?.name ?? exec?.name)
  const action = text(exec?.arguments?.action)
  return (tool === 'team_task_update' && ['complete', 'release'].includes(action))
    || tool === 'team_plan_approve' || tool === 'team_room_close'
    || (tool === 'team_v12' && action === 'waiting_resolve')
    || (tool === 'team_run_lease' && action === 'release')
}

export function apply(ctx, config = {}) {
  console.log('[team-v14-event-continuation] HMR perf40-single-root-focus loaded 2026-09-27')
  const cfg = { controlDir: config.controlDir, scanMs: 30000, maxPerScan: 4,
    maxPerScanCeiling: 16, maxAttempts: 2, retryDelayMs: 30000,
    completionSendDeadlineMs: 30000, verifierSlaMs: 30 * 60 * 1000,
    agingStepMs: 15 * 60 * 1000, agingMaxBoost: 1000,
    staleExecutionMs: 15 * 60 * 1000, ...config }
  const inFlight = new Map()
  const summaryInFlight = new Map()
  const armed = armedRoots()
  let disposed = false
  const controlFor = (agent) => controlPlaneForMember(
    { agentTeams: teamsOf(ctx) }, agent, cfg.controlDir ? { directory: cfg.controlDir } : {})
  const armAgent = (agent) => {
    try {
      const membership = teamsOf(ctx)?.tryMembership(agent)
      if (!membership?.root) return
      const control = controlFor(membership.root)
      const agentIsRoot = agent === membership.root
        || String(agent?.id ?? '') === String(membership.root?.id ?? '')
      if (control && agentIsRoot && !consumeBackgroundWake(control.rootId)) {
        focusRoot(armed, control.rootId)
      }
    } catch { /* a stale or inactive context must not break event handling */ }
  }
  for (const agent of agentsOf(ctx)) {
    if (['running', 'provisioning'].includes(lower(agent?.status))) armAgent(agent)
  }
  const reconcileWaiting = async (control, root) => {
    const now = Date.now()
    const preview = reconcileWaitingTickets(control.view({ history: false }), { now, apply: false })
    if (preview.changed === 0) return preview
    return control.mutateHot('v14/waiting-reconcile', { at: now }, root, (latest) =>
      reconcileWaitingTickets(latest, { now }))
  }
  const scanCandidates = (state, members) => {
    const now = Date.now()
    const candidates = [
      ...continuationCandidates(state, members, now, {
        agingStepMs: cfg.agingStepMs,
        agingMaxBoost: cfg.agingMaxBoost,
        staleExecutionMs: cfg.staleExecutionMs,
      }),
      ...continuationSlaCandidates(state, members, {
        now,
        verifierSlaMs: cfg.verifierSlaMs,
        agingStepMs: cfg.agingStepMs,
        agingMaxBoost: cfg.agingMaxBoost,
      }),
    ]
    const seen = new Set()
    return candidates.filter((candidate) => {
      const episodeId = continuationEpisodeId(candidate)
      if (seen.has(episodeId)) return false
      seen.add(episodeId)
      return true
    }).sort((left, right) => right.effectivePriority - left.effectivePriority
      || right.ageMs - left.ageMs || left.id.localeCompare(right.id))
  }
  const schedule = (agent) => {
    if (disposed || !agent) return Promise.resolve([])
    let membership
    try { membership = teamsOf(ctx)?.tryMembership(agent) } catch { return Promise.resolve([]) }
    if (!membership?.root) return Promise.resolve([])
    const root = membership.root
    const control = controlFor(root)
    if (!control) return Promise.resolve([])
    const key = control.rootId
    if (!isArmed(armed, key)) return Promise.resolve([])
    if (inFlight.has(key)) return inFlight.get(key)
    const run = (async () => {
      if (disposed) return []
      await reconcileWaiting(control, root)
      if (providerBlocked(control)) return []
      const teams = teamsOf(ctx)
      if (!teams) return []
      const members = teams.listMembers(root)
      let state = control.view({ history: false })
      const candidates = scanCandidates(state, members)
      const batch = continuationBatchSize(candidates, {
        baseLimit: cfg.maxPerScan,
        ceiling: cfg.maxPerScanCeiling,
      })
      if (batch.limit === 0) return []
      let currentCandidates = candidates
      let currentRevision = Number(state.revision ?? 0)
      const results = []
      const targeted = new Set()
      for (const candidate of candidates) {
        if (results.length >= batch.limit) break
        if (targeted.has(candidate.owner)) continue
        const stateRevision = Number(state.revision ?? 0)
        if (stateRevision !== currentRevision) {
          currentCandidates = scanCandidates(state, members)
          currentRevision = stateRevision
        }
        const current = currentCandidates
          .find((row) => continuationEpisodeId(row) === continuationEpisodeId(candidate))
        if (!current || providerBlocked(control)) continue
        if (Object.values(state.wakeEpisodes ?? {}).some((episode) =>
          episode?.sender === name && episode?.target === current.owner
            && ['queued', 'turn-started'].includes(episode.status)
            && state.dispatches?.[episode.dispatchId]?.taskId !== current.id)) continue
        if (!continuationAttempt(state, current, Date.now(), cfg.maxAttempts, cfg.retryDelayMs)) continue
        targeted.add(current.owner)
        results.push(await deliver(ctx, teams, root, control, current, cfg))
        state = control.view({ history: false })
      }
      return results
    })().finally(() => { inFlight.delete(key) })
    inFlight.set(key, run)
    return run
  }
  const reportCompletion = async (agent, taskIdValue) => {
    if (disposed) return
    const teams = teamsOf(ctx)
    if (!teams) return
    const membership = teams.tryMembership(agent)
    if (!membership?.root) return
    const control = controlFor(membership.root)
    if (!control) return
    const state = control.view({ history: false })
    const task = taskRows(state).find((row) => taskId(row) === text(taskIdValue))
    if (!task || !['completed', 'accepted'].includes(taskStatus(task))) return
    const roster = teams.listMembers(membership.root)
    const owner = roster.find((row) => text(row.name) === taskOwner(task))
    const leadName = text(owner?.parent ?? owner?.parentName)
    const lead = roster.find((row) => text(row.name) === leadName)
    if (!owner?.id || !leadName || leadName === text(teams.tryMembership(membership.root)?.name)) return
    const summaryId = 'task:' + taskId(task) + ':r' + String(task.revision)
      + ':' + text(membership.id) + ':' + text(owner.id) + ':' + leadName
    const prior = state.v14Continuation?.summaries?.[summaryId]
    if (prior && !['delivery-failed', 'target-missing'].includes(prior.status)) return
    const maxAttempts = Math.max(1, Number(cfg.maxAttempts) || 2)
    if (Number(prior?.attempts ?? 0) >= maxAttempts) return
    if (prior?.status === 'delivery-failed'
      && Date.now() - Number(prior.updatedAt ?? 0) < Number(cfg.retryDelayMs)) return
    if (summaryInFlight.has(summaryId)) return summaryInFlight.get(summaryId)
    const run = (async () => {
    const queued = await control.mutateHot('v14/task-completion-queued', { taskId: taskId(task), summaryId, target: leadName }, agent, (latest) => {
      latest.v14Continuation ??= { summaries: {} }
      latest.v14Continuation.summaries ??= {}
      const current = latest.v14Continuation.summaries[summaryId]
      if (current && !['delivery-failed', 'target-missing'].includes(current.status)) return current
      const row = { taskId: taskId(task), revision: task.revision, target: leadName,
        targetId: lead?.id ? text(lead.id) : null, ownerId: text(owner.id), teamId: text(membership.id),
        status: lead?.id ? 'sending' : 'target-missing', attempts: Number(current?.attempts ?? 0) + (lead?.id ? 1 : 0),
        evidenceIds: task.evidenceIds ?? [], commitSha: task.commitSha ?? null,
        updatedAt: Date.now(), sendingDeadlineAt: Date.now() + Number(cfg.completionSendDeadlineMs) }
      latest.v14Continuation.summaries[summaryId] = row
      return row
    })
    if (queued.status === 'target-missing') return
    if (queued.status !== 'sending') return
    try {
      markBackgroundWake(control.rootId)
      const receipt = await teams.sendMessage(membership.root, {
        target: leadName, signal: cfg.signal ?? new AbortController().signal,
        content: [{ type: 'text', text: '[team task complete] ' + taskId(task)
          + ' owner=' + taskOwner(task) + ' evidence=' + (task.evidenceIds ?? []).join(',')
          + '\n[team completion id=' + summaryId + ']' }],
      })
      if (!receipt?.messageId || !['accepted', 'queued'].includes(receipt.status)) {
        throw new Error('Team mailbox returned no durable completion receipt')
      }
      await control.mutateHot('v14/task-completion-delivered', { summaryId, messageId: receipt.messageId }, agent, (latest) => {
        const row = latest.v14Continuation?.summaries?.[summaryId]
        if (!row || row.status !== 'sending') return row
        row.status = receipt.status === 'accepted' ? 'delivered' : 'mailbox-queued'
        row.messageId = String(receipt.messageId)
        row.updatedAt = Date.now()
        return row
      })
    } catch (error) {
      await control.mutateHot('v14/task-completion-failed', { summaryId }, agent, (latest) => {
        const row = latest.v14Continuation?.summaries?.[summaryId]
        if (!row || row.status !== 'sending') return row
        row.status = 'delivery-failed'
        row.error = String(error?.message ?? error)
        row.updatedAt = Date.now()
        return row
      })
      throw error
    }
    })().finally(() => summaryInFlight.delete(summaryId))
    summaryInFlight.set(summaryId, run)
    return run
  }
  const recoverSummaries = async (agent) => {
    if (disposed) return
    const teams = teamsOf(ctx)
    if (!teams) return
    const membership = teams.tryMembership(agent)
    if (!membership?.root) return
    const control = controlFor(membership.root)
    if (!control || providerBlocked(control)) return
    const summaryRows = Object.values(control.view({ history: false }).v14Continuation?.summaries ?? {})
    for (const row of summaryRows.filter((item) => item?.status === 'sending'
      && Number(item.sendingDeadlineAt ?? 0) > 0 && Number(item.sendingDeadlineAt) <= Date.now())) {
      await control.mutateHot('v14/task-completion-uncertain', { summaryId: row.summaryId ?? row.taskId }, agent, (latest) => {
        const current = Object.values(latest.v14Continuation?.summaries ?? {}).find((item) => item === row
          || (item.taskId === row.taskId && item.revision === row.revision && item.teamId === row.teamId))
        if (current?.status === 'sending') {
          current.status = 'uncertain'
          current.responsibility = current.target || 'lead'
          current.updatedAt = Date.now()
        }
        return current
      })
    }
    const pending = summaryRows
      .filter((row) => ['target-missing', 'delivery-failed'].includes(row?.status))
      .slice(0, Math.max(1, Number(cfg.maxPerScan) || 4))
    for (const row of pending) await reportCompletion(membership.root, row.taskId)
  }
  const settlePostExecute = async (operation, label) => {
    let timer
    try {
      await Promise.race([
        Promise.resolve().then(operation).catch((error) => {
          safeWarn(ctx, label + String(error?.message ?? error))
        }),
        new Promise((resolve) => {
          timer = setTimeout(resolve, 0)
          timer.unref?.()
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  const disposers = []
  disposers.push(ctx.on?.('tools/post-execute', async (exec, result, next) => {
    if (!disposed) armAgent(exec?.agent)
    const downstream = typeof next === 'function' ? await next() : { kind: 'accept' }
    if (!disposed && successfulTool(exec, result)) {
      const agent = exec?.agent
      await settlePostExecute(async () => {
        if (text(exec?.tool?.name ?? exec?.name) === 'team_task_update' && exec?.arguments?.action === 'complete') {
          await reportCompletion(agent, exec.arguments.task_id)
        }
        await schedule(agent)
      }, 'team-v14 post-execute: ')
    }
    return downstream
  }))
  disposers.push(ctx.on?.('agent/status', ({ agent, status }) => {
    if (disposed) return
    if (status === 'running' || status === 'provisioning') armAgent(agent)
    if (status === 'idle') void schedule(agent).then(() => recoverSummaries(agent))
      .catch((error) => safeWarn(ctx, 'team-v14 continuation: ' + String(error?.message ?? error)))
  }, { global: true }))
  const timer = Number(cfg.scanMs) > 0 ? setInterval(() => {
    if (disposed) return
    try {
      for (const agent of agentsOf(ctx)) {
        void schedule(agent).then(() => recoverSummaries(agent))
          .catch((error) => safeWarn(ctx, 'team-v14 continuation scan: ' + String(error?.message ?? error)))
      }
    } catch (error) {
      safeWarn(ctx, 'team-v14 continuation scan: ' + String(error?.message ?? error))
    }
  }, Number(cfg.scanMs)) : undefined
  timer?.unref?.()
  return () => {
    disposed = true
    if (timer) clearInterval(timer)
    for (const dispose of disposers) if (typeof dispose === 'function') dispose()
  }
}
