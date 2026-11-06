// Review 1, item 1: the production lifecycle path has to take a stop proof, and the effect close-out has to check it.
//
// Two halves, one rule. The port (profiles/runtime.mjs) stops the session and returns the row the platform read back;
// the close-out (host/src/effects/protocol.mjs) writes that row and re-checks it in the transaction that would retire
// the member. A receipt that only says { stopped: true } -- what the reviewed code returned without waiting for the turn
// or looking at a single child process -- is not a stop: the member goes unknown, its lease is kept, and the operator
// gets one stuck-member row. With the switch off both halves are exactly HEAD's.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
import { closeEffect } from '../src/effects/protocol.mjs';
import { profile } from '../test-support/profile.mjs';
import { certificate } from '../test-support/execution.mjs';

function team(label, { autonomy = 'on' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-stop-closeout-' + label + '-'));
  const store = new ControlStore(root);
  const core = new TeamCore(store, {}, { enabled: true, autonomy, decisionTtlMs: 900000 });
  core.member('member:root', 'root');
  core.member('member:w', 'worker');
  core.mutate('attempt:a', 'scheduler', {}, tx => tx.put('attempt:a', { owner: 'member:w', taskId: 'task:a',
    lease: 'active', fence: 1, generation: 1, expiresAt: Date.now() + 60000 }));
  return { root, store, core, close() { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

/** Close one cancel-member effect exactly the way the runner does: one transaction, the protocol's own close-out. */
function closeOut(t, evidence, options) {
  const p=evidence.receipt?.stopProof;
  if(p?.verified && p.subject?.id==='member:w' && p.subject.fence===1)evidence={...evidence,receipt:{...evidence.receipt,stopProof:certificate(t.core,
    p.subject,{attemptId:'attempt:a'})}};
  const effect = { id: 'e1', payload: { kind: 'cancel-member', memberId: 'member:w', generation: 1 } };
  // The runner closes through the ledger (store.settle), which decides the effect row and ignores the close-out's own
  // return value; this wrapper does the same, so the transaction's receipt stays a ledger fact either way.
  return t.store.commit(t.core.command('effect:e1', 'adapter', {}),
    tx => { closeEffect(tx, effect, evidence, { revisions: new Map() }, options); return { closed: true }; });
}

const proofFor = (id, fence, verified = true) => ({ kind: 'stop-proof', subject: { kind: 'member-session', id, fence },
  method: 'in-process-session', roots: [], verified, writtenBy: 'adapter', switch: 'on', at: Date.now(),
  confidence: verified ? 'medium' : 'low', error: verified ? null : { code: 'STOP_PROOF_TIMEOUT', message: 'still alive' } });

test('an autonomy cancel that carries no proof keeps the member unknown, keeps the lease and opens the stuck-member row', () => {
  const t = team('unproven');
  try {
    closeOut(t, { executed: true, receipt: { stopped: true } }, { autonomy: true, decisionTtlMs: 900000 });
    const member = t.store.read('member:w');
    assert.equal(member.status, 'unknown', 'never retired on a bare { stopped: true }');
    assert.equal(member.observed, 'unknown');
    assert.equal(member.responsible, 'operator');
    assert.equal(member.generation, 1, 'no generation was advanced, so the same member is still in question');
    assert.equal(t.store.read('attempt:a').lease, 'active', 'the attempt keeps its lease: nothing was proven stopped');
    const proof = t.store.read(member.lastStopProof);
    assert.equal(proof.kind, 'stop-proof');
    assert.equal(proof.verified, false);
    assert.equal(proof.writtenBy, 'adapter');
    const decisions = t.store.list('decision:').filter(row => row.kind === 'stuck-member');
    assert.equal(decisions.length, 1, 'the escalation is a row, not a note');
    assert.equal(decisions[0].state, 'open');
    assert.equal(decisions[0].openedFor, 'operator');
    assert.equal(member.stopDecision, decisions[0].entityId);
    // The row is decidable: it names the revision the member row was written at, not the one it replaced.
    t.core.decideDecision(decisions[0].entityId, 'member:root', { decision: 'wait', reason: 'operator has the machine' });
    assert.equal(t.store.read(decisions[0].entityId).state, 'decided');
  } finally { t.close(); }
});

test('a verified proof for exactly this member and generation retires it, and the row is kept as evidence', () => {
  const t = team('verified');
  try {
    closeOut(t, { executed: true, receipt: { stopped: true, stopProof: proofFor('member:w', 1) } },
      { autonomy: true, decisionTtlMs: 900000 });
    const member = t.store.read('member:w');
    assert.equal(member.status, 'frozen');
    assert.equal(member.observed, 'stopped');
    assert.equal(member.generation, 2, 'the retirement advanced the generation, as it always did');
    const proof = t.store.read(member.lastStopProof);
    assert.equal(proof.verified, true);
    assert.deepEqual(proof.subject, { kind: 'member-session', id: 'member:w', fence: 1 });
    assert.equal(t.store.list('decision:').length, 0, 'a proven stop needs nobody');
  } finally { t.close(); }
});

test('a proof taken for another subject is not relabelled into this one', () => {
  const t = team('foreign');
  try {
    closeOut(t, { executed: true, receipt: { stopped: true, stopProof: proofFor('member:other', 1) } },
      { autonomy: true, decisionTtlMs: 900000 });
    const member = t.store.read('member:w');
    assert.equal(member.status, 'unknown', 'the row names another member, so it proves nothing about this one');
    assert.equal(t.store.read(member.lastStopProof).verified, false);
    assert.equal(t.store.list('decision:').filter(row => row.kind === 'stuck-member').length, 1);
  } finally { t.close(); }
});

test('with the switch off the close-out is HEAD: stopped:true retires, and stopped:false is still STOP_NOT_CONFIRMED', () => {
  const t = team('off', { autonomy: 'off' });
  try {
    // HEAD's refusal, unchanged: a receipt that does not claim a stop never retires a member.
    assert.throws(() => closeOut(t, { executed: true, receipt: { stopped: false } }, { autonomy: false, decisionTtlMs: 900000 }),
      { code: 'STOP_NOT_CONFIRMED' });
    assert.equal(t.store.read('member:w').generation, 1, 'the refused close-out wrote nothing');
    closeOut(t, { executed: true, receipt: { stopped: true } }, { autonomy: false, decisionTtlMs: 900000 });
    const member = t.store.read('member:w');
    assert.equal(member.status, 'frozen');
    assert.equal(member.generation, 2);
    assert.equal(member.lastStopProof ?? null, null, 'the package writes no proof row');
    assert.equal(t.store.list('stop-proof:').length, 0);
    assert.equal(t.store.list('decision:').length, 0);
  } finally { t.close(); }
});

test('the production port proves the stop before it answers, and dispose proves before it drops the handle', async () => {
  const w = await profile({ autonomy: 'on' });
  try {
    const core = w.runtime.core;
    core.member('member:w', 'worker');
    const created = await core.ports.create({ memberId: 'member:w', cwd: w.root });
    assert.ok(created.nativeRef);
    const receipt = await core.ports.cancel({ memberId: 'member:w', generation: 1 });
    assert.equal(receipt.stopped, false);
    assert.equal(receipt.stopProof.kind, 'stop-proof');
    assert.deepEqual(receipt.stopProof.subject, { kind: 'member-session', id: 'member:w', fence: 1 });
    assert.equal(receipt.stopProof.verified, false);
    assert.equal(receipt.stopProof.writtenBy, 'adapter');
    assert.equal(receipt.stopProof.switch, 'on');
    // A prover that cannot verify is not a stop: the port says so instead of reporting one it did not observe.
    const agent=w.runtime.handles.get('member:w').agent;
    core.mutate('attempt:timeout','scheduler',{},tx=>tx.put('attempt:timeout',{owner:'member:w',taskId:'task:timeout',lease:'active',fence:1,generation:1,
      executionSessionId:agent.session.id}));
    w.runtime.bindAgent('member:w',{attemptId:'attempt:timeout',fence:1,generation:1});
    core.ports.stopProof = async () => ({ verified: false, error: { code: 'STOP_PROOF_TIMEOUT', message: 'still alive' } });
    const unproven = await core.ports.cancel({ memberId: 'member:w', generation: 1 });
    assert.equal(unproven.stopped, false);
    assert.equal(unproven.stopProof.verified, false);
    const disposed = await core.ports.dispose({ memberId: 'member:w', generation: 1 });
    assert.equal(disposed.stopped, false, 'the dispose is not a retirement either');
    assert.equal(disposed.stopProof.error.code, 'STOP_PROOF_TIMEOUT');
    assert.equal(w.runtime.handles.has('member:w'), true, 'unverified disposal retains the unique recovery handle');
  } finally { await w.close(); }
});
test('a verified stop closes the generation it proves: attempt, task, wait and the run slot', () => {
  // Review 1 #2: advancing the member generation alone left the old leases active (or unknown) and, because the store
  // keeps one run slot per owner, still occupying capacity that no later close-out would ever free -- a stop that was
  // proven and yet did not finish closing the resources it proved.
  const t = team('reclaims');
  try {
    t.core.mutate('task:a', 'scheduler', {}, tx => tx.put('task:a', { owner: 'member:w', status: 'executing',
      attemptId: 'attempt:a', lastFence: 1, contractRevision: 1 }));
    t.core.mutate('wait:a', 'scheduler', {}, tx => tx.put('wait:a', { status: 'pending', attemptId: 'attempt:a',
      taskId: 'task:a', dependency: { kind: 'message', messageId: 'message:x' }, deadline: null }));
    closeOut(t, { executed: true, receipt: { stopped: true, stopProof: proofFor('member:w', 1) } },
      { autonomy: true, decisionTtlMs: 900000 });
    const attempt = t.store.read('attempt:a');
    assert.equal(attempt.lease, 'revoked', 'the attempt of the proven generation is closed with it');
    assert.equal(attempt.status, 'cancelled');
    assert.equal(t.store.read('task:a').status, 'cancelled', 'and its task, in the same transaction');
    assert.equal(t.store.read('wait:a').status, 'cancelled', 'and the wait it held');
    assert.equal(t.store.read('member:w').generation, 2);
    // The run slot is free: run_slots.owner is UNIQUE, so another active attempt for the same member can only be
    // written if the stopped generation really let go of the slot.
    t.core.mutate('attempt:c', 'scheduler', {}, tx => tx.put('attempt:c', { owner: 'member:w', taskId: 'task:c',
      lease: 'active', status: 'running', fence: 1, generation: 3, expiresAt: Date.now() + 60000 }));
    assert.equal(t.store.read('attempt:c').lease, 'active');
  } finally { t.close(); }
});

test('an unproven member stop reclaims nothing', () => {
  const t = team('keeps');
  try {
    t.core.mutate('task:a', 'scheduler', {}, tx => tx.put('task:a', { owner: 'member:w', status: 'executing',
      attemptId: 'attempt:a', lastFence: 1, contractRevision: 1 }));
    closeOut(t, { executed: true, receipt: { stopped: true } }, { autonomy: true, decisionTtlMs: 900000 });
    assert.equal(t.store.read('attempt:a').lease, 'active', 'the lease the proof did not cover is untouched');
    assert.equal(t.store.read('task:a').status, 'executing');
    assert.equal(t.store.read('member:w').status, 'unknown');
  } finally { t.close(); }
});

test('missing dispatch monitoring cannot grant complete transport coverage even with a permit-capable runtime',async()=>{
  const w=await profile({autonomy:'on'},async({ctx})=>{
    const on=ctx.on.bind(ctx);let rejected=false;
    ctx.llm.executionPermitContract='execution-permit/1';
    ctx.on=(name,...args)=>{if(name==='llm/dispatch'&&!rejected){rejected=true;throw Error('monitor unavailable');}return on(name,...args);};
  });
  try{
    const core=w.runtime.core;core.member('member:w','worker');
    await core.ports.create({memberId:'member:w',cwd:w.root});await w.runtime.stop.ready;
    core.mutate('attempt:monitor','scheduler',{},tx=>tx.put('attempt:monitor',{owner:'member:w',taskId:'task:monitor',lease:'active',status:'running',fence:
      1,generation:1}));
    const agent=w.runtime.bindAgent('member:w',{attemptId:'attempt:monitor',fence:1,generation:1});
    const scope=w.runtime.executionScopes.get(agent.session.id);
    assert.equal(scope.snapshot().coverage.transport,false);
    const receipt=await core.ports.dispose({memberId:'member:w',generation:1});
    assert.equal(receipt.stopped,false);assert.equal(w.runtime.handles.has('member:w'),true);
    assert.equal(core.store.read('attempt:monitor').lease,'active');
  }finally{await w.close();}
});

