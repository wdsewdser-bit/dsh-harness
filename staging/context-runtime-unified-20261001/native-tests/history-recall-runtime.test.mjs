import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Session, SessionStore, installNativeSessionBridge } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { ReactLoopAgent, inboxProjectionDefinition, turnBoundaryProjectionDefinition } from '../app/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'
import { ToolRuntime } from '../app/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
import { controlPlaneFor, readControlPlaneSnapshot, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { registerHistoryRecall } from '../home/profiles/web/plugins/team-v15-history-recall.mjs'
import { installRequestMessageProjection } from '../home/profiles/web/plugins/request-message-projection.mjs'
import { initializeNativeHost } from './native-host-fixture.mjs'
const require = createRequire(new URL('../app/package.json', import.meta.url))
const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)))
const { Context } = await load('cordis')
const { SessionProjectionRegistry } = await load('dsh-session-projection')
const { SystemPrompt } = await load('dsh-system-prompt')
const { AgentRegistry } = await load('dsh-agent')
const { SessionQueryEngine } = await load('dsh-session-query')
const { TokenMeter } = await load('dsh-token-meter')
const { BasicCompactionEngine } = await load('dsh-compaction-basic')
const llmModule = await load('dsh-llm')
const { createUserMessage, createToolResultMessage, LlmRuntime, LlmAdapter, markAgentLoopRequest } = llmModule
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'history-fixture' } })

