import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncResource } from 'node:async_hooks';
import http from 'node:http';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
import { loadBuild } from '../../adapter-dsh/index.mjs';
import { installRuntime } from '../runtime.mjs';
import { installLlmExecutionEntries } from '../llm-execution.mjs';
import { createExecutionScopes } from '../execution-scope.mjs';

async function world() {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-execution-entries-')),store=new ControlStore(root),listeners=new Map();
 const core=new TeamCore(store,{}, {enabled:true,autonomy:'on'});core.member('member:w','worker');
 const module=await loadBuild('dsh-llm');let sends=0,networkWork=async()=>[];
 const ctx={llm:{executionPermitContract:'execution-permit/1',isAgentLoopRequest:()=>true},subprocess:{},
  tools:{register(){}},on(name,fn){const set=listeners.get(name)??new Set();set.add(fn);listeners.set(name,set);return()=>set.delete(fn);},
  agents:{currentInitiator:()=>null}};
 for(const name of ['prepareCall','listModels','discoverModels','remoteDiscoverModels','resolveModelInfo','resolveModelInfoFor','resolveCallConfig',
   'resolveCallFor'])
   ctx.llm[name]=async()=>module.executionNetwork(async()=>{sends++;return networkWork();});
 const adapter=module.registerExecutionTarget({executionPermitContract:'execution-permit/1'});ctx.llm.registration=()=>({adapter});ctx.llm.discoveries=new Map(
   [['p',adapter]]);
 ctx.llm.adapters=new Map([['p',{adapter}]]);
 const runtime=installRuntime(ctx,core);await runtime.stop.ready;await Promise.resolve();
 const session={id:'same-session',seq:0,snapshotEvents:()=>[]};let wakes=0;
 const agent={session,phase:{kind:'idle'},wakeDriver(){wakes++;},preemptStep(){wakes++;return true;},followup(){wakes++;},cancel(){},async whenIdle(){},ctx:{
   tools:{register(){},restrict(){},guard(){}}}};
 runtime.handles.set('member:w',{agent});runtime.bindSessionToMember(agent,'member:w');
 const bind=n=>{
  const id='attempt:'+n;core.mutate(id,'scheduler',{},tx=>tx.put(id,{owner:'member:w',taskId:'task:'+n,generation:1,fence:1,lease:'active',status:'running',
    executionSessionId:session.id}));
  runtime.bindAgent('member:w',{attemptId:id,generation:1,fence:1});const scope=runtime.executionScopes.get(session.id);
  scope.coverage('transport',true);scope.coverage('subprocess',true);return scope;
 };
 const release=scope=>{scope.seal();const proof=scope.prove({kind:'attempt',id:scope.E.attemptId,fence:1});const payload={proof,evidenceRef:'proof:'+
   scope.E.executionEpoch};core.dispatch(scope.E.attemptId,'adapter',payload,{type:'execution.close',payload});scope.released(proof);};
 return {root,store,core,ctx,runtime,agent,listeners,bind,release,module,setNetwork(work){networkWork=work;},get sends(){return sends;},get wakes(){
   return wakes;},close(){store.close();fs.rmSync(root,{recursive:true,force:true});}};
}

test('production runtime bounded rebind: inherited E1 callback cannot acquire any E2 permit on the same session',async()=>{
 const w=await world();try{
  const old=w.bind(1),invoke=AsyncResource.bind(()=>w.agent.wakeDriver());
  const metadata=old.run(()=>AsyncResource.bind(()=>w.ctx.llm.listModels('p')));
  const tools=old.run(()=>AsyncResource.bind(()=>[...w.listeners.get('tools/execute')][0]({agent:w.agent,callId:'old',name:'io'},()=>{throw Error(
    'must not execute');})));
  // Save the wake callback WITH E1 inherited identity, not as an unscoped host callback.
  const inherited=old.run(()=>AsyncResource.bind(()=>w.agent.wakeDriver()));
  const stream=old.run(()=>[...w.listeners.get('llm/stream')][0]({sessionId:w.agent.session.id},()=>{throw Error('must not dispatch');}));
  w.release(old);const fresh=w.bind(2),before=fresh.snapshot().active;
  assert.throws(inherited,/EXECUTION_CONTEXT_STALE/);await assert.rejects(metadata(),/EXECUTION_CONTEXT_STALE/);await assert.rejects(tools(),
    /EXECUTION_CONTEXT_STALE/);
  await assert.rejects(stream.next(),/EXECUTION_SEALED/);
  assert.equal(w.wakes,0);assert.equal(w.sends,0);assert.equal(fresh.snapshot().active,before);
  invoke();assert.equal(w.wakes,1,'a genuinely unscoped, current host wake may enter E2');
  w.release(fresh);
 }finally{w.close();}
});

