import { fail, failWith, id } from '../../contracts/index.mjs';
import { decisionAuthority } from '../authority.mjs';
import { closeGoalOnCompletion } from './goals.mjs';
import { adjudicateMessage } from './messages.mjs';
import { coordinationQuestionHash, expireCoordinationIntent, isCoordinationIntent, resolveCoordinationIntent } from './intents.mjs';

/**
 * P1 of the team-autonomy design (docs/decisions/team-autonomy-design.md §2, §9.4): the decision row.
 *
 * A decision is ONE thing that needs adjudication: a subject row at a named revision, the evidence for it, a closed
 * option set fixed when the row opens, a TTL and one terminal state. It is not a second write path: every option is
 * applied by the reducer that already owns that fact (message.adjudicate here; further kinds arrive with the packages
 * that own their reducers, §2.2.1). What this file adds is authority, the audit trail and the operator notice.
 *
 * Nothing in here commits, awaits or reads outside the transaction it is handed (§10 "并发": no await inside a
 * transaction). A verdict either lands with its domain write, its audit row and its notice, or none of them.
 */

/**
 * §12 U7: what one session journal proves about one completion token, in the one place both deciding entries read.
 *
 * A completion is decided on log evidence or not at all, and the owner channel and the model's team_decide tool must
 * answer that question the same way -- so the match lives here rather than being written twice. The option is the one
 * the caller asked for; a proof that does not fit it is the reducer's JOURNAL_CONFLICT, never a softer "unknown".
 */
export function completionProofOf(journal, token, option) {
  if (!journal || journal.available !== true) {
    failWith('SESSION_LOG_UNAVAILABLE', 'the completion verdict needs the session journal (' +
      String(journal?.capability ?? 'unavailable') + ')');
  }
  const goal = token?.input?.goal ?? null;
  const events = (journal.events ?? []).filter(entry => entry.type === 'goal/change' &&
    entry.data?.goal?.phase === 'complete' && entry.data.goal.id === goal?.id);
  const event = events.find(entry => entry.data.goal.revision === (goal?.revision ?? 0) + 1 &&
    entry.data.goal.objective === goal?.objective && entry.data.goal.maxGoalRounds === goal?.maxGoalRounds);
  if (option === 'consumed') {
    if (!event) {
      failWith('JOURNAL_CONFLICT', 'no completion event for ' + goal?.id + ' at revision ' +
        ((goal?.revision ?? 0) + 1) + ' in the journal of ' + journal.sessionId);
    }
    return { sessionId: journal.sessionId, seq: event.seq, expectedRevision: event.data.goal.revision,
      goalId: goal?.id ?? null };
  }
  if (option === 'cancelled') {
    if (events.length) {
      failWith('JOURNAL_CONFLICT', 'the journal of ' + journal.sessionId + ' contains a completion for ' +
        (goal?.id ?? 'this goal') + '; it cannot be cancelled');
    }
    return { sessionId: journal.sessionId, absent: true, goalId: goal?.id ?? null };
  }
  return null;
}

/**
 * The options each kind may be decided with, fixed when the row opens and never widened (§2.2.1).
 *
 * Only the kinds whose reducers live in this package are opened here. The rest of the §2.2.1 table names reducers
 * that belong to later packages (goal gate, member lifecycle, workspaces, budgets); their rows will open with their
 * own option set when those packages land, and adding them here without their reducer would publish an option set
 * nothing can apply.
 */
export const DECISION_OPTIONS = Object.freeze({
  'objection': Object.freeze(['waive', 'uphold', 'withdraw']),
  'unknown-effect': Object.freeze(['effective', 'not-effective', 'abandoned']),
  // P3 §2.2.1: a completion token (§12 U7). Root may decide it, but only on the journal evidence the goal gate read
  // back -- see applyOption: a verdict without that proof is refused, never applied on a claim.
  'completion': Object.freeze(['consumed', 'cancelled']),
  // P5 §7.2.2/§12 U8: a member whose stop could not be proven is handed to the operator. Only `wait` is opened here:
  // `replace` and `stop` are applied by the member-lifecycle reducers (§2.2.4) and publishing them before those exist
  // would be an option set nothing can apply -- the same rule this table already follows for every other kind.
  'stuck-member': Object.freeze(['wait']),
  // P6 §8.2.3 / §12 U2: a token count nobody could measure. 'continue' is the design's default outcome (a measurement
  // hole never stops the team by itself); 'stop' is the only option that refuses new work, and it is root's to choose.
  'budget-unknown': Object.freeze(['continue', 'stop']),
  // §3.3 rule 3 (P1): one member asking root to change a commitment, an owner or a contract. The options are the
  // design's closed set, and only 'approve' clears the publish block on that contract revision.
  'coordination': Object.freeze(['approve', 'reject', 'request-revision']),
});

