import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore, batchCandidate, recordUsage, drain, capacityUsage, capacityStatus, acquireOwnerControl, settleOwnerControl,
  effectTrafficClass } from '../index.mjs';
import { createHumanInputGateway } from '../../host/index.mjs';
import { certificate } from '../test-support/execution.mjs';
import { assertProtocolSupported } from '../../contracts/index.mjs';
const cfg={enabled:true,attach:true,teamId:'team:h',autonomy:'on',collab:'on',superagentBorrow:'v1',intentSemantics:'root-decision-v1',maxRuns:1};
export function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'borrow-h-')),store=new ControlStore(dir),core=new TeamCore(store,{},cfg);
 for(const [m,r] of [['root','root'],['a','worker'],['b','worker'],['c','worker']])core.member('member:'+m,r);
 const token={},gateway=createHumanInputGateway({core,teamId:cfg.teamId,ownerSessionId:'owner',authenticate:c=>c===token?{
   teamId:cfg.teamId,ownerSessionId:'owner',authenticatedEntry:'authenticated-viewer'}:null});
 let n=0;return {dir,store,core,token,gateway,human:(recipient,purpose='message')=>gateway.send({operationId:'v1:operation:human-input-'+(++n),
   recipient,purpose,summary:'human '+n},token),close(primary=null){const cleanup={close:null,closeResult:null,remove:null};try{cleanup.closeResult=
     store.close();}catch(error){cleanup.close=error;}try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}catch(error){cleanup.remove=
     error;}if(cleanup.close||cleanup.remove){const error=cleanup.close??cleanup.remove;error.cleanup=cleanup;if(primary){primary.cleanupErrors=[...(
     primary.cleanupErrors??[]),error];return;}throw error;}return cleanup.closeResult;}};
}
const withFixture=body=>async()=>{const t=fixture();let primary=null;try{await body(t);}catch(error){primary=error;throw error;}finally{try{t.close(primary);
  }catch(error){if(primary)primary.cleanupErrors=[...(primary.cleanupErrors??[]),error];else throw error;}}};
const binding={routed:true,kind:'owner',teamId:cfg.teamId,sessionId:'owner',ownerSessionId:'owner',memberId:'member:root',generation:1,epoch:'host:1'};
const admit=(t,name)=>{t.core.task('task:'+name,'member:'+name);return t.core.schedule('evt:'+name,'task:'+name).result;};
const owner=(t,originRef,id='owner-call:test')=>t.core.execute('control-slot:'+cfg.teamId+':'+id,'adapter',{originRef},tx=>acquireOwnerControl(tx,{
 teamId:cfg.teamId,binding,holderRef:id,originRef,now:Date.now()})).result;
const release=(t,a)=>t.core.dispatch(a.attemptId,'member:'+t.store.read(a.attemptId).owner.split(':')[1],{fence:a.fence},
 {type:'attempt.release',payload:{...a,status:'cancelled'}});

test('H01/H05: N bounds real attempts, existing active human communication uses I without another run slot; v1 stays closed',withFixture(t=>{
  const a=admit(t,'a');t.core.task('task:b','member:b');assert.throws(()=>t.core.schedule('evt:b','task:b'),e=>e.code==='CAPACITY');
  const h=t.human('member:a');const effect=t.store.effects().find(e=>e.payload.messageId===h.result.entityId);
  assert.equal(effectTrafficClass(t.store,effect),'human');assert.equal(t.store.list('attempt:').length,1);
  assert.equal(capacityUsage(t.store).normal,1);assert.equal(capacityUsage(t.store).human,0);
  assert.throws(()=>assertProtocolSupported({superagentBorrow:'v1',intentSemantics:'root-decision-v1'}),e=>e.code==='PROTOCOL_UNSUPPORTED');
  assert.equal(t.store.read(a.attemptId).lease,'active');
 }));

