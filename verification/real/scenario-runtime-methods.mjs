import {repository,executeProductWork} from './product-workload.mjs';
import {noteRouteReady,noteFirstRequest} from './timing.mjs';
import {assertLosslessJson,nativeToolErrors,nativeErrorCode,isOutputError} from './tool-output.mjs';
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {pathToFileURL,fileURLToPath} from 'node:url';import {
  randomInt,randomUUID,verify} from 'node:crypto';import {bootProfile,registerBusinessTool} from '../../packages/profiles/index.mjs';import {buildTarget
  } from '../../packages/adapter-dsh/build-target.mjs';const buildBase=buildTarget().base;import {snapshot,
    bindManifest} from '../../packages/core/snapshot.mjs';
import {requestBoundary} from '../../packages/core/provenance.mjs';import {handleTool} from '../../packages/core/tools.mjs';import {deadlineDescription
  } from '../../packages/contracts/index.mjs';
import {teamSchemas,validateTool} from '../../packages/contracts/team-tools.mjs';import {failWith,DISPATCH_CONTRACT,publishDispatchEvent,
  summariseDispatchMessages} from '../../packages/contracts/index.mjs';import {toolDescription,rolePrompt} from '../../packages/core/authorization.mjs';import {
  wire,chunks,digest,truncation,interruptedRaw} from './protocol.mjs';import {topology,turnLimitFor,policy} from './config.mjs';import {noteToolCall,loopCode
  } from './loop-guard.mjs';import {installCollabTools,collabCatalog,prepareWorkspaces,workspaceOf} from './collab-session.mjs';
import {createDispatchContexts,publishDispatchPhase} from '../../packages/contracts/index.mjs';
import {workSchema as toolSchema,workArgs,requireWorkArgs,deliveryRefs,reviewGuard,issueView,integrateGuard,brief as workloadBrief
  } from '../../packages/core/workload.mjs';
import { until } from './scenario-runtime.mjs';

