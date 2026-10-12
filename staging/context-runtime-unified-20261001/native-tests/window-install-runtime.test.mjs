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
import { issueProcessCertificate, certificateStillValid, certificateModuleFiles, sessionHasWindowState, installSessionWindow } from '../home/profiles/web/plugins/team-v15-window-install.mjs'
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
const sha = value => createHash('sha256').update(value).digest('hex')
const message = (id, role, text) => ({ id, role, source: role === 'user' ? { kind: 'user' }
  : { kind: 'model', provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text }] })

// Copied from native-tests/window-collector-runtime.test.mjs fixture (39-146) and adapted: the native
// path is always taken, the static window list comes from limits, and windowAdmission defaults to
// runtime so only teamWindowRuntime.admit can let a session through.
async function fixture(t, limits = {}) {
  const root = mkdtempSync(join(tmpdir(), 'native-window-install-')), ctx = new Context()
  let handle, cleanup = () => {}, stopMilestones = () => {}, beforeCleanup = async () => {}
  t.after(async () => { await beforeCleanup(); cleanup(); await stopMilestones(); await handle?.close(); await ctx.fiber.dispose(); resetControlPlaneCache(); rmSync(root, { recursive: true, force: true }) })
  return initializeNativeHost(ctx, async () => {
    await ctx.plugin(Loader)
    ctx.loader.builtins.windowFixture = () => {}
    await ctx.loader.create({ id: 'window-install-fixture', name: 'cordis:windowFixture', config: {} })
    const sessions = new SessionStore(ctx), projectionRegistry = new SessionProjectionRegistry(ctx)
    projectionRegistry.register(inboxProjectionDefinition); projectionRegistry.register(turnBoundaryProjectionDefinition)
    new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false }); new AgentRegistry(ctx)
    const session = Session.create('window-root', undefined, { id: 'window-root', version: 4, cwd: root, createdAt: Date.now(), isSeeded: false })
    sessions.enter(session); sessions.announce(session)
    const agent = new ReactLoopAgent(ctx, session.id, { provider: 'fixture', model: 'fixture' }, session)
    const detachAgent = ctx.agents.enter(agent, { dispose: async () => {} }); agent.wakeDriver = () => {}
    let tier = 0, membership = true
    class Teams extends Service {
      constructor(ctx) { super(ctx, 'agentTeams') }
      tryMembership(candidate) { return membership && candidate === agent ? { id: 'window-team', name: 'root', tier, root: agent } : undefined }
      listMembers() { return [{ id: session.id, name: 'root', tier }] }
    }
    new Teams(ctx)
    const control = controlPlaneForMember(ctx, agent, { directory: join(root, 'control') })
    const ref = (name, body) => { const path = join(root, name); writeFileSync(path, body); return { path, sha256: sha(body) } }
    const roles = join(root, 'roles'); mkdirSync(roles)
    const bodies = Object.fromEntries(['AGENTS.md', 'root.md', 'lead.md', 'member.md', 'verifier.md'].map(name => [name, name + ' effective test identity']))
    for (const [name, body] of Object.entries(bodies)) writeFileSync(join(roles, name), body)
    writeFileSync(join(roles, 'identity-version.json'), JSON.stringify({ schemaVersion: 1, identityVersion: 'install-test-1', files: Object.fromEntries(Object.entries(bodies).map(([name, body]) => [name, sha(body)])) }))
    const identity = createActiveIdentityService({ controlPlane: control, rolesDir: roles, allowedRoots: [root], resolveActor: () => ({ name: 'root', tier, id: session.id }) })
    const proposal = identity.readonly.proposal()
    await identity.internal.activate({ expectedControlRevision: control.snapshot().revision, expectedIdentityEpoch: 0, expectedBundleHash: proposal.contentHash }, agent)
    new ToolRuntime(ctx)
    applyTeamRuntime(ctx, { controlDir: join(root, 'control'), pluginDir: root, rolesDir: roles,
      activeIdentity: { enabled: true, allowedRoots: [root] }, windowHostParticipation: true, windowOsFileProtection: true,
      windowIsolatedSessions: limits.windowIsolatedSessions ?? [], windowAdmission: limits.windowAdmission ?? 'runtime' })
    const planRef = ref('plan.json', JSON.stringify({ kind: 'dsh-plan-contract', version: 1, planId: 'install-plan', scope: ['source.mjs'],
      items: [{ requirementId: 'r1', taskRefs: [{ boardId: 'global', taskId: 't1' }], implementationRefs: ['impl'] }] }, null, 2))
    const registry = createPlanRegistry({ control, readDurable: () => readControlPlaneSnapshot(control.file), allowedRoots: [root], authorize: () => tier === 0 })
    await registry.register({ planId: 'install-plan', expectedPlanRevision: 0, ref: planRef }, agent)
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
    session.append('turn/start', { turn: 2 })
    session.append('user/message', message('current-user', 'user', 'keep current constraint'), { surfaceOp: 'append' })
    session.append('step/start', { turn: 2, step: 1 })
    session.append('assistant/message', { turn: 2, step: 1, stream: [], message: message('current-answer', 'assistant', 'current complete answer') }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 2, step: 1 }); session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const backend = new Jsonl(ctx, { root: join(root, 'sessions'), compression: 'none' })
    handle = await backend.create(session.header)
    await handle.append(session.snapshotEvents()); await handle.flush()
    new SessionQueryEngine(ctx)
    const llm = new official.LlmRuntime(ctx), captured = []
    llm.registerAdapter(['fixture'], new class extends official.LlmAdapter {
      providerInfo(provider) { return { id: provider, name: provider } }
      async prepareCall(provider, model) { return { model: { provider, id: model, name: model }, stream(options) {
        captured.push(options); return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })() } } }
    }())
    const projection = installRequestMessageProjection(llm, official, limits.projectionConfig ?? {})
    ctx.provide('requestMessageProjection', projection)
    const request = () => official.markAgentLoopRequest({ provider: 'fixture', model: 'fixture', sessionId: session.id,
      purpose: 'conversation', signal: new AbortController().signal, messages: session.deriveMessages() })
    const certificate = issueProcessCertificate({ route: { provider: 'fixture', model: 'fixture' }, moduleDirectory: pluginDir })
    let exposed
    const install = (options = {}) => installSessionWindow(ctx, { agent, planId: 'install-plan', allowedRoots: [root],
      recoveryDirectory: join(root, 'recovery'), controlDirectory: join(root, 'control'), certificate, recentMessages: 1,
      routeFor: () => ({ provider: 'fixture', model: 'fixture', protocol: 'deepseek-dsh-v1' }), expose: value => { exposed = value }, ...options })
    return { root, ctx, session, agent, control, captured, llm, projection, request, install, handle,
      exposed: () => exposed, runtime: () => ctx.get('teamWindowRuntime'),
      detach: () => detachAgent(),
      changeTier: () => { tier = 2 }, restoreTier: () => { tier = 0 },
      diskEvents: async () => (await handle.read()).events }
  })
}

