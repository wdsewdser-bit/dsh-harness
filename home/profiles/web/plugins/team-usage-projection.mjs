/**
 * team-usage-projection — the whole Team's token spend, visible to the client.
 *
 * The composer's two stats pills read ONE session's `tokenUsage`, and a session
 * projection is per-session by construction: its apply() only ever sees that session's
 * own event stream, so the Lead's pill showed roughly a seventh of the real spend and
 * there was no cross-session aggregate to read instead.
 *
 * The fix keeps every part inside machinery that already exists. The Team's journals are
 * still the single durable record of what each agent burned; on the Lead's idle edge they
 * are summed once and appended to the Lead's own session as a `team/usage` event; and a
 * projection unit turns that event into a view the client reads with the same
 * useProjection() call it already uses for tokenUsage. No new remote method, no polling.
 */
import { z } from 'zod'
import { join } from 'node:path'
import { collectTeamUsage, locateWorkspace, summarizeTeamUsage } from './team-usage.mjs'

export const name = 'team-usage-projection'
export const inject = ['sessionProjections', 'agentTeams']

export const DEFAULTS = {
  /** Overridden by tests; defaults to $DSH_HOME/sessions. */
  sessionsDir: null,
}

const usageSchema = z.union([z.null(), z.object({
  agents: z.number(),
  total: z.number(),
  leadTotal: z.number(),
  otherTotal: z.number(),
  cached: z.number(),
  at: z.number(),
})])

/** Shape one summary as the durable view the client reads. */
export function usageView(summary, at) {
  return {
    agents: summary.agents,
    total: summary.total,
    leadTotal: summary.leadTotal,
    otherTotal: summary.otherTotal,
    cached: summary.cached,
    at,
  }
}

/**
 * Sum every agent of one Team, or null when its store cannot be found.
 * @param sessionsBase - the $DSH_HOME/sessions directory.
 * @param rootId - the Team's root session id.
 * @param now - timestamp recorded with the view.
 */
export function computeUsage(sessionsBase, rootId, now) {
  const workspace = locateWorkspace(sessionsBase, rootId)
  if (workspace === undefined) return null
  return usageView(summarizeTeamUsage(collectTeamUsage(workspace, rootId), rootId), now)
}

export function apply(ctx, config) {
  const overrides = config === null || config === undefined ? {} : config
  const cfg = Object.assign({}, DEFAULTS, overrides)
  const base = typeof cfg.sessionsDir === 'string' && cfg.sessionsDir.length > 0
    ? cfg.sessionsDir
    : join(process.env.DSH_HOME ?? process.cwd(), 'sessions')

  ctx.sessionProjections.register({
    key: 'teamUsage',
    // Required by the registry; bump it only if the shape below ever changes out of band.
    stateVersion: 1,
    stateSchema: usageSchema,
    init: () => null,
    apply: (state, event) => (event.type === 'team/usage' ? event.data : state),
    wire: { viewSchema: usageSchema, view: (state) => state },
  })

  // The Lead is the session a human reads, and it goes idle at real boundaries, so this
  // is both the cheapest and the most accurate moment to re-sum the Team. Sub-agents are
  // deliberately not recomputed: their turns are far more frequent than anyone's need to
  // re-read a total, and the Lead's number already covers every one of them.
  return ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle' || agent === undefined || agent === null) return
    try {
      const membership = ctx.agentTeams.tryMembership(agent)
      if (membership === undefined || membership.role !== 'lead') return
      const view = computeUsage(base, membership.id, Date.now())
      if (view !== null) agent.session.append('team/usage', view)
    } catch {
      /* A statistics view must never disturb the agent it measures. */
    }
  })
}
