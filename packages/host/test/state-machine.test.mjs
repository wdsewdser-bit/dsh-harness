// Offline feature tests for the host state machine; docs/host-protocol.md §2.1 and invariant 9.
// The defect these pin: stop() and start() used to race with no owner of the transition graph, so a host could jump
// back from stopping, run a second time after stop, or stay half started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HOST_STATES, HOST_TRANSITIONS, HostStateMachine, isLegalTransition } from '../index.mjs';

const legalPairs = () => {
  const pairs = [];
  for (const from of HOST_STATES) for (const to of HOST_STATES) if (isLegalTransition(from, to)) pairs.push(from + '->' + to);
  return pairs.sort();
};

test('the spec graph is the whole graph: six spec edges plus the two created-state edges', () => {
  assert.deepEqual(legalPairs(), [
    'created->starting',
    'created->stopping',
    'recovering->running',
    'recovering->stopping',
    'running->stopping',
    'starting->recovering',
    'starting->stopping',
    'stopping->stopped',
  ]);
  for (const from of HOST_STATES) assert.ok(Array.isArray(HOST_TRANSITIONS[from]), 'missing row for ' + from);
});

test('every other pair is illegal and is refused instead of guessed', () => {
  const legal = new Set(legalPairs());
  for (const from of HOST_STATES) {
    for (const to of HOST_STATES) {
      if (legal.has(from + '->' + to)) continue;
      assert.equal(isLegalTransition(from, to), false, from + ' -> ' + to);
      assert.throws(
        () => new HostStateMachine({ state: from }).transition(to),
        error => error.code === 'INVALID_STATE',
        from + ' -> ' + to + ' should be refused',
      );
    }
  }
});

test('the jumps back that the old code allowed are exactly the illegal ones', () => {
  for (const pair of [['running', 'recovering'], ['stopping', 'running'], ['stopping', 'starting'], ['recovering', 'starting'], ['running', 'starting']]) {
    assert.equal(isLegalTransition(pair[0], pair[1]), false, pair.join(' -> '));
  }
});

test('stopped is terminal: no edge leaves it', () => {
  assert.deepEqual(HOST_TRANSITIONS.stopped, []);
  const machine = new HostStateMachine({ state: 'stopped' });
  for (const next of HOST_STATES) {
    assert.throws(() => machine.transition(next), error => error.code === 'INVALID_STATE', 'stopped -> ' + next);
  }
  assert.equal(machine.state, 'stopped');
});

test('a legal walk records an append-only history and notifies each listener once per step', () => {
  const machine = new HostStateMachine({ now: () => 7 });
  const seen = [];
  const unsubscribe = machine.onChange(step => seen.push(step.to));
  machine.transition('starting');
  machine.transition('recovering');
  machine.transition('stopping');
  unsubscribe();
  machine.transition('stopped');
  assert.deepEqual(seen, ['starting', 'recovering', 'stopping'], 'an unsubscribed listener hears nothing');
  assert.deepEqual(
    machine.history.map(step => step.from + '>' + step.to),
    ['created>starting', 'starting>recovering', 'recovering>stopping', 'stopping>stopped'],
  );
  assert.ok(machine.history.every(step => step.at === 7));
});

test('a throwing listener is reported and cannot undo or block the transition', () => {
  const seen = [];
  const machine = new HostStateMachine({ onListenerError: (error, step) => seen.push({ code: error.code, step: step.to }) });
  machine.onChange(() => {
    throw Object.assign(new Error('observer failed'), { code: 'OBSERVER_FAILED' });
  });
  machine.onChange(step => seen.push({ code: 'ok', step: step.to }));
  const step = machine.transition('starting');
  assert.equal(machine.state, 'starting');
  assert.equal(step.to, 'starting');
  assert.deepEqual(seen, [{ code: 'OBSERVER_FAILED', step: 'starting' }, { code: 'ok', step: 'starting' }]);
});

test('a refused transition leaves the state and the history untouched', () => {
  const machine = new HostStateMachine({ state: 'running' });
  assert.throws(() => machine.transition('recovering'), error => error.code === 'INVALID_STATE');
  assert.throws(() => machine.transition('running'), error => error.code === 'INVALID_STATE');
  assert.equal(machine.state, 'running');
  assert.deepEqual(machine.history, []);
});
