import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Session } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { installRequestMessageProjection } from '../home/profiles/web/plugins/request-message-projection.mjs'
import { authorityKeys, createWindowCheckpointAuthority, windowHash, windowMessageBytes } from '../home/profiles/web/plugins/team-v15-window-checkpoint.mjs'
import { installWindowProjection } from '../home/profiles/web/plugins/team-v15-window-projection.mjs'
const require = createRequire(new URL('../app/package.json', import.meta.url))
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')))
const llmModule = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')))
const { LlmRuntime, LlmAdapter, createUserMessage, createAssistantMessage, createSystemMessage, createToolResultMessage } = llmModule
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
function fixture(mode = 'W1', changes = {}) {
  const session = Session.create('isolated-window-fixture')
  const system = createSystemMessage('PTC system contract')
  const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  const assistant = text => createAssistantMessage({ content: [{ type: 'text', text }], source: { kind: 'llm', provider: 'fixture', model: 'fixture' } })
  session.append('user/message', user('old input '.repeat(2500)), { surfaceOp: 'append' })
  session.append('assistant/message', { message: assistant('old result '.repeat(2500)) }, { surfaceOp: 'append' })
  session.append('user/message', user('current pending user'), { surfaceOp: 'append' })
  const original = [system, ...session.deriveMessages()]
  let revision = 1, authorityExtra = {}
  const source = () => ({ sessionId: session.id, actorId: 'actor', rootTeamId: 'team', windowId: 1,
    surfaceRevision: session.snapshotEvents().filter(e => e.surfaceOp !== undefined).length,
    criticalRevisionVector: { tasks: revision, inbox: 1, lease: 1, identity: 1, plan: 1 }, identityVersion: 1,
    identityHashes: { actor: windowHash('actor') }, configFingerprint: 'order:5/10/20/30',
    planRef: { path: 'registered-plan', sha256: windowHash('plan') }, planRevision: 1, planHash: windowHash('plan'),
    authority: { ...Object.fromEntries(authorityKeys.map(key => [key, []])), activeTaskIds: ['open-task'],
      taskRevisions: { 'open-task': revision }, planCoverageStates: { E4: 'open' }, ...authorityExtra },
    working: { progress: 'model claims all tasks done', memoRevision: 99 },
    recovery: { requiredRereads: ['registered-plan'], memoryDebt: ['old-span-events'], activeJobs: [] },
    messages: original, events: session.snapshotEvents(), recentTailIds: [original.at(-1).id], pendingMessageIds: [original.at(-1).id],
    completedSpans: [{ status: 'completed', messageIds: original.slice(1, 3).map(m => m.id),
      eventRefs: session.snapshotEvents().slice(0, 2).map(e => ({ seq: e.seq, sha256: windowHash(e) })),
      retentionReceipt: { id: 'fixture-recovery', currentAcl: true, durable: true }, memoryDebtCovered: true }],
    protocolCertificateHash: 'fixture-certified', ...changes })
  const authority = createWindowCheckpointAuthority({ readSource: source,
    verifyRecovery: (s, span) => span.retentionReceipt.id === 'fixture-recovery' && span.retentionReceipt.currentAcl === true && span.retentionReceipt.durable === true })
  const ctx = new Context(), runtime = new LlmRuntime(ctx), captured = []
  runtime.registerAdapter(['fixture'], new class extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: provider } }
    async prepareCall(provider, model) { return { model: { provider, id: model, name: model }, stream(options) {
      captured.push(options)
      return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })()
    } } }
  }())
  const bridge = installRequestMessageProjection(runtime, llmModule)
  const nativeForAdapter = runtime.forAdapter
  let mutateAtBoundary = false, mutateActorAtBoundary = false, dropCheckpointAtBoundary = false
  runtime.forAdapter = function(...args) {
    const result = nativeForAdapter.apply(this, args)
    if (mutateAtBoundary) revision++
    if (dropCheckpointAtBoundary) return { ...result, messages: result.messages.filter(message => !message.source?.windowCheckpoint) }
    return mutateActorAtBoundary ? { ...result, actorId: 'foreign-forwarded-actor' } : result
  }
  const window = installWindowProjection({ projection: bridge, llm: runtime, authority, mode,
    sessions: [session.id], routes: [{ provider: 'fixture', model: 'fixture', protocol: 'dsh-v1',
      certificateHash: 'fixture-certified', configFingerprint: 'order:5/10/20/30', expiresAt: Date.now() + 60000 }] })
  const options = () => llmModule.markAgentLoopRequest({ provider: 'fixture', model: 'fixture', sessionId: session.id,
    actorId: 'actor', messages: structuredClone(original), signal: new AbortController().signal })
  return { session, original, authority, runtime, bridge, window, captured, options,
    revise: () => { revision++ }, changeSource: data => Object.assign(changes,data), mutateAtBoundary: () => { mutateAtBoundary = true }, mutateActorAtBoundary: () => { mutateActorAtBoundary = true }, dropCheckpointAtBoundary: () => { dropCheckpointAtBoundary = true }, updateAuthority: data => { authorityExtra = data }, close: () => { window.dispose(); bridge.dispose() },
    user, assistant, createToolResultMessage }
}

