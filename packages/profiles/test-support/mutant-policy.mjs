/**
 * The retry policy for mutation runs. A mutation run has exactly one meaning: the mutated tree must fail a behavioral
 * assertion. Two rules follow from that and are enforced here, not in every sweep:
 *
 *   1. A run that exits 0 SURVIVED the mutant. It is evidence, never an infrastructure accident, so it is returned on
 *      the first attempt and must fail the sweep immediately. Retrying it could turn a survivor into a "kill".
 *   2. Only failures that say nothing about the mutant are retried, and only once: a transient Windows CreateProcess
 *      refusal (spawn EBUSY), a run that made no progress (stalled), or a root killed by a signal. The runner's own
 *      "run made no progress" stop is an infrastructure symptom, not a behavioral verdict; the retried run is judged
 *      on its own. NOT_ROUTED, import failures, assertion failures and every other exit are NOT retried: they are
 *      verdicts about the tree under test (or about the harness wiring), and a retry would hide them.
 *
 * The first attempt is kept in the returned history and in the evidence string, so a retried kill still shows what the
 * first run did.
 */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function isInfrastructureFailure(result) {
  if (!result || result.status === 0) return false; // a surviving mutant is a verdict, never retried
  if (result.error?.code === 'EBUSY') return true;   // Windows refused CreateProcess; nothing ran
  if (result.stalled === true || result.stopReason === 'idle') return true;
  if (result.signal !== null && result.signal !== undefined) return true; // the root was killed by a signal
  return false;
}

export function describeAttempt(result) {
  return 'status=' + String(result.status) + ' signal=' + String(result.signal ?? null) +
    ' stalled=' + String(result.stalled ?? false) + ' timedOut=' + String(result.timedOut ?? false) +
    (result.stopReason ? ' stop=' + result.stopReason : '') +
    (result.error ? ' error=' + (result.error.code ?? result.error.message ?? String(result.error)) : '');
}

export function mutantEvidence(history) {
  return 'attempts=' + history.length + ' ' + history.map((result, index) =>
    'run' + (index + 1) + '[' + describeAttempt(result) + ']').join(' ');
}

/** The tail of the first attempt, for the failure diagnostics of a retried run. */
export function firstRunTail(result, limit = 2000) {
  const text = (result.stdout ?? '') + (result.stderr ?? '');
  return text.length > limit ? text.slice(-limit) : text;
}

/**
 * Run one mutant (already applied to disk) up to maxAttempts times, retrying only identified infrastructure failures.
 * The returned result is the last attempt; history always contains the first-run evidence.
 */
export async function runMutant(run, { maxAttempts = 2 } = {}) {
  const history = [await run()];
  while (history.length < maxAttempts && isInfrastructureFailure(history.at(-1))) {
    await sleep(250 * history.length);
    history.push(await run());
  }
  return { result: history.at(-1), attempts: history.length, history, retried: history.length > 1,
    evidence: mutantEvidence(history) };
}
