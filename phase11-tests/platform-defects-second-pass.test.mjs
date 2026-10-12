import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

const base = 'D:/dsh-test/home/profiles/web/plugins/'
const policyModule = await import(pathToFileURL(base + 'team-policy.mjs').href)
const toolsModule = await import(pathToFileURL(base + 'team-tools-v2-r10.mjs').href)
const controlModule = await import(pathToFileURL(base + 'team-control-plane.mjs').href)
const contextModule = await import(pathToFileURL(base + 'team-v14-context-delivery.mjs').href)

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
}

const digest = (value) => createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')

const makeAgent = (name, role, registrations) => ({
  name,
  membership: { id: 'team-second-pass', name, role, root: undefined },
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

test('delivery check treats an unbound or other-task milestone as neutral', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-c4-verdict-'))
  try {
    const registrations = []
    const lead = makeAgent('lead', 'lead', registrations)
    const member = makeAgent('a1', 'teammate', registrations)
    lead.membership.root = lead
    member.membership.root = lead
    const agents = [lead, member]
    const memberships = new Map(agents.map((agent) => [agent, agent.membership]))
    const taskRows = [{ id: 't41', subject: 'inflight', status: 'in_progress', ownerName: 'a1' }]
    const ctx = {
      agents: { list: () => agents },
      agentTeams: {
        tryMembership: (agent) => memberships.get(agent),
        membership: (agent) => memberships.get(agent),
        listMembers: () => agents.map((agent) => ({
          id: 'team-second-pass', name: agent.name, role: agent.membership.role,
          status: 'running', diagnostics: [],
        })),
        listTasks: () => taskRows,
        getTask: () => ({}),
        updateTask: async () => ({}),
        waitForChange: async () => ({ timedOut: true }),
      },
      logger: { warn: () => {} },
      on: () => {},
      effect: () => {},
    }
    const controlDir = join(root, 'control')
    const milestonePath = join(root, 'milestones.json')
    policyModule.apply(ctx, { controlDir })
    const policy = policyModule.policyFor(policyModule.teamKeyOf(ctx, lead))
    policy.put({ name: 'a1', tier: 2, group: 'g', parent: 'lead' })
    const milestone = (taskId) => JSON.stringify({
      version: 2,
      teams: { 'team-second-pass': { members: { a1: {
        owner: 'a1', stage: 'current', doneWhen: 'current', setAt: 1, done: true, taskId,
      } }, bands: {}, compactions: {} } },
      members: {}, bands: {}, compactions: {},
    })
    writeFileSync(milestonePath, milestone('t35'))
    toolsModule.apply(ctx, {
      controlDir,
      milestonePath,
      scopesFile: join(root, 'scopes.json'),
      reportDir: join(root, 'reports'),
      clearanceFile: join(root, 'clearances.json'),
      healthPath: join(root, 'health.json'),
      rolesDir: join(root, 'roles'),
    })
    const tool = registrations.find((row) => row.owner === 'lead'
      && row.definition.name === 'team_delivery_check')?.definition
    assert.ok(tool)
    const unbound = await tool.execute({}, { agent: lead, signal: undefined })
    assert.equal(unbound.open.find((row) => row.id === 't41')?.verdict, 'milestone-unbound')
    writeFileSync(milestonePath, milestone('t41'))
    const bound = await tool.execute({}, { agent: lead, signal: undefined })
    assert.equal(bound.open.find((row) => row.id === 't41')?.verdict, 'owner-forgot-to-mark-it')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('packet contentDigest v2 is recomputable from the stored row', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b29-digest-'))
  try {
    const cp = controlModule.controlPlaneFor('second-pass-digest', { controlDir: root })
    const packet = await cp.packetPut({
      packetId: 'packet-1', kind: 'group-acceptance', group: 'group-a',
      taskIds: ['task-1'], commitSha: 'abc', requirements: ['req-1'],
      checks: [{ command: 'node --check', status: 'pass' }], files: ['src/index.mjs'],
      screenshots: [], resourceScan: { status: 'pass' }, risks: [], blockers: [],
      meta: { note: 'caller metadata' }, submittedBy: 'lead-a',
    })
    assert.equal(packet.meta.contentDigestVersion, 2)
    assert.deepEqual(packet.meta.metaInput, { note: 'caller metadata' })
    const recomputed = digest({
      kind: packet.kind, group: packet.group, taskIds: packet.taskIds,
      commitSha: packet.commitSha, requirements: packet.requirements,
      checks: packet.checks, files: packet.files, screenshots: packet.screenshots,
      resourceScan: packet.resourceScan, risks: packet.risks, blockers: packet.blockers,
      meta: packet.meta.metaInput,
    })
    assert.equal(packet.meta.contentDigest, recomputed)
  } finally {
    controlModule.resetControlPlaneCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a completed discussion card can advance directly to accepted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b31-accepted-'))
  try {
    const cp = controlModule.controlPlaneFor('second-pass-accepted', { controlDir: root })
    let task = await cp.boardCreate({
      boardId: 'global', taskId: 'discussion-1', subject: 'discussion',
      workKind: 'discussion', phase: 'room-discussion',
    })
    task = await cp.boardUpdate({
      boardId: 'global', taskId: task.id, expectedRevision: task.revision,
      action: 'complete', actorName: 'member-a',
    })
    task = await cp.boardUpdate({
      boardId: 'global', taskId: task.id, expectedRevision: task.revision,
      action: 'advance_phase', phase: 'accepted', allowDirectAccept: true,
    })
    assert.equal(task.phase, 'accepted')
    assert.equal(task.status, 'completed')
  } finally {
    controlModule.resetControlPlaneCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('team_task_update exposes the completed discussion acceptance path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b31-tool-'))
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
          id: 'team-second-pass', name: agent.name, role: agent.membership.role,
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
    let task = await policy.control.boardCreate({
      boardId: 'group-g', taskId: 'group-g-t1', subject: 'discussion',
      workKind: 'discussion', phase: 'room-discussion',
    })
    task = await policy.control.boardUpdate({
      boardId: 'group-g', taskId: task.id, expectedRevision: task.revision,
      action: 'complete', actorName: 'a1',
    })
    toolsModule.apply(ctx, {
      controlDir,
      milestonePath: join(root, 'milestones.json'),
      scopesFile: join(root, 'scopes.json'),
      reportDir: join(root, 'reports'),
      clearanceFile: join(root, 'clearances.json'),
      healthPath: join(root, 'health.json'),
      rolesDir: join(root, 'roles'),
    })
    const tool = registrations.find((row) => row.owner === 'lead'
      && row.definition.name === 'team_task_update')?.definition
    assert.ok(tool)
    const updated = await tool.execute({
      task_id: task.id, expected_revision: task.revision,
      action: 'advance_phase', phase: 'accepted', board: 'group-g',
    }, { agent: lead, signal: undefined })
    assert.equal(updated.phase, 'accepted')
    assert.equal(updated.status, 'completed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('context debt is acknowledged once its manifest is visible or durably received', () => {
  const source = {
    id: 'required:large', revision: 1, required: true,
    content: 'x'.repeat(4000),
    fetch: { action: 'task_contract_get', task_id: 'task-1' },
  }
  const delivery = contextModule.buildContextDelivery({
    sources: [source], visible: [], member: 'member-a', sessionId: 'session-a', maxTokens: 80,
  })
  assert.equal(delivery.debt, true)
  const debt = delivery.manifest.debt?.[0]
  assert.ok(debt?.hash)
  const visibleVersions = contextModule.visibleContextVersions([{
    source: { kind: 'team-message', plugin: 'team-v12-runtime' },
    content: [{ type: 'text', text: delivery.body }],
  }])
  assert.equal(visibleVersions.get(source.id), debt.hash)
  const durableVersions = contextModule.durableContextVersions([{
    member: 'member-a', sessionId: 'session-a', debt: delivery.manifest.debt,
  }], { member: 'member-a', sessionId: 'session-a' })
  assert.equal(durableVersions.get(source.id), debt.hash)
  const repeat = contextModule.buildContextDelivery({
    sources: [source], visible: [{
      source: { kind: 'team-message', plugin: 'team-v12-runtime' },
      content: [{ type: 'text', text: delivery.body }],
    }],
    member: 'member-a', sessionId: 'session-a', maxTokens: 80,
  })
  assert.equal(repeat.body, '')
})
