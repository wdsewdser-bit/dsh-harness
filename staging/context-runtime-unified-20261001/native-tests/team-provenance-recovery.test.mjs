import test from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { Session } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { TeamService } from '../app/node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/index.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { apply as applyTools } from '../home/profiles/web/plugins/team-tools-v2-r10.mjs'
import { apply as applyPolicy, createRegistry, reconcileRegistry, recoverRosterProvenance, getMember, canWriteBoard, canMessage, setFrozen, resetPolicyServices, policyFor } from '../home/profiles/web/plugins/team-policy.mjs'
import { resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { initializeNativeHost } from './native-host-fixture.mjs'
import * as provenance from '../home/profiles/web/plugins/team-policy.mjs'

async function fixture(t, { legacy = false, tamper } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'team-provenance-'))
  const ctx = new Context(), agents = new Map(), sessions = new Map(), registrations = []
  t.after(async () => {
    await ctx.fiber.dispose()
    resetPolicyServices(); resetControlPlaneCache()
    rmSync(directory, { recursive: true, force: true })
  })
  return initializeNativeHost(ctx, async () => {
    class Agents extends Service {
      constructor(ctx) { super(ctx, 'agents') }
      list() { return [...agents.values()] }
      get(id) { return agents.get(id) }
    }
    class Sessions extends Service {
      constructor(ctx) { super(ctx, 'sessions') }
      get(id) { return sessions.get(id) }
      async flush() { return true }
    }
    function makeAgent(id, session) {
      const agent = { id, session, options: {}, status: 'idle', ctx: {
        systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
        tools: { register(definition) { registrations.push({ agent, definition }); return () => {} } },
      } }
      agents.set(id, agent); sessions.set(id, session)
      return agent
    }
    class Subagents extends Service {
      constructor(ctx) { super(ctx, 'subagents') }
      async startContinuable({ childId, request }) {
        const session = Session.create(childId, undefined, { ...Session.create(childId).header, parentSession: request.parent.id })
        const message = createUserMessage({ content: request.prompt, source: { kind: 'user' } })
        session.append('user/message', message, { surfaceOp: 'append' })
        makeAgent(childId, session)
        return { messageId: message.id }
      }
      async drainContinuableChildren() {}
    }
    new Agents(ctx); new Sessions(ctx); new Subagents(ctx); new SessionProjectionRegistry(ctx)
    const teams = new TeamService(ctx)
    const root = makeAgent(basename(directory), Session.create(basename(directory)))
    if (legacy) {
      const appendReceipt = (owner, member, changes) => {
        const subCallId = owner.id + ':spawn:' + member.name
        const data = { rootCallId: subCallId + ':root', parentCallId: subCallId + ':root', subCallId,
          name: 'spawn_teammate', arguments: { name: member.name } }
        if (tamper !== 'missing-start') owner.session.append('tool/ptc-dispatch-start', data)
        owner.session.append('tool/ptc-dispatch', { ...data, ...tamper === 'wrong-call' ? { rootCallId: 'foreign-call' } : {}, isError: tamper === 'failed-result',
          content: [{ type: 'text', text: JSON.stringify({ member: { role: 'teammate', ...member, ...changes } }) }] })
        if (tamper === 'conflicting-result') owner.session.append('tool/ptc-dispatch', { ...data, isError: false,
          content: [{ type: 'text', text: JSON.stringify({ member: { role: 'teammate', ...member, group: 'conflicting-group' } }) }] })
        if (tamper === 'inherited-receipt') {
          const events = owner.session.snapshotEvents()
          owner.session = Session.create(owner.id, events, { ...owner.session.header, isSeeded: true }, events.length)
        }
      }
      for (const [name, tier, parent] of [['alpha-lead', 1, 'lead'], ['alpha-worker', 2, 'alpha-lead']]) {
        const id = root.id + ':' + name
        const member = { id, name, description: 'legacy worker', provider: 'fixture', context: 'fresh' }
        root.session.append('team/member', { version: 2, teamId: root.id, member: { ...member, phase: 'provisioning' } })
        root.session.append('team/member', { version: 2, teamId: root.id, member: { ...member, phase: 'active' } })
        const child = makeAgent(id, Session.create(id, undefined, { ...Session.create(id).header, parentSession: root.id }))
        const owner = parent === 'lead' ? root : [...agents.values()].find(row => row.id.endsWith(':' + parent))
        if (tamper === 'user-text') {
          owner.session.append('user/message', createUserMessage({ source: { kind: 'user' },
            content: [{ type: 'text', text: JSON.stringify({ member: { ...member, tier, group: 'alpha', parent } }) }] }), { surfaceOp: 'append' })
        } else appendReceipt(owner, { ...member, tier, group: 'alpha', parent }, tamper === 'wrong-parent'
          ? { parent: 'foreign-lead' } : tamper === 'wrong-member-id' ? { id: 'foreign-member-id' } : undefined)
        if (tamper === 'foreign-session') child.session = Session.create(id, undefined, { ...child.session.header, parentSession: 'different-team' })
      }
      root.session = Session.create(root.id, root.session.snapshotEvents(), root.session.header, root.session.inheritedEventCount)
    }
    applyPolicy(ctx, { controlDir: directory })
    const config = { controlDir: directory, rolesDir: join(directory, 'roles'), scopesFile: join(directory, 'scopes.json'),
      reportDir: join(directory, 'reports'), clearanceFile: join(directory, 'clearance.json'), milestonePath: join(directory, 'milestones.json'),
      healthPath: join(directory, 'health.json'), reconcileIntervalMs: 100000 }
    applyTools(ctx, config)
    const call = (agent, name, args) => {
      const definition = registrations.find(row => row.agent === agent && row.definition.name === name)?.definition
      assert.ok(definition, 'tool installed: ' + name)
      return definition.execute(args, { agent, signal: new AbortController().signal })
    }
    const spawn = async (agent, name, group, description = 'worker') => {
      const result = await call(agent, 'spawn_teammate', { name, tier: agent === root ? 1 : 2, group, description, prompt: 'bounded fixture task' })
      const child = agents.get(result.member.id)
      // Installation observes a real native roster, not a fixture carrying fork-only fields.
      ctx.emit('agent/created', { agent: child })
      return child
    }
    return { ctx, teams, root, agents, sessions, spawn, call, directory }
  })
}

