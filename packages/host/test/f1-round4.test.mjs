import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { profile, until } from '../test-support/profile.mjs';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
import { applyTeamProjections } from '../../profiles/index.mjs';
const snapshot=root=>{const s=ControlStore.openReadOnly(root);try{return JSON.stringify([s.list('attempt:'),s.list('task:'),s.effects()]);}finally{s.close();}};
test('R4 startup leaves team rows fences and outbox unchanged while old IO drains and while registry is contested',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'r4-start-'));const s=new ControlStore(root),c=new TeamCore(s,{}, {enabled:true,attach:true});
 c.mutate('attempt:seed','root',{},tx=>tx.put('attempt:seed',{status:'running',lease:'active',fence:7,taskId:'task:seed',owner:'member:seed',generation:1,
   expiresAt:Date.now()+60000,scopeSet:[]}));s.close();
 const before=snapshot(root);let release;const drained=new Promise(resolve=>{release=resolve;});
 const starting=profile({root,previousDriver:{async stop(){},whenSettled:()=>drained,status:()=>({stopped:true})}});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(snapshot(root),before);
 release();const w=await starting;
 try{assert.equal(w.runtime.core.configuration.teamId,w.runtime.host.teamId);await w.runtime.runner.whenIdle();const held=snapshot(root);await assert.rejects(
   profile({root}),{code:'REGISTRY_LOCKED'});assert.equal(snapshot(root),held);}
 finally{await w.close();}
});
test('R4 second owner fails closed before reserve or mount',async()=>{
 const w=await profile();try{w.ctx.agents.currentInitiator=()=>({session:w.sessions.get(w.runtime.host.ownerSessionId)});assert.doesNotThrow(()=>
   w.globalTools.get('team_read').execute({view:'team',ref:'team'}));const before=fs.readFileSync(w.runtime.manager.registry.file);await assert.rejects(async(
   )=>w.runtime.manager.ensureOwner({ownerSessionId:'other',root:w.root+'/other'}),/MULTI_TEAM_NOT_SUPPORTED/);assert.deepEqual(fs.readFileSync(
   w.runtime.manager.registry.file),before);assert.equal(w.runtime.manager.size,1);}
 finally{await w.close();}
});
test('R4 native session disposed event unbinds member and stops owner with full cleanup',async()=>{
 const w=await profile();
 try{const r=w.runtime;r.host.command({teamId:r.host.teamId,actor:'root',requestId:'member',operationId:'v1:operation:r4-member-0001',payload:{command:
   'team.member.request',entityId:'member-intent:m',role:'worker'}});await until(()=>r.store.read('member-intent:m')?.status==='confirmed');
 await w.ctx.emit('session/disposed',w.sessions.get('session:worker'));
 assert.equal(r.router.routeExecution('session:worker').routed,false);assert.equal(r.host.state,'running');
 const owner=w.sessions.get(r.host.ownerSessionId);assert(owner);await w.ctx.emit('session/disposed',owner);
 assert.equal(r.host.state,'stopped');assert.equal(r.manager.registry.held,false);assert.equal(r.runner.status().stopped,true);assert.equal(r.gc.status(
   ).armed,false);
 }finally{await w.close();}
});
test('R4 host writes reject during stop and after recovery failure without changing the ledger',async()=>{
 let release,entered=false;const work=new Promise(resolve=>{release=resolve;});const w=await profile({gcIntervalMs:150,gc:async()=>{entered=true;return work;
   }});
 try{
 const command=(name,entityId,args={})=>w.runtime.host.command({teamId:w.runtime.host.teamId,actor:'root',requestId:entityId,operationId:'v1:operation:'+
   entityId.replaceAll(':','-').padEnd(20,'x'),payload:{command:name,entityId,...args}});
 command('team.member.request','member-intent:w',{role:'worker'});await until(()=>w.runtime.store.read('member-intent:w')?.status==='confirmed');command(
   'team.task.request','task:w',{owner:'member:w'});await until(()=>w.agentTools.has('team_message'));
 await applyTeamProjections(w.ctx,{port:40298,sessions:{root:{teamId:w.runtime.host.teamId,memberId:'member:root'}}});
 await until(()=>entered);const stopping=w.runtime.host.stop({timeoutMs:1000});const before=snapshot(w.root);const response=await fetch(
   'http://127.0.0.1:40298/team/commands',{method:'POST',headers:{authorization:'Bearer root','content-type':'application/json'},body:JSON.stringify({name:
   'scheduler.approveContract',target:'task:w',args:{}})});assert.equal(response.status,400);assert.match((await response.json()).error,/WRITE_REVOKED/);
   assert.throws(()=>w.agentTools.get('team_message').execute({}),/WRITE_REVOKED/);assert.throws(()=>w.runtime.host.executeAuthorized('business',()=>{
   throw Error('MUTATION_REACHED');}),/WRITE_REVOKED/);assert.equal(snapshot(w.root),before);assert.equal(w.runtime.lifecycle,undefined);release({executed:true,
   receipt:{}});await stopping;}
 finally{release({executed:true,receipt:{}});await w.ctx.teamProjections?.transport.close();await w.close();}
 const failed=await profile({},({root})=>{const s=new ControlStore(root),c=new TeamCore(s,{}, {enabled:true,attach:true});c.mutate('delivery:bad','root',{},
   tx=>tx.put('delivery:bad',{status:'applying',taskId:'missing',target:'main'}));s.close();});
 try{assert.equal(failed.runtime.host.status().admission,false);const before=snapshot(failed.root);assert.throws(()=>failed.runtime.host.executeAuthorized(
   'business',()=>{throw Error('MUTATION_REACHED');}),/ADMISSION_CLOSED/);assert.equal(snapshot(failed.root),before);}
 finally{await failed.close();}
});
