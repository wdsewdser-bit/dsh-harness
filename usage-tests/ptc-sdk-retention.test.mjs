import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, open, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SDK_TITLE, findSdkSection, projectSdkRetention, apply, verifySdkCompatibility, AUDITED_SDK_CHAIN } from '../home/profiles/web/plugins/ptc-sdk-retention.mjs'

const fixturePath = 'D:/dsh-test/workspaces/usage-lab-20261001/ptc-sdk.private.txt'
const auditPath = 'D:/dsh-test/docs/usage-audit-20261001/system-sdk-audit.json'
const sdk = await readFile(fixturePath, 'utf8')
const sourceAudit = JSON.parse(await readFile(auditPath, 'utf8'))
const compatibilityManifest = JSON.parse(await readFile('D:/dsh-test/docs/context-opt-20261001/sdk-compatibility-manifest.json', 'utf8'))
const sha = value => createHash('sha256').update(value).digest('hex')
const system = (id, text, kind = 'system-prompt') => ({ id, role: 'system', source: { kind }, content: [{ type: 'text', text }] })
const request = messages => ({ sessionId: 'test-session', provider: 'test-route', model: 'test-model', messages, tools: [{ name: 'run_code', parameters: { type: 'object', required: ['code', 'description'], properties: { code: { type: 'string' }, description: { type: 'string' } } } }] })
const freeze = value => { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze) } return value }
const loadHistoricalSystems = async () => {
  const file = await open(sourceAudit.sourceSnapshot.journal, 'r')
  try {
    const messages = []
    for (const item of sourceAudit.systemBlocks) {
      const bytes = Buffer.alloc(item.compressedFrame.end - item.compressedFrame.start)
      await file.read(bytes, 0, bytes.length, item.compressedFrame.start)
      const event = zstdDecompressSync(bytes).toString('utf8').split('\n').filter(Boolean).map(JSON.parse).find(row => row.seq === item.seq)
      const message = event.data.message
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      const section = text.slice(item.sdk.startUtf16, item.sdk.endUtf16)
      assert.equal(sha(section), item.sdk.sha256)
      messages.push(message)
    }
    return messages
  } finally { await file.close() }
}

test('audited real fixture has exact renderer boundaries and hash', () => {
  const section = findSdkSection(sdk)
  assert.equal(section.status, 'valid')
  assert.equal(section.start, 0)
  assert.equal(section.end, sdk.length)
  assert.equal(section.bytes, 144589)
  assert.equal(section.sha256, sourceAudit.fixture.sha256)
})

test('apply candidate strips only identical historical SDK, preserving policy characters and latest SDK exactly', () => {
  const prefix = 'Policy-before: SECRET-POLICY\n\n'
  const suffix = '\n\nPolicy-after: SECRET-POLICY-SUFFIX\n'
  const original = freeze(request([system('old', prefix + sdk + suffix), system('latest', 'new-policy\n' + sdk + '\nlatest-suffix')]))
  const before = JSON.stringify(original)
  const result = projectSdkRetention(original, { mode: 'apply' })
  assert.equal(result.options.messages[0].content[0].text, prefix + suffix)
  assert.equal(result.options.messages[1], original.messages[1])
  assert.equal(JSON.stringify(original), before)
  assert.equal(result.audit.removedCopies, 1)
  assert.equal(result.audit.retainedCopies, 1)
  assert.equal(result.audit.candidateSavedSdkBytes, Buffer.byteLength(sdk))
  assert.equal(result.audit.before.systemTextBytes - result.audit.after.systemTextBytes, Buffer.byteLength(sdk))
  assert.ok(Object.isFrozen(result.options.messages))
  assert.ok(!JSON.stringify(result.audit).includes('SECRET'))
  assert.ok(!JSON.stringify(result.audit).includes(SDK_TITLE))
})

