import { fail } from '../contracts/index.mjs';
import { id } from '../contracts/index.mjs';
import { normalizeScope } from './scopes.mjs';

/**
 * Model tools are translators (plan §5 M2, rule 2): one closed tool call becomes one domain command.
 *
 * This file writes nothing. Every fact named here is written by the reducer in commands/ that the command selects, so a
 * message, a task, a thread or an assumption has one owner whether the model wrote it or the host did.
 */

/** The row a caller predicted a revision for. The dispatcher checks it inside the same transaction as the write. */
function toolCas(args) {
  const ref = args.messageId ?? args.issueId ?? args.taskRef ?? args.memberRef ?? args.deliveryRef ?? args.decisionId;
  return ref ? { ref, revision: args.expectedRevision } : null;
}

const scoped = (prefix, operationId) => prefix + ':' + operationId;

function messageCommand(binding, args, trusted = {}) {
  // §3.2.3: an owner holds no execution lease, so its accept/resolve cannot travel the lease path. The channel is
  // selected HERE, by the trusted translator, from the owner row the caller read inside the transaction -- never from a
  // request field -- and an owner writes no attempt, no fence and no checkpoint, because it has none to write. Every
  // other member keeps the execution path it has always had, selected explicitly so the two are told apart.
  if (args.op === 'send') {
    const messageId = 'message:' + id('message');
    // The simplified send (host-protocol §4.3): an intent names its downstream set and the contract revision it binds,
    // and the server owns the window. Every other kind keeps the addressed single-recipient shape.
    return { type: 'message.send', payload: { messageId, to: args.to, kind: args.kind, summary: args.summary,
      bodyRef: args.bodyRef, taskRef: args.taskRef, threadRef: args.threadRef,
      expectedOutcome: args.expectedOutcome, contractRevision: args.contractRevision, deadline: args.deadline,
      // §3.3 rule 3: a v1 intent carries the reason for the ruling and the evidence it rests on. The legacy window
      // ignores both; the v1 reducer requires them, so the translator passes what the surface published and no more.
      ...(args.reason === undefined ? {} : { reason: args.reason }),
      ...(args.evidenceRefs === undefined ? {} : { evidenceRefs: Array.isArray(args.evidenceRefs) ? args.evidenceRefs.slice() : args.evidenceRefs }),
      ...(args.previousDecisionId === undefined ? {} : { previousDecisionId: args.previousDecisionId }),
      // The model path is where an intent IS the implement gate, so it refuses a self-addressed one.
      policy: { rejectSelfIntent: true } } };
  }
  if (args.op === 'reply') {
    return { type: 'message.reply', payload: { messageId: args.messageId, verdict: args.verdict,
      reason: args.reason ?? null } };
  }
  const owner = trusted.owner === true;
  const policy = { authority: owner ? 'owner' : 'execution' };
  if (args.op === 'accept') {
    return { type: 'message.accept', policy, payload: { messageId: args.messageId,
      attemptId: owner ? null : binding.attemptId, fence: owner ? null : binding.fence,
      checkpointRef: owner ? null : args.checkpointRef } };
  }
  return { type: 'message.resolve', policy, payload: { messageId: args.messageId, resultRef: args.resultRef,
    attemptId: owner ? null : binding.attemptId, fence: owner ? null : binding.fence } };
}

function threadCommand(args) {
  // §3.1/§3.2 (P1): the resource branches of the same team_thread tool. They translate to the thread-events reducers;
  // the surface that publishes them arrives with the v1 activation, which this build still refuses (§2). The id a
  // resource is opened under is derived from the operation id, and the reducer's canonical index decides whether that
  // identity already owns a thread.
  if (args.op === 'open-resource') {
    return { type: 'thread.open-resource', payload: { issueId: scoped('thread', args.operationId),
      resource: args.resource, descriptionRef: args.descriptionRef, owner: args.owner ?? null,
      taskRef: args.taskRef ?? null } };
  }
  if (args.op === 'subscribe') {
    return { type: 'thread.subscribe', payload: { issueId: args.issueId, memberId: args.memberId ?? null,
      replayFrom: args.replayFrom ?? null } };
  }
  if (args.op === 'unsubscribe') {
    return { type: 'thread.unsubscribe', payload: { issueId: args.issueId, memberId: args.memberId ?? null,
      reason: args.reason } };
  }
  if (args.op === 'publish') {
    return { type: 'thread.publish', payload: { issueId: args.issueId, eventType: args.eventType,
      summary: args.summary, bodyRef: args.bodyRef ?? null, operationId: args.operationId } };
  }
  if (args.op === 'close-resource') {
    return { type: 'thread.close-resource', payload: { issueId: args.issueId, reason: args.reason } };
  }
  if (args.op === 'open') {
    return { type: 'thread.open', payload: { issueId: scoped('thread', args.operationId), owner: args.owner,
      requiredRespondents: args.requiredRespondents, requiredEvidence: args.requiredEvidence ?? [],
      question: args.question, deadline: args.deadline, escalationOwner: 'operator', taskRef: args.taskRef,
      // The model may only open a thread for an owner that exists; the direct entry never checked it.
      policy: { requireOwnerRow: true } } };
  }
  if (args.op === 'reply') {
    return { type: 'thread.reply', payload: { issueId: args.issueId, proposalRevision: args.proposalRevision,
      bodyRef: args.bodyRef } };
  }
  return { type: 'thread.decide', payload: { issueId: args.issueId, proposalRevision: args.proposalRevision,
    conclusionRef: args.conclusionRef } };
}

