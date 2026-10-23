import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { BasicCompactionEngine } from '../app/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js'
import { createAssistantMessage } from '../app/node_modules/@deepseek-ai/dsh-llm/lib/index.js'
import { Session, SessionStore, installNativeSessionBridge } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { ReactLoopAgent, inboxProjectionDefinition, turnBoundaryProjectionDefinition } from '../app/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'
import { ToolRuntime } from '../app/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
import { GoalService } from '../app/node_modules/@deepseek-ai/dsh-goal/lib/index.js'
import JsonlSessionPersistence from '../app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'
import { TYPERT as goalTypert } from '../app/node_modules/@deepseek-ai/dsh-goal/lib/typert.host.js'
import remoteGoal from '../app/node_modules/@deepseek-ai/dsh-goal/lib/typert.remote-client.js'
import { installSessionDelivery } from '../home/profiles/web/plugins/session-plan-delivery.mjs'
import { readControlPlaneSnapshot, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { initializeNativeHost } from './native-host-fixture.mjs'
const require = createRequire(new URL('../app/package.json', import.meta.url))
const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)))
const { Context, Service } = await load('cordis')
const { SessionProjectionRegistry } = await load('dsh-session-projection')
const { SystemPrompt } = await load('dsh-system-prompt')
const { AgentRegistry } = await load('dsh-agent')
const { LocalSubprocessRuntime } = await load('dsh-subprocess-local')
const { LocalBashExecutor } = await load('dsh-bash-local')
const { ShellEnvRegistry } = await load('dsh-shell-env')
const { TypertRegistry } = await load('dsh-typert-registry')
const { TypertGatewayService } = await load('dsh-api-gateway')
const bashPlugin = await load('dsh-tool-bash')