/** Every state a decided row can no longer be decided from (§2.2.6). */
const TERMINAL = Object.freeze(['decided', 'expired', 'superseded']);

/**
 * Open one decision row (§2.2.6: opened by a reducer in another command's transaction, never by a request).
 *
 * The subject revision is frozen here and re-checked when the verdict lands, which is what makes a stale subject
 * DECISION_STALE instead of a verdict applied to a row nobody looked at (§2.3).
 */
export function openDecision(tx, command, { kind, subject, evidence, openedFor = null, now = null, ttlMs = null,
  fallback = 'stay', decisionId = null, binding = null }) {
  if (command?.autonomy !== 'on') failWith('DENIED', 'a decision row is opened only with the autonomy switch on');
  const options = DECISION_OPTIONS[kind];
  if (!options) failWith('DENIED', 'no decision kind ' + JSON.stringify(kind) + ' is opened by this package');
  if (!subject?.id || !Number.isSafeInteger(subject.revision)) {
    failWith('MISSING_REFERENCE', 'a decision names the subject row and the revision it was opened against');
  }
  if (!Array.isArray(evidence) || evidence.length === 0) {
    failWith('MISSING_EVIDENCE', 'a decision carries at least one evidence reference; a verdict without evidence is ' +
      'an opinion');
  }
  const at = now ?? command.now ?? Date.now();
  const ttl = Number.isSafeInteger(ttlMs) && ttlMs > 0 ? ttlMs : 900000;
  return tx.put(decisionId ?? 'decision:' + id('decision'), {
    kind,
    subject: { type: subject.type, id: subject.id, revision: subject.revision,
      ...(kind === 'coordination' ? { fingerprint: subject.fingerprint } : {}) },
    // A kind that is decided about a revision of some work names the binding it was opened against (P1's coordination
    // rows); every other kind writes no binding key at all, so their rows are byte-identical to the rows they had.
    ...(binding ? { binding } : {}),
    evidence,
    options: options.slice(),
    openedFor,
    openedAt: at,
    opensBy: 'system',
    expiresAt: at + ttl,
    fallback,
    state: 'open',
    verdict: null,
  });
}

/**
 * P4 §6.2.4: the opening entry for an effect whose outcome could not be proven (§6.2.1 "两者都没有、或两者都失败").
 *
 * The subject is the effect's own ledger row (`effect:<effectId>`, the row the store keeps in step with the outbox), so
 * the verdict is checked against the exact revision the adapter saw: if the effect moved between the ticket and the
 * verdict the row is stale and the verdict is refused, instead of being applied to a row nobody looked at. The options
 * are the closed set DECISION_OPTIONS already publishes for this kind; the evidence names a readable row (what the
 * adapter observed), because a verdict without evidence is an opinion.
 */
export function openUnknownEffect(tx, command, { effectId, revision, evidence, openedFor = 'member:root', ttlMs = null } = {}) {
  if (typeof effectId !== 'string' || !effectId) {
    failWith('MISSING_REFERENCE', 'an unknown effect must name the effect row it could not settle');
  }
  if (!Number.isSafeInteger(revision)) {
    failWith('MISSING_REFERENCE', 'an unknown effect must name the revision of the row it was opened against');
  }
  return openDecision(tx, command, { kind: 'unknown-effect', subject: { type: 'effect', id: 'effect:' + effectId, revision },
    evidence, openedFor, ttlMs, fallback: 'stay' });
}

/**
 * The transaction a verdict may write in: the decision row, its audit rows, the subject row, and the one notice row
 * this transaction created (§2.3, §9.2 rule 3).
 *
 * It is the same discipline as core-access.mjs:72-90 -- the reducer that applies the verdict receives this object
 * instead of the raw transaction, so a bug there cannot reach a row the decision did not name, and the refusal rolls
 * the whole decision back. The audit row is inside the whitelist on purpose: writing the verdict without its record
 * must not compile into a commit.
 */