test('a later raw fallback on the same turn signal must not inherit the previous checkpoint binding', async () => {
  const f = fixture(), first = f.options()
  await collect(f.runtime.stream(first))
  assert.equal(f.captured.length,1)
  f.changeSource({completedSpans:[]})
  const later = {...f.options(),signal:first.signal}
  const chunks = await collect(f.runtime.stream(later))
  assert.equal(f.captured.length,2,'raw request after a blocked projection must reach its own adapter')
  assert.deepEqual(f.captured[1].messages,later.messages)
  assert.equal(chunks.at(-1).reason.kind,'stop')
  assert.equal(f.window.audit().at(-1).blockedReason,'WINDOW_NO_COMPLETED_SPAN')
  f.close()
})

test('two prepared requests sharing a signal retain their independent native checkpoint bindings', async () => {
  const f = fixture(), first = f.options()
  const a = f.bridge.prepare(first)
  f.changeSource({working:{progress:'new observation',memoRevision:100}})
  const b = f.bridge.prepare({...f.options(),signal:first.signal})
  f.changeSource({working:{progress:'model claims all tasks done',memoRevision:99}})
  await collect(f.runtime.stream(a.options))
  f.changeSource({working:{progress:'new observation',memoRevision:100}})
  await collect(f.runtime.stream(b.options))
  assert.equal(f.captured.length,2)
  assert.ok(f.window.audit().every(row=>row.postSource==='unchanged'))
  f.close()
})

test('W0 real Session/LlmRuntime shadow is pure and preserves request, surface, journal and raw authority', async () => {
  const f = fixture('W0'), request = f.options(), events = windowHash(f.session.snapshotEvents()), surface = windowHash(f.session.surface.nodes)
  const preview = f.bridge.preview(request)
  assert.equal(preview.options, request)
  assert.equal(f.window.audit().length, 0)
  const candidate = f.window.preview(request)
  assert.equal(candidate.status, 'shadow')
  assert.ok(candidate.estimated.candidateBytes < candidate.estimated.beforeBytes)
  await collect(f.runtime.stream(request))
  assert.deepEqual(f.captured[0].messages, request.messages)
  assert.equal(windowHash(f.session.snapshotEvents()), events)
  assert.equal(windowHash(f.session.surface.nodes), surface)
  assert.equal(f.window.audit()[0].actual.handedToAdapter, true)
  assert.equal(f.window.audit()[0].actual.modelPayload.bytes, candidate.estimated.beforeBytes)
  f.close()
})

test('W1 actual prepared adapter payload is immutable, nonempty, bounded and keeps authority over memo', async t => {
  const f = fixture(), request = f.options(), events = windowHash(f.session.snapshotEvents())
  const prepared = f.bridge.prepare(request)
  const cp = prepared.options.messages.find(m => m.source.windowCheckpoint).source.windowCheckpoint
  assert.deepEqual(cp.authority.activeTaskIds, ['open-task'])
  assert.equal(cp.authority.planCoverageStates.E4, 'open')
  assert.equal(cp.working.kind, 'non-authoritative-observation')
  request.messages[1].content[0].text = 'caller mutation'
  assert.ok(Object.isFrozen(prepared.options.messages))
  assert.equal(f.window.audit().length, 0)
  await collect(f.runtime.stream(prepared.options))
  assert.ok(f.captured[0].messages.length > 0)
  assert.ok(Buffer.byteLength(JSON.stringify(f.captured[0].messages)) < 262144)
  assert.deepEqual(f.captured[0].messages.at(-1), f.original.at(-1))
  assert.deepEqual(f.captured[0].messages[0], f.original[0])
  assert.equal(windowHash(f.session.snapshotEvents()), events)
  const receipt = f.window.audit()[0]
  assert.equal(receipt.actual.handedToAdapter, true)
  assert.equal(receipt.postSource, 'unchanged')
  assert.equal(receipt.estimated.candidateBytes, receipt.actual.modelPayload.bytes)
  assert.equal(receipt.actual.payload.bytes, Buffer.byteLength(JSON.stringify(f.captured[0].messages)), 'retain the adapter-options measure separately')
  assert.equal(receipt.actual.providerReceipt, 'unknown')
  t.diagnostic(JSON.stringify({ measurement: receipt.estimated, actual: receipt.actual, postSource: receipt.postSource }))
  f.close()
})

