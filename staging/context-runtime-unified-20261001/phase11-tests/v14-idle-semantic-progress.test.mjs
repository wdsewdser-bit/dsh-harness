import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Session } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { apply, idleWakeHash } from '../home/profiles/web/plugins/team-idle-watch-v6.mjs'
import { controlPlaneFor, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { armedRoots, clearBackgroundWakes } from '../home/profiles/web/plugins/team-armed-roots.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const inputState = { boards: { global: { tasks: {} } } }
const inputEvent = source => ({ type: 'user/message', data: { source, content: [{ type: 'text', text: 'input' }] } })
function inputFixture() {
  const events = [inputEvent({ kind: 'user' })]
  const session = { get seq() { return events.length }, eventAt: index => events[index] }
  return { events, hash: () => idleWakeHash(inputState, { session }, []) }
}

test('runtime context refresh is not a new work input', () => {
  const f = inputFixture(), before = f.hash()
  f.events.push(inputEvent({ kind: 'runtime-context' }))
  assert.equal(f.hash(), before)
})

test('versioned Team projection is not a new work input', () => {
  const f = inputFixture(), before = f.hash()
  f.events.push(inputEvent({ kind: 'team-message', plugin: 'team-v12-runtime', form: 'snapshot', summary: 'versioned Team context delta' }))
  assert.equal(f.hash(), before)
})

test('observer notices stay stable while genuine user and peer inputs rearm', () => {
  const f = inputFixture(), before = f.hash()
  f.events.push(inputEvent({ kind: 'team-message', plugin: 'team-idle-watch' }))
  assert.equal(f.hash(), before)
  f.events.push(inputEvent({ kind: 'team-message', plugin: 'team-activity-digest' }))
  assert.equal(f.hash(), before)
  f.events.push(inputEvent({ kind: 'team-message', plugin: 'tool-agent-team-v2', form: 'notice' }))
  const peer = f.hash()
  assert.notEqual(peer, before)
  f.events.push(inputEvent({ kind: 'user' }))
  assert.notEqual(f.hash(), peer)
})

test('same-turn drained quiet batch is acknowledged by the reminder, including cold replay', () => {
  const f = inputFixture(), before = f.hash()
  f.events.push(inputEvent({ kind: 'team-message', plugin: 'tool-agent-team-v2', summary: 'team quiet batch' }))
  f.events.push(inputEvent({ kind: 'team-message', plugin: 'team-idle-watch' }))
  f.events.push(inputEvent({ kind: 'team-message', plugin: 'team-v12-runtime', form: 'snapshot' }))
  assert.equal(f.hash(), before)
  const session = { seq: f.events.length, eventAt: index => f.events[index] }
  assert.equal(idleWakeHash(inputState, { session }, []), before)
})

test('a separate quiet batch after a reminder or processed in its own turn rearms', () => {
  const f = inputFixture()
  f.events.push(inputEvent({ kind: 'team-message', plugin: 'team-idle-watch' }))
  const first = f.hash()
  f.events.push(inputEvent({ kind: 'team-message', plugin: 'tool-agent-team-v2', summary: 'team quiet batch' }))
  assert.notEqual(f.hash(), first)
  f.events.push({ type: 'request/header', data: {} })
  const separatelyProcessed = f.hash()
  f.events.push(inputEvent({ kind: 'team-message', plugin: 'team-idle-watch' }))
  assert.equal(f.hash(), separatelyProcessed)
})

async function waitFor(fn) {
  const until = Date.now() + 2000
  while (!fn() && Date.now() < until) await sleep(10)
  assert.ok(fn(), 'expected actual wake within deadline')
}
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'idle-semantic-')), key = 'idle-semantic'
  const delivered = [], hooks = new Map(), disposers = []
  const warnings = []
  let mount
  const root = { id: key, status: 'idle', session: Session.create(key), followup: message => delivered.push(message) }
  const rows = [{ id: key, name: 'lead', role: 'lead', status: 'idle' }, { id: 'worker-id', name: 'worker', role: 'teammate', status: 'inactive' }]
  const teams = { listMembers: () => rows, tryMembership: agent => agent === root ? { id: key, root, name: 'lead', role: 'lead' } : undefined }
  const ctx = { agents: { list: () => [root] }, agentTeams: teams, logger: { info() {}, warn(message) { warnings.push(message) } },
    inject(_names, callback) { mount = callback; callback(ctx) },
    get(name) { return name === 'agents' ? this.agents : name === 'agentTeams' ? teams : undefined },
    effect(install) { disposers.push(install()) },
    on(name, hook) { hooks.set(name, hook); return () => hooks.delete(name) } }
  const control = controlPlaneFor(key, { directory })
  const install = () => { apply(ctx, { controlDir: directory, settleMs: 5, intervalMs: 5, bootstrapScanMs: 5, retryAfterMs: 25 }); return disposers.at(-1) }
  const arm = () => hooks.get('agent/status')({ agent: root, status: 'running' })
  const append = (text, plugin) => root.session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: plugin ? { kind: 'team-message', plugin, form: 'notice' } : { kind: 'user' } }), { surfaceOp: 'append' })
  armedRoots().clear(); clearBackgroundWakes()
  t.after(async () => {
    for (const dispose of disposers) await dispose?.()
    await control.flush(); resetControlPlaneCache(); armedRoots().clear(); clearBackgroundWakes()
    rmSync(directory, { recursive: true, force: true })
  })
  return { root, rows, delivered, control, install, arm, append, warnings, reinject: () => mount(ctx) }
}

