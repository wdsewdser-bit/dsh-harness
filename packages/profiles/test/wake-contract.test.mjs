import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {host} from '../../adapter-dsh/index.mjs';import {ControlStore} from '../../store/index.mjs';import {TeamCore,
  PreemptWatcher} from '../../core/index.mjs';
// Same contract for native and replacement adapters. Holding downstream kick isolates the admission edge,
// not wakeDriver: the production method must synchronously own running and retain the same driver/turn.
function conforms(agent,opens,invoke=()=>agent.wakeDriver()){
 assert.equal(agent.phase.kind,'idle');invoke();assert.equal(agent.phase.kind,'running','idle wake synchronously owns running');
 const phase=agent.phase,activity=agent.activityDone,count=opens();assert.equal(count,1);
 for(let n=0;n<8;n++)invoke(n%2===0);
 assert.equal(opens(),count,'busy wake must not open a second turn');assert.equal(agent.phase,phase,'busy wake retains the current turn');assert.equal(
   agent.activityDone,activity,'busy wake retains the driver');
}
async function native(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'wake-contract-'));const stack=await host(root,{prepared:true});const h=
  await stack.create({sessionId:'wake-contract',agentOptions:{provider:'offline',model:'model'},meta:{cwd:root}});let opens=0,release;const gate=new Promise(r=>
  release=r);h.agent.kick=()=>{opens++;return gate;};return {root,stack,h,opens:()=>opens,async close(){release();await h.agent.whenIdle();await h.dispose();
  await stack.ctx.fiber.dispose();fs.rmSync(root,{recursive:true,force:true});}};}
test('production wakeDriver satisfies single-turn busy-wake contract',async()=>{const w=await native();try{conforms(w.h.agent,w.opens,arg=>w.h.agent.wakeDriver(
  arg));}finally{await w.close();}});
test('PreemptWatcher production delivery and first-dispatch paths merge busy native wake',async()=>{const w=await native(),store=new ControlStore(path.join(
  w.root,'team')),core=new TeamCore(store,{}, {enabled:true});try{core.member('member:root','root');core.member('member:w','worker');core.ready=()=>true;
  const agent=w.h.agent;agent.preemptStep=()=>false;const watcher=new PreemptWatcher(core);watcher.bind('member:w',agent);
 conforms(agent,w.opens,()=>{const already=w.opens()>0,result=watcher.wakeIdle('member:w');assert.equal(result.fired,!already);if(already)assert.equal(
   result.reason,'alreadyLive');});
 const phase=agent.phase,activity=agent.activityDone;for(let n=0;n<8;n++){const result=watcher.deliverMail('member:w',{sender:'member:root',form:'action'});
   assert.equal(result.dispatched,true);assert.ok(['live','coalesced'].includes(result.wake));}
 assert.equal(w.opens(),1);assert.equal(agent.phase,phase);assert.equal(agent.activityDone,activity);
 agent.phase={kind:'maintenance',abort:new AbortController(),lastTurn:0,wakeRequested:false};assert.equal(watcher.wakeIdle('member:w').defer,true);
   assert.equal(watcher.deliverMail('member:w',{sender:'member:root'}).wake,'notExecuting');assert.equal(w.opens(),1);agent.phase=phase;
 }finally{store.close();await w.close();}});
test('conformance rejects a replacement that opens another turn while busy',()=>{let count=0;const agent={phase:{kind:'idle'},wakeDriver(){count++;this.phase={
  kind:'running'};this.activityDone=Promise.resolve();}};assert.throws(()=>conforms(agent,()=>count),/busy wake must not open a second turn/);});
