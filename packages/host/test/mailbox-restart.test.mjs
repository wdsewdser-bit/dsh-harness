import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
import { createTeamHost } from '../index.mjs';

for (const point of ['before-drain', 'after-task-before-schedule', 'after-schedule-before-cursor']) {
 test('durable mailbox rebind survives restart at ' + point, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rebind-'));
  let store, core, host;
  const at = Date.now();
  async function open() {
   store = new ControlStore(root);
   core = new TeamCore(store, {}, { enabled: true, teamId: 'team:rebind', now: () => at });
   host = createTeamHost({ root, core, teamId: 'team:rebind', now: () => at, cycleIntervalMs: 1000000,
     recoverer: async () => ({ status: 'ok', admission: true }), openStore: () => ({ close() {} }) });
   await host.start();
  }
  try {
   await open(); core.member('member:s', 'root'); core.member('member:r', 'worker');
   const messageId = core.send('member:s', 'member:r', 'action', 'work', { expectedOutcome: 'done', deadline: new Date(at + 3600000).toISOString(
     ) }).result.entityId;
   await host.cycle.run();
   const first = store.list('attempt:')[0]; assert.ok(first);
   core.finish(first.entityId, first.fence, 'cancelled');
   // Use the real public domain command, preserving messageId and advancing bindingGeneration.
   core.dispatch(messageId, 'operator', { recipient: 'member:r', evidenceRef: 'evidence:rebind' },
     { type: 'message.rebind', payload: { messageId, recipient: 'member:r', evidenceRef: 'evidence:rebind' } });
   assert.equal(store.read(messageId).bindingGeneration, 1);
   let interrupted = false;
   if (point === 'after-task-before-schedule') {
    core.schedule = () => { interrupted = true; throw Object.assign(Error('restart'), { code: 'RESTART' }); };
    const round = await host.cycle.run(); assert.equal(round.steps.drain.error, 'RESTART');
    assert.equal(store.read('task:mail-member:r').status, 'ready');
    assert.equal(store.list('attempt:').length, 1);
   } else if (point === 'after-schedule-before-cursor') {
    const mutate = core.mutate.bind(core);
    core.mutate = (entityId, ...args) => {
     if (entityId === 'dispatch-cursor') { interrupted = true; throw Object.assign(Error('restart'), { code: 'RESTART' }); }
     return mutate(entityId, ...args);
    };
    const cursor = store.cursor('dispatch');
    const round = await host.cycle.run(); assert.equal(round.steps.drain.error, 'RESTART');
    assert.equal(store.list('attempt:').length, 2); assert.equal(store.cursor('dispatch'), cursor);
   }
   if (point !== 'before-drain') assert.equal(interrupted, true);
   const epoch = host.status().epoch;
   await host.stop(); store.close(); await open();
   assert.ok(host.status().epoch > epoch);
   await host.cycle.run();
   assert.equal(store.list('attempt:').length, 2, 'new binding is admitted exactly once across restart');
   assert.equal(store.effects().filter(e => e.payload.kind === 'start').length, 2);
   const bindings = store.read('task:mail-member:r').mailboxMessages.map(JSON.parse);
   assert.deepEqual(bindings, [[messageId, 'member:r', 1, 0], [messageId, 'member:r', 1, 1]]);
   const snapshot = () => JSON.stringify({ rows: store.list(), events: store.events(), effects: store.effects() });
   const before = snapshot();
   for (let i = 0; i < 20; i++) await host.cycle.run();
   assert.equal(snapshot(), before);
  } finally { await host?.stop(); store?.close(); fs.rmSync(root, { recursive: true, force: true }); }
 });
}
