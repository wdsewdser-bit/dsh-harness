#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const base = 'D:\\dsh-test\\home\\profiles\\web\\plugins\\'
const policyMod = await import(pathToFileURL(base + 'team-policy.mjs').href)
const toolsMod = await import(pathToFileURL(base + 'team-tools-v2-r10.mjs').href)

function createAgent(name, role) {
  const registrations = []
  const agent = {
    id: 'phase11-' + name,
    status: 'idle',
    name,
    ctx: {
      systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
      tools: {
        register: (definition) => {
          registrations.push(definition)
          return () => {}
        },
      },
    },
    membership: { id: 'phase11-team', name, role, root: undefined },
  }
  return { agent, registrations }
}

test('a completed edit task can acquire its approved plan again without reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-completed-plan-lease-'))
  const lead = createAgent('lead', 'lead')
  const member = createAgent('lead-a', 'teammate')
  const agents = [lead.agent, member.agent]
  lead.agent.membership.root = lead.agent
  member.agent.membership.root = lead.agent
  const memberships = new Map(agents.map((agent) => [agent, agent.membership]))
  const domainTasks = new Map()
  let sequence = 0

  const ctx = {
    agents: { list: () => agents },
    agentTeams: {
      tryMembership: (agent) => memberships.get(agent),
      membership: (agent) => memberships.get(agent),
      listMembers: () => agents.map((agent) => ({
        id: 'phase11-' + agent.name,
        name: agent.name,
        role: agent.membership.role,
        status: 'idle',
        diagnostics: [],
        ...(agent === lead.agent ? {} : {
          level: 1,
          groupId: 'lead-a',
          parentName: 'lead',
        }),
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
        if (request.action === 'claim') task.status = 'in_progress'
        if (request.action === 'complete') {
          task.status = 'completed'
          if (request.commitSha !== undefined) task.commitSha = request.commitSha
          if (request.evidenceIds !== undefined) task.evidenceIds = request.evidenceIds
        }
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

  try {
    policyMod.apply(ctx, { controlDir: join(root, 'control') })
    const policy = policyMod.policyFor('phase11-team')
    policy.seedRoot(lead.agent)
    policy.put({ name: 'lead-a', tier: 1, group: 'lead-a', parent: 'lead' })
    toolsMod.apply(ctx, {
      controlDir: join(root, 'control'),
      scopesFile: join(root, 'scopes.json'),
      milestonePath: join(root, 'milestones.json'),
      rolesDir: join(root, 'roles'),
    })

    const tool = (registrations, name) => registrations
      .find((definition) => definition.name === name)
    const leadTools = lead.registrations
    const memberTools = member.registrations
    const signal = new AbortController().signal
    const createTask = tool(memberTools, 'team_task_create')
    const updateTask = tool(memberTools, 'team_task_update')
    const propose = tool(memberTools, 'team_plan_propose')
    const approve = tool(memberTools, 'team_plan_approve')
    const recordEvidence = tool(memberTools, 'team_evidence_record')
    const runLease = tool(memberTools, 'team_run_lease')
    const commit = 'a'.repeat(40)

    const task = await createTask.execute({
      subject: 'completed plan rebind',
      description: 'the approved plan remains bindable after completion',
      kind: 'edit',
      write_scopes: ['docs'],
      board: 'group',
    }, { agent: member.agent, signal })

    await updateTask.execute({
      task_id: task.id,
      expected_revision: 1,
      action: 'claim',
      board: 'group',
    }, { agent: member.agent, signal })

    await propose.execute({
      task_id: task.id,
      requirement_id: 'completed-plan-rebind',
      goal: 'prove completed cards retain a bindable approved plan',
      members: ['lead-a'],
      write_scopes: ['docs'],
      checks: { acquisition: ['lease acquire succeeds after completion'] },
      rollback: 'remove the regression fixture',
    }, { agent: member.agent, signal })
    await approve.execute({ task_id: task.id }, { agent: member.agent, signal })

    const first = await runLease.execute({
      action: 'acquire',
      task_id: task.id,
    }, { agent: member.agent, signal })
    assert.equal(first.status, 'active')

    const evidence = await recordEvidence.execute({
      task_id: task.id,
      commit_sha: commit,
      kind: 'implementation',
      output: 'fixture completed while the first lease was active',
      status: 'pass',
    }, { agent: member.agent, signal })

    const beforeComplete = policy.control.boardGet(task.board, task.id)
    const completed = await updateTask.execute({
      task_id: task.id,
      expected_revision: beforeComplete.revision,
      action: 'complete',
      commit_sha: commit,
      evidence_ids: [evidence.evidenceId],
      board: 'group',
    }, { agent: member.agent, signal })
    assert.equal(completed.status, 'completed')

    await runLease.execute({
      action: 'release',
      run_id: first.runId,
      status: 'completed',
    }, { agent: member.agent, signal })

    const phaseBefore = completed.phase
    const planBefore = policy.control.planState(task.id)
    assert.equal(planBefore.state, 'plan-approved')

    const rebound = await runLease.execute({
      action: 'acquire',
      task_id: task.id,
    }, { agent: member.agent, signal })

    assert.equal(rebound.status, 'active')
    assert.equal(rebound.taskId, task.id)
    const after = policy.control.boardGet(task.board, task.id)
    assert.equal(after.status, 'completed')
    assert.equal(after.phase, phaseBefore)
    assert.equal(policy.control.planState(task.id).state, 'plan-approved')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
