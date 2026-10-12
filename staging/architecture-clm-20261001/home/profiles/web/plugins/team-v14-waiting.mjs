/** Structured waiting tickets for v14 continuation gates. Pure state helpers only. */
import { randomUUID } from 'node:crypto'
import { taskDependencySatisfied } from './team-control-plane.mjs'

const text = (value) => String(value ?? '').trim()
const lower = (value) => text(value).toLowerCase()
const taskIdOf = (task) => text(task?.id ?? task?.taskId)
const tasksOf = (state) => Object.values(state?.boards ?? {}).flatMap((board) => Object.values(board?.tasks ?? {}))
const terminal = new Set(['completed', 'accepted', 'cancelled', 'deleted', 'expired'])
const activeMemberStates = new Set(['active', 'busy', 'executing', 'idle', 'running', 'thinking', 'working'])
const inactiveMemberStates = new Set(['failed', 'frozen', 'inactive', 'stopped', 'terminated'])
const MAX_TTL_MS = 24 * 60 * 60 * 1000

function responsibilityProjection(member, membersKnown) {
  if (member === undefined || member === null) {
    return membersKnown ? { responsibleStatus: 'missing', responsibleInactive: true } : {}
  }
  const status = lower(member.status ?? member.state)
  const inactive = member.frozen === true || inactiveMemberStates.has(status)
  return {
    ...(status.length > 0 ? { responsibleStatus: status } : {}),
    ...(inactive ? { responsibleInactive: true } : {}),
  }
}

// The public prompt contract uses short names such as room/provider; the
// canonical condition names below are the durable spelling.
const CONDITION_ALIASES = new Map([
  ['dependency', 'dependency'], ['depends-on', 'dependency'], ['task-dependency', 'dependency'],
  ['room', 'room-closed'], ['room-close', 'room-closed'], ['room-closed', 'room-closed'],
  ['lease', 'lease-released'], ['lease-release', 'lease-released'], ['lease-released', 'lease-released'],
  ['provider', 'provider-healthy'], ['provider-healthy', 'provider-healthy'], ['provider-recovered', 'provider-healthy'],
  ['owner', 'owner-unfrozen'], ['owner-unfrozen', 'owner-unfrozen'], ['unfrozen', 'owner-unfrozen'],
  ['approval', 'approval'], ['approval-granted', 'approval'],
  ['manual', 'manual'], ['manual-resolve', 'manual'],
  ['external', 'external'], ['external-resolve', 'external'],
  ['background', 'background'], ['background-resume', 'background'],
])

// These conditions have no trustworthy automatic predicate. They stay open
// until waiting_resolve records an explicit resolution.
const EXPLICIT_ONLY = new Set(['manual', 'external', 'background'])
const DEPENDENCY_OBJECT_FIELDS = ['on', 'object', 'objectId', 'object_id', 'reference', 'commit', 'note']

function dependencyObjectText(condition) {
  for (const field of DEPENDENCY_OBJECT_FIELDS) {
    const value = text(condition?.[field])
    if (value) return value
  }
  return ''
}

function closurePolicyFor(reason, condition) {
  const type = text(condition?.type) || CONDITION_ALIASES.get(lower(reason)) || lower(reason)
  if (EXPLICIT_ONLY.has(type)) return 'explicit'
  if (type === 'dependency' && (!Array.isArray(condition?.taskIds) || condition.taskIds.length === 0)) return 'explicit'
  if (['manual-pause', 'waiting-manual', 'waiting-external', 'waiting-background'].includes(lower(reason))) {
    return 'explicit'
  }
  return 'condition'
}

