// Shape only. Null economics are intentional: real host evidence must fill them.
// No configured third-party price or provider usage is invented here.
export function evidenceExample({ sessionId, actorId, route, sourceHash, candidateHash, certificateHash, now }) {
  return {
    sessionId, actorId, route, sourceHash, revision: 0, observedAt: now, expiresAt: now + 5000,
    live: { idle: true, effectsInFlight: 0, certifiedRequestBoundary: false, adapterValidation: false, requestId: null },
    hardSafety: { rawGatePreserved: true, rawSafetyTokens: null, safeLimitTokens: null, safeCompactionRequired: false },
    candidates: [{
      id: 'native-candidate-reference', kind: 'W2', candidateHash,
      certification: { verified: true, sessionId, actorId, route, sourceHash, candidateHash, certificateHash, expiresAt: now + 5000 },
      pricing: { known: false, kind: 'relative-estimate', unit: 'relative-cost', source: null, priceVersion: route.priceVersion },
      usage: { status: 'unknown', source: null, requestId: null, inputTokens: null, cacheReadTokens: null,
        cacheWriteTokens: null, outputTokens: null, reasoningTokens: null },
      costs: Object.fromEntries(['checkpointCost', 'firstColdPenalty', 'expectedRecallCost', 'stableOldCost', 'stableNewCost']
        .map(k => [k, { amount: null, unit: 'relative-cost', source: null }])),
      qualityRisk: { verified: false, acceptable: false, score: null, evidenceRef: null },
      remainingTurns: { estimate: null, uncertainty: null, source: null },
    }],
  }
}
