import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeUsage, makeFixture, validateAnswer, planTrials, disabledContinuationTrials, estimateInput, assertBudget, run, buildReport, renderReport } from '../tools/usage-lab.mjs'

const fixture = makeFixture()
const validAnswer = { error_code: 'E_FIXTURE_173', error_line: 173, expected_checksum: '7e2a', actual_checksum: '91bf', final_status: 'blocked', quotes: fixture.critical }

test('fixture exact line recall passes and an incomplete compact answer fails', () => {
  assert.equal(validateAnswer(JSON.stringify(validAnswer), fixture).passed, true)
  const missing = validateAnswer(JSON.stringify({ ...validAnswer, quotes: fixture.critical.slice(1) }), fixture)
  assert.equal(missing.passed, false)
  assert.equal(missing.quoteRecall, 2 / 3)
})

test('paraphrase, wrong line and false success are rejected', () => {
  assert.equal(validateAnswer(JSON.stringify({ ...validAnswer, quotes: [{ line: 173, text: 'checksum failed' }] }), fixture).passed, false)
  assert.equal(validateAnswer(JSON.stringify({ ...validAnswer, error_line: 172 }), fixture).passed, false)
  assert.equal(validateAnswer(JSON.stringify({ ...validAnswer, final_status: 'success' }), fixture).passed, false)
})

test('named quote objects retain the same exact evidence gates as arrays', () => {
  const quotes = Object.fromEntries(['CONFIG', 'UNIQUE_FAILURE', 'FINAL'].map((name, i) => [name, fixture.critical[i]]))
  assert.equal(validateAnswer(JSON.stringify({ ...validAnswer, quotes }), fixture).passed, true)
  assert.equal(validateAnswer(JSON.stringify({ ...validAnswer, quotes: { ...quotes, FINAL: { ...quotes.FINAL, text: 'WARN: FINAL success' } } }), fixture).passed, false)
  assert.equal(validateAnswer(JSON.stringify({ ...validAnswer, quotes: { CONFIG: quotes.CONFIG, UNIQUE_FAILURE: quotes.UNIQUE_FAILURE } }), fixture).passed, false)
  assert.equal(validateAnswer(JSON.stringify({ ...validAnswer, quotes: { ...quotes, EXTRA: null } }), fixture).passed, false)
})

test('raw provider totals stay disjoint and absent fields are null', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 70, prompt_cache_miss_tokens: 30, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 5 }, total_tokens: 120 }), { prompt_tokens: 100, prompt_cache_hit_tokens: 70, prompt_cache_miss_tokens: 30, completion_tokens: 20, reasoning_tokens: 5, total_tokens: 120 })
  assert.ok(Object.values(normalizeUsage(null)).every(v => v === null))
  assert.equal(normalizeUsage({ prompt_tokens_details: { cached_tokens: 42 } }).prompt_cache_hit_tokens, 42)
})

test('counterbalanced trial plan has 20 calls including both reducer passes', () => {
  const trials = planTrials()
  assert.equal(trials.reduce((n, t) => n + t.calls, 0), 20)
  assert.equal(trials.filter(t => t.arm === 'reducer').length, 2)
  for (const batch of ['schema', 'team', 'history']) assert.equal(trials.filter(t => t.batch === batch).length, 4)
  assert.deepEqual(trials.filter(t => t.batch === 'log').map(t => t.arm), ['full', 'pack', 'reducer', 'reducer', 'pack', 'full'])
})

test('budget guard blocks attempts before another call can be made', () => {
  assert.throws(() => assertBudget({ calls: 24, inputTokens: 0 }, 1, { calls: 24, inputTokens: 200000 }), /call-budget/)
  assert.throws(() => assertBudget({ calls: 1, inputTokens: 199999 }, 1000, { calls: 24, inputTokens: 200000 }), /input-budget/)
  assert.doesNotThrow(() => assertBudget({ calls: 0, inputTokens: 0 }, 1000, { calls: 24, inputTokens: 200000 }))
  assert.equal(estimateInput({ messages: [{ role: 'user', content: 'x' }] }), Math.ceil(Buffer.byteLength(JSON.stringify({ messages: [{ role: 'user', content: 'x' }] })) / 4))
})

test('disabled continuation uses matched new Team baseline and 22 total calls', () => {
  const trials = disabledContinuationTrials()
  assert.equal(6 + trials.reduce((n, trial) => n + trial.calls, 0), 22)
  assert.deepEqual(trials.filter(trial => trial.batch === 'team').map(trial => trial.arm), ['on', 'off', 'off', 'on'])
  assert.equal(trials[0].id, 'team-disabled-1-on')
  assert.ok(trials.every(trial => trial.reasoningSetting === 'thinking-disabled'))
  assert.ok(trials.every(trial => trial.batch !== 'schema'))
})

test('execution gate refuses unnotified provider execution without reading credentials', async () => {
  await assert.rejects(run('X:/missing', 'not-ready'), /parent-execution-gate-required/)
})

test('reducer totals include both HTTP rows without re-adding reasoning', () => {
  const usage = normalizeUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, completion_tokens_details: { reasoning_tokens: 5 } })
  const plan = { route: {}, limits: {}, fixture: {}, schema: { sha256: 'private-hash', count: 1 }, sourceHashes: {}, limitations: [] }
  const calls = ['a', 'b'].map(id => ({ id, usage, rawUsage: {}, latencyMs: 5, phase: id === 'a' ? 'reducer' : 'answer' }))
  const report = buildReport(plan, calls, [{ id: 'log-1-reducer', batch: 'log', pair: 1, arm: 'reducer', callRows: ['a', 'b'], quality: { passed: true } }])
  assert.equal(report.arms[0].usage.prompt_tokens.exact, 200)
  assert.equal(report.arms[0].usage.total_tokens.exact, 240)
  assert.equal(report.arms[0].usage.reasoning_tokens.exact, 10)
  assert.equal(report.arms[0].totalLatencyMs, 10)
  assert.equal(report.totals.prompt_cache_miss_tokens.exact, null)
})

test('report excludes schema contents and marks money/cache limitations', () => {
  const report = buildReport({ route: {}, limits: {}, fixture: {}, schema: { count: 1, sha256: 'x' }, sourceHashes: {}, limitations: [] }, [], [])
  const rendered = renderReport(report)
  assert.match(rendered, /Prices are unknown/)
  assert.match(rendered, /cold provider cache/)
  assert.doesNotMatch(rendered, /Authorization:|Bearer /)
})
