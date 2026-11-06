import { AsyncLocalStorage } from 'node:async_hooks';
import { acquireOwnerControl, settleOwnerControl, recoverControlCapacity, providerCapacity } from '../core/index.mjs';
import { randomUUID } from 'node:crypto';
import { BORROW_TRANSPORT_CONTRACT } from './borrow-entry-support.mjs';
const refused=code=>Object.assign(Error(code),{code});
export const HOST_LLM_ENTRIES=Object.freeze(['model-catalog','model-discovery','owner-conversation']);

function implementation(llm,name,args) {
  if(name==='discoverModels'||name==='remoteDiscoverModels')return llm.discoveries?.get(args[0]);
  if(name==='resolveModelInfoFor'||name==='resolveCallFor')return args[0]?.adapter;
  const provider=['prepareCall','resolveCallConfig'].includes(name)?args[0]?.provider:args[0];
  return llm.registration?.(provider)?.adapter;
}
export const LLM_NETWORK_ENTRIES=Object.freeze(['prepareCall','listModels','discoverModels','remoteDiscoverModels',
  'resolveModelInfo','resolveModelInfoFor','resolveCallConfig','resolveCallFor']);
/**
 * §4.2/P2: a host-control capability is bound to the operations it was minted for. Catalog and discovery can read
 * metadata; only the owner conversation can drive a stream. A capability name is not a universal key.
 */
export const HOST_ENTRY_OPERATIONS=Object.freeze({
  'model-catalog':Object.freeze(['listModels','resolveModelInfo','resolveModelInfoFor','resolveCallFor','resolveCallConfig']),
  'model-discovery':Object.freeze(['discoverModels','remoteDiscoverModels']),
  'owner-conversation':Object.freeze([...LLM_NETWORK_ENTRIES,'stream']),
});
const entryAllows=(entry,label)=>entry===null||entry===undefined||entry===label||Boolean(HOST_ENTRY_OPERATIONS[entry]?.includes(label));


/** Explicit host-control authority, never inferred in the network layer from an absent member capability. */
function hostCall(assertAuthorized,label, observer = null) {
  let closed=false,serial=0;const pending=new Set();
  const observed=observer?.call(label) ?? null;
  const check=()=>{if(closed)throw refused('HOST_CALL_CLOSED');assertAuthorized();};
  return Object.freeze({domain:observed?'owner-control':'host-control',label,
    reserve(){check();const token=Object.freeze({host:label,id:++serial});pending.add(token);observed?.reserve(token);return token;},
    finish(token){observed?.finish(token);return pending.delete(token);},unmanaged(){observed?.unknown("unmanaged transport");},
    async network(work){check();const token=this.reserve();try{return await work();}finally{this.finish(token);}},
    close(outcome){closed=true;observed?.close(outcome,pending.size);if(!observed)pending.clear();},
  });
}

