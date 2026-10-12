import { createHypothesisMemory, DEFAULT_HYPOTHESIS_MEMORY_LIMITS } from './team-v15-hypothesis-memory.mjs'
import { readProperty } from './team-v14-identity.mjs'
import { planDeliveryHash } from './team-v15-plan-delivery.mjs'

export const DEFAULT_HYPOTHESIS_RUNTIME_FILE = 'D:\\dsh-test\\home\\team-control-plane\\v15-hypothesis-memory.json'

const clone = value => structuredClone(value)
const fail = code => { throw Object.assign(new Error(code), { code }) }
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key))
const same = (left, right) => {
  try { return planDeliveryHash(left) === planDeliveryHash(right) } catch { return false }
}

function callSync(fn, code, ...args) {
  if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') fail(code)
  const value = fn(...args)
  if (value?.then) fail(code)
  return value
}

function validText(value) {
  if (typeof value !== 'string') return false
  const text = value.trim()
  return text.length > 0 && text.length <= 256 && !/[\u0000-\u001f\u007f]/.test(text)
    && !['unknown', 'undefined', 'null', 'n/a', 'na', 'shared'].includes(text.toLowerCase())
    && !text.startsWith('unresolved:')
}

function validCallId(value) {
  return validText(value) && value.length <= 160 && value === value.trim()
}

function taskMatches(state, taskId, preferredBoardId) {
  const matches = []
  for (const [boardId, board] of Object.entries(state.boards ?? {})) {
    const task = board?.tasks?.[taskId]
    if (task && (!preferredBoardId || preferredBoardId === boardId)) matches.push({ boardId, task })
  }
  return matches
}

function taskOwner(task) {
  return task?.ownerName ?? task?.owner ?? task?.contract?.owner
}

function scopeEqual(left, right) {
  return same(left, right)
}

function proofBindingMatches(proof, plan, item, task, context) {
  return proof.status === 'passed' && proof.planId === plan.planId
    && proof.planRevision === plan.planRevision && proof.planHash === plan.planHash
    && proof.requirementId === item.requirementId && same(proof.scope, plan.scope)
    && proof.boardId === task.boardId && proof.taskId === task.taskId
    && proof.taskRevision === task.revision && proof.contractRevision === task.contract.contractRevision
    && same(proof.sourceIdentity, context.sourceIdentity)
    && proof.environmentFingerprint === context.environmentFingerprint
    && proof.recipeFingerprint === context.recipeFingerprint
    && !(Array.isArray(proof.staleReasons) && proof.staleReasons.length)
}

function validProofPayload(proof, context) {
  if (proof.kind === 'implementation') {
    const file = context.sourceManifest?.files?.find(row => row.path === proof.locator)
    return proof.provenance?.kind === 'server-physical-source-scan' && file
      && file.sha256 === proof.artifactHash && proof.provenance.bytes === file.bytes
      && proof.provenance.physicalPath === file.physicalPath
  }
  if (proof.kind === 'test' || proof.kind === 'acceptance') {
    const quality = proof.provenance?.quality
    return proof.provenance?.kind === 'server-tool-runtime-quality-oracle'
      && typeof proof.provenance.callId === 'string' && proof.provenance.callId.length > 0
      && proof.provenance.recipeId && proof.provenance.recipeHash
      && quality?.schema === 'dsh-execution-quality-v1' && quality.kind === proof.kind
      && quality.checks?.length > 0 && quality.checks.every(row => row?.passed === true)
      && planDeliveryHash(quality) === proof.artifactHash
  }
  return false
}

