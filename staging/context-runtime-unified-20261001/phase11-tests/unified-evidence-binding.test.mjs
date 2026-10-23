import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildAcceptanceMatrix, buildVerificationPlan, createEvidenceRegistry,
  evidenceFingerprint, queryEvidence, reuseEvidenceForPlan,
} from '../home/profiles/web/plugins/team-v12-evidence-scheduler.mjs'
import { apply as applyRuntime } from '../home/profiles/web/plugins/team-v12-runtime.mjs'
import { controlPlaneForMember, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'

const binding = {
  commitSha: 'a'.repeat(40), treeHash: 'current-tree', contractRevision: 3,
  planRevision: 2, recipeId: 'test-recipe', recipeFingerprint: 'recipe-v1',
  environmentFingerprint: 'env-v1',
}
const task = (overrides = {}) => ({
  id: 'target', boardId: 'main', ...binding,
  acceptanceCriteria: [{ id: 'ac-1', text: 'observable behavior passes' }], ...overrides,
})
const evidence = (overrides = {}) => ({
  id: 'ev-1', taskId: 'target', boardId: 'main', requirementId: 'ac-1',
  status: 'passed', ...binding, ...overrides,
})
const covered = (target, row) => buildAcceptanceMatrix(target, createEvidenceRegistry([row]), { now: 10 }).covered

test('exact task and board bind acceptance despite colliding ac-1 ids', () => {
  assert.equal(covered(task(), evidence()), true)
  assert.equal(covered(task(), evidence({ taskId: 'foreign', reusable: true })), false)
  assert.equal(covered(task(), evidence({ boardId: 'other' })), false)
  assert.equal(covered(task(), evidence({ boardId: undefined })), false)
})

test('every explicitly current version, source, recipe and environment must match', () => {
  for (const key of Object.keys(binding)) {
    assert.equal(covered(task(), evidence({ [key]: 'old' })), false, key)
    assert.equal(covered(task(), evidence({ [key]: undefined })), false, 'missing ' + key)
  }
  assert.equal(covered(task(), evidence({ status: 'stale' })), false)
  assert.equal(covered(task(), evidence({ staleReasons: ['tree-changed'] })), false)
})

test('matching omissions cannot certify an incomplete current coverage key', () => {
  for (const key of ['treeHash', 'commitSha', 'contractRevision', 'planRevision', 'recipeFingerprint', 'environmentFingerprint']) {
    const missing = { [key]: undefined }
    assert.equal(covered(task(missing), evidence(missing)), false, 'both missing ' + key)
  }
  const manifest = { commitSha: undefined, treeHash: undefined, manifestHash: 'current-manifest' }
  assert.equal(covered(task(manifest), evidence(manifest)), true)
  for (const key of ['contractRevision', 'planRevision', 'recipeFingerprint', 'environmentFingerprint']) {
    assert.equal(covered(task({ ...manifest, [key]: undefined }), evidence({ ...manifest, [key]: undefined })), false,
      'manifest route missing ' + key)
  }
})

test('criterion metadata is retained and contract revision is independent of lifecycle revision', () => {
  const target = task({ ...binding, contractRevision: undefined, revision: 99,
    contract: { contractRevision: 3, acceptanceCriteria: [{ id: 'ac-1', text: 'passes', recipeFingerprint: 'criterion-recipe' }] },
  })
  assert.equal(covered(target, evidence({ recipeFingerprint: 'criterion-recipe' })), true)
  assert.equal(covered(target, evidence()), false)
  assert.equal(covered(target, evidence({ recipeFingerprint: 'criterion-recipe', contractRevision: 99 })), false)
})

test('criterion metadata cannot override current source or plan/contract versions', () => {
  for (const key of ['commitSha', 'treeHash', 'manifestHash', 'contractRevision', 'planRevision']) {
    const target = task({ manifestHash: 'current-manifest', acceptanceCriteria: [{ id: 'ac-1', text: 'passes', [key]: 'old' }] })
    assert.equal(covered(target, evidence({ manifestHash: 'current-manifest', [key]: 'old' })), false, key)
    assert.equal(covered(target, evidence({ manifestHash: 'current-manifest' })), true, 'current ' + key)
  }
})

test('non-Git acceptance requires an explicit current manifest; legacy records remain readable', () => {
  const target = task({ commitSha: undefined, treeHash: undefined, manifestHash: 'sha256-manifest-current' })
  const row = evidence({ commitSha: undefined, treeHash: undefined, manifestHash: 'sha256-manifest-current' })
  assert.equal(covered(target, row), true)
  assert.equal(covered(target, { ...row, manifestHash: 'old-manifest' }), false)
  assert.equal(covered({ ...target, manifestHash: undefined }, row), false)
  const legacy = { id: 'old', taskId: 'target', requirementId: 'ac-1', status: 'passed' }
  const registry = createEvidenceRegistry([legacy])
  assert.equal(queryEvidence(registry, { id: 'old' }).length, 1)
  assert.equal(buildAcceptanceMatrix(target, registry).covered, false)
})

test('environment details, including extra keys, cannot be hidden by an unchanged declared fingerprint', () => {
  const environment = { runtime: 'node-24', profile: 'web', deployment: 'staging' }
  assert.equal(covered(task({ environment }), evidence({ environment })), true)
  assert.equal(covered(task({ environment }), evidence({ environment: { ...environment, runtime: 'node-22' } })), false)
  assert.equal(covered(task({ environment }), evidence({ environment: { ...environment, deployment: 'production' } })), false)
})

function reuseFixture() {
  const source = evidence({ id: 'source-ev', taskId: 'source-task', boardId: 'source-board', requirementId: 'source-ac' })
  const receipt = {
    id: 'reuse-1', source: { evidenceId: source.id, fingerprint: evidenceFingerprint(source),
      taskId: source.taskId, boardId: source.boardId, requirementId: source.requirementId },
    target: { taskId: 'target', boardId: 'main', requirementId: 'ac-1', ...binding },
    reason: 'Same verified object and contract', affectedFiles: ['src/verified.mjs'], expiresAt: 100,
  }
  return { source, receipt }
}

test('explicit reuse resolves unchanged source evidence and validates the complete target', () => {
  const { source, receipt } = reuseFixture()
  const registry = createEvidenceRegistry([source])
  const matrix = buildAcceptanceMatrix(task({ reuseReceipts: [receipt] }), registry, { now: 10 })
  assert.equal(matrix.covered, true)
  assert.equal(matrix.rows[0].evidence[0].reuseReceiptId, receipt.id)
  assert.equal(registry.records[source.id].taskId, 'source-task')
  assert.equal(buildAcceptanceMatrix(task(), registry).covered, false)
})

test('unchecked reuse flags, expired or altered receipts and stale sources cannot authorize reuse', () => {
  const { source, receipt } = reuseFixture()
  const check = (r, s = source, target = task()) => buildAcceptanceMatrix(
    { ...target, reuseReceipts: [r] }, createEvidenceRegistry([s]), { now: 10 }).covered
  for (const r of [
    { reusable: true }, { ...receipt, expiresAt: 10 }, { ...receipt, reason: '' },
    { ...receipt, affectedFiles: [] }, { ...receipt, source: { ...receipt.source, fingerprint: 'fake' } },
    { ...receipt, source: { ...receipt.source, evidenceId: 'missing' } },
    { ...receipt, source: { ...receipt.source, boardId: 'wrong' } },
  ]) assert.equal(check(r), false)
  for (const key of ['taskId', 'boardId', 'requirementId', ...Object.keys(binding)]) {
    assert.equal(check({ ...receipt, target: { ...receipt.target, [key]: 'changed' } }), false, key)
  }
  assert.equal(check(receipt, { ...source, status: 'stale' }), false)
  assert.equal(check(receipt, { ...source, command: 'different check' }), false)
  for (const key of Object.keys(binding)) {
    const changedSource = { ...source, [key]: 'old' }
    const renewedReceipt = { ...receipt, source: { ...receipt.source, fingerprint: evidenceFingerprint(changedSource) } }
    assert.equal(check(renewedReceipt, changedSource), false, 'source ' + key)
  }
  assert.equal(check(receipt, source, task({ contractRevision: 4 })), false)
  assert.equal(check(receipt, source, task({ recipeFingerprint: undefined })), false)
})

test('generated verification plans retain board and explicit contract/plan/source/environment binding', () => {
  const plan = buildVerificationPlan(task({ revision: 77 }), { now: 10 })
  assert.equal(plan.contractRevision, 3)
  assert.equal(plan.planRevision, 2)
  assert.equal(plan.boardId, 'main')
  const rows = plan.checks.map((check, i) => evidence({ id: 'check-' + i,
    requirementId: check.evidenceRequirement, recipeId: plan.recipeId, recipeFingerprint: plan.recipeFingerprint }))
  assert.equal(reuseEvidenceForPlan(plan, createEvidenceRegistry(rows)).complete, true)
  for (const change of [{ boardId: 'foreign' }, { treeHash: 'dirty-tree' }, { contractRevision: 4 },
    { recipeFingerprint: 'old-recipe' }, { environmentFingerprint: 'different-env' }]) {
    assert.equal(reuseEvidenceForPlan(plan, createEvidenceRegistry(rows.map((row) => ({ ...row, ...change })))).complete, false)
  }
  const unbound = { ...plan, commitSha: undefined, treeHash: undefined }
  assert.equal(reuseEvidenceForPlan(unbound, createEvidenceRegistry(rows)).complete, false)
  const manifestPlan = { ...unbound, manifestHash: 'current-manifest' }
  const manifestRows = rows.map((row) => ({ ...row, commitSha: undefined, treeHash: undefined, manifestHash: 'current-manifest' }))
  assert.equal(reuseEvidenceForPlan(manifestPlan, createEvidenceRegistry(manifestRows)).complete, true)
  assert.equal(reuseEvidenceForPlan(manifestPlan, createEvidenceRegistry(manifestRows.map((row) => ({ ...row, manifestHash: 'old' })))).complete, false)
})

test('default evidence ids and exact fingerprints cannot collapse colliding tasks or boards', () => {
  const a = evidence({ id: undefined })
  const b = evidence({ id: undefined, taskId: 'foreign' })
  const c = evidence({ id: undefined, boardId: 'other' })
  const registry = createEvidenceRegistry([a, b, c])
  assert.equal(Object.keys(registry.records).length, 3)
  assert.equal(queryEvidence(registry, { ...a, exact: true }).length, 1)
})

// ---------------------------------------------------------------------------
// C-04 / P2-04: the producer side of explicit reuse receipts, exercised through
// the real team_v12 tool and a real (temporary) control plane.
// ---------------------------------------------------------------------------

const reuseDirs = []
afterEach(() => {
  resetControlPlaneCache()
  for (const dir of reuseDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function reuseHarness({ name = 'root', tier = 0 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-reuse-receipt-'))
  reuseDirs.push(directory)
  const tools = new Map()
  const hooks = new Map()
  const member = { id: name, name, tier, role: tier === 0 ? 'lead' : 'teammate' }
  const agent = { id: name, name, session: { id: name + '-session', deriveMessages: () => [], deriveEventMessage: (event) => event }, status: 'idle' }
  agent.ctx = {
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
    tools: { register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) }, schemas: () => [] },
    on: (event, handler) => { hooks.set(event, handler); return () => {} },
  }
  const ctx = {
    get: () => undefined,
    requestMessageProjection: { register: () => () => {}, isAgentLoopRequest: () => false },
    agents: { list: () => [agent] },
    agentTeams: { tryMembership: () => ({ ...member, id: 'team-reuse' }), listMembers: () => [member] },
    on: () => () => {}, effect: () => {}, logger: { warn: () => {} },
    provide: () => () => {},
  }
  applyRuntime(ctx, { controlDir: directory, pluginDir: directory, profile: 'web' })
  const cp = controlPlaneForMember(ctx, agent, { directory })
  const tool = tools.get('team_v12')
  const exec = { name: 'team_v12', callId: 'reuse-call', rootCallId: 'reuse-call', arguments: {}, agent }
  return { directory, ctx, agent, cp, tool, exec, hooks,
    seed: (type, fn) => cp.mutate(type, {}, agent, fn),
    call: (action, input, extra = {}) => tool.execute({ action, ...(input === undefined ? {} : { input }), ...extra }, exec) }
}

const TEN = Array.from({ length: 10 }, (_, i) => ({ id: 'ac-' + (i + 1), text: 'criterion ' + (i + 1) + ' passes' }))
async function seedReuse(h, { source = evidence({ id: 'source-ev', taskId: 'source-task', boardId: 'source-board', requirementId: 'source-ac', command: 'node --test focused' }) } = {}) {
  await h.seed('test/reuse-seed', (state) => {
    state.boards = {
      main: { tasks: {
        target: { ...task(), board: 'main', ownerName: 'root', acceptanceCriteria: TEN },
        other: { ...task({ id: 'other' }), board: 'main', ownerName: 'root', acceptanceCriteria: TEN },
      } },
      'source-board': { tasks: { 'source-task': { id: 'source-task', board: 'source-board', ownerName: 'root' } } },
    }
    state.evidence = { [source.id]: source }
  })
  await h.cp.flush()
  return source
}
const receiptFor = (source, overrides = {}) => ({
  source: { evidenceId: source.id, fingerprint: evidenceFingerprint(source), taskId: source.taskId,
    boardId: source.boardId, requirementId: source.requirementId },
  target: { taskId: 'target', boardId: 'main', requirementId: 'ac-4', ...binding },
  reason: 'Same verified object, contract and environment', affectedFiles: ['src/verified.mjs'],
  expiresAt: Date.now() + 3_600_000, ...overrides,
})
const matrixOf = (pack, taskId = 'target') => pack.matrices.find((m) => m.taskId === taskId)
const rejectedFor = (pack, receiptId) => (pack.reuse?.rejected ?? []).filter((row) => row.receiptId === receiptId)
const rowOf = (pack, requirementId, taskId = 'target') => matrixOf(pack, taskId).rows.find((row) => row.requirementId === requirementId)

test('reuse_receipt_put persists a lawful receipt and review_package covers only its target requirement', async () => {
  const h = reuseHarness()
  const source = await seedReuse(h)
  const before = await h.call('review_package')
  assert.equal(matrixOf(before).covered, false)
  assert.equal(matrixOf(before).uncovered.length, 10)

  const put = await h.call('reuse_receipt_put', receiptFor(source))
  assert.equal(put.ok, true)
  assert.match(put.receiptId, /^reuse-/)

  const pack = await h.call('review_package')
  const matrix = matrixOf(pack)
  assert.equal(rowOf(pack, 'ac-4').covered, true)
  assert.equal(rowOf(pack, 'ac-4').evidence[0].reuseReceiptId, put.receiptId)
  assert.deepEqual(matrix.uncovered, TEN.map((row) => row.id).filter((id) => id !== 'ac-4'))
  assert.equal(matrix.covered, false)
  assert.equal(pack.complete, false)
  // The sibling task with identical criteria receives nothing from the receipt.
  assert.equal(matrixOf(pack, 'other').uncovered.length, 10)
  assert.equal(pack.reuse.applied.length, 1)
  assert.equal(pack.reuse.applied[0].receiptId, put.receiptId)

  // Durable and tamper-evident: survives a control-plane reload.
  await h.cp.flush()
  resetControlPlaneCache()
  const reloaded = controlPlaneForMember(h.ctx, h.agent, { directory: h.directory }).view({ history: false })
  const stored = reloaded.v12EvidenceReuse.receipts[put.receiptId]
  assert.equal(stored.source.evidenceId, 'source-ev')
  assert.equal(typeof stored.digest, 'string')
})

test('reuse hits are counted once per distinct authorization and name the reused evidence', async () => {
  const h = reuseHarness()
  const source = await seedReuse(h)
  const { receiptId } = await h.call('reuse_receipt_put', receiptFor(source))
  assert.equal((await h.call('reuse_receipt_status')).totals.hits, 0)
  await h.call('review_package')
  await h.call('review_package')
  const status = await h.call('reuse_receipt_status')
  assert.equal(status.totals.hits, 1)
  assert.equal(status.hits[receiptId].count, 1)
  assert.equal(status.hits[receiptId].evidenceId, 'source-ev')
  assert.equal(status.receipts.find((row) => row.id === receiptId).hits, 1)
})

test('stored receipts stop covering after tree change, expiry, tampering or requirement change, with readable reasons', async () => {
  const mutateAndReview = async (mutate, { ttl = 3_600_000, wait = 0 } = {}) => {
    const h = reuseHarness()
    const source = await seedReuse(h)
    const { receiptId } = await h.call('reuse_receipt_put', receiptFor(source, { expiresAt: Date.now() + ttl }))
    assert.equal(rowOf(await h.call('review_package'), 'ac-4').covered, true)
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    await h.seed('test/reuse-mutate', (state) => mutate(state, receiptId))
    await h.cp.flush()
    return { pack: await h.call('review_package'), receiptId }
  }

  let r = await mutateAndReview((state) => { state.boards.main.tasks.target.treeHash = 'new-tree' })
  assert.equal(rowOf(r.pack, 'ac-4').covered, false)
  assert.equal(rejectedFor(r.pack, r.receiptId)[0].code, 'reuse-binding-mismatch')
  assert.match(rejectedFor(r.pack, r.receiptId)[0].reason, /treeHash/)
  assert.equal(rowOf(r.pack, 'ac-4').rejectedReuse[0].code, 'reuse-binding-mismatch')
  assert.equal(r.pack.reuse.applied.length, 0)

  r = await mutateAndReview(() => {}, { ttl: 1200, wait: 1300 })
  assert.equal(rowOf(r.pack, 'ac-4').covered, false)
  assert.equal(rejectedFor(r.pack, r.receiptId)[0].code, 'reuse-receipt-expired')
  assert.match(rejectedFor(r.pack, r.receiptId)[0].reason, /expired/)

  for (const tamper of [
    (row) => { row.expiresAt += 86_400_000 },
    (row) => { row.reason = 'edited after the fact' },
    (row) => { row.affectedFiles = ['src/other.mjs'] },
    (row) => { row.target.requirementId = 'ac-5' },
  ]) {
    r = await mutateAndReview((state, id) => tamper(state.v12EvidenceReuse.receipts[id]))
    assert.equal(rowOf(r.pack, 'ac-4').covered, false)
    assert.equal(rejectedFor(r.pack, r.receiptId)[0].code, 'reuse-receipt-tampered')
    assert.match(rejectedFor(r.pack, r.receiptId)[0].reason, /digest/)
    assert.equal(rowOf(r.pack, 'ac-5').covered, false)
  }

  r = await mutateAndReview((state) => { state.evidence['source-ev'].status = 'stale' })
  assert.equal(rowOf(r.pack, 'ac-4').covered, false)
  assert.equal(rejectedFor(r.pack, r.receiptId)[0].code, 'reuse-source-not-passed')

  r = await mutateAndReview((state) => { state.evidence['source-ev'].command = 'a different check' })
  assert.equal(rowOf(r.pack, 'ac-4').covered, false)
  assert.equal(rejectedFor(r.pack, r.receiptId)[0].code, 'reuse-source-fingerprint-mismatch')

  // The requirement the receipt was aimed at no longer exists on the task.
  r = await mutateAndReview((state) => {
    state.boards.main.tasks.target.acceptanceCriteria = TEN.map((row) => row.id === 'ac-4' ? { id: 'ac-4b', text: 'reworded' } : row)
  })
  assert.equal(rowOf(r.pack, 'ac-4b').covered, false)
  assert.equal(rejectedFor(r.pack, r.receiptId)[0].code, 'reuse-target-requirement-unknown')
  assert.match(rejectedFor(r.pack, r.receiptId)[0].reason, /ac-4/)
})

test('forged or incomplete receipts are refused before persistence with stable business codes', async () => {
  const h = reuseHarness()
  const source = await seedReuse(h)
  const good = receiptFor(source)
  const without = (path) => {
    const copy = JSON.parse(JSON.stringify(good))
    const keys = path.split('.')
    const last = keys.pop()
    delete keys.reduce((node, key) => node[key], copy)[last]
    return copy
  }
  const cases = [
    ['reuse-receipt-incomplete', { reusable: true }],
    ['reuse-receipt-incomplete', without('reason')],
    ['reuse-receipt-incomplete', { ...good, affectedFiles: [] }],
    ['reuse-receipt-incomplete', { ...good, affectedFiles: ['src/a.mjs', ''] }],
    ['reuse-receipt-incomplete', without('source.fingerprint')],
    ['reuse-receipt-incomplete', without('target.requirementId')],
    ['reuse-receipt-incomplete', { ...good, expiresAt: 'tomorrow' }],
    ['reuse-receipt-expired', { ...good, expiresAt: Date.now() - 1 }],
    ['reuse-source-fingerprint-mismatch', { ...good, source: { ...good.source, fingerprint: 'fake' } }],
    ['reuse-source-not-found', { ...good, source: { ...good.source, evidenceId: 'missing' } }],
    ['reuse-source-binding-mismatch', { ...good, source: { ...good.source, boardId: 'wrong' } }],
    ['reuse-target-requirement-unknown', { ...good, target: { ...good.target, requirementId: 'ac-99' } }],
    ['reuse-binding-mismatch', { ...good, target: { ...good.target, treeHash: 'other-tree' } }],
    ['reuse-binding-mismatch', { ...good, target: { ...good.target, environmentFingerprint: 'other-env' } }],
    ['task-not-found', { ...good, target: { ...good.target, taskId: 'ghost' } }],
  ]
  for (const [code, input] of cases) {
    await assert.rejects(h.call('reuse_receipt_put', input), { code }, code + ' ' + JSON.stringify(input).slice(0, 80))
  }
  await h.seed('test/reuse-stale-source', (state) => { state.evidence['source-ev'].status = 'stale' })
  await assert.rejects(h.call('reuse_receipt_put', good), { code: 'reuse-source-not-passed' })
  await h.seed('test/reuse-fresh-source', (state) => { state.evidence['source-ev'].status = 'passed' })

  // Nothing was persisted by any refused attempt, and coverage is unchanged.
  const status = await h.call('reuse_receipt_status')
  assert.deepEqual(status.receipts, [])
  assert.equal(matrixOf(await h.call('review_package')).uncovered.length, 10)

  // Identical re-put is idempotent; the same id with different content is a conflict.
  const first = await h.call('reuse_receipt_put', { ...good, id: 'reuse-fixed' })
  const replay = await h.call('reuse_receipt_put', { ...good, id: 'reuse-fixed' })
  assert.equal(replay.receiptId, first.receiptId)
  assert.equal(replay.replayed, true)
  await assert.rejects(h.call('reuse_receipt_put', { ...good, id: 'reuse-fixed', reason: 'different' }), { code: 'reuse-receipt-conflict' })
  assert.equal((await h.call('reuse_receipt_status')).receipts.length, 1)
})

test('only a lead or tier 0 may record a receipt', async () => {
  const member = reuseHarness({ name: 'alice', tier: 2 })
  const source = await seedReuse(member)
  await assert.rejects(member.call('reuse_receipt_put', receiptFor(source)), { code: 'lead-or-tier-0-only' })
  assert.deepEqual((await member.call('reuse_receipt_status')).receipts, [])
})

test('verification_plan consults persisted receipts and reuses exactly one check of the plan', async () => {
  const h = reuseHarness()
  await seedReuse(h)
  const planned = await h.call('verification_plan', {}, { task_id: 'target' })
  const plan = planned.plan
  assert.ok(plan.checks.length >= 3)
  const check = plan.checks[1]
  const planBinding = { ...binding, recipeId: plan.recipeId, recipeFingerprint: plan.recipeFingerprint }
  const planSource = evidence({ id: 'plan-source', taskId: 'source-task', boardId: 'source-board', requirementId: 'unit-run',
    ...planBinding, command: 'node --test focused' })
  await h.seed('test/reuse-plan-source', (state) => { state.evidence['plan-source'] = planSource })
  await h.cp.flush()
  assert.equal(planned.reuse.complete, false)
  const put = await h.call('reuse_receipt_put', receiptFor(planSource, {
    target: { taskId: 'target', boardId: 'main', requirementId: check.evidenceRequirement, ...planBinding },
  }))
  const after = await h.call('verification_plan', {}, { task_id: 'target' })
  const reused = after.reuse.checks.filter((row) => row.reusable)
  assert.deepEqual(reused.map((row) => row.requirementId), [check.requirementId])
  assert.equal(reused[0].evidence[0].reuseReceiptId, put.receiptId)
  assert.equal(after.reuse.missing.length, plan.checks.length - 1)
  assert.equal(after.reuse.complete, false)
  assert.equal((await h.call('reuse_receipt_status')).hits[put.receiptId].count, 1)
})

// ---- C-04 on production-shaped data: v15 server proofs as reuse sources ----
// Real tasks and team_evidence_record rows carry no tree/plan/recipe/environment
// binding; only the v15 domain does. These cases use that shape on purpose.
const V15 = { manifestHash: 'a'.repeat(64), environmentFingerprint: 'e'.repeat(64), recipeFingerprint: 'recipe-file-v1',
  planId: 'p1', planRevision: 2, planHash: 'plan-hash-1' }
const v15Proof = (overrides = {}) => ({
  planId: V15.planId, planRevision: V15.planRevision, planHash: V15.planHash, requirementId: 'r-src',
  scope: { kind: 'workspace' }, sourceIdentity: { manifestHash: V15.manifestHash },
  environmentFingerprint: V15.environmentFingerprint, recipeFingerprint: V15.recipeFingerprint,
  boardId: 'main', taskId: 'src', taskRevision: 1, contractRevision: 3,
  id: 'proof-src-test', kind: 'test', status: 'passed', artifactHash: 'quality-hash',
  provenance: { kind: 'server-tool-runtime-quality-oracle', callId: 'execution-proof-1' },
  verificationScope: 'declared-server-recipe-exact-quality-checks', ...overrides,
})
async function seedV15(h, { proof = v15Proof(), mutate = () => {} } = {}) {
  await h.seed('test/reuse-v15-seed', (state) => {
    state.boards = { main: { tasks: {
      target: { id: 'target', board: 'main', ownerName: 'root', revision: 1, acceptanceCriteria: TEN, contract: { contractRevision: 3 } },
      src: { id: 'src', board: 'main', ownerName: 'root', revision: 1, contract: { contractRevision: 3 } },
    } } }
    state.evidence = {}
    state.v15PlanDelivery = { version: 1, receipts: {}, outbox: {}, plans: { p1: { planId: V15.planId, planRevision: V15.planRevision,
      planHash: V15.planHash, scope: { kind: 'workspace' }, items: [
        { requirementId: 'r-src', taskRefs: [{ boardId: 'main', taskId: 'src' }], testEvidenceRefs: [proof.id], acceptanceEvidenceRefs: [] },
        { requirementId: 'r-target', taskRefs: [{ boardId: 'main', taskId: 'target' }] },
      ] } } }
    state.v15DeliveryContext = { revision: 1, sourceIdentity: { manifestHash: V15.manifestHash }, scope: { kind: 'workspace' },
      environmentFingerprint: V15.environmentFingerprint, recipeFingerprint: V15.recipeFingerprint, unresolvedDebt: [], blockers: [] }
    state.v12Evidence = { version: 1, revision: 1, records: { [proof.id]: proof } }
    mutate(state)
  })
  await h.cp.flush()
  return proof
}
const v15Receipt = (proof, overrides = {}) => ({
  source: { evidenceId: proof.id, fingerprint: evidenceFingerprint(proof), taskId: proof.taskId, boardId: proof.boardId, requirementId: proof.requirementId },
  target: { taskId: 'target', boardId: 'main', requirementId: 'ac-4', manifestHash: V15.manifestHash, contractRevision: 3,
    planRevision: V15.planRevision, recipeFingerprint: V15.recipeFingerprint, environmentFingerprint: V15.environmentFingerprint },
  reason: 'Same manifest, plan, recipe and environment as the server proof', affectedFiles: ['src/verified.mjs'],
  expiresAt: Date.now() + 3_600_000, ...overrides,
})

test('a v15 server proof is a lawful reuse source for a task that carries no binding of its own', async () => {
  const h = reuseHarness()
  const proof = await seedV15(h)
  // The proof belongs to another task and requirement: without a receipt it covers nothing here.
  assert.equal(matrixOf(await h.call('review_package')).uncovered.length, 10)
  const put = await h.call('reuse_receipt_put', v15Receipt(proof))
  const pack = await h.call('review_package')
  assert.equal(rowOf(pack, 'ac-4').covered, true)
  assert.equal(rowOf(pack, 'ac-4').evidence[0].id, 'proof-src-test')
  assert.equal(rowOf(pack, 'ac-4').evidence[0].reuseReceiptId, put.receiptId)
  assert.deepEqual(matrixOf(pack).uncovered, TEN.map((row) => row.id).filter((id) => id !== 'ac-4'))
  assert.equal(pack.complete, false)
  assert.equal((await h.call('reuse_receipt_status')).hits[put.receiptId].count, 1)
})

test('v15 reuse stops when the current source, plan or proof no longer matches, and never accepts weaker proofs', async () => {
  const afterChange = async (mutate) => {
    const h = reuseHarness()
    const proof = await seedV15(h)
    const { receiptId } = await h.call('reuse_receipt_put', v15Receipt(proof))
    assert.equal(rowOf(await h.call('review_package'), 'ac-4').covered, true)
    await h.seed('test/reuse-v15-mutate', mutate)
    await h.cp.flush()
    const pack = await h.call('review_package')
    assert.equal(rowOf(pack, 'ac-4').covered, false)
    return rejectedFor(pack, receiptId)[0]
  }
  let rejected = await afterChange((state) => { state.v15DeliveryContext = { ...state.v15DeliveryContext, revision: 2, sourceIdentity: { manifestHash: 'b'.repeat(64) } } })
  assert.equal(rejected.code, 'reuse-binding-mismatch')
  assert.match(rejected.reason, /manifestHash/)
  rejected = await afterChange((state) => { state.v15DeliveryContext = { ...state.v15DeliveryContext, revision: 2, environmentFingerprint: 'f'.repeat(64) } })
  assert.equal(rejected.code, 'reuse-binding-mismatch')
  assert.match(rejected.reason, /environmentFingerprint/)
  // Once the registered plan's hash moves, the plan no longer names this proof: it stops being a source at all.
  rejected = await afterChange((state) => { state.v15PlanDelivery.plans.p1 = { ...state.v15PlanDelivery.plans.p1, planHash: 'plan-hash-2' } })
  assert.equal(rejected.code, 'reuse-source-not-found')
  rejected = await afterChange((state) => { state.v15PlanDelivery.plans.p1 = { ...state.v15PlanDelivery.plans.p1, planRevision: 3 } })
  assert.equal(rejected.code, 'reuse-binding-mismatch')
  assert.match(rejected.reason, /planRevision/)
  rejected = await afterChange((state) => { state.v12Evidence = { ...state.v12Evidence, records: { 'proof-src-test': { ...v15Proof(), status: 'invalidated', staleReasons: ['EXECUTION_COMMIT_FAILED'] } } } })
  assert.equal(rejected.code, 'reuse-source-not-passed')
  // The proof is judged against its own task: once that task or its contract moves on, the proof is stale.
  rejected = await afterChange((state) => { state.boards.main.tasks.src = { ...state.boards.main.tasks.src, contract: { contractRevision: 4 } } })
  assert.equal(rejected.code, 'reuse-source-stale')
  assert.match(rejected.reason, /contract revision is 4/)
  rejected = await afterChange((state) => { state.boards.main.tasks.src = { ...state.boards.main.tasks.src, revision: 2 } })
  assert.equal(rejected.code, 'reuse-source-stale')
  // A fingerprint the target task declares for itself cannot vouch for a server environment that has moved.
  rejected = await afterChange((state) => {
    state.boards.main.tasks.target = { ...state.boards.main.tasks.target, environmentFingerprint: V15.environmentFingerprint }
    state.v15DeliveryContext = { ...state.v15DeliveryContext, revision: 2, environmentFingerprint: 'f'.repeat(64) }
  })
  assert.equal(rejected.code, 'reuse-binding-mismatch')
  assert.match(rejected.reason, /environmentFingerprint/)
  rejected = await afterChange((state) => { delete state.v15DeliveryContext })
  assert.equal(rejected.code, 'reuse-binding-incomplete')

  // Not a server test/acceptance proof: never a source, whatever its binding says.
  for (const weak of [v15Proof({ kind: 'implementation' }), v15Proof({ provenance: { kind: 'caller-claimed' } }), v15Proof({ planHash: '' })]) {
    const h = reuseHarness()
    await seedV15(h, { proof: weak })
    await assert.rejects(h.call('reuse_receipt_put', v15Receipt(weak)), { code: 'reuse-source-not-found' })
  }
  // Row fields alone are not proof: the registered plan must name the id in the slot of its kind.
  const unanchored = reuseHarness()
  const loose = await seedV15(unanchored, { mutate: (state) => { state.v15PlanDelivery.plans.p1.items[0].testEvidenceRefs = [] } })
  await assert.rejects(unanchored.call('reuse_receipt_put', v15Receipt(loose)), { code: 'reuse-source-not-found' })
  // A proof bound to a different registered plan than the target's.
  const h = reuseHarness()
  const foreign = v15Proof({ planId: 'p2', planHash: 'other-plan-hash' })
  await seedV15(h, { proof: foreign, mutate: (state) => { state.v15PlanDelivery.plans.p2 = { planId: 'p2', planRevision: V15.planRevision, planHash: 'other-plan-hash',
    scope: { kind: 'workspace' }, items: [{ requirementId: 'r-src', taskRefs: [{ boardId: 'main', taskId: 'src' }], testEvidenceRefs: [foreign.id] }] } } })
  await assert.rejects(h.call('reuse_receipt_put', v15Receipt(foreign)), { code: 'reuse-binding-mismatch' })
  // A task that two registered plans reference has no single current plan revision.
  const two = reuseHarness()
  const proof = await seedV15(two, { mutate: (state) => { state.v15PlanDelivery.plans.p2 = { ...state.v15PlanDelivery.plans.p1, planId: 'p2', planHash: 'other-plan-hash' } } })
  await assert.rejects(two.call('reuse_receipt_put', v15Receipt(proof)), { code: 'reuse-binding-incomplete' })
})

test('recording legacy evidence keeps v15 proofs and the registry revision in v12Evidence', async () => {
  const h = reuseHarness()
  const proof = await seedV15(h)
  const post = h.hooks.get('tools/post-execute')
  assert.equal(typeof post, 'function')
  const value = { evidenceId: 'ev-legacy-1', taskId: 'target', requirementId: 'ac-1', kind: 'command', status: 'recorded', commitSha: 'abc' }
  await h.seed('test/legacy-evidence', (state) => { state.evidence = { 'ev-legacy-1': { ...value, id: 'ev-legacy-1' } } })
  await post({ name: 'team_evidence_record', arguments: { task_id: 'target', kind: 'command' }, callId: 'record-1', rootCallId: 'record-1', agent: h.agent },
    { value, content: [] }, async () => ({ kind: 'accept' }))
  await h.cp.flush()
  resetControlPlaneCache()
  const disk = controlPlaneForMember(h.ctx, h.agent, { directory: h.directory }).view({ history: false }).v12Evidence
  assert.deepEqual(disk.records['proof-src-test'], proof)
  assert.equal(disk.records['ev-legacy-1'].status, 'passed')
  assert.equal(disk.revision, 2)
  // A legacy row may not take over a slot a server proof already holds.
  await post({ name: 'team_evidence_record', arguments: { kind: 'command' }, callId: 'record-2', rootCallId: 'record-2', agent: h.agent },
    { value: { ...value, evidenceId: 'proof-src-test' }, content: [] }, async () => ({ kind: 'accept' }))
  await h.cp.flush()
  resetControlPlaneCache()
  const again = controlPlaneForMember(h.ctx, h.agent, { directory: h.directory }).view({ history: false }).v12Evidence
  assert.deepEqual(again.records['proof-src-test'], proof)
})

test('a v15 proof is reusable across tasks whose own contract revisions differ', async () => {
  const h = reuseHarness()
  const proof = await seedV15(h, { mutate: (state) => { state.boards.main.tasks.target = { ...state.boards.main.tasks.target, contract: { contractRevision: 7 } } } })
  // The receipt states the target's contract revision; the proof keeps the revision of the task it was taken for.
  await assert.rejects(h.call('reuse_receipt_put', v15Receipt(proof)), { code: 'reuse-binding-mismatch' })
  const put = await h.call('reuse_receipt_put', v15Receipt(proof, { target: { ...v15Receipt(proof).target, contractRevision: 7 } }))
  const pack = await h.call('review_package')
  assert.equal(rowOf(pack, 'ac-4').covered, true)
  assert.equal(rowOf(pack, 'ac-4').evidence[0].reuseReceiptId, put.receiptId)
})
