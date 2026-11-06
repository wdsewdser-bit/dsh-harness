import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mailboxVisibility, mailboxInvalidation } from '../mailbox-visibility.mjs';

// Execute the actual production delivery closure with controlled scheduling/IO ports. No reimplementation of
// its receipt decision: the mutation below removes that exact production guard and reruns the same assertions.
const driver = fs.readFileSync(new URL('../host-driver.mjs', import.meta.url), 'utf8');
const start = driver.indexOf('  const deliver = async (recipient, generation, messageId, effectId) => {');
const end = driver.indexOf('  ports.wake = async request => {', start);
assert(start > 0 && end > start);
function world(source = driver.slice(start, end)) {
  const rows = new Map(), listeners = new Set(); let wakes = 0;
  const attempt = { entityId: 'attempt:a', fence: 1, generation: 1 };
  const current = { ok: true, attempt, binding: { attemptId: attempt.entityId, sessionId: 'session:a' } };
  const agent = { phase: { kind: 'running' }, session: { id: 'session:a', snapshotEvents: () => [] },
    whenIdle: () => new Promise(() => {}) };
  const core = { store: { read: id => rows.get(id), effects: () => [] } };
  const mutate = (_key, _actor, _payload, fn) => fn({ put: (key, value) => rows.set(key, value) });
  const host = { clock: { now: () => 1 }, coreAccess: { lifecycle: () => ({ mutate }) } };
  const runtime = { handles: new Map([['member:a', { agent }]]), preempt: { deliverMail() {
    wakes++; queueMicrotask(() => { for (const listener of listeners) listener(agent.session, { type: 'step/start', seq: wakes }); });
    return { wake: 'coalesced', dispatched: true };
  } } };
  const ctx = { on(_type, fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  const deliver = new Function('core', 'host', 'runtime', 'ctx', 'authority', 'bindEffectExecution',
    'beginMailboxMerge', 'sameAuthority', 'markMailboxMerge', 'markDispatched', 'mailboxVisibility', 'mailboxInvalidation', source + '\nreturn deliver;')(
    core, host, runtime, ctx, () => current, () => true, () => ({ close() {} }), () => true, () => {}, () => {}, mailboxVisibility, mailboxInvalidation);
  const id = 'message:omitted', receipt = 'wake-receipt:' + id + ':member:a';
  rows.set(id, { entityId: id, generation: 1, bindingGeneration: 0 });
  return { rows, core, id, receipt, deliver: () => deliver('member:a', 1, id, 'effect:a'), get wakes() { return wakes; },
    visible() {
      rows.set(id, { ...rows.get(id), visible: true, observation: { requestId: 'req:a', manifestHash: 'hash:a' } });
      rows.set('manifest:hash:a', { memberId: 'member:a', generation: 1,
        messageBindings: [{ messageId: id, recipient: 'member:a', generation: 1, bindingGeneration: 0 }] });
    } };
}
async function omissionContract(source) {
  const w = world(source), result = await w.deliver();
  assert.equal(result.outcome, 'deferred', 'an omitted running-step merge must remain pending');
  assert.equal(w.rows.has(w.receipt), false, 'no receipt without actual request visibility');
  assert.equal(w.wakes, 1);
  // The next boundary can carry it; retry closes the effect without opening a duplicate turn.
  w.visible();
  assert.equal((await w.deliver()).outcome, 'executed');
  assert(w.rows.has(w.receipt)); assert.equal(w.wakes, 1);
  assert.equal((await w.deliver()).receipt.deduplicated, true);
}
test('running-step omission stays retryable; later manifest visibility yields exactly one receipt', async () => {
  await omissionContract();
});
test('visibility requires a real carrying manifest at the current recipient generation and binding', () => {
  const w = world(); w.visible();
  assert.equal(mailboxVisibility(w.core, w.id, 'member:a', 1), true);
  for (const change of [{ withdrawn: true }, { memberId: 'member:b' }, { generation: 2 }, { messageBindings: [] }]) {
    const original = w.rows.get('manifest:hash:a');
    w.rows.set('manifest:hash:a', { ...original, ...change });
    assert.equal(mailboxVisibility(w.core, w.id, 'member:a', 1), false);
    w.rows.set('manifest:hash:a', original);
  }
  w.rows.set(w.id, { ...w.rows.get(w.id), bindingGeneration: 2 });
  assert.equal(mailboxVisibility(w.core, w.id, 'member:a', 1), false);
});
test('mutation: unconditional receipt is killed by the running-step omission contract', async () => {
  const source = driver.slice(start, end);
  const guard = "if (!mailboxVisibility(core, messageId, recipient, generation)) {";
  assert.equal(source.split(guard).length, 2, 'exactly one receipt guard must be mutated');
  const mutant = source.replace(guard, 'if (false) {');
  await assert.rejects(omissionContract(mutant), { code: 'ERR_ASSERTION', message: /omitted running-step merge/ });
});
for (const status of ['cancelled', 'expired']) test('deferred unseen message becomes ' + status + ': close undelivered without another wake', async () => {
  const w = world();
  assert.equal((await w.deliver()).outcome, 'deferred');
  assert.equal(w.wakes, 1); assert.equal(w.rows.has(w.receipt), false);
  w.rows.set(w.id, { ...w.rows.get(w.id), status, visible: false });
  for (let retry = 0; retry < 3; retry++) {
    const result = await w.deliver();
    assert.equal(result.outcome, 'executed', 'the notification effect terminates, not another deferred retry');
    assert.equal(result.receipt.delivered, false); assert.equal(result.receipt.invalidated, true);
    assert.equal(result.receipt.reason, status);
    assert.equal(w.wakes, 1, 'terminal responsibility must not wake again');
  }
  assert.equal(w.rows.get(w.receipt).delivered, false);
  assert.equal(w.rows.get(w.id).observation, undefined, 'no fabricated visibility');
});
test('deadline expiring between retries closes the unseen notice before the scheduler has marked its row', async () => {
  const w = world(); assert.equal((await w.deliver()).outcome, 'deferred');
  w.rows.set(w.id, { ...w.rows.get(w.id), deadline: new Date(0).toISOString() });
  assert.equal((await w.deliver()).receipt.reason, 'expired');
  assert.equal(w.wakes, 1); assert.equal(w.rows.get(w.receipt).delivered, false);
});
test('terminal notice preserves a delivery that really was visible instead of rewriting it as undelivered', async () => {
  const w = world(); w.visible();
  w.rows.set(w.id, { ...w.rows.get(w.id), status: 'cancelled' });
  const result = await w.deliver();
  assert.equal(result.receipt.invalidated, true);
  assert.equal(result.receipt.delivered, true, 'terminal status does not erase real carrying evidence');
  assert.equal(w.wakes, 0);
  assert.equal((await w.deliver()).receipt.delivered, true);
});
test('dedup corrects an invalidated undelivered receipt when valid carrying evidence arrives later', async () => {
  const w = world();
  w.rows.set(w.id, { ...w.rows.get(w.id), deadline: new Date(0).toISOString() });
  const expired = await w.deliver();
  assert.equal(expired.receipt.delivered, false); assert.equal(expired.receipt.invalidated, true);
  assert.equal(w.wakes, 0);
  w.visible();
  const corrected = await w.deliver();
  assert.equal(mailboxVisibility(w.core, w.id, 'member:a', 1), true);
  assert.equal(corrected.receipt.delivered, true);
  assert.equal(corrected.receipt.deduplicated, true);
  assert.equal(corrected.receipt.deliveryCorrected, true);
  assert.equal(w.rows.get(w.receipt).delivered, true, 'persist the correction, not just the port return value');
  assert.equal(w.rows.get(w.receipt).deliveryEvidence.manifestHash, 'hash:a');
  assert.equal(w.wakes, 0, 'correcting late evidence never schedules another turn');
  assert.equal((await w.deliver()).receipt.delivered, true);
});
