#!/usr/bin/env node
/** Runtime regression: team_task_update(reopen) reaches the module-scoped recovery helper. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const base = 'D:\\dsh-test\\home\\profiles\\web\\plugins\\'
const controlMod = await import(pathToFileURL(base + 'team-control-plane.mjs').href)
const policyMod = await import(pathToFileURL(base + 'team-policy.mjs').href)
const toolsMod = await import(pathToFileURL(base + 'team-tools-v2-r9.mjs').href)

const dir = mkdtempSync(join(tmpdir(), 'dsh-reopen-r9-'))
const scopesFile = join(dir, 'scopes.json')
writeFileSync(scopesFile, JSON.stringify({ byName: { lead: ['*'] }, bySession: {} }), 'utf8')

const registrations = []
const mkAgent = (name, role) => ({
  name,
  status: 'idle',
  ctx: {
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
    tools: { register: (definition) => { registrations.push({ owner: name, definition }); return () => {} } },
  },
  membership: { id: 'team-reopen', name, role, root: undefined },
})
const lead = mkAgent('lead', 'lead')
const member = mkAgent('member', 'teammate')
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
      name: agent.name,
      role: agent.membership.role,
      status: 'idle',
      id: 'team-reopen',
    })),
    getTask: (_caller, taskId) => control.boardGet('global', String(taskId)),
    updateTask: async (_caller, request) => control.boardGet('global', String(request.taskId)),
    listTasks: () => control.boardList('global'),
    waitForChange: async () => ({ timedOut: true }),
  },
  set(key, value) { this[key] = value },
  logger: { warn: () => {} },
  on: () => () => {},
  effect: () => () => {},
}

policyMod.apply(ctx, { controlDir: dir })
const teamKey = policyMod.teamKeyOf(ctx, lead)
const control = controlMod.controlPlaneFor(teamKey, { directory: dir })
await control.boardCreate({
  boardId: 'global',
  taskId: 'reopen-case',
  subject: 'reopen regression',
  description: 'seed a rejected task',
  phase: 'rejected',
  workKind: 'discussion',
})
toolsMod.apply(ctx, {
  scopesFile,
  rolesDir: join(dir, 'roles'),
  reportDir: join(dir, 'reports'),
  clearanceFile: join(dir, 'clearances.json'),
  milestonePath: join(dir, 'milestones.json'),
  controlDir: dir,
})

const definition = registrations.find((row) => row.owner === 'lead' && row.definition.name === 'team_task_update')?.definition
assert.ok(definition, 'team_task_update was not installed')
const result = await definition.execute(
  { task_id: 'reopen-case', expected_revision: 1, action: 'reopen', board: 'global' },
  { agent: lead, signal: undefined },
)
assert.equal(result.phase, 'room-discussion')
assert.equal(control.boardGet('global', 'reopen-case').phase, 'room-discussion')
console.log('PASS r9 reopen recovers a rejected task without ReferenceError')
rmSync(dir, { recursive: true, force: true })
