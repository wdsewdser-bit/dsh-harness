import test from 'node:test';
import assert from 'node:assert/strict';
import { real } from '../test-support/real.mjs';
import { handleTool } from '../../core/index.mjs';
import { id } from '../../contracts/index.mjs';
test('F11 twenty idle host rounds do not grow the journal or wake themselves', async () => {
 const w = await real(); try {
  const before = w.snapshot(); let commits = 0; w.store.hooks.beforeCommit = () => { commits++; };
  for (let i = 0; i < 20; i++) await w.host.cycle.run();
  assert.equal(w.snapshot(), before); assert.equal(commits, 0); assert.equal(w.host.cycle.status().rounds, 20);
  assert.equal(w.host.cycle.status().kicks, 0); assert.equal(w.host.cycle.status().dirty, false);
 } catch(error){w.recordError(error);throw error;} finally { await w.close(); }
});
for (const offset of [-1, 0, 1]) for (const clockFirst of [false, true]) test('F15 objection/deadline offset ' + offset + ', clock first ' + clockFirst, async (
  ) => {
 const w = await real(); try {
  w.core.member('member:s', 'root'); w.core.member('member:r', 'worker');
  w.core.mutate('task:plan', 'scheduler', {}, tx => tx.put('task:plan', { status: 'draft', owner: 'member:s', contractRevision: 1 }));
  const receipt = w.core.send('member:s', ['member:r'], 'intent', 'plan', { taskRef: 'task:plan', contractRevision: 1 });
  const id = receipt.result.entityId, deadline = w.store.read(id).closesAt;
  w.at = deadline + offset;
  if (clockFirst) await w.host.cycle.run();
  w.core.replyIntent(id, 'member:r', 'object');
  await w.host.cycle.run();
  assert.equal(w.store.read(id).decision, offset < 0 ? 'objected' : 'passed');
  assert.equal(w.store.read(id).seenSummary, 'seenNone');
  assert.equal(w.store.effects().filter(e => e.id === 'intent-result:' + id).length, 1);
 } catch(error){w.recordError(error);throw error;} finally { await w.close(); }
});

test('host cycle reconciles an expired applying claim once, not on idle rounds', async () => {
 const w = await real(); try {
  w.core.mutate('seed', 'scheduler', {}, tx => { tx.outbox('cancel:a', { kind: 'cancel', attemptId: 'attempt:a' }); return null; });
  w.host.coreAccess.lifecycle().claim('cancel:a', 'adapter', 10);
  await w.host.cycle.run(); assert.equal(w.store.effects()[0].status, 'applying');
  w.at += 11; await w.host.cycle.run(); assert.equal(w.store.effects()[0].status, 'unknown');
  const before = w.snapshot(); let commits = 0; w.store.hooks.beforeCommit = () => commits++;
  for (let i = 0; i < 20; i++) await w.host.cycle.run();
  assert.equal(w.snapshot(), before); assert.equal(commits, 0);
 } catch(error){w.recordError(error);throw error;} finally { await w.close(); }
});

for (const offset of [-1, 0, 1]) for (const clockFirst of [false, true]) test('F15 real handleTool uses host time: ' + offset + ', clock first ' + clockFirst,
  async () => {
 const w = await real(); try {
  // Deliberately far from wall time: falling back to Date.now cannot accidentally pass.
  w.at = Date.UTC(2040, 0, 1); w.core.configuration.collab = 'on'; w.core.configuration.intentWindowMs = 1000;
  const bindings = {};
  for (const m of ['s', 'r']) {
   w.core.member('member:' + m, 'worker'); w.core.task('task:' + m, 'member:' + m);
   const a = w.core.schedule('tool-admit-' + m, 'task:' + m, w.at).result;
   bindings[m] = { actor: 'member:' + m, attemptId: a.attemptId, fence: a.fence };
  }
  const commands = [], command = w.core.command.bind(w.core);
  w.core.command = (...args) => { const c = command(...args); commands.push(c); return c; };
  const args = { operationId: id('operation'), op: 'send', kind: 'intent', to: ['member:r'], summary: 'interface', taskRef: 'task:s', contractRevision: 1 };
  const openedAt = w.at;
  const receipt = handleTool(w.core, bindings.s, 'team_message', args);
  const messageId = receipt.result.entityId;
  assert.equal(receipt.result.openedAt, openedAt); assert.equal(receipt.result.closesAt, openedAt + 1000);
  const firstCommand = commands.at(-1);
  assert.equal(firstCommand.now, openedAt); assert.equal(Object.hasOwn(firstCommand.payload, 'now'), false);
  const beforeBad = w.snapshot();
  assert.throws(() => handleTool(w.core, bindings.r, 'team_message', { operationId: id('operation'), op: 'reply', messageId, verdict: 'object', now:
    openedAt - 1 }));
  assert.equal(w.snapshot(), beforeBad);
  w.at = openedAt + 1000 + offset;
  if (clockFirst) await w.host.cycle.run();
  handleTool(w.core, bindings.r, 'team_message', { operationId: id('operation'), op: 'reply', messageId, verdict: 'object' });
  await w.host.cycle.run();
  const row = w.store.read(messageId);
  assert.equal(row.decision, offset < 0 ? 'objected' : 'passed');
  assert.equal(offset < 0 ? row.votes['member:r'].at : row.lateReplies.at(-1).at, w.at);
  assert.equal(w.store.effects().filter(e => e.id === 'intent-result:' + messageId).length, 1);
  // Same business request at a different trusted instant must replay, not conflict or create a message.
  const beforeReplay = w.snapshot(); w.at += 5000;
  assert.deepEqual(handleTool(w.core, bindings.s, 'team_message', args), receipt);
  assert.equal(commands.at(-1).payloadHash, firstCommand.payloadHash);
  assert.equal(commands.at(-1).now, w.at); assert.equal(w.snapshot(), beforeReplay);
 } catch(error){w.recordError(error);throw error;} finally { await w.close(); }
});
