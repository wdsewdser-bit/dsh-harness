import test from 'node:test';
import assert from 'node:assert/strict';
import { profile, until } from '../test-support/profile.mjs';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
test('frozen production recovery consumes only its bound cancel through native stop and managed release',async()=>{
 let cancelled=0;
 const w=await profile({executionOf:async binding=>{assert.equal(binding.attemptId,'attempt:old');assert.equal(binding.executionSessionId,'session:old');
   return {session:{id:'session:old'},cancel(){cancelled++;},async whenIdle(){}};}},({root})=>{
  const store=new ControlStore(root),core=new TeamCore(store,{}, {enabled:true});
  core.member('member:old','worker');
  core.mutate('task:old','root',{},tx=>tx.put('task:old',{owner:'member:old',status:'executing',attemptId:'attempt:old',lastFence:1}));
  core.mutate('attempt:old','root',{},tx=>tx.put('attempt:old',{owner:'member:old',taskId:'task:old',generation:1,fence:1,status:'running',lease:'active',
    expiresAt:Date.now()+60000,executionSessionId:'session:old',scopeSet:[]}));
  core.mutate('completion:frozen','operator',{},tx=>tx.put('completion:frozen',{status:'unknown',input:{sessionId:'missing',goal:{id:'g',revision:1}}}));
    store.close();
 });
 try{
  await until(()=>w.runtime.store.read('attempt:old').lease==='revoked');
  assert.equal(cancelled,1);assert.equal(w.runtime.store.read('task:old').status,'failed');
  assert.equal(w.runtime.store.read('completion:frozen').status,'unknown');assert.equal(w.runtime.host.status().admission,false);
  assert.equal(w.runtime.store.effects().find(e=>e.payload.kind==='cancel').status,'confirmed');
  assert.throws(()=>w.runtime.host.command({teamId:w.runtime.host.teamId,requestId:'new',operationId:'v1:operation:deny-frozen-0001',actor:'root',payload:{
    command:'team.member.request',entityId:'member-intent:new',role:'worker'}}));
 }finally{await w.close();}
});
