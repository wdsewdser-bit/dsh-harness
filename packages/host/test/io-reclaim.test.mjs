import test from 'node:test';
import assert from 'node:assert/strict';
import { createEffectRunner, createClock } from '../index.mjs';
test('IO slots survive logical stop and require trusted external proof', async () => {
  const clock = createClock(); let proof = false;
  const effect = { id: 'effect:hung', payload: { kind: 'wake' }, status: 'pending', tries: 0, nextDue: 0 };
  const route = { effects: () => [effect], claim: () => ({ result: { ...effect, fence: 1 } }),
    registerEffect: () => ({ assertDispatch() {}, complete() {}, close() {} }) };
  const runner = createEffectRunner({ access: { lifecycle: () => route }, clock, capacity: 1,
    ports: { wake: () => new Promise(() => {}) }, verifyStopped: async ({ effectId, evidenceRef }) => proof && effectId === effect.id &&
      evidenceRef === 'external:stop' });
  runner.pump(); await Promise.resolve(); await Promise.resolve();
  assert.equal(runner.status().activeIO, 1);
  assert.equal(runner.status().occupants[0].effectId, effect.id);
  assert(runner.status().occupants[0].durationMs >= 0);
  runner.stop(); await runner.whenIdle();
  assert.equal(runner.status().activeIO, 1);
  await assert.rejects(runner.reclaim(effect.id, 'external:stop'), /STOP_NOT_CONFIRMED|trusted external stop proof/);
  assert.equal(runner.status().activeIO, 1);
  proof = true; await runner.reclaim(effect.id, 'external:stop');
  assert.equal(runner.status().activeIO, 0);
  assert.equal(runner.status().audit.at(-1).code, 'EXTERNAL_STOP_CONFIRMED');
  clock.stopAll();
});
