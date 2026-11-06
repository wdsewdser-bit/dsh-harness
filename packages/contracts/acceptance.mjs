/** Evaluate evidence/merge predicates without issuing delivery authority; 08 §4.8–4.9, §7.2 H. */
export function acceptanceReady(task) {
  if (!task || !task.contractApproved || !task.independentVerifier || !task.evidenceCurrent ||
    task.unknownEffect || task.blockedDecision) return false;
  const children = task.children ?? [];
  if (task.requiresChildren && children.length === 0) return false;
  if (!children.every(child => child.status === 'accepted')) return false;
  return task.deliveryKind === 'code' ? task.exactMergeConfirmed === true :
    task.deliveryKind === 'evidence' && task.evidenceAccepted === true;
}
