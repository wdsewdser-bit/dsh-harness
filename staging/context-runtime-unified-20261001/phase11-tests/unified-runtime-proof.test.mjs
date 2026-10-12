import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { apply as applyContext } from '../home/profiles/web/plugins/context-workspace.mjs'
import { controlPlaneFor, readControlPlaneSnapshot, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { resetPolicyServices } from '../home/profiles/web/plugins/team-policy.mjs'
import { createPlanRegistry } from '../home/profiles/web/plugins/team-v15-plan-registry.mjs'
import { collectDeliveryContext } from '../home/profiles/web/plugins/team-v15-delivery-source.mjs'
import { createImplementationProofProducer } from '../home/profiles/web/plugins/team-v15-implementation-proof.mjs'
import { createRuntimeProofProducer, runtimeProofDebt } from '../home/profiles/web/plugins/team-v15-runtime-proof.mjs'

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-proof-'))
  t.after(() => { resetControlPlaneCache(); resetPolicyServices(); rmSync(directory, { recursive: true, force: true }) })
  const root = dirname(fileURLToPath(new URL('../home/profiles/web/plugins/context-workspace.mjs', import.meta.url)))
  const ref = (name, value) => { const path = join(directory, name), body = JSON.stringify(value, null, 2); writeFileSync(path, body); return { path, sha256: createHash('sha256').update(body).digest('hex') } }
  const control = controlPlaneFor('runtime-team', { directory: join(directory, 'control') })
  await control.mutateHot('fixture', {}, null, state => {
    state.boards = { global: { tasks: { t: { id: 't', revision: 1, ownerName: 'root', contract: { contractRevision: 1, writeScopes: ['context-workspace.mjs'] } } } } }
    state.leases.l = { status: 'active', member: 'root', taskId: 't', contractRevision: 1, expiresAt: Date.now() + 60000 }
  }, { deferMs: 0 })
  const readDurable = () => readControlPlaneSnapshot(control.file)
  const registry = createPlanRegistry({ control, readDurable, allowedRoots: [directory], authorize: () => true })
  const result = await registry.register({ planId: 'p', expectedPlanRevision: 0, ref: ref('plan.json', {
    kind: 'dsh-plan-contract', version: 1, planId: 'p', scope: ['context-workspace.mjs'], items: [{ requirementId: 'r',
      taskRefs: [{ boardId: 'global', taskId: 't' }], implementationRefs: ['impl'], enablementReceiptRefs: ['enabled'] }],
  }) })
  const policy = { workspaceRoot: root, allowedRoots: [root, directory], environmentRefs: [ref('env.json', {})], recipeRef: ref('recipe.json', {}),
    collectAuthorityDebt: () => ({ unresolvedDebt: [], blockers: [] }) }
  const collectContext = (state, plan) => collectDeliveryContext(state, plan, policy)
  const request = { planId: 'p', expectedPlanRevision: 1, expectedPlanHash: result.plan.planHash, requirementId: 'r', boardId: 'global', taskId: 't',
    expectedTaskRevision: 1, expectedContractRevision: 1, proofRef: 'enabled', locator: 'context-workspace.mjs' }
  const common = { control, readDurable, collectContext, verifyPlan: plan => registry.verify(plan), authorize: () => true }
  await createImplementationProofProducer(common).prove({ ...request, proofRef: 'impl' })
  const brands = new WeakSet(), hooks = []
  const agent = { name: 'root', session: { id: 'isolated-runtime' }, ctx: { tools: { register: () => () => {} } } }
  const ctx = { agents: { list: () => [agent] }, agentTeams: { tryMembership: () => ({ id: 'runtime-team', name: 'root', tier: 0 }) },
    on: () => () => {}, effect: () => {}, provide: (_name, value) => { ctx.contextWorkspace = value; return () => {} },
    requestMessageProjection: { isAgentLoopRequest: options => brands.has(options), register: (_name, project, options) => { hooks.push({ project, ...options }); return () => {} } } }
  const config = { directory: join(directory, 'memo'), controlDir: join(directory, 'control'), mode: 'apply', appliedSessionIds: [agent.session.id] }
  const stop = applyContext(ctx, config); t.after(stop)
  const service = ctx.contextWorkspace, row = service.manage(agent, { action: 'memo_put', input: { sourceId: 'w', expectedRevision: 0, text: 'verified memo' } })
  const proposal = service.manage(agent, { action: 'propose', input: { expectedRevision: 0, operations: [{ op: 'select', sourceId: row.sourceId, revision: row.revision, sha256: row.sha256 }] } })
  assert.equal(service.manage(agent, { action: 'commit', input: { expectedRevision: 0, proposalId: proposal.proposalId } }).ok, true)
  const options = { sessionId: agent.session.id, purpose: 'conversation', messages: [{ id: 'input', role: 'user', content: [{ type: 'text', text: 'request' }] }] }; brands.add(options)
  const wire = { ...options, messages: hooks[0].project(options).messages }; brands.add(wire)
  const dispatch = () => hooks[0].onDispatch({ options: wire, receipt: { stage: 'handed-to-adapter', handedToAdapter: true, requestId: 'actual-wire' } })
  const producer = createRuntimeProofProducer({ ...common, collectRuntime: () => service.runtimeReceipt(agent) })
  return { producer, request, readDurable, control, config, dispatch, stop, collectRuntime: () => service.runtimeReceipt(agent) }
}

