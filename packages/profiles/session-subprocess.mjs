import { AsyncLocalStorage } from 'node:async_hooks';
// The adapter's public entry, not its private build-target module: the build selection is the adapter's to resolve, and
// loadBuild() imports exactly the module instance the Loader boots (the same URL this file used to compute by hand).
import { loadBuild } from '../adapter-dsh/index.mjs';

/**
 * In-process execution shutdown. Authority comes only from the durable sealed E registry,
 * never from cancel/idle, dispatch headers or an empty process-tree sample.
 * All spawn calls reserve before entering the provider (including async creation).
 * Without native Windows containment, spawning invalidates descendant-range completeness:
 * direct-child readback is useful cleanup/diagnostics but cannot certify grandchildren.
 */

/** The carrier the task asked for: a spawn inside this scope is attributed to the member it was opened for. */
export const memberScope = new AsyncLocalStorage();

export const withMember = (memberId, sessionId, work) => memberScope.run({ memberId, sessionId }, work);

/** The member a spawn belongs to: the explicit scope first, then the runtime's own host-attribution API. */
export function attributeSpawn(readInitiator) {
  const scoped = memberScope.getStore();
  if (scoped && typeof scoped.memberId === 'string') return { memberId: scoped.memberId, sessionId: scoped.sessionId ?? null, basis: 'scope' };
  let sessionId = null;
  try { sessionId = readInitiator() ?? null; } catch { sessionId = null; }
  return { memberId: null, sessionId, basis: sessionId === null ? 'none' : 'initiator' };
}

/**
 * Every handle the session's tools spawned, with the member it belonged to.
 *
 * `settled` is attached once, at record time, from the handle's own `done` promise; it is a cheap liveness hint for
 * the unattributed set, never the proof itself (the proof is `waitForExit`, because a managed range can outlive the
 * command that opened it).
 */
export function createSubprocessTracker() {
  const entries = new Set(), audit = [];
  let retired = 0;
  const retire = (entry, reason) => {
    if (!entries.delete(entry)) return false;
    audit.push({ kind: entry.kind, memberId: entry.memberId, sessionId: entry.sessionId,
      basis: entry.basis, at: entry.at, endedAt: Date.now(), reason });
    if (audit.length > 256) audit.shift();
    retired++;
    entry.handle = null;
    entry.scope?.finish(entry.permit);entry.scope=null;entry.permit=null;
    return true;
  };
  const checkExit = async entry => {
    const handle = entry.handle;
    if (typeof handle?.waitForExit !== 'function') return false;
    try {
      const result = await bounded(handle.waitForExit(AbortSignal.timeout(100)), 150);
      if (result.ok && result.value === true) return retire(entry, 'range-exited');
    } catch { /* done alone does not prove the managed range is empty */ }
    return false;
  };
  return Object.freeze({
    record(handle, kind, { memberId = null, sessionId = null, basis = 'none', scope = null, permit = null } = {}) {
      if (!handle || typeof handle !== 'object') return null;
      const entry = { handle, kind, memberId, sessionId, basis, scope, permit, at: Date.now(), settled: false };
      entries.add(entry);
      if (handle.done && typeof handle.done.then === 'function') Promise.resolve(handle.done).then(
        () => { entry.settled = true; void checkExit(entry); },
        () => { entry.settled = true; void checkExit(entry); });
      return entry;
    },
    retire: entry => retire(entry, 'stop-proof'),
    all: () => [...entries],
    forMember: memberId => [...entries].filter(entry => entry.memberId === memberId),
    unattributed: () => [...entries].filter(entry => entry.memberId === null),
    size: () => entries.size,
    audit: () => audit.slice(),
    retired: () => retired,
  });
}

