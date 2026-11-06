import {assertReviewEfficiency} from './soak-efficiency.mjs';
import fs from 'node:fs';
import { saveFailure } from '../failure-diagnostics.mjs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {summarize} from './metrics.mjs';
import {checkPairs} from './protocol.mjs';
import {assertLosslessJson} from './tool-output.mjs';
import {route} from './config.mjs';
const root=path.resolve(process.argv[2]??'');
assert(root.toLowerCase().replaceAll('\\','/').startsWith(process.cwd().replaceAll('\\', '/').toLowerCase() + '/runs/'));
assert(!fs.existsSync(root));fs.mkdirSync(root,{recursive:true});
const ledger=process.env.DSH_BUDGET_LEDGER??'runs/real-budget.json',before=fs.existsSync(ledger)?fs.readFileSync(ledger):null;
const env={...process.env};delete env.CLOSEOUT_PROVIDER_KEY;
const stages=['smoke','p2-replay','model-contracts','soak'],results=[],mutations=[],childOutputs=[];
process.on('uncaughtExceptionMonitor',error=>{
  const diagnostics=saveFailure({label:'real/full-test',output:childOutputs.join('\n')+'\n'+error.stack,error,
    metadata:{phase:'assertion-or-unhandled',root},roots:[root]});
  console.error('FAILED real/full-test; diagnostics='+diagnostics);
});
const load=p=>JSON.parse(fs.readFileSync(p));
const run=(script,args,expected=0)=>{
  const outputFile=path.join(root,'child-output-'+childOutputs.length+'.log'),fd=fs.openSync(outputFile,'w');
  let x;
  try { x=spawnSync(process.execPath,[script,...args],{env,stdio:['ignore',fd,fd],timeout:120000}); }
  finally {fs.closeSync(fd);}
  x.stdout=fs.readFileSync(outputFile,'utf8');x.stderr='';
  childOutputs.push('== '+script+' '+args.join(' ')+'\n'+String(x.stdout??'')+String(x.stderr??''));
  if (x.status !== expected || x.error) {
    const diagnostics = saveFailure({ label: script, output: String(x.stdout ?? '') + String(x.stderr ?? ''), error: x.error,
      metadata: { args, expected, exitCode: x.status, signal: x.signal }, roots: [root] });
    console.error('FAILED ' + script + '; diagnostics=' + diagnostics);
    assert.fail('child exit=' + x.status + ' expected=' + expected + '; diagnostics=' + diagnostics);
  }
  return x;
};
const mutate=(stage,facts,name,change,assertion)=>{
  const f=structuredClone(facts);change(f);const m=summarize(f);
  assert.equal(m.assertions[assertion],false,stage+': '+name+' did not fail '+assertion);
  assert.equal(m.passed,false);mutations.push({stage,name,failedAssertion:assertion});
};
for(const stage of stages){
  const p=root+'/'+stage;
  run('verification/real/run.mjs',[stage,'--fake-provider','--root',p]);
  const report=load(p+'/report.json'),f=load(p+'/facts.json');
  assert.equal(report.status,'passed');assert.equal(report.realProviderRequests,0);
  // Stage ceilings and repetition detector remain independent; fake efficiency must preserve all real review work.
  if(stage==='soak')assertReviewEfficiency(f);
  assert.equal(report.turnRequestLimit,stage==='soak'?32:16,stage+': stage-specific per-turn ceiling');
  assert.equal(report.repeatedToolCallLimit,6,stage+': the loop detector must be armed');
  assert.deepEqual(report.loops,[],stage+': an honest run repeats no call');
  assert.equal(report.metrics.assertions.turnLimitHonest,true,stage+': neither safety net may fire');
  assert(report.cleanup&&report.ports.every(p=>p.closed));assert(report.metrics.passed);
  assert(report.metrics.rootContext.sequence.length>=2);
  assert(report.metrics.rootContext.sequence.every(x=>Number.isFinite(x.inputTokens)&&Number.isFinite(x.snapshotTokens)&&Number.isFinite(x.requestBytes)&&Number
      .isFinite(x.cacheHit)&&Number.isFinite(x.cacheMiss)));
  assert(report.metrics.latency.transport.raw.length>0);
  // The pre-dispatch estimate must be a real upper bound on tokens whatever method produced it, and every request
  // must say which method it used: full UTF-8 bytes (a BPE token is at least one byte) or the reported input of the
  // previous request plus the bytes appended since. bytes*4 bounded nothing (usage is ~1 token per 3 bytes) and
  // refused a 187 KB request at ~6% of the window; a delta that forgot the prefix it reuses would be the same bug
  // in the other direction, so both halves are checked here.
  assert(f.requests.length>0);
  const methods=new Set();
  for(const r of f.requests){
    methods.add(r.estimateMethod);
    assert(['prefix-delta','full-bytes'].includes(r.estimateMethod),stage+': every request must record how it was estimated');
    assert(r.inputUpperBound>=r.usage.input,stage+': the estimate must never understate measured input tokens');
    if(r.estimateMethod==='full-bytes')assert.equal(r.inputUpperBound,r.requestBytes,stage+': a full estimate is the serialized byte count');
    else assert(r.estimateEvidence.previousInput+r.estimateEvidence.addedBytes<=r.inputUpperBound,stage
      +': a delta estimate must carry the reported prefix it reuses');
  }
  assert(methods.has('prefix-delta'),stage+': a long-running member must reuse its reported prefix instead of re-estimating its whole history');
  assert.equal(report.metrics.rootContext.estimate.methods['full-bytes']+report.metrics.rootContext.estimate.methods['prefix-delta'],f.requests.length);
  assert(f.requests.every(r=>r.usage.input+r.usage.output<route.contextWindow*.75),stage+': a dispatched request exceeded the 75% ceiling');
  assert.equal(report.metrics.assertions.toolOutputs,true);assert.deepEqual(report.metrics.toolOutputErrors,[]);
  // Guards are reported apart from the schema rate, and the request gate must stay inside its limits.
  assert.equal(report.metrics.assertions.guardRejectionsHandled,true);
  assert.equal(report.metrics.assertions.concurrencyHonest,true);
  assert(Number.isFinite(report.metrics.guardRejections.count));
  assert(report.metrics.concurrency.gate.peakPerMember<=report.metrics.concurrency.gate.maxConcurrent);
  assert(report.metrics.concurrency.gate.peakInFlight<=report.metrics.concurrency.gate.globalConcurrency);
  assert.equal(report.metrics.concurrency.budgetViolations.length,0);
  assert.equal(report.metrics.latency.storedToBoundary.split.slotWaitMs.raw.length,report.metrics.latency.storedToBoundary.raw.length);
  assert.equal(report.metrics.latency.storedToBoundary.split.requestServiceMs.raw.length,report.metrics.latency.storedToBoundary.raw.length);
  assert(!report.metrics.qualityDiagnostics.some(p=>p.toolErrors.length));
  mutate(stage,f,'missing provider evidence',x=>x.requests=[], 'provider');
  mutate(stage,f,'native schema execution error',x=>x.protocolErrors.push({error:'injected'}),'nativeToolProtocol');
  mutate(stage,f,'JavaScript internal exception',x=>x.protocolErrors.push({actor:'verifier',name:'real_work',args:{op:'review'},
    requestId:'injected-fixture',at:Number.MAX_SAFE_INTEGER,error:"Cannot read properties of null (reading 'replies')"}),'noHarnessErrors');
  mutate(stage,f,'uncorrected real protocol error',x=>x.protocolErrors.push({actor:'a1',name:'team_read',args:{view:'team',ref:'team'},
        requestId:'injected-uncorrected',at:Number.MAX_SAFE_INTEGER,error:'INVALID_STRING'}),'nativeToolProtocol');
  // The BPE-independent rate limit is 10%, so a single injected error only stays inside it on a stage with enough
  // tool calls; on the four-call compatibility stages it would fail for the rate rather than for the rule.
  if(['model-contracts','soak'].includes(stage)){
    // A caller-side ref defect is forgiven only by a later successful read of the SAME view. Both directions are
    // pinned here with synthesized rows, because the live soak failed on exactly this rule: member a2 read
    // artifact:2:a2 five seconds before that artifact existed and never retried the evidence view, while root's
    // malformed task ref was repaired by a later {view:"task"}. One is a real caller defect, the other a repaired
    // one, and a rule that answered the same way for both would either hide a defect or fail an honest run.
    const read=(view,requestId,at)=>({actor:'a1',name:'team_read',args:{view},requestId,at,source:'native-model-tool'});
    const refError={actor:'a1',name:'team_read',args:{view:'evidence',ref:'artifact:9:zz'},
      requestId:'injected-ref-defect',at:0,error:'INVALID_REF'};
    const repaired=structuredClone(f);
    repaired.toolActions.push(read('evidence','injected-later-read',1));
    repaired.protocolErrors.push(structuredClone(refError));
    const rm=summarize(repaired);
    assert(rm.protocol.schemaErrorRate<=.10,stage+': the injected error must stay inside the rate limit');
    assert.equal(rm.assertions.nativeToolProtocol,true,stage+': a ref repaired by a later same-view read must pass');
    assert.equal(rm.protocol.recoveredErrors>=1,true,stage+': the repaired ref must be accounted as recovered');
    const unrepaired=structuredClone(f);
    unrepaired.toolActions.push(read('task','injected-other-view',1));
    unrepaired.protocolErrors.push(structuredClone(refError));
    const um=summarize(unrepaired);
    assert.equal(um.assertions.nativeToolProtocol,false,stage+': an unrepaired ref must fail the protocol answer');
    assert(um.protocol.unrecovered.some(e=>e.code==='INVALID_REF'),stage+': the unrepaired ref must be listed as unresolved');
    assert.equal(um.passed,false);
    mutations.push({stage,name:'evidence ref read before it exists, never retried',failedAssertion:'nativeToolProtocol'});
  }
  mutate(stage,f,'guard rejection without the demanded progress',x=>x.protocolErrors.push({actor:'root',name:'real_work',args:{op:'integrate'},
        requestId:'injected-guard',at:Number.MAX_SAFE_INTEGER,cycle:null,error:'DELIVERIES_NOT_VERIFIED'}),'guardRejectionsHandled');
  if(['model-contracts','soak'].includes(stage)){
    // The fourth real run failed exactly here: four deliveries verified, the issue still collecting with one reply.
    mutate(stage,f,'decision recorded without every review reply',x=>{const issue=x.issues[0];issue.status='decided';issue.missing=[];
      issue.requiredEvidence=['artifact:1:a1','artifact:1:a2','artifact:1:b1','artifact:1:b2'];issue.replies=issue.replies.slice(0,1);},'threadReadiness');
    mutate(stage,f,'issue left collecting after integration',x=>{x.issues[0].status='collecting';},'threadReadiness');
    // A thread the harness escalated at teardown is a different fact from one the model left collecting, and both
    // must fail readiness. The report names the first kind separately (closeEscalations) so a reader can tell an
    // early exit from a missed obligation without re-deriving it from timestamps -- which is exactly the judgement
    // the live soak needed and could not make.
    mutate(stage,f,'thread escalated by the run closing',x=>{x.issues[0].status='escalated';
      x.issues[0].reason='run closed with pending decision';},'threadReadiness');
    assert.equal(report.metrics.threadReadiness.closeEscalations,0,stage+': a completed run escalates no thread');
    const escalated=structuredClone(f);escalated.issues[0].status='escalated';escalated.issues[0].reason='run closed with pending decision';
    assert.equal(summarize(escalated).threadReadiness.closeEscalations,1,stage+': a teardown escalation must be counted');
    // Dependency release means accepted, not merely verified: a batch whose four artifacts are verified but never
    // integrated is the state the live soak stopped in, and it must not pass.
    mutate(stage,f,'verified deliveries never integrated',x=>{for(const d of x.deliveries)d.status='verified';},'dependencyReleased');
    // The clock, not the team, ends the cycle in flight when the soak reaches its hour. Three runs' worth of
    // assertions failed at once on that half-cycle, so the forgiveness is pinned from both sides: it must pass only
    // for the last cycle and only for TIME_STOP, and every other early exit still has to fail.
    // The clock class now has two members and both must forgive: the soak's TIME_STOP and the collaboration stage's
    // own ceiling. They are separate codes because the stage's progress window is not a clock and still fails.
    const truncated=(x,code='TIME_STOP')=>{x.cycleInProgress=(x.completedCycles??2)+1;x.stop={code};
      const cycle=x.cycleInProgress,issue=x.issues[0];
      issue.requiredEvidence=['artifact:'+cycle+':a1','artifact:'+cycle+':b1'];
      issue.status='escalated';issue.reason='run closed with pending decision';issue.replies=[];issue.missing=[];
      x.deliveries.push({id:'artifact:'+cycle+':b2',cycle,actor:'b2',status:'produced',producedAt:Date.now(),messageId:'message:truncated',
        manifestHash:'hash-truncated',verifierRequestId:null,certificate:null});};
    {
      const clock=structuredClone(f);truncated(clock);const cm=summarize(clock);
      assert.equal(cm.truncatedForgiven,true,stage+': a TIME_STOP must be recognised as truncating the last cycle');
      assert.equal(summarize({...structuredClone(clock),stop:{code:'STAGE_TIME_LIMIT'}}).assertions.dependencyReleased,true,
        stage+': the collab stage ceiling is the same clock and forgives the same half-cycle');
      assert.equal(cm.truncatedCycle.cycle,f.completedCycles+1);
      assert(cm.truncatedCycle.thread.length===1&&cm.truncatedCycle.deliveries.some(d=>d.status==='produced'),stage
        +': the truncated cycle must be reported with its thread and deliveries');
      for(const k of ['threadReadiness','dependencyReleased','independentVerifier'])
        assert.equal(cm.assertions[k],true,stage+': '+k+' must forgive the cycle the clock truncated');
      // The same half-cycle outside the clock is a missed obligation, not a truncation.
      for(const code of ['NO_PROGRESS_STOP','CONTEXT_75_PERCENT_GATE_BEFORE_REQUEST','WORKLOAD_CYCLE_NOT_ACCEPTED',null]){
        const notClock=structuredClone(clock);notClock.stop={code};
        for(const k of ['threadReadiness','dependencyReleased','independentVerifier'])
          assert.equal(summarize(notClock).assertions[k],false,stage+': '+k+' must fail when the run stopped for '+(code??'nothing'));
      }
      const early=structuredClone(clock);early.cycleInProgress=1;
      for(const k of ['threadReadiness','dependencyReleased','independentVerifier'])
        assert.equal(summarize(early).assertions[k],false,stage+': '+k+' must fail when the truncated cycle is not the last one');
      const finished=structuredClone(clock);finished.cycleInProgress=null;
      for(const k of ['threadReadiness','dependencyReleased','independentVerifier'])
        assert.equal(summarize(finished).assertions[k],false,stage+': '+k+' must fail when the cycle actually finished');
      assert.equal(summarize(clock).passed,true,stage+': a clean TIME_STOP truncation must not fail the run');
      for(const name of ['truncated cycle forgiven only for TIME_STOP','truncation not in the last cycle','truncation under a non-TIME_STOP exit'])
        mutations.push({stage,name,failedAssertion:'threadReadiness/dependencyReleased/independentVerifier'});
    }
  }
  mutate(stage,f,'permanent dead letter',x=>x.messages[0].status='dead-letter','noPermanentDeadLetter');
  mutate(stage,f,'duplicate retry effect',x=>{const t=x.toolActions.find(t=>t.args?.operationId);x.toolActions.push({...structuredClone(t),
          resultRef:'message:injected-duplicate'})},'noDuplicateEffects');
  mutate(stage,f,'role elevation allowed',x=>x.security[0].rejected=false,'security');
  // The preemption metric must stay honest: a step that was cut short is only legitimate if it can be charged for
  // the extra request it caused, so an extra request with no preemption behind it fails on its own line.
  mutate(stage,f,'preempt never fired',x=>{x.preempt={...(x.preempt??{}),count:0,extraRequests:Math.max(1,x.preempt?.extraRequests??0)}},
    'instantPreemptHonest');
  mutate(stage,f,'oversized snapshot',x=>x.requests.find(r=>r.snapshotTokens>0).snapshotTokens=4097,'snapshot4096');
  // One truncated response, injected into an otherwise clean run, must fail on its own line: the assertion is not a
  // restatement of the stop code, it is about the response the provider actually sent.
  mutate(stage,f,'response truncated at the output cap',x=>{x.requests[0]={...x.requests[0],truncated:true,responseStatus:'incomplete',
        incompleteReason:'max_output_tokens'}},'noSilentTruncation');
  if(['smoke','p2-replay'].includes(stage)){
    for(const surface of ['structuredSnapshot','toolPairs','reasoning','nativeFold','cold'])assert.equal(report.metrics.compatibility[surface].status,
      'accepted');
    assert(report.metrics.compatibility.reasoning.opaqueHashesUnchanged);
    assert(report.metrics.replay.offQuality.length===2&&report.metrics.replay.onQuality.length===2);
    assert(report.metrics.rootContext.slopeByFold.off!==null&&report.metrics.rootContext.slopeByFold.on!==null);
    mutate(stage,f,'masked snapshot reappears',x=>x.folds[0].oldMasked=false,'nativeFold');
    mutate(stage,f,'reasoning byte changed',x=>x.requests.find(r=>r.reasoningHashes.length).reasoningHashes[0]='tampered','reasoning');
    mutate(stage,f,'cold host differs',x=>x.cold[0].hostProcessEqual=false,'cold');
    mutate(stage,f,'missing replay source',x=>delete x.replay,'sameReplaySource');
    mutate(stage,f,'quality regressed',x=>x.replay.onQuality[0]=false,'quality');
  }else{
    assert.equal(report.metrics.peerMessages,8);assert.equal(report.metrics.actionAcceptance.rate,1);
    assert.equal(report.metrics.deliveries.length,8);assert.equal(report.completedCycles,2);
    for(const k of ['producedToVerified','verifiedToMerged','mergedToAccepted','readyToAdmitted','admittedToFirstRequest','firstRequestToCheckpoint',
        'storedToBoundary'])assert(report.metrics.latency[k].raw.length>0);
    assert(report.metrics.decisionLatency.raw.length>=2&&report.metrics.rootPendingQueue.length>0);
    // Every batch must end behind a decided issue that recorded one reply per reviewed delivery.
    assert.equal(report.metrics.assertions.threadReadiness,true,stage+': thread readiness');
    mutate(stage,f,'host broadcast not native peer',x=>x.toolActions=[],'peer');
    mutate(stage,f,'accept third boundary',x=>{for(const m of x.messages)m.acceptBoundary=m.visibleBoundary+3},'accept95');
    mutate(stage,f,'deadline missed',x=>{for(const m of x.messages)m.deadline='2000-01-01T00:00:00.000Z'},'deadline100');
    mutate(stage,f,'verifier association missing',x=>delete x.deliveries[0].verifierRequestId,'independentVerifier');
    mutate(stage,f,'decision not manifest-linked',x=>delete x.decisions[0].manifestHash,'decisions');
    mutate(stage,f,'delivery timestamps missing',x=>{for(const d of x.deliveries)delete d.verifiedAt},'deliveryTiming');
    { const slow=structuredClone(f);for(const m of slow.messages)m.visibleAt=m.storedAt+6000;const measured=summarize(slow);assert(measured.latency
        .storedToBoundary.p90>=6000);assert.equal(measured.performance.status,'not-run');assert.equal(measured.passed,true,
        'fake slow wall-clock values are retained, not a live benchmark');
      }
    if(stage==='model-contracts'){
      // Functional facts are already independently passing above. Only the explicitly requested study varies.
      // Each child executes the worker's actual summarize/verdict/report/exit functions with provider IO denied.
      const study=()=>({concurrency:1,backgroundLoad:'idle',samples:['cold','warm'].flatMap(condition=>
        Array.from({length:30},()=>({condition,warmupCycles:condition==='cold'?0:2,readyToAdmittedMs:2000,storedToBoundaryMs:5000})))});
      const cases=[
        {name:'qualified-boundary-control',passed:true,status:'measured',change:()=>{}},
        {name:'ready-over-2000',passed:false,status:'measured',change:x=>{for(const s of x.performanceStudy.samples)if(s.condition==='cold')s.readyToAdmittedMs=
          2001;
        }
          },
        {name:'mailbox-over-5000',passed:false,status:'measured',change:x=>{for(const s of x.performanceStudy.samples)if(
        s.condition==='warm')s.storedToBoundaryMs
            =5001;}},
        {name:'both-p90-90000',passed:false,status:'measured',change:x=>{for(const s of x.performanceStudy.samples){s.readyToAdmittedMs=90000;
        s.storedToBoundaryMs
              =90000;}}},
        {name:'insufficient-warm-samples',passed:false,status:'insufficient',change:x=>x.performanceStudy.samples.pop()},
        {name:'invalid-latency-sample',passed:false,status:'insufficient',change:x=>{x.performanceStudy.samples[0].readyToAdmittedMs=null;}},
        {name:'missing-condition-label',passed:false,status:'insufficient',change:x=>{delete x.performanceStudy.samples[0].condition;}},
        {name:'unqualified-concurrency',passed:false,status:'insufficient',change:x=>{x.performanceStudy.concurrency=2;}},
        {name:'live-functional-not-requested',passed:true,status:'not-run',change:x=>{delete x.performanceStudy;}},
        {name:'fake-study-not-run',passed:true,status:'not-run',change:x=>{x.mode='fake';for(const s of x.performanceStudy.samples)s.storedToBoundaryMs=90000;
          }},
        {name:'fault-study-not-run',passed:true,status:'not-run',change:x=>{x.fault='injected';for(const s of x.performanceStudy.samples)s.readyToAdmittedMs=
          90000;}
        }
      ];
      for(const c of cases){
        const sample=structuredClone(f);sample.mode='live';sample.performanceStudy=study();c.change(sample);
        const direct=summarize(sample);
        assert.equal(direct.performance.status,c.status,c.name+': performance classification');
        assert.equal(direct.passed,c.passed,c.name+': summarize total verdict');
        assert(Object.entries(direct.assertions).filter(([k])=>k!=='performance').every(([,v])=>v===true),c.name+': functional baseline must stay passing');
        if(c.status!=='not-run')assert.equal(direct.assertions.performance,c.passed,c.name+': explicit performance assertion');
        const input=path.join(root,'performance-'+c.name+'-facts.json'),output=path.join(root,'performance-'+c.name);
        fs.writeFileSync(input,JSON.stringify(sample));
        run('verification/real/test-support/worker-result-child.mjs',[input,output],c.passed?0:2);
        const replay=load(output+'/report.json');
        assert.equal(replay.status,c.passed?'passed':'assertions-failed',c.name+': worker verdict');
        assert.equal(replay.metrics.passed,c.passed,c.name+': persisted total verdict');
        assert.deepEqual(replay.metrics.performance,direct.performance,c.name+': persisted performance evidence');
        assert.deepEqual(replay.metrics.assertions,direct.assertions,c.name+': persisted assertions');
        assert.equal(replay.realProviderRequests,0);assert.equal(replay.reportEvaluationOnly,true);
        if(!c.passed)mutations.push({stage,name:c.name,failedAssertion:'performance',exitCode:2,report:'performance-'+c.name+'/report.json'});
      }
    }
    if(stage==='soak')mutate(stage,f,'fake is not one-hour live',x=>{x.mode='live';x.elapsedMs=1000},'duration');
    {
      // A guard refusal is legitimate, so it must not hide a duplicate external effect: here the guard itself is
      // worked through, and the duplicated result must still fail the assertion on its own.
      const g=structuredClone(f),t=g.toolActions.find(t=>t.args?.operationId);
      g.toolActions.push({...structuredClone(t),resultRef:'effect:injected-after-guard'});
      g.protocolErrors.push({actor:'root',name:'real_work',args:{op:'integrate'},requestId:'injected-guard-worked',at:-1,cycle:null,error:
      'DELIVERIES_NOT_VERIFIED'
          });
      const gm=summarize(g);
      assert.equal(gm.guardRejections.unresolved,0,stage+': the injected guard should have been worked through');
      assert.equal(gm.assertions.guardRejectionsHandled,false,stage+': duplicate effect after a guard rejection did not fail');
      assert.equal(gm.assertions.noDuplicateEffects,false);assert.equal(gm.passed,false);
      mutations.push({stage,name:'duplicate effect after a guard rejection',failedAssertion:'guardRejectionsHandled'});
    }
  }
  if(stage==='model-contracts'){
    // Real ordering failure: root integrates before opening the review issue, so the verifier completes the batch
    // with no thread to reply on. Both refusals must be business errors, the batch must be recoverable, and the
    // run must still be able to complete the cycle after repairing the order.
    const orderRoot=p+'-review-before-open';
    run('verification/real/run.mjs',[stage,'--fake-provider','--fake-fault','review-before-open','--root',orderRoot],0);
    const order=load(orderRoot+'/report.json'),om=order.metrics;
    assert.equal(order.status,'passed');
    assert.equal(om.assertions.noHarnessErrors,true);
    assert.equal(om.assertions.guardRejectionsHandled,true);
    assert.equal(om.assertions.nativeToolProtocol,true);
    const codes=om.guardRejections.items.map(i=>i.code);
    assert(codes.includes('REVIEW_THREAD_NOT_OPENED'),'the missing-thread guard must be exercised');
    assert(om.guardRejections.items.every(i=>i.state!=='unresolved'),'every refusal must be recovered by the repair');
    assert.equal(order.completedCycles,2);
    assert.equal(om.assertions.dependencyReleased,true);
    // Every accepted batch must be backed by a decided issue that recorded one reply per delivery: this is the state
    // the fourth real run could not reach, where four deliveries were verified and the thread still read collecting.
    const orderFacts=load(orderRoot+'/facts.json');
    assert.equal(orderFacts.issues.length>=2,true);
    for(const issue of orderFacts.issues){
      assert.equal(issue.status,'decided',issue.entityId+' must be decided after integration');
      assert.equal(issue.replies.length,4,issue.entityId+' must record every review reply');
      assert.equal(new Set(issue.replies.map(r=>r.bodyRef)).size,4,issue.entityId+' must record distinct deliveries');
      assert.deepEqual(issue.missing,[]);
    }
    results.push({stage:stage+'-review-before-open',status:order.status,guards:om.guardRejections.items.map(i=>i.code+'/'+i.state)});
  }
  const fault=['smoke','p2-replay'].includes(stage)?'reject-reasoning':'omit-accept',negative=p+'-negative';
  run('verification/real/run.mjs',[stage,'--fake-provider','--fake-fault',fault,'--root',negative],2);
  const nr=load(negative+'/report.json');assert.equal(nr.realProviderRequests,0);assert(nr.cleanup&&!nr.metrics.passed);
  if(fault==='reject-reasoning')assert(nr.metrics.compatibility.errors.some(e=>e.rawError?.code==='injected_signature_rejection'));
  else {assert.equal(nr.metrics.assertions.accept95,false);assert.equal(nr.metrics.assertions.dependencyReleased,false);assert(nr.metrics.decisionDeadlineExits
      .some(i=>i.status==='escalated'));assert(nr.metrics.actionAcceptance.samples.every(m=>m.accepted||m.status==='escalated'));
    }
  results.push({stage,status:report.status,requests:report.providerRequests,realProviderRequests:0,negative:{fault,status:nr.status,assertionsFailed:Object
        .entries(nr.metrics.assertions).filter(([,v])=>!v).map(([k])=>k)}});
  console.log(stage+' fake positive/negative PASS');
}
const outputRoot=root+'/smoke-invalid-tool-output';
run('verification/real/run.mjs',['smoke','--fake-provider','--fake-fault','invalid-tool-output','--root',outputRoot],2);
const outputReport=load(outputRoot+'/report.json');
assert.equal(outputReport.error.code,'TOOL_OUTPUT_ERROR');assert.equal(outputReport.error.message,'工具输出错误');
assert.equal(outputReport.metrics.assertions.toolOutputs,false);assert.equal(outputReport.metrics.assertions.quality,false);
assert(outputReport.metrics.toolOutputErrors.some(e=>e.source==='native-journal'&&e.code==='INVALID_TOOL_OUTPUT'&&e.name==='real_work'&&e.sourceEventSeqs
    .length>0));
