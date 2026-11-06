// Opt-in live performance study: every sample is one real product cycle measured from product events.
//
// The gate (./performance.mjs) needs at least 30 cold and 30 warm samples, each carrying its condition, the number of
// warmup cycles that preceded it, ready->admitted and stored->boundary in milliseconds. Nothing here invents a number:
// ready->admitted is the journal's own task status=ready event and the attempt's status=admitted event ('admittedAt'),
// read back through the timing module the rest of the harness uses, and stored->boundary is the message row's
// createdAt and the visibility event's updatedAt, the same two values metrics.mjs subtracts for
// latency.storedToBoundary.
//
// One cycle: a durable responsibility from root is stored, then a work task for the member is requested. The product's
// scheduler admits the task (status=ready -> attempt status=admitted) and the host opens that attempt's turn; the
// pre-step snapshot carries the pending responsibility, so the product's request boundary commits it visible. The
// sample is that pair of committed transitions from the same member, and the attempt is closed with the product's own
// attempt.finish so the member takes the next sample.
//
// Conditions:
// - cold is a native session that has never issued a provider request. The product caps a team at 30 member rows
//   (including member:root), so the study creates 28 dedicated cold members, counts the warm member's own first
//   (unwarmed) cycle, and counts root's first (unwarmed) cycle: 30 cold sessions, 29 worker rows plus root.
// - warm is the same native session as one of the cold samples, after exactly two completed warmup cycles on it.
//   Every warm row therefore records warmupCycles=2.
// The study is single-concurrency (one message in flight, each cycle awaited to its turn end) and the run injects no
// fault and starts no background load; the gate reads concurrency/backgroundLoad from the study row.
import {attemptTiming} from './timing.mjs';
import {PERFORMANCE_PROTOCOL} from './performance.mjs';

const COLD_MEMBERS = 28;
const WARM_MEMBER = 'warm';
const WARMUP_CYCLES = PERFORMANCE_PROTOCOL.warmupCycles;
const WARM_SAMPLES = PERFORMANCE_PROTOCOL.samplesPerCondition;
const COLD_GROUPS = ['perf-a', 'perf-b', 'perf-c', 'perf-d'];
const groupFor = index => COLD_GROUPS[Math.floor(index / 8) % COLD_GROUPS.length];
const probe = label => 'Latency probe ' + label + ': this is a single-response check. Reply with exactly ACK and do not call tools.';

const until = async (predicate, what, timeoutMs = 180000) => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > end) throw Error('PERFORMANCE_TIMEOUT: ' + what);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

export class PerformanceStudy {
  constructor(engine, {stopped = () => false} = {}) {
    this.engine = engine;
    this.stopped = stopped;
    this.facts = engine.facts;
    this.serial = 0;
  }

  begin() {
    this.facts.performanceStudy = {
      protocol: PERFORMANCE_PROTOCOL,
      concurrency: PERFORMANCE_PROTOCOL.concurrency,
      backgroundLoad: PERFORMANCE_PROTOCOL.backgroundLoad,
      faults: PERFORMANCE_PROTOCOL.faults,
      coldScope: 'a native session that has never issued a provider request: 28 members created for the study, the warm member before its first cycle, and ' +
        'member:root before its first cycle',
      warmScope: 'the warm member\'s same native session after exactly ' + WARMUP_CYCLES + ' completed warmup cycles',
      startedAt: Date.now(),
      completedAt: null,
      stoppedAt: null,
      samples: [],
    };
    return this.facts.performanceStudy;
  }

  finish() {
    const study = this.facts.performanceStudy;
    if (study) study.completedAt = Date.now();
    return study;
  }