test('production runtime metadata entries: bounded send/seal orders; explicit host control is separate from member identity',async()=>{
 for(const sealFirst of [false,true]) {
  const w=await world();try{
   const scope=w.bind(1),entries=['listModels','discoverModels','remoteDiscoverModels','resolveModelInfo','resolveModelInfoFor','resolveCallConfig',
     'resolveCallFor','prepareCall'];
   if(sealFirst)scope.seal();
   for(const name of entries) {
    if(sealFirst)await assert.rejects(scope.run(()=>w.ctx.llm[name]('p')),/EXECUTION_SEALED/);
    else await scope.run(()=>w.ctx.llm[name](['resolveModelInfoFor','resolveCallFor'].includes(name)?w.ctx.llm.registration('p'):['prepareCall',
      'resolveCallConfig'].includes(name)?{provider:'p'}:'p'));
   }
   assert.equal(w.sends,sealFirst?0:entries.length);
   if(!sealFirst){
     let resume,started;
     const ready=new Promise(r=>started=r);w.setNetwork(()=>new Promise(r=>{resume=r;started();}));
     const pending=scope.run(()=>w.ctx.llm.resolveModelInfo('p'));await ready;scope.seal();
     assert.equal(scope.prove({kind:'attempt',id:scope.E.attemptId,fence:1}).verified,false);
     assert.ok(scope.snapshot().active>=2,'metadata C and physical X are both pending before response');
     resume([]);await pending;
   }
   if(!sealFirst)scope.seal();assert.equal(scope.prove({kind:'attempt',id:scope.E.attemptId,fence:1}).verified,true);
   assert.throws(()=>w.module.executionNetwork(()=>{throw Error('unpermitted side effect');}),/EXECUTION_CALL_REQUIRED/);
   await w.runtime.hostControl('model-catalog',()=>w.module.executionNetwork(async()=>{}));
   assert.throws(()=>scope.run(()=>w.runtime.hostControl('model-catalog',()=>{})),/HOST_CONTROL_FROM_MEMBER/);
  }finally{w.close();}
 }
});

test('real requestModelListing has no ambient capability fallback before or after seal',async()=>{
 const w=await world(),provider=await loadBuild('dsh-llm-deepseek'),previous=globalThis.fetch;let sends=0;
 globalThis.fetch=async()=>{sends++;return new Response(JSON.stringify({data:[{id:'model',name:'Model'}]}),{status:200});};
 try{
  const scope=w.bind(1);scope.seal();
  await assert.rejects(scope.run(()=>provider.requestModelListing(new URL('http://127.0.0.1/models'),{},new AbortController().signal)));
  assert.equal(sends,0);assert.equal(scope.snapshot().active,0);assert.equal(scope.prove({kind:'attempt',id:scope.E.attemptId,fence:1}).verified,true);
  await w.runtime.hostControl('model-catalog',()=>provider.requestModelListing(new URL('http://127.0.0.1/models'),{},new AbortController().signal));
    assert.equal(sends,1);
 }finally{globalThis.fetch=previous;w.close();}
});

