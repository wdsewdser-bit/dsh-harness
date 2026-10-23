import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  apply,
  parseReceipt,
  readReducerSettings,
  renderReceipt,
  verifyReceipt,
  writeReducerSettings,
} from '../home/profiles/web/plugins/evidence-reducer.mjs'

const source = [
  'starting build',
  'ERROR: boom',
  'compiling crate',
  ...Array.from({ length: 50 }, (_, index) => 'noise line ' + String(index)),
].join('\n')

function receipt(quote) {
  return {
    version: 1,
    summary: 'the build failed at ERROR: boom',
    quotes: [{ line: 2, text: quote }],
    unresolved: [],
  }
}

function harness({ receiptText, route = { provider: 'local-test', model: 'm' }, config = {} }) {
  const listeners = new Map()
  let calls = 0
  const llm = {
    stream() {
      calls += 1
      return (async function* () {
        yield { type: 'text-delta', text: receiptText }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const ctx = {
    logger: { info() {} },
    llm,
    on(name, fn) {
      listeners.set(name, fn)
    },
  }
  apply(ctx, {
    enabled: true,
    useSettingsFile: false,
    route,
    thresholdBytes: 100,
    archiveDir: config.archiveDir,
    telemetryDir: config.archiveDir,
    localProviders: ['local-test'],
    remoteAllowed: false,
    ...config,
  })
  return { listener: listeners.get('tools/post-execute'), calls: () => calls }
}

test('parseReceipt extracts one JSON object from prose or a fence', () => {
  assert.deepEqual(parseReceipt('```json\n{"version":1,"summary":"x","quotes":[]}\n```').version, 1)
  assert.equal(parseReceipt('no json here'), undefined)
})

test('verifyReceipt accepts exact quotes and rejects mismatches', () => {
  assert.equal(verifyReceipt(receipt('ERROR: boom'), source, { maxReceiptTokens: 1500 }).ok, true)
  const mismatch = verifyReceipt(receipt('ERROR: different'), source, { maxReceiptTokens: 1500 })
  assert.equal(mismatch.ok, false)
  assert.ok(mismatch.reasons.includes('quote-0-mismatch'))
  const outOfRange = verifyReceipt({ ...receipt('ERROR: boom'), quotes: [{ line: 999, text: 'x' }] }, source)
  assert.equal(outOfRange.ok, false)
})

test('renderReceipt carries the marker, quotes and archive identity', () => {
  const rendered = renderReceipt(receipt('ERROR: boom'), {
    filePath: 'D:/archive/x.txt',
    sha256: 'abc',
    bytes: 123,
    lines: 53,
  })
  assert.match(rendered, /^sol_pi_evidence_receipt_v1/)
  assert.match(rendered, /L2: ERROR: boom/)
  assert.match(rendered, /archive_sha256: abc/)
})

test('apply replaces a long log with a verified receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evr-'))
  try {
    const harnessed = harness({
      receiptText: JSON.stringify(receipt('ERROR: boom')),
      config: { archiveDir: root },
    })
    const decision = await harnessed.listener(
      { name: 'bash', signal: undefined },
      { isError: false, content: [{ type: 'text', text: source }] },
      async () => ({ kind: 'accept' }),
    )
    assert.equal(harnessed.calls(), 1)
    assert.match(decision.content[0].text, /^sol_pi_evidence_receipt_v1/)
    const archivePath = /archive: (.+)/.exec(decision.content[0].text)[1].trim()
    assert.equal(existsSync(archivePath), true)
    assert.equal(readFileSync(archivePath, 'utf8'), source)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unverifiable receipt fails open and keeps the original log', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evr-'))
  try {
    const harnessed = harness({
      receiptText: JSON.stringify(receipt('NOT IN THE SOURCE')),
      config: { archiveDir: root },
    })
    const decision = await harnessed.listener(
      { name: 'bash', signal: undefined },
      { isError: false, content: [{ type: 'text', text: source }] },
      async () => ({ kind: 'accept' }),
    )
    assert.equal(decision.content, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a non-local route is refused when remote reduction is disabled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evr-'))
  try {
    const harnessed = harness({
      receiptText: JSON.stringify(receipt('ERROR: boom')),
      route: { provider: 'remote-x', model: 'm' },
      config: { archiveDir: root },
    })
    const decision = await harnessed.listener(
      { name: 'bash', signal: undefined },
      { isError: false, content: [{ type: 'text', text: source }] },
      async () => ({ kind: 'accept' }),
    )
    assert.equal(decision.content, undefined)
    assert.equal(harnessed.calls(), 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the operator settings document round-trips the reducer route', () => {
  const root = mkdtempSync(join(tmpdir(), 'evr-settings-'))
  try {
    const file = join(root, 'evidence-reducer.json')
    const written = writeReducerSettings({
      enabled: true,
      route: { provider: 'cmd', model: 'deepseek/deepseek-v4.1-flash' },
      routeMode: 'explicit',
      remoteAllowed: true,
    }, file)
    assert.equal(written.enabled, true)
    assert.deepEqual(readReducerSettings(file).route, {
      provider: 'cmd',
      model: 'deepseek/deepseek-v4.1-flash',
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

async function isolatedSettingsMirror(t, sectionHasFile) {
  const root = mkdtempSync(join(tmpdir(), 'evr-mirror-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const fallback = join(root, 'production-sentinel.json'), target = join(root, 'isolated-settings.json')
  writeFileSync(fallback, JSON.stringify({ sentinel: 'unchanged', revision: 10 }))
  const before = readFileSync(fallback, 'utf8')
  const sourceUrl = new URL('../home/profiles/web/plugins/evidence-reducer.mjs', import.meta.url)
  const source = readFileSync(sourceUrl, 'utf8')
    .replace(/^export const DEFAULT_SETTINGS_FILE = .*$/m, 'export const DEFAULT_SETTINGS_FILE = ' + JSON.stringify(fallback))
    .replace(/from '(\.[^']+)'/g, (_all, relative) => 'from ' + JSON.stringify(new URL(relative, sourceUrl).href))
  const fixture = join(root, 'reducer-under-test.mjs')
  writeFileSync(fixture, source)
  const { apply: applyActual } = await import(pathToFileURL(fixture).href)
  let section = { enabled: false, useSettingsFile: false, thresholdBytes: 32768,
    ...(sectionHasFile ? { settingsFile: target } : {}) }
  const listeners = new Map()
  const ctx = {
    get(name) { return name === 'settings' ? { describe: () => [{ ns: 'evidence-reducer', value: section }] } : undefined },
    on(name, listener) { listeners.set(name, listener) },
    logger: { warn() {}, info() {} },
  }
  applyActual(ctx, { enabled: false, useSettingsFile: false, settingsFile: target })
  assert.equal(readFileSync(fallback, 'utf8'), before, 'startup must not write the default production document')
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).thresholdBytes, 32768)
  section = { ...section, thresholdBytes: 49152 }
  listeners.get('settings/document-updated')('unrelated')
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).thresholdBytes, 32768)
  listeners.get('settings/document-updated')('evidence-reducer')
  assert.equal(readFileSync(fallback, 'utf8'), before, 'settings updates must not write the default production document')
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).thresholdBytes, 49152)
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).revision, 2)
}

test('live reducer settings mirror uses the explicit section file at startup and update', async t => {
  await isolatedSettingsMirror(t, true)
})

test('live reducer settings mirror falls back to the configured isolated file, not the production default', async t => {
  await isolatedSettingsMirror(t, false)
})