async function fixture(t, { goal = true, install = true, teamService = false, requirePlan = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'session-delivery-')), id = basename(root)
  const file = (name, body) => {
    const path = join(root, name); writeFileSync(path, body)
    return { path, sha256: createHash('sha256').update(body).digest('hex') }
  }
  file('source.txt', 'verified output\n')
  file('oracle.cjs', `const fs = require('node:fs');const assert = require('node:assert/strict');
assert.equal(fs.readFileSync('source.txt','utf8'),'verified output\\n');
process.stdout.write(JSON.stringify({schema:'dsh-execution-quality-v1',recipeId:'check',kind:'test',checks:[{id:'content',passed:true}]}));`)
  const recipeRef = file('recipes.json', JSON.stringify({ schema: 'dsh-execution-recipes-v1', recipes: [{ id: 'check', kind: 'test', toolName: 'bash',
    arguments: { command: `'${process.execPath.replaceAll('\\', '/')}' oracle.cjs`, description: 'Verify actual file', workdir: root, timeoutMs: 15000 },
    checks: ['content'], slots: [{ planId: 'p', requirementId: 'r', boardId: 'session', taskId: 't', proofRef: 'test' }] }] }, null, 2))
  const contract = { kind: 'dsh-plan-contract', version: 1, planId: 'p', scope: ['source.txt', 'oracle.cjs'],
    items: [{ requirementId: 'r', taskRefs: [{ boardId: 'session', taskId: 't' }], requiredDimensions: ['implemented', 'tested'],
      implementationRefs: ['impl'], testEvidenceRefs: ['test'] }] }
  const planRef = file('plan.json', JSON.stringify(contract, null, 2))
  const config = { workspaceRoot: root, writeScopes: ['source.txt', 'oracle.cjs'], allowedRoots: [root], controlDir: join(root, 'control'),
    environmentRefs: [file('env.json', '{}')], recipeRef, requirePlan }
  let current, member, lookupFailure = false, call = 0
  async function open(events, header, enable = install) {
    const ctx = new Context()
    return initializeNativeHost(ctx, async () => {
      const sessions = new SessionStore(ctx), projections = new SessionProjectionRegistry(ctx)
      projections.register(inboxProjectionDefinition); projections.register(turnBoundaryProjectionDefinition)
      new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
      new AgentRegistry(ctx)
      class FixtureTeams extends Service {
        constructor(ctx) { super(ctx, 'agentTeams') }
        tryMembership() { if (lookupFailure) throw new Error('MEMBERSHIP_LOOKUP_FAILED'); return member }
      }
      if (teamService) new FixtureTeams(ctx)
      const session = Session.create(id, events, header ?? { id, version: 4, cwd: root, createdAt: Date.now(), isSeeded: false })
      const storage = new JsonlSessionPersistence(new Context(), { root: join(root, 'sessions'), compression: 'none' })
      const handle = events ? await storage.open(id, 'write') : await storage.create(session.header)
      let persisted = events?.length ?? 0
      ctx.on('session/flush', async target => {
        assert.equal(target, session)
        await handle.append(session.snapshotEvents(persisted)); persisted = session.seq; await handle.flush()
      })
      sessions.enter(session); sessions.announce(session)
      const agent = new ReactLoopAgent(ctx, id, { provider: 'fixture', model: 'fixture' }, session)
      ctx.agents.enter(agent, { dispose: async () => {} }); agent.wakeDriver = () => {}
      const flush = () => sessions.flush(session)
      installNativeSessionBridge(session, { sessionId: id, isolated: true, flush })
      const runtime = new ToolRuntime(ctx), goals = new GoalService(ctx)
      new TypertRegistry(ctx).register(goalTypert)
      const gateway = new TypertGatewayService(ctx, {})
      new LocalSubprocessRuntime(ctx)
      class FixtureBash extends LocalBashExecutor {
        execute(spec) { return this.executeArgv(spec, [process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash', '-c', spec.command]) }
      }
      const cell = value => ({ get: () => value })
      new FixtureBash(ctx, { cwd: cell(root), timeoutMs: cell(15000), maxTimeoutMs: cell(15000), maxOutputBytes: cell(262144), maxSpillBytes: cell(262144), graceMs: cell(1000) })
      new ShellEnvRegistry(ctx, { dshHome: root })
      bashPlugin.apply(ctx, { enableRunInBackground: false, promoteOnTimeout: false })
      const service = enable ? await installSessionDelivery(ctx, agent, config) : undefined
      const run = (action, input = {}) => runtime.execute({ name: 'session_delivery', arguments: { action, input }, callId: 'local-' + ++call,
        agent, signal: new AbortController().signal })
      return { ctx, session, agent, goals, gateway, handle, storage, runtime, service, flush, run }
    })
  }
  current = await open()
  t.after(async () => { current.service?.dispose(); await current.flush(); await current.handle.close(); await current.ctx.fiber.dispose() })
  const g = goal ? current.goals.create(current.agent, { objective: 'Verify the exact file and deliver it' }) : undefined
  await current.flush()
  const f = { root, config, contract, planRef, get c() { return current }, ref: g && { id: g.id, revision: g.revision },
    team: value => { member = value }, failMembership: () => { lookupFailure = true },
    async reload(enable = true, cacheCold = false) {
      current.service?.dispose(); await current.flush(); await current.handle.close(); await current.ctx.fiber.dispose()
      if (cacheCold) resetControlPlaneCache()
      const h = await current.storage.open(id, 'read'), data = await h.read(), header = h.header
      await h.close()
      current = await open(data.events, header, enable)
      return current
    } }
  f.register = async () => {
    const result = await current.run('plan_register', { planId: 'p', expectedPlanRevision: 0, ref: planRef })
    assert.equal(result.isError, false, JSON.stringify(result.error))
    f.plan = result.value.plan
    return result
  }
  f.proof = async kind => {
    const result = await current.run(kind === 'impl' ? 'implementation_prove' : 'execution_prove', {
      planId: 'p', expectedPlanRevision: f.plan.planRevision, expectedPlanHash: f.plan.planHash, requirementId: 'r', boardId: 'session', taskId: 't',
      expectedTaskRevision: 1, expectedContractRevision: 1, proofRef: kind, ...(kind === 'impl' ? { locator: 'source.txt' } : { recipeId: 'check' }),
    })
    assert.equal(result.isError, false, JSON.stringify(result.error))
    return result
  }
  return f
}

test('strict no-goal session persists an empty-plan partial verdict, not accepted prose', async t => {
  const f = await fixture(t, { goal: false, requirePlan: true })
  f.c.session.append('turn/start', { turn: 1 })
  f.c.session.append('step/start', { turn: 1, step: 1 })
  f.c.session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
    source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: 'Everything is complete.' }] }) }, { surfaceOp: 'append' })
  f.c.session.append('step/end', { turn: 1, step: 1 })
  f.c.session.append('turn/end', { turn: 1 })
  const verdict = (await f.c.run('status')).value
  assert.equal(verdict.required, true)
  assert.equal(verdict.deliverable, false)
  assert.equal(verdict.code, 'DELIVERY_PLAN_REQUIRED')
  assert.deepEqual(verdict.plans, [])
  const event = f.c.session.log.findLast(event => event.type === 'native/delivery-status')
  assert.equal(event.data.status, 'partial')
  assert.equal(event.data.code, 'DELIVERY_PLAN_REQUIRED')
  f.config.requirePlan = false
  await f.reload()
  assert.equal((await f.c.run('status')).value.deliverable, false)
  assert.equal(f.c.session.log.some(event => event.type === 'native/goal-policy-required' && event.data.requiresPlan === true), true)
})

