#!/usr/bin/env node
/**
 * Phase 7: exercise the actual team_delivery_check tool against a fully
 * planned task, then prove that a queued dispatch or major finding closes the
 * gate again.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const base = 'D:\\dsh-test\\home\\profiles\\web\\plugins\\'
const policyMod = await import(pathToFileURL(base + 'team-policy.mjs').href)
const toolsMod = await import(pathToFileURL(base + 'team-tools-v2.mjs').href)

let failed = 0
const check = (label, condition, detail) => {
  if (!condition) failed += 1
  console.log((condition ? 'PASS ' : 'FAIL ') + label + (detail ? '  ' + detail : ''))
}

const root = mkdtempSync(join(tmpdir(), 'dsh-v5-gate-'))
const controlDir = join(root, 'control')
const milestonePath = join(root, 'milestones.json')
const scopesFile = join(root, 'scopes.json')
const reportDir = join(root, 'reports')
const clearanceFile = join(root, 'clearances.json')
const taskCommit = 'a'.repeat(40)

const registrations = []
const mkAgent = (name, role) => {
  const agent = {
    name,
    membership: { id: 'gate-team', name, role, root: undefined },
    ctx: {
      systemPrompt: {
        section: () => () => {},
        getSectionOrder: () => 0,
      },
      tools: {
        register: (definition) => {
          registrations.push({ owner: name, definition })
          return () => {}
        },
      },
    },
  }
  return agent
}

const lead = mkAgent('lead', 'lead')
const groupLead = mkAgent('group-lead', 'teammate')
const member = mkAgent('member', 'teammate')
const verifier = mkAgent('verifier', 'teammate')
const agents = [lead, groupLead, member, verifier]
for (const agent of agents) agent.membership.root = lead
const byAgent = new Map(agents.map((agent) => [agent, agent.membership]))
const frozen = new Map()

const ctx = {
  agents: { list: () => agents },
  agentTeams: {
    tryMembership: (agent) => byAgent.get(agent),
    membership: (agent) => byAgent.get(agent),
    listMembers: () => agents.map((agent) => ({
      id: 'id-' + agent.name,
      name: agent.name,
      role: agent.membership.role,
      status: 'idle',
      diagnostics: [],
      ...(agent === lead ? {} : {
        level: agent === member ? 2 : 1,
        groupId: agent === member ? 'group-a' : agent === verifier ? 'verifier' : 'group-a',
        parentName: agent === member ? 'group-lead' : 'lead',
      }),
      ...(frozen.has(agent.name) ? { frozen: frozen.get(agent.name) } : {}),
    })),
    listTasks: () => [],
    getTask: async () => undefined,
    createTask: async () => { throw new Error('not used') },
    updateTask: async () => { throw new Error('not used') },
    sendMessage: async () => ({ messageId: 'unused' }),
    waitForChange: async () => ({ timedOut: true }),
  },
  logger: { warn: () => {} },
  on: () => {},
  effect: () => {},
}

try {
  policyMod.apply(ctx, { controlDir })
  const policy = policyMod.policyFor('gate-team')
  policy.seedRoot(lead)
  policy.put({ name: 'group-lead', tier: 1, group: 'group-a', parent: 'lead' })
  policy.put({ name: 'member', tier: 2, group: 'group-a', parent: 'group-lead' })
  policy.put({ name: 'verifier', tier: 1, group: 'verifier', parent: 'lead' })
  toolsMod.apply(ctx, {
    scopesFile,
    controlDir,
    milestonePath,
    reportDir,
    clearanceFile,
    healthPath: join(root, 'health.json'),
    rolesDir: join(root, 'roles'),
    windowTokens: 1000,
  })

  const tool = registrations.find((row) => row.owner === 'lead' && row.definition.name === 'team_delivery_check')?.definition
  check('the real delivery gate tool is installed for tier 0', tool !== undefined)

  const cp = policy.control
  let task = await cp.boardCreate({
    boardId: 'global',
    taskId: 'gate-task',
    subject: 'gate task',
    description: 'all acceptance evidence',
    writeScopes: ['src'],
  })
  const advance = async (phase) => {
    task = await cp.boardUpdate({
      boardId: 'global',
      taskId: 'gate-task',
      expectedRevision: task.revision,
      action: 'advance_phase',
      phase,
      actorName: 'lead',
    })
  }
  await advance('room-discussion')
  await cp.planPropose({
    taskId: 'gate-task',
    requirementId: 'REQ-GATE',
    goal: 'prove a complete delivery chain',
    members: ['lead', 'group-lead', 'member', 'verifier'],
    writeScopes: ['src'],
    checks: { member: ['node --check src/index.mjs'] },
    rollback: 'revert',
    proposedBy: 'lead',
  })
  await advance('plan-proposed')
  await cp.planApprove({ taskId: 'gate-task', approvedBy: 'lead' })
  await advance('plan-approved')
  task = await cp.boardUpdate({
    boardId: 'global',
    taskId: 'gate-task',
    expectedRevision: task.revision,
    action: 'claim',
    actorName: 'member',
  })
  await advance('execution')
  task = await cp.boardUpdate({
    boardId: 'global',
    taskId: 'gate-task',
    expectedRevision: task.revision,
    action: 'complete',
    actorName: 'member',
    commitSha: taskCommit,
    evidenceIds: ['gate-evidence'],
  })
  await advance('group-check')
  await advance('verifier-review')
  await advance('integration-ready')
  await advance('integrated')

  await cp.evidencePut({
    evidenceId: 'gate-evidence',
    taskId: 'gate-task',
    commitSha: taskCommit,
    requirementId: 'REQ-GATE',
    kind: 'test',
    command: 'node --check src/index.mjs',
    expected: 'exit 0',
    actual: 'exit 0',
    output: 'ok',
  })
  task = cp.boardGet('global', 'gate-task')
  const packet = (kind) => cp.packetPut({
    packetId: kind + '-packet',
    kind,
    group: kind === 'group-acceptance' ? 'group-a' : kind === 'verifier-review' ? 'verifier' : null,
    taskIds: ['gate-task'],
    commitSha: taskCommit,
    requirements: ['REQ-GATE'],
    checks: [{ command: 'node --check src/index.mjs', status: 'pass' }],
    files: ['src/index.mjs'],
    screenshots: [],
    resourceScan: { missing: [], status: 'pass' },
    risks: [],
    blockers: [],
    submittedBy: kind === 'group-acceptance' ? 'group-lead' : kind === 'verifier-review' ? 'verifier' : 'lead',
  })
  await packet('group-acceptance')
  await packet('verifier-review')
  await packet('final-acceptance')
  await advance('accepted')

  const call = async () => tool.execute({}, { agent: lead, signal: undefined })
  const good = await call()
  check('complete plan/evidence/packet chain passes delivery gate',
    good.deliverable === true && good.openCount === 0 && good.blockers.length === 0,
    JSON.stringify(good))

  const queued = await cp.dispatchCreate({
    dispatchId: 'gate-queued',
    taskId: 'gate-task',
    sender: 'lead',
    target: 'member',
    message: 'late queued work',
    wakeup: false,
  })
  await cp.dispatchTransition({ dispatchId: queued.dispatchId, status: 'queued' })
  const blockedByQueue = await call()
  check('a queued dispatch closes the delivery gate',
    blockedByQueue.deliverable === false
      && blockedByQueue.blockers.some((row) => row.kind === 'dispatch' && row.status === 'queued'),
    JSON.stringify(blockedByQueue.blockers))
  await cp.dispatchTransition({ dispatchId: queued.dispatchId, status: 'delivered' })
  await cp.dispatchTransition({ dispatchId: queued.dispatchId, status: 'turn-started' })
  await cp.dispatchTransition({ dispatchId: queued.dispatchId, status: 'run-failed', error: 'cancelled by gate test' })

  await cp.evidencePut({
    evidenceId: 'gate-major',
    taskId: 'gate-task',
    commitSha: taskCommit,
    requirementId: 'REQ-GATE',
    kind: 'verifier-finding',
    classification: 'major',
    status: 'recorded',
    output: 'major finding',
  })
  const blockedByFinding = await call()
  check('a major finding closes the delivery gate',
    blockedByFinding.deliverable === false
      && blockedByFinding.blockers.some((row) => row.kind === 'finding' && row.status === 'major'),
    JSON.stringify(blockedByFinding.blockers))
} catch (error) {
  failed += 1
  console.log('FAIL delivery gate harness: ' + String(error?.stack ?? error))
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
