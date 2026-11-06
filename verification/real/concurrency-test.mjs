import fs from 'node:fs';
import assert from 'node:assert/strict';
import {ConcurrencyGate,slotWaitWithin} from './concurrency.mjs';
import {Budget,usage} from './budget.mjs';
import {stages} from './config.mjs';
import {concurrencyGateHonest} from './metrics.mjs';

/**
 * The request gate and the budget ledger must stay correct when several requests overlap.
 *
 * The gate is checked for its two limits at once: no member holds more than maxConcurrent requests, and the
 * whole run never holds more than globalConcurrency. The ledger is checked against a stage with room for
 * exactly three bounds: ten overlapping reservations may admit three and must refuse the other seven before a
 * request is sent, and the settled total must never exceed the stage cap.
 */
const root=process.argv[2];assert(root&&!fs.existsSync(root));fs.mkdirSync(root,{recursive:true});
const wait=ms=>new Promise(r=>setTimeout(r,ms));

const gate=new ConcurrencyGate({maxConcurrent:1,globalConcurrency:6});
const windows=[];
await Promise.all(Array.from({length:24},(_,i)=>gate.run('member:m'+(i%8),async window=>{
  windows.push(window);await wait(4);
  assert(Number.isFinite(window.grantedAt)&&Number.isFinite(window.requestedAt));
})));
const stats=gate.stats();
assert.equal(stats.maxConcurrent,1);assert.equal(stats.globalConcurrency,6);
assert(stats.peakInFlight>1,'the gate must actually overlap different members');
assert(stats.peakInFlight<=6,'global ceiling exceeded');
assert(stats.peakPerMember<=1,'a member ran two requests at once');
assert.equal(stats.queued,0);
assert.equal(stats.admitted,24);assert.equal(windows.length,24);
// A slot wait is measured inside the mailbox window and never exceeds it.
const overlap=slotWaitWithin(windows,'member:m0',Math.min(...windows.map(w=>w.requestedAt)),Math.max(...windows.map(w=>w.grantedAt)));
assert(overlap>=0&&overlap<=Math.max(...windows.map(w=>w.grantedAt))-Math.min(...windows.map(w=>w.requestedAt)));

// A superseded in-flight request retains its real global slot while a new step of the same member proceeds.
{
  const g=new ConcurrencyGate({maxConcurrent:1,globalConcurrency:2}), controller=new AbortController();
  let releaseOld,startedOld,startedNext;const oldStarted=new Promise(r=>startedOld=r),nextStarted=new Promise(r=>startedNext=r);
  const hold=new Promise(r=>releaseOld=r);
  const old=g.run('a',async()=>{startedOld();await hold;},{signal:controller.signal});await oldStarted;
  const next=g.run('a',async()=>{startedNext();});
  await Promise.resolve();assert.equal(g.stats().admitted,1,'an ordinary overlapping request waits');
  controller.abort('team-message');await nextStarted;await next;
  const during=g.stats();assert.equal(during.inFlight,1,'the superseded transport still owns its physical slot');
  assert.equal(during.supersededInFlight,1);assert.equal(await g.whenSettled(0),false,'a superseded IO has not drained');
  assert.equal(during.peakPerMember,2,'physical overlap is visible');
  assert.equal(during.peakActivePerMember,1);assert.equal(during.overlapWithoutSupersession,0);
  releaseOld();await old;assert.equal(g.stats().inFlight,0);assert.equal(await g.whenSettled(0),true);
  const settled=g.stats();assert.equal(concurrencyGateHonest(settled),true,'a proven supersession is allowed without hiding physical IO');
  assert.equal(concurrencyGateHonest({...settled,peakSuperseded:0}),false,'physical overlap without supersession must fail');
  assert.equal(concurrencyGateHonest({...settled,overlapWithoutSupersession:1}),false);
  assert.equal(concurrencyGateHonest({...settled,inFlight:1}),false,'undrained IO cannot pass the run');
  assert.equal(concurrencyGateHonest(settled,[{code:'BUDGET_VIOLATION'}]),false);
  // A queued step that is preempted before admission never dispatches later.
  const c=new AbortController();let releaseFirst;const blocker=g.run('b',()=>new Promise(r=>releaseFirst=r));await Promise.resolve();
  let ran=false;const queued=g.run('b',()=>{ran=true},{signal:c.signal});c.abort('team-message');
  await assert.rejects(queued,/STEP_PREEMPTED_BEFORE_DISPATCH/);releaseFirst();await blocker;assert.equal(ran,false);
}

const file=root+'/budget.json',room=3000;
fs.writeFileSync(file,JSON.stringify({version:1,total:stages.smoke-room,stages:{smoke:stages.smoke-room},
  input:stages.smoke-room,output:0,cacheHit:0,cacheMiss:stages.smoke-room,pending:null}));
const budget=new Budget(file,'smoke');
let sent=0,refused=0;
await Promise.all(Array.from({length:10},async(_,i)=>{
  await wait(i%3);
  let token;
  try{token=budget.reserve(1000);}catch(e){assert.match(e.message,/BUDGET_STOP_BEFORE_REQUEST/);refused++;return;}
  sent++;
  await wait(2);
  budget.settle(usage({input_tokens:800,output_tokens:100}),token);
}));
assert.equal(sent,3,'the ledger admitted more requests than its remaining stage room');
assert.equal(refused,7);
assert.equal(budget.data.total,stages.smoke-room+3*900);
assert.equal(budget.data.stages.smoke,stages.smoke-room+3*900);
assert(budget.data.total<=stages.smoke&&!(budget.data.stages.smoke>stages.smoke));
assert.equal(budget.outstanding(),0);
assert.equal(budget.data.pending,null);
budget.close();

// An overrun is still fail-closed when reservations overlap: the ledger records pending and refuses to reopen.
const over=root+'/overrun.json',b2=new Budget(over,'smoke');
b2.reserve(100);b2.reserve(100);
assert.throws(()=>b2.settle({input:500,output:1,cacheHit:null,cacheMiss:null},[...b2.reservations.keys()][0]),/USAGE_BOUND_VIOLATION/);
assert.equal(b2.data.pending.reason,'PROVIDER_EXCEEDED_RESERVATION');
b2.close();
assert.throws(()=>new Budget(over,'smoke'),/RECONCILIATION/);

// A timeout while actual IO is still present retains the exclusive ledger lock and pending reservation.
const heldFile=root+'/held-lock.json',heldBudget=new Budget(heldFile,'smoke');heldBudget.reserve(100);
heldBudget.close({retainLock:true});assert(fs.existsSync(heldFile+'.lock'));
assert.throws(()=>new Budget(heldFile,'smoke'),/EEXIST/);fs.unlinkSync(heldFile+'.lock');
assert.throws(()=>new Budget(heldFile,'smoke'),/RECONCILIATION/);

fs.writeFileSync(root+'/report.json',JSON.stringify({status:'passed',gate:stats,overlapSlotWaitMs:overlap,
  budget:{stageRoom:room,bound:1000,sent,refused,finalTotal:stages.smoke,noOverrun:true,outstanding:0},
  overrunFailClosed:true,realProviderRequests:0},null,2));
console.log('concurrency/budget gate PASS: '+sent+' of 10 overlapping requests admitted, '+refused+' refused before sending');
