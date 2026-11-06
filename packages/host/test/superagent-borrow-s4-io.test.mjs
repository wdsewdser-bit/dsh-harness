import test from 'node:test';import assert from 'node:assert/strict';
import {real} from '../test-support/real.mjs';
import {createEffectRunner,createHumanInputGateway,effectIoClaimKey} from '../index.mjs';
import {drain,capacityStatus,effectTrafficClass} from '../../core/index.mjs';
const gate=()=>Promise.withResolvers();const turn=()=>new Promise(r=>setImmediate(r));
const seed=(w,id,p={kind:'wake'})=>w.core.mutate('seed:'+id,'scheduler',{},tx=>{tx.outbox(id,p);return null;});
const lanes=w=>({store:w.store,classify:e=>effectTrafficClass(w.store,e),persist:row=>{const {claimKey,...value}=row;const key=claimKey??effectIoClaimKey(
  value.effectId,value.fence);return w.core.controlFact(key,value,tx=>tx.put(key,value));}});
const heldRow=(id,fence,extra={})=>({effectId:id,lane:'normal',fence,state:'held',startedAt:1,teamId:'team:b',hostEpoch:'host:1',attemptId:null,originRef:null,
  ...extra});
function humans(w){w.core.configuration.superagentBorrow='v1';w.core.member('member:root','root');w.core.member('member:a','worker');
 const token={},gateway=createHumanInputGateway({core:w.core,teamId:'team:b',ownerSessionId:'owner',authenticate:c=>c===token?{teamId:'team:b',ownerSessionId:
   'owner',authenticatedEntry:'owner-user-input'}:null});
 return n=>gateway.send({operationId:'v1:operation:io-human-'+n,recipient:'member:a',purpose:'message',summary:'human IO '+n},token);
}

test('H01/H03/H08: C full and normal head does not hide later human I; one runner, no duplicate claim, pure status with all lanes full',async()=>{
 const w=await real();const normal=gate(),human=gate();let runner;const calls=[];
 try{
  const send=humans(w);for(let n=0;n<4;n++)seed(w,'ordinary:'+n);send(1);send(2);
  runner=createEffectRunner({access:w.host.coreAccess,clock:w.host.clock,capacity:2,capacityLanes:lanes(w),ports:{
   wake:p=>{calls.push(p.operationId);return normal.promise;},message:p=>{calls.push(p.operationId);return human.promise;}}});
  assert.equal(runner.pump().claimed,3);await turn();assert.equal(calls.length,3);
  assert.equal(runner.pump().claimed,0);assert.equal(new Set(calls).size,3);
  const before=JSON.stringify(w.store.list());const status=runner.status();assert.equal(status.activeIO,3);assert.equal(status.lanes.normal.current,2);
    assert.equal(status.lanes.human.current,1);
  assert.equal(capacityStatus(w.core).providerCapacity,'unknown');assert.equal(JSON.stringify(w.store.list()),before);
  assert.equal(w.store.effects().find(e=>e.id==='ordinary:2').status,'pending');
  human.resolve({executed:true,receipt:{}});await turn();await turn();assert.equal(runner.status().lanes.human.current,0);
  assert.equal(runner.pump().claimed,1);await turn();assert.equal(calls.length,4);
  normal.resolve({executed:true,receipt:{}});await runner.whenIdle();assert.equal(runner.status().activeIO,0);
  assert.equal(runner.pump().claimed,2);await runner.whenIdle();assert.equal(new Set(calls).size,6);
 }finally{normal.resolve({unknown:true});human.resolve({unknown:true});runner?.stop();await w.close();}
});

