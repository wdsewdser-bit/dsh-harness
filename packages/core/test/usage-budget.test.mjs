// P6 of the team-autonomy design (docs/decisions/team-autonomy-design.md §8, §12 U2, appendix 6): the delegation
// budget and the usage ledger.
//
// The budget has three units and nothing else: task count, concurrency and token counts measured by DSH. `cost` is
// gone with the switch on -- an amount with no unit never limited anything -- while a stored row that still carries
// one stays readable. Usage is written as an increment per measured boundary, deduplicated by the boundary's own
// identity in the durable inbox, so a replay inside one process and a restart over the same store both count once.
// A count nobody could take is unknown, never zero: past the grace period it opens a decision and stops nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore, budgetSettings, recordUsage, unmeasuredOf, usageOf, usageProjection } from '../index.mjs';
import { delegate } from '../organization.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../runs');
const later = () => new Date(Date.now() + 3600000).toISOString();

function team(label, configuration = {}) {
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'usage-budget-' + label + '-'));
  // Scopes are real absolute paths (normalizeScope realpaths an existing ancestor), so the fixture owns one repo.
  const repo = path.join(dir, 'repo');
  for (const name of ['a', 'b', 'c']) fs.mkdirSync(path.join(repo, name), { recursive: true });
  const store = new ControlStore(dir);
  const core = new TeamCore(store, {}, { enabled: true, autonomy: 'on', subCoordinatorMinWorkers: 1, ...configuration });
  core.member('member:root', 'root');
  core.member('member:w1', 'worker');
  core.member('member:w2', 'worker');
  // A subCoordinator needs its workers to exist first (subCoordinatorMinWorkers), and one is enough here.
  core.member('member:coord', 'subCoordinator');
  return { dir, repo, store, core, at: name => path.join(repo, name),
    close() { core.store.close?.(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const delegation = (t, budget, id = 'delegation:d1') => delegate(t.core, id, 'member:coord', [t.repo], budget, later());

test('§8.2.1: with the switch on a unit-less cost is refused by name; with it off the same budget is HEAD, field for field', () => {
  const on = team('cost-on');
  try {
    assert.equal(budgetSettings(on.core).unknownGraceMs, 1800000, 'the default grace period is the contract default');
    assert.throws(() => delegation(on, { tasks: 2, concurrency: 1, cost: 100 }), { code: 'INVALID_BUDGET_FIELD' });
    assert.equal(on.store.list('delegation:').length, 0, 'the refusal wrote nothing');
    const stored = delegation(on, { tasks: 2, concurrency: 1, tokens: { inputLimit: 1000, outputLimit: 500 } }).result;
    assert.deepEqual(stored.budget, { tasks: 2, concurrency: 1, tokens: { inputLimit: 1000, outputLimit: 500 } });
  } finally { on.close(); }
  const off = team('cost-off', { autonomy: 'off' });
  try {
    const stored = delegation(off, { tasks: 2, concurrency: 1, cost: 100 }).result;
    assert.deepEqual(stored.budget, { tasks: 2, concurrency: 1, cost: 100 }, 'off is HEAD: the same call, the same row');
  } finally { off.close(); }
});

test('§8.2.2: the concurrency count and the attempt write are one transaction', () => {
  const t = team('concurrency');
  try {
    delegation(t, { tasks: 4, concurrency: 1, tokens: null });
    t.core.task('task:one', 'member:w1', [t.at('a')], { delegationRef: 'delegation:d1' });
    t.core.task('task:two', 'member:w2', [t.at('b')], { delegationRef: 'delegation:d1' });
    const first = t.core.schedule('admit-1', 'task:one').result;
    assert.ok(first.attemptId, 'the first admission takes the only slot');
    assert.throws(() => t.core.schedule('admit-2', 'task:two'), { code: 'DELEGATION_CONCURRENCY' });
    assert.equal(t.store.read('task:two').status, 'ready', 'the refused task was not touched');
    assert.equal(t.store.read('task:two').attemptId ?? null, null);
    assert.equal(t.store.list('attempt:').filter(row => row.taskId === 'task:two').length, 0,
      'the refusal rolled the attempt write back with it');
    assert.equal(t.store.read('task:one').status, 'executing', 'the running attempt is exactly as it was');
  } finally { t.close(); }
});

test('§8.2.2: an over-budget delegation refuses new work and never interrupts a running turn', () => {
  const t = team('tokens');
  try {
    delegation(t, { tasks: 4, concurrency: 4, tokens: { inputLimit: 100, outputLimit: 50 } });
    t.core.task('task:a', 'member:w1', [t.at('a')], { delegationRef: 'delegation:d1' });
    t.core.task('task:b', 'member:w2', [t.at('b')], { delegationRef: 'delegation:d1' });
    t.core.task('task:c', 'member:w1', [t.at('c')], { delegationRef: 'delegation:d1' });
    const running = t.core.schedule('admit-a', 'task:a').result;
    recordUsage(t.core, { memberId: 'member:w1', sessionId: 's1', input: 90, output: 40, source: 'usage-event',
      eventKey: 'session:s1:4', revision: 4, totalInput: 90, totalOutput: 40 });
    assert.ok(t.core.schedule('admit-b', 'task:b').result.attemptId, '90/40 is inside the limits');
    recordUsage(t.core, { memberId: 'member:w2', sessionId: 's2', input: 20, output: 20, source: 'usage-event',
      eventKey: 'session:s2:3', revision: 3, totalInput: 20, totalOutput: 20 });
    assert.equal(usageOf(t.store, { delegationRef: 'delegation:d1' }).input, 110, 'the delegation sum is its members');
    assert.throws(() => t.core.schedule('admit-c', 'task:c'), { code: 'DELEGATION_TOKEN_BUDGET' });
    assert.equal(t.store.list('attempt:').filter(row => row.taskId === 'task:c').length, 0, 'no attempt was created');
    assert.equal(t.store.read(running.attemptId).lease, 'active', 'a running turn is never interrupted');
    assert.equal(t.store.read('task:a').status, 'executing');
  } finally { t.close(); }
});

test('§8.2.1 legacy rows: a delegation stored with cost and no tokens stays readable and enforceable', () => {
  const t = team('legacy');
  try {
    t.core.mutate('delegation:old', 'root', {}, tx => tx.put('delegation:old', { owner: 'member:coord',
      approvedScope: [t.repo], budget: { tasks: 3, concurrency: 1, cost: 500 }, expiresAt: later(),
      riskClass: 'bounded' }));
    t.core.task('task:old', 'member:w1', [t.at('a')], { delegationRef: 'delegation:old' });
    t.core.task('task:old2', 'member:w2', [t.at('b')], { delegationRef: 'delegation:old' });
    assert.ok(t.core.schedule('admit-old', 'task:old').result.attemptId,
      'no token limit is not a zero token limit: the stored row still admits');
    assert.throws(() => t.core.schedule('admit-old2', 'task:old2'), { code: 'DELEGATION_CONCURRENCY' },
      'the stored concurrency is still the limit');
  } finally { t.close(); }
});

test('§8.3 replay: one measured boundary counts once, including across a restart', () => {
  const t = team('dedup');
  let reopened = null;
  try {
    const boundary = { memberId: 'member:w1', sessionId: 's1', input: 10, output: 5, eventKey: 'session:s1:7',
      revision: 7, totalInput: 10, totalOutput: 5 };
    assert.equal(recordUsage(t.core, boundary).input, 10);
    assert.deepEqual(recordUsage(t.core, boundary), { duplicate: true }, 'the same boundary, offered twice');
    assert.equal(usageOf(t.store, { memberId: 'member:w1' }).input, 10);
    assert.equal(t.store.list('usage:').length, 1, 'one boundary, one row');
    reopened = new TeamCore(new ControlStore(t.dir), {}, { enabled: true, autonomy: 'on', attach: true });
    assert.deepEqual(recordUsage(reopened, boundary), { duplicate: true },
      'the durable inbox, not process memory, is what refuses the second write');
    assert.equal(usageOf(reopened.store, { memberId: 'member:w1' }).input, 10, 'the restart added nothing');
    assert.equal(reopened.store.list('usage:').length, 1);
  } finally { reopened?.store.close?.(); t.close(); }
});

test('§8.2.3 / §12 U2: an unmeasured count past the grace period opens one decision and stops nothing by itself', () => {
  const base = Date.UTC(2026, 0, 1);
  // The decision TTL is computed from the instant the admission ran, so the team's clock is the same instant the
  // verdict is taken at; otherwise a 2026-01-01 decision is expired by the time the test decides it.
  const clock = base + 90000;
  const t = team('unmeasured', { budget: { unknownGraceMs: 60000 }, now: () => clock });
  try {
    assert.equal(budgetSettings(t.core).unknownGraceMs, 60000, 'the configured grace period is what the admission reads');
    delegation(t, { tasks: 4, concurrency: 4, tokens: { inputLimit: 1000, outputLimit: 1000 } });
    t.core.task('task:a', 'member:w1', [t.at('a')], { delegationRef: 'delegation:d1' });
    t.core.task('task:b', 'member:w2', [t.at('b')], { delegationRef: 'delegation:d1' });
    t.core.task('task:c', 'member:w2', [t.at('c')], { delegationRef: 'delegation:d1' });
    for (const memberId of ['member:w1', 'member:w2']) {
      recordUsage(t.core, { memberId, sessionId: 's-' + memberId, unknown: true, reason: 'measure-unavailable',
        source: 'none', eventKey: 'unmeasured:' + memberId + ':1', now: base });
    }
    assert.ok(t.core.schedule('admit-1', 'task:a', base + 30000).result.attemptId, 'a measurement hole never stops the team');
    assert.equal(t.store.list('decision:').length, 0, 'inside the grace period nothing is opened');
    const admitted = t.core.schedule('admit-2', 'task:b', base + 90000).result;
    assert.ok(admitted.attemptId, 'the admission itself still goes ahead');
    const decisions = t.store.list('decision:').filter(row => row.kind === 'budget-unknown');
    assert.equal(decisions.length, 1, 'the lasting gap became exactly one decision');
    assert.equal(decisions[0].state, 'open');
    assert.equal(decisions[0].subject.id, 'usage-unknown:member:w2');
    assert.deepEqual(decisions[0].options, ['continue', 'stop'], 'the option set is the one root may choose from');
    const receipt = t.core.decideDecision(decisions[0].entityId, 'member:root',
      { decision: 'stop', reason: 'no token measurement for 90s', evidenceRef: decisions[0].evidence[0].ref });
    assert.equal(receipt.result.state, 'decided');
    assert.equal(t.store.read('usage-unknown:member:w2').stopped, true, 'stop is recorded on the row that reported the gap');
    assert.throws(() => t.core.schedule('admit-3', 'task:c'), { code: 'DELEGATION_TOKEN_BUDGET' },
      'new work for that member is refused until a real measurement arrives');
    assert.equal(t.store.read(admitted.attemptId).lease, 'active', 'the running turn was not interrupted');
    recordUsage(t.core, { memberId: 'member:w2', sessionId: 's-member:w2', input: 1, output: 1, source: 'usage-event',
      eventKey: 'session:s-member:w2:11', revision: 11, totalInput: 1, totalOutput: 1, now: base + 120000 });
    assert.equal(unmeasuredOf(t.store, 'member:w2'), null, 'a real measurement ends the gap');
  } finally { t.close(); }
});

test('§8.2.4: a price table moves only the projected amount, never a decision', () => {
  const cheap = team('pricing-cheap', { pricing: { currency: 'USD', perInputToken: 0.000001, perOutputToken: 0.000002 } });
  const dear = team('pricing-dear', { pricing: { currency: 'USD', perInputToken: 1, perOutputToken: 1 } });
  const plain = team('pricing-none');
  const run = t => {
    delegation(t, { tasks: 3, concurrency: 3, tokens: { inputLimit: 100, outputLimit: 100 } });
    t.core.task('task:a', 'member:w1', [t.at('a')], { delegationRef: 'delegation:d1' });
    t.core.task('task:b', 'member:w1', [t.at('b')], { delegationRef: 'delegation:d1' });
    const first = t.core.schedule('admit-1', 'task:a').result;
    assert.ok(first.attemptId, 'the first admission is inside the limits');
    recordUsage(t.core, { memberId: 'member:w1', sessionId: 's1', input: 150, output: 10, source: 'usage-event',
      eventKey: 'session:s1:9', revision: 9, totalInput: 150, totalOutput: 10 });
    let refusal = null;
    try { t.core.schedule('admit-2', 'task:b'); } catch (error) { refusal = error.code; }
    return { admitted: Boolean(first.attemptId), refusal, attempts: t.store.list('attempt:').length,
      usage: usageOf(t.store, { memberId: 'member:w1' }), projected: usageProjection(t.core, { memberId: 'member:w1' }) };
  };
  try {
    const a = run(cheap), b = run(dear);
    assert.deepEqual({ admitted: a.admitted, refusal: a.refusal, attempts: a.attempts },
      { admitted: b.admitted, refusal: b.refusal, attempts: b.attempts },
      'the price table changed no decision: same admission, same refusal, same rows');
    assert.equal(a.refusal, 'DELEGATION_TOKEN_BUDGET');
    assert.deepEqual(a.usage, b.usage, 'the counts are the same measurement');
    assert.notEqual(a.projected.cost.amount, b.projected.cost.amount, 'only the projected amount moves');
    assert.equal(a.projected.input, a.usage.input);
    assert.equal('cost' in usageProjection(plain.core), false, 'without a price table there is no amount at all');
  } finally { cheap.close(); dear.close(); plain.close(); }
});
