import { snapshot } from '../../core/index.mjs';

/** Scheduling-only agents have no transport. Opt-in fixtures explicitly model the request their successful merge
 * promises; negative visibility tests must NOT enable this. Native/provider fixtures keep the real dispatch path. */
export function simulateMailboxRequests(runtime) {
  let sequence = 0;
  const wrap = invoke => function (memberId, ...args) {
    const outcome = invoke.call(this, memberId, ...args);
    if (['live', 'coalesced', 'woke'].includes(outcome.wake)) {
      // Exactly one production page per simulated boundary; omitted inputs must wait for a later request.
      const candidate = snapshot(runtime.core, memberId), seq = ++sequence;
      runtime.host.coreAccess.lifecycle().visibility(candidate, 'simulated-request:' + seq, ['simulated-seq:' + seq],
        runtime.store.read(memberId).generation, { requestId: 'simulated-request:' + seq, sessionSeq: seq, requestedAt: Date.now() });
    }
    return outcome;
  };
  let delivery = wrap(runtime.preempt.deliverMail);
  // Tests replace this port to hold/refuse/throw. Wrap each replacement separately, so a saved native method keeps
  // its own identity and a throwing/refused replacement still produces no request evidence.
  Object.defineProperty(runtime.preempt, 'deliverMail', { configurable: true,
    get: () => delivery, set: invoke => { delivery = wrap(invoke); } });
}
