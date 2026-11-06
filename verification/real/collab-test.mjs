import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {summarize} from './metrics.mjs';
import {loopCode} from './loop-guard.mjs';
import {policy} from './config.mjs';
import {stopReason, progressWindowMs} from './stop.mjs';
import {Engine} from './scenario.mjs';
import {writeDelivery, deliveryState, deliverablePath, deliveryRefOf} from './collab-stage.mjs';

/**
 * The collaboration experiment's own verification, offline and provider-free.
 *
 * Three things are proved here and nowhere else. The contract test pins the mechanisms as pure behaviour. The two arms
 * run the same workload through the real host, the real control store and the real native tools, and the facts each
 * arm leaves behind are the experiment's data. Then every assertion that judges those facts is inverted by mutating a
 * fact, so a green run cannot be a run whose numbers were never looked at: a gate that never refused, an assumption
 * that was never answered and a decision that never reached a snapshot all fail on their own line.
 */
const root=path.resolve(process.argv[2]??'');
assert(root.toLowerCase().replaceAll('\\','/').startsWith(process.cwd().replaceAll('\\', '/').toLowerCase() + '/runs/'),'COLLAB_TEST_SCOPE');
assert(!fs.existsSync(root));fs.mkdirSync(root,{recursive:true});
const env={...process.env};delete env.CLOSEOUT_PROVIDER_KEY;
const load=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const run=(script,args,expected=0)=>{
  const x=spawnSync(process.execPath,[script,...args],{env,encoding:'utf8',timeout:600000});
  assert.equal(x.status,expected,script+' '+args.join(' ')+'\n'+x.stdout+x.stderr);
  return x;
};

// 1. The mechanisms as a contract, off and on, with no host and no provider.
run('verification/real/collab-contract-test.mjs',[root+'/contract']);
// Deterministic startup regressions run on every full collaboration acceptance, not only in an ad-hoc stress script.
run('verification/real/collab-backend-test.mjs',[]);
const contract=load(root+'/contract/report.json');
assert.equal(contract.status,'passed');assert(contract.checks.length>=8);

// 2. The snapshot price of the block, isolated on one committed state rather than across two runs.
run('verification/real/collab-snapshot-delta.mjs',[root+'/snapshot-delta']);
const delta=load(root+'/snapshot-delta/report.json');
assert(delta.on.bytes>delta.off.bytes,'the block costs something');
assert(delta.on.blockBytes>0,'the cost of the block itself is reported');
assert(delta.on.bytes<=2048,'the on-arm snapshot stays inside the unchanged 4096-byte ceiling (payload*2)');

// 3. Both arms of the stage, fake provider, empty roots.
const arms={};
for(const arm of ['off','on']){
  const dir=root+'/arm-'+arm;
  run('verification/real/run.mjs',['collab','--fake-provider','--arm',arm,'--root',dir]);
  const report=load(dir+'/report.json'),facts=load(dir+'/facts.json');
  assert.equal(report.status,'passed',arm+': '+(report.error?.code??''));
  assert.equal(report.realProviderRequests,0,arm+': no provider request may leave an offline run');
  assert(report.cleanup&&report.ports.every(p=>p.closed),arm+': the run must own and release its ports');
  assert.equal(report.metrics.passed,true,arm+': every assertion of the summary must hold');
  assert.equal(report.arm,arm,'the report must name the arm it ran');
  // A collaboration turn reads, writes and runs commands, so the per-turn ceiling is the stage's own value and the loop
  // detector is what ends a runaway turn. Both are reported so a real run can be read against them.
  assert.equal(report.turnRequestLimit,80,arm+': the collab stage must be allowed a real working turn');
  assert.equal(report.repeatedToolCallLimit,6,arm+': the loop detector must be armed');
  assert.deepEqual(report.loops,[],arm+': the offline workload never repeats itself');
  // The security block runs at the start of the stage, so all four probes are measured on both arms regardless of how
  // far the workload gets. A control that is only measured when the run finishes cannot be compared between arms.
  assert(facts.security.length>=4,arm+': four security probes, got '+facts.security.length);
  assert(facts.security.every(row=>row.rejected===true),arm+': every probe must be refused');
  // The truncation surface is reported on both arms and is empty here: the scripted provider never cuts a step. A
  // member writing a large file is the case the third real run lost whole turns to, so the two numbers are checked
  // rather than trusted -- and every turn states what ended it, read from the native journal.
  assert.equal(report.metrics.truncatedResponses.count,0,arm+': the offline provider truncates nothing');
  assert.equal(report.metrics.turnEndedOnTruncation.count,0,arm+': no turn may end on a truncated response');
  assert.equal(report.metrics.assertions.noSilentTruncation,true,arm+': the truncation assertion must hold on a clean run');
  assert(facts.turns.length>0&&facts.turns.every(t=>t.endedOnTruncation===false),arm+': every turn states whether it was truncated');
  assert(facts.turns.every(t=>t.turnFinish==='completed'),arm+': every offline turn ends completed, not max-tokens');
  arms[arm]={report,facts};
}

