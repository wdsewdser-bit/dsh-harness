import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { apply } from '../home/profiles/web/plugins/team-v15-window-economics-runtime.mjs'
import { installRequestMessageProjection } from '../home/profiles/web/plugins/request-message-projection.mjs'

const require = createRequire(new URL('../../../app/package.json', import.meta.url))
const official = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')))
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')))

function fixture(t, { maxBufferRecords = 32, usageChunks = [
  { type: 'usage', providerRequestId: 'provider-request-1', usage: {
    inputTokens: 10, cacheReadTokens: 1, cacheWriteTokens: 0, outputTokens: 4, reasoningTokens: 1, totalTokens: 15,
  } },
  { type: 'usage', providerRequestId: 'provider-request-1', usage: {
    inputTokens: 12, cacheReadTokens: 1, cacheWriteTokens: 0, outputTokens: 4, reasoningTokens: 1, totalTokens: 17,
  } },
] } = {}) {
  const cordis = new Context()
  const llm = new official.LlmRuntime(cordis)
  const captured = []
  const unregisterAdapter = llm.registerAdapter(['fixture'], new class extends official.LlmAdapter {
    providerInfo(provider) { return { id: provider, name: provider } }
    async prepareCall(provider, model) {
      return { model: { provider, id: model, name: model }, stream(options) {
        captured.push(options)
        return (async function* () {
          for (const chunk of usageChunks) yield chunk
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      } }
    }
  }())
  const bridge = installRequestMessageProjection(llm, official)
  const tools = new Map()
  const agent = {
    id: 'agent-root', name: 'root', session: { id: 'session-root' },
    ctx: { tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } } },
  }
  const foreignAgent = {
    id: 'agent-foreign', name: 'foreign', session: { id: 'session-foreign' },
    ctx: { tools: { register() { return () => {} } } },
  }
  const listenerStops = new Map()
  const effects = []
  const ctx = {
    llm,
    agents: { list: () => [agent, foreignAgent], get: id => [agent, foreignAgent].find(row => row.id === id || row.session.id === id) },
    agentTeams: { tryMembership(candidate) {
      return candidate === agent ? { id: 'team-root', name: 'root', tier: 0 } : { id: 'team-foreign', name: 'foreign', tier: 0 }
    } },
    requestMessageProjection: bridge,
    logger: { warn() {} },
    on(name, listener, options) {
      const stop = cordis.on(name, listener, options)
      const stops = listenerStops.get(name) ?? new Set()
      stops.add(stop)
      listenerStops.set(name, stops)
      return () => { stop(); stops.delete(stop) }
    },
    provide(name, value) {
      ctx[name] = value
      return () => { if (ctx[name] === value) delete ctx[name] }
    },
    effect(register) { effects.push(register) },
  }
  const removeLateTransform = bridge.register('late-transform', input => ({ messages: input.messages.map(message =>
    message.id === 'window-test' ? { ...message, content: [{ type: 'text', text: 'late transformed payload' }] } : message,
  ) }), { order: 200, preview: input => ({ messages: input.messages.map(message =>
    message.id === 'window-test' ? { ...message, content: [{ type: 'text', text: 'late transformed payload' }] } : message,
  ) }) })
  const stop = apply(ctx, { maxBufferRecords })
  const cleanup = async () => {
    await stop()
    removeLateTransform()
    bridge.dispose()
    unregisterAdapter()
  }
  t.after(cleanup)
  return { llm, bridge, ctx, agent, foreignAgent, tools, listenerStops, effects, captured, stop, cleanup }
}

function request(agent, signal = new AbortController().signal, { protocol = 'fixture-protocol' } = {}) {
  const options = {
    sessionId: agent.session.id, provider: 'fixture', model: 'fixture-model',
    purpose: 'auxiliary', signal,
    messages: [{ id: 'window-test', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'original payload' }] }],
  }
  if (protocol !== null) options.protocol = protocol
  return official.markAgentLoopRequest(options)
}

async function drain(stream) { for await (const _chunk of stream) {} }

