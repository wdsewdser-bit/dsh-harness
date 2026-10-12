/**
 * team-activity-digest — periodic root-level visibility for active Teams.
 *
 * The root is a scheduler and deliberately stops after dispatching.  This plugin
 * watches the live roster and control plane on a fixed cadence, and only when a
 * Team actually has work in flight does it wake the root with a compact digest
 * generated from the same roster/board/lease state that list_agents and
 * team_control_status expose.  A completely idle Team produces no reminder.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { controlPlaneFor, hashControlValue, teamRootIdCandidates } from './team-control-plane.mjs'
import {
  armedRoots,
  consumeBackgroundWake,
  focusBootstrapRoot,
  focusRoot,
  isArmed,
  markBackgroundWake,
} from './team-armed-roots.mjs'

console.log('[team-activity-digest] HMR perf42-ten-minute-digest+runtime-reload loaded 2026-09-27')

export const name = 'team-activity-digest'

export const DEFAULTS = {
  /** Two minutes in tests, ten minutes in the live profiles. */
  intervalMs: 10 * 60 * 1000,
  controlDir: undefined,
}

const TERMINAL_TASK_STATES = new Set(['completed', 'deleted'])
const ACTIVE_MEMBER_STATES = new Set(['running', 'provisioning'])

function list(value) {
  return Array.isArray(value) ? value.filter((row) => row !== null && typeof row === 'object') : []
}

function memberStatus(row) {
  return String(row?.status ?? 'inactive')
}

function memberGroup(row) {
  return String(row?.groupId ?? row?.group ?? row?.groupName ?? 'ungrouped')
}

function memberName(row) {
  return String(row?.name ?? row?.member ?? row?.id ?? '')
}

function shortNames(names, limit = 8) {
  const values = [...new Set(names.filter((name) => name.length > 0))]
  if (values.length <= limit) return values.join(', ')
  return values.slice(0, limit).join(', ') + ' +' + String(values.length - limit)
}

function ownerRows(rows) {
  return new Map(rows.map((row) => [memberName(row), row]))
}

function groupRows(rows) {
  const groups = new Map()
  for (const row of rows) {
    const group = memberGroup(row)
    if (group === 'ungrouped') continue
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(row)
  }
  return groups
}

/**
 * Build the compact facts the root needs without writing anything.
 * Exported for focused tests and for reuse by any future status tool.
 */
export function buildActivitySnapshot(rows, state) {
  const members = list(rows).filter((row) => memberName(row).length > 0)
  const owners = ownerRows(members)
  const groups = groupRows(members)
  const openTasks = Object.values(state?.boards ?? {})
    .flatMap((board) => Object.values(board?.tasks ?? {}))
    .filter((task) => task !== null && typeof task === 'object' && !TERMINAL_TASK_STATES.has(String(task.status ?? '')))
  const leases = Object.values(state?.leases ?? {}).filter((lease) => lease?.status === 'active')
  const activeOwners = new Set(leases.map((lease) => String(lease.member ?? '')).filter(Boolean))
  const activeMemberNames = members
    .filter((row) => ACTIVE_MEMBER_STATES.has(memberStatus(row)))
    .map(memberName)
  const openByOwner = new Map()
  for (const task of openTasks) {
    const owner = String(task.ownerName ?? '')
    if (owner.length === 0) continue
    if (!openByOwner.has(owner)) openByOwner.set(owner, [])
    openByOwner.get(owner).push(task)
  }

  const groupViews = [...groups.entries()].map(([group, groupMembers]) => {
    const groupMemberNames = groupMembers.map(memberName)
    const running = groupMembers.filter((row) => ACTIVE_MEMBER_STATES.has(memberStatus(row)))
    const activeLeaseMembers = groupMemberNames.filter((name) => activeOwners.has(name))
    const groupOpen = groupMemberNames.flatMap((name) => openByOwner.get(name) ?? [])
    const idleWithOpen = groupMemberNames
      .filter((name) => !ACTIVE_MEMBER_STATES.has(memberStatus(owners.get(name))))
      .filter((name) => (openByOwner.get(name) ?? []).length > 0 && !activeOwners.has(name))
    const lead = groupMembers.find((row) => Number(row.level ?? row.tier) === 1)
    return {
      group,
      lead: lead === undefined ? undefined : memberName(lead),
      memberCount: groupMembers.length,
      running: running.length,
      runningNames: running.map(memberName),
      idleWithOpen,
      openTasks: groupOpen.length,
      activeLeases: activeLeaseMembers.length,
      active: running.length > 0 || activeLeaseMembers.length > 0
        || groupOpen.some((task) => ACTIVE_MEMBER_STATES.has(memberStatus(owners.get(String(task.ownerName ?? ''))))),
    }
  })

  const activeGroups = groupViews.filter((view) => view.active)
  const running = members.filter((row) => ACTIVE_MEMBER_STATES.has(memberStatus(row)))
  const idle = members.filter((row) => memberStatus(row) === 'idle')
  const inactive = members.filter((row) => !ACTIVE_MEMBER_STATES.has(memberStatus(row)) && memberStatus(row) !== 'idle')
  const idleWithOpen = groupViews.flatMap((view) => view.idleWithOpen.map((name) => ({ group: view.group, name })))

  return {
    active: activeGroups.length > 0,
    memberCount: members.length,
    runningCount: running.length,
    idleCount: idle.length,
    inactiveCount: inactive.length,
    activeLeaseCount: leases.length,
    openTaskCount: openTasks.length,
    activeGroupCount: activeGroups.length,
    groupCount: groupViews.length,
    activeGroups,
    groups: groupViews,
    idleWithOpen,
  }
}

