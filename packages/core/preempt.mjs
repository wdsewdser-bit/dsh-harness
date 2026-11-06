import { noteAssistantFrame, hasCompletedResponse } from './preempt-completion.mjs';

/**
 * Step-level preemption of a live member turn (instant-preempt, phase 1).
 *
 * Codex preempts at the same seam this module targets: between two stream reads of the current step, not at a
 * token boundary and never by ending the turn (turn.rs:2830-2864 returns needs_follow_up, not TurnAborted).
 * The whole design therefore rests on one property of the driver: preemptStep() only closes the current step,
 * and the driver re-enters pre-step, where the message that caused the preemption is claimed as ordinary input.
 *
 * Two rules come straight from the reference implementation and are easy to get wrong:
 *  1. Subscribe before checking (input_queue.rs:294-315). A check-then-subscribe leaves a window in which a
 *     delivery that arrives between the two calls is neither seen by the check nor by the listener, and the
 *     member waits for a mailbox event that already happened.
 *  2. Notify outside the transaction (the caller's job, done in tools.mjs/index.mjs). A listener that preempts
 *     while a commit is open would re-enter the store.
 */

/**
 * The only three things that may change what a member is working on right now:
 *  - a durable team message from another member, root or the operator;
 *  - a Team wake (the tool transport's own action form), whose payload is not a stored message;
 *  - a user input, which is the human steering the turn.
 * Anything else — a scheduler tick, an internal projection event, a replay — must wait for the boundary.
 * The class is returned rather than a boolean so a refusal can say which rule rejected it.
 */
export function classify(core, message) {
  if (!message || typeof message !== 'object') return null;
  if (message.plugin === 'team-tools-v2-r10' && message.form === 'action') return 'teamWake';
  if (message.role === 'user' || message.source?.kind === 'user') return 'userInput';
  if (typeof message.sender === 'string') {
    if (message.sender === 'root' || message.sender === 'operator') return 'memberMessage';
    const sender = core.store.read(message.sender);
    if (sender && sender.entityId.startsWith('member:')) return 'memberMessage';
  }
  return null;
}
const isMemberMessage = (core, message) => classify(core, message) !== null;

/**
 * Decide whether one durable message may preempt a live step. Every refusal is explicit and counted, so a
 * silent no-op can never be mistaken for "the feature was working".
 */
export function admit(core, memberId, message) {
  const member = core.store.read(memberId);
  if (!member) return { ok: false, reason: 'notMember' };
  if (member.desired !== 'active') return { ok: false, reason: 'notActive' };
  if (core.store.list('completion:').some(t => ['prepared', 'authorized', 'unknown'].includes(t.status))) {
    return { ok: false, reason: 'frozen' };
  }
  // A turn that is already over budget must not be re-driven: the extra request a preemption buys is exactly
  // the cost this check exists to stop. The signal is injected (a ledger read or an operator switch), so this
  // module never reaches into the budget subsystem itself.
  const budget = core.budget?.();
  if (budget?.exhausted === true || core.configuration.budgetExhausted === true) return { ok: false, reason: 'budget' };
  if (!isMemberMessage(core, message)) return { ok: false, reason: 'notMemberMessage' };
  return { ok: true, reason: null };
}

/**
 * R8: which activity a delivery is looking at, read from the driver's own phase.
 *
 * Upstream publishes exactly three kinds (dsh-agent-loop/lib/index.js:547-556,586-609): 'idle', 'running' (a turn is
 * executing) and 'maintenance' (a background job such as compaction owns the agent). 'maintenance' has no turn, returns
 * to 'idle' when the job ends, and a message sitting in the team store never starts one; the patched driver refuses
 * preemptStep for it on purpose, so the job is never cut in half (instant-preempt probe case D). Upstream's own
 * `status` getter reports maintenance as 'idle' and everything else as 'running', which is exactly why the kind is
 * read here and the status never is.
 *
 *   'idle'    - the idle edge: a delivery may open the member's next turn;
 *   'running' - a live turn: a delivery may preempt its step or merge into its next boundary;
 *   'noTurn'  - a phase that exists but executes nothing (maintenance, and any kind this release does not know): the
 *               delivery has no merge target at all and must stay unexecuted;
 *   'unknown' - the driver publishes no phase. That is an agent from before this phase existed, not a non-executing
 *               state, so it keeps the behaviour it had before this rule.
 */
