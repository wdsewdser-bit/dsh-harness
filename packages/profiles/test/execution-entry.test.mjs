import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createExecutionScopes } from '../execution-scope.mjs';
import { scopedSubprocessRuntime,createSubprocessTracker } from '../session-subprocess.mjs';
import { loadBuild } from '../../adapter-dsh/index.mjs';
const E={teamId:'team',memberId:'member:w',generation:1,attemptId:'attempt:entry',attemptFence:1,executionSessionId:'session:entry'};
const coverage={gates:true,attribution:true,transport:true,subprocess:true};
const subject={kind:'attempt',id:E.attemptId,fence:1};

test('real async spawn wrapper reserves before the provider returns a handle; cleanup cannot spawn B',async()=>{
  const scopes=createExecutionScopes(),scope=scopes.open(E,coverage),tracker=createSubprocessTracker();
  let resolve,invoked=0;
  class Base {spawn(){invoked++;return {done:new Promise(()=>{}),waitForExit:async()=>true};}spawnTerminal(){invoked++;return new Promise(r=>resolve=r);}}
  const Runtime=scopedSubprocessRuntime(Base,tracker,()=>({memberId:E.memberId,sessionId:E.executionSessionId,basis:'scope'}),scopes),runtime=new Runtime();
  const Unknown=scopedSubprocessRuntime(Base,tracker,()=>({memberId:null,sessionId:null}),createExecutionScopes());
  assert.throws(()=>new Unknown().spawn({}),/EXECUTION_SCOPE_MISSING/);assert.equal(invoked,0);
  const pending=runtime.spawnTerminal({});assert.equal(invoked,1);assert.equal(scope.snapshot().active,1);scope.seal();
  assert.throws(()=>runtime.spawn({}),/EXECUTION_SEALED/);assert.equal(invoked,1);
  assert.equal(scope.prove(subject).verified,false);
  resolve({done:new Promise(()=>{}),waitForExit:async()=>true});await pending;
  assert.equal(scope.snapshot().active,1);assert.equal(tracker.size(),1);
  tracker.retire(tracker.all()[0]);assert.equal(scope.prove(subject).verified,false,'direct-child exit cannot establish grandchildren coverage');
});

test('actual patched adapter boundary gates each send and internal retry, not an observational listener',async()=>{
  const module=await loadBuild('dsh-llm');assert.equal(module.EXECUTION_PERMIT_CONTRACT,'execution-permit/1');
  const scopes=createExecutionScopes(),scope=scopes.open(E,coverage),call=scope.call();let sent=0;
  const options={sessionId:E.executionSessionId,provider:'offline',model:'model',messages:[]};
  const adapter=module.registerExecutionTarget({dispatchContract:module.DISPATCH_CONTRACT,executionPermitContract:'execution-permit/1'});
  const service={ctx:{events:{dispatch:()=>[]}},forAdapter:o=>o};
  const prepared={registration:{adapter},modelInfo:{},config:options,dispatch:final=>(async function*(){
    const attempt=module.dispatchAttemptOf(final);
    attempt.phase('send-started',{transmission:1});sent++;attempt.phase('committed',{transmission:1});
    yield {type:'test-headers'};
    // Simulate the provider's retry/fallback after a streamed response. The same actual phase method runs BEFORE fetch.
    attempt.phase('send-started',{transmission:2});sent++;yield {type:'second-send'};
  })()};
  const iterator=module.LlmRuntime.prototype.adapterStream.call(service,options,prepared);
  const first=await module.withExecutionCall(call,()=>iterator.next());
  assert.equal(first.value.type,'test-headers');assert.equal(sent,1);assert.equal(scope.activities('transmission').length,1);
  scope.seal();await module.withExecutionCall(call,()=>iterator.next());
  assert.equal(sent,1,'retry refused before any second side effect');call.close();
  assert.equal(scope.prove(subject).verified,false,'early/error iterator never erases a started transmission');
});



test('real DeepSeek HTTP path: headers cannot prove drained; no new send after seal', {timeout:15000},async()=>{
  const [llm,deepseek,cordis]=await Promise.all(['dsh-llm','dsh-llm-deepseek','cordis'].map(loadBuild));
  const sockets=new Set();let requests=0,headers;
  const committed=new Promise(r=>headers=r);
  const server=http.createServer((req,res)=>{requests++;sockets.add(req.socket);res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const ctx=new cordis.Context(),runtime=new llm.LlmRuntime(ctx),abort=new AbortController();
  const scopes=createExecutionScopes(),scope=scopes.open(E,coverage),call=scope.call();
  ctx.on('llm/dispatch',event=>{if(event.phase==='committed')headers();});
  deepseek.registerDeepSeekProvider(ctx,'deepseek',{
    options:()=>deepseek.resolveAdapterOptions({baseURL:'http://127.0.0.1:'+server.address().port},undefined),
    resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'offline-test',resolveAttachments:()=>undefined,
  });
  llm.registerExecutionTarget(runtime.registration('deepseek').adapter); // fixture installation audits this local-only transport
  const options={provider:'deepseek',model:'probe-model',sessionId:E.executionSessionId,signal:abort.signal,
    messages:[llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'offline'}]})]};
  let pump;
  try {
    pump=llm.withExecutionCall(call,async()=>{for await(const chunk of runtime.stream(options)){} });
    await committed;assert.equal(requests,1);scope.seal();assert.equal(scope.prove(subject).verified,false);
    await llm.withExecutionCall(call,async()=>{for await(const chunk of runtime.stream(options)){} });
    assert.equal(requests,1,'the actual provider never reaches a second fetch after seal');
    abort.abort();await pump;call.close();assert.equal(scope.prove(subject).verified,false);
  }finally{
    abort.abort();for(const socket of sockets)socket.destroy();await pump?.catch(()=>{});
    await new Promise(r=>server.close(r));await ctx.fiber.dispose();
  }
});


test('uncontrolled provider is refused before model preparation can create any IO',async()=>{
  const module=await loadBuild('dsh-llm'),scope=createExecutionScopes().open(E,coverage),call=scope.call();
  let sideEffects=0;
  const adapter={prepareCall:async()=>{sideEffects++;throw Error('must not run');}},options={provider:'custom',model:'m',messages:[]};
  const service={ctx:{events:{dispatch:()=>[]}},registration:()=>({adapter})};
  await module.withExecutionCall(call,async()=>{for await(const chunk of module.LlmRuntime.prototype.adapterStream.call(service,options)){} });
  assert.equal(sideEffects,0);call.close();scope.seal();assert.equal(scope.prove(subject).verified,false);
});

