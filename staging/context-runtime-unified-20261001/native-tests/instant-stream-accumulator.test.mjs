import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {AssistantStreamAccumulator} from '../app/node_modules/@deepseek-ai/dsh-llm/lib/index.js'

// Exercise the installed private accumulator without adding a public package export.
const source=readFileSync(new URL('../app/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js',import.meta.url),'utf8')
const start=source.indexOf('var SessionAssistantStreamAccumulator = class {')
const end=source.indexOf('//#endregion',start)
assert.ok(start>=0&&end>start)
const Accumulator=new Function('AssistantStreamAccumulator','const EMPTY_BASELINE={revision:0};'+source.slice(start,end)+';return SessionAssistantStreamAccumulator;')(AssistantStreamAccumulator)
const frame=(type,revision,attemptId='s:1',extra={})=>({type,revision,attemptId,turn:1,step:1,generation:0,...type==='end'?{index:0}:{},...extra})

test('native reconnect keeps immutable superseded partial and current generation',()=>{
  const value=new Accumulator()
  value.accept(frame('start',1),10)
  value.accept(frame('chunk',2,'s:1',{index:0,time:1,chunk:{type:'text-delta',index:0,text:'obsolete'}}),10)
  const before=value.snapshot()
  const outcome={kind:'committed',eventType:'assistant/attempt',seq:11}
  value.accept(frame('end',3,'s:1',{index:1,superseded:true,outcome}),11)
  value.accept(frame('start',4,'s:2',{generation:1}),12)
  const after=value.snapshot()
  assert.equal(after.activeAttempt.generation,1)
  assert.equal(after.lastAttempt.superseded,true)
  assert.equal(after.lastAttempt.generation,0)
  assert.deepEqual(after.lastAttempt.outcome,outcome)
  assert.equal(JSON.stringify(after.lastAttempt.stream).includes('obsolete'),true)
  assert.equal(before.activeAttempt.generation,0)
  assert.equal(before.lastAttempt,undefined)
  assert.equal(value.snapshot(),after)
})

test('late generation, foreign attempt and mismatched generation cannot overwrite successor',()=>{
  const value=new Accumulator()
  value.accept(frame('start',1),0)
  value.accept(frame('end',2,'s:1',{superseded:true,outcome:{kind:'abandoned'}}),0)
  value.accept(frame('start',3,'s:2',{generation:1}),1)
  value.accept(frame('chunk',4,'s:1',{index:0,chunk:{type:'text-delta',index:0,text:'late'}}),1)
  value.accept(frame('end',5,'foreign',{generation:1,outcome:{kind:'committed',seq:999}}),1)
  value.accept(frame('chunk',6,'foreign',{generation:1,index:0,chunk:{type:'text-delta',index:0,text:'foreign'}}),1)
  value.accept(frame('end',7,'s:2',{generation:2,outcome:{kind:'committed',seq:999}}),1)
  value.accept(frame('chunk',8,'s:2',{generation:1,index:0,time:1,chunk:{type:'text-delta',index:0,text:'fresh'}}),1)
  const snapshot=value.snapshot()
  assert.equal(snapshot.activeAttempt.attemptId,'s:2')
  assert.equal(snapshot.activeAttempt.nextIndex,1)
  assert.equal(JSON.stringify(snapshot.activeAttempt.stream).includes('fresh'),true)
  assert.equal(JSON.stringify(snapshot.activeAttempt.stream).includes('late'),false)
  assert.equal(snapshot.lastAttempt.attemptId,'s:1')
  value.accept(frame('end',9,'s:2',{generation:1,index:1,outcome:{kind:'committed',eventType:'assistant/message',seq:2}}),2)
  assert.equal(value.snapshot().activeAttempt,undefined)
  assert.equal(value.snapshot().lastAttempt.superseded,false)
})

test('gap and wrong chunk index fail closed without fabricating a terminal',()=>{
  for(const broken of [frame('chunk',3,'s:1',{index:0}),frame('chunk',2,'s:1',{index:3})]){
    const value=new Accumulator()
    value.accept(frame('start',1),0)
    value.accept(broken,0)
    const snapshot=value.snapshot()
    assert.equal(snapshot.activeAttempt,undefined)
    assert.equal(snapshot.lastAttempt,undefined)
  }
})
test('native terminal cannot commit a missing, negative or mismatched dense index',()=>{
  for(const index of [undefined,-1,0,2]){
    const value=new Accumulator()
    value.accept(frame('start',1),0)
    value.accept(frame('chunk',2,'s:1',{index:0,time:1,chunk:{type:'text-delta',index:0,text:'partial'}}),0)
    value.accept(frame('end',3,'s:1',{index,superseded:true,outcome:{kind:'committed',eventType:'assistant/attempt',seq:1}}),1)
    assert.equal(value.snapshot().lastAttempt,undefined)
    assert.equal(value.snapshot().activeAttempt,undefined)
  }
})

test('legacy frames retain old baseline shape and attached lifecycle resets native state',()=>{
  const legacy=new Accumulator()
  legacy.accept(frame('start',1,'old',{generation:undefined}),0)
  assert.equal(Object.hasOwn(legacy.snapshot().activeAttempt,'generation'),false)
  legacy.accept(frame('end',2,'old',{generation:undefined,outcome:{kind:'committed'}}),0)
  assert.deepEqual(legacy.snapshot(),{revision:2})
  const native=new Accumulator()
  native.accept(frame('start',1,'old',{generation:4}),0)
  native.accept(frame('end',2,'old',{generation:4,superseded:true,outcome:{kind:'abandoned'}}),0)
  native.accept(frame('start',1,'new'),5)
  assert.equal(native.snapshot().lastAttempt,undefined)
  assert.equal(native.snapshot().activeAttempt.generation,0)
})