test('metadata member entries reject uncontracted adapter/discovery before any body and invalidate coverage',async()=>{
 for(const name of ['prepareCall','listModels','resolveModelInfo','resolveModelInfoFor','resolveCallConfig','resolveCallFor','discoverModels',
   'remoteDiscoverModels']){
  const w=await world();try{
   const scope=w.bind(1);w.ctx.llm.registration=()=>({adapter:{}});w.ctx.llm.discoveries.set('p',{});
   const arg=['resolveModelInfoFor','resolveCallFor'].includes(name)?{adapter:{}}:['prepareCall','resolveCallConfig'].includes(name)?{provider:'p'}:'p';
   await assert.rejects(scope.run(()=>w.ctx.llm[name](arg)),/EXECUTION_TRANSPORT_UNCONTROLLED/);
   assert.equal(w.sends,0);scope.seal();assert.equal(scope.prove({kind:'attempt',id:scope.E.attemptId,fence:1}).verified,false);
  }finally{w.close();}
 }
});

test('unknown sessions and absent control registration do not mint host authority',async()=>{
 const w=await world();try{
  w.ctx.agents.currentInitiator=()=>({session:{id:'unknown'}});
  await assert.rejects(w.ctx.llm.listModels('p'),/HOST_ENTRY_REQUIRED/);assert.equal(w.sends,0);
  assert.throws(()=>w.runtime.hostControl('arbitrary',()=>{}),/HOST_ENTRY_REQUIRED/);
  await w.runtime.hostControl('model-catalog',()=>w.ctx.llm.listModels('p'));assert.equal(w.sends,1);
 }finally{w.close();}
});

test('v1 host-control capabilities are operation-bound; an unscoped stream needs live owner control; transport trust is checked without an owner',async()=>{
 const module=await loadBuild('dsh-llm'),listeners=new Map();
 const ctx={llm:{executionPermitContract:'execution-permit/1',isAgentLoopRequest:()=>true,
   prepareCall:async()=>[],listModels:async()=>['model'],discoverModels:async()=>[]},
  on(name,fn){const set=listeners.get(name)??new Set();set.add(fn);listeners.set(name,set);return()=>set.delete(fn);},
  agents:{currentInitiator:()=>null}};
 const trusted=module.registerExecutionTarget({executionPermitContract:'execution-permit/1'});
 let registration={adapter:trusted};ctx.llm.registration=()=>registration;
 const observation={reserve(){return{};},finish(){return true;},close(){},unknown(){}};
 const ownerControl={resolve:sid=>sid==='owned'?{call:()=>observation}:null};
 const entries=installLlmExecutionEntries({ctx,scopes:{resolve:()=>null,current:()=>null},memberOfSession:()=>false,
   sessionId:()=>null,authorizeHost:work=>work(),moduleReady:Promise.resolve(module),autonomy:true,borrowV1:true,
   transportReady:()=>true,hostSessionAuthorized:sid=>sid==='owned',ownerControl});
 const listener=[...listeners.get('llm/stream')][0];
 const turn=()=>({[Symbol.asyncIterator]:async function*(){yield {type:'finish',reason:{kind:'stop'}};}});
 // A catalog capability is metadata-only: it may list models, but it cannot drive a request or a stream.
 await entries.hostControl('model-catalog',()=>ctx.llm.listModels('p'));
 await assert.rejects(entries.hostControl('model-catalog',()=>ctx.llm.prepareCall({provider:'p'})),
   e=>e.code==='HOST_ENTRY_SCOPE_VIOLATION');
 await assert.rejects((await entries.hostControl('model-catalog',()=>listener({sessionId:'owned',provider:'p'},turn))).next(),
   e=>e.code==='HOST_ENTRY_SCOPE_VIOLATION');
 // v1: an unscoped stream needs a live owner control call for this exact owner session, not merely a host entry.
 assert.throws(()=>listener({sessionId:'unowned',provider:'p'},turn),e=>e.code==='HOST_ENTRY_REQUIRED');
 // v1 has no session-id-only fallback: a host-authorized session with no resolvable owner call is still refused.
 const bare=installLlmExecutionEntries({ctx,scopes:{resolve:()=>null,current:()=>null},memberOfSession:()=>false,
   sessionId:()=>null,authorizeHost:work=>work(),moduleReady:Promise.resolve(module),autonomy:true,borrowV1:true,
   transportReady:()=>true,hostSessionAuthorized:()=>true,ownerControl:null});
 const bareListener=[...listeners.get('llm/stream')].at(-1);
 await assert.rejects(bareListener({sessionId:'owner-only',provider:'p'},turn).next(),e=>e.code==='HOST_ENTRY_REQUIRED');

 // The transport trust check is not inside the scope/owner branch: an unregistered target is refused even when the
 // owner gate is satisfied.
 registration={adapter:{executionPermitContract:'execution-permit/1'}};
 await assert.rejects(listener({sessionId:'owned',provider:'p'},turn).next(),e=>e.code==='EXECUTION_TRANSPORT_UNCONTROLLED');
 // The same owner-bound stream reaches the provider once the target is registered.
 registration={adapter:trusted};
 const iterator=listener({sessionId:'owned',provider:'p'},turn)[Symbol.asyncIterator]();
 const first=await iterator.next();assert.equal(first.value.type,'finish');
});

