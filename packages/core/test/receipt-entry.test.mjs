import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore, handleTool } from '../index.mjs';
import { digest } from '../../contracts/index.mjs';

/**
 * Should-fix review 2 #3 entry acceptance: the same operationId answers with the same durable receipt, a different
 * payload under it conflicts, a compacted receipt is a typed refusal instead of a silent null result, and none of it
 * writes anything a second time.
 */
test('tool entry: same-argument replay, conflicting replay, compacted refusal and zero duplicate effects', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-entry-'));
  const store = new ControlStore(dir);
  try {
    const core = new TeamCore(store, {}, { enabled: true, autonomy: 'on', attach: true, teamId: 'team:entry', collab: 'on' });
    core.member('member:root', 'root');
    core.member('member:r', 'worker');
    const args = { operationId: 'v1:operation:entry-0001', op: 'send', kind: 'intent', to: ['member:r'], summary: 'interface',
      taskRef: 'task:r', contractRevision: 1 };
    const binding = { actor: 'member:root' };
    const command = core.command('tool-intent:' + args.operationId, 'member:root', { name: 'team_message', args, binding }, args.operationId, { now: 1 });
    store.commit(command, tx => { tx.put('thread-delivery:entry', { state: 'visible', threadRef: 'thread:entry' });
      return { ok: true, padding: 'x'.repeat(4000) }; });
    // Compact it: the terminal delivery loses its event once the dispatch reader is past it, and no retained row names
    // the receipt, so the operation leaves the receipts window.
    store.commit({ entityId: 'cursor:entry', teamId: 'team:entry', actor: 'scheduler', operationId: 'v1:operation:entry-cursor',
      expectedRevision: 0, payload: {}, payloadHash: digest({}) }, tx => {
      const seq = tx.latestEventSeq(); tx.put('cursor:entry', { at: 1 }); tx.cursor('dispatch', seq); return null; });
    const pass = store.retainEvidence({ limits: { receipts: 0, deliveries: 0, events: 0 } });
    assert(pass.compacted.receipts >= 1);
    assert(store.receiptOf(command).receipt.compacted, 'the receipt is compacted, keeping its identity');
    const entities = store.list().length, events = store.events().length;
    // Same arguments: the durable answer is a typed refusal, never a null result body.
    assert.throws(() => handleTool(core, binding, 'team_message', args), error => error?.code === 'RECEIPT_COMPACTED');
    // Same operationId with different arguments: a conflict, not a replay.
    assert.throws(() => handleTool(core, binding, 'team_message', { ...args, summary: 'different' }), error => error?.code === 'ID_CONFLICT');
    assert.equal(store.list().length, entities, 'no duplicate side effects');
    assert.equal(store.events().length, events, 'no new journal rows');
    assert.equal(store.receiptOf(command).receipt.result, null, 'the store-level replay answer keeps the summary, not the body');
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});