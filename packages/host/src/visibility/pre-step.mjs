import { snapshot, batchCandidate } from '../../../core/index.mjs';
/** Candidate generation is read-only; binding is deferred until committed. */
export function prepareVisibility(core, memberId) {
  const candidate = snapshot(core, memberId);
  return candidate && structuredClone(candidate);
}

/**
 * S3 (§5.2 rule 3): the natural-boundary candidate for a v1 member.
 *
 * Read-only, exactly like prepareVisibility: the batch is built from committed rows inside the session's serial
 * queue, and nothing is consumed or injected here. rotation is the arbiter's batch counter, which orders the
 * resource class and keeps an old resource event from being starved by a human flood.
 */
export function prepareBatch(core, memberId, options = {}) {
  const candidate = batchCandidate(core, memberId, options);
  return candidate && structuredClone(candidate);
}
