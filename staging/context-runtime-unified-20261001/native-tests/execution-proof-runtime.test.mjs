import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Session, SessionStore, installNativeSessionBridge } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { ReactLoopAgent, inboxProjectionDefinition, turnBoundaryProjectionDefinition } from '../app/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'
import { ToolRuntime } from '../app/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
import { controlPlaneFor, readControlPlaneSnapshot, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { createPlanRegistry } from '../home/profiles/web/plugins/team-v15-plan-registry.mjs'
import { collectDeliveryContext } from '../home/profiles/web/plugins/team-v15-delivery-source.mjs'
import { createExecutionProofProducer } from '../home/profiles/web/plugins/team-v15-execution-proof.mjs'
import { initializeNativeHost } from './native-host-fixture.mjs'
const require = createRequire(new URL('../app/package.json', import.meta.url))
const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)))
const { Context } = await load('cordis')
const { SessionProjectionRegistry } = await load('dsh-session-projection')
const { SystemPrompt } = await load('dsh-system-prompt')
const { AgentRegistry } = await load('dsh-agent')
const { LocalSubprocessRuntime } = await load('dsh-subprocess-local')
const { LocalBashExecutor } = await load('dsh-bash-local')
const { ShellEnvRegistry } = await load('dsh-shell-env')
const bashPlugin = await load('dsh-tool-bash')