test('unchanged idle state stays quiet beyond retry window and plugin reload; real changes rearm without a lifetime cap', async t => {
  const f = await fixture(t)
  f.append('start bounded task')
  const stop = f.install(); f.arm()
  await waitFor(() => f.delivered.length === 1)
  f.append('watcher reminder', 'team-idle-watch')
  f.arm()
  await sleep(110)
  assert.equal(f.delivered.length, 1, 'own wake and elapsed time are not progress')
  await stop?.(); f.install(); f.arm()
  await sleep(100)
  assert.equal(f.delivered.length, 1, 'durable de-dup survives observer reload')
  for (let index = 0; index < 4; index++) {
    f.append('new operator instruction ' + index)
    f.arm()
    await waitFor(() => f.delivered.length === index + 2)
  }
  await f.control.boardCreate({ boardId: 'global', taskId: 'new-task', subject: 'new task', description: 'actionable change', phase: 'draft', workKind: 'discussion' })
  await waitFor(() => f.delivered.length === 6)
  await f.control.mutate('fixture/metadata', {}, undefined, state => { state.boards.global.tasks['new-task'].revision++; state.boards.global.tasks['new-task'].updatedAt++ })
  await sleep(100)
  assert.equal(f.delivered.length, 6, 'revision-only churn is not an actionable change')
})

test('a failed idle delivery is recorded and retried, without duplicating a successful delivery', async t => {
  const f = await fixture(t)
  let attempts = 0
  f.root.followup = message => {
    if (++attempts === 1) throw new Error('fixture transport unavailable')
    f.delivered.push(message)
  }
  f.install(); f.arm()
  await waitFor(() => f.delivered.length === 1)
  await sleep(110)
  assert.equal(attempts, 2)
  const episodes = Object.values(f.control.view({ history: false }).wakeEpisodes)
  assert.equal(episodes.filter(row => row.status === 'delivery-failed').length, 1)
  assert.equal(episodes.filter(row => row.status === 'delivered').length, 1)
  assert.ok(f.warnings.some(message => message.includes('transport unavailable')))
})

test('overlapping observers claim a semantic wake once', async t => {
  const f = await fixture(t)
  f.install(); f.install(); f.arm()
  await waitFor(() => f.delivered.length === 1)
  await sleep(100)
  assert.equal(f.delivered.length, 1)
  assert.equal(Object.keys(f.control.view({ history: false }).wakeEpisodes).length, 1)
})

test('disposing an observer drains its pending claim without waking the root afterward', async t => {
  const f = await fixture(t)
  const barrier = Promise.withResolvers(), entered = Promise.withResolvers()
  const claim = f.control.wakeClaim
  f.control.wakeClaim = async (...args) => { entered.resolve(); await barrier.promise; return claim(...args) }
  const stop = f.install(); f.arm()
  await entered.promise
  const stopped = stop()
  barrier.resolve()
  await stopped
  assert.equal(f.delivered.length, 0)
  assert.equal(Object.values(f.control.view({ history: false }).wakeEpisodes)[0].status, 'cancelled')
})

test('an explicit waiting deadline creates one new reminder, not an automatic resolution or timer loop', async t => {
  const f = await fixture(t)
  await f.control.mutate('fixture/waiting', {}, undefined, state => {
    state.v14Waiting = { tickets: { ticket: { taskId: 'task', status: 'open', responsible: 'operator',
      unblockCondition: { type: 'manual' }, nextCheckAt: Date.now() + 180 } } }
  })
  f.install(); f.arm()
  await waitFor(() => f.delivered.length === 1)
  await waitFor(() => f.delivered.length === 2)
  await sleep(100)
  assert.equal(f.delivered.length, 2)
  assert.equal(f.control.view({ history: false }).v14Waiting.tickets.ticket.status, 'open')
})

test('a pending idle claim rechecks that every member is still stopped before delivery', async t => {
  const f = await fixture(t), release = Promise.withResolvers()
  const claim = f.control.wakeClaim
  let entered = false
  f.control.wakeClaim = async (...args) => { entered = true; await release.promise; return claim(...args) }
  f.install(); f.arm()
  await waitFor(() => entered)
  f.rows[1].status = 'running'
  release.resolve()
  await sleep(80)
  assert.equal(f.delivered.length, 0)
  assert.equal(Object.values(f.control.view({ history: false }).wakeEpisodes)[0].status, 'cancelled')
})

test('dependency reinjection reactivates the observer without reviving the disposed generation', async t => {
  const f = await fixture(t)
  const stop = f.install(); f.arm()
  await waitFor(() => f.delivered.length === 1)
  await stop()
  await f.control.boardCreate({ boardId: 'global', taskId: 'new-task', subject: 'new work', description: 'after service replacement', workKind: 'discussion', phase: 'draft' })
  f.reinject(); f.arm()
  await waitFor(() => f.delivered.length === 2)
  await sleep(80)
  assert.equal(f.delivered.length, 2)
})

test('reinjection cannot make an old pending generation deliver again', async t => {
  const f = await fixture(t), release = Promise.withResolvers()
  const claim = f.control.wakeClaim
  let entered = false
  f.control.wakeClaim = async (...args) => { entered = true; await release.promise; return claim(...args) }
  const stop = f.install(); f.arm()
  await waitFor(() => entered)
  const stopped = stop()
  f.reinject(); f.arm()
  release.resolve()
  await stopped
  await waitFor(() => f.delivered.length === 1)
  await sleep(100)
  assert.equal(f.delivered.length, 1)
  assert.ok(Object.values(f.control.view({ history: false }).wakeEpisodes).some(row => row.status === 'cancelled'))
})
