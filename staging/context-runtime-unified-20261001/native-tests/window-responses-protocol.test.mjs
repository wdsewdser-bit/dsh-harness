import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PiAiAdapter } from '../app/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'
import { convertResponsesMessages } from '../app/node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js'
import { proveCompletedReasoningSpan } from '../home/profiles/web/plugins/team-v15-window-protocol.mjs'
import { windowHash } from '../home/profiles/web/plugins/team-v15-window-checkpoint.mjs'
import { installReplayTrialGuard } from '../tools/window-protocol-trial.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const raw = readFileSync(new URL('../lab-runs/natural-window-shadow-20261003-1225/canonical-journal.json', import.meta.url), 'utf8')
assert.equal(hash(raw), '05be41915bb056e2955021664576b666154070e656f624a786493c31085a9cc1')
const journal = JSON.parse(raw)
const messages = journal.flatMap(event => event.type === 'user/message' ? [event.data]
  : event.type === 'assistant/message' ? [event.data.message]
    : event.type === 'tool/result' && event.data.message ? [event.data.message] : [])
const firstEnd = journal.find(event => event.type === 'turn/end').seq
const firstIds = new Set(journal.filter(event => event.seq <= firstEnd).flatMap(event =>
  event.type === 'user/message' ? [event.data.id] : event.data.message ? [event.data.message.id] : []))
const model = { provider: 'opencodego', id: 'deepseek-v4.1-flash', api: 'openai-responses', input: ['text'],
  reasoning: true, contextWindow: 1000000 }

// Only the terminal transport is replaced. Both installed conversion layers run.
async function convert(original, strict = false) {
  const input = structuredClone(original), before = JSON.stringify(input)
  const degraded = [], contexts = [], payloads = []
  const profile = { modelErrors: new Map(), streamIdleTimeoutMs: 1000 }
  const adapter = new PiAiAdapter({ resolveApiKey: async () => 'local-test-no-provider',
    onReplayDegrade: row => degraded.push(row) })
  const restore = strict ? installReplayTrialGuard(adapter) : () => {}
  const snapshot = { profiles: new Map([[model.provider, profile]]), models: {
    getModel: () => model,
    streamSimple(actualModel, context) {
      contexts.push(structuredClone(context))
      payloads.push(convertResponsesMessages(actualModel, context, new Set(['openai', 'openai-codex', 'opencode'])))
      return (async function* () {
        yield { type: 'done', message: { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          content: [{ type: 'text', text: 'LOCAL_CONVERTER_TERMINAL' }], stopReason: 'stop', timestamp: 0,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } } }
      })()
    },
  } }
  try {
    for await (const _ of adapter.streamWithSnapshot({ provider: model.provider, model: model.id,
      messages: input, signal: new AbortController().signal }, snapshot)) {}
  } finally { restore() }
  assert.equal(JSON.stringify(input), before)
  assert.equal(contexts.length, 1)
  return { context: contexts[0], payload: payloads[0], degraded }
}

test('installed PiAiAdapter and Responses converter preserve real DS reasoning and complete tool pairs without degradation', async () => {
  const result = await convert(messages)
  assert.equal(result.degraded.length, 0)
  const originals = messages.filter(message => message.role === 'assistant')
  const converted = result.context.messages.filter(message => message.role === 'assistant')
  assert.equal(converted.length, originals.length)
  originals.forEach((message, i) => message.content.forEach((block, index) => {
    const replay = message.source.replayState.blocks[index]
    if (block.type === 'reasoning') {
      assert.equal(converted[i].content[index].thinking, block.text)
      assert.equal(converted[i].content[index].thinkingSignature, replay.thinkingSignature)
      if (replay.thinkingSignature) assert.ok(result.payload.some(item => JSON.stringify(item) === replay.thinkingSignature))
    }
  }))
  const calls = result.payload.filter(item => item.type === 'function_call')
  const results = result.payload.filter(item => item.type === 'function_call_output')
  assert.equal(calls.length, 2)
  assert.equal(results.length, 2)
  assert.deepEqual(results.map(item => item.call_id), calls.map(item => item.call_id))
  assert.ok(!JSON.stringify(result.payload).includes('No result provided'))
})

