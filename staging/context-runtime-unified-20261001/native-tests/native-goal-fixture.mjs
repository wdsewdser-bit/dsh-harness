import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Session, SessionStore, installNativeSessionBridge } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { ReactLoopAgent, inboxProjectionDefinition, turnBoundaryProjectionDefinition } from '../app/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'
import { GoalService } from '../app/node_modules/@deepseek-ai/dsh-goal/lib/index.js'
import JsonlSessionPersistence from '../app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'
import { controlPlaneFor, readControlPlaneSnapshot } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { createPlanRegistry } from '../home/profiles/web/plugins/team-v15-plan-registry.mjs'
import { createDeliveryAuthority } from '../home/profiles/web/plugins/team-v15-delivery-authority.mjs'
import { bindGoalDeliveryPlan, createGoalDeliveryGate } from '../home/profiles/web/plugins/team-v15-goal-delivery.mjs'
import { initializeNativeHost } from './native-host-fixture.mjs'
import { TYPERT as goalTypert } from '../app/node_modules/@deepseek-ai/dsh-goal/lib/typert.host.js'

const require = createRequire(new URL('../app/package.json', import.meta.url))
const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)))
const { Context } = await load('cordis')
const { SessionProjectionRegistry } = await load('dsh-session-projection')
const { AgentRegistry } = await load('dsh-agent')
const { SystemPrompt } = await load('dsh-system-prompt')
const { TypertRegistry } = await load('dsh-typert-registry')
const { TypertGatewayService } = await load('dsh-api-gateway')