function restrictedDecisionTx(tx, { decisionId, subjectId = null, noticeId, extras = [], outboxIds = [] }) {
  const entity = candidate => candidate === decisionId || candidate === subjectId || candidate === noticeId ||
    extras.includes(candidate) || candidate.startsWith('audit:') || candidate.startsWith('decision:');
  return Object.freeze({
    read: key => tx.read(key),
    list: prefix => tx.list(prefix),
    latestEventSeq: exclude => (typeof tx.latestEventSeq === 'function' ? tx.latestEventSeq(exclude) : 0),
    put: (key, data) => {
      if (!entity(key)) failWith('DENIED', JSON.stringify(key) + ' is outside the rows a decision verdict may write');
      return tx.put(key, data);
    },
    outbox: (key, payload) => {
      // The operator notice plus the exact effects the decision itself owns: a coordination verdict closes the intent
      // it adjudicated, and that close is one result effect to the initiator (§3.3 rule 6). The key is named here, at
      // open time, never discovered while applying the option.
      if (key !== noticeId && !outboxIds.includes(key)) {
        failWith('DENIED', JSON.stringify(key) + ' is not an effect of this decision');
      }
      return tx.outbox(key, payload);
    },
  });
}

/**
 * Apply one option through the reducer that owns the fact.
 *
 * The option is already known to be in the closed set; what is left is the domain rule the reducer applies (a row
 * that is not "unknown" cannot be adjudicated, a rebind needs a recipient that exists, ...). Those refusals keep their
 * own codes, so a verdict contradicted by the evidence fails with the reducer's answer rather than with the decision's.
 */