test('shadow keeps original request and clearly separates actual from candidate savings', () => {
  const input = freeze(request([system('first', sdk), system('second', sdk), system('last', sdk)]))
  const result = projectSdkRetention(input)
  assert.equal(result.options, input)
  assert.equal(result.audit.mode, 'shadow')
  assert.equal(result.audit.removedCopies, 0)
  assert.equal(result.audit.candidateRemovedCopies, 2)
  assert.equal(result.audit.retainedCopies, 3)
  assert.deepEqual(result.audit.before, result.audit.after)
  assert.notDeepEqual(result.audit.before, result.audit.candidateAfter)
})

test('real changed SDK versions keep all five full historical sections', async () => {
  const messages = await loadHistoricalSystems()
  const result = projectSdkRetention(freeze(request(messages)), { mode: 'apply' })
  assert.equal(result.options.messages, messages)
  assert.equal(result.audit.sdkCopies, 5)
  assert.equal(result.audit.changedCopies, 4)
  assert.equal(result.audit.removedCopies, 0)
  assert.equal(result.audit.retainedCopies, 5)
  assert.equal(result.audit.sdkVersions.reduce((sum, row) => sum + row.bytes, 0), 720287)
  assert.ok(result.audit.skipReasons.includes('changed-sdk-history-retained'))
})

test('explicit latest candidate removes four real historical SDK versions with version hash markers', async () => {
  const messages = await loadHistoricalSystems()
  const input = freeze(request(messages))
  const result = projectSdkRetention(input, { mode: 'apply', policy: 'latest', compatibilityManifest })
  assert.equal(result.audit.policy, 'latest')
  assert.equal(result.audit.removedCopies, 4)
  assert.equal(result.audit.retainedCopies, 1)
  assert.equal(result.audit.sdkGrossRemovedBytes, 575698)
  assert.equal(result.audit.candidateSavedSdkBytes, 575698 - result.audit.replacementBytes)
  assert.equal(result.audit.historicalContractInterpretationChanged, true)
  assert.equal(result.audit.compatibilityCertificate.verified, true)
  assert.equal(result.options.messages[4], messages[4])
  for (let index = 0; index < 4; index++) {
    const before = messages[index].content[0].text
    const after = result.options.messages[index].content[0].text
    const section = findSdkSection(before)
    assert.equal(after.slice(0, section.start), before.slice(0, section.start))
    assert.ok(after.endsWith(before.slice(section.end)))
    assert.ok(after.includes('previous tools:sdk sha256=' + section.sha256))
    assert.equal(after.includes(SDK_TITLE), false)
  }
  assert.equal(result.audit.before.systemTextBytes - result.audit.after.systemTextBytes, result.audit.candidateSavedSdkBytes)
})

test('changed latest requires explicit certificate, and unknown/deleted/required/order/latest changes fail open', async () => {
  const known = freeze(request(await loadHistoricalSystems()))
  const missing = projectSdkRetention(known, { mode: 'apply', policy: 'latest' })
  assert.equal(missing.options, known)
  assert.ok(missing.audit.skipReasons.includes('compatibility-certificate-missing'))
  for (const change of [sdk.replace('    command: string;\n', ''), sdk.replace('    timeoutMs?: number;', '    timeoutMs: number;')]) {
    assert.notEqual(change, sdk)
    const input = freeze(request([system('old', sdk), system('new', change)]))
    const result = projectSdkRetention(input, { mode: 'apply', policy: 'latest', compatibilityManifest })
    assert.equal(result.options, input)
    assert.ok(result.audit.skipReasons.includes('compatibility-unknown-sdk-version'))
  }
  assert.equal(verifySdkCompatibility(compatibilityManifest, [AUDITED_SDK_CHAIN[2], AUDITED_SDK_CHAIN[1], AUDITED_SDK_CHAIN[4]]).reason, 'compatibility-version-order-mismatch')
  assert.equal(verifySdkCompatibility(compatibilityManifest, AUDITED_SDK_CHAIN.slice(0, 4)).reason, 'compatibility-latest-version-mismatch')
  assert.equal(verifySdkCompatibility({ ...compatibilityManifest, version: 2 }, AUDITED_SDK_CHAIN).verified, false)
})

