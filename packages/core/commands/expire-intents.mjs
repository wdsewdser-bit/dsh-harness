/**
 * Downgrade lifecycle intents no driver could settle in time; 08 §4.3.
 *
 * Written as a reducer body so the clock in TeamCore.tick and the profile's driver share one rule: an intent that
 * stayed 'intent'/'applying' past its threshold stops being presented as "in flight" and becomes the operator's to
 * reconcile, exactly like an interrupted lifecycle. Returns how many rows were downgraded.
 */
export function expireIntents(tx, now, timeoutMs) {
  let expired = 0;
  for (const intent of tx.list('member-intent:')) {
    if (!['intent', 'applying'].includes(intent.status)) continue;
    if (now - (intent.createdAt ?? now) < timeoutMs) continue;
    tx.put(intent.entityId, { ...intent, status: 'unknown', reason: 'lifecycle intent timed out without native stop evidence',
      responsible: 'operator', nextReviewAt: now + 60000 });
    // The member row has to say so too, otherwise the projection keeps showing the last native observation and the
    // operator never sees that this one is theirs to reconcile. Same shape as the failure path in native.mjs.
    const member = intent.memberRef ? tx.read(intent.memberRef) : null;
    if (member && member.status !== 'retired') {
      tx.put(member.entityId, { ...member, status: 'unknown', reason: 'lifecycle intent timed out',
        responsible: 'operator', nextReviewAt: now + 60000 });
    }
    expired += 1;
  }
  return expired;
}
