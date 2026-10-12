import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, watch } from 'node:fs'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getHostLifecycleGate } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { installNativeSessionBridge } from '@deepseek-ai/dsh-session'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { runProfile } from '../app/node_modules/@deepseek-ai/dsh/lib/profile-boot.js'
import { installSessionDelivery } from '../home/profiles/web/plugins/session-plan-delivery.mjs'

const stage = fileURLToPath(new URL('../', import.meta.url))
const replay = process.argv.includes('--replay'), ui = replay || process.argv.includes('--ui')
const strict = process.argv.includes('--strict')
const directory = replay ? resolve(process.argv[process.argv.indexOf('--replay') + 1]) : resolve(stage, 'lab-runs/session-delivery-' + randomUUID())
assert.ok(directory.startsWith(resolve(stage, 'lab-runs') + sep))
assert.equal(process.env.DSH_LAB_CANONICAL_MODULES, '1')
assert.equal(resolve(process.env.DSH_HOME), resolve(stage, 'lab-host-home'))
const bounded = async (label, action, ms = 15000) => {
  let timer
  try { return await Promise.race([action, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DELIVERY_LAB_TIMEOUT_' + label)), ms) })]) }
  finally { clearTimeout(timer) }
}
const marker = async name => {
  let observer
  const path = resolve(directory, name)
  try { await bounded(name, new Promise((accept, reject) => {
    const check = () => { if (existsSync(path)) accept() }
    observer = watch(directory, check); observer.on('error', reject); check()
  }), 300000) } finally { observer?.close() }
}
const file = async (name, body) => {
  const path = resolve(directory, name)
  await writeFile(path, body)
  return { path, sha256: createHash('sha256').update(body).digest('hex') }
}
let ctx, agent, delivery, requests = 0, externalRequests = 0, run, proof, barrier, pending, registration
const agentErrors = []
try {
  await mkdir(directory, { recursive: true })
  const overlay = resolve(directory, 'storage-overlay.json')
  if (!replay) await writeFile(overlay, JSON.stringify([
    { id: 'session-persistence-jsonl', config: { root: resolve(directory, 'sessions') } },
    { id: 'session-query-sqlite', config: { path: resolve(directory, 'query.sqlite'), openAt: 'startup' } },
    ...['context-workspace', 'agent-team', 'tool-agent-team-v2', 'team-v12-runtime', 'team-v14-event-continuation', 'team-policy', 'team-health',
      'team-idle-watch', 'team-runtime-guard', 'team-operator', 'write-scope-guard', 'step-compaction', 'failure-memory'].map(id => ({ id, disabled: true })),
  ]))
  const rows = JSON.parse(await readFile(overlay, 'utf8'))
  assert.equal(rows.find(row => row.id === 'session-persistence-jsonl').config.root, resolve(directory, 'sessions'))
  assert.equal(rows.find(row => row.id === 'agent-team').disabled, true)
  const host = await runProfile({ environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }]),
    profile: 'web', patchFiles: [overlay], args: ['--no-open', '--port', '40124'] })
  ctx = host.ctx
  await getHostLifecycleGate(ctx).observeSettlement(() => getHostLifecycleGate(ctx).runAsync(async () => {
    assert.equal(ctx.get('agentTeams'), undefined)
    ctx.on('llm/stream', (options, next) => {
      if (replay || options.provider !== 'delivery-fixture') { externalRequests++; throw new Error('EXTERNAL_PROVIDER_REFUSED') }
      return next()
    }, { global: true })
    if (replay) { ctx.on('agent/pre-step', () => ({ kind: 'reject', reason: 'read-only delivery replay' }), { global: true }); return }
    ctx.on('agent/error', event => { agentErrors.push(String(event.error?.message ?? event.error)) }, { global: true })
    ctx.llm.registerAdapter(['delivery-fixture'], new class extends LlmAdapter {
      providerInfo(provider) { return { id: provider, name: provider } }
      listModels(provider) { return [{ provider, id: 'fixture', name: 'Fixture' }] }
      async prepareCall(provider, model) { return { model: { provider, id: model, name: model }, stream: () => (async function* () {
        // Six tool turns each need a proposal and a terminal response, plus one text-only turn.
        if (++requests > (strict ? 15 : 13)) throw new Error('DELIVERY_REQUEST_BUDGET_EXCEEDED')
        if (pending) {
          const current = pending; pending = undefined
          yield { type: 'tool-call-delta', index: 0, id: current.callId, name: 'run_code', argumentsDelta: JSON.stringify(current.arguments) }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'text-delta', index: 0, text: 'All requirements are complete.' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })() } }
    }())
    const composition = await ctx.sessionController.agents.composeAgent('ptc')
    agent = (await ctx.agents.create({ sessionId: randomUUID(), agentOptions: { provider: 'delivery-fixture', model: 'fixture', maxTokens: 64 },
      meta: { cwd: directory, agentPreset: composition.agentPreset }, setup: composition.setup })).agent
    barrier = await ctx.sessionPersistence.windowBarrierFor(agent.session, { isolated: true, sessionId: agent.session.id })
    installNativeSessionBridge(agent.session, { isolated: true, sessionId: agent.session.id, flush: async () => (await barrier.persist()).durable === true })
    await file('source.txt', 'verified output\n')
    await file('oracle.cjs', `const fs=require('node:fs');const assert=require('node:assert/strict');assert.equal(fs.readFileSync('source.txt','utf8'),'verified output\\n');process.stdout.write(JSON.stringify({schema:'dsh-execution-quality-v1',recipeId:'check',kind:'test',checks:[{id:'content',passed:true}]}));`)
    const recipeRef = await file('recipes.json', JSON.stringify({ schema: 'dsh-execution-recipes-v1', recipes: [{ id: 'check', kind: 'test', toolName: 'bash',
      arguments: { command: `& '${process.execPath.replaceAll('\\', '/')}' oracle.cjs`, description: 'Verify delivery fixture', workdir: directory, timeoutMs: 15000 },
      checks: ['content'], slots: [{ planId: 'plain-plan', requirementId: 'file-check', boardId: 'session', taskId: 'check', proofRef: 'test' }] }] }, null, 2))
    const contract = { kind: 'dsh-plan-contract', version: 1, planId: 'plain-plan', scope: ['source.txt', 'oracle.cjs'],
      items: [{ requirementId: 'file-check', taskRefs: [{ boardId: 'session', taskId: 'check' }], requiredDimensions: ['implemented', 'tested'],
        implementationRefs: ['impl'], testEvidenceRefs: ['test'] }] }
    const ref = await file('plan.json', JSON.stringify(contract, null, 2))
    delivery = await installSessionDelivery(ctx, agent, { workspaceRoot: directory, writeScopes: contract.scope, allowedRoots: [directory],
      controlDir: resolve(directory, 'control'), environmentRefs: [await file('environment.json', '{}')], recipeRef, requirePlan: strict })
    let calls = 0
    run = async (action, input = {}) => {
      const current = pending = {
        arguments: { code: 'return await tools.session_delivery(' + JSON.stringify({ action, input }) + ');', description: 'Bounded delivery fixture ' + action },
        callId: 'delivery-lab-' + ++calls }
      await agent.steer(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Delivery fixture tool: ' + action }] }))
      await bounded('tool-' + action, agent.whenIdle())
      assert.deepEqual(agentErrors, [])
      assert.equal(agent.inbox.hasPending, false, 'canonical turn must consume the fixture input')
      const result = agent.session.log.findLast(row => row.type === 'native/tool-effect' && row.data.callId === current.callId)?.data.result
      assert.ok(result, 'actual open-turn PTC dispatch must execute')
      assert.equal(result.isError, false, JSON.stringify(result.error))
      return result.value.result
    }
    registration = { planId: contract.planId, expectedPlanRevision: 0, ref }
  }))
  if (replay) {
    console.log('DELIVERY_UI_REPLAY_READY=' + JSON.stringify({ directory, externalRequests }))
    await marker('browser-replay-closed.txt')
  } else {
    // The lab home persists the last selected model across lab runs, so bind the fixture model before the first turn.
    await ctx.sessionController.selectModel({ sessionId: agent.session.id, provider: 'delivery-fixture', model: 'fixture' })
    if (strict) {
      const status = await run('status')
      assert.equal(status.deliverable, false)
      assert.equal(status.code, 'DELIVERY_PLAN_REQUIRED')
      const event = agent.session.log.findLast(row => row.type === 'native/delivery-status')
      assert.equal(event.data.status, 'partial')
      assert.deepEqual(event.data.plans, [])
      console.log('DELIVERY_UI_UNREGISTERED=' + JSON.stringify({ directory, sessionId: agent.session.id, externalRequests }))
      if (ui) await marker('register.txt')
    }
    const { plan } = await run('plan_register', registration)
    proof = { planId: plan.planId, expectedPlanRevision: plan.planRevision, expectedPlanHash: plan.planHash,
      requirementId: 'file-check', boardId: 'session', taskId: 'check', expectedTaskRevision: 1, expectedContractRevision: 1 }
    await run('implementation_prove', { ...proof, proofRef: 'impl', locator: 'source.txt' })
    await agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'delivery-proof-check' }] }))
    await bounded('idle', agent.whenIdle()); await barrier.persist()
    assert.equal(ctx.goals.get(agent), undefined)
    assert.equal(agent.session.log.some(row => row.type.startsWith('team/')), false)
    assert.equal(agent.session.log.findLast(row => row.type === 'native/delivery-status')?.data.status, 'partial')
    assert.equal(requests, strict ? 7 : 5)
    console.log('DELIVERY_UI_PARTIAL=' + JSON.stringify({ directory, sessionId: agent.session.id, externalRequests }))
    if (ui) await marker('accept.txt')
    await run('execution_prove', { ...proof, proofRef: 'test', recipeId: 'check' })
    const preview = await run('preview', { planId: proof.planId })
    await run('commit', { planId: proof.planId, idempotencyKey: 'browser-final', expectedPlanRevision: preview.planRevision,
      expectedPlanHash: preview.planHash, sourceIdentity: preview.sourceIdentity, coverageMatrixHash: preview.coverageMatrixHash,
      sourceRevisionVector: preview.sourceRevisionVector })
    assert.equal(agent.session.log.findLast(row => row.type === 'native/delivery-status').data.status, 'accepted')
    console.log('DELIVERY_UI_ACCEPTED=' + agent.session.id)
    if (ui) await marker('stale.txt')
    await file('source.txt', 'changed after receipt\n')
    assert.equal((await run('status')).deliverable, false)
    assert.equal(agent.session.log.findLast(row => row.type === 'native/delivery-status').data.status, 'partial')
    assert.equal(requests, strict ? 15 : 13)
    assert.equal(externalRequests, 0)
    await barrier.persist()
    await file('evidence.json', JSON.stringify({ scope: 'actual-non-Team-host-fake-adapter-not-provider', directory, sessionId: agent.session.id,
      strict, requests, externalRequests, agentErrors, pendingInput: agent.inbox.hasPending, noGoal: ctx.goals.get(agent) === undefined, teamEvents: 0,
      statuses: agent.session.log.filter(row => row.type === 'native/delivery-status').map(row => ({ seq: row.seq, data: row.data })) }, null, 2))
    console.log('DELIVERY_UI_STALE=' + agent.session.id)
    if (ui) await marker('browser-closed.txt')
  }
} catch (error) {
  console.error('DELIVERY_LAB_ERROR=' + JSON.stringify({ code: error.code, message: error.message, stack: error.stack?.split('\n').slice(0, 7), requests, externalRequests }))
  throw error
} finally {
  if (ctx) {
    if (agent) { agent.cancel({ kind: 'user' }, { keepInbox: true }); await bounded('dispose-idle', agent.whenIdle()) }
    delivery?.dispose()
    await getHostLifecycleGate(ctx).observeSettlement(() => getHostLifecycleGate(ctx).runAsync(() => ctx.fiber.dispose()))
    console.log('DELIVERY_HOST_DISPOSED=true')
  }
}
