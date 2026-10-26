import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Session, SessionStore, installNativeSessionBridge } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { BasicCompactionEngine } from '../app/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js'
import { ToolResultPruner } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import JsonlSessionPersistence from '../app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'
import { createHistoryRecall } from '../home/profiles/web/plugins/team-v15-history-recall.mjs'
import * as deliveryDebt from '../home/profiles/web/plugins/team-v15-delivery-debt.mjs'
import { controlPlaneFor, readControlPlaneSnapshot, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { initializeNativeHost } from './native-host-fixture.mjs'

const require = createRequire(new URL('../app/package.json', import.meta.url))
const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)))
const { Context } = await load('cordis')
const { SessionQueryEngine } = await load('dsh-session-query')
const { createToolResultMessage, createUserMessage, createAssistantMessage } = await load('dsh-llm')
const hash = value => createHash('sha256').update(value).digest('hex')
const textOf = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const markerOf = message => JSON.parse(textOf(message).match(/\[tool-result-recovery\] ([^\n]+)/)?.[1] ?? 'null')
const price = message => Math.ceil(JSON.stringify(message.content).length / 4)

async function fixture(t, { flushMode = 'ok', thresholdChars = 2048 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'e1-pruner-')), ctx = new Context()
  return initializeNativeHost(ctx, async () => {
    const sessions = new SessionStore(ctx)
    const session = Session.create('e1-pruner-session', [], { id: 'e1-pruner-session', version: 4,
      cwd: directory, createdAt: Date.now(), isSeeded: false })
    sessions.enter(session); sessions.announce(session)
    const storage = new JsonlSessionPersistence(new Context(), { root: join(directory, 'sessions'), compression: 'none' })
    const handle = await storage.create(session.header)
    const important = 'MIDDLE: approval remains pending; do not mark delivery accepted.'
    const body = 'head '.repeat(1000) + important + ' tail'.repeat(1000)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      content: [{ type: 'tool-call', id: 'large-result', name: 'read_fixture', arguments: '{}' }] }) }, { surfaceOp: 'append' })
    const call = session.append('tool/call', { turn: 1, step: 1, callId: 'large-result', name: 'read_fixture', arguments: '{}' })
    const original = session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'large-result',
      content: [{ type: 'text', text: body }], isError: false }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    let persisted = 0, barriers = 0
    const state = { flushMode, onFlush: undefined }
    ctx.on('session/flush', async current => {
      assert.equal(current, session)
      barriers++
      if (state.flushMode === 'before' || state.flushMode === 'after' && barriers > 1) throw new Error('E1_PERSISTENCE_FAULT')
      await handle.append(session.snapshotEvents(persisted)); persisted = session.seq; await handle.flush()
      await state.onFlush?.(barriers)
    })
    const flush = () => sessions.flush(session)
    const bridge = installNativeSessionBridge(session, { sessionId: session.id, isolated: true, flush })
    const meter = { estimateMessage: price, measure(current) {
      const nodes = current.surface.nodes.map(seq => { const tokens = price(current.deriveEventMessage(current.eventAt(seq))); return { seq, tokens, heuristicTokens: tokens } })
      return { nodes, totalTokens: nodes.reduce((sum, row) => sum + row.tokens, 0) }
    } }
    ctx.provide('tokenMeter', meter)
    ctx.provide('llm', { resolveModelInfo: async () => ({ context: { contextWindow: 4000 }, defaultMaxTokens: 1 }) })
    const pruner = new ToolResultPruner(ctx, { thresholdChars, headChars: Math.min(256, thresholdChars - 100), tailChars: 32 })
    const engine = new class extends BasicCompactionEngine {
      async summarize() { throw new Error('pruning alone must get this fixture below threshold') }
    }(ctx, { auto: false, thresholdRatio: 0.6, headroomTokens: 1, retainTokens: 50 })
    session.requestHeader = () => ({ config: { provider: 'fixture', model: 'fixture', maxTokens: 1 } })
    const agent = { session, options: { provider: 'fixture', model: 'fixture' } }
    const control = controlPlaneFor('e1-pruner', { directory: join(directory, 'control') })
    await control.mutateHot('fixture/pruner', {}, null, () => ({}), { deferMs: 0 })
    const readDurable = () => readControlPlaneSnapshot(control.file)
    const query = new SessionQueryEngine(ctx)
    const recall = createHistoryRecall({ sessionQuery: query, control, readDurable, pageBytes: 16384,
      projection: { isAgentLoopRequest: options => options.branded === true },
      ownSessionId: session.id, agentForSession: () => agent })
    const exec = () => ({ agent, callId: 'recall-' + ++state.calls, signal: new AbortController().signal })
    state.calls = 0
    const run = input => recall.recall(input, exec())
    const prune = (signal = new AbortController().signal) => engine.compactIfNeeded(agent, 'pressure', signal)
    const debt = () => {
      assert.equal(typeof deliveryDebt.collectPrunedHistoryDebt, 'function')
      return deliveryDebt.collectPrunedHistoryDebt(readDurable(), agent)
    }
    t.after(async () => {
      state.flushMode = 'ok'; state.onFlush = undefined
      await flush().catch(() => {}); await handle.close(); await ctx.fiber.dispose(); resetControlPlaneCache()
      rmSync(directory, { recursive: true, force: true })
    })
    return { directory, ctx, session, storage, agent, original, body, important, bridge, state, pruner, engine, recall, run, prune, debt, control, flush,
      readDurable, get barriers() { return barriers }, get persisted() { return persisted } }
  })
}

