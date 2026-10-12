import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { apply, createObservation, projectMessages, renderHandle, verifyArchive, HANDLE_VERSION, inject } from '../home/profiles/web/plugins/observation-pack-v2.mjs'
import { parseObservationSource } from '../home/profiles/web/plugins/team-v13-observation-source.mjs'
import { createToolResultMessage } from '../home/profiles/web/node_modules/@deepseek-ai/dsh-llm/lib/types/message.js'
import { normalizeUsage, validateAnswer, estimateInput, assertBudget } from '../tools/usage-lab.mjs'
import { apply as applyProjectionBridge } from '../home/profiles/web/plugins/request-message-projection.mjs'
import { observeStream } from '../home/profiles/web/plugins/request-usage-ledger.mjs'

const fixture = JSON.parse(readFileSync('D:/dsh-test/workspaces/usage-lab-20261001/fixture.json', 'utf8'))
const hash = value => createHash('sha256').update(value).digest('hex')

function observation(root, text = fixture.text, callId = 'lineage-call') {
  const obs = createObservation({ toolName: 'synthetic-log', callId, blocks: [{ type: 'text', text }], spillDir: root, previewBytes: 1024, evidenceChars: 2200 })
  assert.ok(obs)
  obs.fullSends = 0
  return obs
}

