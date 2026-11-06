import test from 'node:test';
import { profile, until } from '../test-support/profile.mjs';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
// Windows may allocate low ephemeral ports on Fetch's blocked-port list (e.g. 6000). Do not mistake that for a transport failure.

import { fetchBlockedPorts, listenFetchable, fixture } from '../test-support/visibility-fixtures.mjs';
import { real } from '../test-support/real.mjs';
import { createVisibility } from '../index.mjs';
import { createEffectRunner } from '../src/effect-runner.mjs';
import { withdrawManifest } from '../src/visibility/dispatch.mjs';
import { preStep, requestBoundary } from '../../core/index.mjs';
import { visibilityDirty } from '../src/visibility/dirty.mjs';
import { createVisibilityQueue } from '../src/visibility/queue.mjs';
import { DISPATCH_CONTRACT, DISPATCH_EVENT, DispatchEvidenceLedger, publishDispatchEvent, summariseDispatchMessages } from '../../contracts/index.mjs';

function publisher(publish, { attempt, sessionId = 'session:b', messages, now }) {
 const sendStartedAt = new Map();
 return {
  attempt,
  base: { sessionId, kind: 'main', purpose: null, provider: 'patch-provider', model: 'patch-model', messages },
  phase(name, extra = {}) {
   const transmission = Number.isSafeInteger(extra.transmission) ? extra.transmission : null;
   if (name === 'send-started') sendStartedAt.set(transmission, Number.isFinite(extra.sendStartedAt) ? extra.sendStartedAt : now());
   return publish({ contract: DISPATCH_CONTRACT, phase: name, attempt, ...this.base, transmission,
    sendStartedAt: transmission === null ? null : sendStartedAt.get(transmission) ?? null, at: now(),
    accepted: extra.accepted ?? null, httpStatus: Number.isInteger(extra.httpStatus) ? extra.httpStatus : null,
    reason: extra.reason ?? null });
  },
 };
}

test('D#2 the boundary generation gate refuses a request the member row is not at, on its own',async()=>{
 const w=await fixture(false,'team:b',{routeGeneration:2});try{
  await w.emit('prepared');await w.emit('send-started');
  await w.emit('committed');
  assert.equal(w.seen(),false);
  assert(w.v.audit().some(a=>a.reason==='STALE_MESSAGE_BINDING'),JSON.stringify(w.v.audit()));
  assert.equal(w.store.read('member:b').generation,1);
  assert.equal(w.store.read(w.id).generation,1);
 }finally{await w.close()}
});

// #3: the contract keeps a transmission's send watermark when a failure follows it.
test('D#3 a failed transmission keeps its send watermark, so a later committed still counts and close() settles',()=>{
 const ledger=new DispatchEvidenceLedger({leaseMs:60000,now:()=>0});
 const base={contract:'team-dispatch/2',attempt:'dispatch:c1',sessionId:'session:c',kind:'main',purpose:null,messages:[],at:0};
 const send=extra=>ledger.observe({...base,...extra},{sessionSeq:7,epoch:'e'});
 send({phase:'prepared'});
 send({phase:'send-started',transmission:1,sendStartedAt:5});
 assert.equal(send({phase:'failed',transmission:1,reason:'proxy reset'}).classification,'dispatchUnconfirmed');
 const late=send({phase:'committed',transmission:1,sendStartedAt:5,httpStatus:200,accepted:'accepted'});
 assert.equal(late.accepted,true,'the committed is not discarded as missing-send-time');
 assert.equal(late.visible,true);
 assert.equal(ledger.receipts().length,1);
 assert.equal(ledger.receipts()[0].sessionSeq,7,'the request-side sessionSeq survived the failure');
 assert.equal(ledger.receipts()[0].requestedAt,5);
 assert.equal(ledger.close('dispatch:c1'),false,'a committed transmission is never counted as unresolved');
 assert.equal(ledger.status().unknown,0);
 assert.equal(ledger.missing().length,0);
 // An entry is still created when the transmission had none, and it carries no invented send time.
 const other=new DispatchEvidenceLedger({leaseMs:60000,now:()=>0});
 other.observe({...base,attempt:'dispatch:c2',phase:'prepared'},{sessionSeq:1,epoch:'e'});
 other.observe({...base,attempt:'dispatch:c2',phase:'failed',transmission:3},{sessionSeq:1,epoch:'e'});
 assert.equal(other.slot('dispatch:c2').transmissions.get(3).sessionSeq,null);
});