/** Native-execution and setup plumbing, split out of Engine; the stage transitions and loop stay in scenario.mjs. */
export const runtimeMethods = {
async open(){if(['model-contracts','soak'].includes(this.stage))this.repository=await repository(this.root+'/repository');const workspaceModule=this.root
   +'/member-workspace.mjs';if(this.options.perWorkspace)fs.writeFileSync(workspaceModule,'export function memberWorkspace({memberId}) { return '+JSON
     .stringify(this.root+ '/ws/')+' + memberId.replace("member:",""); }');const spec={team:true,guard:true,goalCheck:true,...(this.options.perWorkspace?{
         memberWorkspace:{module:pathToFileURL(workspaceModule).href,export:'memberWorkspace',workspaceRoot:this.root}}:{}),...(this.repository?{repository:this
         .repository,gitRoots:[this.root]}:{}),...(this.collab==='on'?{collab:'on',...(this.mode==='live'?{}:{intentWindowMs:1000})}:{})};this.spec=spec;
           this.host=
         this
   .options.bootHost?await this.options.bootHost(this.root+'/host',spec,{workspaceRoot:this.root,defaultDirectory:this.root}):await bootProfile(this.root+
     '/host',
     spec);this.ctx=this.host.ctx;this.runtime=this.ctx.teamRuntime;this.core=this.runtime.core;
 // The verifier is a reader of the raw journal: it recomputes attempt timing from the ready/admitted events after the
 // run. Registering before the first cycle pins the retention floor at the journal head, so compaction honours it and
 // the events it will read are kept. This is ordinary reader registration, not a retention exemption.
 this.core.store.registerReader('real-verifier');
 if(fs.existsSync(this.rawFile))this.raw=JSON.parse(fs.readFileSync(this.rawFile));const llmModule=await import(pathToFileURL(buildBase
     +'dsh-llm/lib/index.js'));const {LlmAdapter}=llmModule;this.dispatchAttemptOf=llmModule.dispatchAttemptOf;const engine=this;
 // F2b: the fixture tool is appended per agent after the product bound it (a context-wide registration would
  // collide with the per-agent one), so nothing is registered on the context here.
 this.registerOffline(LlmAdapter);
 // The collaboration arm gives every member its own workspace, so relative paths in a native write or a shell command mean that member's directory. The release
 // stages keep one shared root, which is what they have always used.
 // The workspace layout belongs to the workload, not to the arm: the collaboration stage runs the same task on both
 // arms, so both need the same per-member directories. Only the mechanisms differ between the arms.
 const perWorkspace=this.options.perWorkspace===true;
 if(perWorkspace)prepareWorkspaces(this,this.topology.map(([actor])=>actor));
 for(const [actor,role,group]of this.topology){const state={actor,role,group,boundary:0,manifest:null,pending:null,lastRaw:null,binding:null,turnRequests:0};
   this.states.set(actor,state);this.announceRole(state)
   }
 this.perWorkspace=perWorkspace;
 await this.enroll();for(const state of this.states.values())this.install(state);
   // F2b: the snapshot is injected by the product's visibility port; a second harness injection would duplicate it and
  // write manifest rows outside the one writer port (design §F 接线约束 3).
 // Failures are attributed per initiating agent: turns of different members may be in flight at the same time.
 this.ctx.on('agent/error',({error})=>{const state=this.stateOf(this.ctx.agents.currentInitiator?.());const owner=state?.actor??'*';if(this.failures.has(owner)
       &&typeof this.failures.get(owner)==='object')return;this.failures.set(owner,error?.message??'AGENT_FAILED')});
 // The dead-loop detector sits on the pre-execute waterfall rather than on the result path, because a loop of refused
 // calls produces no results at all: a member that asks the same refused question six times must still be stopped.
 this.ctx.on('tools/pre-execute',async(execution,next)=>{const decision=await next();const state=this.stateOf(execution.agent??this.currentAgent());
     if(!state)return decision;
  const looped=this.noteRepeat(state,execution.name,execution.arguments??{});return looped?{kind:'deny',reason:looped}:decision});
 // Every turn end persists the opaque response of its own last step, whoever opened the turn. A host-opened turn (a
 // mailbox wake, or a dispatched work attempt no fixture call awaits) never reaches turn()'s tail and has no next
 // request to open with remember(), so its final assistant message would otherwise be replayed as fabricated reasoning
 // text (OPAQUE_REASONING_MAPPING_MISSING) the moment anything serializes that session again.
 this.ctx.on('session/event',(session,event)=>{if(session?.id&&event?.type==='turn/end'){const state=this.stateOfSession(session.id);if(state)this
       .remember(state,session.deriveMessages())}});
 // F2b: the pre-step snapshot is the product's injection (team-plugin registers the only one). The fixture reads it back
 // through the same product function, because the collaboration block it carries is the experiment's evidence - which
 // teammate decisions reached a request, and the gate state the member saw. Parsing the rendered text instead would
 // measure our own formatting.
 this.ctx.on('agent/pre-step',async(payload,next)=>{const decision=await next();if(this.collab!=='on')return decision;
  const state=this.stateOf(payload?.agent);if(!state)return decision;
  try{const candidate=snapshot(this.core,'member:'+state.actor),collab=candidate?.payload?.collab;if(!collab)return decision;
   (this.facts.collabSnapshots??=[]).push({actor:state.actor,at:Date.now(),decisions:collab.decisions.length,
     decisionOmitted:collab.decisionOmitted,decisionActors:collab.decisions.map(d=>d.actor),gateOpen:collab.gate.open,
     assumptionsOpen:collab.assumptions.open});}catch{/* evidence only: a read failure must never break the request */}
  return decision;});
   // F2b: the attempt leases belong to the host that granted them; the harness creates none and therefore renews none.return this;
 },
captureNativeToolActions(actor){const session=this.agent(actor).session,journal=session.snapshotEvents();
    for(const result of journal.filter(e=>e.type==='tool/result'&&!e.data.message?.isError)){
      const message=result.data.message,key=session.id+':'+result.seq;if(this.seenNativeToolActions.has(key))continue;
      const call=journal.find(e=>e.type==='tool/call'&&e.data.callId===message?.toolCallId);
      if(!call||call.data.name==='real_work')continue; // real_work already records its own execution exactly once
      let args,output;try{args=JSON.parse(call.data.arguments);output=JSON.parse((message.content??[]).map(b=>b.text??'').join(''));}catch{continue}
      this.seenNativeToolActions.add(key);
      const request=(this.facts.requests??[]).filter(r=>r.actor===actor&&r.nativeSessionId===session.id&&r.nativeSeq<=call.seq)
        .sort((a,b)=>b.nativeSeq-a.nativeSeq||(b.id??0)-(a.id??0))[0];
      this.facts.toolActions.push({actor,name:call.data.name,args,requestId:request?.requestId??this.states.get(actor)?.requestId??null,
        at:call.time??Date.now(),elapsedMs:Number.isFinite(result.time)&&Number.isFinite(call.time)?result.time-call.time:null,
        resultRef:output?.result?.entityId??output?.entityId,source:'native-model-tool',nativeSessionId:session.id,nativeSeq:result.seq});
      if(call.data.name==='team_message'&&args.op==='send'&&this.cycle)this.cycle.sent.add(actor);
      // The two progress signals the release stages emit from their own workload driver (product-workload: produce and
      // verify). The collaboration stage drives the same product tools through the model, so its stop clock reads them
      // here, once per successful call, instead of losing them with the driver that used to emit them.
      if(this.collab==='on'){if(call.data.name==='team_task'&&args?.op==='produce')this.progress('produce:'+actor);
        if(call.data.name==='team_verify')this.progress('verify:'+actor)}
    }},
stateOfSession(sessionId){if(!sessionId)return null;return [...this.states.values()].find(s=>{try{return this.agent(s.actor)?.session?.id===sessionId}catch{
          return false}})??null
    },
enterNativeTurn(state,agent){const start=agent.session.snapshotEvents().findLast(e=>e.type==='turn/start');
    if(!start)throw Error('NATIVE_TURN_START_MISSING');const key=agent.session.id+':'+start.seq;
    if(state.nativeTurnKey!==key){state.nativeTurnKey=key;state.turnRequests=0;state.lastCall=null;state.repeat=0;state.refused=false;state.lastTruncated=false;
      }
    },
realWorkTool(resolve=null){const engine=this;
    const who=()=>{if(typeof resolve==='function'){const state=resolve();if(state)return state}const agent=engine.ctx.agents.currentInitiator?.();
      const route=agent?engine.runtime.router.route(agent.session.id):null;
      return route?.routed?engine.states.get(route.memberId.replace('member:',''))??null:null};
    return{name:'real_work',description:'isolated role-bound workload',parameters:toolSchema,
      output:{schema:{type:'object'},render:(unused,value)=>[{type:'text',text:JSON.stringify(value)}]},
      execute:args=>{const state=who();if(!state)throw Error('NOT_ROUTED');return engine.executeWork(state,args)}};},
async executeWork(state,args){if(state.actor!=='root'){const route=this.runtime.router.route(this.agent(state.actor).session.id);if(route?.attemptId)state
      .binding={attemptId:route.attemptId,fence:route.fence,generation:route.generation};}const before=this.core.store.latestEventSeq(),toolStarted=Date.now();
    let result;
    try{result=await this.work(state.actor,args);assertLosslessJson(result);
      this.facts.toolActions.push({actor:state.actor,name:'real_work',args,requestId:state.requestId,at:Date.now(),elapsedMs:Date.now()-toolStarted,
          resultRef:result?.result?.entityId??result?.entityId,source:'native-model-tool'});
      this.observe(before);
      /* Offline-only injection deliberately reaches the unchanged upstream output validator. */
      if(this.mode==='fake'&&this.fault==='invalid-tool-output'&&args.op==='brief')return{...result,injectedUndefined:undefined};
      return result}catch(e){if(e.code==='INVALID_TOOL_OUTPUT')(this.facts.toolOutputErrors??=[]).push({source:'fixture-output-validation',actor:state.actor,
            name:'real_work',requestId:state.requestId,code:e.code,message:e.message,path:e.path});throw e}
        },
registerOffline(LlmAdapter){const engine=this;this.LlmAdapter=LlmAdapter;
    this.ctx.llm.registerAdapter(['offline'],new class extends LlmAdapter{dispatchContract=DISPATCH_CONTRACT;
      providerInfo(id){return{id,name:'budgeted Responses'}}
      async prepareCall(provider,id){return{model:{provider,id,name:'deepseek-v4.1-flash',context:{contextWindow:1000000}},
        stream(options){return engine.stream(options)}}}}());},
async shutdown(){if(this.stopped||!this.runtime||!this.ctx)return;this.stopped=true;
    try{await this.runtime.stop();}catch(error){this.stopError=error?.message??String(error);}
    try{await this.ctx.fiber.dispose();}catch{}},
install(state){if(this.options.perWorkspace===true)return this.installCollab(state);const agent=this.agent(state.actor);this.byAgent.set(agent,state);
    // One fixture tool per agent: a later cycle rebinds the same agent and must not register it twice.
    if(state.installed===agent)return;state.installed=agent;registerBusinessTool(this.runtime,agent,this.realWorkTool(()=>state));},
async enroll(){const submit=this.submit=this.submitter();
    for(const [actor,role]of this.topology){if(actor==='root'){await this.enrollOwner();continue}
      submit('team.member.request','member-intent:'+actor,{role});
      await until(()=>this.core.store.read('member-intent:'+actor)?.status==='confirmed','member-intent:'+actor+' confirmed');
      await until(()=>this.runtime.handles.has('member:'+actor),'native execution for member:'+actor);}},
submitter(){return(name,entityId,extra={})=>this.runtime.host.command({teamId:this.runtime.host.teamId,actor:'root',
    requestId:entityId,operationId:'v1:operation:'+entityId.replaceAll(':','-').padEnd(20,'x'),payload:{command:name,entityId,...extra}})},
async enrollOwner(){const handle=await this.ctx.agents.create({sessionId:'real-owner',
    agentOptions:{provider:'offline',model:'model'},meta:{cwd:this.root}});
    this.owner=handle;const state=this.states.get('root');this.byAgent.set(handle.agent,state);
    registerBusinessTool(this.runtime,handle.agent,this.realWorkTool(()=>state));state.installed=handle.agent;
    this.runtime.router.bindExecution({executionSessionId:handle.agent.session.id,teamId:this.runtime.host.teamId,
      memberId:'member:root',generation:1});},
deliverPrompt(actor,text){return this.runtime.host.executeAuthorized('business',()=>this.core.send('member:root','member:'+actor,'action',
    // The instruction IS the responsibility: an 180-character excerpt of it is not the task. That slice kept only the
    // role contract and cut every prompt before the step it asked for, so a member that read its mailbox still had
    // nothing to do. The text is bounded by what the experiment wrote.
    String(text),{expectedOutcome:'pursue this instruction and answer it',deadline:new Date(Date.now()+300000).toISOString()}).result.entityId)},
async waitTurn(actor,before){const agent=this.agent(actor);
    await until(()=>this.turnsEnded(agent)>before,'opened turn for '+actor);
    // A host-opened turn bypasses turn()'s tail. Its final assistant has no next step to trigger remember(),
     // so persist that response here before replay/fold/cold or the next turn can serialize opaque reasoning.
     await agent.whenIdle();this.remember(this.states.get(actor),agent.session.deriveMessages());await this.ctx.sessions.flush(agent.session);
     this.captureProtocolErrors(actor);this.captureOutputErrors(actor);this.backfillSnapshots();
    return this.turnsEnded(agent);},
untilAccepted(actor){return until(()=>this.core.store.list('message:').some(m=>m.recipient==='member:'+actor&&m.sender==='member:root'&&m.kind==='action'&&m
        .visible&&m.accepted),'accepted request-visible responsibility for '+actor)
    },
turnsEnded(agent){return agent.session.snapshotEvents().filter(e=>e.type==='turn/end').length},
captureProtocolErrors(actor){const state=this.states.get(actor);if(!state)return;const session=this.agent(actor).session;
    const journal=session.snapshotEvents();
    for(const e of nativeToolErrors(session)){
      const key=e.nativeSessionId+':'+e.nativeSeq;if(this.seenToolErrors.has(key))continue;this.seenToolErrors.add(key);
      const code=nativeErrorCode(e);if(code===loopCode)continue;
       if(['ABORTED_BEFORE_DISPATCH','ABORTED'].includes(code)){(this.facts.toolInterruptions??=[]).push({...e,actor,code});continue;}
      const call=journal.find(c=>c.type==='tool/call'&&c.data.callId===e.callId);let args=null;
      try{args=call?JSON.parse(call.data.arguments):null}catch{args=null}
            this.facts.protocolErrors.push({actor,name:e.name,args,requestId:state.requestId??null,error:code,at:Date.now(),elapsedMs:null});}},
backfillSnapshots(){for(const row of this.facts.requests??[]){if(row.manifestHash||!row.snapshotMessageId)continue;
    const manifest=this.core.store.list('manifest:').find(m=>m.messageId===row.snapshotMessageId&&
      m.memberId==='member:'+row.actor&&m.withdrawn!==true);
    if(!manifest)continue;row.manifestHash=manifest.hash;row.snapshotRevision=manifest.revision;
    row.snapshotPayloadHash=manifest.payloadHash;}},
async bind(actor,cycle){const s=this.states.get(actor);
    if(actor==='root'){s.binding=null;s.task=null;return null;}
    // A member may hold one live attempt at a time, and the product has no command that closes an attempt without a
    // delivery. So an attempt that is still live is this member's attempt and is reused; a new one is requested only
    // when the previous one ended. (The old harness cancelled it in bind(); with the attempt owned by the product, that
    // would be a write the experiment has no authority to make.)
    if(s.binding){const live=this.core.store.read(s.binding.attemptId);
      if(live?.lease==='active'&&live.status==='running'){noteRouteReady(this,actor,cycle,live.entityId,Date.now());return s.task;}}
    const task='task:real:'+cycle+':'+actor;const previous=s.binding?.attemptId??null;
    const artifactRef=this.cycle?.assignments?.[actor]?'artifact:'+this.cycle.id+':'+actor:null;
     const directory=this.repository?this.runtime.delivery.port.worktreePath(task):null;
     s.task=task;if(!this.core.store.read(task))this.submit('team.task.request',task,{owner:'member:'+actor,...(artifactRef?{artifactRef,scopeSet:[path
               .join(directory,actor+'.json')]}:{})});
    // The route keeps naming the previous attempt until this one's start receipt arrives, so the fact to wait for is a
    // binding that is not the old one - not merely "a binding".
    const route=await until(()=>{const bound=this.runtime.router.route(this.agent(actor).session.id);
      if(bound?.routed&&bound.attemptId&&this.core.store.read(bound.attemptId)?.taskId===task)return bound;const own=s.binding&&this.core.store.read(s.binding
        .attemptId);return own?.taskId===task?{routed:true,...s.binding}:null},'attempt binding for '+actor);
    s.binding={attemptId:route.attemptId,fence:route.fence,generation:route.generation};s.task=task;
    noteRouteReady(this,actor,cycle,route.attemptId,Date.now());this.install(s);return task;},
async cold(actor){const agent=this.agent(actor),sessionId=agent.session.id;
    const before=agent.session.deriveMessages();await this.ctx.sessions.flush(agent.session);
    fs.writeFileSync(this.rawFile,JSON.stringify(this.raw));this.backfillSnapshots();
    const stop=await this.runtime.stop();
    const released=stop?.ownership==='released'&&stop?.store!=='isolated'&&stop?.isolated!==true;
    if(!released)throw Error('COLD_LOCK_NOT_RELEASED:'+JSON.stringify({ownership:stop?.ownership??null,store:stop?.store??null,isolated:stop?.isolated??null}));
    await this.ctx.fiber.dispose();this.stopped=true;
    const reopened=await bootProfile(this.root+'/host',this.spec);
    this.host=reopened;this.ctx=reopened.ctx;this.runtime=this.ctx.teamRuntime;this.core=this.runtime.core;this.stopped=false;
    const {LlmAdapter}=await import(pathToFileURL(buildBase+'dsh-llm/lib/index.js'));
    this.registerOffline(LlmAdapter);
    const handle=await this.ctx.agents.resume({resumeSessionId:sessionId,agentOptions:{provider:'offline',model:'model'}});
    this.resumed.set(actor,handle.agent);
    const after=handle.agent.session.deriveMessages();this.raw=JSON.parse(fs.readFileSync(this.rawFile));
    const child=spawnSync(process.execPath,[fileURLToPath(new URL('cold-reader.mjs',import.meta.url)),this.root,actor,sessionId],{encoding:'utf8',timeout:30000,
        env:Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|DSH_UPSTREAM_BUILD)$/i.test(k)))});
    if(child.status!==0)throw Error('COLD_HOST_FAILED:'+child.stderr);
    const host=JSON.parse(fs.readFileSync(this.root+'/cold-reader-report.json'));
    const evidence={actor,sessionId,released,stop:{ownership:stop.ownership??null,store:stop.store??null,isolated:stop.isolated??null,state:stop.state??null},
      beforeHash:digest(before),afterHash:digest(after),equal:digest(before)===digest(after),
      hostProcessEqual:host.messagesHash===digest(before)&&host.wireHash===digest(wire(before,this.raw)),host,opaqueItemsRestored:Object.keys(this.raw).length};
    this.facts.cold.push(evidence);return evidence;},
