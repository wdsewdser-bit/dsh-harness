import fs from 'node:fs';
import assert from 'node:assert/strict';
import {teamSchemas,teamSchemasFor,collabSchemas,validateTool} from '../../packages/contracts/team-tools.mjs';
import {operationIdPattern} from '../../packages/contracts/index.mjs';
import {rolePrompt,toolDescription,roleGuidance} from '../../packages/core/authorization.mjs';
import {ControlStore} from '../../packages/store/index.mjs';
import {TeamCore} from '../../packages/core/index.mjs';
import {handleTool,resolveReadRef} from '../../packages/core/tools.mjs';

/**
 * The published contract the model has to satisfy, checked directly rather than through a workload.
 *
 * Three defects made the last real run fail: an operation id form the server refused although it was unique and
 * readable, a read ref the model had to guess, and role limits the model only learned from a refusal. Each
 * check below pins the fixed behaviour, and the ref check pins that a wrong ref now fails with a readable
 * diagnosis instead of answering an empty list.
 */
const root=process.argv[2];assert(root&&!fs.existsSync(root));fs.mkdirSync(root,{recursive:true});const checks=[];

// 1. Operation identity: uniqueness and readability, not hexadecimal.
for(const id of ['v1:operation:cycle1-a1-send-0001','v1:operation:0f8a-1c2b','v1:operation:abc.def_ghi-jkl'])assert(operationIdPattern.test(id),id);
for(const id of ['v1:operation:short','operation:abcdefgh','v1:operation:'+'a'.repeat(129),'v1:operation:has space'])assert(!operationIdPattern.test(id),id);
assert.equal(teamSchemas.team_message.oneOf[0].properties.operationId.pattern,operationIdPattern.source);
checks.push('operationId accepts unique readable ids and the published schema uses the same pattern');

const store=new ControlStore(root+'/store'),core=new TeamCore(store,{}, {enabled:true});
try{
  core.member('member:root','root');core.member('member:a','worker');
  const bind={actor:'member:root'};
  // 2. Reads: the whole view needs no ref, "team" means the whole team, and a bare suffix resolves.
  const whole=handleTool(core,bind,'team_read',{view:'team'});
  assert(whole.refs.some(x=>x.entityId==='member:root'));
  assert.equal(handleTool(core,bind,'team_read',{view:'team',ref:'team'}).refs.length,whole.refs.length);
  assert.equal(resolveReadRef(core,'team','team'),null);
  assert.equal(resolveReadRef(core,'team'),null);
  const send=handleTool(core,bind,'team_message',{operationId:'v1:operation:cycle1-a1-send-0001',expectedRevision:0,
    op:'send',to:'member:a',kind:'info',summary:'readable id'});
  const id=send.result.entityId;
  assert(id.startsWith('message:'),id);
  assert.equal(handleTool(core,bind,'team_read',{view:'message',ref:id}).refs.length,1);
  assert.equal(resolveReadRef(core,'message',id.replace('message:','')),id,'a bare suffix resolves inside its view');
  assert.throws(()=>resolveReadRef(core,'task','not-a-real-task'),(e)=>e.code==='INVALID_REF'&&/omit ref/.test(e.detail));
  assert.throws(()=>resolveReadRef(core,'evidence','member:a'),
    (e)=>e.code==='INVALID_REF'&&/belongs to view "member"/.test(e.detail));
  // The evidence view holds two id families whose prefixes carry no view name. A bare suffix the snapshot published
  // ("1:a1") has to resolve against both, because that is the read the second real collaboration run was refused.
  core.mutate('artifact:1:a1','root',{kind:'artifact',producer:'member:a'},
    (tx,current)=>tx.put('artifact:1:a1',{...current,hash:'a'.repeat(64),status:'published'}));
  assert.equal(resolveReadRef(core,'evidence','1:a1'),'artifact:1:a1','a bare evidence suffix resolves to the artifact');
  assert.equal(resolveReadRef(core,'evidence','artifact:1:a1'),'artifact:1:a1');
  assert.throws(()=>handleTool(core,bind,'team_read',{view:'evidence',ref:'verification-evidence:1:a1'}),e=>
    e.code==='INVALID_REF'&&e.detail.includes('artifact:1:a1')&&e.detail.includes('team_read {"view":"evidence"}'));
  assert.throws(()=>handleTool(core,bind,'team_read',{view:'evidence',ref:'delivery:task:real:1:a1'}),e=>
    e.code==='INVALID_REF'&&e.detail.includes('artifact:1:a1')&&e.detail.includes('not delivery:task:'));
  assert.throws(()=>handleTool(core,{actor:'member:a'},'team_read',{view:'evidence',ref:'not-real'}),e=>
    e.code==='INVALID_REF'&&!e.detail.includes('artifact:1:a1')&&e.detail.includes('Readable choices: []'));
  checks.push('team_read: ref optional for a whole view, "team" accepted, suffix resolved, wrong ref diagnosed');
  // A refused read must never look like an empty collection.
  assert.throws(()=>handleTool(core,bind,'team_read',{view:'evidence',ref:'member:a'}),/INVALID_REF/);
}finally{store.close();}

