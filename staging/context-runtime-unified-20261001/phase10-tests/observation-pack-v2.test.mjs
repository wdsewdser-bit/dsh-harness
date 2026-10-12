import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply,
  createObservation,
  renderHandle,
  verifyArchive,
} from '../home/profiles/web/plugins/observation-pack-v2.mjs'

function longText() {
  return Array.from({ length: 200 }, (_, index) => (
    index === 100 ? 'ERROR: boom' : 'line ' + String(index)
  )).join('\n')
}

function harness(config) {
  const listeners = new Map()
    let project
    let onDispatch
  const ctx = {
    logger: { warn() {} },
      requestMessageProjection: { register(name, callback, options) { assert.equal(name, 'observation-pack'); assert.equal(options.order, 20); project = callback; onDispatch = options.onDispatch; return () => {} } },
    on(name, fn) {
      listeners.set(name, fn)
    },
  }
  apply(ctx, { ...config, telemetryDir: config.spillDir })
  return {
    post: listeners.get('tools/post-execute'),
      stream: options => {
        const result = project(options)
        const forwarded = { ...options, ...result }
        onDispatch({ options: forwarded, inputOptions: options, result, receipt: { requestId: 'op-harness', stage: 'handed-to-adapter' } })
        return forwarded
      },
    stats: ctx.observationPackStats,
  }
}

test('createObservation writes a content-addressed archive with a handle', () => {
  const root = mkdtempSync(join(tmpdir(), 'obs2-'))
  try {
    const text = longText()
    const observation = createObservation({
      toolName: 'bash',
      callId: 'call-1',
      blocks: [{ type: 'text', text }],
      spillDir: root,
      previewBytes: 80,
      evidenceChars: 200,
      evidencePattern: /ERROR/i,
    })
    assert.ok(observation)
    assert.equal(readFileSync(observation.filePath, 'utf8'), text)
    assert.equal(verifyArchive(observation), true)
    const handle = renderHandle({ ...observation, fullSends: 2 })
    assert.match(handle, /id: obs_/)
    assert.match(handle, /ERROR: boom/)
    assert.match(handle, /retrieve: read /)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('delayed projection keeps the first two sends and replaces the third', async () => {
  const root = mkdtempSync(join(tmpdir(), 'obs2-'))
  try {
    const text = longText()
    const harnessed = harness({
      maxInlineBytes: 100,
      fullSends: 2,
      previewBytes: 80,
      evidenceChars: 200,
      spillDir: root,
    })
    await harnessed.post(
      { name: 'bash', callId: 'call-1' },
      { isError: false, content: [{ type: 'text', text }] },
      async () => ({ kind: 'accept' }),
    )

    const request = () => ({
      messages: [{ role: 'toolResult', toolCallId: 'call-1', content: [{ type: 'text', text }] }],
    })

    const first = harnessed.stream(request())
    assert.equal(first.messages[0].content[0].text, text)

    const second = harnessed.stream(request())
    assert.equal(second.messages[0].content[0].text, text)

    const third = harnessed.stream(request())
    assert.match(third.messages[0].content[0].text, /\[large tool result replaced/)
    assert.notEqual(third.messages[0].content[0].text, text)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('projection never rewrites the system prefix', async () => {
  const root = mkdtempSync(join(tmpdir(), 'obs2-prefix-'))
  try {
    const text = longText()
    const harnessed = harness({
      maxInlineBytes: 100,
      fullSends: 0,
      previewBytes: 80,
      spillDir: root,
    })
    await harnessed.post(
      { name: 'bash', callId: 'call-prefix' },
      { isError: false, content: [{ type: 'text', text }] },
      async () => ({ kind: 'accept' }),
    )
    const request = harnessed.stream({
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'stable prefix' }] },
        { role: 'toolResult', toolCallId: 'call-prefix', content: [{ type: 'text', text }] },
      ],
    })
    assert.equal(request.messages[0].content[0].text, 'stable prefix')
    assert.notEqual(request.messages[1].content[0].text, text)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a corrupted archive fails open and keeps the original text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'obs2-'))
  try {
    const text = longText()
    const harnessed = harness({
      maxInlineBytes: 100,
      fullSends: 0,
      previewBytes: 80,
      spillDir: root,
    })
    await harnessed.post(
      { name: 'bash', callId: 'call-1' },
      { isError: false, content: [{ type: 'text', text }] },
      async () => ({ kind: 'accept' }),
    )
    const file = join(root, 'objects', 'obs_' + (await import('node:crypto'))
      .createHash('sha256').update(text).digest('hex').slice(0, 24) + '.txt')
    assert.equal(existsSync(file), true)
    writeFileSync(file, 'corrupted')

    const request = harnessed.stream({
      messages: [{ role: 'toolResult', toolCallId: 'call-1', content: [{ type: 'text', text }] }],
    })
    assert.equal(request.messages[0].content[0].text, text)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('reducer receipts and small results are never archived', async () => {
  const root = mkdtempSync(join(tmpdir(), 'obs2-'))
  try {
    const harnessed = harness({ maxInlineBytes: 100, spillDir: root })
    const receipt = 'sol_pi_evidence_receipt_v1\nsummary: ok\n' + 'x'.repeat(200)
    await harnessed.post(
      { name: 'bash', callId: 'receipt' },
      { isError: false, content: [{ type: 'text', text: receipt }] },
      async () => ({ kind: 'accept' }),
    )
    await harnessed.post(
      { name: 'bash', callId: 'small' },
      { isError: false, content: [{ type: 'text', text: 'short' }] },
      async () => ({ kind: 'accept' }),
    )
    assert.equal(existsSync(join(root, 'objects')), false)
    assert.equal(harnessed.stats().archived, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an observation source marker prevents a second packing pass', async () => {
  const root = mkdtempSync(join(tmpdir(), 'obs2-'))
  try {
    const harnessed = harness({ maxInlineBytes: 100, spillDir: root })
    const marked = 'sol_pi_observation_source_v1 {"processor":"observation-pack","result":"archived-handle"}'
      + '\n' + 'x'.repeat(200)
    await harnessed.post(
      { name: 'bash', callId: 'marked' },
      { isError: false, content: [{ type: 'text', text: marked }] },
      async () => ({ kind: 'accept' }),
    )
    assert.equal(existsSync(join(root, 'objects')), false)
    assert.equal(harnessed.stats().archived, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a symlink archive is rejected instead of followed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'obs2-link-'))
  try {
    const text = longText()
    const hash = (await import('node:crypto')).createHash('sha256').update(text).digest('hex')
    const objectDir = join(root, 'objects')
    const link = join(objectDir, 'obs_' + hash.slice(0, 24) + '.txt')
    const target = join(root, 'target.txt')
    writeFileSync(target, text)
    try {
      symlinkSync(target, link, 'file')
    } catch {
      return
    }
    const observation = createObservation({
      toolName: 'bash',
      callId: 'call-link',
      blocks: [{ type: 'text', text }],
      spillDir: root,
      previewBytes: 80,
      evidenceChars: 200,
    })
    assert.equal(observation, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
