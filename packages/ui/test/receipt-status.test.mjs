import test from 'node:test';
import assert from 'node:assert/strict';

// ui.mjs is a browser module (React comes from the DSH module loader): stub the globals, then import it.
globalThis.React = { createElement: () => null, Fragment: Symbol('Fragment'), useState: () => [null, () => {}], useEffect: () => {},
  useRef: () => ({ current: null }), useSyncExternalStore: () => null, useMemo: x => x, useCallback: x => x };
globalThis.ReactDOM = { createPortal: () => null };
const { RECEIPT_STATUS_TEXT, receiptSeverity } = await import('../src/ui.mjs');

/**
 * Should-fix review 2 #3: the browser already receives status:'compacted' from the command projection. The operator
 * must see a real explanation and a warning colour, never 'compacted — undefined' painted as success.
 */
test('compacted receipts are explained in the client, with a warning severity', () => {
  const text = RECEIPT_STATUS_TEXT.compacted;
  assert.equal(typeof text, 'string');
  assert.match(text, /RECEIPT_COMPACTED/);
  assert.match(text, /不要换新 operationId/);
  assert.equal(receiptSeverity('compacted'), 'warn');
  assert.equal(receiptSeverity('accepted'), 'ok');
  assert.equal(receiptSeverity('rejected'), 'bad');
});