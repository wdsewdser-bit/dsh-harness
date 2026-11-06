// Stable read-side incident identity, shared by decision/attempt/capacity explanations.
// Inputs are already visible rows. No new fact, authority, or durable identity is minted here.
export function stopSubjectKey(ref, rows, seen = new Set()) {
  if (!ref || seen.has(ref)) return null;
  seen.add(ref);
  const row = rows.get(ref);
  if (!row) return ref.startsWith('attempt:') ? 'stop:' + ref : null;
  const E = row.E ?? rows.get('execution-current:' + ref)?.E;
  if (E?.executionEpoch) return 'stop:execution:' + E.executionEpoch;
  if (ref.startsWith('attempt:')) return row.executionEpoch ? 'stop:execution:' + row.executionEpoch : 'stop:' + ref;
  if (row.kind === 'stuck-member') return stopSubjectKey(row.subject?.id, rows, seen);
  if (ref.startsWith('control-slot:')) {
    return stopSubjectKey(row.holderRef ?? row.originRef, rows, seen);
  }
  if (ref.startsWith('member:')) {
    const attempts = [...rows.values()].filter(candidate => candidate.entityId.startsWith('attempt:') &&
      candidate.owner === ref && candidate.lease === 'unknown' &&
      (candidate.generation == null || candidate.generation === row.generation));
    if (attempts.length === 1) return stopSubjectKey(attempts[0].entityId, rows, seen);
    return 'stop:member:' + ref + ':' + row.generation;
  }
  return null;
}