  async createMember(actor, group) {
    const e = this.engine, member = 'member:' + actor;
    if (e.core.store.read(member)) throw Error('PERFORMANCE_MEMBER_EXISTS:' + member);
    e.submit('team.member.request', 'member-intent:' + actor, {role: 'worker', group});
    await until(() => e.core.store.read('member-intent:' + actor)?.status === 'confirmed', 'member-intent ' + actor + ' confirmed');
    await until(() => e.runtime.handles.has(member), 'native execution for ' + member);
    // The engine attributes every provider stream to a role state; a member created by the study needs one too, so
    // its own requests pass the same stateOfSession lookup every rostered member goes through.
    const agent = e.agent(actor);
    const state = {actor, role: 'worker', group, boundary: 0, manifest: null, pending: null, lastRaw: null,
      binding: null, turnRequests: 0, studyMember: true};
    e.states.set(actor, state);
    e.byAgent.set(agent, state);
    // The request catalog advertises the harness's real_work tool to every member (Engine.catalog), so the tool has to
    // be registered on this agent exactly as it is for every rostered member. Without this registration the member's
    // tool guard sees an unknown native effect and refuses the call with UNKNOWN_EFFECT: the catalog promised a tool the
    // agent does not have.
    e.install(state);
    return state;
  }

  /**
   * One measured cycle, from two committed product transitions of the same member.
   *
   * The probe message is stored first, then a work task is requested. The scheduler admits the task (status=ready ->
   * attempt status=admitted) and the host opens that attempt's turn; the product's pre-step snapshot carries the
   * oldest pending responsibility, which is this probe, so the visibility is committed at that turn's first request.
   * ready->admitted is read from the task and attempt events (a mailbox wake's own task is created inside the drain
   * that admits it, and the drain's clock predates that creation, so the timing module refuses to subtract its two
   * timestamps). stored->boundary is the message row's createdAt and the visibility event's updatedAt, exactly what
   * metrics.mjs reads for latency.storedToBoundary.
   *
   * The snapshot carries ONE pending responsibility at a time and always the oldest, so a probe that was never
   * accepted would hide every later probe. Each probe is therefore closed after its measurement with the same
   * operator escalation the harness already applies to unaccepted responsibilities at teardown; that write happens
   * after the measured timestamps and is recorded in the run's facts. The attempt is closed with the product's own
   * attempt.finish, which frees the member for the next sample.
   */
  async cycle(actor, {condition = null, warmupCycles = null, label}) {
    const e = this.engine, member = 'member:' + actor, agent = e.agent(actor);
    if (!agent) throw Error('PERFORMANCE_MEMBER_WITHOUT_AGENT:' + member);
    const released = () => !e.core.store.list('attempt:').some(a => a.owner === member && ['active', 'unknown'].includes(a.lease));
    await until(released, 'previous attempt released for ' + member);
    const task = 'task:perf:' + label;
    const turnsBefore = e.turnsEnded(agent);
    const before = e.core.store.latestEventSeq();
    const messageId = e.deliverPrompt(actor, probe(label));
    e.submit('team.task.request', task, {owner: member});
    const attempt = await until(() => e.core.store.list('attempt:').find(row => row.owner === member && row.taskId === task) ?? null,
      'admission for ' + member + ' (' + label + ')');
    // Registered before any request so the adapter's own first-request observation reuses this row instead of a second.
    const timing = attemptTiming(e, actor, null, attempt.entityId);
    if (!Number.isFinite(timing.readyAt) || !Number.isFinite(timing.admittedAt)) {
      throw Error('PERFORMANCE_TIMING_MISSING: no ready/admitted event pair for ' + attempt.entityId);
    }
    const message = await until(() => {
      e.observe(before);
      const row = e.facts.messages.find(m => m.id === messageId);
      return row && row.visible === true && Number.isFinite(row.visibleAt) ? row : null;
    }, 'visibility of ' + messageId + ' (' + label + ')');
    if (!Number.isFinite(message.storedAt)) throw Error('PERFORMANCE_TIMING_MISSING: no storedAt for ' + messageId);
    const readyToAdmittedMs = timing.admittedAt - timing.readyAt;
    const storedToBoundaryMs = message.visibleAt - message.storedAt;
    if (!Number.isFinite(readyToAdmittedMs) || !Number.isFinite(storedToBoundaryMs) ||
      readyToAdmittedMs < 0 || storedToBoundaryMs < 0) {
      throw Error('PERFORMANCE_TIMING_NON_MONOTONIC:' + label);
    }
    await until(() => e.turnsEnded(agent) > turnsBefore, 'turn end for ' + member + ' (' + label + ')');
    await agent.whenIdle?.();
    this.closeProbe(messageId);
    e.core.finish(attempt.entityId, attempt.fence, 'cancelled');
    await until(released, 'attempt release for ' + member + ' (' + label + ')');
    e.progress('performance-sample:' + label);
    const sample = {condition, warmupCycles, readyToAdmittedMs, storedToBoundaryMs,
      actor: member, taskId: attempt.taskId, attemptId: attempt.entityId, messageId,
      readyAt: timing.readyAt, admittedAt: timing.admittedAt, storedAt: message.storedAt, visibleAt: message.visibleAt,
      readyEventSeq: timing.readyEventSeq, admissionEventSeq: timing.admissionEventSeq, source: 'product-events'};
    if (condition) {
      if (!['cold', 'warm'].includes(condition)) throw Error('PERFORMANCE_CONDITION_INVALID:' + condition);
      if (!Number.isSafeInteger(warmupCycles) || warmupCycles < 0) throw Error('PERFORMANCE_WARMUP_INVALID:' + warmupCycles);
      this.facts.performanceStudy.samples.push(sample);
    }
    return sample;
  }