test('uniterated and aborted requests have no actual dispatch receipt', async () => {
  const f = fixture(), prepared = f.bridge.prepare(f.options())
  f.runtime.stream(prepared.options)
  assert.equal(f.window.audit().length, 0)
  const controller = new AbortController(), request = { ...f.options(), signal: controller.signal }
  const aborted = f.bridge.prepare(request)
  controller.abort()
  const chunks = await collect(f.runtime.stream(aborted.options))
  assert.ok(chunks.some(chunk => chunk.type === 'finish' && ['error', 'aborted'].includes(chunk.reason.kind)))
  assert.equal(f.captured.length, 0)
  assert.equal(f.window.audit().length, 0)
  f.close()
})

test('source revisions changing after prepare reject before native adapter and receipt', async () => {
  const f = fixture(), prepared = f.bridge.prepare(f.options())
  f.revise()
  const chunks = await collect(f.runtime.stream(prepared.options))
  assert.ok(chunks.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'error'))
  assert.equal(f.captured.length, 0)
  assert.equal(f.window.audit().length, 0)
  assert.equal(f.bridge.audit(prepared.options).handedToAdapter, false)
  f.close()
})

for (const [name, alter, code] of [
  ['wrong actor', r => { r.actorId = 'other' }, 'WINDOW_ACTOR_MISMATCH'],
  ['wrong session', r => { r.sessionId = 'other' }, 'WINDOW_SESSION_NOT_ALLOWED'],
  ['auxiliary purpose', r => { r.purpose = 'compaction' }, 'WINDOW_PURPOSE_NOT_ALLOWED'],
  ['unknown route', r => { r.model = 'unknown' }, 'WINDOW_PROTOCOL_UNCERTIFIED'],
  ['unknown block', r => { r.messages[0].content.push({ type: 'future', text: 'x' }) }, 'WINDOW_SOURCE_REQUEST_MISMATCH'],
]) test(name + ' conservatively keeps the original request', () => {
  const f = fixture(), request = f.options(); alter(request)
  const result = f.window.preview(request)
  assert.equal(result.messages, request.messages)
  assert.equal(result.blockedReason, code)
  assert.equal(f.window.audit().length, 0)
  f.close()
})

test('native raw admission remains authoritative even with small W1 preview', async () => {
  const f = fixture(), request = f.options()
  assert.equal(f.window.preview(request).status, 'projected')
  const raw = Buffer.byteLength(JSON.stringify(f.session.deriveMessages()))
  const rawGate = value => { if (value > 4096) throw new Error('raw-native-pressure') }
  assert.throws(() => rawGate(raw), /raw-native-pressure/)
  assert.equal(f.captured.length, 0)
  assert.equal(Buffer.byteLength(JSON.stringify(f.session.deriveMessages())), raw)
  f.close()
})

test('actual llm waterfall raw request rejection is preserved', async () => {
  const f = fixture()
  const unhook = f.runtime.ctx.on('llm/stream', () => { throw Object.assign(new Error('raw authority refusal'), { code: 'RAW_GATE' }) }, { global: true })
  assert.throws(() => f.runtime.stream(f.options()), { code: 'RAW_GATE' })
  assert.equal(f.captured.length, 0)
  assert.equal(f.window.audit().length, 0)
  unhook(); f.close()
})
test('post-native source CAS prevents forAdapter synchronous source mutation from dispatching', async () => {
  const f = fixture(), prepared = f.bridge.prepare(f.options())
  f.mutateAtBoundary()
  const chunks = await collect(f.runtime.stream(prepared.options))
  assert.ok(chunks.some(c => c.type === 'finish' && c.reason.kind === 'error'))
  assert.equal(f.captured.length, 0)
  assert.equal(f.window.audit().length, 0)
  assert.equal(f.bridge.audit(prepared.options).handedToAdapter, false)
  f.close()
})
test('wrong actor after immutable prepare is rejected at actual dispatch boundary', async () => {
  const f = fixture(), prepared = f.bridge.prepare(f.options())
  const chunks = await collect(f.runtime.stream({ ...prepared.options, actorId: 'different' }))
  assert.ok(chunks.some(c => c.type === 'finish' && c.reason.kind === 'error'))
  assert.equal(f.captured.length, 0)
  assert.equal(f.window.audit().length, 0)
  f.close()
})

