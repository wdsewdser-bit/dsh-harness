export const turnLimitCode = 'NATIVE_TURN_REQUEST_LIMIT';
// Save evidence before native error projection strips custom properties. Refusals are NOT provider dispatches.
export function admitTurnRequest(engine, state, agent) {
  const requestId = 'request-' + engine.serial++, requests = ++state.turnRequests;
  if (requests <= engine.turnLimit) return requestId;
  const evidence = { actor: state.actor, sessionId: agent.session.id, turn: agent.phase.turn,
    requests, limit: engine.turnLimit, stage: engine.stage };
  const failure = { code: turnLimitCode, evidence };
  engine.requestLimitFailure = failure;
  engine.failures.set(state.actor, failure);
  (engine.facts.turnLimitHits ??= []).push({ ...evidence, requestId, step: agent.phase.step, at: Date.now() });
  (engine.facts.rejectedRequests ??= []).push({ ...evidence, requestId, code: turnLimitCode, dispatched: false, at: Date.now() });
  engine.facts.turns.push({ ...evidence, requestId, turnLimit: engine.turnLimit, turnFinish: 'error', killed: true,
    code: turnLimitCode, admittedRequests: requests - 1, at: Date.now() });
  throw Object.assign(Error(turnLimitCode), { evidence });
}
export function failureFromEngine(engine, error) {
  return engine.requestLimitFailure ?? { code: error.message, evidence: error.evidence ?? null };
}
