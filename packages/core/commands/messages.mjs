import { fail, failWith, hash, id } from '../../contracts/index.mjs';
import { messageAuthority } from '../authority.mjs';
import { ROOT_DECISION_PROTOCOL, coordinationQuestionHash, closeIntent, intentOpen, intentProtocolOf, isCoordinationIntent } from './intents.mjs';
import { openDecision } from './decisions.mjs';
import { humanOrigin } from '../control-capacity.mjs';

/**
 * Message facts: one durable responsibility and its lifecycle. Every write here happens inside the caller's
 * transaction; nothing in this file commits, awaits or reads outside the tx it was given.
 *
 * The two callers that used to own a second implementation (TeamCore.send/accept and the model tool path) now both
 * translate to these reducers, so a message row has one shape and one set of refusals (docs/decisions/M2a-shared-reducer.md).
 */

/** Statuses after which a stored responsibility may not be accepted, resolved or made visible again. */
const CLOSED = ['cancelled', 'expired', 'resolved', 'escalated'];

/**
 * The admission the audited UI path selects for the two message writes a browser may submit (message.cancel and
 * message.rebind). Every other entry — the mailbox helpers — passes no policy and gets HEAD's own helper admission.
 * See docs/decisions/M2a-shared-reducer.md §7, and §7.13 for why this is an internal, trusted-interface decision.
 */
export const auditedUiAdmission = Object.freeze({ admission: 'audited-ui' });
const isAuditedUi = policy => policy?.admission === 'audited-ui';

/**
 * Open an intent window (docs/host-protocol.md §4.2–§4.3).
 *
 * One row, one recipient set, one conclusion: the model names the downstream it is about to implement against and the
 * contract revision it binds, and the server owns the window length (the model no longer sends a deadline). A second
 * intent for the same (taskRef, contractRevision) is refused: a conclusion is terminal and only a new revision may
 * open a new window.
 */
function sendIntent(tx, command) {
  const actor = command.actor;
  const p = command.payload;
  const recipients = Array.isArray(p.to) ? p.to.slice() : [p.to];
  if (!recipients.length || recipients.some(recipient => typeof recipient !== 'string' || !recipient.startsWith('member:'))) {
    fail('INVALID_RECIPIENTS');
  }
  // A self-addressed intent opens a window nobody can object to. That is a rule of the model path (where an intent is
  // the implement gate); the direct entry keeps HEAD's freedom to name itself (M2a §7-6, entry-selected policy).
  if (p.policy?.rejectSelfIntent && recipients.includes(actor)) fail('INTENT_NEEDS_A_DOWNSTREAM');
  if (!p.taskRef || !Number.isSafeInteger(p.contractRevision)) fail('INTENT_NEEDS_A_BINDING');
  if (!Number.isSafeInteger(p.windowMs) || p.windowMs <= 0) fail('INVALID_WINDOW');
  if (!p.summary) fail('MISSING_RESPONSIBILITY');
  const task = tx.read(p.taskRef);
  if (!task) fail('UNKNOWN_TASK:' + p.taskRef);
  if (task.contractRevision !== p.contractRevision) fail('STALE_CONTRACT');
  const sameBinding = tx.list('message:').filter(message => message.kind === 'intent' && message.sender === actor &&
    message.taskRef === p.taskRef && message.contractRevision === p.contractRevision);
  if (sameBinding.some(message => message.decision)) {
    failWith('INTENT_CONCLUSION_FIXED', 'the conclusion on ' + p.taskRef + '@' + p.contractRevision +
      ' is terminal; a new intent needs a new contract revision');
  }
  if (sameBinding.length) failWith('INTENT_ALREADY_OPEN', 'an intent for ' + p.taskRef + '@' + p.contractRevision +
    ' is already waiting for its window');
  const generations = {}; const bindingGenerations = {};
  for (const recipient of recipients) {
    const member = tx.read(recipient);
    if (!member) fail('UNKNOWN_MEMBER:' + recipient);
    generations[recipient] = member.generation ?? 1;
    bindingGenerations[recipient] = 0;
  }
  // F1 R6-1: the initiator identity is bound here, in the transaction that opens the window, and only copied later.
  // "Who was executing when the window opened" is not recoverable at close time: the execution may be released, or a
  // new generation may have replaced it, and re-deriving it then would hand the result to an execution that never
  // opened this intent. The kind comes from committed facts - the sender's own member row - never from the command, so
  // a model cannot report that it is the owner.
  const sender = tx.read(actor);
  const isOwner = sender?.role === 'root' || (!sender && (actor === 'root' || actor === 'operator'));
  const senderAttempt = isOwner ? null : (tx.list('attempt:').find(candidate => candidate.owner === actor &&
    candidate.status === 'running' && candidate.lease === 'active') ?? null);
  const initiator = Object.freeze({ kind: isOwner ? 'owner' : senderAttempt ? 'execution' : 'unbound', memberId: actor,
    attemptId: senderAttempt?.entityId ?? null, generation: senderAttempt?.generation ?? null,
    fence: senderAttempt?.fence ?? null,
    ...(senderAttempt && tx.read('execution-current:'+senderAttempt.entityId)?.E ? {E:tx.read('execution-current:'+senderAttempt.entityId).E}: {}) });
  const now = command.now ?? Date.now();
  const row = { sender: actor, kind: 'intent', initiator, recipients, generations, bindingGenerations, votes: {},
    summary: p.summary, bodyRef: p.bodyRef ?? p.messageId, expectedOutcome: p.expectedOutcome ?? null,
    taskRef: p.taskRef, contractRevision: p.contractRevision, openedAt: now, closesAt: now + p.windowMs,
    decision: null, closedAt: null, seenAtClose: null, visibilityEvidenceAtClose: null, seenSummary: null,
    visibility: {}, visibilityAfterClose: [], lateEvidence: [], invalidEvidence: [],
    status: 'open', stored: true, visible: false, accepted: false };
  const result = tx.put(p.messageId, row);
  // One wake per recipient: the intent is delivered like any other message, but its conclusion is one.
  for (const recipient of recipients) {
    tx.outbox('wake:' + p.messageId + ':' + recipient,
      { kind: 'wake', messageId: p.messageId, recipient, generation: generations[recipient] });
  }
  return result;
}

