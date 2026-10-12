// Offline race matrix: Instant steer/preempt/abort x W2 window transition x compaction.
// Real ReactLoopAgent, real native bridge, real JSONL fsync barrier, real BasicCompactionEngine
// and real window coordinator; only the model adapters are fakes with controllable deferreds.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Session, SessionStore, installNativeSessionBridge } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { ReactLoopAgent, ReactLoopInbox, inboxProjectionDefinition, turnBoundaryProjectionDefinition } from '../app/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'
import Jsonl from '../app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'
import { createJsonlWindowBarrier } from '../app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/window-barrier.js'
import { BasicCompactionEngine } from '../app/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js'
import { createWindowTransition } from '../home/profiles/web/plugins/team-v15-window-transition.mjs'
import { windowHash as hash } from '../home/profiles/web/plugins/team-v15-window-checkpoint.mjs'
import { initializeNativeHost } from './native-host-fixture.mjs'

const require = createRequire(new URL('../app/package.json', import.meta.url))
const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)))
const { Context } = await load('cordis')
const { SessionProjectionRegistry } = await load('dsh-session-projection')
const { SystemPrompt } = await load('dsh-system-prompt')
const { AgentRegistry } = await load('dsh-agent')
const { LlmRuntime, LlmAdapter, createUserMessage, createSystemMessage } = await load('dsh-llm')

const deferred = () => Promise.withResolvers()
// Real fsync/readback takes wall time, so absence checks and polling use timers, not event-loop ticks.
const settle = (count = 6) => new Promise(resolve => setTimeout(resolve, count * 5))
const bounded = (label, promise, ms = 8000) => {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('RACE_TIMEOUT_' + label)), ms) })])
    .finally(() => clearTimeout(timer))
}
const input = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', rpcId: text } })
const seedMessage = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const textOf = message => (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
const tokens = message => Math.ceil(JSON.stringify(message.content).length / 4)

// ---------------------------------------------------------------------------
// Fake adapters. A conversation request or a summarization request can be parked
// at a precise point and released (or aborted through its real request.signal).
// ---------------------------------------------------------------------------
function parked(signal, release) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(signal.reason)
    signal?.addEventListener('abort', fail, { once: true })
    if (signal?.aborted) fail()
    release.promise.then(resolve, reject)
  })
}
function adapterOf(onStream) {
  return new class extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: provider } }
    async prepareCall(provider, model) { return { model: { provider, id: model, name: model }, stream: onStream } }
  }()
}

