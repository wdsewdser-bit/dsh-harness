import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { controlPlaneFor, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { messageOperationIdentity, runMessageOperation } from '../home/profiles/web/plugins/team-message-operation.mjs'
import { archiveOperations, operationFind, operationGet, captureInbox, updateInboxIndex, queryInbox } from '../home/profiles/web/plugins/team-control-lifecycle.mjs'

function fixture(t, limit = 2) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'control-lifecycle-'))
  t.after(() => { resetControlPlaneCache(); fs.rmSync(directory, { recursive: true, force: true }) })
  const root = 'lifecycle-' + randomUUID()
  return { directory, root, cp: controlPlaneFor(root, { directory, messageOperationHotLimit: limit }) }
}
const input = id => messageOperationIdentity({ sender: 'owner', target: 'worker', operationId: id, delivery: 'direct', payload: { id } })
const row = i => ({ ...input(String(i)), status: 'completed', revision: 2, receipt: { externalAttempted: false, result: 'body-' + i } })

test('inbox queries equal the full scan at 0/1k/10k and isolate targets without changing bodies', async t => {
  const { cp, directory, root } = fixture(t)
  for (const size of [0, 1000, 10000]) {
    await cp.mutateHot('inbox-seed', {}, null, state => {
      state.v12RoomWake.inbox = Object.fromEntries(Array.from({ length: size }, (_, i) => ['msg-' + i, {
        messageId: 'msg-' + i, target: i % 2 ? 'a' : 'b', sender: 'sender',
        originalText: '  exact body ' + i + '  ', status: i % 3 ? 'queued' : 'handled',
      }]))
    }, { deferMs: 0 })
    const expected = Object.values(cp.get().v12RoomWake.inbox).filter(r => r.target === 'a' && !['handled', 'rejected'].includes(r.status) && r.messageId !== 'msg-1')
    const got = cp.inboxPending({ target: 'a', nativeIds: ['msg-1'] })
    assert.deepEqual(got, expected)
    const samples = []
    for (let i = 0; i < 50; i++) { const at = performance.now(); cp.inboxPending({ target: 'a' }); samples.push(performance.now() - at) }
    samples.sort((a, b) => a - b)
    console.log(JSON.stringify({ inboxSize: size, pending: got.length, lookupP50Ms: samples[25], lookupP95Ms: samples[47] }))
    if (got[0]) { got[0].originalText = 'mutated'; assert.notEqual(cp.inboxPending({ target: 'a' })[0].originalText, 'mutated') }
    assert.throws(() => cp.inboxPending({ target: 'b', member: 'a' }), /scope/)
  }
  const id = cp.inboxPending({ target: 'a' })[0].messageId
  await Promise.all([cp.mutateHot('ack', {}, null, state => { state.v12RoomWake.inbox[id].status = 'handled' }, { deferMs: 0 }),
    cp.mutateHot('ack', {}, null, state => { state.v12RoomWake.inbox[id].status = 'handled' }, { deferMs: 0 })])
  assert.equal(cp.inboxPending({ target: 'a' }).some(r => r.messageId === id), false)
  const expected = cp.inboxPending({ target: 'a' })
  resetControlPlaneCache()
  const restarted = controlPlaneFor(root, { directory })
  assert.deepEqual(restarted.inboxPending({ target: 'a' }), expected)
  const oldest = expected[0].messageId
  await restarted.mutateHot('ack-outside-panel-window', {}, null, state => {
    assert.ok(state.v12RoomWake.inbox[oldest], 'old pending body must remain available to the mutation')
    state.v12RoomWake.inbox[oldest].status = 'handled'
  }, { deferMs: 0 })
  assert.equal(restarted.inboxPending({ target: 'a' }).some(r => r.messageId === oldest), false)
  const hmr = await import('../home/profiles/web/plugins/team-control-plane.mjs?lifecycle-hmr=' + randomUUID())
  t.after(() => hmr.resetControlPlaneCache())
  assert.deepEqual(hmr.controlPlaneFor(root, { directory }).inboxPending({ target: 'a' }), restarted.inboxPending({ target: 'a' }))
})

test('legacy inbox cold batch, row overlay and hot precedence rebuild without writes', () => {
  const blocks = new Map([['batch', { one: { messageId: 'one', target: 'a', status: 'queued', originalText: 'old' } }],
    ['overlay', { messageId: 'one', target: 'a', status: 'handled', originalText: 'new' }]])
  const state = { coldHistory: { inboxBatch: 'batch', inbox: { one: 'overlay' } }, v12RoomWake: { inbox: {} } }
  captureInbox(state, ref => blocks.get(ref))
  assert.deepEqual(queryInbox(state, 'a'), [])
  delete state.inboxPendingIndex
  state.v12RoomWake.inbox.one = { messageId: 'one', target: 'a', status: 'queued', originalText: 'hot' }
  captureInbox(state, ref => blocks.get(ref))
  assert.equal(queryInbox(state, 'a')[0].originalText, 'hot')
  delete state.inboxPendingIndex
  state.v12RoomWake.acknowledgedInbox = { one: { target: 'a', status: 'handled' } }
  captureInbox(state, ref => blocks.get(ref))
  assert.deepEqual(queryInbox(state, 'a'), [])
})

