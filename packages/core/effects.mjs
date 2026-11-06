import { fail, stopProofCovers } from '../contracts/index.mjs';
import { autonomyOn } from './authority.mjs';
import { releaseAttempt } from './commands/release.mjs';

/** Apply durable effects via adapter ports, never hold a transaction across await; 08 §2.2. */
export async function applyEffect(core, effectId, owner = 'adapter', now = Date.now()) {
  const pending = core.store.effects().find(effect => effect.id === effectId);
  if (pending?.payload.kind === 'start') {
    try { core.authority(pending.payload.attemptId, pending.payload.fence, now); }
    catch {
      return core.store.effect(core.command('effect:' + effectId, owner, { stale: true }), effectId,
        effect => ({ ...effect, status: 'cancelled', reason: 'stale admission fence' }));
    }
  }
  const claim = core.store.claim(core.command('effect:' + effectId, owner, { action: 'claim', now }),
    effectId, owner, now).result;
  const port = core.ports[claim.payload.kind];
  let evidence;
  try {
    if (!port) fail('MISSING_ADAPTER_PORT');
    const receipt = await port({ ...claim.payload, operationId: effectId });
    evidence = { executed: true, receipt };
  } catch (error) {
    // An exception cannot establish that the native effect did not happen.
    evidence = { reason: error.message };
  }
  return core.store.settle(core.command('effect:' + effectId, owner, { evidence }), effectId, claim.fence, evidence);
}

/** List ambiguous native/control effects for an operator, not a model tool; 08 §2.2. */
export function unknowns(core) {
  return { effects: core.store.effects().filter(effect => effect.status === 'unknown'),
    attempts: core.store.list('attempt:').filter(attempt => attempt.lease === 'unknown') };
}

/**
 * Release an ambiguous lease only on explicit stop evidence; 08 §4.2, team-autonomy §7.2.4.
 *
 * The operator principal stays exactly as it was (F5: no regression), and with the switch on the host adapter may close
 * the same lease on a verified stop-proof row instead. The row is re-read inside the transaction, so the proof a caller
 * cites is the proof that exists, and it must name this attempt or the member generation that owned it.
 */
export function confirmStopped(core, attemptId, evidenceRef, actor, metadata = {}) {
  const operator = actor === 'operator' && typeof evidenceRef === 'string' && Boolean(evidenceRef);
  const adapter = autonomyOn(core) && actor === 'adapter';
  if (!operator && !adapter) fail('DENIED');
  // execute/store.commit replay the durable receipt before entering this reducer (including CAS and NOT_UNKNOWN).
  // Keep the four-argument payload/authority unchanged; the caller's revision is transaction-local admission metadata.
  return core.mutate(attemptId, actor, { evidenceRef }, (tx, attempt) => {
    if (metadata.expectedRevision !== undefined && (!Number.isSafeInteger(metadata.expectedRevision) ||
        metadata.expectedRevision < 0 || attempt?.revision !== metadata.expectedRevision)) fail('CAS_CONFLICT');
    if (attempt.lease !== 'unknown') fail('NOT_UNKNOWN');
    if (!operator) {
      const row = typeof evidenceRef === 'string' ? tx.read(evidenceRef) : null;
      const covers = stopProofCovers(row, { kind: 'attempt', id: attemptId, fence: attempt.fence }) ||
        stopProofCovers(row, { kind: 'member-session', id: attempt.owner, fence: attempt.generation });
      if (!covers) fail('DENIED');
    }
    releaseAttempt(tx, { attemptId, fence: attempt.fence, evidenceRef, actor, revoked: true, status: 'cancelled', taskStatus: 'failed', taskLast: true });
    return tx.read(attempt.taskId);
  }, { operationId: metadata.operationId });
}
