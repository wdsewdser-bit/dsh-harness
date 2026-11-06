import { failWith } from '../../contracts/index.mjs';

/**
 * Port contracts and timing helpers for the host. docs/host-protocol.md §2.1 rule 3, invariant 9 rules 4-5.
 *
 * openStore({ teamId, dir, epoch }) -> store | null    MUST be synchronous. A promise is a contract violation
 *                                                     (INVALID_STORE_PORT), because a half-opened store must not be
 *                                                     mistaken for an open one during recovery.
 * store.close() -> undefined | Promise<void>          MAY be asynchronous. Its completion is counted in the same
 *                                                     monotonic deadline as the rest of stop(); a close that does not
 *                                                     finish inside the budget is reported as isolated, never as closed.
 */
export const DEFAULT_STOP_TIMEOUT_MS = 30000;

/** Monotonic milliseconds: the stop budget must not move when the wall clock does. */
export function monotonicNow() {
  return performance.now();
}

export function stoppedError(detail) {
  return Object.assign(new Error('HOST_STOPPED: ' + detail), { code: 'HOST_STOPPED', detail });
}

export function describeError(error, at) {
  const code = error && error.code !== undefined ? String(error.code) : 'ERROR';
  const message = error && error.message ? error.message : String(error);
  return { code, message, at };
}

/** Validate the stop options before anything is cached, so one bad call cannot poison later ones. */
export function readStopTimeout(options) {
  const timeoutMs = options && options.timeoutMs !== undefined ? options.timeoutMs : DEFAULT_STOP_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    failWith('INVALID_TIMEOUT', 'timeoutMs must be a non-negative finite number of milliseconds, got ' + String(options && options.timeoutMs));
  }
  return timeoutMs;
}

/** Wait for one promise inside a deadline: 'settled', 'timeout' or 'none' when there is nothing in flight. */
export async function settleWithin(promise, deadline, now = monotonicNow) {
  if (!promise) return 'none';
  const remaining = deadline - now();
  if (remaining <= 0) {
    Promise.resolve(promise).catch(() => {});
    return 'timeout';
  }
  let timer = null;
  const budget = new Promise(resolve => {
    timer = setTimeout(() => resolve('timeout'), remaining);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([Promise.resolve(promise).then(() => 'settled', () => 'settled'), budget]);
  } finally {
    clearTimeout(timer);
  }
}

export function openStorePort(openStore, context) {
  if (typeof openStore !== 'function') return null;
  const opened = openStore(context);
  if (opened !== null && typeof opened === 'object' && typeof opened.then === 'function') {
    failWith('INVALID_STORE_PORT', 'openStore must be synchronous: return the store (or null), not a promise');
  }
  return opened ?? null;
}

/**
 * Close the store inside the deadline. The return value says exactly what happened, so a stop that could not wait for
 * an asynchronous close never claims the store is closed.
 */
export async function closeStorePort(store, { deadline, now = monotonicNow, record = () => {} } = {}) {
  if (!store) return 'none';
  if (typeof store.close !== 'function') return 'no-close-port';
  let closing;
  try {
    closing = store.close();
  } catch (error) {
    record(error);
    return 'failed';
  }
  if (closing === undefined || closing === null) return 'closed';
  if (typeof closing.then !== 'function') {
    record(Object.assign(new Error('store.close() must return undefined or a promise, got ' + typeof closing), { code: 'INVALID_STORE_PORT' }));
    return 'invalid-port';
  }
  let outcome = 'pending';
  const settled = Promise.resolve(closing).then(
    () => {
      outcome = 'closed';
    },
    error => {
      record(error);
      outcome = 'failed';
    },
  );
  const wait = await settleWithin(settled, deadline, now);
  return wait === 'timeout' ? 'isolated' : outcome;
}

/** Release ownership inside the same deadline. A handle that cannot be closed is reported, not assumed. */
export async function releaseWithin(handle, { deadline, now = monotonicNow, record = () => {} } = {}) {
  if (!handle) return 'none';
  let outcome = 'pending';
  const settled = Promise.resolve()
    .then(() => handle.release())
    .then(
      closed => {
        outcome = closed === false ? 'failed' : 'released';
      },
      error => {
        record(error);
        outcome = 'failed';
      },
    );
  const wait = await settleWithin(settled, deadline, now);
  return wait === 'timeout' ? 'isolated' : outcome;
}
