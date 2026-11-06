import { failWith } from '../../contracts/index.mjs';

/**
 * The gc trigger and its failure observation; design §6 E, §8.2.1 (60 s, configured).
 *
 * gc is a real effect kind with a real consumer, not a timer that calls a no-op: the timer (host clock, one timer)
 * writes one `gc:<at>:<serial>` outbox row with kind 'gc', the effect runner claims it, and the injected `gc` port
 * performs the external collection. This module owns the trigger, the interval and the report; it never performs the
 * collection itself and never invents one row per tick when the host cannot write (a frozen team, a stopped host):
 * those attempts are counted as failures with their code, which is what "failure observation is closed" means here.
 */
export const DEFAULT_GC_INTERVAL_MS = 60000;
/** How many failed effect ids status() names before it switches to count-plus-note (review finding 7). */
export const DEFAULT_FAILED_EFFECT_LIMIT = 20;

export function createGarbageCollector({ access = null, clock = null, intervalMs = DEFAULT_GC_INTERVAL_MS,
  now = Date.now, onError = null, failedEffectsLimit = DEFAULT_FAILED_EFFECT_LIMIT } = {}) {
  if (!access || typeof access.lifecycle !== 'function') failWith('INVALID_CONFIG', 'a garbage collector needs the host write ports');
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) failWith('INVALID_CONFIG', 'a gc interval must be a positive finite number of milliseconds');
  if (!Number.isInteger(failedEffectsLimit) || failedEffectsLimit < 0) failWith('INVALID_CONFIG', 'a failed-effect limit must be a non-negative integer');
  if (typeof now !== 'function') failWith('INVALID_CONFIG', 'a garbage collector needs a now() function');
  let serial = 0;
  let cancel = null;
  const counters = { triggered: 0, emitted: 0, failed: 0 };
  let lastError = null;
  let lastEmitAt = null;

  const record = error => {
    counters.failed += 1;
    lastError = Object.freeze({ code: error?.code ?? 'ERROR', message: error?.message ?? String(error), at: now() });
    try {
      onError?.(lastError);
    } catch {
      /* an observer must not break the trigger */
    }
    return lastError;
  };

  function trigger(reason = 'manual') {
    counters.triggered += 1;
    const at = now();
    const effectId = 'gc:' + at.toString(36) + ':' + (++serial);
    try {
      access.lifecycle().mutate('gc', 'scheduler', { trigger: reason, at }, tx => {
        tx.outbox(effectId, { kind: 'gc', at, trigger: reason });
        return null;
      });
      counters.emitted += 1;
      lastEmitAt = at;
      return Object.freeze({ ok: true, effectId, at, reason });
    } catch (error) {
      const failure = record(error);
      return Object.freeze({ ok: false, effectId: null, at, reason, code: failure.code });
    }
  }

  /**
   * Arm the one timer on the host clock; returns the cancel function (null when no clock was injected, and null when
   * the clock is already stopped - a stopped host cannot arm a timer, which is a lifecycle fact, not a defect:
   * review finding 7).
   */
  function arm() {
    if (!clock || typeof clock.every !== 'function') return null;
    if (cancel) return cancel;
    try {
      cancel = clock.every(intervalMs, () => {
        trigger('timer');
      }, 'gc');
    } catch (error) {
      if (error?.code === 'CLOCK_STOPPED') return null;
      throw error;
    }
    return cancel;
  }

  function stop() {
    if (!cancel) return false;
    cancel();
    cancel = null;
    return true;
  }

  function gcEffects() {
    return access.lifecycle().effects().filter(effect => effect.payload?.kind === 'gc');
  }

  function status() {
    let rows = [];
    let observable = true;
    try {
      rows = gcEffects();
    } catch {
      observable = false;
    }
    const byStatus = { pending: 0, applying: 0, confirmed: 0, retryable: 0, unknown: 0, cancelled: 0, 'dead-letter': 0 };
    for (const row of rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    // A bounded report: the count is always exact, the ids are capped, and truncation says so (review finding 7).
    const failedIds = rows.filter(row => ['unknown', 'dead-letter'].includes(row.status)).map(row => row.id);
    return Object.freeze({
      intervalMs, armed: Boolean(cancel), observable, triggered: counters.triggered, emitted: counters.emitted,
      failed: counters.failed, lastError, lastEmitAt, effects: Object.freeze(byStatus),
      failedEffects: Object.freeze(failedIds.slice(0, failedEffectsLimit)),
      failedEffectCount: failedIds.length,
      failedEffectsTruncated: failedIds.length > failedEffectsLimit,
    });
  }

  return Object.freeze({ trigger, arm, stop, status });
}
