import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionScopes } from '../execution-scope.mjs';
import { recordExecution, closeExecution, canCloseExecution } from '../../core/index.mjs';

const identity = (n=1) => ({ teamId:'team',memberId:'member:w',generation:1,executionSessionId:'session:'+n,
  attemptId:'attempt:'+n,attemptFence:1,executionEpoch:'epoch:'+n });
const complete = { gates:true,attribution:true,transport:true,subprocess:true };
function world(n=2) {
  let rows = new Map(),seq=0;
  rows.set('member:w',{entityId:'member:w',generation:1});
  for(let i=1;i<=n;i++) {
    const E=identity(i);
    rows.set(E.attemptId,{entityId:E.attemptId,owner:E.memberId,generation:1,fence:1,executionSessionId:E.executionSessionId,
      lease:'active',status:'running',taskId:'task:'+i});
    rows.set('task:'+i,{entityId:'task:'+i,attemptId:E.attemptId,status:'executing'});
    rows.set('wait:'+i,{entityId:'wait:'+i,attemptId:E.attemptId,status:'pending'});
  }
  const tx = { latestEventSeq:()=>seq,read:k=>structuredClone(rows.get(k)), list:p=>[...rows.values()].filter(r=>r.entityId.startsWith(p)).map(r=>
    structuredClone(r)),
    put(k,v){ const row={...structuredClone(v),entityId:k};rows.set(k,row);seq++;return row; },outbox(){} };
  const commit = work => {const backup=structuredClone(rows),priorSeq=seq;try{return work(tx);}catch(e){rows=backup;seq=priorSeq;throw e;}};
  const registry=createExecutionScopes({persist:s=>commit(tx=>recordExecution(tx,s)),read:tx.read});
  return {tx,commit,registry,open:(n=1,c=complete)=>registry.open(identity(n),c)};
}
const subject = E => ({kind:'attempt',id:E.attemptId,fence:E.attemptFence});

test('ambient context cannot lend an execution permit to another registry/team',()=>{
  const a=createExecutionScopes(),b=createExecutionScopes(),scope=a.open(identity(),complete);
  scope.run(()=>{assert.strictEqual(a.current(),scope);assert.throws(()=>b.current(),/EXECUTION_CONTEXT_STALE/);});
});

test('seal is permanent; each reservation exists before external work starts',async()=>{
  const w=world(),s=w.open(); let resume,started=false;
  const pending=s.perform('pending-spawn',async()=>{started=true;assert.equal(w.tx.read('execution-scope:epoch:1').active,1);await new Promise(r=>resume=r);});
  assert.equal(started,true);s.seal();
  assert.throws(()=>s.acquire('fallback'),/EXECUTION_SEALED/);
  assert.equal(s.prove(subject(s.E)).verified,false);resume();await pending;
  const proof=s.prove(subject(s.E));assert.equal(proof.verified,true);
  assert.throws(()=>s.acquire('retry'),/EXECUTION_SEALED/);
  w.commit(tx=>closeExecution(tx,{proof,evidenceRef:'proof:1',attempts:[tx.read('attempt:1')]}));s.released(proof);
  assert.equal(w.tx.read('attempt:1').lease,'revoked');assert.equal(w.tx.read('task:1').status,'cancelled');
  assert.equal(w.tx.read('wait:1').status,'cancelled');assert.equal(w.tx.read('attempt:2').lease,'active');
});

test('C producer closure and every X are required; a transmission answer cannot close its siblings',async()=>{
  const w=world(),s=w.open(),c1=s.call(),c2=s.call();let r1,r2;
  const p1=c1.send('a',1,()=>new Promise(r=>r1=r)),p2=c1.send('a',2,()=>new Promise(r=>r2=r));
  s.seal();r1();await p1;assert.equal(s.activities('transmission').length,1,'tx2 survives tx1 even on the same dispatch attempt');
  c1.close();assert.equal(s.prove(subject(s.E)).verified,false);
  r2();await p2;assert.equal(s.prove(subject(s.E)).verified,false);
  assert.throws(()=>c2.send('b',1,()=>{}),/EXECUTION_SEALED/);c2.close();assert.equal(s.prove(subject(s.E)).verified,true);
});

test('unknown cannot be erased by fake tokens, exception attributes, coverage repair or idle',async()=>{
  const w=world(),s=w.open();await assert.rejects(s.perform('io',()=>{throw Object.assign(Error('failed'),{notExecuted:true});}));
  const token=s.acquire('io');assert.equal(s.finish({...token}),false);s.finish(token);s.seal();
  assert.equal(s.prove(subject(s.E)).verified,false);
  const x=world().open(1,{...complete,transport:false});x.seal();assert.throws(()=>x.coverage('transport',true),/COVERAGE_SEALED/);
  assert.equal(x.prove(subject(x.E)).verified,false);
});