async function host(t) {
  const root = mkdtempSync(join(tmpdir(), 'instant-window-compaction-'))
  const ctx = new Context(), storageCtx = new Context(), engineCtx = new Context()
  const requests = [], summaryRequests = [], agentErrors = []
  const plans = { conversation: [], summary: [] }
  const conversation = request => (async function* () {
    const entry = { n: requests.length + 1, signal: request.signal, texts: request.messages.filter(m => m.role === 'user').map(textOf),
      entered: deferred(), release: deferred(), aborted: false }
    requests.push(entry)
    const plan = plans.conversation.shift() ?? 'answer'
    if (plan === 'park') {
      yield { type: 'text-delta', index: 0, text: 'obsolete-partial' }
      entry.entered.resolve()
      try { await parked(request.signal, entry.release) } catch (error) { entry.aborted = request.signal.aborted; throw error }
    } else entry.entered.resolve()
    yield { type: 'text-delta', index: 0, text: 'answer-' + entry.n }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  const summary = request => (async function* () {
    const plan = plans.summary.shift() ?? {}
    const entry = { signal: request.signal, entered: deferred(), release: deferred(), done: false }
    summaryRequests.push(entry)
    entry.entered.resolve()
    if (plan.park) await parked(request.signal, entry.release)
    yield { type: 'text-delta', index: 0, text: 'SUMMARY-OF-OLD-WINDOW' }
    yield { type: 'finish', reason: { kind: 'stop' } }
    entry.done = true
    plan.onFinish?.()
  })()
  const header = { id: 'race', version: 4, cwd: root, createdAt: Date.now(), isSeeded: false }
  let head, seeds
  const base = await initializeNativeHost(ctx, async () => {
    const sessions = new SessionStore(ctx), projections = new SessionProjectionRegistry(ctx)
    projections.register(inboxProjectionDefinition); projections.register(turnBoundaryProjectionDefinition)
    new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
    new AgentRegistry(ctx)
    new LlmRuntime(ctx).registerAdapter(['fixture'], adapterOf(conversation))
    const session = Session.create(header.id, undefined, header)
    // Bootstrap turn 1 the way the loop would: the protected (empty) system head, then deterministic old history.
    session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
    head = session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('') }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    seeds = [
      session.append('user/message', seedMessage('h1', 'old-one '.repeat(1500)), { surfaceOp: 'append' }),
      session.append('user/message', seedMessage('h2', 'old-two '.repeat(1500)), { surfaceOp: 'append' }),
      session.append('user/message', seedMessage('h3', 'tail-three '.repeat(10)), { surfaceOp: 'append' }),
      session.append('user/message', seedMessage('h4', 'tail-four '.repeat(10)), { surfaceOp: 'append' }),
    ]
    sessions.enter(session); sessions.announce(session)
    ctx.on('agent/error', event => { agentErrors.push(String(event.error?.code ?? '') + ':' + String(event.error?.message ?? event.error)) })
    const agent = new ReactLoopAgent(ctx, session.id, { provider: 'fixture', model: 'fixture' }, session)
    ctx.agents.enter(agent, { dispose: async () => {} })
    return { sessions, projections, session, agent }
  })
  const { session, agent, projections } = base
  const backend = await initializeNativeHost(storageCtx, async () => new Jsonl(storageCtx, { root, compression: 'none' }))
  const handle = await backend.create(session.header)
  // Deterministic old history: two large windows to be replaced, two small tail messages to keep.
  const barrier = createJsonlWindowBarrier(handle, session)
  const bridge = installNativeSessionBridge(session, { isolated: true, sessionId: session.id, flush: async () => { await barrier.persist(); return true } })
  await barrier.persist()
  const durability = { holdFlush: undefined }
  const meter = {
    measure(s) {
      const nodes = s.surface.nodes.map(seq => {
        const message = s.deriveEventMessage(s.eventAt(seq)), cost = message ? tokens(message) : 0
        return { seq, tokens: cost, heuristicTokens: cost }
      })
      return { nodes, totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0) }
    },
    estimateMessage: tokens,
  }
  const engine = await initializeNativeHost(engineCtx, async () => {
    new LlmRuntime(engineCtx).registerAdapter(['fixture'], adapterOf(summary))
    engineCtx.provide('tokenMeter', meter)
    engineCtx.provide('sessions', { flush: async s => {
      if (durability.holdFlush) await durability.holdFlush.promise
      return (await createJsonlWindowBarrier(handle, s).persist()).durable === true
    } })
    return new BasicCompactionEngine(engineCtx, { auto: false, headroomTokens: 1, retainTokens: 50, manualRetainTokens: 50 })
  })
  // Participating-writer stand-in with a real mutual-exclusion lock.
  let critical = { authority: 1, identity: 1, lease: 1, plan: 1, config: 1 }, lock
  const participation = {
    certificate: () => ({ kind: 'participating-writers-v1', sessionId: session.id, domains: ['authority', 'identity', 'lease', 'plan', 'config', 'input-claim'], verified: true }),
    verifyCertificate: c => c.verified === true,
    read: () => structuredClone(critical),
    acquire(expected) { assert.deepEqual(critical, expected); if (lock) throw new Error('critical locked'); return (lock = {}) },
    assertHeld(token, expected) { if (lock !== token || hash(critical) !== hash(expected)) throw new Error('critical CAS'); return true },
    release(token) { if (lock !== token) throw new Error('stale critical worker'); lock = undefined },
  }
  const state = { fault: async () => {}, maintenance: undefined }
  const coordinator = createWindowTransition({ session, bridge, barrier, participation, isolated: true, sessionId: session.id,
    validateProposal: p => p.checkpoint.authorityVerified === true,
    // Mirrors the production boundary: only inside this agent's own, still-live maintenance phase.
    safeBoundary: () => state.maintenance !== undefined && agent.phase === state.maintenance.phase && agent.phase.kind === 'maintenance'
      && !state.maintenance.signal.aborted && bridge.activeEffects === 0,
    fault: stage => state.fault(stage) })
  const proposal = () => ({ checkpoint: { id: 'cp', authorityVerified: true }, message: seedMessage('window-checkpoint-' + session.seq, 'server checkpoint of h1+h2'),
    range: { startSeq: seeds[0].seq, endSeq: seeds[1].seq }, sourceEventSeqs: [seeds[0].seq, seeds[1].seq],
    protocolCertificate: 'fixture-only', transformFingerprint: hash('order') })
  // The production W2 server surface always enters through agent.runMaintenance.
  const transition = async (transitionId, fault = async () => {}) => agent.runMaintenance(async signal => {
    state.maintenance = { signal, phase: agent.phase }; state.fault = fault
    try { return await coordinator.transition(proposal(), { transitionId }) } finally { state.maintenance = undefined; state.fault = async () => {} }
  })
  const f = { root, ctx, session, agent, bridge, barrier, handle, projections, engine, head, seeds, requests, summaryRequests, agentErrors, plans, durability,
    coordinator, transition, header, backend }
  t.after(async () => {
    for (const row of [...requests, ...summaryRequests]) row.release.resolve()
    try { agent.cancel({ kind: 'user' }, { keepInbox: true }); await bounded('cleanup-idle', agent.whenIdle()) } catch {}
    try { await handle.close() } catch {}
    for (const c of [ctx, storageCtx, engineCtx]) try { await initializeNativeHost(c, () => c.fiber.dispose()) } catch {}
    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
  return f
}

// Independent cold open of the JSONL artifact through a second backend instance.
async function coldRead(f) {
  await f.barrier.persist()
  const ctx = new Context()
  const backend = await initializeNativeHost(ctx, async () => new Jsonl(ctx, { root: f.root, compression: 'none' }))
  const reader = await backend.open(f.session.id, 'read')
  try { return (await reader.read()).events } finally {
    await reader.close()
    await initializeNativeHost(ctx, () => ctx.fiber.dispose())
  }
}
const eventsOf = f => f.session.snapshotEvents()
const inboxIds = inbox => ({ nextStep: inbox.nextStep.map(m => m.source?.rpcId ?? m.id), nextTurn: inbox.nextTurn.map(m => m.source?.rpcId ?? m.id) })
const accepted = (events, id) => events.filter(e => e.type === 'native/input-accepted' && e.data.inputId === id && e.data.action !== 'promote')
const until = async (predicate, label = 'condition') => { for (let i = 0; i < 2000; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)) } throw new Error('RACE_UNTIL_' + label) }
const delivered = (events, id) => events.filter(e => e.type === 'user/message' && e.data.source?.rpcId === id)
const surfaceTexts = session => session.deriveMessages().map(textOf)

