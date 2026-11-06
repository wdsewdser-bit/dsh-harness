import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ControlStore} from '../../packages/store/index.mjs';
import {TeamCore} from '../../packages/core/index.mjs';
import {handleTool} from '../../packages/core/tools.mjs';
import {normalizeDeadline,normalizeToolDeadlines} from '../../packages/contracts/index.mjs';
import {snapshot} from '../../packages/core/snapshot.mjs';
import {recordInjection} from '../../packages/core/provenance.mjs';
import {protocolMetrics,sameIntent} from './protocol-metrics.mjs';
const root=process.argv[2];assert(root&&!fs.existsSync(root));fs.mkdirSync(root,{recursive:true});
const now=Date.now(),checks=[];
for(const [input,ms]of [['PT5M',300000],['PT1S',1000],['P7D',604800000],['P1DT2H3M4.125S',93784125]])assert.equal(Date.parse(normalizeDeadline(input,now)),now
  +ms);
for(const input of ['PT0S','PT0.999S','P8D','P1M','P1Y','P1W','P','PT','P1DT','-PT5M','PTInfinityS','PTNaNS','garbage',new Date(now).toISOString(),new Date(now
      +604800001).toISOString()])assert.throws(()=>normalizeDeadline(input,now),/INVALID_DEADLINE/);
// The two forms the second real collaboration run was refused on, one accepted and one refused for a reason the caller can
// act on. "PT10M" was never refused by this parser -- the recorded refusal was an absolute timestamp already in the past --
// so the accepted case is pinned as the one the model can safely send, and the refusal names the clock it judged against.
assert.equal(Date.parse(normalizeDeadline('PT10M',now)),now+600000,'PT10M is a legal deadline, relative to the server clock');
assert.equal(Date.parse(normalizeDeadline('PT10M',now+3600000)),now+4200000,'a duration is relative to the server clock, not to the caller');
{
  const past=new Date(now-1000).toISOString();
  let thrown;try{normalizeDeadline(past,now)}catch(e){thrown=e}
  assert(thrown,'a past absolute timestamp is still refused');
  assert.equal(thrown.code,'INVALID_DEADLINE');
  assert(thrown.detail.includes(past),'the refusal names the value it judged');
  assert(thrown.detail.includes(new Date(now).toISOString()),'the refusal names the server clock');
  assert(thrown.detail.includes('PT1S'),'the refusal publishes the forms that would be accepted');
  let far;try{normalizeDeadline(new Date(now+604800001).toISOString(),now)}catch(e){far=e}
  assert(far.detail.includes('more than 7 days'),'an over-range absolute deadline says which bound it broke');
}
assert.equal(normalizeDeadline(new Date(now+10000).toISOString(),now),new Date(now+10000).toISOString());
assert.equal(normalizeToolDeadlines({deadline:'PT5M',dependency:{kind:'ExternalEvidence',deadline:'PT30S'}},now).dependency.deadline,new Date(now+30000)
  .toISOString());
checks.push('duration parser bounds, PT10M accepted from the server clock, unreadable refusals name value/clock/bounds, nested evidence');
const store=new ControlStore(root+'/store'),core=new TeamCore(store,{}, {enabled:true});
try{
  core.member('member:root','root');core.member('member:a','worker');
  const args={operationId:'v1:operation:'+randomUUID(),expectedRevision:0,op:'send',to:'member:a',kind:'action',summary:'duration test',
    expectedOutcome:'checkpoint',deadline:'PT5M'},binding={actor:'member:root'};
  const clock=Date.now;let first;
  try{Date.now=()=>now;first=handleTool(core,binding,'team_message',args);Date.now=()=>now+600000;assert.deepEqual(handleTool(core,binding,'team_message',args),
      first);}finally{Date.now=clock;
    }
  assert.equal(first.result.deadline,new Date(now+300000).toISOString());assert.equal(args.deadline,'PT5M');assert.equal(store.list('message:').length,1);
  assert.equal(store.read('tool-intent:'+args.operationId).args.deadline,first.result.deadline);
  assert.throws(()=>handleTool(core,binding,'team_message',{...args,deadline:'PT6M'}),/ID_CONFLICT/);
  const count=store.events().length;
  assert.throws(()=>handleTool(core,binding,'team_message',{...args,operationId:'v1:operation:'+randomUUID(),deadline:'PT0S'}),/INVALID_DEADLINE/);
  assert.equal(store.events().length,count);assert.equal(store.list('message:').length,1);
  checks.push('first admission normalization, expired identical retry dedup, raw-input conflict, rollback with zero effect');
}finally{store.close();}
const error={actor:'a1',name:'team_message',args:{op:'send',to:'member:root',kind:'action',summary:'same intent',deadline:'PT0S'},requestId:'failed',at:100,
  error:'INVALID_DEADLINE'};
