import fs from 'node:fs';
import assert from 'node:assert/strict';
import {ControlStore} from '../../packages/store/index.mjs';
import {TeamCore} from '../../packages/core/index.mjs';
import {handleTool} from '../../packages/core/tools.mjs';
import {snapshot} from '../../packages/core/snapshot.mjs';
import {roleTools, teamSchemas, teamSchemasFor, collabSchemas} from '../../packages/contracts/team-tools.mjs';
import {rolePrompt, toolDescription} from '../../packages/core/authorization.mjs';
import {collabConfig,autonomyConfig,AUTONOMY_CODES,autonomyCodeList,codes} from '../../packages/contracts/index.mjs';
import {implementGate, intentState, assumptionLedger, dependencyPeers, recentDecisions} from '../../packages/core/collab.mjs';
import {nativeEntries, nativeEntriesFor} from './native-host.mjs';
import {BASH_PIN_MODULE, bashPinEntry} from '../../packages/profiles/shell-entries.mjs';
import { runContractTail } from './collab-contract-tail.mjs';

/**
 * The three collaboration mechanisms, checked as pure contract behaviour with no provider in the loop.
 *
 * Every assertion comes in pairs: what the switch ON does, and what the switch OFF keeps doing. The off half is the
 * experiment's control arm, so it is pinned as strictly as the treatment: same tool catalog object, same descriptors,
 * same prompt version, same unblocked calls.
 */
const root=process.argv[2];assert(root&&!fs.existsSync(root));fs.mkdirSync(root,{recursive:true});const checks=[];
const opId=n=>'v1:operation:collab-test-'+String(n).padStart(4,'0');
const codeOf=fn=>{try{fn();return null}catch(e){return {code:e.code??null,message:e.message,detail:e.detail??null}}};

// 1. The switch itself, and its effect on the published surface.
{
  assert.equal(collabConfig({}).collab,'off','the default arm is off');
  assert.equal(collabConfig({collab:'on'}).decisionLimit,5);
  assert.throws(()=>collabConfig({collab:'yes'}),/INVALID_CONFIG/);
  assert.throws(()=>collabConfig({collab:'on',nope:1}),/INVALID_CONFIG/);
  assert.throws(()=>collabConfig({collab:'on',decisionLimit:21}),/INVALID_CONFIG/);
  // Off is the same object, not an equal copy: the catalog a default profile publishes cannot move.
  assert.equal(teamSchemasFor('off'),teamSchemas,'collab off must return the published surface by identity');
  assert.deepEqual(Object.keys(teamSchemasFor('off')).sort(),['team_goal','team_member','team_message','team_plan','team_read','team_task','team_thread',
      'team_verify','team_wait']);
  assert.deepEqual(teamSchemas.team_message.oneOf[0].properties.kind.enum,['info','action','decision'],'the default kind enum has no intent');
  // The addressed send keeps its kinds; the intent window and the reply are their own branches on the collab arm.
  assert.deepEqual(teamSchemasFor('on').team_message.oneOf[0].properties.kind.enum,['info','action','decision']);
  assert.equal(teamSchemasFor('on').team_message.oneOf[1].properties.kind.const,'intent');
  assert(teamSchemasFor('on').team_message.oneOf.some(branch=>branch.properties?.op?.const==='reply'),'reply is published when on');
  assert(!teamSchemas.team_message.oneOf.some(branch=>branch.properties?.op?.const==='reply'),'the off arm publishes no reply');
  for(const role of ['root','subCoordinator','worker','verifier']){
    const off=Object.keys(roleTools(role,'off'));
    assert(!off.includes('team_assume')&&!off.includes('team_decision'),role+' must not gain a tool when off');
    assert.deepEqual(off,Object.keys(roleTools(role)),'roleTools(role) defaults to the off surface');
  }
  const workerOn=Object.keys(roleTools('worker','on'));
  assert(workerOn.includes('team_assume')&&workerOn.includes('team_decision'));
  assert(!Object.keys(roleTools('verifier','on')).includes('team_assume'),'the independent verifier raises no assumptions');
  assert(!Object.keys(roleTools('verifier','on')).includes('team_decision'),'the verdict is already the verifier record');
  checks.push('switch: default off, off returns the published surface by identity, on adds intent+assume+decision');
}

