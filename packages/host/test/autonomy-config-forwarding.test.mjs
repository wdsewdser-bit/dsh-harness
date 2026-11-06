// Review 1, item 2: the fields the profile validated have to reach the code that consumes them.
//
// autonomyConfig() validated goalGate, stopGraceMs and stopProofTimeoutMs and then dropped all three when the core was
// built, so a deployment that asked for the strict goal gate got the default one and every proof ran on the default
// budgets. These cases boot the real profile in-process and assert on the RESULT each consumer produces, not on the
// resolved configuration object ([...] the review asked for a real refusal, not a patch inspection).
import test from 'node:test';
import assert from 'node:assert/strict';
import { profile } from '../test-support/profile.mjs';

test('§12 U5: a profile that asks for the strict goal gate gets the refusal strict is for', async () => {
  const w = await profile({ autonomy: 'on', goalGate: { strict: true } });
  try {
    const core = w.runtime.core;
    // The consumer is the admission rule. strict is what makes a task without a goal row TEAM_GOAL_REQUIRED; without the
    // forwarding this call succeeded and the promised gate simply did not exist.
    assert.throws(() => core.task('task:strict', 'member:root', []), { code: 'TEAM_GOAL_REQUIRED' });
    assert.equal(w.runtime.store.list('task:').length, 0, 'the refusal wrote nothing');
  } finally { await w.close(); }
});

test('a profile that says nothing keeps the default stance: the same task is admitted', async () => {
  const w = await profile({ autonomy: 'on' });
  try {
    w.runtime.core.task('task:plain', 'member:root', []);
    assert.equal(w.runtime.store.read('task:plain').status, 'ready');
  } finally { await w.close(); }
});

test('§7.2.3: the configured stop budgets are the ones the platform proof is asked with', async () => {
  const w = await profile({ autonomy: 'on', stopGraceMs: 40, stopProofTimeoutMs: 50 });
  try {
    const core = w.runtime.core;
    let seen = null;
    // The platform port is the one reader of the two budgets; with the forwarding missing it was asked for 5000/10000.
    core.ports.stopProof = async args => { seen = args; return { verified: true, subject: args.subject,E:args.E,stopId:args.stopId }; };
    core.member('member:w', 'worker');
    await core.ports.create({memberId:'member:w',cwd:w.root});const agent=w.runtime.handles.get('member:w').agent;
    core.mutate('attempt:budgets','scheduler',{},tx=>tx.put('attempt:budgets',{owner:'member:w',taskId:'task:budgets',lease:'active',fence:1,generation:1,
      executionSessionId:agent.session.id}));
    w.runtime.bindAgent('member:w',{attemptId:'attempt:budgets',fence:1,generation:1});
    const receipt = await core.ports.cancel({ memberId: 'member:w', generation: 1 });
    assert.equal(receipt.stopped, true);
    assert.equal(seen.graceMs, 40, 'the deployed grace period reached the prover');
    assert.equal(seen.proofTimeoutMs, 50, 'and so did the readback budget');
  } finally { await w.close(); }
});