/** Cold JSONL must equal live memory; replaying it must rebuild the same world and inbox. */
async function assertColdMatchesLive(f, { pending = {} } = {}) {
  const live = eventsOf(f), cold = await coldRead(f)
  assert.deepEqual(cold, eventsOf(f), 'cold JSONL events differ from live journal')
  const restored = Session.create(f.session.id, cold, f.header)
  assert.deepEqual([...restored.surface.nodes], [...f.session.surface.nodes], 'cold surface differs')
  assert.deepEqual(surfaceTexts(restored), surfaceTexts(f.session), 'cold derived world differs')
  const inbox = new ReactLoopInbox(f.projections, restored, { emit() {} })
  assert.deepEqual(inboxIds(inbox), { nextStep: pending.nextStep ?? [], nextTurn: pending.nextTurn ?? [] }, 'cold inbox differs')
  assert.deepEqual(inboxIds(f.agent.inbox), inboxIds(inbox), 'live and cold inbox differ')
  // every compaction/start is closed in the cold artifact
  const starts = cold.filter(e => e.type === 'compaction/start').map(e => e.data.compactionId)
  for (const id of starts) assert.equal(cold.filter(e => e.type === 'compaction/end' && e.data.compactionId === id).length, 1, 'unclosed compaction ' + id)
  return { live, cold, restored }
}
function assertRawPreserved(f, before) {
  const now = eventsOf(f)
  assert.deepEqual(now.slice(0, before.length), before, 'old-window raw journal prefix changed')
  for (const seed of f.seeds) assert.deepEqual(f.session.eventAt(seed.seq), seed, 'raw seed event ' + seed.seq + ' mutated')
}
function assertDeliveredOnce(f, ids, { ordered = true } = {}) {
  const events = eventsOf(f)
  for (const id of ids) {
    assert.equal(accepted(events, id).length, 1, 'accepted exactly once: ' + id)
    assert.equal(delivered(events, id).length, 1, 'delivered exactly once: ' + id)
  }
  const order = ids.map(id => delivered(events, id)[0].seq)
  if (ordered) assert.deepEqual([...order].sort((a, b) => a - b), order, 'delivery order differs from acceptance order: ' + ids.join(','))
  assert.equal(f.agent.inbox.hasPending, false, 'inbox not drained')
}

