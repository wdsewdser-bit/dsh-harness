import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createReadyQueueContext,
  evaluateReadyTask,
  projectLeasesForMember,
} from '../home/profiles/web/plugins/team-v12-evidence-scheduler.mjs'
import {
  deriveWaitingTickets,
} from '../home/profiles/web/plugins/team-v14-waiting.mjs'
import {
  handleInboxMessage,
  recordDeliveredInboxMessage,
} from '../home/profiles/web/plugins/team-v12-room-wake.mjs'
import {
  planScopeConflictVerdict,
  taskEditWriteScopeVerdict,
} from '../home/profiles/web/plugins/team-tools-v2-r10.mjs'

const task = (overrides = {}) => ({
  id: 'task-a',
  status: 'pending',
  lifecycle: 'approved',
  ownerName: 'member-a',
  writeScopes: [],
  contract: {
    kind: 'discussion',
    owner: 'member-a',
    acceptanceCriteria: ['done'],
  },
  ...overrides,
})

test('D-new-8: an explicit null ownerName is not revived from a stale contract owner', () => {
  const row = task({
    ownerName: null,
    contract: {
      kind: 'discussion',
      owner: 'stale-owner',
      acceptanceCriteria: ['done'],
    },
  })
  const context = createReadyQueueContext(
    [row],
    [{ name: 'stale-owner', status: 'active' }],
    [],
    { now: 1000 },
  )
  const ready = evaluateReadyTask(row, context)
  assert.equal(ready.owner, '')
  assert.ok(ready.reasons.includes('no-owner'))

  const derived = deriveWaitingTickets(
    { boards: { global: { tasks: { [row.id]: row } } } },
    [{ name: 'stale-owner', status: 'active' }],
    1000,
  )
  assert.equal(derived.some((entry) => entry.taskId === row.id), false)

  const legacy = task({
    id: 'legacy',
    ownerName: undefined,
    contract: {
      kind: 'discussion',
      owner: 'legacy-owner',
      acceptanceCriteria: ['done'],
    },
  })
  const legacyContext = createReadyQueueContext(
    [legacy],
    [{ name: 'legacy-owner', status: 'active' }],
    [],
    { now: 1000 },
  )
  assert.equal(evaluateReadyTask(legacy, legacyContext).owner, 'legacy-owner')
})

test('D-new-9: ready rows name whether a lease belongs to the task or the member', () => {
  const leases = [{
    member: 'member-a',
    taskId: 'task-other',
    status: 'active',
    expiresAt: 5000,
  }]
  const rows = [
    task({ id: 'task-a', ownerName: 'member-a', status: 'in_progress', lifecycle: 'running' }),
    task({ id: 'task-b', ownerName: 'member-a', status: 'in_progress', lifecycle: 'running' }),
  ]
  const context = createReadyQueueContext(rows, [{ name: 'member-a', status: 'active' }], leases, { now: 1000 })
  for (const row of rows) {
    const ready = evaluateReadyTask(row, context)
    assert.equal(ready.leaseScope, 'member')
    assert.equal(ready.leaseActive, true)
    assert.equal(ready.leaseExpiresAt, 5000)
    assert.equal(ready.memberLeaseActive, true)
    assert.equal(ready.memberLeaseExpiresAt, 5000)
    assert.equal(ready.taskLeaseActive, false)
  }

  const taskLeaseContext = createReadyQueueContext(
    rows,
    [{ name: 'member-a', status: 'active' }],
    [{ member: 'member-a', taskId: 'task-a', status: 'active', expiresAt: 6000 }],
    { now: 1000 },
  )
  const taskLease = evaluateReadyTask(rows[0], taskLeaseContext)
  assert.equal(taskLease.leaseScope, 'task')
  assert.equal(taskLease.taskLeaseExpiresAt, 6000)
  assert.equal(taskLease.memberLeaseActive, false)
})

test('D-new-10: a committed native team message becomes an ackable inbox row', () => {
  const state = {}
  const recorded = recordDeliveredInboxMessage(state, {
    messageId: 'msg-batch-1',
    target: 'member-a',
    injectionReceipt: 'receipt-1',
    at: 1000,
  })
  assert.equal(recorded.ok, true)
  assert.equal(state.inbox['msg-batch-1'].status, 'injected')

  const handled = handleInboxMessage(state, 'msg-batch-1')
  assert.equal(handled.ok, true)
  assert.equal(handled.handled, true)
  assert.equal(state.inbox['msg-batch-1'].status, 'handled')
})

