import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Session } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { planSurfaceTokens, commitSurfaceTokens } from '../app/node_modules/@deepseek-ai/dsh-token-meter/lib/types/surface-fold.js'
import { estimateMessage } from '../app/node_modules/@deepseek-ai/dsh-token-meter/lib/types/estimate.js'
import { contextPressureProjectionDefinition as pressure } from '../app/node_modules/@deepseek-ai/dsh-token-meter/lib/types/usage-projection.js'
import { contextBreakdownProjectionDefinition as breakdown } from '../app/node_modules/@deepseek-ai/dsh-token-meter/lib/types/breakdown-projection.js'
import { initializeNativeHost } from './native-host-fixture.mjs'

const require = createRequire(new URL('../app/package.json', import.meta.url))
const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)))
const { Context } = await load('cordis')
const { TokenMeter } = await load('dsh-token-meter')
const { SessionProjectionRegistry } = await load('dsh-session-projection')
const message = (id, text = id, window = false) => ({ id, role: 'user', content: [{ type: 'text', text }],
  source: { kind: 'user', ...(window ? { windowCommit: { transitionId: id, toWindowId: 1 } } : {}) } })
const range = (startSeq, endSeq = startSeq) => ({ startSeq, endSeq })
function fixture() {
  const session = Session.create('token-window')
  const entries = Array.from({ length: 7 }, (_, index) => session.append('user/message',
    message('m' + index, ('visible-' + index + ' ').repeat(30 + index)), { surfaceOp: 'append' }))
  return { session, seqs: entries.map(event => event.seq) }
}
function appendWindow(session, seqs) {
  return session.append('user/message', message('window', 'one checkpoint', true), {
    surfaceOp: { op: 'replace-many', ranges: [range(seqs[0], seqs[1]), range(seqs[3], seqs[4]), range(seqs[6])] },
    sourceEventSeqs: [seqs[0], seqs[1], seqs[3], seqs[4], seqs[6]] })
}
const fold = (definition, events) => events.reduce((state, event) => definition.apply(state, event), definition.init())
const sum = messages => messages.reduce((total, row) => total + estimateMessage(row), 0)

test('multi-range pricing keeps gaps, inserts one checkpoint, and matches native surface', () => {
  const { session, seqs } = fixture()
  const nodes = []
  for (const event of session.snapshotEvents()) commitSurfaceTokens(nodes, planSurfaceTokens(nodes, event))
  const before = nodes.reduce((total, row) => total + row.heuristicTokens, 0)
  const event = appendWindow(session, seqs)
  const plan = planSurfaceTokens(nodes, event)
  assert.equal(plan.deltaTokens, sum(session.deriveMessages()) - before)
  commitSurfaceTokens(nodes, plan)
  assert.deepEqual(nodes.map(row => row.seq), session.surface.nodes)
  assert.deepEqual(nodes.map(row => row.seq), [event.seq, seqs[2], seqs[5]])
  assert.equal(nodes.reduce((total, row) => total + row.heuristicTokens, 0), sum(session.deriveMessages()))
  const state = fold(breakdown, session.snapshotEvents())
  assert.equal(state.breakdown.messageTokens, sum(session.deriveMessages()))
})

test('all multi-range validation precedes any node or projection mutation', () => {
  const { session, seqs: s } = fixture()
  const nodes = session.snapshotEvents().map(event => ({ seq: event.seq, heuristicTokens: estimateMessage(event.data) }))
  const state = fold(pressure, session.snapshotEvents())
  const bad = [[], [range(s[1])], [range(s[1]), range(999)], [range(s[1], s[3]), range(s[3], s[4])],
    [range(s[4]), range(s[1])], [range(s[1]), range(s[4], s[3])], [range(s[1]), range(-0)],
    [range(s[1]), undefined], [range(s[1]), range(1.5)]]
  for (const ranges of bad) {
    const event = { seq: session.seq, type: 'user/message', data: message('bad', 'bad', true),
      surfaceOp: { op: 'replace-many', ranges } }
    const originalNodes = structuredClone(nodes), originalState = structuredClone(state)
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.throws(() => planSurfaceTokens(nodes, event))
      assert.throws(() => pressure.apply(state, event))
      assert.deepEqual(nodes, originalNodes)
      assert.deepEqual(state, originalState)
    }
  }
})

test('multi-range pricing uses current position after an earlier replacement, not numeric seq order', () => {
  const { session, seqs: s } = fixture()
  const prior = session.append('user/message', message('prior', 'earlier replacement'), {
    surfaceOp: { op: 'replace', ...range(s[1]) }, sourceEventSeqs: [s[1]] })
  const window = session.append('user/message', message('window', 'window', true), {
    surfaceOp: { op: 'replace-many', ranges: [range(prior.seq, s[2]), range(s[4], s[5])] },
    sourceEventSeqs: [prior.seq, s[2], s[4], s[5]] })
  const nodes = []
  for (const event of session.snapshotEvents()) commitSurfaceTokens(nodes, planSurfaceTokens(nodes, event))
  assert.deepEqual(nodes.map(row => row.seq), [s[0], window.seq, s[3], s[6]])
  assert.equal(nodes.reduce((total, row) => total + row.heuristicTokens, 0), sum(session.deriveMessages()))
})

