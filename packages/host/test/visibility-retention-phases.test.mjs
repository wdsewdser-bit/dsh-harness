import test from 'node:test';
import { registerHostVisibility } from '../../profiles/index.mjs';
import { visibilityDirty } from '../src/visibility/dirty.mjs';
import assert from 'node:assert/strict';
import { real } from '../test-support/real.mjs';
import { createVisibility } from '../index.mjs';
import { summariseDispatchMessages } from '../../contracts/index.mjs';

/**
 * §22.8: a visibility instance holds two per-dispatch bindings - the attempt (prepared/send-started watermarks) and the
 * confirmed receipt (the few journal events flush needs) - until something releases them. The offline soak's 30-minute
 * heap plateau is what exposed them: the map that never shrank was small per entry but unbounded per dispatch, and every
 * commit additionally cloned the whole session journal into the binding. These tests pin the release rules, not the
 * implementation: they read status().retained and the evidence the flush still produces.
 */

import { world } from '../test-support/visibility-retention-fixtures.mjs';

function adapterCalls(w) {
  const hooks = new Map(), publishers = new Map();
  registerHostVisibility({ on(name, fn) { hooks.set(name, fn); return () => {}; } }, w.v,
    { host: w.host, markDirty: visibilityDirty, sessionIdOf: () => 'session:b', newMessageId: () => 'unused', pathOf: () => 'real-cpa-transport' });
  const raw = (attempt, phase, transmission = 1) => ({
    contract: 'team-dispatch/2', attempt, sessionId: 'session:b', kind: 'auxiliary', purpose: 'compaction', messages: [],
    phase, at: w.at, ...(['send-started', 'committed'].includes(phase) ? { transmission, sendStartedAt: w.at + transmission } : {}),
  });
  const emit = (attempt, phase, transmission) => publishers.get(attempt)(raw(attempt, phase, transmission), 'real-cpa-transport');
  const stream = (attempt, body) => (async function* () {
    const release = w.v.candidate({ sessionId: 'session:b', main: false, purpose: 'compaction', messages: [] });
    publishers.set(attempt, release.dispatch);
    try { emit(attempt, 'prepared'); yield* body(phase => emit(attempt, phase)); }
    finally { release(); }
  })();
  return { emit, stream, raw, hooks };
}

test('ownership C: overlapping auxiliary iterators close only their own attempt sets', async () => {
  const w = await world();
  try {
    const { stream } = adapterCalls(w);
    const a = stream('aux:A', async function* (emit) { emit('send-started'); emit('committed'); yield 'A'; });
    const b = stream('aux:B', async function* (emit) { emit('send-started'); yield 'B'; emit('committed'); });
    await a.next(); await b.next();
    assert.equal(w.v.ledger.slot('aux:B').closedAt, null);
    await a.next(); // A finally must not close B, which is still awaiting its answer.
    assert.equal(w.v.ledger.slot('aux:A'), null);
    assert.equal(w.v.ledger.slot('aux:B').closedAt, null, 'A has no ownership of B');
    assert.equal(w.v.status().unknown, 0);
    await b.next();
    assert.equal(w.v.ledger.slot('aux:B'), null);
    assert.equal(w.v.status().attempts, 0);
    assert.equal(w.v.status().receipts, 0);
    assert.equal(w.v.status().observations, 0);
    assert.equal(w.v.status().unknown, 0);
  } finally { await w.close(); }
});

test('ownership D: B prepared cannot retire A before A produces tx2 and terminates', async () => {
  const w = await world();
  try {
    const { emit, stream } = adapterCalls(w);
    const a = stream('aux:A', async function* (send) {
      send('send-started'); send('committed'); yield 'tx1';
      emit('aux:A', 'send-started', 2); yield 'tx2';
      emit('aux:A', 'committed', 2);
    });
    const b = stream('aux:B', async function* (send) { send('failed'); yield 'B'; });
    await a.next(); await b.next(); // Known A transmissions answered, but A iterator is not done.
    assert.ok(w.v.ledger.slot('aux:A'), 'B prepared is not termination evidence for A');
    await a.next();
    assert.equal(w.v.ledger.slot('aux:A').transmissions.size, 2);
    assert.equal(w.v.audit().some(row => row.reason === 'unbound-attempt'), false);
    await b.next();
    assert.ok(w.v.ledger.slot('aux:A'), 'B finally is not termination evidence for A either');
    await a.next();
    assert.equal(w.v.status().attempts, 0);
    assert.equal(w.v.status().receipts, 0);
    assert.equal(w.v.status().observations, 0);
    assert.equal(w.v.status().unknown, 0);
  } finally { await w.close(); }
});

test('unverified auxiliary phases are explicitly refused before retention', async () => {
  const w = await world();
  try {
    const { raw, hooks } = adapterCalls(w);
    for (const phase of ['prepared', 'send-started', 'committed']) hooks.get('llm/dispatch')(raw('aux:unowned', phase));
    await w.v.settled(); w.at += 200000; w.v.expire(); await w.v.settled();
    assert.equal(w.v.status().attempts, 0);
    assert.equal(w.v.status().receipts, 0);
    assert.equal(w.v.status().observations, 0);
    assert.equal(w.v.status().unknown, 0);
    assert.ok(w.v.audit().some(row => row.reason === 'auxiliary-call-unverified'));
    assert.ok(w.store.list('visibility-audit:').some(row => row.reason === 'auxiliary-call-unverified'));
    // Rejection is an admission refusal, never a claim that an unobserved send did not execute.
    assert.equal(w.v.audit().some(row => row.type === 'dispatchFailed(notSent)'), false);
  } finally { await w.close(); }
});