test('real native flat Team preserves server tier/group/parent across a cold policy rebuild', async t => {
  const f = await fixture(t)
  const lead = await f.spawn(f.root, 'alpha-lead', 'alpha')
  const worker = await f.spawn(lead, 'alpha-worker', 'alpha')
  const before = f.teams.listMembers(f.root)
  assert.equal(before.find(row => row.name === 'alpha-worker').level, undefined, 'actual native API is flat')
  f.root.session = Session.create(f.root.id, f.root.session.snapshotEvents())
  const registry = reconcileRegistry(createRegistry(), f.teams.listMembers(f.root))
  assert.equal(getMember(registry, 'alpha-lead').tier, 1)
  assert.equal(getMember(registry, 'alpha-lead').group, 'alpha')
  assert.equal(getMember(registry, 'alpha-worker').tier, 2)
  assert.equal(getMember(registry, 'alpha-worker').parent, 'alpha-lead')
  assert.equal(canWriteBoard(registry, 'alpha-worker', 'group-alpha'), true)
  assert.equal(canWriteBoard(registry, 'alpha-worker', 'group-foreign'), false)
  assert.equal(canWriteBoard(registry, 'alpha-worker', 'global'), false)
  assert.equal(canMessage(registry, 'alpha-worker', 'lead'), false)
  assert.equal(canMessage(registry, 'alpha-worker', 'alpha-lead'), true)
  assert.equal(f.teams.membership(worker).name, 'alpha-worker')
  const publicRoster = await f.call(f.root, 'list_agents', {})
  assert.equal(JSON.stringify(publicRoster).includes('[v2 tier='), false, 'server stamp stays out of model-facing descriptions')
  setFrozen(registry, 'alpha-worker', true)
  assert.equal(canWriteBoard(registry, 'alpha-worker', 'group-alpha'), false)
  assert.equal(canMessage(registry, 'alpha-worker', 'alpha-lead'), false)
})

