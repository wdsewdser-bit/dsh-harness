// §9 overall acceptance, offline performance half: only request counts, batch size and bounded occupancy. This suite
// makes no live latency claim; a controlled live sample set is reported separately as not-run/insufficient.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../packages/store/index.mjs';
import { TeamCore, batchCandidate } from '../../packages/core/index.mjs';
import { Projection } from '../../packages/projections/index.mjs';
import { submit } from '../../packages/projections/commands.mjs';

const future = ms => new Date(Date.now() + ms).toISOString();

function team(label, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's5-perf-' + label + '-'));
  const store = new ControlStore(dir);
  const core = new TeamCore(store, { enabled: true }, { enabled: true, attach: true, teamId: 'team:s5-perf',
    collab: 'on', autonomy: 'on', superagentBorrow: 'v1', intentSemantics: 'root-decision-v1', maxRuns: 1,
    repositories: [{ repositoryKey: 'repo:acme/app', root: dir }], ...overrides });
  core.member('member:root', 'root'); core.member('member:fe', 'worker'); core.member('member:be', 'worker');
  let operations = 0;
  return { dir, store, core, op: name => 'v1:operation:s5-perf-' + label + '-' + name + '-' + String(++operations).padStart(3, '0'),
    close() { try { core.store.close?.(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('offline performance: events, deliveries, batches and capacity have bounded counts (live latency not-run)', () => {
  const t = team('counts');
  try {
    const issueId = 'thread:' + t.op('resource');
    const opened = submit(t.core, 'member:fe', { name: 'threads.openResource', target: issueId, expectedRevision: 0,
      operationId: t.op('open'), args: { resource: { kind: 'branch', repositoryKey: 'repo:acme/app', key: 'refs/heads/main' },
        descriptionRef: 'artifact:desc:1' } });
    assert.equal(opened.status, 'accepted');
    for (const actor of ['member:fe', 'member:be']) submit(t.core, actor, { name: 'threads.subscribe', target: issueId,
      expectedRevision: t.store.read(issueId).revision, operationId: t.op('subscribe-' + actor.slice(-2)), args: {} });
    const before = { attempts: t.store.list('attempt:').length, messages: t.store.list('message:').length,
      decisions: t.store.list('decision:').length };
    for (let index = 0; index < 10; index++) {
      const receipt = submit(t.core, 'member:fe', { name: 'threads.publish', target: issueId,
        expectedRevision: t.store.read(issueId).revision, operationId: t.op('publish-' + index),
        args: { eventType: 'change-reported', summary: 'report ' + index } });
      assert.equal(receipt.status, 'accepted');
    }
    assert.equal(t.store.list('thread-event:' + issueId + ':').length, 10, 'one sequence per publish');
    assert.equal(t.store.list('thread-delivery:' + issueId + ':').length, 20, 'one delivery per subscriber per event');
    assert.equal(t.store.effects().filter(effect => effect.payload.kind === 'wake' && effect.payload.threadRef === issueId).length, 20);
    assert.equal(t.store.list('attempt:').length, before.attempts, 'publishing opens no attempt');
    assert.equal(t.store.list('message:').length, before.messages, 'publishing opens no message');
    assert.equal(t.store.list('decision:').length, before.decisions, 'publishing opens no coordination decision');

    // 40 addressed inputs still become one bounded batch; the budget is the existing 4096-byte one.
    for (let index = 0; index < 40; index++) {
      t.core.send('member:root', 'member:fe', 'action', 'input ' + index, { deadline: future(600000), expectedOutcome: 'ok' });
    }
    const candidate = batchCandidate(t.core, 'member:fe');
    assert(candidate, 'inputs are pending');
    assert(candidate.payload.batch.version === 2);
    assert(candidate.payload.batch.pendingCount >= candidate.payload.inputs.length);
    assert.equal(Number.isSafeInteger(candidate.payload.batch.omittedCount), true);
    assert(Buffer.byteLength(candidate.text) * 2 <= 4096, 'the 4096-byte text budget is unchanged');
    assert(candidate.payload.inputs.length <= candidate.payload.batch.pendingCount);
    // One bounded injection wrote one manifest; no second arbiter or per-item turn.
    assert.equal(t.store.list('manifest:').length, 0, 'building a batch does not commit a manifest');

    // N=1: one work attempt, the next work is refused; the human lane is a separate bounded 1.
    t.core.task('task:a', 'member:fe'); t.core.task('task:b', 'member:be');
    assert.equal(t.core.schedule(t.op('admit-a'), 'task:a').result.attemptId !== undefined, true);
    assert.throws(() => t.core.schedule(t.op('admit-b'), 'task:b'), error => error.code === 'CAPACITY');
    const projection = new Projection({ events: seq => t.store.events(seq), scanEvents: seq => t.store.scanEvents(seq) },
      { protocol: 'v1', maxRuns: t.core.configuration.maxRuns });
    const capacity = projection.snapshot('member:root').data.capacity;
    assert.equal(capacity.normal.current, 1);
    assert.equal(capacity.normal.limit, 1);
    assert.equal(capacity.human.limit, 1);
    assert.equal(capacity.admissionClosed, false);
    assert.equal(capacity.providerCapacity, 'unknown');
    console.log('live latency: not-run (offline counts only; no provider request was made)');
  } finally { t.close(); }
});
