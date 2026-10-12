import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import { open } from 'node:fs/promises'
import { apply as bridgeApply } from '../home/profiles/web/plugins/request-message-projection.mjs'
import { apply as opApply } from '../home/profiles/web/plugins/observation-pack-v2.mjs'
import { projectSdkRetention, apply as sdkApply } from '../home/profiles/web/plugins/ptc-sdk-retention.mjs'
import { apply as ledgerApply, observeRequestBudget } from '../home/profiles/web/plugins/request-usage-ledger.mjs'
import { detectCacheAnomalies, readLedgerRequests } from '../home/profiles/web/plugins/team-v13-cache-monitor.mjs'
import { preStepBudget, DEFAULTS } from '../home/profiles/web/plugins/step-compaction-v4.mjs'
import { initializeNativeHost } from '../native-tests/native-host-fixture.mjs'

const profileRequire = createRequire(new URL('../home/profiles/web/package.json', import.meta.url))
const appRequire = createRequire(new URL('../app/package.json', import.meta.url))
const { Context } = await import(pathToFileURL(profileRequire.resolve('@deepseek-ai/cordis')).href)
const profile = await import(pathToFileURL(profileRequire.resolve('@deepseek-ai/dsh-llm')).href)
const canonicalApp = await import(pathToFileURL(appRequire.resolve('@deepseek-ai/dsh-llm')).href)
const appUrl = pathToFileURL(appRequire.resolve('@deepseek-ai/dsh-llm'))
appUrl.searchParams.set('fixture', 'request-plan-independent-official-brand')
const app = await import(appUrl.href)
const collect = async stream => { const out = []; for await (const chunk of stream) out.push(chunk); return out }
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fixture = JSON.parse(readFileSync('D:/dsh-test/workspaces/usage-lab-20261001/fixture.json', 'utf8'))
const usage = { inputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2, reasoningTokens: 1, totalTokens: 14 }

async function setup(module = profile, config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'request-plan-'))
  const ctx = new Context()
  const llm = await initializeNativeHost(ctx, () => new module.LlmRuntime(ctx))
  const captures = []
  const prepare = { count: 0 }
  const adapter = generation => new class extends module.LlmAdapter {
    providerInfo(provider) { return { id: provider, name: provider } }
    async prepareCall(provider, model) {
      prepare.count++
      return { model: { provider, id: model, name: model }, stream(options) {
        captures.push({ generation, options })
        return (async function* () { yield { type: 'usage', usage }; yield { type: 'finish', reason: { kind: 'stop' } } })()
      } }
    }
  }()
  const release = llm.registerAdapter(['fixture'], adapter('A'))
  const bridge = await bridgeApply(ctx, { ...config, resolveLlmModule: () => module })
  const request = extra => ({ provider: 'fixture', model: 'model', sessionId: 'isolated-session',
    messages: [module.createUserMessage({ content: [{ type: 'text', text: 'stable prefix' }], source: { kind: 'user' } })],
    signal: new AbortController().signal, ...extra })
  return { root, ctx, llm, captures, prepare, adapter, release, bridge, request,
    async dispose() { await bridge(); release(); rmSync(root, { recursive: true, force: true }) } }
}

