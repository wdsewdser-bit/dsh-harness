import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Session, SessionStore, installNativeSessionBridge } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import { ReactLoopAgent, ReactLoopInbox, inboxProjectionDefinition, turnBoundaryProjectionDefinition } from '../app/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js';
import { ToolRuntime } from '../app/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
import { GoalService } from '../app/node_modules/@deepseek-ai/dsh-goal/lib/index.js';
import { SessionCommandController } from '../app/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js';
import JsonlSessionPersistence from '../app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const load = n => import(pathToFileURL(require.resolve('@deepseek-ai/'+n)));
const { Context, getHostLifecycleGate } = await load('cordis');
const { SessionProjectionRegistry } = await load('dsh-session-projection');
const { SystemPrompt } = await load('dsh-system-prompt');
const { AgentRegistry } = await load('dsh-agent');
const { LlmRuntime, LlmAdapter, createUserMessage } = await load('dsh-llm');
const deferred = () => Promise.withResolvers();
const message = text => createUserMessage({content:[{type:'text',text}],source:{kind:'user',rpcId:text}});
const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup(options={}) {
  const ctx = new Context();
  await tick();
  const fixture = await getHostLifecycleGate(ctx).runAsync(async () => {
  const sessions = new SessionStore(ctx);
  const projections = new SessionProjectionRegistry(ctx);
  projections.register(inboxProjectionDefinition);
  projections.register(turnBoundaryProjectionDefinition);
  new SystemPrompt(ctx, {includeHarnessIdentity:false, includeRuntimeContext:false});
  new AgentRegistry(ctx);
  const session = Session.create('isolated-fixture');
  sessions.enter(session); sessions.announce(session);
  const agent = new ReactLoopAgent(ctx, session.id, {provider:'fixture',model:'fixture'}, session);
  ctx.agents.enter(agent, {dispose:async()=>{}});
  const bridge = installNativeSessionBridge(session,{sessionId:session.id,isolated:true,flush:async()=>true,...options});
  // Disable automatic launch only for admission/reservation fixtures; driver tests restore it.
  const wake = agent.wakeDriver.bind(agent);
  agent.wakeDriver = () => {};
  return {ctx,sessions,session,agent,bridge,projections,wake};
  });
  await tick();
  return fixture;
}
test('exact opt-in and real SessionStore flush(false) are fail closed', async()=>{
  const ctx = new Context(); const sessions = new SessionStore(ctx);
  const session = Session.create('plain'); sessions.enter(session);
  assert.throws(()=>installNativeSessionBridge(session,{sessionId:'other',isolated:true,flush:()=>true}));
  const bridge=installNativeSessionBridge(session,{sessionId:session.id,isolated:true,flush:s=>sessions.flush(s)});
  await assert.rejects(bridge.requireDurable(), /DURABILITY_UNAVAILABLE/);
});
test('accepted-before-ack, serialized A/B/C, transport duplicate and reservation replay',async()=>{
  const barrier=deferred(); let flushes=0;
  const f=await setup({flush:async()=>{if(++flushes===1) await barrier.promise;return true;}});
  let acknowledged=false;
  const a=f.agent.steer(message('A')).then(()=>{acknowledged=true;});
  const b=f.agent.steer(message('B')); const c=f.agent.steer(message('C'));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(acknowledged,false);
  barrier.resolve(); await Promise.all([a,b,c]);
  await f.agent.steer(message('A'));
  assert.deepEqual(f.agent.inbox.nextStep.map(m=>m.source.rpcId),['A','B','C']);
  const claimed=f.agent.inbox.claim('next-step',1);
  assert.equal(f.agent.inbox.nextStep.length,3);
  const restored=Session.create(f.session.id,f.session.snapshotEvents());
  const inbox=new ReactLoopInbox(f.projections,restored,{emit(){}});
  assert.equal(inbox.nextStep.length,3);
  for(const m of claimed) restored.append('user/message',m,{surfaceOp:'append'});
  const committed=Session.create(restored.id,restored.snapshotEvents());
  assert.equal(new ReactLoopInbox(f.projections,committed,{emit(){}}).hasPending,false);
});
test('flush failure rejects acceptance but retains same input ID for retry',async()=>{
  let fail=true; const f=await setup({flush:async()=>!fail});
  await assert.rejects(f.agent.steer(message('A')),/DURABILITY_UNAVAILABLE/);
  fail=false; await f.agent.steer(message('A'));
  assert.equal(f.agent.inbox.nextStep.length,1);
});