async function fixture(t, { compact = false, pair = false, ptc = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'native-history-')), ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); resetControlPlaneCache(); rmSync(root, { recursive: true, force: true }) })
  return initializeNativeHost(ctx, async () => {
  const sessions = new SessionStore(ctx), projections = new SessionProjectionRegistry(ctx)
  projections.register(inboxProjectionDefinition); projections.register(turnBoundaryProjectionDefinition)
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false }); new AgentRegistry(ctx)
  const session = Session.create('own-history-session')
  sessions.enter(session); sessions.announce(session)
  const agent = new ReactLoopAgent(ctx, session.id, { provider: 'fixture', model: 'fixture' }, session)
  ctx.agents.enter(agent, { dispose: async () => {} }); agent.wakeDriver = () => {}
  const originalText = '\u4e2d\u6587-original-history-' + 'untrimmed-content '.repeat(600)
  const original = session.append('user/message', user(originalText), { surfaceOp: 'append' })
  if (pair) {
    const call = session.append('tool/call', { turn: 1, step: 1, callId: 'old-call', name: 'fixture', arguments: { raw: 'old-args' } })
    session.append('user/message', user('between-call-and-result'), { surfaceOp: 'append' })
    const result = session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'old-call',
      content: [{ type: 'text', text: 'original-tool-result' }], isError: false }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    session.fixturePair = { call, result }
  }
  if (compact) {
    new TokenMeter(ctx)
    // The official compaction replay/commit code is unchanged. Only its public
    // summarizer hook returns deterministic offline text, with no model call.
    class OfflineCompaction extends BasicCompactionEngine {
      count = 0
      async summarize() { return { summary: [{ type: 'text', text: ++this.count === 1 ? 'first-summary '.repeat(100) : 'second summary' }], provider: 'offline', model: 'fixture' } }
    }
    const compaction = new OfflineCompaction(ctx, { auto: false })
    session.append('turn/start', { turn: 1 })
    await compaction.compactRegion(original.seq, original.seq, agent, new AbortController().signal)
    const replacement = session.surface.nodes.at(-1)
    await compaction.compactRegion(replacement, replacement, agent, new AbortController().signal)
    session.append('turn/end', { turn: 1, outcome: 'completed' })
    assert.equal(session.snapshotEvents().filter(event => event.type === 'compaction/summary').length, 2)
    assert.ok(!JSON.stringify(session.deriveMessages()).includes(originalText))
  }
  installNativeSessionBridge(session, { sessionId: session.id, isolated: true, flush: async () => true })
  const foreign = Session.create('foreign-history-session')
  foreign.append('user/message', user('private-foreign-original'), { surfaceOp: 'append' })
  sessions.enter(foreign); sessions.announce(foreign)
  const query = new SessionQueryEngine(ctx)
  const runtime = new ToolRuntime(ctx,{mode:ptc?'ptc':'native'}), control = controlPlaneFor('history-own', { directory: join(root, 'control') })
  if (ptc) {
    const {NodePtcRuntime}=await load('dsh-ptc-runtime-node')
    const {SandboxPolicyService}=await load('dsh-sandbox-policy')
    const {LocalSandboxProvider}=await load('dsh-sandbox-local')
    const {LocalSubprocessRuntime}=await load('dsh-subprocess-local')
    const {LocalFileSystem}=await load('dsh-fs-local')
    new SandboxPolicyService(ctx,{mode:'read-only',workspaceRoot:root})
    new LocalSandboxProvider(ctx,{runnerCommand:[],runnerFailureSignatures:[],probeTimeoutMs:5000})
    new LocalSubprocessRuntime(ctx)
    new LocalFileSystem(ctx,{cwd:root,diffBasisMaxBytes:1048576})
    new NodePtcRuntime(ctx,{timeoutMs:15000,maxTimeoutMs:15000,maxOutputBytes:131072,maxMessageBytes:131072,
      maxPendingCalls:1,maxOldGenerationSizeMb:128,graceMs:100})
  }
  await control.mutateHot('fixture/history-control-init', {}, null, state => { state.allowedRecallSessions = [] }, { deferMs: 0 })
  const readDurable = () => readControlPlaneSnapshot(control.file)
  const llm = new LlmRuntime(ctx), captured = []
  llm.registerAdapter(['fixture'], new class extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: provider } }
    async prepareCall(provider, model) { return { model: { provider, id: model, name: model }, stream(options) {
      captured.push(options)
      return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })()
    } } }
  }())
  const projection = installRequestMessageProjection(llm, llmModule)
  const registration = registerHistoryRecall(ctx, { control, readDurable, pageBytes: 1024, projection,
    authorizeSession: (state, current, sessionId) => current === agent && state.allowedRecallSessions.includes(sessionId) })
  t.after(() => { registration(); projection.dispose() })
  let seq = 0
  const run = input => runtime.execute({ name: 'history_recall', arguments: input, callId: 'recall-' + ++seq, agent, signal: new AbortController().signal })
  const page = (d, offset) => run({ action: 'read', locator: d.locator, expectedRevision: d.sourceRef.sourceRevision,
    expectedSourceHash: d.sourceRef.sourceHash, offset })
  return { ctx, runtime, session, agent, foreign, query, original, originalText, control, readDurable, run, page,
    llm, projection, registration, captured }
  })
}

test('registered raw Query recall restores original bytes after two actual compactions, preserves journal and exact trace', async t => {
  const f = await fixture(t, { compact: true }), before = f.session.snapshotEvents()
  const located = await f.run({ action: 'locate', seq: f.original.seq })
  assert.equal(located.isError, false, JSON.stringify(located.error))
  const d = located.value.descriptor
  assert.ok(d.pages > 1); assert.equal(located.value.receipt, null)
  const first = await f.page(d, 0)
  assert.equal(first.value.complete, false); assert.equal(first.value.receipt, null)
  const chunks = []
  let last
  for (let offset = 0; offset < d.bytes; offset += d.pageBytes) {
    const result = await f.page(d, offset)
    assert.equal(result.isError, false, JSON.stringify(result.error)); last = result.value
    chunks.push(Buffer.from(result.value.dataBase64, 'base64'))
  }
  const bytes = Buffer.concat(chunks), artifact = JSON.parse(bytes)
  assert.equal(sha(bytes), d.sourceRef.artifactHash)
  assert.deepEqual(artifact.target, f.original)
  assert.ok(JSON.stringify(artifact.target).includes(f.originalText))
  assert.equal(artifact.trace.replacementChain.length, 2)
  assert.equal(last.receipt.status, 'full-fetched')
  assert.equal(f.readDurable().v15HistoryRecall.reads[d.locator].receipt.status, 'full-fetched')
  assert.deepEqual(f.session.snapshotEvents().slice(0, before.length), before)
  assert.deepEqual((await f.page(d, 0)).value.receipt, last.receipt)
})