test('D-new-11: no-plan scope refusal points at plan creation instead of plan replacement', () => {
  const verdict = taskEditWriteScopeVerdict({
    action: 'edit',
    write_scopes: ['tests/file.md'],
    description: 'also update this',
  }, { planExists: false })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /No plan exists yet/)
  assert.match(verdict.reason, /team_plan_propose/)
  assert.doesNotMatch(verdict.reason, /replace the approved plan/i)
  assert.deepEqual(verdict.unappliedFields, ['description'])

  const withPlan = taskEditWriteScopeVerdict({
    action: 'edit',
    write_scopes: ['tests/file.md'],
  }, { planExists: true })
  assert.match(withPlan.reason, /replace the plan/i)
})

test('D-new-12: narrowing a directory scope to a contained file bypasses the stale self-conflict', () => {
  const rows = [
    task({
      id: 'task-narrow',
      ownerName: 'member-a',
      status: 'in_progress',
      lifecycle: 'running',
      writeScopes: ['tests/fixtures/worldgen'],
      contract: {
        kind: 'edit',
        owner: 'member-a',
        acceptanceCriteria: ['done'],
        writeScopes: ['tests/fixtures/worldgen'],
      },
    }),
    task({
      id: 'task-file',
      ownerName: 'member-b',
      status: 'in_progress',
      lifecycle: 'running',
      writeScopes: ['tests/fixtures/worldgen/ORACLE-SPEC.md'],
      contract: {
        kind: 'edit',
        owner: 'member-b',
        acceptanceCriteria: ['done'],
        writeScopes: ['tests/fixtures/worldgen/ORACLE-SPEC.md'],
      },
    }),
  ]
  const narrowed = planScopeConflictVerdict(rows, {
    id: 'task-narrow',
    taskId: 'task-narrow',
    owner: 'member-a',
    lifecycle: 'running',
    writeScopes: ['tests/fixtures/worldgen/ORACLE-SPEC.md'],
  })
  assert.equal(narrowed.ok, true)
  assert.equal(narrowed.code, 'narrowed-scope')

  const widened = planScopeConflictVerdict(rows, {
    id: 'task-narrow',
    taskId: 'task-narrow',
    owner: 'member-a',
    lifecycle: 'running',
    writeScopes: ['tests/fixtures'],
  })
  assert.equal(widened.ok, false)
  assert.equal(widened.code, 'scope-conflict')
})

test('D-new-13: identical directory scopes do not block one side from narrowing to a child file', () => {
  const rows = [
    task({
      id: 'task-left',
      ownerName: 'member-a',
      status: 'in_progress',
      lifecycle: 'running',
      writeScopes: ['crates/mc-worldgen/tests'],
      contract: {
        kind: 'edit',
        owner: 'member-a',
        acceptanceCriteria: ['done'],
        writeScopes: ['crates/mc-worldgen/tests'],
      },
    }),
    task({
      id: 'task-right',
      ownerName: 'member-b',
      status: 'in_progress',
      lifecycle: 'running',
      writeScopes: ['crates/mc-worldgen/tests/'],
      contract: {
        kind: 'edit',
        owner: 'member-b',
        acceptanceCriteria: ['done'],
        writeScopes: ['crates/mc-worldgen/tests/'],
      },
    }),
  ]
  const narrowed = planScopeConflictVerdict(rows, {
    id: 'task-right',
    taskId: 'task-right',
    owner: 'member-b',
    lifecycle: 'running',
    writeScopes: ['crates/mc-worldgen/tests/dump_chunks.rs'],
  })
  assert.equal(narrowed.ok, true)
  assert.equal(narrowed.code, 'narrowed-scope')
})

test('D-new-14: a member can read its own leases while tier 0 can scope another member', () => {
  const leases = [
    { runId: 'run-a', member: 'member-a', taskId: 'task-a', status: 'active', acquiredAt: 200, expiresAt: 5000 },
    { runId: 'run-b', member: 'member-b', taskId: 'task-b', status: 'active', acquiredAt: 300, expiresAt: 6000 },
    { runId: 'run-c', member: 'member-a', taskId: 'task-c', status: 'completed', acquiredAt: 100, endedAt: 150 },
  ]
  const own = projectLeasesForMember(leases, { tier: 2, member: 'member-a', status: 'active' })
  assert.deepEqual(own.map((lease) => lease.runId), ['run-a'])
  assert.equal(own[0].taskId, 'task-a')
  assert.equal(own[0].expiresAt, 5000)

  const rootScoped = projectLeasesForMember(leases, {
    tier: 0,
    member: 'member-b',
    taskId: 'task-b',
  })
  assert.deepEqual(rootScoped.map((lease) => lease.runId), ['run-b'])
})