test('H02/H07: one shared H, FIFO human targets before root decisions; mailbox release closes every index atomically',withFixture(t=>{
  admit(t,'a');const first=t.human('member:b'),second=t.human('member:c'),root=t.human('member:root');
  const outcomes=drain(t.core);assert.equal(outcomes.length,1);
  const a=t.store.read(outcomes[0].attemptId);assert.equal(a.owner,'member:b');assert.equal(a.runClass,'human-mailbox');assert.deepEqual(a.scopeSet,[]);
  assert.equal(capacityUsage(t.store).normal,1);assert.equal(capacityUsage(t.store).human,1);
  assert.throws(()=>owner(t,root.result.humanOriginRef),e=>e.code==='CAPACITY');
  assert.throws(()=>t.core.finish(a.entityId,a.fence,'produced'),e=>e.code==='ROLE_GUARD_DENIED');
  const slot=t.store.list('control-slot:')[0];assert.equal(slot.holderRef,a.entityId);
  // A crash at commit leaves attempt, task, SQL slot, and capacity index unchanged.
  const before=JSON.stringify(t.store.list());t.store.hooks.beforeCommit=()=>{throw Error('cutpoint');};
  assert.throws(()=>release(t,outcomes[0]),/cutpoint/);delete t.store.hooks.beforeCommit;assert.equal(JSON.stringify(t.store.list()),before);
  release(t,outcomes[0]);assert.equal(t.store.read(a.entityId).lease,'released');assert.equal(t.store.read(a.taskId).status,'cancelled');
  assert.equal(t.store.read(slot.entityId).state,'released');
  const next=drain(t.core);assert.equal(t.store.read(next[0].attemptId).owner,'member:c');
  release(t,next[0]);const owned=owner(t,root.result.humanOriginRef);assert.equal(owned.lane,'human');
  assert.equal(t.store.list('attempt:').filter(a=>a.owner==='member:root').length,0);
  assert(first.result.humanOriginRef&&second.result.humanOriginRef);
 }));

test('H03/H06: status is pure while H/N full; unknown owner stays occupied across recovery, no TTL or insufficient proof release',withFixture(t=>{
  admit(t,'a');const h=t.human('member:root','status'),slot=owner(t,h.result.humanOriginRef);
  const snapshot=JSON.stringify(t.store.list());const status=capacityStatus(t.core);assert.equal(status.human.current,1);assert.equal(status.normal.current,1);
  assert.equal(JSON.stringify(t.store.list()),snapshot);assert.equal(t.human('member:b').result.visible,false);
  t.core.controlFact(slot.entityId,{},tx=>settleOwnerControl(tx,{slotRef:slot.entityId,callIdentity:slot.callIdentity,hostEpoch:'host:1',now:1e15,reason:
    'timeout'}));
  assert.equal(t.store.read(slot.entityId).state,'unknown');assert.equal(capacityStatus(t.core).admissionClosed,true);
  assert.throws(()=>t.core.controlFact(slot.entityId,{},tx=>settleOwnerControl(tx,{slotRef:slot.entityId,callIdentity:'forged',hostEpoch:'host:1',terminal:
    true,now:1e15})),e=>e.code==='DENIED');
  const recovered=new TeamCore(t.store,{}, {...cfg,attach:false});assert.equal(capacityStatus(recovered).human.current,1);
  assert.equal(t.store.read('execution-outcome:'+slot.callIdentity).state,'unknown');
  t.core.configuration.maxRuns=0;t.core.task('task:b','member:b');assert.throws(()=>t.core.schedule('lower','task:b'),e=>e.code==='CAPACITY_UNKNOWN');
 }));

test('H06 normal unknown: an unproven N execution closes both execution lanes and owner admission',withFixture(t=>{
  const a=admit(t,'a');t.core.mutate(a.attemptId,'adapter',{},tx=>tx.put(a.attemptId,{...tx.read(a.attemptId),lease:'unknown',status:'unknown'}));
  t.core.configuration.maxRuns=3;t.core.task('task:b','member:b');
  const human=t.human('member:root');t.human('member:c');
  const status=capacityStatus(t.core);assert.equal(status.unknown,1);assert.equal(status.admissionClosed,true);
  assert.equal(status.normal.unknown,1);assert.equal(status.normal.current,1);
  assert.throws(()=>t.core.schedule('unknown-normal','task:b'),e=>e.code==='CAPACITY_UNKNOWN');
  assert.throws(()=>owner(t,human.result.humanOriginRef),e=>e.code==='CAPACITY_UNKNOWN');
  assert.equal(drain(t.core).length,0);assert.equal(t.store.list('attempt:').length,1);
 }));

