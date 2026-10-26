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

async function surfaceFixture(t, fault, options = {}) {
  const { fixtureConfig = {}, ...surfaceOptions } = options
  const f=await fixture(t,{installNativeRuntime:true,historyRepeats:4000,protocolCertificateHash:'native-fixture-only',...fixtureConfig})
  await f.service.retainCompletedTurns(f.session.id)
  const source=f.service.authorityForSurface(f.session.id).capture(f.session.id).source
  const routes=[{provider:'fixture',model:'fixture',protocol:'dsh-v1',certificateHash:'native-fixture-only',
    configFingerprint:source.configFingerprint,expiresAt:Date.now()+60000}]
  const surface=await createServerWindowSurface(f.ctx,{collector:f.service,sessionId:f.session.id,routes,fault,...surfaceOptions})
  // A route certificate is issued for one config fingerprint; after the host changed it has to be issued again.
  const refreshRoutes=()=>{routes[0].configFingerprint=f.service.authorityForSurface(f.session.id).capture(f.session.id).source.configFingerprint}
  return {...f,surface,refreshRoutes}
}

async function reconstructSurfaceHost(t,f,{withoutMilestones=false}={}) {
  await f.closeHandle();await f.ctx.fiber.dispose()
  const ctx=new Context();let handle
  f.beforeCleanup(async()=>{await handle?.close();await ctx.fiber.dispose()})
  const rebuilt=await initializeNativeHost(ctx,async()=> {
    await ctx.plugin(Loader);ctx.loader.builtins.windowFixture=()=>{}
    await ctx.loader.create({id:'window-native-rebuilt',name:'cordis:windowFixture',config:{}})
    const sessions=new SessionStore(ctx),registry=new SessionProjectionRegistry(ctx)
    registry.register(inboxProjectionDefinition);registry.register(turnBoundaryProjectionDefinition)
    new SystemPrompt(ctx,{includeHarnessIdentity:false,includeRuntimeContext:false});new AgentRegistry(ctx);new ToolRuntime(ctx)
    const backend=new Jsonl(ctx,{root:join(f.root,'sessions'),compression:'none'})
    handle=await backend.open(f.session.id,'write')
    const disk=(await handle.read()).events
    assert.equal(handle.state.cursor,disk.length,JSON.stringify({cursor:handle.state.cursor,count:disk.length,recovered:handle.state.recoveredTail}))
    const session=Session.create(f.session.id,disk,handle.header)
    // Match AgentLoopFactory.resumeWith: persist constructor-owned suffix before publication.
    const restoredSuffix=session.snapshotEvents(disk.length)
    assert.deepEqual(restoredSuffix.map(row=>row.type),['session/end-seed'])
    await handle.append(restoredSuffix);await handle.flush()
    assert.deepEqual((await handle.read()).events,session.snapshotEvents())
    sessions.enter(session);sessions.announce(session)
    const agent=new ReactLoopAgent(ctx,session.id,{provider:'fixture',model:'fixture'},session)
    ctx.agents.enter(agent,{dispose:async()=>{}});agent.wakeDriver=()=>{}
    ctx.provide('agentTeams',{tryMembership:current=>current===agent?{id:'window-team',name:'root',tier:0,root:agent}:undefined,
      listMembers:()=>[{id:agent.id,name:'root',tier:0}]})
    const memo = f.memo ? createContextWorkspaceService(ctx, { directory: join(f.root, 'memo'), controlDir: join(f.root, 'control') }) : null
    if (memo) ctx.provide('contextWorkspace', memo)
    applyTeamRuntime(ctx,{controlDir:join(f.root,'control'),pluginDir:f.root,rolesDir:join(f.root,'roles'),
      activeIdentity:{enabled:true,allowedRoots:[f.root]},windowHostParticipation:true,windowOsFileProtection:true,windowIsolatedSessions:[session.id]})
    if(!withoutMilestones)applyCompactionMilestones(ctx,{milestonePath:join(f.root,'milestones.json')})
    const llm=new official.LlmRuntime(ctx),captured=[]
    llm.registerAdapter(['fixture'],new class extends official.LlmAdapter {
      providerInfo(provider){return{id:provider,name:provider}}
      async prepareCall(provider,model){return{model:{provider,id:model,name:model},stream(options){captured.push(options);return(async function*(){yield{type:'finish',reason:{kind:'stop'}}})()}}}
    }())
    const projection=installRequestMessageProjection(llm,official);ctx.provide('requestMessageProjection',projection)
    const collector=createServerWindowCollector(ctx,f.config)
    return {ctx,session,agent,llm,captured,collector,projection,disk,memo}
  })
  const source=rebuilt.collector.authorityForSurface(rebuilt.session.id).capture(rebuilt.session.id).source
  const surface=await createServerWindowSurface(ctx,{collector:rebuilt.collector,sessionId:rebuilt.session.id,
    routes:[{provider:'fixture',model:'fixture',protocol:'dsh-v1',certificateHash:'native-fixture-only',configFingerprint:source.configFingerprint,expiresAt:Date.now()+60000}]})
  return {...rebuilt,surface,request:()=>official.markAgentLoopRequest({provider:'fixture',model:'fixture',sessionId:rebuilt.session.id,
    purpose:'conversation',signal:new AbortController().signal,messages:rebuilt.session.deriveMessages()})}
}

// What a model reading the conversation knows to be current: the authority of the last checkpoint still in it, with
// the changes the current-authority message states applied the way that message says to apply them.
function statedAuthority(messages) {
  const current = JSON.parse(messages.findLast(row => row.source?.nativeWindowAuthority).content[0].text)
  if (current.authority && typeof current.authority === 'object') return current.authority
  const base = JSON.parse(messages.findLast(row => row.source?.nativeWindowCheckpoint).content[0].text).checkpoint.authority
  const apply = (value, delta) => {
    if (delta === undefined) return value
    if (Object.hasOwn(delta, 'set')) return delta.set
    const next = { ...value }
    for (const key of delta.removed ?? []) delete next[key]
    for (const [key, inner] of Object.entries(delta.changed ?? {})) next[key] = apply(value?.[key], inner)
    return next
  }
  return apply(base, current.authorityChanges)
}

test('server W2 uses actual Team/CP/identity, live writer and maintenance; next native request consumes committed surface',async t=> {
  const f=await surfaceFixture(t),original=f.session.snapshotEvents(),before=f.session.deriveMessages()
  const result=await f.surface.commit()
  assert.equal(result.durable,true)
  assert.equal(f.surface.status().paused,false)
  assert.equal(f.agent.phase.kind,'idle')
  assert.deepEqual(f.session.snapshotEvents().slice(0,original.length),original)
  const current=f.session.deriveMessages()
  assert.ok(!current.some(row=>row.id==='old-user'))
  assert.equal(current.at(-1).id,'current-answer')
  const checkpoint=current.find(row=>row.source?.nativeWindowCheckpoint)
  assert.equal(checkpoint.source.authorityMode,'historical-snapshot-current-authority-required')
  assert.ok(Buffer.byteLength(JSON.stringify(current))<Buffer.byteLength(JSON.stringify(before)))
  for await (const _ of f.llm.stream(f.request())) {}
  assert.deepEqual(f.captured.at(-1).messages.slice(0,-1),current)
  const currentAuthority=JSON.parse(f.captured.at(-1).messages.at(-1).content[0].text)
  assert.equal(currentAuthority.authoritative,true)
  assert.equal(statedAuthority(f.captured.at(-1).messages).phaseRefs['global:t1'].status,'in_progress')
  assert.equal(f.control.snapshot().boards.global.tasks.t1.status,'in_progress')
  const disk=await f.diskEvents()
  assert.equal(disk.filter(row=>row.data?.source?.windowCommit).length,1)
  assert.deepEqual(disk,f.session.snapshotEvents())
  assert.throws(()=>f.surface.dispose(),/CURRENT_AUTHORITY_REQUIRED/)
})

