import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootProfile, registerBusinessTool } from '../../packages/profiles/index.mjs';
import { buildTarget } from '../../packages/adapter-dsh/build-target.mjs';
import { chunks } from '../real/protocol.mjs';

const root=path.resolve(process.argv[2]??''),noFinish=process.argv.includes('--no-finish');
assert(root.toLowerCase().replaceAll('\\','/').startsWith(process.cwd().replaceAll('\\', '/').toLowerCase() + '/runs/'));
assert(!fs.existsSync(root));fs.mkdirSync(root,{recursive:true});
const wait=async(test,label)=>{const end=Date.now()+30000;while(!test()){
  if(Date.now()>end)throw Error('TIMEOUT:'+label);await new Promise(r=>setTimeout(r,10));
}};
let release;const hold=new Promise(r=>release=r),requests=[],executions=[];let host;
try {
  host=await bootProfile(root+'/host',{team:true,guard:true,goalCheck:true});
  const {ctx}=host,runtime=ctx.teamRuntime,{host:team,core}=runtime,frames=[];
  ctx.on('agent/assistant-stream',({frame})=>frames.push(frame));
  const native=await import(pathToFileURL(buildTarget().base+'dsh-llm/lib/index.js'));
  ctx.llm.registerAdapter(['offline'],new class extends native.LlmAdapter {
    dispatchContract=native.DISPATCH_CONTRACT;
    providerInfo(id){return {id,name:'completed-response controlled provider'};}
    async prepareCall(provider,id){return {model:{provider,id,name:id,contextWindow:1000000},stream:options=>this.stream(options)};}
    async *stream(options){
      const index=requests.length;requests.push(structuredClone(options.messages));
      const attempt=native.dispatchAttemptOf(options);
      attempt.phase('send-started',{transmission:1,sendStartedAt:Date.now()});
      attempt.phase('committed',{transmission:1,httpStatus:200,accepted:'accepted'});
      for(const chunk of chunks({usage:{input_tokens:10,output_tokens:5,input_tokens_details:{cached_tokens:0}},
        output:index===0?[1,2].map(id=>({type:'function_call',call_id:'held-'+id,name:'held_work',arguments:JSON.stringify({id})})):
        [{type:'message',role:'assistant',content:[{type:'output_text',text:'done'}]}]})){
        if(!noFinish||chunk.type!=='finish')yield chunk;
      }
    }
  }());
  const command=(name,entityId,extra)=>team.command({teamId:team.teamId,actor:'root',requestId:entityId,
    operationId:'v1:operation:'+entityId.replaceAll(':','-').padEnd(24,'x'),payload:{command:name,entityId,...extra}});
  command('team.member.request','member-intent:completed',{role:'worker'});
  await wait(()=>runtime.handles.has('member:completed'),'member');
  const agent=runtime.handles.get('member:completed').agent;
  registerBusinessTool(runtime,agent,{name:'held_work',description:'controlled held work',
    parameters:{type:'object',properties:{id:{type:'integer'}},required:['id']},
    output:{schema:{type:'object'},render:(_,v)=>[{type:'text',text:JSON.stringify(v)}]},
    execute:async({id})=>{executions.push({id,started:true});await hold;return {id,completed:true};}});
  command('team.task.request','task:completed',{owner:'member:completed'});
  await wait(()=>executions.length>0,'response finished and first tool started');
  assert.equal(executions.length,1,'the second generated tool has not started');
  assert(frames.some(f=>f.type==='end'&&f.outcome.kind==='committed'&&f.outcome.eventType==='assistant/message'));
  if(noFinish)assert(!frames.some(f=>f.type==='chunk'&&f.chunk.type==='finish'),'successful native exhaustion has no finish hint');
  const beforeMerge=runtime.preempt.snapshot().notLive;
  const sent=team.executeAuthorized('business',()=>core.send('member:root','member:completed','action','COMPLETED_BATCH_MAIL',
    {expectedOutcome:'read after completing current tools',deadline:new Date(Date.now()+300000).toISOString()}));
  const messageId=sent.result.entityId;
  await wait(()=>runtime.preempt.snapshot().notLive>beforeMerge,'mail merged into live tools');
  assert.equal(agent.preemptStats.fired,0,'completed response is not destructively preempted');
  assert.equal(requests.length,1,'no resend while completed tools are held');
  assert.equal(executions.length,1,'new mail does not dispatch or discard the pending second tool');
  assert(!core.store.read('wake-receipt:'+messageId+':member:completed'),'merge alone is not delivery');
  release();await wait(()=>requests.length===2&&agent.phase.kind==='idle','natural followup');
  await wait(()=>core.store.read('wake-receipt:'+messageId+':member:completed'),'carrying receipt');
  assert(JSON.stringify(requests[1]).includes('COMPLETED_BATCH_MAIL'));
  assert.deepEqual(executions.map(x=>x.id).sort(),[1,2],'each generated tool executes exactly once');
  const events=agent.session.snapshotEvents(),results=events.filter(e=>e.type==='tool/result');
  assert.equal(results.length,2);assert(!JSON.stringify(results).includes('ABORTED'));
  assert.equal(events.filter(e=>e.type==='turn/end').length,1,'mail does not replace the original turn');
  command('team.wake','signal:completed-duplicate',{messageId,recipient:'member:completed'});
  await wait(()=>core.store.effects().some(e=>e.id==='wake:'+messageId+':member:completed'&&e.status==='confirmed'),'duplicate wake');
  assert.equal(requests.length,2);assert.equal(agent.preemptStats.extraRequests,0);
  fs.writeFileSync(root+'/report.json',JSON.stringify({status:'passed',noFinish,durableSettlement:true,queuedToolRetained:true,
    requests:2,tools:2,preempts:0,extraRequests:0,duplicateSuppressed:true},null,2));
  console.log('completed response preempt PASS: completed batch retained, exactly once, mail carried at natural boundary');
} finally {release();if(host){await host.ctx.teamRuntime.stop();await host.ctx.fiber.dispose();}}
