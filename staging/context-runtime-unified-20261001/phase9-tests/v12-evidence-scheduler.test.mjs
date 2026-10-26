import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAcceptanceMatrix,
  buildReadyQueue,
  buildReviewPackage,
  buildSchedulerAdvice,
  buildVerificationPlan,
  checkFanOut,
  classifyStall,
  computeTaskCost,
  costGuard,
  createEvidenceRegistry,
  estimateTaskEffort,
  invalidateEvidence,
  queryEvidence,
  reuseEvidenceForPlan,
  registerEvidence,
  selectVerificationRecipe,
} from '../home/profiles/web/plugins/team-v12-evidence-scheduler.mjs'

const task = (id, overrides = {}) => ({
  id,
  status: 'pending',
  lifecycle: 'ready',
  ownerName: 'lead-a',
  kind: 'edit',
  writeScopes: ['src/a'],
  acceptanceCriteria: [{ id: 'ac-1', text: 'build passes' }],
  ...overrides,
})
const coverageBinding = { commitSha: 'abc', treeHash: 'tree', contractRevision: 1, planRevision: 1,
  recipeFingerprint: 'recipe', environmentFingerprint: 'environment' }

test('evidence registry reuses exact matches and invalidates stale records', () => {
  const registry = createEvidenceRegistry()
  const base = {
    taskId: 't1',
    requirementId: 'ac-1',
    commitSha: 'abc',
    treeHash: 'tree1',
    command: 'npm test',
    profile: 'web',
    status: 'passed',
    evidenceRef: 'log://1',
  }
  registerEvidence(registry, base)
  assert.equal(queryEvidence(registry, { ...base, exact: true }).length, 1)
  const changed = invalidateEvidence(registry, { taskId: 't1', commitSha: 'def' })
  assert.equal(changed.length, 1)
  assert.equal(changed[0].status, 'stale')
  assert.deepEqual(changed[0].staleReasons, ['commit-changed'])
})

test('acceptance matrix refuses completion without mapped evidence', () => {
  const registry = createEvidenceRegistry()
  const matrix = buildAcceptanceMatrix(task('t1'), registry)
  assert.equal(matrix.covered, false)
  assert.deepEqual(matrix.uncovered, ['ac-1'])
  registerEvidence(registry, {
    ...coverageBinding,
    taskId: 't1',
    requirementId: 'ac-1',
    commitSha: 'abc',
    command: 'npm test',
    profile: 'web',
    status: 'passed',
  })
  assert.equal(buildAcceptanceMatrix(task('t1', { commitSha: 'abc' }), registry).covered, false)
  assert.equal(buildAcceptanceMatrix(task('t1', coverageBinding), registry).covered, true)
})

test('review package refuses shared evidence without an explicit reuse receipt', () => {
  const registry = createEvidenceRegistry([{
    ...coverageBinding,
    id: 'ev-shared',
    taskId: 't1',
    requirementId: 'ac-1',
    commitSha: 'abc',
    command: 'test',
    profile: 'web',
    status: 'passed',
  }])
  const second = task('t2', {
    ...coverageBinding,
    acceptanceCriteria: [{ id: 'ac-1', text: 'build passes' }],
  })
  const pack = buildReviewPackage([task('t1', coverageBinding), second], registry)
  assert.equal(pack.evidence.length, 1)
  assert.deepEqual(pack.evidence[0].tasks.sort(), ['t1'])
  assert.equal(pack.complete, false)
  assert.equal(pack.matrices[1].covered, false)
  assert.deepEqual(pack.blockers, [{ taskId: 't2', requirementId: 'ac-1' }])
})

test('ready queue is derived and rejects unmet dependencies and conflicts', () => {
  const queue = buildReadyQueue([
    task('t1'),
    task('t2', { blockedBy: ['t1'], writeScopes: ['src/a/file.js'] }),
    task('t3', { writeScopes: ['src/b'] }),
  ], [{ name: 'lead-a', tier: 1 }], [], { now: 10 })
  assert.equal(queue.ready.some((row) => row.id === 't1'), true)
  assert.equal(queue.ready.some((row) => row.id === 't2'), false)
  assert.ok(queue.blocked.find((row) => row.id === 't2').reasons.includes('dependencies-unmet'))
  assert.equal(queue.ready.some((row) => row.id === 't3'), true)
})