test('actual Query tool pairing retains complete nonadjacent raw invocation and result', async t => {
  const f = await fixture(t, { pair: true }), { call, result } = f.session.fixturePair
  for (const target of [call, result]) {
    const located = await f.run({ action: 'locate', seq: target.seq })
    assert.equal(located.isError, false)
    const d = located.value.descriptor, chunks = []
    assert.equal(d.pairingComplete, true)
    for (let offset = 0; offset < d.bytes; offset += d.pageBytes) chunks.push(Buffer.from((await f.page(d, offset)).value.dataBase64, 'base64'))
    const artifact = JSON.parse(Buffer.concat(chunks))
    assert.deepEqual(artifact.target, target)
    assert.deepEqual(artifact.pairedEvents, [target === call ? result : call])
  }
})

test('a current tail raw event remains readable when recall itself appends native audit events', async t => {
  const f = await fixture(t)
  const located = await f.run({ action: 'locate', seq: f.original.seq })
  assert.equal(located.isError, false)
  const d = located.value.descriptor
  assert.deepEqual(d.neighborSeqs, [])
  let result
  for (let offset = 0; offset < d.bytes; offset += d.pageBytes) {
    result = await f.page(d, offset)
    assert.equal(result.isError, false); assert.equal(result.value.ok, true)
  }
  assert.equal(result.value.complete, true)
})

test('real registered ACL denies foreign Query reads and rechecks explicit current scope on every page', async t => {
  const f = await fixture(t)
  const denied = await f.run({ action: 'locate', sessionId: f.foreign.id, seq: 0 })
  assert.equal(denied.isError, true); assert.match(denied.error.message, /HISTORY_SCOPE_DENIED/)
  await f.control.mutateHot('fixture/server-authorized-session-scope', {}, null, state => { state.allowedRecallSessions = [f.foreign.id] }, { deferMs: 0 })
  const located = await f.run({ action: 'locate', sessionId: f.foreign.id, seq: 0 })
  assert.equal(located.isError, false)
  await f.control.mutateHot('fixture/server-revoke-session-scope', {}, null, state => { state.allowedRecallSessions = [] }, { deferMs: 0 })
  const revoked = await f.page(located.value.descriptor, 0)
  assert.equal(revoked.isError, true); assert.match(revoked.error.message, /HISTORY_SCOPE_DENIED/)
})

test('wrong expected source vector, missing references and caller source fabrication never clear raw recall debt', async t => {
  const f = await fixture(t), located = await f.run({ action: 'locate', seq: f.original.seq }), d = located.value.descriptor
  const stale = await f.run({ action: 'read', locator: d.locator, expectedRevision: d.sourceRef.sourceRevision + 1,
    expectedSourceHash: '0'.repeat(64), offset: 0 })
  assert.equal(stale.value.code, 'HISTORY_SOURCE_CAS_CONFLICT')
  const unknown = await f.run({ action: 'read', locator: 'missing' })
  assert.equal(unknown.value.debt.status, 'required')
  const missing = await f.run({ action: 'locate', seq: 99999 })
  assert.equal(missing.value.code, 'SESSION_QUERY_EVENT_NOT_FOUND')
  const fabricated = await f.run({ action: 'locate', seq: 0, original: 'caller-content', status: 'full-fetched' })
  assert.equal(fabricated.isError, true)
  assert.equal(f.readDurable().v15HistoryRecall.reads[d.locator], undefined)
})

async function returnedPages(f, d) {
  const pages = []
  for (let offset = 0; offset < d.bytes; offset += d.pageBytes) pages.push((await f.page(d, offset)).value)
  return pages
}

