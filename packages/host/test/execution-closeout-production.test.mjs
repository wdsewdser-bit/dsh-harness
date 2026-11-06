import test from 'node:test';import assert from 'node:assert/strict';
import { profile,until } from '../test-support/profile.mjs';
import { closeEffect } from '../src/effects/protocol.mjs';
import {applyLifecycle} from '../../core/index.mjs';
function command(w,type,id,extra={}) {return w.runtime.host.command({teamId:w.runtime.host.teamId,actor:'root',requestId:id,
 operationId:'v1:operation:'+id.replaceAll(':','-').padEnd(20,'x'),payload:{command:type,entityId:id,...extra}});}
async function world(){
 const calls={wakes:0};
 const w=await profile({autonomy:'on',collab:'off'},async({ctx,sessions})=>{
  ctx.agents.create=async opts=>{
   const session={id:opts.sessionId,seq:0,snapshotEvents:()=>[]};
   const agent={session,phase:{kind:'idle'},wakeDriver(){calls.wakes++;agent.phase={kind:'running'};},preemptStep(){return false;},cancel(){},async whenIdle(
     ){},
    ctx:{tools:{register(){},restrict(){},guard(){}}}};sessions.set(session.id,session);return {agent,async dispose(){}};
  };
 });
 command(w,'team.member.request','member-intent:w',{role:'worker'});
 await until(()=>w.runtime.handles.has('member:w'));
 command(w,'team.task.request','task:work',{owner:'member:w',plannedDelivery:'delivery:product'});
 await until(()=>w.runtime.store.list('attempt:').some(a=>a.taskId==='task:work'&&a.status==='running'));
 const attempt=w.runtime.store.list('attempt:').find(a=>a.taskId==='task:work'&&a.status==='running');
 await until(()=>w.runtime.store.read('attempt-dispatch:'+attempt.entityId));await w.runtime.runner.whenIdle();
 const agent=w.runtime.handles.get('member:w').agent,scope=w.runtime.executionScopes.get(agent.session.id);
 // This fixture has no subprocess or provider; explicitly assert complete pure-memory coverage, not a production fallback.
 scope.coverage('transport',true);scope.coverage('subprocess',true);
 return Object.assign(w,{calls,attempt,agent,scope});
}

test('full host bounded produce/drain orders: completion intent publishes produced, never cancelled',async()=>{
 for(const completeBeforeEnd of [false,true]){
  const w=await world();try{
   const {scope,agent,attempt}=w;
   await w.ctx.emit('session/event',agent.session,{type:'turn/start',data:{turn:1}});
   if(!completeBeforeEnd)await w.ctx.emit('session/event',agent.session,{type:'turn/end',data:{turn:1}});
   w.ctx.agents.currentInitiator=()=>({session:agent.session});
   const finish=scope.run(()=>w.globalTools.get('team_task').execute({operationId:'v1:operation:closeout-produce-0001',op:'produce',taskRef:'task:work',
     deliveryRef:'delivery:product'}));
   assert.equal(finish.result.completionPending,true);assert.equal(w.runtime.store.read('task:work').status,'executing');
   if(completeBeforeEnd){await w.runtime.host.cycle.run();assert.equal(w.runtime.store.read(attempt.entityId).lease,'active');await w.ctx.emit(
     'session/event',agent.session,{type:'turn/end',data:{turn:1}});}
   await until(()=>w.runtime.store.read('task:work').status==='produced');
   assert.equal(w.runtime.store.read(attempt.entityId).lease,'released');assert.equal(w.runtime.store.read(attempt.entityId).status,'produced');
   assert.equal(w.runtime.store.read('task:work').deliveryRef,'delivery:product');assert.equal(scope.state(),'RELEASED');
  }finally{await w.close();}
 }
});