/** Installs server-only hooks and a read-only view fixed to the executing task scope. */
export function createHypothesisRuntime({ ctx, memoryFile, readDurable, collectContext, verifyPlan, readAttempt, resolveActor,
  control, authorizeTool, now = Date.now,
  maxKeys, maxAttempts, maxNoProgressAttempts, maxDurationMs, auditLimit, smallerProbeMaxSteps,
  smallerProbeMaxDurationMs, lockTimeoutMs } = {}) {
  if (typeof ctx?.on !== 'function' || typeof memoryFile !== 'string' || !memoryFile.trim()) fail('HYPOTHESIS_RUNTIME_CONFIG_INVALID')
  if (typeof readDurable !== 'function' || typeof collectContext !== 'function' || typeof verifyPlan !== 'function'
    || (typeof readAttempt !== 'function' && (typeof control?.mutateHot !== 'function' || typeof authorizeTool !== 'function'))
    || typeof resolveActor !== 'function'
    || typeof now !== 'function') fail('HYPOTHESIS_RUNTIME_AUTHORITY_UNAVAILABLE')

  const memoryOptions = { file: memoryFile, now, maxKeys, maxAttempts, maxNoProgressAttempts, maxDurationMs,
    auditLimit, smallerProbeMaxSteps, smallerProbeMaxDurationMs, lockTimeoutMs }
  const memory = createHypothesisMemory({ ...memoryOptions, readEvidence: async () => undefined })
  const pending = new Map()
  const hooks = []
  let disposed = false
  let settlement = Promise.resolve()
  let settlementFailure

  async function flush() {
    await settlement
    if (settlementFailure) throw settlementFailure
  }

  function at() {
    const value = callSync(now, 'HYPOTHESIS_RUNTIME_CLOCK_INVALID')
    if (!Number.isSafeInteger(value) || value < 0) fail('HYPOTHESIS_RUNTIME_CLOCK_INVALID')
    return value
  }

  function durable() {
    const state = callSync(readDurable, 'HYPOTHESIS_RUNTIME_DURABLE_READ_UNAVAILABLE')
    if (!isObject(state) || !Number.isSafeInteger(state.revision) || state.revision < 0
      || !validText(state.rootTeamId ?? state.rootId)) fail('HYPOTHESIS_RUNTIME_DURABLE_READ_UNAVAILABLE')
    return state
  }

  function currentAuthority(exec, state = durable()) {
    if (!isObject(exec) || !validCallId(readProperty(exec, 'callId'))
      || !validText(readProperty(exec, 'name') ?? readProperty(readProperty(exec, 'tool'), 'name'))) {
      fail('HYPOTHESIS_RUNTIME_CALL_CONTEXT_UNAVAILABLE')
    }
    const actor = callSync(resolveActor, 'HYPOTHESIS_RUNTIME_ACTOR_UNAVAILABLE', readProperty(exec, 'agent'))
    const agentName = actor?.name
    const sessionId = actor?.sessionId
    const rootTeamId = state.rootTeamId ?? state.rootId
    if (!validText(sessionId) || !validText(agentName) || !validText(rootTeamId)
      || actor?.rootTeamId !== rootTeamId) fail('HYPOTHESIS_RUNTIME_AUTHORITY_UNVERIFIED')

    const timestamp = at()
    const matches = []
    for (const [leaseRef, lease] of Object.entries(state.leases ?? {})) {
      if (!validText(leaseRef) || lease?.status !== 'active' || lease.member !== agentName
        || !validText(lease.taskId) || lease.contractRevision === undefined
        || !Number.isFinite(lease.expiresAt) || lease.expiresAt <= timestamp) continue
      const tasks = taskMatches(state, lease.taskId, lease.boardId)
      if (tasks.length !== 1) continue
      const { boardId, task } = tasks[0]
      const contractRevision = task.contract?.contractRevision
      if (taskOwner(task) !== agentName || !Number.isSafeInteger(contractRevision) || contractRevision < 0
        || !Number.isSafeInteger(task.revision) || lease.contractRevision !== contractRevision) continue
      matches.push({ leaseRef, lease, boardId, task })
    }
    if (matches.length !== 1) fail('HYPOTHESIS_RUNTIME_AUTHORITY_UNVERIFIED')
    const { leaseRef, lease, boardId, task } = matches[0]
    const identity = Object.freeze({ sessionId: sessionId.trim(), rootTeamId: rootTeamId.trim(),
      taskId: lease.taskId, contractRevision: task.contract.contractRevision })
    return { identity, state, owner: agentName, leaseRef, lease: clone(lease), boardId, task: clone(task),
      taskRevision: task.revision, at: timestamp }
  }

  function normalizeSpec(value) {
    const keys = ['requirementId', 'hypothesisId', 'failureCause', 'hypothesis', 'probe']
    if (!exactKeys(value, keys) || keys.slice(0, 4).some(key => !validText(value[key]))) fail('HYPOTHESIS_RUNTIME_ATTEMPT_INPUT_INVALID')
    const probeKeys = value.probe?.kind === 'smallerProbe' ? ['kind', 'method', 'maxSteps', 'maxDurationMs'] : ['kind', 'method']
    if (!exactKeys(value.probe, probeKeys) || !['standard', 'smallerProbe'].includes(value.probe.kind)
      || !validText(value.probe.method)) fail('HYPOTHESIS_RUNTIME_ATTEMPT_INPUT_INVALID')
    if (value.probe.kind === 'smallerProbe' && (!Number.isSafeInteger(value.probe.maxSteps) || value.probe.maxSteps < 1
      || value.probe.maxSteps > (smallerProbeMaxSteps ?? DEFAULT_HYPOTHESIS_MEMORY_LIMITS.smallerProbeMaxSteps)
      || !Number.isSafeInteger(value.probe.maxDurationMs) || value.probe.maxDurationMs < 1
      || value.probe.maxDurationMs > (smallerProbeMaxDurationMs ?? DEFAULT_HYPOTHESIS_MEMORY_LIMITS.smallerProbeMaxDurationMs))) {
      fail('HYPOTHESIS_MEMORY_SMALLER_PROBE_UNBOUNDED')
    }
    return clone(value)
  }

  function attemptSpec(exec) {
    // Intent is host-owned metadata, not an extension of a native tool's argument schema.
    const value = typeof readAttempt === 'function'
      ? callSync(readAttempt, 'HYPOTHESIS_RUNTIME_ATTEMPT_UNAVAILABLE', exec) : boundAttempt(exec)
    return value === undefined ? undefined : normalizeSpec(value)
  }

  function requirementBinding(authority, requirementId) {
    if (!validText(requirementId)) fail('HYPOTHESIS_RUNTIME_REQUIREMENT_UNVERIFIED')
    const currentPlan = authority.state.v15PlanDelivery?.taskPlanBindings?.[authority.boardId]?.[authority.identity.taskId]
    if (!isObject(currentPlan)) fail('HYPOTHESIS_RUNTIME_REQUIREMENT_UNVERIFIED')
    const matches = []
    for (const plan of Object.values(authority.state.v15PlanDelivery?.plans ?? {})) {
      if (!isObject(plan) || !same(currentPlan, { planId: plan.planId, planRevision: plan.planRevision, planHash: plan.planHash })) continue
      const items = plan.items?.filter(item => item?.requirementId === requirementId
        && item.taskRefs?.some(ref => ref.boardId === authority.boardId && ref.taskId === authority.identity.taskId))
      if (items?.length !== 1) continue
      const verified = callSync(verifyPlan, 'HYPOTHESIS_RUNTIME_PLAN_UNVERIFIED', clone(plan))
      if (verified !== false) matches.push({ planId: plan.planId, planRevision: plan.planRevision,
        planHash: plan.planHash, requirementId })
    }
    if (matches.length !== 1) fail('HYPOTHESIS_RUNTIME_REQUIREMENT_UNVERIFIED')
    return matches[0]
  }

  function actorFor(agent, state = durable()) {
    const actor = callSync(resolveActor, 'HYPOTHESIS_RUNTIME_ACTOR_UNAVAILABLE', agent)
    if (!validText(actor?.name) || !validText(actor?.sessionId) || actor.rootTeamId !== (state.rootTeamId ?? state.rootId)) {
      fail('HYPOTHESIS_RUNTIME_AUTHORITY_UNVERIFIED')
    }
    return actor
  }

  function intentKey(actor, toolName) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/.test(toolName ?? '') || toolName === 'team_v12') fail('HYPOTHESIS_INTENT_TOOL_DENIED')
    return planDeliveryHash({ sessionId: actor.sessionId, toolName })
  }

  function intentBinding(authority, spec) {
    return { ...requirementBinding(authority, spec.requirementId), ...authority.identity, boardId: authority.boardId,
      taskRevision: authority.taskRevision, owner: authority.owner, leaseRef: authority.leaseRef, expiresAt: authority.lease.expiresAt }
  }

  function intents(state) {
    const doc = state.v15HypothesisIntents ?? { version: 1, records: {} }
    if (!isObject(doc) || doc.version !== 1 || !isObject(doc.records)
      || Object.keys(doc.records).length > 256) fail('HYPOTHESIS_INTENT_STORE_INVALID')
    return doc
  }

  function boundAttempt(exec) {
    const state = durable()
    const actor = actorFor(exec.agent, state)
    if (exec.name === 'team_v12') return undefined
    const row = intents(state).records[planDeliveryHash({ sessionId: actor.sessionId, toolName: exec.name })]
    if (!row || row.status === 'cleared') return undefined
    if (row.status !== 'active' || row.toolName !== exec.name || !Number.isSafeInteger(row.generation)) fail('HYPOTHESIS_INTENT_STORE_INVALID')
    const authority = currentAuthority(exec, state)
    if (!same(row.binding, intentBinding(authority, row.spec))) fail('HYPOTHESIS_INTENT_STALE')
    return clone(row.spec)
  }

  async function mutateIntent(type, agent, update) {
    if (disposed) fail('HYPOTHESIS_RUNTIME_DISPOSED')
    if (typeof control?.mutateHot !== 'function') fail('HYPOTHESIS_INTENT_CONTROL_UNAVAILABLE')
    await flush()
    let receipt
    await control.mutateHot(type, {}, agent, state => update(state), { deferMs: 0,
      afterDurable(result, locked) {
        const disk = durable()
        if (disk.rootId !== locked.rootId || disk.revision !== locked.revision
          || !same(disk.v15HypothesisIntents, locked.v15HypothesisIntents)) fail('HYPOTHESIS_INTENT_READBACK_MISMATCH')
        receipt = { ...clone(result), durable: true }
      } })
    if (!receipt) fail('HYPOTHESIS_INTENT_DURABILITY_UNAVAILABLE')
    return receipt
  }

  async function bind(input, agent) {
    const keys = ['planId', 'expectedPlanRevision', 'expectedPlanHash', 'boardId', 'taskId', 'expectedTaskRevision',
      'expectedContractRevision', 'expectedGeneration', 'toolName', 'requirementId', 'hypothesisId', 'failureCause', 'hypothesis', 'probe']
    if (!exactKeys(input, keys) || !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) fail('HYPOTHESIS_INTENT_INPUT_INVALID')
    const request = clone(input)
    const spec = normalizeSpec(Object.fromEntries(['requirementId', 'hypothesisId', 'failureCause', 'hypothesis', 'probe']
      .map(key => [key, request[key]])))
    return mutateIntent('v15/hypothesis-bound', agent, state => {
      const actor = actorFor(agent, state)
      const key = intentKey(actor, request.toolName)
      if (callSync(authorizeTool, 'HYPOTHESIS_INTENT_TOOL_DENIED', request.toolName, agent) !== true) fail('HYPOTHESIS_INTENT_TOOL_DENIED')
      const authority = currentAuthority({ callId: 'hypothesis-intent-bind', name: request.toolName, agent }, state)
      const binding = intentBinding(authority, spec)
      if (!same({ planId: request.planId, planRevision: request.expectedPlanRevision, planHash: request.expectedPlanHash,
        boardId: request.boardId, taskId: request.taskId, taskRevision: request.expectedTaskRevision,
        contractRevision: request.expectedContractRevision }, { planId: binding.planId, planRevision: binding.planRevision,
        planHash: binding.planHash, boardId: binding.boardId, taskId: binding.taskId, taskRevision: binding.taskRevision,
        contractRevision: binding.contractRevision })) fail('HYPOTHESIS_INTENT_AUTHORITY_CAS_CONFLICT')
      const doc = clone(intents(state))
      const old = doc.records[key]
      if ((old?.generation ?? 0) !== request.expectedGeneration || request.expectedGeneration >= Number.MAX_SAFE_INTEGER) fail('HYPOTHESIS_INTENT_CAS_CONFLICT')
      if (!old && (Object.keys(doc.records).length >= 256 || Object.values(doc.records).filter(row => row.binding.sessionId === actor.sessionId).length >= 32)) fail('HYPOTHESIS_INTENT_CAPACITY')
      const row = { status: 'active', generation: request.expectedGeneration + 1, toolName: request.toolName,
        spec, binding, recordedAt: at() }
      doc.records[key] = row
      state.v15HypothesisIntents = doc
      return row
    })
  }

  async function clear(input, agent) {
    if (!exactKeys(input, ['toolName', 'expectedGeneration', 'reason']) || !Number.isSafeInteger(input.expectedGeneration)
      || input.expectedGeneration < 1 || input.expectedGeneration >= Number.MAX_SAFE_INTEGER || !validText(input.reason)) fail('HYPOTHESIS_INTENT_INPUT_INVALID')
    const request = clone(input)
    return mutateIntent('v15/hypothesis-cleared', agent, state => {
      const key = intentKey(actorFor(agent, state), request.toolName)
      const doc = clone(intents(state))
      const old = doc.records[key]
      if (!old || old.generation !== request.expectedGeneration) fail('HYPOTHESIS_INTENT_CAS_CONFLICT')
      const row = { ...old, generation: old.generation + 1, status: 'cleared', clearedAt: at(), reason: request.reason }
      doc.records[key] = row
      state.v15HypothesisIntents = doc
      return row
    })
  }

  function intentStatus(agent) {
    if (disposed) fail('HYPOTHESIS_RUNTIME_DISPOSED')
    const state = durable()
    const actor = actorFor(agent, state)
    return deepFreeze({ scope: 'own-session-durable-intents-and-observations',
      records: Object.values(intents(state).records)
        .filter(row => row.binding?.sessionId === actor.sessionId && row.binding?.rootTeamId === actor.rootTeamId).map(clone),
      observations: memory.snapshot().entries.filter(row => row.identity.sessionId === actor.sessionId
        && row.identity.rootTeamId === actor.rootTeamId) })
  }

  function memoryFor(requirementId) {
    return createHypothesisMemory({ ...memoryOptions,
      readEvidence: (ref, identity) => resolveEvidence(ref, identity, requirementId) })
  }

  function resolveEvidence(ref, identity, requiredRequirementId) {
    if (!validText(ref)) return undefined
    const state = durable()
    const proof = state.v12Evidence?.records?.[ref]
    if (!isObject(proof) || proof.id !== ref || !['implementation', 'test', 'acceptance'].includes(proof.kind)) return undefined
    if (!validText(proof.boardId) || !validText(proof.taskId)) return undefined
    const tasks = taskMatches(state, proof.taskId, proof.boardId)
    if (tasks.length !== 1) return undefined
    const { boardId, task } = tasks[0]
    if (boardId !== proof.boardId || !task.contract
      || !Number.isSafeInteger(task.contract.contractRevision)) return undefined
    const rootTeamId = state.rootTeamId ?? state.rootId
    const currentIdentity = { sessionId: identity.sessionId, rootTeamId, taskId: proof.taskId,
      contractRevision: task.contract.contractRevision }
    if (!scopeEqual(identity, currentIdentity) || proof.contractRevision !== task.contract.contractRevision
      || (requiredRequirementId !== undefined && proof.requirementId !== requiredRequirementId)) return undefined
    const owner = taskOwner(task)
    if (!validText(owner)) return undefined
    const timestamp = at()
    const leases = Object.entries(state.leases ?? {}).filter(([, lease]) => lease?.status === 'active'
      && lease.member === owner && lease.taskId === proof.taskId && lease.contractRevision === task.contract.contractRevision
      && Number.isFinite(lease.expiresAt) && lease.expiresAt > timestamp)
    if (leases.length !== 1) return undefined
    const [leaseRef, lease] = leases[0]

    const plan = state.v15PlanDelivery?.plans?.[proof.planId]
    if (!isObject(plan) || proof.planId !== plan.planId
      || !same(state.v15PlanDelivery?.taskPlanBindings?.[boardId]?.[proof.taskId],
        { planId: plan.planId, planRevision: plan.planRevision, planHash: plan.planHash })) return undefined
    const verification = callSync(verifyPlan, 'HYPOTHESIS_RUNTIME_PLAN_UNVERIFIED', clone(plan))
    if (verification === false) return undefined
    const items = Array.isArray(plan.items) ? plan.items.filter(row => row?.requirementId === proof.requirementId
      && row.taskRefs?.some(refRow => refRow?.boardId === proof.boardId && refRow?.taskId === proof.taskId)) : []
    if (items.length !== 1) return undefined
    const item = items[0]
    const refField = proof.kind === 'implementation' ? 'implementationRefs'
      : proof.kind === 'test' ? 'testEvidenceRefs' : 'acceptanceEvidenceRefs'
    const context = callSync(collectContext, 'HYPOTHESIS_RUNTIME_CONTEXT_UNVERIFIED', clone(state), clone(plan))
    if (!Array.isArray(item[refField]) || !item[refField].includes(ref)
      || !proofBindingMatches(proof, plan, item, { ...task, boardId, taskId: proof.taskId }, context)
      || !context?.sourceIdentity?.manifestHash || !/^[a-f\d]{64}$/i.test(context.environmentFingerprint ?? '')
      || !/^[a-f\d]{64}$/i.test(context.recipeFingerprint ?? '') || !validProofPayload(proof, context)) return undefined

    const binding = { planId: proof.planId, planRevision: proof.planRevision, planHash: proof.planHash,
      requirementId: proof.requirementId, scope: proof.scope, sourceIdentity: proof.sourceIdentity,
      environmentFingerprint: proof.environmentFingerprint, recipeFingerprint: proof.recipeFingerprint,
      boardId: proof.boardId, taskId: proof.taskId, taskRevision: proof.taskRevision,
      contractRevision: proof.contractRevision }
    const receipts = Object.values(state.deliveryAuthorityReceipts ?? {}).filter(receipt => receipt?.kind === 'delivery-authority'
      && receipt.status === 'passed' && receipt.owner === owner && receipt.leaseRef === leaseRef
      && receipt.expiresAt === lease.expiresAt && same(receipt, { ...binding, id: receipt.id, kind: 'delivery-authority',
        status: 'passed', owner, leaseRef, expiresAt: lease.expiresAt }))
    if (receipts.length !== 1) return undefined
    const sourceIdentity = Object.freeze(clone(identity))
    return { ref, hash: planDeliveryHash({ proof, authority: receipts[0], lease, sourceIdentity: context.sourceIdentity,
      environmentFingerprint: context.environmentFingerprint, recipeFingerprint: context.recipeFingerprint }),
      status: 'passed', sourceIdentity }
  }

  function evidenceRefs(state, authority, requirementId) {
    const matches = []
    for (const plan of Object.values(state.v15PlanDelivery?.plans ?? {})) {
      if (!isObject(plan)) continue
      const items = Array.isArray(plan.items) ? plan.items.filter(row => row?.requirementId === requirementId
        && row.taskRefs?.some(ref => ref?.boardId === authority.boardId && ref?.taskId === authority.identity.taskId)) : []
      if (items.length !== 1) continue
      try {
        const verified = callSync(verifyPlan, 'HYPOTHESIS_RUNTIME_PLAN_UNVERIFIED', clone(plan))
        if (verified === false) continue
      } catch { continue }
      const item = items[0]
      for (const field of ['implementationRefs', 'testEvidenceRefs', 'acceptanceEvidenceRefs']) {
        if (Array.isArray(item[field])) matches.push(...item[field])
      }
    }
    return [...new Set(matches.filter(validText))].sort()
  }

  function newEvidenceCandidate(authority, spec) {
    const previous = memory.snapshot(authority.identity).entries.find(row => row.hypothesisId === spec.hypothesisId
      && row.failureCause === spec.failureCause)
    const known = previous?.evidenceRefs ?? []
    for (const ref of evidenceRefs(authority.state, authority, spec.requirementId)) {
      let evidence
      try { evidence = resolveEvidence(ref, authority.identity, spec.requirementId) } catch { continue }
      if (evidence && !known.some(row => row.ref === evidence.ref || row.hash === evidence.hash)) return evidence.ref
    }
    return undefined
  }

  function callIdRecorded(callId) {
    return memory.snapshot().entries.some(entry => entry.attempts.some(attempt => attempt.attemptId === callId))
  }

  function actionSignature(exec, authority, spec) {
    return planDeliveryHash({ callId: exec.callId, tool: readProperty(exec, 'name') ?? readProperty(readProperty(exec, 'tool'), 'name'),
      arguments: readProperty(exec, 'arguments') ?? readProperty(exec, 'args'), identity: authority.identity, boardId: authority.boardId,
      taskRevision: authority.taskRevision, contractRevision: authority.identity.contractRevision,
      owner: authority.owner, leaseRef: authority.leaseRef, spec })
  }

  function observationFor(result) {
    if (!isObject(result)) return undefined
    if (result.isError !== true && result.isError !== false && result.kind !== 'error') return undefined
    const status = result.isError === true || result.kind === 'error' ? 'failed' : 'passed'
    const rawCode = result.code ?? result.error?.code ?? result.error?.info?.code
    const errorCode = typeof rawCode === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(rawCode) ? rawCode : undefined
    return { status, ...(errorCode ? { errorCode } : {}) }
  }

  function proofRefFrom(result) {
    const payload = result?.structuredContent ?? result?.value
    if (!isObject(payload) || payload.durable !== true || !isObject(payload.proof) || !validText(payload.proof.id)) return undefined
    return payload.proof.id
  }

  function removeHook(event, listener, handle) {
    try {
      if (handle !== ctx && typeof handle === 'function') handle()
      else if (handle !== ctx && typeof handle?.dispose === 'function') handle.dispose()
      else if (handle !== ctx && typeof handle?.unsubscribe === 'function') handle.unsubscribe()
      else if (typeof ctx.off === 'function') ctx.off(event, listener)
      else if (typeof ctx.removeListener === 'function') ctx.removeListener(event, listener)
    } catch {}
  }

  function dispose() {
    if (disposed) return false
    disposed = true
    pending.clear()
    for (const row of hooks.splice(0)) removeHook(row.event, row.listener, row.handle)
    return true
  }

  async function beforeExecute(exec, next) {
    if (disposed) return typeof next === 'function' ? next() : { kind: 'allow' }
    await flush()
    const spec = attemptSpec(exec)
    if (!spec) return typeof next === 'function' ? next() : { kind: 'allow' }
    const authority = currentAuthority(exec)
    const binding = requirementBinding(authority, spec.requirementId)
    if (callIdRecorded(exec.callId) || pending.has(exec.callId)) fail('HYPOTHESIS_RUNTIME_CALL_ID_REUSED')
    if ([...pending.values()].some(row => same(row.authority.identity, authority.identity)
      && row.spec.hypothesisId === spec.hypothesisId && row.spec.failureCause === spec.failureCause)) {
      fail('HYPOTHESIS_RUNTIME_ATTEMPT_IN_FLIGHT')
    }
    const scoped = { identity: authority.identity, hypothesisId: spec.hypothesisId,
      failureCause: spec.failureCause, probe: spec.probe }
    const decision = memory.checkAttempt(scoped)
    const proofRef = newEvidenceCandidate(authority, spec)
    if (decision.decision !== 'continue' && !(decision.reason === 'no-progress-limit' && proofRef)) {
      fail('HYPOTHESIS_RUNTIME_REPLAN_REQUIRED')
    }
    const signature = actionSignature(exec, authority, spec)
    pending.set(exec.callId, { signature, authority, binding, spec, proofRef })
    try { return typeof next === 'function' ? await next() : { kind: 'allow' } }
    catch (error) { pending.delete(exec.callId); throw error }
  }

  function afterFinal(exec, result) {
    if (disposed) return
    const callId = readProperty(exec, 'callId')
    const row = pending.get(callId)
    if (!row) return
    pending.delete(callId)
    const job = settlement.then(async () => {
      if (settlementFailure) throw settlementFailure
      if (!isObject(exec) || actionSignature(exec, row.authority, row.spec) !== row.signature) fail('HYPOTHESIS_RUNTIME_CALL_BINDING_MISMATCH')
      let authorityCurrent = false
      try {
        const current = currentAuthority(exec)
        authorityCurrent = scopeEqual(current.identity, row.authority.identity) && current.owner === row.authority.owner
          && current.leaseRef === row.authority.leaseRef && current.taskRevision === row.authority.taskRevision
          && same(requirementBinding(current, row.spec.requirementId), row.binding)
      } catch (error) {
        if (!['HYPOTHESIS_RUNTIME_AUTHORITY_UNVERIFIED', 'HYPOTHESIS_RUNTIME_REQUIREMENT_UNVERIFIED'].includes(error.code)) throw error
      }
      // Historical observation survives a legitimate ownership transition, but cannot certify progress.
      const observation = authorityCurrent ? observationFor(result) ?? { status: 'unknown' } : { status: 'unknown' }
      const request = { identity: row.authority.identity, hypothesisId: row.spec.hypothesisId,
        failureCause: row.spec.failureCause, attemptId: callId, hypothesis: row.spec.hypothesis,
        probe: row.spec.probe, serverObservation: { identity: row.authority.identity, ...observation } }
      const evidenceRef = authorityCurrent ? row.proofRef ?? (observation.status === 'passed' ? proofRefFrom(result) : undefined) : undefined
      if (evidenceRef) request.newEvidenceRef = evidenceRef
      await memoryFor(row.spec.requirementId).recordAttempt(request)
    })
    settlement = job.catch(error => { settlementFailure ??= error })
    return job
  }

  function register(event, listener) {
    const handle = ctx.on(event, listener)
    hooks.push({ event, listener, handle })
  }

  try {
    register('tools/pre-execute', beforeExecute)
    register('tools/result', afterFinal)
  } catch (error) {
    dispose()
    throw error
  }

  function observe(exec) {
    if (disposed) fail('HYPOTHESIS_RUNTIME_DISPOSED')
    const authority = currentAuthority(exec)
    return deepFreeze(memory.snapshot(authority.identity))
  }

  function check(exec, value) {
    if (disposed) fail('HYPOTHESIS_RUNTIME_DISPOSED')
    const keys = ['requirementId', 'hypothesisId', 'failureCause', 'probe']
    if (!exactKeys(value, keys)) fail('HYPOTHESIS_RUNTIME_OBSERVATION_INPUT_INVALID')
    const authority = currentAuthority(exec)
    requirementBinding(authority, value.requirementId)
    const decision = memory.checkAttempt({ identity: authority.identity, hypothesisId: value.hypothesisId,
      failureCause: value.failureCause, probe: clone(value.probe) })
    if (decision.decision === 'continue' || decision.reason !== 'no-progress-limit') return decision
    const spec = { requirementId: value.requirementId, hypothesisId: value.hypothesisId, failureCause: value.failureCause }
    return newEvidenceCandidate(authority, spec)
      ? Object.freeze({ ...decision, decision: 'continue', reason: 'new-server-proof-available' }) : decision
  }

  return Object.freeze({ observe, check, bind, clear, intentStatus, flush, dispose })
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    if (!Object.isFrozen(value)) Object.freeze(value)
  }
  return value
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) return Object.freeze({ dispose() { return false } })
  const limits = Object.fromEntries(Object.keys(DEFAULT_HYPOTHESIS_MEMORY_LIMITS)
    .filter(key => config[key] !== undefined).map(key => [key, config[key]]))
  return createHypothesisRuntime({ ctx,
    memoryFile: config.memoryFile ?? DEFAULT_HYPOTHESIS_RUNTIME_FILE,
    readDurable: config.readDurable,
    collectContext: config.collectContext,
    verifyPlan: config.verifyPlan,
    readAttempt: config.readAttempt,
    resolveActor: config.resolveActor,
    control: config.control,
    authorizeTool: config.authorizeTool,
    now: config.now ?? Date.now,
    ...limits,
  })
}
