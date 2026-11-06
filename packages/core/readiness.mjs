/**
 * Thread readiness: what a model may do with a thread now, and what is still missing.
 *
 * A thread carries two independent obligations: every required respondent must reply at least once, and every
 * required evidence ref (for a review issue, one artifact delivery) must be recorded as a non-late reply.
 * Respondent identity alone is not enough, because one respondent reviews several deliveries: treating "the
 * verifier replied" as ready would let the owner decide on a batch that is only partly reviewed, and treating
 * the status alone as "still collecting" hides a batch that is fully reviewed. The same function answers the
 * thread record, reply, decide and the team_read projection, so what a model reads and what the server
 * enforces can never disagree.
 */
export function readiness(thread) {
  const replies = Array.isArray(thread?.replies) ? thread.replies.filter(reply => !reply.late) : [];
  const missing = [];
  for (const member of thread?.requiredRespondents ?? []) {
    if (!replies.some(reply => reply.actor === member)) missing.push(member);
  }
  for (const ref of thread?.requiredEvidence ?? []) {
    if (!replies.some(reply => reply.bodyRef === ref)) missing.push(ref);
  }
  const status = thread?.status ?? 'unknown';
  const readyToDecide = status === 'collecting' && missing.length === 0;
  const nextAction = status !== 'collecting'
    ? status === 'decided' ? 'decided; nothing left to do'
      : status === 'escalated' ? 'escalated to ' + (thread?.responsible ?? thread?.escalationOwner ?? 'operator') +
        ': ' + (thread?.reason ?? 'deadline passed or a reply is missing')
        : 'closed'
    : readyToDecide
      ? 'every required reply and evidence ref is recorded; the owner may decide or integrate now'
      : 'waiting for ' + missing.join(', ') + '; the owner may not decide yet';
  return { missing, readyToDecide, nextAction };
}
