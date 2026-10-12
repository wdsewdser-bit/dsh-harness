import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { readJournalTail, decodeJournal } from '../home/profiles/web/plugins/team-usage.mjs'
import { createObservation, projectMessages, verifyArchive } from '../home/profiles/web/plugins/observation-pack-v2.mjs'
import { archiveText, buildBoundedInput, buildReducerPrompt, callReducer, parseReceipt, verifyReceipt, renderReceipt } from '../home/profiles/web/plugins/evidence-reducer.mjs'

export const DEFAULT_WORKSPACE = 'D:/dsh-test/workspaces/usage-lab-20261001'
export const DEFAULT_SOURCE = 'D:/dsh-test/home/sessions/--D-dsh-test-workspaces-RustMc--/session-028e6f5b-1716-4c23-a232-af16d853d191/session.v4.jsonl.zstd'
const PROFILE = 'D:/dsh-test/home/profiles/web/cordis.patch.yml'
const CREDENTIALS = 'D:/dsh-test/home/.credentials.yaml'
const require = createRequire('D:/dsh-test/home/profiles/web/node_modules/@deepseek-ai/cordis/package.json')
const yaml = require('yaml')
const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
const json = file => JSON.parse(readFileSync(file, 'utf8'))
const writeJson = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value, null, 2) + '\n') }
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null

export function normalizeUsage(raw) {
  const u = raw && typeof raw === 'object' ? raw : {}
  return {
    prompt_tokens: finite(u.prompt_tokens),
    prompt_cache_hit_tokens: finite(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens),
    prompt_cache_miss_tokens: finite(u.prompt_cache_miss_tokens),
    completion_tokens: finite(u.completion_tokens),
    reasoning_tokens: finite(u.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens),
    total_tokens: finite(u.total_tokens),
  }
}

export function makeFixture() {
  const lines = Array.from({ length: 400 }, (_, i) => `trace step=${String(i + 1).padStart(4, '0')} component=fixture-worker phase=compile artifact=item-${i % 23} outcome=ok`)
  lines[1] = 'WARN: CONFIG fixture=lab-v1 expected_checksum=7e2a required_route=flash'
  lines[172] = 'ERROR: UNIQUE_FAILURE E_FIXTURE_173 file=src/cache.ts:41 expected=7e2a actual=91bf'
  lines[398] = 'WARN: FINAL fixture=lab-v1 status=blocked reason=checksum-mismatch'
  const critical = [2, 173, 399].map(line => ({ line, text: lines[line - 1] }))
  return { version: 'usage-lab-v1', text: lines.join('\n'), critical }
}

export function validateAnswer(text, fixture) {
  let answer
  try { answer = JSON.parse(String(text).replace(/^```(?:json)?\s*|\s*```$/g, '')) } catch { return { passed: false, reasons: ['answer-not-json'], quoteRecall: 0 } }
  const reasons = []
  if (answer.error_code !== 'E_FIXTURE_173') reasons.push('error-code')
  if (answer.error_line !== 173) reasons.push('error-line')
  if (answer.expected_checksum !== '7e2a' || answer.actual_checksum !== '91bf') reasons.push('checksum')
  if (answer.final_status !== 'blocked') reasons.push('final-status')
  const quotes = Array.isArray(answer.quotes) ? answer.quotes : answer.quotes && typeof answer.quotes === 'object' ? Object.values(answer.quotes) : []
  const recalled = fixture.critical.filter(expected => quotes.some(q => q?.line === expected.line && q.text === expected.text)).length
  if (recalled !== fixture.critical.length) reasons.push('critical-quotes-missing')
  for (const q of quotes) if (!q || !Number.isInteger(q.line) || fixture.text.split('\n')[q.line - 1] !== q.text) reasons.push('quote-mismatch')
  return { passed: reasons.length === 0, reasons: [...new Set(reasons)], quoteRecall: recalled / fixture.critical.length }
}

export function planTrials() {
  const trials = []
  for (const [batch, arms] of [['schema', ['off', 'on', 'on', 'off']], ['team', ['off', 'on', 'on', 'off']], ['history', ['short', 'long', 'long', 'short']]]) {
    arms.forEach((arm, i) => trials.push({ id: `${batch}-${i + 1}-${arm}`, batch, arm, pair: Math.floor(i / 2) + 1, calls: 1 }))
  }
  for (const [i, arms] of [['full', 'pack', 'reducer'], ['reducer', 'pack', 'full']].entries()) {
    for (const arm of arms) trials.push({ id: `log-${i + 1}-${arm}`, batch: 'log', arm, pair: i + 1, calls: arm === 'reducer' ? 2 : 1 })
  }
  return trials
}

export function disabledContinuationTrials() {
  const team = ['on', 'off', 'off', 'on'].map((arm, i) => ({ id: `team-disabled-${i + 1}-${arm}`, batch: 'team', arm, pair: Math.floor(i / 2) + 1, calls: 1, reasoningSetting: 'thinking-disabled' }))
  const others = planTrials().filter(trial => trial.batch === 'history' || trial.batch === 'log').map(trial => ({ ...trial, id: trial.id + '-disabled', reasoningSetting: 'thinking-disabled' }))
  return [...team, ...others]
}

