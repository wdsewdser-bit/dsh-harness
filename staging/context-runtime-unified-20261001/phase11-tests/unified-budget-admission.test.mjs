/**
 * A request that is known not to fit the model window is not sent.
 *
 * Pins the production failure of 2026-10-07: a member grew to 914k tokens inside one long turn; its conversation
 * requests (914k + the route's 128k output allowance) and its idle summary request (an unpruned replay of the whole
 * transcript + 64k) were both rejected by the provider, and the member could not continue.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply as applyStepCompaction, compactOnIdle, preStepBudget, summaryRequestBudget } from '../home/profiles/web/plugins/step-compaction-v4.mjs'
import { createMilestoneDoc } from '../home/profiles/web/plugins/team-milestone-v2.mjs'

const WINDOW = 1048576

function harness(t, { tokens, config = {}, doc = createMilestoneDoc() }) {
  const directory = mkdtempSync(join(tmpdir(), 'budget-admission-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const milestonePath = join(directory, 'milestones.json')
  writeFileSync(milestonePath, JSON.stringify(doc))
  const calls = { compactNow: 0 }
  const sent = []
  const inbox = { nextStep: [], nextTurn: [], splice(target, start, remove, items) { (target === 'next-step' ? this.nextStep : this.nextTurn).splice(Math.min(start, 1e9), remove, ...items) } }
  const agent = { session: { id: 'budget-' + Math.random().toString(36).slice(2) }, membership: { name: 'a1' }, inject() {}, status: 'idle', inbox,
    send(message, target, wakeup) { sent.push({ message, target, wakeup }) } }
  const services = {
    agents: { get: id => (id === agent.session.id ? agent : undefined) },
    agentTeams: { tryMembership: row => row.membership },
    tokenMeter: { measure: () => ({ totalTokens: tokens }) },
    compaction: { compactNow: async () => { calls.compactNow++; return { compactionId: 'c', summary: [{ type: 'text', text: 'a1 S W next action' }] } } },
  }
  const handlers = new Map()
  const scoped = { get: name => services[name], on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); return () => {} } }
  const ctx = { logger: { debug() {}, info() {}, warn() {} }, on() { return () => {} }, inject(_names, callback) { callback(scoped); return () => {} } }
  const cfg = { milestonePath, windowTokens: WINDOW, enablePreStep: true, ...config }
  let dispose = applyStepCompaction(ctx, cfg)
  t.after(() => dispose())
  // A hot reload: the old instance goes away and a new one is applied over the same host.
  const reload = () => { dispose(); handlers.clear(); dispose = applyStepCompaction(ctx, cfg) }
  const preStep = async (messages = [], signal) => {
    let decision = { kind: 'enter', messages }
    for (const handler of handlers.get('agent/pre-step') ?? []) decision = await handler({ agent, messages, signal }, async () => decision) ?? decision
    return decision
  }
  // The waterfall hands every handler the same payload object, as the agent dispatcher does.
  const requestError = async failure => {
    const payload = { agent, failure }
    let seen
    const chain = [...(handlers.get('agent/request-error') ?? []), p => { seen = p.failure; return undefined }]
    const run = index => chain[index](payload, () => run(index + 1))
    await run(0)
    return seen
  }
  const refusals = () => {
    const file = join(directory, 'context-budget-refusals.jsonl')
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  }
  return { agent, calls, cfg, ctx, doc, milestonePath, preStep, refusals, reload, sent, inbox, requestError, services,
    injected: { teams: services.agentTeams, meter: services.tokenMeter, engine: services.compaction } }
}

test('the conversation budget reserves the output the route really sends', () => {
  const cfg = { windowTokens: WINDOW }
  const meter = tokens => ({ meter: { measure: () => ({ totalTokens: tokens }) } })
  // 914k passed under the old 32768 reservation and was rejected by the provider.
  assert.equal(preStepBudget({}, cfg, {}, 914000, meter(914000)).ok, false)
  assert.equal(preStepBudget({}, cfg, {}, 880000, meter(880000)).ok, true)
  assert.equal(preStepBudget({}, cfg, {}, 890000, meter(890000)).ok, false, 'the margin covers one step of estimated growth')
  // An agent explicitly configured for a larger output is budgeted for that output.
  assert.equal(preStepBudget({}, cfg, { options: { maxTokens: 356000 } }, 700000, meter(700000)).ok, false)
  const refused = preStepBudget({}, cfg, {}, 914000, meter(914000))
  assert.deepEqual([refused.reserved, refused.margin, refused.window], [128000, 32768, WINDOW])
})

test('a step that cannot fit is refused with a reason, and the refusal is recorded', async t => {
  const h = harness(t, { tokens: 915000 })
  const decision = await h.preStep()
  assert.equal(decision.kind, 'reject')
  assert.match(decision.reason, /^context-budget: /)
  assert.match(decision.reason, /was not sent/)
  const rows = h.refusals()
  assert.equal(rows.length, 1)
  assert.deepEqual([rows[0].kind, rows[0].sessionId, rows[0].member, rows[0].tokens], ['conversation', h.agent.session.id, 'a1', 915000])
})

test('a step that fits is entered and nothing is recorded', async t => {
  const h = harness(t, { tokens: 600000 })
  assert.equal((await h.preStep()).kind, 'enter')
  assert.deepEqual(h.refusals(), [])
})

test('the idle summary budget counts the unpruned replay and the summary output', () => {
  const cfg = { windowTokens: WINDOW }
  // The production case: 874k measured, the summary request was ~16% larger and carried a 64k output allowance.
  assert.equal(summaryRequestBudget(cfg, 874000).ok, false)
  assert.equal(summaryRequestBudget(cfg, 786000).ok, true, 'a fold right at the hard cap still goes out')
  assert.equal(summaryRequestBudget(cfg, undefined).ok, true, 'no measurement never blocks a fold')
})

test('an idle fold whose summary request cannot fit is not sent; it is left for the step-boundary fold', async t => {
  const h = harness(t, { tokens: 874000 })
  const outcome = await compactOnIdle(h.ctx, h.cfg, h.agent, new AbortController().signal, h.injected)
  assert.equal(outcome, 'skipped:summary-over-budget')
  assert.equal(h.calls.compactNow, 0, 'the engine was not asked to summarise')
  const row = JSON.parse(readFileSync(h.milestonePath, 'utf8')).compactions.a1
  assert.deepEqual([row.status, row.lastError], ['retryable', 'summary-request-over-budget'])
  assert.equal(h.refusals()[0].kind, 'summary')
})

test('an idle pressure fold that fits still runs', async t => {
  const h = harness(t, { tokens: 800000 })
  const outcome = await compactOnIdle(h.ctx, h.cfg, h.agent, new AbortController().signal, h.injected)
  assert.match(outcome, /^folded:pressure/)
  assert.equal(h.calls.compactNow, 1)
})

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const message = id => ({ id, role: 'user', content: [{ type: 'text', text: id }] })

test('a refused step puts the input it had claimed straight back and wakes the member again after a delay', async t => {
  const h = harness(t, { tokens: 915000, config: { budgetRetryBackoffMs: [20, 20] } })
  assert.equal((await h.preStep([message('m1')])).kind, 'reject')
  assert.deepEqual(h.inbox.nextStep.map(row => row.id), ['m1'], 'back in the inbox at once: nothing is kept only in memory')
  assert.deepEqual([h.refusals()[0].retry, h.refusals()[0].attempt, h.refusals()[0].requeuedMessages], ['scheduled', 1, 1])
  assert.equal(h.sent.length, 0)
  await wait(60)
  assert.equal(h.sent.length, 1)
  assert.deepEqual([h.sent[0].target, h.sent[0].wakeup], ['next-turn', true])
  assert.match(h.sent[0].message.content[0].text, /^\[context budget\]/)
})

test('refusals caused by other wakes do not use the attempts up; only a wake this plugin sent counts', async t => {
  const h = harness(t, { tokens: 915000, config: { budgetRetryBackoffMs: [40] } })
  for (const id of ['m1', 'm2', 'm3', 'm4']) {
    h.inbox.nextStep.length = 0 // the turn claims what the last refusal put back
    assert.equal((await h.preStep([message(id)])).kind, 'reject')
  }
  assert.deepEqual(h.refusals().map(row => row.retry), ['scheduled', 'pending', 'pending', 'pending'])
  await wait(120)
  assert.equal(h.sent.length, 1, 'the one scheduled wake still fires')
})

test('after the last retry the member is left alone with its input intact, and its lead is told once', async t => {
  const h = harness(t, { tokens: 915000, config: { budgetRetryBackoffMs: [10] } })
  const rootSent = []
  h.agent.membership.root = { send(note, target, wakeup) { rootSent.push({ note, target, wakeup }) } }
  await h.preStep([message('m1')])
  await wait(40)
  assert.equal(h.sent.length, 1)
  h.inbox.nextStep.length = 0
  assert.equal((await h.preStep([message('m1')])).kind, 'reject')
  const last = h.refusals().at(-1)
  assert.deepEqual([last.retry, last.attempts], ['gave-up', 1])
  assert.deepEqual(h.inbox.nextStep.map(row => row.id), ['m1'], 'the input waits in the inbox for whoever wakes the member next')
  assert.equal(rootSent.length, 1)
  assert.deepEqual([rootSent[0].target, rootSent[0].wakeup], ['next-step', false], 'the lead is informed, not interrupted')
  assert.match(rootSent[0].note.content[0].text, /Member a1 cannot continue/)
  h.inbox.nextStep.length = 0
  await h.preStep([message('m1')])
  await wait(40)
  assert.equal(h.sent.length, 1, 'no further wake')
  assert.equal(rootSent.length, 1, 'and no second notice')
})

test('a step that fits again cancels the pending wake', async t => {
  let tokens = 915000
  const h = harness(t, { tokens, config: { budgetRetryBackoffMs: [30] } })
  h.services.tokenMeter.measure = () => ({ totalTokens: tokens })
  await h.preStep([message('m1')])
  tokens = 300000
  assert.equal((await h.preStep()).kind, 'enter')
  await wait(60)
  assert.equal(h.sent.length, 0)
})

test('a turn that is being cancelled is refused without restoring its input or scheduling a wake', async t => {
  const h = harness(t, { tokens: 915000, config: { budgetRetryBackoffMs: [10] } })
  const controller = new AbortController()
  controller.abort()
  assert.equal((await h.preStep([message('m1')], controller.signal)).kind, 'reject')
  assert.deepEqual(h.inbox.nextStep, [])
  await wait(40)
  assert.equal(h.sent.length, 0)
  assert.deepEqual(h.refusals(), [])
})

test('input withdrawn after the refusal (a cancel clears the inbox) cancels the wake', async t => {
  const h = harness(t, { tokens: 915000, config: { budgetRetryBackoffMs: [20] } })
  await h.preStep([message('m1')])
  h.inbox.nextStep.length = 0
  await wait(60)
  assert.equal(h.sent.length, 0)
  assert.equal(h.refusals().at(-1).kind, 'retry-dropped')
})

test('a pending wake survives a hot reload of the plugin', async t => {
  const h = harness(t, { tokens: 915000, config: { budgetRetryBackoffMs: [60] } })
  await h.preStep([message('m1')])
  h.reload()
  assert.deepEqual(h.inbox.nextStep.map(row => row.id), ['m1'])
  await wait(140)
  assert.equal(h.sent.length, 1, 'the new instance sent the wake the old one had scheduled')
})

test('a wake that fails asynchronously is recorded instead of becoming an unhandled rejection', async t => {
  const h = harness(t, { tokens: 915000, config: { budgetRetryBackoffMs: [10] } })
  h.agent.send = () => Promise.reject(Object.assign(new Error('durability unavailable'), { code: 'NATIVE_DURABILITY_UNAVAILABLE' }))
  await h.preStep()
  await wait(50)
  const last = h.refusals().at(-1)
  assert.deepEqual([last.kind, last.error], ['wake-failed', 'NATIVE_DURABILITY_UNAVAILABLE'])
})

test('a provider "parameters rejected" 400 close to the window is handed to the engine as a context overflow', async t => {
  const near = harness(t, { tokens: 900000 })
  const failure = { code: 'INVALID_REQUEST', message: 'OpenAI API error (400): upstream 400: {"code":11133,"msg":"Invalid request parameters","extError":{"code":"model_param_invalid","message":"the request parameters were rejected by the model provider"}}' }
  const seen = await near.requestError(failure)
  assert.equal(seen.code, 'CONTEXT_WINDOW_EXCEEDED')
  assert.equal(seen.reclassifiedFrom, 'INVALID_REQUEST')
  assert.equal(near.refusals().at(-1).kind, 'provider-overflow')

  const far = harness(t, { tokens: 300000 })
  assert.equal((await far.requestError(failure)).code, 'INVALID_REQUEST', 'the same wording far from the window is a real parameter error')
  const other = harness(t, { tokens: 900000 })
  assert.equal((await other.requestError({ code: 'RATE_LIMIT', message: '429 rate limit' })).code, 'RATE_LIMIT')
})

test('what the step is about to add counts against the window, not only what the session already holds', async t => {
  const h = harness(t, { tokens: 880000 })
  assert.equal((await h.preStep([message('small')])).kind, 'enter', 'the held context alone fits')
  const large = { id: 'pasted', role: 'user', content: [{ type: 'text', text: 'x'.repeat(90000) }] }
  const decision = await h.preStep([large])
  assert.equal(decision.kind, 'reject', '880k held plus about 30k entering does not')
  assert.ok(h.refusals().at(-1).tokens > 880000)
  assert.deepEqual(h.inbox.nextStep.map(row => row.id), ['pasted'], 'and the input is kept')
})

test('a request that certainly cannot fit is answered locally, whoever built it, the engine summary included', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'final-request-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const milestonePath = join(directory, 'milestones.json')
  writeFileSync(milestonePath, JSON.stringify(createMilestoneDoc()))
  let stream
  const ctx = { logger: { debug() {}, info() {}, warn() {} }, on(event, handler) { if (event === 'llm/stream' && !stream) stream = handler; return () => {} } }
  t.after(applyStepCompaction(ctx, { milestonePath, windowTokens: 100000, enablePreStep: true, reservedOutputTokens: 20000, summaryMaxOutputTokens: 10000 }))
  const request = (chars, extra = {}) => ({ provider: 'p', model: 'm', sessionId: 's', messages: [{ id: 'm', role: 'user', content: [{ type: 'text', text: 'x'.repeat(chars) }] }], ...extra })
  const sent = []
  const run = async options => { const out = []; for await (const chunk of await stream(options, () => { sent.push(options); return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })() })) out.push(chunk); return out }
  assert.equal((await run(request(200000)))[0].reason.kind, 'stop', '50k floor + 20k output fits in 100k')
  const refused = await run(request(360000))
  assert.deepEqual([refused[0].reason.kind, refused[0].reason.failure.code], ['error', 'CONTEXT_WINDOW_EXCEEDED'], '90k floor + 20k output cannot')
  assert.equal(sent.length, 1, 'it was not sent')
  assert.equal((await run(request(350000, { purpose: 'compaction' })))[0].reason.kind, 'stop', 'a summary request is judged with its own, smaller output')
  assert.equal((await run(request(370000, { purpose: 'compaction' })))[0].reason.kind, 'error')
  const rows = readFileSync(join(directory, 'context-budget-refusals.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.deepEqual(rows.map(row => [row.kind, row.purpose]), [['final-request', 'conversation'], ['final-request', 'compaction']])
})

test('a waiting retry is on disk and is taken up again after a restart', async t => {
  const h = harness(t, { tokens: 915000, config: { budgetRetryBackoffMs: [60000] } })
  await h.preStep([message('m1')])
  const file = join(h.milestonePath, '..', 'context-budget-pending.json')
  const saved = () => JSON.parse(readFileSync(file, 'utf8')).sessions[h.agent.session.id]
  assert.deepEqual([saved().state, saved().wakes], ['retrying', 0])
  // The process dies: nothing in memory survives, only the file.
  clearTimeout(globalThis[Symbol.for('dsh.step-compaction.budget-retries.v1')].get(h.agent.session.id).timer)
  globalThis[Symbol.for('dsh.step-compaction.budget-retries.v1')].clear()
  h.reload()
  const adopted = globalThis[Symbol.for('dsh.step-compaction.budget-retries.v1')].get(h.agent.session.id)
  assert.ok(adopted && adopted.timer !== undefined, 'the new process armed the wake again')
  // A step that fits clears the record.
  h.services.tokenMeter.measure = () => ({ totalTokens: 300000 })
  assert.equal((await h.preStep()).kind, 'enter')
  assert.equal(saved(), undefined)
})

test('a member out of retries is recorded as paused until one of its steps goes through', async t => {
  const h = harness(t, { tokens: 915000, config: { budgetRetryBackoffMs: [5] } })
  await h.preStep([message('m1')])
  await wait(30)
  h.inbox.nextStep.length = 0
  await h.preStep([message('m1')])
  const file = join(h.milestonePath, '..', 'context-budget-pending.json')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).sessions[h.agent.session.id].state, 'paused')
})

test('the operator can list waiting and paused sessions, and a paused lead is told in its own session', async t => {
  const commands = []
  const h = harness(t, { tokens: 915000, config: { budgetRetryBackoffMs: [5] } })
  h.services.commands = { register(command) { commands.push(command); return () => {} } }
  h.reload()
  const budget = () => commands.find(row => row.name === 'budget').handler({})
  assert.match((await budget()).text, /no session is waiting or paused/)
  await h.preStep([message('m1')])
  assert.match((await budget()).text, /waiting for retry 1/)
  await wait(30)
  h.inbox.nextStep.length = 0
  await h.preStep([message('m1')])
  assert.match((await budget()).text, /PAUSED after 1 retries/)
  const own = h.sent.filter(row => /This session is PAUSED/.test(row.message.content[0].text))
  assert.equal(own.length, 1, 'no lead above it: the notice waits in its own inbox')
  assert.deepEqual([own[0].target, own[0].wakeup], ['next-step', false])
})
