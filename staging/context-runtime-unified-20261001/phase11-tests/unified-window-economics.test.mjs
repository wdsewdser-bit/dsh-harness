import test from 'node:test'
import assert from 'node:assert/strict'
import { aggregateWindowUsage, evaluateWindowEconomics } from '../home/profiles/web/plugins/team-v15-window-economics.mjs'

function economicsInput(overrides = {}) {
  return {
    route: { provider: 'fixture', model: 'model-a', protocol: 'responses', priceVersion: 'prices-7' },
    currentEstimate: { inputTokens: 1000, cacheReadTokens: 200, cacheWriteTokens: 0, outputTokens: 120, reasoningTokens: 20 },
    projectedEstimate: { inputTokens: 700, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 120, reasoningTokens: 20 },
    coldPrefixEstimate: { inputTokens: 80 },
    remainingTurns: { estimate: 6, uncertainty: 1 },
    costs: {
      checkpointCost: { amount: 3, unit: 'USD' },
      firstColdPenalty: { amount: 2, unit: 'USD' },
      expectedRecallCost: { amount: 1, unit: 'USD' },
      stableOldCost: { amount: 10, unit: 'USD' },
      stableNewCost: { amount: 6, unit: 'USD' },
    },
    pricing: { known: true, priceVersion: 'prices-7' },
    cacheWriteTokens: 0,
    reasoningTokens: 20,
    qualityRisk: { verified: true, acceptable: true, score: 0.1 },
    hardSafety: { rawSafetyTokens: 500, safeLimitTokens: 1000, safeCompactionAvailable: true },
    ...overrides,
  }
}

function usageRecord({ sessionId = 'root', parentId = null, rootTeamId = 'team-1', purpose = 'conversation', ...overrides } = {}) {
  return {
    event: 'terminal', status: 'success', complete: true,
    requestId: 'request-1', attemptId: 'attempt-1', sessionId, parentId, rootSessionId: 'root', rootTeamId,
    purpose, requestProjection: { stage: 'handed-to-adapter' },
    usage: { inputTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 1, outputTokens: 4, reasoningTokens: 1, totalTokens: 17 },
    payload: { bytes: 200 }, fee: { amount: 0.01, unit: 'USD' },
    ...overrides,
  }
}

test('economics preview preserves the route and estimates while unknown price/cache-write/reasoning stay unknown', () => {
  const input = economicsInput({ pricing: { known: false }, cacheWriteTokens: null, reasoningTokens: undefined })
  const result = evaluateWindowEconomics(input)
  assert.equal(result.mode, 'shadow')
  assert.equal(result.route.protocol, 'responses')
  assert.equal(result.route.priceVersion, 'prices-7')
  assert.deepEqual(result.estimates.current, input.currentEstimate)
  assert.equal(result.knowledge.price.status, 'unknown')
  assert.equal(result.knowledge.cacheWriteTokens.value, null)
  assert.equal(result.knowledge.reasoningTokens.value, null)
  assert.equal(result.breakEvenTurns, null)
  assert.equal(result.wouldTransition, false)
  assert.equal(result.economicAutoAllowed, false)
  assert.equal(input.currentEstimate.inputTokens, 1000)
})

test('economic transition is shadowed only when costs align, conservative horizon clears break-even and quality is verified', () => {
  const result = evaluateWindowEconomics(economicsInput())
  assert.equal(result.transitionCost.amount, 6)
  assert.equal(result.warmBenefitPerTurn.amount, 4)
  assert.equal(result.breakEvenTurns, 1.5)
  assert.equal(result.knowledge.breakEven.status, 'known')
  assert.equal(result.remainingTurns.conservativeLowerBound, 5)
  assert.equal(result.wouldTransition, true)
  assert.equal(result.wouldContinue, false)
  assert.equal(result.economicAutoAllowed, false)
})

test('nonpositive benefit, incompatible units, unverified quality or unknown horizon cannot suggest economic transition', () => {
  const nonpositive = evaluateWindowEconomics(economicsInput({ costs: {
    checkpointCost: { amount: 3, unit: 'USD' }, firstColdPenalty: { amount: 2, unit: 'USD' },
    expectedRecallCost: { amount: 1, unit: 'USD' }, stableOldCost: { amount: 6, unit: 'USD' }, stableNewCost: { amount: 6, unit: 'USD' },
  } }))
  assert.equal(nonpositive.warmBenefitPerTurn.amount, 0)
  assert.equal(nonpositive.breakEvenTurns, null)
  assert.equal(nonpositive.wouldTransition, false)

  const mismatched = evaluateWindowEconomics(economicsInput({ costs: {
    checkpointCost: { amount: 3, unit: 'USD' }, firstColdPenalty: { amount: 2, unit: 'EUR' },
    expectedRecallCost: { amount: 1, unit: 'USD' }, stableOldCost: { amount: 10, unit: 'USD' }, stableNewCost: { amount: 6, unit: 'USD' },
  } }))
  assert.equal(mismatched.transitionCost, null)
  assert.equal(mismatched.wouldTransition, false)

  assert.equal(evaluateWindowEconomics(economicsInput({ qualityRisk: { verified: false, acceptable: true } })).wouldTransition, false)
  assert.equal(evaluateWindowEconomics(economicsInput({ remainingTurns: { estimate: 6 } })).wouldTransition, false)
})

