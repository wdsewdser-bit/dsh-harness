import { fail, failWith } from '../../contracts/index.mjs';
import { assumptionCommands } from './assumptions.mjs';
import { clockCommands } from './clock.mjs';
import { decisionCommands } from './decisions.mjs';
import { deliveryCommands } from './delivery.mjs';
import { goalCommands } from './goals.mjs';
import { memberCommands } from './members.mjs';
import { recoveryCommands } from './recovery.mjs';
import { messageCommands } from './messages.mjs';
import { taskCommands } from './tasks.mjs';
import { threadCommands } from './threads.mjs';
import { threadEventCommands } from '../thread-events.mjs';
import { executionCommands } from './execution.mjs';

/**
 * The shared transactional reducer: reduceCommand(tx, command) (plan §5 M2, rule 2).
 *
 * A command is { type, actor, payload, cas? }. Every reducer behind the dispatch table reads and writes only the tx it
 * is handed, never commits, and never awaits: the caller owns the transaction and the receipt. Tools, the projection
 * API and TeamCore are translators: each one builds this object and calls the reducer inside its own store.commit.
 *
 * cas is the internal concurrency control of docs/host-protocol.md §2.4 and nothing else: it is the revision the caller
 * read for one row, checked inside the same transaction as the write. It never enters the external request identity.
 * The check itself is one pre-step in the public reduceCommand (core/index.mjs), not a per-reducer concern.
 */

export const commandReducers = Object.freeze({
  ...assumptionCommands,
  ...clockCommands,
  ...decisionCommands,
  ...deliveryCommands,
  ...goalCommands,
  ...memberCommands,
  ...messageCommands,
  ...recoveryCommands,
  ...taskCommands,
  ...threadCommands,
  // §3.1 (P1): resource threads and their events live in one reducer file of their own, beside the decision threads
  // they share the id space with, so the fan-out and the wake effects are written by the same transactional writer.
  ...threadEventCommands,
  ...executionCommands,
});

/**
 * The row revision the caller read must still be current; a missing row is the same refusal.
 *
 * cas.message exists for one caller: the projection entry reproduces the bare CAS_CONFLICT code its commit proxy
 * threw at HEAD, while the model tool path and every other caller keep the ref-suffixed code.
 */
export function assertCas(tx, cas) {
  const row = tx.read(cas.ref);
  if (!row || (cas.revision !== undefined && row.revision !== cas.revision)) fail(cas.message ?? 'CAS_CONFLICT:' + cas.ref);
}

/**
 * Dispatch one domain command. CAS is applied by the public pre-step in core/index.mjs, before this table is
 * consulted, so every command (the admission gate included) is checked exactly once.
 * Admission-only commands (the scheduling gate) are composed in core/index.mjs.
 *
 * TRUSTED INTERNAL INTERFACE. The command object carries more than domain data: `cas` (a revision prediction) and
 * `payload.policy` / `payload.entry` (which admission and which receipt a write uses). Those fields must only ever be
 * written by a trusted entry — the tool translator, mailbox/threads/delivery translators, or TeamCore — never by
 * spreading an external request body into a command. A host adopting the reducer must keep its own admission checks in
 * front of it and map requests through a translator; forwarding a request as a command would let the request choose a
 * weaker admission than its entry selected (docs/decisions/M2a-shared-reducer.md §7.13, §7.16, §7.18).
 */
export function reduceCommand(tx, command) {
  if (!command || typeof command.type !== 'string') fail('INVALID_COMMAND');
  if (Object.hasOwn(threadEventCommands, command.type) && command.intentProtocol !== 'root-decision-v1') {
    failWith('PROTOCOL_UNSUPPORTED', 'resource thread commands require the v1 protocol');
  }
  const reduce = commandReducers[command.type];
  if (typeof reduce !== 'function') fail('UNKNOWN_COMMAND:' + command.type);
  return reduce(tx, command);
}

/** Types this layer can execute, for the host gateway and for tests that want to look before they write. */
export const commandTypes = Object.freeze(Object.keys(commandReducers));
