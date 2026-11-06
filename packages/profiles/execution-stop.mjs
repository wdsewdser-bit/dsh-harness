import {sameExecution} from '../contracts/index.mjs';
// Captured before any async handle lookup. A session is routing, never the stop identity.
export function captureExecutionStop(store,scopes,attempt,purpose){
 const pointer=store.read('execution-current:'+attempt.entityId);if(!pointer?.E)return null;
 return scopes.captureStop(attempt.executionSessionId,purpose,pointer.E)??Object.freeze({E:pointer.E,stopId:pointer.stopId});
}
export async function resolveExecutionStop(scopes,captured,lookup){
 const agent=await lookup();
 if(scopes.stopResult(captured.E,captured.stopId))return agent;
 const current=scopes.byExecution(captured.E);
 if(!current || !sameExecution(current.E,captured.E) || current.snapshot().stopId!==captured.stopId || agent?.session?.id!==captured.E.executionSessionId)
  throw Object.assign(Error('STALE_EXECUTION_STOP'),{code:'STALE_EXECUTION_STOP'});
 return agent;
}