test('prepared W2 internal writer read tolerates only own intent plus ordered durable A/B/C input; public reads remain fenced',async t=> {
  let f
  f=await surfaceFixture(t,async stage=> {
    if (stage!=='prepared-durable') return
    assert.throws(()=>f.session.deriveMessages(),/WINDOW_READ_PAUSED/)
    const bridge=nativeSessionBridge(f.session)
    assert.throws(()=>bridge.readWindowSurface({}),/STALE_WRITER/)
    for (const id of ['A','B','C']) await bridge.accept(f.agent,message(id,'user',id),'next-step',false)
    assert.throws(()=>f.agent.inbox.claim('next-step',3),/WINDOW_READ_PAUSED/)
  })
  const receipt=await f.surface.commit()
  assert.deepEqual(receipt.consumedInputIds,[])
  assert.deepEqual(f.agent.inbox.nextStep.map(row=>row.id),['A','B','C'])
  assert.deepEqual((await f.diskEvents()).filter(row=>row.type==='native/input-accepted').map(row=>row.data.inputId),['A','B','C'])
  assert.throws(()=>f.surface.dispose(),/CURRENT_AUTHORITY_REQUIRED/)
})

test('durable commit recovery accepts current legal CP changes without replaying old authority; current request rebinds',async t=> {
  const f=await surfaceFixture(t,stage=>{if(stage==='commit-durable')throw new Error('after-durable')})
  await assert.rejects(f.surface.commit(),/after-durable/)
  await f.control.mutateHot('fixture/post-commit-update',{},f.agent,state=>{state.boards.global.tasks.t1.status='blocked'},{deferMs:0})
  const before=f.session.snapshotEvents(),revision=f.control.snapshot().revision
  assert.equal((await f.surface.recover()).state,'committed')
  assert.deepEqual(f.session.snapshotEvents(),before)
  assert.equal(f.control.snapshot().revision,revision)
  assert.equal((await f.surface.recover()).state,'clean')
  for await (const _ of f.llm.stream(f.request())) {}
  assert.equal(f.captured.length,1)
  assert.equal(f.service.capture(f.request()).checkpoint.authority.phaseRefs['global:t1'].status,'blocked')
  assert.equal(statedAuthority(f.captured.at(-1).messages).phaseRefs['global:t1'].status,'blocked')
  assert.throws(()=>f.surface.dispose(),/CURRENT_AUTHORITY_REQUIRED/)
})

test('server W2 refuses foreign session, active work, late plan source change and current ACL loss',async t=> {
  const f=await surfaceFixture(t)
  await assert.rejects(createServerWindowSurface(f.ctx,{collector:f.service,sessionId:'foreign',routes:[]}),/NOT_ALLOWED/)
  const previous=f.agent.phase; f.agent.phase={kind:'running'}
  await assert.rejects(f.surface.commit(),/active work/)
  f.agent.phase=previous
  writeFileSync(f.planRef.path,'{"changed":true}')
  await assert.rejects(f.surface.commit(),/PLAN_REF|HASH|SOURCE/)
  assert.equal(f.session.snapshotEvents().filter(row=>row.type==='native/window-intent').length,0)
  f.revoke()
  const count=f.captured.length,chunks=[]
  for await (const chunk of f.llm.stream(f.request())) chunks.push(chunk)
  assert.equal(f.captured.length,count)
  assert.ok(chunks.some(chunk=>chunk.type==='finish'&&chunk.reason.kind==='error'))
  f.surface.dispose()
})

test('server W2 settles already accepted deferred CP changes before making its current proposal',async t=> {
  const f=await surfaceFixture(t)
  const old=f.control.windowSnapshot().revision
  await f.control.mutateHot('fixture/deferred-current-change',{},f.agent,state=>{state.boards.global.tasks.t1.status='blocked'}, {deferMs:10000})
  assert.equal(f.control.windowSnapshot().revision,old)
  const result=await f.surface.commit()
  assert.equal(result.durable,true)
  const checkpoint=f.session.deriveMessages().find(row=>row.source?.nativeWindowCheckpoint).source.nativeWindowCheckpoint
  assert.equal(checkpoint.authority.phaseRefs['global:t1'].status,'blocked')
  assert.ok(checkpoint.criticalRevisionVector.controlRevision>old)
})

for(const stage of ['prepared-durable','commit-durable'])test('real host reconstruction after '+stage+' acquires new owner/current authority and preserves exact durable history',async t=> {
  const f=await surfaceFixture(t,at=>{if(at===stage)throw new Error('host-crash-boundary')})
  const oldOwner=nativeHostBinding(f.ctx).ownerId
  await assert.rejects(f.surface.commit(),/host-crash-boundary/)
  await f.control.mutateHot('fixture/legitimate-revision-before-rebuild',{},f.agent,state=>{state.boards.global.tasks.t1.status='blocked'}, {deferMs:0})
  const original=await f.diskEvents(),revision=f.control.snapshot().revision
  const rebuilt=await reconstructSurfaceHost(t,f)
  assert.notEqual(nativeHostBinding(rebuilt.ctx).ownerId,oldOwner)
  assert.equal(rebuilt.surface.status().paused,true)
  assert.throws(()=>rebuilt.session.deriveMessages(),/WINDOW_READ_PAUSED/)
  const result=await rebuilt.surface.recover()
  assert.equal(result.state,stage==='prepared-durable'?'aborted':'committed')
  assert.deepEqual(rebuilt.session.snapshotEvents().slice(0,original.length),original)
  assert.equal(f.control.snapshot().revision,revision)
  assert.equal(rebuilt.session.deriveMessages().at(-1).id,'current-answer')
  assert.equal(rebuilt.session.deriveMessages().some(row=>row.id==='old-user'),stage==='prepared-durable')
  for await(const _ of rebuilt.llm.stream(rebuilt.request())){}
  assert.equal(rebuilt.captured.length,1)
  if(stage==='commit-durable')assert.equal(statedAuthority(rebuilt.captured[0].messages).phaseRefs['global:t1'].status,'blocked')
  assert.equal((await rebuilt.surface.recover()).state,'clean')
})

