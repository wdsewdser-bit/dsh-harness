import fs from 'node:fs';

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Delete every directory, retrying only transient failures a finite number of times. Every directory is attempted even
 * when an earlier one fails, and every final failure is returned instead of stopping at the first.
 */
export function cleanupDirs(dirs, { attempts = 10, delayMs = 50, remove = dir => fs.rmSync(dir, { recursive: true, force: true }) } = {}) {
  const errors = [];
  for (const dir of dirs) {
    let last = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try { remove(dir); last = null; break; }
      catch (error) {
        last = error;
        if (attempt + 1 < attempts) sleep(delayMs);
      }
    }
    if (last) errors.push({ dir, error: last });
  }
  return errors;
}

/**
 * Final-cleanup boundary. A successful body with a failed deletion must fail the test; a failed body keeps its own
 * error and gets the cleanup diagnostics attached, so cleanup never masks the primary assertion.
 */
export function cleanupOrThrow(dirs, primary = null, options = {}) {
  const errors = cleanupDirs(dirs, options);
  if (!errors.length) return;
  if (primary) {
    primary.cleanupErrors = [...(primary.cleanupErrors ?? []), ...errors];
    throw primary;
  }
  const detail = errors.map(e => e.dir + ': ' + e.error.message).join('; ');
  throw Object.assign(Error('final cleanup failed: ' + detail), { cleanupErrors: errors });
}

/**
 * The body is synchronous by contract: callers close the store only after every assertion has run. If both the body
 * and close() fail, the body error is the one thrown and the close error is attached to cleanupErrors.
 */
export function withStore(Store, root, work) {
  const store = new Store(root);
  let result;
  let primary = null;
  try { result = work(store); }
  catch (error) { primary = error; }
  finally {
    try { store.close(); }
    catch (error) {
      if (primary) primary.cleanupErrors = [...(primary.cleanupErrors ?? []), error];
      else primary = error;
    }
  }
  if (result && typeof result.then === 'function') throw TypeError('withStore callback must be synchronous');
  if (primary) throw primary;
  return result;
}