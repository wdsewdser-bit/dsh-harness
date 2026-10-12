/**
 * The idle fold offers itself to the durable window first, and folds by compaction whenever the window does not
 * take it. Also the size rule: a very large context is folded at the next idle boundary without a finished phase.
 * The window executor is a scripted double here; its real behaviour is covered by the native-tests window suites.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compactOnIdle } from '../home/profiles/web/plugins/step-compaction-v4.mjs'
import { createMilestoneDoc } from '../home/profiles/web/plugins/team-milestone-v2.mjs'

const FOLD = Symbol.for('dsh.window.fold.v1')

function scenario(t, { tokens, milestone = true, handle, config = {} }) {
  const directory = mkdtempSync(join(tmpdir(), 'window-fold-hook-'))
  t.after(() => { rmSync(directory, { recursive: true, force: true }); delete globalThis[FOLD] })
  const milestonePath = join(directory, 'milestones.json')
  const doc = createMilestoneDoc()
  if (milestone) {
    doc.members.a1 = { owner: 'a1', stage: 'S', doneWhen: 'W', setAt: 1, done: true }
    doc.compactions.a1 = { kind: 'milestone', status: 'pending-idle', reason: 'milestone', milestoneSetAt: 1, requestedAt: 1 }
  }
  writeFileSync(milestonePath, JSON.stringify(doc))
  const compactions = [], asked = [], resets = []
  const ctx = {
    logger: { warn() {}, info() {}, debug() {} },
    agentTeams: { tryMembership: row => row.membership },
    tokenMeter: { measure: () => ({ totalTokens: tokens }) },
    compaction: { compactNow: async () => { compactions.push(1); return { compactionId: 'c' + compactions.length, summary: [{ type: 'text', text: 'a1 S W next action' }] } } },
  }
  const agent = { session: { id: 'hook-' + Math.random().toString(36).slice(2), seq: 1 }, membership: { name: 'a1' }, inject() {} }
  if (handle) globalThis[FOLD] = { inScope: candidate => handle.inScope !== false && candidate === agent,
    async tryFold(candidate, facts) { asked.push({ candidate, facts }); return handle.answer(facts) }, resetDemand: () => { resets.push(1) } }
  const run = (extra = {}) => compactOnIdle(ctx, { milestonePath, controlDir: directory, windowTokens: 1000000, minMilestoneFoldTokens: 200000, ...config, ...extra },
    agent, new AbortController().signal)
  return { agent, asked, compactions, milestonePath, resets, run, saved: () => JSON.parse(readFileSync(milestonePath, 'utf8')) }
}

test('a due milestone fold goes to the window when it takes it: no summary call, milestone settled, no debt', async t => {
  const s = scenario(t, { tokens: 300000, handle: { answer: () => ({ outcome: 'folded', receipt: { toWindowId: 3 } }) } })
  assert.equal(await s.run(), 'folded:window:milestone')
  assert.equal(s.compactions.length, 0)
  assert.equal(s.asked.length, 1)
  const facts = s.asked[0].facts
  assert.deepEqual([facts.contextTokens, facts.windowTokens, facts.milestoneDone, facts.safeBoundary], [300000, 1000000, true, true])
  const saved = s.saved()
  assert.ok(saved.members.a1.compactedAt > 0, 'the phase is not folded a second time')
  const row = saved.compactions.a1
  assert.deepEqual([row.kind, row.status, row.memoryDebt, row.noticeDelivered, row.windowId, row.reason], ['window', 'compacted', null, true, 3, 'milestone'])
  assert.notEqual(await s.run(), 'folded:window:milestone', 'settled: the next idle does not fold again')
  assert.equal(s.asked.length, 1)
})

test('every refusal, error or out-of-scope session folds by compaction exactly as before', async t => {
  const refused = scenario(t, { tokens: 300000, handle: { answer: () => ({ outcome: 'fallback', reason: 'window-plan-unregistered' }) } })
  assert.match(await refused.run(), /^folded:milestone:/)
  assert.deepEqual([refused.asked.length, refused.compactions.length], [1, 1])
  delete globalThis[FOLD]

  const broken = scenario(t, { tokens: 300000, handle: { answer: () => { throw new Error('executor exploded') } } })
  assert.match(await broken.run(), /^folded:milestone:/)
  assert.equal(broken.compactions.length, 1)
  delete globalThis[FOLD]

  const outside = scenario(t, { tokens: 300000, handle: { inScope: false, answer: () => ({ outcome: 'folded', receipt: {} }) } })
  assert.match(await outside.run(), /^folded:milestone:/)
  assert.deepEqual([outside.asked.length, outside.compactions.length], [0, 1])
  delete globalThis[FOLD]

  const none = scenario(t, { tokens: 300000 })
  assert.match(await none.run(), /^folded:milestone:/)
})

test('a milestone below the floor is not offered to the window either', async t => {
  const s = scenario(t, { tokens: 120000, handle: { answer: () => ({ outcome: 'folded', receipt: {} }) } })
  assert.equal(await s.run(), 'milestone-deferred:below-floor')
  assert.equal(s.asked.length, 0)
})

test('a very large context is folded at the next idle boundary without a finished phase, when the rule is on', async t => {
  const off = scenario(t, { tokens: 520000, milestone: false })
  assert.doesNotMatch(await off.run(), /^folded/, 'off by default')
  assert.equal(off.compactions.length, 0)

  const on = scenario(t, { tokens: 520000, milestone: false, config: { proactiveFoldTokens: 500000 } })
  assert.match(await on.run(), /^folded:proactive/)
  assert.equal(on.compactions.length, 1)
  assert.match(await on.run(), /-cooldown$/, 'a fold that just happened is not repeated')
  assert.equal(on.compactions.length, 1)

  const below = scenario(t, { tokens: 480000, milestone: false, config: { proactiveFoldTokens: 500000 } })
  assert.doesNotMatch(await below.run(), /^folded/)

  const windowed = scenario(t, { tokens: 520000, milestone: false, config: { proactiveFoldTokens: 500000 },
    handle: { answer: () => ({ outcome: 'folded', receipt: { toWindowId: 1 } }) } })
  assert.equal(await windowed.run(), 'folded:window:proactive')
  assert.equal(windowed.asked[0].facts.milestoneDone, false)
  assert.equal(windowed.compactions.length, 0)
})

test('a proactive attempt that folded nothing is not retried on every idle', async t => {
  const s = scenario(t, { tokens: 520000, milestone: false, config: { proactiveFoldTokens: 500000 } })
  const doc = s.saved()
  doc.compactions.a1 = { kind: 'proactive', reason: 'proactive', status: 'no_compactable_range', updatedAt: Date.now() - 60000 }
  writeFileSync(s.milestonePath, JSON.stringify(doc))
  assert.equal(await s.run(), 'proactive-cooldown')
  assert.equal(s.compactions.length, 0)
})

test('a window fold that leaves the context over the pressure line is followed by the summary fold at once', async t => {
  const s = scenario(t, { tokens: 760000, milestone: false, handle: { answer: () => ({ outcome: 'folded', receipt: { toWindowId: 2 } }) } })
  assert.match(await s.run(), /^folded:pressure/, 'pressure is not left waiting behind a cooldown')
  assert.deepEqual([s.asked.length, s.compactions.length], [1, 1])
  assert.equal(s.resets.length, 1, 'a summary fold lets the window be asked again')
})

test('a fold the engine made on its own sets the cooldown too', async t => {
  const s = scenario(t, { tokens: 520000, milestone: false, config: { proactiveFoldTokens: 500000 } })
  const doc = s.saved()
  doc.compactions['engine:a1'] = { kind: 'engine', status: 'compacted', memoryDebt: null, updatedAt: Date.now() - 5 * 60000 }
  writeFileSync(s.milestonePath, JSON.stringify(doc))
  assert.equal(await s.run(), 'proactive-cooldown', 'the engine folded five minutes ago: size alone does not fold again yet')
  assert.equal(s.compactions.length, 0)
})