test('harness: summary adapter and conversation adapter are wired to the real engine and agent', async t => {
  const f = await host(t)
  const before = eventsOf(f)
  const result = await bounded('compact', f.engine.compactNow(f.agent, new AbortController().signal))
  assert.deepEqual(result.shadowedSeqs, [f.seeds[0].seq, f.seeds[1].seq])
  assert.equal(f.summaryRequests.length, 1)
  assertRawPreserved(f, before)
  await assertColdMatchesLive(f)
  await f.agent.followup(input('hello')); await bounded('idle', f.agent.whenIdle())
  assert.deepEqual(f.agentErrors, [])
  assert.deepEqual(f.requests.map(r => r.texts.at(-1)), ['hello'])
})

// ---------------------------------------------------------------------------
// 2. compactNow summary in flight + steer
// ---------------------------------------------------------------------------
test('steer lands while the compactNow summary request is in flight: durable accept, compaction commits, successor drains A,B once after it closes', async t => {
  const f = await host(t), raw = eventsOf(f)
  f.plans.summary.push({ park: true })
  const compaction = f.engine.compactNow(f.agent, new AbortController().signal)
  const outcome = compaction.then(value => ({ value }), error => ({ error }))
  await until(() => f.summaryRequests.length === 1, 'summary-entered')
  await bounded('steer-A', f.agent.steer(input('A'))); await bounded('steer-B', f.agent.steer(input('B')))
  // accept returned only after the fsynced journal contained both inputs
  const disk = await f.barrier.read()
  assert.deepEqual(['A', 'B'].map(id => accepted(disk, id).length), [1, 1])
  assert.equal(f.requests.length, 0, 'a conversation request was dispatched while maintenance owned the agent')
  assert.equal(f.summaryRequests[0].signal.aborted, false, 'steer must not kill the manual compaction request')
  assert.equal(f.agent.status, 'idle'); assert.equal(f.agent.phase.kind, 'maintenance')
  assert.deepEqual(inboxIds(f.agent.inbox).nextStep, ['A', 'B'])
  f.summaryRequests[0].release.resolve()
  const { value, error } = await bounded('compaction', outcome)
  assert.equal(error, undefined, String(error?.message)); assert.deepEqual(value.shadowedSeqs, [f.seeds[0].seq, f.seeds[1].seq])
  await bounded('idle', f.agent.whenIdle())
  assert.deepEqual(f.agentErrors, [])
  assertRawPreserved(f, raw)
  assertDeliveredOnce(f, ['A', 'B'])
  const events = eventsOf(f), end = events.find(e => e.type === 'compaction/end')
  assert.ok(end && !end.data.error)
  assert.ok(delivered(events, 'A')[0].seq > end.seq, 'successor consumed input before compaction closed')
  assert.equal(f.requests.length, 1, 'A and B must be batched into one successor request')
  const texts = f.requests[0].texts
  assert.deepEqual(texts.slice(-2), ['A', 'B'])
  assert.ok(texts.some(text => text.includes('SUMMARY-OF-OLD-WINDOW')) && !texts.some(text => text.includes('old-one')), 'successor must see the compacted window only')
  assert.deepEqual(surfaceTexts(f.session).filter(text => text.includes('old-one') || text.includes('old-two')), [])
  await assertColdMatchesLive(f)
})

