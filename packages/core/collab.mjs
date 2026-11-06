import { digest } from '../contracts/index.mjs';
import { ROOT_DECISION_PROTOCOL, coordinationBlock, coordinationDecisionState, coordinationDecisions } from './commands/intents.mjs';

/**
 * The three proactive-collaboration mechanisms of 11 §2, as pure functions over committed state.
 *
 * Everything here is inert unless core.configuration.collab === 'on'. That is not a convention but the mechanism the
 * A/B experiment rests on: the off arm must be the system that already existed, so nothing in this file may run,
 * register a tool, alter a snapshot, or refuse a call while the switch is off. Callers ask collabOn() first and the
 * disabled path returns the same values it returned before this file existed.
 */

/**
 * The effective switch and its tunables, read off the core the profile built.
 *
 * intentWindowMs is the objection window of an intent (§4.2 rule 2, §7.1 3(a)): five minutes by default, and bounded
 * here rather than trusted from a caller — a window shorter than a second or longer than an hour is not a window.
 */
export function collabSettings(core) {
  const configuration = core?.configuration ?? {};
  const window = configuration.intentWindowMs;
  return { collab: configuration.collab === 'on' ? 'on' : 'off',
    decisionLimit: Number.isSafeInteger(configuration.decisionLimit) ? configuration.decisionLimit : 5,
    assumptionDeadline: configuration.assumptionDeadline ?? 'PT10M',
    intentWindowMs: Number.isSafeInteger(window) && window >= 1000 && window <= 60 * 60 * 1000 ? window : 5 * 60 * 1000 };
}
export const collabOn = core => collabSettings(core).collab === 'on';

/**
 * §3.3/§12: which intent protocol this core runs. Off is HEAD's window; v1 is the explicit root decision.
 *
 * The selection is configuration only -- superagentBorrow 'v1' AND the deployment's recorded 'root-decision-v1' -- and
 * it is handed to the reducers as trusted command metadata, never read from a request. A build that cannot boot v1
 * (S2-S5 still contracts, §2) never reaches this function through the composition root; the reducers below are what a
 * v1 build would use once it can.
 */
export function intentProtocol(core) {
  const configuration = core?.configuration ?? {};
  return configuration.superagentBorrow === 'v1' && configuration.intentSemantics === ROOT_DECISION_PROTOCOL
    ? ROOT_DECISION_PROTOCOL : 'silence-pass-m2b';
}
export const rootDecisionOn = core => intentProtocol(core) === ROOT_DECISION_PROTOCOL;

/**
 * Which operations count as entering implement.
 *
 * The task state machine already names the transition: a task is ready, an attempt lease makes it executing, and the
 * attempt either produces a delivery (team_task produce), submits verification evidence (team_verify) or closes a
 * decision the team is waiting on (team_thread decide). Those three are the calls that turn this member's work into
 * something others depend on, so they are exactly the calls that must not happen before the downstream has heard the
 * interface. Everything else (reading, the intent send itself, accepting a message, a progress checkpoint, an ack)
 * stays open, because a member that could not read or speak could never satisfy the guard in the first place.
 */
export const implementOperations = Object.freeze({
  team_task: ['produce'], team_verify: ['*'], team_thread: ['decide'],
});
export function isImplementCall(name, args) {
  const ops = implementOperations[name];
  if (!ops) return false;
  return ops.includes('*') || ops.includes(args?.op);
}

/**
 * The members this member actually depends on.
 *
 * Three committed relations, no heuristics and no prompt text: a raised assumption ties its raiser to the owner it
 * named; a pending cross-task wait ties the two task owners; a decision whose affects ref points at a task or artifact
 * this member owns ties its author here. The result is a set of member ids, which is what the snapshot filter needs.
 */
export function dependencyPeers(core, memberId, store = core.store) {
  const peers = new Set();
  const add = value => { if (typeof value === 'string' && value.startsWith('member:') && value !== memberId) peers.add(value); };
  const ownerOf = ref => {
    const row = ref ? store.read(ref) : null;
    if (row && typeof row.owner === 'string' && row.owner.startsWith('member:')) return row.owner;
    // An artifact names its producer in the id suffix (artifact:<cycle>:<actor>).
    const parts = String(ref ?? '').split(':');
    return String(ref ?? '').startsWith('artifact:') && parts.length >= 3 ? 'member:' + parts[2] : null;
  };
  for (const assumption of store.list('assumption:')) {
    if (assumption.raiser === memberId) add(assumption.owner);
    if (assumption.owner === memberId) add(assumption.raiser);
  }
  for (const wait of store.list('wait:')) {
    const owner = ownerOf(wait.taskId), target = ownerOf(wait.dependency?.taskId);
    if (owner === memberId) add(target);
    if (target === memberId) add(owner);
  }
  for (const decision of store.list('decision-log:')) {
    if (decision.actor === memberId) continue;
    for (const ref of decision.affects ?? []) {
      if (ref === memberId) add(decision.actor);
      else if (ownerOf(ref) === memberId) add(decision.actor);
    }
  }
  return peers;
}

