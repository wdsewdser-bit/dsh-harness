import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tools from '../home/profiles/web/plugins/team-tools-v2-r10.mjs'
import * as policy from '../home/profiles/web/plugins/team-policy.mjs'
import { controlPlaneFor, resetControlPlaneCache, reconcileState } from '../home/profiles/web/plugins/team-control-plane.mjs'

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'delivery-recovery-'))
  const timers = [], registrations = [], disposers = [], sent = []
  const original = globalThis.setInterval
  globalThis.setInterval = (fn, ms) => { timers.push({ fn, ms }); return { unref() {} } }
  const scoped = () => ({
    tools: { register(definition) { registrations.push(definition); return () => {} } },
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
  })
  const root = { id: directory, name: 'lead', session: { id: directory }, ctx: scoped() }
  const child = { id: 'session-original', name: 'worker', session: { id: 'session-original' }, ctx: scoped() }
  const roster = [{ id: root.id, name: 'lead', role: 'lead', status: 'idle' },
    { id: 'session-original', name: 'worker', role: 'teammate', status: 'inactive', level: 1, parentName: 'lead', groupId: 'g' }]
  const membership = actor => ({ id: directory, name: actor === child ? 'worker' : 'lead', role: actor === child ? 'teammate' : 'lead', root })
  const ctx = { agents: { list: () => [root, child] }, logger: { warn() {}, error() {} },
    on() {}, effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose) },
    agentTeams: { tryMembership: membership,
      membership,
      listMembers: () => roster, listTasks: () => [],
      async sendMessage(actor, request) { sent.push(request); return { status: 'accepted', messageId: 'native-' + sent.length } },
    },
  }
  policy.apply(ctx, { controlDir: directory })
  try { tools.apply(ctx, { controlDir: directory, scopesFile: join(directory, 'scope.json'),
    milestonePath: join(directory, 'milestone.json'), rolesDir: directory, wakeAckWaitMs: 20, deliveryTimeoutMs: 100, reconcileIntervalMs: 5000 }) }
  finally { globalThis.setInterval = original }
  const cp = controlPlaneFor(directory, { directory })
  t.after(async () => { for (const dispose of disposers.reverse()) dispose(); await cp.flush(); resetControlPlaneCache(); rmSync(directory, { recursive: true, force: true }) })
  const tick = async () => { timers.find(timer => timer.ms === 5000).fn();
    for (let n = 0; n < 80; n++) await new Promise(resolve => setTimeout(resolve, 20)) }
  return { cp, sent, tick, roster, root, registrations, ctx,
    wake: message => registrations.find(tool => tool.name === 'team_wake').execute({ target: 'worker', message, reason: 'fixture action' }, { agent: root, signal: new AbortController().signal }),
    escalate: args => registrations.filter(tool => tool.name === 'team_escalate').at(-1).execute({ category: 'blocked', summary: 'fixture decision', decision_needed: 'decide', urgency: 'critical', ...args }, { agent: child, signal: new AbortController().signal }) }
}

test('real plugin timer refuses ambiguous legacy retry instead of creating another native message', async t => {
  const f = await fixture(t)
  const claimed = await f.cp.wakeClaim({ episodeId: 'legacy', target: 'worker', sender: 'lead',
    pendingMessage: { messageId: 'p', text: 'private original', status: 'queued' } })
  await f.cp.mutateHot('fixture/age', {}, null, state => { state.dispatches[claimed.dispatch.dispatchId].createdAt = Date.now() - 41 * 3600000 })
  await f.tick()
  assert.equal(f.sent.length, 0)
  const row = f.cp.dispatchGet(claimed.dispatch.dispatchId)
  assert.equal(row.status, 'delivery-failed')
  assert.match(row.lastError, /unconfirmed|binding|admission/)
  await f.cp.flush(); resetControlPlaneCache()
  assert.equal(controlPlaneFor(f.root.id, { directory: f.root.id }).dispatchGet(row.dispatchId).status, 'delivery-failed')
})

test('retry deadline starts at the current attempt, and settled payload stays settled', () => {
  const state = { dispatches: { d: { dispatchId: 'd', wakeup: true, target: 'worker', status: 'queued',
    attempt: 1, createdAt: 1000, pendingMessages: [{ status: 'handled' }, { status: 'rejected' }, { status: 'acked' }] } } }
  assert.equal(reconcileState(state, { deliveryTimeoutMs: 100 }, 5000)[0].kind, 'dispatch-retry')
  assert.deepEqual(reconcileState(state, { deliveryTimeoutMs: 100 }, 5001), [])
  assert.deepEqual(state.dispatches.d.pendingMessages.map(row => row.status), ['handled', 'rejected', 'acked'])
})

