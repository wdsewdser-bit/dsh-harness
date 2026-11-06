import { sameExecution } from '../contracts/index.mjs';

/** Target selection belongs to the effect semantics, not optional recipient-shaped fields. */
export function effectExecutionTarget(store,payload) {
  const p=payload??{};
  if(p.kind==='intent-result') {
    const message=store.read(p.messageId),initiator=message?.initiator;
    if(!initiator || initiator.memberId!==message.sender)return {kind:'invalid',reason:'intent has no trusted initiator'};
    if(initiator.kind==='owner')return store.read(message.sender)?.role==='root'?{kind:'control',memberId:message.sender,initiator}:{kind:'invalid',reason:'invalid owner initiator'};
    const attempt=store.read(initiator.attemptId);
    if(initiator.kind!=='execution' || !attempt || attempt.owner!==message.sender || attempt.fence!==initiator.fence || attempt.generation!==initiator.generation)
      return {kind:'invalid',reason:'intent initiator execution changed'};
    if(initiator.E && !sameExecution(initiator.E,store.read('execution-current:'+attempt.entityId)?.E))return {kind:'invalid',reason:'intent initiator epoch changed'};
    return {kind:'execution',memberId:message.sender,attempt,initiator};
  }
  const memberId=p.owner??p.memberId??p.recipient??store.read(p.attemptId)?.owner??store.read(p.messageId)?.recipient;
  const attempt=p.attemptId?store.read(p.attemptId):null;
  return {kind:'execution',memberId,attempt};
}

export function permitEffectPort({store,scopes,handles,invoke,kind}) {
  return async request=>{
    const effect=store.effects().find(e=>e.id===request.operationId),payload=effect?.payload??{...request,kind};
    const target=effectExecutionTarget(store,payload);
    if(target.kind==='invalid')return {notExecuted:true,reason:target.reason};
    const trusted=kind==='intent-result'?{...request,initiator:target.initiator}:request;
    if(target.kind==='control')return invoke(trusted); // durable owner receipt only; no agent/native IO
    const sid=target.attempt?.executionSessionId??handles.get(target.memberId)?.agent?.session?.id;
    let scope,token;
    try {
      scope=scopes.resolve(sid);
      if(!scope || scope.E.memberId!==target.memberId || (target.attempt && (scope.E.attemptId!==target.attempt.entityId || scope.E.attemptFence!==target.attempt.fence || scope.E.generation!==target.attempt.generation)))
        return {notExecuted:true,reason:'execution scope unavailable before IO'};
      token=scope.acquire('effect',{effectId:request.operationId});
    }catch(error){return {notExecuted:true,reason:error.code??error.message};}
    try {const answer=await scope.run(()=>invoke(trusted));scope.finish(token,answer?.unknown?'unknown':answer?.notExecuted?'notExecuted':'executed');return answer;}
    catch(error){scope.finish(token,'unknown');throw error;}
  };
}
