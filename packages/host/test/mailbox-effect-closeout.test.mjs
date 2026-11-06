// Review 2 #3: the mailbox hand-over must not turn a normal release into an unproven effect.
//
// admitTask() releases the wake attempt in the very transaction that admits the work task, and the turn listener
// releases it when the turn ends. Both orders can land while the wake's start (or the dispatch it wrote) is still
// pending, applying, or between its preparation and its close-out:
//
//   1. the effect is claimed afterwards and refused with INVALID_LEASE - the attempt is gone, so the effect definitively
//      did NOT execute and is closed as cancelled, instead of becoming unknown (which the goal gate's effect check
//      blocks on);
//   2. the release lands while the start close-out is in flight - the prepared receipt is already there, and the same
//      answer applies instead of STALE_EFFECT_SUBJECT leaving the effect applying and later unknown.
//
// These cases drive the real close-out through store.claim/settle, which is what the runner does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
import { closeEffect } from '../src/effects/protocol.mjs';
import { createEffectRunner } from '../src/effect-runner.mjs';
import { real } from '../test-support/real.mjs';

function team(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mailbox-closeout-' + label + '-'));
  const store = new ControlStore(root);
  const core = new TeamCore(store, {}, { enabled: true, autonomy: 'on' });
  core.member('member:root', 'root');
  core.member('member:w', 'worker');
  return { root, store, core, close() { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

/** One wake attempt of a mailbox task, in the state the hand-over leaves it in, plus its pending start effect. */
function wake(t, attemptId, { lease = 'released', status = 'cancelled' } = {}) {
  t.store.commit(t.core.command('task:mail-' + attemptId, 'scheduler', {}), tx => {
    tx.put('task:mail-' + attemptId, { owner: 'member:w', mailboxOnly: true, status: 'cancelled', approved: true });
    return tx.put(attemptId, { owner: 'member:w', taskId: 'task:mail-' + attemptId, lease, status, fence: 1,
      generation: 1, expiresAt: Date.now() + 60000 });
  });
  t.store.commit(t.core.command('outbox:' + attemptId, 'scheduler', {}), tx => {
    tx.outbox(attemptId, { kind: 'start', attemptId, owner: 'member:w', generation: 1, fence: 1 });
    return { queued: true };
  });
  return attemptId;
}

/** Claim and settle one effect exactly the way the runner does: the close-out runs inside the settle transaction. */
function run(t, effectId, evidence) {
  const claimed = t.store.claim(t.core.command('claim:' + effectId, 'adapter', {}), effectId, 'adapter', Date.now());
  const settled = t.store.settle(t.core.command('settle:' + effectId, 'adapter', {}), effectId, claimed.result.fence,
    evidence, (tx, effect) => closeEffect(tx, effect, evidence, { revisions: new Map() }, {}), Date.now());
  return settled.result;
}

test('review 2 #3: a start claimed after its attempt was released settles as cancelled, not unknown', () => {
  const t = team('refused-start');
  try {
    // The runner claims the pending start, the authority check refuses it with INVALID_LEASE (the lease is gone), and that
    // meets the close-out as an unexecuted effect.
    const settled = run(t, wake(t, 'attempt:wake'), { notExecuted: true, reason: 'INVALID_LEASE: the attempt was released' });
    assert.equal(settled.status, 'cancelled', 'a definite non-execution of a released attempt is a cancellation');
    const outcome = t.store.commit(t.core.command('inspect:refused', 'adapter', {}), tx => closeEffect(tx,
      { id: 'inspect:refused', payload: { kind: 'start', attemptId: 'attempt:wake', fence: 1, generation: 1 } },
      { notExecuted: true, reason: 'INVALID_LEASE' }, { revisions: new Map() }, {}));
    assert.deepEqual(outcome.result, { cancelled: true, reason: 'the attempt was released before its start ran' },
      'the close-out states the cancellation it saw');
  } finally { t.close(); }
});

test('review 2 #3: a start whose attempt is released while its close-out is in flight settles as cancelled', () => {
  const t = team('raced-start');
  try {
    // ports.start() prepared an execution and the release landed before the receipt was settled: the attempt can never
    // run, so the close-out answers the cancellation instead of STALE_EFFECT_SUBJECT (which left the effect applying).
    const settled = run(t, wake(t, 'attempt:raced'), { executed: true, receipt: { prepared: true, executionSessionId: 'session:w' } });
    assert.equal(settled.status, 'cancelled');
    assert.equal(t.store.read('attempt:raced').lease, 'released', 'the released attempt was not revived by the close-out');
    // An unknown attempt is NOT "definitely not executed": it keeps its lease and stays with the operator.
    const kept = run(t, wake(t, 'attempt:unknown', { lease: 'unknown', status: 'unknown' }),
      { notExecuted: true, reason: 'INVALID_LEASE: unknown lease' });
    assert.equal(kept.status, 'retryable', 'an unknown attempt is not a proof that the effect never ran');
  } finally { t.close(); }
});
for (const autonomy of ['off', 'on']) test('released start is cancelled through the real runner, autonomy ' + autonomy, async () => {
  const w = await real();
  let portCalls = 0, runner;
  w.core.configuration.autonomy = autonomy;
  try {
    w.core.member('member:root', 'root');
    w.core.member('member:w', 'worker');
    // A mailbox wake attempt, released by the hand-over that admits the member's work task, with its start still pending.
    w.core.mutate('mailbox', 'scheduler', {}, tx => {
      tx.put('task:mail-member:w', { owner: 'member:w', mailboxOnly: true, status: 'cancelled', approved: true });
      return tx.put('attempt:wake', { owner: 'member:w', taskId: 'task:mail-member:w', lease: 'active', status: 'running',
        fence: 1, generation: 1, expiresAt: w.at + 600000, scopeSet: [] });
    });
    w.core.mutate('outbox', 'scheduler', {}, tx => {
      tx.outbox('attempt:wake', { kind: 'start', attemptId: 'attempt:wake', owner: 'member:w', generation: 1, fence: 1 });
      return null;
    });
    const payload = { attemptId: 'attempt:wake', fence: 1, status: 'cancelled',
      reason: 'mailbox wake released so the member can take its work task' };
    w.host.coreAccess.lifecycle().dispatch('attempt:wake', 'member:w', payload, { type: 'attempt.release', payload });
    assert.equal(w.store.read('attempt:wake').lease, 'released');
    // The runner that really ships with the host, driven against the real claim/register/close-out path.
    runner = createEffectRunner({ access: w.host.coreAccess, clock: w.host.clock,
      ...(autonomy === 'on' ? { capabilities: { on: true, kinds: ['start'], store: w.store, teamId: w.host.teamId } } : {}),
      ports: { start: () => { portCalls += 1; return { executed: true, receipt: { prepared: true, executionSessionId: 'session:never' } }; } } });
    assert.equal(runner.pump().claimed, 1, 'the runner does claim the pending start of the released attempt');
    await runner.whenIdle();
    // Review 2 #3: the authorization check runs BEFORE the port, so a refusal there is a proved non-execution - not an
    // unknown execution. That is what lets the close-out answer cancelled instead of handing an unknown to the operator.
    assert.equal(portCalls, 0, 'the port was never entered: the dispatch authorization refused first');
    const effect = w.store.effects().find(row => row.id === 'attempt:wake');
    assert.equal(effect.status, 'cancelled', 'a start that provably never ran is a cancellation, not an unknown');
    assert.equal(effect.lastEvidence.notExecuted, true);
    assert.equal(w.store.list('decision:').length, 0, 'no unknown-effect ticket can block completion');
    assert.equal(runner.pump().claimed, 0, 'the cancelled start is terminal');
    assert.deepEqual(runner.status().audit.filter(row => row.code === 'INVALID_LEASE'), [],
      'the refusal was classified, not swallowed into the audit as an execution failure');
  } finally { runner?.stop(); await w.close(); }
});

test('review 2 #3: unknown evidence for a released attempt is not a cancellation', () => {
  const t = team('unknown-evidence');
  try {
    // The attempt is gone, so it cannot run now - but nothing observed what it did before. "Cancelled" is a claim
    // about the past that this evidence does not support: the effect stays unknown and reaches the operator as one.
    const settled = run(t, wake(t, 'attempt:unknownish'), { unknown: true, reason: 'the adapter stopped answering' });
    assert.equal(settled.status, 'unknown', 'a lease that cannot run is not proof that it never ran');
    assert.equal(t.store.read('attempt:unknownish').lease, 'released', 'the release itself is left exactly as it was');
  } finally { t.close(); }
});

test('two proven refusals then released attempt cancels at retry cap, not unknown', async () => {
  const w = await real(); let runner, calls = 0;
  w.core.configuration.autonomy = 'on';
  try {
    w.core.member('member:root', 'root'); w.core.member('member:w', 'worker');
    w.core.mutate('seed:dispatch-limit', 'scheduler', {}, tx => {
      tx.put('task:mail-cap', { owner: 'member:w', mailboxOnly: true, status: 'executing', attemptId: 'attempt:cap' });
      tx.put('attempt:cap', { owner: 'member:w', taskId: 'task:mail-cap', lease: 'active', status: 'running',
        generation: 1, fence: 1, expiresAt: w.at + 600000, scopeSet: [] });
      tx.outbox('dispatch:attempt:cap', { kind: 'dispatch', attemptId: 'attempt:cap', recipient: 'member:w', generation: 1, fence: 1 });
      return null;
    });
    runner = createEffectRunner({ access: w.host.coreAccess, clock: w.host.clock,
      capabilities: { on: true, kinds: ['dispatch'], store: w.store, teamId: w.host.teamId },
      ports: { dispatch: () => { calls++; return { notExecuted: true, reason: 'wake refused before start' }; } } });
    for (let n = 0; n < 2; n++) { w.at += 10000; runner.pump(); await runner.whenIdle(); }
    assert.equal(calls, 2);
    const payload = { attemptId: 'attempt:cap', fence: 1, status: 'cancelled' };
    w.host.coreAccess.lifecycle().dispatch('attempt:cap', 'member:w', payload, { type: 'attempt.release', payload });
    w.at += 10000; runner.pump(); await runner.whenIdle();
    const effect = w.store.effects().find(e => e.id === 'dispatch:attempt:cap');
    assert.equal(effect.tries, 3);
    assert.equal(effect.status, 'cancelled');
    assert.equal(effect.lastEvidence.notExecuted, true);
    assert.equal(w.store.list('decision:').length, 0);
  } finally { runner?.stop(); await w.close(); }
});