async close(){clearInterval(this.heartbeat);if(!this.core||this.stopped)return;for(const actor of this.states.keys())if(this.runtime.handles.has('member:'
       +actor))this.captureOutputErrors(actor);this.observe();for(const issue of this.core.store.list('thread:').filter(t=>t.status==='collecting'))this.core
   .mutate(issue.entityId,'operator',{},(tx,r)=>tx.put(issue.entityId,{...r,status:'escalated',responsible:'operator',reason:'run closed with pending decision'
         }));
   this.facts.issues=this.core.store.list('thread:');fs.writeFileSync(this.root+'/tool-actions.json',JSON.stringify(this.facts.toolActions,null,2));
   for(const m of this.core.store.list('message:').filter(m=>m.kind!=='info'&&m.kind!=='intent'&&!['resolved','cancelled','escalated','expired','dead-letter']
       .includes(m.status)&&!m.accepted))this.core.mutate(m.entityId,'operator',{},(tx,r)=>tx.put(m.entityId,{...r,status:'escalated',responsible:'operator',
         reason:'run closed with unresolved responsibility'}));this.observe();for(const s of this.states.values()){const a=s.binding&&this.core.store.read(
         s.binding
       .attemptId);if(a?.lease==='active')this.core.finish(a.entityId,a.fence,'cancelled');}fs.writeFileSync(this.rawFile,JSON.stringify(this.raw));
       this.facts.preempt
   =this.preemptFacts();await this.shutdown();
   },
 async probe(actor,messages,mode,purpose='replay'){const snapshots=messages.filter(m=>m.source?.kind==='trusted-team-plugin'),latest=snapshots.at(-1);
   return this.transport.call(actor,wire(messages,this.raw),[],{purpose,mode,historyToolErrors:nativeToolErrors(this.agent(actor).session,messages),
       foldSourceEventSeqs:mode==='on'?this.facts.folds.at(-1)?.records.flatMap(r=>r.sourceEventSeqs):[],nativeSessionId:this.agent(actor).session.id,nativeSeq:
       this
       .agent(actor).session.seq,snapshotTokens:latest?this.ctx.tokenMeter.estimateMessage(latest):0,snapshotTokenMethod:'native-estimateMessage',
       snapshotUpperBound:latest?Buffer.byteLength(latest.content[0].text)*2:0,oldSnapshotTokens:snapshots.slice(0,-1).reduce((n,m)=>n+this.ctx.tokenMeter
         .estimateMessage(m),0)})
   },
 security(){const s=this.states.get('a1');const checks=[['role escalation',()=>this.work('a1',{op:'integrate'})],['forged actor',()=>handleTool(this.core,{
           actor:'member:a1',...s.binding},'team_message',{operationId:'v1:operation:'+randomUUID(),expectedRevision:0,op:'send',to:'member:root',kind:'info',
             summary:'x',
           actor:'member:root'})],['message ID misuse',()=>this.work('a1',{op:'accept',messageId:'operation:fake'})]];for(const [name,fn]of checks){try{fn();
           this.facts
       .security.push({name,rejected:false})}catch(e){this.facts.security.push({name,rejected:true,rawError:e.message})}}
   },
 /**
  * The preemption evidence for the metric surface: what the watcher asked for, what the driver accepted, and what
  * it had to throw away, summed over every member. A build without the candidate has no counters on the agent,
  * so the surface reports zeroes rather than failing on a missing field.
  */
 preemptFacts(){const counters=this.runtime?.preempt?.snapshot?.();
  const stats={fired:0,extraRequests:0,extraInputTokens:0,extraOutputTokens:0,discardedPartialItems:0};
  for(const [actor]of topology){const own=this.runtime?.handles.get('member:'+actor)?.agent?.preemptStats;
   if(!own)continue;for(const key of Object.keys(stats))stats[key]+=own[key]??0}
  // asked = triggers the watcher's latch accepted; count = steps the driver actually settled as preempted. They
 // differ when a trigger lands in the last moments of a step whose stream was already ending: nothing was bought.
 return{asked:counters?.preempts??0,count:stats.fired,coalesced:counters?.coalesced??0,notLive:counters?.notLive??0,woke:counters?.woke??0,refused:{
     ...(counters?.refused??{})},
   discardedPartialItems:stats.discardedPartialItems,extraRequests:stats.extraRequests,
   extraInputTokens:stats.extraInputTokens,extraOutputTokens:stats.extraOutputTokens};}
};
