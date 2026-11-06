import { failWith, hash } from '../../contracts/index.mjs';

/**
 * The silence-equals-consent window of docs/host-protocol.md §4, as pure transaction helpers.
 *
 * An intent is one durable message row that binds (taskRef, contractRevision) to a recipient set. It carries one vote
 * per recipient and one immutable conclusion. Nothing here commits, awaits or reads outside the tx it is handed.
 *
 * The four judgement classes of §4.4 are decided by where an evidence write lands relative to the closing
 * transaction, never by re-reading "is it visible now":
 *   1. evidence committed before the close  -> counted in seenAtClose (the only source of "seen at the deadline");
 *   2. evidence committed after the close whose request happened before closedAt -> lateEvidence, audit only;
 *   3. evidence committed after the close whose request happened after closedAt  -> visibilityAfterClose;
 *   4. evidence bound to an old generation or bindingGeneration -> refused, counted neither way.
 */

/**
 * Whether one closed row's frozen facts are consistent with each other.
 *
 * The counts a report prints are only as good as the row they come from, so the row is audited rather than trusted:
 * the summary must be what the per-recipient flags say, every recipient must have a flag, and a "saw it" must carry the
 * evidence of a request that started inside the window while a "did not" must carry none (§4.4). A row that fails any
 * of the three is a defect in the close, not a quiet team.
 */
export function intentRowAudit(row) {
  const recipients = row.recipients ?? [];
  const seen = row.seenAtClose ?? {};
  const evidence = row.visibilityEvidenceAtClose ?? {};
  return {
    summaryMatches: row.seenSummary === seenSummaryOf(seen),
    everyRecipientFrozen: recipients.every(recipient => typeof seen[recipient] === 'boolean'),
    evidenceMatches: recipients.every(recipient => seen[recipient] === true
      ? Boolean(evidence[recipient]) && Number.isFinite(evidence[recipient].requestedAt) &&
        evidence[recipient].requestedAt < row.closedAt
      : evidence[recipient] === null || evidence[recipient] === undefined),
    passedUnseenMatches: row.decision !== 'passed' ||
      (row.seenSummary !== 'seenAll') === recipients.some(recipient => seen[recipient] !== true),
  };
}

/** An intent that has no conclusion yet. */
export const intentOpen = message => Boolean(message) && message.kind === 'intent' && !message.decision;

/** seenAll / seenPartial / seenNone, computed only from the frozen per-recipient facts. */
export function seenSummaryOf(seenAtClose) {
  const seen = Object.values(seenAtClose ?? {});
  if (!seen.length) return 'seenNone';
  const count = seen.filter(Boolean).length;
  return count === seen.length ? 'seenAll' : count === 0 ? 'seenNone' : 'seenPartial';
}

/**
 * The row a closing intent becomes: the decision, the frozen per-recipient facts, and nothing that a later evidence
 * write could still move (invariant 8 rule 6, §4.4).
 */
export function closedIntentRow(message, decision, closedAt) {
  const seenAtClose = {};
  const visibilityEvidenceAtClose = {};
  for (const recipient of message.recipients ?? []) {
    const evidence = message.visibility?.[recipient] ?? null;
    // "Seen at the close" means the request started strictly before the window's closing instant (§4.3: now < closesAt
    // is the only accepted time; §4.4 class 1). Evidence without a time, or from at/after the close, cannot be
    // promoted here even if it was written while the row still looked open.
    const withinWindow = Boolean(evidence) && Number.isFinite(evidence.requestedAt) && evidence.requestedAt < closedAt;
    seenAtClose[recipient] = withinWindow;
    visibilityEvidenceAtClose[recipient] = withinWindow
      ? { requestId: evidence.requestId, manifestHash: evidence.manifestHash, sessionSeq: evidence.sessionSeq,
        requestedAt: evidence.requestedAt }
      : null;
  }
  return { ...message, decision, closedAt, status: decision, seenAtClose, visibilityEvidenceAtClose,
    seenSummary: seenSummaryOf(seenAtClose) };
}