/** Validate and canonicalize one unblock condition. Throws on malformed input. */
export function normalizeWaitingCondition(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('waiting condition must be an object')
  const rawType = lower(value.type ?? value.condition ?? value.kind)
  const type = CONDITION_ALIASES.get(rawType)
  if (!type) throw new Error('unknown waiting condition type "' + rawType + '"')
  const condition = { ...value, type }
  if (type === 'dependency') {
    const source = Array.isArray(value.taskIds) ? value.taskIds : Array.isArray(value.task_ids) ? value.task_ids : []
    const taskIds = [...new Set(source.map(text).filter(Boolean))]
    if (taskIds.length === 0) {
      const objectText = dependencyObjectText(value)
      if (!objectText) throw new Error('dependency condition requires taskIds or a named object/note')
      condition.object = objectText
    } else {
      condition.taskIds = taskIds
    }
  }
  if (type === 'room-closed') {
    const roomId = text(value.roomId ?? value.room_id)
    if (roomId) condition.roomId = roomId
  }
  if (type === 'approval') {
    const requestId = text(value.requestId ?? value.request_id ?? value.objectId ?? value.object_id)
    if (requestId) condition.requestId = requestId
    const planId = text(value.planId ?? value.plan_id ?? value.targetPlanId ?? value.target_plan_id)
    if (planId) condition.planId = planId
  }
  return condition
}

/** Accept epoch milliseconds or an ISO-8601 string; reject other values. */
export function waitingTimeOf(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric
  const parsed = Date.parse(String(value))
  if (!Number.isFinite(parsed)) throw new Error('invalid waiting time "' + String(value) + '"')
  return parsed
}

/** Provider waits are real only when the provider is blocked by a recorded failure. */
export function providerWaitingActive(state) {
  const provider = state?.provider
  return lower(provider?.status) === 'blocked' && provider?.lastFailure !== null
    && provider?.lastFailure !== undefined
}

function taskStatus(task) {
  const status = lower(task?.status)
  if (status) return status === 'in_progress' ? 'running' : status
  return lower(task?.lifecycle ?? task?.phase)
}

function keyOf(taskId, owner) { return text(taskId) + ':' + text(owner) }