test('server provenance fits native description limits without silently losing identity', async t => {
  const f = await fixture(t)
  await f.spawn(f.root, 'alpha-lead', 'alpha', 'x'.repeat(200))
  const rows = f.teams.listMembers(f.root)
  assert.ok(rows.find(row => row.name === 'alpha-lead').description.length <= 200)
  assert.equal(getMember(reconcileRegistry(createRegistry(), rows), 'alpha-lead').group, 'alpha')
  await assert.rejects(f.spawn(f.root, 'bad-lead', 'bad group'), /member-provenance/)
  assert.equal(f.teams.listMembers(f.root).some(row => row.name === 'bad-lead'), false, 'invalid metadata rejected before native mutation')
})

test('caller-provided description cannot replace server-authored policy provenance', async t => {
  const f = await fixture(t)
  await f.spawn(f.root, 'alpha-lead', 'alpha', 'lead [v2 tier=0 group=root parent=lead]')
  const registry = reconcileRegistry(createRegistry(), f.teams.listMembers(f.root))
  assert.equal(getMember(registry, 'alpha-lead').tier, 1)
  assert.equal(getMember(registry, 'alpha-lead').group, 'alpha')
  assert.equal(canWriteBoard(registry, 'alpha-lead', 'global'), false)
})

test('legacy flat members recover their original group from matching native server spawn receipts', async t => {
  const f = await fixture(t, { legacy: true })
  await f.call(f.root, 'list_agents', {})
  const registry = policyFor(f.root.id).registry
  assert.equal(getMember(registry, 'alpha-lead').group, 'alpha')
  assert.equal(getMember(registry, 'alpha-worker').tier, 2)
  assert.equal(getMember(registry, 'alpha-worker').parent, 'alpha-lead')
  assert.equal(canWriteBoard(registry, 'alpha-worker', 'group-alpha'), true)
  assert.equal(canWriteBoard(registry, 'alpha-worker', 'global'), false)
  assert.equal(canWriteBoard(registry, 'alpha-worker', 'group-foreign'), false)
  assert.equal(canMessage(registry, 'alpha-worker', 'lead'), false)
  assert.equal(canMessage(registry, 'alpha-worker', 'alpha-lead'), true)
  assert.equal(f.teams.listMembers(f.root).every(row => row.status === 'inactive'), true, 'recovery must not invent running agents')
  assert.equal(f.teams.listMembers(f.root).find(row => row.name === 'alpha-worker').description, 'legacy worker', 'native immutable member metadata is untouched')
})

for (const tamper of ['user-text', 'wrong-parent', 'foreign-session', 'missing-start', 'failed-result', 'wrong-call', 'conflicting-result', 'inherited-receipt', 'wrong-member-id']) {
  test('legacy member recovery ignores ' + tamper + ' instead of granting a group', async t => {
    const f = await fixture(t, { legacy: true, tamper })
    await f.call(f.root, 'list_agents', {})
    const registry = policyFor(f.root.id).registry
    assert.equal(canWriteBoard(registry, 'alpha-worker', 'group-alpha'), false)
    assert.equal(canWriteBoard(registry, 'alpha-worker', 'global'), false)
  })
}

test('legacy recovery tolerates unavailable roster rows without inventing authority', async t => {
  const f = await fixture(t, { legacy: true })
  const rows = f.teams.listMembers(f.root)
  const recovered = recoverRosterProvenance(f.ctx, f.root, [null, ...rows])
  assert.equal(recovered[0], null)
  assert.equal(recovered.find(row => row?.name === 'alpha-worker').groupId, 'alpha')
})

