import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { apply } from '../home/profiles/web/plugins/team-v15-window-economics-runtime.mjs'
import { installRequestMessageProjection } from '../home/profiles/web/plugins/request-message-projection.mjs'
import { initializeNativeHost } from './native-host-fixture.mjs'

const require = createRequire(new URL('../app/package.json', import.meta.url))
const official = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')))
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')))

async function fixture(t, { maxBufferRecords = 32, afterChunks = () => {} } = {}) {
  const nativeContext = new Context()
  const llm = await initializeNativeHost(nativeContext, () => new official.LlmRuntime(nativeContext))
  const usageChunks = []
  const captured = []
  const unregisterAdapter = llm.registerAdapter(['fixture'], new class extends official.LlmAdapter {
    providerInfo(provider) { return { id: provider, name: provider } }
    async prepareCall(provider, model) {
      return { model: { provider, id: model, name: model }, stream(options) {
        captured.push(options)
        return (async function* () { yield* usageChunks; afterChunks(); yield { type: 'finish', reason: { kind: 'stop' } } })()
      } }
    }
  }())
  const bridge = installRequestMessageProjection(llm, official)
  const tools = new Map()
  const agent = { name: 'root', session: { id: 'session-root' }, ctx: { tools: {
    register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) },
  } } }
  const events = new Map(), effects = []
  const ctx = {
    llm, agents: { list: () => [agent] },
    agentTeams: { tryMembership(candidate) { return candidate === agent ? { id: 'team-root', name: 'root', tier: 0 } : undefined } },
    requestMessageProjection: bridge,
    on(name, listener) {
      const listeners = events.get(name) ?? new Set()
      listeners.add(listener); events.set(name, listeners)
      const unregister = nativeContext.on(name, listener, { global: true })
      return () => { listeners.delete(listener); unregister() }
    },
    provide(name, value) { ctx[name] = value; return () => { if (ctx[name] === value) delete ctx[name] } },
    effect(register) { effects.push(register) },
  }
  const removeLateTransform = bridge.register('late-transform', input => ({ messages: input.messages.map(message =>
    message.id === 'window-test' ? { ...message, content: [{ type: 'text', text: 'late transformed payload' }] } : message,
  ) }), { order: 200, preview: input => ({ messages: input.messages.map(message =>
    message.id === 'window-test' ? { ...message, content: [{ type: 'text', text: 'late transformed payload' }] } : message,
  ) }) })
  const stop = apply(ctx, { maxBufferRecords })
  const preparedPromise = llm.prepareCall({ provider: 'fixture', model: 'fixture-model' })
  const cleanup = async () => { await stop(); removeLateTransform(); bridge.dispose(); unregisterAdapter() }
  t.after(cleanup)
  return { llm, bridge, ctx, agent, tools, events, effects, captured, stop, cleanup, preparedPromise, usageChunks }
}

function request(agent, signal = new AbortController().signal) {
  return official.markAgentLoopRequest({
    sessionId: agent.session.id, provider: 'fixture', model: 'fixture-model', protocol: 'fixture-protocol',
    purpose: 'auxiliary', signal,
    messages: [{ id: 'window-test', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'original payload' }] }],
  })
}

async function drain(stream) { for await (const _chunk of stream) {} }

test('actual native LlmRuntime preemption keeps interrupted usage unknown in economics', async t => {
  const controller = new AbortController()
  const f = await fixture(t, { afterChunks: () => controller.abort(Object.assign(new Error('interrupted'), { code: 'SAMPLING_PREEMPTED' })) })
  await f.preparedPromise
  f.usageChunks.push({ type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } })
  try { await drain(f.llm.stream(request(f.agent, controller.signal))) } catch (error) { assert.equal(controller.signal.aborted, true) }
  const snapshot = await f.ctx.windowEconomics.readSnapshot(f.agent)
  assert.equal(snapshot.usage.activity.attempts, 1)
  assert.equal(snapshot.usage.activity.preempted, 1)
  assert.equal(snapshot.usage.activity.providerTerminal, 0)
  assert.equal(snapshot.usage.activity.unclassifiedTerminal, 0)
  assert.equal(snapshot.usage.tokens.totalTokens.value, null)
  assert.equal(snapshot.usage.tokens.totalTokens.unknownCount, 1)
  assert.equal(snapshot.window.terminalReceipt.usageFinal, false)
  assert.equal(snapshot.window.terminalReceipt.reportedUsage.totalTokens, 0)
})

