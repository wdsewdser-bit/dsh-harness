import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { filterVisibleEvidence } from '../home/profiles/web/plugins/team-v12-runtime.mjs'
import { controlPlaneFile, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { apply as applyWriteScopeGuard } from '../home/profiles/web/plugins/write-scope-guard.mjs'

const base = 'D:/dsh-test/home/profiles/web/plugins/'
const policyModule = await import(pathToFileURL(base + 'team-policy.mjs').href)
const toolsModule = await import(pathToFileURL(base + 'team-tools-v2-r10.mjs').href)

function makeAgent(name, role, registrations) {
  return {
    name,
    membership: { id: 'team-b193-b195', name, role, root: undefined },
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

test('B-193 verifier can read landing-token evidence without broadening private evidence', () => {
  const rows = [
    {
      evidenceId: 'evidence-token',
      kind: 'landing-token',
      classification: 'landing-token',
      taskId: null,
      recordedBy: 'lead',
    },
    {
      evidenceId: 'evidence-token-confirmation',
      kind: 'landing-token-confirmation',
      classification: 'token-confirmation',
      taskId: null,
      recordedBy: 'lead',
    },
    {
      evidenceId: 'evidence-private',
      kind: 'internal-note',
      taskId: null,
      recordedBy: 'lead',
    },
  ]

  const visible = filterVisibleEvidence(rows, {
    tier: 1,
    mine: { name: 'verifier', group: 'verifier', role: 'verifier' },
    canReadTask: () => false,
  })
  assert.deepEqual(visible.map((row) => row.evidenceId), [
    'evidence-token',
    'evidence-token-confirmation',
  ])

  const ordinaryMember = filterVisibleEvidence(rows, {
    tier: 2,
    mine: { name: 'rig-member', group: 'rig', role: 'member' },
    canReadTask: () => false,
  })
  assert.deepEqual(ordinaryMember, [])
})

test('B-195 release reports an expired lease instead of lease-release-order', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b195-release-'))
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
          id: 'team-b193-b195', name: agent.name, role: agent.membership.role,
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
    const task = await control.boardCreate({
      boardId: 'group-g',
      taskId: 'group-g-b195',
      subject: 'expired lease release',
      workKind: 'edit',
      writeScopes: ['src/demo'],
      ownerName: 'a1',
      phase: 'execution',
      status: 'in_progress',
    })
    const expiresAt = Date.now() + 20
    const lease = await control.leaseAcquire({
      member: 'a1',
      taskId: task.id,
      expiresAt,
    }, {})
    await new Promise((resolve) => setTimeout(resolve, 40))

    const tool = registrations.find((row) => row.owner === 'a1'
      && row.definition.name === 'team_run_lease')?.definition
    assert.ok(tool)
    await assert.rejects(tool.execute({
      action: 'release',
      run_id: lease.runId,
      status: 'completed',
    }, { agent: member, signal: undefined }), (error) => {
      assert.match(error.message, /\[lease-expired\]/)
      assert.match(error.message, new RegExp(new Date(expiresAt).toISOString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      assert.doesNotMatch(error.message, /\[lease-release-order\]/)
      return true
    })
  } finally {
    resetControlPlaneCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-195 write refusal names no active lease or its expiry', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-b195-write-'))
  const repo = join(directory, 'repo')
  const scopesFile = join(directory, 'scopes.json')
  const membership = { id: 'team-b193-b195', name: 'member-a', tier: 1, group: 'group-a' }
  const controlFile = controlPlaneFile(membership.id, { directory })
  const agent = { id: 'agent-a', name: 'member-a', session: { header: { cwd: repo } } }
  const actor = { agent }
  let writeIntent
  const ctx = {
    agentTeams: { tryMembership: () => membership },
    logger: { warn: () => {} },
    on(event, handler) {
      if (event === 'fs/write-intent') writeIntent = handler
    },
  }
  const expiresAt = Date.UTC(2026, 8, 29, 10, 0, 0)
  const state = (leases) => ({
    version: 2,
    schemaVersion: 2,
    revision: 1,
    boards: {
      'group-group-a': {
        tasks: {
          t1: {
            id: 't1',
            board: 'group-group-a',
            status: 'in_progress',
            phase: 'execution',
            writeScopes: ['docs/'],
          },
        },
      },
    },
    plans: {
      t1: {
        taskId: 't1',
        state: 'plan-approved',
        members: ['member-a'],
        writeScopes: ['docs/'],
      },
    },
    leases,
  })
  try {
    mkdirSync(repo, { recursive: true })
    writeFileSync(scopesFile, JSON.stringify({
      rootDir: repo,
      defaultDeny: true,
      byName: {},
    }))
    writeFileSync(controlFile, JSON.stringify(state({
      r1: {
        runId: 'r1',
        member: 'member-a',
        taskId: 't1',
        status: 'expired',
        expiresAt,
      },
    })))
    resetControlPlaneCache()
    applyWriteScopeGuard(ctx, { scopesFile, controlDir: directory, rootDir: repo, enforce: true })
    assert.throws(() => writeIntent({
      targetKey: join(repo, 'docs', 'probe.md'),
      displayPath: 'docs/probe.md',
    }, actor), (error) => {
      assert.match(error.message, /active lease: expired at 2026-09-29T10:00:00\.000Z/)
      return true
    })

    writeFileSync(controlFile, JSON.stringify(state({})))
    resetControlPlaneCache()
    assert.throws(() => writeIntent({
      targetKey: join(repo, 'docs', 'probe.md'),
      displayPath: 'docs/probe.md',
    }, actor), /active lease: none/)
  } finally {
    resetControlPlaneCache()
    rmSync(directory, { recursive: true, force: true })
  }
})
