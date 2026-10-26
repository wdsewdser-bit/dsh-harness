import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { controlPlaneFor, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'

function fixture(t, externalAttempted) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'lifecycle-r2-'))
  let current
  t.after(async () => { await current?.flush().catch(() => {}); resetControlPlaneCache(); fs.rmSync(directory, { recursive: true, force: true }) })
  const root = 'lifecycle-r2'
  const high = controlPlaneFor(root, { directory, messageOperationHotLimit: 10 })
  return { directory, root, high, async seed() {
    await high.mutateHot('seed', {}, null, state => {
      state.marker = 'durable'
      state.nested = { accepted: 'durable' }
      state.messageOperations = Object.fromEntries(['a', 'b'].map(key => [key, {
        key, sender: 'sender', operationId: key, payloadHash: key, status: 'completed', receipt: { externalAttempted },
      }]))
    }, { deferMs: 0 })
    resetControlPlaneCache()
    current = controlPlaneFor(root, { directory, messageOperationHotLimit: 1 })
    return current
  } }
}

async function rejectColdWrite(fn) {
  const original = fs.writeFileSync
  fs.writeFileSync = (file, body, ...rest) => {
    if (String(body).includes('"type":"keys"')) throw Error('r2-injected-cold-write')
    return original(file, body, ...rest)
  }
  syncBuiltinESMExports()
  try { await assert.rejects(fn(), /r2-injected-cold-write/) }
  finally { fs.writeFileSync = original; syncBuiltinESMExports() }
}

test('rejected deferred archive cannot contaminate cache or a later durable commit', async t => {
  const { seed } = fixture(t, false)
  const cp = await seed()
  await rejectColdWrite(() => cp.mutateHot('rejected', {}, null, state => {
    state.marker = 'UNPUBLISHED'; state.nested.accepted = 'UNPUBLISHED'
  }, { deferMs: 60_000 }))
  assert.equal(cp.get().marker, 'durable')
  assert.equal(cp.get().nested.accepted, 'durable')
  assert.equal(JSON.parse(fs.readFileSync(cp.file, 'utf8')).marker, 'durable')
  await cp.mutateHot('subsequent', {}, null, state => { state.subsequent = true }, { deferMs: 0 })
  const disk = JSON.parse(fs.readFileSync(cp.file, 'utf8'))
  assert.equal(disk.marker, 'durable')
  assert.equal(disk.nested.accepted, 'durable')
  assert.equal(disk.subsequent, true)
})

test('rejected second archive preserves the first accepted pending mutation through flush and later commits', async t => {
  const { seed } = fixture(t, true)
  const cp = await seed()
  await cp.mutateHot('accepted-pending', {}, null, state => {
    state.marker = 'accepted'; state.nested.accepted = 'accepted'
  }, { deferMs: 60_000 })
  assert.equal(cp.get().marker, 'accepted')
  assert.equal(JSON.parse(fs.readFileSync(cp.file, 'utf8')).marker, 'durable')
  await rejectColdWrite(() => cp.mutateHot('rejected-second', {}, null, state => {
    state.marker = 'UNPUBLISHED'; state.nested.accepted = 'UNPUBLISHED'
    for (const row of Object.values(state.messageOperations)) row.receipt.externalAttempted = false
  }, { deferMs: 60_000 }))
  assert.equal(cp.get().marker, 'accepted')
  assert.equal(cp.get().nested.accepted, 'accepted')
  assert.equal(cp.get().messageOperations.a.receipt.externalAttempted, true)
  assert.equal(JSON.parse(fs.readFileSync(cp.file, 'utf8')).marker, 'durable')
  await cp.flush()
  assert.equal(JSON.parse(fs.readFileSync(cp.file, 'utf8')).marker, 'accepted')
  await cp.mutateHot('subsequent', {}, null, state => { state.subsequent = true }, { deferMs: 0 })
  const disk = JSON.parse(fs.readFileSync(cp.file, 'utf8'))
  assert.equal(disk.marker, 'accepted')
  assert.equal(disk.nested.accepted, 'accepted')
  assert.equal(disk.messageOperations.a.receipt.externalAttempted, true)
  assert.equal(disk.subsequent, true)
})
