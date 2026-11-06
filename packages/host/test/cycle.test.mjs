// The cycle skeleton; M1b design §3.2, §3.3 (F2/F11 land in B, this pins the contract they extend).
import test from 'node:test';
import assert from 'node:assert/strict';
import { real } from '../test-support/real.mjs';
import { id } from '../../contracts/index.mjs';
import { createClock } from '../src/clock.mjs';
import { CYCLE_STEPS, createCycle } from '../src/cycle.mjs';
import { createTeamHost } from '../index.mjs';
import { commands, fakeCore, removeDir, tempDir, waitFor } from '../test-support/helpers.mjs';

test('every step runs in the fixed order and an uninstalled step is skipped and counted', async () => {
  const seen = [];
  const cycle = createCycle({
    steps: {
      tick: () => { seen.push('tick'); return { changed: 1 }; },
      drain: () => { seen.push('drain'); return { consumed: 2 }; },
      pump: () => { seen.push('pump'); return { claimed: 1 }; },
    },
  });
  const round = await cycle.run('manual');
  assert.deepEqual(seen, ['tick', 'drain', 'pump']);
  assert.equal(round.progress, true);
  for (const name of CYCLE_STEPS) assert.ok(round.steps[name], 'step ' + name + ' is reported');
  assert.equal(round.steps.reconcile.skipped, 1);
  assert.equal(round.steps.publish.skipped, 1);
  assert.equal(cycle.status().rounds, 1);
});

test('a kick during a round runs again afterwards, without a round ceiling', async () => {
  let rounds = 0;
  let cycle = null;
  const steps = {
    drain: async () => {
      rounds += 1;
      // An external input arrives while the round is still running: it must buy another round, not be dropped.
      if (rounds === 1) cycle.kick('session-event');
      return { consumed: 1 };
    },
  };
  cycle = createCycle({ steps });
  await cycle.kick('gateway');
  assert.equal(rounds, 2, 'the second round was scheduled by the kick that arrived mid-round');
  assert.equal(cycle.status().coalesced, 1);
  assert.equal(cycle.status().dirty, false);
});

test('an empty round makes no progress and the cycle never wakes itself', async () => {
  let internal = 0;
  const cycle = createCycle({
    steps: {
      tick: () => ({ due: false }),
      drain: () => ({ consumed: 0, changed: 0 }),
      pump: ({ noteProgress }) => { noteProgress('pump'); return {}; },
    },
    onStep: (_name, _step, round) => {
      if (round.progress) internal += 1;
    },
  });
  await cycle.run('manual');
  const status = cycle.status();
  assert.equal(status.noProgressRounds, 1, 'a round that changed nothing is counted, not retried');
  assert.equal(status.kicks, 0, 'noteProgress never kicks');
  assert.equal(status.internalProgress, 1, 'internal commits are counted separately');
  assert.equal(internal, 0);
});

test('stop clears the timer and refuses further rounds', async () => {
  const clock = createClock();
  const cycle = createCycle({ clock, intervalMs: 5, steps: { drain: () => ({ consumed: 1 }) } });
  await waitFor(() => cycle.status().rounds > 0, 'a timer-driven round');
  const frozen = cycle.stop();
  assert.equal(clock.size, 0, 'the cycle timer was cleared with the cycle');
  const rounds = cycle.status().rounds;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(cycle.status().rounds, rounds, 'no round runs after stop()');
  assert.equal(await cycle.kick('late'), null);
  assert.ok(frozen.rounds >= 1);
});

test('the host owns one clock and starts the cycle only after it is running', async () => {
  const dir = tempDir('cycle-host');
  let internalKicks = 0;
  const host = createTeamHost({
    teamId: 'team:cycle', root: dir, ownerSessionId: 'session:cycle',
    commands, core: fakeCore(), recoverer: async () => ({ status: 'ok', admission: true }),
    steps: { drain: () => ({ consumed: 1 }), pump: ({ noteProgress }) => { internalKicks += 1; noteProgress('pump'); return {}; } },
    cycleIntervalMs: 20,
  });
  try {
    assert.equal(host.cycle, null, 'no cycle before start()');
    await host.start();
    assert.ok(host.cycle, 'the cycle is installed once the host runs');
    assert.equal(host.clock.size > 0, true);
    await waitFor(() => host.status().cycle.rounds > 0, 'a cycle round');
    assert.equal(host.status().lastCycle.progress, true);
    assert.ok(internalKicks > 0);
    await host.stop();
    assert.equal(host.clock.size, 0, 'stop() clears every timer of the host clock');
  } finally {
    await host.stop();
    removeDir(dir);
  }
});

test('F2 real inputs in each merged round reach four rounds without spin', async () => {
 const w = await real(); let cycle; let seen = 0;
 try {
  cycle = createCycle({ access: w.host.coreAccess.lifecycle(), steps: { publish: () => {
    seen++;
    if (seen < 4) { w.core.mutate('message:input-' + seen, 'scheduler', {}, tx => tx.put('message:input-' + seen, { kind: 'info', status: 'stored' }));
      cycle.kick('external'); cycle.kick('merged'); }
    cycle.noteProgress('internal'); return {};
  } } });
  await cycle.kick('first');
  assert.equal(seen, 4); assert.equal(cycle.status().dirty, false);
  assert.equal(w.store.cursor('dispatch'), w.store.events().filter(e => e.entity.startsWith('message:')).at(-1).seq);
  assert.equal(cycle.status().kicks, 7); assert.equal(cycle.status().rounds, 4);
  const before = w.snapshot(); for (let i = 0; i < 20; i++) await cycle.run();
  assert.equal(w.snapshot(), before); assert.equal(cycle.status().rounds, 24);
 } finally { cycle?.stop(); await w.close(); }
});

test('real external gateway commit kicks once; internal cursor/admission commits never kick back', async () => {
 const w = await real({ commands: { input: { kind: 'business', reduce: tx => tx.put('message:external', { kind: 'info', status: 'stored' }) } } });
 try {
  const receipt = w.host.command({ requestId: 'request:b', teamId: 'team:b', actor: 'root', operationId: id('operation'), payload: { command: 'input',
    entityId: 'message:external' } });
  assert.equal(receipt.result.status, 'confirmed');
  await waitFor(() => !w.host.cycle.status().running, 'gateway cycle');
  assert.equal(w.host.cycle.status().kicks, 1); assert.equal(w.host.cycle.status().rounds, 1);
  assert.equal(w.store.cursor('dispatch'), w.store.events().at(-1).seq);
  const before = w.snapshot(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(w.host.cycle.status().rounds, 1); assert.equal(w.snapshot(), before);
 } finally { await w.close(); }
});
