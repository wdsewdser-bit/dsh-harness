import test from 'node:test'
import assert from 'node:assert/strict'
import {
  apply,
  continuationAttempt,
  continuationBatchSize,
  continuationCandidates,
  continuationEpisodeId,
  continuationSlaCandidates,
  continuationText,
} from '../home/profiles/web/plugins/team-v14-event-continuation.mjs'
import { buildReadyQueue, taskStatus } from '../home/profiles/web/plugins/team-v12-evidence-scheduler.mjs'
import { controlPlaneFor, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('continuation only targets approved idle owners and is revision keyed', () => {
  const state = {
    boards: { main: { tasks: {
      ready: { id: 'ready', ownerName: 'member-a', lifecycle: 'approved', phase: 'plan-approved', revision: 7, contract: { owner: 'member-a', acceptanceCriteria: ['done'] } },
      running: { id: 'running', ownerName: 'member-b', lifecycle: 'running', phase: 'execution', revision: 2, contract: { owner: 'member-b', acceptanceCriteria: ['done'] } },
      proposed: { id: 'proposed', ownerName: 'member-a', lifecycle: 'proposed', phase: 'plan-proposed', revision: 3, contract: { owner: 'member-a', acceptanceCriteria: ['done'] } },
      dependent: { id: 'dependent', ownerName: 'member-a', lifecycle: 'approved', phase: 'execution', revision: 1, blockedBy: ['running'], contract: { owner: 'member-a', dependencies: ['running'], acceptanceCriteria: ['done'] } },
    } } },
    leases: { active: { member: 'member-b', taskId: 'running', status: 'active' } },
  }
  const members = [
    { name: 'member-a', status: 'idle', frozen: false },
    { name: 'member-b', status: 'running', frozen: false },
  ]
  const rows = continuationCandidates(state, members, 10)
  assert.deepEqual(rows.map((row) => row.id), ['ready'])
  assert.equal(continuationEpisodeId(rows[0]), 'continuation:ready:r7:member-a')
  assert.match(continuationText(rows[0]), /revision=7/)
})

test('successful terminal dependency only; stale lifecycle cannot revive terminal task', () => {
  const task = { id: 'next', status: 'pending', ownerName: 'm', blockedBy: ['prior'],
    contract: { owner: 'm', acceptanceCriteria: ['done'] } }
  const member = [{ name: 'm', status: 'idle' }]
  for (const status of ['deleted', 'cancelled', 'expired']) {
    const prior = { id: 'prior', status, lifecycle: 'running', phase: 'execution' }
    assert.equal(taskStatus(prior), status)
    assert.equal(buildReadyQueue([prior, task], member).ready.length, 0)
  }
  assert.deepEqual(buildReadyQueue([{ id: 'prior', status: 'completed', phase: 'accepted' }, task], member).ready.map((row) => row.id), ['next'])
})

test('edit requires durable approved plan; idle in-progress recovery obeys lease and room wait', () => {
  const task = { id: 'edit', status: 'in_progress', ownerName: 'm', lifecycle: 'approved',
    phase: 'execution', revision: 3, workKind: 'edit', writeScopes: ['src'], contract: { acceptanceCriteria: ['done'] } }
  const state = { boards: { main: { tasks: { edit: task } } }, plans: {}, leases: {}, rooms: {}, rounds: {} }
  const member = [{ name: 'm', status: 'idle' }]
  assert.equal(continuationCandidates(state, member).length, 0)
  state.plans.edit = { state: 'plan-approved' }
  assert.equal(continuationCandidates(state, member)[0].mode, 'idle-resume')
  state.leases.active = { member: 'm', taskId: 'edit', status: 'active' }
  assert.equal(continuationCandidates(state, member).length, 0)
  delete state.leases.active
  state.rooms['task:edit'] = { currentRoundId: 'round' }
  state.rounds.round = { status: 'open' }
  assert.equal(continuationCandidates(state, member).length, 0)
  state.rooms['task:edit'].status = 'closed'
  state.rounds.round.status = 'closed'
  task.phase = 'execution'
  assert.equal(continuationCandidates(state, member)[0].id, 'edit')
})

test('overlapping in-progress edit scopes cannot both resume', () => {
  const makeEdit = (id, owner) => ({ id, status: 'in_progress', ownerName: owner,
    lifecycle: 'approved', phase: 'execution', workKind: 'edit', writeScopes: ['src/shared'],
    contract: { acceptanceCriteria: ['done'] } })
  const state = { boards: { main: { tasks: { a: makeEdit('a', 'a'), b: makeEdit('b', 'b') } } },
    plans: { a: { state: 'plan-approved' }, b: { state: 'plan-approved' } }, leases: {} }
  assert.deepEqual(continuationCandidates(state, [{ name: 'a', status: 'idle' }, { name: 'b', status: 'idle' }])
    .map((row) => row.id), ['a'])
})

test('continuation batch expands on backlog and aging promotes old runnable work', () => {
  const oldTask = { id: 'z-old', status: 'pending', lifecycle: 'approved', phase: 'execution',
    ownerName: 'm', revision: 1, createdAt: 0, updatedAt: 0, priority: 1,
    contract: { kind: 'discussion', acceptanceCriteria: ['done'] } }
  const newTask = { id: 'a-new', status: 'pending', lifecycle: 'approved', phase: 'execution',
    ownerName: 'm', revision: 1, createdAt: 60 * 60 * 1000, updatedAt: 60 * 60 * 1000, priority: 1,
    contract: { kind: 'discussion', acceptanceCriteria: ['done'] } }
  const state = { boards: { main: { tasks: { old: oldTask, fresh: newTask } } }, leases: {} }
  const candidates = continuationCandidates(state, [{ name: 'm', status: 'idle' }],
    2 * 60 * 60 * 1000, { agingStepMs: 15 * 60 * 1000 })
  assert.deepEqual(candidates.map((row) => row.id), ['z-old', 'a-new'])
  assert.equal(candidates[0].effectivePriority > candidates[1].effectivePriority, true)
  assert.deepEqual(continuationBatchSize(candidates, { baseLimit: 1, ceiling: 8 }), {
    candidates: 2, base: 1, ceiling: 8, backlog: true, limit: 2,
  })
})

test('verifier waits past SLA produce an explicit escalation candidate', () => {
  const state = {
    boards: { main: { tasks: { t: {
      id: 't', status: 'pending', lifecycle: 'approved', ownerName: 'm', revision: 2,
      contract: { acceptanceCriteria: ['done'] },
    } } } },
    leases: {},
    v14Waiting: { tickets: {
      review: {
        ticketId: 'review', taskId: 't', owner: 'm', responsible: 'verifier',
        reason: 'verifier review waiting for CLEARED/blocker', status: 'open',
        createdAt: 0, updatedAt: 0, taskRevision: 2,
        unblockCondition: { type: 'external', who: 'verifier' },
      },
    } },
  }
  const rows = continuationSlaCandidates(state, [
    { name: 'm', status: 'idle' },
    { name: 'verifier', status: 'inactive', role: 'verifier' },
  ], { now: 60 * 60 * 1000, verifierSlaMs: 1000 })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].mode, 'sla-escalation')
  assert.equal(rows[0].target, 'verifier')
  assert.match(continuationText(rows[0]), /SLA/)
})

