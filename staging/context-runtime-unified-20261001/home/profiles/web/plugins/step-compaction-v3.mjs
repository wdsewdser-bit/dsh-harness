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
 * and the idle transition is what fires it. Context pressure is a separate hard gate:
 * it refuses the next step, but it never compacts without an armed milestone.
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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { consumeMilestoneCompaction, markCompacted, milestoneScope, pendingMilestoneCompaction, pruneStaleMilestoneCompactions, shouldCompact } from './team-milestone-v2.mjs'

export const name = 'step-compaction'

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
  reservedOutputTokens: 32768,
  safetyMarginTokens: 8192,
  enablePreStep: false,
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
  const measured = meter.measure(agent.session)
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
  const measured = meter.measure(agent.session)
  const tokens = measured === null || measured === undefined ? undefined : measured.totalTokens
  if (typeof tokens !== 'number') return 'no-measurement'
  // A ticked milestone is represented by an independent pending job, because the
  // current milestone record may already have been replaced by the next stage.
  // pendingMilestoneCompaction() checks that the job still matches the live
  // revision; a stale job can never fold a newer milestone.
  const pending = pendingMilestoneCompaction(teamScope, name)
  const ratio = tokens / cfg.windowTokens
  const verdict = pending === undefined
    ? shouldCompact(teamScope.members[name], ratio, pressureRatioOf(cfg))
    : { yes: true, reason: pending.reason ?? 'milestone', ratio }
  if (verdict.yes !== true) return 'nothing-armed'
  const milestoneSetAt = pending?.milestoneSetAt ?? teamScope.members[name]?.setAt
  if (verdict.reason === 'milestone' && typeof milestoneSetAt !== 'number') return 'nothing-armed'
  const prior = teamScope.compactions[name]
  const priorAge = Date.now() - Number(prior?.updatedAt ?? 0)
  if (prior?.status === 'retryable' && priorAge < 5 * 60 * 1000) return 'pressure-cooldown'
  if (prior?.status === 'compacted' && priorAge < 60 * 1000) return 'pressure-cooldown'
  markPending(teamScope, name, 'compacting', {
    reason: verdict.reason,
    requestedAt: pending?.requestedAt ?? Date.now(),
    tokens,
    ...milestoneSetAt === undefined ? {} : { milestoneSetAt },
  })
  writeDoc(cfg.milestonePath, doc)
  const engine = engineOf(ctx, agent, injected)
  if (engine !== undefined && typeof engine.compactNow === 'function') {
    try {
      // An idle transition with queued work still throws busy; skipping rather than
      // queueing is deliberate, so a wake-up is never blocked behind a summarization.
      const folded = await engine.compactNow(agent, signal, undefined)
      if (verdict.reason === 'milestone') {
        markCompacted(teamScope, name, Date.now(), milestoneSetAt)
        consumeMilestoneCompaction(teamScope, name, Date.now(), milestoneSetAt)
        markPending(teamScope, name, 'compacted', { reason: 'milestone', completedAt: Date.now() })
      } else {
        markPending(teamScope, name, 'compacted', { reason: 'pressure', completedAt: Date.now() })
      }
      writeDoc(cfg.milestonePath, doc)
      return 'folded:' + verdict.reason + ':' + (folded === null ? 'no-range' : 'committed')
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
  if (commands === undefined || typeof commands.execute !== 'function') return 'no-compaction-service'
  let settled
  try {
    settled = await commands.execute(agent, '/compact', [], signal)
  } catch (error) {
    markPending(teamScope, name, 'retryable', { lastError: String(error?.message ?? error) })
    writeDoc(cfg.milestonePath, doc)
    return 'skipped: ' + ((error && error.message) || String(error)).slice(0, 120)
  }
  if (settled === void 0) return 'no-compact-command'
  const result = settled !== null && typeof settled === 'object' && settled.result !== void 0 ? settled.result : settled
  if (result !== null && typeof result === 'object' && result.kind === 'error') {
    markPending(teamScope, name, 'retryable', { lastError: String(result.text === void 0 ? 'compact failed' : result.text) })
    writeDoc(cfg.milestonePath, doc)
    return 'skipped: ' + String(result.text === void 0 ? 'compact failed' : result.text).slice(0, 120)
  }
  if (verdict.reason === 'milestone') {
    markCompacted(teamScope, name, Date.now(), milestoneSetAt)
    consumeMilestoneCompaction(teamScope, name, Date.now(), milestoneSetAt)
    markPending(teamScope, name, 'compacted', { reason: 'milestone', completedAt: Date.now() })
  } else {
    markPending(teamScope, name, 'compacted', { reason: 'pressure', completedAt: Date.now() })
  }
  writeDoc(cfg.milestonePath, doc)
  return 'folded:' + verdict.reason
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
    })
    return
  }
  install(ctx, undefined)
  installBudget(ctx, undefined)
}
