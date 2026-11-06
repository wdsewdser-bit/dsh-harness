import fs from 'node:fs';
import assert from 'node:assert/strict';
import {ControlStore} from '../../packages/store/index.mjs';
import {TeamCore} from '../../packages/core/index.mjs';
import {protocolMetrics,isHarnessError} from './protocol-metrics.mjs';
import {requireWorkArgs,reviewGuard,reviewDelivery,integrateGuard,deliveryRefs} from '../../packages/core/workload.mjs';
import {applyDeliveryVerification,recordDeliveryVerification} from './product-workload.mjs';
import {assertLosslessJson} from './tool-output.mjs';

/**
 * The two null-path defects from the third real run, and the concurrency ordering case behind them.
 *
 * 1. The verifier reviewed the last artifact before root had opened the review issue; the reply dereferenced a
 *    null thread and the model saw "Cannot read properties of null (reading 'replies')".
 * 2. Root called real_work integrate without opening the issue; the decision dereferenced a null thread and the
 *    model saw "Cannot read properties of null (reading 'owner')".
 * Both are now business refusals with a remedy, and a JavaScript internal exception is classified as a harness
 * defect that fails the run on its own line.
 */
const root=process.argv[2];assert(root&&!fs.existsSync(root));fs.mkdirSync(root,{recursive:true});const checks=[];
{
  const delivery={id:'artifact:1:a1',deliveryId:'delivery:task:real:1:a1',actor:'a1',status:'produced'};
  const cycle={deliveries:[delivery]},original=structuredClone(cycle);
  for(const deliveryId of [delivery.id,delivery.deliveryId])assert.equal(reviewDelivery(cycle,{deliveryId,approved:true},'verifier'),delivery);
  assert.deepEqual(cycle,original,'resolving either spelling has no side effects');
  assert.throws(()=>reviewDelivery(cycle,{deliveryId:'missing',approved:true},'verifier'),e=>
    e.code==='REVIEW_REJECTED'&&e.detail.includes(delivery.id)&&e.detail.includes(delivery.deliveryId)&&e.detail.includes('approved:true'));
  assert.throws(()=>reviewDelivery(cycle,{deliveryId:delivery.id,approved:false},'verifier'),/REVIEW_REJECTED/);
  delivery.status='verified';
  assert.throws(()=>reviewDelivery(cycle,{deliveryId:delivery.deliveryId,approved:true},'verifier'),/REVIEW_REJECTED/);
  assert.equal(delivery.status,'verified','alias cannot re-review or duplicate completed work');
  checks.push('review accepts artifact and delivery ids; invalid and repeated reviews give actionable remedies without mutation');
}
const codeOf=fn=>{try{fn();return null}catch(e){return {code:e.code??null,message:e.message,isTypeError:e instanceof TypeError}}};

// 1. A reply to a thread that does not exist yet is a business refusal naming the missing step.
const store=new ControlStore(root+'/store'),core=new TeamCore(store,{}, {enabled:true});
try{
  core.member('member:root','root');core.member('member:verifier','verifier');
  for(const issueId of ['thread:v1:issue:missing','thread:v1:issue:not-created-yet']){
    const reply=codeOf(()=>core.reply(issueId,'member:verifier',1,'artifact:1:a1'));
    assert(reply&&!reply.isTypeError,String(reply&&reply.message));
    assert.equal(reply.code,'UNKNOWN_THREAD');
    assert.match(reply.message,/real_work open|view:"thread"/);
    const decide=codeOf(()=>core.decide(issueId,'member:root',1,'artifact:1:a1'));
    assert(decide&&!decide.isTypeError);
    assert.equal(decide.code,'UNKNOWN_THREAD');
  }
  const noId=codeOf(()=>core.reply(undefined,'member:verifier',1,'artifact:1:a1'));
  assert.equal(noId.code,'UNKNOWN_THREAD');
  // The same reply succeeds once root opened the issue, so the refusal is recoverable rather than terminal.
  const issue=core.thread('member:root',['member:verifier'],'Review batch',new Date(Date.now()+300000).toISOString()).result;
  const replied=core.reply(issue.entityId,'member:verifier',1,'artifact:1:a1');
  assert.equal(replied.result.replies.length,1);
  const decided=core.decide(issue.entityId,'member:root',1,'artifact:1:a1');
  assert.equal(decided.result.status,'decided');
  checks.push('reply/decide on a missing thread refuse with UNKNOWN_THREAD and a remedy; the same reply succeeds after open');
}finally{store.close()}

