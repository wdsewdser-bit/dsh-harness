import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { Session, SessionStore, installNativeSessionBridge } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { ReactLoopAgent, inboxProjectionDefinition, turnBoundaryProjectionDefinition } from '../app/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'
import { ToolRuntime } from '../app/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
import { GoalService } from '../app/node_modules/@deepseek-ai/dsh-goal/lib/index.js'
import JsonlSessionPersistence from '../app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'
import { apply } from '../home/profiles/web/plugins/team-v12-runtime.mjs'
import { deliveryServiceFor } from '../home/profiles/web/plugins/team-v15-delivery-service.mjs'
import { controlPlaneForMember, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { initializeNativeHost } from './native-host-fixture.mjs'

const require = createRequire(new URL('../app/package.json', import.meta.url))
const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)))
const { Context, Service } = await load('cordis')
const { SessionProjectionRegistry } = await load('dsh-session-projection')
const { SystemPrompt } = await load('dsh-system-prompt')
const { AgentRegistry } = await load('dsh-agent')

// The strict-plan switch belongs to a root that actually has teammates. Real GoalService, session, JSONL storage and
// team-v12-runtime; only the Team roster is a fixture whose teammate list the test controls.
async function fixture(t, { requirePlan = true, teammates = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'strict-plan-scope-')), id = basename(root)
  let roster = teammates ? ['worker'] : [], current
  async function open(events, header, options = {}) {
    const ctx = new Context()
    return initializeNativeHost(ctx, async () => {
      const sessions = new SessionStore(ctx), projections = new SessionProjectionRegistry(ctx)
      projections.register(inboxProjectionDefinition); projections.register(turnBoundaryProjectionDefinition)
      new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
      new AgentRegistry(ctx)
      const session = Session.create(id, events, header ?? { id, version: 4, cwd: root, createdAt: Date.now(), isSeeded: false })
      const storage = new JsonlSessionPersistence(new Context(), { root: join(root, 'sessions'), compression: 'none' })
      const handle = events ? await storage.open(id, 'write') : await storage.create(session.header)
      let persisted = events?.length ?? 0
      ctx.on('session/flush', async target => {
        await handle.append(target.snapshotEvents(persisted)); persisted = target.seq; await handle.flush()
      })
      sessions.enter(session); sessions.announce(session)
      const agent = new ReactLoopAgent(ctx, id, { provider: 'fixture', model: 'fixture' }, session)
      ctx.agents.enter(agent, { dispose: async () => {} }); agent.wakeDriver = () => {}
      installNativeSessionBridge(session, { sessionId: id, isolated: true, flush: () => sessions.flush(session) })
      const goals = new GoalService(ctx)
      class FixtureTeams extends Service {
        constructor(ctx) { super(ctx, 'agentTeams') }
        tryMembership(candidate) { if (candidate === agent) return { id, name: 'lead', role: 'lead', tier: 0, root: agent } }
        listMembers() {
          return [{ id: agent.id, name: 'lead', role: 'lead', status: 'idle' },
            ...roster.map(name => ({ id: 'member-' + name, name, role: 'teammate', status: 'idle' }))]
        }
      }
      new FixtureTeams(ctx)
      new ToolRuntime(ctx)
      const dispose = apply(ctx, { controlDir: join(root, 'control'), pluginDir: root, profile: 'web',
        deliveryPolicy: { requirePlan: options.requirePlan ?? requirePlan } })
      // The control plane file must exist before the delivery service reads it.
      await controlPlaneForMember(ctx, agent, { directory: join(root, 'control') }).mutateHot('fixture/init', {}, null, state => { state.boards = {} }, { deferMs: 0 })
      const flush = () => sessions.flush(session)
      return { ctx, session, agent, goals, handle, storage, flush, dispose }
    })
  }
  current = await open()
  const f = {
    get c() { return current }, root,
    setRoster: value => { roster = value },
    // Same journal event the real Team service appends to the root session when a teammate joins.
    joinEvent: async name => {
      current.session.append('team/member', { version: 2, teamId: id, member: { id: 'member-' + name, name, phase: 'active' } })
      await new Promise(resolve => setTimeout(resolve, 50))
    },
    markers: () => current.session.log.filter(event => event.type === 'native/goal-policy-required'),
    strictMarkers: () => current.session.log.filter(event => event.type === 'native/goal-policy-required' && event.data?.requiresPlan === true),
    check: () => deliveryServiceFor(current.ctx, current.agent).checkAll(),
    async reload(options) {
      await current.flush(); await current.handle.close(); await current.ctx.fiber.dispose()
      const h = await current.storage.open(id, 'read'), data = await h.read(), header = h.header
      await h.close()
      current = await open(data.events, header, options)
      return current
    },
  }
  t.after(async () => { await current.flush().catch(() => {}); await current.handle.close().catch(() => {}); await current.ctx.fiber.dispose(); resetControlPlaneCache(); rmSync(root, { recursive: true, force: true }) })
  const goal = current.goals.create(current.agent, { objective: 'Finish the work' })
  await current.flush()
  f.ref = { id: goal.id, revision: goal.revision }
  return f
}