test('admit: static denies, runtime admits root once, non-root denied, revoke honors the static list', async t => {
  const statik = await fixture(t, { windowAdmission: 'static', windowIsolatedSessions: ['window-root'] })
  const staticRuntime = statik.runtime()
  assert.throws(() => staticRuntime.admit(statik.agent), /WINDOW_SESSION_NOT_ALLOWED/)
  assert.equal(staticRuntime.facts(statik.agent).exactIsolatedOptIn, true)
  assert.equal(staticRuntime.revoke(statik.agent), false)
  assert.equal(staticRuntime.facts(statik.agent).exactIsolatedOptIn, true)
  const f = await fixture(t)
  const runtime = f.runtime()
  assert.equal(runtime.admit(f.agent), true)
  assert.equal(runtime.admit(f.agent), true)
  assert.equal(runtime.facts(f.agent).exactIsolatedOptIn, true)
  assert.equal(runtime.revoke(f.agent), true)
  assert.equal(runtime.facts(f.agent).exactIsolatedOptIn, false)
  assert.equal(runtime.revoke(f.agent), false)
  const g = await fixture(t)
  g.changeTier()
  assert.throws(() => g.runtime().admit(g.agent), /WINDOW_SESSION_NOT_ALLOWED/)
  assert.equal(g.runtime().facts(g.agent).exactIsolatedOptIn, false)
})

