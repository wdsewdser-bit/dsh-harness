import { installSessionWindow, sessionHasWindowState } from './team-v15-window-install.mjs'
import { decideWindowAction } from './team-v15-window-decision.mjs'

// Process-level registry: a hot-reloaded wiring plugin finds here the handle that already owns the session's
// window. If that handle is still usable it is reused; if the code or the projection service under it changed, it
// is handed over (released and installed again) at the session's next idle boundary.
const installs = globalThis[Symbol.for('dsh.window.installs.v1')] ??= new Map()
// Installs in flight, at process level for the same reason: two callers (the idle pass and a fold) and two plugin
// instances (across a reload) must not install the same session twice at once.
const installing = globalThis[Symbol.for('dsh.window.installing.v1')] ??= new Map()
const recovering = globalThis[Symbol.for('dsh.window.recovering.v1')] ??= new Map()
// A failed install is retried, not remembered for ever: a session that already holds a window stays refused until
// an install succeeds, so one transient failure must not become permanent.
const INSTALL_BACKOFF_MS = Object.freeze([30000, 60000, 120000, 300000, 600000])

/** Execution layer for W2. Pure orchestration: it decides nothing about scope, only whether the
 * process can install, guard, recover and fold a session that someone else has already chosen. */
export function createWindowExecutor(ctx, options = {}) {
  const { certificate = null, planIdFor = () => undefined, routeFor, allowedRoots, recoveryDirectory,
    controlDirectory, decide = decideWindowAction, settings = {}, clock = Date.now, onDecision, logger,
    maxArtifacts, projectionOf, planProjection = false, peerCompactionDebt, maxRequestBytes, maxAuthorityBytes, authorityDetail, maxRecoveryBytes, minReductionRatio, spanMode } = options
  // Rebuilt projection service is observable only as a different instance; without the seam the executor
  // would have to guess from a service it can no longer register on.
  const currentProjection = projectionOf ?? (() => ctx.get('requestMessageProjection'))
  // The other two services an install is built on. A hot reload can replace either while the projection service
  // stays the same; an install made against the replaced one keeps failing (its identity service is disposed) and
  // must be handed over like any other stale install, not trusted because it still answers.
  const currentGeneration = () => { try { return [ctx.get('teamWindowRuntime'), ctx.get('teamIdentityRuntime')] } catch { return [undefined, undefined] } }
  const sameGeneration = entry => { const [runtime, identity] = currentGeneration(); return entry.generation === undefined || (entry.generation[0] === runtime && entry.generation[1] === identity) }
  // A function lets the owner re-issue after a hot reload; a certificate describes the code loaded right now.
  const currentCertificate = agent => typeof certificate === 'function' ? certificate(agent) : certificate
  // A session proven to have no window state stays cheap to guard: the log scan is skipped until this
  // session is installed here, which is the only thing that changes the answer.
  const noWindowState = new Set()

  const windowState = (agent, sessionId) => noWindowState.has(sessionId)
    ? { committed: false, pending: false, needsRecover: false }
    : (() => { const state = sessionHasWindowState(agent.session)
        if (!state.committed && !state.needsRecover) noWindowState.add(sessionId)
        return state })()
  const healthyEntry = agent => {
    const entry = installs.get(agent.session.id)
    // alive(): the context the install was made in may have been disposed by a hot reload.
    return entry?.handle && entry.handle.alive?.() !== false && entry.projection === currentProjection() && sameGeneration(entry) && entry.agent === agent ? entry : undefined
  }
  const emit = (sessionId, result) => {
    onDecision?.({ sessionId, outcome: result.outcome, reason: result.reason ?? null, ...(result.detail ? { detail: result.detail } : {}),
      retryable: result.retryable ?? false, toWindowId: result.receipt?.toWindowId ?? null })
    return result
  }

  return Object.freeze({
    state(agent) {
      const sessionId = agent.session.id, entry = installs.get(sessionId), healthy = healthyEntry(agent)
      if (healthy) return { sessionId, installed: true, healthy: true, needsRecover: healthy.handle.needsRecover(), reason: 'window-install-healthy' }
      const state = windowState(agent, sessionId)
      if (!entry) return { sessionId, installed: false, healthy: false, needsRecover: state.needsRecover,
        reason: state.committed || state.needsRecover ? 'window-state-uninstalled' : 'window-state-absent' }
      return { sessionId, installed: true, healthy: false, needsRecover: state.needsRecover,
        reason: entry.handle ? 'window-install-stale' : 'window-install-failed' }
    },
    guardStep(agent) {
      const sessionId = agent.session.id, healthy = healthyEntry(agent)
      if (healthy) return healthy.handle.needsRecover() ? 'window-guard:recovery-required' : null
      const state = windowState(agent, sessionId)
      if (!state.committed && !state.needsRecover) return null
      return installs.has(sessionId) ? 'window-guard:install-stale' : 'window-guard:window-state-uninstalled'
    },
    ensureInstalled(agent) {
      const sessionId = agent.session.id, running = installing.get(sessionId)
      if (running) return running
      const flight = this.installOnce(agent).finally(() => { if (installing.get(sessionId) === flight) installing.delete(sessionId) })
      installing.set(sessionId, flight)
      return flight
    },
    async installOnce(agent) {
      const sessionId = agent.session.id, entry = installs.get(sessionId)
      const issued = currentCertificate(agent)
      let failures = 0
      if (entry && !entry.handle) {
        failures = Number(entry.failures) || 1
        const retryAt = Number(entry.failedAt) + INSTALL_BACKOFF_MS[Math.min(failures, INSTALL_BACKOFF_MS.length) - 1]
        if (clock() < retryAt) return { ok: false, reason: entry.failure ?? 'window-install-failed', retryAt }
        installs.delete(sessionId)
      } else if (entry) {
        const usable = healthyEntry(agent)
        if (usable && (!issued || entry.certificateHash === issued.certificateHash)) return { ok: true, handle: entry.handle }
        // The projection service was rebuilt, or the window modules were reloaded: this handle can still protect
        // what it protects, but it cannot commit. Hand the session over, at an idle boundary only.
        if (!issued) return { ok: false, reason: usable ? 'window-certificate-unavailable' : 'window-install-stale' }
        if (agent.phase?.kind !== 'idle') return { ok: false, reason: 'window-reinstall-pending' }
        try { entry.handle.dispose({ handover: true }) }
        catch (error) { return { ok: false, reason: 'window-handover-refused:' + (error?.code ?? error?.message ?? 'unknown') } }
        installs.delete(sessionId)
      }
      if (!issued) return { ok: false, reason: 'window-certificate-unavailable' }
      // A registered delivery contract when the Team has one; otherwise, if the host allows it, the published
      // projection of the Team's approved task plans.
      const planId = planIdFor(agent)
      if (!planId && planProjection !== true) return { ok: false, reason: 'window-plan-unregistered' }
      // Installing puts the native bridge under the session; that must not happen under a running turn.
      if (agent.phase !== undefined && agent.phase?.kind !== 'idle') return { ok: false, reason: 'window-install-not-idle' }
      try {
        const handle = await installSessionWindow(ctx, { agent, ...(planId ? { planId } : { planProjection: true }), certificate: issued, allowedRoots, recoveryDirectory,
          controlDirectory, maxArtifacts, routeFor, clock, onDecision, ...(peerCompactionDebt === undefined ? {} : { peerCompactionDebt }),
          ...(maxRequestBytes === undefined ? {} : { maxRequestBytes }), ...(maxAuthorityBytes === undefined ? {} : { maxAuthorityBytes }), ...(authorityDetail === undefined ? {} : { authorityDetail }), ...(maxRecoveryBytes === undefined ? {} : { maxRecoveryBytes }), ...(minReductionRatio === undefined ? {} : { minReductionRatio }), ...(spanMode === undefined ? {} : { spanMode }) })
        noWindowState.delete(sessionId)
        installs.set(sessionId, { handle, agent, projection: currentProjection(), generation: currentGeneration(), certificateHash: issued.certificateHash, failedAt: null, failure: null })
        return { ok: true, handle }
      } catch (error) {
        const failure = error?.code ?? error?.message ?? 'unknown'
        // Lost a race with a wake-up: nothing was installed and nothing is wrong, the next idle boundary tries again.
        if (failure === 'WINDOW_INSTALL_NOT_IDLE') return { ok: false, reason: 'window-install-not-idle' }
        logger?.warn?.(`window install failed for ${sessionId} (attempt ${failures + 1}): ${failure}`)
        const failedAt = clock()
        installs.set(sessionId, { handle: null, agent, projection: null, certificateHash: null, failedAt, failure, failures: failures + 1 })
        return { ok: false, reason: failure, retryAt: failedAt + INSTALL_BACKOFF_MS[Math.min(failures + 1, INSTALL_BACKOFF_MS.length) - 1] }
      }
    },
    // One recovery per session at a time, across plugin instances: a reload can start two wiring instances within
    // milliseconds, and a second maintenance phase on the same agent is refused by the agent itself.
    recoverIfNeeded(agent) {
      const sessionId = agent.session.id, running = recovering.get(sessionId)
      if (running) return running
      const flight = (async () => {
        const healthy = healthyEntry(agent)
        if (!healthy || !healthy.handle.needsRecover()) return { state: 'not-needed' }
        // Recovery runs a maintenance phase and must not race a live turn.
        if (agent.phase?.kind !== 'idle') return { state: 'deferred' }
        try { return { state: 'recovered', states: await healthy.handle.recover() } }
        catch (error) { return { state: 'failed', reason: error?.code ?? error?.message ?? 'unknown' } }
      })().finally(() => { if (recovering.get(sessionId) === flight) recovering.delete(sessionId) })
      recovering.set(sessionId, flight)
      return flight
    },
    // `manual` is an operator asking for this fold now: the size and phase rule is skipped, nothing else is.
    async tryFold(agent, facts = {}, { manual = false } = {}) {
      const sessionId = agent.session.id
      const installed = await this.ensureInstalled(agent)
      if (!installed.ok) return emit(sessionId, { outcome: 'fallback', reason: installed.reason })
      const handle = installed.handle, attempts = handle.attempts()
      const decision = manual ? Object.freeze({ action: 'fold', reason: 'manual', mechanism: 'window' })
        : decide({ ...facts, window: { eligible: true, deferred: attempts.deferred, retryAt: attempts.notBefore } }, settings)
      if (decision.action !== 'fold' || decision.mechanism !== 'window') return emit(sessionId, { outcome: 'fallback', reason: 'rule:' + decision.reason, decision })
      // A fenced session may not commit; its owner recovers at an idle boundary first.
      if (handle.needsRecover()) return emit(sessionId, { outcome: 'fallback', reason: 'window-recovery-required', decision })
      try { return emit(sessionId, { outcome: 'folded', receipt: await handle.commit(), decision }) }
      catch (error) { return emit(sessionId, { outcome: 'fallback', reason: error?.code ?? error?.message ?? 'unknown',
        retryable: error?.retryable === true, decision, ...(error?.detail ? { detail: error.detail } : {}) }) }
    },
    // The surface stops asking for a window after repeated durable aborts; a later summary fold changes the
    // picture enough to ask again.
    // The authority a baseline message should carry for this session, or null when none is needed.
    missingBaseline(agent) {
      const healthy = healthyEntry(agent)
      if (!healthy || healthy.handle.needsRecover()) return null
      try { return healthy.handle.missingBaseline?.() ?? null } catch { return null }
    },
    resetDemand(agent) {
      const healthy = healthyEntry(agent)
      if (!healthy) return false
      healthy.handle.resetDemand()
      return true
    },
    forget(agent) {
      const sessionId = agent.session.id, entry = installs.get(sessionId)
      if (!entry?.handle) { installs.delete(sessionId); return true }
      if (ctx.agents.list().includes(agent)) {
        const status = entry.handle.status?.() ?? {}
        if (status.windowId > 0 || status.paused) return false
      }
      entry.handle.dispose()
      installs.delete(sessionId)
      return true
    },
    installs() {
      return [...installs.entries()].map(([sessionId, entry]) => ({ sessionId, healthy: !!healthyEntry(entry.agent),
        certificateHash: entry.certificateHash ?? null, failure: entry.failure ?? null }))
    },
  })
}

// The loaded-code certificate reads this module's own source hash from here (see team-v15-window-loaded.mjs).
import { registerLoadedModule } from './team-v15-window-loaded.mjs'
registerLoadedModule(import.meta.url)
