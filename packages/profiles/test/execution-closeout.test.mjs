import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore,recordExecution,closeExecution } from '../../core/index.mjs';
import { createExecutionScopes } from '../execution-scope.mjs';

test('SQLite transaction: no partial proof consumption, task/wait release or run-slot loss after a crash',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'execution-cas-')),store=new ControlStore(root);
 const core=new TeamCore(store,{}, {enabled:true,autonomy:'on'});
 try{
  core.member('member:w','worker');core.member('member:other','worker');
  core.mutate('fixture','scheduler',{},tx=>{
   for(const n of ['w','other']) {
    tx.put('attempt:'+n,{owner:'member:'+n,taskId:'task:'+n,generation:1,fence:1,lease:'active',status:'running',executionSessionId:'session:'+n});
    tx.put('task:'+n,{attemptId:'attempt:'+n,status:'executing'});tx.put('wait:'+n,{attemptId:'attempt:'+n,status:'pending'});
   }return null;
  });
  const scopes=createExecutionScopes({read:k=>store.read(k),persist:s=>core.mutate('scope-write','adapter',{},tx=>recordExecution(tx,s))});
  const scope=scopes.open({teamId:'team',memberId:'member:w',generation:1,attemptId:'attempt:w',attemptFence:1,executionSessionId:'session:w'},
   {gates:true,attribution:true,transport:true,subprocess:true});
  scope.seal();const proof=scope.prove({kind:'attempt',id:'attempt:w',fence:1});
  assert.throws(()=>core.mutate('close-crash','adapter',{},tx=>{
   closeExecution(tx,{proof,evidenceRef:'proof:crash',attempts:[tx.read('attempt:w')]});throw Error('CRASH_BEFORE_COMMIT');
  }),/CRASH_BEFORE_COMMIT/);
  assert.equal(store.read('attempt:w').lease,'active');assert.equal(store.read('task:w').status,'executing');
  assert.equal(store.read('wait:w').status,'pending');assert.equal(store.read('execution-scope:'+scope.E.executionEpoch).state,'PROVEN');
  const payload={proof,evidenceRef:'proof:commit'};
  core.dispatch('attempt:w','adapter',payload,{type:'execution.close',payload});scope.released(proof);
  assert.equal(store.read('attempt:w').lease,'revoked');assert.equal(store.read('task:w').status,'cancelled');assert.equal(store.read('wait:w').status,
    'cancelled');
  assert.equal(store.read('attempt:other').lease,'active');
  assert.equal(core.dispatch('attempt:w','adapter',payload,{type:'execution.close',payload}).result,1,'late identical closeout reads committed result');
  assert.throws(()=>scope.acquire('stale-callback'),/EXECUTION_SEALED/);
 }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});