test('durable attempt never re-sends delivered or unresolved queued episode', () => {
  const candidate = { id: 't', revision: 2, owner: 'm' }
  const base = continuationEpisodeId(candidate)
  assert.equal(continuationAttempt({}, candidate, 100, 2, 0).attempt, 1)
  for (const status of ['queued', 'delivered', 'turn-started', 'completed']) {
    assert.equal(continuationAttempt({ wakeEpisodes: { [base + ':a1']: { status } } }, candidate, 100, 2, 0), null)
  }
  assert.equal(continuationAttempt({ wakeEpisodes: { [base + ':a1']: { status: 'delivery-failed', updatedAt: 1 } } }, candidate, 100, 2, 0).attempt, 2)
})

test('registered post-execute and idle hooks dispatch once per durable owner/revision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-continuation-'))
  const root = { id: 'fixture-team', status: 'idle' }
  const worker = { id: 'worker' }
  const hooks = new Map()
  const deliveries = []
  const members = [{ name: 'lead', status: 'idle' }, { name: 'worker', status: 'idle' }]
  const teams = {
    tryMembership(agent) { return agent === root ? { id: root.id, root, name: 'lead' } : agent === worker ? { id: root.id, root, name: 'worker' } : undefined },
    listMembers() { return members },
    async sendMessage(caller, request) { assert.equal(caller, root); assert.ok(request.signal); deliveries.push(request); return { messageId: 'msg-' + deliveries.length, status: 'accepted' } },
  }
  const ctx = { agentTeams: teams, agents: { list: () => [root, worker] },
    on(event, handler) { hooks.set(event, handler); return () => hooks.delete(event) }, logger: { warn() {} } }
  try {
    const cp = controlPlaneFor(root.id, { directory: dir })
    await cp.mutate('fixture/tasks', {}, root, (state) => {
      state.boards.main = { tasks: {
        done: { id: 'done', status: 'pending', lifecycle: 'approved', phase: 'accepted', ownerName: 'worker', revision: 1, contract: { acceptanceCriteria: ['done'] } },
        next: { id: 'next', status: 'pending', lifecycle: 'approved', ownerName: 'worker', revision: 2, blockedBy: ['done'], contract: { acceptanceCriteria: ['done'], dependencies: ['done'] } },
      } }
    })
    const dispose = apply(ctx, { controlDir: dir, scanMs: 0 })
    await hooks.get('tools/post-execute')({ agent: root, tool: { name: 'team_task_update' }, arguments: { action: 'complete', task_id: 'done' } }, { isError: false }, async () => ({ kind: 'accept' }))
    assert.equal(deliveries.length, 1)
    await cp.mutate('fixture/complete', {}, root, (state) => {
      state.boards.main.tasks.done.status = 'completed'
      state.boards.main.tasks.done.phase = 'accepted'
    })
    await hooks.get('tools/post-execute')({ agent: root, tool: { name: 'team_task_update' }, arguments: { action: 'complete', task_id: 'done' } }, { isError: false }, async () => ({ kind: 'accept' }))
    assert.equal(deliveries.length, 2)
    hooks.get('agent/status')({ agent: worker, status: 'running' })
    hooks.get('agent/status')({ agent: worker, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(deliveries.length, 2)
    assert.ok(Object.keys(cp.snapshot().wakeEpisodes).some((id) => id.includes('next:r2:worker')))
    dispose()
  } finally { resetControlPlaneCache(); rmSync(dir, { recursive: true, force: true }) }
})

