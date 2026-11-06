import test from 'node:test';
import assert from 'node:assert/strict';
import { noteAssistantFrame, hasCompletedResponse } from '../preempt-completion.mjs';
import { MemberInputArbiter } from '../preempt.mjs';

function driver() {
  const events=[];
  return {phase:{kind:'running',turn:1,step:1},session:{snapshotEvents:()=>events},events};
}
const start=(agent,attemptId='a')=>noteAssistantFrame(agent,{type:'start',attemptId,turn:agent.phase.turn,step:agent.phase.step});
const finish=(agent,kind='stop',attemptId='a')=>noteAssistantFrame(agent,{type:'chunk',attemptId,chunk:{type:'finish',reason:{kind}}});
function settle(agent,{attemptId='a',kind='committed',eventType='assistant/message',interrupted=false,turn=1,step=1}={}) {
  const seq=agent.events.length+1;
  if(kind==='committed')agent.events.push({type:eventType,seq,data:{turn,step,interrupted}});
  noteAssistantFrame(agent,{type:'end',attemptId,outcome:{kind,eventType,seq}});
}

test('normal committed end without finish protects the response; finish alone never does', () => {
  const agent=driver();start(agent);settle(agent);
  assert.equal(hasCompletedResponse(agent),true,'normal exhaustion defaults to stop without an explicit finish');
  const other=driver();start(other);finish(other);
  assert.equal(hasCompletedResponse(other),false,'finish is not durable settlement');
  settle(other);assert.equal(hasCompletedResponse(other),true);
});

test('error/aborted finish, abandoned end and interrupted/failed commits do not protect tools', () => {
  for(const reason of ['error','aborted']) {
    const agent=driver();start(agent);finish(agent,reason);
    assert.equal(hasCompletedResponse(agent),false);
    settle(agent);assert.equal(hasCompletedResponse(agent),false,'even an inconsistent message commit cannot excuse a failure hint');
  }
  for(const kind of ['error','aborted','abandoned']) {
    const agent=driver();start(agent);finish(agent);settle(agent,{kind});
    assert.equal(hasCompletedResponse(agent),false);
    settle(agent);assert.equal(hasCompletedResponse(agent),false,'late frames cannot revive an ended attempt');
  }
  for(const options of [{eventType:'assistant/attempt'},{interrupted:true},{turn:2},{step:2}]) {
    const agent=driver();start(agent);settle(agent,options);assert.equal(hasCompletedResponse(agent),false);
  }
  const agent=driver();start(agent);
  noteAssistantFrame(agent,{type:'end',attemptId:'a',outcome:{kind:'committed',eventType:'assistant/message',seq:99}});
  assert.equal(hasCompletedResponse(agent),false,'the referenced durable row must exist');
});

test('settlement is isolated by agent, attempt, turn and step; stale rows cannot protect a retry', () => {
  const a=driver(),b=driver();start(a);start(b,'b');settle(a);
  assert.equal(hasCompletedResponse(a),true);assert.equal(hasCompletedResponse(b),false);
  settle(b,{attemptId:'a'});assert.equal(hasCompletedResponse(b),false,'mismatched end cannot settle this attempt');
  settle(b,{attemptId:'b'});assert.equal(hasCompletedResponse(b),true);
  a.phase.step=2;assert.equal(hasCompletedResponse(a),false);
  a.phase.step=1;a.phase.turn=2;assert.equal(hasCompletedResponse(a),false);
  a.phase.turn=1;start(a,'retry');
  assert.equal(hasCompletedResponse(a),false,'prior durable message is not a current attempt commit');
  settle(a);assert.equal(hasCompletedResponse(a),false,'old attempt end cannot settle retry');
  settle(a,{attemptId:'retry'});assert.equal(hasCompletedResponse(a),true);
  a.phase.kind='idle';assert.equal(hasCompletedResponse(a),false);
  const unknown=driver();unknown.events.push({type:'assistant/message',seq:1,data:{turn:1,step:1}});
  assert.equal(hasCompletedResponse(unknown),false,'a row alone cannot identify an unobserved attempt');
});

test('legacy mail merges a successfully committed batch but still interrupts the next partial step', () => {
  const core={store:{read:id=>({entityId:id,desired:'active'}),list:()=>[]},configuration:{}};
  const arbiter=new MemberInputArbiter(core,{policy:'preempt',minIntervalMs:0});let preempts=0;
  const agent=driver();agent.preemptStep=()=>{preempts++;return true;};arbiter.bind('member:a',agent);
  start(agent);settle(agent);
  assert.equal(arbiter.deliverMail('member:a',{sender:'root'}).wake,'live');assert.equal(preempts,0);
  agent.phase.step=2;
  assert.equal(arbiter.deliverMail('member:a',{sender:'root'}).fired,true);assert.equal(preempts,1);
});

test('queue policy remains non-preempting', () => {
  const core={store:{read:()=>({desired:'active'}),list:()=>[]},configuration:{},ready:()=>true};
  const arbiter=new MemberInputArbiter(core,{policy:'queue'}),agent=driver();
  agent.preemptStep=()=>{throw Error('queue must not call preemptStep');};arbiter.bind('member:a',agent);
  start(agent);settle(agent);assert.equal(arbiter.queuedOutcome('member:a',agent).fired,false);
});
