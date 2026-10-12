import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply as applyTeamTools,
  taskEditWriteScopeVerdict,
  taskScopeRecoveryVerdict,
} from '../home/profiles/web/plugins/team-tools-v2-r10.mjs'
import { apply as applyPolicy, policyFor, resetPolicyServices } from '../home/profiles/web/plugins/team-policy.mjs'
import { resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'

const tempDirs = []

afterEach(() => {
  resetControlPlaneCache()
  resetPolicyServices()
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function makeAgent(name, membership) {
  const registrations = []
  const agent = {
    id: 'b47-' + name,
    status: 'idle',
    name,
    ctx: {
      systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
      tools: {
        register(definition) {
          registrations.push(definition)
          return () => {}
        },
      },
    },
    membership,
  }
  return { agent, registrations }
}

function harness(ownerStatus = 'inactive') {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-b47-'))
  tempDirs.push(directory)
  const teamId = 'b47-team-' + Math.random().toString(16).slice(2)
  const root = makeAgent('lead', {
    id: teamId,
    name: 'lead',
    role: 'lead',
    root: undefined,
  })
  const lead = makeAgent('lead-rig', {
    id: teamId,
    name: 'lead-rig',
    role: 'teammate',
    root: root.agent,
  })
  const owner = makeAgent('member-rig', {
    id: teamId,
    name: 'member-rig',
    role: 'teammate',
    root: root.agent,
  })
  const agents = [root.agent, lead.agent, owner.agent]
  const memberships = new Map(agents.map((agent) => [agent, agent.membership]))
  const domainTasks = new Map()
  const liveMembers = [
    { id: teamId, name: 'lead', role: 'lead', status: 'running', diagnostics: [] },
    { id: teamId, name: 'lead-rig', role: 'teammate', status: 'idle', diagnostics: [] },
    { id: teamId, name: 'member-rig', role: 'teammate', status: ownerStatus, diagnostics: [] },
  ]
  const ctx = {
    agents: { list: () => agents },
    agentTeams: {
      tryMembership: (agent) => memberships.get(agent),
      membership: (agent) => memberships.get(agent),
      listMembers: () => liveMembers,
      createTask: async (_caller, request) => {
        const task = {
          id: request.taskId ?? 'task-b47',
          revision: 1,
          subject: request.subject,
          description: request.description,
          status: request.ownerName === undefined ? 'pending' : 'in_progress',
          phase: 'room-discussion',
          ownerName: request.ownerName,
          blockedBy: [],
          writeScopes: request.writeScopes ?? [],
          workKind: request.workKind ?? 'edit',
          ready: true,
        }
        domainTasks.set(task.id, task)
        return structuredClone(task)
      },
      listTasks: () => [...domainTasks.values()].map((task) => structuredClone(task)),
      getTask: (_caller, id) => {
        const task = domainTasks.get(String(id))
        if (task === undefined) throw new Error('unknown domain task')
        return structuredClone(task)
      },
      updateTask: async (_caller, request) => {
        const task = domainTasks.get(String(request.taskId))
        if (task === undefined) throw new Error('unknown domain task')
        if (Number(task.revision) !== Number(request.expectedRevision)) throw new Error('stale domain revision')
        if (request.action === 'edit' && request.writeScopes !== undefined) task.writeScopes = [...request.writeScopes]
        if (request.action === 'claim') task.status = 'in_progress'
        task.revision += 1
        return structuredClone(task)
      },
      sendMessage: async () => ({ messageId: 'message-1' }),
      waitForChange: async () => ({ timedOut: true }),
    },
    logger: { warn: () => {}, info: () => {} },
    subagents: { interrupt: () => {} },
    on: () => () => {},
    effect: () => () => {},
  }
  const config = {
    controlDir: join(directory, 'control'),
    scopesFile: join(directory, 'scopes.json'),
    milestonePath: join(directory, 'milestones.json'),
    rolesDir: join(directory, 'roles'),
  }
  applyPolicy(ctx, { controlDir: config.controlDir })
  const policy = policyFor(teamId)
  policy.seedRoot(root.agent)
  policy.put({ name: 'lead-rig', tier: 1, group: 'rig', parent: 'lead' })
  policy.put({ name: 'member-rig', tier: 2, group: 'rig', parent: 'lead-rig' })
  applyTeamTools(ctx, config)
  return { config, ctx, lead, owner, policy, root }
}

function toolFor(registrations, name) {
  const tool = registrations.find((definition) => definition.name === name)
  assert.ok(tool, name + ' must be registered')
  return tool
}

async function seedTask(h, scopes = ['docs/wrong']) {
  return h.policy.control.boardCreate({
    boardId: 'group-rig',
    taskId: 'task-b47',
    subject: 'repair unplanned task scope',
    description: 'the inactive owner cannot propose the corrective plan',
    ownerName: 'member-rig',
    writeScopes: scopes,
    workKind: 'edit',
    phase: 'room-discussion',
  }, h.root.agent)
}

test('B-47: an inactive-owner unplanned scope can be repaired by the own-group lead', async () => {
  const h = harness('inactive')
  const task = await seedTask(h)
  const update = toolFor(h.lead.registrations, 'team_task_update')
  const repaired = await update.execute({
    task_id: task.id,
    board: 'group',
    expected_revision: task.revision,
    action: 'edit',
    write_scopes: ['tools/rig-batch'],
  }, { agent: h.lead.agent })
  assert.deepEqual(repaired.writeScopes, ['tools/rig-batch'])
  assert.deepEqual(h.policy.control.boardGet('group-rig', task.id).writeScopes, ['tools/rig-batch'])
})

test('B-47: the recovery path stays closed while the owner is active', async () => {
  const h = harness('running')
  const task = await seedTask(h)
  const update = toolFor(h.lead.registrations, 'team_task_update')
  await assert.rejects(() => update.execute({
    task_id: task.id,
    board: 'group',
    expected_revision: task.revision,
    action: 'edit',
    write_scopes: ['tools/rig-batch'],
  }, { agent: h.lead.agent }), /task-scope-recovery-owner-active/)
})

test('B-47: the recovery path stays closed while a run lease is active', async () => {
  const h = harness('inactive')
  const task = await seedTask(h)
  await h.policy.control.mutate('test/b47-active-lease', {}, h.root.agent, (state) => {
    state.leases = state.leases ?? {}
    state.leases['run-b47'] = {
      runId: 'run-b47',
      taskId: task.id,
      member: 'member-rig',
      status: 'active',
      expiresAt: Date.now() + 60_000,
    }
    return state.leases['run-b47']
  })
  const update = toolFor(h.lead.registrations, 'team_task_update')
  await assert.rejects(() => update.execute({
    task_id: task.id,
    board: 'group',
    expected_revision: task.revision,
    action: 'edit',
    write_scopes: ['tools/rig-batch'],
  }, { agent: h.lead.agent }), /task-scope-recovery-active-lease/)
})

test('B-47: the pure verdict rejects cross-group, plan-controlled and non-lead edits', () => {
  const base = {
    actor: { name: 'lead-rig', tier: 1, group: 'rig' },
    task: { ownerName: 'member-rig', status: 'in_progress' },
    boardId: 'group-rig',
    ownerActive: false,
    activeLease: false,
    planExists: false,
  }
  assert.equal(taskScopeRecoveryVerdict({ action: 'edit', write_scopes: ['tools/rig-batch'] }, base).ok, true)
  assert.equal(taskScopeRecoveryVerdict({ action: 'edit', write_scopes: ['tools/rig-batch'] }, {
    ...base,
    boardId: 'group-proto',
  }).code, 'task-scope-recovery-board')
  assert.equal(taskScopeRecoveryVerdict({ action: 'edit', write_scopes: ['tools/rig-batch'] }, {
    ...base,
    planExists: true,
  }).code, 'task-scope-recovery-plan')
  assert.equal(taskScopeRecoveryVerdict({ action: 'edit', write_scopes: ['tools/rig-batch'] }, {
    ...base,
    actor: { name: 'member-rig', tier: 2, group: 'rig' },
  }).code, 'task-scope-recovery-actor')
  assert.equal(taskEditWriteScopeVerdict({ action: 'edit', write_scopes: ['tools/rig-batch'] }).ok, false)
  assert.equal(taskEditWriteScopeVerdict(
    { action: 'edit', write_scopes: ['tools/rig-batch'] },
    { recovery: taskScopeRecoveryVerdict({ action: 'edit', write_scopes: ['tools/rig-batch'] }, base) },
  ).ok, true)
})
