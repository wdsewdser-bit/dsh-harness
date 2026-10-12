import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { Session, SessionStore, installNativeSessionBridge } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { ReactLoopAgent, inboxProjectionDefinition, turnBoundaryProjectionDefinition } from '../app/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'
import { ToolRuntime } from '../app/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
import { apply } from '../home/profiles/web/plugins/team-v12-runtime.mjs'
import { initializeNativeHost } from './native-host-fixture.mjs'
import { apply as applyStepCompaction } from '../home/profiles/web/plugins/step-compaction-v4.mjs'
import { controlPlaneForMember, readControlPlaneSnapshot, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
const require = createRequire(new URL('../app/package.json', import.meta.url))
const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)))
const { Context, Service } = await load('cordis')
const { SessionProjectionRegistry } = await load('dsh-session-projection')
const { SystemPrompt } = await load('dsh-system-prompt')
const { AgentRegistry } = await load('dsh-agent')
const { LocalSubprocessRuntime } = await load('dsh-subprocess-local')
const { LocalBashExecutor } = await load('dsh-bash-local')
const { ShellEnvRegistry } = await load('dsh-shell-env')
const bashPlugin = await load('dsh-tool-bash')

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'team-execution-proof-')), teamId = basename(root)
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); resetControlPlaneCache(); rmSync(root, { recursive: true, force: true }) })
  return initializeNativeHost(ctx, async () => {
  const sessions = new SessionStore(ctx), projections = new SessionProjectionRegistry(ctx)
  projections.register(inboxProjectionDefinition); projections.register(turnBoundaryProjectionDefinition)
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  new AgentRegistry(ctx)
  function createAgent(label) {
    const session = Session.create(teamId + '-' + label)
    sessions.enter(session); sessions.announce(session)
    const agent = new ReactLoopAgent(ctx, session.id, { provider: 'fixture', model: 'fixture' }, session)
    ctx.agents.enter(agent, { dispose: async () => {} }); agent.wakeDriver = () => {}
    const bridge = installNativeSessionBridge(session, { sessionId: session.id, isolated: true, flush: async () => true })
    return { session, agent, bridge }
  }
  const lead = createAgent('root'), child = createAgent('tier2')
  // Only the Team roster is a minimal server fixture. Agent contexts, tool
  // registration, policy hooks, execution tokens and subprocesses are real.
  class FixtureTeams extends Service {
    constructor(ctx) { super(ctx, 'agentTeams') }
    tryMembership(agent) {
      if (agent === lead.agent) return { id: teamId, name: 'root', tier: 0, role: 'lead', root: lead.agent }
      if (agent === child.agent) return { id: teamId, name: 'tier2', tier: 2, role: 'teammate', root: lead.agent }
    }
    listMembers() { return [{ id: lead.agent.id, name: 'root', tier: 0, role: 'lead' }, { id: child.agent.id, name: 'tier2', tier: 2, role: 'teammate' }] }
  }
  new FixtureTeams(ctx)
  const runtime = new ToolRuntime(ctx)
  new LocalSubprocessRuntime(ctx)
  class FixtureBash extends LocalBashExecutor {
    execute(spec) { return this.executeArgv(spec, [process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash', '-c', spec.command]) }
  }
  const cell = value => ({ get: () => value })
  new FixtureBash(ctx, { cwd: cell(root), timeoutMs: cell(15000), maxTimeoutMs: cell(15000), maxOutputBytes: cell(262144), maxSpillBytes: cell(262144), graceMs: cell(1000) })
  new ShellEnvRegistry(ctx, { dshHome: root })
  bashPlugin.apply(ctx, { enableRunInBackground: false, promoteOnTimeout: false })
  const ref = (name, text) => { const path = join(root, name); writeFileSync(path, text); return { path, sha256: createHash('sha256').update(text).digest('hex') } }
  ref('source.mjs', 'export const value = 1\n')
  ref('oracle.cjs', `const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.equal(fs.readFileSync('source.mjs','utf8'), 'export const value = 1\\n');
assert.equal(1 + 1, 2);
const kind = process.argv[2];
process.stdout.write(JSON.stringify({schema:'dsh-execution-quality-v1',recipeId:'fixed-' + kind,kind,
checks:[{id:'physical-source-value',passed:true},{id:'arithmetic-regression',passed:true}]}));
`)
  const recipes = ['test', 'acceptance'].map(kind => ({ id: 'fixed-' + kind, kind, toolName: 'bash', arguments: {
    command: `'${process.execPath.replaceAll('\\', '/')}' oracle.cjs ${kind}`, description: 'Run exact Team recipe quality checks', workdir: root, timeoutMs: 15000 },
    checks: ['physical-source-value', 'arithmetic-regression'], slots: [{ planId: 'p', requirementId: 'r', boardId: 'global', taskId: 't', proofRef: kind }] }))
  const recipeRef = ref('recipes.json', JSON.stringify({ schema: 'dsh-execution-recipes-v1', recipes }, null, 2))
  const planRef = ref('plan.json', JSON.stringify({ kind: 'dsh-plan-contract', version: 1, planId: 'p', scope: ['source.mjs', 'oracle.cjs'],
    items: [{ requirementId: 'r', taskRefs: [{ boardId: 'global', taskId: 't' }], testEvidenceRefs: ['test'], acceptanceEvidenceRefs: ['acceptance'] }] }, null, 2))
  const milestones = ref('milestones.json', JSON.stringify({ version: 3, teams: { [teamId]: { compactions: {} } } }))
  const stopMilestones = applyStepCompaction(ctx, { milestonePath: milestones.path })
  t.after(stopMilestones)
  apply(ctx, { controlDir: join(root, 'control'), pluginDir: root, profile: 'web', planReadRoots: [root],
    deliveryPolicy: { workspaceRoot: root, allowedRoots: [root], environmentRefs: [ref('env.json', '{}')], recipeRef, milestonePath: milestones.path } })
  const control = controlPlaneForMember(ctx, lead.agent, { directory: join(root, 'control') })
  assert.ok(control)
  await control.mutateHot('fixture/server-task-authority', {}, null, state => {
    state.boards = { global: { tasks: { t: { id: 't', revision: 1, ownerName: 'root', contract: { contractRevision: 2, writeScopes: ['source.mjs', 'oracle.cjs'] } } } } }
    state.leases.l = { member: 'root', taskId: 't', contractRevision: 2, status: 'active', expiresAt: Date.now() + 300000 }
    state.v12RoomWake = { version: 1, rooms: {}, inbox: {}, wakes: {} }
    state.v12Compaction = { version: 1, jobs: {} }
    state.v12Requirements = { version: 1, requirements: {}, decisions: {} }
  }, { deferMs: 0 })
  let sequence = 0
  const run = (action, input, agent = lead.agent, signal = new AbortController().signal) => runtime.execute({
    name: 'team_v12', arguments: { action, input }, callId: 'team-action-' + ++sequence, agent, signal })
  return { lead, child, runtime, control, run, planRef }
  }).then(async ({ lead, child, runtime, control, run, planRef }) => {
  const registration = await run('plan_register', { planId: 'p', ref: planRef, expectedPlanRevision: 0 })
  assert.equal(registration.isError, false, JSON.stringify(registration.error))
  const readDurable = () => readControlPlaneSnapshot(control.file)
  const plan = readDurable().v15PlanDelivery.plans.p
  const request = kind => ({ planId: 'p', expectedPlanRevision: 1, expectedPlanHash: plan.planHash, requirementId: 'r', boardId: 'global',
    taskId: 't', expectedTaskRevision: 1, expectedContractRevision: 2, proofRef: kind, recipeId: 'fixed-' + kind })
  return { root, ctx, lead, child, runtime, control, readDurable, run, request }
  })
}

test('registered team_v12 execution_prove executes real fixed recipes and persists test/acceptance authority', async t => {
  const f = await fixture(t), parents = new Set(), observed = []
  f.ctx.on('tools/execute', (exec, next) => {
    if (exec.name === 'team_v12' && exec.arguments.action === 'execution_prove') parents.add(exec.token)
    if (exec.name === 'bash') { assert.ok(parents.has(exec.parent)); observed.push(exec.arguments.command) }
    return next()
  })
  for (const kind of ['test', 'acceptance']) {
    const result = await f.run('execution_prove', f.request(kind))
    assert.equal(result.isError, false, JSON.stringify(result.error))
    assert.equal(result.value.durable, true)
    const disk = f.readDurable(), proof = disk.v12Evidence.records[kind]
    assert.deepEqual(proof, result.value.proof)
    assert.equal(proof.kind, kind); assert.equal(proof.status, 'passed')
    assert.equal(proof.provenance.kind, 'server-tool-runtime-quality-oracle')
    assert.deepEqual(proof.provenance.quality.checks, [{ id: 'physical-source-value', passed: true }, { id: 'arithmetic-regression', passed: true }])
    assert.equal(disk.deliveryAuthorityReceipts[result.value.authority.id].leaseRef, 'l')
    const effect = f.lead.session.snapshotEvents().find(event => event.type === 'native/tool-effect' && event.data.callId === proof.provenance.callId)
    assert.equal(effect.data.result.value.kind, 'foreground')
    assert.equal(effect.data.result.value.exitCode, 0)
  }
  assert.equal(observed.length, 2)
})

test('tier2 agent cannot certify root execution proof', async t => {
  const f = await fixture(t)
  const result = await f.run('execution_prove', f.request('test'), f.child.agent)
  assert.equal(result.isError, true)
  assert.match(result.error.message, /PLAN_DELIVERY_DENIED/)
  assert.equal(f.readDurable().v12Evidence.records.test, undefined)
})

test('host history settlement is read-only and restricted to installed live Team agents', async t => {
  const f = await fixture(t), before = f.readDurable().revision
  assert.deepEqual(await f.ctx.teamWindowRuntime.drainHistoryDispatch(f.lead.agent),[])
  assert.deepEqual(await f.ctx.teamWindowRuntime.drainHistoryDispatch(f.child.agent),[])
  assert.equal(f.readDurable().revision,before)
  await assert.rejects(f.ctx.teamWindowRuntime.drainHistoryDispatch({id:f.lead.agent.id,session:f.lead.session}),/HISTORY_SCOPE_DENIED/)
  const service=f.ctx.teamWindowRuntime
  await f.ctx.fiber.dispose()
  await assert.rejects(service.drainHistoryDispatch(f.lead.agent),/HISTORY_SCOPE_DENIED/)
})

test('registered Team action refuses missing native cancellation method', async t => {
  const f = await fixture(t)
  const capture = f.runtime.captureProofCancellation
  f.runtime.captureProofCancellation = undefined
  t.after(() => { f.runtime.captureProofCancellation = capture })
  const result = await f.run('execution_prove', f.request('test'))
  assert.equal(result.isError, true)
  assert.match(result.error.message, /EXECUTION_CANCELLATION_UNAVAILABLE/)
  assert.equal(f.readDurable().v12Evidence.records.test, undefined)
})

test('registered Team action rejects extra caller fields and foreign proof slots', async t => {
  const f = await fixture(t)
  for (const key of ['status', 'command', 'result', 'artifactHash', 'parent']) {
    const result = await f.run('execution_prove', { ...f.request('test'), [key]: 'passed' })
    assert.equal(result.isError, true)
    assert.match(result.error.message, /EXECUTION_PROOF_INPUT_INVALID/)
  }
  const result = await f.run('execution_prove', { ...f.request('test'), proofRef: 'acceptance' })
  assert.equal(result.isError, true)
  assert.match(result.error.message, /EXECUTION_SLOT_DENIED/)
  assert.deepEqual(f.readDurable().v12Evidence.records, {})
})