test('archived duplicate, conflict, wrapper concurrency and restart remain idempotent', async t => {
  const { cp, root, directory } = fixture(t, 1)
  let effects = 0
  const execute = async () => { effects++; return { externalAttempted: false, result: 'original' } }
  const first = input('first')
  await Promise.all([runMessageOperation(cp, first, null, execute), runMessageOperation(cp, first, null, execute)])
  assert.equal(effects, 1)
  await runMessageOperation(cp, input('second'), null, execute)
  assert.equal(Object.keys(cp.get().messageOperations).length, 1)
  assert.equal(cp.messageOperationGet(first.key).receipt.result, 'original')
  assert.equal((await runMessageOperation(cp, first, null, execute)).duplicate, true)
  await assert.rejects(cp.messageOperationBegin({ ...first, payloadHash: 'different' }), /conflict/)
  await assert.rejects(cp.messageOperationBegin({ ...first, key: 'changed-scope' }), /conflict/)
  const recovered = await cp.messageOperationRecover({ ...first, recovery: { expected_revision: 2, reason: 'read terminal' } })
  assert.equal(recovered.status, 'completed')
  resetControlPlaneCache()
  const restarted = controlPlaneFor(root, { directory })
  assert.equal((await runMessageOperation(restarted, first, null, execute)).duplicate, true)
  assert.equal(effects, 2)
  await restarted.gc({ allowDelete: true, coldGcGraceMs: 0 })
  assert.equal(restarted.messageOperationGet(first.key).receipt.result, 'original')
  const hot = JSON.parse(fs.readFileSync(restarted.file, 'utf8'))
  const ref = Object.values(hot.messageOperationArchive.keys)[0]
  fs.unlinkSync(restarted.file + '.cold-' + ref + '.json')
  resetControlPlaneCache()
  const broken = controlPlaneFor(root, { directory })
  assert.throws(() => broken.messageOperationGet(first.key), /cold.*(missing|corrupt)/)
  await assert.rejects(broken.messageOperationBegin(first), /cold.*(missing|corrupt)/)
})

test('unsafe and unfinished operations exceed configured limits without removal', async t => {
  const { cp } = fixture(t, 1)
  await cp.mutateHot('unsafe-seed', {}, null, state => {
    state.messageOperations = Object.fromEntries(['reserved', 'partial-failed', 'completed'].map((status, i) => {
      const value = row(i); value.status = status; value.receipt = { externalAttempted: true }; return [value.key, value]
    }))
    delete state.messageOperationHotIndex
  }, { deferMs: 0 })
  assert.equal(Object.keys(cp.get().messageOperations).length, 3)
  assert.equal(cp.get().messageOperationLifecycle.overLimit, true)
  for (let i = 0; i < 3; i++) assert.ok(cp.messageOperationGet(input(String(i)).key))
})

test('legacy completed receipts compact even when the triggering reservation is a duplicate', async t => {
  const { cp, root, directory } = fixture(t, 10)
  await cp.mutateHot('legacy-seed', {}, null, state => {
    const a = row('a'), b = row('b'); state.messageOperations = { [a.key]: a, [b.key]: b }
    delete state.messageOperationHotIndex
  }, { deferMs: 0 })
  resetControlPlaneCache()
  const low = controlPlaneFor(root, { directory, messageOperationHotLimit: 1 })
  assert.equal((await low.messageOperationBegin(input('a'))).claimed, false)
  assert.equal(Object.keys(low.get().messageOperations).length, 1)
  assert.equal(low.messageOperationGet(input('a').key).receipt.result, 'body-a')
})

