import './host-lifecycle-resolve.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { controlPlaneFor, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { createNativeWindowParticipation } from '../home/profiles/web/plugins/team-v15-window-participation.mjs'
import { Session, installNativeSessionBridge } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
const { Context, getHostLifecycleGate } = await import('@deepseek-ai/cordis')
const { Loader } = await import('@deepseek-ai/cordis-plugin-loader')
const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
const { createScope } = await import('@deepseek-ai/dsh-scope')
const { ToolRuntime } = await import('../app/node_modules/@deepseek-ai/dsh-tools/lib/index.js')
const tick = () => new Promise(resolve => setImmediate(resolve))

test('two real Team control fences bind the host by revision: a third plugin install proceeds and invalidates both; so does revoke', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-window-host-'))
  const ctx = new Context()
  await tick()
  await ctx.plugin(Loader)
  ctx.loader.builtins.fixture = () => {}
  await ctx.loader.create({ id: 'window-fixture', name: 'cordis:fixture', config: {} })
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
  const gate = getHostLifecycleGate(ctx)
  await gate.runAsync(async () => {
    new ToolRuntime(ctx)
    await tick()
    const owner = ctx.inject(['systemPrompt', 'tools'], () => {})
    await owner
    const scope = createScope(owner.ctx, {})
    await scope.ctx.fiber.await()
    scope.ctx.systemPrompt.section({ name: 'window-fixture', order: 1, text: 'actual scoped persona' })
    scope.ctx.tools.register({ name: 'window-fixture', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [] }, execute: () => ({}) })
  })
  const participants = []
  for (const label of ['A', 'B']) {
    const cp = controlPlaneFor('team-' + randomUUID(), { directory })
    await cp.mutateHot('fixture/seed', {}, null, s => { s.marker = label }, { deferMs: 0 })
    const session = Session.create('native-host-' + label)
    const bridge = installNativeSessionBridge(session, { sessionId: session.id, isolated: true, flush: async () => true })
    participants.push(createNativeWindowParticipation({ control: cp, session, bridge, hostContext: ctx,
      loadedFacts: () => ({ binding: { fixture: label }, coveredDomains: [], externalWriters: [] }) }))
  }
  t.after(async () => { await ctx.fiber.dispose(); resetControlPlaneCache(); rmSync(directory, { recursive: true, force: true }) })
  const reads = participants.map(p => structuredClone(p.read()))
  assert.equal(reads[0].host.ownerId, reads[1].host.ownerId)
  assert.ok(participants[0].certificate().domains.includes('config'), JSON.stringify(participants[0].certificate()))
  assert.ok(participants[0].certificate().blockers.includes('loaded-writer-not-participating:identity'), 'host coverage alone is not a complete W2 certificate')
  const leases = await Promise.all(participants.map((p, i) => p.acquire(reads[i])))
  let starts = 0
  const installed = gate.runAsync(async () => { await ctx.plugin(async () => { starts++ }) })
  // No host-wide lease: the install is not held back while the two fences are out.
  await installed
  assert.equal(starts, 1)
  while (gate.snapshot().pending) await tick()
  assert.doesNotThrow(() => ctx.systemPrompt.section({ name: 'concurrent-window', order: 1, text: 'installs while fences are held' }))
  for (const i of [0, 1]) assert.throws(() => participants[i].assertHeld(leases[i], reads[i]), /HOST_STALE_EPOCH/)
  await participants[0].release(leases[0])
  // A recovery fence is bound to the control plane only, so the same churn does not invalidate it.
  const recovering = await participants[0].acquire(reads[0], { recovery: true })
  ctx.systemPrompt.section({ name: 'during-recovery', order: 2, text: 'unrelated churn' })
  assert.equal(participants[0].assertHeld(recovering, reads[0]), true)
  await participants[0].release(recovering)
  await assert.rejects(participants[0].acquire(reads[0]), /WINDOW_PARTICIPANT_CAS_CONFLICT/)
  // A host writer that is still running is neither acquirable against nor committable under.
  const hold = Promise.withResolvers(), pending = gate.runAsync(() => hold.promise)
  await assert.rejects(participants[0].acquire(participants[0].read()), /HOST_PENDING/)
  hold.resolve(); await pending
  gate.revoke('operator security withdrawal')
  assert.throws(() => participants[1].assertHeld(leases[1], reads[1]), /HOST_ADMISSION_VETO/)
  await participants[1].release(leases[1])
  await assert.rejects(participants[1].acquire(participants[1].read()), /HOST_ADMISSION_VETO/)
  gate.clearVeto(gate.snapshot())
  const fresh = participants[1].read()
  assert.ok(fresh.host.epoch > reads[1].host.epoch)
  const lease = await participants[1].acquire(fresh)
  await participants[1].release(lease)
})