/** One runtime entry policy for metadata and streams; stale member context always takes precedence over session lookup. */
export function installLlmExecutionEntries({ctx,scopes,memberOfSession,sessionId,authorizeHost,moduleReady,
  autonomy=false,borrowV1=false,transportReady=()=>false,hostSessionAuthorized=()=>false,ownerControl=null,observeProvider=null}) {
  const hostEntries=new AsyncLocalStorage();
  // Gap 3: a provider limit is observed where the call is made. Recording the fact must never change the outcome of
  // the call itself, so every observation is fire-and-forget and the original error is always rethrown.
  const observe=(error,failure)=>{if(typeof observeProvider==='function')try{observeProvider(error??null,failure??null);}catch{}};
  const select=hint=>{
    const sid=hint??sessionId(),scope=scopes.resolve(sid);
    if(scope)return scope;
    if(memberOfSession(sid))throw refused('EXECUTION_SCOPE_MISSING');
    if(!hostEntries.getStore() && !hostSessionAuthorized(sid))throw refused('HOST_ENTRY_REQUIRED');
    return null;
  };
  const assertHost=()=>{
    if(scopes.current())throw refused('HOST_CONTROL_FROM_MEMBER');
    authorizeHost(()=>true);
  };
  async function enter(label,work,hint,args) {
    const entry=hostEntries.getStore();
    if(!entryAllows(entry,label))throw refused('HOST_ENTRY_SCOPE_VIOLATION');
    const scope=autonomy?select(hint):null;
    // Select synchronously, before the module import await or any provider code can run.
    const owner=ownerControl?.resolve(hint??sessionId());
     if(ownerControl && !scope && label==='owner-conversation' && !owner)throw refused('HOST_ENTRY_REQUIRED');
     const call=scope?scope.call():hostCall(assertHost,label,owner);
    let completed=false;
    try {
      if(!scope)assertHost();
      const module=await moduleReady;
      if(!module?.withExecutionCall) {
        if(autonomy)throw refused('EXECUTION_TRANSPORT_UNCONTROLLED');
        const value=await work();completed=true;return value; // explicit legacy off/pristine composition
      }
      // v1 never drives a request through an unverified transport, whatever entry asked for it; legacy autonomy keeps
      // its previous scope/owner rule.
      if(borrowV1 || scope || (call.domain==='owner-control' && LLM_NETWORK_ENTRIES.includes(label))) {
        // A host-control entry (owner-conversation) is not a provider operation: there is no target to look up for the
        // entry itself. It only requires a verified transport layer here; the stream listener still checks the exact
        // adapter that will run the request. Every network operation is checked against its own target.
        if(!transportReady()){scope?.invalidate('transport');call.unmanaged();throw refused('EXECUTION_TRANSPORT_UNCONTROLLED');}
        if(LLM_NETWORK_ENTRIES.includes(label)){
          let target;try{target=implementation(ctx.llm,label,args??[]);}catch{}
          if(!module.isExecutionTargetTrusted?.(target) || target?.executionPermitContract!==BORROW_TRANSPORT_CONTRACT){scope?.invalidate('transport');call.unmanaged();throw refused('EXECUTION_TRANSPORT_UNCONTROLLED');}
        }
      }
      const run=()=>module.withExecutionCall(call,work);
      const value=await (scope?scope.run(run):run());completed=true;return value;
    } catch(error){observe(error,null);throw error;}
    finally {call.close(completed?'executed':'unknown');}
  }
  for(const name of LLM_NETWORK_ENTRIES)if(typeof ctx.llm?.[name]==='function') {
    const original=ctx.llm[name];ctx.llm[name]=(...args)=>enter(name,()=>original.apply(ctx.llm,args),undefined,args);
  }
  if(autonomy || ctx.llm?.executionPermitContract==='execution-permit/1')ctx.on('llm/stream',(options,next)=>{
    const entry=hostEntries.getStore();
    // Catalog/discovery capabilities are metadata-only; they can never carry a stream.
    if(entry!==null && entry!==undefined && entry!=='owner-conversation')return (async function*(){throw refused('HOST_ENTRY_SCOPE_VIOLATION');})();
    const scope=autonomy?select(options?.sessionId):null;
    return (async function*(){
    const owner=ownerControl?.resolve(options?.sessionId??sessionId());
     // v1: a stream always needs either a member execution scope or a live owner control call for this exact owner
     // session and its native turn. A host-control domain (metadata) never substitutes for owner control, so an
     // unrouted session cannot drive a provider request.
     // v1: a stream without a member scope must resolve a live owner control call for this exact session. There is
     // no session-id-only fallback; an owner turn is identified by the call/turn identity, never by its session string.
     if(borrowV1 && !scope && !owner)throw refused('HOST_ENTRY_REQUIRED');
     if(ownerControl && !scope && (hostSessionAuthorized(options?.sessionId??sessionId()) || entry==='owner-conversation') && !owner)throw refused('HOST_ENTRY_REQUIRED');
     const call=scope?scope.call():hostCall(assertHost,'stream',owner);let completed=false,iterator;
    try {
      if(!scope)assertHost();
      const module=await moduleReady;
      if(!module?.withExecutionCall || (scope && !transportReady()))throw refused('EXECUTION_TRANSPORT_UNCONTROLLED');
      // The transport trust check is not conditional on an owner being resolved: v1 requires a trusted
      // execution-permit/1 adapter for every stream it drives.
      if(borrowV1 || owner){const target=ctx.llm.registration?.(options?.provider)?.adapter;if(!transportReady()||!module.isExecutionTargetTrusted?.(target)||target?.executionPermitContract!==BORROW_TRANSPORT_CONTRACT){call.unmanaged();throw refused('EXECUTION_TRANSPORT_UNCONTROLLED');}}
       const run=work=>scope?scope.run(()=>module.withExecutionCall(call,work)):module.withExecutionCall(call,work);
      iterator=run(()=>next()[Symbol.asyncIterator]());
      // Gap 3: the llm layer folds an adapter failure into the finish chunk (reason.kind==='error'), so a failed stream
      // must not be read as a completed provider response below. A clean end is the only success observation.
      let failed=false;
      try {for(;;){const item=await run(()=>iterator.next());
        if(item.done){completed=true;if(!failed)observe(null,null);break;}
        const chunk=item.value;
        if(chunk?.type==='finish'&&chunk.reason?.kind==='error'){failed=true;observe(null,chunk.reason.failure??{code:'UNKNOWN',message:'provider failure without a code'});}
        yield chunk;}}
      catch(error){failed=true;observe(error,null);throw error;}
      finally {if(!completed&&iterator?.return)await run(()=>iterator.return());}
    } finally {call.close(completed?'executed':'unknown');}
    })();
  });
  return Object.freeze({transportCovered:module=>{const registrations=[...(ctx.llm?.adapters?.values?.()??[])];return registrations.length>0 && registrations.every(r=>module?.isExecutionTargetTrusted?.(r.adapter));},hostControl:(entry,work)=>{
    // Only installation's closed control catalog may mint a capability; an unknown session is not authority.
    assertHost();if(!HOST_LLM_ENTRIES.includes(entry)||typeof work!=='function')throw refused('HOST_ENTRY_REQUIRED');
    return hostEntries.run(entry,()=>enter(entry,work));
  }});
}
/** P4: one H owner call identity, the native turn, and all transport reservations share a persistent outcome.
 * A stream return/rejection is not a stop proof. Unknown is sticky until independently verified termination.
 */