/**
 * §3.3 rules 2-4: a v1 intent is a request for a ROOT DECISION, opened with its decision row in the same transaction.
 *
 * What it cannot be is an M2b window: there is no recipient set to out-vote, no windowMs (silence proves nothing), no
 * ok/object vote table and no deadline. The requester names the reason, the evidence and the exact contract revision it
 * needs moved, root's inbox gets the request, and the decision row is what the publish gate reads afterwards.
 *
 * The initiator binding is frozen here for the same reason sendIntent freezes it (F1 R6-1): the result must reach the
 * execution that asked, and asking again later cannot recover who that was.
 */
function sendCoordinationRequest(tx, command) {
  const actor = command.actor;
  const p = command.payload;
  const rootRef = 'member:root';
  if (Array.isArray(p.to) || p.to !== rootRef) {
    failWith('COORDINATE_VIA_ROOT', 'a v1 intent asks root for a decision and addresses ' + rootRef + ' alone; ' +
      (Array.isArray(p.to) ? 'a downstream set' : JSON.stringify(p.to ?? null)) + ' is M2b window semantics (§3.3 rule 2)');
  }
  if (p.windowMs !== undefined && p.windowMs !== null) {
    failWith('WRONG_INTENT_PROTOCOL', 'a v1 intent has no window: silence is not consent, so there is nothing to wait for (§3.3)');
  }
  if (!p.taskRef || !Number.isSafeInteger(p.contractRevision)) fail('INTENT_NEEDS_A_BINDING');
  if (!p.summary) fail('MISSING_RESPONSIBILITY');
  if (!p.expectedOutcome) fail('MISSING_RESPONSIBILITY');
  if (typeof p.reason !== 'string' || !p.reason.trim()) {
    failWith('MISSING_RESPONSIBILITY', 'a coordination request states why root has to decide it (reason)');
  }
  if (!Array.isArray(p.evidenceRefs) || p.evidenceRefs.length === 0) {
    failWith('MISSING_EVIDENCE', 'a coordination request carries at least one evidenceRef; a ruling asked for on nothing is an opinion');
  }
  if (tx.read(actor)?.desired !== 'active') fail('UNKNOWN_MEMBER');
  // §3.3 rule 6: a request that re-asks a question an earlier decision already answered names that row. The link is
  // traceability, not a revival: the old decision stays terminal, and a link that names another task's ruling is refused.
  const previousDecisionId = p.previousDecisionId ?? null;
  const expired = tx.list('decision:').filter(row => row.kind === 'coordination' && row.state === 'expired' &&
    row.binding?.taskRef === p.taskRef && row.binding?.contractRevision === p.contractRevision && row.binding?.requestedBy === actor);
  if (expired.length && previousDecisionId === null) {
    failWith('DECISION_STALE', 'renewing an expired coordination question requires previousDecisionId');
  }
  if (previousDecisionId !== null) {
    const previous = tx.read(previousDecisionId);
    if (!previous || !['expired', 'decided'].includes(previous.state) || previous.kind !== 'coordination' || previous.binding?.taskRef !== p.taskRef ||
      previous.binding?.contractRevision !== p.contractRevision) {
      failWith('DECISION_STALE', 'previousDecisionId must name a coordination decision about ' + p.taskRef + '@' +
        p.contractRevision + '; ' + String(previousDecisionId) + ' is not one');
    }
  }
  const task = tx.read(p.taskRef);
  if (!task) fail('UNKNOWN_TASK:' + p.taskRef);
  if (task.contractRevision !== p.contractRevision) fail('STALE_CONTRACT');
  for (const ref of p.evidenceRefs) if (!tx.read(ref)) fail('MISSING_REFERENCE:' + ref);
  const rootMember = tx.read(rootRef);
  if (!rootMember || rootMember.role !== 'root' || rootMember.desired !== 'active') {
    failWith('UNKNOWN_OWNER', 'a v1 coordination request needs the team owner row ' + rootRef + '; this team has none');
  }
  const now = command.now ?? Date.now();
  const decisionId = 'decision:' + id('decision');
  const sender = tx.read(actor);
  const isOwner = sender?.role === 'root';
  const senderAttempt = isOwner ? null : (tx.list('attempt:').find(candidate => candidate.owner === actor &&
    candidate.status === 'running' && candidate.lease === 'active') ?? null);
  const E = senderAttempt ? (tx.read('execution-current:' + senderAttempt.entityId)?.E ?? null) : null;
  const initiator = Object.freeze({ kind: isOwner ? 'owner' : senderAttempt ? 'execution' : 'unbound', memberId: actor,
    attemptId: senderAttempt?.entityId ?? null, generation: senderAttempt?.generation ?? null,
    fence: senderAttempt?.fence ?? null, ...(E ? { E } : {}) });
  const generation = rootMember.generation ?? 1;
  // The request's ordinal among this team's coordination requests: the newest open question is the state the gate
  // reports, so "which one is current" has to be a durable fact rather than an accident of id ordering.
  const requestSeq = tx.list('decision:').filter(row => row.kind === 'coordination')
    .reduce((max, row) => Math.max(max, row.binding?.requestSeq ?? 0), 0) + 1;
  const row = tx.put(p.messageId, { sender: actor, kind: 'intent', protocol: ROOT_DECISION_PROTOCOL,
    recipients: [rootRef], to: rootRef, generations: { [rootRef]: generation }, bindingGenerations: { [rootRef]: 0 },
    votes: {}, summary: p.summary, bodyRef: p.bodyRef ?? p.messageId, expectedOutcome: p.expectedOutcome,
    reason: p.reason, evidenceRefs: p.evidenceRefs.slice(), taskRef: p.taskRef, contractRevision: p.contractRevision,
    openedFor: rootRef, decisionRef: decisionId, initiator, openedAt: now, closesAt: null, decision: null,
    closedAt: null, seenAtClose: null, visibilityEvidenceAtClose: null, seenSummary: null, visibility: {},
    visibilityAfterClose: [], lateEvidence: [], invalidEvidence: [], status: 'open', stored: true, visible: false,
    accepted: false });
  // One wake to the owner's inbox: the request is a responsibility root reads, not a message a worker accepts.
  tx.outbox('wake:' + p.messageId + ':' + rootRef, { kind: 'wake', targetKind: 'owner', messageId: p.messageId, recipient: rootRef, generation });
  // §3.3 rule 5: a new contract revision supersedes the still-open requests of the same task. An approval is never
  // inherited by a revision nobody asked about.
  for (const other of tx.list('decision:')) {
    if (other.kind !== 'coordination' || other.state !== 'open') continue;
    if (other.binding?.taskRef !== p.taskRef || other.binding?.contractRevision === p.contractRevision) continue;
    tx.put(other.entityId, { ...other, state: 'superseded', supersededAt: now, supersededBy: decisionId });
  }
  openDecision(tx, command, { kind: 'coordination', decisionId, openedFor: rootRef, now, ttlMs: command.decisionTtlMs,
    fallback: 'stay', subject: { type: 'intent', id: p.messageId, revision: row.revision, fingerprint: coordinationQuestionHash(row) },
    binding: { taskRef: p.taskRef, contractRevision: p.contractRevision, intentRef: p.messageId, requestedBy: actor,
      requestSeq, interestedMemberIds: [actor, task.owner].filter(Boolean), ...(previousDecisionId ? { previousDecisionId } : {}) },
    evidence: [
      { at: now, kind: 'row', ref: p.messageId, text: 'coordination requested by ' + actor + ': ' + String(p.reason).slice(0, 200) },
      ...p.evidenceRefs.map(ref => ({ at: now, kind: 'row', ref, text: 'evidence named by ' + actor })),
    ] });
  return row;
}