test('capability binding matrix: autonomy off/on x borrow off/v1 keeps metadata and owner chains, tightens catalog prepareCall/stream',async()=>{
 for (const autonomy of [false,true]) for (const borrowV1 of [false,true]) {
  const module=await loadBuild('dsh-llm'),listeners=new Map(),calls={listModels:0,discoverModels:0,prepareCall:0,stream:0};
  const ctx={llm:{executionPermitContract:'execution-permit/1',isAgentLoopRequest:()=>true,
    listModels:async()=>{calls.listModels+=1;return [];},discoverModels:async()=>{calls.discoverModels+=1;return [];},
    prepareCall:async()=>{calls.prepareCall+=1;return [];}},
   on(name,fn){const set=listeners.get(name)??new Set();set.add(fn);listeners.set(name,set);return()=>set.delete(fn);},
   agents:{currentInitiator:()=>null}};
  const trusted=module.registerExecutionTarget({executionPermitContract:'execution-permit/1'});
  ctx.llm.registration=()=>({adapter:trusted});ctx.llm.discoveries=new Map([['ns',trusted]]);
  const observation={reserve(){return{};},finish(){return true;},close(){},unknown(){}};
  const ownerControl=borrowV1?{resolve:()=>({call:()=>observation})}:null;
  const entries=installLlmExecutionEntries({ctx,scopes:{resolve:()=>null,current:()=>null},memberOfSession:()=>false,
    sessionId:()=>null,authorizeHost:work=>work(),moduleReady:Promise.resolve(module),autonomy,borrowV1,
    transportReady:()=>true,hostSessionAuthorized:()=>true,ownerControl});
  const listener=[...listeners.get('llm/stream')].at(-1);
  const turn=()=>({[Symbol.asyncIterator]:async function*(){calls.stream+=1;yield {type:'finish',reason:{kind:'stop'}};}});
  const label='autonomy:'+(autonomy?'on':'off')+' borrow:'+(borrowV1?'v1':'off');
  // Metadata capabilities stay compatible in all four combinations.
  await entries.hostControl('model-catalog',()=>ctx.llm.listModels('p'));
  await entries.hostControl('model-discovery',()=>ctx.llm.discoverModels('ns'));
  assert.equal(calls.listModels,1,label);assert.equal(calls.discoverModels,1,label);
  // Intentional tightening, all modes: a catalog capability may not issue prepareCall or drive a stream.
  await assert.rejects(entries.hostControl('model-catalog',()=>ctx.llm.prepareCall({provider:'p'})),
    e=>e.code==='HOST_ENTRY_SCOPE_VIOLATION',label);
  await assert.rejects((await entries.hostControl('model-catalog',()=>listener({sessionId:'owner',provider:'p'},turn))).next(),
    e=>e.code==='HOST_ENTRY_SCOPE_VIOLATION',label);
  assert.equal(calls.prepareCall,0,label);assert.equal(calls.stream,0,label);
  // The owner-conversation chain still works: metadata through it, and (with its owner/off host entry) a stream.
  await entries.hostControl('owner-conversation',()=>ctx.llm.listModels('p'));
  assert.equal(calls.listModels,2,label);
  await assert.doesNotReject(async()=>{
    const iterator=(await entries.hostControl('owner-conversation',()=>listener({sessionId:'owner',provider:'p'},turn)))[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value.type,'finish',label);
  },label);
  assert.equal(calls.stream,1,label);
 }
});

