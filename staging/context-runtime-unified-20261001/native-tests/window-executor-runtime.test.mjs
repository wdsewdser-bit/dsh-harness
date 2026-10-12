import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Session, SessionStore } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { ReactLoopAgent, inboxProjectionDefinition, turnBoundaryProjectionDefinition } from '../app/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'
import Jsonl from '../app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'
import { initializeNativeHost } from './native-host-fixture.mjs'
import { controlPlaneForMember, readControlPlaneSnapshot, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { createPlanRegistry } from '../home/profiles/web/plugins/team-v15-plan-registry.mjs'
import { createActiveIdentityService } from '../home/profiles/web/plugins/team-v15-active-identity.mjs'
import { apply as applyCompactionMilestones } from '../home/profiles/web/plugins/step-compaction-v4.mjs'
import { installRequestMessageProjection } from '../home/profiles/web/plugins/request-message-projection.mjs'
import { apply as applyTeamRuntime } from '../home/profiles/web/plugins/team-v12-runtime.mjs'
import { ToolRuntime } from '../app/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
import { issueProcessCertificate } from '../home/profiles/web/plugins/team-v15-window-install.mjs'
import { createWindowExecutor } from '../home/profiles/web/plugins/team-v15-window-executor.mjs'
const require = createRequire(new URL('../app/package.json', import.meta.url))
const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)))
const { Context, Service } = await load('cordis')
const { Loader } = await load('cordis-plugin-loader')
const { SessionProjectionRegistry } = await load('dsh-session-projection')
const { AgentRegistry } = await load('dsh-agent')
const { SystemPrompt } = await load('dsh-system-prompt')
const { SessionQueryEngine } = await load('dsh-session-query')
const official = await load('dsh-llm')
const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'home', 'profiles', 'web', 'plugins')
const registry = () => globalThis[Symbol.for('dsh.window.installs.v1')]
const sha = value => createHash('sha256').update(value).digest('hex')
const message = (id, role, text) => ({ id, role, source: role === 'user' ? { kind: 'user' }
  : { kind: 'model', provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text }] })