test('slow completion handoff returns without waiting for mailbox I/O and still delivers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-continuation-slow-mail-'))
  const root = { id: 'fixture-slow-mail', status: 'idle' }
  const worker = { id: 'worker-slow-mail' }
  const hooks = new Map()
  const deliveries = []
  let releaseSend
  const sendGate = new Promise((resolve) => { releaseSend = resolve })
  const members = [
    { id: 'root-id', name: 'lead', status: 'idle' },
    { id: 'group-id', name: 'group-lead', status: 'idle' },
    { id: 'owner-id', name: 'worker', parentName: 'group-lead', status: 'idle' },
  ]
  const teams = {
    tryMembership(agent) {
      return agent === root ? { id: root.id, root, name: 'lead' }
        : agent === worker ? { id: root.id, root, name: 'worker' } : undefined
    },
    listMembers() { return members },
    async sendMessage(caller, request) {
      assert.equal(caller, root)
      deliveries.push(request)
      await sendGate
      return { messageId: 'slow-mail', status: 'accepted' }
    },
  }
  const ctx = {
    agentTeams: teams,
    agents: { list: () => [root, worker] },
    on(event, handler) { hooks.set(event, handler); return () => hooks.delete(event) },
    logger: { warn() {} },
  }
  let dispose
  try {
    const cp = controlPlaneFor(root.id, { directory: dir })
    await cp.mutate('fixture/tasks', {}, root, (state) => {
      state.boards.main = { tasks: {
        done: { id: 'done', status: 'completed', lifecycle: 'completed', ownerName: 'worker', revision: 1,
          evidenceIds: ['ev-1'], contract: { acceptanceCriteria: ['done'] } },
      } }
    })
    dispose = apply(ctx, { controlDir: dir, scanMs: 0 })
    const startedAt = Date.now()
    await hooks.get('tools/post-execute')(
      { agent: root, tool: { name: 'team_task_update' }, arguments: { action: 'complete', task_id: 'done' } },
      { isError: false },
      async () => ({ kind: 'accept' }),
    )
    assert.ok(Date.now() - startedAt < 150, 'post-execute waited for slow mailbox I/O')

    const deliveryDeadline = Date.now() + 1000
    while (deliveries.length === 0 && Date.now() < deliveryDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(deliveries.length, 1)
    releaseSend()

    const deliveredDeadline = Date.now() + 1000
    while (Object.values(cp.snapshot().v14Continuation?.summaries ?? {})[0]?.status !== 'delivered'
      && Date.now() < deliveredDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(Object.values(cp.snapshot().v14Continuation?.summaries ?? {})[0]?.status, 'delivered')
  } finally {
    releaseSend?.()
    dispose?.()
    resetControlPlaneCache()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('legacy control root is reused and downstream block still schedules a successful mutation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-legacy-continuation-'))
  const root = { id: 'new-root', session: { id: 'legacy-root' } }
  const hooks = new Map()
  const deliveries = []
  const teams = {
    tryMembership(agent) { return agent === root ? { id: 'new-root', root, name: 'lead' } : undefined },
    listMembers() { return [{ id: 'lead-id', name: 'lead', status: 'idle' }, { id: 'm-id', name: 'm', status: 'inactive' }] },
    async sendMessage(caller, request) { deliveries.push(request); return { messageId: 'mail-1', status: 'accepted' } },
  }
  const ctx = { agentTeams: teams, agents: { list: () => [root] },
    on(event, handler) { hooks.set(event, handler); return () => hooks.delete(event) }, logger: { warn() {} } }
  try {
    const legacy = controlPlaneFor('legacy-root', { directory: dir })
    await legacy.mutate('fixture/legacy', {}, root, (state) => {
      state.boards.main = { tasks: { t: { id: 't', status: 'pending', lifecycle: 'approved',
        ownerName: 'm', revision: 1, contract: { acceptanceCriteria: ['done'] } } } }
    })
    const dispose = apply(ctx, { controlDir: dir, scanMs: 0 })
    await hooks.get('tools/post-execute')({ agent: root, tool: { name: 'team_plan_approve' }, arguments: {} },
      { isError: false }, async () => ({ kind: 'block' }))
    assert.equal(deliveries.length, 1)
    assert.ok(Object.keys(legacy.snapshot().wakeEpisodes).some((id) => id.includes('continuation:t:r1:m')))
    dispose()
  } finally { resetControlPlaneCache(); rmSync(dir, { recursive: true, force: true }) }
})

