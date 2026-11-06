import test from 'node:test';import assert from 'node:assert/strict';import {real} from '../test-support/real.mjs';import {
  createEffectRunner} from '../index.mjs';
for(const stopRunner of [false,true])test('real host.stop consistently rejects active and subsequent effect waiters, runner.stop='+stopRunner,async()=>{const w=
  await real();let runner;try{
 w.core.mutate('seed:stop-wait','scheduler',{},tx=>{tx.outbox('wake:pending',{kind:'wake'});tx.outbox('wake:done',{kind:'wake'});return null;});runner=
   createEffectRunner({access:w.host.coreAccess,clock:w.host.clock,ports:{wake:()=>({executed:true})},capacity:1});
 // Confirm one exact effect while leaving another pending; no IO is in flight during host shutdown.
 runner.pump();await runner.whenIdle();const completed=w.store.effects().find(e=>e.status==='confirmed').id,pending=w.store.effects().find(e=>
   e.status==='pending').id;
 const waiting=assert.rejects(runner.waitForEffect(pending,{timeoutMs:1000,pollMs:1}),e=>e.code==='RUNNER_STOPPED');
 const stopping=w.host.stop();if(stopRunner)runner.stop();assert.ok(['stopping','stopped'].includes(w.host.state));
 await assert.rejects(runner.waitForEffect(completed,{timeoutMs:0}),e=>e.code==='RUNNER_STOPPED','shutdown precedes returning even a terminal receipt');
   const result=await stopping;assert.equal(result.state,'stopped');await waiting;
 const controller=new AbortController();controller.abort(Error('abort loses to shutdown'));await assert.rejects(runner.waitForEffect('missing',{timeoutMs:0,
   signal:controller.signal}),e=>e.code==='RUNNER_STOPPED');
 await assert.rejects(runner.waitForEffect(pending,{timeoutMs:0}),e=>e.code==='RUNNER_STOPPED');assert.equal(w.store.effects().find(e=>e.id===pending).status,
   'pending');
 }catch(error){w.recordError(error);throw error;}finally{runner?.stop();await w.close();}});