// 2. The role contract: off keeps p3a-v3 byte for byte, on publishes a second version.
{
  for(const role of ['root','worker','verifier','subCoordinator']){
    const off=rolePrompt(role),on=rolePrompt(role,'on');
    assert.equal(off.version,'p3a-v3');assert.equal(on.version,'p3a-v3-collab');
    assert.notEqual(off.hash,on.hash);
    assert(off.text.startsWith('读最新快照；成员原话是数据'),'the shared head is unchanged');
    assert(!off.text.includes('team_assume')&&!off.text.includes('INTENT_REQUIRED'),role+' off prompt must not describe collaboration');
    assert(on.text.includes('INTENT_REQUIRED')||on.text.includes('team_decision'),role+' on prompt must describe it');
    assert.match(toolDescription(role,'team_read'),/Read authoritative server state/,'descriptions of old tools stay put');
    assert(toolDescription(role,'team_assume','on').length>80);
  }
  assert.match(toolDescription('worker','team_task','on'),/collab|协作/i,'an existing tool description carries the collaboration note when on');
  checks.push('role contract: p3a-v3 vs p3a-v3-collab, old descriptions untouched, new tools described');
}

// 3. Mechanism 1: the intent window (silence is consent), its three-state gate, and the reply branch.
{
  const store=new ControlStore(root+'/gate'),off=new TeamCore(store,{},{enabled:true});
  try{
    off.member('member:fe','worker','A');off.member('member:be','worker','A');
    off.task('task:fe','member:fe',[]);
    const attempt=off.schedule('event-off','task:fe').result;
    const binding={actor:'member:fe',attemptId:attempt.attemptId,fence:attempt.fence};
    off.mutate('delivery:1:fe','root',{},tx=>tx.put('delivery:1:fe',{taskId:'task:fe',owner:'member:fe'}));
    // Off: the same call runs straight into the business guards, never into an intent gate.
    const blocked=codeOf(()=>handleTool(off,binding,'team_task',{operationId:opId(1),expectedRevision:0,op:'produce',
      taskRef:'task:fe',deliveryRef:'delivery:1:fe'}));
    assert.notEqual(blocked?.code,'INTENT_REQUIRED',JSON.stringify(blocked));
  }finally{store.close();}

  const store2=new ControlStore(root+'/gate-on');
  const on=new TeamCore(store2,{},{enabled:true,intentWindowMs:1000,...collabConfig({collab:'on'})});
  try{
    on.member('member:fe','worker','A');on.member('member:be','worker','A');on.member('member:qa','verifier','V');
    on.task('task:fe','member:fe',[]);
    const attempt=on.schedule('event-on','task:fe').result;
    const fe={actor:'member:fe',attemptId:attempt.attemptId,fence:attempt.fence};
    on.mutate('delivery:1:fe','root',{},tx=>tx.put('delivery:1:fe',{taskId:'task:fe',owner:'member:fe'}));
    const produce=operationId=>handleTool(on,fe,'team_task',{operationId,expectedRevision:on.store.read('task:fe').revision,
      op:'produce',taskRef:'task:fe',deliveryRef:'delivery:1:fe'});
    // No intent bound to this contract revision: publishing is refused inside the transaction that would write it.
    assert.equal(codeOf(()=>produce(opId(2)))?.code,'INTENT_REQUIRED');
    assert.match(codeOf(()=>produce(opId(2)))?.detail,/kind=intent/,'the refusal names the remedy');
    assert.equal(implementGate(on,'member:fe'),'INTENT_REQUIRED');
    // The published intent branch: a recipient set, the contract revision, and no deadline of the model's choosing.
    assert.equal(codeOf(()=>handleTool(on,fe,'team_message',{operationId:opId(20),op:'send',
      to:['member:be'],kind:'intent',summary:'GET /todos returns {id,title,done}',taskRef:'task:fe',contractRevision:1,
      deadline:'PT5M'}))?.code,'INVALID_TOOL_BRANCH','the window belongs to the server, not to the model');
    const sent=handleTool(on,fe,'team_message',{operationId:opId(21),op:'send',
      to:['member:be','member:qa'],kind:'intent',summary:'GET /todos returns {id,title,done}',
      expectedOutcome:'confirm the shape or object',taskRef:'task:fe',contractRevision:1});
    const intentId=sent.result.entityId;
    assert.deepEqual(sent.result.recipients,['member:be','member:qa']);
    assert(sent.result.closesAt>Date.now(),'the server opened the window');
    // Sending no longer opens the gate: the window is open and publishing waits (silence is consent).
    assert.equal(implementGate(on,'member:fe'),'INTENT_WINDOW_OPEN');
    assert.equal(codeOf(()=>produce(opId(3)))?.code,'INTENT_WINDOW_OPEN');
    // Only a recipient answers, and the model sends no revision.
    assert.equal(codeOf(()=>handleTool(on,fe,'team_message',{operationId:opId(22),op:'reply',messageId:intentId,verdict:'ok'}))?.code,
      'NOT_A_RECIPIENT');
    const beAttempt=on.schedule('event-on-be',(()=>{on.task('task:be','member:be',[]);return 'task:be'})()).result;
    const be={actor:'member:be',attemptId:beAttempt.attemptId,fence:beAttempt.fence};
    handleTool(on,be,'team_message',{operationId:opId(23),op:'reply',messageId:intentId,verdict:'ok'});
    assert.equal(on.store.read(intentId).decision,null,'one ok of two does not close the window');
    assert.equal(on.store.read(intentId).votes['member:be'].verdict,'ok');
    // An intent is never accepted: the window is answered by reply.
    assert.equal(codeOf(()=>handleTool(on,be,'team_message',{operationId:opId(24),expectedRevision:on.store.read(intentId).revision,
      op:'accept',messageId:intentId,checkpointRef:'checkpoint:collab-1'}))?.code,'INTENT_NEEDS_REPLY');
    // The other recipient objects: the window closes at once and that revision cannot publish.
    const qaAttempt=on.schedule('event-on-qa',(()=>{on.task('task:qa','member:qa',[]);return 'task:qa'})()).result;
    const qa={actor:'member:qa',attemptId:qaAttempt.attemptId,fence:qaAttempt.fence};
    const objected=handleTool(on,qa,'team_message',{operationId:opId(25),op:'reply',messageId:intentId,verdict:'object',
      reason:'the field is done, not completed'});
    assert.equal(objected.result.decision,'objected');
    assert(Number.isFinite(objected.result.closedAt),'the objection is the closing instant');
    assert.equal(codeOf(()=>produce(opId(4)))?.code,'INTENT_OBJECTED');
    // The conclusion is terminal: the same revision cannot open a second window.
    assert.equal(codeOf(()=>handleTool(on,fe,'team_message',{operationId:opId(26),op:'send',
      to:['member:be'],kind:'intent',summary:'second try',taskRef:'task:fe',contractRevision:1}))?.code,
      'INTENT_CONCLUSION_FIXED');
    // Silence is consent: a new revision with no objection passes when the window closes, with nobody escalated.
    on.mutate('task:fe','root',{},(tx,row)=>tx.put('task:fe',{...row,contractRevision:2}));
    const second=handleTool(on,fe,'team_message',{operationId:opId(27),op:'send',
      to:['member:be','member:qa'],kind:'intent',summary:'revised shape: {id,title,done}',
      expectedOutcome:'confirm or object',taskRef:'task:fe',contractRevision:2});
    const secondId=second.result.entityId;
    const closesAt=on.store.read(secondId).closesAt;
    assert.equal(on.store.read(secondId).status,'open');
    on.tick(closesAt+1);
    const closed=on.store.read(secondId);
    assert.equal(closed.decision,'passed','a window that closes with no objection passes');
    assert.equal(closed.closedAt,closesAt,'the deadline is the closing instant');
    assert.deepEqual(closed.seenAtClose,{'member:be':false,'member:qa':false},'neither recipient was in a request');
    assert.equal(closed.seenSummary,'seenNone');
    assert(on.store.effects().some(effect=>effect.payload.kind==='intent-result'&&effect.payload.messageId===secondId),
      'the initiator is notified by a durable effect');
    assert.equal(on.store.list('message:').filter(message=>message.status==='escalated').length,0,
      'an intent never becomes an operator escalation');
    const produced=produce(opId(5));
    assert.equal(produced.result.status,'produced','a passed window lets the publish through');
    assert.equal(implementGate(on,'member:fe'),null);
    const state=intentState(on,'member:fe');
    assert.equal(state.sent,2);assert.equal(state.open,0);assert.equal(state.passed,1);assert.equal(state.objected,1);
    assert.equal(state.passedUnseen,1,'a pass nobody saw is counted separately');
    assert.equal(state.seenNone,2);
    checks.push('mechanism 1: silence passes without escalation, one object closes the window, the gate binds task+revision, reply never accepts');
  }finally{store2.close();}
}

