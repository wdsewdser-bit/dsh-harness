import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {ControlStore} from '../../store/index.mjs';import {TeamCore,recordExecution,canFinishStoppedGeneration} from '../../core/index.mjs';
import {createExecutionScopes} from '../execution-scope.mjs';import {createInProcessStopProver,createDispatchTracker,
  createSubprocessTracker} from '../session-subprocess.mjs';
import {captureExecutionStop,resolveExecutionStop} from '../execution-stop.mjs';
test('old cancel awaiting executionOf remains pinned to E1 when same-session E2 opens',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'stop-rebind-')),store=new ControlStore(root),core=new TeamCore(store,{}, {enabled:true,autonomy:'on'});
   core.member('member:w','worker');
 const scopes=createExecutionScopes({read:k=>store.read(k),persist:s=>core.mutate('scope','adapter',{},tx=>recordExecution(tx,s))});let cancels=0;
 const agent={session:{id:'shared'},cancel(){cancels++;},async whenIdle(){}};
 const open=id=>{core.mutate(id,'scheduler',{},tx=>tx.put(id,{owner:'member:w',taskId:'task:'+id,generation:1,fence:1,lease:'active',executionSessionId:
   'shared'}));return scopes.open({teamId:'team',memberId:'member:w',generation:1,attemptId:id,attemptFence:1,executionSessionId:'shared'},{gates:true,
   attribution:true,transport:true,subprocess:true});};
 const prover=createInProcessStopProver({tracker:createSubprocessTracker(),dispatch:createDispatchTracker(),agentOf:()=>agent,scopes});
 try{
  const old=open('attempt:old'),captured=captureExecutionStop(store,scopes,store.read('attempt:old'),'cancel');let release;
  const late=(async()=>{const exact=await resolveExecutionStop(scopes,captured,()=>new Promise(r=>release=r));return prover({subject:{kind:'member-session',
    id:'member:w',fence:1},agent:exact,operation:'cancel',...captured});})();
  const proof=await prover({subject:{kind:'member-session',id:'member:w',fence:1},agent,operation:'cancel',...captured});assert.equal(cancels,1);
  const payload={proof,evidenceRef:'stop:old',purpose:'cancel'};core.dispatch('attempt:old','adapter',payload,{type:'execution.close',payload});old.released(
    proof);
  const fresh=open('attempt:new');release(agent);const result=await late;
  assert.equal(result.verified,true);assert.equal(result.E.executionEpoch,old.E.executionEpoch);assert.equal(result.stopId,captured.stopId);assert.equal(
    cancels,1);assert.equal(fresh.state(),'OPEN');assert.equal(fresh.snapshot().stopId,null);
  assert.equal(canFinishStoppedGeneration(store,proof,'member:w',1),false,'old consumed proof cannot retire a member with a newer epoch');
  const wrong=await prover({subject:{kind:'member-session',id:'member:w',fence:1},agent,operation:'cancel',E:old.E,stopId:'wrong'});assert.equal(
    wrong.verified,false);assert.equal(cancels,1);
 }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});
