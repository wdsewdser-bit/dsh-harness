/**
 * Which rows of the in-memory projection may be dropped once the limit is reached.
 *
 * The rule is one sentence - an archived row may go, a live one may not - so every family the host writes is listed
 * here by the state that closes it. The host driver added four families that were never listed, and a long run then
 * grew the map without bound: the offline soak's 30-minute heap plateau is what caught it (M1b-F2 §22.8).
 *  - effect / effect-ledger: closed once the effect reached a terminal status; pending, applying and unknown stay
 *    (an unknown effect is the operator's decision, and the view publishes it). The ledger row belongs to its effect, so
 *    it follows that effect's status instead of being archived on its own: trimming the ledger of an unknown or
 *    in-flight effect would leave the projection describing an effect it can no longer account for.
 *  - visibility-audit, wake-receipt, attempt-dispatch: append-only receipts of a request, a wake and a dispatch.
 *
 * P7 (docs/decisions/team-autonomy-design.md §10 P7, appendix 8) adds three families and two lifecycle rules:
 *  - audit: NEVER archived. A verdict is the record that somebody decided something on some evidence; a projection that
 *    drops it answers "nobody decided" to a question the store still answers, and the UI's audit trail is exactly the
 *    place where that difference is read. It is bounded by decisions, not by time.
 *  - decision: archived only once terminal (decided / expired / superseded). An open row is somebody's inbox item and
 *    stays until it is answered; a closed row is still fully described by its audit row.
 *  - usage: aggregated once the family outgrows the limit, never simply dropped. Every row carries the cumulative
 *    reading it was derived from (totalInput / totalOutput), so one row per (member, session) can carry the whole sum:
 *    the newest row is rewritten to the totals and the rest are dropped, which keeps `usageOf` answering the same
 *    number while the per-turn detail (what the UI does not need) goes away.
 *  - group / member.workspace: reclaimed when their lifecycle is over - the workspace of a retired member, and a group
 *    with no member left and no provisioning intent in flight. Before that they are live rows describing where work
 *    runs, and the fence still reads them.
 */
const closedEffect = status => ['confirmed', 'retryable', 'cancelled', 'dead-letter'].includes(status);
/** The effect a ledger row accounts for; a ledger whose effect is gone (already trimmed) has nothing left to protect. */
const ledgerCloses = (rows, id) => {
 const effect = rows.get('effect:' + id.slice('effect-ledger:'.length));
 return !effect || closedEffect(effect.status);
};
/** §2.2.6: a decision that can no longer be decided carries no inbox item; its audit row keeps the record. */
const TERMINAL_DECISION = Object.freeze(['decided', 'expired', 'superseded']);
/** The member states that end a binding: after these the workspace is inert (§4.2.4). */
const RETIRED = Object.freeze(['retired', 'cancelled']);

/**
 * §4.2.4/appendix 8: reclaim the workspace of a retired member and groups nobody belongs to any more.
 *
 * This is not an archive rule - it does not wait for the limit. The lifecycle is over, so the row answers nothing that
 * is still true. A member that is only unknown keeps its workspace: §4.3 sends root back to re-assign exactly there.
 */
function reclaimFinished(rows) {
  for (const [id, row] of [...rows]) {
    if (id.startsWith('member.workspace:')) {
      // An assignment is written before the member row exists (§4.2.1), so a missing member keeps it; only a retired
      // member's workspace is over. A member that is merely unknown keeps its workspace -- §4.3 re-assigns right there.
      const member = rows.get(row.memberId ?? id.slice('member.workspace:'.length));
      if (member && RETIRED.includes(member.status)) rows.delete(id);
      continue;
    }
    if (id.startsWith('group:')) {
      // A group is reclaimed when it HAD members and every one of them retired. A group nobody ever joined is a plan,
      // not a leftover: root may create it ahead of its members, and a pending provisioning intent keeps it alive too.
      const name = row.name ?? id.slice('group:'.length);
      const holders = [...rows.values()].filter(other => other.entityId.startsWith('member:') && other.group === name);
      const live = holders.some(member => !RETIRED.includes(member.status));
      const retired = holders.some(member => RETIRED.includes(member.status));
      const pending = [...rows.values()].some(other => other.entityId.startsWith('member-intent:') &&
        other.status === 'intent' && other.group === name);
      if (!live && retired && !pending) rows.delete(id);
    }
  }
}