function applyOption(tx, command, decision, subject, option, now) {
  const p = command.payload ?? {};
  const evidenceRef = p.evidenceRef ?? decision.evidence?.[0]?.ref ?? null;
  if (decision.kind === 'objection') {
    if (option === 'uphold') return { applied: 'objection stands', evidenceRef };
    if (option === 'waive') {
      return { applied: 'waived', evidenceRef, row: tx.put(subject.entityId, { ...subject,
        waivers: [...(subject.waivers ?? []), { decisionRef: decision.entityId,
          contractRevision: subject.contractRevision, by: command.actor, at: now }] }) };
    }
    return { applied: 'withdrawn', evidenceRef, row: tx.put(subject.entityId, { ...subject,
      withdrawn: { decisionRef: decision.entityId, by: command.actor, at: now } }) };
  }
  if (decision.kind === 'unknown-effect') {
    return { applied: option, evidenceRef, row: adjudicateMessage(tx, { ...command, type: 'message.adjudicate',
      payload: { messageId: subject.entityId, decision: option, evidenceRef, operationId: command.operationId } }) };
  }
  if (decision.kind === 'completion') {
    // §12 U7: a completion is decided on log evidence or not at all. The proof is produced by GoalGate.decideCompletion
    // (the only reader of the session journal) and rides the command as trusted metadata; a verdict that arrives
    // without one -- a model call, a UI call, anything that did not read a journal -- is refused here.
    const proof = command.journal;
    if (!proof || typeof proof.sessionId !== 'string' || !proof.sessionId) {
      failWith('SESSION_LOG_UNAVAILABLE', 'a completion verdict needs the session journal readback; it is produced by ' +
        'the goal gate, not by a request (§12 U7)');
    }
    const sessionRef = decision.evidence?.find(entry => entry.kind === 'journal')?.ref ?? null;
    if (sessionRef !== null && sessionRef !== proof.sessionId) {
      failWith('DECISION_STALE', 'the verdict cites the journal of ' + proof.sessionId + ' but this decision was opened ' +
        'against ' + sessionRef);
    }
    const tokenId = subject.entityId;
    if (option === 'consumed') {
      const revision = subject.input?.goal?.revision ?? null;
      if (!Number.isSafeInteger(proof.seq) || !Number.isSafeInteger(revision) || proof.expectedRevision !== revision + 1) {
        failWith('JOURNAL_CONFLICT', 'the proof does not match the completion this token was prepared for');
      }
      const adjudication = { decision: option, evidence: { sessionId: proof.sessionId, seq: proof.seq },
        actor: command.actor, at: now };
      const ref = 'inconsistency:' + proof.sessionId + ':' + proof.seq;
      const inconsistency = tx.read(ref);
      if (inconsistency) tx.put(ref, { ...inconsistency, status: 'resolved', tokenId, adjudication });
      const row = tx.put(tokenId, { ...subject, status: 'consumed', seq: proof.seq,
        expectedRevision: proof.expectedRevision, adjudication, responsible: null, nextReviewAt: null });
      // §5.2.2: the consumed completion is what closes the team goal, in the same transaction as the verdict.
      closeGoalOnCompletion(tx, { goalId: command.teamGoalId, tokenId, at: now });
      return { applied: 'completion consumed', evidenceRef: tokenId, row };
    }
    if (proof.absent !== true) failWith('JOURNAL_CONFLICT', 'the proof does not establish that no completion was published');
    const adjudication = { decision: option, evidence: { sessionId: proof.sessionId, absent: true },
      actor: command.actor, at: now };
    return { applied: 'completion cancelled', evidenceRef: tokenId,
      row: tx.put(tokenId, { ...subject, status: 'cancelled', adjudication, responsible: null, nextReviewAt: null }) };
  }
  if (decision.kind === 'budget-unknown') {
    // §8.2.3: the verdict is recorded on the row that reported the gap. 'continue' restarts the grace clock so the same
    // hole is not re-opened every cycle; 'stop' refuses new work for that member until a real measurement arrives, and a
    // measurement clears the row (usage.mjs), which is what lifts it again.
    if (!subject) failWith('DECISION_STALE', 'the usage row this decision was opened against no longer exists');
    const next = option === 'stop'
      ? { ...subject, stopped: true, since: now, lastAt: now, verdict: { option, by: command.actor, at: now } }
      : { ...subject, stopped: false, since: now, lastAt: now, acknowledgedAt: now, verdict: { option, by: command.actor, at: now } };
    return { applied: option === 'stop' ? 'new work refused until the count is measured' : 'the team keeps running',
      evidenceRef, row: tx.put(subject.entityId, next) };
  }
  if (decision.kind === 'coordination') {
    // §3.3 rule 4: the verdict resolves the request it names and nothing else. It grants root no write capability on the
    // work itself -- a real reassignment or contract change still travels the domain commands that own those rows.
    if (!subject) failWith('DECISION_STALE', 'the coordination request this decision was opened against no longer exists');
    const row = resolveCoordinationIntent(tx, subject, { option, decisionRef: decision.entityId, actor: command.actor, at: now });
    return { applied: option === 'approve' ? 'coordination approved; the revision may publish' : 'coordination ' + option,
      evidenceRef: row.entityId, row };
  }
  if (decision.kind === 'stuck-member') {
    // §12 U8: this kind exists to hand a member to the operator when no stop proof arrived. `wait` changes no domain
    // fact -- the member is already unknown with the operator responsible when the row opens -- so the verdict is the
    // record that a human took it, and the audit/notice every verdict writes are the whole effect.
    return { applied: 'operator keeps the member', evidenceRef };
  }
  return failWith('DENIED', 'no verdict is applied for decision kind ' + JSON.stringify(decision.kind));
}

/** The mandatory record of one verdict (§9.4): who decided, on what evidence, and what the option was. */
function recordAudit(tx, command, decision, { authority, option, evidenceRef, at, applied }) {
  return tx.put('audit:' + id('audit'), {
    kind: 'decision',
    decisionId: decision.entityId,
    subject: decision.subject,
    option,
    evidenceRef: evidenceRef ?? null,
    by: command.actor,
    byKind: authority.kind,
    at,
    operationId: command.operationId,
    priorRevision: decision.subject?.revision ?? null,
    applied: applied ?? null,
  });
}

/**
 * The operator notice (§2.2.7 item 2): one info message, in the same transaction, that nobody has to accept.
 *
 * It never blocks the verdict: the notice is a plain stored row plus its own delivery effect, written without a
 * single refusal of its own, so a team with no operator mailbox still records the decision (§9.4 "审计不可关闭").
 */
function notifyOperator(tx, command, decision, { option, at, noticeId, auditRef }) {
  const operator = tx.read('member:operator');
  const summary = 'decision ' + decision.kind + ' on ' + (decision.subject?.id ?? 'nothing') + ': ' + option +
    ' by ' + command.actor;
  tx.put(noticeId, { sender: command.actor, recipient: 'member:operator', kind: 'info',
    summary: summary.slice(0, 1024), bodyRef: decision.entityId, generation: operator?.generation ?? 1,
    taskRef: null, threadRef: null, expectedOutcome: null, deadline: null, status: 'stored', stored: true,
    visible: false, accepted: false, decisionRef: decision.entityId, auditRef });
  tx.outbox(noticeId, { kind: 'message', messageId: noticeId });
}

