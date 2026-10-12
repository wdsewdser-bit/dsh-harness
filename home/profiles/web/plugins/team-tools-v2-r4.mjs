/**
 * team-tools-v2 — Agent Team v2 / Phase 3 enforcement
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

import { defineTool } from '@deepseek-ai/dsh-tools'
import { TeamTaskId } from '@deepseek-ai/dsh-experimental-agent-team'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { activePolicy, policyFor, reconcileRegistry, stripStamp, teamKeyOf } from './team-policy.mjs'
import { canAdvanceTaskPhase, hashControlValue, latestClosedRound, roomActivity, roomDependencyVerdict, TASK_PHASES } from './team-control-plane.mjs'
import { BAND_START, HARD_RATIO, acknowledgeReminder, armMilestoneCompaction, canReadMilestone, createMilestoneDoc, markCompacted, markMilestoneDone, milestoneMarker, milestoneNotice, milestoneScope, normalizeMilestoneDoc, pendingReminder, pruneStaleMilestoneCompactions, reminderText, setMilestone, shouldCompact } from './team-milestone-v2.mjs'
import { BRANCH_MAIN, absoluteWorktreePath, clearanceDigestGate, groupBranch, memberBranch, mergeExact, mergePlan, runGit, setupPlan, sourceSnapshot, withMergeLock, worktreeAdd, worktreePath } from './team-worktree.mjs'

/** Cordis plugin name. */
export const name = 'tool-agent-team-v2'
/** Services required by the v2 Team tool plugin. */
export const inject = ['agents', 'agentTeams', 'tools', 'systemPrompt']

const POLICY = 'Agent Team v2 is active. Tiers: tier 0 is the session Lead, tier 1 are group leads plus one independent verifier, tier 2 are group members. Constraints are enforced by the runtime, not by this text: a refused call is refused in code.'
  + ' Tier 0 and tier 1 are SCHEDULERS, not workers: your own output is dispatched work and checked results, never the product. Break the goal into accepted tasks, put a named owner on every one of them, supervise, and interrupt the moment a member drifts. If you notice yourself implementing, that is the signal to spawn the member who should own it instead.'
  + ' Dispatch a standing identity with spawn_teammate(role:"lead"|"verifier"|"member") and pass only the task brief — the identity, its duties and its prohibitions come from the role file, so do not restate them. Use role:"custom" only when no standing identity fits, and then write the whole prompt yourself.'
  + ' STOP AFTER DISPATCHING. The moment you have handed work out, end your turn. Do NOT call wait_agent and do NOT poll list_agents / team_task_list to see how things are going: you are a scheduler, and a scheduler waits to be called. A subordinate report may use quiet send_message; if the recipient must act now, use team_wake(target, message, reason), or team_wake_superior for an upward blocked decision. When the whole Team stops, team-idle-watch wakes the Lead once. Polling has zero information gain and burns the whole team budget.'
  + ' DELIVER TO THE VERIFIER ONCE, AND WAKE YOUR SUPERIOR ONLY FOR A DECISION. The verifier is one shared, expensive reviewer: do not wake it once per fix. Let every group lead finish and reconcile, then hand the verifier the whole thing in one delivery. The verifier answers with ONE aggregated table back to the leads, never a stream of one-off messages. The same discipline applies upward: send_message is quiet and never wakes a superior; use team_wake_superior for an upward blocked decision and team_escalate when the decision is genuinely above your level. A normal escalation requires a CLOSED room round, one unresolved point, evidence references and options (or an explicit no-options reason).'
  + ' ROOMS ARE THE DEFAULT PEER CHANNEL. After every team_room_read, obey its waitAction exactly. waitAction="speak" means post exactly one main speech; waitAction="close" means the host closes the round; waitAction="stop" means END THIS TURN IMMEDIATELY and wait for the system room handoff. Never call wait_agent, sleep, poll, re-read, or send progress while a Room turn is pending. The host is always a participant; when the caller does not name the host, the runtime appends it last. A group Room inherits level:1 as its parent whenever that planning room exists, and its rounds are refused until the parent round is closed. A room has at most three rounds: host closes each round with a summary and unresolved list, and after the third unresolved item must use team_escalate instead of reopening the same room. Resolve a completed follow-up item with team_room_resolve rather than leaving stale text.'
  + ' TASKS HAVE A DELIVERABLE KIND. discussion and review tasks carry no write scopes and complete with evidence only; edit tasks require write scopes, an approved plan, an owner lease and commit_sha. Claiming an edit task without scopes is refused.'
  + ' PROGRESS IS PULLED, NOT PUSHED. A superiors progress view lives behind team_milestone(action:"list"), which reports each visible members stage, whether it is ticked, and how full its context is. Call it when you need to judge progress or steer where a milestone should sit; milestone state is never injected into the cacheable system prefix.'
  + ' PEERS TALK DIRECTLY. Same-group members, and group leads across groups, may send_message each other quietly to align interfaces and agree on who edits what; when the peer must act now, use team_wake(target, message, reason). Escalate to your superior only when the decision is genuinely above your level. Peers may also read each other milestones and progress. What peers may NOT do is interrupt each other: interrupt_agent reaches only the members you spawned yourself.'
  + ' WAKE YOUR DIRECT SUPERIOR WHEN A DECISION IS BLOCKED. A tier-2 member may call team_wake_superior to wake its own group lead; a tier-1 lead may use it to wake tier 0. It requires the blocked action, reason and evidence, and coalesces while an unhandled wake exists. Use it for an approval, unblock, or privilege review that cannot proceed without that superior; ordinary progress stays quiet. Do not use send_message when that superior must act now.'
  + ' INTERRUPTING IS YOUR POWER, AND A MESSAGE IS NOT AN INTERRUPT. A message delivered to a RUNNING member is spliced into its next step: it keeps working on whatever it already had in hand, indefinitely. Telling it to stop in a message stops nothing. When a member has drifted, is editing the wrong file, or is grinding on an approach you already rejected, call interrupt_agent — that is the only thing that ends its current turn. Do NOT interrupt for mere slowness, and do not be shy with it when the work is actually wrong: a measured judgement plus interrupt_agent beats a polite message that changes nothing.'
  + ' BEFORE YOU DECLARE ANYTHING DELIVERED, call team_delivery_check. It lists every task still open and tells you, per task, whether the owner forgot to mark it done or the work genuinely was not finished — chase the first with a status fix and the second with a rework order. Announcing a delivery on the strength of your own impression, while the board still shows open work, is exactly the failure this check exists to stop.'
  + ' A wait that returns, a quiet roster, or an empty inbox is NOT evidence that anyone is stuck. Silence means the member is working. Never interrupt, re-dispatch or restart work because you "checked and saw no progress" — only act on a message you actually received, or on a state you can prove is broken (failed phase, a refusal, a stale task). The control plane sends timeout/retry summaries by message, not by rewriting the system prompt.'
  + ' When you ARE woken, handle exactly the one thing that woke you, then stop again. Do not use a wake-up as a licence to re-scan the whole team.'
const ACTIVE_WAIT_STATUSES = new Set(['running', 'provisioning'])
const NO_ACTIVE_PEER_MESSAGE = 'No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents; use team_wake(target, message, reason) for an actionable peer or downward wake, otherwise post the decision in the room or escalate it.'

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
    evidenceIds: { type: 'array', items: { type: 'string' } },
    blockedBy: { type: 'array', required: true, items: { type: 'string' } },
    writeScopes: { type: 'array', required: true, items: { type: 'string' } },
    workKind: { type: 'string', enum: ['discussion', 'review', 'edit'] },
    ready: { type: 'boolean', required: true },
    writeScopeWarnings: { type: 'array', required: true, items: { type: 'string' } },
    board: { type: 'string' },
    createdAt: { type: 'integer' },
  },
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

/** Re-read on every access so step-compaction's file writes cannot be overwritten. */
function milestones(path) {
  MILESTONE_PATH = path
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    MILESTONE_DOC = normalizeMilestoneDoc(parsed)
  } catch {
    MILESTONE_DOC = createMilestoneDoc()
  }
  return MILESTONE_DOC
}

/** Persist the exact document supplied by the caller, never a stale process cache. */
function saveMilestones(path, doc = MILESTONE_DOC) {
  if (doc === undefined) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(doc, null, 1), 'utf8')
  } catch {
    /* Losing milestone text costs a re-declaration, never correctness. */
  }
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
 * @param ctx - plugin context carrying the agent registry and Team service.
 * @param name - the member name to resolve.
 */
