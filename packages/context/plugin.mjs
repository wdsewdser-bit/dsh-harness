import { fail } from '../contracts/index.mjs';
import { planRequest, measureUsage } from './budget.mjs';
import { evaluate } from './policy.mjs';

/** Install the final read-only stream budget boundary; 08 §3.2. */
export function wireGuard(adapter, configuration, getAgent, onObservation = () => {}) {
  adapter.onStream((options, next) => (async function* () {
    const purpose = adapter.isMain(options) ? 'main' : 'summary';
    const agent = getAgent();
    const measurement = purpose === 'main' && agent ? adapter.measure(agent.session) : null;
    if (measurement?.baseline?.kind === 'usage') {
      measureUsage(measurement.baseline.usage);
    }
    // The guard is the shared rule, not a call into an exception: the plan says what the input is estimated to cost
    // and whether this stream may proceed. The measured session total is a floor on the next prompt, never a
    // substitute for the complete pending payload (a stale sample cannot price the request being sent).
    const plan = planRequest(options, configuration, {
      purpose, baseline: measurement?.totalTokens ?? 0,
    });
    if (plan.verdict === 'unknown') {
      fail('UNKNOWN_BUDGET');
    }
    if (plan.verdict !== 'allow') {
      fail('BLOCKED_BUDGET');
    }
    onObservation({
      I: plan.I, W: plan.W, R: plan.reserve, M: plan.M, purpose,
      estimateMethod: plan.method, estimateEvidence: plan.evidence,
    });
    yield* next();
  })());
}

/** Publish large text before returning its model-visible excerpt; 08 §3.3. */
export function archiveText(store, configuration, { text, callId, principal }) {
  if (text.length <= configuration.truncateChars) {
    return null;
  }
  try {
    const ref = store.publish(callId, text, principal);
    const provenance = {
      ...ref,
      truncatedRange: { start: 128, end: text.length - 128 },
    };
    const excerpt = text.slice(0, 128) + ' … ' + JSON.stringify(provenance) +
      ' recall(ref,{offset,length<=4096}); ' + text.slice(-128);
    return {
      ref,
      // The tools contract accepts content OR value, never both (P1-5).
      decision: { kind: 'accept', content: [{ type: 'text', text: excerpt }] },
    };
  } catch (error) {
    return {
      error,
      decision: {
        kind: 'accept',
        content: [{
          type: 'text',
          text: 'ARCHIVE_FAILED: original not promised recoverable; tool side effect unknown; do not rerun.',
        }],
      },
    };
  }
}

/** Persist a policy decision with its source observation; 08 §3.1. */
export function recordPolicy(store, session, source, configuration, inputBound) {
  const decision = evaluate(configuration, inputBound);
  store.db.prepare('INSERT OR REPLACE INTO policy_decisions VALUES(?,?,?)')
    .run(session, JSON.stringify(source), JSON.stringify(decision));
  return decision;
}