for (const boundary of ['outside', 'inside-B']) test('callback prepared ' + boundary + ' keeps original call ownership', async () => {
  const w = await world();
  try {
    const { raw } = adapterCalls(w);
    const a = w.v.candidate({ sessionId: 'session:b', main: false, purpose: 'compaction', messages: [] });
    // A registers a callback. Triggering it does not carry A's ambient async context.
    const callback = phase => a.dispatch(raw('aux:A', phase), 'real-cpa-transport');
    let b;
    if (boundary === 'inside-B') b = w.v.candidate({ sessionId: 'session:b', main: false, purpose: 'compaction', messages: [] });
    callback('prepared'); callback('send-started');
    b?.();
    assert.equal(w.v.ledger.slot('aux:A').closedAt, null, 'B cannot close A');
    assert.equal(w.v.status().unknown, 0);
    callback('committed');
    assert.equal(w.v.ledger.slot('aux:A').committedCount, 1);
    a();
    await w.v.settled();
    assert.equal(w.v.status().attempts, 0);
    assert.equal(w.v.status().receipts, 0);
    assert.equal(w.v.status().observations, 0);
    assert.equal(w.v.status().unknown, 0);
  } finally { await w.close(); }
});

test('forged, mismatched and ended-call prepared cannot enter the ledger', async () => {
  const w = await world();
  try {
    const { raw } = adapterCalls(w);
    const a = w.v.candidate({ sessionId: 'session:b', main: false, purpose: 'session-title', messages: [] });
    assert.equal(a.dispatch(raw('aux:wrong-purpose', 'prepared')).accepted, false);
    assert.equal(w.v.dispatch(raw('aux:forged', 'prepared'), 'other', () => {}).accepted, false);
    a();
    assert.equal(a.dispatch({ ...raw('aux:late', 'prepared'), purpose: 'session-title' }).accepted, false);
    assert.equal(w.v.status().observations, 0);
    assert.equal(w.v.status().attempts, 0);
  } finally { await w.close(); }
});

test('every phase after legal prepared requires the same capability', async () => {
  const w = await world();
  try {
    const { raw } = adapterCalls(w);
    const a = w.v.candidate({ sessionId: 'session:b', main: false, purpose: 'compaction', messages: [] });
    const b = w.v.candidate({ sessionId: 'session:b', main: false, purpose: 'compaction', messages: [] });
    a.dispatch(raw('aux:A', 'prepared')); a.dispatch(raw('aux:A', 'send-started'));
    const slot = w.v.ledger.slot('aux:A');
    for (const event of [raw('aux:A', 'prepared'), raw('aux:A', 'send-started', 2), raw('aux:A', 'committed'), raw('aux:A', 'failed')]) {
      assert.equal(w.v.dispatch(event).accepted, false, 'unidentified ' + event.phase + ' was rejected');
      assert.equal(b.dispatch(event).accepted, false, 'sibling capability cannot publish ' + event.phase);
    }
    assert.equal(slot.transmissions.size, 1, 'no forged send watermark');
    assert.equal(slot.committedCount, 0, 'no forged receipt');
    assert.equal(slot.failedCount, 0, 'no forged failure');
    assert.equal(w.v.ledger.receipts().length, 0);
    a.dispatch(raw('aux:A', 'committed')); a(); b();
    await w.v.settled();
    assert.equal(w.v.status().attempts, 0, 'the actual source can still finish normally');
    assert.equal(w.v.status().unknown, 0);
  } finally { await w.close(); }
});

test('stored kind cannot be relabelled to bypass auxiliary ownership', async () => {
  const w = await world();
  try {
    const { raw } = adapterCalls(w);
    const a = w.v.candidate({ sessionId: 'session:b', main: false, purpose: 'compaction', messages: [] });
    a.dispatch(raw('aux:A', 'prepared')); a.dispatch(raw('aux:A', 'send-started'));
    for (const phase of ['prepared', 'send-started', 'committed', 'failed']) {
      const forged = { ...raw('aux:A', phase), kind: 'main', purpose: null };
      assert.equal(w.v.dispatch(forged).accepted, false);
      assert.equal(a.dispatch(forged).accepted, false);
    }
    assert.equal(w.v.ledger.slot('aux:A').committedCount, 0);
    assert.equal(w.v.ledger.slot('aux:A').failedCount, 0);
    a();
    assert.equal(w.v.status().unknown, 1, 'a real unanswered send remains unknown');
    assert.equal(w.v.dispatch(raw('aux:A', 'committed')).accepted, false, 'late forgery cannot erase unknown');
    assert.ok(w.v.ledger.slot('aux:A'));
  } finally { await w.close(); }
});

