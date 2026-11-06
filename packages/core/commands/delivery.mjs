import { fail, failWith } from '../../contracts/index.mjs';
import { teamGoalIn } from './goals.mjs';

/**
 * Delivery facts the command layer writes: the delivery row itself and the task row that names it once a certified
 * integration is accepted.
 *
 * Git, worktrees, the verifier subprocess and signature checks stay in packages/delivery/index.mjs: they are external
 * IO and must not run inside a transaction. Only the two durable writes are reducers, so the task row has one owner
 * whether it is written by Delivery.reconcile or by any later host command.
 */

function putDelivery(tx, command) {
  const p = command.payload;
  const current = tx.read(p.deliveryId);
  if (p.row) {
    if (current) fail('ID_CONFLICT:' + p.deliveryId);
    return tx.put(p.deliveryId, p.row);
  }
  return tx.put(p.deliveryId, { ...current, ...p.values });
}

function acceptDeliveredTask(tx, command) {
  const p = command.payload;
  return tx.put(p.taskId, { ...tx.read(p.taskId), status: 'accepted', deliveryRef: p.deliveryId });
}

/**
 * Record an operator verdict only. Acceptance still requires independent certified Git readback: the verdict leaves the
 * row in quarantine ('unknown') and never moves it to accepted.
 */
function adjudicateDelivery(tx, command) {
  const p = command.payload;
  const current = tx.read(p.deliveryId);
  if (!current) fail('MISSING_REFERENCE');
  if (!p.deliveryId.startsWith('delivery:') || current.status !== 'unknown' ||
    !['effective', 'not-effective', 'abandoned'].includes(p.decision) || !p.evidenceRef || !tx.read(p.evidenceRef)) {
    fail('INVALID_ADJUDICATION');
  }
  return tx.put(p.deliveryId, { ...current, adjudication: { decision: p.decision, evidenceRef: p.evidenceRef,
    actor: command.actor, operationId: p.operationId } });
}

/**
 * The one close-out transition the host applies after a readback; design §3.7.
 *
 * The port returns evidence - { actual, candidate, tree, contractCurrent, dirty } - and the host decides which state
 * that evidence supports; this reducer applies exactly that state in one transaction. `from` is the status the host
 * read, so a concurrent transition is a refusal instead of a silent overwrite, the reachable states are a closed
 * table, and the writable fields are a closed list. Acceptance writes the task row in the same transaction: the
 * delivery row and the task that names it can never disagree.
 */
const DELIVERY_FIELDS = Object.freeze(['status', 'directory', 'base', 'candidate', 'tree', 'certificate', 'signature',
  'publicKey', 'certificateHash', 'integrationCommit', 'integrationTree', 'target', 'reason', 'lastEvidence',
  'nextReviewAt', 'responsible', 'adjudication']);

const TRANSITIONS = Object.freeze({
  creating: Object.freeze(['ready', 'unknown']),
  ready: Object.freeze(['produced', 'unknown']),
  produced: Object.freeze(['verified', 'unknown']),
  verified: Object.freeze(['applying', 'accepted', 'unknown']),
  applying: Object.freeze(['accepted', 'unknown']),
  unknown: Object.freeze(['verified', 'accepted']),
});

function transitionDelivery(tx, command) {
  const p = command.payload;
  if (!['root', 'operator', 'adapter', 'scheduler'].includes(command.actor)) fail('DENIED');
  const current = p.deliveryId && p.deliveryId.startsWith('delivery:') ? tx.read(p.deliveryId) : null;
  if (!current) fail('MISSING_REFERENCE');
  if (p.from !== current.status) fail('STALE_DELIVERY:' + current.status);
  if (p.revision !== undefined && p.revision !== current.revision) fail('STALE_DELIVERY_REVISION');
  if (p.taskRevision !== undefined && p.taskRevision !== (tx.read(current.taskId)?.revision ?? 0)) fail('STALE_TASK_REVISION');
  if (!(TRANSITIONS[current.status] ?? []).includes(p.status)) fail('INVALID_TRANSITION:' + current.status + '>' + String(p.status));
  const values = { ...p };
  delete values.deliveryId; delete values.from; delete values.revision; delete values.taskRevision;
  for (const key of Object.keys(values)) if (!DELIVERY_FIELDS.includes(key)) fail('INVALID_DELIVERY_FIELD:' + key);
  if (p.status === 'accepted') {
    // Only the certified candidate, at its certified tree, can be accepted; the readback proved the ref, this proves
    // the row the evidence is bound to.
    if (!current.certificate || !current.certificateHash ||
      p.integrationCommit !== current.certificate.candidate || p.integrationTree !== current.certificate.tree) {
      fail('UNCERTIFIED_INTEGRATION');
    }
    // §5.2.3: an accepted delivery belongs to the team goal that was open when it landed. The row is bound here, in
    // the transaction that makes the chain fact, because the delivery writer (packages/delivery) knows nothing about
    // goals; a row already bound to another goal is a stale completion, never a silent rebind.
    const goal = teamGoalIn(tx);
    if (goal) {
      if (current.teamGoalRef && current.teamGoalRef !== goal.entityId) {
        failWith('STALE_COMPLETION', 'this delivery is bound to ' + current.teamGoalRef + ' but the team goal is ' +
          goal.entityId);
      }
      values.teamGoalRef = goal.entityId;
      values.teamGoalRevision = goal.revision;
    } else if (command.goalGate?.strict === true) {
      failWith('TEAM_GOAL_REQUIRED', 'this team has no goal record; an accepted delivery needs the chain root it ' +
        'extends (team.goal.open before the first task)');
    }
    const task = tx.read(current.taskId);
    if (!task) fail('MISSING_REFERENCE');
    tx.put(task.entityId, { ...task, status: 'accepted', deliveryRef: p.deliveryId });
  }
  return tx.put(p.deliveryId, { ...current, ...values });
}

export const deliveryCommands = {
  'delivery.put': putDelivery,
  'delivery.transition': transitionDelivery,
  'task.deliveryAccepted': acceptDeliveredTask,
  'delivery.adjudicate': adjudicateDelivery,
};
