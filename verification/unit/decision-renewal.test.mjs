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

for(const entry of ['owner','operator'])test('expired E decision explicitly renews via '+entry+' without changing gap, leases or automatic dedup',async()=>{
    const w=await world();try{
 await w.ctx.emit('session/event',w.agent.session,{type:'turn/start'});await w.ctx.emit('session/event',w.agent.session,{type:'turn/start'});await w.ctx
 .emit('session/event',w.agent.session,{type:'turn/end'});
 const key='execution-alert:'+w.scope.E.executionEpoch,first=w.runtime.store.read(key),actor=entry==='owner'?'member:root':'operator';
 const run=()=>w.runtime.host.executeAuthorized('operator',()=>w.runtime.core.reopenExecutionTurnDecision(w.scope.E,actor,{previousDecisionId:first.decisionId,
       reason:'review quarantine after expired TTL'},entry));
 assert.throws(run,/DECISION_NOT_EXPIRED/);
 w.runtime.host.executeAuthorized('operator',()=>w.runtime.core.dispatch('clock','scheduler',{now:Date.now()+3600000},{type:'decision.expire',payload:{now:Date
         .now()+3600000}},{now:Date.now()+3600000}));
 assert.equal(w.runtime.store.read(first.decisionId).state,'expired');assert.throws(()=>w.runtime.host.executeAuthorized('operator',()=>w.runtime.core
     .decideDecision(first.decisionId,actor,{decision:'wait'},entry)),/DECISION_STALE/);
 const before=JSON.stringify({scope:w.scope.snapshot(),row:w.runtime.store.read('execution-scope:'+w.scope.E.executionEpoch),attempt:w.runtime.store.read(w
       .attempt.entityId)});
 assert.throws(()=>w.runtime.host.executeAuthorized('operator',()=>w.runtime.core.reopenExecutionTurnDecision({...w.scope.E,generation:w.scope.E.generation+1},
       actor,{previousDecisionId:first.decisionId,reason:'wrong generation'},entry)),/STALE_EXECUTION/);
 assert.throws(()=>w.runtime.host.executeAuthorized('operator',()=>w.runtime.core.reopenExecutionTurnDecision(w.scope.E,'member:w',{previousDecisionId:first
         .decisionId,reason:'forged owner'},'owner')),/DENIED|REFERENCE_ACL/);
 assert.throws(()=>w.runtime.host.executeAuthorized('operator',()=>w.runtime.core.reopenExecutionTurnDecision(w.scope.E,actor,{previousDecisionId:first
         .decisionId,reason:''},entry)),/MISSING_EVIDENCE/);
 assert.throws(()=>w.runtime.host.executeAuthorized('operator',()=>w.runtime.core.reopenExecutionTurnDecision(w.scope.E,'member:root',{previousDecisionId:first
         .decisionId,reason:'owner may not impersonate operator'},'operator')),/DENIED/);
 const renewed=run().result;assert.notEqual(renewed.decisionId,first.decisionId);assert.equal(renewed.previousDecisionId,first.decisionId);
 assert.deepEqual(renewed.E,w.scope.E);
 assert.equal(JSON.stringify({scope:w.scope.snapshot(),row:w.runtime.store.read('execution-scope:'+w.scope.E.executionEpoch),attempt:w.runtime.store.read(w
         .attempt.entityId)}),before);
 assert.equal(w.runtime.store.read(first.decisionId).state,'expired');assert.equal(w.runtime.store.read(renewed.decisionId).state,'open');assert.equal(w.runtime
   .store.list('execution-alert:').length,1);
 assert.throws(run,/DECISION_STALE/);await w.runtime.host.cycle.run();assert.equal(w.runtime.store.list('decision:').filter(d=>d.kind==='stuck-member').length,
   2);assert.equal(w.runtime.store.read(key).decisionId,renewed.decisionId);
 w.runtime.host.executeAuthorized('operator',()=>w.runtime.core.decideDecision(renewed.decisionId,actor,{decision:'wait'},entry));assert.equal(w.runtime.store
   .read(renewed.decisionId).state,'decided');
 assert.ok(w.runtime.store.list('audit:').some(a=>a.kind==='execution-turn-decision-reopen'&&a.previousDecisionId===first.decisionId&&a.by===actor&&a
     .byKind===entry));assert.equal(w.scope.state(),'UNVERIFIED');assert.equal(w.runtime.store.read(w.attempt.entityId).lease,'active');assert.equal(
     w.runtime.store
   .list('break-glass:').length,0);
 }finally{await w.close();}});