function findProvider() {
  const doc = yaml.parseDocument(readFileSync(PROFILE, 'utf8'), { logLevel: 'silent' }).toJS()
  let provider
  function visit(v) { if (!v || typeof v !== 'object') return; if (v.providers?.opencodego) provider = v.providers.opencodego; for (const child of Object.values(v)) visit(child) }
  visit(doc)
  if (!provider || provider.baseURL !== 'http://127.0.0.1:8788/v1' || provider.api !== 'openai-completions' || !provider.models?.some(m => m.id === 'deepseek-v4.1-flash')) throw new Error('profile-route-drift')
  return provider
}

function readKey() {
  if (process.env.OPENCODEGO_API_KEY) return process.env.OPENCODEGO_API_KEY
  const doc = yaml.parse(readFileSync(CREDENTIALS, 'utf8'))
  const key = doc?.refs?.OPENCODEGO_API_KEY
  if (typeof key === 'string' && key.trim()) return key
  throw new Error('opencodego-key-unavailable')
}

function extractSchema(source) {
  const find = text => text.split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } }).reverse().find(row => row.type === 'request/header' && Array.isArray(row.data?.header?.tools) && row.data.header.tools.length > 0)
  let row = find(readJournalTail(source))
  let mode = 'tail'
  if (!row) { row = find(decodeJournal(readFileSync(source))); mode = 'single-source-full-decode' }
  if (!row) throw new Error('source-tools-unavailable')
  const tools = row.data.header.tools.map(tool => {
    if (typeof tool.name !== 'string' || typeof tool.parameters !== 'object') throw new Error('unexpected-tool-schema')
    return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }
  })
  return { tools, source: { path: source, seq: row.seq, type: row.type, extraction: mode, sha256: sha(tools), count: tools.length, bytes: Buffer.byteLength(JSON.stringify(tools)) } }
}

export function estimateInput(body) {
  return Math.ceil(Buffer.byteLength(JSON.stringify({ messages: body.messages, tools: body.tools }), 'utf8') / 4)
}

export function assertBudget(state, estimate, limits) {
  if (state.calls >= limits.calls) throw new Error('call-budget-exhausted')
  // Reserve more than the byte/4 estimate; actual provider usage replaces this reserve after each call.
  if (state.inputTokens + Math.ceil(estimate * 1.6) + 600 > limits.inputTokens) throw new Error('input-budget-exhausted')
}

const TEAM_TEXT = [
  '[representative Team task injection; synthetic; no production task state]',
  'task_id=lab-fixture-audit revision=4 phase=review owner=fixture-lead tier=1',
  'Approved scope: isolate diagnostic fixture; no product writes; no provider route changes.',
  'Acceptance: identify unique checksum failure, preserve CONFIG and FINAL quotations, cite original lines.',
  'Decision version=2: blocked checksums require exact evidence; do not infer success from a shorter prompt.',
  'Inbox cursor=3 handled=[wake-lab-1,wake-lab-2] pending=[]; room=closed; next action=return evidence.',
  'The archive is authoritative for quoted evidence. Do not claim a real Team lifecycle action happened.',
  'Member summary: compile completed except checksum comparison; verifier must independently quote CONFIG, ERROR and FINAL.',
  'Lease=none (read-only review); dependencies=[]; requirement version=1; unresolved=[]; wait condition=none.',
].join('\n')