/**
 * The teammate decisions the snapshot carries: authored by a dependency peer, newest first, bounded by the switch's
 * limit. The rows are already small; the caller still has to fit them into the snapshot budget, which is why the
 * trimming lives there and not here.
 */
export function recentDecisions(core, memberId, limit = 5, store = core.store) {
  if (limit <= 0) return [];
  const peers = dependencyPeers(core, memberId, store);
  if (!peers.size) return [];
  return store.list('decision-log:')
    .filter(row => peers.has(row.actor))
    .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0) || String(b.entityId).localeCompare(String(a.entityId)))
    .slice(0, limit)
    .map(row => ({ actor: row.actor, summary: String(row.summary ?? '').slice(0, 80), at: row.decidedAt ?? 0,
      affects: (row.affects ?? []).slice(0, 4) }));
}

/**
 * The intent windows of one member, from committed rows only.
 *
 * One row per intent (kind 'intent'), one vote per recipient, one immutable conclusion. The counts below are the
 * report of §4.5 rule 5 and they are computed from the frozen facts — seenSummary is read off seenAtClose, never off
 * "is this recipient visible now", so a late request can never rewrite history (invariant 8 rule 6).
 */
export function intentState(core, memberId, store = core.store) {
  // A root-decision request is not a window: it has no votes, no seenAtClose and no passedUnseen, so counting it here
  // would report M2b statistics for a protocol that does not have them (§3.3, last rule).
  const intents = store.list('message:').filter(row => row.kind === 'intent' &&
    row.protocol !== ROOT_DECISION_PROTOCOL && row.sender === memberId)
    .sort((a, b) => (a.openedAt ?? 0) - (b.openedAt ?? 0));
  const closed = intents.filter(row => row.decision);
  const withSummary = summary => closed.filter(row => row.seenSummary === summary).length;
  return { sent: intents.length, open: intents.filter(row => !row.decision).length,
    passed: intents.filter(row => row.decision === 'passed').length,
    passedUnseen: intents.filter(row => row.decision === 'passed' && row.seenSummary !== 'seenAll').length,
    objected: intents.filter(row => row.decision === 'objected').length,
    seenAll: withSummary('seenAll'), seenPartial: withSummary('seenPartial'), seenNone: withSummary('seenNone'),
    intents: intents.map(row => ({ messageId: row.entityId, taskRef: row.taskRef ?? null,
      contractRevision: row.contractRevision ?? null, recipients: (row.recipients ?? []).slice(),
      openedAt: row.openedAt ?? null, closesAt: row.closesAt ?? null, decision: row.decision ?? null,
      closedAt: row.closedAt ?? null, seenSummary: row.seenSummary ?? null,
      votes: (row.recipients ?? []).map(recipient => ({ recipient, verdict: row.votes?.[recipient]?.verdict ?? null,
        reason: row.votes?.[recipient]?.reason ?? null, at: row.votes?.[recipient]?.at ?? null,
        seenAtClose: row.seenAtClose?.[recipient] ?? null })),
      visibilityAfterClose: (row.visibilityAfterClose ?? []).length,
      lateEvidence: (row.lateEvidence ?? []).length })) };
}

/**
 * What the gate will do for this member's current task, as a view.
 *
 * The authoritative check is the reducer's (host-protocol §4.2 rule 5); this is the sentence the model reads in its
 * snapshot so the requirement arrives with the task instead of as a refusal.
 */
/**
 * §3.3 rules 5-6, as the sentence a v1 member reads instead of an intent prompt.
 *
 * In v1 no task needs an intent before it publishes: the M2b requirement arrived with the task, and the design replaced
 * it with 'ask root only when a commitment, an owner or a contract has to change'. What can still block a revision is
 * an explicit coordination decision on exactly that revision -- open, rejected, revision-requested or expired. Waiting
 * is not one of the ways out: only root's approve is.
 */
