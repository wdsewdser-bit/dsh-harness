import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { afterEach } from 'node:test'

import {
  allowedTaskPhaseTransitions,
  resetControlPlaneCache,
  taskPhaseRecoveryActions,
} from '../home/profiles/web/plugins/team-control-plane.mjs'
import { detectScopeConflicts, scopesOverlap } from '../home/profiles/web/plugins/team-v12-contract.mjs'
import { buildReadyQueue, buildSchedulerAdvice } from '../home/profiles/web/plugins/team-v12-evidence-scheduler.mjs'
import { recordWaiting, resolveWaiting } from '../home/profiles/web/plugins/team-v14-waiting.mjs'
import * as policyModule from '../home/profiles/web/plugins/team-policy.mjs'
import * as toolsModule from '../home/profiles/web/plugins/team-tools-v2-r10.mjs'

const tempDirs = []

afterEach(() => {
  resetControlPlaneCache()
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function createAgent(name, role) {
  const registrations = []
  const agent = {
    id: 'batch-253-271-' + name,
    status: 'idle',
    name,
    ctx: {
      systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
      on: () => () => {},
      tools: {
        register: (definition) => {
          registrations.push(definition)
          return () => {}
        },
      },
    },
    membership: { id: 'batch-253-271-team', name, role, root: undefined },
  }
  return { agent, registrations }
}

function setupTeam() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-batch-253-271-'))
  tempDirs.push(root)
  const lead = createAgent('lead', 'lead')
  const groupLead = createAgent('lead-a', 'teammate')
  const agents = [lead.agent, groupLead.agent]
  lead.agent.membership.root = lead.agent
  groupLead.agent.membership.root = lead.agent
  const memberships = new Map(agents.map((agent) => [agent, agent.membership]))
  const domainTasks = new Map()
  let sequence = 0

  const ctx = {
    agents: { list: () => agents },
    agentTeams: {
      tryMembership: (agent) => memberships.get(agent),
      membership: (agent) => memberships.get(agent),
      listMembers: () => agents.map((agent) => ({
        id: 'batch-253-271-' + agent.name,
        name: agent.name,
        role: agent.membership.role,
        status: 'idle',
        diagnostics: [],
        ...(agent === lead.agent ? {} : { level: 1, groupId: 'lead-a', parentName: 'lead' }),
      })),
      createTask: async (_caller, request) => {
        const id = 'task-' + String(++sequence)
        const task = {
          id,
          revision: 1,
          subject: request.subject,
          description: request.description,
          status: 'pending',
          phase: 'room-discussion',
          blockedBy: request.blockedBy ?? [],
          writeScopes: request.writeScopes ?? [],
          commitSha: null,
          evidenceIds: [],
          ready: true,
          writeScopeWarnings: [],
        }
        domainTasks.set(id, task)
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
        if (task.revision !== request.expectedRevision) throw new Error('stale domain revision')
        if (request.action === 'reassign') task.ownerName = request.owner
        task.revision += 1
        return structuredClone(task)
      },
      sendMessage: async () => ({ messageId: 'message-1' }),
      waitForChange: async () => ({ timedOut: true }),
    },
    logger: { warn: () => {}, info: () => {} },
    subagents: { interrupt: () => {} },
    on: () => {},
    effect: () => {},
  }

  const controlDir = join(root, 'control')
  policyModule.apply(ctx, { controlDir })
  const policy = policyModule.policyFor(policyModule.teamKeyOf(ctx, lead.agent))
  policy.seedRoot(lead.agent)
  policy.put({ name: 'lead-a', tier: 1, group: 'lead-a', parent: 'lead' })
  toolsModule.apply(ctx, {
    controlDir,
    scopesFile: join(root, 'scopes.json'),
    milestonePath: join(root, 'milestones.json'),
    rolesDir: join(root, 'roles'),
  })
  return { lead, groupLead, control: policy.control }
}

const toolFor = (registrations, name) => {
  const definition = registrations.find((row) => row.name === name)
  assert.ok(definition, name + ' must be registered')
  return definition
}

test('B-227 rejects a tier-1 owner on a global board at create and reassign', async () => {
  const { lead } = setupTeam()
  const create = toolFor(lead.registrations, 'team_task_create')
  const update = toolFor(lead.registrations, 'team_task_update')
  const signal = new AbortController().signal

  await assert.rejects(
    create.execute({
      subject: 'impossible global owner',
      description: 'tier 1 cannot mutate a global card',
      kind: 'discussion',
      owner: 'lead-a',
      board: 'global',
    }, { agent: lead.agent, signal }),
    /global-board tasks must be owned by tier 0/,
  )

  const created = await create.execute({
    subject: 'unassigned global card',
    description: 'tier 0 can later assign this only to another tier-0 owner',
    kind: 'discussion',
    board: 'global',
  }, { agent: lead.agent, signal })

  await assert.rejects(
    update.execute({
      task_id: created.id,
      expected_revision: created.revision,
      action: 'reassign',
      owner: 'lead-a',
      board: 'global',
    }, { agent: lead.agent, signal }),
    /global-board tasks must be owned by tier 0/,
  )
})

test('B-228 excludes a dependent active card from the candidate scope conflict', () => {
  const candidate = {
    id: 'b',
    lifecycle: 'ready',
    worktreeId: 'group-world',
    writeScopes: ['src/shared.rs'],
  }
  const dependent = {
    id: 'a',
    lifecycle: 'running',
    worktreeId: 'group-world',
    writeScopes: ['src/shared.rs'],
    blockedBy: ['b'],
  }
  assert.deepEqual(detectScopeConflicts([dependent], candidate), [])

  const independent = { ...dependent, blockedBy: [] }
  const conflicts = detectScopeConflicts([independent], candidate)
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].taskId, 'a')

  const tasks = [
    {
      id: 'a',
      boardId: 'group-world',
      status: 'in_progress',
      phase: 'execution',
      ownerName: 'member-a',
      writeScopes: ['src/shared.rs'],
      blockedBy: ['b'],
      acceptanceCriteria: ['done'],
      contract: { kind: 'edit', owner: 'member-a', acceptanceCriteria: ['done'] },
    },
    {
      id: 'b',
      boardId: 'group-world',
      status: 'pending',
      phase: 'room-discussion',
      ownerName: 'member-b',
      writeScopes: ['src/shared.rs'],
      acceptanceCriteria: ['done'],
      contract: { kind: 'edit', owner: 'member-b', acceptanceCriteria: ['done'] },
    },
  ]
  const queue = buildReadyQueue(
    tasks,
    [
      { name: 'member-a', status: 'running' },
      { name: 'member-b', status: 'running' },
    ],
    [{ status: 'active', taskId: 'a', member: 'member-a', expiresAt: 999999 }],
    {
      now: 1000,
      planByTask: new Map([
        ['a', { state: 'plan-approved' }],
        ['b', { state: 'plan-approved' }],
      ]),
    },
  )
  assert.ok(queue.ready.some((row) => row.id === 'b'))
  assert.equal(queue.ready.find((row) => row.id === 'b').reasons.includes('scope-conflict:a'), false)
})