test('native window adapter guard rejects a dropped current authority body before actual adapter entry',async t=> {
  const f=await surfaceFixture(t);await f.surface.commit()
  const original=f.llm.forAdapter
  f.llm.forAdapter=function(options,adapter) {
    const forwarded=original.call(this,options,adapter)
    return {...forwarded,messages:forwarded.messages.filter(row=>!row.source?.nativeWindowAuthority)}
  }
  const chunks=[]
  for await(const chunk of f.llm.stream(f.request()))chunks.push(chunk)
  assert.equal(f.captured.length,0)
  assert.ok(chunks.some(row=>row.type==='finish'&&row.reason.kind==='error'))
})

test('live abort persistence failure stays fenced and cannot become durable through a recovery retry',async t=> {
  const f=await surfaceFixture(t,stage=>{if(stage==='prepared-durable')throw new Error('prepared-crash')})
  await assert.rejects(f.surface.commit(),/prepared-crash/)
  const original=f.backend.persistBatch;let attempts=0
  f.backend.persistBatch=async()=>{attempts++;throw new Error('abort-disk-failure')}
  await assert.rejects(f.surface.recover(),/abort-disk-failure/)
  assert.equal(attempts,1)
  assert.equal(f.surface.status().paused,true)
  assert.throws(()=>f.session.deriveMessages(),/WINDOW_READ_PAUSED/)
  assert.equal(f.session.snapshotEvents().filter(row=>row.type==='native/window-aborted').length,1)
  assert.equal((await f.diskEvents()).filter(row=>row.type==='native/window-aborted').length,0)
  await assert.rejects(f.surface.recover(),/WINDOW_RECOVERY_REQUIRED/)
  assert.equal(attempts,1)
  f.backend.persistBatch=original
  await f.backend.flush()
  assert.equal((await f.surface.recover()).state,'aborted')
  assert.deepEqual(await f.diskEvents(),f.session.snapshotEvents())
  assert.equal((await f.surface.recover()).state,'clean')
})

test('historical durable commit can be confirmed when current source is unavailable, but successor adapter remains closed',async t=> {
  const f=await surfaceFixture(t,stage=>{if(stage==='commit-durable')throw new Error('committed-crash')})
  await assert.rejects(f.surface.commit(),/committed-crash/)
  const rebuilt=await reconstructSurfaceHost(t,f,{withoutMilestones:true})
  assert.equal((await rebuilt.surface.recover()).state,'committed')
  const chunks=[]
  for await(const chunk of rebuilt.llm.stream(rebuilt.request()))chunks.push(chunk)
  assert.equal(rebuilt.captured.length,0)
  assert.ok(chunks.some(row=>row.type==='finish'&&row.reason.kind==='error'))
})

test('actual root CP/plan/identity and native surface supply W0 authority; preview never writes or mutates journal', async t => {
  const f = await fixture(t), original = f.session.snapshotEvents(), revisions = f.control.snapshot().revision
  const result = f.service.capture(f.request())
  assert.equal(result.checkpoint.authority.phaseRefs['global:t1'].status, 'in_progress')
  assert.equal(result.checkpoint.authority.requirementRefs.r1.text, 'critical current requirement')
  assert.equal(result.checkpoint.identityVersion, 'collector-test-1')
  assert.equal(result.source.completedSpans.length, 0)
  assert.ok(result.checkpoint.recovery.memoryDebt.some(row => row.kind === 'completed-turn-retention-required'))
  assert.ok(result.source.recentTailIds.includes('current-user'))
  assert.equal(existsSync(f.config.recoveryDirectory), false)
  assert.equal(f.service.audit().length, 0)
  assert.equal(f.control.snapshot().revision, revisions)
  assert.deepEqual(f.session.snapshotEvents(), original)
})

test('host surface authority reads current native messages without accepting caller history or dispatch claims',async t=> {
  const f=await fixture(t)
  await f.service.retainCompletedTurns(f.session.id)
  const authority=f.service.authorityForSurface(f.session.id),captured=authority.capture(f.session.id)
  assert.deepEqual(captured.source.messages,f.session.deriveMessages())
  assert.equal(captured.source.completedSpans.length,1)
  assert.equal(f.service.readSnapshot(f.session.id),null)
  assert.equal(f.service.audit().length,0)
  assert.throws(()=>authority.capture('foreign'),/SESSION_DENIED/)
  f.session.append('user/message',message('later-correction','user','current authoritative correction'),{surfaceOp:'append'})
  assert.throws(()=>authority.validate(captured.checkpoint),/SOURCE_CAS_CONFLICT/)
  assert.ok(authority.capture(f.session.id).source.messages.some(row=>row.id==='later-correction'))
  f.revoke()
  assert.throws(()=>authority.capture(f.session.id),/ROOT_ONLY/)
})

test('fsynced/readback original artifacts enable exact spans; restore is own-session ACL-bound and survives service recreation', async t => {
  const f = await fixture(t), original = f.session.snapshotEvents(), retained = await f.service.retainCompletedTurns(f.session.id)
  assert.equal(retained.receipts.length, 1)
  assert.deepEqual((await f.diskEvents()).slice(0, original.length), original)
  const options = f.request(), authority = f.service.authorityFor(options), result = authority.capture(f.session.id)
  assert.equal(result.source.completedSpans.length, 1)
  assert.deepEqual(result.source.completedSpans[0].messageIds, ['old-user', 'old-answer'])
  assert.equal(authority.validate(result.checkpoint).checkpoint.checkpointId, result.checkpoint.checkpointId)
  const restored = createServerWindowCollector(f.ctx, f.config)
  assert.deepEqual(restored.readRecovery(f.session.id, retained.receipts[0]), original.filter(event => event.seq < original.find(row => row.type === 'turn/start' && row.data.turn === 2).seq))
  assert.equal(restored.capture(f.request()).source.completedSpans.length, 1)
  assert.deepEqual(f.session.snapshotEvents(), original)
  f.revoke()
  assert.throws(() => restored.readRecovery(f.session.id, retained.receipts[0]), /ROOT_ONLY/)
  f.restoreRoster(); f.changeTier()
  assert.throws(() => restored.capture(f.request()), /ROOT_ONLY/)
})

test('durable original events do not stand in for retention of context memo references', async t => {
  const f = await fixture(t)
  await f.service.retainCompletedTurns(f.session.id)
  const locator = 'context://' + 'a'.repeat(24) + '/working@1/' + 'b'.repeat(64)
  await f.control.mutateHot('fixture/required-memo', {}, f.agent, state => {
    state.v12Requirements.requirements.r1.text = 'Required recovery source ' + locator
  }, { deferMs: 0 })
  const captured = f.service.capture(f.request())
  assert.equal(captured.source.completedSpans.length, 0)
  assert.ok(captured.checkpoint.recovery.memoryDebt.some(row => row.kind === 'context-retention-required' && row.locator === locator))
  const cold = createServerWindowCollector(f.ctx, f.config)
  assert.equal(cold.capture(f.request()).source.completedSpans.length, 0)
  assert.deepEqual((await f.diskEvents()), f.session.snapshotEvents())
})

