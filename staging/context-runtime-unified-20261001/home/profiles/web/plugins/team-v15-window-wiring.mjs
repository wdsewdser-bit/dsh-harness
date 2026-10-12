// team-v15-window-wiring — connects the durable window (W2) executor to a running host.
//
// Three jobs, in order of importance:
//  1. Protection. A session whose journal already holds a committed window (or an unresolved intent) must not send
//     a request until this process has a healthy install for it and that install is recovered to clean: without it
//     the request would carry a historical checkpoint and no current authority, silently. Until then its steps are
//     refused. This job runs whatever the scope setting is, because turning the feature off must not strip
//     protection from sessions that already used it. It also runs before the services folding needs are bound, and
//     a guard that cannot answer refuses rather than lets the request through.
//  2. Handover. After a hot reload of the window modules, or a rebuilt projection service, the old install is
//     released and a new one made at the session's next idle boundary.
//  3. Folding. Only for sessions inside the configured scope: the compaction plugin asks `tryFold` before it folds,
//     and a window is committed when the fold rule chooses one. Every refusal falls back to compaction.
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { controlPlaneForMember } from './team-control-plane.mjs'
import { certificateStillValid, issueProcessCertificate, sessionHasWindowState } from './team-v15-window-install.mjs'
import { createWindowExecutor } from './team-v15-window-executor.mjs'

export const name = 'team-v15-window-wiring'
// Declared empty on purpose: a static inject on a service this composition does not provide leaves the entry
// pending. The services are bound through the callback form below instead.
export const inject = []

const SERVICES = ['agents', 'agentTeams', 'sessions', 'sessionQuery', 'teamIdentityRuntime', 'requestMessageProjection',
  'teamWindowRuntime', 'sessionPersistence']
const FOLD_SERVICE = Symbol.for('dsh.window.fold.v1')
const RETRY_FALLBACK_MS = 30000
const text = value => typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
const safely = (fn, fallback) => { try { return fn() } catch { return fallback } }

/** Which sessions may be folded with a window. Protection of existing windows does not depend on this. */
export function windowScope(config, teams) {
  const mode = ['list', 'team-roots'].includes(config?.scope) && config?.enabled === true ? config.scope : 'off'
  const listed = new Set(Array.isArray(config?.sessions) ? config.sessions.map(String) : [])
  // A list may also name workspace folders: the Team roots working in them are in scope without their session ids
  // having to be known (and the host restarted) first.
  const folder = value => String(value ?? '').replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  const workspaces = (Array.isArray(config?.workspaces) ? config.workspaces : []).map(folder).filter(Boolean)
  const isRoot = (agent, sessionId) => {
    const member = safely(() => teams?.tryMembership?.(agent), undefined)
    return member !== undefined && Number(member.tier ?? 0) === 0 && member.root === agent && agent.id === sessionId
  }
  return agent => {
    const sessionId = text(agent?.session?.id)
    if (mode === 'off' || sessionId === null) return false
    if (mode === 'list') {
      if (listed.has(sessionId)) return true
      const cwd = folder(agent.session?.header?.cwd ?? agent.session?.cwd)
      return cwd.length > 0 && workspaces.some(root => cwd === root || cwd.startsWith(root + '/')) && isRoot(agent, sessionId)
    }
    return isRoot(agent, sessionId)
  }
}