// 4. The treatment: what the on arm proves about each mechanism.
{
  const {report,facts}=arms.on,m=facts.collab.metrics,fm=m;
  assert.equal(report.metrics.assertions.collabTools,true);
  assert.equal(report.metrics.assertions.collabGate,true);
  assert.equal(report.metrics.assertions.collabAssumption,true);
  assert.equal(report.metrics.assertions.collabDecisions,true);
  assert.equal(report.metrics.assertions.collabMetrics,true);
  // The tool list is the arm, not the workload.
  for(const actor of ['be','fe','qa','root'])
    assert(facts.collab.catalog[actor].tools.includes('team_assume')&&facts.collab.catalog[actor].tools.includes('team_decision'),actor
      +' must have both collaboration tools');
  assert.equal(facts.collab.catalog.verifier.tools.includes('team_assume'),false,'the independent verifier raises no assumption');
  assert(Object.values(facts.collab.catalog).every(row=>row.intentKind===true),'the intent kind is published on every arm-on member');
  // The gate: a write refused, then the intent that answers it, per executor.
  const denials=facts.guardDenials??[],intents=facts.toolActions.filter(t=>t.name==='team_message'&&t.args?.kind==='intent');
  for(const actor of ['be','fe','qa'])
    assert(denials.some(d=>d.actor===actor&&d.name==='write'&&String(d.reason).startsWith('INTENT_REQUIRED')),actor+' must be refused before its intent');
  assert.equal(intents.length>=3,true,'every executor must have sent an intent');
  // Silence is consent (host-protocol 4.2 rule 6): by the end of the run every window has a conclusion, none escalated
  // to the operator, and every recipient of every window has a frozen per-recipient seenAtClose fact. These are read
  // from the closed rows, so a window that merely stopped being displayed cannot pass them.
  {
    const c=fm.intentConclusions;
    assert(c&&c.sent>=3,'the conclusions are computed from committed intent rows');
    assert.equal(c.open,0,'every window closed by the end of the stage');
    assert.equal(c.passed+c.objected,c.sent,'a conclusion is passed or objected, never pending');
    assert(c.passed>=3,'silence passed the executors: '+JSON.stringify(c));
    assert.equal(c.escalated,0,'an intent is never escalated to the operator');
    assert.equal(c.seenAll+c.seenPartial+c.seenNone,c.sent,'seen is summarised per window from seenAtClose');
    assert.equal(c.recipientsRecorded,true,'every recipient has a frozen seenAtClose entry, even when it never saw it');
    assert((facts.messages??[]).filter(m=>m.kind==='intent').every(m=>m.status!=='escalated'),
      'the run teardown must not turn a decided intent into an escalation');
  }
  // Mechanism 2: raised, delivered, answered before the first integration, and no longer open.
  assert.equal(fm.assumptionsRaised,1);
  assert.equal(fm.assumptionsConfirmedBeforeIntegration,1);
  assert.equal(fm.assumptionsUnconfirmed.length,0,'the acceptance data carries no unanswered assumption');
  // Mechanism 3: the ledger reaches the snapshot of a dependency peer, inside the unchanged budget.
  assert.equal(m.proactive.decisions>=3,true,'the change round logs a decision per affected member');
  assert((facts.collabSnapshots??[]).some(row=>row.decisions>0),'a snapshot must carry a teammate decision');
  assert(facts.requests.filter(r=>r.snapshotTokens>0).every(r=>r.snapshotTokens<=4096),'the 4096-byte ceiling is unchanged');
  // The metrics themselves.
  for(const key of ['proactiveRatio','reworkRate','hiddenTestPass','tokenCost','wallClock'])
    assert(Number.isFinite(fm[key]),key+' must be computed');
  assert.deepEqual(Object.keys(fm.changePropagationLatency).sort(),['be','fe','qa']);
  assert(Object.values(fm.changePropagationLatency).every(row=>row&&Number.isFinite(row.ms)),'every affected member reacts to the change');
  assert.equal(fm.hiddenTestPass,1,'the hidden set passes after the change is propagated');
  // The cycle itself: the report's own assertions, not only the stage's summary.
  assert.equal(report.metrics.assertions.collabDelivery,true,'a deliverable reached the integration');
  assert.equal(report.metrics.assertions.collabCycle,true,'every delivery was submitted, verified and the hidden set passed');
  assert.equal(report.completedCycles,1,'a cycle of produce -> verify -> integrate actually finished');
  // Cost: every dispatched request carries the provider's own counters, and an unreported price stays null instead of a
  // zero that would read as "free". The totals are the sum of the rows, so no number in the report is invented.
  {
    const cost=report.metrics.cost,rows=cost.perRequest;
    assert.equal(rows.length,report.providerRequests,'one cost row per dispatched request');
    assert(rows.every(r=>Number.isInteger(r.input)&&Number.isInteger(r.output)),'input/output per request');
    assert(rows.every(r=>Number.isInteger(r.cacheHit)&&Number.isInteger(r.cacheMiss)&&r.cacheHit+r.cacheMiss===r.input),
      'cacheHit + cacheMiss account for the input of every request');
    for(const key of ['input','output','cacheHit','cacheMiss'])assert.equal(cost.totals[key],rows.reduce((n,r)=>n+r[key],0),key+' total is the column sum');
    assert(Object.keys(cost.byActor).sort().join(',')===('be,fe,qa,root,verifier'),'per-arm totals are grouped by actor: '+Object.keys(cost.byActor));
  }
  assert.equal(m.integrationFailures,1,'the injected requirement change is a real failure before propagation: '+JSON.stringify(m.integration));
  // The stop clock is part of the record now: which window the stage measured, what moved it last, and how many
  // signals it saw. A run that ended is judged against those numbers instead of against its wall clock.
  assert.equal(facts.stop.progressWindowMs,policy.collabNoProgressMs,'the collab stage is judged on its own progress window');
  assert.equal(facts.progress.windowMs,policy.collabNoProgressMs);
  assert(facts.progress.count>=5,'rounds, integrations, turns, produces and verifies all signal: '+facts.progress.count);
  assert(['stage:start','turn:root','round:build','integration:build','produce:be','verify:verifier']
    .every(source=>facts.progress.bySource[source]>0),'every source the stage claims must appear: '+JSON.stringify(facts.progress.bySource));
  console.log('collab on arm PASS: gate, assumption, decisions, metrics');
}