export async function goalFixture(root, { native = true, restore = false, bindPlan = true, remote = false } = {}) {
  mkdirSync(root, { recursive: true })
  const control = controlPlaneFor('native-goal-fixture', { directory: join(root, 'control') })
  const readDurable = () => readControlPlaneSnapshot(control.file)
  const source = { kind: 'dsh-plan-contract', version: 1, planId: 'p1', scope: ['src'], items: [{
    requirementId: 'r1', taskRefs: [{ boardId: 'main', taskId: 't1' }],
    implementationRefs: ['impl'], testEvidenceRefs: ['test'], acceptanceEvidenceRefs: ['accept'], enablementReceiptRefs: ['deploy'],
  }] }
  const path = join(root, 'plan.json'), body = JSON.stringify(source, null, 2)
  writeFileSync(path, body)
  const registry = createPlanRegistry({ control, readDurable, allowedRoots: [root], authorize: () => true, now: () => 10 })
  const serverContext = { revision: 1, sourceIdentity: { manifestHash: 'a'.repeat(64) }, scope: source.scope,
    environmentFingerprint: 'env', recipeFingerprint: 'recipe', unresolvedDebt: [], blockers: [] }
  let current, flushFailure = false, ackFailure = false
  async function open(events, header, { completionGate = true } = {}) {
    const ctx = new Context()
    return initializeNativeHost(ctx, async () => {
    new SessionStore(ctx)
    if (remote) new TypertRegistry(ctx).register(goalTypert)
    const projections = new SessionProjectionRegistry(ctx)
    projections.register(inboxProjectionDefinition); projections.register(turnBoundaryProjectionDefinition)
    new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
    new AgentRegistry(ctx)
    // Separate storage context makes flush faults deterministic: no automatic
    // session/event writer can persist effects behind the explicit test flush.
    const backend = new JsonlSessionPersistence(new Context(), { root: join(root, 'sessions'), compression: 'none' })
    const session = Session.create('native-goal', events, header ?? {
      id: 'native-goal', version: 4, cwd: root, createdAt: Date.now(), isSeeded: false,
    })
    const handle = events ? await backend.open(session.id, 'write') : await backend.create(session.header)
    let persisted = events?.length ?? 0
    const flush = async () => {
      if (flushFailure) return false
      await handle.append(session.snapshotEvents(persisted))
      persisted = session.seq
      await handle.flush()
      return true
    }
    const agent = new ReactLoopAgent(ctx, session.id, { provider: 'fixture', model: 'fixture' }, session)
    ctx.sessions.enter(session); ctx.sessions.announce(session)
    ctx.agents.enter(agent, { dispose: async () => {} }); agent.wakeDriver = () => {}
    const goals = new GoalService(ctx)
    const gateway = remote ? new TypertGatewayService(ctx, {}) : undefined
    const bridge = native ? installNativeSessionBridge(session, { sessionId: session.id, isolated: true, flush }) : undefined
    const authority = createDeliveryAuthority({ control, readDurable, collectContext: () => structuredClone(serverContext),
      verifyPlanReadback: plan => registry.verify(plan), now: () => 10 })
    const gate = createGoalDeliveryGate({ agent, authority: { ...authority, ackOutbox: (...args) => {
      if (ackFailure) throw Object.assign(new Error('ACK_FAILURE'), { code: 'ACK_FAILURE' })
      return authority.ackOutbox(...args)
    } }, readDurable, getGoal: () => goals.get(agent), flush })
    const disposeGate = bridge || !completionGate ? undefined : goals.registerCompletionGate(agent, gate)
    if (bridge && completionGate) bridge.options.goalCompletion = gate
    return { ctx, session, agent, goals, gateway, bridge, gate, handle, flush, authority, disposeGate }
    })
  }
  async function loadStored(options) {
    const ctx = new Context(), backend = new JsonlSessionPersistence(ctx, { root: join(root, 'sessions'), compression: 'none' })
    const handle = await backend.open('native-goal', 'read'), read = await handle.read(), header = handle.header
    await handle.close()
    return open(read.events, header, options)
  }
  if (restore) {
    current = await loadStored()
    return { get current() { return current }, control, readDurable }
  }
  current = await open()
  const goal = current.goals.create(current.agent, { objective: 'Fully verified fixture delivery' })
  await current.flush()
  const registration = await registry.register({ planId: 'p1', expectedPlanRevision: 0,
    ref: { path, sha256: createHash('sha256').update(body).digest('hex') } }, current.agent)
  const plan = registration.plan
  const binding = { status: 'passed', planId: 'p1', planRevision: plan.planRevision, planHash: plan.planHash, requirementId: 'r1',
    scope: source.scope, sourceIdentity: serverContext.sourceIdentity, environmentFingerprint: 'env', recipeFingerprint: 'recipe',
    boardId: 'main', taskId: 't1', taskRevision: 1, contractRevision: 2 }
  await control.mutateHot('fixture/proofs', {}, current.agent, state => {
    state.boards.main = { tasks: { t1: { id: 't1', ownerName: 'worker', revision: 1, contract: { contractRevision: 2 } } } }
    state.leases.run1 = { runId: 'run1', member: 'worker', taskId: 't1', status: 'active', contractRevision: 2, expiresAt: 100 }
    state.v12Evidence = { records: {
      impl: { ...binding, id: 'impl', kind: 'implementation', locator: 'src/result.mjs', artifactHash: 'artifact' },
      test: { ...binding, id: 'test', kind: 'test' }, accept: { ...binding, id: 'accept', kind: 'acceptance' },
    } }
    state.deploymentReceipts = { deploy: { ...binding, id: 'deploy', kind: 'deployment', entrypoint: 'fixture', loadedHash: 'artifact', runtimeReceiptRef: 'load' } }
    state.runtimeReceipts = { load: { ...binding, id: 'load', kind: 'runtime-load', entrypoint: 'fixture', loadedHash: 'artifact' } }
    state.deliveryAuthorityReceipts = { auth: { ...binding, id: 'auth', kind: 'delivery-authority', owner: 'worker', leaseRef: 'run1', expiresAt: 100 } }
  }, { deferMs: 0 })
  if (bindPlan) await bindGoalDeliveryPlan({ control, readDurable, getGoal: () => current.goals.get(current.agent), agent: current.agent, registry,
    flush: () => current.flush(),
    input: { planId: 'p1', expectedGoalId: goal.id, expectedGoalRevision: goal.revision } })
  async function reload(options) {
    await current.handle.close()
    current = await loadStored(options)
    return current
  }
  return { get current() { return current }, control, readDurable, registry, serverContext, ref: { id: goal.id, revision: goal.revision },
    reload, failFlush: value => { flushFailure = value }, failAck: value => { ackFailure = value } }
}