test('plan approval reconciles its wait and wakes the owner in the same scan', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-approval-continuation-'))
  const root = { id: 'approval-root', status: 'idle' }
  const worker = { id: 'approval-worker' }
  const hooks = new Map()
  const deliveries = []
  const members = [{ name: 'lead', status: 'idle' }, { name: 'worker', status: 'idle' }]
  const teams = {
    tryMembership(agent) { return agent === root ? { id: root.id, root, name: 'lead' } : undefined },
    listMembers() { return members },
    async sendMessage(caller, request) { deliveries.push(request); return { messageId: 'approval-mail', status: 'accepted' } },
  }
  const ctx = { agentTeams: teams, agents: { list: () => [root, worker] },
    on(event, handler) { hooks.set(event, handler); return () => hooks.delete(event) }, logger: { warn() {} } }
  try {
    const cp = controlPlaneFor(root.id, { directory: dir })
    await cp.mutate('fixture/approval', {}, root, (state) => {
      state.boards.main = { tasks: { t: {
        id: 't', status: 'pending', lifecycle: 'approved', phase: 'plan-approved',
        ownerName: 'worker', revision: 3, contract: { owner: 'worker', acceptanceCriteria: ['done'] },
      } } }
      state.plans = { t: { taskId: 't', state: 'plan-approved' } }
      state.v14Waiting = { tickets: { 'wait:t:worker': {
        ticketId: 'wait:t:worker', taskId: 't', owner: 'worker', reason: 'approval',
        responsible: 'lead', status: 'open', taskRevision: 2, createdAt: 1, updatedAt: 1,
        unblockCondition: { type: 'approval' },
      } } }
    })
    const dispose = apply(ctx, { controlDir: dir, scanMs: 0 })
    await hooks.get('tools/post-execute')({ agent: root, tool: { name: 'team_plan_approve' }, arguments: {} },
      { isError: false }, async () => ({ kind: 'accept' }))
    assert.equal(cp.snapshot().v14Waiting.tickets['wait:t:worker'].status, 'resolved')
    assert.equal(cp.snapshot().v14Waiting.tickets['wait:t:worker'].resolution, 'auto:plan-approved')
    assert.equal(deliveries.length, 1)
    assert.equal(deliveries[0].target, 'worker')
    dispose()
  } finally { resetControlPlaneCache(); rmSync(dir, { recursive: true, force: true }) }
})