test(
  'real LlmRuntime chains: metadata and owner prepareCall work in all modes; legacy without execution-permit keeps metadata and refuses only catalog overreach',
  async()=>{
 const module=await loadBuild('dsh-llm');
 const make=({autonomy,borrowV1,permitModule=true})=>{
  const listeners=new Map();
  const adapter=module.registerExecutionTarget({executionPermitContract:'execution-permit/1',
    async resolveModel(provider,model){return {provider,id:model,name:model.toUpperCase(),contextWindow:4096};},
    async prepareCall(provider,model){return {model:{provider,id:model,name:model.toUpperCase(),contextWindow:4096}};}});
  const discover=async()=>[{id:'m1',name:'M1',contextWindow:4096}];
  discover.executionPermitContract='execution-permit/1';module.registerExecutionTarget(discover);
  const service={registration:provider=>({provider:{id:provider},adapter}),discoveries:new Map([['ns',discover]]),
    normalizeModelInfo:module.LlmRuntime.prototype.normalizeModelInfo,
    detachedModalities:module.LlmRuntime.prototype.detachedModalities,
    resolveCallWithInfo:module.LlmRuntime.prototype.resolveCallWithInfo,
    resolveModelInfoFor:module.LlmRuntime.prototype.resolveModelInfoFor,
    resolveCallFor:module.LlmRuntime.prototype.resolveCallFor,
    resolveModelInfo:module.LlmRuntime.prototype.resolveModelInfo,
    resolveCallConfig:module.LlmRuntime.prototype.resolveCallConfig,
    discoverModels:module.LlmRuntime.prototype.discoverModels,
    remoteDiscoverModels:module.LlmRuntime.prototype.remoteDiscoverModels,
    resolveModel:(p,m)=>adapter.resolveModel(p,m),
    stream:()=>(async function*(){yield {type:'finish',reason:{kind:'stop'}};})()};
  const llm={executionPermitContract:permitModule?'execution-permit/1':undefined,isAgentLoopRequest:()=>true,
    registration:service.registration,discoveries:service.discoveries};
  for(const name of ['resolveModelInfo','resolveCallConfig','discoverModels','remoteDiscoverModels'])
    llm[name]=(...args)=>service[name].apply(service,args);
  llm.prepareCall=(...args)=>module.LlmRuntime.prototype.prepareCall.apply(service,args);
  const ctx={llm,on(name,fn){const set=listeners.get(name)??new Set();set.add(fn);listeners.set(name,set);return()=>set.delete(fn);},
    agents:{currentInitiator:()=>null}};
  const ownerControl=borrowV1?{resolve:()=>({call:()=>({reserve(){return{};},finish(){return true;},close(){},unknown(){}})})}:null;
  const entries=installLlmExecutionEntries({ctx,scopes:{resolve:()=>null,current:()=>null},memberOfSession:()=>false,
    sessionId:()=>null,authorizeHost:work=>work(),moduleReady:Promise.resolve(permitModule?module:{}),autonomy,borrowV1,
    transportReady:()=>true,hostSessionAuthorized:()=>true,ownerControl});
  return {ctx,entries,listeners};
 };
 for(const autonomy of [false,true]) for(const borrowV1 of [false,true]){
  const label='autonomy:'+(autonomy?'on':'off')+' borrow:'+(borrowV1?'v1':'off');
  const {ctx,entries}=make({autonomy,borrowV1});
  const info=await entries.hostControl('model-catalog',()=>ctx.llm.resolveModelInfo('p','m'));
  assert.equal(info.id,'m',label);assert.equal(info.name,'M',label);
  const config=await entries.hostControl('model-catalog',()=>ctx.llm.resolveCallConfig({provider:'p',model:'m'}));
  assert.equal(config.provider,'p',label);assert.equal(config.model,'m',label);
  const discovered=await entries.hostControl('model-discovery',()=>ctx.llm.remoteDiscoverModels('ns',{provider:'p'}));
  assert.equal(discovered[0].id,'m1',label);
  const prepared=await entries.hostControl('owner-conversation',()=>ctx.llm.prepareCall({provider:'p',model:'m'}));
  assert.equal(prepared.config.model,'m',label);
  await assert.rejects(entries.hostControl('model-catalog',()=>ctx.llm.prepareCall({provider:'p',model:'m'})),
    e=>e.code==='HOST_ENTRY_SCOPE_VIOLATION',label);
 }
 // Legacy/off without any execution-permit module: the legal metadata chain still works through the real methods,
 // while catalog prepareCall remains the only refused operation.
 const legacy=make({autonomy:false,borrowV1:false,permitModule:false});
 const legacyInfo=await legacy.entries.hostControl('model-catalog',()=>legacy.ctx.llm.resolveModelInfo('p','m'));
 assert.equal(legacyInfo.id,'m');
 const legacyConfig=await legacy.entries.hostControl('model-catalog',()=>legacy.ctx.llm.resolveCallConfig({provider:'p',model:'m'}));
 assert.equal(legacyConfig.model,'m');
 const legacyDiscovered=await legacy.entries.hostControl('model-discovery',()=>legacy.ctx.llm.remoteDiscoverModels('ns',{provider:'p'}));
 assert.equal(legacyDiscovered[0].id,'m1');
 const legacyPrepared=await legacy.entries.hostControl('owner-conversation',()=>legacy.ctx.llm.prepareCall({provider:'p',model:'m'}));
 assert.equal(legacyPrepared.config.model,'m');
 await assert.rejects(legacy.entries.hostControl('model-catalog',()=>legacy.ctx.llm.prepareCall({provider:'p',model:'m'})),
   e=>e.code==='HOST_ENTRY_SCOPE_VIOLATION');
});