assert(outputReport.metrics.qualityDiagnostics.filter(p=>p.mode==='off'&&!p.passed).every(p=>p.toolErrors.some(e=>e.code==='INVALID_TOOL_OUTPUT')));
assert(outputReport.cleanup&&outputReport.realProviderRequests===0);
const outputFacts=load(outputRoot+'/facts.json');outputFacts.replay.offQuality=[true,true];outputFacts.replay.onQuality=[true,true];
assert.equal(summarize(outputFacts).assertions.toolOutputs,false);assert.equal(summarize(outputFacts).passed,false);
// A turn that repeats one call is ended by the loop detector, with its own code and before the ceiling it would
// otherwise reach. This is the failure mode the ceiling was standing in for, and it is now measured rather than assumed.
{
  const loopRoot=root+'/smoke-repeat-tool-call';
  run('verification/real/run.mjs',['smoke','--fake-provider','--fake-fault','repeat-tool-call','--root',loopRoot],2);
  const lr=load(loopRoot+'/report.json'),lf=load(loopRoot+'/facts.json');
  assert.equal(lr.error.code,'REPEATED_TOOL_CALL_LOOP');
  assert.equal(lr.error.evidence.count,6);assert.equal(lr.error.evidence.limit,6);assert.equal(lr.error.evidence.name,'team_read');
  assert.equal(lr.loops.length,1);assert.equal(lr.realProviderRequests,0);assert(lr.cleanup);
  assert.equal(lr.metrics.assertions.turnLimitHonest,false,'a loop must fail the run on its own line');
  assert.equal(lr.metrics.assertions.nativeToolProtocol,true,'a repeated legal call is not a protocol defect');
  assert(lr.providerRequests<lr.turnRequestLimit,'the detector must fire long before the ceiling');
  const honest=structuredClone(lf);honest.loops=[];honest.stop={code:null};
  assert.equal(summarize(honest).assertions.turnLimitHonest,true,'the same facts without a loop pass');
  const injected=structuredClone(lf);injected.loops=[];injected.stop={code:'NATIVE_TURN_REQUEST_LIMIT'};
  assert.equal(summarize(injected).assertions.turnLimitHonest,false,'the ceiling exit, injected into an honest run, fails');
  mutations.push({stage:'smoke',name:'turn ended by the loop detector',failedAssertion:'turnLimitHonest'});
  mutations.push({stage:'smoke',name:'turn ended by the per-turn ceiling',failedAssertion:'turnLimitHonest'});
  results.push({stage:'smoke-repeat-tool-call',status:lr.status,error:lr.error.code,requests:lr.providerRequests});
}
// The provider cut a step at its output cap: status "incomplete", reason "max_output_tokens", the fragment of a write
// and no tool call. That is the failure the third real collaboration run paid for -- 17 of 95 responses truncated and
// every truncated turn reported as a normal end -- so the adapter must translate it to the loop's own max-tokens finish
// reason, the fact must be recorded per request and per turn, and a turn that ended on it must fail its own assertion.
{
  const cutRoot=root+'/smoke-truncated-output';
  run('verification/real/run.mjs',['smoke','--fake-provider','--fake-fault','truncate-output','--root',cutRoot],2);
  const cr=load(cutRoot+'/report.json'),cf=load(cutRoot+'/facts.json'),cm=cr.metrics;
  assert.equal(cr.realProviderRequests,0);assert(cr.cleanup);
  assert.equal(cr.status,'assertions-failed','a run cut short by its output cap must be assertions-failed, never passed');
  const rows=cf.requests.filter(r=>r.truncated===true);
  assert(rows.length>0,'the truncated responses must be recorded per request');
  assert(rows.every(r=>r.responseStatus==='incomplete'&&r.incompleteReason==='max_output_tokens'),'the provider verdict is recorded verbatim');
  assert(rows.every(r=>r.outputCap===route.maxOutputTokens),'each request states the output cap it asked for');
  assert.equal(cm.truncatedResponses.count,rows.length);assert(cm.truncatedResponses.byActor.a1>=1||cm.truncatedResponses.byActor.root>=1);
  assert(cm.turnEndedOnTruncation.count>0,'a turn the cap ended must be counted as one');
  // The mapping itself: the loop recorded max-tokens, not completed. Without it the truncated turn is a normal end.
  assert(cm.turnEndedOnTruncation.turns.some(t=>t.finish==='max-tokens'),'the truncated step must end the turn as max-tokens');
  assert.equal(cm.assertions.noSilentTruncation,false,'a turn that ended on a truncated response must fail the run');
  assert.equal(cm.assertions.noHarnessErrors,true,'a truncation is provider behaviour, not a JavaScript defect');
  mutations.push({stage:'smoke',name:'turn ended on a response truncated at the output cap',failedAssertion:'noSilentTruncation'});
  results.push({stage:'smoke-truncated-output',status:cr.status,truncated:cm.truncatedResponses.count,turns:cm.turnEndedOnTruncation.count});
}
run('verification/real/turn-limit-test.mjs',[root+'/turn-limit']);
run('verification/real/tool-output-test.mjs',[root+'/tool-output']);
assert.throws(()=>checkPairs([{type:'function_call',call_id:'a'}]),/UNPAIRED_TOOL_CALL/);
assert.throws(()=>checkPairs([{type:'function_call_output',call_id:'a'}]),/ORPHAN_TOOL_RESULT/);
assert.throws(()=>checkPairs([{type:'function_call',call_id:'a'},{type:'function_call',call_id:'a'}]),/DUPLICATE_TOOL_CALL/);
run('verification/real/deadline-protocol-test.mjs',[root+'/deadline-protocol']);
// The published contract the model must satisfy: operation ids, read refs, role limits.
run('verification/real/tool-contract-test.mjs',[root+'/tool-contract']);
// The two null paths from the third real run, and the concurrency ordering case behind them.
run('verification/real/workload-guard-test.mjs',[root+'/workload-guard']);
// The gate and the ledger must stay correct when requests overlap: the ceiling holds and no bound is spent twice.
run('verification/real/concurrency-test.mjs',[root+'/concurrency']);
run('verification/real/self-test.mjs',[root+'/budget']);
run('verification/real/safety-test.mjs',[root+'/safety']);
run('verification/real/dry-test.mjs',[root+'/dry']);
// The collaboration experiment: both arms of its stage, the three mechanisms as a contract, and the fact mutations
// that make every one of its assertions able to fail. Offline, like everything above.
run('verification/real/collab-test.mjs',[root+'/collab']);
assert.deepEqual(fs.existsSync(ledger)?fs.readFileSync(ledger):null,before);
fs.writeFileSync(root+'/summary.json',JSON.stringify({status:'passed',results,mutations,wireNegativeTests:3,toolOutput:load(root+'/tool-output/report.json'),
      nativeToolOutputNegative:{status:outputReport.status,error:outputReport.error.code,evidence:outputRoot+'/report.json'},deadlineProtocol:load(root
        +'/deadline-protocol/report.json'),concurrency:load(root+'/concurrency/report.json'),toolContract:load(root+'/tool-contract/report.json'),
      workloadGuard:load(root+'/workload-guard/report.json'),budget:'passed',safety:load(root+'/safety/report.json'),dry:load(root+'/dry/summary.json'),
      collab:load(root+'/collab/summary.json'),realLedgerUnchanged:true,realProviderRequests:0},null,2));
console.log('PASS: '+mutations.length+' negative metric mutations; concurrency/budget gate; four zero-request dry runs; budget; real ledger unchanged');