test('T1 end is a fact about T1, not permission to end T2',()=>{
  const w=world(),s=w.open(),t1=s.startTurn('T1');s.endTurn(t1);const t2=s.startTurn('T2');
  assert.equal(s.endTurn(t1),false);assert.equal(s.endTurn({...t2}),false);s.seal();assert.equal(s.prove(subject(s.E)).verified,false);
  s.endTurn(t2);assert.equal(s.prove(subject(s.E)).verified,true);
});

test('certificate replay, stale epoch/version/stopId/coverage and widened scope fail atomically',()=>{
  for(const change of [p=>p.E.executionEpoch='old',p=>p.stopId='old',p=>p.scopeVersion++,p=>p.coverage.complete=false,p=>p.certificateId='old']){
    const w=world(),s=w.open();s.seal();const proof=structuredClone(s.prove(subject(s.E)));change(proof);
    assert.throws(()=>w.commit(tx=>closeExecution(tx,{proof,evidenceRef:'proof',attempts:[tx.read('attempt:1')]})),/STOP_NOT_CONFIRMED/);
    assert.equal(w.tx.read('attempt:1').lease,'active');assert.equal(w.tx.read('wait:1').status,'pending');
  }
  const w=world(),s=w.open();s.seal();const proof=s.prove(subject(s.E));
  assert.equal(canCloseExecution(w.tx,proof,[w.tx.read('attempt:1'),w.tx.read('attempt:2')]),false);
  for(const change of [p=>p.stopId='wrong',p=>p.version++,p=>p.E={...p.E,teamId:'another-team'}]) {
    const pointer=w.tx.read('execution-current:attempt:1');change(pointer);w.tx.put(pointer.entityId,pointer);
    assert.equal(canCloseExecution(w.tx,proof,[w.tx.read('attempt:1')]),false);
    w.tx.put('execution-current:attempt:1',{E:s.E,state:'PROVEN',version:proof.scopeVersion,stopId:proof.stopId});
  }
  assert.throws(()=>w.registry.open(identity()),/EXECUTION_ALREADY_OPEN/);
  const restarted=createExecutionScopes({read:w.tx.read});assert.throws(()=>restarted.open(identity()),/EXECUTION_RECOVERY_REQUIRED/);
  const durable=w.tx.read('execution-scope:epoch:1');
  w.tx.put('execution-scope:epoch:1',{...durable,stopId:'foreign-stop'});
  assert.equal(canCloseExecution(w.tx,proof,[w.tx.read('attempt:1')]),false,'scope and pointer must independently match stopId');
  w.tx.put('execution-scope:epoch:1',{...durable,coverage:{...durable.coverage,transport:false}});
  assert.equal(canCloseExecution(w.tx,proof,[w.tx.read('attempt:1')]),false,'complete flag cannot hide a missing coverage component');
});

test('failed permit persistence gates all later IO and never runs the failed operation',async()=>{
  let writes=0,sideEffects=0;
  const s=createExecutionScopes({persist:()=>{if(++writes>1)throw Error('disk failed');}}).open(identity(),complete);
  await assert.rejects(s.perform('spawn',()=>sideEffects++),/disk failed/);assert.equal(sideEffects,0);
  assert.throws(()=>s.acquire('fallback'),/EXECUTION_SEALED/);assert.equal(s.state(),'UNVERIFIED');
});

// Independent bounded scheduler. The oracle is a bag of outstanding reservations plus a permanent closed bit.
function* schedules(chains,prefix=[]) {
  if(chains.every(c=>!c.length)){yield prefix;return;}
  for(let i=0;i<chains.length;i++)if(chains[i].length){const copy=chains.map(c=>c.slice());const action=copy[i].shift();yield* schedules(copy,[...prefix,
    action]);}
}
test('exhaustive interleavings: seal vs 2 calls x 2 transmissions and pending spawn',()=>{
  let checked=0;
  for(const trace of schedules([['call1','tx11','tx12','end11','end12','close1'],['call2','tx21','tx22','end21','end22','close2'],['spawn','spawnEnd'],[
    'seal']])) {
    const s=createExecutionScopes().open(identity(),complete),tokens=new Map();let sealed=false,active=0;
    for(const event of trace){
      if(event==='seal'){s.seal();sealed=true;}
      else if(event==='spawnEnd'||event.startsWith('end')||event.startsWith('close')){
        const key=event==='spawnEnd'?'spawn':event.startsWith('end')?'tx'+event.slice(3):'call'+event.slice(5);
        if(tokens.has(key)){s.finish(tokens.get(key));tokens.delete(key);active--;}
      }else if(sealed){assert.throws(()=>s.acquire(event),/EXECUTION_SEALED/);}
      else {tokens.set(event,s.acquire(event));active++;}
      if(sealed)assert.equal(s.prove(subject(s.E)).verified,active===0,JSON.stringify(trace));
      // prove is terminal on success; remaining actions must all be rejected, no re-open.
      if(s.state()==='PROVEN')break;
    }
    checked++;
  }
  assert.ok(checked>1000);console.log('checked interleavings:',checked);
});
