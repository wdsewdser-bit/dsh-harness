import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchTracker, createInProcessStopProver, createSubprocessTracker } from '../session-subprocess.mjs';
import { createExecutionScopes } from '../execution-scope.mjs';

const never = () => new Promise(() => {});
const subject = { kind: 'member-session', id: 'member:w', fence: 1 };

function fixture({ idle = null, handles = [], unattributed = [], open = [] } = {}) {
  const scopes=createExecutionScopes(),scope=scopes.open({teamId:'team',memberId:'member:w',generation:1,
    attemptId:'attempt:1',attemptFence:1,executionSessionId:'s1'}, {gates:true,attribution:true,transport:true,subprocess:true});
  const raw=createSubprocessTracker();
  const tracker={...raw,record(handle,kind,who={}){
    if(!who.memberId)scope.invalidate('unattributed-process');
    return raw.record(handle,kind,who.memberId==='member:w'?{...who,scope,permit:scope.acquire(kind)}:who);
  }};
  const rawDispatch=createDispatchTracker({scopes}),calls=new Map(),tokens=new Map();
  const dispatch={...rawDispatch,observe(event){
    if(event.phase==='prepared' && !calls.has(event.attempt))calls.set(event.attempt,scope.call());
    if(event.phase==='send-started') {
      if(scope.state()!=='OPEN' && !calls.has(event.attempt)){scope.invalidate('unpermitted-send');return rawDispatch.observe(event);}
      const call=calls.get(event.attempt)??scope.call();calls.set(event.attempt,call);
      const key=JSON.stringify([event.attempt,event.transmission]);
      if(!tokens.has(key))try{tokens.set(key,call.reserve(event.attempt,event.transmission));}catch{scope.invalidate('unpermitted-send');}
    }
    return rawDispatch.observe(event);
  }};
  for (const handle of handles) tracker.record(handle, 'spawn', { memberId: 'member:w', sessionId: 's1', basis: 'scope' });
  for (const handle of unattributed) tracker.record(handle, 'spawn', { memberId: null, sessionId: null, basis: 'none' });
  for (const attempt of open) {
    dispatch.observe({ contract: 'team-dispatch/2', sessionId: 's1', attempt: attempt.id, phase: 'prepared' });
    dispatch.observe({ contract: 'team-dispatch/2', sessionId: 's1', attempt: attempt.id, phase: 'send-started', transmission: 1 });
  }

  const agent={session:{id:'s1'},cancelled:0,cancel(){this.cancelled++;},whenIdle:idle??(async()=>{})};
  const prover=createInProcessStopProver({tracker,dispatch,agentOf:id=>id==='member:w'?agent:null,scopes});
  return {tracker,dispatch,agent,scope,finishCalls(){for(const token of tokens.values())scope.finish(token);for(const c of calls.values())c.close();},
    prove:extra=>prover({subject,graceMs:20,proofTimeoutMs:60,...extra})};
}

function exitedHandle() {
  return { terminated: 0, terminate() { this.terminated += 1; }, async waitForExit() { return true; }, done: Promise.resolve() };
}
function stuckHandle() {
  return { terminated: 0, terminate() { this.terminated += 1; }, async waitForExit() { return false; }, done: Promise.resolve() };
}

test('stop quiescence does not rewrite an unknown historical wake into execution success',async()=>{
  const h=fixture();await assert.rejects(h.scope.perform('wakeDriver',()=>{throw Error('ack lost');}));
  assert.equal(h.scope.snapshot().uncertain,1);
  const proof=await h.prove();assert.equal(proof.verified,true);
  assert.equal(h.scope.snapshot().historicalUnknown,1,'historical uncertainty is independent of stop state');
  const physical=fixture();await assert.rejects(physical.scope.perform('transmission',()=>{throw Error('network unknown');}));
  assert.equal((await physical.prove()).verified,false,'unknown physical IO cannot be reconciled from idle');
});

test('all three conditions hold: verified, medium confidence, method in-process-session', async () => {
  const h = fixture({ handles: [exitedHandle()] });
  const row = await h.prove();
  assert.equal(row.method, 'sealed-execution');
  assert.equal(row.verified, true);
  assert.equal(row.confidence, 'medium');
  assert.equal(row.error, null);
  assert.equal(h.agent.cancelled, 1);
  assert.deepEqual(row.checks.children, { registered: 1, terminated: 1, exited: 1, alive: 0, unattributed: 0, unattributedAlive: 0, handles: [{ kind: 'spawn',
    terminated: true, exited: true, error: null }] });
  assert.deepEqual(row.checks.llm, { basis: 'loop', sessionId: 's1', open: [] });
});

