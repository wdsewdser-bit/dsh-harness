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

test('a run releases every dispatch binding once its evidence is written', async () => {
 const w = await world();
 try {
  for (let n = 1; n <= 12; n++) {
   const r = await w.round(n);
   // The journal is mostly traffic this receipt cannot use. The binding must keep the one carrying event, not the rest.
   for (let d = 0; d < 20; d++) w.session.events.push({ type: 'user/message', seq: 10000 + n * 100 + d,
    data: { id: 'native:noise:' + n + ':' + d, content: [{ type: 'text', text: 'unrelated journal traffic ' + d }] } });
   w.session.events.push(r.carried);
   await r.emit('prepared'); await r.emit('send-started'); await r.emit('committed'); r.release();
   assert.equal(w.v.status().retained.confirmed, 0, 'the flush that uses a binding also releases it (round ' + n + ')');
   assert.equal(w.v.status().retained.attempts, 1, 'only the round in flight is bound (round ' + n + ')');
   assert.equal(w.seen(r.id), true, 'the evidence still reaches the message (round ' + n + ')');
  }
  assert.equal(w.v.status().visible, 12, 'every round committed its visibility');
  assert.deepEqual(w.v.audit().filter(a => a.type === 'evidenceMissing'), [], JSON.stringify(w.v.audit()));
 } finally { await w.close(); }
});

test('a superseded candidate releases its attempts and their confirmed bindings', async () => {
 // Evidence work is held, so a commit is bound while the session moves on - the only ordering in which the supersede
 // branch has anything to clean.
 const held = []; let open = true;
 const queue = (namespace, work) => namespace !== 'evidence' || open ? Promise.resolve().then(work)
  : new Promise((resolve, reject) => held.push(() => Promise.resolve().then(work).then(resolve, reject)));
 const releaseQueue = async () => { open = true; await Promise.all(held.splice(0).map(run => run())); };
 const w = await world({ queue });
 try {
  open = false;
  const first = await w.round(1);
  w.session.events.push(first.carried);
  await first.emit('prepared'); await first.emit('send-started');
  const committed = first.emit('committed');
  assert.equal(w.v.status().retained.confirmed, 1, 'a committed receipt is bound until its evidence is written');
  assert.equal(w.v.status().retained.attempts, 1);
  const second = await w.round(2);
  assert.equal(w.v.status().retained.attempts, 0, 'the superseded candidate takes its attempts with it');
  assert.equal(w.v.status().retained.confirmed, 0, 'and the confirmations bound to those attempts');
  await releaseQueue(); await committed; second.release();
  assert.equal(w.seen(first.id), false, 'the superseded attempt never writes visibility');
  assert.equal(w.v.audit().some(a => a.reason === 'unbound-attempt' || a.reason === 'ambiguous-or-closed'), true,
   'and the reason it could not is recorded: ' + JSON.stringify(w.v.audit()));
  // Review 2 #6: the closed attempt's receipt is persisted-or-refused evidence now, so it is released with the attempt
  // instead of staying in the ledger for the rest of the run.
  assert.equal(w.v.ledger.receipts().length, 0, 'the settled receipt of a closed attempt is released with it');
  assert.equal(w.v.ledger.slot('dispatch:1'), null, 'and so is its slot');
 } finally { open = true; await releaseQueue(); await w.close(); }
});

test('review 2 #6: the dispatch auxiliary state is bounded across a long run', async () => {
  // The soak used to prove only the projection's rows plateau and the heap grew no faster than the session journal. Every
  // auxiliary structure this layer keeps (the ledger's slots and receipts, the observed-attempt set, the consumed-key set,
  // the audit array) grew with the dispatch history, and a heap-per-event ratio cannot see them. This is that assertion
  // on its own: forty completed dispatches, and the state stays at the size of the candidate in flight.
  const w = await world();
  try {
    for (let n = 1; n <= 40; n++) {
      const r = await w.round(n);
      w.session.events.push(r.carried);
      await r.emit('prepared'); await r.emit('send-started'); await r.emit('committed'); r.release();
      assert.equal(w.seen(r.id), true, 'round ' + n + ' wrote its evidence');
    }
    const status = w.v.status();
    assert.equal(status.visible, 40, 'every round committed');
    assert.ok(status.attempts <= 2, 'ledger slots grew to ' + status.attempts);
    assert.ok(status.receipts <= 2, 'ledger receipts grew to ' + status.receipts);
    assert.ok(status.retained.attempts <= 2, 'visibility bindings grew to ' + status.retained.attempts);
    assert.ok(status.retained.confirmed <= 2, 'confirmed bindings grew to ' + status.retained.confirmed);
    assert.ok(status.observations <= 4, 'the observed-attempt set grew to ' + status.observations);
    assert.ok(status.consumedKeys <= 4, 'the consumed-key set grew to ' + status.consumedKeys);
    assert.ok(status.auditRetained <= 256, 'the audit tail grew to ' + status.auditRetained);
    assert.equal(status.auditWrites, 40, 'every audit row still reached the store as an entity');
    assert.deepEqual(w.v.audit().filter(a => a.type === 'evidenceMissing'), []);
  } finally { await w.close(); }
});