test('certificate: stable, invalidated on module change, expectedModules gated', async t => {
  const root = mkdtempSync(join(tmpdir(), 'window-cert-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const modules = certificateModuleFiles()
  const base = join(root, 'home', 'profiles', 'web', 'plugins')
  mkdirSync(base, { recursive: true })
  for (const name of modules) { const path = join(base, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'module ' + name) }
  const route = { provider: 'fixture', model: 'fixture', api: 'openai-responses' }
  const first = issueProcessCertificate({ route, moduleDirectory: base })
  const second = issueProcessCertificate({ route, moduleDirectory: base })
  assert.equal(first.certificateHash, second.certificateHash)
  assert.equal(certificateStillValid(first, { moduleDirectory: base }), true)
  const expected = Object.fromEntries(modules.map(name => [name, first.modules[name]]))
  assert.doesNotThrow(() => issueProcessCertificate({ route, moduleDirectory: base, expectedModules: expected }))
  const tampered = { ...expected, [modules[0]]: '0'.repeat(64) }
  assert.throws(() => issueProcessCertificate({ route, moduleDirectory: base, expectedModules: tampered }),
    error => error.code === 'WINDOW_CERTIFICATE_MODULE_MISMATCH' && Array.isArray(error.mismatched) && error.mismatched.includes(modules[0]))
  writeFileSync(join(base, modules[0]), 'module changed')
  assert.equal(certificateStillValid(first, { moduleDirectory: base }), false)
})

test('installSessionWindow commits once, injects current authority, reports window state', async t => {
  const f = await fixture(t)
  assert.deepEqual(sessionHasWindowState(f.session), { committed: false, pending: false, needsRecover: false })
  const handle = await f.install()
  assert.deepEqual(f.captured, [])
  const receipt = await handle.commit()
  assert.equal(receipt.state, 'COMMITTED')
  assert.equal(receipt.durable, true)
  assert.deepEqual(sessionHasWindowState(f.session), { committed: true, pending: false, needsRecover: true })
  assert.equal(f.captured.length, 0)
  for await (const _ of f.llm.stream(f.request())) {}
  assert.equal(f.captured.length, 1)
  const current = f.captured.at(-1).messages.at(-1)
  assert.ok(current.source.nativeWindowAuthority)
  assert.equal(JSON.parse(current.content[0].text).kind, 'current-server-window-authority')
  assert.equal(JSON.parse(current.content[0].text).authoritative, true)
})

test('refreshRoute re-reads configFingerprint after a host epoch change', async t => {
  const f = await fixture(t)
  const handle = await f.install()
  const before = handle.refreshRoute().configFingerprint
  f.ctx.systemPrompt.section({ name: 'window-install-epoch-bump', order: 9, text: 'host churn' })
  const after = handle.refreshRoute().configFingerprint
  const source = f.exposed().collector.authorityForSurface('window-root').capture('window-root').source
  assert.notEqual(after, before)
  assert.equal(after, source.configFingerprint)
})

test('refreshRoute refuses a route the certificate was not issued for', async t => {
  const wrongModel = await fixture(t)
  const byModel = await wrongModel.install({ routeFor: () => ({ provider: 'fixture', model: 'other', protocol: 'deepseek-dsh-v1' }) })
  assert.throws(() => byModel.refreshRoute(), /WINDOW_CERTIFICATE_ROUTE_MISMATCH/)
  const noProtocol = await fixture(t)
  const byProtocol = await noProtocol.install({ routeFor: () => ({ provider: 'fixture', model: 'fixture' }) })
  assert.throws(() => byProtocol.refreshRoute(), /WINDOW_ROUTE_PROTOCOL_REQUIRED/)
  const apiMismatch = await fixture(t)
  const apiCert = issueProcessCertificate({ route: { provider: 'fixture', model: 'fixture', api: 'openai-responses' }, moduleDirectory: pluginDir })
  const byApi = await apiMismatch.install({ certificate: apiCert, routeFor: () => ({ provider: 'fixture', model: 'fixture', protocol: 'deepseek-dsh-v1' }) })
  assert.throws(() => byApi.refreshRoute(), /WINDOW_CERTIFICATE_ROUTE_MISMATCH/)
})

test('stale certificate refuses commit without writing an intent', async t => {
  const f = await fixture(t)
  const good = issueProcessCertificate({ route: { provider: 'fixture', model: 'fixture' }, moduleDirectory: pluginDir })
  const tampered = { ...good, modules: { ...good.modules, [certificateModuleFiles()[0]]: '0'.repeat(64) } }
  const handle = await f.install({ certificate: tampered })
  await assert.rejects(handle.commit(), /WINDOW_CERTIFICATE_STALE/)
  assert.equal(f.session.snapshotEvents().filter(row => row.type === 'native/window-intent').length, 0)
})

test('recover settles a prepared-but-uncommitted intent to clean', async t => {
  const f = await fixture(t)
  const handle = await f.install({ fault: async stage => { if (stage === 'prepared-durable') throw new Error('install-crash-boundary') } })
  await assert.rejects(handle.commit(), /install-crash-boundary/)
  assert.equal(sessionHasWindowState(f.session).pending, true)
  const states = await handle.recover()
  assert.equal(states[0], 'aborted')
  assert.equal(states.at(-1), 'clean')
  assert.equal(handle.status().paused, false)
})

test('needsRecover fences commit after a durable-commit crash and recover clears it', async t => {
  const f = await fixture(t)
  const handle = await f.install({ fault: async stage => { if (stage === 'commit-durable') throw new Error('install-commit-crash') } })
  await assert.rejects(handle.commit(), /install-commit-crash/)
  assert.equal(handle.needsRecover(), true)
  assert.equal(sessionHasWindowState(f.session).needsRecover, true)
  await assert.rejects(handle.commit(), /WINDOW_RECOVERY_REQUIRED/)
  const states = await handle.recover()
  assert.ok(states.includes('committed'))
  assert.equal(states.at(-1), 'clean')
  assert.equal(handle.needsRecover(), false)
})

test('install failure rolls back admission; a later install succeeds', async t => {
  const f = await fixture(t)
  const runtime = f.runtime()
  // requestMessageProjection is frozen, so fail the surface step instead: the barrier is looked up
  // after admit, and a non-participation error is not retried, so it must roll the admission back.
  const backend = f.ctx.get('sessionPersistence')
  const original = backend.windowBarrierFor
  let first = true
  backend.windowBarrierFor = async function (...args) {
    if (first) { first = false; throw Object.assign(new Error('barrier-boom'), { code: 'BARRIER_BOOM' }) }
    return original.apply(this, args)
  }
  await assert.rejects(f.install(), /barrier-boom/)
  assert.equal(runtime.facts(f.agent).exactIsolatedOptIn, false)
  const handle = await f.install()
  const receipt = await handle.commit()
  assert.equal(receipt.state, 'COMMITTED')
})

test('install failure before admit leaves no half install', async t => {
  const f = await fixture(t)
  await assert.rejects(f.install({ planId: 'missing-plan' }), /WINDOW_COLLECTOR_PLAN_UNAVAILABLE/)
  assert.equal(f.runtime().facts(f.agent).exactIsolatedOptIn, false)
  const handle = await f.install()
  const receipt = await handle.commit()
  assert.equal(receipt.state, 'COMMITTED')
})

test('handover dispose releases the session gate; the same session installs again and recovers', async t => {
  const f = await fixture(t)
  const first = await f.install()
  await first.commit()
  assert.deepEqual(first.dispose({ handover: true }), { kept: false })
  assert.equal(sessionHasWindowState(f.session).needsRecover, true)
  const second = await f.install()
  assert.equal(second.needsRecover(), true, 'a reinstall over a committed window starts fenced')
  const states = await second.recover()
  assert.equal(states.at(-1), 'clean')
  assert.equal(second.needsRecover(), false)
  // The successor serves current authority exactly as the first install did.
  for await (const _ of f.llm.stream(f.request())) {}
  assert.equal(JSON.parse(f.captured.at(-1).messages.at(-1).content[0].text).kind, 'current-server-window-authority')
})

test('dispose keeps a live committed install and still serves current authority', async t => {
  const f = await fixture(t)
  const handle = await f.install()
  await handle.commit()
  assert.deepEqual(handle.dispose(), { kept: true })
  assert.deepEqual(handle.dispose(), { kept: true })
  for await (const _ of f.llm.stream(f.request())) {}
  const current = f.captured.at(-1).messages.at(-1)
  assert.equal(JSON.parse(current.content[0].text).authoritative, true)
})

test('dispose removes the install once the agent has left the roster', async t => {
  const f = await fixture(t)
  const handle = await f.install()
  await handle.commit()
  f.detach()
  assert.deepEqual(handle.dispose(), { kept: false })
})

// --- Plan projection: Teams that never registered a delivery contract --------------------------------------------
const approve = (f, taskId, extra = {}) => f.control.mutateHot('fixture/plan-approved', {}, f.agent, state => {
  state.plans[taskId] = { taskId, state: 'plan-approved', revision: 1, goal: 'goal of ' + taskId, writeScopes: ['source.mjs'], checks: ['node --test'], approvedBy: 'root', ...extra }
}, { deferMs: 0 })
const projected = { planId: undefined, planProjection: true }
const windowPlan = f => f.control.snapshot({ history: false, copy: true }).v15WindowPlan
const checkpointOf = f => f.exposed().collector.authorityForSurface('window-root').capture('window-root').checkpoint

test('a Team with no registered contract folds on the published projection of its approved task plans', async t => {
  const f = await fixture(t)
  await approve(f, 't1', { requirementId: 'r1' })
  const handle = await f.install(projected)
  const published = windowPlan(f)
  assert.deepEqual([published.planId, published.planRevision], ['derived:window-team', 1])
  assert.equal(published.content.coverage.statement, 'known-requirements-have-approved-tasks')
  assert.deepEqual(published.content.items.map(item => [item.requirementId, item.tasks.map(task => task.taskId)]), [['r1', ['t1']]])
  const receipt = await handle.commit()
  assert.equal(receipt.state, 'COMMITTED')
  assert.equal(windowPlan(f).planRevision, 1, 'publishing identical content before the fold is not a new revision')
  const checkpoint = checkpointOf(f)
  assert.equal(checkpoint.planRef.path, 'control-plane:v15WindowPlan#1')
  assert.equal(checkpoint.planHash, published.planHash)
  assert.equal(checkpoint.authority.planCoverageStates.coverage.basis, 'approved-task-plans')
})

test('approvals between folds do not move the plan a window is bound to; publishing does, once', async t => {
  const f = await fixture(t)
  await approve(f, 't1', { requirementId: 'r1' })
  await f.install(projected)
  const before = checkpointOf(f).planHash
  await approve(f, 't2')
  assert.equal(checkpointOf(f).planHash, before, 'the live approval set is not what the window cites')
  const { publishWindowPlan } = await import('../home/profiles/web/plugins/team-v15-window-plan.mjs')
  const first = await publishWindowPlan(f.control, f.agent)
  assert.deepEqual([first.changed, first.plan.planRevision], [true, 2])
  const again = await publishWindowPlan(f.control, f.agent)
  assert.deepEqual([again.changed, again.plan.planRevision], [false, 2])
  assert.notEqual(checkpointOf(f).planHash, before)
})

test('the projection says what it cannot vouch for', async t => {
  const { deriveWindowPlan } = await import('../home/profiles/web/plugins/team-v15-window-plan.mjs')
  const plans = { t1: { taskId: 't1', state: 'plan-approved', revision: 2, goal: 'g', writeScopes: ['b', 'a', 'a'], requirementId: 'r1' },
    t2: { taskId: 't2', state: 'plan-proposed', goal: 'not approved yet' }, t3: { taskId: 't3', state: 'plan-approved', goal: 'no requirement' } }
  const none = deriveWindowPlan({ plans })
  assert.equal(none.coverage.statement, 'requirement-list-unknown', 'no requirement list: completeness is unknown, not passed')
  assert.deepEqual(none.items.map(item => item.requirementId), ['r1', 't3'], 'a proposed plan commits the Team to nothing')
  assert.deepEqual(none.items[0].tasks[0].writeScopes, ['a', 'b'])
  const gap = deriveWindowPlan({ plans, v12Requirements: { requirements: { r1: { requirementId: 'r1', status: 'active' }, r2: { requirementId: 'r2', status: 'active' }, r3: { requirementId: 'r3', status: 'withdrawn' } } } })
  assert.deepEqual([gap.coverage.statement, gap.coverage.unmappedRequirements], ['known-requirements-without-approved-task', ['r2']])
  assert.deepEqual(deriveWindowPlan({ plans: { t3: plans.t3, t1: plans.t1, t2: plans.t2 } }), none, 'independent of insertion order')
})

test('a settled lossy fold is reported, whoever made it; a fold of this session that is still running or failed blocks', async t => {
  const debtRow = { status: 'completed_with_debt', memoryDebt: { missingAnchors: ['a'] } }
  const withRows = async rows => {
    const f = await fixture(t)
    await approve(f, 't1', { requirementId: 'r1' })
    writeFileSync(join(f.root, 'milestones.json'), JSON.stringify({ version: 3, teams: { [f.control.rootId]: { compactions: rows } } }))
    return f
  }
  const blocked = await withRows({ worker: debtRow })
  const strict = await blocked.install(projected)
  assert.equal(checkpointOf(blocked).recovery.memoryDebt.some(row => row.kind === 'compaction-memory'), true, 'the default stays strict')
  await assert.rejects(strict.commit())

  const reported = await withRows({ worker: debtRow })
  const handle = await reported.install({ ...projected, peerCompactionDebt: 'report' })
  const checkpoint = checkpointOf(reported)
  assert.deepEqual(checkpoint.recovery.memoryDebt.filter(row => row.kind === 'compaction-memory'), [])
  assert.deepEqual(checkpoint.recovery.peerCompactionDebt.map(row => [row.memberName, row.status]), [['worker', 'completed_with_debt']])
  assert.equal((await handle.commit()).state, 'COMMITTED')
  assert.deepEqual(checkpointOf(reported).recovery.memoryDebt, [], 'nothing owed after the fold')

  const settledOwn = await withRows({ root: debtRow })
  const settledHandle = await settledOwn.install({ ...projected, peerCompactionDebt: 'report' })
  assert.deepEqual(checkpointOf(settledOwn).recovery.peerCompactionDebt.map(row => row.memberName), ['root'], 'a summary debt of the root itself does not shut the window for good')
  assert.equal((await settledHandle.commit()).state, 'COMMITTED')

  const own = await withRows({ 'engine:root': { status: 'retryable', lastError: 'summary failed' } })
  await own.install({ ...projected, peerCompactionDebt: 'report' })
  assert.deepEqual(checkpointOf(own).recovery.memoryDebt.filter(row => row.kind === 'compaction-memory').map(row => row.memberName), ['engine:root'])
})

test('after a fold the conversation may grow past the authority size limit again; only the authority message is bounded', async t => {
  const f = await fixture(t)
  const handle = await f.install()
  assert.equal((await handle.commit()).state, 'COMMITTED')
  f.session.append('turn/start', { turn: 3 })
  f.session.append('user/message', message('big-user', 'user', 'x'.repeat(400000)), { surfaceOp: 'append' })
  for await (const _ of f.llm.stream(f.request())) {}
  assert.equal(f.captured.length, 1, 'the request is admitted')
  assert.ok(Buffer.byteLength(JSON.stringify(f.captured[0].messages)) > 262144)
  assert.ok(f.captured[0].messages.at(-1).source.nativeWindowAuthority)
})

test('a request branded in another dsh-llm module instance is accepted by the window, an unbranded one is not', async t => {
  // A second module instance of the same library: its own brand set, as a hard-linked copy under another path has.
  const marks = new WeakSet()
  const otherCopy = { isAgentLoopRequest: options => marks.has(options), markAgentLoopRequest: options => { marks.add(options); return options } }
  const f = await fixture(t, { projectionConfig: { brandModules: [otherCopy] } })
  const handle = await f.install()
  assert.equal((await handle.commit()).state, 'COMMITTED')
  const plain = () => ({ provider: 'fixture', model: 'fixture', sessionId: f.session.id, purpose: 'conversation',
    signal: new AbortController().signal, messages: f.session.deriveMessages() })
  const foreign = otherCopy.markAgentLoopRequest(plain())
  assert.equal(f.projection.isAgentLoopRequest(foreign), true, 'recognised although the instance the runtime came from never saw it')
  assert.equal(official.isAgentLoopRequest(foreign), false)
  for await (const _ of f.llm.stream(foreign)) {}
  assert.equal(f.captured.length, 1)
  assert.ok(f.captured[0].messages.at(-1).source.nativeWindowAuthority, 'the branded request carries current authority')
  let refused = null
  try { for await (const chunk of f.llm.stream(plain())) { if (chunk.type === 'finish' && chunk.reason?.kind === 'error') refused = chunk.reason } }
  catch (error) { refused = error }
  assert.ok(refused, 'a request nobody branded is still refused for a session that holds a window')
  assert.equal(f.captured.length, 1)
})

// --- Authority that cites settled history instead of carrying it ---------------------------------------------------
const parsedAuthority = message => JSON.parse(message.content[0].text)
const settleHistory = f => f.control.mutateHot('fixture/settled-history', {}, f.agent, state => {
  state.boards.global.tasks.t0 = { id: 't0', ownerName: 'root', revision: 5, status: 'completed', phase: 'done', contract: { contractRevision: 1, writeScopes: ['old.mjs'] }, notes: 'x'.repeat(4000) }
  state.evidence = { e1: { id: 'e1', taskId: 't0', text: 'y'.repeat(6000) }, e2: { id: 'e2', taskId: 't0', text: 'z'.repeat(6000) } }
  state.v12RoomWake.wakes = { w1: { wakeId: 'w1', target: 'root', status: 'handled', body: 'w'.repeat(3000) }, w2: { wakeId: 'w2', target: 'root', status: 'queued', body: 'open wake' } }
  state.v14Waiting = { tickets: { k1: { ticketId: 'k1', status: 'resolved', resolvedAt: 1, reason: 'r'.repeat(3000) }, k2: { ticketId: 'k2', status: 'open', reason: 'still waiting' } } }
}, { deferMs: 0 })

test('live authority carries what is in force as text and cites settled history by count and hash', async t => {
  const f = await fixture(t)
  await settleHistory(f)
  await f.install({ authorityDetail: 'live' })
  const { authority, criticalRevisionVector } = checkpointOf(f)
  assert.deepEqual(Object.keys(authority.ownerScopeLeaseRefs.tasks), ['global:t1'], 'only the open task is carried')
  assert.deepEqual(Object.keys(authority.taskRevisions), ['global:t1'])
  assert.deepEqual(Object.keys(authority.wakeInboxRefs.wakes), ['w2'])
  assert.deepEqual(Object.keys(authority.waitingRefs), ['k2'])
  assert.equal(authority.requirementRefs.r1.text, 'critical current requirement', 'requirements stay in full')
  assert.deepEqual([authority.settledRefs.tasks.count, authority.settledRefs.wakes.count, authority.settledRefs.waiting.count, authority.evidenceRefs.legacy.count], [1, 1, 1, 2])
  assert.ok(Buffer.byteLength(JSON.stringify(authority)) < 6000, 'none of the settled text is in it')
  // The hash still binds the checkpoint to the settled history: changing an old record changes the authority.
  await f.control.mutateHot('fixture/old-evidence-edited', {}, f.agent, state => { state.evidence.e1.text = 'rewritten' }, { deferMs: 0 })
  assert.notEqual(checkpointOf(f).criticalRevisionVector.authorityHash, criticalRevisionVector.authorityHash)
})

test('after a fold the current authority is stated as changes against the checkpoint, and in full once the checkpoint is gone', async t => {
  const f = await fixture(t)
  await settleHistory(f)
  const handle = await f.install({ authorityDetail: 'live' })
  assert.equal((await handle.commit()).state, 'COMMITTED')
  const historical = f.session.deriveMessages().find(row => row.source?.nativeWindowCheckpoint)
  const stored = parsedAuthority(historical)
  assert.equal(stored.checkpoint.criticalRevisionVector, undefined, 'the model text carries no host-only binding fields')
  assert.equal(typeof stored.foldedEvents.count, 'number')
  for await (const _ of f.llm.stream(f.request())) {}
  const unchanged = parsedAuthority(f.captured.at(-1).messages.at(-1))
  assert.deepEqual([unchanged.baselineCheckpointId, unchanged.authority], [stored.checkpoint.checkpointId, 'unchanged-since-that-checkpoint'])
  await f.control.mutateHot('fixture/task-blocked', {}, f.agent, state => { state.boards.global.tasks.t1.status = 'blocked' }, { deferMs: 0 })
  for await (const _ of f.llm.stream(f.request())) {}
  const changed = parsedAuthority(f.captured.at(-1).messages.at(-1))
  assert.equal(changed.authorityChanges.changed.phaseRefs.changed['global:t1'].changed.status.set, 'blocked')
  assert.equal(changed.authority, undefined, 'only the change is restated')
  // A summary fold took the checkpoint message out of the conversation: the session still holds a window, so the
  // request still gets its current authority, now in full because there is nothing left to refer to.
  const withoutCheckpoint = official.markAgentLoopRequest({ provider: 'fixture', model: 'fixture', sessionId: f.session.id, purpose: 'conversation',
    signal: new AbortController().signal, messages: f.session.deriveMessages().filter(row => !row.source?.nativeWindowCheckpoint) })
  for await (const _ of f.llm.stream(withoutCheckpoint)) {}
  const full = parsedAuthority(f.captured.at(-1).messages.at(-1))
  assert.equal(full.baselineCheckpointId, undefined)
  assert.equal(full.authority.phaseRefs['global:t1'].status, 'blocked')
})

test('an authority too large to restate refuses the fold up front, and never a request of a session that already folded', async t => {
  const small = await fixture(t)
  const refused = await small.install({ authorityDetail: 'live', maxAuthorityBytes: 1500, maxRequestBytes: 16777216 })
  await assert.rejects(refused.commit(), error => error.code === 'WINDOW_COLLECTOR_CHECKPOINT_BUDGET' && error.detail.limitBytes === 1500)
  assert.deepEqual(sessionHasWindowState(small.session), { committed: false, pending: false, needsRecover: false }, 'nothing was written')

  const f = await fixture(t)
  const handle = await f.install({ authorityDetail: 'live', maxAuthorityBytes: 20000, maxRequestBytes: 16777216 })
  assert.equal((await handle.commit()).state, 'COMMITTED')
  await f.control.mutateHot('fixture/state-grew', {}, f.agent, state => {
    // Records this session owns stay whole, so enough of them still outgrow the limit.
    for (let n = 0; n < 10; n++) state.boards.global.tasks['own' + n] = { id: 'own' + n, ownerName: 'root', revision: 1, status: 'in_progress', phase: 'execution', description: 'q'.repeat(7000) }
  }, { deferMs: 0 })
  for await (const _ of f.llm.stream(f.request())) {}
  assert.equal(f.captured.length, 1, 'the request is sent')
  const stated = parsedAuthority(f.captured.at(-1).messages.at(-1))
  assert.equal(stated.authority.oversize, true)
  assert.match(stated.requiredRead, /Read the Team board/)
  assert.ok(Buffer.byteLength(JSON.stringify(f.captured.at(-1).messages.at(-1))) < 20000)
})

test('a turn that cannot be folded in the middle does not stop the fold: the largest unbroken run is folded', async t => {
  const f = await fixture(t)
  // turn 1 and turn 2 exist (completed). Add an errored turn 3 and completed turns 4 and 5 after it, then a last one.
  const turn = (n, reason, size = 2000) => {
    f.session.append('turn/start', { turn: n })
    f.session.append('user/message', message('u' + n, 'user', ('question ' + n + ' ').repeat(size)), { surfaceOp: 'append' })
    f.session.append('step/start', { turn: n, step: 1 })
    if (reason === 'completed') f.session.append('assistant/message', { turn: n, step: 1, stream: [], message: message('a' + n, 'assistant', 'answer ' + n) }, { surfaceOp: 'append' })
    f.session.append('step/end', { turn: n, step: 1 }); f.session.append('turn/end', { turn: n, reason: { kind: reason } })
  }
  turn(3, 'error'); turn(4, 'completed'); turn(5, 'completed'); turn(6, 'completed', 5)
  const handle = await f.install()
  const receipt = await handle.commit()
  assert.equal(receipt.state, 'COMMITTED')
  let ids = f.session.deriveMessages().map(row => row.id)
  assert.ok(ids.includes('u3'), 'the errored turn stays where it is')
  assert.ok(!ids.includes('old-user') && !ids.includes('current-answer'), 'the first unbroken run was folded')
  assert.ok(ids.includes('u4') && ids.includes('a5'), 'the run behind the errored turn waits for the next fold')
  assert.equal((await handle.commit()).state, 'COMMITTED', 'which is the next fold')
  ids = f.session.deriveMessages().map(row => row.id)
  assert.ok(!ids.includes('u4') && !ids.includes('a5') && ids.includes('u3') && ids.includes('u6'))
})

test('a delivery check can say what it does not know about requirements', async () => {
  const { requirementCoverageNote } = await import('../home/profiles/web/plugins/team-v15-window-plan.mjs')
  const plans = { t1: { taskId: 't1', state: 'plan-approved', requirementId: 'r1' } }
  assert.equal(requirementCoverageNote({ plans }).requirementCompleteness, 'unknown')
  const listed = { r1: { requirementId: 'r1', status: 'active' }, r2: { requirementId: 'r2', status: 'active' } }
  const gap = requirementCoverageNote({ plans, v12Requirements: { requirements: listed } })
  assert.deepEqual([gap.requirementCompleteness, gap.requirementsWithoutApprovedTask], ['incomplete', ['r2']])
  assert.equal(requirementCoverageNote({ plans, v12Requirements: { requirements: { r1: listed.r1 } } }).requirementCompleteness, 'covered')
})

test('on a busy Team what is open but not this session\'s own is carried as brief rows, so the authority stays small', async t => {
  const f = await fixture(t)
  await f.control.mutateHot('fixture/busy-team', {}, f.agent, state => {
    for (let n = 0; n < 60; n++) state.boards.global.tasks['w' + n] = { id: 'w' + n, ownerName: 'worker-' + (n % 7), revision: 3, status: 'in_progress', phase: 'execution',
      title: 'task ' + n, description: 'd'.repeat(4000), contract: { contractRevision: 2, writeScopes: ['src/w' + n + '.mjs'], acceptance: 'a'.repeat(1500) } }
    state.v12RoomWake.wakes = Object.fromEntries(Array.from({ length: 30 }, (_, n) => ['k' + n, { wakeId: 'k' + n, target: n === 0 ? 'root' : 'worker-1', status: 'queued', body: 'b'.repeat(5000) }]))
  }, { deferMs: 0 })
  await f.install({ authorityDetail: 'live' })
  const { authority } = checkpointOf(f)
  const bytes = Buffer.byteLength(JSON.stringify(authority))
  assert.ok(bytes < 120000, 'about 400KB of open records fit in ' + bytes + ' bytes')
  const other = authority.ownerScopeLeaseRefs.tasks['global:w3']
  assert.deepEqual([other.brief, other.status, other.ownerName, other.contract.writeScopes], [true, 'in_progress', 'worker-3', ['src/w3.mjs']])
  assert.match(other.sha256, /^[a-f0-9]{64}$/)
  assert.equal(authority.ownerScopeLeaseRefs.tasks['global:t1'].brief, undefined, 'the session\'s own task is whole')
  assert.equal(authority.wakeInboxRefs.wakes.k0.brief, true, 'wakes are named, not carried: their text arrives through the inbox')
  assert.equal(authority.wakeInboxRefs.wakes.k1.brief, true)
})

test('a baseline put back after a summary fold is what later requests state their changes against', async t => {
  const f = await fixture(t)
  const handle = await f.install({ authorityDetail: 'live' })
  assert.equal((await handle.commit()).state, 'COMMITTED')
  assert.equal(handle.missingBaseline(), null, 'the checkpoint is still in the conversation')
  const authority = checkpointOf(f).authority
  const baseline = { id: 'baseline-1', role: 'user', source: { kind: 'team-message', nativeWindowBaseline: { checkpointId: 'put-back', authority } }, content: [{ type: 'text', text: 'baseline' }] }
  const request = official.markAgentLoopRequest({ provider: 'fixture', model: 'fixture', sessionId: f.session.id, purpose: 'conversation', signal: new AbortController().signal,
    messages: [...f.session.deriveMessages().filter(row => !row.source?.nativeWindowCheckpoint), baseline] })
  for await (const _ of f.llm.stream(request)) {}
  const stated = JSON.parse(f.captured.at(-1).messages.at(-1).content[0].text)
  assert.deepEqual([stated.baselineCheckpointId, stated.authority], ['put-back', 'unchanged-since-that-checkpoint'])
})

test('a fold that would not free the share the host asks for is refused before anything is written', async t => {
  const f = await fixture(t)
  const handle = await f.install({ minReductionRatio: 0.999 })
  await assert.rejects(handle.commit(), error => error.code === 'WINDOW_NO_BOUNDED_REDUCTION' && error.detail.everyRequestBytes > 0 && error.detail.minReductionRatio === 0.999)
  assert.deepEqual(sessionHasWindowState(f.session), { committed: false, pending: false, needsRecover: false })
  const modest = await fixture(t)
  assert.equal((await (await modest.install({ minReductionRatio: 0.25 })).commit()).state, 'COMMITTED')
})

test('the request limit includes the every-request authority, not just the replaced surface', async t => {
  const f = await fixture(t)
  const measuring = await f.install({ minReductionRatio: 0.999 })
  let measured
  await assert.rejects(measuring.commit(), error => { measured = error.detail; return error.code === 'WINDOW_NO_BOUNDED_REDUCTION' })
  measuring.dispose()
  const limit = Math.floor(measured.afterBytes + measured.everyRequestBytes / 2)
  const bounded = await f.install({ minReductionRatio: 0, maxRequestBytes: limit })
  await assert.rejects(bounded.commit(), error => error.code === 'WINDOW_NO_BOUNDED_REDUCTION'
    && error.detail.afterBytes <= limit && error.detail.afterBytes + error.detail.everyRequestBytes > limit
    && error.detail.limitBytes === limit)
  assert.deepEqual(sessionHasWindowState(f.session), { committed: false, pending: false, needsRecover: false })
})

test('inbox brief rows have fixed fields and exact paged retrieval, while injected messages remain unresolved', async t => {
  const f = await fixture(t)
  const body = 'first body '.repeat(700)
  await f.control.mutateHot('fixture/large-inbox', {}, f.agent, state => {
    state.v12RoomWake.inbox = Object.fromEntries(Array.from({ length: 146 }, (_, n) => ['m' + n, {
      messageId: 'm' + n, target: 'root', sender: 'worker', status: 'injected', originalText: n === 0 ? body : 'same body',
      wakeIds: n < 2 ? ['w'] : [], createdAt: n + 1, duplicateBody: body, arbitraryPayload: { nested: body }, injectionReceipt: 'receipt-' + n,
    }]))
    state.v12RoomWake.wakes = { w: { wakeId: 'w', target: 'root', sender: 'worker', status: 'injected',
      messageIds: ['m0', 'm1'], originalText: body, arbitraryPayload: { nested: body } } }
  }, { deferMs: 0 })
  await f.install({ authorityDetail: 'live' })
  const { authority } = checkpointOf(f)
  const inbox = authority.wakeInboxRefs.inbox
  assert.equal(Object.keys(inbox).length, 146, 'same text is not deduplicated by similarity')
  assert.equal(inbox.m0.status, 'injected')
  assert.equal(inbox.m0.summary.length, 200)
  assert.equal(inbox.m0.duplicateBody, undefined)
  assert.equal(authority.wakeInboxRefs.wakes.w.originalText, undefined)
  assert.deepEqual(authority.wakeInboxRefs.wakes.w.messageIds, ['m0', 'm1'])
  assert.ok(Buffer.byteLength(JSON.stringify(authority.wakeInboxRefs)) < 100000)
  const read = async input => {
    const result = await f.ctx.tools.execute({ name: 'team_v12', arguments: { action: 'inbox_list', input },
      agent: f.agent, callId: 'inbox-read-' + JSON.stringify(input), signal: new AbortController().signal })
    assert.equal(result.isError, false, JSON.stringify(result))
    return result.value
  }
  assert.equal((await read({ limit: 100 })).inbox.some(row => row.messageId === 'm0'), false)
  let recovered = '', offset = 0
  do {
    const result = await read({ ...inbox.m0.retrieve.input, text_offset: offset })
    assert.equal(result.inbox.length, 1)
    recovered += result.inbox[0].originalText
    offset = result.inbox[0].nextTextOffset
  } while (offset !== null)
  assert.equal(recovered, body)
  const wake = await read(authority.wakeInboxRefs.wakes.w.retrieve.input)
  assert.deepEqual(wake.inbox.map(row => row.messageId), ['m0', 'm1'])
})

// --- Step ranges inside a completed turn ---------------------------------------------------------------------------
const workingTurn = (f, n, steps, between = {}) => {
  f.session.append('turn/start', { turn: n })
  f.session.append('user/message', message('u' + n, 'user', 'do the work, and keep this constraint'), { surfaceOp: 'append' })
  for (let step = 1; step <= steps; step++) {
    const callId = 'call-' + n + '-' + step
    f.session.append('step/start', { turn: n, step })
    f.session.append('assistant/message', { turn: n, step, stream: [], message: { id: 'a' + n + '-' + step, role: 'assistant',
      source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }] } }, { surfaceOp: 'append' })
    const call = f.session.append('tool/call', { turn: n, step, callId, name: 'read', arguments: '{}' }).seq
    f.session.append('tool/result', { turn: n, step, message: JSON.parse(JSON.stringify(official.createToolResultMessage({ callId, content: [{ type: 'text', text: ('result of step ' + step + ' ').repeat(2500) }] }))) },
      { surfaceOp: 'append', sourceEventSeqs: [call] })
    f.session.append('step/end', { turn: n, step })
    if (between[step]) f.session.append('user/message', { ...message(between[step].id, 'user', between[step].id + ' text'), source: between[step].source }, { surfaceOp: 'append' })
  }
  f.session.append('step/start', { turn: n, step: steps + 1 })
  f.session.append('assistant/message', { turn: n, step: steps + 1, stream: [], message: message('a' + n + '-final', 'assistant', 'final answer of the working turn') }, { surfaceOp: 'append' })
  f.session.append('step/end', { turn: n, step: steps + 1 }); f.session.append('turn/end', { turn: n, reason: { kind: 'completed' } })
}

