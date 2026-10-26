import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildContextDelivery, CONTEXT_MARKER } from '../home/profiles/web/plugins/team-v14-context-delivery.mjs'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(testDir, '../../..')
const sourcePath = resolve(testDir, '../home/profiles/web/plugins/team-v14-context-delivery.mjs')
const estimateModuleUrl = pathToFileURL(resolve(testDir, '../home/profiles/web/plugins/team-v12-context.mjs')).href
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const baseline = JSON.parse(readFileSync(resolve(repoRoot, 'output/agent-team-complete-20261021/baseline.json'), 'utf8'))
const baselineRecord = baseline.facts.find(row => row.file.replaceAll('\\', '/') === sourcePath.replaceAll('\\', '/'))
assert.ok(baselineRecord, 'baseline.json must identify the saved original context-delivery module')
const baselineSource = readFileSync(baselineRecord.saved, 'utf8')
assert.equal(sha256(Buffer.from(baselineSource)), baselineRecord.sha256, 'saved baseline module hash')
assert.equal(baselineRecord.sha256, 'bb7fb8077ac7c9e714528c686fb119f717643f0eb05185758a666f7dc7d1b85b')

function withSharedEstimateImport(source) {
  const anchor = "import { estimateTokens } from './team-v12-context.mjs'"
  assert.equal(source.split(anchor).length - 1, 1, 'one estimateTokens import must be remapped')
  return source.replace(anchor, `import { estimateTokens } from ${JSON.stringify(estimateModuleUrl)}`)
}

async function loadSourceModule(source, suffix, { instrument = false } = {}) {
  let moduleSource = withSharedEstimateImport(source)
  if (instrument) {
    const tokenAnchor = 'const tokenStats = (value) => {'
    assert.equal(moduleSource.split(tokenAnchor).length - 1, 1, 'tokenStats instrumentation anchor')
    moduleSource = moduleSource.replace(tokenAnchor, `${tokenAnchor}\n  if (globalThis.__contextDeliveryPerfCounters) globalThis.__contextDeliveryPerfCounters.tokenStatsCalls += 1`)
    const hashAnchor = "createHash('sha256')"
    assert.equal(moduleSource.split(hashAnchor).length - 1, 1, 'hash instrumentation anchor')
    moduleSource = moduleSource.replace(hashAnchor, "(globalThis.__contextDeliveryPerfCounters && (globalThis.__contextDeliveryPerfCounters.hashCalls += 1), createHash('sha256'))")
  }
  const dir = mkdtempSync(resolve(tmpdir(), 'context-delivery-perf-'))
  const path = resolve(dir, `module-${suffix}.mjs`)
  writeFileSync(path, moduleSource, 'utf8')
  const loaded = await import(pathToFileURL(path).href + '?v=' + suffix)
  return { loaded, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function sourceHash(source) {
  return sha256(JSON.stringify([source.revision, source.content]))
}

function refillHistory(source, member, sessionId) {
  return [{
    source: { kind: 'team-message', plugin: 'team-v12-runtime' },
    content: [{ type: 'text', text: CONTEXT_MARKER + JSON.stringify({
      version: 1,
      receiptId: 'a'.repeat(24),
      member,
      sessionId,
      items: [{ id: source.id, hash: sourceHash(source), form: 'compact' }],
    }) }],
  }]
}

function largeSources(count) {
  return Array.from({ length: count }, (_, index) => {
    const source = {
      id: `source-🐙-${index}`,
      revision: index + 1,
      priority: (index * 17) % 80,
      required: index % 17 === 0,
      safetyCritical: index % 85 === 0,
      content: `规则 ${index} — preserve Unicode 😀 and exact order. ` + 'body '.repeat(4 + index % 5),
      metadata: { catalog: 'metadata-中文', ordinal: index, labels: ['required?', 'α'] },
    }
    if (index % 7 === 0) source.compactContent = `摘要 ${index} 🧭`
    if (source.required) source.fetch = { action: 'source_get', id: source.id }
    if (index === 1) source.wantFull = true
    return source
  })
}

function largeInput(count) {
  const sources = largeSources(count)
  const member = 'member-中文'
  const sessionId = 'session-😀'
  return {
    sources,
    member,
    sessionId,
    visible: refillHistory(sources.find(source => source.wantFull), member, sessionId),
    maxTokens: Number.MAX_SAFE_INTEGER,
  }
}

function richFixture() {
  return [
    {
      id: 'identity:lead', revision: 4, priority: 0, required: true, safetyCritical: true,
      content: '只读此处的约束。 Preserve the rule 😀. '.repeat(4), compactContent: 'must not compact',
      metadata: { kind: 'identity', locale: '中文', revision: 'metadata revision' },
      fetch: { action: 'identity_get', agent: 'lead' },
    },
    {
      id: 'requirement:full', revision: 7, priority: 9, required: true,
      content: '完整要求 αβ 中文内容。 '.repeat(600), compactContent: '短摘要 🌱',
      metadata: { kind: 'requirement', owner: 'lead', tags: ['安全', 'exact'] },
      fetch: { action: 'requirements_snapshot', input: { scope: 'team' } },
    },
    {
      id: 'room:optional', revision: 2, priority: 30,
      content: 'optional note 🧪', metadata: { kind: 'room', extra: { x: 1 } },
    },
  ]
}

function p95(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * 0.95) - 1]
}

