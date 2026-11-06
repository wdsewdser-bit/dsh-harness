import { hash, fail } from '../contracts/index.mjs';

/** Plan closed spans using trusted provenance, without production admission; 08 §3.4. */
export function planClosedSteps(nodes, manifests = [], protect = 8) {
  let lastSequence = -1;
  for (const node of nodes) {
    for (const sequence of node.seqs) {
      if (!Number.isSafeInteger(sequence) || sequence <= lastSequence) {
        fail('INVALID_SOURCE_ORDER');
      }
      lastSequence = sequence;
    }
  }
  const steps = nodes.filter(node => node.kind === 'step' && node.closed);
  const retainedSteps = new Set(steps.slice(-Math.max(8, protect)));
  const latestRevision = Math.max(0, ...manifests.map(manifest => manifest.revision));
  let pendingNodes = [];
  const plans = [];
  const flush = () => {
    if (pendingNodes.some(node => node.kind === 'step')) {
      plans.push({
        sourceEventSeqs: pendingNodes.flatMap(node => node.seqs),
        nodes: pendingNodes,
      });
    }
    pendingNodes = [];
  };

  for (const node of nodes) {
    const calls = node.calls ?? [];
    const results = node.results ?? [];
    const paired = calls.length === new Set(calls).size &&
      results.length === new Set(results).size &&
      calls.length === results.length &&
      calls.every(callId => results.includes(callId));
    let safe = node.kind === 'step' && node.closed && paired &&
      !retainedSteps.has(node) && !node.cancelled;
    if (node.kind === 'user') {
      // Text labels alone never authorize replacing a user surface node.
      const manifest = manifests.find(candidate => (
        candidate.messageId === node.messageId &&
        candidate.hash === hash(node.text) &&
        candidate.source === node.source
      ));
      safe = !!manifest && manifest.revision < latestRevision &&
        manifest.accepted && node.sections?.every(section => section.authorized === true);
    }
    if (safe && !node.protected) {
      pendingNodes.push(node);
    } else {
      flush();
    }
  }
  flush();
  return plans;
}

/** Delegate safety pressure handling to native compaction; 08 §3.3. */
export const compactForPressure = (adapter, agent, signal) => (
  adapter.compactIfNeeded(agent, signal)
);

/** Reject second-layer commits until route admission is certified; 08 §3.4. */
export function commitReplace() {
  fail('SECOND_LAYER_OFF');
}

/** Find authoritative journal evidence for an operation; 08 §3.4. */
export function reconcile(session, operationId) {
  return session.snapshotEvents().filter(event => event.data?.operationId === operationId);
}
