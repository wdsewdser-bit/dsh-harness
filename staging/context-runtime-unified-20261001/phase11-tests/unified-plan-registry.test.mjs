import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { controlPlaneFor, readControlPlaneSnapshot, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { currentTaskPlanRefs } from '../home/profiles/web/plugins/team-v15-plan-refs.mjs'
import { createPlanRegistry, parsePlanSource, verifyRegisteredPlanSource } from '../home/profiles/web/plugins/team-v15-plan-registry.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const source = (items = 10) => ({ kind: 'dsh-plan-contract', version: 1, planId: 'full-plan', scope: ['product'],
  items: Array.from({ length: items }, (_, n) => ({ requirementId: 'r-' + n, mandatory: true,
    taskRefs: [{ boardId: 'global', taskId: 't-' + n }], requiredDimensions: ['implemented', 'tested', 'enabled', 'accepted'] })) })
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'unified-plan-registry-'))
  const control = controlPlaneFor('registry-' + randomUUID(), { directory })
  const path = join(directory, 'full-plan.md')
  function write(contract, suffix = '') {
    const text = '# Full Plan\n\nAll requirements below are authoritative.\n\n```dsh-plan-contract\n' + JSON.stringify(contract, null, 2) + '\n```\n' + suffix
    writeFileSync(path, text)
    return { planId: contract.planId, expectedPlanRevision: 0, ref: { path, sha256: hash(text) } }
  }
  const input = write(source())
  const read = () => readControlPlaneSnapshot(control.file)
  const registry = createPlanRegistry({ control, readDurable: read, allowedRoots: [directory], authorize: () => true, now: () => 10 })
  t.after(() => {
    resetControlPlaneCache()
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())))
    rmSync(directory, { recursive: true, force: true })
  })
  await control.mutateHot('fixture/tasks', {}, null, state => {
    state.boards.global = { tasks: { 't-0': { id: 't-0', planId: 'legacy-task-id', revision: 1, contract: { contractRevision: 1 } } } }
  }, { deferMs: 0 })
  return { directory, control, registry, input, read, write }
}

test('actual durable registry reads all ten source items, retains missing task coverage and binds current recovery', async t => {
  const f = await fixture(t)
  const result = await f.registry.register(f.input)
  assert.equal(result.durable, true)
  assert.equal(result.plan.items.length, 10)
  assert.equal(result.sourceReceipt.verificationScope, 'full-source-exact-contract')
  const doc = f.read()
  assert.deepEqual(doc.v15PlanDelivery.plans['full-plan'], result.plan)
  assert.deepEqual(f.registry.verify(result.plan), result.sourceReceipt)
  assert.equal(currentTaskPlanRefs(doc, { boardId: 'global', taskId: 't-0' }).planId, 'full-plan')
  assert.equal(doc.boards.global.tasks['t-0'].planId, 'legacy-task-id')
  assert.equal(doc.boards.global.tasks['t-0'].revision, 1)
  assert.equal(Object.keys(doc.v15PlanDelivery.taskPlanBindings.global).length, 10)
})

test('caller cannot replace complete source with six items or fabricated readback receipts', async t => {
  const f = await fixture(t)
  const before = f.read()
  for (const key of ['items', 'scope', 'planRefReceipts', 'planHash']) {
    await assert.rejects(f.registry.register({ ...f.input, [key]: source(6).items }), { code: 'PLAN_REGISTRATION_INPUT_INVALID' })
    assert.deepEqual(f.read(), before)
  }
})

test('stale source bytes, changed full prose and wrong declared plan id fail without persistence', async t => {
  const f = await fixture(t)
  const before = f.read()
  writeFileSync(f.input.ref.path, readFileSync(f.input.ref.path, 'utf8') + 'new user constraint\n')
  await assert.rejects(f.registry.register(f.input), { code: 'RECOVERY_SOURCE_HASH_MISMATCH' })
  assert.deepEqual(f.read(), before)
  const input = f.write(source())
  await assert.rejects(f.registry.register({ ...input, planId: 'other' }), { code: 'PLAN_SOURCE_ID_MISMATCH' })
  assert.deepEqual(f.read(), before)
})