test('B-230 exposes blocked phase transitions and the reopen recovery action', () => {
  assert.ok(allowedTaskPhaseTransitions('blocked').includes('room-discussion'))
  assert.deepEqual(taskPhaseRecoveryActions('blocked'), ['reopen'])
  assert.deepEqual(taskPhaseRecoveryActions('execution'), [])
})

test('B-233 keeps a broad directory claim authoritative over a contained file', () => {
  const broad = 'tools/rig-batch/tests/'
  const narrow = 'tools/rig-batch/tests/oracle/run.ps1'
  assert.equal(scopesOverlap(broad, narrow), true)
  const conflicts = detectScopeConflicts([{
    id: 't114',
    lifecycle: 'running',
    worktreeId: 'group-rig',
    writeScopes: [broad],
  }], {
    id: 't123',
    lifecycle: 'ready',
    worktreeId: 'group-rig',
    writeScopes: [narrow],
  })
  assert.equal(conflicts.length, 1)
})

test('B-231 names an execution-phase task whose owner is inactive', () => {
  const task = {
    id: 't97',
    boardId: 'group-proto',
    status: 'in_progress',
    phase: 'execution',
    ownerName: 'member-registry',
    writeScopes: ['src/registry.rs'],
    contract: { kind: 'edit', owner: 'member-registry', lifecycle: 'running' },
  }
  const advice = buildSchedulerAdvice(
    [task],
    [{ name: 'member-registry', status: 'inactive' }],
    [],
    {
      now: 1000,
      staleExecutionMs: 1000,
      planByTask: new Map([['t97', { state: 'plan-approved' }]]),
    },
  )
  assert.equal(advice.mode, 'shadow')
  assert.equal(advice.executorInactive, true)
  assert.deepEqual(advice.stalledTasks.map((row) => ({ taskId: row.taskId, owner: row.owner })), [
    { taskId: 't97', owner: 'member-registry' },
  ])
})