function sendMessage(tx, command) {
  const actor = command.actor;
  const p = command.payload;
  const v1 = intentProtocolOf(command) === ROOT_DECISION_PROTOCOL;
  const forwarded=v1 && tx.read(actor)?.role==='root' ? p.extra?.humanOriginRef : null;
  if(v1 && ['humanOriginRef','humanOrigin','trafficClass','originRef','source','role','priority'].some(k=>(p[k]!==undefined||p.extra?.[k]!==undefined)&&!(k==='humanOriginRef'&&forwarded)))fail('DENIED');
  const origin=v1 && (command.humanOriginRef||forwarded) ? humanOrigin(tx,command.humanOriginRef||forwarded,p.to):null;
  if(forwarded && (!origin || origin.forwardedMessageRef || p.kind!=='info'))fail('DENIED');
  if(command.humanOriginRef && !origin)fail('DENIED');
  if (p.kind === 'intent') return v1 ? sendCoordinationRequest(tx, command) : sendIntent(tx, command);
  const recipient = tx.read(p.to);
  if (!recipient) fail('UNKNOWN_MEMBER:' + p.to);
  // A direct host call names its sender explicitly; the model path already proved the actor holds a role.
  if (p.requireSender && !tx.read(actor)) fail('UNKNOWN_MEMBER');
  // §3.3 rule 2: in v1 an executing member does not task another member directly -- that is a coordination request,
  // and coordination goes through root. A plain directed notice keeps working exactly as before.
  if (v1 && !origin && p.kind === 'action' && actor !== 'member:root' && p.to !== 'member:root') {
    failWith('COORDINATE_VIA_ROOT', 'v1 members do not send execution requests to each other (' + actor + ' -> ' + p.to +
      '); ask root for the change (team_message send kind=intent to member:root) or send a plain info notice');
  }
  if (p.kind !== 'info' && (!p.expectedOutcome || !p.deadline)) fail('MISSING_RESPONSIBILITY');
  // An intent addressed to yourself would open the implement gate without telling anyone. That is a rule of the model
  // path, where an intent IS the implement gate; the direct entry has no gate to open and keeps sending it (§7-6).
  if (p.policy?.rejectSelfIntent && p.kind === 'intent' && p.to === actor) fail('INTENT_NEEDS_A_DOWNSTREAM');
  const row = { sender: actor, recipient: p.to, kind: p.kind, summary: p.summary,
    bodyRef: p.bodyRef ?? p.messageId, generation: recipient.generation,
    taskRef: p.taskRef ?? null, threadRef: p.threadRef ?? null,
    expectedOutcome: p.expectedOutcome ?? null, deadline: p.deadline ?? null,
    status: 'stored', stored: true, visible: false, accepted: false, ...(p.extra ?? {}) };
  if(origin){row.humanOriginRef=origin.entityId;tx.put(origin.entityId,{...origin,...(forwarded?{forwardedMessageRef:p.messageId}:{messageRef:p.messageId})});}
  const result = tx.put(p.messageId, row);
  tx.outbox(p.messageId, { kind: 'message', messageId: p.messageId, ...(origin ? {trafficClass:'human',originRef:origin.entityId,
    ...(p.to==='member:root'?{targetKind:'owner',recipient:p.to,generation:recipient.generation}:{})} : {}) });
  return result;
}

