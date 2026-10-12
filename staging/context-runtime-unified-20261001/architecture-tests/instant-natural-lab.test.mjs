import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {AssistantStreamAccumulator} from '../app/node_modules/@deepseek-ai/dsh-llm/lib/index.js'
import {verifyInstantNatural,observeInstantStream} from '../tools/instant-natural-lab.mjs'
const stream=new AssistantStreamAccumulator()
stream.push({time:1,chunk:{type:'text-delta',index:0,text:'obsolete partial'}})
const journal=[{type:'native/input-accepted',seq:1,data:{preemptGeneration:1,messageId:'input1',inputId:'changed'}},
  {type:'assistant/attempt',seq:2,data:{superseded:true,stream:stream.snapshot()}},
  {type:'native/sampling-interrupted',seq:3,data:{superseded:true}},
  {type:'user/message',seq:4,data:{id:'input1',source:{nativeInputId:'changed'}}},
  {type:'assistant/message',data:{message:{content:[{type:'tool-call',id:'call1',name:'run_code',arguments:{code:'return "UNIFIED_PTC_BOOTSTRAP_OK";'}}]}}},
  {type:'tool/result',data:{message:{role:'tool',toolCallId:'call1',isError:false}}},
  {type:'assistant/message',data:{message:{content:[{type:'text',text:'UNIFIED_PTC_BOOTSTRAP_OK'}]}}},
  {type:'turn/end',seq:8,data:{reason:{kind:'completed'}}}]
test('natural Instant verifier requires real preempt, paired PTC and exact successor, rejecting old partial replay',()=>{
  const requests=[{messages:[]},{messages:[]}]
  assert.equal(verifyInstantNatural(journal,requests).accepted,true)
  for(const type of ['assistant/attempt','native/input-accepted','native/sampling-interrupted','user/message','turn/end','tool/result','assistant/message']){
    assert.equal(verifyInstantNatural(journal.filter(row=>row.type!==type),requests).accepted,false)
  }
  assert.equal(verifyInstantNatural(journal,[requests[0],{messages:[{role:'assistant',content:[{type:'text',text:'obsolete partial'}]}]}]).accepted,false)
  assert.equal(verifyInstantNatural(journal,requests.concat(requests,requests)).accepted,false)
  assert.equal(verifyInstantNatural([],[],{run:false}).accepted,true)
  assert.equal(verifyInstantNatural([],requests,{run:false}).accepted,false)
})
test('actual natural canonical schema validates and duplicate input, foreign pair or false terminal rejects',()=>{
  const directory=new URL('../lab-runs/natural-instant-e2b9f25a-5b8f-4b90-931f-4adfe27afb93/',import.meta.url)
  const journal=JSON.parse(readFileSync(new URL('canonical-journal.json',directory),'utf8'))
  const requests=JSON.parse(readFileSync(new URL('request-evidence.json',directory),'utf8'))
  assert.equal(verifyInstantNatural(journal,requests).accepted,true)
  for(const mutate of [
    rows=>rows.splice(rows.length-1,0,structuredClone(rows.find(r=>r.type==='user/message'&&r.data.source?.nativeInputId==='changed'))),
    rows=>{rows.find(r=>r.type==='tool/result').data.message.toolCallId='foreign'},
    rows=>{rows.at(-1).data.reason.kind='error'},
    rows=>{rows.find(r=>r.type==='native/input-accepted'&&r.data.preemptGeneration).seq=999},
  ]){const bad=structuredClone(journal);mutate(bad);assert.equal(verifyInstantNatural(bad,requests).accepted,false)}
})
test('real stream middleware remains a synchronous async iterable, forwarding all chunks and cancellation',async()=>{
  const source=[{type:'text-delta',index:0,text:'partial'},{type:'usage',usage:{inputTokens:3}},{type:'finish',reason:{kind:'stop'}}]
  const request={chunks:0,usage:null},notices=[]
  const stream=observeInstantStream((async function*(){yield*source})(),request,new AbortController().signal,r=>notices.push(r.index))
  assert.equal(stream.then,undefined)
  assert.equal(typeof stream[Symbol.asyncIterator],'function')
  const received=[]
  for await(const chunk of stream)received.push(chunk)
  assert.deepEqual(received,source)
  assert.equal(request.terminal,'completed')
  assert.equal(request.chunks,3)
  assert.deepEqual(request.usage,{inputTokens:3})
  assert.equal(notices.length,1)
  const controller=new AbortController();controller.abort()
  const failed={chunks:0}
  await assert.rejects(async()=>{for await(const chunk of observeInstantStream((async function*(){throw new Error('cancelled')})(),failed,controller.signal,()=>{}))void chunk},/cancelled/)
  assert.equal(failed.terminal,'aborted')
})