test('the finished steps of a long completed turn are folded; the input, the final answer and an unfinished step stay', async t => {
  const f = await fixture(t, { historyRepeats: 5 })
  workingTurn(f, 3, 6)
  const handle = await f.install()
  const receipt = await handle.commit()
  assert.equal(receipt.state, 'COMMITTED')
  const left = f.session.deriveMessages()
  const ids = left.map(row => row.id)
  assert.ok(ids.includes('u3'), 'what the user asked for stays in the conversation')
  assert.ok(ids.includes('a3-final'), 'and so does the answer')
  assert.deepEqual(ids.filter(id => /^a3-\d$/.test(id)), [], 'the tool steps in between are folded')
  assert.equal(left.filter(row => row.role === 'tool').length, 0, 'with every one of their results')
  const at = name => ids.indexOf(name), checkpoint = left.findIndex(row => row.source?.nativeWindowCheckpoint)
  assert.ok(at('u3') < checkpoint && checkpoint < at('a3-final'), 'the checkpoint stands where the steps were')
  for await (const _ of f.llm.stream(f.request())) {}
  assert.equal(f.captured.length, 1, 'and the next request is admitted')
})

test('a runtime state message between steps is folded with them; what a teammate wrote ends the run and stays', async t => {
  const f = await fixture(t, { historyRepeats: 5 })
  workingTurn(f, 3, 8, {
    2: { id: 'state-3', source: { kind: 'team-message', plugin: 'team-v12-runtime', form: 'snapshot', summary: 'versioned Team context delta' } },
    5: { id: 'mate-3', source: { kind: 'team-message', teamId: 'team', messageId: 'm1', senderId: 'worker', senderName: 'worker' } } })
  const handle = await f.install()
  assert.equal((await handle.commit()).state, 'COMMITTED')
  const ids = f.session.deriveMessages().map(row => row.id)
  assert.deepEqual(ids.filter(id => /^a3-[1-5]$/.test(id)), [], 'the steps on both sides of the state message are one run')
  assert.ok(!ids.includes('state-3'), 'and the state message went with them')
  assert.ok(ids.includes('mate-3'), 'the teammate message is still in the conversation')
  assert.ok(ids.includes('a3-6') && ids.includes('u3') && ids.includes('a3-final'), 'and so is everything after it')
  for await (const _ of f.llm.stream(f.request())) {}
  assert.equal(f.captured.length, 1, 'the next request is admitted')
})

