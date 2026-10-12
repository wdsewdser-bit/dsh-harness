import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as policyModule from '../home/profiles/web/plugins/team-policy.mjs'
import * as toolsModule from '../home/profiles/web/plugins/team-tools-v2-r10.mjs'
import { resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { registerDeliveryService } from '../home/profiles/web/plugins/team-v15-delivery-service.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'unified-team-gate-')), registrations = []
  const agent = { name: 'lead', ctx: { systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
    tools: { register: definition => { registrations.push(definition); return () => {} } } } }
  const membership = { id: 'gate-' + randomUUID(), name: 'lead', role: 'lead', root: agent }
  const ctx = { agents: { list: () => [agent] }, agentTeams: {
    tryMembership: () => membership, membership: () => membership,
    listMembers: () => [{ ...membership, status: 'idle', diagnostics: [] }],
    listTasks: () => [], getTask: () => ({}), updateTask: async () => ({}), waitForChange: async () => ({ timedOut: true }),
  }, logger: { warn: () => {} }, on: () => {}, effect: () => {} }
  const controlDir = join(root, 'control')
  policyModule.apply(ctx, { controlDir })
  toolsModule.apply(ctx, { controlDir, scopesFile: join(root, 'scopes.json'), reportDir: join(root, 'reports'),
    milestonePath: join(root, 'milestones.json'), clearanceFile: join(root, 'clearance.json'), healthPath: join(root, 'health.json'), rolesDir: join(root, 'roles') })
  const policy = policyModule.policyFor(policyModule.teamKeyOf(ctx, agent))
  t.after(() => { resetControlPlaneCache(); rmSync(root, { recursive: true, force: true }) })
  return { ctx, agent, control: policy.control, tool: registrations.find(tool => tool.name === 'team_delivery_check') }
}

test('actual old Team gate keeps legacy clean-board behavior but cannot lose a registered full plan', async t => {
  const f = fixture(t)
  const legacy = await f.tool.execute({}, { agent: f.agent })
  assert.equal(legacy.deliverable, true)
  await f.control.mutateHot('fixture/mandatory-plan', {}, f.agent, state => {
    state.v15PlanDelivery = { plans: { full: { items: Array(10).fill({ mandatory: true }) } } }
  }, { deferMs: 0 })
  const guarded = await f.tool.execute({}, { agent: f.agent })
  assert.equal(guarded.deliverable, false)
  assert.equal(guarded.blockers.some(row => row.kind === 'plan-coverage' && row.code === 'DELIVERY_SERVICE_UNAVAILABLE'), true)
  assert.equal(guarded.planCoverage.length, 1)
})

test('actual Team check fails closed for durable strict policy with no registered plan or service', async t => {
  const f = fixture(t)
  f.agent.session = { id: 'strict-root', log: [{ type: 'native/goal-policy-required', data: {
    version: 1, sessionId: 'strict-root', policy: 'delivery', requiresPlan: true } }] }
  const result = await f.tool.execute({}, { agent: f.agent })
  assert.equal(result.deliverable, false)
  assert.deepEqual(result.planCoverage, [])
  assert.equal(result.blockers.some(row => row.kind === 'plan-coverage' && row.code === 'DELIVERY_PLAN_REQUIRED'), true)
})

test('actual Team gate consumes the shared server verdict, never a complete-card or packet assertion', async t => {
  const f = fixture(t)
  let deliverable = false
  const dispose = registerDeliveryService({}, f.agent, { checkAll: () => ({ required: true, deliverable,
    plans: [{ planId: 'full', deliverable, code: deliverable ? null : 'DELIVERY_INCOMPLETE', remainingScope: deliverable ? [] : ['r7', 'r8', 'r9', 'r10'] }] }) })
  t.after(dispose)
  const result = await f.tool.execute({}, { agent: f.agent })
  assert.equal(result.deliverable, false)
  assert.deepEqual(result.blockers.find(row => row.kind === 'plan-coverage').remainingScope, ['r7', 'r8', 'r9', 'r10'])
  deliverable = true
  assert.equal((await f.tool.execute({}, { agent: f.agent })).deliverable, true)
})

// The tool's output schema forbids undeclared properties, and the host validates every result against it. A field
// added to the result but not to the schema passes every direct call here and fails every real call.
test('every field the delivery check returns is declared in its output schema', async t => {
  const f = fixture(t)
  const result = await f.tool.execute({}, { agent: f.agent })
  const declared = new Set(Object.keys(f.tool.output.schema.properties))
  assert.deepEqual(Object.keys(result).filter(key => !declared.has(key)), [])
  assert.equal(result.requirementCoverage.requirementCompleteness, 'unknown')
})