/**
 * §8.2.2/appendix 8: fold the usage detail once the family outgrows the limit.
 *
 * One row per (member, session) survives. Its increment becomes the group's total - taken from the cumulative reading
 * the newest row already carries when it has one - so the sum a budget reads is unchanged while the per-turn detail,
 * which the UI never shows, is gone. `aggregated` says how many rows were folded into it.
 */
function aggregateUsage(rows, limit) {
  const usage = [...rows].filter(([id]) => id.startsWith('usage:'));
  if (usage.length <= limit) return;
  const groups = new Map();
  for (const entry of usage) {
    const row = entry[1];
    const key = String(row.memberId ?? '') + '|' + String(row.sessionId ?? '');
    const list = groups.get(key);
    if (list) list.push(entry); else groups.set(key, [entry]);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0) || a[0].localeCompare(b[0]));
    const [keepId, keep] = list.at(-1);
    const rest = list.slice(0, -1);
    const sum = key => rest.reduce((total, entry) => total + (Number.isFinite(entry[1][key]) ? entry[1][key] : 0), 0);
    const own = key => (Number.isFinite(keep[key]) ? keep[key] : 0);
    rows.set(keepId, { ...keep,
      input: Number.isFinite(keep.totalInput) ? keep.totalInput : own('input') + sum('input'),
      output: Number.isFinite(keep.totalOutput) ? keep.totalOutput : own('output') + sum('output'),
      turns: own('turns') + sum('turns'),
      aggregated: own('aggregated') + sum('aggregated') + rest.length });
    for (const entry of rest) rows.delete(entry[0]);
  }
}

/**
 * P5 (§3.4): the resource thread families.
 *
 * A thread event may leave the in-memory projection only below the resource's retention watermark and only when
 * nothing still reserves it: a pending delivery of that exact event, or a decision that cites it. A delivery may go
 * once it is terminal and its event is no longer held. A committed batch reserves the event bodies it carried. A
 * subscription row is durable audience history (active, paused or closed) and is never collected here. The resource
 * index and the resource thread row itself are
 * never archived here: reopening the same resource must find the same thread.
 */
function threadEventKey(row) {
  if (typeof row?.eventRef === 'string') return row.eventRef;
  return typeof row?.threadRef === 'string' && Number.isSafeInteger(row?.seq)
    ? 'thread-event:' + row.threadRef + ':' + String(row.seq).padStart(6, '0') : null;
}
/** Every event a pending delivery, a committed batch or a decision still names (§3.4: evidence outlives its summary). */
function reservedThreadEvents(rows) {
  const reserved = new Set();
  for (const row of rows.values()) {
    if (row.entityId?.startsWith('thread-delivery:') && ['pending', 'unknown'].includes(row.state)) {
      const key = threadEventKey(row); if (key) reserved.add(key);
    }
    // A manifest is the evidence of what a request actually carried; its resource bindings name the event body.
    if (row.entityId?.startsWith('manifest:')) {
      for (const binding of row.inputBindings ?? []) {
        if (binding?.kind === 'thread-delivery' && typeof binding.bodyRef === 'string') reserved.add(binding.bodyRef);
      }
      for (const ref of row.detailRefs ?? []) {
        const delivery = typeof ref === 'string' && ref.startsWith('thread-delivery:') ? rows.get(ref) : null;
        const key = threadEventKey(delivery); if (key) reserved.add(key);
      }
      continue;
    }
    if (!/^(decision:|audit:)/.test(row.entityId ?? '')) continue;
    const refs = [row.subject?.id, row.verdict?.evidenceRef, row.evidenceRef, ...(row.evidence ?? []).map(entry => entry?.ref)];
    for (const ref of refs) {
      if (typeof ref !== 'string') continue;
      if (ref.startsWith('thread-event:')) reserved.add(ref);
      const delivery = ref.startsWith('thread-delivery:') ? rows.get(ref) : null;
      const key = threadEventKey(delivery); if (key) reserved.add(key);
    }
  }
  return reserved;
}
function resourceEventCollectable(row, rows, reserved) {
  const thread = typeof row.threadRef === 'string' ? rows.get(row.threadRef) : null;
  // A missing thread is not proof the history was collected: keep the event rather than invent an orphan.
  if (!thread || thread.kind !== 'resource') return false;
  if (!Number.isSafeInteger(row.seq) || row.seq >= (thread.retainedFrom ?? 1)) return false;
  return !reserved.has(row.entityId);
}

