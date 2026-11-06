import test from 'node:test';
import assert from 'node:assert/strict';
import { borrowRelease } from '../borrow-entry-support.mjs';

test('borrowRelease fails closed on a missing or malformed borrow.release', () => {
  for (const config of [{}, { borrow: {} }, { borrow: { release: '' } }, { borrow: { release: 123 } }, null]) {
    assert.throws(() => borrowRelease(config), err => err.code === 'PATCH_MISSING', JSON.stringify(config));
  }
});

test('borrowRelease returns the configured release', () => {
  assert.equal(borrowRelease({ borrow: { release: '0.2.2-rc.1' } }), '0.2.2-rc.1');
  assert.equal(typeof borrowRelease(), 'string');
});
