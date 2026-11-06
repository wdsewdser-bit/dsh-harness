// §5 of the super-agent borrow design (P3): one input model, one arbiter, one bounded batch, one wake edge.
//
// The cases run offline against a real control store. The core is configured v1 so the S3 code paths are exercised as
// they will run once the protocol can boot; the composition root still refuses to activate v1 (pinned below). The
// legacy arm keeps its own tests (preempt.test.mjs, wake-contract) and this file asserts it is still what a default
// team runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from '../../store/index.mjs';
import { createHumanInputGateway } from '../../host/index.mjs';
import { TeamCore, drain } from '../index.mjs';
import { pendingInputs, orderedInputs, INPUT_KINDS, publicBinding, HUMAN_SLOTS } from '../inputs.mjs';
import { batchCandidate, BATCH_TEXT_LIMIT, renderBatchText, payloadDigest } from '../snapshot.mjs';
import { hash } from '../../contracts/index.mjs';
import { batchPreStep, recordBatchInjection, requestBoundaryBatch, advanceThreadWatermark, verifyInputBinding } from '../provenance.mjs';
import { MemberInputArbiter, PreemptWatcher, inputPolicy } from '../preempt.mjs';
import { BORROW_IMPLEMENTATION_STAGES, ROOT_DECISION_SEMANTICS, assertProtocolSupported } from '../../contracts/index.mjs';


import { root, codeOf, bytes, team, send, humanSend, humanCredential, openResource, subscribe, publish, deliveries,
  ports } from '../test-support/s3-fixtures.mjs';

const resign = c => {
  c.text = renderBatchText(c.payload); c.manifest.hash = hash(c.text); c.manifest.payloadHash = payloadDigest(c.payload);
  return c;
};

test('B03 review: manifest metadata cannot relabel the hashed payload; a self-consistent forged body is refused', () => {
  const t = team('forgery');
  try {
    send(t, 'member:root', 'member:be', 'action', 'real body');
    const c = batchCandidate(t.core, 'member:be');
    for (const change of [
      x => { x.manifest.inputBindings[0].bodyRef = 'artifact:forged'; },
      x => { x.manifest.batch.cutoffSeq = 0; },
      x => { x.manifest.messageBindings[0].generation = 9; },
      x => { x.batch.generation = 9; },
      x => { x.payload.inputs[0].summary = 'forged instructions'; resign(x); },
      x => { x.payload.inputs = []; resign(x); },
      x => { x.payload.batch.cutoffSeq = 0; x.payload.asOfSeq = 0; x.batch.cutoffSeq = 0;
        x.manifest.batch.cutoffSeq = 0; x.manifest.revision = 0; resign(x); },
    ]) {
      const forged = structuredClone(c); change(forged);
      assert.equal(codeOf(() => recordBatchInjection(t.core, forged, 'native:forgery', [1])), 'INVALID_MANIFEST');
      assert.equal(t.store.read('manifest:' + forged.manifest.hash), null);
    }
  } finally { t.close(); }
});

test('B02/B03 review: generation and subscription epoch are rechecked at record AND send', () => {
  const t = team('stale-send');
  try {
    const thread = openResource(t, 'member:be', { kind: 'file-area', repositoryKey: 'repo:acme/app', key: 'src' });
    subscribe(t, 'member:be', thread.entityId); publish(t, 'member:be', thread.entityId, 'change');
    const c = batchCandidate(t.core, 'member:be');
    recordBatchInjection(t.core, c, 'native:stale-send', [1]);
    t.core.mutate('member:be', 'root', {}, (tx, row) => tx.put('member:be', { ...row, generation: row.generation + 1 }));
    assert.equal(codeOf(() => requestBoundaryBatch(t.core, c.manifest.hash,
      { requestId: 'stale', sessionSeq: 2, requestedAt: 1, generation: c.batch.generation })), 'STALE_MESSAGE_BINDING');
    assert(deliveries(t, thread.entityId).every(row => row.state === 'pending'));
  } finally { t.close(); }
  const u = team('unsubscribe');
  try {
    const thread = openResource(u, 'member:be', { kind: 'file-area', repositoryKey: 'repo:acme/app', key: 'src' });
    subscribe(u, 'member:be', thread.entityId); publish(u, 'member:be', thread.entityId, 'old');
    const c = batchCandidate(u.core, 'member:be');
    const issueId = thread.entityId;
    u.core.dispatch('thread-op:' + u.op('unsub'), 'member:be', { issueId },
      { type: 'thread.unsubscribe', payload: { issueId, reason: 'review epoch race' } });
    subscribe(u, 'member:be', issueId);
    assert.equal(codeOf(() => recordBatchInjection(u.core, c, 'native:old-epoch', [1])), 'STALE_MESSAGE_BINDING');
    assert.equal(pendingInputs(u.core, 'member:be').pendingCount, 0);
  } finally { u.close(); }
});