test('strict policy cannot be downgraded by cold config, missing plugin or a legacy gate', async t => {
  const f = await fixture(t, { requirePlan: true })
  await assert.rejects(async () => f.c.goals.complete(f.c.agent, f.ref), { code: 'GOAL_PLAN_UNBOUND' })
  f.config.requirePlan = false
  await f.reload()
  await assert.rejects(async () => f.c.goals.complete(f.c.agent, f.ref), { code: 'GOAL_PLAN_UNBOUND' })
  await f.reload(false)
  assert.throws(() => f.c.goals.complete(f.c.agent, f.ref), { code: 'GOAL_DELIVERY_BRIDGE_UNAVAILABLE' })
  f.c.goals.registerCompletionGate(f.c.agent, { isBound: () => false, authorize() {}, verifyReceipt() {}, requireDurable() {} })
  assert.throws(() => f.c.goals.complete(f.c.agent, f.ref), { code: 'GOAL_PLAN_UNBOUND' })
})

test('strict policy retains the existing receipt-backed accepted and stale-source paths', async t => {
  const f = await fixture(t, { goal: false, requirePlan: true })
  await f.register(); await f.proof('impl'); await f.proof('test')
  const { commit } = await previewCommit(f, 'p', 'strict-receipt')
  assert.equal(commit.isError, false, JSON.stringify(commit.error))
  assert.equal((await f.c.run('status')).value.deliverable, true)
  assert.equal(f.c.session.log.findLast(event => event.type === 'native/delivery-status').data.status, 'accepted')
  await f.reload()
  assert.equal((await f.c.run('status')).value.deliverable, true)
  writeFileSync(join(f.root, 'source.txt'), 'changed after receipt\n')
  assert.equal((await f.c.run('status')).value.deliverable, false)
  assert.equal(f.c.session.log.findLast(event => event.type === 'native/delivery-status').data.status, 'partial')
})

