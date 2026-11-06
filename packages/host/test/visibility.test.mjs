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

test('auxiliary requests are filtered by the consumer, not the publisher',async()=>{
 const w=await fixture();try{
  const before=w.snapshot();
 // Review 3 #4: candidate()/release() is the llm/stream pair around one adapter call, and the call's end is where an
 // auxiliary attempt is over - a committed transmission only proves that one response arrived.
 const release=w.v.candidate({sessionId:'session:b',kind:'auxiliary',purpose:'compaction',messages:[]});
 for(const phase of ['prepared','send-started','committed']) release.dispatch({...w.base,phase,kind:'auxiliary',purpose:'compaction',transmission:1,
   sendStartedAt:w.at,at:w.at},'real-cpa-transport');
 release();
  // Review 1 #6 / review 2 #5: an auxiliary request is observed, never consumed as turn evidence - and once its
  // transmission is settled it is released here. It used to keep one slot, one receipt and one observed attempt for the
  // life of the run, because expire() skips a committed slot and release() needs a closed one.
  assert.equal(w.v.ledger.receipts().length,0,'a settled auxiliary receipt is not evidence and does not stay');
  assert.equal(w.v.ledger.slot('dispatch:1'),null,'nor does its slot');
  assert.equal(w.v.status().observations,0,'nor the observed-attempt entry it put in this host');
  assert.equal(w.v.ledger.consumable().length,0);
  assert.equal(w.snapshot(),before);assert.equal(w.seen(),false);
 }finally{await w.close()}
});

test('attempt/transmission receipts keep send and confirm watermarks apart; duplicates and later failure never revoke',async()=>{
 const w=await fixture();try{
  await w.emit('prepared');await w.emit('send-started');w.session.seq=99;
  await w.emit('committed',{at:w.base.at+50});await w.emit('committed');await w.emit('failed',{transmission:2,reason:'later failure'});
  assert(w.seen());const a=w.v.audit().filter(a=>a.type==='visibilityCommitted');assert.equal(a.length,1);
  assert.equal(a[0].sendStartedSessionSeq,10);assert.equal(a[0].confirmedSessionSeq,99);assert.equal(a[0].confirmedAt,w.base.at+50);
  assert.equal(w.store.read(w.id).observation.sessionSeq,10);
 }finally{await w.close()}
});

for(const reason of ['missing-send-time','unbound-attempt']) test('evidenceMissing observable: '+reason,async()=>{
 const w=await fixture();try{
  if(reason!=='unbound-attempt'){await w.emit('prepared');await w.emit('send-started',{sendStartedAt:undefined});}
  await w.emit('committed',{sendStartedAt:undefined});assert.equal(w.seen(),false);assert(w.v.status().evidenceMissing>0);
 }finally{await w.close()}
});

for(const change of ['stop','generation','completion']) test('late evidence ordinary lifecycle authorization rejects '+change,async()=>{
 const w=await fixture();try{
  await w.emit('prepared');await w.emit('send-started');
  if(change==='stop')await w.host.stop();
  if(change==='generation')w.core.mutate('member:b','scheduler',{},tx=>tx.put('member:b',{...tx.read('member:b'),generation:2}));
  if(change==='completion')w.core.mutate('completion:c','scheduler',{},tx=>tx.put('completion:c',{status:'prepared'}));
  await w.emit('committed');assert.equal(w.seen(),false);assert(w.v.audit().some(a=>a.type==='evidenceMissing'));
 }finally{await w.close()}
});

test('two teams in flight cannot borrow one another candidate or attempt identity',async()=>{
 const a=await fixture(false,'team:first'),b=await fixture(false,'team:second');try{
  await Promise.all([a.emit('prepared'),b.emit('prepared')]);await Promise.all([a.emit('send-started'),b.emit('send-started')]);
  await a.emit('committed');assert(a.seen());assert.equal(b.seen(),false);await b.emit('committed');assert(b.seen());
 }finally{await a.close();await b.close()}
});