/** Fingerprint facts, not timestamps or the digest's own root wake/status. */
export function activityFactSignature(rows, state, at = Date.now()) {
  const sort = (values) => values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const tasks = Object.entries(state?.boards ?? {}).flatMap(([board, value]) => Object.values(value?.tasks ?? {}).map((task) => ({
    board, id: task.id, subject: task.subject, description: task.description, status: task.status, phase: task.phase, owner: task.ownerName,
    blockedBy: task.blockedBy, evidenceIds: task.evidenceIds, commitSha: task.commitSha, contractDigest: task.contractDigest,
    writeScopes: task.writeScopes, workKind: task.workKind, dependencyPhase: task.dependencyPhase,
  })))
  const members = list(rows).filter((row) => row.role !== 'lead' && Number(row.tier ?? row.level) !== 0)
    .map((row) => ({ name: memberName(row), group: memberGroup(row), status: memberStatus(row) }))
  const deadlines = []
  const visit = (value, path, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 7) return
    if (['completed', 'resolved', 'closed', 'cancelled', 'expired', 'accepted', 'handled'].includes(String(value.status ?? ''))) return
    for (const field of ['dueAt', 'deadlineAt', 'deadline', 'expiresAt', 'timeoutAt', 'responsibilityDueAt']) {
      const raw = value[field]
      const due = typeof raw === 'string' ? Date.parse(raw) : Number(raw)
      if (raw !== undefined && Number.isFinite(due) && due > 0 && due <= at) deadlines.push({ path, field, due, responsible: value.responsible ?? value.ownerName ?? value.member })
    }
    for (const [key, child] of Object.entries(value)) if (child && typeof child === 'object') visit(child, path + '/' + key, depth + 1)
  }
  for (const field of ['boards', 'leases', 'rooms', 'rounds', 'v14Waiting', 'v12Waiting', 'waiting']) visit(state?.[field], field)
  const facts = { tasks: sort(tasks), members: sort(members),
    leases: sort(Object.values(state?.leases ?? {}).map((row) => ({ id: row.runId, taskId: row.taskId, member: row.member, status: row.status }))),
    requirements: state?.v12Requirements?.revision ?? 0, deadlines: sort(deadlines) }
  return { factsHash: hashControlValue(facts), dueResponsibilities: deadlines.length, deadlines: facts.deadlines }
}

