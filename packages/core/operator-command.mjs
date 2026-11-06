import { authorize } from './authorization.mjs';
import { fail } from '../contracts/index.mjs';

/** Operator/root control-plane admission. Identity includes the original CAS and intent. */
export function operatorCommand(core, actor, command, reduce, operatorOnly = false) {
  if (!core.configuration.enabled) fail('TEAM_DISABLED');
  authorize(core, actor, command.target);
  if (actor !== 'operator' && (operatorOnly || (actor !== 'root' && core.store.read(actor)?.role !== 'root'))) fail('ROLE_DENIED');
  const input = { ...core.command(command.target, actor, command, command.operationId), expectedRevision: command.expectedRevision };
  return core.store.commit(input, (tx, current) => {
    if (tx.list('completion:').some(t => ['prepared', 'authorized', 'unknown'].includes(t.status))) fail('COMPLETION_FROZEN');
    if (!current) fail('MISSING_REFERENCE');
    return reduce(tx, current);
  });
}