function activity(agent) {
  const kind = agent.phase?.kind;
  if (kind === 'idle') return 'idle';
  if (kind === 'running') return 'running';
  if (kind === undefined) return 'unknown';
  return 'noTurn';
}

/**
 * One watcher per member. It subscribes first, then checks, then subscribes the live step; each step gets at
 * most one preemption and two triggers inside the coalescing window produce one request, never two.
 */
/**
 * §5.4: which input strategy this team runs. Chosen once, from the team policy, and never switched at run time.
 *
 *   preempt - HEAD's instant-preempt: a live step may be closed between two stream reads.
 *   queue   - v1: a running member only latches the input; the next natural boundary reads it. No window, no step
 *             seam, no second dispatcher.
 *
 * 'preempt' is the default for every team that did not record the new protocol, which is what keeps off byte-identical.
 */
export function inputPolicy(core) {
  return core?.configuration?.superagentBorrow === 'v1' ? 'queue' : 'preempt';
}

/**
 * One arbiter per member. It subscribes first, then checks, then (legacy only) subscribes the live step; each step
 * gets at most one preemption and two triggers inside the coalescing window produce one request, never two.
 *
 * A legacy team selects 'preempt': partial streams are interruptible, but a successfully committed response now
 * owns its entire tool batch (the intentional completion policy below). A v1 team selects 'queue', where preemptStep
 * and the window are never read. The compatibility export keeps the old name for existing wiring and tests.
 */
export class MemberInputArbiter {
  constructor(core, options = {}) {
    this.core = core;
    this.policy = options.policy ?? inputPolicy(core);
    if (this.policy === 'preempt') this.minIntervalMs = options.minIntervalMs ?? 2000;
    this.now = options.now ?? (() => Date.now());
    // The wake port is injectable so an offline test can prove the decision without a driver; the default is
    // the driver's own idle edge, which is the only object allowed to open a turn.
    this.wakeHook = options.wake;
    this.bindings = new Map();
    // §5.4: the policy is read once. Under 'queue' the window fields are legacy and never consulted.
    this.rotation = 0;
    // coalesced counts deliveries folded into a request that was already bought (inside the window); notLive
    // counts deliveries no live step could take (idle member, step ending). They are reported apart so a run
    // that never had a step to interrupt is not mistaken for one where the window did the merging. woke is the
    // part of notLive that opened the recipient's next turn; notLive - woke is the part that had to wait for an
    // ordinary boundary, which is the number a run must be able to explain. dispatched counts the wakes a first
    // dispatch or an intent result bought (F1 R5-2/R5-3); they are the same idle edge, never a second dispatcher.
    // R8 adds notExecuting: deliveries that reached a phase which executes nothing (upstream's maintenance, or any kind
    // this release does not know). They are neither a merge nor a wake - they have no target at all - and a run that
    // reports them is the one that can explain why those deliveries were retried instead of confirmed.
    this.counters = { preempts: 0, coalesced: 0, notLive: 0, notExecuting: 0, woke: 0, dispatched: 0,
      // §5.4: the v1 counters. A legacy team leaves them at zero; the legacy four are 'not-applicable' under 'queue'
      // and are never incremented there, so a run can say which strategy it measured instead of mixing them.
      ...(this.policy === 'queue' ? { queued: 0, batches: 0, batchItems: 0, overflow: 0, idleWakes: 0, deferred: 0 } : {}),
      refused: { frozen: 0, notActive: 0, budget: 0, notMemberMessage: 0, notMember: 0 } };
  }