// 3. The role limits are published where the model reads them: the tool description and the role contract.
const verifierTool=toolDescription('verifier','real_work'),rootTool=toolDescription('root','real_work');
assert(/cannot open/.test(verifierTool),verifierTool);
assert(/evidence/.test(verifierTool)&&/review/.test(verifierTool));
assert(/verified/.test(rootTool)&&/DELIVERIES_NOT_VERIFIED/.test(rootTool),rootTool);
for(const role of ['root','worker','verifier']){
  const prompt=rolePrompt(role),guidance=roleGuidance[role];
  assert(prompt.cannot===guidance.cannot&&prompt.how===guidance.how);
  assert(prompt.text.includes(guidance.cannot)&&prompt.text.includes(guidance.how),role);
  assert.equal(prompt.version,'p3a-v3');
  for(const name of ['team_read','team_message','real_work'])assert(toolDescription(role,name).length>40);
  // A binding contract is longer than the published limit, and the first real run lost turns to that: every member
  // learned the 1024/512 ceiling only from a refusal. The limit and the place the long part goes are published text.
  assert.match(toolDescription(role,'team_message','on'),/summary is at most 1024 characters/);
  assert.match(toolDescription(role,'team_message','on'),/bodyRef/);
  if(role!=='verifier')assert.match(toolDescription(role,'team_decision','on'),/summary is at most 512 characters/);
}
checks.push('verifier and root learn their limits from the tool description and the role contract, not from a refusal');

// 4. The readiness a model must be able to read: one respondent reviewing four deliveries leaves four replies, and
//    "collecting" with every delivery reviewed says so instead of leaving root to infer it.
{
  const store=new ControlStore(root+'/threads'),core=new TeamCore(store,{}, {enabled:true});
  try{
    core.member('member:root','root');core.member('member:verifier','verifier');
    const evidence=['artifact:2:a1','artifact:2:a2','artifact:2:b1','artifact:2:b2'];
    const opened=core.thread('member:root',['member:verifier'],'Review batch 2',new Date(Date.now()+300000).toISOString(),'operator',evidence).result;
    assert.equal(opened.status,'collecting');assert.deepEqual(opened.missing,['member:verifier',...evidence]);
    assert.equal(opened.readyToDecide,false);assert.match(opened.nextAction,/waiting for member:verifier/);
    core.reply(opened.entityId,'member:verifier',1,evidence[0]);
    let row=core.store.read(opened.entityId);
    assert.equal(row.replies.length,1,'a second respondent reply must not overwrite the first');
    assert.deepEqual(row.missing,evidence.slice(1),'respondent identity alone is not readiness: one of four reviewed is not ready');
    assert.equal(row.readyToDecide,false);
    // Reviewing the same delivery twice replaces its reply instead of inflating the thread.
    core.reply(opened.entityId,'member:verifier',1,evidence[0]);
    assert.equal(core.store.read(opened.entityId).replies.length,1);
    for(const ref of evidence.slice(1))core.reply(opened.entityId,'member:verifier',1,ref);
    row=core.store.read(opened.entityId);
    assert.equal(row.replies.length,4);
    assert.deepEqual(row.missing,[]);assert.equal(row.readyToDecide,true);
    assert.match(row.nextAction,/may decide or integrate now/);
    // The read model says the same thing the reducer enforces.
    const read=handleTool(core,{actor:'member:root'},'team_read',{view:'thread',ref:opened.entityId}).refs[0];
    assert.equal(read.readyToDecide,true);assert.deepEqual(read.missing,[]);assert.match(read.nextAction,/integrate/);
    const decided=core.decide(opened.entityId,'member:root',1,evidence[0]).result;
    assert.equal(decided.status,'decided');assert.equal(decided.readyToDecide,false);
    assert.match(decided.nextAction,/decided/);
    // An issue that requires only a respondent (no evidence refs) is decided by the first reply, as before.
    const simple=core.thread('member:root',['member:verifier'],'Simple review',new Date(Date.now()+300000).toISOString()).result;
    assert.deepEqual(simple.requiredEvidence,[]);
    assert.equal(core.reply(simple.entityId,'member:verifier',1,'artifact:3:a1').result.readyToDecide,true);
  }finally{store.close();}
  checks.push('thread readiness: one reply per reviewed delivery, readyToDecide/nextAction agree with decide');
}

