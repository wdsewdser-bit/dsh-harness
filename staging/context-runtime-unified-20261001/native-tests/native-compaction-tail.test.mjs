import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Session } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { BasicCompactionEngine } from '../app/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js'

const require = createRequire(new URL('../app/package.json', import.meta.url))
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')))
const { createUserMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')))
const message = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const size = message => Math.ceil(JSON.stringify(message.content).length / 4)

function fixture(config = {}, flush = async () => true) {
  const ctx = new Context()
  const session = Session.create('tail-fixture')
  const original = []
  for (const text of ['old1'.repeat(3000), 'old2'.repeat(3000), 'new3'.repeat(20), 'new4'.repeat(20)]) {
    original.push(session.append('user/message', message(text), { surfaceOp: 'append' }))
  }
  session.requestHeader = () => ({ config: { provider: 'fixture', model: 'fixture', maxTokens: 1 } })
  const meter = {
    measure(s) {
      const nodes = s.surface.nodes.map(seq => {
        const tokens = size(s.deriveEventMessage(s.eventAt(seq)))
        return { seq, tokens, heuristicTokens: tokens }
      })
      return { nodes, totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0) }
    },
    estimateMessage: size,
  }
  ctx.provide('tokenMeter', meter)
  ctx.provide('sessions', { flush })
  ctx.provide('llm', { resolveModelInfo: async () => ({ context: { contextWindow: 8000 }, defaultMaxTokens: 1 }) })
  const engine = new class extends BasicCompactionEngine {
    async summarize() { return { summary: [{ type: 'text', text: 'checkpoint exact source retained' }], provider: 'fixture', model: 'fixture' } }
  }(ctx, { auto: false, headroomTokens: 1, retainTokens: 50, ...config })
  const agent = { session, options: { provider: 'fixture', model: 'fixture' },
    runMaintenance: fn => fn(new AbortController().signal) }
  return { ctx, session, original, engine, agent, meter }
}

test('manual retention is validated, configurable and inherited by exact route', async () => {
  const f = fixture({ manualRetainTokens: 50 })
  const tail = f.original.at(-1)
  const result = await f.engine.compactNow(f.agent, new AbortController().signal)
  assert.ok(result.shadowedSeqs.includes(f.original[0].seq))
  assert.equal(result.shadowedSeqs.includes(tail.seq), false)
  assert.ok(f.session.surface.nodes.includes(tail.seq))
  assert.deepEqual(f.session.eventAt(tail.seq), tail)
  const routed = fixture({ manualRetainTokens: 0, modelPolicies: [{ provider: 'fixture', model: 'fixture', manualRetainTokens: 50 }] })
  const routedResult = await routed.engine.compactNow(routed.agent, new AbortController().signal)
  assert.equal(routedResult.shadowedSeqs.includes(routed.original.at(-1).seq), false)
  assert.throws(() => fixture({ manualRetainTokens: -1 }), /manualRetainTokens/)
  assert.throws(() => fixture({ overflowRetainTokens: 1.5 }), /overflowRetainTokens/)
})

test('retention larger than history yields no range and never calls summarizer', async () => {
  const f = fixture({ manualRetainTokens: 1000000 })
  const before = f.session.snapshotEvents()
  f.engine.summarize = () => { throw new Error('must not summarize') }
  assert.equal(await f.engine.compactNow(f.agent, new AbortController().signal), null)
  assert.deepEqual(f.session.snapshotEvents(), before)
})

test('manual compaction with unavailable durability cannot report success', async () => {
  const f = fixture({ manualRetainTokens: 50 }, async () => false)
  await assert.rejects(f.engine.compactNow(f.agent, new AbortController().signal), /durability unavailable|manual compaction/)
})

test('overflow and pressure retain their configured balanced real surface tail', async () => {
  for (const trigger of ['context-overflow', 'pressure']) {
    const f = fixture({ thresholdRatio: 0.6, overflowRetainTokens: 50 })
    f.session.append('turn/start', { turn: 'turn-fixture' })
    const result = await f.engine.compactIfNeeded(f.agent, trigger, new AbortController().signal)
    assert.ok(result)
    assert.equal(result.shadowedSeqs.includes(f.original.at(-1).seq), false, trigger)
    assert.ok(f.session.surface.nodes.includes(f.original.at(-1).seq), trigger)
  }
})

test('three actual manual compactions preserve raw original events and current tail corrections', async () => {
  const f = fixture({ manualRetainTokens: 50 })
  for (let index = 0; index < 3; index++) {
    const correction = f.session.append('user/message', message('new correction ' + index + ': do not touch active production'), { surfaceOp: 'append' })
    const result = await f.engine.compactNow(f.agent, new AbortController().signal)
    assert.ok(result)
    assert.ok(f.session.surface.nodes.includes(correction.seq))
    for (const original of f.original) assert.deepEqual(f.session.eventAt(original.seq), original)
    f.session.append('user/message', message('next work '.repeat(3000)), { surfaceOp: 'append' })
  }
  assert.equal(f.session.log.filter(event => event.type === 'compaction/end').length, 3)
})