async function fixture(t, kind = 'test') {
  const root = mkdtempSync(join(tmpdir(), 'native-execution-proof-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); resetControlPlaneCache(); rmSync(root, { recursive: true, force: true }) })
  return initializeNativeHost(ctx, async () => {
  const sessions = new SessionStore(ctx), projections = new SessionProjectionRegistry(ctx)
  projections.register(inboxProjectionDefinition); projections.register(turnBoundaryProjectionDefinition)
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  new AgentRegistry(ctx)
  const session = Session.create('isolated-execution-proof')
  sessions.enter(session); sessions.announce(session)
  const agent = new ReactLoopAgent(ctx, session.id, { provider: 'fixture', model: 'fixture' }, session)
  ctx.agents.enter(agent, { dispose: async () => {} })
  agent.wakeDriver = () => {}
  const bridge = installNativeSessionBridge(session, { sessionId: session.id, isolated: true, flush: async () => true })
  const runtime = new ToolRuntime(ctx)
  new LocalSubprocessRuntime(ctx)
  // Windows' PATH bash is a WSL launcher; select the installed Git bash only
  // for this fixture, retaining the official managed subprocess lifecycle.
  class FixtureBash extends LocalBashExecutor {
    execute(spec) { return this.executeArgv(spec, [process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash', '-c', spec.command]) }
  }
  const cell = value => ({ get: () => value })
  new FixtureBash(ctx, { cwd: cell(root), timeoutMs: cell(15000), maxTimeoutMs: cell(15000), maxOutputBytes: cell(262144), maxSpillBytes: cell(262144), graceMs: cell(1000) })
  new ShellEnvRegistry(ctx, { dshHome: root })
  bashPlugin.apply(ctx, { enableRunInBackground: false, promoteOnTimeout: false })
  const ref = (name, text) => { const path = join(root, name); writeFileSync(path, text); return { path, sha256: createHash('sha256').update(text).digest('hex') } }
  const sourceRef = ref('source.mjs', 'export const value = 1\n')
  ref('oracle.cjs', `const assert = require('node:assert/strict');
const fs = require('node:fs');
const kind = process.argv[2];
assert.equal(fs.readFileSync('source.mjs','utf8'), 'export const value = 1\\n');
assert.equal(1 + 1, 2);
process.stdout.write(JSON.stringify({schema:'dsh-execution-quality-v1',recipeId:'fixed',kind,
checks:[{id:'physical-source-value',passed:true},{id:'arithmetic-regression',passed:true}]}));
`)
  const recipe = { id: 'fixed', kind, toolName: 'bash', arguments: {
    command: `'${process.execPath.replaceAll('\\', '/')}' oracle.cjs ${kind}`, description: 'Run exact isolated quality checks', workdir: root, timeoutMs: 15000 },
    checks: ['physical-source-value', 'arithmetic-regression'], slots: [{ planId: 'p', requirementId: 'r', boardId: 'global', taskId: 't', proofRef: kind }] }
  const recipeRef = ref('recipes.json', JSON.stringify({ schema: 'dsh-execution-recipes-v1', recipes: [recipe] }, null, 2))
  const planRef = ref('plan.json', JSON.stringify({ kind: 'dsh-plan-contract', version: 1, planId: 'p', scope: ['source.mjs', 'oracle.cjs'],
    items: [{ requirementId: 'r', taskRefs: [{ boardId: 'global', taskId: 't' }], testEvidenceRefs: ['test'], acceptanceEvidenceRefs: ['acceptance'] }] }, null, 2))
  const control = controlPlaneFor('native-proof-team', { directory: join(root, 'control') })
  const readDurable = () => readControlPlaneSnapshot(control.file)
  const registry = createPlanRegistry({ control, readDurable, authorize: () => true, allowedRoots: [root] })
  await control.mutateHot('fixture/tasks', {}, null, state => {
    state.boards = { global: { tasks: { t: { id: 't', revision: 1, ownerName: 'alice', contract: { contractRevision: 2 } } } } }
    state.leases.l = { member: 'alice', taskId: 't', contractRevision: 2, status: 'active', expiresAt: 100 }
  }, { deferMs: 0 })
  const registered = await registry.register({ planId: 'p', ref: planRef, expectedPlanRevision: 0 })
  const policy = { workspaceRoot: root, allowedRoots: [root], environmentRefs: [ref('env.json', '{}')], recipeRef,
    collectAuthorityDebt: () => ({ unresolvedDebt: [], blockers: [] }) }
  const abort = new AbortController()
  const f = { root, ctx, runtime, session, agent, bridge, abort, sourceRef, control, readDurable, bodyTokens: [] }
  const producer = createExecutionProofProducer({ control, readDurable, recipeRef, allowedRoots: [root], toolRuntime: runtime,
    collectContext: (state, plan) => collectDeliveryContext(state, plan, policy), verifyPlan: plan => registry.verify(plan),
    authorize: () => true, now: () => 10, captureCancellation: exec => runtime.captureProofCancellation(exec) })
  const request = { planId: 'p', expectedPlanRevision: 1, expectedPlanHash: registered.plan.planHash, requirementId: 'r', boardId: 'global',
    taskId: 't', expectedTaskRevision: 1, expectedContractRevision: 2, proofRef: kind, recipeId: 'fixed' }
  runtime.register({ name: 'execution_prove', parameters: { type: 'object', properties: {} }, output: { schema: {},
    render: (_, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    async execute(_, exec) {
      f.bodyTokens.push(exec.token)
      f.parentExec = exec
      f.bodySignal = exec.signal
      f.cancellation = runtime.captureProofCancellation(exec)
      return producer.prove(request, exec)
    } })
  f.run = () => runtime.execute({ name: 'execution_prove', arguments: {}, callId: 'actual-parent', agent, signal: abort.signal })
  return f
  })
}

test('actual native ToolRuntime executes official bash and durable test/acceptance proof with real parent tokens', async t => {
  for (const kind of ['test', 'acceptance']) await t.test(kind, async t => {
    const f = await fixture(t, kind), stages = []
    f.ctx.on('tools/pre-execute', (exec, next) => { if (exec.name === 'bash') { stages.push('pre'); assert.equal(exec.parent, f.bodyTokens[0]) } return next() })
    f.ctx.on('tools/execute', (exec, next) => { if (exec.name === 'bash') stages.push('body'); return next() })
    f.ctx.on('tools/post-execute', (exec, result, next) => { if (exec.name === 'bash') stages.push('post'); return next() })
    const result = await f.run()
    assert.equal(result.isError, false, JSON.stringify(result.error))
    assert.equal(result.value.durable, true)
    assert.notEqual(f.bodySignal, f.abort.signal)
    assert.equal(f.cancellation.signal, f.abort.signal)
    assert.equal(f.cancellation.isCancelled(), false)
    assert.deepEqual(stages, ['pre', 'body', 'post'])
    assert.deepEqual(f.readDurable().v12Evidence.records[kind], result.value.proof)
    const effect = f.session.snapshotEvents().find(event => event.type === 'native/tool-effect' && event.data.callId === result.value.proof.provenance.callId)
    assert.equal(effect.data.effectOutcome, 'succeeded')
    assert.equal(effect.data.result.value.kind, 'foreground')
    assert.equal(JSON.parse(effect.data.result.value.stdout.text).checks.length, 2)
  })
})

test('actual pre-execute, monotonic ACL and post-execute deny proof persistence', async t => {
  for (const gate of ['pre', 'acl', 'post']) await t.test(gate, async t => {
    const f = await fixture(t)
    if (gate === 'pre') f.ctx.on('tools/pre-execute', (exec, next) => exec.name === 'bash' ? { kind: 'deny', reason: 'fixture deny' } : next())
    if (gate === 'acl') f.runtime.guard(exec => exec.name === 'bash' ? 'fixture ACL deny' : undefined)
    if (gate === 'post') f.ctx.on('tools/post-execute', (exec, result, next) => exec.name === 'bash' ? { kind: 'block', feedback: [{ type: 'text', text: 'fixture post deny' }] } : next())
    const result = await f.run()
    assert.equal(result.isError, true)
    assert.equal(f.readDurable().v12Evidence.records.test, undefined)
  })
})

test('native bridge cancellation after drained shell success and physical change after execution reject proof', async t => {
  for (const change of ['callerCancel', 'hardAbort', 'source']) await t.test(change, async t => {
    const f = await fixture(t)
    f.ctx.on('tools/post-execute', (exec, result, next) => {
      if (exec.name === 'bash') {
        assert.equal(result.isError, false)
        if (change === 'callerCancel') f.abort.abort()
        else if (change === 'hardAbort') f.bridge.abortTurn()
        else writeFileSync(f.sourceRef.path, 'export const value = 2\n')
        if (change !== 'source') {
          assert.equal(f.bodySignal.aborted, false)
          assert.equal(f.cancellation.isCancelled(), true)
        }
      }
      return next()
    })
    const result = await f.run()
    assert.equal(result.isError, true)
    assert.equal(f.readDurable().v12Evidence.records.test, undefined)
  })
})

test('proof cancellation observer rejects forged execution objects even with copied real token', async t => {
  const f = await fixture(t)
  assert.throws(() => f.runtime.captureProofCancellation({}), /registry-minted execution/)
  assert.throws(() => f.runtime.captureProofCancellation({ token: Symbol('forged'), signal: f.abort.signal }), /registry-minted execution/)
  const result = await f.run()
  assert.equal(result.isError, false)
  assert.throws(() => f.runtime.captureProofCancellation({ ...f.parentExec }), /registry-minted execution/)
})

test('real zero-exit is insufficient and actual checker failure cannot create proof', async t => {
  const f = await fixture(t)
  writeFileSync(f.sourceRef.path, 'export const value = 2\n')
  const result = await f.run()
  assert.equal(result.isError, true)
  assert.equal(f.readDurable().v12Evidence.records.test, undefined)
  const shell = f.session.snapshotEvents().find(event => event.type === 'native/tool-effect' && event.data.callId !== 'actual-parent')
  assert.equal(shell.data.result.value.exitCode, 1)
})
