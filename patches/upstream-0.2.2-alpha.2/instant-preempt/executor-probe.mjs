import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import { boot, C2, ORIGINAL, harness, deferred, chunks, stable } from './probe.mjs';
const root=new URL('./executor-runs/'+Date.now()+'/',import.meta.url);
fs.mkdirSync(root,{recursive:true});
const summary=[];
for(const [base,on,parallel,label] of [[C2,true,1,'serial'],[C2,true,2,'rolling-pool'],[C2,true,1,'exclusive'],[C2,false,1,'switch-off'],[ORIGINAL,undefined,1,'native']]){
 const home=fileURLToPath(new URL(label+'/',root));fs.mkdirSync(home,{recursive:true});
 const {ctx,LlmAdapter}=await boot(base,on,home);
 try {
  const bodyStarted=deferred(),release=deferred();let started=[],signals=[];
  ctx.tools.register({name:'slow',description:'offline controlled body',parameters:{type:'object',properties:{i:{type:'number'}},required:['i']},
   ...(label==='exclusive'?{}:{isConcurrencySafe:()=>true}),
   output:{schema:{type:'string'},render:(_,v)=>[{type:'text',text:v}]},
   async execute(args,exec){started.push(args.i);signals.push(exec.signal);if(args.i===1){bodyStarted.resolve();await release.promise;}return 'real:'+args.i;}});
  const evidence={requests:[]},h=harness(LlmAdapter,evidence);ctx.llm.registerAdapter(['offline'],h.adapter);
  h.arm({entry(i){return i===0?{chunks:[...chunks.toolCall(0,'t1','slow','{"i":1}'),...chunks.toolCall(1,'t2','slow','{"i":2}'),...chunks.toolCall(2,'t3','slow','{"i":3}'),chunks.finish('tool-calls')]}:{chunks:[...chunks.text(0,'done'),chunks.textEnd(0,'done'),chunks.finish('stop')]};}});
  const handle=await ctx.agents.create({sessionId:'tools-'+label,agentOptions:{provider:'offline',model:'model'},meta:{cwd:home}}),agent=handle.agent;
  agent.followup({id:'user',role:'user',source:{kind:'user'},content:[{type:'text',text:'run tools'}]});
  await bodyStarted.promise;
  if(on){assert.equal(agent.preemptStep('tool-body'),true);assert.equal(agent.preemptStep('again'),false);}else if(agent.preemptStep)assert.equal(agent.preemptStep('disabled'),false);
  release.resolve();await agent.whenIdle();
  const events=agent.session.snapshotEvents(),calls=events.filter(e=>e.type==='tool/call'),results=events.filter(e=>e.type==='tool/result');
  assert.equal(calls.length,3);assert.equal(results.length,3);
  for(const id of ['t1','t2','t3'])assert.equal(results.filter(e=>e.data.message.toolCallId===id).length,1);
  assert.equal(results[0].data.message.isError,false);assert(JSON.stringify(results[0]).includes('real:1'));
  assert(signals.every(s=>!s.aborted),'a step halt must NOT abort an invoked body');
  if(on){assert.equal(started.includes(3),false);if(parallel===1)assert.deepEqual(started,[1]);assert.equal(results.at(-1).data.message.isError,true);assert(JSON.stringify(results.at(-1)).includes('aborted before dispatch'));assert.equal(agent.preemptStats.fired,0,'tool drain is a normal step boundary, not stream settlement');assert.equal(agent.preemptStats.extraRequests,0);}else assert.deepEqual(started,[1,2,3]);
  assert.equal(events.filter(e=>e.type==='turn/end').length,1);assert.equal(events.find(e=>e.type==='turn/end').data.reason.kind,'completed');
  const item={label,started,requests:evidence.requests.length,events:stable(agent.session)};summary.push(item);
  console.log('PASS executor '+label+': drain original results; skip undispatched; one result per call; one turn');
  await handle.dispose();
 }finally{await ctx.fiber.dispose();}
}
assert.deepEqual(summary.find(r=>r.label==='switch-off').events,summary.find(r=>r.label==='native').events);
console.log('PASS executor switch-off parity: full normalized journal equals pristine native');
fs.writeFileSync(new URL('evidence.json',root),JSON.stringify(summary,null,2));
