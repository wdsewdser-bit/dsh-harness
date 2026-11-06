import { fail, failWith } from '../../contracts/index.mjs';
import { ownerBindingOf } from '../authority.mjs';
import { leaseOf } from './lease.mjs';
import { releaseAttempt } from './release.mjs';
import { assertCoordinationAllows } from './intents.mjs';
import { teamGoalIn } from './goals.mjs';

/**
 * Task-side facts: the contract row, the execution result, waits and dependencies, verification evidence, goal
 * requests and the decision ledger.
 *
 * Each reducer is the single owner of its fact. Two former implementations (TeamCore.task/finish/wait and the model
 * tool path) disagreed about defaults and about which refusal a missing owner produced; the union kept here is
 * recorded in docs/decisions/M2a-shared-reducer.md. Nothing here commits, awaits or spawns.
 */

/**
 * P3 §5.2.3: every task is bound to the team goal that was open when it was written.
 *
 * With no goal record the row is exactly HEAD's row (the record is opt-in), and TEAM_GOAL_REQUIRED is raised only in
 * the strict stance of §12 U5 -- the compatibility stance keeps running the teams that exist.
 */
function bindTeamGoal(tx, command, row) {
  const goal = teamGoalIn(tx);
  if (!goal) {
    if (command.goalGate?.strict === true) {
      failWith('TEAM_GOAL_REQUIRED', 'this team has no goal record; open one (team.goal.open, before the first task) ' +
        'so every task names the chain root it was planned against');
    }
    return row;
  }
  if (goal.state !== 'open') {
    failWith('TEAM_GOAL_TOO_LATE', 'the team goal is ' + goal.state + '; a new task cannot bind to a closed goal');
  }
  return { ...row, teamGoalRef: goal.entityId, teamGoalRevision: goal.revision };
}

/**
 * §3.2.3 / §12 U7's sibling: the owner holds no execution lease.
 *
 * P1 opened the owner path for responsibilities (message.accept) and deliberately did not invent an attempt for it.
 * The execution writes -- checkpoint, finish, verification evidence -- are the other half of that rule: when the team
 * owner calls one with no attempt of its own, the answer is OWNER_HAS_NO_LEASE with the exit it does have, not the
 * INVALID_LEASE a worker would get for holding a stale fence. Off, this is byte for byte HEAD's leaseOf.
 */
function executionLease(tx, command, attemptId, fence) {
  if (command.autonomy === 'on' && !tx.read(attemptId) && ownerBindingOf(tx, command.actor)) {
    failWith('OWNER_HAS_NO_LEASE', 'the team owner holds no execution lease, so ' + String(command.type) + ' cannot run ' +
      'as ' + command.actor + '; produce, verify, checkpoint and finish belong to the attempt that holds the lease, and ' +
      'the owner adjudicates through team_decide (decision rows) instead');
  }
  return leaseOf(tx, attemptId, fence);
}

/** Bounded root delegation: the scope and task budget a subCoordinator plans inside (08 §4.3). */
function requireDelegation(tx, actor, delegationRef, scopeSet) {
  const delegation = tx.read(delegationRef);
  if (!delegation || delegation.owner !== actor || Date.parse(delegation.expiresAt) <= Date.now()) fail('DELEGATION_NOT_BOUND');
  if (!scopeSet.every(scope => delegation.approvedScope.some(approved => scope === approved || scope.startsWith(approved + '/')))) {
    fail('DELEGATION_SCOPE');
  }
  return delegation;
}

function roleOf(tx, command) {
  return command.payload.role ?? tx.read(command.actor)?.role ?? null;
}

/**
 * The queue position of the current ready episode, persisted on the task itself.
 *
 * v1 drains in the order tasks entered ready. That used to be rebuilt by scanning the journal for the transition,
 * which stops working once retention collects old versions of a live row. The seq is therefore written into the row
 * at the moment it becomes ready and carried across every later update while it stays ready: changing unrelated
 * fields never loses queue age, and re-entering ready takes a new position at the tail.
 */