test('multi-system and full tool/reasoning chain retain all unaffected message and block identities', () => {
  const assistant = { id: 'assistant', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'reasoning', text: 'SECRET-REASONING' }, { type: 'tool-call', id: 'call-1', name: 'run_code', arguments: 'SECRET-ARGS' }] }
  const result = { id: 'result', role: 'tool', toolCallId: 'call-1', source: { kind: 'tool' }, content: [{ type: 'text', text: 'SECRET-RESULT' }] }
  const user = { role: 'user', content: [{ type: 'text', text: sdk }] }
  const foreign = system('foreign-system', sdk, 'another-producer')
  const changed = sdk.replace('interface ToolArgsMap {', 'interface ToolArgsMap {\n  // changed documentation')
  const input = freeze(request([system('policy', 'Policy without SDK'), system('old', sdk), assistant, result, user, foreign, system('changed', changed), system('latest', sdk)]))
  const projected = projectSdkRetention(input, { mode: 'apply' })
  assert.equal(projected.audit.removedCopies, 1)
  assert.equal(projected.audit.changedCopies, 1)
  for (const index of [0, 2, 3, 4, 5, 6, 7]) assert.equal(projected.options.messages[index], input.messages[index])
  assert.equal(projected.options.messages[1].id, 'old')
  assert.equal(projected.options.messages[1].content[0].text, '')
  assert.ok(!JSON.stringify(projected.audit).includes('SECRET'))
})

test('absent, non-PTC, one-shot, auxiliary and unclear boundaries fail open', () => {
  const cases = [
    [request([system('no', 'plain policy')]), 'no-sdk'],
    [{ ...request([system('old', sdk), system('latest', sdk)]), tools: [{ name: 'bash' }] }, 'not-ptc-run-code-only'],
    [{ ...request([system('old', sdk), system('latest', sdk)]), system: 'one-shot' }, 'one-shot-system-slot'],
    [{ ...request([system('old', sdk), system('latest', sdk)]), purpose: 'compaction' }, 'auxiliary-request'],
    [request([system('old', sdk), system('latest', sdk.slice(0, -3))]), 'unknown-sdk-closing-fence'],
    [request([system('old', sdk), system('latest', sdk.replace('Inside the program:', 'Unverified instructions:'))]), 'unknown-sdk-instructions'],
    [request([system('old', sdk), system('latest', sdk + '\n' + SDK_TITLE)]), 'ambiguous-sdk-title'],
    [request([system('old', sdk), system('latest', 'latest policy omits SDK')]), 'latest-system-has-no-sdk'],
    [request([{ ...system('old', sdk), content: [{ type: 'text', text: sdk }, { type: 'text', text: sdk }] }, system('latest', sdk)]), 'multiple-sdk-sections-in-one-message'],
    [request([system('old', sdk), system('latest', sdk.replace('```ts', '```typescript'))]), 'unknown-sdk-fence'],
  ]
  for (const [input, reason] of cases) {
    freeze(input)
    const result = projectSdkRetention(input, { mode: 'apply' })
    assert.equal(result.options, input, reason)
    assert.equal(result.audit.removedCopies, 0, reason)
    assert.ok(result.audit.skipReasons.includes(reason), reason)
  }
})