const success={actor:'a1',name:'team_message',args:{...error.args,deadline:'PT5M'},requestId:'corrected',at:101,source:'native-model-tool',
  resultRef:'message:one'};
const fixture=()=>({protocolErrors:[structuredClone(error)],toolActions:[structuredClone(success),...Array.from({length:8},(_,i)=>({actor:'root',
            name:'real_work',args:{op:'brief'},requestId:'other-'+i,at:200,source:'native-model-tool'}))],messages:[]});
let f=fixture(),m=protocolMetrics(f,[]);assert(m.passed);assert.equal(m.schemaErrorRate,.1);assert.equal(m.recoveredErrors,1);assert.equal(m.totalToolCalls,10);
for(const change of [x=>x.toolActions.pop(),x=>x.toolActions[0].actor='b1',x=>x.toolActions[0].requestId='failed',x=>x.toolActions[0].at=99,x=>x.toolActions[0]
    .args.to='member:other',x=>x.messages.push({status:'dead-letter'}),x=>delete x.protocolErrors[0].args]){f=fixture();change(f);assert.equal(protocolMetrics(
      f,
          [])
    .passed,false);}
// A guard rejection is not a protocol error, but it is never ignored: the progress the guard demanded is required.
f=fixture();f.protocolErrors[0].error='ROLE_DENIED';m=protocolMetrics(f,[]);
assert(m.passed);assert.equal(m.schemaErrorRate,0);assert.equal(m.protocolAttempts,9);assert.equal(m.recoveredErrors,0);assert.equal(m.guardRejections.count,1);
assert.equal(m.guardRejections.workedThrough,1);assert.equal(m.guardRejections.unresolved,0);assert.equal(m.byCode.ROLE_DENIED.kind,'guard');
f=fixture();f.protocolErrors[0].error='ROLE_DENIED';f.toolActions[0].name='team_read';
assert.equal(protocolMetrics(f,[]).guardsPassed,false);
assert.equal(protocolMetrics(f,[]).passed,true,'an unresolved guard must not be reported as a protocol failure');
f=fixture();f.protocolErrors[0].error='ROLE_DENIED';f.messages.push({status:'dead-letter'});assert.equal(protocolMetrics(f,[]).passed,false);
f=fixture();f.protocolErrors[0].error='ROLE_DENIED';assert.equal(protocolMetrics(f,[{entities:['message:one','message:two']}]).passed,false);
// An unknown code is never a guard: it stays a protocol defect.
f=fixture();f.protocolErrors[0].error='SOMETHING_NEW';m=protocolMetrics(f,[]);
assert.equal(m.byCode.SOMETHING_NEW.kind,'protocol');assert.equal(m.byCode.SOMETHING_NEW.items[0].resolved,false);
assert.equal(m.passed,false);assert.equal(m.guardRejections.count,0);
assert.equal(protocolMetrics(fixture(),[{entities:['message:one','message:two']}]).passed,false);
// A rewrite of the prose is no longer one of the failures: it is the repair a length refusal asks for, and it is
// checked as such below. Here the counterpart is changed, which is a genuinely different intent.
checks.push('10% corrected passes; over-limit, another counterpart/same-request/earlier correction, unknown provenance and dead letter fail');
// A summary refused for its length can only be repaired by rewriting it, so prose is not part of identity here.
// Judging it as a different intent made the retry that obeyed the refusal read as "never repaired" -- which is what
// turned one over-long message into an unrecovered protocol error in the first real collaboration run.
{
  const long={...error,error:'INVALID_STRING',args:{...error.args,summary:'s'.repeat(1024),deadline:'PT5M'}};
  const rewording={...success,args:{...long.args,summary:'the same intent, said in one line'}};
  const moved={...success,args:{...rewording.args,to:'member:other'}};
  const fx=intent=>({protocolErrors:[structuredClone(long)],toolActions:[structuredClone(intent),...fixture().toolActions.slice(1)],messages:[]});
  const repaired=protocolMetrics(fx(rewording),[]);
  assert(repaired.passed,'a rewritten summary is the repair the refusal asked for');
  assert.equal(repaired.recoveredErrors,1);
  const elsewhere=protocolMetrics(fx(moved),[]);
  assert.equal(elsewhere.passed,false,'retrying the same words at a different counterpart is not the same intent');
  assert.equal(elsewhere.recoveredErrors,0);
  // The identity is the address the failed call named, not the prose it carried and not fields it never sent: a retry
  // that keeps the counterpart and adds a field the first call omitted is still the repair of that first call.
  const base={op:'send',to:'member:a',summary:'a'};
  assert.equal(sameIntent(base,{...base,summary:'b',bodyRef:'artifact:1:a1'}),true,'an added field does not change the intent');
  assert.equal(sameIntent(base,{...base,summary:'b',kind:'action'}),true,'a field the failed call never sent cannot distinguish it');
  for(const change of [{to:'member:b'},{op:'accept'}])assert.equal(sameIntent(base,{...base,summary:'b',...change}),false,JSON.stringify(change)
    +' names a different intent');
  assert.equal(sameIntent({op:'accept',messageId:'message:one'},{op:'accept',messageId:'message:two'}),false,'an addressed row is part of the intent');
  // The two collaboration rows carry their subject in affects/about, so a decision retried with a shorter summary over
  // the same affected set is the repaired call, while the same words over a different set are a new one.
  assert.equal(sameIntent({summary:'a',affects:['task:x']},{summary:'b',affects:['task:x']}),true);
  assert.equal(sameIntent({summary:'a',affects:['task:x']},{summary:'b',affects:['task:y']}),false);
  assert.equal(sameIntent({about:'member:a',claim:'a'},{about:'member:a',claim:'b'}),true);
  assert.equal(sameIntent({about:'member:a',claim:'a'},{about:'member:b',claim:'b'}),false);
  assert.equal(sameIntent({op:'send',summary:'a'},{op:'send',summary:'b'}),false,'a call with no addressed key proves nothing');
  checks.push('a length-refused summary is repaired by rewriting it; a different counterpart or branch is not');
}
checks.push('guard rejections are reported apart from the schema rate and require the progress they demanded; unknown codes stay protocol, dead letters and ' +
  'duplicate effects always fail');

