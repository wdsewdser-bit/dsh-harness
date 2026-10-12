import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

const base = 'D:/dsh-test/home/profiles/web/plugins/'
const policyModule = await import(pathToFileURL(base + 'team-policy.mjs').href)
const toolsModule = await import(pathToFileURL(base + 'team-tools-v2-r10.mjs').href)
const waitingModule = await import(pathToFileURL(base + 'team-v14-waiting.mjs').href)
const worktreeModule = await import(pathToFileURL(base + 'team-worktree.mjs').href)

function makeAgent(name, role, registrations) {
  return {
    name,
    membership: { id: 'team-b187', name, role, root: undefined },
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

test('B-187 owner may complete from integration-ready without phase rollback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b187-'))
  try {
    const repo = join(root, 'repo')
    const git = (cwd, args) => execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    git(root, ['init', '-b', 'main', repo])
    git(repo, ['config', 'user.email', 'b187@example.test'])
    git(repo, ['config', 'user.name', 'B-187 Test'])
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    git(repo, ['add', 'base.txt'])
    git(repo, ['commit', '-m', 'base'])
    const commit = git(repo, ['rev-parse', 'HEAD'])
    const registrations = []
    const lead = makeAgent('lead', 'lead', registrations)
    const member = makeAgent('a1', 'teammate', registrations)
    member.session = { header: { cwd: repo } }
    lead.membership.root = lead
    member.membership.root = lead
    const agents = [lead, member]
    const memberships = new Map(agents.map((agent) => [agent, agent.membership]))
    const ctx = {
      agents: { list: () => agents },
      agentTeams: {
        tryMembership: (agent) => memberships.get(agent),
        membership: (agent) => memberships.get(agent),
        listMembers: () => agents.map((agent) => ({
          id: 'team-b187', name: agent.name, role: agent.membership.role,
          status: 'running', diagnostics: [],
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
    policy.put({ name: 'a1', tier: 2, group: 'g', parent: 'lead' })
    toolsModule.apply(ctx, {
      controlDir,
      milestonePath: join(root, 'milestones.json'),
      scopesFile: join(root, 'scopes.json'),
      reportDir: join(root, 'reports'),
      clearanceFile: join(root, 'clearances.json'),
      healthPath: join(root, 'health.json'),
      rolesDir: join(root, 'roles'),
    })
    const control = policy.control
    let task = await control.boardCreate({
      boardId: 'group-g',
      taskId: 'group-g-b187',
      subject: 'complete after integration-ready',
      workKind: 'edit',
      writeScopes: ['src/demo'],
      ownerName: 'a1',
      phase: 'integration-ready',
      status: 'in_progress',
    })
    await control.planPropose({
      taskId: task.id,
      requirementId: 'req-b187',
      goal: 'preserve phase while re-closing',
      members: ['a1'],
      writeScopes: ['src/demo'],
      dependencies: [],
      options: [],
      selectedOption: 'complete in place',
      checks: { completion: 'phase must remain integration-ready' },
      risks: [],
      rollback: 'reopen the task',
      proposedBy: 'lead',
    })
    await control.planApprove({ taskId: task.id, approvedBy: 'lead' })
    task = control.boardGet('group-g', task.id)
    await control.leaseAcquire({
      member: 'a1',
      taskId: task.id,
      expiresAt: Date.now() + 60_000,
    }, {})
    await control.mutate('test/b187-evidence', {}, lead, (state) => {
      state.evidence = state.evidence ?? {}
      state.evidence['evidence-b187'] = {
        evidenceId: 'evidence-b187',
        taskId: task.id,
        kind: 'probe',
        classification: 'non-product',
        status: 'recorded',
      }
    })
    const tool = registrations.find((row) => row.owner === 'a1'
      && row.definition.name === 'team_task_update')?.definition
    assert.ok(tool)
    const completed = await tool.execute({
      task_id: task.id,
      expected_revision: task.revision,
      action: 'complete',
      commit_sha: commit,
      evidence_ids: ['evidence-b187'],
      board: 'group-g',
    }, { agent: member, signal: undefined })
    assert.equal(completed.status, 'completed')
    assert.equal(completed.phase, 'integration-ready')
    assert.equal(control.boardGet('group-g', task.id).phase, 'integration-ready')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-190 opaque approval waits ignore unrelated plan approval', () => {
  const state = {
    boards: {
      global: {
        tasks: {
          t: { id: 't', status: 'in_progress', phase: 'execution', revision: 1 },
        },
      },
    },
    plans: { t: { taskId: 't', state: 'plan-approved' } },
    v14Waiting: { tickets: {} },
  }
  const opaque = waitingModule.recordWaiting(state, {
    taskId: 't',
    owner: 'member',
    reason: 'release',
    unblockCondition: {
      type: 'approval',
      object: 'release ac-3 on the card face',
      note: 'the lead must name a free port',
    },
  }, 'member', { now: 100 })
  assert.equal(waitingModule.waitingTicketActive(opaque, state, 200), true)
  const reconciled = waitingModule.reconcileWaitingTickets(state, { now: 200 })
  assert.equal(reconciled.resolved, 0)
  assert.equal(opaque.status, 'open')

  const planBound = waitingModule.recordWaiting(state, {
    taskId: 't',
    owner: 'member',
    reason: 'plan approval',
    unblockCondition: { type: 'approval', planId: 't' },
  }, 'member', { now: 300 })
  assert.equal(waitingModule.waitingTicketActive(planBound, state, 400), false)
  waitingModule.reconcileWaitingTickets(state, { now: 400 })
  assert.equal(planBound.closedReason, 'plan-approved')

  const legacy = waitingModule.recordWaiting(state, {
    taskId: 't',
    owner: 'member',
    reason: 'approval',
    unblockCondition: { type: 'approval' },
  }, 'member', { now: 500 })
  assert.equal(waitingModule.waitingTicketActive(legacy, state, 600), false)
  const reconciledSatisfied = waitingModule.reconcileWaitingTickets(state, { now: 600 })
  assert.equal(reconciledSatisfied.resolved, 1)
  assert.equal(planBound.status, 'resolved')
  assert.equal(legacy.status, 'resolved')
  assert.equal(opaque.status, 'open')
})

test('B-192 preserved unstaged rows retain raw porcelain bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-b192-'))
  const repo = join(directory, 'repo')
  const worktree = join(directory, 'worktree')
  const git = (cwd, args) => execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  try {
    git(directory, ['init', '-b', 'main', repo])
    git(repo, ['config', 'user.email', 'b192@example.test'])
    git(repo, ['config', 'user.name', 'B-192 Test'])
    writeFileSync(join(repo, 'local.txt'), 'base\n')
    git(repo, ['add', 'local.txt'])
    git(repo, ['commit', '-m', 'base'])
    git(repo, ['branch', 'task'])
    git(repo, ['worktree', 'add', worktree, 'task'])
    writeFileSync(join(repo, 'main.txt'), 'main\n')
    git(repo, ['add', 'main.txt'])
    git(repo, ['commit', '-m', 'advance main'])
    writeFileSync(join(worktree, 'local.txt'), 'changed\n')

    const outcome = worktreeModule.worktreeAdd(repo, worktree, 'task', 'main', worktreeModule.runGit, false, {
      allowTrackedUnstaged: true,
    })
    assert.equal(outcome.ok, true)
    assert.deepEqual(outcome.preservedTrackedUnstaged, [' M local.txt'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
