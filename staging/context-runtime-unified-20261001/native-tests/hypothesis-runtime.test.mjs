import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import './host-lifecycle-resolve.mjs'
import { createHypothesisRuntime } from '../home/profiles/web/plugins/team-v15-hypothesis-runtime.mjs'
import { controlPlaneFor, readControlPlaneSnapshot, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'

const load = name => import('@deepseek-ai/' + name)
const { Session, SessionStore } = await import('../app/node_modules/@deepseek-ai/dsh-session/lib/index.js')
const { ReactLoopAgent, inboxProjectionDefinition, turnBoundaryProjectionDefinition } = await import('../app/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js')
const { ToolRuntime, validateJsonSchemaValue } = await import('../app/node_modules/@deepseek-ai/dsh-tools/lib/index.js')
const { Context, getHostLifecycleGate } = await load('cordis')
const { SessionProjectionRegistry } = await load('dsh-session-projection')
const { SystemPrompt } = await load('dsh-system-prompt')
const { AgentRegistry } = await load('dsh-agent')
const { HarnessError } = await load('dsh-llm')

async function setup(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'native-hypothesis-'))
  const ctx = new Context()
  const tick = () => new Promise(resolve => setImmediate(resolve))
  await tick()
  return getHostLifecycleGate(ctx).runAsync(async () => {
  const sessions = new SessionStore(ctx)
  await tick()
  const projections = new SessionProjectionRegistry(ctx)
  await tick()
  projections.register(inboxProjectionDefinition)
  projections.register(turnBoundaryProjectionDefinition)
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  await tick()
  new AgentRegistry(ctx)
  await tick()
  const session = Session.create('hypothesis-native')
  sessions.enter(session)
  sessions.announce(session)
  const agent = new ReactLoopAgent(ctx, session.id, { provider: 'fixture', model: 'fixture' }, session)
  ctx.agents.enter(agent, { dispose: async () => {} })
  await tick()
  const cp = controlPlaneFor('native-hypothesis', { directory })
  await cp.mutateHot('test/seed', {}, null, state => {
    state.boards = { global: { tasks: { t1: { ownerName: 'worker', revision: 1, contract: { contractRevision: 1 } } } } }
    state.leases = { l1: { member: 'worker', taskId: 't1', contractRevision: 1, status: 'active', expiresAt: Date.now() + 60000 } }
    state.v15PlanDelivery = { taskPlanBindings: { global: { t1: { planId: 'p1', planRevision: 1, planHash: 'hash1' } } },
      plans: { p1: { planId: 'p1', planRevision: 1, planHash: 'hash1',
      items: [{ requirementId: 'req1', taskRefs: [{ boardId: 'global', taskId: 't1' }],
        implementationRefs: [], testEvidenceRefs: [], acceptanceEvidenceRefs: [] }] } } }
  }, { deferMs: 0 })
  const intent = { requirementId: 'req1', hypothesisId: 'parser-boundary', failureCause: 'parser failure',
    hypothesis: 'The current parser rejects the exact documented field.', probe: { kind: 'standard', method: 'minimal-case' } }
  const runtimeOptions = { ctx: agent.ctx, memoryFile: join(directory, 'memory.json'),
    readDurable: () => readControlPlaneSnapshot(cp.file), collectContext: () => ({}), verifyPlan: plan => plan.planHash === 'hash1',
    ...(options.durableIntent ? { control: cp, authorizeTool: (name, current) => current === agent
      && tools.schemas(agent).some(tool => tool.name === name) && name !== 'team_v12' }
      : { readAttempt: exec => exec.name === 'probe' ? structuredClone(intent) : undefined }),
    resolveActor: current => current === agent ? { name: 'worker', sessionId: session.id, rootTeamId: 'native-hypothesis' } : undefined,
    maxNoProgressAttempts: options.maxNoProgressAttempts ?? 3 }
  const runtime = createHypothesisRuntime(runtimeOptions)
  const tools = new ToolRuntime(ctx)
  await tick()
  let bodies = 0
  let lastExec
  const parameters = { type: 'object', properties: { command: { type: 'string' } },
    required: ['command'], additionalProperties: false }
  tools.register({ name: 'probe', parameters,
    output: { schema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
      render: (_args, value) => [{ type: 'text', text: String(value.count) }] },
    execute: async (args, exec) => {
      assert.deepEqual(validateJsonSchemaValue(parameters, args, 'args'), [])
      bodies++; lastExec = exec; await options.body?.(exec); return { count: bodies }
    },
    ...(options.finalizeContent ? { finalizeContent: options.finalizeContent } : {}) })
  const execute = (callId, args = { command: 'exact probe' }) => tools.execute({ name: 'probe', arguments: args,
    callId, agent, signal: new AbortController().signal })
  const bindingInput = () => ({ planId: 'p1', expectedPlanRevision: 1, expectedPlanHash: 'hash1',
    boardId: 'global', taskId: 't1', expectedTaskRevision: 1, expectedContractRevision: 1,
    expectedGeneration: 0, toolName: 'probe', ...structuredClone(intent) })
  t.after(async () => { runtime.dispose(); await runtime.flush().catch(() => {}); resetControlPlaneCache(); rmSync(directory, { recursive: true, force: true }) })
  return { ctx, agent, cp, runtime, runtimeOptions, execute, intent, bindingInput, bodies: () => bodies, lastExec: () => lastExec }
  })
}