test('actual pruner carries exact raw source and field hashes for the missing middle, after a real JSONL barrier', async t => {
  const f = await fixture(t)
  assert.equal(await f.prune(), null)
  const replacement = f.session.log.findLast(event => event.type === 'tool/result')
  assert.notEqual(replacement.seq, f.original.seq)
  assert.equal(textOf(replacement.data.message).includes(f.important), false)
  const metadata = markerOf(replacement.data.message)
  assert.ok(metadata, 'a generic middle-pruned marker is not an exact recovery reference')
  assert.equal(metadata.requiredFetch, true)
  assert.equal(metadata.truncated, true)
  assert.equal(metadata.revision, f.original.seq)
  assert.equal(metadata.locator.sessionId, f.session.id)
  assert.equal(metadata.locator.seq, f.original.seq)
  assert.equal(metadata.sourceHash, hash(JSON.stringify(f.original)))
  assert.equal(metadata.sha256, hash(JSON.stringify(f.original.data.message.content)))
  assert.equal(metadata.lengthUnit, 'unicode-code-points')
  assert.equal(metadata.originalLength, Array.from(f.body).length)
  assert.ok(metadata.projectedLength < metadata.originalLength)
  assert.ok(Array.from(textOf(replacement.data.message)).length <= f.pruner.config.thresholdChars)
  assert.ok(f.barriers >= 2)
  const handle = await f.storage.open(f.session.id, 'read')
  try {
    const events = (await handle.read()).events
    assert.deepEqual(events[f.original.seq], f.original)
    const cold = Session.create(f.session.id, events, handle.header)
    assert.equal(deliveryDebt.collectPrunedHistoryDebt(f.readDurable(), { session: cold }).length, 1)
  } finally { await handle.close() }
  assert.equal(f.debt().length, 1)
})

test('a failed first durability barrier leaves the full original surface untouched', async t => {
  const f = await fixture(t, { flushMode: 'before' }), before = f.session.snapshotEvents()
  await assert.rejects(f.prune(), /E1_PERSISTENCE_FAULT|PRUNE_RECOVERY_DURABILITY_UNAVAILABLE/)
  assert.deepEqual(f.session.snapshotEvents(), before)
})

test('a source-generation change during persistence cannot authorize a stale pruning pass', async t => {
  const f = await fixture(t), before = f.session.snapshotEvents()
  f.state.onFlush = () => { f.bridge.generation++ }
  await assert.rejects(f.prune(), /PRUNE_RECOVERY_CONTEXT_CHANGED/)
  assert.deepEqual(f.session.snapshotEvents(), before)
})

test('cancellation during the replacement durability barrier cannot return successful compaction', async t => {
  const f = await fixture(t), abort = new AbortController()
  f.state.onFlush = count => { if (count === 2) abort.abort() }
  await assert.rejects(f.prune(abort.signal), { name: 'AbortError' })
  assert.equal(f.debt().length, 1)
})

test('failure persisting the replacement cannot report successful compaction or lose the durable raw source', async t => {
  const f = await fixture(t, { flushMode: 'after' })
  await assert.rejects(f.prune(), /E1_PERSISTENCE_FAULT|PRUNE_RECOVERY_DURABILITY_UNAVAILABLE/)
  const handle = await f.storage.open(f.session.id, 'read')
  try {
    const raw = (await handle.read()).events[f.original.seq]
    assert.deepEqual(raw, f.original)
    assert.ok(textOf(raw.data.message).includes(f.important))
  } finally { await handle.close() }
  assert.equal(f.debt().length, 1)
})

