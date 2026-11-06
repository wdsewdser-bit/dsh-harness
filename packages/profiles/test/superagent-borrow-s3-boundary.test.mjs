import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTarget } from '../../adapter-dsh/index.mjs';
import { inputPolicy } from '../../core/index.mjs';

/**
 * S3 (§5.4, B06): the wake edge is a capability of its own.
 *
 * The prepared build still ships step preemption, and v1 must be able to use only the atomic idle latch without the
 * seam. Keeping the two facts apart in the target is what makes that choice expressible, and what makes a build
 * without the latch fail at the adapter boundary instead of at the first wake.
 */
test('B06: boundary-wake is reported apart from step preemption and does not require it', () => {
  const target = buildTarget();
  assert.equal(target.boundaryWake.contract, 'boundary-wake/1');
  assert.equal(target.boundaryWake.atomicIdleLatch, true, 'the idle latch is the part v1 keeps');
  assert.equal(target.boundaryWake.wakeOnly, true, 'a wake-only composition is admissible');
  assert.equal(typeof target.boundaryWake.stepAbort, 'boolean', 'step preemption is reported, never required');
  assert.equal(target.preemptExecutor, 'dsh-tool-executor-preempt', 'the legacy arm keeps its executor');
  // The two strategies are selected from the team policy, never from the build: an off team is HEAD even on a build
  // that could preempt.
  assert.equal(inputPolicy({ configuration: { superagentBorrow: 'off' } }), 'preempt');
  assert.equal(inputPolicy({ configuration: { superagentBorrow: 'v1' } }), 'queue');
  assert.equal(inputPolicy({ configuration: { superagentBorrow: 'v1', inputPolicy: 'preempt' } }), 'queue',
    'v1 cannot opt back into step-abort through a stray policy field');
  assert.equal(buildTarget(undefined, { boundaryWakeOnly: true }).nativeExecutor, 'dsh-tool-executor-native');
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { host as nativeHost, loadBuild } from '../../adapter-dsh/index.mjs';
import { createVisibility, createTeamHost } from '../../host/index.mjs';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore, MemberInputArbiter, pendingInputs } from '../../core/index.mjs';
import { registerHostVisibility, assertBoundaryInputRuntime } from '../team-plugin.mjs';

import { createOwnerInputPort } from '../runtime.mjs';
import { installLlmExecutionEntries } from '../llm-execution.mjs';
import { summariseDispatchMessages } from '../../contracts/index.mjs';
async function real() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'s3-host-')), store=new ControlStore(root);
  const core=new TeamCore(store,{}, {enabled:true,attach:true,teamId:'team:b'});
  const host=createTeamHost({root,teamId:'team:b',core,cycleIntervalMs:1000000,
    recoverer:async()=>({status:'ok',admission:true}),openStore:()=>({close(){}})});
  await host.start();
  return {core,store,host,async close(){await host.stop();store.close();fs.rmSync(root,{recursive:true,force:true});}};
}
const chunks={
  text:(index,text)=>[{type:'block-start',index,blockType:'text'},{type:'text-delta',index,text}],
  textEnd:(index,text)=>({type:'block-end',index,block:{type:'text',text}}),
  toolCall:(index,id,name,args)=>[{type:'block-start',index,blockType:'tool-call'},
    {type:'tool-call-delta',index,id,name,argumentsDelta:args},
    {type:'block-end',index,block:{type:'tool-call',id,name,arguments:args}}],
  usage:(input,output)=>({type:'usage',usage:{inputTokens:input,outputTokens:output,totalTokens:input+output}}),
  finish:kind=>({type:'finish',reason:{kind}}),
};
function scriptedAdapter(LlmAdapter,evidence) {
  let script;
  const adapter=new class extends LlmAdapter {
    providerInfo(id){return {id,name:'offline boundary'};}
    async prepareCall(provider,id){return {model:{provider,id,name:id,contextWindow:1000000,inputModalities:['text']},stream:o=>this.stream(o)};}
    async *stream(options){
      const entry=script.entry(evidence.requests.length);
      evidence.requests.push({messages:options.messages.map(m=>({role:m.role,blocks:m.content}))});
      yield* entry.chunks??[];
      if(entry.hold){entry.onHold?.();await entry.hold.promise;}
      yield* entry.tail??[];
    }
  }();
  return {adapter,arm:value=>{script=value;}};
}

const gate = () => Promise.withResolvers();
const deadline = promise => Promise.race([promise, new Promise((_, reject) => {
  const timer = setTimeout(() => reject(Error('real boundary timeout')), 10000); timer.unref();
})]);
const textChunks = text => [...chunks.text(0, text), chunks.textEnd(0, text), chunks.usage(3, 2), chunks.finish('stop')];

