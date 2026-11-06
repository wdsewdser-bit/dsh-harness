import { fail, id, executionIdentity, sameExecution, executionScopeId, scopeCertificateMatches } from '../../contracts/index.mjs';
import { releaseAttempt } from './release.mjs';
import { canCloseExecution, canFinishStoppedGeneration } from './execution-validation.mjs';
import { assertCoordinationAllows } from './intents.mjs';
import { openDecision } from './decisions.mjs';
import { resolveAuthority } from '../authority.mjs';

const edges = { OPEN: ['OPEN','SEALING','UNVERIFIED'], SEALING: ['DRAINING','UNVERIFIED'],
  DRAINING: ['DRAINING','PROVEN','UNVERIFIED'], UNVERIFIED: ['UNVERIFIED','PROVEN'], PROVEN: ['UNVERIFIED','DRAINING'], RELEASED: [] };
const held = a => ['active','unknown'].includes(a?.lease);
const certificates = proof => proof?.contract === 'execution-stop-set/1' ? proof.certificates : [proof];

/** Internal synchronous write, before a permit can escape to IO. Recovery never invents an empty registry. */
export function recordExecution(tx, snapshot, alertOptions={}) {
  const E = executionIdentity(snapshot?.E), key = executionScopeId(E), old = tx.read(key);
  const current = tx.read('execution-current:' + E.attemptId), attempt = tx.read(E.attemptId), member = tx.read(E.memberId);
  if (!held(attempt) || (attempt.teamId && attempt.teamId!==E.teamId) || attempt.owner !== E.memberId || attempt.generation !== E.generation ||
      attempt.fence !== E.attemptFence || member?.generation !== E.generation ||
      (attempt.executionSessionId && attempt.executionSessionId !== E.executionSessionId)) fail('STALE_EXECUTION');
  if (!Number.isSafeInteger(snapshot.version) || !Number.isSafeInteger(snapshot.active) || snapshot.active < 0 ||
      !Number.isSafeInteger(snapshot.uncertain) || snapshot.uncertain < 0) fail('INVALID_EXECUTION_SNAPSHOT');
  if (!old) {
    if (snapshot.state !== 'OPEN' || snapshot.version !== 1 || (current && current.state !== 'RELEASED')) fail('EXECUTION_RECOVERY_REQUIRED');
  } else if (!sameExecution(old.E,E) || !sameExecution(current?.E,E) || current.version!==old.version || current.state!==old.state || current.stopId!==old.stopId || snapshot.version !== old.version + 1 ||
      !edges[old.state]?.includes(snapshot.state) || (old.stopId && old.stopId !== snapshot.stopId)) fail('STALE_EXECUTION_STATE');
  const gaps=snapshot.coverageGaps??[];
  if(!Array.isArray(gaps)||new Set(gaps).size!==gaps.length||gaps.some(k=>typeof k!=='string'||snapshot.coverage?.[k]!==false)||
     (old?.coverageGaps??[]).some(k=>!gaps.includes(k)||snapshot.coverage?.[k]!==false)||
     Object.entries(snapshot.coverage??{}).some(([k,v])=>k!=='complete'&&v===false&&old&&old.coverage?.[k]!==false&&!gaps.includes(k)))fail('COVERAGE_GAP_IRREVERSIBLE');
  if(old?.closeoutPurpose && old.closeoutPurpose!=='complete' && snapshot.closeoutPurpose!==old.closeoutPurpose)fail('CLOSEOUT_PURPOSE_CONFLICT');
  if (snapshot.state !== 'OPEN' && !snapshot.stopId) fail('INVALID_STOP_ID');
  if (snapshot.state === 'PROVEN' && (!snapshot.coverage?.complete || snapshot.active || snapshot.uncertain || !snapshot.certificateId)) fail('EXECUTION_NOT_DRAINED');
  const row = tx.put(key, { ...snapshot, E, epochOpenedSeq:old?.epochOpenedSeq??tx.latestEventSeq() });
  tx.put('execution-current:' + E.attemptId, { E, state: row.state, version: row.version, stopId: row.stopId });
  if(row.coverageGaps?.includes('unpermitted-turn'))openExecutionTurnAlert(tx,row,alertOptions);
  return row;
}

