import test from 'node:test';
import { profile, until } from '../test-support/profile.mjs';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
// Windows may allocate low ephemeral ports on Fetch's blocked-port list (e.g. 6000). Do not mistake that for a transport failure.

export const fetchBlockedPorts=new Set([1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,101,102,103,104,109,110,111,113,115,117,119,123,135,137,
  139,143,161,179,389,427,465,512,513,514,515,526,530,531,532,540,548,554,556,563,587,601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,5060,5061,6000,6566,
  6665,6666,6667,6668,6669,6697,10080]);
export async function listenFetchable(server){for(let n=0;n<10;n++){server.listen(0,'127.0.0.1');await once(server,'listening');if(!fetchBlockedPorts.has(
  server.address().port))return;await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}throw Error(
  'no Fetch-compatible ephemeral port in ten allocations');}
import { real } from '../test-support/real.mjs';
import { createVisibility } from '../index.mjs';
import { createEffectRunner } from '../src/effect-runner.mjs';
import { withdrawManifest } from '../src/visibility/dispatch.mjs';
import { preStep, requestBoundary } from '../../core/index.mjs';
import { visibilityDirty } from '../src/visibility/dirty.mjs';
import { createVisibilityQueue } from '../src/visibility/queue.mjs';
import { DISPATCH_CONTRACT, DISPATCH_EVENT, DispatchEvidenceLedger, publishDispatchEvent, summariseDispatchMessages } from '../../contracts/index.mjs';

/** The route the host would report, mutable so a test can rebind it while a request is in flight. */
export async function fixture(intent = false, teamId = 'team:b', options = {}) {
 const w = await real({ teamId }); w.core.configuration.teamId = teamId;
 w.core.member('member:a', 'worker'); w.core.member('member:b', 'worker');
 w.core.configuration.collab = 'on'; w.core.configuration.intentWindowMs = 1000;
 if(intent) w.core.task('task:a', 'member:a');
 const id = w.core.send('member:a', intent ? ['member:b'] : 'member:b', intent ? 'intent' : 'info', 'visible only after headers', intent ? {taskRef:'task:a',
   contractRevision:1} : {}).result.entityId;
 const session = { seq: 10, events: [], snapshotEvents() { return this.events; } };
 const routed = { memberId: options.routeMember ?? 'member:b', generation: options.routeGeneration ?? 1 };
 const v = createVisibility({ host: w.host, core: w.core, sessions: new Map([['session:b',session]]),
  routeExecution: sessionId => ({ routed: sessionId === 'session:b', teamId, memberId: routed.memberId, generation: routed.generation }),
  isMain: o => o.main && o.purpose === undefined, leaseMs: 100,
  ...(options.ledger ? { ledger: options.ledger } : {}), ...(options.queue ? { queue: options.queue } : {}) });
 const message = await v.preStep('session:b','native:1');
 session.events.push({type:'user/message',seq:5,data:{id:message.id,content:message.content}});
 const release = v.candidate({sessionId:'session:b',main:true,messages:[message]});
 const base = {contract:'team-dispatch/2',attempt:options.attempt ?? 'dispatch:1',sessionId:'session:b',kind:'main',purpose:null,messages:
   summariseDispatchMessages([message]), at:w.at};
 const emit = (phase, extra={}) => v.dispatch({...base,phase,...(['send-started','committed'].includes(phase)?{transmission:1,sendStartedAt:w.at}:{}),
   ...extra},'real-cpa-transport');
 return {...w,get at(){return w.at},set at(value){w.at=value},v,session,id,message,base,emit,release,
  setGeneration(n){routed.generation=n}, setMember(memberId){routed.memberId=memberId},
  seen(){return Boolean(w.store.read(id).visible);}};
}

for (const kind of ['budget-rejected','next-not-called','cancel-before-send','adapter-prepare-failed','first-chunk','pending']) test('F9 no visibility: '+kind,
  async()=>{
 const w=await fixture(); try {
  const before=w.snapshot(); await w.emit('prepared');
  let entered=0, chunks=0; const abort=new AbortController(); if(kind==='cancel-before-send')abort.abort();
  const adapter=(async function*(){
    entered++;
    if(kind==='budget-rejected')throw Error('budget rejected before transport');
    abort.signal.throwIfAborted();
    if(kind==='adapter-prepare-failed')throw Error('adapter preparation failed');
    yield {type:'failure',message:'synthetic middleware chunk'};
  })();
  if(!['next-not-called','pending'].includes(kind)){
    try{for await(const chunk of adapter){chunks++;assert.equal(chunk.type,'failure');assert.equal(w.seen(),false)}}
    catch{await w.emit('failed',{reason:kind})}
  }
  assert.equal(entered,['next-not-called','pending'].includes(kind)?0:1);assert.equal(chunks,kind==='first-chunk'?1:0);
  // Review 2 #5: a failure diagnosis now goes through the bounded, persisted audit entry point, so the store may carry a
  // visibility-audit row (and its journal event) that it did not carry before. Nothing business-visible may change, and
  // nothing may become visible - that is what this comparison is for.
  const state = JSON.parse(w.snapshot()), original = JSON.parse(before);
  const business = value => ({ rows: value.rows.filter(row => !String(row.entityId).startsWith('visibility-audit:')),
    events: value.events.filter(event => !String(event.entity).startsWith('visibility-audit:')), effects: value.effects });
  assert.deepEqual(business(state), business(original));
  assert.equal(w.seen(),false);
  w.v.ledger.expire(w.base.at+101);
  if(['budget-rejected','cancel-before-send','adapter-prepare-failed'].includes(kind))assert.equal(w.v.status().unknown,0);
  else assert(w.v.status().evidenceMissing>0);
 }finally{await w.close()}
});

for (const mode of ['removed','rewritten','id-preserving']) test('F9/F19 final projection '+mode,async()=>{
 const w=await fixture();try{
  await w.emit('prepared');await w.emit('send-started');
  const messages=mode==='removed'?[]:mode==='rewritten'?summariseDispatchMessages([{...w.message,content:'projected'}]):w.base.messages;
  await w.emit('committed',{messages});assert.equal(w.seen(),mode==='id-preserving',JSON.stringify({audit:w.v.audit(),row:w.store.read(w.id)}));
  if(mode!=='id-preserving')assert(w.v.audit().some(a=>a.reason==='content-projected'));
 }finally{await w.close()}
});

