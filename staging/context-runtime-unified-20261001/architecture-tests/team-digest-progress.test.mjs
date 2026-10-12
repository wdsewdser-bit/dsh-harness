import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const base = 'D:/dsh-test/staging/architecture-clm-20261001/home/profiles/web/plugins/'
const { apply } = await import(pathToFileURL(base + 'team-activity-digest.mjs'))
const { controlPlaneFor, resetControlPlaneCache } = await import(pathToFileURL(base + 'team-control-plane.mjs'))
const dir = mkdtempSync(join(tmpdir(), 'dsh-digest-progress-'))
const key = 'digest-progress-fixture'
const received = []
const root = { id: key, status: 'idle', followup: (message) => received.push(message) }
const rows = [{ name: 'lead', role: 'lead', status: 'idle' }, { name: 'worker', tier: 2, group: 'alpha', status: 'running' }]
const teams = { tryMembership: () => ({ id: key, root, name: 'lead', role: 'lead' }), listMembers: () => rows }
const listeners = []
const ctx = { agents: { list: () => [root] }, agentTeams: teams, on: (event, fn) => { listeners.push({ event, fn }); return () => {} }, logger: { warn: (message) => { throw new Error(message) } } }
const control = controlPlaneFor(key, { directory: dir })
let stop
const waitUntil = async (fn) => { const end = Date.now() + 2000; while (!fn() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 15)); assert.ok(fn(), 'timer deadline exceeded') }
try {
  stop = apply(ctx, { controlDir: dir, intervalMs: 30 })
  await waitUntil(() => received.length === 1)
  await new Promise((resolve) => setTimeout(resolve, 130))
  assert.equal(received.length, 1, 'unchanged active facts must not followup in new slots')
  console.log('PASS unchanged active Team remains silent across multiple timer slots')
  await control.boardCreate({ boardId: 'global', taskId: 'new-task', subject: 'new work', description: 'changed user facts', workKind: 'discussion', phase: 'draft' })
  await waitUntil(() => received.length === 2)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(received.length, 2)
  console.log('PASS new task facts produce one new digest episode')
  await control.mutateHot('fixture/metadata', {}, undefined, (state) => { state.boards.global.tasks['new-task'].updatedAt++; state.boards.global.tasks['new-task'].revision++ }, { deferMs: 1 })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(received.length, 2)
  console.log('PASS metadata-only task revision does not create progress followup')
  await control.mutateHot('fixture/due', {}, undefined, (state) => { state.v14Waiting = { tickets: { responsibility: { status: 'active', responsible: 'worker', expiresAt: Date.now() + 80 } } } }, { deferMs: 1 })
  await waitUntil(() => received.length === 3)
  assert.ok(JSON.stringify(received[2]).includes('Responsibilities due'))
  await new Promise((resolve) => setTimeout(resolve, 90))
  assert.equal(received.length, 3)
  console.log('PASS actual responsibility expiry emits one reminder and preserves exact due fact')
  await control.flush()
  assert.equal(control.view().activityDigest.sequence, 3)
  console.log('PASS delivered fact/episode sequence persisted')
} finally {
  stop?.()
  await control.flush()
  resetControlPlaneCache()
  rmSync(dir, { recursive: true, force: true })
}