  /** Bind a live agent to its member id; the agent is the only object that can preempt or wake. */
  bind(memberId, agent) {
    // -Infinity, not 0: the first delivery must not be coalesced by a timestamp that never happened.
    this.bindings.set(memberId, this.policy === 'queue' ? { agent } : { agent, lastFiredAt: -Infinity, steps: new WeakSet() });
  }

  bindOwner(memberId, agent) {
    if (this.policy !== 'queue' || this.core.store.read(memberId)?.role !== 'root') throw Error('INVALID_OWNER_BINDING');
    this.bind(memberId, agent);
  }

  unbind(memberId) { this.bindings.delete(memberId); }

  observeAssistantFrame(agent, frame) { noteAssistantFrame(agent, frame); }

  /**
   * A delivery happened. Subscribe (the caller already did, via the inbound queue) then check: the message is
   * durable before this runs, so the check is against committed state, never against a pending promise.
   */
  onMail(memberId, messageId) {
    const outcome = this.mailboxOutcome(memberId, messageId);
    return { fired: outcome.fired, reason: outcome.reason };
  }

  /**
   * R7-1: the product wake port's view of the same decision. onMail's two fields cannot say "the driver refused" or
   * "the driver raised", which let a port confirm a delivery that never opened a turn; this returns the three-state
   * result the port needs:
   *   dispatched  - a turn was opened, or the delivery legally merged into a turn that is still live;
   *   wake        - 'woke' | 'live' | 'coalesced' | 'refused' (driver said no) | 'error' (driver raised) | null
   *                 (nothing to wake: no surface, no binding, policy refusal) | 'notExecuting' (the phase executes
   *                 nothing - maintenance - so there is no merge target and the delivery must stay unexecuted);
   *   defer       - R9: the non-executing phase is upstream's maintenance, which ends by itself and hands the agent
   *                 back as idle. That wait is a schedule, not a failure: the port defers the effect (the ledger owns
   *                 nextDue and keeps the try) instead of spending a bounded retry on it. Any other non-executing kind
   *                 stays notExecuted - it may never end.
   */
  deliverMail(memberId, messageId) { return this.mailboxOutcome(memberId, messageId); }

  /**
   * R9: is this member's agent owned by a maintenance job right now? The only phase a dispatch may wait for: no turn and
   * no idle edge, but a job that ends by itself. Read from the same helper the mailbox uses, so the pre-claim question
   * and the post-claim answer can never disagree about which phase this is.
   */
  maintenance(memberId) {
    const binding = this.bindings.get(memberId);
    return binding ? activity(binding.agent) === 'noTurn' && binding.agent.phase?.kind === 'maintenance' : false;
  }