test('stall classification separates waiting from actionable blocks', () => {
  assert.equal(classifyStall({ dependencyState: 'waiting' }).class, 'waiting-dependency')
  assert.equal(classifyStall({ permissionBlocked: true }).escalate, true)
  assert.equal(classifyStall({ repeatedFailures: 3 }).class, 'repeated-failure')
  assert.equal(classifyStall({ state: 'running', lastProgressAt: 0, now: 1000 }).class, 'working')
})

test('cost guard alerts only when spend grows without new evidence', () => {
  const rows = Array.from({ length: 30 }, () => ({ inputTokens: 1000, outputTokens: 100 }))
  assert.equal(costGuard({ events: rows, progressCount: 0, threshold: 1 }).alert, true)
  assert.equal(costGuard({ events: rows, progressCount: 1, threshold: 1 }).alert, false)
  assert.equal(computeTaskCost(rows).inputTokens, 30000)
})

test('verification recipes bind checks to task revision and exact evidence', () => {
  const apiTask = task('api-task', {
    ...coverageBinding,
    subject: 'API lifecycle transition',
    revision: 4,
    acceptanceCriteria: [{ id: 'ac-1', text: 'invalid transition is refused' }],
  })
  const recipe = selectVerificationRecipe(apiTask)
  assert.equal(recipe.id, 'api-state-machine')
  const plan = buildVerificationPlan(apiTask, { recipe, now: 10 })
  assert.equal(plan.recipeFingerprint.length, 64)
  assert.equal(plan.checks.some((check) => check.requirementId === 'illegal-transition'), true)

  const registry = createEvidenceRegistry()
  for (const check of plan.checks) {
    registerEvidence(registry, {
      ...coverageBinding,
      taskId: apiTask.id,
      requirementId: check.evidenceRequirement,
      recipeId: plan.recipeId,
      recipeFingerprint: plan.recipeFingerprint,
      commitSha: 'abc',
      treeHash: 'tree',
      command: 'test ' + check.requirementId,
      profile: 'web',
      status: 'passed',
    })
  }
  const reuse = reuseEvidenceForPlan(plan, registry, { commitSha: 'abc', treeHash: 'tree' })
  assert.equal(reuse.complete, true)
  assert.equal(reuse.checks.every((check) => check.reusable), true)

  const changed = reuseEvidenceForPlan(plan, registry, { commitSha: 'def', treeHash: 'tree' })
  assert.equal(changed.complete, false)
})

test('fan-out advice requires independent deliverables and exposes unknown history honestly', () => {
  const parent = task('parent', {
    subject: 'split independent API and UI work',
    children: [
      { id: 'api', owner: 'lead-a', deliverable: 'API', acceptanceCriteria: ['api passes'], writeScopes: ['src/api'] },
      { id: 'ui', owner: 'lead-b', deliverable: 'UI', acceptanceCriteria: ['ui renders'], writeScopes: ['src/ui'] },
    ],
  })
  const fanOut = checkFanOut(parent)
  assert.equal(fanOut.recommend, true)
  assert.equal(fanOut.baseEffort.confidence, 'unknown')
  assert.equal(fanOut.parts.length, 2)

  const conflicting = checkFanOut(task('conflict', {
    children: [
      { id: 'a', owner: 'a', deliverable: 'A', acceptanceCriteria: ['a'], writeScopes: ['src/shared'] },
      { id: 'b', owner: 'b', deliverable: 'B', acceptanceCriteria: ['b'], writeScopes: ['src/shared/file.js'] },
    ],
  }))
  assert.equal(conflicting.recommend, false)
  assert.ok(conflicting.reasons.some((reason) => reason.startsWith('child-scope-conflict:')))
})

test('scheduler advice is shadow-only by default and stabilizes concurrency changes', () => {
  const rows = [
    task('t1'),
    task('t2', { writeScopes: ['src/b'] }),
    task('t3', { writeScopes: ['src/c'] }),
  ]
  const members = [
    { name: 'lead-a', tier: 1, status: 'idle' },
    { name: 'lead-b', tier: 1, status: 'idle' },
  ]
  const advice = buildSchedulerAdvice(rows, members, [], {
    now: 1000,
    currentConcurrency: 1,
    maxConcurrency: 4,
    cooldownMs: 0,
    history: [{ id: 'h1', kind: 'edit', durationMs: 1000 }],
  })
  assert.equal(advice.mode, 'shadow')
  assert.equal(advice.applyAllowed, false)
  assert.equal(advice.targetConcurrency > advice.currentConcurrency, true)
  assert.equal(advice.criticalPath.every((row) => row.estimateMs === null), false)
  assert.equal(estimateTaskEffort({ kind: 'edit' }, []).confidence, 'unknown')
})
