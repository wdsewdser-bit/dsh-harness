import { id, fail, failWith } from '../contracts/index.mjs';
import { canonical, digest, validateDependency } from '../contracts/index.mjs';
import { authorize } from './authorization.mjs';
import { recover } from './runtime.mjs';
import { pendingInputs } from './inputs.mjs';
import { assertCapacity, mailboxOrigin, allocateMailbox, borrowCapacityOn, recoverControlCapacity } from './control-capacity.mjs';
export { capacityStatus, capacityUsage, messageHumanOrigin, mintHumanInput, effectTrafficClass, acquireOwnerControl, settleOwnerControl, recoverControlCapacity } from './control-capacity.mjs';
// Gap 3: the provider observation is published beside the local capacity reducer so status, projection and host read
// one classification instead of each inventing its own.
export { PROVIDER_CAPACITY_ROW, PROVIDER_CAPACITY_STATES, PROVIDER_EVIDENCE_TTL_MS, PROVIDER_WINDOW_MS,
  providerCapacity, providerFailureObservation, providerObserver, providerOutcome, providerWait, recordProviderObservation } from './provider-capacity.mjs';
// Public re-exports of the two digest helpers the host delivery close-out needs: the import above already counts as
// the package's one edge into the contracts entry, so naming them here adds no dependency edge.
export { canonical, digest };
import { releaseAttempt as releaseExecution } from './commands/release.mjs';
const SAFE_COMMAND = Symbol('finite-safe-domain-command');
// Commands are data contracts: class methods and accessors are not preserved.
function snapshotCommand(value) {
 const seen = new Set();
 const check = v => {
  if (!v || typeof v !== 'object') return;
  if (seen.has(v)) fail('INVALID_COMMAND'); seen.add(v);
  for (const d of Object.values(Object.getOwnPropertyDescriptors(v))) {
   if (d.get || d.set) fail('INVALID_COMMAND');
   check(d.value);
  }
  seen.delete(v);
 };
 check(value);
 const copy = structuredClone(value);
 const freeze = v => { if (v && typeof v === 'object') { for (const x of Object.values(v)) freeze(x); Object.freeze(v); } return v; };
 return freeze(copy);
}
export { drain, heartbeat, sweepInterruptedClaims } from './runtime.mjs';
export { preStep, recordInjection, requestBoundary, batchPreStep, recordBatchInjection, requestBoundaryBatch, verifyInputBinding, advanceThreadWatermark } from './provenance.mjs';
export { snapshot, batchCandidate, renderBatchText, payloadDigest, BATCH_VERSION, BATCH_TEXT_LIMIT } from './snapshot.mjs';
export { releaseAttempt } from './commands/release.mjs';
export { applyLifecycle } from './native.mjs';
export { recordExecution, openExecutionTurnAlert, canCloseExecution, canFinishStoppedGeneration, consumedStopMatches, consumedGenerationProof, stoppedTransitionMatches, closeExecution, closeStoppedGeneration } from './commands/execution.mjs';
export { GoalGate } from './goal-gate.mjs';
export { RECOVERY_CONTRACT, RECOVERY_GRANT_VIOLATION, createRecoveryScope, recoveryCommands, recoverFacts, systemRecover } from './commands/recovery.mjs';
export { handleTool } from './tools.mjs';
export { authorize, toolDescription, rolePrompt, borrowGuidance } from './authorization.mjs';
// P5 §7.2.5: the host's effect close-out opens the stuck-member row itself, in the same transaction as the member
// transition it justifies, so the opener travels through this entry rather than a deep import (check-deps rule b).
export { openDecision, openUnknownEffect } from './commands/decisions.mjs';
export { PreemptWatcher, MemberInputArbiter, inputPolicy } from './preempt.mjs';
// The read model a projection or a profile records one fact into (P2 §6, P7 §8): published through the entry so
// profiles/context-reader and profiles/native-observations stop deep-importing core/read-model.mjs.
export { recordReadModel } from './read-model.mjs';
// The two operator/browser write translators projections/commands needs: the mailbox verdict and the thread escalation
// are reducers of this package, so a caller reads them through this entry instead of core/mailbox.mjs and core/threads.mjs.
export { submitMailbox } from './mailbox.mjs';
// The stop close-out has one implementation (effects.mjs); the browser gateway reaches it through this entry only.
export { confirmStopped } from './effects.mjs';
export { escalateThread } from './threads.mjs';
// The operator command translator (§WP-C 3): the host's write gateway assembles delivery.adjudicate through it, so it
// is published here rather than deep-imported from core/operator-command.mjs.
export { operatorCommand } from './operator-command.mjs';
export { pendingInputs, orderedInputs, publicBinding, INPUT_KINDS } from './inputs.mjs';
// §3.2 (P1): the resource-thread read model and its paginated event read, published through the package entry so a
// projection or a host gateway reads them without reaching into the module (check-deps rule b).
export { readThreadEvents, resourceThreadView, threadRetention } from './thread-events.mjs';
// The one readiness verdict every consumer must share (core reply/decide, the team_read thread projection and the
// workload fixtures that assert the review ordering). Exported here so a package outside core reads it through
// this entry instead of reaching into the module (check-deps rule b).
export { readiness } from './readiness.mjs';
// P1 of the autonomy design (§3.2.2): the one authority resolver, published through the package entry so a host or a
// profile reads "is the autonomy package on" through the same function the reducers use instead of spelling it again.
export { autonomyOn, autonomySettings, ownerBindingOf, resolveAuthority } from './authority.mjs';
// P6 §8.2.2/§8.2.4: the usage ledger and its display projection, published through the package entry so the adapter
// that measures and the projection that shows an amount never reach into the module (check-deps rule b).
export { recordUsage, usageOf, usageProjection, budgetSettings, pricingOf, unmeasuredOf } from './usage.mjs';
import { expireIntents } from './commands/expire-intents.mjs';
import { normalizeScope } from './scopes.mjs';
import { readiness } from './readiness.mjs';
import { reduceCommand as reduceDomainCommand, assertCas } from './commands/index.mjs';
import { collabOn, collabSettings, intentProtocol } from './collab.mjs';
export { intentProtocol, collabSettings };
import { leaseOf } from './commands/lease.mjs';
import { normalizeFinishStatus } from './commands/tasks.mjs';
import { autonomyOn, autonomySettings } from './authority.mjs';
import { goalGateSettings, goalIdOf } from './commands/goals.mjs';
import { budgetSettings, usageOf, unmeasuredOf } from './usage.mjs';
import { openDecision } from './commands/decisions.mjs';