test('pure preview skips legacy stateful transforms; final prepared plan is adopted once with byte/hash receipt', async () => {
  const s = await setup()
  try {
    let legacy = 0, pure = 0, dispatched = 0
    s.bridge.service.register('legacy', input => { legacy++; return { messages: input.messages } })
    const change = input => { pure++; return { messages: input.messages.map(m => ({ ...m, content: [{ type: 'text', text: 'short' }] })), privateText: 'secret-body', callback() {} } }
    s.bridge.service.register('pure', change, { preview: change, onDispatch({ receipt, result }) { dispatched++; assert.equal(typeof result.callback, 'function'); assert.equal(receipt.stage, 'handed-to-adapter') } })
    const original = Object.freeze(profile.markAgentLoopRequest(s.request()))
    for (let index = 0; index < 3; index++) {
      const preview = s.bridge.service.preview(original)
      assert.equal(preview.receipt.stage, 'preview')
      assert.equal(preview.receipt.transforms[0].status, 'skipped-no-pure-preview')
    }
    assert.equal(legacy, 0); assert.equal(dispatched, 0); assert.equal(s.prepare.count, 0)
    const plan = s.bridge.service.prepare(original)
    const count = pure
    const prepared = await s.llm.prepareCall({ provider: 'fixture', model: 'model' })
    await collect(prepared.stream(plan.options))
    assert.equal(pure, count); assert.equal(legacy, 1); assert.equal(dispatched, 1)
    assert.equal(s.captures[0].options, plan.options)
    const receipt = s.bridge.service.audit(original)
    assert.equal(receipt.requestId, plan.receipt.requestId)
    assert.equal(receipt.before.sha256, hash(original.messages))
    assert.equal(receipt.after.sha256, hash(plan.options.messages))
    assert.equal(receipt.before.bytes, Buffer.byteLength(JSON.stringify(original.messages)))
    assert.equal(receipt.firstChangedMessageIndex, 0)
    assert.ok(receipt.commonPrefixBytes > 0)
    assert.equal(receipt.providerReceipt, 'unknown')
    assert.ok(!JSON.stringify(receipt).includes('secret-body'))
    assert.equal(s.bridge.service.stats().calls, 1)
  } finally { await s.dispose() }
})

test('OP fullSends count only native handoff; preview, uniterated, blocked and canceled do not consume it', async () => {
  const s = await setup()
  try {
    opApply(s.ctx, { maxInlineBytes: 100, fullSends: 2, spillDir: s.root, telemetryDir: s.root, evidenceChars: 2200 })
    const callId = 'recorded-log'
    await s.ctx.waterfall(s.ctx, 'tools/post-execute', { name: 'read_log', callId, agent: { session: { id: 'isolated-session' } } },
      { content: [{ type: 'text', text: fixture.text }], isError: false }, async () => ({ kind: 'accept' }))
    const message = profile.createToolResultMessage({ callId, content: [{ type: 'text', text: fixture.text }], isError: false })
    const request = () => Object.freeze(profile.markAgentLoopRequest(s.request({ messages: [message] })))
    const full = fixture.text
    for (let n = 0; n < 4; n++) assert.equal(s.bridge.service.preview(request()).options.messages[0].content[0].text, full)
    const unused = s.llm.stream(request())
    await unused[Symbol.asyncIterator]().return()
    const stop = s.ctx.on('llm/stream', () => (async function* () {})(), { global: true })
    const blocked = request(); await collect(s.llm.stream(blocked)); stop()
    assert.equal(s.bridge.service.audit(blocked).handedToAdapter, false)
    const controller = new AbortController(); controller.abort()
    const canceled = s.request({ messages: [message], signal: controller.signal })
    const chunks = await collect(s.llm.stream(canceled))
    assert.equal(chunks[0].reason.kind, 'aborted')
    assert.equal(s.bridge.service.audit(canceled).handedToAdapter, false)
    assert.equal(s.captures.length, 0)
    for (let n = 0; n < 3; n++) await collect(s.llm.stream(request()))
    assert.equal(s.captures[0].options.messages[0].content[0].text, full)
    assert.equal(s.captures[1].options.messages[0].content[0].text, full)
    assert.match(s.captures[2].options.messages[0].content[0].text, /L173: ERROR: UNIQUE_FAILURE/)
    assert.equal(s.ctx.observationPackStats().replaced, 1)
    assert.equal(s.ctx.observationPackStats().archived, 1)
    assert.equal(message.content[0].text, full)
    assert.equal(s.bridge.service.preview(request()).options.messages[0].content[0].text, s.captures[2].options.messages[0].content[0].text)
    assert.equal(s.ctx.observationPackStats().replaced, 1)
  } finally { await s.dispose() }
})

