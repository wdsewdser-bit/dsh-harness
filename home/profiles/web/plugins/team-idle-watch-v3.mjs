/**
 * team-idle-watch — the safety net for a Team that quietly stopped.
 *
 * The failure this exists for: every member finished, nobody reported to the Lead, and the
 * whole Team simply went silent. Nothing in the runtime notices, because to an observer that
 * only sees messages, 'nobody has anything left to do' looks exactly like 'work in flight'.
 *
 * The rule is deterministic rather than advisory: once the Lead AND every live subordinate
 * have been non-running for settleMs, the Lead is WOKEN with one reminder. A quiet inject
 * would be useless here — the Lead is idle with nothing in its inbox, so nothing would ever
 * read it. The reminder fires at most once per stop episode: any member going back to
 * running (including the Lead) starts a new episode.
 *
 * There is no lifetime or no-progress cap by default. A new stop episode always gets its
 * one reminder; an operator may still set maxReminders explicitly as an absolute backstop.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { controlPlaneFor, hashControlValue, teamRootIdCandidates } from './team-control-plane.mjs'

export const name = 'team-idle-watch'

/**
 * plugin activation must never depend on a service this composition may not mount, so this
 * uses the inject CALLBACK form: it binds the services without leaving the entry pending.
 */
export const inject = []

export const DEFAULTS = {
  /** How long the whole Team must stay stopped before the Lead is told. */
  /** No lifetime cap by default; a positive override is an optional operator backstop. */
  maxReminders: Number.POSITIVE_INFINITY,
  settleMs: 30000,
}

/**
 * Hash only state that means the Team actually delivered or explicitly resolved
 * something: terminal task state, evidence/commit, closed-round summaries and
 * decisions, escalation status, and packets. Task creation, claim, revision-only
 * edits, open rounds, chatter and dispatch rows are deliberately excluded.
 */
