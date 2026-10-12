import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { controlPlaneFor } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { createNativeWindowParticipation } from '../home/profiles/web/plugins/team-v15-window-participation.mjs'
import { Session, installNativeSessionBridge } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { Context, getHostLifecycleGate } from '../app/node_modules/@deepseek-ai/cordis-v15/lib/index.js'

test('participation derives native host coverage and never certifies a missing Loader', async () => {
  const cp = controlPlaneFor('host-' + randomUUID(), { directory: mkdtempSync(join(tmpdir(), 'host-participant-')) })
  await cp.mutateHot('fixture/seed', {}, null, () => {}, { deferMs: 0 })
  const session = Session.create('host-participant')
  const bridge = installNativeSessionBridge(session, { sessionId: session.id, isolated: true, flush: async () => true })
  const ctx = new Context()
  await new Promise(resolve => setImmediate(resolve))
  const service = createNativeWindowParticipation({ control: cp, session, bridge, hostContext: ctx,
    loadedFacts: () => ({ binding: {}, coveredDomains: ['identity'], externalWriters: [] }) })
  assert.ok(service.certificate().blockers.some(reason => reason.includes('HOST_DOMAIN_MISSING:loader')))
  await assert.rejects(service.acquire(service.read()), /HOST_DOMAIN_MISSING:loader/)
})

test('actual CP mutate and mutateHot share a held window file lock, with durable CAS', async () => {
  const cp = controlPlaneFor('window-' + randomUUID(), { directory: mkdtempSync(join(tmpdir(), 'window-cp-')) })
  await cp.mutateHot('fixture/seed', {}, null, state => { state.windowTest = 1 }, { deferMs: 0 })
  const expected = cp.windowFenceFacts().binding
  const lease = await cp.acquireWindowFence(expected, { sessionId: 'isolated', isolated: true })
  assert.equal(lease.assertHeld(expected), true)
  let completed = 0
  const writes = [cp.mutate('fixture/full', {}, null, s => { s.windowTest++ }, { deferMs: 0 }),
    cp.mutateHot('fixture/hot', {}, null, s => { s.windowTest++ }, { deferMs: 0 })].map(p => p.then(() => completed++))
  await Promise.resolve(); await Promise.resolve()
  assert.equal(completed, 0)
  assert.equal(cp.get().windowTest, 1)
  await lease.release(); await Promise.all(writes)
  assert.equal(cp.get().windowTest, 3)
  assert.throws(() => lease.assertHeld(expected), /STALE/)
  await assert.rejects(cp.acquireWindowFence(expected, { sessionId: 'isolated', isolated: true }), /CAS/)
})
test('real participant adapter holds actual CP lock and refuses unknown identity/config writers', async () => {
  const cp = controlPlaneFor('window-' + randomUUID(), { directory: mkdtempSync(join(tmpdir(), 'window-participant-')) })
  await cp.mutateHot('fixture/seed', {}, null, s => { s.windowTest = 1 }, { deferMs: 0 })
  const session = Session.create('exact-participant')
  const bridge = installNativeSessionBridge(session, { sessionId: session.id, isolated: true, flush: async () => true })
  let configRevision = 1
  const service = createNativeWindowParticipation({ control: cp, session, bridge,
    loadedFacts: () => ({ binding: { configRevision }, coveredDomains: [], externalWriters: ['roles-file-update'] }) })
  assert.equal(service.verifyCertificate(service.certificate()), false)
  assert.ok(service.certificate().blockers.includes('loaded-writer-not-participating:identity'))
  const expected = service.read(), lease = await service.acquire(expected)
  assert.equal(service.assertHeld(lease, expected), true)
  configRevision++
  assert.throws(() => service.assertHeld(lease, expected), /IDENTITY_CONFIG_CHANGED/)
  await service.release(lease)
})