test('ordinary receipt task identity survives fresh-process normalization and cache-cold reloads', async t => {
  const f = await fixture(t, { goal: false })
  await f.register(); await f.proof('impl'); await f.proof('test')
  const { commit } = await previewCommit(f, 'p', 'cold-task-identity')
  assert.equal(commit.isError, false, JSON.stringify(commit.error))
  const before = readControlPlaneSnapshot(f.c.service.control.file)
  const moduleUrl = new URL('../home/profiles/web/plugins/team-control-plane.mjs', import.meta.url).href
  const source = `const { readControlPlaneSnapshot } = await import(${JSON.stringify(moduleUrl)});`
    + `const state = readControlPlaneSnapshot(${JSON.stringify(f.c.service.control.file)});`
    + 'console.log(JSON.stringify(state.boards.session.tasks));'
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', env, windowsHide: true, maxBuffer: 65536 })
  const normalized = JSON.parse(output.trim().split(/\r?\n/).at(-1))
  assert.deepEqual(normalized, before.boards.session.tasks, 'a cold reader must not silently change the receipt task identity')
  for (let index = 0; index < 2; index++) {
    await f.reload(true, true)
    const verdict = f.c.service.service.checkAll()
    assert.equal(verdict.deliverable, true, JSON.stringify(verdict.plans.map(row => row.code)))
    assert.equal(verdict.plans[0].durableReceiptId, commit.value.receipt.id)
  }
  await f.c.service.control.mutateHot('test/task-revision', {}, f.c.agent, state => { state.boards.session.tasks.t.revision++ }, { deferMs: 0 })
  assert.equal(f.c.service.service.checkAll().deliverable, false, 'real task changes must still invalidate the old receipt')
})

test('JSONL keeps accepted status nonempty and strict marker types validated', async t => {
  for (const mode of ['accepted-empty', 'unknown-code', 'invalid-policy']) await t.test(mode, async t => {
    const f = await fixture(t, { goal: false, requirePlan: true })
    if (mode === 'invalid-policy') f.c.session.append('native/goal-policy-required', {
      version: 1, sessionId: f.c.session.id, policy: 'delivery', requiresPlan: 'true' })
    else f.c.session.append('native/delivery-status', { version: 1, sessionId: f.c.session.id,
      checkedAt: Date.now(), status: mode === 'accepted-empty' ? 'accepted' : 'partial', plans: [],
      code: mode === 'unknown-code' ? 'UNKNOWN' : 'DELIVERY_PLAN_REQUIRED' })
    await f.c.flush()
    await assert.rejects(f.c.handle.read(), /Invalid native bridge event/)
  })
})

test('ordinary non-Team plan uses actual shell proofs, same durable gate and UI remote; cold JSONL retains completion', async t => {
  const f = await fixture(t)
  assert.equal(f.c.ctx.get('agentTeams'), undefined)
  await f.register()
  const bind = await f.c.run('goal_bind', { planId: 'p', expectedGoalId: f.ref.id, expectedGoalRevision: f.ref.revision })
  assert.equal(bind.isError, false, JSON.stringify(bind.error))
  await assert.rejects(f.c.gateway.invoke({ namespace: 'goals', method: 'complete', args: { agentId: f.c.agent.id, ref: f.ref } }), { code: 'DELIVERY_INCOMPLETE' })
  await f.proof('impl'); await f.proof('test')
  const completed = await f.c.gateway.invoke({ namespace: 'goals', method: 'complete', args: { agentId: f.c.agent.id, ref: f.ref } })
  const codec = remoteGoal.descriptors.find(row => row.namespace === 'goals' && row.method === 'complete').result.create()
  assert.equal(codec.parse(completed).phase, 'complete')
  const disk = readControlPlaneSnapshot(f.c.service.control.file)
  assert.equal(disk.boards.session.tasks.t.ownerName, 'session:' + f.c.session.id)
  assert.equal(Object.values(disk.v15PlanDelivery.outbox)[0].status, 'consumed')
  assert.equal(f.c.session.log.some(event => event.type === 'team/member'), false)
  assert.equal(f.c.session.log.some(event => event.type === 'native/tool-effect' && event.data.callId.startsWith('execution-proof-')), true)
  await f.reload()
  assert.equal(f.c.goals.get(f.c.agent).phase, 'complete')
})