test('retention preparation automatically pins the final memo dependency closure while previews stay pure', async t => {
  const f = await fixture(t, { installMemo: true })
  const row = f.memo.manage(f.agent, { action: 'memo_put', input: { sourceId: 'recovery', expectedRevision: 0, text: 'must recover exactly', ttlMs: 10 } })
  assert.equal(row.ok, true, JSON.stringify(row))
  await f.control.mutateHot('fixture/retained-memo', {}, f.agent, state => {
    state.v12Requirements.requirements.r1.text = 'Required recovery source ' + row.locator
  }, { deferMs: 0 })
  assert.equal(f.service.capture(f.request()).source.completedSpans.length, 0)
  const retained = await f.service.retainCompletedTurns(f.session.id)
  assert.equal(retained.memoReceipts.length, 1)
  const captured = f.service.capture(f.request())
  assert.equal(captured.source.completedSpans.length, 1)
  assert.deepEqual(captured.checkpoint.recovery.memoRetentionReceipts, retained.memoReceipts)
  const files = f.memo.retentionFiles(f.agent), before = files.map(path => readFileSync(path, 'utf8'))
  f.advanceMemoClock(11)
  assert.equal(createServerWindowCollector(f.ctx, f.config).capture(f.request()).source.completedSpans.length, 1)
  assert.deepEqual(files.map(path => readFileSync(path, 'utf8')), before)
  assert.ok(files.every(path => f.service.protectionFiles(f.session.id).includes(path)))
  f.memo.releaseRecovery(f.agent, retained.memoReceipts[0])
  const refused = f.service.capture(f.request())
  assert.equal(refused.source.completedSpans.length, 0)
  assert.ok(refused.checkpoint.recovery.memoryDebt.some(debt => debt.kind === 'context-retention-required'))
})

test('a newly eligible unretained step stays raw without blocking older fully retained spans', async t => {
  const f = await fixture(t)
  f.session.append('step/start', { turn: 2, step: 1 })
  f.session.append('assistant/message', { turn: 2, step: 1, stream: [], message: {
    ...message('recent-call', 'assistant', 'a recent tool call'),
    content: [{ type: 'tool-call', id: 'recent-tool', name: 'fixture_read', arguments: '{}' }],
  } }, { surfaceOp: 'append' })
  f.session.append('tool/result', { turn: 2, step: 1, message: { id: 'recent-result', role: 'tool', toolCallId: 'recent-tool',
    source: { kind: 'tool', callId: 'recent-tool' }, content: [{ type: 'text', text: 'keep the unretained result raw' }] } }, { surfaceOp: 'append' })
  f.session.append('step/end', { turn: 2, step: 1 })
  f.session.append('step/start', { turn: 2, step: 2 })
  f.session.append('assistant/message', { turn: 2, step: 2, stream: [], message: message('recent-final', 'assistant', 'final recent answer') }, { surfaceOp: 'append' })
  f.session.append('step/end', { turn: 2, step: 2 }); f.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  await f.service.retainCompletedTurns(f.session.id)
  f.session.append('turn/start', { turn: 3 })
  f.session.append('user/message', message('new-user', 'user', 'new turn shifts the protected tail'), { surfaceOp: 'append' })
  const captured = f.service.capture(f.request())
  assert.ok(captured.source.completedSpans.length > 0, JSON.stringify(captured.checkpoint.recovery))
  assert.ok(captured.source.completedSpans.some(span => span.messageIds.includes('old-user')))
  assert.ok(captured.source.completedSpans.every(span => !span.messageIds.includes('recent-call') && !span.messageIds.includes('recent-result')))
  assert.ok(captured.checkpoint.recovery.deferredCompletedTurnRetention.some(row => row.turn === 2))
  assert.equal(captured.checkpoint.recovery.memoryDebt.length, 0)
})

test('the actual native commit fence protects retained memo content and permits revocation after release', async t => {
  let f, pin, row, releaseError, attempted = false
  f = await surfaceFixture(t, stage => {
    if (stage !== 'prepared-durable' || attempted) return
    attempted = true
    try { f.memo.releaseRecovery(f.agent, pin) } catch (error) { releaseError = error }
  }, { fixtureConfig: { installMemo: true } })
  row = f.memo.manage(f.agent, { action: 'memo_put', input: { sourceId: 'fenced', expectedRevision: 0, text: 'durable fenced body', ttlMs: 10 } })
  assert.equal(row.ok, true, JSON.stringify(row))
  await f.control.mutateHot('fixture/fenced-memo', {}, f.agent, state => {
    state.v12Requirements.requirements.r1.text = 'Need exact recovery ' + row.locator
  }, { deferMs: 0 })
  const retained = await f.service.retainCompletedTurns(f.session.id)
  pin = retained.memoReceipts[0]
  f.advanceMemoClock(11)
  f.refreshRoutes()
  const receipt = await f.surface.commit()
  assert.equal(receipt.state, 'COMMITTED')
  assert.equal(attempted, true)
  assert.ok(releaseError, 'the real fence must reject the concurrent durable replacement')
  assert.equal(f.memo.readRecovery(f.agent, pin).sources[0].text, 'durable fenced body')
  assert.deepEqual(await f.diskEvents(), f.session.snapshotEvents())
  const revoked = f.memo.manage(f.agent, { action: 'memo_put', input: { sourceId: 'fenced', expectedRevision: 1, deleted: true } })
  assert.equal(revoked.ok, true, JSON.stringify(revoked))
  assert.throws(() => f.memo.readRecovery(f.agent, pin), /SOURCE_DELETED/)
  assert.ok(f.service.authorityForSurface(f.session.id).capture(f.session.id).checkpoint.recovery.memoryDebt.some(debt => debt.kind === 'context-retention-required'))
})

test('preparation renews live pins and automatically retires only superseded unreferenced owners', async t => {
  const f = await fixture(t, { installMemo: true })
  const note = id => f.memo.manage(f.agent, { action: 'memo_put', input: { sourceId: id, expectedRevision: 0, text: id, ttlMs: 10 } })
  const a = note('a'), b = note('b')
  const requireSource = row => f.control.mutateHot('fixture/recovery-owner', {}, f.agent, state => {
    state.v12Requirements.requirements.r1.text = row.locator
  }, { deferMs: 0 })
  await requireSource(a)
  const first = await f.service.retainCompletedTurns(f.session.id)
  assert.equal(first.memoReceipts.length, 1)
  assert.deepEqual((await f.service.retainCompletedTurns(f.session.id)).memoReceipts, first.memoReceipts)
  await requireSource(b)
  const second = await f.service.retainCompletedTurns(f.session.id)
  assert.deepEqual(second.retiredMemoReceiptIds, [first.memoReceipts[0].id])
  assert.throws(() => f.memo.readRecovery(f.agent, first.memoReceipts[0]), /RECOVERY_PIN_UNAVAILABLE/)
  f.advanceMemoClock(11)
  assert.equal(f.memo.manage(f.agent, { action: 'memo_get', input: { locator: a.locator } }).code, 'SOURCE_EXPIRED')
  assert.equal(f.memo.readRecovery(f.agent, second.memoReceipts[0]).sources[0].text, 'b')
})

