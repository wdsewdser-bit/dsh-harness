import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServerWindowCollector } from './team-v15-window-collector.mjs'
import { createServerWindowSurface } from './team-v15-window-surface.mjs'
import { proveCompletedReasoningSpan } from './team-v15-window-protocol.mjs'
import { windowHash } from './team-v15-window-checkpoint.mjs'
import { loadedModuleHash } from './team-v15-window-loaded.mjs'
import { controlPlaneForMember } from './team-control-plane.mjs'
import { publishWindowPlan } from './team-v15-window-plan.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const here = dirname(fileURLToPath(import.meta.url))
// Everything a commit's correctness rests on. Hashing it at process start makes an in-process
// certificate that a later HMR rewrite invalidates, without any wall-clock expiry: a rewritten
// window, runtime or persistence module could change what a checkpoint means.
const PLUGIN_MODULES = Object.freeze([
  'team-v15-window-projection.mjs', 'team-v15-window-protocol.mjs', 'team-v15-window-collector.mjs',
  'team-v15-window-surface.mjs', 'team-v15-window-transition.mjs', 'team-v15-window-participation.mjs',
  'team-v15-window-checkpoint.mjs', 'request-message-projection.mjs', 'team-v15-window-install.mjs',
  'team-v15-window-manager.mjs', 'team-v15-window-wiring.mjs', 'team-v15-window-executor.mjs', 'team-v15-window-file-protection.mjs', 'team-v15-window-decision.mjs', 'team-v15-window-plan.mjs',
  'team-control-plane.mjs', 'team-v12-runtime.mjs', 'team-v15-plan-registry.mjs', 'team-v14-durable-store.mjs',
])
// Native packages are hashed by their path relative to the plugin directory, so the certificate covers
// the journal, barrier and agent-loop implementations the checkpoint semantics depend on.
const NATIVE_MODULES = Object.freeze([
  '../../../../app/node_modules/@deepseek-ai/dsh-session/lib/index.js',
  '../../../../app/node_modules/@deepseek-ai/dsh-session/lib/native-bridge.js',
  '../../../../app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js',
  '../../../../app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/window-barrier.js',
  '../../../../app/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js',
])
const MODULE_FILES = Object.freeze([
  ...PLUGIN_MODULES.map(name => ({ name, path: name })),
  ...NATIVE_MODULES.map(path => ({ name: path, path })),
])
const freezeFail = code => { throw Object.assign(new Error(code), { code }) }
const diskHash = (moduleDirectory, module) => sha(readFileSync(join(moduleDirectory, module.path)))
// Native packages are never hot-reloaded, so what was on disk when this process first looked is what is loaded.
const nativeAtStart = globalThis[Symbol.for('dsh.window.native-modules.v1')] ??= new Map()
// In the running process (the default directory) a plugin module is identified by the source it was loaded from, so
// a file that was saved but not reloaded does not change the answer. A caller that names another directory (a
// deploy tool, a test mirror) is asking about files and gets the disk.
const readModuleHashes = moduleDirectory => Object.fromEntries(MODULE_FILES.map(module => {
  if (moduleDirectory !== here) return [module.name, diskHash(moduleDirectory, module)]
  if (module.path.startsWith('..')) {
    if (!nativeAtStart.has(module.name)) nativeAtStart.set(module.name, diskHash(here, module))
    return [module.name, nativeAtStart.get(module.name)]
  }
  return [module.name, loadedModuleHash(module.name) ?? diskHash(here, module)]
}))

export function certificateModuleFiles() { return MODULE_FILES.map(module => module.name) }

export function issueProcessCertificate({ route, moduleDirectory = here, expectedModules } = {}) {
  if (!route || typeof route.provider !== 'string' || typeof route.model !== 'string') freezeFail('WINDOW_CERTIFICATE_ROUTE_REQUIRED')
  const modules = readModuleHashes(moduleDirectory)
  if (expectedModules !== undefined) {
    // Optional strict mode. A published manifest pins the reviewed files; any missing or differing entry
    // means the running tree is not the reviewed one, so no certificate is issued. Off by default: an
    // operator who edits plugins live would otherwise lose the window fold on every save.
    const expected = new Map(Object.entries(expectedModules ?? {}).map(([name, value]) => [name.toLowerCase(), value]))
    const mismatched = MODULE_FILES.map(module => module.name)
      .filter(name => expected.get(name.toLowerCase()) !== modules[name])
    if (mismatched.length) throw Object.assign(new Error('WINDOW_CERTIFICATE_MODULE_MISMATCH'),
      { code: 'WINDOW_CERTIFICATE_MODULE_MISMATCH', mismatched })
  }
  const body = { kind: 'in-process-protocol-v1', route: { provider: route.provider, model: route.model, api: route.api }, modules }
  return Object.freeze({ ...body, certificateHash: windowHash(body) })
}

