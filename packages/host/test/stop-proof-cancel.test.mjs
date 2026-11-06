// Review 1 #1 (blocker): an automatic execution stop is not the operator's manual release.
//
// The cancel effect used to answer { stopped: true, evidenceRef: 'native-stop:<id>' } after agent.cancel()/whenIdle(),
// and the close-out then released the lease with actor:'operator' - the manual exemption, used by a machine, on no
// proof at all. With the autonomy switch on the same close-out now demands what the member path demands: a verified
// stop-proof row, written by the adapter, naming this attempt or the member generation that owned it.
//
// Failure keeps everything: the attempt stays unknown (its run slot is still occupied), nothing is released, and the
// effect settles unproven, which is what hands it to a human.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
import { profile, until } from '../test-support/profile.mjs';
import { closeEffect } from '../src/effects/protocol.mjs';
import { certificate } from '../test-support/execution.mjs';

function team(label, { autonomy = 'on' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cancel-proof-' + label + '-'));
  const store = new ControlStore(root);
  const core = new TeamCore(store, {}, { enabled: true, autonomy, decisionTtlMs: 900000 });
  core.member('member:root', 'root');
  core.member('member:w', 'worker');
  core.mutate('task:a', 'scheduler', {}, tx => tx.put('task:a', { owner: 'member:w', status: 'executing',
    attemptId: 'attempt:a', lastFence: 3, contractRevision: 1 }));
  core.mutate('attempt:a', 'scheduler', {}, tx => tx.put('attempt:a', { owner: 'member:w', taskId: 'task:a',
    lease: 'unknown', status: 'unknown', fence: 3, generation: 1, executionSessionId: 'session:w',
    expiresAt: Date.now() + 60000 }));
  core.mutate('wait:a', 'scheduler', {}, tx => tx.put('wait:a', { status: 'pending', attemptId: 'attempt:a',
    taskId: 'task:a', dependency: { kind: 'message', messageId: 'message:x' }, deadline: null }));
  return { root, store, core, close() { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

/** One cancel effect closed exactly the way the runner closes it: the protocol's close-out inside the settle. */
function closeOut(t, evidence, options = { autonomy: true, decisionTtlMs: 900000 }) {
  const p=evidence.receipt?.stopProof;
  if(p?.verified && ((p.subject.kind==='attempt' && p.subject.id==='attempt:a' && p.subject.fence===3) ||
    (p.subject.kind==='member-session' && p.subject.id==='member:w' && p.subject.fence===1)))
    evidence={...evidence,receipt:{...evidence.receipt,stopProof:certificate(t.core,p.subject,{attemptId:'attempt:a'})}};
  return t.store.commit(t.core.command('effect:cancel', 'adapter', {}),
    tx => { closeEffect(tx, { id: 'effect:cancel', payload: { kind: 'cancel', attemptId: 'attempt:a' } }, evidence,
      { revisions: new Map() }, options); return { closed: true }; });
}

const proofFor = (subject, verified = true) => ({ kind: 'stop-proof', subject, method: 'in-process-session', roots: [],
  verified, writtenBy: 'adapter', switch: 'on', at: Date.now(), confidence: verified ? 'medium' : 'low',
  error: verified ? null : { code: 'STOP_PROOF_TIMEOUT', message: 'still alive' } });

test('an autonomy execution cancel without a proof keeps the attempt unknown and its slot occupied', () => {
  const t = team('unproven');
  try {
    // Exactly what the reviewed automatic path returned: a claim, an id it made up, and no proof behind either.
    assert.throws(() => closeOut(t, { executed: true, receipt: { stopped: true, evidenceRef: 'native-stop:e1' } }),
      { code: 'STOP_NOT_CONFIRMED' });
    const attempt = t.store.read('attempt:a');
    assert.equal(attempt.lease, 'unknown', 'nothing was released on a claim');
    assert.equal(attempt.status, 'unknown');
    assert.equal(t.store.read('task:a').status, 'executing', 'the task is untouched');
    assert.equal(t.store.read('wait:a').status, 'pending', 'and so is the wait it held');
    assert.equal(t.store.list('stop-proof:').length, 0, 'the refused close-out wrote no proof row');
  } finally { t.close(); }
});

test('a proof taken for this attempt releases the lease as the adapter, and closes task and wait with it', () => {
  const t = team('attempt-proof');
  try {
    closeOut(t, { executed: true, receipt: { stopped: true,
      stopProof: proofFor({ kind: 'attempt', id: 'attempt:a', fence: 3 }) } });
    const attempt = t.store.read('attempt:a');
    assert.equal(attempt.lease, 'revoked');
    assert.equal(attempt.status, 'failed');
    assert.equal(t.store.read('task:a').status, 'failed', 'the task is closed by the same release');
    assert.equal(t.store.read('wait:a').status, 'cancelled');
    const proof = t.store.read(attempt.evidenceRef);
    assert.equal(proof.kind, 'stop-proof');
    assert.equal(proof.verified, true);
    assert.equal(proof.writtenBy, 'adapter', 'the row is the adapter\'s, not a relabelled claim');
    assert.deepEqual(proof.subject, { kind: 'attempt', id: 'attempt:a', fence: 3 });
  } finally { t.close(); }
});

test('a proof for the member generation that owned the attempt releases it too', () => {
  const t = team('member-proof');
  try {
    closeOut(t, { executed: true, receipt: { stopped: true,
      stopProof: proofFor({ kind: 'member-session', id: 'member:w', fence: 1 }) } });
    assert.equal(t.store.read('attempt:a').lease, 'revoked');
    assert.equal(t.store.read('task:a').status, 'failed');
  } finally { t.close(); }
});

test('a proof for another attempt or generation is not relabelled into this one', () => {
  const t = team('foreign');
  try {
    assert.throws(() => closeOut(t, { executed: true, receipt: { stopped: true,
      stopProof: proofFor({ kind: 'attempt', id: 'attempt:other', fence: 3 }) } }), { code: 'STOP_NOT_CONFIRMED' });
    assert.equal(t.store.read('attempt:a').lease, 'unknown');
    // A proof for the same member at a generation that is not this attempt's is the same refusal.
    assert.throws(() => closeOut(t, { executed: true, receipt: { stopped: true,
      stopProof: proofFor({ kind: 'member-session', id: 'member:w', fence: 2 }) } }), { code: 'STOP_NOT_CONFIRMED' });
    assert.equal(t.store.read('attempt:a').lease, 'unknown');
  } finally { t.close(); }
});

test('with the switch off the cancel close-out is HEAD: the operator channel, unchanged', () => {
  const t = team('off', { autonomy: 'off' });
  try {
    closeOut(t, { executed: true, receipt: { stopped: true, evidenceRef: 'evidence:stop' } },
      { autonomy: false, decisionTtlMs: 900000 });
    const attempt = t.store.read('attempt:a');
    assert.equal(attempt.lease, 'revoked');
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.evidenceRef, 'evidence:stop');
    assert.equal(t.store.read('task:a').status, 'failed');
    assert.equal(t.store.list('stop-proof:').length, 0, 'the package writes no proof row with the switch off');
  } finally { t.close(); }
});
/**
 * The same rule at the production seam: the port the runner calls for kind 'cancel'.
 *
 * Two runs of one fixture - an execution that really goes idle (a proof), and one that never does inside the two
 * budgets (no proof). The second one is the case the review reproduced: the old port answered { stopped: true } in
 * both, so the close-out released a live execution.
 */
const seedCancel = root => {
  const store = new ControlStore(root);
  const core = new TeamCore(store, {}, { enabled: true });
  core.member('member:old', 'worker');
  core.mutate('task:old', 'root', {}, tx => tx.put('task:old', { owner: 'member:old', status: 'executing',
    attemptId: 'attempt:old', lastFence: 1, contractRevision: 1 }));
  core.mutate('attempt:old', 'root', {}, tx => tx.put('attempt:old', { owner: 'member:old', taskId: 'task:old',
    generation: 1, fence: 1, status: 'unknown', lease: 'unknown', expiresAt: Date.now() + 600000,
    executionSessionId: 'session:old', scopeSet: [] }));
  // The cancel effect the domain writes for an execution nobody could account for (clock/recovery both do this).
  core.mutate('recover-cancel', 'scheduler', {}, tx => {
    tx.outbox('cancel:attempt:old', { kind: 'cancel', attemptId: 'attempt:old' });
    return null;
  });
  store.close();
};
const execution = whenIdle => ({ session: { id: 'session:old' }, phase: { kind: 'idle' }, cancel() {}, whenIdle,
  wakeDriver() {}, preemptStep() { return false }, ctx: { tools: { register() {}, restrict() {}, guard() {} } } });
const cancelled = () => profile({ autonomy: 'on', stopGraceMs: 50, stopProofTimeoutMs: 200,
  executionOf: async binding => { assert.equal(binding.executionSessionId, 'session:old'); return execution(() => undefined); } },
async ({ root }) => seedCancel(root));
const cancelEffect = w => w.runtime.store.effects().find(row => row.payload?.kind === 'cancel');

test('the production execution cancel takes a proof before it answers', async () => {
  const w = await cancelled();
  try {
    await until(() => w.runtime.store.effects().some(row => row.payload?.kind === 'cancel' &&
      ['applying', 'confirmed', 'unknown', 'retryable'].includes(row.status)));
    await w.runtime.runner.whenIdle();
    const effect = cancelEffect(w);
    await until(()=>cancelEffect(w).status==='unknown');
    const settled=cancelEffect(w);
    const proof = settled.lastEvidence?.adapterEvidence?.receipt?.stopProof ?? settled.lastEvidence?.receipt?.stopProof;
    assert.equal(proof?.verified, false, 'recovery without the original registry cannot invent a complete range');
    assert.equal(proof.writtenBy, 'adapter');
    assert.deepEqual(proof.subject, { kind: 'member-session', id: 'member:old', fence: 1 });
    assert.equal(w.runtime.store.read('attempt:old').lease, 'unknown', 'recovery holds its precise execution for verification');
    assert.equal(w.runtime.store.read('task:old').status, 'executing');
  } finally { await w.close(); }
});

test('the production execution cancel releases nothing when the execution never proves stopped', async () => {
  const w = await profile({ autonomy: 'on', stopGraceMs: 50, stopProofTimeoutMs: 200,
    executionOf: async () => execution(() => new Promise(() => {})) }, async ({ root }) => seedCancel(root));
  try {
    await until(() => cancelEffect(w) && ['applying', 'unknown', 'retryable'].includes(cancelEffect(w).status));
    await w.runtime.runner.whenIdle();
    const effect = cancelEffect(w);
    assert.notEqual(effect.status, 'confirmed', 'an unproven stop is never closed as done');
    assert.equal(w.runtime.store.read('attempt:old').lease, 'unknown', 'the lease and its run slot stay occupied');
    assert.equal(w.runtime.store.read('task:old').status, 'executing');
    assert.equal(w.runtime.store.list('stop-proof:').every(row => row.verified === false), true);
  } finally { await w.close(); }
});
