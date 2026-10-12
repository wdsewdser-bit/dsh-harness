/**
 * step-compaction — Agent Team v3 context folding at a declared milestone.
 *
 * Supersedes the v2 version, which keyed the boundary off todo_write. That failed twice
 * over: a session's todo list does not outlive the session, and in a real project the
 * main session never called todo_write even once, so nothing ever fired.
 *
 * v3 turns the two hard constraints into one mechanism:
 *  - compactNow() requires an IDLE agent, and ticking a milestone happens inside a turn,
 *    so a tick can only ARM the fold.
 *  - agent/status -> idle is the only moment the engine will actually accept it.
 *
 * A tick therefore means 'this work unit landed and the reasoning behind it is spent',
 * and the idle transition is what fires the milestone fold. Context pressure is also a
 * real idle trigger: at autoCompactRatio an idle agent folds even without a milestone,
 * while the pre-step guard remains fail-closed. Status and recovery notices expose the
 * trigger and measured ratio so pressure folds are never mistaken for milestone folds.
 *
 * Two facts about THIS profile shape the plumbing, both measured on a live instance:
 *  1. The services this plugin consumes live in another isolate, so ctx.get() finds
 *     nothing (all three came back undefined at activation). They are reached through
 *     ctx.inject's CALLBACK form instead: it binds them without leaving this plugin
 *     pending when one is absent, and it never blocks the boot.
 *  2. The web app plane disables the host-level compaction-basic; the engine is mounted
 *     inside each agent's preset realm behind 'isolate: { compaction: true }'. No
 *     host-plane context can resolve it — not even agent.ctx. The one entry point that
 *     crosses that boundary is the /compact command, whose handler runs inside the realm.
 */
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { consumeMilestoneCompaction, markCompacted, milestoneScope, pendingMilestoneCompaction, pruneStaleMilestoneCompactions, shouldCompact } from './team-milestone-v2.mjs'
import { COMPACTION_RECOVERY_FIRST_ACTION, normalizeCompactionState, recordCompactionDecision } from './team-v12-compaction.mjs'
import { evaluateShadow } from './team-v13-compaction-shadow.mjs'
import { validateCompactionAnchors } from './team-v13-compaction-anchors.mjs'
import { buildMemberRecoveryPack, captureMemberMemory } from './team-v14-memory-anchor.mjs'
import { controlPlaneForMember } from './team-control-plane.mjs'
import { measureSessionTokens } from './team-token-meter-cache.mjs'
import { observeRequestBudget } from './request-usage-ledger.mjs'

export const name = 'step-compaction'

const modulePath = fileURLToPath(import.meta.url)
const moduleHash = createHash('sha256').update(readFileSync(modulePath)).digest('hex')
const modulePathParts = modulePath.split(sep)
const profileIndex = modulePathParts.lastIndexOf('profiles')
const moduleProfile = profileIndex >= 0 ? modulePathParts[profileIndex + 1] : 'unknown'

const mirroredDecisions = new Set()

/**
 * Sessions whose fold this plugin is running right now, counted rather than flagged: two
 * folds for one session can overlap, and the one that ends first must not release the mark
 * the other still holds. Its own fold already validates the anchors, writes the ledger row
 * and sends the recovery notice, so the engine observer must recognise those end events and
 * leave them alone instead of doing it all a second time.
 */
const selfCompactions = new Map()

/** End events already post-processed, keyed by session and compaction id. */
const observedEngineCompactions = new Set()

/** One key per session, so a fold mark can be taken and released around one engine call. */
function selfCompactionKey(agent) {
  return String(agent?.session?.id ?? '')
}

/** Take the fold mark for one session; the mark clears only once every fold released it. */
function takeSelfCompaction(agent) {
  const key = selfCompactionKey(agent)
  selfCompactions.set(key, Number(selfCompactions.get(key) ?? 0) + 1)
}

/** Release one fold mark, dropping the session only when nothing else still holds it. */
function releaseSelfCompaction(agent) {
  const key = selfCompactionKey(agent)
  const remaining = Number(selfCompactions.get(key) ?? 0) - 1
  if (remaining > 0) selfCompactions.set(key, remaining)
  else selfCompactions.delete(key)
}

/** Whether this plugin is folding that session itself right now. */
function foldingHere(sessionId) {
  return Number(selfCompactions.get(String(sessionId)) ?? 0) > 0
}

/**
 * Session key -> the seq of its most recent step/start, and the boundary an engine notice was
 * already queued for. The engine retries a compaction inside one step, each attempt closing
 * its own compactionId, and each of those folds ends on the same transcript: one notice per
 * step boundary is what keeps the resume prompt from repeating itself.
 */
const stepBoundaries = new Map()
const engineNoticeBoundaries = new Map()

/** Record one step/start as the current coalescing boundary for its session. */
function noteStepBoundary(session) {
  const key = String(session?.id ?? '')
  if (key.length === 0) return
  boundedMapSet(stepBoundaries, key, Number(session?.seq ?? 0))
}

/** The boundary the next engine notice for this session belongs to. */
function stepBoundaryOf(sessionId) {
  return stepBoundaries.get(String(sessionId)) ?? -1
}

/** Keep one diagnostic/coalescing map from growing without bound. */
function boundedMapSet(map, key, value) {
  map.delete(key)
  map.set(key, value)
  if (map.size > 2048) map.delete(map.keys().next().value)
}

function stableConfigValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('cyclic config')
    seen.add(value)
    const result = value.map(item => stableConfigValue(item, seen))
    seen.delete(value)
    return result
  }
  if (typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    if (seen.has(value)) throw new TypeError('cyclic config')
    seen.add(value)
    const result = Object.create(null)
    for (const key of Object.keys(value).sort()) result[key] = stableConfigValue(value[key], seen)
    seen.delete(value)
    return result
  }
  throw new TypeError('unsupported config value')
}

function configHashOf(config) {
  try {
    return createHash('sha256').update(JSON.stringify(stableConfigValue(config))).digest('hex')
  } catch {
    return null
  }
}

function milestonePathFacts(configuredPath) {
  if (typeof configuredPath !== 'string' || configuredPath.length === 0) {
    return { configuredPath: null, physicalPath: null, physicalPathStatus: 'unknown:invalid-config' }
  }
  try {
    const physicalPath = realpathSync(resolve(configuredPath))
    if (!statSync(physicalPath).isFile()) {
      return { configuredPath, physicalPath: null, physicalPathStatus: 'unknown:not-file' }
    }
    return { configuredPath, physicalPath, physicalPathStatus: 'resolved' }
  } catch (error) {
    const reason = error?.code === 'ENOENT' ? 'not-found' : error?.code === 'EACCES' ? 'access-denied' : 'resolve-failed'
    return { configuredPath, physicalPath: null, physicalPathStatus: 'unknown:' + reason }
  }
}

function compactionTriggerText(reason, ratio, tokens, windowTokens) {
  const trigger = String(reason ?? 'unknown')
  const ratioText = typeof ratio === 'number' && Number.isFinite(ratio)
    ? ' ratio=' + ratio.toFixed(3) + ' (' + Math.round(ratio * 100) + '%)'
    : ''
  const tokenText = typeof tokens === 'number' && Number.isFinite(tokens)
    ? ' tokens=' + String(Math.round(tokens))
      + (typeof windowTokens === 'number' && Number.isFinite(windowTokens) && windowTokens > 0
        ? '/' + String(Math.round(windowTokens))
        : '')
    : ''
  return 'trigger=' + trigger + ratioText + tokenText
}

/**
 * Recovery is product-task scoped. Platform v12/v13/v14 plans are implementation
 * notes for DSH itself and must not be injected into business member sessions.
 */
function injectCompactionRecoveryNotice(agent, reason, memoryPack, details = {}) {
  if (agent === undefined || typeof agent.inject !== 'function') return false
  try {
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: '[team v12 compaction recovery] Compaction completed (' + String(reason)
        + '; ' + compactionTriggerText(details.trigger ?? reason, details.ratio, details.tokens, details.windowTokens)
        + '). Restore the current product task from its contract, owner, phase, Room decisions, blockers,'
        + ' cursors and the recovery pack below. Confirm completed work and the next action before issuing tools.'
        + ' ' + COMPACTION_RECOVERY_FIRST_ACTION
        + ' Platform v12/v13/v14 implementation plans and ledgers are not product-session state.'
        + (memoryPack?.text ? '\n' + memoryPack.text : '') }],
      source: { kind: 'team-message', plugin: name, form: 'notice', summary: 'v12 compaction recovery' },
    }))
    return true
  } catch {
    /* Recovery notice delivery is best effort; the durable ledger remains the source. */
    return false
  }
}

function compactionAnchors(teamScope, name, pending, memory) {
  const member = teamScope?.members?.[name] ?? {}
  const handoff = pending?.handoff ?? {}
  return {
    ...memory?.anchors,
    taskContract: memory?.anchors?.taskContract?.length > 0
      ? memory.anchors.taskContract : handoff.taskId ?? pending?.taskId ?? member.taskId ?? member.stage,
    ownerScope: memory?.anchors?.ownerScope ?? name,
    milestoneNext: member.stage || member.doneWhen,
    roomDecisions: memory?.anchors?.roomDecisions ?? handoff.decisions ?? [],
    cursor: memory?.anchors?.cursor ?? handoff.cursors ?? {},
    blockers: memory?.anchors?.blockers ?? handoff.unresolved ?? [],
  }
}