test('H04: model/operator JSON labels cannot mint H/I; target-bound origins never authorize start/delivery/new work',withFixture(t=>{
  const request={operationId:'v1:operation:machine-input',recipient:'member:b',purpose:'message',summary:'machine'};
  assert.throws(()=>t.gateway.send(request,{role:'user',teamId:cfg.teamId}),e=>e.code==='DENIED');
  for(const extra of [{humanOrigin:true},{humanOriginRef:'human-input:fake'},{trafficClass:'human'},{role:'user'},{source:{kind:'user'}}])
    assert.throws(()=>t.core.send('member:a','member:b','info','fake',extra),e=>e.code==='DENIED');
  const h=t.human('member:b');const origin=h.result.humanOriginRef;
  for(const kind of ['start','delivery','create','dispatch'])assert.equal(effectTrafficClass(t.store,{payload:{kind,trafficClass:'human',originRef:origin,
    messageId:h.result.entityId}}),'normal');
  assert.equal(effectTrafficClass(t.store,{payload:{kind:'wake',trafficClass:'human',originRef:origin,messageId:h.result.entityId,recipient:'member:c'}}),
    'normal');
  assert.throws(()=>t.gateway.send({...request,operationId:'v1:operation:provision',purpose:'provision'},t.token),e=>e.code==='DENIED');
  assert.equal(t.store.list('human-input:').length,1);
  assert.throws(()=>t.core.send('member:root','member:c','info','wrong target',{humanOriginRef:origin}),e=>e.code==='DENIED');
  const forwarded=t.core.send('member:root','member:b','info','forwarded',{humanOriginRef:origin});
  assert.equal(effectTrafficClass(t.store,t.store.effects().find(e=>e.id===forwarded.result.entityId)),'human');
  assert.throws(()=>t.core.send('member:b','member:b','info','descendant',{humanOriginRef:origin}),e=>e.code==='DENIED');
  assert.throws(()=>t.core.send('member:root','member:b','action','new work',{humanOriginRef:origin,expectedOutcome:'work',deadline:'2099-01-01'}),e=>
    e.code==='DENIED');
 }));

test('H07: ordinary mailbox consumes N; N jobs waiting for root do not deadlock H, queued humans win next allocation',withFixture(t=>{
  t.core.send('member:root','member:a','action','ordinary',{deadline:new Date(Date.now()+60000).toISOString(),expectedOutcome:'reply'});
  const mail=drain(t.core);assert.equal(t.store.read(mail[0].attemptId).runClass,'mailbox');assert.equal(capacityUsage(t.store).normal,1);
  t.core.task('task:b','member:b');assert.throws(()=>t.core.schedule('full','task:b'),e=>e.code==='CAPACITY');
  const sent=t.core.send('member:b','member:root','intent','decide',{taskRef:'task:b',contractRevision:1,reason:'wait',evidenceRefs:['task:b'],
    expectedOutcome:'decide'});
  const slot=owner(t,sent.result.decisionRef);assert.equal(capacityUsage(t.store).human,1);
  const human=t.human('member:c');t.core.controlFact(slot.entityId,{},tx=>settleOwnerControl(tx,{slotRef:slot.entityId,callIdentity:slot.callIdentity,
    hostEpoch:'host:1',terminal:true,evidenceRef:'real end',now:Date.now()}));
  assert.throws(()=>owner(t,sent.result.decisionRef,'owner-call:next'),e=>e.code==='CAPACITY');
  const next=drain(t.core);assert.equal(t.store.read(next[0].attemptId).humanOriginRef,human.result.humanOriginRef);
 }));

