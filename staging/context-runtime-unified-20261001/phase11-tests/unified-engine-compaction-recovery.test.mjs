/**
 * Recovery for compactions this plugin did not start.
 *
 * The compaction engine now owns the step-boundary pressure fold (auto + thresholdRatio in
 * dsh-compaction-basic), and that path never passes through foldNow. These tests pin the
 * observer that gives an engine fold the same anchor check, ledger row and recovery notice
 * as a plugin-run fold, and pin that it keeps its hands off a fold the plugin ran itself.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply as applyStepCompaction, compactOnIdle } from '../home/profiles/web/plugins/step-compaction-v4.mjs'
import { createMilestoneDoc, pendingMilestoneCompaction } from '../home/profiles/web/plugins/team-milestone-v2.mjs'

const WINDOW = 1000000
const FOLD_SUMMARY = [{ type: 'text', text: 'a1 S W next action' }]
const foldResult = (id) => ({ compactionId: id, summary: FOLD_SUMMARY })

function eventBus(services = {}) {
  const handlers = new Map()
  return {
    handlers,
    get(name) { return services[name] },
    on(event, handler) {
      const rows = handlers.get(event) ?? []
      rows.push(handler)
      handlers.set(event, rows)
      return () => {
        const index = rows.indexOf(handler)
        if (index >= 0) rows.splice(index, 1)
      }
    },
  }
}

function tempDir(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

/** The inject-callback host shape apply() expects, plus the session/event dispatch it uses. */
function harness(t, { tokens = 500000, doc = createMilestoneDoc(), log } = {}) {
  const directory = tempDir(t, 'engine-recovery-')
  const milestonePath = join(directory, 'milestones.json')
  writeFileSync(milestonePath, JSON.stringify(doc))
  // Session-scoped, because the observer's dedupe is: every harness needs its own session.
  const session = { id: 'engine-recovery-' + Math.random().toString(36).slice(2), seq: 1, log }
  const injected = []
  const warns = []
  const agent = {
    session,
    membership: { name: 'a1' },
    inject(message) { injected.push(message) },
  }
  const impl = { compactNow: null, compactIfNeeded: null }
  const services = {
    // The observer resolves the live agent from the session id, as the composition does.
    agents: { get: id => (id === session.id ? agent : undefined) },
    agentTeams: { tryMembership: row => row.membership },
    tokenMeter: { measure: () => ({ totalTokens: tokens }) },
    compaction: {
      compactNow: (...args) => impl.compactNow(...args),
      compactIfNeeded: (...args) => impl.compactIfNeeded(...args),
    },
  }
  const scoped = eventBus(services)
  const ctx = {
    logger: { debug() {}, info() {}, warn: message => warns.push(String(message)) },
    on() { return () => {} },
    inject(_names, callback) { callback(scoped); return () => {} },
  }
  const stop = applyStepCompaction(ctx, { milestonePath, windowTokens: WINDOW })
  t.after(stop)

  const emit = event => {
    for (const handler of scoped.handlers.get('session/event') ?? []) handler(session, event)
  }
  return {
    agent,
    scoped,
    ctx,
    doc,
    emit,
    impl,
    injected,
    session,
    milestonePath,
    warns,
    injectedServices: { teams: services.agentTeams, meter: services.tokenMeter, engine: services.compaction },
    saved: () => JSON.parse(readFileSync(milestonePath, 'utf8')),
    /** The engine's own close event, exactly as session.append publishes it: payload in `data`. */
    end: (compactionId, extra = {}) => emit({ type: 'compaction/end', seq: 9, data: { compactionId, ...extra } }),
  }
}

const ARMED_MILESTONE = { kind: 'milestone', status: 'pending-idle', reason: 'milestone', milestoneSetAt: 1, requestedAt: 1 }

function armedDoc() {
  const doc = createMilestoneDoc()
  doc.members.a1 = { owner: 'a1', stage: 'S', doneWhen: 'W', setAt: 1, done: true }
  doc.compactions.a1 = { ...ARMED_MILESTONE }
  return doc
}

// The notice is sent from a microtask, after the publication of the close event has ended.
const settle = () => new Promise(resolve => setImmediate(resolve))
const preStep = h => { for (const handler of h.scoped.handlers.get('agent/pre-step') ?? []) handler({ agent: h.agent }, () => ({ kind: 'enter', messages: [] })) }

test('an engine compaction gets the anchor check, a namespaced settled ledger row and one recovery notice', async t => {
  const h = harness(t, {
    doc: armedDoc(),
    log: [{ type: 'compaction/summary', seq: 8, data: { compactionId: 'c1', summary: FOLD_SUMMARY } }],
  })
  const before = JSON.parse(JSON.stringify(h.doc.compactions.a1))
  h.end('c1', { turn: 3 })
  assert.equal(h.injected.length, 0, 'nothing is injected while the close event is still being published')
  await settle()

  assert.equal(h.injected.length, 1, 'the recovery notice is delivered exactly once')
  const text = h.injected[0].content.map(block => block.text).join('\n')
  assert.match(text, /\[team v12 compaction recovery\]/)
  assert.match(text, /engine-auto/)

  const row = h.saved().compactions['engine:a1']
  assert.equal(row.kind, 'engine')
  assert.equal(row.status, 'compacted', 'an engine row is never left as outstanding debt')
  assert.equal(row.trigger, 'engine-auto')
  assert.equal(row.compactionId, 'c1')
  assert.equal(row.summaryAvailable, true)
  assert.equal(row.ratio, 0.5)
  assert.equal(row.memoryDebt, null)
  assert.equal(row.noticeDelivered, true)
  assert.equal(row.milestoneSetAt, undefined, 'an engine fold is not a milestone fold')

  const saved = h.saved()
  assert.deepEqual(saved.compactions.a1, before, 'the member milestone record is untouched')
  const pending = pendingMilestoneCompaction(saved, 'a1')
  assert.equal(pending?.kind, 'milestone')
  assert.equal(pending?.status, 'pending-idle', 'the armed milestone job is still the one the idle path claims')
})

