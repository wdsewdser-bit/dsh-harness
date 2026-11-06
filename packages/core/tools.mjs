import { roleTools, validateTool } from '../contracts/team-tools.mjs';
import { fail, failWith } from '../contracts/index.mjs';
import { toolCommand } from './tool-reducer.mjs';
import { reduceCommand } from './index.mjs';
import { assertCas } from './commands/index.mjs';
import { authorize } from './authorization.mjs';
import {normalizeToolDeadlines} from '../contracts/index.mjs';
import {readiness} from './readiness.mjs';
import {collabOn, collabSettings, intentProtocol, isImplementCall} from './collab.mjs';
import { resourceThreadView, readThreadEvents } from './thread-events.mjs';
import {autonomySettings, ownerBindingOf} from './authority.mjs';
import {completionProofOf} from './commands/decisions.mjs';
import {goalGateSettings, goalIdOf} from './commands/goals.mjs';

/**
 * Thread row as the model reads it: the discriminant first, then the shape that kind actually has.
 *
 * §3.1: a legacy row carries no kind and is a decision thread, so the read derives 'decision' instead of rewriting
 * history; a resource row is projected through its own view (identity, head, subscribers, pending counts, last event)
 * because feeding it to requiredRespondents/replies would answer a review question about a topic that has none.
 */
const projectedThread = (row, store, v1, canReadMember) => {
  if (row.kind === 'resource') return resourceThreadView(store, row.entityId, canReadMember) ?? { ...row, kind: 'resource' };
  const state = readiness(row);
  return { ...row, ...(v1 ? { kind: row.kind ?? 'decision' } : {}), missing: state.missing,
    readyToDecide: state.readyToDecide, nextAction: state.nextAction };
};

const viewPrefix = view => view === 'evidence' ? '' : view === 'team' ? 'member:' : view + ':';
/** Which view an exact entity id belongs to; artifacts are read through the evidence view. */
const viewOfId = id => { const parts = String(id).split(':'), head = parts[0] === 'v1' ? parts[1] : parts[0];
  return head === 'artifact' || head === 'verification-evidence' ? 'evidence' : head; };

/**
 * Resolve a published read ref inside its view; the whole view needs no ref.
 * Accepts the exact id, or the suffix the model can read from a snapshot, never a guess outside the view.
 */
function refRemedy(core, view, actor) {
  const ids = actor ? core.store.list(viewPrefix(view)).filter(row => viewOfId(row.entityId) === view).filter(row => {
    try { authorize(core, actor, row.entityId); return true; } catch { return false; }
  }).slice(0, 5).map(row => row.entityId) : [];
  return 'Run team_read ' + JSON.stringify({ view }) + ' (omit ref), then copy an exact entityId from refs. ' +
    (view === 'evidence' ? 'Evidence refs use artifact: or verification-evidence:, not delivery:task: ids. ' : '') +
    'Readable choices: ' + JSON.stringify(ids);
}
export function resolveReadRef(core, view, ref, actor) {
  if (ref === undefined || ref === null) return null;
  if (view === 'team' && (ref === 'team' || ref === 'member:team')) return null;
  // A full id that exists but belongs to another view is a caller mistake worth naming, not an empty list.
  if (String(ref).includes(':') && core.store.read(ref)) {
    const belongs = viewOfId(ref);
    if (belongs !== view) failWith('INVALID_REF', 'ref ' + ref + ' belongs to view "' + belongs +
      '", not "' + view + '". ' + refRemedy(core, view, actor));
  }
  // The evidence view holds two id families whose prefixes carry no view name (artifact:<cycle>:<actor> and
  // verification-evidence:...), so a suffix the model read ("1:be") has to be tried against both instead of against a
  // "evidence:" prefix that never exists. That single missing candidate cost the second real collaboration run its only
  // unrecovered read refusal.
  const candidates = view === 'evidence'
    ? [ref, 'artifact:' + ref, 'verification-evidence:' + ref, 'v1:artifact:' + ref]
    : [ref, viewPrefix(view) + ref, 'v1:' + view + ':' + ref];
  for (const candidate of candidates) if (core.store.read(candidate)) return candidate;
  // Nothing matched: say so instead of answering an empty list the caller cannot interpret.
  failWith('INVALID_REF', 'ref ' + ref + ' is not in view "' + view + '". ' + refRemedy(core, view, actor));
}

/**
 * The collaboration facts an admitted call carries into its command.
 *
 * The intent gate itself is NOT evaluated here: host-protocol §4.2 rule 5 requires it inside the transaction that
 * publishes, so the entry only marks the command (`gate: true`) and the reducer decides against the committed votes.
 * The intent window length is a server setting and travels the same way.
 */
