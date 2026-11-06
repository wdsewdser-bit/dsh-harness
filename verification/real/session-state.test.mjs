import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from './scenario.mjs';
import { interruptedRaw, wire } from './protocol.mjs';

test('host-opened turn persists its own opaque assistant and session identity wins over another initiator', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-opaque-turn-'));
  try {
    const engine=new Engine(root,{},'fake'), rootState={actor:'root',lastRaw:{turn:1,step:1,output:[{type:'reasoning',id:'root-raw'}]}},
      memberState={actor:'a1',lastRaw:{turn:1,step:2,output:[{type:'reasoning',id:'member-raw',encrypted_content:'signed'}]}};
    engine.states.set('root',rootState);engine.states.set('a1',memberState);
    const messages=[{id:'old',role:'assistant'},{id:'member-final',role:'assistant',content:[{type:'reasoning',text:''}]}];
    const agents={root:{session:{id:'owner'}},a1:{session:{id:'member',deriveMessages:()=>messages,snapshotEvents:()=>[{type:'assistant/message',data:{turn:1,
                step:2,message:{id:'member-final'}}}]},whenIdle:async()=>{}}};
    engine.agent=actor=>agents[actor];engine.turnsEnded=()=>1;
    let flushed=null;engine.ctx={agents:{currentInitiator:()=>agents.root},sessions:{flush:async session=>{flushed=session.id}}};
    engine.captureProtocolErrors=()=>{};engine.captureOutputErrors=()=>{};engine.backfillSnapshots=()=>{};
    engine.raw.old=[{type:'message',id:'old-raw'}];
    assert.equal(engine.stateOfSession('member'),memberState,'the dispatch session, not the unrelated initiator, owns the response');
    assert.equal(engine.stateOfSession('missing'),null);
    assert.throws(()=>wire(messages,engine.raw),/OPAQUE_REASONING_MAPPING_MISSING/,'the unmapped final assistant reproduces the host-turn defect');
    await engine.waitTurn('a1',0);
    assert.deepEqual(wire(messages,engine.raw),[...engine.raw.old,...engine.raw['member-final']],
      'the next request must replay the exact opaque items, not fabricated reasoning text');
    assert.deepEqual(engine.raw['member-final'],[{type:'reasoning',id:'member-raw',encrypted_content:'signed'}]);
    assert.deepEqual(engine.raw.old,[{type:'message',id:'old-raw'}],'already mapped history is not overwritten');
    assert.deepEqual(rootState.lastRaw,{turn:1,step:1,output:[{type:'reasoning',id:'root-raw'}]},'another session retains its pending response');
    assert.equal(memberState.lastRaw,null);assert.equal(flushed,'member');
    assert.deepEqual(JSON.parse(fs.readFileSync(engine.rawFile,'utf8')),engine.raw,'the sidecar survives a restart');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('turn state resets only at a new native turn, not for a message inside a running turn', () => {
  const engine=new Engine('.',{},'fake'), state={};let seq=10;
  const agent={session:{id:'session-a',snapshotEvents:()=>[{type:'turn/start',seq,data:{turn:seq}}]}};
  engine.enterNativeTurn(state,agent);state.turnRequests=5;state.lastCall={key:'team_read|{}',count:5};state.repeat=5;
  engine.enterNativeTurn(state,agent);assert.equal(state.turnRequests,5);assert.equal(state.repeat,5);
  seq=20;engine.enterNativeTurn(state,agent);assert.equal(state.turnRequests,0);assert.equal(state.repeat,0);assert.equal(state.lastCall,null);
});

test('native Error prefix does not misclassify the loop guard or hide other refusals', () => {
  const engine=new Engine('.',{protocolErrors:[]},'fake'), state={actor:'root',requestId:'req'};engine.states.set('root',state);
  const errors=['Error: REPEATED_TOOL_CALL_LOOP: repeated','Error: CAS_CONFLICT:message:x','TypeError: broken'];
  const journal=errors.flatMap((message,i)=>[{type:'tool/call',seq:i*2+1,data:{callId:'c'+i,name:'team_read',arguments:'{}'}},
    {type:'tool/result',seq:i*2+2,data:{message:{id:'m'+i,toolCallId:'c'+i,isError:true,content:[{type:'text',text:message}]}}}]);
  engine.agent=()=>({session:{id:'owner',snapshotEvents:()=>journal}});
  engine.captureProtocolErrors('root');
  assert.deepEqual(engine.facts.protocolErrors.map(e=>e.error),['CAS_CONFLICT','TypeError']);
});

test('successful product tools are attributed from their native call/result pair exactly once', () => {
  const facts={toolActions:[],requests:[{actor:'a1',nativeSessionId:'member',nativeSeq:10,requestId:'r1'}]};
  const engine=new Engine('.',facts,'fake');engine.states.set('a1',{actor:'a1'});
  const journal=[{type:'tool/call',seq:11,time:100,data:{callId:'c1',name:'team_message',arguments:JSON.stringify({op:'send',operationId:'op:1'})}},
    {type:'tool/result',seq:12,time:105,data:{message:{toolCallId:'c1',content:[{type:'text',text:JSON.stringify({result:{entityId:'message:1'}})}]}}},
    {type:'tool/call',seq:13,time:106,data:{callId:'c2',name:'team_read',arguments:'{}'}},
    {type:'tool/result',seq:14,time:107,data:{message:{toolCallId:'c2',isError:true,content:[{type:'text',text:'Error: DENIED'}]}}}];
  engine.agent=()=>({session:{id:'member',snapshotEvents:()=>journal}});
  engine.captureNativeToolActions('a1');engine.captureNativeToolActions('a1');
  assert.equal(facts.toolActions.length,1);assert.deepEqual(facts.toolActions[0],{actor:'a1',name:'team_message',
    args:{op:'send',operationId:'op:1'},requestId:'r1',at:100,elapsedMs:5,resultRef:'message:1',
    source:'native-model-tool',nativeSessionId:'member',nativeSeq:12});
});

test('interrupted response sidecar keeps only closed native blocks and never maps an abandoned step', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-opaque-preempt-'));
  try {
    const engine=new Engine(root,{},'fake');const raw=[{type:'reasoning',id:'r',summary:[],encrypted_content:'opaque'},
      {type:'message',id:'partial',content:[{type:'output_text',text:'partial'}]}];
    const state={actor:'a1',lastRaw:{turn:1,step:2,output:raw}},message={id:'kept',role:'assistant',content:[{type:'reasoning',text:''}]};
    engine.agent=()=>({session:{snapshotEvents:()=>[{type:'assistant/message',data:{turn:1,step:2,interrupted:true,message}}]}});
    engine.remember(state,[message]);assert.deepEqual(engine.raw.kept,[raw[0]]);
    assert.throws(()=>interruptedRaw(raw,[{type:'text',text:'not-in-response'}]),/OPAQUE_REASONING_MAPPING_MISSING/);
    state.lastRaw={turn:1,step:3,output:raw};engine.remember(state,[message]);
    assert.deepEqual(engine.raw.kept,[raw[0]],'an assistant/attempt without a message cannot overwrite a prior assistant');
    assert.equal(state.lastRaw,null);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