test('an unrepresentably small exact-recovery marker preserves the full result instead of creating untraceable truncation', async t => {
  const f = await fixture(t, { thresholdChars: 128 })
  const result = f.pruner.pruneSession(f.session)
  assert.equal(result.pruned.length, 0)
  assert.equal(f.session.log.findLast(event => event.type === 'tool/result').seq, f.original.seq)
})

test('exact history server read is not recovery until the full unmodified artifact is actually handed to the adapter', async t => {
  const f = await fixture(t)
  await f.prune()
  const descriptor = (await f.run({ action: 'locate', seq: f.original.seq })).descriptor
  const fields = { locator: descriptor.locator, expectedRevision: descriptor.sourceRef.sourceRevision,
    expectedSourceHash: descriptor.sourceRef.sourceHash }
  const wrong = await f.run({ action: 'read', ...fields, expectedSourceHash: '0'.repeat(64), offset: 0 })
  assert.equal(wrong.ok, false)
  assert.equal(f.debt().length, 1)
  for (let offset = 0; offset < descriptor.bytes; offset += descriptor.pageBytes) await f.run({ action: 'read', ...fields, offset })
  const packet = await f.run({ action: 'assemble', ...fields })
  assert.deepEqual(packet.artifact.target, f.original)
  assert.equal(f.debt().length, 1, 'server retrieval does not imply model-visible recovery')
  const options = { branded: true, sessionId: f.session.id, signal: new AbortController().signal,
    messages: [createToolResultMessage({ callId: packet.deliveryCandidate.callId,
      content: [{ type: 'text', text: JSON.stringify(packet) }], isError: false })] }
  const result = f.recall.project(options)
  assert.equal(f.debt().length, 1, 'prepared/uniterated projection is not a dispatch')
  await f.recall.onDispatch({ options, inputOptions: options, result,
    receipt: { handedToAdapter: false, stage: 'prepared', requestId: 'prepared' } })
  assert.equal(f.debt().length, 1)
  const truncated = { ...options, messages: options.messages.map(message => ({ ...message, content: [{ type: 'text', text: 'summary claims all original history recovered' }] })) }
  await f.recall.onDispatch({ options: truncated, inputOptions: options, result,
    receipt: { handedToAdapter: true, stage: 'handed-to-adapter', requestId: 'truncated' } })
  assert.equal(f.debt().length, 1)
  await f.recall.onDispatch({ options, inputOptions: options, result,
    receipt: { handedToAdapter: true, stage: 'handed-to-adapter', requestId: 'exact' } })
  assert.deepEqual(f.debt(), [])
  f.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'new window' }],
    source: { kind: 'user', windowCommit: { transitionId: 'e1-next-window' } } }), { surfaceOp: 'append' })
  assert.equal(f.debt().length, 1, 'old-window raw dispatch cannot satisfy a new context')
  await f.recall.onDispatch({ options, inputOptions: options, result,
    receipt: { handedToAdapter: true, stage: 'handed-to-adapter', requestId: 'stale-projection' } })
  assert.equal(f.debt().length, 1)
  const current = f.recall.project(options)
  await f.recall.onDispatch({ options, inputOptions: options, result: current,
    receipt: { handedToAdapter: true, stage: 'handed-to-adapter', requestId: 'current-window-exact' } })
  assert.deepEqual(f.debt(), [])
  await f.flush()
})

test('legacy generic pruning and missing raw sources remain explicit debt without trusting replacement text', () => {
  const raw = { seq: 0, type: 'tool/result', data: { message: { toolCallId: 'legacy', content: [{ type: 'text', text: 'original middle' }] } } }
  const prune = { seq: 1, type: 'compaction/prune', data: { shadowedSeqs: [0] } }
  const replacement = { seq: 2, type: 'tool/result', sourceEventSeqs: [0], data: {
    message: { toolCallId: 'legacy', content: [{ type: 'text', text: '[... tool result middle pruned ...] all accepted' }] } } }
  const session = { id: 'legacy', seq: 3, log: [raw, prune, replacement] }
  assert.equal(deliveryDebt.collectPrunedHistoryDebt({}, { session })[0].sourceRef.sourceHash, hash(JSON.stringify(raw)))
  const missing = { ...session, log: [prune, replacement] }
  assert.equal(deliveryDebt.collectPrunedHistoryDebt({}, { session: missing })[0].reason, 'PRUNED_HISTORY_SOURCE_UNAVAILABLE')
  const malformed = { ...session, log: [{ ...prune, data: {} }] }
  assert.equal(deliveryDebt.collectPrunedHistoryDebt({}, { session: malformed })[0].reason, 'PRUNED_HISTORY_SOURCE_UNAVAILABLE')
})
