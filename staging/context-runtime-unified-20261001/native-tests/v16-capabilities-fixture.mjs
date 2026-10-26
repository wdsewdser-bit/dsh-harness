import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session, SessionStore, nativeSessionBridge } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { ReactLoopAgent, inboxProjectionDefinition, turnBoundaryProjectionDefinition } from '../app/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'
import Jsonl from '../app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'
import { initializeNativeHost } from './native-host-fixture.mjs'
import { controlPlaneForMember, readControlPlaneSnapshot, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { createPlanRegistry } from '../home/profiles/web/plugins/team-v15-plan-registry.mjs'
import { createActiveIdentityService } from '../home/profiles/web/plugins/team-v15-active-identity.mjs'
import { apply as applyCompactionMilestones } from '../home/profiles/web/plugins/step-compaction-v4.mjs'
import { installRequestMessageProjection } from '../home/profiles/web/plugins/request-message-projection.mjs'
import { createServerWindowCollector, apply as applyCollector } from '../home/profiles/web/plugins/team-v15-window-collector.mjs'
import { installWindowProjection } from '../home/profiles/web/plugins/team-v15-window-projection.mjs'
import { proveCompletedReasoningSpan } from '../home/profiles/web/plugins/team-v15-window-protocol.mjs'
import { windowHash as hash } from '../home/profiles/web/plugins/team-v15-window-checkpoint.mjs'
import { apply as applyTeamRuntime } from '../home/profiles/web/plugins/team-v12-runtime.mjs'
import { ToolRuntime } from '../app/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
import { createServerWindowSurface } from '../home/profiles/web/plugins/team-v15-window-surface.mjs'
import { nativeHostBinding } from '../home/profiles/web/plugins/team-v15-window-participation.mjs'
import { createContextWorkspaceService } from '../home/profiles/web/plugins/context-workspace.mjs'
const require = createRequire(new URL('../app/package.json', import.meta.url))
const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)))
const { Context, Service, getHostLifecycleGate } = await load('cordis')
const {Loader}=await load('cordis-plugin-loader')
const { SessionProjectionRegistry } = await load('dsh-session-projection')
const { AgentRegistry } = await load('dsh-agent')
const { SystemPrompt } = await load('dsh-system-prompt')
const { SessionQueryEngine } = await load('dsh-session-query')
const official = await load('dsh-llm')
const sha = value => createHash('sha256').update(value).digest('hex')
const message = (id, role, text) => ({ id, role, source: role === 'user' ? { kind: 'user' }
  : { kind: 'model', provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text }] })