// ---------------------------------------------------------------------------
// 3. compactNow summary in flight + hard abort
// ---------------------------------------------------------------------------
async function cancelDuringCompaction(f, { steerBefore = true, steerAfter = true } = {}) {
  const compaction = f.engine.compactNow(f.agent, new AbortController().signal)
  const outcome = compaction.then(value => ({ value }), error => ({ error }))
  await until(() => f.summaryRequests.length === 1, 'summary-entered')
  if (steerBefore) await bounded('steer-A', f.agent.steer(input('A')))
  f.agent.cancel({ kind: 'user' }, { keepInbox: true })
  if (steerAfter) await bounded('steer-B', f.agent.steer(input('B')))
  return outcome
}
test('hard abort during the compactNow summary request: no commit, no successor, accepted inputs retained and later drained once in order', async t => {
  const f = await host(t), raw = eventsOf(f)
  f.plans.summary.push({ park: true })
  const outcome = await bounded('outcome', cancelDuringCompaction(f))
  assert.equal(outcome.value, undefined)
  assert.equal(outcome.error?.code, 'cancelled', String(outcome.error?.message))
  assert.equal(f.summaryRequests[0].signal.aborted, true, 'summary request kept running after hard abort')
  const events = eventsOf(f)
  assert.equal(events.filter(e => e.type === 'compaction/summary').length, 0)
  assert.equal(events.filter(e => e.surfaceOp?.op === 'replace').length, 0, 'aborted compaction mutated the surface')
  const start = events.find(e => e.type === 'compaction/start'), end = events.find(e => e.type === 'compaction/end')
  assert.ok(start && end && end.data.compactionId === start.data.compactionId && end.data.error, 'aborted compaction must close its marker with the error')
  assertRawPreserved(f, raw)
  assert.deepEqual(f.session.surface.nodes.slice(0, 5), [f.head.seq, ...f.seeds.map(s => s.seq)])
  await bounded('idle', f.agent.whenIdle()); await settle(20)
  assert.equal(f.requests.length, 0, 'abort revived a successor')
  assert.equal(f.bridge.hardAborted, true)
  assert.deepEqual(inboxIds(f.agent.inbox), { nextStep: ['A', 'B'], nextTurn: [] }, 'accepted inputs were lost or consumed by abort')
  assert.deepEqual(['A', 'B'].map(id => delivered(events, id).length), [0, 0])
  assert.equal(accepted(events, 'B')[0].data.preemptGeneration, undefined, 'a post-abort steer must not mint a preempt generation')
  await assertColdMatchesLive(f, { pending: { nextStep: ['A', 'B'] } })
  // The next explicit user turn is the receipt boundary: it drains the retained inputs exactly once, in acceptance order.
  await f.agent.followup(input('C')); await bounded('idle-2', f.agent.whenIdle())
  assert.deepEqual(f.agentErrors, [])
  assert.equal(f.requests.length, 1)
  assert.deepEqual(f.requests[0].texts.slice(-3), ['A', 'B', 'C'])
  assertDeliveredOnce(f, ['A', 'B', 'C'])
  await assertColdMatchesLive(f)
})
test('abort lands exactly when the summary stream completes: abort wins, compaction cannot commit', async t => {
  const f = await host(t), raw = eventsOf(f)
  f.plans.summary.push({ onFinish: () => f.agent.cancel({ kind: 'user' }, { keepInbox: true }) })
  const outcome = await bounded('outcome', cancelDuringCompaction(f, { steerBefore: true, steerAfter: false }))
  assert.equal(outcome.error?.code, 'cancelled', String(outcome.error?.message))
  const events = eventsOf(f)
  assert.equal(events.filter(e => e.type === 'compaction/summary').length, 0, 'summary committed after abort')
  assert.equal(events.filter(e => e.surfaceOp?.op === 'replace').length, 0)
  assertRawPreserved(f, raw)
  await bounded('idle', f.agent.whenIdle()); await settle(20)
  assert.equal(f.requests.length, 0)
  assert.deepEqual(inboxIds(f.agent.inbox).nextStep, ['A'])
  await assertColdMatchesLive(f, { pending: { nextStep: ['A'] } })
})

