import { clockStopCodes, notExercised } from './metrics-helpers.mjs';
import { loopCode } from './loop-guard.mjs';

/** The collaboration experiment's assertions, split out of summarize() by responsibility. */
export function attachCollabAssertions(f, assertions) {
  if(f.stage==='collab'){
    const collab=f.collab??{},m=collab.metrics??{},catalog=collab.catalog??{};
    const delivery=collab.delivery??null;
    const hidden=delivery?.hidden??null;
    const arms=Object.values(catalog);
    // Did the workload produce anything, and did it get accepted?
    //
    // The second real run of the treatment arm reached its stage end with the application untouched -- no delivery had
    // ever been submitted, the integration copied nothing, and the hidden set failed 4 of 4 -- and the summary reported
    // a pass, because the only collab assertions were about the mechanisms and no assertion asked whether the team had
    // done the job. A workload that produces no deliverable is not a passed run, whatever the mechanisms did: the arm
    // answers the experiment's question only if both arms built the same application. The stop code is separate and
    // stays separate (a budget stop is an expected end), so a run cut short before it could deliver is not blamed for
    // not delivering; a run that returned with nothing is.
    const cycleCutShort=['BUDGET_STOP_BEFORE_REQUEST',...clockStopCodes,'NO_PROGRESS_STOP','SIGNAL_STOP','NATIVE_TURN_REQUEST_LIMIT',loopCode].includes(f
      .stop?.code);
    // The first cycle is judged on the state captured before the requirement change whenever the stage recorded it: a
    // change round that delivers its own artifacts must not stand in for a build round that delivered nothing.
    const before=delivery?.firstIntegration??delivery;
    // The acceptance set that judges the first cycle is the one the first integration ran; a later round passing its own
    // set cannot make up for a first round whose application did not exist.
    const firstHidden=delivery?.firstHidden??hidden;
    // The first integration is the build round, which the injected requirement change makes fail one check on purpose
    // (integrationFailures is that number). So the delivery line asks that the application existed and ran there: the
    // files were copied and at least one check passed. A build round that copied nothing fails it, a change round that
    // passes its own set cannot rescue it.
    const delivered=(before?.produced??0)>=1&&(before?.filesPresent??0)>=1&&
      (firstHidden?.copied??0)>0&&(firstHidden?.pass??0)>0;
    const allDelivered=delivered&&(delivery?.completedCycles??0)>=1&&(delivery?.verified??0)>=3&&(hidden?.fail??1)===0;
    Object.assign(assertions,{
      // Some deliverable reached the integration and the integrated application passes its own acceptance set.
      collabDelivery:cycleCutShort&&!delivery?notExercised('the stage did not reach its first delivery before the exit at '+f.stop.code)
        :delivered,
      // The full cycle: every executor artifact exists, every delivery is verified, and the hidden set passes. This is the
      // number the experiment compares between arms, so it is an assertion and not a footnote.
      collabCycle:cycleCutShort&&!delivery?notExercised('the stage did not reach a cycle before the exit at '+f.stop.code)
        :allDelivered,
    });
    const tools=arm=>(arm?.tools??[]);
    // Two sources, one meaning: the stage's own summary (written when it completes) and the denials the engine recorded
    // as they happened. A run cut short before the stage could summarise still refused its members, and reading only the
    // summary reported the gate as never fired -- which is a fact about the report, not about the gate.
    // The code is the identity of a refusal; its remedy text follows after a colon and is not part of it.
    const code=reason=>String(reason??'').split(':')[0];
    const refusals=[...(m.guardRefusals??[]).map(r=>({actor:r.actor,name:r.name,reason:code(r.reason)})),
      ...(f.guardDenials??[]).map(r=>({actor:r.actor,name:r.name,reason:code(r.reason)}))];
    const intents=(f.toolActions??[]).filter(t=>t.name==='team_message'&&t.args?.kind==='intent')
      .map(t=>({actor:t.actor,at:t.at}));
    // The native gate covers write, edit and bash, and which one a model reaches for first is its own choice: a
    // member that starts by running a command is refused exactly like one that starts by writing a file.
    const nativeGated=new Set(['write','edit','bash']);
    const gatedExecutors=['be','fe','qa'].filter(actor=>refusals.some(r=>r.actor===actor&&nativeGated.has(r.name)&&r.reason==='INTENT_REQUIRED'));
    // A refusal only proves the gate if the intent that answers it comes afterwards: the same member must speak first
    // and write second, or the arm never exercised the mechanism.
    const ordered=['be','fe','qa'].every(actor=>{
      const denial=(f.guardDenials??[]).filter(d=>d.actor===actor&&String(d.reason).startsWith('INTENT_REQUIRED'))
        .sort((a,b)=>a.at-b.at)[0],intent=intents.filter(i=>i.actor===actor).sort((a,b)=>a.at-b.at)[0];
      return !!denial&&!!intent&&denial.at<=intent.at;});
    // Delivered, not merely logged: a snapshot row must name the peer whose decision it carried, and a decision only
    // reaches a peer snapshot through the dependency graph. Counting rows alone would pass an arm that logged a
    // decision nobody depended on.
    const deliveredDecisions=(f.collabSnapshots??[]).filter(row=>row.decisions>0&&(row.decisionActors??[]).some(actor=>actor&&actor.startsWith('member:')));
    const snapshotHasDecisions=deliveredDecisions.length>0;
    // Both premises below are about a run that got far enough to measure them. A run cut short by its own safety net
    // still reports every assertion honestly, and the report names the exit; what it must not do is borrow the verdict
    // of a run that finished, or hide a real miss behind the excuse.
    // An exit before the stage could compute its numbers. The two safety nets are the harness's own early ends; the
    // budget/clock stops are the run's deliberate ends. Both leave the same hole in the evidence: the mechanisms that
    // need a later step never arose, and the stage never wrote its metrics. The second real run stopped on
    // BUDGET_STOP_BEFORE_REQUEST and reported three mechanism assertions as failures for that reason alone.
    const earlyCodes=['NATIVE_TURN_REQUEST_LIMIT',loopCode,'BUDGET_STOP_BEFORE_REQUEST',...clockStopCodes,'NO_PROGRESS_STOP','SIGNAL_STOP'];
    const truncatedExit=earlyCodes.includes(f.stop?.code);
    // The stage records its assumption and decision ledgers as facts, so the mechanisms can be judged from committed
    // rows even when the stage never reached collabMetrics().
    //
    // A run that predates those facts has none, and judging it from the summary it never wrote reported a mechanism that
    // demonstrably happened as a failure. The receipts of the tool actions are the same evidence one level down: a
    // team_assume call that returned an assumption: id raised one, a team_assume call answering that id is the answer,
    // and a team_decision call that returned a decision-log: id logged one. So the ledger is read first and the receipts
    // are the fallback, never a substitute for evidence.
    const assumptions=collab.assumptions??null,decisions=collab.decisions??null;
    const actions=(f.toolActions??[]).filter(t=>t.resultRef);
    const raiseReceipts=actions.filter(t=>t.name==='team_assume'&&t.args?.assumptionId===undefined&&
      String(t.resultRef).startsWith('assumption:'));
    const answerReceipts=actions.filter(t=>t.name==='team_assume'&&t.args?.assumptionId!==undefined);
    const decisionReceipts=actions.filter(t=>t.name==='team_decision'&&String(t.resultRef).startsWith('decision-log:'));
    const raised=assumptions?assumptions.length:(m.assumptionsRaised??raiseReceipts.length);
    const answeredBefore=assumptions&&assumptions.length
      ?assumptions.filter(row=>['confirmed','corrected'].includes(row.status)&&row.answeredAt!=null&&row.answeredAt<=(collab.injectedAt??Infinity))
      .length/assumptions.length
      :m.assumptionsConfirmedBeforeIntegration??(raiseReceipts.length?raiseReceipts.filter(raise=>answerReceipts.some(answer=>
        answer.args.assumptionId===raise.resultRef&&answer.at<=(collab.injectedAt??Infinity))).length/raiseReceipts.length:null);
    const loggedDecisions=decisions?decisions.length:(m.proactive?.decisions??decisionReceipts.length);
    const snapshotBudget=(f.requests??[]).filter(r=>r.snapshotTokens>0).every(r=>r.snapshotTokens<=4096);
    const computable=['proactiveRatio','reworkRate','hiddenTestPass','tokenCost','wallClock'].every(k=>Number.isFinite(m[k]));
    if(collab.arm==='on')Object.assign(assertions,{collabTools:arms.length>0&&tools(catalog.be).includes('team_assume')&&
      tools(catalog.be).includes('team_decision')&&!tools(catalog.verifier).includes('team_assume')&&
      arms.every(arm=>arm.intentKind===true),
      // A run the per-turn ceiling or the loop detector cut short never reached the steps these three need, so they are
      // reported as not-exercised (explicitly, with the exit that ended the run) instead of as a verdict on the
      // mechanisms. Everything else -- the tool surface, the gate, the metrics -- still has to hold on an early exit.
      // Judged whenever the premise actually happened -- a member refused for its missing intent and the intent that
      // answers it afterwards -- and reported as not-exercised only when an early exit stopped the premise from arising.
      collabGate:gatedExecutors.length===3&&ordered?true
        :truncatedExit&&gatedExecutors.length===0&&intents.length===0?notExercised('no member was refused for a missing intent before the exit at '+f.stop.code)
        :false,
      // The window's own verdict (4.2 rule 6, 4.4): every intent the run sent reached a conclusion, silence passed
      // some of them, none escalated to the operator, and each recipient has a frozen seenAtClose fact.
      collabIntentConclusions:(m.intentConclusions?.sent??0)>0
        ?m.intentConclusions.open===0&&m.intentConclusions.escalated===0&&
          m.intentConclusions.passed+m.intentConclusions.objected===m.intentConclusions.sent&&
          m.intentConclusions.seenAll+m.intentConclusions.seenPartial+m.intentConclusions.seenNone===m.intentConclusions.sent&&
          m.intentConclusions.recipientsRecorded===true&&m.intentConclusions.rowsConsistent===true&&
          m.intentConclusions.passedUnseenConsistent===true
        :(truncatedExit?notExercised('no intent was sent before the exit at '+f.stop.code):false),
      collabAssumption:raised===0?(truncatedExit?notExercised('no assumption was raised before the exit at '+f.stop.code):false)
        :raised>=1&&answeredBefore===1,
      collabDecisions:loggedDecisions>=1&&snapshotHasDecisions?true
        :truncatedExit&&!snapshotHasDecisions?notExercised('no peer snapshot carried a decision before the exit at '+f.stop.code)
        :false,
      // The stage computes its numbers from the completed run, so a run that stopped early has no numbers to judge;
      // that is reported as not-exercised rather than as a mechanism that failed.
      collabMetrics:truncatedExit&&!computable?notExercised('the stage computes its metrics when it completes; the run stopped at '+f.stop.code)
        :computable&&snapshotBudget});
    else Object.assign(assertions,{collabControl:arms.length>0&&arms.every(arm=>!tools(arm).includes('team_assume')&&
      !tools(arm).includes('team_decision')&&arm.intentKind===false)&&refusals.every(r=>r.reason!=='INTENT_REQUIRED')&&
      (f.collabSnapshots??[]).length===0&&(m.proactive?.intents??0)===0&&(m.assumptionsRaised??0)===0,
      // The control arm's numbers, like the treatment's, only exist once the stage completed.
      collabMetrics:truncatedExit&&!computable?notExercised('the stage computes its metrics when it completes; the run stopped at '+f.stop.code)
        :computable&&snapshotBudget});
  }
}