export function compactionSummaryText(folded, settled) {
  const values = []
  const seen = new WeakSet()
  const visit = (value) => {
    if (typeof value === 'string') { values.push(value); return }
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      for (const block of value) if (block?.type === 'text') visit(block.text)
      return
    }
    if (typeof value.text === 'string') visit(value.text)
    if (value.summary !== undefined) visit(value.summary)
    if (value.result !== undefined) visit(value.result)
  }
  visit(folded)
  visit(settled)
  return values.filter((value) => typeof value === 'string' && value.length > 0).join('\n')
}

export function compactionResultStatus(value) {
  const result = value && typeof value === 'object' && value.result !== undefined ? value.result : value
  if (result === null) return { status: 'no-compactable-range', summaryAvailable: false, unknownBlocks: [] }
  if (result?.kind === 'error' || result?.isError === true) return { status: 'failed', summaryAvailable: false, unknownBlocks: [] }
  const blocks = Array.isArray(result?.summary) ? result.summary : []
  const unknownBlocks = blocks.filter((block) => block?.type !== 'text').map((block) => String(block?.type ?? 'unknown'))
  const summaryAvailable = compactionSummaryText(value, undefined).trim().length > 0
  return { status: unknownBlocks.length ? 'completed-with-debt' : summaryAvailable ? 'completed-with-summary' : 'summary-missing', summaryAvailable, unknownBlocks }
}

function anchorDebt(teamScope, name, pending, folded, settled, memory) {
  const validation = validateCompactionAnchors(
    compactionSummaryText(folded, settled),
    compactionAnchors(teamScope, name, pending, memory),
    { sourceStatus: memory?.sourceStatus ?? 'unavailable' },
  )
  const outcome = compactionResultStatus(folded === undefined ? settled : folded)
  if (outcome.unknownBlocks.length) {
    validation.ok = false
    validation.missing = [...validation.missing, ...outcome.unknownBlocks.map((type) => 'unsupported-summary-block:' + type)]
  }
  return validation
}

function authoritativeMemory(ctx, cfg, agent, name, teamScope, pending) {
  try {
    const control = controlPlaneForMember(ctx, agent, { directory: cfg.controlDir })
    if (control === undefined || typeof control.snapshot !== 'function' || !existsSync(control.file)) {
      return captureMemberMemory(undefined, name)
    }
    return captureMemberMemory(control.view({ history: false }), name, {
      taskId: pending?.taskId ?? teamScope?.members?.[name]?.taskId,
      milestoneNext: teamScope?.members?.[name]?.stage ?? teamScope?.members?.[name]?.doneWhen,
    })
  } catch {
    return captureMemberMemory(undefined, name)
  }
}

/**
 * Compaction is an observed side effect: it must never fail a tool call, and it must
 * never block plugin activation. Services are resolved lazily, so a profile without a
 * compaction engine simply gets no milestone folding instead of a plugin tree that
 * refuses to boot waiting for a service that is not installed.
 */
export const inject = []

export const DEFAULTS = {
  /** Must match the model's real contextWindow in settings.yaml. */
  windowTokens: 1000000,
  /** At this share an idle agent folds even without a milestone tick. */
  autoCompactRatio: 0.75,
  /**
   * A ticked milestone folds only when the context has reached this many tokens. A milestone is meant to close a
   * large phase; below this the tick is recorded and the fold skipped, because rewriting a small, still-cached
   * context costs more than it saves. 0 keeps the old behaviour (every tick folds). The pressure cap ignores it.
   */
  minMilestoneFoldTokens: 0,
  /** After a pressure fold, do not fold again until this much time passes. */
  pressureCooldownMs: 10 * 60 * 1000,
  // At or above this size the next idle boundary folds the context even with no finished phase: attention degrades
  // and every turn is expensive there. 0 turns the rule off.
  proactiveFoldTokens: 0,
  /** A pressure fold above this share is never delayed by the cooldown. */
  pressureHardRatio: 0.9,
  // What a conversation request reserves for its own output. This has to be the max output the route really sends
  // (128000 on the default route), not a guess: with 32768 here a 915k request passed the check and was rejected by
  // the provider, because 915k + 128k is past the window.
  reservedOutputTokens: 128000,
  /** Output allowance of the engine's summary request. */
  summaryMaxOutputTokens: 65536,
  /** How much larger than the measured context an idle summary request is (unpruned tool results). */
  idleSummaryInputFactor: 1.2,
  summarySafetyMarginTokens: 8192,
  // The meter is exact only up to the last provider-reported request; what one step added since is a character
  // estimate. The margin has to absorb that error for a large tool result, or the check passes a request the
  // provider then rejects.
  safetyMarginTokens: 32768,
  /** After a step was refused for budget: when to wake the member again (ms). After the last one it is left alone. */
  budgetRetryBackoffMs: [30000, 180000, 600000],
  /** A provider "parameters rejected" 400 this close to the window (share of it) is treated as a context overflow. */
  overflowReclassifyRatio: 0.9,
  enablePreStep: false,
  /**
   * off    -> preserve the pre-v13 behavior exactly.
   * shadow -> calculate and record an economic decision on idle boundaries.
   * on     -> allow a non-mandatory economic decision to fold an idle agent.
   *
   * Shadow is the safe rollout default. The mandatory milestone and pressure
   * paths below never consult this setting.
   */
  opportunisticCompaction: 'shadow',
  sessionsRoot: 'D:\\dsh-test\\home\\sessions',
  telemetryDir: 'D:\\dsh-test\\home\\team-control-plane',
  controlDir: 'D:\\dsh-test\\home\\team-control-plane',
  debtFile: 'D:\\dsh-test\\home\\team-control-plane\\v13-compaction-debt.json',
  writeTokens: 8000,
  memoTokens: 2000,
  cacheWriteReadRatio: null,
  minContextGrowthTokens: 50000,
  minRequestsSinceCompaction: 20,
  /**
   * Core compaction omits reasoningEffort, so the provider resolves its model
   * default. The upstream prefix cache is scoped by that setting: a main
   * session on max and a compaction call on the default high share no cache,
   * even when every message is byte-identical. Inherit the routed effort for
   * auxiliary compaction calls per session. Set to 'off' to disable the bridge
   * or to an explicit effort only for diagnostics.
   */
  compactionReasoningEffort: 'inherit',
}

/** Read the milestone document; undefined when it has never been written. */
function readDoc(path) {
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    if (doc === null || typeof doc !== 'object') return undefined
    if (doc.compactions === undefined || doc.compactions === null || typeof doc.compactions !== 'object') doc.compactions = {}
    return doc
  } catch {
    return undefined
  }
}

/** Persist the milestone document, best effort. */
function writeDoc(path, doc) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(doc, null, 1), 'utf8')
  } catch {
    /* A lost marker costs one redundant skip, never correctness. */
  }
}

function markPending(scope, name, status, extra = {}) {
  if (scope.compactions === undefined || scope.compactions === null || typeof scope.compactions !== 'object') scope.compactions = {}
  const current = scope.compactions[name] ?? { attempts: 0 }
  scope.compactions[name] = {
    ...current,
    status,
    attempts: Number(current.attempts || 0) + (status === 'compacting' ? 1 : 0),
    ...extra,
    updatedAt: Date.now(),
  }
  return scope.compactions[name]
}

function tokenTotal(meter, agent) {
  if (meter === undefined || typeof meter.measure !== 'function') return undefined
  const measured = measureSessionTokens(meter, agent.session)
  return measured === null || measured === undefined ? undefined : measured.totalTokens
}

/**
 * Enforce a request-time context budget. Returns a structured decision instead
 * of throwing so the caller can turn it into a normal refusal/message.
 */
/**
 * Whether an idle (whole-transcript) summary request can be sent at all.
 *
 * The idle path hands the engine the transcript without the tool-result pruning the conversation path gets, so the
 * request is larger than the measured context (16% larger in the one production failure this guards against), and
 * the engine adds its own output allowance. When that sum cannot fit, the fold is left to the engine's step-boundary
 * path on the next turn, which prunes, keeps a tail and picks a range that does fit.
 */
export function summaryRequestBudget(cfg, tokens) {
  const window = Number(cfg.windowTokens)
  if (!(window > 0) || typeof tokens !== 'number' || !Number.isFinite(tokens)) return { ok: true, reason: 'no-measurement' }
  const factor = Number(cfg.idleSummaryInputFactor ?? DEFAULTS.idleSummaryInputFactor)
  const output = Number(cfg.summaryMaxOutputTokens ?? DEFAULTS.summaryMaxOutputTokens)
  // The input factor already carries this request's estimation error; the conversation margin is not added on top.
  const margin = Number(cfg.summarySafetyMarginTokens ?? DEFAULTS.summarySafetyMarginTokens)
  const estimate = Math.ceil(tokens * factor)
  return estimate + output + margin <= window
    ? { ok: true, tokens, estimate, window }
    : { ok: false, reason: 'summary-budget', tokens, estimate, reserved: output, margin, window }
}

