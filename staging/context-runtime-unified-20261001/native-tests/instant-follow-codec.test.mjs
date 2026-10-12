import test from 'node:test'
import assert from 'node:assert/strict'
import {TYPERT as host} from '../app/node_modules/@deepseek-ai/dsh-api-session-controller/lib/typert.host.js'
import remote from '../app/node_modules/@deepseek-ai/dsh-api-session-controller/lib/typert.remote-client.js'

for(const [name,registry] of [['host',host],['remote',remote]])test(name+' actual follow wire codec preserves native generation on all frames and rejects invalid generation',()=>{
  const method=(registry.invocations??registry.descriptors).find(row=>row.namespace==='session'&&row.method==='follow')
  const schema=method.result.create()
  const outcome={kind:'committed',eventType:'assistant/attempt',seq:12}
  const frame={type:'assistant-stream',frame:{type:'end',attemptId:'s:1',revision:3,index:1,generation:0,superseded:true,outcome}}
  const parsed=schema.parse(frame)
  assert.equal(parsed.frame.generation,0)
  assert.equal(parsed.frame.superseded,true)
  const start={type:'assistant-stream',frame:{type:'start',attemptId:'s:1',revision:1,generation:0,startedAfterSeq:10,turn:1,step:1}}
  const chunk={type:'assistant-stream',frame:{type:'chunk',attemptId:'s:1',revision:2,generation:0,index:0,time:1,chunk:{type:'text-delta',index:0,text:'part'}}}
  for(const input of [start,chunk,frame]){
    assert.equal(schema.parse(input).frame.generation,0)
    const legacy=structuredClone(input);delete legacy.frame.generation;delete legacy.frame.superseded
    assert.equal(Object.hasOwn(schema.parse(legacy).frame,'generation'),false)
    for(const generation of [-1,0.5,Infinity,'1'])assert.throws(()=>schema.parse({...input,frame:{...input.frame,generation}}))
  }
})
