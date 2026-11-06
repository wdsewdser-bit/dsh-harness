import { failWith } from '../../contracts/index.mjs';

/**
 * Host state machine; docs/host-protocol.md §2.1 and invariant 9.
 *
 *   created -> starting -> recovering -> running -> stopping -> stopped
 *                 |            |
 *                 +------------+--> stopping
 *
 * 'created' is not in the spec's five states: it is the "constructed but not started" position a host needs before
 * start() takes its first step. stop() before start() goes created -> stopping -> stopped so a caller never has to
 * special-case an unmounted host.
 */
export const HOST_STATES = Object.freeze(['created', 'starting', 'recovering', 'running', 'stopping', 'stopped']);

export const HOST_TRANSITIONS = Object.freeze({
  created: Object.freeze(['starting', 'stopping']),
  starting: Object.freeze(['recovering', 'stopping']),
  recovering: Object.freeze(['running', 'stopping']),
  running: Object.freeze(['stopping']),
  stopping: Object.freeze(['stopped']),
  stopped: Object.freeze([]),
});

export function isLegalTransition(from, to) {
  return Boolean(HOST_TRANSITIONS[from]?.includes(to));
}

export function assertTransition(from, to) {
  if (!isLegalTransition(from, to)) failWith('INVALID_STATE', 'host transition ' + from + ' -> ' + to + ' is not allowed');
}

/**
 * Append-only state with observers. A listener that throws is reported to onListenerError and otherwise ignored:
 * an observer must never decide whether a transition, or the shutdown that follows it, is correct.
 */
export class HostStateMachine {
  #state;
  #history = [];
  #listeners = new Set();
  #now;
  #onListenerError;

  constructor({ state = 'created', now = Date.now, onListenerError = null } = {}) {
    if (!HOST_STATES.includes(state)) failWith('INVALID_STATE', 'unknown host state ' + state);
    this.#state = state;
    this.#now = now;
    this.#onListenerError = onListenerError;
  }

  get state() {
    return this.#state;
  }

  get history() {
    return this.#history.slice();
  }

  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  transition(next) {
    const from = this.#state;
    assertTransition(from, next);
    this.#state = next;
    const step = Object.freeze({ from, to: next, at: this.#now() });
    this.#history.push(step);
    for (const listener of [...this.#listeners]) {
      try {
        listener(step);
      } catch (error) {
        if (this.#onListenerError) this.#onListenerError(error, step);
      }
    }
    return step;
  }
}
