import { releaseWithin } from './ports.mjs';

/**
 * Ownership lifecycle for status(): none -> held -> releasing -> released | release-failed.
 *
 * Only a confirmed close may report 'released'. The synchronous wait and the background confirmation after a stop
 * timeout use the same judgement: a release that settles false, throws, or never settles is not a release. A second
 * cleanup pass with no handle must not rewrite a phase that already happened.
 */
export class OwnershipState {
  #phase = 'none';
  #since = null;
  #error = null;
  #now;

  constructor(now) {
    this.#now = now;
  }

  get phase() {
    return this.#phase;
  }

  snapshot() {
    return { phase: this.#phase, since: this.#since, error: this.#error };
  }

  setHeld() {
    this.#set('held');
  }

  #set(phase, error = null) {
    this.#phase = phase;
    this.#since = this.#now();
    this.#error = error;
  }

  /** Confirmed close: the only path that may report 'released' and drop the handle. */
  #confirm(onConfirmed) {
    this.#set('released');
    onConfirmed();
  }

  #fail(error = null) {
    const code = error && error.code ? String(error.code) : 'RELEASE_FAILED';
    const message = error && error.message ? error.message : 'the ownership handle did not confirm its release';
    this.#set('release-failed', { code, message });
  }

  async release(handle, { deadline, record = () => {}, onConfirmed = () => {} }) {
    if (!handle) {
      // Nothing to release in this pass. A phase that already happened (released / releasing / release-failed) is a
      // fact about a real handle and must survive a second, empty cleanup; only a host that never acquired stays none.
      return 'none';
    }
    this.#set('releasing');
    const outcome = await releaseWithin(handle, { deadline, record });
    if (outcome === 'released') {
      this.#confirm(onConfirmed);
      return outcome;
    }
    if (outcome === 'isolated') {
      // Same result judgement as the synchronous wait: a release that settles false is a failure, not a release.
      handle.release().then(
        closed => {
          if (closed === false) this.#fail();
          else this.#confirm(onConfirmed);
        },
        error => {
          record(error);
          this.#fail(error);
        },
      );
      return outcome;
    }
    this.#fail();
    return outcome;
  }
}
