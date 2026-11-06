import { fail, executionScopeId } from '../../contracts/index.mjs';
import { canCloseExecution } from './execution-validation.mjs';

/**
 * §7.2.4 of the team-autonomy design: who may close a revoked lease, and on what.
 *
 * The operator channel is unchanged — the human principal plus any evidence reference is the manual fallback it always
 * was. The new path is the one the design calls the watershed: the host adapter closes the lease on a stop-proof row
 * that names THIS attempt (or the member generation that owned it) and that the platform layer marked verified. The
 * argument is a predicate over committed rows, so a caller can neither name itself adapter nor write the row it cites
 * from a request: F4 — an owner that hand-writes a stop proof gets nothing.
 */
function revokesOnEvidence(tx, attempt, actor, evidenceRef) {
  if (typeof evidenceRef !== 'string' || !evidenceRef) return false;
  if (actor === 'operator') return true;
  if (actor !== 'adapter') return false;
  const row = tx.read(evidenceRef);
  return row?.writtenBy==='adapter' && row?.switch==='on' && canCloseExecution(tx,row,[attempt]);
}

/** One exact execution close-out. No publication or reassignment is permitted here. */
export function releaseAttempt(tx, { attemptId, fence, status = 'cancelled', taskStatus = status, evidenceRef = null, revoked = false, actor, reason = null, deliveryRef = null, publish = false, taskLast = false }) {
 const a = tx.read(attemptId);
 if (!a || a.fence !== fence || !(['cancelled', 'failed'].includes(status) || (publish && status === 'produced'))) fail('DENIED');
 if (['released', 'revoked'].includes(a.lease)) return a;
 // §7.2.4: a proof closes the lease it names. An 'unknown' lease is the ordinary case, and since review 1 #2 an
 // ACTIVE lease of a generation the proof covers is closed by the same adapter rule -- a membership that was proven
 // stopped cannot keep a lease alive, and refusing it is what left the run slot occupied. The owner path is unchanged.
 const completion=tx.read('execution-finish:'+tx.read('execution-current:'+attemptId)?.E?.executionEpoch);
 const completed=completion?.state==='requested' && completion.result.status===status && actor==='adapter' && revokesOnEvidence(tx,a,actor,evidenceRef);
 if(status==='produced' && tx.read('execution-current:'+attemptId) && !completed)fail('EXECUTION_FINISH_REQUIRED');
 const proven = revoked && revokesOnEvidence(tx, a, actor, evidenceRef) &&
   (a.lease === 'unknown' || (a.lease === 'active' && actor === 'adapter'));
 if (revoked ? !proven : !completed && (actor !== a.owner || a.lease !== 'active')) fail('DENIED');
 if (tx.read('execution-current:' + attemptId) && !revoked && !completed) fail('EXECUTION_REQUIRES_CLOSEOUT');
 const breakGlass = revoked && actor === 'operator';
 if (breakGlass) tx.put('break-glass:' + attemptId + ':' + a.fence, { attemptId, fence:a.fence, evidenceRef,
   riskExemption:true, stopState:'unverified', verified:false, warning:'forced release: execution isolation is not proven' });
 const result = tx.put(attemptId, { ...a, lease: revoked ? 'revoked' : 'released', status, ...(reason ? { reason } : {}), ...(deliveryRef ? { deliveryRef } : {}), ...(evidenceRef ? { evidenceRef } : {}) });
 const task = tx.read(a.taskId);
 const writeTask = () => {
  if (task?.attemptId === attemptId && task.status === 'executing') tx.put(a.taskId, { ...task, status: taskStatus, ...(deliveryRef ? { deliveryRef } : {}) });
  else if (!task) tx.outbox('release-task:' + attemptId, { kind: 'release-task', attemptId, taskId: a.taskId, status: taskStatus, reason, evidenceRef });
 };
 if (!taskLast) writeTask();
 for (const w of tx.list('wait:')) if (w.attemptId === attemptId && w.status === 'pending') tx.put(w.entityId, { ...w, status: 'cancelled', ...(reason ? { reason } : {}) });
 if (taskLast) writeTask();
 const current=tx.read('execution-current:' + attemptId);
 if(current && (revoked || completed) && actor==='adapter') {
   const key=executionScopeId(current.E),scope=tx.read(key),proof=tx.read(evidenceRef);
   tx.put(key,{...scope,state:'RELEASED',version:scope.version+1,consumedCertificate:proof.certificateId,
      closeoutResult:{purpose:revoked?(scope.closeoutPurpose==='retire'?'retire':'cancel'):'complete',status,attemptId,proof}});
   tx.put('execution-current:' + attemptId,{...current,state:'RELEASED',version:scope.version+1});
 }
 return result;
}