test('(a) a turn that never goes idle inside the budgets is not stopped', async () => {
  const h = fixture({ idle: never });
  const row = await h.prove();
  assert.equal(row.verified, false);
  assert.equal(row.checks.idle.ok, false);
  assert.equal(row.error.code, 'STOP_PROOF_TIMEOUT');
});

test('(b) an in-flight provider request blocks the proof, and a committed one does not', async () => {
  const open = fixture({ open: [{ id: 'dispatch:1' }] });
  const row = await open.prove();
  assert.equal(row.verified, false);
  assert.equal(row.checks.llm.open.length, 1);
  assert.equal(row.error.code, 'STOP_NOT_VERIFIED');
  const closed = fixture();
  closed.dispatch.observe({ contract: 'team-dispatch/2', sessionId: 's1', attempt: 'dispatch:2', phase: 'prepared' });
  closed.dispatch.observe({ contract: 'team-dispatch/2', sessionId: 's1', attempt: 'dispatch:2', phase: 'send-started', transmission: 1 });
  closed.dispatch.observe({ contract: 'team-dispatch/2', sessionId: 's1', attempt: 'dispatch:2', phase: 'committed', transmission: 1 });
  assert.equal((await closed.prove()).verified,false,'headers are not iterator termination');
  closed.finishCalls();
  const after = await closed.prove();
  assert.equal(after.verified, true);
  assert.equal(after.checks.llm.basis, 'dispatch');
});

test('(c) whenIdle succeeds but a tool child still runs: verified is false, and the handle was terminated', async () => {
  const stuck = stuckHandle();
  const h = fixture({ handles: [stuck] });
  const row = await h.prove();
  assert.equal(row.verified, false);
  assert.equal(stuck.terminated, 1);
  assert.equal(row.checks.children.alive, 1);
  assert.equal(row.error.code, 'STOP_NOT_VERIFIED');
});

test('(c) whenIdle succeeds but a handle never answers waitForExit: verified is false', async () => {
  // (a) holds -- the turn went idle -- and (b) holds -- nothing is in flight -- and the proof still has to say no,
  // because (c) is the one condition the session cannot satisfy from inside itself: the OS child is not gone.
  const handle = { terminated: 0, terminate() { this.terminated += 1; }, waitForExit: never, done: Promise.resolve() };
  const h = fixture({ handles: [handle] });
  const row = await h.prove();
  assert.equal(row.checks.idle.ok, true);
  assert.equal(row.checks.llm.open.length, 0);
  assert.equal(row.verified, false);
  assert.equal(row.checks.children.alive, 1);
  assert.equal(row.checks.children.handles[0].error, 'STOP_PROOF_TIMEOUT');
  assert.equal(row.confidence, 'low');
});

test('(c) a terminate that throws is a refusal, not a pass', async () => {
  const handle = { terminate() { throw Object.assign(new Error('denied'), { code: 'STOP_ACCESS_DENIED' }); }, async waitForExit() { return true; }, done:
    Promise.resolve() };
  const h = fixture({ handles: [handle] });
  const row = await h.prove();
  assert.equal(row.verified, false);
  assert.equal(row.checks.children.alive, 1);
});

test('(c) an unattributed child that is still alive blocks every member proof', async () => {
  const live = { terminate() {}, waitForExit: never, done: never() };
  const h = fixture({ handles: [exitedHandle()], unattributed: [live] });
  const row = await h.prove();
  assert.equal(row.verified, false);
  assert.equal(row.checks.children.unattributed, 1);
  assert.equal(row.checks.children.unattributedAlive, 1);
  assert.match(row.error.message, /no owning member/);
});

test('(c) an unattributed exit cannot repair missing range coverage', async () => {
  const h = fixture({ handles: [exitedHandle()], unattributed: [exitedHandle()] });
  const row = await h.prove();
  assert.equal(row.verified, false);
  assert.equal(row.checks.children.unattributed, 1);
  assert.equal(row.checks.children.unattributedAlive, 0);
});