function sameExplicitCondition(left, right) {
  const a = waitingConditionOf(left)
  const b = waitingConditionOf(right)
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

function uniqueTicketId(state, taskId, owner, reason, condition, responsible) {
  const tickets = state?.v14Waiting?.tickets ?? {}
  for (const ticket of Object.values(tickets)) {
    if (lower(ticket?.status || 'open') !== 'open') continue
    if (text(ticket.taskId) !== text(taskId) || text(ticket.owner) !== text(owner)) continue
    if (text(ticket.reason) !== text(reason)) continue
    if (text(ticket.responsible ?? ticket.owner) !== text(responsible ?? owner)) continue
    if (sameExplicitCondition(ticket, { unblockCondition: condition })) return text(ticket.ticketId)
  }
  return 'wait:' + keyOf(taskId, owner) + ':' + randomUUID()
}

function roomOf(state, roomId) {
  const id = text(roomId)
  if (!id) return undefined
  return state?.rooms?.[id] ?? state?.v12RoomWake?.rooms?.[id]
}

function roundOf(state, room) {
  const roundId = room?.currentRoundId
  if (roundId == null) return undefined
  return state?.rounds?.[roundId] ?? state?.v12RoomWake?.rounds?.[roundId]
}

function taskOf(state, taskId) {
  return tasksOf(state).find((row) => taskIdOf(row) === text(taskId))
}

function boardIdOfTask(state, task) {
  const explicit = text(task?.board ?? task?.boardId)
  if (explicit && state?.boards?.[explicit]?.tasks?.[taskIdOf(task)] !== undefined) return explicit
  return Object.entries(state?.boards ?? {})
    .find(([, board]) => board?.tasks?.[taskIdOf(task)] === task)?.[0] ?? 'global'
}

function planStateOf(state, taskId) {
  const id = text(taskId)
  const plan = state?.plans?.[id] ?? state?.v12Plans?.[id]
  const task = taskOf(state, id)
  return lower(plan?.state ?? plan?.status ?? task?.planState ?? task?.approvalState)
}

function planApproved(state, taskId) {
  const planState = planStateOf(state, taskId)
  const task = taskOf(state, taskId)
  return planState === 'plan-approved' || lower(task?.phase) === 'plan-approved'
}

function approvalRequestId(ticket, condition) {
  return text(
    condition?.requestId
      ?? condition?.request_id
      ?? condition?.objectId
      ?? condition?.object_id
      ?? ticket?.requestId
      ?? ticket?.request_id,
  )
}

function approvalPlanId(ticket, condition) {
  return text(
    condition?.planId
      ?? condition?.plan_id
      ?? ticket?.planId
      ?? ticket?.plan_id,
  )
}

function approvalConditionSatisfied(state, ticket) {
  const condition = waitingConditionOf(ticket)
  const requestId = approvalRequestId(ticket, condition)
  if (requestId) {
    const request = state?.privilegeRequests?.[requestId]
    return request !== undefined && ['approved', 'active'].includes(lower(request.status))
  }
  const planId = approvalPlanId(ticket, condition)
  if (planId) return planApproved(state, planId)
  // Legacy approval tickets without any object binding retain plan semantics.
  // An approval that names a different object or outcome is opaque: it must be
  // resolved explicitly rather than being cleared by an unrelated plan event.
  const hasOpaqueBinding = [
    'object', 'objectId', 'object_id', 'reference', 'detail', 'note',
    'target', 'targetId', 'target_id',
  ].some((field) => text(condition?.[field]).length > 0)
  if (hasOpaqueBinding) return false
  return planApproved(state, ticket.taskId)
}

function waitingConditionOf(ticket) {
  try { return normalizeWaitingCondition(ticket?.unblockCondition) } catch { return null }
}

function waitingTypeOf(ticket) {
  const condition = waitingConditionOf(ticket)
  if (condition?.type) return condition.type
  const reason = lower(ticket?.reason)
  return CONDITION_ALIASES.get(reason) ?? reason
}

function waitingDedupeKey(ticket) {
  return [
    text(ticket?.taskId),
    text(ticket?.owner),
    waitingTypeOf(ticket) || 'waiting',
    text(ticket?.responsible ?? ticket?.owner),
  ].join('\u0000')
}

function conditionOpen(ticket, state, now) {
  const task = taskOf(state, ticket.taskId)
  if (!task) return false
  const reason = lower(ticket.reason)
  const type = waitingTypeOf(ticket)
  const condition = waitingConditionOf(ticket)
  // Plan approval is a durable state transition, not a human-only condition.
  // Check it before revision invalidation because approval itself advances the
  // task revision.
  if (type === 'approval' || reason === 'waiting-approval') return !approvalConditionSatisfied(state, ticket)
  // Human, external and background pauses require an explicit resolve. Expiry
  // only marks the responsibility stale; it never authorizes an automatic wake.
  if (EXPLICIT_ONLY.has(reason)
    || ['manual-pause', 'waiting-manual', 'waiting-external', 'waiting-background'].includes(reason)) return true
  if (Number(ticket.expiresAt ?? 0) > 0 && Number(ticket.expiresAt) <= now) return false
  // A structured condition is authoritative even after the task reaches a
  // terminal status. Post-completion gates must survive until their own
  // condition is satisfied or an actor resolves them explicitly.
  if (condition === null && terminal.has(taskStatus(task))) return false
  // Legacy reason-only tickets use revision as a weak invalidation signal.
  // Structured conditions are authoritative and survive unrelated task edits
  // such as phase advancement.
  if (condition === null
    && ticket.taskRevision !== undefined
    && Number(ticket.taskRevision) !== Number(task.revision ?? 0)) return false
  if (!condition) return true
  if (EXPLICIT_ONLY.has(condition.type)) return true
  if (condition.type === 'dependency') {
    const deps = Array.isArray(condition.taskIds) ? condition.taskIds.map(String) : []
    if (deps.length > 0 && deps.every((id) =>
      taskDependencySatisfied(state?.boards ?? {}, boardIdOfTask(state, task), id))) return false
    return true
  }
  if (condition.type === 'room-closed') {
    const roomId = text(condition.roomId) || 'task:' + text(ticket.taskId)
    const room = roomOf(state, roomId)
    if (!room) return true
    const round = roundOf(state, room)
    if (room.status !== 'closed' || (round && round.status === 'open')) return true
    return false
  }
  if (condition.type === 'lease-released') {
    const held = Object.values(state?.leases ?? {}).some((lease) => lower(lease?.status) === 'active'
      && (text(lease.member) === text(ticket.owner) || text(lease.taskId) === text(ticket.taskId)))
    if (!held) return false
  }
  if (condition.type === 'provider-healthy' && !providerWaitingActive(state)) return false
  if (condition.type === 'owner-unfrozen' && state?.frozenMembers?.[text(ticket.owner)]?.frozen !== true) return false
  return true
}

function closureReasonFor(ticket, state, now) {
  const task = taskOf(state, ticket.taskId)
  if (!task) return 'task-missing'
  const reason = lower(ticket.reason)
  const type = waitingTypeOf(ticket)
  if ((type === 'approval' || reason === 'waiting-approval') && approvalConditionSatisfied(state, ticket)) {
    const requestId = approvalRequestId(ticket, waitingConditionOf(ticket))
    return requestId ? 'privilege-approved:' + requestId : 'plan-approved'
  }
  if (waitingConditionOf(ticket) === null && terminal.has(taskStatus(task))) return 'task-terminal'
  if (Number(ticket.expiresAt ?? 0) > 0 && Number(ticket.expiresAt) <= now) return 'expired'
  return 'condition-cleared'
}

/** Upsert one bounded waiting ticket. Runtime callers must enforce actor scope. */
export function recordWaiting(state, input = {}, actor, options = {}) {
  if (!state || typeof state !== 'object') throw new Error('waiting state is required')
  const taskId = text(input.taskId)
  const owner = text(input.owner)
  if (!taskId || !owner) throw new Error('waiting ticket requires taskId and owner')
  const reason = text(input.reason) || 'waiting'
  const now = Number(options.now ?? Date.now())
  const ttlMs = Math.min(MAX_TTL_MS, Math.max(1, Number(input.ttlMs ?? options.ttlMs ?? MAX_TTL_MS)))
  const tickets = state.v14Waiting?.tickets && typeof state.v14Waiting.tickets === 'object'
    ? state.v14Waiting.tickets : {}
  state.v14Waiting = { ...(state.v14Waiting ?? {}), tickets }
  const requestedCondition = normalizeWaitingCondition(input.unblockCondition ?? null)
  const responsible = text(input.responsible) || owner
  const waiter = text(input.waiter) || text(actor) || owner
  const ticketId = text(input.ticketId) || uniqueTicketId(state, taskId, owner, reason, requestedCondition, responsible)
  const prior = tickets[ticketId]
  const condition = requestedCondition ?? normalizeWaitingCondition(prior?.unblockCondition ?? null)
  const closurePolicy = closurePolicyFor(reason, condition)
  const nextCheckAt = waitingTimeOf(input.nextCheckAt, Number(prior?.nextCheckAt ?? now))
  const requestedExpiry = waitingTimeOf(input.expiresAt, undefined)
  const createdAt = Number(prior?.createdAt ?? now)
  const ticket = {
    ...(prior ?? {}),
    ticketId, taskId, owner, waiter, reason,
    unblockCondition: condition,
    closurePolicy,
    responsible: responsible || prior?.responsible || owner,
    nextCheckAt,
    taskRevision: Number(input.taskRevision ?? prior?.taskRevision ?? tasksOf(state).find((row) => taskIdOf(row) === taskId)?.revision ?? 0),
    status: text(input.status) || (prior?.status === 'resolved' ? 'open' : prior?.status) || 'open',
    createdAt, updatedAt: now,
    expiresAt: requestedExpiry ?? Math.min(now + ttlMs, createdAt + MAX_TTL_MS),
    actor: text(actor) || prior?.actor || null,
  }
  if (ticket.status === 'open') {
    delete ticket.resolution
    delete ticket.resolvedBy
    delete ticket.resolvedAt
    delete ticket.supersededBy
    delete ticket.closedReason
    delete ticket.closedAt
    delete ticket.closedBy
  }
  if (ticket.expiresAt > now + MAX_TTL_MS) ticket.expiresAt = now + MAX_TTL_MS
  tickets[ticketId] = ticket
  return ticket
}

export function resolveWaiting(state, input = {}, actor, options = {}) {
  const tickets = state?.v14Waiting?.tickets ?? {}
  const requestedTicketId = text(input.ticketId)
  let ticketId = requestedTicketId
  if (!ticketId) {
    const matching = Object.values(tickets).filter((row) => {
      if (text(row.taskId) !== text(input.taskId)) return false
      return [input.owner, input.waiter, input.responsible]
        .map(text)
        .filter(Boolean)
        .some((candidate) => [row.owner, row.waiter, row.responsible].map(text).includes(candidate))
    })
    const candidates = matching.filter((row) => lower(row?.status || 'open') === 'open')
    if (candidates.length === 0 && matching.length === 1) {
      return { ...matching[0], alreadyResolved: lower(matching[0].status) !== 'open' }
    }
    if (candidates.length !== 1) return undefined
    ticketId = text(candidates[0].ticketId)
  }
  const ticket = tickets[ticketId]
  if (!ticket) return undefined
  const resolvedAt = Number(options.now ?? Date.now())
  const resolutionKind = lower(input.resolutionKind ?? input.resolution_kind)
  const supersededBy = text(input.supersededBy ?? input.superseded_by)
  if (resolutionKind === 'superseded' && supersededBy.length === 0) {
    throw new Error('superseded waiting resolution requires supersededBy')
  }
  if (lower(ticket.status) !== 'open') {
    const explicitResolution = text(input.resolution)
    const autoReason = lower(ticket.closedReason)
    const canAnnotate = explicitResolution.length > 0
      && autoReason !== 'explicit-resolve'
      && autoReason !== 'deduplicated'
    if (!canAnnotate) return { ...ticket, alreadyResolved: true }
    ticket.autoResolution = text(ticket.autoResolution) || text(ticket.resolution) || null
    ticket.resolution = explicitResolution
    ticket.resolutionNote = 'explicit resolution appended after automatic closure'
    ticket.resolvedBy = text(actor) || null
    ticket.resolvedAt = resolvedAt
    ticket.updatedAt = resolvedAt
    return { ...ticket, alreadyResolved: true, resolutionUpdated: true }
  }
  ticket.status = 'resolved'
  ticket.closurePolicy = text(ticket.closurePolicy) || closurePolicyFor(ticket.reason, waitingConditionOf(ticket))
  ticket.resolution = resolutionKind === 'superseded'
    ? (text(input.resolution) || 'SUPERSEDED by ' + supersededBy + '; condition NOT met')
    : (text(input.resolution) || 'resolved')
  ticket.closedReason = resolutionKind === 'superseded' ? 'superseded' : 'explicit-resolve'
  if (resolutionKind === 'superseded') {
    ticket.resolutionKind = 'superseded'
    ticket.supersededBy = supersededBy
  }
  ticket.closedAt = resolvedAt
  ticket.closedBy = text(actor) || null
  ticket.resolvedBy = text(actor) || null
  ticket.resolvedAt = resolvedAt
  ticket.updatedAt = resolvedAt
  return { ...ticket, alreadyResolved: false }
}

export function waitingTicketActive(ticket, state, now = Date.now()) {
  return !!ticket && lower(ticket.status || 'open') === 'open' && conditionOpen(ticket, state, Number(now))
}

/** Read-only current waiting health, including stale and duplicate open rows. */
export function waitingHealth(state, now = Date.now()) {
  const tickets = Object.values(state?.v14Waiting?.tickets ?? {})
    .filter((ticket) => lower(ticket?.status || 'open') === 'open')
  const groups = new Map()
  const staleByOwner = {}
  const staleByResponsible = {}
  let active = 0
  let stale = 0
  let duplicate = 0
  let oldestOpenAgeMs = 0
  let oldestStaleAgeMs = 0
  for (const ticket of tickets) {
    const ageMs = Math.max(0, Number(now) - Number(ticket.createdAt ?? now))
    oldestOpenAgeMs = Math.max(oldestOpenAgeMs, ageMs)
    const key = waitingDedupeKey(ticket)
    groups.set(key, Number(groups.get(key) ?? 0) + 1)
    if (waitingTicketActive(ticket, state, now)) {
      active += 1
      continue
    }
    stale += 1
    oldestStaleAgeMs = Math.max(oldestStaleAgeMs, ageMs)
    const owner = text(ticket.owner) || 'unowned'
    const responsible = text(ticket.responsible) || owner
    staleByOwner[owner] = Number(staleByOwner[owner] ?? 0) + 1
    staleByResponsible[responsible] = Number(staleByResponsible[responsible] ?? 0) + 1
  }
  for (const count of groups.values()) duplicate += Math.max(0, count - 1)
  return {
    total: Object.keys(state?.v14Waiting?.tickets ?? {}).length,
    open: tickets.length,
    active,
    stale,
    duplicate,
    oldestOpenAgeMs,
    oldestStaleAgeMs,
    staleByOwner,
    staleByResponsible,
  }
}

/**
 * Close terminal/expired/revision-stale waits and collapse duplicate active
 * responsibilities. `apply:false` is a read-only reconciliation preview.
 */
export function reconcileWaitingTickets(state, options = {}) {
  if (!state || typeof state !== 'object') throw new Error('waiting state is required')
  const now = Number(options.now ?? Date.now())
  const apply = options.apply !== false
  const tickets = state.v14Waiting?.tickets ?? {}
  const stale = []
  const groups = new Map()
  for (const ticket of Object.values(tickets)) {
    if (lower(ticket?.status || 'open') !== 'open') continue
    if (!waitingTicketActive(ticket, state, now)) {
      stale.push(ticket)
      continue
    }
    const key = waitingDedupeKey(ticket)
    const group = groups.get(key) ?? []
    group.push(ticket)
    groups.set(key, group)
  }
  const duplicates = []
  for (const group of groups.values()) {
    if (group.length < 2) continue
    group.sort((left, right) => Number(right.updatedAt ?? right.createdAt ?? 0)
      - Number(left.updatedAt ?? left.createdAt ?? 0))
    const keeper = group[0]
    for (const ticket of group.slice(1)) duplicates.push({ ticket, keeper })
  }
  let resolved = 0
  let deduped = 0
  if (apply) {
    for (const ticket of stale) {
      const type = waitingTypeOf(ticket)
      const closedReason = closureReasonFor(ticket, state, now)
      ticket.status = 'resolved'
      ticket.resolution = closedReason === 'task-terminal'
        ? 'auto:task-terminal'
        : type === 'approval' && approvalConditionSatisfied(state, ticket)
          ? (approvalRequestId(ticket, waitingConditionOf(ticket))
              ? 'auto:privilege-approved'
              : 'auto:plan-approved')
          : 'auto:condition-cleared'
      ticket.closurePolicy = text(ticket.closurePolicy)
        || closurePolicyFor(ticket.reason, waitingConditionOf(ticket))
      ticket.closedReason = closedReason
      ticket.closedAt = now
      ticket.closedBy = 'team-v14-waiting'
      ticket.resolvedBy = 'team-v14-waiting'
      ticket.resolvedAt = now
      ticket.updatedAt = now
      resolved += 1
    }
    for (const { ticket, keeper } of duplicates) {
      ticket.status = 'resolved'
      ticket.resolution = 'auto:deduplicated'
      ticket.supersededBy = text(keeper.ticketId)
      ticket.closedReason = 'deduplicated'
      ticket.closedAt = now
      ticket.closedBy = 'team-v14-waiting'
      ticket.resolvedBy = 'team-v14-waiting'
      ticket.resolvedAt = now
      ticket.updatedAt = now
      deduped += 1
    }
  }
  const health = waitingHealth(state, now)
  if (apply) {
    state.v14Waiting = {
      ...(state.v14Waiting ?? {}),
      tickets,
      health: {
        ...health,
        lastReconcile: {
          at: now,
          stale: stale.length,
          resolved,
          duplicates: duplicates.length,
          deduped,
        },
      },
    }
  }
  return {
    changed: stale.length + duplicates.length,
    stale: stale.length,
    resolved,
    duplicates: duplicates.length,
    deduped,
    health,
  }
}

/** Derive read-only responsibility rows; callers may persist explicit tickets separately. */
export function deriveWaitingTickets(state, members = [], now = Date.now()) {
  const memberMap = new Map((Array.isArray(members) ? members : []).map((row) => [text(row.name ?? row.id), row]))
  const membersKnown = memberMap.size > 0
  const rows = []
  for (const task of tasksOf(state)) {
    const id = taskIdOf(task)
    const owner = task.ownerName !== undefined && task.ownerName !== null
      ? text(task.ownerName)
      : task.ownerName === null
        ? ''
        : task.owner !== undefined && task.owner !== null
          ? text(task.owner)
          : task.owner === null
            ? ''
            : text(task.contract?.owner)
    if (!id || !owner || terminal.has(taskStatus(task))) continue
    const member = memberMap.get(owner)
    const base = {
      taskId: id,
      owner,
      taskRevision: Number(task.revision ?? 0),
      responsible: owner,
      nextCheckAt: Number(now),
      status: 'derived',
      ...responsibilityProjection(member, membersKnown),
    }
    const deps = Array.isArray(task.blockedBy ?? task.contract?.dependencies) ? (task.blockedBy ?? task.contract.dependencies).map(String) : []
    const unmet = deps.filter((dep) =>
      !taskDependencySatisfied(state?.boards ?? {}, boardIdOfTask(state, task), dep))
    if (unmet.length > 0) rows.push({ ...base, reason: 'waiting-dependency', unblockCondition: { type: 'dependency', taskIds: unmet } })
    const lease = Object.values(state?.leases ?? {}).find((row) => lower(row?.status) === 'active' && (text(row.member) === owner || text(row.taskId) === id))
    if (lease) {
      const responsible = text(lease.member) || owner
      rows.push({
        ...base,
        ...responsibilityProjection(memberMap.get(responsible), membersKnown),
        reason: 'waiting-lease',
        unblockCondition: { type: 'lease-released' },
        responsible,
      })
    }
    if (member?.frozen === true || state?.frozenMembers?.[owner]?.frozen === true) rows.push({ ...base, reason: 'waiting-frozen', unblockCondition: { type: 'owner-unfrozen' } })
    if (task.manualPause === true || task.paused === true || lower(task.status) === 'paused') rows.push({ ...base, reason: 'waiting-manual', unblockCondition: { type: 'manual' } })
    if (task.waitingApproval === true || lower(task.status) === 'waiting-approval') rows.push({ ...base, reason: 'waiting-approval', unblockCondition: { type: 'approval' }, responsible: 'lead' })
    if (task.externalWait === true || task.waitingExternal === true) rows.push({ ...base, reason: 'waiting-external', unblockCondition: { type: 'external' } })
    if (task.background === true) rows.push({ ...base, reason: 'waiting-background', unblockCondition: { type: 'background' } })
    const roomId = text(task.roomId ?? task.contract?.roomId) || 'task:' + id
    const room = roomOf(state, roomId)
    const round = roundOf(state, room)
    if (round?.status === 'open') rows.push({ ...base, reason: 'waiting-room', unblockCondition: { type: 'room-closed', roomId } })
    if (providerWaitingActive(state)) rows.push({
      ...base,
      reason: 'waiting-provider',
      unblockCondition: { type: 'provider-healthy' },
      responsible: 'lead',
      derivedFrom: 'provider',
      providerStatus: lower(state?.provider?.status),
      providerLastFailure: state?.provider?.lastFailure === null || state?.provider?.lastFailure === undefined
        ? null
        : {
            category: text(state.provider.lastFailure.category),
            summary: text(state.provider.lastFailure.summary).slice(0, 500),
            createdAt: Number(state.provider.lastFailure.createdAt ?? 0),
          },
      healthStatus: lower(state?.health?.status),
    })
  }
  return rows
}

/**
 * Build an explicit, complete projection over persisted waiting tickets.
 * Open tickets whose condition is no longer active are reported as stale
 * instead of disappearing from both the active and closed sets.
 */
export function projectWaitingTickets(state, options = {}) {
  const stored = Array.isArray(options.stored)
    ? options.stored
    : Object.values(state?.v14Waiting?.tickets ?? {})
  const derived = Array.isArray(options.derived) ? options.derived : []
  const ticketId = text(options.ticketId ?? options.ticket_id)
  const taskId = text(options.taskId ?? options.task_id)
  const includeClosed = options.includeClosed === true
  const now = Number(options.now ?? Date.now())
  const members = Array.isArray(options.members) ? options.members : []
  const memberMap = new Map(members.map((row) => [text(row.name ?? row.id), row]))
  const membersKnown = memberMap.size > 0
  const withResponsibility = (row) => {
    const responsible = text(row?.responsible ?? row?.owner)
    return {
      ...row,
      ...responsibilityProjection(memberMap.get(responsible), membersKnown),
    }
  }

  const classified = stored.map((ticket) => {
    const status = lower(ticket?.status || 'open')
    const active = status === 'open' && waitingTicketActive(ticket, state, now)
    return {
      ticket,
      active,
      closed: status !== 'open',
      stale: status === 'open' && !active,
    }
  })
  const active = classified.filter((row) => row.active).length
  const closed = classified.filter((row) => row.closed).length
  const stale = classified.filter((row) => row.stale).length

  let selected = classified
  if (ticketId) selected = selected.filter((row) => text(row.ticket.ticketId) === ticketId)
  if (taskId) selected = selected.filter((row) => text(row.ticket.taskId) === taskId)
  if (!includeClosed && !ticketId && !taskId) selected = selected.filter((row) => row.active)

  const selectedDerived = ticketId
    ? []
    : derived.filter((row) => !taskId || text(row?.taskId) === taskId)
  const allRows = [
    ...selected.map((row) => withResponsibility(row.ticket)),
    ...selectedDerived.map((row) => withResponsibility(row)),
  ]

  const rawOffset = Number(options.offset ?? 0)
  const rawLimit = Number(options.limit ?? 100)
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0
  const limit = Number.isFinite(rawLimit) ? Math.min(500, Math.max(1, Math.floor(rawLimit))) : 100
  const rows = allRows.slice(offset, offset + limit)
  const nextOffset = offset + rows.length < allRows.length ? offset + rows.length : null

  return {
    tickets: rows,
    total: allRows.length,
    returned: rows.length,
    offset,
    limit,
    truncated: nextOffset !== null,
    nextOffset,
    includeClosed,
    active,
    closed,
    stale,
    storedTotal: stored.length,
    derivedTotal: selectedDerived.length,
    responsibleInactive: allRows.filter((row) => row.responsibleInactive === true).length,
    projectionComplete: active + closed + stale === stored.length,
    query: {
      ticketId: ticketId || null,
      taskId: taskId || null,
    },
  }
}