test('observation pack unregisters from native Cordis effect teardown across restart and dispose', async () => {
  const s = await setup()
  const plugin = { name: 'request-plan-observation-pack', inject: ['llm', 'requestMessageProjection'], apply: opApply }
  let fiber
  try {
    fiber = s.ctx.plugin(plugin, { maxInlineBytes: 100, fullSends: 2, spillDir: s.root, telemetryDir: s.root })
    await fiber.await()
    assert.equal(s.bridge.service.stats().registrations, 1)
    await fiber.restart()
    assert.equal(s.bridge.service.stats().registrations, 1)
    await fiber.restart()
    assert.equal(s.bridge.service.stats().registrations, 1)
    await fiber.dispose()
    await fiber.await()
    assert.equal(s.bridge.service.stats().registrations, 0)
    await fiber.dispose()
    assert.equal(s.bridge.service.stats().registrations, 0)
  } finally {
    if (fiber?.uid !== null) await fiber.dispose().catch(() => {})
    await s.dispose()
  }
})

test('canonical aliases agree while an independent official brand preserves prepared generation and caller context', async () => {
  assert.equal(canonicalApp.LlmRuntime, profile.LlmRuntime)
  assert.notEqual(app.LlmRuntime, profile.LlmRuntime)
  const s = await setup(app)
  try {
    const contexts = []
    s.bridge.service.register('identity', input => ({ messages: input.messages }), { preview: input => ({ messages: input.messages }), onDispatch() { contexts.push(true) } })
    const caller = s.ctx.extend({ requestCaller: 'caller-scope' })
    const originalForAdapter = s.llm.forAdapter
    s.llm.forAdapter = function(options, adapter) { assert.equal(this.ctx.requestCaller, 'caller-scope'); return originalForAdapter.call(this, options, adapter) }
    const prepared = await caller.llm.prepareCall({ provider: 'fixture', model: 'model' })
    s.release(); const releaseB = s.llm.registerAdapter(['fixture'], s.adapter('B'))
    const tools = Object.freeze([{ name: 'recorded_tool', parameters: { type: 'object' } }])
    const toolHistory = Object.freeze({ retained: true })
    const options = Object.freeze(app.markAgentLoopRequest(s.request({ ...prepared.config, tools, toolHistory, purpose: 'auxiliary', turnId: 't1', taskId: 'task1' })))
    await collect(prepared.stream(options))
    const received = s.captures[0].options
    assert.equal(s.captures[0].generation, 'A'); assert.equal(s.prepare.count, 1)
    assert.equal(app.isAgentLoopRequest(received), true); assert.equal(profile.isAgentLoopRequest(received), false)
    assert.equal(received.signal, options.signal); assert.equal(received.tools, tools); assert.equal(received.toolHistory, toolHistory)
    assert.equal(contexts.length, 1)
    assert.equal(s.bridge.service.audit(received).taskId, 'task1')
    releaseB()
  } finally { await s.dispose() }
})

// The agent loop of a real host brands its requests in another module instance of dsh-llm than the one the runtime
// came from (hard-linked copies under different paths). A guard bound to one instance answered "no" for every real
// request and switched off every observer behind it, so the guard recognises the brand of either instance.
test('public brand guard recognises the brand of either dsh-llm instance, never an unbranded request, and follows projected clones', async () => {
  for (const module of [profile, app]) {
    const s = await setup(module)
    try {
      const guard = s.bridge.service.isAgentLoopRequest
      assert.equal(guard(s.request()), false)
      // The two instances a real host has: the profile's and the application's, each at its plain file URL.
      const known = module === profile ? canonicalApp : profile
      assert.equal(guard(known.markAgentLoopRequest(s.request())), true)
      // An instance that is certainly a different one from the bound module, whatever the host aliases.
      const other = module === profile ? app : profile
      // An instance nobody told the bridge about (here: the same file under a query string) proves nothing.
      if (module === profile) assert.equal(guard(app.markAgentLoopRequest(s.request())), false)
      const prepared = await s.llm.prepareCall({ provider: 'fixture', model: 'model' })
      const canonical = Object.freeze(module.markAgentLoopRequest(s.request({ ...prepared.config })))
      assert.equal(guard(canonical), true)
      const change = input => ({ messages: input.messages.map(message => ({ ...message, content: [{ type: 'text', text: 'projected clone' }] })) })
      s.bridge.service.register('brand-clone', change, { preview: change })
      const preview = s.bridge.service.preview(canonical)
      assert.notEqual(preview.options, canonical)
      assert.equal(guard(preview.options), true)
      const plan = s.bridge.service.prepare(canonical)
      assert.notEqual(plan.options, canonical)
      assert.equal(guard(plan.options), true)
      assert.equal(other.isAgentLoopRequest(plan.options), false)
      await collect(prepared.stream(plan.options))
      assert.equal(guard(s.captures[0].options), true)
    } finally { await s.dispose() }
  }
})