test('transition cost and warm benefit in different units cannot form a break-even ratio', () => {
  const result = evaluateWindowEconomics(economicsInput({ costs: {
    checkpointCost: { amount: 3, unit: 'USD' }, firstColdPenalty: { amount: 2, unit: 'USD' },
    expectedRecallCost: { amount: 1, unit: 'USD' }, stableOldCost: { amount: 10, unit: 'EUR' }, stableNewCost: { amount: 6, unit: 'EUR' },
  } }))
  assert.equal(result.transitionCost.unit, 'USD')
  assert.equal(result.warmBenefitPerTurn.unit, 'EUR')
  assert.equal(result.breakEvenTurns, null)
  assert.equal(result.knowledge.breakEven.status, 'unknown')
  assert.equal(result.wouldTransition, false)
  assert.equal(result.economicAutoAllowed, false)
})

test('known price version without provider, model and protocol leaves route economics unknown', () => {
  const result = evaluateWindowEconomics(economicsInput({ route: { priceVersion: 'prices-7' } }))
  assert.equal(result.route.provider, null)
  assert.equal(result.route.model, null)
  assert.equal(result.route.protocol, null)
  assert.equal(result.knowledge.price.status, 'unknown')
  assert.equal(result.breakEvenTurns, null)
  assert.equal(result.knowledge.breakEven.status, 'unknown')
  assert.equal(result.wouldTransition, false)
  assert.equal(result.economicAutoAllowed, false)
})

test('hard safety reports raw pressure and safe-compaction requirement independently of economics', () => {
  const result = evaluateWindowEconomics(economicsInput({
    hardSafety: { rawSafetyTokens: 950, safeLimitTokens: 900, safeCompactionAvailable: true },
  }))
  assert.equal(result.hardSafety.rawSafetyTokens, 950)
  assert.equal(result.hardSafety.safeCompactionRequired, true)
  assert.equal(result.wouldCompact, true)
  assert.equal(result.wouldTransition, false)
  assert.equal(result.wouldContinue, false)

  const unsupported = evaluateWindowEconomics(economicsInput({
    hardSafety: { rawSafetyTokens: 950, safeLimitTokens: 900, safeCompactionAvailable: false },
  }))
  assert.equal(unsupported.hardSafety.safeCompactionRequired, true)
  assert.equal(unsupported.wouldCompact, false)
  assert.equal(unsupported.wouldContinue, false)
})

test('missing hard-safety measurements stay unknown and cannot imply continue', () => {
  const result = evaluateWindowEconomics({})
  assert.equal(result.hardSafety.rawSafetyTokens, null)
  assert.equal(result.hardSafety.safeCompactionRequired, null)
  assert.equal(result.hardSafety.safeCompactionAvailable, null)
  assert.equal(result.wouldContinue, false)
})

test('checkpoint suggestions require an explicit shadow requirement and stay non-operative', () => {
  const result = evaluateWindowEconomics(economicsInput({ checkpoint: { required: true, available: true } }))
  assert.equal(result.wouldCheckpoint, true)
  assert.equal(result.economicAutoAllowed, false)
  assert.equal(evaluateWindowEconomics(economicsInput({ checkpoint: { required: true, available: false } })).wouldCheckpoint, false)
})

