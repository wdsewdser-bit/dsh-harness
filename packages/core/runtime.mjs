import { id, fail } from '../contracts/index.mjs';
import { pendingInputs } from './inputs.mjs';

/**
 * The cold-start transition and the two admission-side steps that must follow it; 08 §2.2, §4.2, design §3.5.1, §3.8.
 *
 * system.recover itself is a domain command now (commands/recovery.mjs): the host runs it through its recovery
 * capability, and this module keeps only the parts that belong to TeamCore - the sweep that follows it in the same
 * pass, plus the offline driver's drain and heartbeat.
 */
export { recoverFacts } from './commands/recovery.mjs';

/** Recover fences before enabling the sole durable event consumer; 08 §2.2, §4.2. */
export function recover(core) {
  const receipt = core.dispatch('runtime', 'scheduler', { recovery: true }, { type: 'system.recover', payload: {} });
  sweepInterruptedClaims(core);
  core.recovered = true;
  return receipt.result ?? null;
}

/**
 * Only an applying claim whose expiry has already passed is swept; design §3.5.1. It runs in the same recovery pass
 * (both entries below call it immediately after system.recover), which is why it may use the interrupt horizon rather
 * than the wall clock: an interrupted claim is interrupted however long ago it expired.
 */
export function sweepInterruptedClaims(core, now = Number.MAX_SAFE_INTEGER) {
  return core.store.reconcile(core.command('recovery', 'scheduler', {}), now);
}

/**
 * CAS_CONFLICT is the optimistic-retry signal a concurrent writer raises: it rewrites a row between the read that
 * built a command's expectedRevision and that command's commit. Two drains of one team in two processes do exactly
 * that to the same wake row (each recomputes its mailboxMessages), so a pass must answer it the way §8.2.3 answers
 * every other refusal: read again, decide again, and if the race is lost again, count the candidate and go on. It is
 * never a crash that leaves the candidates behind it unattempted -- that is how a mailbox (H) allocation gets dropped
 * from a whole pass while the normal (N) lane keeps its slot.
 */
const DRAIN_CONFLICT_ATTEMPTS = 3;

/**
 * v1 FIFO positions are journal seqs written when a task enters ready. A store written before that field existed has
 * tasks without one, and createdAt milliseconds are not comparable with journal seqs: mixing the two units lets a new
 * task jump every old one. Before the first v1 drain, recover each such task's current ready episode from the retained
 * history and write it as a position in the same unit, oldest first. If the history no longer contains a task's ready
 * transition, its queue age cannot be established and the pass refuses (READY_ORDER_UNRECOVERABLE) rather than guess.
 */