// The branches that create their row accept its omission: the second real run spent six refusals on a revision the model
// could not read (the snapshot publishes the contract revision, not the row revision). The published surface now says so,
// and the call goes through -- while acting on a row still needs the revision it read (deadline-protocol-test pins the
// stale value, tool-contract-test pins which branches publish the field).
{
  const store=new ControlStore(root+'/optional-revision');
  const core=new TeamCore(store,{},{enabled:true,intentWindowMs:1000,...collabConfig({collab:'on'})});
  try{
    core.member('member:fe','worker','A');core.member('member:be','worker','A');core.member('member:qa','verifier','V');
    core.task('task:fe','member:fe',[]);
    const a=core.schedule('opt-fe','task:fe').result;
    const fe={actor:'member:fe',attemptId:a.attemptId,fence:a.fence};
    const sent=handleTool(core,fe,'team_message',{operationId:opId(80),op:'send',to:['member:be'],kind:'intent',
      summary:'GET /todos returns {id,title,done}',expectedOutcome:'ack',taskRef:'task:fe',contractRevision:1});
    assert(sent.result.entityId.startsWith('message:'),'a send with no expectedRevision is admitted');
    const decision=handleTool(core,fe,'team_decision',{operationId:opId(81),summary:'colour is a hex string',affects:['task:fe']});
    assert(decision.result.entityId.startsWith('decision-log:'),'a decision needs no revision it cannot read');
    const assume=handleTool(core,fe,'team_assume',{operationId:opId(82),about:'member:be',claim:'tags are strings',impact:'sort'});
    assert(assume.result.entityId.startsWith('assumption:'),'raising needs no revision either');
    // The delivery row is what root records when it delegates; produce names it and the reference guard requires it.
    core.mutate('delivery:collab:fe:v1','root',{kind:'planned-delivery'},
      (tx,current)=>tx.put('delivery:collab:fe:v1',{...current,owner:'member:fe',kind:'planned-delivery'}));
    // Silence is consent: once the window has closed unopposed the publish passes, with nobody acking it.
    core.tick(core.store.read(sent.result.entityId).closesAt+1);
    const produced=handleTool(core,fe,'team_task',{operationId:opId(83),op:'produce',taskRef:'task:fe',deliveryRef:'delivery:collab:fe:v1'});
    assert.equal(produced.result.status,'produced','produce acts on the caller own task once its intent passed');
  }finally{store.close();}
  checks.push('expectedRevision is optional where the caller has none to read: send, decision, assumption, own produce');
}

