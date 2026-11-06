import { failWith, id } from '../../contracts/index.mjs';

/**
 * The controlled capability handed to recovery and to hooks; docs/host-protocol.md §2.1 rule 3, invariant 9.
 *
 * A recoverer or a hook never receives a store, the gateway or an ownership handle. It receives this object, and every
 * method re-checks the lifecycle token, the epoch, the actual ownership and (for writes) the kind whitelist of its
 * scope. AbortSignal is cooperative cancellation only; eligibility is the barrier, so code that ignores the signal
 * still cannot write after stop().
 */
export function createLifecycleToken({ epoch, now }) {
  return { id: id('lifecycle'), epoch, revoked: false, reason: null, revokedAt: null, now };
}

export function revokeLifecycleToken(token, reason) {
  if (!token || token.revoked) return false;
  token.revoked = true;
  token.reason = reason;
  token.revokedAt = token.now();
  return true;
}

/** The single eligibility rule: token live, current, epoch-true, host state allowed and no failed start. */
export function assertWritable({ token, current, epoch, state, allowedStates, failure }) {
  if (failure) failWith('WRITE_REVOKED', 'the host failed to start (' + failure.code + ') and takes no writes until stop()');
  if (!token) failWith('WRITE_REVOKED', 'no lifecycle token: the host has not started');
  if (token.revoked) failWith('WRITE_REVOKED', 'the lifecycle token was revoked' + (token.reason ? ': ' + token.reason : ''));
  if (token !== current) failWith('WRITE_REVOKED', 'the capability belongs to an earlier lifecycle');
  if (epoch === null || token.epoch !== epoch) {
    failWith('STALE_EPOCH', 'the capability was issued for epoch ' + token.epoch + ' but the host is at ' + String(epoch));
  }
  if (!allowedStates.includes(state)) failWith('WRITE_REVOKED', 'writes are closed while the host is ' + state);
}

export function createCapability({ scope, token, teamId, dir, epoch, deps }) {
  const capability = {
    teamId,
    dir,
    scope,
    epoch,
    state: () => deps.state(),
    writable: () => {
      try {
        deps.assertWritable(token, scope);
        return true;
      } catch {
        return false;
      }
    },
    /** kind is whitelisted per scope; a scope cannot write outside its own kinds. */
    write: (kind, payload) => {
      deps.assertWritable(token, scope);
      return deps.write(kind, payload, scope);
    },
    /** The command class comes from the trusted registry, never from this capability. */
    command: request => {
      deps.assertWritable(token, scope);
      return deps.command(request, scope, token);
    },
  };
  return Object.freeze(capability);
}
