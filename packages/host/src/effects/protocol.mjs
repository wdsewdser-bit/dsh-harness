import { STOP_PROOF_KIND, fail, stopProofCovers, sameExecution } from '../../../contracts/index.mjs';
import { openDecision, releaseAttempt, reduceCommand, canCloseExecution, canFinishStoppedGeneration, stoppedTransitionMatches, closeExecution, closeStoppedGeneration } from '../../../core/index.mjs';
export function evidenceOf(value, error = null) {
 if (error) return { unknown: true, reason: String(error.message ?? error) };
 if (!value || typeof value !== 'object') return { unknown: true, reason: 'missing evidence' };
 // R9: deferred is a scheduling outcome, not an execution failure. It is a state of its own here and in the ledger -
 // folding it into notExecuted would spend a try on a wait, and folding it into unknown would leave a maintenance
 // delivery for the operator.
 const states = ['executed', 'notExecuted', 'deferred', 'unknown'].filter(k => value[k] === true);
 if (states.length !== 1) return { unknown: true, reason: 'ambiguous evidence' };
 return structuredClone(value);
}
/** The runner's finite field policy; callers cannot supply a reducer. */
/**
 * P5 §7.2.1/§7.2.4: the durable row a stop claim is checked against, written inside the transaction that decides.
 *
 * The subject and the provenance are the host's, never the receipt's: a proof that names another member, generation or
 * kind cannot be relabelled into this one -- it is written as verified:false, which is exactly what a close-out has to
 * see to refuse the retirement. The row is kept either way, because "this stop was not proven" is evidence too.
 */
function stopProofRow(tx, subject, proof) {
  const row = proof && typeof proof === 'object' ? { ...proof } : {};
  const named = proof && typeof proof === 'object' ? proof.subject ?? null : null;
  const sameSubject = Boolean(named) && named.kind === subject.kind && named.id === subject.id && named.fence === subject.fence;
  const attempts = tx.list('attempt:').filter(a => ['active','unknown'].includes(a.lease) &&
    (subject.kind === 'attempt' ? a.entityId === subject.id && a.fence === subject.fence : a.owner === subject.id && a.generation === subject.fence));
  const verified = sameSubject && (subject.kind==='member-session'?canFinishStoppedGeneration(tx,row,subject.id,subject.fence):canCloseExecution(tx,row,attempts));
  const at = Date.now();
  const base = 'stop-proof:' + subject.id + ':' + subject.fence + ':';
  return tx.put(base + (tx.list(base).length + 1), { ...row, kind: STOP_PROOF_KIND, subject, verified,
    writtenBy: 'adapter', switch: 'on', at: Number.isFinite(row.at) ? row.at : at,
    confidence: verified ? row.confidence ?? 'low' : 'low',
    error: verified ? row.error ?? null
      : row.error ?? { code: 'STOP_NOT_VERIFIED', message: sameSubject ? 'the platform did not verify this stop'
        : 'the receipt carries no stop proof for ' + subject.id + ' at generation ' + subject.fence } });
}

/**
 * Close one effect out; §7.2.5, F1.
 *
 * `options.autonomy` is the composition's switch, passed by the one caller that owns it (core-access). It is never read
 * from a payload: with the switch off this function is exactly what it was before the autonomy package existed.
 */
/**
 * Review 2 #3: did this effect's subject leave before the effect could run?
 *
 * A released (or revoked) attempt can never be started or dispatched again, so an effect bound to it did NOT execute -
 * that is a known fact, not an unproven one. 'unknown' is deliberately not included: an attempt whose lease was lost is
 * exactly the case where nothing is known, and it must keep going to the operator.
 */
function releasedBeforeRun(tx, attemptId) {
  const attempt = tx.read(attemptId);
  if (!attempt) return false;
  return attempt.lease !== 'active' && attempt.lease !== 'unknown';
}