function liveAgent(ctx, name) {
  try {
    for (const peer of ctx.agents.list()) {
      const other = ctx.agentTeams.tryMembership(peer)
      if (other !== undefined && other.name === name) return peer
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
      source: { kind: 'plugin', plugin: name, ...source },
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
      kind: 'plugin',
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
  if (source?.kind === 'plugin' && source.plugin === name && source.form === 'notice') return true
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
    source: { kind: 'plugin', plugin: name, form: 'notice', summary: 'team quiet batch' },
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
 */
function deliverThreshold(ctx, agent, name, me, due, tokens, windowSize, scope) {
  deliverNotice(ctx, agent, reminderText(due, tokens, windowSize))
  const parentName = me === undefined ? undefined : me.parent
  if (typeof parentName !== 'string' || parentName.length === 0) return
  const parent = liveAgent(ctx, parentName)
  if (parent === undefined || parent === agent) return
  const declared = scope.members[name]
  const where = me === undefined ? '' : ' (tier ' + me.tier + ', group ' + me.group + ')'
  const state = declared === undefined
    ? 'has not declared a milestone yet'
    : 'milestone "' + declared.stage + '" (done when: ' + declared.doneWhen + ')'
      + (declared.done === true ? ', TICKED' : ', not ticked yet')
  deliverNotice(ctx, parent, '[team context] ' + name + where + ' is at '
    + Math.round(due.ratio * 100) + '% of its context and ' + state
    + '. Its context is approaching the point where a fold would be cheaper than continuing;'
    + ' consider whether its milestone is set where it will finish before that.')
}

/** The verifier clearance recorded against one exact commit, if any. */
function readClearance(config, commit) {
  if (typeof config.clearanceFile !== 'string' || config.clearanceFile.length === 0) return undefined
  try {
    const doc = JSON.parse(readFileSync(config.clearanceFile, 'utf8'))
    const entry = doc === null || typeof doc !== 'object' ? undefined : doc[commit]
    return entry === null || typeof entry !== 'object' ? undefined : entry
  } catch {
    return undefined
  }
}

function readProfileHealth(config) {
  if (typeof config.healthPath !== 'string' || config.healthPath.length === 0) return undefined
  try {
    const value = JSON.parse(readFileSync(config.healthPath, 'utf8'))
    return value !== null && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
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
  const messages = Array.isArray(room.messages) ? room.messages : []
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
  const decisions = Array.isArray(room.decisions) ? room.decisions.slice(-5) : []
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
    decisions,
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
      kind: 'plugin',
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
  const policy = () => {
    // Per Team, not per process: two sessions running a Team at once each project their
    // OWN roster, or the second one sees the first one's members and caps.
    const active = policyFor(teamKeyOf(ctx, agent))
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
    } catch (error) {
      // No Domain roster this step: keep the registry exactly as it is. Logged rather than
      // silent — swallowing this hid a total failure of the rebuild for a long time.
      if (ctx.logger !== undefined) {
        ctx.logger.warn?.('team-policy: registry rebuild skipped: ' + ((error && error.message) || String(error)))
      }
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
    if (me?.tier === 0 || plan.members?.includes(memberName)) return
    refuse('plan-scope', 'member "' + memberName + '" is not assigned to task "' + plan.taskId + '"')
  }
  const assertDispatchAccess = (row, memberName) => {
    const me = record(memberName)
    if (me?.tier === 0 || row.sender === memberName || row.target === memberName) return
    const room = row.roomId ? control().snapshot().rooms?.[row.roomId] : undefined
    if (room?.members?.includes(memberName)) return
    refuse('dispatch-scope', 'member "' + memberName + '" cannot inspect dispatch "' + row.dispatchId + '"')
  }
  const ensureRoom = async (spec, actor) => {
    const cp = control()
    assertRoomMetadata(spec.roomId, spec.kind)
    assertKnownMembers(spec.members)
    const room = await cp.roomOpen(spec, actor)
    assertRoomAccess(room, callerName())
    for (const member of spec.members) {
      assertRoomAdmission(room, member)
      await cp.roomJoin(spec.roomId, member, actor)
    }
    const snapshot = cp.snapshot()
    const current = snapshot.rooms?.[spec.roomId]
    if (current?.currentRoundId && snapshot.rounds?.[current.currentRoundId]?.status === 'open') {
      return { room: current, round: snapshot.rounds[current.currentRoundId] }
    }
    return { room: current ?? room, round: null }
  }
  const wakeRoomMember = async ({ roomId, roundId, target, reason, actor, phase, signal }) => {
    const targetName = resolveTargetName(target)
    if (targetName.length === 0 || targetName === callerName()) return undefined
    const episodeId = 'room:' + String(roomId) + ':' + String(roundId) + ':' + phase + ':' + targetName
    const current = control().snapshot().wakeEpisodes?.[episodeId]
    if (current !== undefined && !['delivery-failed', 'cancelled', 'expired', 'timed-out', 'run-failed'].includes(current.status)) {
      return { target: targetName, status: current.status, dispatchId: current.dispatchId }
    }
    let claimed
    try {
      claimed = await control().wakeClaim({
        episodeId,
        kind: 'control',
        roomId,
        sender: callerName(),
        target: targetName,
        messageHash: hashControlValue(String(reason || 'room handoff')),
      }, actor)
    } catch (error) {
      if (ctx.logger !== undefined) ctx.logger.warn?.('team room wake claim failed for ' + targetName + ': ' + ((error && error.message) || String(error)))
      return { target: targetName, status: 'claim-failed' }
    }
    const dispatch = claimed.dispatch
    if (claimed.claimed === false) {
      return { target: targetName, status: 'coalesced', dispatchId: dispatch.dispatchId }
    }
    try {
      await ctx.agentTeams.sendMessage(actor, {
        target: targetName,
        content: [{ type: 'text', text: '[team room turn] ' + reason }],
        signal,
      })
      await control().dispatchTransition({ dispatchId: dispatch.dispatchId, status: 'delivered' }, actor)
      await control().wakeAcknowledge({ episodeId, status: 'delivered' }, actor)
      return { target: targetName, status: 'delivered', dispatchId: dispatch.dispatchId }
    } catch (error) {
      const detail = (error && error.message) || String(error)
      try {
        await control().dispatchTransition({ dispatchId: dispatch.dispatchId, status: 'delivery-failed', error: detail }, actor)
        await control().wakeAcknowledge({ episodeId, status: 'delivery-failed' }, actor)
      } catch {
        /* The delivery row may already have reached a terminal state. */
      }
      if (ctx.logger !== undefined) ctx.logger.warn?.('team room wake delivery failed for ' + targetName + ': ' + detail)
      return { target: targetName, status: 'delivery-failed', dispatchId: dispatch.dispatchId }
    }
  }
  const retryDispatch = async (dispatchId) => {
    const row = control().dispatchGet(dispatchId)
    if (row === undefined || row.status !== 'queued') return false
    try {
      if (row.wakeup === true) {
        await ctx.agentTeams.sendMessage(agent, {
          target: row.target,
          content: [{ type: 'text', text: '[team retry] A durable dispatch timed out and was requeued. Resolve it or report why it cannot proceed.' }],
          signal: new AbortController().signal,
        })
        await control().dispatchTransition({ dispatchId, status: 'delivered' }, agent)
        const episode = Object.values(control().snapshot().wakeEpisodes ?? {}).find((candidate) => candidate.dispatchId === dispatchId)
        if (episode !== undefined) {
          await control().wakeAcknowledge({ episodeId: episode.episodeId, status: 'delivered' }, agent)
        }
      } else {
        const target = liveAgent(ctx, row.target)
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
  const durableTask = (taskId) => {
    const wanted = String(taskId)
    const snapshot = control().snapshot()
    for (const [boardId, board] of Object.entries(snapshot.boards ?? {})) {
      const task = board.tasks?.[wanted]
      if (task !== undefined) return { boardId, task }
    }
    return undefined
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
      && String(lease.taskId ?? '') === String(taskId)
      && String(lease.member ?? '') === String(memberName))
  const advanceTaskPhase = async (taskId, phase, actor) => {
    if (!TASK_PHASES.includes(phase)) throw new Error('unsupported task phase "' + phase + '"')
    for (let attempt = 0; attempt < 2; attempt++) {
      const found = durableTask(taskId)
      if (found === undefined) return undefined
      const current = TASK_PHASES.includes(found.task.phase) ? found.task.phase : 'draft'
      if (current === phase) return found.task
      if (!canAdvanceTaskPhase(current, phase)) {
        refuse('task-phase', 'task "' + taskId + '" cannot advance from "' + current + '" to "' + phase + '"')
      }
      try {
        const updated = await control().boardUpdate({
          boardId: found.boardId,
          taskId: String(taskId),
          expectedRevision: found.task.revision,
          action: 'advance_phase',
          phase,
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
  const assertTaskPhaseCanAdvance = (taskId, phase) => {
    const found = durableTask(taskId)
    if (found === undefined || control().planState(String(taskId)) === undefined) return
    const current = TASK_PHASES.includes(found.task.phase) ? found.task.phase : 'draft'
    if (!canAdvanceTaskPhase(current, phase)) {
      refuse('task-phase', 'task "' + taskId + '" cannot advance from "' + current + '" to "' + phase + '"')
    }
  }
  const projectTask = (task) => {
    const found = durableTask(task.id)
    if (found === undefined) return task
    const row = found.task
    const projected = {
      ...task,
      // The local control plane is authoritative for task status/phase after a
      // local-only transition; the shipped domain may still report its older
      // pending/in_progress value. Merge local status explicitly instead of
      // letting the domain snapshot win.
      status: row.status ?? task.status,
      revision: row.revision ?? task.revision,
      phase: row.phase,
      ...row.ownerName === undefined ? {} : { ownerName: row.ownerName },
      ...row.commitSha === undefined ? {} : { commitSha: typeof row.commitSha === 'string' ? row.commitSha : null },
      ...row.evidenceIds === undefined ? {} : { evidenceIds: row.evidenceIds },
      ...row.workKind === undefined ? {} : { workKind: row.workKind },
      ...row.createdAt === undefined ? {} : { createdAt: row.createdAt },
    }
    if (Object.prototype.hasOwnProperty.call(projected, 'commitSha') && projected.commitSha !== null && typeof projected.commitSha !== 'string') {
      projected.commitSha = null
    }
    return projected
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
  /** Whether this request already carries the exact milestone snapshot at its tail. */
  const hasMilestoneMessage = (messages, record) => {
    // The marker excludes the human-readable stage text: quotes and other JSON
    // escapes in that text made a full-notice comparison miss every time.
    const marker = milestoneMarker(record)
    const list = messages ?? []
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const message = list[index]
      try {
        if (JSON.stringify(message?.content ?? '').includes(marker)) return true
      } catch {
        /* Ignore a malformed historical message and keep looking for the marker. */
      }
    }
    return false
  }

  try {
    register(scoped.systemPrompt.section({
      name: 'team:policy',
      order: scoped.systemPrompt.getSectionOrder('TEAM_POLICY'),
      text: () => {
        const membership = ctx.agentTeams.membership(agent)
        const me = record(membership.name)
        // This section is deliberately static for the life of the agent. Milestone
        // state and threshold reminders are appended as conversation messages in the
        // pre-step hook below. A changing system prompt invalidates the cache prefix.
        return POLICY + '\nYour Team role is ' + membership.role + '; your Team name is ' + membership.name
          + '; Team id is ' + membership.id
          + (me ? '; tier ' + me.tier + '; group ' + me.group : '')
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
          const activatedPrivilege = await liveControl.privilegeActivate({ member: membership.name })
          if (activatedPrivilege !== undefined) {
            resolved = {
              ...resolved,
              messages: [...(resolved.messages ?? []), createUserMessage({
                content: [{ type: 'text', text: '[team privilege granted] Request ' + activatedPrivilege.requestId
                  + ' is active for THIS turn only. Allowed fail-closed bypass: ' + activatedPrivilege.blockedAction
                  + '. It expires automatically when this turn ends. Identity, cross-group, task-ownership and room rules are not bypassed.' }],
                source: { kind: 'plugin', plugin: name, form: 'notice', summary: 'team privilege granted' },
              })],
            }
          }
          const ownLease = liveControl.leaseList().find((lease) =>
            lease.member === membership.name && lease.status === 'active' && lease.taskId)
          if (ownLease !== undefined) {
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
          const visible = stepped.session?.deriveMessages?.() ?? []
          const currentMessages = [...visible, ...(messages ?? []), ...(resolved.messages ?? [])]
          const foundMilestone = hasMilestoneMessage(currentMessages, declared)
          if (declared !== undefined && !foundMilestone) {
            resolved = {
              ...resolved,
              messages: [...(resolved.messages ?? []), milestoneSnapshotMessage(declared)],
            }
          }

          const controlSnapshot = control().snapshot()
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
          const measured = meter === undefined ? undefined : meter.measure(stepped.session)
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
              deliverThreshold(ctx, stepped, membership.name, record(membership.name), due, tokens, windowSize, progressState)
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
        if (status !== 'idle') return
        try {
          const membership = ctx.agentTeams.membership(changed)
          await control().privilegeEnd({ member: membership.name, reason: 'turn ended' }, changed)
        } catch {
          /* A disposed or unregistered member has no active grant to close. */
        }
      }))
    }

    register(scoped.tools.register(defineTool({
      name: 'spawn_teammate',
      description: 'Create one named, durable teammate. Tier 0 may create tier 1 (a group lead, or the single independent verifier); a tier 1 group lead may create up to three tier 2 members in its own group. Tier 2 members cannot spawn.',
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
              : 'Only tier 0 may freeze: send_message to the Lead asking it to freeze a finished member, then retry this spawn. Do not keep retrying a spawn the roster cannot admit.'
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
      description: 'Send one durable, quiet, non-waking message. Upward messages become quiet room summaries; peer messages are injected only into a live target next step. If the target must act now, do NOT rely on this: call team_wake(target, message, reason) for an actionable peer/downward wake, or team_wake_superior for an upward blocked decision. wake:true remains only for a short downward control delivery.',
      parameters: {
        target: { type: 'string', required: true, description: 'Team member name, or lead.' },
        message: { type: 'string', required: true, description: 'Self-contained message for the target.' },
        wake: { type: 'boolean', description: 'Wake an inactive subordinate for a short control delivery. Upward/peer wake is refused.' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: { messageId: { type: 'string', required: true }, status: { type: 'string', required: true, enum: ['queued', 'delivered', 'room-summary'] }, roomId: { type: 'string' }, roundId: { type: 'string' }, dispatchId: { type: 'string' } } }),
      async execute(args, exec) {
        const actor = callingAgent(exec.agent, 'send_message')
        const me = record(callerName())
        const targetName = resolveTargetName(args.target)
        const message = Array.isArray(args.message)
          ? args.message.map((part) => typeof part === 'string' ? part : String(part?.text ?? '')).join('\n')
          : String(args.message ?? '')
        if (message.trim().length === 0) refuse('message-empty', 'send_message requires non-empty text')
        const whyMessage = policy().whyCannotMessage(callerName(), targetName)
        if (whyMessage !== undefined) refuse('message-scope', whyMessage)
        // Freezing has to MEAN something, or it is just a quota trick and the model keeps
        // waking members it deliberately parked. Restore is the way back, and the refusal
        // says so, because a model that does not know the exit retries forever.
        const targetRecord = policy().get(targetName)
        if (targetRecord !== undefined && targetRecord.frozen === true) {
          refuse('target-frozen', 'member "' + targetName + '" is frozen: it receives nothing until you restore it with freeze_member(target:"' + targetName + '", frozen:false)')
        }
        const upward = targetRecord !== undefined && me !== undefined && targetRecord.tier < me.tier
        if (args.wake === true && upward) {
          refuse('upward-wake', 'send_message never wakes a superior; use team_escalate with a closed room round and evidence')
        }
        if (args.wake === true && targetRecord !== undefined && me !== undefined && targetRecord.tier === me.tier) {
          refuse('peer-wake', 'send_message never wakes a peer; deliver a quiet room message or use the agreed round')
        }
        const spec = roomSpec(callerName(), targetName)
        const { round } = await ensureRoom(spec, actor)
        const posted = await control().roomNotice({
          roomId: spec.roomId,
          roundId: round?.roundId,
          author: callerName(),
          content: message,
          references: [],
        }, actor)
        const dispatch = await control().dispatchCreate({
          roomId: spec.roomId,
          sender: callerName(),
          target: targetName,
          message,
          messageHash: hashControlValue(message),
          wakeup: args.wake === true,
        }, actor)
        await control().dispatchTransition({ dispatchId: dispatch.dispatchId, status: 'queued' }, actor)
        let status = upward ? 'room-summary' : 'queued'
        try {
          if (args.wake === true) {
            await ctx.agentTeams.sendMessage(actor, {
              target: targetName,
              content: [{ type: 'text', text: '[team control message from ' + callerName() + '] ' + message }],
              signal: exec.signal,
            })
            status = 'delivered'
          } else {
            const targetAgent = liveAgent(ctx, targetName)
            const delivered = deliverPluginMessage(ctx, targetAgent,
              '[team message from ' + callerName() + '] ' + message,
              { form: 'notice', summary: message.slice(0, 120) })
            if (delivered) status = 'delivered'
          }
          if (args.wake !== true) {
            // A quiet message has no target run to acknowledge. Its durable record
            // is the delivery: closing it here prevents the reconcile timer from
            // turning every ordinary notice into a red timed-out dispatch.
            await control().dispatchTransition({ dispatchId: dispatch.dispatchId, status: 'delivered' }, actor)
            await control().dispatchTransition({ dispatchId: dispatch.dispatchId, status: 'completed' }, actor)
            status = upward ? 'room-summary' : 'delivered'
          } else if (status === 'delivered') {
            await control().dispatchTransition({
              dispatchId: dispatch.dispatchId,
              status: 'delivered',
            }, actor)
            await control().dispatchTransition({ dispatchId: dispatch.dispatchId, status: 'completed' }, actor)
          }
        } catch (error) {
          if (args.wake === true) {
            await control().dispatchTransition({ dispatchId: dispatch.dispatchId, status: 'delivery-failed', error: error?.message ?? String(error) }, actor)
            throw error
          }
        }
        return {
          messageId: posted.messageId,
          status,
          roomId: spec.roomId,
          ...(round?.roundId === undefined ? {} : { roundId: round.roundId }),
          dispatchId: dispatch.dispatchId,
        }
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
      },
      output: jsonOutput(roomOutput),
      async execute(args, exec) {
        const actor = callingAgent(exec.agent, 'team_room_open')
        if (record(callerName())?.tier === 2) {
          refuse('room-open-scope', 'tier 2 members cannot open rooms; wait for your group lead to open and wake the round')
        }
        assertRoomMetadata(args.room_id, args.kind)
        const baseMembers = [...new Set([callerName(), ...(args.members ?? []).map(String)])]
        const host = explicitRoomHost(args.kind, args.room_id, callerName(), baseMembers)
        if (host === undefined) {
          refuse('room-host', 'room "' + args.room_id + '" has no eligible host')
        }
        const members = [...new Set([...baseMembers, host])]
        assertKnownMembers(members)
        const room = await control().roomOpen({
          roomId: args.room_id,
          kind: args.kind,
          title: args.title,
          members,
          host,
          dependsOnRooms: args.depends_on,
        }, actor)
        assertRoomAccess(room, callerName())
        for (const member of members) {
          assertRoomAdmission(room, member)
          await control().roomJoin(room.roomId, member, actor)
        }
        return { roomId: room.roomId, status: room.status }
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
        const current = control().snapshot().rooms?.[args.room_id]
        if (!current) {
          if (pendingRoomJoin(args.room_id)) return { roomId: args.room_id, status: 'pending' }
          refuse('room-not-found', 'no room named "' + args.room_id + '"')
        }
        if (member !== callerName() && record(callerName())?.tier !== 0 && current.host !== callerName()) {
          refuse('room-membership', 'only tier 0 or the room host may add another member to a room')
        }
        assertKnownMembers([member])
        assertRoomAdmission(current, member)
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
        const controlSnapshot = control().snapshot()
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
        const members = requested.includes(room.host) ? requested : [...requested, room.host]
        assertKnownMembers(members)
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
        const snapshot = control().snapshot()
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
        const updated = control().snapshot()
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
        const snapshot = control().snapshot()
        const room = snapshot.rooms?.[args.room_id]
        if (!room) {
          if (pendingRoomJoin(args.room_id)) return pendingRoomSnapshot(args.room_id)
          refuse('room-not-found', 'no room named "' + args.room_id + '"')
        }
        assertRoomAccess(room, callerName())
        const compact = compactRoomSnapshot(snapshot, args.room_id, callerName(), config.maxRoomRounds)
        return {
          ...compact,
          ...args.include_messages === true ? { messages: room.messages } : {},
        }
      },
    })))
    register(scoped.tools.register(defineTool({
      name: 'team_room_close',
      description: 'Close the active room round and persist a compact summary.',
      parameters: { room_id: { type: 'string', required: true }, round_id: { type: 'string' }, summary: { type: 'string', required: true }, unresolved: { type: 'array', items: { type: 'string' } } },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: { roomId: { type: 'string', required: true }, roundId: { type: 'string', required: true }, status: { type: 'string', required: true } } }),
      async execute(args, exec) {
        const actor = callingAgent(exec.agent, 'team_room_close')
        const room = control().snapshot().rooms?.[args.room_id]
        if (!room) refuse('room-not-found', 'no room named "' + args.room_id + '"')
        assertRoomAccess(room, callerName())
        assertRoomHost(room, callerName())
        const result = await control().roomClose({ roomId: args.room_id, roundId: args.round_id, summary: args.summary, unresolved: args.unresolved }, actor)
        return { roomId: result.room.roomId, roundId: result.round.roundId, status: result.round.status }
      },
    })))
    register(scoped.tools.register(defineTool({
      name: 'team_room_decide',
      description: 'Record a room decision and its rationale without waking the hierarchy.',
      parameters: { room_id: { type: 'string', required: true }, round_id: { type: 'string' }, title: { type: 'string', required: true }, choice: { type: 'string', required: true }, rationale: { type: 'string', required: true }, references: { type: 'array', items: { type: 'string' } } },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: { decisionId: { type: 'string', required: true }, status: { type: 'string', required: true } } }),
      async execute(args, exec) {
        const actor = callingAgent(exec.agent, 'team_room_decide')
        const room = control().snapshot().rooms?.[args.room_id]
        if (!room) refuse('room-not-found', 'no room named "' + args.room_id + '"')
        assertRoomAccess(room, callerName())
        assertRoomHost(room, callerName())
        const decision = await control().roomDecision({ roomId: args.room_id, roundId: args.round_id, title: args.title, choice: args.choice, rationale: args.rationale, references: args.references, decidedBy: callerName() }, actor)
        return { decisionId: decision.decisionId, status: decision.status }
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
        const room = control().snapshot().rooms?.[args.room_id]
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
        const room = args.room_id === undefined ? undefined : control().snapshot().rooms?.[args.room_id]
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
          try {
            await ctx.agentTeams.sendMessage(caller, { target, content: [{ type: 'text', text: '[team escalation] ' + args.summary + '\nDecision needed: ' + args.decision_needed }], signal: exec.signal })
            await control().dispatchTransition({ dispatchId: dispatch.dispatchId, status: 'delivered' }, caller)
            await control().wakeAcknowledge({ episodeId, status: 'delivered' }, caller)
          } catch (error) {
            await control().dispatchTransition({ dispatchId: dispatch.dispatchId, status: 'delivery-failed', error: error?.message ?? String(error) }, caller)
            throw error
          }
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
        const row = control().snapshot().escalations?.[args.escalation_id]
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
      name: 'team_wake',
          description: 'Wake one exact Team target for a message that must cause action now. send_message and Room posts are quiet by default; use this only for an actionable peer or downward delivery that cannot wait for the next wake. Upward decision wakes must use team_wake_superior with blocked_action and evidence. A pending identical sender/target wake is coalesced.'
,
      parameters: {
        target: { type: 'string', required: true, description: 'Exact Team member name, or lead where the sender is allowed to reach it.' },
        message: { type: 'string', required: true, description: 'Self-contained actionable message for the target.' },
        reason: { type: 'string', required: true, description: 'Why the target must act now instead of receiving a quiet message.' },
        task_id: { type: 'string' },
        urgency: { type: 'string', enum: ['normal', 'high', 'critical'], description: 'Critical is reserved for safety or data-loss risk.' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: {
        target: { type: 'string', required: true },
        status: { type: 'string', required: true, enum: ['delivered', 'coalesced'] },
        dispatchId: { type: 'string', required: true },
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
        const text = '[team wake] ' + callerName() + ' -> ' + target
          + '\nMessage: ' + message
          + '\nReason: ' + reason
          + (args.task_id === undefined ? '' : '\nTask: ' + String(args.task_id))
          + (args.urgency === undefined ? '' : '\nUrgency: ' + String(args.urgency))
        const episodeId = 'team-wake:' + callerName() + ':' + target
        const claimed = await control().wakeClaim({
          episodeId,
          kind: 'control',
          taskId: args.task_id,
          sender: callerName(),
          target,
          messageHash: hashControlValue(text),
        }, caller)
        const dispatch = claimed.dispatch
        if (claimed.claimed === false) return { target, status: 'coalesced', dispatchId: dispatch.dispatchId }
        try {
          await ctx.agentTeams.sendMessage(caller, { target, content: [{ type: 'text', text }], signal: exec.signal })
          await control().dispatchTransition({ dispatchId: dispatch.dispatchId, status: 'delivered' }, caller)
          await control().wakeAcknowledge({ episodeId, status: 'delivered' }, caller)
        } catch (error) {
          await control().dispatchTransition({ dispatchId: dispatch.dispatchId, status: 'delivery-failed', error: error?.message ?? String(error) }, caller)
          throw error
        }
        return { target, status: 'delivered', dispatchId: dispatch.dispatchId }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_wake_superior',
      description: 'Wake your direct superior for a decision that is actually blocked on them. A tier-2 member reaches only its own group lead; a tier-1 lead reaches tier 0. Include the blocked action, reason and evidence. Use team_wake instead for an actionable peer or downward delivery. A pending wake for the same sender/target is coalesced.',
      parameters: {
        blocked_action: { type: 'string', required: true, description: 'The exact action waiting on the superior.' },
        reason: { type: 'string', required: true, description: 'Why this cannot be resolved inside the group or by a normal quiet message.' },
        evidence: { type: 'array', required: true, items: { type: 'string' }, description: 'Evidence proving the block or pending decision.' },
        task_id: { type: 'string' },
        privilege_request_id: { type: 'string', description: 'Optional privilege request awaiting tier-0 review.' },
        urgency: { type: 'string', enum: ['normal', 'high', 'critical'], description: 'Critical is reserved for safety or data-loss risk.' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: {
        target: { type: 'string', required: true },
        status: { type: 'string', required: true, enum: ['delivered', 'coalesced'] },
        dispatchId: { type: 'string', required: true },
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
        const evidence = Array.isArray(args.evidence) ? args.evidence.map(String).filter((row) => row.trim().length > 0) : []
        if (reason.length === 0 || blockedAction.length === 0 || evidence.length === 0) {
          refuse('wake-superior-evidence', 'wake_superior requires blocked_action, reason and at least one evidence reference')
        }
        const text = '[team superior wake] ' + callerName() + ' -> ' + target
          + '\nBlocked action: ' + blockedAction
          + '\nReason: ' + reason
          + '\nEvidence: ' + evidence.join(' | ')
          + (args.task_id === undefined ? '' : '\nTask: ' + String(args.task_id))
          + (args.privilege_request_id === undefined ? '' : '\nPrivilege request: ' + String(args.privilege_request_id))
          + (args.urgency === undefined ? '' : '\nUrgency: ' + String(args.urgency))
        const episodeId = 'superior-wake:' + callerName() + ':' + target
        const claimed = await control().wakeClaim({
          episodeId,
          kind: 'control',
          taskId: args.task_id,
          sender: callerName(),
          target,
          messageHash: hashControlValue(text),
        }, caller)
        const dispatch = claimed.dispatch
        if (claimed.claimed === false) return { target, status: 'coalesced', dispatchId: dispatch.dispatchId }
        try {
          await ctx.agentTeams.sendMessage(caller, { target, content: [{ type: 'text', text }], signal: exec.signal })
          await control().dispatchTransition({ dispatchId: dispatch.dispatchId, status: 'delivered' }, caller)
          await control().wakeAcknowledge({ episodeId, status: 'delivered' }, caller)
        } catch (error) {
          await control().dispatchTransition({ dispatchId: dispatch.dispatchId, status: 'delivery-failed', error: error?.message ?? String(error) }, caller)
          throw error
        }
        return { target, status: 'delivered', dispatchId: dispatch.dispatchId }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_privilege_request',
      description: 'Request a one-turn fail-closed bypass. Tier 1/2 members may request it for themselves only, with the blocked action, reason and evidence. Tier 0 reviews; approval activates on the requester next wake and ends with that turn.',
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
      description: 'Tier-0 review of a one-turn privilege request. Approve or reject with a reason. Approval applies only to the requester next wake and expires when that turn ends.',
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
      description: 'Create the durable execution plan for a task. Worktree setup and execution are refused until a lead approves it.',
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
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: { taskId: { type: 'string', required: true }, state: { type: 'string', required: true }, proposedBy: { type: 'string', required: true } } }),
      async execute(args, exec) {
        const actor = callingAgent(exec.agent, 'team_plan_propose')
        assertTeamRunnable()
        const me = callerName()
        const members = [...new Set(args.members.map(String))]
        if (!members.includes(me)) members.push(me)
        for (const member of members) if (record(member) === undefined) refuse('plan-member', 'plan names unknown member "' + member + '"')
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
          proposedBy: me,
        }, actor)
        await advanceTaskPhase(args.task_id, 'plan-proposed', actor)
        return { taskId: plan.taskId, state: plan.state, proposedBy: plan.proposedBy }
      },
    })))
    register(scoped.tools.register(defineTool({
      name: 'team_plan_approve',
      description: 'Approve a proposed execution plan. Group leads approve plans contained in their group; cross-group plans require tier 0.',
      parameters: { task_id: { type: 'string', required: true } },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: { taskId: { type: 'string', required: true }, state: { type: 'string', required: true }, approvedBy: { type: 'string', required: true } } }),
      async execute(args, exec) {
        const actor = callingAgent(exec.agent, 'team_plan_approve')
        assertTeamRunnable()
        const me = callerName()
        const mine = record(me)
        const plan = control().planState(TeamTaskId(args.task_id))
        if (!plan) refuse('plan-not-found', 'no plan exists for task "' + args.task_id + '"')
        const groups = new Set(plan.members.map((name) => record(name)?.group).filter(Boolean))
        if (mine?.tier !== 0 && (mine?.tier !== 1 || groups.size !== 1 || !groups.has(mine.group))) {
          refuse('plan-approval-scope', 'only the owning group lead may approve a single-group plan; cross-group plans require tier 0')
        }
        const approved = await control().planApprove({ taskId: TeamTaskId(args.task_id), approvedBy: me }, actor)
        await advanceTaskPhase(args.task_id, 'plan-approved', actor)
        return { taskId: approved.taskId, state: approved.state, approvedBy: approved.approvedBy }
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
        assertPlanAccess(plan, callerName())
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
        const snapshot = control().snapshot()
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
          })),
          wakeEpisodes: Object.values(snapshot.wakeEpisodes ?? {}).map((episode) => ({
            episodeId: episode.episodeId,
            target: episode.target,
            status: episode.status,
            mergedCount: episode.mergedCount,
            escalationIds: episode.escalationIds,
            updatedAt: episode.updatedAt,
          })),
          plans: visiblePlans.map((plan) => ({ taskId: plan.taskId, state: plan.state, approvedBy: plan.approvedBy })),
          pendingCompactions: Object.entries(milestoneState.compactions ?? {})
            .filter(([, row]) => row?.status !== 'compacted')
            .map(([member, row]) => ({ member, status: row?.status ?? 'pending', attempts: row?.attempts ?? 0, requestedAt: row?.requestedAt ?? null })),
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
        status: { type: 'string', enum: ['completed', 'cancelled', 'expired', 'failed'] },
        error: { type: 'string' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: true }),
      async execute(args, exec) {
        const actor = callingAgent(exec.agent, 'team_run_lease')
        const me = callerName()
        let lease
        if (args.action === 'acquire') {
          assertTeamRunnable()
          if (args.task_id) control().planRequireApproved(TeamTaskId(args.task_id))
          lease = await control().leaseAcquire({ member: me, taskId: args.task_id, dispatchId: args.dispatch_id, expiresAt: args.expires_at }, actor)
          if (args.dispatch_id) {
            await control().dispatchTransition({ dispatchId: args.dispatch_id, status: 'turn-started', runId: lease.runId }, actor)
          }
          if (args.task_id) await advanceTaskPhase(args.task_id, 'execution', actor)
        } else if (args.action === 'heartbeat') {
          lease = await control().leaseHeartbeat({ runId: args.run_id, checkpoint: args.checkpoint, expiresAt: args.expires_at }, actor)
          const linked = lease.dispatchId
          if (linked) {
            await control().dispatchTransition({ dispatchId: linked, status: 'checkpointed', runId: lease.runId, checkpoint: args.checkpoint }, actor)
          }
        } else {
          const existing = control().leaseGet(args.run_id)
          if (existing === undefined) refuse('lease-not-found', 'unknown run lease "' + String(args.run_id) + '"')
          if ((args.status ?? 'completed') === 'completed' && existing.taskId) {
            const task = durableTask(existing.taskId)?.task
            if (task !== undefined && task.status !== 'completed') {
              refuse('lease-release-order', 'task "' + existing.taskId + '" is still ' + task.status
                + '; complete it while the lease is active before releasing the lease as completed')
            }
          }
          lease = await control().leaseRelease({ runId: args.run_id, status: args.status ?? 'completed', error: args.error }, actor)
          if (lease.dispatchId) {
            const dispatchStatus = lease.status === 'completed' ? 'completed'
              : lease.status === 'cancelled' ? 'cancelled'
                : lease.status === 'expired' ? 'expired' : 'run-failed'
            await control().dispatchTransition({ dispatchId: lease.dispatchId, status: dispatchStatus, runId: lease.runId, error: args.error }, actor)
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
        if (args.task_id) {
          const plan = control().planState(TeamTaskId(args.task_id))
          if (plan) assertPlanAccess(plan, callerName())
        }
        const row = await control().evidencePut({ taskId: args.task_id, commitSha: args.commit_sha, requirementId: args.requirement_id, kind: args.kind, command: args.command, expected: args.expected, actual: args.actual, output: args.output, paths: args.paths, classification: args.classification, status: args.status }, actor)
        return structuredClone(row)
      },
    })))
    register(scoped.tools.register(defineTool({
      name: 'team_acceptance_packet',
      description: 'Submit one aggregated group or verifier acceptance packet. Individual members do not wake the verifier directly.',
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
      },
      output: jsonOutput({ type: 'object', additionalProperties: true }),
      async execute(args, exec) {
        const actor = callingAgent(exec.agent, 'team_acceptance_packet')
        const me = callerName()
        const mine = record(me)
        if (args.kind === 'group-acceptance' && mine?.tier !== 1) refuse('packet-scope', 'only a group lead may submit a group acceptance packet')
        if (args.kind === 'verifier-review' && mine?.group !== 'verifier') refuse('packet-scope', 'only the independent verifier may submit a verifier review packet')
        if (args.kind === 'final-acceptance' && mine?.tier !== 0) refuse('packet-scope', 'only tier 0 may submit the final acceptance packet')
        const phaseBeforePacket = args.kind === 'group-acceptance'
          ? 'group-check'
          : args.kind === 'verifier-review'
            ? 'verifier-review'
            : 'accepted'
        for (const taskId of args.task_ids) assertTaskPhaseCanAdvance(taskId, phaseBeforePacket)
        const packet = await control().packetPut({
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
          submittedBy: me,
        }, actor)
        for (const taskId of args.task_ids) {
          await advanceTaskPhase(taskId, phaseBeforePacket, actor)
          if (args.kind === 'verifier-review' && (!Array.isArray(args.blockers) || args.blockers.length === 0)) {
            await advanceTaskPhase(taskId, 'integration-ready', actor)
          }
        }
        return structuredClone(packet)
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
      name: 'wait_agent',
      description: 'Rarely needed and NEVER used to wait for a Room turn. When a Room is open, obey team_room_read.waitAction: stop means end the turn and let the system handoff wake you. This tool never wakes inactive members and returns noProgress immediately when no other member is running or provisioning. A return from this call, or the absence of one, is never evidence that a member is stuck.',
      parameters: { timeout_ms: { type: 'integer', description: 'Wait duration in milliseconds, from 10000 through 3600000. Defaults to 30000.' } },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: { timedOut: { type: 'boolean', required: true }, noProgress: { type: 'object', additionalProperties: false, properties: { reason: { type: 'string', required: true, enum: ['no-active-peer', 'room-turn-pending'] }, message: { type: 'string', required: true } } } } }),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'wait_agent')
        const me = callerName()
        const timeoutMs = args.timeout_ms ?? 3e4
        const mineRecord = record(me)
        const activeRoom = Object.values(control().snapshot().rounds ?? {}).find((round) =>
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
        return Promise.resolve(ctx.agentTeams.interrupt(caller, args.target))
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
        } catch (error) {
          refuse('domain-sync', 'the durable member route could not be persisted: ' + (error && error.message) || String(error))
        }
        policy().setRoute(args.target, pinnedRoute)
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
      description: 'Declare, tick and read the MILESTONE: the stage you can finish before your next task, plus the check that proves it done. Ticking it is what makes the runtime fold your context at a real task edge instead of cutting a task in half, so declare one early. Only you can set or tick YOUR OWN milestone; a superior and a peer may read it. action=list defaults to your own.',
      parameters: {
        action: { type: 'string', required: true, enum: ['set', 'done', 'list'], description: 'set declares or replaces your milestone, done ticks it and arms the compaction, list reads milestones you are allowed to see.' },
        stage: { type: 'string', description: 'action=set: the stage, e.g. "deliver and verify one user-visible capability". Must be finishable before your next task.' },
        done_when: { type: 'string', description: 'action=set: the command or check that proves it done, e.g. "run the project focused acceptance command and confirm PASS".' },
        target: { type: 'string', description: 'action=list: read this member instead of yourself. Must be a member you are allowed to read.' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: {
        action: { type: 'string', required: true },
        stage: { type: 'string' },
        doneWhen: { type: 'string' },
        done: { type: 'boolean' },
        armed: { type: 'boolean' },
        notice: { type: 'string' },
        openTasks: { type: 'array', items: { type: 'string' } },
        members: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          owner: { type: 'string', required: true },
          stage: { type: 'string' },
          doneWhen: { type: 'string' },
          done: { type: 'boolean', required: true },
          pendingCompaction: { type: 'object', additionalProperties: false, properties: {
            status: { type: 'string', required: true },
            reason: { type: 'string', required: true },
            milestoneStage: { type: 'string', required: true },
            requestedAt: { type: 'integer' },
          } },
          contextPct: { type: 'integer' },
        } } },
      } }),
      async execute(args, exec) {
        callingAgent(exec.agent, 'team_milestone')
        const me = callerName()
        const doc = milestones(config.milestonePath)
        const state = milestoneState(doc)
        const mine = record(me)

        if (args.action === 'set') {
          if (typeof args.stage !== 'string' || args.stage.trim().length === 0) {
            refuse('milestone-stage', 'a milestone needs a stage: what can you finish before your next task?')
          }
          if (typeof args.done_when !== 'string' || args.done_when.trim().length === 0) {
            refuse('milestone-proof', 'a milestone needs done_when: the command or check that proves it done, so ticking it is a fact rather than a feeling')
          }
          // No target parameter exists on purpose: a milestone is private to its owner,
          // so "set someone else's" is not a thing the caller can even express.
          const saved = setMilestone(state, me, args.stage.trim(), args.done_when.trim(), Date.now())
          saveMilestones(config.milestonePath)
          return { action: 'set', stage: saved.stage, doneWhen: saved.doneWhen, done: false, armed: false, notice: milestoneNotice(saved), members: [] }
        }

        if (args.action === 'done') {
          const ticked = markMilestoneDone(state, me, Date.now())
          if (ticked === undefined) refuse('milestone-missing', 'you have not declared a milestone yet: call team_milestone(action:"set", ...) first')
          // Keep the fold independent of the mutable current milestone. The normal
          // workflow ticks this one and immediately sets the next one; replacing the
          // record must not cancel the already-armed fold.
          const armed = armMilestoneCompaction(state, me, Date.now())
          saveMilestones(config.milestonePath)
          const openTasks = Object.values(control().snapshot().boards ?? {})
            .flatMap((board) => Object.values(board.tasks ?? {}))
            .filter((task) => task.ownerName === me && !['completed', 'deleted'].includes(task.status))
            .map((task) => String(task.id))
          // Armed, not compacted: compactNow() needs an idle agent, and this call runs
          // inside a turn. The idle transition is what actually fires it.
          return {
            action: 'done',
            stage: ticked.stage,
            doneWhen: ticked.doneWhen,
            done: true,
            armed: armed !== undefined,
            notice: milestoneNotice(ticked) + (openTasks.length === 0
              ? ''
              : ' Board check: your owned tasks ' + openTasks.join(', ') + ' are still open; complete or reopen them explicitly before ending this work unit.'),
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
          for (const peer of ctx.agents.list()) {
            const other = ctx.agentTeams.tryMembership(peer)
            if (other !== undefined) live.set(other.name, peer)
          }
        } catch {
          /* No live roster: report milestones without context shares. */
        }
        const meter = serviceOf(ctx, 'tokenMeter')
        const windowSize = config.windowTokens
        const contextPct = (owner) => {
          const peer = live.get(owner)
          if (peer === undefined || meter === undefined) return undefined
          const measured = meter.measure(peer.session)
          const total = measured === null || measured === undefined ? undefined : measured.totalTokens
          if (typeof total !== 'number' || typeof windowSize !== 'number' || windowSize <= 0) return undefined
          return Math.round((total / windowSize) * 100)
        }
        const rows = []
        for (const [owner, entry] of Object.entries(state.members)) {
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
            done: entry.done === true,
            ...pending === undefined ? {} : {
              pendingCompaction: {
                status: pending.status,
                reason: pending.reason ?? 'milestone',
                milestoneStage: pending.milestoneStage ?? entry.stage,
                requestedAt: pending.requestedAt ?? null,
              },
            },
            ...pct === undefined ? {} : { contextPct: pct },
          })
        }
        return { action: 'list', done: false, armed: false, members: rows }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_worktree_setup',
      description: 'Lay out one member\u2019s git worktree on its integration branch, so two members can never overwrite each other\u2019s files. Tier 0 lays out its group leads, a group lead lays out its own members, and the verifier lays out its own DETACHED (read-only) checkout. Idempotent.',
      parameters: {
        target: { type: 'string', required: true, description: 'Member whose worktree is created.' },
        task_id: { type: 'string', required: true, description: 'Task whose plan has been approved.' },
        repo: { type: 'string', description: 'Repository directory the worktrees live under. Defaults to the caller session repository cwd.' },
        base: { type: 'string', description: 'Base branch or commit. Defaults to main for a group lead and to the group branch for a member.' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: {
        target: { type: 'string', required: true },
        branch: { type: 'string', required: true },
        path: { type: 'string', required: true },
        readOnly: { type: 'boolean', required: true },
        created: { type: 'boolean', required: true },
        reason: { type: 'string' },
      } }),
      async execute(args, exec) {
        callingAgent(exec.agent, 'team_worktree_setup')
        const caller = callerName()
        const approvedPlan = policy().control.planRequireApproved(TeamTaskId(args.task_id))
        if (!approvedPlan.members.includes(args.target) && approvedPlan.proposedBy !== caller && record(caller)?.tier !== 0) {
          refuse('plan-target', 'approved plan "' + args.task_id + '" does not include target "' + args.target + '"')
        }
        const members = new Map(policy().all().map((member) => [member.name, member]))
        const plan = setupPlan({ members }, caller, args.target, (registry, name) => registry.members.get(name))
        if (!plan.ok) refuse(plan.code, 'worktree setup refused for "' + caller + '" -> "' + args.target + '": ' + plan.code)
        const repo = repositoryRoot(exec.agent, args.repo, approvedPlan)
        const path = absoluteWorktreePath(repo, config.worktreeRoot ?? '.dsh-worktrees', plan.branch)
        const base = args.base ?? plan.base
        const outcome = worktreeAdd(repo, path, plan.branch, base, undefined, plan.readOnly === true)
        if (outcome.ok !== true) refuse(outcome.code, 'worktree for "' + args.target + '" could not be created: ' + String(outcome.detail ?? outcome.code))
        await advanceTaskPhase(args.task_id, 'execution', callingAgent(exec.agent, 'team_worktree_setup'))
        return { target: args.target, branch: plan.branch, path: outcome.path, readOnly: plan.readOnly === true, created: outcome.created === true }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_merge',
      description: 'Merge one branch back, as a tool with an approval. A group lead merges its own member into the group branch; tier 0 merges a group branch into main and must have a verifier clearance on that exact commit. A conflict is never auto-resolved: the unmerged paths are reported and the decision escalates to the branch owner.',
      parameters: {
        target: { type: 'string', required: true, description: 'Member whose branch is merged: a member for a group lead, a group lead for tier 0.' },
        task_id: { type: 'string', required: true, description: 'Task whose approved plan and evidence authorize this merge.' },
        repo: { type: 'string', description: 'Repository directory the worktrees live in. Defaults to the caller session repository cwd.' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: {
        target: { type: 'string', required: true },
        source: { type: 'string', required: true },
        destination: { type: 'string', required: true },
        merged: { type: 'boolean', required: true },
        commit: { type: 'string' },
        conflict: { type: 'boolean' },
        files: { type: 'array', items: { type: 'string' } },
        escalatedTo: { type: 'string' },
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
        const source = sourceSnapshot(repo, sourcePath, plan.source, (cwd, argv) => runGit(cwd, argv))
        if (!source.ok) refuse(source.code, 'source branch is not ready: ' + String(source.detail ?? source.code))
        const commit = source.sha

        // main only accepts a branch the verifier has cleared at THIS commit.
        if (plan.needsClearance === true) {
          const gate = clearanceDigestGate(readClearance(config, commit), { commit })
          if (!gate.ok) {
            refuse(gate.code, 'main refuses "' + plan.source + '": ' + gate.code + ' (commit ' + commit.slice(0, 12) + ')')
          }
        }

        const outcome = await withMergeLock(repo, () => mergeExact(repo, destinationPath, sourcePath, plan.source, commit, (cwd, argv) => runGit(cwd, argv)))
        if (outcome.ok === true) {
          await advanceTaskPhase(args.task_id, 'integrated', callingAgent(exec.agent, 'team_merge'))
          return { target: args.target, source: plan.source, destination: plan.dest, merged: true, commit: outcome.commit }
        }
        if (outcome.code === 'merge-conflict') {
          return {
            target: args.target,
            source: plan.source,
            destination: plan.dest,
            merged: false,
            conflict: true,
            files: outcome.files,
            escalatedTo: plan.owner,
            reason: 'unmerged paths must be decided by ' + plan.owner + ', not resolved automatically',
          }
        }
        refuse(outcome.code, 'merge of "' + plan.source + '" into "' + plan.dest + '" failed: ' + String(outcome.detail ?? outcome.code))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'verifier_report',
      description: 'Publish one aggregated issue table. The independent verifier group only. Every issue must cite evidence that distinguishes the broken state; "nothing to report" is not a review. The table is written under the configured report directory and every group lead is notified with the path.',
      parameters: {
        name: { type: 'string', required: true, description: 'Short report name, sanitized to [a-z0-9-_]. Becomes <name>.md in the report directory.' },
        summary: { type: 'string', required: true, description: 'One-paragraph verdict.' },
        commit: { type: 'string', description: 'Commit hash this verdict was produced against. Required to clear a branch for merge into main.' },
        issues: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              severity: { type: 'string', required: true, enum: ['blocker', 'major', 'minor', 'nit'] },
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
          if (typeof issue.severity !== 'string' || !['blocker', 'major', 'minor', 'nit'].includes(issue.severity)) {
            refuse('bad-severity', 'issue #' + (index + 1) + ' has severity "' + String(issue.severity) + '"; expected blocker|major|minor|nit')
          }
        })

        const safe = String(args.name).toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
        if (safe.length === 0) refuse('bad-name', 'report name must contain at least one [a-z0-9] character')
        const order = { blocker: 0, major: 1, minor: 2, nit: 3 }
        const sorted = [...issues].sort((a, b) => order[a.severity] - order[b.severity])
        const bySeverity = {}
        for (const issue of sorted) bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1

        const header = [
          '# Verifier report: ' + safe,
          '',
          'Verdict: ' + String(args.summary),
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
        if (typeof args.commit === 'string' && args.commit.trim().length > 0 && typeof config.clearanceFile === 'string' && config.clearanceFile.length > 0) {
          try {
            let doc = {}
            try { doc = JSON.parse(readFileSync(config.clearanceFile, 'utf8')) } catch { doc = {} }
            if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) doc = {}
            const reportDigest = hashControlValue({ summary: args.summary, issues: sorted })
            const evidenceHash = hashControlValue(sorted.map((issue) => issue.evidence))
            doc[args.commit.trim()] = {
              commit: args.commit.trim(),
              severity: sorted[0] === undefined ? 'nit' : sorted[0].severity,
              report: safe,
              reportDigest,
              evidenceHash,
              filesHash: hashControlValue(sorted.map((issue) => issue.location ?? '')),
              checksHash: hashControlValue(sorted.map((issue) => issue.evidence)),
              by: me,
              at: new Date().toISOString(),
            }
            mkdirSync(dirname(config.clearanceFile), { recursive: true })
            writeFileSync(config.clearanceFile, JSON.stringify(doc, null, 1), 'utf8')
          } catch (error) {
            refuse('clearance-io', 'could not record the clearance: ' + String(error && error.message))
          }
        }
        await control().evidencePut({
          taskId: args.task_id,
          commitSha: args.commit,
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
            references: [file, ...(args.commit ? [args.commit] : [])],
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
        return { path: file, issues: issues.length, bySeverity, notified }
      },
    })))

    /** Resolve the board one call targets: 'global' is the durable domain board. */
    const resolveBoard = (actorName, kind) => {
      const requested = kind ?? 'global'
      if (requested === 'global') return 'global'
      return policy().boardOf(actorName, requested)
    }

    /** Write guard shared by the task tools; the reason names the real cause. */
    const requireBoardWrite = (actorName, boardId) => {
      if (boardId === undefined) {
        refuse('board-scope', 'member "' + actorName + '" owns no board of that kind')
      }
      if (policy().canWriteBoard(actorName, boardId)) return
      if (boardId === 'global') {
        refuse('global-board-write', 'only tier 0 may write the global board; "' + actorName + '" has read access only')
      }
      const level = policy().boardTier(boardId)
      refuse('board-write', '"' + actorName + '" may not write board "' + boardId + '"'
        + (level === undefined ? '' : ' (that board belongs to tier ' + level + ')'))
    }

    register(scoped.tools.register(defineTool({
      name: 'team_task_create',
      description: 'Create one unowned pending task with an explicit deliverable kind. discussion/review tasks use no write scopes and close with evidence; edit tasks require write scopes and the plan/commit gate.',
      parameters: {
        subject: { type: 'string', required: true, description: 'Concise task title.' },
        description: { type: 'string', required: true, description: 'Complete task details and acceptance criteria.' },
        kind: { type: 'string', required: true, enum: ['discussion', 'review', 'edit'], description: 'discussion/review produce evidence without writes; edit produces tracked file changes.' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Task ids that must complete first.' },
        write_scopes: { type: 'array', items: { type: 'string' }, description: 'Advisory workspace-relative file or directory prefixes this task expects to modify.' },
        board: { type: 'string', enum: ['global', 'level', 'group'], description: 'Target board: the shared global board, your level board, or your group board. Defaults to global.' },
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
          refuse('task-kind-scope', args.kind + ' task "' + args.subject + '" must not declare write_scopes; use kind:"edit" for file changes')
        }
        const request = {
          subject: args.subject,
          description: args.description,
          ...args.blocked_by === void 0 ? {} : { blockedBy: args.blocked_by.map(TeamTaskId) },
          ...args.write_scopes === void 0 ? {} : { writeScopes },
        }
        const boardId = resolveBoard(me, target)
        requireBoardWrite(me, boardId)
        if (boardId === 'global') {
          const task = await ctx.agentTeams.createTask(caller, request)
          await control().boardCreate({
            boardId,
            taskId: task.id,
            ...request,
            phase: 'room-discussion',
            subject: task.subject,
            description: task.description,
            writeScopes: task.writeScopes,
            workKind: args.kind,
          }, caller)
          return projectTask(task)
        }
        const task = await policy().boardCreateAsync(boardId, { ...request, phase: 'room-discussion', workKind: args.kind }, caller)
        return projectTask(task)
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_list',
      description: 'List tasks on one board, including readiness, owner, revision, blockers, and write-scope warnings.',
      parameters: {
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Optional exact status filter.' },
        owner: { type: 'string', description: 'Optional member-name filter; use unowned for tasks without an owner.' },
        ready: { type: 'boolean', description: 'Optional readiness filter.' },
        cursor: { type: 'integer', description: 'Zero-based result offset. Defaults to 0.' },
        limit: { type: 'integer', description: 'Number of rows, 1 through 100. Defaults to 50.' },
        board: { type: 'string', enum: ['global', 'level', 'group'], description: 'Board to read. Defaults to global.' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: { tasks: { type: 'array', required: true, items: TASK_VIEW_SCHEMA }, nextCursor: { type: 'integer' } } }),
      execute(args, exec) {
        const caller = callingAgent(exec.agent, 'team_task_list')
        const me = callerName()
        const boardId = resolveBoard(me, args.board)
        if (!policy().canReadBoard(me, boardId)) refuse('board-read', 'member "' + me + '" may not read board "' + boardId + '"')
        const raw = boardId === 'global'
          ? ctx.agentTeams.listTasks(caller)
          : (policy().refreshBoards(), policy().boardList(boardId))
        // Filter after projecting the local status/phase/revision, otherwise a
        // task completed in the control plane is still filtered by the domain's
        // stale pending status.
        const all = raw.map(projectTask)
        const status = args.status
        const filtered = all.filter((task) => (status === void 0 || task.status === status)
          && (args.owner === void 0 || (args.owner === 'unowned' ? task.ownerName === void 0 : task.ownerName === args.owner))
          && (args.ready === void 0 || task.ready === args.ready))
        const cursor = args.cursor ?? 0
        const limit = args.limit ?? 50
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('cursor must be a non-negative safe integer')
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 through 100')
        return Promise.resolve({
          tasks: filtered.slice(cursor, cursor + limit),
          ...cursor + limit < filtered.length ? { nextCursor: cursor + limit } : {},
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_delivery_check',
      description: 'Check the board before declaring anything delivered. Lists every task that is not completed and, for each, whether its owner has already TICKED its milestone — which tells you whether the owner simply forgot to mark the task done, or the work genuinely is not finished. Tier 0 only.',
      parameters: {},
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: {
        deliverable: { type: 'boolean', required: true },
        openCount: { type: 'integer', required: true },
        open: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          id: { type: 'string', required: true },
          subject: { type: 'string', required: true },
          status: { type: 'string', required: true },
          workKind: { type: 'string', enum: ['discussion', 'review', 'edit'] },
          owner: { type: 'string' },
          ownerMilestone: { type: 'string' },
          verdict: { type: 'string', required: true, enum: ['owner-forgot-to-mark-it', 'work-genuinely-unfinished', 'no-owner'] },
        } } },
        blockers: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        counters: { type: 'object', required: true, additionalProperties: true },
      } }),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'team_delivery_check')
        const me = record(callerName())
        if (me === undefined || me.tier !== 0) refuse('tier-0-only', 'only tier 0 may decide that the work is delivered')
        const tasks = await ctx.agentTeams.listTasks(caller)
        const durable = control().snapshot()
        // Every durable board task is part of the delivery picture, not only planned
        // ones: filtering by plan here is what let an unplanned completed task skip the
        // gate entirely and still produce deliverable=true.
        const durableTasks = Object.values(durable.boards ?? {}).flatMap((board) => Object.values(board.tasks ?? {}))
        const allTasks = tasks.map((task) => {
          const durableRow = durableTasks.find((row) => String(row.id) === String(task.id))
          return durableRow === undefined ? task : { ...durableRow, ...task,
            status: durableRow.status ?? task.status,
            phase: durableRow.phase ?? task.phase,
            revision: durableRow.revision ?? task.revision,
            ...(durableRow.ownerName !== undefined ? { ownerName: durableRow.ownerName } : {}),
            ...(durableRow.commitSha !== undefined ? { commitSha: durableRow.commitSha } : {}),
            ...(durableRow.evidenceIds !== undefined ? { evidenceIds: durableRow.evidenceIds } : {}),
          }
        })
        allTasks.push(...durableTasks.filter((row) => !tasks.some((task) => String(task.id) === String(row.id))))
        const plannedTaskIds = new Set(Object.keys(durable.plans ?? {}))
        const evidenceRows = Object.values(durable.evidence ?? {})
        const packets = Object.values(durable.packets ?? {})
        const state = milestoneState(milestones(config.milestonePath))
        const open = []
        const blockers = []
        for (const task of allTasks) {
          const taskId = String(task.id)
          if (task.status === 'completed') {
            const planned = plannedTaskIds.has(taskId)
            const scoped = Array.isArray(task.writeScopes) && task.writeScopes.length > 0
            const taskEvidence = evidenceRows.filter((row) => String(row.taskId ?? '') === taskId)
            const commitSha = typeof task.commitSha === 'string' && task.commitSha.length > 0 ? task.commitSha : null
            const evidenceIds = Array.isArray(task.evidenceIds) ? task.evidenceIds.map(String) : []
            const matchingEvidence = taskEvidence.filter((row) => commitSha === null || row.commitSha === commitSha)
            const groupPackets = packets.filter((row) => row.kind === 'group-acceptance' && row.taskIds.includes(taskId)
              && (commitSha === null || row.commitSha === commitSha))
            const verifierPackets = packets.filter((row) => row.kind === 'verifier-review' && row.taskIds.includes(taskId)
              && (commitSha === null || row.commitSha === commitSha))
            const finalPackets = packets.filter((row) => row.kind === 'final-acceptance' && row.taskIds.includes(taskId)
              && (commitSha === null || row.commitSha === commitSha))
            const reference = taskEvidence.find((row) => row.kind === 'delivery-reference'
              && typeof row.requirementId === 'string'
              && commitSha !== null
              && row.commitSha === commitSha)
            const referenced = reference === undefined ? undefined : durableTasks.find((row) => String(row.id) === String(reference.requirementId))
            const validReference = reference !== undefined
              && referenced !== undefined
              && referenced.status === 'completed'
              && typeof referenced.commitSha === 'string'
              && referenced.commitSha === commitSha
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
              if (!present) blockers.push({ kind: 'task-gate', taskId, requirement, status: 'missing' })
            }
            for (const packet of [...verifierPackets, ...finalPackets]) {
              if (Array.isArray(packet.blockers) && packet.blockers.length > 0) {
                blockers.push({ kind: 'packet-blocker', taskId, packetId: packet.packetId, packetKind: packet.kind, blockers: packet.blockers })
              }
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
          // The milestone tick is the owner's own statement that its work unit landed.
          // A ticked milestone with an open task is a bookkeeping miss, not missing work;
          // an unticked one means the work itself is still in flight. Either way the
          // answer is not 'ignore it' — it is which of the two to chase.
          open.push({
            id: String(task.id),
            subject: String(task.subject),
            status: String(task.status),
            ...task.workKind === undefined ? {} : { workKind: String(task.workKind) },
            owner,
            ...milestone === undefined ? {} : { ownerMilestone: String(milestone.stage) },
            verdict: milestone !== undefined && milestone.done === true ? 'owner-forgot-to-mark-it' : 'work-genuinely-unfinished',
          })
        }
        for (const row of Object.values(durable.dispatches ?? {})) {
          if (row.taskId !== null && row.taskId !== undefined
            && ['queued', 'delivered', 'turn-started', 'first-observation', 'checkpointed', 'response-recorded',
              'delivery-failed', 'run-failed', 'timed-out', 'expired'].includes(row.status)) {
            blockers.push({ kind: 'dispatch', id: row.dispatchId, status: row.status, target: row.target })
          }
        }
        for (const row of Object.values(durable.escalations ?? {})) {
          if (!['resolved', 'cancelled'].includes(row.status)) blockers.push({ kind: 'escalation', id: row.escalationId, status: row.status })
        }
        for (const row of Object.values(durable.evidence ?? {})) {
          if (['blocker', 'major'].includes(row.classification) || row.status === 'blocker') blockers.push({ kind: 'finding', id: row.evidenceId, status: row.classification ?? row.status })
        }
        const deliverable = open.length === 0 && blockers.length === 0
        return { deliverable, openCount: open.length, open, blockers, counters: durable.counters }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_get',
      description: 'Read the complete latest value of one task before changing or executing it.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Task id.' },
        board: { type: 'string', enum: ['global', 'level', 'group'], description: 'Board to read. Defaults to global.' },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'team_task_get')
        const me = callerName()
        const boardId = resolveBoard(me, args.board)
        if (!policy().canReadBoard(me, boardId)) refuse('board-read', 'member "' + me + '" may not read board "' + boardId + '"')
        if (boardId === 'global') return Promise.resolve(projectTask(await ctx.agentTeams.getTask(caller, TeamTaskId(args.task_id))))
        const found = policy().boardGet(boardId, args.task_id)
        if (found === undefined) throw new Error('unknown task "' + args.task_id + '" on board "' + boardId + '"')
        return Promise.resolve(projectTask({ ...found }))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_reconcile',
      description: 'Tier-0-only bookkeeping repair for a stranded REFERENCE task. It may complete only by linking to an already completed same-Team task that carries the exact commit and evidence; it never fabricates evidence or bypasses an execution gate.',
      parameters: {
        task_id: { type: 'string', required: true },
        source_task_id: { type: 'string', required: true, description: 'Completed group-board task whose delivery this reference task represents.' },
        reason: { type: 'string', required: true },
        board: { type: 'string', enum: ['global', 'level', 'group'], description: 'Target board. Defaults to global.' },
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
        const commitSha = typeof source.task.commitSha === 'string' && source.task.commitSha.trim().length > 0
          ? source.task.commitSha
          : undefined
        const evidenceIds = Array.isArray(source.task.evidenceIds) ? source.task.evidenceIds.map(String) : []
        if (commitSha === undefined || evidenceIds.length === 0) {
          refuse('reconcile-source', 'source task "' + args.source_task_id + '" has no exact commit_sha and evidence_ids')
        }
        const evidence = control().snapshot().evidence ?? {}
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
          kind: 'delivery-reference',
          command: 'team_task_reconcile({task_id:"' + args.task_id + '",source_task_id:"' + args.source_task_id + '"})',
          expected: 'global reference points at a completed execution task with the same delivery',
          actual: 'source_task_id=' + String(args.source_task_id) + '; reason=' + String(args.reason),
          paths: [],
          classification: 'reference',
          status: 'pass',
        }, caller)
        await control().boardUpdate({
          boardId,
          taskId: args.task_id,
          expectedRevision: found.task.revision,
          action: 'complete',
          commitSha,
          evidenceIds: [...new Set([link.evidenceId, ...evidenceIds])],
          actorName: me,
        }, caller)
        const durable = durableTask(args.task_id)
        return projectTask(durable === undefined ? found.task : durable.task)
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_update',
      description: 'Compare-and-set one task action using the latest revision. The global board accepts mutations from tier 0 only.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Task id.' },
        expected_revision: { type: 'integer', required: true, description: 'Current task revision used as the CAS precondition.' },
        action: { type: 'string', required: true, enum: ['claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete', 'advance_phase'], description: 'Task transition to apply.' },
        phase: { type: 'string', enum: TASK_PHASES, description: 'Next durable task phase for advance_phase.' },
        subject: { type: 'string', description: 'Replacement title for edit.' },
        description: { type: 'string', description: 'Replacement details for edit.' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Complete blocker list for set_dependencies.' },
        write_scopes: { type: 'array', items: { type: 'string' }, description: 'Replacement write scopes for edit.' },
        commit_sha: { type: 'string', description: 'Exact commit SHA produced by the task owner when completing it.' },
        evidence_ids: { type: 'array', items: { type: 'string' }, description: 'Durable evidence ids proving the completed task.' },
        owner: { type: 'string', description: 'Member name for Lead-only reassign; omit to unassign.' },
        board: { type: 'string', enum: ['global', 'level', 'group'], description: 'Target board. Defaults to global.' },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'team_task_update')
        assertTeamRunnable()
        const me = callerName()
        const boardId = resolveBoard(me, args.board)
        const request = {
          taskId: TeamTaskId(args.task_id),
          expectedRevision: args.expected_revision,
          action: args.action,
          ...args.subject === void 0 ? {} : { subject: args.subject },
          ...args.description === void 0 ? {} : { description: args.description },
          ...args.blocked_by === void 0 ? {} : { blockedBy: args.blocked_by.map(TeamTaskId) },
          ...args.write_scopes === void 0 ? {} : { writeScopes: args.write_scopes },
          ...args.commit_sha === void 0 ? {} : { commitSha: args.commit_sha },
          ...args.evidence_ids === void 0 ? {} : { evidenceIds: args.evidence_ids },
          ...args.owner === void 0 ? {} : { owner: args.owner },
          ...args.phase === void 0 ? {} : { phase: args.phase },
        }
        requireBoardWrite(me, boardId)
        // §7.2.1: the global board is append-only. Editing or deleting a task there
        // rewrites a prefix every member has already cached.
        if (boardId === 'global' && (args.action === 'edit' || args.action === 'delete' || args.action === 'reassign')) {
          refuse('global-append-only', 'the global board is append-only: only creating a task and advancing its status are allowed; name the owner in the task and let them claim it')
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
            if (workKind === 'edit') {
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
          const plan = control().planState(TeamTaskId(args.task_id))
          const scopes = Array.isArray(found?.task?.writeScopes) ? found.task.writeScopes : []
          const workKind = found?.task?.workKind ?? (scopes.length > 0 ? 'edit' : 'discussion')
          if (workKind === 'edit' && plan !== undefined) {
            if (plan.state !== 'plan-approved') {
              refuse('complete-plan', 'planned task "' + args.task_id + '" requires an approved plan before completion')
            }
            if (found?.task?.phase !== 'execution') {
              refuse('complete-phase', 'planned task "' + args.task_id + '" must be in execution before completion')
            }
            if (activeLeaseFor(args.task_id, me) === undefined) {
              refuse('complete-lease', 'planned task "' + args.task_id + '" requires the owner active run lease before completion')
            }
            if (typeof args.commit_sha !== 'string' || args.commit_sha.trim().length === 0) {
              refuse('complete-commit', 'completion requires the exact commit_sha produced by the task')
            }
          } else if (workKind === 'edit') {
            refuse('complete-plan', 'task "' + args.task_id + '" declares write scopes but has no plan: call team_plan_propose, team_plan_approve, advance the task to execution, then complete it with the owner commit_sha')
          } else if (plan !== undefined) {
            refuse('complete-plan', workKind + ' task "' + args.task_id + '" must not have an edit plan')
          }
          if (!Array.isArray(args.evidence_ids) || args.evidence_ids.length === 0) {
            refuse('complete-evidence', 'completion requires at least one evidence_id recorded for task "' + args.task_id + '"')
          }
          const evidence = control().snapshot().evidence ?? {}
          const unknown = args.evidence_ids.map(String).filter((evidenceId) => {
            const row = evidence[evidenceId]
            return row === undefined || String(row.taskId ?? '') !== String(args.task_id)
          })
          if (unknown.length > 0) {
            refuse('complete-evidence', 'evidence_ids must reference records already stored for task "' + args.task_id + '"; unknown or foreign: ' + unknown.join(', '))
          }
        }
        if (boardId === 'global') {
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
          const updated = args.action === 'advance_phase'
            ? projectTask(await ctx.agentTeams.getTask(caller, TeamTaskId(args.task_id)))
            : await ctx.agentTeams.updateTask(caller, await domainRequestWithCurrentRevision(caller, request))
          await control().boardUpdate({ boardId, ...request, actorName: me }, caller)
          if (args.action === 'complete' && control().planState(TeamTaskId(args.task_id))) {
            const found = durableTask(args.task_id)
            if (found && found.task.phase !== 'member-check') {
              if (found.task.phase !== 'execution') {
                refuse('task-phase', 'planned task "' + args.task_id + '" must hold an execution lease before member-check')
              }
              await advanceTaskPhase(args.task_id, 'member-check', caller)
            }
          }
          if (args.action === 'reopen') {
            const found = durableTask(args.task_id)
            if (found && found.task.phase !== 'room-discussion') {
              try { await advanceTaskPhase(args.task_id, 'execution', caller) } catch {}
            }
          }
          const durable = durableTask(args.task_id)
          return durable === undefined ? updated : projectTask(updated)
        }
        if (args.action === 'reassign' && (record(me) || {}).tier !== 0) refuse('reassign-scope', 'only tier 0 may reassign a task')
        const updated = await policy().boardUpdateAsync(boardId, request, me, caller)
        if (args.action === 'complete' && control().planState(TeamTaskId(args.task_id))) {
          const found = durableTask(args.task_id)
          if (found && found.task.phase !== 'member-check') {
            if (found.task.phase !== 'execution') {
              refuse('task-phase', 'planned task "' + args.task_id + '" must hold an execution lease before member-check')
            }
            await advanceTaskPhase(args.task_id, 'member-check', caller)
          }
        }
        if (args.action === 'reopen') {
          const found = durableTask(args.task_id)
          if (found && found.task.phase !== 'room-discussion') {
            try { await advanceTaskPhase(args.task_id, 'execution', caller) } catch {}
          }
        }
        const durable = durableTask(args.task_id)
        return durable === undefined ? updated : projectTask(updated)
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
    maxRoomRounds: typeof config.maxRoomRounds === 'number' && config.maxRoomRounds > 0
      ? Math.floor(config.maxRoomRounds)
      : 3,
    reconcileIntervalMs: typeof config.reconcileIntervalMs === 'number' && config.reconcileIntervalMs > 0
      ? config.reconcileIntervalMs
      : 30000,
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
  const maybeInstall = (agent) => {
    if (installed.has(agent) || ctx.agentTeams.tryMembership(agent) === undefined) return
    installed.set(agent, install(agent, ctx, resolved))
    const membership = ctx.agentTeams.tryMembership(agent)
    const pending = resolved.pendingRoutes.get(membership.name)
    if (pending !== undefined) installRouteOn(agent, membership.name, pending)
  }
  ROUTE_APPLIER = resolved.applyRoute
  ctx.effect(() => () => {
    if (ROUTE_APPLIER === resolved.applyRoute) ROUTE_APPLIER = undefined
  }, 'tool-team-v2.routeApplier')
  for (const agent of ctx.agents.list()) maybeInstall(agent)
  ctx.on('agent/created', ({ agent }) => {
    maybeInstall(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
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
}
