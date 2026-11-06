import { fail } from '../contracts/index.mjs';
import { authorize } from './authorization.mjs';
import { operatorCommand } from './operator-command.mjs';
import { reduceCommand } from './index.mjs';
import { auditedUiAdmission } from './commands/messages.mjs';

/**
 * Audited UI operations: unknown adjudication never changes delivery state or queues work.
 *
 * The verdict is operator-only in the strict sense (operatorOnly below): the literal 'operator' principal and nobody
 * else, root included. That is deliberate -- the operator adjudicates an unknown external effect, and root is a team
 * role, not the operator. A browser cannot authenticate as 'operator', so no logged-in viewer can submit a verdict;
 * the UI therefore shows these rows as operator work and never offers the command (see "unknown" in ui
 * ui.mjs). The refusal below is the rule, not a defect.
 *
 * This module is now only a translator and an admission gate: the three writes are message.cancel, message.rebind and
 * message.adjudicate in commands/messages.mjs (docs/decisions/M2a-shared-reducer.md).
 */
const TYPES = { 'mailbox.cancelMessage': 'message.cancel', 'mailbox.rebind': 'message.rebind',
  'mailbox.resolveUnknown': 'message.adjudicate' };

/**
 * Which audited commands select the UI admission. The other two (resolveUnknown, and every helper below) keep theirs.
 * The policy object is defined next to the reducers that apply it and is written *after* the request args, so a
 * request cannot choose or weaken an admission (docs/decisions/M2a-shared-reducer.md §7-2, §7-14, §7-16).
 */
const POLICIES = Object.freeze({
  'mailbox.cancelMessage': auditedUiAdmission,
  'mailbox.rebind': auditedUiAdmission,
});

export function submitMailbox(core, actor, command) {
  const type = TYPES[command.name];
  if (!type) fail('UNSUPPORTED_COMMAND');
  if (!command.target.startsWith('message:')) fail('INVALID_MESSAGE');
  return operatorCommand(core, actor, command, tx => {
    // A rebind names two rows, and HEAD checked both against this actor inside the same transaction. A missing ref is
    // left to the reducer's INVALID_REBIND so the refusal code keeps its original precedence.
    if (command.name === 'mailbox.rebind') {
      for (const ref of [command.args.recipient, command.args.evidenceRef]) {
        if (typeof ref === 'string' && ref) authorize(core, actor, ref);
      }
    }
    return reduceCommand(tx, { type, actor,
      payload: { ...command.args, messageId: command.target, operationId: command.operationId,
        policy: POLICIES[command.name] } });
  }, command.name === 'mailbox.resolveUnknown');
}

/** Rebind durable responsibility explicitly, retaining prior delivery history; 08 §4.4. */
export function rebindMessage(core, messageId, recipient, evidenceRef) {
  return core.mutate(messageId, 'operator', { recipient, evidenceRef }, tx => reduceCommand(tx,
    { type: 'message.rebind', actor: 'operator', payload: { messageId, recipient, evidenceRef } }));
}

/**
 * Cancel a message without erasing any responsibility or side-effect evidence; 08 §4.4.
 *
 * The sender-or-operator and non-empty-reason admission is the reducer's default (HEAD checked it inside the same
 * transaction, against the row it was about to cancel), so this helper passes no policy and pre-reads nothing: a
 * message whose sender changed after such a read must not be cancellable by the old sender (§7.14).
 */
export function cancelMessage(core, messageId, actor, reason) {
  return core.mutate(messageId, actor, { reason }, tx => reduceCommand(tx,
    { type: 'message.cancel', actor, payload: { messageId, reason } }));
}
