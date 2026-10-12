/**
 * HMR activation marker: 2026-09-28T16:10+08:00 perf68-clearance-severity+sync-diagnostics.
 * HMR perf14 marker: 2026-09-26T08:55+08:00 - direct steer for wake/escalation/upward live targets.
 *
 * team-tools-v2 — Agent Team v2 / Phase 3 enforcement
 * Live activity digest: includes regular groups and the independent verifier.
 *
 * Replacement for @deepseek-ai/dsh-experimental-tool-agent-team (547 lines).
 * It keeps the shipped nine tools and their exact value shapes, and adds the
 * tier/group/permission/board/freeze rules of the v2 design. Every rule is a
 * hard refusal executed HERE, before the domain is touched: a denial throws, so
 * the model receives an actionable error instead of a policy paragraph it can
 * forget. The shipped plugin row must be disabled when this one is mounted.
 *
 * Why the domain is not forked: its roster is flat (spawnTeammate creates a
 * direct child of the Lead and its only roles are lead | teammate), and its
 * tier-2 world is modelled by team-policy. Every domain call is still made with
 * a real Agent as the authority credential; the ROOT LEAD identity performs the
 * actual spawn while the requesting lead is recorded as the parent.
 *
 * @module team-tools-v2
 */

console.log('[team-tools-v2-r10] HMR r26-static-policy-membership+perf68-clearance-severity+sync-diagnostics loaded 2026-09-28')

import { defineTool } from '@deepseek-ai/dsh-tools'
import { TeamTaskId } from '@deepseek-ai/dsh-experimental-agent-team'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { activePolicy, policyFor, reconcileRegistry, stripStamp, teamKeyOf } from './team-policy.mjs'
import { canAdvanceTaskPhase, dependencyCycle, hashControlValue, latestClosedRound, normalizeCommitSha, parseTaskDependencyReference, PLAN_REPLACEMENT_RECOVERY, roomActivity, roomDependencyVerdict, shouldMoveTaskPhase, TASK_PHASES, taskPhaseRecoveryActions } from './team-control-plane.mjs'
import { detectScopeConflicts, normalizeContractScope, normalizeTaskContract } from './team-v12-contract.mjs'
import { createTaskQuerySnapshot, projectTaskQueryView, taskQueryFilter } from './team-query-efficiency.mjs'
import { messageOperationIdentity, runMessageOperation } from './team-message-operation.mjs'
import { projectRoomDecisions } from './team-v12-room-wake.mjs'
import { deliveryCheckCoverage } from './team-v15-delivery-service.mjs'
import { requirementCoverageNote } from './team-v15-window-plan.mjs'
import { apply as applyActivityDigest } from './team-activity-digest.mjs'
import { BAND_START, HARD_RATIO, acknowledgeReminder, armMilestoneCompaction, canReadMilestone, createMilestoneDoc, markCompacted, markMilestoneDone, milestoneNotice, milestoneProofVerdict, milestoneScope, normalizeMilestoneDoc, pendingReminder, pruneStaleMilestoneCompactions, reminderText, setMilestone, shouldCompact } from './team-milestone-v2.mjs'
import { BRANCH_MAIN, absoluteWorktreePath, cargoTargetIsolationVerdict, clearanceDigestGate, groupBranch, memberBranch, mergeExact, mergePlan, runGit, setupPlan, sourceSnapshot, withMergeLock, worktreeAdd, worktreePath } from './team-worktree.mjs'
import { measureSessionTokens } from './team-token-meter-cache.mjs'

/** Cordis plugin name. */
export const name = 'tool-agent-team-v2'
/** Services required by the v2 Team tool plugin. */
export const inject = ['agents', 'agentTeams', 'tools', 'systemPrompt', 'subagents']

const POLICY = 'Agent Team v2 is active. Tiers: tier 0 is the session Lead, tier 1 are group leads plus one independent verifier, tier 2 are group members. Constraints are enforced by the runtime, not by this text: a refused call is refused in code.'
  + ' Tier 0 coordinates global and cross-group work; tier-1 group leads schedule their own groups. Neither role implements member-owned product work. Break approved work into scoped tasks with a named owner, supervise, check results, and interrupt only when a member has demonstrably drifted.'
  + ' Dispatch a standing identity with spawn_teammate(role:"lead"|"verifier"|"member") and pass only the task brief — the identity, its duties and its prohibitions come from the role file, so do not restate them. Use role:"custom" only when no standing identity fits, and then write the whole prompt yourself.'
  + ' AFTER DISPATCHING, finish the related actionable batch in this turn: record task owners, dependencies, receipts, and any wait reason, resolving condition and responsible actor. Then end the turn when no approved unblocked work remains. Do not use wait_agent or poll list_agents / team_task_list to watch quiet members. A subordinate report uses send_message(delivery:"info") for quiet progress; use delivery:"action" with a reason when a peer or subordinate must act now, and delivery:"decision" with blocked_action, reason and evidence for a decision by the direct superior. team_wake and team_wake_superior remain compatibility aliases. Completion and dependency release are system events for a continuation service when it is enabled; until then, record responsibility and use the permitted directed action path. Never claim an event was dispatched without a receipt.'
  + ' DELIVER COMPLETE DEPENDENCY BATCHES TO THE VERIFIER. The shared verifier receives an aggregated acceptance packet when that batch is ready; do not wake it per small fix and do not wait for unrelated slower groups. It returns one consolidated findings table for that batch. delivery:"info" remains quiet; delivery:"decision" is for an upward blocked decision, not ordinary completion. Use team_escalate only when a decision is genuinely above your level. A normal escalation requires a CLOSED room round, one unresolved point, evidence references and options (or an explicit no-options reason).'
  + ' ROOMS ARE THE DEFAULT PEER CHANNEL. After every team_room_read, obey its waitAction exactly. waitAction="speak" means post exactly one main speech; waitAction="close" means the host closes the round; waitAction="stop" means END THIS ROOM TURN and wait for the system room handoff. This pauses only the room round; continue independent approved tasks. Never call wait_agent, sleep, poll, re-read, or send progress while a Room turn is pending. The host is always a participant; when the caller does not name the host, the runtime appends it last. A group Room inherits level:1 as its parent whenever that planning room exists, and its rounds are refused until the parent round is closed. A room has a configured round budget: read the value from the tool result and escalate after it is exhausted instead of reopening the same room. Resolve a completed follow-up item with team_room_resolve rather than leaving stale text.'
  + ' TASKS HAVE A DELIVERABLE KIND. discussion and review tasks carry no write scopes and complete with evidence only; edit tasks require write scopes, an approved plan, an owner lease and commit_sha. Claiming an edit task without scopes is refused.'
  + ' STRANDED GLOBAL REFERENCE CARDS HAVE AN EXPLICIT RECOVERY PATH. If a global card is obsolete, has no active owner or lease, and cannot be reassigned or advanced, tier 0 may call team_task_update(action:"admin_close", admin_close_reason:"..."). This writes an audit evidence row and removes the card from the domain and local projection; it does not fabricate delivery.'
  + ' READ CURRENT STATE WHEN NEEDED. team_milestone(action:"list") shows visible member stages and context use; call it for a concrete steering or acceptance decision, not to poll silent members. Dynamic task, decision and wait updates belong in bounded per-turn context, never in the cacheable system prefix.'
  + ' PEERS TALK DIRECTLY. Same-group members, and group leads across groups, may send_message(delivery:"info") to align interfaces and agree on who edits what; when the peer must act now, use send_message(delivery:"action", reason:...). Escalate to your superior only when the decision is genuinely above your level. Peers may also read each other milestones and progress. What peers may NOT do is interrupt each other: interrupt_agent reaches only the members you spawned yourself.'
  + ' WAKE YOUR DIRECT SUPERIOR WHEN A DECISION IS BLOCKED. A tier-2 member may send delivery:"decision" to its own group lead; a tier-1 lead may use it to wake tier 0. It requires the blocked action, reason and evidence, and coalesces while an unhandled wake exists. Use it for an approval, unblock, or privilege review that cannot proceed without that superior; ordinary progress stays quiet. team_wake_superior remains a compatibility alias.'
  + ' INTERRUPTING IS YOUR POWER, AND A MESSAGE IS NOT AN INTERRUPT. A message delivered to a RUNNING member is spliced into its next step: it keeps working on whatever it already had in hand, indefinitely. Telling it to stop in a message stops nothing. When a member has drifted, is editing the wrong file, or is grinding on an approach you already rejected, call interrupt_agent — that is the only thing that ends its current turn. Do NOT interrupt for mere slowness, and do not be shy with it when the work is actually wrong: a measured judgement plus interrupt_agent beats a polite message that changes nothing.'
  + ' BEFORE YOU DECLARE ANYTHING DELIVERED, call team_delivery_check. It lists every task still open and tells you, per task, whether the owner forgot to mark it done or the work genuinely was not finished — chase the first with a status fix and the second with a rework order. Announcing a delivery on the strength of your own impression, while the board still shows open work, is exactly the failure this check exists to stop.'
  + ' A returned wait, quiet roster or empty inbox alone does not prove a stall. Do not interrupt or re-dispatch without a concrete failure, expired responsibility or stale task. A durable Room timeout must name the waiting speaker and recovery owner; take the bounded recovery action, then escalate a proven stall. Timeout and retry facts belong in a message, not a rewritten system prefix.'
  + ' On a wake, handle its related actionable batch and any independent approved unblocked work already assigned to you. Recheck the affected task revision, phase, owner, lease, scope and dependencies before acting. Stop when the batch is done or waits have explicit responsibility; do not scan the whole Team without a concrete reason. Room waitAction="stop" pauses that Room turn, not unrelated work; system handoff wakes the next speaker. An info message never starts a turn.'
const ACTIVE_WAIT_STATUSES = new Set(['running', 'provisioning'])
const NO_ACTIVE_PEER_MESSAGE = 'No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents; use send_message(delivery:"action", reason:...) for an actionable peer or downward wake, otherwise post the decision in the room or escalate it.'
export const SILENT_SEND_WAKE_REMINDER = 'Informational delivery only: this message does not wake or start the target turn. If the target must act now, resend it with delivery:"action"; for a blocked upward decision use delivery:"decision" with blocked_action, reason and evidence.'
export const VERIFIER_ISSUE_SEVERITIES = Object.freeze(['blocker', 'major', 'condition', 'minor', 'nit'])
export const VERIFIER_CLEARANCE_POLICY = 'A report clears exact commits only when its issue table contains no blocker or major; condition, minor, and nit findings do not suppress clearance.'
export const PRIVILEGE_TURN_POLICY = 'Approval activates on the requester next wake and ends with that turn. If approval arrives while the requester is already running, it must not retry the blocked action in that turn; it takes effect only after the current turn ends and the member is woken again.'
const TEAM_PLUGIN_MESSAGE_KIND = 'team-plugin-message'
const TEAM_WAKE_KIND = 'team-wake'
const TEAM_DOC_CACHE_LIMIT = 8
const teamDocCache = new Map()
// A privilege approval is scoped to the requester's turn. Keep the start time
// in memory so an approval received while a turn is already running cannot be
// activated by a second pre-step in that same turn.
const activeTurnStartedAt = new WeakMap()

export function privilegeActivationAllowed(request, turnStartedAt) {
  if (request?.status !== 'approved') return false
  if (turnStartedAt === undefined || turnStartedAt === null) return true
  const approvedAt = Number(request.approvedAt)
  return !Number.isFinite(approvedAt) || approvedAt <= Number(turnStartedAt)
}

/** Receipt status must describe the direct-delivery attempt, not the target's rank. */
export function infoDeliveryReceiptStatus(delivered) {
  return delivered === true ? 'delivered' : 'queued'
}

/**
 * Cache small Team-owned JSON documents by file identity. The files are edited by
 * this plugin and by step-compaction, so every read still stats the path and the
 * cache is invalidated whenever dev/ino/size/mtime/ctime changes.
 */
export function readTeamJsonCached(path) {
  const stats = statSync(path, { bigint: true })
  const signature = [
    String(stats.dev),
    String(stats.ino),
    String(stats.size),
    String(stats.mtimeNs),
    String(stats.ctimeNs),
  ].join(':')
  const cached = teamDocCache.get(path)
  if (cached?.signature === signature) {
    teamDocCache.delete(path)
    teamDocCache.set(path, cached)
    return cached.value
  }
  const value = JSON.parse(readFileSync(path, 'utf8'))
  teamDocCache.delete(path)
  teamDocCache.set(path, { signature, value })
  while (teamDocCache.size > TEAM_DOC_CACHE_LIMIT) {
    teamDocCache.delete(teamDocCache.keys().next().value)
  }
  return value
}

function invalidateTeamJsonCache(path) {
  teamDocCache.delete(path)
}

/** Compact responsibility detail for a waiting room or task. */
export function waitingResponsibility(snapshot, roomId) {
  const room = snapshot?.rooms?.[String(roomId)]
  const round = room?.currentRoundId == null ? undefined : snapshot?.rounds?.[room.currentRoundId]
  if (!room || !round || round.status !== 'open') return { waiting: false, roomId: String(roomId), responsibility: null }
  const speaker = typeof round.nextSpeaker === 'string' ? round.nextSpeaker : null
  return {
    waiting: speaker !== null,
    roomId: String(room.roomId),
    roundId: String(round.roundId),
    speaker,
    host: room.host ?? null,
    responsibility: speaker === null ? 'host-close' : 'speaker-main-turn',
    topic: String(round.topic ?? ''),
  }
}

/** Stable, bounded stall detail suitable for a repair/decision event. */
export function stallDetail(input = {}) {
  const now = Number(input.now ?? Date.now())
  const lastProgressAt = Number(input.lastProgressAt ?? input.lastProgress ?? now)
  const quietMs = Math.max(0, now - lastProgressAt)
  return {
    class: String(input.class ?? (input.waiting ? 'waiting-responsibility' : 'idle-no-progress')),
    quietMs,
    lastProgressAt,
    owner: input.owner ?? null,
    responsibility: input.responsibility ?? null,
    retryCount: Number(input.retryCount ?? 0),
    retryAllowed: input.retryAllowed === true,
    evidence: Array.isArray(input.evidence) ? input.evidence.map(String) : [],
  }
}

/** Payload used by a completion event handoff; no dispatch or wake side effect. */
export function taskCompletionHandoff(task, details = {}) {
  const source = task ?? {}
  return {
    type: 'task/completion-handoff',
    taskId: String(source.id ?? source.taskId ?? ''),
    owner: source.ownerName ?? source.owner ?? null,
    status: String(source.status ?? 'completed'),
    phase: source.phase ?? null,
    commitSha: details.commitSha ?? source.commitSha ?? null,
    evidenceIds: (details.evidenceIds ?? source.evidenceIds ?? []).map(String),
    at: Number(details.at ?? Date.now()),
  }
}

/** Validate the source delivery that one global reference task may reconcile to. */
export function reconcileSourceRequirement(task, taskId = '') {
  const source = task ?? {}
  const commitSha = typeof source.commitSha === 'string' && source.commitSha.trim().length > 0
    ? source.commitSha
    : undefined
  const evidenceIds = Array.isArray(source.evidenceIds)
    ? source.evidenceIds.map(String).filter((value) => value.length > 0)
    : []
  const writeScopes = Array.isArray(source.writeScopes) ? source.writeScopes : []
  const workKind = source.workKind ?? (writeScopes.length > 0 ? 'edit' : 'discussion')
  const label = 'source ' + workKind + ' task' + (taskId.length > 0 ? ' "' + taskId + '"' : '')
  if (evidenceIds.length === 0) {
    return { ok: false, code: 'reconcile-source', reason: label + ' has no evidence_ids' }
  }
  if (workKind === 'edit' && commitSha === undefined) {
    return { ok: false, code: 'reconcile-source', reason: label + ' has no exact commit_sha' }
  }
  return { ok: true, commitSha, evidenceIds, workKind }
}

/**
 * Return true only when every declared scope is entirely outside git's
 * tracked/working-tree product surface. This gives commit_sha:null a
 * satisfiable path for edit cards whose scopes are all ignored, without
 * weakening the check for cards that can produce tracked changes.
 */
export function scopesAreEntirelyIgnored(repoRoot, scopes, runner) {
  const list = Array.isArray(scopes)
    ? scopes.map((scope) => String(scope).trim()).filter((scope) => scope.length > 0)
    : []
  if (typeof repoRoot !== 'string' || repoRoot.trim().length === 0 || list.length === 0) return false
  return list.every((scope) => {
    const normalized = scope.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '')
    const absolute = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/')
    const path = absolute ? relative(repoRoot, scope).replace(/\\/g, '/') : normalized
    if (path.length === 0 || path === '.' || path === '..' || path.startsWith('../')) return false
    const tracked = runGit(repoRoot, ['ls-files', '--', path], runner)
    if (tracked.code !== 0 || tracked.stdout.trim().length > 0) return false
    const changed = runGit(repoRoot, ['diff', '--quiet', '--', path], runner)
    if (changed.code !== 0) return false
    return runGit(repoRoot, ['check-ignore', '-q', '--', path], runner).code === 0
  })
}

/** Select dispatch rows that still block delivery, ignoring stale retry attempts. */
export function activeDispatchBlockers(dispatches = {}, tasks = []) {
  const blockingStates = new Set([
    'queued', 'delivered', 'turn-started', 'first-observation', 'checkpointed',
    'response-recorded', 'delivery-failed', 'run-failed', 'timed-out', 'expired',
  ])
  const taskStatus = new Map(tasks.map((task) => [String(task?.id ?? task?.taskId ?? ''), String(task?.status ?? '')]))
  const latestWakeAttempt = new Map()
  const latestWakeGeneration = new Map()
  for (const row of Object.values(dispatches ?? {})) {
    const match = /^wake:(.*):a(\d+)$/.exec(String(row?.dispatchId ?? ''))
    if (match === null) continue
    const attempt = Number(match[2])
    const current = latestWakeAttempt.get(match[1])
    if (current === undefined || attempt > current) latestWakeAttempt.set(match[1], attempt)
  }
  for (const row of Object.values(dispatches ?? {})) {
    const match = /^wake:(.*):r(\d+)$/.exec(String(row?.dispatchId ?? ''))
    if (match === null) continue
    const generation = Number(match[2])
    const current = latestWakeGeneration.get(match[1])
    if (current === undefined || generation > current) latestWakeGeneration.set(match[1], generation)
  }
  const blockers = []
  for (const row of Object.values(dispatches ?? {})) {
    if (row === null || typeof row !== 'object' || !blockingStates.has(String(row.status))) continue
    if (row.taskId === null || row.taskId === undefined) continue
    if (taskStatus.get(String(row.taskId)) === 'completed') continue
    if (['superseded', 'resolved'].includes(String(row.deadLetter?.status ?? ''))) continue
    const match = /^wake:(.*):a(\d+)$/.exec(String(row.dispatchId ?? ''))
    if (match !== null && Number(match[2]) < Number(latestWakeAttempt.get(match[1]))) continue
    const generation = /^wake:(.*):r(\d+)$/.exec(String(row.dispatchId ?? ''))
    if (generation !== null && Number(generation[2]) < Number(latestWakeGeneration.get(generation[1]))) continue
    blockers.push({ kind: 'dispatch', id: row.dispatchId, status: row.status, target: row.target })
  }
  return blockers
}

const WAKE_DEAD_LETTER_STATES = new Set(['timed-out', 'expired'])
const WAKE_TERMINAL_EPISODE_STATES = new Set([
  'completed', 'delivery-failed', 'run-failed', 'timed-out', 'cancelled', 'expired', 'resolved',
])

/** Distinguish an expired system notification from a failed peer message. */
export function deadLetterKind(row) {
  const dispatchId = String(row?.dispatchId ?? '')
  return /^wake:(?:idle|activity):/.test(dispatchId) ? 'system-notification' : 'peer-message'
}

/** Stable dead-letter view for terminal wake dispatches. */
export function dispatchDeadLetter(row, nowValue = Date.now()) {
  if (row === null || typeof row !== 'object' || row.wakeup !== true) return undefined
  if (!WAKE_DEAD_LETTER_STATES.has(String(row.status))) return undefined
  const metadata = row.deadLetter !== null && typeof row.deadLetter === 'object' ? row.deadLetter : {}
  const createdAt = Number(metadata.createdAt ?? row.resolvedAt ?? row.deadlineAt ?? row.createdAt ?? nowValue)
  return {
    dispatchId: String(row.dispatchId ?? ''),
    sender: String(row.sender ?? ''),
    target: String(row.target ?? ''),
    taskId: row.taskId ?? null,
    roomId: row.roomId ?? null,
    status: String(metadata.status ?? 'open'),
    terminalStatus: String(row.status),
    attempt: Number(row.attempt ?? 0),
    lastError: String(metadata.lastError ?? row.lastError ?? 'dispatch deadline expired'),
    createdAt,
    ageMs: Math.max(0, Number(nowValue) - createdAt),
    suggestedAction: String(metadata.suggestedAction ?? 'retry-new-episode|reassign|block|cancel'),
    deadLetterKind: deadLetterKind(row),
  }
}

/** Return terminal wake rows for sender/root recovery and delivery health. */
export function deadLetterRows(dispatches = {}, options = {}) {
  const nowValue = Number(options.now ?? Date.now())
  const openOnly = options.openOnly === true
  return Object.values(dispatches ?? {})
    .map((row) => dispatchDeadLetter(row, nowValue))
    .filter((row) => row !== undefined && (!openOnly || !['superseded', 'resolved'].includes(row.status)))
    .sort((left, right) => right.createdAt - left.createdAt)
}

/** Count dead letters by their actual referent, never by a mixed total alone. */
export function deadLetterCounts(rows = []) {
  const peerRows = rows.filter((row) => row?.deadLetterKind !== 'system-notification')
  const systemRows = rows.filter((row) => row?.deadLetterKind === 'system-notification')
  return {
    total: rows.length,
    peerMessage: peerRows.length,
    systemNotification: systemRows.length,
    oldestPeerAgeMs: peerRows.reduce((oldest, row) => Math.max(oldest, Number(row?.ageMs ?? 0)), 0),
  }
}

const AUTOMATED_ESCALATION_CATEGORIES = new Set(['wake-dead-letter'])
const TERMINAL_ESCALATION_STATES = new Set(['resolved', 'cancelled'])

/** Project one durable escalation into a bounded, category-aware read row. */
export function escalationViewRow(row) {
  if (row === null || typeof row !== 'object') return undefined
  const category = String(row.category ?? 'blocked')
  return {
    escalationId: String(row.escalationId ?? ''),
    category,
    status: String(row.status ?? 'queued'),
    urgency: String(row.urgency ?? 'normal'),
    target: row.target === null || row.target === undefined ? null : String(row.target),
    summary: String(row.summary ?? ''),
    decisionNeeded: String(row.decisionNeeded ?? ''),
    createdAt: Number(row.createdAt ?? 0),
    ...(row.resolvedAt === null || row.resolvedAt === undefined ? {} : { resolvedAt: Number(row.resolvedAt) }),
    ...(row.dispatchId === null || row.dispatchId === undefined ? {} : { dispatchId: String(row.dispatchId) }),
    ...(row.wakeEpisodeId === null || row.wakeEpisodeId === undefined ? {} : { wakeEpisodeId: String(row.wakeEpisodeId) }),
    automated: AUTOMATED_ESCALATION_CATEGORIES.has(category),
  }
}

/** Filter and summarize escalations without mixing automated notices with decisions. */
export function escalationView({
  rows = [],
  actorTier = 2,
  actorName = '',
  status = 'open',
  category,
  urgency,
  target,
  limit = 100,
} = {}) {
  const permitted = rows
    .map(escalationViewRow)
    .filter((row) => row !== undefined)
    .filter((row) => actorTier === 0 || row.target === actorName)
  const filtered = permitted
    .filter((row) => {
      if (status === undefined || status === 'all') return true
      if (status === 'open') return !TERMINAL_ESCALATION_STATES.has(row.status)
      return row.status === status
    })
    .filter((row) => category === undefined || row.category === category)
    .filter((row) => urgency === undefined || row.urgency === urgency)
    .filter((row) => target === undefined || row.target === target)
    .sort((left, right) => right.createdAt - left.createdAt)
  const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 100))
  const selected = filtered.slice(0, boundedLimit)
  const byCategory = {}
  for (const row of permitted.filter((row) => !TERMINAL_ESCALATION_STATES.has(row.status))) {
    byCategory[row.category] = Number(byCategory[row.category] ?? 0) + 1
  }
  const openRows = permitted.filter((row) => !TERMINAL_ESCALATION_STATES.has(row.status))
  return {
    total: filtered.length,
    returned: selected.length,
    truncated: selected.length < filtered.length,
    openCount: openRows.length,
    humanDecisionCount: openRows.filter((row) => row.automated !== true).length,
    automatedNotificationCount: openRows.filter((row) => row.automated === true).length,
    byCategory,
    escalations: selected,
  }
}

/** Build a retry payload from the original durable dispatch, never a placeholder. */
export function pendingDispatchText(row, fallback = '') {
  const pending = Array.isArray(row?.pendingMessages) ? row.pendingMessages : []
  const text = pending
    .filter((message) => message !== null && typeof message === 'object')
    .filter((message) => !['handled', 'rejected'].includes(String(message.status ?? '')))
    .map((message) => String(message.text ?? '').trim())
    .filter((value) => value.length > 0)
    .join('\n\n')
  return text.length > 0 ? text : String(fallback ?? '')
}

const MEMBER_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    role: { type: 'string', required: true, enum: ['lead', 'teammate'] },
    status: { type: 'string', required: true, enum: ['running', 'idle', 'inactive', 'provisioning', 'failed', 'frozen'] },
    description: { type: 'string' },
    provider: { type: 'string' },
    context: { type: 'string', enum: ['fresh', 'fork'] },
    model: { type: 'string' },
    tier: { type: 'integer' },
    group: { type: 'string' },
    parent: { type: 'string' },
    diagnostics: { type: 'array', required: true, items: { type: 'string' } },
  },
}
const TASK_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    revision: { type: 'integer', required: true },
    subject: { type: 'string', required: true },
    description: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed', 'deleted'] },
    phase: { type: 'string', enum: TASK_PHASES },
    ownerName: { type: 'string' },
    // The control plane deliberately uses null until a task has produced an
    // exact commit. A plain string schema turned that valid state into a
    // runtime tool-output failure (`value.commitSha must be a string`).
    commitSha: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    commitShaRaw: { type: 'string' },
    commitShaIssue: { type: 'string', enum: ['invalid-shape', 'non-commit-sentinel'] },
    evidenceIds: { type: 'array', items: { type: 'string' } },
    blockedBy: { type: 'array', required: true, items: { type: 'string' } },
    dependencyPhase: { type: 'string', enum: ['completed', ...TASK_PHASES] },
    writeScopes: { type: 'array', required: true, items: { type: 'string' } },
    workKind: { type: 'string', enum: ['discussion', 'review', 'edit'] },
    ready: { type: 'boolean', required: true },
    readyReason: { type: 'string' },
    readyReasons: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          code: { type: 'string', required: true },
          detail: { type: 'string', required: true },
          taskId: { type: 'string' },
          member: { type: 'string' },
          taskIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    writeScopeWarnings: { type: 'array', required: true, items: { type: 'string' } },
    board: { type: 'string' },
    branch: { type: 'string' },
    // The control plane leaves this null until a worktree exists; a plain string
    // schema turned that valid state into a tool-output failure
    // (`value.worktreePath must be a string`) and made the whole board unreadable.
    worktreePath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    worktreeBindingWarning: { type: 'string' },
    createdAt: { type: 'integer' },
    contract: { type: 'object', additionalProperties: true },
    contractDigest: { type: 'string' },
    contractRevision: { type: 'integer' },
    requirementRevision: { type: 'integer' },
    contractStale: { type: 'boolean' },
    lifecycle: { type: 'string' },
    integrationState: { type: 'string', enum: ['integrated-pending-terminal', 'completed-not-integrated', 'completed-commit-missing', 'integration-unverified'] },
    integrationMeaning: { type: 'string' },
    lastReopenReason: { type: 'string' },
    lastReopenAt: { type: 'integer' },
    deletionReason: { type: 'string' },
    updatedAt: { type: 'integer' },
    queryView: { type: 'string', enum: ['compact'] },
    completionEvidence: { type: 'boolean' },
    snapshotRevision: { type: 'integer' },
    snapshotId: { type: 'string' },
  },
}
const TASK_VIEW_FIELDS = new Set(Object.keys(TASK_VIEW_SCHEMA.properties))

/**
 * Keep tool output on the declared task schema. Domain rows can carry legacy
 * fields (for example the old `approved` flag); leaking one unknown key makes
 * the entire board fail output validation.
 */
export function taskViewFields(task = {}) {
  return Object.fromEntries(
    Object.entries(task ?? {}).filter(([key]) => TASK_VIEW_FIELDS.has(key)),
  )
}

const TASK_UPDATE_FIELDS = Object.freeze(new Set([
  'task_id', 'expected_revision', 'action', 'phase', 'subject', 'description',
  'goal', 'deliverable', 'blocked_by', 'dependency_phase', 'write_scopes', 'commit_sha', 'evidence_ids',
  'owner', 'force_complete', 'force_complete_reason', 'admin_close_reason', 'delete_reason', 'evidence_mode',
  'bind_fix_reason', 'reopen_reason', 'reason', 'board',
]))

/** Return update fields that the tool does not define, so callers fail closed. */
export function taskUpdateUnknownFields(input = {}) {
  return Object.keys(input).filter((key) => !TASK_UPDATE_FIELDS.has(key))
}

/**
 * A group lead may repair an unplanned scope only when the current owner is
 * inactive and the task has no active lease. This is deliberately narrower
 * than ordinary edit authority: it keeps plan-controlled scopes fail-closed
 * while removing the owner-must-act-first deadlock.
 */
export function taskScopeRecoveryVerdict(input = {}, options = {}) {
  if (String(input.action ?? '') !== 'edit' || input.write_scopes === undefined) {
    return { ok: false, code: 'task-scope-recovery-action', reason: 'scope recovery requires action:"edit" with write_scopes' }
  }
  const actor = options.actor
  const task = options.task
  const boardId = String(options.boardId ?? '')
  const group = String(actor?.group ?? '')
  const scopes = Array.isArray(input.write_scopes) ? input.write_scopes.map(String) : []
  if (Number(actor?.tier) !== 1) {
    return { ok: false, code: 'task-scope-recovery-actor', reason: 'scope recovery is limited to a tier-1 group lead' }
  }
  if (group.length === 0 || boardId !== 'group-' + group) {
    return { ok: false, code: 'task-scope-recovery-board', reason: 'scope recovery is limited to the caller\'s own group board' }
  }
  if (task === undefined) {
    return { ok: false, code: 'task-scope-recovery-task', reason: 'scope recovery requires an existing task projection' }
  }
  if (String(task.ownerName ?? '').trim().length === 0) {
    return { ok: false, code: 'task-scope-recovery-owner', reason: 'scope recovery requires a named task owner' }
  }
  if (options.ownerActive === true) {
    return { ok: false, code: 'task-scope-recovery-owner-active', reason: 'scope recovery is refused while the task owner is running or provisioning' }
  }
  if (options.activeLease === true) {
    return { ok: false, code: 'task-scope-recovery-active-lease', reason: 'scope recovery is refused while the task has an active run lease' }
  }
  if (options.planExists === true) {
    return { ok: false, code: 'task-scope-recovery-plan', reason: 'scope recovery is only for tasks without a plan; replace the plan instead' }
  }
  if (!['pending', 'in_progress'].includes(String(task.status ?? ''))) {
    return { ok: false, code: 'task-scope-recovery-status', reason: 'scope recovery is limited to pending or in-progress tasks' }
  }
  if (scopes.length === 0 || scopes.some((scope) => scope.trim().length === 0)) {
    return { ok: false, code: 'task-scope-recovery-scopes', reason: 'scope recovery requires at least one non-empty write scope' }
  }
  return { ok: true, code: 'task-scope-recovery', reason: 'inactive owner and no active lease permit an unplanned scope repair' }
}

/** Direct task-row scope edits are forbidden unless the narrow recovery verdict applies. */
export function taskEditWriteScopeVerdict(input = {}, options = {}) {
  if (String(input.action ?? '') !== 'edit' || input.write_scopes === undefined) return { ok: true }
  if (options.recovery?.ok === true) return { ok: true, code: 'task-write-scopes-recovery' }
  if (options.recovery?.ok === false) {
    return {
      ok: false,
      code: options.recovery.code,
      reason: options.recovery.reason,
      unappliedFields: ['subject', 'description', 'goal', 'deliverable']
        .filter((key) => input[key] !== undefined),
      atomic: true,
    }
  }
  const unappliedFields = ['subject', 'description', 'goal', 'deliverable']
    .filter((key) => input[key] !== undefined)
  const planExists = options.planExists === true
  return {
    ok: false,
    code: 'task-write-scopes-plan-controlled',
    reason: (planExists
      ? 'write_scopes is controlled by the existing plan'
      : 'write_scopes is controlled by the task contract until a plan exists; No plan exists yet')
      + '; no fields were applied by this call'
      + (unappliedFields.length === 0 ? '' : ' (including ' + unappliedFields.join(', ') + ')')
      + (planExists
        ? '; ' + PLAN_REPLACEMENT_RECOVERY
        : '; call team_plan_propose with the intended write_scopes, then send non-controlled fields in a separate edit'),
    unappliedFields,
    atomic: true,
  }
}

/**
 * Validate dependency references. Unqualified ids stay board-local and are
 * rejected when they only exist elsewhere; `boardId:taskId` explicitly
 * selects another board.
 */
export function crossBoardBlockerVerdict(blockedBy = [], targetBoardId = 'global', boards = {}) {
  const ids = [...new Set((Array.isArray(blockedBy) ? blockedBy : [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean))]
  const target = String(targetBoardId ?? 'global')
  const targetTasks = boards?.[target]?.tasks ?? {}
  const crossBoard = []
  const invalid = []
  for (const id of ids) {
    const parsed = parseTaskDependencyReference(id, target)
    if (parsed?.qualified) {
      if (boards?.[parsed.boardId]?.tasks?.[parsed.taskId] === undefined) {
        invalid.push({
          id,
          boardId: parsed.boardId,
          taskId: parsed.taskId,
          reason: boards?.[parsed.boardId] === undefined ? 'board-not-found' : 'task-not-found',
        })
      }
      continue
    }
    if (Object.prototype.hasOwnProperty.call(targetTasks, id)) continue
    const foundOn = Object.entries(boards ?? {})
      .filter(([boardId, board]) => boardId !== target && board?.tasks?.[id] !== undefined)
      .map(([boardId]) => boardId)
      .sort()
    if (foundOn.length > 0) crossBoard.push({ id, boards: foundOn })
  }
  const details = [
    ...crossBoard.map((row) => row.id + ' exists on ' + row.boards.join(', ')),
    ...invalid.map((row) => row.id + ' is invalid (' + row.reason + ')'),
  ]
  return {
    ok: crossBoard.length === 0 && invalid.length === 0,
    crossBoard,
    invalid,
    detail: details.join('; '),
  }
}

/** Whether a dependency reference explicitly selects another board. */
export function boardQualifiedDependency(reference, defaultBoardId = 'global') {
  return parseTaskDependencyReference(reference, defaultBoardId)?.qualified === true
}

function namedWaitingCondition(condition) {
  if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) return false
  const taskIds = Array.isArray(condition.taskIds)
    ? condition.taskIds
    : Array.isArray(condition.task_ids)
      ? condition.task_ids
      : []
  if (taskIds.some((value) => String(value ?? '').trim().length > 0)) return true
  return ['on', 'object', 'objectId', 'object_id', 'reference', 'commit', 'note', 'roomId', 'room_id', 'requestId', 'request_id']
    .some((field) => String(condition[field] ?? '').trim().length > 0)
}

/**
 * A blocked lease release is allowed only when the task names the external
 * dependency that prevents completion. A bare in-progress task remains
 * fail-closed and must complete or be cancelled explicitly.
 */
export function blockedLeaseReleaseVerdict(task, snapshot = {}) {
  if (task === undefined || task === null) {
    return { ok: false, code: 'lease-release-task-missing', reason: 'the leased task no longer exists' }
  }
  const taskId = String(task.id ?? task.taskId ?? '')
  const blockedBy = Array.isArray(task.blockedBy)
    ? task.blockedBy.map(String).map((value) => value.trim()).filter(Boolean)
    : []
  if (blockedBy.length > 0) {
    return { ok: true, blockedBy, waitingTicketId: null }
  }
  const openTickets = Object.values(snapshot?.v14Waiting?.tickets ?? {}).filter((row) =>
    String(row?.taskId ?? '') === taskId
    && String(row?.status ?? 'open').toLowerCase() === 'open')
  const namedTickets = openTickets.filter((row) => namedWaitingCondition(row?.unblockCondition))
  const ticket = namedTickets[0]
  if (ticket !== undefined) {
    return { ok: true, blockedBy: [], waitingTicketId: String(ticket.ticketId ?? '') || null }
  }
  const taskLabel = taskId.length === 0 ? '(unknown)' : '"' + taskId + '"'
  const missing = 'a non-empty blockedBy list or an open waiting ticket whose unblockCondition names '
    + 'taskIds/on/object/note/reference/commit/requestId'
  return {
    ok: false,
    code: 'lease-release-blocked-unnamed',
    reason: 'status:"blocked" refused for task ' + taskLabel
      + '; task.blockedBy: (none)'
      + '; open waiting tickets for this task: ' + openTickets.length
      + '; named open waiting tickets: ' + namedTickets.length
      + '; unnamed open waiting tickets: ' + (openTickets.length - namedTickets.length)
      + '; missing: ' + missing
      + '; construct blockedBy with team_task_update(action:"set_dependencies", blocked_by:["<task-id>"]), '
      + 'then retry team_run_lease(status:"blocked")',
  }
}

/** A completed run may leave its task open only when a named residual blocker is recorded. */
export function leaseReleaseOrderVerdict(task, status, snapshot = {}) {
  if (String(status ?? 'completed') !== 'completed' || task === undefined || task === null
    || String(task.status ?? '') === 'completed') return { ok: true }
  const blocked = blockedLeaseReleaseVerdict(task, snapshot)
  if (blocked.ok !== true) {
    return {
      ok: false,
      code: 'lease-release-order',
      reason: 'task "' + String(task.id ?? task.taskId ?? '') + '" is still ' + String(task.status ?? 'pending')
        + '; release as completed requires a named external dependency: ' + blocked.reason,
    }
  }
  return {
    ok: true,
    residual: true,
    detail: 'run completed while task remains ' + String(task.status ?? 'pending')
      + '; named dependency keeps the task open',
  }
}

/**
 * A release call must diagnose lease liveness before task completion order.
 * Otherwise an expired explicit run_id is reported as "finish the task first",
 * which reinforces the stale belief that the lease is still active.
 */
export function leaseReleaseStateVerdict(lease, at = Date.now()) {
  if (lease === undefined || lease === null || typeof lease !== 'object') {
    return { ok: false, code: 'lease-not-found', detail: 'unknown run lease' }
  }
  const runId = String(lease.runId ?? lease.leaseId ?? '')
  const member = String(lease.member ?? lease.owner ?? '')
  const status = String(lease.status ?? 'active').toLowerCase()
  const expiresAt = Number(lease.expiresAt)
  const expired = status === 'expired'
    || (status === 'active' && Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Number(at))
  if (expired) {
    const expiredAt = Number.isFinite(expiresAt) && expiresAt > 0
      ? new Date(expiresAt).toISOString()
      : 'an unknown time'
    return {
      ok: false,
      code: 'lease-expired',
      detail: 'run lease "' + runId + '" for "' + member + '" expired at '
        + expiredAt + '; acquire a new approved lease before continuing',
    }
  }
  if (status !== 'active') {
    return {
      ok: false,
      code: 'lease-not-active',
      detail: 'run lease "' + runId + '" for "' + member + '" is ' + status
        + '; only an active lease may be released',
    }
  }
  return { ok: true, code: 'active' }
}

/** Version projection for card consumers when contract and requirements can lag. */
export function taskContractRevisionProjection(contract, requirement) {
  const contractRevision = Number(contract?.contractRevision)
  const requirementRevision = Number(requirement?.revision)
  const hasContractRevision = Number.isSafeInteger(contractRevision) && contractRevision >= 0
  const hasRequirementRevision = Number.isSafeInteger(requirementRevision) && requirementRevision >= 0
  return {
    ...hasContractRevision ? { contractRevision } : {},
    ...hasRequirementRevision ? { requirementRevision } : {},
    contractStale: hasContractRevision && hasRequirementRevision && requirementRevision > contractRevision,
  }
}

/** Reopen must carry a reason in the same mutation that changes the task state. */
export function taskReopenReason(input = {}) {
  if (String(input.action ?? '') !== 'reopen') return { ok: true, reason: '' }
  const reason = String(input.reopen_reason ?? input.reason ?? '').trim()
  return reason.length > 0
    ? { ok: true, reason }
    : { ok: false, code: 'task-reopen-reason', reason: 'reopen requires reopen_reason (reason is accepted as an alias)' }
}

/** A replacement plan changes the plan record, not the task's completed phase. */
export function planProposePhaseVerdict(currentPhase, replaceApproved = false) {
  const current = TASK_PHASES.includes(currentPhase) ? currentPhase : 'draft'
  if (replaceApproved === true && TASK_PHASES.indexOf(current) >= TASK_PHASES.indexOf('plan-approved')) {
    return { action: 'preserve', phase: current }
  }
  return { action: 'advance', phase: 'plan-proposed' }
}

/** Approval of a replacement must not roll a post-approval task back. */
export function planApprovePhaseVerdict(currentPhase) {
  const current = TASK_PHASES.includes(currentPhase) ? currentPhase : 'draft'
  return TASK_PHASES.indexOf(current) < TASK_PHASES.indexOf('plan-approved')
    ? { action: 'advance', phase: 'plan-approved' }
    : { action: 'preserve', phase: current }
}

/** Member-to-group merges bind to the completed task's exact commit. */
export function memberMergeSourceVerdict({
  destination,
  task,
  sourceSha,
  sourceDescendsFromTask,
  allowSourceAncestor = false,
  sourceSelection,
  privilege,
  target,
} = {}) {
  const destinationBranch = String(destination ?? '')
  const explicitSelection = sourceSelection !== undefined
    && sourceSelection !== null
    && String(sourceSelection).trim().length > 0
  const selection = String(sourceSelection ?? (destinationBranch === BRANCH_MAIN ? 'branch_head' : 'commit_sha')).trim()
  if (!['commit_sha', 'branch_head'].includes(selection)) {
    return {
      ok: false,
      code: 'member-merge-source-selection-invalid',
      reason: 'team_merge source must be "commit_sha" or "branch_head"; found "' + selection + '"',
    }
  }
  if (destinationBranch === BRANCH_MAIN && !explicitSelection) return { ok: true }
  const expected = String(task?.commitSha ?? '').trim()
  const actual = String(sourceSha ?? '').trim()
  if (selection === 'branch_head') {
    if (expected.length === 0 && !explicitSelection) {
      return {
        ok: true,
        expected: actual,
        sourceHead: actual,
      }
    }
    if (expected.length === 0) {
      return {
        ok: false,
        code: 'member-merge-task-commit-missing',
        reason: 'source:"branch_head" still requires the completed task commit_sha so the branch tip can be proven to contain the authorized work',
      }
    }
    if (!/^[0-9a-f]{40}$/.test(expected)) {
      return {
        ok: false,
        code: 'member-merge-task-commit-invalid',
        reason: 'team_merge requires one exact 40-character task commit_sha; found "' + expected + '"',
      }
    }
    if (actual !== expected && sourceDescendsFromTask !== true) {
      return {
        ok: false,
        code: 'member-merge-branch-head-not-descendant',
        reason: 'source branch tip ' + actual + ' does not descend from task commit_sha ' + expected
          + '; branch_head cannot merge unrelated history',
      }
    }
    return {
      ok: true,
      expected: actual,
      sourceHead: actual,
      ...(explicitSelection ? { selection, taskCommit: expected, mergeSource: actual } : {}),
      ...(actual === expected ? {} : { sourceDescendsFromTask: true }),
    }
  }
  if (destinationBranch === BRANCH_MAIN && expected.length === 0) {
    if (/^[0-9a-f]{40}$/.test(actual)
      && privilegeAllowsToolCall(privilege, {
        tool: 'team_merge',
        taskId: task?.taskId ?? task?.id,
        target,
      })) {
      return {
        ok: true,
        expected: actual,
        sourceHead: actual,
        ...(explicitSelection ? { selection, taskCommit: null, mergeSource: actual } : {}),
        privilegeBypass: 'member-merge-task-commit-missing',
      }
    }
    return {
      ok: false,
      code: 'member-merge-task-commit-missing',
      reason: 'source:"commit_sha" requires the completed task commit_sha; complete or bind the task before merging',
    }
  }
  if (expected.length === 0) {
    if (/^[0-9a-f]{40}$/.test(actual)
      && privilegeAllowsToolCall(privilege, {
        tool: 'team_merge',
        taskId: task?.taskId ?? task?.id,
        target,
      })) {
      return {
        ok: true,
        expected: actual,
        sourceHead: actual,
        ...(explicitSelection ? { selection, taskCommit: null, mergeSource: actual } : {}),
        privilegeBypass: 'member-merge-task-commit-missing',
      }
    }
    return {
      ok: false,
      code: 'member-merge-task-commit-missing',
      reason: 'member-to-group merge requires the completed task commit_sha; complete or bind the task before merging',
    }
  }
  if (!/^[0-9a-f]{40}$/.test(expected)) {
    return {
      ok: false,
      code: 'member-merge-task-commit-invalid',
      reason: 'member-to-group merge requires one exact 40-character task commit_sha; found "' + expected + '"',
    }
  }
  if (actual !== expected && (sourceDescendsFromTask !== true || allowSourceAncestor !== true)) {
    return {
      ok: false,
      code: 'member-merge-source-drift',
      reason: 'member branch tip ' + actual + ' does not match task commit_sha ' + expected
        + '; merge the cleared task commit instead of a later branch tip',
    }
  }
  return {
    ok: true,
    expected,
    sourceHead: actual,
    ...(explicitSelection ? { selection, taskCommit: expected, mergeSource: expected } : {}),
    ...(actual === expected ? {} : { sourceDescendsFromTask: true }),
  }
}

/** A true member fast-forward already carries main; refreshing it would create a wrapper merge. */
export function memberMergeDestinationBase({ sourceContainsMain, destinationHeadIsAncestor } = {}) {
  return sourceContainsMain === true && destinationHeadIsAncestor === true
    ? undefined
    : BRANCH_MAIN
}

/** A global-board owner must be able to perform the board mutations lifecycle requires. */
export function taskOwnerBoardWriteVerdict(owner, boardId) {
  if (String(boardId ?? '') !== 'global') return { ok: true, code: 'non-global-board' }
  if (owner === undefined || owner === null) return { ok: true, code: 'unassigned' }
  if (Number(owner.tier) === 0) return { ok: true, code: 'tier-0-owner' }
  return {
    ok: false,
    code: 'task-owner-board-write',
    reason: 'global-board tasks must be owned by tier 0; "' + String(owner.name ?? '')
      + '" is tier ' + String(owner.tier ?? 'unknown') + ' and cannot claim or complete a global card',
  }
}

/**
 * A target's status is not a delivery gate. The Agent Team service explicitly
 * starts or resumes an inactive target, so treating `inactive` as unreachable
 * would disable the documented cold-start path and convert a healthy mailbox
 * into a permanent delivery failure.
 */
export function deliveryTargetVerdict({ target, status, liveAgent } = {}) {
  const name = String(target ?? '').trim()
  if (name.length === 0) {
    return { ok: false, code: 'target-required', target: name, status: String(status ?? '').toLowerCase() }
  }
  return {
    ok: true,
    code: 'cold-resumable',
    target: name,
    status: String(status ?? '').toLowerCase(),
    live: liveAgent !== undefined,
  }
}

/** Only tier 0 may retire a timed-out dead letter into the explicit expired state. */
export function dispatchRetireVerdict({ actorTier, currentStatus, nextStatus } = {}) {
  const from = String(currentStatus ?? '')
  const to = String(nextStatus ?? '')
  if (from !== 'timed-out' || to !== 'expired') return { ok: true, code: 'not-retirement' }
  if (Number(actorTier) === 0) return { ok: true, code: 'tier-0-retirement' }
  return {
    ok: false,
    code: 'dispatch-retire-scope',
    detail: 'only tier 0 may retire a timed-out dispatch as expired',
  }
}

/** A plan may not persist a scope that the claim gate would immediately reject. */
export function planScopeConflictVerdict(tasks, candidate, options = {}) {
  const conflicts = detectScopeConflicts(tasks, candidate, options)
  if (conflicts.length === 0) return { ok: true, code: 'clear', conflicts: [] }
  // A plan is an intent record and does not write product files. The same owner
  // may propose a later card against the same scope while its current card is
  // active; the execution lease/claim gate remains the fail-closed boundary.
  if (options.allowSameOwner !== false
    && conflicts.every((conflict) => conflict.sameOwner === true)) {
    return { ok: true, code: 'same-owner-plan', conflicts }
  }
  const next = normalizeTaskContract(candidate)
  const nextId = String(next.taskId ?? next.id ?? '')
  const previousRow = (Array.isArray(tasks) ? tasks : Object.values(tasks ?? {}))
    .find((task) => String(task?.id ?? task?.taskId ?? '') === nextId)
  if (previousRow !== undefined) {
    const previous = normalizeTaskContract(previousRow)
    const within = (inner, outer) => inner === outer || inner.startsWith(outer + '/')
    const previousScopes = [...new Set(previous.writeScopes.map(normalizeContractScope).filter(Boolean))]
    const nextScopes = [...new Set(next.writeScopes.map(normalizeContractScope).filter(Boolean))]
    const allNarrower = nextScopes.length > 0 && nextScopes.every((scope) =>
      previousScopes.some((previousScope) => within(scope, previousScope)))
    const strictlyChanged = nextScopes.some((scope) =>
      !previousScopes.some((previousScope) => within(previousScope, scope)))
    if (allNarrower && strictlyChanged) {
      return { ok: true, code: 'narrowed-scope', conflicts }
    }
  }
  return { ok: false, code: 'scope-conflict', conflicts }
}

/**
 * Match an active one-turn privilege to the exact tool/task/target it was
 * requested for. The privilege text is intentionally human-readable, so only
 * stable identifiers are parsed here.
 */
export function privilegeAllowsToolCall(privilege, { tool, taskId, target } = {}) {
  if (privilege === null || typeof privilege !== 'object') return false
  if (String(privilege.status ?? 'active') !== 'active') return false
  const action = String(privilege.blockedAction ?? '').trim()
  const wantedTool = String(tool ?? '').trim()
  const wantedTask = String(taskId ?? '').trim()
  const privilegedTask = String(privilege.taskId ?? '').trim()
  if (wantedTool.length === 0 || !action.includes(wantedTool)) return false
  if (wantedTask.length > 0 && privilegedTask !== wantedTask) return false
  const targetMatch = /target\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9._-]+))/.exec(action)
  const privilegedTarget = targetMatch?.[1] ?? targetMatch?.[2] ?? targetMatch?.[3] ?? null
  return privilegedTarget === null || privilegedTarget === String(target ?? '')
}

/**
 * The three pre-written identities plus the escape hatch. A built-in role means
 * the Lead supplies only a short brief: the standing identity, the do's and the
 * don'ts live in a file the operator can edit, so a spawn costs a paragraph
 * instead of a re-invented persona every time.
 */
const ROLE_FALLBACK = {
  lead: 'You are a GROUP LEAD. Your output is dispatched tasks and checked results, never code. Break the goal into accepted tasks on your own group board, staff every one of them with a member, supervise, and interrupt a member the moment it drifts. Do not implement product code yourself.',
  verifier: 'You are the INDEPENDENT VERIFIER. Your only job is to find problems; assume nothing is impeccable. Reproduce everything yourself and never trust a self-test. Report each issue with severity, location, reproduction, expected vs actual, and evidence, then send it to the owning lead and re-verify after the fix. Never write product code.',
  member: 'You are a MEMBER at tier 2. Do exactly the one task your lead assigned, inside its declared write scope, following docs/INTERFACES.md. Claim it, verify it yourself, then report files, commands, and numbers back to your lead. Do not widen scope, do not edit other modules, and do not spawn anyone.',
}

/**
 * Read one standing identity. Falls back to the embedded text so the roles keep
 * working when the operator has not created the files yet.
 */
function readRole(role, dir) {
  if (role === 'custom') return undefined
  try {
    const text = readFileSync(join(dir, role + '.md'), 'utf8').trim()
    if (text.length > 0) return text
  } catch {
    // fall through to the embedded identity
  }
  return ROLE_FALLBACK[role]
}

/** One canonical output schema with compact model-facing JSON. */
/**
 * The milestone document, read lazily from disk.
 * A milestone is the agent's own semantic boundary: it is what makes a compaction land
 * on a task edge instead of midway through one. It lives in its own file because it is
 * small, private progress state — not authority — so it needs no journal and cannot
 * become a second source of truth for anything that gates a permission.
 */
let MILESTONE_DOC
let MILESTONE_PATH

/** Re-read by file signature so step-compaction's file writes cannot be overwritten. */
function milestones(path) {
  MILESTONE_PATH = path
  try {
    const parsed = readTeamJsonCached(path)
    MILESTONE_DOC = normalizeMilestoneDoc(parsed)
  } catch {
    MILESTONE_DOC = createMilestoneDoc()
  }
  return MILESTONE_DOC
}

/** Persist the exact document supplied by the caller, never a stale process cache. */
function saveMilestones(path, doc = MILESTONE_DOC) {
  if (doc === undefined) throw new Error('milestone document is unavailable')
  mkdirSync(dirname(path), { recursive: true })
  const payload = JSON.stringify(doc, null, 1)
  writeFileSync(path, payload, 'utf8')
  invalidateTeamJsonCache(path)
  const persisted = JSON.parse(readFileSync(path, 'utf8'))
  if (JSON.stringify(persisted) !== JSON.stringify(doc)) {
    throw new Error('milestone persistence verification failed: the durable document does not match the write')
  }
  return persisted
}

/**
 * Resolve a service lazily instead of reading ctx.<name> directly.
 * Reading an undeclared property off the cordis context THROWS at runtime
 * ("cannot get property X without inject"), which is how a missing inject silently broke
 * every turn in a live session while the boot log stayed clean. ctx.get() queries instead,
 * and a missing service degrades to 'no measurement' rather than a failed turn.
 */
function serviceOf(ctx, name) {
  if (ctx === undefined || ctx === null) return undefined
  if (typeof ctx.get === 'function') {
    try { return ctx.get(name) } catch { return undefined }
  }
  return undefined
}

/**
 * The live agent behind one model-facing member name, or undefined.
 *
 * The lookup MUST be scoped to one exact Team root. Every session's root is
 * named "lead", and group leads/members reuse names across Teams, so matching
 * on the name alone returned whichever Team happened to be enumerated first.
 * That is how one Team's "[team context]" notice was delivered into an
 * unrelated session. A missing root therefore resolves to nothing: refusing to
 * deliver is safe, guessing a recipient is not.
 * @param ctx - plugin context carrying the agent registry and Team service.
 * @param name - the member name to resolve.
 * @param root - the exact live Team root the member must belong to.
 */
function liveAgent(ctx, name, root) {
  if (root === undefined || root === null) return undefined
  try {
    for (const peer of ctx.agents.list()) {
      const other = ctx.agentTeams.tryMembership(peer)
      if (other === undefined || other.name !== name) continue
      if (other.root === undefined || other.root.id !== root.id) continue
      return peer
    }
  } catch {
    /* No live roster: nothing to deliver to. */
  }
  return undefined
}

/**
 * Hand one message to an agent WITHOUT waking it.
 * agent.inject() is send(input, 'next-step', false): the message joins the inbox and is
 * read at the agent's next step, so a progress note never interrupts work in flight.
 */
function deliverPluginMessage(ctx, target, text, source) {
  if (target === undefined) return false
  try {
    target.inject(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: TEAM_PLUGIN_MESSAGE_KIND, plugin: name, ...source },
    }))
    return true
  } catch (error) {
    if (ctx.logger !== undefined) {
      ctx.logger.warn?.('team reminder delivery failed: ' + ((error && error.message) || String(error)))
    }
    return false
  }
}

/** Build one durable milestone snapshot for the current request tail. */
function milestoneSnapshotMessage(record) {
  const text = milestoneNotice(record)
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'team-message',
      plugin: name,
      form: 'snapshot',
      sections: [{ name: 'team:milestone', text }],
    },
  })
}
/**
 * Quiet-message batching for the Team Lead.
 *
 * Subagent settlement notices are generated one child at a time, and Team
 * send_message notices are generated one dispatch at a time. They enter the
 * Lead's inbox as separate messages, so the first model step can observe only
 * the prefix that arrived before its claim. The Team pre-step hook rewrites an
 * adjacent quiet batch into one model-visible message while leaving every
 * original message in the durable session log. Control deliveries and user
 * input are deliberately excluded: they retain their immediate semantics.
 */
const QUIET_BATCH_MAX_MESSAGES = 64

function quietBatchMember(message) {
  const source = message?.source
  if (source?.kind === 'subagent-settled') return true
  if ((source?.kind === 'team-message' || source?.kind === TEAM_PLUGIN_MESSAGE_KIND) && source.plugin === name && source.form === 'notice') return true
  return false
}

function quietBatchText(messages) {
  const lines = ['[team batch] ' + messages.length + ' quiet Team messages arrived together.']
  for (let index = 0; index < messages.length; index += 1) {
    const text = (messages[index].content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    lines.push('', '--- message ' + (index + 1) + ' ---', text)
  }
  return lines.join('\n')
}

function collapseQuietBatch(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return undefined
  const quiet = messages.filter(quietBatchMember)
  if (quiet.length < 2 || quiet.length > QUIET_BATCH_MAX_MESSAGES) return undefined
  const firstIndex = messages.indexOf(quiet[0])
  const selected = new Set(quiet)
  const kept = messages.filter((message) => !selected.has(message))
  const batch = createUserMessage({
    content: [{ type: 'text', text: quietBatchText(quiet) }],
    source: { kind: 'team-message', plugin: name, form: 'notice', summary: 'team quiet batch' },
  })
  kept.splice(Math.min(firstIndex, kept.length), 0, batch)
  return kept
}

/** Append one quiet notice without waking an idle member. */
function deliverNotice(ctx, target, text) {
  return deliverPluginMessage(ctx, target, text, {
    form: 'notice',
    summary: text.slice(0, 120),
  })
}
/**
 * Deliver a threshold reminder to the member, and a quiet copy to its superior.
 * Both go as MESSAGES: putting either in the system prompt would change the cache prefix
 * and make every earlier turn miss. Message text never reaches the prompt prefix.
 * @param ctx - plugin context.
 * @param agent - the member that crossed the threshold.
 * @param name - that member's model-facing name.
 * @param me - that member's registry record, when it has one.
 * @param due - the pending reminder: band and ratio.
 * @param tokens - the member's current context size.
 * @param windowSize - the configured window the ratio is measured against.
 * @param doc - the milestone document.
 * @param root - the exact live Team root that owns this member.
 */
function deliverThreshold(ctx, agent, name, me, due, tokens, windowSize, scope, root) {
  deliverNotice(ctx, agent, reminderText(due, tokens, windowSize))
  const measuredAt = new Date().toISOString()
  const parentName = me === undefined ? undefined : me.parent
  if (typeof parentName !== 'string' || parentName.length === 0) return
  const parent = liveAgent(ctx, parentName, root)
  if (parent === undefined || parent === agent) return
  const declared = scope.members[name]
  const where = me === undefined ? '' : ' (tier ' + me.tier + ', group ' + me.group + ')'
  const state = declared === undefined
    ? 'has not declared a milestone yet'
    : 'milestone "' + declared.stage + '" (done when: ' + declared.doneWhen + ')'
      + (declared.done === true ? ', TICKED' : ', not ticked yet')
  deliverNotice(ctx, parent, '[team context] ' + name + where + ' is at '
    + Math.round(due.ratio * 100) + '% of its context (contextPct@' + measuredAt + ') and ' + state
    + '. Its context is approaching the point where a fold would be cheaper than continuing;'
    + ' consider whether its milestone is set where it will finish before that.')
}

/** The verifier clearance recorded against one exact commit, if any. */
function readClearance(config, commit) {
  if (typeof config.clearanceFile !== 'string' || config.clearanceFile.length === 0) return undefined
  try {
    const doc = readTeamJsonCached(config.clearanceFile)
    const entry = doc === null || typeof doc !== 'object' ? undefined : doc[commit]
    return entry === null || typeof entry !== 'object' ? undefined : entry
  } catch {
    return undefined
  }
}

/** Full, actionable diagnostic for a rejected main-branch clearance lookup. */
function clearanceDiagnostic(config, commit) {
  const expectedCommit = String(commit ?? '')
  const result = {
    expectedCommit,
    foundKey: null,
    record: null,
    recordKeys: [],
  }
  if (typeof config.clearanceFile !== 'string' || config.clearanceFile.length === 0) return result
  try {
    const doc = readTeamJsonCached(config.clearanceFile)
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return result
    const direct = doc[expectedCommit]
    if (direct !== null && typeof direct === 'object' && !Array.isArray(direct)) {
      result.foundKey = expectedCommit
      result.record = direct
      return result
    }
    const matching = Object.entries(doc)
      .find(([, record]) => record !== null && typeof record === 'object' && record.commit === expectedCommit)
    if (matching !== undefined) {
      result.foundKey = matching[0]
      result.record = matching[1]
    }
    result.recordKeys = Object.keys(doc)
  } catch {}
  return result
}

/** Return every commit a verifier report explicitly clears, without duplicates. */
export function clearanceCommitsForReport({ commit, clearedCommits, cleared_commits } = {}) {
  return [...new Set([
    commit,
    ...(Array.isArray(clearedCommits) ? clearedCommits : []),
    ...(Array.isArray(cleared_commits) ? cleared_commits : []),
  ].map((value) => String(value ?? '').trim()).filter(Boolean))]
}

/** A report may clear exact commits only when its issue table has no blocker/major. */
export function reportClearanceVerdict(input = {}) {
  const issues = Array.isArray(input.issues) ? input.issues : []
  const blocking = issues.find((issue) => ['blocker', 'major'].includes(String(issue?.severity ?? '')))
  return {
    ok: blocking === undefined,
    commits: blocking === undefined ? clearanceCommitsForReport(input) : [],
    blockingSeverity: blocking?.severity ?? null,
  }
}

/**
 * Validate one clearance key before it is persisted. A verifier report must
 * never create a syntactically plausible key that does not name a commit.
 */
export function clearanceCommitVerdict(commit, repo, runner) {
  const expectedCommit = String(commit ?? '').trim()
  if (!/^[0-9a-f]{40}$/.test(expectedCommit)) {
    return {
      ok: false,
      code: 'invalid-clearance-commit',
      expectedCommit,
      actualKey: expectedCommit,
      detail: 'expected one 40-character lowercase hexadecimal commit id',
    }
  }
  if (typeof repo !== 'string' || repo.trim().length === 0) {
    return {
      ok: false,
      code: 'clearance-repo-missing',
      expectedCommit,
      actualKey: expectedCommit,
      detail: 'no repository root was available for commit validation',
    }
  }
  const type = runGit(repo, ['cat-file', '-t', expectedCommit], runner)
  if (type.code !== 0 || type.stdout.trim() !== 'commit') {
    return {
      ok: false,
      code: 'invalid-clearance-commit',
      expectedCommit,
      actualKey: expectedCommit,
      detail: type.code === 0
        ? 'object type is "' + type.stdout.trim() + '", expected commit'
        : 'git cat-file could not resolve the commit: ' + String(type.stderr || type.stdout || '').trim(),
    }
  }
  const resolved = runGit(repo, ['rev-parse', '--verify', expectedCommit + '^{commit}'], runner)
  if (resolved.code !== 0 || resolved.stdout.trim() !== expectedCommit) {
    return {
      ok: false,
      code: 'invalid-clearance-commit',
      expectedCommit,
      actualKey: expectedCommit,
      detail: 'git rev-parse did not resolve the exact commit id',
      resolvedCommit: resolved.code === 0 ? resolved.stdout.trim() : null,
    }
  }
  return { ok: true, commit: expectedCommit, resolvedCommit: resolved.stdout.trim() }
}

/** Expand a caller-supplied task commit to one exact commit object id. */
export function taskCommitShaVerdict(value, repo, runner) {
  const raw = String(value ?? '').trim()
  if (raw.length === 0) return { ok: true, commit: null, raw: null }
  if (!/^[0-9a-f]{7,40}$/i.test(raw)) {
    return {
      ok: false,
      code: 'invalid-task-commit',
      raw,
      detail: 'expected 7 to 40 hexadecimal characters that resolve to one commit',
    }
  }
  if (/^[0-9a-f]{40}$/i.test(raw)) {
    return { ok: true, commit: raw.toLowerCase(), raw }
  }
  if (typeof repo !== 'string' || repo.trim().length === 0) {
    return {
      ok: false,
      code: 'task-commit-repo-missing',
      raw,
      detail: 'no repository root was available for commit validation',
    }
  }
  const resolved = runGit(repo, ['rev-parse', '--verify', raw + '^{commit}'], runner)
  const commit = resolved.stdout.trim()
  if (resolved.code !== 0 || !/^[0-9a-f]{40}$/.test(commit)) {
    return {
      ok: false,
      code: 'invalid-task-commit',
      raw,
      detail: 'git rev-parse could not resolve the exact commit: '
        + String(resolved.stderr || resolved.stdout || '').trim(),
    }
  }
  return { ok: true, commit, raw }
}

/** Normalize an update commit without mutating the tool's frozen argument object. */
export function taskCommitShaUpdateVerdict(value, repo, runner) {
  if (value === undefined || value === null) return { ok: true, commitSha: value }
  const verdict = taskCommitShaVerdict(value, repo, runner)
  if (verdict.ok !== true) {
    return {
      ok: false,
      code: verdict.code,
      detail: verdict.detail ?? verdict.code,
    }
  }
  return { ok: true, commitSha: verdict.commit }
}

/** Read the current main ancestry once so a board page does not spawn one Git process per task. */
export function mainAncestorSet(repo, runner) {
  if (typeof repo !== 'string' || repo.trim().length === 0) return null
  const result = runGit(repo, ['rev-list', BRANCH_MAIN], runner)
  if (result.code !== 0) return null
  return new Set(result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))
}

/** Classify completed work by whether its commit is already in main. */
export function taskIntegrationVerdict(task, repo, runner, mainAncestors) {
  if (String(task?.status ?? '').toLowerCase() !== 'completed') {
    return { ok: true, state: null, commit: null }
  }
  const scoped = Array.isArray(task?.writeScopes) && task.writeScopes.length > 0
  if (task?.workKind !== 'edit' && !scoped) {
    return { ok: true, state: null, commit: null }
  }
  const commit = normalizeCommitSha(task?.commitSha)
  if (commit.value === null) {
    return {
      ok: false,
      code: 'completed-commit-missing',
      state: 'completed-commit-missing',
      commit: null,
      raw: commit.raw,
      issue: commit.issue,
    }
  }
  if (typeof repo !== 'string' || repo.trim().length === 0) {
    return {
      ok: false,
      code: 'integration-repo-missing',
      state: 'integration-unverified',
      commit: commit.value,
    }
  }
  const integrated = mainAncestors instanceof Set
    ? mainAncestors.has(commit.value)
    : runGit(repo, ['merge-base', '--is-ancestor', commit.value, BRANCH_MAIN], runner).code === 0
  return {
    ok: true,
    state: integrated ? 'integrated-pending-terminal' : 'completed-not-integrated',
    commit: commit.value,
  }
}

function changedPathsForRange(repo, from, to, runner) {
  const diff = runGit(repo, ['diff', '--name-only', '--no-renames', from, to], runner)
  if (diff.code !== 0) return null
  return [...new Set(diff.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))]
}

function normalizedRepoPath(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '')
}

/** A group-acceptance packet must name the exact integration object it reviews. */
export function acceptanceCommitVerdict({ commitSha, groupTip } = {}) {
  const commit = String(commitSha ?? '').trim()
  const tip = String(groupTip ?? '').trim()
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    return { ok: false, code: 'packet-commit-invalid', detail: 'commit_sha must be one exact 40-character commit' }
  }
  if (!/^[0-9a-f]{40}$/.test(tip)) {
    return { ok: false, code: 'packet-group-tip-invalid', detail: 'the target group branch tip could not be resolved' }
  }
  if (commit !== tip) {
    return {
      ok: false,
      code: 'packet-commit-not-group-tip',
      detail: 'group acceptance must name the current group branch tip; expected ' + tip + ', found ' + commit,
      expected: tip,
      actual: commit,
    }
  }
  return { ok: true, code: 'group-tip', commit }
}

function verifierFindingText(value) {
  if (typeof value === 'string') return value.trim()
  if (value === null || value === undefined) return ''
  if (typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['blocker', 'condition', 'reason', 'detail', 'title', 'summary', 'message']) {
      const text = verifierFindingText(value[key])
      if (text.length > 0) return text
    }
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Verifier-review packets carry actionable conditions and blockers in addition
 * to their aggregate verdict. Tier 0 owns the criteria that can be wrong, so
 * these findings must not remain visible only to group leads.
 */
export function verifierReviewEscalations({ checks, blockers } = {}) {
  const findings = []
  for (const [index, check] of (Array.isArray(checks) ? checks : []).entries()) {
    if (check === null || typeof check !== 'object' || Array.isArray(check)) continue
    const text = verifierFindingText(check.condition)
    if (text.length === 0) continue
    findings.push({
      severity: 'condition',
      text,
      source: 'checks[' + String(index) + '].condition',
      location: verifierFindingText(check.location ?? check.name ?? ''),
    })
  }
  for (const [index, blocker] of (Array.isArray(blockers) ? blockers : []).entries()) {
    const text = verifierFindingText(blocker)
    if (text.length === 0) continue
    findings.push({
      severity: 'blocker',
      text,
      source: 'blockers[' + String(index) + ']',
      location: blocker !== null && typeof blocker === 'object' && !Array.isArray(blocker)
        ? verifierFindingText(blocker.location ?? blocker.taskId ?? blocker.task_id ?? '')
        : '',
    })
  }
  const seen = new Set()
  return findings.filter((finding) => {
    const key = finding.severity + '\u0000' + finding.text
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Inspect current surface references without deriving the entire message history. */
export function hasCurrentMilestoneSnapshot(session, record, pending = []) {
  if (record === undefined) return false
  const expected = milestoneNotice(record)
  const matches = (message) => {
    const source = message?.source
    return message?.role === 'user' && source?.kind === 'team-message'
      && source.plugin === name && source.form === 'snapshot'
      && Array.isArray(source.sections) && source.sections.length === 1
      && source.sections[0]?.name === 'team:milestone' && source.sections[0].text === expected
      && Array.isArray(message.content) && message.content.length === 1
      && message.content[0]?.type === 'text' && message.content[0].text === expected
  }
  if (pending.some(matches)) return true
  try {
    const nodes = session?.surface?.nodes
    if (nodes !== undefined && nodes !== null && typeof session.eventAt === 'function') {
      for (const seq of nodes) {
        const event = session.eventAt(seq)
        if (event?.type === 'user/message' && matches(event.data?.message ?? event.data)) return true
      }
      return false
    }
    return (session?.deriveMessages?.() ?? []).some(matches)
  } catch {
    return false
  }
}

/**
 * `ready=false` must be actionable. Preserve the scheduler's raw reasons but
 * attach the holder named by a scope conflict so readers do not have to infer
 * it by comparing every card on the board.
 */
export function readyReasonDiagnostics(row, queueRows = []) {
  const reasons = Array.isArray(row?.reasons) ? row.reasons.map(String) : []
  const details = reasons.map((reason) => {
    const separator = reason.indexOf(':')
    const code = separator < 0 ? reason : reason.slice(0, separator)
    const target = separator < 0 ? '' : reason.slice(separator + 1)
    if (code === 'scope-conflict' || code === 'runnable-scope-conflict') {
      const holder = queueRows.find((candidate) => String(candidate.id) === target)
      return {
        code: 'write-scope-held-by',
        detail: 'write scope is held by task ' + target,
        taskId: target,
        ...typeof holder?.owner === 'string' && holder.owner.length > 0
          ? { member: holder.owner }
          : {},
      }
    }
    if (code === 'dependencies-unmet') {
      const taskIds = Array.isArray(row?.unmet) ? row.unmet.map(String) : []
      return {
        code: 'dependency-unmet',
        detail: 'waiting for dependencies: ' + taskIds.join(', '),
        ...taskIds.length > 0 ? { taskIds } : {},
      }
    }
    if (code === 'owner-busy') {
      return {
        code: 'owner-busy',
        detail: 'owner ' + String(row?.owner ?? '') + ' is working on task ' + String(row?.leaseTaskId ?? ''),
        ...typeof row?.owner === 'string' && row.owner.length > 0 ? { member: row.owner } : {},
        ...typeof row?.leaseTaskId === 'string' && row.leaseTaskId.length > 0 ? { taskId: row.leaseTaskId } : {},
      }
    }
    const known = {
      'already-running': 'task is already running',
      'blocked-phase': 'task is in the blocked phase and cannot run',
      'no-owner': 'task has no owner',
      'owner-unavailable': 'task owner is not available in the Team roster',
      'no-plan': 'task has no plan',
      'plan-not-approved': 'task plan is not approved',
      'no-acceptance': 'task has no acceptance criteria',
      'no-write-scope': 'edit task has no write scope',
    }
    return {
      code,
      detail: known[code] ?? reason,
    }
  })
  const rowId = String(row?.id ?? row?.taskId ?? '')
  if (Array.isArray(row?.unmet) && row.unmet.length > 0
    && !details.some((reason) => reason.code === 'dependency-unmet')) {
    const taskIds = row.unmet.map(String)
    details.push({
      code: 'dependency-unmet',
      detail: 'waiting for dependencies: ' + taskIds.join(', '),
      taskIds,
    })
  }
  const holdingTaskIds = [...new Set((Array.isArray(queueRows) ? queueRows : [])
    .filter((candidate) => String(candidate?.id ?? candidate?.taskId ?? '') !== rowId)
    .filter((candidate) => (Array.isArray(candidate?.reasons) ? candidate.reasons : [])
      .some((reason) => {
        const value = String(reason)
        const separator = value.indexOf(':')
        const code = separator < 0 ? value : value.slice(0, separator)
        const target = separator < 0 ? '' : value.slice(separator + 1)
        return (code === 'scope-conflict' || code === 'runnable-scope-conflict') && target === rowId
      }))
    .map((candidate) => String(candidate?.id ?? candidate?.taskId ?? ''))
    .filter(Boolean))]
  if (holdingTaskIds.length > 0) {
    details.push({
      code: 'write-scope-holding',
      detail: 'write scope is holding tasks: ' + holdingTaskIds.join(', '),
      taskIds: holdingTaskIds,
    })
  }
  return {
    readyReason: details[0]?.code ?? 'not-ready',
    readyReasons: details,
  }
}

export function taskListPageMetadata(total, cursor, limit, returned) {
  const normalizedTotal = Math.max(0, Number(total) || 0)
  const normalizedCursor = Math.max(0, Number(cursor) || 0)
  const normalizedLimit = Math.max(1, Number(limit) || 1)
  return {
    total: normalizedTotal,
    returned: Math.max(0, Number(returned) || 0),
    truncated: normalizedCursor + normalizedLimit < normalizedTotal,
  }
}

/**
 * A clearance remains valid after unrelated main advances. It is invalidated
 * only when the recorded destination is no longer an ancestor, or when main
 * changed a path also changed by the cleared source.
 */
export function clearanceLandingVerdict(record, {
  commit,
  destinationRef = BRANCH_MAIN,
  destinationSha,
  repo,
  runner,
} = {}) {
  const base = clearanceDigestGate(record, { commit })
  if (base.ok !== true) return base
  if (typeof record?.destinationSha !== 'string' || record.destinationSha.length === 0) {
    return {
      ok: false,
      code: 'clearance-destination-unbound',
      detail: 'clearance predates destination anchoring; request a fresh verifier report for this commit',
    }
  }
  const expectedDestination = String(destinationRef ?? BRANCH_MAIN)
  if (String(record.destinationRef ?? BRANCH_MAIN) !== expectedDestination) {
    return {
      ok: false,
      code: 'clearance-destination-ref-mismatch',
      expectedDestination,
      actualDestination: record.destinationRef ?? null,
    }
  }
  const currentDestination = String(destinationSha ?? '').trim()
  if (!/^[0-9a-f]{40}$/.test(currentDestination)) {
    return { ok: false, code: 'clearance-destination-missing', expectedDestination }
  }
  if (currentDestination === record.destinationSha) {
    return { ok: true, mode: 'exact-destination' }
  }
  if (runGit(repo, ['merge-base', '--is-ancestor', record.destinationSha, currentDestination], runner).code !== 0) {
    return {
      ok: false,
      code: 'clearance-destination-not-ancestor',
      recordedDestination: record.destinationSha,
      currentDestination,
    }
  }
  const destinationPaths = changedPathsForRange(repo, record.destinationSha, currentDestination, runner)
  const sourcePaths = Array.isArray(record.sourcePaths)
    ? record.sourcePaths.map(normalizedRepoPath).filter(Boolean)
    : changedPathsForRange(repo, record.sourceBase, commit, runner)
  if (destinationPaths === null || sourcePaths === null) {
    return {
      ok: false,
      code: 'clearance-destination-diff-unavailable',
      recordedDestination: record.destinationSha,
      currentDestination,
    }
  }
  const destinationSet = new Set(destinationPaths.map(normalizedRepoPath))
  const overlap = sourcePaths.find((path) => destinationSet.has(path))
  if (overlap !== undefined) {
    return {
      ok: false,
      code: 'clearance-destination-overlap',
      recordedDestination: record.destinationSha,
      currentDestination,
      path: overlap,
    }
  }
  return {
    ok: true,
    mode: 'disjoint-destination-advance',
    recordedDestination: record.destinationSha,
    currentDestination,
    sourcePathCount: sourcePaths.length,
    destinationPathCount: destinationPaths.length,
  }
}

/** Record the moving destination's issuance-time anchor for a cleared commit. */
export function clearanceDestinationMetadata(commit, repo, runner, destinationRef = BRANCH_MAIN) {
  const destination = runGit(repo, ['rev-parse', '--verify', destinationRef + '^{commit}'], runner)
  const destinationSha = destination.stdout.trim()
  if (destination.code !== 0 || !/^[0-9a-f]{40}$/.test(destinationSha)) {
    return {
      ok: false,
      code: 'clearance-destination-missing',
      detail: String(destination.stderr || destination.stdout || '').trim(),
    }
  }
  const mergeBase = runGit(repo, ['merge-base', destinationSha, commit], runner)
  const sourceBase = mergeBase.stdout.trim()
  if (mergeBase.code !== 0 || !/^[0-9a-f]{40}$/.test(sourceBase)) {
    return {
      ok: false,
      code: 'clearance-source-base-missing',
      detail: String(mergeBase.stderr || mergeBase.stdout || '').trim(),
    }
  }
  const sourcePaths = changedPathsForRange(repo, sourceBase, commit, runner)
  if (sourcePaths === null) {
    return { ok: false, code: 'clearance-source-diff-unavailable' }
  }
  return {
    ok: true,
    destinationRef,
    destinationSha,
    sourceBase,
    sourcePaths,
  }
}

const CLEARANCE_SEVERITY_RANK = Object.freeze({
  blocker: 5,
  major: 4,
  condition: 3,
  minor: 2,
  nit: 1,
})

function clearanceSeverityRank(severity) {
  return CLEARANCE_SEVERITY_RANK[String(severity ?? '')] ?? 0
}

/**
 * Merge clearance records without allowing a lower-severity probe to erase a
 * stronger formal verdict. Same or higher severity may update a record.
 */
export function mergeClearanceRecords(existing = {}, incoming = {}) {
  const records = existing !== null && typeof existing === 'object' && !Array.isArray(existing)
    ? { ...existing }
    : {}
  const updated = []
  const ignored = []
  for (const [commit, record] of Object.entries(incoming ?? {})) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) continue
    const previous = records[commit]
    if (previous !== null && typeof previous === 'object' && !Array.isArray(previous)
      && clearanceSeverityRank(previous.severity) > clearanceSeverityRank(record.severity)) {
      ignored.push({
        commit,
        retainedSeverity: previous.severity,
        ignoredSeverity: record.severity,
        retainedReport: previous.report ?? null,
        ignoredReport: record.report ?? null,
      })
      continue
    }
    records[commit] = record
    updated.push({
      commit,
      severity: record.severity,
      previousSeverity: previous?.severity ?? null,
      report: record.report ?? null,
    })
  }
  return { records, updated, ignored }
}

/** Build one clearance record per cleared commit from the same report digest. */
export function buildClearanceRecords(input = {}) {
  const commits = clearanceCommitsForReport(input)
  const severity = input.severity ?? 'nit'
  const reportDigest = hashControlValue({ summary: input.summary, issues: input.issues })
  const evidenceHash = hashControlValue((input.issues ?? []).map((issue) => issue.evidence))
  const shared = {
    severity,
    report: input.report,
    reportDigest,
    evidenceHash,
    filesHash: hashControlValue((input.issues ?? []).map((issue) => issue.location ?? '')),
    checksHash: hashControlValue((input.issues ?? []).map((issue) => issue.evidence)),
    by: input.by,
    at: input.at,
  }
  return {
    commits,
    records: Object.fromEntries(commits.map((commit) => [commit, { ...shared, commit }])),
  }
}

function readProfileHealth(config) {
  if (typeof config.healthPath !== 'string' || config.healthPath.length === 0) return undefined
  try {
    const value = readTeamJsonCached(config.healthPath)
    return value !== null && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

/** Classify an open task's milestone tick without attributing another task's tick to it. */
export function milestoneDeliveryVerdict(milestone, taskId) {
  const requestedTaskId = String(taskId ?? '')
  const milestoneTaskId = milestone?.taskId === undefined ? undefined : String(milestone.taskId)
  const done = milestone?.done === true
  if (done && milestoneTaskId === requestedTaskId) {
    return { milestoneTaskId, verdict: 'owner-forgot-to-mark-it' }
  }
  if (done && milestoneTaskId !== undefined && milestoneTaskId !== requestedTaskId) {
    return { milestoneTaskId, verdict: 'milestone-unbound' }
  }
  return { milestoneTaskId, verdict: 'work-genuinely-unfinished' }
}

function jsonOutput(schema) {
  return { schema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
}

const ROOM_KIND_PATTERNS = {
  group: /^group:(.+):tier-2$/,
  level: /^level:1$/,
  root: /^root$/,
  task: /^task:.+$/,
}

/**
 * Validate the stable room naming contract before any state is touched. Room
 * IDs are not cosmetic: they are the scope used by admission checks below.
 */
export function roomKindVerdict(roomId, kind) {
  const pattern = ROOM_KIND_PATTERNS[kind]
  if (pattern === undefined || !pattern.test(String(roomId))) {
    const example = {
      group: 'group:<group>:tier-2',
      level: 'level:1',
      root: 'root',
      task: 'task:<task-id>',
    }[kind] ?? '<room-id>'
    return {
      ok: false,
      reason: 'room id "' + roomId + '" does not match kind "' + kind
        + '"; expected the canonical form "' + example + '"',
    }
  }
  return { ok: true }
}

/**
 * Pure room-admission rule shared by open, join and access checks.
 * The caller is the authority; candidate is the member being admitted.
 */
export function roomAdmissionVerdict(room, caller, candidate) {
  if (candidate === undefined) return { ok: false, reason: 'unknown room member' }
  if (caller?.tier === 0) return { ok: true }
  if (caller === undefined) return { ok: false, reason: 'caller is not registered in the Team policy' }
  const roomId = String(room.roomId)
  const kind = String(room.kind)
  if (kind === 'group') {
    const match = ROOM_KIND_PATTERNS.group.exec(roomId)
    if (match === null) return { ok: false, reason: 'malformed group room id' }
    const group = match[1]
    if (candidate.group !== group) return { ok: false, reason: 'group rooms admit only that group' }
    if (candidate.tier !== 1 && candidate.tier !== 2) return { ok: false, reason: 'group rooms admit only the group lead and its members' }
    return { ok: true }
  }
  if (kind === 'level') {
    return candidate.tier === 1
      ? { ok: true }
      : { ok: false, reason: 'level rooms admit tier-1 leads and the verifier only' }
  }
  if (kind === 'root') {
    return candidate.tier === 0 || candidate.tier === 1
      ? { ok: true }
      : { ok: false, reason: 'root rooms admit tier 0 and tier-1 leads only' }
  }
  if (kind === 'task') {
    if (candidate.name === caller.name) return { ok: true }
    if (caller.tier <= 1 && candidate.parent === caller.name) return { ok: true }
    if (caller.tier === 1 && candidate.group === caller.group && candidate.tier === 2) return { ok: true }
    return { ok: false, reason: 'task rooms admit the owning lead, its members and task peers only' }
  }
  return { ok: false, reason: 'unsupported room kind "' + kind + '"' }
}

/**
 * Absolute seat rule for a room kind, independent of who is asking. Tier 0 may
 * open any room, but it must not seat a member who would then be unable to
 * speak there: an inadmissible speaker makes the round impossible to close and
 * a parent round then blocks every dependent group room.
 */
export function roomSeatVerdict(roomId, kind, member) {
  if (member === undefined || member === null) return { ok: false, reason: 'unknown room member' }
  const tier = Number(member.tier)
  if (kind === 'group') {
    const match = ROOM_KIND_PATTERNS.group.exec(String(roomId))
    if (match === null) return { ok: false, reason: 'malformed group room id' }
    if (tier === 0) return { ok: true }
    if (member.group !== match[1]) return { ok: false, reason: 'group rooms seat only that group' }
    if (tier !== 1 && tier !== 2) return { ok: false, reason: 'group rooms seat only the group lead and its members' }
    return { ok: true }
  }
  if (kind === 'level') {
    return tier === 0 || tier === 1
      ? { ok: true }
      : { ok: false, reason: 'level rooms seat only tier-0 and tier-1 members' }
  }
  if (kind === 'root') {
    return tier === 0 || tier === 1
      ? { ok: true }
      : { ok: false, reason: 'root rooms seat only tier 0 and tier-1 leads' }
  }
  return { ok: true }
}

/**
 * Freeze is a participation fact, not just a runtime status. Keep the order and
 * the close quorum derived from the same participant set: exclude frozen
 * non-hosts, but refuse a frozen host because nobody else can close the round.
 */
export function selectRoomRoundMembers({ room, requested = [], memberRecord = () => undefined, frozen = () => false }) {
  const host = typeof room?.host === 'string' ? room.host : ''
  if (host.length === 0) return { ok: false, code: 'room-host', reason: 'room has no host' }
  if (frozen(host) === true) {
    return { ok: false, code: 'room-host-frozen', reason: 'room host "' + host + '" is frozen' }
  }
  const candidateMembers = requested.includes(host) ? requested : [...requested, host]
  const excludedMembers = []
  const members = [...new Set(candidateMembers.map(String))].filter((name) => {
    if (name === host) return true
    if (frozen(name) === true) {
      excludedMembers.push(name)
      return false
    }
    const verdict = roomSeatVerdict(room.roomId, room.kind, memberRecord(name))
    if (!verdict.ok) excludedMembers.push(name)
    return verdict.ok
  })
  return { ok: true, members, excludedMembers }
}

/**
 * A group lead owns plans on its own group board and its own group-document
 * namespace. Product scopes are delegated through that board; another group's
 * document namespace and global governance documents remain cross-group work.
 */
export function planApprovalVerdict(caller, plan, taskBoard) {
  if (Number(caller?.tier) === 0) return { ok: true }
  if (Number(caller?.tier) !== 1 || String(caller?.group ?? '').length === 0) {
    return { ok: false, reason: 'only tier 0 or a group lead may approve a plan' }
  }
  const group = String(caller.group)
  const memberGroups = [...new Set((plan?.members ?? [])
    .map((member) => String(member?.group ?? member?.groupId ?? ''))
    .filter(Boolean))]
  if (memberGroups.length !== 1 || memberGroups[0] !== group) {
    return { ok: false, reason: 'cross-group plans require tier 0' }
  }
  const taskId = String(plan?.taskId ?? '')
  const board = String(taskBoard ?? '')
  if (board !== 'group-' + group && !taskId.startsWith('group-' + group + '-')) {
    return {
      ok: false,
      reason: 'task "' + taskId + '" is not on the "' + group + '" group board; cross-group plans require tier 0',
    }
  }
  for (const rawScope of plan?.writeScopes ?? []) {
    const scope = String(rawScope).replace(/\\/g, '/').replace(/^\.?\//, '')
    const repositoryRootFile = /^\.[^/]+$/.test(scope)
      || /^[^/]+\.[^/]+$/.test(scope)
      || /^(?:LICENSE|NOTICE|Makefile|Dockerfile)$/i.test(scope)
    if (repositoryRootFile) {
      return {
        ok: false,
        reason: 'scope "' + rawScope + '" is a repository-root governance file; cross-group plans require tier 0',
      }
    }
    const foreignGroup = /^docs\/groups\/([^/]+)(?:\/|$)/i.exec(scope)
    if (foreignGroup !== null && foreignGroup[1] !== group) {
      return {
        ok: false,
        reason: 'scope "' + rawScope + '" belongs to group "' + foreignGroup[1]
          + '", not "' + group + '"; cross-group plans require tier 0',
      }
    }
    if (/^docs\/(?:GOVERNANCE|PLATFORM-DEFECTS|WORKAROUND-REVERT|STATUS)\.md$/i.test(scope)) {
      return {
        ok: false,
        reason: 'scope "' + rawScope + '" is global documentation; cross-group plans require tier 0',
      }
    }
  }
  return { ok: true }
}

export function mergePhaseAdvanceVerdict(phaseBefore, phaseAfter) {
  return String(phaseBefore ?? '') === String(phaseAfter ?? '')
    ? { status: 'already-at-or-beyond', phase: phaseAfter ?? null }
    : { status: 'advanced', phase: phaseAfter ?? null }
}

/** Preserve the successful git half when only the follow-up phase move fails. */
export function mergePhaseAdvanceFailureVerdict(error, targetPhase, phaseAfter) {
  const message = String(error?.message ?? error ?? 'phase advance failed')
  const refusal = /^team policy refusal \[([^\]]+)\]:\s*(.*)$/.exec(message)
  return {
    status: 'failed',
    ...(typeof phaseAfter === 'string' && phaseAfter.length > 0 ? { phase: phaseAfter } : {}),
    ...(typeof targetPhase === 'string' && targetPhase.length > 0 ? { targetPhase } : {}),
    code: refusal?.[1] ?? 'phase-advance-failed',
    reason: refusal?.[2] ?? message,
  }
}

/** A worktree may be bound only to the task owner it is intended to serve. */
export function worktreeTargetVerdict(task, target) {
  const owner = String(task?.ownerName ?? task?.owner ?? '').trim()
  const requested = String(target ?? '').trim()
  if (owner.length > 0 && owner !== requested) {
    return {
      ok: false,
      code: 'worktree-task-owner-mismatch',
      reason: 'task "' + String(task?.id ?? task?.taskId ?? 'unknown') + '" belongs to "' + owner
        + '", not target "' + requested + '"; reassign the task before laying out its worktree',
    }
  }
  return { ok: true }
}

/** Only a main merge may claim the integrated phase. */
export function mergeTargetPhase(destination) {
  return String(destination ?? '') === BRANCH_MAIN ? 'integrated' : 'integration-ready'
}

/**
 * Describe the exact adjacent phase moves needed to reach a packet phase.
 * This keeps the phase machine strict while making a refusal actionable.
 */
export function phaseAdvanceGuidance(currentPhase, targetPhase) {
  const current = TASK_PHASES.includes(currentPhase) ? currentPhase : 'draft'
  const target = String(targetPhase ?? '')
  const from = TASK_PHASES.indexOf(current)
  const to = TASK_PHASES.indexOf(target)
  if (to < 0 || from >= to) return { ok: true, steps: [], detail: null }
  const steps = TASK_PHASES.slice(from + 1, to + 1)
  return {
    ok: false,
    steps,
    detail: 'required adjacent phase steps: ' + steps.join(' -> ')
      + ' (' + String(steps.length) + ' step' + (steps.length === 1 ? '' : 's')
      + '); call team_task_update(action:"advance_phase") once per step',
  }
}

/**
 * Owners may drive a card to the integration boundary, but only tier 0 may
 * cross into integrated/accepted. The completed read-only exception preserves
 * the existing direct-accept path for discussion/review cards.
 */
export function taskPhaseAdvanceActorVerdict(input = {}) {
  if (String(input.action ?? '') !== 'advance_phase') return { ok: true, reason: 'not-phase-advance' }
  const nextPhase = String(input.phase ?? '')
  const tier = Number(input.actorTier)
  const directCompletedReadOnlyAccept = input.allowDirectAccept === true
    && nextPhase === 'accepted'
  if (tier !== 0 && ['integrated', 'accepted'].includes(nextPhase) && !directCompletedReadOnlyAccept) {
    return {
      ok: false,
      code: 'phase-owner-terminal',
      reason: 'non-tier-0 callers may advance tasks only through "integration-ready"; '
        + '"integrated" and "accepted" are controlled by merge/final acceptance',
    }
  }
  return { ok: true, reason: tier === 0 ? 'tier-0' : 'within-owner-phase-limit' }
}

/**
 * A completed card may already have reached the owner's integration boundary.
 * Completing in place preserves that phase instead of forcing a rollback.
 */
export function completionPhaseVerdict(phase) {
  const current = String(phase ?? '')
  if (current === 'execution') return { ok: true, nextPhase: 'member-check' }
  if (current === 'integration-ready') return { ok: true, nextPhase: null }
  return {
    ok: false,
    code: 'complete-phase',
    reason: 'planned task must be in execution or integration-ready before completion',
  }
}

const HISTORICAL_TASK_GATES = new Set([
  'phase-accepted',
  'group-acceptance',
  'verifier-review',
  'final-acceptance',
])

/** Historical packet gates are noise only after the exact commit is in main. */
export function taskGateActionable(integratedHistory, requirement) {
  return integratedHistory !== true || !HISTORICAL_TASK_GATES.has(String(requirement))
}

export function memberWorktreeSyncPlan(membership, task, repo, worktreeRoot, memberName) {
  if (Number(membership?.tier) !== 2) return null
  const branch = memberBranch(String(membership.group ?? ''), String(memberName))
  const path = typeof task?.worktreePath === 'string' && task.worktreePath.length > 0
    ? task.worktreePath
    : absoluteWorktreePath(repo, worktreeRoot ?? '.dsh-worktrees', branch)
  return { branch, path }
}

export function memberWorktreeBindingVerdict(membership, task, repo, worktreeRoot, memberName) {
  const workKind = String(task?.workKind ?? (Array.isArray(task?.writeScopes) && task.writeScopes.length > 0 ? 'edit' : ''))
  if (workKind !== 'edit') return { required: false, needsBinding: false }
  const plan = memberWorktreeSyncPlan(membership, task, repo, worktreeRoot, memberName)
  if (plan === null) return { required: false, needsBinding: false }
  return {
    required: true,
    needsBinding: String(task?.worktreePath ?? '') !== plan.path,
    branch: plan.branch,
    path: plan.path,
  }
}

export function reassignActiveOwnerVerdict(task, liveOwner) {
  const active = liveOwner !== undefined
    && ['running', 'provisioning'].includes(String(liveOwner?.status ?? '').toLowerCase())
  if (!active) return { ok: true, reason: 'owner-inactive' }
  if (task?.ready === false) return { ok: true, reason: 'dependency-blocked' }
  return { ok: false, reason: 'reassign-active-owner' }
}

/** Compact every fact a model needs for one room without replaying its transcript. */
const ROOM_SNAPSHOT_RECENT_MESSAGES = 6
const ROOM_SNAPSHOT_MESSAGE_CHARS = 600

function roomMessageTail(room, limit = ROOM_SNAPSHOT_RECENT_MESSAGES) {
  return (Array.isArray(room?.messages) ? room.messages : []).slice(-limit).map((message) => ({
    messageId: String(message?.messageId ?? ''),
    roundId: message?.roundId === undefined || message?.roundId === null ? null : String(message.roundId),
    author: String(message?.author ?? ''),
    kind: String(message?.kind ?? 'notice'),
    turn: message?.turn === true,
    createdAt: Number(message?.createdAt || 0),
    content: String(message?.content ?? '').slice(0, ROOM_SNAPSHOT_MESSAGE_CHARS),
    references: Array.isArray(message?.references) ? message.references.slice(-6).map(String) : [],
  }))
}

function roomSnapshotId(snapshot) {
  return hashControlValue({
    roomId: snapshot.roomId,
    activity: snapshot.activity,
    activeRoundId: snapshot.round?.roundId ?? null,
    latestClosedRoundId: snapshot.latestClosedRound?.roundId ?? null,
    openUnresolved: snapshot.unresolved.map((item) => item.id),
    decisions: snapshot.decisions.map((item) => item.decisionId ?? item.title ?? item.choice ?? ''),
    pendingEscalations: snapshot.pendingEscalations.map((item) => item.escalationId),
    recentMessages: snapshot.recentMessages.map((item) => item.messageId),
  })
}

/** Only an actionable room may inject a turn directive into an unrelated wake. */
export function shouldInjectRoomSnapshot(snapshot) {
  if (snapshot === undefined || snapshot === null) return false
  return snapshot.round?.status === 'open'
    || (Array.isArray(snapshot.pendingEscalations) && snapshot.pendingEscalations.length > 0)
    || (Array.isArray(snapshot.unresolved) && snapshot.unresolved.length > 0)
}

export function compactRoomSnapshot(state, roomId, memberName, maxRoomRounds = 3) {
  const room = state.rooms?.[roomId]
  if (room === undefined) return undefined
  const roundBudget = Number.isFinite(Number(maxRoomRounds)) && Number(maxRoomRounds) > 0
    ? Math.floor(Number(maxRoomRounds))
    : 3
  const roundsUsed = Object.values(state.rounds ?? {}).filter((row) => row?.roomId === roomId).length
  const round = room.currentRoundId === null || room.currentRoundId === undefined
    ? undefined
    : state.rounds?.[room.currentRoundId]
  const messages = Array.isArray(room.messages) && room.messages.length > 0
    ? room.messages
    : Array.isArray(state.roomTails?.[roomId]) ? state.roomTails[roomId] : []
  const latestClosed = latestClosedRound(state, roomId)
  const unresolved = [
    ...(Array.isArray(room.unresolved) ? room.unresolved : []).filter((item) => item === null || typeof item !== 'object' || item.status !== 'resolved').map((item, index) => {
      if (item !== null && typeof item === 'object') {
        return {
          id: String(item.id ?? 'unresolved-' + String(index + 1)),
          text: String(item.text ?? item.content ?? ''),
          status: 'open',
          resolution: item.resolution ?? null,
        }
      }
      return { id: 'unresolved-' + String(index + 1), text: String(item), status: 'open', resolution: null }
    }),
    ...messages
      .filter((message) => ['risk', 'question', 'decision-request'].includes(message.kind))
      .slice(-5)
      .map((message) => ({
        id: String(message.messageId ?? ''),
        text: String(message.content ?? ''),
        status: 'open',
        author: message.author,
        kind: message.kind,
        references: message.references ?? [],
      })),
  ].slice(-12)
  const conflicts = messages
    .filter((message) => message.kind === 'risk')
    .slice(-3)
    .map((message) => ({ author: message.author, content: message.content, references: message.references ?? [] }))
  const evidence = [...new Set(messages.flatMap((message) => Array.isArray(message.references) ? message.references : []))].slice(-12)
  const decisionProjection = projectRoomDecisions(room.decisions)
  const pendingEscalations = Object.values(state.escalations ?? {})
    .filter((row) => row.roomId === roomId && !['resolved', 'cancelled'].includes(row.status))
    .map((row) => ({ escalationId: row.escalationId, category: row.category, decisionNeeded: row.decisionNeeded, urgency: row.urgency }))
  const recentMessages = roomMessageTail(room)
  const waitAction = round?.status !== 'open'
    ? 'stop'
    : round.nextSpeaker === memberName
      ? 'speak'
      : round.nextSpeaker === null && room.host === memberName
        ? 'close'
        : 'stop'
  const snapshot = {
    roomId: room.roomId,
    kind: room.kind,
    status: room.status,
    activity: roomActivity(state, room),
    host: room.host,
    members: room.members,
    summary: latestClosed?.summary ?? room.latestSummary?.text ?? room.summary ?? '',
    latestClosedRound: latestClosed === undefined ? (room.latestSummary ?? null) : {
      roundId: latestClosed.roundId,
      topic: latestClosed.topic ?? '',
      summary: latestClosed.summary,
      closedAt: latestClosed.closedAt ?? null,
    },
    roundBudget: {
      used: roundsUsed,
      max: roundBudget,
      remaining: Math.max(0, roundBudget - roundsUsed),
    },
    round: round === undefined ? null : {
      roundId: round.roundId,
      topic: round.topic,
      status: round.status,
      nextSpeaker: round.nextSpeaker,
      spoken: round.mainSpoken ?? round.spoken ?? [],
      clarified: round.clarified ?? [],
      order: round.order,
    },
    decisions: decisionProjection.decisions,
    pendingDecisions: decisionProjection.decisions.filter((decision) => decision.status === 'proposed'),
    decisionProjection: decisionProjection.projection,
    unresolved,
    recentMessages,
    conflicts,
    evidence,
    pendingEscalations,
    forMember: memberName,
    waitAction,
    waitInstruction: waitAction === 'speak'
      ? 'Post one main speech now, then stop.'
      : waitAction === 'close'
        ? 'Close the round now with summary and unresolved items.'
        : 'End this turn now. Do not call wait_agent; the room handoff will wake you when your turn starts.',
    revision: room.revision,
  }
  snapshot.snapshotId = roomSnapshotId(snapshot)
  return snapshot
}

function roomSnapshotMessage(snapshot) {
  const marker = '[team room snapshot] ' + snapshot.roomId + '@' + String(snapshot.snapshotId ?? snapshot.revision)
  const text = marker + '\n' + JSON.stringify(snapshot)
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'team-message',
      plugin: name,
      form: 'snapshot',
      sections: [{ name: 'team:room', text }],
    },
  })
}

function hasRoomSnapshotMessage(messages, snapshot) {
  const marker = '[team room snapshot] ' + snapshot.roomId + '@' + String(snapshot.snapshotId ?? snapshot.revision)
  for (const message of messages ?? []) {
    try {
      if (JSON.stringify(message?.content ?? '').includes(marker)) return true
    } catch {
      /* Ignore malformed history and keep scanning for the marker. */
    }
  }
  return false
}

/**
 * Derive only the recent model-visible tail. Full `deriveMessages()` copies the
 * entire session history on every pre-step; for large sessions that allocation
 * dominates otherwise small milestone and Room checks.
 */
function recentDerivedMessages(session, limit = 256) {
  try {
    const nodes = session?.surface?.nodes
    if (nodes === undefined || nodes === null) return session?.deriveMessages?.() ?? []
    const list = Array.isArray(nodes) ? nodes : Array.from(nodes)
    const start = Math.max(0, list.length - Math.max(1, Number(limit) || 256))
    const messages = []
    for (let index = start; index < list.length; index += 1) {
      const event = session.eventAt?.(list[index])
      if (event === undefined) continue
      const message = session.deriveEventMessage?.(event)
      if (message !== null && message !== undefined) messages.push(message)
    }
    return messages
  } catch {
    return session?.deriveMessages?.() ?? []
  }
}

/** The caller guaranteed by Agent-scoped tool discovery. */
function callingAgent(agent, toolName) {
  if (agent === void 0) throw new Error(toolName + ' requires a calling Agent')
  return agent
}

/**
 * Project one member to a lossless-JSON value: the registry rejects a result
 * carrying `undefined`, so every optional field is added only when present.
 */
function memberView(member, extra) {
  const view = {
    id: member.id,
    name: member.name,
    role: member.role,
    status: extra !== undefined && extra.frozen === true ? 'frozen' : member.status,
    diagnostics: Array.isArray(member.diagnostics) ? [...member.diagnostics] : [],
  }
  // The provenance stamp is ours, not the caller's: never show it back.
  if (member.description !== undefined) view.description = stripStamp(member.description)
  if (member.provider !== undefined) view.provider = member.provider
  if (member.context !== undefined) view.context = member.context
  if (member.model !== undefined) view.model = member.model
  if (extra !== undefined) {
    view.tier = extra.tier
    view.group = extra.group
    if (extra.parent !== undefined) view.parent = extra.parent
  }
  return view
}

/** Refuse one operation with an actionable message. */
function refuse(rule, detail) {
  throw new Error('team policy refusal [' + rule + ']: ' + detail)
}

/**
 * The live session Lead Agent that owns this caller's Team, used as the domain
 * authority credential for a spawn.
 *
 * This MUST be derived from the caller and never scanned for: one process runs
 * one Team per open session, so "the first live lead in the process" files the
 * spawn into whichever session happens to be enumerated first. That is exactly
 * how a spawned member ended up in another session's roster while the caller's
 * own Team stayed empty, and why every later call reported
 * @@active teammate "..." not found@@.
 *
 * @param ctx - host context carrying the Agent Teams service.
 * @param caller - the exact live Agent this invocation runs as.
 * @returns the live root Lead Agent, or undefined when the caller owns no Team.
 */
export function rootLead(ctx, caller) {
  const member = ctx.agentTeams.tryMembership(caller)
  if (member === undefined) return undefined
  if (member.root !== undefined) return member.root
  // The Domain reports root === agent for a Lead; keep that identity true even if
  // a membership ever omits the field, and never guess for a teammate.
  return member.role === 'lead' ? caller : undefined
}

/** Register the complete v2 Team tool set in one exact Agent scope. */
function install(agent, ctx, config) {
  const scoped = agent.ctx
  const disposers = []
  const register = (disposer) => disposers.push(disposer)

  // The Domain keeps its Team state, but it has no room for tier/group/parent,
  // and smuggling them through the member description leaks them into the
  // session title the operator reads. They live in their own file instead.
  /** Where the standing identity files live; the operator may edit them freely. */
  const rolesDir = config.rolesDir ?? join(process.env.DSH_HOME ?? process.cwd(), 'team-roles')
  const ROLE_LABEL = { verifier: '独立审查组', lead: '组长', member: '组员' }
  /** The same file write-scope-guard enforces at the fs seam (§7.2.4). */
  const scopesFile = config.scopesFile ?? join(process.env.DSH_HOME ?? process.cwd(), 'write-scopes.json')

  /**
   * The write scopes the operator declared for one member, or undefined when it
   * declared none. An undeclared member is not blocked here: the fs guard is the
   * hard floor, and this check only catches a task claiming outside its owner.
   */
  const declaredScopes = (name, sessionId) => {
    try {
      const doc = JSON.parse(readFileSync(scopesFile, 'utf8'))
      const byName = doc.byName === undefined ? undefined : doc.byName[name]
      const bySession = sessionId === undefined || doc.bySession === undefined ? undefined : doc.bySession[sessionId]
      const own = byName ?? bySession
      return Array.isArray(own) ? own : undefined
    } catch {
      return undefined
    }
  }

  // Seeding is part of resolving the name: boardOf() returns undefined for an
  // actor the registry has never seen, so a tool that read the name alone refused
  // the Lead's very first task call as a non-member.
  const callerName = () => callerRecord().name
  /**
   * Resolve a peer inside THIS agent's own Team only. A bare name scan is not
   * safe: every session's root is named "lead" and member names repeat across
   * Teams, so the first name match can belong to a different session entirely.
   */
  const liveTeamAgent = (name) => liveAgent(ctx, name, rootLead(ctx, agent))
  const POLICY_CACHE_MS = 500
  let policyCacheKey
  let policyCacheAt = 0
  let policyCacheValue
  const policy = () => {
    const key = teamKeyOf(ctx, agent)
    const at = Date.now()
    if (policyCacheValue !== undefined && key !== undefined && policyCacheKey === key && at - policyCacheAt < POLICY_CACHE_MS) {
      return policyCacheValue
    }
    // Per Team, not per process: two sessions running a Team at once each project their
    // OWN roster, or the second one sees the first one's members and caps.
    const active = policyFor(key)
    let reconciled = false
    // The Domain roster is the durable truth and this registry is not, so rebuild
    // the registry from it on every step. Without this a restart leaves members
    // that still own their names but that no predicate here can see.
    try {
      // active.registry, NOT active: the service exposes the registry as a property, and
      // passing the service itself made reconcileRegistry read members off an object that
      // has none — it threw on every single call, and the empty catch below swallowed it.
      // The registry was therefore NEVER rebuilt from the Domain, which is why freeze and
      // every other lookup reported unknown-member for members the roster plainly lists.
      reconcileRegistry(active.registry, ctx.agentTeams.listMembers(agent))
      const roster = active.all()
      const counters = active.control.counters()
      const activeSlots = roster.filter((member) => member.tier > 0 && member.frozen !== true && !['failed'].includes(member.status)).length
      if (counters.activeSlots !== activeSlots) {
        void active.control.countersUpdate({ activeSlots }).catch(() => {})
      }
      reconciled = true
    } catch (error) {
      // No Domain roster this step: keep the registry exactly as it is. Logged rather than
      // silent — swallowing this hid a total failure of the rebuild for a long time.
      if (ctx.logger !== undefined) {
        ctx.logger.warn?.('team-policy: registry rebuild skipped: ' + ((error && error.message) || String(error)))
      }
    }
    if (reconciled && key !== undefined) {
      policyCacheKey = key
      policyCacheAt = at
      policyCacheValue = active
    }
    return active
  }

  const record = (name) => policy().get(name)
  const control = () => policy().control
  const assertTeamRunnable = () => {
    const provider = control().providerState?.()
    if (provider?.status === 'blocked') {
      refuse('provider-blocked', 'provider is blocked after ' + String(provider.lastFailure?.category || 'a request failure')
        + '; restore credentials/quota and call team_provider_resume before starting more work')
    }
  }
  const rootMemberName = () => policy().all().find((member) => member.tier === 0)?.name
  const groupLeadName = (group) => policy().all().find((member) => member.tier === 1 && member.group === group)?.name
  const resolveTargetName = (targetName) => {
    const requested = String(targetName)
    return requested === 'root' ? rootMemberName() ?? requested : requested
  }
  const explicitRoomHost = (kind, roomId, actorName, members) => {
    const actor = record(actorName)
    if (kind === 'root') return rootMemberName()
    if (kind === 'group') {
      const match = ROOM_KIND_PATTERNS.group.exec(String(roomId))
      if (match !== null) return groupLeadName(match[1])
    }
    if (actor?.tier === 0 || actor?.tier === 1) return actorName
    return members.map((name) => record(name)).find((member) => member?.tier === 1)?.name ?? rootMemberName()
  }
  const roomSpec = (actorName, targetName, taskId) => {
    const actor = record(actorName)
    const target = record(targetName)
    if (taskId) {
      const members = policy().all().filter((m) => m.name === actorName || m.name === targetName || m.group === actor?.group).map((m) => m.name)
      const roomId = 'task:' + String(taskId)
      const unique = [...new Set(members)]
      const host = explicitRoomHost('task', roomId, actorName, unique)
      return { roomId, kind: 'task', title: 'task ' + String(taskId), members: [...new Set(host === undefined ? unique : [...unique, host])], host }
    }
    // Root-to-lead traffic is a root-level decision channel. Checking the target
    // for tier 1 before the caller would incorrectly downgrade it to level:1.
    if (actor?.tier === 0 || target?.tier === 0) {
      const members = policy().all().filter((m) => m.tier === 0 || m.tier === 1).map((m) => m.name)
      const host = rootMemberName()
      return { roomId: 'root', kind: 'root', title: 'root', members: [...new Set(host === undefined ? members : [...members, host])], host }
    }
    if (actor?.tier === 2) {
      const members = policy().all().filter((m) => m.group === actor.group && m.tier === 2 || m.name === actor.parent).map((m) => m.name)
      const roomId = 'group:' + actor.group + ':tier-2'
      const host = groupLeadName(actor.group)
      return { roomId, kind: 'group', title: 'group ' + actor.group, members: [...new Set(host === undefined ? members : [...members, host])], host }
    }
    // A group lead talking to its own tier-2 member belongs in the group room. The
    // generic tier-1 branch below is the peer-lead channel, and a member is not
    // admitted there: routing downward control through level:1 left those dispatches
    // queued forever because no member can join that room.
    if (actor?.tier === 1 && target?.tier === 2 && target.parent === actorName) {
      const members = policy().all()
        .filter((m) => m.name === actorName || (m.group === actor.group && m.tier === 2))
        .map((m) => m.name)
      return {
        roomId: 'group:' + actor.group + ':tier-2',
        kind: 'group',
        title: 'group ' + actor.group,
        members: [...new Set(members)],
        host: actorName,
      }
    }
    if (actor?.tier === 1 || target?.tier === 1) {
      const members = policy().all().filter((m) => m.tier === 1).map((m) => m.name)
      const host = actor?.tier === 1 ? actorName : target?.tier === 1 ? targetName : rootMemberName()
      return { roomId: 'level:1', kind: 'level', title: 'level 1', members: [...new Set(host === undefined ? members : [...members, host])], host }
    }
    const members = policy().all().filter((m) => m.tier === 0 || m.tier === 1).map((m) => m.name)
    const host = rootMemberName()
    return { roomId: 'root', kind: 'root', title: 'root', members: [...new Set(host === undefined ? members : [...members, host])], host }
  }
  const assertKnownMembers = (members) => {
    for (const name of [...new Set((members ?? []).map(String))]) {
      if (record(name) === undefined) refuse('room-member', 'room names unknown member "' + name + '"')
    }
  }
  const assertRoomMetadata = (roomId, kind) => {
    const verdict = roomKindVerdict(roomId, kind)
    if (!verdict.ok) refuse('room-shape', verdict.reason)
  }
  const assertRoomAdmission = (room, memberName) => {
    const caller = record(callerName())
    const candidate = record(memberName)
    const verdict = roomAdmissionVerdict(room, caller, candidate)
    if (!verdict.ok) {
      refuse('room-admission', 'member "' + memberName + '" cannot enter room "' + room.roomId + '": ' + verdict.reason)
    }
  }
  const assertRoomAccess = (room, memberName) => {
    if (!roomKindVerdict(room.roomId, room.kind).ok) {
      refuse('room-shape', 'persisted room "' + room.roomId + '" has kind "' + room.kind + '"')
    }
    const me = record(memberName)
    if (me?.tier === 0) return
    if (!room.members.includes(memberName)) {
      refuse('room-access', 'member "' + memberName + '" has not joined room "' + room.roomId + '"')
    }
    assertRoomAdmission(room, memberName)
  }
  const assertRoomHost = (room, memberName) => {
    const me = record(memberName)
    if (me?.tier === 0 || room.host === memberName) return
    refuse('room-host', 'only tier 0 or room host "' + String(room.host) + '" may change round state')
  }
  const assertPlanAccess = (plan, memberName) => {
    const me = record(memberName)
    const members = Array.isArray(plan.members) ? plan.members.map(String) : []
    if (me?.tier === 0 || members.includes(memberName)) return
    const groups = new Set(members.map((name) => record(name)?.group).filter(Boolean))
    if (me?.tier === 1 && groups.size === 1 && groups.has(me.group)) return
    refuse('plan-scope', 'member "' + memberName + '" is not assigned to task "' + plan.taskId
      + '"; plan members: [' + members.join(', ') + ']; access is limited to tier 0, assigned members, and the owning group lead')
  }
  const assertPlanReadAccess = (plan, memberName) => {
    if (Array.isArray(plan.members) && plan.members.map(String).includes(memberName)) return
    const found = durableTask(plan.taskId)
    if (String(found?.task?.ownerName ?? '') === memberName) return
    assertPlanAccess(plan, memberName)
  }
  const assertDispatchAccess = (row, memberName) => {
    const me = record(memberName)
    if (me?.tier === 0 || row.sender === memberName || row.target === memberName) return
    const room = row.roomId ? control().view({ history: false }).rooms?.[row.roomId] : undefined
    if (room?.members?.includes(memberName)) return
    refuse('dispatch-scope', 'member "' + memberName + '" cannot inspect dispatch "' + row.dispatchId + '"')
  }
  const ensureRoom = async (spec, actor) => {
    const cp = control()
    assertRoomMetadata(spec.roomId, spec.kind)
    assertKnownMembers(spec.members)
    let snapshot = cp.view({ history: false })
    let room = snapshot.rooms?.[spec.roomId]
    const requestedDependencies = Array.isArray(spec.dependsOnRooms)
      ? [...new Set(spec.dependsOnRooms.map(String).filter((value) => value.length > 0))]
      : []
    const joinedDependencies = new Set(Array.isArray(room?.dependsOnRooms)
      ? room.dependsOnRooms.map(String)
      : [])
    const needsOpen = room === undefined
      || room.host === null || room.host === undefined || room.host === ''
      || (spec.replaceHost === true && spec.host)
      || (spec.kind !== undefined && String(spec.kind) !== String(room.kind))
      || requestedDependencies.some((dependency) => !joinedDependencies.has(dependency))
    let changed = needsOpen
    if (needsOpen) room = await cp.roomOpen(spec, actor)
    assertRoomAccess(room, callerName())
    const joined = new Set(Array.isArray(room.members) ? room.members.map(String) : [])
    for (const member of spec.members) {
      assertRoomAdmission(room, member)
      if (joined.has(String(member))) continue
      await cp.roomJoin(spec.roomId, member, actor)
      joined.add(String(member))
      changed = true
    }
    if (changed) snapshot = cp.view({ history: false })
    const current = snapshot.rooms?.[spec.roomId]
    if (current?.currentRoundId && snapshot.rounds?.[current.currentRoundId]?.status === 'open') {
      return { room: current, round: snapshot.rounds[current.currentRoundId] }
    }
    return { room: current ?? room, round: null }
  }
  const wakeRoomMember = async ({ roomId, roundId, target, reason, actor, phase, signal }) => {
    const targetName = resolveTargetName(target)
    if (targetName.length === 0 || targetName === callerName()) return undefined
    const baseEpisodeId = 'room:' + String(roomId) + ':' + String(roundId) + ':' + phase + ':' + targetName
    const text = '[team room turn] ' + reason
    const messageHash = hashControlValue(text)
    let claimed
    try {
      claimed = await claimWakeMessage({
        actor,
        baseEpisodeId,
        kind: 'control',
        roomId,
        sender: callerName(),
        target: targetName,
        messageId: baseEpisodeId + ':' + messageHash.slice(0, 16),
        messageHash,
        text,
      })
    } catch (error) {
      if (ctx.logger !== undefined) ctx.logger.warn?.('team room wake claim failed for ' + targetName + ': ' + ((error && error.message) || String(error)))
      return { target: targetName, status: 'claim-failed' }
    }
    const dispatch = claimed.dispatch
    if (claimed.distinct !== true) {
      return { target: targetName, status: 'coalesced', dispatchId: dispatch.dispatchId }
    }
    try {
      const delivered = await deliverWake({
        actor,
        target: targetName,
        text,
        signal,
        episodeId: claimed.episodeId,
        dispatchId: dispatch.dispatchId,
        messageId: baseEpisodeId + ':' + messageHash.slice(0, 16),
        messageHash,
        allowDirect: true,
      })
      return { target: targetName, status: delivered.status, dispatchId: dispatch.dispatchId }
    } catch (error) {
      const detail = (error && error.message) || String(error)
      try {
        await safeDispatchTransition({ dispatchId: dispatch.dispatchId, status: 'delivery-failed', error: detail }, actor)
        await control().wakeAcknowledge({ episodeId: claimed.episodeId, status: 'delivery-failed' }, actor)
      } catch {
        /* The delivery row may already have reached a terminal state. */
      }
      if (ctx.logger !== undefined) ctx.logger.warn?.('team room wake delivery failed for ' + targetName + ': ' + detail)
      return { target: targetName, status: 'delivery-failed', dispatchId: dispatch.dispatchId }
    }
  }
  const safeDispatchTransition = async (input, actor) => {
    try { return await control().dispatchTransition({ ...input, ignoreTerminal: true }, actor) }
    catch (error) {
      ctx.logger?.warn?.('dispatch transition ignored for ' + String(input.dispatchId) + ': ' + String(error?.message ?? error))
      return undefined
    }
  }

  const wakeEpisodeGeneration = (baseEpisodeId, episodeId) => {
    const base = String(baseEpisodeId)
    const id = String(episodeId)
    if (id === base) return 1
    if (!id.startsWith(base + ':r')) return 0
    const value = Number(id.slice(base.length + 2))
    return Number.isSafeInteger(value) && value > 0 ? value : 0
  }

  const nextWakeEpisode = (snapshot, baseEpisodeId) => {
    const base = String(baseEpisodeId)
    const candidates = []
    const baseEpisode = snapshot.wakeEpisodes?.[base]
    if (baseEpisode !== undefined) candidates.push({ episodeId: base, episode: baseEpisode, generation: 1 })
    for (const [episodeId, episode] of Object.entries(snapshot.wakeEpisodes ?? {})) {
      const generation = wakeEpisodeGeneration(base, episodeId)
      if (generation > 1) candidates.push({ episodeId, episode, generation })
    }
    candidates.sort((left, right) => left.generation - right.generation)
    const latest = candidates.at(-1)
    if (latest === undefined || !WAKE_TERMINAL_EPISODE_STATES.has(String(latest.episode?.status))) {
      return latest ?? { episodeId: base, episode: undefined, generation: 1 }
    }
    const generation = Math.max(latest.generation, 1) + 1
    return {
      episodeId: base + ':r' + String(generation),
      episode: undefined,
      previous: latest.episode,
      previousEpisodeId: latest.episodeId,
      generation,
    }
  }

  const mutateWakeRecord = async (action, input, actor, mutation) => {
    const cp = control()
    if (typeof cp.mutateHot !== 'function') return undefined
    try {
      return await cp.mutateHot(action, input, actor, mutation)
    } catch (error) {
      ctx.logger?.warn?.('wake record mutation failed for ' + String(input.dispatchId ?? input.episodeId ?? '') + ': ' + String(error?.message ?? error))
      return undefined
    }
  }

  const recordWakePendingMessage = async ({ actor, dispatchId, episodeId, messageId, messageHash, text }) => {
    const id = String(messageId ?? dispatchId + ':' + String(messageHash).slice(0, 16))
    const hash = String(messageHash ?? '')
    const body = String(text ?? '').slice(0, 8000)
    const createdAt = Date.now()
    return mutateWakeRecord('wake/message-recorded', { dispatchId, episodeId, messageId: id, messageHash: hash }, actor, (state) => {
      const dispatch = state.dispatches?.[dispatchId]
      const episode = state.wakeEpisodes?.[episodeId]
      if (dispatch === undefined || episode === undefined) return undefined
      const rows = Array.isArray(dispatch.pendingMessages) ? dispatch.pendingMessages : []
      if (!rows.some((row) => row?.messageHash === hash || row?.messageId === id)) {
        rows.push({
          messageId: id,
          messageHash: hash,
          text: body,
          status: 'queued',
          createdAt,
        })
      }
      dispatch.pendingMessages = rows.slice(-16)
      episode.pendingMessages = dispatch.pendingMessages
      episode.latestMessageId = id
      episode.latestMessageHash = hash
      episode.updatedAt = createdAt
      return { dispatchId, episodeId, messageId: id, pendingCount: dispatch.pendingMessages.length }
    })
  }

  const markWakePendingMessage = async ({ actor, dispatchId, episodeId, messageId, messageHash, status }) => {
    const hash = String(messageHash ?? '')
    const id = String(messageId ?? '')
    const updatedAt = Date.now()
    return mutateWakeRecord('wake/message-status', { dispatchId, episodeId, messageId: id, messageHash: hash, status }, actor, (state) => {
      const dispatch = state.dispatches?.[dispatchId]
      const episode = state.wakeEpisodes?.[episodeId]
      if (dispatch === undefined) return undefined
      const rows = Array.isArray(dispatch.pendingMessages) ? dispatch.pendingMessages : []
      const row = rows.find((candidate) => candidate?.messageHash === hash || candidate?.messageId === id)
      if (row !== undefined) {
        row.status = String(status)
        row.updatedAt = updatedAt
      }
      if (episode !== undefined) episode.pendingMessages = dispatch.pendingMessages
      return { dispatchId, episodeId, messageId: id, status }
    })
  }

  const claimWakeMessage = async ({
    actor,
    baseEpisodeId,
    kind = 'control',
    taskId,
    roomId,
    sender,
    target,
    messageId,
    messageHash,
    text,
    messageOperationKey,
  }) => {
    const before = control().view({ history: false })
    const selected = nextWakeEpisode(before, baseEpisodeId)
    const priorDispatch = selected.episode?.dispatchId === undefined
      ? undefined
      : before.dispatches?.[selected.episode.dispatchId]
    const priorHashes = Array.isArray(priorDispatch?.messageHashes) ? priorDispatch.messageHashes.map(String) : []
    const claimed = await control().wakeClaim({
      episodeId: selected.episodeId,
      kind,
      taskId,
      roomId,
      sender,
      target,
      messageHash,
      pendingMessage: { messageId, messageHash, text, status: 'queued' },
      ...(messageOperationKey === undefined ? {} : { messageOperationKey }),
    }, actor)
    const duplicate = claimed.claimed === false && priorHashes.includes(String(messageHash))
    const previousDispatch = selected.previous?.dispatchId === undefined
      ? undefined
      : before.dispatches?.[selected.previous.dispatchId]
    if (claimed.claimed === true
      && selected.previous !== undefined
      && previousDispatch !== undefined
      && WAKE_DEAD_LETTER_STATES.has(String(previousDispatch.status))) {
      await mutateWakeRecord('wake/episode-recovered', {
        dispatchId: selected.previous.dispatchId,
        episodeId: selected.previousEpisodeId,
        replacementEpisodeId: selected.episodeId,
      }, actor, (state) => {
        const previous = state.dispatches?.[selected.previous.dispatchId]
        const previousEpisode = state.wakeEpisodes?.[selected.previousEpisodeId]
        if (previous !== undefined) {
          previous.deadLetter = {
            ...(previous.deadLetter && typeof previous.deadLetter === 'object' ? previous.deadLetter : {}),
            status: 'superseded',
            recoveredAt: Date.now(),
            replacementEpisodeId: selected.episodeId,
          }
        }
        if (previousEpisode !== undefined) {
          previousEpisode.deadLetter = previous?.deadLetter ?? {
            status: 'superseded',
            recoveredAt: Date.now(),
            replacementEpisodeId: selected.episodeId,
          }
        }
        return { replacementEpisodeId: selected.episodeId }
      })
    }
    if (!duplicate && claimed.pendingAdded !== true) {
      await recordWakePendingMessage({
        actor,
        dispatchId: claimed.dispatch.dispatchId,
        episodeId: selected.episodeId,
        messageId,
        messageHash,
        text,
      })
    }
    return {
      ...claimed,
      episodeId: selected.episodeId,
      duplicate,
      distinct: !duplicate,
      generation: selected.generation,
      priorDispatch,
    }
  }

  const recordWakeDeadLetter = async ({ actor, dispatchId, kind }) => {
    const row = control().dispatchGet(dispatchId)
    if (row === undefined || row.wakeup !== true || !WAKE_DEAD_LETTER_STATES.has(String(row.status))) return undefined
    const metadata = {
      status: 'open',
      kind: String(kind ?? 'dispatch-timeout'),
      sender: String(row.sender ?? ''),
      target: String(row.target ?? ''),
      taskId: row.taskId ?? null,
      roomId: row.roomId ?? null,
      attempt: Number(row.attempt ?? 0),
      lastError: String(row.lastError ?? 'dispatch deadline expired'),
      suggestedAction: 'retry-new-episode|reassign|block|cancel',
      createdAt: Number(row.resolvedAt ?? Date.now()),
    }
    await mutateWakeRecord('wake/dead-letter', { dispatchId }, actor, (state) => {
      const dispatch = state.dispatches?.[dispatchId]
      if (dispatch === undefined) return undefined
      dispatch.deadLetter = {
        ...(dispatch.deadLetter && typeof dispatch.deadLetter === 'object' ? dispatch.deadLetter : {}),
        ...metadata,
      }
      const episode = Object.values(state.wakeEpisodes ?? {}).find((candidate) => candidate?.dispatchId === dispatchId)
      if (episode !== undefined) episode.deadLetter = dispatch.deadLetter
      return dispatch.deadLetter
    })
    const text = '[team wake dead-letter] ' + metadata.sender + ' -> ' + metadata.target
      + '\nDispatch: ' + String(dispatchId)
      + '\nTask: ' + String(metadata.taskId ?? 'none') + ' Room: ' + String(metadata.roomId ?? 'none')
      + '\nAttempts: ' + String(metadata.attempt) + ' Last error: ' + metadata.lastError
      + '\nRecovery: retry with a new episode, reassign, mark the task blocked, or cancel explicitly. Inspect team_dispatch_status and team_control_status before acting.'
    try {
      await control().escalate({
        category: 'wake-dead-letter',
        summary: 'Wake dispatch ' + String(dispatchId) + ' exhausted retries for target "' + metadata.target + '".',
        decisionNeeded: 'Retry with a new episode, reassign, mark blocked, or cancel explicitly.',
        target: metadata.target || null,
        references: [String(dispatchId)],
        options: ['retry-new-episode', 'reassign', 'block', 'cancel'],
        urgency: 'critical',
      }, actor)
    } catch (error) {
      ctx.logger?.warn?.('wake dead-letter escalation failed for ' + String(dispatchId) + ': ' + String(error?.message ?? error))
    }
    try {
      const sender = metadata.sender
      const senderAgent = sender.length > 0 ? liveTeamAgent(sender) : undefined
      if (senderAgent !== undefined) {
        deliverPluginMessage(ctx, senderAgent, text, { form: 'notice', summary: 'wake dead-letter ' + String(dispatchId) })
      } else if (sender.length === 0 || sender === callerName()) {
        deliverPluginMessage(ctx, actor, text, { form: 'notice', summary: 'wake dead-letter ' + String(dispatchId) })
      }
    } catch (error) {
      ctx.logger?.warn?.('wake dead-letter sender notice failed for ' + String(dispatchId) + ': ' + String(error?.message ?? error))
    }
    return metadata
  }

  /**
   * The Team mailbox is already durable before it attempts immediate delivery.
   * Waiting for a cold target or a slow session flush inside a model tool call
   * turns a healthy queue into a long PTC timeout, so keep the caller bounded:
   * return queued after the configured short wait and let the background
   * delivery continue to its terminal acknowledgement.
   */
  const deliverWake = async ({
    actor,
    target,
    text,
    signal,
    episodeId,
    dispatchId,
    messageId,
    messageHash,
    allowDirect = false,
  }) => {
    const targetAgent = liveTeamAgent(target)
    let targetStatus
    try {
      const roster = ctx.agentTeams.listMembers?.(actor) ?? []
      targetStatus = roster.find((member) => String(member?.name ?? '') === String(target))?.status
    } catch {
      targetStatus = undefined
    }
    const targetVerdict = deliveryTargetVerdict({
      target,
      status: targetStatus,
      liveAgent: targetAgent,
    })
    if (targetVerdict.ok !== true) {
      await safeDispatchTransition({
        dispatchId,
        status: 'delivery-failed',
        error: targetVerdict.reason,
      }, actor)
      await markWakePendingMessage({
        actor,
        dispatchId,
        episodeId,
        messageId,
        messageHash,
        status: 'delivery-failed',
      })
      try {
        await control().wakeAcknowledge({ episodeId, status: 'delivery-failed' }, actor)
      } catch {
        /* The dispatch transition is the durable failure record. */
      }
      return {
        status: 'delivery-failed',
        code: targetVerdict.code,
        error: targetVerdict.reason,
      }
    }
    if (allowDirect) {
      const source = { kind: TEAM_WAKE_KIND, plugin: name, form: 'action', summary: text.slice(0, 120) }
      const directWaitMs = Math.max(100, Math.min(1000, Number(config.wakeAckWaitMs) || 500))
      const boundedDirect = async (operation) => {
        let timer
        try {
          return await Promise.race([
            Promise.resolve(operation).then(
              (value) => ({ ok: true, value }),
              (error) => ({ ok: false, error }),
            ),
            new Promise((resolve) => {
              timer = setTimeout(() => resolve({ ok: false, timeout: true }), directWaitMs)
              timer.unref?.()
            }),
          ])
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
      }
      if (targetAgent !== undefined && typeof targetAgent.steer === 'function') {
        try {
          const direct = await boundedDirect(targetAgent.steer(createUserMessage({
            content: [{ type: 'text', text }],
            source,
          })))
          if (direct.ok === true) {
            try {
              await control().wakeAcknowledge({ episodeId, status: 'delivered' }, actor)
              await markWakePendingMessage({ actor, dispatchId, episodeId, messageId, messageHash, status: 'delivered' })
            } catch { /* the target already has the wake */ }
            return { status: 'delivered' }
          }
        } catch {
          // Fall back to the durable Team mailbox for cold, unauthorized, or
          // version-mismatched targets.
        }
      }
      // Do not synchronously cold-resume a large target Session inside a PTC
      // tool call. `subagents.steerPrompt` can spend minutes restoring history
      // and previously made a sequence of send_message calls hit the 115s
      // execution deadline. The durable mailbox below still queues the wake;
      // its short race returns `queued` while recovery continues in background.
    }
    const background = new AbortController()
    // The caller's PTC deadline must not cancel cold-resume work. The mailbox
    // row is durable before dispatch; once the bounded wait expires we return
    // `queued` while this delivery continues in the background.
    const delivery = ctx.agentTeams.sendMessage(actor, {
      target,
      content: [{ type: 'text', text }],
      signal: background.signal,
    }).then(async (receipt) => {
      if (receipt?.status !== undefined && receipt.status !== 'accepted') {
        return { status: 'queued', messageId: receipt?.messageId }
      }
      try {
        await control().wakeAcknowledge({ episodeId, status: 'delivered' }, actor)
        await markWakePendingMessage({ actor, dispatchId, episodeId, messageId, messageHash, status: 'delivered' })
        return { status: 'delivered', messageId: receipt.messageId }
      } catch (error) {
        await safeDispatchTransition({
          dispatchId,
          status: 'delivery-failed',
          error: error?.message ?? String(error),
        }, actor)
        await markWakePendingMessage({ actor, dispatchId, episodeId, messageId, messageHash, status: 'delivery-failed' })
        return { status: 'delivery-failed', error }
      }
    }, async (error) => {
      await safeDispatchTransition({
        dispatchId,
        status: 'delivery-failed',
        error: error?.message ?? String(error),
      }, actor)
      await markWakePendingMessage({ actor, dispatchId, episodeId, messageId, messageHash, status: 'delivery-failed' })
      try {
        await control().wakeAcknowledge({ episodeId, status: 'delivery-failed' }, actor)
      } catch {
        /* The dispatch transition is the durable failure record. */
      }
      return { status: 'delivery-failed', error }
    })
    let timer
    const queued = new Promise((resolve) => {
      timer = setTimeout(() => {
        resolve({ status: 'queued' })
      }, config.wakeAckWaitMs)
      timer.unref?.()
    })
    const outcome = await Promise.race([delivery, queued])
    if (timer !== undefined) clearTimeout(timer)
    if (outcome.status === 'delivery-failed') {
      return {
        status: 'delivery-failed',
        messageId: outcome.messageId,
        error: String(outcome.error?.message ?? outcome.error ?? 'delivery failed'),
      }
    }
    return outcome
  }

  const retryDispatch = async (dispatchId) => {

    const row = control().dispatchGet(dispatchId)
    if (row === undefined || row.status !== 'queued') return false
    try {
      if (row.wakeup === true) {
        const retryText = pendingDispatchText(row,
          '[team retry] A durable dispatch timed out and was requeued. Resolve it or report why it cannot proceed.')
        const receipt = await ctx.agentTeams.sendMessage(agent, {
          target: row.target,
          content: [{ type: 'text', text: retryText }],
          signal: new AbortController().signal,
        })
        if (receipt?.status !== 'accepted') return false
        await control().dispatchTransition({ dispatchId, status: 'delivered' }, agent)
        const episode = Object.values(control().view({ history: false }).wakeEpisodes ?? {})
          .find((candidate) => candidate.dispatchId === dispatchId)
        for (const message of Array.isArray(row.pendingMessages) ? row.pendingMessages : []) {
          if (['handled', 'rejected'].includes(String(message?.status ?? ''))) continue
          await markWakePendingMessage({
            actor: agent,
            dispatchId,
            episodeId: episode?.episodeId,
            messageId: message.messageId,
            messageHash: message.messageHash,
            status: 'delivered',
          })
        }
        if (episode !== undefined) {
          await control().wakeAcknowledge({ episodeId: episode.episodeId, status: 'delivered' }, agent)
        }
      } else {
        const target = liveTeamAgent(row.target)
        const delivered = deliverPluginMessage(ctx, target,
          '[team retry] A durable quiet message is waiting for your next step.',
          { form: 'notice', summary: 'retry ' + dispatchId })
        if (!delivered) return false
        await control().dispatchTransition({ dispatchId, status: 'delivered' }, agent)
        await control().dispatchTransition({ dispatchId, status: 'completed' }, agent)
      }
      return true
    } catch (error) {
      if (ctx.logger !== undefined) {
        ctx.logger.warn?.('team dispatch retry failed for ' + dispatchId + ': ' + ((error && error.message) || String(error)))
      }
      return false
    }
  }
  if (ctx.agentTeams.membership(agent).role === 'lead' && typeof setInterval === 'function') {
    const timer = setInterval(() => {
      void (async () => {
        try {
          const reconciled = await control().reconcileDispatches({
            deliveryTimeoutMs: config.deliveryTimeoutMs,
            runTimeoutMs: config.runTimeoutMs,
            maxAttempts: config.maxDispatchAttempts,
          }, agent)
          for (const change of reconciled.changes) {
            if (change.kind === 'dispatch-retry') await retryDispatch(change.dispatchId)
            if (change.kind === 'dispatch-timeout' || change.kind === 'dispatch-expired') {
              await recordWakeDeadLetter({ actor: agent, dispatchId: change.dispatchId, kind: change.kind })
            }
          }
        } catch (error) {
          if (ctx.logger !== undefined) {
            ctx.logger.warn?.('team control reconciliation failed: ' + ((error && error.message) || String(error)))
          }
        }
      })()
    }, Math.max(5000, Number(config.reconcileIntervalMs || 30000)))
    timer.unref?.()
    register(() => clearInterval(timer))
  }
  const durableTask = (taskId, preferredBoardId, querySnapshot) => {
    const wanted = String(taskId)
    const snapshot = querySnapshot ?? control().view({ history: false })
    const requirement = snapshot.v12Requirements?.requirements?.['task:' + wanted + ':acceptance']
    if (preferredBoardId !== undefined) {
      const preferred = snapshot.boards?.[String(preferredBoardId)]?.tasks?.[wanted]
      if (preferred !== undefined) return { boardId: String(preferredBoardId), task: preferred, requirement }
    }
    for (const [boardId, board] of Object.entries(snapshot.boards ?? {})) {
      const task = board.tasks?.[wanted]
      if (task !== undefined) return { boardId, task, requirement }
    }
    return undefined
  }
  const assertEvidenceTaskAccess = (taskId) => {
    if (taskId === undefined || taskId === null || String(taskId).trim().length === 0) return
    const me = record(callerName())
    if (me?.tier === 0) return
    const found = durableTask(taskId)
    if (found === undefined) {
      refuse('evidence-task-not-found', 'cannot bind evidence to unknown task "' + taskId + '"')
    }
    // The verifier may bind its review evidence to the card it is reviewing.
    // This is narrower than an unbound evidence row and matches its existing
    // read-only visibility across group boards.
    if (me?.group === 'verifier') return
    if (String(found.task.ownerName ?? '') === callerName()) return
    const plan = control().planState(taskId)
    if (plan !== undefined) {
      assertPlanAccess(plan, callerName())
      return
    }
    if (me?.tier === 1 && String(found.boardId) === 'group-' + String(me.group)) return
    refuse('evidence-task-scope',
      'member "' + callerName() + '" may not bind evidence to task "' + taskId
      + '"; only its owner, assigned plan members, the group lead, the verifier, or tier 0 may do so')
  }
  /**
   * Bind an actionable instruction to the task state the sender claims to have
   * read. A stale task snapshot is refused before delivery, which prevents the
   * expensive failure mode where a lead orders a member to do work that a newer
   * result has already invalidated.
   */
  const instructionTaskSnapshot = (taskId, basedOnRevision, basedOnPhase) => {
    if (taskId === undefined || taskId === null || String(taskId).length === 0) return undefined
    const found = durableTask(taskId)
    if (found === undefined) refuse('instruction-task', 'task "' + taskId + '" does not exist in the control plane')
    if (!policy().canReadBoard(callerName(), found.boardId)) refuse('instruction-task-scope', 'task is outside the sender board scope')
    if (!Number.isSafeInteger(basedOnRevision) || basedOnRevision < 1) {
      refuse('instruction-state-required', 'a task-bound action/decision requires based_on_revision; read team_task_get immediately before sending')
    }
    if (typeof basedOnPhase !== 'string' || basedOnPhase.length === 0) {
      refuse('instruction-state-required', 'a task-bound action/decision requires based_on_phase; read team_task_get immediately before sending')
    }
    const current = Number(found.task.revision)
    const currentPhase = String(found.task.phase ?? '')
    if (basedOnRevision !== current || basedOnPhase !== currentPhase) {
      refuse('instruction-stale', 'task "' + taskId + '" advanced before delivery: you cited revision ' + basedOnRevision
        + ' phase "' + basedOnPhase + '", current is revision ' + current + ' phase "' + currentPhase
        + '"; re-read team_task_get and rebuild the instruction instead of sending stale work')
    }
    return { taskId: String(taskId), revision: current, phase: currentPhase, status: String(found.task.status ?? '') }
  }
  /**
   * Resolve the one mandatory delivery intent on a direct message.
   * `wake:true` remains as a legacy alias for `action`; a missing intent can
   * never silently become a quiet notification.
   */
  const resolveDirectDelivery = (args) => {
    const explicit = args.delivery === undefined || args.delivery === null ? undefined : String(args.delivery)
    if (explicit === undefined && args.wake === true) return 'action'
    if (explicit === undefined) {
      refuse('delivery-intent-required', 'send_message requires delivery:"info" for a non-waking notice, delivery:"action" for an actionable peer/downward message, or delivery:"decision" for a blocked upward decision')
    }
    if (!['info', 'action', 'decision'].includes(explicit)) {
      refuse('delivery-intent', 'send_message delivery must be "info", "action" or "decision"')
    }
    if (args.wake === true && explicit !== 'action') {
      refuse('delivery-conflict', 'wake:true is a legacy alias for delivery:"action"; do not combine it with delivery:"' + explicit + '"')
    }
    return explicit
  }
  /**
   * The domain and the local control plane each own a revision counter. They are
   * both CAS preconditions, but they do not advance on the same actions: the
   * shipped domain has no `advance_phase`, so a local-only phase move leaves the
   * domain revision behind. Mixing the two counters made the next claim/complete
   * fail as a stale domain revision. Domain calls therefore read and bind the
   * domain revision immediately before the mutation; callers continue to use the
   * local board revision exposed by team_task_get/list.
   */
  const domainTaskRevision = async (caller, taskId) => {
    const task = await ctx.agentTeams.getTask(caller, TeamTaskId(taskId))
    return { task, revision: Number(task.revision) }
  }
  const domainRequestWithCurrentRevision = async (caller, request) => {
    const current = await domainTaskRevision(caller, request.taskId)
    return { ...request, expectedRevision: current.revision }
  }
  const localExpectedRevision = (boardId, taskId) => {
    const found = durableTask(taskId)
    if (found === undefined) return undefined
    if (boardId !== undefined && found.boardId !== boardId) return undefined
    return Number(found.task.revision)
  }
  /**
   * Resolve the repository a worktree/merge command must be anchored to.
   *
   * `process.cwd()` is the DSH worker directory, not the project: real child
   * sessions inherited the parent workspace while their approved write scopes
   * pointed at `mc189-rs/...`, so a default setup created `.dsh-worktrees` in
   * the wrong place and the resulting checkout did not match the scope root.
   * Prefer the exact session repository cwd, then the configured repo, then the
   * worker cwd as the final legacy fallback.
   */
  const nearestGitRoot = (start) => {
    if (typeof start !== 'string' || start.trim().length === 0) return undefined
    let current = resolve(start)
    for (;;) {
      try {
        if (existsSync(join(current, '.git')) && statSync(join(current, '.git')).isDirectory()) return current
      } catch {
        return undefined
      }
      const parent = dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  }
  const repositoryRoot = (agent, explicit, approvedPlan) => {
    if (typeof explicit === 'string' && explicit.trim().length > 0) {
      const requested = resolve(explicit)
      const requestedGit = nearestGitRoot(requested)
      if (requestedGit === undefined) refuse('repo-not-git', 'repo "' + explicit + '" is not inside a git repository')
      return requestedGit
    }
    const sessionCwd = agent?.session?.header?.cwd
    const configured = typeof config.repoRoot === 'string' && config.repoRoot.trim().length > 0 ? config.repoRoot : undefined
    const candidates = [sessionCwd, configured, process.cwd()]
    for (const scope of approvedPlan?.writeScopes ?? []) {
      const first = String(scope).split(/[\\/]/).filter(Boolean)[0]
      if (first === undefined) continue
      for (const base of candidates) {
        if (typeof base !== 'string' || base.length === 0) continue
        const git = nearestGitRoot(join(base, first))
        if (git !== undefined) return git
      }
    }
    for (const base of candidates) {
      const git = nearestGitRoot(base)
      if (git !== undefined) return git
    }
    return resolve(sessionCwd ?? configured ?? process.cwd())
  }
  const activeLeaseFor = (taskId, memberName) => control().leaseList().find((lease) =>
    lease.status === 'active'
      && (!Number(lease.expiresAt) || Number(lease.expiresAt) > Date.now())
      && String(lease.taskId ?? '') === String(taskId)
      && String(lease.member ?? '') === String(memberName))
  const advanceTaskPhase = async (taskId, phase, actor, options = {}) => {
    if (!TASK_PHASES.includes(phase)) throw new Error('unsupported task phase "' + phase + '"')
    for (let attempt = 0; attempt < 2; attempt++) {
      const found = durableTask(taskId)
      if (found === undefined) return undefined
      const current = TASK_PHASES.includes(found.task.phase) ? found.task.phase : 'draft'
      if (current === phase) return found.task
      const directCompletedReadOnlyAccept = phase === 'accepted'
        && found.task.status === 'completed'
        && ['discussion', 'review'].includes(found.task.workKind)
      if (TASK_PHASES.indexOf(phase) >= TASK_PHASES.indexOf('verifier-review')
        && found.task.status !== 'completed'
        && !directCompletedReadOnlyAccept) {
        refuse('task-phase-status', 'task "' + taskId + '" cannot enter packet phase "' + phase
          + '" while status is "' + String(found.task.status ?? 'unknown') + '"; complete the task in execution first')
      }
      if (!shouldMoveTaskPhase(current, phase, options) && !directCompletedReadOnlyAccept) {
        if (options.skipIfNotForward === true) return found.task
        const guidance = phaseAdvanceGuidance(current, phase)
        refuse('task-phase', 'task "' + taskId + '" cannot advance from "' + current + '" to "' + phase + '"'
          + (guidance.detail === null ? '' : '; ' + guidance.detail))
      }
      try {
        const updated = await control().boardUpdate({
          boardId: found.boardId,
          taskId: String(taskId),
          expectedRevision: found.task.revision,
          action: 'advance_phase',
          phase,
          allowDirectAccept: directCompletedReadOnlyAccept,
        }, actor)
        policy().refreshBoards()
        return updated
      } catch (error) {
        if (attempt === 1 || !/stale revision/.test(String(error?.message ?? error))) throw error
        control().reload()
      }
    }
    return undefined
  }
  const recoverTaskPhaseForReopen = async (taskId, actor) => {
    const found = durableTask(taskId)
    if (found === undefined || found.task.phase === 'room-discussion') return
    const workKind = found.task.workKind
      ?? (Array.isArray(found.task.writeScopes) && found.task.writeScopes.length > 0 ? 'edit' : 'discussion')
    if (workKind === 'edit' && ['integrated', 'accepted'].includes(found.task.phase)) {
      await control().boardUpdate({
        boardId: found.boardId,
        taskId: String(taskId),
        expectedRevision: found.task.revision,
        action: 'recover_phase',
        phase: 'execution',
      }, actor)
      policy().refreshBoards()
      return
    }
    if (['rejected', 'cancelled', 'expired'].includes(found.task.phase)) {
      await control().boardUpdate({
        boardId: found.boardId,
        taskId: String(taskId),
        expectedRevision: found.task.revision,
        action: 'recover_phase',
        phase: 'room-discussion',
      }, actor)
      policy().refreshBoards()
      return
    }
    try { await advanceTaskPhase(taskId, 'execution', actor, { allowRollback: true }) } catch {}
  }

  const assertTaskPhaseCanAdvance = (taskId, phase) => {
    const found = durableTask(taskId)
    if (found === undefined || control().planState(String(taskId)) === undefined) return
    const current = TASK_PHASES.includes(found.task.phase) ? found.task.phase : 'draft'
    const directCompletedReadOnlyAccept = phase === 'accepted'
      && found.task.status === 'completed'
      && ['discussion', 'review'].includes(found.task.workKind)
    if (TASK_PHASES.indexOf(phase) >= TASK_PHASES.indexOf('verifier-review')
      && found.task.status !== 'completed'
      && !directCompletedReadOnlyAccept) {
      refuse('task-phase-status', 'task "' + taskId + '" cannot enter packet phase "' + phase
        + '" while status is "' + String(found.task.status ?? 'unknown') + '"; complete the task in execution first')
    }
    if (!canAdvanceTaskPhase(current, phase) && !directCompletedReadOnlyAccept) {
      const guidance = phaseAdvanceGuidance(current, phase)
      refuse('task-phase', 'task "' + taskId + '" cannot advance from "' + current + '" to "' + phase + '"'
        + (guidance.detail === null ? '' : '; ' + guidance.detail))
    }
  }
  const ensurePacketPhase = async (taskId, phase, actor) => {
    const found = durableTask(taskId)
    if (found === undefined || control().planState(String(taskId)) === undefined) return
    const order = TASK_PHASES.indexOf(phase)
    const current = TASK_PHASES.includes(found.task.phase) ? found.task.phase : 'draft'
    if (TASK_PHASES.indexOf(current) >= order) return
    if (canAdvanceTaskPhase(current, phase)) return advanceTaskPhase(taskId, phase, actor)
    const guidance = phaseAdvanceGuidance(current, phase)
    refuse('task-phase', 'task "' + taskId + '" is before packet phase "' + phase + '" and cannot advance there directly'
      + (guidance.detail === null ? '' : '; ' + guidance.detail))
  }
  const projectTask = (task, preferredBoardId, querySnapshot) => {
    const found = durableTask(task.id, preferredBoardId, querySnapshot)
    if (found === undefined) return taskViewFields(task)
    const row = found.task
    const contractVersion = taskContractRevisionProjection(row.contract, found.requirement)
    const projected = {
      ...taskViewFields(task),
      // The local control plane is authoritative for task status/phase after a
      // local-only transition; the shipped domain may still report its older
      // pending/in_progress value. Merge local status explicitly instead of
      // letting the domain snapshot win.
      subject: row.subject ?? task.subject,
      description: row.description ?? task.description,
      status: row.status ?? task.status,
      revision: row.revision ?? task.revision,
      phase: row.phase,
      ...row.blockedBy === undefined ? {} : { blockedBy: row.blockedBy },
      ...row.dependencyPhase === undefined ? {} : { dependencyPhase: row.dependencyPhase },
      ...row.writeScopes === undefined ? {} : { writeScopes: row.writeScopes },
      ...row.ready === undefined ? {} : { ready: row.ready },
      ...row.writeScopeWarnings === undefined ? {} : { writeScopeWarnings: row.writeScopeWarnings },
      ...row.ownerName === undefined ? {} : { ownerName: row.ownerName },
      ...row.commitSha === undefined ? {} : { commitSha: typeof row.commitSha === 'string' ? row.commitSha : null },
      ...typeof row.commitShaRaw !== 'string' ? {} : { commitShaRaw: row.commitShaRaw },
      ...typeof row.commitShaIssue !== 'string' ? {} : { commitShaIssue: row.commitShaIssue },
      ...row.evidenceIds === undefined ? {} : { evidenceIds: row.evidenceIds },
      ...row.workKind === undefined ? {} : { workKind: row.workKind },
      ...row.createdAt === undefined ? {} : { createdAt: row.createdAt },
      ...row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt },
      ...row.contract === null || typeof row.contract !== 'object' || Array.isArray(row.contract) ? {} : { contract: row.contract },
      ...typeof row.contractDigest !== 'string' ? {} : { contractDigest: row.contractDigest },
      ...contractVersion,
      ...typeof row.lifecycle === 'string'
        ? { lifecycle: row.lifecycle }
        : row.approved === true ? { lifecycle: 'ready' } : {},
      ...typeof row.lastReopenReason !== 'string' ? {} : { lastReopenReason: row.lastReopenReason },
      ...Number.isSafeInteger(row.lastReopenAt) ? { lastReopenAt: row.lastReopenAt } : {},
    }
    const owner = projected.ownerName
    const ownerRecord = typeof owner === 'string' && owner.length > 0 ? record(owner) : undefined
    if (ownerRecord !== undefined) {
      const branch = ownerRecord.tier === 0
        ? BRANCH_MAIN
        : ownerRecord.tier === 1
          ? groupBranch(ownerRecord.group)
          : memberBranch(ownerRecord.group, ownerRecord.name)
      projected.branch = branch
      if (typeof config.repoRoot === 'string' && config.repoRoot.length > 0 && branch !== BRANCH_MAIN) {
        projected.worktreePath = absoluteWorktreePath(config.repoRoot, config.worktreeRoot ?? '.dsh-worktrees', branch)
      }
    }
    if (Object.prototype.hasOwnProperty.call(projected, 'commitSha') && projected.commitSha !== null && typeof projected.commitSha !== 'string') {
      projected.commitSha = null
    }
    return projected
  }

  const taskQuerySnapshot = (actor, args = {}) => createTaskQuerySnapshot(
    control().snapshot({ history: false }), ctx.agentTeams.listMembers?.(actor) ?? [], args)
  const projectReady = (task, actor, preferredBoardId, query) => {
    const projected = projectTask(task, preferredBoardId, query?.snapshot)
    try {
      const ready = query ?? taskQuerySnapshot(actor)
      const row = ready.readyById.get(String(projected.id))
      if (row === undefined) return projected
      const diagnostics = readyReasonDiagnostics(row, ready.rows)
      const holdingReasons = diagnostics.readyReasons.filter((reason) => reason.code === 'write-scope-holding')
      return {
        ...projected,
        ready: row.eligible === true,
        ...row.eligible === true
          ? holdingReasons.length > 0 ? { readyReasons: holdingReasons } : {}
          : diagnostics,
      }
    } catch {
      return projected
    }
  }

  /** Resolve the caller's own record, seeding tier 0 on first use. */
  const callerRecord = () => {
    const mine = ctx.agentTeams.membership(agent)
    if (mine.role === 'lead') {
      if (record(mine.name) === undefined) policy().seedRoot(agent)
      return record(mine.name)
    }
    const found = record(mine.name)
    if (found === undefined) {
      // A teammate created before this plugin loaded: adopt it as a tier-1 peer
      // so it is never silently unrestricted.
      return policy().put({ name: mine.name, tier: 1, group: mine.name, parent: 'lead', frozen: false })
    }
    return found
  }

  /** The stable storage key for this member's Team. */
  const milestoneKey = () => teamKeyOf(ctx, agent) ?? ''
  /** Resolve the caller's Team-local milestone bucket. */
  const milestoneState = (doc) => milestoneScope(doc, milestoneKey())
  try {
    // Resolve the live service while this agent's scope is active. The prompt
    // assembler may later call text() from a disposed HMR context; touching
    // ctx.agentTeams there fails before agent/pre-step can run.
    const installedMembership = ctx.agentTeams.membership(agent)
    const installedRecord = record(installedMembership.name)
    register(scoped.systemPrompt.section({
      name: 'team:policy',
      order: scoped.systemPrompt.getSectionOrder('TEAM_POLICY'),
      text: () => {
        // This section is deliberately static for the life of the agent. Milestone
        // state and threshold reminders are appended as conversation messages in the
        // pre-step hook below. A changing system prompt invalidates the cache prefix.
        return POLICY + '\nYour Team role is ' + installedMembership.role + '; your Team name is ' + installedMembership.name
          + '; Team id is ' + installedMembership.id
          + (installedRecord ? '; tier ' + installedRecord.tier + '; group ' + installedRecord.group : '')
          + '.'
      },
    }))

    // Keep milestone state at the conversation tail, never in the prompt prefix.
    // The hook re-adds a snapshot only when the current request no longer contains
    // its stable marker, which also repairs state after a lossy compaction.
    if (typeof scoped.on === 'function') {
      register(scoped.on('agent/pre-step', async ({ agent: stepped, messages }, next) => {
        const decision = await next()
        if (decision?.kind === 'reject') return decision
        let resolved = decision
        try {
          const membership = ctx.agentTeams.membership(stepped)
          if (membership.role === 'lead') {
            const collapsed = collapseQuietBatch(resolved.messages ?? [])
            if (collapsed !== undefined) resolved = { ...resolved, messages: collapsed }
          }
          const liveControl = control()
          const turnStartedAt = activeTurnStartedAt.get(stepped)
          const privilegePending = Object.values(liveControl.view({ history: false }).privilegeRequests ?? {})
            .some((request) => request.member === membership.name
              && privilegeActivationAllowed(request, turnStartedAt))
          const activatedPrivilege = privilegePending
            ? await liveControl.privilegeActivate({ member: membership.name })
            : undefined
          if (activatedPrivilege !== undefined) {
            resolved = {
              ...resolved,
              messages: [...(resolved.messages ?? []), createUserMessage({
                content: [{ type: 'text', text: '[team privilege granted] Request ' + activatedPrivilege.requestId
                  + ' is active for THIS turn only. Allowed fail-closed bypass: ' + activatedPrivilege.blockedAction
                  + '. It expires automatically when this turn ends. Identity, cross-group, task-ownership and room rules are not bypassed.' }],
                source: { kind: 'team-message', plugin: name, form: 'notice', summary: 'team privilege granted' },
              })],
            }
          }
          const ownLease = liveControl.leaseList().find((lease) =>
            lease.member === membership.name && lease.status === 'active' && lease.taskId)
          const leaseExpiresAt = Number(ownLease?.expiresAt)
          const heartbeatDue = ownLease !== undefined
            && (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt - Date.now() < 10 * 60 * 1000)
          if (heartbeatDue) {
            try {
              await liveControl.leaseHeartbeat({
                runId: ownLease.runId,
                expiresAt: Date.now() + 30 * 60 * 1000,
              }, stepped)
            } catch {
              /* A concurrent reconciliation may have expired the lease first. */
            }
          }
          const doc = milestones(config.milestonePath)
          const state = milestoneState(doc)
          const declared = state.members[membership.name]
          // The hook payload only carries newly claimed inbox messages, not the
          // session history. Check the live model-visible surface too, otherwise a
          // snapshot would be appended again on every model step. A compaction
          // removes the marker from that surface, so the next step restores it.
          const visible = recentDerivedMessages(stepped.session)
          const foundMilestone = hasCurrentMilestoneSnapshot(stepped.session, declared,
            [...(messages ?? []), ...(resolved.messages ?? [])])
          if (declared !== undefined && !foundMilestone) {
            resolved = {
              ...resolved,
              messages: [...(resolved.messages ?? []), milestoneSnapshotMessage(declared)],
            }
          }

          const controlSnapshot = control().view({ history: false })
          const mine = record(membership.name)
          const visibleRooms = Object.values(controlSnapshot.rooms ?? {}).filter((room) =>
            mine?.tier === 0 || room.members?.includes(membership.name))
          const focused = visibleRooms
            .map((room) => compactRoomSnapshot(controlSnapshot, room.roomId, membership.name, config.maxRoomRounds))
            .filter((snapshot) => snapshot !== undefined)
            .filter(shouldInjectRoomSnapshot)
            .sort((left, right) => {
              const leftMine = left.round?.nextSpeaker === membership.name ? 1 : 0
              const rightMine = right.round?.nextSpeaker === membership.name ? 1 : 0
              return rightMine - leftMine || Number(right.revision || 0) - Number(left.revision || 0)
            })[0]
          if (focused !== undefined && !hasRoomSnapshotMessage(currentMessages, focused)) {
            resolved = {
              ...resolved,
              messages: [...(resolved.messages ?? []), roomSnapshotMessage(focused)],
            }
          }
          for (const episode of Object.values(controlSnapshot.wakeEpisodes ?? {})) {
            if (episode.target !== membership.name || !['queued', 'delivered'].includes(episode.status)) continue
            try {
              await control().wakeAcknowledge({ episodeId: episode.episodeId, status: 'turn-started' }, stepped)
            } catch {
              /* A concurrent resolution may have closed the episode first. */
            }
          }
          // A delivered downward control message is acknowledged by the target's next
          // real step. Without this the row stayed `delivered` and reconciliation later
          // rewrote it as `timed-out` even though the member had acted on it.
          if ((messages ?? []).length > 0) {
            for (const row of Object.values(controlSnapshot.dispatches ?? {})) {
              if (row.target !== membership.name || row.wakeup !== true || row.status !== 'delivered') continue
              if (row.sender === 'team-idle-watch') continue
              try {
                await control().dispatchTransition({ dispatchId: row.dispatchId, status: 'turn-started' }, stepped)
                await control().dispatchTransition({ dispatchId: row.dispatchId, status: 'completed' }, stepped)
              } catch {
                /* A concurrent reconciliation may have closed the row first. */
              }
            }
          }

          const meter = serviceOf(ctx, 'tokenMeter')
          const measured = measureSessionTokens(meter, stepped.session)
          const tokens = measured === null || measured === undefined ? undefined : measured.totalTokens
          const windowSize = config.windowTokens
          const ratio = typeof tokens === 'number' && typeof windowSize === 'number' && windowSize > 0
            ? tokens / windowSize
            : undefined
          if (ratio !== undefined) {
            // Re-read here: step-compaction may have consumed this member's job while
            // this async pre-step hook was awaiting the control plane. Saving the older
            // snapshot would resurrect a compaction that had already completed.
            const progressDoc = milestones(config.milestonePath)
            const progressState = milestoneState(progressDoc)
            const due = pendingReminder(progressState, membership.name, ratio)
            if (due !== undefined) {
              acknowledgeReminder(progressState, membership.name, due.band)
              saveMilestones(config.milestonePath, progressDoc)
              deliverThreshold(ctx, stepped, membership.name, record(membership.name), due, tokens, windowSize, progressState, membership.root)
            }
          }
        } catch (error) {
          if (ctx.logger !== undefined) {
            ctx.logger.warn?.('team milestone step delivery failed: ' + ((error && error.message) || String(error)))
          }
        }
        return resolved
      }))
      register(scoped.on('agent/status', async ({ agent: changed, status }) => {
        if (status !== 'idle') {
          if (!activeTurnStartedAt.has(changed)) activeTurnStartedAt.set(changed, Date.now())
          return
        }
        try {
          const membership = ctx.agentTeams.membership(changed)
          activeTurnStartedAt.delete(changed)
          await control().privilegeEnd({ member: membership.name, reason: 'turn ended' }, changed)
        } catch {
          /* A disposed or unregistered member has no active grant to close. */
          activeTurnStartedAt.delete(changed)
        }
      }))
    }

    register(scoped.tools.register(defineTool({
      name: 'spawn_teammate',
      description: 'Create one named, durable teammate. Tier 0 may create tier 1 (a group lead, or the single independent verifier); a tier 1 group lead may create tier 2 members until the configured Team quota is reached. Tier 2 members cannot spawn.',
      parameters: {
        name: { type: 'string', required: true, description: 'Unique lower-kebab-case teammate name.' },
        role: { type: 'string', enum: ['lead', 'verifier', 'member', 'custom'], description: 'Standing identity to dispatch: lead/verifier/member load the pre-written identity file and pin the tier and group for you; custom is the escape hatch where you write the whole prompt yourself. Defaults to custom.' },
        description: { type: 'string', description: 'Short description shown in the roster. Defaults to the role label for a built-in role.' },
        prompt: { type: 'string', description: 'For a built-in role: only the task brief — goals, deliverable, acceptance criteria, write scope. The standing identity, duties, and prohibitions are supplied by the role file. For role:"custom": the complete prompt.' },
        context: { type: 'string', enum: ['fresh', 'fork'], description: 'fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh.' },
        tier: { type: 'integer', enum: [1, 2], description: 'Requested tier. Defaults to 1 for tier 0 callers and 2 for tier 1 callers.' },
        group: { type: 'string', description: 'Group id. Tier 0 defaults it to the member name; the independent verifier group is "verifier".' },
        provider: { type: 'string', description: 'Optional LLM provider route for the new member.' },
        model: { type: 'string', description: 'Optional LLM model id for the new member.' },
        reasoning_effort: { type: 'string', description: 'Optional reasoning effort for the new member.' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: { member: { ...MEMBER_VIEW_SCHEMA, required: true } } }),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'spawn_teammate')
        assertTeamRunnable()
        const me = callerRecord()
        const context = args.context ?? 'fresh'
        const role = args.role ?? 'custom'
        const identity = readRole(role, rolesDir)
        if (role === 'custom' && (args.prompt === undefined || args.prompt.trim().length === 0)) {
          refuse('role-brief', 'role "custom" carries no standing identity, so it needs a complete prompt')
        }
        let requestedTier = args.tier ?? (me.tier === 0 ? 1 : 2)
        let group = args.group ?? (requestedTier === 1 ? args.name : me.group)
        // A built-in role pins the position outright: asking for a verifier should
        // not require restating its tier and group.
        if (role === 'verifier') { requestedTier = 1; group = 'verifier' }
        else if (role === 'lead') { requestedTier = 1; group = args.group ?? args.name }
        else if (role === 'member') { requestedTier = 2; group = me.group }
        const description = args.description ?? ROLE_LABEL[role] ?? args.name
        const brief = args.prompt ?? ''
        const promptText = identity === undefined
          ? brief
          : identity + '\n\n---\n\n# 本次任务（由你的上级下发）\n\n' + brief
        const verdict = policy().canSpawn(callerName(), requestedTier, group)
        if (!verdict.ok) refuse('tier-cap', verdict.reason)
        const lead = rootLead(ctx, caller)
        if (lead === undefined) refuse('no-lead', 'no live session Lead is available to authorize the spawn')

        const owner = callerName()
        // Authorization stays with the Lead — the domain only lets the Lead create members,
        // and passing the caller here broke group leads entirely ('only the Team Lead can
        // create teammates'). The ACTUAL spawner travels in parentName below, and the domain
        // uses that to parent the child, so a member wakes its own group lead rather than
        // the main session.
        let result
        try {
          result = await ctx.agentTeams.spawnTeammate(lead, {
          name: args.name,
          description,
          prompt: [{ type: 'text', text: promptText }],
          context,
          // Forked domain fields: the tier tree rides on the member snapshot, so it
          // survives a restart and is visible to any process reading this Team.
          level: requestedTier,
          groupId: group,
          // The real spawner. The domain resolves this name to a live agent and makes it the
          // child's subagent parent, so wake-ups follow the Team tree instead of all landing
          // on the Lead.
          parentName: owner,
          provider: context === 'fork' ? config.forkProvider : config.freshProvider,
          signal: exec.signal,
        })
        } catch (error) {
          const message = (error && error.message) || String(error)
          // The domain refuses the member past maxMembers. The model cannot see the quota, so the
          // refusal itself has to say how a slot comes back: freezing is the ONLY way to release
          // one without losing the member or its work. It is also tier-0 only, so a group lead is
          // told to ask rather than to try.
          if (/member limit|TEAM_MEMBER_LIMIT|capacity/i.test(message)) {
            const how = me.tier === 0
              ? 'You are tier 0: call freeze_member(target, frozen:true) on a member that has already finished or is idle - a frozen member stops counting against the quota and keeps its session, and freeze_member(target, frozen:false) restores it. Then retry this spawn.'
              : 'Only tier 0 may freeze: send_message(delivery:"decision", ...) to the Lead asking it to freeze a finished member, then retry this spawn. Do not keep retrying a spawn the roster cannot admit.'
            refuse('member-limit', message + '. ' + how)
          }
          throw error
        }
        const spawned = result.member.name
        policy().put({ name: spawned, tier: verdict.tier, group: verdict.group, parent: owner, role, frozen: false })
        await policy().control.countersUpdate({
          activeSlots: policy().control.counters().activeSlots + 1,
        }, caller)
        const dispatch = await policy().control.dispatchCreate({
          taskId: args.task_id,
          sender: owner,
          target: spawned,
          message: brief,
          wakeup: true,
        }, caller)
        await policy().control.dispatchTransition({ dispatchId: dispatch.dispatchId, status: 'queued' }, caller)
        await policy().control.dispatchTransition({ dispatchId: dispatch.dispatchId, status: 'delivered' }, caller)
        if (args.model !== undefined || args.provider !== undefined) {
          config.pendingRoutes.set(spawned, {
            provider: args.provider,
            model: args.model,
            ...args.reasoning_effort === undefined ? {} : { reasoningEffort: args.reasoning_effort },
          })
        }
        return { member: memberView(result.member, { tier: verdict.tier, group: verdict.group, parent: owner, frozen: false }) }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'send_message',
      description: 'Send one direct message with a mandatory delivery intent. delivery:"info" is quiet; delivery:"action" wakes an allowed peer/downward target; delivery:"decision" wakes the direct superior and requires blocked_action, reason and evidence. delivery is required even for a quiet note. wake:true is a legacy alias for action. When task_id is supplied, based_on_revision and based_on_phase are required.' ,
      parameters: {
        operation_id: { type: 'string', description: 'Optional caller operation id. Retries return durable receipts without replaying effects. Use a new id for a new event; a changed payload with the same id is refused.' },
        operation_recovery: { type: 'object', additionalProperties: false, properties: { expected_revision: { type: 'integer', required: true }, reason: { type: 'string', required: true } }, description: 'Explicit sender-scoped recovery of this same operation_id. CAS against operationRevision with an audit reason. Current ACL/task revision must still pass. Resumes known missing steps, or confirms delivery from a matching real dispatch; inflight or unconfirmed external effects are refused.' },
        target: { type: 'string', required: true, description: 'Team member name, or lead.' },
        message: { type: 'string', description: 'Self-contained message for the target. Required for info/action; optional for a decision whose blocked_action, reason and evidence already carry the request.' },
        delivery: { type: 'string', enum: ['info', 'action', 'decision'], description: 'Required. info = notify only; action = wake a peer/downward target; decision = wake the direct superior for a blocked decision.' },
        reason: { type: 'string', description: 'Required for action and decision: why the target must act now.' },
        blocked_action: { type: 'string', description: 'Required for decision: the exact action waiting on the superior.' },
        evidence: { type: 'array', items: { type: 'string' }, description: 'Required for decision: evidence proving the block or pending decision.' },
        task_id: { type: 'string' },
        based_on_revision: { type: 'integer', description: 'Required with task_id: the exact revision returned by team_task_get immediately before this message.' },
        based_on_phase: { type: 'string', description: 'Required with task_id: the exact phase returned by team_task_get immediately before this message.' },
        privilege_request_id: { type: 'string', description: 'Optional for decision: privilege request awaiting tier-0 review.' },
        urgency: { type: 'string', enum: ['normal', 'high', 'critical'], description: 'Critical is reserved for safety or data-loss risk.' },
        wake: { type: 'boolean', description: 'Deprecated compatibility alias: wake:true maps to delivery:"action". A missing delivery is otherwise refused.' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: {
        messageId: { type: 'string', required: true },
        delivery: { type: 'string', required: true, enum: ['info', 'action', 'decision'] },
        status: { type: 'string', required: true, enum: ['queued', 'delivered', 'room-summary', 'coalesced', 'delivery-failed'] },
        wakeReminder: { type: 'string', required: true },
        error: { type: 'string' },
        roomId: { type: 'string' },
        operationId: { type: 'string' },
        operationRevision: { type: 'integer' },
        duplicate: { type: 'boolean' },
        partial: { type: 'boolean' },
        externalAttempted: { type: 'boolean' },
        externalConfirmed: { type: 'boolean' },
        roundId: { type: 'string' },
        dispatchId: { type: 'string' },
        episodeId: { type: 'string' },
        coalesced: { type: 'boolean' },
        distinct: { type: 'boolean' },
        messageHash: { type: 'string' },
        pendingCount: { type: 'integer' },
        taskSnapshot: { type: 'object', additionalProperties: false, properties: {
          taskId: { type: 'string', required: true },
          revision: { type: 'integer', required: true },
          phase: { type: 'string', required: true },
          status: { type: 'string', required: true },
        } },
      } }),
      async execute(args, exec) {
        const actor = callingAgent(exec.agent, 'send_message')
        const me = record(callerName())
        const targetName = resolveTargetName(args.target)
        const message = Array.isArray(args.message)
          ? args.message.map((part) => typeof part === 'string' ? part : String(part?.text ?? '')).join('\n')
          : String(args.message ?? '')
        const whyMessage = policy().whyCannotMessage(callerName(), targetName)
        if (whyMessage !== undefined) refuse('message-scope', whyMessage)
        const targetRecord = policy().get(targetName)
        if (targetRecord !== undefined && targetRecord.frozen === true) {
          refuse('target-frozen', 'member "' + targetName + '" is frozen: it receives nothing until you restore it with freeze_member(target:"' + targetName + '", frozen:false)')
        }
        const delivery = resolveDirectDelivery(args)
        if (delivery !== 'decision' && message.trim().length === 0) {
          refuse('message-empty', 'send_message requires non-empty text for delivery:"' + delivery + '"')
        }
        const upward = targetRecord !== undefined && me !== undefined && targetRecord.tier < me.tier
        let reason = String(args.reason ?? '').trim()
        let blockedAction = String(args.blocked_action ?? '').trim()
        const evidence = Array.isArray(args.evidence) ? args.evidence.map(String).filter((row) => row.trim().length > 0) : []
        if (delivery === 'info' && (blockedAction.length > 0 || evidence.length > 0)) refuse('delivery-info-fields', 'delivery:"info" is notification-only; remove blocked_action/evidence or use delivery:"decision"')
        if (delivery === 'action') {
          assertTeamRunnable()
          if (upward) refuse('delivery-upward-decision', 'send_message delivery:"action" cannot wake a superior; use delivery:"decision" with blocked_action, reason and evidence')
          if (reason.length === 0) refuse('delivery-action-reason', 'send_message delivery:"action" requires reason: why the target must act now')
        } else if (delivery === 'decision') {
          assertTeamRunnable()
          if (me === undefined || (me.tier !== 1 && me.tier !== 2)) refuse('delivery-decision-scope', 'only tier 1 or tier 2 members may send a decision to a superior')
          const superior = me.tier === 2 ? me.parent : rootMemberName()
          if (targetName !== superior) refuse('delivery-decision-target', 'send_message delivery:"decision" must target the direct superior "' + String(superior) + '"')
          if (reason.length === 0 || blockedAction.length === 0 || evidence.length === 0) {
            refuse('delivery-decision-evidence', 'send_message delivery:"decision" requires blocked_action, reason and at least one evidence reference')
          }
        }
        const taskSnapshot = instructionTaskSnapshot(args.task_id, args.based_on_revision, args.based_on_phase)
        if (args.operation_recovery !== undefined && args.operation_id === undefined) refuse('operation-recovery-scope', 'operation_recovery requires the exact sender-scoped operation_id')
        const operation = args.operation_id === undefined ? undefined : {
          ...messageOperationIdentity({ operationId: args.operation_id, sender: callerName(), target: targetName, delivery, taskSnapshot,
            payload: { message, reason, blockedAction, evidence, urgency: args.urgency ?? null, privilegeRequestId: args.privilege_request_id ?? null } }),
          receipt: { messageId: '', delivery, status: 'queued', wakeReminder: delivery === 'info' ? SILENT_SEND_WAKE_REMINDER : 'Operation reserved; query the receipt before retrying.' },
          ...(args.operation_recovery === undefined ? {} : { recovery: args.operation_recovery }),
        }
        return runMessageOperation(control(), operation, actor, async (checkpoint, messageOperationKey, priorReceipt = {}) => {
          const noticeText = message.trim().length > 0 ? message : '[decision] ' + blockedAction
          const spec = roomSpec(callerName(), targetName)
          const { round } = priorReceipt.messageId ? { round: priorReceipt.roundId ? { roundId: priorReceipt.roundId } : null } : await ensureRoom(spec, actor)
          const posted = priorReceipt.messageId ? { messageId: priorReceipt.messageId } : await control().roomNotice({
            roomId: spec.roomId,
            roundId: round?.roundId,
            author: callerName(),
            content: noticeText,
            references: [],
            ...(messageOperationKey === undefined ? {} : { messageOperationKey }),
          }, actor)
          if (messageOperationKey !== undefined) await control().flush()
          await checkpoint({ messageId: posted.messageId, roomId: spec.roomId, ...(round?.roundId === undefined ? {} : { roundId: round.roundId }) })
          if (delivery === 'info') {
            const targetAgent = liveTeamAgent(targetName)
            const existingDispatch = priorReceipt.dispatchId ? control().dispatchGet(priorReceipt.dispatchId) : undefined
            if (existingDispatch) return { ...priorReceipt, status: existingDispatch.status === 'completed' ? 'delivered' : 'queued' }
            let delivered = priorReceipt.externalConfirmed === true
            if (!delivered) {
              await checkpoint({ externalAttempted: true })
              try {
                delivered = deliverPluginMessage(ctx, targetAgent,
                  '[team info from ' + callerName() + '] ' + message + '\n[team message id=' + posted.messageId + ']',
                  { form: 'notice', summary: message.slice(0, 120) })
              } catch {
                /* The durable dispatch row below keeps the message for reconciliation. */
              }
              await checkpoint({ externalAttempted: false, externalConfirmed: delivered })
            }
            const dispatch = await control().dispatchCreate({
              roomId: spec.roomId,
              sender: callerName(),
              target: targetName,
              message,
              ...(messageOperationKey === undefined ? {} : { messageOperationKey }),
              messageHash: hashControlValue(message),
              wakeup: false,
              status: delivered ? 'completed' : 'queued',
            }, actor)
            return {
              messageId: posted.messageId,
              delivery,
              status: infoDeliveryReceiptStatus(delivered),
              wakeReminder: SILENT_SEND_WAKE_REMINDER,
              roomId: spec.roomId,
              ...(round?.roundId === undefined ? {} : { roundId: round.roundId }),
              dispatchId: dispatch.dispatchId,
            }
          }
          const text = delivery === 'action'
            ? '[team action required] ' + callerName() + ' -> ' + targetName
              + '\nMessage: ' + message
              + '\nReason: ' + reason
              + (args.task_id === undefined ? '' : '\nTask: ' + String(args.task_id))
              + (taskSnapshot === undefined ? '' : '\nState snapshot: revision ' + String(taskSnapshot.revision) + ', phase "' + taskSnapshot.phase + '", status "' + taskSnapshot.status + '"')
              + (taskSnapshot === undefined ? '' : '\nReceipt rule: re-read team_task_get before acting. If it has advanced beyond this snapshot, report an instruction-stale receipt instead of executing the old order.')
              + (args.urgency === undefined ? '' : '\nUrgency: ' + String(args.urgency))
            : '[team decision required] ' + callerName() + ' -> ' + targetName
              + (message.length === 0 ? '' : '\nMessage: ' + message)
              + '\nBlocked action: ' + blockedAction
              + '\nReason: ' + reason
              + '\nEvidence: ' + evidence.join(' | ')
              + (args.task_id === undefined ? '' : '\nTask: ' + String(args.task_id))
              + (taskSnapshot === undefined ? '' : '\nState snapshot: revision ' + String(taskSnapshot.revision) + ', phase "' + taskSnapshot.phase + '", status "' + taskSnapshot.status + '"')
              + (taskSnapshot === undefined ? '' : '\nReceipt rule: re-read team_task_get before acting. If it has advanced beyond this snapshot, report an instruction-stale receipt instead of executing the old order.')
              + (args.privilege_request_id === undefined ? '' : '\nPrivilege request: ' + String(args.privilege_request_id))
              + (args.urgency === undefined ? '' : '\nUrgency: ' + String(args.urgency))
          const baseEpisodeId = delivery === 'action'
            ? 'team-wake:' + callerName() + ':' + targetName
            : 'superior-wake:' + callerName() + ':' + targetName
          const messageHash = hashControlValue(text)
          const priorDispatch = priorReceipt.dispatchId ? control().dispatchGet(priorReceipt.dispatchId) : undefined
          if (priorDispatch && ['delivered', 'completed'].includes(priorDispatch.status)) return { ...priorReceipt, status: 'delivered' }
          const claimed = priorDispatch ? { dispatch: priorDispatch, episodeId: priorReceipt.episodeId, claimed: false, distinct: true } : await claimWakeMessage({
            actor,
            baseEpisodeId,
            kind: 'control',
            taskId: args.task_id,
            sender: callerName(),
            target: targetName,
            messageId: posted.messageId,
            messageHash,
            text,
            messageOperationKey,
        })
        const dispatch = claimed.dispatch
        const pendingCount = Array.isArray(dispatch.pendingMessages)
          ? dispatch.pendingMessages.length
          : 0
        const base = {
          messageId: posted.messageId,
          delivery,
          wakeReminder: 'Waking delivery: the target received a control message and can start a turn.',
          roomId: spec.roomId,
          ...(round?.roundId === undefined ? {} : { roundId: round.roundId }),
          dispatchId: dispatch.dispatchId,
          episodeId: claimed.episodeId,
          coalesced: claimed.claimed === false,
          distinct: claimed.distinct === true,
          messageHash,
          pendingCount,
          ...(taskSnapshot === undefined ? {} : { taskSnapshot }),
        }
          await checkpoint({ ...base, status: 'queued' })
          if (claimed.distinct !== true) return { ...base, status: 'coalesced' }
          await checkpoint({ externalAttempted: true })
          const delivered = await deliverWake({
          actor,
          target: targetName,
          text: text + '\n[team message id=' + posted.messageId + ']',
          signal: exec.signal,
          episodeId: claimed.episodeId,
          dispatchId: dispatch.dispatchId,
          messageId: posted.messageId,
          messageHash,
          // Any live Team target can receive a direct steer. The old downward-
          // only gate forced peer and upward decisions through the core mailbox,
          // whose per-message Session.flush is the expensive path we are
          // bypassing. Inactive targets still fall back to the durable mailbox.
          allowDirect: targetRecord !== undefined,
        })
        return {
          ...base,
          status: delivered.status,
          ...(messageOperationKey === undefined ? {} : { externalAttempted: false, externalConfirmed: ['delivered', 'queued'].includes(delivered.status) }),
          ...(delivered.error === undefined ? {} : { error: String(delivered.error) }),
        }
        })
      },
    })))

    const roomOutput = {
      type: 'object',
      additionalProperties: false,
      properties: {
        roomId: { type: 'string', required: true },
        roundId: { type: 'string' },
        status: { type: 'string', required: true },
        wakeTarget: { type: 'string' },
        wakeStatus: { type: 'string' },
        wakeDispatchId: { type: 'string' },
        excludedMembers: { type: 'array', items: { type: 'string' } },
      },
    }
    const pendingRoomJoin = (roomId) => {
      const requested = String(roomId)
      const me = record(callerName())
      if (requested === 'level:1' && me?.tier === 1) return true
      const match = ROOM_KIND_PATTERNS.group.exec(requested)
      return match !== null && me?.tier === 2 && me.group === match[1]
    }
    const pendingRoomSnapshot = (roomId) => ({
      roomId,
      kind: String(roomId) === 'level:1' ? 'level' : 'group',
      status: 'not-open',
      host: String(roomId) === 'level:1'
        ? rootMemberName() ?? null
        : groupLeadName(ROOM_KIND_PATTERNS.group.exec(roomId)?.[1]) ?? null,
      members: [],
      summary: '',
      roundBudget: { used: 0, max: config.maxRoomRounds ?? 3, remaining: config.maxRoomRounds ?? 3 },
      round: null,
      decisions: [],
      unresolved: [],
      conflicts: [],
      evidence: [],
      pendingEscalations: [],
      forMember: callerName(),
      action: 'stop',
      waitAction: 'stop',
      waitInstruction: 'End this turn now. Do not call wait_agent; the room host will wake you when the round opens.',
      message: 'This room is not open yet. End this turn; the room host will wake you with a room turn when it is ready.',
    })
    register(scoped.tools.register(defineTool({
      name: 'team_room_open',
      description: 'Open or reuse a durable Team room. Rooms are the default non-waking channel for peer coordination.',
      parameters: {
        room_id: { type: 'string', required: true },
        kind: { type: 'string', required: true, enum: ['group', 'level', 'root', 'task'], description: 'Room type.' },
        title: { type: 'string', description: 'Human-readable topic.' },
        members: { type: 'array', items: { type: 'string' }, description: 'Initial member names.' },
        depends_on: { type: 'array', items: { type: 'string' }, description: 'Parent room ids whose rounds must close before this room can start a round. Group rooms infer level:1 automatically when it exists.' },
        host: { type: 'string', description: 'Optional host override. Only tier 0 may use it with replace_host:true.' },
        replace_host: { type: 'boolean', description: 'Replace the host of an existing room. Tier 0 only.' },
      },
      output: jsonOutput(roomOutput),
      async execute(args, exec) {
        const actor = callingAgent(exec.agent, 'team_room_open')
        const caller = callerName()
        const me = record(caller)
        if (me?.tier === 2) {
          refuse('room-open-scope', 'tier 2 members cannot open rooms; wait for your group lead to open and wake the round')
        }
        if (args.replace_host === true && me?.tier !== 0) {
          refuse('room-host-replace', 'only tier 0 may replace a room host')
        }
        if (args.replace_host === true && (typeof args.host !== 'string' || args.host.trim().length === 0)) {
          refuse('room-host-replace', 'replace_host requires an explicit host')
        }
        assertRoomMetadata(args.room_id, args.kind)
        const baseMembers = [...new Set([caller, ...(args.members ?? []).map(String)])]
        const requestedHost = typeof args.host === 'string' && args.host.trim().length > 0 ? args.host.trim() : undefined
        const host = requestedHost ?? explicitRoomHost(args.kind, args.room_id, caller, baseMembers)
        if (host === undefined) {
          refuse('room-host', 'room "' + args.room_id + '" has no eligible host')
        }
        const requestedMembers = [...new Set([...baseMembers, host])]
        assertKnownMembers(requestedMembers)
        const hostSeat = roomSeatVerdict(args.room_id, args.kind, record(host))
        if (!hostSeat.ok) {
          refuse('room-seat', 'host "' + host + '" cannot be seated in room "' + args.room_id + '": ' + hostSeat.reason)
        }
        const excludedMembers = []
        const members = requestedMembers.filter((name) => {
          const verdict = roomSeatVerdict(args.room_id, args.kind, record(name))
          if (!verdict.ok) excludedMembers.push(name)
          return verdict.ok
        })
        const room = await control().roomOpen({
          roomId: args.room_id,
          kind: args.kind,
          title: args.title,
          members,
          host,
          replaceHost: args.replace_host === true,
          dependsOnRooms: args.depends_on,
        }, actor)
        assertRoomAccess(room, callerName())
        for (const member of members) {
          assertRoomAdmission(room, member)
          await control().roomJoin(room.roomId, member, actor)
        }
        return {
          roomId: room.roomId,
          status: room.status,
          ...excludedMembers.length === 0 ? {} : { excludedMembers },
        }
      },
    })))
    register(scoped.tools.register(defineTool({
      name: 'team_room_join',
      description: 'Join a durable room as the current Team member.',
      parameters: { room_id: { type: 'string', required: true }, member: { type: 'string', description: 'Optional member to add; defaults to yourself.' } },
      output: jsonOutput(roomOutput),
      async execute(args, exec) {
        const actor = callingAgent(exec.agent, 'team_room_join')
        const member = args.member ?? callerName()
        const current = control().view({ history: false }).rooms?.[args.room_id]
        if (!current) {
          if (pendingRoomJoin(args.room_id)) return { roomId: args.room_id, status: 'pending' }
          refuse('room-not-found', 'no room named "' + args.room_id + '"')
        }
        if (member !== callerName() && record(callerName())?.tier !== 0 && current.host !== callerName()) {
          refuse('room-membership', 'only tier 0 or the room host may add another member to a room')
        }
        assertKnownMembers([member])
        assertRoomAdmission(current, member)
        const seat = roomSeatVerdict(current.roomId, current.kind, record(member))
        if (!seat.ok) {
          refuse('room-seat', 'member "' + member + '" cannot be seated in room "' + current.roomId + '": ' + seat.reason)
        }
        const room = await control().roomJoin(args.room_id, member, actor)
        return { roomId: room.roomId, status: room.status }
      },
    })))
    register(scoped.tools.register(defineTool({
      name: 'team_room_next',
      description: 'Start one of at most three fixed-order rounds in a room. The host is always included as a participant; when members are omitted or the host is not named, the host is appended last. Each participant gets one main turn plus at most one short clarification.',
      parameters: { room_id: { type: 'string', required: true }, topic: { type: 'string', required: true }, members: { type: 'array', items: { type: 'string' } } },
      output: jsonOutput(roomOutput),
      async execute(args, exec) {
        const actor = callingAgent(exec.agent, 'team_room_next')
        const controlSnapshot = control().view({ history: false })
        const room = controlSnapshot.rooms?.[args.room_id]
        if (!room) refuse('room-not-found', 'no room named "' + args.room_id + '"')
        assertRoomAccess(room, callerName())
        assertRoomHost(room, callerName())
        const dependency = roomDependencyVerdict(controlSnapshot, room)
        if (!dependency.ok) {
          refuse('room-dependency', 'room "' + room.roomId + '" cannot start a round because '
            + dependency.reason + '; wait for the parent round to close and wake this host')
        }
        const requested = args.members === undefined ? [...room.members] : [...new Set(args.members.map(String))]
        if (typeof room.host !== 'string' || room.host.length === 0) {
          refuse('room-host', 'room "' + room.roomId + '" has no host; reopen or repair the room before starting a round')
        }
        const candidateMembers = requested.includes(room.host) ? requested : [...requested, room.host]
        assertKnownMembers(candidateMembers)
        // Frozen and unseatable participants cannot post a main speech. Exclude
        // them from the order so the same participant set drives close quorum.
        const participantSelection = selectRoomRoundMembers({
          room,
          requested,
          memberRecord: record,
          frozen: (name) => controlSnapshot.frozenMembers?.[name]?.frozen === true,
        })
        if (!participantSelection.ok) {
          refuse(participantSelection.code, participantSelection.reason)
        }
        const { members, excludedMembers } = participantSelection
        for (const member of members) assertRoomAdmission(room, member)
        const current = room.currentRoundId === null || room.currentRoundId === undefined
          ? undefined
          : controlSnapshot.rounds?.[room.currentRoundId]
        const maxRoomRounds = Number.isFinite(config.maxRoomRounds) && config.maxRoomRounds > 0
          ? Math.floor(config.maxRoomRounds)
          : 3
        const roundsUsed = Object.values(controlSnapshot.rounds ?? {})
          .filter((row) => row?.roomId === args.room_id).length
        if (current?.status !== 'open' && roundsUsed >= maxRoomRounds) {
          refuse('round-budget', 'room "' + args.room_id + '" has used ' + String(roundsUsed) + '/'
            + String(maxRoomRounds) + ' rounds; record the unresolved items and use team_escalate instead of reopening it')
        }
        let round = current
        if (current?.status === 'open') {
          if (current.topic !== args.topic) {
            refuse('round-open', 'room "' + room.roomId + '" already has open round "' + current.roundId
              + '" for topic "' + current.topic + '"; close it before starting another')
          }
        } else {
          round = await control().roomNext({ roomId: args.room_id, topic: args.topic, members }, actor)
        }
        const wake = round?.nextSpeaker === undefined || round.nextSpeaker === null || round.nextSpeaker === callerName()
          ? undefined
          : await wakeRoomMember({
            roomId: args.room_id,
            roundId: round.roundId,
            target: round.nextSpeaker,
            phase: 'speaker',
            reason: 'Speak next in room "' + args.room_id + '" for topic "' + args.topic + '". Read the room, make one main turn with team_room_post, then END THE TURN. Do not call wait_agent.',
            signal: exec.signal,
            actor,
          })
        return {
          roomId: args.room_id,
          roundId: round.roundId,
          status: round.status,
          ...wake === undefined ? {} : { wakeTarget: wake.target, wakeStatus: wake.status, ...wake.dispatchId === undefined ? {} : { wakeDispatchId: wake.dispatchId } },
          ...excludedMembers.length === 0 ? {} : { excludedMembers },
        }
      },
    })))
    register(scoped.tools.register(defineTool({
      name: 'team_room_post',
      description: 'Post a fact, proposal, risk or question to a durable room without waking recipients.',
      parameters: {
        room_id: { type: 'string', required: true },
        round_id: { type: 'string', description: 'Active round; defaults to the room round.' },
        kind: { type: 'string', enum: ['fact', 'proposal', 'risk', 'question', 'decision-request', 'clarification'] },
        content: { type: 'string', required: true },
        references: { type: 'array', items: { type: 'string' } },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: { messageId: { type: 'string', required: true }, roomId: { type: 'string', required: true }, roundId: { type: 'string', required: true }, status: { type: 'string', required: true }, wakeTarget: { type: 'string' }, wakeStatus: { type: 'string' }, wakeDispatchId: { type: 'string' } } }),
      async execute(args, exec) {
        const actor = callingAgent(exec.agent, 'team_room_post')
        const snapshot = control().view({ history: false })
        const room = snapshot.rooms?.[args.room_id]
        if (!room) refuse('room-not-found', 'no room named "' + args.room_id + '"')
        assertRoomAccess(room, callerName())
        const roundId = args.round_id ?? room.currentRoundId
        if (!roundId) refuse('round-required', 'open a room round before posting')
        const before = snapshot.rounds?.[roundId]
        const previousNextSpeaker = before?.nextSpeaker ?? null
        const posted = await control().roomPost({
          roomId: args.room_id,
          roundId,
          author: callerName(),
          content: args.content,
          kind: args.kind ?? 'fact',
          references: args.references,
        }, actor)
        const updated = control().view({ history: false })
        const after = updated.rounds?.[roundId]
        const nextSpeaker = after?.nextSpeaker ?? null
        let wake
        if (after?.status === 'open' && nextSpeaker !== previousNextSpeaker) {
          const finalTurn = nextSpeaker === null
          wake = await wakeRoomMember({
            roomId: args.room_id,
            roundId,
            target: finalTurn ? updated.rooms?.[args.room_id]?.host : nextSpeaker,
            phase: finalTurn ? 'close' : 'speaker',
            reason: finalTurn
              ? 'Every participant has spoken in room "' + args.room_id + '". Close the round with team_room_close, summary and unresolved list, then stop.'
              : 'Speak next in room "' + args.room_id + '". Read the room, make one main turn with team_room_post, then END THE TURN. Do not call wait_agent.',
            signal: exec.signal,
            actor,
          })
        }
        return {
          messageId: posted.messageId,
          roomId: posted.roomId,
          roundId: posted.roundId,
          status: posted.kind === 'clarification' ? 'clarification' : 'accepted',
          ...wake === undefined ? {} : { wakeTarget: wake.target, wakeStatus: wake.status, ...wake.dispatchId === undefined ? {} : { wakeDispatchId: wake.dispatchId } },
        }
      },
    })))
    register(scoped.tools.register(defineTool({
      name: 'team_room_read',
      description: 'Read the compact room snapshot: current round, decisions, unresolved points, evidence, next speaker and pending escalations. Raw transcript is omitted unless explicitly requested.',
      parameters: { room_id: { type: 'string', required: true }, include_messages: { type: 'boolean', description: 'Include the raw transcript; defaults to false.' } },
      output: jsonOutput({ type: 'object', additionalProperties: true }),
      execute(args, exec) {
        callingAgent(exec.agent, 'team_room_read')
        const snapshot = control().view({ history: false })
        const room = snapshot.rooms?.[args.room_id]
        if (!room) {
          if (pendingRoomJoin(args.room_id)) return pendingRoomSnapshot(args.room_id)
          refuse('room-not-found', 'no room named "' + args.room_id + '"')
        }
        assertRoomAccess(room, callerName())
        const compact = compactRoomSnapshot(snapshot, args.room_id, callerName(), config.maxRoomRounds)
        return {
          ...compact,
          ...args.include_messages === true
            ? { messages: Array.isArray(room.messages) && room.messages.length > 0
              ? room.messages
              : Array.isArray(snapshot.roomTails?.[args.room_id]) ? snapshot.roomTails[args.room_id] : [] }
            : {},
        }
      },
    })))
    register(scoped.tools.register(defineTool({
      name: 'team_room_timeout_recover',
      description: 'Record one durable room-timeout repair event. Retry the current speaker, wake/replace the host for an awaiting-close round, or tier-0 force-close after the bounded close grace. This never reassigns tasks or wakes the whole Team.',
      parameters: {
        room_id: { type: 'string', required: true },
        round_id: { type: 'string' },
        action: { type: 'string', enum: ['retry-speaker', 'record-stall', 'wake-host', 'replace-host', 'force-close'], description: 'Retry a speaker, wake/replace the close host, record a stall, or force-close an impossible round.' },
        reason: { type: 'string', required: true, description: 'Concrete recovery or stall reason.' },
        references: { type: 'array', items: { type: 'string' } },
        new_host: { type: 'string', description: 'replace-host: a room member that accepts close responsibility.' },
        summary: { type: 'string', description: 'force-close: optional round summary; defaults to a deterministic recovery summary.' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: { roomId: { type: 'string', required: true }, roundId: { type: 'string', required: true }, speaker: { type: 'string' }, host: { type: 'string' }, status: { type: 'string', required: true }, dispatchId: { type: 'string' }, noticeId: { type: 'string' } } }),
      async execute(args, exec) {
        const actor = callingAgent(exec.agent, 'team_room_timeout_recover')
        const caller = callerName()
        const snapshot = control().view({ history: false })
        const room = snapshot.rooms?.[args.room_id]
        if (!room) refuse('room-not-found', 'no room named "' + args.room_id + '"')
        assertRoomAccess(room, caller)
        assertRoomHost(room, caller)
        const roundId = args.round_id ?? room.currentRoundId
        const round = snapshot.rounds?.[roundId]
        if (!round || round.roomId !== room.roomId || round.status !== 'open') refuse('round-required', 'room has no matching open round')
        const speaker = typeof round.nextSpeaker === 'string' ? round.nextSpeaker : ''
        const reason = String(args.reason || '').trim()
        if (!reason) refuse('recovery-reason', 'reason is required')
        const action = String(args.action || 'record-stall')
        const awaitingClose = speaker.length === 0
        if (action === 'retry-speaker' && awaitingClose) {
          refuse('round-speaker', 'room round is awaiting host close; use action:"wake-host", "replace-host", or "force-close"')
        }
        if (['wake-host', 'replace-host', 'force-close'].includes(action) && !awaitingClose) {
          refuse('round-host-close', 'host-close recovery requires an awaiting-close round')
        }
        if (action === 'replace-host') {
          if (record(caller)?.tier !== 0) refuse('room-host-replace', 'only tier 0 may replace an awaiting-close host')
          const newHost = String(args.new_host || '').trim()
          if (newHost.length === 0 || !room.members.includes(newHost)) {
            refuse('room-host-replace', 'new_host must be a joined room member')
          }
          if (control().view({ history: false }).frozenMembers?.[newHost]?.frozen === true) {
            refuse('room-host-replace', 'new_host "' + newHost + '" is frozen')
          }
        }
        if (action === 'force-close' && record(caller)?.tier !== 0) {
          refuse('room-force-close', 'only tier 0 may force-close an awaiting-close round')
        }
        const recoveryKey = '[room-timeout-recovery] round=' + round.roundId
          + (speaker.length > 0 ? ' speaker=' + speaker : ' responsibility=host-close')
        const priorRecovery = (Array.isArray(room.messages) ? room.messages : [])
          .find((message) => typeof message?.content === 'string'
            && message.content.includes(recoveryKey)
            && message.content.includes('action=' + action))
        if (priorRecovery !== undefined) {
          return { roomId: room.roomId, roundId: round.roundId, ...speaker.length > 0 ? { speaker } : {}, status: 'already-recovered', noticeId: priorRecovery.messageId }
        }
        const noticeAuthor = room.members.includes(caller) ? caller : room.host
        if (typeof noticeAuthor !== 'string' || noticeAuthor.length === 0) refuse('room-host', 'room has no durable host for the repair notice')
        const newHost = action === 'replace-host' ? String(args.new_host || '').trim() : ''
        const summary = action === 'force-close'
          ? String(args.summary || '').trim()
            || 'Recovery closed this round after every participant finished speaking and the host did not close within the bounded grace period.'
          : ''
        const notice = await control().roomNotice({
          roomId: room.roomId,
          roundId: round.roundId,
          author: noticeAuthor,
          content: recoveryKey + ' by=' + caller + ' action=' + action + ' reason=' + reason
            + (newHost.length > 0 ? ' new_host=' + newHost : ''),
          references: args.references,
        }, actor)
        if (action === 'force-close') {
          const controlSnapshot = control().view({ history: false })
          const missingSpeakers = Array.isArray(round.order)
            ? round.order.filter((member) => !round.mainSpoken.includes(member))
            : []
          const frozenMissing = missingSpeakers.filter((member) => controlSnapshot.frozenMembers?.[member]?.frozen === true)
          const unseatableMissing = missingSpeakers.filter((member) => roomSeatVerdict(room.roomId, room.kind, record(member)).ok !== true)
          const waivableMembers = unseatableMissing.length > 0
            ? [...new Set([...missingSpeakers, ...frozenMissing])]
            : [...new Set(frozenMissing)]
          const result = await control().roomClose({
            roomId: room.roomId,
            roundId: round.roundId,
            summary,
            unresolved: [],
            forceClose: missingSpeakers.length > 0,
            waivedMembers: [...new Set([...frozenMissing, ...unseatableMissing])],
            waivableMembers,
            forceCloseReason: reason,
            forceClosedBy: caller,
          }, actor)
          return {
            roomId: result.room.roomId,
            roundId: result.round.roundId,
            host: String(room.host ?? ''),
            status: 'force-closed',
            noticeId: notice.messageId,
          }
        }
        if (action === 'replace-host') {
          await control().roomOpen({ roomId: room.roomId, host: newHost, replaceHost: true }, actor)
          const wake = await wakeRoomMember({
            roomId: room.roomId,
            roundId: round.roundId,
            target: newHost,
            phase: 'close-recovery',
            reason: 'You are the replacement host for an awaiting-close round. Read the room and close it with team_room_close, then stop.',
            signal: exec.signal,
            actor,
          })
          return {
            roomId: room.roomId,
            roundId: round.roundId,
            host: newHost,
            status: wake?.status ?? 'host-replaced',
            ...wake?.dispatchId === undefined ? {} : { dispatchId: wake.dispatchId },
            noticeId: notice.messageId,
          }
        }
        if (action === 'wake-host') {
          const host = typeof room.host === 'string' && room.host.length > 0 ? room.host : caller
          const wake = await wakeRoomMember({
            roomId: room.roomId,
            roundId: round.roundId,
            target: host,
            phase: 'close-recovery',
            reason: 'Every participant has spoken. Close the round with team_room_close and a summary, then stop.',
            signal: exec.signal,
            actor,
          })
          return {
            roomId: room.roomId,
            roundId: round.roundId,
            host,
            status: wake?.status ?? 'repair-recorded',
            ...wake?.dispatchId === undefined ? {} : { dispatchId: wake.dispatchId },
            noticeId: notice.messageId,
          }
        }
        if (action !== 'retry-speaker' || speaker === caller) {
          return { roomId: room.roomId, roundId: round.roundId, speaker, status: 'repair-recorded', noticeId: notice.messageId }
        }
        const wake = await wakeRoomMember({
          roomId: room.roomId,
          roundId: round.roundId,
          target: speaker,
          phase: 'timeout-recovery',
          reason: 'One bounded retry after room timeout notice. Speak once in room "' + room.roomId + '" and end your turn.',
          signal: exec.signal,
          actor,
        })
        return { roomId: room.roomId, roundId: round.roundId, speaker, status: wake?.status ?? 'repair-recorded', ...wake?.dispatchId === undefined ? {} : { dispatchId: wake.dispatchId }, noticeId: notice.messageId }
      },
    })))
    register(scoped.tools.register(defineTool({
      name: 'team_room_close',
      description: 'Close the active room round and persist a compact summary.',
      parameters: {
        room_id: { type: 'string', required: true },
        round_id: { type: 'string' },
        summary: { type: 'string', required: true },
        unresolved: { type: 'array', items: { type: 'string' } },
        force_close: { type: 'boolean', description: 'Tier 0 only. Close despite missing speakers when every missing speaker is frozen, or when the room holds a member that cannot be seated in this room kind and the round is therefore impossible to finish.' },
        waived_members: { type: 'array', items: { type: 'string' }, description: 'Exact members waived by a forced close; must be listed in the waivable set the runtime derives.' },
        force_close_reason: { type: 'string', description: 'Audit reason required for a forced close.' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: { roomId: { type: 'string', required: true }, roundId: { type: 'string', required: true }, status: { type: 'string', required: true } } }),
      async execute(args, exec) {
        const actor = callingAgent(exec.agent, 'team_room_close')
        const room = control().view({ history: false }).rooms?.[args.room_id]
        if (!room) refuse('room-not-found', 'no room named "' + args.room_id + '"')
        const caller = callerName()
        assertRoomAccess(room, caller)
        assertRoomHost(room, caller)
        if (args.force_close === true && record(caller)?.tier !== 0) {
          refuse('room-force-close', 'only tier 0 may force-close a room round')
        }
        if (args.force_close === true && (typeof args.force_close_reason !== 'string' || args.force_close_reason.trim().length === 0)) {
          refuse('room-force-close', 'force_close requires force_close_reason')
        }
        const controlSnapshot = control().view({ history: false })
        const roundId = args.round_id ?? room.currentRoundId
        const round = roundId === null || roundId === undefined ? undefined : controlSnapshot.rounds?.[roundId]
        const missingSpeakers = Array.isArray(round?.order)
          ? round.order.filter((member) => !round.mainSpoken.includes(member))
          : []
        const frozenMissing = missingSpeakers.filter((member) => controlSnapshot.frozenMembers?.[member]?.frozen === true)
        const unseatableMissing = missingSpeakers.filter((member) => roomSeatVerdict(room.roomId, room.kind, record(member)).ok !== true)
        // A room that seats a member who can never speak cannot be finished by
        // anyone; tier 0 gets a reasoned close for that structural defect only.
        const waivableMembers = unseatableMissing.length > 0
          ? [...new Set([...missingSpeakers, ...frozenMissing])]
          : [...new Set(frozenMissing)]
        const result = await control().roomClose({
          roomId: args.room_id,
          roundId: args.round_id,
          summary: args.summary,
          unresolved: args.unresolved,
          forceClose: args.force_close === true,
          waivedMembers: args.waived_members,
          waivableMembers,
          forceCloseReason: args.force_close_reason,
          forceClosedBy: caller,
        }, actor)
        return { roomId: result.room.roomId, roundId: result.round.roundId, status: result.round.status }
      },
    })))
    register(scoped.tools.register(defineTool({
      name: 'team_room_decide',
      description: 'Record a room decision and its rationale without waking the hierarchy. Cross-group decisions must name every affected group lead in required_confirmations; the decision remains proposed until all of them confirm with team_room_confirm.',
      parameters: {
        room_id: { type: 'string', required: true },
        round_id: { type: 'string' },
        title: { type: 'string', required: true },
        choice: { type: 'string', required: true },
        rationale: { type: 'string', required: true },
        references: { type: 'array', items: { type: 'string' } },
        required_confirmations: { type: 'array', items: { type: 'string' }, description: 'Affected group leads. A single-member room may omit this for the host-confirmed compatibility path.' },
      },
      output: jsonOutput({
        type: 'object',
        additionalProperties: false,
        properties: {
          decisionId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          requiredConfirmations: { type: 'array', items: { type: 'string' } },
          missingConfirmations: { type: 'array', items: { type: 'string' } },
          confirmedBy: { type: 'string' },
        },
      }),
      async execute(args, exec) {
        const actor = callingAgent(exec.agent, 'team_room_decide')
        const room = control().view({ history: false }).rooms?.[args.room_id]
        if (!room) refuse('room-not-found', 'no room named "' + args.room_id + '"')
        assertRoomAccess(room, callerName())
        assertRoomHost(room, callerName())
        const decision = await control().roomDecision({
          roomId: args.room_id,
          roundId: args.round_id,
          title: args.title,
          choice: args.choice,
          rationale: args.rationale,
          references: args.references,
          requiredConfirmations: args.required_confirmations,
          decidedBy: callerName(),
        }, actor)
        return {
          decisionId: decision.decisionId,
          status: decision.status,
          requiredConfirmations: decision.requiredConfirmations ?? [],
          missingConfirmations: decision.missingConfirmations ?? [],
          ...decision.confirmedBy ? { confirmedBy: decision.confirmedBy } : {},
        }
      },
    })))
    register(scoped.tools.register(defineTool({
      name: 'team_room_confirm',
      description: 'Confirm a proposed Room decision as one of its named affected group leads. The decision becomes effective only after every required lead has confirmed. This does not wake the hierarchy.',
      parameters: {
        room_id: { type: 'string', required: true },
        decision_id: { type: 'string', required: true },
        rationale: { type: 'string' },
        evidence_links: { type: 'array', items: { type: 'string' } },
      },
      output: jsonOutput({
        type: 'object',
        additionalProperties: false,
        properties: {
          decisionId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          requiredConfirmations: { type: 'array', items: { type: 'string' } },
          missingConfirmations: { type: 'array', items: { type: 'string' } },
          confirmedBy: { type: 'string' },
        },
      }),
      async execute(args, exec) {
        const actor = callingAgent(exec.agent, 'team_room_confirm')
        const room = control().view({ history: false }).rooms?.[args.room_id]
        if (!room) refuse('room-not-found', 'no room named "' + args.room_id + '"')
        assertRoomAccess(room, callerName())
        const decision = await control().roomDecisionConfirm({
          roomId: args.room_id,
          decisionId: args.decision_id,
          confirmedBy: callerName(),
          rationale: args.rationale,
          evidenceLinks: args.evidence_links,
        }, actor)
        return {
          decisionId: decision.decisionId,
          status: decision.status,
          requiredConfirmations: decision.requiredConfirmations ?? [],
          missingConfirmations: decision.missingConfirmations ?? [],
          ...decision.confirmedBy ? { confirmedBy: decision.confirmedBy } : {},
        }
      },
    })))
    register(scoped.tools.register(defineTool({
      name: 'team_room_resolve',
      description: 'Resolve one previously recorded unresolved room item with a concrete outcome. The room host or tier 0 only. This keeps stale items from remaining open after downstream work lands.',
      parameters: {
        room_id: { type: 'string', required: true },
        unresolved_id: { type: 'string' },
        text: { type: 'string', description: 'Exact unresolved text when resolving a legacy or id-less item.' },
        resolution: { type: 'string', required: true, description: 'Concrete outcome or evidence proving the item is resolved.' },
      },
      output: jsonOutput({
        type: 'object',
        additionalProperties: false,
        properties: {
          roomId: { type: 'string', required: true },
          unresolvedId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          resolution: { type: 'string', required: true },
        },
      }),
      async execute(args, exec) {
        const actor = callingAgent(exec.agent, 'team_room_resolve')
        const room = control().view({ history: false }).rooms?.[args.room_id]
        if (!room) refuse('room-not-found', 'no room named "' + args.room_id + '"')
        assertRoomAccess(room, callerName())
        assertRoomHost(room, callerName())
        const result = await control().roomResolveUnresolved({
          roomId: args.room_id,
          unresolvedId: args.unresolved_id,
          text: args.text,
          resolution: args.resolution,
          resolvedBy: callerName(),
        }, actor)
        return {
          roomId: result.room.roomId,
          unresolvedId: result.item.id,
          status: result.item.status,
          resolution: result.item.resolution,
        }
      },
    })))
    register(scoped.tools.register(defineTool({
      name: 'team_escalate',
      description: 'Escalate one unresolved, evidence-backed decision. This is the only ordinary collaboration action that wakes a superior.',
      parameters: {
        category: { type: 'string', required: true, enum: ['contract-conflict', 'blocked', 'timeout', 'security', 'merge-risk', 'product-decision'] },
        summary: { type: 'string', required: true },
        decision_needed: { type: 'string', required: true },
        room_id: { type: 'string' },
        round_id: { type: 'string' },
        options: { type: 'array', items: { type: 'object', additionalProperties: true } },
        no_options_reason: { type: 'string', description: 'Required when options is empty.' },
        references: { type: 'array', items: { type: 'string' } },
        urgency: { type: 'string', enum: ['normal', 'high', 'critical'], description: 'Critical may be used for an immediate safety or data-loss risk.' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: { escalationId: { type: 'string', required: true }, dispatchId: { type: 'string', required: true }, target: { type: 'string', required: true }, status: { type: 'string', required: true } } }),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'team_escalate')
        const me = record(callerName())
        const target = me?.tier === 2 ? me.parent : me?.tier === 1 ? 'lead' : undefined
        if (!target) refuse('escalation-target', 'tier 0 has no superior; record a room decision instead')
        const room = args.room_id === undefined ? undefined : control().view({ history: false }).rooms?.[args.room_id]
        if (args.room_id !== undefined && !room) refuse('room-not-found', 'no room named "' + args.room_id + '"')
        if (room) assertRoomAccess(room, callerName())
        const urgency = args.urgency ?? 'normal'
        const options = args.options ?? []
        const references = args.references ?? []
        if (urgency !== 'critical' && options.length === 0
          && (args.no_options_reason === undefined || args.no_options_reason.trim().length === 0)) {
          refuse('escalation-options', 'a normal escalation needs at least one option or no_options_reason')
        }
        const escalation = await control().escalate({
          category: args.category,
          summary: args.summary,
          decisionNeeded: args.decision_needed,
          target,
          roomId: args.room_id,
          roundId: args.round_id,
          options,
          noOptionsReason: args.no_options_reason,
          references,
          urgency,
        }, caller)
        const episodeId = 'escalation:' + target
        const claimed = await control().wakeClaim({
          episodeId,
          roomId: args.room_id,
          sender: callerName(),
          target,
          messageHash: hashControlValue(args.summary),
          escalationId: escalation.escalationId,
        }, caller)
        const dispatch = claimed.dispatch
        await control().escalationBind({
          escalationId: escalation.escalationId,
          dispatchId: dispatch.dispatchId,
          wakeEpisodeId: episodeId,
        }, caller)
        if (claimed.claimed !== false) {
      await deliverWake({
        actor: caller,
        target,
        text: '[team escalation] ' + args.summary + '\nDecision needed: ' + args.decision_needed + '\n[team message id=' + dispatch.dispatchId + ']',
        signal: exec.signal,
        episodeId,
        dispatchId: dispatch.dispatchId,
        allowDirect: true,
      })
        }
        return {
          escalationId: escalation.escalationId,
          dispatchId: dispatch.dispatchId,
          target,
          status: claimed.claimed === false ? 'coalesced' : 'delivered',
        }
      },
    })))
    register(scoped.tools.register(defineTool({
      name: 'team_escalation_resolve',
      description: 'Resolve an escalation after its decision has been recorded. The target or tier 0 closes the wake episode only when every escalation in it is resolved.',
      parameters: {
        escalation_id: { type: 'string', required: true },
        resolution: { type: 'string', required: true },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: { escalationId: { type: 'string', required: true }, status: { type: 'string', required: true }, wakeEpisodeId: { type: 'string' } } }),
      async execute(args, exec) {
        const actor = callingAgent(exec.agent, 'team_escalation_resolve')
        const row = control().view({ history: false }).escalations?.[args.escalation_id]
        if (!row) refuse('escalation-not-found', 'no escalation named "' + args.escalation_id + '"')
        const me = record(callerName())
        if (me?.tier !== 0 && row.target !== callerName()) {
          refuse('escalation-resolve-scope', 'only the escalation target or tier 0 may resolve it')
        }
        const resolved = await control().escalationResolve({
          escalationId: args.escalation_id,
          status: 'resolved',
          resolution: args.resolution,
          resolvedBy: callerName(),
        }, actor)
        return {
          escalationId: resolved.escalationId,
          status: resolved.status,
          ...(resolved.wakeEpisodeId === null ? {} : { wakeEpisodeId: resolved.wakeEpisodeId }),
        }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_escalation_list',
      description: 'Read durable escalations with category, urgency, target, summary and decisionNeeded. Open escalations are returned by default; wake-dead-letter rows are marked automated so they do not masquerade as human decisions.',
      parameters: {
        status: { type: 'string', enum: ['open', 'all', 'queued', 'resolved', 'cancelled'] },
        category: { type: 'string' },
        urgency: { type: 'string', enum: ['normal', 'high', 'critical'] },
        target: { type: 'string' },
        limit: { type: 'integer' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: {
        total: { type: 'integer', required: true },
        returned: { type: 'integer', required: true },
        truncated: { type: 'boolean', required: true },
        openCount: { type: 'integer', required: true },
        humanDecisionCount: { type: 'integer', required: true },
        automatedNotificationCount: { type: 'integer', required: true },
        byCategory: { type: 'object', required: true, additionalProperties: true },
        escalations: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
      } }),
      async execute(args, exec) {
        callingAgent(exec.agent, 'team_escalation_list')
        const me = record(callerName())
        const rows = Object.values(control().view({ history: false }).escalations ?? {})
        return escalationView({
          rows,
          actorTier: me?.tier ?? 2,
          actorName: callerName(),
          status: args.status ?? 'open',
          category: args.category,
          urgency: args.urgency,
          target: args.target,
          limit: args.limit,
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_wake',
      description: 'Compatibility alias for send_message(delivery:"action"). Wake one exact Team target for a message that must cause action now. Upward decision wakes must use send_message(delivery:"decision") or the team_wake_superior alias. When task_id is supplied, based_on_revision and based_on_phase are required; stale snapshots are refused. A pending identical sender/target wake is coalesced.'
,
      parameters: {
        target: { type: 'string', required: true, description: 'Exact Team member name, or lead where the sender is allowed to reach it.' },
        message: { type: 'string', required: true, description: 'Self-contained actionable message for the target.' },
        reason: { type: 'string', required: true, description: 'Why the target must act now instead of receiving a quiet message.' },
        task_id: { type: 'string' },
        based_on_revision: { type: 'integer', description: 'Required with task_id: the exact revision returned by team_task_get immediately before this wake.' },
        based_on_phase: { type: 'string', description: 'Required with task_id: the exact phase returned by team_task_get immediately before this wake.' },
        urgency: { type: 'string', enum: ['normal', 'high', 'critical'], description: 'Critical is reserved for safety or data-loss risk.' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: {
        target: { type: 'string', required: true },
        status: { type: 'string', required: true, enum: ['queued', 'delivered', 'coalesced', 'delivery-failed'] },
        dispatchId: { type: 'string', required: true },
        episodeId: { type: 'string', required: true },
        error: { type: 'string' },
        coalesced: { type: 'boolean' },
        distinct: { type: 'boolean' },
        messageHash: { type: 'string' },
        pendingCount: { type: 'integer' },
        taskSnapshot: { type: 'object', additionalProperties: false, properties: {
          taskId: { type: 'string', required: true },
          revision: { type: 'integer', required: true },
          phase: { type: 'string', required: true },
          status: { type: 'string', required: true },
        } },
      } }),
      async execute(args, exec) {
          const caller = callingAgent(exec.agent, 'team_wake')
        assertTeamRunnable()
        const me = record(callerName())
        const target = resolveTargetName(args.target)
        if (me === undefined) refuse('wake-scope', 'unknown team caller')
        if (target === callerName()) refuse('wake-self', 'team_wake cannot wake the caller')
        const targetRecord = record(target)
        if (targetRecord === undefined) refuse('wake-target', 'unknown Team member "' + target + '"')
        const why = policy().whyCannotMessage(callerName(), target)
        if (why !== undefined) refuse('wake-scope', why)
        if (targetRecord.frozen === true) refuse('wake-frozen', 'member "' + target + '" is frozen and cannot be woken')
        if (targetRecord.tier < me.tier) {
          refuse('wake-upward-formal', 'upward decision wakes must use team_wake_superior with blocked_action, reason and evidence')
        }
        const message = String(args.message ?? '').trim()
        const reason = String(args.reason ?? '').trim()
        if (message.length === 0 || reason.length === 0) {
          refuse('wake-message', 'team_wake requires a message and a reason')
        }
        const taskSnapshot = instructionTaskSnapshot(args.task_id, args.based_on_revision, args.based_on_phase)
        const text = '[team wake] ' + callerName() + ' -> ' + target
          + '\nMessage: ' + message
          + '\nReason: ' + reason
          + (args.task_id === undefined ? '' : '\nTask: ' + String(args.task_id))
          + (taskSnapshot === undefined ? '' : '\nState snapshot: revision ' + String(taskSnapshot.revision) + ', phase "' + taskSnapshot.phase + '", status "' + taskSnapshot.status + '"')
          + (taskSnapshot === undefined ? '' : '\nReceipt rule: re-read team_task_get before acting. If it has advanced beyond this snapshot, report an instruction-stale receipt instead of executing the old order.')
          + (args.urgency === undefined ? '' : '\nUrgency: ' + String(args.urgency))
        const messageHash = hashControlValue(text)
        const claimed = await claimWakeMessage({
          actor: caller,
          baseEpisodeId: 'team-wake:' + callerName() + ':' + target,
          kind: 'control',
          taskId: args.task_id,
          sender: callerName(),
          target,
          messageId: 'team-wake:' + callerName() + ':' + target + ':' + messageHash.slice(0, 16),
          messageHash,
          text,
        })
        const dispatch = claimed.dispatch
        const pendingCount = Array.isArray(dispatch.pendingMessages)
          ? dispatch.pendingMessages.length
          : 0
        const base = {
          target,
          dispatchId: dispatch.dispatchId,
          episodeId: claimed.episodeId,
          coalesced: claimed.claimed === false,
          distinct: claimed.distinct === true,
          messageHash,
          pendingCount,
          ...(taskSnapshot === undefined ? {} : { taskSnapshot }),
        }
        if (claimed.distinct !== true) return { ...base, status: 'coalesced' }
        const delivered = await deliverWake({
          actor: caller,
          target,
          text: text + '\n[team message id=' + dispatch.dispatchId + ']',
          signal: exec.signal,
          episodeId: claimed.episodeId,
          dispatchId: dispatch.dispatchId,
          messageId: 'team-wake:' + callerName() + ':' + target + ':' + messageHash.slice(0, 16),
          messageHash,
          allowDirect: true,
        })
        return {
          ...base,
          status: delivered.status,
          ...(delivered.error === undefined ? {} : { error: String(delivered.error) }),
        }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_wake_superior',
      description: 'Compatibility alias for send_message(delivery:"decision"). Wake your direct superior for a decision that is actually blocked on them. A tier-2 member reaches only its own group lead; a tier-1 lead reaches tier 0. Include the blocked action, reason and evidence. When task_id is supplied, based_on_revision and based_on_phase are required; stale snapshots are refused. A pending wake for the same sender/target is coalesced.',
      parameters: {
        message: { type: 'string', description: 'Optional decision summary. The canonical send_message(delivery:"decision") form may omit it because blocked_action, reason and evidence are the required payload.' },
        blocked_action: { type: 'string', required: true, description: 'The exact action waiting on the superior.' },
        reason: { type: 'string', required: true, description: 'Why this cannot be resolved inside the group or by a normal quiet message.' },
        evidence: { type: 'array', required: true, items: { type: 'string' }, description: 'Evidence proving the block or pending decision.' },
        task_id: { type: 'string' },
        based_on_revision: { type: 'integer', description: 'Required with task_id: the exact revision returned by team_task_get immediately before this wake.' },
        based_on_phase: { type: 'string', description: 'Required with task_id: the exact phase returned by team_task_get immediately before this wake.' },
        privilege_request_id: { type: 'string', description: 'Optional privilege request awaiting tier-0 review.' },
        urgency: { type: 'string', enum: ['normal', 'high', 'critical'], description: 'Critical is reserved for safety or data-loss risk.' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: {
        target: { type: 'string', required: true },
        status: { type: 'string', required: true, enum: ['queued', 'delivered', 'coalesced', 'delivery-failed'] },
        dispatchId: { type: 'string', required: true },
        episodeId: { type: 'string', required: true },
        error: { type: 'string' },
        coalesced: { type: 'boolean' },
        distinct: { type: 'boolean' },
        messageHash: { type: 'string' },
        pendingCount: { type: 'integer' },
        taskSnapshot: { type: 'object', additionalProperties: false, properties: {
          taskId: { type: 'string', required: true },
          revision: { type: 'integer', required: true },
          phase: { type: 'string', required: true },
          status: { type: 'string', required: true },
        } },
      } }),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'team_wake_superior')
        assertTeamRunnable()
        const me = record(callerName())
        if (me === undefined || (me.tier !== 1 && me.tier !== 2)) {
          refuse('wake-superior-scope', 'only tier 1 or tier 2 members may wake a superior')
        }
        const target = me.tier === 2 ? me.parent : rootMemberName()
        if (target === undefined || target.length === 0) refuse('wake-superior-target', 'no direct superior is registered for "' + callerName() + '"')
        const superior = record(target)
        if (superior === undefined) refuse('wake-superior-target', 'direct superior "' + target + '" is not registered')
        if (superior.frozen === true) refuse('wake-superior-frozen', 'direct superior "' + target + '" is frozen and cannot be woken')
        const reason = String(args.reason ?? '').trim()
        const blockedAction = String(args.blocked_action ?? '').trim()
        const message = String(args.message ?? '').trim()
        const evidence = Array.isArray(args.evidence) ? args.evidence.map(String).filter((row) => row.trim().length > 0) : []
        if (reason.length === 0 || blockedAction.length === 0 || evidence.length === 0) {
          refuse('wake-superior-evidence', 'wake_superior requires blocked_action, reason and at least one evidence reference')
        }
        const taskSnapshot = instructionTaskSnapshot(args.task_id, args.based_on_revision, args.based_on_phase)
        const text = '[team superior wake] ' + callerName() + ' -> ' + target
          + (message.length === 0 ? '' : '\nMessage: ' + message)
          + '\nBlocked action: ' + blockedAction
          + '\nReason: ' + reason
          + '\nEvidence: ' + evidence.join(' | ')
          + (args.task_id === undefined ? '' : '\nTask: ' + String(args.task_id))
          + (taskSnapshot === undefined ? '' : '\nState snapshot: revision ' + String(taskSnapshot.revision) + ', phase "' + taskSnapshot.phase + '", status "' + taskSnapshot.status + '"')
          + (taskSnapshot === undefined ? '' : '\nReceipt rule: re-read team_task_get before acting. If it has advanced beyond this snapshot, report an instruction-stale receipt instead of executing the old order.')
          + (args.privilege_request_id === undefined ? '' : '\nPrivilege request: ' + String(args.privilege_request_id))
          + (args.urgency === undefined ? '' : '\nUrgency: ' + String(args.urgency))
        const messageHash = hashControlValue(text)
        const claimed = await claimWakeMessage({
          actor: caller,
          baseEpisodeId: 'superior-wake:' + callerName() + ':' + target,
          kind: 'control',
          taskId: args.task_id,
          sender: callerName(),
          target,
          messageId: 'superior-wake:' + callerName() + ':' + target + ':' + messageHash.slice(0, 16),
          messageHash,
          text,
        })
        const dispatch = claimed.dispatch
        const pendingCount = Array.isArray(dispatch.pendingMessages)
          ? dispatch.pendingMessages.length
          : 0
        const base = {
          target,
          dispatchId: dispatch.dispatchId,
          episodeId: claimed.episodeId,
          coalesced: claimed.claimed === false,
          distinct: claimed.distinct === true,
          messageHash,
          pendingCount,
          ...(taskSnapshot === undefined ? {} : { taskSnapshot }),
        }
        if (claimed.distinct !== true) return { ...base, status: 'coalesced' }
        const delivered = await deliverWake({
          actor: caller,
          target,
          text: text + '\n[team message id=' + dispatch.dispatchId + ']',
          signal: exec.signal,
          episodeId: claimed.episodeId,
          dispatchId: dispatch.dispatchId,
          messageId: 'superior-wake:' + callerName() + ':' + target + ':' + messageHash.slice(0, 16),
          messageHash,
          allowDirect: true,
        })
        return {
          ...base,
          status: delivered.status,
          ...(delivered.error === undefined ? {} : { error: String(delivered.error) }),
        }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_privilege_request',
        description: 'Request a one-turn fail-closed bypass. Tier 1/2 members may request it for themselves only, with the blocked action, reason and evidence. Tier 0 reviews. ' + PRIVILEGE_TURN_POLICY,
      parameters: {
        blocked_action: { type: 'string', required: true, description: 'The exact action currently refused by a fail-closed gate.' },
        reason: { type: 'string', required: true, description: 'Why this action is required and why the normal scope/plan/provider path cannot unblock it.' },
        evidence: { type: 'array', required: true, items: { type: 'string' }, description: 'Commands, refusal text, paths or IDs proving the block.' },
        task_id: { type: 'string' },
        requested_scope: { type: 'string', description: 'Optional narrow description of the one-turn bypass requested.' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: {
        requestId: { type: 'string', required: true }, member: { type: 'string', required: true },
        status: { type: 'string', required: true }, createdAt: { type: 'integer', required: true },
      } }),
      async execute(args, exec) {
        const actor = callingAgent(exec.agent, 'team_privilege_request')
        assertTeamRunnable()
        const me = record(callerName())
        if (me === undefined || (me.tier !== 1 && me.tier !== 2)) {
          refuse('privilege-request-scope', 'only tier 1 or tier 2 members may request a one-turn privilege bypass')
        }
        const request = await control().privilegeRequest({
          member: callerName(),
          requestedBy: callerName(),
          taskId: args.task_id,
          blockedAction: args.blocked_action,
          reason: args.reason,
          evidence: args.evidence,
          requestedScope: args.requested_scope,
        }, actor)
        return { requestId: request.requestId, member: request.member, status: request.status, createdAt: request.createdAt }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_privilege_review',
        description: 'Tier-0 review of a one-turn privilege request. Approve or reject with a reason. ' + PRIVILEGE_TURN_POLICY,
      parameters: {
        request_id: { type: 'string', required: true },
        decision: { type: 'string', required: true, enum: ['approve', 'reject'] },
        reason: { type: 'string' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: {
        requestId: { type: 'string', required: true }, member: { type: 'string', required: true },
        status: { type: 'string', required: true }, decision: { type: 'string', required: true },
      } }),
      async execute(args, exec) {
        const actor = callingAgent(exec.agent, 'team_privilege_review')
        const me = record(callerName())
        if (me?.tier !== 0) refuse('privilege-review-scope', 'only tier 0 may approve or reject a privilege request')
        const request = control().privilegeList().find((row) => row.requestId === args.request_id)
        if (request === undefined) refuse('privilege-not-found', 'no privilege request named "' + args.request_id + '"')
        if (request.member === callerName()) refuse('privilege-self-review', 'a member cannot approve its own privilege request')
        const updated = args.decision === 'approve'
          ? await control().privilegeApprove({ requestId: args.request_id, approvedBy: callerName() }, actor)
          : await control().privilegeReject({ requestId: args.request_id, rejectedBy: callerName(), reason: args.reason ?? '' }, actor)
        return { requestId: updated.requestId, member: updated.member, status: updated.status, decision: args.decision }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_privilege_status',
      description: 'Read privilege requests visible to the caller. Members see their own; tier 0 sees all.',
      parameters: { request_id: { type: 'string' } },
      output: jsonOutput({ type: 'array', items: { type: 'object', additionalProperties: true } }),
      execute(args, exec) {
        callingAgent(exec.agent, 'team_privilege_status')
        const me = record(callerName())
        const rows = control().privilegeList()
          .filter((row) => row.requestId === args.request_id || args.request_id === undefined)
          .filter((row) => me?.tier === 0 || row.member === callerName())
        return structuredClone(rows)
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_plan_propose',
      description: 'Create the durable execution plan for a task. Worktree setup and execution are refused until a lead approves it. An approved/rejected/blocked plan may be replaced explicitly with replace_approved:true after its active lease ends. ' + PLAN_REPLACEMENT_RECOVERY,
      parameters: {
        task_id: { type: 'string', required: true },
        requirement_id: { type: 'string', required: true },
        goal: { type: 'string', required: true },
        members: { type: 'array', required: true, items: { type: 'string' } },
        write_scopes: { type: 'array', required: true, items: { type: 'string' } },
        dependencies: { type: 'array', items: { type: 'string' } },
        options: { type: 'array', items: { type: 'object', additionalProperties: true } },
        selected_option: { type: 'string' },
        checks: { type: 'json', required: true },
        risks: { type: 'array', items: { type: 'object', additionalProperties: true } },
        rollback: { type: 'string', required: true },
        replace_approved: { type: 'boolean', description: 'Replace an existing approved/rejected/blocked plan. Requires replace_reason and no active task lease.' },
        replace_reason: { type: 'string', description: 'Why the prior plan must be replaced; required with replace_approved:true.' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: { taskId: { type: 'string', required: true }, state: { type: 'string', required: true }, proposedBy: { type: 'string', required: true } } }),
      async execute(args, exec) {
        const actor = callingAgent(exec.agent, 'team_plan_propose')
        assertTeamRunnable()
        const me = callerName()
        const members = [...new Set(args.members.map(String))]
        if (!members.includes(me)) members.push(me)
        for (const member of members) if (record(member) === undefined) refuse('plan-member', 'plan names unknown member "' + member + '"')
        const taskRow = durableTask(args.task_id)?.task
        const taskKind = taskRow?.workKind ?? (Array.isArray(taskRow?.writeScopes) && taskRow.writeScopes.length > 0 ? 'edit' : 'discussion')
        if (taskRow !== undefined && taskKind !== 'edit') {
          refuse('plan-kind', 'task "' + args.task_id + '" is a ' + taskKind + ' task; plans are only valid for edit tasks')
        }
        const controlSnapshot = control().view({ history: false })
        const activeTasks = Object.values(controlSnapshot.boards ?? {})
          .flatMap((board) => Object.values(board?.tasks ?? {}))
        const scopeVerdict = planScopeConflictVerdict(activeTasks, {
          id: args.task_id,
          taskId: args.task_id,
          owner: taskRow?.ownerName ?? me,
          writeScopes: args.write_scopes,
          worktreeId: taskRow?.worktreeId ?? null,
          lifecycle: taskRow?.lifecycle ?? taskRow?.phase ?? 'plan-proposed',
        }, {
          leases: controlSnapshot.leases ?? {},
        })
        if (scopeVerdict.ok !== true) {
          refuse(scopeVerdict.code, 'plan "' + args.task_id + '" write_scopes conflict with active task(s): '
            + JSON.stringify(scopeVerdict.conflicts))
        }
        const plan = await control().planPropose({
          taskId: TeamTaskId(args.task_id),
          requirementId: args.requirement_id,
          goal: args.goal,
          members,
          writeScopes: args.write_scopes,
          dependencies: args.dependencies,
          options: args.options,
          selectedOption: args.selected_option,
          checks: Array.isArray(args.checks)
            ? Object.fromEntries(args.checks.map((value, index) => ['check-' + String(index + 1), value]))
            : args.checks,
          risks: args.risks,
          rollback: args.rollback,
          replaceApproved: args.replace_approved === true,
          replaceReason: args.replace_reason,
          proposedBy: me,
        }, actor)
        const found = durableTask(args.task_id)
        const phaseVerdict = planProposePhaseVerdict(found?.task?.phase, args.replace_approved === true)
        if (phaseVerdict.action === 'advance') {
          await advanceTaskPhase(args.task_id, 'plan-proposed', actor)
        }
        return { taskId: plan.taskId, state: plan.state, proposedBy: plan.proposedBy }
      },
    })))
    register(scoped.tools.register(defineTool({
      name: 'team_plan_approve',
      description: 'Approve a proposed execution plan. Group leads approve plans contained in their group; cross-group plans require tier 0.',
      parameters: { task_id: { type: 'string', required: true } },
      output: jsonOutput({
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          state: { type: 'string', required: true },
          approvedBy: { type: 'string', required: true },
          changed: { type: 'boolean', required: true },
          deduplicated: { type: 'boolean', required: true },
        },
      }),
      async execute(args, exec) {
        const actor = callingAgent(exec.agent, 'team_plan_approve')
        assertTeamRunnable()
        const me = callerName()
        const mine = record(me)
        const plan = control().planState(TeamTaskId(args.task_id))
        if (!plan) refuse('plan-not-found', 'no plan exists for task "' + args.task_id + '"')
        const phaseVerdict = planApprovePhaseVerdict(durableTask(args.task_id)?.task?.phase)
        const planMembers = plan.members.map((name) => ({ name, ...(record(name) ?? {}) }))
        const approval = planApprovalVerdict(mine, { ...plan, members: planMembers }, durableTask(args.task_id)?.boardId)
        if (approval.ok !== true) refuse('plan-approval-scope', approval.reason)
        if (plan.state === 'plan-approved') {
          if (phaseVerdict.action === 'advance') await advanceTaskPhase(args.task_id, 'plan-approved', actor)
          return {
            taskId: plan.taskId,
            state: plan.state,
            approvedBy: plan.approvedBy ?? me,
            changed: false,
            deduplicated: true,
          }
        }
        if (plan.state !== 'plan-proposed') {
          refuse('plan-approval-state', 'plan "' + args.task_id + '" is ' + plan.state + ', not plan-proposed; replace it with replace_approved:true before approving')
        }
        const approved = await control().planApprove({ taskId: TeamTaskId(args.task_id), approvedBy: me }, actor)
        if (phaseVerdict.action === 'advance') await advanceTaskPhase(args.task_id, 'plan-approved', actor)
        return {
          taskId: approved.taskId,
          state: approved.state,
          approvedBy: approved.approvedBy,
          changed: true,
          deduplicated: false,
        }
      },
    })))
    register(scoped.tools.register(defineTool({
      name: 'team_plan_get',
      description: 'Read the durable plan and its approval state.',
      parameters: { task_id: { type: 'string', required: true } },
      output: jsonOutput({ type: 'object', additionalProperties: true }),
      execute(args, exec) {
        callingAgent(exec.agent, 'team_plan_get')
        const plan = control().planState(TeamTaskId(args.task_id))
        if (!plan) refuse('plan-not-found', 'no plan exists for task "' + args.task_id + '"')
        assertPlanReadAccess(plan, callerName())
        return structuredClone(plan)
      },
    })))
    register(scoped.tools.register(defineTool({
      name: 'team_dispatch_status',
      description: 'Read dispatch lifecycle and run lease state without waking anyone.',
      parameters: { dispatch_id: { type: 'string', required: true } },
      output: jsonOutput({ type: 'object', additionalProperties: true }),
      execute(args, exec) {
        callingAgent(exec.agent, 'team_dispatch_status')
        const row = control().dispatchGet(args.dispatch_id)
        if (!row) refuse('dispatch-not-found', 'no dispatch named "' + args.dispatch_id + '"')
        assertDispatchAccess(row, callerName())
        return { ...structuredClone(row), lease: row.runId ? control().leaseGet(row.runId) ?? null : null }
      },
    })))
    register(scoped.tools.register(defineTool({
      name: 'team_dispatch_update',
      description: 'Advance one durable dispatch lifecycle row from the member that owns it or from tier 0. This never wakes a recipient.',
      parameters: {
        dispatch_id: { type: 'string', required: true },
        status: { type: 'string', required: true, enum: ['queued', 'delivered', 'turn-started', 'first-observation', 'checkpointed', 'response-recorded', 'completed', 'delivery-failed', 'run-failed', 'timed-out', 'cancelled', 'expired'] },
        run_id: { type: 'string' },
        checkpoint: { type: 'string' },
        error: { type: 'string' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: true }),
      async execute(args, exec) {
        const actor = callingAgent(exec.agent, 'team_dispatch_update')
        const row = control().dispatchGet(args.dispatch_id)
        if (!row) refuse('dispatch-not-found', 'no dispatch named "' + args.dispatch_id + '"')
        const me = record(callerName())
        if (me?.tier !== 0 && row.target !== callerName() && row.sender !== callerName()) {
          refuse('dispatch-scope', 'only the dispatch target, sender or tier 0 may update "' + args.dispatch_id + '"')
        }
        const retirement = dispatchRetireVerdict({
          actorTier: me?.tier,
          currentStatus: row.status,
          nextStatus: args.status,
        })
        if (retirement.ok !== true) refuse(retirement.code, retirement.detail)
        const updated = await control().dispatchTransition({
          dispatchId: args.dispatch_id,
          status: args.status,
          ...args.run_id === undefined ? {} : { runId: args.run_id },
          ...args.checkpoint === undefined ? {} : { checkpoint: args.checkpoint },
          ...args.error === undefined ? {} : { error: args.error },
        }, actor)
        return structuredClone(updated)
      },
    })))
    register(scoped.tools.register(defineTool({
      name: 'team_control_status',
      description: 'Read the compact durable Team control-plane snapshot for dashboards and recovery decisions.',
      parameters: {},
      output: jsonOutput({ type: 'object', additionalProperties: true }),
      async execute(_args, exec) {
        const actor = callingAgent(exec.agent, 'team_control_status')
        await control().reconcileDispatches({}, actor)
        const snapshot = control().view({ history: false })
        const me = callerName()
        const mine = record(me)
        const visibleRooms = mine?.tier === 0
          ? Object.values(snapshot.rooms ?? {})
          : Object.values(snapshot.rooms ?? {}).filter((room) => room.members?.includes(me))
        const visibleRoomIds = new Set(visibleRooms.map((room) => room.roomId))
        const visibleDispatches = mine?.tier === 0
          ? Object.values(snapshot.dispatches ?? {})
          : Object.values(snapshot.dispatches ?? {}).filter((row) => row.sender === me || row.target === me || (row.roomId && visibleRoomIds.has(row.roomId)))
        const visiblePlans = mine?.tier === 0
          ? Object.values(snapshot.plans ?? {})
          : Object.values(snapshot.plans ?? {}).filter((plan) => plan.members?.includes(me))
        const milestoneState = milestoneScope(milestones(config.milestonePath), milestoneKey())
        const nowValue = Date.now()
        const deadLetters = deadLetterRows(snapshot.dispatches, { now: nowValue })
        const openDeadLetters = deadLetters.filter((row) => !['superseded', 'resolved'].includes(row.status))
        const deadLetterBreakdown = deadLetterCounts(deadLetters)
        return {
          rootId: snapshot.rootId,
          revision: snapshot.revision,
          health: snapshot.health,
          provider: snapshot.provider,
          counters: snapshot.counters,
          rooms: visibleRooms.map((room) => ({
            roomId: room.roomId,
            kind: room.kind,
            status: room.status,
            host: room.host,
            currentRoundId: room.currentRoundId,
            members: room.members,
            round: room.currentRoundId === null ? null : snapshot.rounds?.[room.currentRoundId] ?? null,
            unresolved: room.unresolved ?? [],
          })),
          dispatches: visibleDispatches.map((row) => ({
            dispatchId: row.dispatchId,
            taskId: row.taskId,
            roomId: row.roomId,
            sender: row.sender,
            target: row.target,
            status: row.status,
            createdAt: row.createdAt,
            deadlineAt: row.deadlineAt,
            queueAgeMs: ['queued', 'delivered'].includes(row.status) ? Math.max(0, nowValue - Number(row.createdAt || nowValue)) : 0,
            attempt: row.attempt,
            firstCheckpoint: row.firstCheckpoint,
            lastCheckpoint: row.lastCheckpoint,
            lastError: row.lastError,
            mergedCount: row.mergedCount,
            pendingCount: Array.isArray(row.pendingMessages) ? row.pendingMessages.length : 0,
            latestMessageId: row.pendingMessages?.at(-1)?.messageId ?? null,
            deadLetter: row.deadLetter ?? null,
          })),
          wakeEpisodes: Object.values(snapshot.wakeEpisodes ?? {}).map((episode) => ({
            episodeId: episode.episodeId,
            target: episode.target,
            status: episode.status,
            mergedCount: episode.mergedCount,
            pendingCount: Array.isArray(episode.pendingMessages) ? episode.pendingMessages.length : 0,
            latestMessageId: episode.latestMessageId ?? null,
            latestMessageHash: episode.latestMessageHash ?? null,
            escalationIds: episode.escalationIds,
            updatedAt: episode.updatedAt,
          })),
          deadLetterCount: deadLetters.length,
          peerDeadLetterCount: deadLetterBreakdown.peerMessage,
          systemDeadLetterCount: deadLetterBreakdown.systemNotification,
          openDeadLetterCount: openDeadLetters.length,
          oldestDeadLetterAgeMs: openDeadLetters.reduce((oldest, row) => Math.max(oldest, Number(row.ageMs ?? 0)), 0),
          oldestPeerDeadLetterAgeMs: deadLetterBreakdown.oldestPeerAgeMs,
          deadLetters: deadLetters.slice(0, 20),
          plans: visiblePlans.map((plan) => ({ taskId: plan.taskId, state: plan.state, approvedBy: plan.approvedBy })),
          pendingCompactions: Object.entries(milestoneState.compactions ?? {})
            .filter(([, row]) => row?.status !== 'compacted')
            .map(([member, row]) => ({
              member,
              status: row?.status ?? 'pending',
              attempts: row?.attempts ?? 0,
              trigger: row?.trigger ?? row?.reason ?? 'milestone',
              ratio: typeof row?.ratio === 'number' ? row.ratio : null,
              tokens: typeof row?.tokens === 'number' ? row.tokens : null,
              windowTokens: typeof row?.windowTokens === 'number' ? row.windowTokens : null,
              requestedAt: row?.requestedAt ?? null,
            })),
          ...readProfileHealth(config) === undefined ? {} : { profileHealth: readProfileHealth(config) },
        }
      },
    })))
    register(scoped.tools.register(defineTool({
      name: 'team_provider_resume',
      description: 'Clear a durable provider block after the operator has restored credentials or quota. Tier 0 only.',
      parameters: {},
      output: jsonOutput({ type: 'object', additionalProperties: true }),
      async execute(_args, exec) {
        const actor = callingAgent(exec.agent, 'team_provider_resume')
        const me = record(callerName())
        if (me?.tier !== 0) refuse('tier-0-only', 'only tier 0 may resume a provider-blocked Team')
        return structuredClone(await control().providerResume({ resumedBy: callerName() }, actor))
      },
    })))
    register(scoped.tools.register(defineTool({
      name: 'team_compaction_reconcile',
      description: 'Tier-0 bookkeeping repair for milestone compaction jobs. Retires jobs whose milestone revision can no longer be proven complete, so stale pending jobs cannot fold a later milestone. It never folds context and never changes a live milestone.',
      parameters: {},
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: {
        changed: { type: 'integer', required: true },
        pending: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          member: { type: 'string', required: true },
          status: { type: 'string', required: true },
          milestoneSetAt: { type: 'integer' },
        } } },
      } }),
      async execute(_args, exec) {
        callingAgent(exec.agent, 'team_compaction_reconcile')
        const me = record(callerName())
        if (me === undefined || me.tier !== 0) refuse('tier-0-only', 'only tier 0 may reconcile milestone compaction jobs')
        const doc = milestones(config.milestonePath)
        const changed = pruneStaleMilestoneCompactions(doc)
        saveMilestones(config.milestonePath)
        const state = milestoneState(doc)
        const pending = Object.entries(state.compactions ?? {})
          .filter(([, row]) => ['pending-idle', 'retryable', 'compacting'].includes(String(row?.status)))
          .map(([member, row]) => ({
            member,
            status: String(row.status),
            ...typeof row.milestoneSetAt === 'number' ? { milestoneSetAt: row.milestoneSetAt } : {},
          }))
        return { changed, pending }
      },
    })))
    register(scoped.tools.register(defineTool({
      name: 'team_run_lease',
      description: 'Acquire, heartbeat or release the one active execution lease for the current member.',
      parameters: {
        action: { type: 'string', required: true, enum: ['acquire', 'heartbeat', 'release'] },
        run_id: { type: 'string' },
        task_id: { type: 'string' },
        checkpoint: { type: 'string' },
        expires_at: { type: 'integer' },
        dispatch_id: { type: 'string' },
        status: { type: 'string', enum: ['completed', 'blocked', 'cancelled', 'expired', 'failed'] },
        error: { type: 'string' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: true }),
      async execute(args, exec) {
        const actor = callingAgent(exec.agent, 'team_run_lease')
        const me = callerName()
        const activeRunId = () => {
          if (typeof args.run_id === 'string' && args.run_id.trim().length > 0) return args.run_id
          const leases = control().leaseList().filter((row) => row.member === me)
          const active = leases.filter((row) => leaseReleaseStateVerdict(row).ok === true)
          if (active.length === 1) return active[0].runId
          if (active.length === 0) {
            const expired = leases.filter((row) => leaseReleaseStateVerdict(row).code === 'lease-expired')
            if (expired.length > 0) {
              const verdict = leaseReleaseStateVerdict(expired[0])
              refuse(verdict.code, verdict.detail)
            }
            refuse('lease-not-found', 'no active run lease belongs to "' + me + '"; pass run_id explicitly')
          }
          refuse('lease-ambiguous', 'multiple active run leases belong to "' + me + '"; pass run_id explicitly: ' + active.map((row) => row.runId).join(', '))
        }
        let lease
        if (args.action === 'acquire') {
          assertTeamRunnable()
          const taskRow = args.task_id === undefined ? undefined : durableTask(args.task_id)?.task
          const taskKind = taskRow?.workKind ?? (Array.isArray(taskRow?.writeScopes) && taskRow.writeScopes.length > 0 ? 'edit' : 'discussion')
          let preservedTrackedUnstaged = []
          if (args.task_id && taskKind === 'edit') {
            const approvedPlan = control().planRequireApproved(TeamTaskId(args.task_id))
            const membership = record(me)
            const repo = repositoryRoot(exec.agent, undefined, approvedPlan)
            const syncPlan = memberWorktreeSyncPlan(membership, taskRow, repo, config.worktreeRoot, me)
            if (syncPlan !== null) {
              const synced = worktreeAdd(repo, syncPlan.path, syncPlan.branch, BRANCH_MAIN, undefined, false, {
                allowTrackedUnstaged: true,
              })
              if (synced.ok !== true) {
                const syncDiagnostics = [
                  synced.behind === undefined || synced.behind === null ? null : 'behind=' + String(synced.behind),
                  synced.dirtyCount === undefined ? null : 'dirty=' + String(synced.dirtyCount),
                  synced.head ? 'head=' + String(synced.head) : null,
                  synced.baseSha ? 'baseSha=' + String(synced.baseSha) : null,
                ].filter(Boolean).join(', ')
                refuse('worktree-sync-failed', 'member "' + me + '" cannot acquire lease for task "' + args.task_id
                  + '": worktree "' + syncPlan.path + '" could not be synchronized with "' + BRANCH_MAIN
                  + '"; ' + (syncDiagnostics.length > 0 ? syncDiagnostics + '; ' : '')
                  + String(synced.detail ?? synced.code)
                  + (synced.nextStep ? '; nextStep=' + String(synced.nextStep) : '')
                  + '; bounded recovery=team_worktree_setup(target:"' + me + '", task_id:"' + String(args.task_id)
                  + '", base:"' + BRANCH_MAIN + '", conflict_strategy:"base|worktree", expected_head:"'
                  + String(synced.head ?? '<head>') + '", expected_base:"' + String(synced.baseSha ?? '<baseSha>') + '")')
              }
              preservedTrackedUnstaged = Array.isArray(synced.preservedTrackedUnstaged)
                ? synced.preservedTrackedUnstaged
                : []
              if (taskRow?.worktreePath !== synced.path) {
                await control().boardSetWorktree({ taskId: String(args.task_id), worktreePath: String(synced.path) }, actor)
                policy().refreshBoards()
              }
            }
          }
          const contractRevision = Number(taskRow?.contract?.contractRevision ?? taskRow?.contractRevision)
          lease = await control().leaseAcquire({
            member: me,
            taskId: args.task_id,
            dispatchId: args.dispatch_id,
            expiresAt: args.expires_at,
            ...(Number.isInteger(contractRevision) && contractRevision >= 1 ? { contractRevision } : {}),
          }, actor)
          if (preservedTrackedUnstaged.length > 0) {
            lease = { ...lease, preservedTrackedUnstaged }
          }
          if (args.dispatch_id) {
            await control().dispatchTransition({ dispatchId: args.dispatch_id, status: 'turn-started', runId: lease.runId }, actor)
          }
          if (args.task_id && taskKind === 'edit') {
            await advanceTaskPhase(args.task_id, 'execution', actor, { skipIfNotForward: true })
          }
        } else if (args.action === 'heartbeat') {
          const runId = activeRunId()
          const existing = control().leaseGet(runId)
          const taskRow = existing?.taskId === undefined ? undefined : durableTask(existing.taskId)?.task
          const contractRevision = Number(taskRow?.contract?.contractRevision ?? taskRow?.contractRevision)
          lease = await control().leaseHeartbeat({
            runId,
            checkpoint: args.checkpoint,
            expiresAt: args.expires_at,
            ...(Number.isInteger(contractRevision) && contractRevision >= 1 ? { contractRevision } : {}),
          }, actor)
          const linked = lease.dispatchId
          if (linked) {
            await control().dispatchTransition({ dispatchId: linked, status: 'checkpointed', runId: lease.runId, checkpoint: args.checkpoint }, actor)
          }
        } else {
          const runId = activeRunId()
          const existing = control().leaseGet(runId)
          if (existing === undefined) refuse('lease-not-found', 'unknown run lease "' + String(runId) + '"')
          const leaseState = leaseReleaseStateVerdict(existing)
          if (leaseState.ok !== true) refuse(leaseState.code, leaseState.detail)
          const releaseStatus = args.status ?? 'completed'
          const task = existing.taskId ? durableTask(existing.taskId)?.task : undefined
          let releaseError = args.error
          if (releaseStatus === 'completed' && existing.taskId) {
            const order = leaseReleaseOrderVerdict(task, releaseStatus, control().view({ history: false }))
            if (order.ok !== true) refuse(order.code, order.reason)
            if (order.residual === true && releaseError === undefined) releaseError = order.detail
          }
          if (releaseStatus === 'blocked') {
            const verdict = blockedLeaseReleaseVerdict(task, control().view({ history: false }))
            if (verdict.ok !== true) refuse(verdict.code, verdict.reason)
            releaseError = releaseError ?? 'task is blocked by a named dependency; lease released without completion'
          }
          lease = await control().leaseRelease({ runId, status: releaseStatus, error: releaseError }, actor)
          if (lease.dispatchId) {
            const dispatchStatus = lease.status === 'completed' ? 'completed'
              : lease.status === 'cancelled' ? 'cancelled'
                : lease.status === 'expired' ? 'expired' : 'run-failed'
            await control().dispatchTransition({ dispatchId: lease.dispatchId, status: dispatchStatus, runId: lease.runId, error: releaseError }, actor)
          }
        }
        return structuredClone(lease)
      },
    })))
    register(scoped.tools.register(defineTool({
      name: 'team_evidence_record',
      description: 'Record a reproducible command, output, screenshot or resource scan in the durable evidence ledger.',
      parameters: {
        task_id: { type: 'string' },
        commit_sha: { type: 'string' },
        requirement_id: { type: 'string' },
        kind: { type: 'string', required: true },
        command: { type: 'string' },
        expected: { type: 'string' },
        actual: { type: 'string' },
        output: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' } },
        classification: { type: 'string' },
        status: { type: 'string' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: true }),
      async execute(args, exec) {
        const actor = callingAgent(exec.agent, 'team_evidence_record')
        assertEvidenceTaskAccess(args.task_id)
        const row = await control().evidencePut({ taskId: args.task_id, commitSha: args.commit_sha, requirementId: args.requirement_id, kind: args.kind, command: args.command, expected: args.expected, actual: args.actual, output: args.output, paths: args.paths, classification: args.classification, status: args.status, recordedBy: callerName() }, actor)
        const persisted = control().view({ history: false }).evidence?.[row.evidenceId]
        if (persisted === undefined || String(persisted.evidenceId) !== String(row.evidenceId)) {
          refuse('evidence-persistence', 'evidence_record returned "' + String(row.evidenceId) + '" but an independent control-plane read could not find it; no completion pointer was returned')
        }
        return structuredClone(row)
      },
    })))
    register(scoped.tools.register(defineTool({
      name: 'team_acceptance_packet',
      description: 'Submit one aggregated acceptance packet. Permission: group-acceptance requires a tier-1 group lead, verifier-review requires the independent verifier, final-acceptance requires tier 0. A task already beyond the packet phase is accepted without phase rollback.',
      parameters: {
        kind: { type: 'string', required: true, enum: ['group-acceptance', 'verifier-review', 'final-acceptance'] },
        group: { type: 'string' },
        task_ids: { type: 'array', required: true, items: { type: 'string' } },
        commit_sha: { type: 'string', required: true },
        requirements: { type: 'array', required: true, items: { type: 'string' } },
        checks: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        files: { type: 'array', required: true, items: { type: 'string' } },
        screenshots: { type: 'array', items: { type: 'string' } },
        resource_scan: { type: 'object', additionalProperties: true },
        risks: { type: 'array', items: { type: 'object', additionalProperties: true } },
        blockers: { type: 'array', items: { type: 'object', additionalProperties: true } },
        meta: { type: 'object', additionalProperties: true, description: 'Caller-defined packet metadata. packetVersion, revision, supersedes and contentDigest are platform-injected; see docs/agent-team-packet-meta-contract.md for the digest input.' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: true }),
      async execute(args, exec) {
        const actor = callingAgent(exec.agent, 'team_acceptance_packet')
        const allowedKeys = new Set([
          'kind', 'group', 'task_ids', 'commit_sha', 'requirements', 'checks', 'files',
          'screenshots', 'resource_scan', 'risks', 'blockers', 'meta',
        ])
        const unknownKeys = Object.keys(args).filter((key) => !allowedKeys.has(key))
        if (unknownKeys.length > 0) {
          refuse('packet-unknown-fields',
            'team_acceptance_packet refuses unknown top-level fields instead of silently dropping them: '
            + unknownKeys.join(', ') + '; put non-schema evidence in checks/resource_scan/meta')
        }
        const me = callerName()
        const mine = record(me)
        if (args.kind === 'group-acceptance' && mine?.tier !== 1) refuse('packet-scope', 'only a group lead may submit a group acceptance packet')
        if (args.kind === 'verifier-review' && mine?.group !== 'verifier') refuse('packet-scope', 'only the independent verifier may submit a verifier review packet')
        if (args.kind === 'final-acceptance' && mine?.tier !== 0) refuse('packet-scope', 'only tier 0 may submit the final acceptance packet')
        if (args.kind === 'group-acceptance') {
          const group = String(args.group ?? mine?.group ?? '').trim()
          const repo = repositoryRoot(exec.agent)
          const tip = runGit(repo, ['rev-parse', '--verify', groupBranch(group)])
          if (tip.code !== 0) {
            refuse('packet-group-branch-missing', 'cannot resolve group branch "' + groupBranch(group) + '" for this acceptance packet')
          }
          const commitVerdict = acceptanceCommitVerdict({
            commitSha: args.commit_sha,
            groupTip: tip.stdout.trim(),
          })
          if (commitVerdict.ok !== true) refuse(commitVerdict.code, commitVerdict.detail)
        }
        const phaseBeforePacket = args.kind === 'group-acceptance'
          ? 'group-check'
          : args.kind === 'verifier-review'
            ? 'verifier-review'
            : 'accepted'
        for (const taskId of args.task_ids) await ensurePacketPhase(taskId, phaseBeforePacket, actor)
        const packetId = 'packet-' + hashControlValue({
          kind: args.kind,
          group: args.group ?? mine?.group ?? null,
          taskIds: [...args.task_ids].map(String).sort(),
          commitSha: args.commit_sha,
        }).slice(0, 24)
        if (args.kind === 'final-acceptance') {
          const reviews = control().packetList('verifier-review').filter((row) =>
            String(row.commitSha) === String(args.commit_sha)
            && args.task_ids.every((taskId) => row.taskIds.includes(String(taskId)))
            && (!Array.isArray(row.blockers) || row.blockers.length === 0))
          if (reviews.length === 0) {
            refuse('verifier-review-required',
              'final acceptance requires one verifier-review packet for the same task set and commit with no blockers')
          }
        }
        const packet = await control().packetPut({
          packetId,
          kind: args.kind,
          group: args.group ?? mine?.group,
          taskIds: args.task_ids,
          commitSha: args.commit_sha,
          requirements: args.requirements,
          checks: args.checks,
          files: args.files,
          screenshots: args.screenshots,
          resourceScan: args.resource_scan,
          risks: args.risks,
          blockers: args.blockers,
          meta: args.meta,
          submittedBy: me,
        }, actor)
        let rootEscalation
        if (args.kind === 'verifier-review') {
          const findings = verifierReviewEscalations({
            checks: args.checks,
            blockers: args.blockers,
          })
          if (findings.length > 0) {
            const root = policy().all().find((member) =>
              member.tier === 0 && member.frozen !== true)
            if (root === undefined || !policy().canMessage(me, root.name)) {
              rootEscalation = {
                target: root?.name ?? null,
                status: 'unavailable',
                findings: findings.length,
              }
            } else {
              const text = '[team verifier escalation] packet=' + packet.packetId
                + ' commit=' + String(args.commit_sha)
                + ' tasks=' + [...args.task_ids].map(String).sort().join(',')
                + '\n' + findings.slice(0, 50).map((finding) =>
                  finding.severity + ': ' + finding.text
                  + (finding.location.length > 0 ? ' [' + finding.location + ']' : '')
                  + ' (' + finding.source + ')').join('\n')
              const messageHash = hashControlValue({
                packetId: packet.packetId,
                findings,
              })
              const claimed = await claimWakeMessage({
                actor,
                baseEpisodeId: 'verifier-escalation:' + packet.packetId,
                kind: 'control',
                taskId: args.task_ids.length === 1 ? String(args.task_ids[0]) : undefined,
                sender: me,
                target: root.name,
                messageId: packet.packetId,
                messageHash,
                text,
              })
              const dispatch = claimed.dispatch
              if (claimed.distinct === true) {
                const delivered = await deliverWake({
                  actor,
                  target: root.name,
                  text,
                  signal: exec.signal,
                  episodeId: claimed.episodeId,
                  dispatchId: dispatch.dispatchId,
                  messageId: packet.packetId,
                  messageHash,
                  allowDirect: true,
                })
                rootEscalation = {
                  target: root.name,
                  status: delivered.status,
                  findings: findings.length,
                  dispatchId: dispatch.dispatchId,
                  episodeId: claimed.episodeId,
                }
              } else {
                rootEscalation = {
                  target: root.name,
                  status: 'coalesced',
                  findings: findings.length,
                  dispatchId: dispatch.dispatchId,
                  episodeId: claimed.episodeId,
                }
              }
            }
          }
        }
        let verifierWake
        if (args.kind === 'group-acceptance') {
          const verifier = policy().all().find((member) =>
            member.group === 'verifier' || member.role === 'verifier')
          if (verifier !== undefined && verifier.frozen !== true) {
            const verifierText = '[team verifier handoff] Group acceptance packet ' + packet.packetId
              + ' is ready. group=' + String(packet.group ?? mine?.group ?? '')
              + ' commit=' + String(args.commit_sha)
              + ' tasks=' + [...args.task_ids].map(String).sort().join(',')
              + '. Review the exact commit and task set; submit one verifier-review packet with CLEARED/blockers.'
            const verifierDedupe = hashControlValue({
              kind: 'group-acceptance',
              group: packet.group ?? mine?.group ?? null,
              taskIds: [...args.task_ids].map(String).sort(),
              commitSha: args.commit_sha,
            })
            const messageHash = verifierDedupe
            const claimed = await claimWakeMessage({
              actor,
              baseEpisodeId: 'acceptance-verifier:' + verifierDedupe.slice(0, 24),
              kind: 'control',
              taskId: args.task_ids.length === 1 ? String(args.task_ids[0]) : undefined,
              sender: me,
              target: verifier.name,
              messageId: packet.packetId,
              messageHash,
              text: verifierText,
            })
            const dispatch = claimed.dispatch
            if (claimed.distinct === true) {
              const delivered = await deliverWake({
                actor,
                target: verifier.name,
                text: verifierText + '\n[team message id=' + packet.packetId + ']',
                signal: exec.signal,
                episodeId: claimed.episodeId,
                dispatchId: dispatch.dispatchId,
                messageId: packet.packetId,
                messageHash,
                allowDirect: true,
              })
              verifierWake = {
                target: verifier.name,
                status: delivered.status,
                dispatchId: dispatch.dispatchId,
                episodeId: claimed.episodeId,
              }
            } else {
              verifierWake = {
                target: verifier.name,
                status: 'coalesced',
                dispatchId: dispatch.dispatchId,
                episodeId: claimed.episodeId,
              }
            }
          } else {
            verifierWake = { target: null, status: 'unavailable' }
          }
        }
        for (const taskId of args.task_ids) {
          await ensurePacketPhase(taskId, phaseBeforePacket, actor)
          if (args.kind === 'verifier-review' && (!Array.isArray(args.blockers) || args.blockers.length === 0)) {
            await ensurePacketPhase(taskId, 'integration-ready', actor)
          }
        }
        const dispatches = [rootEscalation?.dispatchId, verifierWake?.dispatchId]
          .filter((value) => typeof value === 'string' && value.length > 0)
        return {
          ...structuredClone(packet),
          dispatched: dispatches.length > 0,
          dispatches,
          ...(rootEscalation === undefined ? {} : { rootEscalation }),
          ...(verifierWake === undefined ? {} : { verifierWake }),
        }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'list_agents',
      description: 'List active Team members visible to you. Frozen members are hidden by default; set include_frozen:true only to inspect or restore them. Group isolation is enforced.',
      parameters: { include_frozen: { type: 'boolean', description: 'Include frozen members. Defaults to false.' } },
      output: jsonOutput({ type: 'array', items: MEMBER_VIEW_SCHEMA }),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'list_agents')
        policy().refreshFrozen()
        policy().refreshBoards()
        const me = callerName()
        const mine = ctx.agentTeams.membership(caller).name
        // Tier 0 sees the WHOLE roster. It is the only member that can freeze, restore or
        // route anyone, and it is the one that has to account for the team at delivery, so
        // a visibility rule that hid tier 2 from it made those powers unusable: a real run
        // saw the Lead guessing names (c1, c-forge, c-artist...) and refusing them all.
        // This widens the MANAGEMENT view only. Message scope is untouched: tier 0 still
        // talks to tier 1 alone, which is what "0 only talks to 1" was ever about.
        const seesAll = me !== undefined && record(me) !== undefined && record(me).tier === 0
        return ctx.agentTeams.listMembers(caller)
          .filter((member) => seesAll || member.name === mine || member.role === 'lead' || policy().canSee(me, member.name))
          .filter((member) => args.include_frozen === true || record(member.name)?.frozen !== true)
          .map((member) => memberView(member, record(member.name)))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_member_reparent',
      description: 'Tier 0 transfers an existing tier-2 member to a replacement tier-1 lead in the same group. The override is persisted and changes message, interrupt, milestone and merge authority without rewriting the member session lineage.',
      parameters: {
        member: { type: 'string', required: true, description: 'Existing tier-2 member name.' },
        parent: { type: 'string', required: true, description: 'Replacement tier-1 lead name.' },
        reason: { type: 'string', required: true, description: 'Audit reason for the transfer.' },
      },
      output: jsonOutput({
        type: 'object',
        additionalProperties: false,
        properties: {
          member: { type: 'string', required: true },
          parent: { type: 'string', required: true },
          previousParent: { type: 'string' },
          changed: { type: 'boolean', required: true },
        },
      }),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'team_member_reparent')
        const me = callerName()
        const mine = record(me)
        if (mine?.tier !== 0) refuse('member-reparent-scope', 'only tier 0 may transfer a member to another lead')
        const memberName = String(args.member ?? '').trim()
        const parentName = String(args.parent ?? '').trim()
        const reason = String(args.reason ?? '').trim()
        if (reason.length === 0) refuse('member-reparent-reason', 'reason is required')
        const member = record(memberName)
        const parent = record(parentName)
        if (member === undefined) refuse('member-reparent-member', 'unknown member "' + memberName + '"')
        if (parent === undefined) refuse('member-reparent-parent', 'unknown lead "' + parentName + '"')
        if (member.tier !== 2) refuse('member-reparent-tier', 'member "' + memberName + '" is not tier 2')
        if (parent.tier !== 1) refuse('member-reparent-tier', 'parent "' + parentName + '" is not tier 1')
        if (memberName === parentName) refuse('member-reparent-cycle', 'a member cannot be its own parent')
        if (String(member.group ?? '') !== String(parent.group ?? '')) {
          refuse('member-reparent-group', 'member "' + memberName + '" and lead "' + parentName + '" are in different groups')
        }
        const previousParent = String(member.parent ?? '')
        const changed = await policy().setParentAsync(memberName, parentName, me, reason)
        if (changed?.ok !== true) refuse('member-reparent-failed', changed?.reason ?? 'parent override failed')
        policy().refreshParents()
        return {
          member: memberName,
          parent: parentName,
          ...(previousParent.length === 0 ? {} : { previousParent }),
          changed: previousParent !== parentName,
        }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'wait_agent',
      description: 'Rarely needed and NEVER used to wait for a Room turn. When a Room is open, obey team_room_read.waitAction: stop means end the turn and let the system handoff wake you. This tool never wakes inactive members and returns noProgress immediately when no other member is running or provisioning. A return from this call, or the absence of one, is never evidence that a member is stuck.',
      parameters: { timeout_ms: { type: 'integer', description: 'Wait duration in milliseconds, from 10000 through 3600000. Defaults to 30000.' } },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: { timedOut: { type: 'boolean', required: true }, noProgress: { type: 'object', additionalProperties: false, properties: { reason: { type: 'string', required: true, enum: ['no-active-peer', 'room-turn-pending'] }, message: { type: 'string', required: true } } } } }),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'wait_agent')
        const me = callerName()
        const timeoutMs = args.timeout_ms ?? 3e4
        const mineRecord = record(me)
        const activeRoom = Object.values(control().view({ history: false }).rounds ?? {}).find((round) =>
          round?.status === 'open'
            && Array.isArray(round.order)
            && round.order.includes(me))
        if (activeRoom !== undefined) {
          return {
            timedOut: false,
            noProgress: {
              reason: 'room-turn-pending',
              message: activeRoom.nextSpeaker === me
                ? 'Room "' + String(activeRoom.roomId) + '" has selected you as nextSpeaker. Post your main turn now, then end the turn; never call wait_agent.'
                : 'Room "' + String(activeRoom.roomId) + '" is waiting for "' + String(activeRoom.nextSpeaker)
                  + '". End this turn now; the room handoff will wake you when it is your turn.',
            },
          }
        }
        if (mineRecord?.tier === 2) {
          return {
            timedOut: false,
            noProgress: {
              reason: 'room-turn-pending',
              message: 'Tier 2 execution is wake-driven. End this turn now and do not call wait_agent; a Room handoff or downward control message will wake you.',
            },
          }
        }
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1e4 || timeoutMs > 36e5) {
          return await ctx.agentTeams.waitForChange(caller, timeoutMs, exec.signal)
        }
        const mine = ctx.agentTeams.membership(caller).name
        const visible = ctx.agentTeams.listMembers(caller).filter((member) => member.name !== mine && policy().canSee(me, member.name))
        if (!visible.some((member) => ACTIVE_WAIT_STATUSES.has(member.status))) {
          return { timedOut: false, noProgress: { reason: 'no-active-peer', message: NO_ACTIVE_PEER_MESSAGE } }
        }
        return await ctx.agentTeams.waitForChange(caller, timeoutMs, exec.signal)
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'interrupt_agent',
      description: 'Interrupt one member\u2019s current turn while preserving its pending inbox. Tier 0 may interrupt anyone; a tier 1 lead may interrupt only its own members. Same-level peers can talk but never interrupt each other.',
      parameters: { target: { type: 'string', required: true, description: 'Teammate name.' } },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: { previousStatus: { type: 'string', required: true, enum: ['running', 'idle', 'inactive'] } } }),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'interrupt_agent')
        const whyInterrupt = policy().whyCannotInterrupt(callerName(), args.target)
        if (whyInterrupt !== undefined) refuse('interrupt-scope', whyInterrupt)
        const targetName = resolveTargetName(args.target)
        const targetAgent = liveTeamAgent(targetName)
        if (targetAgent === undefined) return { previousStatus: 'inactive' }
        const previousStatus = targetAgent.status === 'running' ? 'running' : targetAgent.status === 'idle' ? 'idle' : 'inactive'
        // The v2 policy above has already narrowed authority. Pass the true root
        // Lead to the core primitive directly, avoiding a second roster journal
        // scan and target resolution on this user-facing hot path.
        const authority = rootLead(ctx, caller)
        if (authority === undefined) refuse('interrupt-authority', 'no live root Team Lead can authorize this interrupt')
        ctx.subagents.interrupt(targetAgent.id, { kind: 'ancestor', agent: authority })
        return { previousStatus }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'freeze_member',
      description: 'Freeze or restore one member. A frozen member is a distinct state: it neither sends nor receives messages, cannot spawn or be interrupted, and is never cold-resumed by a delivery attempt. Tier 0 only.',
      parameters: {
        target: { type: 'string', required: true, description: 'Member name.' },
        frozen: { type: 'boolean', required: true, description: 'true freezes, false restores.' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: { target: { type: 'string', required: true }, frozen: { type: 'boolean', required: true }, previous: { type: 'boolean' } } }),
      async execute(args, exec) {
        callingAgent(exec.agent, 'freeze_member')
        const me = record(callerName())
        if (!me || me.tier !== 0) refuse('operator-only', 'only tier 0 may freeze or restore a member')
        let previous
        try {
          previous = await policy().setFrozenAsync(args.target, args.frozen, callerName(), async () => {
            await ctx.agentTeams.setMemberFrozen(exec.agent, args.target, args.frozen === true)
          })
        } catch (error) {
          refuse('freeze-io', 'the durable freeze record could not be updated: ' + (error && error.message) || String(error))
        }
        if (previous === undefined) refuse('unknown-member', 'no member named "' + args.target + '"')
        const roster = policy().all()
        await policy().control.countersUpdate({
          activeSlots: roster.filter((member) => member.tier > 0 && member.frozen !== true && member.status !== 'failed').length,
        }, callerName())
        return { target: args.target, frozen: args.frozen === true, previous }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'set_member_route',
      description: 'Change a live member\u2019s LLM provider/model/reasoning effort. The switch takes effect on that member\u2019s next step. Tier 0 only.',
      parameters: {
        target: { type: 'string', required: true, description: 'Member name.' },
        provider: { type: 'string', required: true, description: 'Registered provider route.' },
        model: { type: 'string', required: true, description: 'Provider-owned model id.' },
        reasoning_effort: { type: 'string', description: 'Optional adapter-owned reasoning effort.' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: { target: { type: 'string', required: true }, provider: { type: 'string', required: true }, model: { type: 'string', required: true }, applied: { type: 'boolean', required: true } } }),
      async execute(args, exec) {
        callingAgent(exec.agent, 'set_member_route')
        const me = record(callerName())
        if (!me || me.tier !== 0) refuse('operator-only', 'only tier 0 may change a member route')
        if (record(args.target) === undefined) refuse('unknown-member', 'no member named "' + args.target + '"')
        const pinnedRoute = {
          provider: args.provider,
          model: args.model,
          ...args.reasoning_effort === undefined ? {} : { reasoningEffort: args.reasoning_effort },
        }
        try {
          // The 0.1.6 stock Team service no longer owns member model routing.
          // Use its durable hook only when present; the v2 route applier below
          // remains the compatibility path for the stock service.
          if (typeof ctx.agentTeams.setMemberRoute === 'function') {
            await ctx.agentTeams.setMemberRoute(exec.agent, args.target, pinnedRoute)
          }
          const updated = await policy().setRouteAsync(args.target, pinnedRoute, callerName())
          if (updated === undefined) refuse('unknown-member', 'no member named "' + args.target + '"')
        } catch (error) {
          refuse('domain-sync', 'the durable member route could not be persisted: ' + (error && error.message) || String(error))
        }
        const applied = config.applyRoute(args.target, {
          provider: args.provider,
          model: args.model,
          ...args.reasoning_effort === undefined ? {} : { reasoningEffort: args.reasoning_effort },
        })
        return { target: args.target, provider: args.provider, model: args.model, applied }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_milestone',
      description: 'Declare, tick and read the MILESTONE: one LARGE phase of your work, a deliverable that takes many tasks and a long stretch of context (typically hundreds of thousands of tokens) to build and verify, plus the check that proves it done. Ticking it lets the runtime fold your context at a real phase edge instead of cutting work in half. A fold is lossy and makes everything kept be read again at full price, so tick only when such a phase is truly finished: never after a single task or a small step (finishing a task is reported on the board, not here). Declare the current phase early. Only you can set or tick YOUR OWN milestone; a superior and a peer may read it. action=list defaults to your own.',
      parameters: {
        action: { type: 'string', required: true, enum: ['set', 'done', 'list'], description: 'set declares or replaces your milestone, done ticks it and arms the compaction, list reads milestones you are allowed to see.' },
        stage: { type: 'string', description: 'action=set: the phase, e.g. "the whole import pipeline implemented, integrated and passing its acceptance suite". It should span many tasks; do not declare one per task.' },
        done_when: { type: 'string', description: 'action=set: the command or check that proves it done, e.g. "run the project focused acceptance command and confirm PASS".' },
        expected_done_when: { type: 'string', description: 'action=done: echo the active done_when. Required when the proof was set or replaced within the last two minutes; a mismatch is refused.' },
        target: { type: 'string', description: 'action=list: read this member instead of yourself. Must be a member you are allowed to read.' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: {
        action: { type: 'string', required: true },
        stage: { type: 'string' },
        doneWhen: { type: 'string' },
        doneWhenSetAt: { type: 'integer' },
        doneWhenEditedMsBeforeDone: { type: 'integer' },
        doneWhenEditedBeforeDone: { type: 'boolean' },
        doneWhenEchoVerified: { type: 'boolean' },
        done: { type: 'boolean' },
        armed: { type: 'boolean' },
        deferred: { type: 'boolean' },
        notice: { type: 'string' },
        openTasks: { type: 'array', items: { type: 'string' } },
        contextPctAt: { type: 'string' },
        members: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          owner: { type: 'string', required: true },
          stage: { type: 'string' },
          doneWhen: { type: 'string' },
          doneWhenSetAt: { type: 'integer' },
          done: { type: 'boolean', required: true },
          pendingCompaction: { type: 'object', additionalProperties: false, properties: {
            status: { type: 'string', required: true },
            reason: { type: 'string', required: true },
            trigger: { type: 'string', required: true },
            ratio: { type: 'number' },
            milestoneStage: { type: 'string', required: true },
            requestedAt: { type: 'integer' },
          } },
          contextPct: { type: 'integer' },
          contextPctAt: { type: 'string' },
        } } },
      } }),
      async execute(args, exec) {
        callingAgent(exec.agent, 'team_milestone')
        const me = callerName()
        const doc = milestones(config.milestonePath)
        const state = milestoneState(doc)
        const mine = record(me)
        const activeMilestoneLease = control().leaseList().find((row) =>
          row.member === me && row.status === 'active' && row.taskId)
        const activeMilestoneTaskId = activeMilestoneLease?.taskId

        if (args.action === 'set') {
          if (typeof args.stage !== 'string' || args.stage.trim().length === 0) {
            refuse('milestone-stage', 'a milestone needs a stage: which large phase, spanning many tasks, are you working toward?')
          }
          if (typeof args.done_when !== 'string' || args.done_when.trim().length === 0) {
            refuse('milestone-proof', 'a milestone needs done_when: the command or check that proves it done, so ticking it is a fact rather than a feeling')
          }
          // No target parameter exists on purpose: a milestone is private to its owner,
          // so "set someone else's" is not a thing the caller can even express.
          const saved = setMilestone(state, me, args.stage.trim(), args.done_when.trim(), Date.now(), activeMilestoneTaskId)
          saveMilestones(config.milestonePath)
          return { action: 'set', stage: saved.stage, doneWhen: saved.doneWhen, doneWhenSetAt: saved.doneWhenSetAt, done: false, armed: false, notice: milestoneNotice(saved), members: [] }
        }

        if (args.action === 'done') {
          const declared = state.members[me]
          const now = Date.now()
          const proof = milestoneProofVerdict(declared, args.expected_done_when, now)
          if (proof.ok !== true) {
            refuse(proof.code, proof.reason + (proof.code === 'milestone-missing'
              ? ': call team_milestone(action:"set", ...) first'
              : ''))
          }
          const ticked = markMilestoneDone(state, me, now, activeMilestoneTaskId)
          // Keep the fold independent of the mutable current milestone. The normal
          // workflow ticks this one and immediately sets the next one; replacing the
          // record must not cancel the already-armed fold.
          const openTasks = Object.values(control().view({ history: false }).boards ?? {})
            .flatMap((board) => Object.values(board.tasks ?? {}))
            .filter((task) => task.ownerName === me && !['completed', 'deleted'].includes(task.status))
            .map((task) => String(task.id))
          // Never arm a lossy fold while this member still has open work. The
          // tick remains durable; the fold is deferred until the task edge is
          // actually clear, so a following write cannot be discarded by idle.
          const armed = openTasks.length === 0 ? armMilestoneCompaction(state, me, Date.now()) : undefined
          saveMilestones(config.milestonePath)
          // Armed, not compacted: compactNow() needs an idle agent, and this call runs
          // inside a turn. The idle transition is what actually fires it.
          return {
            action: 'done',
            stage: ticked.stage,
            doneWhen: ticked.doneWhen,
            doneWhenSetAt: ticked.doneWhenSetAt,
            ...ticked.doneWhenEditedMsBeforeDone === null || ticked.doneWhenEditedMsBeforeDone === undefined
              ? {}
              : { doneWhenEditedMsBeforeDone: ticked.doneWhenEditedMsBeforeDone },
            doneWhenEditedBeforeDone: ticked.doneWhenEditedBeforeDone === true,
            doneWhenEchoVerified: proof.echoVerified === true,
            done: true,
            armed: armed !== undefined,
            deferred: openTasks.length > 0,
            notice: milestoneNotice(ticked) + (openTasks.length === 0
              ? ''
              : ' Compaction is deferred: your owned tasks ' + openTasks.join(', ')
                + ' are still open. Continue this work unit and tick again only after they are closed or explicitly handed off.')
              + (ticked.doneWhenEditedBeforeDone === true
                ? ' Proof audit: done_when was declared ' + String(ticked.doneWhenEditedMsBeforeDone)
                  + ' ms before the tick; expected_done_when matched, but review the boundary before trusting it.'
                : ''),
            openTasks,
            members: [],
          }
        }

        const wanted = args.target ?? me
        if (wanted !== me) {
          const owner = record(wanted)
          if (owner === undefined) refuse('unknown-member', 'no member named "' + wanted + '"')
          if (!canReadMilestone(mine, owner)) {
            refuse('milestone-visibility', 'you may read your own milestone, your own members and your peers — not "' + wanted + '"')
          }
        } else if (mine === undefined) {
          refuse('unknown-member', 'this session has no Team membership record')
        }
        // Each visible member's CONTEXT SHARE rides here rather than in the system prompt.
        // A superior needs it to judge whether a milestone was set at a sensible point, but
        // putting it in the prompt changed a byte every turn and destroyed the prompt cache
        // (measured: hit rate 99% -> 36%, spend up more than tenfold). A tool result is
        // appended to the conversation, so earlier turns stay cached.
        const live = new Map()
        try {
          const ownRoot = rootLead(ctx, exec.agent)
          for (const peer of ctx.agents.list()) {
            const other = ctx.agentTeams.tryMembership(peer)
            if (other === undefined) continue
            // Name-only keying collided across Teams (every root is "lead"), so
            // a context share could report an unrelated session's token usage.
            if (ownRoot === undefined || other.root === undefined || other.root.id !== ownRoot.id) continue
            live.set(other.name, peer)
          }
        } catch {
          /* No live roster: report milestones without context shares. */
        }
        const meter = serviceOf(ctx, 'tokenMeter')
        const windowSize = config.windowTokens
        const contextPctAt = new Date().toISOString()
        const contextPct = (owner) => {
          const peer = live.get(owner)
          if (peer === undefined || meter === undefined) return undefined
          const measured = measureSessionTokens(meter, peer.session)
          const total = measured === null || measured === undefined ? undefined : measured.totalTokens
          if (typeof total !== 'number' || typeof windowSize !== 'number' || windowSize <= 0) return undefined
          return Math.round((total / windowSize) * 100)
        }
        const rows = []
        const targetMembers = args.target === undefined
          ? Object.entries(state.members)
          : Object.prototype.hasOwnProperty.call(state.members, wanted)
            ? [[wanted, state.members[wanted]]]
            : []
        for (const [owner, entry] of targetMembers) {
          if (owner !== me && (mine === undefined || !canReadMilestone(mine, record(owner) ?? { name: owner, tier: -1 }))) continue
          const pct = contextPct(owner)
          const rawPending = state.compactions?.[owner]
          const pending = rawPending === undefined || rawPending === null
            || !['pending-idle', 'retryable', 'compacting'].includes(String(rawPending.status))
            ? undefined
            : rawPending
          rows.push({
            owner,
            stage: entry.stage,
            doneWhen: entry.doneWhen,
            ...typeof entry.doneWhenSetAt === 'number' ? { doneWhenSetAt: entry.doneWhenSetAt } : {},
            done: entry.done === true,
            ...pending === undefined ? {} : {
              pendingCompaction: {
                status: pending.status,
                reason: pending.reason ?? 'milestone',
                trigger: pending.trigger ?? pending.reason ?? 'milestone',
                ...typeof pending.ratio === 'number' ? { ratio: pending.ratio } : {},
                milestoneStage: pending.milestoneStage ?? entry.stage,
                requestedAt: pending.requestedAt ?? null,
              },
            },
            ...pct === undefined ? {} : { contextPct: pct },
            ...pct === undefined ? {} : { contextPctAt },
          })
        }
        return { action: 'list', done: false, armed: false, contextPctAt, members: rows }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_worktree_setup',
      description: 'Lay out one member\u2019s git worktree on its integration branch, so two members can never overwrite each other\u2019s files. Tier 0 lays out its group leads, a group lead lays out its own members, and the verifier lays out its own DETACHED (read-only) checkout. On an existing stale worktree this MERGES the requested base into the branch; it never resets or rebases. If a conflict must be resolved without a lease, pass conflict_strategy plus both pinned full commit SHAs; this is the bounded sync channel used to break the acquire/commit deadlock.',
      parameters: {
        target: { type: 'string', required: true, description: 'Member whose worktree is created.' },
        task_id: { type: 'string', required: true, description: 'Task whose plan has been approved.' },
        repo: { type: 'string', description: 'Repository directory the worktrees live under. Defaults to the caller session repository cwd.' },
        base: { type: 'string', description: 'Base branch or commit. Defaults to main unless the approved plan explicitly names a fresher base; stale group branches are never selected implicitly.' },
        conflict_strategy: { type: 'string', enum: ['base', 'worktree'], description: 'Explicit conflict resolution for a stale member branch: base keeps the requested base side; worktree keeps the member side. Requires expected_head and expected_base.' },
        expected_head: { type: 'string', description: 'Full 40-character member branch SHA observed before the conflict resolution.' },
        expected_base: { type: 'string', description: 'Full 40-character requested base SHA observed before the conflict resolution.' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: {
        target: { type: 'string', required: true },
        branch: { type: 'string', required: true },
        path: { type: 'string', required: true },
        readOnly: { type: 'boolean', required: true },
        created: { type: 'boolean', required: true },
        previousHead: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        head: { type: 'string' },
        parents: { type: 'array', items: { type: 'string' } },
        headKind: { type: 'string' },
        mergeCommitCreated: { type: 'boolean' },
        ignoredUntracked: { type: 'array', items: { type: 'string' } },
        conflictStrategy: { type: 'string' },
        sourceHeadBefore: { type: 'string' },
        baseHeadBefore: { type: 'string' },
        cargoTargetDirectory: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        cargoTargetIsolation: { type: 'object', additionalProperties: true },
        reason: { type: 'string' },
      } }),
      async execute(args, exec) {
        callingAgent(exec.agent, 'team_worktree_setup')
        const caller = callerName()
        const approvedPlan = policy().control.planRequireApproved(TeamTaskId(args.task_id))
        if (!approvedPlan.members.includes(args.target) && approvedPlan.proposedBy !== caller && record(caller)?.tier !== 0) {
          refuse('plan-target', 'approved plan "' + args.task_id + '" does not include target "' + args.target + '"')
        }
        const worktreeTask = durableTask(args.task_id)?.task
        const targetBinding = worktreeTargetVerdict(worktreeTask, args.target)
        if (targetBinding.ok !== true) refuse(targetBinding.code, targetBinding.reason)
        const members = new Map(policy().all().map((member) => [member.name, member]))
        const plan = setupPlan({ members }, caller, args.target, (registry, name) => registry.members.get(name))
        if (!plan.ok) refuse(plan.code, 'worktree setup refused for "' + caller + '" -> "' + args.target + '": ' + plan.code)
        const repo = repositoryRoot(exec.agent, args.repo, approvedPlan)
        const path = absoluteWorktreePath(repo, config.worktreeRoot ?? '.dsh-worktrees', plan.branch)
        const base = args.base ?? (typeof approvedPlan.base === 'string' && approvedPlan.base.length > 0 ? approvedPlan.base : 'main')
        const outcome = worktreeAdd(repo, path, plan.branch, base, undefined, plan.readOnly === true, {
          conflictStrategy: args.conflict_strategy,
          expectedHead: args.expected_head,
          expectedBase: args.expected_base,
        })
        if (outcome.ok !== true) {
          const pins = [
            outcome.head ? 'head=' + String(outcome.head) : null,
            outcome.baseSha ? 'baseSha=' + String(outcome.baseSha) : null,
          ].filter(Boolean).join('; ')
          refuse(outcome.code, 'worktree for "' + args.target + '" could not be created: '
            + String(outcome.detail ?? outcome.code)
            + (pins.length > 0 ? '; ' + pins : ''))
        }
        const cargoIsolation = cargoTargetIsolationVerdict([
          { id: 'repository', path: repo },
          { id: args.target, path: outcome.path },
        ])
        if (cargoIsolation.ok !== true) {
          const detail = cargoIsolation.shared.length > 0
            ? 'Cargo target directory is shared: '
              + cargoIsolation.shared.map((row) => row.targetDirectory + ' <- '
                + row.worktrees.map((entry) => entry.worktree).join(', ')).join('; ')
            : cargoIsolation.errors.map((row) => row.worktree + ': ' + row.code + ' ' + row.detail).join('; ')
          refuse('cargo-target-isolation', 'worktree for "' + args.target
            + '" would not have an independently observable Cargo target: ' + detail)
        }
        const cargoTarget = cargoIsolation.targets.find((row) => row.worktree === args.target)
        await control().boardSetWorktree({
          taskId: String(args.task_id),
          worktreePath: String(outcome.path),
        }, callingAgent(exec.agent, 'team_worktree_setup'))
        await advanceTaskPhase(
          args.task_id,
          'execution',
          callingAgent(exec.agent, 'team_worktree_setup'),
          { skipIfNotForward: true },
        )
        return {
          target: args.target,
          branch: plan.branch,
          path: outcome.path,
          readOnly: plan.readOnly === true,
          created: outcome.created === true,
          previousHead: outcome.previousHead ?? null,
          head: outcome.head,
          parents: outcome.parents ?? [],
          headKind: outcome.headKind,
          mergeCommitCreated: outcome.mergeCommitCreated === true,
          ignoredUntracked: outcome.ignoredUntracked ?? [],
          ...(outcome.conflictStrategy === undefined ? {} : { conflictStrategy: outcome.conflictStrategy }),
          ...(outcome.sourceHeadBefore === undefined ? {} : { sourceHeadBefore: outcome.sourceHeadBefore }),
          ...(outcome.baseHeadBefore === undefined ? {} : { baseHeadBefore: outcome.baseHeadBefore }),
          cargoTargetDirectory: cargoTarget?.targetDirectory ?? null,
          cargoTargetIsolation: cargoIsolation,
        }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_merge',
      description: 'Merge one branch back, as a tool with an approval. A group lead merges its own member into the group branch; tier 0 merges a group branch into main and must have a verifier clearance on that exact commit. A conflict is never auto-resolved: the unmerged paths are reported and the decision escalates to the branch owner.',
      parameters: {
        target: { type: 'string', required: true, description: 'Member whose branch is merged: a member for a group lead, a group lead for tier 0.' },
        task_id: { type: 'string', required: true, description: 'Task whose approved plan and evidence authorize this merge.' },
        source: { type: 'string', enum: ['commit_sha', 'branch_head'], description: 'Explicit merge source. commit_sha merges the task card commit; branch_head merges the current source branch tip after proving it descends from that task commit. Defaults preserve the historical tier behavior: commit_sha for member-to-group, branch_head for group-to-main.' },
        repo: { type: 'string', description: 'Repository directory the worktrees live in. Defaults to the caller session repository cwd.' },
        allow_source_ancestor: { type: 'boolean', description: 'Explicitly allow a member-to-group merge to consume the exact task commit when the source branch tip has advanced. Defaults to false so stale card pointers fail closed.' },
        ignore_untracked: { type: 'boolean', description: 'Allow untracked files in the source/destination worktrees. Tracked modifications always remain blocking.' },
        allowed_untracked: { type: 'array', items: { type: 'string' }, description: 'Exact untracked paths to allow in the source/destination worktrees. Other untracked paths and all tracked modifications remain blocking.' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: {
        target: { type: 'string', required: true },
        source: { type: 'string', required: true },
        sourceSelection: { type: 'string' },
        taskCommit: { type: 'string' },
        mergeSource: { type: 'string' },
        destination: { type: 'string', required: true },
        gitApplied: { type: 'boolean', required: true },
        merged: { type: 'boolean', required: true },
        commit: { type: 'string' },
        sourceSha: { type: 'string' },
        sourceBranchHead: { type: 'string' },
        sourceBranchHeadAfter: { type: 'string' },
        previous: { type: 'string' },
        previousMeaning: { type: 'string' },
        destinationBefore: { type: 'string' },
        destinationRefBefore: { type: 'string' },
        destinationRefAfter: { type: 'string' },
        sourceHead: { type: 'string' },
        mergeBase: { type: 'string' },
        ancestorVerified: { type: 'boolean' },
        fastForwarded: { type: 'boolean' },
        createdCommit: { type: 'boolean' },
        alreadyUpToDate: { type: 'boolean' },
        changed: { type: 'boolean' },
        ignoredUntracked: { type: 'array', items: { type: 'string' } },
        conflict: { type: 'boolean' },
        files: { type: 'array', items: { type: 'string' } },
        escalatedTo: { type: 'string' },
        phaseAdvance: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true },
            phase: { type: 'string' },
            targetPhase: { type: 'string' },
            code: { type: 'string' },
            reason: { type: 'string' },
          },
        },
        privilegeBypass: { type: 'string' },
        reason: { type: 'string' },
      } }),
      async execute(args, exec) {
        callingAgent(exec.agent, 'team_merge')
        const caller = callerName()
        const approvedPlan = policy().control.planRequireApproved(TeamTaskId(args.task_id))
        if (!approvedPlan.members.includes(args.target) && record(caller)?.tier !== 0) {
          refuse('plan-target', 'approved plan "' + args.task_id + '" does not include target "' + args.target + '"')
        }
        const all = policy().all()
        const members = new Map(all.map((member) => [member.name, member]))
        const plan = mergePlan({ members }, caller, args.target, (registry, name) => registry.members.get(name))
        if (!plan.ok) refuse(plan.code, 'merge refused for "' + caller + '" -> "' + args.target + '": ' + plan.code)
        if (plan.dest !== BRANCH_MAIN && plan.source === plan.dest) refuse('nothing-to-merge', 'source and destination are the same branch')

        const repo = repositoryRoot(exec.agent, args.repo, approvedPlan)
        const root = join(repo, config.worktreeRoot ?? '.dsh-worktrees')
        const sourcePath = absoluteWorktreePath(repo, config.worktreeRoot ?? '.dsh-worktrees', plan.source)
        const destinationPath = plan.dest === BRANCH_MAIN ? repo : absoluteWorktreePath(repo, config.worktreeRoot ?? '.dsh-worktrees', plan.dest)
        const mergeOptions = {
          ignoreUntracked: args.ignore_untracked === true,
          allowedUntracked: Array.isArray(args.allowed_untracked) ? args.allowed_untracked : [],
        }
        const source = sourceSnapshot(repo, sourcePath, plan.source, (cwd, argv) => runGit(cwd, argv), mergeOptions)
        if (!source.ok) {
          const dirty = Array.isArray(source.files) && source.files.length > 0
            ? '; dirty files: ' + source.files.slice(0, 20).join(', ') + (source.files.length > 20 ? ' (+' + String(source.files.length - 20) + ' more)' : '')
            : ''
          refuse(source.code, 'source branch is not ready: ' + String(source.detail ?? source.code)
            + '; branch: ' + plan.source + '; worktree: ' + sourcePath + dirty)
        }
        const commit = source.sha
        const mergeTask = durableTask(args.task_id)?.task
        const expectedTaskCommit = String(mergeTask?.commitSha ?? '').trim()
        const sourceDescendsFromTask = expectedTaskCommit.length > 0
          && commit !== expectedTaskCommit
          && runGit(repo, ['merge-base', '--is-ancestor', expectedTaskCommit, commit]).code === 0
        const sourceSelection = String(args.source ?? (plan.dest === BRANCH_MAIN ? 'branch_head' : 'commit_sha')).trim()
        const sourceBinding = memberMergeSourceVerdict({
          destination: plan.dest,
          task: mergeTask,
          sourceSha: commit,
          sourceDescendsFromTask,
          allowSourceAncestor: args.allow_source_ancestor === true,
          sourceSelection,
          privilege: control().privilegeActive(caller),
          target: args.target,
        })
        if (sourceBinding.ok !== true) refuse(sourceBinding.code, sourceBinding.reason)
        const mergeCommit = sourceBinding.expected ?? commit
        const mergeSource = sourceBinding.mergeSource ?? mergeCommit

        // main only accepts a branch the verifier has cleared at THIS commit.
        if (plan.needsClearance === true) {
          const destination = runGit(repo, ['rev-parse', '--verify', BRANCH_MAIN + '^{commit}'])
          const gate = clearanceLandingVerdict(readClearance(config, commit), {
            commit,
            destinationRef: BRANCH_MAIN,
            destinationSha: destination.code === 0 ? destination.stdout.trim() : null,
            repo,
            runner: (cwd, argv) => runGit(cwd, argv),
          })
          if (!gate.ok) {
            const diagnostic = clearanceDiagnostic(config, commit)
            const record = diagnostic.record
            refuse(gate.code, 'main refuses "' + plan.source + '": ' + gate.code
              + '; expectedCommit=' + commit
              + '; foundKey=' + String(diagnostic.foundKey ?? 'none')
              + '; report=' + String(record?.report ?? 'none')
              + '; severity=' + String(record?.severity ?? 'none')
              + '; registryKeys=' + (diagnostic.recordKeys.length === 0 ? 'none' : diagnostic.recordKeys.join(',')))
          }
        }

        // Phase preflight must happen before the branch is mutated. If this
        // refuses, the merge has no side effect to unwind.
        await ensurePacketPhase(args.task_id, 'integration-ready', callingAgent(exec.agent, 'team_merge'))
        if (plan.dest !== BRANCH_MAIN) {
          const sourceContainsMain = runGit(
            repo,
            ['merge-base', '--is-ancestor', BRANCH_MAIN, mergeCommit],
            (cwd, argv) => runGit(cwd, argv),
          ).code === 0
          const destinationHeadIsAncestor = runGit(
            repo,
            ['merge-base', '--is-ancestor', plan.dest, mergeCommit],
            (cwd, argv) => runGit(cwd, argv),
          ).code === 0
          const destinationBase = memberMergeDestinationBase({
            sourceContainsMain,
            destinationHeadIsAncestor,
          })
          const destination = worktreeAdd(
            repo,
            destinationPath,
            plan.dest,
            destinationBase,
            (cwd, argv) => runGit(cwd, argv),
            false,
            mergeOptions,
          )
          if (destination.ok !== true) {
            const files = Array.isArray(destination.files) && destination.files.length > 0
              ? '; files: ' + destination.files.slice(0, 20).join(', ')
              : ''
            refuse(destination.code,
              'merge destination worktree for "' + plan.dest + '" is not ready at ' + destinationPath
              + ': ' + String(destination.detail ?? destination.code) + files)
          }
        }
        const outcome = await withMergeLock(repo, () => {
          if (plan.needsClearance === true) {
            const lockedDestination = runGit(repo, ['rev-parse', '--verify', BRANCH_MAIN + '^{commit}'])
            const lockedGate = clearanceLandingVerdict(readClearance(config, commit), {
              commit,
              destinationRef: BRANCH_MAIN,
              destinationSha: lockedDestination.code === 0 ? lockedDestination.stdout.trim() : null,
              repo,
              runner: (cwd, argv) => runGit(cwd, argv),
            })
            if (lockedGate.ok !== true) {
              return {
                ok: false,
                code: lockedGate.code,
                detail: 'clearance changed after preflight; re-run the merge after the verifier reanchors it',
                clearanceLockedRecheck: true,
              }
            }
          }
          return mergeExact(
            repo,
            destinationPath,
            sourcePath,
            plan.source,
            mergeCommit,
            (cwd, argv) => runGit(cwd, argv),
            {
              ...mergeOptions,
              destinationRef: plan.dest,
              allowSourceAncestor: plan.dest !== BRANCH_MAIN
                && sourceSelection === 'commit_sha'
                && args.allow_source_ancestor === true,
            },
          )
        })
        if (outcome.ok === true) {
          const phaseBefore = durableTask(args.task_id)?.task?.phase
          const targetPhase = mergeTargetPhase(plan.dest)
          let phaseAdvance
          try {
            const advanced = await advanceTaskPhase(
              args.task_id,
              targetPhase,
              callingAgent(exec.agent, 'team_merge'),
              { skipIfNotForward: true },
            )
            const phaseAfter = advanced?.phase ?? durableTask(args.task_id)?.task?.phase
            phaseAdvance = typeof phaseAfter === 'string' && phaseAfter.length > 0
              ? mergePhaseAdvanceVerdict(phaseBefore, phaseAfter)
              : mergePhaseAdvanceFailureVerdict(
                new Error('phase advance did not persist a readable task phase'),
                targetPhase,
                phaseAfter,
              )
          } catch (error) {
            phaseAdvance = mergePhaseAdvanceFailureVerdict(
              error,
              targetPhase,
              durableTask(args.task_id)?.task?.phase,
            )
          }
          return {
            target: args.target,
            source: plan.source,
            sourceSelection,
            ...(expectedTaskCommit.length > 0 ? { taskCommit: expectedTaskCommit } : {}),
            mergeSource,
            destination: plan.dest,
            gitApplied: true,
            merged: true,
            commit: outcome.commit,
            sourceSha: outcome.sourceSha,
            sourceBranchHead: outcome.sourceBranchHead,
            sourceBranchHeadAfter: outcome.sourceBranchHeadAfter,
            previous: outcome.previous,
            previousMeaning: outcome.previousMeaning,
            destinationBefore: outcome.destinationBefore,
            destinationRefBefore: outcome.destinationRefBefore,
            destinationRefAfter: outcome.destinationRefAfter,
            sourceHead: outcome.sourceHead,
            mergeBase: outcome.mergeBase,
            ancestorVerified: outcome.ancestorVerified === true,
            fastForwarded: outcome.fastForwarded === true,
            createdCommit: outcome.createdCommit === true,
            alreadyUpToDate: outcome.alreadyUpToDate === true,
            changed: outcome.changed === true,
            ignoredUntracked: outcome.ignoredUntracked ?? [],
            phaseAdvance,
            ...(sourceBinding.privilegeBypass === undefined ? {} : { privilegeBypass: sourceBinding.privilegeBypass }),
          }
        }
        if (outcome.code === 'merge-conflict') {
          return {
            target: args.target,
            source: plan.source,
            sourceSelection,
            ...(expectedTaskCommit.length > 0 ? { taskCommit: expectedTaskCommit } : {}),
            mergeSource,
            destination: plan.dest,
            gitApplied: false,
            merged: false,
            conflict: true,
            files: outcome.files,
            escalatedTo: plan.owner,
            reason: 'unmerged paths must be decided by ' + plan.owner + ', not resolved automatically',
          }
        }
        const outcomeFiles = Array.isArray(outcome.files) && outcome.files.length > 0
          ? '; files: ' + outcome.files.slice(0, 20).join(', ') + (outcome.files.length > 20 ? ' (+' + String(outcome.files.length - 20) + ' more)' : '')
          : ''
        refuse(outcome.code, 'git application failed before phase advance; merge of "' + plan.source + '" into "' + plan.dest + '" failed: '
          + String(outcome.detail ?? outcome.code)
          + (outcome.destinationRef ? '; expectedRef: ' + String(outcome.destinationRef) : '')
          + (outcome.destinationRefBefore ? '; actualRef: ' + String(outcome.destinationRefBefore) : '')
          + (outcome.path ? '; worktree: ' + String(outcome.path) : '')
          + outcomeFiles)
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'verifier_report',
      description: 'Publish one aggregated issue table. The independent verifier group only. Every issue must cite evidence that distinguishes the broken state; "nothing to report" is not a review. The table is written under the configured report directory and every group lead is notified with the path. ' + VERIFIER_CLEARANCE_POLICY,
      parameters: {
        name: { type: 'string', required: true, description: 'Short report name, sanitized to [a-z0-9-_]. Becomes <name>.md in the report directory.' },
        summary: { type: 'string', required: true, description: 'One-paragraph verdict.' },
        commit: { type: 'string', description: 'Commit hash this verdict was produced against. Required to clear a branch for merge into main; reports with blocker or major do not write clearance keys.' },
        cleared_commits: { type: 'array', items: { type: 'string' }, description: 'Additional exact commits this report clears, such as both the task commit and the group-branch head.' },
        clearedCommits: { type: 'array', items: { type: 'string' }, description: 'Camel-case alias for cleared_commits.' },
        issues: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              severity: { type: 'string', required: true, enum: [...VERIFIER_ISSUE_SEVERITIES] },
              title: { type: 'string', required: true, description: 'What is wrong.' },
              evidence: { type: 'string', required: true, description: 'The command, file, or output that distinguishes the broken state.' },
              location: { type: 'string', description: 'File, symbol, or task id.' },
            },
          },
        },
      },
      output: jsonOutput({
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          issues: { type: 'integer', required: true },
          bySeverity: { type: 'object', required: true, additionalProperties: true },
          notified: { type: 'array', required: true, items: { type: 'string' } },
          clearedCommits: { type: 'array', items: { type: 'string' } },
          clearanceUpdated: { type: 'integer' },
          clearanceIgnored: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                commit: { type: 'string', required: true },
                retainedSeverity: { type: 'string' },
                ignoredSeverity: { type: 'string' },
                retainedReport: { type: 'string' },
                ignoredReport: { type: 'string' },
              },
            },
          },
        },
      }),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'verifier_report')
        const me = callerName()
        const mine = record(me)
        if (mine === undefined || mine.group !== 'verifier') {
          refuse('verifier-only', 'verifier_report belongs to the independent verifier group; "' + me + '" is in group "' + String((mine || {}).group) + '"')
        }
        const issues = Array.isArray(args.issues) ? args.issues : []
        if (issues.length === 0) refuse('empty-report', 'a verifier report must contain at least one issue; an empty table is not a review')
        issues.forEach((issue, index) => {
          if (issue === null || typeof issue !== 'object') refuse('bad-issue', 'issue #' + (index + 1) + ' is not an object')
          if (typeof issue.evidence !== 'string' || issue.evidence.trim().length === 0) {
            refuse('missing-evidence', 'issue #' + (index + 1) + ' ("' + String(issue.title) + '") cites no evidence; every finding must name the command, file, or output that distinguishes the broken state')
          }
          if (typeof issue.severity !== 'string' || !VERIFIER_ISSUE_SEVERITIES.includes(issue.severity)) {
            refuse('bad-severity', 'issue #' + (index + 1) + ' has severity "' + String(issue.severity)
              + '"; expected ' + VERIFIER_ISSUE_SEVERITIES.join('|'))
          }
        })

        const safe = String(args.name).toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
        if (safe.length === 0) refuse('bad-name', 'report name must contain at least one [a-z0-9] character')
        const order = Object.fromEntries(VERIFIER_ISSUE_SEVERITIES.map((severity, index) => [severity, index]))
        const sorted = [...issues].sort((a, b) => order[a.severity] - order[b.severity])
        const clearanceVerdict = reportClearanceVerdict(args)
        const clearanceCommits = clearanceVerdict.commits
        let clearanceRepo
        if (clearanceCommits.length > 0) {
          clearanceRepo = repositoryRoot(exec.agent, undefined, undefined)
          for (const commit of clearanceCommits) {
            const verdict = clearanceCommitVerdict(commit, clearanceRepo, (cwd, argv) => runGit(cwd, argv))
            if (verdict.ok !== true) {
              refuse(verdict.code, 'clearance commit "' + commit + '" for report "' + safe
                + '" is invalid: ' + String(verdict.detail ?? verdict.code))
            }
          }
        }
        const bySeverity = {}
        for (const issue of sorted) bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1

        const header = [
          '# Verifier report: ' + safe,
          '',
          'Verdict: ' + String(args.summary),
          ...(clearanceCommits.length === 0 ? [] : ['', 'Cleared commits: ' + clearanceCommits.join(', ')]),
          '',
          '| severity | issue | location | evidence |',
          '| --- | --- | --- | --- |',
          ...sorted.map((issue) => '| ' + issue.severity + ' | ' + String(issue.title).replace(/\|/g, '\\|')
            + ' | ' + String(issue.location ?? '-').replace(/\|/g, '\\|')
            + ' | ' + String(issue.evidence).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ') + ' |'),
          '',
        ].join('\n')

        const dir = config.reportDir
        const file = join(dir, safe + '.md')
        try {
          mkdirSync(dir, { recursive: true })
          writeFileSync(file, header, 'utf8')
        } catch (error) {
          refuse('report-io', 'could not write the report to "' + file + '": ' + String(error && error.message))
        }

        // A verdict only clears a branch when it names the commit it was produced
        // against; team_merge refuses main otherwise. No commit, no clearance.
        let clearanceUpdated = 0
        let clearanceIgnored = []
        if (clearanceCommits.length > 0 && typeof config.clearanceFile === 'string' && config.clearanceFile.length > 0) {
          try {
            let doc = {}
            try { doc = JSON.parse(readFileSync(config.clearanceFile, 'utf8')) } catch { doc = {} }
            if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) doc = {}
            const clearance = buildClearanceRecords({
              commit: args.commit,
              clearedCommits: args.clearedCommits,
              cleared_commits: args.cleared_commits,
              severity: sorted[0] === undefined ? 'nit' : sorted[0].severity,
              summary: args.summary,
              issues: sorted,
              report: safe,
              by: me,
              at: new Date().toISOString(),
            })
            if (clearanceRepo !== undefined) {
              for (const commit of clearance.commits) {
                const metadata = clearanceDestinationMetadata(
                  commit,
                  clearanceRepo,
                  (cwd, argv) => runGit(cwd, argv),
                )
                if (metadata.ok !== true) {
                  refuse(metadata.code, 'could not bind clearance commit "' + commit
                    + '" to main: ' + String(metadata.detail ?? metadata.code))
                }
                clearance.records[commit] = { ...clearance.records[commit], ...metadata }
              }
            }
            const merged = mergeClearanceRecords(doc, clearance.records)
            clearanceUpdated = merged.updated.length
            clearanceIgnored = merged.ignored
            mkdirSync(dirname(config.clearanceFile), { recursive: true })
            writeFileSync(config.clearanceFile, JSON.stringify(merged.records, null, 1), 'utf8')
          } catch (error) {
            refuse('clearance-io', 'could not record the clearance: ' + String(error && error.message))
          }
        }
        await control().evidencePut({
          taskId: args.task_id,
          commitSha: clearanceCommits[0] ?? args.commit,
          recordedBy: callerName(),
          kind: 'verifier-report',
          output: header,
          paths: [file],
          classification: 'verifier-review',
          status: 'recorded',
        }, caller)

        const leads = policy().all().filter((m) => m.tier === 1 && m.group !== 'verifier')
        const notified = []
        for (const lead of leads) {
          if (lead.frozen === true) continue
          if (!policy().canMessage(me, lead.name)) continue
          const spec = roomSpec(me, lead.name)
          const { round } = await ensureRoom(spec, caller)
          await control().roomNotice({
            roomId: spec.roomId,
            roundId: round?.roundId,
            author: me,
            content: 'Verifier report "' + safe + '" (' + String(issues.length) + ' issues: '
              + Object.entries(bySeverity).map(([k, v]) => k + '=' + String(v)).join(', ')
              + ') written to ' + file + '. Read it and rework every blocker and major.',
            references: [file, ...clearanceCommits],
          }, caller)
          try {
            await ctx.agentTeams.sendMessage(caller, {
              target: lead.name,
              content: [{ type: 'text', text: '[verifier report] ' + safe + ' (' + String(issues.length) + ' issues). Read ' + file + ' and rework every blocker/major.' }],
              signal: exec.signal,
            })
            notified.push(lead.name)
          } catch (error) {
            if (ctx.logger !== undefined) {
              ctx.logger.warn?.('verifier report delivery failed for ' + lead.name + ': ' + ((error && error.message) || String(error)))
            }
          }
        }
        return {
          path: file,
          issues: issues.length,
          bySeverity,
          notified,
          clearedCommits: clearanceCommits,
          clearanceUpdated,
          clearanceIgnored,
        }
      },
    })))

    /** Resolve the board one call targets; exact group/level ids are accepted. */
    const resolveBoard = (actorName, kind) => {
      const requested = String(kind ?? 'global')
      if (requested === 'global') return 'global'
      if (requested.startsWith('group-') || requested.startsWith('level-')) return requested
      return policy().boardOf(actorName, requested)
    }

    /** Write guard shared by the task tools; the reason names the real cause. */
    const requireBoardWrite = (actorName, boardId, action, taskId) => {
      if (boardId === undefined) {
        refuse('board-scope', 'member "' + actorName + '" owns no board of that kind')
      }
      if (policy().canWriteBoard(actorName, boardId)) return
      if (boardId === 'global') {
        const task = durableTask(taskId)?.task
        if (action === 'complete' && task?.ownerName === actorName
          && !['completed', 'deleted'].includes(String(task.status ?? ''))) {
          return
        }
        refuse('global-board-write', 'only tier 0 may write the global board; "' + actorName + '" has read access only')
      }
      const level = policy().boardTier(boardId)
      refuse('board-write', '"' + actorName + '" may not write board "' + boardId + '"'
        + (level === undefined ? '' : ' (that board belongs to tier ' + level + ')'))
    }

    /**
     * The shipped Team domain owns the global task log, while this plugin keeps
     * a local projection for phase/kind metadata. A task created before the
     * projection existed can therefore be readable through the domain but
     * absent locally. Materialize it before a local CAS update so the caller
     * gets one coherent read/write path instead of `unknown task`.
     */
    const ensureGlobalTaskProjection = async (caller, task) => {
      const existing = durableTask(task.id)
      if (existing !== undefined) return existing
      const writeScopes = Array.isArray(task.writeScopes) ? task.writeScopes.map(String) : []
      const workKind = writeScopes.length > 0 ? 'edit' : 'discussion'
      await control().boardCreate({
        boardId: 'global',
        taskId: String(task.id),
        subject: String(task.subject ?? ''),
        description: String(task.description ?? ''),
        blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy.map(String) : [],
        writeScopes,
        phase: 'room-discussion',
        workKind,
      }, caller)
      policy().refreshBoards()
      return durableTask(task.id)
    }

    register(scoped.tools.register(defineTool({
      name: 'team_task_create',
      description: 'Create one pending task with an explicit deliverable kind and an optional owner. Use the returned id verbatim; never infer the next id from a numeric sequence. discussion/review tasks use no write scopes and close with evidence; edit tasks require write scopes and the plan/commit gate.',
      parameters: {
        subject: { type: 'string', required: true, description: 'Concise task title.' },
        description: { type: 'string', required: true, description: 'Complete task details and acceptance criteria.' },
        kind: { type: 'string', required: true, enum: ['discussion', 'review', 'edit'], description: 'discussion/review produce evidence without writes; edit produces tracked file changes.' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Task ids that must complete first. Use boardId:taskId for a cross-board dependency.' },
        dependency_phase: { type: 'string', enum: ['completed', ...TASK_PHASES], description: 'Dependency release threshold. Defaults to accepted; completed selects content completion without waiting for final acceptance.' },
        write_scopes: { type: 'array', items: { type: 'string' }, description: 'Advisory workspace-relative file or directory prefixes this task expects to modify.' },
        owner: { type: 'string', description: 'Optional member name to assign in the same create mutation. Group leads may assign only their own group members or themselves.' },
        board: { type: 'string', description: 'Target board: global, level, group, or an exact board id such as group-proto or level-1. Defaults to global. Tier 0 may read every exact board; the verifier may read group boards read-only; other roles remain restricted to their own board.' },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'team_task_create')
        assertTeamRunnable()
        const me = callerName()
        const target = args.board ?? 'global'
        const writeScopes = Array.isArray(args.write_scopes) ? args.write_scopes.map(String) : []
        if (args.kind === 'edit' && writeScopes.length === 0) {
          refuse('task-kind-scope', 'edit task "' + args.subject + '" must declare at least one write_scope')
        }
        if (args.kind !== 'edit' && writeScopes.length > 0) {
          refuse('task-kind-scope', args.kind + ' task "' + args.subject + '" is evidence-only and must not declare write_scopes')
        }
        if (args.kind !== 'edit' && writeScopes.length > 0) {
          refuse('task-kind-scope', args.kind + ' task "' + args.subject + '" must not declare write_scopes; use kind:"edit" for file changes')
        }
        const ownerName = typeof args.owner === 'string' ? args.owner.trim() : ''
        if (args.owner !== undefined && ownerName.length === 0) {
          refuse('task-owner-invalid', 'owner must be a non-empty member name when provided')
        }
        const request = {
          subject: args.subject,
          description: args.description,
          ...args.blocked_by === void 0 ? {} : { blockedBy: args.blocked_by.map(TeamTaskId) },
          ...args.dependency_phase === void 0 ? {} : { dependencyPhase: args.dependency_phase },
          ...args.write_scopes === void 0 ? {} : { writeScopes },
        }
        const boardId = resolveBoard(me, target)
        requireBoardWrite(me, boardId)
        const crossBoard = crossBoardBlockerVerdict(
          request.blockedBy,
          boardId,
          control().view({ history: false }).boards,
        )
        if (crossBoard.invalid.length > 0) {
          refuse('dependency-reference-invalid',
            'blocked_by contains an unresolved board-qualified dependency: ' + crossBoard.detail)
        }
        if (crossBoard.crossBoard.length > 0) {
          refuse('cross-board-blocker-unsupported',
            'blocked_by is board-local: ' + crossBoard.detail
            + '; use board-qualified syntax "' + crossBoard.crossBoard[0].boards[0] + ':' + crossBoard.crossBoard[0].id
            + '" or a waiting ticket')
        }
        if (ownerName.length > 0) {
          const ownerRecord = record(ownerName)
          if (ownerRecord === undefined) refuse('task-owner-unknown', 'owner "' + ownerName + '" is not registered in the Team')
          const boardWrite = taskOwnerBoardWriteVerdict(ownerRecord, boardId)
          if (boardWrite.ok !== true) refuse(boardWrite.code, boardWrite.reason)
          const meRecord = record(me)
          if (boardId !== 'global' && meRecord?.tier === 1
            && ownerRecord.group !== meRecord.group) {
            refuse('task-owner-scope', 'a group lead may assign a new task only to its own group or itself')
          }
        }
        if (boardId === 'global') {
          const domainRequest = {
            ...request,
            ...Array.isArray(request.blockedBy)
              ? { blockedBy: request.blockedBy.filter((reference) => !boardQualifiedDependency(reference, boardId)) }
              : {},
          }
          let task = await ctx.agentTeams.createTask(caller, domainRequest)
          if (ownerName.length > 0) {
            task = await ctx.agentTeams.updateTask(caller, {
              taskId: task.id,
              expectedRevision: task.revision,
              action: 'reassign',
              owner: ownerName,
            })
          }
          await control().boardCreate({
            boardId,
            taskId: task.id,
            ...request,
            phase: 'room-discussion',
            subject: task.subject,
            description: task.description,
            writeScopes: task.writeScopes,
            workKind: args.kind,
            ...ownerName.length === 0 ? {} : { ownerName },
          }, caller)
          let projected = projectTask(task, boardId)
          if (args.kind === 'edit' && ownerName.length > 0) {
            const binding = memberWorktreeBindingVerdict(
              record(ownerName),
              task,
              repositoryRoot(exec.agent, undefined, undefined),
              config.worktreeRoot,
              ownerName,
            )
            if (binding.required === true && binding.needsBinding === true) {
              task = await control().boardSetWorktree({ taskId: String(task.id), worktreePath: binding.path }, caller)
              policy().refreshBoards()
              projected = projectTask(task, boardId)
            }
          }
          return args.kind === 'edit' && ownerName.length === 0
            ? { ...projected, worktreeBindingWarning: 'edit task is unbound until an owner is assigned; reassignment binds its member worktree' }
            : projected
        }
        let task = await policy().boardCreateAsync(boardId, {
          ...request,
          phase: 'room-discussion',
          workKind: args.kind,
          ...ownerName.length === 0 ? {} : { ownerName },
        }, caller)
        let projected = projectTask(task, boardId)
        if (args.kind === 'edit' && ownerName.length > 0) {
          const binding = memberWorktreeBindingVerdict(
            record(ownerName),
            task,
            repositoryRoot(exec.agent, undefined, undefined),
            config.worktreeRoot,
            ownerName,
          )
          if (binding.required === true && binding.needsBinding === true) {
            task = await control().boardSetWorktree({ taskId: String(task.id), worktreePath: binding.path }, caller)
            policy().refreshBoards()
            projected = projectTask(task, boardId)
          }
        }
        return args.kind === 'edit' && ownerName.length === 0
          ? { ...projected, worktreeBindingWarning: 'edit task is unbound until an owner is assigned; reassignment binds its member worktree' }
          : projected
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_list',
      description: 'List tasks on one board, including readiness, owner, revision, blockers, and write-scope warnings.',
      parameters: {
        view: { type: 'string', enum: ['compact', 'full'], description: 'Optional compact decision view; default full. Compact is not completion evidence.' },
        taskIds: { type: 'array', items: { type: 'string' }, description: 'Optional exact task ids within the authorized board.' },
        changed_since: { type: 'integer', description: 'Return tasks updated strictly after this epoch-millisecond timestamp.' },
        snapshotRevision: { type: 'integer', description: 'Optional exact control-plane revision; a changed snapshot is refused.' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Optional exact status filter.' },
        owner: { type: 'string', description: 'Optional member-name filter; use unowned for tasks without an owner.' },
        ready: { type: 'boolean', description: 'Optional readiness filter.' },
        cursor: { type: 'integer', description: 'Zero-based result offset. Defaults to 0.' },
        limit: { type: 'integer', description: 'Number of rows, 1 through 100. Defaults to 50.' },
        board: { type: 'string', description: 'Board to read: global, level, group, or an exact board id such as group-proto or level-1. Defaults to global. Tier 0 may read every exact board; the verifier may read group boards read-only; other roles remain restricted to their own board.' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: { tasks: { type: 'array', required: true, items: TASK_VIEW_SCHEMA }, nextCursor: { type: 'integer' }, total: { type: 'integer', required: true }, returned: { type: 'integer', required: true }, truncated: { type: 'boolean', required: true }, snapshotRevision: { type: 'integer' }, snapshotId: { type: 'string' } } }),
      execute(args, exec) {
        const caller = callingAgent(exec.agent, 'team_task_list')
        const me = callerName()
        const boardId = resolveBoard(me, args.board)
        if (!policy().canReadBoard(me, boardId)) refuse('board-read', 'member "' + me + '" may not read board "' + boardId + '"')
        const query = taskQuerySnapshot(caller, args)
        const raw = boardId === 'global'
          ? ctx.agentTeams.listTasks(caller)
          : Object.values(query.snapshot.boards?.[boardId]?.tasks ?? {})
        // Filter after projecting the local status/phase/revision, otherwise a
        // task completed in the control plane is still filtered by the domain's
        // stale pending status.
        let integrationRepo
        try {
          integrationRepo = repositoryRoot(exec.agent, undefined, undefined)
        } catch {
          integrationRepo = undefined
        }
        const all = raw.map((task) => projectReady(task, caller, task.board ?? boardId, query))
        const status = args.status
        const filtered = all.filter((task) => taskQueryFilter(task, args) && (status === void 0 || task.status === status)
          && (args.owner === void 0 || (args.owner === 'unowned' ? task.ownerName === void 0 : task.ownerName === args.owner))
          && (args.ready === void 0 || task.ready === args.ready))
        const cursor = args.cursor ?? 0
        const limit = args.limit ?? 50
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('cursor must be a non-negative safe integer')
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 through 100')
        // Integration requires a git ancestry probe per completed edit task.
        // Project and filter the whole board first, then probe only the page
        // actually returned to the model.
        const page = filtered.slice(cursor, cursor + limit)
        const mainAncestors = page.some((task) => task.status === 'completed'
          && (task.workKind === 'edit' || (Array.isArray(task.writeScopes) && task.writeScopes.length > 0)))
          ? mainAncestorSet(integrationRepo, (cwd, argv) => runGit(cwd, argv))
          : null
        const tasks = page.map((projected) => {
          const integration = taskIntegrationVerdict(projected, integrationRepo, (cwd, argv) => runGit(cwd, argv), mainAncestors)
          if (integration.state === null) return projected
          return {
            ...projected,
            integrationState: integration.state,
            integrationMeaning: integration.state === 'integrated-pending-terminal'
              ? 'commit is already an ancestor of main; phase is historical, not pending integration'
              : integration.state === 'completed-not-integrated'
                ? 'status is completed but the commit is not an ancestor of main'
                : integration.state === 'completed-commit-missing'
                  ? 'completed edit work has no exact commit binding'
                  : 'main ancestry could not be verified in the current repository',
          }
        })
        return Promise.resolve({
          tasks: tasks.map((task) => projectTaskQueryView(task, args.view)),
          snapshotRevision: query.snapshotRevision,
          snapshotId: query.snapshotId,
          ...taskListPageMetadata(filtered.length, cursor, limit, tasks.length),
          ...cursor + limit < filtered.length ? { nextCursor: cursor + limit } : {},
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_delivery_check',
      description: 'Check the board before declaring anything delivered. Lists every task that is not completed and, for each, whether its owner has already TICKED its milestone. Use verdict to filter; ownerless reference tasks are counted separately from actionable work. Tier 0 only.',
      parameters: { verdict: { type: 'string', enum: ['owner-forgot-to-mark-it', 'work-genuinely-unfinished', 'milestone-unbound', 'no-owner'], description: 'Optional verdict filter for the open list.' } },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: {
        deliverable: { type: 'boolean', required: true },
        openCount: { type: 'integer', required: true },
        actionableOpenCount: { type: 'integer', required: true },
        noOwnerCount: { type: 'integer', required: true },
        deadLetterCount: { type: 'integer', required: true },
        peerDeadLetterCount: { type: 'integer', required: true },
        systemDeadLetterCount: { type: 'integer', required: true },
        completedNotIntegratedCount: { type: 'integer', required: true },
        completedNotIntegrated: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        oldestDeadLetterAgeMs: { type: 'integer', required: true },
        oldestPeerDeadLetterAgeMs: { type: 'integer', required: true },
        deadLetters: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        escalationSummary: { type: 'object', required: true, additionalProperties: true },
        open: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          id: { type: 'string', required: true },
          subject: { type: 'string', required: true },
          status: { type: 'string', required: true },
          workKind: { type: 'string', enum: ['discussion', 'review', 'edit'] },
          owner: { type: 'string' },
          ownerMilestone: { type: 'string' },
          ownerMilestoneTaskId: { type: 'string' },
          responsibleInactive: { type: 'boolean' },
          verdict: { type: 'string', required: true, enum: ['owner-forgot-to-mark-it', 'work-genuinely-unfinished', 'milestone-unbound', 'no-owner'] },
        } } },
        blockers: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        cargoTargetIsolation: { type: 'object', required: true, additionalProperties: true },
        counters: { type: 'object', required: true, additionalProperties: true },
        planCoverage: { type: 'array', items: { type: 'object', additionalProperties: true } },
        requirementCoverage: { type: 'object', additionalProperties: true },
      } }),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'team_delivery_check')
        const me = record(callerName())
        if (me === undefined || me.tier !== 0) refuse('tier-0-only', 'only tier 0 may decide that the work is delivered')
        const tasks = await ctx.agentTeams.listTasks(caller)
        const liveMembers = ctx.agentTeams.listMembers?.(caller) ?? []
        const memberByName = new Map(liveMembers.map((member) => [String(member?.name ?? member?.id ?? ''), member]))
        const durable = control().view({ history: false })
        // Every durable board task is part of the delivery picture, not only planned
        // ones: filtering by plan here is what let an unplanned completed task skip the
        // gate entirely and still produce deliverable=true.
        const durableTasks = Object.values(durable.boards ?? {}).flatMap((board) => Object.values(board.tasks ?? {}))
        const durableTaskById = new Map(durableTasks.map((row) => [String(row.id), row]))
        const domainTaskIds = new Set(tasks.map((task) => String(task.id)))
        const allTasks = tasks.map((task) => {
          const durableRow = durableTaskById.get(String(task.id))
          return durableRow === undefined ? task : { ...durableRow, ...task,
            status: durableRow.status ?? task.status,
            phase: durableRow.phase ?? task.phase,
            revision: durableRow.revision ?? task.revision,
            ...(durableRow.ownerName !== undefined ? { ownerName: durableRow.ownerName } : {}),
            ...(durableRow.commitSha !== undefined ? { commitSha: durableRow.commitSha } : {}),
            ...(durableRow.evidenceIds !== undefined ? { evidenceIds: durableRow.evidenceIds } : {}),
          }
        })
        allTasks.push(...durableTasks.filter((row) => !domainTaskIds.has(String(row.id))))
        const taskKindById = new Map(durableTasks.map((row) => [
          String(row.id),
          row.workKind ?? (Array.isArray(row.writeScopes) && row.writeScopes.length > 0 ? 'edit' : 'discussion'),
        ]))
        const plannedTaskIds = new Set(Object.keys(durable.plans ?? {}).filter((taskId) => taskKindById.get(taskId) === 'edit'))
        const evidenceRows = Object.values(durable.evidence ?? {})
        const packets = Object.values(durable.packets ?? {})
        const evidenceByTask = new Map()
        for (const row of evidenceRows) {
          const taskId = String(row.taskId ?? '')
          if (taskId.length === 0) continue
          const rows = evidenceByTask.get(taskId) ?? []
          rows.push(row)
          evidenceByTask.set(taskId, rows)
        }
        const packetsByTask = new Map()
        for (const row of packets) {
          for (const taskId of Array.isArray(row.taskIds) ? row.taskIds.map(String) : []) {
            const rows = packetsByTask.get(taskId) ?? []
            rows.push(row)
            packetsByTask.set(taskId, rows)
          }
        }
        const state = milestoneState(milestones(config.milestonePath))
        const open = []
        const blockers = []
        const completedNotIntegrated = []
        let integrationRepo
        try {
          integrationRepo = repositoryRoot(exec.agent, undefined, undefined)
        } catch {
          integrationRepo = undefined
        }
        const cargoWorktrees = integrationRepo === undefined
          ? []
          : [
              { id: 'repository', path: integrationRepo },
              ...[...new Set(durableTasks
                .map((task) => typeof task.worktreePath === 'string' ? task.worktreePath : '')
                .filter((path) => path.length > 0))]
                .map((path) => ({ id: path, path })),
            ]
        const cargoTargetIsolation = cargoWorktrees.length === 0
          ? { ok: true, checked: 0, targets: [], shared: [], errors: [] }
          : cargoTargetIsolationVerdict(cargoWorktrees)
        for (const row of cargoTargetIsolation.shared) {
          blockers.push({ kind: 'cargo-target-shared', ...row })
        }
        for (const row of cargoTargetIsolation.errors) {
          blockers.push({ kind: 'cargo-target-unverified', ...row })
        }
        const mainAncestors = integrationRepo === undefined
          ? null
          : mainAncestorSet(integrationRepo, (cwd, argv) => runGit(cwd, argv))
        for (const task of allTasks) {
          const taskId = String(task.id)
          if (task.status === 'completed') {
            const planned = plannedTaskIds.has(taskId)
            const scoped = Array.isArray(task.writeScopes) && task.writeScopes.length > 0
            const taskEvidence = evidenceByTask.get(taskId) ?? []
            const commitSha = typeof task.commitSha === 'string' && task.commitSha.length > 0 ? task.commitSha : null
            const evidenceIds = Array.isArray(task.evidenceIds) ? task.evidenceIds.map(String) : []
            const matchingEvidence = taskEvidence.filter((row) => commitSha === null || row.commitSha === commitSha)
            const taskPackets = packetsByTask.get(taskId) ?? []
            const groupPackets = taskPackets.filter((row) => row.kind === 'group-acceptance'
              && (commitSha === null || row.commitSha === commitSha))
            const verifierPackets = taskPackets.filter((row) => row.kind === 'verifier-review'
              && (commitSha === null || row.commitSha === commitSha))
            const finalPackets = taskPackets.filter((row) => row.kind === 'final-acceptance'
              && (commitSha === null || row.commitSha === commitSha))
            const reference = taskEvidence.find((row) => row.kind === 'delivery-reference'
              && typeof row.requirementId === 'string'
              && commitSha !== null
              && row.commitSha === commitSha)
            const referenced = reference === undefined ? undefined : durableTaskById.get(String(reference.requirementId))
            const validReference = reference !== undefined
              && referenced !== undefined
              && referenced.status === 'completed'
              && typeof referenced.commitSha === 'string'
              && referenced.commitSha === commitSha
            const integration = taskIntegrationVerdict(
              task,
              integrationRepo,
              (cwd, argv) => runGit(cwd, argv),
              mainAncestors,
            )
            // Once a completed edit card's exact commit is already in main, its
            // missing historical phase/packet rows are not actionable blockers
            // for the current delivery decision. Keep them for unintegrated or
            // unverified work so the signal remains fail-closed.
            const integratedHistory = integration.state === 'integrated-pending-terminal'
            const requirements = [
              ['owner', typeof task.ownerName === 'string' && task.ownerName.length > 0],
              ...(planned || scoped ? [['commit', commitSha !== null]] : []),
              ['evidence', evidenceIds.length > 0 || matchingEvidence.length > 0],
              ...(validReference ? [] : planned ? [
                ['phase-accepted', task.phase === 'accepted'],
                ['group-acceptance', groupPackets.length > 0],
                ['verifier-review', verifierPackets.length > 0],
                ['final-acceptance', finalPackets.length > 0],
              ] : []),
            ]
            for (const [requirement, present] of requirements) {
              if (!present && taskGateActionable(integratedHistory, requirement)) {
                blockers.push({ kind: 'task-gate', taskId, requirement, status: 'missing' })
              }
            }
            if (!integratedHistory) {
              for (const packet of [...verifierPackets, ...finalPackets]) {
                if (Array.isArray(packet.blockers) && packet.blockers.length > 0) {
                  blockers.push({ kind: 'packet-blocker', taskId, packetId: packet.packetId, packetKind: packet.kind, blockers: packet.blockers })
                }
              }
            }
            if (!validReference && integration.state === 'completed-not-integrated') {
              const row = { taskId, commitSha: integration.commit, phase: task.phase ?? null }
              completedNotIntegrated.push(row)
              blockers.push({ kind: 'completed-not-integrated', ...row })
            }
            continue
          }
          if (task.status === 'deleted') continue
          const owner = task.ownerName
          if (owner === undefined) {
            open.push({
              id: String(task.id),
              subject: String(task.subject),
              status: String(task.status),
              ...task.workKind === undefined ? {} : { workKind: String(task.workKind) },
              verdict: 'no-owner',
            })
            continue
          }
          const milestone = state.members[owner]
          const milestoneVerdict = milestoneDeliveryVerdict(milestone, taskId)
          const ownerMember = memberByName.get(String(owner))
          const ownerStatus = String(ownerMember?.status ?? ownerMember?.state ?? '').toLowerCase()
          const responsibleInactive = ownerMember !== undefined
            && (ownerMember.frozen === true || ['failed', 'frozen', 'inactive', 'stopped', 'terminated'].includes(ownerStatus))
          // The milestone tick is the owner's own statement that its work unit landed.
          // Only a milestone explicitly bound to this task is evidence about this
          // task. A tick for another task, or a legacy tick with no task binding,
          // is neutral: it must not make every open task owned by that member look
          // like a bookkeeping miss.
          open.push({
            id: String(task.id),
            subject: String(task.subject),
            status: String(task.status),
            ...task.workKind === undefined ? {} : { workKind: String(task.workKind) },
            owner,
            ...milestone === undefined ? {} : { ownerMilestone: String(milestone.stage) },
            ...milestoneVerdict.milestoneTaskId === undefined
              ? {}
              : { ownerMilestoneTaskId: milestoneVerdict.milestoneTaskId },
            ...responsibleInactive ? { responsibleInactive: true } : {},
            verdict: milestoneVerdict.verdict,
          })
        }
        blockers.push(...activeDispatchBlockers(durable.dispatches, allTasks))
        const deadLetters = deadLetterRows(durable.dispatches, { openOnly: true })
        const deadLetterBreakdown = deadLetterCounts(deadLetters)
        blockers.push(...deadLetters
          .filter((row) => row.deadLetterKind !== 'system-notification')
          .map((row) => ({ kind: 'wake-dead-letter', ...row })))
        const escalationRows = Object.values(durable.escalations ?? {}).map(escalationViewRow).filter((row) => row !== undefined)
        const escalationSummary = escalationView({ rows: escalationRows, actorTier: 0, status: 'open' })
        for (const row of escalationSummary.escalations) {
          blockers.push({
            kind: 'escalation',
            id: row.escalationId,
            escalationId: row.escalationId,
            category: row.category,
            status: row.status,
            urgency: row.urgency,
            target: row.target,
            summary: row.summary,
            decisionNeeded: row.decisionNeeded,
            automated: row.automated,
          })
        }
        for (const row of Object.values(durable.evidence ?? {})) {
          const status = String(row.status ?? '').toLowerCase()
          if (['resolved', 'cancelled'].includes(status)) continue
          if (['blocker', 'major'].includes(row.classification) || status === 'blocker') {
            blockers.push({ kind: 'finding', id: row.evidenceId, status: row.classification ?? row.status })
          }
        }
        const planCoverage = deliveryCheckCoverage(ctx, caller, durable)
        if (planCoverage.required && !planCoverage.plans.length && !planCoverage.deliverable) {
          blockers.push({ kind: 'plan-coverage', code: planCoverage.code ?? 'DELIVERY_PLAN_REQUIRED', remainingScope: [] })
        }
        for (const row of planCoverage.plans.filter(row => !row.deliverable)) {
          blockers.push({ kind: 'plan-coverage', planId: row.planId, code: row.code, remainingScope: row.remainingScope ?? [] })
        }
        const deliverable = open.length === 0 && blockers.length === 0 && planCoverage.deliverable
        const noOwnerCount = open.filter((row) => row.verdict === 'no-owner').length
        const actionableOpenCount = open.length - noOwnerCount
        const selectedOpen = args.verdict === undefined ? open : open.filter((row) => row.verdict === args.verdict)
        return {
          deliverable,
          ...(planCoverage.required ? { planCoverage: planCoverage.plans } : {}),
          // `deliverable` is about the tasks that exist. Whether they cover what was asked is reported separately
          // and is advisory: it never changes `deliverable`.
          requirementCoverage: (() => { try { return requirementCoverageNote(durable) } catch { return { requirementCompleteness: 'unknown' } } })(),
          openCount: open.length,
          actionableOpenCount,
          noOwnerCount,
          deadLetterCount: deadLetters.length,
          peerDeadLetterCount: deadLetterBreakdown.peerMessage,
          systemDeadLetterCount: deadLetterBreakdown.systemNotification,
          completedNotIntegratedCount: completedNotIntegrated.length,
          completedNotIntegrated,
          oldestDeadLetterAgeMs: deadLetters.reduce((oldest, row) => Math.max(oldest, Number(row.ageMs ?? 0)), 0),
          oldestPeerDeadLetterAgeMs: deadLetterBreakdown.oldestPeerAgeMs,
          deadLetters,
          escalationSummary,
          open: selectedOpen,
          blockers,
          cargoTargetIsolation,
          counters: durable.counters,
        }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_get',
      description: 'Read the complete latest value of one task before changing or executing it.',
      parameters: {
        view: { type: 'string', enum: ['compact', 'full'], description: 'Default full. Compact is a decision projection, not completion evidence.' },
        snapshotRevision: { type: 'integer', description: 'Optional exact control-plane revision.' },
        task_id: { type: 'string', required: true, description: 'Task id.' },
        board: { type: 'string', description: 'Board to read: global, level, group, or an exact board id such as group-proto or level-1. Defaults to global. Tier 0 may read every exact board; the verifier may read group boards read-only; other roles remain restricted to their own board.' },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'team_task_get')
        const me = callerName()
        const inferredBoard = args.board === undefined ? durableTask(args.task_id)?.boardId : undefined
        const boardId = resolveBoard(me, args.board ?? inferredBoard)
        if (!policy().canReadBoard(me, boardId)) refuse('board-read', 'member "' + me + '" may not read board "' + boardId + '"')
        const raw = boardId === 'global' ? await ctx.agentTeams.getTask(caller, TeamTaskId(args.task_id)) : undefined
        const query = taskQuerySnapshot(caller, args)
        const found = raw ?? query.snapshot.boards?.[boardId]?.tasks?.[String(args.task_id)]
        if (found === undefined) throw new Error('unknown task "' + args.task_id + '" on board "' + boardId + '"')
        const projected = projectTaskQueryView(projectReady({ ...found }, caller, boardId, query), args.view)
        return { ...projected, snapshotRevision: query.snapshotRevision, snapshotId: query.snapshotId }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_reconcile',
      description: 'Tier-0-only bookkeeping repair for a stranded REFERENCE task. It may complete only by linking to an already completed same-Team task that carries the exact commit and evidence; it never fabricates evidence or bypasses an execution gate.',
      parameters: {
        task_id: { type: 'string', required: true },
        source_task_id: { type: 'string', required: true, description: 'Completed group-board task whose delivery this reference task represents.' },
        reason: { type: 'string', required: true },
        board: { type: 'string', description: 'Target board: global, level, group, or an exact board id such as group-proto or level-1. Defaults to global.' },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'team_task_reconcile')
        assertTeamRunnable()
        const me = callerName()
        if (record(me)?.tier !== 0) refuse('reconcile-scope', 'only tier 0 may reconcile stranded task bookkeeping')
        const boardId = resolveBoard(me, args.board)
        requireBoardWrite(me, boardId)
        const found = durableTask(args.task_id)
        if (found === undefined) refuse('task-not-found', 'no task named "' + args.task_id + '"')
        if (found.task.status === 'completed') return projectTask(found.task)
        if (boardId !== 'global') {
          refuse('reconcile-scope', 'bookkeeping reconciliation is only for the append-only global reference board')
        }
        const source = durableTask(args.source_task_id)
        if (source === undefined) refuse('reconcile-source', 'source task "' + args.source_task_id + '" does not exist')
        if (source.boardId === 'global') {
          refuse('reconcile-source', 'source task must be an execution task on a group or level board, not another global reference')
        }
        if (source.task.status !== 'completed') {
          refuse('reconcile-source', 'source task "' + args.source_task_id + '" is not completed')
        }
        const sourceRequirement = reconcileSourceRequirement(source.task, args.source_task_id)
        if (!sourceRequirement.ok) refuse(sourceRequirement.code, sourceRequirement.reason)
        const { commitSha, evidenceIds } = sourceRequirement
        const evidence = control().view({ history: false }).evidence ?? {}
        const unknown = evidenceIds.filter((evidenceId) => {
          const row = evidence[evidenceId]
          return row === undefined || String(row.taskId ?? '') !== String(args.source_task_id)
        })
        if (unknown.length > 0) {
          refuse('reconcile-evidence', 'source evidence is missing or foreign: ' + unknown.join(', '))
        }
        const link = await control().evidencePut({
          taskId: args.task_id,
          commitSha,
          requirementId: String(args.source_task_id),
          recordedBy: callerName(),
          kind: 'delivery-reference',
          command: 'team_task_reconcile({task_id:"' + args.task_id + '",source_task_id:"' + args.source_task_id + '"})',
          expected: 'global reference points at a completed execution task with the same delivery',
          actual: 'source_task_id=' + String(args.source_task_id) + '; reason=' + String(args.reason),
          paths: [],
          classification: 'reference',
          status: 'pass',
        }, caller)
        const request = {
          taskId: TeamTaskId(args.task_id),
          expectedRevision: found.task.revision,
          action: 'complete',
          ...commitSha === undefined ? {} : { commitSha },
          evidenceIds: [...new Set([link.evidenceId, ...evidenceIds])],
        }
        await ctx.agentTeams.updateTask(caller, await domainRequestWithCurrentRevision(caller, request))
        await control().boardUpdate({
          boardId,
          ...request,
          taskId: args.task_id,
          actorName: me,
        }, caller)
        const durable = durableTask(args.task_id)
        return projectTask(durable === undefined ? found.task : durable.task)
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_update',
      description: 'Compare-and-set one task action using the latest revision. Tier 0 may reassign any task; a group lead may reassign a task in its own group to one of its tier-2 members when the current owner is not running or the task is dependency-blocked and cannot be in flight. A group lead may also repair write_scopes on an unplanned own-group task when its owner is inactive and no run lease is active; plan-controlled scopes still require replacing the plan. reopen also recovers rejected/cancelled/expired phases. bind_fix repairs the commit/evidence pointers of a completed card without changing its phase or status. The global board accepts mutations from tier 0 only.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Task id.' },
        expected_revision: { type: 'integer', required: true, description: 'Current task revision used as the CAS precondition.' },
        action: { type: 'string', required: true, enum: ['claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete', 'advance_phase', 'admin_close', 'bind_fix'], description: 'Task transition to apply. admin_close is a tier-0-only audit recovery for stranded global reference cards. bind_fix is a narrow completed-card ledger repair.' },
        phase: { type: 'string', enum: TASK_PHASES, description: 'Next durable task phase for advance_phase.' },
        subject: { type: 'string', description: 'Replacement title for edit.' },
        description: { type: 'string', description: 'Replacement details for edit.' },
        goal: { type: 'string', description: 'Replacement contract goal for edit.' },
        deliverable: { type: 'string', description: 'Replacement contract deliverable for edit.' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Complete blocker list for set_dependencies; boardId:taskId selects a cross-board task.' },
        dependency_phase: { type: 'string', enum: ['completed', ...TASK_PHASES], description: 'Dependency release threshold for set_dependencies. Defaults to accepted; completed releases when each dependency status is completed.' },
        write_scopes: { type: 'array', items: { type: 'string' }, description: 'Replacement write scopes for edit.' },
        commit_sha: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Exact commit SHA produced by the task owner when completing it. bind_fix accepts null for a completed card that has no commit.' },
        evidence_ids: { type: 'array', items: { type: 'string' }, description: 'Durable evidence ids proving the completed task.' },
        owner: { type: 'string', description: 'Member name for Lead-only reassign; omit to unassign.' },
        force_complete: { type: 'boolean', description: 'Tier 0 recovery for a global edit card whose owner is inactive. Requires force_complete_reason, exact commit_sha and evidence.' },
        force_complete_reason: { type: 'string', description: 'Audit reason required with force_complete:true.' },
        admin_close_reason: { type: 'string', description: 'Audit reason required with action:"admin_close".' },
        delete_reason: { type: 'string', description: 'Audit reason required when deleting a group-board task.' },
          bind_fix_reason: { type: 'string', description: 'Audit reason required with action:"bind_fix". The action changes only commitSha and evidenceIds on a completed task.' },
          evidence_mode: { type: 'string', enum: ['append', 'replace'], description: 'action:"bind_fix": append (default) or replace the completed card evidence pointer set. replace is required to remove an erroneous pointer.' },
        reopen_reason: { type: 'string', description: 'Required with action:"reopen"; stored on the task as lastReopenReason and lastReopenAt.' },
        reason: { type: 'string', description: 'Alias for reopen_reason when action is "reopen".' },
        board: { type: 'string', description: 'Target board: global, level, group, or an exact board id such as group-proto or level-1. Defaults to global.' },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'team_task_update')
        assertTeamRunnable()
        const unknownFields = taskUpdateUnknownFields(args)
        if (unknownFields.length > 0) {
          refuse('task-update-unknown-fields',
            'team_task_update refuses unknown fields instead of silently ignoring them: ' + unknownFields.join(', '))
        }
        const me = callerName()
        const inferredBoard = args.board === undefined ? durableTask(args.task_id)?.boardId : undefined
        const boardId = resolveBoard(me, args.board ?? inferredBoard)
        const localTaskBeforeUpdate = durableTask(args.task_id)?.task
        const planExists = control().planState(TeamTaskId(args.task_id)) !== undefined
        const ownerName = String(localTaskBeforeUpdate?.ownerName ?? '')
        const liveOwner = ownerName.length === 0
          ? undefined
          : ctx.agentTeams.listMembers(caller).find((row) => String(row?.name ?? '') === ownerName)
        const ownerActive = liveOwner !== undefined
          && ['running', 'provisioning'].includes(String(liveOwner.status ?? '').toLowerCase())
        const activeLease = control().leaseList().some((lease) =>
          lease?.status === 'active' && String(lease.taskId ?? '') === String(args.task_id))
        const scopeRecovery = taskScopeRecoveryVerdict(args, {
          actor: record(me),
          task: localTaskBeforeUpdate,
          boardId,
          planExists,
          ownerActive,
          activeLease,
        })
        const scopeEdit = taskEditWriteScopeVerdict(args, { planExists, recovery: scopeRecovery })
        if (scopeEdit.ok !== true) refuse(scopeEdit.code, scopeEdit.reason)
        const reopen = taskReopenReason(args)
        if (reopen.ok !== true) refuse(reopen.code, reopen.reason)
        if (args.action !== 'reopen' && (args.reopen_reason !== undefined || args.reason !== undefined)) {
          refuse('task-update-reason-action', 'reopen_reason/reason is valid only with action:"reopen"')
        }
        let normalizedCommitSha = args.commit_sha
        if (['complete', 'bind_fix'].includes(args.action)
          && args.commit_sha !== undefined
          && args.commit_sha !== null) {
          const repo = repositoryRoot(exec.agent, undefined, control().planState(TeamTaskId(args.task_id)))
          const verdict = taskCommitShaUpdateVerdict(args.commit_sha, repo, (cwd, argv) => runGit(cwd, argv))
          if (verdict.ok !== true) {
            refuse(verdict.code, 'commit_sha "' + String(args.commit_sha) + '" is not an exact task commit: '
              + String(verdict.detail ?? verdict.code))
          }
          normalizedCommitSha = verdict.commitSha
        }
        const directCompletedReadOnlyAccept = args.action === 'advance_phase'
          && args.phase === 'accepted'
          && localTaskBeforeUpdate?.status === 'completed'
          && ['discussion', 'review'].includes(localTaskBeforeUpdate.workKind)
        const phaseActor = taskPhaseAdvanceActorVerdict({
          action: args.action,
          phase: args.phase,
          actorTier: Number(record(me)?.tier ?? -1),
          allowDirectAccept: directCompletedReadOnlyAccept,
        })
        if (phaseActor.ok !== true) refuse(phaseActor.code, phaseActor.reason)
        const request = {
          taskId: TeamTaskId(args.task_id),
          expectedRevision: args.expected_revision,
          action: args.action,
          ...args.subject === void 0 ? {} : { subject: args.subject },
          ...args.description === void 0 ? {} : { description: args.description },
          ...args.goal === void 0 ? {} : { goal: args.goal },
          ...args.deliverable === void 0 ? {} : { deliverable: args.deliverable },
          ...args.blocked_by === void 0 ? {} : { blockedBy: args.blocked_by.map(TeamTaskId) },
          ...args.dependency_phase === void 0 ? {} : { dependencyPhase: args.dependency_phase },
          ...args.write_scopes === void 0 ? {} : { writeScopes: args.write_scopes },
          ...normalizedCommitSha === void 0 ? {} : { commitSha: normalizedCommitSha },
          ...args.evidence_ids === void 0 ? {} : { evidenceIds: args.evidence_ids },
          ...args.evidence_mode === void 0 ? {} : { evidenceMode: args.evidence_mode },
          ...args.bind_fix_reason === void 0 ? {} : { bindFixReason: args.bind_fix_reason },
          ...args.owner === void 0 ? {} : { owner: args.owner },
          ...args.phase === void 0 ? {} : { phase: args.phase },
          ...args.action === 'release' ? {
            actorTier: Number(record(me)?.tier ?? -1),
            actorGroup: String(record(me)?.group ?? ''),
          } : {},
          ...directCompletedReadOnlyAccept ? { allowDirectAccept: true } : {},
        }
        if (args.action === 'set_dependencies' && Array.isArray(request.blockedBy)) {
          const cycle = dependencyCycle(
            control().view({ history: false }).boards,
            boardId,
            args.task_id,
            request.blockedBy,
          )
          if (cycle !== null) {
            refuse('task-dependency-cycle',
              'blocked_by would create a task dependency cycle: '
              + cycle.map((key) => key.replace('\u0000', ':')).join(' -> '))
          }
        }
        const crossBoard = crossBoardBlockerVerdict(
          request.blockedBy,
          boardId,
          control().view({ history: false }).boards,
        )
        if (crossBoard.invalid.length > 0) {
          refuse('dependency-reference-invalid',
            'blocked_by contains an unresolved board-qualified dependency: ' + crossBoard.detail)
        }
        if (crossBoard.crossBoard.length > 0) {
          refuse('cross-board-blocker-unsupported',
            'blocked_by is board-local: ' + crossBoard.detail
            + '; use board-qualified syntax "' + crossBoard.crossBoard[0].boards[0] + ':' + crossBoard.crossBoard[0].id
            + '" or a waiting ticket')
        }
        const controlRequest = {
          ...request,
          ...args.action === 'reopen' ? { reopenReason: reopen.reason } : {},
          ...args.delete_reason === undefined ? {} : { deleteReason: args.delete_reason.trim() },
          ...scopeRecovery.ok === true ? {
            scopeEditRecovery: true,
            actorTier: Number(record(me)?.tier ?? -1),
            actorGroup: String(record(me)?.group ?? ''),
          } : {},
        }
        const domainRequest = {
          ...request,
          ...args.action === 'set_dependencies' && Array.isArray(request.blockedBy)
            ? { blockedBy: request.blockedBy.filter((reference) => !boardQualifiedDependency(reference, boardId)) }
            : {},
        }
        requireBoardWrite(me, boardId, args.action, args.task_id)
        if (boardId === 'global' && args.action === 'reassign' && typeof args.owner === 'string') {
          const replacement = record(args.owner)
          if (replacement === undefined) refuse('task-owner-unknown', 'owner "' + args.owner + '" is not registered in the Team')
          const boardWrite = taskOwnerBoardWriteVerdict(replacement, boardId)
          if (boardWrite.ok !== true) refuse(boardWrite.code, boardWrite.reason)
        }
        if (args.action === 'admin_close') {
          if (record(me)?.tier !== 0 || boardId !== 'global') {
            refuse('admin-close-scope', 'admin_close is a tier-0 recovery action for stranded global tasks only')
          }
          const reason = typeof args.admin_close_reason === 'string' ? args.admin_close_reason.trim() : ''
          if (reason.length === 0) {
            refuse('admin-close-reason', 'admin_close requires admin_close_reason')
          }
          let current
          try {
            current = await ctx.agentTeams.getTask(caller, TeamTaskId(args.task_id))
          } catch (error) {
            const local = durableTask(args.task_id)
            if (local === undefined) throw error
            const deleted = await control().boardUpdate({
              boardId: 'global',
              taskId: String(args.task_id),
              expectedRevision: local.task.revision,
              action: 'delete',
              actorName: me,
            }, caller)
            policy().refreshBoards()
            return projectTask(deleted)
          }
          if (current.status === 'deleted') return projectTask(current)
          const localProjection = durableTask(args.task_id)?.task
          const expectedRevision = Number(localProjection?.revision ?? current.revision)
          if (Number(args.expected_revision) !== expectedRevision) {
            refuse('admin-close-stale', 'task "' + args.task_id + '" advanced before admin_close: expected revision '
              + String(args.expected_revision) + ', current is ' + String(expectedRevision) + '; re-read the task first')
          }
          const owner = current.ownerName === undefined || current.ownerName === null ? '' : String(current.ownerName)
          if (owner.length > 0) {
            const liveOwner = ctx.agentTeams.listMembers(caller).find((row) => row.name === owner)
            if (liveOwner !== undefined && ['running', 'provisioning'].includes(liveOwner.status)) {
              refuse('admin-close-active-owner', 'task "' + args.task_id + '" is still owned by active member "' + owner + '"')
            }
          }
          const activeLease = control().leaseList().find((lease) =>
            lease.status === 'active' && String(lease.taskId ?? '') === String(args.task_id))
          if (activeLease !== undefined) {
            refuse('admin-close-active-lease', 'task "' + args.task_id + '" still has an active run lease')
          }
          if (Array.isArray(current.blockedBy) && current.blockedBy.length > 0) {
            current = await ctx.agentTeams.updateTask(caller, {
              taskId: TeamTaskId(args.task_id),
              expectedRevision: current.revision,
              action: 'set_dependencies',
              blockedBy: [],
            })
          }
          try {
            current = await ctx.agentTeams.updateTask(caller, {
              taskId: TeamTaskId(args.task_id),
              expectedRevision: current.revision,
              action: 'delete',
            })
          } catch (error) {
            if (/still blocks|TEAM_TASK_HAS_DEPENDENTS/.test(String(error?.message ?? error))) {
              refuse('admin-close-dependent', 'task "' + args.task_id + '" still blocks another task; close dependents first')
            }
            throw error
          }
          await control().evidencePut({
            taskId: args.task_id,
            recordedBy: callerName(),
            kind: 'admin-close',
            command: 'team_task_update({task_id:"' + args.task_id + '",action:"admin_close"})',
            expected: 'stranded global reference card is removed without fabricating a delivery',
            actual: reason,
            classification: 'admin-close',
            status: 'closed',
            paths: [],
          }, caller)
          const local = durableTask(args.task_id)
          if (local === undefined) {
            await ensureGlobalTaskProjection(caller, current)
          }
          const mirrored = durableTask(args.task_id)
          if (mirrored !== undefined && mirrored.task.status !== 'deleted') {
            await control().boardUpdate({
              boardId: 'global',
              taskId: String(args.task_id),
              expectedRevision: mirrored.task.revision,
              action: 'delete',
              actorName: me,
            }, caller)
          }
          policy().refreshBoards()
          return projectTask(current)
        }
        if (args.action === 'delete' && boardId !== 'global') {
          const reason = typeof args.delete_reason === 'string' ? args.delete_reason.trim() : ''
          if (reason.length === 0) refuse('delete-reason', 'deleting a group-board task requires delete_reason')
        }
        if (args.force_complete === true) {
          if (record(me)?.tier !== 0 || boardId !== 'global' || args.action !== 'complete') {
            refuse('force-complete-scope', 'force_complete is a tier-0 recovery action for global edit cards only')
          }
          if (typeof args.force_complete_reason !== 'string' || args.force_complete_reason.trim().length === 0) {
            refuse('force-complete-reason', 'force_complete requires force_complete_reason')
          }
        }
        if (args.action === 'bind_fix') {
          const actorRecord = record(me)
          const target = durableTask(args.task_id)?.task
          if (target === undefined) {
            refuse('bind-fix-task', 'bind_fix requires a task already present in the local control-plane projection')
          }
          if (target.status !== 'completed') {
            refuse('bind-fix-status', 'bind_fix is only for completed tasks; task "' + args.task_id
              + '" is ' + String(target.status))
          }
          const ownGroupBoard = actorRecord?.tier === 1 && boardId === 'group-' + actorRecord.group
          if (actorRecord?.tier !== 0 && !ownGroupBoard) {
            refuse('bind-fix-scope', 'bind_fix is limited to tier 0 or the group lead that owns the target board')
          }
          if (typeof args.bind_fix_reason !== 'string' || args.bind_fix_reason.trim().length === 0) {
            refuse('bind-fix-reason', 'bind_fix requires bind_fix_reason')
          }
          if (args.evidence_mode !== undefined && !['append', 'replace'].includes(args.evidence_mode)) {
            refuse('bind-fix-evidence-mode', 'evidence_mode must be "append" or "replace"')
          }
          const writeScopes = Array.isArray(target.writeScopes) ? target.writeScopes : []
          const workKind = target.workKind ?? (writeScopes.length > 0 ? 'edit' : 'discussion')
          const commitRequired = workKind === 'edit' || writeScopes.length > 0
          if (commitRequired
            && (typeof args.commit_sha !== 'string' || !/^[0-9a-f]{40}$/.test(args.commit_sha.trim()))) {
            refuse('bind-fix-commit', 'bind_fix requires one exact 40-character lowercase commit_sha for edit cards')
          }
          if (!commitRequired) normalizedCommitSha = null
          if (!Array.isArray(args.evidence_ids) || args.evidence_ids.length === 0) {
            refuse('bind-fix-evidence', 'bind_fix requires at least one evidence_id recorded for task "' + args.task_id + '"')
          }
          const activeLease = control().leaseList().find((lease) =>
            lease.status === 'active' && String(lease.taskId ?? '') === String(args.task_id))
          if (activeLease !== undefined) {
            refuse('bind-fix-active-lease', 'bind_fix cannot run while task "' + args.task_id
              + '" has active run lease "' + String(activeLease.runId) + '"')
          }
          const evidence = control().view({ history: false }).evidence ?? {}
          const unknown = args.evidence_ids.map(String).filter((evidenceId) => {
            const row = evidence[evidenceId]
            return row === undefined || String(row.taskId ?? '') !== String(args.task_id)
          })
          if (unknown.length > 0) {
            const available = Object.entries(evidence)
              .filter(([, row]) => String(row?.taskId ?? '') === String(args.task_id))
              .map(([id]) => id)
            refuse('bind-fix-evidence', 'evidence_ids must reference records already stored for task "'
              + args.task_id + '"; unknown or foreign: ' + unknown.join(', ')
              + '; available for this task: ' + (available.length === 0 ? '(none)' : available.join(', ')))
          }
        }
        // §7.2.1: the global board is append-only. Editing or deleting a task there
        // rewrites a prefix every member has already cached. Reassign is a normal
        // owner transition in the shipped domain and is required when a global
        // reference card must be handed to a group lead.
        if (boardId === 'global' && args.action === 'delete') {
          refuse('global-append-only', 'the global board is append-only: deletion is not allowed; use admin_close for a stranded reference card')
        }
        if (boardId === 'global' && args.action === 'edit') {
          if (record(me)?.tier !== 0) {
            refuse('global-append-only', 'the global board is append-only for non-tier-0 callers')
          }
          const allowedEditKeys = new Set(['task_id', 'expected_revision', 'action', 'board', 'subject', 'description'])
          const forbidden = Object.keys(args).filter((key) => !allowedEditKeys.has(key))
          if (forbidden.length > 0) {
            refuse('global-append-only', 'tier 0 may correct only subject/description on the global board; forbidden fields: ' + forbidden.join(', '))
          }
        }
        // Discussion/review tasks are evidence-only; edit tasks must declare a scope.
        if (args.action === 'claim') {
          const durable = durableTask(args.task_id)?.task
          const holder = durable ?? (boardId === 'global'
            ? (await ctx.agentTeams.listTasks(caller)).find((row) => String(row.id) === String(args.task_id))
            : policy().boardGet(boardId, args.task_id))
          const scopes = holder === undefined ? undefined : holder.writeScopes
          const workKind = holder?.workKind ?? (Array.isArray(scopes) && scopes.length > 0 ? 'edit' : 'discussion')
          if (!Array.isArray(scopes) || scopes.length === 0) {
            const plan = control().planState(TeamTaskId(args.task_id))
            const explicitEmptyPlan = workKind === 'edit'
              && plan?.state === 'plan-approved'
              && Array.isArray(plan.writeScopes)
              && plan.writeScopes.length === 0
            if (workKind === 'edit' && !explicitEmptyPlan) {
              refuse('claim-scope', 'edit task "' + args.task_id + '" declares no writeScopes; edit the task before claiming it or recreate it with write_scopes')
            }
          } else if (workKind !== 'edit') {
            refuse('claim-scope', 'task "' + args.task_id + '" is a ' + workKind + ' task and must not declare writeScopes')
          }
          // §7.2.4: a member may not claim a task that writes outside its own area.
          const own = declaredScopes(me, exec.agent === undefined ? undefined : exec.agent.session?.id)
          if (own !== undefined && !own.includes('*')) {
            const outside = scopes.find((scope) => !own.some((allowed) => {
              const root = String(allowed).replace(/[\\/]+$/, '')
              return String(scope) === root || String(scope).startsWith(root + '/')
            }))
            if (outside !== undefined) {
              refuse('claim-scope', 'task "' + args.task_id + '" writes "' + outside + '", which is outside the declared scope of "' + me + '"')
            }
          }
        }
        if (args.action === 'complete') {
          const found = durableTask(args.task_id)
          let plan = control().planState(TeamTaskId(args.task_id))
          const scopes = Array.isArray(found?.task?.writeScopes) ? found.task.writeScopes : []
          const workKind = found?.task?.workKind ?? (scopes.length > 0 ? 'edit' : 'discussion')
          if (workKind === 'edit' && plan !== undefined) {
            if (plan.state !== 'plan-approved') {
              refuse('complete-plan', 'planned task "' + args.task_id + '" requires an approved plan before completion')
            }
            const phase = found?.task?.phase
            const phaseIndex = TASK_PHASES.indexOf(phase)
            const completionPhase = completionPhaseVerdict(phase)
            if (args.force_complete !== true && completionPhase.ok !== true) {
              refuse(completionPhase.code, 'planned task "' + args.task_id + '" '
                + completionPhase.reason
                + '; force_complete is available only to tier 0 on the global board after the owner is inactive')
            }
            if (args.force_complete === true && phaseIndex < TASK_PHASES.indexOf('execution')) {
              refuse('complete-phase', 'forced completion requires the task to have reached execution; current phase is "' + phase + '"')
            }
            if (activeLeaseFor(args.task_id, me) === undefined) {
              if (args.force_complete !== true) {
                refuse('complete-lease', 'planned task "' + args.task_id + '" requires the owner active run lease before completion; tier 0 may use force_complete with a reason only when the owner is inactive')
              }
            }
            if (args.commit_sha === null) {
              const explicitEmptyPlan = plan.state === 'plan-approved'
                && Array.isArray(plan.writeScopes)
                && plan.writeScopes.length === 0
              const evidenceRows = Object.values(control().view({ history: false }).evidence ?? {})
                .filter((row) => String(row?.taskId ?? '') === String(args.task_id))
              const evidenceNonProduct = evidenceRows.length > 0 && evidenceRows.every((row) => {
                const classification = String(row?.classification ?? '').toLowerCase()
                if (['probe', 'evidence-only', 'non-product', 'untracked'].includes(classification)) return true
                const paths = Array.isArray(row?.paths) ? row.paths.map(String) : []
                return paths.length > 0 && paths.every((path) =>
                  path.replace(/\\/g, '/').startsWith('.local/')
                  || path.replace(/\\/g, '/').startsWith('.dsh-worktrees/'))
              })
              const repoRoot = repositoryRoot(exec.agent, undefined, plan)
              const ignoredScopes = scopesAreEntirelyIgnored(repoRoot, scopes)
              const nonProduct = explicitEmptyPlan || evidenceNonProduct || ignoredScopes
              if (!nonProduct) {
                const trackedScopes = scopes.filter((scope) => {
                  const normalized = String(scope).replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '')
                  const absolute = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/')
                  const path = absolute ? relative(repoRoot, String(scope)).replace(/\\/g, '/') : normalized
                  if (path.length === 0 || path === '.' || path === '..' || path.startsWith('../')) return false
                  return runGit(repoRoot, ['ls-files', '--', path]).stdout.trim().length > 0
                })
                const detail = trackedScopes.length > 0
                  ? 'this edit task declares tracked write scopes (' + trackedScopes.join(', ') + '); provide the exact commit_sha'
                  : 'evidence does not prove a non-product delivery and the write scopes are not all gitignored; provide the exact commit_sha or record evidence that every scope is outside tracked product files'
                refuse('complete-commit', 'commit_sha:null rejected: ' + detail)
              }
            } else if (typeof args.commit_sha !== 'string' || args.commit_sha.trim().length === 0) {
              refuse('complete-commit', 'completion requires the exact commit_sha produced by the task')
            }
          } else if (workKind === 'edit') {
            refuse('complete-plan', 'task "' + args.task_id + '" declares write scopes but has no plan: call team_plan_propose, team_plan_approve, advance the task to execution, then complete it with the owner commit_sha')
          } else if (plan !== undefined) {
            // Older builds could leave an edit plan attached to a
            // discussion/review task. Plans are edit-only, so remove the
            // stale record instead of making the task permanently
            // uncloseable.
            await control().planRemove({
              taskId: TeamTaskId(args.task_id),
              reason: 'removed stale edit plan from ' + workKind + ' task',
            }, actor)
            plan = undefined
          }
          if (!Array.isArray(args.evidence_ids) || args.evidence_ids.length === 0) {
            const evidence = control().view({ history: false }).evidence ?? {}
            const available = Object.entries(evidence)
              .filter(([, row]) => String(row?.taskId ?? '') === String(args.task_id))
              .map(([id]) => id)
            refuse('complete-evidence', 'this complete call did not include evidence_ids; task "' + args.task_id
              + '" currently has ' + available.length + ' recorded evidence(s): '
              + (available.length === 0 ? '(none)' : available.join(', '))
              + '; pass evidence_ids explicitly'
              + (available.length === 0 ? ' after recording evidence' : ''))
          }
          const evidence = control().view({ history: false }).evidence ?? {}
          const unknown = args.evidence_ids.map(String).filter((evidenceId) => {
            const row = evidence[evidenceId]
            return row === undefined || String(row.taskId ?? '') !== String(args.task_id)
          })
          if (unknown.length > 0) {
            const available = Object.entries(evidence)
              .filter(([, row]) => String(row?.taskId ?? '') === String(args.task_id))
              .map(([id]) => id)
            refuse('complete-evidence', 'evidence_ids must reference records already stored for task "' + args.task_id + '"; unknown or foreign: '
              + unknown.join(', ') + '; available for this task: ' + (available.length === 0 ? '(none)' : available.join(', ')))
          }
        }
        if (boardId === 'global') {
          const domainSnapshot = await ctx.agentTeams.getTask(caller, TeamTaskId(args.task_id))
          if (domainSnapshot.status !== 'deleted') {
            const before = durableTask(args.task_id)
            if (before === undefined) {
              const mirrored = await ensureGlobalTaskProjection(caller, domainSnapshot)
              if (mirrored !== undefined) request.expectedRevision = mirrored.task.revision
            }
          }
          if (args.action === 'complete' && domainSnapshot.status === 'completed') {
            const local = durableTask(args.task_id)
            if (local !== undefined && local.task.status !== 'completed') {
              await control().boardUpdate({
                boardId,
                taskId: String(args.task_id),
                expectedRevision: local.task.revision,
                action: 'reconcile_complete',
                actorName: me,
                ...(local.task.ownerName === undefined ? {} : { ownerName: local.task.ownerName }),
                ...(request.commitSha === undefined ? {} : { commitSha: request.commitSha }),
                ...(request.evidenceIds === undefined ? {} : { evidenceIds: request.evidenceIds }),
              }, caller)
              policy().refreshBoards()
            }
            const reconciled = durableTask(args.task_id, boardId)
            return reconciled === undefined ? projectTask(domainSnapshot, boardId) : projectTask(reconciled.task, boardId)
          }
          // `advance_phase` is a local control-plane concept. The shipped Team
          // domain only knows its own task actions and rejects the extra action
          // before this layer can record the phase, so phase-only updates stay
          // local and all other mutations continue through the domain CAS.
          //
          // The two CAS counters are deliberately separated here: `expected_revision`
          // is the local board revision the caller read from team_task_get/list,
          // while the domain call is bound to the domain's own current revision.
          // This keeps a local-only phase move from making the next claim/complete
          // fail with a stale domain revision.
          let updated = ['advance_phase', 'bind_fix'].includes(args.action)
            ? projectTask(domainSnapshot, boardId)
            : await ctx.agentTeams.updateTask(caller, await domainRequestWithCurrentRevision(caller, domainRequest))
          await control().boardUpdate({
            boardId,
            ...controlRequest,
            actorName: me,
            actorTier: Number(record(me)?.tier ?? -1),
          }, caller)
          if (args.action === 'complete' && control().planState(TeamTaskId(args.task_id))) {
            const found = durableTask(args.task_id)
            if (found && found.task.phase !== 'member-check') {
              if (args.force_complete === true) {
                if (found.task.phase === 'execution') await advanceTaskPhase(args.task_id, 'member-check', caller)
              } else {
                const completionPhase = completionPhaseVerdict(found.task.phase)
                if (completionPhase.ok !== true) {
                  refuse('task-phase', 'planned task "' + args.task_id + '" '
                    + completionPhase.reason + ' before member-check')
                }
                if (completionPhase.nextPhase !== null) {
                  await advanceTaskPhase(args.task_id, completionPhase.nextPhase, caller)
                }
              }
            }
          }
          if (args.action === 'reopen') {
            const found = durableTask(args.task_id)
            if (found && found.task.phase !== 'room-discussion') {
              await recoverTaskPhaseForReopen(args.task_id, caller)
            }
          }
          if (args.action === 'reassign' && typeof args.owner === 'string') {
            const replacement = record(args.owner)
            const task = durableTask(args.task_id)?.task
            const binding = memberWorktreeBindingVerdict(
              replacement,
              task,
              repositoryRoot(exec.agent, undefined, control().planState(TeamTaskId(args.task_id))),
              config.worktreeRoot,
              replacement?.name,
            )
            if (binding.required === true && binding.needsBinding === true) {
              updated = await control().boardSetWorktree({ taskId: String(args.task_id), worktreePath: binding.path }, caller)
              policy().refreshBoards()
            }
          }
          const durable = durableTask(args.task_id, boardId)
          return durable === undefined ? updated : projectTask(updated, boardId)
        }
        if (args.action === 'reassign') {
          const meRecord = record(me)
          if (meRecord?.tier === 1) {
            if (typeof args.owner !== 'string' || args.owner.trim().length === 0) {
              refuse('reassign-scope', 'a group lead must name a replacement member; only tier 0 may unassign a task')
            }
            const replacement = record(args.owner)
            if (replacement === undefined || replacement.group !== meRecord.group || (replacement.tier !== 2 && replacement.name !== meRecord.name)) {
              refuse('reassign-scope', 'a group lead may reassign only to a tier-2 member of its own group or to itself')
            }
            const currentTask = durableTask(args.task_id)?.task
            const currentOwner = currentTask?.ownerName
            const liveOwner = currentOwner === undefined ? undefined : ctx.agentTeams.listMembers(caller).find((row) => row.name === currentOwner)
            const reassign = reassignActiveOwnerVerdict(currentTask, liveOwner)
            if (reassign.ok !== true) {
              refuse('reassign-active-owner', 'task "' + args.task_id + '" is still owned by active member "' + currentOwner + '"; interrupt or wait before reassigning')
            }
          } else if (meRecord?.tier !== 0) {
            refuse('reassign-scope', 'only a group lead or tier 0 may reassign a task')
          }
        }
        const updated = await policy().boardUpdateAsync(boardId, controlRequest, me, caller)
        if (args.action === 'reassign' && typeof args.owner === 'string') {
          const replacement = record(args.owner)
          const task = durableTask(args.task_id)?.task
          const binding = memberWorktreeBindingVerdict(
            replacement,
            task,
            repositoryRoot(exec.agent, undefined, control().planState(TeamTaskId(args.task_id))),
            config.worktreeRoot,
            replacement?.name,
          )
          if (binding.required === true && binding.needsBinding === true) {
            await control().boardSetWorktree({ taskId: String(args.task_id), worktreePath: binding.path }, caller)
            policy().refreshBoards()
          }
        }
        if (args.action === 'complete' && control().planState(TeamTaskId(args.task_id))) {
          const found = durableTask(args.task_id)
          if (found && found.task.phase !== 'member-check') {
            const completionPhase = completionPhaseVerdict(found.task.phase)
            if (completionPhase.ok !== true) {
              refuse('task-phase', 'planned task "' + args.task_id + '" '
                + completionPhase.reason + ' before member-check')
            }
            if (completionPhase.nextPhase !== null) {
              await advanceTaskPhase(args.task_id, completionPhase.nextPhase, caller)
            }
          }
        }
        if (args.action === 'reopen') {
          const found = durableTask(args.task_id)
            if (found && found.task.phase !== 'room-discussion') {
              await recoverTaskPhaseForReopen(args.task_id, caller)
            }
        }
        const durable = durableTask(args.task_id, boardId)
        return durable === undefined ? updated : projectTask(updated, boardId)
      },
    })))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

/**
 * Register the v2 Team tool set in every live or subsequently published member
 * scope, and apply a requested LLM route to each member as it appears.
 * @param ctx - cordis plugin context.
 * @param config - this plugin row's config.
 */
/**
 * The one route applier of the mounted v2 tool layer.
 * team-operator is a separate plugin that must reach the same
 * ModelSelectionRef registry, and cordis function plugins cannot publish a
 * service without `provide`; a module-level singleton is the same escape hatch
 * team-policy already uses for activePolicy().
 */
let ROUTE_APPLIER

/** The active route applier, or undefined when the v2 tool layer is not mounted. */
export function activeRouteApplier() {
  return ROUTE_APPLIER
}

export function apply(ctx, config = {}) {
  const resolved = {
    freshProvider: config.freshProvider ?? 'spawn',
    forkProvider: config.forkProvider ?? 'fork',
    // The model never chooses an absolute report path: it names the report and
    // this operator-configured directory owns the rest, so verifier_report
    // cannot become a general filesystem write backdoor around the fs guard.
    reportDir: typeof config.reportDir === 'string' && config.reportDir.length > 0
      ? config.reportDir
      : join(process.env.DSH_HOME ?? process.cwd(), 'team-reports'),
    // A verifier verdict only clears a branch when it names the commit it judged.
    clearanceFile: typeof config.clearanceFile === 'string' && config.clearanceFile.length > 0
      ? config.clearanceFile
      : join(process.env.DSH_HOME ?? process.cwd(), 'team-clearances.json'),
    // Worktrees live under <repo>/<worktreeRoot>, one per branch.
    worktreeRoot: typeof config.worktreeRoot === 'string' && config.worktreeRoot.length > 0
      ? config.worktreeRoot
      : '.dsh-worktrees',
    // Self-declared milestones: private progress state that anchors compactions.
    milestonePath: typeof config.milestonePath === 'string' && config.milestonePath.length > 0
      ? config.milestonePath
      : join(process.env.DSH_HOME ?? process.cwd(), 'team-milestones.json'),
    healthPath: typeof config.healthPath === 'string' && config.healthPath.length > 0
      ? config.healthPath
      : join(process.env.DSH_HOME ?? process.cwd(), 'team-health.json'),
    // The window the reminder ratio is measured against. The runtime cannot resolve it
    // synchronously inside a prompt builder, so it is configured; keep it in step with
    // the model's real contextWindow in settings.yaml.
    windowTokens: typeof config.windowTokens === 'number' && config.windowTokens > 0 ? config.windowTokens : 1000000,
    // Both of these were read from `config` inside install() but never forwarded
    // here, so the documented options were dead and the DSH_HOME fallback silently
    // won. A config whitelist is a trap: add every forwarded key explicitly.
    scopesFile: typeof config.scopesFile === 'string' && config.scopesFile.length > 0
      ? config.scopesFile
      : join(process.env.DSH_HOME ?? process.cwd(), 'write-scopes.json'),
    rolesDir: typeof config.rolesDir === 'string' && config.rolesDir.length > 0
      ? config.rolesDir
      : join(process.env.DSH_HOME ?? process.cwd(), 'team-roles'),
    deliveryTimeoutMs: typeof config.deliveryTimeoutMs === 'number' && config.deliveryTimeoutMs > 0
      ? config.deliveryTimeoutMs
      : 5 * 60 * 1000,
    runTimeoutMs: typeof config.runTimeoutMs === 'number' && config.runTimeoutMs > 0
      ? config.runTimeoutMs
      : 30 * 60 * 1000,
    maxDispatchAttempts: typeof config.maxDispatchAttempts === 'number' && config.maxDispatchAttempts > 0
      ? config.maxDispatchAttempts
      : 3,
    wakeAckWaitMs: typeof config.wakeAckWaitMs === 'number' && config.wakeAckWaitMs > 0
      ? Math.floor(config.wakeAckWaitMs)
      : 500,
    maxRoomRounds: typeof config.maxRoomRounds === 'number' && config.maxRoomRounds > 0
      ? Math.floor(config.maxRoomRounds)
      : 3,
    reconcileIntervalMs: typeof config.reconcileIntervalMs === 'number' && config.reconcileIntervalMs > 0
      ? config.reconcileIntervalMs
      : 30000,
    controlDir: typeof config.controlDir === 'string' && config.controlDir.length > 0
      ? config.controlDir
      : join(process.env.DSH_HOME ?? process.cwd(), 'team-control-plane'),
    activityDigestIntervalMs: typeof config.activityDigestIntervalMs === 'number' && config.activityDigestIntervalMs > 0
      ? config.activityDigestIntervalMs
      : 10 * 60 * 1000,
    pendingRoutes: new Map(),
    liveRoutes: new Map(),
  }

  /**
   * Put a route onto one live member agent. A stale holder from a previous
   * agent instance is disposed first: cold resume creates a NEW agent object,
   * so the old disposer would otherwise leak listeners on a dead scope.
   */
  const installRouteOn = (agent, memberName, route) => {
    const previous = resolved.liveRoutes.get(memberName)
    if (previous !== undefined && previous.agent === agent) {
      previous.ref.current = route
      return true
    }
    try {
      const holder = { current: route, assembled: undefined }
      const dispose = installModelSelection(agent.ctx, holder)
      if (previous !== undefined) {
        try {
          previous.dispose()
        } catch {
          /* the old scope may already be gone */
        }
      }
      resolved.liveRoutes.set(memberName, { ref: holder, dispose, agent })
      return true
    } catch {
      return false
    }
  }

  /**
   * Record and, when possible, apply one member's LLM route.
   *
   * A teammate is *not* a permanently live agent: the domain lets it go
   * inactive between turns and cold-resumes it on the next delivery, so
   * looking only at ctx.agents.list() returns false for exactly the members a
   * route change is most needed for (an idle or quota-blocked one). The
   * requested route is therefore always recorded, and agent/created applies it
   * on the member's next turn. `true` means "accepted and effective from the
   * member's next step", not "installed on a live agent right now".
   */
  resolved.applyRoute = (memberName, route) => {
    if (activePolicy() === undefined || activePolicy().get(memberName) === undefined) return false
    resolved.pendingRoutes.set(memberName, route)
    for (const agent of ctx.agents.list()) {
      const membership = ctx.agentTeams.tryMembership(agent)
      if (membership === undefined || membership.name !== memberName) continue
      installRouteOn(agent, memberName, route)
      return true
    }
    return true
  }

  const installed = new Map()
  const inactiveContext = (error) => /inactive context/i.test(String(error?.message ?? error))
  const maybeInstall = (agent) => {
    try {
      if (installed.has(agent) || ctx.agentTeams.tryMembership(agent) === undefined) return
      installed.set(agent, install(agent, ctx, resolved))
      const membership = ctx.agentTeams.tryMembership(agent)
      ctx.logger?.info?.('[team-tools-v2-r10] scoped tools installed for ' + String(membership?.name ?? 'unknown'))
      const teamKey = teamKeyOf(ctx, agent)
      const teamPolicy = teamKey === undefined ? undefined : policyFor(teamKey)
      const pending = resolved.pendingRoutes.get(membership.name)
      const durable = pending ?? teamPolicy?.control.memberRoute?.(membership.name)
      const route = durable === undefined
        ? undefined
        : durable.provider === undefined
          ? durable
          : {
              provider: durable.provider,
              model: durable.model,
              ...(durable.reasoningEffort === undefined ? {} : { reasoningEffort: durable.reasoningEffort }),
            }
      if (route !== undefined) {
        teamPolicy?.setRoute(membership.name, route)
        installRouteOn(agent, membership.name, route)
      }
    } catch (error) {
      if (!inactiveContext(error)) throw error
    }
  }
  ROUTE_APPLIER = resolved.applyRoute
  ctx.effect(() => () => {
    if (ROUTE_APPLIER === resolved.applyRoute) ROUTE_APPLIER = undefined
  }, 'tool-team-v2.routeApplier')
  for (const agent of ctx.agents.list()) maybeInstall(agent)
  ctx.on('agent/created', ({ agent }) => {
    maybeInstall(agent)
  }, { global: true })
  ctx.on('agent/status', ({ agent }) => {
    maybeInstall(agent)
  }, { global: true })
  ctx.on('agent/pre-step', async ({ agent: activeAgent }, next) => {
    maybeInstall(activeAgent)
    return next()
  }, { global: true })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  }, { global: true })
  ctx.effect(() => () => {
    for (const entry of resolved.liveRoutes.values()) {
      try {
        entry.dispose()
      } catch {
        /* already torn down */
      }
    }
    resolved.liveRoutes.clear()
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }, 'tool-team-v2.scopedTools()')
  ctx.effect(() => {
    const installSweep = setInterval(() => {
      try {
        for (const activeAgent of ctx.agents.list()) maybeInstall(activeAgent)
      } catch (error) {
        if (!inactiveContext(error)) throw error
      }
    }, 30000)
    installSweep.unref?.()
    return () => clearInterval(installSweep)
  }, 'tool-team-v2.installSweep()')

  // A running Team's scheduler deliberately goes quiet after dispatch. The
  // digest wakes only the Team Lead and only while at least one group is
  // actually running or holding an active lease. A fully idle Team is silent.
  ctx.effect(() => {
    const disposeDigest = applyActivityDigest(ctx, {
      intervalMs: resolved.activityDigestIntervalMs,
      controlDir: resolved.controlDir,
    })
    return () => disposeDigest?.()
  }, 'tool-team-v2.activityDigest()')
}