/**
 * Close an intent in this transaction. The conclusion is terminal: a later intent must name a new contract revision,
 * and every later visibility fact is audit only. The result effect is what wakes the initiator (host-protocol §5.2).
 */
export function closeIntent(tx, message, decision, closedAt) {
  const row = tx.put(message.entityId, closedIntentRow(message, decision, closedAt));
  // F1 R6-1: the result carries the binding recorded when the window opened. It is copied here, never re-derived:
  // looking up "who is running now" is exactly how a result ended up addressing an execution that never opened this
  // intent. A row written before the binding existed has no target, and the consumer must refuse rather than guess.
  const initiator = message.initiator ?? { kind: 'unbound', memberId: message.sender, attemptId: null,
    generation: null, fence: null };
  tx.outbox('intent-result:' + message.entityId, { kind: 'intent-result', messageId: message.entityId,
    decision, seenAtClose: row.seenAtClose, initiator });
  return row;
}

/** Close every open intent whose window has run out; the clock owns the only timer (§4.5 rule 1). */
export function expireIntents(tx, now) {
  // A v1 intent has no window to run out: its TTL belongs to the coordination decision that carries it (§3.3 rule 6),
  // so the M2b sweep never closes one as passed. With no v1 row in the store this predicate is HEAD's, unchanged.
  const expired = tx.list('message:').filter(message => message.kind === 'intent' && message.status === 'open' &&
    message.protocol !== ROOT_DECISION_PROTOCOL && Number.isFinite(message.closesAt) && message.closesAt <= now);
  for (const message of expired) closeIntent(tx, message, 'passed', message.closesAt);
  return expired.length;
}

/**
 * The in-transaction gate (§4.2 rule 5): publishing work bound to (taskRef, contractRevision) needs a passed intent
 * from this member for exactly that binding. open refuses the publish but allows preparation; objected refuses the
 * revision until a new intent names a new one.
 */
export function assertIntentAllows(tx, { actor, taskRef, contractRevision }) {
  // A root-decision intent is not an M2b window: it can neither pass by silence nor be waived here, and v1 is judged
  // by assertCoordinationAllows instead (§3.3 rule 5). In an off/legacy store this filter matches nothing new.
  const bound = tx.list('message:').filter(message => message.kind === 'intent' &&
    message.protocol !== ROOT_DECISION_PROTOCOL && message.sender === actor &&
    message.taskRef === taskRef && message.contractRevision === contractRevision);
  // §2.2.3: the conclusion stays terminal and the waiver travels beside it. A revision is unblocked only by a waiver
  // decided against THIS revision, in a decision row that really reached 'decided' with option 'waive' -- the fact is
  // read here, in the transaction that publishes, never from a flag the objector could have written. Without the
  // autonomy package no row carries waivers at all, so this branch cannot fire in the product as it is today.
  const waived = message => (message.waivers ?? []).some(waiver => waiver.contractRevision === contractRevision &&
    tx.read(waiver.decisionRef)?.state === 'decided' && tx.read(waiver.decisionRef)?.verdict?.option === 'waive');
  if (bound.some(message => message.decision === 'objected' && !waived(message))) {
    failWith('INTENT_OBJECTED', 'a recipient objected to contract revision ' + contractRevision + ' of ' + taskRef +
      '; send a new team_message kind=intent for a new revision before publishing');
  }
  // A waived objection is not a passed window, but it is no longer a block either: the revision may be published,
  // and the waiver row (not the conclusion) is what a report reads to tell "nobody objected" from "overruled".
  if (bound.some(message => message.decision === 'passed' ||
    (message.decision === 'objected' && waived(message)))) return;
  if (bound.length) {
    failWith('INTENT_WINDOW_OPEN', 'the intent window for contract revision ' + contractRevision + ' of ' + taskRef +
      ' is still open; silence is consent, so prepare and retry when the window closes');
  }
  failWith('INTENT_REQUIRED', 'send team_message kind=intent to the downstream that consumes this work ' +
    '(taskRef, contractRevision, expectedOutcome) before publishing: ' + taskRef + '@' + contractRevision);
}