test('R1 a root without teammates writes no strict marker, reports nothing required and completes its goal', async t => {
  const f = await fixture(t)
  assert.equal(f.strictMarkers().length, 0)
  assert.equal(f.markers().length, 1, 'the plain delivery policy marker stays as in production')
  const verdict = f.check()
  assert.equal(verdict.required, false)
  assert.equal(verdict.code, undefined)
  assert.equal((await f.c.goals.complete(f.c.agent, f.ref)).phase, 'complete')
  assert.equal(f.strictMarkers().length, 0)
})

test('R2 the first teammate writes exactly one strict marker; completion then needs a bound plan', async t => {
  const f = await fixture(t)
  assert.equal(f.check().required, false)
  f.setRoster(['worker'])
  await f.joinEvent('worker')
  assert.equal(f.strictMarkers().length, 1)
  const verdict = f.check()
  assert.equal(verdict.required, true)
  assert.equal(verdict.code, 'DELIVERY_PLAN_REQUIRED')
  assert.equal(verdict.deliverable, false)
  await assert.rejects(async () => f.c.goals.complete(f.c.agent, f.ref), { code: 'GOAL_PLAN_UNBOUND' })
  assert.equal(f.c.goals.get(f.c.agent).phase, 'active')
  // More teammates, more events and repeated checks never add a second marker.
  f.setRoster(['worker', 'second'])
  await f.joinEvent('second')
  f.check()
  assert.equal(f.strictMarkers().length, 1)
  assert.equal(f.markers().length, 2, 'one plain policy marker plus one strict marker')
})

test('R2 a teammate that is still provisioning or failed does not switch the root on', async t => {
  const f = await fixture(t)
  const listMembers = f.c.ctx.agentTeams.listMembers.bind(f.c.ctx.agentTeams)
  f.c.ctx.agentTeams.listMembers = a => [...listMembers(a), { id: 'member-x', name: 'x', role: 'teammate', status: 'provisioning' }, { id: 'member-y', name: 'y', role: 'teammate', status: 'failed' }]
  await f.joinEvent('x')
  assert.equal(f.strictMarkers().length, 0)
  assert.equal(f.check().required, false)
})

test('R3 the marker is monotonic: no teammate and no configuration afterwards relaxes it', async t => {
  const f = await fixture(t)
  f.setRoster(['worker'])
  await f.joinEvent('worker')
  f.setRoster([])
  assert.equal(f.check().code, 'DELIVERY_PLAN_REQUIRED')
  await assert.rejects(async () => f.c.goals.complete(f.c.agent, f.ref), { code: 'GOAL_PLAN_UNBOUND' })
  await f.reload({ requirePlan: false })
  assert.equal(f.strictMarkers().length, 1)
  assert.equal(f.check().code, 'DELIVERY_PLAN_REQUIRED')
  await assert.rejects(async () => f.c.goals.complete(f.c.agent, f.ref), { code: 'GOAL_PLAN_UNBOUND' })
  assert.equal(f.c.goals.get(f.c.agent).phase, 'active')
  assert.equal(f.strictMarkers().length, 1)
})

test('R4 a cold restore with teammates but no strict marker writes it at assembly, once', async t => {
  const f = await fixture(t)
  assert.equal(f.strictMarkers().length, 0)
  f.setRoster(['worker'])
  await f.reload()
  assert.equal(f.strictMarkers().length, 1)
  assert.equal(f.check().code, 'DELIVERY_PLAN_REQUIRED')
  await assert.rejects(async () => f.c.goals.complete(f.c.agent, f.ref), { code: 'GOAL_PLAN_UNBOUND' })
  await f.reload()
  assert.equal(f.strictMarkers().length, 1, 'a second restore does not write another')
})

test('R5 with the switch off a root with teammates behaves as before', async t => {
  const f = await fixture(t, { requirePlan: false, teammates: true })
  await f.joinEvent('worker')
  assert.equal(f.strictMarkers().length, 0)
  assert.equal(f.markers().length, 1)
  assert.equal(f.check().required, false)
  await f.reload()
  assert.equal(f.strictMarkers().length, 0)
  assert.equal((await f.c.goals.complete(f.c.agent, f.ref)).phase, 'complete')
})
