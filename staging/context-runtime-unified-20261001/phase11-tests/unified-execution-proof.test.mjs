import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { controlPlaneFor, readControlPlaneSnapshot, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { createPlanRegistry } from '../home/profiles/web/plugins/team-v15-plan-registry.mjs'
import { collectDeliveryContext } from '../home/profiles/web/plugins/team-v15-delivery-source.mjs'
import { createExecutionProofProducer } from '../home/profiles/web/plugins/team-v15-execution-proof.mjs'

async function fixture(t, kind = 'test') {
  const root = mkdtempSync(join(tmpdir(), 'execution-proof-'))
  t.after(() => { resetControlPlaneCache(); rmSync(root, { recursive: true, force: true }) })
  const ref = (name, text) => { const path = join(root, name); writeFileSync(path, text); return { path, sha256: createHash('sha256').update(text).digest('hex') } }
  const file = ref('source.mjs', 'export const value = 1\n')
  const source = { kind: 'dsh-plan-contract', version: 1, planId: 'p', scope: ['source.mjs'], items: [{ requirementId: 'r',
    taskRefs: [{ boardId: 'global', taskId: 't' }], testEvidenceRefs: ['test'], acceptanceEvidenceRefs: ['acceptance'] }] }
  const planRef = ref('plan.json', JSON.stringify(source, null, 2))
  const recipe = { id: 'fixed', kind, toolName: 'bash', arguments: { command: 'node server-check.mjs', workdir: root, description: 'Run server quality checks', timeoutMs: 15000 },
    checks: ['exact-result', 'no-regression'], slots: [{ planId: 'p', requirementId: 'r', boardId: 'global', taskId: 't', proofRef: kind }] }
  const recipeRef = ref('recipes.json', JSON.stringify({ schema: 'dsh-execution-recipes-v1', recipes: [recipe] }, null, 2))
  const environmentRef = ref('env.json', '{}')
  const control = controlPlaneFor('execution-team', { directory: join(root, 'control') })
  const readDurable = () => readControlPlaneSnapshot(control.file)
  const registry = createPlanRegistry({ control, readDurable, authorize: () => true, allowedRoots: [root] })
  await control.mutateHot('fixture/tasks', {}, null, state => {
    state.boards = { global: { tasks: { t: { id: 't', revision: 1, ownerName: 'alice', contract: { contractRevision: 2 } } } } }
    state.leases.l = { member: 'alice', taskId: 't', contractRevision: 2, status: 'active', expiresAt: 100 }
  }, { deferMs: 0 })
  const registered = await registry.register({ planId: 'p', ref: planRef, expectedPlanRevision: 0 })
  const policy = { workspaceRoot: root, allowedRoots: [root], environmentRefs: [environmentRef], recipeRef,
    collectAuthorityDebt: () => ({ unresolvedDebt: [], blockers: [] }) }
  const quality = { schema: 'dsh-execution-quality-v1', recipeId: 'fixed', kind,
    checks: recipe.checks.map(id => ({ id, passed: true })) }
  const abort = new AbortController()
  const f = { root, file, planRef, recipeRef, environmentRef, control, readDurable, quality, abort, calls: [],
    result: { isError: false, value: { kind: 'foreground', exitCode: 0, signal: null, timedOut: false, aborted: false,
      stdout: { text: JSON.stringify(quality), truncated: false }, stderr: { text: '', truncated: false } } } }
  const toolRuntime = { async execute(call) { f.calls.push(call); await f.onExecute?.(); return f.result } }
  const producer = createExecutionProofProducer({ control, readDurable: () => f.readback?.() ?? readDurable(),
    collectContext: (state, plan) => collectDeliveryContext(state, plan, policy), verifyPlan: plan => registry.verify(plan),
    authorize: () => f.denied !== true, now: () => 10, toolRuntime, recipeRef, allowedRoots: [root],
    captureCancellation: () => ({ signal: abort.signal, isCancelled: () => f.cancelled === true }) })
  const request = { planId: 'p', expectedPlanRevision: 1, expectedPlanHash: registered.plan.planHash,
    requirementId: 'r', boardId: 'global', taskId: 't', expectedTaskRevision: 1, expectedContractRevision: 2, proofRef: kind, recipeId: 'fixed' }
  // Unit-only execution token. The native suite uses only actual runtime tokens.
  return Object.assign(f, { producer, request, exec: { token: Symbol('unit'), callId: 'unit-parent', agent: {}, signal: abort.signal } })
}

test('test and acceptance proofs bind exact server recipe, physical sources and durable authority', async t => {
  for (const kind of ['test', 'acceptance']) await t.test(kind, async t => {
    const f = await fixture(t, kind), result = await f.producer.prove(f.request, f.exec)
    assert.equal(result.durable, true)
    assert.equal(result.proof.kind, kind)
    assert.deepEqual(result.proof.provenance.quality, f.quality)
    assert.deepEqual(f.readDurable().v12Evidence.records[kind], result.proof)
    assert.equal(result.authority.leaseRef, 'l')
    assert.equal(f.calls[0].arguments.command, 'node server-check.mjs')
    assert.equal(f.calls[0].parent, f.exec.token)
    assert.equal(result.proof.sourceIdentity.manifestHash.length, 64)
  })
})

test('caller cannot supply results, status, hashes, commands or foreign slots', async t => {
  const f = await fixture(t)
  for (const key of ['status', 'command', 'result', 'artifactHash', 'parent']) {
    await assert.rejects(f.producer.prove({ ...f.request, [key]: 'passed' }, f.exec), { code: 'EXECUTION_PROOF_INPUT_INVALID' })
  }
  await assert.rejects(f.producer.prove({ ...f.request, proofRef: 'foreign' }, f.exec), { code: 'EXECUTION_SLOT_DENIED' })
  await assert.rejects(f.producer.prove({ ...f.request, recipeId: 'other' }, f.exec), { code: 'EXECUTION_RECIPE_DENIED' })
  assert.equal(f.calls.length, 0)
})

test('zero exit, prose passed, incomplete/duplicate/failed checks, background, truncation and exceptions fail closed', async t => {
  const cases = [
    f => { f.result.value.stdout.text = 'passed' },
    f => { f.result.value.stdout.text = JSON.stringify({ ...f.quality, checks: [] }) },
    f => { f.result.value.stdout.text = JSON.stringify({ ...f.quality, checks: [f.quality.checks[0], f.quality.checks[0]] }) },
    f => { f.quality.checks[0].passed = false; f.result.value.stdout.text = JSON.stringify(f.quality) },
    f => { f.result.value.kind = 'background' },
    f => { f.result.value.stdout.truncated = true },
    f => { f.result.value.aborted = true },
    f => { f.result.value.exitCode = 1 },
    f => { f.result.isError = true },
    f => { f.onExecute = () => { throw new Error('transport failed') } },
  ]
  for (const [i, alter] of cases.entries()) await t.test(String(i), async t => {
    const f = await fixture(t); alter(f)
    await assert.rejects(f.producer.prove(f.request, f.exec))
    assert.equal(f.readDurable().v12Evidence.records.test, undefined)
  })
})

test('changes during actual execution invalidate source, environment, recipe, plan, task, lease and authorization', async t => {
  const changes = {
    source: f => writeFileSync(f.file.path, 'export const value = 2'),
    environment: f => writeFileSync(f.environmentRef.path, '{"changed":true}'),
    recipe: f => writeFileSync(f.recipeRef.path, '{}'),
    plan: f => writeFileSync(f.planRef.path, '{}'),
    task: f => f.control.mutateHot('fixture/change', {}, null, s => { s.boards.global.tasks.t.revision++ }, { deferMs: 0 }),
    contract: f => f.control.mutateHot('fixture/change', {}, null, s => { s.boards.global.tasks.t.contract.contractRevision++ }, { deferMs: 0 }),
    lease: f => f.control.mutateHot('fixture/change', {}, null, s => { s.leases.l.expiresAt = 99 }, { deferMs: 0 }),
    owner: f => f.control.mutateHot('fixture/change', {}, null, s => { s.boards.global.tasks.t.ownerName = 'bob' }, { deferMs: 0 }),
    authorization: f => { f.denied = true },
    cancellation: f => f.abort.abort(),
    nativeCancellation: f => { f.cancelled = true },
  }
  for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
    const f = await fixture(t); f.onExecute = () => change(f)
    await assert.rejects(f.producer.prove(f.request, f.exec))
    assert.equal(f.readDurable().v12Evidence.records.test, undefined)
  })
})

test('pre-cancel and durable readback mismatch do not return durable success', async t => {
  const f = await fixture(t); f.abort.abort()
  await assert.rejects(f.producer.prove(f.request, f.exec), { code: 'EXECUTION_CANCELLED' })
  assert.equal(f.calls.length, 0)
  const g = await fixture(t)
  g.readback = () => ({ ...g.readDurable(), rootId: 'foreign-root' })
  await assert.rejects(g.producer.prove(g.request, g.exec), { code: 'EXECUTION_DURABLE_READBACK_MISMATCH' })
  assert.equal(g.readDurable().v12Evidence.records.test.status, 'invalidated')
  const h = await fixture(t)
  h.readback = () => { h.abort.abort(); return h.readDurable() }
  await assert.rejects(h.producer.prove(h.request, h.exec), { code: 'EXECUTION_CANCELLED' })
  assert.equal(h.readDurable().v12Evidence.records.test.status, 'invalidated')
})