test('ordinary plan without goal cannot turn partial evidence or assistant claims into accepted delivery', async t => {
  const f = await fixture(t, { goal: false })
  await f.register(); await f.proof('impl')
  const before = await f.c.run('status')
  assert.equal(before.value.deliverable, false)
  assert.deepEqual(before.value.plans[0].remainingScope, ['r'])
  assert.equal(f.c.goals.get(f.c.agent), undefined)
  await f.proof('test')
  const preview = (await f.c.run('preview', { planId: 'p' })).value
  const commit = await f.c.run('commit', { planId: 'p', idempotencyKey: 'local-final', expectedPlanRevision: preview.planRevision,
    expectedPlanHash: preview.planHash, sourceIdentity: preview.sourceIdentity, coverageMatrixHash: preview.coverageMatrixHash,
    sourceRevisionVector: preview.sourceRevisionVector })
  assert.equal(commit.isError, false, JSON.stringify(commit.error))
  assert.equal((await f.c.run('status')).value.deliverable, true)
  writeFileSync(join(f.root, 'source.txt'), 'changed after receipt\n')
  assert.equal((await f.c.run('status')).value.deliverable, false)
})

test('local route refuses current Team membership and failed membership lookups', async t => {
  for (const mode of ['team', 'unknown']) await t.test(mode, async t => {
    const f = await fixture(t, { teamService: true })
    await f.register()
    if (mode === 'team') f.team({ name: 'root', tier: 0 }); else f.failMembership()
    const result = await f.c.run('status')
    assert.equal(result.isError, true)
  })
})

test('cold non-Team session cannot drop its completion gate or original source scope', async t => {
  const f = await fixture(t)
  await f.register()
  await f.c.run('goal_bind', { planId: 'p', expectedGoalId: f.ref.id, expectedGoalRevision: f.ref.revision })
  await f.reload(false)
  assert.throws(() => f.c.goals.complete(f.c.agent, f.ref), { code: 'GOAL_DELIVERY_BRIDGE_UNAVAILABLE' })
  await assert.rejects(initializeNativeHost(f.c.ctx, () => installSessionDelivery(f.c.ctx, f.c.agent,
    { ...f.config, writeScopes: ['source.txt'] })), { code: 'SESSION_DELIVERY_AUTHORITY_MISMATCH' })
})

