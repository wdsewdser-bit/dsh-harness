import { fail } from '../contracts/index.mjs';
import { planRequest } from './budget.mjs';

const owners = new Map();

/** Serialize the sole history mutation entry for a Session; 08 §3.1. */
export class Coordinator {
  constructor(session) {
    if (owners.has(session)) {
      fail('DUPLICATE_COORDINATOR');
    }
    owners.set(session, this);
    this.tail = Promise.resolve();
  }

  run(operation) {
    // A rejected operation must not poison the queue for later reconciliation.
    const pending = this.tail.then(operation);
    this.tail = pending.catch(() => {});
    return pending;
  }

  close() {
    for (const [session, owner] of owners) {
      if (owner === this) {
        owners.delete(session);
      }
    }
  }
}

/** Decide safety before considering uncertified optional folding; 08 §3.1–3.4. */
export function evaluate(configuration, inputBound) {
  // The verdict is the budget rule's, never a second copy of it. With the committed input measurement and no body
  // to measure, planRequest answers exactly the question this decision asks: may this prompt proceed at 75% of W?
  const { verdict } = planRequest(null, configuration, { purpose: 'policy', inputBound });
  const safe = verdict === 'allow';
  return {
    safetyAction: safe ? 'allow' : 'pressure-or-block',
    optimizationPermit: false,
    reason: !safe
      ? 'blocked-budget'
      : inputBound < 200000
        ? 'below-200k'
        : 'uncertified/unknown-economics',
  };
}
