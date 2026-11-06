import test from 'node:test';import assert from 'node:assert/strict';
import {profile,until} from '../../packages/host/test-support/profile.mjs';import {openExecutionTurnAlert} from '../../packages/core/index.mjs';
async function world(){const w=await profile({autonomy:'on'},async({ctx,sessions})=>{ctx.agents.create=async opts=>{const agent={session:{id:opts.sessionId,
            seq:0,snapshotEvents:()=>[]},phase:{kind:'idle'},wakeDriver(){agent.phase={kind:'running'};},preemptStep(){return false;},cancel(){},async whenIdle(
              ){},ctx:{
            tools:{register(){},restrict(){},guard(){}}}};sessions.set(agent.session.id,agent.session);return {agent,async dispose(){}};};});
 const cmd=(type,id,extra={})=>w.runtime.host.command({teamId:w.runtime.host.teamId,actor:'root',requestId:id,operationId:'v1:operation:'+id.replaceAll(':','-')
     .padEnd(20,'x'),payload:{command:type,entityId:id,...extra}});cmd('team.member.request','member-intent:w',{role:'worker'});await until(()=>
     w.runtime.handles
   .has('member:w'));cmd('team.task.request','task:alert',{owner:'member:w'});await until(()=>w.runtime.store.list('attempt:').some(a=>a.taskId==='task:alert'
   &&a
     .status==='running'));const attempt=w.runtime.store.list('attempt:').find(a=>a.taskId==='task:alert'&&a.status==='running');await until(()=>w.runtime.store
   .read('attempt-dispatch:'+attempt.entityId));await w.runtime.runner.whenIdle();const agent=w.runtime.handles.get('member:w').agent,scope=w.runtime
 .executionScopes.get(agent.session.id);scope.coverage('transport',true);scope.coverage('subprocess',true);return Object.assign(w,{agent,scope,attempt,
     command:cmd});}
test('rejected turn atomically seals UNVERIFIED and opens one actionable E-bound root/operator decision',async()=>{const w=await world();try{const {scope,agent}
      =w,emit=type=>w.ctx.emit('session/event',agent.session,{type});await emit('turn/start');const rejected=emit('turn/start');
 assert.ok(w.runtime.store.read('execution-alert:'+scope.E.executionEpoch),'alert must be committed before yielding to host recovery');await rejected;
 const fault=scope.snapshot();assert.equal(fault.state,'UNVERIFIED');assert.deepEqual(fault.coverageGaps,['unpermitted-turn']);assert.equal(fault.turnFault
   .code,'TURN_ALREADY_OPEN');assert.throws(()=>scope.acquire('call'),e=>e.code==='EXECUTION_SEALED');
 const alert=w.runtime.store.read('execution-alert:'+scope.E.executionEpoch);assert.ok(alert,'fault reservation must atomically publish an actionable alert');
 const decision=w.runtime.store.read(alert.decisionId);assert.deepEqual(alert.E,scope.E);assert.equal(alert.occupancy,'retained');assert.equal(alert.code,
   'TURN_ALREADY_OPEN');assert.ok(alert.actions.some(a=>a.includes('break-glass')));assert.equal(decision.kind,'stuck-member');assert.equal(decision.openedFor,
   'operator');assert.deepEqual(decision.options,['wait']);
 assert.throws(()=>w.runtime.host.executeAuthorized('operator',()=>w.runtime.core.decideDecision(decision.entityId,'member:w',{decision:'wait'})),
   /DENIED|LEASE|AUTHORITY|REFERENCE_ACL/);
 w.runtime.host.executeAuthorized('operator',()=>w.runtime.core.decideDecision(decision.entityId,'member:root',{decision:'wait',
       reason:'quarantine adapter and inspect E'}));assert.equal(w.runtime.store.read(decision.entityId).state,'decided');assert.ok(w.runtime.store.list(
       'audit:')
   .some(a=>a.decisionId===decision.entityId&&a.option==='wait'));assert.ok(w.runtime.store.list('message:').some(m=>m.decisionRef===decision.entityId&&m
     .recipient==='member:operator'),'existing operator notice is preserved');
 await emit('turn/end');for(let n=0;n<4;n++){await emit('turn/start');await w.runtime.host.cycle.run();}assert.equal(w.runtime.store.list('execution-alert:')
   .length,1);assert.equal(w.runtime.store.list('decision:').filter(d=>d.entityId===decision.entityId).length,1);assert.equal(scope.state(),'UNVERIFIED');
   assert.equal(w.runtime.store.read(w.attempt.entityId).lease,'active');assert.equal(w.runtime.status().executionAlerts.length,1);
   assert.equal(w.runtime.status()
   .executionCloseout.find(c=>c.scope.E.executionEpoch===scope.E.executionEpoch).reason,'unpermitted-turn');
 const returned=w.runtime.host.executeAuthorized('operator',()=>w.runtime.core.mutate('replay:alert','adapter',{},tx=>openExecutionTurnAlert(tx,scope
       .snapshot(),{now:Date.now()+99999999}))).result;assert.equal(returned.decisionId,decision.entityId);assert.equal(w.runtime.store.read(
         decision.entityId).state,
   'decided','dedup survives TTL and acknowledgement');
 }finally{await w.close();}});