export function certificateStillValid(certificate, { moduleDirectory = here } = {}) {
  if (certificate?.kind !== 'in-process-protocol-v1' || typeof certificate.modules !== 'object' || certificate.modules === null) return false
  let current
  try { current = readModuleHashes(moduleDirectory) } catch { return false }
  const names = Object.keys(current)
  if (names.length !== MODULE_FILES.length) return false
  return names.every(name => certificate.modules[name] === current[name])
}

// Durable recollection only: a commit is a `user/message` whose source carries windowCommit; an intent
// is an unresolved window until an abort or (per the transition constructor) still active even after a
// commit, so needsRecover mirrors that constructor exactly rather than "committed or pending".
export function sessionHasWindowState(session) {
  if (typeof session?.snapshotEvents !== 'function') freezeFail('WINDOW_SESSION_LOG_UNAVAILABLE')
  const events = session.snapshotEvents()
  const committed = [], intents = [], aborted = new Set()
  for (const event of events) {
    const commit = event.type === 'user/message' ? event.data?.source?.windowCommit : undefined
    if (commit) committed.push(commit.transitionId ?? null)
    if (event.type === 'native/window-intent') intents.push(event.data)
    if (event.type === 'native/window-aborted') aborted.add(event.data?.transitionId ?? null)
  }
  const done = new Set([...committed, ...aborted])
  return { committed: committed.length > 0, pending: intents.some(intent => !done.has(intent?.transitionId ?? null)),
    needsRecover: intents.findLast(intent => !aborted.has(intent?.transitionId ?? null)) !== undefined }
}

/** Per-session W2 install. One collector per session because sessionIds / planBindings /
 * protocolCertificateHash freeze into its configFingerprint at construction, and the collector
 * apply() can only own a single fixed service name. */