/** Render one compact digest, bounded so a large Team does not flood root context. */
export function activityDigestText(snapshot, rootName, teamKey) {
  const groupLines = snapshot.groups.map((group) => {
    const lead = group.lead === undefined ? '-' : group.lead
    const running = shortNames(group.runningNames)
    const stalled = group.idleWithOpen.length === 0 ? '-' : shortNames(group.idleWithOpen)
    return '- ' + group.group + ': lead=' + lead
      + ' members=' + String(group.memberCount)
      + ' running=' + String(group.running) + (running.length === 0 ? '' : ' [' + running + ']')
      + ' openTasks=' + String(group.openTasks)
      + ' leases=' + String(group.activeLeases)
      + ' idleWithOpen=' + stalled
  })
  return [
    '[team activity] root=' + rootName + ' team=' + teamKey,
    'summary: groups=' + String(snapshot.activeGroupCount) + '/' + String(snapshot.groupCount)
      + ' active; members=' + String(snapshot.memberCount)
      + ' (running=' + String(snapshot.runningCount)
      + ' idle=' + String(snapshot.idleCount)
      + ' inactive=' + String(snapshot.inactiveCount) + ')'
      + '; activeLeases=' + String(snapshot.activeLeaseCount)
      + '; openTasks=' + String(snapshot.openTaskCount),
    ...groupLines,
    snapshot.idleWithOpen.length === 0
      ? 'idle-with-open: none'
      : 'idle-with-open: ' + snapshot.idleWithOpen.map((row) => row.group + '/' + row.name).join(', '),
    'This digest is the roster and status check. Do not re-list only to repeat it; act only on a real blocker or stall.',
  ].join('\n')
}

export function suppressForControlPlane(control) {
  if (control === undefined || control === null) return false
  try {
    if (control.providerState?.().status === 'blocked') return true
    const health = typeof control.healthStatus === 'function' ? control.healthStatus() : control.health?.()
    return health?.status === 'disabled'
      && Array.isArray(health.reasons)
      && health.reasons.some((reason) => String(reason).startsWith('provider failure'))
  } catch {
    return false
  }
}