// 2. A missing argument is a schema refusal with the field to pass, never a TypeError.
assert.equal(requireWorkArgs({op:'integrate'}),undefined,'integrate takes no arguments and must not be refused');
assert.equal(requireWorkArgs({op:'open'}),undefined);
for(const [args,field] of [[{op:'accept'},'messageId'],[{op:'produce'},'messageId'],[{op:'produce',messageId:'m'},'value'],
  [{op:'review',approved:true},'deliveryId']]){
  const refusal=codeOf(()=>requireWorkArgs(args));
  assert(refusal&&!refusal.isTypeError,JSON.stringify(args));
  assert.equal(refusal.code,'INVALID_TOOL_FIELDS');assert.match(refusal.message,new RegExp(field));
  assert.match(refusal.message,/real_work brief|snapshot|peer value/);
}
assert.equal(codeOf(()=>requireWorkArgs(undefined)).code,'INVALID_TOOL_FIELDS');
assert.equal(codeOf(()=>requireWorkArgs({op:'bogus'})),null,'an unknown op is the schema job, not the argument check');
checks.push('real_work refuses a missing argument by field name with where to get it, and accepts integrate with no arguments');

// 3. A JavaScript internal exception is a harness defect: listed separately and failing on its own.
const harnessRows=["Cannot read properties of null (reading 'replies')","Cannot read properties of null (reading 'owner')",
  "TypeError: x is not a function","undefined is not iterable"];
for(const message of harnessRows)assert(isHarnessError(message),message);
for(const message of ['REVIEW_REJECTED','DELIVERIES_NOT_VERIFIED','INVALID_TOOL_FIELDS: missing deliveryId','CAS_CONFLICT:task:real:1:a1'])
  assert(!isHarnessError(message),message);
const facts={protocolErrors:[{actor:'verifier',name:'real_work',args:{op:'review'},requestId:'request-85',at:100,
  error:"Cannot read properties of null (reading 'replies')"}],toolActions:[
  {actor:'root',name:'real_work',args:{op:'brief'},requestId:'request-90',at:200,source:'native-model-tool'}],messages:[]};
const m=protocolMetrics(facts,[]);
assert.equal(m.harnessErrors.count,1);
assert.equal(m.harnessErrors.items[0].requestId,'request-85');
assert.equal(m.errors[0].kind,'defect');
assert.equal(m.unrecoveredErrors,0,'a fixture defect must not be counted as an uncorrected model error');
assert.equal(m.schemaErrorRate,0);
assert.equal(m.passed,true,'the protocol verdict is about the model only; fixture failures are reported separately');
checks.push('TypeError-shaped failures are harnessErrors with their request ids, excluded from the schema rate');

// 4. The same facts without the harness defect stay clean, and the guard table is untouched by it.
const clean=structuredClone(facts);clean.protocolErrors[0].error='REVIEW_REJECTED';
assert.equal(protocolMetrics(clean,[]).harnessErrors.count,0);
assert.equal(protocolMetrics(clean,[]).guardRejections.count,1);
checks.push('a guard refusal is still a guard, not a fixture defect');