test('prepare locks a detached snapshot even for identity transforms and mutable caller messages', async () => {
  const s = await setup()
  try {
    let transforms = 0
    s.bridge.service.register('identity-lock', input => { transforms++; return { messages: input.messages } })
    const input = s.request({ tools: [{ name: 'original', parameters: { type: 'object' } }], toolHistory: { retained: ['original'] } })
    input.messages = structuredClone(input.messages)
    profile.markAgentLoopRequest(input)
    const originalMessages = structuredClone(input.messages)
    const plan = s.bridge.service.prepare(input)
    assert.notEqual(plan.options, input)
    assert.notEqual(plan.options.messages, input.messages)
    assert.equal(plan.receipt.preparedSnapshot, true)
    assert.equal(plan.receipt.changed, false)
    assert.equal(Object.isFrozen(plan.options), true)
    assert.equal(Object.isFrozen(plan.options.messages[0].content[0]), true)
    assert.equal(Object.isFrozen(input), false)
    assert.equal(Object.isFrozen(input.messages), false)
    input.messages[0].content[0].text = 'changed after prepare'
    input.messages.push(profile.createUserMessage({ content: [{ type: 'text', text: 'late appended body' }], source: { kind: 'user' } }))
    input.tools[0].name = 'changed after prepare'
    input.toolHistory.retained.push('late')
    assert.throws(() => { plan.options.messages = input.messages }, TypeError)
    await collect(s.llm.stream(plan.options))
    assert.equal(transforms, 1)
    assert.deepEqual(s.captures[0].options.messages, originalMessages)
    assert.equal(s.captures[0].options.tools[0].name, 'original')
    assert.deepEqual(s.captures[0].options.toolHistory, { retained: ['original'] })
    assert.equal(s.captures[0].options.signal, input.signal)
    assert.equal(s.bridge.service.isAgentLoopRequest(s.captures[0].options), true)
    const receipt = s.bridge.service.audit(plan.options)
    assert.equal(receipt.after.sha256, receipt.adapterPayload.sha256)
    assert.equal(receipt.after.bytes, receipt.adapterPayload.bytes)
    assert.equal(receipt.after.sha256, hash(originalMessages))
  } finally { await s.dispose() }
})

test('prepare cannot lock unknown protocol values and explicitly returns unprepared fail-open dispatch', async () => {
  const s = await setup()
  try {
    const input = s.request({ messages: [{ id: 'unknown', role: 'user', source: { kind: 'user' }, content: [{ type: 'future-block', data: 'original' }] }] })
    const plan = s.bridge.service.prepare(input)
    assert.equal(plan.options, input)
    assert.equal(plan.receipt.preparedSnapshot, false)
    assert.equal(plan.receipt.stage, 'unprepared-fail-open')
    input.messages[0].content[0].data = 'latest native input'
    await collect(s.llm.stream(plan.options))
    assert.equal(s.captures[0].options, input)
    assert.equal(s.captures[0].options.messages[0].content[0].data, 'latest native input')
    const receipt = s.bridge.service.audit(input)
    assert.notEqual(receipt.requestId, plan.receipt.requestId)
    assert.equal(receipt.preparedSnapshot, false)
    assert.equal(receipt.after.sha256, receipt.adapterPayload.sha256)
  } finally { await s.dispose() }
})