test('real adapter receipts and terminal usage are read-only, scoped, unknown-safe and deduplicated', async t => {
  const f = fixture(t)
  const service = f.ctx.windowEconomics
  const tool = f.tools.get('window_economics')
  assert.ok(service)
  assert.ok(tool)
  assert.equal(service.mode, 'shadow')
  assert.equal(service.automaticActionsEnabled, false)
  assert.deepEqual(tool.parameters.properties, {})
  assert.equal(tool.parameters.additionalProperties, false)

  const options = request(f.agent)
  const originalMessages = structuredClone(options.messages)
  f.bridge.preview(options)
  assert.equal(service.stats().bufferedRecords, 0)
  const uniterated = (await f.llm.prepareCall({ provider: 'fixture', model: 'fixture-model' })).stream(options)
  assert.equal(service.stats().bufferedRecords, 0)

  const controller = new AbortController()
  controller.abort()
  try {
    const aborted = await f.llm.prepareCall({ provider: 'fixture', model: 'fixture-model' })
    await drain(aborted.stream(request(f.agent, controller.signal)))
  } catch { /* Aborted before adapter dispatch. */ }
  assert.equal(service.stats().bufferedRecords, 0)
  assert.equal(f.captured.length, 0)
  void uniterated

  const prepared = await f.llm.prepareCall({ provider: 'fixture', model: 'fixture-model' })
  const stream = prepared.stream(options)
  await drain(stream)
  assert.equal(typeof stream.next, 'function')
  await stream.next()
  assert.equal(f.captured.length, 1)
  assert.equal(official.isAgentLoopRequest(f.captured[0]), true)
  assert.deepEqual(options.messages, originalMessages)
  assert.equal(options.messages[0].content[0].text, 'original payload')
  assert.equal(f.captured[0].messages[0].content[0].text, 'late transformed payload')

  const snapshot = await tool.execute({}, { agent: f.agent })
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.mode, 'shadow')
  assert.equal(snapshot.window.sessionId, 'session-root')
  assert.equal(snapshot.window.purpose, 'auxiliary')
  assert.deepEqual(snapshot.window.route, { provider: 'fixture', model: 'fixture-model', protocol: 'fixture-protocol' })
  assert.equal(snapshot.window.receipt.stage, 'handed-to-adapter')
  assert.equal(snapshot.window.receipt.handedToAdapter, true)
  assert.ok(snapshot.window.receipt.requestId)
  assert.ok(snapshot.window.receipt.before.sha256)
  assert.notEqual(snapshot.window.receipt.before.sha256, snapshot.window.receipt.after.sha256)
  assert.equal(snapshot.window.receipt.adapterPayload.sha256, f.bridge.audit(f.captured[0]).adapterPayload.sha256)
  assert.equal(snapshot.window.terminalReceipt.status, 'success')
  assert.equal(snapshot.window.terminalReceipt.complete, true)
  assert.equal(snapshot.window.terminalReceipt.providerRequestId, 'provider-request-1')
  assert.equal(snapshot.window.terminalReceipt.finishReason, 'stop')
  assert.equal(snapshot.window.terminalReceipt.usageSource, 'dsh-adapter-usage-last-snapshot')
  assert.equal(snapshot.window.terminalReceipt.usageSnapshots, 2)
  assert.equal(snapshot.usage.activity.requests, 1)
  assert.equal(snapshot.usage.activity.attempts, 1)
  assert.equal(snapshot.usage.activity.providerTerminal, 1)
  assert.equal(snapshot.usage.dedup.duplicateTerminalRecords, 0)
  assert.equal(snapshot.usage.tokens.inputTokens.value, 12)
  assert.equal(snapshot.usage.tokens.componentTotal.value, 17)
  assert.equal(snapshot.usage.tokens.reasoningTokens.value, 1)
  assert.equal(snapshot.usage.fees.unknownCount, 1)
  assert.equal(snapshot.economics.knowledge.price.status, 'unknown')
  assert.equal(snapshot.economics.knowledge.cacheWriteTokens.value, null)
  assert.equal(snapshot.economics.knowledge.reasoningTokens.value, null)
  assert.equal(snapshot.economics.hardSafety.rawSafetyTokens, null)
  assert.equal(snapshot.economics.hardSafety.safeCompactionRequired, null)
  assert.equal(snapshot.economics.wouldTransition, false)
  assert.equal(snapshot.economics.wouldContinue, false)
  assert.doesNotMatch(JSON.stringify(snapshot), /original payload|late transformed payload/)

  const denied = await tool.execute({ sessionId: 'session-foreign', provider: 'caller-provider',
    pricing: { known: true }, costs: { stableOldCost: { amount: 0, unit: 'USD' } },
    receipt: { handedToAdapter: true }, usage: { inputTokens: 999 }, status: 'passed' }, { agent: f.foreignAgent })
  assert.deepEqual(denied, { ok: false, code: 'WINDOW_ECONOMICS_SCOPE_DENIED' })
  const ignored = await tool.execute({ sessionId: 'session-foreign', provider: 'caller-provider',
    pricing: { known: true }, receipt: { handedToAdapter: true }, usage: { inputTokens: 999 } }, { agent: f.agent })
  assert.equal(ignored.window.sessionId, 'session-root')
  assert.equal(ignored.window.route.provider, 'fixture')
  assert.equal(ignored.economics.knowledge.price.status, 'unknown')
  assert.equal(ignored.usage.tokens.inputTokens.value, 12)
  const foreignSnapshot = await service.readSnapshot(f.foreignAgent)
  assert.equal(foreignSnapshot.ok, true)
  assert.equal(foreignSnapshot.window.sessionId, 'session-foreign')
  assert.equal(foreignSnapshot.usage.membership.includedRecords, 0)
})