test('registered wake persists target and native receipt; deadline and reload never create another native mail', async t => {
  const f = await fixture(t)
  f.ctx.agentTeams.sendMessage = async (actor, request) => { f.sent.push(request); return { status: 'queued', messageId: 'native-queued' } }
  const result = await f.wake('private payload')
  assert.equal(result.status, 'queued')
  const admitted = f.cp.dispatchGet(result.dispatchId)
  assert.equal(admitted.targetId, 'session-original')
  assert.equal(admitted.pendingMessages[0].transport.messageId, 'native-queued')
  await f.cp.mutateHot('fixture/age', {}, null, state => { state.dispatches[result.dispatchId].createdAt = Date.now() - 41 * 3600000 })
  // A different session using the same name is not an authorized recovery.
  f.roster[1].id = 'session-impostor'
  await f.cp.flush(); resetControlPlaneCache()
  await f.tick()
  assert.equal(f.sent.length, 1)
  const failed = f.cp.dispatchGet(result.dispatchId)
  assert.equal(failed.status, 'delivery-failed')
  assert.match(failed.lastError, /stale target binding/)
  await f.tick()
  assert.equal(f.sent.length, 1)
  await assert.rejects(f.wake('private payload'), /wake-stale-target/)
  assert.equal(f.sent.length, 1)
})

test('accepted transport and coalescing do not inject the same payload twice', async t => {
  const f = await fixture(t)
  const first = await f.wake('one payload')
  assert.equal(first.status, 'delivered')
  assert.equal((await f.wake('one payload')).status, 'coalesced')
  assert.equal(f.sent.length, 1)
  assert.equal((await f.wake('second payload')).status, 'delivered')
  assert.equal(f.sent.length, 2)
})

test('a new episode cannot replay an identical native-admitted payload after its deadline', async t => {
  const f = await fixture(t)
  f.ctx.agentTeams.sendMessage = async (actor, request) => { f.sent.push(request); return { status: 'queued', messageId: 'still-native-pending' } }
  const result = await f.wake('original pending payload')
  await f.cp.mutateHot('fixture/age', {}, null, state => { state.dispatches[result.dispatchId].createdAt = Date.now() - 41 * 3600000 })
  await f.tick()
  await assert.rejects(f.wake('original pending payload'), /wake-native-admission-unconfirmed/)
  assert.equal(f.sent.length, 1)
})

test('late native receipt cannot reopen settled dispatch or handled/rejected payload after reload', async t => {
  const f = await fixture(t)
  let release
  const gate = new Promise(resolve => { release = resolve })
  f.ctx.agentTeams.sendMessage = async (actor, request) => { f.sent.push(request); return gate }
  // The tool's bounded timeout is unref'ed, so the fixture owns a short live wait.
  const keepAlive = setTimeout(() => {}, 2000)
  t.after(() => clearTimeout(keepAlive))
  const result = await f.wake('late receipt payload')
  assert.equal(result.status, 'queued')
  await f.cp.mutateHot('fixture/settled', {}, null, state => {
    const row = state.dispatches[result.dispatchId]
    row.status = 'completed'
    row.pendingMessages[0].status = 'handled'
    row.pendingMessages.push({ messageId: 'rejected', status: 'rejected' })
  })
  await f.cp.flush(); resetControlPlaneCache()
  release({ status: 'accepted', messageId: 'late-native' })
  await new Promise(resolve => setTimeout(resolve, 100))
  const row = f.cp.dispatchGet(result.dispatchId)
  assert.equal(row.status, 'completed')
  assert.deepEqual(row.pendingMessages.map(message => message.status), ['handled', 'rejected'])
  await f.tick()
  assert.equal(f.sent.length, 1)
})

test('review P1: legal escalation uses durable native admission and reports the real queued receipt', async t => {
  const f = await fixture(t)
  f.ctx.agentTeams.sendMessage = async (actor, request) => { f.sent.push(request); return { status: 'queued', messageId: 'escalation-native' } }
  const result = await f.escalate()
  assert.equal(f.sent.length, 1)
  assert.equal(result.status, 'queued')
  const dispatch = f.cp.dispatchGet(result.dispatchId)
  assert.equal(dispatch.targetId, f.root.id)
  assert.equal(dispatch.pendingMessages[0].transport.messageId, 'escalation-native')
  assert.equal(dispatch.escalationIds.includes(result.escalationId), true)
  await assert.rejects(f.escalate({ urgency: 'normal' }), /escalation-options/)
  assert.equal(f.sent.length, 1)
})

