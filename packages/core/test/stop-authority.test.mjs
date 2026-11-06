// P5 of the team-autonomy design (docs/decisions/team-autonomy-design.md §7.2.4, §7.4 F2-F6): who may close a stop,
// and on what evidence.
//
// The operator channel is the old one and must not regress. Beside it stands the predicate the design calls the
// watershed: the host adapter closes a lease on a stop-proof row that names the exact subject, was marked verified by
// the platform layer, and was written by the adapter itself. A model or an owner that cites a row it wrote is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../index.mjs';
import { confirmStopped } from '../effects.mjs';
import { applyLifecycle } from '../native.mjs';
import { certificate } from '../test-support/execution.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../runs');

function team(label, { ports = {}, configuration = {} } = {}) {
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'stop-authority-' + label + '-'));
  const store = new ControlStore(dir);
  const core = new TeamCore(store, { ...ports }, { enabled: true, ...configuration });
  core.member('member:root', 'root');
  core.member('member:w', 'worker');
  return { dir, store, core, close() { store.close?.(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function unknownAttempt(t, attemptId = 'attempt:a') {
  t.core.mutate(attemptId, 'scheduler', {}, tx => tx.put(attemptId, { owner: 'member:w', taskId: 'task:a',
    lease: 'unknown', status: 'unknown', fence: 1, generation: 1 }));
  return attemptId;
}

/** A stop-proof row written the way the host adapter writes it, without running a process. */
function proofRow(t, { subject, ref = 'stop-proof:p:1', verified = true, writtenBy = 'adapter', on = 'on' }) {
  const a=subject.kind==='attempt'?t.store.read(subject.id):t.store.list('attempt:').find(a=>a.owner===subject.id);
  const valid=a && (subject.kind==='attempt'?subject.id===a.entityId&&subject.fence===a.fence:subject.id===a.owner&&subject.fence===a.generation);
  const cert=valid?certificate(t.core,subject,{attemptId:a.entityId,verified}):{};
  t.core.mutate(ref, 'adapter', {}, tx => tx.put(ref, { ...cert,kind: 'stop-proof', subject, verified, writtenBy, switch: on,
    method: 'taskkill-tree', roots: [{ pid: 4242, createdAt: 'filetime:7', image: 'node.exe' }], reaped: [], descendantsAfter: 0,
    polls: 3, emptySince: 1, confidence: 'high', at: Date.now(), tool: 'taskkill /PID 4242 /T /F', error: null }));
  return ref;
}

function release(t, { ref, actor = 'adapter', attemptId = 'attempt:a', fence = 1 }) {
  const payload = { attemptId, fence, revoked: true, status: 'failed', evidenceRef: ref };
  return t.core.dispatch(attemptId, actor, payload, { type: 'attempt.release', payload });
}

test('an attempt a reused stop proof closes is never closed by the principal alone (the old rule, unchanged)', () => {
  const t = team('operator');
  try {
    const attemptId = unknownAttempt(t);
    assert.throws(() => release(t, { ref: null, actor: 'adapter' }), { code: 'DENIED' });
    assert.throws(() => release(t, { ref: 'evidence:whatever', actor: 'adapter' }), { code: 'DENIED' },
      'a bare evidence string is not a stop proof');
    assert.equal(t.store.read(attemptId).lease, 'unknown');
    // F5: the operator channel is exactly what it always was -- a principal plus a non-empty reference.
    release(t, { ref: 'evidence:operator-stop', actor: 'operator' });
    assert.equal(t.store.read(attemptId).lease, 'revoked');
    assert.equal(t.store.read(attemptId).evidenceRef, 'evidence:operator-stop');
    const exemption=t.store.list('break-glass:')[0];
    assert.equal(exemption.verified,false);assert.equal(exemption.riskExemption,true);assert.equal(exemption.stopState,'unverified');
  } finally { t.close(); }
});

test('the adapter closes a lease on a verified stop proof that names the attempt and its fence', () => {
  const t = team('adapter-verified', { configuration: { autonomy: 'on' } });
  try {
    const attemptId = unknownAttempt(t);
    const ref = proofRow(t, { subject: { kind: 'attempt', id: attemptId, fence: 1 } });
    release(t, { ref });
    assert.equal(t.store.read(attemptId).lease, 'revoked');
    assert.equal(t.store.read(attemptId).status, 'failed');
    assert.equal(t.store.read(attemptId).evidenceRef, ref);
  } finally { t.close(); }
});

test('a proof for a member generation closes the attempt that generation owned', () => {
  const t = team('adapter-generation', { configuration: { autonomy: 'on' } });
  try {
    const attemptId = unknownAttempt(t);
    const ref = proofRow(t, { subject: { kind: 'member-session', id: 'member:w', fence: 1 } });
    release(t, { ref });
    assert.equal(t.store.read(attemptId).lease, 'revoked');
  } finally { t.close(); }
});

test('an unverified proof, a foreign subject and a self-written row are all refused', () => {
  const t = team('adapter-refusals', { configuration: { autonomy: 'on' } });
  try {
    const attemptId = unknownAttempt(t);
    const unverified = proofRow(t, { subject: { kind: 'attempt', id: attemptId, fence: 1 }, verified: false, ref: 'stop-proof:p:u' });
    assert.throws(() => release(t, { ref: unverified }), { code: 'DENIED' }, 'verified:false is not a stop');
    const otherFence = proofRow(t, { subject: { kind: 'attempt', id: attemptId, fence: 9 }, ref: 'stop-proof:p:f' });
    assert.throws(() => release(t, { ref: otherFence }), { code: 'DENIED' }, 'the fence must match');
    const otherMember = proofRow(t, { subject: { kind: 'member-session', id: 'member:zzz', fence: 1 }, ref: 'stop-proof:p:m' });
    assert.throws(() => release(t, { ref: otherMember }), { code: 'DENIED' }, 'the proof names another member');
    // F4: a row that was not written by the adapter is not evidence, whoever cites it.
    const forged = proofRow(t, { subject: { kind: 'attempt', id: attemptId, fence: 1 }, writtenBy: 'root', ref: 'stop-proof:p:r' });
    assert.throws(() => release(t, { ref: forged }), { code: 'DENIED' }, 'an owner cannot write its own stop proof');
    assert.throws(() => release(t, { ref: forged, actor: 'member:root' }), { code: 'DENIED' });
    assert.equal(t.store.read(attemptId).lease, 'unknown', 'nothing moved');
  } finally { t.close(); }
});

test('confirmStopped keeps the operator path and gates the adapter path on the switch', () => {
  const on = team('confirm-on', { configuration: { autonomy: 'on' } });
  const off = team('confirm-off');
  try {
    const a = unknownAttempt(on);
    const ref = proofRow(on, { subject: { kind: 'attempt', id: a, fence: 1 } });
    confirmStopped(on.core, a, ref, 'adapter');
    assert.equal(on.store.read(a).lease, 'revoked');

    const rootOnly = unknownAttempt(on, 'attempt:root-only');
    assert.throws(() => confirmStopped(on.core, rootOnly, proofRow(on, {
      subject: { kind: 'attempt', id: rootOnly, fence: 1 }, ref: 'stop-proof:p:root-only' }), 'member:root'),
    { code: 'DENIED' });

    // The switch off: exactly the behaviour of the control arm -- operator only.
    const b = unknownAttempt(off);
    assert.throws(() => confirmStopped(off.core, b, 'evidence:stop', 'adapter'), { code: 'DENIED' });
    confirmStopped(off.core, b, 'evidence:stop', 'operator');
    assert.equal(off.store.read(b).lease, 'revoked');
  } finally { on.close(); off.close(); }
});

test('the proof close-out still runs while a completion token freezes the team (F24 stays open)', () => {
  const t = team('frozen', { configuration: { autonomy: 'on' } });
  try {
    const attemptId = unknownAttempt(t);
    const ref = proofRow(t, { subject: { kind: 'attempt', id: attemptId, fence: 1 } });
    t.core.mutate('completion:x', 'scheduler', {}, tx => tx.put('completion:x', { status: 'prepared' }));
    assert.throws(() => t.core.task('task:z', 'member:root', []), { code: 'COMPLETION_FROZEN' }, 'business writes are frozen');
    // attempt.release is one of the safe commands: the stop still has to be able to land during the freeze.
    release(t, { ref });
    assert.equal(t.store.read(attemptId).lease, 'revoked');
    assert.equal(t.store.read('completion:x').status, 'prepared', 'the token is untouched by the close-out');
  } finally { t.close(); }
});

test('a verified cancel retires the member, keeps the proof row and opens no decision (F1)', async () => {
  const t = team('native-verified', { configuration: { autonomy: 'on' }, ports: {
    cancel: async () => ({ stopped: true, pid: 4242, createdAt: 'filetime:7', image: 'node.exe' }),
    stopProof: async ({ subject, roots, graceMs, proofTimeoutMs }) => ({ kind: 'stop-proof', subject, method: 'taskkill-tree',
      roots, reaped: [{ pid: roots[0].pid, exitCode: 0, at: Date.now() }], descendantsAfter: 0, polls: 3,
      emptySince: Date.now(), verified: true, confidence: 'high', at: Date.now(),
      tool: 'taskkill /PID ' + roots[0].pid + ' /T /F', error: null, budgets: { graceMs, proofTimeoutMs } }),
  } });
  try {
    const a=unknownAttempt(t);
    const original=t.core.ports.stopProof;
    t.core.ports.stopProof=async request=>({...await original(request),...certificate(t.core,request.subject,{attemptId:a})});
    await applyLifecycle(t.core, 'member:w', 'cancel');
    const member = t.store.read('member:w');
    assert.equal(member.status, 'frozen');
    assert.ok(member.lastStopProof, 'the member names the proof that let it go');
    const proof = t.store.read(member.lastStopProof);
    assert.equal(proof.kind, 'stop-proof');
    assert.equal(proof.verified, true);
    assert.equal(proof.writtenBy, 'adapter');
    assert.equal(proof.switch, 'on');
    assert.deepEqual(proof.subject, { kind: 'member-session', id: 'member:w', fence: 1 });
    assert.equal(proof.reaped.length, 1);
    assert.equal(t.store.list('decision:').length, 0, 'a proven stop needs nobody');
    const intent = t.store.read('native-intent:member:w');
    assert.equal(t.store.effects().find(effect => effect.id === intent.effectId).status, 'confirmed', 'the effect settled');
  } finally { t.close(); }
});

test('an unproven cancel keeps the member unknown, holds its lease and opens one stuck-member decision (F2)', async () => {
  const t = team('native-unproven', { configuration: { autonomy: 'on' }, ports: {
    // The session runs inside the host process: the port can say it asked, but not that a process died.
    cancel: async () => ({ stopped: true }),
  } });
  try {
    const attemptId = unknownAttempt(t, 'attempt:hold');
    await applyLifecycle(t.core, 'member:w', 'cancel');
    const member = t.store.read('member:w');
    assert.equal(member.status, 'unknown', 'never retired on a timeout');
    assert.equal(member.responsible, 'operator');
    assert.equal(member.observed, 'unknown');
    assert.equal(t.store.read(attemptId).lease, 'unknown', 'a lease is not released before the stop is proven (§2.2.4)');
    const proof = t.store.read(member.lastStopProof);
    assert.equal(proof.verified, false);
    assert.equal(proof.error.code, 'STOP_CAPABILITY_MISSING');
    assert.equal(proof.method, 'session-dispose');
    const decisions = t.store.list('decision:');
    assert.equal(decisions.length, 1, 'the escalation is a row, not a note');
    const decision = decisions[0];
    assert.equal(decision.kind, 'stuck-member');
    assert.deepEqual(decision.options, ['wait']);
    assert.deepEqual(decision.subject, { type: 'member', id: 'member:w', revision: member.revision },
      'the row names the revision the member has now, so the operator verdict is not stale on arrival');
    assert.equal(decision.evidence[0].ref, proof.entityId);
    // The operator (and the owner) can take it: the verdict lands on the revision the row was opened against.
    t.core.decideDecision(decision.entityId, 'member:root', { decision: 'wait', reason: 'operator has the machine' });
    assert.equal(t.store.read(decision.entityId).state, 'decided');
  } finally { t.close(); }
});

test('a lifecycle port that throws is an unproven stop too, not a silent unknown', async () => {
  const t = team('native-error', { configuration: { autonomy: 'on' }, ports: {
    cancel: async () => { throw Object.assign(new Error('the adapter refused'), { code: 'STOP_NOT_CONFIRMED' }); },
  } });
  try {
    await applyLifecycle(t.core, 'member:w', 'cancel');
    const member = t.store.read('member:w');
    assert.equal(member.status, 'unknown');
    const proof = t.store.read(member.lastStopProof);
    assert.equal(proof.verified, false);
    assert.equal(proof.error.code, 'STOP_CAPABILITY_MISSING');
    assert.equal(t.store.list('decision:').length, 1);
  } finally { t.close(); }
});

test('with the switch off the lifecycle behaves exactly as before: no proof row, no decision', async () => {
  const t = team('native-off', { ports: { cancel: async () => ({ stopped: true }) } });
  try {
    await applyLifecycle(t.core, 'member:w', 'cancel');
    const member = t.store.read('member:w');
    assert.equal(member.status, 'frozen');
    assert.equal(member.lastStopProof ?? null, null);
    assert.equal(t.store.list('stop-proof:').length, 0);
    assert.equal(t.store.list('decision:').length, 0);
  } finally { t.close(); }
});