export function retain(rows, limit, { protocol = 'off' } = {}) {
 const borrow = protocol === 'v1';
 reclaimFinished(rows);
 aggregateUsage(rows, limit);
 const reserved = borrow ? reservedThreadEvents(rows) : new Set();
 // A decision/audit may cite the carried batch rather than the event itself. Keep the request binding as well
 // as its body; uncited manifests still roll off under the ordinary recent limit.
 const cited = new Set();
 if (borrow) for (const row of rows.values()) {
   if (!/^(decision:|audit:)/.test(row.entityId ?? '')) continue;
   for (const ref of [row.subject?.id, row.verdict?.evidenceRef, row.evidenceRef, ...(row.evidence ?? []).map(e => e?.ref)]) {
     if (typeof ref === 'string') cited.add(ref);
   }
 }
 const archive = [...rows].filter(([id,r]) => {
 if (r.status === 'unknown' || (id.startsWith('member-intent:') && ['intent','applying'].includes(r.status))) return false;
 if (borrow) {
 if ((id.startsWith('manifest:') || id.startsWith('thread-delivery:')) && cited.has(id)) return false;
 // Publish-id deduplication belongs to the durable reducer/store, not the read model. Otherwise even a single
 // resource with a moving watermark leaves one projection row per operation forever.
 if (id.startsWith('thread-publish:')) return true;
 // P5: resource rows follow their own reservation rules before any generic archive rule.
 if (id.startsWith('thread-event:')) return resourceEventCollectable(r, rows, reserved);
 if (id.startsWith('thread-delivery:')) {
   if (['pending', 'unknown'].includes(r.state)) return false;
   const event = typeof r.eventRef === 'string' ? rows.get(r.eventRef) : null;
   return !event || resourceEventCollectable(event, rows, reserved);
 }
 // A subscription row is the durable audience fact (active, paused or closed); keeping it is what makes a
 // paused/retired subscription's history readable (§3.1). It is small and bounded by members, so retention keeps
 // it rather than answering 'never subscribed'.
 if (id.startsWith('thread-subscription:')) return false;
 if (id.startsWith('thread-resource:')) return false;
 // A terminal decision may still cite resource evidence in its original evidence[] (not just its verdict).
 // Its audit is not a copy of that list: retain the citation root, or the next trim would forget the reservation.
 if (id.startsWith('decision:') && [r.subject?.id, r.verdict?.evidenceRef, ...(r.evidence ?? []).map(e => e?.ref)]
   .some(ref => typeof ref === 'string' && /^(thread-event:|thread-delivery:|manifest:)/.test(ref))) return false;
 }
 // appendix 8: an audit row is never archived, and a decision only once it can no longer be decided.
 if (id.startsWith('audit:')) return false;
 return /^(checkpoint:|tool-intent:|native-intent:|member-intent:|guard-audit:|manifest:|claim:|settle:|visibility-audit:|wake-receipt:|attempt-dispatch:)/.test(id) || id.startsWith('decision:') && TERMINAL_DECISION.includes(r.state) || id.startsWith('effect-ledger:') && ledgerCloses(rows, id) || id.startsWith('effect:') && closedEffect(r.status) || id.startsWith('attempt:') && !['active','unknown'].includes(r.lease) || id.startsWith('message:') && ['resolved','cancelled','expired','dead-letter'].includes(r.status) || id.startsWith('task:') && ['accepted','cancelled'].includes(r.status);
 });
 archive.sort((a,b)=>(b[1].updatedAt-a[1].updatedAt)||a[0].localeCompare(b[0]));
 for(const [id] of archive.slice(limit)) rows.delete(id);
}
