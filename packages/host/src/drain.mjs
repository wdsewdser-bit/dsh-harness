/**
 * Everything stop() must wait for: an in-flight start/recovery, running hooks and managed operations.
 * Returns null when there is nothing to wait for.
 */
export function drainSignal({ startPromise, hooks, inflight }) {
  const pending = [];
  if (startPromise) pending.push(startPromise.catch(() => {}));
  const hookWait = hooks.settled();
  if (hookWait) pending.push(hookWait);
  const managedWait = inflight.pending();
  if (managedWait) pending.push(managedWait);
  return pending.length ? Promise.all(pending) : null;
}