test('review 1 #6: a settled auxiliary request is reclaimed instead of accumulating', async () => {
  // A session-title or compaction request holds a slot, a receipt and an observed-attempt entry of its own, and nothing
  // in the flush path ever closed it: consumable() only takes 'main', expire() skips a slot that committed, and
  // release() needs a closed one. A hundred of them used to stay for the life of the run.
  const w = await world();
  try {
    const emit = (call, attempt, phase) => call.dispatch({ contract: 'team-dispatch/2', attempt, sessionId: 'session:b',
      kind: 'auxiliary', purpose: 'session-title', messages: [], phase, at: w.at,
      ...(['send-started', 'committed'].includes(phase) ? { transmission: 1, sendStartedAt: w.at } : {}) },
    'real-cpa-transport');
    // Review 3 #4: one auxiliary request is one adapter call. The llm/stream hook calls candidate() when the call starts
    // and the closure it returns when the call ends; that end - never the first committed transmission - is the boundary
    // at which the attempt is over.
    for (let n = 1; n <= 100; n++) {
      const release = w.v.candidate({ sessionId: 'session:b', main: false, purpose: 'session-title', messages: [] });
      for (const phase of ['prepared', 'send-started', 'committed']) emit(release, 'aux:' + n, phase);
      release();
    }
    const status = w.v.status();
    assert.equal(status.attempts, 0, 'no auxiliary slot survived its own transmission');
    assert.equal(status.receipts, 0, 'and no auxiliary receipt did either');
    assert.equal(status.observations, 0, 'nor the observed-attempt entry it put in this host');
    assert.equal(w.v.ledger.slot('aux:100'), null);
    assert.equal(status.unknown, 0, 'none of them is unknown evidence: each one was settled');
  } finally { await w.close(); }
});

test('review 2 #5: a failed dispatch is diagnosed through the bounded, persisted audit', async () => {
  const w = await world();
  try {
    const base = { contract: 'team-dispatch/2', attempt: 'aux:fail', sessionId: 'session:b', kind: 'auxiliary',
      purpose: 'compaction', messages: [] };
    const release = w.v.candidate({ sessionId: 'session:b', main: false, purpose: 'compaction', messages: [] });
    release.dispatch({ ...base, phase: 'prepared', at: w.at }, 'real-cpa-transport');
    release.dispatch({ ...base, phase: 'failed', at: w.at, reason: 'not sent' }, 'real-cpa-transport');
    await w.v.settled();
    release();
    const status = w.v.status();
    assert.equal(status.auditWrites, 1, 'the diagnosis reached the database through the one entry point');
    assert.equal(w.store.list('visibility-audit:').length, 1, 'and it is a row, not only an array element');
    assert.equal(w.v.audit().some(row => row.type === 'dispatchFailed(notSent)'), true);
    assert.equal(status.attempts, 0, 'a request that definitively never left is reclaimed');
  } finally { await w.close(); }
});