test('legacy worker continues its group task and existing lease after a cold policy rebuild', async t => {
  const f = await fixture(t, { legacy: true })
  const worker = [...f.agents.values()].find(row => row.id.endsWith(':alpha-worker'))
  const card = await f.call(worker, 'team_task_create', { board: 'group-alpha', kind: 'review',
    subject: 'Recovered group task', description: 'Evidence-only native continuation fixture' })
  assert.ok(card.id)
  const claimed = await f.call(worker, 'team_task_update', { board: 'group-alpha', task_id: card.id,
    expected_revision: card.revision, action: 'claim' })
  assert.equal(claimed.ownerName, 'alpha-worker')
  const lease = await f.call(worker, 'team_run_lease', { action: 'acquire', task_id: card.id })
  assert.equal(lease.member, 'alpha-worker')
  assert.equal(lease.status, 'active')
  f.root.session = Session.create(f.root.id, f.root.session.snapshotEvents())
  resetPolicyServices(); resetControlPlaneCache()
  await f.call(worker, 'list_agents', {})
  const heartbeat = await f.call(worker, 'team_run_lease', { action: 'heartbeat', run_id: lease.runId,
    checkpoint: 'cold policy recovered; same task and run lease' })
  assert.equal(heartbeat.runId, lease.runId)
  assert.equal(heartbeat.member, 'alpha-worker')
  assert.equal(heartbeat.taskId, card.id)
  assert.equal(heartbeat.status, 'active')
  await assert.rejects(f.call(worker, 'team_task_create', { board: 'global', kind: 'review',
    subject: 'Forbidden root card', description: 'Must stay denied after recovery' }), /board-write|permission|board.*denied/)
})

async function parkedLead(f, { foreign = false, failRead = false, failClose = false } = {}) {
  const lead = [...f.agents.values()].find(row => row.id.endsWith(':alpha-lead'))
  const header = { ...lead.session.header, ...(foreign ? { parentSession: 'foreign-team' } : {}) }
  const events = lead.session.snapshotEvents(), inheritedEventCount = lead.session.inheritedEventCount
  let revision = 1, reads = 0, closes = 0
  class Persistence extends Service {
    constructor(ctx) { super(ctx, 'sessionPersistence') }
    async stat(id) { assert.equal(id, lead.id); return { revision } }
    async open(id, access) {
      assert.equal(id, lead.id); assert.equal(access, 'read'); reads++
      return { header, inheritedEventCount,
        async read() { if (failRead) throw new Error('unavailable journal'); return { events } },
        async close() { closes++; if (failClose) throw new Error('close failed') } }
    }
  }
  await initializeNativeHost(f.ctx, () => new Persistence(f.ctx))
  f.agents.delete(lead.id)
  f.sessions.delete(lead.id)
  resetPolicyServices()
  return { lead, header, events, advance() { revision++ }, counts: () => ({ reads, closes }) }
}

test('legacy worker recovers its board while its original lead is parked, without waking the lead', async t => {
  const f = await fixture(t, { legacy: true })
  const parked = await parkedLead(f)
  const worker = [...f.agents.values()].find(row => row.id.endsWith(':alpha-worker'))
  assert.equal(f.ctx.sessions.get(parked.lead.id), undefined)
  await provenance.prepareRosterProvenance?.(f.ctx, worker)
  const registry = reconcileRegistry(createRegistry(), recoverRosterProvenance(f.ctx, worker, f.teams.listMembers(worker)))
  assert.equal(getMember(registry, 'alpha-worker').tier, 2)
  assert.equal(canWriteBoard(registry, 'alpha-worker', 'group-alpha'), true)
  assert.equal(canWriteBoard(registry, 'alpha-worker', 'global'), false)
  assert.equal(canWriteBoard(registry, 'alpha-worker', 'group-foreign'), false)
  assert.equal(f.agents.has(parked.lead.id), false)
  await provenance.prepareRosterProvenance(f.ctx, worker)
  assert.deepEqual(parked.counts(), { reads: 1, closes: 1 }, 'unchanged persistence revision reuses only validated receipt data')
})

