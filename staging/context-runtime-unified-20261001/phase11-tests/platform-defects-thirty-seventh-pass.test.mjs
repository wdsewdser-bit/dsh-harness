import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { afterEach } from 'node:test'
import { pathToFileURL } from 'node:url'

const base = 'D:/dsh-test/home/profiles/web/plugins/'
const contractModule = await import(pathToFileURL(base + 'team-v12-contract.mjs').href)
const controlModule = await import(pathToFileURL(base + 'team-control-plane.mjs').href)
const policyModule = await import(pathToFileURL(base + 'team-policy.mjs').href)
const roomWakeModule = await import(pathToFileURL(base + 'team-v12-room-wake.mjs').href)
const schedulerModule = await import(pathToFileURL(base + 'team-v12-evidence-scheduler.mjs').href)
const toolsModule = await import(pathToFileURL(base + 'team-tools-v2-r10.mjs').href)

const tempDirs = []
afterEach(() => {
  controlModule.resetControlPlaneCache()
  policyModule.resetPolicyServices()
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function makeAgent(name, role, registrations) {
  return {
    name,
    membership: { id: 'team-platform-defects-37', name, role, root: undefined },
    ctx: {
      systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
      tools: {
        register: (definition) => {
          registrations.push({ owner: name, definition })
          return () => {}
        },
      },
    },
  }
}

function setupTeam() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-platform-defects-37-'))
  tempDirs.push(root)
  const registrations = []
  const lead = makeAgent('lead', 'lead', registrations)
  const leadOld = makeAgent('lead-old', 'lead', registrations)
  const leadNew = makeAgent('lead-new', 'lead', registrations)
  const member = makeAgent('member-world', 'teammate', registrations)
  lead.membership.root = lead
  for (const agent of [leadOld, leadNew, member]) agent.membership.root = lead
  const agents = [lead, leadOld, leadNew, member]
  const memberships = new Map(agents.map((agent) => [agent, agent.membership]))
  const ctx = {
    agents: { list: () => agents },
    agentTeams: {
      tryMembership: (agent) => memberships.get(agent),
      membership: (agent) => memberships.get(agent),
      listMembers: () => agents.map((agent) => ({
        id: 'team-platform-defects-37',
        name: agent.name,
        role: agent.membership.role,
        status: 'running',
        diagnostics: [],
      })),
      listTasks: () => [],
      getTask: () => ({}),
      updateTask: async () => ({}),
      waitForChange: async () => ({ timedOut: true }),
    },
    logger: { warn: () => {} },
    on: () => {},
    effect: () => {},
  }
  const controlDir = join(root, 'control')
  policyModule.apply(ctx, { controlDir })
  const policy = policyModule.policyFor(policyModule.teamKeyOf(ctx, lead))
  policy.seedRoot(lead)
  policy.put({ name: 'lead-old', tier: 1, group: 'world', parent: 'lead' })
  policy.put({ name: 'lead-new', tier: 1, group: 'world', parent: 'lead' })
  policy.put({ name: 'member-world', tier: 2, group: 'world', parent: 'lead-old' })
  toolsModule.apply(ctx, {
    controlDir,
    milestonePath: join(root, 'milestones.json'),
    scopesFile: join(root, 'scopes.json'),
    reportDir: join(root, 'reports'),
    clearanceFile: join(root, 'clearances.json'),
    healthPath: join(root, 'health.json'),
    rolesDir: join(root, 'roles'),
  })
  return { controlDir, ctx, lead, leadNew, leadOld, member, policy, registrations }
}

function toolFor(registrations, owner, name) {
  const tool = registrations.find((row) => row.owner === owner
    && row.definition.name === name)?.definition
  assert.ok(tool, name + ' must be registered for ' + owner)
  return tool
}

test('B-222 correction: an inactive target remains cold-resumable for action delivery', () => {
  assert.equal(typeof toolsModule.deliveryTargetVerdict, 'function')
  const inactive = toolsModule.deliveryTargetVerdict({
    target: 'lead-world',
    status: 'inactive',
    liveAgent: undefined,
  })
  assert.equal(inactive.ok, true)
  assert.equal(inactive.code, 'cold-resumable')
  assert.equal(inactive.live, false)

  const coldResumable = toolsModule.deliveryTargetVerdict({
    target: 'member-idle',
    status: 'idle',
    liveAgent: undefined,
  })
  assert.equal(coldResumable.ok, true)
})

test('queued inbox rows can be acknowledged by the target after inbox_list exposes them', () => {
  assert.equal(typeof roomWakeModule.inboxAckInputForCaller, 'function')
  const state = roomWakeModule.createWakeState()
  const queued = roomWakeModule.requestWake(state, {
    target: 'member-a',
    sender: 'lead',
    messageId: 'msg-queued-41h',
    originalText: 'read and acknowledge this queued instruction',
    reason: 'queued-stall',
    dedupeKey: 'queued-stall',
    wakeup: true,
  })
  assert.equal(queued.ok, true)
  const wake = state.wakes[queued.wake.wakeId]
  const input = roomWakeModule.inboxAckInputForCaller(wake, 'member-a', {})
  const handled = roomWakeModule.handleWakeBatch(state, wake.wakeId, input)
  assert.equal(handled.ok, true)
  assert.equal(handled.status, 'handled')
  assert.equal(state.inbox['msg-queued-41h'].status, 'handled')
  assert.equal(state.wakes[wake.wakeId].status, 'handled')
})

test('a replacement lead can receive messages from the previous lead\'s members through a durable re-parent override', () => {
  assert.equal(typeof policyModule.setMemberParentOverride, 'function')
  const registry = policyModule.createRegistry()
  policyModule.putMember(registry, { name: 'lead-old', tier: 1, group: 'world', parent: 'lead' })
  policyModule.putMember(registry, { name: 'lead-new', tier: 1, group: 'world', parent: 'lead' })
  policyModule.putMember(registry, { name: 'member-world', tier: 2, group: 'world', parent: 'lead-old' })

  assert.equal(policyModule.canMessage(registry, 'member-world', 'lead-new'), false)
  const changed = policyModule.setMemberParentOverride(registry, 'member-world', 'lead-new')
  assert.equal(changed.ok, true)
  assert.equal(policyModule.canMessage(registry, 'member-world', 'lead-new'), true)
  assert.equal(policyModule.canSee(registry, 'lead-new', 'member-world'), true)
})

test('a blocked task without an active lease does not block a successor claim', () => {
  const blocked = {
    id: 'group-world-t134',
    status: 'pending',
    lifecycle: 'blocked',
    phase: 'blocked',
    owner: 'world',
    worktreeId: 'world',
    writeScopes: ['crates/mc-worldgen/src/generator.rs'],
  }
  const successor = {
    id: 'group-world-t129',
    status: 'pending',
    phase: 'plan-approved',
    owner: 'world',
    worktreeId: 'world',
    writeScopes: ['crates/mc-worldgen/src/generator.rs'],
  }
  assert.deepEqual(
    contractModule.detectScopeConflicts([blocked], successor, { leases: [] }),
    [],
  )
  assert.equal(
    contractModule.detectScopeConflicts([blocked], successor, {
      leases: [{ taskId: blocked.id, status: 'active' }],
    }).length,
    1,
  )
})

test('an approved plan can explicitly declare no remaining product write scope', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b222-empty-scope-'))
  tempDirs.push(root)
  const control = controlModule.controlPlaneFor('team-empty-scope', { directory: root })
  const plan = await control.planPropose({
    taskId: 'group-world-t134',
    requirementId: 'req-t134',
    goal: 'finish criteria execution without further product writes',
    members: ['world-lead'],
    writeScopes: [],
    checks: { criteria: 'run c1/c2/c3' },
    rollback: 'no product files changed',
  }, {})
  assert.deepEqual(plan.writeScopes, [])
  const validation = contractModule.validateTaskContract({
    taskId: 'group-world-t134',
    kind: 'edit',
    workKind: 'edit',
    owner: 'world-lead',
    writeScopes: [],
    goal: 'finish criteria execution without further product writes',
    acceptanceCriteria: ['criteria pass'],
    risk: { level: 'low', rationale: 'no product write' },
    lifecycle: 'ready',
    contractRevision: 1,
  }, { allowEmptyWriteScopes: true })
  assert.equal(validation.ok, true)

  const task = {
    id: 'group-world-t134',
    status: 'pending',
    phase: 'plan-approved',
    lifecycle: 'ready',
    workKind: 'edit',
    writeScopes: [],
    ownerName: 'world-lead',
    acceptanceCriteria: ['criteria pass'],
    blockedBy: [],
    board: 'group-world',
  }
  const queue = schedulerModule.buildReadyQueue(
    [task],
    [{ name: 'world-lead', status: 'idle' }],
    [],
    { plans: { 'group-world-t134': plan } },
  )
  const ready = [...(queue.ready ?? []), ...(queue.blocked ?? [])]
    .find((row) => row.id === 'group-world-t134')
  assert.equal(ready?.reasons.includes('no-write-scope'), false)
  assert.equal(ready?.eligible, true)
})