test('completion summary retries a failed mailbox send, confirms receipt, and stays within its Team', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-summary-'))
  const root = { id: 'team-one' }
  const hooks = new Map()
  let attempts = 0
  const members = [
    { id: 'root-id', name: 'lead', status: 'inactive' },
    { id: 'group-id', name: 'group-lead', status: 'inactive' },
    { id: 'owner-id', name: 'worker', parentName: 'group-lead', status: 'inactive' },
  ]
  const teams = {
    tryMembership(agent) { return agent === root ? { id: 'team-one', root, name: 'lead' } : undefined },
    listMembers() { return members },
    async sendMessage(caller, request) {
      assert.equal(caller, root)
      assert.equal(request.target, 'group-lead')
      attempts += 1
      if (attempts === 1) throw new Error('transient transport failure')
      return { messageId: 'summary-mail', status: 'accepted' }
    },
  }
  const ctx = { agentTeams: teams, agents: { list: () => [root] },
    on(event, handler) { hooks.set(event, handler); return () => hooks.delete(event) }, logger: { warn() {} } }
  try {
    const cp = controlPlaneFor(root.id, { directory: dir })
    await cp.mutate('fixture/summary', {}, root, (state) => {
      state.boards.main = { tasks: { t: { id: 't', status: 'completed', ownerName: 'worker',
        revision: 4, evidenceIds: ['ev-1'] } } }
    })
    const dispose = apply(ctx, { controlDir: dir, scanMs: 0, retryDelayMs: 0 })
    const hook = hooks.get('tools/post-execute')
    const exec = { agent: root, tool: { name: 'team_task_update' }, arguments: { action: 'complete', task_id: 't' } }
    await hook(exec, { isError: false }, async () => ({ kind: 'block' }))
    assert.equal(Object.values(cp.snapshot().v14Continuation.summaries)[0].status, 'delivery-failed')
    await hook(exec, { isError: false }, async () => ({ kind: 'block' }))
    const summary = Object.values(cp.snapshot().v14Continuation.summaries)[0]
    assert.equal(summary.status, 'delivered')
    assert.equal(summary.messageId, 'summary-mail')
    assert.equal(summary.targetId, 'group-id')
    assert.equal(summary.ownerId, 'owner-id')
    assert.equal(summary.teamId, 'team-one')
    await hook(exec, { isError: false }, async () => ({ kind: 'block' }))
    assert.equal(attempts, 2)
    dispose()
  } finally { resetControlPlaneCache(); rmSync(dir, { recursive: true, force: true }) }
})