export function idleProgressHash(state) {
  try {
    const tasks = Object.values(state?.boards ?? {}).flatMap((board) =>
      Object.values(board?.tasks ?? {})
        .filter((task) => ['completed', 'deleted'].includes(String(task.status ?? '')))
        .map((task) => [
          String(task.id), String(task.status ?? ''), String(task.phase ?? ''),
          (task.evidenceIds ?? []).length, String(task.commitSha ?? ''),
        ])).sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    // Closed-round summaries/decisions and unresolved-item resolution are real
    // deliverables. Starting/open rounds and ordinary messages are not.
    const rooms = Object.values(state?.rooms ?? {})
      .map((room) => [
        String(room.roomId), String(room.summary ?? ''),
        (Array.isArray(room.unresolved) ? room.unresolved : [])
          .map((item) => [String(item?.id ?? item), String(item?.status ?? 'open'), String(item?.resolution ?? '')]),
        (Array.isArray(room.decisions) ? room.decisions : [])
          .map((decision) => [String(decision?.decisionId ?? ''), String(decision?.status ?? '')]),
      ])
      .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    const escalations = Object.values(state?.escalations ?? {})
      .map((row) => [String(row.escalationId), String(row.status ?? '')])
      .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    const packets = Object.values(state?.packets ?? {})
      .map((row) => [String(row.packetId), String(row.kind ?? ''), String(row.status ?? ''), String(row.commitSha ?? '')])
      .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    const payload = JSON.stringify({ tasks, rooms, escalations, packets })
    let hash = 0x811c9dc5
    for (let index = 0; index < payload.length; index += 1) {
      hash ^= payload.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash.toString(16).padStart(8, '0')
  } catch {
    return 'unknown'
  }
}

/** The one reminder the Lead gets when its Team went quiet. */
export function idleReminderText() {
  return '[team idle] 目前所有 team 已停工。先调用 team_delivery_check：如果它报告 owner-forgot-to-mark-it，唤醒对应 owner 补看板状态；如果确有未完成任务，再判断是继续推进还是被中断。'
    + ' 用 list_agents 看当前状态；如果看板无 open task 且已经交付，忽略本消息即可。'
}

/**
 * Whether one Team has stopped.
 *
 * Frozen members do not count as waiting — the Lead parked them on purpose — and failed
 * members never will. A Team whose only members are parked is therefore NOT reported, and a
 * Team with no subordinates at all is not reported either: there is nothing to wait for.
 * A member still provisioning is not stopped yet, however idle everything else looks.
 *
 * @param rows - one Team roster as @@ctx.agentTeams.listMembers@@ returns it.
 * @param rootStatus - the Lead's own agent status.
 * @returns whether the Team stopped, plus the counts the decision used.
 */
export function stoppedState(rows, rootStatus) {
  const list = Array.isArray(rows) ? rows.filter((row) => row !== null && typeof row === 'object') : []
  const provisioning = list.some((row) => row.status === 'provisioning')
  const live = list.filter((row) => row.role !== 'lead' && row.status !== 'failed' && row.frozen !== true)
  const waiting = live.filter((row) => row.status !== 'running').length
  const stopped = rootStatus !== 'running' && !provisioning && live.length > 0 && waiting === live.length
  return { stopped, waiting, live: live.length, provisioning }
}

/** Do not wake a Team whose control plane is explicitly blocked by a provider failure. */
export function suppressForControlPlane(control) {
  if (control === undefined || control === null) return false
  try {
    if (control.providerState?.().status === 'blocked') return true
    const health = control.health?.()
    return health?.status === 'disabled'
      && Array.isArray(health.reasons)
      && health.reasons.some((reason) => String(reason).startsWith('provider failure'))
  } catch {
    return false
  }
}

/**
 * Install the idle watch.
 * @param ctx - cordis plugin context.
 * @param config - optional settleMs override.
 * @returns nothing; the observers unwind with the plugin fiber.
 */
export function apply(ctx, config) {
  const overrides = config === null || config === undefined ? {} : config
  const cfg = Object.assign({}, DEFAULTS, overrides)
  const settleMs = Number.isFinite(cfg.settleMs) && cfg.settleMs > 0 ? cfg.settleMs : DEFAULTS.settleMs
  /** rootKey -> one pending check, plus whether this stop episode already reminded. */
  const episodes = new Map()
  const durableControl = (key) => typeof cfg.controlDir === 'string' && cfg.controlDir.length > 0
    ? controlPlaneFor(key, { directory: cfg.controlDir })
    : undefined

  const cancel = (key) => {
    const entry = episodes.get(key)
    if (entry !== undefined && entry.timer !== undefined) clearTimeout(entry.timer)
    episodes.delete(key)
  }

  const check = (teams, root, key) => {
    try {
      if (root === undefined || root === null) return
      if (root.status === 'running') return
      const state = stoppedState(teams.listMembers(root), root.status)
      if (state.stopped !== true) return
      const cp = durableControl(key)
      const progress = cp === undefined ? undefined : idleProgressHash(cp.snapshot())
      if (cp !== undefined) {
        const absoluteBudget = Number.isFinite(cfg.maxReminders) && cfg.maxReminders > 0
          ? cfg.maxReminders
          : Number.POSITIVE_INFINITY
        const watchRows = Object.values(cp.snapshot().wakeEpisodes ?? {})
          .filter((row) => row.sender === 'team-idle-watch')
          .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0))
        // Only an explicit maxReminders override can suppress a stop episode. The semantic
        // progress hash remains in the episode id for diagnostics, but never counts as a cap.
        if (watchRows.length >= absoluteBudget) {
          episodes.set(key, { timer: undefined, reminded: true })
          if (ctx.logger !== undefined) {
            ctx.logger.warn?.('team-idle-watch: ' + key + ' suppressed an idle reminder ('
              + String(watchRows.length) + ' total, maxReminders=' + String(absoluteBudget)
              + '); leaving the stopped Team for the operator')
          }
          return
        }
      }
      if (suppressForControlPlane(cp)) {
        if (ctx.logger !== undefined) ctx.logger.warn?.('team-idle-watch: provider-blocked Team ' + key + ' remains stopped')
        return
      }
      const message = createUserMessage({ content: [{ type: 'text', text: idleReminderText() }], source: { kind: 'user' } })
      if (cp !== undefined) {
        const claim = cp.wakeClaim({
          episodeId: 'idle:' + key + ':' + String(Math.floor(Date.now() / Math.max(1, settleMs))) + ':' + String(progress ?? 'unknown'),
          sender: 'team-idle-watch',
          target: membershipName(root, teams),
          messageHash: hashControlValue(idleReminderText()),
        })
        if (claim && typeof claim.then === 'function') {
          claim.then((result) => {
            if (result?.claimed === false) return
            deliverIdle(root, message, key)
          }).catch(() => {})
          return
        }
      }
      deliverIdle(root, message, key)
    } catch (error) {
      if (ctx.logger !== undefined) ctx.logger.warn?.('team-idle-watch: ' + ((error && error.message) || String(error)))
    }
  }

  const membershipName = (root, teams) => {
    try { return teams.tryMembership(root)?.name ?? 'lead' } catch { return 'lead' }
  }
  const deliverIdle = (root, message, key) => {
      // Waking on purpose: an idle Lead with an empty inbox never reads a quiet inject, and
      // the whole point of this net is the case where nothing else would ever wake it.
      if (typeof root.followup === 'function') root.followup(message)
      else if (typeof root.inject === 'function') root.inject(message)
      else return
      episodes.set(key, { timer: undefined, reminded: true })
      if (ctx.logger !== undefined) ctx.logger.info?.('team-idle-watch: reminded the Lead of Team ' + key)
  }

  const install = (host, teams) => {
    if (teams === undefined || teams === null) return undefined
    return host.on('agent/status', ({ agent, status }) => {
      if (agent === undefined || agent === null) return
      let membership
      try {
        membership = teams.tryMembership(agent)
      } catch {
        return
      }
      if (membership === undefined || membership.root === undefined) return
      const key = teamRootIdCandidates({ agentTeams: teams }, agent)[0] ?? ''
      if (status === 'running') {
        // Work resumed — including the Lead answering a member — so this episode is over and
        // the next stop deserves its own reminder.
        cancel(key)
        return
      }
      const entry = episodes.get(key)
      if (entry !== undefined && entry.reminded === true) return
      if (entry !== undefined && entry.timer !== undefined) clearTimeout(entry.timer)
      // One-shot timers lose the stop when another member is still running at expiry and
      // then finishes without producing a fresh status event. Keep a periodic re-check alive
      // until the Team actually resumes or the reminder is delivered.
      const timer = setInterval(() => {
        const current = episodes.get(key)
        if (current === undefined || current.reminded === true) {
          clearInterval(timer)
          episodes.delete(key)
          return
        }
        check(teams, membership.root, key)
      }, settleMs)
      if (typeof timer.unref === 'function') timer.unref()
      episodes.set(key, { timer, reminded: false })
    }, { global: true })
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['agentTeams'], (scoped) => {
      const teams = typeof scoped.get === 'function' ? scoped.get('agentTeams') : undefined
      install(scoped, teams)
    })
    return
  }
  install(ctx, ctx.agentTeams)
}
