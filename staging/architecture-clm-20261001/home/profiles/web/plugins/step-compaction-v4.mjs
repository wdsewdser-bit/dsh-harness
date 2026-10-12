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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { consumeMilestoneCompaction, markCompacted, milestoneScope, pendingMilestoneCompaction, pruneStaleMilestoneCompactions, shouldCompact } from './team-milestone-v2.mjs'
import { normalizeCompactionState, recordCompactionDecision } from './team-v12-compaction.mjs'
import { evaluateShadow } from './team-v13-compaction-shadow.mjs'
import { validateCompactionAnchors } from './team-v13-compaction-anchors.mjs'
import { buildMemberRecoveryPack, captureMemberMemory } from './team-v14-memory-anchor.mjs'
import { controlPlaneForMember } from './team-control-plane.mjs'
import { measureSessionTokens } from './team-token-meter-cache.mjs'
import { observeRequestBudget } from './request-usage-ledger.mjs'

export const name = 'step-compaction'

const mirroredDecisions = new Set()

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

function compactionSummaryText(folded, settled) {
  const values = []
  if (typeof folded === 'string') values.push(folded)
  if (typeof settled === 'string') values.push(settled)
  if (settled !== null && typeof settled === 'object') {
    if (typeof settled.text === 'string') values.push(settled.text)
    if (settled.result !== undefined) values.push(compactionSummaryText(settled.result, undefined))
  }
  return values.filter((value) => typeof value === 'string' && value.length > 0).join('\n')
}

