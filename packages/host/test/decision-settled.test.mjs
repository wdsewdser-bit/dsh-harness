// Review 1 #3: the host is the only thing that may reopen admission, and only when its own recovery allows it.
//
// Two halves: the refresh the tool entry calls (published once by the host driver), and the constraint that survives
// every verdict -- a recovery that did not conclude 'ok' is never reopened by a decision, however that decision ended.
import test from 'node:test';
import assert from 'node:assert/strict';
import { real } from '../test-support/real.mjs';
import { profile } from '../test-support/profile.mjs';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';

test('a decision refresh never reopens a recovery that did not conclude ok', async () => {
  const w = await real({ recoverer: async () => ({ status: 'failed', admission: false }) });
  try {
    assert.equal(w.host.status().admission, false);
    assert.equal(w.host.refreshAdmission(), false, 'the decision entry asks, and the answer is still no');
  } finally { await w.close(); }
});

test('a decision refresh reopens admission when the recovery concluded ok and nothing is pending', async () => {
  const w = await real({ recoverer: async () => ({ status: 'ok', admission: false }) });
  try {
    assert.equal(w.host.status().admission, false);
    assert.equal(w.host.refreshAdmission(), true);
    assert.equal(w.host.status().admission, true);
  } finally { await w.close(); }
});

test('the profile publishes the refresh, and a pending completion holds admission closed until it is consumed', async () => {
  const w = await profile({ autonomy: 'on' }, async ({ root }) => {
    const store = new ControlStore(root);
    const core = new TeamCore(store, {}, { enabled: true });
    core.member('member:root', 'root');
    core.mutate('completion:frozen', 'root', {}, tx => tx.put('completion:frozen', { status: 'unknown',
      input: { sessionId: 'missing', goal: { id: 'g', revision: 1 } } }));
    store.close();
  });
  try {
    assert.equal(typeof w.runtime.core.notifyDecisionSettled, 'function', 'the host driver installs the hook once');
    assert.equal(w.runtime.host.status().admission, false, 'a pending completion closes admission at start-up');
    // The hook IS the host's own refresh: not a copy, not a shortcut around it.
    let calls = 0;
    const refresh = w.runtime.host.refreshAdmission.bind(w.runtime.host);
    w.runtime.host.refreshAdmission = () => { calls += 1; return refresh(); };
    w.runtime.core.mutate('completion:frozen', 'root', {}, (tx, row) => tx.put('completion:frozen', { ...row, status: 'consumed' }));
    w.runtime.core.notifyDecisionSettled();
    assert.equal(calls, 1, 'the decision hook asked the host exactly once');
    // And the host's own rule still decides: this recovery did not conclude ok (its token names a session that cannot be
    // read), so consuming the row opens nothing. A verdict never overrides a broken recovery.
    assert.equal(w.runtime.host.status().admission, false, 'a failed recovery is not reopened by a verdict');
  } finally { await w.close(); }
});