/**
 * The admission gate as a reducer step (08 §4.1–4.6).
 *
 * It stays in this file on purpose: p3-closure pins the single writer of the start effect to index.mjs (the file that
 * owns the one admission chain), so the reducer that emits 'start' lives here while every other fact lives in
 * commands/. The compose function below is the public reduceCommand, so a host or a tool never has to know that.
 */
/**
 * P6 §8.2.3 / §12 U2: a lasting measurement gap becomes one decision, in the admission's own transaction.
 *
 * It never refuses anything by itself: the admission that found the gap still creates its attempt, because a measurement
 * hole must not stop the team. What root can do about it is budget-unknown: 'continue' restarts the clock, 'stop'
 * refuses new work for that member until a real measurement arrives.
 */
function openUnmeasuredBudget(tx, command, { memberId, tokens, now }) {
  if (!tokens) return null;
  const row = unmeasuredOf(tx, memberId);
  if (!row) return null;
  const grace = Number.isSafeInteger(command.payload?.budgetGraceMs) ? command.payload.budgetGraceMs : 0;
  if (now - row.since < grace) return null;
  const open = tx.list('decision:').find(entry => entry.kind === 'budget-unknown' && entry.state === 'open' &&
    entry.subject?.id === row.entityId);
  if (open) return null;
  return openDecision(tx, { autonomy: 'on', now, decisionTtlMs: command.decisionTtlMs }, {
    kind: 'budget-unknown',
    subject: { type: 'budget', id: row.entityId, revision: row.revision },
    evidence: [{ at: now, kind: 'usage', ref: row.entityId, text: 'no token measurement for ' +
      Math.round(Math.max(0, now - row.since) / 1000) + 's (' + (row.reason ?? 'unmeasured') + ')' }],
    openedFor: 'member:root', fallback: 'stay' });
}

/** An entered native call owns its execution until it has an answer. Read the outbox
 * inside admission's transaction, not its diagnostic mirror. Applying is already a
 * barrier: waiting until it becomes unknown permits the very handover that loses it. */
export function hasUnsettledExecutionEffect(readable, attempt, statuses = ['applying', 'unknown']) {
  const effects = typeof readable.effects === 'function' ? readable.effects() : readable.list('effect:');
  return effects.some(effect => {
    if (!statuses.includes(effect.status)) return false;
    const p = effect.payload ?? {};
    if (!['start', 'dispatch', 'wake', 'message', 'intent-result'].includes(p.kind)) return false;
    const binding = readable.read('effect-execution:' + (effect.id ?? effect.effectId));
    if (binding) return binding.attemptId === attempt.entityId && binding.fence === attempt.fence &&
      binding.generation === attempt.generation && binding.executionSessionId === attempt.executionSessionId;
    if (p.attemptId) return p.attemptId === attempt.entityId;
    const message = p.messageId ? readable.read(p.messageId) : null;
    const memberId = p.kind === 'intent-result' ? message?.sender : p.recipient ?? message?.recipient;
    const generation = p.generation ?? message?.generation;
    return memberId === attempt.owner && (generation === undefined || generation === attempt.generation);
  });
}

// Port authorization must not reject its own applying call. Only admission/release
// and retention use the applying barrier; a port's post-await check still tests unknown.
export function hasUnknownExecutionEffect(readable, attempt) {
  return hasUnsettledExecutionEffect(readable, attempt, ['unknown']);
}

