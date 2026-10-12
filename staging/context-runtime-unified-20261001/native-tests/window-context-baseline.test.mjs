import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { Context } from '../app/node_modules/@deepseek-ai/cordis/lib/index.js'
import * as llmModule from '../app/node_modules/@deepseek-ai/dsh-llm/lib/index.js'
import { controlPlaneFor, readControlPlaneSnapshot, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { installRequestMessageProjection } from '../home/profiles/web/plugins/request-message-projection.mjs'
import { buildContextDelivery, committedContextCursor, committedContextEpoch, completeContextBaseline,
  durableContextVersions, installContextDispatchObserver } from '../home/profiles/web/plugins/team-v14-context-delivery.mjs'

const scope = { member: 'alice', sessionId: 's' }
const dispatch = { handedToAdapter: true, stage: 'handed-to-adapter', requestId: 'r' }
const sources = [
  { id: 'identity:alice', revision: 1, content: 'required identity', required: true, safetyCritical: true },
  { id: 'requirement:q', revision: 1, content: 'preserve user constraint '.repeat(50), required: true },
]
const pack = (extra = {}) => buildContextDelivery({ ...scope, sources, baselineId: 'window:new', maxTokens: 12000, ...extra })
const message = p => ({ source: { kind: 'team-message', plugin: 'team-v12-runtime' }, content: [{ type: 'text', text: p.body }] })
function observer(expected, onDispatch) {
  let hooks, project
  const dispose = installContextDispatchObserver({ isAgentLoopRequest: () => true,
    register(_id, fn, options) { project = fn; hooks = options; return () => {} },
  }, { ...scope, expectation: () => expected.value, onDispatch })
  const prepare = p => {
    const options = { sessionId: scope.sessionId, messages: [message(p)] }
    return { options, result: project(options), receipt: dispatch }
  }
  return { hooks, prepare, dispose }
}
const expectation = p => ({ value: { epochId: p.manifest.baselineId, bindingHash: p.manifest.bindingHash,
  required: p.manifest.required, known: [] } })

test('cold restore uses committed native window and summary events, never intent; subsequent reads are incremental', () => {
  const log = [{ type: 'compaction/end', data: { compactionId: 'summary' }, time: 2 },
    { type: 'native/window-intent', data: { transitionId: 'not-committed' } }]
  const reads = []
  const session = { seq: 2, snapshotEvents(from) { reads.push(from); return log.slice(from) } }
  assert.equal(committedContextEpoch(session).compactionId, 'summary')
  log.push({ type: 'user/message', time: 3, data: { source: { windowCommit: { transitionId: 'new' } } } })
  session.seq++
  assert.equal(committedContextEpoch(session).compactionId, 'window:new')
  assert.equal(committedContextEpoch(session).compactionId, 'window:new')
  assert.deepEqual(reads, [0, 2])
  assert.equal(committedContextEpoch({ snapshotEvents: () => structuredClone(log) }).compactionId, 'window:new')
  assert.throws(() => committedContextEpoch({}), /epoch-log-unavailable/)
})

test('partial baseline preserves explicit required-source debt and cannot inherit older coverage or advance', () => {
  const full = pack()
  const old = { ...scope, contentReceiptVersion: 3, versions: { stale: 'old' }, epochId: 'window:old', baselineId: 'window:old' }
  const partial = pack({ force: true, maxTokens: 256, acknowledged: [old], visible: [message(full)] })
  assert.equal(partial.failClosed, true)
  assert.equal(partial.debt, true)
  assert.equal(completeContextBaseline(partial.manifest), false)
  const cursor = committedContextCursor(old, [{ ...scope, baselineId: 'window:old', dispatch, items: full.manifest.items }], partial.manifest, { ...scope, dispatch })
  assert.equal(cursor.baselineId, null)
  assert.equal(cursor.versions.stale, undefined)
  assert.equal(durableContextVersions([old], { ...scope, epochId: 'window:new' }).size, 0)
  assert.equal(pack({ acknowledged: [cursor] }).manifest.items.length > 0, true)
})

test('only complete matching baseline with an actual dispatch advances a recoverable cursor', () => {
  const full = pack()
  assert.equal(completeContextBaseline(full.manifest), true)
  for (const receipt of [undefined, { handedToAdapter: true }, { ...dispatch, stage: 'history' }]) {
    assert.equal(committedContextCursor(null, [], full.manifest, { ...scope, dispatch: receipt }).baselineId, null)
  }
  const cursor = committedContextCursor(null, [], full.manifest, { ...scope, dispatch })
  assert.equal(cursor.baselineId, 'window:new')
  assert.equal(completeContextBaseline(JSON.parse(JSON.stringify(cursor)).baselineProof), true)
  assert.equal(pack({ acknowledged: [cursor] }).body, '')
  assert.equal(pack({ acknowledged: [cursor], sources: [sources[0], { ...sources[1], revision: 2 }] }).manifest.items.length, 1)
})

test('final request rejects missing, truncated, wrong-version, stale-state and partially delivered required sources', () => {
  const full = pack(), expected = expectation(full)
  const f = observer(expected, async () => {})
  const prepared = f.prepare(full)
  assert.doesNotThrow(() => f.hooks.validateAdapter(prepared))
  for (const candidate of [[], [message(pack({ sources: [sources[0]] }))],
    [message(pack({ sources: [sources[0], { ...sources[1], revision: 2 }] }))],
    [{ ...message(full), content: [{ type: 'text', text: full.body.split('\n')[0] }] }]]) {
    assert.throws(() => f.hooks.validateAdapter({ ...prepared, options: { ...prepared.options, messages: candidate } }), { code: 'TEAM_CONTEXT_BASELINE_DEBT' })
  }
  expected.value.unavailable = true
  assert.throws(() => f.hooks.validateAdapter(prepared), { code: 'TEAM_CONTEXT_BASELINE_DEBT' })
})

test('receipt write failure stays debt, retries only its failed receipt and stops after three attempts', async () => {
  const full = pack(), expected = expectation(full)
  let attempts = 0
  const f = observer(expected, async () => { attempts++; throw new Error('disk failed') })
  const prepared = f.prepare(full)
  await assert.rejects(f.hooks.onDispatch(prepared), /disk failed/)
  assert.throws(() => f.hooks.validateAdapter(prepared), { code: 'TEAM_CONTEXT_BASELINE_DEBT' })
  await assert.rejects(f.dispose.flushPending(), /disk failed/)
  await assert.rejects(f.dispose.flushPending(), /disk failed/)
  await assert.rejects(f.dispose.flushPending(), /disk failed/)
  await f.hooks.onDispatch(prepared)
  assert.equal(attempts, 3)
})

test('successful durable retry clears debt without replaying obsolete baseline manifests', async () => {
  const full = pack(), expected = expectation(full)
  let attempts = 0, durable = null
  const f = observer(expected, async (_message, receipt) => {
    if (++attempts === 1) throw new Error('transient write')
    durable = JSON.parse(JSON.stringify(committedContextCursor(null, [], full.manifest, { ...scope, dispatch: receipt })))
  })
  const prepared = f.prepare(full)
  await assert.rejects(f.hooks.onDispatch(prepared), /transient write/)
  await f.dispose.flushPending()
  assert.equal(durable.baselineId, 'window:new')
  assert.doesNotThrow(() => f.hooks.validateAdapter(prepared))
  await f.hooks.onDispatch(prepared)
  const old = f.prepare(pack({ baselineId: 'window:old' }))
  await f.hooks.onDispatch(old)
  assert.equal(attempts, 2)
})

test('real native cold session keeps the committed epoch after the event listener was absent', () => {
  const header = { id: 'cold-window', version: 4, cwd: tmpdir(), createdAt: 1, isSeeded: false }
  const session = Session.create(header.id, undefined, header)
  session.append('user/message', { id: 'checkpoint', role: 'user', content: [{ type: 'text', text: 'checkpoint' }],
    source: { kind: 'team-message', windowCommit: { transitionId: 'durable-fold' } } }, { surfaceOp: 'append' })
  const cold = Session.create(header.id, session.snapshotEvents(), header)
  assert.equal(committedContextEpoch(cold).compactionId, 'window:durable-fold')
})

test('actual adapter dispatch and control-plane disk readback are both needed to clear baseline debt', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'window-context-durable-'))
  const ctx = new Context(), llm = new llmModule.LlmRuntime(ctx)
  let requests = 0
  llm.registerAdapter(['fixture'], new class extends llmModule.LlmAdapter {
    providerInfo(id) { return { id, name: id } }
    async prepareCall(provider, id) {
      return { model: { provider, id, name: id }, stream() {
        requests++
        return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })()
      } }
    }
  }())
  const cp = controlPlaneFor('window-baseline-' + directory, { directory })
  const full = pack(), expected = expectation(full)
  const bridge = installRequestMessageProjection(llm, llmModule)
  const dispose = installContextDispatchObserver(bridge, { ...scope, expectation: () => expected.value,
    onDispatch: (_message, receipt) => cp.mutateHot('test/baseline-dispatch', {}, null, state => {
      state.baseline = committedContextCursor(null, [], full.manifest, { ...scope, dispatch: receipt })
    }, { deferMs: 0 }),
  })
  t.after(async () => { dispose(); bridge.dispose(); await ctx.fiber.dispose(); resetControlPlaneCache(); rmSync(directory, { recursive: true, force: true }) })
  const request = llmModule.markAgentLoopRequest({ provider: 'fixture', model: 'fixture', purpose: 'conversation',
    sessionId: scope.sessionId, messages: [llmModule.createUserMessage(message(full))], signal: new AbortController().signal })
  bridge.preview(request)
  assert.equal(requests, 0)
  assert.equal(cp.view({ history: false }).baseline, undefined)
  for await (const _ of llm.stream(request)) {}
  await dispose.flushPending()
  assert.equal(requests, 1)
  const cold = readControlPlaneSnapshot(cp.file)
  assert.equal(cold.baseline.baselineId, 'window:new')
  assert.equal(completeContextBaseline(cold.baseline.baselineProof), true)
  bridge.register('final-removal', () => ({ messages: [] }), { order: 2000 })
  const nextRequest = llmModule.markAgentLoopRequest({ ...request, signal: new AbortController().signal })
  const chunks = []
  for await (const chunk of llm.stream(nextRequest)) chunks.push(chunk)
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(bridge.audit().at(-1).handedToAdapter, false)
  assert.equal(requests, 1)
})