test('prepared metadata boundaries reject uncontracted concrete targets even without runtime wrapping',async()=>{
 const module=await loadBuild('dsh-llm');let io=0;
 for(const name of ['prepareCall','listModels','resolveModelInfoFor','resolveCallFor','discoverModels']){
  const scope=createExecutionScopes().open({teamId:'t',memberId:'m',generation:1,attemptId:'a',attemptFence:1,executionSessionId:'s'},{gates:true,attribution:
    true,transport:true,subprocess:true}),call=scope.call();
  const work=async()=>{io++;return [];},adapter={prepareCall:work,listModels:work},registration={adapter};
  const service={registration:()=>registration,discoveries:new Map([['ns',work]])};
  const args=name==='prepareCall'?[{provider:'p',model:'m'}]:name==='listModels'?['p']:name==='discoverModels'?['ns',{provider:'p'}]:[registration,{model:'m'}];
  await assert.rejects(module.withExecutionCall(call,()=>module.LlmRuntime.prototype[name].apply(service,args)),/EXECUTION_TRANSPORT_UNCONTROLLED/);
  call.close();scope.seal();assert.equal(scope.prove({kind:'attempt',id:'a',fence:1}).verified,false);
 }
 assert.equal(io,0);
});

test('self-declared adapter cannot start unregistered pending IO or receive complete coverage',async()=>{
 const w=await world();let pending=0;try{
  const scope=w.bind(1),fake={executionPermitContract:'execution-permit/1',prepareCall(){pending++;return {model:{}};}};
  w.ctx.llm.registration=()=>({adapter:fake});
  await assert.rejects(scope.run(()=>w.ctx.llm.prepareCall({provider:'fake'})),/EXECUTION_TRANSPORT_UNCONTROLLED/);
  assert.equal(pending,0);scope.seal();assert.equal(scope.prove({kind:'attempt',id:scope.E.attemptId,fence:1}).verified,false);
  const callScope=createExecutionScopes().open({teamId:'t',memberId:'m',generation:1,attemptId:'a',attemptFence:1,executionSessionId:'s'},{gates:true,
    attribution:true,transport:true,subprocess:true});
  const call=callScope.call();await assert.rejects(w.module.withExecutionCall(call,()=>w.module.LlmRuntime.prototype.prepareCall.call({registration:()=>({
    adapter:fake})},{provider:'fake',model:'m'})),/EXECUTION_TRANSPORT_UNCONTROLLED/);
  call.close();callScope.seal();assert.equal(pending,0);assert.equal(callScope.prove({kind:'attempt',id:'a',fence:1}).verified,false);
 }finally{w.close();}
});