/** Account requests per (attempt, transmission), never delete siblings on one answer. */
export function createDispatchTracker({scopes=null}={}) {
  const sessions = new Map(), declared = new Set();
  return Object.freeze({
    observe(event) {
      if (!event || event.contract !== 'team-dispatch/2' || typeof event.sessionId !== 'string' || !event.sessionId ||
        typeof event.attempt !== 'string' || !event.attempt) return false;
      declared.add(event.sessionId);
      const scope=scopes?.get(event.sessionId);
      if(scope && event.phase==='send-started' && !scope.activities('transmission').some(x=>x.dispatchAttemptId===event.attempt && x.transmissionId===event.transmission))scope.invalidate('unpermitted-transport');
      if (!['send-started', 'committed', 'failed'].includes(event.phase)) return true;
      const transmissions = sessions.get(event.sessionId) ?? new Map();
      sessions.set(event.sessionId, transmissions);
      const tx = Number.isSafeInteger(event.transmission) && event.transmission > 0 ? event.transmission : null;
      const key = JSON.stringify([event.attempt, tx]);
      if (event.phase === 'send-started') transmissions.set(key, { attempt: event.attempt, transmission: tx,
        phase: event.phase, kind: event.kind ?? null, at: event.at ?? null });
      else if (tx !== null && event.phase === 'committed') transmissions.delete(key);
      // failed after send-started remains unknown; an unnamed answer cannot clear an unnamed send.
      return true;
    },
    open: sessionId => scopes ? (scopes.get(sessionId)?.activities('transmission')??[]) : [...(sessions.get(sessionId)?.values() ?? [])],
    declared: sessionId => declared.has(sessionId),
    sessions: () => [...sessions.keys()],
  });
}

const timer = ms => new Promise(resolve => { const handle = setTimeout(resolve, Math.max(1, ms)); handle.unref?.(); });

/** Run one promise with a bound; the answer says whether it finished, never whether it "probably" did. */
async function bounded(promise, ms) {
  try {
    const value = await Promise.race([Promise.resolve(promise), timer(ms).then(() => Symbol.for('timeout'))]);
    if (value === Symbol.for('timeout')) return { ok: false, timedOut: true, value: null };
    return { ok: true, timedOut: false, value };
  } catch (error) {
    return { ok: false, timedOut: false, value: null, error: error?.code ?? error?.message ?? String(error) };
  }
}

/** One recorded child: terminate the provider's managed range, then observe it empty. */
async function settleHandle(entry, budgetMs) {
  const deadline=Date.now()+budgetMs;
  const remaining=()=>Math.max(1,deadline-Date.now());
  const handle = entry.handle;
  if (!handle) return { kind: entry.kind, memberId: entry.memberId, terminated: false, exited: true, error: null };
  const outcome = { kind: entry.kind, memberId: entry.memberId, terminated: false, exited: false, error: null };
  try {
    if (typeof handle.terminate === 'function') {
      // Terminal handles await quiescence in terminate(); ordinary handles start the provider's staged kill and return.
      const stopped = await bounded(handle.terminate(), remaining());
      if (!stopped.ok) { outcome.error = 'STOP_PROOF_TIMEOUT'; return outcome; }
      outcome.terminated = true;
    }
    if (typeof handle.waitForExit === 'function') {
      const exited = await bounded(handle.waitForExit(AbortSignal.timeout(remaining())), remaining());
      outcome.exited = exited.ok && exited.value === true;
      if (!outcome.exited) outcome.error = 'STOP_PROOF_TIMEOUT';
      return outcome;
    }
    // A terminal handle has no waitForExit: terminate() already awaited quiescence, and `done` names the top process.
    const done = entry.settled ? { ok: true } : await bounded(handle.done, remaining());
    outcome.exited = done.ok === true;
    if (!outcome.exited) outcome.error = 'STOP_PROOF_TIMEOUT';
    return outcome;
  } catch (error) {
    outcome.error = error?.code ?? 'STOP_NOT_VERIFIED';
    return outcome;
  }
}

/**
 * The in-process prover: the stop-proof port the profile installs as `core.ports.stopProof`.
 *
 * Every branch that cannot prove something returns `verified:false` with the reason; the caller (native.mjs) turns
 * that into an unknown member plus the stuck-member decision, never into a retirement.
 */
