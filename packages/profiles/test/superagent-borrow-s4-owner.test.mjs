import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {host as nativeHost,loadBuild,createRoleToolBoundary} from '../../adapter-dsh/index.mjs';
import {ControlStore} from '../../store/index.mjs';
import {TeamCore,GoalGate,MemberInputArbiter,capacityStatus,effectTrafficClass} from '../../core/index.mjs';
import {createTeamHost,createEffectRunner,createVisibility,createHumanInputGateway} from '../../host/index.mjs';
import {createExecutionScopes} from '../execution-scope.mjs';
import {permitEffectPort} from '../effect-execution.mjs';
import {prepareHost,activateHost} from '../host-driver.mjs';
import {createOwnerInputPort,installOwnerGuard,installRuntime} from '../runtime.mjs';
import {createOwnerControl,installLlmExecutionEntries} from '../llm-execution.mjs';
import {registerHostVisibility} from '../team-plugin.mjs';
import {summariseDispatchMessages} from '../../contracts/index.mjs';
const gate=()=>Promise.withResolvers();
const bound=(sid,epoch)=>({routed:true,kind:'owner',teamId:'team:h',sessionId:sid,ownerSessionId:sid,memberId:'member:root',generation:1,epoch});
const text=t=>[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:t},{type:'block-end',index:0,block:{type:'text',text:t}},{type:
  'usage',usage:{inputTokens:3,outputTokens:2,totalTokens:5}},{type:'finish',reason:{kind:'stop'}}];
const deadline=p=>Promise.race([p,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('owner test timeout')),10000);t.unref();})]);