function readyOrder(tx, prior, row) {
  if (row.status !== 'ready') return row;
  if (prior?.status === 'ready' && Number.isSafeInteger(prior.readySeq)) return { ...row, readySeq: prior.readySeq };
  return { ...row, readySeq: tx.latestEventSeq() + 1 };
}

/**
 * Two creation modes, one owner of the row:
 *   assignment - root provisions a task ready to run (TeamCore.task, fixtures, mailbox-only tasks);
 *   plan       - a role plans a contract that still needs approval (team_plan create).
 */
function createTask(tx, command) {
  const p = command.payload;
  if (p.mode === 'plan') {
    const args = p.args;
    const role = roleOf(tx, command);
    if (role === 'subCoordinator') {
      const delegation = requireDelegation(tx, command.actor, args.delegationRef, args.scopeSet);
      if (tx.list('task:').filter(task => task.delegationRef === args.delegationRef).length >= delegation.budget.tasks) {
        fail('DELEGATION_BUDGET');
      }
    }
    if (tx.list('task:').some(task => task.requirementRef === args.requirementRef)) fail('DUPLICATE_REQUIREMENT');
    const taskOwner = tx.read(args.owner);
    if (!taskOwner) fail('UNKNOWN_OWNER');
    if (['root', 'subCoordinator'].includes(taskOwner.role) && args.scopeSet.length) fail('SUPERVISION_SCOPE');
    const prior = tx.read(p.taskId);
    return tx.put(p.taskId, readyOrder(tx, prior, bindTeamGoal(tx, command, { ...args, owner: args.owner, scopeSet: args.scopeSet,
      contractRevision: 1, assignmentEpoch: 1, approved: role === 'subCoordinator', worktreeReady: false,
      status: role === 'subCoordinator' ? 'ready' : 'draft' })));
  }
  const { owner, scopeSet, extra } = p;
  if (tx.list('task:').some(task => extra.requirementRef && task.requirementRef === extra.requirementRef)) {
    fail('DUPLICATE_REQUIREMENT');
  }
  const member = tx.read(owner);
  // HEAD's direct entry answered a missing owner with SUPERVISION_SCOPE; the plan branch above keeps the model path's
  // UNKNOWN_OWNER. Each entry keeps its own business error (docs/decisions/M2a-shared-reducer.md §7-6).
  if (!member || (['root', 'subCoordinator'].includes(member.role) && scopeSet.length)) fail('SUPERVISION_SCOPE');
  const prior = tx.read(p.taskId);
  return tx.put(p.taskId, readyOrder(tx, prior, bindTeamGoal(tx, command, { owner, scopeSet, contractRevision: 1, assignmentEpoch: 1,
    approved: true, worktreeReady: true, status: 'ready', ...extra })));
}

function approveTask(tx, command) {
  const p = command.payload;
  const current = tx.read(p.taskRef);
  if (!current) fail('CAS_CONFLICT:' + p.taskRef);
  // A delegated coordinator may only approve inside the delegation it was granted, exactly as for creation.
  if (roleOf(tx, command) === 'subCoordinator') requireDelegation(tx, command.actor, p.delegationRef, current.scopeSet ?? []);
  if (p.contractRevision !== current.contractRevision) fail('CAS_CONFLICT:contract');
  if (current.status !== 'draft' || current.approved) fail('NOT_DRAFT_CONTRACT');
  // §5.2.3: approval is the moment the contract binds, so it binds the goal revision it was approved against.
  return tx.put(p.taskRef, readyOrder(tx, current, bindTeamGoal(tx, command, { ...current, approved: true, status: 'ready' })));
}

function checkpointTask(tx, command) {
  const p = command.payload;
  const attempt = executionLease(tx, command, p.attemptId, p.fence);
  if (attempt.taskId !== p.taskRef || tx.read(p.taskRef)?.owner !== command.actor) fail('TASK_NOT_OWNED');
  return tx.put('checkpoint:' + p.progressRef, { attemptId: p.attemptId, progressRef: p.progressRef });
}