  mailboxOutcome(memberId, messageId) {
    const binding = this.bindings.get(memberId);
    if (!binding) return { fired: false, reason: 'notBound', dispatched: false, wake: null };
    const message = typeof messageId === 'string' ? this.core.store.read(messageId) : messageId;
    const resource = this.policy === 'queue' && message?.entityId?.startsWith('thread-delivery:') &&
      message.memberId === memberId && message.generation === this.core.store.read(memberId)?.generation && message.state === 'pending';
    const verdict = admit(this.core, memberId, resource ? { ...message, sender: 'root' } : message);
    if (!verdict.ok) {
      this.counters.refused[verdict.reason] = (this.counters.refused[verdict.reason] ?? 0) + 1;
      return { fired: false, reason: verdict.reason, dispatched: false, wake: null };
    }
    const agent = binding.agent;
    // §5.2 rule 2: v1 answers the same three-state question from the phase alone and never calls preemptStep.
    if (this.policy === 'queue') return this.queuedOutcome(memberId, agent);
    // One preemption per step: the latch is a per-step object, so a second request in the same step is a no-op
    // the driver answers with false and it is counted as notLive, never as a second request.
    if (agent.preemptStep === undefined) return { fired: false, reason: 'noPreemptSurface', dispatched: false, wake: null };
    // R7-2: the coalescing window merges into a *turn*, never into a timestamp. An idle member inside the window used
    // to be reported as 'coalesced' - a merge into a turn that had already ended - and the delivery was then confirmed
    // without anyone opening a turn. R8: "not idle" is not "has a live turn" either. Upstream's maintenance phase has no
    // turn of its own, returns to idle when the background job ends and never reads the team store by itself, so a
    // delivery into it has no merge target at all; its preemptStep is refused on purpose. Both mistakes end the same
    // way - a message confirmed against an activity that never consumes it - so only 'idle' (the idle edge) and
    // 'running' (a live turn) may go on to a success.
    const phase = activity(agent);
    if (phase === 'noTurn') {
      this.counters.notExecuting++;
      return { fired: false, reason: 'notExecuting', dispatched: false, wake: 'notExecuting',
        phase: agent.phase.kind, defer: agent.phase.kind === 'maintenance' };
    }
    const idle = phase === 'idle';
    const at = this.now();
    if (!idle && at - binding.lastFiredAt < this.minIntervalMs) {
      this.counters.coalesced++;
      return { fired: false, reason: 'coalesced', dispatched: true, wake: 'coalesced' };
    }
    // Intentional legacy policy change: after a successful durable assistant settlement, even NOT-YET-STARTED tools
    // in that batch continue. The model has committed its decision: do not abort/replay it and buy another request.
    // New mail waits for the next natural boundary or idle fallback; partial/failed streams remain interruptible.
    const fired = !hasCompletedResponse(agent) && agent.preemptStep('team-message');
    if (fired) {
      binding.lastFiredAt = at;
      this.counters.preempts++;
      return { fired: true, reason: null, dispatched: true, wake: 'live' };
    }
    // Re-read the phase after the refusal: the turn that owned the step may have ended, or handed the agent to a
    // maintenance job, between the check and the call. A phase that is no longer executing cannot read this message at
    // a later boundary of that activity, so it is not a merge point.
    const after = activity(agent);
    if (after === 'noTurn') {
      this.counters.notExecuting++;
      return { fired: false, reason: 'notExecuting', dispatched: false, wake: 'notExecuting',
        phase: agent.phase.kind, defer: agent.phase.kind === 'maintenance' };
    }
    this.counters.notLive++;
    if (!idle && after !== 'idle') {
      // The live turn could not take the request (already fired, ending, or protecting a committed batch). It is still
      // live, so the message is read at its next boundary: that is a legal merge, not a dispatch of a new turn.
      return { fired: false, reason: 'notLive', dispatched: true, wake: 'live' };
    }
    // The member is idle: the idle edge is the driver's to open, and a durable delivery is exactly the event that
    // should open it. Its refusal or failure is reported as such - never folded into a merge, never a success.
    const turn = this.openIdleTurn(memberId, agent);
    if (turn.woke) {
      this.counters.woke++;
      return { fired: false, reason: 'woke', dispatched: true, wake: 'woke' };
    }
    return { fired: false, reason: 'notLive', dispatched: false, wake: turn.kind, error: turn.error };
  }

  /**
   * Open an idle member's next turn so the delivery it just received is picked up now instead of at whatever
   * boundary its caller happens to produce later. Three conditions, each of which must hold for a wake to be
   * honest:
   *  - the candidate surface exists (a C1 agent has no preemptStep and must keep its old behaviour exactly);
   *  - the driver is idle, because wakeDriver on a running phase is a latch, not a wake;
   *  - the mailbox is ready, i.e. the recipient has a non-info message that is still invisible: waking a member
   *    for an info note would spend a request on nothing.
   */
  wakeMember(memberId, binding, agent) {
    return this.openIdleTurn(memberId, agent).woke;
  }