test('native schema dispatch uses server intent and exact membership, not extra tool fields or agent.name', async t => {
  const f = await setup(t)
  const result = await f.execute('native-call')
  assert.equal(result.isError, false, JSON.stringify(result))
  await f.runtime.flush()
  const entry = f.runtime.observe(f.lastExec()).entries[0]
  assert.equal(entry.hypothesisId, 'parser-boundary')
  assert.equal(entry.identity.sessionId, f.agent.session.id)
  assert.equal(entry.attempts[0].serverObservation.status, 'passed')
  assert.equal(f.bodies(), 1)
  const forged = await f.execute('forged-arg', { command: 'exact probe', hypothesisAttempt: { status: 'passed' } })
  assert.equal(forged.isError, true)
  assert.equal(f.bodies(), 1)
})

test('durable server intent binds exact authority with CAS, reads physical state and rejects stale ownership before body', async t => {
  const f = await setup(t, { durableIntent: true })
  const receipt = await f.runtime.bind(f.bindingInput(), f.agent)
  assert.equal(receipt.durable, true)
  assert.equal(receipt.generation, 1)
  const disk = readControlPlaneSnapshot(f.cp.file)
  assert.equal(Object.values(disk.v15HypothesisIntents.records)[0].spec.hypothesisId, 'parser-boundary')
  await assert.rejects(f.runtime.bind(f.bindingInput(), f.agent), /HYPOTHESIS_INTENT_CAS_CONFLICT/)
  assert.equal((await f.execute('bound-call')).isError, false)
  await f.runtime.flush()
  await f.cp.mutateHot('test/transfer', {}, null, state => { state.boards.global.tasks.t1.ownerName = 'another' }, { deferMs: 0 })
  const stale = await f.execute('stale-bound-call')
  assert.equal(stale.isError, true)
  assert.equal(f.bodies(), 1)
  assert.equal((await f.runtime.clear({ toolName: 'probe', expectedGeneration: 1, reason: 'task reassigned' }, f.agent)).generation, 2)
  assert.equal(f.runtime.intentStatus(f.agent).records[0].status, 'cleared')
  assert.equal((await f.execute('unbound-call')).isError, false)
})

test('server intent cannot bind caller evidence, foreign requirement, unknown tool or task revision', async t => {
  const f = await setup(t, { durableIntent: true })
  for (const delta of [{ status: 'passed' }, { requirementId: 'foreign' }, { toolName: 'invented' }, { expectedTaskRevision: 0 }]) {
    await assert.rejects(f.runtime.bind({ ...f.bindingInput(), ...delta }, f.agent))
  }
  assert.equal(readControlPlaneSnapshot(f.cp.file).v15HypothesisIntents, undefined)
  assert.equal(f.bodies(), 0)
})