test('H03: N/H/C/I all full still permit pure host status, while model status input remains queued without fake completion',async()=>{
 const w=await real();const normal=gate(),human=gate();let runner;try{
  humans(w);w.core.configuration.maxRuns=1;w.core.member('member:b','worker');w.core.task('task:a','member:a');w.core.schedule('full-n','task:a');
  const token={},gateway=createHumanInputGateway({core:w.core,teamId:'team:b',ownerSessionId:'owner',authenticate:c=>c===token?{teamId:'team:b',
    ownerSessionId:'owner',authenticatedEntry:'authenticated-viewer'}:null});
  gateway.send({operationId:'v1:operation:all-full-b',recipient:'member:b',purpose:'message',summary:'human mailbox'},token);assert.equal(drain(
    w.core).length,1);
  runner=createEffectRunner({access:w.host.coreAccess,clock:w.host.clock,capacity:2,capacityLanes:lanes(w),ports:{start:()=>normal.promise,message:()=>
    human.promise}});
  assert.equal(runner.pump().claimed,3);await turn();
  assert.equal(capacityStatus(w.core).normal.current,1);assert.equal(capacityStatus(w.core).human.current,1);
  assert.equal(runner.status().lanes.normal.current,2);assert.equal(runner.status().lanes.human.current,1);
  const queued=gateway.send({operationId:'v1:operation:all-full-root',recipient:'member:root',purpose:'status',summary:'model answer requested'},token);
  assert.equal(queued.result.visible,false);assert.equal(runner.pump().claimed,0);assert.equal(capacityStatus(w.core).human.queued,1);
  const before=w.snapshot();assert.equal(w.host.status().state,'running');capacityStatus(w.core);runner.status();assert.equal(w.snapshot(),before);
  assert.equal(w.store.list('attempt:').some(a=>a.owner==='member:root'),false);
 }finally{normal.resolve({executed:true,receipt:{}});human.resolve({executed:true,receipt:{}});await runner?.whenIdle();runner?.stop();await w.close();}
});

test('H04/H08: forged human labels on work and wrong-target wake stay normal; maintenance defer never spends a lane or try',async()=>{
 const w=await real();let runner;const hold=gate();try{
  const send=humans(w),h=send(1),m=w.store.read(h.result.entityId);
  seed(w,'fake:start',{kind:'start',trafficClass:'human',originRef:m.humanOriginRef,messageId:m.entityId});
  seed(w,'fake:target',{kind:'wake',trafficClass:'human',originRef:m.humanOriginRef,messageId:m.entityId,recipient:'member:no'});
  assert.equal(effectTrafficClass(w.store,w.store.effects().find(e=>e.id==='fake:start')),'normal');
  assert.equal(effectTrafficClass(w.store,w.store.effects().find(e=>e.id==='fake:target')),'normal');
  runner=createEffectRunner({access:w.host.coreAccess,clock:w.host.clock,capacity:1,capacityLanes:lanes(w),deferrable:e=>e.id===m.entityId,
   ports:{wake:()=>hold.promise,start:()=>hold.promise}});
  assert.equal(runner.pump().claimed,1);const deferred=w.store.effects().find(e=>e.id===m.entityId);
  assert.equal(deferred.tries,0);assert.equal(runner.status().lanes.human.current,0);assert.equal(deferred.defers,1);
 }finally{hold.resolve({executed:true,receipt:{}});await runner?.whenIdle();runner?.stop();await w.close();}
});