export function createOwnerControl({core,ctx,teamId,ownerSessionId,epoch,authorize=work=>work(),now=Date.now,verifyTerminated=null}) {
  let active=null,stopped=false;const identities=new AsyncLocalStorage();
  const facts=(ref,p,reduce)=>core.controlFact(ref,p,reduce);
  facts('control-recovery',{},tx=>recoverControlCapacity(tx,now()));
  function settle(a,terminal,reason) {
    try {facts(a.slot.entityId,{callIdentity:a.id,terminal,reason:reason??null},tx=>settleOwnerControl(tx,{
      slotRef:a.slot.entityId,callIdentity:a.id,hostEpoch:a.slot.hostEpoch,terminal,reason:reason??null,
      evidenceRef:terminal?'owner-transport:'+a.id:null,now:now()}));}
    catch(error){a.unknown=true;a.error=error.code??error.message;return;}
    if(terminal && active===a)active=null;
  }
  function progress(a) {
    facts(a.slot.entityId,{},tx=>{const key='execution-outcome:'+a.id,old=tx.read(key);return tx.put(key,{...old,
      turn:a.turn,activeCalls:a.calls.size,activeTransport:a.pending.size,observedCalls:a.observedCalls??0});});
  }
  function check(a) {if(a.ended && !a.calls.size && !a.pending.size && !a.unknown)settle(a,true,'native turn ended and all transport calls terminated');}
  const detach=ctx.on('session/event',(session,event)=>{
    const a=active;if(!a||session.id!==ownerSessionId)return;
    if(event.type==='turn/start') {if(a.turn!==null&&a.turn!==event.data?.turn){a.unknown=true;settle(a,false,'overlapping owner turn');}a.turn=event.data?.turn??null;}
    if(event.type==='turn/end') {if(a.turn===null||a.turn!==event.data?.turn){a.unknown=true;settle(a,false,'owner turn identity missing');return;}a.ended=true;
      if(['error','aborted','cancelled','cancel'].includes(event.data?.reason?.kind)){a.unknown=true;settle(a,false,'owner turn error/cancel is not transport termination proof');return;}
      check(a);}
  });
  if(typeof detach!=='function')throw refused('OWNER_CONTROL_UNAVAILABLE');
  return Object.freeze({
    async run(binding,work,request={}) {
      if(stopped||active)return {deferred:true,reason:'owner H held'};
      if(binding?.epoch!==(typeof epoch==='function'?epoch():epoch) || binding?.ownerSessionId!==ownerSessionId || binding?.sessionId!==ownerSessionId)
        return {notExecuted:true,reason:'stale owner control identity'};
      // Gap 3: an open provider limit defers before anything is acquired. The local H lane must not hold a slot for a
      // request the provider already said it will refuse, and an unknown classification never adds a freeze of its own.
      if(providerCapacity(core.store,now()).state==='throttled')return {deferred:true,reason:'PROVIDER_THROTTLED'};
      const id='owner-call:'+randomUUID();let slot;
      try {slot=authorize(()=>core.execute('control-slot:'+teamId+':'+id,'adapter',{binding,originRef:request.originRef??null},
        tx=>acquireOwnerControl(tx,{teamId,binding,holderRef:id,originRef:request.originRef,now:now()}))).result;}
      catch(error){if(['CAPACITY','CAPACITY_UNKNOWN','COMPLETION_FROZEN'].includes(error.code))return {deferred:true,reason:error.code};throw error;}
      const a={id,slot,turn:null,ended:false,calls:new Set(),pending:new Set(),unknown:false};active=a;
      try {
        const result=await identities.run(a.id,work);
        if(!result?.executed) {if(a.turn===null&&!a.calls.size&&!a.pending.size&&!result?.unknown){a.ended=true;check(a);}else{a.unknown=true;settle(a,false,'wake outcome unknown');}}
        return result;
      } catch(error){a.unknown=true;settle(a,false,'owner invocation threw');return {unknown:true,reason:error.message};}
    },
    /**
     * The native owner turn for the active call: one turn per owner call, started inside it, and not a way for another
     * session to borrow H. resolve() still refuses a bare session id; this is the stream-edge binding the host cycle
     * needs when the turn outlives the caller's async context.
     */
    resolve(sid) {
      if((sid!=null && sid!==ownerSessionId) || !active || stopped || identities.getStore()!==active.id)return null;
      const a=active;
      return {call(label){
        if(a.ended||a.unknown||active!==a||stopped)throw refused('HOST_CALL_CLOSED');
        const token={label};a.calls.add(token);a.observedCalls=(a.observedCalls??0)+1;progress(a);
        return {reserve(t){if(a.ended||a.unknown||active!==a||stopped)throw refused('HOST_CALL_CLOSED');a.pending.add(t);progress(a);},finish(t){a.pending.delete(t);progress(a);check(a);},
          unknown(reason){a.unknown=true;settle(a,false,reason);},
          close(outcome,pending){a.calls.delete(token);if(outcome!=='executed'||pending){a.unknown=true;settle(a,false,'transport termination unknown');}check(a);}};
      }};
    },
    async reclaim(slotRef,evidenceRef) {
      const slot=core.store.read(slotRef);
      if(slot?.holderKind!=='owner-request'||slot.state==='released'||typeof evidenceRef!=='string'||!evidenceRef||
        typeof verifyTerminated!=='function'||await verifyTerminated({slot:structuredClone(slot),evidenceRef})!==true)throw refused('STOP_NOT_CONFIRMED');
      try {
        facts(slotRef,{evidenceRef},tx=>settleOwnerControl(tx,{slotRef,callIdentity:slot.callIdentity,hostEpoch:slot.hostEpoch,
          terminal:true,evidenceRef,reason:'trusted external owner transport termination',now:now(),requireLive:true}));
      } catch(error){/* a concurrent reclaim already settled this exact slot: exactly one proof wins */
        if(error?.code==='ALREADY_RELEASED')throw refused('STOP_NOT_CONFIRMED');throw error;}
      if(active?.slot.entityId===slotRef)active=null;
    },
    stop(){stopped=true;if(active){active.unknown=true;settle(active,false,'host stopped; logical isolation is not termination');}detach();},
    status:()=>{const provider=providerCapacity(core.store,now());return {active:active?.id??null,unknown:active?.unknown??false,
      transportContract:BORROW_TRANSPORT_CONTRACT,providerCapacity:provider.state,providerRecoveryAt:provider.recoveryAt};}
  });
}

