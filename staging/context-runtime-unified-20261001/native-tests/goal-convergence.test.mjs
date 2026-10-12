import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { goalFixture } from './native-goal-fixture.mjs'
import { initializeNativeHost } from './native-host-fixture.mjs'
import { ToolRuntime } from '../app/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
import { createAssistantMessage, createToolResultMessage } from '../app/node_modules/@deepseek-ai/dsh-llm/lib/index.js'
import { apply as applyGoalTools } from '../app/node_modules/@deepseek-ai/dsh-tool-goal-v15/lib/index.js'
import { ReactLoopAgent } from '../app/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'
import { foldGoal, foldGoalConvergence } from '../app/node_modules/@deepseek-ai/dsh-goal/lib/index.js'

const blocker = { id: 'missing-access', cause: 'external-service-denies-workspace', message: 'External access is unavailable' }
async function fixture(t) {
  const f = await goalFixture(mkdtempSync(join(tmpdir(), 'goal-convergence-')))
  t.after(async () => { await f.current.handle.close() })
  return f
}
const ref = c => { const g = c.goals.get(c.agent); return { id: g.id, revision: g.revision } }
function round(c, { human = false } = {}) {
  const g = c.goals.get(c.agent)
  const boundary = c.ctx.sessionProjections.stateOf(c.session, 'turnBoundary')
  if (boundary.openTurnStartSeq !== null) {
    c.session.append('step/end', { turn: boundary.lastTurn, step: 1 })
    c.session.append('turn/end', { turn: boundary.lastTurn })
  }
  const turn = boundary.lastTurn + 1
  c.session.append('turn/start', { turn })
  c.session.append('user/message', { id: `round-${g.revision}-${g.roundsStarted + 1}`, role: 'user',
    content: [{ type: 'text', text: human ? 'Ordinary work request' : 'Continue current goal' }],
    source: human ? { kind: 'user' } : { kind: 'goal', goalId: g.id, revision: g.revision, round: g.roundsStarted + 1 } }, { surfaceOp: 'append' })
  c.session.append('step/start', { turn, step: 1 })
  c.agent.phase = { kind: 'running', abort: new AbortController(), turn, step: 1 }
}
function successEvidence(c, callId, meta) {
  const turn = c.agent.phase.turn, step = 1, args = '{}'
  c.session.append('assistant/message', { turn, step, stream: [], message: createAssistantMessage({
    source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    content: [{ type: 'tool-call', id: callId, name: 'fixture-work', arguments: args }] }) }, { surfaceOp: 'append' })
  const call = c.session.append('tool/call', { turn, step, callId, name: 'fixture-work', arguments: args })
  return c.session.append('tool/result', { turn, step, message: createToolResultMessage({ callId,
    content: [{ type: 'text', text: 'Verified work' }], isError: false }), ...meta ? { meta } : {} },
    { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
}
const report = (c, b = blocker) => c.goals.reportRound(c.agent, ref(c), { outcome: 'blocked', blocker: b })
const block = (c, b = blocker) => c.goals.block(c.agent, ref(c), { code: b.id, cause: b.cause, message: b.message })
async function tools(c) {
  return initializeNativeHost(c.ctx, async () => {
  const runtime = new ToolRuntime(c.ctx)
  c.ctx.agents.currentInitiator = () => c.agent
  applyGoalTools(c.ctx, {})
  let calls = 0
  return (name, args) => runtime.execute({ name, arguments: args, callId: `goal-test-${++calls}`, agent: c.agent, signal: new AbortController().signal })
  })
}

test('total admitted rounds do not authorize blocker without real observations at service or actual ToolRuntime', async t => {
  const f = await fixture(t), c = f.current
  for (let n = 0; n < 5; n++) round(c)
  await assert.rejects(async () => block(c), { code: 'GOAL_BLOCK_THRESHOLD' })
  const run = await tools(c), g = ref(c)
  const result = await run('update_goal', { action: 'blocked', goal_id: g.id, revision: g.revision,
    blocked_reason: blocker.message, blocker_id: blocker.id, blocker_cause: blocker.cause })
  assert.equal(result.isError, true)
  assert.equal(c.goals.get(c.agent).phase, 'active')
})

test('exact same blocker counts once per actual goal round and gates stable cause', async t => {
  const f = await fixture(t), c = f.current
  for (let n = 1; n <= 3; n++) {
    round(c)
    await report(c, { ...blocker, message: `Different wrapper ${n}` })
    await report(c)
    assert.equal(c.goals.convergence(c.agent).consecutiveBlocked, n)
    if (n < 3) await assert.rejects(async () => block(c), { code: 'GOAL_BLOCK_THRESHOLD' })
  }
  await assert.rejects(async () => block(c, { ...blocker, cause: 'different-root-cause' }), { code: 'GOAL_BLOCK_THRESHOLD' })
  assert.equal((await block(c)).phase, 'blocked')
  const restored = await f.reload()
  assert.equal(restored.goals.get(restored.agent).phase, 'blocked')
  assert.equal(restored.goals.convergence(restored.agent).consecutiveBlocked, 3)
  assert.equal(restored.session.log.filter(e => e.data?.operation === 'report-round').length, 3)
})

test('missing observation, changed blocker and direct human turn each break consecutive chain', async t => {
  const f = await fixture(t), c = f.current
  round(c); await report(c)
  round(c)
  round(c); await report(c)
  assert.equal(c.goals.convergence(c.agent).consecutiveBlocked, 1)
  round(c); await report(c, { ...blocker, id: 'missing-resource' })
  assert.equal(c.goals.convergence(c.agent).consecutiveBlocked, 1)
  round(c, { human: true })
  await assert.rejects(report(c), { code: 'GOAL_ROUND_REQUIRED' })
  assert.equal(c.goals.convergence(c.agent).consecutiveBlocked, 0)
})

test('verified canonical progress resets and cannot be fabricated with a free pass or round number', async t => {
  const f = await fixture(t), c = f.current
  round(c); await report(c)
  round(c)
  await assert.rejects(c.goals.reportRound(c.agent, ref(c), { outcome: 'progress', evidenceSeq: 999 }), { code: 'GOAL_PROGRESS_UNVERIFIED' })
  await assert.rejects(c.goals.reportRound(c.agent, ref(c), { outcome: 'blocked', blocker, round: 99, advance: true }), { code: 'GOAL_INVALID_ROUND_REPORT' })
  const evidence = successEvidence(c, 'verified-work')
  await c.goals.reportRound(c.agent, ref(c), { outcome: 'progress', evidenceSeq: evidence.seq })
  assert.equal(c.goals.convergence(c.agent).consecutiveBlocked, 0)
  round(c); await report(c)
  assert.equal(c.goals.convergence(c.agent).consecutiveBlocked, 1)
})

test('same-round progress invalidates blocker but repeating another blocker cannot restore it', async t => {
  const f = await fixture(t), c = f.current
  round(c); await report(c)
  const evidence = successEvidence(c, 'progress')
  await c.goals.reportRound(c.agent, ref(c), { outcome: 'progress', evidenceSeq: evidence.seq })
  await assert.rejects(report(c), { code: 'GOAL_ROUND_ALREADY_REPORTED' })
  assert.equal(c.goals.convergence(c.agent).consecutiveBlocked, 0)
})

test('JSONL replay preserves audits but startup/fork disarm and explicit resume start a new chain', async t => {
  const f = await fixture(t), c = f.current
  for (let n = 0; n < 3; n++) { round(c); await report(c) }
  const restored = await f.reload()
  assert.equal(restored.goals.convergence(restored.agent).consecutiveBlocked, 3)
  await assert.rejects(async () => block(restored), { code: 'GOAL_ROUND_DISARMED' })
  restored.goals.resume(restored.agent, ref(restored))
  assert.equal(restored.goals.convergence(restored.agent).consecutiveBlocked, 0)
  round(restored); await report(restored)
  assert.equal(restored.goals.convergence(restored.agent).consecutiveBlocked, 1)
  await assert.rejects(async () => block(restored), { code: 'GOAL_BLOCK_THRESHOLD' })
})

test('failed observation durability neither authorizes block nor survives a fresh JSONL replay', async t => {
  const f = await fixture(t), c = f.current
  round(c); f.failFlush(true)
  await assert.rejects(report(c), { code: 'NATIVE_DURABILITY_UNAVAILABLE' })
  await assert.rejects(async () => block(c), { code: 'GOAL_CONVERGENCE_DURABILITY_FAILED' })
  f.failFlush(false)
  const restored = await f.reload()
  assert.equal(restored.goals.convergence(restored.agent).consecutiveBlocked, 0)
})

test('actual goal_progress tool derives round from canonical source, persists reports, and blocked awaits durability', async t => {
  const f = await fixture(t), c = f.current, run = await tools(c)
  for (let n = 1; n <= 3; n++) {
    round(c)
    const g = ref(c)
    const value = await run('goal_progress', { goal_id: g.id, revision: g.revision, outcome: 'blocked',
      blocker_id: blocker.id, blocker_cause: blocker.cause, blocker_message: blocker.message })
    assert.equal(value.isError, false, JSON.stringify(value.error))
    assert.equal(c.goals.convergence(c.agent).consecutiveBlocked, n)
  }
  const g = ref(c)
  const result = await run('update_goal', { goal_id: g.id, revision: g.revision, action: 'blocked',
    blocker_id: blocker.id, blocker_cause: blocker.cause, blocked_reason: blocker.message })
  assert.equal(result.isError, false, JSON.stringify(result.error))
  assert.equal((await f.reload()).goals.get(f.current.agent).phase, 'blocked')
})

test('ordinary human request no longer becomes long-running intent by prompt inference', async t => {
  const f = await fixture(t), c = f.current, sections = []
  applyGoalTools({ goals: c.goals, systemPrompt: { section: s => sections.push(s.text), getSectionOrder: () => 0 },
    tools: { register: tool => { if (tool.name === 'create_goal') sections.push(tool.description) } } }, {})
  assert.equal(sections.some(text => /may infer goal intent|even if the user did not say/.test(text)), false)
  assert.ok(sections.every(text => /explicit|明确/.test(text)))
})

test('actual SessionStore fork carries audit but not autonomous block authority; rearm resets child only', async t => {
  const f = await fixture(t), c = f.current
  for (let n = 0; n < 3; n++) { round(c); await report(c) }
  const { child, agent } = await initializeNativeHost(c.ctx, async () => {
    const child = c.ctx.sessions.fork(c.session, undefined, 'goal-convergence-child')
    const agent = new ReactLoopAgent(c.ctx, child.id, { provider: 'fixture', model: 'fixture' }, child)
    c.ctx.agents.enter(agent, { dispose: async () => {} }); agent.wakeDriver = () => {}
    return { child, agent }
  })
  assert.equal(child.header.parentSession, c.session.id)
  assert.equal(c.goals.get(agent).activation, 'disarmed')
  assert.equal(c.goals.convergence(agent).consecutiveBlocked, 3)
  await assert.rejects(c.goals.block(agent, ref({ goals: c.goals, agent }), { code: blocker.id, cause: blocker.cause, message: blocker.message }), { code: 'GOAL_ROUND_DISARMED' })
  c.goals.resume(agent, ref({ goals: c.goals, agent }))
  assert.equal(c.goals.convergence(agent).consecutiveBlocked, 0)
  assert.equal(c.goals.convergence(c.agent).consecutiveBlocked, 3)
})

test('same id with a different cause resets and a new goal cannot inherit the old chain', async t => {
  const f = await fixture(t), c = f.current
  round(c); await report(c)
  round(c); await report(c, { ...blocker, cause: 'different-resource-unavailable' })
  assert.equal(c.goals.convergence(c.agent).consecutiveBlocked, 1)
  c.goals.clear(c.agent, ref(c))
  c.goals.create(c.agent, { objective: 'New explicitly authorized goal' })
  assert.equal(c.goals.convergence(c.agent).consecutiveBlocked, 0)
})

test('verified-wait accepts only producer-attested canonical successful tool evidence and resets', async t => {
  const f = await fixture(t), c = f.current
  round(c); await report(c)
  round(c)
  const plain = successEvidence(c, 'plain-result')
  await assert.rejects(c.goals.reportRound(c.agent, ref(c), { outcome: 'verified-wait', evidenceSeq: plain.seq }), { code: 'GOAL_PROGRESS_UNVERIFIED' })
  const wait = successEvidence(c, 'wait-result', { goalWait: { status: 'waiting', verificationRef: 'external-job:verified-state:1' } })
  await c.goals.reportRound(c.agent, ref(c), { outcome: 'verified-wait', evidenceSeq: wait.seq })
  assert.equal(c.goals.convergence(c.agent).consecutiveBlocked, 0)
  assert.equal(c.goals.convergence(c.agent).lastReport.outcome, 'verified-wait')
  const restored = await f.reload()
  assert.equal(restored.goals.convergence(restored.agent).lastReport.outcome, 'verified-wait')
})

test('pure fold and real replay reject forged goal/round identity while checkpoint carries bounded audit', async t => {
  const f = await fixture(t), c = f.current
  round(c); await report(c)
  const cp = c.ctx.sessionProjections.checkpoint(c.session)
  assert.equal(cp.goalConvergence.val.consecutiveBlocked, 1)
  const rows = c.session.snapshotEvents(), original = rows.find(row => row.data.operation === 'report-round')
  for (const mutate of [data => { data.source.round += 1 }, data => { data.source.seq = 0 }, data => { data.goalRef.id = 'foreign-goal' }]) {
    const forged = structuredClone(rows); mutate(forged[original.seq].data)
    assert.throws(() => foldGoal(forged), /goal convergence replay failed/)
    assert.throws(() => foldGoalConvergence(forged), /goal convergence replay failed/)
  }
  c.session.append('goal/change', { ...original.data, source: { ...original.data.source, messageId: 'forged' } })
  await c.flush()
  const restored = await f.reload()
  assert.throws(() => restored.goals.get(restored.agent), { code: 'GOAL_CONVERGENCE_REPLAY_FAILED' })
})

test('block rejects a changed actual round during durable authorization rather than committing stale count', async t => {
  const f = await fixture(t), c = f.current
  for (let n = 0; n < 3; n++) { round(c); await report(c) }
  const flush = c.bridge.options.flush
  let advance = true
  c.bridge.options.flush = async () => { if (advance) { advance = false; round(c) } return flush() }
  await assert.rejects(block(c), { code: 'GOAL_CONVERGENCE_CAS_CONFLICT' })
  assert.equal(c.goals.get(c.agent).phase, 'active')
  assert.equal(c.goals.convergence(c.agent).consecutiveBlocked, 3)
  await assert.rejects(block(c), { code: 'GOAL_BLOCK_THRESHOLD' })
})

test('failure after block mutation returns no success and fresh JSONL restores the durable active phase', async t => {
  const f = await fixture(t), c = f.current
  for (let n = 0; n < 3; n++) { round(c); await report(c) }
  const flush = c.bridge.options.flush
  let calls = 0
  c.bridge.options.flush = () => ++calls === 1 ? flush() : false
  await assert.rejects(block(c), { code: 'NATIVE_DURABILITY_UNAVAILABLE' })
  const restored = await f.reload()
  assert.equal(restored.goals.get(restored.agent).phase, 'active')
})
