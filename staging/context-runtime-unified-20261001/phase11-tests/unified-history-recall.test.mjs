import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { controlPlaneFor, readControlPlaneSnapshot, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { createHistoryRecall } from '../home/profiles/web/plugins/team-v15-history-recall.mjs'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

async function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'history-recall-'))
  t.after(() => { resetControlPlaneCache(); rmSync(root, { recursive: true, force: true }) })
  const control = controlPlaneFor('history-own', { directory: root })
  const readDurable = () => readControlPlaneSnapshot(control.file)
  await control.mutateHot('fixture/history-init', {}, null, () => ({}), { deferMs: 0 })
  const events = [{ seq: 0, time: 10, type: 'user/message', data: { content: '\u4e2d\u6587-original-' + 'long'.repeat(300) }, surfaceOp: 'append' }]
  const f = { root, control, readDurable, events, queried: [], allowed: false, agent: { session: { id: 'own' } } }
  const sessionQuery = {
    async readEvent({ sessionId, seq, before = 0, after = 0 }) {
      f.queried.push(sessionId)
      const target = events[seq]
      if (!target) throw Object.assign(new Error('not found'), { code: 'SESSION_QUERY_EVENT_NOT_FOUND' })
      return { session: { id: sessionId }, target: structuredClone(target), events: structuredClone(events.slice(Math.max(0, seq - before), seq + after + 1)) }
    },
    async traceEvent({ sessionId, seq }) { return { session: { id: sessionId }, target: { seq }, replacementChain: [],
      sourceEventSeqs: [...events[seq].sourceEventSeqs ?? []], derivedEventSeqs: events.filter(event => event.sourceEventSeqs?.includes(seq)).map(event => event.seq) } },
  }
  const service = createHistoryRecall({ sessionQuery, control, readDurable, pageBytes: 256,
    authorizeSession: () => f.allowed, ...options })
  f.recall = input => service.recall(input, { agent: f.agent, signal: new AbortController().signal })
  f.locate = () => f.recall({ action: 'locate', seq: 0 })
  f.page = (descriptor, offset) => f.recall({ action: 'read', locator: descriptor.locator, offset,
    expectedRevision: descriptor.sourceRef.sourceRevision, expectedSourceHash: descriptor.sourceRef.sourceHash })
  return f
}

test('raw JSON byte pages, full fetched only after every page, durable hashes and repeat idempotency', async t => {
  const f = await fixture(t), first = await f.locate(), d = first.descriptor
  assert.equal(first.durable, true); assert.equal(first.receipt, null); assert.ok(d.pages > 1)
  assert.equal(d.sourceRef.sourceHash, sha(Buffer.from(JSON.stringify(f.events[0]))))
  const chunks = []
  const last = await f.page(d, (d.pages - 1) * d.pageBytes)
  assert.equal(last.complete, false); assert.equal(last.receipt, null)
  for (let offset = 0; offset < d.bytes; offset += d.pageBytes) {
    const page = await f.page(d, offset)
    const bytes = Buffer.from(page.dataBase64, 'base64')
    assert.equal(bytes.length, page.bytes); assert.equal(sha(bytes), page.pageHash)
    chunks.push(bytes)
  }
  const bundle = Buffer.concat(chunks)
  assert.equal(sha(bundle), d.sourceRef.artifactHash)
  assert.deepEqual(JSON.parse(bundle).target, f.events[0])
  const disk = f.readDurable(), receipt = disk.v15HistoryRecall.reads[d.locator].receipt
  assert.equal(receipt.status, 'full-fetched'); assert.equal(receipt.modelConsumption, 'unknown')
  assert.equal(disk.v15HistoryRecall.debts['history-debt-' + d.locator].status, 'returned-awaiting-dispatch')
  const repeated = await f.page(d, 0)
  assert.deepEqual(repeated.receipt, receipt)
  assert.deepEqual((await f.locate()).descriptor, d)
})

test('wrong revision/hash, unknown/missing locator, missing seq and changed source remain durable debt', async t => {
  const f = await fixture(t), d = (await f.locate()).descriptor
  for (const field of ['expectedRevision', 'expectedSourceHash']) {
    const request = { action: 'read', locator: d.locator, offset: 0, expectedRevision: d.sourceRef.sourceRevision, expectedSourceHash: d.sourceRef.sourceHash }
    request[field] = field === 'expectedRevision' ? 99 : '0'.repeat(64)
    const result = await f.recall(request)
    assert.equal(result.code, 'HISTORY_SOURCE_CAS_CONFLICT'); assert.equal(result.debt.status, 'required')
  }
  assert.equal((await f.recall({ action: 'read', locator: 'unknown' })).code, 'HISTORY_LOCATOR_UNAVAILABLE')
  assert.equal((await f.recall({ action: 'read' })).code, 'HISTORY_LOCATOR_UNAVAILABLE')
  assert.equal((await f.recall({ action: 'locate', seq: 999 })).code, 'SESSION_QUERY_EVENT_NOT_FOUND')
  assert.equal((await f.recall({ action: 'locate' })).code, 'HISTORY_EVENT_UNAVAILABLE')
  f.events[0].data.content = 'changed raw source'
  const changed = await f.page(d, 0)
  assert.equal(changed.code, 'HISTORY_SOURCE_CHANGED'); assert.equal(changed.durable, true)
  assert.ok(Object.values(f.readDurable().v15HistoryRecall.debts).some(row => row.reason === 'HISTORY_SOURCE_CHANGED' && row.status === 'required'))
})

