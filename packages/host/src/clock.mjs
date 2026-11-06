import { failWith } from '../../contracts/index.mjs';

/**
 * One clock for every timer the host owns; M1b design §3.1.
 *
 * now() is the only wall-clock read the driver uses for decisions, and every timer is created, unref'd and cleared
 * here so stop() cannot leave a timer behind. The host never calls setTimeout/setInterval directly: a second source
 * of time is how "the cycle is late", "the lease expired" and "the budget ran out" start disagreeing.
 */
export function createClock({ now = Date.now, timers = null } = {}) {
  if (typeof now !== 'function') failWith('INVALID_CONFIG', 'a clock needs a now() function');
  const api = timers ?? { setInterval, setTimeout, clearInterval, clearTimeout };
  const handles = new Set();
  let stopped = false;

  const validate = (ms, fn, label) => {
    if (stopped) failWith('CLOCK_STOPPED', 'the clock was stopped; ' + label + ' cannot be armed');
    if (typeof fn !== 'function') failWith('INVALID_CONFIG', label + ' needs a function');
    if (!Number.isFinite(ms) || ms < 0) failWith('INVALID_TIMER', label + ' needs a non-negative finite millisecond value, got ' + String(ms));
  };
  const track = handle => {
    if (handle && typeof handle.unref === 'function') handle.unref();
    handles.add(handle);
    return handle;
  };
  const cancel = handle => {
    if (!handle) return false;
    handles.delete(handle);
    api.clearInterval(handle);
    api.clearTimeout(handle);
    return true;
  };

  return Object.freeze({
    now: () => now(),
    get stopped() {
      return stopped;
    },
    get size() {
      return handles.size;
    },
    /** A repeating timer. Returns the cancel function, so a caller can end one loop without touching the rest. */
    every(ms, fn, label = 'interval') {
      validate(ms, fn, label);
      const handle = track(api.setInterval(fn, ms));
      return () => cancel(handle);
    },
    /** A one-shot timer. Returns its cancel function. */
    after(ms, fn, label = 'timeout') {
      validate(ms, fn, label);
      let handle = null;
      handle = track(api.setTimeout(() => {
        handles.delete(handle);
        fn();
      }, ms));
      return () => cancel(handle);
    },
    /** Clear every timer. Idempotent; returns how many were cleared. */
    stopAll() {
      if (stopped) return 0;
      stopped = true;
      const count = handles.size;
      for (const handle of handles) {
        api.clearInterval(handle);
        api.clearTimeout(handle);
      }
      handles.clear();
      return count;
    },
  });
}