test('shadow plugin keeps exact underlying iterable/chunks, next once, HMR never cancels inflight, apply requested is reported unavailable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sdk-retention-'))
  try {
    let handler
    const ctx = { on: (event, listener) => { assert.equal(event, 'llm/stream'); handler = listener; return () => { handler = null } } }
    const dispose = apply(ctx, { directory, mode: 'apply' })
    await dispose.ready
    const chunks = [{ type: 'reasoning-delta', text: 'SECRET-OUTPUT' }, { type: 'usage', usage: { inputTokens: 100, outputTokens: 1 } }, { type: 'finish', reason: { kind: 'stop' } }]
    let closed = false
    const original = (async function* () { try { yield* chunks } finally { closed = true } })()
    let nextCalls = 0
    const input = freeze(request([system('old', sdk), system('latest', sdk)]))
    const stream = handler(input, () => { nextCalls++; return original })
    assert.equal(stream, original)
    assert.equal(nextCalls, 1)
    assert.equal((await stream.next()).value, chunks[0])
    await dispose()
    assert.equal(handler, null)
    assert.equal(closed, false)
    assert.equal((await stream.next()).value, chunks[1])
    assert.equal((await stream.next()).value, chunks[2])
    await stream.next()
    assert.equal(closed, true)
    await dispose.flush()
    const rows = (await readFile(dispose.stats().file, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].mode, 'shadow')
    assert.equal(rows[0].requestedMode, 'apply')
    assert.equal(rows[0].removedCopies, 0)
    assert.equal(rows[0].candidateRemovedCopies, 1)
    assert.ok(rows[0].skipReasons.includes('runtime-request-projection-hook-unavailable'))
    assert.ok(!JSON.stringify(rows).includes('SECRET'))
    assert.ok(!JSON.stringify(rows).includes(SDK_TITLE))
    const runtime = (await readFile(dispose.stats().runtimeFile, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(runtime.map(row => row.event), ['loaded', 'disposed'])
    assert.equal(runtime[0].pid, process.pid)
    assert.match(runtime[0].moduleHash, /^[a-f0-9]{64}$/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('shadow audit persistence failures never affect next or stream error propagation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sdk-retention-invalid-'))
  try {
    let handler
    const ctx = { on: (_event, listener) => { handler = listener; return () => {} }, logger: { warn: () => {} } }
    // A file in place of the audit directory exercises the real fail-open writer.
    await writeFile(join(directory, 'not-directory'), 'fixture')
    const dispose = apply(ctx, { directory: join(directory, 'not-directory') })
    await dispose.ready
    const error = new Error('SECRET-STREAM-ERROR')
    assert.throws(() => handler(freeze(request([system('old', sdk), system('latest', sdk)])), () => { throw error }), caught => caught === error)
    await dispose()
    assert.ok(dispose.stats().failures > 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('explicit apply uses the request bridge, shadow leaves messages intact, HMR unregisters without touching streams', async () => {
  for (const mode of ['shadow', 'apply']) {
    const directory = await mkdtemp(join(tmpdir(), 'sdk-retention-bridge-'))
    try {
      let callback
      let registration
      const bridge = { register: (id, listener, options) => { callback = listener; registration = { id, options }; return () => { callback = null } } }
      const ctx = { get: key => key === 'requestMessageProjection' ? bridge : null, on: () => assert.fail('llm/stream fallback must not register with a supported bridge') }
      const dispose = apply(ctx, { directory, mode, policy: 'latest' })
      await dispose.ready
      assert.equal(registration.options.order, 10)
      const input = freeze(request([system('old', sdk), system('latest', sdk)]))
      const result = callback(input)
      if (mode === 'shadow') assert.equal(result.messages, input.messages)
      else {
        assert.notEqual(result.messages, input.messages)
        assert.equal(result.messages[1], input.messages[1])
        assert.ok(result.messages[0].content[0].text.startsWith('<!-- previous tools:sdk sha256='))
      }
      await dispose()
      assert.equal(callback, null)
      const rows = (await readFile(dispose.stats().file, 'utf8')).trim().split('\n').map(JSON.parse)
      assert.equal(rows[0].integration, 'request-message-projection-bridge')
      assert.equal(rows[0].mode, mode)
      assert.equal(rows[0].removedCopies, mode === 'apply' ? 1 : 0)
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
})