// ---------------------------------------------------------------------------
// 1. W2 window transition + steer (PREPARED, COMMITTED-not-published, published)
// ---------------------------------------------------------------------------
const windowCommitOf = events => events.filter(e => e.type === 'user/message' && e.data.source?.windowCommit)
function assertWindowWorld(f, raw, ids, { batched = true } = {}) {
  const events = eventsOf(f), commits = windowCommitOf(events), commit = commits[0]
  assert.equal(commits.length, 1, 'exactly one durable window commit')
  assert.equal(events.filter(e => e.type === 'native/window-aborted').length, 0)
  assert.equal(events.filter(e => e.type === 'native/window-intent').length, 1)
  assert.deepEqual(commit.data.source.windowCommit.consumedInputIds, [], 'transition must not consume queued inputs')
  assertRawPreserved(f, raw)
  for (const id of ids) {
    const acceptance = accepted(events, id)[0], seq = delivered(events, id)[0].seq
    assert.ok(acceptance.seq > commit.data.source.windowCommit.pendingInputCutoff, 'input ' + id + ' accepted before the transition cutoff')
    assert.ok(seq > commit.seq, 'input ' + id + ' was consumed before the new window was published')
    assert.equal(commit.sourceEventSeqs.includes(acceptance.seq) || commit.sourceEventSeqs.includes(seq), false, 'checkpoint swallowed input ' + id)
  }
  const world = surfaceTexts(f.session)
  assert.ok(world.some(text => text.includes('server checkpoint of h1+h2')))
  assert.equal(world.some(text => text.includes('old-one') || text.includes('old-two')), false, 'old window still on the live surface')
  if (batched) assert.deepEqual(world.slice(-ids.length - 1, -1), ids, 'successor answer must follow the drained inputs')
  else assert.deepEqual(world.filter(text => ids.includes(text)), ids)
}
for (const stage of ['prepared-durable', 'commit-appended', 'commit-durable', 'before-publish', 'after-receipt']) {
  test('W2 transition (' + stage + ') + steer A,B: durable accept, nothing consumed into the checkpoint, successor drains once on the new window', async t => {
    const f = await host(t), raw = eventsOf(f)
    let fence
    const steers = async () => { await bounded('steer-A', f.agent.steer(input('A'))); await bounded('steer-B', f.agent.steer(input('B'))) }
    // After the receipt there is no fence: the first accepted steer wakes the idle agent at once, so batching is not promised.
    const batched = stage !== 'after-receipt'
    const receipt = await bounded('transition', f.transition('race-' + stage, async at => {
      if (at !== stage) return
      await steers()
      fence = { requests: f.requests.length, paused: f.coordinator.status().paused, disk: await f.barrier.read(), phase: f.agent.phase.kind }
    }))
    assert.equal(receipt.state, 'COMMITTED'); assert.equal(receipt.durable, true)
    if (stage === 'after-receipt') { await steers(); fence = undefined } else {
      assert.equal(fence.paused, true); assert.equal(fence.phase, 'maintenance')
      assert.equal(fence.requests, 0, 'a model request was dispatched while the window fence was up')
      assert.deepEqual(['A', 'B'].map(id => accepted(fence.disk, id).length), [1, 1], 'accepted input was not fsynced before acknowledgement')
      assert.ok(accepted(fence.disk, 'A')[0].seq > fence.disk.find(e => e.type === 'native/window-intent').seq)
    }
    await bounded('idle', f.agent.whenIdle())
    assert.deepEqual(f.agentErrors, [])
    assertDeliveredOnce(f, ['A', 'B'])
    assertWindowWorld(f, raw, ['A', 'B'], { batched })
    if (batched) assert.equal(f.requests.length, 1, 'A and B must be one batched successor request')
    assert.deepEqual(f.requests.at(-1).texts.filter(text => ['A', 'B'].includes(text)), ['A', 'B'])
    for (const request of f.requests) {
      assert.equal(request.texts.some(text => text.includes('old-one')), false, 'a request used the replaced window')
      assert.ok(request.texts.some(text => text.includes('server checkpoint of h1+h2')))
    }
    await assertColdMatchesLive(f)
    assert.equal((await f.coordinator.recover()).state, 'clean')
  })
}