test('native assembly requires all exact pages and full artifact dispatch has a distinct durable receipt', async t => {
  const f = await fixture(t), d = (await f.run({action:'locate',seq:f.original.seq})).value.descriptor
  const assemble = () => f.run({action:'assemble',locator:d.locator,expectedRevision:d.sourceRef.sourceRevision,
    expectedSourceHash:d.sourceRef.sourceHash})
  const early = await assemble()
  assert.equal(early.isError,false)
  assert.equal(early.value.ok,false)
  assert.equal(early.value.code,'HISTORY_ASSEMBLY_PAGES_INCOMPLETE')
  await returnedPages(f,d)
  const assembled = await assemble()
  assert.equal(assembled.isError,false)
  assert.equal(assembled.value.kind,'history-raw-artifact-v1')
  assert.equal(sha(Buffer.from(JSON.stringify(assembled.value.artifact))),d.sourceRef.artifactHash)
  assert.deepEqual(assembled.value.artifact.target,f.original)
  const request = markAgentLoopRequest({provider:'fixture',model:'fixture',sessionId:f.session.id,
    signal:new AbortController().signal,messages:[createToolResultMessage({callId:assembled.value.deliveryCandidate.callId,
      isError:false,content:[{type:'text',text:JSON.stringify(assembled.value)}]})]})
  f.projection.preview(request)
  assert.equal(f.readDurable().v15HistoryRecall.reads[d.locator].artifactDeliveryReceipt,undefined)
  await dispatch(f,request)
  const state = f.readDurable(), progress = state.v15HistoryRecall.reads[d.locator]
  assert.equal(progress.artifactDeliveryReceipt.status,'full-artifact-dispatched')
  assert.equal(progress.modelDeliveryReceipt,undefined,'aggregate cannot counterfeit canonical page dispatch')
  assert.ok(Object.values(state.v15HistoryRecall.returnedPages).every(row=>row.status==='returned-awaiting-dispatch'))
  assert.deepEqual(f.registration.service.collectDebt(state,f.agent),[])
})

test('official Node PTC returns server assembly through a native parent; only complete outer dispatch clears debt', async t => {
  const f = await fixture(t,{ptc:true})
  const code=`const located=await tools.history_recall({action:"locate",seq:${f.original.seq}});
const d=located.descriptor;
for(let offset=0;offset<d.bytes;offset+=d.pageBytes) await tools.history_recall({action:"read",locator:d.locator,expectedRevision:d.sourceRef.sourceRevision,expectedSourceHash:d.sourceRef.sourceHash,offset});
const assembled=await tools.history_recall({action:"assemble",locator:d.locator,expectedRevision:d.sourceRef.sourceRevision,expectedSourceHash:d.sourceRef.sourceHash});
if(assembled.ok!==true) throw new Error("ASSEMBLY_FAILED");
return JSON.stringify(assembled);`
  const outer = await f.runtime.execute({name:'run_code',arguments:{code,description:'Read isolated raw history only'},
    callId:'official-ptc-history-assembly',agent:f.agent,signal:new AbortController().signal})
  assert.equal(outer.isError,false,JSON.stringify(outer.error))
  const assembled=JSON.parse(outer.content[0].text.split('\n')[0]), d=assembled.descriptor
  assert.deepEqual(assembled.artifact.target,f.original)
  const candidate=Object.values(f.readDurable().v15HistoryRecall.returnedArtifacts)[0]
  assert.equal(candidate.rootCallId,'official-ptc-history-assembly')
  assert.notEqual(candidate.callId,candidate.rootCallId)
  const options=(callId=candidate.rootCallId)=>markAgentLoopRequest({provider:'fixture',model:'fixture',sessionId:f.session.id,
    signal:new AbortController().signal,messages:[createToolResultMessage({callId,isError:false,content:outer.content})]})
  const wrongParent=options('other-outer-program')
  await dispatch(f,wrongParent)
  assert.equal(f.readDurable().v15HistoryRecall.reads[d.locator].artifactDeliveryReceipt,undefined)
  await dispatch(f,options())
  const progress=f.readDurable().v15HistoryRecall.reads[d.locator]
  assert.equal(progress.artifactDeliveryReceipt.status,'full-artifact-dispatched')
  assert.equal(progress.artifactDeliveryReceipt.callId,candidate.rootCallId)
  assert.equal(progress.modelDeliveryReceipt,undefined)
  const revision=f.readDurable().revision
  await dispatch(f,options())
  assert.equal(f.readDurable().revision,revision,'repeat same full artifact dispatch is idempotent')
})