test('a committed window keeps its exact memo retention through native host and JSONL reconstruction', async t => {
  const f = await surfaceFixture(t, undefined, { fixtureConfig: { installMemo: true } })
  const row = f.memo.manage(f.agent, { action: 'memo_put', input: { sourceId: 'committed', expectedRevision: 0, text: 'checkpoint original body', ttlMs: 10 } })
  await f.control.mutateHot('fixture/committed-memo', {}, f.agent, state => {
    state.v12Requirements.requirements.r1.text = row.locator
  }, { deferMs: 0 })
  const retained = await f.service.retainCompletedTurns(f.session.id), pin = retained.memoReceipts[0]
  f.advanceMemoClock(11)
  f.refreshRoutes()
  assert.equal((await f.surface.commit()).state, 'COMMITTED')
  const restored = await reconstructSurfaceHost(t, f)
  assert.equal(restored.memo.readRecovery(restored.agent, pin).sources[0].text, 'checkpoint original body')
  assert.equal((await restored.surface.recover()).state, 'committed')
  const retainedAgain = await restored.collector.retainCompletedTurns(restored.session.id)
  assert.ok(!retainedAgain.retiredMemoReceiptIds.includes(pin.id))
  assert.deepEqual(restored.memo.readRecovery(restored.agent, pin).receipt, pin)
})

for (const kind of ['no-memo', 'folded-memo', 'settled-only-memo']) test('live recovery dependency closure: ' + kind, async t => {
  const locator = 'context://' + 'a'.repeat(24) + '/working@1/' + 'b'.repeat(64)
  const f = await fixture(t, { authorityDetail: 'live', historySuffix: kind === 'folded-memo' ? locator : '' })
  await f.service.retainCompletedTurns(f.session.id)
  if (kind === 'settled-only-memo') await f.control.mutateHot('fixture/settled-memo', {}, f.agent, state => {
    state.boards.global.tasks.settled = { id: 'settled', ownerName: 'root', revision: 1, status: 'completed', notes: locator }
  }, { deferMs: 0 })
  for (const collector of [f.service, createServerWindowCollector(f.ctx, f.config)]) {
    const captured = collector.capture(f.request())
    assert.equal(JSON.stringify(captured.source.authority).includes(locator), false)
    const memoDebt = captured.checkpoint.recovery.memoryDebt.filter(row => row.kind === 'context-retention-required')
    assert.equal(captured.source.completedSpans.length, kind === 'folded-memo' ? 0 : 1)
    assert.equal(memoDebt.length, kind === 'folded-memo' ? 1 : 0)
  }
  assert.deepEqual(await f.diskEvents(), f.session.snapshotEvents())
})

test('actual immutable preparation/dispatch keeps every raw message; preview/uniterated calls create no dispatch receipt', async t => {
  const f = await fixture(t)
  await f.service.retainCompletedTurns(f.session.id)
  const options = f.request(), before = plainMessages(options.messages)
  f.projection.preview(options)
  const stream = f.llm.stream(options)
  assert.equal(f.service.audit().length, 0)
  assert.equal(f.captured.length, 0)
  for await (const _ of stream) {}
  assert.equal(f.service.audit().length, 1)
  assert.equal(f.service.audit()[0].status, 'shadow')
  assert.equal(f.service.audit()[0].actual.handedToAdapter, true)
  assert.equal(f.service.audit()[0].changedMessages, false)
  assert.deepEqual(f.captured[0].messages, before)
  assert.deepEqual(f.session.deriveMessages(), before)
})
const plainMessages = messages => structuredClone(messages)

test('W1 reasoning remains blocked by default; exact whole-turn server proof is required for a bounded isolated projection', async t => {
  const f = await fixture(t, { protocolCertificateHash: 'reasoning-fixture-only', historyRepeats: 4000, signedReasoning: true })
  await f.service.retainCompletedTurns(f.session.id)
  const snapshot = f.service.capture(f.request())
  const routes = [{ provider: 'fixture', model: 'fixture', protocol: 'deepseek-dsh-v1',
    certificateHash: 'reasoning-fixture-only', configFingerprint: snapshot.source.configFingerprint, expiresAt: Date.now() + 60000,
    reasoningPolicy: 'whole-completed-turn-v1' }]
  const config = { projection: f.projection, llm: f.llm, authorityFor: f.service.authorityFor, mode: 'W1', sessions: [f.session.id], routes }
  const blocked = installWindowProjection(config)
  assert.equal(blocked.preview(f.request()).blockedReason, 'WINDOW_REASONING_RETENTION_REQUIRED')
  blocked.dispose()
  const allowed = installWindowProjection({ ...config, proveReasoningSpan: proveCompletedReasoningSpan })
  t.after(() => allowed.dispose())
  const original = f.session.snapshotEvents(), prepared = f.request()
  assert.equal(allowed.preview(prepared).status, 'projected')
  for await (const _ of f.llm.stream(prepared)) {}
  assert.equal(allowed.audit().at(-1).status, 'projected')
  assert.ok(!f.captured.at(-1).messages.some(message => message.id === 'old-answer'))
  assert.deepEqual(f.session.snapshotEvents(), original)
})

test('W1 binds each official request to actual collector authority and native actor; late native effects block dispatch', async t => {
  const f = await fixture(t, { protocolCertificateHash: 'native-fixture-only', historyRepeats: 4000 })
  await f.service.retainCompletedTurns(f.session.id)
  // Large original text makes this a reduction test, not a production certificate.
  const snapshot = f.service.capture(f.request())
  const window = installWindowProjection({ projection: f.projection, llm: f.llm,
    authorityFor: f.service.authorityFor, mode: 'W1', sessions: [f.session.id],
    routes: [{ provider: 'fixture', model: 'fixture', protocol: 'dsh-v1', certificateHash: 'native-fixture-only',
      configFingerprint: snapshot.source.configFingerprint, expiresAt: Date.now() + 60000 }] })
  t.after(() => window.dispose())
  const original = f.session.snapshotEvents(), options = f.request()
  assert.equal(options.actorId, undefined)
  const plan = window.preview(options)
  assert.equal(plan.status, 'projected', plan.blockedReason)
  assert.equal(plan.checkpoint.actorId, f.agent.id)
  for await (const _ of f.llm.stream(options)) {}
  assert.equal(window.audit().at(-1).status, 'projected')
  assert.ok(f.captured.at(-1).messages.some(message => message.source?.windowCheckpoint))
  assert.ok(!f.captured.at(-1).messages.some(message => message.id === 'old-user'))
  assert.deepEqual(f.session.snapshotEvents(), original)
  const forged = f.request(); forged.actorId = 'foreign'
  assert.equal(window.preview(forged).blockedReason, 'WINDOW_ACTOR_MISMATCH')
  const unknown = f.request(); unknown.purpose = 'compaction'
  assert.equal(window.preview(unknown).blockedReason, 'WINDOW_PURPOSE_NOT_ALLOWED')
  f.projection.register('late-native-authority-change', request => {
    f.session.append('native/tool-effect', { scope: 'late-server-binding-test', revision: 1 })
    return { messages: request.messages }
  }, { order: 99 })
  const capturedBefore = f.captured.length
  const chunks = []
  for await (const chunk of f.llm.stream(f.request())) chunks.push(chunk)
  assert.ok(chunks.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'error'))
  assert.equal(f.captured.length, capturedBefore)
})