// ---------------------------------------------------------------------------
// 5. abort never revives a successor (window variant)
// ---------------------------------------------------------------------------
for (const stage of ['prepared-durable', 'commit-durable']) {
  test('hard abort inside a W2 transition (' + stage + '): commit stays valid, no successor, A,B retained, later user turn drains A,B,C once', async t => {
    const f = await host(t), raw = eventsOf(f)
    const receipt = await bounded('transition', f.transition('abort-' + stage, async at => {
      if (at !== stage) return
      await bounded('steer-A', f.agent.steer(input('A')))
      f.agent.cancel({ kind: 'user' }, { keepInbox: true })
      await bounded('steer-B', f.agent.steer(input('B')))
    }))
    assert.equal(receipt.state, 'COMMITTED')
    await bounded('idle', f.agent.whenIdle()); await settle(20)
    assert.equal(f.requests.length, 0, 'abort revived a successor after the window committed')
    assert.equal(f.bridge.hardAborted, true)
    assert.deepEqual(inboxIds(f.agent.inbox), { nextStep: ['A', 'B'], nextTurn: [] })
    assert.equal(windowCommitOf(eventsOf(f)).length, 1); assertRawPreserved(f, raw)
    await assertColdMatchesLive(f, { pending: { nextStep: ['A', 'B'] } })
    await f.agent.followup(input('C')); await bounded('idle-2', f.agent.whenIdle())
    assert.deepEqual(f.agentErrors, [])
    assert.equal(f.requests.length, 1)
    assert.deepEqual(f.requests[0].texts.slice(-3), ['A', 'B', 'C'])
    assertDeliveredOnce(f, ['A', 'B', 'C'])
    assertWindowWorld(f, raw, ['A', 'B', 'C'])
    await assertColdMatchesLive(f)
  })
}

// ---------------------------------------------------------------------------
// 4/5. compaction and Instant preempt on a running turn
// ---------------------------------------------------------------------------
/** Runs the real engine inside the agent's own pre-step, exactly where automatic compaction runs. */
function compactInPreStep(f, when) {
  const state = { runs: [], done: undefined }
  f.ctx.on('agent/pre-step', async (event, next) => {
    if (when(event, state)) {
      const run = f.engine.compactRegion(f.seeds[0].seq, f.seeds[1].seq, f.agent, event.signal)
      state.runs.push(run); await run
    }
    return next()
  })
  return state
}
test('preempt (A) lands while a running turn is compacting in pre-step: summary commits, claimed prompt F and A both delivered exactly once', async t => {
  const f = await host(t), raw = eventsOf(f)
  f.plans.summary.push({ park: true })
  const state = compactInPreStep(f, (event, s) => event.turn === 2 && s.runs.length === 0)
  await f.agent.followup(input('F'))
  await until(() => f.summaryRequests.length === 1, 'summary-entered')
  assert.equal(f.requests.length, 0)
  await bounded('steer-A', f.agent.steer(input('A')))
  assert.equal(f.bridge.generation, 1)
  assert.equal(f.summaryRequests[0].signal.aborted, false, 'the turn-level compaction must survive a sampling preempt')
  f.summaryRequests[0].release.resolve()
  await bounded('compaction', state.runs[0])
  await bounded('idle', f.agent.whenIdle())
  assert.deepEqual(f.agentErrors, [])
  assertRawPreserved(f, raw)
  // F rides the queued-turn target, A the next-step target; the claim contract puts next-step input first, so only once-each is promised.
  assertDeliveredOnce(f, ['F', 'A'], { ordered: false })
  assert.equal(f.requests.some(r => r.texts.some(text => text.includes('old-one'))), false, 'a request used the pre-compaction window')
  // No request may be built from the pre-signal context while A is already durably signaled.
  assert.ok(f.requests[0].texts.includes('A'), 'first dispatched request ignored the signaled preempt input')
  const first = f.requests[0].texts
  assert.ok(first.some(text => text.includes('SUMMARY-OF-OLD-WINDOW')))
  await assertColdMatchesLive(f)
})
test('step preempt (A) then compaction in the successor pre-step while B arrives: no stale request, A,B drained once in one request, partial output discarded', async t => {
  const f = await host(t), raw = eventsOf(f)
  f.plans.conversation.push('park'); f.plans.summary.push({ park: true })
  const state = compactInPreStep(f, (event, s) => f.requests.length === 1 && s.runs.length === 0)
  await f.agent.followup(input('S')); await until(() => f.requests.length === 1, 'request-1'); await bounded('request-1-parked', f.requests[0].entered.promise)
  await bounded('steer-A', f.agent.steer(input('A')))
  await until(() => f.summaryRequests.length === 1, 'summary-entered')
  assert.equal(f.requests[0].aborted, true, 'preempt did not stop the old generation request')
  assert.equal(f.requests.length, 1, 'successor dispatched before its pre-step compaction finished')
  await bounded('steer-B', f.agent.steer(input('B')))
  assert.equal(f.bridge.generation, 2)
  f.summaryRequests[0].release.resolve()
  await bounded('compaction', state.runs[0])
  await bounded('idle', f.agent.whenIdle())
  assert.deepEqual(f.agentErrors, [])
  assertRawPreserved(f, raw)
  assertDeliveredOnce(f, ['S', 'A', 'B'])
  assert.equal(f.requests.length, 2, 'one aborted generation plus exactly one successor')
  const last = f.requests.at(-1).texts
  assert.deepEqual(last.filter(text => ['S', 'A', 'B'].includes(text)), ['S', 'A', 'B'])
  assert.ok(last.some(text => text.includes('SUMMARY-OF-OLD-WINDOW')) && !last.some(text => text.includes('old-one')))
  assert.equal(surfaceTexts(f.session).some(text => text.includes('obsolete-partial')), false, 'superseded partial text leaked into canonical history')
  assert.equal(f.session.deriveMessages().filter(m => m.role === 'assistant').length, 1)
  await assertColdMatchesLive(f)
})

