import { failWith } from '../../contracts/index.mjs';

/**
 * Command authorization; docs/host-protocol.md §2.4, invariant 1 rule 3, invariant 5 rules 1-2, invariant 7 rule 3.
 *
 * Four classes with four different bars, never one shared "the host is up" check:
 *   business  - running, admission open, ownership held, no failed start;
 *   recovery  - the recovering phase only (recovery commits happen before admission exists);
 *   operator  - running or recovering, whatever admission says: a local unknown must be actionable without freezing
 *               the whole team (spec 250-258, 432). A command that needs a frozen or maintenance state enforces that
 *               in its own rule; admission is never used as a stand-in for permission.
 *   inflight  - the receipt of one managed operation: a live token of this epoch whose operationId, command, target
 *               entity and actor all match the request, during running or stopping.
 */
export const COMMAND_KINDS = Object.freeze(['business', 'recovery', 'operator', 'inflight']);

export function createCommandAuthorization(host) {
  return (kind, request, options = {}, facts = {}) => {
    if (!COMMAND_KINDS.includes(kind)) failWith('INVALID_COMMAND', 'unknown command kind ' + JSON.stringify(kind));
    const failure = host.failure();
    // A failed start is the primary reason a business write is refused; ownership is the secondary one.
    if (kind === 'business' && failure) {
      failWith('HOST_FAILED', 'the host failed to start (' + failure.code + ' at ' + failure.stage + ') and takes no business write until stop()');
    }
    const ownership = host.ownership();
    if (!ownership.ok) {
      failWith('OWNERSHIP_LOST', 'the host does not hold the team lock (' + (ownership.reason || 'unknown') + ')');
    }
    const state = host.state();
    if (kind === 'business') {
      if (state !== 'running') failWith('HOST_NOT_RUNNING', 'business commands are refused while the host is ' + state);
      if (!host.admission()) failWith('ADMISSION_CLOSED', 'admission is closed: no recovery conclusion has opened it');
      return;
    }
    if (kind === 'recovery') {
      if (state !== 'recovering') failWith('RECOVERY_WINDOW_CLOSED', 'recovery commands are only accepted while recovering, got ' + state);
      return;
    }
    if (kind === 'operator') {
      if (state !== 'running' && state !== 'recovering') {
        failWith('OPERATOR_NOT_ALLOWED', 'operator commands need a running or recovering host, got ' + state);
      }
      return;
    }
    const token = options.inflight;
    if (!host.isManagedInflight(token)) failWith('INFLIGHT_UNKNOWN', 'the receipt does not match a managed in-flight token');
    if (token.epoch !== host.epoch()) failWith('STALE_EPOCH', 'the in-flight token belongs to epoch ' + token.epoch + ', the host is at ' + host.epoch());
    if (token.operationId !== facts.operationId) {
      failWith('INFLIGHT_MISMATCH', 'this token carries operation ' + token.operationId + ', not ' + String(facts.operationId));
    }
    if (token.command !== facts.command) failWith('INFLIGHT_MISMATCH', 'this token closes ' + token.command + ', not ' + String(facts.command));
    if (token.entityId !== facts.entityId) failWith('INFLIGHT_MISMATCH', 'this token targets ' + token.entityId + ', not ' + String(facts.entityId));
    if (token.actor !== facts.actor) failWith('INFLIGHT_MISMATCH', 'this token was opened by ' + token.actor);
    if (state !== 'running' && state !== 'stopping') failWith('HOST_NOT_RUNNING', 'in-flight receipts need a running or stopping host, got ' + state);
  };
}