async function assembledRequest(f,d) {
  await returnedPages(f,d)
  const value=(await f.run({action:'assemble',locator:d.locator,expectedRevision:d.sourceRef.sourceRevision,
    expectedSourceHash:d.sourceRef.sourceHash})).value
  assert.equal(value.ok,true)
  const make=(text=JSON.stringify(value),sessionId=f.session.id,callId=value.deliveryCandidate.callId)=>markAgentLoopRequest({
    provider:'fixture',model:'fixture',sessionId,signal:new AbortController().signal,messages:[createToolResultMessage({callId,isError:false,
      content:[{type:'text',text}]})]})
  return {value,make}
}

test('assembly never trusts caller status or fake full-fetched progress without every exact page', async t => {
  const f=await fixture(t), d=(await f.run({action:'locate',seq:f.original.seq})).value.descriptor
  const args={action:'assemble',locator:d.locator,expectedRevision:d.sourceRef.sourceRevision,expectedSourceHash:d.sourceRef.sourceHash}
  assert.equal((await f.run({...args,status:'full-artifact-dispatched'})).isError,true)
  await f.control.mutateHot('fixture/corrupt-read-progress',{},null,state=>{
    state.v15HistoryRecall.reads[d.locator]={receipt:{status:'full-fetched'},pageHashes:{}}
  },{deferMs:0})
  assert.equal((await f.run(args)).value.code,'HISTORY_ASSEMBLY_PAGES_INCOMPLETE')
  assert.equal(f.readDurable().v15HistoryRecall.returnedArtifacts,undefined)
  assert.ok(f.registration.service.collectDebt(f.readDurable(),f.agent).length)
})

test('preview, uniterated, late truncation, forged call, foreign reader, unbranded and abort do not acknowledge full artifacts', async t => {
  const f=await fixture(t), d=(await f.run({action:'locate',seq:f.original.seq})).value.descriptor
  const {value,make}=await assembledRequest(f,d), request=make()
  f.projection.preview(request)
  const prepared=await f.llm.prepareCall({provider:'fixture',model:'fixture'})
  prepared.stream(request)
  const stop=f.projection.register('truncate-full-artifact',options=>({messages:options.messages.map(message=>({...message,
    content:[{type:'text',text:message.content[0].text.slice(0,200)}]}))}),{order:1200})
  await dispatch(f,make()); stop()
  for (const input of [make(JSON.stringify(value)+'\nforeign'),make(undefined,'foreign-reader'),
    make(undefined,f.session.id,'forged-call'),{...make()}]) await dispatch(f,input)
  const abort=new AbortController(); abort.abort()
  await dispatch(f,markAgentLoopRequest({...make(),signal:abort.signal}))
  assert.equal(f.readDurable().v15HistoryRecall.reads[d.locator].artifactDeliveryReceipt,undefined)
  assert.ok(f.registration.service.collectDebt(f.readDurable(),f.agent).length)
})

