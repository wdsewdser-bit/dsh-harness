import { failWith } from '../../contracts/index.mjs';
import { GoalGate } from '../../core/index.mjs';

/**
 * Host-side completion-token reconciliation; design §3.8, host-protocol invariant 7 rules 4, 7, 10.
 *
 * The gate is synchronous because the upstream completion guard is ("one synchronous policy; only literal true
 * authorizes"): this module owns the one asynchronous, budgeted step - reading the offline session log - and hands the
 * gate a read-only view. A journal that cannot be read within its budget, at all, or only in part (a truncated log
 * that does not declare itself complete) is a missing capability:
 * `status: 'unknown'`, capability `session-log-unavailable` (or `session-log-truncated`), and no token is touched, so
 * admission stays closed. It is never
 * "nothing was completed". An aborted read (stop during recovery) says so too, and the host's recovery wrapper turns
 * that into HOST_STOPPED.
 */
export const SESSION_LOG_UNAVAILABLE = 'session-log-unavailable';
export const SESSION_LOG_TRUNCATED = 'session-log-truncated';
export const RECOVERY_ABORTED = 'recovery-aborted';
export const DEFAULT_LOG_READ_TIMEOUT_MS = 30000;

export function createGoalRecovery({ core = null, gate = null, sessionLog = null, alarm = () => {}, now = Date.now,
  clock = null, readTimeoutMs = DEFAULT_LOG_READ_TIMEOUT_MS } = {}) {
  if (!gate && !core) failWith('INVALID_CONFIG', 'goal recovery needs a gate or a core to build one on');
  if (typeof now !== 'function') failWith('INVALID_CONFIG', 'goal recovery needs a now() function');
  if (!Number.isFinite(readTimeoutMs) || readTimeoutMs < 0) failWith('INVALID_CONFIG', 'the log read budget must be a non-negative finite number of milliseconds');
  const attached = gate ?? new GoalGate(core, alarm);
  const read = typeof sessionLog === 'function' ? sessionLog : null;
  let last = null;

  /** Race one read against the stop signal and its own budget; the host never waits on a hung log. */
  const withinBudget = (work, signal) => new Promise(resolve => {
    let done = false;
    let timer = null;
    let detach = () => {};
    const settle = value => {
      if (done) return;
      done = true;
      timer?.cancel?.();
      detach();
      resolve(value);
    };
    const onAbort = () => settle({ aborted: true, reason: 'stop() cancelled the recovery log read' });
    if (signal?.aborted) return onAbort();
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
      detach = () => signal.removeEventListener('abort', onAbort);
    }
    const onTimeout = () => settle({ timedOut: true, reason: 'the session log read exceeded its ' + readTimeoutMs + 'ms budget' });
    if (clock && typeof clock.after === 'function') timer = { cancel: clock.after(readTimeoutMs, onTimeout, 'recovery-log') };
    else {
      const handle = setTimeout(onTimeout, readTimeoutMs);
      if (typeof handle.unref === 'function') handle.unref();
      timer = { cancel: () => clearTimeout(handle) };
    }
    Promise.resolve(work).then(value => settle({ value }), error => settle({ error }));
  });

  async function journal(sessionId, { signal = null } = {}) {
    if (!read) return { available: false, capability: SESSION_LOG_UNAVAILABLE, reason: 'no offline session log port is installed' };
    const outcome = await withinBudget(Promise.resolve().then(() => read({ sessionId, signal })), signal);
    if (outcome.aborted) return { available: false, capability: RECOVERY_ABORTED, reason: outcome.reason, aborted: true };
    if (outcome.timedOut) return { available: false, capability: SESSION_LOG_UNAVAILABLE, reason: outcome.reason, timedOut: true };
    if (outcome.error) return { available: false, capability: SESSION_LOG_UNAVAILABLE, reason: outcome.error?.message ?? String(outcome.error) };
    const log = outcome.value;
    if (!log) return { available: false, capability: SESSION_LOG_UNAVAILABLE, reason: 'the session log was not found' };
    const events = typeof log.snapshotEvents === 'function' ? log.snapshotEvents() : log.events;
    if (!Array.isArray(events)) return { available: false, capability: SESSION_LOG_UNAVAILABLE, reason: 'the session log carries no event list' };
    // A log that does not declare itself complete cannot prove a completion is absent (review finding 4): treating a
    // truncated read as "nothing there" would withdraw a completion that may have been published past the cut.
    if (log.complete !== true) return { available: false, truncated: true, capability: SESSION_LOG_TRUNCATED,
      reason: log.complete === false || log.truncated === true ? 'the session log is not a complete journal' : 'the session log does not declare itself complete' };
    return { available: true, complete: true, events, seq: log.seq ?? events.at(-1)?.seq ?? null };
  }

  async function reconcileSession(sessionId, { signal = null } = {}) {
    const found = await journal(sessionId, { signal });
    if (!found.available) {
      return Object.freeze({ sessionId, status: 'unknown', capability: found.capability, reason: found.reason ?? null, inspected: 0, prepared: 0 });
    }
    return attached.reconcile({ id: sessionId, seq: found.seq, snapshotEvents: () => found.events });
  }

  /** Every session that still holds a completion token, or the explicit list the caller names. */
  function sessions() {
    if (!core) return [];
    return [...new Set(core.store.list('completion:')
      .filter(token => ['prepared', 'authorized', 'unknown'].includes(token.status) && token.input?.sessionId)
      .map(token => token.input.sessionId))];
  }

  async function reconcileAll({ sessionIds = null, signal = null } = {}) {
    const ids = Array.isArray(sessionIds) ? [...new Set(sessionIds.filter(Boolean))] : sessions();
    const results = [];
    let status = 'ok';
    let capability = null;
    for (const sessionId of ids) {
      const result = await reconcileSession(sessionId, { signal });
      results.push(result);
      if (result.status !== 'ok' && status === 'ok') {
        status = 'unknown';
        capability = result.capability ?? SESSION_LOG_UNAVAILABLE;
      }
      if (result.capability === RECOVERY_ABORTED) break;
    }
    const conclusion = Object.freeze({ status, capability, sessions: Object.freeze(results), at: now() });
    last = conclusion;
    return conclusion;
  }

  /**
   * P3 (§2.2.1 completion row, §12 U7): the decision channel of one completion token.
   *
   * The gate reads the journal and hands the proof to the decision reducer; this wrapper only supplies the session the
   * caller routed, so the host never builds a decision command of its own.
   */
  function decideCompletion(sessionId, decisionId, verdict, { actor, entry = 'owner' } = {}) {
    return attached.decideCompletion({ id: sessionId }, decisionId, verdict, actor, entry);
  }

  return Object.freeze({ gate: attached, reconcileSession, reconcileAll, sessions, decideCompletion, status: () => last });
}