// 5. The control: the off arm is the system that already existed.
{
  const {report,facts}=arms.off,m=facts.collab.metrics,fm=m;
  assert.equal(report.metrics.assertions.collabControl,true);
  assert.equal(report.metrics.assertions.collabMetrics,true);
  assert(Object.values(facts.collab.catalog).every(row=>!row.tools.includes('team_assume')&&!row.tools.includes('team_decision')),
    'no collaboration tool is published when off');
  assert(Object.values(facts.collab.catalog).every(row=>row.intentKind===false),'the intent kind is not published when off');
  assert.equal((facts.guardDenials??[]).some(d=>String(d.reason).startsWith('INTENT_REQUIRED')),false,'nothing is refused for a missing intent when off');
  assert.equal((facts.collabSnapshots??[]).length,0,'the snapshot carries no collaboration block when off');
  assert.equal(fm.proactive.intents,0);assert.equal(fm.proactive.decisions,0);assert.equal(fm.assumptionsRaised,0);
  assert.equal(fm.intentConclusions.sent,0,'the control arm opens no window');
  // The workload itself is identical: the same integration outcomes and the same hidden-set verdict.
  assert.deepEqual(m.integration.map(row=>row.label+':'+row.pass+'/'+row.total),arms.on.facts.collab.metrics.integration.map(row=>row.label+':'+row.pass+'/'+row
      .total),'both arms build and fix the same application');
  assert.equal(fm.hiddenTestPass,1);
  console.log('collab off arm PASS: control surface unchanged, same workload');
}

