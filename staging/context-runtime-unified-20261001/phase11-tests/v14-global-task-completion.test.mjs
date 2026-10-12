import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../home/profiles/web/plugins/team-tools-v2-r10.mjs'
import { policyFor, resetPolicyServices } from '../home/profiles/web/plugins/team-policy.mjs'
import { resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'

const tempDirs = []

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

afterEach(() => {
  resetControlPlaneCache()
  resetPolicyServices()
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function harness({ actor = 'lead', domainStatus = 'in_progress', repoRoot } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-global-complete-'))
  tempDirs.push(directory)
  const teamId = 'session-global-complete-' + Date.now() + '-' + Math.random().toString(16).slice(2)
  const tools = new Map()
  const hooks = new Map()
  const calls = { domainUpdates: [] }
  const root = { id: teamId, name: 'lead', tier: 0, role: 'lead', group: 'root', status: 'running' }
  const owner = { id: teamId, name: 'lead-parity', tier: 1, role: 'teammate', group: 'parity', status: 'running' }
  const member = actor === 'lead' ? root : owner
  const agent = { id: actor + '-agent', name: actor, session: { id: teamId } }
  agent.ctx = {
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
    on: () => () => {},
  }
  const domainTask = {
    id: 'task-6',
    revision: domainStatus === 'completed' ? 3 : 2,
    status: domainStatus,
    subject: 'global completion regression',
    description: 'regression fixture',
    ownerName: owner.name,
    blockedBy: [],
    writeScopes: [],
    ready: false,
  }
  const ctx = {
    agents: { list: () => [agent] },
    agentTeams: {
      tryMembership: (candidate) => candidate === agent ? member : undefined,
      membership: (candidate) => candidate === agent ? member : undefined,
      listMembers: () => [root, owner],
      getTask: async () => ({ ...domainTask }),
      listTasks: async () => [{ ...domainTask }],
      updateTask: async (_caller, request) => {
        calls.domainUpdates.push({ ...request })
        if (domainStatus === 'completed') throw new Error('completed domain task must not be mutated again')
        return { ...domainTask, revision: domainTask.revision + 1, status: 'completed' }
      },
      sendMessage: async () => ({}),
      spawnTeammate: async () => ({}),
      setMemberFrozen: async () => ({}),
      setMemberRoute: async () => ({}),
      waitForChange: async () => {},
      createTask: async () => ({}),
    },
    subagents: { interrupt: () => {}, steerPrompt: async () => ({}) },
    logger: { warn: () => {} },
    effect: () => () => {},
    on(event, handler) {
      hooks.set(event, handler)
      return () => hooks.delete(event)
    },
  }
  const config = {
    controlDir: directory,
    ...(repoRoot === undefined ? {} : { repoRoot }),
    scopesFile: join(directory, 'write-scopes.json'),
    rolesDir: directory,
    healthPath: join(directory, 'health.json'),
    milestonePath: join(directory, 'milestones.json'),
  }
  apply(ctx, config)
  return { agent, calls, config, ctx, hooks, tools, teamId, control: policyFor(teamId).control }
}

async function seedGlobalTask(control, agent, domainStatus) {
  await control.boardCreate({
    boardId: 'global',
    taskId: 'task-6',
    subject: 'global completion regression',
    description: 'regression fixture',
    ownerName: 'lead-parity',
    phase: 'room-discussion',
    workKind: 'discussion',
  })
  await control.boardUpdate({
    boardId: 'global',
    taskId: 'task-6',
    expectedRevision: 1,
    action: 'claim',
    actorName: 'lead-parity',
  })
  await control.mutate('test/global-completion-evidence', {}, agent, (state) => {
    state.evidence = state.evidence ?? {}
    state.evidence['evidence-global-complete'] = {
      evidenceId: 'evidence-global-complete',
      taskId: 'task-6',
      kind: 'closure',
      status: 'completed',
    }
    return state.evidence['evidence-global-complete']
  })
}

async function complete(control, tools, agent, expectedRevision = 2) {
  const tool = tools.get('team_task_update')
  assert.ok(tool, 'team_task_update must be registered')
  return tool.execute({
    task_id: 'task-6',
    board: 'global',
    expected_revision: expectedRevision,
    action: 'complete',
    evidence_ids: ['evidence-global-complete'],
  }, { agent })
}

test('tier 0 can complete an in-progress global task and mirror the domain result', async () => {
  const h = harness({ actor: 'lead', domainStatus: 'in_progress' })
  await seedGlobalTask(h.control, h.agent, 'in_progress')
  const result = await complete(h.control, h.tools, h.agent)
  assert.equal(result.status, 'completed')
  assert.equal(result.ownerName, 'lead-parity')
  assert.equal(h.calls.domainUpdates.length, 1)
  assert.equal(h.control.boardGet('global', 'task-6').status, 'completed')
})

test('the task owner can complete an in-progress global task', async () => {
  const h = harness({ actor: 'lead-parity', domainStatus: 'in_progress' })
  await seedGlobalTask(h.control, h.agent, 'in_progress')
  const result = await complete(h.control, h.tools, h.agent)
  assert.equal(result.status, 'completed')
  assert.equal(h.calls.domainUpdates.length, 1)
  assert.equal(h.control.boardGet('global', 'task-6').status, 'completed')
})

test('a domain-completed global task is reconciled without replaying completion', async () => {
  const h = harness({ actor: 'lead', domainStatus: 'completed' })
  await seedGlobalTask(h.control, h.agent, 'completed')
  const result = await complete(h.control, h.tools, h.agent)
  assert.equal(result.status, 'completed')
  assert.equal(h.calls.domainUpdates.length, 0)
  const local = h.control.boardGet('global', 'task-6')
  assert.equal(local.status, 'completed')
  assert.deepEqual(local.evidenceIds, ['evidence-global-complete'])
})

test('B-166: complete accepts frozen args with a non-null commit_sha', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-b166-repo-'))
  tempDirs.push(repo)
  git(repo, ['init', '-b', 'main'])
  git(repo, ['config', 'user.email', 'b166@example.test'])
  git(repo, ['config', 'user.name', 'B-166 Test'])
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  git(repo, ['add', 'base.txt'])
  git(repo, ['commit', '-m', 'base'])
  const commit = git(repo, ['rev-parse', 'HEAD'])

  const h = harness({ actor: 'lead', repoRoot: repo })
  await seedGlobalTask(h.control, h.agent, 'in_progress')
  const tool = h.tools.get('team_task_update')
  assert.ok(tool, 'team_task_update must be registered')
  const args = Object.freeze({
    task_id: 'task-6',
    board: 'global',
    expected_revision: 2,
    action: 'complete',
    commit_sha: commit,
    evidence_ids: ['evidence-global-complete'],
  })
  const result = await tool.execute(args, { agent: h.agent })
  assert.equal(result.status, 'completed')
  assert.equal(result.commitSha, commit)
  assert.equal(args.commit_sha, commit)
})

test('an HMR scan that misses an existing agent reinstalls Team tools on its next status event', () => {
  const h = harness()
  h.tools.clear()
  h.ctx.agents.list = () => []
  apply(h.ctx, h.config)
  assert.equal(h.tools.has('team_task_update'), false)
  h.ctx.agents.list = () => [h.agent]
  h.hooks.get('agent/status')({ agent: h.agent, status: 'running' })
  assert.equal(typeof h.tools.get('team_task_update')?.execute, 'function')
})

test('tier 0 can read an exact group board by board id', async () => {
  const h = harness()
  await h.control.boardCreate({
    boardId: 'group-proto',
    taskId: 'group-proto-t1',
    subject: 'exact group board read',
    description: 'tier 0 must address the group board by its exact id',
    phase: 'room-discussion',
    workKind: 'discussion',
  })
  const get = h.tools.get('team_task_get')
  const list = h.tools.get('team_task_list')
  const task = await get.execute({ task_id: 'group-proto-t1', board: 'group-proto' }, { agent: h.agent })
  assert.equal(task.board, 'group-proto')
  const rows = await list.execute({ board: 'group-proto', limit: 10 }, { agent: h.agent })
  assert.equal(rows.tasks.length, 1)
  assert.equal(rows.tasks[0].id, 'group-proto-t1')
})

test('D-新-7 task projection exposes stale contract and requirement revisions', async () => {
  const h = harness()
  await h.control.boardCreate({
    boardId: 'global',
    taskId: 'task-6',
    subject: 'contract projection regression',
    description: 'contract and requirements can lag independently',
    phase: 'room-discussion',
    workKind: 'discussion',
  })
  await h.control.mutate('test/contract-projection', {}, h.agent, (state) => {
    const task = state.boards.global.tasks['task-6']
    task.contract = {
      taskId: 'task-6',
      contractRevision: 2,
      acceptanceCriteria: [{ text: 'old acceptance', required: true }],
    }
    task.contractDigest = 'test-digest'
    state.v12Requirements = {
      version: 1,
      revision: 3,
      requirements: {
        'task:task-6:acceptance': {
          requirementId: 'task:task-6:acceptance',
          revision: 3,
          source: 'task-contract-set',
          acceptance: ['new acceptance'],
        },
      },
      decisions: {},
      events: [],
    }
    return task
  })

  const get = h.tools.get('team_task_get')
  assert.ok(get, 'team_task_get must be registered')
  const result = await get.execute({ task_id: 'task-6', board: 'global' }, { agent: h.agent })
  assert.equal(result.contractRevision, 2)
  assert.equal(result.requirementRevision, 3)
  assert.equal(result.contractStale, true)
})

test('D-新-4 task creation rejects a blocker that exists on another board', async () => {
  const h = harness()
  await h.control.boardCreate({
    boardId: 'group-rig',
    taskId: 'group-rig-t63',
    subject: 'cross-board blocker',
    description: 'exists on a group board',
    phase: 'room-discussion',
    workKind: 'review',
  })
  const create = h.tools.get('team_task_create')
  assert.ok(create, 'team_task_create must be registered')
  await assert.rejects(
    () => create.execute({
      subject: 'global review dependency',
      description: 'must reject an unqualified cross-board blocker',
      kind: 'review',
      blocked_by: ['group-rig-t63'],
    }, { agent: h.agent }),
    (error) => /cross-board-blocker-unsupported/.test(String(error.message))
      && /group-rig-t63 exists on group-rig/.test(String(error.message)),
  )
})

test('a stale HMR status callback ignores an inactive plugin context', () => {
  const h = harness()
  Object.defineProperty(h.ctx, 'agentTeams', {
    configurable: true,
    get() {
      throw new Error('cannot get required service "agentTeams" in inactive context')
    },
  })
  assert.doesNotThrow(() => h.hooks.get('agent/status')({ agent: h.agent, status: 'running' }))
})