test('review P1: A then B then A cannot replay unresolved native admission across generations or reload', async t => {
  const f = await fixture(t)
  f.ctx.agentTeams.sendMessage = async (actor, request) => { f.sent.push(request); return { status: 'queued', messageId: 'mail-' + f.sent.length } }
  const a = await f.wake('payload A')
  await f.cp.wakeAcknowledge({ episodeId: a.episodeId, status: 'delivery-failed' }, f.root)
  const b = await f.wake('payload B')
  await f.cp.wakeAcknowledge({ episodeId: b.episodeId, status: 'delivery-failed' }, f.root)
  await f.cp.mutateHot('fixture/terminal-compaction', {}, null, state => {
    for (let index = 0; index < 220; index++) state.dispatches['finished-' + index] = {
      dispatchId: 'finished-' + index, status: 'completed', createdAt: Date.now() + index, resolvedAt: Date.now() + index,
    }
  })
  await f.cp.flush(); resetControlPlaneCache()
  assert.ok(f.cp.dispatchGet(a.dispatchId), 'an unresolved admission reference survives hot terminal compaction')
  await assert.rejects(f.wake('payload A'), /wake-native-admission-unconfirmed/)
  assert.equal(f.sent.length, 2)
  // Explicit business settlement permits a later episode with identical text.
  await f.cp.mutateHot('fixture/business-settled', {}, null, state => {
    state.dispatches[a.dispatchId].pendingMessages[0].status = 'handled'
  })
  assert.equal((await f.wake('payload A')).status, 'queued')
  assert.equal(f.sent.length, 3)
  const index = f.cp.view({ history: false }).wakeAdmissions
  assert.equal(JSON.stringify(index).includes('payload A'), false)
})

test('review P2: terminal transition during fence flush prevents the first native send', async t => {
  const f = await fixture(t), realFlush = f.cp.flush
  let failed = false
  f.cp.flush = async () => {
    await realFlush()
    const row = f.cp.dispatchList().find(row => row.wakeup)
    if (row && !failed) {
      failed = true
      await f.cp.dispatchTransition({ dispatchId: row.dispatchId, status: 'delivery-failed', error: 'fixture terminal during flush' }, f.root)
      await realFlush()
    }
  }
  t.after(() => { f.cp.flush = realFlush })
  const result = await f.wake('expired before native admission')
  assert.equal(f.sent.length, 0)
  assert.equal(result.status, 'delivery-failed')
  assert.equal(f.cp.dispatchGet(result.dispatchId).pendingMessages[0].transport.status, 'cancelled-before-send')
})

test('escalation reports accepted and failed native outcomes without changing normal escalation permissions', async t => {
  const f = await fixture(t)
  assert.equal((await f.escalate()).status, 'delivered')
  f.ctx.agentTeams.sendMessage = async (actor, request) => { f.sent.push(request); throw new Error('fixture native refusal') }
  const failed = await f.escalate({ summary: 'another decision' })
  assert.equal(failed.status, 'delivery-failed')
  assert.equal(f.cp.dispatchGet(failed.dispatchId).status, 'delivery-failed')
  assert.equal(f.sent.length, 2)
})

test('bounded legacy index migration covers older native admissions after durable reload', async t => {
  const f = await fixture(t)
  f.ctx.agentTeams.sendMessage = async (actor, request) => { f.sent.push(request); return { status: 'queued', messageId: 'mail-' + f.sent.length } }
  const a = await f.wake('legacy A')
  await f.cp.wakeAcknowledge({ episodeId: a.episodeId, status: 'delivery-failed' }, f.root)
  const b = await f.wake('legacy B')
  await f.cp.wakeAcknowledge({ episodeId: b.episodeId, status: 'delivery-failed' }, f.root)
  await f.cp.mutateHot('fixture/pre-index-snapshot', {}, null, state => { delete state.wakeAdmissions })
  await f.cp.flush(); resetControlPlaneCache()
  await assert.rejects(f.wake('legacy A'), /wake-native-admission-unconfirmed/)
  assert.equal(f.sent.length, 2)
  assert.equal(f.cp.view({ history: false }).wakeAdmissions.version, 1)
})