test('an approved empty write scope can complete a criteria-only task with evidence and no commit', async () => {
  const { member, policy, registrations } = setupTeam()
  const control = policy.control
  const task = await control.boardCreate({
    boardId: 'group-world',
    taskId: 'group-world-t134',
    subject: 'run criteria without product writes',
    workKind: 'edit',
    writeScopes: [],
    ownerName: 'member-world',
    phase: 'execution',
    status: 'in_progress',
  })
  await control.planPropose({
    taskId: task.id,
    requirementId: 'req-t134',
    goal: 'run c1/c2/c3 without further product writes',
    members: ['member-world'],
    writeScopes: [],
    checks: { criteria: 'c1/c2/c3' },
    rollback: 'no product files changed',
    proposedBy: 'lead',
  })
  await control.planApprove({ taskId: task.id, approvedBy: 'lead' })
  await control.leaseAcquire({
    member: 'member-world',
    taskId: task.id,
    expiresAt: Date.now() + 60_000,
  }, {})
  await control.mutate('test/platform-defects-37-empty-scope-evidence', {}, member, (state) => {
    state.evidence = state.evidence ?? {}
    state.evidence['evidence-criteria-only'] = {
      evidenceId: 'evidence-criteria-only',
      taskId: task.id,
      kind: 'criteria-run',
      classification: 'criteria-only',
      status: 'passed',
      recordedBy: 'member-world',
    }
  })

  const update = toolFor(registrations, 'member-world', 'team_task_update')
  const completed = await update.execute({
    task_id: task.id,
    board: 'group-world',
    expected_revision: control.boardGet('group-world', task.id).revision,
    action: 'complete',
    commit_sha: null,
    evidence_ids: ['evidence-criteria-only'],
  }, { agent: member, signal: undefined })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.commitSha, null)
})