test('duplicate user input after successor sampling starts cannot preempt again',async()=>{
  const f=await setup();await f.agent.steer(message('same'));
  const generation=f.bridge.generation,sample=f.bridge.beginSampling(new AbortController().signal);
  await f.agent.steer(message('same'));
  assert.equal(f.bridge.generation,generation);assert.equal(sample.signal.aborted,false);sample.dispose();
});

test('ordinary Team message is queued but does not preempt user sampling',async()=>{
  const f=await setup(),sample=f.bridge.beginSampling(new AbortController().signal);
  await f.agent.steer({...message('team-notice'),source:{kind:'team-message',rpcId:'team-notice'}});
  assert.equal(f.bridge.generation,0);assert.equal(sample.signal.aborted,false);
  assert.equal(f.agent.inbox.nextStep.length,1);sample.dispose();
});

test('durable acceptance generation survives restore and failed flush retry signals only once',async()=>{
  let fail=true;const f=await setup({flush:async()=>!fail});
  await assert.rejects(f.agent.steer(message('retry')),/DURABILITY_UNAVAILABLE/);
  assert.equal(f.bridge.generation,0);fail=false;await f.agent.steer(message('retry'));
  assert.equal(f.bridge.generation,1);
  const event=f.session.snapshotEvents().find(row=>row.type==='native/input-accepted');
  assert.equal(event.data.preemptGeneration,1);
  const restored=Session.create(f.session.id,f.session.snapshotEvents());
  const bridge=installNativeSessionBridge(restored,{isolated:true,sessionId:restored.id,flush:async()=>true});
  assert.equal(bridge.generation,1);
  const inbox=new ReactLoopInbox(f.projections,restored,{emit(){}}),sample=bridge.beginSampling(new AbortController().signal);
  await bridge.accept({inbox,phase:{kind:'idle'},wakeDriver(){}},message('retry'),'next-step',true);
  assert.equal(bridge.generation,1);assert.equal(sample.signal.aborted,false);sample.dispose();
});

