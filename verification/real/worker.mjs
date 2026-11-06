import { failureFromEngine } from './turn-budget.mjs';
import fs from 'node:fs';import path from 'node:path';import net from 'node:net';import {Budget} from './budget.mjs';import {Transport} from './transport.mjs';
import {Engine} from './scenario.mjs';import {fakeProvider} from './fake.mjs';import {compatibility,workload,collab as collabStage,
  performance as performanceStage} from './stages.mjs';import {evaluateWorkerResult,writeWorkerReport} from './worker-result.mjs';import {route,stages,policy,
  topology,collabTopology,performanceTopology} from './config.mjs';import {bootNativeProfile} from './native-host.mjs';import {collabFake
  } from './collab-stage.mjs';import {workspace,scopedRoot} from './scope.mjs';import {stopReason,progressWindowMs} from './stop.mjs';import {ConcurrencyGate
  } from './concurrency.mjs';
const [stage,root,mode,authorization,fault,arm='off']=process.argv.slice(2),dry=mode==='dry',fake=mode==='fake',collabStageRun=stage==='collab',
performanceStageRun=stage==='performance';const key=mode==='live'?process.env.CLOSEOUT_PROVIDER_KEY:null;delete process.env.CLOSEOUT_PROVIDER_KEY;
scopedRoot(root);if(!stages[stage]||!['live','dry','fake'].includes(mode))throw Error('INVALID_WORKER_MODE');if(mode==='live'&&(!key
    ||authorization!=='authorized'))throw Error('AUTH_REQUIRED');fs.mkdirSync(root,{recursive:true});const ledger=fake?root+'/fake-budget.json':(mode!=='live'
  &&process.env.DSH_BUDGET_LEDGER?path.resolve(process.env.DSH_BUDGET_LEDGER):path.join(workspace,'runs','real-budget.json'));
const facts={stage,mode,requests:[],messages:[],toolActions:[],turns:[],deliveries:[],decisions:[],protocolErrors:[],security:[],folds:[],cold:[],latency:{},
  completedCycles:0};const topologyFor=collabStageRun?collabTopology:performanceStageRun?performanceTopology:topology;const engine=new Engine(root,facts,mode,{
    stage,collab:collabStageRun?arm:'off',topology:topologyFor,bootHost:collabStageRun?bootNativeProfile:null,perWorkspace:collabStageRun});const gate
=new ConcurrencyGate({maxConcurrent:policy.maxConcurrent,globalConcurrency:policy.globalConcurrency??1});let budget,transport,status='failed',error=null,
stopRequested=false;const started=Date.now();const originalConnect=net.Socket.prototype.connect,originalFetch=globalThis.fetch;
engine.fault=fake?fault:null;
if(dry||fake){net.Socket.prototype.connect=function(){throw Error('OFFLINE_NETWORK_DENIED')};globalThis.fetch=async()=>{throw Error('OFFLINE_NETWORK_DENIED')}}
const stopped=()=>engine.requestLimitFailure?.code??stopReason({stopRequested,stage,started,lastProgress:engine.lastProgress});
process.on('message',m=>{if(m?.stop)stopRequested=true});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopRequested=true});
try{budget=new Budget(ledger,stage,{readonly:dry});await engine.open();transport=new Transport({root,budget,mode,key,fake:fake?(collabStageRun
        ?collabFake(engine):fakeProvider(engine,{fault})):null,facts,stopped,gate,onDispatchPhase:event=>engine.onDispatchPhase(event)});engine.gate=gate;engine
  .transport=transport;
 // The collaboration stage admits its own members inside the stage (one task and one attempt per member, created by
 // the delegation), so the bootstrap bind here would schedule a second attempt on the same member; it also runs its
 // own security block at the start of the stage instead of after the first build round, because a probe the run never
 // reaches while another member is still working is an unmeasured property rather than a passed one.
  if(!collabStageRun&&(stage==='smoke'||stage==='p2-replay')){const first=engine.turnsEnded(engine.agent('a1'));const offline=stage==='smoke'
    ||stage==='p2-replay';if(offline)engine.compatibilityMode=true;if(offline&&!dry)await engine.turn('root',
      'Hand one responsibility to member:a1 with team_message send {kind action, expectedOutcome, deadline PT5M, expectedRevision 0, unique ' +
        'operationId}, call real_work brief once, then stop after tools.');
    await engine.bind('a1','bootstrap');await engine.waitTurn('a1',first);engine.security();
    }
 if(dry){try{await engine.turn('root','Dry run: stop before the first provider transport.')}catch(e){if(e.message!=='DRY_STOP_BEFORE_PROVIDER')throw e
     }if(!transport.boundary||transport.requests!==0)throw Error('DRY_BOUNDARY_FAILED');status='dry-run-passed';
   }
 else{if(stage==='smoke'||stage==='p2-replay')await compatibility(engine);else if(collabStageRun)await collabStage(engine,{stopped});
   else if(performanceStageRun)await performanceStage(engine,{stopped});else await workload(engine,{stage,mode,stopped});status='evaluated';
   }
}catch(e){error=failureFromEngine(engine,e);status=['TIME_STOP','STAGE_TIME_LIMIT','BUDGET_STOP_BEFORE_REQUEST','NO_PROGRESS_STOP','SIGNAL_STOP']
  .includes(e.message)?'stopped':'failed';
  }