test('a fold this plugin ran itself is not post-processed a second time', async t => {
  const h = harness(t, { tokens: 760000, doc: armedDoc() })
  h.impl.compactNow = async () => {
    // The engine publishes its own close event while the plugin still holds the marker.
    h.end('fold-1')
    return foldResult('fold-1')
  }
  const outcome = await compactOnIdle(h.ctx, { milestonePath: h.milestonePath, windowTokens: WINDOW }, h.agent, new AbortController().signal, h.injectedServices)
  await settle()
  assert.match(outcome, /^folded:milestone/)
  assert.equal(h.injected.length, 1, 'only foldNow delivers a notice')
  assert.equal(h.saved().compactions['engine:a1'], undefined, 'no observer row for a plugin-run fold')
})

test('the same compaction id is post-processed once', async t => {
  const h = harness(t)
  h.end('c1'); h.end('c1')
  await settle()
  assert.equal(h.injected.length, 1)
  assert.equal(h.saved().compactions['engine:a1'].compactionId, 'c1')
})

test('an errored close is left to the engine', async t => {
  const h = harness(t)
  h.end('c1', { error: { code: 'model_param_invalid' } })
  await settle()
  assert.equal(h.injected.length, 0)
  assert.equal(h.saved().compactions['engine:a1'], undefined)
})

test('a session outside the Team is skipped without noise', async t => {
  const h = harness(t)
  h.agent.membership = undefined
  h.end('c1')
  await settle()
  assert.equal(h.injected.length, 0)
  assert.equal(h.warns.length, 0)
  assert.equal(h.saved().compactions['engine:a1'], undefined)
})

test('missing anchors are recorded on the row without making it a blocking debt, and the notice still goes out', async t => {
  const doc = createMilestoneDoc()
  doc.members.a1 = { owner: 'a1', stage: 'phase-X', doneWhen: 'W', setAt: 1, done: false }
  const h = harness(t, { doc })
  h.end('c1')
  await settle()
  const row = h.saved().compactions['engine:a1']
  assert.equal(row.status, 'compacted')
  assert.equal(row.summaryAvailable, false)
  assert.ok(row.missingAnchors.length > 0)
  assert.equal(row.memoryDebt, null, 'the window collector reads memoryDebt as outstanding debt')
  assert.ok(!JSON.stringify(row).includes('recoveryPack'), 'no second copy of the pack in the ledger')
  assert.equal(h.injected.length, 1)
})

test('a notice that cannot be injected while the close event is being published is delivered right after it', async t => {
  const h = harness(t)
  let publishing = true
  const delivered = []
  // What a session without the native bridge does: inject appends, and append refuses to reenter.
  h.agent.inject = message => { if (publishing) throw new Error('session append cannot reenter'); delivered.push(message) }
  h.end('c1')
  publishing = false
  await settle()
  assert.equal(delivered.length, 1)
  assert.equal(h.saved().compactions['engine:a1'].noticeDelivered, true)
})

test('an undelivered engine notice is owed and re-sent at the next step', async t => {
  const h = harness(t)
  const delivered = []
  h.agent.inject = () => { throw new Error('inbox closed') }
  assert.doesNotThrow(() => h.end('c1'))
  await settle()
  assert.equal(h.saved().compactions['engine:a1'].kind, 'engine', 'the durable record does not depend on the notice')
  assert.equal(h.saved().compactions['engine:a1'].noticeDelivered, false)
  h.agent.inject = message => delivered.push(message)
  preStep(h)
  assert.equal(delivered.length, 1)
  assert.equal(h.saved().compactions['engine:a1'].noticeDelivered, true)
  preStep(h)
  assert.equal(delivered.length, 1, 'and only once')
})

test('several engine folds inside one step send one notice; a new step sends a new one', async t => {
  const h = harness(t)
  h.emit({ type: 'step/start', seq: 10 })
  h.end('c1'); h.end('c2')
  await settle()
  assert.equal(h.injected.length, 1)
  assert.equal(h.saved().compactions['engine:a1'].compactionId, 'c2', 'the ledger still follows the latest fold')
  assert.equal(h.saved().compactions['engine:a1'].noticeDelivered, true)
  h.emit({ type: 'step/start', seq: 20 })
  h.end('c3')
  await settle()
  assert.equal(h.injected.length, 2)
})

test('an ownerless or command-issued close is recorded as manual, not as the automatic path', async t => {
  const h = harness(t)
  h.end('c1', { turn: null })
  await settle()
  assert.equal(h.saved().compactions['engine:a1'].trigger, 'engine-manual')
  const g = harness(t)
  g.end('c2', { turn: 4, sourceCommandId: 'compact-1' })
  await settle()
  assert.equal(g.saved().compactions['engine:a1'].trigger, 'engine-manual')
})

test('a throwing listener body never propagates to the event publisher', async t => {
  const h = harness(t)
  // The session is the listener's first read, so faulting it here faults the body itself.
  Object.defineProperty(h.agent.session, 'id', { get() { throw new Error('session unavailable') } })
  assert.doesNotThrow(() => h.end('c1'))
  assert.equal(h.warns.length, 1)
  assert.match(h.warns[0], /engine compaction recovery failed/)
})