test('real LlmRuntime observer records only handed adapter payload and leaves request unchanged', async t => {
  const f = await fixture(t)
  await f.preparedPromise
  const service = f.ctx.windowEconomics
  const tool = f.tools.get('window_economics')
  assert.ok(service); assert.ok(tool)
  assert.equal(service.mode, 'shadow')
  assert.equal(service.automaticActionsEnabled, false)
  assert.deepEqual(tool.parameters, { type: 'object', properties: {}, additionalProperties: false })

  const options = request(f.agent)
  const originalMessages = structuredClone(options.messages)
  f.bridge.preview(options)
  const uniterated = f.llm.stream(options)
  assert.equal(service.stats().bufferedRecords, 0)
  assert.equal(f.captured.length, 0)

  const controller = new AbortController(); controller.abort()
  try { await drain(f.llm.stream(request(f.agent, controller.signal))) } catch { /* Aborted before adapter dispatch. */ }
  assert.equal(service.stats().bufferedRecords, 0)
  assert.equal(f.captured.length, 0)
  void uniterated

  await drain(f.llm.stream(options))
  assert.equal(f.captured.length, 1)
  assert.equal(official.isAgentLoopRequest(f.captured[0]), true)
  assert.deepEqual(options.messages, originalMessages)
  assert.equal(options.messages[0].content[0].text, 'original payload')
  assert.equal(f.captured[0].messages[0].content[0].text, 'late transformed payload')

  const snapshot = await tool.execute({})
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
  assert.equal(snapshot.economics.knowledge.price.status, 'unknown')
  assert.equal(snapshot.economics.knowledge.cacheWriteTokens.value, null)
  assert.equal(snapshot.economics.knowledge.reasoningTokens.value, null)
  assert.equal(snapshot.economics.hardSafety.rawSafetyTokens, null)
  assert.equal(snapshot.economics.hardSafety.safeCompactionRequired, null)
  assert.equal(snapshot.economics.wouldTransition, false)
  assert.equal(snapshot.economics.wouldContinue, false)
  assert.doesNotMatch(JSON.stringify(snapshot), /original payload|late transformed payload/)

  const denied = await tool.execute({ sessionId: 'foreign-session', provider: 'caller-provider', pricing: { known: true }, status: 'passed' },
    { agent: { session: { id: 'foreign-session' } } })
  assert.deepEqual(denied, { ok: false, code: 'WINDOW_ECONOMICS_SCOPE_DENIED' })
  const unchanged = await tool.execute({})
  assert.equal(unchanged.window.route.provider, 'fixture')
  assert.equal(unchanged.economics.knowledge.price.status, 'unknown')

  assert.equal(service.server, undefined, 'model callers have no terminal-recording API')
  f.usageChunks.push({ type: 'usage', providerRequestId: 'native-terminal-1', usage: {
    inputTokens: 10, cacheReadTokens: 1, cacheWriteTokens: 0, outputTokens: 4, reasoningTokens: 1, totalTokens: 15,
  } }, { type: 'usage', providerRequestId: 'native-terminal-1', usage: {
    inputTokens: 12, cacheReadTokens: 1, cacheWriteTokens: 0, outputTokens: 4, reasoningTokens: 1, totalTokens: 17,
  } })
  await drain(f.llm.stream(options))
  const afterUsage = await tool.execute({})
  assert.equal(afterUsage.usage.activity.attempts, 2)
  assert.equal(afterUsage.usage.activity.providerTerminal, 2)
  assert.equal(afterUsage.usage.dedup.duplicateTerminalRecords, 0)
  assert.equal(afterUsage.window.terminalReceipt.usageSnapshots, 2)
  assert.equal(afterUsage.usage.tokens.inputTokens.value, null, 'the earlier unreported request keeps the total unknown')
  assert.equal(afterUsage.usage.tokens.inputTokens.knownSubtotal, 12, 'last cumulative provider snapshot, not the sum of snapshots')
  assert.equal(afterUsage.usage.tokens.inputTokens.unknownCount, 1)
  assert.equal(afterUsage.usage.tokens.reasoningTokens.value, null)
  assert.equal(afterUsage.usage.tokens.reasoningTokens.knownSubtotal, 1)
  assert.equal(afterUsage.usage.tokens.componentTotal.value, null)
  assert.equal(afterUsage.usage.tokens.componentTotal.knownSubtotal, 17)
  assert.equal(afterUsage.usage.fees.byUnit.USD, undefined, 'unreported fees cannot be invented')
  assert.equal(afterUsage.window.route.provider, 'fixture')
  assert.equal(afterUsage.window.route.model, 'fixture-model')
  assert.equal(afterUsage.window.route.protocol, 'fixture-protocol')
  assert.equal(afterUsage.economics.knowledge.price.status, 'unknown')
  assert.equal(afterUsage.economics.wouldTransition, false)
})

test('usage buffer is bounded and effect cleanup unregisters bridge and tool registrations', async t => {
  const f = await fixture(t, { maxBufferRecords: 2 })
  await f.preparedPromise
  const service = f.ctx.windowEconomics
  await drain(f.llm.stream(request(f.agent)))
  const oldRequestId = (await service.readSnapshot(f.agent)).window.receipt.requestId
  assert.equal(service.stats().bufferedRecords, 1)
  await drain(f.llm.stream(request(f.agent)))
  assert.equal(service.stats().bufferedRecords, 2)
  await drain(f.llm.stream(request(f.agent)))
  assert.equal(service.stats().bufferedRecords, 2)
  assert.ok(service.stats().droppedRecords >= 1)
  assert.equal(service.server, undefined)
  assert.notEqual((await service.readSnapshot(f.agent)).window.receipt.requestId, oldRequestId)

  const effect = f.effects[0]()
  assert.equal(typeof effect, 'function')
  await effect()
  await effect()
  assert.equal(f.bridge.stats().registrations, 1)
  assert.equal(f.tools.has('window_economics'), false)
  assert.equal(f.ctx.windowEconomics, undefined)
  assert.equal(service.stats().disposed, true)
  assert.deepEqual(service.readSnapshot(f.agent), { ok: false, code: 'WINDOW_ECONOMICS_DISPOSED' })
})
