import { failWith } from './index.mjs';
export const EXECUTION_STATES = Object.freeze(['OPEN','SEALING','DRAINING','PROVEN','RELEASED','UNVERIFIED']);
export const EXECUTION_ID_FIELDS = Object.freeze(['teamId','memberId','generation','executionSessionId','attemptId','attemptFence','executionEpoch']);
const completeIdentity = value => Boolean(value) && ['teamId','memberId','executionSessionId','attemptId','executionEpoch'].every(k=>typeof value[k]==='string'&&value[k]) &&
  Number.isSafeInteger(value.generation)&&value.generation>0&&Number.isSafeInteger(value.attemptFence)&&value.attemptFence>0;
export const sameExecution = (a, b) => completeIdentity(a) && completeIdentity(b) && EXECUTION_ID_FIELDS.every(k => a[k] === b[k]);
export function executionIdentity(value) {
  if (!value || !['teamId','memberId','executionSessionId','attemptId','executionEpoch'].every(k => typeof value[k] === 'string' && value[k]) ||
      !Number.isSafeInteger(value.generation) || value.generation<1 || !Number.isSafeInteger(value.attemptFence) || value.attemptFence<1) failWith('INVALID_EXECUTION', 'complete E identity required');
  return Object.freeze(Object.fromEntries(EXECUTION_ID_FIELDS.map(k => [k, value[k]])));
}
export const executionScopeId = E => 'execution-scope:' + E.executionEpoch;
export function scopeCertificateMatches(row, proof) {
  return Boolean(row && proof && proof.verified === true && proof.stopState === 'proven' &&
    proof.contract === 'execution-stop/1' && sameExecution(row.E, proof.E) && row.state === 'PROVEN' &&
    typeof row.stopId==='string' && row.stopId && typeof row.certificateId==='string' && row.certificateId &&
    Number.isSafeInteger(row.version) && row.version>0 && row.stopId === proof.stopId && row.version === proof.scopeVersion && row.certificateId === proof.certificateId &&
    row.coverage?.complete === true && proof.coverage?.complete === true &&
    ['gates','attribution','transport','subprocess'].every(k=>row.coverage[k]===true && proof.coverage[k]===true) &&
    Object.values(row.coverage).every(v=>v===true) && row.active === 0 && row.uncertain === 0);
}