for(const status of [200,401,502]) test('controlled HTTP headers commit independently of hanging body, status '+status,async()=>{
 const w=await fixture();let response,received='';
 const server=http.createServer(async(req,res)=>{for await(const chunk of req)received+=chunk;response=res;res.writeHead(status,{'content-type':
   'application/json'});res.flushHeaders();});
 await listenFetchable(server);
 try{
  await w.emit('prepared');await w.emit('send-started');
  const responseHeaders=await fetch('http://127.0.0.1:'+server.address().port,{method:'POST',body:JSON.stringify([w.message])});
  assert.deepEqual(JSON.parse(received),[w.message]);assert.equal(w.seen(),false);
  await w.emit('committed',{httpStatus:responseHeaders.status});assert(w.seen());assert.equal(w.v.status().dispatchEvidence['real-cpa-transport'],
    'adapter-confirmed');
  assert.equal(w.v.audit().find(a=>a.type==='visibilityCommitted').accepted,status===200?'accepted':status===401?'auth-rejected':'proxy-error');
  response.end('{}');await responseHeaders.text();
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await w.close()}
});

test('fetch rejected after send-started is unknown, never visible',async()=>{
 const w=await fixture();const server=http.createServer();await listenFetchable(server);const port=server.address().port;await new Promise(r=>server.close(r));
 try{await w.emit('prepared');await w.emit('send-started');await assert.rejects(fetch('http://127.0.0.1:'+port));w.v.ledger.expire(w.base.at+101);assert.equal(
   w.seen(),false);assert.equal(w.v.status().unknown,1)}finally{await w.close()}
});

test('F16 tool-gap input is injected at next step and visible only on committed',async()=>{
 const w=await fixture();try{
  await w.emit('prepared');await w.emit('send-started');await w.emit('committed');assert(w.seen());
  w.release();const fresh=w.core.send('member:a','member:b','request','tool gap',{expectedOutcome:'reply',deadline:new Date(w.base.at+10000).toISOString(
    )}).result.entityId;
  const m=await w.v.preStep('session:b','native:2');w.session.events.push({type:'user/message',seq:6,data:{id:m.id,content:m.content}});
  w.v.candidate({sessionId:'session:b',main:true,messages:[m]});const messages=summariseDispatchMessages([m]);
  await w.emit('prepared',{attempt:'dispatch:2',messages});await w.emit('send-started',{attempt:'dispatch:2'});assert.equal(w.store.read(fresh).visible,false);
  await w.emit('committed',{attempt:'dispatch:2',messages});assert(w.store.read(fresh).visible);
 }finally{await w.close()}
});