// 6. The two behaviours the fourth real run asked for, as negatives on facts rather than as hopes in a live run.
//    One: a stage that returns right after its first integration must still report the cycle it finished. The record is
//    written at the integration, so an exit during the change round has nothing left to erase.
//    Two: a team that keeps producing signals is never read as stalled. The window is measured from the newest signal,
//    and the stage's own ceiling is the only clock that can still end such a run -- with its own code.
{
  const negatives=[];
  const dir=root+'/negatives';
  for(const actor of ['be','fe','qa']){
    const file=path.join(dir,'ws',actor,deliverablePath[actor]);
    fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'fixture artifact');
  }
  const rows={
    'task:':['be','fe','qa'].map(actor=>({entityId:'task:collab:'+actor,owner:'member:'+actor,status:'produced'})),
    'verification-evidence:':['be','fe','qa'].map(actor=>({entityId:'verification-evidence:'+actor,
      deliveryRef:deliveryRefOf(actor),status:'evidence-only'})),
  };
  const engine={root:dir,facts:{collab:{}},core:{store:{list:prefix=>rows[prefix]??[],read:()=>null}}};
  assert.equal(deliveryState(engine).completedCycles,1,'the fixture state is one completed cycle');
  const integration={label:'build',pass:3,fail:1,total:4,copied:[{},{},{}],missing:[],relocated:[]};
  writeDelivery(engine,integration);
  assert.equal(engine.facts.completedCycles,1,'the cycle is recorded at its integration, not after the change round');
  assert.equal(engine.facts.collab.delivery.completedCycles,1);
  assert.deepEqual(engine.facts.collab.delivery.hidden,{pass:3,fail:1,total:4,copied:3,missing:[],relocated:[]},
    'the hidden-set outcome travels with the cycle it belongs to');
  // The run stops here. Nothing else is written, and the record must not decay to zero on its own.
  assert.equal(engine.facts.collab.delivery.completedCycles,1,'an early exit does not turn a finished cycle into zero');
  assert.equal(engine.facts.completedCycles,1);
  // A later round that delivered nothing cannot lower it either: completedCycles never decreases inside a run.
  for(const key of Object.keys(rows))rows[key]=[];
  writeDelivery(engine,{label:'change',pass:0,fail:4,total:4,copied:[],missing:['server.mjs'],relocated:[]});
  assert.equal(engine.facts.completedCycles,1,'a second round with nothing delivered keeps the first cycle standing');
  assert.equal(engine.facts.collab.delivery.firstIntegration!==null,true,'the pre-change integration is still readable');
  assert.equal(engine.facts.collab.delivery.hidden.fail,4,'the newest round is what the hidden field reports');


  // The progress clock is the engine's own signal, not a scripted number, so it is exercised through engine.progress().
  assert.equal(progressWindowMs('collab'),policy.collabNoProgressMs);
  const live=new Engine(dir,{stage:'collab',requests:[],turns:[]},'fake',{stage:'collab'});
  // A virtual clock: one signal per window, read one millisecond before the window would expire. The engine's own
  // progress() supplies the signal, so the two halves being joined here are the real ones.
  const started=Date.now(),seen=[];
  for(let i=1;i<=60;i++){
    live.progress('turn:be');
    const signal=started+i*policy.collabNoProgressMs;
    seen.push(stopReason({stage:'collab',started,lastProgress:signal,now:signal+policy.collabNoProgressMs-1}));
  }
  assert.equal(seen.includes('NO_PROGRESS_STOP'),false,'a team that keeps signalling is never cut off for silence');
  // Five hours of unbroken progress: the ceiling ends such a run, and it says so with its own code rather than
  // borrowing the stall's.
  assert.equal(stopReason({stage:'collab',started,lastProgress:started+policy.collabDurationMs-1,now:started+policy.collabDurationMs}),
    'STAGE_TIME_LIMIT','the stage ceiling is the clock that ends a healthy long run');
  assert.equal(live.facts.progress.bySource['turn:be'],60,'every signal is counted with its source');
  assert.equal(live.facts.progress.last.source,'turn:be');

  negatives.push('delivery record: first integration survives an early exit','progress clock: continuous signals, never NO_PROGRESS_STOP');
  fs.writeFileSync(dir+'/report.json',JSON.stringify({status:'passed',checks:negatives},null,2));
  console.log('collab negatives PASS: delivery written at integration, progress window measured from the newest signal');
}

