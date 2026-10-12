#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const base = pathToFileURL('D:/dsh-test/home/profiles/web/plugins/').href
const policyMod = await import(base + 'team-policy.mjs')
const toolsMod = await import(base + 'team-tools-v2-r10.mjs')

const root = mkdtempSync(join(tmpdir(), 'dsh-v14-acceptance-verifier-'))
const repo = join(root, 'repo')
mkdirSync(repo)
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
execFileSync('git', ['config', 'user.email', 'acceptance@example.test'], { cwd: repo })
execFileSync('git', ['config', 'user.name', 'Acceptance Test'], { cwd: repo })
writeFileSync(join(repo, 'base.txt'), 'base\n')
execFileSync('git', ['add', 'base.txt'], { cwd: repo })
execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo })
const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
execFileSync('git', ['branch', 'grp/group-a'], { cwd: repo })
const registrations = []
const mkAgent = (name) => ({
  name,
  session: { header: { cwd: repo } },
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

const rootAgent = mkAgent('lead')
const groupLead = mkAgent('lead-a')
const verifier = mkAgent('verifier')
const agents = [rootAgent, groupLead, verifier]
const memberships = new Map([
  [rootAgent, { id: 'acceptance-team', name: 'lead', role: 'lead', root: rootAgent }],
  [groupLead, { id: 'acceptance-team', name: 'lead-a', role: 'teammate', root: rootAgent }],
  [verifier, { id: 'acceptance-team', name: 'verifier', role: 'teammate', root: rootAgent }],
])
const sent = []

const ctx = {
  agents: { list: () => agents },
  subagents: { steerPrompt: async () => {} },
  agentTeams: {
    tryMembership: (agent) => memberships.get(agent),
    membership: (agent) => memberships.get(agent),
    listMembers: () => agents.map((agent) => ({
      id: 'id-' + agent.name,
      name: agent.name,
      role: memberships.get(agent).role,
      status: 'idle',
      diagnostics: [],
      frozen: false,
      ...(agent === rootAgent ? {} : { level: 1, groupId: agent === verifier ? 'verifier' : 'group-a', parentName: 'lead' }),
    })),
    listTasks: () => [],
    getTask: async () => undefined,
    updateTask: async () => { throw new Error('not used') },
    sendMessage: async (caller, request) => {
      sent.push({ caller: caller.name, target: request.target })
      return { messageId: 'acceptance-message-' + String(sent.length) }
    },
    waitForChange: async () => ({ timedOut: true }),
  },
  logger: { warn: () => {}, error: () => {} },
  on: () => {},
  effect: () => {},
}

try {
  policyMod.apply(ctx, { controlDir: join(root, 'control') })
  const policy = policyMod.policyFor('acceptance-team')
  policy.seedRoot(rootAgent)
  policy.put({ name: 'lead-a', tier: 1, group: 'group-a', parent: 'lead' })
  policy.put({ name: 'verifier', tier: 1, group: 'verifier', parent: 'lead' })
  toolsMod.apply(ctx, {
    controlDir: join(root, 'control'),
    scopesFile: join(root, 'scopes.json'),
    milestonePath: join(root, 'milestones.json'),
    rolesDir: join(root, 'roles'),
    wakeAckWaitMs: 20,
  })

  const packetTool = registrations
    .find((row) => row.owner === 'lead-a' && row.definition.name === 'team_acceptance_packet')
    ?.definition
  const verifierPacketTool = registrations
    .find((row) => row.owner === 'verifier' && row.definition.name === 'team_acceptance_packet')
    ?.definition
  const rootPacketTool = registrations
    .find((row) => row.owner === 'lead' && row.definition.name === 'team_acceptance_packet')
    ?.definition
  assert.ok(packetTool && verifierPacketTool && rootPacketTool)

  const groupPacket = {
    kind: 'group-acceptance',
    task_ids: ['task-a'],
    commit_sha: commitSha,
    requirements: ['done'],
    checks: [{ name: 'focused' }],
    files: ['src/a.rs'],
  }
  const first = await packetTool.execute(groupPacket, { agent: groupLead, signal: new AbortController().signal })
  assert.equal(first.verifierWake?.target, 'verifier')
  assert.ok(['delivered', 'queued'].includes(first.verifierWake.status))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].target, 'verifier')

  const second = await packetTool.execute(groupPacket, { agent: groupLead, signal: new AbortController().signal })
  assert.notEqual(second.packetId, first.packetId)
  assert.equal(second.verifierWake?.status, 'coalesced')
  assert.equal(sent.length, 1)

  await assert.rejects(
    () => rootPacketTool.execute({
      kind: 'final-acceptance',
      task_ids: ['task-a'],
      commit_sha: commitSha,
      requirements: ['done'],
      checks: [],
      files: [],
    }, { agent: rootAgent, signal: new AbortController().signal }),
    /verifier-review-required/,
  )

  await verifierPacketTool.execute({
    kind: 'verifier-review',
    task_ids: ['task-a'],
    commit_sha: commitSha,
    requirements: ['done'],
    checks: [{ name: 'review' }],
    files: [],
    blockers: [],
  }, { agent: verifier, signal: new AbortController().signal })

  const final = await rootPacketTool.execute({
    kind: 'final-acceptance',
    task_ids: ['task-a'],
    commit_sha: commitSha,
    requirements: ['done'],
    checks: [],
    files: [],
  }, { agent: rootAgent, signal: new AbortController().signal })
  assert.equal(final.kind, 'final-acceptance')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('acceptance verifier checks passed')