// Ordinary-session compaction gate: real BasicCompactionEngine over the fixture's real session, fake summarizer only.
const { createUserMessage } = await load('dsh-llm')
const chat = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const tokens = message => Math.ceil(JSON.stringify(message.content).length / 4)
async function compact(f, summary) {
  const { session, flush } = f.c, ctx = new Context()
  for (const body of ['old1 '.repeat(3000), 'old2 '.repeat(3000), 'tail '.repeat(20)]) session.append('user/message', chat(body), { surfaceOp: 'append' })
  session.requestHeader = () => ({ config: { provider: 'fixture', model: 'fixture', maxTokens: 1 } })
  ctx.provide('tokenMeter', { estimateMessage: tokens, measure: s => {
    const nodes = s.surface.nodes.map(seq => { const n = tokens(s.deriveEventMessage(s.eventAt(seq))); return { seq, tokens: n, heuristicTokens: n } })
    return { nodes, totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0) }
  } })
  ctx.provide('sessions', { flush })
  ctx.provide('llm', { resolveModelInfo: async () => ({ context: { contextWindow: 8000 }, defaultMaxTokens: 1 }) })
  const engine = new class extends BasicCompactionEngine {
    async summarize() { return { summary: [{ type: 'text', text: summary }], provider: 'fixture', model: 'fixture' } }
  }(ctx, { auto: false, headroomTokens: 1, retainTokens: 50, manualRetainTokens: 50 })
  const result = await engine.compactNow({ session, options: { provider: 'fixture', model: 'fixture' },
    runMaintenance: fn => fn(new AbortController().signal) }, new AbortController().signal)
  assert.ok(result)
  return result
}
const identity = plan => 'plan ' + plan.planId + ' hash ' + plan.planHash.slice(0, 12) + ' file ' + plan.ref.sha256.slice(0, 12)
async function previewCommit(f, planId, key) {
  const preview = (await f.c.run('preview', { planId })).value
  const commit = await f.c.run('commit', { planId, idempotencyKey: key, expectedPlanRevision: preview.planRevision,
    expectedPlanHash: preview.planHash, sourceIdentity: preview.sourceIdentity, coverageMatrixHash: preview.coverageMatrixHash,
    sourceRevisionVector: preview.sourceRevisionVector })
  return { preview, commit }
}
async function bigPlan(f, done) {
  const items = Array.from({ length: 10 }, (_, i) => { const n = String(i + 1).padStart(2, '0')
    return { requirementId: 'req-' + n, taskRefs: [{ boardId: 'session', taskId: 'task-' + n }], requiredDimensions: ['implemented'], implementationRefs: ['impl-' + n] } })
  const body = JSON.stringify({ kind: 'dsh-plan-contract', version: 1, planId: 'big', scope: ['source.txt'], items }, null, 2)
  const path = join(f.root, 'big-plan.json'); writeFileSync(path, body)
  const registered = await f.c.run('plan_register', { planId: 'big', expectedPlanRevision: 0, ref: { path, sha256: createHash('sha256').update(body).digest('hex') } })
  assert.equal(registered.isError, false, JSON.stringify(registered.error))
  const plan = registered.value.plan
  for (let i = 1; i <= done; i++) { const n = String(i).padStart(2, '0')
    const proof = await f.c.run('implementation_prove', { planId: 'big', expectedPlanRevision: plan.planRevision, expectedPlanHash: plan.planHash,
      requirementId: 'req-' + n, boardId: 'session', taskId: 'task-' + n, expectedTaskRevision: 1, expectedContractRevision: 1, proofRef: 'impl-' + n, locator: 'source.txt' })
    assert.equal(proof.isError, false, JSON.stringify(proof.error))
  }
  return plan
}