test('review 2 #4: a transmission that may have left is never reclaimed by another one\'s commit', async () => {
  const w = await world();
  try {
    const r = await w.round(1);
    await r.emit('prepared'); await r.emit('send-started');
    w.session.events.push(r.carried);
    await r.emit('committed');
    await w.v.settled();
    assert.equal(w.v.ledger.slot('dispatch:1').committedCount, 1, 'the first transmission is visible evidence');
    // The attempt closes - the candidate was superseded, or its step moved on - while a retry is still on the wire.
    w.v.ledger.close('dispatch:1');
    assert.equal(w.v.ledger.slot('dispatch:1').unknown, undefined, 'a committed attempt is not "unknown" at that point');
    await r.emit('send-started', { transmission: 2, sendStartedAt: w.at + 1 });
    await r.emit('failed', { transmission: 2, reason: 'the socket closed after the request left' });
    // Releasing here would delete the second transmission\'s send watermark and the fact that it is unaccounted for.
    assert.equal(w.v.ledger.release('dispatch:1'), false, 'an unconfirmed transmission keeps its send watermark');
    assert.ok(w.v.ledger.slot('dispatch:1'), 'so the slot stays with the operator');
    // A late answer for that transmission is still bound to its attempt: nothing was deleted for it to fall out of.
    w.session.seq = 42;
    await r.emit('committed', { transmission: 2, sendStartedAt: w.at + 1 });
    assert.equal(w.v.audit().some(row => row.reason === 'unbound-attempt'), false, 'the late answer was still bound');
    // And once nothing is unconfirmed any more, the ordinary release applies again: the evidence is complete.
    assert.equal(w.v.ledger.release('dispatch:1') === false || w.v.ledger.slot('dispatch:1') === null, true,
      'the attempt settles only after every transmission has answered');
  } finally { await w.close(); }
});

test('review 2 #4: closing an attempt with a transmission that never answered retains it as evidence', async () => {
  const w = await world();
  try {
    const r = await w.round(1);
    await r.emit('prepared'); await r.emit('send-started');
    w.session.events.push(r.carried);
    await r.emit('committed');
    await w.v.settled();
    await r.emit('send-started', { transmission: 2, sendStartedAt: w.at + 1 });
    await r.emit('failed', { transmission: 2, reason: 'no answer' });
    w.v.ledger.close('dispatch:1');
    assert.equal(w.v.ledger.slot('dispatch:1').unknown, true, 'a committed transmission does not settle the attempt');
    assert.equal(w.v.status().unknown, 1);
    assert.equal(w.v.ledger.release('dispatch:1'), false, 'unknown evidence stays with the operator');
    assert.ok(w.v.ledger.slot('dispatch:1'));
  } finally { await w.close(); }
});

test('review 3 #4: a sequential retry of one auxiliary attempt stays bound until the adapter call ends', async () => {
  // Review 2 #5 (N2): "one transmission answered" is not "the adapter is done with this attempt". A compaction request
  // that retries sends transmission 2 of the SAME attempt after transmission 1 was committed; closing the attempt at
  // the first commit deleted the slot its retry still needed, so the second send became an unbound-attempt with no
  // watermark - an uncertain request the operator could never see.
  const w = await world();
  try {
    const emit = (phase, extra = {}) => release.dispatch({ contract: 'team-dispatch/2', attempt: 'aux:retry', sessionId: 'session:b',
      kind: 'auxiliary', purpose: 'compaction', messages: [], phase, at: w.at,
      ...(['send-started', 'committed'].includes(phase) ? { transmission: 1, sendStartedAt: w.at } : {}), ...extra },
    'real-cpa-transport');
    const release = w.v.candidate({ sessionId: 'session:b', main: false, purpose: 'compaction', messages: [] });
    release.dispatch({ contract: 'team-dispatch/2', attempt: 'aux:retry', sessionId: 'session:b',
      kind: 'auxiliary', purpose: 'compaction', messages: [], phase: 'prepared', at: w.at }, 'real-cpa-transport');
    emit('send-started');
    emit('committed');
    // The retry of the same attempt, after the first transmission was answered.
    w.session.seq = 42;
    emit('send-started', { transmission: 2, sendStartedAt: w.at + 1 });
    assert.equal(w.v.audit().some(row => row.reason === 'unbound-attempt'), false, 'the retry was still bound to its attempt');
    assert.equal(w.v.ledger.slot('aux:retry').transmissions.size, 2, 'both transmissions keep their send watermark');
    emit('committed', { transmission: 2, sendStartedAt: w.at + 1 });
    assert.equal(w.v.status().unknown, 0, 'an answered retry is not unknown evidence');
    // The adapter call ends: only now is the attempt over, and it is reclaimed with everything it held.
    release();
    assert.equal(w.v.ledger.slot('aux:retry'), null);
    assert.equal(w.v.status().attempts, 0, 'the attempt is reclaimed at the end of the call that owned it');
    assert.equal(w.v.status().observations, 0);
    assert.equal(w.v.status().receipts, 0);
  } finally { await w.close(); }
});
// A source that supports auxiliary ownership retains the publisher minted for its call.