function acceptMessage(tx, command) {
  const p = command.payload;
  // P1 of the autonomy design (§3.2.3): the lease is one authority, not the only one. A command that selected no
  // authority is the execution path this reducer has always had -- leaseOf on the payload's attempt and fence -- so
  // every existing caller keeps its refusals and its writes to the byte. The owner path is selected by the trusted
  // entry alone (core/authority.mjs) and grants no attempt: the owner has none, and inventing one would make a
  // fabricated fence and generation part of a real lease.
  const authority = messageAuthority(tx, command);
  const current = tx.read(p.messageId);
  if (current?.kind === 'intent') {
    failWith('INTENT_NEEDS_REPLY', 'an intent opens an objection window; answer it with team_message op=reply ' +
      '(verdict ok|object), not with accept');
  }
  if (authority.kind === 'owner') {
    if (!current || current.recipient !== command.actor || current.generation !== authority.generation ||
      CLOSED.includes(current.status)) fail('LATE_MESSAGE:' + p.messageId);
    // §12 U6: an owner that addressed a responsibility to itself does not take it up. The predicate is the row --
    // sender and recipient -- never a claim about who the actor is, and it is checked after the address so a
    // responsibility meant for someone else still answers LATE_MESSAGE.
    if (current.sender === command.actor) {
      failWith('SELF_ADDRESSED', 'the owner cannot accept a responsibility it addressed to itself (' + p.messageId +
        '); a self-addressed responsibility records no work anybody took up');
    }
    // §4.2 rule 9 is not relaxed for the owner: only what was really in a request may be accepted.
    if (!current.visible) {
      failWith('NOT_VISIBLE', 'the responsibility has not been in a request context yet; read your mailbox first, ' +
        'then accept ' + p.messageId);
    }
    return tx.put(p.messageId, { ...current, accepted: true, status: 'accepted', attemptId: null,
      acceptedBy: { kind: 'owner', attemptId: null, generation: authority.generation }, answeredAt: Date.now() });
  }
  if (!current || current.recipient !== command.actor || current.generation !== authority.generation ||
    CLOSED.includes(current.status) || !p.checkpointRef) fail('LATE_MESSAGE:' + p.messageId);
  // §4.2 rule 9 / host-protocol 7.1(3c): a responsibility may only be accepted after it has been in a real request.
  if (!current.visible) {
    failWith('NOT_VISIBLE', 'the responsibility has not been in a request context yet; read your mailbox first, ' +
      'then accept ' + p.messageId);
  }
  tx.put('checkpoint:' + p.checkpointRef, { attemptId: p.attemptId, messageId: p.messageId });
  // answeredAt is the ack instant the collaboration metrics read; it is written for every acceptance.
  return tx.put(p.messageId, { ...current, accepted: true, status: 'accepted', attemptId: p.attemptId,
    checkpointRef: p.checkpointRef, answeredAt: Date.now() });
}