test('a later successful flush announces earlier failed acceptance without stale generation replay',async()=>{
  let flushes=0;const f=await setup({flush:async()=>++flushes>1});
  await assert.rejects(f.agent.steer(message('A')),/DURABILITY_UNAVAILABLE/);
  await f.agent.steer(message('B'));assert.equal(f.bridge.generation,2);
  const sample=f.bridge.beginSampling(new AbortController().signal);
  await f.agent.steer(message('A'));
  assert.equal(f.bridge.generation,2);assert.equal(sample.signal.aborted,false);sample.dispose();
  assert.deepEqual(f.agent.inbox.nextStep.map(row=>row.source.rpcId),['A','B']);
});
test('input transport identity binds target, source kind and wakeup rather than silently changing delivery',async()=>{
  const f=await setup();await f.agent.followup(message('identity'));
  await assert.rejects(f.agent.steer(message('identity')),/INPUT_ID_CONFLICT/);
  await assert.rejects(f.bridge.accept(f.agent,{...message('identity'),source:{kind:'team-message',rpcId:'identity'}},'next-turn',true),/INPUT_ID_CONFLICT/);
  await assert.rejects(f.bridge.accept(f.agent,message('identity'),'next-turn',false),/INPUT_ID_CONFLICT/);
  assert.equal(f.agent.inbox.nextTurn.length,1);assert.equal(f.bridge.generation,0);
});
test('queued promotion is one durable inbox transition and retry does not preempt twice',async()=>{
  let fail=false;const f=await setup({flush:async()=>!fail});
  await f.agent.followup(message('queued'));
  f.agent.phase={kind:'running',abort:new AbortController(),turn:1,step:1};
  const id=f.agent.inbox.nextTurn[0].id,sample=f.bridge.beginSampling(new AbortController().signal);
  fail=true;await assert.rejects(f.bridge.promoteQueued(f.agent,id),/DURABILITY_UNAVAILABLE/);
  assert.equal(f.bridge.generation,0);assert.equal(sample.signal.aborted,false);
  assert.equal(f.agent.inbox.nextTurn.length,0);assert.equal(f.agent.inbox.nextStep.length,1);
  fail=false;await f.bridge.promoteQueued(f.agent,id);
  assert.equal(f.bridge.generation,1);assert.equal(sample.signal.aborted,true);sample.dispose();
  const next=f.bridge.beginSampling(new AbortController().signal);
  await f.bridge.promoteQueued(f.agent,id);
  assert.equal(next.signal.aborted,false);assert.equal(f.bridge.generation,1);next.dispose();
  const events=f.session.snapshotEvents(),promotion=events.find(row=>row.data.action==='promote');
  assert.ok(promotion);assert.equal(events.filter(row=>row.data.action==='promote').length,1);
  for(const cutoff of [promotion.seq,promotion.seq+1]){
    const restored=Session.create(f.session.id,events.slice(0,cutoff));
    const inbox=new ReactLoopInbox(f.projections,restored,{emit(){}});
    assert.equal(inbox.nextTurn.length+inbox.nextStep.length,1);
    assert.equal(inbox.nextStep.length,cutoff===promotion.seq?0:1);
  }
  const restored=Session.create(f.session.id,events),bridge=installNativeSessionBridge(restored,{isolated:true,sessionId:restored.id,flush:async()=>true});
  assert.equal(bridge.generation,1);
  await bridge.promoteQueued({inbox:new ReactLoopInbox(f.projections,restored,{emit(){}}),wakeDriver(){},phase:{kind:'idle'}},id);
  assert.equal(bridge.generation,1);
});
test('queued promotion refuses foreign, removed, non-user and hard-aborted pending input',async()=>{
  for(const kind of ['foreign','removed','team','abort']){
    const f=await setup(),msg=kind==='team'?{...message(kind),source:{kind:'team-message',rpcId:kind}}:message(kind);
    await f.agent.followup(msg);const id=f.agent.inbox.nextTurn[0].id;
    f.agent.phase={kind:'running',abort:new AbortController(),turn:1,step:1};
    if(kind==='removed')f.agent.inbox.remove(id);
    if(kind==='abort')f.bridge.abortTurn();
    await assert.rejects(f.bridge.promoteQueued(f.agent,kind==='foreign'?'foreign-id':id),/QUEUE_STEER_UNAVAILABLE/);
    assert.equal(f.bridge.generation,0);
  }
});
test('subscribe-before-check catches acceptance during preparation and hard abort wins',async()=>{
  const f=await setup(); const generation=f.bridge.generation;
  await f.agent.steer(message('A'));
  const turn=new AbortController(); const sample=f.bridge.beginSampling(turn.signal,generation);
  assert.equal(sample.signal.aborted,true); sample.dispose();
  const next=f.bridge.beginSampling(turn.signal);
  f.agent.phase={kind:'running',abort:turn,turn:1,step:1};
  f.agent.cancel({kind:'interrupted'},{keepInbox:true});
  await f.agent.steer(message('B'));
  assert.equal(next.signal.aborted,true);
  assert.equal(f.bridge.hardAborted,true);
  assert.throws(()=>f.bridge.admit(f.bridge.generation),/ADMISSION_CLOSED/);
  next.dispose();
});
test('writer fence covers actual Session append, stale release, CAS and accepts pending input',async()=>{
  const f=await setup(); const revision=f.bridge.surfaceRevision;
  const token=f.bridge.acquireWriter(revision);
  assert.throws(()=>f.session.append('session/title',{title:'late'}),/WRITER_FENCED/);
  await f.agent.steer(message('A'));
  f.session.append('user/message',message('surface'),{surfaceOp:'append',writerToken:token,expectedSurfaceRevision:revision});
  assert.throws(()=>f.session.append('session/title',{title:'stale'},{writerToken:token,expectedSurfaceRevision:revision}),/SURFACE_CAS_CONFLICT/);
  f.bridge.releaseWriter(token);
  assert.throws(()=>f.session.append('session/title',{title:'late'},{writerToken:token}),/STALE_WRITER/);
  assert.equal(f.agent.inbox.nextStep.length,1);
});
function tool(f,execute) {
  const runtime=new ToolRuntime(f.ctx);
  runtime.register({name:'mutation',parameters:{type:'object',properties:{}},output:{schema:{type:'object',properties:{count:{type:'number'}},required:['count']},render:(_,v)=>[{type:'text',text:String(v.count)}],presentationMeta:(_,v)=>({count:v.count})},execute});
  return runtime;
}
test('real tool mutation settles after hardabort with original success value/meta and durable receipt',async()=>{
  const f=await setup(); let world=0; const entered=deferred(); const finish=deferred();
  const runtime=tool(f,async(_,exec)=>{world++;entered.resolve(exec);await finish.promise;return {count:world};});
  const abort=new AbortController();
  const pending=runtime.execute({name:'mutation',arguments:{},callId:'call-1',agent:f.agent,signal:abort.signal});
  const exec=await entered.promise;
  assert.throws(()=>f.bridge.acquireWriter(f.bridge.surfaceRevision),/CAS_CONFLICT/);
  abort.abort(); f.bridge.abortTurn();
  assert.equal(exec.signal.aborted,false);
  finish.resolve(); const result=await pending;
  assert.equal(world,1); assert.equal(result.isError,false);
  assert.deepEqual(result.value,{count:1}); assert.deepEqual(result.meta,{count:1});
  const receipt=f.session.snapshotEvents().find(e=>e.type==='native/tool-effect');
  assert.deepEqual(receipt.data.result.value,result.value);
  assert.equal(receipt.data.effectOutcome,'succeeded');
});
test('late body admission after asynchronous wrapper and nested transport is denied',async()=>{
  for(const nested of [false,true]) {
    const f=await setup(); let world=0; const entered=deferred(); const release=deferred();
    const runtime=tool(f,()=>{world++;return {count:world};});
    f.ctx.on('tools/execute',async(exec,next)=>{entered.resolve();await release.promise;return next();});
    const pending=runtime.execute({name:'mutation',arguments:{},callId:'late',agent:f.agent,signal:new AbortController().signal,...nested?{parent:{callId:'root'}}:{}});
    await entered.promise; await f.agent.steer(message('new'));release.resolve();
    const result=await pending; assert.equal(world,0);assert.equal(result.isError,true);
  }
});
test('GoalService completion bridge validates canonical receipt at service boundary',async()=>{
  let receipt;
  const f=await setup({goalCompletion:{isBound:()=>true,verifyReceipt:r=>r===receipt&&!!r,authorize:async({commit})=>{commit(receipt);return receipt;}}});
  const service=new GoalService(f.ctx);
  const goal=service.create(f.agent,{objective:'Bound fixture'}); const ref={id:goal.id,revision:goal.revision};
  await assert.rejects(service.complete(f.agent,ref),/Invalid canonical/);
  assert.equal(service.get(f.agent).phase,'active');
  receipt={id:'canonical-fixture'};
  const result=await service.complete(f.agent,ref);
  assert.equal(result.phase,'complete');
});
test('actual JSONL persisted accepted input survives abrupt subprocess exit and claim recovery',async()=>{
  const root=await mkdtemp(join(tmpdir(),'native-crash-'));
  const child=spawnSync(process.execPath,['--import',new URL('../tools/prepare-unified-lab-host.mjs',import.meta.url).href,new URL('./native-crash-fixture.mjs',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'),root],{encoding:'utf8',timeout:15000,env:{...process.env,DSH_LAB_CANONICAL_MODULES:'1'}});
  assert.equal(child.status,17,child.stderr);
  const ctx=new Context(); const backend=new JsonlSessionPersistence(ctx,{root,compression:'none'});
  const handle=await backend.open('native-crash','read'); const read=await handle.read();
  const restored=Session.create('native-crash',read.events,handle.header);
  await tick();
  const projections=new SessionProjectionRegistry(ctx); projections.register(inboxProjectionDefinition);
  const inbox=new ReactLoopInbox(projections,restored,{emit(){}});
  assert.equal(inbox.nextStep.length,1);
  assert.equal(inbox.nextStep[0].source.nativeInputId,'crash-A');
  await handle.close();
});
function adapter(f, stream) {
  const llm=new LlmRuntime(f.ctx);
  llm.registerAdapter(['fixture'],new class extends LlmAdapter {
    providerInfo(provider){return {id:provider,name:provider};}
    async prepareCall(provider,model){return {model:{provider,id:model,name:model},stream};}
  }());
  f.agent.wakeDriver=f.wake;
}
test('actual driver consumes transformed quiet notices once without replaying their reserved inbox batch',{timeout:5000},async()=>{
  const f=await setup();let requests=0
  f.agent.inbox.append('next-step',{...message('quiet-A'),source:{kind:'subagent-settled'}})
  f.agent.inbox.append('next-step',{...message('quiet-B'),source:{kind:'subagent-settled'}})
  f.ctx.on('agent/pre-step',async(_,next)=>{
    const decision=await next(),quiet=decision.messages.filter(m=>m.source.kind==='subagent-settled')
    return quiet.length ? {...decision,messages:[message('quiet-batch')]} : decision
  })
  adapter(f,()=> (async function*(){
    if(++requests>1)throw new Error('QUIET_BATCH_REPEATED')
    yield {type:'text-delta',index:0,text:'one-answer'};yield {type:'finish',reason:{kind:'stop'}}
  })())
  f.agent.wakeDriver();await f.agent.whenIdle()
  assert.equal(requests,1);assert.equal(f.agent.inbox.hasPending,false)
  const restored=Session.create(f.session.id,f.session.snapshotEvents())
  assert.equal(new ReactLoopInbox(f.projections,restored,{emit(){}}).hasPending,false)
  assert.equal(f.session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.source.rpcId==='quiet-batch').length,1)
  const root=await mkdtemp(join(tmpdir(),'native-quiet-claim-')),storageCtx=new Context(),gate=getHostLifecycleGate(storageCtx)
  const backend=await gate.observeSettlement(()=>gate.runAsync(()=>new JsonlSessionPersistence(storageCtx,{root,compression:'none'})))
  const writer=await backend.create(f.session.header)
  await writer.append(f.session.snapshotEvents());await writer.flush();await writer.close()
  const reader=await backend.open(f.session.id,'read'),cold=await reader.read();await reader.close()
  const coldSession=Session.create(f.session.id,cold.events)
  assert.equal(new ReactLoopInbox(f.projections,coldSession,{emit(){}}).hasPending,false)
  await gate.observeSettlement(()=>gate.runAsync(()=>storageCtx.fiber.dispose()))
})

test('reservation commit is the final delivered message and cannot consume later arrivals',async()=>{
  const f=await setup(),first=message('first'),second=message('second'),late=message('late')
  f.agent.inbox.append('next-step',first);f.agent.inbox.append('next-step',second)
  const reserved=f.agent.inbox.claim('next-step',1);f.agent.inbox.append('next-step',late)
  f.session.append('user/message',message('partial-transformation'),{surfaceOp:'append'})
  assert.equal(f.agent.inbox.nextStep.length,3)
  f.session.append('user/message',{...message('transformation-committed'),source:{kind:'user',
    nativeInboxConsumedIds:reserved.map(m=>m.id)}},{surfaceOp:'append'})
  assert.deepEqual(f.agent.inbox.nextStep.map(m=>m.id),[late.id])
  assert.throws(()=>inboxProjectionDefinition.apply({ 'next-turn':[], 'next-step':[] },
    {type:'user/message',seq:99,data:{source:{nativeInboxConsumedIds:['duplicate','duplicate']}}}),/invalid persisted inbox consumption/)
})

test('actual ReactLoop driver preempts stream, batches steer, preserves history and marks UI superseded', {timeout:5000}, async()=>{
  const f=await setup(); const started=deferred(); let requests=0; const frames=[];
  f.ctx.on('agent/assistant-stream',({frame})=>frames.push(frame));
  adapter(f, request=>(async function*(){
    requests++;
    if(requests===1){
      yield {type:'text-delta',index:0,text:'obsolete'};
      started.resolve();
      await new Promise((_,reject)=>{const fail=()=>reject(request.signal.reason);request.signal.addEventListener('abort',fail,{once:true});if(request.signal.aborted)fail();});
    }else{
      yield {type:'text-delta',index:0,text:'fresh'};
      yield {type:'finish',reason:{kind:'stop'}};
    }
  })());
  await f.agent.followup(message('start'));
  await started.promise;
  await Promise.all([f.agent.steer(message('A')),f.agent.steer(message('B')),f.agent.steer(message('C'))]);
  await f.agent.whenIdle();
  assert.equal(requests,2);
  const history=f.session.deriveMessages();
  assert.deepEqual(history.filter(m=>m.role==='user').map(m=>m.source.rpcId),['start','A','B','C']);
  assert.equal(history.some(m=>m.content.some(b=>b.text==='obsolete')),false);
  assert.ok(frames.some(frame=>frame.type==='end'&&frame.superseded===true));
  const interrupted=f.session.snapshotEvents().filter(e=>e.type==='native/sampling-interrupted');
  assert.equal(interrupted.length,1);
  assert.equal(interrupted[0].data.partial,true);
  assert.equal(interrupted[0].data.superseded,true);
  assert.equal(interrupted[0].data.reason,'sampling-preempt');
  assert.equal(f.agent.inbox.hasPending,false);
});
test('actual retry hook receives sampling abort and cannot dispatch old generation again', {timeout:5000}, async()=>{
  const f=await setup(); const retryEntered=deferred(); const release=deferred(); let requests=0;
  adapter(f, ()=> (async function*(){requests++;yield {type:'finish',reason:requests===1?{kind:'error',failure:{message:'retry fixture',code:'TRANSIENT'}}:{kind:'stop'}};})());
  f.ctx.on('agent/request-error',async()=>{retryEntered.resolve();await release.promise;return {kind:'retry'};});
  await f.agent.followup(message('start'));await retryEntered.promise;
  await f.agent.steer(message('new'));release.resolve();await f.agent.whenIdle();
  assert.equal(requests,2);
  assert.equal(f.session.deriveMessages().filter(m=>m.source?.rpcId==='new').length,1);
});
test('actual API prompt waits for durable acceptance, including duplicate retry',async()=>{
  const barrier=deferred();const f=await setup({flush:async()=>{await barrier.promise;return true;}});
  f.ctx.provide('attachments',{admitPromptContent:async content=>content});
  f.ctx.provide('fileUploads',{resolve(){},bindPrompt(){return {commit(){},[Symbol.dispose](){}};}});
  const controller=new SessionCommandController(f.ctx,{resolveAgent:async()=>({agent:f.agent})},process.cwd());
  const request={sessionId:f.session.id,requestId:'api-input',mode:'steer',content:[{type:'text',text:'API'}]};
  let ack=false;const pending=controller.prompt(request).then(result=>{ack=result.accepted;});
  for(let i=0;i<10;i++)await Promise.resolve();
  assert.equal(ack,false);barrier.resolve();await pending;
  assert.equal(ack,true);await controller.prompt(request);
  assert.equal(f.agent.inbox.nextStep.length,1);
});
test('actual driver hardabort prevents successor even with an accepted steer', {timeout:5000},async()=>{
  const f=await setup();const started=deferred();const release=deferred();let requests=0;
  adapter(f,request=>(async function*(){requests++;started.resolve();await release.promise;request.signal.throwIfAborted();yield {type:'finish',reason:{kind:'stop'}};})());
  await f.agent.followup(message('start'));await started.promise;
  await f.agent.steer(message('pending'));f.agent.cancel({kind:'user'},{keepInbox:true});release.resolve();
  await f.agent.whenIdle();assert.equal(requests,1);assert.equal(f.agent.inbox.nextStep.length,1);
});
test('ordinary non-opt-in inbox claim and tool cancellation retain the released contract',async()=>{
  const ctx=new Context(); await tick();
  const {sessions,projection} = await getHostLifecycleGate(ctx).runAsync(async () => {
  const sessions=new SessionStore(ctx);const projection=new SessionProjectionRegistry(ctx);projection.register(inboxProjectionDefinition);
  new SystemPrompt(ctx,{includeHarnessIdentity:false,includeRuntimeContext:false});
  return {sessions,projection};
  });
  await tick();
  const session=Session.create('ordinary');sessions.enter(session); const inbox=new ReactLoopInbox(projection,session,{emit(){}});
  inbox.append('next-step',message('ordinary'));assert.equal(inbox.claim('next-step',1).length,1);assert.equal(inbox.hasPending,false);
  const entered=deferred();const release=deferred();let world=0;const agent={session};
  const runtime=tool({ctx},async()=>{world++;entered.resolve();await release.promise;return {count:world};});
  const abort=new AbortController();const pending=runtime.execute({name:'mutation',arguments:{},callId:'ordinary',agent,signal:abort.signal});
  await entered.promise;abort.abort();release.resolve();const result=await pending;
  assert.equal(world,1);assert.equal(result.isError,true);assert.equal(session.snapshotEvents().some(e=>e.type==='native/tool-effect'),false);
});
test('nested calls keep parent generation even after successor sampling begins',async()=>{
  const f=await setup(); const rootStarted=deferred();const release=deferred();let childWorld=0;
  const runtime=tool(f,async(_,exec)=>{
    if(exec.parent){childWorld++;return {count:childWorld};}
    rootStarted.resolve(exec.token);await release.promise;return {count:0};
  });
  const root=runtime.execute({name:'mutation',arguments:{},callId:'root-generation',agent:f.agent,signal:new AbortController().signal});
  const parent=await rootStarted.promise;await f.agent.steer(message('preempt'));
  const sample=f.bridge.beginSampling(new AbortController().signal);
  const result=await runtime.execute({name:'mutation',arguments:{},callId:'old-nested',parent,agent:f.agent,signal:new AbortController().signal});
  assert.equal(result.isError,true);assert.equal(childWorld,0);sample.dispose();release.resolve();await root;
});