// 4. Mechanism 2: team_assume raises without blocking, delivers to the owner, and is answered once.
{
  const store=new ControlStore(root+'/assume'),core=new TeamCore(store,{},{enabled:true,...collabConfig({collab:'on'})});
  try{
    core.member('member:fe','worker','A');core.member('member:be','worker','A');core.member('member:qa','verifier','V');
    core.task('task:fe','member:fe',[]);core.task('task:be','member:be',[]);
    const a=core.schedule('e-fe','task:fe').result,b=core.schedule('e-be','task:be').result;
    const fe={actor:'member:fe',attemptId:a.attemptId,fence:a.fence};
    const be={actor:'member:be',attemptId:b.attemptId,fence:b.fence};
    const raised=handleTool(core,fe,'team_assume',{operationId:opId(30),expectedRevision:0,about:'member:be',
      claim:'POST /todos stores colour as a hex string',impact:'I parse it as a string and sort by it',deadline:'PT10M'});
    const id=raised.result.entityId;
    assert(id.startsWith('assumption:'));assert.equal(raised.result.status,'open');
    assert.equal(raised.result.owner,'member:be');
    // The raise is durable and delivered, and the raiser kept its lease: nothing waited for an answer.
    assert.equal(raised.result.raiser,'member:fe');
    const message=core.store.read(raised.result.messageId);
    assert.equal(message.recipient,'member:be');assert.equal(message.kind,'action');assert(message.summary.includes(id));
    assert.match(message.expectedOutcome,/confirm or correct/);assert.equal(message.deadline.length>0,true);
    assert(core.pending('member:be').some(m=>m.entityId===raised.result.messageId),'the owner sees it in its mailbox');
    // A retried operationId replays rather than raising twice.
    const replay=handleTool(core,fe,'team_assume',{operationId:opId(30),expectedRevision:0,about:'member:be',
      claim:'POST /todos stores colour as a hex string',impact:'I parse it as a string and sort by it',deadline:'PT10M'});
    assert.equal(replay.result.entityId,id);
    assert.equal(core.store.list('assumption:').length,1);
    // Only the owner answers, only once, and a correction must say what the truth is.
    assert.match(codeOf(()=>handleTool(core,fe,'team_assume',{operationId:opId(31),expectedRevision:0,assumptionId:id,verdict:'confirm'}))?.code,
      /^ASSUMPTION_NOT_YOURS/);
    assert.match(codeOf(()=>handleTool(core,be,'team_assume',{operationId:opId(32),expectedRevision:0,assumptionId:id,verdict:'correct'}))?.code,
      /^CORRECTION_REQUIRED/);
    const corrected=handleTool(core,be,'team_assume',{operationId:opId(33),expectedRevision:0,assumptionId:id,verdict:'correct',
      correction:'colour is stored as {name,hex}; no sorting needed'});
    assert.equal(corrected.result.status,'corrected');assert.equal(corrected.result.answeredBy,'member:be');
    assert.match(codeOf(()=>handleTool(core,be,'team_assume',{operationId:opId(34),expectedRevision:0,assumptionId:id,verdict:'confirm'}))?.code,
      /^ASSUMPTION_ALREADY_ANSWERED/);
    // The acceptance list: what is still unconfirmed stays visible, and the ledger counts both halves.
    handleTool(core,fe,'team_assume',{operationId:opId(35),expectedRevision:0,about:'member:be',claim:'GET /todos paginates by cursor',
        impact:'UI assumes 20 per page'});
    const ledger=assumptionLedger(core,'member:fe');
    assert.equal(ledger.raised,2);assert.equal(ledger.open,1);assert.equal(ledger.corrected,1);assert.equal(ledger.confirmed,0);
    assert.equal(ledger.unanswered.length,1);assert.match(ledger.unanswered[0].claim,/cursor/);
    assert.equal(assumptionLedger(core,'member:be').owedToOthers,1,'the owner sees the answer it owes');
    // An assumption about an artifact names its producer from the id when the artifact row is not written yet.
    const before=handleTool(core,fe,'team_assume',{operationId:opId(36),expectedRevision:0,about:'artifact:1:be',claim:'the artifact file is JSON',
        impact:'I read it as JSON'});
    assert.equal(before.result.owner,'member:be');
    checks.push('mechanism 2: raise is non-blocking and delivered, owner answers once, unconfirmed assumptions stay listed');
  }finally{store.close();}

  // Off: the tool does not exist at all, for any role.
  const offStore=new ControlStore(root+'/assume-off'),offCore=new TeamCore(offStore,{},{enabled:true});
  try{
    offCore.member('member:fe','worker','A');offCore.member('member:be','worker','A');
    const attempt=offCore.schedule('e-off',(()=>{offCore.task('task:fe','member:fe',[]);return 'task:fe'})()).result;
    const refused=codeOf(()=>handleTool(offCore,{actor:'member:fe',attemptId:attempt.attemptId,fence:attempt.fence},'team_assume',
      {operationId:opId(40),expectedRevision:0,about:'member:be',claim:'x',impact:'y'}));
    assert.equal(refused?.code,'ROLE_DENIED','with collab off the tool is not in the role surface');
    assert.equal(assumptionLedger(offCore,'member:fe').raised,0);
  }finally{offStore.close();}
  checks.push('mechanism 2 off: team_assume is ROLE_DENIED and no assumption ledger exists');
}

