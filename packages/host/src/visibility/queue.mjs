/**
 * Serialize candidate work and evidence commits per execution session. No transaction crosses await.
 *
 * S3 (§5.2 rule 3): a batch is prepared and its evidence committed inside this same serial queue, keyed by the
 * session that carried the request. The owner path uses the owner session id as its key, so an owner batch can never
 * interleave with a member batch of the same host, and two sessions never serialize each other.
 */
export function createVisibilityQueue() {
  const tails = new Map();
  return (sessionId, work) => {
    const next = (tails.get(sessionId) ?? Promise.resolve()).then(work);
    const tail = next.catch(() => {});
    tails.set(sessionId, tail);
    tail.then(() => { if (tails.get(sessionId) === tail) tails.delete(sessionId); });
    return next;
  };
}

/** S3: the same serial discipline, named for the input path (member session or owner session). */
export const createInputQueue = createVisibilityQueue;