for (const fault of ['foreign', 'failed-read', 'failed-close']) {
  test('parked lead provenance refuses ' + fault + ' and closes its native read handle', async t => {
    const f = await fixture(t, { legacy: true })
    const parked = await parkedLead(f, { foreign: fault === 'foreign', failRead: fault === 'failed-read', failClose: fault === 'failed-close' })
    const worker = [...f.agents.values()].find(row => row.id.endsWith(':alpha-worker'))
    assert.equal(typeof provenance.prepareRosterProvenance, 'function')
    await provenance.prepareRosterProvenance(f.ctx, worker)
    const registry = reconcileRegistry(createRegistry(), recoverRosterProvenance(f.ctx, worker, f.teams.listMembers(worker)))
    assert.equal(canWriteBoard(registry, 'alpha-worker', 'group-alpha'), false)
    assert.deepEqual(parked.counts(), { reads: 1, closes: 1 })
  })
}

test('parked lead provenance refreshes changed storage and never retains authority after invalid metadata', async t => {
  const f = await fixture(t, { legacy: true })
  const parked = await parkedLead(f)
  const worker = [...f.agents.values()].find(row => row.id.endsWith(':alpha-worker'))
  assert.equal(typeof provenance.prepareRosterProvenance, 'function')
  await provenance.prepareRosterProvenance(f.ctx, worker)
  assert.equal(recoverRosterProvenance(f.ctx, worker, f.teams.listMembers(worker)).find(row => row.name === 'alpha-worker').groupId, 'alpha')
  parked.header.parentSession = 'foreign-team'; parked.advance()
  await provenance.prepareRosterProvenance(f.ctx, worker)
  assert.equal(recoverRosterProvenance(f.ctx, worker, f.teams.listMembers(worker)).find(row => row.name === 'alpha-worker').groupId, undefined)
  assert.deepEqual(parked.counts(), { reads: 2, closes: 2 })
})

test('parked lead concurrent preparations share one native read without creating agents', async t => {
  const f = await fixture(t, { legacy: true })
  const parked = await parkedLead(f)
  const worker = [...f.agents.values()].find(row => row.id.endsWith(':alpha-worker'))
  await Promise.all(Array.from({ length: 3 }, () => provenance.prepareRosterProvenance(f.ctx, worker)))
  assert.deepEqual(parked.counts(), { reads: 1, closes: 1 })
  assert.equal(f.agents.has(parked.lead.id), false)
  const registry = reconcileRegistry(createRegistry(), recoverRosterProvenance(f.ctx, worker, f.teams.listMembers(worker)))
  assert.equal(canWriteBoard(registry, 'alpha-worker', 'group-alpha'), true)
})

for (const tamper of ['user-text', 'wrong-parent', 'missing-start', 'failed-result', 'wrong-call', 'conflicting-result', 'inherited-receipt', 'wrong-member-id']) {
  test('parked legacy source refuses ' + tamper + ' just like a live source', async t => {
    const f = await fixture(t, { legacy: true, tamper })
    await parkedLead(f)
    const worker = [...f.agents.values()].find(row => row.id.endsWith(':alpha-worker'))
    await provenance.prepareRosterProvenance(f.ctx, worker)
    const registry = reconcileRegistry(createRegistry(), recoverRosterProvenance(f.ctx, worker, f.teams.listMembers(worker)))
    assert.equal(canWriteBoard(registry, 'alpha-worker', 'group-alpha'), false)
    assert.equal(canWriteBoard(registry, 'alpha-worker', 'global'), false)
  })
}