/** One durable actionable escalation per full E, including after acknowledgement/TTL or a host restart. */
export function openExecutionTurnAlert(tx,snapshot,{now=Date.now(),ttlMs=900000}={}) {
  const E=snapshot?.E,row=E&&tx.read(executionScopeId(E));
  if(!sameExecution(row?.E,E)||!row.coverageGaps?.includes('unpermitted-turn')||row.state==='RELEASED')return null;
  const key='execution-alert:'+E.executionEpoch,prior=tx.read(key);
  if(prior){if(!sameExecution(prior.E,E))fail('STALE_EXECUTION');return prior;}
  const decisionId='decision:execution-turn:'+E.executionEpoch;
  const alert=tx.put(key,{E,kind:'execution-turn-contract',code:row.turnFault?.code??'TURN_EVENT_REJECTED',
    error:row.turnFault??null,severity:'error',responsible:'operator',stopState:'unverified',occupancy:'retained',
    decisionId,at:now,actions:[
      'Inspect the E-bound turn events and replace or repair the nonconforming wake adapter.',
      'Root/operator may acknowledge with team_decide(wait); after TTL use explicit reopenExecutionTurnDecision(E, actor, {previousDecisionId, reason}, entry). Neither action stops or releases E.',
      'Obtain independent complete isolation/stop evidence, or use the existing explicit break-glass risk exemption; never clear coverageGaps or release on timeout.'
    ]});
  openDecision(tx,{autonomy:'on',now},{kind:'stuck-member',
    subject:{type:'execution-alert',id:key,revision:alert.revision},
    evidence:[{kind:'execution-turn-contract',ref:key,at:now,text:alert.code+': unpermitted turn; UNVERIFIED and occupancy retained. '+alert.actions.join(' ')}],
    openedFor:'operator',decisionId,now,ttlMs,fallback:'escalate'});
  return alert;
}

/** Pure validation over the deciding transaction. A subject label can never widen a certificate's E. */
export { canCloseExecution, canFinishStoppedGeneration, consumedStopMatches, consumedGenerationProof, stoppedTransitionMatches } from './execution-validation.mjs';

/** The only automatic stop closeout. Caller owns one transaction including any member generation change. */
export function closeExecution(tx, { proof, evidenceRef, attempts, status = 'cancelled', purpose = 'cancel',
  intentProtocol = null }) {
  if (!['complete','cancel','retire'].includes(purpose)) fail('INVALID_CLOSEOUT_PURPOSE');
  const old=proof?.E&&tx.read(executionScopeId(proof.E));
  if(old?.state==='RELEASED' && attempts.length===1 && attempts[0].entityId===proof.E.attemptId && attempts[0].fence===proof.E.attemptFence && old?.state==='RELEASED' && sameExecution(old.E,proof.E) && old.stopId===proof.stopId && old.consumedCertificate===proof.certificateId && old.closeoutResult?.proof?.scopeVersion===proof.scopeVersion){
    if(old.closeoutResult?.purpose!==purpose)fail('CLOSEOUT_PURPOSE_CONFLICT');
    return attempts.length;
  }
  if (!canCloseExecution(tx,proof,attempts)) fail('STOP_NOT_CONFIRMED');
  const certs = certificates(proof);
  for (const attempt of attempts) {
    const cert = certs.find(c => c.E.attemptId === attempt.entityId), key = executionScopeId(cert.E), row = tx.read(key);
    // releaseAttempt independently checks the exact certificate while it is still PROVEN.
    const ref = evidenceRef + ':' + cert.E.executionEpoch;
    tx.put(ref,{ ...cert, writtenBy:'adapter', switch:'on' });
    const finish=tx.read('execution-finish:'+cert.E.executionEpoch);
    if(purpose==='complete') {
      if(row.closeoutPurpose && row.closeoutPurpose!=='complete')fail('CLOSEOUT_PURPOSE_CONFLICT');
      const effects=typeof tx.effects==='function'?tx.effects():tx.list('effect:');
      if(effects.some(e=>['pending','retryable','applying'].includes(e.status) &&
        ((e.payload?.kind==='cancel'&&e.payload.attemptId===attempt.entityId)||(['dispose','cancel-member'].includes(e.payload?.kind)&&e.payload.memberId===attempt.owner))))fail('CLOSEOUT_PURPOSE_CONFLICT');
    }
    if(purpose==='complete' && finish?.state==='requested') {
      if(!sameExecution(finish.E,cert.E))fail('STALE_EXECUTION_FINISH');
      const result=finish.result,task=tx.read(attempt.taskId);
      if(task?.status!=='executing' || task.attemptId!==attempt.entityId || task.revision!==result.taskRevision || (task.contractRevision??null)!==result.contractRevision)fail('STALE_EXECUTION_FINISH');
      // §3.3: the execution close-out is a publish entry too, so it runs the same gate as produce/verify/decide/API
      // finish. The protocol is an entry-selected option (absent = legacy), which is why every caller that does not name
      // one keeps HEAD's window rule byte for byte.
      if(result.gate && result.status==='produced')assertCoordinationAllows(tx,{intentProtocol:finish.intentProtocol ?? intentProtocol},
        {actor:attempt.owner,taskRef:attempt.taskId,contractRevision:task.contractRevision});
      releaseAttempt(tx,{attemptId:attempt.entityId,fence:attempt.fence,status:result.status,revoked:false,actor:'adapter',evidenceRef:ref,
        deliveryRef:result.deliveryRef,publish:result.status==='produced',taskLast:result.taskLast});
      tx.put(finish.entityId,{...finish,state:'completed',certificateId:cert.certificateId});
    } else {
      if(purpose==='complete')fail('EXECUTION_FINISH_REQUIRED');
      if(finish?.state==='requested')tx.put(finish.entityId,{...finish,state:'superseded',supersededBy:purpose,certificateId:cert.certificateId});
      releaseAttempt(tx,{ attemptId:attempt.entityId, fence:attempt.fence, status, revoked:true, actor:'adapter', evidenceRef:ref });
    }

  }
  return attempts.length;
}