  /**
   * The idle edge with its reason kept: 'unavailable' (a C1 build has no surface, the phase is not idle, or the
   * mailbox is not ready - there is nothing honest to wake for), 'refused' (the driver said no) or 'error' (it raised,
   * which may or may not have opened the turn). The last two must never be reported as a merge or a success.
   */
  openIdleTurn(memberId, agent) {
    if (agent.preemptStep === undefined) return { woke: false, kind: 'unavailable', error: null };
    if (agent.phase?.kind !== 'idle') return { woke: false, kind: 'unavailable', error: null };
    if (this.core.ready(memberId) !== true) return { woke: false, kind: 'unavailable', error: null };
    const turn = this.openTurn(agent);
    if (turn.woke) return { woke: true, kind: 'woke', error: null };
    return { woke: false, kind: turn.error ? 'error' : 'refused', error: turn.error ?? null };
  }

  /**
   * The only idle edge: a driver that is between turns is opened by wakeDriver, and nothing else may call it.
   * A running phase is never woken - wakeDriver there is a latch, not a wake - so a wake that arrives while the
   * member is live is a no-op instead of a second dispatch. A driver that refuses to be woken leaves the fact
   * (the message, the attempt, the intent result) durable and unstarted: the wake is an optimisation of when,
   * never a transfer of responsibility.
   */
  openTurn(agent) {
    const wake = this.wakeHook ?? (target => {
      if (typeof target.wakeDriver !== 'function') return false;
      // A driver that answers false refused the turn; only a truthy/undefined answer means it was opened.
      return target.wakeDriver() !== false;
    });
    try {
      return { woke: wake(agent) !== false, error: null };
    } catch (error) {
      // A driver that raised may or may not have opened the turn before it threw: that is an unknown outcome and the
      // caller must not report it as a refusal (and must never report it as a dispatch).
      return { woke: false, error };
    }
  }

  /**
   * R5-2/R5-3: a durable fact with no live step to interrupt - the first dispatch of a new attempt, or an intent
   * result - asks the same consumer for the idle edge. It refuses when the member has no bound agent and when the
   * phase is not idle: a mailbox wake that already opened the turn is the one dispatch, and this call reports that
   * instead of opening a second one.
   */
  wakeIdle(memberId) {
    const binding = this.bindings.get(memberId);
    if (!binding) return { fired: false, reason: 'notBound' };
    const agent = binding.agent;
    // §5.2 rule 2: the same idle edge, counted as a v1 idle wake; a live turn is a latch, never a second dispatch.
    if (this.policy === 'queue') return this.queueIdle(agent);
    // No preemption-surface check here, unlike wakeMember: the first dispatch is not an optimisation of when, it is
    // the only thing that starts a new attempt, and a build without the candidate still has to start work (that is
    // its old behaviour). What still must hold is the idle phase: a live turn is a latch, never a second dispatch.
    // R8: maintenance is not a live turn either. Upstream reports it as status 'idle' while no turn executes and the
    // phase returns to idle by itself, so a dispatch or an intent result confirmed against it would be confirmed
    // against nothing. It stays notExecuted, and the bounded retry wakes the member once the job is over.
    const phase = activity(agent);
    if (phase === 'noTurn') return { fired: false, reason: 'notExecuting', phase: agent.phase.kind,
      defer: agent.phase.kind === 'maintenance' };
    if (phase !== 'idle') return { fired: false, reason: 'alreadyLive' };
    const turn = this.openTurn(agent);
    if (turn.woke) {
      this.counters.woke++;
      this.counters.dispatched++;
    }
    return { fired: turn.woke, reason: turn.woke ? null : turn.error ? 'wakeError' : 'wakeRefused',
      error: turn.error ?? null };
  }