test('team_member_reparent persists the override and rehydrates the replacement lead authority', async () => {
  const { controlDir, ctx, lead, leadNew, member, policy, registrations } = setupTeam()
  assert.equal(policy.canMessage('member-world', 'lead-new'), false)
  const reparent = toolFor(registrations, 'lead', 'team_member_reparent')
  const result = await reparent.execute({
    member: 'member-world',
    parent: 'lead-new',
    reason: 'replacement lead continuity',
  }, { agent: lead, signal: undefined })
  assert.equal(result.changed, true)
  assert.equal(policy.canMessage('member-world', 'lead-new'), true)
  assert.equal(policy.canInterrupt('lead-new', 'member-world'), true)
  assert.equal(policy.canSee('lead-new', 'member-world'), true)

  policyModule.resetPolicyServices()
  policyModule.apply(ctx, { controlDir })
  const rehydrated = policyModule.policyFor(policyModule.teamKeyOf(ctx, lead))
  rehydrated.seedRoot(lead)
  rehydrated.put({ name: 'lead-old', tier: 1, group: 'world', parent: 'lead' })
  rehydrated.put({ name: 'lead-new', tier: 1, group: 'world', parent: 'lead' })
  rehydrated.put({ name: 'member-world', tier: 2, group: 'world', parent: 'lead-old' })
  assert.equal(rehydrated.get('member-world').parent, 'lead-new')
  assert.equal(rehydrated.canMessage('member-world', 'lead-new'), true)
  assert.equal(rehydrated.canSee('lead-new', 'member-world'), true)
})