function admitTask(tx, command) {
  const p = command.payload;
  if (!tx.inbox('scheduler', p.eventId)) return { duplicate: true };
  const task = tx.read(p.taskId);
  const member = tx.read(task?.owner);
  // P2: checked transactionally, before mailbox handover, budgets, run slots or dispatch effects.
  if (command.superagentBorrow === 'v1' && (task?.owner === 'member:root' || member?.role === 'root')) fail('ROOT_WORK_ATTEMPT_DENIED');
  if (!task || task.status !== 'ready' || !task.approved || !task.worktreeReady || member?.desired !== 'active') fail('NOT_READY');
  const expected = p.expected ?? {};
  if ((expected.contractRevision !== undefined && expected.contractRevision !== task.contractRevision) ||
    (expected.assignmentEpoch !== undefined && expected.assignmentEpoch !== task.assignmentEpoch)) fail('STALE_ASSIGNMENT');
  if (['create-pending', 'resume-pending', 'cancel-pending', 'dispose-pending', 'unknown'].includes(member.status)) fail('NOT_READY');
  if (tx.list('wait:').some(wait => wait.taskId === p.taskId && wait.status === 'pending')) fail('BLOCKED');
  // Ruling A (F2): a mailbox task is a wake, not a run. The attempt it opens never occupies a work slot, and a member
  // that still holds one when its work task is admitted loses it here, in the same transaction, through the product's
  // own release rule: a wake must never turn into CAPACITY for the work it was only there to announce. The wake is not
  // lost either - whatever the member has not read is still in its mailbox and the next drain asks for a new one.
  // Refuse before any handover write; an active lease does not prove a known effect outcome.
  for (const attempt of tx.list('attempt:')) {
    if (['active', 'unknown'].includes(attempt.lease) && tx.read(attempt.taskId)?.mailboxOnly === true &&
      (attempt.owner === task.owner || attempt.taskId === p.taskId) &&
      (tx.read('execution-current:'+attempt.entityId)?.state !== undefined || hasUnsettledExecutionEffect(tx, attempt))) fail('BLOCKED');
  }
  for (const attempt of tx.list('attempt:')) {
    if (attempt.lease !== 'active' || attempt.owner !== task.owner) continue;
    if (tx.read(attempt.taskId)?.mailboxOnly !== true) continue;
    releaseExecution(tx, { attemptId: attempt.entityId, fence: attempt.fence, status: 'cancelled', actor: attempt.owner,
      reason: 'mailbox wake released so the member can take its work task' });
  }
  // §2.2.4 / review 2 #4: an unknown mailbox attempt is not work capacity, but it still holds the store's one run slot
  // for its owner (run_slots.owner is UNIQUE and an unknown lease keeps its row). Admitting a work attempt over it would
  // pass every domain check and then fail inside the store with a UNIQUE constraint the drain cannot classify, so the
  // isolation is stated as the domain refusal it is: nothing is released without proof, and the same owner or task waits.
  const unknownMailbox = tx.list('attempt:').filter(attempt => attempt.lease === 'unknown' &&
    tx.read(attempt.taskId)?.mailboxOnly === true);
  if (unknownMailbox.some(attempt => attempt.owner === task.owner || attempt.taskId === p.taskId)) fail('BLOCKED');
  const occupied = tx.list('attempt:').filter(attempt => ['active', 'unknown'].includes(attempt.lease) &&
    tx.read(attempt.taskId)?.mailboxOnly !== true);
  const v1 = command.superagentBorrow === 'v1';
  if(v1 && task.mailboxOnly && task.scopeSet.length)fail('DENIED');
  const origin = v1 && task.mailboxOnly ? mailboxOrigin(tx, task) : null;
  const lane = origin ? 'human' : 'normal';
  if (v1) assertCapacity(tx, lane, p.maxRuns);
  else if (occupied.length >= p.maxRuns) fail('CAPACITY');
  if (task.delegationRef && !(v1 && task.mailboxOnly)) {
    const delegation = tx.read(task.delegationRef);
    // §8.2.3 / appendix 6: with the switch on, this admission is decided by the three units the budget really has.
    const autonomy = command.autonomy === 'on';
    // The count, the decision and the attempt write are one transaction: the running set is read here, microseconds
    // before the attempt row is written below, so two admissions can never both pass a check taken outside a
    // transaction. (The mutation "read the count before the transaction" is what this placement exists to fail.)
    const running = occupied.filter(attempt => tx.read(attempt.taskId)?.delegationRef === task.delegationRef).length;
    if (!delegation || Date.parse(delegation.expiresAt) <= p.now || running >= delegation.budget.concurrency) {
      if (autonomy) {
        failWith('DELEGATION_CONCURRENCY', 'delegation ' + task.delegationRef + ' already holds ' + running + ' of its ' +
          delegation?.budget?.concurrency + ' concurrent slots (or has expired); the attempt was not created');
      }
      fail('CAPACITY');
    }
    if (autonomy) {
      const tokens = delegation.budget.tokens ?? null;
      if (unmeasuredOf(tx, task.owner)?.stopped === true) {
        failWith('DELEGATION_TOKEN_BUDGET', 'root stopped new work for ' + task.owner + ' while its token usage is ' +
          'unmeasured; a real measurement lifts the stop');
      }
      const usage = usageOf(tx, { delegationRef: task.delegationRef });
      if (tokens && !usage.unknown) {
        const over = [];
        if (Number.isSafeInteger(tokens.inputLimit) && usage.input > tokens.inputLimit) over.push('input ' + usage.input + '>' + tokens.inputLimit);
        if (Number.isSafeInteger(tokens.outputLimit) && usage.output > tokens.outputLimit) over.push('output ' + usage.output + '>' + tokens.outputLimit);
        if (over.length > 0) {
          failWith('DELEGATION_TOKEN_BUDGET', 'delegation ' + task.delegationRef + ' is over its token budget (' +
            over.join(', ') + '); a running turn is never interrupted, and only new work is refused');
        }
      }
      // §8.2.3 / §12 U2: an unmeasured count never stops the team. Past the grace period it becomes a decision, in
      // this same transaction, and the admission itself goes ahead.
      openUnmeasuredBudget(tx, command, { memberId: task.owner, tokens, now: p.now });
    } else {
      const cost = task.estimatedCost ?? 1;
      if (cost < 0 || !Number.isFinite(cost) || (delegation.spent ?? 0) + cost > delegation.budget.cost) fail('DELEGATION_COST');
      tx.put(delegation.entityId, { ...delegation, spent: (delegation.spent ?? 0) + cost });
    }
  }
  if ((v1 ? tx.list('attempt:').filter(a=>['active','unknown'].includes(a.lease)) : occupied).some(attempt => attempt.owner === task.owner || attempt.taskId === p.taskId ||
    attempt.scopeSet.some(scope => task.scopeSet.some(target => scope === target || scope.startsWith(target + '/') ||
      target.startsWith(scope + '/'))))) fail('CAPACITY');
  const attemptId = 'attempt:' + id('attempt');
  const fence = (task.lastFence ?? 0) + 1;
  if(origin)allocateMailbox(tx,{teamId:command.teamId??'team',attemptId,origin});
  tx.put(attemptId, { taskId: p.taskId, owner: task.owner, status: 'admitted', lease: 'active', fence,
    generation: member.generation, expiresAt: p.now + 60000, scopeSet: task.scopeSet, admittedAt: p.now,
    ...(v1 ? { runClass:origin?'human-mailbox':task.mailboxOnly?'mailbox':'work',capacityLane:lane,humanOriginRef:origin?.entityId??null } : {}) });
  tx.put(p.taskId, { ...task, status: 'executing', attemptId, lastFence: fence });
  tx.outbox(attemptId, { kind: 'start', attemptId, owner: task.owner, generation: member.generation, fence });
  // The journal head as this transaction sees it, read here where HEAD read store.latestEventSeq(): the delegation,
  // attempt and task writes above are already in the journal on this connection (docs/decisions/M2a-shared-reducer.md §7-4).
  tx.cursor('scheduler', tx.latestEventSeq());
  tx.put('scheduler', { eventId: p.eventId, onlyAdmissionChain: true });
  return { attemptId, fence };
}