test('full host intent-result targets trusted sender E; owner result is durable-only without a member scope',async()=>{
 for(const owner of [true,false])for(const sealBeforeReceipt of [false,true]){
  const w=await world();try{
   const {agent,attempt,scope}=w;
   const sender=owner?'member:root':'member:w';
   const intent=w.runtime.host.executeAuthorized('business',()=>w.runtime.core.send(sender,['member:w'],'intent','interface',{taskRef:'task:work',
     contractRevision:1})).result.entityId;
   const row=w.runtime.store.read(intent);assert.equal(row.sender,sender);assert.ok(row.recipients);assert.equal(row.recipient,undefined);
   // Remove only the independent recipient wake, not the real closeIntent result producer under test.
   await w.runtime.runner.whenIdle();agent.phase={kind:'idle'};
   if(sealBeforeReceipt)scope.seal();
   const before=w.calls.wakes;
   w.runtime.host.executeAuthorized('business',()=>w.runtime.core.replyIntent(intent,'member:w','object'));
   await until(()=>w.runtime.store.effects().some(e=>e.id==='intent-result:'+intent&&['confirmed','retryable','dead-letter','unknown'].includes(e.status)));
   const effect=w.runtime.store.effects().find(e=>e.id==='intent-result:'+intent);
   if(owner){assert.equal(effect.status,'confirmed');assert.equal(effect.lastEvidence.receipt.owner,sender);assert.equal(w.calls.wakes,before);}
   else if(sealBeforeReceipt){assert.notEqual(effect.status,'confirmed');assert.equal(w.calls.wakes,before);}
   else {assert.equal(effect.status,'confirmed');assert.equal(w.calls.wakes,before+1);assert.equal(w.runtime.store.read('effect-execution:'+
     effect.id).attemptId,attempt.entityId);}
  }finally{await w.close();}
 }
});

test('production cancel effect supersedes both current and stale completion targets without publishing',async()=>{
 for(const changed of [false,true]){
  const w=await world();try{
   w.ctx.agents.currentInitiator=()=>({session:w.agent.session});
   w.scope.run(()=>w.globalTools.get('team_task').execute({operationId:'v1:operation:closeout-cancel-0001',op:'produce',taskRef:'task:work',deliveryRef:
     'delivery:product'}));
   if(changed)w.runtime.host.executeAuthorized('business',()=>w.runtime.core.mutate('change-target','scheduler',{},tx=>tx.put('task:work',{...tx.read(
     'task:work'),contractRevision:2})));
   w.scope.seal();const proof=w.scope.prove({kind:'attempt',id:w.attempt.entityId,fence:w.attempt.fence});assert.equal(proof.verified,true);
   w.runtime.host.executeAuthorized('operator',()=>w.runtime.core.mutate('cancel-target','adapter',{},tx=>{closeEffect(tx,{id:'cancel:completion',payload:{
     kind:'cancel',attemptId:w.attempt.entityId}},{executed:true,receipt:{stopProof:proof}},{revisions:[]},{autonomy:true});return null;}));
   w.scope.released(proof);assert.equal(w.runtime.store.read('task:work').status,'failed');assert.equal(w.runtime.store.read(w.attempt.entityId).lease,
     'revoked');
   assert.equal(w.runtime.store.read('execution-finish:'+w.scope.E.executionEpoch).state,'superseded');assert.equal(w.runtime.store.list(
     'break-glass:').length,0);
  }finally{await w.close();}
 }
});