// #4: a refused boundary leaves no usable manifest row behind.
test('D#4 a rejected boundary leaves no usable manifest behind',async()=>{
 const w=await fixture(true);try{
  await w.emit('prepared');await w.emit('send-started');
  assert.equal(w.store.list('manifest:').length,0);
  w.core.mutate('member:b','scheduler',{},tx=>tx.put('member:b',{...tx.read('member:b'),generation:2}));
  await w.emit('committed');
  assert.equal(w.seen(),false);
  assert(w.v.audit().some(a=>a.reason==='STALE_MESSAGE_BINDING'),JSON.stringify(w.v.audit()));
  // This path refuses inside the injection transaction, so no row is written at all. Asserting the empty list is the
  // point: it fails the moment recordInjection writes the row before the boundary refuses. If a row ever is there, it
  // can only be the withdrawn tombstone, never a live source.
  const rows=w.store.list('manifest:');
  assert.equal(rows.length,0,'the refused injection wrote no manifest row');
  assert.equal(rows.filter(row=>row.withdrawn!==true).length,0,'a row that exists must be a tombstone');
  assert.equal(w.store.read(w.id).visible,false);
 }finally{await w.close()}
});

// #5: the skip line is per session, and a refused audit write is counted instead of swallowed.
test('D#5 visibilitySkipped is reported once per session and audit persistence failures are counted',async()=>{
 const w=await fixture();try{
  w.v.candidate({sessionId:'session:b',main:true,messages:[]});
  w.v.candidate({sessionId:'session:b',main:true,messages:[]});
  await w.v.settled();
  assert.equal(w.v.audit().filter(a=>a.reason==='visibilitySkipped').length,1,'one line per session, not per request');
  assert.equal(w.store.list('visibility-audit:').filter(a=>a.reason==='visibilitySkipped').length,1);
  const stored=w.store.list('visibility-audit:').length;
  w.core.mutate('completion:c','scheduler',{},tx=>tx.put('completion:c',{status:'prepared'}));
  await w.emit('prepared');await w.emit('send-started',{sendStartedAt:undefined});
  await w.emit('committed',{sendStartedAt:undefined});
  assert(w.v.audit().some(a=>a.reason==='missing-send-time'),'the evidence is still observable in memory');
  assert(w.host.status().visibility.auditPersistFailed>0,JSON.stringify(w.host.status().visibility));
  assert.equal(w.store.list('visibility-audit:').length,stored,'a frozen store takes no audit rows');
 }finally{await w.close()}
});

// #6a: committed comes from the phase publisher, after the response headers arrived; the test never emits a phase.
test('D#6 the phase publisher mints committed when headers arrive',async()=>{
 const w=await fixture();let response,received='';
 const server=http.createServer(async(req,res)=>{for await(const chunk of req)received+=chunk;response=res;res.writeHead(200,{'content-type':
   'application/json'});res.flushHeaders();});
 await listenFetchable(server);
 try{
  const published=[];
  const bus={on:()=>[],listeners:name=>name===DISPATCH_EVENT?[event=>{published.push(event);w.v.dispatch(event,'real-cpa-transport');}]:[]};
  const attempt=publisher(event=>publishDispatchEvent(bus,event),{attempt:'dispatch:p1',messages:w.base.messages,now:()=>w.at});
  attempt.phase('prepared');attempt.phase('send-started',{transmission:1});
  assert.equal(w.seen(),false);
  const headers=await fetch('http://127.0.0.1:'+server.address().port,{method:'POST',body:JSON.stringify([w.message])});
  assert.deepEqual(JSON.parse(received),[w.message]);
  assert.equal(w.seen(),false,'headers alone are not evidence until the transport publishes committed');
  attempt.phase('committed',{transmission:1,httpStatus:headers.status});
  await w.v.settled();
  assert(w.seen(),JSON.stringify({audit:w.v.audit()}));
  assert.deepEqual(published.map(event=>event.phase),['prepared','send-started','committed']);
  assert.equal(w.v.status().dispatchEvidence['real-cpa-transport'],'adapter-confirmed');
  assert.equal(w.v.audit().find(a=>a.type==='visibilityCommitted').accepted,'accepted');
  response.end('{}');await headers.text();
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await w.close()}
});