test('current source and ACL are rechecked after assembling a packet and before acknowledgement', async t => {
  const f=await fixture(t)
  await f.control.mutateHot('fixture/grant-foreign-read',{},null,state=>{state.allowedRecallSessions=[f.foreign.id]},{deferMs:0})
  const d=(await f.run({action:'locate',sessionId:f.foreign.id,seq:0})).value.descriptor
  const {make}=await assembledRequest(f,d)
  await f.control.mutateHot('fixture/revoke-foreign-read',{},null,state=>{state.allowedRecallSessions=[]},{deferMs:0})
  await dispatch(f,make())
  assert.equal(f.readDurable().v15HistoryRecall.reads[d.locator].artifactDeliveryReceipt,undefined)
  await f.control.mutateHot('fixture/regrant-foreign-read',{},null,state=>{state.allowedRecallSessions=[f.foreign.id]},{deferMs:0})
  const original=f.query.readEvent.bind(f.query)
  f.query.readEvent=async(...args)=>{
    const row=await original(...args)
    if(args[0].sessionId===f.foreign.id)row.target.data.content[0].text='changed private source'
    return row
  }
  await dispatch(f,make())
  assert.equal(f.readDurable().v15HistoryRecall.reads[d.locator].artifactDeliveryReceipt,undefined)
  assert.ok(f.registration.service.collectDebt(f.readDurable(),f.agent).length)
})

test('successful exact assembly resolves only matching prior source debt, never unrelated missing locators', async t => {
  const f=await fixture(t), d=(await f.run({action:'locate',seq:f.original.seq})).value.descriptor
  await f.run({action:'read',locator:d.locator,expectedRevision:d.sourceRef.sourceRevision,expectedSourceHash:'0'.repeat(64),offset:0})
  await f.run({action:'read',locator:'unrelated-missing-locator'})
  const {make}=await assembledRequest(f,d)
  await dispatch(f,make())
  const debts=f.registration.service.collectDebt(f.readDurable(),f.agent)
  assert.equal(debts.length,1)
  assert.equal(debts[0].sourceRef.locator,'unrelated-missing-locator')
})
function wire(f, pages, sessionId = f.session.id) {
  const rows = f.readDurable().v15HistoryRecall.returnedPages
  return markAgentLoopRequest({ provider: 'fixture', model: 'fixture', sessionId, purpose: 'conversation', signal: new AbortController().signal,
    messages: pages.map(page => createToolResultMessage({ callId: rows[page.deliveryCandidate.id].callId,
      isError: false, content: [{ type: 'text', text: JSON.stringify(page) }] })).concat([
        llmModule.createAssistantMessage({ content: [{ type: 'text', text: 'foreign replay context' }],
          source: { kind: 'model', provider: 'foreign', model: 'old', replayState: { filtered: true } } })]) })
}
async function dispatch(f, options) {
  for await (const _chunk of f.llm.stream(options)) {}
  await f.registration.drainDispatch()
}

test('actual branded LlmRuntime adapter confirms every exact page separately from server fetch', async t => {
  const f = await fixture(t), d = (await f.run({ action: 'locate', seq: f.original.seq })).value.descriptor
  const pages = await returnedPages(f, d)
  let state = f.readDurable()
  assert.equal(state.v15HistoryRecall.reads[d.locator].receipt.status, 'full-fetched')
  assert.equal(state.v15HistoryRecall.reads[d.locator].modelDeliveryReceipt, undefined)
  assert.equal(f.registration.service.collectDebt(state, f.agent)[0].status, 'returned-awaiting-dispatch')
  const request = wire(f, pages)
  f.projection.preview(request)
  const prepared = await f.llm.prepareCall({ provider: 'fixture', model: 'fixture' })
  prepared.stream(request)
  assert.equal(f.readDurable().v15HistoryRecall.reads[d.locator].modelDeliveryReceipt, undefined)
  await dispatch(f, wire(f, pages.slice(0, 1)))
  assert.equal(f.readDurable().v15HistoryRecall.reads[d.locator].modelDeliveryReceipt, undefined)
  await dispatch(f, wire(f, pages.slice(1)))
  state = f.readDurable()
  assert.equal(state.v15HistoryRecall.reads[d.locator].modelDeliveryReceipt.status, 'full-dispatched')
  assert.equal(state.v15HistoryRecall.reads[d.locator].modelDeliveryReceipt.modelUnderstanding, 'unknown')
  assert.equal(state.v15HistoryRecall.reads[d.locator].receipt.status, 'full-fetched')
  assert.deepEqual(f.registration.service.collectDebt(state, f.agent), [])
  assert.ok(f.captured.length > 0)
  assert.equal(f.captured.at(-1).messages.at(-1).source.replayState, undefined)
})