test('unknown/image/error shapes fail open and raw safety measurement stays authoritative', async () => {
  const s = await setup()
  try {
    s.bridge.service.register('shape', input => ({ messages: input.messages }), { preview: input => ({ messages: input.messages }) })
    const images = [{ id: 'image', role: 'user', source: { kind: 'user' }, content: [{ type: 'image', source: { kind: 'url', url: 'https://example.invalid/image.png' } }] }]
    const options = s.request({ messages: images })
    const preview = s.bridge.service.preview(options)
    assert.equal(preview.options, options)
    assert.equal(preview.receipt.transforms[0].status, 'skipped-unrecognized-request')
    const agent = { session: {} }
    const ctx = { get(key) { return key === 'requestMessageProjection' ? s.bridge.service : key === 'agents' ? { get() { return agent } } : key === 'tokenMeter' ? { measure(session) { assert.equal(session, agent.session); return { totalTokens: 250000 } } } : null } }
    const budget = observeRequestBudget(ctx, options)
    assert.equal(budget.rawSafetyTokens, 250000)
    assert.equal(budget.controlsSafetyRejection, false)
    assert.equal(budget.routeTokenizerPricing, 'unknown')
    const pressure = preStepBudget(ctx, { ...DEFAULTS, windowTokens: 200000, reservedOutputTokens: 8192, safetyMarginTokens: 4096 }, agent)
    assert.equal(pressure.ok, false)
    assert.equal(pressure.reason, 'context-budget')
    assert.equal(pressure.tokens, 250000)
  } finally { await s.dispose() }
})

test('transform mutations cannot change mutable caller tools or tool history; final identities are preserved', async () => {
  const s = await setup()
  try {
    const tools = [{ name: 'original', parameters: { type: 'object' } }]
    const toolHistory = { retained: ['original'] }
    s.bridge.service.register('mutate-tools', input => { input.tools[0].name = 'changed'; return { messages: input.messages } })
    s.bridge.service.register('mutate-history', input => { input.toolHistory.retained.push('changed'); return { messages: input.messages } })
    const options = s.request({ tools, toolHistory })
    await collect(s.llm.stream(options))
    assert.equal(tools[0].name, 'original')
    assert.deepEqual(toolHistory, { retained: ['original'] })
    assert.equal(Object.isFrozen(tools), false)
    assert.equal(s.captures[0].options.tools, tools)
    assert.equal(s.captures[0].options.toolHistory, toolHistory)
    assert.deepEqual(s.bridge.service.audit(options).transforms.map(row => row.status), ['failed-open', 'failed-open'])
  } finally { await s.dispose() }
})

test('concurrent unchanged requests sharing an options object retain independent receipts after audit eviction', async () => {
  const s = await setup(profile, { maxAuditRecords: 2 })
  const ledger = ledgerApply(s.ctx, { directory: s.root, identityManifestPath: join(s.root, 'missing.json') })
  try {
    await ledger.ready
    const options = Object.freeze(s.request())
    const delayed = s.llm.stream(options)
    for (let n = 0; n < 4; n++) await collect(s.llm.stream(options))
    await collect(delayed)
    await ledger.flush()
    const rows = readFileSync(ledger.stats().file, 'utf8').trim().split('\n').map(JSON.parse)
    const starts = rows.filter(row => row.event === 'start')
    const terminals = rows.filter(row => row.event === 'terminal')
    assert.equal(new Set(starts.map(row => row.requestId)).size, 5)
    assert.equal(terminals.length, 5)
    for (const row of terminals) {
      assert.equal(row.requestProjection.requestId, row.requestId)
      assert.equal(row.requestProjection.stage, 'handed-to-adapter')
      assert.equal(row.requestProjection.handedToAdapter, true)
    }
    assert.equal(s.captures.length, 5)
  } finally { await ledger(); await s.dispose() }
})

