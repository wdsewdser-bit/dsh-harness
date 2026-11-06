/**
 * Separate genuine protocol/schema failures from business guards that refused by design.
 *
 * A schema failure is the caller publishing something the contract does not allow: a malformed id, a wrong
 * argument type, an unpublished branch. It passes only when the same actor later makes a legal call that
 * achieves the same intent, and the total rate stays under the limit.
 *
 * A guard rejection is the server working as designed: the role may not do that, the batch is not verified
 * yet, the artifact does not pass review. It is not a protocol failure and does not enter the schema rate,
 * but it is never ignored: every guard rejection must be followed by the progress the guard demanded (the
 * same operation succeeded legally, or the cycle it guarded completed), or by an explicit escalation record.
 * Duplicate external effects and dead letters fail unconditionally, so a guard can never hide them.
 *
 * Unmapped codes are protocol defects by construction: the guard table is an explicit allow-list, so a real
 * error can never be re-labelled as a guard to make an assertion pass.
 */

/** Caller-side contract defects: correctable input the model can retry legally. */
const PROTOCOL_CODES=new Set(['INVALID_TOOL_BRANCH','INVALID_TOOL_FIELDS','INVALID_STRING','INVALID_INTEGER',
  'INVALID_ENUM','INVALID_CONST','INVALID_ARRAY','INVALID_ID','INVALID_REF','INVALID_DEADLINE','INVALID_DEPENDENCY',
  'INVALID_COMMAND','INVALID_JSON','INVALID_SNAPSHOT_PAGE','MISSING_REQUEST_EVIDENCE','INVALID_BOUND']);

/** Business guards that refuse by design, each with the progress that makes the refusal "worked through". */
export const GUARDS={
  ROLE_DENIED:'the refused operation is performed by the role that owns it, or the guarded cycle completes',
  DELIVERIES_NOT_VERIFIED:'the same integration succeeds after verification, or the guarded cycle completes',
  REVIEW_REJECTED:'the delivery is produced/repaired and then reviewed successfully, or the cycle completes',
  QUALITY_FAILED:'the artifact is recomputed to the contract value and accepted later',
  DEPENDENCY_NOT_RELEASED:'the dependency is accepted and the same operation succeeds, or the cycle completes',
  NOT_REQUEST_VISIBLE_AUTHORIZED:'the responsibility becomes request-visible and is accepted later',
  DUPLICATE_DELIVERY:'no second artifact is created; the existing delivery is verified and integrated',
  LATE_MESSAGE:'the responsibility is handled within its live generation or escalated',
  CAS_CONFLICT:'the caller re-reads the revision and retries, or the cycle completes',
  ID_CONFLICT:'one identity per intent; the original receipt stands',
  STALE_DECISION:'the issue is decided at its current proposal revision',
  STALE_CONTRACT:'the current contract revision is used',
  TASK_NOT_OWNED:'only the owning attempt writes to its task',
  VERIFIER_NOT_INDEPENDENT:'an independent verifier signs, never the owner',
  MISSING_RESPONSIBILITY:'action/decision messages carry expectedOutcome and deadline',
  COMPLETION_FROZEN:'no new work is admitted while completion is pending or unknown',
  REFERENCE_ACL:'only owned or granted references are read or written',
  MISSING_REFERENCE:'only existing references are written',
  INVALID_LEASE:'only the live attempt and fence write',
  ACTOR_MISMATCH:'the bound attempt belongs to the calling actor',
  UNKNOWN_MEMBER:'messages address an existing member',
  UNKNOWN_OWNER:'plans and threads name an existing owner',
  NOT_ACCEPTED:'a message is accepted before it is resolved',
  // The collaboration gate (11 §2, 4.2 rule 5): publishing work before the downstream has heard the interface is
  // refused by design, and the progress it demands is the intent itself, sent before the same publish.
  INTENT_REQUIRED:'the member sends the intent the gate names and the same publish succeeds, or the cycle completes',
  INTENT_WINDOW_OPEN:'the window closes and the same publish succeeds, or the cycle completes',
  INTENT_OBJECTED:'a new contract revision is announced and the publish succeeds, or the cycle completes',
  CAPACITY:'admission waits for a free slot instead of creating a second one',
  NOT_READY:'the task is approved and ready before scheduling',
  BLOCKED:'the pending dependency resolves first',
  DUPLICATE_REQUIREMENT:'one task per requirement reference',
  SUPERVISION_SCOPE:'supervision holds no product scope',
  DELEGATION_SCOPE:'work stays inside the delegated scope',
  DELEGATION_BUDGET:'work stays inside the delegated task budget',
  DELEGATION_COST:'work stays inside the delegated cost budget',
  STALE_ASSIGNMENT:'the current contract revision and assignment epoch are used',
  STOP_REQUIRED:'the old native handle stops before resume',
  DECISION_THREAD_REQUIRED:'root opens the review issue with real_work open (and the thread is decided) before integrating, then retries',
  REVIEWS_INCOMPLETE:'every delivery is reviewed onto the issue thread, then the same integrate succeeds',
  REVIEW_THREAD_NOT_OPENED:'root opens the review issue with real_work open; the verifier reply is then recorded on it',
};
export const guardCodes=Object.keys(GUARDS).sort();
export const protocolCodes=[...PROTOCOL_CODES].sort();

