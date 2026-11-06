import { failWith } from '../../contracts/index.mjs';
import { AsyncResource } from 'node:async_hooks';

/**
 * The scheduling cycle; M1b design §3.2, §3.3.
 *
 * Step order is fixed and named. A step that is not installed is skipped and counted, so the skeleton can run before
 * B/C/D install their steps. "kick" is the only way an external input wakes the cycle, and the cycle coalesces:
 *
 *   - an external kick while a round runs sets dirty again, and the loop runs once more after the current round;
 *     there is no round ceiling, because dropping an input is worse than running again;
 *   - the cycle's own commits call noteProgress() and never kick, which is what cuts the "internal write sets dirty
 *     again" spin: the journal can grow without the scheduler waking itself.
 *
 * A round reports per-step counts. It made progress when a step consumed an input, changed state, claimed an effect,
 * dispatched a lifecycle intent or admitted a task (§3.3). No progress is reported, never retried here.
 */
export const CYCLE_STEPS = Object.freeze(['tick', 'reconcile', 'intents', 'drain', 'pump', 'publish']);

const PROGRESS_KEYS = Object.freeze(['consumed', 'changed', 'claimed', 'dispatched', 'scheduled']);

export function createCycle({ access = null, clock = null, now = Date.now, steps = {}, intervalMs = null, onError = null, onStep = null } = {}) {
  // B owns clocks and admission only. Legacy driver exclusively owns member-intent IO until C/F.
  if (access) steps = {
    tick: () => access.isDue(now()) ? { changed: access.tick(now()) ? 1 : 0 } : { due: false, skipped: 1 },
    reconcile: () => ({ changed: access.reconcile(now()) ? 1 : 0 }),
    drain: () => { const result = access.drain(now()); return { consumed: result.consumed, scheduled: result.length, rejected: result.rejected }; },
    publish: () => ({}), ...steps,
  };
  for (const name of Object.keys(steps ?? {})) {
    if (!CYCLE_STEPS.includes(name)) failWith('INVALID_CONFIG', 'unknown cycle step ' + JSON.stringify(name));
    if (typeof steps[name] !== 'function') failWith('INVALID_CONFIG', 'cycle step ' + JSON.stringify(name) + ' must be a function');
  }
  const installed = Object.freeze({ ...steps });
  // Capture trusted installation context, never the member that later kicks this scheduler.
  const hostContext = new AsyncResource('team-host-cycle');

  let running = null;
  let active = false;
  let dirty = false;
  let stopped = false;
  let cancelTimer = null;
  let rounds = 0;
  let kicks = 0;
  let coalesced = 0;
  let noProgressRounds = 0;
  let lastCycle = null;
  const progress = { internal: 0, bySource: {} };

  const normalise = outcome => {
    const value = outcome && typeof outcome === 'object' ? outcome : {};
    const step = {};
    for (const key of PROGRESS_KEYS) step[key] = Number.isFinite(value[key]) ? value[key] : 0;
    for (const key of ['rejected', 'skipped']) step[key] = Number.isFinite(value[key]) ? value[key] : 0;
    if (value.changed === true) step.changed = 1;
    if (value.due === false) step.due = false;
    return step;
  };

  const runRound = async reason => {
    const at = now();
    const result = { at, reason, steps: {}, progress: false };
    for (const name of CYCLE_STEPS) {
      const step = stopped ? null : installed[name];
      if (!step) {
        result.steps[name] = { skipped: 1 };
        continue;
      }
      try {
        const outcome = await step({ now, noteProgress: source => noteProgress(source) });
        result.steps[name] = normalise(outcome);
        onStep?.(name, result.steps[name], result);
      } catch (error) {
        const code = error && error.code ? String(error.code) : 'ERROR';
        result.steps[name] = { ...normalise(null), error: code };
        onError?.(error, { step: name, round: rounds });
      }
    }
    result.progress = CYCLE_STEPS.some(name => {
      const step = result.steps[name];
      return PROGRESS_KEYS.some(key => step[key] > 0);
    });
    if (!result.progress) noProgressRounds += 1;
    rounds += 1;
    lastCycle = result;
    return result;
  };

  /**
   * Start a drain. The latch is taken synchronously, before the first step runs: a step that receives an external
   * input mid-round must coalesce into the current drain, not start a second, interleaved one.
   */
  const start = reason => {
    active = true;
    const promise = hostContext.runInAsyncScope(() => Promise.resolve().then(async () => {
      try {
        do {
          dirty = false;
          await runRound(reason);
        } while (dirty && !stopped);
        return lastCycle;
      } finally {
        active = false;
        running = null;
      }
    }));
    running = promise;
    return promise;
  };

  const noteProgress = source => {
    progress.internal += 1;
    const key = typeof source === 'string' && source ? source : 'unknown';
    progress.bySource[key] = (progress.bySource[key] ?? 0) + 1;
  };

  const cycle = {
    /** External input: gateway acceptance, a session event, an effect receipt, a timer. Never called by a step. */
    kick(reason = 'external') {
      if (stopped) return Promise.resolve(null);
      kicks += 1;
      if (active) {
        dirty = true;
        coalesced += 1;
        return running;
      }
      return start(reason);
    },
    /** An internal commit. It records that the cycle did something and never schedules another round. */
    noteProgress,
    /** Run one round synchronously from the caller's point of view; used by tests and by the first cycle. */
    run(reason = 'manual') {
      if (stopped) return Promise.resolve(null);
      if (active) {
        dirty = true;
        coalesced += 1;
        return running;
      }
      return start(reason);
    },
    stop() {
      stopped = true;
      if (cancelTimer) {
        cancelTimer();
        cancelTimer = null;
      }
      return { rounds, kicks, coalesced, noProgressRounds };
    },
    status() {
      return {
        rounds,
        kicks,
        coalesced,
        noProgressRounds,
        dirty,
        running: active,
        stopped,
        internalProgress: progress.internal,
        progressBySource: { ...progress.bySource },
        lastCycle,
        steps: [...CYCLE_STEPS],
        installed: [...CYCLE_STEPS].filter(name => Boolean(installed[name])),
      };
    },
  };

  if (clock && Number.isFinite(intervalMs) && intervalMs > 0) {
    cancelTimer = clock.every(intervalMs, () => {
      cycle.kick('timer');
    }, 'cycle');
  }
  return Object.freeze(cycle);
}