function resolveMessage(tx, command) {
  const p = command.payload;
  const authority = messageAuthority(tx, command);
  const current = tx.read(p.messageId);
  if (!current) fail('CAS_CONFLICT:' + p.messageId);
  // The responsibilities a resolve may close are exactly the ones an accept may open (HEAD checked this in the tool
  // path before the lease of the row): still addressed to this actor, still of this attempt's generation, not closed.
  // Without it a cancelled row stays accepted=true and its old attempt could turn "cancelled" into "resolved".
  if (current.recipient !== command.actor || current.generation !== authority.generation ||
    CLOSED.includes(current.status)) fail('LATE_MESSAGE:' + p.messageId);
  if (authority.kind === 'owner') {
    // Only a responsibility this owner really accepted, and only through the owner path, may be closed by it.
    if (!current.accepted || current.acceptedBy?.kind !== 'owner') fail('NOT_ACCEPTED');
    return tx.put(p.messageId, { ...current, status: 'resolved', resultRef: p.resultRef,
      resolvedBy: { kind: 'owner', generation: authority.generation } });
  }
  if (!current.accepted || current.attemptId !== p.attemptId) fail('NOT_ACCEPTED');
  return tx.put(p.messageId, { ...current, status: 'resolved', resultRef: p.resultRef });
}

/**
 * Visibility evidence (invariant 8, §4.4). The only entry that may write a visible fact.
 *
 * Evidence must be a real request payload: requestId, manifestHash, sessionSeq and the instant the request started.
 * The manifest must exist for exactly this member and must have carried this message at the generation the row is
 * bound to right now; anything else is refused (invariant 8 rule 4, §4.4 class 4) and counted neither as seen nor as
 * looked-at-later. Once an intent has closed, evidence cannot move the conclusion: it lands in lateEvidence (the
 * request happened before closedAt) or in visibilityAfterClose (after it), and seenAtClose stays frozen.
 */