function timeSamples(builder, input, count = 5) {
  builder(input)
  const samples = []
  for (let index = 0; index < count; index += 1) {
    const start = performance.now()
    builder(input)
    samples.push(performance.now() - start)
  }
  const sorted = [...samples].sort((a, b) => a - b)
  return { p50Ms: Number(sorted[Math.floor(sorted.length / 2)].toFixed(3)), p95Ms: Number(p95(sorted).toFixed(3)), samples: count }
}

function countedBuild(builder, input) {
  const counters = { hashCalls: 0, tokenStatsCalls: 0 }
  globalThis.__contextDeliveryPerfCounters = counters
  try {
    const result = builder(input)
    return { result, counters }
  } finally {
    delete globalThis.__contextDeliveryPerfCounters
  }
}

test('optimized delivery matches the saved implementation and reports measured scaling', { timeout: 180000 }, async () => {
  const baselineModule = await loadSourceModule(baselineSource, 'baseline')
  const currentSource = readFileSync(sourcePath, 'utf8')
  const instrumentedBaseline = await loadSourceModule(baselineSource, 'instrumented-baseline', { instrument: true })
  const instrumentedCurrent = await loadSourceModule(currentSource, 'instrumented-current', { instrument: true })
  try {
    const oldBuild = baselineModule.loaded.buildContextDelivery
    const fixtures = richFixture()
    const scope = { member: 'lead-中文', sessionId: 'session-🧭' }

    const fullWithBaseline = { ...scope, sources: fixtures, baselineId: 'window:α', bindingHash: 'binding:😀', maxTokens: 100000 }
    const fullResult = oldBuild(fullWithBaseline)
    assert.deepEqual(buildContextDelivery(fullWithBaseline), fullResult)
    assert.match(fullResult.manifest.receiptId, /^[0-9a-f]{24}$/)
    assert.equal(fullResult.manifest.required.length, 2)
    assert.equal(fullResult.manifest.required[0].id, 'identity:lead')
    assert.equal(fullResult.manifest.items[0].revision, 'metadata revision')

    const compactInput = { ...scope, sources: fixtures, baselineId: 'window:α', bindingHash: 'binding:😀', maxTokens: 500 }
    const compactResult = oldBuild(compactInput)
    assert.ok(compactResult.compacted.includes('requirement:full'), 'fixture must exercise required-source compact fallback')
    assert.deepEqual(buildContextDelivery(compactInput), compactResult)

    const debtSources = [
      { id: 'critical:first', revision: 1, required: true, safetyCritical: true, priority: 0, content: 'keep this safety rule 😀', metadata: { kind: 'safety' } },
      { id: 'critical:debt', revision: 2, required: true, safetyCritical: true, priority: 1, content: 'required but too large '.repeat(900), compactContent: 'small', fetch: { action: 'get_debt' } },
      { id: 'optional:must-skip', revision: 1, content: 'optional', metadata: { note: 'must not hide debt' } },
    ]
    const debtInput = { ...scope, sources: debtSources, baselineId: 'window:debt', maxTokens: 220 }
    const debtResult = oldBuild(debtInput)
    assert.equal(debtResult.debt, true)
    assert.equal(debtResult.failClosed, true)
    assert.deepEqual(debtResult.debtItems.map(row => row.id), ['critical:debt'])
    assert.deepEqual(buildContextDelivery(debtInput), debtResult)

    const refillSource = { id: 'refill:compact', revision: 3, wantFull: true, content: 'complete refill 内容 😀', compactContent: 'summary', metadata: { source: 'fixture' } }
    const refillInput = { ...scope, sources: [refillSource], visible: refillHistory(refillSource, scope.member, scope.sessionId), maxTokens: 1000 }
    const refillResult = oldBuild(refillInput)
    assert.equal(refillResult.manifest.items[0].id, refillSource.id)
    assert.equal('form' in refillResult.manifest.items[0], false)
    assert.deepEqual(buildContextDelivery(refillInput), refillResult)

    const boundarySource = [{ id: 'boundary:exact', revision: 1, content: 'boundary text 中文 😀'.repeat(8), metadata: { source: 'edge' } }]
    const upper = { ...scope, sources: boundarySource, maxTokens: 100000 }
    const upperResult = oldBuild(upper)
    for (const maxTokens of [upperResult.estimatedTokens + 1, upperResult.estimatedTokens, Math.max(0, upperResult.estimatedTokens - 1), 0]) {
      const input = { ...upper, maxTokens }
      assert.deepEqual(buildContextDelivery(input), oldBuild(input), `budget boundary ${maxTokens}`)
    }
    assert.deepEqual(buildContextDelivery({ ...scope, sources: [], maxTokens: 0 }), oldBuild({ ...scope, sources: [], maxTokens: 0 }))

    const benchmark = []
    for (const size of [32, 128, 512, 2000]) {
      const input = largeInput(size)
      const oldOutput = oldBuild(input)
      const newOutput = buildContextDelivery(input)
      assert.deepEqual(newOutput, oldOutput, `${size}-source output equivalence`)
      assert.equal(newOutput.manifest.items.length, size)
      const oldCount = countedBuild(instrumentedBaseline.loaded.buildContextDelivery, input)
      const newCount = countedBuild(instrumentedCurrent.loaded.buildContextDelivery, input)
      assert.deepEqual(newCount.result, oldCount.result, `${size}-source instrumented output equivalence`)
      benchmark.push({
        sourceCount: size,
        outputItems: newOutput.manifest.items.length,
        omitted: newOutput.omitted.length,
        bodyBytes: Buffer.byteLength(newOutput.body),
        bodySha256: sha256(Buffer.from(newOutput.body)),
        baselineCounters: oldCount.counters,
        optimizedCounters: newCount.counters,
        baseline: timeSamples(oldBuild, input),
        optimized: timeSamples(buildContextDelivery, input),
      })
    }
    console.log('[perf-local-context-delivery] ' + JSON.stringify({
      baselineModuleSha256: baselineRecord.sha256,
      optimizedModuleSha256: sha256(readFileSync(sourcePath)),
      benchmark,
    }))
  } finally {
    baselineModule.cleanup()
    instrumentedBaseline.cleanup()
    instrumentedCurrent.cleanup()
  }
})