test('B01/B05 real: held native step and tool are not aborted; exactly one batch arrives at the next natural preStep', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-real-step-'));
  const stack = await nativeHost(dir, { prepared: true });
  const w = await real();
  const held = gate(), entered = gate(), toolHeld = gate(), toolEntered = gate();
  let handle, detach, cancelled = 0, calls = 0;
  try {
    w.core.configuration.superagentBorrow = 'v1';
    w.core.member('member:root', 'root'); w.core.member('member:be', 'worker');
    const evidence = { requests: [] }, scripted = scriptedAdapter(stack.LlmAdapter, evidence);
    stack.ctx.llm.registerAdapter(['offline'], scripted.adapter);
    stack.ctx.tools.register({ name: 's3_hold', description: 'offline latch', parameters: { type:'object', properties:{} },
      output: { schema:{type:'string'}, render:(_,v)=>[{type:'text',text:v}] },
      async execute(_args, execution) { calls++; toolEntered.resolve(); await toolHeld.promise; return 'tool done'; } });
    scripted.arm({ entry: n => n === 0 ? { chunks: [], hold: held, onHold: () => entered.resolve(),
      tail: [...chunks.toolCall(0, 's3-call', 's3_hold', '{}'), chunks.usage(3, 2), chunks.finish('tool-calls')] }
      : { chunks: textChunks('done') } });
    handle = await stack.create({ sessionId:'s3-native-member', agentOptions:{provider:'offline',model:'model'}, meta:{cwd:dir} });
    const agent = handle.agent;
    const arbiter = new MemberInputArbiter(w.core); arbiter.bind('member:be', agent);
    const visibility = createVisibility({host:w.host,core:w.core,sessions:stack.ctx.sessions,isMain:stack.isMain,
      routeInputSession: id => id === agent.session.id ? {routed:true,kind:'execution',teamId:w.host.teamId,
        memberId:'member:be',generation:1,epoch:w.host.epoch,sessionId:id,attemptId:'attempt:probe',fence:1,executionEpoch:'exec:probe'} : null});
    detach = registerHostVisibility(stack.ctx, visibility, {host:w.host,sessionIdOf:p=>p.agent?.session?.id,
      newMessageId:()=> 's3-native-' + Math.random(), pathOf:()=> 'fake'});
    agent.followup({id:'s3-start',role:'user',source:{kind:'user'},content:[{type:'text',text:'do tool'}]});
    await deadline(entered.promise).catch(error=>{ throw Error(error.message+' entering stream '+JSON.stringify(agent.session.snapshotEvents().slice(-8))); });
    const phase = agent.phase, signal = phase.abort.signal;
    signal.addEventListener('abort',()=>cancelled++);
    for (let n=0;n<40;n++) {
      const sent=w.core.send('member:root','member:be',n%4===0?'info':'action','input '+n,
        n%4===0?{}:{expectedOutcome:'ack',deadline:new Date(Date.now()+60000).toISOString()});
      arbiter.deliverMail('member:be',sent.result.entityId);
    }
    assert.equal(evidence.requests.length,1); assert.equal(agent.phase,phase); assert.equal(cancelled,0);
    held.resolve(); await deadline(toolEntered.promise).catch(error=>{ throw Error(error.message+' entering tool '+JSON.stringify(
      agent.session.snapshotEvents().slice(-8))); });
    assert.equal(cancelled,0); assert.equal(calls,1); assert.equal(evidence.requests.length,1);
    toolHeld.resolve(); await deadline(agent.whenIdle());
    assert.equal(evidence.requests.length,2,'one natural request after the tool, not an interrupt request');
    const batches=evidence.requests[1].messages.flatMap(m=>m.blocks).filter(b=>b.text?.startsWith('<team_batch'));
    assert.equal(batches.length,1); assert(Buffer.byteLength(batches[0].text)*2<=4096);
    assert(pendingInputs(w.core,'member:be').pendingCount>0,'unconfirmed and omitted inputs remain pending');
    assert.equal(cancelled,0); assert.equal(arbiter.snapshot().preempts,0); assert.equal(agent.preemptStats.extraRequests,0);
    assert.equal(stack.ctx.agentLoop.config.instantInterrupt,false);
    assert.equal(assertBoundaryInputRuntime(stack.ctx).contract,'boundary-wake/1');
    assert.throws(()=>assertBoundaryInputRuntime({get:()=>({config:{instantInterrupt:true}})}),e=>e.code==='PATCH_MISSING');
    assert.throws(()=>assertBoundaryInputRuntime({get:()=>({config:{}})}),e=>e.code==='PATCH_MISSING');
  } finally {
    held.resolve(); toolHeld.resolve(); detach?.();
    if(handle){await handle.agent.whenIdle();await handle.dispose();}
    await stack.ctx.fiber.dispose(); await w.close(); fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('B07 real owner: constrained control port opens the native owner once and commits only actual request payload evidence', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'s3-real-owner-'));
  const stack=await nativeHost(dir,{prepared:true}), w=await real();
  let handle, detach;
  try {
    w.core.configuration.superagentBorrow='v1'; w.core.configuration.collab='on'; w.core.configuration.intentSemantics='root-decision-v1';
      w.core.configuration.autonomy='on';
    w.core.member('member:root','root'); w.core.member('member:be','worker'); w.core.task('task:be','member:be');
    handle=await stack.create({sessionId:'s3-native-owner',agentOptions:{provider:'offline',model:'model'},meta:{cwd:dir}});
    const agent=handle.agent, sid=agent.session.id;
    let route={routed:true,kind:'owner',teamId:w.host.teamId,sessionId:sid,ownerSessionId:sid,
      memberId:'member:root',generation:1,epoch:w.host.epoch};
    const visibility=createVisibility({host:w.host,core:w.core,sessions:stack.ctx.sessions,isMain:stack.isMain,
      routeInputSession:id=>id===sid?route:null});
    detach=registerHostVisibility(stack.ctx,visibility,{host:w.host,sessionIdOf:p=>p.agent?.session?.id,
      newMessageId:()=> 's3-owner-' + Math.random(),pathOf:()=> 'fake'});
    let requestCount=0,controls=0;
    const module=await loadBuild('dsh-llm');
    const entries=installLlmExecutionEntries({ctx:stack.ctx,scopes:{resolve:()=>null,current:()=>null},
      memberOfSession:()=>false,sessionId:()=>sid,authorizeHost:work=>work(),moduleReady:Promise.resolve(module),
      autonomy:true,transportReady:()=>true,hostSessionAuthorized:id=>id===sid});
    const adapter=new class extends stack.LlmAdapter {
      providerInfo(id){return {id,name:'offline owner'};}
      async prepareCall(provider,id){return {model:{provider,id,name:id,contextWindow:1000000,inputModalities:['text']},stream:o=>this.stream(o)};}
      async *stream(options){
        requestCount++;
        const base={contract:'team-dispatch/2',attempt:'s3-owner-dispatch-'+requestCount,sessionId:sid,kind:'main',purpose:null,
          messages:summariseDispatchMessages(options.messages),at:Date.now()};
        await visibility.dispatch({...base,phase:'prepared'},'fake');
        assert(!w.store.read(sent.result.entityId).visibility['member:root'],'prepared is not visible');
        const sendStartedAt=Date.now();
        await visibility.dispatch({...base,phase:'send-started',transmission:1,sendStartedAt},'fake');
        assert(!w.store.read(sent.result.entityId).visibility['member:root'],'send-started is not visible');
        await visibility.dispatch({...base,phase:'committed',transmission:1,sendStartedAt},'fake');
        const revision=w.store.read(sent.result.entityId).revision;
        await visibility.dispatch({...base,phase:'send-started',transmission:2,sendStartedAt},'fake');
        await visibility.dispatch({...base,phase:'committed',transmission:2,sendStartedAt},'fake');
        assert.equal(w.store.read(sent.result.entityId).revision,revision,'second transmission does not re-accept or mark again');
        yield* textChunks('root received');
      }
    }();
    stack.ctx.llm.registerAdapter(['offline'],adapter);
    const sent=w.core.send('member:be','member:root','intent','need coordination',{taskRef:'task:be',contractRevision:1,
      reason:'conflict',evidenceRefs:['task:be'],expectedOutcome:'decide'});
    const effect=w.store.effects().find(e=>e.payload.messageId===sent.result.entityId&&e.payload.kind==='wake');
    assert.equal(effect.payload.targetKind,'owner');
    const arbiter=new MemberInputArbiter(w.core);
    const args={core:w.core,arbiter,route:()=>route,teamId:w.host.teamId,ownerSessionId:sid,epoch:w.host.epoch,agent,hostControl:entries.hostControl};
    const request={...effect.payload,operationId:effect.id};
    const absent=await createOwnerInputPort(args)(request);
    assert.equal(absent.deferred,true,'P3 never fabricates H when P4 is absent '+JSON.stringify({absent,route,root:w.store.read('member:root'),request,row:
      w.store.read(sent.result.entityId)}));
    // Capacity is a constrained integration seam here; persistent H/unknown recovery is a P4 acceptance, not claimed.
    const port=createOwnerInputPort({...args,control:{run:async(binding,work)=>{controls++;return work();}}});
    const answers=await Promise.all([port(request),port(request)]);
    assert(answers.some(a=>a.executed));
    await deadline(agent.whenIdle()); await visibility.settled();
    assert.equal(requestCount,1); assert.equal(agent.session.snapshotEvents().filter(e=>e.type==='turn/start').length,1);
    assert.equal(visibility.status().visible,1,'two transmissions produce exactly one visibility fact');
    assert.equal(visibility.ledger.receipts().filter(r=>r.attempt==='s3-owner-dispatch-1').length,2,'both real transmissions are retained as receipts');
    assert.equal(w.store.list('attempt:').length,0,'owner is never a member execution');
    const seen=w.store.read(sent.result.entityId).visibility['member:root'];
    assert(seen,JSON.stringify(visibility.audit()));
    assert.equal(seen.manifestHash,w.store.list('manifest:')[0].hash);
    assert.equal(w.store.read(sent.result.entityId).accepted,false,'visibility is not accept');
    route={...route,teamId:'wrong-team'};
    assert.equal((await port(request)).notExecuted,true);
    assert(controls>=1);
  } finally {
    detach?.(); if(handle){await handle.agent.whenIdle();await handle.dispose();}
    await stack.ctx.fiber.dispose();await w.close();fs.rmSync(dir,{recursive:true,force:true});
  }
});