test('production profile waits for acknowledged old IO before installing visibility', async () => {
 let release, stopped=false; const wait=new Promise(resolve=>{release=()=>{stopped=true;resolve();};});
 const pending=profile({previousDriver:{async stop(){},whenSettled:()=>wait,status:()=>({stopped})}});
 let activated=false; pending.then(()=>{activated=true;});
 await new Promise(resolve=>setImmediate(resolve)); assert.equal(activated,false);
 release(); const w=await pending;
 try { assert.equal(w.runtime.host.state,'running'); assert.equal(w.listeners.get('llm/dispatch').size,1); }
 finally { await w.close(); }
});
test('profile wake effects alone dispatch across steps; post-stop commands buy no requests', async()=>{
 const w=await profile({simulateRequests:true},({root})=>{const store=new ControlStore(root),core=new TeamCore(store,{}, {enabled:true});core.mutate(
   'message:w','root',{},tx=>{
   const row=tx.put('message:w',{sender:'root',recipient:'member:w',kind:'action'});tx.put('message:old',{sender:'root',recipient:'member:w',kind:'action'});
   tx.outbox('old-generation-wake',{kind:'wake',messageId:'message:old',recipient:'member:w',generation:0});return row;});store.effect(core.command('delay-old',
   'root',{}),'old-generation-wake',row=>({...row,nextDue:Date.now()+500}));store.close();});
 let fired=0;
 const command=(name,entityId,extra={})=>w.runtime.host.command({teamId:w.runtime.host.teamId,requestId:entityId,operationId:'v1:operation:'+
   entityId.replaceAll(':','-').padEnd(20,'x'),actor:'root',payload:{command:name,entityId,...extra}});
 try{
  command('team.member.request','member-intent:w',{role:'worker'});await until(()=>w.runtime.store.read('member-intent:w')?.status==='confirmed');
  w.runtime.host.coreAccess.lifecycle().mutate('message:w','adapter',{},tx=>tx.put('message:w',{
    ...tx.read('message:w'),generation:tx.read('member:w').generation,summary:'wake visibility',status:'stored'}));
  w.runtime.handles.get('member:w').agent.preemptStep=()=>{fired++;return true;};
  command('team.task.request','task:w',{owner:'member:w'});await until(()=>w.runtime.store.list('attempt:').some(row=>row.status==='running'));
  assert.equal(w.runtime.core.notifyDelivery,undefined);assert.equal(fired,0);
  command('team.wake','signal:one',{messageId:'message:w',recipient:'member:w'});await until(()=>fired===1);
  command('team.wake','signal:two',{messageId:'message:w',recipient:'member:w'});await until(()=>w.runtime.store.effects().find(e=>
    e.id==='wake:message:w:member:w')?.status==='confirmed');
  assert.equal(fired,1);assert.equal(w.runtime.store.effects().filter(e=>e.id==='wake:message:w:member:w').length,1);assert(w.runtime.store.read(
    'wake-receipt:message:w:member:w'));
  await new Promise(resolve=>setTimeout(resolve,2010));
  command('team.wake','signal:three',{messageId:'message:w',recipient:'member:w'});await new Promise(resolve=>setTimeout(resolve,30));assert.equal(fired,1);
  await w.runtime.host.stop();assert.throws(()=>command('team.wake','signal:late',{messageId:'message:w',recipient:'member:w'}));
  assert.equal(fired,1);assert.equal(w.runtime.preempt.snapshot().preempts,1);assert.equal(w.runtime.preempt.snapshot().coalesced,0);assert(
    w.runtime.store.effects().find(e=>e.id==='old-generation-wake').tries>0);
 }finally{await w.close();}
});
for (const kind of ['seen-before-close','late-proof','post-close-request','old-generation','seen-none']) test('F14/F19 linearization '+kind,async()=>{
 const w=await fixture(true);let runner;
 try{
  const close=w.store.read(w.id).closesAt;
  await w.emit('prepared');
  if(kind==='post-close-request')w.at=close+1;
  await w.emit('send-started',{sendStartedAt:kind==='post-close-request'?close+1:w.base.at});
  if(kind==='seen-before-close')await w.emit('committed');
  w.at=close+1; await w.host.cycle.run();
  const frozen=w.store.read(w.id);
  assert.equal(frozen.decision,'passed');assert.equal(frozen.seenAtClose['member:b'],kind==='seen-before-close');
  if(kind==='old-generation')w.core.mutate('member:b','scheduler',{},tx=>tx.put('member:b',{...tx.read('member:b'),generation:2}));
  if(!['seen-none','seen-before-close'].includes(kind))await w.emit('committed',{sendStartedAt:kind==='post-close-request'?close+1:w.base.at});
  const after=w.store.read(w.id);assert.deepEqual(after.seenAtClose,frozen.seenAtClose);assert.equal(after.decision,'passed');
  assert.equal(after.lateEvidence.length,kind==='late-proof'?1:0);
  assert.equal(after.visibilityAfterClose.length,kind==='post-close-request'?1:0);
  if(kind==='old-generation')assert(w.v.audit().some(a=>a.reason==='STALE_MESSAGE_BINDING'));
  if(kind==='seen-none'){
   assert.equal(after.seenSummary,'seenNone');
   runner=createEffectRunner({access:w.host.coreAccess,clock:w.host.clock,ports:{wake:async()=>({executed:true}), 'intent-result':async()=>({executed:
     true})}});
   runner.pump();await runner.whenIdle();
   assert(w.store.effects().some(e=>e.payload.kind==='intent-result'&&e.status==='confirmed'));
  }
 }finally{runner?.stop();await w.close()}
});