function anchorDebt(teamScope, name, pending, folded, settled, memory) {
  const validation = validateCompactionAnchors(
    compactionSummaryText(folded, settled),
    compactionAnchors(teamScope, name, pending, memory),
    { sourceStatus: memory?.sourceStatus ?? 'unavailable' },
  )
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
  /** After a pressure fold, do not fold again until this much time passes. */
  pressureCooldownMs: 10 * 60 * 1000,
  /** A pressure fold above this share is never delayed by the cooldown. */
  pressureHardRatio: 0.9,
  reservedOutputTokens: 32768,
  safetyMarginTokens: 8192,
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
export function preStepBudget(ctx, cfg, agent, inputTokens, injected) {
  const services = servicesOf(ctx, injected)
  const tokens = typeof inputTokens === 'number' ? inputTokens : tokenTotal(services.meter, agent)
  if (typeof tokens !== 'number' || !Number.isFinite(tokens)) return { ok: true, reason: 'no-measurement' }
  const window = Number(cfg.windowTokens)
  const reserved = Number(cfg.reservedOutputTokens ?? DEFAULTS.reservedOutputTokens)
  const margin = Number(cfg.safetyMarginTokens ?? DEFAULTS.safetyMarginTokens)
  if (!(window > 0)) return { ok: true, reason: 'no-window' }
  if (tokens + reserved + margin <= window) {
    return { ok: true, tokens, window, ratio: tokens / window }
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

  const engine = engineOf(ctx, agent, injected)
  if (engine !== undefined && typeof engine.compactNow === 'function') {
    try {
      // An idle transition with queued work still throws busy; skipping rather than
      // queueing is deliberate, so a wake-up is never blocked behind a summarization.
      const folded = await engine.compactNow(agent, signal, undefined)
      if (reason === 'milestone') {
        markCompacted(teamScope, name, Date.now(), milestoneSetAt)
        consumeMilestoneCompaction(teamScope, name, Date.now(), milestoneSetAt)
      }
      const validation = anchorDebt(teamScope, name, pending, folded, undefined, memory)
      markPending(teamScope, name, validation.ok ? 'compacted' : 'completed_with_debt', {
        reason,
        trigger: reason,
        ratio,
        completedAt: Date.now(),
        tokens,
        windowTokens: cfg.windowTokens,
        missingAnchors: validation.missing,
        summaryAvailable: validation.summaryAvailable,
        memoryDebt: validation.ok ? null : {
          sourceStatus: memory.sourceStatus,
          missing: validation.missing,
          recoveryPack: recoveryPack.text,
          digest: memory.digest ?? null,
        },
      })
      writeDoc(cfg.milestonePath, doc)
      injectCompactionRecoveryNotice(agent, validation.ok ? reason : reason + ':completed_with_debt', recoveryPack, {
        trigger: reason,
        ratio,
        tokens,
        windowTokens: cfg.windowTokens,
      })
      return 'folded:' + reason + ':' + (folded === null ? 'no-range' : 'committed')
        + (validation.ok ? '' : ':debt')
    } catch (error) {
      markPending(teamScope, name, 'retryable', { lastError: String(error?.message ?? error) })
      writeDoc(cfg.milestonePath, doc)
      return 'skipped: ' + ((error && error.message) || String(error)).slice(0, 120)
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
  try {
    settled = await commands.execute(agent, '/compact', [], signal)
  } catch (error) {
    markPending(teamScope, name, 'retryable', { lastError: String(error?.message ?? error) })
    writeDoc(cfg.milestonePath, doc)
    return 'skipped: ' + ((error && error.message) || String(error)).slice(0, 120)
  }
  if (settled === void 0) {
    markPending(teamScope, name, 'retryable', { lastError: 'no-compact-command' })
    writeDoc(cfg.milestonePath, doc)
    return 'no-compact-command'
  }
  const result = settled !== null && typeof settled === 'object' && settled.result !== void 0 ? settled.result : settled
  if (result !== null && typeof result === 'object' && result.kind === 'error') {
    markPending(teamScope, name, 'retryable', { lastError: String(result.text === void 0 ? 'compact failed' : result.text) })
    writeDoc(cfg.milestonePath, doc)
    return 'skipped: ' + String(result.text === void 0 ? 'compact failed' : result.text).slice(0, 120)
  }
  if (reason === 'milestone') {
    markCompacted(teamScope, name, Date.now(), milestoneSetAt)
    consumeMilestoneCompaction(teamScope, name, Date.now(), milestoneSetAt)
  }
  const validation = anchorDebt(teamScope, name, pending, undefined, settled, memory)
  markPending(teamScope, name, validation.ok ? 'compacted' : 'completed_with_debt', {
    reason,
    trigger: reason,
    ratio,
    completedAt: Date.now(),
    tokens,
    windowTokens: cfg.windowTokens,
    missingAnchors: validation.missing,
    summaryAvailable: validation.summaryAvailable,
    memoryDebt: validation.ok ? null : {
      sourceStatus: memory.sourceStatus,
      missing: validation.missing,
      recoveryPack: recoveryPack.text,
      digest: memory.digest ?? null,
    },
  })
  writeDoc(cfg.milestonePath, doc)
  injectCompactionRecoveryNotice(agent, validation.ok ? reason : reason + ':completed_with_debt', recoveryPack, {
    trigger: reason,
    ratio,
    tokens,
    windowTokens: cfg.windowTokens,
  })
  return 'folded:' + reason + (validation.ok ? '' : ':debt')
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
  const verdict = pending === undefined
    ? shouldCompact(teamScope.members[name], ratio, pressureRatio)
    : { yes: true, reason: pending.reason ?? 'milestone', ratio }
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
  const prior = teamScope.compactions[name]
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
  const result = await foldNow(ctx, cfg, agent, signal, injected, services, teamScope, name, doc, verdict.reason, tokens, ratio, milestoneSetAt, pending)
  await mirrorCompactionDecision(ctx, cfg, agent, name, {
    compact: true,
    reason: verdict.reason,
  }, tokens, result.startsWith('folded'))
  return result
}

/**
 * Install the idle-triggered fold.
 * @param ctx - plugin context carrying the agent teams, token meter and commands.
 * @param config - optional overrides for DEFAULTS plus milestonePath.
 * @returns a disposer that removes the observer, when one is installed.
 */
export function apply(ctx, config) {
  const overrides = config === null || config === undefined ? {} : config
  const cfg = Object.assign({}, DEFAULTS, overrides)
  const compactionReasoningEffort = typeof cfg.compactionReasoningEffort === 'string'
    ? cfg.compactionReasoningEffort.trim()
    : ''
  ctx.on('llm/stream', (options, next) => {
    const observation = observeRequestBudget(ctx, options)
    // These estimates are diagnostic only. preStepBudget still uses the raw meter.
    if (options?.purpose === 'compaction' && observation.requestId) {
      ctx.logger?.debug?.('[step-compaction] request budget ' + JSON.stringify(observation))
    }
    return next()
  }, { global: true })
  if (compactionReasoningEffort !== 'off') {
    ctx.logger?.info?.('[step-compaction] cache-reasoning bridge loaded')
    ctx.on('llm/stream', (options, next) => {
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
    }, { global: true, prepend: true })
  }
  // Defaulted here as well as in the tool layer: both plugins must independently agree
  // on which file holds the milestones, or the tick would arm a document nobody reads.
  if (typeof cfg.milestonePath !== 'string' || cfg.milestonePath.length === 0) {
    cfg.milestonePath = join(process.env.DSH_HOME ?? process.cwd(), 'team-milestones.json')
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
  const installBudget = (host, injected) => {
    if (cfg.enablePreStep !== true) return () => {}
    if (typeof host.on !== 'function') return () => {}
    return host.on('agent/pre-step', async ({ agent }, next) => {
      const prior = await next()
      if (prior?.kind === 'reject') return prior
      const verdict = preStepBudget(host, cfg, agent, undefined, injected)
      if (!verdict.ok) {
        if (ctx.logger !== undefined) ctx.logger.warn?.('step-compaction: refusing ' + verdict.reason + ' step for ' + String(memberName(servicesOf(host, injected).teams, agent)) + ' (ratio=' + Number(verdict.ratio ?? 0).toFixed(3) + ')')
        return { kind: 'reject' }
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
        }
      }
      return typeof next === 'function' ? next() : undefined
    }, { global: true })
  }
  // The callback form is load-bearing: a static inject on a service this composition does
  // not provide leaves the entry pending, and one pending entry refuses the whole tree.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['agentTeams', 'tokenMeter', 'commands'], (scoped) => {
      const injected = {
        teams: serviceOf(scoped, 'agentTeams'),
        meter: serviceOf(scoped, 'tokenMeter'),
        engine: serviceOf(scoped, 'compaction'),
        commands: serviceOf(scoped, 'commands'),
      }
      install(scoped, injected)
      installBudget(scoped, injected)
      installMemoryRecovery(scoped, injected)
    })
    return
  }
  install(ctx, undefined)
  installBudget(ctx, undefined)
  installMemoryRecovery(ctx, undefined)
}