// 5. Mechanism 3: the decision log is a ledger, reaches only dependency peers, and lands in the snapshot.
{
  const store=new ControlStore(root+'/decisions'),core=new TeamCore(store,{},{enabled:true,...collabConfig({collab:'on'})});
  try{
    for(const m of ['member:fe','member:be','member:qa','member:other'])core.member(m,m==='member:qa'?'verifier':'worker','A');
    for(const [task,owner] of [['task:fe','member:fe'],['task:be','member:be']])core.task(task,owner,[]);
    const a=core.schedule('e1','task:fe').result,b=core.schedule('e2','task:be').result;
    const fe={actor:'member:fe',attemptId:a.attemptId,fence:a.fence};
    const feId='member:fe';
    // A decision is written and nothing is delivered: the outbox and the mailbox stay empty.
    const before=store.effects().length;
    handleTool(core,fe,'team_decision',{operationId:opId(50),expectedRevision:0,summary:'todos are keyed by uuid',affects:['task:fe']});
    assert.equal(store.effects().length,before,'team_decision must never enqueue a delivery');
    assert.equal(core.pending('member:be').length,0,'nobody is woken by a decision log entry');
    assert.equal(core.store.list('decision-log:').length,1);
    // Dependency filtering is the committed graph, so the edge has to exist first: fe raises an assumption that names
    // be, and that row is what makes be a dependency peer of fe.
    handleTool(core,fe,'team_assume',{operationId:opId(51),expectedRevision:0,about:'member:be',claim:'tags are strings',impact:'sort order'});
    assert.deepEqual([...dependencyPeers(core,'member:be')],['member:fe']);
    assert.deepEqual([...dependencyPeers(core,'member:fe')],['member:be']);
    const seenByBe=recentDecisions(core,'member:be',5);
    assert.equal(seenByBe.length,1);assert.equal(seenByBe[0].summary,'todos are keyed by uuid');assert.equal(seenByBe[0].actor,'member:fe');
    // An unrelated member sees nothing: the filter is the dependency graph, not the team.
    assert.deepEqual(recentDecisions(core,'member:other',5),[]);
    assert.deepEqual([...dependencyPeers(core,'member:other')],[]);
    // N defaults to 5 and the newest wins.
    for(let i=0;i<7;i++)handleTool(core,fe,'team_decision',{operationId:opId(60+i),expectedRevision:0,summary:'decision '+i});
    const five=recentDecisions(core,'member:be',5);
    assert.equal(five.length,5);assert.equal(five[0].summary,'decision 6');assert.equal(five[4].summary,'decision 2');
    // The pre-step snapshot carries them, and the block is on the same payload the manifest hashes.
    const candidate=snapshot(core,'member:be');
    assert(candidate.payload.collab,'the snapshot carries a collab block when on');
    // N caps the list at 5; the snapshot budget may cap it lower, and whatever it drops it counts.
    assert.equal(candidate.payload.collab.decisions.length+candidate.payload.collab.decisionOmitted,5);
    assert(candidate.payload.collab.decisions.length>=1,'the newest decision survives');
    assert.equal(candidate.payload.collab.decisions[0].summary,'decision 6');
    assert.equal(candidate.payload.collab.gate.open,false);
    assert.match(candidate.payload.collab.gate.nextAction,/kind=intent/);
    assert(Buffer.byteLength(candidate.text)*2<=4096,'the collaboration block must fit the existing snapshot budget');
    // The snapshot of a member with no dependency relation carries no decisions and says so.
    const unrelated=snapshot(core,'member:other');
    assert.equal(unrelated.payload.collab.decisions.length,0);
    checks.push('mechanism 3: ledger only, dependency-filtered, N=5 newest, present in the snapshot within budget');
  }finally{store.close();}

  // Off: no collab block at all, and the snapshot payload is the one the control arm has always produced.
  const offStore=new ControlStore(root+'/decisions-off'),offCore=new TeamCore(offStore,{},{enabled:true});
  try{
    offCore.member('member:fe','worker','A');offCore.member('member:be','worker','A');
    const cand=snapshot(offCore,'member:be');
    assert(!Object.hasOwn(cand.payload,'collab'),'collab off must not add a key to the snapshot payload');
    assert.deepEqual(Object.keys(cand.payload).sort(),['asOfSeq','decisionsDue','detailRefs','goal','memberData','nextOwner','responsibilities',
        'responsibilityPage','self','source','stale','tasks','unknownEffects'].sort());
  }finally{offStore.close();}
  checks.push('mechanism 3 off: no collab key in the snapshot payload at all');
}