test('request brand, exact registered source plan and current authority are not caller-substitutable', async t => {
  const f = await fixture(t), options = f.request()
  assert.throws(() => f.service.capture({ ...options }), /REQUEST_BRAND/)
  const foreign = official.markAgentLoopRequest({ ...options, sessionId: 'foreign' })
  assert.throws(() => f.service.capture(foreign), /SESSION_DENIED/)
  const authority = f.service.authorityFor(options), checkpoint = authority.capture(f.session.id).checkpoint
  await f.control.mutateHot('fixture/current-task-changed', {}, f.agent, state => { state.boards.global.tasks.t1.status = 'blocked' }, { deferMs: 0 })
  assert.throws(() => authority.validate(checkpoint), /SOURCE_CAS_CONFLICT/)
  writeFileSync(f.planRef.path, '{"changed":true}')
  assert.throws(() => f.service.capture(f.request()), /PLAN_REF|HASH|SOURCE/)
})

test('missing late authority domains and current history debt forbid exclusions, never default to clean coverage', async t => {
  const f = await fixture(t)
  await f.service.retainCompletedTurns(f.session.id)
  await f.control.mutateHot('fixture/late-domain-unavailable', {}, f.agent, state => { state.v14Waiting = {} }, { deferMs: 0 })
  const missing = f.service.capture(f.request())
  assert.equal(missing.source.completedSpans.length, 0)
  assert.ok(missing.checkpoint.recovery.memoryDebt.some(row => row.source === 'waiting'))
  await f.control.mutateHot('fixture/unread-required-history', {}, f.agent, state => {
    state.v14Waiting = { tickets: {} }
    state.v15HistoryRecall = { debts: { h: { status: 'required', readerSessionId: f.session.id, sourceRef: { seq: 1 } } } }
  }, { deferMs: 0 })
  const debt = f.service.capture(f.request())
  assert.equal(debt.source.completedSpans.length, 0)
  assert.ok(debt.checkpoint.recovery.memoryDebt.some(row => row.kind === 'history-recall'))
})

test('tampered recovery body and foreign receipts are refused', async t => {
  const f = await fixture(t), retained = await f.service.retainCompletedTurns(f.session.id), receipt = retained.receipts[0]
  assert.throws(() => f.service.readRecovery(f.session.id, { ...receipt, acl: { ...receipt.acl, rootTeamId: 'foreign' } }), /RECEIPT_INVALID/)
  const path = join(f.config.recoveryDirectory, receipt.id + '.json'), body = JSON.parse(readFileSync(path, 'utf8'))
  body.events.find(event => event.type === 'user/message').data.content[0].text = 'forged original'
  writeFileSync(path, JSON.stringify(body))
  assert.throws(() => f.service.readRecovery(f.session.id, receipt), /ARTIFACT_INVALID/)
  assert.throws(() => f.service.capture(f.request()), /ARTIFACT_INVALID/)
  f.session.append('turn/end', { turn: 2, reason: { kind: 'cancelled' } })
  await assert.rejects(f.service.retainCompletedTurns(f.session.id), /ARTIFACT_INVALID/)
})

test('cancelled/incomplete turns are never marked completed; current queued input stays authoritative and unconsumed', async t => {
  const f = await fixture(t)
  f.session.append('turn/end', { turn: 2, reason: { kind: 'cancelled' } })
  const retained = await f.service.retainCompletedTurns(f.session.id)
  assert.equal(retained.receipts.length, 1)
  assert.equal(f.service.readRecovery(f.session.id, retained.receipts[0]).some(event => event.type === 'turn/start' && event.data.turn === 2), false)
  f.agent.inbox.append('next-step', message('pending-new', 'user', 'pending current correction'))
  const before = f.session.snapshotEvents(), result = f.service.capture(f.request())
  assert.equal(result.checkpoint.authority.pendingAcceptanceRefs.input.nextStep, 1)
  assert.equal(result.checkpoint.authority.pendingAcceptanceRefs.inbox.nextStep[0].id, 'pending-new')
  assert.deepEqual(f.session.snapshotEvents(), before)
  assert.equal(f.agent.inbox.nextStep[0].content[0].text, 'pending current correction')
})

test('native authority boundary and actual host config epoch changes invalidate prior checkpoints', async t => {
  const f = await fixture(t), authority = f.service.authorityFor(f.request())
  const old = authority.capture(f.session.id).checkpoint
  f.session.append('native/tool-effect', { callId: 'side-effect', status: 'uncertain' })
  assert.throws(() => authority.validate(old), /SOURCE_CAS_CONFLICT/)
  const latest = authority.capture(f.session.id).checkpoint
  await initializeNativeHost(f.ctx, () => { f.ctx.provide('fixtureConfigChange', { version: 2 }) })
  assert.throws(() => authority.validate(latest), /SOURCE_CAS_CONFLICT/)
})

test('official lead membership without tier is a root only with its exact live root credential', async t => {
  const f = await fixture(t)
  f.officialRootShape()
  assert.equal(f.service.capture(f.request()).checkpoint.rootTeamId, 'window-team')
  f.wrongRoot()
  assert.throws(() => f.service.capture(f.request()), /ROOT_ONLY/)
})

test('artifact/checkpoint budgets stop with explicit debt or refusal; collector off has no runtime effect', async t => {
  const f = await fixture(t, { maxRecoveryBytes: 64, maxCheckpointBytes: 64 })
  await assert.rejects(f.service.retainCompletedTurns(f.session.id), /ARTIFACT_BUDGET/)
  assert.throws(() => f.service.capture(f.request()), /CHECKPOINT_BUDGET/)
  assert.equal(existsSync(f.config.recoveryDirectory), false)
  const before = hash(f.session.snapshotEvents())
  const dispose = applyCollector(f.ctx, { enabled: false })
  dispose(); dispose()
  assert.equal(f.ctx.get('windowCheckpointRuntime'), undefined)
  assert.equal(hash(f.session.snapshotEvents()), before)
})

// Natural run ab-s2window-treat-r2-20261006: the very first request of a session that had no committed window
// died with WINDOW_SOURCE_CAS_CONFLICT because an unrelated journal append landed between prepare and adapter entry.
for (const [label, racer] of [
  ['session title', f => f.session.append('session/title', { title: 'late title' })],
  ['uncertain native effect', f => f.session.append('native/tool-effect', { callId: 'late-effect', status: 'uncertain' })],
]) {
  test('before any window commit a concurrent ' + label + ' append cannot fail the request: nothing window-specific was injected', async t => {
    const f = await surfaceFixture(t), original = f.llm.forAdapter
    let raced = false
    f.llm.forAdapter = function(options, adapter) {
      if (!raced) { raced = true; racer(f) }
      return original.call(this, options, adapter)
    }
    const chunks = []
    for await (const chunk of f.llm.stream(f.request())) chunks.push(chunk)
    assert.equal(raced, true)
    assert.ok(!chunks.some(row => row.type === 'finish' && row.reason.kind === 'error'), 'request must not end in an error')
    assert.equal(f.captured.length, 1)
    assert.ok(!f.captured[0].messages.some(row => row.source?.nativeWindowAuthority || row.source?.nativeWindowCheckpoint))
  })
}

