// Review 1 #3: a completion verdict has to reopen the admission it closed.
//
// The operator channel already did (host-driver.adjudicate calls host.refreshAdmission). The root tool entry did not:
// it went through executeAuthorized('operator', ...) and stopped there, so a team whose admission had been closed by a
// pending completion stayed closed after root had decided that very completion. The host owns admission, so the host
// publishes the refresh (core.notifyDecisionSettled) and this package calls it -- after the verdict commits, outside any
// transaction, and only when the verdict really landed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore, openDecision } from '../../core/index.mjs';
import { decisionSettled, installRuntime } from '../runtime.mjs';

function context() {
  const tools = new Map(), listeners = new Map();
  const ctx = {
    agents: {
      currentInitiator: () => ({ session: { id: 'session:root' } }),
      async create(options = {}) {
        return { agent: { session: { id: options.sessionId ?? 'session:x', seq: 0, snapshotEvents: () => [] }, ctx: {} },
          dispose: async () => {} };
      },
      async resume() { throw Error('unused'); },
    },
    tools: { register(tool) { tools.set(tool.name, tool); }, restrict() {}, guard() {} },
    on(name, fn) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); return () => set.delete(fn); },
    plugin() { return {}; },
    sessions: { get: () => null },
    get(name) { return this[name]; },
    provide() {},
    async emit() {},
  };
  return { ctx, tools };
}

test('the decision tool refreshes admission after a verdict, and only after one that landed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-decision-settled-'));
  const store = new ControlStore(root);
  const core = new TeamCore(store, {}, { enabled: true, autonomy: 'on' });
  try {
    core.member('member:root', 'root');
    core.member('member:w', 'worker');
    let refreshes = 0;
    core.notifyDecisionSettled = () => { refreshes += 1; };
    const { ctx, tools } = context();
    const runtime = installRuntime(ctx, core, { authorize: (kind, work) => { assert.equal(kind, 'operator'); return work(); },
      route: () => ({ routed: true, kind: 'owner', memberId: 'member:root' }) });
    await runtime.stop.ready;
    const tool = tools.get('team_decide');
    assert.ok(tool, 'the autonomy switch publishes the decision entry');
    const decision = core.mutate('decision:t1', 'root', {}, tx => openDecision(tx,
      { autonomy: 'on', now: Date.now(), decisionTtlMs: 900000 },
      { kind: 'stuck-member', subject: { type: 'member', id: 'member:w', revision: core.store.read('member:w').revision },
        evidence: [{ at: 1, kind: 'stop-proof', ref: 'stop-proof:member:w:1:1', text: 'the stop was not proven' }],
        openedFor: 'operator', ttlMs: 900000, decisionId: 'decision:t1' }));
    const result = tool.execute({ operationId: 'v1:operation:decide-tool-1', decisionId: decision.entityId,
      decision: 'wait', expectedRevision: decision.revision });
    assert.equal(result.status, 'confirmed');
    assert.equal(core.store.read(decision.entityId).state, 'decided');
    assert.equal(refreshes, 1, 'the host was asked to recompute the admission the token closed');
    // A verdict that is refused asks for nothing: the row is terminal now, and this is a DECISION_STALE refusal.
    assert.throws(() => tool.execute({ operationId: 'v1:operation:decide-tool-2', decisionId: decision.entityId,
      decision: 'wait', expectedRevision: core.store.read(decision.entityId).revision }), { code: 'DECISION_STALE' });
    assert.equal(refreshes, 1, 'a refusal is not a verdict');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('the refresh is best-effort: a host that refuses it cannot turn a committed verdict into a failure', () => {
  let calls = 0;
  assert.equal(decisionSettled({ notifyDecisionSettled() { calls += 1; } }), true);
  assert.equal(calls, 1);
  // A bare core (a test, a composition without a host) has no hook, and that is not an error.
  assert.equal(decisionSettled({}), true);
  // A revoked host throws from the hook; the verdict is already committed, so this must not surface as a tool failure.
  assert.equal(decisionSettled({ notifyDecisionSettled() { throw Object.assign(Error('WRITE_REVOKED'), { code: 'WRITE_REVOKED' }); } }), true);
});