// Copied from native-tests/window-install-runtime.test.mjs fixture and adapted for the executor.
async function fixture(t, limits = {}) {
  const root = mkdtempSync(join(tmpdir(), 'native-window-executor-')), ctx = new Context()
  let handle, cleanup = () => {}, stopMilestones = () => {}, beforeCleanup = async () => {}
  t.after(async () => { await beforeCleanup(); cleanup(); await stopMilestones(); await handle?.close(); await ctx.fiber.dispose(); resetControlPlaneCache(); rmSync(root, { recursive: true, force: true }) })
  return initializeNativeHost(ctx, async () => {
    await ctx.plugin(Loader)
    ctx.loader.builtins.windowFixture = () => {}
    await ctx.loader.create({ id: 'window-executor-fixture', name: 'cordis:windowFixture', config: {} })
    const sessions = new SessionStore(ctx), projectionRegistry = new SessionProjectionRegistry(ctx)
    projectionRegistry.register(inboxProjectionDefinition); projectionRegistry.register(turnBoundaryProjectionDefinition)
    new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false }); new AgentRegistry(ctx)
    const session = Session.create('window-root', undefined, { id: 'window-root', version: 4, cwd: root, createdAt: Date.now(), isSeeded: false })
    sessions.enter(session); sessions.announce(session)
    const agent = new ReactLoopAgent(ctx, session.id, { provider: 'fixture', model: 'fixture' }, session)
    ctx.agents.enter(agent, { dispose: async () => {} }); agent.wakeDriver = () => {}
    let tier = 0
    class Teams extends Service {
      constructor(ctx) { super(ctx, 'agentTeams') }
      tryMembership(candidate) { return candidate === agent ? { id: 'window-team', name: 'root', tier, root: agent } : undefined }
      listMembers() { return [{ id: session.id, name: 'root', tier }] }
    }
    new Teams(ctx)
    const control = controlPlaneForMember(ctx, agent, { directory: join(root, 'control') })
    const ref = (name, body) => { const path = join(root, name); writeFileSync(path, body); return { path, sha256: sha(body) } }
    const roles = join(root, 'roles'); mkdirSync(roles)
    const bodies = Object.fromEntries(['AGENTS.md', 'root.md', 'lead.md', 'member.md', 'verifier.md'].map(name => [name, name + ' effective test identity']))
    for (const [name, body] of Object.entries(bodies)) writeFileSync(join(roles, name), body)
    writeFileSync(join(roles, 'identity-version.json'), JSON.stringify({ schemaVersion: 1, identityVersion: 'executor-test-1', files: Object.fromEntries(Object.entries(bodies).map(([name, body]) => [name, sha(body)])) }))
    const identity = createActiveIdentityService({ controlPlane: control, rolesDir: roles, allowedRoots: [root], resolveActor: () => ({ name: 'root', tier, id: session.id }) })
    const proposal = identity.readonly.proposal()
    await identity.internal.activate({ expectedControlRevision: control.snapshot().revision, expectedIdentityEpoch: 0, expectedBundleHash: proposal.contentHash }, agent)
    new ToolRuntime(ctx)
    applyTeamRuntime(ctx, { controlDir: join(root, 'control'), pluginDir: root, rolesDir: roles,
      activeIdentity: { enabled: true, allowedRoots: [root] }, windowHostParticipation: true, windowOsFileProtection: true,
      windowIsolatedSessions: [], windowAdmission: 'runtime' })
    const planRef = ref('plan.json', JSON.stringify({ kind: 'dsh-plan-contract', version: 1, planId: 'install-plan', scope: ['source.mjs'],
      items: [{ requirementId: 'r1', taskRefs: [{ boardId: 'global', taskId: 't1' }], implementationRefs: ['impl'] }] }, null, 2))
    const planRegistry = createPlanRegistry({ control, readDurable: () => readControlPlaneSnapshot(control.file), allowedRoots: [root], authorize: () => tier === 0 })
    await planRegistry.register({ planId: 'install-plan', expectedPlanRevision: 0, ref: planRef }, agent)
    await control.mutateHot('fixture/actual-window-authority', {}, agent, state => {
      state.boards.global = { tasks: { t1: { id: 't1', ownerName: 'root', revision: 2, status: 'in_progress', phase: 'execution', contract: { contractRevision: 3, writeScopes: ['source.mjs'] } } } }
      state.v12Requirements = { version: 1, requirements: { r1: { requirementId: 'r1', status: 'active', text: 'critical current requirement' } }, decisions: {} }
      state.v12RoomWake = { version: 1, rooms: {}, inbox: {}, wakes: {} }
      state.v12Compaction = { version: 1, jobs: {} }; state.v14Waiting = { tickets: {} }; state.v12Evidence = { version: 1, records: {} }
    }, { deferMs: 0 })
    const milestonePath = ref('milestones.json', JSON.stringify({ version: 3, teams: { [control.rootId]: { compactions: {} } } })).path
    stopMilestones = applyCompactionMilestones(ctx, { milestonePath })
    session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', message('old-user', 'user', 'completed but raw original '.repeat(limits.historyRepeats ?? 4000)), { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 1, step: 1, stream: [], message: message('old-answer', 'assistant', 'past answer') }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    // Enough completed turns that the collector's protected tail (recentMessages defaults to 6) leaves
    // earlier turns foldable; with only two turns everything would be protected.
    for (let turn = 2; turn <= 5; turn++) {
      session.append('turn/start', { turn }); session.append('step/start', { turn, step: 1 })
      session.append('user/message', message('filler-user-' + turn, 'user', 'filler question '.repeat(200)), { surfaceOp: 'append' })
      session.append('assistant/message', { turn, step: 1, stream: [], message: message('filler-answer-' + turn, 'assistant', 'filler answer '.repeat(200)) }, { surfaceOp: 'append' })
      session.append('step/end', { turn, step: 1 }); session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    session.append('turn/start', { turn: 6 })
    session.append('user/message', message('current-user', 'user', 'keep current constraint'), { surfaceOp: 'append' })
    session.append('step/start', { turn: 6, step: 1 })
    session.append('assistant/message', { turn: 6, step: 1, stream: [], message: message('current-answer', 'assistant', 'current complete answer') }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 6, step: 1 }); session.append('turn/end', { turn: 6, reason: { kind: 'completed' } })
    const backend = new Jsonl(ctx, { root: join(root, 'sessions'), compression: 'none' })
    handle = await backend.create(session.header)
    await handle.append(session.snapshotEvents()); await handle.flush()
    new SessionQueryEngine(ctx)
    const llm = new official.LlmRuntime(ctx)
    llm.registerAdapter(['fixture'], new class extends official.LlmAdapter {
      providerInfo(provider) { return { id: provider, name: provider } }
      async prepareCall(provider, model) { return { model: { provider, id: model, name: model }, stream() { return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })() } } }
    }())
    const projection = installRequestMessageProjection(llm, official)
    ctx.provide('requestMessageProjection', projection)
    const certificate = issueProcessCertificate({ route: { provider: 'fixture', model: 'fixture' }, moduleDirectory: pluginDir })
    return { root, ctx, session, agent, certificate, projection }
  })
}
const executorFor = (f, options = {}) => createWindowExecutor(f.ctx, { certificate: f.certificate,
  planIdFor: () => 'install-plan', routeFor: () => ({ provider: 'fixture', model: 'fixture', protocol: 'deepseek-dsh-v1' }),
  allowedRoots: [f.root], recoveryDirectory: join(f.root, 'recovery'), controlDirectory: join(f.root, 'control'), ...options })
