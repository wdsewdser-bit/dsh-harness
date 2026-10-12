const MAX_RECORDS = 100_000
const TOKEN_FIELDS = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens', 'totalTokens']
const PURPOSES = ['conversation', 'auxiliary', 'checkpoint', 'compaction', 'steer']
const PROVIDER_TERMINALS = new Set(['success', 'succeeded', 'complete', 'completed', 'provider-terminal'])
const TRANSPORT_FAILURES = new Set(['transport-failed', 'transport-failure', 'network-error'])
const PREEMPTIONS = new Set(['preempted', 'preempt', 'superseded'])
const NON_PROVIDER_TERMINALS = new Set(['aborted', 'consumer-return', 'consumer-throw', 'cancelled', 'canceled'])

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 160 ? value.trim() : null
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key)
const first = (...values) => values.find(value => value !== undefined)

function estimateSnapshot(value) {
  if (nonnegative(value) !== null) return { tokens: value }
  if (!object(value)) return null
  const result = {}
  for (const key of [...TOKEN_FIELDS, 'tokens', 'bytes', 'rawSafetyTokens']) {
    if (own(value, key)) result[key] = nonnegative(value[key])
  }
  for (const key of ['unit', 'source', 'status', 'priceVersion']) {
    if (own(value, key)) result[key] = text(value[key])
  }
  return result
}

function costSnapshot(value) {
  if (!object(value)) return null
  const amount = nonnegative(first(value.amount, value.value))
  const unit = text(first(value.unit, value.currency))
  return amount === null || unit === null ? null : { amount, unit }
}

function addCosts(values) {
  if (values.some(value => value === null)) return null
  const unit = values[0].unit
  if (values.some(value => value.unit !== unit)) return null
  const amount = values.reduce((sum, value) => sum + value.amount, 0)
  return Number.isFinite(amount) ? { amount, unit } : null
}

function subtractCosts(left, right) {
  if (left === null || right === null || left.unit !== right.unit) return null
  const amount = left.amount - right.amount
  return Number.isFinite(amount) ? { amount, unit: left.unit } : null
}

function usageKnowledge(input, key, current, projected) {
  if (own(input, key)) {
    const value = nonnegative(input[key])
    return { status: value === null ? 'unknown' : 'known', value }
  }
  const currentValue = nonnegative(current?.[key])
  const projectedValue = nonnegative(projected?.[key])
  const known = currentValue !== null && projectedValue !== null
  return {
    status: known ? 'known' : 'unknown',
    value: known && currentValue === projectedValue ? currentValue : null,
    currentEstimate: currentValue,
    projectedEstimate: projectedValue,
  }
}