test('B04 review: a long multibyte human flood and an action flood cannot spend the resource byte reserve', () => {
  const t = team('fair-bytes');
  try {
    const thread = openResource(t, 'member:be', { kind: 'file-area', repositoryKey: 'repo:acme/app', key: 'src' });
    subscribe(t, 'member:be', thread.entityId); publish(t, 'member:be', thread.entityId, 'old');
    for (let n = 0; n < 12; n++) humanSend(t, '控制'.repeat(80));
    const c = batchCandidate(t.core, 'member:be');
    assert(c.manifest.inputBindings.some(b => b.kind === 'thread-delivery'));
    assert(bytes(c.text) <= 4096);
    assert.equal(codeOf(() => batchCandidate(t.core, 'member:be', { limit: 100000 })), 'INVALID_CONFIG');
    const actions = pendingInputs(t.core, 'member:be').bindings.map(b => ({ ...b, kind: b.kind === 'human-control' ? 'message' : b.kind }));
    assert.equal(orderedInputs(actions)[0].kind, 'thread-delivery', 'resource also survives continuous action traffic');
  } finally { t.close(); }
});

test('B03/B04 review: visible inputs leave the next batch; internal manifests do not self-trigger; restart is stable', async () => {
  const t = team('no-self-trigger');
  try {
    send(t, 'member:root', 'member:be', 'action', 'one');
    const counter = { n: 0 }, raw = ports(counter);
    const p = { ...raw, inject: async text => ({ ...await raw.inject(text), generation: t.store.read('member:be').generation }) };
    const first = await batchPreStep(t.core, 'member:be', p);
    assert.equal(await batchPreStep(t.core, 'member:be', p), null, 'recording a manifest does not change batch identity');
    assert.equal(counter.n, 1);
    const before = batchCandidate(t.core, 'member:be');
    t.store.close(); t.store = new ControlStore(t.dir); t.core.store = t.store;
    assert.equal(batchCandidate(t.core, 'member:be').text, before.text, 'reopening preserves committed ordering');
    requestBoundaryBatch(t.core, first.manifest.hash,
      { requestId: 'sent', sessionSeq: 2, requestedAt: 1, generation: first.batch.generation });
    assert.equal(batchCandidate(t.core, 'member:be'), null, 'visible action is not re-injected while awaiting accept');
  } finally { t.close(); }
});

test('B04 review: a missing delivery and an unknown delivery state are holes, not a terminal prefix', () => {
  const t = team('holes');
  try {
    const thread = openResource(t, 'member:be', { kind: 'file-area', repositoryKey: 'repo:acme/app', key: 'src' });
    subscribe(t, 'member:be', thread.entityId);
    for (let n = 0; n < 3; n++) publish(t, 'member:be', thread.entityId, 'hole' + n);
    const rows = deliveries(t, thread.entityId).sort((a,b) => a.seq - b.seq);
    for (const row of rows) t.core.mutate(row.entityId, 'adapter', {}, tx => tx.put(row.entityId,
      { ...tx.read(row.entityId), state: row.seq === 1 ? 'unknown' : 'visible' }));
    advanceThreadWatermark(t.core, thread.entityId, 'member:be');
    assert.equal(t.store.read('thread-subscription:' + thread.entityId + ':member:be').visibleThrough, 0);
  } finally { t.close(); }
});

test('B02/B04 review: commit order is not source sequence; resource-only ready admits a mailbox, never an owner attempt', () => {
  const t=team('unified-drain');
  try {
    for(const id of ['task:be','task:root'])t.core.mutate(id,'root',{},(tx,row)=>tx.put(id,{...row,status:'done'}));
    const first=send(t,'member:root','member:qa','action','first').result;
    const second=send(t,'member:root','member:qa','action','second').result;
    t.core.mutate(first.entityId,'adapter',{},(tx,row)=>tx.put(row.entityId,{...row,seq:999999}));
    t.core.mutate(second.entityId,'adapter',{},(tx,row)=>tx.put(row.entityId,{...row,seq:1}));
    const ordered=orderedInputs(pendingInputs(t.core,'member:qa').bindings);
    assert.deepEqual(ordered.map(b=>b.ref),[first.entityId,second.entityId]);
    assert(ordered[0].sourceSeq>pendingInputs(t.core,'member:qa').cutoffSeq,'sourceSeq lives in a different space');
    const thread=openResource(t,'member:be',{kind:'file-area',repositoryKey:'repo:acme/app',key:'src'});
    subscribe(t,'member:be',thread.entityId);publish(t,'member:be',thread.entityId,'resource-only');
    assert.equal(t.core.pending('member:be').length,0);
    assert.equal(t.core.ready('member:be'),true,'resource-only is ready without fabricating a message');
    drain(t.core);
    assert(t.store.read('task:mail-member:be')?.mailboxMessages.some(key=>key.includes('thread-delivery:')));
    assert.equal(t.store.list('attempt:').filter(a=>a.owner==='member:root').length,0);
  }finally{t.close();}
});