test('missing group lead stays queued and idle hook delivers when the same Team roster recovers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-summary-missing-'))
  const root = { id: 'team-missing' }
  const hooks = new Map()
  const deliveries = []
  const members = [{ id: 'root-id', name: 'lead', status: 'inactive' },
    { id: 'owner-id', name: 'worker', parentName: 'group-lead', status: 'inactive' }]
  const teams = {
    tryMembership(agent) { return agent === root ? { id: root.id, root, name: 'lead' } : undefined },
    listMembers() { return members },
    async sendMessage(caller, request) { deliveries.push(request); return { messageId: 'mail-later', status: 'accepted' } },
  }
  const ctx = { agentTeams: teams, agents: { list: () => [root] },
    on(event, handler) { hooks.set(event, handler); return () => hooks.delete(event) }, logger: { warn() {} } }
  try {
    const cp = controlPlaneFor(root.id, { directory: dir })
    await cp.mutate('fixture/summary', {}, root, (state) => {
      state.boards.main = { tasks: { t: { id: 't', status: 'completed', ownerName: 'worker', revision: 1 } } }
    })
    const dispose = apply(ctx, { controlDir: dir, scanMs: 0 })
    await hooks.get('tools/post-execute')({ agent: root, tool: { name: 'team_task_update' }, arguments: { action: 'complete', task_id: 't' } },
      { isError: false }, async () => ({ kind: 'accept' }))
    assert.equal(Object.values(cp.snapshot().v14Continuation.summaries)[0].status, 'target-missing')
    assert.equal(deliveries.length, 0)
    members.push({ id: 'group-id', name: 'group-lead', status: 'inactive' })
    hooks.get('agent/status')({ agent: root, status: 'running' })
    hooks.get('agent/status')({ agent: root, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(deliveries.length, 1)
    assert.equal(Object.values(cp.snapshot().v14Continuation.summaries)[0].status, 'delivered')
    dispose()
  } finally { resetControlPlaneCache(); rmSync(dir, { recursive: true, force: true }) }
})

