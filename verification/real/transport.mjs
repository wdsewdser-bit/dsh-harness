import fs from 'node:fs';import {route,policy,gate as contextGate} from './config.mjs';import {classifyAccepted} from '../../packages/contracts/index.mjs';
import {planRequest,GATE_RATIO} from '../../packages/context/budget.mjs';import {usage} from './budget.mjs';import {digest,checkPairs,truncation
  } from './protocol.mjs';import {ConcurrencyGate} from './concurrency.mjs';

export class Transport {
  constructor({root,budget,mode,key,fake,facts,stopped,gate,onDispatchPhase=null,now=Date.now}={}){Object.assign(this,{root,budget,mode,key,fake,facts,
    stopped});
    this.requests=0;this.boundary=false;this.fetch=globalThis.fetch;
    // The confirmation points (M1b design §1.4.1). send-started is diagnostic only; committed is the first fact that
    // may become visible evidence, and it can only be reported after the awaited fetch returned a Response (real) or
    // after the controlled receiver answered (fake) - never from a generator first line.
    this.onDispatchPhase=typeof onDispatchPhase==='function'?onDispatchPhase:null;this.dispatchNow=now;this.transmissions=new Map();
    // What the last successful request of each actor/session carried and what the provider reported for it.
    this.lastCall=new Map();
    this.gate=gate??new ConcurrencyGate({maxConcurrent:policy.maxConcurrent,globalConcurrency:policy.globalConcurrency??1});}
  /** One attempt, many transmissions: the counter is per attempt id, and 1 is the first real transmission. */
  transmissionFor(attemptId){const next=(this.transmissions.get(attemptId)??0)+1;this.transmissions.set(attemptId,next);return next;}
  /**
   * Report one phase to the trusted dispatcher.
   *
   * When the caller hands over the attempt the patched runtime minted, its own publisher is called: that is the only
   * place that knows the request-side facts (session, kind, purpose, message digests) and the send time of each
   * transmission, so two interleaved requests cannot swap identities. The observer below is the fallback for an
   * adapter that reports raw fields; it is a listener, so a synchronous throw and a rejected promise are contained.
   */
  report(phase,attempt,fields){
    if(attempt&&typeof attempt==='object'&&typeof attempt.phase==='function'){try{attempt.phase(phase,fields);}catch{}return;}
    const observer=this.onDispatchPhase;const attemptId=typeof attempt==='string'?attempt:null;
    if(observer===null||typeof attemptId!=='string'||!attemptId)return;
    try{const returned=observer({phase,attemptId,...fields});if(returned!=null&&typeof returned.then==='function')Promise.resolve(returned).then(void 0,()=>{});
      }catch{}
  }
  clean(x){const scrub=s=>this.key&&this.key.length>=12?s.split(this.key).join('[REDACTED]'):s;const visit=v=>typeof v==='string'?scrub(v):Array.isArray(v)?v
    .map(visit):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,value])=>[scrub(k),visit(value)])):v;return visit(x)
    }
  async call(actor,input,tools=[],meta={},{stepSignal}={}){
    checkPairs(input);
    // One body shape, built twice: the estimate below runs on a provisional body carrying the fixed route.maxOutputTokens,
    // and only the cap computed from that estimate goes into the body that is serialized and sent.
    const build=cap=>({model:route.model,input,tools,max_output_tokens:cap,stream:false,store:false,include:['reasoning.encrypted_content'],...(meta.forceTool?{
            tool_choice:{type:'function',name:meta.forceTool}}:{})});
    const provisional=build(route.maxOutputTokens);
    /**
     * One plan, many consequences: the pre-request input estimate, the input-only 75% ceiling, the output cap the
     * window still leaves and the durable reservation all come from the single rule in packages/context/budget.mjs
     * (planRequest). What stays here is the per-actor/session memory both halves need: the items, the body overhead
     * and the reported input of the last request the provider accepted, so the next estimate reuses that report
     * (prefix-delta) instead of re-measuring the whole history in bytes. A rewritten or folded history, a rotated
     * native session and the first request of a session carry no such sample and fall back to the full byte count,
     * which is always safe; the method used is recorded per request, so the report tells a delta from a full estimate.
     *
     * The plan is taken on the provisional body (the fixed route cap), never on the final body: the digit count of a
     * clamped max_output_tokens would otherwise move the overhead between two adjacent requests and the prefix-delta
     * would add that difference to nonInputBytes - an estimate inflated by the cap rather than by the prompt. The
     * method and evidence are written to the request row unchanged.
     */
    const key=actor+'|'+(meta.nativeSessionId??'default'),previous=this.lastCall.get(key);
    const plan=planRequest(provisional,contextGate,{purpose:'main',previous});
    const inputUpperBound=plan.I,estimateMethod=plan.method,estimateEvidence=plan.evidence;
    const maxOutputTokens=plan.maxOutputTokens,bound=plan.reserve;
    this.boundary=true;
    // Refused only when the input alone reaches 75% of the window; the cap and the reservation are already computed.
    if(plan.verdict!=='allow')throw Error(plan.code);
    // The request that leaves this process IS the plan's body: the estimate, the media scan, the reservation, the
    // bytes, the hash and the payload the provider sees all come from one serialization, so a toJSON() that answers
    // differently on a second call cannot be priced as text and sent as an image. dispatch receives the parsed form
    // of that same string (its requestHash is the digest of exactly these bytes).
    const serialized=plan.body,bytes=plan.payloadBytes,body=JSON.parse(serialized);
    // Every request-side fact here is read from that body, never from the caller's objects: inputHash is the digest
    // of exactly the input the provider receives, and the counts describe the same bytes. (Reading the raw input
    // would serialize it a second time and could hash a different body under a toJSON() that answers twice.)
    const sentInput=Array.isArray(body.input)?body.input:[];
    meta={...meta,reasoningItems:sentInput.filter(x=>x.type==='reasoning').length,reasoningHashes:sentInput.filter(x=>x.type==='reasoning').map(digest),
      toolPairs:sentInput.filter(x=>x.type==='function_call_output').length,inputHash:digest(sentInput),inputUpperBound,estimateMethod,estimateEvidence};
    // Cheap fail-fast before occupying a slot; the authoritative reservation happens inside the slot.
    if(!this.budget.canAdmit(bound))throw Error('BUDGET_STOP_BEFORE_REQUEST');
    if(this.mode==='dry')throw Error('DRY_STOP_BEFORE_PROVIDER');const stop=this.stopped();if(stop)throw Error(stop);
    // Per-member slot plus global ceiling: different members no longer queue behind each other's whole turn.
    return this.gate.run(actor,window=>this.dispatch({actor,body,serialized,bytes,bound,meta,window,
      remember:{key,items:plan.items,overheadBytes:plan.overheadBytes},maxOutputTokens}),{signal:stepSignal});
  }
  async dispatch({actor,body,serialized,bytes,bound,meta,window,remember,maxOutputTokens}){
    const after=this.stopped();if(after)throw Error(after);
    const token=this.budget.reserve(bound),requestNumber=++this.requests;const at=Date.now();let result,httpStatus=0,rawError=null;
    const attempt=meta.attempt??null;if(attempt!==null)delete meta.attempt;const attemptId=meta.attemptId??attempt?.id??null;const transmission
    =typeof attemptId==='string'?this.transmissionFor(attemptId):null;
    try{
      if(this.mode==='fake'){
        // The controlled receiver has to take the whole body and answer before this is a confirmation.
        this.report('send-started',attempt??attemptId,{transmission,sendStartedAt:this.dispatchNow()});
        result=await this.fake(body,{actor,...meta});httpStatus=result.error?400:200;
        this.report('committed',attempt??attemptId,{transmission,httpStatus,accepted:classifyAccepted(httpStatus,{receiverError:Boolean(result.error)}),
            receiverError:Boolean(result.error)});
          }
            else{
        // send-started: parameters are built, fetch is about to be called. It proves neither arrival nor failure.
        this.report('send-started',attempt??attemptId,{transmission,sendStartedAt:this.dispatchNow()});
        const response=await this.fetch(route.baseURL+'/responses',{method:'POST',headers:{authorization:'Bearer '+this.key,'content-type':'application/json'},
            body:serialized,signal:AbortSignal.timeout(policy.requestTimeoutMs),redirect:'error'});
        // committed: headers arrived, before any body is read. Reading the body cannot change whether it arrived.
        this.report('committed',attempt??attemptId,{transmission,httpStatus:response.status,accepted:classifyAccepted(response.status)});
        httpStatus=response.status;const text=await response.text();try{result=JSON.parse(text)}catch{rawError=text;throw Error('PROVIDER_NON_JSON')}}
      if(result.error)rawError=result.error;
    }catch(e){rawError=rawError??String(e.message)}
    const u=usage(result?.usage),elapsedMs=Date.now()-at,cut=truncation(result);const row=this.clean({id:requestNumber,actor,at,elapsedMs,slotWaitMs:window?.ms
        ??null,superseded:window?.supersededAt!=null,requestBytes:bytes,usage:u,httpStatus,
      // The provider's own verdict on the response, so a truncated step is a recorded fact and not a guess: a request
      // the provider stopped at max_output_tokens carries truncated:true and the reason it gave.
      responseStatus:cut.status,incompleteReason:cut.reason,truncated:cut.truncated,outputCap:maxOutputTokens,outputReasoningHashes:(result?.output??[]).filter(
        x=>
      x
        .type==='reasoning').map(digest),accepted:httpStatus>=200&&httpStatus<300&&!rawError,rawError,...meta,requestHash:digest(body),body,result});
    fs.appendFileSync(this.root+'/requests.jsonl',JSON.stringify(row)+String.fromCharCode(10));
    this.facts.requests.push({...row,body:undefined,result:undefined});
    (this.facts.latency.transport??=[]).push(elapsedMs);
    // Slot waiting is reported separately from request latency; it is never removed from any raw sample.
    (this.facts.slotWaits??=[]).push({actor,requestId:meta.requestId??null,at,requestedAt:window?.requestedAt??null,
      grantedAt:window?.grantedAt??null,waitMs:window?.ms??0,heldMs:window?.heldMs??elapsedMs});
    try{this.budget.settle(u,token)}catch(e){// Still charged; recorded so a reservation overrun fails the run instead of vanishing.
      (this.facts.budgetViolations??=[]).push({actor,requestId:meta.requestId??null,code:e.message,actual:(u?.input??0)+(u?.output??0)});throw e}
    // Only a request the provider actually accepted teaches the next estimate what its prefix cost.
    if(row.accepted&&Number.isInteger(u?.input)&&(this.lastCall.get(remember.key)?.requestNumber??0)<requestNumber)
      this.lastCall.set(remember.key,{...remember,input:u.input,requestNumber});
    if(!row.accepted){const error=Error('PROVIDER_REJECTED');error.evidence=row;throw error}
    if(u.input>=contextGate.W*GATE_RATIO)throw Error('CONTEXT_75_PERCENT_GATE');
    if(this.key&&this.key.length>=12&&JSON.stringify(result)!==JSON.stringify(this.clean(result)))throw Error('SECRET_IN_PROVIDER_OUTPUT');
    return result;
  }
}

// Keys shorter than 12 chars (the local wb-proxy key) collide with ordinary model text such as UUIDs; they are not scanned or scrubbed.