/**
 * The public transactional reducer: every domain command, including the admission gate.
 *
 * CAS is a property of the command, not of one reducer: this one pre-step covers the domain table and the admission
 * gate alike, and no reducer repeats it (docs/decisions/M2a-shared-reducer.md §7-5).
 */
export function reduceCommand(tx, command) {
  if (!command || typeof command.type !== 'string') fail('INVALID_COMMAND');
  if (command.cas) assertCas(tx, command.cas);
  if (command.superagentBorrow === 'v1') {
    const attempt=tx.read(command.payload?.attemptId);
    if(attempt?.runClass==='human-mailbox' && command.type==='attempt.finish' && command.payload.status==='produced')fail('ROLE_GUARD_DENIED');
  }
  if (command.type === 'schedule.admit') return admitTask(tx, command);
  if (command.type === 'attempt.release') {
    const p = command.payload;
    if (Object.keys(p).some(k => !['attemptId', 'fence', 'status', 'evidenceRef', 'revoked', 'reason'].includes(k)) || !['cancelled', 'failed'].includes(p.status)) fail('DENIED');
    return releaseExecution(tx, { ...p, actor: command.actor });
  }
  return reduceDomainCommand(tx, command);
}

/** Drive the offline domain through one event admission path; 08 §4.1–4.6. */
export class TeamCore {
  constructor(store, ports = {}, configuration = {}) {
    this.store = store;
    this.ports = ports;
    // intentWindowMs is the objection window of an intent (host-protocol §4.2, §7.1 3(a)): five minutes as a
    // configurable initial value, computed here and never taken from the model.
    this.configuration = { enabled: false, subCoordinatorMinWorkers: 6, maxRuns: 30, lifecycleIntentTimeoutMs: 120000,
      intentWindowMs: 5 * 60 * 1000, ...configuration };
    this.recovered = true;
    if (borrowCapacityOn(this) && !configuration.attach && store.list('control-slot:').some(s=>s.state!=='released')) {
      this.mutate('control-recovery','adapter',{},tx=>recoverControlCapacity(tx,Date.now()));
    }
    /** Set by the profile (packages/core/preempt.mjs); absent means "no instant preemption installed". */
    this.notifyDelivery = undefined;
    if (this.configuration.enabled && !configuration.attach && (store.list('attempt:').length || store.effects().some(e => e.status === 'applying') ||
      store.list('member-intent:').some(i => i.status === 'applying'))) {
      this.recovered = false;
      recover(this);
    }
  }
  /**
   * Build one command. teamId comes from the configuration, never from a literal (design §4.1: one database per
   * team). now, when supplied, is execution metadata carried beside the payload: it must not enter the stable
   * identity, or every replay at a different instant would look like a conflict (design §3.6).
   */
  command(entityId, actor, payload, operationId = id('operation'), meta = {}) {
    return { entityId, teamId: this.configuration.teamId ?? 'team', actor, payload, operationId,
      expectedRevision: this.store.read(entityId)?.revision ?? 0, payloadHash: digest(payload),
      ...(meta.now === undefined ? {} : { now: meta.now }) };
  }
  /**
   * One transaction, one admission gate: completion fence, reference authorization, then the reducer body.
   * Every write entry in this class goes through here or through mutate(); nothing calls store.commit twice.
   */
  execute(entityId, actor, payload, reduce, meta = {}) {
    if (!this.configuration.enabled) fail('TEAM_DISABLED');
    // A missing entity id is a caller mistake, never a reducer concern: without this the reducer would read
    // null and surface a TypeError instead of a business refusal with a remedy.
    if (typeof entityId !== 'string' || !entityId) failWith('INVALID_ENTITY', 'a durable id is required; got ' + JSON.stringify(entityId));
    authorize(this, actor, entityId);
    // The operation identity is the caller's durable request identity, not a fresh id per write: the gateway passes
    // the authenticated operationId as trusted metadata, and a replay after a restart must reach the same operation
    // record. Only an internal caller without one gets a generated id.
    const operationId = typeof meta.operationId === 'string' && meta.operationId ? meta.operationId : id('operation');
    return this.store.commit(this.command(entityId, actor, payload, operationId, meta), (tx, current) => {
      const frozen = tx.list('completion:').some(t => ['prepared', 'authorized', 'unknown'].includes(t.status));
      if (frozen && !meta[SAFE_COMMAND] && !/^(completion:|inconsistency:)/.test(entityId)) fail('COMPLETION_FROZEN');
      // The operation identity travels with the reducer call: it is execution metadata (never business data, so it is
      // not part of the payload hash), and a fact that records what a command decided needs to name the command.
      return reduce(tx, current, operationId);
    });
  }
  /** Translate a request into a domain command and run it in one transaction. */
  dispatch(entityId, actor, payload, command, meta = {}) {
    command = snapshotCommand(command);
    const now = meta.now ?? this.configuration.now?.() ?? Date.now();
    // §10 P1 / §2.2.5 item 2: the decision channel is the autonomy package's operator-class command, and it is the one
    // new entry that has to run while a completion token freezes the team -- adjudicating that token is what unfreezes
    // it (§12 U7, A9). It is not a general bypass: the flag is attached to exactly these two command types, only while
    // the switch is on, and the verdict then runs behind the restricted transaction in commands/decisions.mjs, so it
    // cannot touch a row the decision did not name. Every other new entry stays behind the freeze.
    const autonomy = autonomySettings(this);
    const safe = (command.type === 'system.recover' && actor === 'scheduler' && entityId === 'runtime') ||
      (command.type === 'clock.expire-attempts' && actor === 'scheduler' && entityId === 'clock') ||
      (command.type === 'attempt.release' && entityId === command.payload.attemptId) ||
      (autonomy.autonomy === 'on' && actor === 'adapter' && ['execution.record','execution.close'].includes(command.type)) ||
      (autonomy.autonomy === 'on' && command.type === 'decision.decide' && entityId === command.payload.decisionId) ||
      (autonomy.autonomy === 'on' && command.type === 'execution.reopen-decision' && entityId === 'execution-alert:'+command.payload.E?.executionEpoch) ||
      (autonomy.autonomy === 'on' && command.type === 'decision.expire' && actor === 'scheduler' && entityId === 'clock');
    // autonomy and decisionTtlMs ride beside the payload, like now: they are trusted-entry metadata, not business
    // data, so they never enter the operation identity and a request can neither switch the package on nor move a TTL.
    // The intent protocol, the registered repositories and the per-resource event limit ride beside the payload for the
    // same reason autonomy does: they are trusted-entry metadata (§3.1, §3.3), so a request cannot choose the protocol it
    // is judged under, the repository a resource belongs to, or how much backlog it is allowed to create.
    const borrow = { superagentBorrow: this.configuration.superagentBorrow ?? 'off', intentProtocol: intentProtocol(this), repositories: this.configuration.repositories ?? [],
      threadEventLimit: this.configuration.threadEventLimit };
    return this.execute(entityId, actor, payload, (tx, current, operationId) => reduceCommand(tx, { ...command, actor,
      now, operationId, teamId:this.configuration.teamId??'team', autonomy: autonomy.autonomy, decisionTtlMs: autonomy.decisionTtlMs,
      goalGate: goalGateSettings(this), ...borrow }),
      { ...meta, now, [SAFE_COMMAND]: safe });
  }
  /** Escape hatch for the adapters that own a fact with no command type yet (goal gate, native, recovery). */
  mutate(entityId, actor, payload, reducer, meta = {}) {
    return this.execute(entityId, actor, payload, (tx, current) => reducer(tx, current), meta);
  }
  // Receipt/recovery facts only. No model command exposes this trusted adapter outlet.
  controlFact(entityId, payload, reducer) {
    // provider-capacity is the gap-3 observation fact: a receipt/recovery fact with no model command, like the rest.
    if(!/^(control-slot:|control-recovery|effect-io:|provider-capacity:)/.test(entityId))fail('DENIED');
    return this.execute(entityId,'adapter',payload,reducer,{[SAFE_COMMAND]:true});
  }
  authority(attemptId, fence, now = Date.now()) {
    return leaseOf({ read: entityId => this.store.read(entityId) }, attemptId, fence, now);
  }
  memberLimits() {
    return { maxMembers: 30, subCoordinatorMinWorkers: this.configuration.subCoordinatorMinWorkers,
      maxSubCoordinators: 8, maxPerGroup: 8 };
  }
  member(memberId, role, group = 'default') {
    return this.dispatch(memberId, 'root', { role, group },
      { type: 'member.create', payload: { memberId, role, group, limits: this.memberLimits() } });
  }
  task(taskId, owner, scopeSet = [], extra = {}) {
    const scopes = scopeSet.map(normalizeScope);
    return this.dispatch(taskId, 'root', { owner, scopeSet: scopes, ...extra },
      { type: 'task.create', payload: { mode: 'assignment', taskId, owner, scopeSet: scopes, extra } });
  }
  schedule(eventId, taskId, now = Date.now(), expected = {}) {
    if (!this.recovered) fail('RECOVERY_REQUIRED');
    return this.dispatch('scheduler', 'scheduler', { eventId, taskId, expected }, { type: 'schedule.admit',
      payload: { eventId, taskId, now, expected, maxRuns: this.configuration.maxRuns,
        budgetGraceMs: budgetSettings(this).unknownGraceMs } }, { now });
  }
  finish(attemptId, fence, status = 'produced') {
    // One normalisation, shared with the reducer (commands/tasks.mjs): the entry and the write cannot read "no status"
    // differently. An unknown status -- including an explicit null -- is refused here, before any transaction opens,
    // so the attempt, the task and the waits are untouched.
    const finalStatus = normalizeFinishStatus(status);
    const attempt = this.authority(attemptId, fence);
    // The host publish path passes the same in-transaction gate the model path passes (§4.2 rule 5); with the switch
    // off it is not even asked, so the control arm is unchanged.
    //
    // The gate guards publishing, not withdrawing: a cancel or a failure closes the authorisation without putting work
    // in front of anyone, and §4.2 rule 3 makes withdrawal a separate act that also drops the pending work, not a gate
    // of its own. Gating every status would have demanded an intent to stop -- the teardown of a team that never
    // announced anything.
    const publishes = finalStatus === 'produced';
    return this.dispatch(attemptId, attempt.owner, { fence, status: finalStatus },
      { type: 'attempt.finish', payload: { attemptId, fence, status: finalStatus, gate: collabOn(this) && publishes } });
  }
  /**
   * Send a message, or open an intent window.
   *
   * An intent names the downstream set it binds and the contract revision it announces; its window length comes from
   * the server configuration and no deadline is accepted from the caller (§4.2 rules 1–2, §4.3).
   */
  send(sender, recipient, kind, summary, extra = {}) {
    const messageId = 'message:' + id('message');
    const intent = kind === 'intent';
    const targets = Array.isArray(recipient) ? recipient : [recipient];
    const receipt = this.dispatch(messageId, sender, { recipient, kind, summary, ...extra }, { type: 'message.send',
      payload: { messageId, to: recipient, kind, summary, bodyRef: extra.bodyRef, taskRef: extra.taskRef,
        threadRef: extra.threadRef, expectedOutcome: extra.expectedOutcome,
        contractRevision: extra.contractRevision, deadline: intent ? undefined : extra.deadline,
        // One window setting for both entries: the bounded value collabSettings exposes, not raw configuration. A v1
        // intent has no window at all (§3.3), so the entry does not carry one for it.
        windowMs: intent && intentProtocol(this) !== 'root-decision-v1' ? collabSettings(this).intentWindowMs : undefined,
        ...(intent && intentProtocol(this) === 'root-decision-v1' ? { reason: extra.reason,
          evidenceRefs: extra.evidenceRefs, previousDecisionId: extra.previousDecisionId } : {}),
        extra, requireSender: true } });
    // Announced after the commit, never inside it: a listener that preempts re-enters the driver, and a
    // rolled-back send must not wake anyone.
    for (const target of targets) this.notifyDelivery?.(target, receipt.result?.entityId ?? messageId);
    return receipt;
  }
  /**
   * Answer an intent: one vote per legal recipient, decided by the window (host-protocol §4.3).
   *
   * The name is explicit because the class already had a reply -- the thread reply -- and a second method of the same
   * name silently replaced it: the intent answer would have run the thread reducer, and the thread answer would have
   * looked up a message. Two facts, two names.
   */
  replyIntent(messageId, actor, verdict, reason = null) {
    return this.dispatch(messageId, actor, { verdict, reason },
      { type: 'message.reply', payload: { messageId, verdict, reason } });
  }
  pending(memberId) {
    const closed = ['resolved', 'cancelled', 'expired', 'escalated', 'dead-letter', 'unknown'];
    const generation = this.store.read(memberId)?.generation;
    return this.store.list('message:').filter(message => {
      // An intent is addressed to a set, bound per recipient to that recipient's generation, and it leaves the mailbox
      // once its window closed: a conclusion is not work to accept.
      if (message.kind === 'intent') {
        return message.status === 'open' && (message.recipients ?? []).includes(memberId) &&
          (message.generations?.[memberId] ?? null) === generation;
      }
      return message.recipient === memberId && message.generation === generation && !closed.includes(message.status);
    });
  }
  ready(memberId) {
    if (this.configuration.superagentBorrow === 'v1') return pendingInputs(this, memberId).bindings.some(b => b.messageKind !== 'info');
    return this.pending(memberId).some(message => message.kind !== 'info' &&
      (message.kind === 'intent' ? !message.visibility?.[memberId] : !message.visible));
  }
  /**
   * Record that a message was really in a request (invariant 8). The evidence names the manifest the request carried
   * and the instant the request started; the reducer refuses anything that is not bound to the current generation.
   */
  visible(messageId, observation, recipient = null) {
    // A visible fact has to say when the request started, or it cannot be binned against the closing instant. Guessing
    // the time would put an unprovable request into the history (§4.4 classes 1-3), so the trusted entry refuses it.
    if (!observation.requestId || !observation.manifestHash || !Number.isInteger(observation.sessionSeq) ||
      !Number.isFinite(observation.requestedAt)) fail('MISSING_REQUEST_EVIDENCE');
    const message = this.store.read(messageId);
    return this.dispatch(messageId, 'adapter', observation,
      { type: 'message.visible', payload: { messageId, recipient: recipient ?? message?.recipient ?? null,
        evidence: { requestId: observation.requestId, manifestHash: observation.manifestHash,
          sessionSeq: observation.sessionSeq, requestedAt: observation.requestedAt ?? null } } });
  }
  accept(messageId, attemptId, fence, checkpointRef) {
    const attempt = this.authority(attemptId, fence);
    return this.dispatch(messageId, attempt.owner, { attemptId, fence, checkpointRef },
      { type: 'message.accept', payload: { messageId, attemptId, fence, checkpointRef } });
  }
  /**
   * The owner path of §3: the team owner takes up a responsibility addressed to it, with no attempt and no fence.
   *
   * This is not a second accept: the same reducer runs, the same visibility rule applies and the same row is written;
   * only the authority differs, and it is selected here by the trusted entry (never by the caller) and then verified
   * against the member row inside the transaction.
   */
  acceptAsOwner(messageId, memberId, extra = {}) {
    return this.dispatch(messageId, memberId, { checkpointRef: null, ...extra },
      { type: 'message.accept', policy: { authority: 'owner' },
        payload: { messageId, attemptId: null, fence: null, checkpointRef: null } });
  }
  /** The owner closes a responsibility it took up through the owner path (§3.2.3). */
  resolveAsOwner(messageId, memberId, resultRef) {
    return this.dispatch(messageId, memberId, { resultRef },
      { type: 'message.resolve', policy: { authority: 'owner' },
        payload: { messageId, attemptId: null, fence: null, resultRef } });
  }
  /**
   * Adjudicate one decision row (§2.2.2). entry says which channel this caller is -- 'owner' for the team owner,
   * 'operator' for the principal beside it (§12 U7) -- and neither is believed: the reducer re-checks the row.
   */
  /** Root/owner or authenticated operator renews only an expired E-bound turn-fault decision. */
  reopenExecutionTurnDecision(E,actor,{previousDecisionId,reason},entry='owner') {
    const payload={E,previousDecisionId,reason};
    return this.dispatch('execution-alert:'+E?.executionEpoch,actor,payload,
      {type:'execution.reopen-decision',entityId:'execution-alert:'+E?.executionEpoch,policy:{authority:entry},payload});
  }
  decideDecision(decisionId, actor, verdict, entry = 'owner', trusted = {}) {
    const payload = { decisionId, decision: verdict.decision, reason: verdict.reason ?? null,
      evidenceRef: verdict.evidenceRef ?? null };
    // trusted carries what only the hosting process can prove: the journal readback behind a completion verdict (§12
    // U7 -- root may decide a completion, but only on log evidence) and the goal row a consumed completion closes. It
    // is entry metadata like policy/now: it never enters the operation identity, and a request cannot supply it.
    return this.dispatch(decisionId, actor, payload,
      { type: 'decision.decide', policy: { authority: entry }, journal: trusted.journal ?? null,
        teamGoalId: goalIdOf(this), payload });
  }
  wait(taskId, attemptId, dependency, deadline, gateId = null) {
    validateDependency(dependency);
    const waitId = 'wait:' + id('dependency');
    return this.dispatch(waitId, 'dependency', { dependency, deadline },
      { type: 'wait.open', payload: { waitId, taskId, attemptId, gateId, dependency, deadline } });
  }
  /**
   * Dependency resolution matches waits by digest of the typed dependency. It stays a mutate() reducer here because
   * digest comes from the contracts entry, and reaching for another module from commands/ would add a dependency-check
   * violation (docs/decisions/M2a-shared-reducer.md §5). One transaction, one implementation either way.
   */
  resolveDependency(dependency, evidenceRef) {
    return this.mutate('dependency-events', 'dependency', { dependency, evidenceRef }, tx => {
      for (const wait of tx.list('wait:')) {
        if (wait.status === 'pending' && digest(wait.dependency) === digest(dependency)) {
          tx.put(wait.entityId, { ...wait, status: 'satisfied', resolutionEvidence: evidenceRef });
        }
      }
      return tx.put('dependency-events', { dependency, evidenceRef });
    });
  }
  /**
   * Open a thread. requiredEvidence names the non-late reply bodyRefs the thread must record before the owner may
   * decide; a review issue needs one reply per reviewed delivery, not one reply per respondent.
   */
  thread(owner, requiredRespondents, question, deadline, escalationOwner = 'operator', requiredEvidence = []) {
    const issueId = 'thread:' + id('issue');
    return this.dispatch(issueId, owner, { question, deadline }, { type: 'thread.open',
      payload: { issueId, owner, requiredRespondents, requiredEvidence, question, deadline, escalationOwner } });
  }
  reply(issueId, actor, proposalRevision, bodyRef) {
    // A reply to a thread that does not exist yet is a real ordering case (the verifier can finish before root
    // opened the issue), so it must answer with a business error that says how to get a thread, not crash.
    if (!issueId) failWith('UNKNOWN_THREAD', 'reply needs the issue thread id; read one with team_read {view:"thread"} ' +
      'or open it first with real_work open');
    if (!this.store.read(issueId)) failWith('UNKNOWN_THREAD', 'no thread "' + issueId + '"; open the review issue first ' +
      '(real_work open) or read an existing one with team_read {view:"thread"}');
    return this.dispatch(issueId, actor, { proposalRevision, bodyRef },
      { type: 'thread.reply', payload: { issueId, proposalRevision, bodyRef } });
  }
  decide(issueId, actor, proposalRevision, conclusionRef) {
    if (!issueId) failWith('UNKNOWN_THREAD', 'decide needs the issue thread id; read one with team_read {view:"thread"}');
    if (!this.store.read(issueId)) failWith('UNKNOWN_THREAD', 'no thread "' + issueId + '"; open the review issue first ' +
      '(real_work open) or read an existing one with team_read {view:"thread"}');
    return this.dispatch(issueId, actor, { proposalRevision, conclusionRef },
      // The host entry carries the same trusted gate marker the tool path carries: §4.2 rule 5 covers every public
      // entry, and a decision publishes work exactly like produce does.
      { type: 'thread.decide', payload: { issueId, proposalRevision, conclusionRef, gate: collabOn(this) } });
  }
  /** Everything the clock has run out of time on. With the autonomy package off this is exactly HEAD's predicate. */
  isDue(now) {
    return this.clockDue(now) || this.decisionsDue(now);
  }
  clockDue(now) {
    return this.store.list('attempt:').some(a => a.lease === 'active' && a.expiresAt <= now) ||
      this.store.list('member-intent:').some(i => ['intent', 'applying'].includes(i.status) && now - (i.createdAt ?? now) >= this.configuration.lifecycleIntentTimeoutMs) ||
      // A v1 intent has no window (closesAt is null), and null <= now is true: without the finite check the clock
      // would consider the team due forever and tick on every pass.
      this.store.list('message:').some(m => m.kind === 'intent' && m.status === 'open' && Number.isFinite(m.closesAt) &&
        m.closesAt <= now) ||
      ['thread:', 'message:', 'wait:'].some(prefix => this.store.list(prefix).some(e => e.deadline && Date.parse(e.deadline) <= now && ['collecting', 'stored', 'visible', 'pending'].includes(e.status)));
  }
  /** §12 U8: an open decision row past its TTL is due. Nothing else about it is due -- expiry changes no domain row. */
  decisionsDue(now) {
    return autonomyOn(this) && this.store.list('decision:').some(row => row.state === 'open' &&
      Number.isFinite(row.expiresAt) && row.expiresAt <= now);
  }
  tick(now) {
    if (!this.isDue(now)) return null;
    // The expiry sweep is its own safe command: the TTL must not be suspended by the very freeze a decision may be
    // there to adjudicate, and it writes nothing but decision and audit rows.
    const expiry = this.decisionsDue(now)
      ? this.dispatch('clock', 'scheduler', { now, sweep: 'decision' },
        { type: 'decision.expire', payload: { now } }, { now })
      : null;
    if (!this.clockDue(now)) return expiry;
    return this.dispatch('clock', 'scheduler', {}, { type: 'clock.tick',
      now, payload: { timeoutMs: this.configuration.lifecycleIntentTimeoutMs } }, { now });
  }
}