for(const change of ['attemptId','fence','epoch','executionEpoch','ownerSessionId'])test('B02 real evidence route rebind refuses '+change,async()=>{
  const w=await real();let visibility;
  try{
    w.core.configuration.superagentBorrow='v1';w.core.member('member:root','root');w.core.member('member:be','worker');
    const id=w.core.send('member:root','member:be','info','bound E').result.entityId;
    const sid='session:bound',session={seq:4,events:[],snapshotEvents(){return this.events;}};
    const route={routed:true,kind:'execution',teamId:w.host.teamId,sessionId:sid,memberId:'member:be',
      generation:1,epoch:w.host.epoch,attemptId:'attempt:old',fence:1,executionEpoch:'exec:old'};
    visibility=createVisibility({host:w.host,core:w.core,sessions:new Map([[sid,session]]),isMain:()=>true,routeInputSession:()=>route});
    const message=await visibility.preStep(sid,'native:bound');session.events.push({type:'user/message',seq:2,data:message});
    const release=visibility.candidate({sessionId:sid,messages:[message]});
    const base={contract:'team-dispatch/2',attempt:'binding-'+change,sessionId:sid,kind:'main',purpose:null,
      at:Date.now(),messages:summariseDispatchMessages([message])};
    await visibility.dispatch({...base,phase:'prepared'});
    const sendStartedAt=Date.now();await visibility.dispatch({...base,phase:'send-started',transmission:1,sendStartedAt});
    route[change]=typeof route[change]==='number'?route[change]+1:'changed';
    await visibility.dispatch({...base,phase:'committed',transmission:1,sendStartedAt});
    assert.equal(w.store.read(id).visible,false);
    assert.equal(w.store.list('manifest:').length,0,'rebound E cannot acquire any manifest');
    if(change!=='epoch') assert(visibility.audit().some(a=>a.reason==='stale-route'||a.reason==='unbound-attempt'));
    release();
  }finally{visibility?.stop();await w.close();}
});