export function createInProcessStopProver({ tracker, dispatch, agentOf, scopes } = {}) {
  if (!tracker || !dispatch || typeof agentOf !== 'function') throw Error('INVALID_CONFIG: stop services required');
  const jobs=new WeakMap(),completed=new WeakMap(),latest=new Map();
  return function prove({subject,graceMs=5000,proofTimeoutMs=10000,agent:exact=null,operation='cancel',E:expected=null,stopId:expectedStopId=null}={}) {
    const at=Date.now(),deadline=at+Math.max(0,graceMs)+Math.max(1,proofTimeoutMs);
    const memberId=subject?.kind==='member-session'?subject.id:null;
    const agent=exact??agentOf(memberId),scope=expected?scopes?.byExecution(expected):scopes?.get(agent?.session?.id);
    const blank={kind:'stop-proof',subject,verified:false,stopState:'unverified',confidence:'low',at,
      method:'sealed-execution',error:{code:'EXECUTION_SCOPE_MISSING',message:'no recoverable execution registry; occupancy retained'}};
    if(expected && (expected.memberId!==memberId || expected.generation!==subject?.fence))return Promise.resolve(blank);
    if(expected){const result=scopes?.stopResult(expected,expectedStopId);if(result?.proof)return Promise.resolve({...result.proof,subject,closeoutResult:result});}
    if(!scope || scope.E.memberId!==memberId || scope.E.generation!==subject.fence) {
      if(expected)return Promise.resolve(blank);
      const prior=(agent&&completed.get(agent))??latest.get(memberId),result=prior?.scope.stopResult();
      return Promise.resolve(result?.proof && prior.scope.E.memberId===memberId && prior.scope.E.generation===subject?.fence ? {...result.proof,subject,closeoutResult:result} : blank);
    }
    // Persist arbitration before seal observers or the first await can run automatic completion.
    if(expectedStopId && scope.snapshot().stopId!==expectedStopId)return Promise.resolve(blank);
    scope.beginStop(operation==='dispose'||operation==='retire'?'retire':'cancel');
    const captured={E:scope.E,stopId:scope.snapshot().stopId};
    const recheck=()=>{const result=scopes?.stopResult?.(captured.E,captured.stopId)??scope.stopResult();if(result?.proof)return {...result.proof,subject,closeoutResult:result};if(scopes?.get(agent?.session?.id)!==scope || scope.snapshot().stopId!==captured.stopId)return {...blank,error:{code:'STALE_EXECUTION_STOP',message:'captured execution no longer current'}};return null;};
    const result=scope.stopResult();if(result?.proof)return Promise.resolve({...result.proof,subject,closeoutResult:result});
    if(jobs.has(scope))return jobs.get(scope);
    let resolve,reject;const job=new Promise((yes,no)=>{resolve=yes;reject=no;});jobs.set(scope,job);
    const work=async()=>{
    try { agent.cancel({keepInbox:true}); } catch { scope.invalidate('cancel-failed'); }
    const idle=await bounded(agent.whenIdle(),Math.max(1,deadline-Date.now()));
    const changed=recheck();if(changed)return changed;
    if(!idle.ok)scope.invalidate('idle-unverified');
    const handles=[],registered=tracker.forMember(memberId),unattributed=tracker.unattributed();
    for(const entry of registered) {
      if(Date.now()>=deadline)break;
      const settled=await settleHandle(entry,Math.max(1,deadline-Date.now()));handles.push(settled);const changed=recheck();if(changed)return changed;
      if(settled.error)scope.invalidate('cleanup-error');
      if(settled.exited)tracker.retire(entry);
    }
    let unattributedAlive=0;
    for(const entry of unattributed) {
      if(!entry.handle)continue;
      if(Date.now()>=deadline){unattributedAlive++;continue;}
      const read=await bounded(entry.handle?.waitForExit?.(AbortSignal.timeout(Math.max(1,deadline-Date.now()))),Math.max(1,deadline-Date.now()));
      const changed=recheck();if(changed)return changed;
      if(read.ok&&read.value===true)tracker.retire(entry);else unattributedAlive++;
    }
    if(unattributed.length)scope.invalidate('unattributed-process');
    if(idle.ok)scope.confirmQuiescentEntries();
    const proof=scope.prove(subject);
    if(!idle.ok)proof.error={code:'STOP_PROOF_TIMEOUT',message:'whenIdle did not finish within total stop deadline'};
    else if(!proof.verified)proof.error={code:'STOP_NOT_VERIFIED',message:unattributed.length?'process has no owning member; range incomplete':'execution range incomplete or active permits remain'};
    return {...proof,checks:{idle:{ok:idle.ok},llm:{basis:dispatch.declared(agent.session.id)?'dispatch':'loop',sessionId:agent.session.id,open:dispatch.open(agent.session.id)},
      children:{registered:registered.length,terminated:handles.filter(h=>h.terminated).length,exited:handles.filter(h=>h.exited).length,alive:registered.length-handles.filter(h=>h.exited).length,unattributed:unattributed.length,unattributedAlive,
        handles:handles.map(({kind,terminated,exited,error})=>({kind,terminated,exited,error}))}}};
    };
    work().then(proof=>{jobs.delete(scope);completed.set(agent,{scope});latest.set(memberId,{scope});resolve(proof);},error=>{jobs.delete(scope);reject(error);});
    return job;
  };
}

