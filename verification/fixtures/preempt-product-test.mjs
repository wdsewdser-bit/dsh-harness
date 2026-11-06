import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootProfile } from '../../packages/profiles/index.mjs';
import { buildTarget } from '../../packages/adapter-dsh/build-target.mjs';

// This is the product host, not the old harness watcher. A held model stream guarantees that the durable message
// arrives inside a live step. The only wake is the host's message effect; no test calls preemptStep or followup.
const root=path.resolve(process.argv[2]??'');
assert(root.toLowerCase().replaceAll('\\','/').startsWith(process.cwd().replaceAll('\\', '/').toLowerCase() + '/runs/'),'PREEMPT_TEST_SCOPE');
assert(!fs.existsSync(root),'the evidence root must be new');fs.mkdirSync(root,{recursive:true});
const deadline=ms=>new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('PREEMPT_TEST_TIMEOUT')),ms);t.unref?.();});
const wait=async(p,label)=>{const end=Date.now()+30000;while(!p()){if(Date.now()>end)throw Error('TIMEOUT:'+label);await new Promise(r=>setTimeout(r,10));}};
let release,heldResolve;const hold=new Promise(r=>release=r),held=new Promise(r=>heldResolve=r);let released=false;
const requests=[];let host;
try {
  host=await bootProfile(root+'/host',{team:true,guard:true,goalCheck:true});
  const {ctx}=host,runtime=ctx.teamRuntime,{host:team,core}=runtime;
  const {LlmAdapter,DISPATCH_CONTRACT,dispatchAttemptOf}=await import(pathToFileURL(buildTarget().base+'dsh-llm/lib/index.js'));
  ctx.llm.registerAdapter(['offline'],new class extends LlmAdapter {
    dispatchContract=DISPATCH_CONTRACT;
    providerInfo(id){return {id,name:'controlled preempt provider'};}
    async prepareCall(provider,id){return {model:{provider,id,name:id,contextWindow:1000000,inputModalities:['text']},stream:options=>this.stream(options)};}
    async *stream(options){
      const index=requests.length;requests.push(structuredClone(options.messages));
      const attempt=dispatchAttemptOf(options);assert(attempt,'each native step must carry a dispatch attempt');
      attempt.phase('send-started',{transmission:1,sendStartedAt:Date.now()});
      attempt.phase('committed',{transmission:1,httpStatus:200,accepted:'accepted'});
      if(index===0){
        yield {type:'block-start',index:0,blockType:'text'};
        yield {type:'text-delta',index:0,text:'partial-must-not-survive'};
        heldResolve();await hold;return;
      }
      yield {type:'block-start',index:0,blockType:'text'};
      yield {type:'text-delta',index:0,text:'complete'};
      yield {type:'block-end',index:0,block:{type:'text',text:'complete'}};
      yield {type:'usage',usage:{inputTokens:13,outputTokens:4,totalTokens:17}};
      yield {type:'finish',reason:{kind:'stop'}};
    }
  }());
  const command=(name,entityId,extra)=>team.command({teamId:team.teamId,actor:'root',requestId:entityId,
    operationId:'v1:operation:'+entityId.replaceAll(':','-').padEnd(24,'x'),payload:{command:name,entityId,...extra}});
  command('team.member.request','member-intent:preempt',{role:'worker'});
  await wait(()=>core.store.read('member-intent:preempt')?.status==='confirmed'&&runtime.handles.has('member:preempt'),'member');
  command('team.task.request','task:preempt-product',{owner:'member:preempt'});
  await Promise.race([held,deadline(30000)]);
  const agent=runtime.handles.get('member:preempt').agent;
  assert.equal(agent.phase.kind,'running');assert.equal(typeof agent.preemptStep,'function');
  assert.equal(agent.preemptStats.fired,0,'the held step has not yet been interrupted');
  const sent=team.executeAuthorized('business',()=>core.send('member:root','member:preempt','action','PREEMPT_PRODUCT_MARKER',
    {expectedOutcome:'read the newer responsibility',deadline:new Date(Date.now()+300000).toISOString()}));
  const messageId=sent.result.entityId;
  await wait(()=>requests.length>=2,'follow-up request while the old stream is still blocked');
  assert.equal(released,false,'follow-up must start before the blocked provider is released');
  assert.equal(requests.length,2,'the message buys one follow-up request');
  assert(JSON.stringify(requests[1]).includes('PREEMPT_PRODUCT_MARKER'),'the follow-up request sees the delivered message');
  assert(!JSON.stringify(requests[1]).includes('partial-must-not-survive'),'an open partial item never leaks to the next request');
  await Promise.race([agent.whenIdle(),deadline(30000)]);
  assert.equal(agent.preemptStats.fired,1);assert.equal(agent.preemptStats.extraRequests,1);
  assert.equal(runtime.preempt.snapshot().preempts,1);
  assert.equal(agent.session.snapshotEvents().filter(e=>e.type==='turn/end').length,1,'preemption preserves the original turn');
  await wait(()=>core.store.read('wake-receipt:'+messageId+':member:preempt'),'one durable wake receipt');
  command('team.wake','signal:preempt-duplicate',{messageId,recipient:'member:preempt'});
  await wait(()=>core.store.effects().some(e=>e.id==='wake:'+messageId+':member:preempt'&&e.status==='confirmed'),'duplicate wake effect');
  assert.equal(requests.length,2,'a repeated wake for the same message cannot buy another request');
  const evidence={status:'passed',messageId,requests:requests.length,preempts:agent.preemptStats.fired,
    extraRequests:agent.preemptStats.extraRequests,turns:1,followupBeforeRelease:true};
  fs.writeFileSync(root+'/report.json',JSON.stringify(evidence,null,2));
  console.log('real preempt product PASS: live step interrupted, one follow-up, same turn, duplicate wake suppressed');
} finally {
  released=true;release();
  if(host){await host.ctx.teamRuntime.stop();await host.ctx.fiber.dispose();}
}
