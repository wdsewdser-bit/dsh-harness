import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { afterEach } from 'node:test'
import { pathToFileURL } from 'node:url'

import { Context } from '../app/node_modules/@deepseek-ai/cordis/lib/index.js'
import { JobJournal, LocalJobRegistry } from '../app/node_modules/@deepseek-ai/dsh-jobs-local/lib/index.js'
import { resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { blockedLeaseReleaseVerdict } from '../home/profiles/web/plugins/team-tools-v2-r10.mjs'

const base = 'D:/dsh-test/home/profiles/web/plugins/'
const policyModule = await import(pathToFileURL(base + 'team-policy.mjs').href)
const toolsModule = await import(pathToFileURL(base + 'team-tools-v2-r10.mjs').href)

const tempDirs = []

afterEach(() => {
  resetControlPlaneCache()
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function makeAgent(name, role, registrations) {
  return {
    name,
    membership: { id: 'team-b197-b202', name, role, root: undefined },
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

function setupTeam(rootName = 'lead') {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b197-b202-'))
  tempDirs.push(root)
  const registrations = []
  const lead = makeAgent(rootName, 'lead', registrations)
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
        id: 'team-b197-b202',
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
  policy.put({ name: 'a1', tier: 2, group: 'g', parent: rootName })
  toolsModule.apply(ctx, {
    controlDir,
    milestonePath: join(root, 'milestones.json'),
    scopesFile: join(root, 'scopes.json'),
    reportDir: join(root, 'reports'),
    clearanceFile: join(root, 'clearances.json'),
    healthPath: join(root, 'health.json'),
    rolesDir: join(root, 'roles'),
  })
  return { lead, member, registrations, control: policy.control }
}

test('B-198 restarted host skips recovered job ids instead of colliding with them', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-b198-recovered-id-'))
  tempDirs.push(directory)
  const oldHost = new JobJournal({
    directory,
    processId: 111,
    processToken: 'old-host',
    isProcessAlive: () => true,
  })
  oldHost.recordSettlement({
    id: 'pwsh-1',
    kind: 'pwsh',
    label: 'recovered completed job',
    status: 'completed',
    startedAt: 1,
    finishedAt: 2,
    detail: 'exit code: 0',
  })

  const registry = new LocalJobRegistry(new Context(), {
    maxConcurrentJobsPerOwner: 10,
    retainBytes: 1024,
    settledRetainBytes: 1024,
    pumpPollMs: 10,
    journalDirectory: directory,
  })
  registry.attachController('batch65-test')
  try {
    const id = registry.start({
      kind: 'pwsh',
      label: 'fresh host job',
      run: () => ({
        done: Promise.resolve({ status: 'completed', detail: 'exit code: 0' }),
        cancel: () => {},
      }),
    })
    await registry.wait(id, 100, undefined)
    let removalError
    try {
      registry.remove(id, undefined)
    } catch (error) {
      removalError = error.message
    }
    assert.equal(removalError, undefined)
    assert.equal(id, 'pwsh-2')
  } finally {
    await registry.disposeAll()
  }
})

test('B-199 plan approval distinguishes a real event from an idempotent no-op', async () => {
  const { lead, registrations, control } = setupTeam()
  await control.boardCreate({
    boardId: 'global',
    taskId: 'global-b199',
    subject: 'plan approval result',
    ownerName: 'lead',
    phase: 'plan-proposed',
    workKind: 'edit',
    writeScopes: ['docs/demo.md'],
  }, {})
  await control.planPropose({
    taskId: 'global-b199',
    goal: 'distinguish plan approval from a no-op',
    members: ['lead'],
    writeScopes: ['docs/demo.md'],
    checks: { result: 'changed and deduplicated are explicit' },
    rollback: 'remove the additive result fields',
    proposedBy: 'lead',
  }, {})

  const approve = registrations.find((row) => row.owner === 'lead'
    && row.definition.name === 'team_plan_approve')?.definition
  assert.ok(approve)
  const first = await approve.execute({ task_id: 'global-b199' }, { agent: lead, signal: undefined })
  assert.deepEqual(
    { changed: first.changed, deduplicated: first.deduplicated },
    { changed: true, deduplicated: false },
  )
  const approvedRevision = control.planState('global-b199').revision
  const second = await approve.execute({ task_id: 'global-b199' }, { agent: lead, signal: undefined })
  assert.deepEqual(
    { changed: second.changed, deduplicated: second.deduplicated },
    { changed: false, deduplicated: true },
  )
  assert.equal(control.planState('global-b199').revision, approvedRevision)
})

test('B-200 blocked release refusal reports every checked condition and a constructible path', () => {
  const verdict = blockedLeaseReleaseVerdict({
    id: 't-b200',
    status: 'in_progress',
    blockedBy: [],
  }, {
    v14Waiting: {
      tickets: {
        unnamed: {
          ticketId: 'unnamed',
          taskId: 't-b200',
          status: 'open',
          unblockCondition: {},
        },
        closedNamed: {
          ticketId: 'closedNamed',
          taskId: 't-b200',
          status: 'closed',
          unblockCondition: { on: 'external dependency' },
        },
      },
    },
  })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /task "t-b200"/)
  assert.match(verdict.reason, /task\.blockedBy: \(none\)/)
  assert.match(verdict.reason, /open waiting tickets for this task: 1/)
  assert.match(verdict.reason, /named open waiting tickets: 0/)
  assert.match(verdict.reason, /unnamed open waiting tickets: 1/)
  assert.match(verdict.reason, /team_task_update\(action:"set_dependencies", blocked_by:\["<task-id>"\]\)/)
})

test('B-202 complete refusal names the missing call argument and existing evidence', async () => {
  const { member, registrations, control } = setupTeam()
  await control.boardCreate({
    boardId: 'global',
    taskId: 'global-b202',
    subject: 'complete refusal diagnosis',
    ownerName: 'a1',
    phase: 'execution',
    workKind: 'discussion',
  }, {})
  await control.evidencePut({
    evidenceId: 'evidence-b202',
    taskId: 'global-b202',
    kind: 'test',
    status: 'passed',
    recordedBy: 'a1',
  }, {})

  const update = registrations.find((row) => row.owner === 'a1'
    && row.definition.name === 'team_task_update')?.definition
  assert.ok(update)
  const expectedRevision = control.boardGet('global', 'global-b202').revision
  await assert.rejects(update.execute({
    action: 'complete',
    task_id: 'global-b202',
    expected_revision: expectedRevision,
  }, { agent: member, signal: undefined }), (error) => {
    assert.match(error.message, /this complete call did not include evidence_ids/)
    assert.match(error.message, /currently has 1 recorded evidence\(s\): evidence-b202/)
    assert.match(error.message, /pass evidence_ids explicitly/)
    return true
  })
})
