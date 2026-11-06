import { failWith } from '../../contracts/index.mjs';

/**
 * Command preflight shared by both entry points: dispatching through the gateway and opening a managed in-flight
 * operation. Everything that does not depend on host state lives here, so the two paths cannot drift apart:
 *   - the command must exist in the trusted registry;
 *   - a command that declares a principal only accepts that principal;
 *   - the in-flight channel only accepts a business command the registry marks completion: 'inflight'.
 */
export function preflightCommand({ entry, command, actor, inflight = false }) {
  if (!entry) failWith('UNIMPLEMENTED_COMMAND', 'no trusted command is registered for ' + JSON.stringify(command));
  if (entry.actor && actor !== entry.actor) {
    failWith('ACTOR_NOT_AUTHORIZED', 'command ' + JSON.stringify(command) + ' belongs to the ' + entry.actor + ' principal');
  }
  if (inflight && (entry.kind !== 'business' || entry.completion !== 'inflight')) {
    failWith('INVALID_INFLIGHT', 'command ' + JSON.stringify(command) + ' cannot be closed through the in-flight channel');
  }
  return entry;
}
