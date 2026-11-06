import { randomUUID } from 'node:crypto';
/** Explicit complete-domain fixture, not a production proof shortcut. Each row is scoped and durable. */
export function certificate(core, subject, {attemptId=null, verified=true}={}) {
  const direct=core.store.read(attemptId??subject.id);
  const a=direct?.entityId.startsWith('attempt:')?direct:core.store.list('attempt:').find(a=>a.owner===subject.id);
  if(!a)return {kind:'stop-proof',subject,verified:false,error:{code:'EXECUTION_SCOPE_MISSING'}};
  const E=core.store.read('execution-current:'+a.entityId)?.E??{teamId:core.configuration.teamId??'team',memberId:a.owner,generation:a.generation,
    executionSessionId:a.executionSessionId??'fixture:'+a.entityId,attemptId:a.entityId,attemptFence:a.fence,executionEpoch:randomUUID()};
  const coverage={gates:true,attribution:true,transport:true,subprocess:true,complete:true};
  const proof={kind:'stop-proof',contract:'execution-stop/1',E,subject,verified,stopState:verified?'proven':'unverified',
    stopId:core.store.read('execution-current:'+a.entityId)?.stopId??randomUUID(),scopeVersion:3,certificateId:randomUUID(),coverage,method:
      'sealed-execution',confidence:'medium',writtenBy:'adapter',switch:'on'};
  core.mutate('fixture-scope:'+E.executionEpoch,'adapter',{},tx=>{
    if(a.executionSessionId!==E.executionSessionId)tx.put(a.entityId,{...a,executionSessionId:E.executionSessionId});
    tx.put('execution-scope:'+E.executionEpoch,{E,state:verified?'PROVEN':'UNVERIFIED',version:3,stopId:proof.stopId,certificateId:proof.certificateId,
      coverage,active:0,uncertain:0});
    tx.put('execution-current:'+E.attemptId,{E,state:verified?'PROVEN':'UNVERIFIED',version:3,stopId:proof.stopId});
    return null;
  });
  return proof;
}