test('pressure prices native windows exactly and stores only compact retained-node prices', () => {
  const { session, seqs } = fixture()
  const events = session.snapshotEvents()
  const usageEvent = { seq: session.seq, type: 'assistant/attempt', data: { turn: 1, step: 1,
    stream: [{ type: 'chunk', time: 1, chunk: { type: 'usage', usage: {
      inputTokens: 12000, outputTokens: 20, cacheReadTokens: 3000, cacheWriteTokens: 0 } } }] } }
  let state = fold(pressure, events)
  const before = state.surfaceTokens
  state = pressure.apply(state, usageEvent)
  assert.equal(state.pressureTokens, 15000)
  const event = appendWindow(session, seqs)
  state = pressure.apply(state, event)
  pressure.stateSchema.parse(state)
  assert.equal(state.surfaceTokens, sum(session.deriveMessages()))
  assert.equal(pressure.wire.view(state).projectedTokens, 15000 + state.surfaceTokens - before)
  assert.deepEqual(state.nodes.map(row => row.seq), session.surface.nodes)
  assert.equal(state.nodes.length, 3)
  for (const row of state.nodes) assert.deepEqual(Object.keys(row).sort(), ['heuristicTokens', 'seq'])
  assert.equal(pressure.stateVersion, 6)
})

test('v6 prices legacy unpriced single replacement and keeps the exact retained total', () => {
  const { session, seqs } = fixture()
  const before = fold(pressure, session.snapshotEvents())
  const event = session.append('user/message', message('legacy', 'legacy'), {
    surfaceOp: { op: 'replace', ...range(seqs[1], seqs[3]) }, sourceEventSeqs: seqs.slice(1, 4) })
  const after = pressure.apply(before, event)
  assert.equal(after.surfaceTokens, sum(session.deriveMessages()))
  assert.ok(after.surfaceTokens < before.surfaceTokens)
  assert.deepEqual(after.nodes.map(row => row.seq), session.surface.nodes)
})

test('legacy expansion and shrink followed by a window cannot make pressure checkpoints negative', () => {
  for (const expand of [true, false]) {
    const session = Session.create('legacy-mixed-' + expand)
    const entries = [0, 1, 2].map(index => session.append('user/message', message('m' + index,
      index === 0 && !expand ? 'large '.repeat(10000) : 'small'), { surfaceOp: 'append' }))
    let state = fold(pressure, session.snapshotEvents())
    const sampled = state.surfaceTokens
    state = pressure.apply(state, { type: 'assistant/attempt', data: { turn: 1, step: 1,
      stream: [{ type: 'chunk', time: 1, chunk: { type: 'usage', usage: {
        inputTokens: 30000, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } } }] } })
    const legacy = session.append('user/message', message('legacy', expand ? 'large '.repeat(10000) : 'small'), {
      surfaceOp: { op: 'replace', ...range(entries[0].seq) }, sourceEventSeqs: [entries[0].seq] })
    state = pressure.apply(state, legacy)
    const window = session.append('user/message', message('window', 'short', true), {
      surfaceOp: { op: 'replace-many', ranges: [range(legacy.seq), range(entries[2].seq)] },
      sourceEventSeqs: [legacy.seq, entries[2].seq] })
    state = pressure.apply(state, window)
    assert.equal(state.surfaceTokens, sum(session.deriveMessages()))
    assert.ok(state.surfaceTokens >= 0)
    assert.equal(pressure.wire.view(state).projectedTokens, 30000 + state.surfaceTokens - sampled)
    assert.ok(pressure.stateSchema.safeParse(state).success)
    assert.deepEqual(state.nodes.map(row => row.seq), session.surface.nodes)
  }
})

test('legacy adjacent shadow-price range mismatch remains a failure without partial state', () => {
  const { session, seqs } = fixture()
  const before = fold(pressure, session.snapshotEvents())
  const claim = pressure.apply(before, { type: 'compaction/prune', data: {
    shadowedRange: { start: seqs[0], end: seqs[1] }, shadowedTokenCount: 100 } })
  const event = session.append('user/message', message('legacy'), {
    surfaceOp: { op: 'replace', ...range(seqs[3]) }, sourceEventSeqs: [seqs[3]] })
  const original = structuredClone(claim)
  assert.throws(() => pressure.apply(claim, event), /no adjacent shadow price/)
  assert.deepEqual(claim, original)
})

test('bundled TokenMeter, projections, and v5-to-v6 cold checkpoint replay agree', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await initializeNativeHost(ctx, async () => {
    const projections = new SessionProjectionRegistry(ctx)
    const meter = new TokenMeter(ctx)
    const { session, seqs } = fixture()
    const before = meter.measure(session)
    appendWindow(session, seqs)
    const after = meter.measure(session)
    assert.equal(after.surfaceTokens, sum(session.deriveMessages()))
    assert.ok(after.surfaceTokens < before.surfaceTokens)
    assert.deepEqual(after.nodes.map(row => row.seq), session.surface.nodes)
    const snapshot = projections.snapshot(session)
    assert.equal(snapshot.values.contextBreakdown.messageTokens, after.surfaceTokens)
    const checkpoint = projections.checkpoint(session)
    assert.equal(checkpoint.contextPressure.ver, 6)
    assert.deepEqual(checkpoint.contextPressure.val.nodes.map(row => row.seq), session.surface.nodes)
    const old = { ...checkpoint, contextPressure: { ...checkpoint.contextPressure, ver: 5,
      val: { surfaceTokens: 999999 } } }
    assert.equal(projections.restoreFloor(old), 0)
    const restored = projections.restore(old, session.snapshotEvents(), 0, session.header, session.inheritedEventCount)
    assert.deepEqual(restored.snapshot.values, snapshot.values)
    assert.deepEqual(restored.checkpoint.contextPressure.val, checkpoint.contextPressure.val)
  })
})