/** P2: an effective value is evidence of an exact model check AND a real owner model selection.
 * A discovery endpoint alone is not a conversation provider. Null does not even look up the owner.
 */
export async function resolveOwnerModel({ ownerModel = null, ctx = null, ownerSessionId = null } = {}) {
  if (ownerModel === null || ownerModel === undefined) {
    return Object.freeze({ configured: null, effective: null, source: 'host-default' });
  }
  const unavailable = cause => Object.assign(Error('ROOT_MODEL_UNAVAILABLE: ' + String(cause?.message ?? cause)),
    { code: 'ROOT_MODEL_UNAVAILABLE', cause });
  try {
    const { provider, model } = ownerModel;
    if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) throw Error('invalid selection');
    const agent = ctx?.agents?.get?.(ownerSessionId);
    if (!agent || agent.session?.id !== ownerSessionId || agent.running === true ||
        typeof agent.model?.select !== 'function' || typeof agent.model?.current !== 'function') throw Error('no idle owner model entry');
    if (!ctx.llm?.registration?.(provider)?.adapter || typeof ctx.llm.resolveModelInfo !== 'function') throw Error('no conversation provider');
    const info = await ctx.llm.resolveModelInfo(provider, model);
    if (info?.provider !== provider || info?.id !== model) throw Error('exact model unavailable');
    if (agent.running === true || ctx.agents.get(ownerSessionId) !== agent) throw Error('owner changed during model resolution');
    const selection = Object.freeze({ provider, model });
    agent.model.select(selection);
    const actual = agent.model.current();
    if (actual?.provider !== provider || actual?.model !== model) throw Error('owner did not apply model selection');
    return Object.freeze({ configured: selection, effective: selection, source: 'owner-model' });
  } catch (error) { throw unavailable(error); }
}
