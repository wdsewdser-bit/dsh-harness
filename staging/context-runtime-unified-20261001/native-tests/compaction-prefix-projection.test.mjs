import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as bridgeApply } from '../home/profiles/web/plugins/request-message-projection.mjs'
import { initializeNativeHost } from './native-host-fixture.mjs'

const profileRequire = createRequire(new URL('../home/profiles/web/package.json', import.meta.url))
const { Context } = await import(pathToFileURL(profileRequire.resolve('@deepseek-ai/cordis')).href)
const profile = await import(pathToFileURL(profileRequire.resolve('@deepseek-ai/dsh-llm')).href)
const collect = async stream => { const out = []; for await (const chunk of stream) out.push(chunk); return out }
const usage = { inputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2, reasoningTokens: 1, totalTokens: 14 }
const ELIDED = '[tool result elided]'

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'compaction-prefix-'))
  const ctx = new Context()
  const llm = await initializeNativeHost(ctx, () => new profile.LlmRuntime(ctx))
  const captures = []
  const prepare = { count: 0 }
  const adapter = new class extends profile.LlmAdapter {
    providerInfo(provider) { return { id: provider, name: provider } }
    async prepareCall(provider, model) {
      prepare.count++
      return { model: { provider, id: model, name: model }, stream(options) {
        captures.push({ options })
        return (async function* () { yield { type: 'usage', usage }; yield { type: 'finish', reason: { kind: 'stop' } } })()
      } }
    }
  }()
  const release = llm.registerAdapter(['fixture'], adapter)
  const bridge = await bridgeApply(ctx, { resolveLlmModule: () => profile })
  return { root, ctx, llm, captures, prepare, release, bridge,
    async dispose() { await bridge(); release(); rmSync(root, { recursive: true, force: true }) } }
}

// Shared history: a large tool result between two ordinary turns. Built once per test so that the conversation request
// and the compaction request hold the very same message objects.
const history = () => [
  profile.createUserMessage({ content: [{ type: 'text', text: 'first question' }], source: { kind: 'user' } }),
  profile.createToolResultMessage({ callId: 'call-1', content: [{ type: 'text', text: 'BIG '.repeat(500) }], isError: false }),
  profile.createUserMessage({ content: [{ type: 'text', text: 'follow up' }], source: { kind: 'user' } }),
]
// The native compaction instruction: a user message without an id, which is what makes the whole request unrecognized.
const instruction = () => ({ role: 'user', content: [{ type: 'text', text: 'Compact the conversation above.' }] })
const conversation = (messages, purpose = 'conversation') => ({ provider: 'fixture', model: 'model', sessionId: 'isolated-session',
  purpose, messages, signal: new AbortController().signal })
const placeholder = input => ({ messages: input.messages.map(message => message.role === 'tool'
  ? { ...message, content: [{ type: 'text', text: ELIDED }] } : message) })

test('compaction request carries the conversation projection of its history and keeps the instruction object', async () => {
  const s = await setup()
  try {
    s.bridge.service.register('elide-tool', placeholder, { preview: placeholder })
    const past = history()
    const tail = instruction()
    const conv = conversation(past)
    const comp = conversation([...past, tail], 'compaction')
    await collect(s.llm.stream(conv))
    await collect(s.llm.stream(comp))
    const [convSent, compSent] = s.captures.map(capture => capture.options)
    assert.equal(compSent.messages.length, convSent.messages.length + 1)
    for (let index = 0; index < convSent.messages.length; index++) {
      assert.equal(JSON.stringify(compSent.messages[index]), JSON.stringify(convSent.messages[index]))
    }
    assert.equal(convSent.messages[1].content[0].text, ELIDED)
    assert.equal(compSent.messages.at(-1), tail)
    assert.equal(compSent.purpose, 'compaction')
    assert.equal(past[1].content[0].text, 'BIG '.repeat(500))
    assert.equal(s.bridge.service.audit(comp).transforms[0].status, 'compaction-prefix')
    assert.equal(s.bridge.service.audit(comp).transforms[0].tailMessages, 1)
  } finally { await s.dispose() }
})

test('a compaction prefix transform sees the conversation purpose and never the instruction; the legacy transform is not called', async () => {
  const s = await setup()
  try {
    const seen = []
    let legacy = 0
    s.bridge.service.register('spy', () => { legacy++; return { messages: [] } }, { preview: input => {
      seen.push({ purpose: input.purpose, count: input.messages.length, ids: input.messages.map(message => typeof message.id === 'string') })
      return { messages: input.messages }
    } })
    const past = history()
    const tail = instruction()
    await collect(s.llm.stream(conversation([...past, tail], 'compaction')))
    assert.equal(legacy, 0)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].purpose, 'conversation')
    assert.equal(seen[0].count, past.length)
    assert.ok(seen[0].ids.every(Boolean))
    assert.equal(s.captures[0].options.messages.length, past.length + 1)
    assert.equal(s.captures[0].options.messages.at(-1), tail)
  } finally { await s.dispose() }
})

test('a registration without a pure preview is skipped on compaction prefixes and is never dispatched', async () => {
  const s = await setup()
  try {
    let transformed = 0, dispatched = 0
    s.bridge.service.register('legacy-only', input => { transformed++; return { messages: input.messages.map(message => ({ ...message, content: [{ type: 'text', text: 'legacy' }] })) } }, {
      onDispatch() { dispatched++ },
    })
    const past = history()
    const comp = conversation([...past, instruction()], 'compaction')
    await collect(s.llm.stream(comp))
    assert.equal(transformed, 0)
    assert.equal(dispatched, 0)
    const receipt = s.bridge.service.audit(comp)
    assert.equal(receipt.transforms[0].status, 'compaction-prefix')
    assert.equal(receipt.transforms[1].status, 'skipped-no-pure-preview')
    assert.equal(JSON.stringify(s.captures[0].options.messages.slice(0, -1)), JSON.stringify(past))
  } finally { await s.dispose() }
})

