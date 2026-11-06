import {protocolMetrics,GUARDS,guardCodes,protocolCodes} from './protocol-metrics.mjs';
import {loopCode} from './loop-guard.mjs';
import {slotWaitWithin} from './concurrency.mjs';
import {performanceGate} from './performance.mjs';
import { clockStopCodes, quantile, slope, concurrencyGateHonest, columnSum, costTotals, groupCost } from './metrics-helpers.mjs';
import { attachCollabAssertions } from './metrics-collab.mjs';
export { clockStopCodes, quantile, slope, concurrencyGateHonest } from './metrics-helpers.mjs';

export function summarize(f) {
  const requests=[...f.requests].sort((a,b)=>(a.id??0)-(b.id??0)),root=requests.filter(x=>x.actor==='root');
  const actions=f.messages.filter(m=>m.kind==='action'&&m.visible&&m.available&&m.authorized);
  const accepted=actions.filter(m=>m.acceptBoundary!=null&&m.acceptBoundary>=m.visibleBoundary&&m.acceptBoundary-m.visibleBoundary<=2);
  const stored=f.messages.filter(m=>m.kind==='action'),rate=actions.length?accepted.length/actions.length:null;
  const terminal=m=>m.accepted||['resolved','cancelled','escalated'].includes(m.status);
  const inDeadline=m=>terminal(m)&&Number.isFinite(Date.parse(m.deadline))&&Number.isFinite(m.acceptedAt??m.terminalAt)&&(m.acceptedAt??m.terminalAt)<=Date
  .parse(m.deadline);
  // Peer messages: written by a model, from one member to a different member.
  //
  // The earlier rule hard-coded the release topology's ids (member:a1/a2/b1/b2 and the group letter at offset 7), which
  // cannot match the collaboration topology's member:be/fe/qa/verifier: the treatment arm therefore reported zero peer
  // messages while its own tool actions recorded eight model-sent intents between members. Plan 11 §3 treats root as a
  // member of the same team (members address it with intents and it addresses them), so the identity of a peer message
  // is "two distinct members, and the model wrote it" -- a message the driver sent (the stage's delegation) has no
  // team_message tool action behind its resultRef and is therefore not counted as peer traffic.
  const memberId=id=>/^member:[A-Za-z0-9:._-]+$/.test(String(id))?String(id):null;
  const modelSent=new Set(f.toolActions.filter(t=>t.source==='native-model-tool'&&t.name==='team_message'&&t.resultRef).map(t=>t.resultRef));
  const peers=f.messages.filter(m=>memberId(m.sender)&&memberId(m.recipient)&&m.sender!==m.recipient&&modelSent.has(m.id));
  const rawLatency={...f.latency,
    storedToBoundary:f.messages.filter(m=>m.visibleAt!=null).map(m=>m.visibleAt-m.storedAt),
    producedToVerified:f.deliveries.filter(d=>d.verifiedAt!=null).map(d=>d.verifiedAt-d.producedAt),
    verifiedToMerged:f.deliveries.filter(d=>d.mergedAt!=null).map(d=>d.mergedAt-d.verifiedAt),
    mergedToAccepted:f.deliveries.filter(d=>d.acceptedAt!=null).map(d=>d.acceptedAt-d.mergedAt)};
  const latency=Object.fromEntries(['readyToAdmitted','admittedToRouteReady','admittedToFirstRequest','firstRequestToCheckpoint','producedToVerified',
      'verifiedToMerged','mergedToAccepted','storedToBoundary','transport'].map(k=>{
    const raw=rawLatency[k]??[];return[k,{raw,p50:quantile(raw,.5),p90:quantile(raw,.9),exclusions:[]}];
  }));
  // Mailbox latency split, not filtered. "slotWaitMs" is the part of stored->boundary spent queued for a
  // member/global request slot; both columns keep every sample, including slow ones; 08 §9.
  const visibleMessages=f.messages.filter(m=>m.visibleAt!=null),slotWaits=f.slotWaits??[];
  const slots=visibleMessages.map(m=>({messageId:m.id,recipient:m.recipient,storedAt:m.storedAt,visibleAt:m.visibleAt,
    totalMs:m.visibleAt-m.storedAt,slotWaitMs:slotWaitWithin(slotWaits,m.recipient,m.storedAt,m.visibleAt)}));
  const slotColumn=slots.map(s=>s.slotWaitMs),requestColumn=slots.map(s=>s.totalMs-s.slotWaitMs);
  latency.storedToBoundary.slots=slots;
  latency.storedToBoundary.split={
    note:'storedToBoundary = slotWaitMs (waited for a member/global request slot) + requestServiceMs; both columns retain every sample and neither replaces ' +
      'the raw distribution.',
    slotWaitMs:{raw:slotColumn,p50:quantile(slotColumn,.5),p90:quantile(slotColumn,.9)},
    requestServiceMs:{raw:requestColumn,p50:quantile(requestColumn,.5),p90:quantile(requestColumn,.9)}};
  latency.slotWait={raw:slotWaits.map(w=>w.waitMs),p50:quantile(slotWaits.map(w=>w.waitMs),.5),
    p90:quantile(slotWaits.map(w=>w.waitMs),.9),exclusions:[],samples:slotWaits.length};
  // Preemption is measured, never inferred from timing: the counters come from the watcher that asked for the
  // preemption and from the driver's own honesty counters, so a step that was cut short stays visible next to the
  // request it made necessary. A build without the feature reports zeroes instead of omitting the surface.
  const preemptRaw=f.preempt??{};
  // coalesced = folded into a request that already existed (inside the 2s window); notLive = no live step could
  // take it (idle member, step ending), which stays queued. Mixing them would make an idle run look like merging.
  const preempt={asked:preemptRaw.asked??0,count:preemptRaw.count??0,coalesced:preemptRaw.coalesced??0,notLive:preemptRaw.notLive??0,woke:preemptRaw.woke??0,
    refused:{frozen:0,notActive:0,budget:0,notMemberMessage:0,notMember:0,...preemptRaw.refused??{}},
    discardedPartialItems:preemptRaw.discardedPartialItems??0,
    extraRequests:preemptRaw.extraRequests??0,
    extraInputTokens:preemptRaw.extraInputTokens??0,extraOutputTokens:preemptRaw.extraOutputTokens??0,
    // The two names the review asked for, kept as derived fields so they can never disagree with the counters.
    extraRequestsFromPreempt:preemptRaw.extraRequests??0,
    extraTokensFromPreempt:(preemptRaw.extraInputTokens??0)+(preemptRaw.extraOutputTokens??0),
    costRatioNote:'1:50 cache:output'};
  preempt.refusedTotal=Object.values(preempt.refused).reduce((n,x)=>n+x,0);
  const previousRaw=new Set();let opaqueUnchanged=true;
  for(const r of requests){if((r.reasoningHashes??[]).some(h=>!previousRaw.has(h)))opaqueUnchanged=false;if(!r.superseded)for(const h of r.outputReasoningHashes
      ??[])previousRaw.add(h);
    }
  const reasoning=requests.filter(r=>r.reasoningItems>0),pairs=requests.filter(r=>r.toolPairs>0),snapshots=requests.filter(r=>r.snapshotTokens>0);
  const acceptance=rows=>({status:!rows.length?'not-exercised':rows.every(r=>r.accepted)?'accepted':'rejected',accepted:rows.length?rows.every(r=>r
        .accepted):null,requests:rows.map(r=>r.id),rawErrors:rows.filter(r=>!r.accepted).map(r=>({requestId:r.id,httpStatus:r.httpStatus,rawError:
          r.rawError}))});
  const foldRows=requests.filter(r=>r.foldSourceEventSeqs?.length),coldRows=requests.filter(r=>r.purpose==='cold-probe');
  const compatibility={
    structuredSnapshot:{...acceptance(snapshots),revisions:snapshots.filter(r=>r.manifestHash).map(r=>({requestId:r.id,revision:r.snapshotRevision,hash:r
            .manifestHash,payloadHash:r.snapshotPayloadHash}))},
    toolPairs:acceptance(pairs),reasoning:{...acceptance(reasoning),opaqueHashesUnchanged:reasoning.length?opaqueUnchanged:null},
    nativeFold:{...acceptance(foldRows),evidence:f.folds},cold:{...acceptance(coldRows),evidence:f.cold},
    errors:requests.filter(r=>!r.accepted).map(r=>({requestId:r.id,httpStatus:r.httpStatus,rawError:r.rawError}))};
  if(reasoning.length&&!opaqueUnchanged){compatibility.reasoning.accepted=false;compatibility.reasoning.status='rejected';}
  const sequence=root.map(r=>({id:r.id,nativeSessionId:r.nativeSessionId,nativeSeq:r.nativeSeq,mode:r.mode,purpose:r.purpose,inputTokens:r.usage?.input??null,
        outputTokens:r.usage?.output??null,snapshotTokens:r.snapshotTokens??null,snapshotTokenMethod:r.snapshotTokenMethod??null,oldSnapshotTokens:
        r.oldSnapshotTokens
        ??null,requestBytes:r.requestBytes,cacheHit:r.usage?.cacheHit??null,cacheMiss:r.usage?.cacheMiss??null}));
  // How the pre-request estimate was produced. A run whose requests are all full-byte estimates is paying the ~3x
  // over-estimate of every prompt, which is what pushed the 75% ceiling to a ~717 KB prompt; the delta count shows
  // how often a member could reuse the input the provider already reported.
  const estimateRows=requests.filter(r=>r.estimateMethod);
  const contextEstimate={methods:Object.fromEntries(['prefix-delta','full-bytes'].map(method=>[method,estimateRows.filter(r=>r.estimateMethod===method)
          .length])),
    largestEstimate:estimateRows.reduce((best,r)=>!best||r.inputUpperBound>best.inputUpperBound?{requestId:r.id,estimate:r.inputUpperBound,bytes:r.requestBytes,
        reportedInput:r.usage?.input??null,method:r.estimateMethod}:best,null),
    note:'prefix-delta = last reported input for the same actor/session + UTF-8 bytes of the items appended to it; full-bytes = whole serialized body. Both ' +
      'are upper bounds; the pre-request gate reads this estimate alone (it is not added to the output cap any more), the reservation adds the cap this ' +
      'request actually asks for, and the post-response gate still reads the reported input.'
      };
  // Smoke/replay now fold a1, the live attempt that can accept a responsibility. Compare the two actual replay
  // samples from that same session, never root's unrelated requests or samples from different sessions.
  const replayStage=['smoke','p2-replay'].includes(f.stage), foldActor=f.replay?.actor??'root', foldSession=f.replay?.nativeSessionId??null;
  const foldSequence=replayStage?requests.filter(r=>r.actor===foldActor&&r.purpose==='replay'&&(!foldSession||r.nativeSessionId===foldSession)).map(r=>({mode:r
        .mode,inputTokens:r.usage?.input??null})):sequence;
  const context={sequence,estimate:contextEstimate,foldSource:{actor:replayStage?foldActor:'root',nativeSessionId:foldSession,purpose:replayStage
      ?'replay':'root-context',samples:foldSequence.length},slopeByFold:{off:slope(foldSequence.filter(r=>r.mode==='off')),on:slope(foldSequence.filter(r=>r
          .mode==='on'))},snapshotLimit:4096,contextWindowVerified:false,sessionRotations:f.sessionRotations??[],slopeBySession:Object.fromEntries([...new Set(
          sequence
          .map(r=>r.nativeSessionId))].map(id=>[id,slope(sequence.filter(r=>r.nativeSessionId===id))])),replayOnlySlopeByFold:Object.fromEntries(['off','on']
      .map(mode=>[mode,slope(replayStage?foldSequence.filter(r=>r.mode===mode):sequence.filter(r=>r.mode===mode&&r.purpose==='replay'))]))};
  const costRows=requests.map(r=>({requestId:r.id,actor:r.actor,mode:r.mode??null,purpose:r.purpose??null,
    input:r.usage?.input??null,output:r.usage?.output??null,cacheHit:r.usage?.cacheHit??null,cacheMiss:r.usage?.cacheMiss??null,
    reported:r.usage?.cost??null}));
  const operations=new Map();for(const t of f.toolActions.filter(t=>t.args?.operationId)){const key=t.actor+':'+t.args.operationId;const row=operations.get(key)
    ??{actor:t.actor,operationId:t.args.operationId,requests:[],entities:[]};row.requests.push(t.requestId);if(t.resultRef&&!row.entities.includes(
    t.resultRef))row
    .entities.push(t.resultRef);operations.set(key,row);}const operationRows=[...operations.values()];
  const protocol=protocolMetrics(f,operationRows);
  // Guard refusals are legitimate, so they get their own assertion: each one must end in the progress it
  // demanded or an explicit escalation, and must never be followed by a duplicate effect or dead letter.
  const guardRejectionsHandled=protocol.guardRejections.unresolved===0&&protocol.duplicateEffects.length===0&&
    protocol.deadLetters.length===0;
  // The request gate must never have admitted more than its configured limits, and the budget ledger must never
  // have charged more than it reserved for an in-flight request.
  const gate=f.gate??null,budgetViolations=f.budgetViolations??[];
  // A superseded request may still drain physically while its replacement starts. The live session claim remains
  // bounded per member; actual IO remains globally bounded and the report exposes both peaks and outstanding slots.
  const concurrencyHonest=concurrencyGateHonest(gate,budgetViolations);
  // The per-turn ceiling and the dead-loop detector are the two safety nets that end a turn; neither may fire. The
  // ceiling firing on a productive turn is what the first real collaboration run reported, and a run of identical calls
  // is the loop the detector exists for, so both are read from the run's own exit code rather than inferred.
  const turnLimitHonest=!['NATIVE_TURN_REQUEST_LIMIT',loopCode].includes(f.stop?.code)&&(f.loops??[]).length===0;
  // A JavaScript internal exception in the harness or server is our defect, so it fails on its own line.
  const harnessHandled=protocol.harnessErrors.count===0;
  // A preemption must pay for the extra request it caused, and the extra requests must be attributed to something
  // that actually fired: a counter that claims work never happened is the failure this line detects.
  // A response the provider cut at its output cap is a fact about the run, not an implementation detail: what
  // survived is a fragment. The transport records the provider's own verdict on every request (status "incomplete",
  // incomplete_details.reason "max_output_tokens") and the engine records what ended each turn, so the report states
  // both -- per arm and per actor -- instead of leaving a truncated step to look like a normal end. Every stage is
  // judged on it, not just the collaboration arm: a member that writes a large file is truncated on any stage.
  const truncatedRows=requests.filter(r=>r.truncated===true),allTurns=f.turns??[];
  const truncatedTurns=allTurns.filter(t=>t.endedOnTruncation===true);
  const byCount=(rows,key)=>Object.fromEntries([...new Set(rows.map(r=>String(r[key])))].sort()
    .map(group=>[group,rows.filter(r=>String(r[key])===group).length]));
  const truncatedResponses={count:truncatedRows.length,requests:truncatedRows.map(r=>r.id),
    byActor:byCount(truncatedRows,'actor'),byReason:byCount(truncatedRows,'incompleteReason'),
    // A truncation no turn owns: the request was cut inside no recorded turn window at all (a turn killed by another
    // error before it could finish, or a request made outside a turn). A truncated step in the middle of a turn is
    // attributed to that turn's window, so only the genuinely ownerless ones are listed here; either way `count`
    // counts every truncated response and the assertion fails on all of them.
    unattributed:truncatedRows.filter(r=>!allTurns.some(t=>t.actor===r.actor&&r.at>=t.at&&r.at<=t.at+(t.elapsedMs??0)+5)).map(r=>r.id),
    outputCap:requests.find(r=>Number.isInteger(r.outputCap))?.outputCap??null,
    note:'truncated = the provider answered status "incomplete" with incomplete_details.reason "max_output_tokens" at the requested outputCap; the response ' +
      'is a fragment of the step the model was writing. turnEndedOnTruncation counts the turns whose last response was one of these, i.e. turns the cap ' +
      'ended.'
      };
  const turnEndedOnTruncation={count:truncatedTurns.length,byActor:byCount(truncatedTurns,'actor'),
    turns:truncatedTurns.map(t=>({actor:t.actor,requestId:t.requestId??null,finish:t.turnFinish??null}))};
  const assertions={instantPreemptHonest:preempt.extraRequests<=preempt.count&&preempt.count<=preempt.asked,
    // The one assertion the truncation needs: a turn that ended on a truncated response did not finish what it was
    // asked to do, and calling that a completed turn is exactly the silent failure this line exists to stop. It fails
    // on any truncated response, not only on an unattributed one.
    noSilentTruncation:requests.length>0&&truncatedResponses.count===0&&turnEndedOnTruncation.count===0,toolOutputs:(f.toolOutputErrors??[]).length===0,
    noPermanentDeadLetter:!f.messages.some(m=>m.status==='dead-letter'),noDuplicateEffects:operationRows.every(r=>r.entities.length<=1),nativeToolProtocol:
    protocol
    .passed,guardRejectionsHandled,turnLimitHonest,noHarnessErrors:harnessHandled,concurrencyHonest,provider:requests.length>0&&requests.every(r=>r.accepted),
    hardGate75:requests.length>0&&requests.every(r=>Number.isFinite(r.usage?.input)&&r.usage.input<750000),snapshot4096:snapshots.length>0&&snapshots.every(r=>r
      .snapshotTokens<=4096),
    // The performance stage is a measurement run: it dispatches no root turn and runs no security block, so that
    // assertion would be a verdict about a check the stage never asked for. Every functional stage keeps it.
    ...(f.stage==='performance'?{}:{security:f.security.length>=4&&f.security.every(x=>x.rejected===true)})};
  if(['smoke','p2-replay'].includes(f.stage))Object.assign(assertions,{
    structuredSnapshot:compatibility.structuredSnapshot.accepted===true&&compatibility.structuredSnapshot.revisions.length>0,
    toolPairs:compatibility.toolPairs.accepted===true,reasoning:compatibility.reasoning.accepted===true,
    nativeFold:compatibility.nativeFold.accepted===true&&f.folds.length>0&&f.folds.every(x=>x.records.length>0&&x.oldMasked&&x.latestRetained&&x.records.some(
      r=>
    r
        .acceptedMessageIds.length>0&&r.acceptedMessageNativeSources.some(s=>s.sourceEventSeqs.length>=3&&s.sourceEventSeqs.every(seq=>r.sourceEventSeqs
            .includes(seq))))),
    cold:compatibility.cold.accepted===true&&f.cold.length>0&&f.cold.every(x=>x.equal&&x.hostProcessEqual),
    sameReplaySource:!!f.replay&&f.replay.offSourceHash===f.replay.onSourceHash,
    quality:!!f.replay&&f.replay.offQuality.length>=2&&f.replay.onQuality.length>=2&&[...f.replay.offQuality,...f.replay.onQuality].every(Boolean),
    foldSlopes:context.slopeByFold.off!==null&&context.slopeByFold.on!==null});
  /**
   * A cycle the clock cut short is not a missed obligation. When the soak reaches its hour, the cycle in flight is
   * interrupted wherever it happened to be: its review thread is still collecting at teardown (so the harness
   * escalates it) and some of its deliveries were produced but never verified. Judging those three assertions over
   * that half-cycle failed a clean 60-minute run for the clock, not for the team.
   *
   * Forgiveness is narrow on purpose: only the last cycle may be truncated, and only for TIME_STOP. A truncation
   * anywhere else, or an early exit for an error, a gate or NO_PROGRESS, still fails -- those are defects, and a
   * finished cycle that ends collected, unintegrated or unverified is a missed obligation under any stop reason.
   */
  const truncatedCycleId=Number.isInteger(f.cycleInProgress)?f.cycleInProgress:null;
  const truncatedCycle=truncatedCycleId===null?null:{cycle:truncatedCycleId,stopCode:f.stop?.code??null,
    thread:(f.issues??[]).filter(issue=>(issue.requiredEvidence??[]).some(ref=>String(ref).startsWith('artifact:'+truncatedCycleId+':'))).map(issue=>issue
      .entityId),
    deliveries:f.deliveries.filter(d=>d.cycle===truncatedCycleId).map(d=>({id:d.id,status:d.status}))};
  // In flight means the run ended before this cycle reached its final step, so the cycle number is above everything
  // completed. Anything else is a finished cycle and gets the strict answer.
  // A stage that hit its own 30-minute ceiling is the same clock, so it forgives the same half-cycle; a NO_PROGRESS
  // exit still does not, because silence with a cycle in flight is exactly the defect that code reports.
  const truncatedForgiven=!!truncatedCycle&&clockStopCodes.includes(f.stop?.code)&&truncatedCycleId>f.completedCycles;
  const issueCycle=issue=>{const ref=(issue.requiredEvidence??[])[0];const n=Number(String(ref??'').split(':')[1]);return Number.isInteger(n)?n:null};
  const judgedIssues=(f.issues??[]).filter(issue=>!(truncatedForgiven&&issueCycle(issue)===truncatedCycleId));
  const judgedDeliveries=truncatedForgiven?f.deliveries.filter(d=>d.cycle!==truncatedCycleId):f.deliveries;
  // A decided issue must record one non-late reply per delivery it required, and no required reply may be missing.
  // This is the state the fourth real run never reached: four verified deliveries behind a collecting thread.
  const threadReadiness=judgedIssues.length>0&&judgedIssues.every(issue=>{
    const replies=(issue.replies??[]).filter(reply=>!reply.late);
    const required=issue.requiredEvidence??[];
    const covered=required.filter(ref=>replies.some(reply=>reply.bodyRef===ref));
    const respondents=(issue.requiredRespondents??[]).every(member=>replies.some(reply=>reply.actor===member));
    return issue.status==='decided'&&respondents&&covered.length===required.length&&covered.length===new Set(covered).size&&
      Array.isArray(issue.missing)&&issue.missing.length===0;});
  if(['model-contracts','soak'].includes(f.stage))Object.assign(assertions,{threadReadiness,
    peer:peers.length>0,accept95:rate!==null&&rate>=.95,deadline100:stored.length>0&&stored.every(inDeadline),
    dependencyReleased:judgedDeliveries.length>=8&&judgedDeliveries.every(d=>d.messageId&&d.manifestHash&&d.status==='accepted'),
    independentVerifier:judgedDeliveries.length>0&&judgedDeliveries.every(d=>d.certificate?.verifier==='member:verifier'&&d.verifierRequestId),
    decisions:f.decisions.length>0&&f.decisions.every(d=>d.manifestHash&&d.requestId&&d.verifierRequestId&&d.status==='decided'&&d.decisionAt<=Date.parse(d
        .deadline)),
    admissionTiming:latency.readyToAdmitted.raw.length>0 && (f.timingMissing??[]).filter(x=>x.metric==='readyToAdmitted').length===0,
    requestTiming:latency.firstRequestToCheckpoint.raw.length>=8 && (f.timingMissing??[]).filter(x=>x.metric==='firstRequestToCheckpoint').length===0,
    deliveryTiming:['producedToVerified','verifiedToMerged','mergedToAccepted'].every(k=>latency[k].raw.length>=8)});
  if(f.stage==='soak'){if(f.mode==='fake')assertions.fakePipelineCycles=f.completedCycles>=2;else assertions.duration=f.elapsedMs>=3600000;}
  /**
   * The collaboration experiment's own answer, from the two runs the stage produces.
   *
   * The off arm is the control: it must show no collaboration tool, no collaboration block and no collaboration
   * refusal, because that is the system the experiment is measured against. The on arm must show the guard working
   * (a refused write per executor before its intent), the assumption answered before the first integration, the
   * decision ledger reaching a snapshot, and every metric computable. None of these numbers comes from a transcript.
   */
  attachCollabAssertions(f, assertions);
  // Fake/fault runs are functional evidence only. A requested live study must pass qualification AND thresholds.
  const performance=performanceGate(f.mode==='live'&&!f.fault?f:{...f,performanceStudy:null},latency);
  if(performance.status!=='not-run')assertions.performance=performance.status==='measured'&&performance.passed===true;
  return{providerRequests:requests.length,rootContext:context,peerMessages:peers.length,peerEvidence:peers,
    actionAcceptance:{eligible:actions.length,acceptedWithinTwoBoundaries:accepted.length,rate,stored:stored.length,storedToAccept:stored.length?stored.filter(
      m=>
    m
        .accepted).length/stored.length:null,samples:stored,deadlineViolations:stored.filter(m=>!inDeadline(m))},
    decisionLatency:{raw:f.decisions.map(x=>x.latencyMs),p50:quantile(f.decisions.map(x=>x.latencyMs),.5),p90:quantile(f.decisions.map(x=>x.latencyMs),.9),
      associations:f.decisions},
    latency,preempt,compatibility,toolOutputErrors:f.toolOutputErrors??[],qualityDiagnostics:requests.filter(r=>r.purpose==='replay').map(r=>{const peers=
    requests
        .filter(x=>x.purpose==='replay'&&x.mode===r.mode),index=peers.indexOf(r);return{requestId:r.id,mode:r.mode,index,passed:(
          r.mode==='off'?f.replay?.offQuality:
        f
            .replay?.onQuality)?.[index]??null,toolErrors:r.historyToolErrors??[]}}),replay:f.replay,deliveries:f.deliveries,
    guardRejections:protocol.guardRejections,harnessErrors:protocol.harnessErrors,
    // The interrupted cycle is reported apart, never silently dropped: its thread and deliveries stay visible next to
    // the fact that the clock, not the team, ended it.
    truncatedCycle,truncatedForgiven,truncatedResponses,turnEndedOnTruncation,
    threadReadiness:{passed:threadReadiness,judgedIssues:judgedIssues.length,
      // A thread the harness itself escalated at teardown (the run stopped mid-cycle) and a thread the model left
      // past its deadline are both failures, but they are not the same fact: one says the workload was cut short,
      // the other says the model missed an obligation. Naming the reason here is what lets a reader of the report
      // tell them apart without re-deriving it from timestamps.
      closeEscalations:(f.issues??[]).filter(issue=>issue.status==='escalated'&&/^run closed/.test(String(issue.reason??''))).length,
      issues:(f.issues??[]).map(issue=>({entityId:issue.entityId,status:issue.status,reason:issue.reason??null,
        updatedAt:issue.updatedAt??null,replies:(issue.replies??[]).length,requiredEvidence:(issue.requiredEvidence??[]).length,missing:issue.missing??null}))},
        concurrency:{gate,budgetViolations,policyNote:
          'per-member in-flight limit and global ceiling; slot waiting is reported separately from mailbox latency'},
    protocol:{...protocol,classification:{guard:guardCodes,protocol:protocolCodes,guards:GUARDS,
      note:'guard codes are an explicit allow-list of refusals by design; a JavaScript internal exception is a fixture or host defect and fails outright; ' +
        'any other code, including an unknown one, is a protocol failure'
        },security:f.security,retries:operationRows.reduce((n,r)=>n+r.requests.length-1,0),operationEvidence:operationRows,toolTimings:f.toolActions.map(t=>(
          {actor:
        t
            .actor,name:t.name,op:t.args?.op,elapsedMs:t.elapsedMs,requestId:t.requestId,uninterruptible:t.args?.op==='review'})),freezeIntervals:[],
      freezeEvidence:'No deliberate freeze in this workload; no latency samples excluded.'},
    rootPendingQueue:f.pendingDecisions??[],decisionDeadlineExits:f.issues??[],
    // Per-request usage, then the totals. Every request the transport dispatched carries the provider's own counters, so
    // the report states input/output/cacheHit/cacheMiss per request and the sum of each over the arm; a provider that
    // reports no price leaves reported:null per row instead of a zero that would read as "free".
    cost:{perRequest:costRows,totals:costTotals(costRows),byActor:groupCost(costRows,'actor'),byMode:groupCost(costRows,'mode'),
      reported:costRows.map(row=>row.reported),estimated:null,priceVersion:null,
      note:'input/output/cacheHit/cacheMiss are the provider counters for each dispatched request; reported is the provider price when it sends one (null ' +
        'otherwise), so no price is invented'
        },
    performance,timingMissing:f.timingMissing??[],timingSamples:f.timingSamples??[],
    assertions,passed:Object.values(assertions).every(x=>x===true),mode:f.mode,
    coordinatorPeer:'not applicable: reduced topology has no subCoordinators',secondLayer:
    'closed; this verifier never authorizes production second-layer folding'
      };
}