for(const mode of ['complete','unknown'])test('B07/H02/H06/H07 real owner '+mode+
  ': N full, native owner wakes once through durable H, real payload evidence and transport/turn terminal release',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'s4-real-owner-')),store=new ControlStore(dir),core=new TeamCore(store,{}, {enabled:true,attach:true,teamId:
   'team:h',maxRuns:1});
 const stack=await nativeHost(dir,{prepared:true});const host=createTeamHost({root:dir,teamId:'team:h',core,cycleIntervalMs:1000000,recoverer:async()=>({
   status:'ok',admission:true}),openStore:()=>({close(){}})});
 let handle,control,detach;const held=gate(),entered=gate();
 try{
  await host.start();Object.assign(core.configuration,{superagentBorrow:'v1',autonomy:'on',collab:'on',intentSemantics:'root-decision-v1'});
  core.member('member:root','root');core.member('member:a','worker');core.task('task:a','member:a');core.schedule('evt:a','task:a');
  handle=await stack.create({sessionId:'s4-owner',agentOptions:{provider:'offline',model:'model'},meta:{cwd:dir}});const agent=handle.agent,sid=
    agent.session.id;
  let route=bound(sid,host.epoch);const arbiter=new MemberInputArbiter(core),module=await loadBuild('dsh-llm');
  control=createOwnerControl({core,ctx:stack.ctx,teamId:'team:h',ownerSessionId:sid,epoch:host.epoch,
    verifyTerminated:async({slot,evidenceRef})=>slot.binding.ownerSessionId===sid&&evidenceRef==='owner:stopped'});
  const entries=installLlmExecutionEntries({ctx:stack.ctx,scopes:{resolve:()=>null,current:()=>null},memberOfSession:()=>false,sessionId:()=>sid,
    authorizeHost:w=>w(),moduleReady:Promise.resolve(module),autonomy:true,transportReady:()=>true,hostSessionAuthorized:id=>id===sid,ownerControl:control});
  const visibility=createVisibility({host,core,sessions:stack.ctx.sessions,isMain:stack.isMain,routeInputSession:id=>id===sid?route:null});
  detach=registerHostVisibility(stack.ctx,visibility,{host,sessionIdOf:p=>p.agent?.session?.id,newMessageId:()=> 'owner-native-'+Math.random(),pathOf:()=>
    'fake'});
  let requests=0;
  const adapter=new class extends stack.LlmAdapter {
    executionPermitContract='execution-permit/1';
    providerInfo(id){return {id,name:'offline owner'};}
    async prepareCall(provider,id){return {model:{provider,id,name:id,contextWindow:1e6,inputModalities:['text']},stream:o=>this.stream(o)};}
    async *stream(options){
      requests++;const at=Date.now(),event={contract:'team-dispatch/2',attempt:'owner-request-'+requests,sessionId:sid,kind:'main',purpose:null,
        messages:summariseDispatchMessages(options.messages),at};
      await visibility.dispatch({...event,phase:'prepared'},'fake');await visibility.dispatch({...event,phase:'send-started',transmission:1,sendStartedAt:
        at},'fake');
      await visibility.dispatch({...event,phase:'committed',transmission:1,sendStartedAt:at},'fake');entered.resolve();await held.promise;if(
        mode==='unknown')throw Error('unknown owner transport');yield*text('decided');
    }
  }();module.registerExecutionTarget(adapter);stack.ctx.llm.registerAdapter(['offline'],adapter);
  const sent=core.send('member:a','member:root','intent','coordination',{taskRef:'task:a',contractRevision:1,reason:'all N waits',evidenceRefs:['task:a'],
    expectedOutcome:'decide'});
  const effect=store.effects().find(e=>e.payload.messageId===sent.result.entityId),request={...effect.payload,operationId:effect.id};
  const port=createOwnerInputPort({core,arbiter,route:()=>route,teamId:'team:h',ownerSessionId:sid,epoch:host.epoch,agent,hostControl:entries.hostControl,
    control});
  const result=await port(request);assert.equal(result.executed,true,JSON.stringify(result));await deadline(entered.promise).catch(e=>{throw Error(e.message+
    ' '+JSON.stringify({events:agent.session.snapshotEvents().slice(-8),slots:store.list('control-slot:'),outcomes:store.list('execution-outcome:')}));});
  assert.equal(capacityStatus(core).human.current,1);assert.equal(capacityStatus(core).normal.current,1);assert.equal(store.list('attempt:').length,1);
  assert(store.read(sent.result.entityId).visibility['member:root']);assert.equal(requests,1);
  assert.equal((await port(request)).executed,true,'duplicate has a durable receipt, not a second turn');
  route={...route,teamId:'wrong'};assert.equal((await port(request)).notExecuted,true);route=bound(sid,host.epoch);
  const outcome=store.list('execution-outcome:')[0];assert.equal(outcome.state,'applying');assert(outcome.observedCalls>0);
  held.resolve();await deadline(agent.whenIdle());await visibility.settled();
  if(mode==='unknown'){
    assert.equal(capacityStatus(core).human.current,1);assert.equal(capacityStatus(core).admissionClosed,true);
    const slot=store.list('control-slot:')[0];assert.equal(store.list('execution-outcome:')[0].state,'unknown');
    await assert.rejects(control.reclaim(slot.entityId,'timeout'),e=>e.code==='STOP_NOT_CONFIRMED');
    await control.reclaim(slot.entityId,'owner:stopped');
  }
  assert.equal(capacityStatus(core).human.current,0,JSON.stringify({slots:store.list('control-slot:'),out:store.list('execution-outcome:')}));
  assert.equal(store.list('execution-outcome:')[0].state,'terminated');assert.equal(agent.session.snapshotEvents().filter(e=>e.type==='turn/start').length,1);
  assert.equal(store.list('attempt:').some(a=>a.owner==='member:root'),false);
 }finally{held.resolve();control?.stop();detach?.();if(handle){await handle.agent.whenIdle();await handle.dispose();}await stack.ctx.fiber.dispose();
   await host.stop();store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('H01 real member: N and C full, authenticated human message crosses I and latches without another attempt, turn or abort',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'s4-active-')),stack=await nativeHost(dir,{prepared:true}),store=new ControlStore(dir),held=gate(),entered=
   gate(),normal=gate();
 const core=new TeamCore(store,{}, {enabled:true,attach:true,teamId:'team:h',maxRuns:1}),host=createTeamHost({root:dir,teamId:'team:h',core,cycleIntervalMs:
   1000000,
  recoverer:async()=>({status:'ok',admission:true}),openStore:()=>({close(){}})});let handle,runner;
 try{
  await host.start();Object.assign(core.configuration,{superagentBorrow:'v1',autonomy:'on',collab:'on',intentSemantics:'root-decision-v1'});
  core.member('member:root','root');core.member('member:a','worker');core.task('task:a','member:a');const admitted=core.schedule('active','task:a').result;
  let requests=0;const adapter=new class extends stack.LlmAdapter {providerInfo(id){return{id,name:'active'};}
   async prepareCall(provider,id){return{model:{provider,id,name:id,contextWindow:1e6,inputModalities:['text']},stream:o=>this.stream(o)};}
   async *stream(){requests++;entered.resolve();await held.promise;yield*text('done');}
  }();stack.ctx.llm.registerAdapter(['offline'],adapter);
  handle=await stack.create({sessionId:'active-member',agentOptions:{provider:'offline',model:'model'},meta:{cwd:dir}});
  const agent=handle.agent,arbiter=new MemberInputArbiter(core);arbiter.bind('member:a',agent);
  agent.followup({id:'initial-work',role:'user',source:{kind:'user'},content:[{type:'text',text:'perform admitted work'}]});
  await deadline(entered.promise);const phase=agent.phase;
  const scopes=createExecutionScopes({read:k=>store.read(k)});scopes.open({teamId:'team:h',memberId:'member:a',generation:1,
    executionSessionId:agent.session.id,attemptId:admitted.attemptId,attemptFence:admitted.fence,executionEpoch:'active:epoch'}, {gates:true,attribution:
      true,transport:true,subprocess:true});
  const credential={},gateway=createHumanInputGateway({core,teamId:'team:h',ownerSessionId:'owner',authenticate:c=>c===credential?{teamId:'team:h',
    ownerSessionId:'owner',authenticatedEntry:'owner-user-input'}:null});
  let deliveries=0;const message=permitEffectPort({store,scopes,handles:new Map([['member:a',{agent}]]),kind:'message',invoke:p=>{
    deliveries++;const result=arbiter.deliverMail('member:a',p.messageId);assert.equal(result.queued,true);return {deferred:true,reason:'natural boundary'};}});
  runner=createEffectRunner({access:host.coreAccess,clock:host.clock,capacity:1,capacityLanes:{store,classify:e=>effectTrafficClass(store,e),
    persist:row=>core.controlFact('effect-io:'+row.effectId,row,tx=>tx.put('effect-io:'+row.effectId,row))},ports:{start:()=>normal.promise,message}});
  assert.equal(runner.pump().claimed,1);await new Promise(r=>setImmediate(r));
  gateway.send({operationId:'v1:operation:active-human',recipient:'member:a',purpose:'message',summary:'human while full'},credential);
  assert.equal(runner.pump().claimed,1);await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
  assert.equal(deliveries,1);assert.equal(store.list('attempt:').length,1);assert.equal(agent.phase,phase);assert.equal(requests,1);
  assert.equal(phase.abort.signal.aborted,false);assert.equal(agent.preemptStats.extraRequests,0);assert.equal(runner.status().lanes.normal.current,1);
  assert.equal(arbiter.snapshot().queued,1);assert.equal(capacityStatus(core).normal.current,1);
 }finally{held.resolve();normal.resolve({executed:true,receipt:{}});await runner?.whenIdle();runner?.stop();if(handle){await handle.agent.whenIdle();
   await handle.dispose();}await host.stop();await stack.ctx.fiber.dispose();store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('P4 composition: production host starts after runner/controller assembly, real human owner request acquires H with current epoch',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'s4-compose-')),stack=await nativeHost(dir,{prepared:true}),held=gate(),entered=gate();
 let driver,store,handle,prepared;const credential={};
 try{
  handle=await stack.create({sessionId:'composed-owner',agentOptions:{provider:'offline',model:'model'},meta:{cwd:dir}});
  const config={root:dir,home:dir,ownerSessionId:'composed-owner',lifecycleIntervalMs:1000000,gcIntervalMs:1000000,
   authenticateHumanInput:c=>c===credential?{teamId:prepared.teamId,ownerSessionId:'composed-owner',authenticatedEntry:'owner-user-input'}:null};
  prepared=await prepareHost(stack.ctx,config);store=new ControlStore(dir);const core=new TeamCore(store,{}, {enabled:true,attach:true,teamId:prepared.teamId,
   superagentBorrow:'v1',intentSemantics:'root-decision-v1',collab:'on',autonomy:'on',maxRuns:1});
  const module=await loadBuild('dsh-llm');let requests=0;
  const adapter=new class extends stack.LlmAdapter {executionPermitContract='execution-permit/1';providerInfo(id){return {id,name:'composed owner'};}
   async prepareCall(provider,id){return {model:{provider,id,name:id,contextWindow:1e6,inputModalities:['text']},stream:o=>this.stream(o)};}
   async *stream(){requests++;entered.resolve();await held.promise;yield*text('done');}
  }();module.registerExecutionTarget(adapter);stack.ctx.llm.registerAdapter(['offline'],adapter);
  const runtime={core};Object.assign(runtime,installRuntime(stack.ctx,core,{ownerSessionId:'composed-owner',route:id=>runtime.router?.route(id),authorize:(
    kind,w)=>runtime.host.executeAuthorized(kind,w)}));
  await runtime.stop.ready;
  Object.defineProperty(stack.ctx,'goals',{value:{registerCompletionGuard:()=>()=>{}},configurable:true});
  driver=await activateHost({ctx:stack.ctx,core,runtime,gate:new GoalGate(core),configuration:config,registerVisibility:registerHostVisibility,prepared});
    Object.assign(runtime,driver);
  assert.equal(driver.host.state,'running');assert.equal(driver.runner.status().lanes.human.limit,1);
  assert.throws(()=>driver.humanInput.send({operationId:'v1:operation:operator-json',recipient:'member:root',purpose:'status',summary:'machine'},
    driver.bindPrincipal({teamId:prepared.teamId,memberId:'operator'})),e=>e.code==='DENIED');
  driver.humanInput.send({operationId:'v1:operation:composed-human',recipient:'member:root',purpose:'status',summary:'human control'},credential);
  driver.runner.pump();await deadline(entered.promise);assert.equal(driver.status().capacity.human.current,1);
  assert.equal(store.list('control-slot:')[0].hostEpoch,driver.host.epoch);assert.equal(requests,1);
  held.resolve();await deadline(handle.agent.whenIdle());await driver.runner.whenIdle();assert.equal(driver.status().capacity.human.current,0);
 }finally{
  held.resolve();if(handle)await handle.agent.whenIdle();if(driver)await driver.stop();else{try{store?.close();}catch{}try{await prepared?.manager.close();
    }catch{}try{prepared?.ownership.release();}catch{}}
  if(handle)await handle.dispose();await stack.ctx.fiber.dispose();fs.rmSync(dir,{recursive:true,force:true});
 }
});