test('real web redirect across seal is never certified complete by the outer tool permit',async()=>{
 const w=await world();let release,started,requests=0;
 const entered=new Promise(r=>started=r),response=new Promise(r=>release=r);
 const server=http.createServer(async(req,res)=>{requests++;if(req.url==='/first'){started();await response;res.writeHead(302,{location:'/last'});res.end();
   }else{res.writeHead(200,{'content-type':'text/plain'});res.end('done');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const module=await loadBuild('dsh-web-fetch-http'),Provider=module.HttpFetchProvider??module.default;
  const provider=Provider?new Provider({timeoutMs:5000,maxRedirects:3,maxBytes:100000,userAgent:'test'}):null;assert.ok(provider,'actual HTTP provider export');
  const scope=w.bind(1),hook=[...w.listeners.get('tools/execute')][0];
  const work=scope.run(()=>hook({agent:w.agent,callId:'web',name:'web_fetch'},()=>provider.fetch({url:'http://127.0.0.1:'+server.address().port+'/first'})));
  await entered;scope.seal();release();await work;assert.equal(requests,2);
  const durable=w.store.read('execution-scope:'+scope.E.executionEpoch);assert.equal(durable.coverage.complete,false);assert.equal(durable.coverage[
    'unmanaged-tool-network'],false);
  assert.equal(scope.prove({kind:'attempt',id:scope.E.attemptId,fence:1}).verified,false);
 }finally{release?.();await new Promise(r=>server.close(r));w.close();}
});

test('installation trust is method identity, not provider string or a later method replacement',async()=>{
 const w=await world();try{
  const adapter=w.ctx.llm.registration('p').adapter;assert.equal(w.module.isExecutionTargetTrusted(adapter),true);
  const scope=w.bind(1);assert.throws(()=>{adapter.prepareCall=()=>({});},TypeError);
  const proto={prepareCall(){}};const mutable=Object.create(proto);mutable.executionPermitContract='execution-permit/1';w.module.registerExecutionTarget(
    mutable);assert.throws(()=>Object.defineProperty(mutable,'prepareCall',{get:()=>()=>({})}),TypeError);
  Object.defineProperty(proto,'prepareCall',{get:()=>()=>({})});assert.equal(w.module.isExecutionTargetTrusted(mutable),false);w.ctx.llm.registration=()=>({
    adapter:mutable});
  await assert.rejects(scope.run(()=>w.ctx.llm.prepareCall({provider:'p'})),/EXECUTION_TRANSPORT_UNCONTROLLED/);
  scope.seal();assert.equal(scope.prove({kind:'attempt',id:scope.E.attemptId,fence:1}).verified,false);
 }finally{w.close();}
});

test('trusted registration rejects getters and proxies without evaluating accessors; immutable methods cannot be shadowed',async()=>{
 const w=await world();let invoked=0;try{
  const target={executionPermitContract:'execution-permit/1'};Object.defineProperty(target,'prepareCall',{configurable:true,get(){invoked++;return ()=>{
    invoked++;};}});
  assert.throws(()=>w.module.registerExecutionTarget(target),/EXECUTION_TARGET_ACCESSOR/);assert.equal(invoked,0);
  Object.defineProperty(target,'prepareCall',{configurable:true,get(){return ()=>{invoked++;};}});assert.equal(w.module.isExecutionTargetTrusted(target),false);
  assert.throws(()=>w.module.registerExecutionTarget(new Proxy({prepareCall(){}},{})),/EXECUTION_TARGET_UNSTABLE/);
  const proto={prepareCall(){return 'safe';}},instance=Object.create(proto);w.module.registerExecutionTarget(instance);
  const d=Object.getOwnPropertyDescriptor(instance,'prepareCall');assert.equal(d.writable,false);assert.equal(d.configurable,false);
  assert.throws(()=>Object.defineProperty(instance,'prepareCall',{get:()=>()=>{invoked++;}}),TypeError);
  assert.throws(()=>Object.setPrototypeOf(instance,{prepareCall(){invoked++;}}),TypeError);assert.equal(invoked,0);
 }finally{w.close();}
});