/**
 * §3.3: the two intent protocols. 'silence-pass-m2b' is HEAD's window; 'root-decision-v1' is §12's selection.
 *
 * The selection travels on the command as trusted entry metadata (like autonomy/decisionTtlMs), never in a payload, so
 * a request cannot choose the protocol it is judged under. Nothing here turns v1 on: the composition root still
 * refuses to boot it until every stage in the contract's implementation table is installed.
 */
export const ROOT_DECISION_PROTOCOL = 'root-decision-v1';
export const SILENCE_PASS_PROTOCOL = 'silence-pass-m2b';

export function intentProtocolOf(command) {
  return command?.intentProtocol === ROOT_DECISION_PROTOCOL ? ROOT_DECISION_PROTOCOL : SILENCE_PASS_PROTOCOL;
}

/** One v1 intent: a request for a root decision, not a window with votes. */
export function isCoordinationIntent(message) {
  return Boolean(message) && message.kind === 'intent' && message.protocol === ROOT_DECISION_PROTOCOL;
}

/** Visibility may change a row revision, but the question a root read must stay identical. */
export const coordinationQuestionHash = message => hash(JSON.stringify([
  message.sender, message.taskRef, message.contractRevision, message.summary, message.bodyRef,
  message.reason, message.expectedOutcome, message.evidenceRefs, message.recipients, message.initiator,
], (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value));

/** The closed option set of a coordination decision (§3.3 rule 3). */
export const COORDINATION_OPTIONS = Object.freeze(['approve', 'reject', 'request-revision']);

/** The state an option leaves on the intent row. */
export const coordinationStateOf = option => option === 'approve' ? 'approved'
  : option === 'reject' ? 'rejected' : 'revision-requested';

/**
 * The coordination decisions that bind one (taskRef, contractRevision).
 *
 * A superseded row is history: it neither grants nor blocks, which is what makes a new contract revision start from
 * zero instead of inheriting an approval nobody gave for it (§3.3 rule 5).
 */
export function coordinationDecisions(store, { taskRef, contractRevision } = {}) {
  if (typeof taskRef !== 'string' || !Number.isSafeInteger(contractRevision)) return [];
  // Newest request first: the block the gate reports is the question that is actually open, not the oldest answer to a
  // question that has since been asked again.
  return store.list('decision:').filter(row => row.kind === 'coordination' && row.state !== 'superseded' &&
    row.binding?.taskRef === taskRef && row.binding?.contractRevision === contractRevision)
    .sort((a, b) => (b.binding?.requestSeq ?? 0) - (a.binding?.requestSeq ?? 0) ||
      (b.openedAt ?? 0) - (a.openedAt ?? 0));
}

/** What one coordination decision means right now: approved, or the reason it still blocks. */
export function coordinationDecisionState(row) {
  if (!row) return 'clear';
  if (row.state === 'decided') return row.verdict?.option === 'approve' ? 'approved' : coordinationStateOf(row.verdict?.option);
  if (row.state === 'expired') return 'expired';
  return 'open';
}

const COORDINATION_CODES = Object.freeze({ open: 'COORDINATION_PENDING', expired: 'COORDINATION_PENDING',
  rejected: 'COORDINATION_REJECTED', 'revision-requested': 'COORDINATION_REVISION_REQUESTED' });

/**
 * The explicit coordination block on one revision, or null when root has cleared it (§3.3 rule 5).
 *
 * Only a decision that really reached 'decided' with 'approve' clears it: an expired TTL leaves the revision blocked
 * with its evidence (rule 6), and a rejection or a revision request keeps it blocked until root answers again.
 */
export function coordinationBlock(store, binding = {}) {
  const rows = coordinationDecisions(store, binding);
  const answered = new Set();
  for (const row of rows.filter(row => coordinationDecisionState(row) === 'approved')) {
    let previous = row.binding?.previousDecisionId;
    while (previous && !answered.has(previous)) {
      const prior = rows.find(candidate => candidate.entityId === previous);
      if (!prior) break;
      answered.add(previous);
      previous = prior.binding?.previousDecisionId;
    }
  }
  const blocking = rows.filter(row => !answered.has(row.entityId) && coordinationDecisionState(row) !== 'approved');
  if (!blocking.length) return null;
  const first = blocking[0];
  const state = coordinationDecisionState(first);
  return Object.freeze({ code: COORDINATION_CODES[state] ?? 'COORDINATION_PENDING', state, decisionId: first.entityId,
    decisions: Object.freeze(rows) });
}

/**
 * The one publish gate (§3.3, replacing the per-task intent requirement in v1).
 *
 * Legacy keeps HEAD's rule exactly; v1 asks whether an explicit coordination request on THIS revision is still open.
 * produce, verify, thread.decide and the host/API finish all call this one entry, so the four answers cannot differ.
 */
export function assertCoordinationAllows(tx, command, binding) {
  if (intentProtocolOf(command) !== ROOT_DECISION_PROTOCOL) return assertIntentAllows(tx, binding);
  const block = coordinationBlock(tx, { taskRef: binding?.taskRef, contractRevision: binding?.contractRevision });
  if (!block) return;
  failWith(block.code, 'contract revision ' + binding?.contractRevision + ' of ' + binding?.taskRef + ' is blocked by ' +
    block.decisionId + ' (' + block.state + '); root has to decide it (team_decide approve|reject|request-revision). ' +
    'An expired decision keeps the block: a root request that timed out is not an approval');
}

/**
 * §3.3 rule 6: the intent row a coordination verdict resolves, plus the one result effect its initiator owns.
 *
 * The result carries the binding frozen when the request opened (the same F1 R6-1 discipline as closeIntent): the
 * consumer that receives it must be the execution that asked, and an execution that started later is refused there —
 * never handed the answer through a guess made here.
 */
export function resolveCoordinationIntent(tx, message, { option, decisionRef, actor, at }) {
  if (!isCoordinationIntent(message)) {
    failWith('WRONG_INTENT_PROTOCOL', message?.entityId + ' is not a root-decision intent; only one has coordination options');
  }
  const state = coordinationStateOf(option);
  const row = tx.put(message.entityId, { ...message, status: state, closedAt: at,
    coordination: { state, option, decisionRef, by: actor, at } });
  tx.outbox('intent-result:' + message.entityId, { kind: 'intent-result', messageId: message.entityId,
    decision: option, coordination: state, seenAtClose: null,
    initiator: message.initiator ?? { kind: 'owner', memberId: message.sender, attemptId: null, generation: null, fence: null } });
  return row;
}

/** §3.3 rule 6: a TTL left the request unanswered — the revision stays blocked, with the evidence intact. */
export function expireCoordinationIntent(tx, message, { decisionRef, at }) {
  if (!isCoordinationIntent(message) || message.status !== 'open') return message;
  const row = tx.put(message.entityId, { ...message, status: 'expired-unresolved', closedAt: at,
    coordination: { state: 'expired-unresolved', option: null, decisionRef, at } });
  tx.outbox('intent-result:' + message.entityId, { kind: 'intent-result', messageId: message.entityId,
    decision: 'expired-unresolved', coordination: 'expired-unresolved', seenAtClose: null,
    initiator: message.initiator ?? { kind: 'owner', memberId: message.sender, attemptId: null, generation: null, fence: null } });
  return row;
}