test('compacted summary that lost the plan identity registers debt and commit names what is missing', async t => {
  const f = await fixture(t, { goal: false })
  await f.register(); await f.proof('impl'); await f.proof('test')
  await compact(f, '## Primary Request\n- keep working on the file; everything looks fine')
  const { preview, commit } = await previewCommit(f, 'p', 'gate-a')
  assert.ok(preview.globalBlockers.includes('unresolved-debt-or-blockers'))
  assert.ok(preview.compactionDebt.includes('compaction-memory:session:p:anchor-missing:plan-hash'), JSON.stringify(preview.compactionDebt))
  assert.ok(preview.compactionDebt.includes('compaction-memory:session:p:anchor-missing:recovery-locator'))
  assert.equal(commit.isError, true)
  assert.match(JSON.stringify(commit.error), /uncovered \[compaction debt: .*compaction-memory:session:p:anchor-missing:plan-hash/)
  assert.equal((await f.c.run('status')).value.deliverable, false)
})

test('explicit compaction_anchor repairs the debt for that summary only and the next compaction needs a new anchor', async t => {
  const f = await fixture(t, { goal: false })
  await f.register(); await f.proof('impl'); await f.proof('test')
  await compact(f, 'lost the plan')
  // A thrown commit would leave its own native unknown-tool-effect debt, so the repair is exercised from preview.
  assert.ok((await f.c.run('preview', { planId: 'p' })).value.globalBlockers.includes('unresolved-debt-or-blockers'))
  const anchor = await f.c.run('compaction_anchor', { planId: 'p' })
  assert.equal(anchor.isError, false, JSON.stringify(anchor.error))
  assert.equal(anchor.value.anchored, true)
  assert.match(anchor.value.anchorText, new RegExp(f.plan.planHash.slice(0, 12)))
  const ok = await previewCommit(f, 'p', 'gate-b1')
  assert.equal(ok.preview.compactionDebt, undefined)
  assert.equal(ok.commit.isError, false, JSON.stringify(ok.commit.error))
  await compact(f, 'lost the plan again')
  const stale = await previewCommit(f, 'p', 'gate-b2')
  assert.ok(stale.preview.compactionDebt.length > 0)
  assert.equal((await f.c.run('status')).value.deliverable, false)
})

test('a later complete summary clears the compaction debt without any anchor record', async t => {
  const f = await fixture(t, { goal: false })
  await f.register(); await f.proof('impl'); await f.proof('test')
  await compact(f, 'lost the plan')
  assert.ok((await f.c.run('preview', { planId: 'p' })).value.compactionDebt.length > 0)
  await compact(f, identity(f.plan))
  const ok = await previewCommit(f, 'p', 'gate-c')
  assert.equal(ok.preview.compactionDebt, undefined)
  assert.equal(ok.commit.isError, false, JSON.stringify(ok.commit.error))
})

test('ten-item plan with six proven stays partial although the summary claims everything is complete', async t => {
  const f = await fixture(t, { goal: false })
  const plan = await bigPlan(f, 6)
  const claim = identity(plan) + ' all 10 requirements are complete, delivered and accepted'
  await compact(f, claim)
  const preview = (await f.c.run('preview', { planId: 'big' })).value
  assert.equal(preview.status, 'partial')
  assert.equal(preview.complete, false)
  // The summary debt is a global blocker, so the evaluator holds every item back; item facts still show the real six.
  assert.deepEqual(preview.matrix.filter(row => row.remaining.length).map(row => row.requirementId), ['req-07', 'req-08', 'req-09', 'req-10'])
  assert.deepEqual(preview.compactionDebt, ['07', '08', '09', '10'].map(n => 'compaction-memory:session:big:anchor-missing:pending:req-' + n))
  assert.equal((await f.c.run('status')).value.deliverable, false)
  await compact(f, claim + ' pending req-07 req-08 req-09 req-10')
  const listed = await previewCommit(f, 'big', 'gate-d2')
  assert.equal(listed.preview.compactionDebt, undefined)
  assert.equal(listed.preview.status, 'partial')
  assert.deepEqual(listed.preview.remainingScope, ['req-07', 'req-08', 'req-09', 'req-10'])
  assert.equal(listed.preview.complete, false)
  assert.equal(listed.commit.isError, true)
})

test('a complete summary or no compaction at all adds no compaction debt', async t => {
  const f = await fixture(t, { goal: false })
  await f.register(); await f.proof('impl'); await f.proof('test')
  assert.equal((await f.c.run('preview', { planId: 'p' })).value.compactionDebt, undefined)
  await compact(f, identity(f.plan))
  const ok = await previewCommit(f, 'p', 'gate-e')
  assert.equal(ok.preview.compactionDebt, undefined)
  assert.equal(ok.commit.isError, false, JSON.stringify(ok.commit.error))
  assert.equal((await f.c.run('status')).value.deliverable, true)
})

// A thrown tool body is logged by the runtime as native/tool-effect "unknown". A gate that refused before it wrote anything is not
// an unknown effect, but a failure after the write began, and every other tool's unknown effect, must keep blocking delivery.
const unknownEffects = f => f.c.session.log.filter(event => event.type === 'native/tool-effect' && event.data.effectOutcome === 'unknown')
const rejectedLedger = f => readControlPlaneSnapshot(f.c.service.control.file).v15SessionRefusedCalls

test('a premature commit that the gate refused does not leave unknown-effect debt once the missing proof exists', async t => {
  const f = await fixture(t, { goal: false })
  await f.register(); await f.proof('impl')
  const early = await previewCommit(f, 'p', 'early-1')
  assert.equal(early.commit.isError, true)
  assert.equal(unknownEffects(f).length, 1, 'the runtime still records the thrown call as unknown; the plugin must classify it')
  await f.proof('test')
  const ok = await previewCommit(f, 'p', 'early-2')
  assert.equal(ok.preview.globalBlockers.includes('unresolved-debt-or-blockers'), false, JSON.stringify(ok.preview.globalBlockers))
  assert.equal(ok.commit.isError, false, JSON.stringify(ok.commit.error))
  assert.equal((await f.c.run('status')).value.deliverable, true)
})

test('repeated refused commits stay recoverable, also after a cold reload', async t => {
  const f = await fixture(t, { goal: false })
  await f.register(); await f.proof('impl')
  for (const key of ['again-1', 'again-2', 'again-3']) assert.equal((await previewCommit(f, 'p', key)).commit.isError, true)
  assert.equal(unknownEffects(f).length, 3)
  await f.reload()
  await f.proof('test')
  const ok = await previewCommit(f, 'p', 'again-4')
  assert.equal(ok.preview.globalBlockers.includes('unresolved-debt-or-blockers'), false, JSON.stringify(ok.preview.globalBlockers))
  assert.equal(ok.commit.isError, false, JSON.stringify(ok.commit.error))
})

test('refused commits never clear another tool\'s unknown effect', async t => {
  const f = await fixture(t, { goal: false })
  await f.register(); await f.proof('impl'); await f.proof('test')
  f.c.agent.ctx.tools.register({ name: 'crashing_tool', description: 'throws after it started', parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: {}, render: (_, result) => [{ type: 'text', text: JSON.stringify(result) }] }, execute() { throw new Error('crashed mid effect') } })
  const crashed = await f.c.runtime.execute({ name: 'crashing_tool', arguments: {}, callId: 'crash-1', agent: f.c.agent, signal: new AbortController().signal })
  assert.equal(crashed.isError, true)
  const blocked = await previewCommit(f, 'p', 'other-1')
  assert.ok(blocked.preview.globalBlockers.includes('unresolved-debt-or-blockers'))
  assert.equal(blocked.commit.isError, true)
  // The refused commit is classified, the crash is not: the debt must survive the classification of the later call.
  const still = await previewCommit(f, 'p', 'other-2')
  assert.ok(still.preview.globalBlockers.includes('unresolved-debt-or-blockers'))
  assert.equal(still.commit.isError, true)
  assert.equal((await f.c.run('status')).value.deliverable, false)
})

