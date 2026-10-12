import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, appendFile, mkdir, open, access } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { projectSdkRetention, findSdkSection } from '../home/profiles/web/plugins/ptc-sdk-retention.mjs'

const ROOT = 'D:/dsh-test/workspaces/context-sdk-01'
const AUDIT = 'D:/dsh-test/docs/usage-audit-20261001/system-sdk-audit.json'
const CERTIFICATE = 'D:/dsh-test/docs/context-opt-20261001/sdk-compatibility-manifest.json'
const MODULE = 'D:/dsh-test/home/profiles/web/plugins/ptc-sdk-retention.mjs'
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const normalizeUsage = raw => ({
  prompt_tokens: count(raw?.prompt_tokens), prompt_cache_hit_tokens: count(raw?.prompt_cache_hit_tokens ?? raw?.prompt_tokens_details?.cached_tokens),
  prompt_cache_miss_tokens: count(raw?.prompt_cache_miss_tokens), completion_tokens: count(raw?.completion_tokens),
  reasoning_tokens: count(raw?.reasoning_tokens ?? raw?.completion_tokens_details?.reasoning_tokens), total_tokens: count(raw?.total_tokens),
})
const LIMITS = Object.freeze({ calls: 4, inputTokens: 500000, outputTokens: 2048, maxOutputPerCall: 512, concurrency: 1 })
const EXPECTED = Object.freeze({
  directTool: 'run_code', runCodeRequiredArgs: ['code', 'description'],
  currentRequiredArgs: { bash: ['command', 'description'], create_goal: ['objective'], ask_user_question: ['questions'] },
  history: { callId: 'call_sdk_golden_01', records: 7, status: 'read-only', checksum: 'ab12' },
})
const POLICY = 'This is an isolated documentation and recorded-protocol golden sample. Treat the completed synthetic tool result as immutable evidence. Do not execute tools. Answer the current question using the latest SDK and return only strict JSON.'
const QUESTION = 'Return exactly one JSON object with these keys: directTool (the only directly callable tool), runCodeRequiredArgs (all required transport arguments), currentRequiredArgs (an object mapping bash, create_goal, and ask_user_question to arrays of their required top-level SDK argument names, excluding optional fields), and history (callId copied from the recorded result originalCallId, records, status, checksum copied from that result). Preserve the argument order shown in the SDK. Return all values, no extra keys, no markdown and no tool call.'

export async function prepareSdkGolden() {
  const audit = JSON.parse(await readFile(AUDIT, 'utf8'))
  const certificate = JSON.parse(await readFile(CERTIFICATE, 'utf8'))
  const wireTools = JSON.parse(await readFile('D:/dsh-test/workspaces/usage-lab-20261001/tools-schema.private.json', 'utf8'))
  assert.equal(wireTools.length, 1)
  assert.equal(wireTools[0].function.name, 'run_code')
  const file = await open(audit.sourceSnapshot.journal, 'r')
  const systems = []
  try {
    for (const item of audit.systemBlocks) {
      const bytes = Buffer.alloc(item.compressedFrame.end - item.compressedFrame.start)
      await file.read(bytes, 0, bytes.length, item.compressedFrame.start)
      const event = zstdDecompressSync(bytes).toString('utf8').split('\n').filter(Boolean).map(JSON.parse).find(row => row.seq === item.seq)
      const full = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      const sdk = full.slice(item.sdk.startUtf16, item.sdk.endUtf16)
      assert.equal(hash(sdk), item.sdk.sha256)
      assert.equal(findSdkSection(sdk).status, 'valid')
      systems.push({ id: 'sdk-golden-' + item.seq, role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: POLICY + '\n\n' + sdk + '\n\nGolden policy suffix: retain recorded facts.' }] })
    }
  } finally { await file.close() }
  const history = [
    { id: 'golden-history-user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Recorded synthetic task: return the fixed read-only fixture facts.' }] },
    { id: 'golden-history-assistant', role: 'assistant', source: { kind: 'model' }, content: [
      { type: 'reasoning', text: 'SYNTHETIC_RECORDED_REASONING=retain-tool-result-facts' },
      { type: 'tool-call', id: EXPECTED.history.callId, name: 'run_code', arguments: JSON.stringify({ code: 'return {records:7,status:"read-only",checksum:"ab12"};', description: 'Return synthetic fixture facts without executing tools' }) },
    ] },
    { id: 'golden-history-result', role: 'tool', toolCallId: EXPECTED.history.callId, source: { kind: 'tool' }, content: [{ type: 'text', text: JSON.stringify({ originalCallId: EXPECTED.history.callId, fixture: 'CTX-SDK-01', records: 7, status: 'read-only', checksum: 'ab12' }) }] },
  ]
  const messages = [...systems.slice(0, 2), ...history, ...systems.slice(2), { role: 'user', content: [{ type: 'text', text: QUESTION }] }]
  const options = { sessionId: 'context-sdk-01-isolated', messages, tools: wireTools.map(item => item.function) }
  const projected = projectSdkRetention(options, { mode: 'apply', policy: 'latest', compatibilityManifest: certificate })
  assert.equal(projected.audit.removedCopies, 4)
  assert.equal(projected.audit.compatibilityCertificate.verified, true)
  for (const message of history) assert.equal(projected.options.messages.find(item => item.id === message.id), message)
  return { options, projected: projected.options, projectionAudit: projected.audit, wireTools, history,
    source: { auditSha256: hash(await readFile(AUDIT)), certificateSha256: hash(await readFile(CERTIFICATE)), sdkHashes: audit.systemBlocks.map(row => row.sdk.sha256), seqs: audit.systemBlocks.map(row => row.seq), frameCount: audit.systemBlocks.length } }
}

