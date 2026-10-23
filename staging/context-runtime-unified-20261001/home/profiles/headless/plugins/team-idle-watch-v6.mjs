/**
 * HMR probe: 2026-09-27T14:24+08:00.
 *
 * team-idle-watch — the safety net for a Team that quietly stopped.
 *
 * The failure this exists for: every member finished, nobody reported to the Lead, and the
 * whole Team simply went silent. It also hands durable room speaker timeouts to the Lead.
 *
 * The rule is deterministic rather than advisory: once the Lead AND every live subordinate
 * have been non-running for settleMs, the Lead is WOKEN with one reminder. A quiet inject
 * would be useless here — the Lead is idle with nothing in its inbox, so nothing would ever
 * read it. A delivered reminder is not repeated until genuine input, a task fact,
 * or an explicit responsibility deadline changes.
 *
 * There is no lifetime cap by default. New input or task facts rearm the reminder;
 * time passing and the observer's own wake are not new work.
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
  /** Backstop polling for a Team that was already stopped before this plugin mounted. */
  bootstrapScanMs: 30000,
  settleMs: 30000,
  /** Optional periodic scan cadence. When set, this replaces settleMs for stop re-checks. */
  intervalMs: 0,
  /** Maximum quiet interval for the current Room speaker before one Lead/host notice. */
  roomSpeakerTimeoutMs: 15 * 60 * 1000,
  /** Bounded transport retries for the current speaker's timeout notice. */
  roomTimeoutMaxAttempts: 2,
  roomTimeoutRetryMs: 30000,
  /** A round whose speakers are all done must be closed within this grace period. */
  roomCloseGraceMs: 15 * 60 * 1000,
  /** Bounded host re-wakes before the host is replaced or the round is auto-closed. */
  roomCloseMaxAttempts: 2,
  roomCloseRetryMs: 30000,
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

const inputCursors = new WeakMap()
const OBSERVER_INPUTS = new Set(['team-idle-watch', 'team-activity-digest'])

/** Keep the latest genuine input stable across observer-only turns and reloads. */
function latestIdleInput(session) {
  if (typeof session?.eventAt !== 'function' || !Number.isInteger(session.seq)) return null
  let cursor = inputCursors.get(session)
  if (cursor === undefined || cursor.seq > session.seq) cursor = { seq: 0, input: null }
  for (let seq = cursor.seq; seq < session.seq; seq++) {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message') { cursor.quietBatch = undefined; continue }
    const source = event.data?.source
    if (source?.kind === 'runtime-context'
      || (source?.kind === 'team-message' && source?.plugin === 'team-v12-runtime' && source?.form === 'snapshot')) continue
    if (OBSERVER_INPUTS.has(source?.plugin)) {
      // A queued quiet batch drained in this same reminder turn is already observed.
      if (source?.plugin === 'team-idle-watch' && cursor.quietBatch !== undefined) cursor.input = cursor.quietBatch
      cursor.quietBatch = undefined
      continue
    }
    const quiet = source?.kind === 'team-message' && source?.plugin === 'tool-agent-team-v2' && source?.summary === 'team quiet batch'
    cursor.quietBatch = quiet ? (cursor.quietBatch === undefined ? cursor.input : cursor.quietBatch) : undefined
    cursor.input = seq
  }
  cursor.seq = session.seq
  inputCursors.set(session, cursor)
  return cursor.input
}

/** Exclude timestamps/revision churn and observer receipts from wake identity. */
export function idleWakeHash(state, root, rows) {
  const tasks = Object.entries(state?.boards ?? {}).flatMap(([boardId, board]) =>
    Object.values(board?.tasks ?? {}).map(task => [boardId, task.id, task.status, task.phase,
      task.lifecycle, task.ownerName, task.blockedBy ?? [], task.contract ?? null, task.writeScopes ?? []]))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const roster = (Array.isArray(rows) ? rows : []).map(row =>
    [row.id ?? row.name, row.name, row.role, row.frozen === true, row.status === 'failed'])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  const waiting = Object.entries(state?.v14Waiting?.tickets ?? {}).map(([id, row]) => {
    const deadline = row?.nextCheckAt ?? row?.expiresAt
    const at = typeof deadline === 'string' ? Date.parse(deadline) : Number(deadline)
    return [id, row?.status, row?.taskId, row?.responsible, row?.unblockCondition,
      deadline ?? null, Number.isFinite(at) && at > 0 && Date.now() >= at]
  }).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  return hashControlValue({ progress: idleProgressHash(state), tasks, roster, waiting, input: latestIdleInput(root?.session) })
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
    const health = typeof control.healthStatus === 'function' ? control.healthStatus() : control.health?.()
    return health?.status === 'disabled'
      && Array.isArray(health.reasons)
      && health.reasons.some((reason) => String(reason).startsWith('provider failure'))
  } catch {
    return false
  }
}