async function fixture(t, limits = {}) {
  const root = mkdtempSync(join(tmpdir(), 'native-window-collector-')), ctx = new Context()
  let handle, cleanup = () => {}, stopMilestones = () => {}, beforeCleanup=async()=>{}
  t.after(async () => { await beforeCleanup(); cleanup(); await stopMilestones(); await handle?.close(); await ctx.fiber.dispose(); resetControlPlaneCache(); rmSync(root, { recursive: true, force: true }) })
  return initializeNativeHost(ctx, async () => {
    if(limits.installNativeRuntime) {
      await ctx.plugin(Loader)
      ctx.loader.builtins.windowFixture=()=>{}
      await ctx.loader.create({id:'window-native-fixture',name:'cordis:windowFixture',config:{}})
    }
    const sessions = new SessionStore(ctx), projectionRegistry = new SessionProjectionRegistry(ctx)
    projectionRegistry.register(inboxProjectionDefinition); projectionRegistry.register(turnBoundaryProjectionDefinition)
    new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false }); new AgentRegistry(ctx)
    const session = Session.create('window-root', undefined, { id: 'window-root', version: 4, cwd: root, createdAt: Date.now(), isSeeded: false })
    sessions.enter(session); sessions.announce(session)
    const agent = new ReactLoopAgent(ctx, session.id, { provider: 'fixture', model: 'fixture' }, session)
    ctx.agents.enter(agent, { dispose: async () => {} }); agent.wakeDriver = () => {}
    let tier = 0, membership = true, nativeRoot = false, rootPointer = agent
    class Teams extends Service {
      constructor(ctx) { super(ctx, 'agentTeams') }
      tryMembership(candidate) { return membership && candidate === agent ? nativeRoot
        ? { id: 'window-team', name: 'lead', role: 'lead', root: rootPointer }
        : { id: 'window-team', name: 'root', tier, root: rootPointer } : undefined }
      listMembers() { return [{ id: session.id, name: 'root', tier }] }
    }
    new Teams(ctx)
    let memoClock = 100000
    const memo = limits.installMemo ? createContextWorkspaceService(ctx, {
      directory: join(root, 'memo'), controlDir: join(root, 'control'), now: () => memoClock,
    }) : null
    if (memo) ctx.provide('contextWorkspace', memo)
    const control = controlPlaneForMember(ctx, agent, { directory: join(root, 'control') })
    const ref = (name, body) => { const path = join(root, name); writeFileSync(path, body); return { path, sha256: sha(body) } }
    const roles = join(root, 'roles'); mkdirSync(roles)
    const bodies = Object.fromEntries(['AGENTS.md', 'root.md', 'lead.md', 'member.md', 'verifier.md'].map(name => [name, name + ' effective test identity']))
    for (const [name, body] of Object.entries(bodies)) writeFileSync(join(roles, name), body)
    writeFileSync(join(roles, 'identity-version.json'), JSON.stringify({ schemaVersion: 1, identityVersion: 'collector-test-1', files: Object.fromEntries(Object.entries(bodies).map(([name, body]) => [name, sha(body)])) }))
    const identity = createActiveIdentityService({ controlPlane: control, rolesDir: roles, allowedRoots: [root], resolveActor: () => ({ name: 'root', tier, id: session.id }) })
    const proposal = identity.readonly.proposal()
    await identity.internal.activate({ expectedControlRevision: control.snapshot().revision, expectedIdentityEpoch: 0, expectedBundleHash: proposal.contentHash }, agent)
    if (limits.installNativeRuntime) {
      new ToolRuntime(ctx)
      applyTeamRuntime(ctx,{controlDir:join(root,'control'),pluginDir:root,rolesDir:roles,
        activeIdentity:{enabled:true,allowedRoots:[root]},windowHostParticipation:true,windowOsFileProtection:true,windowIsolatedSessions:[session.id]})
    } else ctx.provide('teamIdentityRuntime', { status: () => identity.readonly.snapshot() })
    const planRef = ref('plan.json', JSON.stringify({ kind: 'dsh-plan-contract', version: 1, planId: 'collector-plan', scope: ['source.mjs'],
      items: [{ requirementId: 'r1', taskRefs: [{ boardId: 'global', taskId: 't1' }], implementationRefs: ['impl'] }] }, null, 2))
    const registry = createPlanRegistry({ control, readDurable: () => readControlPlaneSnapshot(control.file), allowedRoots: [root], authorize: () => tier === 0 })
    await registry.register({ planId: 'collector-plan', expectedPlanRevision: 0, ref: planRef }, agent)
    await control.mutateHot('fixture/actual-window-authority', {}, agent, state => {
      state.boards.global = { tasks: { t1: { id: 't1', ownerName: 'root', revision: 2, status: 'in_progress', phase: 'execution', contract: { contractRevision: 3, writeScopes: ['source.mjs'] } } } }
      state.v12Requirements = { version: 1, requirements: { r1: { requirementId: 'r1', status: 'active', text: 'critical current requirement' } }, decisions: {} }
      state.v12RoomWake = { version: 1, rooms: {}, inbox: {}, wakes: {} }
      state.v12Compaction = { version: 1, jobs: {} }; state.v14Waiting = { tickets: {} }; state.v12Evidence = { version: 1, records: {} }
    }, { deferMs: 0 })
    const milestonePath = ref('milestones.json', JSON.stringify({ version: 3, teams: { [control.rootId]: { compactions: {} } } })).path
    stopMilestones = applyCompactionMilestones(ctx, { milestonePath })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', message('old-user', 'user', 'completed but raw original '.repeat(limits.historyRepeats ?? 80) + (limits.historySuffix ?? '')), { surfaceOp: 'append' })
    const oldAnswer = message('old-answer', 'assistant', 'past answer')
    if (limits.signedReasoning === true) {
      oldAnswer.content.unshift({ type: 'reasoning', text: 'fixture completed reasoning' })
      oldAnswer.source.replayState = { response: { kind: 'pi-ai', version: 2, api: 'openai-responses',
        provider: 'fixture', model: 'fixture', stopReason: 'stop' }, blocks: [
        { type: 'reasoning', thinkingSignature: JSON.stringify({ type: 'reasoning', id: 'rs_fixture', summary: [] }) }, { type: 'text' }] }
    }
    session.append('assistant/message', { turn: 1, step: 1, stream:[], message: oldAnswer }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    session.append('user/message', message('current-user', 'user', 'keep current constraint'), { surfaceOp: 'append' })
    if (limits.installNativeRuntime) {
      session.append('step/start',{turn:2,step:1})
      session.append('assistant/message',{turn:2,step:1,stream:[],message:message('current-answer','assistant','current complete answer')},{surfaceOp:'append'})
      session.append('step/end',{turn:2,step:1})
      session.append('turn/end',{turn:2,reason:{kind:'completed'}})
    }
    const backend = new Jsonl(limits.installNativeRuntime ? ctx : new Context(), { root: join(root, 'sessions'), compression: 'none' })
    handle = await backend.create(session.header)
    let persisted = 0
    if (limits.installNativeRuntime) {
      await handle.append(session.snapshotEvents()); await handle.flush()
    } else ctx.on('session/flush', async current => {
      assert.equal(current, session)
      await handle.append(session.snapshotEvents(persisted)); await handle.flush(); persisted = session.seq
    }, { global: true })
    new SessionQueryEngine(ctx)
    const llm = new official.LlmRuntime(ctx), captured = []
    llm.registerAdapter(['fixture'], new class extends official.LlmAdapter {
      providerInfo(provider) { return { id: provider, name: provider } }
      async prepareCall(provider, model) { return { model: { provider, id: model, name: model }, stream(options) {
        captured.push(options)
        return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })()
      } } }
    }())
    const projection = installRequestMessageProjection(llm, official)
    ctx.provide('requestMessageProjection', projection)
    const config = { isolated: true, sessionIds: [session.id], planBindings: { [session.id]: 'collector-plan' }, allowedRoots: [root],
      recoveryDirectory: join(root, 'recovery'), controlDirectory: join(root, 'control'), recentMessages: 1, ...limits }
    const service = createServerWindowCollector(ctx, config)
    const unregister = projection.register('collector-native-test', service.project, { order: 4, preview: service.project, onDispatch: service.onDispatch })
    cleanup = () => { unregister(); projection.dispose() }
    const request = () => official.markAgentLoopRequest({ provider: 'fixture', model: 'fixture', sessionId: session.id, purpose: 'conversation',
      signal: new AbortController().signal, messages: session.deriveMessages() })
    return { root, ctx, session, agent, service, request, control, config, captured, llm, projection, planRef,backend,
      memo, advanceMemoClock: delta => { memoClock += delta },
      closeHandle:()=>handle.close(),
      beforeCleanup:callback=>{beforeCleanup=callback},
      revoke: () => { membership = false }, changeTier: () => { tier = 2 }, restoreRoster: () => { membership = true; tier = 0 },
      officialRootShape: () => { nativeRoot = true }, wrongRoot: () => { rootPointer = {} },
      diskEvents: async () => (await handle.read()).events }
  })
}


export { fixture }