// #6b: the same concurrency case with one process-wide ledger and queue instead of two isolated ones.
test('D#6 two teams sharing one ledger and queue cannot borrow one another receipt',async()=>{
 const clock={at:Date.now()};
 const ledger=new DispatchEvidenceLedger({now:()=>clock.at,leaseMs:100}),queue=createVisibilityQueue();
 const a=await fixture(false,'team:first',{ledger,queue,attempt:'dispatch:first:1'});
 const b=await fixture(false,'team:second',{ledger,queue,attempt:'dispatch:second:1'});
 try{
  await Promise.all([a.emit('prepared'),b.emit('prepared')]);
  await Promise.all([a.emit('send-started'),b.emit('send-started')]);
  await a.emit('committed');
  assert(a.seen());assert.equal(b.seen(),false);
  await b.emit('committed');
  assert(b.seen());assert(a.seen());
  assert.equal(ledger.receipts().length,2);
  // Each team's evidence stays its own. The shared ledger holds both receipts, but the other team's receipt is skipped
  // before it is consumed, so it leaves no audit row in this team's database and does not inflate evidenceMissing
  // (review 2 #1).
  assert.equal(a.store.list('visibility-audit:').filter(r=>r.reason==='unbound-attempt').length,0,'A wrote no audit row for B receipt');
  assert.equal(b.store.list('visibility-audit:').filter(r=>r.reason==='unbound-attempt').length,0,'B wrote no audit row for A receipt');
  assert.equal(a.v.status().evidenceMissing,0);
  assert.equal(b.v.status().evidenceMissing,0);
  assert.equal(a.store.list('visibility-audit:').filter(r=>r.type==='visibilityCommitted').length,1);
  assert.equal(b.store.list('visibility-audit:').filter(r=>r.type==='visibilityCommitted').length,1);
 }finally{await a.close();await b.close()}
});

// #7: the dirty hook takes (sessionId, host) and refuses a call that could only no-op.
test('D#7 visibilityDirty takes the session id and the host, and refuses anything else',async()=>{
 const w=await fixture();try{
  const before=w.host.cycle.status().kicks;
  visibilityDirty('session:b',w.host);
  assert.equal(w.host.cycle.status().kicks,before+1,'the tool-gap mark really kicks the cycle');
  assert.throws(()=>visibilityDirty(w.host),{code:'INVALID_SESSION'});
  assert.throws(()=>visibilityDirty(undefined,w.host),{code:'INVALID_SESSION'});
  assert.throws(()=>visibilityDirty('session:b'),{code:'INVALID_HOST'});
  assert.throws(()=>visibilityDirty('session:b','session:b'),{code:'INVALID_HOST'});
  assert.throws(()=>visibilityDirty('session:b',{cycle:{}}),{code:'INVALID_HOST'});
 }finally{await w.close()}
});

