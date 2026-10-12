import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { afterEach } from 'node:test'
import { pathToFileURL } from 'node:url'

const base = 'D:/dsh-test/home/profiles/web/plugins/'
const controlModule = await import(pathToFileURL(base + 'team-control-plane.mjs').href)
const toolsModule = await import(pathToFileURL(base + 'team-tools-v2-r10.mjs').href)
const policyModule = await import(pathToFileURL(base + 'team-policy.mjs').href)

const tempDirs = []
afterEach(() => {
  controlModule.resetControlPlaneCache()
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function setupTeam() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b207-b210-'))
  tempDirs.push(root)
  const registrations = []
  const lead = {
    name: 'lead',
    membership: { id: 'team-b207-b210', name: 'lead', role: 'lead', root: undefined },
    ctx: {
      systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
      on: () => () => {},
      tools: {
        register: (definition) => {
          registrations.push({ owner: 'lead', definition })
          return () => {}
        },
      },
    },
  }
  lead.membership.root = lead
  const memberships = new Map([[lead, lead.membership]])
  const ctx = {
    agents: { list: () => [lead] },
    agentTeams: {
      tryMembership: (agent) => memberships.get(agent),
      membership: (agent) => memberships.get(agent),
      listMembers: () => [{ id: 'team-b207-b210', name: 'lead', role: 'lead', status: 'running', diagnostics: [] }],
      listTasks: () => [],
      getTask: () => ({}),
      updateTask: async () => ({}),
      waitForChange: async () => ({ timedOut: true }),
      createTask: async (_caller, request) => ({
        id: 'task-b207',
        revision: 1,
        subject: request.subject,
        description: request.description,
        blockedBy: request.blockedBy ?? [],
        writeScopes: request.writeScopes ?? [],
      }),
    },
    logger: { warn: () => {} },
    on: () => {},
    effect: () => {},
  }
  const controlDir = join(root, 'control')
  policyModule.apply(ctx, { controlDir })
  const policy = policyModule.policyFor(policyModule.teamKeyOf(ctx, lead))
  policy.seedRoot(lead)
  toolsModule.apply(ctx, {
    controlDir,
    milestonePath: join(root, 'milestones.json'),
    scopesFile: join(root, 'scopes.json'),
    reportDir: join(root, 'reports'),
    clearanceFile: join(root, 'clearances.json'),
    healthPath: join(root, 'health.json'),
    rolesDir: join(root, 'roles'),
  })
  return { lead, registrations, control: policy.control }
}

function toolFor(registrations, name) {
  const definition = registrations.find((row) => row.definition.name === name)?.definition
  assert.ok(definition)
  return definition
}

test('B-207 completed dependency mode releases a completed content dependency before final acceptance', () => {
  const dependency = { status: 'completed', phase: 'integration-ready' }
  assert.equal(controlModule.dependencySatisfied(dependency), false)
  assert.equal(controlModule.dependencySatisfied(dependency, 'completed'), true)
  assert.equal(controlModule.dependencySatisfied({ status: 'pending', phase: 'accepted' }, 'completed'), false)
})

test('B-207 task tools expose and persist an explicit completed dependency threshold', async () => {
  const { lead, registrations, control } = setupTeam()
  const create = toolFor(registrations, 'team_task_create')
  const created = await create.execute({
    subject: 'content dependency card',
    description: 'release after content completion',
    kind: 'edit',
    blocked_by: ['dependency-task'],
    dependency_phase: 'completed',
    write_scopes: ['src/content.rs'],
  }, { agent: lead, signal: undefined })
  assert.equal(created.dependencyPhase, 'completed')
  assert.equal(control.view({ history: false }).boards.global.tasks[created.id].dependencyPhase, 'completed')

  const update = toolFor(registrations, 'team_task_update')
  await update.execute({
    task_id: created.id,
    expected_revision: created.revision,
    action: 'set_dependencies',
    blocked_by: ['dependency-task'],
    dependency_phase: 'accepted',
  }, { agent: lead, signal: undefined })
  assert.equal(control.view({ history: false }).boards.global.tasks[created.id].dependencyPhase, 'accepted')
})

test('B-210 same-owner plan proposal is advisory while execution conflicts remain fail-closed', () => {
  const active = {
    id: 'group-world-t134',
    status: 'in_progress',
    phase: 'execution',
    owner: 'world-1',
    worktreeId: 'group-world',
    writeScopes: ['crates/mc-worldgen/src/generator.rs'],
  }
  const sameOwner = toolsModule.planScopeConflictVerdict([active], {
    id: 'group-world-t129',
    status: 'pending',
    phase: 'room-discussion',
    owner: 'world-1',
    worktreeId: 'group-world',
    writeScopes: ['crates/mc-worldgen/src/generator.rs'],
  })
  assert.equal(sameOwner.ok, true)
  assert.equal(sameOwner.code, 'same-owner-plan')
  assert.equal(sameOwner.conflicts.length, 1)

  const otherOwner = toolsModule.planScopeConflictVerdict([active], {
    id: 'group-world-t129',
    status: 'pending',
    phase: 'room-discussion',
    owner: 'world-2',
    worktreeId: 'group-world',
    writeScopes: ['crates/mc-worldgen/src/generator.rs'],
  })
  assert.equal(otherOwner.ok, false)
  assert.equal(otherOwner.code, 'scope-conflict')
})