test('a refused dispatch names which bindings moved; a source that moves inside the adapter boundary itself is still refused', async t => {
  const f = await surfaceFixture(t); await f.surface.commit()
  const authority = f.service.authorityFor(f.request()), old = authority.capture(f.session.id).checkpoint
  f.session.append('native/tool-effect', { callId: 'late-effect', status: 'uncertain' })
  assert.throws(() => authority.validate(old), error => error.code === 'WINDOW_SOURCE_CAS_CONFLICT'
    && error.changed.includes('criticalRevisionVector') && error.changedRevisions.length > 0)
  const original = f.llm.forAdapter
  let raced = false
  f.llm.forAdapter = function(options, adapter) {
    if (!raced) { raced = true; f.session.append('native/tool-effect', { callId: 'later-effect', status: 'uncertain' }) }
    return original.call(this, options, adapter)
  }
  const chunks = []
  for await (const chunk of f.llm.stream(f.request())) chunks.push(chunk)
  assert.equal(f.captured.length, 0)
  assert.ok(chunks.some(row => row.type === 'finish' && row.reason.kind === 'error'))
})

test('after a committed window, ordinary movement between prepare and adapter entry restates current authority instead of failing the turn', async t => {
  const f = await surfaceFixture(t); await f.surface.commit()
  const prepared = f.service.authorityFor(f.request()).capture(f.session.id).checkpoint
  // A later registration runs after the admission transform and before adapter entry: exactly the racing gap.
  let raced = 0
  const stop = f.ctx.requestMessageProjection.register('test-late-source-movement', options => {
    if (options.sessionId === f.session.id && !raced++) f.session.append('native/tool-effect', { callId: 'late-effect', status: 'uncertain' })
    return { messages: options.messages }
  }, { order: 9 })
  t.after(stop)
  const chunks = []
  for await (const chunk of f.llm.stream(f.request())) chunks.push(chunk)
  assert.equal(raced, 1)
  assert.ok(!chunks.some(row => row.type === 'finish' && row.reason.kind === 'error'), 'the turn must not fail')
  assert.equal(f.captured.length, 1)
  const delivered = f.captured[0].messages.filter(row => row.source?.nativeWindowAuthority)
  assert.equal(delivered.length, 1)
  const stated = JSON.parse(delivered[0].content[0].text)
  const current = f.service.authorityFor(f.request()).capture(f.session.id).checkpoint
  assert.equal(delivered[0].source.nativeWindowAuthority, current.checkpointIntegrityHash, 'the delivered authority is the current one')
  assert.notEqual(delivered[0].source.nativeWindowAuthority, prepared.checkpointIntegrityHash)
  assert.equal(stated.windowId, prepared.windowId)
})

// --- W2 commit binds the host optimistically (no host-wide read lease) ---------------------------------------------
// "Foreign host writer" below is what any other session does all the time on a shared host: install a prompt section
// or a tool. It goes through the host lifecycle gate and moves the host epoch.
const foreignWriter = (f, n) => f.ctx.systemPrompt.section({ name: 'foreign-session-' + n, order: 50 + n, text: 'foreign session persona ' + n })
const journal = events => ({ intents: events.filter(row => row.type === 'native/window-intent').length,
  aborted: events.filter(row => row.type === 'native/window-aborted').length,
  commits: events.filter(row => row.data?.source?.windowCommit).length })

test('optimistic_commit_idle_host_first_attempt', async t => {
  const f = await surfaceFixture(t), before = nativeHostBinding(f.ctx).epoch
  const receipt = await f.surface.commit()
  assert.equal(receipt.state, 'COMMITTED')
  assert.equal(nativeHostBinding(f.ctx).epoch, before, 'a commit on an idle host must not move the host epoch itself')
  assert.deepEqual(journal(await f.diskEvents()), { intents: 1, aborted: 0, commits: 1 })
})

test('foreign_register_during_intent_fsync_succeeds_and_aborts', async t => {
  let f, fired = false
  f = await surfaceFixture(t, stage => { if (stage === 'prepared-durable' && !fired) { foreignWriter(f, 1); fired = true } })
  const error = await f.surface.commit().then(() => null, failure => failure)
  assert.equal(fired, true, 'the foreign registration itself did not throw')
  assert.equal(error?.transitionAborted, true, String(error?.stack ?? error))
  assert.equal(error.code, 'WINDOW_SOURCE_CAS_CONFLICT', 'the moved host epoch is what the commit step saw')
  assert.deepEqual(journal(await f.diskEvents()), { intents: 1, aborted: 1, commits: 0 })
  assert.deepEqual(await f.diskEvents(), f.session.snapshotEvents())
})

test('aborted_transition_leaves_session_readable', async t => {
  let f, fired = false, now = 1000
  f = await surfaceFixture(t, stage => { if (stage === 'prepared-durable' && !fired) { fired = true; foreignWriter(f, 1) } }, { clock: () => now })
  const error = await f.surface.commit().then(() => null, failure => failure)
  assert.equal(error?.transitionAborted, true)
  assert.equal(error.retryable, true)
  assert.equal(f.surface.status().paused, false)
  assert.ok(f.session.deriveMessages().some(row => row.id === 'old-user'), 'readable without recover(), old surface intact')
  assert.equal((await f.surface.recover()).state, 'clean')
  now = error.retryAt; f.refreshRoutes()
  const receipt = await f.surface.commit()
  assert.equal(receipt.state, 'COMMITTED')
  assert.equal(receipt.toWindowId, 2, 'the aborted attempt keeps its window id; the retry takes the next one')
  assert.deepEqual(journal(await f.diskEvents()), { intents: 2, aborted: 1, commits: 1 })
})

test('foreign_register_after_commit_append_commit_stands', async t => {
  let f, fired = false
  f = await surfaceFixture(t, stage => { if (stage === 'commit-appended' && !fired) { foreignWriter(f, 1); fired = true } })
  const receipt = await f.surface.commit()
  assert.equal(fired, true)
  assert.equal(receipt.state, 'COMMITTED')
  assert.deepEqual(journal(await f.diskEvents()), { intents: 1, aborted: 0, commits: 1 })
  for await (const _ of f.llm.stream(f.request())) {}
  assert.equal(f.captured.length, 1, 'the next request is admitted')
  const current = JSON.parse(f.captured.at(-1).messages.at(-1).content[0].text)
  assert.equal(current.authoritative, true)
  const now = f.service.authorityFor(f.request()).capture(f.session.id).checkpoint
  assert.equal(now.criticalRevisionVector.host.epoch, nativeHostBinding(f.ctx).epoch)
  assert.equal(f.captured.at(-1).messages.at(-1).source.nativeWindowAuthority, now.checkpointIntegrityHash, 'and is bound to the host as it is now')
})