test('100k receipts use bounded hot keys and shard roots; lookup timing is diagnostic', () => {
  const blocks = new Map()
  const write = value => { const raw = JSON.stringify(value); const hash = createHash('sha256').update(raw).digest('hex'); blocks.set(hash, JSON.parse(raw)); return hash }
  const read = ref => { assert.ok(blocks.has(ref), 'missing block'); return blocks.get(ref) }
  const state = { messageOperations: {} }
  for (let i = 0; i < 100000; i++) { const value = row(i); state.messageOperations[value.key] = value }
  const start = performance.now()
  archiveOperations(state, read, write, { messageOperationHotLimit: 100 })
  const archiveMs = performance.now() - start
  assert.equal(Object.keys(state.messageOperations).length, 100)
  assert.equal(Object.keys(state.messageOperationHotIndex.rows).length, 100)
  assert.ok(Object.keys(state.messageOperationArchive.keys).length <= 256)
  assert.ok(Object.keys(state.messageOperationArchive.identities).length <= 256)
  const timings = []
  for (let i = 0; i < 200; i++) {
    const value = input(String(i * 499)); const at = performance.now()
    assert.equal(operationFind(state, value, read).payloadHash, value.payloadHash)
    assert.equal(operationGet(state, value.key, read).receipt.result, 'body-' + i * 499)
    timings.push(performance.now() - at)
  }
  timings.sort((a, b) => a - b)
  console.log(JSON.stringify({ scale: 100000, hot: 100, roots: Object.keys(state.messageOperationArchive.keys).length + Object.keys(state.messageOperationArchive.identities).length, archiveMs, lookupP50Ms: timings[100], lookupP95Ms: timings[190] }))
})

test('archive write failure leaves all original hot receipts and root publication unchanged', () => {
  const value = row(0), other = row(1)
  const state = { messageOperations: { [value.key]: value, [other.key]: other } }
  let writes = 0
  assert.throws(() => archiveOperations(state, () => { throw Error('unexpected read') }, () => { if (++writes === 2) throw Error('crash-before-publication'); return 'a'.repeat(64) }, { messageOperationHotLimit: 1 }), /crash/)
  assert.equal(Object.keys(state.messageOperations).length, 2)
  assert.equal(state.messageOperationArchive, undefined)
})

test('failed main publication leaves orphan shards unconfirmed and GC can reclaim them', async t => {
  const { cp, directory, root } = fixture(t, 10)
  await cp.mutateHot('seed', {}, null, state => { const a = row('a'), b = row('b'); state.messageOperations = { [a.key]: a, [b.key]: b } }, { deferMs: 0 })
  resetControlPlaneCache()
  const low = controlPlaneFor(root, { directory, messageOperationHotLimit: 1 })
  const original = fs.fsyncSync
  let rejected = false
  fs.fsyncSync = fd => {
    const buf = Buffer.alloc(fs.fstatSync(fd).size)
    try { fs.readSync(fd, buf, 0, buf.length, 0) } catch (error) { if (error.code === 'EBADF') return original(fd); throw error }
    if (buf.includes(Buffer.from('"messageOperationArchive"'))) { rejected = true; throw Error('injected-main-publication-crash') }
    return original(fd)
  }
  syncBuiltinESMExports()
  try { await assert.rejects(low.messageOperationsArchive(), /injected-main-publication-crash/) }
  finally { fs.fsyncSync = original; syncBuiltinESMExports() }
  assert.equal(rejected, true)
  assert.equal(low.get().messageOperationArchive, undefined)
  assert.equal(Object.keys(low.get().messageOperations).length, 2)
  const health = low.storageHealth()
  assert.ok(health.orphanFiles > 0, JSON.stringify(health))
  await low.gc({ allowDelete: true, coldGcGraceMs: 0 })
  await low.messageOperationsArchive()
  assert.equal(Object.keys(low.get().messageOperations).length, 1)
  assert.equal(low.messageOperationGet(input('a').key).receipt.result, 'body-a')
})

test('100k durable migration and cold lookup after restart do not hydrate archive into hot state', async t => {
  const { cp, root, directory } = fixture(t, 100)
  const start = performance.now()
  await cp.mutateHot('100k-seed', {}, null, state => {
    state.messageOperations = {}
    for (let i = 0; i < 100000; i++) { const value = row(i); state.messageOperations[value.key] = value }
  }, { deferMs: 0 })
  const archiveMs = performance.now() - start
  resetControlPlaneCache()
  const restarted = controlPlaneFor(root, { directory, messageOperationHotLimit: 100 })
  const timings = []
  for (let i = 0; i < 100; i++) {
    const value = input(String(i * 997)), at = performance.now()
    assert.equal(restarted.messageOperationGet(value.key).receipt.result, 'body-' + i * 997)
    assert.equal((await restarted.messageOperationBegin(value)).claimed, false)
    timings.push(performance.now() - at)
  }
  timings.sort((a, b) => a - b)
  const hot = JSON.parse(fs.readFileSync(cp.file, 'utf8'))
  assert.equal(Object.keys(hot.messageOperations).length, 100)
  assert.equal(Object.keys(restarted.get().messageOperations).length, 100)
  assert.equal(Object.keys(hot.messageOperationHotIndex.rows).length, 100)
  assert.equal(hot.messageOperationLifecycle.archivedCount, 99900)
  console.log(JSON.stringify({ durableScale: 100000, hot: 100, archiveMs, hotBytes: fs.statSync(cp.file).size,
    lookupAndBeginP50Ms: timings[50], lookupAndBeginP95Ms: timings[95] }))
})
