import { createHash, randomUUID } from 'node:crypto'
import { readFile, open, readdir, stat, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { officialModuleFor } from '../home/profiles/web/plugins/request-message-projection.mjs'
import { findSdkSection } from '../home/profiles/web/plugins/ptc-sdk-retention.mjs'
import { measureRequest, resolveProjection } from '../home/profiles/web/plugins/request-usage-ledger.mjs'
import { parseObservationSource } from '../home/profiles/web/plugins/team-v13-observation-source.mjs'

export const name = 'context-opt-runtime-probe'
export const inject = ['llm', 'requestMessageProjection']
const BASE = 'D:/dsh-test'
const hash = value => createHash('sha256').update(value).digest('hex')
const jsonHash = value => hash(JSON.stringify(value))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const safeCode = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value) ? value : 'CANARY_CHECK_FAILED'
const expect = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }) }
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }; return value }

function sdkVersions(messages) {
  return messages.filter(message => message.role === 'system').flatMap(message => message.content.flatMap(block => {
    if (block.type !== 'text') return []
    const section = findSdkSection(block.text)
    return section.status === 'valid' ? [{ sha256: section.sha256, bytes: section.bytes }] : []
  }))
}

function nonSdk(messages, observationCallId) {
  return messages.map(message => {
    const copy = structuredClone(message)
    if (copy.role === 'system') copy.content = copy.content.map(block => {
      if (block.type !== 'text') return block
      const section = findSdkSection(block.text)
      let text = section.status === 'valid' ? block.text.slice(0, section.start) + block.text.slice(section.end) : block.text
      text = text.replace(/<!-- previous tools:sdk sha256=[a-f0-9]{64} bytes=\d+; latest sha256=[a-f0-9]{64} retained -->/g, '')
      return { ...block, text }
    })
    if (copy.role === 'tool' && copy.toolCallId === observationCallId) copy.content = [{ type: 'text', text: '[canary-observation-content-slot]' }]
    return copy
  })
}