test('the projected compaction request stays writable and unfrozen, so an assigned messages array reaches the native layer', async () => {
  const s = await setup()
  try {
    s.bridge.service.register('elide-tool', placeholder, { preview: placeholder })
    const past = history()
    const tail = instruction()
    const comp = conversation([...past, tail], 'compaction')
    const { options: projected } = s.bridge.service.preview(comp)
    assert.notEqual(projected, comp)
    assert.equal(Object.isFrozen(projected), false)
    assert.equal(Object.isFrozen(projected.messages), false)
    const replacement = [...projected.messages, profile.createUserMessage({ content: [{ type: 'text', text: 'appended' }], source: { kind: 'user' } })]
    assert.doesNotThrow(() => { projected.messages = replacement })
    assert.equal(projected.messages, replacement)
    const plan = s.bridge.service.prepare(comp)
    assert.equal(Object.isFrozen(plan.options), false)
    assert.doesNotThrow(() => { plan.options.messages = [...plan.options.messages] })
    const prepared = await s.llm.prepareCall({ provider: 'fixture', model: 'model' })
    await collect(prepared.stream(plan.options))
    assert.equal(s.captures[0].options.messages.length, past.length + 1)
    assert.equal(s.captures[0].options.messages.at(-1), tail)
  } finally { await s.dispose() }
})

test('unrecognized shapes stay wholly unrecognized and reach the native layer with their messages unchanged', async () => {
  const s = await setup()
  try {
    let transforms = 0
    s.bridge.service.register('count', input => { transforms++; return { messages: input.messages } }, {
      preview: input => { transforms++; return { messages: input.messages } } })
    const user = text => profile.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    const unlabelled = (role, text) => ({ role, content: [{ type: 'text', text }] })
    const shapes = [
      ['missing id in the middle', 'compaction', [user('a'), unlabelled('user', 'middle'), ...history().slice(1), instruction()]],
      ['two trailing messages without id', 'compaction', [user('a'), unlabelled('user', 'x'), unlabelled('user', 'y')]],
      ['a single message without id', 'compaction', [instruction()]],
      ['no id on the final message, conversation purpose', 'conversation', [user('a'), instruction()]],
      ['no id on the final message, auxiliary purpose', 'auxiliary', [user('a'), instruction()]],
    ]
    for (const [label, purpose, messages] of shapes) {
      const options = conversation(messages, purpose)
      await collect(s.llm.stream(options))
      const sent = s.captures.at(-1).options
      assert.equal(sent.messages, messages, label)
      assert.equal(s.bridge.service.audit(options).transforms[0].status, 'skipped-unrecognized-request', label)
    }
    assert.equal(transforms, 0)
  } finally { await s.dispose() }
})

test('prepare keeps the compaction-prefix projection and the prepared stream dispatches that same plan', async () => {
  const s = await setup()
  try {
    let dispatched = 0
    s.bridge.service.register('elide-tool', placeholder, { preview: placeholder, onDispatch() { dispatched++ } })
    const past = history()
    const tail = instruction()
    const comp = conversation([...past, tail], 'compaction')
    const plan = s.bridge.service.prepare(comp)
    assert.equal(plan.receipt.stage, 'prepared-compaction-prefix')
    assert.equal(plan.receipt.preparedSnapshot, false)
    assert.equal(plan.receipt.changed, true)
    assert.equal(plan.options.messages.at(-1), tail)
    assert.equal(plan.options.messages[1].content[0].text, ELIDED)
    const prepared = await s.llm.prepareCall({ provider: 'fixture', model: 'model' })
    await collect(prepared.stream(plan.options))
    assert.equal(s.captures.length, 1)
    assert.equal(s.captures[0].options, plan.options)
    const receipt = s.bridge.service.audit(undefined, plan.receipt.requestId)
    assert.equal(receipt.call, 1)
    assert.equal(receipt.stage, 'handed-to-adapter')
    assert.equal(receipt.handedToAdapter, true)
    assert.equal(receipt.preparedSnapshot, false)
    // The compaction plan has no results, so no observer is dispatched for it.
    assert.equal(dispatched, 0)
  } finally { await s.dispose() }
})

test('a throwing compaction-prefix transform fails open: the request is still sent with the prefix the other transforms produced', async () => {
  const s = await setup()
  try {
    const boom = () => { throw new Error('boom') }
    s.bridge.service.register('boom', boom, { order: 0, preview: boom })
    s.bridge.service.register('elide-tool', placeholder, { order: 10, preview: placeholder })
    const past = history()
    const tail = instruction()
    const comp = conversation([...past, tail], 'compaction')
    await collect(s.llm.stream(comp))
    assert.equal(s.captures.length, 1)
    const sent = s.captures[0].options.messages
    assert.equal(sent.length, past.length + 1)
    assert.equal(sent.at(-1), tail)
    assert.equal(sent[1].content[0].text, ELIDED)
    assert.deepEqual(s.bridge.service.audit(comp).transforms.map(row => row.status), ['compaction-prefix', 'failed-open', 'applied'])
  } finally { await s.dispose() }
})