  /** Close a measured probe so the next snapshot can carry the next one; the same operator write close() applies. */
  closeProbe(messageId) {
    const current = this.engine.core.store.read(messageId);
    if (!current || ['accepted', 'escalated', 'resolved', 'cancelled'].includes(current.status)) return;
    this.engine.core.mutate(messageId, 'operator', {}, (tx, row) => tx.put(messageId, {...row, status: 'escalated',
      responsible: 'operator', reason: 'performance study: measured boundary; the probe is not a responsibility'}));
  }


  /**
   * root's own cold sample.
   *
   * The owner session is bound as the team's owner, not as a member execution, so a work attempt on it never gets a
   * turn dispatched into it (the start port binds the agent but the wake is not routed to that attempt; a fake run
   * that waited for the message to become visible timed out). The two numbers are therefore read from two committed
   * cycles of the same owner session: ready->admitted from a work task that is admitted and then closed without a
   * turn, and stored->boundary from the product's own mailbox wake, which does open the owner's turn. The sample row
   * names both attempts so the two measurements stay separable.
   */
  async rootCycle({label, condition, warmupCycles}) {
    const e = this.engine, member = 'member:root', agent = e.agent('root');
    await until(() => !e.core.store.list('attempt:').some(a => a.owner === member && ['active', 'unknown'].includes(a.lease)),
      'previous attempt released for ' + member);
    const task = 'task:perf:' + label;
    e.submit('team.task.request', task, {owner: member});
    const attempt = await until(() => e.core.store.list('attempt:').find(row => row.owner === member && row.taskId === task) ?? null,
      'admission for ' + member + ' (' + label + ')');
    const timing = attemptTiming(e, 'root', null, attempt.entityId);
    if (!Number.isFinite(timing.readyAt) || !Number.isFinite(timing.admittedAt)) {
      throw Error('PERFORMANCE_TIMING_MISSING: no ready/admitted event pair for ' + attempt.entityId);
    }
    e.core.finish(attempt.entityId, attempt.fence, 'cancelled');
    await until(() => !e.core.store.list('attempt:').some(a => a.owner === member && ['active', 'unknown'].includes(a.lease)),
      'attempt release for ' + member + ' (' + label + ')');
    const before = e.core.store.latestEventSeq();
    const messageId = e.deliverPrompt('root', probe(label));
    // The owner session does not take a member execution, so the product's mailbox wake for it opens no turn. The
    // owner's real boundary is the turn the user's session opens: the queued message travels in that request's
    // snapshot and the product's visibility port commits the same stored->visible fact it commits for a member.
    await e.turn('root', 'Reply with exactly ACK and do not call tools.');
    e.observe(before);
    const message = e.facts.messages.find(m => m.id === messageId);
    if (!message || message.visible !== true || !Number.isFinite(message.visibleAt)) {
      throw Error('PERFORMANCE_NO_BOUNDARY:' + messageId + ' (' + label + ')');
    }
    if (!Number.isFinite(message.storedAt)) throw Error('PERFORMANCE_TIMING_MISSING: no storedAt for ' + messageId);
    const boundaryAttempt = e.core.store.list('attempt:').filter(row => row.owner === member &&
      row.taskId === 'task:mail-' + member).sort((a, b) => (b.admittedAt ?? 0) - (a.admittedAt ?? 0))[0] ?? null;
    const readyToAdmittedMs = timing.admittedAt - timing.readyAt;
    const storedToBoundaryMs = message.visibleAt - message.storedAt;
    if (!Number.isFinite(readyToAdmittedMs) || !Number.isFinite(storedToBoundaryMs) ||
      readyToAdmittedMs < 0 || storedToBoundaryMs < 0) {
      throw Error('PERFORMANCE_TIMING_NON_MONOTONIC:' + label);
    }
    e.progress('performance-sample:' + label);
    const sample = {condition, warmupCycles, readyToAdmittedMs, storedToBoundaryMs,
      actor: member, taskId: attempt.taskId, attemptId: attempt.entityId, messageId,
      readyAt: timing.readyAt, admittedAt: timing.admittedAt, storedAt: message.storedAt, visibleAt: message.visibleAt,
      readyEventSeq: timing.readyEventSeq, admissionEventSeq: timing.admissionEventSeq,
      boundaryTaskId: boundaryAttempt?.taskId ?? null, boundaryAttemptId: boundaryAttempt?.entityId ?? null,
      source: 'product-events'};
    this.facts.performanceStudy.samples.push(sample);
    return sample;
  }

