import test from 'node:test';import assert from 'node:assert/strict';
import {profile,until} from '../../packages/host/test-support/profile.mjs';import {applyLifecycle} from '../../packages/core/index.mjs';
async function world(){
 const calls={cancel:0,dispose:0,idle:0};let pause=null;const make=id=>{const agent={session:{id,seq:0,snapshotEvents:()=>[]},phase:{kind:'idle'},wakeDriver(){
       agent.phase={kind:'running'};},preemptStep(){return false;},cancel(){calls.cancel++;agent.phase={kind:'idle'};},async whenIdle(){calls.idle++;},ctx:
         {tools:{
         register(){},restrict(){},guard(){}}}};return {agent,async dispose(){calls.dispose++;if(pause)await pause();}};};
 const w=await profile({autonomy:'on',collab:'off'},async({ctx,sessions})=>{
  ctx.agents.create=async options=>{const h=make(options.sessionId);sessions.set(h.agent.session.id,h.agent.session);return h;};
  ctx.agents.resume=async options=>{const h=make(options.resumeSessionId);sessions.set(h.agent.session.id,h.agent.session);return h;};
 });
 const command=(type,id,extra={})=>w.runtime.host.command({teamId:w.runtime.host.teamId,actor:'root',requestId:id,operationId:'v1:operation:'+id.replaceAll(':',
       '-').padEnd(20,'x'),payload:{command:type,entityId:id,...extra}});
 command('team.member.request','member-intent:w',{role:'worker'});await until(()=>w.runtime.handles.has('member:w'));
 command('team.task.request','task:work',{owner:'member:w',plannedDelivery:'delivery:product'});await until(()=>w.runtime.store.list('attempt:').some(a=>a
     .taskId==='task:work'&&a.status==='running'));
 const attempt=w.runtime.store.list('attempt:').find(a=>a.taskId==='task:work'&&a.status==='running');await until(()=>w.runtime.store.read('attempt-dispatch:'
     +attempt.entityId));await w.runtime.runner.whenIdle();
 const handle=w.runtime.handles.get('member:w'),scope=w.runtime.executionScopes.get(handle.agent.session.id);scope.coverage('transport',true);scope
 .coverage('subprocess',true);
 return Object.assign(w,{attempt,handle,scope,calls,pauseDispose(work){pause=work;}});
}
test('real dispose obtains durable consumed stop only after cancel receipt removed memory scope; no prefetched proof or replaced port',async()=>{
 const w=await world();try{
  w.runtime.host.executeAuthorized('operator',()=>w.runtime.core.mutate('cancel:after','adapter',{},tx=>{tx.put(w.attempt.entityId,{...tx.read(w.attempt
              .entityId),lease:'unknown'});tx.outbox('cancel:after',{kind:'cancel',attemptId:w.attempt.entityId});return null;}));
  await until(()=>w.runtime.store.effects().find(e=>e.id==='cancel:after')?.status==='confirmed');
  await until(()=>w.runtime.executionScopes.get(w.handle.agent.session.id)===null);
  const before={...w.calls},preemptBinding=w.runtime.preempt.bindings.get('member:w');
   const wrong=await w.runtime.core.ports.dispose({memberId:'member:w',generation:w.attempt.generation+1});
   assert.equal(wrong.stopped,false,'consumed evidence belongs to the exact generation');assert.deepEqual(w.calls,before);assert.equal(
   w.runtime.preempt.bindings
     .get('member:w'),preemptBinding);
   await applyLifecycle(w.runtime.core,'member:w','dispose');
  const member=w.runtime.store.read('member:w');assert.equal(member.status,'retired');assert.equal(member.generation,w.attempt.generation+1);assert.equal(w
    .runtime.store.read(w.attempt.entityId).lease,'revoked');
  assert.equal(w.calls.cancel,before.cancel);assert.equal(w.calls.idle,before.idle);assert.equal(w.calls.dispose,before.dispose,
    'durable evidence does not control current session');
  assert.equal(w.runtime.store.list('decision:').filter(d=>d.kind==='stuck-member').length,0);
 }finally{await w.close();}
});
test('old dispose awaiting captured handle cleanup cannot remove real resume replacement handle or new E',async()=>{
 const w=await world();let release;try{
  let entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);w.pauseDispose(()=>{entered();return gate;});
  const pending=w.runtime.core.ports.dispose({memberId:'member:w',generation:w.attempt.generation});await ready;
  const proof=w.scope.prove({kind:'member-session',id:'member:w',fence:w.attempt.generation}),payload={proof,evidenceRef:'stop:old-dispose',purpose:'retire'};
  w.runtime.host.executeAuthorized('operator',()=>w.runtime.core.dispatch(w.attempt.entityId,'adapter',payload,{type:'execution.close',payload}));w.scope
  .released(proof);
  w.runtime.host.executeAuthorized('operator',()=>w.runtime.core.mutate('resume-generation','adapter',{},tx=>tx.put('member:w',{...tx.read('member:w'),
          generation:w.attempt.generation+1,status:'active'})));
  await w.runtime.core.ports.resume({memberId:'member:w',nativeRef:w.handle.agent.session.id,cwd:w.root});const replacement=w.runtime.handles.get('member:w');
  assert.notEqual(replacement,w.handle);
  w.runtime.host.executeAuthorized('operator',()=>w.runtime.core.mutate('attempt:new','scheduler',{},tx=>tx.put('attempt:new',{owner:'member:w',
          taskId:'task:new',generation:w.attempt.generation+1,fence:1,lease:'active',executionSessionId:replacement.agent.session.id})));
  w.runtime.bindAgent('member:w',{attemptId:'attempt:new',generation:w.attempt.generation+1,fence:1});const fresh=w.runtime.executionScopes.get(
  replacement.agent
    .session.id);assert.equal(fresh.state(),'OPEN');
  release();const result=await pending;assert.equal(result.retained,true);assert.equal(w.runtime.handles.get('member:w'),replacement);assert.equal(w.runtime
    .executionScopes.get(replacement.agent.session.id),fresh);assert.equal(fresh.state(),'OPEN');
 }finally{release?.();await w.close();}
});
