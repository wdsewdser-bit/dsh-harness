import test from 'node:test';
import assert from 'node:assert/strict';
import { observeMailboxTurn } from '../mailbox-observation.mjs';
function world() {
  const listeners = new Set(); let valid = true, releases = 0, removals = 0;
  const watcher = observeMailboxTurn({
    listen(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    valid: () => valid, openTurn: () => null,
    turnOf: event => Number.isInteger(event?.data?.turn) ? event.data.turn : null,
    onDone() { removals++; }, onRelease() { releases++; },
  });
  return { watcher, listeners, invalidate() { valid = false; },
    emit(type) { for (const fn of [...listeners]) fn({ type }); },
    get releases() { return releases; }, get removals() { return removals; } };
}
test('A.begin B.begin B.close start A.arm end keeps A start', () => {
  const w = world(), a = w.watcher.begin(), b = w.watcher.begin();
  w.watcher.cancel(b);
  w.emit('turn/start');
  w.watcher.arm({ kind: 'next', turn: null, window: a });
  w.emit('turn/end');
  assert.equal(w.releases, 1);
  assert.equal(w.listeners.size, 0);
});
test('cancelling A cannot consume B events or a pre-window start', () => {
  const w = world(); w.emit('turn/start');
  const a = w.watcher.begin(), b = w.watcher.begin();
  w.watcher.cancel(a); w.emit('turn/end');
  w.watcher.arm({ kind: 'next', turn: null, window: b });
  assert.equal(w.releases, 0);
  w.emit('turn/start'); w.emit('turn/end');
  assert.equal(w.releases, 1);
});
test('stale close actively removes watcher without another session event', () => {
  const w = world(), a = w.watcher.begin();
  w.invalidate(); w.watcher.cancel(a);
  assert.equal(w.listeners.size, 0);
  assert.equal(w.removals, 1);
  assert.equal(w.releases, 0);
});
test('start then wake throws discards observation, never releases lease', () => {
  const w = world(), a = w.watcher.begin();
  w.emit('turn/start'); w.watcher.cancel(a, true); w.emit('turn/end');
  assert.equal(w.listeners.size, 0);
  assert.equal(w.releases, 0);
  assert.equal(w.removals, 1);
});
test('failing sibling observation cannot revoke a still-pending merge', () => {
  const w = world(), a = w.watcher.begin(), b = w.watcher.begin();
  w.watcher.cancel(b, true); w.emit('turn/start');
  w.watcher.arm({ kind: 'next', turn: null, window: a }); w.emit('turn/end');
  assert.equal(w.releases, 1);
});