function recordVisibility(tx, command) {
  const p = command.payload;
  const current = tx.read(p.messageId);
  if (!current) fail('MISSING_REFERENCE');
  // Only the request boundary writes visibility. The tool surface has no branch that reaches this reducer, and an
  // internal caller that is not the adapter is refused here rather than trusted.
  if (command.actor !== 'adapter') failWith('DENIED', 'visibility is recorded by the request boundary, not by ' + command.actor);
  const evidence = p.evidence ?? {};
  const recipient = p.recipient ?? current.recipient ?? null;
  if (!evidence.requestId || !evidence.manifestHash || !Number.isInteger(evidence.sessionSeq)) {
    fail('MISSING_REQUEST_EVIDENCE');
  }
  // A free-standing message names one recipient on its row; an intent names a set, so the evidence has to say whose
  // request carried it.
  if (!recipient) failWith('UNBOUND_RECIPIENT', 'visibility names the recipient whose request carried ' + p.messageId);
  const manifest = tx.read('manifest:' + evidence.manifestHash);
  if (!manifest) {
    failWith('MISSING_SOURCE', 'no injected manifest ' + evidence.manifestHash + '; a visible fact needs the source ' +
      'the request actually carried');
  }
  if (hash(manifest.text) !== evidence.manifestHash || manifest.memberId !== recipient ||
    !(manifest.messageIds ?? []).includes(p.messageId)) {
    failWith('FORGED_EVIDENCE', 'manifest ' + evidence.manifestHash + ' does not bind ' + p.messageId +
      ' to ' + recipient);
  }
  const binding = (manifest.messageBindings ?? []).find(row => row.messageId === p.messageId && row.recipient === recipient);
  const generation = current.kind === 'intent' ? current.generations?.[recipient] : current.generation;
  const bindingGeneration = current.kind === 'intent'
    ? (current.bindingGenerations?.[recipient] ?? 0) : (current.bindingGeneration ?? 0);
  if (!binding || binding.generation !== generation || binding.bindingGeneration !== bindingGeneration) {
    failWith('STALE_MESSAGE_BINDING', 'evidence for ' + p.messageId + ' was taken under an old generation or ' +
      'binding; it is refused and counted neither as seen nor as looked at later');
  }
  // Two old rows agreeing with each other is not proof that the binding is still live: the member may have been
  // replaced since, in which case the request that carried the message belonged to a generation that no longer holds
  // this responsibility (§4.4 class 4: refused, never counted as seen and never as looked at later).
  const member = tx.read(recipient);
  if (!member || member.generation !== generation) {
    failWith('STALE_MESSAGE_BINDING', 'evidence for ' + p.messageId + ' names generation ' + generation + ' of ' +
      recipient + ', which is now at generation ' + (member?.generation ?? 'none') + '; a replaced member cannot ' +
      'report what the live one has seen');
  }
  if (current.kind !== 'intent') {
    const terminal = CLOSED.includes(current.status);
    // Legacy updatedAt may reflect a repeated cancellation or unrelated write, not the FIRST cancellation.
    // Unknown cancellation time is not historical-delivery authority; never infer or backfill it from updatedAt.
    const cancelledAt = current.cancelledAt;
    if (terminal) {
      // A terminal responsibility cannot reopen. A request already in flight before BOTH its deadline and its
      // cancellation may still prove historical delivery; absent/late request time is never such proof.
      if (!['expired', 'cancelled'].includes(current.status)) fail('LATE_MESSAGE');
      if (current.status === 'cancelled' && !Number.isFinite(cancelledAt)) fail('LATE_MESSAGE');
      const deadline = Date.parse(current.deadline);
      const cutoff = current.status === 'cancelled'
        ? Math.min(cancelledAt, Number.isFinite(deadline) ? deadline : Infinity) : deadline;
      if (!Number.isFinite(cutoff) || !Number.isFinite(evidence.requestedAt) || evidence.requestedAt >= cutoff) fail('LATE_MESSAGE');
    }
    const observation = { requestId: evidence.requestId, manifestHash: evidence.manifestHash, sessionSeq: evidence.sessionSeq,
      requestedAt: evidence.requestedAt ?? null, ...(terminal ? { historical: true } : {}) };
    const visible = tx.put(p.messageId, terminal
      ? { ...current, observation }
      : { ...current, visible: true, status: current.accepted ? 'accepted' : 'visible', observation });
    // A notice may already have stopped retrying at its deadline while this pre-deadline request was in flight.
    // The carrying evidence above is authoritative. Repair its durable receipt in THIS visibility transaction;
    // a confirmed notification effect will not call the wake port again just to discover the late evidence.
    const key = 'wake-receipt:' + p.messageId + ':' + recipient, receipt = tx.read(key);
    if (receipt?.delivered === false && receipt.generation === generation) {
      tx.put(key, { ...receipt, delivered: true, deliveryCorrected: true, deliveryEvidence: observation });
    }
    return visible;
  }
  const at = command.now ?? Date.now();
  const requestedAt = Number.isFinite(evidence.requestedAt) ? evidence.requestedAt : null;
  const observed = { recipient, requestId: evidence.requestId, manifestHash: evidence.manifestHash,
    sessionSeq: evidence.sessionSeq, requestedAt, at };
  // No request time, no bin. It is neither "seen at the close" nor "a late request": it is a fact whose time nobody
  // proved, so it is recorded as such and counted in neither visibility statistic (§4.4 classes 1-3 all need a time).
  if (requestedAt === null) {
    return tx.put(p.messageId, { ...current, timeUnknown: [...(current.timeUnknown ?? []), observed] });
  }
  if (isCoordinationIntent(current) && current.status === 'open') {
    return tx.put(p.messageId, { ...current, visible: true, visibility: { ...(current.visibility ?? {}), [recipient]: observed } });
  }
  if (intentOpen(current)) {
    // The window is judged against closesAt, not against whether the clock has got round to committing the close: a
    // request that started at or after closesAt is class 3 even while the row still says open (F19).
    if (requestedAt >= current.closesAt) {
      return tx.put(p.messageId, { ...current, visibilityAfterClose: [...(current.visibilityAfterClose ?? []), observed] });
    }
    return tx.put(p.messageId, { ...current, visible: true, visibility: { ...(current.visibility ?? {}),
      [recipient]: observed } });
  }
  // Closed already: audit only, and the class is decided by when the request happened, never by "is it visible now".
  if (requestedAt >= current.closedAt) {
    return tx.put(p.messageId, { ...current, visibilityAfterClose: [...(current.visibilityAfterClose ?? []), observed] });
  }
  return tx.put(p.messageId, { ...current, lateEvidence: [...(current.lateEvidence ?? []), observed] });
}