  /**
   * §5.2 rule 2 (v1): the running member only latches; the idle member is woken exactly once through the idle edge.
   *
   *   running     - queued: the input is durable and will be read at the next natural preStep. This is not a merge
   *                 into a step and not a preemption; nothing is aborted, no tool is cancelled, no turn is opened.
   *   idle        - the idle edge opens the next turn (only when the mailbox is really ready for a non-info input).
   *   noTurn      - maintenance (or an unknown non-executing kind): deferred, not executed, not consumed.
   *   unknown     - the driver publishes no phase: the answer is 'unknown', never a guess of 'busy'.
   */
  queuedOutcome(memberId, agent) {
    const phase = activity(agent);
    if (phase === 'unknown') {
      return { fired: false, reason: 'unknownPhase', dispatched: false, wake: 'unknown' };
    }
    if (phase === 'noTurn') {
      this.counters.notExecuting++;
      if (agent.phase?.kind === 'maintenance') this.counters.deferred++;
      return { fired: false, reason: 'notExecuting', dispatched: false, wake: 'notExecuting',
        phase: agent.phase?.kind, defer: agent.phase?.kind === 'maintenance' };
    }
    if (this.core.ready(memberId) !== true) {
      // Carry-only is not a dispatch. Otherwise an info notice racing first-dispatch could consume its receipt
      // while idle and suppress the only wake that starts the attempt.
      this.counters.queued++;
      return { fired: false, reason: 'infoOnly', dispatched: false, wake: 'carried' };
    }
    if (phase === 'running') {
      this.counters.queued++;
      return { fired: false, reason: 'queued', dispatched: true, wake: 'queued' };
    }
    const turn = this.openTurn(agent);
    if (turn.woke) {
      this.counters.idleWakes++;
      this.counters.woke++;
      return { fired: false, reason: 'woke', dispatched: true, wake: 'woke' };
    }
    return { fired: false, reason: turn.error ? 'wakeError' : 'wakeRefused', dispatched: false,
      wake: turn.error ? 'error' : 'refused', error: turn.error ?? null };
  }

  /** §5.2 rule 2 (v1): the first dispatch or coordination result asks for the same one idle edge. */
  queueIdle(agent) {
    const phase = activity(agent);
    if (phase === 'noTurn') {
      this.counters.notExecuting++;
      if (agent.phase?.kind === 'maintenance') this.counters.deferred++;
      return { fired: false, reason: 'notExecuting', phase: agent.phase?.kind,
        defer: agent.phase?.kind === 'maintenance' };
    }
    if (phase === 'unknown') return { fired: false, reason: 'unknownPhase' };
    if (phase !== 'idle') return { fired: false, reason: 'alreadyLive' };
    const turn = this.openTurn(agent);
    if (turn.woke) { this.counters.idleWakes++; this.counters.dispatched++; }
    return { fired: turn.woke, reason: turn.woke ? null : turn.error ? 'wakeError' : 'wakeRefused',
      error: turn.error ?? null };
  }

  /**
   * §5.4 counters: a prepared batch reporting what it carried and what it left pending, plus the rotation the next
   * batch uses. The arbiter owns the counter, the batch builder owns the selection; neither opens a second dispatcher.
   */
  noteBatch({ items = 0, omitted = 0 } = {}) {
    this.rotation += 1;
    this.counters.batches++;
    this.counters.batchItems += items;
    if (omitted > 0) this.counters.overflow += omitted;
    return this.rotation;
  }

  get batchRotation() { return this.rotation; }

  /** The counters the verification surface reports; copied so a caller cannot mutate them by accident. */
  snapshot() { return { ...this.counters, refused: { ...this.counters.refused },
    ...(this.policy === 'queue' ? { policy: this.policy } : {}) }; }
}

/** §5.4 compatibility export: the same class under the name the F1/F2 wiring and its tests already import. */
export const PreemptWatcher = MemberInputArbiter;

/** Install the watcher on an existing runtime; returns it so a profile can expose it. */
export function installPreempt(ctx, core, options = {}) {
  const watcher = new MemberInputArbiter(core, options);
  core.notifyDelivery = (memberId, messageId) => watcher.onMail(memberId, messageId);
  core.preempt = watcher;
  return watcher;
}