test('B06 review: wake-only build works without a step-abort executor; token names alone are not a latch proof',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'s3-build-contract-'));
  const base=path.join(dir,'node_modules/@deepseek-ai');
  const put=(name,file,text)=>{const p=path.join(base,name,file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,text);};
  try{
    put('dsh','package.json',JSON.stringify({version:'0.0.0-fixture'}));
    put('dsh-llm','lib/index.js','export const DISPATCH_CONTRACT="team-dispatch/2";');
    put('dsh-tool-executor-native','package.json',JSON.stringify({name:'@deepseek-ai/dsh-tool-executor-native'}));
    put('dsh-tool-executor-native','lib/index.js','class NativeToolExecutor {}');
    const source=fs.readFileSync(path.join(buildTarget().base,'dsh-agent-loop/lib/index.js'),'utf8');
    const wake=source.slice(source.indexOf('wakeDriver(wakeAfterAbort = false) {'),source.indexOf('async whenIdle()',source.indexOf(
      'wakeDriver(wakeAfterAbort = false) {')));
    put('dsh-agent-loop','lib/index.js',wake+'async whenIdle() {}');
    const target=buildTarget(dir,{boundaryWakeOnly:true});
    assert.equal(target.boundaryWake.stepAbort,false);assert.equal(target.preemptExecutor,null);
    assert.throws(()=>buildTarget(dir),error=>error.code==='PATCH_MISSING','legacy still requires its complete executor');
    put('dsh-agent-loop','lib/index.js','// wakeDriver phase idle');
    assert.throws(()=>buildTarget(dir,{boundaryWakeOnly:true}),error=>error.code==='PATCH_MISSING');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