test('crashed completion send becomes uncertain after its deadline and is never blindly resent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-summary-uncertain-'))
  const root = { id: 'team-uncertain' }
  const hooks = new Map()
  const members = [{ id: 'root-id', name: 'lead', status: 'inactive' },
    { id: 'group-id', name: 'group-lead', status: 'inactive' },
    { id: 'owner-id', name: 'worker', parentName: 'group-lead', status: 'inactive' }]
  let sends = 0
  const teams = {
    tryMembership(agent) { return agent === root ? { id: root.id, root, name: 'lead' } : undefined },
    listMembers() { return members },
    async sendMessage() { sends += 1; return new Promise(() => {}) },
  }
  const ctx = { agentTeams: teams, agents: { list: () => [root] },
    on(event, handler) { hooks.set(event, handler); return () => hooks.delete(event) }, logger: { warn() {} } }
  try {
    const cp = controlPlaneFor(root.id, { directory: dir })
    await cp.mutate('fixture/summary', {}, root, (state) => {
      state.boards.main = { tasks: { t: { id: 't', status: 'completed', ownerName: 'worker', revision: 1 } } }
    })
    const dispose = apply(ctx, { controlDir: dir, scanMs: 0, completionSendDeadlineMs: 1 })
    const hook = hooks.get('tools/post-execute')
    const pending = hook({ agent: root, tool: { name: 'team_task_update' }, arguments: { action: 'complete', task_id: 't' } }, { isError: false }, async () => ({ kind: 'accept' }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    hooks.get('agent/status')({ agent: root, status: 'running' })
    hooks.get('agent/status')({ agent: root, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(sends, 1)
    assert.equal(Object.values(cp.snapshot().v14Continuation.summaries)[0].status, 'uncertain')
    dispose()
    void pending
  } finally { resetControlPlaneCache(); rmSync(dir, { recursive: true, force: true }) }
})

test('manual pause and frozen owners never become automatic continuation targets', () => {
  const state = { boards: { main: { tasks: {
    paused: { id: 'paused', ownerName: 'member-a', lifecycle: 'approved', phase: 'execution', paused: true, contract: { owner: 'member-a', acceptanceCriteria: ['done'] } },
    frozen: { id: 'frozen', ownerName: 'member-b', lifecycle: 'approved', phase: 'execution', contract: { owner: 'member-b', acceptanceCriteria: ['done'] } },
  } } }, leases: {} }
  assert.deepEqual(continuationCandidates(state, [
    { name: 'member-a', status: 'idle' },
    { name: 'member-b', status: 'idle', frozen: true },
  ]), [])
})

test('continuation recovers from one delivery failure without root polling', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-continuation-retry-'))
  const root = { id: 'fixture-retry', status: 'idle' }
  const worker = { id: 'worker-retry' }
  const hooks = new Map()
  let attempts = 0
  const deliveries = []
  const members = [{ name: 'lead', status: 'idle' }, { name: 'worker', status: 'idle' }]
  const teams = {
    tryMembership(agent) {
      return agent === root ? { id: root.id, root, name: 'lead' }
        : agent === worker ? { id: root.id, root, name: 'worker' } : undefined
    },
    listMembers() { return members },
    async sendMessage(caller, request) {
      attempts += 1
      if (attempts === 1) throw new Error('transient mailbox failure')
      deliveries.push(request)
      return { messageId: 'continuation-retry-mail', status: 'accepted' }
    },
  }
  const ctx = {
    agentTeams: teams,
    agents: { list: () => [root, worker] },
    on(event, handler) { hooks.set(event, handler); return () => hooks.delete(event) },
    logger: { warn() {} },
  }
  try {
    const cp = controlPlaneFor(root.id, { directory: dir })
    await cp.mutate('fixture/tasks', {}, root, (state) => {
      state.boards.main = { tasks: {
        done: { id: 'done', status: 'completed', lifecycle: 'completed', phase: 'accepted', ownerName: 'worker', revision: 1 },
        next: {
          id: 'next', status: 'pending', lifecycle: 'approved', ownerName: 'worker', revision: 2,
          blockedBy: ['done'], contract: { owner: 'worker', acceptanceCriteria: ['done'], dependencies: ['done'] },
        },
      } }
    })
    const dispose = apply(ctx, { controlDir: dir, scanMs: 0, retryDelayMs: 0 })
    const hook = hooks.get('tools/post-execute')
    const exec = { agent: root, tool: { name: 'team_task_update' }, arguments: { action: 'complete', task_id: 'done' } }
    await hook(exec, { isError: false }, async () => ({ kind: 'accept' }))
    const failed = Object.values(cp.snapshot().wakeEpisodes)
      .find((row) => row.sender === 'team-v14-event-continuation')
    assert.equal(failed.status, 'delivery-failed')
    await hook(exec, { isError: false }, async () => ({ kind: 'accept' }))
    const delivered = Object.values(cp.snapshot().wakeEpisodes)
      .find((row) => row.sender === 'team-v14-event-continuation' && row.status === 'delivered')
    assert.equal(delivered.status, 'delivered')
    assert.equal(deliveries.length, 1)
    assert.match(deliveries[0].content[0].text, /team continuation/)
    dispose()
  } finally {
    resetControlPlaneCache()
    rmSync(dir, { recursive: true, force: true })
  }
})
