/**
 * perf2: reload after control-plane hot-state bounds.
 *
 * The human operator's direct channel into a Team.
 *
 * Every Team control so far is a *tool*: the model decides to call it. That is
 * exactly the wrong dependency when the operator needs to intervene — a stuck
 * member, a provider quota lockout on one teammate, or a run that must stop
 * now. dsh-commands runs a handler against the receiving agent WITHOUT creating
 * a model message, so the human owns these operations deterministically and the
 * model can neither forget nor refuse them.
 *
 * The operator sits above tier 0: these handlers intentionally skip the peer
 * permission matrix (which governs model-called tools), while still obeying
 * structural limits such as the tier-1 lead cap and the per-group member cap.
 */
import { policyFor, reconcileRegistry, teamKeyOf } from './team-policy.mjs'
import { controlPlaneFor, latestClosedRound, roomActivity } from './team-control-plane.mjs'
import { collectTeamUsage, summarizeTeamUsage } from './team-usage.mjs'
import { milestoneScope } from './team-milestone-v2.mjs'
import {
  DEFAULT_SETTINGS_FILE as DEFAULT_REDUCER_SETTINGS_FILE,
  readReducerSettings,
  routeAllowed,
  writeReducerSettings,
} from './evidence-reducer.mjs'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { activeRouteApplier } from './team-tools-v2-r10.mjs'
import { buildTeamPanelOverview, projectPanelRooms } from './team-v14-panel.mjs'

export const name = 'team-operator'
console.log('[team-operator] loaded: perf35-health-status+perf49-single-hot-read+perf50-policy-snapshot-reuse+perf51-policy-snapshot-order+perf53-panel-doc-cache+member-route-persistence')
export const inject = ['commands', 'agentTeams']

const HELP = [
  '/team list                      roster with tier, group, status and parent',
  '/team freeze <name>             stop a member taking work (no cold resume)',
  '/team restore <name>            allow it to work again',
  '/team interrupt <name>          interrupt its current turn',
  '/team abort <name>              interrupt now, then freeze until restored',
  '/team route <name> <provider> <model> [effort]   change model and reasoning effort',
  '/team resume-provider           clear a provider auth/quota block after fixing it',
  '/team reducer-route show|off|session|set <provider> <model> [effort]',
  '                                route the evidence reducer without a restart',
  '/team usage                     tokens burned by the WHOLE Team, not just this session',
  '/team spawn <name> <tier> <group> <prompt...>    create a member directly',
].join('\n')

// `/team meta` is polled by the operator panel and every result is persisted as
// a command/done event in the session log. Keep this projection bounded: the
// panel needs recent state, not a second copy of every board, dispatch, and room
// transcript. Full task/room reads remain available through the Team tools.
const PANEL_ROOM_LIMIT = 12
const PANEL_ROOM_MESSAGE_LIMIT = 6
const PANEL_BOARD_TASK_LIMIT = 20
const PANEL_DISPATCH_LIMIT = 10
const PANEL_ROUND_LIMIT = 10
const PANEL_WAKE_LIMIT = 10
const PANEL_MILESTONE_LIMIT = 20
const PANEL_DOC_CACHE_LIMIT = 8
const TERMINAL_TASK_STATUSES = new Set(['completed', 'cancelled', 'expired', 'deleted'])
const panelDocCache = new Map()

const panelText = (value, limit) => String(value ?? '').slice(0, limit)
const panelArray = (value, limit = 12) => (Array.isArray(value) ? value : [])
  .slice(0, limit)
  .map((item) => panelText(item, 180))

export function readPanelJsonCached(path) {
  const stats = statSync(path, { bigint: true })
  const signature = [
    String(stats.dev),
    String(stats.ino),
    String(stats.size),
    String(stats.mtimeNs),
    String(stats.ctimeNs),
  ].join(':')
  const cached = panelDocCache.get(path)
  if (cached?.signature === signature) {
    panelDocCache.delete(path)
    panelDocCache.set(path, cached)
    return cached.value
  }
  const value = JSON.parse(readFileSync(path, 'utf8'))
  panelDocCache.delete(path)
  panelDocCache.set(path, { signature, value })
  while (panelDocCache.size > PANEL_DOC_CACHE_LIMIT) {
    panelDocCache.delete(panelDocCache.keys().next().value)
  }
  return value
}