function collabFields(core, name, args, command) {
  if (!collabOn(core)) return command;
  const settings = collabSettings(core);
  // §3.3: a v1 intent is a root decision, not a window, so the entry carries no windowMs for it -- the reducer refuses
  // one outright, and a v1 request that had one would be an M2b call wearing the wrong protocol.
  if (command.type === 'message.send' && command.payload.kind === 'intent' && intentProtocol(core) !== 'root-decision-v1') {
    return { ...command, payload: { ...command.payload, windowMs: settings.intentWindowMs } };
  }
  if (isImplementCall(name, args)) return { ...command, payload: { ...command.payload, gate: true } };
  return command;
}

/**
 * Execute role commands atomically with injected authority and durable receipts; 08 §4.10.
 *
 * The tool no longer writes: it translates one closed call into one domain command (tool-reducer.mjs) and runs that
 * command inside this single transaction. intent.cas is the revision the projection API read for the command target;
 * a model call leaves it absent and carries its own expectedRevision instead.
 */
/**
 * The workspace fence, asked of the profile's own port (§4.2.3 rule 3, appendix 7).
 *
 * core has no team root and no filesystem policy; the host that owns the root injects one function that resolves a
 * relative path against it. Absent port, absent answer: a workspace is not assignable through a core that cannot prove
 * where it lands, which is why this refuses instead of recording the relative path and hoping.
 */
function fenceWorkspace(core, relPath) {
  const port = core.ports?.workspaceFence;
  if (typeof port !== 'function') {
    failWith('INVALID_WORKSPACE', 'this core has no workspace fence: a workspace is assignable only through a host that can prove the path sits under the team root');
  }
  const fenced = port({ relPath });
  if (!fenced || typeof fenced.resolved !== 'string' || typeof fenced.relPath !== 'string') {
    failWith('INVALID_WORKSPACE', 'the workspace fence answered nothing usable for ' + JSON.stringify(relPath));
  }
  return fenced;
}

/**
 * P3 §12 U7: the journal proof behind a completion verdict, read through the profile's own port.
 *
 * A completion is decided on log evidence or not at all, and the only reader of the session journal is the gate; the
 * profile publishes it as `core.ports.sessionJournal`. This asks that reader -- outside the transaction, exactly as the
 * gate's own entry does -- and hands the proof to the same reducer. Nothing here comes from the request: the model names
 * a decision row and one option, and a composition with no journal port refuses instead of believing a claim.
 */
function completionJournal(core, decisionId, option) {
  const decision = core.store.read(decisionId);
  if (!decision || decision.kind !== 'completion') return null;
  // An option outside the closed set is the reducer's refusal (INVALID_ADJUDICATION); a proof for it would be moot.
  if (option !== 'consumed' && option !== 'cancelled') return null;
  const sessionRef = decision.evidence?.find(entry => entry.kind === 'journal')?.ref ?? null;
  if (!sessionRef) {
    failWith('SESSION_LOG_UNAVAILABLE', 'this completion decision names no session journal, so no verdict can be taken on it');
  }
  const port = core.ports?.sessionJournal;
  if (typeof port !== 'function') {
    failWith('SESSION_LOG_UNAVAILABLE', 'this composition publishes no session-journal readback, so a completion verdict ' +
      'cannot be taken through a tool (§12 U7)');
  }
  const token = decision.subject?.id ? core.store.read(decision.subject.id) : null;
  if (!token) failWith('DECISION_STALE', 'the completion token of ' + decisionId + ' no longer exists');
  return completionProofOf(port({ sessionId: sessionRef }), token, option);
}

/**
 * A compacted receipt is a durable replay answer, not an execution result: retention replaces the result body with
 * its digest. Callers of a tool entry that read result fields must never receive a silent null, so replay of a
 * compacted operation through this entry is a typed refusal. Store-level replay (commit/receiptOf) still returns the
 * same receipt with the same resultDigest, which is what "same operationId, same answer" means after compaction.
 */
function replayGuard(receipt) {
  if (receipt && receipt.compacted) {
    failWith('RECEIPT_COMPACTED', 'operation ' + String(receipt.operationId) + ' was compacted after it committed; ' +
      'its result body is not stored (resultDigest ' + receipt.compacted.resultDigest + '). The durable replay answer ' +
      'is the summary, so a caller that needs the body must not reuse an operationId across retention');
  }
  return receipt;
}

