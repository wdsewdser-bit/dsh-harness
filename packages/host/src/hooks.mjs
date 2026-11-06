import { failWith } from '../../contracts/index.mjs';

/**
 * Hook registry; docs/host-protocol.md §2.2 rules 1-4.
 *
 * Mounting the same name twice is refused (HOOK_ALREADY_MOUNTED) instead of silently replacing an entry whose invoke
 * would otherwise stay live. Every invocation gets the host's controlled capability, and running invocations are
 * tracked so stop() can wait for them inside its budget.
 *
 * The tracking promise consumes its own failure: it records the error and never leaves an unhandled rejection behind,
 * while the caller still receives the original result (and therefore the original rejection).
 */
export class HookRegistry {
  #hooks = new Map();
  #inflight = new Set();
  #errors = [];
  #makeCapability;

  constructor({ makeCapability }) {
    this.#makeCapability = makeCapability;
  }

  get mounted() {
    return this.#hooks.size;
  }

  get inflight() {
    return this.#inflight.size;
  }

  /** The last few hook failures, newest last; observable through status().hookErrors. */
  get errors() {
    return this.#errors.slice();
  }

  mount(name, handler, check) {
    if (typeof name !== 'string' || !name) failWith('INVALID_HOOK', 'a hook name is required');
    if (typeof handler !== 'function') failWith('INVALID_HOOK', 'a hook handler must be a function');
    if (typeof check === 'function') check();
    if (this.#hooks.has(name)) failWith('HOOK_ALREADY_MOUNTED', 'hook ' + name + ' is already mounted; unmount it first');
    const entry = { name, mounted: true };
    entry.invoke = payload => this.#invoke(entry, handler, payload);
    this.#hooks.set(name, entry);
    return entry.invoke;
  }

  unmount(name) {
    const entry = this.#hooks.get(name);
    if (!entry) return false;
    entry.mounted = false;
    this.#hooks.delete(name);
    return true;
  }

  /** Detach everything; an invoke after this returns undefined and never reaches the handler. */
  unmountAll() {
    for (const entry of this.#hooks.values()) entry.mounted = false;
    this.#hooks.clear();
  }

  /** Settles when every running invocation has finished; null when there is nothing to wait for. */
  settled() {
    if (this.#inflight.size === 0) return null;
    return Promise.all([...this.#inflight].map(record => record.promise));
  }

  #invoke(entry, handler, payload) {
    if (!entry.mounted) return undefined;
    const capability = this.#makeCapability();
    if (!capability) return undefined;
    const result = handler(payload, capability);
    if (!result || typeof result.then !== 'function') return result;
    const record = { promise: null };
    record.promise = Promise.resolve(result).then(
      () => undefined,
      error => {
        const code = error && error.code !== undefined ? String(error.code) : 'HOOK_FAILED';
        const message = error && error.message ? error.message : String(error);
        this.#errors.push({ code, message, hook: entry.name, at: Date.now() });
        if (this.#errors.length > 5) this.#errors.shift();
      },
    ).finally(() => this.#inflight.delete(record));
    this.#inflight.add(record);
    return result;
  }
}