// #8 / design §6 D-3 (F10): a response that arrives after stop closes as missing evidence, never as visible.
test('D#8 F10 stop in flight: headers arriving after stop never become visible and the attempt still closes',async()=>{
 const w=await fixture();let response,arrived;const accepted=new Promise(r=>{arrived=r});
 const server=http.createServer(async(req,res)=>{for await(const chunk of req){}response=res;arrived()});
 await listenFetchable(server);
 let pending;
 try{
  await w.emit('prepared');await w.emit('send-started');
  pending=fetch('http://127.0.0.1:'+server.address().port,{method:'POST',body:JSON.stringify([w.message])});
  await accepted;assert.equal(w.seen(),false);
  await w.host.stop();
  response.writeHead(200,{'content-type':'application/json'});response.flushHeaders();
  const headers=await pending;
  await w.emit('committed',{httpStatus:headers.status});
  assert.equal(w.seen(),false,'a request that crossed stop cannot certify a visible fact');
  assert(w.v.audit().some(a=>a.type==='evidenceMissing'),JSON.stringify(w.v.audit()));
  // The attempt is accounted for inside the evidence budget: one committed receipt the host refused, zero visible.
  w.at+=101;w.v.expire();await w.v.settled();
  assert.equal(w.host.status().visibility.visible,0);
  assert.equal(w.host.status().visibility.receipts,1);
  assert(w.host.status().visibility.evidenceMissing>0);
 }finally{
  try{response?.end?.('{}')}catch{}
  await pending?.catch?.(()=>null);
  server.closeAllConnections();await new Promise(r=>server.close(r));await w.close()
 }
});
test('profile stop drains a real gc effect and admits no new ordinary claim',async()=>{
 let release,entered=false;const work=new Promise(resolve=>{release=resolve;});
 const w=await profile({gcIntervalMs:15,gc:async()=>{entered=true;return work;}});
 try{await until(()=>entered);const count=w.runtime.store.effects().filter(e=>e.status==='applying').length;
 const stopping=w.runtime.host.stop({timeoutMs:1000});
 assert.equal(w.runtime.runner.pump().claimed,0);
 release({executed:true,receipt:{collected:true}});assert.equal((await stopping).timedOut,false);
 assert.equal(w.runtime.store.effects().filter(e=>e.status==='confirmed').length,count);
 }finally{release({executed:true,receipt:{}});await w.close();}
});

// #8 / design §6 D-4 (F24): under the completion fence the evidence stays in memory, never in the store.
test('D#8 F24 freeze: a committed under COMPLETION_FROZEN stays in memory and is never written',async()=>{
 const w=await fixture();try{
  await w.emit('prepared');await w.emit('send-started');
  w.core.mutate('completion:c','scheduler',{},tx=>tx.put('completion:c',{status:'prepared'}));
  const stored=w.store.list('visibility-audit:').length;
  await w.emit('committed');
  assert.equal(w.seen(),false);
  assert(w.v.audit().some(a=>a.reason==='COMPLETION_FROZEN'),JSON.stringify(w.v.audit()));
  assert(w.host.status().visibility.auditPersistFailed>0,'the refusal is counted, not dropped');
  assert.equal(w.store.list('visibility-audit:').length,stored,'a frozen store takes no audit rows');
  assert.equal(w.store.list('manifest:').length,0,'and no manifest row either');
 }finally{await w.close()}
});

// ---------------------------------------------------------------------------------------------------------------
// Second review round (#1-#7). Each case names the finding it pins.
// ---------------------------------------------------------------------------------------------------------------

// 2: the dirty hook is a pair, checked once at registration; a failing mark never reaches the tool chain.
test('D2#2 the dirty hook is validated as a pair and a failing mark never breaks a tool call',async()=>{
 const w=await fixture();try{
  assert.equal(w.v.dirty.assert(undefined,null),false,'no dirty hook at all is a valid wiring');
  assert.throws(()=>w.v.dirty.assert(()=>{},null),{code:'INVALID_CONFIG'});
  assert.throws(()=>w.v.dirty.assert(()=>{},{}),{code:'INVALID_CONFIG'});
  assert.throws(()=>w.v.dirty.assert('session:b',w.host),{code:'INVALID_CONFIG'});
  assert.equal(w.v.dirty.assert(visibilityDirty,w.host),true);
  const before=w.host.cycle.status().kicks;
  assert.equal(w.v.dirty.mark(()=>{throw Error('kick failed')},'session:b',w.host),false,'a failing mark is swallowed');
  assert.equal(w.host.cycle.status().kicks,before);
  assert.equal(w.v.dirty.mark(undefined,'session:b',w.host),false);
  assert.equal(w.v.dirty.mark(visibilityDirty,'session:b',w.host),true,'the real mark still kicks');
  assert.equal(w.host.cycle.status().kicks,before+1);
 }finally{await w.close()}
});