/** One line per request that was not sent, next to the milestone file. Never throws; capped so a loop cannot fill the disk. */
function noteBudgetRefusal(cfg, row) {
  try {
    const file = join(dirname(String(cfg.milestonePath)), 'context-budget-refusals.jsonl')
    if (existsSync(file) && statSync(file).size >= 5 * 1024 * 1024) return
    appendFileSync(file, JSON.stringify({ version: 1, at: new Date().toISOString(), ...row }) + '\n')
  } catch { /* the refusal itself already happened; the note is best effort */ }
}

export function preStepBudget(ctx, cfg, agent, inputTokens, injected) {
  const services = servicesOf(ctx, injected)
  const tokens = typeof inputTokens === 'number' ? inputTokens : tokenTotal(services.meter, agent)
  if (typeof tokens !== 'number' || !Number.isFinite(tokens)) return { ok: true, reason: 'no-measurement' }
  const window = Number(cfg.windowTokens)
  // Never reserve less than what this agent is explicitly configured to ask for.
  // The request header is what the engine itself budgets with; either source may be absent.
  const headerMax = (() => { try { return Number(agent?.session?.requestHeader?.()?.config?.maxTokens) || 0 } catch { return 0 } })()
  const reserved = Math.max(Number(cfg.reservedOutputTokens ?? DEFAULTS.reservedOutputTokens), Number(agent?.options?.maxTokens) || 0, headerMax)
  const margin = Number(cfg.safetyMarginTokens ?? DEFAULTS.safetyMarginTokens)
  if (!(window > 0)) return { ok: true, reason: 'no-window' }
  if (tokens + reserved + margin <= window) {
    return { ok: true, tokens, window, ratio: tokens / window, reserved, margin }
  }
  return {
    ok: false,
    reason: 'context-budget',
    tokens,
    window,
    ratio: tokens / window,
    reserved,
    margin,
    remaining: window - tokens,
  }
}

/**
 * Read one service, preferring a direct property and never throwing on a real ctx.
 * A cordis context THROWS on an undeclared property, so both reads are guarded.
 */