export function closeStoppedGeneration(tx, memberId, generation, proof, evidenceRef) {
  const attempts = tx.list('attempt:').filter(a => a.owner === memberId && a.generation === generation && held(a));
  if(!canFinishStoppedGeneration(tx,proof,memberId,generation))fail('STOP_NOT_CONFIRMED');
  const certs=certificates(proof).filter(c=>attempts.some(a=>a.entityId===c.E.attemptId));
  if(!attempts.length)return 0;
  const pending=certs.length===1?certs[0]:{...proof,contract:'execution-stop-set/1',certificates:certs};
  return closeExecution(tx,{proof:pending,evidenceRef,attempts,purpose:'retire'});
}

/** Historical off-mode cleanup, kept behind the composition switch (no scope/proof inference). */
export function closeLegacyGeneration(tx, memberId) {
  for (const a of tx.list('attempt:').filter(a => a.owner === memberId && held(a))) {
    tx.put(a.entityId,{...a,lease:'revoked',fence:a.fence+1,status:'cancelled'});
    for(const w of tx.list('wait:').filter(w=>w.attemptId===a.entityId&&w.status==='pending')) tx.put(w.entityId,{...w,status:'cancelled'});
  }
}

/** Explicit control-plane renewal only. Acknowledgement history and the sealed E are never reset. */
function reopenExecutionTurnDecision(tx,command) {
  if(command.autonomy!=='on')fail('DENIED');
  const authority=resolveAuthority(tx,command,{operator:true}),p=command.payload??{},E=executionIdentity(p.E);
  const key='execution-alert:'+E.executionEpoch,alert=tx.read(key),scope=tx.read(executionScopeId(E));
  if(!sameExecution(alert?.E,E)||!sameExecution(scope?.E,E)||scope.state==='RELEASED'||!scope.coverageGaps?.includes('unpermitted-turn'))fail('STALE_EXECUTION');
  if(command.entityId!==key||p.previousDecisionId!==alert.decisionId)fail('DECISION_STALE');
  if(typeof p.reason!=='string'||!p.reason.trim())fail('MISSING_EVIDENCE');
  const previous=tx.read(alert.decisionId),now=command.now??Date.now();
  if(!previous||previous.kind!=='stuck-member'||previous.subject?.id!==key||
    !(previous.state==='expired'||(previous.state==='open'&&Number.isFinite(previous.expiresAt)&&previous.expiresAt<=now)))fail('DECISION_NOT_EXPIRED');
  const round=(alert.decisionRound??0)+1,decisionId='decision:execution-turn:'+E.executionEpoch+':reopen:'+round;
  if(tx.read(decisionId))fail('DECISION_STALE');
  if(previous.state==='open')tx.put(previous.entityId,{...previous,state:'expired',expiredAt:now});
  const next=tx.put(key,{...alert,decisionId,decisionRound:round,previousDecisionId:previous.entityId,
    reopenedBy:command.actor,reopenedAt:now,reopenReason:p.reason});
  openDecision(tx,{autonomy:'on',now},{kind:'stuck-member',subject:{type:'execution-alert',id:key,revision:next.revision},
    evidence:[{kind:'execution-turn-contract',ref:key,at:now,text:'Explicit renewal for the same sealed E: '+p.reason}],
    openedFor:'operator',decisionId,now,ttlMs:command.decisionTtlMs,fallback:'escalate'});
  tx.put('audit:'+id('audit'),{kind:'execution-turn-decision-reopen',E,alertId:key,previousDecisionId:previous.entityId,decisionId,
    by:command.actor,byKind:authority.kind,reason:p.reason,at:now,operationId:command.operationId,
    applied:'manual decision reopened only; scope, coverage gaps and occupancy unchanged'});
  return {alertId:key,decisionId,previousDecisionId:previous.entityId,E};
}

export const executionCommands = {
  'execution.reopen-decision':reopenExecutionTurnDecision,
  'execution.record'(tx, command) {
    if (command.actor !== 'adapter' || command.autonomy !== 'on') fail('DENIED');
    return recordExecution(tx,command.payload.snapshot,{now:command.now??Date.now(),ttlMs:command.decisionTtlMs});
  },
  'execution.close'(tx, command) {
    if (command.actor !== 'adapter' || command.autonomy !== 'on') fail('DENIED');
    const { proof,evidenceRef,purpose,status } = command.payload;
    const attempt = tx.read(proof?.E?.attemptId);
    return closeExecution(tx,{proof,evidenceRef,purpose,status,attempts:attempt ? [attempt] : [],intentProtocol:command.intentProtocol});
  },
};