/** Pure, bounded shadow evaluation. It never changes service configuration or enables automatic actions. */
export function evaluateWindowEconomics(input = {}) {
  const routeInput = object(input.route) ? input.route : input
  const pricing = object(input.pricing) ? input.pricing : {}
  const currentInput = first(input.currentEstimate, input.estimates?.current)
  const projectedInput = first(input.projectedEstimate, input.estimates?.projected)
  const coldPrefixInput = first(input.coldPrefixEstimate, input.coldPrefix, input.estimates?.coldPrefix)
  const current = estimateSnapshot(currentInput)
  const projected = estimateSnapshot(projectedInput)
  const currentObject = object(currentInput) ? currentInput : null
  const projectedObject = object(projectedInput) ? projectedInput : null
  const route = {
    provider: text(routeInput.provider), model: text(routeInput.model), protocol: text(first(routeInput.protocol, routeInput.routeProtocol)),
    priceVersion: text(first(routeInput.priceVersion, pricing.priceVersion)),
  }

  const priceVersionMatches = !text(pricing.priceVersion) || text(pricing.priceVersion) === route.priceVersion
  const routeKnown = route.provider !== null && route.model !== null && route.protocol !== null
  const priceKnown = routeKnown && pricing.known === true && route.priceVersion !== null && priceVersionMatches && input.priceKnown !== false
  const cacheWriteTokens = usageKnowledge(input, 'cacheWriteTokens', currentObject, projectedObject)
  const reasoningTokens = usageKnowledge(input, 'reasoningTokens', currentObject, projectedObject)
  const knowledge = {
    price: { status: priceKnown ? 'known' : 'unknown', value: priceKnown ? route.priceVersion : null },
    cacheWriteTokens,
    reasoningTokens,
  }

  const sourceCosts = object(input.costs) ? input.costs : {}
  const checkpointCost = costSnapshot(sourceCosts.checkpointCost)
  const firstColdPenalty = costSnapshot(sourceCosts.firstColdPenalty)
  const expectedRecallCost = costSnapshot(sourceCosts.expectedRecallCost)
  const stableOldCost = costSnapshot(sourceCosts.stableOldCost)
  const stableNewCost = costSnapshot(sourceCosts.stableNewCost)
  const transitionCost = addCosts([checkpointCost, firstColdPenalty, expectedRecallCost])
  const warmBenefitPerTurn = subtractCosts(stableOldCost, stableNewCost)
  const knownBreakEvenInputs = priceKnown && cacheWriteTokens.status === 'known' && reasoningTokens.status === 'known'
    && transitionCost !== null && warmBenefitPerTurn !== null && transitionCost.unit === warmBenefitPerTurn.unit
  const breakEvenReliable = knownBreakEvenInputs && warmBenefitPerTurn.amount > 0
  const breakEvenTurns = breakEvenReliable ? transitionCost.amount / warmBenefitPerTurn.amount : null
  knowledge.breakEven = { status: breakEvenReliable ? 'known' : 'unknown', value: breakEvenTurns }

  const turnsInput = input.remainingTurns
  const turnsEstimate = nonnegative(object(turnsInput) ? first(turnsInput.estimate, turnsInput.value, turnsInput.remaining) : turnsInput)
  const turnsUncertainty = nonnegative(first(object(turnsInput) ? turnsInput.uncertainty : undefined, input.remainingTurnsUncertainty))
  const conservativeLowerBound = turnsEstimate !== null && turnsUncertainty !== null ? Math.max(0, turnsEstimate - turnsUncertainty) : null
  const qualityInput = object(input.qualityRisk) ? input.qualityRisk : {}
  const qualityRisk = {
    verified: qualityInput.verified === true,
    acceptable: qualityInput.acceptable === true,
    score: nonnegative(qualityInput.score),
    status: text(qualityInput.status),
  }
  const hardInput = object(input.hardSafety) ? input.hardSafety : {}
  const rawSafetyTokens = nonnegative(first(hardInput.rawSafetyTokens, hardInput.rawTokens))
  const safeLimitTokens = nonnegative(first(hardInput.safeLimitTokens, hardInput.capacityTokens))
  const explicitSafetyState = ['safeCompactionRequired', 'compactionRequired', 'nearCapacity']
    .some(key => typeof hardInput[key] === 'boolean')
  const safetyMeasurementKnown = rawSafetyTokens !== null && safeLimitTokens !== null
  const safetyThresholdReached = safetyMeasurementKnown && rawSafetyTokens >= safeLimitTokens
  const safeCompactionRequired = hardInput.safeCompactionRequired === true || hardInput.compactionRequired === true
    || hardInput.nearCapacity === true || safetyThresholdReached
    ? true
    : explicitSafetyState || safetyMeasurementKnown ? false : null
  const safeCompactionAvailable = typeof hardInput.safeCompactionAvailable === 'boolean' ? hardInput.safeCompactionAvailable : null
  const checkpointInput = object(input.checkpoint) ? input.checkpoint : {}
  const checkpointRequired = input.checkpointRequired === true || checkpointInput.required === true
  const wouldCheckpoint = checkpointRequired && checkpointInput.available === true
  const wouldCompact = safeCompactionRequired === true && safeCompactionAvailable === true && hardInput.safeCompactionAllowed !== false
  const qualityAllowsTransition = qualityRisk.verified && qualityRisk.acceptable
  const wouldTransition = !safeCompactionRequired && qualityAllowsTransition && breakEvenTurns !== null
    && conservativeLowerBound !== null && conservativeLowerBound >= breakEvenTurns
  const wouldContinue = !wouldCompact && !wouldCheckpoint && !wouldTransition && safeCompactionRequired === false

  return {
    mode: 'shadow', economicAutoAllowed: false,
    route,
    estimates: { current, projected, coldPrefix: estimateSnapshot(coldPrefixInput) },
    remainingTurns: { estimate: turnsEstimate, uncertainty: turnsUncertainty, conservativeLowerBound },
    costs: { checkpointCost, firstColdPenalty, expectedRecallCost, stableOldCost, stableNewCost },
    transitionCost, warmBenefitPerTurn, breakEvenTurns,
    knowledge,
    qualityRisk,
    hardSafety: {
      rawSafetyTokens, safeLimitTokens, safeCompactionRequired, safeCompactionAvailable,
      rawGatePreserved: true,
    },
    wouldContinue, wouldCompact, wouldCheckpoint, wouldTransition,
  }
}