function serviceOf(ctx, name) {
  try {
    const direct = ctx[name]
    if (direct !== undefined && direct !== null) return direct
  } catch {
    /* Undeclared property: fall through to the inject-free read. */
  }
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/** The Team membership behind one live agent, or undefined for a non-member. */
function membershipOf(teams, agent) {
  if (teams === undefined || teams === null || typeof teams.tryMembership !== 'function') return undefined
  try {
    return teams.tryMembership(agent)
  } catch {
    return undefined
  }
}

/** The Team member name behind one live agent, or undefined for a non-member. */
function memberName(teams, agent) {
  return membershipOf(teams, agent)?.name
}

/** Resolve the pressure threshold, retaining older config aliases. */
function pressureRatioOf(cfg) {
  const configured = Number(cfg.autoCompactRatio ?? cfg.rejectRatio ?? cfg.hardRatio ?? 0.75)
  return Number.isFinite(configured) && configured > 0 && configured < 1 ? configured : 0.75
}

/**
 * Resolve the compaction engine, if this composition exposes one on a reachable context.
 * @param ctx - host-plane plugin context (test doubles and any host-plane engine).
 * @param agent - the idle agent whose realm may own the engine.
 * @param injected - services bound by the inject callback, when they were.
 * @returns the engine, or undefined when it is isolated away.
 */
function engineOf(ctx, agent, injected) {
  if (injected !== undefined && injected.engine !== undefined && injected.engine !== null) return injected.engine
  const fromAgent = serviceOf(agent === undefined || agent === null ? undefined : agent.ctx, 'compaction')
  if (fromAgent !== undefined && fromAgent !== null) return fromAgent
  return serviceOf(ctx, 'compaction')
}

/**
 * Resolve the services this plugin consumes, falling back to direct reads for test
 * doubles that have no inject channel.
 */
function servicesOf(host, injected) {
  if (injected !== undefined) return injected
  return {
    teams: serviceOf(host, 'agentTeams'),
    meter: serviceOf(host, 'tokenMeter'),
    engine: serviceOf(host, 'compaction'),
    commands: serviceOf(host, 'commands'),
  }
}

/**
 * Validate one finished fold, record it, and announce the recovery prompt.
 *
 * A fold must end the same way whoever started it: the summary still has to carry the
 * anchors a resuming model needs, the outcome belongs in the ledger, and the member gets
 * the recovery notice. Keeping that in one place is what makes "the engine folded behind
 * us" observably identical to a fold this plugin ran itself.
 *
 * @param name - the Team member the fold belongs to; anchors are resolved from this name.
 * @param ledgerName - ledger key, namespaced by the caller when the row must not land on
 *   the member's own key, which is where the milestone job lives.
 * @param outcome - the fold facts: reason/trigger, optional pending job, the engine result
 *   (`folded` or `settled`), measured tokens and ratio, an outcome `detail` suffix, and
 *   extra ledger fields.
 * @returns the outcome string for the caller's log line.
 */
function recordFoldOutcome(ctx, cfg, agent, teamScope, name, ledgerName, doc, memory, recoveryPack, outcome) {
  const validation = anchorDebt(teamScope, name, outcome.pending, outcome.folded, outcome.settled, memory)
  // An engine row is never a blocking debt: the window collector reads any row whose
  // memoryDebt is set, or whose status is outside the settled set, as outstanding memory
  // debt and then withholds the window fold — so this path keeps the row settled and carries
  // the anchor verdict in fields of its own instead of storing a second copy of the pack.
  const keepRecoveryPack = outcome.omitRecoveryPack !== true && !validation.ok
  markPending(teamScope, ledgerName, outcome.rowStatus ?? (validation.ok ? 'compacted' : 'completed_with_debt'), {
    reason: outcome.reason,
    trigger: outcome.trigger,
    ratio: outcome.ratio,
    completedAt: Date.now(),
    tokens: outcome.tokens,
    windowTokens: cfg.windowTokens,
    missingAnchors: validation.missing,
    summaryAvailable: validation.summaryAvailable,
    memoryDebt: keepRecoveryPack ? {
      sourceStatus: memory.sourceStatus,
      missing: validation.missing,
      recoveryPack: recoveryPack.text,
      digest: memory.digest ?? null,
    } : null,
    ...outcome.extra,
  })
  writeDoc(cfg.milestonePath, doc)
  const noticeReason = validation.ok ? outcome.reason : outcome.reason + (outcome.debtSuffix ?? ':completed_with_debt')
  const details = {
    trigger: outcome.trigger,
    ratio: outcome.ratio,
    tokens: outcome.tokens,
    windowTokens: cfg.windowTokens,
  }
  if (outcome.skipNotice === true) return 'folded:' + outcome.reason + (outcome.detail ?? '') + (validation.ok ? '' : ':debt')
  if (outcome.deferredNotice !== true) {
    injectCompactionRecoveryNotice(agent, noticeReason, recoveryPack, details)
    return 'folded:' + outcome.reason + (outcome.detail ?? '') + (validation.ok ? '' : ':debt')
  }
  // The engine's end event is published synchronously from inside Session.append, and its
  // reentry guard rejects any append made while that publication is open — on a session
  // without the native bridge agent.inject() splices the inbox through exactly such an
  // append, so a notice sent here would be swallowed. A microtask runs as soon as the
  // publication closes, still inside the same turn and before the next step, which is the
  // notice's whole point; setImmediate would wait for the event loop's next turn instead.
  queueMicrotask(() => {
    let delivered = false
    try {
      delivered = injectCompactionRecoveryNotice(agent, noticeReason, recoveryPack, details) === true
    } catch {
      delivered = false
    }
    // Another fold of the same step may have rewritten the ledger since this one was recorded: mark the row as it
    // is on disk now, not the copy this call started from.
    const current = typeof outcome.reload === 'function' ? outcome.reload() : { doc, scope: teamScope }
    const row = current?.scope?.compactions?.[ledgerName]
    if (row === undefined || row === null) return
    row.noticeDelivered = delivered
    if (delivered) row.noticePromptedAt = Date.now()
    writeDoc(cfg.milestonePath, current.doc)
  })
  return 'folded:' + outcome.reason + (outcome.detail ?? '') + (validation.ok ? '' : ':debt')
}

/**
 * Execute one already-authorized fold and persist the same recovery state used
 * by the mandatory path. The caller decides whether the reason is mandatory or
 * economic; this helper only owns the side effect and its failure handling.
 */
async function foldNow(ctx, cfg, agent, signal, injected, services, teamScope, name, doc, reason, tokens, ratio, milestoneSetAt, pending) {
  const memory = authoritativeMemory(ctx, cfg, agent, name, teamScope, pending)
  const recoveryPack = buildMemberRecoveryPack(memory)
  markPending(teamScope, name, 'compacting', {
    reason,
    trigger: reason,
    ratio,
    requestedAt: pending?.requestedAt ?? Date.now(),
    tokens,
    windowTokens: cfg.windowTokens,
    memorySourceStatus: memory.sourceStatus,
    memoryDigest: memory.digest ?? null,
    memoryOmitted: memory.omitted ?? {},
    ...milestoneSetAt === undefined ? {} : { milestoneSetAt },
  })
  writeDoc(cfg.milestonePath, doc)

  const summaryBudget = summaryRequestBudget(cfg, tokens)
  if (!summaryBudget.ok) {
    markPending(teamScope, name, 'retryable', { lastError: 'summary-request-over-budget', reason, tokens,
      summaryEstimate: summaryBudget.estimate, windowTokens: cfg.windowTokens })
    writeDoc(cfg.milestonePath, doc)
    noteBudgetRefusal(cfg, { kind: 'summary', sessionId: agent?.session?.id ?? null, member: name, ...summaryBudget })
    return 'skipped:summary-over-budget'
  }
  const engine = engineOf(ctx, agent, injected)
  if (engine !== undefined && typeof engine.compactNow === 'function') {
    // Marked for the duration of the call, not longer: the end event is published inside
    // it, so an observer that checks the marker synchronously sees it.
    takeSelfCompaction(agent)
    try {
      // An idle transition with queued work still throws busy; skipping rather than
      // queueing is deliberate, so a wake-up is never blocked behind a summarization.
      const folded = await engine.compactNow(agent, signal, undefined)
      if (compactionResultStatus(folded).status === 'failed') {
        markPending(teamScope, name, 'retryable', { lastError: String(folded?.text ?? folded?.error?.message ?? 'compact failed') })
        writeDoc(cfg.milestonePath, doc)
        return 'skipped:compact-failed'
      }
      if (folded === null) {
        markPending(teamScope, name, 'no_compactable_range', { reason, completedAt: null, summaryAvailable: false })
        writeDoc(cfg.milestonePath, doc)
        return 'skipped:no-compactable-range'
      }
      if (reason === 'milestone') {
        markCompacted(teamScope, name, Date.now(), milestoneSetAt)
        consumeMilestoneCompaction(teamScope, name, Date.now(), milestoneSetAt)
      }
      return recordFoldOutcome(ctx, cfg, agent, teamScope, name, name, doc, memory, recoveryPack, {
        reason,
        trigger: reason,
        pending,
        folded,
        ratio,
        tokens,
        detail: ':' + (folded === null ? 'no-range' : 'committed'),
      })
    } catch (error) {
      markPending(teamScope, name, 'retryable', { lastError: String(error?.message ?? error) })
      writeDoc(cfg.milestonePath, doc)
      return 'skipped: ' + ((error && error.message) || String(error)).slice(0, 120)
    } finally {
      releaseSelfCompaction(agent)
    }
  }

  // The engine is isolated inside the agent's preset realm, so the host plane reaches
  // compaction through the command that crosses that boundary. /compact's handler runs
  // inside the realm, where it calls compactNow for exactly this agent.
  const commands = services.commands
  if (commands === undefined || typeof commands.execute !== 'function') {
    markPending(teamScope, name, 'retryable', { lastError: 'no-compaction-service' })
    writeDoc(cfg.milestonePath, doc)
    return 'no-compaction-service'
  }
  let settled
  takeSelfCompaction(agent)
  try {
    settled = await commands.execute(agent, '/compact', [], signal)
  } catch (error) {
    markPending(teamScope, name, 'retryable', { lastError: String(error?.message ?? error) })
    writeDoc(cfg.milestonePath, doc)
    return 'skipped: ' + ((error && error.message) || String(error)).slice(0, 120)
  } finally {
    releaseSelfCompaction(agent)
  }
  if (settled === void 0) {
    markPending(teamScope, name, 'retryable', { lastError: 'no-compact-command' })
    writeDoc(cfg.milestonePath, doc)
    return 'no-compact-command'
  }
  const result = settled !== null && typeof settled === 'object' && settled.result !== void 0 ? settled.result : settled
  if (result === null) {
    markPending(teamScope, name, 'no_compactable_range', { reason, completedAt: null, summaryAvailable: false })
    writeDoc(cfg.milestonePath, doc)
    return 'skipped:no-compactable-range'
  }
  if (result !== null && typeof result === 'object' && result.kind === 'error') {
    markPending(teamScope, name, 'retryable', { lastError: String(result.text === void 0 ? 'compact failed' : result.text) })
    writeDoc(cfg.milestonePath, doc)
    return 'skipped: ' + String(result.text === void 0 ? 'compact failed' : result.text).slice(0, 120)
  }
  if (reason === 'milestone') {
    markCompacted(teamScope, name, Date.now(), milestoneSetAt)
    consumeMilestoneCompaction(teamScope, name, Date.now(), milestoneSetAt)
  }
  return recordFoldOutcome(ctx, cfg, agent, teamScope, name, name, doc, memory, recoveryPack, {
    reason,
    trigger: reason,
    pending,
    settled,
    ratio,
    tokens,
  })
}

/**
 * Mirror one economic decision into the v12 compaction document. This is a
 * diagnostic record only: it never changes the mandatory fold path, and a
 * missing control plane must not block compaction.
 */
async function mirrorCompactionDecision(ctx, cfg, agent, name, decision, contextTokens, applied) {
  try {
    const control = controlPlaneForMember(ctx, agent, { directory: cfg.controlDir })
    if (control === undefined || typeof control.mutate !== 'function') return
    if (typeof control.file === 'string' && !existsSync(control.file)) return
    const sessionId = agent?.session?.id ?? agent?.id ?? 'session'
    const decisionValue = decision?.compact === true ? 'compact' : 'defer'
    const reason = decision?.reason ?? 'economic'
    const contextBucket = Math.floor(Math.max(0, Number(contextTokens) || 0) / 10000)
    const mirrorKey = [name, sessionId, contextBucket, decisionValue, reason, applied === true].join('|')
    if (mirroredDecisions.has(mirrorKey)) return
    // This is an in-memory diagnostic record. It must not enter the
    // append-only Room/event history path, which rewrites cold snapshots and
    // the panel cache on every pre-step.
    await control.mutateHot('v13/compaction-decision', {
      owner: name,
      sessionId,
      decision: decisionValue,
      reason,
      contextTokens,
      applied: applied === true,
    }, agent, (latest) => {
      const doc = normalizeCompactionState(latest.v12Compaction ?? {})
      const result = recordCompactionDecision(doc, {
        owner: name,
        sessionId,
        decision: decisionValue,
        reason,
        contextTokens,
        applied: applied === true,
        breakevenRequests: decision?.breakevenRequests ?? null,
        estimatedRemainingRequests: decision?.estimatedRemainingRequests ?? null,
        carriedDebtTokens: decision?.carriedDebtTokens ?? 0,
      })
      latest.v12Compaction = doc
      return result.job
    })
    mirroredDecisions.add(mirrorKey)
    if (mirroredDecisions.size > 2048) {
      const oldest = mirroredDecisions.values().next().value
      mirroredDecisions.delete(oldest)
    }
  } catch {
    /* Decision mirroring is best effort and must never block a fold. */
  }
}

// The durable-window executor, when a host has wired one (team-v15-window-wiring.mjs). It lives in another plugin
// instance, so a process-level handle is the one thing both can see.
const WINDOW_FOLD = Symbol.for('dsh.window.fold.v1')

/**
 * Offer one due fold to the durable window before the summary-based compaction takes it.
 *
 * A window keeps the originals retrievable and needs no summary call, so it is preferred where the session is in
 * its scope and its own rule chooses it. Anything else, including every refusal and every error, returns undefined
 * and the caller folds by compaction exactly as before.
 */
async function windowFold(ctx, cfg, agent, teamScope, name, doc, reason, tokens, milestoneSetAt) {
  const handle = globalThis[WINDOW_FOLD]
  if (handle === undefined || handle === null || typeof handle.tryFold !== 'function') return undefined
  let result
  try {
    if (handle.inScope?.(agent) !== true) return undefined
    result = await handle.tryFold(agent, { contextTokens: tokens, windowTokens: Number(cfg.windowTokens),
      milestoneDone: reason === 'milestone', safeBoundary: true, now: Date.now() })
  } catch (error) {
    if (ctx.logger !== undefined) ctx.logger.warn?.('step-compaction: window fold failed, using compaction: ' + String(error?.code ?? error?.message ?? error).slice(0, 160))
    return undefined
  }
  if (result?.outcome !== 'folded') return undefined
  const now = Date.now()
  if (reason === 'milestone') {
    markCompacted(teamScope, name, now, milestoneSetAt)
    consumeMilestoneCompaction(teamScope, name, now, milestoneSetAt)
  }
  // Nothing was summarised, so nothing can have been lost: the row carries no memory debt and owes no notice.
  teamScope.compactions[name] = { kind: 'window', reason, trigger: reason, status: 'compacted', memoryDebt: null, noticeDelivered: true,
    summaryAvailable: false, windowId: result.receipt?.toWindowId ?? null, tokens, windowTokens: Number(cfg.windowTokens),
    ...(typeof milestoneSetAt === 'number' ? { milestoneSetAt } : {}), completedAt: now, updatedAt: now }
  writeDoc(cfg.milestonePath, doc)
  return 'folded:window:' + reason
}

/**
 * Fold one idle agent's context at a milestone or the pressure safety threshold.
 * @returns a short outcome string, for logging and tests.
 */
export async function compactOnIdle(ctx, cfg, agent, signal, injected) {
  const services = servicesOf(ctx, injected)
  const membership = membershipOf(services.teams, agent)
  if (membership === undefined) return 'not-a-team-member'
  const name = membership.name
  const doc = readDoc(cfg.milestonePath)
  if (doc === undefined) return 'no-milestones'
  pruneStaleMilestoneCompactions(doc)
  const teamScope = milestoneScope(doc, String(membership.id ?? ''))
  const meter = services.meter
  if (meter === undefined || typeof meter.measure !== 'function') return 'no-meter'
  const measured = measureSessionTokens(meter, agent.session)
  const tokens = measured === null || measured === undefined ? undefined : measured.totalTokens
  if (typeof tokens !== 'number') return 'no-measurement'
  // A ticked milestone is represented by an independent pending job, because the
  // current milestone record may already have been replaced by the next stage.
  // pendingMilestoneCompaction() checks that the job still matches the live
  // revision; a stale job can never fold a newer milestone.
  const pending = pendingMilestoneCompaction(teamScope, name)
  const ratio = tokens / cfg.windowTokens
  const pressureRatio = pressureRatioOf(cfg)
  // A tick already skipped for being too small stays skipped: only pressure can fold until a new milestone is ticked.
  const current = teamScope.members[name]
  const alreadySkipped = pending === undefined && current?.done === true && typeof current.foldSkippedAt === 'number'
  let verdict = pending === undefined
    ? shouldCompact(alreadySkipped ? undefined : current, ratio, pressureRatio)
    : { yes: true, reason: pending.reason ?? 'milestone', ratio }
  const proactiveAt = Math.max(0, Number(cfg.proactiveFoldTokens ?? DEFAULTS.proactiveFoldTokens) || 0)
  if (verdict.yes !== true && proactiveAt > 0 && tokens >= proactiveAt) verdict = { yes: true, reason: 'proactive', ratio }
  if (verdict.yes !== true) {
    const mode = String(cfg.opportunisticCompaction ?? 'shadow')
    if (mode !== 'shadow' && mode !== 'on') return 'nothing-armed'
    let shadow
    try {
      shadow = evaluateShadow(agent, cfg, tokens)
    } catch (error) {
      if (ctx.logger !== undefined) ctx.logger.warn?.('step-compaction: economic shadow failed: ' + String(error?.message ?? error))
      return 'economic-unavailable'
    }
    if (shadow === undefined) return 'economic-no-boundary'
    if (mode === 'shadow') {
      await mirrorCompactionDecision(ctx, cfg, agent, name, shadow.decision, tokens, false)
      return 'shadow:' + shadow.decision.reason
    }
    if (shadow.decision.compact !== true) {
      await mirrorCompactionDecision(ctx, cfg, agent, name, shadow.decision, tokens, false)
      return 'economic-deferred:' + shadow.decision.reason
    }
    const result = await foldNow(ctx, cfg, agent, signal, injected, services, teamScope, name, doc, 'economic', tokens, ratio, undefined, undefined)
    await mirrorCompactionDecision(ctx, cfg, agent, name, shadow.decision, tokens, result.startsWith('folded'))
    return result
  }
  const milestoneSetAt = pending?.milestoneSetAt ?? teamScope.members[name]?.setAt
  if (verdict.reason === 'milestone' && typeof milestoneSetAt !== 'number') return 'nothing-armed'
  const milestoneFloor = Math.max(0, Number(cfg.minMilestoneFoldTokens ?? DEFAULTS.minMilestoneFoldTokens) || 0)
  if (verdict.reason === 'milestone' && tokens < milestoneFloor) {
    const now = Date.now()
    teamScope.compactions[name] = { ...(teamScope.compactions[name] ?? {}), kind: 'milestone', reason: 'milestone',
      status: 'skipped-below-floor', milestoneSetAt, tokens, minMilestoneFoldTokens: milestoneFloor, updatedAt: now }
    if (teamScope.members[name]?.setAt === milestoneSetAt) teamScope.members[name].foldSkippedAt = now
    writeDoc(cfg.milestonePath, doc)
    await mirrorCompactionDecision(ctx, cfg, agent, name, { compact: false, reason: 'milestone-below-floor' }, tokens, false)
    return 'milestone-deferred:below-floor'
  }
  // The engine's own folds are recorded under a row of their own; whichever fold happened last sets the cooldown.
  const prior = [teamScope.compactions[name], teamScope.compactions['engine:' + name]].filter(row => row !== undefined && row !== null)
    .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))[0]
  const priorAge = Date.now() - Number(prior?.updatedAt ?? 0)
  const pressureCooldownMs = Math.max(0, Number(cfg.pressureCooldownMs ?? DEFAULTS.pressureCooldownMs))
  const pressureHardRatio = Math.min(
    0.99,
    Math.max(pressureRatio, Number(cfg.pressureHardRatio ?? DEFAULTS.pressureHardRatio)),
  )
  if (
    verdict.reason === 'pressure'
    && prior?.status === 'compacted'
    && priorAge < pressureCooldownMs
    && ratio < pressureHardRatio
  ) return 'pressure-cooldown'
  if (prior?.status === 'retryable' && priorAge < 5 * 60 * 1000) return 'pressure-cooldown'
  if (prior?.status === 'compacted' && priorAge < 60 * 1000) return 'pressure-cooldown'
  // Size alone is not urgent: whatever the last attempt did, it is not repeated on every idle.
  if (verdict.reason === 'proactive' && priorAge < pressureCooldownMs) return 'proactive-cooldown'
  const windowed = await windowFold(ctx, cfg, agent, teamScope, name, doc, verdict.reason, tokens, milestoneSetAt)
  let foldReason = verdict.reason, foldTokens = tokens, foldRatio = ratio, foldSetAt = milestoneSetAt, foldPending = pending
  if (windowed !== undefined) {
    await mirrorCompactionDecision(ctx, cfg, agent, name, { compact: true, reason: 'window:' + verdict.reason }, tokens, true)
    // A window folds completed turns only. If the context is still over the pressure line afterwards, the fold did
    // not do what pressure needs, and the summary fold must still run now rather than after a cooldown.
    const after = measureSessionTokens(meter, agent.session)?.totalTokens
    if (typeof after !== 'number' || after / cfg.windowTokens < pressureRatio) return windowed
    foldReason = 'pressure'; foldTokens = after; foldRatio = after / cfg.windowTokens; foldSetAt = undefined; foldPending = undefined
  }
  const result = await foldNow(ctx, cfg, agent, signal, injected, services, teamScope, name, doc, foldReason, foldTokens, foldRatio, foldSetAt, foldPending)
  if (result.startsWith('folded')) { try { globalThis[WINDOW_FOLD]?.resetDemand?.(agent) } catch { /* the window is optional */ } }
  await mirrorCompactionDecision(ctx, cfg, agent, name, {
    compact: true,
    reason: verdict.reason,
  }, tokens, result.startsWith('folded'))
  return result
}

