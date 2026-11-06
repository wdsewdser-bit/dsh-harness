import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
import { submitDeliveryReconciliation } from '../index.mjs';

/**
 * §WP-C 3 control (docs/refactor-20261026/19-M3a-M4-plan.md, WP-C risk note): the delivery.adjudicate assembly moved
 * from packages/delivery to the host's write gateway. It must still produce the same command - one
 * `delivery.adjudicate` payload carrying the delivery id (command.target), the decision, the evidence reference and the
 * operation id - and it must still be operator-only, never widened to root by the move.
 *
 * The durable row is the assertion surface: the reducer that reads that exact payload shape either records every field
 * or refuses (MISSING_REFERENCE / INVALID_ADJUDICATION), and a different command type is UNKNOWN_COMMAND.
 */
test('delivery.reconcile still assembles one operator-only delivery.adjudicate command', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-reconcile-'));
  const store = new ControlStore(dir);
  const core = new TeamCore(store, {}, { enabled: true, attach: true, teamId: 'team:reconcile' });
  try {
    core.member('member:root', 'root');
    core.member('member:w', 'worker');
    core.mutate('delivery:task:a', 'root', {}, tx => tx.put('delivery:task:a',
      { taskId: 'task:a', owner: 'member:w', status: 'unknown' }));
    core.mutate('artifact:evidence', 'operator', {}, tx => tx.put('artifact:evidence', { status: 'evidence' }));
    const command = { name: 'delivery.reconcile', target: 'delivery:task:a',
      expectedRevision: store.read('delivery:task:a').revision,
      args: { decision: 'effective', evidenceRef: 'artifact:evidence' },
      operationId: 'v1:operation:reconcile-control' };
    // Root is a team role, not the operator: the verdict stays with the operator exactly as before the move.
    assert.throws(() => submitDeliveryReconciliation(core, 'member:root', command), { code: 'ROLE_DENIED' });
    assert.equal(store.read('delivery:task:a').adjudication, undefined, 'a refused verdict writes nothing');

    const receipt = submitDeliveryReconciliation(core, 'operator', command);
    assert.equal(receipt.operationId, command.operationId);
    assert.equal(receipt.entityId, 'delivery:task:a');
    const row = store.read('delivery:task:a');
    assert.deepEqual(row.adjudication, { decision: 'effective', evidenceRef: 'artifact:evidence', actor: 'operator',
      operationId: command.operationId }, 'every payload field of the moved assembly lands on the row');
    // A verdict records responsibility; acceptance still needs the certified Git readback, so the row stays unknown.
    assert.equal(row.status, 'unknown');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
