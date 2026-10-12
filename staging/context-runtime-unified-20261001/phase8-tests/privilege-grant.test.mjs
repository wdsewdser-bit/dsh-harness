#!/usr/bin/env node
/**
 * One-turn privilege escalation: request, tier-0 review, next-wake activation,
 * fail-closed bypass, and automatic turn-end expiry.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const base = 'D:\\dsh-test\\home\\profiles\\web\\plugins\\'
const controlMod = await import(pathToFileURL(base + 'team-control-plane.mjs').href)
const toolsMod = await import(pathToFileURL(base + 'team-tools-v2.mjs').href)
const guardMod = await import(pathToFileURL(base + 'write-scope-guard.mjs').href)
const policyMod = await import(pathToFileURL(base + 'team-policy.mjs').href)

let failed = 0
const check = (label, condition, detail) => {
  if (!condition) failed += 1
  console.log((condition ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  ' + detail))
}

const root = mkdtempSync(join(tmpdir(), 'dsh-privilege-'))
const controlDir = join(root, 'control')
const scopesFile = join(root, 'scopes.json')
writeFileSync(scopesFile, JSON.stringify({ rootDir: root, defaultDeny: true, byName: {}, bySession: {} }))
const registrations = []

const mkAgent = (name, role) => ({
  name,
  ctx: {
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
    tools: { register: (definition) => { registrations.push({ owner: name, definition }); return () => {} } },
  },
  membership: { id: 'privilege-team', name, role, root: undefined },
})

const lead = mkAgent('lead', 'lead')
const groupLead = mkAgent('lead-a', 'teammate')
const member = mkAgent('m1', 'teammate')
for (const agent of [lead, groupLead, member]) agent.membership.root = lead
const memberships = new Map([[lead, lead.membership], [groupLead, groupLead.membership], [member, member.membership]])

const ctx = {
  agents: { list: () => [lead, groupLead, member] },
  agentTeams: {
    tryMembership: (agent) => memberships.get(agent),
    membership: (agent) => memberships.get(agent),
    listMembers: () => [
      { id: 'lead', name: 'lead', role: 'lead', status: 'idle', diagnostics: [] },
      { id: 'lead-a', name: 'lead-a', role: 'teammate', status: 'idle', diagnostics: [], level: 1, groupId: 'lead-a', parentName: 'lead' },
      { id: 'm1', name: 'm1', role: 'teammate', status: 'idle', diagnostics: [], level: 2, groupId: 'lead-a', parentName: 'lead-a' },
    ],
    createTask: async () => { throw new Error('not used') },
    listTasks: () => [],
    sendMessage: async () => ({ messageId: 'm' }),
    waitForChange: async () => ({ timedOut: true }),
  },
  logger: { warn: () => {}, info: () => {} },
  on: () => {},
  effect: () => {},
}

try {
  policyMod.apply(ctx, { controlDir })
  const policy = policyMod.policyFor('privilege-team')
  policy.seedRoot(lead)
  policy.put({ name: 'lead-a', tier: 1, group: 'lead-a', parent: 'lead' })
  policy.put({ name: 'm1', tier: 2, group: 'lead-a', parent: 'lead-a' })
  toolsMod.apply(ctx, { controlDir, scopesFile, rolesDir: join(root, 'roles') })
  const signal = new AbortController().signal
  const tool = (owner, name) => registrations.find((row) => row.owner === owner && row.definition.name === name)?.definition

  const requestTool = tool('m1', 'team_privilege_request')
  const reviewTool = tool('lead', 'team_privilege_review')
  const statusTool = tool('m1', 'team_privilege_status')
  const requested = await requestTool.execute({
    blocked_action: 'Set-Content -Path src/escape.txt',
    reason: 'the approved task scope is stale and the only needed write is this one file',
    evidence: ['FS_WRITE_OUT_OF_SCOPE: src/escape.txt outside active plan'],
    requested_scope: 'one file write outside the stale plan',
  }, { agent: member, signal })
  check('a member can request a one-turn bypass with reason and evidence',
    requested.status === 'pending' && requested.member === 'm1', JSON.stringify(requested))

  const reviewed = await reviewTool.execute({ request_id: requested.requestId, decision: 'approve' }, { agent: lead, signal })
  check('tier 0 can approve the request', reviewed.status === 'approved', JSON.stringify(reviewed))

  const second = await requestTool.execute({
    blocked_action: 'provider-blocked next step',
    reason: 'the provider block prevents the required verification turn',
    evidence: ['team policy refusal [provider-blocked]'],
  }, { agent: member, signal })
  let selfApproval
  try {
    await tool('m1', 'team_privilege_review').execute({ request_id: second.requestId, decision: 'approve' }, { agent: member, signal })
    selfApproval = 'allowed'
  } catch (error) {
    selfApproval = String(error?.message ?? error)
  }
  check('a requester cannot approve its own privilege request',
    /privilege-review-scope/.test(selfApproval ?? ''), selfApproval)

  const pending = await statusTool.execute({ request_id: requested.requestId }, { agent: member, signal })
  check('the approved request remains visible to its requester',
    pending[0]?.status === 'approved', JSON.stringify(pending))

  controlMod.resetControlPlaneCache()
  const cp = controlMod.controlPlaneFor('privilege-team', { directory: controlDir })
  const activated = await cp.privilegeActivate({ member: 'm1' })
  check('an approved request activates on the next wake', activated?.status === 'active', JSON.stringify(activated))

  const registrationsGuard = []
  const guardCtx = {
    agentTeams: { tryMembership: (agent) => memberships.get(agent) },
    logger: { warn: () => {} },
    on(event, listener, options) { registrationsGuard.push({ event, listener, options }) },
  }
  guardMod.apply(guardCtx, { scopesFile, controlDir, controlPlane: cp, enforce: true, defaultDeny: true })
  const writeGuard = registrationsGuard.find((row) => row.event === 'fs/write-intent').listener
  let allowed = true
  try {
    writeGuard({ displayPath: join(root, 'outside', 'x.txt'), targetKey: join(root, 'outside', 'x.txt') }, { agent: member })
  } catch (error) {
    console.log('DEBUG guard error', error?.code, error?.message, 'active=', JSON.stringify(cp.privilegeActive('m1')))
    allowed = false
  }
  check('an active grant bypasses the write-scope fail-closed gate for the turn',
    allowed, String(allowed))

  await cp.privilegeEnd({ member: 'm1', reason: 'turn ended' })
  let deniedAfterTurn = false
  try {
    writeGuard({ displayPath: join(root, 'outside', 'y.txt'), targetKey: join(root, 'outside', 'y.txt') }, { agent: member })
  } catch (error) {
    deniedAfterTurn = error?.code === 'FS_WRITE_OUT_OF_SCOPE'
  }
  check('the grant expires when the turn ends',
    deniedAfterTurn, String(deniedAfterTurn))
} catch (error) {
  failed += 1
  console.log('FAIL privilege harness: ' + String(error?.stack ?? error))
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
