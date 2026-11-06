import { fail } from '../../contracts/index.mjs';

/**
 * The one authority rule for a live execution lease (08 §4.2).
 *
 * The public read (TeamCore.authority) and every reducer that writes under a lease call this function, so "only the
 * current attempt, fence, generation and an active member may write" has exactly one owner. It takes a reader instead
 * of a core: inside a transaction the caller passes tx, outside it passes the store, and both are the same connection.
 */
export function leaseOf(tx, attemptId, fence, now = Date.now()) {
  const attempt = tx.read(attemptId);
  const member = tx.read(attempt?.owner);
  if (!attempt || attempt.lease !== 'active' || attempt.fence !== fence || attempt.expiresAt <= now ||
    member?.desired !== 'active' || member.generation !== attempt.generation) fail('INVALID_LEASE');
  return attempt;
}