/** Return open room turns whose current speaker has exceeded the bounded wait. */
export function timedOutRoomSpeakers(state, nowValue = Date.now(), timeoutMs = 15 * 60 * 1000) {
  const now = Number(nowValue)
  const timeout = Number(timeoutMs)
  if (!Number.isFinite(now) || !Number.isFinite(timeout) || timeout <= 0) return []
  const timedOut = []
  for (const room of Object.values(state?.rooms ?? {})) {
    if (room?.status !== 'open' || room.currentRoundId == null) continue
    const round = state?.rounds?.[room.currentRoundId]
    const speaker = round?.nextSpeaker
    if (round?.status !== 'open' || typeof speaker !== 'string' || speaker.length === 0) continue
    const activityAt = Math.max(
      Number(round.openedAt || 0),
      Number(room.lastMessageAt || 0),
    )
    if (activityAt <= 0 || now - activityAt < timeout) continue
    timedOut.push({
      roomId: String(room.roomId),
      roundId: String(round.roundId),
      speaker,
      host: typeof room.host === 'string' ? room.host : null,
      topic: String(round.topic || ''),
      activityAt,
      timeoutMs: timeout,
      episodeId: 'room-timeout:' + String(room.roomId) + ':' + String(round.roundId) + ':' + speaker,
    })
  }
  return timedOut
}

export function roomTimeoutReminder(roomWait, timeoutMs = 15 * 60 * 1000) {
  return '[team room timeout] Room "' + roomWait.roomId + '" round "' + roomWait.roundId
    + '" is still waiting for speaker "' + roomWait.speaker + '" (' + String(timeoutMs)
    + 'ms without a turn). Read the room and roster, then use team_room_timeout_recover only if a bounded retry is appropriate. Do not wake the whole team or reassign work.'
}

/** Return open rounds whose every main speaker has finished but the host did not close. */
export function timedOutRoomClosures(state, nowValue = Date.now(), graceMs = 15 * 60 * 1000) {
  const now = Number(nowValue)
  const grace = Number(graceMs)
  if (!Number.isFinite(now) || !Number.isFinite(grace) || grace <= 0) return []
  const timedOut = []
  for (const room of Object.values(state?.rooms ?? {})) {
    if (room?.status !== 'open' || room.currentRoundId == null) continue
    const round = state?.rounds?.[room.currentRoundId]
    if (round?.status !== 'open' || round.nextSpeaker !== null) continue
    const order = Array.isArray(round.order) ? round.order.map(String) : []
    const spoken = new Set(Array.isArray(round.mainSpoken) ? round.mainSpoken.map(String) : [])
    if (order.length === 0 || order.some((member) => !spoken.has(member))) continue
    const turnTimes = (Array.isArray(room.messages) ? room.messages : [])
      .filter((message) => message?.roundId === round.roundId && message.turn === true)
      .map((message) => Number(message.createdAt || 0))
    const awaitingSince = Math.max(
      Number(round.openedAt || 0),
      ...turnTimes,
      Number(room.lastMessageAt || 0),
    )
    if (awaitingSince <= 0 || now - awaitingSince < grace) continue
    timedOut.push({
      roomId: String(room.roomId),
      roundId: String(round.roundId),
      host: typeof room.host === 'string' ? room.host : null,
      topic: String(round.topic || ''),
      awaitingSince,
      deadlineAt: awaitingSince + grace,
      overdueMs: Math.max(0, now - awaitingSince - grace),
      graceMs: grace,
      episodeId: 'room-close:' + String(room.roomId) + ':' + String(round.roundId),
    })
  }
  return timedOut
}

export function roomCloseReminder(roomWait, graceMs = 15 * 60 * 1000) {
  return '[team room close timeout] Room "' + roomWait.roomId + '" round "' + roomWait.roundId
    + '" has been awaiting host close for at least ' + String(graceMs)
    + 'ms. Read the room, close the round with team_room_close and a summary, then stop.'
}