export function apply(ctx, config = {}) {
  const disposers = []
  let disposed = false
  const logger = ctx.logger
  const logFile = text(config.logFile)
  // One line per decision or refusal. Never throws; capped so a loop cannot fill the disk.
  const note = row => {
    if (logFile === null) return
    try {
      if (existsSync(logFile) && statSync(logFile).size >= 5 * 1024 * 1024) return
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, JSON.stringify({ version: 1, at: new Date().toISOString(), ...row }) + '\n')
    } catch { /* best effort */ }
  }
  const keyOf = agent => String(agent?.session?.id ?? '')
  const queued = (agent, message) => agent?.inbox?.nextStep?.includes?.(message) === true || agent?.inbox?.nextTurn?.includes?.(message) === true
  // With the native bridge send() is asynchronous; an unhandled rejection there could take the whole host down.
  const sendQuietly = (agent, message, target, wake, label) => {
    const failed = error => note({ kind: 'send-failed', sessionId: keyOf(agent), label, reason: String(error?.code ?? error?.message ?? error).slice(0, 200) })
    try { Promise.resolve(agent.send(message, target, wake)).catch(failed) } catch (error) { failed(error) }
  }

  // --- 1. Protection -------------------------------------------------------------------------------------------
  // The executor exists once the services folding needs are bound. Until then, and whenever it cannot answer, the
  // session's own journal decides: window state present means the step is refused.
  let executor = null, attend = () => {}
  const journal = new WeakMap()
  const journalHasWindow = agent => {
    const session = agent?.session
    if (!session) return false
    if (!journal.has(session)) {
      const state = safely(() => sessionHasWindowState(session), null)
      if (state === null) return false
      journal.set(session, state.committed || state.needsRecover)
    }
    return journal.get(session)
  }
  const guardReason = agent => {
    if (executor === null) return journalHasWindow(agent) ? 'window-guard:wiring-not-started' : null
    try { return executor.guardStep(agent) } catch { return journalHasWindow(agent) ? 'window-guard:guard-failed' : null }
  }
  // Sessions refused at least once; they are woken when their window is back.
  const guarded = new Set()
  const guard = async ({ agent, messages }, next) => {
    const reason = guardReason(agent)
    if (reason === null) return next()
    const key = keyOf(agent)
    // Without the native bridge the claim already took these out of the inbox. They go straight back, in order, so
    // nothing lives only in this plugin's memory across a reload or a restart. A refused turn ends idle and only a
    // new wake starts another, so this cannot spin.
    let returned = 0
    for (const message of [...(Array.isArray(messages) ? messages : [])].reverse()) {
      if (queued(agent, message)) continue
      try { agent.inbox.splice('next-step', 0, 0, [message]); returned++ } catch { /* already pending, or the inbox went with the agent */ }
    }
    guarded.add(key)
    note({ kind: 'guard', sessionId: key, reason, returnedMessages: returned })
    logger?.warn?.(`window guard refused a step of ${key}: ${reason}`)
    return { kind: 'reject', reason: reason + ': this session has a committed context window that is not restored in this process yet; the step was not sent' }
  }
  const on = (host, event, handler, options) => { const stop = safely(() => host.on(event, handler, options), undefined); if (typeof stop === 'function') disposers.push(stop) }
  const bind = (names, callback) => {
    if (typeof ctx.inject === 'function') { const stop = safely(() => ctx.inject(names, callback), undefined); if (typeof stop === 'function') disposers.push(stop) }
    else callback(ctx)
  }
  bind(['agents'], host => { on(host, 'agent/pre-step', guard, { global: true, prepend: true }) })

  // --- 2 and 3. Handover and folding ---------------------------------------------------------------------------
  const start = scoped => {
    const teams = safely(() => scoped.get('agentTeams'), undefined)
    const inScope = windowScope(config, teams)
    const certificates = new Map()
    // One certificate per route, re-issued as soon as the loaded window modules are no longer the ones it names.
    const certificateFor = agent => {
      const provider = text(agent?.options?.provider), model = text(agent?.options?.model)
      if (provider === null || model === null) return null
      const key = provider + '/' + model, cached = certificates.get(key)
      if (cached && certificateStillValid(cached)) return cached
      const issued = safely(() => issueProcessCertificate({ route: { provider, model },
        ...(config.expectedModules ? { expectedModules: config.expectedModules } : {}) }), null)
      if (issued) certificates.set(key, issued); else certificates.delete(key)
      return issued
    }
    // The plan a session's window is bound to: the Team's registered delivery contract when it has exactly one.
    // Most Teams register none; their window cites the published projection of their approved task plans instead
    // (team-v15-window-plan.mjs), unless the host turned that off.
    const planIdFor = agent => safely(() => {
      const control = controlPlaneForMember(scoped, agent, { directory: config.controlDirectory })
      const plans = Object.keys(control.snapshot({ history: false, copy: false })?.v15PlanDelivery?.plans ?? {})
      return plans.length === 1 ? plans[0] : undefined
    }, undefined)
    executor = (config.createExecutor ?? createWindowExecutor)(scoped, {
      certificate: certificateFor, planIdFor,
      routeFor: agent => ({ provider: agent.options.provider, model: agent.options.model, protocol: text(config.protocol) ?? 'deepseek-dsh-v1' }),
      allowedRoots: config.allowedRoots, recoveryDirectory: config.recoveryDirectory, controlDirectory: config.controlDirectory,
      settings: config.settings, maxArtifacts: config.maxArtifacts, logger,
      // The conversation left after a fold is bounded by the model window (the budget admission enforces that), not
      // by the small number the isolated trials used. The authority message keeps its own, small bound.
      maxRequestBytes: Number.isSafeInteger(config.maxRequestBytes) && config.maxRequestBytes > 0 ? config.maxRequestBytes : 16 * 1024 * 1024,
      ...(Number.isSafeInteger(config.maxAuthorityBytes) && config.maxAuthorityBytes > 0 ? { maxAuthorityBytes: config.maxAuthorityBytes } : {}),
      planProjection: config.planProjection !== false,
      // Other members' lossy folds are reported in the checkpoint, not allowed to block the root's window for good.
      peerCompactionDebt: config.peerCompactionDebt === 'block' ? 'block' : 'report',
      // Settled Team history is cited by count and hash; only what is still in force is carried as text.
      authorityDetail: config.authorityDetail === 'full' ? 'full' : 'live',
      // A fold has to free at least this share of the request, counting what it adds to every later request.
      minReductionRatio: Number.isFinite(config.minReductionRatio) ? config.minReductionRatio : 0.25,
      spanMode: config.spanMode ?? 'single',
      // The exact copy of one completed turn that a fold keeps. Real working turns are tens of MB.
      maxRecoveryBytes: Number.isSafeInteger(config.maxRecoveryBytes) && config.maxRecoveryBytes > 0 ? config.maxRecoveryBytes : 128 * 1024 * 1024,
      onDecision: decision => note({ kind: 'fold', ...decision }),
    })
    const mine = executor
    disposers.push(() => { if (executor === mine) executor = null })

    const attending = new Set()
    const timers = new Map()
    disposers.push(() => { for (const timer of timers.values()) clearTimeout(timer); timers.clear() })
    const release = agent => {
      if (!guarded.delete(keyOf(agent)) || agent.status !== 'idle') return
      sendQuietly(agent, createUserMessage({
        content: [{ type: 'text', text: '[window guard] Your previous step was held back while this session\'s context window was being'
          + ' restored after a restart or reload. It is restored now; continue from the current authority message.' }],
        source: { kind: 'team-message', plugin: name, form: 'notice', summary: 'window guard released' },
      }), 'next-turn', true, 'guard-released')
    }
    // A session that needs its window back does not wait for somebody to wake it: the next idle event may never come.
    const retryLater = (agent, retryAt) => {
      const key = keyOf(agent)
      if (disposed || timers.has(key)) return
      const delay = Math.max(1000, Number.isFinite(retryAt) ? retryAt - Date.now() + 50 : RETRY_FALLBACK_MS)
      const timer = setTimeout(() => { timers.delete(key); void attend(agent) }, delay)
      timer.unref?.()
      timers.set(key, timer)
    }
    // After a summary fold the conversation of a windowed session has no checkpoint left to refer to, and every
    // request would have to carry the whole current authority. One baseline message, queued without a wake, goes
    // into the conversation with the next step; from then on requests state only what changed since.
    const rebased = new Map()
    const rebase = agent => {
      if (disposed || agent.status !== 'idle') return
      const key = keyOf(agent)
      const queuedAlready = [...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])].some(message => message?.source?.nativeWindowBaseline)
      if (queuedAlready) return
      const view = safely(() => mine.missingBaseline?.(agent), null)
      if (!view || rebased.get(key) === view.checkpointId) return
      rebased.set(key, view.checkpointId)
      sendQuietly(agent, createUserMessage({
        content: [{ type: 'text', text: JSON.stringify({ kind: 'window-authority-baseline', authoritative: false, currentAuthorityRequired: true,
          note: 'Team state as of this message. Later current-authority messages state what changed since.', checkpoint: view }) }],
        source: { kind: 'team-message', plugin: name, form: 'notice', summary: 'window authority baseline',
          nativeWindowBaseline: { checkpointId: view.checkpointId, authority: view.authority } },
      }), 'next-step', false, 'authority-baseline')
      note({ kind: 'baseline', sessionId: key, checkpointId: view.checkpointId, bytes: Buffer.byteLength(JSON.stringify(view)) })
    }
    // Bring a session with window state to a healthy, clean install. Only at an idle boundary: recovery needs it.
    attend = async agent => {
      const key = keyOf(agent)
      if (disposed || key.length === 0 || attending.has(key)) return
      const state = safely(() => mine.state(agent), null)
      if (state === null || (state.reason === 'window-state-absent' && !guarded.has(key))) return
      if (state.healthy && !state.needsRecover) { release(agent); rebase(agent); return }
      if (agent.status !== 'idle') return
      attending.add(key)
      try {
        const installed = await mine.ensureInstalled(agent)
        if (!installed.ok) {
          note({ kind: 'attend', sessionId: key, outcome: 'install-failed', reason: installed.reason })
          // Only a session that is being refused needs the retry; anything else just keeps folding by compaction.
          if (guardReason(agent) !== null) {
            logger?.warn?.(`window of ${key} is not restored (${installed.reason}); its steps stay refused, retrying`)
            retryLater(agent, installed.retryAt)
          }
          return
        }
        const recovered = await mine.recoverIfNeeded(agent)
        note({ kind: 'attend', sessionId: key, outcome: recovered.state, reason: recovered.reason ?? null })
        if (guardReason(agent) === null) release(agent)
        else retryLater(agent)
      } catch (error) {
        note({ kind: 'attend', sessionId: key, outcome: 'error', reason: String(error?.code ?? error?.message ?? error).slice(0, 200) })
        if (guardReason(agent) !== null) retryLater(agent)
      } finally { attending.delete(key) }
    }

    on(scoped, 'agent/status', ({ agent, status }) => { if (status === 'idle') void attend(agent) }, { global: true })
    on(scoped, 'agent/created', ({ agent }) => { void attend(agent) }, { global: true })
    on(scoped, 'agent/disposed', ({ agent }) => { guarded.delete(keyOf(agent)); safely(() => mine.forget(agent)) }, { global: true })
    for (const agent of safely(() => scoped.get('agents').list(), []) ?? []) void attend(agent)

    // The compaction plugin lives in another plugin instance; a process-level handle is the one thing both can see.
    const fold = Object.freeze({
      async tryFold(agent, facts) {
        if (disposed || !inScope(agent)) return { outcome: 'fallback', reason: 'window-scope' }
        return mine.tryFold(agent, facts)
      },
      // A summary fold just made room; a window that had given up on this session may be asked again.
      resetDemand: agent => safely(() => mine.resetDemand?.(agent), undefined),
      inScope, state: agent => mine.state(agent),
    })
    globalThis[FOLD_SERVICE] = fold
    disposers.push(() => { if (globalThis[FOLD_SERVICE] === fold) delete globalThis[FOLD_SERVICE] })

    // The operator's own channel: a command runs against the session without a model turn. `/window` reports the
    // session's window state; `/window fold` folds it now, for a session inside the scope only.
    const registerCommand = host => {
      const commands = safely(() => host.get?.('commands') ?? host.commands, undefined)
      if (typeof commands?.register !== 'function') return undefined
      return commands.register({
        name: 'window', description: 'Durable context window: status, or fold this session now', input: { hint: '<status|fold>' }, recordInput: false,
        handler: async ({ agent, rawInput }) => {
          const verb = String(rawInput ?? '').trim().split(/\s+/)[0] || 'status'
          if (verb === 'status') return { kind: 'success', text: 'window ' + JSON.stringify({ inScope: inScope(agent), ...safely(() => mine.state(agent), {}) }) }
          if (verb !== 'fold') return { kind: 'error', text: 'usage: /window <status|fold>' }
          if (disposed || !inScope(agent)) return { kind: 'error', text: 'window fold refused: this session is outside the configured window scope' }
          const result = await mine.tryFold(agent, { safeBoundary: true, now: Date.now() }, { manual: true })
          note({ kind: 'manual-fold', sessionId: keyOf(agent), outcome: result?.outcome ?? null, reason: result?.reason ?? null })
          return result?.outcome === 'folded'
            ? { kind: 'success', text: 'window folded: ' + JSON.stringify({ state: result.receipt?.state ?? null, toWindowId: result.receipt?.toWindowId ?? null }) }
            : { kind: 'error', text: 'window fold refused: ' + String(result?.reason ?? 'unknown') + (result?.detail ? ' ' + JSON.stringify(result.detail) : '') }
        },
      })
    }
    if (typeof scoped.inject === 'function') {
      const stop = safely(() => scoped.inject(['commands'], host => {
        const unregister = safely(() => registerCommand(host), undefined)
        return typeof unregister === 'function' ? unregister : undefined
      }), undefined)
      if (typeof stop === 'function') disposers.push(stop)
    } else {
      const unregister = safely(() => registerCommand(scoped), undefined)
      if (typeof unregister === 'function') disposers.push(unregister)
    }
    note({ kind: 'started', scope: config.enabled === true ? config.scope ?? 'off' : 'off' })
  }
  bind(SERVICES, start)

  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const stop of disposers.splice(0).reverse()) safely(stop)
  }
  if (typeof ctx.effect === 'function') safely(() => ctx.effect(() => dispose))
  return dispose
}

// The loaded-code certificate reads this module's own source hash from here (see team-v15-window-loaded.mjs).
import { registerLoadedModule } from './team-v15-window-loaded.mjs'
registerLoadedModule(import.meta.url)