const intents = session => session.snapshotEvents().filter(row => row.type === 'native/window-intent').length

test('idle session without window state passes the guard and falls back below the floor', async t => {
  registry()?.clear()
  const f = await fixture(t)
  const executor = executorFor(f)
  assert.equal(executor.guardStep(f.agent), null)
  const result = await executor.tryFold(f.agent, { contextTokens: 60000, milestoneDone: false, safeBoundary: true })
  assert.equal(result.outcome, 'fallback')
  assert.equal(result.reason, 'rule:below-floor')
  assert.equal(intents(f.session), 0)
})

test('a foldable session folds with a durable window and stays healthy', async t => {
  registry()?.clear()
  const f = await fixture(t)
  const executor = executorFor(f)
  const result = await executor.tryFold(f.agent, { contextTokens: 300000, milestoneDone: true, safeBoundary: true })
  assert.equal(result.outcome, 'folded')
  assert.equal(result.receipt.state, 'COMMITTED')
  assert.equal(executor.guardStep(f.agent), null)
  assert.equal(executor.state(f.agent).healthy, true)
})

test('a new process without the install refuses steps for a committed session', async t => {
  registry()?.clear()
  const f = await fixture(t)
  const executor = executorFor(f)
  assert.equal((await executor.tryFold(f.agent, { contextTokens: 300000, milestoneDone: true, safeBoundary: true })).outcome, 'folded')
  registry().clear()
  const fresh = executorFor(f)
  assert.match(fresh.guardStep(f.agent), /^window-guard:/)
})

test('a rebuilt projection service or reloaded window code hands the session over at the next idle boundary', async t => {
  registry()?.clear()
  const f = await fixture(t)
  let current = f.projection, issued = f.certificate ?? undefined
  const executor = executorFor(f, { projectionOf: () => current, ...(issued ? { certificate: () => issued } : {}) })
  assert.equal((await executor.tryFold(f.agent, { contextTokens: 300000, milestoneDone: true, safeBoundary: true })).outcome, 'folded')
  assert.equal(executor.state(f.agent).healthy, true)
  const before = registry().get(f.session.id).handle

  // The projection service was rebuilt: the old handle no longer serves this session's requests.
  current = { rebuilt: true }
  assert.equal(executor.state(f.agent).healthy, false)
  assert.match(executor.guardStep(f.agent), /^window-guard:/, 'steps are refused until the session is handed over')
  const phase = f.agent.phase
  // Not at an idle boundary: nothing is torn down yet.
  Object.defineProperty(f.agent, 'phase', { value: { kind: 'running' }, configurable: true })
  assert.deepEqual(await executor.ensureInstalled(f.agent), { ok: false, reason: 'window-reinstall-pending' })
  assert.equal(registry().get(f.session.id).handle, before)
  Object.defineProperty(f.agent, 'phase', { value: phase, configurable: true, writable: true })

  const handed = await executor.ensureInstalled(f.agent)
  assert.equal(handed.ok, true, JSON.stringify(handed.reason))
  assert.notEqual(handed.handle, before, 'a new install replaced the old one')
  assert.equal(executor.state(f.agent).healthy, true)
  assert.match(executor.guardStep(f.agent), /recovery-required/, 'the successor starts fenced over the committed window')
  assert.equal((await executor.recoverIfNeeded(f.agent)).state, 'recovered')
  assert.equal(executor.guardStep(f.agent), null)
})

