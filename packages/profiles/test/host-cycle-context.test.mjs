import test from 'node:test';import assert from 'node:assert/strict';
import {createCycle} from '../../host/index.mjs';import {createExecutionScopes} from '../execution-scope.mjs';import {
  permitEffectPort} from '../effect-execution.mjs';
test('trusted cycle escapes caller ALS; persistent effect alone selects B, direct cross-member callback stays denied',async()=>{
 const durable=new Map();const scopes=createExecutionScopes({read:id=>durable.get(id)});const open=id=>scopes.open({teamId:'t',memberId:'member:'+id,
   generation:1,attemptId:'attempt:'+id,attemptFence:1,executionSessionId:'s:'+id},{gates:true,attribution:true,transport:true,subprocess:true});
 const a=open('a'),b=open('b');let calls=0,answer;
 const attempt={entityId:'attempt:b',owner:'member:b',generation:1,fence:1,executionSessionId:'s:b'};
 const store={effects:()=>[{id:'send:b',payload:{kind:'dispatch',attemptId:'attempt:b'}}],read:id=>id==='attempt:b'?attempt:null};
 const port=permitEffectPort({store,scopes,handles:new Map(),kind:'dispatch',invoke:async()=>{assert.equal(scopes.current(),b);calls++;return {executed:true};
   }});
 const cycle=createCycle({steps:{pump:async()=>{answer=await port({operationId:'send:b'});}}});
 try{
  const direct=await a.run(()=>port({operationId:'send:b'}));assert.match(direct.reason,/EXECUTION_CONTEXT_MISMATCH/);assert.equal(calls,0);
  await a.run(()=>cycle.kick('member-a'));assert.equal(answer.executed,true);assert.equal(calls,1);
  a.seal();const proof=a.prove({kind:'attempt',id:a.E.attemptId,fence:1});durable.set('execution-scope:'+a.E.executionEpoch,{E:a.E,state:'RELEASED',stopId:
    proof.stopId,version:proof.version+1,consumedCertificate:proof.certificateId});a.released(proof);
  await a.run(()=>cycle.run('stale-member-a'));assert.equal(answer.executed,true);assert.equal(calls,2);
  const stale=await a.run(()=>port({operationId:'send:b'}));assert.match(stale.reason,/EXECUTION_CONTEXT_STALE/);
 }finally{cycle.stop();}
});
