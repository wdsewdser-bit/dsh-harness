import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {AssistantStreamAccumulator,expandAssistantStream} from '../app/node_modules/@deepseek-ai/dsh-llm/lib/index.js'

const source=readFileSync(new URL('../app/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js',import.meta.url),'utf8')
const region=name=>{
  const marker='//#region lib/types/client/conversation-nodes/'+name+'.js'
  const start=source.indexOf(marker),end=source.indexOf('//#endregion',start)
  assert.ok(start>=0&&end>start)
  return source.slice(start,end)
}
const {definition,project,tailData}=new Function('_deepseek_ai_dsh_api_session_controller',region('common')+region('event-projection')+region('assistant')+region('turn-tail')+';return {definition:assistantDefinition,project:projectAssistant,tailData};')({expandAssistantStream})
const stream=new AssistantStreamAccumulator()
stream.push({time:100,chunk:{type:'text-delta',index:0,text:'obsolete partial'}})
stream.push({time:101,chunk:{type:'reasoning-delta',index:1,text:'partial reasoning'}})
const attempt={type:'assistant/attempt',seq:12,time:102,data:{turn:1,step:1,generation:0,superseded:true,stream:stream.snapshot()}}
const location={kind:'step',step:{step:1,status:'closed',end:{seq:14,time:104},data:new Map()},turn:{turn:1,status:'open',steps:[],data:new Map()}}
const context={key:'assistant-step:1:1',id:'1:1',start:{event:{type:'step/start',seq:10,time:99,data:{turn:1,step:1}},location},matches:[{event:attempt,location}],current:new Map()}

test('actual Web assistant definition renders superseded canonical attempt after reload, not completion',()=>{
  assert.deepEqual(definition.match(attempt),{id:'1:1',role:'update'})
  const result=project(context)
  assert.equal(result.data.status,'superseded')
  assert.equal(result.data.generation,0)
  assert.equal(result.data.blocks[0].text,'obsolete partial')
  assert.equal(result.data.blocks[1].text,'partial reasoning')
  assert.equal(result.settled.messageId,undefined)
  assert.equal(result.settled.superseded,true)
  assert.equal(result.settled.seq,12)
  const plain={...attempt,data:{...attempt.data,superseded:undefined}}
  assert.equal(definition.match(plain),null)
  location.turn.steps=[{data:new Map([['assistant-step',result.data]])}]
  location.turn.status='closed'
  const tail=tailData({matches:[{event:{type:'turn/end',seq:15,time:105,data:{turn:1,reason:{kind:'completed'}}},location}]})
  assert.equal(tail.closing,null)
  assert.equal(tail.branchUnavailable,true)
})

test('actual Web transient fold rejects old generation without retiring current attempt',()=>{
  const api=readFileSync(new URL('../app/node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js',import.meta.url),'utf8')
  const start=api.indexOf('var ClientAssistantStream = class {'),end=api.indexOf('//#endregion',start)
  const Client=new Function('expandAssistantStream',api.slice(start,end)+';return ClientAssistantStream;')(expandAssistantStream)
  const value=new Client()
  value.replace([],{revision:5,activeAttempt:{attemptId:'s:2',generation:2,startedAfterSeq:10,turn:1,step:2,nextIndex:0,stream:[]}})
  const stale=value.acceptFrame({type:'chunk',attemptId:'s:2',generation:1,index:0,time:100,chunk:{type:'text-delta',index:0,text:'late'}})
  assert.equal(stale,undefined)
  const fresh=value.acceptFrame({type:'chunk',attemptId:'s:2',generation:2,index:0,time:101,chunk:{type:'text-delta',index:0,text:'fresh'}})
  assert.equal(fresh.type,'transient')
  assert.equal(fresh.entry.event.data.generation,2)
})
