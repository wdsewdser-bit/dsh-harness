import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore,recordExecution } from '../../core/index.mjs';
import { createExecutionScopes } from '../execution-scope.mjs';

function world(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'execution-finish-')),store=new ControlStore(root),core=new TeamCore(store,{}, {enabled:true,autonomy:'on'});
   core.member('member:w','worker');
 core.mutate('fixture','scheduler',{},tx=>{tx.put('task:w',{owner:'member:w',attemptId:'attempt:w',status:'executing',contractRevision:1});tx.put('attempt:w',{
   owner:'member:w',taskId:'task:w',status:'running',lease:'active',generation:1,fence:1,expiresAt:Date.now()+600000,executionSessionId:'s'});tx.put('wait:w',{
   attemptId:'attempt:w',status:'pending'});return null;});
 const scopes=createExecutionScopes({read:k=>store.read(k),persist:s=>core.mutate('scope','adapter',{},tx=>recordExecution(tx,s))});
 const scope=scopes.open({teamId:'team',memberId:'member:w',generation:1,attemptId:'attempt:w',attemptFence:1,executionSessionId:'s'}, {gates:true,attribution:
   true,transport:true,subprocess:true});
 const finish=(entry='api')=>{const payload={attemptId:'attempt:w',fence:1,status:'produced',deliveryRef:'delivery:product',entry};return core.dispatch(
   'attempt:w','member:w',payload,{type:'attempt.finish',payload});};
 const close=()=>{const proof=scope.prove({kind:'attempt',id:'attempt:w',fence:1}),payload={proof,evidenceRef:'proof:finish',purpose:'complete'};core.dispatch(
   'attempt:w','adapter',payload,{type:'execution.close',payload});scope.released(proof);};
 return {store,core,scope,finish,close,dispose(){store.close();fs.rmSync(root,{recursive:true,force:true});}};
}

test('production reducer bounded finish/drain orders preserve produced and atomically consume its exact completion intent',()=>{
 for(const entry of ['api','tool'])for(const finishFirst of [false,true]){
  const w=world();try{
   const t=w.scope.startTurn('T'),call=w.scope.call(),tx=call.reserve('dispatch',1);
   if(!finishFirst){call.finish(tx);call.close();w.scope.endTurn(t);}
   const receipt=w.finish(entry);assert.equal(receipt.result.completionPending,true);
   assert.equal(w.store.read('attempt:w').lease,'active');assert.equal(w.store.read('task:w').status,'executing');
   assert.throws(()=>w.scope.acquire('late-fallback'),/EXECUTION_SEALED/);
   if(finishFirst){assert.equal(w.scope.prove({kind:'attempt',id:'attempt:w',fence:1}).verified,false);call.finish(tx);call.close();w.scope.endTurn(t);}
   w.close();assert.equal(w.store.read('attempt:w').lease,'released');assert.equal(w.store.read('attempt:w').status,'produced');
   assert.equal(w.store.read('task:w').status,'produced');assert.equal(w.store.read('task:w').deliveryRef,'delivery:product');assert.equal(w.store.read(
     'wait:w').status,'cancelled');
   assert.equal(w.store.list('execution-finish:')[0].state,'completed');
  }finally{w.dispose();}
 }
});

test('normal produce cannot publish over pending/unknown IO or a mutated target task',()=>{
 const w=world();try{
  const pending=w.scope.acquire('pending-spawn');w.finish();w.scope.seal();
  assert.equal(w.scope.prove({kind:'attempt',id:'attempt:w',fence:1}).verified,false);assert.equal(w.store.read('task:w').status,'executing');
  w.scope.finish(pending);w.core.mutate('task:w','scheduler',{},tx=>tx.put('task:w',{...tx.read('task:w'),contractRevision:2}));
  assert.throws(w.close,/STALE_EXECUTION_FINISH/);assert.equal(w.store.read('attempt:w').lease,'active');assert.equal(w.store.read('wait:w').status,'pending');
 }finally{w.dispose();}
});

test('a stop-sealed execution cannot create a later produced intent',()=>{
 const w=world();try{w.scope.seal();assert.throws(()=>w.finish(),/EXECUTION_NOT_OPEN_FOR_FINISH/);assert.equal(w.store.read('task:w').status,'executing');
   }finally{w.dispose();}
});

test('cancel/retire supersedes completion atomically even after target revision changed',()=>{
 for(const changed of [false,true])for(const purpose of ['cancel','retire']){
  const w=world();try{
   w.finish();if(changed)w.core.mutate('change','scheduler',{},tx=>tx.put('task:w',{...tx.read('task:w'),contractRevision:2}));
   w.scope.seal();const proof=w.scope.prove({kind:'attempt',id:'attempt:w',fence:1});assert.equal(proof.verified,true);
   const payload={proof,evidenceRef:'proof:cancel',purpose,status:'failed'};w.core.dispatch('attempt:w','adapter',payload,{type:'execution.close',payload});
   assert.equal(w.store.read('attempt:w').lease,'revoked');assert.equal(w.store.read('task:w').status,'failed');
   assert.equal(w.store.list('execution-finish:')[0].state,'superseded');assert.equal(w.store.list('break-glass:').length,0);
  }finally{w.dispose();}
 }
});

test('coverage gaps are irreversible in scope and reducer, distinct from initial missing capability',()=>{
 const isolated=createExecutionScopes().open({teamId:'t',memberId:'m',generation:1,attemptId:'isolated',attemptFence:1,executionSessionId:'isolated'},{gates:
   true,attribution:true,transport:true,subprocess:true});isolated.invalidate('transport');assert.throws(()=>isolated.coverage('transport',true),
   /COVERAGE_GAP_IRREVERSIBLE/);
 const w=world();try{
  w.scope.invalidate('transport');assert.throws(()=>w.scope.coverage('transport',true),/COVERAGE_GAP_IRREVERSIBLE/);
  const old=w.store.read('execution-scope:'+w.scope.E.executionEpoch);assert.deepEqual(old.coverageGaps,['transport']);
  const gapless={...old,version:old.version+1,coverageGaps:[],coverage:{...old.coverage,newGap:false}};assert.throws(()=>w.core.mutate('drop-history',
    'adapter',{},tx=>recordExecution(tx,gapless)),/COVERAGE_GAP_IRREVERSIBLE/);
  for(const omitHistory of [false,true]){
   const snapshot={...old,version:old.version+1,coverageGaps:omitHistory?[]:old.coverageGaps,coverage:{...old.coverage,transport:true,complete:true}};
   assert.throws(()=>w.core.mutate('restore','adapter',{},tx=>recordExecution(tx,snapshot)),/COVERAGE_GAP_IRREVERSIBLE/);
  }
  w.scope.seal();assert.equal(w.scope.prove({kind:'attempt',id:'attempt:w',fence:1}).verified,false);
 }finally{w.dispose();}
 const scopes=createExecutionScopes(),s=scopes.open({teamId:'t',memberId:'m',generation:1,attemptId:'a',attemptFence:1,executionSessionId:'s'},{gates:true,
   attribution:true,transport:false,subprocess:true});
 s.coverage('transport',true);assert.equal(s.snapshot().coverage.complete,true,'initial installation may supply a capability before any gap occurred');
 s.invalidate('web');assert.throws(()=>s.coverage('web',true),/COVERAGE_GAP_IRREVERSIBLE/);
});