export function backfillReadyOrder(core) {
  if (!core.store.list('task:').some(t => t.status === 'ready' && !Number.isSafeInteger(t.readySeq))) return 0;
  const receipt = core.mutate('ready-order-backfill', 'scheduler', {}, tx => {
    // The preflight above is only an optimization: tasks and history used to decide/write are read under the SAME lock.
    const pending = tx.list('task:').filter(t => t.status === 'ready' && !Number.isSafeInteger(t.readySeq));
    const histories = new Map(pending.map(t => [t.entityId, new Map()]));
    for (const event of tx.scanEvents()) {
      histories.get(event.entity)?.set(event.revision, event);
    }
    for (const task of pending) {
      const history = histories.get(task.entityId);
      let entry = null;
      for (let revision = task.revision; revision >= 1; revision--) {
        const event = history.get(revision);
        if (!event) fail('READY_ORDER_UNRECOVERABLE', 'missing task revision: ' + task.entityId + ':' + revision);
        if (event.payload?.status !== 'ready') break;
        entry = event;
        // A revision-1 ready creation or a contiguous non-ready predecessor proves the current episode's start.
      }
      if (!entry) fail('READY_ORDER_UNRECOVERABLE', 'ready task without a proven transition: ' + task.entityId);
      tx.put(task.entityId, { ...task, readySeq: entry.seq });
    }
    return { backfilled: pending.length };
  });
  return receipt.result.backfilled;
}
/** Synchronous admission decisions, never lifecycle intents or external IO. */
export function drain(core, now = Date.now()) {
  if (!core.recovered) fail('RECOVERY_REQUIRED');
  const outcomes = []; let rejected = 0; const rejections = [];
  const events = core.store.events(core.store.cursor('dispatch')).filter(e => /^(task:|message:)/.test(e.entity));
  // §8.2.3: the two budget refusals an admission may answer with are scheduling answers like the rest -- one limited
  // delegation must not stop the drain from admitting the healthy candidates behind it (and must be countable, not a
  // crash that leaves every later candidate unattempted).
  const blocked = new Set(['CAPACITY', 'BLOCKED', 'NOT_READY', 'DELEGATION_COST', 'STALE_ASSIGNMENT', 'COMPLETION_FROZEN',
    'DELEGATION_CONCURRENCY', 'DELEGATION_TOKEN_BUDGET', 'CAPACITY_UNKNOWN']);
  const conflicted = code => String(code ?? '').startsWith('CAS_CONFLICT');
  // Every attempt re-reads its row before it builds the command, so a retry decides on the revision that is current now.
  const decide = run => {
    for (let attempt = 1; ; attempt++) {
      try { return run(); }
      catch (error) {
        const code = error.code ?? error.message;
        if (attempt >= DRAIN_CONFLICT_ATTEMPTS || !conflicted(code)) throw error;
      }
    }
  };
  const candidates = new Set(core.store.list('task:').filter(t => t.status === 'ready').map(t => t.entityId));
  for (const member of core.store.list('member:')) {
    if (core.configuration.superagentBorrow === 'v1' && member.role === 'root') continue;
    if (member.desired !== 'active' || !core.ready(member.entityId)) continue;
    if (core.store.list('attempt:').some(a => a.owner === member.entityId && ['active', 'unknown'].includes(a.lease))) continue;
    const taskId = 'task:mail-' + member.entityId;
    // Identity is the recipient's responsibility binding, not the message's durable row id.
    // A legal rebind keeps messageId while advancing generation/bindingGeneration.
    const bindingKey = m => JSON.stringify([m.entityId, member.entityId,
      m.kind === 'intent' ? m.generations?.[member.entityId] : m.generation,
      m.kind === 'intent' ? (m.bindingGenerations?.[member.entityId] ?? 0) : (m.bindingGeneration ?? 0)]);
    // Delivery decisions survive a finished attempt too: the same open intent must not admit twice
    // merely because the first execution returned without a visibility receipt. F2 ruling A keeps this rule exactly:
    // a released wake is not renewed, and the next drain asks for a new one only for mail this member has not already
    // been woken for (a new binding) - the ordinary rule decides, never a lease that is held open.
    // The wake row and the delivered set are re-read on each attempt: a competing drain writes the same row.
    const wake = () => {
      const prior = core.store.read(taskId);
      const delivered = prior?.mailboxMessages ?? [];
      const pending = core.configuration.superagentBorrow === 'v1'
        ? pendingInputs(core, member.entityId).bindings.filter(b => b.messageKind !== 'info').map(b => ({
          entityId: b.ref, generation: b.generation, bindingGeneration: b.bindingEpoch })).filter(m => !delivered.includes(bindingKey(m)))
        : core.pending(member.entityId).filter(m => m.kind !== 'info' && !delivered.includes(bindingKey(m)));
      if (!pending.length || prior?.status === 'executing') return false;
      core.task(taskId, member.entityId, [], { mailboxOnly: true,
        mailboxMessages: [...delivered, ...pending.map(bindingKey)] });
      return true;
    };
    try { if (decide(wake)) candidates.add(taskId); }
    catch (error) {
      const code = error.code ?? error.message;
      if (!conflicted(code)) throw error;
      rejected++; rejections.push({ taskId, code });
    }
  }
  let orderedCandidates=[...candidates];
  if(core.configuration.superagentBorrow==='v1'){
    // Order by the durable queue position written into the row when it entered ready, not by the task ID and not by
    // a journal transition: retention may collect old versions of a live row, so the order must not depend on history.
    // Re-entering ready writes a new readySeq (tail); changing unrelated fields while ready carries the old one.
    // Legacy rows get their position from retained history once, before the first v1 drain (same unit, no createdAt).
    backfillReadyOrder(core);
    const readyAt=id=>{const row=core.store.read(id);
      if(!Number.isSafeInteger(row?.readySeq))fail('READY_ORDER_UNRECOVERABLE', 'ready task without a queue position: '+id);
      return row.readySeq;};
    orderedCandidates.sort((a,b)=>readyAt(a)-readyAt(b)||a.localeCompare(b));
  }
  for (const taskId of orderedCandidates) {
    try {
      outcomes.push(decide(() => {
        const task = core.store.read(taskId);
        return core.schedule(id('event'), taskId, now,
          { contractRevision: task?.contractRevision, assignmentEpoch: task?.assignmentEpoch }).result;
      }));
    }
    catch (error) {
      const code = error.code ?? error.message;
      if (!blocked.has(code) && !conflicted(code)) { if (error && typeof error === 'object') error.taskId = taskId; throw error; }
      rejected++; rejections.push({ taskId, code });
    }
  }
  // Cursor-only commit emits no journal. Internal prefixes never become input.
  if (events.length) core.mutate('dispatch-cursor', 'scheduler', { seq: events.at(-1).seq }, tx => {
    tx.cursor('dispatch', events.at(-1).seq); return { consumed: events.length };
  });
  Object.defineProperties(outcomes, { consumed: { value: events.length }, rejected: { value: rejected },
    rejections: { value: rejections } });
  return outcomes;
}

/** Extend only the current execution authorization; 08 §4.2. */
export function heartbeat(core, attemptId, fence, now = Date.now()) {
  const attempt = core.authority(attemptId, fence, now);
  return core.mutate(attemptId, attempt.owner, { fence }, tx => {
    const current = core.authority(attemptId, fence, now);
    return tx.put(attemptId, { ...current, heartbeat: now, expiresAt: now + 60000 });
  }, { now });
}