/** The live agent behind one session id, or undefined when this plane cannot see it. */
function agentOfSession(host, ctx, sessionId) {
  for (const carrier of [host, ctx]) {
    try {
      // serviceOf reads either the direct property or the inject-free accessor, so an
      // undeclared service on one carrier never hides a resolvable one on the other.
      const agent = serviceOf(carrier, 'agents')?.get?.(sessionId)
      if (agent !== undefined && agent !== null) return agent
    } catch {
      /* The next carrier may still resolve the agent. */
    }
  }
  return undefined
}

/**
 * The summary blocks of one finished compaction, when the session still exposes its log.
 *
 * anchorDebt() prices that text. Without it the row is recorded as an honest
 * missing-summary debt, which is the point: an unread summary must never read as a pass.
 */
function engineCompactionSummary(session, compactionId) {
  try {
    const log = Array.isArray(session?.log) ? session.log
      : typeof session?.list === 'function' ? session.list() : undefined
    if (!Array.isArray(log)) return undefined
    const summary = log.findLast((row) => row?.type === 'compaction/summary' && row?.data?.compactionId === compactionId)
    return summary === undefined ? undefined : { summary: summary.data?.summary }
  } catch {
    return undefined
  }
}

/** The context pressure after a fold, or an absent measurement rather than a failed one. */
function measuredRatio(cfg, services, agent) {
  try {
    const window = Number(cfg.windowTokens)
    const tokens = tokenTotal(services.meter, agent)
    if (!(window > 0) || typeof tokens !== 'number') return {}
    return { tokens, ratio: tokens / window }
  } catch {
    return {}
  }
}

/**
 * Post-process one compaction this plugin did not start.
 *
 * The engine owns the step-boundary pressure fold and the overflow-recovery fold, and both
 * run inside its own handlers rather than through foldNow. Unobserved they would end with no
 * anchor check, no ledger row and no recovery notice, so a member folded by the engine would
 * resume with less than a member folded by this plugin. The encounter itself is synchronous,
 * inside the publication of the close event, so the row is written here and the notice is
 * handed to a microtask that runs once that publication has closed.
 */