test('source requires exactly one explicit canonical contract and rejects duplicate declarations', () => {
  assert.throws(() => parsePlanSource('# prose-only plan with ten requirements'), { code: 'PLAN_SOURCE_CONTRACT_REQUIRED' })
  const canonical = JSON.stringify(source(), null, 2)
  assert.equal(parsePlanSource(canonical).items.length, 10)
  assert.throws(() => parsePlanSource('```dsh-plan-contract\n' + canonical + '\n```\n```dsh-plan-contract\n' + canonical + '\n```\n'), { code: 'PLAN_SOURCE_CONTRACT_REQUIRED' })
  assert.throws(() => parsePlanSource(canonical.replace('"planId": "full-plan",', '"planId": "wrong",\n  "planId": "full-plan",')), { code: 'PLAN_SOURCE_NONCANONICAL' })
  assert.throws(() => parsePlanSource(JSON.stringify({ ...source(), accepted: true }, null, 2)), { code: 'PLAN_SOURCE_CONTRACT_INVALID' })
  const wrongItem = source()
  wrongItem.items[0].unlistedAcceptance = 'must not be silently ignored'
  assert.throws(() => parsePlanSource(JSON.stringify(wrongItem, null, 2)), { code: 'PLAN_SOURCE_CONTRACT_INVALID' })
})

test('root authorization, source budget and unauthorized physical path all fail closed', async t => {
  const f = await fixture(t)
  const before = f.read()
  for (const [extra, code] of [[{ authorize: () => false }, 'PLAN_REGISTRATION_DENIED'],
    [{ maxBytes: 1 }, 'RECOVERY_FULL_READ_BUDGET_EXCEEDED'], [{ allowedRoots: [] }, 'RECOVERY_PATH_DENIED']]) {
    const registry = createPlanRegistry({ control: f.control, readDurable: f.read, authorize: () => true, allowedRoots: [f.directory], ...extra })
    await assert.rejects(registry.register(f.input), { code })
    assert.deepEqual(f.read(), before)
  }
  const sibling = join(f.directory, 'sibling'), root = join(f.directory, 'allowed')
  mkdirSync(sibling); mkdirSync(root)
  writeFileSync(join(sibling, 'source.json'), JSON.stringify(source(), null, 2))
  symlinkSync(sibling, join(root, 'escape'), 'junction')
  const path = join(root, 'escape', 'source.json')
  const registry = createPlanRegistry({ control: f.control, readDurable: f.read, authorize: () => true, allowedRoots: [root] })
  await assert.rejects(registry.register({ ...f.input, ref: { path, sha256: hash(readFileSync(path)) } }), { code: 'RECOVERY_PATH_DENIED' })
  assert.deepEqual(f.read(), before)
})

test('plan revision CAS and mandatory weakening require canonical authorization, not fresh file hash alone', async t => {
  const f = await fixture(t)
  const first = await f.registry.register(f.input)
  await assert.rejects(f.registry.register(f.input), { code: 'DELIVERY_CAS_CONFLICT' })
  const before = f.read()
  const changed = f.write(source(6))
  await assert.rejects(f.registry.register({ ...changed, expectedPlanRevision: 1 }), { code: 'PLAN_SCOPE_CHANGE_UNAUTHORIZED' })
  assert.deepEqual(f.read(), before)
  assert.throws(() => verifyRegisteredPlanSource(first.plan, { allowedRoots: [f.directory] }), { code: 'RECOVERY_SOURCE_HASH_MISMATCH' })
})

test('unsupported durable hook never returns success, and changed disk readback is rejected', async t => {
  const f = await fixture(t)
  const control = { mutateHot: (...args) => f.control.mutateHot(...args.slice(0, 4), { deferMs: 0 }) }
  const registry = createPlanRegistry({ control, readDurable: f.read, authorize: () => true, allowedRoots: [f.directory] })
  await assert.rejects(registry.register(f.input), { code: 'PLAN_DURABLE_HOOK_UNSUPPORTED' })
  const input = { ...f.write(source()), expectedPlanRevision: 1 }
  const corrupt = createPlanRegistry({ control: f.control, readDurable: () => ({ ...f.read(), revision: -1 }), authorize: () => true, allowedRoots: [f.directory] })
  await assert.rejects(corrupt.register(input), { code: 'PLAN_DURABLE_READBACK_MISMATCH' })
})