function makeHistory(long) {
  return Array.from({ length: long ? 48 : 2 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Previous fixture discussion ${i + 1}: retain exact evidence, check only approved scope, trace artifact=item-${i % 23}. No checksum conclusion was made. ` + (long ? 'Progress remains read-only; archive identity and line quotations are required. '.repeat(4) : '') }))
}

function question(text) {
  return 'Analyze only the supplied diagnostic fixture. Return one JSON object with error_code, error_line (original 1-based source line), expected_checksum, actual_checksum, final_status, and quotes containing all three decisive CONFIG, UNIQUE_FAILURE and FINAL lines, each {line,text}. Copy each complete source line exactly; do not quote L<number>: wrappers. No tool calls or explanatory prose.\n--- DIAGNOSTIC FIXTURE ---\n' + text
}

function bodyFor(trial, material) {
  const messages = [{ role: 'system', content: 'You are an evidence-led diagnostic verifier. Data below is a synthetic fixture. Return exact JSON quotations.' }]
  if (trial.batch === 'team' && trial.arm === 'on') messages[0].content += '\n' + TEAM_TEXT
  if (trial.batch === 'history') messages.push(...makeHistory(trial.arm === 'long'))
  const text = trial.batch === 'log' ? material[trial.arm] : material.compact
  messages.push({ role: 'user', content: question(text) })
  const body = { model: 'deepseek-v4.1-flash', messages, max_tokens: 1500, temperature: 0, stream: false }
  if (trial.batch === 'schema' && trial.arm === 'on') { body.tools = material.tools; body.tool_choice = 'none' }
  return body
}

export function prepare(workspace = DEFAULT_WORKSPACE, source = DEFAULT_SOURCE) {
  workspace = resolve(workspace)
  mkdirSync(workspace, { recursive: true })
  const provider = findProvider()
  const schema = extractSchema(source)
  const fixture = makeFixture()
  writeJson(join(workspace, 'fixture.json'), fixture)
  writeJson(join(workspace, 'tools-schema.private.json'), schema.tools)
  const archive = archiveText(fixture.text, join(workspace, 'archive'))
  if (!archive) throw new Error('fixture-archive-failed')
  const obs = createObservation({ toolName: 'synthetic-log', callId: 'lab-log-1', blocks: [{ type: 'text', text: fixture.text }], spillDir: join(workspace, 'archive'), previewBytes: 1024, evidenceChars: 2200 })
  if (!obs || !verifyArchive(obs)) throw new Error('observation-archive-failed')
  obs.fullSends = 0
  const projection = projectMessages([{ role: 'toolResult', toolCallId: obs.callId, content: [{ type: 'text', text: fixture.text }] }], new Map([[obs.callId, obs]]))
  const pack = projection.messages[0].content[0].text
  if (!fixture.critical.every(q => pack.includes(q.text))) throw new Error('pack-critical-recall-failed')
  const bounded = buildBoundedInput(fixture.text, { maxInputBytes: 24000, maxInputLines: 80 })
  if (!fixture.critical.every(q => bounded.text.includes(q.text))) throw new Error('bounded-critical-recall-failed')
  const compact = fixture.critical.map(q => `L${q.line}: ${q.text}`).join('\n')
  writeJson(join(workspace, 'material.json'), { compact, full: fixture.text, pack, archive, bounded })
  const material = { compact, full: fixture.text, pack, tools: schema.tools, reducer: pack }
  const trials = planTrials().map(t => ({ ...t, estimatedInput: estimateInput(bodyFor(t, material)) }))
  const reducerEstimate = estimateInput({ messages: [{ role: 'user', content: buildReducerPrompt(bounded.text, archive, { maxQuotes: 6 }) }] })
  const estimatedInput = trials.reduce((n, t) => n + t.estimatedInput + (t.arm === 'reducer' ? reducerEstimate : 0), 0)
  const plan = {
    version: 1, createdAt: new Date().toISOString(), workspace,
    route: { provider: 'opencodego', model: 'deepseek-v4.1-flash', baseURL: provider.baseURL, api: provider.api },
    limits: { calls: 24, plannedCalls: trials.reduce((n, t) => n + t.calls, 0), inputTokens: 200000, maxOutputPerCall: 1500, concurrency: 1, timeoutMs: 90000 },
    estimatedInput, reducerEstimate, schema: schema.source,
    fixture: { version: fixture.version, sha256: sha(fixture.text), bytes: Buffer.byteLength(fixture.text), lines: 400, criticalLines: fixture.critical.map(q => q.line) },
    sourceHashes: Object.fromEntries(['evidence-reducer.mjs', 'observation-pack-v2.mjs'].map(name => [name, sha(readFileSync('D:/dsh-test/home/profiles/web/plugins/' + name))])),
    trials, requires: 'explicit parent notification: history backfilled and recorder installed',
    limitations: ['synthetic task/history/log; real root tool schema', 'counterbalanced sequential pairs; cache heat cannot be reset or proven cold', 'pure OP toolResult projection; current DSH core uses role tool; no live OP lifecycle claim', 'Reducer pure functions + isolated llm.stream adapter with real HTTP', 'no prices known; token savings are not monetary savings', 'not an explanation of the full historical 47-billion-token corpus'],
  }
  if (estimatedInput * 1.6 + trials.reduce((n, t) => n + t.calls, 0) * 600 > plan.limits.inputTokens) throw new Error('planned-input-budget-exceeds-limit')
  writeJson(join(workspace, 'plan.json'), plan)
  return { workspace, plannedCalls: plan.limits.plannedCalls, estimatedInput, conservativeInputReserve: Math.ceil(estimatedInput * 1.6) + plan.limits.plannedCalls * 600, schemaCount: schema.source.count, schemaSha256: schema.source.sha256 }
}

async function httpCall(body, context) {
  if (context.wireExtra) body = { ...body, ...context.wireExtra }
  const estimate = estimateInput(body)
  assertBudget(context.state, estimate, context.plan.limits)
  context.state.calls++
  const started = Date.now()
  const id = `${context.runId}-call-${context.state.calls}`
  const row = { id, runId: context.runId, trial: context.trial, phase: context.phase, startedAt: new Date().toISOString(), requestedModel: body.model, reasoningSetting: context.wireExtra ? 'thinking-disabled' : 'provider-default', estimatedInput: estimate, requestSha256: sha(body), maxOutput: body.max_tokens }
  appendFileSync(context.ledger, JSON.stringify({ ...row, event: 'request-start' }) + '\n')
  try {
    const response = await fetch(context.plan.route.baseURL + '/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + context.key, 'x-opencode-session': context.runId },
      body: JSON.stringify(body), signal: context.signal ?? AbortSignal.timeout(context.plan.limits.timeoutMs),
    })
    row.httpStatus = response.status
    if (!response.ok) { await response.body?.cancel(); throw new Error(`provider-http-${response.status}`) }
    const data = await response.json()
    if (!data.choices?.length) throw new Error('provider-missing-choices')
    row.model = data.model ?? null
    row.responseId = data.id ?? null
    row.rawUsage = data.usage ?? null
    row.usage = normalizeUsage(data.usage)
    row.finishReason = data.choices[0].finish_reason ?? null
    row.text = data.choices[0].message?.content ?? ''
    row.latencyMs = Date.now() - started
    row.error = null
    context.state.inputTokens += row.usage.prompt_tokens ?? Math.ceil(estimate * 1.6) + 600
    appendFileSync(context.ledger, JSON.stringify({ ...row, event: 'request-complete' }) + '\n')
    context.rows.push(row)
    if (row.finishReason !== 'stop') throw new Error('provider-finish-' + row.finishReason)
    if (context.state.inputTokens > context.plan.limits.inputTokens) throw new Error('actual-input-budget-exceeded')
    return row
  } catch (error) {
    if (!context.rows.some(r => r.id === id)) {
      row.latencyMs = Date.now() - started
      row.error = /^provider-http-\d+$/.test(error.message) ? error.message : error.name === 'TimeoutError' || error.name === 'AbortError' ? 'provider-timeout' : 'provider-call-failed'
      row.usage ??= normalizeUsage(null)
      row.rawUsage ??= null
      context.state.inputTokens += Math.ceil(estimate * 1.6) + 600
      context.rows.push(row)
      appendFileSync(context.ledger, JSON.stringify({ ...row, event: 'request-failed' }) + '\n')
    }
    throw new Error(row.error ?? error.message)
  }
}

export async function run(workspace, ready, resume = false, disableThinking = false) {
  if (ready !== 'history-backfilled-recorder-installed') throw new Error('parent-execution-gate-required')
  workspace = resolve(workspace ?? DEFAULT_WORKSPACE)
  const plan = json(join(workspace, 'plan.json'))
  const provider = findProvider()
  if (provider.baseURL !== plan.route.baseURL) throw new Error('prepared-route-drift')
  for (const [name, hash] of Object.entries(plan.sourceHashes)) if (sha(readFileSync('D:/dsh-test/home/profiles/web/plugins/' + name)) !== hash) throw new Error('plugin-source-drift-' + name)
  const fixture = json(join(workspace, 'fixture.json'))
  if (sha(fixture.text) !== plan.fixture.sha256) throw new Error('fixture-drift')
  const material = { ...json(join(workspace, 'material.json')), tools: json(join(workspace, 'tools-schema.private.json')) }
  if (sha(material.tools) !== plan.schema.sha256) throw new Error('schema-drift')
  const ledger = join(workspace, 'calls.jsonl')
  const results = []
  let previousRows = []
  let runId = 'usage-lab-' + randomUUID()
  if (existsSync(ledger) && readFileSync(ledger, 'utf8').trim()) {
    if (!resume) throw new Error('existing-call-ledger-refuse-rerun')
    const events = readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const starts = events.filter(row => row.event === 'request-start')
    previousRows = events.filter(row => row.event === 'request-complete')
    if (starts.length !== previousRows.length || events.some(row => row.event === 'request-failed') || new Set(starts.map(row => row.id)).size !== starts.length || new Set(previousRows.map(row => row.id)).size !== previousRows.length) throw new Error('resume-unsettled-or-failed-call')
    runId = starts[0]?.runId
    if (!runId || events.some(row => row.runId !== runId)) throw new Error('resume-run-identity-mismatch')
    for (const trial of plan.trials) {
      const rows = previousRows.filter(row => row.trial === trial.id)
      if (rows.length === 0) break
      if (disableThinking && trial.id === 'team-2-on') {
        const failed = rows[0]
        if (rows.length !== 1 || previousRows.length !== 6 || failed.finishReason !== 'length' || failed.text !== '' || failed.usage.completion_tokens !== 1500 || failed.usage.reasoning_tokens !== 1500) throw new Error('disabled-continuation-prerequisite-mismatch')
        break
      }
      if (rows.length !== trial.calls || rows.filter(row => row.phase === 'answer').length !== 1 || rows.some(row => row.finishReason !== 'stop' || row.error)) throw new Error('resume-incomplete-trial-' + trial.id)
      if (trial.arm === 'reducer') {
        const saved = json(join(workspace, trial.id + '-receipt.json'))
        if (!verifyReceipt(saved.receipt, fixture.text, { maxReceiptTokens: 1500 }).ok || !fixture.critical.every(q => saved.receipt.quotes.some(r => r.line === q.line && r.text === q.text))) throw new Error('resume-reducer-quality-' + trial.id)
        material.reducer = renderReceipt(saved.receipt, material.archive, material.bounded)
      }
      const answerRow = rows.find(row => row.phase === 'answer')
      if (answerRow.requestSha256 !== sha(bodyFor(trial, material))) throw new Error('resume-answer-payload-drift-' + trial.id)
      const quality = validateAnswer(answerRow.text, fixture)
      if (!quality.passed) throw new Error('resume-answer-quality-' + trial.id)
      results.push({ ...trial, ...(disableThinking && trial.batch === 'team' ? { batch: 'team-default-incomplete' } : {}), reasoningSetting: 'provider-default', callRows: rows.map(row => row.id), quality, offlineRevalidated: true })
    }
    if (results.reduce((n, trial) => n + trial.callRows.length, 0) !== previousRows.length - (disableThinking ? 1 : 0)) throw new Error('resume-noncontiguous-trials')
    const originalReport = join(workspace, 'report.pre-validator-fix.json')
    if (!existsSync(originalReport)) writeFileSync(originalReport, readFileSync(join(workspace, 'report.json')))
    const revalidationPath = join(workspace, disableThinking ? 'revalidation-before-disabled.json' : 'revalidation.json')
    writeJson(revalidationPath, {
      at: new Date().toISOString(), runId, providerCalls: 0,
      reason: 'Original prompt did not require an array for quotes. Accept array or named-object values, preserving exact complete-line quotation and all critical evidence gates. Original stop report retained.',
      originalReport, validated: results.map(trial => ({ trial: trial.id, callIds: trial.callRows, quality: trial.quality })),
    })
  } else if (resume) throw new Error('resume-without-ledger')
  if (disableThinking) {
    if (previousRows.length !== 6 || results.length !== 5) throw new Error('disabled-continuation-count-mismatch')
    const stopped = join(workspace, 'report.length-stop.json')
    if (existsSync(stopped)) throw new Error('disabled-continuation-already-attempted')
    writeFileSync(stopped, readFileSync(join(workspace, 'report.json')))
    plan.trials = disabledContinuationTrials()
    plan.limits = { ...plan.limits, plannedCalls: 22 }
    plan.continuation = {
      reason: 'Parent authorized request-level thinking disable after all 1500 output tokens were consumed by reasoning. First new Team-on confirms parameter acceptance and zero reported reasoning before later arms execute.',
      wireExtra: { thinking: { type: 'disabled' } }, originalStoppedReport: stopped,
      parameterEvidence: { file: 'D:/dsh-test/home/profiles/web/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js', lines: [681, 686], sha256: '1e2097ced37cf0e21aa5711297eecc77916de8a4ed81a9019bc7d97b22825fa3' },
      historicalCalls: 6, plannedNewCalls: 16, totalPlannedCalls: 22, schemaSetting: 'provider-default', subsequentBatchesSetting: 'thinking-disabled',
    }
    writeJson(join(workspace, 'disabled-plan.json'), plan)
  }
  const ctx = { plan, key: readKey(), ledger, runId, ...(disableThinking ? { wireExtra: plan.continuation.wireExtra } : {}), state: { calls: previousRows.length, inputTokens: previousRows.reduce((n, row) => n + (row.usage.prompt_tokens ?? Math.ceil(row.estimatedInput * 1.6) + 600), 0) }, rows: previousRows }
  let failure = null
  try {
    for (const trial of plan.trials) {
      if (results.some(result => result.id === trial.id)) continue
      ctx.trial = trial.id
      const callRows = []
      if (trial.arm === 'reducer') {
        ctx.phase = 'reducer'
        const llm = { stream(options) { return (async function* () {
          const row = await httpCall({ model: options.model, messages: options.messages.map(m => ({ role: m.role, content: m.content.map(b => b.text ?? '').join('\n') })), max_tokens: options.maxTokens, temperature: 0, stream: false }, { ...ctx, signal: options.signal })
          callRows.push(row.id)
          yield { type: 'text-delta', text: row.text }
          yield { type: 'usage', usage: row.rawUsage }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })() } }
        const raw = await callReducer(llm, { provider: 'opencodego', model: plan.route.model }, buildReducerPrompt(material.bounded.text, material.archive, { maxQuotes: 6 }), { maxReceiptTokens: 1500, timeoutMs: plan.limits.timeoutMs })
        const receipt = parseReceipt(raw.text)
        const verified = verifyReceipt(receipt, fixture.text, { maxReceiptTokens: 1500 })
        const recall = fixture.critical.filter(q => receipt?.quotes?.some(r => r.line === q.line && q.text === r.text)).length / fixture.critical.length
        writeJson(join(workspace, trial.id + '-receipt.json'), { receipt, verification: verified, criticalQuoteRecall: recall })
        if (!verified.ok || recall !== 1) throw new Error('reducer-quality-gate-failed')
        material.reducer = renderReceipt(receipt, material.archive, material.bounded)
      }
      ctx.phase = 'answer'
      const row = await httpCall(bodyFor(trial, material), ctx)
      callRows.push(row.id)
      const quality = validateAnswer(row.text, fixture)
      results.push({ ...trial, callRows, quality })
      writeJson(join(workspace, 'progress.json'), { runId: ctx.runId, ...ctx.state, results, lastTrial: trial.id })
      console.log(JSON.stringify({ trial: trial.id, calls: ctx.state.calls, inputTokens: ctx.state.inputTokens, qualityPassed: quality.passed, latencyMs: row.latencyMs, usage: row.usage }))
      if (!quality.passed) throw new Error('answer-quality-gate-failed-' + trial.id)
      if (disableThinking && row.usage.reasoning_tokens !== 0) throw new Error('thinking-disabled-not-confirmed-' + trial.id)
    }
  } catch (error) { failure = error.message }
  const report = buildReport(plan, ctx.rows, results, failure, ctx.runId)
  if (resume) report.validatorCorrection = { revalidation: join(workspace, 'revalidation.json'), originalReport: join(workspace, 'report.pre-validator-fix.json'), providerCallsAddedByRevalidation: 0 }
  if (disableThinking) report.continuation = plan.continuation
  writeJson(join(workspace, 'report.json'), report)
  writeFileSync(join(workspace, 'report.md'), renderReport(report))
  console.log(JSON.stringify({ report: join(workspace, 'report.json'), status: report.status, calls: ctx.state.calls, inputTokens: ctx.state.inputTokens, failure }))
  if (failure) throw new Error(failure)
  return report
}

function sumKnown(rows, key) {
  const values = rows.map(r => r.usage[key])
  return { sum: values.reduce((n, v) => n + (v ?? 0), 0), known: values.filter(v => v !== null).length, missing: values.filter(v => v === null).length, exact: values.every(v => v !== null) ? values.reduce((n, v) => n + v, 0) : null }
}

export function buildReport(plan, calls, trials, failure = null, runId = null) {
  const totals = Object.fromEntries(Object.keys(normalizeUsage(null)).map(key => [key, sumKnown(calls, key)]))
  const arms = trials.map(trial => {
    const rows = calls.filter(row => trial.callRows.includes(row.id))
    return { ...trial, reasoningSetting: trial.reasoningSetting ?? 'provider-default', totalLatencyMs: rows.reduce((n, row) => n + row.latencyMs, 0), usage: Object.fromEntries(Object.keys(normalizeUsage(null)).map(key => [key, sumKnown(rows, key)])) }
  })
  const comparisons = []
  for (const batch of ['schema', 'team', 'history', 'log']) {
    for (const pair of [1, 2]) {
      const rows = arms.filter(a => a.batch === batch && a.pair === pair)
      const baseline = rows.find(a => a.arm === ({ schema: 'off', team: 'off', history: 'short', log: 'full' }[batch]))
      for (const arm of rows.filter(a => a !== baseline)) {
        comparisons.push({ batch, pair, baseline: baseline?.id ?? null, arm: arm.id, qualityPassed: !!baseline?.quality.passed && arm.quality.passed, inputTokensDelta: baseline?.usage.prompt_tokens.exact !== null && baseline?.usage.prompt_tokens.exact !== undefined && arm.usage.prompt_tokens.exact !== null ? arm.usage.prompt_tokens.exact - baseline.usage.prompt_tokens.exact : null, completionTokensDelta: baseline?.usage.completion_tokens.exact !== null && baseline?.usage.completion_tokens.exact !== undefined && arm.usage.completion_tokens.exact !== null ? arm.usage.completion_tokens.exact - baseline.usage.completion_tokens.exact : null, latencyDeltaMs: baseline ? arm.totalLatencyMs - baseline.totalLatencyMs : null, monetarySavings: null })
      }
    }
  }
  return { schemaVersion: 1, runId, completedAt: new Date().toISOString(), status: failure ? 'stopped' : 'completed', failure, route: plan.route, limits: plan.limits, fixture: plan.fixture, schema: plan.schema, sourceHashes: plan.sourceHashes, limitations: plan.limitations, totals, arms, comparisons, calls, usageSemantics: 'Raw usage retained per HTTP call. Reasoning is a reported subset/detail, never added to completion or total. Missing fields stay null. Reducer totals include both reducer and answer calls. Provider prompt_tokens is used as returned; cache hit/miss are not added to it.' }
}

export function renderReport(report) {
  const rows = report.calls.map(c => `| ${c.trial} | ${c.phase} | ${c.model ?? 'null'} | ${c.usage.prompt_tokens} | ${c.usage.prompt_cache_hit_tokens} | ${c.usage.prompt_cache_miss_tokens} | ${c.usage.completion_tokens} | ${c.usage.reasoning_tokens} | ${c.usage.total_tokens} | ${c.latencyMs} |`).join('\n')
  return `# Usage attribution lab\n\nStatus: ${report.status}; calls: ${report.calls.length}; failure: ${report.failure ?? 'none'}.\n\nModel: ${report.route.model}; protocol: ${report.route.api}.\n\nReal HTTP usage; synthetic diagnostic fixture and representative Team/history; extracted real root tool schema (hash/count only).\n\n| Trial | Phase | Model returned | Input | Cache hit | Cache miss | Output | Reasoning | Total | Latency ms |\n|---|---|---|---:|---:|---:|---:|---:|---:|---:|\n${rows}\n\nQuality requires the exact error, checksums, blocked state, and all three original-line quotations. An arm with missing recall is not a valid savings result. All reducer costs are included. Reasoning is never added again. Missing usage fields are null.\n\nPrices are unknown; reported token differences do not establish monetary savings. Pair order is counterbalanced, but neither a cold provider cache nor absence of cross-arm prefix reuse can be guaranteed. Cache hit/miss must be examined per call. No extrapolation to the entire historical 47-billion-token corpus is justified.\n\nObservationPack uses the existing pure toolResult projection on the synthetic fixture. Current DSH core uses role tool; this test does not claim an active-session OP hook was exercised. Reducer uses existing pure buildBoundedInput/buildReducerPrompt/callReducer/verifyReceipt/renderReceipt with an isolated stream adapter that makes real HTTP calls.\n\nDetailed paired deltas and raw usage: report.json. Private schema contents and authentication headers are excluded from this report.\n`
}

export async function runTargeted(workspace, ready) {
  if (ready !== 'history-backfilled-recorder-installed') throw new Error('parent-execution-gate-required')
  workspace = resolve(workspace ?? DEFAULT_WORKSPACE)
  const prior = json(join(workspace, 'report.json'))
  if (prior.calls.length !== 16 || prior.failure !== 'answer-quality-gate-failed-log-1-pack-disabled') throw new Error('targeted-prerequisite-mismatch')
  const before = join(workspace, 'report.before-targeted.json')
  if (existsSync(before)) throw new Error('targeted-already-attempted')
  const plan = json(join(workspace, 'disabled-plan.json'))
  findProvider()
  for (const [name, hash] of Object.entries(plan.sourceHashes)) if (sha(readFileSync('D:/dsh-test/home/profiles/web/plugins/' + name)) !== hash) throw new Error('plugin-source-drift-' + name)
  const fixture = json(join(workspace, 'fixture.json'))
  if (sha(fixture.text) !== plan.fixture.sha256) throw new Error('fixture-drift')
  const material = json(join(workspace, 'material.json'))
  const ledger = join(workspace, 'calls.jsonl')
  const events = readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const starts = events.filter(row => row.event === 'request-start')
  const completed = events.filter(row => row.event === 'request-complete')
  if (starts.length !== 16 || completed.length !== 16 || events.some(row => row.event === 'request-failed') || new Set(starts.map(row => row.id)).size !== 16 || completed.some(row => row.runId !== prior.runId)) throw new Error('targeted-ledger-mismatch')
  writeFileSync(before, readFileSync(join(workspace, 'report.json')))
  const ctx = { plan, key: readKey(), ledger, runId: prior.runId, wireExtra: { thinking: { type: 'disabled' } }, state: { calls: 16, inputTokens: prior.totals.prompt_tokens.exact }, rows: prior.calls }
  const trials = prior.arms
  const experiments = []
  let systemicFailure = false
  const record = async (name, fn) => {
    if (systemicFailure) { experiments.push({ name, status: 'unexecuted', reason: 'prior-provider-failure' }); return }
    const count = ctx.state.calls
    try { experiments.push({ name, status: 'passed', ...(await fn()) }) }
    catch (error) {
      experiments.push({ name, status: ctx.state.calls === count ? 'unexecuted' : 'failed', reason: error.message })
      if (/^provider-|actual-input-budget|input-budget|call-budget|thinking-disabled-not-confirmed/.test(error.message)) systemicFailure = true
    }
    writeJson(join(workspace, 'targeted-progress.json'), { ...ctx.state, experiments })
    console.log(JSON.stringify({ experiment: name, calls: ctx.state.calls, inputTokens: ctx.state.inputTokens, result: experiments.at(-1) }))
  }
  await record('real-reducer', async () => {
    ctx.trial = 'log-targeted-reducer-disabled'
    ctx.phase = 'reducer'
    const ids = []
    const llm = { stream(options) { return (async function* () {
      const row = await httpCall({ model: options.model, messages: options.messages.map(m => ({ role: m.role, content: m.content.map(b => b.text ?? '').join('\n') })), max_tokens: options.maxTokens, temperature: 0, stream: false }, { ...ctx, signal: options.signal })
      ids.push(row.id)
      if (row.usage.reasoning_tokens !== 0) throw new Error('thinking-disabled-not-confirmed-reducer')
      yield { type: 'text-delta', text: row.text }
      yield { type: 'usage', usage: row.rawUsage }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })() } }
    const raw = await callReducer(llm, { provider: 'opencodego', model: plan.route.model }, buildReducerPrompt(material.bounded.text, material.archive, { maxQuotes: 6 }), { maxReceiptTokens: 1500, timeoutMs: plan.limits.timeoutMs })
    const receipt = parseReceipt(raw.text)
    const verification = verifyReceipt(receipt, fixture.text, { maxReceiptTokens: 1500 })
    const criticalQuoteRecall = fixture.critical.filter(q => receipt?.quotes?.some(r => r.line === q.line && r.text === q.text)).length / fixture.critical.length
    const receiptPath = join(workspace, 'targeted-reducer-receipt.json')
    writeJson(receiptPath, { receipt, verification, criticalQuoteRecall })
    if (!verification.ok || criticalQuoteRecall !== 1) {
      trials.push({ id: ctx.trial, batch: 'log', pair: 1, arm: 'reducer', reasoningSetting: 'thinking-disabled', callRows: ids, quality: { passed: false, quoteRecall: criticalQuoteRecall, reasons: ['receipt-critical-quality'] } })
      throw new Error('reducer-critical-receipt-failed')
    }
    material.reducer = renderReceipt(receipt, material.archive, material.bounded)
    ctx.phase = 'answer'
    const trial = { id: ctx.trial, batch: 'log', pair: 1, arm: 'reducer', reasoningSetting: 'thinking-disabled' }
    const answer = await httpCall(bodyFor(trial, material), ctx)
    ids.push(answer.id)
    const quality = validateAnswer(answer.text, fixture)
    trials.push({ ...trial, callRows: ids, quality })
    if (!quality.passed) throw new Error('reducer-answer-critical-quality-failed')
    if (answer.usage.reasoning_tokens !== 0) throw new Error('thinking-disabled-not-confirmed-reducer-answer')
    return { receiptPath, verification, criticalQuoteRecall, answerQuality: quality, callIds: ids }
  })
  await record('pack-line-overlay-candidate', async () => {
    const overlay = fixture.critical.map(q => `L${q.line}: ${q.text}`).join('\n')
    material['pack-line-overlay'] = material.pack + '\n--- IMMUTABLE FIXTURE ORIGINAL LINE INDEX: NEW CANDIDATE, NOT PRODUCTION ---\n' + overlay
    const trial = { id: 'log-targeted-pack-line-overlay-disabled', batch: 'log', pair: 1, arm: 'pack-line-overlay', reasoningSetting: 'thinking-disabled', candidateOnly: true }
    ctx.trial = trial.id
    ctx.phase = 'answer'
    const row = await httpCall(bodyFor(trial, material), ctx)
    const quality = validateAnswer(row.text, fixture)
    trials.push({ ...trial, callRows: [row.id], quality })
    if (!quality.passed) throw new Error('pack-candidate-critical-quality-failed')
    if (row.usage.reasoning_tokens !== 0) throw new Error('thinking-disabled-not-confirmed-pack-candidate')
    return { quality, callIds: [row.id], provenance: 'line overlay generated only from immutable fixture, candidate-only; production renderHandle unchanged' }
  })
  const sdkPath = join(workspace, 'ptc-sdk.private.txt')
  const expectedSdkHash = '36fb549199503b202530c0acc2f51f1a84e4dad808f1ccf6a05762d406ef215e'
  const sdk = existsSync(sdkPath) ? readFileSync(sdkPath, 'utf8') : null
  for (const copies of [1, 2]) await record('ptc-sdk-' + copies + '-copies', async () => {
    if (sdk === null || sha(sdk) !== expectedSdkHash || Buffer.byteLength(sdk) !== 144589) throw new Error('sdk-fixture-unavailable-or-drift')
    ctx.trial = `sdk-${copies}-copies-disabled`
    ctx.phase = 'sentinel'
    const body = { model: plan.route.model, messages: [{ role: 'system', content: 'Reference tool SDK follows. This is a read-only context sizing experiment; do not execute tools.\n' + Array.from({ length: copies }, () => sdk).join('\n') }, { role: 'user', content: 'Return exactly USAGE_LAB_SDK_OK_20261001. Do not execute tools or add other text.' }], max_tokens: 1500, temperature: 0, stream: false }
    const row = await httpCall(body, ctx)
    const quality = { passed: row.text.trim() === 'USAGE_LAB_SDK_OK_20261001', sentinelExact: row.text.trim() === 'USAGE_LAB_SDK_OK_20261001', toolExecution: 'no-tools-exposed' }
    trials.push({ id: ctx.trial, batch: 'sdk', pair: 1, arm: copies + '-copies', reasoningSetting: 'thinking-disabled', callRows: [row.id], quality })
    if (!quality.passed) throw new Error('sdk-sentinel-quality-failed')
    if (row.usage.reasoning_tokens !== 0) throw new Error('thinking-disabled-not-confirmed-sdk')
    return { quality, callIds: [row.id], sdk: { path: sdkPath, sha256: expectedSdkHash, bytesPerCopy: 144589, copies, sourceMetadata: 'D:/dsh-test/docs/usage-audit-20261001/system-sdk-audit.json' } }
  })
  const report = buildReport(plan, ctx.rows, trials, prior.failure, prior.runId)
  report.status = experiments.every(experiment => experiment.status === 'passed') ? 'completed-with-observed-production-quality-failure' : 'targeted-completed-with-failures-or-unexecuted-arms'
  report.continuation = prior.continuation
  report.validatorCorrection = prior.validatorCorrection
  report.targeted = { initialCalls: 16, actualAdditionalCalls: ctx.state.calls - 16, originalStoppedReport: before, experiments, preservesOriginalOpFailure: true }
  const sdkArms = report.arms.filter(arm => arm.batch === 'sdk')
  if (sdkArms.length === 2) {
    report.sdkComparison = { first: sdkArms[0].id, second: sdkArms[1].id, qualityPassed: sdkArms.every(arm => arm.quality.passed), inputTokensDelta: sdkArms[1].usage.prompt_tokens.exact - sdkArms[0].usage.prompt_tokens.exact, outputTokensDelta: sdkArms[1].usage.completion_tokens.exact - sdkArms[0].usage.completion_tokens.exact, latencyDeltaMs: sdkArms[1].totalLatencyMs - sdkArms[0].totalLatencyMs, monetarySavings: null, repeats: 1, noExtrapolationToFiveCopiesOrHistory: true }
  }
  writeJson(join(workspace, 'report.json'), report)
  writeFileSync(join(workspace, 'report.md'), renderReport(report) + '\nSettings: schema ran with provider-default thinking; new Team/history/log/Reducer/candidate/SDK arms used request-level thinking disabled. The original Team length failure and OP original-line quality failure remain in calls/report.\n\nCandidate line overlay is not production ObservationPack. SDK is an independent one-pair context sizing experiment with a fixed sentinel; no conclusion about five copies or the historical corpus follows.\n')
  console.log(JSON.stringify({ report: join(workspace, 'report.json'), status: report.status, calls: ctx.state.calls, inputTokens: ctx.state.inputTokens, experiments }))
  return report
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  const opts = Object.fromEntries(args.flatMap((arg, i) => arg.startsWith('--') ? [[arg.slice(2), args[i + 1]]] : []))
  if (command === 'prepare') console.log(JSON.stringify(prepare(opts.workspace, opts.source)))
  else if (command === 'run') await run(opts.workspace, opts.ready, opts.resume === 'verified-completed')
  else if (command === 'continue-disabled') await run(opts.workspace, opts.ready, true, true)
  else if (command === 'targeted') await runTargeted(opts.workspace, opts.ready)
  else throw new Error('usage: node tools/usage-lab.mjs prepare|run [--workspace PATH] [--source JOURNAL] [--ready history-backfilled-recorder-installed] [--resume verified-completed]')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1 })
