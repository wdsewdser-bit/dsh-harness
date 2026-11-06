import { failWith, id } from '../../contracts/index.mjs';
import { preflightCommand } from './preflight.mjs';

/**
 * Managed in-flight tokens; docs/host-protocol.md §2.1 rule 3 and invariant 9 rule 3.
 *
 * A token is bound to exactly one dispatch: the operationId, the completing command, the target entity and the actor.
 * It is not a licence for "any business write": authorization compares all four against the request, so a token can
 * only carry its own operation's receipt. Managed operations also have a completion notification, which is what lets
 * stop() wait for real work instead of relying on some unrelated hook being busy.
 */
/**
 * Open a managed operation. The token is bound to one dispatch, and opening it runs the same authorization as
 * dispatching that command: a closed admission cannot mint a token that bypasses it.
 */
export function openManagedOperation({ gateway, inflight, authorize, spec = {}, state, epoch, now }) {
  const { operationId, command, entityId, actor, label = 'effect' } = spec;
  if (state !== 'running') failWith('HOST_NOT_RUNNING', 'in-flight tokens open only while running, got ' + state);
  for (const [name, value] of [['operationId', operationId], ['command', command], ['entityId', entityId], ['actor', actor]]) {
    if (typeof value !== 'string' || !value) failWith('INVALID_INFLIGHT', 'openInflight needs a non-empty ' + name);
  }
  // The same preflight the gateway runs before dispatch: class, in-flight channel flag and the command's principal.
  // A rejected preflight throws before inflight.open(), so no token is minted.
  preflightCommand({ entry: gateway.describe(command), command, actor, inflight: true });
  authorize('business', {}, {}, { command, entityId, operationId, actor });
  return inflight.open({ label, epoch, now, operationId, command, entityId, actor });
}

export class InflightRegistry {
  #records = new Map();
  #opened = 0;
  #completed = 0;

  open({ label = 'effect', epoch, now = Date.now, operationId, command, entityId, actor } = {}) {
    if (typeof operationId !== 'string' || !operationId) failWith('INVALID_INFLIGHT', 'a managed operation needs an operationId');
    if (typeof command !== 'string' || !command) failWith('INVALID_INFLIGHT', 'a managed operation needs the command that closes it');
    if (typeof entityId !== 'string' || !entityId) failWith('INVALID_INFLIGHT', 'a managed operation needs a target entity');
    if (typeof actor !== 'string' || !actor) failWith('INVALID_INFLIGHT', 'a managed operation needs the actor that opened it');
    const token = Object.freeze({
      id: id('inflight'), label: String(label), epoch, at: now(), operationId, command, entityId, actor,
    });
    let settle = null;
    const done = new Promise(resolve => {
      settle = resolve;
    });
    const record = {
      token,
      done,
      completed: false,
      settle,
      complete: () => {
        if (record.completed) return false;
        record.completed = true;
        this.#completed += 1;
        this.#records.delete(token);
        record.settle();
        return true;
      },
    };
    this.#opened += 1;
    this.#records.set(token, record);
    return { token, close: () => record.complete() };
  }

  has(token) {
    const record = token ? this.#records.get(token) : null;
    return Boolean(record) && !record.completed;
  }

  /** Resolves when every managed operation still open has completed; null when nothing is pending. */
  pending() {
    if (this.#records.size === 0) return null;
    return Promise.all([...this.#records.values()].map(record => record.done));
  }

  /** Counters for the stop result: opened, completed, and how many were still open. */
  stats() {
    return { opened: this.#opened, completed: this.#completed, open: this.#records.size };
  }

  get size() {
    return this.#records.size;
  }

  /** Revoke what is still open without counting it as completed; waiters are released so nobody hangs. */
  clear() {
    for (const record of [...this.#records.values()]) {
      record.completed = true;
      record.settle();
    }
    this.#records.clear();
  }
}