/**
 * The statuses attempt.finish writes, and the one normalisation both callers share.
 *
 * This lives in one function on purpose. The entry decides whether to ask for the publish gate and the reducer decides
 * whether to publish, so two different readings of "no status" are two different grants: with `status === 'produced'` at
 * the entry and `p.status ?? 'produced'` at the reducer, an explicit null read as "not a publish" on the way in and as
 * "the default publish" on the way out — a window with no gate. Now the argument is normalised and validated once, the
 * set is closed, and the gate follows the normalised value.
 *
 * Only an omitted argument means the default. `null` is not a status: it is an argument nobody normalised.
 */
export const FINISH_STATUSES = Object.freeze(['produced', 'cancelled', 'failed']);
export function normalizeFinishStatus(value) {
  const status = value === undefined ? 'produced' : value;
  if (!FINISH_STATUSES.includes(status)) {
    failWith('INVALID_FINISH_STATUS', 'attempt.finish takes ' + FINISH_STATUSES.join(' | ') + '; got ' +
      JSON.stringify(value ?? null) + ' (an omitted status means "produced", an explicit null is not a status)');
  }
  return status;
}

/**
 * Close the execution authorization and move the task with it: the attempt lease is released, the task reaches the
 * produced status (or the status the host asked for), and waits bound to that attempt are cancelled in the same write.
 */
function finishAttempt(tx, command) {
  const p = command.payload;
  // The status is read, validated and normalised before anything is written, and the gate follows the same value the
  // task will get (§4.2 rule 5: the check and the publish are one transaction, so they cannot disagree about whether
  // this finish publishes at all).
  const status = normalizeFinishStatus(p.status);
  const attempt = executionLease(tx, command, p.attemptId, p.fence);
  if (p.taskRef && (attempt.taskId !== p.taskRef || tx.read(attempt.taskId)?.owner !== command.actor)) fail('TASK_NOT_OWNED');
  if ((p.gate || command.intentProtocol === 'root-decision-v1') && status === 'produced') {
    // §3.3: the one publish gate, dispatched by protocol. Legacy -> the M2b window; v1 -> the explicit coordination
    // block on this revision. The check and the publish are still one transaction.
    assertCoordinationAllows(tx, command, { actor: command.actor, taskRef: attempt.taskId,
      contractRevision: tx.read(attempt.taskId)?.contractRevision });
  }
  const execution=tx.read('execution-current:'+p.attemptId);
  if(execution) {
    const key='execution-finish:'+execution.E.executionEpoch,prior=tx.read(key);
    if(!prior && execution.state!=='OPEN')fail('EXECUTION_NOT_OPEN_FOR_FINISH');
    const result={status,deliveryRef:p.deliveryRef??null,taskLast:p.entry==='tool',gate:p.gate===true || command.intentProtocol === 'root-decision-v1',
      taskRevision:tx.read(attempt.taskId)?.revision??null,contractRevision:tx.read(attempt.taskId)?.contractRevision??null};
    if(prior && JSON.stringify(prior.result)!==JSON.stringify(result))fail('EXECUTION_FINISH_CONFLICT');
    if(!prior)tx.put(key,{E:execution.E,result,state:'requested',requestedBy:command.actor,
      ...(command.intentProtocol === 'root-decision-v1' ? { intentProtocol: command.intentProtocol } : {})});
    return p.entry==='tool'?{...tx.read(attempt.taskId),completionPending:true,targetStatus:status}:{status,completionPending:true};
  }
  releaseAttempt(tx, { attemptId: p.attemptId, fence: p.fence, status, actor: attempt.owner,
    deliveryRef: p.deliveryRef, publish: status === 'produced', taskLast: p.entry === 'tool' });
  // Preserve both existing entries' write ordering and receipt shape.
  return p.entry === 'tool' ? tx.read(attempt.taskId) : { status };
}

