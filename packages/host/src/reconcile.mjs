import { operatorCommand, reduceCommand } from '../../core/index.mjs';

/**
 * Record an operator verdict on a delivery row; the acceptance itself still requires independent certified Git
 * readback (packages/delivery). Moved here from delivery/index.mjs (§WP-C 3 of 19-M3a-M4-plan): delivery keeps the IO
 * port and the gate runner factory, and the `delivery.adjudicate` command assembly - the half that writes through the
 * core - is the host's write gateway, which is the only package allowed to reach core with it.
 *
 * "Operator" is literal here, exactly as for mailbox.resolveUnknown: root is a team role, not the operator, and the
 * verdict on an unknown external effect belongs to the operator. The command shape is unchanged: one
 * `delivery.adjudicate` payload carrying the delivery id, the decision, the evidence reference and the operation id,
 * admitted through operatorCommand with operatorOnly.
 */
export function submitDeliveryReconciliation(core, actor, command) {
  return operatorCommand(core, actor, command, tx => reduceCommand(tx, { type: 'delivery.adjudicate', actor,
    payload: { deliveryId: command.target, decision: command.args.decision, evidenceRef: command.args.evidenceRef,
      operationId: command.operationId } }), true);
}