test('a step whose tool result is missing is not folded, and neither is anything after a gap', async t => {
  const f = await fixture(t, { historyRepeats: 5 })
  f.session.append('turn/start', { turn: 3 })
  f.session.append('user/message', message('u3', 'user', 'work'), { surfaceOp: 'append' })
  f.session.append('step/start', { turn: 3, step: 1 })
  f.session.append('assistant/message', { turn: 3, step: 1, stream: [], message: { id: 'a3-1', role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    content: [{ type: 'tool-call', id: 'orphan', name: 'read', arguments: '{}' }] } }, { surfaceOp: 'append' })
  f.session.append('step/end', { turn: 3, step: 1 })
  f.session.append('step/start', { turn: 3, step: 2 })
  f.session.append('assistant/message', { turn: 3, step: 2, stream: [], message: message('a3-final', 'assistant', 'stopped') }, { surfaceOp: 'append' })
  f.session.append('step/end', { turn: 3, step: 2 }); f.session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
  const handle = await f.install()
  await handle.commit().catch(() => {})
  assert.ok(f.session.deriveMessages().some(row => row.id === 'a3-1'), 'the unanswered call is still in the conversation')
})

test('multiple step ranges share one atomic checkpoint and keep human inputs, teammate decisions and final replies in order', async t => {
  const f = await fixture(t, { historyRepeats: 5 })
  workingTurn(f, 3, 8, {
    2: { id: 'state-3', source: { kind: 'team-message', plugin: 'team-v12-runtime', form: 'snapshot' } },
    3: { id: 'mate-3', source: { kind: 'team-message', teamId: 'team', messageId: 'decision-1', senderId: 'worker' } },
    5: { id: 'person-3', source: { kind: 'user', rpcId: 'correction', clientTimeZone: 'UTC' } },
    6: { id: 'mate-4', source: { kind: 'team-message', senderSessionId: 'peer', messageId: 'decision-2' } } })
  const original = f.session.snapshotEvents(), originalMessages = f.session.deriveMessages()
  const keep = ['old-user', 'old-answer', 'current-user', 'current-answer', 'u3', 'mate-3', 'person-3', 'mate-4', 'a3-final']
  const handle = await f.install({ spanMode: 'multiple', minReductionRatio: 0.25 })
  const receipt = await handle.commit()
  assert.equal(receipt.state, 'COMMITTED')
  const committed = f.session.snapshotEvents().find(row => row.data?.source?.windowCommit)
  assert.equal(committed.surfaceOp.op, 'replace-many')
  assert.equal(committed.surfaceOp.ranges.length, 4)
  assert.equal(f.session.snapshotEvents().find(row => row.type === 'native/window-intent').data.schemaVersion, 2)
  assert.deepEqual(f.session.snapshotEvents().slice(0, original.length), original)
  const left = f.session.deriveMessages(), ids = left.map(row => row.id)
  assert.deepEqual(ids.filter(id => keep.includes(id)), keep)
  assert.equal(left.filter(row => row.source?.nativeWindowCheckpoint).length, 1)
  for (const id of keep) assert.deepEqual(left.find(row => row.id === id), originalMessages.find(row => row.id === id))
  assert.ok(ids.indexOf('u3') < ids.indexOf(committed.data.id) && ids.indexOf(committed.data.id) < ids.indexOf('mate-3'))
  assert.equal(left.some(row => row.role === 'tool' || /^a3-\d$/.test(row.id) || row.id === 'state-3'), false)
  const disk = await f.diskEvents(), cold = Session.create(f.session.id, disk, f.session.header, undefined, [inboxProjectionDefinition, turnBoundaryProjectionDefinition])
  assert.deepEqual(cold.deriveMessages(), left, 'JSONL replay derives exactly the committed multi-range view')
  for await (const _ of f.llm.stream(f.request())) {}
  assert.equal(f.captured.length, 1)
  await assert.rejects(handle.commit(), /WINDOW_NO_COMPLETED_SPAN/, 'the folded steps are not proposed again')
})
