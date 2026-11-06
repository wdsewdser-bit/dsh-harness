import test from 'node:test';
import assert from 'node:assert/strict';
import { createClock } from '../index.mjs';
import { world, send, requestMember } from '../test-support/mailbox-fixtures.mjs';
import { until } from '../test-support/profile.mjs';

for (const disposition of ['cancelled', 'expired']) test('durable deferred notice closes undelivered after ' + disposition, async () => {
  let at = Date.now();
  const w = await world({ autonomy: 'on', simulateRequests: false, clock: createClock({ now: () => at }) });
  try {
    await requestMember(w, 'w');
    const id = send(w, 'member:w', 'will disappear while still unseen');
    const effect = () => w.runtime.store.effects().find(row => row.payload?.kind === 'message' && row.payload.messageId === id);
    await until(() => w.runtime.store.list('attempt:').some(row =>
      w.runtime.store.read('attempt-dispatch:' + row.entityId)));
    await w.runtime.runner.whenIdle();
    at = Math.max(at, effect().nextDue);
    await w.runtime.host.cycle.run(); await w.runtime.runner.whenIdle();
    await until(() => (effect()?.defers ?? 0) > 0);
    assert.equal(w.runtime.store.read(id).visible, false);
    const agent = w.runtime.handles.get('member:w').agent;
    agent.phase = { kind: 'maintenance' };
    const wakes = w.control.wakes.length;
    if (disposition === 'cancelled') {
      w.runtime.host.executeAuthorized('business', () => w.runtime.core.dispatch(id, 'member:root', { reason: 'withdrawn during deferral' },
        { type: 'message.cancel', payload: { messageId: id, reason: 'withdrawn during deferral' } }));
    } else {
      w.runtime.host.coreAccess.lifecycle().mutate(id, 'adapter', {}, tx => tx.put(id,
        { ...tx.read(id), status: 'expired', deadline: new Date(at - 1).toISOString() }));
    }
    at = Math.max(at + 1, effect().nextDue);
    await w.runtime.host.cycle.run(); await w.runtime.runner.whenIdle();
    await until(() => effect().status === 'confirmed');
    assert.equal(effect().lastEvidence.receipt.delivered, false);
    assert.equal(effect().lastEvidence.receipt.invalidated, true);
    assert.equal(effect().lastEvidence.receipt.reason, disposition);
    assert.equal(w.control.wakes.length, wakes, 'maintenance and execution-scope gates must not cause another wake');
    assert.equal(w.runtime.store.read(id).observation, undefined);
    for (let retry = 0; retry < 3; retry++) { at += 10000; await w.runtime.host.cycle.run(); await w.runtime.runner.whenIdle(); }
    assert.equal(effect().status, 'confirmed');
    assert.equal(w.control.wakes.length, wakes);
  } finally { await w.close(); }
});