test(
  "H06: timeout/runner.stop are logical isolation, unknown retains I and closes admission; insufficient"+
  " reclaim never frees; late outcome never becomes success",async()=>{
 const w=await real();const io=gate();let runner;try{
  const send=humans(w);const h=send(1);send(2);
  runner=createEffectRunner({access:w.host.coreAccess,clock:w.host.clock,capacity:1,timeoutMs:5,capacityLanes:lanes(w),
   verifyStopped:async({evidenceRef})=>evidenceRef==='stop:trusted',ports:{message:()=>io.promise}});
  runner.pump();await new Promise(r=>setTimeout(r,20));await runner.whenIdle();
  assert.equal(w.store.effects().find(e=>e.id===h.result.entityId).status,'unknown');assert.equal(runner.status().lanes.human.unknown,1);
  assert.equal(runner.status().activeIO,1);assert.equal(runner.pump().claimed,0);assert.equal(capacityStatus(w.core).admissionClosed,true);
  await assert.rejects(runner.reclaim(h.result.entityId,'elapsed'),e=>e.code==='STOP_NOT_CONFIRMED');assert.equal(runner.status().activeIO,1);
  runner.stop();assert.equal(runner.status().activeIO,1);assert.equal(w.store.read(effectIoClaimKey(h.result.entityId,1)).state,'unknown');
  await runner.reclaim(h.result.entityId,'stop:trusted');assert.equal(runner.status().activeIO,0);
  io.resolve({executed:true,receipt:{}});await turn();assert.equal(w.store.effects().find(e=>e.id===h.result.entityId).status,'unknown');
 }finally{io.resolve({unknown:true});runner?.stop();await w.close();}
});

test('H06: an unknown returned IO and a pending closeOut do not release a lane or become success/failure',async()=>{
 const w=await real();const readback=gate();let runner;try{
  humans(w);seed(w,'delivery:uncertain',{kind:'delivery',deliveryId:'delivery:x',taskId:'task:x',deliveryRevision:1,target:'refs/heads/main'});
  runner=createEffectRunner({access:w.host.coreAccess,clock:w.host.clock,capacity:1,capacityLanes:lanes(w),ports:{delivery:()=>({unknown:true})},
    capabilities:{on:true,kinds:['delivery'],store:w.store,access:w.host.coreAccess,teamId:'team:b',readbackTimeoutMs:10000,readbacks:{git:()=>
      readback.promise}}});
  runner.pump();await turn();assert.equal(runner.status().activeIO,1);assert.equal(runner.status().pending,1);
  assert.equal(runner.status().admissionClosed,true);assert.equal(runner.pump().claimed,0);
  readback.resolve({unknown:true});await runner.whenIdle();assert.equal(runner.status().activeIO,1);
  assert.equal(w.store.effects()[0].status,'unknown');assert.equal(w.store.read(effectIoClaimKey('delivery:uncertain',1)).state,'unknown');
 }finally{readback.resolve({unknown:true});runner?.stop();await w.close();}
});

test('H06 readback timeout: late original IO cannot release a lane while closeOut transport is still outstanding',async()=>{
 const w=await real(),io=gate(),readback=gate(),entered=gate();let runner;try{
  humans(w);seed(w,'delivery:late',{kind:'delivery',deliveryId:'delivery:x',taskId:'task:x',deliveryRevision:1,target:'refs/heads/main'});
  runner=createEffectRunner({access:w.host.coreAccess,clock:w.host.clock,capacity:1,timeoutMs:5,capacityLanes:lanes(w),ports:{delivery:()=>io.promise},
   capabilities:{on:true,kinds:['delivery'],store:w.store,access:w.host.coreAccess,teamId:'team:b',readbackTimeoutMs:20,readbacks:{git:()=>{entered.resolve(
     );return readback.promise;}}}});
  runner.pump();await entered.promise;io.resolve({executed:true,receipt:{}});await runner.whenIdle();
  assert.equal(runner.status().activeIO,1);assert.equal(runner.status().admissionClosed,true);
  assert.equal(w.store.read(effectIoClaimKey('delivery:late',1)).state,'unknown');assert.equal(w.store.effects()[0].status,'unknown');
  seed(w,'next:after-readback');assert.equal(runner.pump().claimed,0);
  readback.resolve({executed:true,receipt:{}});await turn();await turn();
  assert.equal(runner.status().activeIO,0,'both actual transports have now terminated');
  assert.equal(w.store.effects()[0].status,'unknown','late terminal evidence never rewrites the settled outcome');
 }finally{io.resolve({unknown:true});readback.resolve({unknown:true});runner?.stop();await w.close();}
});