test('B04 review: committed resource rotation survives restart and same-thread input order remains FIFO', () => {
  const t=team('durable-rotation');
  try {
    const refs=['src','other'].map(key=>openResource(t,'member:be',{kind:'file-area',repositoryKey:'repo:acme/app',key}));
    for(const thread of refs){subscribe(t,'member:be',thread.entityId);publish(t,'member:be',thread.entityId,'first');publish(t,'member:be',thread.entityId,
      'second');}
    const first=batchCandidate(t.core,'member:be');
    const leading=first.manifest.inputBindings[0].threadRef;
    recordBatchInjection(t.core,first,'native:rotation',[1]);
    requestBoundaryBatch(t.core,first.manifest.hash,{requestId:'rotation',sessionSeq:1,requestedAt:1,generation:first.batch.generation});
    const next=batchCandidate(t.core,'member:be');
    assert.equal(next.batch.rotation,1);
    assert.notEqual(next.manifest.inputBindings[0].threadRef,leading,'the other resource gets the next byte reserve');
    t.store.close();t.store=new ControlStore(t.dir);t.core.store=t.store;
    assert.equal(batchCandidate(t.core,'member:be').text,next.text,'cursor and pending order survive reopen');
  }finally{t.close();}
});

test('B02/B03 review: a coordination result belongs to its initiating E, not another execution of the same generation',()=>{
  const t=team('result-E');
  try{
    const admitted=t.core.schedule(t.op('admit'),'task:be').result;
    t.core.mutate(admitted.attemptId,'adapter',{},(tx,row)=>tx.put(row.entityId,{...row,status:'running'}));
    const E={teamId:t.core.configuration.teamId??'team',memberId:'member:be',generation:1,attemptId:admitted.attemptId,
      attemptFence:admitted.fence,executionSessionId:'session:old',executionEpoch:'exec:old'};
    const current='execution-current:'+admitted.attemptId;
    t.core.mutate(current,'adapter',{},tx=>tx.put(current,{E}));
    const sent=send(t,'member:be','member:root','intent','coordination',{taskRef:'task:be',contractRevision:1,
      reason:'conflict',evidenceRefs:['task:be'],expectedOutcome:'decide'}).result;
    const payload={decisionId:sent.decisionRef,decision:'approve',reason:'root approved',evidenceRef:null};
    t.core.dispatch(sent.decisionRef,'member:root',payload,{type:'decision.decide',policy:{authority:'owner'},payload});
    const candidate=batchCandidate(t.core,'member:be');
    assert.equal(candidate.manifest.inputBindings[0].kind,'coordination-result');
    assert.match(candidate.payload.inputs[0].summary,/approved|approve/,'the carried result actually contains the decision');
    recordBatchInjection(t.core,candidate,'native:result',[1]);
    t.core.mutate(current,'adapter',{},tx=>tx.put(current,{E:{...E,executionEpoch:'exec:new'}}));
    assert.equal(batchCandidate(t.core,'member:be'),null,'new E does not borrow an old result');
    assert.equal(codeOf(()=>requestBoundaryBatch(t.core,candidate.manifest.hash,
      {requestId:'late-result',sessionSeq:1,requestedAt:1,generation:1})),'STALE_MESSAGE_BINDING');
    assert(!t.store.read(sent.entityId).visibility['member:be']);
  }finally{t.close();}
});

test('B05 review: an info notice racing first dispatch never records a turn that did not open',()=>{
  const t=team('info-dispatch');
  try{
    const row=send(t,'member:root','member:be','info','carry on the next turn').result;
    let starts=0;
    const agent={phase:{kind:'idle'},wakeDriver(){starts++;this.phase={kind:'running'};return true;}};
    const arbiter=new MemberInputArbiter(t.core);arbiter.bind('member:be',agent);
    const info=arbiter.deliverMail('member:be',row.entityId);
    assert.equal(info.dispatched,false,'carry-only cannot consume first-dispatch');assert.equal(starts,0);
    assert.equal(arbiter.wakeIdle('member:be').fired,true);
    assert.equal(arbiter.wakeIdle('member:be').reason,'alreadyLive');assert.equal(starts,1);
  }finally{t.close();}
});