test('B-232 keeps decision aliases schema-compatible and supports explicit supersede', () => {
  const { lead } = setupTeam()
  const send = toolFor(lead.registrations, 'send_message')
  const wakeSuperior = toolFor(lead.registrations, 'team_wake_superior')
  assert.equal(send.parameters.properties.message.required, undefined)
  assert.ok(wakeSuperior.parameters.properties.message)

  const state = { boards: { global: { tasks: {} } }, v14Waiting: { tickets: {} } }
  const ticket = recordWaiting(state, {
    taskId: 'task-113',
    owner: 'verifier',
    waiter: 'verifier',
    reason: 'manual',
    unblockCondition: { type: 'manual', note: 'owner was recorded incorrectly' },
  }, 'verifier', { now: 100 })
  const resolved = resolveWaiting(state, {
    ticketId: ticket.ticketId,
    resolutionKind: 'superseded',
    supersededBy: 'wait:replacement',
  }, 'lead', { now: 200 })
  assert.equal(resolved.status, 'resolved')
  assert.equal(resolved.closedReason, 'superseded')
  assert.equal(resolved.supersededBy, 'wait:replacement')
  assert.match(resolved.resolution, /condition NOT met/)
  assert.throws(() => resolveWaiting(state, {
    ticketId: ticket.ticketId,
    resolutionKind: 'superseded',
  }, 'lead', { now: 300 }), /requires supersededBy/)
})

test('B-234 binds evidence to a completed read-only card without fabricating a commit', async () => {
  const { lead, control } = setupTeam()
  const create = toolFor(lead.registrations, 'team_task_create')
  const update = toolFor(lead.registrations, 'team_task_update')
  const record = toolFor(lead.registrations, 'team_evidence_record')
  const signal = new AbortController().signal

  const created = await create.execute({
    subject: 'read-only evidence card',
    description: 'this card produces readings, not a commit',
    kind: 'discussion',
    board: 'global',
  }, { agent: lead.agent, signal })
  const claimed = await update.execute({
    task_id: created.id,
    expected_revision: created.revision,
    action: 'claim',
    board: 'global',
  }, { agent: lead.agent, signal })
  const firstEvidence = await record.execute({
    task_id: created.id,
    kind: 'reading',
    actual: 'initial reading',
    status: 'pass',
  }, { agent: lead.agent, signal })
  const completed = await update.execute({
    task_id: created.id,
    expected_revision: control.boardGet('global', created.id).revision,
    action: 'complete',
    evidence_ids: [firstEvidence.evidenceId],
    board: 'global',
  }, { agent: lead.agent, signal })
  const lateEvidence = await record.execute({
    task_id: created.id,
    kind: 'reading',
    actual: 'late complete reading',
    status: 'pass',
  }, { agent: lead.agent, signal })
  const fixed = await update.execute({
    task_id: created.id,
    expected_revision: control.boardGet('global', created.id).revision,
    action: 'bind_fix',
    commit_sha: null,
    evidence_ids: [lateEvidence.evidenceId],
    bind_fix_reason: 'late read-only evidence arrived after completion',
    board: 'global',
  }, { agent: lead.agent, signal })

  assert.equal(fixed.commitSha, null)
  assert.ok(fixed.evidenceIds.includes(firstEvidence.evidenceId))
  assert.ok(fixed.evidenceIds.includes(lateEvidence.evidenceId))
})