test('native hook reinstallation recovers durable intent and clearing/rebinding cannot reset same-hypothesis history', async t => {
  const f = await setup(t, { durableIntent: true, maxNoProgressAttempts: 1 })
  await f.runtime.bind(f.bindingInput(), f.agent)
  assert.equal((await f.execute('before-reinstall')).isError, false)
  await f.runtime.flush()
  f.runtime.dispose()
  await new Promise(resolve => setImmediate(resolve))
  const restored = createHypothesisRuntime(f.runtimeOptions)
  t.after(async () => { restored.dispose(); await restored.flush() })
  assert.equal(restored.intentStatus(f.agent).records[0].generation, 1)
  assert.equal((await f.execute('after-reinstall')).isError, true)
  await restored.clear({ toolName: 'probe', expectedGeneration: 1, reason: 'replace intent' }, f.agent)
  await restored.bind({ ...f.bindingInput(), expectedGeneration: 2 }, f.agent)
  assert.equal((await f.execute('after-rebind')).isError, true)
  assert.equal(f.bodies(), 1)
})

test('concurrent same-hypothesis calls cannot bypass admission or the durable no-progress budget', async t => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers()
  const f = await setup(t, { body: async () => { entered.resolve(); await finish.promise } })
  const first = f.execute('concurrent-1')
  await entered.promise
  const secondPending = f.execute('concurrent-2')
  await new Promise(resolve => setImmediate(resolve))
  finish.resolve()
  const [, second] = await Promise.all([first, secondPending])
  await f.runtime.flush()
  assert.equal(second.isError, true)
  assert.match(JSON.stringify(second), /HYPOTHESIS_RUNTIME_ATTEMPT_IN_FLIGHT/)
  assert.equal(f.bodies(), 1)
})

test('native stable error codes count as new observations without trusting model status', async t => {
  let code = 'E_FIRST'
  const f = await setup(t, { body: async () => { throw new HarnessError('server failure', code) } })
  await f.execute('error-first')
  code = 'E_CHANGED'
  await f.execute('error-changed')
  await f.runtime.flush()
  const rows = f.runtime.observe(f.lastExec()).entries[0].attempts
  assert.deepEqual(rows.map(row => row.serverObservation.errorCode), ['E_FIRST', 'E_CHANGED'])
  assert.ok(rows.every(row => row.newInformation.error && !row.newInformation.progress))
})

test('authority change after admitted body records unknown historical outcome, not proof or a permanent retry lock', async t => {
  const f = await setup(t, { durableIntent: true, body: async () => {
    await f.cp.mutateHot('test/authority-change', {}, null, state => { state.boards.global.tasks.t1.revision++ }, { deferMs: 0 })
  } })
  await f.runtime.bind(f.bindingInput(), f.agent)
  assert.equal((await f.execute('changed-authority')).isError, false, 'observer must not rewrite native effect outcome')
  await f.runtime.flush()
  const row = f.runtime.intentStatus(f.agent).observations[0].attempts[0]
  assert.equal(row.serverObservation.status, 'unknown')
  assert.equal(row.newInformation.evidence, false)
  assert.equal(row.newInformation.progress, false)
  await f.runtime.clear({ toolName: 'probe', expectedGeneration: 1, reason: 'rebind current revision' }, f.agent)
  assert.equal((await f.runtime.bind({ ...f.bindingInput(), expectedGeneration: 2, expectedTaskRevision: 2 }, f.agent)).durable, true)
})

test('native final observer records post-policy block and final-content failure, never intermediate success', async t => {
  const blocked = await setup(t)
  blocked.agent.ctx.on('tools/post-execute', () => ({ kind: 'block', feedback: [{ type: 'text', text: 'policy rejection' }] }))
  const result = await blocked.execute('blocked-final')
  assert.equal(result.isError, true)
  await blocked.runtime.flush()
  assert.equal(blocked.runtime.observe(blocked.lastExec()).entries[0].attempts[0].serverObservation.status, 'failed')
  const finalized = await setup(t, { finalizeContent: () => { throw new Error('final content failure') } })
  assert.equal((await finalized.execute('finalizer-error')).isError, true)
  await finalized.runtime.flush()
  assert.equal(finalized.runtime.observe(finalized.lastExec()).entries[0].attempts[0].serverObservation.status, 'failed')
})

test('native repeated probes wait for durable final observations and stop before the next body', async t => {
  const f = await setup(t, { maxNoProgressAttempts: 2 })
  await f.execute('first')
  await f.execute('second')
  const result = await f.execute('third')
  assert.equal(result.isError, true)
  assert.match(JSON.stringify(result), /HYPOTHESIS_RUNTIME_REPLAN_REQUIRED/)
  assert.equal(f.bodies(), 2)
  await f.runtime.flush()
  assert.equal(f.runtime.observe(f.lastExec()).entries[0].attempts.length, 2)
})
