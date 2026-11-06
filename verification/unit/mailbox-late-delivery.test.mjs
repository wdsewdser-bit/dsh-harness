import test from 'node:test';import assert from 'node:assert/strict';
import {profile,until} from '../../packages/host/test-support/profile.mjs';import {createClock} from '../../packages/host/index.mjs';
import { snapshot } from '../../packages/core/index.mjs';
for(const numbered of [false,true])test('delayed initial retry during fallback T2 merges without opening another turn, numbered='+numbered,async()=>{
 let at=Date.now(),release;const clock=createClock({now:()=>at});
 const w=await profile({autonomy:'on',clock},async({ctx,sessions})=>{ctx.agents.create=async opts=>{const agent={session:{id:opts.sessionId,seq:0,
           snapshotEvents:()=>[]},phase:{kind:'idle'},wakeDriver(){agent.phase={kind:'running'};},preemptStep(){return false;},cancel(){},async whenIdle(){},
             ctx:{tools:{
             register(){},restrict(){},guard(){}}}};sessions.set(agent.session.id,agent.session);return {agent,async dispose(){}};};});
 try{const bind=w.runtime.bindAgent;w.runtime.bindAgent=(...args)=>{const agent=bind(...args),scope=w.runtime.executionScopes.get(agent.session.id);scope
     .coverage('transport',true);scope.coverage('subprocess',true);return agent;};
 w.runtime.host.command({teamId:w.runtime.host.teamId,actor:'root',requestId:'member-intent:w',operationId:'v1:operation:late-delivery-memberx',payload:{
       command:'team.member.request',entityId:'member-intent:w',role:'worker'}});await until(()=>w.runtime.handles.has('member:w'));
 const send=(kind,summary)=>w.runtime.host.executeAuthorized('business',()=>w.runtime.core.send('member:root','member:w',kind,summary,kind==='action'?{
       expectedOutcome:'report',deadline:new Date(at+600000).toISOString()}:{}).result.entityId);
 const initial=send('action','initial retry pending before any scope');
 // Pump before the scheduler installs E: the real permit port refuses before IO and persists a bounded retry.
 w.runtime.runner.pump();await w.runtime.runner.whenIdle();
 const initialEffect=()=>w.runtime.store.effects().find(e=>e.payload?.messageId===initial);assert.equal(initialEffect().status,'retryable');
 assert.equal(initialEffect().lastEvidence.notExecuted,true);
 await until(()=>w.runtime.store.list('attempt:').some(a=>a.status==='running'));const attempt=w.runtime.store.list('attempt:').find(a=>a.status==='running');
 await until(()=>w.runtime.store.read('attempt-dispatch:'+attempt.entityId));await w.runtime.runner.whenIdle();
 const agent=w.runtime.handles.get('member:w').agent,scope=w.runtime.executionScopes.get(agent.session.id),event=(type,n)=>({type,...(numbered?{data:{turn:n}}:{
         })});
 await w.ctx.emit('session/event',agent.session,event('turn/start',1));let waiting=false;const gate=new Promise(r=>release=r);agent.whenIdle=()=>{waiting=true;
   return gate;};
 const info=send('info','held delivery');const effect=()=>w.runtime.store.effects().find(e=>e.payload?.messageId===info);await until(()=>waiting&&effect()
   .status==='applying');agent.phase={kind:'idle'};await w.ctx.emit('session/event',agent.session,event('turn/end',1));
 let starts=0;const native=w.runtime.preempt.deliverMail.bind(w.runtime.preempt);w.runtime.preempt.deliverMail=(member,id)=>{if(agent.phase
     .kind!=='idle')return native(member,id);starts++;agent.phase={kind:'running'};for(const fn of [...w.listeners.get('session/event')])fn(agent.session,
     event('turn/start',2));
    // A simulated wake alone is no longer delivery. Model the carrying request at T2's boundary as well.
    const candidate=snapshot(w.runtime.core,member);
    w.runtime.host.coreAccess.lifecycle().visibility(candidate,'native:T2',['seq:T2'],w.runtime.store.read(member).generation,
      {requestId:'request:T2',sessionSeq:2,requestedAt:at});
    return {wake:'woke',dispatched:true};};
 release();await until(()=>effect().status==='confirmed');assert.equal(scope.snapshot().currentTurn!==null,true);
 at=initialEffect().nextDue;await w.runtime.host.cycle.run();await w.runtime.runner.whenIdle();await until(()=>initialEffect().status==='confirmed');
 const evidence={numbered,initialEffect:initialEffect(),starts,turns:w.runtime.turnDiagnostics.map(t=>({type:t.type,turn:t.turn,error:t.error,beforeState:t
         .before.state,beforeTurn:t.before.currentTurn,afterGaps:t.after.coverageGaps}))};
 console.log('LATE_DELIVERY_EVIDENCE '+JSON.stringify(evidence));
 assert.equal(starts,1,'a live T2 is a merge, not a second wake');assert.deepEqual(scope.snapshot().coverageGaps,[]);await w.ctx.emit('session/event',agent
   .session,event('turn/end',2));await until(()=>w.runtime.store.read(attempt.entityId).lease==='revoked');
 }finally{release?.();await w.close();}
});