  async run() {
    this.begin();
    const stoppedEarly = () => {
      if (!this.stopped()) return false;
      this.facts.performanceStudy.stoppedAt = Date.now();
      return true;
    };
    try {
      // The fake transport's regression runs this stage at a reduced size (it is functional evidence only: the gate
      // reports not-run for any non-live mode). Live always uses the protocol's own counts.
      const reduced = this.engine.mode === 'fake' && process.env.DSH_PERF_FAKE_SMALL === '1';
      const coldMembers = reduced ? 1 : COLD_MEMBERS;
      const warmSamples = reduced ? 2 : WARM_SAMPLES;
      // The warm member's session is created first and measured before any other request, so its first sample is cold.
      await this.createMember(WARM_MEMBER, 'perf-warm');
      await this.cycle(WARM_MEMBER, {condition: 'cold', warmupCycles: 0, label: 'cold-warm-0'});
      if (stoppedEarly()) return this.finish();
      // member:root is the thirtieth member row the product allows (root included): its first (unwarmed) cycle is the
      // thirtieth cold sample. A work attempt on the owner session gets no member turn, so root's boundary is the
      // owner's own turn, which is the boundary the user's session really has.
      await this.rootCycle({condition: 'cold', warmupCycles: 0, label: 'cold-root'});
      for (let index = 0; index < coldMembers; index++) {
        if (stoppedEarly()) return this.finish();
        const actor = 'cold' + String(index + 1).padStart(2, '0');
        await this.createMember(actor, groupFor(index));
        await this.cycle(actor, {condition: 'cold', warmupCycles: 0, label: 'cold-' + actor});
      }
      if (stoppedEarly()) return this.finish();
      for (let index = 0; index < WARMUP_CYCLES; index++) {
        if (stoppedEarly()) return this.finish();
        await this.cycle(WARM_MEMBER, {label: 'warmup-' + (index + 1)});
      }
      for (let index = 0; index < warmSamples; index++) {
        if (stoppedEarly()) return this.finish();
        await this.cycle(WARM_MEMBER, {condition: 'warm', warmupCycles: WARMUP_CYCLES, label: 'warm-' + (index + 1)});
      }
      return this.finish();
    } catch (error) {
      this.finish();
      throw error;
    }
  }
}

/** Opt-in entry: only the explicit 'performance' stage calls this. */
export function runPerformanceStudy(engine, {stopped = () => false} = {}) {
  return new PerformanceStudy(engine, {stopped}).run();
}
