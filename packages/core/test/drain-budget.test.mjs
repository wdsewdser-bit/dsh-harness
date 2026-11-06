// Review 1, item 7: one limited delegation must not stop the drain.
//
// admitTask() answers DELEGATION_CONCURRENCY / DELEGATION_TOKEN_BUDGET for a task the budget refuses. Those are scheduling
// answers, like CAPACITY and BLOCKED: the drain has to count them and keep admitting the candidates behind them. Before
// the fix the first refused task threw out of the loop and every later, healthy candidate was never attempted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore, drain } from '../index.mjs';
import { delegate } from '../organization.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../runs');
const later = () => new Date(Date.now() + 3600000).toISOString();

function team(label) {
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'drain-budget-' + label + '-'));
  const repo = path.join(dir, 'repo');
  for (const name of ['a', 'b', 'c']) fs.mkdirSync(path.join(repo, name), { recursive: true });
  const store = new ControlStore(dir);
  const core = new TeamCore(store, {}, { enabled: true, autonomy: 'on', subCoordinatorMinWorkers: 1 });
  core.member('member:root', 'root');
  core.member('member:w1', 'worker');
  core.member('member:w2', 'worker');
  core.member('member:coord', 'subCoordinator');
  return { dir, repo, store, core, at: name => path.join(repo, name),
    close() { core.store.close?.(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('§8.2.3: a refused delegation is counted and the healthy candidate behind it is admitted', () => {
  const t = team('concurrency');
  try {
    delegate(t.core, 'delegation:d1', 'member:coord', [t.repo], { tasks: 4, concurrency: 1, tokens: null }, later());
    // The limited candidate is created FIRST, so the drain meets it before the healthy one.
    t.core.task('task:first', 'member:w1', [t.at('a')], { delegationRef: 'delegation:d1' });
    t.core.task('task:limited', 'member:w2', [t.at('b')], { delegationRef: 'delegation:d1' });
    t.core.task('task:ok', 'member:w2', [t.at('c')]);
    assert.ok(t.core.schedule('admit-first', 'task:first').result.attemptId, 'the one slot is taken');
    const outcomes = drain(t.core);
    assert.equal(outcomes.rejected, 1, 'DELEGATION_CONCURRENCY is a scheduling refusal, not a drain failure');
    assert.equal(outcomes.length, 1, 'and the healthy candidate was attempted');
    assert.equal(t.store.read('task:ok').status, 'executing');
    assert.equal(t.store.read('task:limited').status, 'ready', 'the refused task was left untouched');
    assert.equal(t.store.list('attempt:').filter(row => row.taskId === 'task:limited').length, 0);
  } finally { t.close(); }
});

// Two drains of one team in two processes rewrite the same wake row between the read that built the command's
// expectedRevision and its commit: the loser sees CAS_CONFLICT. That is the optimistic-retry signal, not a failure of
// the pass - before the fix it threw out of the wake loop and out of the candidate loop, so every candidate behind
// the lost race went unattempted for that pass (with the borrow switch on, that is how a whole H allocation vanishes
// while the N lane keeps its slot).
test('§8.2.3: a revision lost to a concurrent writer is re-read and the pass still admits every candidate', () => {
  const t = team('cas');
  try {
    const raced = code => Object.assign(Error(code), { code });
    const realTask = t.core.task.bind(t.core), realSchedule = t.core.schedule.bind(t.core);
    realTask('task:ok', 'member:w1', [t.at('a')]);
    t.core.send('member:root', 'member:w2', 'action', 'invisible mail',
      { expectedOutcome: 'a report', deadline: later() });
    let taskRace = 1, scheduleRace = 1;
    t.core.task = (...args) => { if (taskRace-- > 0) throw raced('CAS_CONFLICT'); return realTask(...args); };
    t.core.schedule = (eventId, taskId, ...rest) => {
      if (scheduleRace-- > 0) throw raced('CAS_CONFLICT');
      return realSchedule(eventId, taskId, ...rest);
    };
    const outcomes = drain(t.core);
    assert.equal(outcomes.rejected, 0, 'a lost revision is re-read, not counted as a refusal');
    assert.equal(outcomes.length, 2, 'the candidate that lost the race and the wake behind it are both admitted');
    assert.equal(t.store.read('task:ok').status, 'executing');
    assert.equal(t.store.list('attempt:').filter(row => row.taskId === 'task:mail-member:w2').length, 1,
      'the wake the wake loop lost is still opened');
  } finally { t.close(); }
});