test('native forAdapter cannot forward a different actor after the pre-boundary check', async () => {
  const f = fixture(), prepared = f.bridge.prepare(f.options())
  f.mutateActorAtBoundary()
  const chunks = await collect(f.runtime.stream(prepared.options))
  assert.ok(chunks.some(c => c.type === 'finish' && c.reason.kind === 'error'))
  assert.equal(f.captured.length, 0)
  assert.equal(f.window.audit().length, 0)
  f.close()
})

test('native forAdapter cannot drop the bound checkpoint after the pre-boundary check', async () => {
  const f = fixture(), prepared = f.bridge.prepare(f.options())
  f.dropCheckpointAtBoundary()
  const chunks = await collect(f.runtime.stream(prepared.options))
  assert.ok(chunks.some(c => c.type === 'finish' && c.reason.kind === 'error'))
  assert.equal(f.captured.length, 0)
  assert.equal(f.window.audit().length, 0)
  f.close()
})
test('unknown request model fails open to unchanged messages at actual adapter', async () => {
  const f = fixture(), request = { ...f.options(), model: 'unknown-model' }
  await collect(f.runtime.stream(request))
  assert.deepEqual(f.captured[0].messages, request.messages)
  assert.equal(f.window.audit()[0].blockedReason, 'WINDOW_PROTOCOL_UNCERTIFIED')
  assert.equal(f.window.audit()[0].actual.handedToAdapter, true)
  f.close()
})
test('downstream transform cannot drop checkpoint and bypass source dispatch fence', async () => {
  const f = fixture()
  const unregister = f.bridge.register('fixture-downstream', options => ({ messages: options.messages.filter(m => !m.source.windowCheckpoint) }), { order: 10 })
  const prepared = f.bridge.prepare(f.options())
  const chunks = await collect(f.runtime.stream(prepared.options))
  assert.ok(chunks.some(c => c.type === 'finish' && c.reason.kind === 'error'))
  assert.equal(f.captured.length, 0)
  assert.equal(f.window.audit().length, 0)
  unregister(); f.close()
})

test('a large host binding is excluded from the budget while the actual checkpoint body is still counted', async () => {
  const f = fixture('W1', { criticalRevisionVector: { tasks: 1, inbox: 1, lease: 1, identity: 1, plan: 1, hostProof: 'p'.repeat(180000) } })
  const preview = f.window.preview(f.options())
  assert.equal(preview.status, 'projected', preview.blockedReason)
  await collect(f.runtime.stream(f.options()))
  const receipt = f.window.audit().at(-1)
  assert.equal(receipt.estimated.candidateBytes, windowMessageBytes(f.captured[0].messages))
  assert.ok(receipt.estimated.candidateBytes < receipt.estimated.beforeBytes)
  assert.ok(receipt.actual.payload.bytes > Buffer.byteLength(JSON.stringify(f.original)), 'host provenance makes the adapter options larger but is not sent as model content')
  assert.equal(receipt.estimated.providerWireBytes, 'unknown', 'this measure cannot claim an HTTP wire size')
  f.close()
})

test('provider replay signatures remain in the model budget; checkpoint provenance does not', () => {
  const bare = { id: 'a', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'reasoning', text: 'reasoning' }] }
  const host = { ...bare, source: { ...bare.source, nativeWindowCheckpoint: { authority: 'host'.repeat(10000) } } }
  assert.equal(windowMessageBytes([host]), windowMessageBytes([bare]))
  const signed = { ...host, source: { ...host.source, replayState: { blocks: [{ thinkingSignature: 'signed'.repeat(10000) }] } } }
  assert.ok(windowMessageBytes([signed]) > windowMessageBytes([host]) + 50000)
})