/**
 * Answer an intent (docs/host-protocol.md §4.3): one vote per legal recipient, decided inside the transaction.
 *
 * The model never sends a revision and never names a vote table: the reducer reads the current row, checks the caller
 * is a recipient at the generation the intent was bound to, and applies the set rule — any object closes the window as
 * objected at once, all ok closes it as passed, and silence decides at the deadline. A reply that arrives after the
 * deadline (even if the clock has not run yet) or after a conclusion is audit only: the conclusion never moves.
 */
function replyToIntent(tx, command) {
  const p = command.payload;
  const message = tx.read(p.messageId);
  if (!message) fail('MISSING_REFERENCE');
  if (message.kind !== 'intent') {
    failWith('NOT_AN_INTENT', 'reply answers an intent; ' + p.messageId + ' is a ' + message.kind);
  }
  // §3.3 rule 3: a v1 intent has no ok/object votes at all. Answering one with the M2b reply surface would be a second
  // adjudication protocol beside the decision row root actually decides.
  if (isCoordinationIntent(message)) {
    failWith('WRONG_INTENT_PROTOCOL', p.messageId + ' is a root-decision request; it has no vote window. Root answers it ' +
      'with team_decide (approve|reject|request-revision), and the result reaches you as an intent-result');
  }
  const actor = command.actor;
  if (!(message.recipients ?? []).includes(actor)) {
    failWith('NOT_A_RECIPIENT', 'only a recipient of ' + p.messageId + ' may answer it; ' + actor + ' is not one');
  }
  if (p.verdict !== 'ok' && p.verdict !== 'object') fail('INVALID_VERDICT');
  const now = command.now ?? Date.now();
  const vote = { recipient: actor, verdict: p.verdict, reason: p.reason ?? null, at: now,
    generation: message.generations?.[actor] ?? null, bindingGeneration: message.bindingGenerations?.[actor] ?? 0 };
  const audited = () => ({ ...message, lateReplies: [...(message.lateReplies ?? []), vote] });
  if (message.decision) {
    // "结论已定": the reply is recorded for the audit and changes nothing (F17).
    return tx.put(p.messageId, audited());
  }
  const member = tx.read(actor);
  if (!member || (message.generations?.[actor] ?? null) !== member.generation ||
    (message.bindingGenerations?.[actor] ?? 0) !== vote.bindingGeneration) {
    failWith('STALE_MESSAGE_BINDING', 'this intent is bound to another generation of ' + actor + '; reply from the ' +
      'binding it was opened against');
  }
  // The deadline is decided BEFORE the vote table is touched (host-protocol §4.3, F17): a reply that arrives at or
  // after closesAt is audit only, whatever the clock has or has not committed yet. Writing it into votes first and
  // deciding afterwards left a passed window carrying a vote that arrived too late to count.
  if (now >= message.closesAt) {
    return closeIntent(tx, audited(), 'passed', message.closesAt);
  }
  // A reply inside the window is not late: it is the vote that decides the window.
  const votes = { ...(message.votes ?? {}), [actor]: vote };
  const answered = { ...message, votes };
  if (p.verdict === 'object') return escalateObjection(tx, command, closeIntent(tx, answered, 'objected', now), vote, now);
  if (message.recipients.every(recipient => votes[recipient]?.verdict === 'ok')) {
    return closeIntent(tx, answered, 'passed', now);
  }
  return tx.put(p.messageId, answered);
}

/**
 * §2.2.3 / §12 U1: one objection opens one decision row, in the same transaction that closes the window.
 *
 * The conclusion itself does not move -- "objected" stays terminal, so "nobody objected" and "somebody objected and
 * was overruled" remain two different facts. What the row adds is the thing that was missing: somebody now knows the
 * revision is blocked and has a closed set of options to answer it with (waive / uphold / withdraw). The proposer is
 * recorded as openedFor, which is what makes "root cannot waive an objection to its own proposal" checkable instead of
 * a promise.
 *
 * With the autonomy switch off nothing is written here at all: the row, the escalation field and the decision id do
 * not exist in that product.
 */
function escalateObjection(tx, command, closed, vote, now) {
  if (command.autonomy !== 'on') return closed;
  const decisionRef = 'decision:' + id('decision');
  const escalated = tx.put(closed.entityId, { ...closed, escalation: { by: command.actor, decisionRef, at: now } });
  openDecision(tx, command, { kind: 'objection', decisionId: decisionRef,
    subject: { type: 'intent', id: escalated.entityId, revision: escalated.revision },
    evidence: [
      { at: now, kind: 'row', ref: escalated.entityId, text: 'the window closed as objected at ' + now },
      { at: vote.at, kind: 'row', ref: command.actor, text: 'vote object by ' + command.actor + ': ' +
        (vote.reason ?? 'no reason given') },
    ],
    openedFor: closed.sender, now, ttlMs: command.decisionTtlMs });
  return escalated;
}

