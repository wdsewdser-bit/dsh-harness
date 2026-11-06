/**
 * In-process sequencing between the two acceptance plugins.
 *
 * The Loader starts plugin entries concurrently, so "the recordable scenario has finished committing" cannot be
 * inferred from insertion order or from counting rows: the fixture must wait for the scenario's last write, because
 * the prepared completion token it ends with freezes every later write (COMPLETION_FROZEN). Both halves are plain
 * promises inside one host process; nothing is persisted and no server contract is involved.
 */
const states = new Map();
const state = key => {
  let entry = states.get(key);
  if (!entry) { let resolve; const promise = new Promise(r => { resolve = r; }); entry = { done: false, resolve, promise }; states.set(key, entry); }
  return entry;
};
export function markDone(key) { const entry = state(key); entry.done = true; entry.resolve(); }
export function isDone(key) { return state(key).done; }
export function waitDone(key, timeoutMs = 120000) {
  const entry = state(key);
  if (entry.done) return Promise.resolve();
  return Promise.race([entry.promise, new Promise((resolve, reject) =>
    setTimeout(() => reject(Error('SEQUENCE_TIMEOUT:' + key)), timeoutMs).unref?.())]);
}