export function panelHealth(control) {
  if (typeof control?.healthStatus === 'function') return control.healthStatus()
  return typeof control?.health === 'function' ? control.health() : null
}

function compactPanelTask(task) {
  return {
    id: task?.id ?? task?.taskId ?? null,
    subject: panelText(task?.subject ?? task?.title, 180),
    description: panelText(task?.description, 500),
    status: task?.status ?? null,
    phase: task?.phase ?? null,
    ownerName: task?.ownerName ?? task?.owner ?? null,
    blockedBy: panelArray(task?.blockedBy),
    writeScopes: panelArray(task?.writeScopes),
    writeScopeWarnings: panelArray(task?.writeScopeWarnings, 8),
    ready: task?.ready === true,
    revision: task?.revision ?? null,
    updatedAt: task?.updatedAt ?? null,
  }
}

function compactPanelTasks(tasks) {
  const rows = Array.isArray(tasks) ? tasks : Object.values(tasks ?? {})
  const active = rows.filter((task) => !TERMINAL_TASK_STATUSES.has(String(task?.status ?? '').toLowerCase()))
  const terminal = rows.filter((task) => TERMINAL_TASK_STATUSES.has(String(task?.status ?? '').toLowerCase()))
  return [...active.slice(-PANEL_BOARD_TASK_LIMIT), ...terminal.slice(-5)].map(compactPanelTask)
}

function compactPanelRound(round) {
  return {
    roundId: round?.roundId ?? null,
    roomId: round?.roomId ?? null,
    status: round?.status ?? null,
    topic: panelText(round?.topic, 180),
    summary: panelText(round?.summary, 500),
    unresolved: panelArray(round?.unresolved, 8),
    openedAt: round?.openedAt ?? null,
    closedAt: round?.closedAt ?? null,
    nextSpeaker: round?.nextSpeaker ?? null,
    mainSpoken: panelArray(round?.mainSpoken, 20),
    spoken: panelArray(round?.spoken, 20),
    order: panelArray(round?.order, 20),
  }
}

/** One line of roster text. */
function describe(member, extra) {
  const frozen = extra !== undefined && extra.frozen === true
  const tier = extra === undefined ? '?' : String(extra.tier)
  const group = extra === undefined ? '?' : String(extra.group)
  return '  ' + member.name + '  tier=' + tier + ' group=' + group
    + ' status=' + (frozen ? 'frozen' : member.status)
    + (extra !== undefined && extra.parent !== undefined ? ' parent=' + String(extra.parent) : '')
}

