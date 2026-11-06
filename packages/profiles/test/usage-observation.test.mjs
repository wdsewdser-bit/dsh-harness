// P6 of the team-autonomy design (§8.2.2, §8.2.3, §12 U2): the measurement boundary in the profile.
//
// The one place a session's spend becomes a ledger row. What is pinned here: the exact source wins when the token
// meter has provider samples, the estimate is used (and marked) when it does not, a repeated observation at the same
// revision adds nothing, and a measurement that cannot be taken becomes an unknown row plus a clock - never a zero.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore, unmeasuredOf, usageOf } from '../../core/index.mjs';
import { observeNative } from '../native-observations.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../runs');

function core(label) {
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'usage-observation-' + label + '-'));
  const store = new ControlStore(dir);
  const team = new TeamCore(store, {}, { enabled: true, autonomy: 'on', attach: true });
  return { dir, store, team, close() { store.close?.(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const session = (seq, id = 'session:s1') => ({ id, seq, snapshotEvents: () => [] });
/* A context whose token meter publishes the durable usage totals (and, optionally, a measure() estimate). */
const exact = (totals, seq, estimate = null) => ({
  tokenMeter: { contextPressure: () => ({}), measure: () => estimate ?? { logRevision: seq, totalTokens: 0 } },
  sessionProjections: { stateOf: (s, key) => (key === 'tokenUsage' ? totals : {}) },
});
const estimated = (totalTokens, seq) => ({
  tokenMeter: { contextPressure: () => ({}), measure: () => ({ logRevision: seq, totalTokens }) },
  sessionProjections: { stateOf: () => undefined },
});
const blind = {
  tokenMeter: { contextPressure: () => ({}), measure: () => { throw Error('METER_DOWN'); } },
  sessionProjections: { stateOf: () => { throw Error('PROJECTIONS_DOWN'); } },
};

test('§8.2.2: provider-reported totals become one increment per session revision', () => {
  const t = core('exact');
  try {
    observeNative(exact({ uncachedInputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 0, outputTokens: 40 }, 10),
      t.team, 'member:w1', session(10));
    const first = usageOf(t.store, { memberId: 'member:w1' });
    assert.equal(t.store.list('usage:').length, 1);
    assert.equal(first.input, 120, 'cache traffic is prompt side');
    assert.equal(first.output, 40);
    assert.equal(first.source, 'usage-event');
    assert.equal(first.approximate, false, 'a provider sample is an exact count');
    observeNative(exact({ uncachedInputTokens: 200, cacheReadTokens: 20, cacheWriteTokens: 0, outputTokens: 90 }, 11),
      t.team, 'member:w1', session(11));
    const second = usageOf(t.store, { memberId: 'member:w1' });
    assert.equal(t.store.list('usage:').length, 2, 'a new revision is a new boundary');
    assert.equal(second.input, 220, 'the rows add up to the latest cumulative reading');
    assert.equal(second.output, 90);
  } finally { t.close(); }
});

test('§8.3: an observation at a revision already recorded adds nothing', () => {
  const t = core('same-revision');
  try {
    const ctx = exact({ uncachedInputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 }, 7);
    observeNative(ctx, t.team, 'member:w1', session(7));
    observeNative(ctx, t.team, 'member:w1', session(7));
    observeNative(ctx, t.team, 'member:w1', session(7));
    assert.equal(t.store.list('usage:').length, 1, 'the same boundary is one row');
    assert.equal(usageOf(t.store, { memberId: 'member:w1' }).input, 50);
  } finally { t.close(); }
});

test('§12 U2: without provider samples the meter estimate is used and marked approximate', () => {
  const t = core('estimate');
  try {
    observeNative(estimated(500, 3), t.team, 'member:w1', session(3));
    observeNative(estimated(700, 4), t.team, 'member:w1', session(4));
    const usage = usageOf(t.store, { memberId: 'member:w1' });
    assert.equal(t.store.list('usage:').length, 2);
    assert.equal(usage.input, 700, 'the increments reconstruct the estimate');
    assert.equal(usage.source, 'delta');
    assert.equal(usage.approximate, true, 'an estimate is never presented as a count');
  } finally { t.close(); }
});

test('§8.2.3: a measurement that cannot be taken is unknown, one row per minute, and starts the clock', () => {
  const t = core('unmeasured');
  try {
    observeNative(blind, t.team, 'member:w1', session(1));
    observeNative(blind, t.team, 'member:w1', session(2));
    const rows = t.store.list('usage:');
    assert.equal(rows.length, 1, 'the observation tick is not a measurement boundary');
    assert.equal(rows[0].unknown, true);
    assert.equal(rows[0].reason, 'measure-unavailable');
    assert.equal(rows[0].input, null, 'nothing is recorded as zero');
    const usage = usageOf(t.store, { memberId: 'member:w1' });
    assert.equal(usage.unknown, true);
    assert.equal(usage.counted, 0);
    const clock = unmeasuredOf(t.store, 'member:w1');
    assert.ok(clock, 'the gap is a durable clock, which is what the grace period reads');
    assert.equal(clock.reason, 'measure-unavailable');
  } finally { t.close(); }
});

test('§8.2.2: every boundary is diffed against the latest MEASUREMENT, never against the row version', () => {
  const t = core('three-boundaries');
  let reopened = null;
  try {
    const reading = (total, revision) => exact({ uncachedInputTokens: total, cacheReadTokens: 0, cacheWriteTokens: 0,
      outputTokens: 0 }, revision);
    for (const [total, revision] of [[100, 10], [200, 11], [300, 12]]) {
      observeNative(reading(total, revision), t.team, 'member:w1', session(revision));
    }
    const rows = t.store.list('usage:');
    assert.equal(rows.length, 3, 'three boundaries, three rows');
    assert.deepEqual(rows.map(row => row.revision), [1, 1, 1],
      'the row version is the entity counter: every boundary is a new row, so it can never order measurements');
    assert.deepEqual(rows.map(row => row.logRevision), [10, 11, 12], 'the measurement revision has its own column');
    assert.equal(usageOf(t.store, { memberId: 'member:w1' }).input, 300,
      'the increments add up to the last cumulative reading (the defect counted 400)');
    // A restart over the same store: the duplicate boundary adds nothing, and the next one still diffs against 300.
    reopened = new TeamCore(new ControlStore(t.dir), {}, { enabled: true, autonomy: 'on', attach: true });
    observeNative(reading(300, 12), reopened, 'member:w1', session(12));
    assert.equal(reopened.store.list('usage:').length, 3, 'the replayed boundary is the same boundary');
    observeNative(reading(400, 13), reopened, 'member:w1', session(13));
    assert.equal(usageOf(reopened.store, { memberId: 'member:w1' }).input, 400, 'the increment is 100, not 300');
  } finally { reopened?.store?.close?.(); t.close(); }
});

test('§8.2.2 legacy rows: the measurement revision is recovered from the event key', () => {
  const t = core('legacy-key');
  try {
    // A row written before the column existed: its measurement sequence is the one its event key was built from, and the
    // entity revision (1) must not be read as if it were the log revision.
    t.team.mutate('usage:member:w1:session:session:s1:9', 'adapter', {}, tx => tx.put('usage:member:w1:session:session:s1:9', {
      memberId: 'member:w1', sessionId: 'session:s1', input: 90, output: 0, source: 'usage-event', approximate: false,
      eventKey: 'session:session:s1:9', totalInput: 90, totalOutput: 0, unknown: false, measuredAt: Date.now() }));
    observeNative(exact({ uncachedInputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, 10),
      t.team, 'member:w1', session(10));
    assert.equal(usageOf(t.store, { memberId: 'member:w1' }).input, 120, 'the increment is 30 over the recovered baseline');
  } finally { t.close(); }
});
