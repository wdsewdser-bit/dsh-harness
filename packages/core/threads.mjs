import { operatorCommand } from './operator-command.mjs';
import { reduceCommand } from './index.mjs';

/** Escalate responsibility, not a decision or a reassignment of recorded replies. */
export function escalateThread(core, actor, command) {
  return operatorCommand(core, actor, command, tx => reduceCommand(tx,
    { type: 'thread.escalate', actor, payload: { issueId: command.target, reason: command.args.reason } }));
}