// 6. The snapshot budget is not raised: an oversized decision list is trimmed, and the trim is reported.
{
  const store=new ControlStore(root+'/budget'),core=new TeamCore(store,{},{enabled:true,...collabConfig({collab:'on',decisionLimit:20})});
  try{
    for(const m of ['member:fe','member:be'])core.member(m,'worker','A');
    core.task('task:fe','member:fe',[]);core.task('task:be','member:be',[]);
    const a=core.schedule('b1','task:fe').result;
    const fe={actor:'member:fe',attemptId:a.attemptId,fence:a.fence};
    handleTool(core,fe,'team_assume',{operationId:opId(70),expectedRevision:0,about:'member:be',claim:'c',impact:'i'});
    for(let i=0;i<20;i++)handleTool(core,fe,'team_decision',{operationId:opId(100+i),expectedRevision:0,summary:'x'.repeat(80)});
    const cand=snapshot(core,'member:be');
    assert(Buffer.byteLength(cand.text)*2<=4096,'the budget must hold');
    assert(cand.payload.collab.decisions.length<20,'the block gives way to the budget');
    assert(cand.payload.collab.decisionOmitted>0,'every dropped decision is reported');
    checks.push('the 4096-byte snapshot ceiling is unchanged; a large decision list is trimmed and counted');
  }finally{store.close();}
}


runContractTail(checks);

fs.writeFileSync(root+'/report.json',JSON.stringify({status:'passed',checks,realProviderRequests:0},null,2));
console.log('collab contract tests PASS: '+checks.length+' checks');