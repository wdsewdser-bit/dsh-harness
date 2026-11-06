import { expireIntents } from './expire-intents.mjs';
import { expireIntents as closeExpiredIntents } from './intents.mjs';

/**
 * The clock: lease expiry, responsibility deadlines and lifecycle-intent timeouts, in one transaction.
 *
 * expireIntents is imported rather than copied so the tick path and the profile driver apply exactly one rule for an
 * intent no driver settled.
 */
function expireAttempts(tx, command) {
 const now = command.now ?? command.payload.now;
 let changed = 0;
 for (const attempt of tx.list('attempt:')) if (attempt.lease === 'active' && attempt.expiresAt <= now) {
  tx.put(attempt.entityId, { ...attempt, lease: 'unknown', status: 'unknown', responsible: 'operator', reason: 'lease expired without stop evidence', lastEvidence: null, nextReviewAt: now + 60000 });
  tx.outbox('cancel:' + attempt.entityId, { kind: 'cancel', attemptId: attempt.entityId }); changed++;
 }
 return { changed };
}
function tick(tx, command) {
  const { timeoutMs } = command.payload;
  const now = command.now ?? command.payload.now;
  expireIntents(tx, now, timeoutMs);
  // §4.5: an intent window that runs out with no objection passes. The clock owns the only timer, and the closing
  // facts (decision, closedAt, seenAtClose) are written in this same transaction; nothing escalates to the operator.
  closeExpiredIntents(tx, now);
  expireAttempts(tx, command);
  for (const entity of [...tx.list('thread:'), ...tx.list('message:'), ...tx.list('wait:')]) {
    // §3.2/§3.4: a resource thread has no deadline and no automatic escalation -- it is a topic, not an unanswered
    // review, and its open status must neither decay into an operator escalation nor block the goal. Decision threads
    // keep HEAD's deadline rule exactly. v1 intents are excluded from the M2b close inside intents.expireIntents.
    if (entity.kind === 'resource') continue;
    if (entity.deadline && Date.parse(entity.deadline) <= now &&
      ['collecting', 'stored', 'visible', 'pending'].includes(entity.status)) {
      tx.put(entity.entityId, { ...entity, status: entity.dependency ? 'timed-out' : 'escalated',
        escalatedAt: now, responsible: entity.escalationOwner ?? 'operator' });
    }
  }
  return tx.put('clock', { now });
}

export const clockCommands = { 'clock.tick': tick, 'clock.expire-attempts': expireAttempts };
