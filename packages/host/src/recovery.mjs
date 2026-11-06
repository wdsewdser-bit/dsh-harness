import { stoppedError } from './ports.mjs';

/**
 * One recovery pass; docs/host-protocol.md §2.1 rule 6 and invariant 7 rule 9.
 * The recoverer only ever sees the controlled capability. Its result is returned to the caller; writing it into the
 * host is the caller's job, because only the caller knows whether the stop budget already isolated this run.
 */
export async function recoverOnce({ recoverer, teamId, dir, epoch, capability, signal, now }) {
  if (typeof recoverer !== 'function') {
    // No recovery consumer in M1a: report the missing capability instead of a clean team.
    return Object.freeze({ status: 'skeleton', admission: false, capability: 'recover-not-implemented', at: now() });
  }
  const out = await recoverer({ teamId, dir, epoch, signal, capability });
  return Object.freeze({
    status: (out && out.status) || 'ok',
    admission: out?.admission === true,
    capability: out?.capability ?? null,
    at: now(),
  });
}

/** After the recoverer returns: an isolated or cancelled run may not write its conclusion. */
export function assertNotCancelled({ isolated, revoked, signal }) {
  if (isolated) throw stoppedError('recovery finished after the stop budget expired; its result is isolated');
  if (revoked) throw stoppedError('recovery was cancelled by stop()');
  if (signal && signal.aborted) throw stoppedError('recovery was cancelled by stop()');
}