function observeEngineCompaction(ctx, cfg, host, injected, session, event) {
  try {
    // session/event carries the appended payload under `data`; an errored close is left to
    // the engine's own failure handling and must not be counted as a fold.
    const data = event?.data ?? event
    if (data?.error !== undefined) return
    const compactionId = data?.compactionId
    const sessionId = session?.id
    if (compactionId === undefined || compactionId === null) return
    if (sessionId === undefined || sessionId === null) return
    if (foldingHere(sessionId)) return
    const key = String(sessionId) + '|' + String(compactionId)
    if (observedEngineCompactions.has(key)) return
    observedEngineCompactions.add(key)
    if (observedEngineCompactions.size > 2048) {
      const oldest = observedEngineCompactions.values().next().value
      observedEngineCompactions.delete(oldest)
    }
    const agent = agentOfSession(host, ctx, sessionId)
    if (agent === undefined) return
    const services = servicesOf(host, injected)
    const membership = membershipOf(services.teams, agent)
    if (membership === undefined) return
    const doc = readDoc(cfg.milestonePath)
    if (doc === undefined) return
    const name = membership.name
    const teamScope = milestoneScope(doc, String(membership.id ?? ''))
    // The plugin has no inject entry of its own, so the services that can see this agent live
    // on the host scope the observer was installed with — the same one foldNow reads through.
    const memory = authoritativeMemory(host, cfg, agent, name, teamScope, undefined)
    const recoveryPack = buildMemberRecoveryPack(memory)
    // The engine folds the step boundary on its own threshold and also recovers a request
    // that overflowed; the durable event separates them: an ownerless close (turn null) or
    // one issued by a command is operator-driven, anything else is the automatic path.
    const manual = data?.sourceCommandId !== undefined || data?.turn === null
    const trigger = manual ? 'engine-manual' : 'engine-auto'
    const boundary = stepBoundaryOf(sessionId)
    const coalesced = engineNoticeBoundaries.get(String(sessionId)) === boundary
    if (!coalesced) boundedMapSet(engineNoticeBoundaries, String(sessionId), boundary)
    // The ledger key is namespaced on purpose: the member's own key carries the milestone
    // job that the idle path claims, and an engine fold must not consume or overwrite it.
    const outcome = recordFoldOutcome(host, cfg, agent, teamScope, name, 'engine:' + name, doc, memory, recoveryPack, {
      reason: trigger,
      trigger,
      settled: engineCompactionSummary(session, compactionId),
      ...measuredRatio(cfg, services, agent),
      rowStatus: 'compacted',
      omitRecoveryPack: true,
      deferredNotice: true,
      skipNotice: coalesced,
      reload: () => { const fresh = readDoc(cfg.milestonePath); return fresh === undefined ? undefined : { doc: fresh, scope: milestoneScope(fresh, String(membership.id ?? '')) } },
      debtSuffix: ':anchor-debt',
      extra: {
        kind: 'engine',
        compactionId: String(compactionId),
        memorySourceStatus: memory.sourceStatus,
        // A coalesced row is covered by the notice already queued for this same step, so it
        // must not look like a delivery that still has to be retried.
        noticeDelivered: coalesced,
        ...coalesced ? { noticeCoalesced: true } : {},
      },
    })
    ctx.logger?.info?.('step-compaction: ' + outcome)
  } catch (error) {
    ctx.logger?.warn?.('step-compaction: engine compaction recovery failed: ' + String(error?.message ?? error))
  }
}

/**
 * Install the idle-triggered fold.
 * @param ctx - plugin context carrying the agent teams, token meter and commands.
 * @param config - optional overrides for DEFAULTS plus milestonePath.
 * @returns an idempotent disposer with the read-only runtime identity service attached.
 */