// 5. Cycle 2 of the fourth real run: four deliveries verified, the thread still read "collecting" with one reply, and
//    root waited forever because nothing it could read said "ready", then escalated. The ordering rules are pure
//    functions, so the exact state is reproduced here without a live run.
{
  const cycle=c=>{c.id=2;c.issue='thread:v1:issue:ready';c.assignments={a1:{},a2:{},b1:{},b2:{}};
    c.deliveries=['a1','a2','b1','b2'].map(actor=>({id:'artifact:2:'+actor,actor,status:'verified'}));return c;};
  // a) With no issue, neither the review nor the integrate may proceed, and neither is a TypeError.
  assert.equal(reviewGuard({id:2,assignments:{},deliveries:[]}),'REVIEW_THREAD_NOT_OPENED');
  assert.equal(integrateGuard({id:2,deliveries:[]},null),'DECISION_THREAD_REQUIRED');
  // b) The second real-run state: all verified, thread open, one reply of four recorded. Integrate says why.
  const open=cycle({});
  assert.equal(integrateGuard(open,{status:'collecting',readyToDecide:false}),'REVIEWS_INCOMPLETE',
    'a thread that has not recorded every review reply must not be integrable');
  assert.equal(integrateGuard(open,{status:'collecting',readyToDecide:true}),null,
    'a closing batch whose last review reply is recorded is integrable even while the row says collecting');
  assert.equal(integrateGuard(open,{status:'decided',readyToDecide:false}),null);
  assert.equal(integrateGuard(open,{status:'escalated'}),'DECISION_THREAD_REQUIRED');
  // c) Deliveries still produced take precedence: that refusal is the verifier's to fix, not root's ordering.
  const partial=cycle({});partial.deliveries[0].status='produced';
  assert.equal(integrateGuard(partial,{status:'collecting',readyToDecide:true}),'DELIVERIES_NOT_VERIFIED');
  checks.push('ordering rules: review needs the issue, integrate needs decided evidence, and the reason names the fix');

  // d) An issue opened before the workers produce already knows which deliveries it must account for, so the
  //    decision cannot admit a batch that was only partly reviewed.
  const refs=deliveryRefs({id:2,assignments:{a1:{},a2:{},b1:{},b2:{}},deliveries:[]});
  assert.deepEqual(refs,['artifact:2:a1','artifact:2:a2','artifact:2:b1','artifact:2:b2']);
  checks.push('the review issue declares one required delivery per assignment before anything is produced');

  // e) The end-to-end ordering on a real store: the verifier reviews one delivery at a time and the thread only
  //    becomes integrable after the fourth, with four replies from the single respondent.
  const store=new ControlStore(root+'/ordering'),core=new TeamCore(store,{}, {enabled:true});
  try{
    core.member('member:root','root');core.member('member:verifier','verifier');
    const issue=core.thread('member:root',['member:verifier'],'Review batch 2',new Date(Date.now()+300000).toISOString(),'operator',refs).result;
    const seen=[];
    for(const ref of refs){
      core.reply(issue.entityId,'member:verifier',1,ref);
      const row=core.store.read(issue.entityId);
      seen.push({n:row.replies.length,missing:row.missing.length,ready:row.readyToDecide});
    }
    // The first reply satisfies the respondent obligation and one evidence ref, so three refs remain; the count
    // must fall by one per delivery and reach zero only on the fourth.
    assert.deepEqual(seen,[{n:1,missing:3,ready:false},{n:2,missing:2,ready:false},{n:3,missing:1,ready:false},{n:4,missing:0,ready:true}]);
    assert.equal(issue.missing.length,5,'before any reply the issue needs the respondent plus four deliveries');
    assert.equal(core.store.read(issue.entityId).status,'collecting','the row stays collecting until the owner decides');
    assert.equal(integrateGuard(cycle({}),core.store.read(issue.entityId)),null);
    checks.push('a single respondent replying four times yields four replies and readiness on the fourth');
  }finally{store.close();}
}

// 6. A legitimate delivery.readback unknown is not a certificate and must not publish a verification reply. The
//    failure is returned explicitly (never as certificate:undefined), and the delivery stays non-integrable.
{
  const cases=[
    ['dirty',{status:'unknown',reason:'DIRTY_WORKTREE',lastEvidence:{code:'DIRTY_WORKTREE',at:1}}],
    ['head',{status:'unknown',reason:'GIT_FAILED',lastEvidence:{code:'GIT_FAILED',at:2}}],
    ['verifier',{status:'unknown',reason:'VERIFIER_TIMEOUT',lastEvidence:{code:'VERIFIER_TIMEOUT',at:3}}],
  ];
  for(const [name,result] of cases){
    const delivery={id:'artifact:2:b2',status:'produced'};const facts={};let replies=0;
    const outcome=applyDeliveryVerification({delivery,verified:result,facts,onVerified:()=>{replies+=1;}});
    assert.equal(outcome.failed,true,name);assert.equal(replies,0,name);const out=outcome.result;
    assert.equal(out.status,'unknown',name);assert.equal(out.certificate,null,name);assert.equal(delivery.status,'unknown',name);
    assert.equal(facts.verificationResults.length,1,name);assert.equal(facts.verificationResults[0].status,result.status,name);
    assert.equal(facts.verificationResults[0].code,result.lastEvidence.code,name);assert.equal(facts.verificationResults[0].reason,result.reason,name);
    assert.deepEqual(facts.verificationResults[0].lastEvidence,result.lastEvidence,name);
    assert.doesNotThrow(()=>assertLosslessJson(out),name);
    assert.equal(integrateGuard({id:2,issue:'thread:2',deliveries:[delivery,{status:'verified'},{status:'verified'},{status:'verified'}]},
      {status:'decided'}),'DELIVERIES_NOT_VERIFIED',name);
  }
  assert.equal(recordDeliveryVerification({id:'artifact:2:ok',status:'produced'}, {status:'verified',certificate:{verifier:'member:verifier'}}, {}),null,
    'a verified row with a certificate still takes the success path');
  let verifiedReplies=0;assert.equal(applyDeliveryVerification({delivery:{id:'artifact:2:ok',status:'produced'},
    verified:{status:'verified',certificate:{verifier:'member:verifier'}},facts:{},onVerified:()=>{verifiedReplies+=1;}}).failed,false);
  assert.equal(verifiedReplies,1,'only a verified row with a certificate reaches the reply path');
  checks.push('dirty/head/verifier unknown return explicit non-success JSON with raw status/code/reason, no reply path, no integration');
}

fs.writeFileSync(root+'/report.json',JSON.stringify({status:'passed',checks,realProviderRequests:0},null,2));
console.log('workload guard tests PASS: '+checks.length+' checks');