export async function installSessionWindow(ctx, { agent, planId, certificate, allowedRoots, recoveryDirectory, controlDirectory, maxArtifacts = 2048,
  recentMessages, routeFor, moduleDirectory = here, clock = Date.now, routeTtlMs = 300000, onDecision, fault,
  participationRetries = 5, participationRetryDelayMs = 200, expose, planProjection = false, peerCompactionDebt,
  maxRequestBytes, maxAuthorityBytes, authorityDetail, maxRecoveryBytes, minReductionRatio, spanMode } = {}) {
  if (!agent?.session || (typeof planId !== 'string' && planProjection !== true) || typeof routeFor !== 'function') freezeFail('WINDOW_INSTALL_INPUT_REQUIRED')
  const runtime = ctx.get('teamWindowRuntime')
  const sessionId = agent.session.id
  // controlDirectory must be the same control plane the team runtime writes, or the collector's actor()
  // resolves membership against a different file and refuses the session.
  // Without a registered contract the window cites the published projection of the Team's approved task plans.
  // It is published here and again before every commit, never in between, so the plan a window is bound to only
  // moves at a fold boundary.
  const projected = typeof planId !== 'string'
  const publishPlan = async () => {
    if (!projected) return
    const control = controlPlaneForMember(ctx, agent, { directory: controlDirectory })
    if (!control) freezeFail('WINDOW_PLAN_CONTROL_UNAVAILABLE')
    await publishWindowPlan(control, agent, { now: clock })
  }
  await publishPlan()
  // Everything from here to the native bridge going under the session is synchronous. A wake-up that arrived while
  // the plan was being published means a turn is running now, and the bridge must not appear under it.
  if (agent.phase !== undefined && agent.phase?.kind !== 'idle') freezeFail('WINDOW_INSTALL_NOT_IDLE')
  const collector = createServerWindowCollector(ctx, { isolated: true, sessionIds: [sessionId],
    planBindings: projected ? {} : { [sessionId]: planId }, ...(projected ? { planProjection: true } : {}),
    ...(peerCompactionDebt === undefined ? {} : { peerCompactionDebt }), ...(authorityDetail === undefined ? {} : { authorityDetail }),
    ...(maxRecoveryBytes === undefined ? {} : { maxRecoveryBytes }),
    ...(spanMode === undefined ? {} : { spanMode }),
    allowedRoots, recoveryDirectory, controlDirectory, maxArtifacts, ...(recentMessages === undefined ? {} : { recentMessages }),
    protocolCertificateHash: certificate?.certificateHash })
  const projection = ctx.get('requestMessageProjection')
  // Other sessions share this projection service; only our own session may enter the collector, so a
  // foreign dispatch returns the caller's messages untouched and never reaches the audit ring.
  const projectFor = options => options?.sessionId !== sessionId ? { messages: options.messages } : collector.project(options)
  const dispatchFor = ({ result, receipt }) => receipt?.sessionId !== sessionId ? undefined : collector.onDispatch({ result, receipt })
  const routes = []
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  let surface, unregister
  try {
    // capture() resolves plan, identity and root membership against the control plane, not the
    // admission list, so it runs before admit and fails an unusable install before anything is registered.
    collector.authorityForSurface(sessionId).capture(sessionId)
    runtime?.admit(agent)
    unregister = projection.register('team-v15-window-collector:' + sessionId, projectFor,
      { order: 4, preview: projectFor, onDispatch: dispatchFor })
    // surface validates the participation certificate (and builds the transition) before it registers
    // its admission projection, so a WINDOW_PARTICIPATION_UNVERIFIED construction leaves nothing
    // registered and is safe to retry against a live writer.
    for (let attempt = 0; ; attempt++) {
      try { surface = await createServerWindowSurface(ctx, { collector, sessionId, routes, proveReasoningSpan: proveCompletedReasoningSpan,
        clock, onDecision, ...(fault ? { fault } : {}), ...(maxRequestBytes === undefined ? {} : { maxRequestBytes }), ...(minReductionRatio === undefined ? {} : { minReductionRatio }),
        ...(maxAuthorityBytes === undefined ? {} : { maxPayloadBytes: maxAuthorityBytes }) }); break }
      catch (error) {
        if (error?.code !== 'WINDOW_PARTICIPATION_UNVERIFIED' || attempt >= participationRetries) throw error
        await sleep(participationRetryDelayMs)
      }
    }
  } catch (error) {
    // Unwind in reverse: a half install must not leave an admitted session or a live projection behind.
    try { unregister?.() } catch {}
    try { runtime?.revoke(agent) } catch {}
    throw error
  }
  expose?.({ surface, collector, routes })

  const sourceFingerprint = () => collector.authorityForSurface(sessionId).capture(sessionId).source.configFingerprint
  function refreshRoute() {
    // Validity is rechecked here rather than in commit: the route is what a stale certificate would
    // otherwise certify, and every commit reissues it.
    if (!certificateStillValid(certificate, { moduleDirectory })) freezeFail('WINDOW_CERTIFICATE_STALE')
    const route = routeFor(agent), cert = certificate.route
    if (!route || route.provider !== cert.provider || route.model !== cert.model
      || (cert.api !== undefined && route.api !== cert.api)) freezeFail('WINDOW_CERTIFICATE_ROUTE_MISMATCH')
    if (typeof route.protocol !== 'string' || !route.protocol) freezeFail('WINDOW_ROUTE_PROTOCOL_REQUIRED')
    routes[0] = Object.freeze({ provider: route.provider, model: route.model, protocol: route.protocol,
      certificateHash: certificate.certificateHash, configFingerprint: sourceFingerprint(),
      expiresAt: clock() + routeTtlMs, reasoningPolicy: 'whole-completed-turn-v1' })
    return routes[0]
  }
  return Object.freeze({
    sessionId, certificateHash: certificate.certificateHash,
    needsRecover: () => surface.status().paused,
    async commit() {
      // Recovery needs runMaintenance and an idle agent; a request boundary may not do it, so a fenced
      // session refuses until its owner recovers explicitly.
      if (surface.status().paused) freezeFail('WINDOW_RECOVERY_REQUIRED')
      await publishPlan()
      await collector.retainCompletedTurns(sessionId)
      refreshRoute()
      return surface.commit()
    },
    refreshRoute,
    async recover({ attempts = 5, delayMs = 200 } = {}) {
      const states = []
      let retries = 0
      // recover() settles one journal state per call; an aborted or committed window still needs a
      // second pass to become clean. Participation-unverified is a transient busy host, so it is
      // retried in bounds instead of turning a live writer into a hard failure.
      for (let pass = 0; pass < attempts + 4; pass++) {
        try {
          const result = await surface.recover()
          states.push(result.state)
          if (result.state === 'clean') return states
        } catch (error) {
          if (error?.code === 'WINDOW_PARTICIPATION_UNVERIFIED' && retries < attempts) { retries++; await sleep(delayMs); continue }
          throw error
        }
      }
      freezeFail('WINDOW_RECOVERY_NOT_SETTLED')
    },
    status: () => surface.status(),
    missingBaseline: () => surface.missingBaseline(),
    attempts: () => surface.attempts(),
    resetDemand: () => surface.resetDemand(),
    // A hot reload of the plugin that made this install disposes its context; every service read through it then
    // throws, so this install can no longer capture or commit anything. The executor asks before trusting it.
    alive() { try { ctx.agents.list(); return true } catch { return false } },
    dispose({ handover = false } = {}) {
      // A handover has to work from exactly that dead context, so it reads no service.
      if (handover) {
        unregister(); surface.dispose({ handover: true })
        try { runtime?.revoke(agent) } catch { /* the runtime went with the context; the new install admits again */ }
        return { kept: false }
      }
      const status = surface.status()
      if (!ctx.agents.list().includes(agent)) {
        unregister(); surface.dispose({ handover: true }); runtime?.revoke(agent)
        return { kept: false }
      }
      // A committed window is current authority for later requests; tearing it down here would strand
      // them. Keep the install (and its admission) alive until the session ends or a handover is asked for.
      if (status.windowId > 0 || status.paused) return { kept: true }
      unregister(); surface.dispose(); runtime?.revoke(agent)
      return { kept: false }
    },
  })
}

// The loaded-code certificate reads this module's own source hash from here (see team-v15-window-loaded.mjs).
import { registerLoadedModule } from './team-v15-window-loaded.mjs'
registerLoadedModule(import.meta.url)
