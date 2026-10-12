import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

const base = 'D:/dsh-test/home/profiles/web/plugins/'
const policyModule = await import(pathToFileURL(base + 'team-policy.mjs').href)
const toolsModule = await import(pathToFileURL(base + 'team-tools-v2-r10.mjs').href)

const makeAgent = (name, role, registrations) => ({
  name,
  membership: { id: 'team-b186', name, role, root: undefined },
  ctx: {
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
    tools: {
      register: (definition) => {
        registrations.push({ owner: name, definition })
        return () => {}
      },
    },
  },
})

test('B-186 only tier 0 may cross the integration boundary', () => {
  assert.equal(toolsModule.taskPhaseAdvanceActorVerdict({
    action: 'advance_phase', phase: 'integration-ready', actorTier: 2,
  }).ok, true)
  assert.equal(toolsModule.taskPhaseAdvanceActorVerdict({
    action: 'advance_phase', phase: 'integrated', actorTier: 2,
  }).code, 'phase-owner-terminal')
  assert.equal(toolsModule.taskPhaseAdvanceActorVerdict({
    action: 'advance_phase', phase: 'accepted', actorTier: 1,
  }).code, 'phase-owner-terminal')
  assert.equal(toolsModule.taskPhaseAdvanceActorVerdict({
    action: 'advance_phase', phase: 'accepted', actorTier: 0,
  }).ok, true)
  assert.equal(toolsModule.taskPhaseAdvanceActorVerdict({
    action: 'advance_phase', phase: 'accepted', actorTier: 2, allowDirectAccept: true,
  }).ok, true)
})

test('B-186 team_task_update refuses owner terminal advance and reopen repairs accepted state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b186-'))
  try {
    const registrations = []
    const lead = makeAgent('lead', 'lead', registrations)
    const member = makeAgent('a1', 'teammate', registrations)
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
          id: 'team-b186', name: agent.name, role: agent.membership.role,
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
    const toolFor = (owner) => registrations.find((row) => row.owner === owner
      && row.definition.name === 'team_task_update')?.definition

    let blocked = await policy.control.boardCreate({
      boardId: 'group-g', taskId: 'group-g-b186', subject: 'over-terminal guard',
      workKind: 'edit', writeScopes: ['crates/demo'], phase: 'integration-ready',
    })
    blocked = await policy.control.boardUpdate({
      boardId: 'group-g', taskId: blocked.id, expectedRevision: blocked.revision,
      action: 'claim', actorName: 'a1',
    })
    await assert.rejects(
      () => toolFor('a1').execute({
        task_id: blocked.id,
        expected_revision: blocked.revision,
        action: 'advance_phase',
        phase: 'integrated',
        board: 'group-g',
      }, { agent: member, signal: undefined }),
      /phase-owner-terminal/,
    )
    assert.equal(policy.control.boardGet('group-g', blocked.id).phase, 'integration-ready')

    const crossed = await toolFor('lead').execute({
      task_id: blocked.id,
      expected_revision: blocked.revision,
      action: 'advance_phase',
      phase: 'integrated',
      board: 'group-g',
    }, { agent: lead, signal: undefined })
    assert.equal(crossed.phase, 'integrated')

    const overTerminal = await policy.control.boardCreate({
      boardId: 'group-g', taskId: 'group-g-b186-recover', subject: 'over-terminal recovery',
      workKind: 'edit', writeScopes: ['crates/demo'], phase: 'accepted', status: 'pending',
    })
    const repaired = await toolFor('a1').execute({
      task_id: overTerminal.id,
      expected_revision: overTerminal.revision,
      action: 'reopen',
      reopen_reason: 'repair over-terminal phase',
      board: 'group-g',
    }, { agent: member, signal: undefined })
    assert.equal(repaired.status, 'pending')
    assert.equal(repaired.phase, 'execution')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