test('current handle carries original lines 2/173/399 without an overlay', () => {
  const root = mkdtempSync(join(tmpdir(), 'op-lineage-'))
  try {
    const obs = observation(root)
    const handle = renderHandle(obs)
    const evidence = handle.split('--- evidence lines (L<number> is the original 1-based log line) ---\n')[1].split('\n[')[0]
    assert.equal(evidence, fixture.critical.map(q => `L${q.line}: ${q.text}`).join('\n'))
    assert.match(evidence, /L173: ERROR: UNIQUE_FAILURE E_FIXTURE_173 file=src\/cache.ts:41/)
    const metadata = parseObservationSource(handle)
    assert.deepEqual(metadata.lineNumbers, [2, 173, 399])
    assert.equal(metadata.archivePath, obs.filePath)
    assert.equal(metadata.sha256, hash(fixture.text))
    assert.equal(readFileSync(obs.filePath, 'utf8'), fixture.text)
    assert.equal(verifyArchive(obs), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('evidence retains whitespace, CRLF source line numbers and order', () => {
  const root = mkdtempSync(join(tmpdir(), 'op-lineage-crlf-'))
  try {
    const text = 'start\r\n  ERROR: source=file.js:99  \r\n\r\nWARN: final blocked\r\nend'
    const handle = renderHandle(observation(root, text))
    assert.match(handle, /L2:   ERROR: source=file.js:99  \nL4: WARN: final blocked/)
    assert.deepEqual(parseObservationSource(handle).lineNumbers, [2, 4])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('stale verified cached handles rebuild by version without deleting archives', () => {
  const root = mkdtempSync(join(tmpdir(), 'op-lineage-cache-'))
  try {
    const obs = observation(root)
    const msg = createToolResultMessage({ callId: obs.callId, content: [{ type: 'text', text: fixture.text }], isError: false })
    const map = new Map([[obs.callId, obs]])
    assert.equal(projectMessages([msg], map).changed, 1)
    assert.equal(obs.text, undefined)
    const signature = obs.verifiedSignature
    obs.cachedHandle = 'old unnumbered cached handle'
    obs.cachedHandleVersion = HANDLE_VERSION - 1
    const rebuilt = projectMessages([msg], map)
    assert.equal(rebuilt.changed, 1)
    assert.match(rebuilt.messages[0].content[0].text, /L173: ERROR/)
    assert.equal(obs.cachedHandleVersion, HANDLE_VERSION)
    assert.equal(obs.verifiedSignature, signature)
    assert.equal(verifyArchive(obs), true)
    const cached = obs.cachedHandle
    assert.equal(projectMessages([msg], map).messages[0].content[0].text, cached)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('actual frozen current tool messages and legacy toolResult preserve identity and source', () => {
  const root = mkdtempSync(join(tmpdir(), 'op-lineage-role-'))
  try {
    for (const role of ['tool', 'toolResult']) {
      const obs = observation(root, fixture.text, role + '-call')
      const current = createToolResultMessage({ callId: obs.callId, content: [{ type: 'text', text: fixture.text }], isError: false })
      const msg = role === 'tool' ? current : Object.freeze({ ...current, role })
      const projected = projectMessages([msg], new Map([['session-a\0' + obs.callId, obs]]), 'session-a')
      assert.equal(projected.changed, 1)
      assert.equal(projected.messages[0].role, role)
      assert.equal(projected.messages[0].id, msg.id)
      assert.equal(projected.messages[0].source, msg.source)
      assert.equal(msg.content[0].text, fixture.text)
      assert.match(projected.messages[0].content[0].text, /L173: ERROR/)
      const failed = { ...msg, isError: true }
      assert.equal(projectMessages([failed], new Map([[obs.callId, obs]])).changed, 0)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('current tool delayed sends keep the original contract and session isolation', () => {
  const root = mkdtempSync(join(tmpdir(), 'op-lineage-delay-'))
  try {
    const obs = observation(root)
    obs.fullSends = 2
    const msg = createToolResultMessage({ callId: obs.callId, content: [{ type: 'text', text: fixture.text }], isError: false })
    const map = new Map([['session-a\0' + obs.callId, obs]])
    assert.equal(projectMessages([msg], map, 'session-other').changed, 0)
    assert.equal(projectMessages([msg], map, 'session-a').changed, 0)
    assert.equal(projectMessages([msg], map, 'session-a').changed, 0)
    assert.equal(projectMessages([msg], map, 'session-a').changed, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('canonical mixed/unknown content and error messages fail open without losing blocks or counting savings', () => {
  const root = mkdtempSync(join(tmpdir(), 'op-lineage-mixed-'))
  try {
    const cases = [
      [{ type: 'image', source: { kind: 'url', url: 'https://fixture.invalid/image.png' } }],
      [{ type: 'file', name: 'fixture.txt', content: 'keep-this-file-block' }],
      [{ type: 'future-block', payload: 'keep-unknown-payload' }],
      [{ type: 'text', text: null }],
    ]
    for (const [index, extra] of cases.entries()) {
      const obs = observation(root, fixture.text, 'mixed-' + index)
      const message = createToolResultMessage({ callId: obs.callId, content: [{ type: 'text', text: fixture.text }, ...extra], isError: false })
      const input = Object.freeze([message])
      const result = projectMessages(input, new Map([[obs.callId, obs]]))
      assert.equal(result.messages, input)
      assert.equal(result.messages[0], message)
      assert.deepEqual(result.messages[0].content, [{ type: 'text', text: fixture.text }, ...extra])
      assert.equal(result.changed, 0)
      assert.equal(result.savedTokens, 0)
      assert.equal(obs.sentCount, 0)
    }
    const obs = observation(root, fixture.text, 'failed-text-only')
    const failed = createToolResultMessage({ callId: obs.callId, content: [{ type: 'text', text: fixture.text }], isError: true })
    const input = Object.freeze([failed])
    const result = projectMessages(input, new Map([[obs.callId, obs]]))
    assert.equal(result.messages, input)
    assert.equal(result.changed, 0)
    assert.equal(result.savedTokens, 0)
    assert.equal(obs.sentCount, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('bridge projects frozen current options and leaves native stream mutation hooks absent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'op-lineage-hook-'))
  try {
    const listeners = new Map()
    let project
    let onDispatch
    let unregistered = false
    const ctx = {
      on: (event, fn) => listeners.set(event, fn),
      requestMessageProjection: { register(name, callback, options) {
        assert.equal(name, 'observation-pack')
        assert.equal(options.order, 20)
        project = callback
        onDispatch = options.onDispatch
        return () => { unregistered = true }
      } },
    }
    apply(ctx, { maxInlineBytes: 100, fullSends: 0, spillDir: root, telemetryDir: root })
    await listeners.get('tools/post-execute')({ name: 'synthetic-log', callId: 'hook-call', agent: { session: { id: 'hook-session' } } }, { isError: false, content: [{ type: 'text', text: fixture.text }] }, async () => ({ kind: 'accept' }))
    const msg = createToolResultMessage({ callId: 'hook-call', content: [{ type: 'text', text: fixture.text }], isError: false })
    const frozen = Object.freeze({ sessionId: 'hook-session', messages: Object.freeze([msg]) })
    const transformed = project(frozen)
    assert.match(transformed.messages[0].content[0].text, /L173: ERROR/)
    assert.equal(frozen.messages[0].content[0].text, fixture.text)
    assert.equal(transformed.messages[0].id, msg.id)
    assert.equal(transformed.messages[0].source, msg.source)
    assert.equal(ctx.observationPackStats().projectionUnavailable, 0)
    assert.equal(ctx.observationPackStats().replaced, 0)
    onDispatch({ options: { ...frozen, messages: transformed.messages }, inputOptions: frozen, result: transformed,
      receipt: { requestId: 'hook-fixture-request', stage: 'handed-to-adapter' } })
    assert.equal(ctx.observationPackStats().replaced, 1)
    const mixed = createToolResultMessage({ callId: 'hook-call', content: [{ type: 'text', text: fixture.text }, { type: 'image', source: { kind: 'url', url: 'https://fixture.invalid/image.png' } }], isError: false })
    const frozenMixed = Object.freeze({ sessionId: 'hook-session', messages: Object.freeze([mixed]) })
    assert.equal(project(frozenMixed).messages, frozenMixed.messages)
    assert.equal(ctx.observationPackStats().replaced, 1)
    assert.equal(listeners.has('llm/stream'), false)
    assert.deepEqual(inject, ['llm', 'requestMessageProjection'])
    listeners.get('dispose')()
    assert.equal(unregistered, true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('real Cordis bridge sends current tool handle to adapter on third request and usage ledger sees identical projection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'op-lineage-native-'))
  const require = createRequire('D:/dsh-test/home/profiles/web/package.json')
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
  const llmModule = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href)
  const ctx = new Context()
  const llm = new llmModule.LlmRuntime(ctx)
  const captures = []
  const ledgerRecords = []
  const adapter = new class extends llmModule.LlmAdapter {
    providerInfo(provider) { return { id: provider, name: provider } }
    async prepareCall(provider, model) {
      return { model: { provider, id: model, name: model }, stream(options) {
        captures.push(options)
        return (async function* () {
          yield { type: 'usage', usage: { inputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2, reasoningTokens: 0, totalTokens: 7 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      } }
    }
  }()
  const releaseAdapter = llm.registerAdapter(['lineage-fixture'], adapter)
  const disposeBridge = await applyProjectionBridge(ctx)
  const unhookLedger = ctx.on('llm/stream', (options, next) => observeStream(options, next, { record: record => ledgerRecords.push(record) }), { global: true })
  try {
    apply(ctx, { maxInlineBytes: 100, fullSends: 2, previewBytes: 1024, evidenceChars: 2200, spillDir: root, telemetryDir: root })
    const sessionId = 'obs-line-native-session'
    const callId = 'obs-line-native-call'
    const decision = await ctx.waterfall(ctx, 'tools/post-execute', { name: 'synthetic-log', callId, agent: { id: sessionId, session: { id: sessionId } } }, { isError: false, content: [{ type: 'text', text: fixture.text }] }, async () => ({ kind: 'accept' }))
    assert.equal(decision.kind, 'accept')
    const tool = llmModule.createToolResultMessage({ callId, content: [{ type: 'text', text: fixture.text }], isError: false })
    assert.equal(tool.role, 'tool')
    const prefix = llmModule.createSystemMessage('stable-lineage-prefix')
    for (let index = 0; index < 3; index++) {
      const prepared = await llm.prepareCall({ provider: 'lineage-fixture', model: 'fixture-model' })
      const request = Object.freeze(llmModule.markAgentLoopRequest({ ...prepared.config, provider: 'lineage-fixture', model: 'fixture-model', sessionId, messages: Object.freeze([prefix, tool]), signal: new AbortController().signal }))
      for await (const chunk of prepared.stream(request)) assert.ok(chunk)
      assert.equal(request.messages[1].content[0].text, fixture.text)
      assert.equal(llmModule.isAgentLoopRequest(captures[index]), true)
      assert.equal(captures[index].signal, request.signal)
      assert.equal(captures[index].messages[1].id, tool.id)
      assert.deepEqual(captures[index].messages[1].source, tool.source)
      assert.equal(captures[index].messages[0].content[0].text, 'stable-lineage-prefix')
    }
    assert.equal(captures.length, 3)
    assert.equal(captures[0].messages[1].content[0].text, fixture.text)
    assert.equal(captures[1].messages[1].content[0].text, fixture.text)
    const handle = captures[2].messages[1].content[0].text
    assert.match(handle, /L173: ERROR: UNIQUE_FAILURE E_FIXTURE_173 file=src\/cache.ts:41/)
    assert.equal(captures[2].messages[1].role, 'tool')
    assert.equal(ctx.observationPackStats().replaced, 1)
    assert.equal(ctx.observationPackStats().archived, 1)
    const mixed = llmModule.createToolResultMessage({ callId, content: [{ type: 'text', text: fixture.text }, { type: 'image', source: { kind: 'url', url: 'https://fixture.invalid/image.png' } }], isError: false })
    const failed = llmModule.createToolResultMessage({ callId, content: [{ type: 'text', text: fixture.text }], isError: true })
    for (const message of [mixed, failed]) {
      const prepared = await llm.prepareCall({ provider: 'lineage-fixture', model: 'fixture-model' })
      const request = Object.freeze(llmModule.markAgentLoopRequest({ ...prepared.config, provider: 'lineage-fixture', model: 'fixture-model', sessionId, messages: Object.freeze([prefix, message]), signal: new AbortController().signal }))
      for await (const chunk of prepared.stream(request)) assert.ok(chunk)
      assert.deepEqual(captures.at(-1).messages[1].content, message.content)
      assert.equal(captures.at(-1).messages[1].isError, message.isError)
      assert.equal(captures.at(-1).messages[1].id, message.id)
    }
    assert.equal(ctx.observationPackStats().replaced, 1)
    const starts = ledgerRecords.filter(row => row.event === 'start')
    const terminals = ledgerRecords.filter(row => row.event === 'terminal')
    assert.equal(starts.length, 5)
    assert.equal(terminals.length, 5)
    assert.ok(starts.every(row => row.sessionId === sessionId))
    assert.equal(starts[0].payload.categories.toolResult.items, 1)
    assert.equal(starts[1].payload.categories.toolResult.items, 1)
    assert.equal(starts[0].payload.categories.observationHandle.items, 0)
    assert.equal(starts[2].payload.categories.observationHandle.items, 1)
    assert.equal(starts[2].payload.categories.observationHandle.bytes, Buffer.byteLength(handle))
    assert.equal(starts[3].payload.categories.observationHandle.items, 0)
    assert.equal(starts[4].payload.categories.observationHandle.items, 0)
    assert.ok(terminals.every(row => row.status === 'success' && row.usage.totalTokens === 7))
    const audit = ctx.requestMessageProjection.audit()
    assert.equal(audit.length, 5)
    assert.deepEqual(audit.map(row => row.transforms[0].status), ['unchanged', 'unchanged', 'applied', 'skipped-unrecognized-request', 'unchanged'])
    const artifactRoot = process.env.DSH_REQUEST_STAGING === '1' ? join(root, 'runtime-evidence') : 'D:/dsh-test/workspaces/usage-lab-20261001/obs-line-01'
    mkdirSync(artifactRoot, { recursive: true })
    writeFileSync(join(artifactRoot, 'runtime-integration.json'), JSON.stringify({
      case: 'OBS-LINE-01 current core integration', passed: true, providerCalls: 0, adapter: 'in-process fixture adapter on real Cordis/LlmRuntime',
      sourceSha256: hash(readFileSync(process.env.DSH_REQUEST_PLUGIN_ROOT
        ? join(process.env.DSH_REQUEST_PLUGIN_ROOT, 'observation-pack-v2.mjs') : 'D:/dsh-test/home/profiles/web/plugins/observation-pack-v2.mjs')),
      sessionId, canonicalRole: tool.role, adapterDispatches: captures.length, unchangedFullSends: 2, thirdIsHandle: true,
      exactLineNumbers: parseObservationSource(handle).lineNumbers, handleSha256: hash(handle), originalFixtureSha256: hash(fixture.text),
      ledgerStarts: starts.length, ledgerTerminals: terminals.length, thirdLedgerHandleBytes: starts[2].payload.categories.observationHandle.bytes,
      mixedContentPreserved: true, errorContentPreserved: true, additionalProviderCalls: 0,
      nativeImageProtection: 'Bridge fail-open retains the complete image request; direct OP transform mixed-content guard is independently verified.',
      stats: ctx.observationPackStats(), bridgeAudit: audit, liveDeployment: false,
    }, null, 2) + '\n')
    const goldenPath = join(artifactRoot, 'report.json')
    if (existsSync(goldenPath)) {
      const golden = JSON.parse(readFileSync(goldenPath, 'utf8'))
      writeFileSync(join(artifactRoot, 'source-update.json'), JSON.stringify({
        goldenReportSha256: hash(readFileSync(goldenPath)), goldenSourceSha256: golden.sourceSha256,
        finalModuleSha256: hash(readFileSync('D:/dsh-test/home/profiles/web/plugins/observation-pack-v2.mjs')),
        change: 'Post-golden fail-open guard: mixed/nontext/unknown blocks are preserved. Text-only lineage format is unchanged.',
        verification: 'focused tests and real Cordis/LlmRuntime fixture-adapter integration; no new provider validation',
        providerCallsAdded: 0, goldenCallsRecomputed: false, originalGoldenCalls: golden.totalCalls,
      }, null, 2) + '\n')
    }
  } finally {
    unhookLedger()
    await disposeBridge()
    releaseAdapter()
    rmSync(root, { recursive: true, force: true })
  }
})

export async function runRealObservationLineage() {
  const root = 'D:/dsh-test/workspaces/usage-lab-20261001/obs-line-01'
  const ledger = join(root, 'calls.jsonl')
  if (existsSync(ledger)) throw new Error('real-lineage-ledger-exists-refuse-rerun')
  const require = createRequire('D:/dsh-test/home/profiles/web/node_modules/@deepseek-ai/cordis/package.json')
  const yaml = require('yaml')
  const config = yaml.parseDocument(readFileSync('D:/dsh-test/home/profiles/web/cordis.patch.yml', 'utf8'), { logLevel: 'silent' }).toJS()
  let route
  const visit = value => { if (!value || typeof value !== 'object') return; if (value.providers?.opencodego) route = value.providers.opencodego; for (const child of Object.values(value)) visit(child) }
  visit(config)
  if (route?.baseURL !== 'http://127.0.0.1:8788/v1' || route?.api !== 'openai-completions' || !route.models?.some(model => model.id === 'deepseek-v4.1-flash')) throw new Error('lineage-provider-route-drift')
  const key = process.env.OPENCODEGO_API_KEY || yaml.parse(readFileSync('D:/dsh-test/home/.credentials.yaml', 'utf8'))?.refs?.OPENCODEGO_API_KEY
  if (typeof key !== 'string' || !key) throw new Error('lineage-api-key-unavailable')
  mkdirSync(root, { recursive: true })
  const obs = observation(join(root, 'archive'))
  const message = createToolResultMessage({ callId: obs.callId, content: [{ type: 'text', text: fixture.text }], isError: false })
  const projected = projectMessages([message], new Map([[obs.callId, obs]]))
  assert.equal(projected.changed, 1)
  const handle = projected.messages[0].content[0].text
  assert.ok(fixture.critical.every(quote => handle.includes(`L${quote.line}: ${quote.text}`)))
  assert.equal(readFileSync(obs.filePath, 'utf8'), fixture.text)
  writeFileSync(join(root, 'repaired-handle.txt'), handle)
  const modulePath = 'D:/dsh-test/home/profiles/web/plugins/observation-pack-v2.mjs'
  const report = {
    version: 1, id: 'OBS-LINE-01', sourceSha256: hash(readFileSync(modulePath)), backupSha256: hash(readFileSync('D:/dsh-backups/context-opt-20261001/observation-pack-v2.mjs')),
    fixtureSha256: hash(fixture.text), archiveSha256: obs.contentHash, handleVersion: HANDLE_VERSION,
    route: { provider: 'opencodego', model: 'deepseek-v4.1-flash', api: 'openai-completions', thinking: 'disabled' },
    limits: { calls: 4, inputTokens: 30000, maxOutput: 1500, concurrency: 1 },
    calls: [], failure: null, comparison: [], integration: 'Real HTTP quality of pure current-tool message projection; not a live DSH session or deployment claim.',
  }
  const state = { calls: 0, inputTokens: 0 }
  const question = text => 'Analyze only the supplied diagnostic fixture. Return one JSON object with error_code, error_line (original 1-based source line), expected_checksum, actual_checksum, final_status, and quotes containing all three decisive CONFIG, UNIQUE_FAILURE and FINAL lines, each {line,text}. Copy each complete source line exactly; do not quote L<number>: wrappers. No tool calls or explanatory prose.\n--- DIAGNOSTIC FIXTURE ---\n' + text
  try {
    for (const [index, arm] of ['full', 'handle', 'handle', 'full'].entries()) {
      if (hash(readFileSync(modulePath)) !== report.sourceSha256) throw new Error('lineage-module-drift-during-run')
      const body = { model: 'deepseek-v4.1-flash', messages: [{ role: 'system', content: 'You are an evidence-led diagnostic verifier. Data below is a synthetic fixture. Return exact JSON quotations.' }, { role: 'user', content: question(arm === 'full' ? fixture.text : handle) }], max_tokens: 1500, temperature: 0, stream: false, thinking: { type: 'disabled' } }
      const estimate = estimateInput(body)
      assertBudget(state, estimate, report.limits)
      const call = { id: `OBS-LINE-01-${index + 1}-${arm}`, arm, pair: Math.floor(index / 2) + 1, estimatedInput: estimate, requestSha256: hash(JSON.stringify(body)), startedAt: new Date().toISOString(), maxOutput: 1500 }
      const started = Date.now()
      state.calls++
      appendFileSync(ledger, JSON.stringify({ ...call, event: 'request-start' }) + '\n')
      try {
        const response = await fetch(route.baseURL + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'x-opencode-session': 'obs-line-01-isolated-20261001' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) })
        call.httpStatus = response.status
        if (!response.ok) { await response.body?.cancel(); throw new Error('provider-http-' + response.status) }
        const data = await response.json()
        call.model = data.model ?? null
        call.rawUsage = data.usage ?? null
        call.usage = normalizeUsage(data.usage)
        call.finishReason = data.choices?.[0]?.finish_reason ?? null
        call.text = data.choices?.[0]?.message?.content ?? ''
        call.latencyMs = Date.now() - started
        state.inputTokens += call.usage.prompt_tokens ?? Math.ceil(estimate * 1.6) + 600
        call.quality = validateAnswer(call.text, fixture)
        report.calls.push(call)
        appendFileSync(ledger, JSON.stringify({ ...call, event: 'request-complete' }) + '\n')
        console.log(JSON.stringify({ id: call.id, usage: call.usage, quality: call.quality, latencyMs: call.latencyMs }))
        if (call.finishReason !== 'stop') throw new Error('provider-finish-' + call.finishReason)
        if (call.usage.reasoning_tokens !== 0) throw new Error('thinking-disabled-not-confirmed')
        if (!call.quality.passed) throw new Error('strict-lineage-quality-failed')
        if (state.inputTokens > report.limits.inputTokens) throw new Error('actual-input-budget-exceeded')
      } catch (error) {
        if (!report.calls.some(row => row.id === call.id)) {
          call.latencyMs = Date.now() - started
          call.error = /^provider-http-\d+$/.test(error.message) ? error.message : 'provider-call-failed'
          call.rawUsage ??= null
          call.usage ??= normalizeUsage(null)
          report.calls.push(call)
          appendFileSync(ledger, JSON.stringify({ ...call, event: 'request-failed' }) + '\n')
        }
        throw error
      }
    }
  } catch (error) { report.failure = error.message }
  report.status = report.failure ? 'failed' : 'passed'
  report.totalInput = state.inputTokens
  report.totalCalls = state.calls
  for (const pair of [1, 2]) {
    const full = report.calls.find(row => row.pair === pair && row.arm === 'full')
    const compact = report.calls.find(row => row.pair === pair && row.arm === 'handle')
    if (full && compact) report.comparison.push({ pair, full: full.id, handle: compact.id, qualityPassed: full.quality?.passed === true && compact.quality?.passed === true, inputDelta: compact.usage.prompt_tokens - full.usage.prompt_tokens, outputDelta: compact.usage.completion_tokens - full.usage.completion_tokens, latencyDeltaMs: compact.latencyMs - full.latencyMs, monetarySavings: null })
  }
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ report: join(root, 'report.json'), status: report.status, calls: state.calls, inputTokens: state.inputTokens, failure: report.failure }))
  if (report.failure) throw new Error(report.failure)
  return report
}

if (process.argv.includes('--real')) await runRealObservationLineage()
