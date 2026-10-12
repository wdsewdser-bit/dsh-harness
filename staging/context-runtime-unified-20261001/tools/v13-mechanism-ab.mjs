/**
 * Deterministic offline A/B report for the v13 observation mechanisms.
 *
 * This is intentionally provider-free. It measures the model-facing bytes
 * removed by ObservationPack and Evidence-Preserving Reducer on the same
 * fixture, checks the archive/receipt quality gates, and writes a report that
 * can be registered as v12 evidence.
 *
 * Usage:
 *   node tools/v13-mechanism-ab.mjs --fixture D:/dsh-test/phase10-tests/fixtures/v13-mechanism-ab.json --json
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createObservation, projectMessages, verifyArchive } from '../home/profiles/web/plugins/observation-pack-v2.mjs'
import { renderReceipt, verifyReceipt } from '../home/profiles/web/plugins/evidence-reducer.mjs'
import { buildCostAttributionReport } from '../home/profiles/web/plugins/team-v13-cost-attribution.mjs'

const DEFAULTS = {
  fixture: 'D:/dsh-test/phase10-tests/fixtures/v13-mechanism-ab.json',
  output: 'D:/dsh-test/home/team-control-plane/v13-mechanism-ab.json',
  model: 'offline-fixture',
  json: false,
}

function parseArgs(argv) {
  const options = { ...DEFAULTS }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      options.json = true
      continue
    }
    const match = /^--([A-Za-z][A-Za-z0-9]*)(?:=(.*))?$/.exec(arg)
    if (match === null) continue
    const value = match[2] ?? argv[++index]
    if (value === undefined) continue
    if (match[1] === 'fixture') options.fixture = value
    else if (match[1] === 'output') options.output = value
    else if (match[1] === 'model') options.model = value
  }
  return options
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function sha256Text(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function makeLog(fixture) {
  const lines = Array.isArray(fixture?.lines) ? fixture.lines.map(String) : []
  const repeats = Math.max(0, Number(fixture?.repeat ?? 0))
  const repeated = Array.isArray(fixture?.repeatLine) ? fixture.repeatLine.map(String) : ['noise']
  const rows = [...lines]
  for (let index = 0; index < repeats; index += 1) {
    rows.push(repeated[index % repeated.length] + ' #' + String(index))
  }
  return rows.join('\n')
}

function metric(inputTokens, outputTokens = 0, savedTokens = 0, toolCalls = 0, modelTurns = 0, qualityPassed = 0) {
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    savedTokens,
    overheadTokens: 0,
    toolMs: 0,
    waitMs: 0,
    modelTurns,
    toolCalls,
    qualityPassed,
    qualityFailed: qualityPassed > 0 ? 0 : 1,
  }
}

function runObservationPack(fixture, text, root) {
  const observation = createObservation({
    toolName: 'fixture',
    callId: 'ab-observation',
    blocks: [{ type: 'text', text }],
    spillDir: root,
    previewBytes: 1024,
    evidenceChars: 1500,
  })
  if (observation === undefined) throw new Error('observation fixture was not archived')
  observation.fullSends = 0
  const message = {
    role: 'toolResult',
    toolCallId: 'ab-observation',
    content: [{ type: 'text', text }],
  }
  const projected = projectMessages([message], new Map([[observation.callId, observation]]))
  const handle = projected.messages[0].content[0].text
  const qualityPassed = verifyArchive(observation) && handle.includes('retrieve: read ') ? 1 : 0
  const handleTokens = Math.ceil(Buffer.byteLength(handle, 'utf8') / 4)
  return {
    id: 'observation-pack',
    metrics: metric(
      handleTokens,
      0,
      projected.savedTokens,
      1,
      0,
      qualityPassed,
    ),
    quality: { passed: qualityPassed, failed: qualityPassed > 0 ? 0 : 1 },
    fixtureVersion: fixture.fixtureVersion,
  }
}

function runReducer(fixture, text) {
  const lines = text.split(/\r?\n/)
  const errorLine = Math.max(1, lines.findIndex((line) => /error|fail|panic/i.test(line)) + 1)
  const quote = lines[errorLine - 1] ?? lines[0] ?? ''
  const receipt = {
    version: 1,
    summary: 'fixture diagnostic summary',
    quotes: [{ line: errorLine, text: quote }],
    unresolved: [],
  }
  const verification = verifyReceipt(receipt, text, { maxReceiptTokens: 1500 })
  const rendered = renderReceipt(receipt, {
    id: 'ab-reducer',
    filePath: 'D:/dsh-test/home/evidence-archive/ab-reducer.txt',
    sha256: createHash('sha256').update(text).digest('hex'),
    bytes: Buffer.byteLength(text, 'utf8'),
    lines: lines.length,
  })
  const qualityPassed = verification.ok ? 1 : 0
  const receiptTokens = Math.ceil(Buffer.byteLength(rendered, 'utf8') / 4)
  return {
    id: 'evidence-reducer',
    metrics: metric(
      receiptTokens,
      receiptTokens,
      Math.max(0, Math.ceil(Buffer.byteLength(text, 'utf8') / 4) - receiptTokens * 2),
      1,
      1,
      qualityPassed,
    ),
    quality: { passed: qualityPassed, failed: qualityPassed > 0 ? 0 : 1 },
    fixtureVersion: fixture.fixtureVersion,
  }
}

const options = parseArgs(process.argv.slice(2))
if (!existsSync(options.fixture)) throw new Error('fixture not found: ' + options.fixture)
const fixture = readJson(options.fixture)
const text = makeLog(fixture)
const root = join(dirname(options.output), 'v13-mechanism-ab-archive')
mkdirSync(root, { recursive: true })

const observation = runObservationPack(fixture, text, root)
const reducer = runReducer(fixture, text)
const before = {
  id: 'baseline',
  metrics: metric(Math.ceil(Buffer.byteLength(text, 'utf8') / 4), 0, 0, 0, 0, 1),
  quality: { passed: 1, failed: 0 },
  fixtureVersion: fixture.fixtureVersion,
  model: options.model,
  commitSha: null,
}
const report = buildCostAttributionReport({
  sourceHash: sha256File(new URL(import.meta.url)),
  config: {
    observationPack: { maxInlineBytes: 10240, fullSends: 0 },
    reducer: { maxReceiptTokens: 1500, providerFree: true },
  },
  model: options.model,
  fixtureVersion: fixture.fixtureVersion,
})
const fixtureHash = sha256File(options.fixture)
report.binding.fixtureHash = fixtureHash
report.binding.configHash = sha256Text(JSON.stringify(report.binding.config))
report.mechanisms = [observation, reducer]
report.comparisons = [
  {
    mechanism: observation.id,
    ...buildCostAttributionReport({ before, after: observation, model: options.model, fixtureVersion: fixture.fixtureVersion }).comparison,
  },
  {
    mechanism: reducer.id,
    ...buildCostAttributionReport({ before, after: reducer, model: options.model, fixtureVersion: fixture.fixtureVersion }).comparison,
  },
]
report.comparison = {
  verdict: report.comparisons.every((row) => row.verdict === 'keep') ? 'keep' : 'reject',
  qualityRegression: report.comparisons.some((row) => row.qualityRegression === true),
  components: report.comparisons.map((row) => ({
    mechanism: row.mechanism,
    verdict: row.verdict,
    beforeTokens: row.before.totalTokens,
    afterTokens: row.after.totalTokens,
  })),
}
report.fixture = {
  id: fixture.fixtureId,
  version: fixture.fixtureVersion,
  sha256: fixtureHash,
  bytes: Buffer.byteLength(text, 'utf8'),
  lines: text.split(/\r?\n/).length,
}
report.v12Evidence = {
  id: 'v13-mechanism-ab-' + String(report.binding.sourceHash).slice(0, 16),
  requirementId: 'v13-mechanism-ab',
  status: report.comparison.verdict === 'keep' ? 'passed' : 'failed',
  evidenceRef: options.output,
  command: 'node tools/v13-mechanism-ab.mjs',
  sourceHash: report.binding.sourceHash,
  configHash: report.binding.configHash,
  fixtureHash,
  fixtureVersion: fixture.fixtureVersion,
  model: options.model,
}
mkdirSync(dirname(options.output), { recursive: true })
writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n', 'utf8')
if (options.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
else console.log(JSON.stringify({
  verdict: report.comparison?.verdict ?? null,
  output: options.output,
  components: report.comparison?.components ?? [],
  qualityRegression: report.comparison?.qualityRegression ?? null,
}, null, 2))