test('H06 stopped readback: logical isolation cannot dispatch a new untracked closeOut transport',async()=>{
 const w=await real(),io=gate();let runner,readbacks=0;try{
  humans(w);seed(w,'delivery:stop',{kind:'delivery',deliveryId:'delivery:x',taskId:'task:x',deliveryRevision:1,target:'refs/heads/main'});
  runner=createEffectRunner({access:w.host.coreAccess,clock:w.host.clock,capacity:1,capacityLanes:lanes(w),ports:{delivery:()=>io.promise},
   capabilities:{on:true,kinds:['delivery'],store:w.store,access:w.host.coreAccess,teamId:'team:b',readbacks:{git:()=>{readbacks++;return {unknown:true};}}}});
  runner.pump();await turn();runner.stop();await runner.whenIdle();
  assert.equal(readbacks,0);assert.equal(runner.status().activeIO,1);assert.equal(w.store.read(effectIoClaimKey('delivery:stop',1)).state,'unknown');
 }finally{io.resolve({unknown:true});runner?.stop();await w.close();}
});

test('H06 stale index: a released old fence cannot hide a new applying claim after crash before indexing',async()=>{
 const w=await real();let runner;try{
  humans(w);seed(w,'retry:io');
  const first=w.host.coreAccess.lifecycle().claim('retry:io','adapter',10000).result;
  const firstKey=effectIoClaimKey('retry:io',first.fence);
  w.core.controlFact(firstKey,{},tx=>tx.put(firstKey,heldRow('retry:io',first.fence,{state:'released'})));
  w.store.settle(w.core.command('effect:retry:io','adapter',{}),'retry:io',first.fence,{notExecuted:true});w.at=Date.now()+2000;
  const second=w.host.coreAccess.lifecycle().claim('retry:io','adapter',10000).result;assert(second.fence>first.fence);
  let calls=0;seed(w,'next:io');runner=createEffectRunner({access:w.host.coreAccess,clock:w.host.clock,capacity:1,capacityLanes:lanes(w),teamId:'team:b',
    hostEpoch:'host:1',ports:{wake:()=>{calls++;return {executed:true};}}});
  assert.equal(runner.status().activeIO,1);assert.equal(runner.status().admissionClosed,true);assert.equal(runner.pump().claimed,0);assert.equal(calls,0);
  const secondKey=effectIoClaimKey('retry:io',second.fence),restored=w.store.read(secondKey);
  assert.equal(restored.fence,second.fence);assert.equal(restored.state,'unknown');assert.equal(restored.startedAt,null);assert.equal(
    restored.identityMissing,true);
  assert.equal(capacityStatus(w.core).admissionClosed,true);
  await assert.rejects(runner.reclaim('retry:io','stop:quarantined',{fence:second.fence}),e=>e.code==='CLAIM_IDENTITY_MISSING');
 }finally{runner?.stop();await w.close();}
});

test('H06: crash recovery and lower C restore unknown occupancy before pumping, no timeout eviction',async()=>{
 const w=await real();let runner;try{
  humans(w);seed(w,'old:io');const effect=w.host.coreAccess.lifecycle().claim('old:io','adapter',10000).result;
  const k1=effectIoClaimKey('old:io',effect.fence);w.core.controlFact(k1,{},tx=>tx.put(k1,heldRow('old:io',effect.fence)));
  seed(w,'old:io2');const second=w.host.coreAccess.lifecycle().claim('old:io2','adapter',10000).result;
  const k2=effectIoClaimKey('old:io2',second.fence);w.core.controlFact(k2,{},tx=>tx.put(k2,heldRow('old:io2',second.fence)));
  seed(w,'next:io');runner=createEffectRunner({access:w.host.coreAccess,clock:w.host.clock,capacity:1,capacityLanes:lanes(w),teamId:'team:b',hostEpoch:
    'host:1',verifyStopped:async()=>true});
  assert.equal(runner.status().activeIO,2);assert.equal(runner.status().lanes.normal.unknown,2);assert.equal(runner.status().lanes.normal.limit,1);
    assert.equal(runner.pump().claimed,0);
  assert.equal(w.store.read(k1).state,'unknown');await runner.reclaim('old:io','stop:external',{fence:effect.fence});assert.equal(runner.status().activeIO,1);
  assert.equal(runner.pump().claimed,0);await runner.reclaim('old:io2','stop:external2',{fence:second.fence});assert.equal(runner.status().activeIO,0);
 }finally{runner?.stop();await w.close();}
});