test('overlapping transmissions retain their own send watermarks',async()=>{
 const w=await fixture();try{
  await w.emit('prepared');await w.emit('send-started');w.session.seq=20;
  await w.emit('send-started',{transmission:2,sendStartedAt:w.base.at+1});w.session.seq=30;
  await Promise.all([w.emit('committed',{transmission:1}),w.emit('committed',{transmission:2,sendStartedAt:w.base.at+1})]);
  assert(w.seen());assert.equal(w.store.read(w.id).observation.sessionSeq,10);
  assert.equal(w.v.ledger.receipts()[0].sessionSeq,10);assert.equal(w.v.ledger.receipts()[1].sessionSeq,20);
  assert.equal(w.v.audit().filter(a=>a.type==='visibilityCommitted').length,1);
 }finally{await w.close()}
});

test('no response headers persists evidenceMissing and exposes host status count',async()=>{
 const w=await fixture();let received;const accepted=new Promise(r=>{received=r});
 const server=http.createServer(async(req)=>{for await(const chunk of req){}received()});await listenFetchable(server);
 const controller=new AbortController();let pending;
 try{
  await w.emit('prepared');await w.emit('send-started');
  pending=fetch('http://127.0.0.1:'+server.address().port,{method:'POST',body:JSON.stringify([w.message]),signal:controller.signal}).catch(()=>null);
  await accepted;assert.equal(w.seen(),false);w.at+=101;w.v.expire();await w.v.settled();
  assert.equal(w.host.status().visibility.unknown,1);assert(w.host.status().visibility.evidenceMissing>0);
  assert(w.store.list('visibility-audit:').some(a=>a.type==='evidenceMissing'));
 }finally{controller.abort();await pending;server.closeAllConnections();await new Promise(r=>server.close(r));await w.close()}
});

test('concurrent wrappers are ambiguous and never write visible',async()=>{
 const w=await fixture();try{w.v.candidate({sessionId:'session:b',main:true,messages:[w.message]});await w.emit('prepared');await w.emit('send-started');
   await w.emit('committed');assert.equal(w.seen(),false);assert(w.v.status().evidenceMissing>0)}finally{await w.close()}
});

// ---------------------------------------------------------------------------------------------------------------
// D review fixes (#1-#8). Each case names the finding it pins.
// ---------------------------------------------------------------------------------------------------------------

/** A stand-in for the attempt object the upstream patch mints, shaped like verification/real/dispatch-phase-test.mjs:
 * the attempt owns its per-transmission send time and publishes every phase itself through the contract publisher, so
 * the committed these cases assert on is produced by a publisher and not written by the test. */

// #1: the route is re-checked at the moment the evidence would be written, not only when the candidate was prepared.
for (const change of ['route-member','route-generation']) test('D#1 a route changed in flight keeps a late committed out of visible: '+change, async()=>{
 const w=await fixture();try{
  await w.emit('prepared');await w.emit('send-started');
  if(change==='route-member')w.setMember('member:a');else w.setGeneration(2);
  await w.emit('committed');
  assert.equal(w.seen(),false);
  assert(w.v.audit().some(a=>a.reason==='stale-route'),JSON.stringify(w.v.audit()));
  assert.equal(w.store.list('manifest:').length,0);
 }finally{await w.close()}
});

// #2: the generation the boundary checks is the live one, and it refuses a request on its own. The route already names
// generation 2 while the member row and the message row are still at 1: the per-message binding loop would agree with
// itself, so only the boundary's generation gate can refuse this request.