function toWire(messages) {
  return messages.map(message => {
    const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
    if (message.role === 'assistant') return {
      role: 'assistant', content: text || null,
      reasoning_content: message.content.filter(block => block.type === 'reasoning').map(block => block.text).join(''),
      tool_calls: message.content.filter(block => block.type === 'tool-call').map(block => ({ id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } })),
    }
    return { role: message.role, content: text, ...(message.role === 'tool' ? { tool_call_id: message.toolCallId } : {}) }
  })
}

export function validateSdkGolden(text) {
  try {
    const answer = JSON.parse(text)
    assert.deepEqual(answer, EXPECTED)
    return { passed: true, answer, reasons: [] }
  } catch { return { passed: false, answer: null, reasons: ['strict-sdk-args-or-recorded-facts-mismatch'], responseSha256: hash(String(text)), responseBytes: Buffer.byteLength(String(text)) } }
}

export async function runRealSdkGolden({ postRepair = false } = {}) {
  const ledger = join(ROOT, postRepair ? 'post-repair-calls.jsonl' : 'calls.jsonl')
  const reportPath = join(ROOT, postRepair ? 'post-repair-report.json' : 'report.json')
  const limits = postRepair ? { ...LIMITS, calls: 2, inputTokens: 250000, outputTokens: 1024 } : LIMITS
  let original = null
  if (postRepair) {
    const originalReport = await readFile(join(ROOT, 'report.json'))
    const originalCalls = await readFile(join(ROOT, 'calls.jsonl'))
    original = { report: JSON.parse(originalReport), reportSha256: hash(originalReport), callsSha256: hash(originalCalls) }
    if (original.report.failure !== 'provider-http-403' || original.report.totalCalls !== 3 || original.report.completedPairs !== 1) throw new Error('sdk-golden-post-repair-original-state-mismatch')
  }
  if (await access(ledger).then(() => true, () => false)) throw new Error('sdk-golden-ledger-exists-refuse-rerun')
  const require = createRequire('D:/dsh-test/home/profiles/web/node_modules/@deepseek-ai/cordis/package.json')
  const yaml = require('yaml')
  const config = yaml.parseDocument(await readFile('D:/dsh-test/home/profiles/web/cordis.patch.yml', 'utf8'), { logLevel: 'silent' }).toJS()
  let route
  const visit = value => { if (!value || typeof value !== 'object') return; if (value.providers?.opencodego) route = value.providers.opencodego; Object.values(value).forEach(visit) }
  visit(config)
  if (route?.baseURL !== 'http://127.0.0.1:8788/v1' || route?.api !== 'openai-completions' || !route.models?.some(model => model.id === 'deepseek-v4.1-flash')) throw new Error('sdk-golden-provider-route-drift')
  const key = process.env.OPENCODEGO_API_KEY || yaml.parse(await readFile('D:/dsh-test/home/.credentials.yaml', 'utf8'))?.refs?.OPENCODEGO_API_KEY
  if (typeof key !== 'string' || !key) throw new Error('sdk-golden-key-unavailable')
  const fixture = await prepareSdkGolden()
  await mkdir(ROOT, { recursive: true })
  await writeFile(ledger, '', { flag: 'wx' })
  await writeFile(join(ROOT, postRepair ? 'post-repair-fixture.json' : 'fixture.json'), JSON.stringify({ version: 1, policy: POLICY, question: QUESTION, expected: EXPECTED, history: fixture.history,
    source: fixture.source, projectionAudit: fixture.projectionAudit, limitation: 'Only synthetic recorded facts and selected real SDK argument documentation; no dangerous tool is executed.' }, null, 2) + '\n')
  const report = { version: 1, id: postRepair ? 'CTX-SDK-01-post-repair' : 'CTX-SDK-01', status: 'running', limits, source: fixture.source, moduleSha256: hash(await readFile(MODULE)),
    route: { provider: 'opencodego', model: 'deepseek-v4.1-flash', api: 'openai-completions', thinking: 'disabled' },
    projectionAudit: fixture.projectionAudit, calls: [], comparison: [], failure: null,
    limitation: 'Two paired documentation/recorded-protocol samples using direct isolated HTTP; not live DSH HMR, tool execution, or all-task quality.' }
  if (postRepair) report.postRepair = { userReportedRelayFixed: true, originalReportSha256: original.reportSha256,
    originalCallsSha256: original.callsSha256, originalFailureRetained: 'provider-http-403',
    comparisonCaveat: 'Repair changed relay/cache conditions; latency and cache values must be reported by batch.' }
  const state = { calls: 0, inputTokens: 0, outputTokens: 0 }
  const measuredPrompts = new Map()
  if (postRepair) for (const row of original.report.calls) if (row.quality?.passed && row.usage?.prompt_tokens !== null) measuredPrompts.set(row.requestSha256, row.usage.prompt_tokens)
  try {
    for (const [index, arm] of (postRepair ? ['latest', 'full'] : ['full', 'latest', 'latest', 'full']).entries()) {
      if (hash(await readFile(MODULE)) !== report.moduleSha256) throw new Error('sdk-golden-module-drift')
      if (hash(await readFile(CERTIFICATE)) !== fixture.source.certificateSha256) throw new Error('sdk-golden-certificate-drift')
      const body = { model: 'deepseek-v4.1-flash', messages: toWire(arm === 'full' ? fixture.options.messages : fixture.projected.messages), tools: fixture.wireTools,
        tool_choice: 'none', temperature: 0, max_tokens: LIMITS.maxOutputPerCall, stream: false, thinking: { type: 'disabled' } }
      const serialized = JSON.stringify(body)
      const requestSha256 = hash(serialized)
      if (postRepair && !original.report.calls.some(row => row.arm === arm && row.quality?.passed && row.requestSha256 === requestSha256)) throw new Error('sdk-golden-post-repair-request-drift')
      const inputReserve = measuredPrompts.has(requestSha256) ? measuredPrompts.get(requestSha256) + 256 : Math.ceil(serialized.length / 3)
      if (state.calls >= limits.calls || state.inputTokens + inputReserve > limits.inputTokens || state.outputTokens + limits.maxOutputPerCall > limits.outputTokens) throw new Error('sdk-golden-budget-reservation-refused')
      const row = { id: `${report.id}-${index + 1}-${arm}`, arm, pair: postRepair ? 2 : Math.floor(index / 2) + 1, requestSha256, inputReserve, requestBytes: Buffer.byteLength(serialized), startedAt: new Date().toISOString() }
      const start = Date.now()
      state.calls++
      await appendFile(ledger, JSON.stringify({ ...row, event: 'request-start' }) + '\n')
      try {
        const response = await fetch(route.baseURL + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'x-opencode-session': postRepair ? 'context-sdk-01-post-repair-20261001' : 'context-sdk-01-isolated-20261001' }, body: serialized, signal: AbortSignal.timeout(90000) })
        row.httpStatus = response.status
        if (!response.ok) { await response.body?.cancel(); throw new Error('provider-http-' + response.status) }
        const data = await response.json()
        const message = data.choices?.[0]?.message
        row.responseModel = data.model ?? null
        row.finishReason = data.choices?.[0]?.finish_reason ?? null
        row.usage = normalizeUsage(data.usage)
        row.latencyMs = Date.now() - start
        row.quality = validateSdkGolden(message?.content ?? '')
        row.toolCallCount = message?.tool_calls?.length ?? 0
        row.responseReasoningBytes = Buffer.byteLength(message?.reasoning_content ?? '')
        state.inputTokens += row.usage.prompt_tokens ?? inputReserve
        state.outputTokens += row.usage.completion_tokens ?? LIMITS.maxOutputPerCall
        if (row.usage.prompt_tokens !== null) measuredPrompts.set(requestSha256, row.usage.prompt_tokens)
        report.calls.push(row)
        await appendFile(ledger, JSON.stringify({ ...row, event: 'request-complete' }) + '\n')
        console.log(JSON.stringify({ id: row.id, usage: row.usage, actualOutput: row.quality.answer, qualityPassed: row.quality.passed, latencyMs: row.latencyMs }))
        if (row.finishReason !== 'stop' || row.toolCallCount !== 0) throw new Error('sdk-golden-unexpected-finish-or-tool-call')
        if (row.usage.reasoning_tokens !== 0 || row.responseReasoningBytes !== 0) throw new Error('sdk-golden-thinking-disabled-not-confirmed')
        if (!row.quality.passed) throw new Error('sdk-golden-quality-failed')
        if (state.inputTokens > limits.inputTokens || state.outputTokens > limits.outputTokens) throw new Error('sdk-golden-actual-budget-exceeded')
      } catch (error) {
        if (!report.calls.some(call => call.id === row.id)) {
          row.latencyMs = Date.now() - start
          row.error = /^provider-http-\d+$/.test(error?.message) ? error.message : 'provider-call-failed'
          report.calls.push(row)
          await appendFile(ledger, JSON.stringify({ ...row, event: 'request-failed' }) + '\n')
        }
        throw error
      }
    }
  } catch (error) { report.failure = /^sdk-golden-[a-z-]+$|^provider-http-\d+$/.test(error?.message) ? error.message : 'sdk-golden-call-failed' }
  report.status = report.failure ? 'failed' : 'passed'
  report.totalCalls = state.calls
  report.unknownUsageCallIds = report.calls.filter(row => !row.usage || row.usage.prompt_tokens === null || row.usage.completion_tokens === null).map(row => row.id)
  report.usageComplete = report.unknownUsageCallIds.length === 0
  report.knownInputTokens = report.calls.reduce((sum, row) => sum + (row.usage?.prompt_tokens ?? 0), 0)
  report.knownOutputTokens = report.calls.reduce((sum, row) => sum + (row.usage?.completion_tokens ?? 0), 0)
  report.totalInputTokens = report.usageComplete ? report.knownInputTokens : null
  report.totalOutputTokens = report.usageComplete ? report.knownOutputTokens : null
  for (const pair of [1, 2]) {
    const full = report.calls.find(row => row.pair === pair && row.arm === 'full')
    const latest = report.calls.find(row => row.pair === pair && row.arm === 'latest')
    if (full?.usage && latest?.usage) report.comparison.push({ pair, qualityPassed: full.quality.passed && latest.quality.passed,
      promptTokenDelta: latest.usage.prompt_tokens - full.usage.prompt_tokens, outputTokenDelta: latest.usage.completion_tokens - full.usage.completion_tokens,
      latencyDeltaMs: latest.latencyMs - full.latencyMs, monetarySavings: null })
  }
  report.requestedPairs = postRepair ? 1 : 2
  report.completedPairs = report.comparison.filter(pair => pair.qualityPassed).length
  if (postRepair) {
    report.originalEvidenceUnchanged = hash(await readFile(join(ROOT, 'report.json'))) === original.reportSha256
      && hash(await readFile(join(ROOT, 'calls.jsonl'))) === original.callsSha256
    const allCalls = [...original.report.calls, ...report.calls]
    const unknownUsageCallIds = allCalls.filter(row => !row.usage || row.usage.prompt_tokens === null || row.usage.completion_tokens === null).map(row => row.id)
    const summary = { version: 1, id: 'CTX-SDK-01-combined', status: report.failure ? 'post-repair-failed' : 'successful-golden-pairs-complete-with-retained-failed-attempt',
      successfulPairs: original.report.completedPairs + report.completedPairs, failedAttempts: allCalls.filter(row => row.httpStatus !== 200).length,
      totalHttpAttempts: allCalls.length, knownInputTokens: allCalls.reduce((sum, row) => sum + (row.usage?.prompt_tokens ?? 0), 0),
      knownOutputTokens: allCalls.reduce((sum, row) => sum + (row.usage?.completion_tokens ?? 0), 0),
      usageComplete: unknownUsageCallIds.length === 0, totalInputTokens: null, totalOutputTokens: null, unknownUsageCallIds,
      originalEvidenceUnchanged: report.originalEvidenceUnchanged, originalReportSha256: original.reportSha256, originalCallsSha256: original.callsSha256,
      comparisons: [...original.report.comparison.map(pair => ({ ...pair, batch: 'pre-repair' })), ...report.comparison.map(pair => ({ ...pair, batch: 'post-repair' }))],
      calls: allCalls.map(row => ({ id: row.id, arm: row.arm, pair: row.pair, batch: row.id.includes('post-repair') ? 'post-repair' : 'pre-repair', httpStatus: row.httpStatus,
        usage: row.usage ?? null, latencyMs: row.latencyMs, qualityPassed: row.quality?.passed ?? null, actualOutput: row.quality?.answer ?? null })),
      caveat: 'The original 403 remains a failed attempt with unknown usage; relay repair changes cache/latency conditions. Two small documentation/recorded-protocol pairs do not prove all-task quality or live HMR.' }
    await writeFile(join(ROOT, 'combined-post-repair-report.json'), JSON.stringify(summary, null, 2) + '\n')
    if (!report.originalEvidenceUnchanged && !report.failure) { report.status = 'failed'; report.failure = 'sdk-golden-original-evidence-changed' }
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ report: reportPath, status: report.status, calls: report.totalCalls, inputTokens: report.totalInputTokens, outputTokens: report.totalOutputTokens, failure: report.failure }))
  if (report.failure) throw new Error(report.failure)
  return report
}

