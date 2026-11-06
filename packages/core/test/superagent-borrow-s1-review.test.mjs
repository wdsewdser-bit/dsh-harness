// §3 of the super-agent borrow design (P1): resource threads, thread events and the root-decision intent.
//
// Every case runs offline against a real control store: the shared reducer, the clock, the core entries and the read
// model, with no provider and no host. The core is configured v1 (superagentBorrow 'v1' + intentSemantics
// 'root-decision-v1') so the S1 reducers are exercised as they will run once the protocol can boot; the composition
// root still refuses to activate v1, which the first case pins. The legacy arm keeps its own tests (collab-protocol)
// and this file only asserts that it is still the one a default team runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../index.mjs';
import { handleTool } from '../tools.mjs';
import { unresolvedDecisionThreads } from '../goal-gate.mjs';
import { readThreadEvents, resourceThreadView, threadRetention } from '../thread-events.mjs';
import { coordinationBlock } from '../commands/intents.mjs';
import { implementGateSummary, intentProtocol, intentState } from '../collab.mjs';
import { snapshot } from '../snapshot.mjs';
import { toolCommand } from '../tool-reducer.mjs';
import { cancelMessage } from '../mailbox.mjs';
import { BORROW_IMPLEMENTATION_STAGES, ROOT_DECISION_SEMANTICS, assertProtocolSupported, borrowReadiness,
  superagentBorrowConfig } from '../../contracts/index.mjs';


import { root, REPOSITORIES, future, codeOf, team, openResource, subscribe, unsubscribe, publishWith, publish, deliveries, events, forMember,
  requestCoordination, verdict, resultEffects } from '../test-support/s1-fixtures.mjs';

test('review: durable host evidence bridge is deterministic, bounded and cannot be model-forged', () => {
  const t=team('review-bridge',{threadEventLimit:1});
  try {
    const ref=openResource(t,'member:fe',{kind:'branch',repositoryKey:REPOSITORIES[0],key:'refs/heads/facts'}).entityId;
    subscribe(t,'member:fe',ref);
    t.core.mutate('delivery:fact','adapter',{},tx=>tx.put('delivery:fact',{repositoryKey:REPOSITORIES[0],status:'produced'}));
    const bridge=actor=>t.core.dispatch('bridge:'+t.op('fact'),actor,{},
      {type:'thread.bridge-evidence',payload:{issueId:ref,sourceRef:'delivery:fact'}});
    assert.equal(codeOf(()=>bridge('member:fe')),'DENIED');
    bridge('adapter'); bridge('adapter');
    assert.equal(events(t,ref).length,1); assert.equal(deliveries(t,ref).length,1);
    assert.equal(events(t,ref)[0].source.ref,'delivery:fact');
    t.core.mutate('delivery:fact','adapter',{},(tx,row)=>tx.put(row.entityId,{...row,status:'verified'}));
    assert.equal(codeOf(()=>bridge('adapter')),'THREAD_BACKLOG_FULL');
    assert.equal(t.store.read(ref).eventSeq,1);
    const read=handleTool(t.core,{actor:'member:fe'},'team_read',{view:'thread',ref});
    subscribe(t,'member:be',ref);
    assert.deepEqual(handleTool(t.core,{actor:'member:fe'},'team_read',{view:'thread',ref}).refs[0].subscribers.map(s=>s.memberId),
      ['member:fe'],'hidden member subscriptions do not leak through the topic view');
    assert.equal(read.refs[0].lastEvent.summary,'delivery:fact: produced');
  } finally { t.close(); }
});