test('whole completed-turn deletion removes its reasoning/calls/results atomically and leaves later exact replay unchanged', async () => {
  const baseline = await convert(messages)
  const remaining = messages.filter(message => !firstIds.has(message.id))
  assert.ok(remaining.length > 0 && remaining.length < messages.length)
  const projected = await convert(remaining)
  assert.equal(projected.degraded.length, 0)
  const firstCalls = messages.filter(message => firstIds.has(message.id))
    .flatMap(message => message.content.filter(block => block.type === 'tool-call').map(block => block.id.split('|')[0]))
  assert.ok(!projected.payload.some(item => firstCalls.includes(item.call_id)))
  assert.equal(projected.payload.filter(item => item.type === 'function_call').length, 1)
  assert.equal(projected.payload.filter(item => item.type === 'function_call_output').length, 1)
  const laterAssistant = projected.context.messages.filter(message => message.role === 'assistant')
  assert.deepEqual(laterAssistant, baseline.context.messages.filter(message => message.role === 'assistant').slice(-laterAssistant.length))
})

test('missing tool result is silently synthesized by official converter and must never count as exact recovery', async () => {
  const partial = messages.filter(message => message.role !== 'tool')
  const result = await convert(partial)
  const synthetic = result.payload.filter(item => item.type === 'function_call_output' && JSON.stringify(item.output).includes('No result provided'))
  assert.equal(synthetic.length, 2)
})

test('malformed same-route replay is degraded by actual adapter and must not silently certify a projected request', async () => {
  const changed = structuredClone(messages)
  const assistant = changed.find(message => message.role === 'assistant' && message.content.some(block => block.type === 'reasoning'))
  assistant.source.replayState.response.version = -1
  const result = await convert(changed)
  assert.equal(result.degraded.length, 1)
  assert.ok(result.degraded[0].reason)
})

test('canonical whole-turn reasoning proof binds exact events, signed replay and route without trusting completion claims', () => {
  const group = journal.filter(event => event.seq < firstEnd && firstIds.has(messageOf(event)?.id)
    && !['system', 'developer'].includes(messageOf(event)?.role))
  const source = { events: journal, messages }
  const span = { status: 'completed', messageIds: group.map(event => messageOf(event).id),
    eventRefs: group.map(event => ({ seq: event.seq, sha256: windowHash(event) })) }
  const options = { provider: model.provider, model: model.id }
  assert.equal(proveCompletedReasoningSpan(source, span, options), true)
  assert.equal(proveCompletedReasoningSpan(source, { ...span, messageIds: span.messageIds.slice(1), eventRefs: span.eventRefs.slice(1) }, options), false)
  assert.equal(proveCompletedReasoningSpan(source, span, { ...options, model: 'other-model' }), false)
  const cancelled = structuredClone(source)
  cancelled.events.find(event => event.seq === firstEnd).data.reason.kind = 'cancelled'
  assert.equal(proveCompletedReasoningSpan(cancelled, span, options), false)
  const changed = structuredClone(source)
  changed.messages.find(message => message.content.some(block => block.type === 'reasoning')).source.replayState.response.version = -1
  assert.equal(proveCompletedReasoningSpan(changed, span, options), false)
})
const messageOf = event => event.type === 'user/message' ? event.data : event.data?.message

test('trial replay guard rejects actual adapter degradation before terminal transport or provider dispatch', async () => {
  const changed = structuredClone(messages)
  changed.find(message => message.role === 'assistant').source.replayState.response.version = -1
  await assert.rejects(convert(changed, true), {code:'LAB_REPLAY_DEGRADE_REFUSED'})
  assert.equal((await convert(messages, true)).degraded.length, 0)
  assert.throws(() => installReplayTrialGuard({config:{resolveApiKey(){}}}), /ACTUAL_PI_ADAPTER_REQUIRED/)
})