test('H06 claim identity: two fences of one effect are separate occupancy; reclaiming the old fence cannot reopen admission',async()=>{
 const w=await real();let runner;try{
  humans(w);const id='dual:io';
  w.core.controlFact(effectIoClaimKey(id,1),{},tx=>tx.put(effectIoClaimKey(id,1),heldRow(id,1,{hostEpoch:'host:1'})));
  w.core.controlFact(effectIoClaimKey(id,2),{},tx=>tx.put(effectIoClaimKey(id,2),heldRow(id,2,{hostEpoch:'host:2'})));
  runner=createEffectRunner({access:w.host.coreAccess,clock:w.host.clock,capacity:1,capacityLanes:lanes(w),teamId:'team:b',hostEpoch:'host:2',
    verifyStopped:async({fence,evidenceRef})=>evidenceRef==='stop:'+fence});
  assert.equal(runner.status().activeIO,2);assert.equal(capacityStatus(w.core).admissionClosed,true);
  await assert.rejects(runner.reclaim(id,'stop:1'),e=>e.code==='CLAIM_REQUIRED');
  await runner.reclaim(id,'stop:1',{fence:1});
  assert.equal(runner.status().activeIO,1);
  assert.equal(w.store.read(effectIoClaimKey(id,2)).state,'unknown','the newer claim is untouched');
  assert.equal(capacityStatus(w.core).admissionClosed,true,'the newer unknown still closes admission');
  assert.equal(runner.pump().claimed,0);
  await runner.reclaim(id,'stop:2',{fence:2});
  assert.equal(runner.status().activeIO,0);assert.equal(capacityStatus(w.core).admissionClosed,false);
 }finally{runner?.stop();await w.close();}
});

test('H06 claim fields: startedAt and a non-null attemptId are bound per field; concurrent reclaim has exactly one winner',async()=>{
 const w=await real();let runner;try{
  humans(w);const id='fields:io';
  const seed=(fence,startedAt,attemptId)=>w.core.controlFact(effectIoClaimKey(id,fence),{},
   tx=>tx.put(effectIoClaimKey(id,fence),heldRow(id,fence,{startedAt,attemptId})));
  seed(1,111,'attempt:field');seed(2,222,'attempt:field');seed(3,333,null);seed(4,444,null);
  const seen=[];let expectStart=111,expectAttempt='attempt:field';
  runner=createEffectRunner({access:w.host.coreAccess,clock:w.host.clock,capacity:1,capacityLanes:lanes(w),teamId:'team:b',hostEpoch:'host:1',
   verifyStopped:async subject=>{seen.push(subject);return subject.startedAt===expectStart&&subject.attemptId===expectAttempt;}});
  await assert.doesNotReject(runner.reclaim(id,'stop:fields',{fence:1}));
  assert.equal(seen[0].startedAt,111,'the verifier receives the claim start, not the restart clock');
  assert.equal(seen[0].attemptId,'attempt:field','a non-null attempt id is part of the binding');
  assert.equal(seen[0].teamId,'team:b');assert.equal(seen[0].hostEpoch,'host:1');
  // startedAt is decided per field: a proof bound to another start cannot release this claim.
  expectStart=111;
  await assert.rejects(runner.reclaim(id,'stop:started',{fence:2}),e=>e.code==='STOP_NOT_CONFIRMED');
  expectStart=222;await assert.doesNotReject(runner.reclaim(id,'stop:started2',{fence:2}));
  // A null attempt id is not the non-null one this proof names.
  expectStart=333;expectAttempt='attempt:field';
  await assert.rejects(runner.reclaim(id,'stop:attempt',{fence:3}),e=>e.code==='STOP_NOT_CONFIRMED');
  expectAttempt=null;await assert.doesNotReject(runner.reclaim(id,'stop:attempt2',{fence:3}));
  // Two reclaims of one claim may both verify; only one may release it.
  const hold=Promise.withResolvers();let arrivals=0;
  const concurrent=createEffectRunner({access:w.host.coreAccess,clock:w.host.clock,capacity:1,capacityLanes:lanes(w),teamId:'team:b',hostEpoch:'host:1',
   verifyStopped:async subject=>{arrivals+=1;if(arrivals===2)hold.resolve();await hold.promise;return subject.fence===4;}});
  const results=await Promise.allSettled([concurrent.reclaim(id,'stop:race-a',{fence:4}),concurrent.reclaim(id,'stop:race-b',{fence:4})]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1,JSON.stringify(results));
  assert.equal(results.filter(result=>result.status==='rejected').length,1);
  assert.equal(concurrent.status().activeIO,0);
 }finally{runner?.stop();await w.close();}
});