test('missing certificate and missing plan both fall back without writing an intent', async t => {
  registry()?.clear()
  const f = await fixture(t)
  const noCertificate = executorFor(f, { certificate: null })
  const withoutCert = await noCertificate.tryFold(f.agent, { contextTokens: 300000, milestoneDone: true, safeBoundary: true })
  assert.equal(withoutCert.outcome, 'fallback')
  assert.equal(withoutCert.reason, 'window-certificate-unavailable')
  assert.equal(intents(f.session), 0)
  const noPlan = executorFor(f, { planIdFor: () => undefined })
  const withoutPlan = await noPlan.tryFold(f.agent, { contextTokens: 300000, milestoneDone: true, safeBoundary: true })
  assert.equal(withoutPlan.outcome, 'fallback')
  assert.equal(withoutPlan.reason, 'window-plan-unregistered')
  assert.equal(intents(f.session), 0)
})

test('a failed install is retried after a backoff instead of being remembered for ever', async t => {
  registry()?.clear()
  const f = await fixture(t)
  let now = Date.now(), planId = 'no-such-plan'
  const warnings = []
  const executor = executorFor(f, { planIdFor: () => planId, clock: () => now, logger: { warn: line => warnings.push(line) } })
  const first = await executor.ensureInstalled(f.agent)
  assert.deepEqual([first.ok, first.reason, first.retryAt], [false, 'WINDOW_COLLECTOR_PLAN_UNAVAILABLE', now + 30000])
  planId = 'install-plan'
  const early = await executor.ensureInstalled(f.agent)
  assert.deepEqual([early.ok, early.retryAt], [false, first.retryAt], 'inside the backoff the failure is reported, not retried')
  assert.equal(warnings.length, 1)
  now += 30001
  assert.equal((await executor.ensureInstalled(f.agent)).ok, true, 'after the backoff the install is attempted again')
  assert.equal(executor.state(f.agent).healthy, true)
})

test('concurrent callers share one install, and nothing is installed under a running turn', async t => {
  registry()?.clear()
  const f = await fixture(t)
  const executor = executorFor(f)
  const idle = f.agent.phase
  f.agent.phase = { ...idle, kind: 'running' }
  assert.deepEqual(await executor.ensureInstalled(f.agent), { ok: false, reason: 'window-install-not-idle' })
  assert.deepEqual(executor.installs(), [], 'not recorded as a failure: the next idle boundary simply tries again')
  f.agent.phase = idle
  const [a, b] = await Promise.all([executor.ensureInstalled(f.agent), executor.ensureInstalled(f.agent)])
  assert.equal(a.ok && b.ok, true)
  assert.equal(a.handle, b.handle)
  assert.equal(executor.installs().length, 1)
})

test('an operator fold skips the size rule and nothing else', async t => {
  registry()?.clear()
  const f = await fixture(t)
  const executor = executorFor(f)
  assert.equal((await executor.tryFold(f.agent, { contextTokens: 60000, safeBoundary: true })).reason, 'rule:below-floor')
  const manual = await executor.tryFold(f.agent, { safeBoundary: true }, { manual: true })
  assert.equal(manual.outcome, 'folded')
  assert.equal(manual.decision.reason, 'manual')
  assert.equal(executor.resetDemand(f.agent), true)
})

test('an install whose context was disposed by a hot reload is refused at the guard and handed over, not trusted', async t => {
  registry()?.clear()
  const f = await fixture(t)
  // What a reload does to the plugin context the first executor lived in: every service read throws afterwards.
  let dead = false
  const reloaded = new Proxy(f.ctx, { get(target, key) {
    if (dead && typeof key === 'string') throw new Error(`cannot get required service "${key}" in inactive context`)
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const before = createWindowExecutor(reloaded, { certificate: f.certificate, planIdFor: () => 'install-plan',
    routeFor: () => ({ provider: 'fixture', model: 'fixture', protocol: 'deepseek-dsh-v1' }),
    allowedRoots: [f.root], recoveryDirectory: join(f.root, 'recovery'), controlDirectory: join(f.root, 'control') })
  assert.equal((await before.tryFold(f.agent, { safeBoundary: true }, { manual: true })).outcome, 'folded')
  dead = true
  const after = executorFor(f)
  assert.equal(after.guardStep(f.agent), 'window-guard:install-stale', 'the old install is not treated as healthy')
  const installed = await after.ensureInstalled(f.agent)
  assert.equal(installed.ok, true, 'the handover does not need the dead context')
  await after.recoverIfNeeded(f.agent)
  assert.equal(after.guardStep(f.agent), null)
  assert.equal(after.state(f.agent).healthy, true)
})
