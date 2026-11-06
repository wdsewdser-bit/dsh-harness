import { failWith } from '../../contracts/index.mjs';
import { stoppedError } from './ports.mjs';

/** Lifecycle guards shared by start, stop and hook mounting; docs/host-protocol.md §2.1 rules 1-3. */

/** A cancelled start/recovery must stop between steps; stop() is the only caller that sets this. */
export function assertNotStopping(state, signal) {
  if (state === 'stopping' || state === 'stopped' || (signal && signal.aborted)) {
    throw stoppedError('start or recovery was cancelled by stop()');
  }
}

/**
 * Mounting has two separate moments, and only the second needs a live token:
 *   - registration: a composition root may register a hook before the host starts (state 'created' or 'starting'),
 *     when no lifecycle token exists yet; a failed start or a stopped host still refuses it;
 *   - activation: the hook fires only while the team runs, and each invocation gets a capability that re-checks the
 *     token, the epoch, the ownership and the write whitelist.
 */
export function assertMountable({ state, failed, token, epoch }) {
  if (failed) failWith('HOST_FAILED', 'the host failed to start (' + failed.code + '); hooks cannot be mounted');
  if (state === 'stopping' || state === 'stopped') failWith('HOST_STOPPED', 'hooks cannot be mounted after stop()');
  if (token) {
    if (token.revoked) failWith('WRITE_REVOKED', 'write eligibility was revoked; hooks cannot be mounted');
    if (epoch !== null && token.epoch !== epoch) failWith('STALE_EPOCH', 'the lifecycle token predates the current epoch');
  }
}