test('alerts are per E, stale identities cannot alias them, and expiry never releases a rejected scope',async()=>{const w=await world();try{
 const first=w.scope,emit=(agent,type)=>w.ctx.emit('session/event',agent.session,{type});await emit(w.agent,'turn/start');await emit(w.agent,'turn/start');
 await emit(w.agent,'turn/end');
 w.command('team.member.request','member-intent:v',{role:'worker'});await until(()=>w.runtime.handles.has('member:v'));w.command('team.task.request',
   'task:alert-v',{owner:'member:v'});await until(()=>w.runtime.store.list('attempt:').some(a=>a.taskId==='task:alert-v'&&a.status==='running'));const agent=w
 .runtime.handles.get('member:v').agent,second=w.runtime.executionScopes.get(agent.session.id);await emit(agent,'turn/start');await emit(agent,'turn/start');
 await emit(agent,'turn/end');
 assert.notEqual(first.E.executionEpoch,second.E.executionEpoch);assert.equal(w.runtime.store.list('execution-alert:').length,2);assert.equal(w.runtime.store
   .list('decision:').filter(d=>d.kind==='stuck-member').length,2);
 const wrong=w.runtime.host.executeAuthorized('operator',()=>w.runtime.core.mutate('alert:wrong-E','adapter',{},tx=>openExecutionTurnAlert(tx,{E:{...first.E,
           generation:first.E.generation+1}}))).result;assert.equal(wrong,null);
 w.runtime.host.executeAuthorized('operator',()=>w.runtime.core.dispatch('decision-expire:turn','operator',{now:Date.now()+3600000},{type:'decision.expire',
       payload:{now:Date.now()+3600000}},{now:Date.now()+3600000}));
 await w.runtime.host.cycle.run();assert.equal(first.state(),'UNVERIFIED');assert.equal(second.state(),'UNVERIFIED');assert.equal(w.runtime.store
   .list('execution-alert:').length,2);assert.ok(w.runtime.store.list('decision:').filter(d=>d.kind==='stuck-member').every(d=>d.state==='expired'));
 assert.equal(w.runtime.store.read(w.attempt.entityId).lease,'active');assert.equal(w.runtime.store.list('break-glass:').length,0);
 }finally{await w.close();}});

test('host pump recovers actionable alert from durable gap without an in-memory scope and does not widen E',async()=>{const w=await world();try{
 const original=w.runtime.store.read('execution-scope:'+w.scope.E.executionEpoch),E={...original.E,executionEpoch:'recovered-epoch',
   executionSessionId:'session:recovered-absent',attemptId:'attempt:recovered-absent'};
 w.runtime.host.executeAuthorized('operator',()=>w.runtime.core.mutate('legacy:turn-gap','adapter',{},tx=>tx.put('execution-scope:'+E.executionEpoch,{
         ...original,E,state:'UNVERIFIED',stopId:'recovered-stop',coverageGaps:['unpermitted-turn'],coverage:{...original.coverage,'unpermitted-turn':false,
           complete:false},turnFault:{code:'TURN_ALREADY_OPEN',message:'legacy adapter duplicate',at:1}})));
 assert.equal(w.runtime.executionScopes.get(E.executionSessionId),null);assert.equal(w.runtime.store.read('execution-alert:'+E.executionEpoch),null);await w
 .runtime.host.cycle.run();
 const alert=w.runtime.store.read('execution-alert:'+E.executionEpoch);assert.deepEqual(alert.E,E);assert.equal(alert.code,'TURN_ALREADY_OPEN');assert.equal(w
   .runtime.store.read(alert.decisionId).state,'open');
 w.runtime.host.executeAuthorized('operator',()=>w.runtime.core.decideDecision(alert.decisionId,'operator',{decision:'wait',reason:'operator owns quarantine'},
     'operator'));assert.equal(w.runtime.store.read(alert.decisionId).verdict.byKind,'operator');
 for(let n=0;n<3;n++)await w.runtime.host.cycle.run();assert.equal(w.runtime.store.list('execution-alert:').length,1);assert.equal(w.runtime.store
   .read('execution-scope:'+E.executionEpoch).state,'UNVERIFIED');assert.equal(w.runtime.store.read(w.attempt.entityId).lease,'active');
 }finally{await w.close();}});