export function apply(ctx, config = {}) {
  // Per Team, not per process: this command runs against one session's agent, and two
  // sessions may run a Team at once. teamKey is refreshed by syncRegistry on every call.
  let teamKey = undefined
  const policy = () => policyFor(teamKey)

/**
 * Rebuild the policy registry from the authoritative Domain roster.
 *
 * The panel reads level and group through this channel, so it must repair the
 * same restart drift the tool layer repairs: a member that outlives a restart in
 * the Domain but not in this process would otherwise render as unregistered.
 * @param ctx - the host context carrying the Agent Teams service.
 * @param agent - the exact live Agent the command runs against.
 */
function syncRegistry(ctx, agent) {
  teamKey = teamKeyOf(ctx, agent)
  const active = policyFor(teamKey)
  if (active === undefined) return active
  try {
    reconcileRegistry(active.registry, ctx.agentTeams.listMembers(agent))
  } catch (error) {
    try { active.control.healthSet({ status: 'degraded', reasons: ['policy-reconcile:' + String(error?.message ?? error)] }) } catch {}
  }
  return active
}

  const fail = (text) => ({ kind: 'error', text })
  const done = (text) => ({ kind: 'success', text })

  /** Resolve the acting member for one human session. */
  const operatorOf = (agent) => {
    const membership = ctx.agentTeams.tryMembership(agent)
    return membership === undefined ? undefined : membership.name
  }

  const requireMember = (name) => {
    const registry = policy()
    if (registry === undefined) return undefined
    return registry.get(name)
  }

  ctx.commands.register({
    name: 'team',
    description: 'Operate the Agent Team directly, without a model turn',
    input: { hint: '<list|freeze|restore|interrupt|abort|route|spawn>' },
    // The operator's commands are authoritative control actions, not prompts.
    recordInput: false,
    handler: async ({ agent, rawInput }) => {
      syncRegistry(ctx, agent)
      const line = String(rawInput ?? '').trim()
      const [verb, ...rest] = line.length === 0 ? [] : line.split(/\s+/)
      const me = operatorOf(agent)

      if (verb === undefined) return done(HELP)

  if (verb === 'list') {
        policy().refreshFrozen?.()
        const includeFrozen = rest[0] === '--frozen'
        const rows = ctx.agentTeams.listMembers(agent)
          .filter((member) => includeFrozen || requireMember(member.name)?.frozen !== true)
          .map((member) => describe(member, requireMember(member.name)))
        return done('Team roster (' + String(rows.length) + ')\n' + rows.join('\n'))
      }

      if (verb === 'meta') {
        // The shipped panel renders the domain roster, which is FLAT: its Remote
        // payload has no tier, group, or frozen field at all. The panel therefore
        // reads them from here, the one host surface it can already reach.
        // Built from the registry, not from the Domain roster: the roster has no
        // tier at all, and needing it here made the panel degrade to "unregistered"
        // whenever this process could not resolve a live Team agent.
        const registry = policy()
        const cp = registry.control
        let durable
        try {
          durable = cp.view({ history: false })
          registry.refreshBoards?.(durable)
        } catch {
          /* Board hydration is best-effort; the panel can still render the Domain roster. */
        }
        const liveMembers = new Map(ctx.agentTeams.listMembers(agent).map((member) => [String(member.name), member]))
        const members = registry.all().map((record) => ({
          name: record.name,
          status: liveMembers.get(String(record.name))?.status ?? 'unknown',
          tier: record.tier,
          group: record.group === undefined ? null : record.group,
          parent: record.parent === undefined ? null : record.parent,
          role: record.role === undefined ? null : record.role,
          frozen: record.frozen === true,
        }))
        const boards = []
        try {
          const durableTasks = Object.values(durable?.boards?.global?.tasks ?? {})
          const domainTasks = await ctx.agentTeams.listTasks(agent)
          const durableById = new Map(durableTasks.map((row) => [String(row.id), row]))
          const domainIds = new Set(domainTasks.map((task) => String(task.id)))
          const projected = domainTasks.map((task) => {
            const local = durableById.get(String(task.id))
            return local === undefined ? task : {
              ...task,
              status: local.status ?? task.status,
              phase: local.phase ?? task.phase,
              revision: local.revision ?? task.revision,
              ...(local.ownerName === undefined ? {} : { ownerName: local.ownerName }),
              ...(local.commitSha === undefined ? {} : { commitSha: local.commitSha }),
              ...(local.evidenceIds === undefined ? {} : { evidenceIds: local.evidenceIds }),
            }
          })
          const extra = durableTasks.filter((local) => !domainIds.has(String(local.id)))
          boards.push({
            id: 'global',
            kind: 'global',
            tier: null,
            group: null,
            tasks: compactPanelTasks([...projected, ...extra]),
          })
        } catch {
          boards.push({ id: 'global', kind: 'global', tier: null, group: null, tasks: [] })
        }
        const ids = new Set()
        for (const member of registry.all()) {
          // Tier 0 owns the global board; it has no level board and no group board.
          if (member.tier !== 1 && member.tier !== 2) continue
          ids.add('level-' + member.tier)
          if (member.group !== undefined && member.group !== 'verifier') ids.add('group-' + member.group)
        }
        for (const id of [...ids].sort()) {
          const level = /^level-(\d+)$/.exec(id)
          boards.push({
            id,
            kind: id.startsWith('group-') ? 'group' : 'level',
            tier: level === null ? null : Number(level[1]),
            group: id.startsWith('group-') ? id.slice(6) : null,
            tasks: compactPanelTasks(registry.boardList(id)),
          })
        }
        // The panel shows each member's self-declared milestone. The model owns that file
        // through team_milestone; this is a read-only projection of it, so a milestone the
        // model set is visible to the human without asking the model to restate it.
        const milestones = {}
        try {
          const path = typeof config.milestonePath === 'string' && config.milestonePath.length > 0
            ? config.milestonePath
            : join(process.env.DSH_HOME ?? process.cwd(), 'team-milestones.json')
          const doc = readPanelJsonCached(path)
          const scope = milestoneScope(doc, teamKey)
          for (const [name, record] of Object.entries(scope.members ?? {})) {
            const pending = scope.compactions?.[name]
            milestones[name] = {
              stage: String(record.stage ?? ''),
              doneWhen: String(record.doneWhen ?? ''),
              done: record.done === true,
              compacted: record.compactedAt !== undefined && record.compactedAt !== null,
              ...pending === undefined || pending.status === 'compacted' ? {} : {
                pendingCompaction: {
                  status: String(pending.status ?? 'pending'),
                  reason: String(pending.reason ?? 'milestone'),
                  milestoneStage: String(pending.milestoneStage ?? record.stage ?? ''),
                  requestedAt: pending.requestedAt ?? null,
                },
              },
            }
          }
        } catch { /* No milestone document yet: the panel simply shows none. */ }
        let snapshot
        if (durable !== undefined) {
          snapshot = { ...durable, rooms: { ...(durable.rooms ?? {}) } }
        } else {
          // A failed read must not blank the whole panel: members and boards
          // come from the Domain and stay renderable without the durable state.
          snapshot = { rooms: {}, rounds: {}, dispatches: {}, escalations: {}, wakeEpisodes: {}, v12Compaction: { jobs: {} }, roomTails: {} }
        }
        for (const [roomId, messages] of Object.entries(snapshot.roomTails ?? {})) {
          if (!Array.isArray(messages) || messages.length === 0) continue
          const room = snapshot.rooms?.[roomId] ?? { roomId, status: 'open', members: [] }
          snapshot.rooms[roomId] = { ...room, messages }
        }
        let mechanismHealth = []
        try {
          const healthPath = typeof config.healthPath === 'string' && config.healthPath.length > 0
            ? config.healthPath
            : join(process.env.DSH_HOME ?? process.cwd(), 'team-health-web.json')
          const health = readPanelJsonCached(healthPath)
          mechanismHealth = Array.isArray(health?.mechanisms) ? health.mechanisms : []
        } catch {
          /* Health telemetry is diagnostic and optional for the panel. */
        }
        const rooms = projectPanelRooms(snapshot, PANEL_ROOM_MESSAGE_LIMIT, PANEL_ROOM_LIMIT).map((room) => {
          const source = snapshot.rooms?.[room.roomId] ?? room
          const latest = latestClosedRound(snapshot, source)
          return {
            ...room,
            summary: String(latest?.summary ?? room.summary ?? '').slice(0, 1000),
            latestClosedRound: latest === undefined ? null : {
              roundId: latest.roundId,
              topic: latest.topic ?? '',
              summary: latest.summary,
              closedAt: latest.closedAt ?? null,
            },
            activity: roomActivity(snapshot, source),
          }
        })
        const overview = buildTeamPanelOverview(snapshot, members)
        return done(JSON.stringify({
          teamRootId: teamKey,
          members,
          boards,
          milestones: Object.fromEntries(Object.entries(milestones).slice(-PANEL_MILESTONE_LIMIT)),
          rooms,
          rounds: Object.fromEntries(Object.entries(snapshot.rounds ?? {}).slice(-PANEL_ROUND_LIMIT).map(([id, round]) => [id, compactPanelRound(round)])),
          dispatches: Object.values(snapshot.dispatches ?? {}).slice(-PANEL_DISPATCH_LIMIT).map((dispatch) => ({
            dispatchId: dispatch.dispatchId, sender: dispatch.sender, target: dispatch.target,
            status: dispatch.status, attempt: dispatch.attempt, createdAt: dispatch.createdAt,
            queueAgeMs: dispatch.queueAgeMs, lastError: panelText(dispatch.lastError, 160),
          })),
          ...overview,
          escalations: Object.values(snapshot.escalations ?? {}).slice(-20).map((row) => ({
            escalationId: row.escalationId ?? row.id ?? null, roomId: row.roomId ?? null, taskId: row.taskId ?? null,
            owner: row.owner ?? row.target ?? null, status: row.status ?? null, reason: panelText(row.reason, 180),
            createdAt: row.createdAt ?? row.at ?? null, updatedAt: row.updatedAt ?? null,
          })),
          wakeEpisodes: Object.values(snapshot.wakeEpisodes ?? {}).slice(-PANEL_WAKE_LIMIT).map((row) => ({
            episodeId: row.episodeId ?? row.id ?? null, taskId: row.taskId ?? null, target: row.target ?? null,
            status: row.status ?? null, attempts: Number(row.attempts ?? row.attempt ?? 0),
            lastError: panelText(row.lastError ?? row.error, 180), updatedAt: row.updatedAt ?? row.at ?? null,
          })),
          compactionJobs: Object.values(snapshot.v12Compaction?.jobs ?? {}).slice(-20).map((row) => ({
            jobId: row.jobId ?? row.id ?? null, owner: row.owner ?? null, status: row.status ?? null,
            reason: panelText(row.reason, 180), requestedAt: row.requestedAt ?? row.at ?? null,
            completedAt: row.completedAt ?? null,
          })),
          mechanismHealth: mechanismHealth.slice(0, 30),
          counters: durable?.counters === undefined
            ? (() => { try { return cp.counters() } catch { return null } })()
            : structuredClone(durable.counters),
          health: durable?.health === undefined
            ? panelHealth(cp)
            : {
                status: durable.health?.status,
                reasons: Array.isArray(durable.health?.reasons) ? [...durable.health.reasons] : [],
                updatedAt: durable.health?.updatedAt,
              },
          provider: durable?.provider === undefined
            ? (() => { try { return cp.providerState?.() ?? null } catch { return null } })()
            : structuredClone(durable.provider),
        }))
      }

      if (verb === 'resume-provider') {
        if (teamKey === undefined) return fail('this session is not part of a Team')
        const result = await policy().control.providerResume({ resumedBy: 'operator' })
        return done(result.resumed === true
          ? 'provider block cleared; check credentials or quota before resuming work'
          : 'Team provider was not blocked')
      }

      if (verb === 'reducer-route') {
        const file = typeof config.reducerSettingsFile === 'string' && config.reducerSettingsFile.length > 0
          ? config.reducerSettingsFile
          : DEFAULT_REDUCER_SETTINGS_FILE
        const persist = async (patch) => {
          try {
            const settings = ctx.get('settings')
            if (settings !== undefined && settings !== null && typeof settings.update === 'function') {
              await settings.update('evidence-reducer', patch)
            }
          } catch {
            /* file fallback below remains deterministic for the live process */
          }
          return writeReducerSettings(patch, file)
        }
        const action = rest[0] ?? 'show'
        if (action === 'show') {
          const settings = readReducerSettings(file)
          return done(JSON.stringify({
            file,
            settings,
            routeStatus: {
              allowed: routeAllowed(settings.route, settings),
              remoteAllowed: settings.remoteAllowed === true,
              localProviders: Array.isArray(settings.localProviders) ? settings.localProviders : [],
            },
          }, null, 2))
        }
        if (action === 'off') {
          const settings = await persist({ enabled: false })
          return done('evidence reducer disabled\n' + JSON.stringify(settings, null, 2))
        }
        if (action === 'session') {
          const settings = await persist({ enabled: true, route: 'session', routeMode: 'session', remoteAllowed: false })
          return done('evidence reducer route: session (effective immediately)\n' + JSON.stringify(settings, null, 2))
        }
        if (action === 'set') {
          const [, provider, model, effort] = rest
          if (provider === undefined || model === undefined) {
            return fail('usage: /team reducer-route set <provider> <model> [effort]')
          }
          const route = effort === undefined ? { provider, model } : { provider, model, reasoningEffort: effort }
          const settings = await persist({
            enabled: true,
            route,
            routeMode: 'explicit',
            provider,
            model,
            ...effort === undefined ? {} : { reasoningEffort: effort },
            remoteAllowed: true,
          })
          return done('evidence reducer route: ' + provider + '/' + model
            + (effort === undefined ? '' : ' @' + effort) + ' (effective immediately)\n'
            + JSON.stringify(settings, null, 2))
        }
        return fail('usage: /team reducer-route show|off|session|set <provider> <model> [effort]')
      }

      if (me === undefined) return fail('this session is not part of a Team, so it has no Team to control')

      if (verb === 'freeze' || verb === 'restore') {
        const target = rest[0]
        if (target === undefined) return fail('usage: /team ' + verb + ' <name>')
        try {
          const previous = await policy().setFrozenAsync(target, verb === 'freeze', me, async () => {
            await ctx.agentTeams.setMemberFrozen(agent, target, verb === 'freeze')
          })
          if (previous === undefined) return fail('no member named "' + target + '"')
          try {
            const roster = policy().all()
            await policy().control.countersUpdate({ activeSlots: roster.filter((m) => m.tier > 0 && m.frozen !== true).length })
          } catch {}
          return done(target + ' frozen=' + String(verb === 'freeze') + ' (was ' + String(previous) + ')')
        } catch (error) {
          return fail('the durable freeze record could not be updated: ' + ((error && error.message) || String(error)))
        }
      }

      if (verb === 'interrupt') {
        const target = rest[0]
        if (target === undefined) return fail('usage: /team interrupt <name>')
        if (requireMember(target) === undefined) return fail('no member named "' + target + '"')
        await ctx.agentTeams.interrupt(agent, target)
        return done('interrupted ' + target)
      }

      if (verb === 'abort') {
        const target = rest[0]
        if (target === undefined) return fail('usage: /team abort <name>')
        if (requireMember(target) === undefined) return fail('no member named "' + target + '"')
        const previous = policy().get(target)?.frozen === true
        await ctx.agentTeams.interrupt(agent, target)
        try {
          await policy().setFrozenAsync(target, true, me, async () => {
            await ctx.agentTeams.setMemberFrozen(agent, target, true)
          })
        } catch (error) {
          return fail('abort freeze failed after interrupt; projection rolled back: ' + String(error?.message ?? error))
        }
        return done('aborted ' + target + ': current turn interrupted and the member is frozen until /team restore ' + target)
      }

      if (verb === 'usage') {
        // The Lead's own pill only ever counts the Lead's session, which in a real
        // project was about a seventh of the truth. This walks the whole Team.
        const membership = ctx.agentTeams.membership(agent)
        const rootId = membership.id
        const base = join(process.env.DSH_HOME ?? process.cwd(), 'sessions')
        let workspace
        try {
          for (const name of readdirSync(base)) {
            try { if (statSync(join(base, name, rootId)).isDirectory()) { workspace = join(base, name); break } } catch { /* not this one */ }
          }
        } catch { /* no sessions directory at all */ }
        if (workspace === undefined) return fail('could not locate the session store for this Team')
        const summary = summarizeTeamUsage(collectTeamUsage(workspace, rootId), rootId)
        const k = (value) => Math.round(value / 1000) + 'k'
        const lines = [
          'agents: ' + summary.agents,
          'total: ' + summary.total.toLocaleString('en-US'),
          '  lead: ' + summary.leadTotal.toLocaleString('en-US') + ' (' + Math.round((summary.leadTotal / Math.max(1, summary.total)) * 100) + '%)',
          '  others: ' + summary.otherTotal.toLocaleString('en-US') + ' (' + Math.round((summary.otherTotal / Math.max(1, summary.total)) * 100) + '%)',
          'cached: ' + summary.cached.toLocaleString('en-US'),
          '',
          ...summary.rows.map((row) => '  ' + String(row.total).padStart(12) + '  ' + (row.label === '' ? row.id.slice(0, 14) : row.label)),
        ]
        return done(lines.join('\n'))
      }

      if (verb === 'route') {
        const [target, provider, model, effort] = rest
        if (target === undefined || provider === undefined || model === undefined) {
          return fail('usage: /team route <name> <provider> <model> [effort]')
        }
        if (requireMember(target) === undefined) return fail('no member named "' + target + '"')
        const applyRoute = activeRouteApplier()
        if (applyRoute === undefined) return fail('the v2 Team tool layer is not mounted, so routes cannot be applied')
        const pinned = effort === undefined
          ? { provider, model }
          : { provider, model, reasoningEffort: effort }
        // DSH 0.1.6 removed the forked Agent Team route mutator. Keep using the
        // official durable hook when it exists, otherwise let the v2 layer own
        // the route and apply it on the member's next step.
        try {
          if (typeof ctx.agentTeams.setMemberRoute === 'function') {
            await ctx.agentTeams.setMemberRoute(agent, target, pinned)
          }
          const updated = await policy().setRouteAsync(target, pinned, 'operator')
          if (updated === undefined) return fail('no member named "' + target + '"')
        } catch (error) {
          return fail('the durable member route could not be persisted: ' + String(error?.message ?? error))
        }
        const applied = applyRoute(target, pinned)
        return applied
          ? done(target + ' -> ' + provider + '/' + model + (effort === undefined ? '' : ' @' + effort) + ' (effective from its next step)')
          : fail('route change for "' + target + '" was rejected')
      }

      if (verb === 'spawn') {
        const [memberName, tierText, group, ...promptParts] = rest
        if (memberName === undefined || tierText === undefined || group === undefined) {
          return fail('usage: /team spawn <name> <tier> <group> <prompt...>')
        }
        const tier = Number(tierText)
        if (tier !== 1 && tier !== 2) return fail('tier must be 1 (group lead or verifier) or 2 (team member)')
        // The human is the one caller that outranks the model-level lifetime budget: the
        // Domain's own limits still apply underneath, so this can never exceed the runtime.
        const verdict = policy().canSpawn(me, tier, group, { operator: true })
        if (!verdict.ok) return fail('refused [spawn-denied]: ' + verdict.reason)
        const { member: spawned } = await ctx.agentTeams.spawnTeammate(agent, {
          name: memberName,
          description: config.spawnDescription ?? 'Created by the human operator',
          prompt: promptParts.length === 0 ? (config.defaultPrompt ?? 'Wait for instructions.') : promptParts.join(' '),
          provider: config.freshProvider ?? 'spawn',
          level: tier,
          groupId: group,
          parentName: me,
        })
        policy().put({ name: spawned.name, tier, group, parent: me, frozen: false })
        try {
          const roster = policy().all()
          await policy().control.countersUpdate({
            activeSlots: roster.filter((m) => m.tier > 0 && m.frozen !== true).length,
          })
        } catch {}
        return done('spawned ' + spawned.name + ' tier=' + String(tier) + ' group=' + group + ' parent=' + me)
      }

      return fail('unknown subcommand "' + verb + '"\n' + HELP)
    },
  })
}
