import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { controlPlaneFor, readControlPlaneSnapshot, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'

test('control publication fsyncs cold references and main snapshot before durable callbacks', async t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'cp-durability-'))
  t.after(() => { resetControlPlaneCache(); fs.rmSync(directory, { recursive: true, force: true }) })
  const original = fs.fsyncSync
  let synchronizations = 0
  fs.fsyncSync = fd => { synchronizations++; return original(fd) }
  syncBuiltinESMExports()
  t.after(() => { fs.fsyncSync = original; syncBuiltinESMExports() })
  const cp = controlPlaneFor('durability-' + randomUUID(), { directory })
  let acknowledged = false
  await cp.mutateHot('test/durable-cold', {}, null, state => {
    state.v12Evidence = { records: { exact: { id: 'exact', text: 'durable evidence' } } }
  }, { deferMs: 0, afterDurable() {
    assert.ok(synchronizations >= 2, 'cold object and main publication must both sync')
    assert.equal(readControlPlaneSnapshot(cp.file).v12Evidence.records.exact.text, 'durable evidence')
    acknowledged = true
  } })
  assert.equal(acknowledged, true)
})

test('file synchronization failure rejects publication without an afterDurable success', async t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'cp-sync-failure-'))
  t.after(() => { resetControlPlaneCache(); fs.rmSync(directory, { recursive: true, force: true }) })
  const cp = controlPlaneFor('durability-' + randomUUID(), { directory })
  await cp.mutateHot('test/seed', {}, null, state => { state.marker = 'old' }, { deferMs: 0 })
  const original = fs.fsyncSync
  fs.fsyncSync = () => { throw Object.assign(new Error('injected sync failure'), { code: 'EIO' }) }
  syncBuiltinESMExports()
  t.after(() => { fs.fsyncSync = original; syncBuiltinESMExports() })
  let acknowledged = false
  await assert.rejects(cp.mutateHot('test/failed-publication', {}, null, state => { state.marker = 'new' },
    { deferMs: 0, afterDurable() { acknowledged = true } }), /injected sync failure/)
  assert.equal(acknowledged, false)
  assert.equal(readControlPlaneSnapshot(cp.file).marker, 'old')
  assert.equal(cp.get().marker, 'old', 'failed publication cannot remain an in-memory authority')
})

test('failed deferred checkpoint discards unpublished authority before the next writer', async t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'cp-deferred-sync-'))
  t.after(() => { resetControlPlaneCache(); fs.rmSync(directory, { recursive: true, force: true }) })
  const cp = controlPlaneFor('durability-' + randomUUID(), { directory })
  await cp.mutateHot('seed', {}, null, state => { state.marker = 'old' }, { deferMs: 0 })
  await cp.mutateHot('pending', {}, null, state => { state.marker = 'unpublished' }, { deferMs: 60_000 })
  const original = fs.fsyncSync
  fs.fsyncSync = () => { throw Object.assign(new Error('deferred sync failure'), { code: 'EIO' }) }
  syncBuiltinESMExports()
  try {
    await assert.rejects(cp.flush(), /deferred sync failure/)
  } finally { fs.fsyncSync = original; syncBuiltinESMExports() }
  assert.equal(cp.get().marker, 'old')
  await cp.mutateHot('next', {}, null, state => { state.next = true }, { deferMs: 0 })
  assert.equal(readControlPlaneSnapshot(cp.file).marker, 'old')
})