test('a session_delivery failure after the write began keeps its unknown effect and is never classified as refused', async t => {
  const f = await fixture(t, { goal: false })
  await f.register(); await f.proof('impl'); await f.proof('test')
  const preview = (await f.c.run('preview', { planId: 'p' })).value
  const append = f.c.handle.append.bind(f.c.handle)
  let armed = true
  // The control plane commit lands first; the injected fault then hits the session flush that follows it.
  f.c.handle.append = async (...args) => { if (armed) { armed = false; throw new Error('INJECTED_WRITE_FAULT') } return append(...args) }
  const commit = await f.c.run('commit', { planId: 'p', idempotencyKey: 'fault-1', expectedPlanRevision: preview.planRevision,
    expectedPlanHash: preview.planHash, sourceIdentity: preview.sourceIdentity, coverageMatrixHash: preview.coverageMatrixHash,
    sourceRevisionVector: preview.sourceRevisionVector })
  assert.equal(armed, false, 'the fault must have fired')
  assert.equal(commit.isError, true)
  assert.equal(unknownEffects(f).length, 1)
  assert.equal(rejectedLedger(f), undefined, 'a post-write failure must not enter the refusal ledger')
  const after = (await f.c.run('preview', { planId: 'p' })).value
  assert.ok(after.globalBlockers.includes('unresolved-debt-or-blockers'), JSON.stringify(after.globalBlockers))
  assert.equal(after.compactionDebt, undefined)
})