function normalizedId(value) { return text(value) }
function rowProjection(record) { return object(record?.requestProjection) ? record.requestProjection : {} }
function rowRootTeam(record) { return normalizedId(first(record?.rootTeamId, record?.identity?.rootTeamId)) }
function rowSession(record) { return normalizedId(first(record?.sessionId, record?.identity?.sessionId)) }
function rowParent(record) { return normalizedId(first(record?.parentId, record?.parentSessionId, record?.identity?.parentId)) }
function rowRootSession(record) { return normalizedId(first(record?.rootSessionId, record?.identity?.rootSessionId)) }
function rowPurpose(record) { return normalizedId(first(record?.purpose, record?.mechanism, rowProjection(record).purpose)) }
function terminalStatus(record) { return String(first(record?.status, record?.terminal?.status, record?.terminalKind, '')).trim().toLowerCase() }
function hasPreemption(record) {
  return record?.preempted === true || record?.preemptReason != null || PREEMPTIONS.has(terminalStatus(record))
    || PREEMPTIONS.has(String(record?.preemption?.kind ?? '').toLowerCase())
}
function hasTransportFailure(record) {
  return record?.transportFailed === true || TRANSPORT_FAILURES.has(terminalStatus(record))
    || String(record?.failure?.kind ?? '').toLowerCase() === 'transport'
}
function isProviderTerminal(record) {
  if (record?.providerTerminal === true) return true
  const status = terminalStatus(record)
  if (PROVIDER_TERMINALS.has(status)) return true
  return record?.event === 'terminal' && record?.complete === true && !hasPreemption(record)
    && !hasTransportFailure(record) && !NON_PROVIDER_TERMINALS.has(status) && status !== 'error'
}
function isTerminalRecord(record) { return record?.event === 'terminal' || record?.terminal === true }
function classifyTerminal(record) {
  if (hasPreemption(record)) return 'preempted'
  if (hasTransportFailure(record)) return 'transport-failed'
  if (isProviderTerminal(record)) return 'provider-terminal'
  return 'unclassified'
}

function metricAccumulator() { return { knownSubtotal: 0, unknownCount: 0, invalidCount: 0 } }
function addMetric(target, value) {
  const normalized = nonnegative(value)
  if (normalized === null) target.unknownCount++
  else target.knownSubtotal += normalized
}
function finishMetric(value) {
  return {
    value: value.unknownCount === 0 && value.invalidCount === 0 ? value.knownSubtotal : null,
    knownSubtotal: value.knownSubtotal,
    unknownCount: value.unknownCount,
    invalidCount: value.invalidCount,
  }
}
function recordFee(record) {
  const fee = first(record?.fee, record?.usage?.fee, record?.providerUsage?.fee)
  if (!object(fee)) return null
  const amount = nonnegative(first(fee.amount, fee.value))
  const unit = text(first(fee.unit, fee.currency))
  return amount === null || unit === null ? null : { amount, unit }
}
function recordUsage(record) {
  if (!object(record)) return null
  return object(record.usage) ? record.usage : object(record.providerUsage) ? record.providerUsage : null
}
function recordByteValue(record, field) {
  const projection = rowProjection(record)
  const candidates = {
    payload: [record?.payload?.bytes, record?.payloadBytes],
    before: [projection.before?.bytes, projection.beforeBytes],
    after: [projection.after?.bytes, projection.afterBytes],
    adapterPayload: [projection.adapterPayload?.bytes, record?.adapterPayload?.bytes],
  }[field]
  return first(...candidates)
}