/**
 * The one adjudication entry (§2.2.2): a verdict on an open decision row, applied with its audit and its notice.
 *
 * The order is the contract: state, TTL, option set and authority are decided before a single row is written, the
 * subject is re-checked at the revision the row was opened against, and only then does the domain write happen. A
 * replay of the same operationId returns the original receipt (store.commit); a second verdict on the same row is
 * DECISION_STALE because the row is no longer open (§2.2.6).
 */
function decideDecision(tx, command) {
  if (command.autonomy !== 'on') {
    failWith('DENIED', 'decision.decide is part of the autonomy package and is refused while the switch is off');
  }
  const p = command.payload ?? {};
  const decision = tx.read(p.decisionId);
  if (!decision) fail('MISSING_REFERENCE');
  const now = command.now ?? Date.now();
  if (TERMINAL.includes(decision.state)) {
    failWith('DECISION_STALE', 'decision ' + decision.entityId + ' is ' + decision.state + '; a decided or expired ' +
      'row is never reused -- open a new decision against the current revision');
  }
  if (Number.isFinite(decision.expiresAt) && decision.expiresAt <= now) {
    failWith('DECISION_STALE', 'decision ' + decision.entityId + ' expired at ' + new Date(decision.expiresAt).toISOString() +
      '; an expired decision changes nothing (' + (decision.fallback ?? 'stay') + ')');
  }
  if (!(decision.options ?? []).includes(p.decision)) {
    failWith('INVALID_ADJUDICATION', 'decision ' + decision.entityId + ' takes one of ' + (decision.options ?? []).join(', ') +
      '; got ' + JSON.stringify(p.decision ?? null));
  }
  const authority = decisionAuthority(tx, command);
  // §12 U1: the owner that proposed the thing being objected to may not waive that objection. It could only uphold or
  // withdraw, so a self-serving verdict has no option it can choose.
  if (p.decision === 'waive' && decision.openedFor === command.actor) {
    failWith('SELF_JUDGE_DENIED', 'the objection against ' + decision.subject?.id + ' was raised against a proposal of ' +
      command.actor + '; it may uphold or withdraw it, not waive it');
  }
  // §3.3 rule 4: a principal that is itself the requesting party cannot approve its own coordination request. When root
  // is that party, the authenticated operator is the channel the design names -- not a second copy of root.
  if (decision.kind === 'coordination' && p.decision === 'approve' && (decision.binding?.requestedBy === command.actor || decision.binding?.interestedMemberIds?.includes(command.actor) ||
      tx.read(decision.binding?.taskRef)?.owner === command.actor)) {
    failWith('SELF_JUDGE_DENIED', 'the coordination request ' + decision.entityId + ' was opened by ' + command.actor +
      '; it cannot approve its own request (escalate to the authenticated operator)');
  }
  const subject = decision.subject?.id ? tx.read(decision.subject.id) : null;
  if (decision.kind === 'coordination') {
    // §3.3 rules 4-6: the subject is the request itself, and what makes the verdict stale is the request being gone,
    // being another protocol's row, naming another revision, or already having an answer -- not the row revision, which
    // the visibility fact of a root read moves without changing the question.
    if (!subject) {
      failWith('DECISION_STALE', 'the coordination request of ' + decision.entityId + ' no longer exists; open a new one');
    }
    if (!isCoordinationIntent(subject)) {
      failWith('WRONG_INTENT_PROTOCOL', 'the subject of ' + decision.entityId + ' is not a root-decision intent');
    }
    if (tx.read(decision.binding?.taskRef)?.contractRevision !== decision.binding?.contractRevision) {
      failWith('DECISION_STALE', 'the task contract changed since this coordination request opened');
    }
    if (subject.taskRef !== decision.binding?.taskRef || subject.contractRevision !== decision.binding?.contractRevision) {
      failWith('DECISION_STALE', 'the request now binds ' + subject.taskRef + '@' + subject.contractRevision + ', not the ' +
        decision.binding?.taskRef + '@' + decision.binding?.contractRevision + ' this decision was opened against');
    }
    if (decision.subject.fingerprint !== coordinationQuestionHash(subject)) {
      failWith('DECISION_STALE', 'the coordination question changed after root read it');
    }
    if (subject.status !== 'open') {
      failWith('DECISION_STALE', 'the coordination request of ' + decision.entityId + ' is already ' + subject.status +
        '; a decided request is never revived -- a new request names a new operationId and the previous decision');
    }
  } else if (decision.subject?.id && (!subject || subject.revision !== decision.subject.revision)) {
    failWith('DECISION_STALE', 'the subject of ' + decision.entityId + ' moved since it opened (expected revision ' +
      decision.subject.revision + ', found ' + (subject?.revision ?? 'none') + '); open a new decision against the ' +
      'current row');
  }
  const noticeId = 'message:' + id('message');
  // The rows a completion verdict may touch beside the decision itself: the goal row a consumed completion closes, and
  // the inconsistency the same journal event resolves. Both are named by the decision, never discovered at write time.
  const extras = [];
  if (decision.kind === 'completion') {
    if (command.teamGoalId) extras.push(command.teamGoalId);
    if (Number.isSafeInteger(command.journal?.seq) && typeof command.journal?.sessionId === 'string') {
      extras.push('inconsistency:' + command.journal.sessionId + ':' + command.journal.seq);
    }
  }
  // The one effect a coordination verdict owns: the result its initiator is waiting on (§3.3 rule 6). Named from the
  // decision row, so applying an option cannot invent another outbox key.
  const outboxIds = decision.kind === 'coordination' && decision.subject?.id ? ['intent-result:' + decision.subject.id] : [];
  const restricted = restrictedDecisionTx(tx, { decisionId: decision.entityId, subjectId: decision.subject?.id ?? null,
    noticeId, extras, outboxIds });
  const applied = applyOption(restricted, command, decision, subject, p.decision, now);
  const audit = recordAudit(restricted, command, decision, { authority, option: p.decision, evidenceRef: applied.evidenceRef,
    at: now, applied: applied.applied });
  notifyOperator(restricted, command, decision, { option: p.decision, at: now, noticeId, auditRef: audit.entityId });
  return restricted.put(decision.entityId, { ...decision, state: 'decided',
    verdict: { option: p.decision, reason: typeof p.reason === 'string' ? p.reason : null,
      evidenceRef: applied.evidenceRef, by: command.actor, byKind: authority.kind, at: now,
      operationId: command.operationId, auditRef: audit.entityId } });
}