/**
 * A JavaScript internal exception in the harness or server is a defect in this repository, not model behaviour:
 * it says nothing about the caller's input, and no retry by the model can fix it. Such rows are collected apart
 * and fail the run outright, whatever the schema rate or the guard progress says.
 */
const HARNESS_ERROR = new RegExp([
  '^(TypeError|ReferenceError|RangeError|SyntaxError|EvalError|URIError)\\b',
  '^(Cannot (read|set) propert|Cannot read properties|undefined is not|.* is not a function|.* is not iterable|.* of undefined|.* of null)'
].join('|'), 'i');
  
export const isHarnessError=value=>HARNESS_ERROR.test(String(value??''));

const base=value=>String(value??'').split(':')[0];

/**
 * Present keys define the intent; retry identity (operationId) and deadline wording do not.
 *
 * Prose is payload, not identity. A summary that was refused for being too long can only be repaired by rewriting it,
 * so comparing it would make every length refusal permanently unrecoverable: the caller did exactly what the refusal
 * asked and the record would still read "never retried". The keys compared here are the ones that say *what* is being
 * done -- the branch, the counterpart, the addressed row, the value, the view -- and the operation branch is checked
 * separately through op.
 */
export function sameIntent(a,b){
  if(!a||!b||a.op!==b.op)return false;
  // affects and about are the addressed subject of the two collaboration rows: a decision retried with a shortened
  // summary over the same affected set, or an assumption answered against the same owner, is the same call repaired.
  const keys=['to','kind','messageId','issueId','taskRef','deliveryId','value','view','ref','affects','about'];
  const present=keys.filter(k=>a[k]!==undefined);
  return present.length>0&&present.every(k=>JSON.stringify(a[k])===JSON.stringify(b[k]));
}

const laterSuccess=(actions,e)=>actions.filter(t=>t.source==='native-model-tool'&&t.actor===e.actor&&
  t.requestId&&t.requestId!==e.requestId&&t.at>=(e.at??0));

/** A legal later call that achieved the failed intent; a read intent is the chosen view, not the bad ref. */
function correctionFor(e,successors){
  if(e.name==='team_read')return successors.find(t=>t.name==='team_read'&&(t.args?.view??null)===(e.args?.view??null))??null;
  return successors.find(t=>t.name===e.name&&sameIntent(e.args,t.args))??null;
}

/** When the workflow actually advanced: the latest accepted delivery, decided issue or completed cycle. */
export function completionAt(f){
  const stamps=[...(f.collab?.delivery?.completedCycles>0
    // The collaboration stage completes a cycle by writing its own delivery record (writeDelivery) instead of the
    // release-stage ledger; "the workflow advanced" is the same fact, read where that stage records it.
    ?[f.collab.firstIntegration?.at,f.collab.final?.at].filter(Number.isFinite):[]),
    ...(f.deliveries??[]).map(d=>d.acceptedAt??d.mergedAt??d.verifiedAt??null),
    ...(f.decisions??[]).map(d=>d.decisionAt??null),
    ...(f.issues??[]).map(i=>i.status==='decided'?i.updatedAt??null:null)].filter(x=>Number.isFinite(x));
  return stamps.length?Math.max(...stamps):null;
}

/**
 * Progress a guard demanded: the same operation succeeded later, or the workflow advanced afterwards.
 * The advance must be timestamped after the refusal, so a rejection that nothing followed stays unresolved.
 */
function guardProgress(e,successors,f){
  const sameOperation=successors.find(t=>t.name===e.name&&(t.args?.op??null)===(e.args?.op??null))??null;
  if(sameOperation)return{state:'worked-through',via:'same-operation',correction:{requestId:sameOperation.requestId,
    at:sameOperation.at,resultRef:sameOperation.resultRef??null}};
  const completed=f.completedCycles??0,advancedAt=completionAt(f);
  if(completed>=1&&advancedAt!==null&&advancedAt>=(e.at??0))return{state:'worked-through',via:'workflow-advanced',
    correction:{cycle:e.cycle??completed,completedCycles:completed,advancedAt}};
  const escalation=[...(f.issues??[]).map(i=>({ref:i.entityId,status:i.status,at:i.updatedAt})),
    ...(f.messages??[]).filter(m=>m.status==='escalated').map(m=>({ref:m.id,status:m.status,at:m.terminalAt}))]
    .find(x=>x.status==='escalated'&&(x.at??0)>=(e.at??0));
  if(escalation)return{state:'escalated',via:'explicit-escalation',correction:{escalation}};
  return{state:'unresolved',via:null,correction:null};
}