test('ledger start/terminal and cache attribution share the exact request receipt; unrelated and future events are ignored', async () => {
  const s = await setup()
  const ledger = ledgerApply(s.ctx, { directory: s.root, identityManifestPath: join(s.root, 'absent.json') })
  try {
    await ledger.ready
    s.bridge.service.register('compress', input => ({ messages: input.messages.map(m => ({ ...m, content: [{ type: 'text', text: 'short' }] })) }))
    const options = s.request()
    await collect(s.llm.stream(options)); await ledger.flush()
    const rows = readFileSync(ledger.stats().file, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(rows.length, 2)
    assert.equal(rows[0].requestId, rows[1].requestId)
    assert.equal(rows[0].requestProjection.stage, 'attempted')
    assert.equal(rows[1].requestProjection.stage, 'handed-to-adapter')
    assert.equal(rows[1].requestId, s.bridge.service.audit(options).requestId)
    assert.equal(rows[1].usage.totalTokens, 14)
    assert.equal(rows[1].providerRequestId, null)
    const current = { ...rows[1].usage, sessionId: options.sessionId, requestId: rows[1].requestId, requestProjection: rows[1].requestProjection }
    const previous = { inputTokens: 0, cacheReadTokens: 100, cacheWriteTokens: 0 }
    const unrelated = [{ name: 'future-other-session', lastEventAt: '2099-01-01', requestId: 'other', sessionId: 'other' }]
    assert.equal(detectCacheAnomalies([previous, current], unrelated)[0].mechanismKind, 'same-request-projection-receipt')
    assert.equal(detectCacheAnomalies([previous, { ...current, requestProjection: null }], unrelated)[0].attribution, 'unknown')
    assert.equal(readLedgerRequests(options.sessionId, s.root)[0].requestId, rows[1].requestId)
    writeFileSync(join(s.root, 'requests-other.jsonl'), JSON.stringify({ ...rows[1], sessionId: 'other', requestId: 'other' }) + '\n')
    assert.equal(readLedgerRequests(options.sessionId, s.root).length, 1)
    assert.equal(detectCacheAnomalies([previous, { inputTokens: null, cacheReadTokens: 0, cacheWriteTokens: 0 }], unrelated).length, 0)
  } finally { await ledger(); await s.dispose() }
})

test('compaction SDK policy explicitly requires audited compatibility and retains unknown auxiliary/SDK contracts', async () => {
  const audit = JSON.parse(readFileSync('D:/dsh-test/docs/usage-audit-20261001/system-sdk-audit.json', 'utf8'))
  const certificate = JSON.parse(readFileSync('D:/dsh-test/docs/context-opt-20261001/sdk-compatibility-manifest.json', 'utf8'))
  const file = await open(audit.sourceSnapshot.journal, 'r')
  const messages = []
  try {
    for (const item of audit.systemBlocks) {
      const bytes = Buffer.alloc(item.compressedFrame.end - item.compressedFrame.start)
      await file.read(bytes, 0, bytes.length, item.compressedFrame.start)
      const event = zstdDecompressSync(bytes).toString('utf8').split('\n').filter(Boolean).map(JSON.parse).find(row => row.seq === item.seq)
      messages.push(event.data.message)
    }
  } finally { await file.close() }
  const input = { messages, purpose: 'compaction', signal: new AbortController().signal, tools: undefined }
  const config = { mode: 'apply', policy: 'latest', purposePolicy: { conversation: 'ptc-only', compaction: 'certified-latest' }, compatibilityManifest: certificate }
  const result = projectSdkRetention(input, config)
  assert.equal(result.audit.removedCopies, 4)
  assert.equal(result.options.signal, input.signal)
  assert.equal(result.audit.compatibilityCertificate.verified, true)
  assert.equal(projectSdkRetention(input, { ...config, compatibilityManifest: null }).options, input)
  assert.equal(projectSdkRetention(input, { ...config, purposePolicy: undefined }).options, input)
  const auxiliary = { ...input, purpose: 'background-helper' }
  assert.equal(projectSdkRetention(auxiliary, config).options, auxiliary)
  const changed = { ...input, messages: messages.map((message, index) => index === messages.length - 1 ? { ...message, content: message.content.map(block => block.type === 'text' ? { ...block, text: block.text.replace('type JsonValue =', 'type UnknownValue =') } : block) } : message) }
  assert.equal(projectSdkRetention(changed, config).options, changed)
  const s = await setup()
  const sdk = sdkApply(s.ctx, { ...config, directory: s.root })
  try {
    await sdk.ready
    const options = s.request(input)
    const preview = s.bridge.service.preview(options)
    assert.equal(s.captures.length, 0)
    assert.equal(preview.receipt.changed, true)
    const prepared = await s.llm.prepareCall({ provider: 'fixture', model: 'model' })
    await collect(prepared.stream(options))
    assert.deepEqual(s.captures[0].options.messages, result.options.messages)
    assert.equal(s.captures[0].options.signal, input.signal)
    assert.equal(s.bridge.service.audit(options).stage, 'handed-to-adapter')
  } finally { await sdk(); await s.dispose() }
})