test('H07 normal FIFO: newer low-ID work cannot starve older work or an ordinary mailbox',withFixture(t=>{
  t.core.task('task:z-old','member:a');t.core.task('task:a-new','member:b');
  const first=drain(t.core);assert.equal(first.length,1);assert.equal(t.store.read(first[0].attemptId).taskId,'task:z-old');
  t.core.send('member:root','member:c','action','ordinary mailbox',{deadline:'2099-01-01',expectedOutcome:'reply'});assert.equal(drain(t.core).length,0);
  release(t,first[0]);t.core.task('task:0-newer','member:a');
  const second=drain(t.core);assert.equal(second.length,1);assert.equal(t.store.read(second[0].attemptId).taskId,'task:a-new');
  release(t,second[0]);t.core.task('task:00-newest','member:b');
  const third=drain(t.core);assert.equal(third.length,1);assert.equal(t.store.read(third[0].attemptId).runClass,'mailbox');assert.equal(t.store.read(third[
    0].attemptId).owner,'member:c');
 }));

test('H05 v1: delegation concurrency/token exhaustion blocks new work, never safe existing human communication; completion freeze still wins',withFixture(t=>{
  t.core.configuration.maxRuns=3;
  const a=admit(t,'a');t.core.task('task:b','member:b',[],{delegationRef:'delegation:limited'});
  t.core.mutate('delegation:limited','adapter',{},tx=>tx.put('delegation:limited',{budget:{concurrency:0,tokens:{inputLimit:1,outputLimit:1}},expiresAt:
    '2099-01-01'}));
  assert.throws(()=>t.core.schedule('concurrency','task:b'),e=>e.code==='DELEGATION_CONCURRENCY');
  t.core.mutate('delegation:limited','adapter',{},tx=>{tx.put('delegation:limited',{...tx.read('delegation:limited'),budget:{concurrency:3,tokens:{inputLimit:
    1,outputLimit:1}}});tx.put('task:a',{...tx.read('task:a'),delegationRef:'delegation:limited'});return null;});
  recordUsage(t.core,{memberId:'member:a',sessionId:'used',input:10,output:10,source:'usage-event',eventKey:'session:used:1',revision:1,totalInput:10,
    totalOutput:10});
  assert.throws(()=>t.core.schedule('token-full','task:b'),e=>e.code==='DELEGATION_TOKEN_BUDGET');
  const h=t.human('member:a');assert.equal(t.store.read(a.attemptId).lease,'active');assert.equal(h.result.humanOriginRef.startsWith('human-input:'),true);
  t.core.mutate('completion:freeze','adapter',{},tx=>tx.put('completion:freeze',{status:'unknown'}));
  assert.throws(()=>t.human('member:a'),e=>e.code==='COMPLETION_FROZEN');
  assert.equal(capacityStatus(t.core).normal.current,1);
 }));

test('H06/H07: H mailbox certificate closeout retains UNIQUE and releases attempt/task/SQL/control index atomically even frozen',withFixture(t=>{
  t.human('member:b');const a=drain(t.core)[0],slot=t.store.list('control-slot:')[0];
  const start=t.store.claim(t.core.command('effect:'+a.attemptId,'adapter',{}),a.attemptId,'adapter',Date.now()).result;
  t.store.settle(t.core.command('effect:'+a.attemptId,'adapter',{}),a.attemptId,start.fence,{executed:true,receipt:{fixture:'start completed'}});
  const proof=certificate(t.core,{kind:'attempt',id:a.attemptId,fence:a.fence});
  const bad=structuredClone(proof);bad.coverage.complete=false;
  assert.throws(()=>t.core.dispatch('execution-close','adapter',{}, {type:'execution.close',payload:{proof:bad,evidenceRef:'stop:bad',purpose:'cancel'}}),e=>
    e.code==='STOP_NOT_CONFIRMED');
  assert.equal(t.store.read(slot.entityId).state,'held');
  t.core.mutate('completion:frozen','adapter',{},tx=>tx.put('completion:frozen',{status:'unknown'}));
  t.core.dispatch('execution-close','adapter',{}, {type:'execution.close',payload:{proof,evidenceRef:'stop:verified',purpose:'cancel'}});
  assert.equal(t.store.read(a.attemptId).lease,'revoked');assert.equal(t.store.read(slot.entityId).state,'released');
  assert.equal(t.store.read(t.store.read(a.attemptId).taskId).status,'cancelled');
  t.core.controlFact(slot.entityId,{},tx=>tx.put('completion:frozen',{...tx.read('completion:frozen'),status:'cancelled'}));
  t.core.task('task:after-mail','member:b');assert(t.core.schedule('after-mail','task:after-mail').result.attemptId,'same owner SQL slot truly freed');
 }));

