import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { installRequestMessageProjection } from '../home/profiles/web/plugins/request-message-projection.mjs'
import { buildContextDelivery, durableContextVersions, installContextDispatchObserver } from '../home/profiles/web/plugins/team-v14-context-delivery.mjs'

const require = createRequire(new URL('../app/package.json', import.meta.url))
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')))
const llmModule = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')))
const scope = { sessionId: 'context-dispatch', member: 'member' }
const source = { id: 'constraint', revision: 1, content: 'must preserve this constraint', required: true }
const collect = async stream => { for await (const _ of stream) {} }

function setup() {
  const ctx = new Context()
  const llm = new llmModule.LlmRuntime(ctx)
  let dispatched = 0
  llm.registerAdapter(['fixture'], new class extends llmModule.LlmAdapter {
    providerInfo(id) { return { id, name: id } }
    async prepareCall(provider, id) {
      return { model: { provider, id, name: id }, stream() {
        dispatched++
        return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })()
      } }
    }
  }())
  const bridge = installRequestMessageProjection(llm, llmModule)
  const receipts = []
  installContextDispatchObserver(bridge, { ...scope, onDispatch(message, dispatch) {
    const delivery = JSON.parse(message.content[0].text.split('\n').find(line => line.startsWith('[team v14 context manifest] ')).slice('[team v14 context manifest] '.length))
    receipts.push({ ...scope, items: delivery.items, dispatch })
  } })
  function request(extra = {}) {
    const pack = buildContextDelivery({ sources: [source], ...scope, maxTokens: 12000 })
    const message = llmModule.createUserMessage({ content: [{ type: 'text', text: pack.body }],
      source: { kind: 'team-message', plugin: 'team-v12-runtime' } })
    return llmModule.markAgentLoopRequest({ provider: 'fixture', model: 'fixture', purpose: 'conversation',
      sessionId: scope.sessionId, messages: [message], signal: new AbortController().signal, ...extra })
  }
  return { llm, bridge, receipts, request, dispatched: () => dispatched }
}

test('actual adapter boundary alone retires full context; preview and uniterated stream do not', async () => {
  const f = setup()
  const input = f.request()
  f.bridge.preview(input)
  const prepared = f.bridge.prepare(input)
  assert.equal(f.receipts.length, 0)
  const stream = f.llm.stream(prepared.options)
  assert.equal(f.receipts.length, 0)
  assert.equal(f.dispatched(), 0)
  await collect(stream)
  assert.equal(f.dispatched(), 1)
  assert.equal(f.receipts.length, 1)
  assert.equal(durableContextVersions(f.receipts, scope).has(source.id), true)
  assert.match(f.receipts[0].dispatch.adapterPayload.sha256, /^[a-f0-9]{64}$/)
  f.bridge.dispose()
})

test('actual abort before adapter cannot create a content receipt', async () => {
  const f = setup()
  const controller = new AbortController()
  const input = f.bridge.prepare(f.request({ signal: controller.signal })).options
  controller.abort()
  try { await collect(f.llm.stream(input)) } catch {}
  assert.equal(f.dispatched(), 0)
  assert.equal(f.receipts.length, 0)
  f.bridge.dispose()
})

test('final projection removal, auxiliary purpose and foreign session never acknowledge the candidate', async () => {
  for (const kind of ['removed', 'body-truncated', 'auxiliary', 'foreign']) {
    const f = setup()
    if (kind === 'removed') f.bridge.register('late-window', () => ({ messages: [] }), { order: 2000 })
    if (kind === 'body-truncated') f.bridge.register('late-window', options => ({ messages: options.messages.map(message => ({
      ...message, content: [{ type: 'text', text: message.content[0].text.split('\n')[0] }],
    })) }), { order: 2000 })
    const extra = kind === 'auxiliary' ? { purpose: 'compaction' } : kind === 'foreign' ? { sessionId: 'foreign' } : {}
    await collect(f.llm.stream(f.request(extra)))
    assert.equal(f.dispatched(), 1)
    assert.equal(f.receipts.length, 0, kind)
    f.bridge.dispose()
  }
})