test('caller cannot supply original text, passed status or source revision; cross scope denied before query', async t => {
  const f = await fixture(t)
  for (const key of ['content', 'original', 'status', 'sourceRevision']) await assert.rejects(f.recall({ action: 'locate', seq: 0, [key]: 'passed' }), { code: 'HISTORY_INPUT_INVALID' })
  await assert.rejects(f.recall({ action: 'locate', sessionId: 'foreign', seq: 0 }), { code: 'HISTORY_SCOPE_DENIED' })
  assert.equal(f.queried.length, 0)
  f.allowed = true
  const d = (await f.recall({ action: 'locate', sessionId: 'team-allowed', seq: 0 })).descriptor
  f.allowed = false
  await assert.rejects(f.page(d, 0), { code: 'HISTORY_SCOPE_DENIED' })
  const own = (await f.locate()).descriptor
  f.agent = { session: { id: 'different-reader' } }
  await assert.rejects(f.page(own, 0), { code: 'HISTORY_SCOPE_DENIED' })
})

test('tool call/result references include exact non-adjacent pair; incomplete call cannot full fetch', async t => {
  const f = await fixture(t)
  f.events[0] = { seq: 0, time: 10, type: 'tool/call', data: { callId: 'c', name: 'sample', arguments: {} } }
  f.events.push({ seq: 1, time: 11, type: 'user/message', data: { content: 'neighbor' } })
  const incomplete = (await f.locate()).descriptor
  assert.equal(incomplete.pairingComplete, false)
  for (let offset = 0; offset < incomplete.bytes; offset += incomplete.pageBytes) assert.equal((await f.page(incomplete, offset)).complete, false)
  f.events.push({ seq: 2, time: 12, type: 'tool/result', data: { callId: 'c', result: { value: 'raw-result' } }, sourceEventSeqs: [0] })
  const d = (await f.locate()).descriptor, chunks = []
  assert.equal(d.pairingComplete, true); assert.notEqual(d.locator, incomplete.locator)
  for (let offset = 0; offset < d.bytes; offset += d.pageBytes) chunks.push(Buffer.from((await f.page(d, offset)).dataBase64, 'base64'))
  const bundle = JSON.parse(Buffer.concat(chunks))
  assert.deepEqual(bundle.pairedEvents, [f.events[2]])
  assert.deepEqual(bundle.neighbors, [f.events[1]])
  assert.equal(f.readDurable().v15HistoryRecall.reads[d.locator].receipt.status, 'full-fetched')
})

test('large artifacts and unavailable exact provider never become full fetched', async t => {
  const f = await fixture(t, { maxArtifactBytes: 256 })
  assert.equal((await f.locate()).code, 'HISTORY_ARTIFACT_BUDGET_EXCEEDED')
  const g = await fixture(t, { sessionQuery: {} })
  assert.equal((await g.locate()).code, 'HISTORY_EXACT_PROVIDER_UNAVAILABLE')
})

test('unrelated tool result citations cannot manufacture pairing-complete receipts', async t => {
  const f = await fixture(t)
  f.events[0] = { seq: 0, time: 10, type: 'tool/call', data: { callId: 'original-call', name: 'sample', arguments: {} } }
  f.events.push({ seq: 1, time: 11, type: 'tool/result', data: { callId: 'different-call', result: 'foreign result' }, sourceEventSeqs: [0] })
  const d = (await f.locate()).descriptor
  assert.equal(d.pairingComplete, false)
  for (let offset = 0; offset < d.bytes; offset += d.pageBytes) assert.equal((await f.page(d, offset)).complete, false)
  assert.equal(f.readDurable().v15HistoryRecall.reads[d.locator].receipt, null)
})

test('expired or unavailable raw source invalidates a previously full-fetched receipt and restores debt', async t => {
  const f = await fixture(t), d = (await f.locate()).descriptor
  for (let offset = 0; offset < d.bytes; offset += d.pageBytes) await f.page(d, offset)
  assert.equal(f.readDurable().v15HistoryRecall.reads[d.locator].receipt.status, 'full-fetched')
  f.events.length = 0
  assert.equal((await f.page(d, 0)).code, 'SESSION_QUERY_EVENT_NOT_FOUND')
  const disk = f.readDurable()
  assert.equal(disk.v15HistoryRecall.reads[d.locator].receipt, null)
  assert.equal(disk.v15HistoryRecall.debts['history-debt-' + d.locator].status, 'required')
})