test('H03/B07: capacity/transport audits alone never change input cutoff or self-inject a new batch',withFixture(t=>{
  const h=t.human('member:root');const before=batchCandidate(t.core,'member:root');assert(before);
  const slot=owner(t,h.result.humanOriginRef);
  t.core.controlFact('effect-io:diagnostic',{},tx=>tx.put('effect-io:diagnostic',{state:'released',effectId:'diagnostic',lane:'normal'}));
  t.core.controlFact(slot.entityId,{},tx=>settleOwnerControl(tx,{slotRef:slot.entityId,callIdentity:slot.callIdentity,hostEpoch:'host:1',terminal:true,
    evidenceRef:'end',now:Date.now()}));
  assert.equal(batchCandidate(t.core,'member:root',{previous:before.manifest}),null,'internal occupancy audit is not a new input');
 }));

test('H07 CAS: a wake row lost to a concurrent writer is re-decided, so the pass still allocates the H lane',withFixture(t=>{
  t.human('member:b');
  const realTask=t.core.task.bind(t.core);let raced=1;
  // The other process's drain rewrote the same wake row between this pass's read and its commit.
  t.core.task=(taskId,...rest)=>{if(raced-->0)throw Object.assign(Error('CAS_CONFLICT'),{code:'CAS_CONFLICT'});return realTask(taskId,...rest);};
  const outcomes=drain(t.core);
  assert.equal(outcomes.rejected,0,'a lost revision is re-read, not answered as a refusal');
  assert.equal(outcomes.length,1,JSON.stringify(outcomes));
  assert.equal(t.store.read(outcomes[0].attemptId).capacityLane,'human');
  assert.equal(capacityUsage(t.store).human,1);
  assert.equal(capacityUsage(t.store).normal,0);
 }));

test('H fixture: close failure never masks the primary assertion',()=>{
 const t=fixture(),primary=Object.assign(Error('primary H assertion'),{code:'PRIMARY_H'}),close=t.store.close;
 t.store.close=()=>{throw Error('injected H close failure');};
 try{assert.throws(()=>{try{throw primary;}catch(error){t.close(error);throw error;}},
   error=>error===primary&&error.cleanupErrors?.[0]?.cleanup?.close?.message==='injected H close failure');}
 finally{t.store.close=close;try{t.close();}catch{/* the injected close failure may also leave the directory locked */}}
});

test('H wrapper: a body error survives a close failure',async()=>{
 const primary=Object.assign(Error('primary wrapper assertion'),{code:'PRIMARY_WRAPPER'}),original=ControlStore.prototype.close;
 ControlStore.prototype.close=function(){original.call(this);throw Error('wrapper close failed');};
 try{await assert.rejects(withFixture(async()=>{throw primary;})(),error=>error===primary&&
   error.cleanupErrors?.[0]?.cleanup?.close?.message==='wrapper close failed');}
 finally{ControlStore.prototype.close=original;}
});

