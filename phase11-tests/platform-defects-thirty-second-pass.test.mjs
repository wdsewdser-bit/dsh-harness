import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { afterEach } from 'node:test'
import { pathToFileURL } from 'node:url'

import { Context } from '../app/node_modules/@deepseek-ai/cordis/lib/index.js'
import { JobJournal, LocalJobRegistry } from '../app/node_modules/@deepseek-ai/dsh-jobs-local/lib/index.js'
import { resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'

const base = 'D:/dsh-test/home/profiles/web/plugins/'
const policyModule = await import(pathToFileURL(base + 'team-policy.mjs').href)
const toolsModule = await import(pathToFileURL(base + 'team-v12-runtime.mjs').href)

const tempDirs = []

afterEach(() => {
  resetControlPlaneCache()
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function makeAgent(name, role, registrations) {
  return {
    name,
    membership: { id: 'team-b197-b203', name, role, root: undefined },
    ctx: {
      systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
      on: () => () => {},
      tools: {
        register: (definition) => {
          registrations.push({ owner: name, definition })
          return () => {}
        },
      },
    },
  }
}

function setupGroupTeam() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b197-b203-'))
  tempDirs.push(root)
  const registrations = []
  const rootLead = makeAgent('root', 'lead', registrations)
  const groupLead = makeAgent('lead-a', 'lead', registrations)
  const otherLead = makeAgent('lead-b', 'lead', registrations)
  const member = makeAgent('a1', 'teammate', registrations)
  const otherMember = makeAgent('a2', 'teammate', registrations)
  rootLead.membership.root = rootLead
  for (const agent of [groupLead, otherLead, member, otherMember]) agent.membership.root = rootLead
  const agents = [rootLead, groupLead, otherLead, member, otherMember]
  const memberships = new Map(agents.map((agent) => [agent, agent.membership]))
  const ctx = {
    agents: { list: () => agents },
    agentTeams: {
      tryMembership: (agent) => memberships.get(agent),
      membership: (agent) => memberships.get(agent),
      listMembers: () => agents.map((agent) => ({
        id: 'team-b197-b203',
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
  const policy = policyModule.policyFor(policyModule.teamKeyOf(ctx, rootLead))
  policy.seedRoot(rootLead)
  policy.put({ name: 'lead-a', tier: 1, group: 'g-a', parent: 'root' })
  policy.put({ name: 'lead-b', tier: 1, group: 'g-b', parent: 'root' })
  policy.put({ name: 'a1', tier: 2, group: 'g-a', parent: 'lead-a' })
  policy.put({ name: 'a2', tier: 2, group: 'g-b', parent: 'lead-b' })
  toolsModule.apply(ctx, {
    controlDir,
    milestonePath: join(root, 'milestones.json'),
    scopesFile: join(root, 'scopes.json'),
    reportDir: join(root, 'reports'),
    clearanceFile: join(root, 'clearances.json'),
    healthPath: join(root, 'health.json'),
    rolesDir: join(root, 'roles'),
  })
  return { groupLead, member, registrations, control: policy.control }
}

function toolFor(registrations, owner) {
  const definition = registrations.find((row) => row.owner === owner
    && row.definition.name === 'team_v12')?.definition
  assert.ok(definition)
  return definition
}

test('B-197 a group lead can read its member leases through both supported argument shapes', async () => {
  const { groupLead, member, registrations, control } = setupGroupTeam()
  await control.leaseAcquire({
    runId: 'run-a1',
    member: 'a1',
    taskId: 'task-a1',
    expiresAt: Date.now() + 60_000,
  }, {})
  const leaseTool = toolFor(registrations, 'lead-a')

  const nested = await leaseTool.execute({
    action: 'leases',
    input: { member: 'a1' },
  }, { agent: groupLead, signal: undefined })
  assert.equal(nested.member, 'a1')
  assert.equal(nested.taskId, null)
  assert.equal(typeof nested.now, 'number')
  assert.deepEqual(nested.leases.map((lease) => lease.runId), ['run-a1'])

  const topLevel = await leaseTool.execute({
    action: 'leases',
    member: 'a1',
  }, { agent: groupLead, signal: undefined })
  assert.equal(topLevel.member, 'a1')
  assert.deepEqual(topLevel.leases.map((lease) => lease.runId), ['run-a1'])

  const own = await toolFor(registrations, 'a1').execute({
    action: 'leases',
  }, { agent: member, signal: undefined })
  assert.deepEqual(own.leases.map((lease) => lease.runId), ['run-a1'])

  await assert.rejects(leaseTool.execute({
    action: 'leases',
    input: { member: 'a2' },
  }, { agent: groupLead, signal: undefined }), /only tier 0 or the target member's group lead/)
})

test('B-203 live pwsh-153 skips a recovered id and keeps its completed output readable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-b203-recovered-id-'))
  tempDirs.push(directory)
  const oldHost = new JobJournal({
    directory,
    processId: 111,
    processToken: 'old-host',
    isProcessAlive: () => true,
  })
  oldHost.recordSettlement({
    id: 'pwsh-153',
    kind: 'pwsh',
    label: 'recovered pwsh-153 from the original counterexample',
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
  registry.attachController('batch66-test')
  registry.counters.set('pwsh', 152)
  try {
    const id = registry.start({
      kind: 'pwsh',
      label: 'fresh job after the recovered id',
      run: (handle) => {
        handle.append('exact-output')
        return {
          done: Promise.resolve({ status: 'completed', detail: 'exit code: 0' }),
          cancel: () => {},
        }
      },
    })
    assert.equal(id, 'pwsh-154')
    await registry.wait(id, 100, undefined)
    const read = registry.read(id, undefined)
    assert.equal(read.chunks.map((chunk) => chunk.text).join(''), 'exact-output')
    registry.remove(id, undefined)
  } finally {
    await registry.disposeAll()
  }
})