/**
 * Review 1 #2: close every attempt the proven stop covers.
 *
 * `releaseAttempt` is the product's own close-out, so the attempt, its task, its pending waits and the run slot the
 * store keeps for a held lease all move together (§7.2.4: a proof for the member generation releases what it owned).
 * The failure branch never reaches here: an unproven stop keeps every lease exactly as it was.
 */


export function closeEffect(tx, effect, evidence, registration, options = {}) {
 const p = effect.payload;
 if(options.autonomy===true && evidence.executed===true && ['dispose','cancel-member'].includes(p.kind) && stoppedTransitionMatches(tx,evidence.receipt?.stopProof,p.memberId,p.generation,p.kind))return;
 if(options.autonomy===true && p.kind==='cancel'){
  const proof=evidence.receipt?.stopProof,row=proof?.E&&tx.read('execution-scope:'+proof.E.executionEpoch);
  if(evidence.executed===true && row?.state==='RELEASED' && sameExecution(row.E,proof.E) && row.E.attemptId===p.attemptId &&
     row.stopId===proof.stopId && row.consumedCertificate===proof.certificateId && row.closeoutResult?.proof?.scopeVersion===proof.scopeVersion &&
     ['cancel','retire'].includes(row.closeoutResult?.purpose))return;
 }
 /**
  * Review 1 #4 / review 2 #3: one narrow exception to the revision defence, and only one.
  *
  * A start (and the dispatch a start wrote) is registered against the attempt row, and the mailbox hand-over releases
  * that attempt in the very transaction that admits the work task. The release necessarily moves the revision the
  * registration froze, so the strict check below answered STALE_EFFECT_SUBJECT and left the effect applying - it said
  * "someone else changed this row", which is exactly what did not happen: the change IS the release this close-out is
  * about. When, and only when, the effect's own attempt is now definitely released (not active, not unknown), that one
  * row is let through to the cancellation branch. Every other revision change still refuses, and an unknown lease still
  * refuses: an unknown attempt is not proof that anything did not run.
  */
 const boundAttempt = (p.kind === 'start' || p.kind === 'dispatch') && p.attemptId ? tx.read(p.attemptId) : null;
 const released = Boolean(boundAttempt) && boundAttempt.lease !== 'active' && boundAttempt.lease !== 'unknown';
 for (const [id, revision] of registration.revisions) {
  if ((tx.read(id)?.revision ?? 0) === revision) continue;
  if (released && id === p.attemptId) continue;
  fail('STALE_EFFECT_SUBJECT');
 }
 // R9: a deferred effect executed nothing, so it must not touch its subject: not the lifecycle member status (that path
 // is for an unknown refusal), and not any success-only reducer.
 if (evidence.deferred) return;
 if (!evidence.executed) {
  // Review 2 #3: the mailbox hand-over releases a wake attempt in the same transaction that admits the work task, so a
  // start (or the dispatch a start wrote) can be claimed afterwards and refused with INVALID_LEASE. The attempt is gone:
  // the effect is CANCELLED here, not left unknown, because an unknown blocks the goal gate's own effect check on a
  // cancellation the product ordered on purpose.
  //
  // "Cancelled" is a claim about the past - this never ran - so it is made only on a DEFINITE non-execution
  // (evidence.notExecuted). An unknown evidence says the lease cannot run now, not that it never did; folding the two
  // together would close an execution nobody can account for, and it would look exactly like a proven cancellation.
  if (evidence.notExecuted && (p.kind === 'start' || p.kind === 'dispatch') && releasedBeforeRun(tx, p.attemptId)) {
   return { cancelled: true, reason: 'the attempt was released before its ' + p.kind + ' ran' };
  }
  if (!evidence.notExecuted && p.memberId && ['create', 'resume', 'dispose', 'cancel-member'].includes(p.kind)) {
   const m = tx.read(p.memberId);
   if (m) tx.put(p.memberId, { ...m, status: 'unknown', reason: evidence.reason ?? 'effect uncertain', responsible: 'operator' });
   if (p.intentId) tx.put(p.intentId, { ...tx.read(p.intentId), status: 'unknown', reason: evidence.reason ?? 'effect uncertain', responsible: 'operator' });
  }
  return;
 }
 if (p.kind === 'delivery') {
  if (tx.list('completion:').some(row=>['prepared','authorized','unknown'].includes(row.status))) fail('COMPLETION_FROZEN');
  const delivery = tx.read(p.deliveryId), command = evidence.receipt?.transition;
  if (!delivery || delivery.target !== p.target || delivery.revision !== p.deliveryRevision || !command || command.type !== 'delivery.transition' ||
    command.payload.deliveryId !== p.deliveryId || command.payload.revision !== delivery.revision || !['accepted','unknown'].includes(command.payload.status)) fail('STALE_DELIVERY_REVISION');
  reduceCommand(tx, { ...command, actor: 'root' });
 }
 if (p.kind === 'release-task') {
  const task = tx.read(p.taskId);
  if (!['cancelled', 'failed'].includes(p.status)) fail('DENIED');
  if (task?.status === 'executing' && task.attemptId === p.attemptId) tx.put(p.taskId, { ...task, status: p.status });
  else { tx.put('release-audit:' + effect.id, { status: 'superseded', attemptId: p.attemptId }); return { cancelled: true }; }
 }
 if (p.kind === 'cancel') {
  const a = tx.read(p.attemptId);
  if (!a) fail('MISSING_REFERENCE');
  if (options.autonomy === true) {
   // Review 1 #1 (blocker): with the switch on, an automatic execution stop is proven exactly like a member stop, and
   // this close-out may not use the operator's manual exemption. The proof row is written here, in the deciding
   // transaction, and it must name this attempt (or the member generation that owned it, §7.2.4). A receipt that only
   // says { stopped: true } - what the automatic path used to answer after agent.cancel() - is not a stop: the lease
   // stays unknown, its run slot stays occupied and the effect ends unproven, which is what hands it to a human.
   const named = evidence.receipt?.stopProof?.subject ?? null;
   const subject = named && (named.kind === 'attempt' || named.kind === 'member-session') && typeof named.id === 'string'
     ? { kind: named.kind, id: named.id, fence: named.fence } : { kind: 'attempt', id: p.attemptId, fence: a.fence };
   const written = stopProofRow(tx, subject, evidence.receipt?.stopProof);
   closeExecution(tx,{proof:written,evidenceRef:written.entityId,attempts:[a],status:'failed',purpose:'cancel'});
  } else {
   if (evidence.receipt?.stopped !== true || !evidence.receipt?.evidenceRef) fail('STOP_NOT_CONFIRMED');
   releaseAttempt(tx, { attemptId: p.attemptId, fence: a.fence, revoked: true, status: 'failed', actor: 'operator', evidenceRef: evidence.receipt.evidenceRef });
  }
 }
 if (['create', 'resume', 'dispose', 'cancel-member'].includes(p.kind)) {
  const m = tx.read(p.memberId);
  if (!m || m.generation !== p.generation) fail('STALE_NATIVE_GENERATION');
  const stopped = ['dispose', 'cancel-member'].includes(p.kind);
  // P5 §7.2.4/§7.2.5: with the switch on, "stopped" is a VERIFIED PROOF for this member at this generation, and nothing
  // else. A receipt that merely says { stopped: true } -- a port that never waited for the turn, a proof taken for another
  // subject -- is not a stop: the member goes unknown with the operator responsible, its leases are left exactly as they
  // are (no generation is advanced, nothing is released), and one stuck-member row hands it to a human (§12 U8).
  let stopProofRef = null;
  if (stopped && options.autonomy === true) {
   const written = stopProofRow(tx, { kind: 'member-session', id: p.memberId, fence: p.generation }, evidence.receipt?.stopProof);
   stopProofRef = written.entityId;
   if (!written.verified) {
    const at = Date.now();
    const ttlMs = Number.isSafeInteger(options.decisionTtlMs) ? options.decisionTtlMs : 900000;
    const reason = written.error?.message ?? 'the stop could not be proven';
    const decision = openDecision(tx, { autonomy: 'on', now: at, decisionTtlMs: ttlMs }, {
      kind: 'stuck-member', subject: { type: 'member', id: p.memberId, revision: m.revision + 1 },
      evidence: [{ at, kind: 'stop-proof', ref: written.entityId, text: 'a ' + p.kind + ' could not be proven stopped: ' +
        (written.error?.code ?? 'STOP_NOT_VERIFIED') }], openedFor: 'operator', now: at, ttlMs, fallback: 'escalate' });
    const unknownRow = tx.put(p.memberId, { ...m, status: 'unknown', observed: 'unknown', responsible: 'operator', reason,
      lastStopProof: written.entityId, stopDecision: decision.entityId });
    if (p.intentId) tx.put(p.intentId, { ...tx.read(p.intentId), status: 'unknown', reason, responsible: 'operator' });
    return unknownRow;
   }
  } else if (stopped && evidence.receipt?.stopped !== true) fail('STOP_NOT_CONFIRMED');
  if (stopped && stopProofRef) closeStoppedGeneration(tx,p.memberId,p.generation,tx.read(stopProofRef),stopProofRef);
   tx.put(p.memberId, { ...m, generation: m.generation + 1, nativeRef: evidence.receipt?.nativeRef ?? m.nativeRef ?? null,
   // The row that let it go stays named on the member, exactly as native.mjs names its own (§7.2.1).
   ...(stopProofRef ? { lastStopProof: stopProofRef } : {}),
   desired: p.kind === 'dispose' ? 'retired' : stopped ? 'frozen' : 'active', observed: stopped ? 'stopped' : 'running', status: p.kind === 'dispose' ? 'retired' : stopped ? 'frozen' : 'active' });
  // Review 1 #2: the proof covers this member at this generation, so the resources that generation still holds are
  // closed with it, in this same transaction. Advancing the generation alone left the old attempts on an active or
  // unknown lease: they can never be resumed (the generation moved), yet each one still occupies the store's run slot,
  // so a restored or reassigned member would find its capacity held by a lease no later close-out would ever reach.

  if(stopped && stopProofRef)tx.put('member-stop-transition:'+p.memberId+':'+p.generation+':'+p.kind,{proof:tx.read(stopProofRef),memberId:p.memberId,generation:p.generation,kind:p.kind});
  if (p.intentId) tx.put(p.intentId, { ...tx.read(p.intentId), status: 'confirmed' });
 }
 if (p.kind === 'start') {
  const a = tx.read(p.attemptId);
  if (!a || a.fence !== p.fence || a.generation !== p.generation) fail('STALE_EFFECT_SUBJECT');
  // Review 2 #3, the other order: the turn can end and the release can land while this close-out is still in flight, so
  // the attempt is already released when the prepared receipt arrives. Failing here left the effect applying and turned
  // it into unknown later; the prepared execution belongs to an attempt that is gone, which is a cancellation.
  if (a.lease !== 'active') {
   if (a.lease === 'unknown' || a.status === 'unknown') fail('STALE_EFFECT_SUBJECT');
   return { cancelled: true, reason: 'the attempt was released while its start was in flight' };
  }
  if (evidence.receipt?.prepared !== true) fail('EXECUTION_NOT_PREPARED');
  const running = tx.put(p.attemptId, { ...a, status: 'running', executionSessionId: evidence.receipt.executionSessionId });
  // R5-2: the start prepared an execution; it never dispatched it. The first dispatch is its own durable fact, bound
  // to this attempt (one id per attempt, so a replay, a retry or a restart cannot open a second one) and executed by
  // the one wake consumer. Calling the driver from a receipt would put a second dispatcher beside the mailbox wake.
  tx.outbox('dispatch:' + p.attemptId, { kind: 'dispatch', attemptId: p.attemptId, recipient: running.owner,
   generation: running.generation, fence: p.fence });
 }
}