/** A verifier's independent evidence is never a certificate: that distinction belongs to the delivery owner. */
function recordEvidence(tx, command) {
  const p = command.payload;
  const current = tx.read(p.deliveryRef);
  if (!current) fail('CAS_CONFLICT:' + p.deliveryRef);
  if (current.owner === command.actor) fail('VERIFIER_NOT_INDEPENDENT');
  if (current.contractRevision !== p.contractRevision) fail('STALE_CONTRACT');
  // The gatherer/publisher checks come first and the gate last (review M2b-7 非阻断: identity and contract validity
  // before the collaboration rule), and the binding is the verifier's own task -- the work it is about to publish --
  // not the producer's task it happens to be judging.
  if (p.gate || command.intentProtocol === 'root-decision-v1') {
    const attempt = executionLease(tx, command, p.attemptId, p.fence);
    assertCoordinationAllows(tx, command, { actor: command.actor, taskRef: attempt.taskId,
      contractRevision: tx.read(attempt.taskId)?.contractRevision });
  }
  return tx.put('verification-evidence:' + p.operationId, { ...p.args, actor: command.actor,
    status: 'evidence-only', certificate: false });
}

function goalIntent(tx, command) {
  const p = command.payload;
  // §5.2.3: a completion request names the goal row it is about. With no record the row is HEAD's (the legacy stance);
  // once a team has a goal, an intent that does not name it would be a completion request nobody can bind.
  const goal = teamGoalIn(tx);
  if (goal && goal.state !== 'open') {
    failWith('TEAM_GOAL_TOO_LATE', 'the team goal is ' + goal.state + '; a completion request needs an open goal');
  }
  return tx.put('goal-intent:' + p.operationId, { ...p.args, actor: command.actor, status: 'intent', completed: false,
    ...(goal ? { teamGoalRef: goal.entityId, goalRevision: goal.revision } : {}) });
}

/**
 * Mechanism 3: the decision log. Ledger only: no outbox entry, no message, no wake. Its reach is the snapshot of the
 * dependency-related members, which is why nothing here may notify anyone.
 */
function decisionLog(tx, command) {
  const p = command.payload;
  for (const ref of p.affects ?? []) if (!tx.read(ref) && !ref.startsWith('member:')) fail('MISSING_REFERENCE:' + ref);
  return tx.put('decision-log:' + p.operationId, { actor: command.actor, summary: p.summary, affects: p.affects ?? [],
    decidedAt: Date.now() });
}

/** Refuse a TaskAccepted wait that would close a cycle through the pending task edges. */
function assertNoDependencyCycle(tx, taskId, target) {
  const edges = tx.list('wait:').filter(wait => wait.status === 'pending' && wait.dependency.kind === 'TaskAccepted');
  const reaches = (node, seen = new Set()) => node === taskId || (!seen.has(node) &&
    (seen.add(node), edges.filter(wait => wait.taskId === node).some(wait => reaches(wait.dependency.taskId, seen))));
  if (reaches(target)) fail('DEPENDENCY_CYCLE:' + target);
}

/**
 * Open a wait. The model path proves a live lease and takes the task from that attempt; the host path names the task
 * directly and may pass a post-completion gate instead of an attempt (Core.wait with gateId).
 */
function openWait(tx, command) {
  const p = command.payload;
  let taskId = p.taskId;
  if (p.deriveTask) taskId = leaseOf(tx, p.attemptId, p.fence).taskId;
  // HEAD's host entry required an attempt row only when no post-completion gate was named, and the row is written with
  // attemptId null in that case: a gate wait never needed an attempt (§7-7).
  else if (!p.gateId && !tx.read(p.attemptId)) fail('UNKNOWN_ATTEMPT');
  if (p.dependency.kind === 'TaskAccepted') assertNoDependencyCycle(tx, taskId, p.dependency.taskId);
  return tx.put(p.waitId, { taskId, attemptId: p.gateId ? null : p.attemptId, postCompletionGateId: p.gateId ?? null,
    dependency: p.dependency, deadline: p.deadline, ...(p.reason ? { reason: p.reason } : {}), status: 'pending' });
}

export const taskCommands = {
  'task.create': createTask,
  'task.approve': approveTask,
  'task.checkpoint': checkpointTask,
  'attempt.finish': finishAttempt,
  'verification.evidence': recordEvidence,
  'goal.intent': goalIntent,
  'decision.log': decisionLog,
  'wait.open': openWait,
};