export function coordinationGateView(core, memberId, store = core.store) {
  const task = store.list('task:').filter(row => row.owner === memberId)[0] ?? null;
  const binding = task ? { taskRef: task.entityId, contractRevision: task.contractRevision } : {};
  const decisions = task ? coordinationDecisions(store, binding) : [];
  const block = task ? coordinationBlock(store, binding) : null;
  return { open: block === null, state: block ? block.state : 'clear', code: block ? block.code : null,
    taskRef: task?.entityId ?? null, contractRevision: task?.contractRevision ?? null,
    coordination: decisions.map(row => ({ decisionId: row.entityId, state: coordinationDecisionState(row),
      option: row.verdict?.option ?? null, expiresAt: row.expiresAt ?? null,
      requestedBy: row.binding?.requestedBy ?? null })),
    nextAction: block
      ? 'contract revision ' + binding.contractRevision + ' is blocked by ' + block.decisionId + ' (' + block.state +
        '): root decides it with team_decide, and an expired request keeps the block -- waiting is not consent'
      : 'publishing this revision needs no intent: report changes on the resource thread, and ask root (team_message ' +
        'send kind=intent) only when a commitment, an owner or a contract has to change' };
}
export function implementGateView(core, memberId, store = core.store) {
  // §3.3: v1 replaced this gate's premise, so the sentence a member reads is the coordination one, not the intent one.
  if (rootDecisionOn(core)) return coordinationGateView(core, memberId, store);
  const task = store.list('task:').filter(row => row.owner === memberId)[0] ?? null;
  const bound = task ? store.list('message:').filter(row => row.kind === 'intent' && row.sender === memberId &&
    row.taskRef === task.entityId && row.contractRevision === task.contractRevision) : [];
  const state = bound.some(row => row.decision === 'objected') ? 'objected'
    : bound.some(row => row.decision === 'passed') ? 'passed'
    : bound.length ? 'open' : 'none';
  return { open: state === 'passed', state, taskRef: task?.entityId ?? null,
    contractRevision: task?.contractRevision ?? null, intents: intentState(core, memberId, store),
    nextAction: state === 'passed' ? 'intent passed; implement may proceed'
      : state === 'objected' ? 'a recipient objected to this contract revision; send a new team_message kind=intent for a new revision before publishing'
      : state === 'open' ? 'the intent window is open: prepare, and publish when it closes (silence is consent); a recipient who disagrees answers with team_message op=reply verdict=object'
      : 'send team_message kind=intent to the downstream that consumes your work (to: member ids, taskRef, contractRevision, summary) before team_task produce, team_verify or team_thread decide; silence when the window closes counts as ok, so you do not wait for an ack' };
}

/**
 * The same gate, in the size a snapshot can afford.
 *
 * The per-intent table is what a report reads (who answered what, when the window closed, what the frozen facts were);
 * the model needs the decision, the binding and the next action, plus the counts. Keeping the table in the payload made
 * the block compete with the decisions it is meant to sit next to, and the block already yields to the 4096-byte ceiling.
 */
export function implementGateSummary(core, memberId, store = core.store) {
  const view = implementGateView(core, memberId, store);
  // §3.3: v1 keeps the state and the blocking decision, and drops the M2b counters and the passedUnseen statistic --
  // there are no windows to pass unseen, and publishing one would report a fact the protocol no longer produces.
  if (rootDecisionOn(core)) {
    const { coordination, ...rest } = view;
    return { ...rest, coordination: coordination.length };
  }
  const { intents, ...rest } = view;
  const { sent, open, passed, passedUnseen, objected, seenAll, seenPartial, seenNone } = intents;
  return { ...rest, intents: { sent, open, passed, passedUnseen, objected, seenAll, seenPartial, seenNone } };
}

/** The gate's refusal code for this member, for callers that only need to describe it. */
export function implementGate(core, memberId, store = core.store) {
  if (!collabOn(core)) return null;
  const view = implementGateView(core, memberId, store);
  // §3.3: v1's only refusal here is the coordination block; 'no intent yet' is no longer one of them.
  if (rootDecisionOn(core)) return view.open ? null : view.code;
  return view.open ? null : view.state === 'open' ? 'INTENT_WINDOW_OPEN'
    : view.state === 'objected' ? 'INTENT_OBJECTED' : 'INTENT_REQUIRED';
}

/**
 * The assumptions a member raised that nobody answered yet, and the ones it owes an answer to.
 * Both halves are what the pre-integration acceptance list needs, so they are derived here and never counted by
 * the model.
 */
export function assumptionLedger(core, memberId, store = core.store) {
  const rows = store.list('assumption:');
  const mine = rows.filter(row => row.raiser === memberId);
  const owed = rows.filter(row => row.owner === memberId && row.status === 'open');
  return { raised: mine.length, open: mine.filter(row => row.status === 'open').length,
    confirmed: mine.filter(row => row.status === 'confirmed').length,
    corrected: mine.filter(row => row.status === 'corrected').length,
    owedToOthers: owed.length,
    unanswered: mine.filter(row => row.status === 'open').map(row => ({ assumptionId: row.entityId,
      about: row.about, claim: row.claim, impact: row.impact, raisedAt: row.raisedAt ?? null, deadline: row.deadline ?? null })) };
}

/** Stable identity for a raise so a retried operationId replays its receipt instead of raising twice. */
export const assumptionId = operationId => 'assumption:' + digest(String(operationId)).slice(0, 32);