/** Aggregate only records with explicit membership in one root team or supplied member set. */
export function aggregateWindowUsage(records, membership = {}) {
  const source = Array.isArray(records) ? records : []
  const limited = source.slice(0, MAX_RECORDS)
  const options = object(membership) ? membership : {}
  const explicitTeamId = normalizedId(options.rootTeamId)
  const explicitRootSessionId = normalizedId(options.rootSessionId)
  const explicitMembers = Array.isArray(options.memberSessionIds)
    ? new Set(options.memberSessionIds.slice(0, MAX_RECORDS).map(normalizedId).filter(Boolean)) : null
  const roots = new Set(limited.map(rowRootTeam).filter(Boolean))
  const missingRootMembership = limited.some(record => rowRootTeam(record) === null)
  const inferredTeamId = roots.size === 1 && !missingRootMembership ? [...roots][0] : null
  const selectedTeamId = explicitTeamId ?? inferredTeamId
  const inferredRootSessionId = explicitRootSessionId ?? rowRootSession(limited.find(record => rowRootTeam(record) === selectedTeamId && rowRootSession(record)))
  const scopeResolved = Boolean(selectedTeamId || explicitMembers?.size || (explicitRootSessionId && explicitMembers))
  const memberIds = new Set(explicitMembers ?? [])
  if (inferredRootSessionId) memberIds.add(inferredRootSessionId)
  if (!explicitMembers && inferredRootSessionId) {
    let changed = true
    while (changed) {
      changed = false
      for (const record of limited) {
        const sessionId = rowSession(record)
        const parentId = rowParent(record)
        if (sessionId && parentId && memberIds.has(parentId) && !memberIds.has(sessionId)) {
          memberIds.add(sessionId)
          changed = true
        }
      }
    }
  }
  const belongs = record => {
    if (!scopeResolved) return false
    const teamId = rowRootTeam(record)
    if (selectedTeamId && teamId && teamId !== selectedTeamId) return false
    const sessionId = rowSession(record)
    if (explicitMembers) return sessionId !== null && memberIds.has(sessionId)
    if (selectedTeamId && teamId === selectedTeamId) return true
    return sessionId !== null && memberIds.has(sessionId)
  }
  const included = limited.filter(belongs)
  const excluded = limited.length - included.length
  const attempts = new Map()
  const requests = new Set()
  const terminalKeys = new Set()
  const terminalRows = []
  let duplicateTerminalRecords = 0
  let missingRequestIdRecords = 0
  let missingAttemptIdRecords = 0

  for (let index = 0; index < included.length; index++) {
    const record = included[index]
    const requestId = normalizedId(first(record.requestId, rowProjection(record).requestId))
    const attemptId = normalizedId(first(record.attemptId, rowProjection(record).attemptId))
    if (requestId) requests.add(requestId)
    else missingRequestIdRecords++
    if (!attemptId) missingAttemptIdRecords++
    const attemptKey = requestId && attemptId ? `${requestId}\u0000${attemptId}` : `unkeyed\u0000${index}`
    let attempt = attempts.get(attemptKey)
    if (!attempt) {
      attempt = { requestId, attemptId, stages: new Set(), purpose: null, terminalCount: 0 }
      attempts.set(attemptKey, attempt)
    }
    const projection = rowProjection(record)
    const stage = String(first(projection.stage, record.stage, '')).trim().toLowerCase()
    if (stage === 'attempted' || stage === 'handed-to-adapter' || isTerminalRecord(record) || record.event === 'start') attempt.stages.add('attempted')
    if (stage === 'handed-to-adapter' || projection.handedToAdapter === true || record.handedToAdapter === true) attempt.stages.add('handed')
    const purpose = rowPurpose(record)
    if (PURPOSES.includes(purpose)) attempt.purpose = purpose
    else if (purpose && attempt.purpose === null) attempt.purpose = 'other'
    if (isTerminalRecord(record)) {
      const terminalKeyValue = normalizedId(first(record.terminalId, record.terminal?.id, record.terminalKind, record.status, 'terminal')) ?? 'terminal'
      const terminalKey = requestId && attemptId ? `${requestId}\u0000${attemptId}\u0000${terminalKeyValue}` : `unkeyed-terminal\u0000${index}`
      if (terminalKeys.has(terminalKey)) {
        duplicateTerminalRecords++
        continue
      }
      terminalKeys.add(terminalKey)
      attempt.terminalCount++
      terminalRows.push({ record, attemptKey })
    }
  }

  const attempted = [...attempts.values()].filter(attempt => attempt.stages.has('attempted')).length
  const handedToAdapter = [...attempts.values()].filter(attempt => attempt.stages.has('handed')).length
  const terminalKinds = terminalRows.map(({ record }) => classifyTerminal(record))
  const providerTerminal = terminalKinds.filter(kind => kind === 'provider-terminal').length
  const transportFailed = terminalKinds.filter(kind => kind === 'transport-failed').length
  const preempted = terminalKinds.filter(kind => kind === 'preempted').length
  const unclassifiedTerminal = terminalKinds.filter(kind => kind === 'unclassified').length
  const purposeCounts = { conversation: 0, auxiliary: 0, checkpoint: 0, compaction: 0, steer: 0, other: 0, unknown: 0 }
  for (const attempt of attempts.values()) purposeCounts[attempt.purpose ?? 'unknown']++

  const missingTerminalRows = [...attempts.entries()].filter(([key, attempt]) => attempt.terminalCount === 0 && (attempt.stages.has('attempted') || attempt.stages.has('handed')))
    .map(([attemptKey]) => ({ record: null, attemptKey }))
  const usageRows = [...terminalRows, ...missingTerminalRows]
  const tokenMetrics = Object.fromEntries(TOKEN_FIELDS.map(key => [key, metricAccumulator()]))
  const byteMetrics = Object.fromEntries(['payload', 'before', 'after', 'adapterPayload'].map(key => [key, metricAccumulator()]))
  const fees = new Map()
  let unknownFeeCount = 0
  for (const { record } of usageRows) {
    const usage = recordUsage(record)
    for (const field of TOKEN_FIELDS) addMetric(tokenMetrics[field], usage?.[field])
    for (const field of Object.keys(byteMetrics)) addMetric(byteMetrics[field], record ? recordByteValue(record, field) : null)
    const fee = record ? recordFee(record) : null
    if (fee === null) unknownFeeCount++
    else {
      let accumulator = fees.get(fee.unit)
      if (!accumulator) fees.set(fee.unit, accumulator = metricAccumulator())
      accumulator.knownSubtotal += fee.amount
    }
  }
  for (const accumulator of fees.values()) accumulator.unknownCount = unknownFeeCount
  const feeByUnit = Object.fromEntries([...fees].map(([unit, accumulator]) => [unit, finishMetric(accumulator)]))
  const componentTotal = metricAccumulator()
  for (const field of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']) {
    componentTotal.knownSubtotal += tokenMetrics[field].knownSubtotal
    componentTotal.unknownCount += tokenMetrics[field].unknownCount
    componentTotal.invalidCount += tokenMetrics[field].invalidCount
  }
  const unresolvedMembershipRecords = limited.filter(record => !belongs(record) && rowRootTeam(record) === null).length
  const memberType = explicitMembers ? 'explicit-session-membership' : selectedTeamId ? 'root-team-lineage' : 'unresolved'

  return {
    version: 1,
    membership: {
      scopeResolved, type: memberType, includedRecords: included.length, excludedRecords: excluded,
      unresolvedRecords: unresolvedMembershipRecords, truncatedRecords: Math.max(0, source.length - limited.length),
    },
    activity: {
      requests: requests.size, attempts: attempts.size, attempted, handedToAdapter,
      providerTerminal, transportFailed, preempted, unclassifiedTerminal: Math.max(0, unclassifiedTerminal),
    },
    purposes: purposeCounts,
    usage: {
      tokens: {
        ...Object.fromEntries(TOKEN_FIELDS.map(key => [key, finishMetric(tokenMetrics[key])])),
        componentTotal: finishMetric(componentTotal),
        reasoningIncludedInOutput: true,
      },
      bytes: Object.fromEntries(Object.keys(byteMetrics).map(key => [key, finishMetric(byteMetrics[key])])),
      fees: { byUnit: feeByUnit, unknownCount: unknownFeeCount },
    },
    dedup: { duplicateTerminalRecords, missingRequestIdRecords, missingAttemptIdRecords },
  }
}