if (process.argv.includes('--post-repair')) await runRealSdkGolden({ postRepair: true }).catch(error => { console.error(error.message); process.exitCode = 1 })
else if (process.argv.includes('--real')) await runRealSdkGolden().catch(error => { console.error(error.message); process.exitCode = 1 })
else {
  test('golden fixture uses five exact frame SDKs and preserves recorded protocol identity', async () => {
    const fixture = await prepareSdkGolden()
    assert.equal(fixture.source.frameCount, 5)
    assert.equal(fixture.projectionAudit.removedCopies, 4)
    const full = toWire(fixture.options.messages)
    const latest = toWire(fixture.projected.messages)
    assert.deepEqual(full.filter(message => message.role !== 'system'), latest.filter(message => message.role !== 'system'))
    assert.ok(full.some(message => message.reasoning_content?.startsWith('SYNTHETIC_RECORDED_REASONING=')))
  })
  test('strict golden validator rejects wrong tool args, wrong recorded facts, extra keys or markdown', () => {
    assert.equal(validateSdkGolden(JSON.stringify(EXPECTED)).passed, true)
    assert.equal(validateSdkGolden(JSON.stringify({ ...EXPECTED, extra: true })).passed, false)
    assert.equal(validateSdkGolden(JSON.stringify({ ...EXPECTED, history: { ...EXPECTED.history, records: 8 } })).passed, false)
    assert.equal(validateSdkGolden(JSON.stringify({ ...EXPECTED, currentRequiredArgs: { ...EXPECTED.currentRequiredArgs, bash: ['command'] } })).passed, false)
    assert.equal(validateSdkGolden('```json\n' + JSON.stringify(EXPECTED) + '\n```').passed, false)
  })
}