// 7. Every judge must be able to fail: each fact is mutated and its assertion re-evaluated.
{
  const mutations=[];
  const mutate=(arm,name,change,assertion)=>{
    const facts=structuredClone(arms[arm].facts);change(facts);
    const summary=summarize(facts);
    assert.equal(summary.assertions[assertion],false,arm+': '+name+' did not fail '+assertion);
    assert.equal(summary.passed,false,arm+': '+name+' must fail the run');
    mutations.push({arm,name,assertion});
  };
  mutate('on','intent recorded without the refusal before it',x=>{x.guardDenials=(x.guardDenials??[]).filter(d=>!String(d.reason).startsWith('INTENT_REQUIRED'))
      },'collabGate');
  mutate('on','intent recorded before the refusal that demanded it',x=>{for(const t of x.toolActions.filter(t=>t.name==='team_message'&&t
          .args?.kind==='intent'))t.at=0},'collabGate');
  // The assumption and decision verdicts are read from the committed ledgers the stage records as facts, so that is
  // what a mutation has to break: nudging the completed stage's summary number would leave the assertion green.
  mutate('on','assumption left open',x=>{x.collab.assumptions=(x.collab.assumptions??[]).map(r=>({...r,status:'open',answeredAt:null}))},'collabAssumption');
  mutate('on','assumption answered only after the integration',x=>{const at=x.collab.injectedAt??Date.now();
    x.collab.assumptions=(x.collab.assumptions??[]).map(r=>({...r,answeredAt:at+1}))},'collabAssumption');
  mutate('on','assumption never raised',x=>{x.collab.assumptions=[];x.collab.metrics.assumptionsRaised=0},'collabAssumption');
  mutate('on','decision ledger never reaches a snapshot',x=>{x.collabSnapshots=(x.collabSnapshots??[]).map(r=>({...r,decisions:0}))},'collabDecisions');
  mutate('on','decision logged but none delivered',x=>{x.collab.decisions=[];x.collab.metrics.proactive.decisions=0},'collabDecisions');
  // Round 2's first defect: a stage that returned with nothing delivered was reported as passed. The facts below are the
  // second real run's shape -- no task submitted, no file at the published path, the hidden set failing 4 of 4 -- and the
  // run must not pass on them. The two assertions are separated too: submitting without the file fails the delivery
  // line, a file written but never submitted or verified fails the cycle line, and neither can borrow the other's verdict.
  const emptyState=delivery=>({...delivery,tasks:0,produced:0,submitted:0,verified:0,accepted:0,evidence:0,
    files:Object.fromEntries(Object.entries(delivery?.files??{}).map(([key,row])=>[key,{...row,present:false,bytes:0}])),
    filesPresent:0,completedCycles:0,missing:['server.mjs','index.html','e2e.test.mjs'],
    hidden:{pass:0,fail:4,total:4,copied:0,missing:['server.mjs','index.html','e2e.test.mjs'],relocated:[]}});
  // The state before the change round is recorded separately, so a mutation of "nothing was ever delivered" has to empty
  // both: emptying only the final state would leave the build round standing behind the assertion.
  const nothingDelivered=x=>{const empty=emptyState(x.collab.delivery);
    x.collab.delivery={...empty,firstHidden:{...empty.hidden},firstIntegration:{...emptyState(x.collab.delivery.firstIntegration),
      hidden:{pass:0,fail:4,total:4,copied:0,missing:['server.mjs','index.html','e2e.test.mjs'],relocated:[]}}};
    x.completedCycles=0};
  mutate('off','the second real run delivered nothing',nothingDelivered,'collabDelivery');
  mutate('off','the second real run delivered nothing',nothingDelivered,'collabCycle');
  // The delivery line is judged on the state captured before the change round, so the mutation reaches that state too:
  // a file on disk that nobody ever submitted is not a delivery, whichever round it was written in.
  const nothingSubmitted=x=>{const none={...x.collab.delivery,produced:0,submitted:0,verified:0,completedCycles:0};
    x.collab.delivery={...none,firstIntegration:{...none,firstIntegration:null,hidden:none.hidden}};x.completedCycles=0};
  mutate('on','a file written but never submitted',nothingSubmitted,'collabDelivery');
  mutate('on','a delivery submitted but never verified',x=>{x.collab.delivery={...x.collab.delivery,verified:0,completedCycles:0};x.completedCycles=0},
    'collabCycle');
  mutate('on','collaboration tools published to the verifier',x=>{x.collab.catalog.verifier.tools.push('team_assume')},'collabTools');
  mutate('on','intent kind hidden from the members',x=>{for(const row of Object.values(x.collab.catalog))row.intentKind=false},'collabTools');
  mutate('on','a metric that was never computed',x=>{x.collab.metrics.wallClock=null},'collabMetrics');
  // The intent conclusions are judged from the closed rows, so the mutation changes what those rows say.
  mutate('on','an intent still open at the end of the run',x=>{x.collab.metrics.intentConclusions.open=1},'collabIntentConclusions');
  mutate('on','an intent escalated instead of passing',x=>{const c=x.collab.metrics.intentConclusions;
    c.escalated=1;c.passed-=1;c.sent=c.passed+c.objected+c.open},'collabIntentConclusions');
  mutate('on','a recipient with no frozen seenAtClose fact',x=>{x.collab.metrics.intentConclusions.recipientsRecorded=false},'collabIntentConclusions');
  mutate('on','a window whose seen counts do not add up',x=>{const c=x.collab.metrics.intentConclusions;
    c.seenAll=c.sent+1},'collabIntentConclusions');
  // The row audit is computed from the closed rows; these two prove the assertion reads it (the calculation itself is
  // unit-tested in packages/core/test/collab-protocol.test.mjs).
  mutate('on','a seen flag the summary does not reflect',x=>{x.collab.metrics.intentConclusions.rowsConsistent=false},'collabIntentConclusions');
  mutate('on','a passedUnseen count the flags do not support',x=>{x.collab.metrics.intentConclusions.passedUnseenConsistent=false},'collabIntentConclusions');
  mutate('off','collaboration tool leaked into the control arm',x=>{x.collab.catalog.be.tools.push('team_decision')},'collabControl');
  mutate('off','intent kind leaked into the control arm',x=>{x.collab.catalog.be.intentKind=true},'collabControl');
  mutate('off','control arm refused for a missing intent',x=>{(x.collab.metrics.guardRefusals??=[]).push({actor:'be',name:'write',reason:'INTENT_REQUIRED'})},
    'collabControl');
  mutate('off','control arm snapshot gained a collaboration block',x=>{(x.collabSnapshots??=[]).push({actor:'be',decisions:1,decisionOmitted:0,gateOpen:true,
          assumptionsOpen:0})},'collabControl');
  // A probe that never ran is not a passed probe, and an early exit must not borrow a finished run's verdict.
  {
    mutate('on','security probe never ran',x=>{x.security=[]},'security');
    const early=structuredClone(arms.on.facts);
    early.stop={code:'NATIVE_TURN_REQUEST_LIMIT'};
    const em=summarize(early);
    assert.equal(em.assertions.turnLimitHonest,false,'the ceiling exit must fail its own line');
    assert.equal(em.assertions.security,true,'the four probes ran before the first turn, so they survive an early exit');
    // What the run did exercise keeps its verdict even on an early exit: the members were refused the native call before
    // their intent and sent it afterwards, the assumption was answered, a snapshot carried the decision. A mechanism
    // that happened is judged on its facts; only the one that never happened is reported as not-exercised.
    assert.equal(em.assertions.collabGate,true,'the gate premise did happen, so the exit does not soften the verdict');
    assert.equal(em.assertions.collabAssumption,true,'an exercised mechanism is not excused by the exit');
    assert.equal(em.assertions.collabDecisions,true);
    assert.equal(em.passed,false,'the exit itself still fails the run on turnLimitHonest');
    assert.equal(em.assertions.turnLimitHonest,false);
    // With nothing refused, nothing raised and no peer snapshot, each is reported with the exit that cut it off.
    const nothing=structuredClone(early);
    nothing.guardDenials=[];nothing.toolActions=[];nothing.collabSnapshots=[];
    // The stage records both ledgers as facts, so a run that never raised an assumption or logged a decision has to
    // clear those too: emptying the summary number alone would leave a committed row standing behind the assertion.
    nothing.collab={...nothing.collab,assumptions:[],decisions:[],
      metrics:{...nothing.collab.metrics,assumptionsRaised:0,guardRefusals:[],proactive:{...nothing.collab.metrics.proactive,decisions:0}}};
    const nm=summarize(nothing);
    for(const key of ['collabGate','collabAssumption','collabDecisions']){
      assert.equal(typeof nm.assertions[key],'string',key+' must report not-exercised rather than pass or blame the arm');
      assert.match(nm.assertions[key],/NATIVE_TURN_REQUEST_LIMIT/,'the reason names the exit: '+key);
    }
    assert.equal(nm.passed,false);
    // The same facts without the early exit keep their verdicts: the excuse is the exit, not the mechanism.
    const finished=structuredClone(arms.on.facts);
    assert.equal(summarize(finished).assertions.collabGate,true);
    // A loop is the same shape of early exit: the turn stops, the stage never reaches the step, and the defect is
    // charged to the loop's own line. What must not happen is a mechanism verdict borrowed from a run that finished.
    const looped=structuredClone(nothing);looped.stop={code:loopCode};
    const lm=summarize(looped);
    assert.equal(typeof lm.assertions.collabAssumption,'string','an unexercised mechanism stays unexercised under a loop');
    assert.match(lm.assertions.collabAssumption,new RegExp(loopCode),'the loop names itself as the exit');
    assert.equal(lm.assertions.turnLimitHonest,false,'the loop is charged on its own line');
    mutations.push({arm:'on',name:'early exit excused instead of blamed',assertion:'turnLimitHonest/collabGate'});
  }
  // Every mutation must be about an assertion this stage judges: its own three mechanisms and control surface, plus
  // the two safety nets whose early exit would otherwise be able to masquerade as a mechanism verdict.
  for(const entry of mutations)assert(entry.assertion.startsWith('collab')||['security','turnLimitHonest'].some(k=>entry.assertion.includes(k)),
    entry.assertion);
  fs.writeFileSync(root+'/mutations.json',JSON.stringify(mutations,null,2));
  console.log('collab negative PASS: '+mutations.length+' fact mutations, each failing its own assertion');
}

const summary={status:'passed',realProviderRequests:0,contract:contract.checks,snapshotDelta:load(root+'/snapshot-delta/report.json'),
  arms:Object.fromEntries(['off','on'].map(arm=>[arm,{status:arms[arm].report.status,assertions:Object.fromEntries(Object.entries(arms[arm].report.metrics
              .assertions).filter(([k])=>k.startsWith('collab'))),metrics:arms[arm].facts.collab.metrics,
    wallClock:arms[arm].facts.collab.metrics.wallClock,tokenCost:arms[arm].facts.collab.metrics.tokenCost}])),
  mutations:load(root+'/mutations.json')};
fs.writeFileSync(root+'/summary.json',JSON.stringify(summary,null,2));
console.log('PASS: collaboration stage offline, both arms, contract + negative fact mutations; zero provider requests');