// ---------------------------------------------------------------------------
// 6. all three at once: compactNow in flight + steer + a W2 transition attempt
// ---------------------------------------------------------------------------
test('window transition attempted during an in-flight compactNow plus steer is refused without side effects; compaction and input both survive', async t => {
  const f = await host(t), raw = eventsOf(f)
  f.plans.summary.push({ park: true })
  const outcome = f.engine.compactNow(f.agent, new AbortController().signal).then(value => ({ value }), error => ({ error }))
  await until(() => f.summaryRequests.length === 1, 'summary-entered')
  await bounded('steer-A', f.agent.steer(input('A')))
  const before = eventsOf(f).length
  await assert.rejects(f.transition('three-way'), /already has active work/)
  assert.equal(eventsOf(f).length, before, 'refused transition still wrote journal events')
  assert.equal(f.coordinator.status().paused, false); assert.equal(f.coordinator.status().running, false)
  assert.equal(eventsOf(f).some(e => e.type === 'native/window-intent'), false)
  f.summaryRequests[0].release.resolve()
  const { value, error } = await bounded('compaction', outcome)
  assert.equal(error, undefined, String(error?.message)); assert.equal(value.shadowedSeqs.length, 2)
  await bounded('idle', f.agent.whenIdle())
  assert.deepEqual(f.agentErrors, [])
  assertRawPreserved(f, raw)
  assertDeliveredOnce(f, ['A'])
  assert.equal(windowCommitOf(eventsOf(f)).length, 0)
  // The refused transition left the window machinery reusable: it can still run once the agent is idle.
  // (h1,h2 are already replaced by the compaction checkpoint, so the stale proposal must be rejected, not applied.)
  await assert.rejects(f.transition('three-way-retry'))
  assert.equal(windowCommitOf(eventsOf(f)).length, 0, 'a stale proposal over compacted history must never commit')
  await assertColdMatchesLive(f)
})
// The compaction result must not contradict the durable world when abort lands during its durability checkpoint.
test('abort during the post-commit durability checkpoint: compactNow outcome agrees with the committed world', async t => {
  const f = await host(t), raw = eventsOf(f)
  f.durability.holdFlush = deferred()
  const outcome = f.engine.compactNow(f.agent, new AbortController().signal).then(value => ({ value }), error => ({ error }))
  await until(() => eventsOf(f).some(e => e.type === 'compaction/end'), 'committed')
  f.agent.cancel({ kind: 'user' }, { keepInbox: true })
  f.durability.holdFlush.resolve()
  const result = await bounded('outcome', outcome)
  const events = eventsOf(f), committed = events.some(e => e.surfaceOp?.op === 'replace')
  assertRawPreserved(f, raw)
  assert.equal(committed, true, 'the commit preceded the abort')
  await assertColdMatchesLive(f)
  assert.ok((await coldRead(f)).some(e => e.surfaceOp?.op === 'replace'), 'replacement is fsynced in the cold artifact')
  assert.equal(result.error, undefined, 'caller was told ' + result.error?.code + ' although the replacement is committed and fsynced')
  assert.deepEqual(result.value.shadowedSeqs, [f.seeds[0].seq, f.seeds[1].seq])
  await assertColdMatchesLive(f)
})
