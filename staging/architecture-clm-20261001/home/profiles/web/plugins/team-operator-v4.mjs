/**
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
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { activeRouteApplier } from './team-tools-v2-r9.mjs'

export const name = 'team-operator'
export const inject = ['commands', 'agentTeams']

const HELP = [
  '/team list                      roster with tier, group, status and parent',
  '/team freeze <name>             stop a member taking work (no cold resume)',
  '/team restore <name>            allow it to work again',
  '/team interrupt <name>          interrupt its current turn',
  '/team abort <name>              interrupt now, then freeze until restored',
  '/team route <name> <provider> <model> [effort]   change model and reasoning effort',
  '/team resume-provider           clear a provider auth/quota block after fixing it',
  '/team usage                     tokens burned by the WHOLE Team, not just this session',
  '/team spawn <name> <tier> <group> <prompt...>    create a member directly',
].join('\n')

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
        registry.refreshBoards?.()
        const members = registry.all().map((record) => ({
          name: record.name,
          tier: record.tier,
          group: record.group === undefined ? null : record.group,
          parent: record.parent === undefined ? null : record.parent,
          role: record.role === undefined ? null : record.role,
          frozen: record.frozen === true,
        }))
        const boards = []
        try {
          const durable = registry.control.snapshot()
          const durableTasks = Object.values(durable.boards?.global?.tasks ?? {})
          const domainTasks = await ctx.agentTeams.listTasks(agent)
          const projected = domainTasks.map((task) => {
            const local = durableTasks.find((row) => String(row.id) === String(task.id))
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
          const extra = durableTasks.filter((local) => !domainTasks.some((task) => String(task.id) === String(local.id)))
          boards.push({ id: 'global', kind: 'global', tier: null, group: null, tasks: [...projected, ...extra] })
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
            tasks: registry.boardList(id),
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
          const doc = JSON.parse(readFileSync(path, 'utf8'))
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
        const cp = registry.control
        const snapshot = cp.snapshot()
        const rooms = Object.values(snapshot.rooms ?? {}).map((room) => {
          const latest = latestClosedRound(snapshot, room)
          return {
            ...room,
            summary: latest?.summary ?? room.latestSummary?.text ?? room.summary ?? '',
            latestClosedRound: latest === undefined ? (room.latestSummary ?? null) : {
              roundId: latest.roundId,
              topic: latest.topic ?? '',
              summary: latest.summary,
              closedAt: latest.closedAt ?? null,
            },
            activity: roomActivity(snapshot, room),
          }
        })
        return done(JSON.stringify({
          teamRootId: teamKey,
          members,
          boards,
          milestones,
          rooms,
          rounds: snapshot.rounds ?? {},
          dispatches: Object.values(snapshot.dispatches ?? {}),
          escalations: Object.values(snapshot.escalations ?? {}),
          wakeEpisodes: Object.values(snapshot.wakeEpisodes ?? {}),
          counters: cp.counters(),
          health: cp.health(),
          provider: cp.providerState?.() ?? null,
        }))
      }

      if (verb === 'resume-provider') {
        if (teamKey === undefined) return fail('this session is not part of a Team')
        const result = await policy().control.providerResume({ resumedBy: 'operator' })
        return done(result.resumed === true
          ? 'provider block cleared; check credentials or quota before resuming work'
          : 'Team provider was not blocked')
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
        if (typeof ctx.agentTeams.setMemberRoute === 'function') {
          await ctx.agentTeams.setMemberRoute(agent, target, pinned)
        }
        policy().setRoute(target, pinned)
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