test('usage accounting stays bounded and disposal unregisters hooks, tools and service', async t => {
  const f = fixture(t, { maxBufferRecords: 1 })
  const service = f.ctx.windowEconomics
  const tool = f.tools.get('window_economics')
  let prepared = await f.llm.prepareCall({ provider: 'fixture', model: 'fixture-model' })
  await drain(prepared.stream(request(f.agent)))
  assert.equal(service.stats().bufferedRecords, 1)
  prepared = await f.llm.prepareCall({ provider: 'fixture', model: 'fixture-model' })
  await drain(prepared.stream(request(f.agent)))
  assert.equal(service.stats().bufferedRecords, 1)
  assert.equal(service.stats().droppedRecords, 1)

  const listenerCount = f.listenerStops.get('llm/stream')?.size ?? 0
  assert.equal(listenerCount, 1)
  const effect = f.effects[0]()
  assert.equal(typeof effect, 'function')
  await effect()
  await effect()
  assert.equal(f.listenerStops.get('llm/stream')?.size ?? 0, 0)
  assert.equal(f.tools.has('window_economics'), false)
  assert.equal(f.ctx.windowEconomics, undefined)
  assert.equal(service.stats().disposed, true)
  assert.deepEqual(await service.readSnapshot(f.agent), { ok: false, code: 'WINDOW_ECONOMICS_DISPOSED' })
  assert.ok(tool)
})

test('missing protocol, usage fields and currency remain unknown instead of receiving defaults', async t => {
  const f = fixture(t, { usageChunks: [] })
  const prepared = await f.llm.prepareCall({ provider: 'fixture', model: 'fixture-model' })
  await drain(prepared.stream(request(f.agent, undefined, { protocol: null })))
  const snapshot = await f.tools.get('window_economics').execute({}, { agent: f.agent })
  assert.deepEqual(snapshot.window.route, { provider: 'fixture', model: 'fixture-model', protocol: null })
  assert.equal(snapshot.window.terminalReceipt.providerRequestId, null)
  assert.equal(snapshot.window.terminalReceipt.terminalIdSource, 'runtime-observer')
  assert.equal(snapshot.economics.knowledge.price.status, 'unknown')
  assert.equal(snapshot.economics.hardSafety.safeCompactionRequired, null)
  assert.equal(snapshot.usage.tokens.inputTokens.value, null)
  assert.equal(snapshot.usage.tokens.inputTokens.unknownCount, 1)
  assert.equal(snapshot.usage.tokens.reasoningTokens.value, null)
  assert.equal(snapshot.usage.fees.unknownCount, 1)
  assert.deepEqual(snapshot.usage.fees.byUnit, {})
})