test('async_host_writer_pending_at_commit_aborts', async t => {
  let f, pending
  const release = Promise.withResolvers()
  f = await surfaceFixture(t, stage => {
    if (stage === 'before-commit' && !pending) pending = getHostLifecycleGate(f.ctx).runAsync(() => release.promise)
  })
  const error = await f.surface.commit().then(() => null, failure => failure)
  release.resolve(); await pending
  assert.equal(error?.transitionAborted, true, String(error?.stack ?? error))
  assert.equal(error.code, 'WINDOW_PARTICIPATION_UNVERIFIED')
  assert.deepEqual(journal(await f.diskEvents()), { intents: 1, aborted: 1, commits: 0 })
  assert.equal(f.surface.status().paused, false)
})

test('recover_tolerates_host_epoch_churn', async t => {
  const f = await surfaceFixture(t, stage => { if (stage === 'prepared-durable') throw new Error('prepared-crash') })
  await assert.rejects(f.surface.commit(), /prepared-crash/)
  assert.equal(f.surface.status().paused, true)
  let n = 0, inside = 0
  foreignWriter(f, ++n)
  // One host writer lands, deterministically, while recovery is waiting for its control-plane fence.
  const acquire = f.control.acquireWindowFence
  f.control.acquireWindowFence = async function(...args) { foreignWriter(f, ++n); inside++; return acquire.apply(this, args) }
  let result
  try { result = await f.surface.recover() } finally { f.control.acquireWindowFence = acquire }
  assert.equal(inside, 1, 'the host changed inside the recovery itself')
  assert.equal(result.state, 'aborted')
  assert.equal(f.surface.status().paused, false)
  assert.ok(f.session.deriveMessages().some(row => row.id === 'old-user'))
})

for (const stage of ['before-prepare', 'prepared-durable', 'before-commit', 'commit-appended', 'commit-durable', 'before-publish']) {
  test('fault_matrix_with_host_writer_at_each_point: ' + stage, async t => {
    let f, fired = false
    f = await surfaceFixture(t, at => { if (at === stage && !fired) { foreignWriter(f, 1); fired = true } })
    const outcome = await f.surface.commit().then(receipt => ({ receipt }), error => ({ error }))
    assert.equal(fired, true)
    const disk = await f.diskEvents()
    assert.deepEqual(disk, f.session.snapshotEvents(), 'memory and disk agree')
    assert.equal(f.surface.status().paused, false)
    if (['before-prepare', 'prepared-durable', 'before-commit'].includes(stage)) {
      assert.equal(outcome.error?.transitionAborted, true, String(outcome.error?.stack ?? outcome.error))
      assert.deepEqual(journal(disk), { intents: 1, aborted: 1, commits: 0 })
      assert.ok(f.session.deriveMessages().some(row => row.id === 'old-user'))
    } else {
      assert.equal(outcome.receipt?.state, 'COMMITTED', String(outcome.error?.stack ?? outcome.error))
      assert.deepEqual(journal(disk), { intents: 1, aborted: 0, commits: 1 })
      assert.ok(!f.session.deriveMessages().some(row => row.id === 'old-user'))
    }
    assert.equal((await f.surface.recover()).state, 'clean')
  })
}

test('bounded_retry_under_continuous_churn', async t => {
  let f, n = 0, churning = true, now = 1000
  const decisions = []
  f = await surfaceFixture(t, stage => { if (stage === 'prepared-durable' && churning) foreignWriter(f, ++n) },
    { clock: () => now, onDecision: decision => decisions.push(decision) })
  const first = await f.surface.commit().then(() => null, failure => failure)
  assert.equal(first?.transitionAborted, true)
  assert.equal(first.retryAt, 31000)
  let size = f.session.snapshotEvents().length
  await assert.rejects(f.surface.commit(), /WINDOW_COMMIT_BACKOFF/)
  assert.equal(f.session.snapshotEvents().length, size, 'a refused attempt writes nothing')
  now = 31000; f.refreshRoutes()
  const second = await f.surface.commit().then(() => null, failure => failure)
  assert.equal(second?.transitionAborted, true)
  assert.equal(second.retryable, false)
  assert.deepEqual(decisions.map(row => row.kind), ['W2_DEFERRED_HOST_BUSY'])
  size = f.session.snapshotEvents().length
  now += 3600000; f.refreshRoutes()
  for (let i = 0; i < 5; i++) await assert.rejects(f.surface.commit(), /W2_DEFERRED_HOST_BUSY/)
  assert.equal(f.session.snapshotEvents().length, size, 'journal growth is bounded by the allowance')
  assert.deepEqual(journal(await f.diskEvents()), { intents: 2, aborted: 2, commits: 0 })
  assert.equal(decisions.length, 1)
  assert.equal(f.surface.status().paused, false)
  assert.ok(f.session.deriveMessages().some(row => row.id === 'old-user'), 'the session keeps working on its full surface')
  churning = false; f.surface.resetDemand(); f.refreshRoutes()
  assert.equal((await f.surface.commit()).state, 'COMMITTED')
})

test('lazy_install_callers_unaffected_during_transition', async t => {
  const tool = name => ({ name, parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, execute: () => ({}) })
  let f, reinstalls = 0, unregister
  f = await surfaceFixture(t, stage => {
    if (stage !== 'prepared-durable' || reinstalls) return
    // The shape of team-v15-window-economics-runtime installAgent and of the team-tools periodic maybeInstall:
    // drop the old registration, then register again, synchronously, with no handling for a busy host.
    unregister(); unregister = f.ctx.tools.register(tool('lazy-session-tool')); reinstalls++
    foreignWriter(f, 1)
  })
  unregister = f.ctx.tools.register(tool('lazy-session-tool')); f.refreshRoutes()
  t.after(() => unregister?.())
  const error = await f.surface.commit().then(() => null, failure => failure)
  assert.equal(reinstalls, 1, 'neither the removal nor the registration threw')
  assert.ok(f.ctx.tools.get('lazy-session-tool'), 'the tool is still there')
  assert.equal(error?.transitionAborted, true, 'the host changed under the commit, so the commit gives way')
  assert.equal(f.surface.status().paused, false)
})

test('a host that changes while the control plane settles skips the boundary before anything is written', async t => {
  const f = await surfaceFixture(t), size = f.session.snapshotEvents().length
  const flush = f.control.flush
  let moved = 0
  f.control.flush = async function(...args) { const result = await flush.apply(this, args); if (!moved++) foreignWriter(f, 1); return result }
  t.after(() => { f.control.flush = flush })
  const error = await f.surface.commit().then(() => null, failure => failure)
  assert.equal(moved >= 1, true)
  assert.equal(error?.code, 'WINDOW_HOST_BUSY_AT_BOUNDARY', String(error?.stack ?? error))
  assert.equal(error.transitionAborted, undefined)
  assert.equal(f.session.snapshotEvents().length, size, 'no intent, no abort record')
  assert.equal(f.surface.attempts().durableAborts, 0, 'and it does not use up the allowance')
  f.refreshRoutes()
  assert.equal((await f.surface.commit()).state, 'COMMITTED')
})