function planCommand(member, args) {
  if (args.op === 'create') {
    const planned = { ...args, scopeSet: args.scopeSet.map(normalizeScope) };
    return { type: 'task.create', payload: { mode: 'plan', taskId: scoped('task', args.operationId), args: planned,
      role: member?.role ?? null } };
  }
  return { type: 'task.approve', payload: { taskRef: args.taskRef, contractRevision: args.contractRevision,
    delegationRef: args.delegationRef, role: member?.role ?? null } };
}

function taskCommand(binding, args) {
  if (args.op === 'checkpoint') {
    return { type: 'task.checkpoint', payload: { taskRef: args.taskRef, progressRef: args.progressRef,
      attemptId: binding.attemptId, fence: binding.fence } };
  }
  // entry: 'tool' keeps this path's HEAD contract: attempt -> waits -> task, result is the task row.
  return { type: 'attempt.finish', payload: { attemptId: binding.attemptId, fence: binding.fence,
    status: 'produced', deliveryRef: args.deliveryRef, taskRef: args.taskRef, entry: 'tool' } };
}

/** The command one admitted tool call translates to, plus the revision prediction the caller sent. */
export function toolCommand(member, binding, name, args, trusted = {}) {
  let command;
  if (name === 'team_assume') {
    command = args.assumptionId === undefined
      ? { type: 'assumption.raise', payload: { operationId: args.operationId, about: args.about, claim: args.claim,
        impact: args.impact, deadline: args.deadline } }
      : { type: 'assumption.answer', payload: { assumptionId: args.assumptionId, verdict: args.verdict,
        correction: args.correction } };
  } else if (name === 'team_message') command = messageCommand(binding, args, trusted);
  else if (name === 'team_thread') command = threadCommand(args);
  else if (name === 'team_wait') {
    command = { type: 'wait.open', payload: { waitId: scoped('wait', args.operationId), attemptId: binding.attemptId,
      fence: binding.fence, deriveTask: true, dependency: args.dependency, deadline: args.deadline, reason: args.reason } };
  } else if (name === 'team_task') command = taskCommand(binding, args);
  else if (name === 'team_plan') command = planCommand(member, args);
  else if (name === 'team_member') {
    // P2 §4.2.1/§4.2.2: provision carries the host's fenced workspace as TRUSTED metadata, beside the request body --
    // never inside it. The body can only name a relative path (the published schema has no absolute one), and the fence
    // is the only thing that turns it into a path somebody proved sits under the team root.
    command = { type: 'member.intent', payload: { operationId: args.operationId, args,
      ...(trusted.workspace ? { workspace: trusted.workspace } : {}) } };
  } else if (name === 'team_verify') {
    // The attempt travels with the evidence: the gate is about the verifier's own task (the work it publishes under),
    // and the reducer reads that binding from the lease rather than guessing it from the delivery it is judging.
    command = { type: 'verification.evidence', payload: { operationId: args.operationId, deliveryRef: args.deliveryRef,
      contractRevision: args.contractRevision, attemptId: binding.attemptId, fence: binding.fence, args } };
  } else if (name === 'team_goal') {
    command = { type: 'goal.intent', payload: { operationId: args.operationId, args } };
  } else if (name === 'team_decision') {
    command = { type: 'decision.log', payload: { operationId: args.operationId, summary: args.summary,
      affects: args.affects } };
  } else if (name === 'team_decide') {
    // §2.2.2: the model names a row and one option; it never creates the row and never names the authority. The
    // policy is written HERE, by the trusted translator, after the request args -- so a request cannot pick a
    // stronger channel than the entry it came through (the same discipline as mailbox.mjs POLICIES and
    // commands/messages.mjs auditedUiAdmission).
    command = { type: 'decision.decide', policy: { authority: 'owner' },
      payload: { decisionId: args.decisionId, decision: args.decision, reason: args.reason ?? null,
        evidenceRef: args.evidenceRef ?? null } };
  } else fail('UNKNOWN_TOOL');
  return { command, cas: toolCas(args) };
}