test('H06 legacy idempotency: init -> stop -> restart -> stop keeps one row and one unknown occupation',async()=>{
 const w=await real();let runner;try{
  humans(w);const options=()=>({access:w.host.coreAccess,clock:w.host.clock,capacity:1,capacityLanes:lanes(w),teamId:'team:b',hostEpoch:'host:1'});
  w.core.controlFact('effect-io:legacy:io',{},tx=>tx.put('effect-io:legacy:io',{effectId:'legacy:io',lane:'normal',fence:3,state:'held',startedAt:1}));
  runner=createEffectRunner(options());
  assert.equal(runner.status().activeIO,1);runner.stop();
  assert.equal(w.store.list('effect-io:').length,1,'stop writes the original legacy key, not a second composite key');
  runner=createEffectRunner(options());
  assert.equal(w.store.list('effect-io:').length,1,'restart does not manufacture a second row');
  assert.equal(runner.status().activeIO,1);assert.equal(runner.status().lanes.normal.unknown,1);
  runner.stop();runner=createEffectRunner(options());
  assert.equal(w.store.list('effect-io:').length,1,'the second stop is equally idempotent');
  assert.equal(runner.status().activeIO,1);assert.equal(runner.status().lanes.normal.unknown,1);
  assert.equal(capacityStatus(w.core).admissionClosed,true);
 }finally{runner?.stop();await w.close();}
});

test('H06 legacy index: an old effectId-keyed row is quarantined, keeps admission closed and refuses a fully bound reclaim',async()=>{
 const w=await real();let runner;try{
  humans(w);
  w.core.controlFact('effect-io:legacy:io',{},tx=>tx.put('effect-io:legacy:io',{effectId:'legacy:io',lane:'normal',fence:3,state:'held',startedAt:1}));
  runner=createEffectRunner({access:w.host.coreAccess,clock:w.host.clock,capacity:1,capacityLanes:lanes(w),teamId:'team:b',hostEpoch:'host:1',verifyStopped:
    async()=>true});
  assert.equal(runner.status().activeIO,1);
  assert.equal(w.store.read('effect-io:legacy:io').state,'unknown');
  assert.equal(w.store.read('effect-io:legacy:io').identityMissing,true);
  assert.equal(capacityStatus(w.core).admissionClosed,true);
  await assert.rejects(runner.reclaim('legacy:io','stop:legacy',{fence:3}),e=>e.code==='CLAIM_IDENTITY_MISSING');
  assert.equal(runner.status().activeIO,1);
 }finally{runner?.stop();await w.close();}
});
