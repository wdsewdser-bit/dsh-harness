import test from 'node:test';import assert from 'node:assert/strict';import {real} from '../test-support/real.mjs';import {
  createEffectRunner} from '../src/effect-runner.mjs';
const seed=(w,id)=>w.core.mutate('seed:'+id,'scheduler',{},tx=>{tx.outbox(id,{kind:'wake'});return null;});
test('whenIdle joins current batch, waitForEffect observes only named terminal receipt across future retry',async()=>{const w=await real();let runner,calls=0;
  try{seed(w,'wake:later');runner=createEffectRunner({access:w.host.coreAccess,clock:w.host.clock,ports:{wake(){return ++calls===1?{notExecuted:true}:{executed:
  true};}}});runner.pump();await runner.whenIdle();const first=w.store.effects().find(e=>e.id==='wake:later');assert.equal(first.status,'retryable');
  assert.equal(runner.status().pending,0);
 await assert.rejects(runner.waitForEffect('wake:later',{timeoutMs:15}),e=>e.code==='EFFECT_WAIT_TIMEOUT'&&e.lastStatus==='retryable');assert.equal(calls,1,
   'waiting never pumps or sends');
 const waiting=runner.waitForEffect('wake:later',{timeoutMs:1000});w.at=first.nextDue;runner.pump();const terminal=await waiting;assert.equal(terminal.status,
   'confirmed');assert.equal(terminal.tries,2);terminal.status='unknown';assert.equal(w.store.effects().find(e=>e.id==='wake:later').status,'confirmed');
 seed(w,'wake:other');assert.equal((await runner.waitForEffect('wake:later',{timeoutMs:0})).status,'confirmed',
   'unrelated pending effect does not block ID barrier');assert.equal(w.store.effects().find(e=>e.id==='wake:other').status,'pending');
 }catch(e){w.recordError(e);throw e;}finally{runner?.stop();await w.close();}});
test('effect waiter deadlines include unknown/missing and never manufacture stop, with abort and stop exits',async()=>{const w=await real();let runner;try{seed(
  w,'wake:unknown');runner=createEffectRunner({access:w.host.coreAccess,clock:w.host.clock,ports:{wake:()=>({unknown:true})}});runner.pump();
  await runner.whenIdle();
 await assert.rejects(runner.waitForEffect('wake:unknown',{timeoutMs:10}),e=>e.code==='EFFECT_WAIT_TIMEOUT'&&e.lastStatus==='unknown');await assert.rejects(
   runner.waitForEffect('missing',{timeoutMs:0}),e=>e.code==='EFFECT_WAIT_TIMEOUT'&&e.lastStatus==='missing');
 for(const timeoutMs of [undefined,NaN,Infinity,-1])await assert.rejects(runner.waitForEffect('wake:unknown',{timeoutMs}),e=>e.code==='INVALID_CONFIG');
 const abort=new AbortController(),reason=Error('cancel this read only');const wait=runner.waitForEffect('wake:unknown',{timeoutMs:1000,signal:abort.signal});
   abort.abort(reason);await assert.rejects(wait,e=>e===reason);
 runner.stop();await assert.rejects(runner.waitForEffect('wake:unknown',{timeoutMs:1000}),e=>e.code==='RUNNER_STOPPED');assert.equal(w.store.effects()[
   0].status,'unknown');
 }catch(e){w.recordError(e);throw e;}finally{runner?.stop();await w.close();}});