/**
 * Load the local subprocess provider out of the selected build and subclass it (SPI: "Subclass, implement spawn, and
 * load the subclass as a plugin"). `attribute` is called at spawn time and returns the member the handle belongs to.
 *
 * P5b defect fix (appendix 4): the tracker is closed over the class, never held in a `#private` field.
 *
 * cordis does not hand a consumer the object the plugin constructor built: a service is served per context inside a
 * Proxy (`createTraceable` in the upstream cordis, which also wraps each method so the call keeps the caller's context),
 * and a method invoked through it runs with `this` set to that Proxy - which is not branded by a subclass's private
 * fields, because a Proxy is not an instance of anything.
 * The e2e showed the exact symptom: the child process really started (its heartbeat file appeared) and the very next
 * line, `this.#track(handle, 'spawn')`, threw "Cannot read private member #track from an object whose class did not
 * declare it" - so the spawn was never recorded, the tracker stayed empty, and the proof could only ever say
 * "no handles". Nothing per instance is needed here anyway: one installed runtime owns exactly one tracker.
 */
const recordHandle = (tracker, attribute, handle, kind) => {
  let verdict = { memberId: null, sessionId: null, basis: 'none' };
  try { verdict = attribute() ?? verdict; } catch { /* attribution never fails a spawn */ }
  tracker.record(handle, kind, verdict);
};

/** Factory also used by integration tests: reservation precedes BOTH provider methods. */
export function scopedSubprocessRuntime(Base,tracker,attribute,scopes) {
  const reserve=kind=>{
    const verdict=attribute()??{},scope=scopes?.resolve(verdict.sessionId);
    if(!scope) {
      for(const active of scopes?.all()??[])active.invalidate('unattributed-process');
      throw Object.assign(Error('EXECUTION_SCOPE_MISSING'),{code:'EXECUTION_SCOPE_MISSING'}); // never execute an unattributable late spawn
    }
    // A wrapped direct child is not proof of its grandchildren. Tree scanning remains diagnostic only.
    scope.coverage('subprocess',false);
    return {...verdict,scope,permit:scope.acquire(kind)};
  };
  return class SessionSubprocessRuntime extends Base {
    spawn(spec) {
      const reservation=reserve('spawn');
      try {const handle=super.spawn(spec);tracker.record(handle,'spawn',reservation);return handle;}
      catch(error){reservation.scope?.finish(reservation.permit,'unknown');throw error;}
    }
    async spawnTerminal(spec) {
      const reservation=reserve('pending-spawn');
      try {const handle=await super.spawnTerminal(spec);tracker.record(handle,'terminal',reservation);return handle;}
      catch(error){reservation.scope?.finish(reservation.permit,'unknown');throw error;}
    }
  };
}
export async function loadSessionRuntime(tracker,attribute,scopes) {
  const module=await loadBuild('dsh-subprocess-local'),Base=module.default??module.LocalSubprocessRuntime;
  if(typeof Base!=='function')throw Error('NO_SUBPROCESS_PROVIDER');
  return scopedSubprocessRuntime(Base,tracker,attribute,scopes);
}

