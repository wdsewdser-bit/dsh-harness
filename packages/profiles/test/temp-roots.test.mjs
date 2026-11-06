import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupDirs, cleanupOrThrow, withStore } from '../test-support/temp-roots.mjs';

test('temp cleanup: every directory is attempted and all final errors are collected', () => {
  const attempts = new Map();
  const errors = cleanupDirs(['a', 'b', 'c'], { attempts: 3, delayMs: 0, remove(dir) {
    attempts.set(dir, (attempts.get(dir) ?? 0) + 1);
    if (dir === 'a') throw Error('permanent a');
    if (dir === 'b' && attempts.get(dir) < 2) throw Error('transient b');
  } });
  assert.equal(attempts.get('a'), 3);
  assert.equal(attempts.get('b'), 2);
  assert.equal(attempts.get('c'), 1);
  assert.deepEqual(errors.map(e => e.dir), ['a']);
  assert.match(errors[0].error.message, /permanent a/);
});

test('temp cleanup: a successful body with a failed final deletion is red', () => {
  assert.throws(() => cleanupOrThrow(['a'], null, { attempts: 1, delayMs: 0, remove: () => { throw Error('delete failed'); } }),
    error => /final cleanup failed/.test(error.message) && error.cleanupErrors?.[0]?.error?.message === 'delete failed');
});

test('temp cleanup: a failed body keeps the primary error and attaches cleanup errors', () => {
  const primary = Object.assign(Error('primary assertion'), { code: 'PRIMARY' });
  assert.throws(() => cleanupOrThrow(['a', 'b'], primary, { attempts: 1, delayMs: 0,
    remove: dir => { throw Error('delete ' + dir); } }), error => error === primary &&
      error.cleanupErrors?.length === 2 && error.cleanupErrors[0].error.message === 'delete a');
});

test('temp cleanup: withStore keeps the body error when close also fails, and close alone is red', () => {
  class FailingClose { constructor() {} close() { throw Error('close failed'); } }
  assert.throws(() => withStore(FailingClose, 'root', () => 'ok'), /close failed/);
  const primary = Object.assign(Error('body failed'), { code: 'BODY' });
  assert.throws(() => withStore(FailingClose, 'root', () => { throw primary; }), error => error === primary &&
    error.cleanupErrors?.[0]?.message === 'close failed');
});