export function apply(ctx, config = {}) {
  console.log('[team-activity-digest] startup-arming active')
  const cfg = Object.assign({}, DEFAULTS, config)
  const intervalMs = Number.isFinite(cfg.intervalMs) && cfg.intervalMs > 0 ? cfg.intervalMs : DEFAULTS.intervalMs
  console.log('[team-activity-digest] intervalMs=' + String(intervalMs))
  const armed = armedRoots()
  let disposed = false
  const stops = []
  const pending = new Set()
  let disposePromise
  const dispose = () => {
    if (disposePromise) return disposePromise
    disposed = true
    for (const stop of stops.splice(0)) stop()
    // Timer removal prevents new work; existing claims and delivery records
    // must settle before the caller releases the control-plane lifecycle.
    disposePromise = Promise.all([...pending]).then(() => undefined)
    return disposePromise
  }
  const keyForRoot = (teams, root) => teamRootIdCandidates({ agentTeams: teams }, root)[0]
    ?? String(teams.tryMembership(root)?.id ?? '')
  const hasRestorableControlState = (cp) => {
    if (cp === undefined) return false
    try {
      const state = cp.view({ history: false })
      if (Object.values(state?.wakeEpisodes ?? {}).length > 0) return true
      if (Object.values(state?.leases ?? {}).some((row) => row?.status === 'active')) return true
      if (Object.values(state?.privilegeRequests ?? {}).some((row) => row?.status === 'active')) return true
      if (Object.values(state?.dispatches ?? {}).some((row) =>
        row && !['completed', 'delivery-failed', 'run-failed', 'timed-out', 'cancelled', 'expired'].includes(String(row.status)))) return true
      if (Object.values(state?.rooms ?? {}).some((row) => row?.status === 'open')) return true
      return Object.values(state?.boards ?? {}).some((board) =>
        Object.values(board?.tasks ?? {}).some((task) => !['completed', 'deleted'].includes(String(task?.status ?? ''))))
    } catch {
      return true
    }
  }
  const armAgent = (teams, agent) => {
    try {
      const membership = teams.tryMembership(agent)
      if (!membership?.root) return
      const key = keyForRoot(teams, membership.root)
      const agentIsRoot = agent === membership.root
        || String(agent?.id ?? '') === String(membership.root?.id ?? '')
      if (key.length > 0 && agentIsRoot && !consumeBackgroundWake(key)) focusRoot(armed, key)
    } catch { /* a stale or inactive context must not break event handling */ }
  }

  const checkRoot = (scoped, teams, root) => {
    try {
      if (disposed || root === undefined || root === null || root.status === 'running') return
      const membership = teams.tryMembership(root)
      if (membership === undefined || membership.role !== 'lead') return
      const rootName = String(membership.name ?? 'lead')
      const key = keyForRoot(teams, root)
      if (key.length === 0) return
      const controlConfig = cfg.controlDir === undefined ? {} : { directory: cfg.controlDir }
      const cp = controlPlaneFor(key, controlConfig)
      if (!isArmed(armed, key)) return
      if (suppressForControlPlane(cp)) return
      const rows = teams.listMembers(root)
      const state = cp.snapshot({ history: false })
      const snapshot = buildActivitySnapshot(rows, state)
      const signature = activityFactSignature(rows, state)
      if (snapshot.active !== true && signature.dueResponsibilities === 0) return
      if (state.activityDigest?.factsHash === signature.factsHash) return
      const text = activityDigestText(snapshot, rootName, key)
        + (signature.deadlines.length === 0 ? '' : '\nResponsibilities due: ' + signature.deadlines.slice(0, 8).map((row) => row.path + '/' + row.field + '=' + row.due + ' responsible=' + String(row.responsible ?? 'unassigned')).join('; '))
      const claim = cp.wakeClaim({
        episodeId: 'activity:' + key + ':' + String(Number(state.activityDigest?.sequence ?? 0) + 1) + ':' + signature.factsHash,
        sender: 'team-activity-digest',
        target: rootName,
        messageHash: hashControlValue(text),
      })
      const operation = Promise.resolve(claim).then(async (result) => {
        if (disposed || result?.claimed === false) return
        const message = createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'team-message', plugin: name, form: 'notice', summary: 'team activity digest' },
        })
        markBackgroundWake(key)
        if (typeof root.followup === 'function') root.followup(message)
        else if (typeof root.inject === 'function') root.inject(message)
        else return
        await cp.activityDigestRecord(signature)
      }).catch(() => {})
      pending.add(operation)
      operation.then(() => pending.delete(operation))
    } catch (error) {
      if (ctx.logger !== undefined) ctx.logger.warn?.('team-activity-digest: ' + String(error?.message ?? error))
    }
  }

  const focusCurrentRoot = (scoped, teams) => {
    const roots = []
    try {
      for (const root of scoped.agents.list()) {
        const membership = teams.tryMembership(root)
        const teamRoot = membership?.root ?? (membership?.role === 'lead' ? root : undefined)
        if (!teamRoot) continue
        const agentIsRoot = root === teamRoot
          || String(root?.id ?? '') === String(teamRoot?.id ?? '')
        if (!agentIsRoot) continue
        const key = keyForRoot(teams, teamRoot)
        if (key.length === 0) continue
        const controlConfig = cfg.controlDir === undefined ? {} : { directory: cfg.controlDir }
        if (hasRestorableControlState(controlPlaneFor(key, controlConfig))) continue
        roots.push({
          key,
          status: String(teamRoot?.status ?? root?.status ?? ''),
          updatedAt: Number(teamRoot?.updatedAt ?? root?.updatedAt ?? 0),
        })
      }
    } catch { /* roster may not be ready during plugin installation */ }
    focusBootstrapRoot(armed, roots)
  }

  const install = (scoped, teams) => {
    if (teams === undefined || teams === null) return undefined
    const listen = typeof scoped.on === 'function' ? scoped.on.bind(scoped)
      : typeof ctx.on === 'function' ? ctx.on.bind(ctx) : undefined
    if (typeof listen === 'function') {
      const stopStatus = listen('agent/status', ({ agent, status }) => {
        if (status === 'running' || status === 'provisioning') armAgent(teams, agent)
      }, { global: true })
      if (typeof stopStatus === 'function') stops.push(stopStatus)
    }
    focusCurrentRoot(scoped, teams)
    const tick = () => {
      try {
        if (disposed) return
        focusCurrentRoot(scoped, teams)
        for (const root of scoped.agents.list()) checkRoot(scoped, teams, root)
      } catch (error) {
        if (ctx.logger !== undefined) ctx.logger.warn?.('team-activity-digest: ' + String(error?.message ?? error))
      }
    }
    const timer = setInterval(tick, intervalMs)
    if (typeof timer.unref === 'function') timer.unref()
    const stop = () => clearInterval(timer)
    stops.push(stop)
    return stop
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['agents', 'agentTeams'], (scoped) => {
      const teams = typeof scoped.get === 'function' ? scoped.get('agentTeams') : scoped.agentTeams
      install(scoped, teams)
    })
    return dispose
  }

  install(ctx, ctx.agentTeams)
  return dispose
}