export function protocolMetrics(f,operationRows=[]){
  const actions=(f.toolActions??[]).filter(t=>t.source==='native-model-tool');
  const errors=(f.protocolErrors??[]).map(e=>{
    const code=base(e.error),successors=laterSuccess(actions,e);
    if(isHarnessError(e.error))return{...e,code,kind:'defect',defect:true,known:false,recovered:false,state:'fixture-defect',
      requiredProgress:'none: a JavaScript internal error is a defect in this repository; fix the code, do not retry',
      correction:null};
    if(GUARDS[code]){
      const progress=guardProgress(e,successors,f);
      return{...e,code,kind:'guard',recovered:progress.state!=='unresolved',state:progress.state,via:progress.via,
        requiredProgress:GUARDS[code],correction:progress.correction};
    }
    // An unmapped code is still a protocol defect; it simply has no published correction rule, so it can never
    // be forgiven by a later call.
    const known=PROTOCOL_CODES.has(code);
    const correction=known&&e.actor&&e.name&&e.requestId&&Number.isFinite(e.at)?correctionFor(e,successors):null;
    return{...e,code,kind:'protocol',known,recovered:!!correction,state:correction?'worked-through':'unresolved',
      correction:correction?{requestId:correction.requestId,at:correction.at,resultRef:correction.resultRef??null,
        args:correction.args??null}:null};
  });
  const protocolErrors=errors.filter(e=>e.kind!=='guard'&&e.kind!=='defect');
  const guardRows=errors.filter(e=>e.kind==='guard');
  const harnessRows=errors.filter(e=>e.kind==='defect');
  const successful=actions.length,protocolAttempts=successful+protocolErrors.length,
    errorRate=protocolAttempts?protocolErrors.length/protocolAttempts:null;
  const count=list=>Object.fromEntries([...new Set(list.map(e=>e.code))].map(code=>{
    const rows=list.filter(e=>e.code===code);
    return[code,{count:rows.length,recovered:rows.filter(e=>e.recovered).length,kind:rows[0].kind,
      rate:protocolAttempts?rows.length/protocolAttempts:null,
      items:rows.map(r=>({actor:r.actor,name:r.name,requestId:r.requestId,cycle:r.cycle??null,args:r.args??null,
        resolved:r.recovered,state:r.state,requiredProgress:r.requiredProgress??null,resolvedBy:r.correction}))}];
  }));
  const duplicateEffects=operationRows.filter(r=>r.entities.length>1);
  const deadLetters=(f.messages??[]).filter(m=>m.status==='dead-letter');
  const unresolvedProtocol=protocolErrors.filter(e=>!e.recovered);
  const unresolvedGuards=guardRows.filter(e=>!e.recovered);
  // This verdict is about the caller's contract only: guard resolution and harness defects have their own
  // assertions, so a refusal by design never makes the protocol answer look like a protocol failure.
  // Duplicate effects and dead letters stay here because they fail unconditionally, whatever else happened.
  const passed=!unresolvedProtocol.length&&(!protocolAttempts||errorRate<=.10)&&
    !duplicateEffects.length&&!deadLetters.length;
  const guardsPassed=!unresolvedGuards.length;
  return{errors,totalToolCalls:successful+errors.length,successfulToolCalls:successful,protocolAttempts,
    schemaErrorRate:errorRate,errorRateLimit:.10,byCode:count(errors),protocolByCode:count(protocolErrors),
    recoveredErrors:protocolErrors.filter(e=>e.recovered).length,unrecoveredErrors:unresolvedProtocol.length,
    unrecovered:unresolvedProtocol,
    guardRejections:{count:guardRows.length,workedThrough:guardRows.filter(e=>e.state==='worked-through').length,
      escalated:guardRows.filter(e=>e.state==='escalated').length,unresolved:unresolvedGuards.length,
      byCode:count(guardRows),
      items:guardRows.map(e=>({actor:e.actor,name:e.name,code:e.code,requestId:e.requestId,cycle:e.cycle??null,
        args:e.args??null,at:e.at,requiredProgress:e.requiredProgress,state:e.state,resolvedBy:e.correction}))},
    harnessErrors:{count:harnessRows.length,
      byMessage:Object.entries(harnessRows.reduce((acc,e)=>{const key=String(e.error??'').slice(0,120);acc[key]=(acc[key]??0)+1;return acc;},{})).map(([message,
            count])=>({message,count})),
      items:harnessRows.map(e=>({actor:e.actor??null,name:e.name??null,requestId:e.requestId??null,at:e.at??null,
        args:e.args??null,error:String(e.error??''),cycle:e.cycle??null}))},
    duplicateEffects,deadLetters,guardsPassed,passed};
}