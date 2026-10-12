import { isAbsolute, relative, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { controlPlaneFor, readControlPlaneSnapshot } from './team-control-plane.mjs'
import { createPlanRegistry } from './team-v15-plan-registry.mjs'
import { evaluatePlanDelivery, planDeliveryHash } from './team-v15-plan-delivery.mjs'
import { validateCompactionAnchors } from './team-v13-compaction-anchors.mjs'
import { collectDeliveryContext } from './team-v15-delivery-source.mjs'
import { createDeliveryService, deliveryServiceFor, registerDeliveryService } from './team-v15-delivery-service.mjs'
import { createImplementationProofProducer } from './team-v15-implementation-proof.mjs'
import { createExecutionProofProducer } from './team-v15-execution-proof.mjs'
import { bindGoalDeliveryPlan, createGoalDeliveryGate } from './team-v15-goal-delivery.mjs'
import { installDeliveryPresentation } from './team-v15-delivery-presentation.mjs'

export const name = 'session-plan-delivery'
export const inject = ['agents', 'sessions', 'tools', 'goals']
const fail = code => { throw Object.assign(new Error(code), { code }) }
const same = (a, b) => planDeliveryHash(a) === planDeliveryHash(b)
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)
  && !['__proto__', 'constructor', 'prototype'].includes(value)
// Compaction memory gate helpers. Ids match as whole tokens, hashes as 12-hex prefixes; never by plan path or full text.
const hex12 = value => String(value ?? '').toLowerCase().slice(0, 12)
const bounded = id => '\u0001' + id + '\u0001'
const summaryTokens = text => bounded((text.match(/[A-Za-z0-9][A-Za-z0-9._-]*/g) ?? []).map(token => token.replace(/[._-]+$/, '')).join('\u0001'))
const COMPACTION_RECOVERY = 'name the missing anchors in a new compaction summary, or call session_delivery compaction_anchor for this plan'
// Observable signal: a compaction/end without error closes the latest compaction; its compaction/summary carries the text blocks.
function latestCompaction(log) {
  const end = log.findLast(event => event.type === 'compaction/end' && !event.data?.error)
  if (!end) return null
  const summary = log.findLast(event => event.type === 'compaction/summary' && event.data?.compactionId === end.data.compactionId)
  const blocks = Array.isArray(summary?.data?.summary) ? summary.data.summary : []
  const text = blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').trim()
  return { seq: summary?.seq ?? end.seq, text }
}
// A native/tool-effect "unknown" is written for every thrown tool body. A commit that the delivery gate refused inside the locked
// mutate callback, before anything was persisted, is the only throw proven side-effect free; its callId goes to a durable ledger.
const REFUSAL_KINDS = new Set(['v15/delivery-validated'])
const refusedBeforeWrite = new WeakSet()
function inside(root, target) {
  const delta = relative(root, target)
  return !isAbsolute(delta) && delta !== '..' && !delta.startsWith('../') && !delta.startsWith('..\\')
}

