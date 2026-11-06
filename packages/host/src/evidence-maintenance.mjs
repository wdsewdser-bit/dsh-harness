import { failWith } from '../../contracts/index.mjs';

/**
 * Authoritative-evidence maintenance (gap 1, blocking review 4).
 *
 * A long-running team never restarts, so "compact once at activation" is not lifecycle governance. This runs on the
 * host's own clock, between commits (always after COMMIT, never inside a transaction), and only when the backlog of
 * completed commits crosses the configured threshold. It is deliberately not a cycle step: retention is a storage
 * choreography, not scheduling progress, and it must not make the cycle report progress or wake itself.
 *
 * Coordination with stop/drain:
 *   - it only runs while the host machine state is 'running', so stop() and recovery stop it before the store closes;
 *   - it refuses to run while the connection already has an open transaction (store.inTransaction()), so it can never
 *     re-enter a transaction that a caller is still writing;
 *   - a failure is atomic in the store, is recorded here with its original code, and backs off for backoffMs; the
 *     backlog keeps growing and stays visible in status, so a persistent failure is reported rather than hidden.
 */
export function createEvidenceMaintenance({ store = null, clock, intervalMs = 1000, threshold = 256, backoffMs = 30000,
  lifecycle = () => 'running', limits = null } = {}) {
  if (!clock || typeof clock.every !== 'function') failWith('INVALID_CONFIG', 'evidence maintenance needs the host clock');
  if (!Number.isSafeInteger(threshold) || threshold < 1) failWith('INVALID_CONFIG', 'evidence retention threshold must be a positive integer');
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) failWith('INVALID_TIMER', 'evidence maintenance needs a positive interval');
  let cancel = null, stopped = false, runs = 0, lastRunAt = null, lastError = null, nextAttemptAt = 0, skipped = 0;
  const backlog = () => (typeof store?.commitsSinceRetention === 'function' ? store.commitsSinceRetention() : 0);
  const status = () => ({ intervalMs, threshold, runs, lastRunAt, lastError, nextAttemptAt, backlog: backlog(), skipped, stopped });
  const publish = () => { try { store?.setRetentionMaintenance?.(status()); } catch { /* status publication is best effort */ } };
  const tick = () => {
    if (stopped) return status();
    if (lifecycle() !== 'running' || !store || typeof store.retainEvidence !== 'function') { skipped += 1; return status(); }
    // Never re-enter an open transaction: retainEvidence opens its own BEGIN IMMEDIATE.
    if (typeof store.inTransaction === 'function' && store.inTransaction()) { skipped += 1; return status(); }
    const at = typeof clock.now === 'function' ? clock.now() : Date.now();
    if (at < nextAttemptAt) { skipped += 1; return status(); }
    if (backlog() < threshold && !store.retentionWorkPending?.()) return status();
    try {
      store.retainEvidence(limits ? { limits } : {});
      runs += 1; lastRunAt = at; lastError = null; nextAttemptAt = 0;
    } catch (error) {
      // The store rolled the pass back and preserved the original code; record it and back off instead of retrying
      // every tick. The backlog is not cleared, so the next attempt still sees the work that failed.
      lastError = { code: error?.code ?? null, message: error?.message ?? String(error), at };
      nextAttemptAt = at + backoffMs;
    }
    publish();
    return status();
  };
  return Object.freeze({
    arm() { if (!cancel) cancel = clock.every(intervalMs, tick, 'evidence-retention'); return tick; },
    stop() { if (cancel) cancel(); cancel = null; stopped = true; publish(); },
    tick, status,
  });
}