/**
 * Return the next bounded close wake attempt. Unlike a transport-only retry, a
 * delivered close wake is retried too because the responsibility is still open.
 */
export function roomCloseAttempt(state, roomWait, nowValue = Date.now(), maxAttempts = 2, retryDelayMs = 30000) {
  const base = String(roomWait?.episodeId ?? '')
  if (base.length === 0) return null
  const now = Number(nowValue)
  const max = Math.max(1, Number(maxAttempts) || 1)
  const delay = Math.max(0, Number(retryDelayMs) || 0)
  for (let attempt = 1; attempt <= max; attempt += 1) {
    const episodeId = base + ':a' + attempt
    const row = state?.wakeEpisodes?.[episodeId]
    if (row === undefined) return { episodeId, attempt }
    if (now - Number(row.updatedAt ?? row.createdAt ?? now) < delay) return null
  }
  return null
}

/** Resolve the configured watch cadence, including the legacy settle fallback. */
export function idleWatchCadence(config = {}) {
  const settleMs = Number.isFinite(config?.settleMs) && config.settleMs > 0
    ? config.settleMs
    : DEFAULTS.settleMs
  const intervalMs = Number.isFinite(config?.intervalMs) && config.intervalMs > 0
    ? config.intervalMs
    : 0
  return {
    settleMs,
    intervalMs,
    scanIntervalMs: intervalMs > 0 ? intervalMs : settleMs,
  }
}

/**
 * Return the next bounded transport attempt for one room-timeout episode.
 * A failed send is terminal per attempt; a new attempt is allowed only after
 * the retry delay and never beyond the configured maximum.
 */
export function roomTimeoutAttempt(state, roomWait, nowValue = Date.now(), maxAttempts = 2, retryDelayMs = 30000) {
  const base = String(roomWait?.episodeId ?? '')
  if (base.length === 0) return null
  const now = Number(nowValue)
  const max = Math.max(1, Number(maxAttempts) || 1)
  const delay = Math.max(0, Number(retryDelayMs) || 0)
  const legacy = state?.wakeEpisodes?.[base]
  if (legacy !== undefined && !['delivery-failed', 'resolved', 'cancelled'].includes(String(legacy.status))) return null
  for (let attempt = 1; attempt <= max; attempt += 1) {
    const episodeId = base + ':a' + attempt
    const row = state?.wakeEpisodes?.[episodeId]
    if (row === undefined) return { episodeId, attempt }
    if (String(row.status) !== 'delivery-failed') return null
    if (now - Number(row.updatedAt ?? row.createdAt ?? now) < delay) return null
  }
  return null
}

/**
 * Install the idle watch.
 * @param ctx - cordis plugin context.
 * @param config - optional settleMs override.
 * @returns nothing; the observers unwind with the plugin fiber.
 */