// 5. A refusal must name the field to repair, not the branch machinery.
//
// The first real collaboration run lost turns to a refusal that read "unknown operation branch" for a call whose only
// fault was a summary 80 characters over the published limit, and whose payload was echoed in full so the sentence that
// said so was truncated away. Each case below pins the diagnosis a caller can act on.
{
  const refusal=(schema,value)=>{try{validateTool(schema,value);return null}catch(e){return{code:e.code,detail:String(e.detail??e.message)}}};
  const op='v1:operation:cycle1-a1-send-0001';
  const send={operationId:op,expectedRevision:0,op:'send',to:'member:a',kind:'info',summary:'x'.repeat(1100)};
  const long=refusal(teamSchemas.team_message,send);
  assert.equal(long.code,'INVALID_TOOL_BRANCH');
  assert.match(long.detail,/summary is 1100 characters and the published limit is 1024/,'the exact field and its limit');
  assert.match(long.detail,/publishable branches are/,'the branches stay published');
  assert(long.detail.indexOf('summary is 1100 characters')<120,'the field diagnosis is the first thing read, not a footnote');
  assert(!long.detail.includes('x'.repeat(65)),'the payload is shown once, truncated, never repeated');
  // The branch-level defect a caller can actually fix is quoted, not a branch complaint it does not have.
  const on=teamSchemasFor('on');
  assert.match(refusal(on.team_message,{...send,summary:'short',kind:'ask'}).detail,/kind must be one of info, action, decision/);
  const missing={...send};delete missing.summary;
  assert.match(refusal(on.team_message,missing).detail,/missing field\(s\) summary/,'a required field the caller forgot is named, not the branch');
  // A field the closest branch does not publish is named once; the remaining branches are still listed.
  const extra=refusal(teamSchemas.team_message,{...send,summary:'short',claim:'not a message field'});
  assert.match(extra.detail,/unknown field\(s\) claim/);
  assert(extra.detail.indexOf('unknown field(s) claim')<120,'the unknown field is named before the branch list');
  assert(extra.detail.indexOf('(got {')>extra.detail.indexOf('publishable branches'),'the payload is echoed once, at the end');
  assert(extra.detail.length<700,'a refusal stays readable: ' + extra.detail.length + ' characters');
  // The two collaboration-only tools publish their limits the same way.
  const decision=refusal(collabSchemas.team_decision,{operationId:'v1:operation:cycle1-a1-dec-0001',expectedRevision:0,summary:'y'.repeat(600)});
  assert.equal(decision.code,'INVALID_STRING');
  assert.match(decision.detail,/summary is 600 characters and the published limit is 512/);
  assert.match(collabSchemas.team_decision.properties.summary.description,/at most 512 characters/);
  assert.match(refusal(collabSchemas.team_assume,{operationId:'v1:operation:cycle1-a1-assume-0001',expectedRevision:0,
    about:'team:a',claim:'c',impact:'i'}).detail,/about must match|about must start/,'an assumption names an owner, never a view');
  // expectedRevision is published as optional exactly on the branches where the caller has no revision to predict, and
  // stays required on the ones that act on a row it read. That is a published field, not a loosened guard: a value that
  // is sent is still compared (tool-reducer), which deadline-protocol-test pins against a stale one.
  const required=(schema,index=null)=>schema.oneOf?schema.oneOf[index].required:schema.required;
  assert(!required(teamSchemas.team_message,0).includes('expectedRevision'),'a send creates the row it writes');
  assert(required(teamSchemas.team_message,1).includes('expectedRevision'),'accept still predicts the revision it read');
  assert(required(teamSchemas.team_message,2).includes('expectedRevision'),'resolve still predicts the revision it read');
  assert(!required(teamSchemas.team_task,1).includes('expectedRevision'),'produce acts on the caller own task');
  assert(!required(teamSchemas.team_verify).includes('expectedRevision'),'a verdict is guarded by independence, not CAS');
  assert(!required(teamSchemas.team_thread,0).includes('expectedRevision'),'open creates the issue');
  assert(required(teamSchemas.team_thread,2).includes('expectedRevision'),'decide still CAS the proposal revision');
  assert(!required(teamSchemasFor('on').team_decision).includes('expectedRevision'));
  assert(!required(teamSchemasFor('on').team_assume,0).includes('expectedRevision'));
  // Nothing valid is refused: the diagnostics must not have narrowed the published surface.
  assert.equal(refusal(teamSchemas.team_message,{...send,summary:'short'}),null);
  // The intent branch (host-protocol §4.3): a recipient set and the contract revision it binds, and no deadline —
  // the server owns the window, so a model-supplied one is not published at all.
  const intent={operationId:op,expectedRevision:0,op:'send',to:['member:a'],kind:'intent',summary:'short',
    taskRef:'task:a',contractRevision:1};
  assert.equal(refusal(on.team_message,intent),null);
  const intentBranch=on.team_message.oneOf.find(branch=>branch.properties?.kind?.const==='intent');
  assert(!Object.hasOwn(intentBranch.properties,'deadline'),'the intent branch publishes no deadline: the server owns the window');
  assert(refusal(on.team_message,{...intent,deadline:'PT5M'}),'a model deadline on an intent is refused');
  assert.equal(refusal(intentBranch,{...intent,to:'member:a'}).code,'INVALID_ARRAY','a recipient set is an array');
  const withoutTask={...intent};delete withoutTask.taskRef;
  assert.match(refusal(intentBranch,withoutTask).detail,/missing field\(s\) taskRef/,'an intent without a binding opens no gate');
  // The reply branch: the model names the message and the verdict, never a revision or a vote table.
  assert.equal(refusal(on.team_message,{operationId:op,op:'reply',messageId:'message:v1:message:x',verdict:'ok'}),null);
  assert.match(refusal(on.team_message,{operationId:op,op:'reply',messageId:'message:v1:message:x',verdict:'maybe'}).detail,
    /verdict must be one of ok, object/);
  // The call the second real run actually made: everything right but the revision it could not read.
  const {expectedRevision,...noRevision}=send;
  const {expectedRevision:alsoOmitted,...noRevisionIntent}=intent;
  assert.equal(refusal(on.team_message,{...noRevision,summary:'short'}),null,'a send with no expectedRevision is admitted');
  assert.equal(refusal(on.team_message,noRevisionIntent),null,'an intent with no expectedRevision is admitted');
  assert.equal(refusal(collabSchemas.team_decision,{operationId:'v1:operation:cycle1-a1-dec-0001',expectedRevision:0,summary:'z'.repeat(512)}),null);
  checks.push('refusals: the closest branch and the exact field/limit are quoted, the payload is not echoed twice, valid calls still pass');
}

fs.writeFileSync(root+'/report.json',JSON.stringify({status:'passed',checks,realProviderRequests:0},null,2));
console.log('tool contract tests PASS: '+checks.length+' checks');