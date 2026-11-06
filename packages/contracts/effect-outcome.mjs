/** Canonical facts for ONE settlement. Previous values trigger migration, never supply current facts. */
export function effectSettlementFields(evidence={}, {tries=0,maxTries=5}={}) {
  const executionOutcome=evidence.executed===true?'executed':evidence.notExecuted===true||evidence.deferred===true?'notExecuted':'unknown';
  const retryPolicy=evidence.executed===true?'forbidden':evidence.deferred===true?'allowed':
    ['allowed','forbidden','exhausted'].includes(evidence.retryPolicy)?evidence.retryPolicy:
    evidence.notExecuted===true?(tries<maxTries?'allowed':'exhausted'):'forbidden';
  const proof=evidence.receipt?.stopProof;
  const stopState=proof ? (proof.stopState==='proven'&&proof.verified===true?'proven':'unverified') :
    ['proven','unverified'].includes(evidence.stopState)?evidence.stopState:null;
  return {executionOutcome,retryPolicy,stopState};
}
export function hasEffectSettlementFields(value) {
  return Boolean(value)&&['executionOutcome','retryPolicy','stopState'].some(k=>Object.hasOwn(value,k));
}
