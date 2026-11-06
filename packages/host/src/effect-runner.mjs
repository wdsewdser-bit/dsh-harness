import { failWith } from '../../contracts/index.mjs';
import { performance } from 'node:perf_hooks';
import { evidenceOf } from './effects/protocol.mjs';
import { createEffectCapabilities } from './effect-capabilities.mjs';

/** The single storage identity of one IO claim: (effectId, fence). No claim is ever stored under effectId alone. */
export const effectIoClaimKey = (effectId, fence) => 'effect-io:' + effectId + ':' + String(fence);
/**
 * Inactive until pump() is explicitly installed. IO never belongs to the cycle's wait chain.
 *
 * P4 (§6.2): `capabilities` is the capability declaration layer, and it is only present while the autonomy switch is
 * on — the composition that owns the switch decides that, never a request. Without it the runner behaves exactly as it
 * did before P4: the ledger's own rule closes every effect, whatever its kind.
 */
export function createEffectRunner({ access, ports = {}, clock, capacity = 4, timeoutMs = 60000, onReceipt = null, verifyStopped = null, deferrable = null, memberOf = null, alertAfterMs = 30000, capabilities = null, capacityLanes = null, teamId = null, hostEpoch = null } = {}) {
 if (!access || !clock || !Number.isSafeInteger(capacity) || capacity < 1 || !Number.isFinite(timeoutMs) || timeoutMs < 0) failWith('INVALID_CONFIG', 'runner needs access, clock and a finite bound');
 if (!Number.isFinite(alertAfterMs) || alertAfterMs < 0) failWith('INVALID_CONFIG', 'alertAfterMs needs a non-negative finite millisecond value');
 const pending = new Set(); const activeIO = new Set(); const aborts = new Set(); let stopped = false; const audit = [];
 // §6.2.1: the start-up check lives in the layer, so an undeclared kind refuses the host before it claims anything.
 const capabilityLayer = capabilities === null || capabilities === undefined ? null
  : createEffectCapabilities({ now: () => clock.now(), ...capabilities,
    ...(capacityLanes ? {readbacks:Object.fromEntries(Object.entries(capabilities.readbacks ?? {}).map(([name,port])=>[name,async request=>{
      const slot=[...activeIO].find(s=>s.effectId===request.operationId);
      if(!slot || slot.reclaimed || stopped)return {unknown:true,reason:'readback dispatch isolated'};
      slot.closeIO=(slot.closeIO??0)+1;
      const uncertain=()=>{if(slot){slot.closeUnknown=true;slot.unknown=true;persist(slot,'unknown','readback transport termination unknown');}};
      try {const value=await port(request);if(evidenceOf(value).unknown)uncertain();return value;}
      catch(error){uncertain();throw error;}
      finally {if(slot){slot.closeIO--;slot.release?.();}}
    }]))}:{}),
    access: capabilities.access ?? access ?? null, audit: entry => audit.push(entry) });
 const laneOf = effect => capacityLanes?.classify(effect)==='human'?'human':'normal';
 // §6.2/H06: a reclaim proof names the exact claim it releases. The team and the epoch the IO was claimed under are
 // durable facts of that claim, not the host's current identity, so a proof from another team, another epoch or a
 // replayed claim cannot free this slot.
 const epochNow = () => (typeof hostEpoch === 'function' ? hostEpoch() : hostEpoch) ?? null;
 const subjectOf = slot => ({ effectId: slot.effectId, fence: slot.fence, startedAt: slot.startedAt,
  teamId: slot.teamId ?? null, hostEpoch: slot.hostEpoch ?? null, attemptId: slot.attemptId ?? null });
 const count = lane => [...activeIO].filter(s=>s.lane===lane).length;
 const persist = (slot,state,reason=null) => {
   if(!capacityLanes || slot.reclaimed)return true;
   try {capacityLanes.persist({effectId:slot.effectId,lane:slot.lane,fence:slot.fence,originRef:slot.originRef??null,startedAt:slot.startedAt,state,reason,
    teamId:slot.teamId??null,hostEpoch:slot.hostEpoch??null,attemptId:slot.attemptId??null,
    ...(slot.identityMissing===true?{identityMissing:true}:{}),...(slot.claimKey?{claimKey:slot.claimKey}:{})});return true;}
   catch(error){slot.unknown=true;audit.push({effectId:slot.effectId,stage:'io-index',code:error.code??'ERROR'});return false;}
 };
 // Restart is not a stop proof. Every durable row is one claim; a claim whose identity is incomplete (old storage
 // format, or a pre-atomic claim) is quarantined: it keeps its occupancy and admission closed, but no reclaim can
 // present a full binding for it. startedAt is never regenerated from the restart clock.
 if(capacityLanes) {
   const all=capacityLanes.store.list('effect-io:');
   const rows=all.filter(s=>['held','unknown'].includes(s.state));
   const identity = row => JSON.stringify([row.effectId ?? row.id,row.fence]);
   const indexed=new Set(all.map(identity));
   for(const effect of capacityLanes.store.effects())if(['applying','unknown'].includes(effect.status)&&!indexed.has(identity(effect)))
     rows.push({effectId:effect.id,lane:laneOf(effect),fence:effect.fence,teamId:effect.teamId??null,
       hostEpoch:null,attemptId:effect.payload?.attemptId??null,startedAt:null,identityMissing:true,fromLedger:true});
   for(const row of rows){
     const claimKey=effectIoClaimKey(row.effectId,row.fence);
     const complete=row.identityMissing!==true && row.entityId===claimKey && Number.isSafeInteger(row.fence) &&
       typeof row.startedAt==='number' && Number.isFinite(row.startedAt) && typeof row.teamId==='string' && row.teamId!=='' &&
       row.hostEpoch!==null && row.hostEpoch!==undefined;
     // A recovered slot keeps its real persisted key for every later write (especially stop). Spreading a temporary
     // claimKey into one persist call would let stop write a second composite-key row for the same old-format claim.
     const persistedKey=row.entityId&&row.entityId!==claimKey?row.entityId:undefined;
     const slot={...row,unknown:true,recovered:true,isolate:()=>{},identityMissing:!complete,
       ...(persistedKey?{claimKey:persistedKey}:{})};
     activeIO.add(slot);
     // Keyed rows are updated in place; a ledger claim without an index gets one explicit quarantine row so shared
     // capacity sees the same unknown the runner holds; an old-format row is quarantined in its own row.
     persist(slot,'unknown',complete? 'recovered IO needs termination proof'
       : row.entityId?'legacy IO index has no complete claim identity; quarantined'
       : 'recovered IO has no complete claim identity; quarantined');
   }
 }
 function pumpRoute(safety = null) {
  if (stopped || (capacityLanes && [...activeIO].some(s=>s.unknown))) return { claimed: 0, skipped: 1 };
  // §6.2.4: a verdict root already gave is applied to the ledger before any new work is claimed.
  if (capabilityLayer) {
   try { capabilityLayer.applySettlements(); }
   catch (error) { audit.push({ code: error.code ?? 'ERROR', stage: 'settlements' }); }
  }
  let claimed = 0; let effects;
  try { effects = access.lifecycle().effects(); }
  catch (error) { audit.push({ code: error.code ?? 'ERROR' }); return { claimed: 0, rejected: 1 }; }
  for (const effect of effects) {
    if (safety && effect.id !== safety.subject.effectId) continue;
   const lane=capacityLanes?laneOf(effect):'normal';
   if (capacityLanes ? count(lane)>=(lane==='human'?1:capacity) : activeIO.size>=capacity) {if(capacityLanes)continue;break;}
   if (!['pending', 'retryable'].includes(effect.status) || effect.nextDue > clock.now() || effect.tries >= 5) continue;
   // R9: a known maintenance wait is decided here, before the claim, so waiting never spends a try. The hook only names
   // the scheduling question ("this member cannot run now"); the ledger owns the delay and the refund rule, and a port
   // that discovers the same state after the claim returns deferred evidence instead.
   if (typeof deferrable === 'function') {
     let waiting = false;
     try { waiting = deferrable(effect) === true; } catch (error) { audit.push({ effectId: effect.id, code: error.code ?? 'ERROR' }); }
     if (waiting) {
       try { access.lifecycle().defer(effect.id); }
       catch (error) { audit.push({ effectId: effect.id, code: error.code ?? 'ERROR' }); }
       continue;
     }
   }
   let claim, managed;
   const claimStartedAt = clock.now();
   const claimIdentity = capacityLanes ? Object.freeze({ teamId: teamId ?? null, hostEpoch: epochNow(),
     attemptId: effect.payload?.attemptId ?? null, startedAt: claimStartedAt, lane, originRef: effect.payload?.originRef ?? null }) : null;
   const indexClaim = claimIdentity ? (tx, next) => tx.put(effectIoClaimKey(effect.id, next.fence), {
     effectId: effect.id, lane: claimIdentity.lane, fence: next.fence, originRef: claimIdentity.originRef,
     startedAt: claimIdentity.startedAt, state: 'held', reason: null, teamId: claimIdentity.teamId,
     hostEpoch: claimIdentity.hostEpoch, attemptId: claimIdentity.attemptId }) : null;
   try { const route = safety ?? access.lifecycle(); claim = route.claim(effect.id, 'adapter', timeoutMs + 1, indexClaim).result; managed = route.registerEffect(effect.id, claim.fence); }
   catch (error) { audit.push({ effectId: effect.id, code: error.code }); continue; }
   claimed++;
   // The index committed atomically with the claim; no second write and no crash window between them.
   const slot = { effectId: effect.id, fence:claim.fence, originRef:claim.payload.originRef??null, lane,
     startedAt: claimIdentity?.startedAt ?? claimStartedAt, isolate: null, unknown:false,
     teamId: teamId ?? null, hostEpoch: claimIdentity?.hostEpoch ?? null, attemptId: claimIdentity?.attemptId ?? null };
   activeIO.add(slot);
    const indexed=true;
   let cancel = () => {}; let finish;
   const timeout = new Promise(resolve => { cancel = clock.after(timeoutMs, () => resolve({ unknown: true, reason: 'effect timeout' }), 'effect-timeout'); });
   let isolate; const isolation = new Promise(resolve => { isolate = () => resolve({ unknown: true, reason: 'runner stopped' }); });
   aborts.add(isolate); slot.isolate = isolate;
   const kind = claim.payload.kind;
   const request = Object.freeze(structuredClone({ ...claim.payload, operationId: effect.id }));
   const io = Promise.resolve().then(() => {
    if (!indexed) return {unknown:true,reason:'IO index not durable'};
     if (stopped) return { unknown: true, reason: 'runner stopped before IO' };
    const port = ports[kind];
     // Review 2 #3 / N1: the dispatch authorization is a CHECK, not IO, and it runs before the port. A refusal here
    // proves the effect did not execute - the mailbox hand-over releases a wake attempt and the runner may still claim
    // its start, and "nothing watched what this did" is false when nothing was called at all. Reporting it as unknown
    // is what kept such a start out of the cancellation branch and handed a proven nothing to the operator.
    try { managed.assertDispatch(); }
    catch (error) { return { notExecuted: true, reason: String(error?.message ?? error) }; }
    if (kind === 'release-task') return { executed: true, receipt: {} };
    if (typeof port !== 'function') return { unknown: true, reason: 'missing adapter port' };
     return port(request);
   }).then(value => evidenceOf(value), error => evidenceOf(null, error));
   // P4: the slot is freed only after the outcome is settled. A readback (§6.2.2) is IO like any other, so a capacity
   // released by the timeout while the port, or the readback, is still running would promise concurrency the host does
   // not have. Both halves therefore have to finish; a port that never answers keeps its slot exactly as before.
   let ioDone = false; let closeDone = false;
   const release = () => { if (ioDone && closeDone && (!capacityLanes || slot.terminal) && (!capacityLanes || (!slot.closeIO && !slot.closeUnknown))) {
      if(persist(slot,'released'))activeIO.delete(slot);
    } };
   // closeOut can time out before its readback port returns; join that actual transport too.
   slot.release=release;
   io.then(evidence => { ioDone = true; slot.terminal=Boolean(evidence.executed || evidence.notExecuted || evidence.deferred); release(); }, () => { ioDone = true; release(); });
   // Observe every eventual resolution, but exactly one result may attempt durable close-out.
   const job = Promise.race([io, timeout, isolation]).then(async evidence => {
    cancel(); aborts.delete(isolate);
    if(capacityLanes && evidence.unknown){slot.unknown=true;persist(slot,'unknown',evidence.reason??'IO unknown');}
     let outcome = evidence; let ticket = null;
    if (capabilityLayer) {
      try {
        const decided = await capabilityLayer.closeOut({ effectId: effect.id, kind, tries: claim.tries, evidence, request });
        outcome = decided.evidence; ticket = decided.ticket ?? null;
        if(capacityLanes && evidence.unknown) {
          // A readback/retry policy is not proof that the outstanding transport terminated.
          outcome=evidence;ticket??={code:'EFFECT_READBACK_UNCERTAIN',message:'real IO termination unknown; occupancy retained'};
        }
      } catch (error) { audit.push({ effectId: effect.id, code: error.code ?? 'ERROR', stage: 'capability' }); }
    }
    try { managed.complete(outcome); }
    catch (error) { audit.push({ effectId: effect.id, code: error.code ?? 'ERROR', evidence: outcome }); ticket = null; }
    finally { managed.close(); onReceipt?.(effect.id); }
    // §6.2.4: the decision is opened against the row the settle just wrote.
    if (ticket) capabilityLayer.openTicket({ effectId: effect.id, kind, code: ticket.code, message: ticket.message,
      attempts: claim.tries, evidence: outcome });
   }).catch(error => { audit.push({ effectId: effect.id, code: error.code ?? 'ERROR' }); })
     .finally(() => { closeDone = true; release(); pending.delete(finish); });
   finish = job; pending.add(job);
  }
  // §6.2.4/§6.3: an effect that ended unknown without its decision (a crash between the two writes) gets it here.
  if (capabilityLayer) {
   try { capabilityLayer.sweep(); }
   catch (error) { audit.push({ code: error.code ?? 'ERROR', stage: 'sweep' }); }
  }
  return { claimed, skipped: activeIO.size >= capacity ? 1 : 0 };
 }
 /**
  * R10: the maintenance waits this ledger is holding, with their age. A long wait is a fact to observe, never a failure
  * to escalate: there is no hard limit, but the cumulative deferral count, the first moment of the current wait and the
  * age past alertAfterMs are all visible, per effect and member.
  */
 function deferrals() {
  let rows = [];
  try { rows = access.lifecycle().effects().filter(effect => (effect.defers ?? 0) > 0 && !['confirmed', 'cancelled'].includes(effect.status)); }
  catch { rows = []; }
  const at = clock.now();
  const effects = rows.map(effect => {
   const since = effect.deferredSince ?? null;
   const waitingMs = since === null ? null : Math.max(0, at - since);
   return { effectId: effect.id, kind: effect.payload?.kind ?? null,
     memberId: (typeof memberOf === 'function' ? memberOf(effect) : null) ?? effect.payload?.memberId ?? effect.payload?.recipient ?? null,
     status: effect.status, defers: effect.defers ?? 0, deferredSince: since, waitingMs, nextDue: effect.nextDue ?? null,
     alerting: waitingMs !== null && waitingMs >= alertAfterMs };
  });
  const earliest = effects.reduce((min, effect) => (effect.deferredSince === null ? min
    : min === null ? effect.deferredSince : Math.min(min, effect.deferredSince)), null);
  return { alertAfterMs, waiting: effects.length, totalDefers: effects.reduce((count, effect) => count + effect.defers, 0),
    earliestDeferredSince: earliest, alerting: effects.filter(effect => effect.alerting).length, effects: structuredClone(effects) };
 }
 /** Read-only completion barrier for one durable effect. Never pumps IO or confers stop/release authority. */
 async function waitForEffect(effectId,{timeoutMs,pollMs=10,signal=null}={}) {
   if(typeof effectId!=='string'||!effectId||!Number.isFinite(timeoutMs)||timeoutMs<0||!Number.isFinite(pollMs)||pollMs<=0)
     failWith('INVALID_CONFIG','waitForEffect needs an effect ID, finite timeoutMs >= 0 and pollMs > 0');
   const deadline=performance.now()+timeoutMs;let last=null;
   for(;;){
     // Shutdown wins over abort, terminal reads and deadlines; host.stop closes lifecycle reads.
     if(stopped||['stopping','stopped','isolated'].includes(access.describe?.().lifecycle?.states))
       throw Object.assign(Error('runner or host stopped while waiting for '+effectId),{code:'RUNNER_STOPPED',effectId,lastEffect:structuredClone(last)});
     if(signal?.aborted)throw signal.reason??Object.assign(Error('effect wait aborted'),{code:'ABORT_ERR'});
     last=access.lifecycle().effects().find(e=>e.id===effectId)??null;
     if(['confirmed','cancelled','dead-letter'].includes(last?.status))return structuredClone(last);
     const remaining=deadline-performance.now();
     if(remaining<=0)throw Object.assign(Error('effect '+effectId+' did not reach terminal state before deadline'),
       {code:'EFFECT_WAIT_TIMEOUT',effectId,lastStatus:last?.status??'missing',lastEffect:structuredClone(last)});
     await new Promise((resolve,reject)=>{
       const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal.reason??Object.assign(Error('effect wait aborted'),{code:'ABORT_ERR'}));};
       const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},Math.min(pollMs,remaining));
       signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
     });
   }
 }
 return Object.freeze({ waitForEffect, async reclaim(effectId, evidenceRef, options = {}) {
   const candidates = [...activeIO].filter(item => item.effectId === effectId);
   if (!candidates.length) failWith('UNKNOWN_IO', 'no occupied claim for this effect');
   const fence = options?.fence;
   // A reclaim names one claim. effectId alone is accepted only while exactly one claim of that effect is occupied; a
   // second fence must be named explicitly rather than freeing whichever slot happened to be first.
   if ((fence === undefined || fence === null) && candidates.length > 1)
     failWith('CLAIM_REQUIRED', 'several claims exist for this effect; reclaim must name the fence');
   const slot = fence === undefined || fence === null ? candidates[0] : candidates.find(item => item.fence === fence);
   if (!slot) failWith('UNKNOWN_IO', 'no occupied claim for this effect and fence');
   // A quarantined claim has no complete durable identity (old format / pre-atomic claim). It keeps its occupancy, but
   // no fully bound proof may be manufactured for it.
   if (slot.identityMissing === true)
     failWith('CLAIM_IDENTITY_MISSING', 'this claim has no complete durable identity; operator migration is required');
   if (typeof verifyStopped !== 'function' || typeof evidenceRef !== 'string' || !evidenceRef ||
     await verifyStopped({ ...subjectOf(slot), evidenceRef }) !== true) failWith('STOP_NOT_CONFIRMED', 'trusted external stop proof is required');
   if(!activeIO.has(slot))failWith('UNKNOWN_IO','IO claim changed while verifying termination');
    if(!persist(slot,'released','trusted external stop: '+evidenceRef))failWith('STOP_NOT_CONFIRMED','termination index not durable');
    slot.reclaimed=true;slot.isolate();activeIO.delete(slot);
   audit.push({ effectId, fence: slot.fence, evidenceRef, code: 'EXTERNAL_STOP_CONFIRMED' });
   return true;
  }, pump: () => pumpRoute(), pumpSafety(capability) {
   if (!capability || capability.route !== 'safety' || !capability.subject?.effectId) failWith('INVALID_SAFETY', 'pumpSafety needs a bound safety capability');
   return pumpRoute(capability);
  }, stop() { stopped = true; if(capacityLanes)for(const slot of activeIO){slot.unknown=true;persist(slot,'unknown','runner stop is logical isolation only');} for (const isolate of aborts) isolate(); },
  /** Current-batch idle only: joins the pending-job snapshot at invocation, not future retries/deferrals,
   * later pumps, native IO still running after timeout, business completion, or execution-stop proof.
   * waitForEffect(id,{timeoutMs}) observes a bounded durable terminal state; callers still own pumping. */
  async whenIdle() { await Promise.all([...pending]); },
  status: () => ({ stopped, ...(capacityLanes?{lanes:{normal:{current:count('normal'),limit:capacity,unknown:[...activeIO].filter(s=>s.lane==='normal'&&s.unknown).length},human:{current:count('human'),limit:1,unknown:[...activeIO].filter(s=>s.lane==='human'&&s.unknown).length}},admissionClosed:[...activeIO].some(s=>s.unknown),queue:capacityLanes.queue?.()??null}:{}), pending: pending.size, activeIO: activeIO.size, occupants: [...activeIO].map(({ effectId, startedAt, lane, unknown, originRef }) => ({ effectId, startedAt, ...(capacityLanes?{lane,unknown,originRef:originRef??null}:{}), durationMs: Math.max(0, clock.now() - startedAt) })), deferrals: deferrals(), audit: structuredClone(audit) }) });
}