export function handleTool(core, binding, name, args, intent = {}) {
  if (!core.configuration.enabled) fail('TEAM_DISABLED');
  const privileged = ['operator', 'root'].includes(binding.actor) &&
    ((name === 'team_member' && args.op === 'retire') || (name === 'team_plan' && args.op === 'approve'));
  const member = core.store.read(binding.actor) ?? (privileged ? { role: 'root' } : null);
  const autonomy = autonomySettings(core);
  const schema = roleTools(member?.role, collabSettings(core).collab, autonomy.autonomy, core.configuration.superagentBorrow ?? 'off')[name];
  if (!schema) fail('ROLE_DENIED');
  if (intentProtocol(core) === 'root-decision-v1' && name === 'team_message' && args.op === 'reply') fail('WRONG_INTENT_PROTOCOL');
  validateTool(schema, args);
  if (name === 'team_read') {
    if (args.view === 'thread-events') {
      authorize(core, binding.actor, args.ref);
      return { asOfSeq: core.store.latestEventSeq(), stale: false, view: args.view,
        ...readThreadEvents(core.store, { threadRef: args.ref, afterSeq: args.afterSeq, limit: args.limit }) };
    }
    const ref = resolveReadRef(core, args.view, args.ref, binding.actor);
    return { asOfSeq: core.store.latestEventSeq(), stale: false,
      view: args.view,
      refs: core.store.list(viewPrefix(args.view))
        .filter(row => args.view !== 'evidence' || /^(artifact:|verification-evidence:|v1:artifact:)/.test(row.entityId))
        .filter(row => {
          if (ref && row.entityId !== ref) return false;
          try { authorize(core, binding.actor, row.entityId); return true; } catch { return false; }
        })
        // A thread row must never depend on the reader doing its own set arithmetic: state what is still missing
        // and whether the owner may decide now, so "collecting" with every delivery reviewed cannot be misread.
        .map(row => args.view === 'thread' ? projectedThread(row, core.store, intentProtocol(core) === 'root-decision-v1', memberId => {
          try { authorize(core, binding.actor, memberId); return true; } catch { return false; }
        }) : row)
        .slice(0, args.limit ?? 20) };
  }
  // One trusted instant for authority, deadline admission and the reducer; never read args.now.
  const now = core.configuration.now?.() ?? Date.now();
  if (['worker', 'verifier'].includes(member.role)) {
    const attempt = core.authority(binding.attemptId, binding.fence, now);
    if (attempt.owner !== binding.actor) fail('ACTOR_MISMATCH');
  }
  // P2 §4.2.3 rule 3: the workspace fence runs here -- before the transaction opens, and long before any host creates a
  // directory or a session. The profile's port resolves the relative path against the team root with realpath on the
  // deepest existing ancestor; this entry refuses to proceed without an answer, because a reducer that received a path
  // nobody fenced cannot tell whether it lands inside the root.
  const workspace = name === 'team_member' && args.op === 'provision' && args.workspace !== undefined
    ? fenceWorkspace(core, args.workspace)
    : null;
  const entityId = 'tool-intent:' + args.operationId;
  const command = { ...core.command(entityId, binding.actor, { name, args, binding }, args.operationId, { now }),
    expectedRevision: 0 };
  // Review 1 #5: the durable receipt is what a retry must find FIRST. The completion proof used to be read before the
  // transaction, so a team_decide that had already committed could fail its own replay as SESSION_LOG_UNAVAILABLE once
  // the journal could not be read again -- a successful verdict reported as a failure. The probe below uses the store's
  // own identity hash, so a different payload under the same operationId is still ID_CONFLICT, and a hit replays the
  // original receipt without any external IO.
  const replayed = typeof core.store.receiptOf === 'function' ? core.store.receiptOf(command) : null;
  if (replayed?.conflict) fail('ID_CONFLICT');
  if (replayed?.receipt) return replayGuard(replayed.receipt);
  // §12 U7: a completion verdict is the one call whose proof cannot come from the request, so it is read here -- before
  // the transaction opens, from the port the composition installed -- and travels as trusted metadata beside it. It is
  // read only on a miss: the external read never runs for an operation that already has its answer.
  const journal = name === 'team_decide' ? completionJournal(core, args.decisionId, args.decision) : null;
  const receipt = core.store.commit(command, tx => {
    // The projection entry's own revision prediction (intent.cas) is checked here, first: durable replay has already
    // run inside commit(), and HEAD's commit proxy checked the target revision at exactly this point -- before the
    // completion fence, the reference existence checks and the reference authorization below. So a stale revision
    // stays a CAS conflict even when one of those would also refuse (§7.13). The tool's own translation.cas keeps its
    // HEAD position, in the shared dispatcher, and is not repeated when it is the same check.
    if (intent.cas) assertCas(tx, intent.cas);
    // §2.2.5 item 2 / §12 U7: the decision entry is the autonomy package's operator-class command, so it survives the
    // completion fence -- adjudicating the token is how the team comes back. Nothing else does: the exemption is
    // keyed on the one tool name the closed catalog publishes only while the switch is on, and the verdict it reaches
    // is further confined by the restricted transaction in commands/decisions.mjs. Every other call stays frozen.
    const decisionEntry = autonomy.autonomy === 'on' && name === 'team_decide';
    if (!decisionEntry && tx.list('completion:').some(t => ['prepared', 'authorized', 'unknown'].includes(t.status))) fail('COMPLETION_FROZEN');
    if (['worker', 'verifier'].includes(member.role)) {
      const current = core.authority(binding.attemptId, binding.fence, now);
      if (current.owner !== binding.actor) fail('ACTOR_MISMATCH');
      authorize(core, binding.actor, binding.actor);
    }
    for (const ref of [args.messageId, args.issueId, args.taskRef, args.bodyRef, args.conclusionRef,
      args.progressRef, args.acceptanceRef, args.resultRef, args.deliveryRef, ...(args.evidenceRefs ?? [])].filter(Boolean)) {
      if (!tx.read(ref)) fail('MISSING_REFERENCE:' + ref);
      authorize(core, binding.actor, ref);
    }
    // Normalize on first transactional admission only; preserve raw command identity for retries.
    const admittedArgs = normalizeToolDeadlines(args, now);
    // The collaboration facts this call carries (the intent window, the in-transaction gate marker) come from the
    // trusted entry, never from the request body (host-protocol §4.2 rule 5).
    // §3.2.3: whether this actor is the owner is a predicate over the member row, read inside the transaction that
    // writes the row -- so the owner channel cannot be claimed by a request and cannot be granted by a stale read.
    const owner = autonomy.autonomy === 'on' && ownerBindingOf(tx, binding.actor) !== null;
    const translation = toolCommand(member, binding, name, admittedArgs, { workspace, owner });
    const admitted = collabFields(core, name, admittedArgs, translation.command);
    // One CAS function, one check: when the entry's prediction and the tool's prediction name the same row and
    // revision, the early check above already answered it.
    const duplicate = intent.cas && translation.cas && translation.cas.ref === intent.cas.ref &&
      translation.cas.revision === intent.cas.revision;
    const result = reduceCommand(tx, { ...admitted, actor: binding.actor, now: command.now,
      operationId: args.operationId, autonomy: autonomy.autonomy, decisionTtlMs: autonomy.decisionTtlMs,
      // The same trusted-entry metadata the core's own dispatch carries: the intent protocol, the registered
      // repositories and the per-resource event limit are read off the composition, never off the request.
      intentProtocol: intentProtocol(core), repositories: core.configuration.repositories ?? [],
      threadEventLimit: core.configuration.threadEventLimit,
      // P3: the strict stance of the goal gate must bind the model entry too, or TEAM_GOAL_REQUIRED would only guard
      // the host's own calls (see the report for why this file is touched outside the P3 allowlist).
      goalGate: goalGateSettings(core),
      // The completion proof read above, and only that one: a command carrying no journal is refused by the reducer.
      journal,
      // §5.2.2 / review 1 #3: a consumed completion closes the team goal, and the reducer needs the goal row's id to do
      // it. Like the journal, it comes from the trusted configuration (one goal row per team) -- never from the
      // request, which cannot name the row a verdict is allowed to write.
      teamGoalId: name === 'team_decide' ? goalIdOf(core) : null,
      cas: duplicate ? undefined : translation.cas });
    tx.put(entityId, { name, args: admittedArgs, actor: binding.actor, attemptId: binding.attemptId ?? null,
      fence: binding.fence ?? null, status: 'confirmed', certificate: false });
    return result;
  });
  replayGuard(receipt);
  // Delivery is announced only after the commit returns: a listener that preempts must never run inside the
  // transaction, and a rolled-back send must never wake anyone.
  // A raised assumption rides the ordinary message path, so the owner is woken the same way an action wakes it;
  // the raiser is not blocked either way, and with collab off this branch cannot exist.
  if (name === 'team_message' && args.op === 'send') {
    for (const target of Array.isArray(args.to) ? args.to : [args.to]) core.notifyDelivery?.(target, receipt.result?.entityId);
  }
  if (name === 'team_assume' && receipt.result?.messageId) core.notifyDelivery?.(receipt.result.owner, receipt.result.messageId);
  return receipt;
}