import { fail, failWith } from '../../contracts/index.mjs';
import { readiness } from '../readiness.mjs';
import { assertCoordinationAllows, intentProtocolOf, ROOT_DECISION_PROTOCOL } from './intents.mjs';

/**
 * Decision threads: open, reply, decide and escalate, as transaction-internal reducers.
 *
 * readiness() is applied on every write for the same reason it is derived in team_read: what a model reads and what
 * the server enforces must not be able to disagree. The row shape is the union of the two former implementations
 * (taskRef is carried; requiredEvidence defaults to []), recorded in docs/decisions/M2a-shared-reducer.md.
 */

function unknownThread(issueId, remedy) {
  return failWith('UNKNOWN_THREAD', 'no thread "' + issueId + '"; ' + remedy);
}

/**
 * A thread reducer only ever writes a thread.
 *
 * The id a caller passes can be any row -- a message id was accepted here before, had its replies appended and came
 * back with thread readiness fields, which is a success for a call that decided nothing. The kind is checked against
 * the id space, not against the shape of the row.
 */
function requireThread(tx, issueId) {
  const current = tx.read(issueId);
  if (!current) return null;
  if (!String(issueId).startsWith('thread:')) {
    failWith('NOT_A_THREAD', issueId + ' is not a thread; a thread reply or decision names thread:<id>, and an intent is ' +
      'answered with team_message {op:"reply", messageId:"<intent>"}');
  }
  // §3.1: the thread family is one id space with a discriminant. A resource thread has events and subscriptions, never
  // required respondents, replies or a decision -- answering it with the decision branches would write readiness fields
  // onto a row that has none, and would read as a ruling nobody gave.
  if (current.kind === 'resource') {
    failWith('WRONG_THREAD_KIND', issueId + ' is a resource thread; reply, decide and escalate belong to a decision thread ' +
      '(a resource takes thread.subscribe/publish/close-resource and no readiness)');
  }
  return current;
}

function openThread(tx, command) {
  const p = command.payload;
  if (!p.owner || !p.escalationOwner || !p.deadline) fail('MISSING_OWNER');
  // The model path may only open a thread for an owner that exists; the direct entry never proved that (§7-6), so the
  // entry selects it instead of the rule being shared.
  if (p.policy?.requireOwnerRow && !tx.read(p.owner)) fail('UNKNOWN_OWNER');
  const thread = { ...(intentProtocolOf(command) === ROOT_DECISION_PROTOCOL ? { kind: 'decision' } : {}),
    owner: p.owner, requiredRespondents: p.requiredRespondents,
    requiredEvidence: p.requiredEvidence ?? [], question: p.question, deadline: p.deadline,
    escalationOwner: p.escalationOwner, taskRef: p.taskRef ?? null,
    proposalRevision: 1, decisionRevision: 0, replies: [], status: 'collecting' };
  return tx.put(p.issueId, { ...thread, ...readiness(thread) });
}

function replyToThread(tx, command) {
  const p = command.payload;
  const current = requireThread(tx, p.issueId);
  if (!current) unknownThread(p.issueId, 'open it with real_work open');
  // One respondent reviewing several deliveries appends one reply per delivery; repeating the same bodyRef
  // replaces that reply instead of inflating the thread with a duplicate.
  const replies = Array.isArray(current.replies) ? current.replies.slice() : [];
  const entry = { actor: command.actor, bodyRef: p.bodyRef, proposalRevision: p.proposalRevision,
    late: current.status !== 'collecting' || current.proposalRevision !== p.proposalRevision };
  const index = replies.findIndex(reply => reply.actor === command.actor && reply.bodyRef === p.bodyRef);
  if (index < 0) replies.push(entry); else replies[index] = entry;
  const next = { ...current, replies };
  return tx.put(p.issueId, { ...next, ...readiness(next) });
}

function decideThread(tx, command) {
  const p = command.payload;
  const current = requireThread(tx, p.issueId);
  if (!current) unknownThread(p.issueId, 'open it with real_work open');
  if (current.owner !== command.actor || current.status !== 'collecting' ||
    current.proposalRevision !== p.proposalRevision) fail('STALE_DECISION');
  // A decision publishes work like produce does, so the same in-transaction gate applies when the thread names a task.
  // A thread that declares a task which no longer exists is not "no gate": the decision would publish against a
  // contract nobody can resolve, so it is refused instead of silently skipping the check (§4.2 rule 5).
  if ((p.gate || intentProtocolOf(command) === ROOT_DECISION_PROTOCOL) && current.taskRef) {
    const task = tx.read(current.taskRef);
    if (!task) fail('UNKNOWN_TASK:' + current.taskRef + ': the thread names a task that does not exist, so the decision it ' +
      'would publish has no contract revision to gate');
    // §3.3: one gate for every publish entry. Legacy asks the M2b window; v1 asks whether an explicit coordination
    // decision on this revision is still open. Same call site, same transaction -- the protocol only picks the rule.
    assertCoordinationAllows(tx, command, { actor: command.actor, taskRef: current.taskRef,
      contractRevision: task.contractRevision });
  }
  const state = readiness(current);
  const next = { ...current, status: state.missing.length ? 'escalated' : 'decided', missing: state.missing,
    conclusionRef: p.conclusionRef, decisionRevision: current.decisionRevision + 1 };
  return tx.put(p.issueId, { ...next, ...readiness(next) });
}

/** Escalate responsibility, not a decision or a reassignment of recorded replies. */
function escalateThread(tx, command) {
  const p = command.payload;
  const current = tx.read(p.issueId);
  if (!current) fail('MISSING_REFERENCE');
  if (current.kind === 'resource') requireThread(tx, p.issueId);
  if (!p.issueId.startsWith('thread:') || !['open', 'collecting', 'deciding'].includes(current.status) ||
    typeof p.reason !== 'string' || !p.reason.trim()) fail('INVALID_ESCALATION');
  return tx.put(p.issueId, { ...current, status: 'escalated', responsible: current.escalationOwner ?? 'operator',
    escalationReason: p.reason, escalatedBy: command.actor, escalatedAt: Date.now() });
}

export const threadCommands = {
  'thread.open': openThread,
  'thread.reply': replyToThread,
  'thread.decide': decideThread,
  'thread.escalate': escalateThread,
};