export function apply(ctx, config) {
  console.log('[team-idle-watch] HMR perf46-operator-stop-wake+ten-minute-retry loaded 2026-09-27')
  const overrides = config === null || config === undefined ? {} : config
  const cfg = Object.assign({}, DEFAULTS, overrides)
  let disposed = false
  let generation = 0
  const pending = new Set()
  const track = operation => {
    pending.add(operation)
    operation.then(() => pending.delete(operation), () => pending.delete(operation))
  }
  const armed = armedRoots()
  const cadence = idleWatchCadence(cfg)
  const scanIntervalMs = cadence.scanIntervalMs
  const roomSpeakerTimeoutMs = Number.isFinite(cfg.roomSpeakerTimeoutMs) && cfg.roomSpeakerTimeoutMs > 0
    ? cfg.roomSpeakerTimeoutMs
    : DEFAULTS.roomSpeakerTimeoutMs
  const roomTimeoutMaxAttempts = Number.isFinite(cfg.roomTimeoutMaxAttempts) && cfg.roomTimeoutMaxAttempts > 0
    ? Math.max(1, Math.floor(cfg.roomTimeoutMaxAttempts))
    : DEFAULTS.roomTimeoutMaxAttempts
  const roomTimeoutRetryMs = Number.isFinite(cfg.roomTimeoutRetryMs) && cfg.roomTimeoutRetryMs >= 0
    ? cfg.roomTimeoutRetryMs
    : DEFAULTS.roomTimeoutRetryMs
  const roomCloseGraceMs = Number.isFinite(cfg.roomCloseGraceMs) && cfg.roomCloseGraceMs > 0
    ? cfg.roomCloseGraceMs
    : DEFAULTS.roomCloseGraceMs
  const roomCloseMaxAttempts = Number.isFinite(cfg.roomCloseMaxAttempts) && cfg.roomCloseMaxAttempts > 0
    ? Math.max(1, Math.floor(cfg.roomCloseMaxAttempts))
    : DEFAULTS.roomCloseMaxAttempts
  const roomCloseRetryMs = Number.isFinite(cfg.roomCloseRetryMs) && cfg.roomCloseRetryMs >= 0
    ? cfg.roomCloseRetryMs
    : DEFAULTS.roomCloseRetryMs
  const retryAfterMs = Number.isFinite(cfg.retryAfterMs) && cfg.retryAfterMs > 0
    ? cfg.retryAfterMs
    : 10 * 60 * 1000
  /** rootKey -> one pending check, plus whether this stop episode already reminded. */
  const episodes = new Map()
  const holdForRetry = (key, delayMs = retryAfterMs) => {
    const previous = episodes.get(key)
    if (previous !== undefined && previous.timer !== undefined) clearTimeout(previous.timer)
    const timer = setTimeout(() => {
      const current = episodes.get(key)
      if (current === undefined || current.timer !== timer) return
      episodes.delete(key)
    }, Math.max(1, Number(delayMs) || retryAfterMs))
    if (typeof timer.unref === 'function') timer.unref()
    episodes.set(key, { timer, reminded: true })
  }
  const durableControl = (key) => typeof cfg.controlDir === 'string' && cfg.controlDir.length > 0
    ? controlPlaneFor(key, { directory: cfg.controlDir })
    : undefined
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

  const cancel = (key) => {
    const entry = episodes.get(key)
    if (entry !== undefined && entry.timer !== undefined) clearTimeout(entry.timer)
    episodes.delete(key)
  }

  const check = (teams, root, key) => {
    try {
      if (disposed) return
      if (root === undefined || root === null) return
      if (!isArmed(armed, key)) return
      if (root.status === 'running') return
      const rows = teams.listMembers(root)
      const state = stoppedState(rows, root.status)
      if (state.stopped !== true) return
      const cp = durableControl(key)
      const snapshot = cp === undefined ? undefined : cp.view({ history: false })
      const progress = idleWakeHash(snapshot, root, rows)
      let attempt = 1
      if (cp !== undefined) {
        const absoluteBudget = Number.isFinite(cfg.maxReminders) && cfg.maxReminders > 0
          ? cfg.maxReminders
          : Number.POSITIVE_INFINITY
        const watchRows = Object.values(snapshot?.wakeEpisodes ?? {})
          .filter((row) => row.sender === 'team-idle-watch')
          .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0))
        const progressSuffix = ':' + String(progress ?? 'unknown')
        attempt = watchRows.filter(row => String(row.episodeId ?? '').endsWith(progressSuffix)).length + 1
        const now = Date.now()
        const claimedRows = watchRows.filter((row) => String(row.episodeId ?? '').endsWith(progressSuffix)
          && !['delivery-failed', 'run-failed', 'timed-out', 'expired', 'failed', 'cancelled', 'rejected'].includes(String(row.status ?? '').toLowerCase())
          && (String(row.status) !== 'queued' || now - Number(row.createdAt || 0) < retryAfterMs))
        const latestClaim = claimedRows[claimedRows.length - 1]
        if (latestClaim !== undefined) {
          holdForRetry(key)
          return
        }
        // Semantic de-dup is independent of this optional lifetime backstop.
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
      const message = createUserMessage({
        content: [{ type: 'text', text: idleReminderText() }],
        source: { kind: 'team-message', plugin: name, form: 'notice', summary: 'team idle watch' },
      })
      if (cp !== undefined) {
        const episodeId = 'idle:' + key + ':' + String(attempt) + ':' + String(progress)
        const claimGeneration = generation
        holdForRetry(key)
        const claim = cp.wakeClaim({
          episodeId,
          sender: 'team-idle-watch',
          target: membershipName(root, teams),
          messageHash: hashControlValue(idleReminderText()),
        })
        if (claim && typeof claim.then === 'function') {
          const operation = claim.then(async (result) => {
            if (result?.claimed === false) return
            const currentRows = teams.listMembers(root)
            if (disposed || claimGeneration !== generation || !isArmed(armed, key)
              || !stoppedState(currentRows, root.status).stopped || suppressForControlPlane(cp)
              || progress !== idleWakeHash(cp.view({ history: false }), root, currentRows)) {
              await cp.wakeAcknowledge({ episodeId, status: 'cancelled' })
              return
            }
            try {
              await deliverIdle(root, message, key)
              await cp.wakeAcknowledge({ episodeId, status: 'delivered' })
            } catch (error) {
              await cp.wakeAcknowledge({ episodeId, status: 'delivery-failed' })
              ctx.logger?.warn?.('team-idle-watch delivery failed: ' + String(error?.message ?? error))
            }
          }).catch(error => ctx.logger?.warn?.('team-idle-watch claim failed: ' + String(error?.message ?? error)))
          track(operation)
          return
        }
      }
      track(deliverIdle(root, message, key).catch(error => ctx.logger?.warn?.('team-idle-watch delivery failed: ' + String(error?.message ?? error))))
    } catch (error) {
      if (ctx.logger !== undefined) ctx.logger.warn?.('team-idle-watch: ' + ((error && error.message) || String(error)))
    }
  }

  const checkRoomTimeouts = async (teams, root, key) => {
    if (disposed) return
    const cp = durableControl(key)
    if (!isArmed(armed, key) || cp === undefined || root === undefined || root === null || suppressForControlPlane(cp)) return
    const snapshot = cp.view({ history: false })
    for (const wait of timedOutRoomSpeakers(snapshot, Date.now(), roomSpeakerTimeoutMs)) {
      const attempt = roomTimeoutAttempt(snapshot, wait, Date.now(), roomTimeoutMaxAttempts, roomTimeoutRetryMs)
      if (attempt === null) {
        const failedAttempts = []
        for (let index = 1; index <= roomTimeoutMaxAttempts; index += 1) {
          const row = snapshot.wakeEpisodes?.[wait.episodeId + ':a' + index]
          if (row !== undefined) failedAttempts.push(row)
        }
        const lastFailed = failedAttempts
          .filter((row) => String(row.status) === 'delivery-failed')
          .sort((left, right) => Number(left.updatedAt ?? left.createdAt ?? 0) - Number(right.updatedAt ?? right.createdAt ?? 0))
          .at(-1)
        if (lastFailed !== undefined
          && Date.now() - Number(lastFailed.updatedAt ?? lastFailed.createdAt ?? 0) >= roomTimeoutRetryMs) {
          const alreadyEscalated = Object.values(snapshot.escalations ?? {}).some((row) =>
            row?.category === 'room-timeout'
              && Array.isArray(row.references)
              && row.references.includes(wait.episodeId)
              && !['resolved', 'cancelled'].includes(String(row.status)))
          if (!alreadyEscalated) {
            try {
              await cp.escalate({
                category: 'room-timeout',
                summary: 'Room "' + wait.roomId + '" speaker "' + wait.speaker + '" timed out and the bounded recovery notice could not be delivered.',
                decisionNeeded: 'Check the speaker and host, repair the room, or explicitly stop the round.',
                roomId: wait.roomId,
                roundId: wait.roundId,
                references: [wait.episodeId],
                urgency: 'critical',
              }, root)
            } catch (error) {
              ctx.logger?.warn?.('team-idle-watch room timeout escalation failed for ' + wait.roomId + ': ' + String(error?.message || error))
            }
          }
        }
        continue
      }
      let claimed
      const leadName = membershipName(root, teams)
      const targetName = typeof wait.host === 'string' && wait.host.length > 0 ? wait.host : leadName
      try {
        claimed = await cp.wakeClaim({
          episodeId: attempt.episodeId,
          kind: 'control',
          roomId: wait.roomId,
          sender: 'team-idle-watch-room-timeout',
          target: targetName,
          messageHash: hashControlValue(roomTimeoutReminder(wait, roomSpeakerTimeoutMs)),
        })
      } catch (error) {
        ctx.logger?.warn?.('team-idle-watch room timeout claim failed for ' + wait.roomId + ': ' + String(error?.message || error))
        continue
      }
      if (claimed?.claimed !== true) continue
      try {
        const message = createUserMessage({
          content: [{ type: 'text', text: roomTimeoutReminder(wait, roomSpeakerTimeoutMs) }],
          source: { kind: 'team-message', plugin: name, form: 'notice', summary: 'room speaker timeout' },
        })
        if (targetName !== leadName && typeof teams.sendMessage === 'function') {
          markBackgroundWake(key)
          await teams.sendMessage(root, { target: targetName, content: message.content })
        } else if (typeof root.followup === 'function') {
          markBackgroundWake(key)
          await root.followup(message)
        } else if (typeof root.inject === 'function') {
          markBackgroundWake(key)
          await root.inject(message)
        }
        else throw new Error('room timeout target has no delivery path')
        await cp.wakeAcknowledge({ episodeId: attempt.episodeId, status: 'delivered' })
        ctx.logger?.warn?.('team-idle-watch: room timeout handed to Lead for ' + wait.roomId + '/' + wait.roundId)
      } catch (error) {
        try {
          await cp.wakeAcknowledge({ episodeId: attempt.episodeId, status: 'delivery-failed' })
        } catch (ackError) {
          ctx.logger?.warn?.('team-idle-watch room timeout failure receipt failed for ' + wait.roomId + ': ' + String(ackError?.message || ackError))
        }
        ctx.logger?.warn?.('team-idle-watch room timeout delivery failed for ' + wait.roomId + ': ' + String(error?.message || error))
      }
    }
  }

  const checkRoomClosures = async (teams, root, key) => {
    const cp = durableControl(key)
    if (!isArmed(armed, key) || cp === undefined || root === undefined || root === null || suppressForControlPlane(cp)) return
    const snapshot = cp.view({ history: false })
    const now = Date.now()
    const leadName = membershipName(root, teams)
    let memberRows = []
    try {
      memberRows = typeof teams.listMembers === 'function' ? teams.listMembers(root) : []
    } catch {
      memberRows = []
    }
    const memberByName = new Map(memberRows.map((row) => [String(row?.name ?? ''), row]))
    const usable = (name) => {
      if (typeof name !== 'string' || name.length === 0) return false
      const row = memberByName.get(name)
      return row === undefined || (row.frozen !== true && row.status !== 'failed')
    }
    const deliver = async (target, text, episodeId, attempt) => {
      const claimed = await cp.wakeClaim({
        episodeId,
        kind: 'control',
        roomId: '',
        sender: 'team-idle-watch-room-close',
        target,
        messageHash: hashControlValue(text),
      })
      if (claimed?.claimed !== true) return
      try {
        if (target !== leadName && typeof teams.sendMessage === 'function') {
          markBackgroundWake(key)
          await teams.sendMessage(root, { target, content: [{ type: 'text', text }] })
        } else if (typeof root.followup === 'function') {
          markBackgroundWake(key)
          await root.followup(createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'team-message', plugin: name, form: 'notice', summary: 'room closure required' },
          }))
        } else if (typeof root.inject === 'function') {
          markBackgroundWake(key)
          await root.inject(createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'team-message', plugin: name, form: 'notice', summary: 'room closure required' },
          }))
        } else {
          throw new Error('room close target has no delivery path')
        }
        await cp.wakeAcknowledge({ episodeId, status: 'delivered' })
        ctx.logger?.warn?.('team-idle-watch: room close wake ' + String(attempt) + ' delivered for ' + String(episodeId))
      } catch (error) {
        try { await cp.wakeAcknowledge({ episodeId, status: 'delivery-failed' }) } catch { /* terminal race */ }
        ctx.logger?.warn?.('team-idle-watch room close wake failed for ' + String(episodeId) + ': ' + String(error?.message ?? error))
      }
    }
    for (const wait of timedOutRoomClosures(snapshot, now, roomCloseGraceMs)) {
      const room = snapshot.rooms?.[wait.roomId]
      if (room === undefined || room.currentRoundId !== wait.roundId) continue
      const host = typeof room.host === 'string' ? room.host : ''
      const hostUsable = usable(host)
      const attempt = roomCloseAttempt(snapshot, wait, now, roomCloseMaxAttempts, roomCloseRetryMs)
      if (hostUsable && attempt !== null) {
        await deliver(host, roomCloseReminder(wait, roomCloseGraceMs), attempt.episodeId, attempt.attempt)
        continue
      }
      const retryWindowMs = roomCloseRetryMs * roomCloseMaxAttempts
      if (hostUsable && now - wait.deadlineAt < retryWindowMs) continue

      const replacement = (Array.isArray(room.members) ? room.members : [])
        .map(String)
        .find((member) => member !== host && member !== leadName && usable(member))
      if (replacement !== undefined) {
        const noticeAuthor = room.members.includes(leadName) ? leadName : host
        if (typeof noticeAuthor === 'string' && noticeAuthor.length > 0) {
          try {
            await cp.roomNotice({
              roomId: room.roomId,
              roundId: wait.roundId,
              author: noticeAuthor,
              content: '[room-close-recovery] host=' + host + ' action=replace-host new_host=' + replacement
                + ' deadline_at=' + String(wait.deadlineAt)
                + ' reason=bounded close deadline expired',
              references: [wait.episodeId],
            }, root)
          } catch (error) {
            ctx.logger?.warn?.('team-idle-watch room close replacement notice failed for ' + wait.roomId + ': ' + String(error?.message ?? error))
          }
        }
        try {
          await cp.roomOpen({ roomId: room.roomId, host: replacement, replaceHost: true }, root)
          await deliver(
            replacement,
            'You are the replacement host for an awaiting-close room. Read the room and close it with team_room_close, then stop.',
            wait.episodeId + ':replace:' + replacement,
            'replacement',
          )
        } catch (error) {
          ctx.logger?.warn?.('team-idle-watch room close host replacement failed for ' + wait.roomId + ': ' + String(error?.message ?? error))
        }
        continue
      }

      const noticeAuthor = room.members.includes(leadName) ? leadName : host
      if (typeof noticeAuthor === 'string' && noticeAuthor.length > 0) {
        try {
          await cp.roomNotice({
            roomId: room.roomId,
            roundId: wait.roundId,
            author: noticeAuthor,
            content: '[room-close-recovery] host=' + host + ' action=auto-close'
              + ' deadline_at=' + String(wait.deadlineAt)
              + ' reason=bounded close deadline expired with no usable replacement',
            references: [wait.episodeId],
          }, root)
        } catch (error) {
          ctx.logger?.warn?.('team-idle-watch room close auto-close notice failed for ' + wait.roomId + ': ' + String(error?.message ?? error))
        }
      }
      try {
        await cp.roomClose({
          roomId: room.roomId,
          roundId: wait.roundId,
          summary: 'Recovery closed this round after every participant finished speaking and the host did not close within the bounded grace period.',
          unresolved: [],
        }, root)
        ctx.logger?.warn?.('team-idle-watch: auto-closed awaiting round ' + wait.roomId + '/' + wait.roundId)
      } catch (error) {
        ctx.logger?.warn?.('team-idle-watch room auto-close failed for ' + wait.roomId + ': ' + String(error?.message ?? error))
      }
    }
  }

  const membershipName = (root, teams) => {
    try { return teams.tryMembership(root)?.name ?? 'lead' } catch { return 'lead' }
  }
  const deliverIdle = async (root, message, key) => {
      if (disposed) throw new Error('idle watch disposed before delivery')
      // Waking on purpose: an idle Lead with an empty inbox never reads a quiet inject, and
      // the whole point of this net is the case where nothing else would ever wake it.
      markBackgroundWake(key)
      if (typeof root.followup === 'function') await root.followup(message)
      else if (typeof root.inject === 'function') await root.inject(message)
      else throw new Error('idle target has no delivery path')
      holdForRetry(key, retryAfterMs)
      if (ctx.logger !== undefined) ctx.logger.info?.('team-idle-watch: reminded the Lead of Team ' + key)
  }

  const install = (host, teams) => {
    if (teams === undefined || teams === null) return undefined
    disposed = false
    const installedGeneration = ++generation
    const bootstrapTeams = (agents, scopedTeams) => {
      if (agents === undefined || agents === null || typeof agents.list !== 'function') return
      const seen = new Set()
      const roots = []
      for (const agent of agents.list()) {
        let membership
        try {
          membership = scopedTeams.tryMembership(agent)
        } catch {
          continue
        }
        if (membership === undefined || membership.root === undefined) continue
        const root = membership.root
        const agentIsRoot = agent === root
          || String(agent?.id ?? '') === String(root?.id ?? '')
        if (!agentIsRoot) continue
        const key = teamRootIdCandidates({ agentTeams: scopedTeams }, agent)[0] ?? ''
        if (key.length === 0 || seen.has(key)) continue
        seen.add(key)
        const cp = durableControl(key)
        if (hasRestorableControlState(cp)) continue
        roots.push({
          key,
          status: String(root?.status ?? agent?.status ?? ''),
          updatedAt: Number(root?.updatedAt ?? agent?.updatedAt ?? 0),
        })
      }
      focusBootstrapRoot(armed, roots)
    }
    const scanRoomHealth = (agents, scopedTeams) => {
      if (agents === undefined || agents === null || typeof agents.list !== 'function') return
      bootstrapTeams(agents, scopedTeams)
      const seen = new Set()
      for (const agent of agents.list()) {
        let membership
        try {
          membership = scopedTeams.tryMembership(agent)
        } catch {
          continue
        }
        if (membership === undefined || membership.root === undefined) continue
        const key = teamRootIdCandidates({ agentTeams: scopedTeams }, agent)[0] ?? ''
        if (key.length === 0 || seen.has(key)) continue
        seen.add(key)
        if (!isArmed(armed, key)) continue
        if (membership.root.status === 'running') cancel(key)
        if (episodes.get(key) === undefined) check(scopedTeams, membership.root, key)
        void checkRoomTimeouts(scopedTeams, membership.root, key)
        void checkRoomClosures(scopedTeams, membership.root, key)
      }
    }

    const disposers = []
    disposers.push(host.on('agent/status', ({ agent, status }) => {
      if (agent === undefined || agent === null) return
      let membership
      try {
        membership = teams.tryMembership(agent)
      } catch {
        return
      }
      if (membership === undefined || membership.root === undefined) return
      const key = teamRootIdCandidates({ agentTeams: teams }, agent)[0] ?? ''
      const rootAgent = membership.root
      const agentIsRoot = agent === rootAgent
        || String(agent?.id ?? '') === String(rootAgent?.id ?? '')
      if ((status === 'running' || status === 'provisioning') && agentIsRoot
        && !consumeBackgroundWake(key)) focusRoot(armed, key)
      if (!isArmed(armed, key)) return
      void checkRoomTimeouts(teams, membership.root, key)
      void checkRoomClosures(teams, membership.root, key)
      if (status === 'running') {
        // Cancel the pending timer while work runs. Durable semantic de-dup
        // still distinguishes useful new work from answering this observer.
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
        if (current === undefined || current.timer !== timer) {
          clearInterval(timer)
          return
        }
        if (current.reminded === true) {
          clearInterval(timer)
          episodes.delete(key)
          return
        }
        check(teams, membership.root, key)
      }, scanIntervalMs)
      if (typeof timer.unref === 'function') timer.unref()
      episodes.set(key, { timer, reminded: false })
    }, { global: true }))

    const bootstrapMs = Number.isFinite(cfg.bootstrapScanMs) && cfg.bootstrapScanMs > 0
      ? cfg.bootstrapScanMs
      : 0
    if (bootstrapMs > 0) {
      const bootstrapTimer = setTimeout(() => {
        try {
          const agents = typeof host.get === 'function' ? host.get('agents') : undefined
          bootstrapTeams(agents, teams)
        } catch (error) {
          if (ctx.logger !== undefined) ctx.logger.warn?.('team-idle-watch bootstrap scan: ' + ((error && error.message) || String(error)))
        }
      }, bootstrapMs)
      if (typeof bootstrapTimer.unref === 'function') bootstrapTimer.unref()
      disposers.push(() => clearTimeout(bootstrapTimer))
    }
    const scanTimer = setInterval(() => {
      try {
        const agents = typeof host.get === 'function' ? host.get('agents') : undefined
        scanRoomHealth(agents, teams)
      } catch (error) {
        if (ctx.logger !== undefined) ctx.logger.warn?.('team-idle-watch periodic scan: ' + ((error && error.message) || String(error)))
      }
    }, bootstrapMs > 0 ? bootstrapMs : scanIntervalMs)
    if (typeof scanTimer.unref === 'function') scanTimer.unref()
    disposers.push(() => clearInterval(scanTimer))

    const dispose = () => {
      if (installedGeneration === generation) {
        disposed = true
        generation++
      }
      for (const close of disposers.splice(0)) {
        try { close() } catch { /* already closed */ }
      }
      for (const entry of episodes.values()) {
        if (entry.timer !== undefined) clearInterval(entry.timer)
      }
      episodes.clear()
      return Promise.allSettled([...pending])
    }
    if (typeof host.effect === 'function') host.effect(() => dispose, 'team-idle-watch.scan()')
    return dispose
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['agents', 'agentTeams'], (scoped) => {
      const teams = typeof scoped.get === 'function' ? scoped.get('agentTeams') : undefined
      install(scoped, teams)
    })
    return
  }
  install(ctx, ctx.agentTeams)
}