test('actual installed context callback produces durable deployment only after exact adapter dispatch', async t => {
  const f = await fixture(t)
  await assert.rejects(f.producer.prove(f.request), { code: 'RUNTIME_PROOF_NOT_CONSUMED' })
  assert.equal(f.readDurable().deploymentReceipts?.enabled, undefined)
  f.dispatch()
  const proof = await f.producer.prove(f.request), disk = f.readDurable()
  assert.equal(proof.durable, true)
  assert.deepEqual(disk.deploymentReceipts.enabled, proof.deployment)
  assert.deepEqual(disk.runtimeReceipts[proof.runtime.id], proof.runtime)
  assert.equal(proof.runtime.runtimeFacts.dispatch.requestId, 'actual-wire')
  assert.equal(proof.runtime.modelUnderstanding, 'unknown')
})

test('caller facts and undeclared slots cannot create runtime proof', async t => {
  const f = await fixture(t); f.dispatch()
  await assert.rejects(f.producer.prove({ ...f.request, runtimeFacts: { consumed: true } }), { code: 'RUNTIME_PROOF_INPUT_INVALID' })
  await assert.rejects(f.producer.prove({ ...f.request, proofRef: 'foreign' }), { code: 'RUNTIME_PROOF_SLOT_DENIED' })
  await assert.rejects(f.producer.prove({ ...f.request, expectedTaskRevision: 99 }), { code: 'DELIVERY_CAS_CONFLICT' })
  assert.equal(f.readDurable().deploymentReceipts?.enabled, undefined)
})

test('disabled and disposed live instances cannot reuse a prior dispatch', async t => {
  const f = await fixture(t); f.dispatch(); f.config.mode = 'shadow'
  await assert.rejects(f.producer.prove(f.request), { code: 'RUNTIME_PROOF_NOT_CONSUMED' })
  f.config.mode = 'apply'; f.stop()
  await assert.rejects(f.producer.prove(f.request), { code: 'RUNTIME_PROOF_NOT_CONSUMED' })
  assert.equal(f.readDurable().deploymentReceipts?.enabled, undefined)
})

test('each delivery rechecks live runtime facts; persisted passed receipt cannot hide later disablement', async t => {
  const f = await fixture(t); f.dispatch(); await f.producer.prove(f.request)
  const state = f.readDurable(), plan = state.v15PlanDelivery.plans.p
  assert.deepEqual(runtimeProofDebt(state, plan, f.collectRuntime), [])
  f.config.mode = 'shadow'
  assert.deepEqual(runtimeProofDebt(state, plan, f.collectRuntime), ['runtime-proof-stale:enabled'])
  f.config.mode = 'apply'
  assert.deepEqual(runtimeProofDebt(state, plan, f.collectRuntime), ['runtime-proof-stale:enabled'], 're-enable requires a fresh dispatch')
  assert.deepEqual(runtimeProofDebt(state, plan, () => { throw new Error('gone') }), ['runtime-proof-unavailable:enabled'])
  assert.equal(state.deploymentReceipts.enabled.status, 'passed', 'read-only debt collection never rewrites history')
})