test('usage aggregation scopes one root team and includes its descendants and auxiliary purposes', () => {
  const records = [
    usageRecord({ sessionId: 'root', purpose: 'conversation' }),
    usageRecord({ requestId: 'request-2', attemptId: 'attempt-1', sessionId: 'child', parentId: 'root', purpose: 'auxiliary' }),
    usageRecord({ requestId: 'request-3', attemptId: 'attempt-1', sessionId: 'grandchild', parentId: 'child', purpose: 'checkpoint' }),
    usageRecord({ requestId: 'request-4', attemptId: 'attempt-1', sessionId: 'child', parentId: 'root', purpose: 'compaction' }),
    usageRecord({ requestId: 'request-5', attemptId: 'attempt-1', sessionId: 'child', parentId: 'root', purpose: 'steer' }),
    usageRecord({ requestId: 'foreign', attemptId: 'attempt-1', sessionId: 'other-root', rootTeamId: 'team-2' }),
    usageRecord({ requestId: 'unresolved', attemptId: 'attempt-1', sessionId: 'unknown-child', rootTeamId: null }),
  ]
  const result = aggregateWindowUsage(records, { rootTeamId: 'team-1', rootSessionId: 'root' })
  assert.equal(result.membership.scopeResolved, true)
  assert.equal(result.membership.includedRecords, 5)
  assert.equal(result.membership.excludedRecords, 2)
  assert.equal(result.activity.attempts, 5)
  assert.deepEqual(result.purposes, { conversation: 1, auxiliary: 1, checkpoint: 1, compaction: 1, steer: 1, other: 0, unknown: 0 })
  assert.equal(result.usage.tokens.inputTokens.knownSubtotal, 50)
  assert.equal(result.usage.bytes.payload.knownSubtotal, 1000)
  assert.equal(result.usage.fees.byUnit.USD.knownSubtotal, 0.05)
})

test('terminal dedupe is request plus attempt plus terminal; distinct retry attempts still count', () => {
  const first = usageRecord({ requestId: 'retrying', attemptId: 'attempt-1', usage: { inputTokens: 100, outputTokens: 20 } })
  const retry = usageRecord({ requestId: 'retrying', attemptId: 'attempt-2', usage: { inputTokens: 50, outputTokens: 10 } })
  const result = aggregateWindowUsage([first, { ...first }, retry], { rootTeamId: 'team-1', rootSessionId: 'root' })
  assert.equal(result.activity.requests, 1)
  assert.equal(result.activity.attempts, 2)
  assert.equal(result.activity.attempted, 2)
  assert.equal(result.activity.handedToAdapter, 2)
  assert.equal(result.activity.providerTerminal, 2)
  assert.equal(result.dedup.duplicateTerminalRecords, 1)
  assert.equal(result.usage.tokens.inputTokens.value, 150)
})

test('transport failure and preemption stay separate; unknown token/byte/fee fields do not become zero', () => {
  const completed = usageRecord({
    requestId: 'a', attemptId: '1', usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: null, outputTokens: 20, reasoningTokens: 10, totalTokens: 120 },
    payload: { bytes: 800 }, fee: { amount: 0.01, unit: 'USD' },
  })
  const failed = usageRecord({
    requestId: 'b', attemptId: '1', status: 'transport-failed', transportFailed: true,
    usage: { inputTokens: null, cacheReadTokens: 5, outputTokens: 5, reasoningTokens: 2, totalTokens: null },
    payload: {}, fee: null,
  })
  const preempted = usageRecord({ requestId: 'c', attemptId: '1', status: 'preempted', preempted: true, usage: null, payload: {} })
  const result = aggregateWindowUsage([completed, failed, preempted], { rootTeamId: 'team-1', rootSessionId: 'root' })
  assert.equal(result.activity.providerTerminal, 1)
  assert.equal(result.activity.transportFailed, 1)
  assert.equal(result.activity.preempted, 1)
  assert.equal(result.usage.tokens.inputTokens.value, null)
  assert.equal(result.usage.tokens.inputTokens.knownSubtotal, 100)
  assert.equal(result.usage.tokens.inputTokens.unknownCount, 2)
  assert.equal(result.usage.tokens.cacheWriteTokens.unknownCount, 3)
  assert.equal(result.usage.tokens.outputTokens.knownSubtotal, 25)
  assert.equal(result.usage.tokens.reasoningTokens.knownSubtotal, 12)
  assert.equal(result.usage.tokens.reasoningIncludedInOutput, true)
  assert.equal(result.usage.tokens.componentTotal.knownSubtotal, 130)
  assert.equal(result.usage.bytes.payload.value, null)
  assert.equal(result.usage.bytes.payload.knownSubtotal, 800)
  assert.equal(result.usage.fees.byUnit.USD.value, null)
  assert.equal(result.usage.fees.byUnit.USD.unknownCount, 1)
  assert.equal(result.usage.fees.unknownCount, 1)
})

test('unresolved root membership fails closed and aggregate never returns body or secret values', () => {
  const records = [
    usageRecord({ rootTeamId: null, sessionId: 'unknown', messages: [{ text: 'private body' }], apiKey: 'private-secret' }),
    usageRecord({ rootTeamId: 'team-2', sessionId: 'other', apiKey: 'another-secret' }),
  ]
  const result = aggregateWindowUsage(records)
  assert.equal(result.membership.scopeResolved, false)
  assert.equal(result.membership.includedRecords, 0)
  const serialized = JSON.stringify(result)
  assert.doesNotMatch(serialized, /private body|private-secret|another-secret/)
})