test('a member with no live agent cannot be proven stopped at all', async () => {
  const tracker = createSubprocessTracker();
  const dispatch = createDispatchTracker();
  const prover = createInProcessStopProver({ tracker, dispatch, agentOf: () => null });
  const row = await prover({ subject, graceMs: 20, proofTimeoutMs: 20 });
  assert.equal(row.verified, false);
  assert.equal(row.error.code, 'EXECUTION_SCOPE_MISSING');
});

test('a terminal handle is proven through terminate(), which awaits quiescence', async () => {
  let quiesced = false;
  const handle = { async terminate() { quiesced = true; }, done: Promise.resolve() };
  const h = fixture();
  h.tracker.record(handle, 'terminal', { memberId: 'member:w', sessionId: 's1', basis: 'scope' });
  const row = await h.prove();
  assert.equal(quiesced, true);
  assert.equal(row.verified, true);
  assert.equal(row.checks.children.terminated, 1);
});

test('tx1 answer cannot prove stopped while tx2 is still on the wire', async () => {
  const h = fixture();
  const phase = (type, tx) => h.dispatch.observe({ contract: 'team-dispatch/2', sessionId: 's1', attempt: 'A',
    phase: type, transmission: tx });
  phase('prepared'); phase('send-started', 1); phase('send-started', 2); phase('committed', 1);
  phase('committed', 1); phase('prepared'); // duplicate answer/prepared must not erase tx2
  assert.deepEqual(h.dispatch.open('s1').map(r => r.transmissionId), [1,2]);
  assert.equal((await h.prove()).verified, false);
  phase('failed', 2);
  assert.equal((await h.prove()).verified, false, 'post-send failure is uncertain');
  phase('committed', 2);
  assert.equal((await h.prove()).verified, false,'headers do not close C');
  h.finishCalls();
  assert.equal((await h.prove()).verified,true);
});

test('unnamed terminal cannot erase an unnamed or a different transmission send', async () => {
  const h = fixture();
  for (const e of [{ phase: 'send-started' }, { phase: 'send-started', transmission: 3 }, { phase: 'committed' },
    { phase: 'failed', transmission: 3 }, { phase: 'committed', transmission: 1 }])
    h.dispatch.observe({ contract: 'team-dispatch/2', sessionId: 's1', attempt: 'A', ...e });
  assert.ok(h.dispatch.open('s1').length >= 1);
  assert.equal((await h.prove()).verified, false);
});

test('proof resamples new transmission after asynchronous child cleanup', async () => {
  const h = fixture();
  h.tracker.record({ done: never(), terminate() {}, async waitForExit() {
    h.dispatch.observe({ contract: 'team-dispatch/2', sessionId: 's1', attempt: 'A', phase: 'send-started', transmission: 2 });
    return true;
  } }, 'spawn', { memberId: 'member:w' });
  const row = await h.prove();
  assert.equal(row.verified, false);
  assert.equal(h.scope.snapshot().coverage['unpermitted-send'],false);
});

test('1000 confirmed exits retire handles and keep only bounded lightweight audit', async () => {
  const tracker = createSubprocessTracker(), entries = [];
  for (let n = 0; n < 1000; n++) entries.push(tracker.record(exitedHandle(), 'spawn', { memberId: 'member:w' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tracker.size(), 0);
  assert.equal(tracker.retired(), 1000);
  assert.equal(tracker.forMember('member:w').length, 0);
  assert.ok(tracker.audit().length <= 256);
  assert.ok(tracker.audit().every(row => !Object.hasOwn(row, 'handle')));
  assert.ok(entries.every(entry => entry.handle === null));
});

test('top process done does not reclaim a still-live managed range', async () => {
  const tracker = createSubprocessTracker();
  tracker.record(stuckHandle(), 'spawn', { memberId: 'member:w' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tracker.size(), 1);
  assert.equal(tracker.retired(), 0);
});

test('terminal handle is retired only after terminate confirms quiescence', async () => {
  const h = fixture();
  const entry = h.tracker.record({ done: Promise.resolve(), async terminate() {} }, 'terminal', { memberId: 'member:w' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.tracker.size(), 1, 'terminal done alone is not range exit');
  assert.equal((await h.prove()).verified, true);
  assert.equal(h.tracker.size(), 0);
  assert.equal(entry.handle, null);
});