// This is a session-local owner, not a synthetic Team member. Both modes use
// the same plan registry, proof producers, durable receipt and GoalService.
export async function installSessionDelivery(ctx, agent, config) {
  const session = agent.session, sessionId = session.id, owner = 'session:' + sessionId
  const root = realpathSync(config.workspaceRoot)
  const scopes = config.writeScopes
  const leaseMs = config.leaseDurationMs ?? 900000
  if (!Array.isArray(scopes) || !scopes.length || scopes.some(scope => typeof scope !== 'string' || !scope
    || !inside(root, resolve(root, scope))) || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3600000) fail('SESSION_DELIVERY_POLICY_INVALID')
  const expected = { version: 1, sessionId, policyHash: planDeliveryHash({ root, scopes,
    environmentRefs: config.environmentRefs, recipeRef: config.recipeRef, allowedRoots: config.allowedRoots }) }
  const raw = controlPlaneFor('session-' + planDeliveryHash(sessionId), { directory: config.controlDir })
  const readDurable = () => readControlPlaneSnapshot(raw.file)
  let disposed = false
  function actor() {
    if (disposed || !ctx.agents.list().includes(agent) || session.header.parentSession || session.header.delegationDepth > 0) fail('SESSION_DELIVERY_ACTOR_DENIED')
    const teams = ctx.get('agentTeams')
    if (teams && typeof teams.tryMembership !== 'function') fail('SESSION_DELIVERY_MEMBERSHIP_UNAVAILABLE')
    // Absence is allowed; lookup failure and any historical membership are not.
    if (teams?.tryMembership(agent) || session.log.some(event => event.type.startsWith('team/'))) fail('SESSION_DELIVERY_TEAM_DENIED')
  }
  function guard(state) {
    actor()
    if (!same(state.v15SessionDelivery, expected)) fail('SESSION_DELIVERY_AUTHORITY_MISMATCH')
    for (const event of session.log.filter(row => row.type === 'native/delivery-required')) {
      if (!state.v15PlanDelivery?.plans?.[event.data.planId]) fail('SESSION_DELIVERY_BINDING_UNRESOLVED')
    }
  }
  actor()
  if (deliveryServiceFor(ctx, agent)) fail('SESSION_DELIVERY_SERVICE_CONFLICT')
  await raw.mutateHot('v15/session-delivery-owned', { sessionId }, agent, state => {
    actor()
    if (state.v15SessionDelivery) guard(state)
    else {
      if (session.log.some(event => ['native/delivery-required', 'native/goal-policy-required'].includes(event.type))) fail('SESSION_DELIVERY_AUTHORITY_MISSING')
      state.v15SessionDelivery = expected
    }
  }, { deferMs: 0, afterDurable() { guard(readDurable()) } })
  const control = { mutateHot(kind, data, caller, mutate, options = {}) {
    if (caller !== agent) fail('SESSION_DELIVERY_ACTOR_DENIED')
    return raw.mutateHot(kind, data, caller, state => {
      guard(state)
      try { return mutate(state) } catch (error) {
        // Only errors thrown by the callback itself qualify; guard, lock, persist and afterDurable failures never reach this tag.
        if (REFUSAL_KINDS.has(kind) && typeof error?.code === 'string') refusedBeforeWrite.add(error)
        throw error
      }
    }, {
      ...options, afterDurable(result, locked) {
        guard(readDurable())
        return options.afterDurable?.(result, locked)
      },
    })
  } }
  function planAllowed(plan) {
    if (!safeId(plan.planId) || plan.scope.some(scope => !scopes.some(allowed => inside(resolve(root, allowed), resolve(root, scope))))) return false
    return plan.items.every(item => safeId(item.requirementId) && item.taskRefs.every(ref => ref.boardId === 'session' && safeId(ref.taskId)))
  }
  const authorize = (state, input, caller) => { guard(state); return caller === agent }
  const registry = createPlanRegistry({ control, readDurable, allowedRoots: config.allowedRoots,
    authorize: (state, plan, caller) => authorize(state, plan, caller) && planAllowed(plan) })
  function collectContext(state, plan) {
    guard(state)
    if (!planAllowed(plan)) fail('SESSION_DELIVERY_SCOPE_DENIED')
    for (const scope of plan.scope) {
      const physical = realpathSync(resolve(root, scope))
      if (!scopes.some(allowed => inside(realpathSync(resolve(root, allowed)), physical))) fail('SESSION_DELIVERY_SCOPE_DENIED')
    }
    const context = collectDeliveryContext(state, plan, { ...config, workspaceRoot: root,
      collectAuthorityDebt(durable) {
        if (!Array.isArray(agent.inbox?.nextStep) || !Array.isArray(agent.inbox?.nextTurn)) fail('DELIVERY_INPUT_STATE_UNAVAILABLE')
        const refused = durable?.v15SessionRefusedCalls ?? {}
        const unknown = session.log.filter(event => event.type === 'native/tool-effect' && event.data.effectOutcome === 'unknown'
          && refused[event.data.callId]?.callId !== event.data.callId)
        return { unresolvedDebt: unknown.map(event => 'unknown-tool-effect:' + event.data.callId), blockers: [] }
      },
    }, { agent, sessionId })
    // Unfinished requirements need the verified context, so the gate joins the same unresolvedDebt channel right after it.
    const check = compactionCheck(state, plan, context)
    compactionChecks.set(plan.planId, check)
    if (check.debt.length) context.unresolvedDebt = [...new Set([...context.unresolvedDebt, ...check.debt])]
    return context
  }
  const compactionChecks = new Map()
  function compactionCheck(state, plan, context) {
    const compaction = latestCompaction(session.log)
    if (!compaction) return { debt: [], pending: [], compaction: null }
    const pending = evaluatePlanDelivery({ ...state, v15DeliveryContext: context }, plan.planId).matrix
      .filter(row => row.mandatory && row.remaining.length).map(row => row.requirementId)
    const prefix = 'compaction-memory:session:' + plan.planId + ':'
    const record = state.v15SessionCompactionAnchors?.[plan.planId]
    if (record?.summarySeq === compaction.seq && record.planHash === plan.planHash && record.planRevision === plan.planRevision
      && pending.every(id => record.pending?.includes(id))) return { debt: [], pending, compaction }
    if (!compaction.text) return { debt: [prefix + 'summary-missing'], pending, compaction }
    const anchors = { 'plan-id': [bounded(plan.planId)], 'plan-hash': [hex12(plan.planHash)], 'recovery-locator': [hex12(plan.ref.sha256)],
      ...Object.fromEntries(pending.map(id => ['pending:' + id, [bounded(id)]])) }
    const { missing } = validateCompactionAnchors(summaryTokens(compaction.text), anchors, { required: Object.keys(anchors) })
    return { debt: missing.map(key => prefix + 'anchor-missing:' + key), pending, compaction }
  }
  const withCompactionDebt = (result, planId) => {
    const check = compactionChecks.get(planId)
    return check?.debt.length ? { ...result, compactionDebt: [...check.debt], compactionRecovery: COMPACTION_RECOVERY } : result
  }
  async function anchorCompaction(planId) {
    const compaction = latestCompaction(session.log)
    if (!compaction) return { planId, anchored: false, code: 'NO_COMPACTION' }
    let result
    await control.mutateHot('v15/session-compaction-anchor', { planId }, agent, state => {
      const plan = state.v15PlanDelivery?.plans?.[planId]
      if (!plan) fail('PLAN_NOT_FOUND')
      registry.verify(plan)
      collectContext(state, plan)
      const { pending } = compactionChecks.get(planId)
      const record = { planId, planRevision: plan.planRevision, planHash: plan.planHash, planFileSha256: plan.ref.sha256,
        summarySeq: compaction.seq, pending, recordedAt: Date.now() }
      ;(state.v15SessionCompactionAnchors ??= {})[planId] = record
      return { ...record, anchored: true, anchorText: ['plan', planId, 'rev', plan.planRevision, 'hash', hex12(plan.planHash),
        'file', hex12(plan.ref.sha256), 'pending', pending.join(',') || '(none)'].join(' ') }
    }, { deferMs: 0, afterDurable(value) {
      const { anchored, anchorText, ...record } = value
      if (!same(readDurable().v15SessionCompactionAnchors?.[planId], record)) fail('SESSION_DELIVERY_READBACK_MISMATCH')
      result = { ...value, durable: true }
    } })
    return result
  }
  const service = createDeliveryService({ control, readDurable, registry, collectContext })
  const implementation = createImplementationProofProducer({ control, readDurable, collectContext,
    verifyPlan: registry.verify, authorize })
  const execution = createExecutionProofProducer({ control, readDurable, collectContext, verifyPlan: registry.verify, authorize,
    toolRuntime: ctx.tools, recipeRef: config.recipeRef, allowedRoots: config.allowedRoots,
    captureCancellation: exec => ctx.tools.captureProofCancellation(exec) })
  const flush = () => ctx.sessions.flush(session)
  const gate = createGoalDeliveryGate({ agent, authority: service.authority, readDurable,
    getGoal: () => ctx.goals.get(agent), flush })
  const disposers = []
  try {
    disposers.push(ctx.goals.registerCompletionGate(agent, gate))
    disposers.push(registerDeliveryService(ctx, agent, service))
    if (await flush() !== true) fail('NATIVE_DURABILITY_UNAVAILABLE')
  } catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error }
  const presentation = installDeliveryPresentation(agent.ctx, agent, service, flush)
  disposers.push(() => presentation.dispose())

  async function renew(planId) {
    let result
    await control.mutateHot('v15/session-plan-authority', { planId }, agent, state => {
      const plan = state.v15PlanDelivery?.plans?.[planId]
      if (!plan) fail('PLAN_NOT_FOUND')
      registry.verify(plan)
      if (!planAllowed(plan)) fail('SESSION_DELIVERY_SCOPE_DENIED')
      state.boards.session ??= { id: 'session', tasks: {} }
      const tasks = state.boards.session.tasks, refs = new Map()
      for (const item of plan.items) for (const ref of item.taskRefs) refs.set(ref.taskId, ref)
      const expiresAt = Date.now() + leaseMs
      for (const taskId of refs.keys()) {
        const previous = tasks[taskId]
        if (previous && (previous.ownerName !== owner || previous.localPlanId !== planId)) fail('SESSION_DELIVERY_TASK_CONFLICT')
        const changed = previous && !same(previous.contract.writeScopes, plan.scope)
        const task = tasks[taskId] = { id: taskId, ownerName: owner, localPlanId: planId,
          revision: previous ? previous.revision + Number(changed) : 1,
          contract: { contractRevision: previous ? previous.contract.contractRevision + Number(changed) : 1, writeScopes: [...plan.scope] } }
        const id = 'session-lease-' + planDeliveryHash({ sessionId, taskId })
        state.leases[id] = { id, member: owner, taskId, contractRevision: task.contract.contractRevision, status: 'active', expiresAt }
      }
      return { planId, tasks: [...refs.keys()].map(id => structuredClone(tasks[id])), expiresAt }
    }, { deferMs: 0, afterDurable(value, locked) {
      const disk = readDurable()
      if (disk.revision !== locked.revision || !same(disk.boards.session, locked.boards.session)
        || !same(disk.leases, locked.leases)) fail('SESSION_DELIVERY_READBACK_MISMATCH')
      result = { ...value, durable: true }
    } })
    return result
  }
  async function recordRefusal(callId, error) {
    if (!safeId(callId)) return
    await control.mutateHot('v15/session-refused-call', { callId, code: error.code }, agent, state => {
      ;(state.v15SessionRefusedCalls ??= {})[callId] = { callId, code: error.code, recordedAt: Date.now() }
    }, { deferMs: 0, afterDurable() { if (readDurable().v15SessionRefusedCalls?.[callId]?.callId !== callId) fail('SESSION_DELIVERY_READBACK_MISMATCH') } })
  }
  // The ledger write is best effort: when it cannot be made durable the thrown call simply stays unknown debt.
  async function execute(args, exec) {
    try { return await dispatch(args, exec) } catch (error) {
      if (args?.action === 'commit' && refusedBeforeWrite.has(error)) await recordRefusal(exec.callId, error).catch(() => {})
      throw error
    }
  }
  async function dispatch(args, exec) {
    if (exec.agent !== agent) fail('SESSION_DELIVERY_ACTOR_DENIED')
    guard(readDurable())
    const input = args.input ?? {}
    switch (args.action) {
      case 'plan_register': {
        const registered = await registry.register(input, agent)
        return { ...registered, authority: await renew(registered.plan.planId) }
      }
      case 'lease_renew': return renew(input.planId)
      case 'implementation_prove': return implementation.prove(input, agent)
      case 'execution_prove': return execution.prove(input, exec)
      case 'preview': return withCompactionDebt(service.preview(input.planId), input.planId)
      case 'compaction_anchor': return anchorCompaction(input.planId)
      case 'commit': {
        let result
        try { result = await service.commit(input, { agent }) } catch (error) {
          const debt = error?.code === 'DELIVERY_INCOMPLETE' ? compactionChecks.get(input?.planId)?.debt : undefined
          if (debt?.length) error.message += ' [compaction debt: ' + debt.join(', ') + '; to recover ' + COMPACTION_RECOVERY + ']'
          throw error
        }
        presentation.publish()
        if (await flush() !== true) fail('NATIVE_DURABILITY_UNAVAILABLE')
        return result
      }
      case 'status': {
        const result = service.checkAll()
        result.plans = result.plans.map(row => withCompactionDebt(row, row.planId))
        presentation.publish()
        if (await flush() !== true) fail('NATIVE_DURABILITY_UNAVAILABLE')
        return result
      }
      case 'goal_bind': return bindGoalDeliveryPlan({ control, readDurable, getGoal: () => ctx.goals.get(agent), agent, input, registry, flush })
      case 'recover': return gate.recover()
      default: fail('SESSION_DELIVERY_ACTION_INVALID')
    }
  }
  disposers.push(agent.ctx.tools.register({ name: 'session_delivery',
    description: 'Current-session plan evidence and durable delivery. Registration reads the complete canonical plan file; use boardId session and exact task refs. No Team membership or goal is created. A turn ending or assistant text is not an accepted delivery. After a compaction whose summary lost plan anchors, compaction_anchor re-asserts them.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['plan_register', 'lease_renew', 'implementation_prove',
      'execution_prove', 'preview', 'commit', 'status', 'goal_bind', 'recover', 'compaction_anchor'] }, input: { type: 'object' } }, required: ['action'], additionalProperties: false },
    output: { schema: {}, render: (_, result) => [{ type: 'text', text: JSON.stringify(result) }] }, execute }))
  return { control: raw, service, dispose() { disposed = true; for (const dispose of disposers.reverse()) dispose() } }
}

export function apply(ctx, config = {}) {
  if (config.enabled !== true) return
  if (!Array.isArray(config.sessionIds) || !config.sessionIds.length) fail('SESSION_DELIVERY_OPT_IN_REQUIRED')
  const allowed = new Set(config.sessionIds), installed = new Map()
  const install = async agent => {
    if (!allowed.has(agent.session.id) || installed.has(agent)) return
    const pending = installSessionDelivery(ctx, agent, config)
    installed.set(agent, pending)
    try { await pending } catch (error) { installed.delete(agent); throw error }
  }
  ctx.on('agent/created', ({ agent }) => install(agent))
  ctx.on('agent/disposed', async ({ agent }) => {
    const pending = installed.get(agent)
    installed.delete(agent)
    if (pending) (await pending).dispose()
  })
  ctx.effect(() => async () => {
    const services = await Promise.allSettled(installed.values())
    for (const result of services) if (result.status === 'fulfilled') result.value.dispose()
    installed.clear()
  }, 'session-plan-delivery.scoped()')
  return Promise.all(ctx.agents.list().map(install))
}
