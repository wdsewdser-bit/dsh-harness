import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { controlPlaneFor, persistControlPlaneSnapshot, persistControlPlaneSnapshotAsync,
  readControlPlaneSnapshot, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'

test('public writers require CAS and cannot bypass an active window fence', async t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'cp-writer-'))
  t.after(() => { resetControlPlaneCache(); fs.rmSync(directory, { recursive: true, force: true }) })
  const cp = controlPlaneFor('writer-' + randomUUID(), { directory })
  await cp.mutateHot('seed', {}, null, state => { state.marker = 'old' }, { deferMs: 0 })
  const before = readControlPlaneSnapshot(cp.file)
  const next = structuredClone(before)
  next.marker = 'new'
  next.revision++
  assert.throws(() => persistControlPlaneSnapshot(cp.file, next), /CONTROL_WRITER_CAS_REQUIRED/)
  await assert.rejects(persistControlPlaneSnapshotAsync(cp.file, next, { expectedRevision: before.revision - 1 }), /CONTROL_WRITER_CAS_CONFLICT/)
  const fence = await cp.acquireWindowFence(cp.windowFenceFacts().binding, { isolated: true, sessionId: 'lab' })
  assert.throws(() => persistControlPlaneSnapshot(cp.file, next, { expectedRevision: before.revision }), /CONTROL_WRITER_BUSY/)
  assert.equal(readControlPlaneSnapshot(cp.file).marker, 'old')
  const pending = persistControlPlaneSnapshotAsync(cp.file, next, { expectedRevision: before.revision })
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(readControlPlaneSnapshot(cp.file).marker, 'old')
  await fence.release()
  await pending
  assert.equal(cp.get().marker, 'new')
  assert.equal(cp.windowFenceFacts().externalWriters.includes('direct persistControlPlaneSnapshot/Async callers'), false)
})

test('cooperative publication rejects stale and nonmonotonic snapshots without side effects', async t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'cp-writer-cas-'))
  t.after(() => { resetControlPlaneCache(); fs.rmSync(directory, { recursive: true, force: true }) })
  const cp = controlPlaneFor('writer-' + randomUUID(), { directory })
  await cp.mutateHot('seed', {}, null, state => { state.marker = 'seed' }, { deferMs: 0 })
  const before = readControlPlaneSnapshot(cp.file)
  assert.throws(() => persistControlPlaneSnapshot(cp.file, before, { expectedRevision: before.revision }), /CONTROL_WRITER_REVISION_INVALID/)
  const next = structuredClone(before)
  next.revision++
  persistControlPlaneSnapshot(cp.file, next, { expectedRevision: before.revision })
  await assert.rejects(persistControlPlaneSnapshotAsync(cp.file, next, { expectedRevision: before.revision }), /CONTROL_WRITER_CAS_CONFLICT/)
  assert.equal(readControlPlaneSnapshot(cp.file).revision, next.revision)
  assert.equal(fs.existsSync(cp.file + '.lock'), false)
})

test('directory aliases share the physical writer fence', async t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'cp-writer-alias-'))
  const physical = join(directory, 'physical')
  const alias = join(directory, 'alias')
  fs.mkdirSync(physical)
  fs.symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir')
  t.after(() => { resetControlPlaneCache(); fs.rmSync(directory, { recursive: true, force: true }) })
  const rootId = 'writer-' + randomUUID()
  const cp = controlPlaneFor(rootId, { directory: physical })
  await cp.mutateHot('seed', {}, null, state => { state.marker = 'original' }, { deferMs: 0 })
  const next = readControlPlaneSnapshot(cp.file)
  const revision = next.revision
  next.marker = 'alias'
  next.revision++
  const fence = await cp.acquireWindowFence(cp.windowFenceFacts().binding, { isolated: true, sessionId: 'lab' })
  try {
    assert.throws(() => persistControlPlaneSnapshot(join(alias, rootId + '.json'), next, { expectedRevision: revision }), /CONTROL_WRITER_BUSY/)
    assert.equal(readControlPlaneSnapshot(cp.file).marker, 'original')
  } finally { await fence.release() }
  const cpAlias = controlPlaneFor(rootId, { directory: alias })
  await cpAlias.mutateHot('alias-write', {}, null, state => { state.marker = 'cooperative' }, { deferMs: 0 })
  assert.equal(cp.get().marker, 'cooperative')
})
