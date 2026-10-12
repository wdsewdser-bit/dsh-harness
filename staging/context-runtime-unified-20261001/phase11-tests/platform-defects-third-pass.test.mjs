import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

const base = 'D:/dsh-test/home/profiles/web/plugins/'
const guard = await import(pathToFileURL(base + 'write-scope-guard.mjs').href)
const waiting = await import(pathToFileURL(base + 'team-v14-waiting.mjs').href)
const evidence = await import(pathToFileURL(base + 'team-v12-evidence-scheduler.mjs').href)
const milestone = await import(pathToFileURL(base + 'team-milestone-v2.mjs').href)
const control = await import(pathToFileURL(base + 'team-control-plane.mjs').href)
const policyModule = await import(pathToFileURL(base + 'team-policy.mjs').href)
const tools = await import(pathToFileURL(base + 'team-tools-v2-r10.mjs').href)

const makeAgent = (name, role, registrations) => ({
  name,
  membership: { id: 'team-third-pass', name, role, root: undefined },
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

test('A-9 parses positional write targets and inline Join-Path expressions', () => {
  const root = 'D:/dsh-test/workspaces/RustMc'
  const outside = 'D:/dsh-test/workspaces/RustMc/../outside-a9.txt'
  for (const command of [
    `Set-Content -Force "${outside}" x`,
    `New-Item -ItemType Directory -Force "${outside}"`,
    `Set-Content "${outside}" x`,
    `New-Item -Force -Path "${outside}"`,
  ]) {
    const parsed = guard.shellWriteTargets(command, root)
    assert.equal(parsed.opaque, false, command)
    assert.equal(parsed.targets.some((target) => target.endsWith('outside-a9.txt')), true, command)
  }
  const temp = guard.shellWriteTargets('Set-Content -Path (Join-Path $env:TEMP "a9-probe.txt") x', root)
  assert.equal(temp.opaque, false)
  assert.equal(temp.targets.some((target) => target.toLowerCase().endsWith('a9-probe.txt')), true)
  const readOnlyAssignment = guard.shellWriteTargets('$x = (git check-ignore -v .local 2>&1)', root)
  assert.equal(readOnlyAssignment.opaque, false)
  assert.deepEqual(readOnlyAssignment.targets, [])
  const zip = guard.shellWriteTargets('[System.IO.Compression.ZipFileExtensions]::ExtractToFile("a.zip", "out/file.txt")', root)
  assert.equal(zip.targets.some((target) => target.endsWith('out\\file.txt') || target.endsWith('out/file.txt')), true)
})

test('B-33 only derives a room wait when an open room round exists', () => {
  const state = {
    boards: { 'group-g': { tasks: { t1: { id: 't1', ownerName: 'm', status: 'in_progress', phase: 'room-discussion' } } } },
    rooms: {}, rounds: {}, leases: {},
  }
  assert.equal(waiting.deriveWaitingTickets(state, [{ name: 'm' }]).some((row) => row.reason === 'waiting-room'), false)
  state.rooms['task:t1'] = { id: 'task:t1', currentRoundId: 'r1', status: 'open' }
  state.rounds.r1 = { id: 'r1', status: 'open' }
  assert.equal(waiting.deriveWaitingTickets(state, [{ name: 'm' }]).some((row) => row.reason === 'waiting-room'), true)
})

test('B-36 distinct explicit waits coexist and resolve independently', () => {
  const state = { boards: { b: { tasks: { t: { id: 't', ownerName: 'm', status: 'in_progress' } } } }, v14Waiting: { tickets: {} } }
  const first = waiting.recordWaiting(state, { taskId: 't', owner: 'm', reason: 'manual-a' }, 'lead', { now: 1 })
  const second = waiting.recordWaiting(state, { taskId: 't', owner: 'm', reason: 'manual-b' }, 'lead', { now: 2 })
  assert.notEqual(first.ticketId, second.ticketId)
  assert.equal(Object.keys(state.v14Waiting.tickets).length, 2)
  assert.equal(waiting.resolveWaiting(state, { taskId: 't', owner: 'm', ticketId: first.ticketId }, 'lead', { now: 3 }).status, 'resolved')
  assert.equal(state.v14Waiting.tickets[second.ticketId].status, 'open')
})

test('B-37 evidence query filters records instead of returning the latest row', () => {
  const registry = evidence.createEvidenceRegistry([
    { id: 'e1', taskId: 't1', requirementId: 'ac-1', status: 'passed', recordedAt: 1, command: 'one' },
    { id: 'e2', taskId: 't2', requirementId: 'ac-2', status: 'failed', recordedAt: 2, command: 'two' },
  ])
  const rows = evidence.queryEvidence(registry, { taskId: 't1' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'e1')
  assert.deepEqual(evidence.queryEvidence(registry, {}), [])
})

test('B-38 recording evidence appends it to the task card', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b38-'))
  try {
    const cp = control.controlPlaneFor('third-pass-b38', { controlDir: root })
    await cp.boardCreate({ boardId: 'group-g', taskId: 't1', subject: 'evidence', status: 'in_progress' })
    const row = await cp.evidencePut({ taskId: 't1', kind: 'test', status: 'passed' }, 'm')
    const task = cp.view({ history: false }).boards['group-g'].tasks.t1
    assert.equal(task.evidenceIds.includes(row.evidenceId), true)
  } finally {
    control.resetControlPlaneCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-39 tier 0 can read tier-2 milestones for delivery-check audit', () => {
  assert.equal(milestone.canReadMilestone({ name: 'lead', tier: 0 }, { name: 'm', tier: 2 }), true)
  assert.equal(milestone.canReadMilestone({ name: 'lead-a', tier: 1 }, { name: 'm', tier: 2, parent: 'lead-a' }), true)
})

test('B-28 bind_fix accepts null as the no-commit sentinel', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b28-null-'))
  try {
    const cp = control.controlPlaneFor('third-pass-b28', { controlDir: root })
    let task = await cp.boardCreate({ boardId: 'group-g', taskId: 't1', subject: 'no commit', status: 'in_progress' })
    task = await cp.boardUpdate({ boardId: 'group-g', taskId: 't1', expectedRevision: task.revision, action: 'complete', actorName: 'm' })
    task = await cp.boardUpdate({ boardId: 'group-g', taskId: 't1', expectedRevision: task.revision, action: 'bind_fix', commitSha: null, evidenceIds: ['e1'], bindFixReason: 'no commit exists' })
    assert.equal(task.commitSha, null)
    assert.deepEqual(task.evidenceIds, ['e1'])
  } finally {
    control.resetControlPlaneCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-40 milestone set verifies the durable document before returning success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b40-'))
  try {
    const registrations = []
    const lead = makeAgent('lead', 'lead', registrations)
    const member = makeAgent('m', 'teammate', registrations)
    lead.membership.root = lead
    member.membership.root = lead
    const agents = [lead, member]
    const memberships = new Map(agents.map((agent) => [agent, agent.membership]))
    const ctx = {
      agents: { list: () => agents },
      agentTeams: {
        tryMembership: (agent) => memberships.get(agent),
        membership: (agent) => memberships.get(agent),
        listMembers: () => agents.map((agent) => ({ id: 'team-third-pass', name: agent.name, role: agent.membership.role, status: 'running' })),
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
    const milestonePath = join(root, 'milestones.json')
    writeFileSync(milestonePath, JSON.stringify({ version: 3, teams: {}, members: {}, bands: {}, compactions: {}, history: {} }))
    policyModule.apply(ctx, { controlDir })
    const policy = policyModule.policyFor(policyModule.teamKeyOf(ctx, lead))
    policy.seedRoot(lead)
    policy.put({ name: 'm', tier: 2, group: 'g', parent: 'lead' })
    tools.apply(ctx, {
      controlDir,
      milestonePath,
      scopesFile: join(root, 'scopes.json'),
      reportDir: join(root, 'reports'),
      clearanceFile: join(root, 'clearances.json'),
      healthPath: join(root, 'health.json'),
      rolesDir: join(root, 'roles'),
    })
    const tool = registrations.find((row) => row.owner === 'm' && row.definition.name === 'team_milestone')?.definition
    assert.ok(tool)
    const result = await tool.execute({ action: 'set', stage: 'durable stage', done_when: 'read back' }, { agent: member, signal: undefined })
    assert.equal(result.done, false)
    const persisted = JSON.parse(readFileSync(milestonePath, 'utf8'))
    assert.equal(persisted.teams['team-third-pass'].members.m.stage, 'durable stage')
  } finally {
    control.resetControlPlaneCache()
    rmSync(root, { recursive: true, force: true })
  }
})