// The published omission is not a weakened guard: a caller that sends a revision is still held to it, and a call whose
// row is gone is still refused. Round 2 lost six calls to a required field the model could not read, so the field became
// optional on exactly those branches; this block pins both halves.
{
  const store=new ControlStore(root+'/cas'),core=new TeamCore(store,{},{enabled:true});
  try{
    core.member('member:root','root');core.member('member:a','worker');
    const bind={actor:'member:root'};
    const send={op:'send',to:'member:a',kind:'info',summary:'no revision'};
    const first=handleTool(core,bind,'team_message',{operationId:'v1:operation:cas-omit-0001',...send});
    assert(first.result.entityId.startsWith('message:'));
    // A branch that does name a row is still held to the revision it predicts: accept is not in the optional set.
    core.task('task:a','member:a',[]);
    const attempt=core.schedule('cas-a','task:a').result,aBind={actor:'member:a',attemptId:attempt.attemptId,fence:attempt.fence};
    const messageId=first.result.entityId;
    const carried=snapshot(core,'member:a');
    recordInjection(core,carried,'native:cas-visible',['cas-seq']);
    core.visible(messageId,{requestId:'r-cas',manifestHash:carried.manifest.hash,sessionSeq:1,requestedAt:Date.now()});
    const row=store.read(messageId);
    let stale;try{handleTool(core,aBind,'team_message',{operationId:'v1:operation:cas-stale-0002',expectedRevision:row.revision+1,
      op:'accept',messageId,checkpointRef:'checkpoint:cas'})}catch(e){stale=e}
    assert(stale,'a stale expectedRevision must be refused');assert.match(String(stale.message),/^CAS_CONFLICT/);
    const ok=handleTool(core,aBind,'team_message',{operationId:'v1:operation:cas-live-0003',expectedRevision:row.revision,
      op:'accept',messageId,checkpointRef:'checkpoint:cas'});
    assert.equal(store.read(messageId).status,'accepted','a correct prediction goes through');
    // A row that does not exist is not "the caller predicted nothing": the reference guards still run.
    let gone;try{handleTool(core,bind,'team_message',{operationId:'v1:operation:cas-missing-0004',op:'accept',
      expectedRevision:0,messageId:'message:v1:message:nonexistent',checkpointRef:'checkpoint:x'})}catch(e){gone=e}
    assert(gone,'a call naming a missing row must be refused');assert.match(String(gone.message),/MISSING_REFERENCE|CAS_CONFLICT/);
    checks.push('expectedRevision: optional where published, still compared when sent, missing rows still refused');
  }finally{store.close();}
}
fs.writeFileSync(root+'/report.json',JSON.stringify({status:'passed',checks,realProviderRequests:0},null,2));console
.log('deadline/protocol recovery tests PASS');