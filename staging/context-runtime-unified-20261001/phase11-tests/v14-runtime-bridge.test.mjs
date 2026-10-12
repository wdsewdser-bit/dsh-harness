import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { apply, authorizeRequirementRecord, authorizeWaitingAction, inject } from '../home/profiles/web/plugins/team-v12-runtime.mjs'

test('Team runtime declares services required by native Agent publication and completion', () => {
  for (const service of ['sessionQuery', 'sessions', 'goals', 'contextWorkspace']) assert.ok(inject.includes(service), service)
})
import { controlPlaneFor, controlPlaneForMember, readControlPlaneSnapshot, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { createWakeState, enqueueInboxMessage, requestWake } from '../home/profiles/web/plugins/team-v12-room-wake.mjs'
import { createRequirementLedger } from '../home/profiles/web/plugins/team-v14-requirements.mjs'
import { normalizePlan } from '../home/profiles/web/plugins/team-v15-plan-delivery.mjs'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { apply as applyStepCompaction } from '../home/profiles/web/plugins/step-compaction-v4.mjs'

const tempDirs = []
afterEach(() => {
  resetControlPlaneCache()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function harness({ name = 'alice', tier = 2, teamId = 'team-v14', sessionId = name + '-session', config = {}, services = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-v14-runtime-'))
  tempDirs.push(directory)
  const hooks = new Map()
  const tools = new Map()
  const messages = []
  const rolesDir = config.rolesDir ?? join(directory, 'roles')
  if (!config.rolesDir) {
    mkdirSync(rolesDir)
    const bodies = Object.fromEntries(['AGENTS.md', 'root.md', 'lead.md', 'member.md', 'verifier.md']
      .map(file => [file, 'Required fixture identity: ' + file]))
    for (const [file, body] of Object.entries(bodies)) writeFileSync(join(rolesDir, file), body)
    writeFileSync(join(rolesDir, 'identity-version.json'), JSON.stringify({ identityVersion: 'fixture-1',
      files: Object.fromEntries(Object.entries(bodies).map(([file, body]) => [file, createHash('sha256').update(body).digest('hex')])) }))
  }
  const member = { id: name, name, tier, role: tier === 0 ? 'lead' : 'teammate' }
  const session = {
    id: sessionId,
    log: [],
    get seq() { return this.log.length },
    snapshotEvents(fromSeq = 0) { return structuredClone(this.log.slice(fromSeq)) },
    deriveMessages: () => messages.slice(),
    deriveEventMessage: (event) => event.message ?? event.data ?? event,
  }
  const agent = { id: name, name, session, status: 'idle' }
  const scoped = {
    systemPrompt: {
      section: () => () => {},
      getSectionOrder: () => 0,
    },
    tools: {
      register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) },
      schemas: () => [...tools.values()].map(tool => ({ name: tool.name })),
    },
    on: (event, callback) => {
      const rows = hooks.get(event) ?? []
      rows.push(callback)
      hooks.set(event, rows)
      return () => hooks.set(event, rows.filter((row) => row !== callback))
    },
  }
  agent.ctx = scoped
  const ctxHooks = new Map()
  const projections = []
  const ctx = {
    ...services,
    get: name => Object.getOwnPropertyDescriptor(ctx, name)?.value,
    requestMessageProjection: {
      register: (_id, project, options) => {
        const registration = { ...options, project }
        projections.push(registration)
        return () => { const index = projections.indexOf(registration); if (index >= 0) projections.splice(index, 1) }
      },
      isAgentLoopRequest: options => !!options && typeof options.sessionId === 'string',
    },
    agents: { list: () => [agent] },
    agentTeams: {
      tryMembership: () => ({ ...member, id: teamId }),
      listMembers: () => [member],
    },
    on: (event, callback) => { ctxHooks.set(event, callback); return () => ctxHooks.delete(event) },
    effect: () => {},
    logger: { warn: () => {} },
    provide: (name, service) => { ctx[name] = service; return () => { if (ctx[name] === service) delete ctx[name] } },
  }
  apply(ctx, { controlDir: directory, pluginDir: directory, profile: 'web', rolesDir, ...config })
  const cp = controlPlaneForMember(ctx, agent, { directory })
  assert.ok(cp, 'runtime should resolve the Team control plane')
  return { directory, ctx, agent, session, messages, hooks, tools, cp, member, teamId,
    restartObserver: () => { ctxHooks.get('agent/disposed')({ agent }); ctxHooks.get('agent/created')({ agent }) },
    dispatch: async (message) => {
      const options = { sessionId, purpose: 'conversation', messages: [message], signal: new AbortController().signal }
      const prepared = projections.map(p => ({ p, result: p.project(options) })).filter(row => Array.isArray(row.result?.messages))
      for (const stage of ['before', 'after']) for (const { p, result } of prepared) p.validateAdapter?.({ stage, options, inputOptions: options, result })
      for (const { p, result } of prepared) await p.onDispatch?.({ inputOptions: options, options, result,
        receipt: { handedToAdapter: true, stage: 'handed-to-adapter', requestId: 'fixture-dispatch-' + session.seq } })
    },
    hook: (event) => event === 'session/event' ? async (current, raw) => {
      const data = raw.data ?? raw.message ?? (raw.type === 'compaction/end' ? { compactionId: raw.compactionId } : raw)
      const committed = { type: raw.type, seq: current.seq, time: Date.now(), data }
      current.log.push(structuredClone(committed))
      for (const callback of hooks.get(event) ?? []) await callback(current, committed)
    } : hooks.get(event)?.[0],
    seed: (type, fn) => cp.mutate(type, {}, agent, fn),
    teamTool: () => tools.get('team_v12'),
  }
}

test('registered active identity drives next-turn delivery; disk edits cannot bypass activation', async () => {
  const rolesDir = mkdtempSync(join(tmpdir(), 'dsh-runtime-roles-'))
  tempDirs.push(rolesDir)
  const writeRoles = marker => {
    const bodies = Object.fromEntries(['AGENTS.md', 'root.md', 'lead.md', 'member.md', 'verifier.md']
      .map(name => [name, name + ' identity ' + marker]))
    for (const [name, body] of Object.entries(bodies)) writeFileSync(join(rolesDir, name), body)
    writeFileSync(join(rolesDir, 'identity-version.json'), JSON.stringify({ schemaVersion: 1,
      identityVersion: 'same-version', files: Object.fromEntries(Object.entries(bodies)
        .map(([name, body]) => [name, createHash('sha256').update(body).digest('hex')])) }))
  }
  writeRoles('A')
  const h = harness({ name: 'root', tier: 0, config: { rolesDir,
    activeIdentity: { enabled: true, allowedRoots: [rolesDir] } } })
  const tool = h.teamTool(), exec = execFor(h, 'team_v12'), pre = h.hook('agent/pre-step')
  assert.ok(tool.parameters.properties.action.enum.includes('identity_activate'))
  const missing = await pre({ agent: h.agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(missing.kind, 'reject')
  assert.match(missing.reason, /ACTIVE_IDENTITY_NOT_SET/)
  const proposal = await tool.execute({ action: 'identity_proposal' }, exec)
  assert.equal(h.ctx.teamIdentityRuntime.proposal(h.agent).contentHash, proposal.contentHash)
  const activate = async expectedBundleHash => tool.execute({ action: 'identity_activate', input: {
    expectedControlRevision: h.cp.snapshot().revision, expectedIdentityEpoch: h.cp.snapshot().identityEpoch ?? 0,
    expectedBundleHash,
  } }, exec)
  await activate(proposal.contentHash)
  const first = await pre({ agent: h.agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  assert.ok(JSON.stringify(first.messages).includes('root.md identity A'))
  h.messages.push(...first.messages)
  writeRoles('B')
  const repeat = await pre({ agent: h.agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  assert.ok(!JSON.stringify(repeat.messages).includes('root.md identity B'))
  const before = h.cp.snapshot().identityEpoch
  await assert.rejects(activate(proposal.contentHash), /IDENTITY_PROPOSAL_STALE/)
  assert.equal(h.cp.snapshot().identityEpoch, before)
  await activate((await tool.execute({ action: 'identity_proposal' }, exec)).contentHash)
  const second = await pre({ agent: h.agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  assert.ok(JSON.stringify(second.messages).includes('root.md identity B'))
  const facts = h.ctx.teamWindowRuntime.facts(h.agent)
  assert.equal(facts.loaded.binding.identity.metadata.identityEpoch, 2)
  assert.equal(h.ctx.teamIdentityRuntime.status(h.agent).epoch, 2)
  assert.ok(facts.loaded.coveredDomains.includes('identity'))
  assert.equal(facts.liveEnabled, false)
  assert.ok(!facts.loaded.externalWriters.some(reason => reason.includes('roles/')))
  const foreign = { ...h.agent }
  await assert.rejects(tool.execute({ action: 'identity_activate', input: {
    expectedControlRevision: h.cp.snapshot().revision, expectedIdentityEpoch: 2,
    expectedBundleHash: facts.loaded.binding.identity.metadata.contentHash,
  } }, { ...exec, agent: foreign }), /IDENTITY_ACTOR_UNRESOLVED/)
})

test('registered hypothesis binding uses durable current plan and membership, leaving ordinary tool arguments unchanged', async () => {
  const roots = []
  const h = harness({ name: 'root', tier: 0, config: { planReadRoots: roots, hypothesis: { enabled: true } } })
  roots.push(h.directory)
  const source = { kind: 'dsh-plan-contract', version: 1, planId: 'hypothesis-plan', scope: ['source.mjs'],
    items: [{ requirementId: 'req-1', taskRefs: [{ boardId: 'global', taskId: 't' }] }] }
  const body = JSON.stringify(source, null, 2), path = join(h.directory, 'hypothesis-plan.json')
  writeFileSync(path, body)
  await h.seed('test/hypothesis-task', state => {
    state.boards = { global: { tasks: { t: { id: 't', revision: 1, ownerName: 'root', contract: { contractRevision: 1 } } } } }
    state.leases = { l1: { member: 'root', taskId: 't', contractRevision: 1, status: 'active', expiresAt: Date.now() + 60000 } }
  })
  await h.cp.flush()
  const tool = h.teamTool(), exec = execFor(h, 'team_v12')
  const registered = await tool.execute({ action: 'plan_register', input: { planId: source.planId, expectedPlanRevision: 0,
    ref: { path, sha256: createHash('sha256').update(body).digest('hex') } } }, exec)
  h.tools.set('probe', { name: 'probe' })
  const input = { planId: source.planId, expectedPlanRevision: 1, expectedPlanHash: registered.plan.planHash,
    boardId: 'global', taskId: 't', expectedTaskRevision: 1, expectedContractRevision: 1, expectedGeneration: 0,
    toolName: 'probe', requirementId: 'req-1', hypothesisId: 'parser-boundary', failureCause: 'parser boundary',
    hypothesis: 'The parser rejects the documented field.', probe: { kind: 'standard', method: 'minimal-case' } }
  const bound = await tool.execute({ action: 'hypothesis_bind', input }, exec)
  assert.equal(bound.durable, true)
  assert.equal(bound.generation, 1)
  assert.ok(tool.parameters.properties.action.enum.includes('hypothesis_bind'))
  await assert.rejects(tool.execute({ action: 'hypothesis_bind', input }, exec), /HYPOTHESIS_INTENT_CAS_CONFLICT/)
  const call = { callId: 'probe-1', name: 'probe', agent: h.agent, arguments: { command: 'minimal' } }
  for (const hook of h.hooks.get('tools/pre-execute')) await hook(call, async () => ({ kind: 'allow' }))
  const observations = h.hooks.get('tools/result') ?? []
  assert.ok(observations.length > 0)
  for (const observe of observations) await observe(call, { isError: false })
  assert.deepEqual(call.arguments, { command: 'minimal' })
  const status = await tool.execute({ action: 'hypothesis_status' }, exec)
  assert.equal(status.records[0].spec.requirementId, 'req-1')
  assert.equal(status.records[0].spec.hypothesisId, 'parser-boundary')
  const cleared = await tool.execute({ action: 'hypothesis_clear', input: { toolName: 'probe', expectedGeneration: 1,
    reason: 'probe replaced' } }, exec)
  assert.equal(cleared.generation, 2)
  assert.equal(cleared.status, 'cleared')
})

test('actual Team runtime binds the current goal durably through the loaded service gate and exposes recovery', async () => {
  const roots = [], gates = []
  const goal = { id: 'canonical-goal', revision: 1, phase: 'active', objective: 'Complete the registered fixture plan' }
  const h = harness({ tier: 0, config: { planReadRoots: roots }, services: {
    goals: { get: () => goal, registerCompletionGate: (_agent, gate) => { gates.push(gate); return () => {} } },
    sessions: { flush: async () => true },
  } })
  h.session.log = []
  h.session.append = (type, data) => {
    const event = { seq: h.session.log.length, type, data: structuredClone(data) }
    h.session.log.push(event)
    return event
  }
  roots.push(h.directory)
  const source = { kind: 'dsh-plan-contract', version: 1, planId: 'full-goal-plan', scope: ['src'],
    items: [{ requirementId: 'r1', taskRefs: [{ boardId: 'global', taskId: 't1' }] }] }
  const path = join(h.directory, 'goal-plan.json'), body = JSON.stringify(source, null, 2)
  writeFileSync(path, body)
  const tool = h.teamTool(), exec = execFor(h, 'team_v12')
  await tool.execute({ action: 'plan_register', input: { planId: source.planId, expectedPlanRevision: 0,
    ref: { path, sha256: createHash('sha256').update(body).digest('hex') } } }, exec)
  assert.equal(gates.length, 1)
  assert.equal(gates[0].isBound(h.agent), true)
  const bound = await tool.execute({ action: 'goal_plan_bind', input: { planId: source.planId,
    expectedGoalId: goal.id, expectedGoalRevision: 1 } }, exec)
  assert.equal(bound.durable, true)
  assert.equal(h.session.log.filter(event => event.type === 'native/delivery-required').length, 1)
  assert.equal(h.cp.snapshot().v15GoalBindings[h.session.id][goal.id].planId, source.planId)
  await assert.rejects(tool.execute({ action: 'goal_plan_bind', input: { planId: source.planId,
    expectedGoalId: goal.id, expectedGoalRevision: 2 } }, exec), { code: 'GOAL_STALE_REVISION' })
  assert.deepEqual(await tool.execute({ action: 'goal_outbox_recover' }, exec), { ok: true, acknowledged: [], pending: [] })
})

test('actual Team goal binding remains root-only and refuses a loaded legacy GoalService without the bridge', async () => {
  const member = harness()
  await assert.rejects(member.teamTool().execute({ action: 'goal_plan_bind', input: {} }, execFor(member, 'team_v12')), { code: 'PLAN_DELIVERY_DENIED' })
  const root = harness({ tier: 0 })
  await assert.rejects(root.teamTool().execute({ action: 'goal_plan_bind', input: {} }, execFor(root, 'team_v12')), { code: 'GOAL_DELIVERY_BRIDGE_UNAVAILABLE' })
})

function execFor(h, name, callId = name + '-call', extra = {}) {
  return { name, callId, rootCallId: extra.rootCallId ?? callId, arguments: extra.arguments ?? {}, agent: h.agent }
}

test('registered history recall preserves exact own events and denies foreign Team scope', async () => {
  const event = { seq: 1, type: 'user/message', data: { id: 'original', text: 'exact original constraint' } }
  const h = harness({ name: 'root', tier: 0, services: { sessionQuery: {
    readEvent: async ({ sessionId }) => ({ session: { id: sessionId }, target: event, events: [event] }),
    traceEvent: async () => ({ sourceEventSeqs: [], derivedEventSeqs: [] }),
  } } })
  const tool = h.tools.get('history_recall')
  assert.ok(tool, 'the actual Team runtime must register exact recall')
  await h.seed('test/history-team-provisioned', () => {})
  const exec = execFor(h, 'history_recall')
  const located = await tool.execute({ action: 'locate', seq: 1 }, exec)
  const descriptor = located.descriptor
  const page = await tool.execute({ action: 'read', locator: descriptor.locator,
    expectedRevision: descriptor.sourceRef.sourceRevision, expectedSourceHash: descriptor.sourceRef.sourceHash, offset: 0 }, exec)
  assert.equal(page.complete, true)
  assert.deepEqual(JSON.parse(Buffer.from(page.dataBase64, 'base64').toString('utf8')).target, event)
  const foreign = { session: { id: 'foreign-session' } }
  h.ctx.agents.list = () => [h.agent, foreign]
  h.ctx.agentTeams.tryMembership = target => ({ name: 'root', tier: 0, id: target === foreign ? 'other-team' : h.teamId })
  await assert.rejects(tool.execute({ action: 'locate', sessionId: foreign.session.id, seq: 1 }, exec), { code: 'HISTORY_SCOPE_DENIED' })
  assert.equal(h.cp.snapshot().v15HistoryRecall.reads[descriptor.locator].receipt.modelConsumption, 'unknown')
})

test('actual registered delivery preview uses runtime-owned debt, never a policy function claiming no blockers', async () => {
  const roots = [], policy = { allowedRoots: roots, collectAuthorityDebt: () => ({ unresolvedDebt: [], blockers: [] }) }
  const h = harness({ name: 'root', tier: 0, config: { planReadRoots: roots, deliveryPolicy: policy } })
  roots.push(h.directory)
  h.session.log = []
  h.agent.inbox = { nextStep: [], nextTurn: [] }
  const ref = (name, body) => {
    const path = join(h.directory, name); writeFileSync(path, body)
    return { path, sha256: createHash('sha256').update(body).digest('hex') }
  }
  const source = { kind: 'dsh-plan-contract', version: 1, planId: 'runtime-debt', scope: ['source.mjs'],
    items: [{ requirementId: 'r', taskRefs: [{ boardId: 'global', taskId: 't' }], implementationRefs: ['impl'] }] }
  const planRef = ref('plan.json', JSON.stringify(source, null, 2))
  ref('source.mjs', 'export const source = true')
  Object.assign(policy, { workspaceRoot: h.directory, environmentRefs: [ref('env.json', '{"version":1}')],
    recipeRef: ref('recipe.json', '{"command":"node --test"}') })
  await h.seed('test/debt-task', state => {
    state.boards = { global: { tasks: { t: { id: 't', revision: 1, ownerName: 'root', contract: { contractRevision: 1 } } } } }
  })
  const tool = h.teamTool(), exec = execFor(h, 'team_v12')
  await tool.execute({ action: 'plan_register', input: { planId: source.planId, expectedPlanRevision: 0, ref: planRef } }, exec)
  const preview = () => tool.execute({ action: 'plan_delivery_preview', input: { planId: source.planId,
    unresolvedDebt: [], blockers: [], milestoneSnapshot: { version: 3, teams: {} } } }, exec)
  Object.defineProperty(h.ctx, 'stepCompactionRuntime', { configurable: true,
    get() { throw new Error('cannot get property "stepCompactionRuntime" without inject') } })
  await assert.rejects(preview(), { code: 'DELIVERY_DEBT_SOURCE_UNAVAILABLE' })
  policy.milestonePath = join(h.directory, 'milestones.json')
  writeFileSync(policy.milestonePath, JSON.stringify({ version: 3, teams: { [h.teamId]: { compactions: {} } } }))
  await assert.rejects(preview(), { code: 'DELIVERY_MILESTONE_RUNTIME_UNAVAILABLE' })
  delete h.ctx.stepCompactionRuntime
  const stopMilestones = applyStepCompaction(h.ctx, { milestonePath: policy.milestonePath })
  const originalMilestonePath = policy.milestonePath
  policy.milestonePath = ref('alternate-milestones.json', JSON.stringify({ version: 3, teams: {} })).path
  await assert.rejects(preview(), { code: 'DELIVERY_MILESTONE_RUNTIME_UNVERIFIED' })
  policy.milestonePath = originalMilestonePath
  const clean = await preview()
  assert.equal(clean.complete, false, 'missing test/enablement proofs must still refuse completion')
  assert.ok(!clean.globalBlockers.includes('unresolved-debt-or-blockers'))
  await h.seed('test/history-body-debt', state => {
    state.v15HistoryRecall = { debts: { raw: { id: 'raw', readerSessionId: h.session.id,
      status: 'returned-awaiting-dispatch', sourceRef: { sessionId: h.session.id, sourceHash: 'original' } } } }
  })
  await h.cp.flush()
  const recalled = await preview()
  assert.ok(recalled.globalBlockers.includes('unresolved-debt-or-blockers'))
  assert.notEqual(recalled.sourceRevisionVector.contextHash, clean.sourceRevisionVector.contextHash)
  await h.seed('test/history-body-source-changed', state => { state.v15HistoryRecall.debts.raw.sourceRef.sourceHash = 'changed' })
  await h.cp.flush()
  const changedRecall = await preview()
  assert.ok(changedRecall.globalBlockers.includes('unresolved-debt-or-blockers'))
  assert.notEqual(changedRecall.sourceRevisionVector.contextHash, recalled.sourceRevisionVector.contextHash)
  await h.seed('test/history-fixture-reset', state => { state.v15HistoryRecall.debts = {} })
  await h.cp.flush()
  h.agent.inbox.nextStep.push({ id: 'new-user-correction' })
  const pending = await preview()
  assert.ok(pending.globalBlockers.includes('unresolved-debt-or-blockers'))
  assert.notEqual(pending.sourceRevisionVector.contextHash, clean.sourceRevisionVector.contextHash)
  const request = value => ({ planId: source.planId, idempotencyKey: 'debt-cas', expectedPlanRevision: value.planRevision,
    expectedPlanHash: value.planHash, sourceIdentity: value.sourceIdentity, coverageMatrixHash: value.coverageMatrixHash,
    sourceRevisionVector: value.sourceRevisionVector })
  await assert.rejects(tool.execute({ action: 'plan_delivery_commit', input: request(clean) }, exec), { code: 'DELIVERY_CAS_CONFLICT' })
  await assert.rejects(tool.execute({ action: 'plan_delivery_commit', input: request(pending) }, exec), { code: 'DELIVERY_INCOMPLETE' })
  assert.deepEqual(h.cp.snapshot().v15PlanDelivery.receipts, {}, 'refused debt must not create a canonical accepted receipt')
  h.agent.inbox.nextStep.length = 0
  writeFileSync(policy.milestonePath, '{broken')
  await assert.rejects(preview(), { code: 'DELIVERY_DEBT_SOURCE_UNAVAILABLE' })
  writeFileSync(policy.milestonePath, JSON.stringify({ version: 3, teams: { [h.teamId]: { compactions: {} } } }))
  await h.seed('test/implementation-authority', state => {
    state.boards.global.tasks.t.contract.writeScopes = ['source.mjs']
    state.leases.live = { member: 'root', taskId: 't', status: 'active', contractRevision: 1, expiresAt: Date.now() + 60000 }
  })
  // The producer cannot invent a slot or edit the canonical plan itself.
  await assert.rejects(tool.execute({ action: 'implementation_prove', input: { planId: source.planId,
    expectedPlanRevision: 1, expectedPlanHash: clean.planHash, requirementId: 'r', boardId: 'global', taskId: 't',
    expectedTaskRevision: 1, expectedContractRevision: 1, proofRef: 'invented', locator: 'source.mjs' } }, exec), { code: 'IMPLEMENTATION_SLOT_DENIED' })
  const proven = await tool.execute({ action: 'implementation_prove', input: { planId: source.planId,
    expectedPlanRevision: 1, expectedPlanHash: clean.planHash, requirementId: 'r', boardId: 'global', taskId: 't',
    expectedTaskRevision: 1, expectedContractRevision: 1, proofRef: 'impl', locator: 'source.mjs' } }, exec)
  assert.equal(proven.durable, true)
  assert.deepEqual(h.cp.snapshot().v12Evidence.records.impl, proven.proof)
  assert.equal((await preview()).complete, false, 'physical implementation alone cannot prove tests, enablement or acceptance')
  stopMilestones()
  await assert.rejects(preview(), { code: 'DELIVERY_MILESTONE_RUNTIME_UNAVAILABLE' })
})
test('actual runtime exposes loaded window blockers and keeps production session opt-in closed', () => {
  const h = harness({ tier: 0 })
  const facts = h.ctx.teamWindowRuntime.facts(h.agent)
  assert.equal(facts.exactIsolatedOptIn, false)
  assert.equal(facts.liveEnabled, false)
  assert.deepEqual(facts.loaded.coveredDomains, [])
  assert.ok(facts.loaded.externalWriters.some(reason => reason.includes('identity')))
  assert.throws(() => h.ctx.teamWindowRuntime.participation(h.agent), /WINDOW_SESSION_NOT_ALLOWED/)
})

test('actual registered Team plan_register uses complete source and persists exact readback before exposing recovery', async () => {
  const roots = []
  const h = harness({ tier: 0, config: { planReadRoots: roots } })
  roots.push(h.directory)
  const path = join(h.directory, 'canonical-plan.json')
  const source = { kind: 'dsh-plan-contract', version: 1, planId: 'product', scope: ['product'],
    items: ['one', 'two'].map(requirementId => ({ requirementId, taskRefs: [{ boardId: 'global', taskId: 'task-source' }] })) }
  const body = JSON.stringify(source, null, 2)
  writeFileSync(path, body)
  await h.seed('test/tasks', state => {
    state.boards = { global: { tasks: { 'task-source': { id: 'task-source', planId: 'legacy-task-only', revision: 1,
      ownerName: 'alice', contract: { contractRevision: 1 } } } } }
  })
  const input = { planId: 'product', expectedPlanRevision: 0, ref: { path, sha256: createHash('sha256').update(body).digest('hex') } }
  const tool = h.teamTool()
  await assert.rejects(tool.execute({ action: 'plan_register', input: { ...input, items: source.items.slice(0, 1) } }, execFor(h, 'team_v12')),
    { code: 'PLAN_REGISTRATION_INPUT_INVALID' })
  const result = await tool.execute({ action: 'plan_register', input }, execFor(h, 'team_v12'))
  assert.equal(result.durable, true)
  assert.equal(result.plan.items.length, 2)
  assert.deepEqual(h.cp.snapshot().planRefReceipts[result.sourceReceipt.id], result.sourceReceipt)
  const recovered = await tool.execute({ action: 'task_contract_get', task_id: 'task-source' }, execFor(h, 'team_v12'))
  assert.equal(recovered.planRecovery.ok, true)
  assert.equal(recovered.planRecovery.planHash, result.plan.planHash)
  assert.equal(recovered.planRecovery.refs[0].sha256, input.ref.sha256)
})

test('actual Team plan registration remains root-authorized and exact read roots default closed', async () => {
  const h = harness({ tier: 2 })
  await assert.rejects(h.teamTool().execute({ action: 'plan_register', input: {} }, execFor(h, 'team_v12')), /PLAN_REGISTRATION_DENIED/)
  const root = harness({ tier: 0 })
  const path = join(root.directory, 'plan.json'), body = JSON.stringify({ kind: 'dsh-plan-contract', version: 1,
    planId: 'p', scope: ['product'], items: [{ requirementId: 'r', taskRefs: [{ boardId: 'global', taskId: 't' }] }] }, null, 2)
  writeFileSync(path, body)
  await assert.rejects(root.teamTool().execute({ action: 'plan_register', input: { planId: 'p', expectedPlanRevision: 0,
    ref: { path, sha256: createHash('sha256').update(body).digest('hex') } } }, execFor(root, 'team_v12')), { code: 'RECOVERY_PATH_DENIED' })
})

test('actual Team runtime plan_ref_get persists full read before returning and confirms only full dispatch', async () => {
  const roots = []
  const h = harness({ tier: 0, config: { planReadRoots: roots } })
  roots.push(h.directory)
  const path = join(h.directory, 'product-plan.md'), body = 'mandatory middle condition; do not touch platform plan'
  writeFileSync(path, body)
  const plan = normalizePlan({ planId: 'product', planRevision: 1, scope: ['product'],
    ref: { path, sha256: createHash('sha256').update(body).digest('hex') },
    items: [{ requirementId: 'mandatory', taskRefs: [{ boardId: 'global', taskId: 'task-doc' }] }] })
  await h.seed('test/registered-plan', state => {
    state.boards = { global: { tasks: { 'task-doc': { id: 'task-doc', revision: 1, planId: 'product', ownerName: 'alice', contract: { contractRevision: 1 } } } } }
    state.v15PlanDelivery = { plans: { product: plan } }
    return plan
  })
  const tool = h.teamTool()
  const refs = await tool.execute({ action: 'plan_refs', task_id: 'task-doc' }, execFor(h, 'team_v12'))
  assert.equal(refs.planHash, plan.planHash)
  const result = await tool.execute({ action: 'plan_ref_get', task_id: 'task-doc', input: {
    expectedPlanRevision: refs.planRevision, expectedPlanHash: refs.planHash, referenceIndex: 0,
  } }, execFor(h, 'team_v12', 'doc-call'))
  assert.equal(result.text, body)
  assert.equal(h.cp.snapshot().v15PlanReadReceipts[result.readReceipt.id].requiredFetch, true)
  await h.dispatch({ role: 'tool', toolCallId: 'doc-call', content: [{ type: 'text', text: JSON.stringify({ ...result, text: 'truncated' }) }] })
  assert.equal(h.cp.snapshot().v15PlanReadReceipts[result.readReceipt.id].requiredFetch, true)
  await h.dispatch({ role: 'tool', toolCallId: 'doc-call', content: [{ type: 'text', text: JSON.stringify(result) }] })
  assert.equal(h.cp.snapshot().v15PlanReadReceipts[result.readReceipt.id].status, 'content-fetched')
  assert.equal(h.cp.snapshot().v15PlanReadReceipts[result.readReceipt.id].requiredFetch, false)
})

async function seedWake(h, { inbox = [], roomAccess = {} } = {}) {
  return h.seed('test/seed-room-wake', (state) => {
    const doc = createWakeState()
    doc.roomAccess = roomAccess
    for (const row of inbox) enqueueInboxMessage(doc, row)
    for (const row of inbox.filter((item) => item.wakeRequested)) requestWake(doc, row)
    state.v12RoomWake = doc
    return doc
  })
}

test('post hook mirrors result.value even when next blocks and persists a compact receipt', async () => {
  const h = harness()
  const before = h.cp.snapshot().revision
  const next = async () => ({ kind: 'block', feedback: 'downstream policy' })
  const result = { isError: false, value: { taskId: 'task-1', revision: 3 }, content: [] }
  const decision = await h.hook('tools/post-execute')(execFor(h, 'team_task_update', 'call-blocked'), result, next)
  assert.equal(decision.kind, 'block')
  const state = h.cp.snapshot()
  assert.ok(state.revision > before)
  const receipt = state.v14Receipts.find((row) => row.callId === 'call-blocked')
  assert.equal(receipt.ids.taskId, 'task-1')
  assert.equal(receipt.projectionBlocked, true)
  assert.equal(receipt.mirrorStatus, 'committed')
})

test('failed original result never creates a successful mirror', async () => {
  const h = harness()
  await h.hook('tools/post-execute')(execFor(h, 'send_message', 'call-failed', { arguments: { target: 'bob', message: 'do not mirror' } }),
    { isError: true, error: { message: 'official failure' }, value: { messageId: 'm-failed' }, content: [] },
    async () => ({ kind: 'accept' }))
  const state = h.cp.snapshot()
  assert.equal(state.v12RoomWake?.inbox?.['m-failed'], undefined)
  assert.equal(state.v14Receipts.find((row) => row.callId === 'call-failed')?.isError, true)
})

test('ordinary team_v12 read does not increment control-plane revision', async () => {
  const h = harness()
  const before = h.cp.snapshot().revision
  await h.hook('tools/post-execute')(execFor(h, 'team_v12', 'read-call', { arguments: { action: 'inbox_list' } }),
    { isError: false, value: { target: 'alice', inbox: [], wakes: [] }, content: [] }, async () => ({ kind: 'accept' }))
  assert.equal(h.cp.snapshot().revision, before)
})

test('room_snapshot and inbox_list enforce caller scope and filter inbox rows', async () => {
  const h = harness({ name: 'alice', tier: 2 })
  await seedWake(h, {
    roomAccess: { room1: { members: ['alice', 'bob'], host: 'alice' } },
    inbox: [
      { messageId: 'own', target: 'alice', sender: 'bob', originalText: 'own', wakeRequested: false },
      { messageId: 'other', target: 'bob', sender: 'alice', originalText: 'other', wakeRequested: false },
    ],
  })
  const tool = h.teamTool()
  await assert.rejects(() => tool.execute({ action: 'room_snapshot', room_id: 'room1', member: 'bob', input: {} }, { agent: h.agent }), /room-read-scope/)
  const own = await tool.execute({ action: 'inbox_list', input: {} }, { agent: h.agent })
  assert.deepEqual(own.inbox.map((row) => row.messageId), ['own'])
  await assert.rejects(() => tool.execute({ action: 'inbox_list', member: 'bob', input: {} }, { agent: h.agent }), /inbox-read-scope/)
})

test('task_contract_set rejects a stale revision after the locked recheck', async () => {
  const h = harness()
  await h.cp.boardCreate({ taskId: 'task-cas', subject: 'CAS task', ownerName: 'alice' }, h.agent)
  await h.seed('test-contract', (state) => {
    const task = state.boards.global.tasks['task-cas']
    task.ownerName = 'alice'
    task.contract = { taskId: 'task-cas', owner: 'alice', subject: 'CAS task', deliverable: 'x', acceptanceCriteria: ['x'], writeScopes: ['src'], risk: { level: 'medium', rationale: 'test' } }
    return task
  })
  const tool = h.teamTool()
  const cp = h.cp
  const mutate = cp.mutate
  let raced = false
  cp.mutate = async (...args) => {
    if (!raced && args[0] === 'v12/task-contract') {
      raced = true
      await mutate.call(cp, 'test-race-owner', {}, h.agent, (state) => {
        state.boards.global.tasks['task-cas'].ownerName = 'bob'
        state.boards.global.tasks['task-cas'].revision += 1
      })
    }
    return mutate.apply(cp, args)
  }
  try {
    await assert.rejects(() => tool.execute({ action: 'task_contract_set', task_id: 'task-cas', input: {
      expected_revision: 2, owner: 'alice', subject: 'CAS task', deliverable: 'x', acceptanceCriteria: ['x'], writeScopes: ['src'], risk: { level: 'medium', rationale: 'test' },
    } }, { agent: h.agent }), /stale-revision|task-contract-scope/)
  } finally { cp.mutate = mutate }
})

test('pre-step is idempotent for 20 calls, cursor waits for session commit, and native message ids prevent duplicate body', async () => {
  const h = harness()
  const roomState = createWakeState()
  roomState.roomAccess.room1 = { members: ['alice'], host: 'alice' }
  roomState.transcripts.room1 = [{ messageId: 'room-m1', roomId: 'room1', sequence: 1, author: 'bob', content: 'room update', originalText: 'room update', revision: 1 }]
  roomState.cursors.room1 = { alice: { sequence: 0, messageIds: [], injected: [], revision: 0 } }
  roomState.inbox['in-m1'] = { messageId: 'in-m1', target: 'alice', sender: 'bob', originalText: 'wake body', status: 'queued', wakeRequested: true }
  roomState.wakes['wake-1'] = { wakeId: 'wake-1', target: 'alice', messageIds: ['in-m1'], status: 'queued', updatedAt: 1 }
  await h.seed('test-pre-step', (state) => { state.v12RoomWake = roomState; return roomState })
  const pre = h.hook('agent/pre-step')
  const first = await pre({ agent: h.agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  assert.ok(first.messages?.length >= 1)
  const beforeCommit = h.cp.snapshot().v12RoomWake.cursors.room1.alice
  for (let i = 0; i < 20; i += 1) {
    const repeat = await pre({ agent: h.agent, messages: [] }, async () => ({ kind: 'enter', messages: first.messages }))
    assert.deepEqual(repeat.messages ?? [], first.messages, 'same manifest must not append a replay')
  }
  assert.deepEqual(h.cp.snapshot().v12RoomWake.cursors.room1.alice, beforeCommit)
  await h.hook('session/event')(h.session, { type: 'user/message', message: first.messages[0] })
  assert.ok(h.cp.snapshot().v12RoomWake.cursors.room1.alice.sequence >= 1)

  h.messages.length = 0
  h.messages.push({ source: { kind: 'team-message' }, content: [{ type: 'text', text: '[team message id=in-m1] wake body' }] })
  const native = await pre({ agent: h.agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  const text = JSON.stringify(native.messages ?? [])
  assert.equal(text.includes('wake body'), false)
})

test('pre-step deduplicates a committed context manifest when no inbox is pending', async () => {
  const h = harness({ tier: 1 })
  await h.seed('test-context-manifest-dedupe', (state) => {
    state.v12Requirements = createRequirementLedger()
    state.v12Requirements.requirements.req1 = {
      requirementId: 'req1',
      text: 'manifest dedupe requirement',
      quote: 'manifest dedupe requirement',
      scope: '',
      taskIds: [],
      acceptance: [],
      status: 'active',
      revision: 1,
    }
    state.v12Requirements.revision = 1
    return state.v12Requirements
  })
  const pre = h.hook('agent/pre-step')
  const first = await pre({ agent: h.agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(first.messages?.length, 1)
  assert.equal(JSON.stringify(first.messages).includes('[team v14 context manifest]'), true)

  h.messages.push(first.messages[0])
  const repeat = await pre({ agent: h.agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  assert.deepEqual(repeat.messages ?? [], [])
})

test('pre-step uses the durable receipt after the visible manifest leaves history', async () => {
  const h = harness({ tier: 1 })
  await h.seed('test-context-durable-cursor', (state) => {
    state.v12Requirements = createRequirementLedger()
    state.v12Requirements.requirements.req1 = {
      requirementId: 'req1',
      text: 'durable cursor requirement',
      quote: 'durable cursor requirement',
      scope: '',
      taskIds: [],
      acceptance: [],
      status: 'active',
      revision: 1,
    }
    state.v12Requirements.revision = 1
    return state.v12Requirements
  })
  const pre = h.hook('agent/pre-step')
  const first = await pre({ agent: h.agent, messages: [], step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(first.messages?.length, 1)
  await h.hook('session/event')(h.session, { type: 'user/message', message: first.messages[0] })
  assert.deepEqual(h.cp.snapshot().v14DeliveryReceipts[0].items.map(row => row.id), ['identity:alice', 'requirement:req1'])
  assert.equal(h.cp.snapshot().v12RoomWake.contextCursors?.['alice-session::alice'], undefined)
  await h.dispatch(first.messages[0])
  assert.equal(h.cp.snapshot().v12RoomWake.contextCursors['alice-session::alice'].versions['requirement:req1'].length, 64)

  h.messages.length = 0
  await h.seed('test-drop-bounded-receipts', (state) => {
    state.v14DeliveryReceipts = []
    return state.v12RoomWake.contextCursors
  })
  const repeat = await pre({ agent: h.agent, messages: [], step: 2 }, async () => ({ kind: 'enter', messages: [] }))
  assert.deepEqual(repeat.messages ?? [], [])
})

test('post-compaction baseline reinjects a bounded root context once', async () => {
  const h = harness({ tier: 1 })
  await h.seed('test-context-compaction-baseline', (state) => {
    state.v12Requirements = createRequirementLedger()
    state.v12Requirements.requirements.req1 = {
      requirementId: 'req1',
      text: 'baseline requirement',
      quote: 'baseline requirement',
      scope: '',
      taskIds: [],
      acceptance: [],
      status: 'active',
      revision: 1,
    }
    state.v12Requirements.revision = 1
    return state.v12Requirements
  })
  const pre = h.hook('agent/pre-step')
  const first = await pre({ agent: h.agent, messages: [], step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  await h.hook('session/event')(h.session, { type: 'user/message', message: first.messages[0] })
  await h.dispatch(first.messages[0])
  await h.hook('session/event')(h.session, { type: 'compaction/end', compactionId: 'compact-1' })
  h.messages.length = 0
  const baseline = await pre({ agent: h.agent, messages: [], step: 9 }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(JSON.stringify(baseline.messages ?? []).includes('baseline requirement'), true)
  await h.hook('session/event')(h.session, { type: 'user/message', message: baseline.messages[0] })
  await h.dispatch(baseline.messages[0])
  h.messages.length = 0
  const settled = await pre({ agent: h.agent, messages: [], step: 10 }, async () => ({ kind: 'enter', messages: [] }))
  assert.deepEqual(settled.messages ?? [], [])
})

test('tier 0 context keeps only active relevant requirements and compact acceptance', async () => {
  const h = harness({ name: 'lead', tier: 0, config: { contextPackMaxTokens: 32000, tier0ContextPackMaxTokens: 900 } })
  const longAcceptance = 'acceptance '.repeat(400)
  await h.seed('test-root-context-budget', (state) => {
    state.boards = {
      global: {
        tasks: {
          active: {
            id: 'active', taskId: 'active', subject: 'active task', status: 'in_progress', phase: 'execution',
            lifecycle: 'running', ownerName: 'lead', revision: 2,
            contract: { owner: 'lead', deliverable: 'root result', acceptanceCriteria: [longAcceptance], writeScopes: ['reports'] },
          },
          done: {
            id: 'done', taskId: 'done', subject: 'done task', status: 'completed', lifecycle: 'completed',
            ownerName: 'member-a', revision: 3, contract: { owner: 'member-a', acceptanceCriteria: ['done'] },
          },
        },
      },
    }
    state.v12Requirements = createRequirementLedger()
    state.v12Requirements.requirements.active = {
      requirementId: 'active', text: 'root active requirement', quote: 'root active requirement',
      scope: '', taskIds: ['active'], acceptance: [longAcceptance], status: 'active', revision: 2,
    }
    state.v12Requirements.requirements.done = {
      requirementId: 'done', text: 'completed requirement must not enter root context',
      quote: 'completed requirement must not enter root context', scope: '', taskIds: ['done'],
      acceptance: [], status: 'completed', revision: 1,
    }
    state.v12Requirements.revision = 2
    return state
  })
  const decision = await h.hook('agent/pre-step')({ agent: h.agent, messages: [], step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  const body = JSON.stringify(decision.messages ?? [])
  assert.equal(body.includes('root active requirement'), true)
  assert.equal(body.includes('completed requirement must not enter root context'), false)
  assert.equal(body.includes('acceptanceSummary'), true)
  assert.equal(body.includes(longAcceptance), false)
  assert.ok(body.length < 12000, 'root context body should stay bounded: ' + body.length)
})

test('cold window epoch recovery accepts its own history receipt but rejects changed required source state before dispatch', async () => {
  const h = harness({ tier: 1 })
  await h.seed('test-cold-window-required-source', state => {
    state.v12Requirements = createRequirementLedger()
    state.v12Requirements.requirements.req1 = {
      requirementId: 'req1', text: 'keep the original constraint', quote: 'keep the original constraint',
      scope: '', taskIds: [], acceptance: [], status: 'active', revision: 1,
    }
  })
  // The listener did not run: only the committed native log can restore this epoch.
  h.session.log.push({ type: 'user/message', seq: 0, time: Date.now(),
    data: { id: 'cold-checkpoint', source: { kind: 'team-message', windowCommit: { transitionId: 'cold' } },
      content: [{ type: 'text', text: 'window checkpoint' }] } })
  const pre = h.hook('agent/pre-step')
  const first = await pre({ agent: h.agent, messages: [], step: 9 }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(first.kind, 'enter')
  assert.equal(h.cp.snapshot().v12RoomWake.contextEpochs[h.session.id].compactionId, 'window:cold')
  await h.hook('session/event')(h.session, { type: 'user/message', message: first.messages[0] })
  assert.equal(h.cp.snapshot().v12RoomWake.contextCursors?.['alice-session::alice'], undefined)
  // Same recorded revision, different required body: stale source binding must still refuse.
  await h.seed('test-required-body-changed', state => { state.v12Requirements.requirements.req1.text = 'updated exact constraint' })
  await assert.rejects(h.dispatch(first.messages[0]), { code: 'TEAM_CONTEXT_BASELINE_DEBT' })
  assert.equal(h.cp.snapshot().v12RoomWake.contextCursors?.['alice-session::alice'], undefined)
  const current = await pre({ agent: h.agent, messages: [], step: 10 }, async () => ({ kind: 'enter', messages: [] }))
  assert.ok(JSON.stringify(current.messages).includes('updated exact constraint'))
  await h.hook('session/event')(h.session, { type: 'user/message', message: current.messages[0] })
  await h.dispatch(current.messages[0])
  const cursor = h.cp.snapshot().v12RoomWake.contextCursors['alice-session::alice']
  assert.equal(cursor.baselineId, 'window:cold')
  assert.deepEqual(cursor.baselineProof.required.map(row => row.id), ['identity:alice', 'requirement:req1'])
})

test('failed durable readback cannot be cleared by a retry that finds only a hot dispatch receipt', async () => {
  const h = harness({ tier: 1 })
  h.session.log.push({ type: 'user/message', seq: 0, time: Date.now(), data: {
    id: 'readback-checkpoint', source: { kind: 'team-message', windowCommit: { transitionId: 'readback' } },
    content: [{ type: 'text', text: 'checkpoint' }],
  } })
  const pre = h.hook('agent/pre-step')
  const first = await pre({ agent: h.agent, messages: [], step: 9 }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(first.kind, 'enter')
  const originalMutate = h.cp.mutateHot, originalFile = h.cp.file
  const shadowFile = join(h.directory, 'failed-readback.json')
  let receiptMutations = 0
  h.cp.mutateHot = (type, data, actor, fn, options) => {
    if (type !== 'v14/delivery-receipt' || !options?.afterDurable) return originalMutate(type, data, actor, fn, options)
    receiptMutations++
    return originalMutate(type, data, actor, fn, { ...options, afterDurable: (result, durable) => {
      const failedReadback = { ...durable, coldHistory: undefined, v12ColdRefs: undefined, v12RequirementsRef: undefined,
        v14DeliveryReceipts: [] }
      writeFileSync(shadowFile, JSON.stringify(failedReadback))
      h.cp.file = shadowFile
      return options.afterDurable(result, failedReadback)
    } })
  }
  try {
    await assert.rejects(h.dispatch(first.messages[0]), /durable readback failed/)
    assert.equal(h.cp.view({ history: false }).v14DeliveryReceipts.filter(row => row.dispatch).length, 1)
    const retry = await pre({ agent: h.agent, messages: [], step: 10 }, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(retry.kind, 'reject')
    assert.match(retry.reason, /durable readback failed/)
    assert.equal(receiptMutations, 1, 'retry must re-read durability rather than replay the receipt mutation')
    // Restoring the real durable store permits the bounded third attempt to clear debt.
    h.cp.file = originalFile
    const restored = await pre({ agent: h.agent, messages: [], step: 11 }, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(restored.kind, 'enter')
    assert.deepEqual(restored.messages, [])
    assert.equal(readControlPlaneSnapshot(originalFile).v12RoomWake.contextCursors['alice-session::alice'].baselineId, 'window:readback')
    assert.equal(receiptMutations, 1)
  } finally {
    h.cp.file = originalFile
    h.cp.mutateHot = originalMutate
  }
})

test('cold observer reconfirms an exact durable older manifest without rolling back upgraded optional coverage', async () => {
  const h = harness({ tier: 1 })
  await h.seed('test-optional-version-one', state => {
    state.v12RoomWake = createWakeState()
    state.v12RoomWake.inbox.optional = { messageId: 'optional', target: 'alice', sender: 'bob',
      originalText: 'optional version one', status: 'queued', wakeRequested: false }
  })
  h.session.log.push({ type: 'user/message', seq: 0, time: Date.now(), data: {
    source: { kind: 'team-message', windowCommit: { transitionId: 'optional' } }, content: [{ type: 'text', text: 'checkpoint' }],
  } })
  const pre = h.hook('agent/pre-step')
  const first = await pre({ agent: h.agent, messages: [], step: 9 }, async () => ({ kind: 'enter', messages: [] }))
  await h.hook('session/event')(h.session, { type: 'user/message', message: first.messages[0] })
  await h.dispatch(first.messages[0])
  const key = 'alice-session::alice'
  const originalHash = h.cp.view({ history: false }).v12RoomWake.contextCursors[key].versions['inbox:optional']
  await h.seed('test-optional-version-two', state => { state.v12RoomWake.inbox.optional.originalText = 'optional version two' })
  const second = await pre({ agent: h.agent, messages: [], step: 10 }, async () => ({ kind: 'enter', messages: [] }))
  assert.ok(JSON.stringify(second.messages).includes('optional version two'))
  await h.hook('session/event')(h.session, { type: 'user/message', message: second.messages[0] })
  await h.dispatch(second.messages[0])
  const currentHash = h.cp.view({ history: false }).v12RoomWake.contextCursors[key].versions['inbox:optional']
  assert.notEqual(currentHash, originalHash)
  h.restartObserver()
  const recovered = await h.hook('agent/pre-step')({ agent: h.agent, messages: [], step: 11 }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(recovered.kind, 'enter')
  await assert.doesNotReject(h.dispatch(first.messages[0]))
  assert.equal(readControlPlaneSnapshot(h.cp.file).v12RoomWake.contextCursors[key].versions['inbox:optional'], currentHash)
  assert.equal(h.cp.view({ history: false }).v12RoomWake.contextCursors[key].baselineId, 'window:optional')
})

test('new requirement is delivered without a new Room message', async () => {
  const h = harness({ tier: 1 })
  await h.seed('test-requirement', (state) => {
    state.v12Requirements = createRequirementLedger()
    state.v12Requirements.requirements.req1 = { requirementId: 'req1', text: 'new requirement', quote: 'new requirement', scope: '', taskIds: [], acceptance: [], status: 'active', revision: 1 }
    state.v12Requirements.revision = 1
    return state.v12Requirements
  })
  const decision = await h.hook('agent/pre-step')({ agent: h.agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  assert.ok(JSON.stringify(decision.messages ?? []).includes('req1'))
})

test('provider safety refusal activates a reduced Team context fallback', async () => {
  const h = harness({ name: 'alice', tier: 0 })
  await h.seed('test-provider-safety-fallback', (state) => {
    state.providerSafety = {
      alice: {
        member: 'alice',
        reason: 'content did not pass safety review',
        category: 'provider-safety',
        attempts: 1,
        requestBytes: 123456,
        requestTokens: 30864,
        contextPack: '[team-context-pack] refused full pack',
        expiresAt: Date.now() + 60_000,
        updatedAt: Date.now(),
      },
    }
    return state.providerSafety
  })
  const decision = await h.hook('agent/pre-step')({ agent: h.agent, messages: [] },
    async () => ({ kind: 'enter', messages: [] }))
  const body = JSON.stringify(decision.messages ?? [])
  assert.ok(body.includes('provider-safety-fallback'))
  assert.ok(body.includes('content did not pass safety review'))
  assert.ok(body.length < 12_000)
})

test('unexpected ready-gate read failure rejects closed', async () => {
  const h = harness()
  await h.cp.boardCreate({ taskId: 'gate-task', subject: 'gate', ownerName: 'alice' }, h.agent)
  const original = h.cp.snapshot
  const originalView = h.cp.view
  h.cp.snapshot = () => { throw new Error('unexpected read failure') }
  h.cp.view = () => { throw new Error('unexpected read failure') }
  try {
    await assert.rejects(() => h.hook('tools/pre-execute')(execFor(h, 'team_task_update', 'gate-call', {
      arguments: { action: 'claim', task_id: 'gate-task' },
    }), async () => ({ kind: 'allow' })), /task-contract-gate-unavailable/)
  } finally {
    h.cp.snapshot = original
    h.cp.view = originalView
  }
})

test('claim gate allows zero-scope discussion/review tasks without weakening edit tasks', async () => {
  const h = harness()
  await h.seed('test-readonly-claim', (state) => {
    state.boards = state.boards ?? {}
    state.boards.global = state.boards.global ?? { tasks: {} }
    for (const kind of ['discussion', 'review', 'edit']) {
      state.boards.global.tasks[kind] = {
        id: kind,
        taskId: kind,
        subject: kind,
        status: 'pending',
        lifecycle: 'proposed',
        phase: 'room-discussion',
        ownerName: 'alice',
        workKind: kind,
        writeScopes: [],
        revision: 1,
        contract: {
          schemaVersion: 2,
          contractId: kind,
          taskId: kind,
          goal: 'verify the claim gate',
          deliverable: 'claim gate result',
          kind,
          owner: 'alice',
          writeScopes: [],
          dependencies: [],
          acceptanceCriteria: [{ id: 'ac-1', text: 'claim is accepted', required: true }],
          risk: { level: 'low', rationale: 'test' },
          contractRevision: 1,
          lifecycle: 'proposed',
        },
      }
    }
    return state.boards.global.tasks
  })
  const pre = h.hook('tools/pre-execute')
  for (const kind of ['discussion', 'review']) {
    const decision = await pre(execFor(h, 'team_task_update', kind + '-claim', {
      arguments: { action: 'claim', task_id: kind },
    }), async () => ({ kind: 'allow' }))
    assert.equal(decision.kind, 'allow')
  }
  await assert.rejects(() => pre(execFor(h, 'team_task_update', 'edit-claim', {
    arguments: { action: 'claim', task_id: 'edit' },
  }), async () => ({ kind: 'allow' })), /task-contract-ready-gate|scope-required/)
})

test('waiting_set accepts an unowned task and snake_case condition alias', async () => {
  const h = harness()
  await h.seed('test-unowned-waiting', (state) => {
    state.boards = state.boards ?? {}
    state.boards.global = state.boards.global ?? { tasks: {} }
    state.boards.global.tasks.unowned = {
      id: 'unowned',
      taskId: 'unowned',
      subject: 'unowned waiting task',
      status: 'pending',
      lifecycle: 'proposed',
      writeScopes: [],
      revision: 1,
    }
    return state.boards.global.tasks.unowned
  })
  const tool = h.teamTool()
  const ticket = await tool.execute({
    action: 'waiting_set',
    task_id: 'unowned',
    input: {
      reason: 'external operator action',
      unblock_condition: { type: 'external' },
      responsible: 'operator',
    },
  }, { agent: h.agent })
  assert.equal(ticket.owner, 'alice')
  assert.equal(ticket.unblockCondition.type, 'external')
  assert.equal(h.cp.snapshot().v14Waiting.tickets[ticket.ticketId].owner, 'alice')

  const resolved = await tool.execute({
    action: 'waiting_resolve',
    task_id: 'unowned',
    input: { resolution: 'operator cleared the condition' },
  }, { agent: h.agent })
  assert.equal(resolved.status, 'resolved')
})

test('requirement record authorization keeps leads inside their own board and scope', () => {
  const tasks = [
    { board: 'group-g1', task: { id: 't1' } },
    { board: 'group-g2', task: { id: 't2' } },
    { board: 'global', task: { id: 't3' } },
  ]
  const canWriteBoard = (_name, board) => board === 'group-g1'
  assert.equal(authorizeRequirementRecord({ tier: 0, memberName: 'lead', group: 'root', input: { scope: 'global' } }).ok, true)
  assert.equal(authorizeRequirementRecord({ tier: 1, memberName: 'g1', group: 'g1', input: { taskIds: ['t1'] }, taskRows: tasks, canWriteBoard }).ok, true)
  assert.equal(authorizeRequirementRecord({ tier: 1, memberName: 'g1', group: 'g1', input: { scope: 'group-g1' }, taskRows: tasks, canWriteBoard }).ok, true)
  assert.match(authorizeRequirementRecord({ tier: 1, memberName: 'g1', group: 'g1', input: { scope: 'global' }, taskRows: tasks, canWriteBoard }).code, /scope/)
  assert.match(authorizeRequirementRecord({ tier: 1, memberName: 'g1', group: 'g1', input: { taskIds: ['t2'] }, taskRows: tasks, canWriteBoard }).code, /task-scope/)
  assert.match(authorizeRequirementRecord({ tier: 2, memberName: 'm', group: 'g1', input: { scope: 'group-g1' } }).code, /lead-or-tier-0-only/)
})

test('waiting authorization lets a group lead manage waits for its own member task', () => {
  const canWriteBoard = (_name, board) => board === 'group-g1'
  assert.equal(authorizeWaitingAction({
    tier: 1,
    memberName: 'lead-g1',
    group: 'g1',
    taskOwner: 'member-g1',
    taskBoard: 'group-g1',
    ownerGroup: 'g1',
    canWriteBoard,
  }).ok, true)
  assert.equal(authorizeWaitingAction({
    tier: 1,
    memberName: 'lead-g1',
    group: 'g1',
    taskOwner: 'member-g1',
    requestedOwner: 'member-g1',
    taskBoard: 'group-g1',
    ownerGroup: 'g1',
    canWriteBoard,
  }).ok, true)
  assert.match(authorizeWaitingAction({
    tier: 1,
    memberName: 'lead-g1',
    group: 'g1',
    taskOwner: 'member-g2',
    taskBoard: 'group-g2',
    ownerGroup: 'g2',
    canWriteBoard,
  }).code, /waiting-scope/)
  assert.match(authorizeWaitingAction({
    tier: 1,
    memberName: 'lead-g1',
    group: 'g1',
    taskOwner: 'member-g1',
    taskBoard: 'global',
    ownerGroup: 'g1',
    canWriteBoard,
  }).code, /waiting-scope/)
  assert.match(authorizeWaitingAction({
    tier: 2,
    memberName: 'member-g1',
    group: 'g1',
    taskOwner: 'member-g1-other',
    taskBoard: 'group-g1',
    ownerGroup: 'g1',
    canWriteBoard,
  }).code, /waiting-scope/)
  assert.equal(authorizeWaitingAction({
    tier: 2,
    memberName: 'member-g1',
    group: 'g1',
    taskOwner: '',
    requestedOwner: 'member-g1',
    taskBoard: 'group-g1',
    canWriteBoard,
  }).ok, true)
  assert.equal(authorizeWaitingAction({
    tier: 0,
    memberName: 'root',
    group: 'root',
    taskOwner: 'member-g2',
    taskBoard: 'global',
    ownerGroup: 'g2',
  }).ok, true)
})