// 3: the tombstone writer has a direct, re-runnable case: the row must exist and must be a tombstone.
test('D2#3 a withdrawn manifest keeps its id as a tombstone that no reader accepts',async()=>{
 const w=await fixture();try{
  await w.emit('prepared');await w.emit('send-started');await w.emit('committed');
  assert(w.seen());
  const manifests=w.store.list('manifest:');
  assert.equal(manifests.length,1,'a committed injection wrote exactly one manifest row');
  assert.equal(typeof manifests[0].text,'string');
  const manifestId=manifests[0].entityId;
  withdrawManifest({host:w.host,now:()=>w.at,manifestId,code:'STALE_MESSAGE_BINDING'});
  const rows=w.store.list('manifest:');
  assert.equal(rows.length,1,'the tombstone keeps the id: the store has no delete');
  assert.equal(rows[0].withdrawn,true);
  assert.equal(rows[0].withdrawnReason,'STALE_MESSAGE_BINDING');
  assert.equal(rows[0].text,'','the text is gone, so no reader can re-derive the hash');
  assert.equal(rows[0].messageId,null);
  assert.equal(rows[0].messageBindings.length,0);
  assert.equal(rows[0].sourceEventSeqs.length,0);
  // ...and the boundary refuses the id instead of trusting the row that is still there.
  assert.throws(()=>requestBoundary(w.core,manifestId.slice('manifest:'.length),
    {generation:1,requestId:'request:after-withdraw',sessionSeq:10,requestedAt:w.at}),/MISSING_SOURCE/);
 }finally{await w.close()}
});

// 4: an injected ledger must agree on the lease it is shared under.
test('D2#4 a shared ledger built with a different lease is refused instead of expiring on a foreign budget',()=>{
 const ledger=new DispatchEvidenceLedger({now:()=>Date.now(),leaseMs:60000});
 const host={teamId:'team:x',clock:{now:()=>Date.now(),every:()=>()=>{}},observeVisibility:()=>{}};
 const build=leaseMs=>()=>createVisibility({host,core:{},routeExecution:()=>null,sessions:new Map(),isMain:()=>false,leaseMs,ledger});
 assert.throws(build(100),{code:'INVALID_CONFIG'});
 const shared=build(60000)();
 assert.equal(shared.ledger,ledger,'the injected ledger is the one this instance uses');
 shared.stop();
});

// 7: a withdrawn manifest is a tombstone, not a source: it must not stand in for an injection that never happened.
const injectionPorts = (messageId, seq) => ({ serialize: operation => operation(),
 inject: async () => ({ messageId, sourceEventSeqs: [seq], generation: 1 }) });

test('D2#7 a tombstoned manifest does not block the same candidate from being injected again',async()=>{
 const w=await fixture();try{
  const first=await preStep(w.core,'member:b',injectionPorts('native:again','seq:again'));
  assert(first,'the first injection wrote a manifest');
  const manifestId='manifest:'+first.manifest.hash;
  assert.equal(typeof w.store.read(manifestId).text,'string');
  withdrawManifest({host:w.host,now:()=>w.at,manifestId,code:'STALE_MESSAGE_BINDING'});
  assert.equal(w.store.read(manifestId).withdrawn,true);
  const again=await preStep(w.core,'member:b',injectionPorts('native:again','seq:again'));
  assert(again,'a withdrawn manifest must not stand in for an injection that never happened');
  assert.equal(again.manifest.hash,first.manifest.hash,'same candidate, same hash');
  const row=w.store.read(manifestId);
  assert.equal(row.withdrawn,undefined,'the re-injection rewrote the row as a live manifest');
  assert.equal(typeof row.text,'string');
  assert(row.text.length>0);
 }finally{await w.close()}
});

test('D2#7 a live manifest still skips the same candidate, as the dedupe always did',async()=>{
 const w=await fixture();try{
  const first=await preStep(w.core,'member:b',injectionPorts('native:once','seq:once'));
  assert(first);
  assert.equal(w.store.read('manifest:'+first.manifest.hash).withdrawn,undefined,'a fresh manifest is not a tombstone');
  assert.equal(await preStep(w.core,'member:b',injectionPorts('native:twice','seq:twice')),null,
    'a live manifest is still the reason to skip');
 }finally{await w.close()}
});