test('review: deferred execution closeout retains v1 and rechecks coordination before consuming proof', () => {
  for (const lateBlock of [false,true]) {
    const t=team('review-close-'+lateBlock);
    try {
      t.core.task('task:fe','member:fe');
      const E={teamId:'team',memberId:'member:fe',generation:1,attemptId:'attempt:fixture',attemptFence:1,
        executionSessionId:'session:fixture',executionEpoch:'epoch:fixture'};
      const coverage={complete:true,gates:true,attribution:true,transport:true,subprocess:true};
      t.core.mutate('attempt:fixture','adapter',{},tx=>{
        tx.put(E.attemptId,{owner:E.memberId,taskId:'task:fe',generation:1,fence:1,lease:'active',status:'running',
          executionSessionId:E.executionSessionId,expiresAt:Date.now()+60000});
        tx.put('task:fe',{...tx.read('task:fe'),status:'executing',attemptId:E.attemptId});
        tx.put('execution-current:'+E.attemptId,{E,state:'OPEN'});return null;
      });
      t.core.finish(E.attemptId,1);
      assert.equal(t.store.read('execution-finish:'+E.executionEpoch).intentProtocol,ROOT_DECISION_SEMANTICS);
      let request;
      if(lateBlock) request=requestCoordination(t,'member:be',{taskRef:'task:fe'});
      const proof={contract:'execution-stop/1',E,verified:true,stopState:'proven',stopId:'stop:fixture',
        certificateId:'certificate:fixture',scopeVersion:4,coverage};
      t.core.mutate('execution-scope:'+E.executionEpoch,'adapter',{},tx=>{
        tx.put('execution-scope:'+E.executionEpoch,{E,state:'PROVEN',stopId:proof.stopId,certificateId:proof.certificateId,
          version:4,coverage,active:0,uncertain:0});
        tx.put('execution-current:'+E.attemptId,{E,state:'PROVEN',version:4,stopId:proof.stopId});return null;
      });
      const payload={proof,evidenceRef:'proof:fixture',purpose:'complete'};
      const close=()=>t.core.dispatch(E.attemptId,'adapter',payload,{type:'execution.close',payload});
      if(lateBlock) {
        assert.equal(codeOf(close),'COORDINATION_PENDING');
        assert.equal(t.store.read(E.attemptId).lease,'active');
        assert.equal(t.store.read('execution-scope:'+E.executionEpoch).state,'PROVEN');
        assert.equal(t.store.read('proof:fixture:'+E.executionEpoch),null,'no half proof consumption');
        verdict(t,request.decisionId,'approve');
      }
      assert.equal(codeOf(close),null,'v1 completion does not fall back to INTENT_REQUIRED');
      assert.equal(t.store.read('task:fe').status,'produced');
      assert.equal(t.store.read('execution-scope:'+E.executionEpoch).state,'RELEASED');
    } finally { t.close(); }
  }
});

test('review: all six subscription orderings observe their commit cut', () => {
  for(const order of ['SPU','SUP','PSU','PUS','USP','UPS']) {
    const t=team('review-order-'+order);
    try {
      const ref=openResource(t,'member:fe',{kind:'branch',repositoryKey:REPOSITORIES[0],key:'refs/heads/order'}).entityId;
      let active=false,known=false;
      for(const op of order) {
        if(op==='S') {subscribe(t,'member:fe',ref);active=true;known=true;}
        if(op==='U') {
          if(known) {unsubscribe(t,'member:fe',ref,{reason:'leave'});active=false;}
          else assert.equal(codeOf(()=>unsubscribe(t,'member:fe',ref,{reason:'leave'})),'UNKNOWN_SUBSCRIPTION');
        }
        if(op==='P') {
          const p=publishWith(t,'adapter',{issueId:ref,summary:'fact',operationId:t.op('fact'),
            source:{kind:'host-evidence',ref:'delivery:ordering'},hostEvidence:true});
          assert.equal(p.result.delivered.length,Number(active),order);
        }
      }
      assert.equal(t.store.read(ref).eventSeq,1);
    } finally { t.close(); }
  }
});

test('review: nested thread IDs never cross resource read, fanout or retention boundaries', () => {
  const t=team('review-prefix');
  try {
    const a=openResource(t,'member:fe',{kind:'branch',repositoryKey:REPOSITORIES[0],key:'refs/heads/parent'}, {issueId:'thread:prefix'}).entityId;
    const b=openResource(t,'member:be',{kind:'branch',repositoryKey:REPOSITORIES[0],key:'refs/heads/child'}, {issueId:'thread:prefix:child'}).entityId;
    subscribe(t,'member:fe',a);subscribe(t,'member:be',b);
    publish(t,'member:be',b,'child only');
    const parent=publish(t,'member:fe',a,'parent only');
    assert.equal(parent.result.delivered.length,1);
    assert.deepEqual(readThreadEvents(t.store,{threadRef:a}).events.map(e=>e.summary),['parent only']);
    assert.equal(resourceThreadView(t.store,a).subscribers.length,1);
    unsubscribe(t,'member:fe',a,{reason:'leave parent'});
    assert.equal(t.store.list('thread-delivery:').find(d=>d.threadRef===b).state,'pending');
    assert.deepEqual(threadRetention(t.store,a).collectable,[1]);
  } finally {t.close();}
});