finally{try{await engine.close()}catch(e){error={code:'CLEANUP_FAILED',detail:e.message,prior:error};status='failed'}
 // A preempted provider call may still be draining. Do not unlock its ledger while a late response can write usage.
 const drained=await gate.whenSettled(policy.requestTimeoutMs+1000);if(!drained){error={code:'TRANSPORT_DRAIN_TIMEOUT',prior:error};status='failed'}
 try{budget?.close({retainLock:!drained})}catch{status='failed'}globalThis.fetch=originalFetch;net.Socket.prototype.connect=originalConnect;facts.stop={
   code:error?.code??null,progressSource:facts.progress?.last?.source??null,progressAt:facts.progress?.last?.at??null,
  progressWindowMs:progressWindowMs(stage)};if(facts.progress)facts.progress.windowMs=progressWindowMs(stage);facts.elapsedMs=Date.now()-started;facts.gate=gate
  .stats();fs.writeFileSync(root+'/facts.json',JSON.stringify(facts,(_,v)=>typeof v==='string'&&key?v.split(key).join('[REDACTED]'):v,2));const evaluated
  =evaluateWorkerResult(facts,status,error);const metrics=evaluated.metrics;status=evaluated.status;error=evaluated.error;const selfPorts=new Set(process.env
    .COLLAB_WATCH_TOKEN?[Number(process.env.COLLAB_WATCH_PORT??40298),Number(process.env.COLLAB_WATCH_VIEWER_PORT??40299)]:[]);const ports=await Promise.all(
    Array
    .from({length:10},(_,n)=>40290+n).map(port=>selfPorts.has(port)?{port,closed:true,self:true}:new Promise(resolve=>{const socket=net.connect({host:
      '127.0.0.1',
              port});socket.setTimeout(500);socket.on('connect',()=>{socket.destroy();resolve({port,closed:false})});socket.on('error',()=>resolve({port,closed:
                true}));
              socket
          .on('timeout',()=>{socket.destroy();resolve({port,closed:false})})})));const cleanup=ports.every(p=>p.closed);if(!cleanup)status='failed';
 const report={stage,arm,status,error,dryRun:dry,fakeProvider:fake,providerKeyPresent:!!key,providerRequests:transport?.requests??0,
   realProviderRequests:mode==='live'?(transport?.requests??0):0,boundaryReached:transport?.boundary??false,provider:route,topology,maxConcurrent:policy
   .maxConcurrent,globalConcurrency:policy.globalConcurrency??1,concurrency:gate?.stats()??null,stageLimit:stages[stage],globalLimit:policy.globalLimit,
   turnRequestLimit:engine.turnLimit,repeatedToolCallLimit:engine.repeatLimit,loops:facts.loops??[],ledger,elapsedMs:facts.elapsedMs,completedCycles:facts
   .completedCycles,metrics,ports,cleanup,limitations:['Fake provider validates pipeline only, not model behavior.',
     'Snapshot tokens use native estimateMessage; input/output/cache usage come from provider, not character estimates.',
     'Artifact integration is isolated signed readback/copy, not production Git delivery; no git commits are created.',
     'Reasoning acceptance means route accepted opaque bytes unchanged; no local signature validation or production fold admission certificate.',
     'Soak early budget/time/no-progress stops are explicit and not automatically a one-hour pass.']};const exitCode=writeWorkerReport(root,report,{key});
 if(exitCode)process.exitCode=exitCode;if(process.connected)process.disconnect();
   }
