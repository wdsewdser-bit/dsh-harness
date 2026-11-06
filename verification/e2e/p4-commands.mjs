import assert from 'node:assert/strict';
import { ControlStore } from '../../packages/store/index.mjs';
import { TeamCore } from '../../packages/core/index.mjs';
import { submit as submitCommand } from '../../packages/projections/commands.mjs';
import { createLifecycleConsumer, submitDeliveryReconciliation } from '../../packages/host/index.mjs';
// The delivery write half is a port now (§WP-C 4): projections keeps the browser translation and never imports delivery.
const submit = (core, actor, command) => submitCommand(core, actor, command, { reconcile: submitDeliveryReconciliation });
import { COMMANDS, UNSUPPORTED_COMMANDS } from '../../packages/ui/src/projection.mjs';

/** No provider: exercise real SQLite commits, durable replay and fake native stop evidence. */
export async function commandTests(root) {
  let store = new ControlStore(root);
  let core = new TeamCore(store, { dispose: async () => ({ stopped: true }) }, { enabled: true, attach: true });
  core.member('member:root', 'root'); core.member('member:worker', 'worker'); core.member('member:peer', 'worker');
  // The deployment's own driver, not a manual drain: the point of this case is that nothing outside the product has to
  // pump lifecycle intents. The timeout is pushed far out so expiry cannot stand in for convergence.
  const driver = createLifecycleConsumer(core, { root, intervalMs: 20, timeoutMs: 4 * 60 * 60 * 1000 });
  const put = (ref, value) => core.mutate(ref, 'operator', value, tx => tx.put(ref, value));
  put('artifact:evidence', { status: 'evidence' });
  const cases = [
    ['organization.retire', 'member:peer', { reason: 'retire explicitly' }, 'member:root'],
    ['threads.escalate', 'thread:test', { reason: 'operator review required' }, 'member:root'],
    ['mailbox.cancelMessage', 'message:cancel', { reason: 'cancel responsibility' }, 'operator'],
    ['mailbox.rebind', 'message:rebind', { recipient: 'member:peer', evidenceRef: 'artifact:evidence' }, 'operator'],
    ['mailbox.resolveUnknown', 'message:unknown', { decision: 'not-effective', evidenceRef: 'artifact:evidence' }, 'operator'],
    ['scheduler.approveContract', 'task:draft', { contractRevision: 3 }, 'member:root'],
    ['delivery.reconcile', 'delivery:unknown', { decision: 'effective', evidenceRef: 'artifact:evidence' }, 'operator'],
  ];
  put('thread:test', { owner: 'member:root', escalationOwner: 'operator', status: 'collecting', requiredRespondents: [], replies: [], proposalRevision: 1 });
  for (const name of ['cancel', 'rebind', 'unknown']) put('message:' + name, { sender: 'member:root', recipient: 'member:worker', generation: 1,
    status: name === 'unknown' ? 'unknown' : 'stored', visible: false, accepted: false, history: [] });
  put('delivery:unknown', { status: 'unknown', taskId: 'task:draft', candidate: 'unverified' });
  core.task('task:draft', 'member:worker', [], { approved: false, status: 'draft', contractRevision: 3 });
  const ledger = () => JSON.stringify({ rows: store.list(), events: store.events(), effects: store.effects() });
  const unchanged = (actor, command, status, message) => {
    const before = ledger(); const result = submit(core, actor, command);
    assert.equal(result.status, status, JSON.stringify(result));
    if (message) assert.match(result.message, message);
    assert.equal(ledger(), before, 'refusal must leave the ledger unchanged');
  };
  try {
    for (let i = 0; i < cases.length; i++) {
      const [name, target, args, actor] = cases[i];
      assert(COMMANDS[name]); assert(!UNSUPPORTED_COMMANDS[name]);
      const command = { name, target, args, expectedRevision: store.read(target).revision, operationId: 'v1:operation:command-test-' + i };
      unchanged('member:worker', command, 'rejected');
      unchanged(actor, { ...command, expectedRevision: command.expectedRevision - 1 }, 'conflict');
      // The browser-facing conflict response keeps HEAD's bare code, not the shared reducer's CAS_CONFLICT:<ref>
      // (docs/decisions/M2a-shared-reducer.md §7-9).
      assert.equal(submit(core, actor, { ...command, expectedRevision: command.expectedRevision - 1 }).message, 'CAS_CONFLICT');
      if (name === 'scheduler.approveContract') unchanged(actor, { ...command, args: { contractRevision: 2 } }, 'conflict');
      const beforeEffects = JSON.stringify(store.effects());
      const accepted = submit(core, actor, command);
      assert.equal(accepted.status, 'accepted', JSON.stringify(accepted));
      const after = ledger(); assert.deepEqual(submit(core, actor, command), accepted); assert.equal(ledger(), after);
      unchanged(actor, { ...command, args: name === 'scheduler.approveContract' ? { contractRevision: 4 } : { ...args, reason: 'changed intent' } }, 'rejected',
        /ID_CONFLICT|INVALID_TOOL/);
      unchanged(actor, { ...command, operationId: 'v1:operation:stale-test-' + i, expectedRevision: 0 }, 'conflict');
      // Reopen the database: idempotency is durable, not a bridge-side cache.
      store.close(); store = new ControlStore(root); core.store = store;
      assert.deepEqual(submit(core, actor, command), accepted); assert.equal(ledger(), after);
      if (name === 'mailbox.resolveUnknown' || name === 'delivery.reconcile') {
        assert.equal(store.read(target).status, 'unknown');
        assert.equal(store.read(target).adjudication.decision, args.decision);
      }
      if (name.startsWith('mailbox.') || name === 'threads.escalate' || name === 'scheduler.approveContract' || name === 'delivery.reconcile') assert.equal(JSON
        .stringify(store.effects()), beforeEffects);
      if (name === 'scheduler.approveContract') {
        assert.equal(store.read(target).approved, true); assert.equal(store.read(target).status, 'ready');
        unchanged(actor, { ...command, operationId: 'v1:operation:not-draft-0001', expectedRevision: store.read(target).revision }, 'rejected', /NOT_DRAFT/);
      }
    }
    // Durable replay is decided before any CAS: a command accepted once answers with its stored receipt even though the
    // revision it carries has moved on, and the row is not re-checked (docs/decisions/M2a-shared-reducer.md §7.13).
    core.task('task:replay', 'member:worker', [], { approved: false, status: 'draft', contractRevision: 1 });
    const replayRevision = store.read('task:replay').revision;
    const replayCommand = { name: 'scheduler.approveContract', target: 'task:replay', args: { contractRevision: 1 },
      expectedRevision: replayRevision, operationId: 'v1:operation:replay-before-cas-01' };
    const firstAnswer = submit(core, 'member:root', replayCommand);
    assert.equal(firstAnswer.status, 'accepted', JSON.stringify(firstAnswer));
    assert(store.read('task:replay').revision > replayRevision, 'the command must move the row past the revision it carried');
    const replayed = submit(core, 'member:root', replayCommand);
    assert.deepEqual(replayed, firstAnswer, 'a stored operation replays even with a now-stale revision');
    // The UI revision prediction is checked before the tool admission checks: a stale revision is a conflict even when a
    // referenced row does not exist...
    const staleMissing = { name: 'threads.decide', target: 'thread:test',
      args: { proposalRevision: 1, conclusionRef: 'artifact:absent' },
      expectedRevision: store.read('thread:test').revision - 1, operationId: 'v1:operation:stale-missing-ref-01' };
    const staleResult = submit(core, 'member:root', staleMissing);
    assert.equal(staleResult.status, 'conflict', JSON.stringify(staleResult));
    assert.equal(staleResult.message, 'CAS_CONFLICT');
    // ...while the same command carrying the current revision reports the missing reference.
    unchanged('member:root', { ...staleMissing, expectedRevision: store.read('thread:test').revision,
      operationId: 'v1:operation:current-missing-ref-01' }, 'rejected', /MISSING_REFERENCE/);
    // Retire is an intent until the profile driver observes confirmed native disposal. Nothing below calls
    // the lifecycle preparation step directly: the driver started above is the only consumer, so a regression that drops it fails here.
    assert.equal(store.read('member:peer').observed, 'offline');
    driver.kick();
    await driver.whenSettled();
    for (let wait = 0; wait < 200 && store.read('member:peer').status !== 'retired'; wait++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(store.read('member:peer').desired, 'retired'); assert.equal(store.read('member:peer').status, 'retired');
    assert.equal(store.read('member:peer').observed, 'stopped');
    const beforeReplay = ledger();
    assert.deepEqual(submit(core, 'member:root', { name: 'organization.retire', target: 'member:peer', args: cases[0][2],
      expectedRevision: 1, operationId: 'v1:operation:command-test-0' }),
      { operationId: 'v1:operation:command-test-0', status: 'accepted', revision: 1, entityId: 'member:peer' });
    assert.equal(ledger(), beforeReplay, 'replay after native disposal must not queue another disposal');
    // Invalid operator verdicts cannot remove quarantine or alter evidence.
    for (const name of ['mailbox.resolveUnknown', 'delivery.reconcile']) {
      const target = name.startsWith('mailbox') ? 'message:unknown' : 'delivery:unknown';
      for (const args of [{ decision: 'retry', evidenceRef: 'artifact:evidence' }, { decision: 'effective', evidenceRef: 'artifact:absent' }])
        unchanged('operator', { name, target, args, expectedRevision: store.read(target).revision,
          operationId: 'v1:operation:invalid-verdict-' + name.replaceAll('.', '-') }, 'rejected', /INVALID_ADJUDICATION|MISSING_EVIDENCE/);
      unchanged('member:root', { name, target, args: { decision: 'effective', evidenceRef: 'artifact:evidence' },
        expectedRevision: store.read(target).revision, operationId: 'v1:operation:denied-verdict-' + name.replaceAll('.', '-') }, 'rejected', /ROLE_DENIED/);
    }
    // Root is deliberately not allowed to adjudicate unknown effects.
    unchanged('member:root', { name: 'mailbox.resolveUnknown', target: 'message:unknown', expectedRevision: store.read('message:unknown').revision,
      args: { decision: 'effective', evidenceRef: 'artifact:evidence' }, operationId: 'v1:operation:root-unknown-0001' }, 'rejected', /ROLE_DENIED/);
    for (const name of ['goal-gate.authorizeCompletion']) {
      assert(UNSUPPORTED_COMMANDS[name]); assert(!COMMANDS[name]);
      unchanged('operator', { name, target: 'message:unknown', expectedRevision: store.read('message:unknown').revision, args: {},
          operationId: 'v1:operation:unsupported-' + name.replaceAll('.', '-') }, 'rejected', /UNSUPPORTED_COMMAND/);
    }
    // Completion fence applies equally to every newly admitted write.
    put('completion:test', { status: 'prepared' });
    for (let i = 0; i < cases.length; i++) {
      const [name, target, args, actor] = cases[i];
      unchanged(actor, { name, target, args, expectedRevision: store.read(target).revision, operationId: 'v1:operation:frozen-test-' + i }, 'rejected',
        /COMPLETION_FROZEN/);
    }
    // A stale revision under the same freeze is still a conflict, not COMPLETION_FROZEN: on the tool path the UI
    // prediction is checked at the top of the transaction, ahead of the fence (§7.13).
    for (const [i, name, target, args] of [[0, 'organization.retire', 'member:peer', cases[0][2]],
      [5, 'scheduler.approveContract', 'task:draft', { contractRevision: 3 }]]) {
      const frozenStale = submit(core, 'member:root', { name, target, args,
        expectedRevision: store.read(target).revision - 1, operationId: 'v1:operation:frozen-stale-' + i });
      assert.equal(frozenStale.status, 'conflict', name + ' under a freeze must answer conflict: ' + JSON.stringify(frozenStale));
      assert.equal(frozenStale.message, 'CAS_CONFLICT');
    }
    console.log('p4-commands: PASS (7 commands; ACL, CAS ordering, durable replay, ID conflict, unchanged refusal, completion fence, confirmed retirement)');
  } finally { await driver.stop(); store.close(); }
}