export function apply(ctx, config) {
  const overrides = config === null || config === undefined ? {} : config
  const cfg = Object.assign({}, DEFAULTS, overrides)
  // Defaulted here as well as in the tool layer: both plugins must independently agree
  // on which file holds the milestones, or the tick would arm a document nobody reads.
  if (typeof cfg.milestonePath !== 'string' || cfg.milestonePath.length === 0) {
    cfg.milestonePath = join(process.env.DSH_HOME ?? process.cwd(), 'team-milestones.json')
  }
  const instanceId = randomUUID()
  const disposers = []
  let disposed = false
  let registered = false
  let registrationStatus = 'unavailable:provide-missing'
  let unprovide
  const compactionReasoningEffort = typeof cfg.compactionReasoningEffort === 'string'
    ? cfg.compactionReasoningEffort.trim()
    : ''
  const runtimeFacts = () => {
    const pathFacts = milestonePathFacts(cfg.milestonePath)
    const configHash = configHashOf(cfg)
    return Object.freeze({
      pid: process.pid,
      instanceId,
      moduleHash,
      loaded: registered && !disposed,
      configuredPath: pathFacts.configuredPath,
      physicalPath: pathFacts.physicalPath,
      physicalPathStatus: pathFacts.physicalPathStatus,
      profile: moduleProfile,
      configHash,
      configHashStatus: configHash === null ? 'unknown' : 'known',
      registrationStatus: disposed ? 'disposed' : registrationStatus,
    })
  }
  const runtimeService = Object.freeze({
    runtimeFacts,
    get loaded() { return registered && !disposed },
  })
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const stop of disposers.splice(0).reverse()) {
      try { stop() } catch (error) {
        ctx.logger?.warn?.('step-compaction: cleanup failed: ' + String(error?.message ?? error))
      }
    }
  }
  dispose.runtimeService = runtimeService
  const keepDisposer = stop => { if (typeof stop === 'function') disposers.push(stop) }
  if (typeof ctx.provide === 'function') {
    try {
      unprovide = ctx.provide('stepCompactionRuntime', runtimeService)
      registered = true
      registrationStatus = 'registered'
      keepDisposer(unprovide)
    } catch (error) {
      registrationStatus = 'unavailable:provide-failed'
      ctx.logger?.warn?.('step-compaction: runtime identity service unavailable: ' + String(error?.message ?? error))
    }
  }
  keepDisposer(ctx.on('llm/stream', (options, next) => {
    const observation = observeRequestBudget(ctx, options)
    // These estimates are diagnostic only. preStepBudget still uses the raw meter.
    if (options?.purpose === 'compaction' && observation.requestId) {
      ctx.logger?.debug?.('[step-compaction] request budget ' + JSON.stringify(observation))
    }
    // The pre-step check sees the session before this step's projections, and it never sees the engine's own summary
    // request at all. This is the final request, whoever built it. The estimate (UTF-16 units / 4) is a floor: real
    // text is never fewer tokens than that, so a request refused here could not have fitted. It is answered with the
    // same terminal chunk a provider overflow produces, which lets the engine's own overflow recovery run.
    if (cfg.enablePreStep === true && cfg.finalRequestGuard !== false) {
      const floor = Number(observation.projectedContentEstimateTokens)
      const output = Number(options?.maxTokens) || Number(options?.purpose === 'compaction'
        ? cfg.summaryMaxOutputTokens ?? DEFAULTS.summaryMaxOutputTokens : cfg.reservedOutputTokens ?? DEFAULTS.reservedOutputTokens)
      const window = Number(cfg.windowTokens)
      if (Number.isFinite(floor) && window > 0 && floor + output > window) {
        noteBudgetRefusal(cfg, { kind: 'final-request', sessionId: options?.sessionId ?? null, purpose: options?.purpose ?? 'conversation',
          estimateFloorTokens: floor, reservedOutput: output, window })
        ctx.logger?.warn?.('step-compaction: a request that cannot fit the model window was not sent (' + String(floor) + ' + ' + String(output) + ' > ' + String(window) + ')')
        const failure = Object.freeze({ code: 'CONTEXT_WINDOW_EXCEEDED',
          message: 'context-budget: the request cannot fit the model window (at least ' + String(floor) + ' input + ' + String(output) + ' output > ' + String(window) + '); it was not sent' })
        return (async function* () { yield { type: 'finish', reason: { kind: 'error', failure } } })()
      }
    }
    return next()
  }, { global: true }))
  if (compactionReasoningEffort !== 'off') {
    ctx.logger?.info?.('[step-compaction] cache-reasoning bridge loaded')
    keepDisposer(ctx.on('llm/stream', (options, next) => {
      if (options?.purpose === 'compaction' && options.reasoningEffort === undefined) {
        try {
          const agent = ctx.agents?.get?.(options.sessionId)
          const routed = agent?.session?.requestHeader?.()?.config?.reasoningEffort
          const effort = compactionReasoningEffort === 'inherit'
            ? (typeof routed === 'string' ? routed.trim() : '')
            : compactionReasoningEffort
          if (effort.length > 0) options.reasoningEffort = effort
        } catch (error) {
          ctx.logger?.warn?.('step-compaction: cannot preserve reasoning effort for cache reuse: ' + String(error?.message ?? error))
        }
      }
      return next()
    }, { global: true, prepend: true }))
  }
  /** Install the idle observer on a context that owns the services. */
  const install = (host, injected) => {
    // global: this plugin is not an ancestor scope of the agents it observes.
    return host.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle' || agent === undefined || agent === null) return
      const controller = new AbortController()
      void compactOnIdle(host, cfg, agent, controller.signal, injected)
        .then((outcome) => {
          if (ctx.logger === undefined) return
          if (outcome.startsWith('folded')) ctx.logger.info?.('step-compaction: ' + outcome)
          else if (outcome.startsWith('skipped')) ctx.logger.warn?.('step-compaction: ' + outcome)
        })
        .catch(() => {})
    }, { global: true })
  }
  // A refused step ends the turn. Two things must not be lost with it: the input that step had already taken out of
  // the inbox, and the member itself, which nobody may ever wake again.
  //  - The input goes straight back into the inbox. That is durable and needs no memory here, so a reload or a cancel
  //    in between behaves as it would for any queued input. It cannot spin: a refused turn ends idle and only a new
  //    wake starts another.
  //  - The member is woken again after a delay. The engine folds at the start of that turn (its own step-boundary
  //    pressure fold), so the recovery is simply another turn, a little later. Only a wake this plugin sent counts as
  //    an attempt; refusals caused by other people's wakes do not use the attempts up.
  // Pending wakes are kept at process level so a hot reload of this plugin hands them to the next instance.
  const RETRIES = Symbol.for('dsh.step-compaction.budget-retries.v1')
  const budgetRetries = globalThis[RETRIES] instanceof Map ? globalThis[RETRIES] : (globalThis[RETRIES] = new Map())
  const budgetOwner = {}
  // What is waiting, on disk: a restart must not forget a member that is waiting for its retry, and a member that
  // ran out of retries stays listed as paused until one of its steps goes through. Sizes and times only.
  const budgetStateFile = join(dirname(String(cfg.milestonePath)), 'context-budget-pending.json')
  const saveBudgetState = () => {
    try {
      const sessions = Object.fromEntries([...budgetRetries].map(([key, entry]) => [key, { state: entry.gaveUp ? 'paused' : 'retrying',
        wakes: entry.wakes, dueAt: entry.dueAt ?? null, member: entry.member ?? null, tokens: entry.tokens ?? null, updatedAt: Date.now() }]))
      writeFileSync(budgetStateFile, JSON.stringify({ version: 1, sessions }, null, 1))
    } catch { /* best effort: the in-memory state still drives this process */ }
  }
  const loadBudgetState = () => { try { return JSON.parse(readFileSync(budgetStateFile, 'utf8'))?.sessions ?? {} } catch { return {} } }
  const budgetBackoff = Array.isArray(cfg.budgetRetryBackoffMs) && cfg.budgetRetryBackoffMs.every(ms => Number.isFinite(ms) && ms >= 0)
    ? cfg.budgetRetryBackoffMs : DEFAULTS.budgetRetryBackoffMs
  const budgetKey = agent => String(agent?.session?.id ?? '')
  const queued = (agent, message) => agent?.inbox?.nextStep?.includes?.(message) === true || agent?.inbox?.nextTurn?.includes?.(message) === true
  // One by one: a batch splice refuses the whole batch when a single id is already pending.
  const requeue = (agent, messages) => {
    let count = 0
    for (const message of messages) {
      if (queued(agent, message)) continue
      try { agent.inbox.splice('next-step', Infinity, 0, [message]); count++ } catch { /* already pending, or the inbox went with the agent */ }
    }
    return count
  }
  const sendQuietly = (target, message, wake, onFailure) => {
    // With the native bridge send() is asynchronous and its rejection would otherwise be unhandled.
    try { Promise.resolve(target.send(message, wake ? 'next-turn' : 'next-step', wake)).catch(onFailure) } catch (error) { onFailure(error) }
  }
  function settleBudgetRetry(agent) {
    const entry = budgetRetries.get(budgetKey(agent))
    if (entry === undefined) return
    clearTimeout(entry.timer)
    budgetRetries.delete(budgetKey(agent))
    saveBudgetState()
  }
  function armBudgetWake(agent, entry, delay) {
    const key = budgetKey(agent)
    entry.owner = budgetOwner
    entry.dueAt = Date.now() + delay
    entry.timer = setTimeout(() => {
      if (disposed || budgetRetries.get(key) !== entry || entry.owner !== budgetOwner) return
      entry.timer = undefined
      entry.dueAt = undefined
      entry.wakes++
      saveBudgetState()
      // The refused input was taken back out of the inbox by someone (a cancel clears it): do not revive the member.
      if (entry.inputs.length > 0 && !entry.inputs.some(message => queued(agent, message))) {
        budgetRetries.delete(key)
        noteBudgetRefusal(cfg, { kind: 'retry-dropped', sessionId: key, reason: 'input-withdrawn' })
        return
      }
      // Someone else already has it running: the returned input is enough, no second wake.
      if (agent.status !== 'idle') return
      sendQuietly(agent, createUserMessage({
        content: [{ type: 'text', text: '[context budget] Your previous step was not sent: the context no longer fit the model window.'
          + ' The runtime folds the context before the next request. Continue from the task state and the recovery notice;'
          + ' do not repeat work that is already recorded on the Team board.' }],
        source: { kind: 'team-message', plugin: name, form: 'notice', summary: 'context budget retry' },
      }), true, error => noteBudgetRefusal(cfg, { kind: 'wake-failed', sessionId: key, attempt: entry.wakes,
        error: String(error?.code ?? error?.message ?? error).slice(0, 200) }))
    }, delay)
    entry.timer.unref?.()
  }
  function scheduleBudgetRetry(agent, claimed, teams) {
    const key = budgetKey(agent)
    if (key.length === 0) return { retry: 'none' }
    const entry = budgetRetries.get(key) ?? { wakes: 0, inputs: [], timer: undefined, owner: budgetOwner, dueAt: undefined, gaveUp: false }
    budgetRetries.set(key, entry)
    entry.inputs = [...new Set([...entry.inputs.filter(message => queued(agent, message)), ...claimed])]
    const requeuedMessages = requeue(agent, claimed)
    if (entry.timer !== undefined && entry.owner === budgetOwner) return { retry: 'pending', attempt: entry.wakes + 1, requeuedMessages }
    if (entry.wakes >= budgetBackoff.length) {
      // Out of attempts. The input is in the inbox for whoever wakes the member next; tell the lead once, because
      // the refusal reason itself is dropped by the agent loop and nobody would otherwise learn the member is stuck.
      if (!entry.gaveUp) {
        entry.gaveUp = true
        ctx.logger?.warn?.('step-compaction: ' + key + ' is PAUSED: its context no longer fits the model window and ' + String(entry.wakes)
          + ' retries did not bring it back. Its input is kept in its inbox. Run /compact in that session, then send it a message. (listed in ' + budgetStateFile + ')')
        const member = (() => { try { return teams?.tryMembership?.(agent) } catch { return undefined } })()
        const root = member?.root
        // The lead itself has nobody above it: the notice waits in its own inbox, where the operator sees it.
        if ((!root || root === agent) && typeof agent.send === 'function') sendQuietly(agent, createUserMessage({
          content: [{ type: 'text', text: '[context budget] This session is PAUSED: its context no longer fits the model window and retrying did not help.'
            + ' Operator: run /compact here, then send a message. /budget lists every paused session.' }],
          source: { kind: 'team-message', plugin: name, form: 'notice', summary: 'context budget paused' },
        }), false, () => {})
        if (root && root !== agent && typeof root.send === 'function') sendQuietly(root, createUserMessage({
          content: [{ type: 'text', text: '[context budget] Member ' + String(member?.name ?? key) + ' cannot continue: its context no longer fits the'
            + ' model window and folding it did not bring it back under the limit after ' + String(entry.wakes) + ' retries. Its queued input is'
            + ' kept. Compact that member manually, or reassign its task.' }],
          source: { kind: 'team-message', plugin: name, form: 'notice', summary: 'context budget gave up' },
        }), false, () => {})
      }
      saveBudgetState()
      return { retry: 'gave-up', attempts: entry.wakes, requeuedMessages }
    }
    const delay = budgetBackoff[entry.wakes]
    armBudgetWake(agent, entry, delay)
    saveBudgetState()
    return { retry: 'scheduled', attempt: entry.wakes + 1, delayMs: delay, requeuedMessages }
  }
  // Wakes an earlier instance of this plugin had pending when it was reloaded.
  const adoptBudgetRetries = host => {
    const agents = serviceOf(host, 'agents')
    // What an earlier process left behind. A retry that was due while the host was down is taken up shortly after
    // start; a paused member is only reported, an operator has to act on it.
    for (const [key, row] of Object.entries(loadBudgetState())) {
      if (budgetRetries.has(key)) continue
      const live = (() => { try { return agents?.get?.(key) } catch { return undefined } })()
      if (live === undefined) continue
      const paused = row?.state === 'paused'
      budgetRetries.set(key, { wakes: Number(row?.wakes) || 0, inputs: [], timer: undefined, owner: null, gaveUp: paused,
        dueAt: paused ? undefined : Math.max(Number(row?.dueAt) || 0, Date.now() + 30000), member: row?.member ?? null, tokens: row?.tokens ?? null })
      if (paused) ctx.logger?.warn?.('step-compaction: ' + key + ' is still PAUSED from an earlier run (context over the model window). Run /compact in that session, then send it a message.')
    }
    for (const [key, entry] of [...budgetRetries]) {
      if (entry.owner === budgetOwner || entry.timer !== undefined || entry.gaveUp) continue
      const agent = (() => { try { return agents?.get?.(key) } catch { return undefined } })()
      if (agent === undefined || typeof entry.dueAt !== 'number' || Date.now() - entry.dueAt > 3600000) { budgetRetries.delete(key); continue }
      armBudgetWake(agent, entry, Math.max(0, entry.dueAt - Date.now()))
    }
  }
  keepDisposer(() => {
    for (const entry of budgetRetries.values()) if (entry.owner === budgetOwner) { clearTimeout(entry.timer); entry.timer = undefined; entry.owner = null }
  })
  // A provider that answers an over-window request with a bare "parameters rejected" 400 gives the engine nothing
  // to recognise, so its overflow recovery (fold once, retry) never runs. Close to the window that is what the
  // rejection means; say so, and let the engine's own handler do the rest.
  const installOverflowReclassifier = (host, injected) => {
    if (typeof host.on !== 'function') return () => {}
    return host.on('agent/request-error', (payload, next) => {
      try {
        const failure = payload?.failure, text = String(failure?.message ?? '')
        if (failure && failure.code !== 'CONTEXT_WINDOW_EXCEEDED'
          && /model_param_invalid|request parameters were rejected by the model provider/i.test(text)) {
          const verdict = preStepBudget(host, { ...cfg, safetyMarginTokens: 0 }, payload.agent, undefined, injected)
          const ratio = Number(cfg.overflowReclassifyRatio ?? DEFAULTS.overflowReclassifyRatio)
          if (typeof verdict.tokens === 'number' && verdict.tokens + (verdict.reserved ?? Number(cfg.reservedOutputTokens ?? DEFAULTS.reservedOutputTokens)) > Number(cfg.windowTokens) * ratio) {
            payload.failure = { ...failure, code: 'CONTEXT_WINDOW_EXCEEDED', reclassifiedFrom: failure.code ?? null }
            noteBudgetRefusal(cfg, { kind: 'provider-overflow', sessionId: payload.agent?.session?.id ?? null, tokens: verdict.tokens, window: Number(cfg.windowTokens) })
          }
        }
      } catch { /* classification is best effort; the original failure stands */ }
      return typeof next === 'function' ? next() : undefined
    }, { global: true, prepend: true })
  }
  const installBudget = (host, injected) => {
    if (cfg.enablePreStep !== true) return () => {}
    if (typeof host.on !== 'function') return () => {}
    adoptBudgetRetries(host)
    // The operator's view of it: which sessions are waiting for a retry and which are paused, without a model turn.
    keepDisposer((() => {
      try {
        const commands = serviceOf(host, 'commands')
        if (typeof commands?.register !== 'function') return undefined
        return commands.register({ name: 'budget', description: 'Sessions refused for context budget: waiting for a retry, or paused', recordInput: false,
          handler: async () => {
            const rows = Object.entries(loadBudgetState())
            if (!rows.length) return { kind: 'success', text: 'context budget: no session is waiting or paused' }
            return { kind: 'success', text: 'context budget\n' + rows.map(([sessionId, row]) => '- ' + sessionId + ': ' + (row.state === 'paused'
              ? 'PAUSED after ' + String(row.wakes) + ' retries; run /compact in that session, then send it a message'
              : 'waiting for retry ' + String(Number(row.wakes) + 1) + (row.dueAt ? ' at ' + new Date(row.dueAt).toISOString() : ''))).join('\n') }
          } })
      } catch { return undefined }
    })())
    // Sessions are loaded lazily; one that was waiting when the host went down is taken up when it appears.
    keepDisposer((() => { try { return host.on('agent/created', () => { try { adoptBudgetRetries(host) } catch { /* best effort */ } }, { global: true }) } catch { return undefined } })())
    return host.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
      const prior = await next()
      if (prior?.kind === 'reject') return prior
      // The meter counts what the session already holds. What this step is about to add (the claimed input and the
      // context pack) is not in it yet, and it is exactly what tips a nearly full context over the window.
      const held = tokenTotal(servicesOf(host, injected).meter, agent)
      const entering = Array.isArray(prior?.messages) && prior.messages.length ? Math.ceil(Buffer.byteLength(JSON.stringify(prior.messages)) / 3) : 0
      const verdict = preStepBudget(host, cfg, agent, typeof held === 'number' && Number.isFinite(held) ? held + entering : undefined, injected)
      if (verdict.ok) settleBudgetRetry(agent)
      if (!verdict.ok) {
        if (ctx.logger !== undefined) ctx.logger.warn?.('step-compaction: refusing ' + verdict.reason + ' step for ' + String(memberName(servicesOf(host, injected).teams, agent)) + ' (ratio=' + Number(verdict.ratio ?? 0).toFixed(3) + ')')
        const reason = 'context-budget: the next request would not fit the model window ('
          + String(verdict.tokens) + ' input + ' + String(verdict.reserved) + ' reserved output + ' + String(verdict.margin)
          + ' margin > ' + String(verdict.window) + '); it was not sent'
        // A turn that is being cancelled is not coming back; its input is not ours to restore and nobody should wake it.
        if (signal?.aborted === true) return { kind: 'reject', reason }
        const retry = scheduleBudgetRetry(agent, Array.isArray(messages) ? messages : [], servicesOf(host, injected).teams)
        noteBudgetRefusal(cfg, { kind: 'conversation', sessionId: agent?.session?.id ?? null,
          member: memberName(servicesOf(host, injected).teams, agent) ?? null, ...verdict, ...retry })
        return { kind: 'reject', reason }
      }
      return prior
    }, { global: true, prepend: true })
  }
  const installMemoryRecovery = (host, injected) => {
    if (typeof host.on !== 'function') return () => {}
    return host.on('agent/pre-step', ({ agent }, next) => {
      const membership = membershipOf(servicesOf(host, injected).teams, agent)
      if (membership !== undefined) {
        const doc = readDoc(cfg.milestonePath)
        if (doc !== undefined) {
          const scope = milestoneScope(doc, String(membership.id ?? ''))
          const pending = scope.compactions?.[membership.name]
          if (pending?.status === 'completed_with_debt' && pending.memoryDebt?.recoveryPack && !pending.recoveryPromptedAt) {
            const delivered = injectCompactionRecoveryNotice(agent, pending.reason + ':memory-debt', { text: pending.memoryDebt.recoveryPack }, {
              trigger: pending.trigger ?? pending.reason,
              ratio: pending.ratio,
              tokens: pending.tokens,
              windowTokens: pending.windowTokens,
            })
            if (delivered) {
              pending.recoveryPromptedAt = Date.now()
              writeDoc(cfg.milestonePath, doc)
            }
          }
          const engineRow = scope.compactions?.['engine:' + membership.name]
          if (engineRow?.kind === 'engine' && engineRow.noticeDelivered === false) {
            try {
              const memory = authoritativeMemory(host, cfg, agent, membership.name, scope, undefined)
              if (injectCompactionRecoveryNotice(agent, String(engineRow.reason) + ':redelivered', buildMemberRecoveryPack(memory), {
                trigger: engineRow.trigger ?? engineRow.reason, ratio: engineRow.ratio, tokens: engineRow.tokens, windowTokens: engineRow.windowTokens,
              })) {
                engineRow.noticeDelivered = true
                engineRow.noticePromptedAt = Date.now()
                writeDoc(cfg.milestonePath, doc)
              }
            } catch { /* still owed; the next step tries again */ }
          }
        }
      }
      return typeof next === 'function' ? next() : undefined
    }, { global: true })
  }
  /**
   * Install the observer for compactions this plugin did not start.
   *
   * global: the engine's folds end on the agent's own session scope, and this plugin is not
   * an ancestor of those agents — the same reason the idle observer above is global.
   */
  const installEngineRecovery = (host, injected) => {
    if (typeof host.on !== 'function') return () => {}
    return host.on('session/event', (session, event) => {
      if (event?.type === 'step/start') { noteStepBoundary({ id: session?.id, seq: event.seq }); return }
      if (event?.type !== 'compaction/end') return
      observeEngineCompaction(ctx, cfg, host, injected, session, event)
    }, { global: true })
  }
  // The callback form is load-bearing: a static inject on a service this composition does
  // not provide leaves the entry pending, and one pending entry refuses the whole tree.
  if (typeof ctx.inject === 'function') {
    keepDisposer(ctx.inject(['agentTeams', 'tokenMeter', 'commands'], (scoped) => {
      if (disposed) return
      const injected = {
        teams: serviceOf(scoped, 'agentTeams'),
        meter: serviceOf(scoped, 'tokenMeter'),
        engine: serviceOf(scoped, 'compaction'),
        commands: serviceOf(scoped, 'commands'),
      }
      keepDisposer(install(scoped, injected))
      keepDisposer(installBudget(scoped, injected))
      keepDisposer(installOverflowReclassifier(scoped, injected))
      keepDisposer(installMemoryRecovery(scoped, injected))
      keepDisposer(installEngineRecovery(scoped, injected))
    }))
  } else {
    keepDisposer(install(ctx, undefined))
    keepDisposer(installBudget(ctx, undefined))
    keepDisposer(installOverflowReclassifier(ctx, undefined))
    keepDisposer(installMemoryRecovery(ctx, undefined))
    keepDisposer(installEngineRecovery(ctx, undefined))
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
  return dispose
}