/**
 * The clock's sweep (§12 U8): an open decision past its TTL becomes expired and changes nothing.
 *
 * "Expired" is never "approved": the domain is untouched, the audit row says when the deadline was, and the only
 * escalation the design allows (a stuck member) belongs to the package that owns member lifecycle, not here.
 */
function expireDecisions(tx, command) {
  if (command.autonomy !== 'on') {
    failWith('DENIED', 'decision.expire is part of the autonomy package and is refused while the switch is off');
  }
  const now = command.now ?? command.payload?.now ?? Date.now();
  const due = tx.list('decision:').filter(row => row.state === 'open' && Number.isFinite(row.expiresAt) &&
    row.expiresAt <= now);
  for (const row of due) {
    // §3.3 rule 6: an unanswered coordination request becomes expired-unresolved on the intent row as well. The
    // revision stays blocked with its evidence -- expiry is a record, never an approval -- and the initiator learns the
    // outcome through the same result port a verdict uses.
    if (row.kind === 'coordination' && row.subject?.id) {
      const intent = tx.read(row.subject.id);
      if (intent) expireCoordinationIntent(tx, intent, { decisionRef: row.entityId, at: now });
    }
    tx.put('audit:' + id('audit'), { kind: 'decision-expiry', decisionId: row.entityId, subject: row.subject,
      option: null, evidenceRef: null, by: 'system', byKind: 'clock', at: now, operationId: command.operationId,
      priorRevision: row.subject?.revision ?? null, applied: 'domain unchanged (' + (row.fallback ?? 'stay') + ')' });
    tx.put(row.entityId, { ...row, state: 'expired', expiredAt: now });
  }
  return { expired: due.length };
}

export const decisionCommands = {
  'decision.decide': decideDecision,
  'decision.expire': expireDecisions,
};