function cancelMessage(tx, command) {
  const p = command.payload;
  // Both admissions read the row this transaction is about to write, never a caller's earlier read: a sender that
  // changed after a pre-read cannot cancel through the helper (§7.14).
  const current = tx.read(p.messageId);
  // Cancelling is for an addressed responsibility. An intent is one row with a recipient set, a vote table and a
  // conclusion; the generic cancel would leave it cancelled without a decision, outside the only close (§4.3).
  if (current?.kind === 'intent') {
    // §3.3: the two protocols close an intent differently, and a v1 member must not be told that silence is consent.
    failWith('INTENT_NOT_CANCELLABLE', isCoordinationIntent(current)
      ? 'a coordination request is not cancelled: root decides it (approve|reject|request-revision) or its TTL expires it ' +
        'unanswered, which keeps the revision blocked'
      : 'an intent is not cancelled: it closes by its window (silence is consent) or by an objection; withdraw the work ' +
        'it gated instead, or announce a new contract revision');
  }
  if (isAuditedUi(p.policy)) {
    if (!current) fail('MISSING_REFERENCE');
    // The audited UI: a real reason and no closed row (HEAD's submitMailbox branch).
    if (typeof p.reason !== 'string' || !p.reason.trim() || ['resolved', 'cancelled', 'unknown'].includes(current.status)) {
      fail('INVALID_CANCELLATION');
    }
  } else if (!current || ![current.sender, 'operator'].includes(command.actor) || !p.reason) {
    // HEAD's helper: the sender or the operator, with a non-empty reason, may override whatever the status is.
    fail('DENIED');
  }
  // Repeating a legacy cancellation cannot manufacture its missing first-cancel time from updatedAt or now.
  const firstCancellation = current.status === 'cancelled' ? {} : { cancelledAt: command.now ?? Date.now() };
  return tx.put(p.messageId, { ...current, ...firstCancellation, status: 'cancelled', cancellationReason: p.reason });
}

function rebindMessage(tx, command) {
  const p = command.payload;
  const current = tx.read(p.messageId);
  const member = tx.read(p.recipient);
  // Rebinding an intent would rewrite one recipient's generation while leaving recipients/bindingGenerations and the
  // frozen facts behind: a second close path with no rules (host-protocol §4.2 rule 3, §4.3). Refused here, both paths.
  if (current?.kind === 'intent') {
    failWith('INTENT_NOT_REBINDABLE', 'an intent binds its recipient set when it opens; a different downstream is a new ' +
      'intent, which needs a new contract revision');
  }
  if (isAuditedUi(p.policy)) {
    // The audited UI admission, exactly as submitMailbox had it: a member: recipient, evidence that is a row, and no
    // unknown row (rebinding one back into 'stored' would bypass the operator-only adjudication path, §7-2).
    if (!current) fail('MISSING_REFERENCE');
    if (!p.recipient?.startsWith('member:') || !member || !p.evidenceRef || !tx.read(p.evidenceRef) ||
      ['resolved', 'cancelled', 'unknown'].includes(current.status)) fail('INVALID_REBIND');
  } else if (!current || !member || !p.evidenceRef || ['resolved', 'cancelled'].includes(current.status)) {
    // HEAD's helper admission: the recipient row must exist, but any id shape is a recipient and evidence may be a
    // label; a missing message is INVALID_REBIND, not MISSING_REFERENCE (§7.15).
    fail('INVALID_REBIND');
  }
  return tx.put(p.messageId, { ...current, recipient: p.recipient, generation: member.generation,
    bindingGeneration: (current.bindingGeneration ?? 0) + 1, status: 'stored', visible: false, accepted: false,
    history: [...(current.history ?? []), { recipient: current.recipient, generation: current.generation,
      observation: current.observation ?? null, attemptId: current.attemptId ?? null, evidenceRef: p.evidenceRef }] });
}

export function adjudicateMessage(tx, command) {
  const p = command.payload;
  const current = tx.read(p.messageId);
  if (!current) fail('MISSING_REFERENCE');
  if (current.status !== 'unknown' || !['effective', 'not-effective', 'abandoned'].includes(p.decision) || !p.evidenceRef) {
    fail('INVALID_ADJUDICATION');
  }
  if (!tx.read(p.evidenceRef)) fail('MISSING_EVIDENCE');
  return tx.put(p.messageId, { ...current, adjudication: { decision: p.decision, evidenceRef: p.evidenceRef,
    actor: command.actor, operationId: p.operationId } });
}

export const messageCommands = {
  'message.send': sendMessage,
  'message.accept': acceptMessage,
  'message.resolve': resolveMessage,
  'message.visible': recordVisibility,
  'message.reply': replyToIntent,
  'message.cancel': cancelMessage,
  'message.rebind': rebindMessage,
  'message.adjudicate': adjudicateMessage,
};
