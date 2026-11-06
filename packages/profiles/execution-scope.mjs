import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { executionIdentity, sameExecution, executionScopeId } from '../contracts/index.mjs';
const context = new AsyncLocalStorage();
const refused = code => Object.assign(Error(code), { code });
/** One authority for E/T/C/X, reservations, sealing and certificates. No inference from empty samples. */
export function createExecutionScopes({ persist = () => {}, read = () => null, clock = Date.now } = {}) {
  const scopes = new Map(), sessions = new Map();
  const api = {
    open(identity, coverage = {}) {
      const E = executionIdentity({ ...identity, executionEpoch: identity.executionEpoch ?? randomUUID() });
      const prior = sessions.get(E.executionSessionId);
      if (prior && prior.state() !== 'RELEASED') throw refused('EXECUTION_ALREADY_OPEN');
      if (read('execution-current:' + E.attemptId)?.state !== undefined && read('execution-current:' + E.attemptId).state !== 'RELEASED') throw refused('EXECUTION_RECOVERY_REQUIRED');
      let state = 'OPEN', version = 0, stopId = null, certificateId = null, currentTurn = null, lastEndedTurn = null, proofCache = null, historicalUnknown = 0, closeoutPurpose = null, turnFault = null;
      const active = new Map(), uncertain = new Map(), tokens = new WeakMap(), listeners = new Set();
      const coverageFacts = { gates: false, attribution: false, transport: false, subprocess: false, ...coverage }, coverageGaps = new Set();
      const snapshot = () => ({ E, state, version, stopId, closeoutPurpose, certificateId, currentTurn, lastEndedTurn, historicalUnknown,
        active: active.size, uncertain: uncertain.size, ...(turnFault ? { turnFault } : {}), coverageGaps: [...coverageGaps].sort(), coverage: { ...coverageFacts, complete: Object.values(coverageFacts).every(v => v === true) } });
      const publish = () => {
        version++;
        try { persist(snapshot()); } catch (error) {
          state = 'UNVERIFIED'; stopId ??= randomUUID(); coverageFacts.persistence = false;coverageGaps.add('persistence');
          throw error; // no permit escapes after a failed reservation or seal write
        }
        for (const fn of listeners) { try { fn(snapshot()); } catch { /* observers do not confer authority */ } }
      };
      const check = () => {
        if(state==='OPEN' && read('execution-finish:'+E.executionEpoch)?.state==='requested')domain.seal();
        if (state !== 'OPEN') throw refused('EXECUTION_SEALED'); };
      const domain = {
        E, state: () => state, snapshot, run: work => context.run(domain, work),
        coverage(key, value) { if (state === 'RELEASED') return;
          if(value===true && coverageGaps.has(key))throw refused('COVERAGE_GAP_IRREVERSIBLE');
          if(value!==true)coverageGaps.add(key);
          if (state !== 'OPEN' && value === true && coverageFacts[key] !== true) throw refused('COVERAGE_SEALED');
          coverageFacts[key] = value === true; if (state === 'PROVEN' && value !== true) state = 'UNVERIFIED'; publish(); },
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        acquire(kind, identity = {}) {
          check(); const id = randomUUID(), token = Object.freeze({ ...identity, E, kind, id });
          tokens.set(token, id); active.set(id, { kind, identity }); publish(); return token;
        },
        finish(token, outcome = 'executed') {
          if (!['executed','notExecuted','unknown'].includes(outcome)) throw refused('INVALID_EXECUTION_OUTCOME');
          const id = tokens.get(token); if (!id || !active.has(id)) return false;
          active.delete(id); if (outcome === 'unknown') {historicalUnknown++;uncertain.set(id, { kind: token.kind, identity: token });}
          publish(); return true;
        },
        resolve(token, outcome) { const id = tokens.get(token); if (!id || !['executed','notExecuted'].includes(outcome)) return false; const changed = uncertain.delete(id); if(changed) publish(); return changed; },
        async perform(kind, work, identity = {}) {
          const token = domain.acquire(kind, identity);
          try { const value = await domain.run(() => work(token)); domain.finish(token); return value; }
          catch (error) { domain.finish(token, 'unknown'); throw error; }
        },
        startTurn(turnId = randomUUID()) { if (currentTurn !== null) throw refused('TURN_ALREADY_OPEN'); const token = domain.acquire('turn', { turnId }); currentTurn = turnId; lastEndedTurn = null; publish(); return token; },
        endTurn(token) { if (!tokens.has(token) || token.turnId !== currentTurn || token.kind !== 'turn') return false; currentTurn = null; lastEndedTurn = token.turnId; return domain.finish(token); },
        call() {
          const callId = randomUUID(), producer = domain.acquire('call', { callId }), transmissions = new Set(), owned = new WeakSet(), networkTokens = new Set();
          let networkSerial=0;
          const reserve = (attemptId,transmissionId) => {
            check();if(!active.has(producer.id))throw refused('CALL_CLOSED');
            const key=JSON.stringify([attemptId,transmissionId]);
            if(!attemptId || transmissionId==null || transmissions.has(key))throw refused('INVALID_TRANSMISSION');
            transmissions.add(key);const token=domain.acquire('transmission',{callId,dispatchAttemptId:attemptId,transmissionId});owned.add(token);return token;
          };
          return Object.freeze({ E, callId, reserve, finish:(token,outcome)=>owned.has(token) && domain.finish(token,outcome),
            unmanaged:()=>domain.invalidate('transport'),
            async network(work){
              const token=reserve('network:'+callId,++networkSerial);
              try {const value=await work();networkTokens.add(token);return value;}
              catch(error){domain.finish(token,'unknown');throw error;}
            },
            send: (attemptId, transmissionId, work) => { check(); if (!active.has(producer.id)) throw refused('CALL_CLOSED');
              const key = JSON.stringify([attemptId,transmissionId]);
              if (!attemptId || transmissionId == null || transmissions.has(key)) throw refused('INVALID_TRANSMISSION');
              transmissions.add(key); return domain.perform('transmission', work, { callId, dispatchAttemptId: attemptId, transmissionId }); },
            close: (outcome='executed') => {for(const token of networkTokens)domain.finish(token,outcome);networkTokens.clear();return domain.finish(producer);},
          });
        },
        beginStop(purpose) {
          if(!['complete','cancel','retire'].includes(purpose))throw refused('INVALID_CLOSEOUT_PURPOSE');
          if(state==='RELEASED')return domain.stopResult();
          // A destructive stop wins over unconsumed completion; later stops join the first destructive purpose.
          if(!closeoutPurpose || (closeoutPurpose==='complete' && purpose!=='complete')) {
            closeoutPurpose=purpose;stopId??=randomUUID();
            if(state==='PROVEN'){state='DRAINING';certificateId=null;proofCache=null;}
            publish();
          }
          domain.seal(stopId??undefined);return {purpose:closeoutPurpose,stopId};
        },
        stopResult() { const row=read(executionScopeId(E));return row?.state==='RELEASED'?row.closeoutResult??null:null; },
        seal(id = randomUUID()) {
          if (state === 'RELEASED') throw refused('EXECUTION_RELEASED');
          if (state !== 'OPEN') return stopId;
          stopId = id; state = 'SEALING'; publish(); state = 'DRAINING'; publish(); return stopId;
        },
        prove(subject) {
          if(state==='PROVEN')return proofCache;
          if (!['DRAINING','UNVERIFIED'].includes(state)) throw refused('EXECUTION_NOT_SEALED');
          const complete = snapshot().coverage.complete;
          state = complete && active.size === 0 && uncertain.size === 0 ? 'PROVEN' : 'UNVERIFIED';
          certificateId = state === 'PROVEN' ? randomUUID() : null; publish();
          return proofCache = { kind: 'stop-proof', contract: 'execution-stop/1', E, subject, stopId, scopeVersion: version,
            certificateId, coverage: snapshot().coverage, verified: state === 'PROVEN', stopState: state === 'PROVEN' ? 'proven' : 'unverified',
            confidence: state === 'PROVEN' ? 'medium' : 'low', method: 'sealed-execution', at: clock(), writtenBy: 'adapter', switch: 'on',
            error: state === 'PROVEN' ? null : { code: 'EXECUTION_UNVERIFIED', message: 'scope incomplete or permits remain; occupancy retained' } };
        },
        released(proof) { const durable = read(executionScopeId(E));
          if (!sameExecution(proof?.E, E) || !sameExecution(durable?.E,E) || durable?.state !== 'RELEASED' || durable.stopId !== stopId || durable.consumedCertificate !== proof.certificateId) throw refused('RELEASE_NOT_COMMITTED');
          state = 'RELEASED'; version = durable.version; active.clear();uncertain.clear();listeners.clear(); scopes.delete(E.executionEpoch); if (sessions.get(E.executionSessionId) === domain) sessions.delete(E.executionSessionId);
        },
        rejectTurn(error) {
          if(state==='RELEASED')return;
          turnFault??={code:error?.code??'TURN_EVENT_REJECTED',message:String(error?.message??error),at:clock()};
          coverageGaps.add('unpermitted-turn');coverageFacts['unpermitted-turn']=false;
          state='UNVERIFIED';stopId??=randomUUID();certificateId=null;proofCache=null;publish();
        },
        invalidate(reason) { if (state === 'RELEASED') return; coverageGaps.add(reason);coverageFacts[reason] = false; if (state === 'PROVEN') state = 'UNVERIFIED'; publish(); },
        // Stop reconciliation is not an executed/notExecuted receipt. Physical IO uncertainty stays held.
        confirmQuiescentEntries() {
          if(!['DRAINING','UNVERIFIED'].includes(state) || active.size || !snapshot().coverage.complete)return false;
          let changed=false;
          for(const [id,entry]of uncertain)if(['effect','followup','wakeDriver','preemptStep','tool'].includes(entry.kind)){uncertain.delete(id);changed=true;}
          if(changed)publish();return changed;
        },
        activities: kind => [...active.values(),...uncertain.values()].filter(x=>x.kind===kind).map(x=>({...x.identity})),
        assertOpen: check,
      };
      scopes.set(E.executionEpoch, domain); sessions.set(E.executionSessionId, domain); publish(); return domain;
    },
    get: sessionId => sessions.get(sessionId) ?? null,
    byExecution(E) { const scope=scopes.get(E?.executionEpoch);return sameExecution(scope?.E,E)?scope:null; },
    stopResult(E,id) { const row=read(executionScopeId(E));return sameExecution(row?.E,E)&&row.state==='RELEASED'&&row.stopId===id?row.closeoutResult??null:null; },
    captureStop(sessionId,purpose,expected=null) {
      const scope=sessions.get(sessionId);if(!scope || (expected&&!sameExecution(scope.E,expected)))return null;
      scope.beginStop(purpose);return Object.freeze({E:scope.E,stopId:scope.snapshot().stopId});
    },
    // Absence is not expiry. An inherited identity must never fall through to a new session binding.
    resolve(sessionId = null) {
      const inherited=context.getStore();
      if(inherited !== undefined) {
        if(scopes.get(inherited.E.executionEpoch)!==inherited || sessions.get(inherited.E.executionSessionId)!==inherited || inherited.state()==='RELEASED')throw refused('EXECUTION_CONTEXT_STALE');
        if(sessionId && inherited.E.executionSessionId!==sessionId)throw refused('EXECUTION_CONTEXT_MISMATCH');
        return inherited;
      }
      return sessionId ? sessions.get(sessionId)??null : null;
    },
    current: () => api.resolve(),
    all: () => [...scopes.values()],
    detach(sessionId) { const scope = sessions.get(sessionId); if(scope) { scope.invalidate('detached'); scope.seal(); } },
  };
  return Object.freeze(api);
}
