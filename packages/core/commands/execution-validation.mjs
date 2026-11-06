import { sameExecution,executionScopeId,scopeCertificateMatches } from '../../contracts/index.mjs';
const held=a=>['active','unknown'].includes(a?.lease);
const certificates=proof=>proof?.contract==='execution-stop-set/1'?proof.certificates:[proof];

/** A consumed certificate remains stop evidence, never permission to act on a new epoch. */
export function consumedStopMatches(tx,cert) {
 const E=cert?.E,row=E&&tx.read(executionScopeId(E)),a=E&&tx.read(E.attemptId),original=row?.closeoutResult?.proof;
 return Boolean(cert?.verified && sameExecution(row?.E,E) && row.state==='RELEASED' && row.stopId===cert.stopId &&
  row.consumedCertificate===cert.certificateId && original?.scopeVersion===cert.scopeVersion && original?.certificateId===cert.certificateId &&
  original?.stopId===cert.stopId && sameExecution(original?.E,E) && original?.coverage?.complete===true &&
  a && !held(a) && a.owner===E.memberId && a.generation===E.generation && a.fence===E.attemptFence && a.executionSessionId===E.executionSessionId);
}
export function canFinishStoppedGeneration(tx,proof,memberId,generation) {
 const certs=certificates(proof);if(!proof?.verified || !Array.isArray(certs)||!certs.length || tx.read(memberId)?.generation!==generation)return false;
 const epochs=new Set(),covered=new Set();
 for(const cert of certs){const E=cert?.E;if(!E || E.memberId!==memberId || E.generation!==generation || epochs.has(E.executionEpoch))return false;
  const a=tx.read(E.attemptId);if(!a || (held(a)?!canCloseExecution(tx,cert,[a]):!consumedStopMatches(tx,cert)))return false;
  epochs.add(E.executionEpoch);covered.add(E.attemptId);
 }
 if(tx.list('attempt:').some(a=>a.owner===memberId&&a.generation===generation&&held(a)&&!covered.has(a.entityId)))return false;
 const certifiedRows=certs.map(c=>tx.read(executionScopeId(c.E))),latestOpened=Math.max(...certifiedRows.map(s=>s?.epochOpenedSeq??-1));
 if(tx.list('execution-scope:').some(s=>s.E?.memberId===memberId&&s.E.generation===generation&&!epochs.has(s.E.executionEpoch)&&
   (s.state!=='RELEASED'||!Number.isSafeInteger(s.epochOpenedSeq)||s.epochOpenedSeq>latestOpened)))return false;
 return true;
}
export function consumedGenerationProof(tx,memberId,generation) {
 if(tx.read(memberId)?.generation!==generation)return null;
 const rows=tx.list('execution-scope:').filter(r=>r.E?.memberId===memberId&&r.E.generation===generation&&r.state==='RELEASED'&&consumedStopMatches(tx,r.closeoutResult?.proof));
 if(!rows.length)return null;
 const certs=rows.map(r=>r.closeoutResult.proof),subject={kind:'member-session',id:memberId,fence:generation};
 const proof=certs.length===1?{...certs[0],subject}:{kind:'stop-proof',contract:'execution-stop-set/1',subject,verified:true,stopState:'proven',certificates:certs,writtenBy:'adapter',switch:'on'};
 return canFinishStoppedGeneration(tx,proof,memberId,generation)?proof:null;
}
export function stoppedTransitionMatches(tx,proof,memberId,generation,kind) {
 const transition=tx.read('member-stop-transition:'+memberId+':'+generation+':'+kind),member=tx.read(memberId),certs=certificates(proof);
 if(!transition || !proof?.verified || member?.generation!==generation+1 || member.status!==(kind==='dispose'?'retired':'frozen') || !Array.isArray(certs)||!certs.length)return false;
 const recorded=certificates(transition.proof);
 if(recorded.length!==certs.length||certs.some(c=>!consumedStopMatches(tx,c)||!recorded.some(r=>sameExecution(r.E,c.E)&&r.stopId===c.stopId&&r.certificateId===c.certificateId&&r.scopeVersion===c.scopeVersion)))return false;
 return !tx.list('execution-scope:').some(s=>s.E?.memberId===memberId&&s.state!=='RELEASED') && !tx.list('attempt:').some(a=>a.owner===memberId&&held(a));
}
export function canCloseExecution(tx, proof, attempts) {
  const certs = certificates(proof);
  if (!proof?.verified || !Array.isArray(certs) || certs.length !== attempts.length || !attempts.length) return false;
  const seen = new Set();
  for (const attempt of attempts) {
    const cert = certs.find(c => c?.E?.attemptId === attempt.entityId);
    const E = cert?.E, row = E && tx.read(executionScopeId(E)), pointer = tx.read('execution-current:' + attempt.entityId);
    if (!E || !held(attempt) || seen.has(E.executionEpoch) || !scopeCertificateMatches(row,cert) || !sameExecution(pointer?.E,E) ||
        (attempt.teamId && attempt.teamId!==E.teamId) || pointer.state !== 'PROVEN' || pointer.stopId!==cert.stopId || pointer.version!==cert.scopeVersion || attempt.owner !== E.memberId || attempt.generation !== E.generation ||
        attempt.fence !== E.attemptFence || attempt.executionSessionId !== E.executionSessionId ||
        tx.read(E.memberId)?.generation !== E.generation) return false;
    const unsettled = typeof tx.effects === 'function' ? tx.effects() : tx.list('effect:');
    if(unsettled.some(effect=>{
      if(!['pending','retryable','applying'].includes(effect.status) || !['start','dispatch','wake','message','intent-result'].includes(effect.payload?.kind))return false;
      const bound=tx.read('effect-execution:' + (effect.id??effect.entityId?.slice(7)));
      return bound ? bound.attemptId===E.attemptId && bound.fence===E.attemptFence :
        effect.payload?.attemptId===E.attemptId || effect.id===E.attemptId;
    }))return false;
    seen.add(E.executionEpoch);
  }
  return true;
}