test('applying cancellation owns purpose before real prover await; automatic completion cannot publish and concurrent proofs join',async()=>{
 const w=await world();try{
  let resume,entered;const idle=new Promise(r=>resume=r),ready=new Promise(r=>entered=r);let cancels=0;
  w.agent.cancel=()=>{cancels++;};w.agent.whenIdle=()=>{entered();return idle;};
  w.ctx.agents.currentInitiator=()=>({session:w.agent.session});
  w.scope.run(()=>w.globalTools.get('team_task').execute({operationId:'v1:operation:closeout-await-0001',op:'produce',taskRef:'task:work',deliveryRef:
    'delivery:product'}));
  w.runtime.host.executeAuthorized('operator',()=>w.runtime.core.mutate('cancel-applying','adapter',{},tx=>{tx.put(w.attempt.entityId,{...tx.read(
    w.attempt.entityId),lease:'unknown'});tx.outbox('cancel:await',{kind:'cancel',attemptId:w.attempt.entityId});return null;}));
  const claim=w.runtime.store.claim(w.runtime.core.command('claim:cancel-await','adapter',{}),'cancel:await','adapter',Date.now()).result;
  assert.equal(w.runtime.store.effects().find(e=>e.id==='cancel:await').status,'applying');
  const prover=w.runtime.core.ports.stopProof; // the real installed prover, not a manufactured certificate
  const args={subject:{kind:'member-session',id:'member:w',fence:w.attempt.generation},operation:'cancel',agent:w.agent};
  const first=prover(args),second=prover(args);assert.equal(first,second);await ready;
  assert.equal(w.runtime.store.read('execution-scope:'+w.scope.E.executionEpoch).closeoutPurpose,'cancel');
  await w.runtime.host.cycle.run('during-prover-await');await Promise.resolve();
  assert.equal(w.runtime.store.read('task:work').status,'executing');assert.equal(w.runtime.store.read(w.attempt.entityId).lease,'unknown');
  resume();const proof=await first;assert.equal(proof.verified,true);assert.equal(cancels,1);
  w.runtime.host.executeAuthorized('operator',()=>w.runtime.core.mutate('close:cancel-await','adapter',{},tx=>{closeEffect(tx,{id:'cancel:await',payload:{
    kind:'cancel',attemptId:w.attempt.entityId}},{executed:true,receipt:{stopProof:proof}},{revisions:[]},{autonomy:true});return null;}));
  w.scope.released(proof);w.runtime.host.executeAuthorized('operator',()=>w.runtime.core.mutate('late-cancel','adapter',{},tx=>{closeEffect(tx,{id:
    'cancel:await',payload:{kind:'cancel',attemptId:w.attempt.entityId}},{executed:true,receipt:{stopProof:proof}},{revisions:[[w.attempt.entityId,0]]},{
    autonomy:true});return null;}));const late=await prover(args);assert.equal(late.verified,true);assert.equal(late.closeoutResult.status,'failed');
    assert.equal(cancels,1);
  assert.equal(w.runtime.store.read('task:work').status,'failed');assert.equal(w.runtime.store.read('execution-finish:'+w.scope.E.executionEpoch).state,
    'superseded');
 }finally{await w.close();}
});

test('cancel and dispose share evidence in both consumption orders; repeated lifecycle closeouts do not become unknown',async()=>{
 for(const native of [false,true])for(const cancelFirst of [false,true]){
  const w=await world();try{
   const prover=w.runtime.core.ports.stopProof;let resume,cancels=0;const idle=new Promise(r=>resume=r);
   w.agent.cancel=()=>{cancels++;};w.agent.whenIdle=()=>idle;
   const args={subject:{kind:'member-session',id:'member:w',fence:w.attempt.generation},agent:w.agent};
   const cancel=prover({...args,operation:'cancel'}),dispose=prover({...args,operation:'dispose'});assert.equal(cancel,dispose);resume();const proof=
     await cancel;
   const closeCancel=()=>w.runtime.host.executeAuthorized('operator',()=>w.runtime.core.mutate('cancel:shared','adapter',{},tx=>{closeEffect(tx,{id:
     'cancel:shared',payload:{kind:'cancel',attemptId:w.attempt.entityId}},{executed:true,receipt:{stopProof:proof}},{revisions:[]},{autonomy:true});
     return null;}));
   const closeDispose=async()=>{
    if(native){w.runtime.core.ports.dispose=async()=>({stopped:true,stopProof:proof});return applyLifecycle(w.runtime.core,'member:w','dispose');}
    return w.runtime.host.executeAuthorized('operator',()=>w.runtime.core.mutate('dispose:shared','adapter',{},tx=>{closeEffect(tx,{id:'dispose:shared',
      payload:{kind:'dispose',memberId:'member:w',generation:w.attempt.generation}},{executed:true,receipt:{stopped:true,stopProof:proof}},{revisions:[]},{
      autonomy:true});return null;}));
   };
   if(cancelFirst){closeCancel();await closeDispose();}else{await closeDispose();closeCancel();}
   await closeDispose();closeCancel();
   const m=w.runtime.store.read('member:w');assert.equal(m.status,'retired');assert.equal(m.generation,w.attempt.generation+1);assert.equal(
     w.runtime.store.read(w.attempt.entityId).lease,'revoked');assert.equal(cancels,1);
   assert.equal(w.runtime.store.list('decision:').filter(d=>d.kind==='stuck-member').length,0);
  }finally{await w.close();}
 }
});