async function fixtures(config) {
  const sdkFixturePath = config.sdkFixturePath ?? `${BASE}/workspaces/context-sdk-01/fixture.json`
  const opFixturePath = config.opFixturePath ?? `${BASE}/workspaces/usage-lab-20261001/fixture.json`
  const auditPath = config.sdkSourceAuditPath ?? `${BASE}/docs/usage-audit-20261001/system-sdk-audit.json`
  const certificatePath = config.compatibilityManifestPath ?? `${BASE}/docs/context-opt-20261001/sdk-compatibility-manifest.json`
  const [sdkBytes, opBytes, auditBytes, certificateBytes] = await Promise.all([sdkFixturePath, opFixturePath, auditPath, certificatePath].map(path => readFile(path)))
  const sdk = JSON.parse(sdkBytes)
  const op = JSON.parse(opBytes)
  const audit = JSON.parse(auditBytes)
  const certificate = JSON.parse(certificateBytes)
  expect(sdk.source?.sdkHashes?.length === 5 && sdk.source?.seqs?.length === 5, 'FIVE_SDK_FIXTURE_REQUIRED')
  expect(JSON.stringify(sdk.source.sdkHashes) === JSON.stringify(certificate.orderedSdkHashes), 'SDK_CERTIFICATE_CHAIN_MISMATCH')
  expect(typeof op.text === 'string' && op.critical?.some(row => row.line === 173), 'OP_LINE_173_FIXTURE_REQUIRED')
  const journal = resolve(audit.sourceSnapshot.journal)
  expect(journal.startsWith(resolve(`${BASE}/home/sessions`) + sep), 'SDK_FRAME_SOURCE_OUTSIDE_SESSIONS')
  const file = await open(journal, 'r')
  const systems = []
  const frameProofs = []
  try {
    for (let index = 0; index < sdk.source.seqs.length; index++) {
      const seq = sdk.source.seqs[index]
      const source = audit.systemBlocks.find(row => row.seq === seq)
      const start = source?.compressedFrame?.start
      const end = source?.compressedFrame?.end
      expect(Number.isSafeInteger(start) && start >= 0 && Number.isSafeInteger(end) && end > start && end - start <= 32 * 1024 * 1024, 'INVALID_SDK_FRAME_BOUNDS')
      const compressed = Buffer.alloc(end - start)
      const read = await file.read(compressed, 0, compressed.length, start)
      expect(read.bytesRead === compressed.length, 'SDK_FRAME_TRUNCATED')
      const event = zstdDecompressSync(compressed, { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8').split('\n').filter(Boolean).map(JSON.parse)
        .find(row => row.type === 'system/message' && row.seq === seq)
      expect(event?.data?.message?.role === 'system', 'SDK_FRAME_EVENT_MISSING')
      const message = event.data.message
      const versions = sdkVersions([message])
      expect(versions.length === 1 && versions[0].sha256 === sdk.source.sdkHashes[index], 'SDK_FRAME_HASH_MISMATCH')
      systems.push(message)
      frameProofs.push({ seq, start, end, compressedSha256: hash(compressed), sdkSha256: versions[0].sha256, sdkBytes: versions[0].bytes })
    }
  } finally { await file.close() }
  return { sdk, op, systems, certificate, metadata: {
    sdkFixture: { path: sdkFixturePath, sha256: hash(sdkBytes) }, opFixture: { path: opFixturePath, sha256: hash(opBytes), lineCount: op.text.split('\n').length },
    certificate: { path: certificatePath, sha256: hash(certificateBytes) }, sourceAudit: { path: auditPath, sha256: hash(auditBytes) },
    sdkMode: 'five-distinct-audited-versions;exact-five-frame-range-reads-no-journal-scan', journal, frameProofs,
  } }
}

async function ledgerTail(directory, pid, sessionId) {
  const files = (await readdir(directory)).filter(file => file.startsWith(`requests-${pid}-`) && file.endsWith('.jsonl'))
  const rows = []
  for (const file of files.slice(-8)) {
    const path = join(directory, file)
    const info = await stat(path)
    const length = Math.min(info.size, 512 * 1024)
    const start = info.size - length
    const handle = await open(path, 'r')
    try {
      const bytes = Buffer.alloc(length)
      const read = await handle.read(bytes, 0, length, start)
      const lines = bytes.subarray(0, read.bytesRead).toString('utf8').split('\n')
      if (start) lines.shift()
      for (const line of lines) {
        let row
        try { row = JSON.parse(line) } catch { continue }
        if (row.sessionId !== sessionId) continue
        rows.push({ file: path, requestId: row.requestId, status: row.status, rootTeamId: row.rootTeamId ?? null,
          provider: row.provider, model: row.model, usage: row.usage, requestProjection: row.requestProjection, payload: row.payload })
      }
    } finally { await handle.close() }
  }
  return rows
}

/** One bounded, entirely local dispatch group on the injected live LlmRuntime. */
export async function runRuntimeCanary(ctx, config = {}) {
  const reportPath = config.reportPath ?? `${BASE}/docs/context-opt-20261001/runtime-canary.json`
  const startedAt = new Date().toISOString()
  const moduleHash = hash(await readFile(new URL(import.meta.url)))
  const runId = randomUUID()
  const provider = `mock-context-opt-canary-${process.pid}-${runId}`
  const model = 'mock-canonical-projection-fixture'
  const sessionId = `mock-context-opt-canary-session-${runId}`
  const observationCallId = `mock-observation-${runId}`
  const report = { version: 1, pid: process.pid, moduleHash, startedAt, runId, status: 'running',
    environment: config.environment ?? 'injected-dsh-runtime', quality: 'local-mock-wiring-only;not-online-quality-or-billing',
    provider, model, sessionId, rootTeamId: null, externalHttpRequests: 0, plannedModelCalls: 0, mockAdapterDispatches: 0,
    reportPath, requests: [], assertions: {}, failures: [] }
  const llm = ctx.llm
  const bridge = ctx.requestMessageProjection
  const registrations = []
  const disposers = []
  let releaseAdapter
  let caught
  try {
    const bridgeStats = bridge.stats()
    report.bridge = bridgeStats
    report.bridgeInstalled = bridgeStats.installed === true
    expect(report.bridgeInstalled && bridgeStats.pid === process.pid, 'LIVE_BRIDGE_UNAVAILABLE')
    const target = llm[Symbol.for('cordis.original')] ?? llm
    const official = await officialModuleFor(target)
    const fixture = await fixtures(config)
    report.fixtures = fixture.metadata
    report.beforeSdk = sdkVersions(fixture.systems)
    expect(report.beforeSdk.length === 5, 'FIVE_INITIAL_SDK_SECTIONS_REQUIRED')
    const requestMessages = [...fixture.systems, ...fixture.sdk.history,
      official.createToolResultMessage({ callId: observationCallId, content: [{ type: 'text', text: fixture.op.text }], isError: false })]
    freeze(requestMessages)
    const originalMessagesHash = jsonHash(requestMessages)
    const expectedNonSdkHash = jsonHash(nonSdk(requestMessages, observationCallId))
    const historyHash = jsonHash(fixture.sdk.history)
    const captured = []
    const hooks = []
    let preparations = 0
    let dispatches = 0
    const adapter = generation => new class extends official.LlmAdapter {
      providerInfo(route) { return { id: route, name: 'Local mock context projection canary' } }
      async prepareCall(route, requestedModel) {
        const preparation = ++preparations
        return { model: { provider: route, id: requestedModel, name: 'Mock fixture', defaultMaxTokens: 32 }, stream(options) {
          dispatches++
          captured.push({ generation, preparation, options })
          return (async function* () {
            yield { type: 'usage', usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 } }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        } }
      }
    }()
    releaseAdapter = llm.registerAdapter([provider], adapter('A'))
    registrations.push({ provider, generation: 'A', isolated: true })
    disposers.push(ctx.on('llm/stream', (options, next) => {
      if (options.sessionId === sessionId) hooks.push({ options, requestProjection: resolveProjection(ctx, options), payload: measureRequest(options) })
      return next()
    }, { global: true }))
    // This publishes one synthetic result to the existing OP archiver. There is
    // no tools.execute(), Agent, Team, session append, or external command.
    const decision = await ctx.waterfall(ctx, 'tools/post-execute', { name: config.observationToolName ?? 'context-opt-canary-fixture', callId: observationCallId, sessionId },
      { isError: false, content: [{ type: 'text', text: fixture.op.text }] }, async () => ({ kind: 'accept' }))
    expect(decision?.kind === 'accept', 'MOCK_OBSERVATION_EVENT_NOT_ACCEPTED')
    report.observationSeed = { method: 'synthetic-tools/post-execute-waterfall', toolName: config.observationToolName ?? 'context-opt-canary-fixture', noToolExecuted: true }
    const tools = freeze([{ name: 'run_code', parameters: { type: 'object', required: ['code', 'description'], properties: { code: { type: 'string' }, description: { type: 'string' } } } }])
    const toolHistory = freeze({ mockCanaryHistory: true })
    const ledgerDirectory = config.ledgerDirectory ?? `${BASE}/home/usage-ledger`
    await pause(Math.min(Math.max(Number(config.settleMs) || 100, 0), 2000))
    for (let index = 0; index < 3; index++) {
      const prepared = await llm.prepareCall({ provider, model, maxTokens: 32 })
      if (index === 0) {
        releaseAdapter()
        releaseAdapter = llm.registerAdapter([provider], adapter('B'))
        registrations.push({ provider, generation: 'B', isolated: true, replacedAfterPreparation: true })
      }
      const signal = new AbortController().signal
      const request = Object.freeze(official.markAgentLoopRequest({ ...prepared.config, sessionId, messages: requestMessages, tools, toolHistory, signal }))
      for await (const chunk of prepared.stream(request)) expect(chunk.type === 'usage' || chunk.type === 'finish', 'UNEXPECTED_MOCK_CHUNK')
      expect(dispatches === index + 1 && captured.length === index + 1 && hooks.length === index + 1, 'MOCK_SINGLE_DISPATCH_FAILED')
      const actual = captured[index]
      const input = actual.options
      const projection = hooks[index].requestProjection
      expect(official.isAgentLoopRequest(input), 'CANONICAL_BRAND_LOST')
      expect(actual.generation === (index === 0 ? 'A' : 'B') && actual.preparation === index + 1, 'PREPARED_GENERATION_DRIFT')
      expect(input.provider === provider && input.model === model && input.signal === signal && input.tools === tools && input.toolHistory === toolHistory, 'REQUEST_PROPERTIES_DRIFT')
      expect(hooks[index].options === input, 'NATIVE_HOOK_ADAPTER_OPTIONS_DIFFER')
      const afterSdk = sdkVersions(input.messages)
      expect(afterSdk.length === 1 && afterSdk[0].sha256 === fixture.certificate.latestSha256, 'SDK_LATEST_PROJECTION_NOT_APPLIED')
      expect(jsonHash(nonSdk(input.messages, observationCallId)) === expectedNonSdkHash, 'NON_SDK_MESSAGE_CHAIN_CHANGED')
      const actualHistory = input.messages.filter(message => fixture.sdk.history.some(original => original.id === message.id))
      expect(jsonHash(actualHistory) === historyHash, 'TOOL_CALL_HISTORY_OR_REASONING_CHANGED')
      expect(jsonHash(requestMessages) === originalMessagesHash, 'ORIGINAL_MESSAGES_MUTATED')
      const actualObservation = input.messages.find(message => message.toolCallId === observationCallId)
      const observationText = actualObservation.content[0].text
      const source = parseObservationSource(observationText)
      if (index < 2) expect(observationText === fixture.op.text, 'OP_FULL_SENDS_DELAY_CHANGED')
      else {
        expect(source?.lineNumbers?.includes(173), 'OP_LINEAGE_173_MISSING')
        expect(observationText.includes(`L173: ${fixture.op.critical.find(row => row.line === 173).text}`), 'OP_LINE_173_TEXT_CHANGED')
      }
      const transforms = projection?.transforms ?? []
      const sdkHandler = transforms.find(row => row.id?.startsWith('ptc-sdk-retention:'))
      const opHandler = transforms.find(row => row.id === 'observation-pack')
      expect(sdkHandler?.order === 10 && opHandler?.order === 20 && transforms.indexOf(sdkHandler) < transforms.indexOf(opHandler), 'HANDLER_ORDER_10_20_MISSING')
      expect(sdkHandler.status === 'applied' && (index < 2 ? opHandler.status === 'unchanged' : opHandler.status === 'applied'), 'PROJECTION_TRANSFORM_STATUS_MISMATCH')
      report.requests.push({ index, preparedGeneration: actual.generation, preparation: actual.preparation, singleDispatch: true,
        before: { messageBytes: Buffer.byteLength(JSON.stringify(requestMessages)), messagesSha256: originalMessagesHash, sdkCopies: 5, nonSdkSha256: expectedNonSdkHash, historySha256: historyHash },
        after: { messageBytes: Buffer.byteLength(JSON.stringify(input.messages)), messagesSha256: jsonHash(input.messages), sdkCopies: afterSdk.length, sdkSha256: afterSdk[0].sha256, nonSdkSha256: jsonHash(nonSdk(input.messages, observationCallId)), historySha256: jsonHash(actualHistory) },
        projection, payload: hooks[index].payload, op: { fullText: index < 2, handle: index === 2, lineNumbers: source?.lineNumbers ?? null, archivePath: source?.archivePath ?? null, sha256: source?.sha256 ?? hash(fixture.op.text), line173Preserved: index === 2 },
        mockUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, billed: false })
    }
    let persisted = []
    const deadline = Date.now() + 3000
    do {
      persisted = await ledgerTail(ledgerDirectory, process.pid, sessionId)
      if (persisted.filter(row => row.status === 'success').length >= 3) break
      await pause(100)
    } while (Date.now() < deadline)
    const terminal = persisted.filter(row => row.status === 'success')
    expect(terminal.length === 3, 'REAL_USAGE_LEDGER_TERMINAL_ROWS_MISSING')
    expect(terminal.every(row => row.rootTeamId === null && row.provider === provider && row.model === model && row.usage?.totalTokens === 0), 'MOCK_LEDGER_ATTRIBUTION_OR_USAGE_MISMATCH')
    const hookedCalls = new Set(report.requests.map(row => row.projection.call))
    expect(terminal.every(row => row.requestProjection?.installed && row.requestProjection.moduleHash === bridgeStats.moduleHash && hookedCalls.has(row.requestProjection.call)), 'REAL_LEDGER_PROJECTION_METADATA_MISSING')
    report.usageLedger = { verified: true, directory: ledgerDirectory, rows: terminal.map(row => ({ ...row, payload: { bytes: row.payload?.bytes, categories: row.payload?.categories } })), actualNativeHook: true, mockNotBilling: true }
    report.mockAdapterDispatches = dispatches
    report.preparations = preparations
    report.assertions = { canonicalBrand: true, preparedGenerations: true, singleDispatch: true, latestSdkCopies: 1, handlerOrder10Then20: true, nonSdkChainPreserved: true, toolCallHistoryAndReasoningPreserved: true, originalMessagesUnchanged: true, opFullSends2ThenHandle: true, lineage173Preserved: true, realLedgerObservedProjection: true, noRealRootTeamAttribution: true }
    report.status = 'passed'
  } catch (error) {
    caught = error
    report.status = 'failed'
    report.failures.push({ code: safeCode(error?.code), type: safeCode(error?.name) })
  } finally {
    try {
      releaseAdapter?.()
      report.mockProviderUnregistered = !llm.listProviders().some(row => row.id === provider)
      expect(report.mockProviderUnregistered, 'MOCK_PROVIDER_UNREGISTER_FAILED')
      for (const dispose of disposers) dispose()
    } catch (error) {
      caught ??= error
      report.status = 'failed'
      report.failures.push({ code: safeCode(error?.code), type: safeCode(error?.name), stage: 'cleanup' })
    }
    report.registrations = registrations
    report.completedAt = new Date().toISOString()
    await mkdir(dirname(reportPath), { recursive: true })
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  }
  if (caught) throw caught
  return report
}

export async function apply(ctx, config = {}) {
  const report = await runRuntimeCanary(ctx, config)
  ctx.logger?.info?.(`[context-opt-runtime-probe] passed pid=${report.pid} bridge=${report.bridge.moduleHash} report=${report.reportPath}`)
}