test('H06 owner unknown: unreturned transport and logical stop hold H across restart; only independent identity-bound proof reclaims',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'s4-owner-unknown-')),store=new ControlStore(dir),core=new TeamCore(store,{}, {enabled:true,attach:true,teamId:
   'team:h',superagentBorrow:'v1',maxRuns:1});
 core.member('member:root','root');let listener;const ctx={on(_name,fn){listener=fn;return ()=>{};}};
 const credential={},gateway=createHumanInputGateway({core,teamId:'team:h',ownerSessionId:'owner',authenticate:c=>c===credential?{teamId:'team:h',
   ownerSessionId:'owner',authenticatedEntry:'owner-user-input'}:null});
 const human=gateway.send({operationId:'v1:operation:owner-unknown',recipient:'member:root',purpose:'status',summary:'status via model'},credential);
 let control=createOwnerControl({core,ctx,teamId:'team:h',ownerSessionId:'owner',epoch:'epoch:1'});
 try{
  let call,token;await control.run(bound('owner','epoch:1'),()=>{listener({id:'owner'},{type:'turn/start',data:{turn:'turn:one'}});
    call=control.resolve('owner').call('stream');token={};call.reserve(token);return {executed:true};},{originRef:human.result.humanOriginRef});
  assert.equal(control.resolve('owner')===null,true,'session ID alone cannot borrow an active H call');
  listener({id:'owner'},{type:'turn/end',data:{turn:'turn:one'}});call.close('unknown',1);
  const slot=store.list('control-slot:')[0];assert.equal(store.read(slot.entityId).state,'unknown');assert.equal(capacityStatus(core).human.current,1);
  control.stop();call.finish(token);assert.equal(store.read(slot.entityId).state,'unknown');
  control=createOwnerControl({core,ctx,teamId:'team:h',ownerSessionId:'owner',epoch:'epoch:2',verifyTerminated:async({slot,evidenceRef})=>
    slot.callIdentity===slot.holderRef&&evidenceRef==='transport:stopped'});
  assert.equal(capacityStatus(core).admissionClosed,true);await assert.rejects(control.reclaim(slot.entityId,'elapsed'),e=>e.code==='STOP_NOT_CONFIRMED');
  assert.equal(store.read('execution-outcome:'+slot.callIdentity).state,'unknown');await control.reclaim(slot.entityId,'transport:stopped');
  assert.equal(capacityStatus(core).human.current,0);assert.equal(store.read('execution-outcome:'+slot.callIdentity).evidenceRef,'transport:stopped');
 }finally{control.stop();store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('H05: a genuinely human I message cannot bypass a sealed or unknown execution scope',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'s4-sealed-')),store=new ControlStore(dir),core=new TeamCore(store,{}, {enabled:true,teamId:'team:h',
   superagentBorrow:'v1'});
 try{
  core.member('member:root','root');core.member('member:a','worker');core.task('task:a','member:a');const a=core.schedule('admit','task:a').result;
  const scopes=createExecutionScopes({read:k=>store.read(k)}),scope=scopes.open({teamId:'team:h',memberId:'member:a',generation:1,
    executionSessionId:'member:session',attemptId:a.attemptId,attemptFence:a.fence,executionEpoch:'epoch:sealed'}, {gates:true,attribution:true,transport:
      true,subprocess:true});
  const credential={},gateway=createHumanInputGateway({core,teamId:'team:h',ownerSessionId:'owner',authenticate:c=>c===credential?{teamId:'team:h',
    ownerSessionId:'owner',authenticatedEntry:'owner-user-input'}:null});
  const h=gateway.send({operationId:'v1:operation:sealed-message',recipient:'member:a',purpose:'message',summary:'safe control'},credential),effect=
    store.effects().find(e=>e.id===h.result.entityId);
  const token=scope.acquire('network');scope.finish(token,'unknown');scope.seal();let io=0;
  const port=permitEffectPort({store,scopes,handles:new Map([['member:a',{agent:{session:{id:'member:session'}}}]]),kind:'message',invoke:()=>{io++;return {
    executed:true};}});
  const result=await port({...effect.payload,operationId:effect.id});assert.equal(result.notExecuted,true);assert.match(result.reason,/SEALED/);assert.equal(
    io,0);
  assert.equal(store.read(h.result.entityId).visible,false);assert.equal(store.list('attempt:').length,1);
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('H05 final tool boundary: H mailbox denies bash/write/produce/provision, permits trusted read and communication; normal worker unchanged',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'s4-tool-')),store=new ControlStore(dir),core=new TeamCore(store,{}, {enabled:true,teamId:'team:h',
   superagentBorrow:'v1'});
 core.member('member:root','root');core.member('member:a','worker');
 core.mutate('attempt:mail','adapter',{},tx=>tx.put('attempt:mail',{owner:'member:a',taskId:'task:mail',lease:'active',status:'running',runClass:
   'human-mailbox',fence:1,generation:1,scopeSet:[]}));
 const defs=new Map();let sid='member-session';const tools={register(d){defs.set(d.name,d);tools.roleToolBoundary.track(d);return ()=>{};},executable:n=>
   defs.get(n)};
 tools.roleToolBoundary=createRoleToolBoundary(tools);const ctx={tools,agents:{currentInitiator:()=>({session:{id:sid}})},on:()=>()=>{}};
 const guard=installOwnerGuard({ctx,core,authorize:(_k,w)=>w(),borrow:{teamId:'team:h'},route:id=>id==='member-session'?{routed:true,kind:'execution',teamId:
   'team:h',attemptId:'attempt:mail'}:null});
 let io=0;try{
  for(const [name,capabilities,operation] of [['bash',['opaque'],null],['write',['write-local'],null],['team_task',['execute'],'produce'],['team_member',[
    'coordinate'],'provision'],['read',['read-local'],null],['team_message',['coordinate'],'send']]){
   const def={name,execute(){io++;return 'ok';}};tools.register(def);guard.register({identity:name,capabilities,implementation:def,source:'fixture'});
   const invoke=()=>def.execute(operation?{op:operation}:{},{agent:{session:{id:sid}}});
   if(['read','team_message'].includes(name))assert.equal(invoke(),'ok');else assert.throws(invoke,e=>e.code==='ROLE_GUARD_DENIED');
  }
  assert.equal(io,2);core.mutate('attempt:mail','adapter',{},tx=>tx.put('attempt:mail',{...tx.read('attempt:mail'),runClass:'work'}));
  assert.equal(defs.get('bash').execute({},{agent:{session:{id:sid}}}),'ok');assert.equal(io,3);
 }finally{guard.revoke();store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
