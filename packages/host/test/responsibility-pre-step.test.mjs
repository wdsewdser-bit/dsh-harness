import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
import { prepareVisibility } from '../src/visibility/pre-step.mjs';
import { createVisibility } from '../index.mjs';
import { summariseDispatchMessages } from '../../contracts/index.mjs';
import { real } from '../test-support/real.mjs';
import { simulateMailboxRequests } from '../test-support/simulated-mailbox-requests.mjs';
test('every pre-step includes multiple pending responsibilities, not just the first mailbox item', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-step-responsibility-'));
  const store = new ControlStore(root), core = new TeamCore(store, {}, { enabled: true });
  try {
    core.member('member:root', 'root'); core.member('member:a', 'worker'); core.member('member:b', 'worker');
    const ids = ['one', 'two'].map(text => core.send('member:b', 'member:a', 'action', text,
      { expectedOutcome: 'ack', deadline: new Date(Date.now() + 600000).toISOString() }).result.entityId);
    const candidate = prepareVisibility(core, 'member:a');
    assert.equal(candidate.manifest.messageIds.length, 2);
    assert.deepEqual(new Set(candidate.manifest.messageIds), new Set(ids));
    for (const id of ids) assert(candidate.text.includes(id));
    assert.equal(candidate.payload.responsibilityPage.omittedCount, 0);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('production pre-step/dispatch drains 12 actions plus info one carrying page per committed boundary', async () => {
  const w = await real(); let visibility;
  try {
    w.core.member('member:root', 'root'); w.core.member('member:a', 'worker');
    const ids = Array.from({ length: 13 }, (_, i) => w.core.send('member:root', 'member:a', i === 12 ? 'info' : 'action',
      'single-page backlog ' + i, { expectedOutcome: 'ack', deadline: new Date(Date.now() + 600000).toISOString() }).result.entityId);
    const session = { seq: 0, events: [], snapshotEvents() { return this.events; } };
    visibility = createVisibility({ host: w.host, core: w.core, sessions: new Map([['session:a', session]]),
      routeExecution: () => ({ routed: true, teamId: 'team:b', memberId: 'member:a', generation: 1 }),
      isMain: options => options.main, leaseMs: 100000 });
    for (let boundary = 0; ids.some(id => !w.store.read(id).visible); boundary++) {
      assert(boundary < ids.length, 'single-page FIFO must meet the U=13 committed-boundary bound');
      const expected = prepareVisibility(w.core, 'member:a').manifest.messageIds;
      const before = new Set(ids.filter(id => w.store.read(id).visible));
      const message = await visibility.preStep('session:a', 'native:backlog-' + boundary);
      session.events.push({ type: 'user/message', seq: ++session.seq, data: { id: message.id, content: message.content } });
      const release = visibility.candidate({ sessionId: 'session:a', main: true, messages: [message] });
      const base = { contract: 'team-dispatch/2', attempt: 'dispatch:backlog-' + boundary, sessionId: 'session:a', kind: 'main',
        purpose: null, messages: summariseDispatchMessages([message]), at: w.at };
      for (const phase of ['prepared', 'send-started', 'committed']) await visibility.dispatch({ ...base, phase,
        ...(['send-started', 'committed'].includes(phase) ? { transmission: 1, sendStartedAt: w.at } : {}) }, 'real-cpa-transport');
      release();
      const newlySeen = ids.filter(id => !before.has(id) && w.store.read(id).visible);
      assert.deepEqual(newlySeen, expected.filter(id => !before.has(id)), 'no omitted item gains request evidence');
      assert(newlySeen.length > 0);
    }
    assert(w.store.read(ids.at(-1)).visible, 'the tail info actually appeared in a native carrying page');
    assert.equal(w.core.pending('member:a').length, ids.length, 'visible responsibility stays pending');
  } finally { visibility?.stop(); await w.close(); }
});

test('scheduling-only fixture commits exactly its one page, never all omitted pages', async () => {
  const w = await real();
  try {
    w.core.member('member:root', 'root'); w.core.member('member:a', 'worker');
    const ids = Array.from({ length: 13 }, (_, i) => w.core.send('member:root', 'member:a', 'info', 'fixture backlog ' + i).result.entityId);
    const expected = prepareVisibility(w.core, 'member:a');
    assert(expected.payload.responsibilityPage.omittedCount > 0);
    const runtime = { ...w, preempt: { deliverMail: () => ({ wake: 'woke' }) } };
    simulateMailboxRequests(runtime);
    runtime.preempt.deliverMail('member:a', ids[0]);
    assert.equal(w.store.list('manifest:').length, 1, 'one schedule is exactly one request source');
    assert.deepEqual(ids.filter(id => w.store.read(id).visible), expected.manifest.messageIds);
    for (const id of ids.filter(id => !expected.manifest.messageIds.includes(id))) {
      assert.equal(w.store.read(id).visible, false, 'an omitted item has no visibility');
      assert.equal(w.store.read(id).observation, undefined);
    }
  } finally { await w.close(); }
});