test('H07 stress: 8 contenders in 2 real processes contend at a barrier for N/H in SQLite transactions, no oversell or UNIQUE failure', {timeout:60000},
  withFixture(async t=>{
 const workers=[];let allocations=0,contended=0,maxPasses=0;try{
  // Every failure below names what each process saw: its admissions, the drain passes it drove, and the
  // candidates drain answered instead of admitting (the codes a pass swallows are the ones that must stay visible).
  const summary=settled=>JSON.stringify(settled.map(s=>({...s,rejections:(s.rejections??[]).map(r=>r.taskId+'='+r.code)})));
  for(let n=0;n<8;n++)t.core.member('member:w'+n,'worker','stress'+Math.floor(n/4));
  const script=fileURLToPath(new URL('../test-support/capacity-worker.mjs',import.meta.url)),ready=[];
  for(let n=0;n<2;n++){
   const p=spawn(process.execPath,[script,t.dir,String(n)],{stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,NODE_TEST_CONTEXT:''}});workers.push(p);
   ready.push(new Promise((resolve,reject)=>{let text='';p.stderr.on('data',d=>text+=d);p.once('error',reject);p.on('message',m=>{if(m.ready)resolve();
     else p.resolveRound?.(m);});
    p.once('exit',c=>{if(c){const error=Error(text||'worker exited '+c);reject(error);p.rejectRound?.(error);}});
   }));
  }
  await Promise.all(ready);
  for(let round=0;round<24;round++){
   for(let n=0;n<8;n++){t.core.task('task:w'+n+':'+round,'member:w'+n);t.human('member:w'+n);}
   const results=workers.map(p=>new Promise((resolve,reject)=>{p.resolveRound=resolve;p.rejectRound=reject;}));
   for(const p of workers)p.send({round});const settled=await Promise.all(results);
   assert(settled.every(s=>s.round===round));maxPasses=Math.max(maxPasses,...settled.map(s=>s.passes??1));
   assert.deepEqual(settled.flatMap(s=>s.violations),[],'transaction-local bounds and mailbox index');
   assert.deepEqual(settled.flatMap(s=>s.errors).filter(e=>!/^(CAPACITY|BLOCKED|NOT_READY|CAS_CONFLICT)$/.test(e)),[],summary(settled));
   const lock=settled.filter(s=>s.heldAt).sort((a,b)=>BigInt(a.heldAt)<BigInt(b.heldAt)?-1:1)[0];assert(lock);
   // At least one other worker entered its scheduling call before the first writer unlocked it.
   assert(settled.filter(s=>BigInt(s.started)<BigInt(lock.heldUntil)&&BigInt(s.ended)>BigInt(lock.heldAt)).length>=2,
     'workers must overlap a real locked transaction');contended++;
   const use=capacityUsage(t.store);assert.equal(use.normal,1,summary(settled));assert.equal(use.human,1,summary(settled));
   assert.equal(settled.reduce((n,s)=>n+s.accepted,0),2,summary(settled));assert.equal(use.runs.length,2);assert.equal(new Set(use.runs.map(a=>
     a.owner)).size,2);
   allocations+=2;
   // No port ran: release these never-started attempts, then genuinely allocate again next round.
   for(const a of use.runs)release(t,{attemptId:a.entityId,fence:a.fence});
   assert.equal(capacityUsage(t.store).normal,0);assert.equal(capacityUsage(t.store).human,0);
   assert(t.store.list('control-slot:').every(s=>s.state==='released'));
   t.core.mutate('stress-round:'+round,'adapter',{},tx=>{for(let n=0;n<8;n++){const id='task:w'+n+':'+round,row=tx.read(id);if(row.status==='ready')tx.put(
     id,{...row,status:'cancelled'});}return null;});
  }
  for(const p of workers)p.send('done');
  await Promise.all(workers.map(p=>new Promise((resolve,reject)=>p.exitCode!==null?(p.exitCode===0?resolve():reject(Error('worker exit '+p.exitCode))):p.once(
    'exit',c=>c===0?resolve():reject(Error('worker exit '+c))))));
  assert.equal(allocations,48);assert.equal(contended,24);assert.equal(t.store.list('attempt:').length,48);
  console.log('H07 stress: processes=2, contenders=8, rounds=24, allocations=48, contended=24, maxDrainPasses='+maxPasses+
    ', normal<=1 human<=1, UNIQUE errors=0');
 }finally{
  const exits=workers.filter(p=>p.exitCode===null&&p.signalCode===null).map(p=>new Promise(resolve=>{p.once('exit',resolve);p.kill();}));
  await Promise.all(exits);assert(workers.every(p=>p.exitCode!==null||p.signalCode!==null),'all pressure children exited');
 }
}));