test('late truncated output, foreign reader, unbranded and aborted requests cannot confirm page dispatch', async t => {
  const f = await fixture(t), d = (await f.run({ action: 'locate', seq: f.original.seq })).value.descriptor
  const pages = await returnedPages(f, d)
  const stopLate = f.projection.register('late-history-truncation', options => ({ messages: options.messages.map(message => ({ ...message,
    content: [{ type: 'text', text: message.content[0].text.slice(0, 100) }] })) }), { order: 1200 })
  await dispatch(f, wire(f, pages)); stopLate()
  await dispatch(f, wire(f, pages, 'foreign-reader'))
  const unbranded = { ...wire(f, pages) }
  await dispatch(f, unbranded)
  const aborted = wire(f, pages), abort = new AbortController(); abort.abort(); aborted.signal = abort.signal
  await dispatch(f, aborted)
  assert.equal(f.readDurable().v15HistoryRecall.reads[d.locator].modelDeliveryReceipt, undefined)
  assert.ok(f.registration.service.collectDebt(f.readDurable(), f.agent).length)
})

test('real adapter history receipts bind the current native context epoch and never combine old-window page dispatches', async t => {
  const f = await fixture(t), d = (await f.run({ action: 'locate', seq: f.original.seq })).value.descriptor
  const pages = await returnedPages(f, d)
  await dispatch(f, wire(f, pages))
  assert.deepEqual(f.registration.service.collectDebt(f.readDurable(), f.agent), [])
  f.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'new history window' }],
    source: { kind: 'user', windowCommit: { transitionId: 'history-next-window' } } }), { surfaceOp: 'append' })
  assert.ok(f.registration.service.collectDebt(f.readDurable(), f.agent).length)
  await dispatch(f, wire(f, pages.slice(0, 1)))
  assert.ok(f.registration.service.collectDebt(f.readDurable(), f.agent).length)
  await dispatch(f, wire(f, pages.slice(1)))
  const progress = f.readDurable().v15HistoryRecall.reads[d.locator]
  assert.equal(progress.modelDeliveryReceipt.contextEpoch, 'window:history-next-window')
  assert.deepEqual(f.registration.service.collectDebt(f.readDurable(), f.agent), [])
})

test('raw source changed after return and current cross-session ACL revoked refuse adapter confirmation', async t => {
  const f = await fixture(t)
  await f.control.mutateHot('fixture/allow-history-scope', {}, null, state => { state.allowedRecallSessions = [f.foreign.id] }, { deferMs: 0 })
  const d = (await f.run({ action: 'locate', sessionId: f.foreign.id, seq: 0 })).value.descriptor
  const pages = await returnedPages(f, d)
  await f.control.mutateHot('fixture/revoke-history-scope', {}, null, state => { state.allowedRecallSessions = [] }, { deferMs: 0 })
  await dispatch(f, wire(f, pages))
  assert.equal(f.readDurable().v15HistoryRecall.reads[d.locator].modelDeliveryReceipt, undefined)
  await f.control.mutateHot('fixture/allow-history-scope', {}, null, state => { state.allowedRecallSessions = [f.foreign.id] }, { deferMs: 0 })
  const readEvent = f.query.readEvent.bind(f.query)
  f.query.readEvent = async (...args) => {
    const result = await readEvent(...args)
    if (args[0].sessionId === f.foreign.id) result.target.data = user('changed physical observation')
    return result
  }
  await dispatch(f, wire(f, pages))
  assert.equal(f.readDurable().v15HistoryRecall.reads[d.locator].modelDeliveryReceipt, undefined)
})
