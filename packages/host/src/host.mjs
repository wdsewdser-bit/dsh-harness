import { failWith } from '../../contracts/index.mjs';
import { ControlStore } from '../../store/index.mjs';
import { createCommandAuthorization } from './authorization.mjs';
import { createLifecycleToken, revokeLifecycleToken } from './capability.mjs';
import { createClock } from './clock.mjs';
import { createEvidenceMaintenance } from './evidence-maintenance.mjs';
import { createCoreAccess } from './core-access.mjs';
import { createCycle } from './cycle.mjs';
import { CommandGateway } from './gateway.mjs';
import { assertMountable, assertNotStopping } from './guards.mjs';
import { drainSignal } from './drain.mjs';
import { HookRegistry } from './hooks.mjs';
import { InflightRegistry, openManagedOperation } from './inflight.mjs';
import { HostStateMachine, isLegalTransition } from './machine.mjs';
import { OwnershipState } from './ownershipstate.mjs';
import { acquireOwnership, ownershipRegistry } from './ownership.mjs';
import { canonicalTeamDir } from './paths.mjs';
import { closeStorePort, describeError, monotonicNow, openStorePort, readStopTimeout, settleWithin, stoppedError } from './ports.mjs';
import { assertNotCancelled, recoverOnce } from './recovery.mjs';
import { sessionRouter } from './sessions.mjs';
import { buildStatus } from './status.mjs';
import { createWritePorts, normaliseWriteKinds } from './writes.mjs';

/**
 * The team host, M1a skeleton; docs/host-protocol.md §2.1, §2.3, §2.5.
 *
 * Ownership (OS-held name + persistent epoch), the lifecycle state machine, stop with one monotonic budget covering
 * start, recovery, hooks, managed work, the store and the lock, the two session maps, and the command gateway.
 *
 * B installs guarded tick/reconcile/admission and exact-execution heartbeat consumers for real TeamCore instances.
 * Lifecycle IO remains exclusively with the legacy driver until C/F. Recovery is supplied by the composition root;
 * without one admission stays closed, enforced at the gateway rather than merely reported in status().
 */
const FAILED_START_RELEASE_TIMEOUT_MS = 5000;

export class TeamHost {
  #teamId;
  #ownerSessionId;
  #dir;
  #config;
  #machine;
  #router;
  #registry;
  #gateway;
  #authorize;
  #hooks;
  #writes;
  #inflight;
  #clock;
  #cycle = null;
  #evidence = null;
  #access;
  #visibilityStatus = null;
  #now;
  #ownership = null;
  #ownerState;
  #store = null;
  #token = null;
  #epochValue = null;
  #admission = false;
  #recovery = null;
  #recovering = null;
  #startPromise = null;
  #stopPromise = null;
  #isolated = false;
  #drainDeadline = Infinity;
  #controller = null;
  #lastError = null;
  #listenerErrors = [];
  #failed = null;
  #startedAt = null;
  #stoppedAt = null;

  constructor(options = {}) {
    const { teamId, root, ownerSessionId = null, core = null, commands = {}, recoverer = null, openStore = null,
      writeSink = null, writeKinds: rawWriteKinds = {}, acquire = acquireOwnership, router = sessionRouter, registry = ownershipRegistry,
      clock = null, now = Date.now, steps = null, cycleIntervalMs = null, heartbeatIntervalMs = 20000,
      evidenceRetentionCommitThreshold = 256, evidenceMaintenanceIntervalMs = null, evidenceRetentionLimits = null,
      evidenceMaintenanceBackoffMs = null, ...ports } = options;
    if (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs <= 0 || heartbeatIntervalMs >= 30000) failWith('INVALID_CONFIG', 'heartbeat interval must be positive and less than half the 60s TTL');
    if (typeof teamId !== 'string' || !teamId) failWith('INVALID_TEAM', 'createTeamHost needs a non-empty teamId');
    if (recoverer !== null && typeof recoverer !== 'function') failWith('INVALID_CONFIG', 'recoverer must be a function when supplied');
    if (openStore !== null && typeof openStore !== 'function') failWith('INVALID_CONFIG', 'openStore must be a function when supplied');
    if (writeSink !== null && typeof writeSink !== 'function') failWith('INVALID_CONFIG', 'writeSink must be a function when supplied');
    if (typeof acquire !== 'function') failWith('INVALID_CONFIG', 'acquire must be a function');
    // Validate and freeze the whitelist now: a string value would make includes() match substrings, and keeping the
    // caller's array would let it widen permissions while the host runs.
    const writeKinds = normaliseWriteKinds(rawWriteKinds);
    this.#teamId = teamId;
    this.#dir = canonicalTeamDir(root);
    this.#ownerSessionId = typeof ownerSessionId === 'string' && ownerSessionId ? ownerSessionId : null;
    // One clock for every timer (design §3.1): an injected clock is adopted rather than wrapped, so the caller can
    // still inspect it, and the host never arms a timer of its own outside it.
    this.#clock = clock && typeof clock.now === 'function' ? clock : createClock({ now });
    this.#now = () => this.#clock.now();
    // adapter, delivery and context are carried for M1b; nothing in this milestone calls them.
    this.#config = { core, recoverer, openStore, writeSink, acquire, steps: steps ?? null, cycleIntervalMs, heartbeatIntervalMs,
      evidenceRetentionCommitThreshold, evidenceMaintenanceIntervalMs, evidenceRetentionLimits, evidenceMaintenanceBackoffMs,
      ports: Object.freeze({ ...ports }) };
    this.#router = router;
    this.#registry = registry;
    this.#inflight = new InflightRegistry();
    this.#ownerState = new OwnershipState(() => this.#now());
    this.#machine = new HostStateMachine({ now: this.#now, onListenerError: (error, step) => this.#recordListenerError(error, step) });
    this.#authorize = createCommandAuthorization({
      state: () => this.#machine.state,
      ownership: () => (this.#ownership ? this.#ownership.verify() : { ok: false, reason: 'not-acquired' }),
      failure: () => this.#failed,
      admission: () => this.#admission,
      epoch: () => this.#epochValue,
      isManagedInflight: token => this.#inflight.has(token),
    });
    this.#gateway = new CommandGateway({ teamId, core, commands, now: this.#now, authorize: this.#authorize });
    // Built after the gateway; it reaches the gateway lazily so construction order cannot leave it with undefined.
    this.#writes = createWritePorts({
      teamId,
      dir: this.#dir,
      now: this.#now,
      getGateway: () => this.#gateway,
      writeSink,
      writeKinds,
      token: () => this.#token,
      epoch: () => this.#epochValue,
      state: () => this.#machine.state,
      failure: () => this.#failed,
      ownership: () => Boolean(this.#ownership && this.#ownership.verify().ok),
    });
    this.#hooks = new HookRegistry({ makeCapability: () => this.#writes.hookCapability() });
    // The controlled write ports, built once, reflecting live host state through getters (design §3.4). The cycle and
    // every adapter go through these; none of them gets the core or the gateway directly.
    this.#access = createCoreAccess({
      core,
      teamId,
      epoch: () => this.#epochValue,
      state: () => this.#machine.state,
      token: () => this.#token,
      ownership: () => Boolean(this.#ownership && this.#ownership.verify().ok),
      failure: () => this.#failed,
      inflight: this.#inflight,
      drainWritable: () => !this.#isolated && monotonicNow() < this.#drainDeadline,
      now: this.#now,
    });
  }

  get teamId() {
    return this.#teamId;
  }

  get ownerSessionId() {
    return this.#ownerSessionId;
  }

  /** The normalised team directory: the key ownership is taken on. */
  get root() {
    return this.#dir;
  }

  get state() {
    return this.#machine.state;
  }

  get epoch() {
    return this.#epochValue;
  }

  get ownership() {
    return this.#ownership;
  }

  /** The injected native ports, kept for M1b; M1a never calls them. */
  get ports() {
    return this.#config.ports;
  }

  /** The clock every timer of this host is armed on. */
  get clock() {
    return this.#clock;
  }

  /** The scheduling cycle, or null when the composition root installed no steps. */
  get cycle() {
    return this.#cycle;
  }

  /** The controlled write ports (lifecycle / managed / safety / recovery); design §3.4. */
  get coreAccess() {
    return this.#access;
  }

  /** start(): ownership (cancellable) -> epoch -> (business store) -> recovery -> route -> running -> cycle. */
  start() {
    if (this.#stopPromise) failWith('HOST_STOPPED', 'start() after stop() is refused; a restart is a new instance with a new epoch');
    if (this.#startPromise) failWith('INVALID_STATE', 'start() was already called on this host');
    if (this.#failed) failWith('HOST_FAILED', 'start() already failed during ' + this.#failed.stage + '; call stop() and create a new host');
    this.#startPromise = this.#runStart();
    return this.#startPromise;
  }

  async #runStart() {
    // Reject a read-only/incompatible database before acquiring ownership or incrementing epoch.
    if (this.#config.core?.store && typeof this.#config.core.store.assertWritableDriver !== 'function') {
      failWith('UNSUPPORTED_STORE_PREFLIGHT', 'a writable core store must expose synchronous version preflight');
    }
    this.#config.core?.store?.assertWritableDriver?.();
    ControlStore.preflight(this.#dir);
    // openStore is a synchronous, canonical-team-directory-only adapter. Opaque/remote/cross-directory
    // writable stores cannot be preflighted by this host and are not supported.
    this.#machine.transition('starting');
    this.#assertNotStopping();
    this.#controller = new AbortController();
    let stage = 'ownership';
    try {
      this.#ownership = await this.#config.acquire({ root: this.#dir, registry: this.#registry, now: this.#now, signal: this.#controller.signal });
      this.#epochValue = this.#ownership.epoch;
      this.#ownerState.setHeld();
      this.#assertNotStopping();
      stage = 'store';
      this.#store = openStorePort(this.#config.openStore, { teamId: this.#teamId, dir: this.#dir, epoch: this.#epochValue });
      this.#assertNotStopping();
      stage = 'recovery';
      this.#token = createLifecycleToken({ epoch: this.#epochValue, now: this.#now });
      this.#machine.transition('recovering');
      const conclusion = await this.#runRecover();
      this.#assertNotStopping();
      stage = 'routing';
      // Route before announcing running, so a listener that reacts to 'running' already finds the mapping; the
      // failure path unregisters it again.
      if (this.#ownerSessionId) this.#router.registerTeam({ teamId: this.#teamId, ownerSessionId: this.#ownerSessionId, host: this });
      stage = 'running';
      this.#machine.transition('running');
      // Start the cycle before admission is set (design §3.8): the cycle's own routes are the lifecycle ports, which
      // do not read admission, while business commands stay closed until the recoverer's conclusion opens them.
      if (this.#config.steps || typeof this.#config.core?.isDue === 'function') {
        this.#cycle = createCycle({ access: typeof this.#config.core?.isDue === 'function' ? this.#access.lifecycle() : null, clock: this.#clock, now: this.#now, steps: this.#config.steps ?? {},
          intervalMs: this.#config.cycleIntervalMs ?? 500, onError: error => this.#recordError(error) });
        if (typeof this.#config.core?.isDue === 'function') this.#clock.every(this.#config.heartbeatIntervalMs, () => {
          if (this.#machine.state !== 'running') return;
          const core = this.#config.core;
          // A host without an owner session registers no routes in start(), so it has no execution bindings to renew.
          // teamSessions() rightly reports NOT_ROUTED for a team this process does not host; that combination is
          // supported (manager.mount defaults ownerSessionId to null, and owner-less fixtures build exactly this host),
          // so the heartbeat is a no-op instead of an uncaught exception one heartbeat after start.
          if (!this.#ownerSessionId) return;
          const sessions = this.#router.teamSessions(this.#teamId).executions;
          const renewed = new Set();
          for (const binding of sessions) {
            if (!binding.attemptId || binding.epoch !== this.#epochValue || renewed.has(binding.attemptId)) continue;
            const attempt = core.store.read(binding.attemptId);
            if (!attempt || attempt.lease !== 'active' || attempt.owner !== binding.memberId ||
              attempt.generation !== binding.generation || attempt.fence !== binding.fence) continue;
            // Ruling A / review 2 #5: a mailbox attempt is a single-turn wake and is never renewed, so a turn that hangs
            // (no turn/end) cannot keep the lease alive past its expiry. The expiry still goes through the stop proof and
            // the safe-cancel path rather than being released as unknown.
            if (core.store.read(attempt.taskId)?.mailboxOnly === true) continue;
            try { this.#access.lifecycle().heartbeat(binding.attemptId, binding.fence, binding.epoch, this.#now()); renewed.add(binding.attemptId); }
            catch (error) { this.#recordError(error); }
          }
        }, 'heartbeat');
      }
      // Gap 1: bounded evidence retention on the host clock, driven by the commit backlog. It is independent of the
      // scheduling cycle (retention is storage choreography, not progress), never runs inside a transaction, and stops
      // with the host clock; a failure backs off and stays visible in status. It is on by default -- a production team
      // that never activates a trigger must still be bounded -- and can be switched off with
      // evidenceRetentionCommitThreshold: false (or null). A consumer that reads the raw journal after the fact is a
      // registered reader (ControlStore.registerReader) and its floor is honoured, not an exception to governance.
      const retentionThreshold = this.#config.evidenceRetentionCommitThreshold;
      if (retentionThreshold !== false && retentionThreshold !== null &&
        (!Number.isSafeInteger(retentionThreshold) || retentionThreshold <= 0)) failWith('INVALID_CONFIG', 'evidence retention commit threshold must be a positive integer, false or null');
      if (typeof this.#config.core?.store?.retainEvidence === 'function' && retentionThreshold !== false && retentionThreshold !== null) {
        this.#evidence = createEvidenceMaintenance({ store: this.#config.core.store, clock: this.#clock,
          intervalMs: this.#config.evidenceMaintenanceIntervalMs ?? 1000,
          threshold: retentionThreshold,
          backoffMs: this.#config.evidenceMaintenanceBackoffMs ?? 30000,
          limits: this.#config.evidenceRetentionLimits ?? null,
          lifecycle: () => this.#machine.state });
        this.#evidence.arm();
      }
      this.#admission = conclusion.admission === true;
      this.#startedAt = this.#now();
      return this.status();
    } catch (error) {
      await this.#failStart(error, stage);
      throw error;
    }
  }

  /** Failure ordering: admission closed, writes and hooks revoked, commands forbidden, then resources released. */
  async #failStart(error, stage) {
    this.#admission = false;
    revokeLifecycleToken(this.#token, 'start failed at ' + stage);
    this.#hooks.unmountAll();
    this.#inflight.clear();
    this.#router.unregisterTeam(this.#teamId, { host: this });
    this.#recordError(error);
    const cancelledByStop = this.#machine.state === 'stopping' || this.#machine.state === 'stopped';
    if (!cancelledByStop) {
      const code = String(error && error.code ? error.code : 'ERROR');
      const message = error && error.message ? error.message : String(error);
      this.#failed = { code, message, stage, at: this.#now() };
    }
    const deadline = monotonicNow() + FAILED_START_RELEASE_TIMEOUT_MS;
    await this.#closeStore(deadline);
    await this.#releaseOwnership(deadline);
  }

  /** recover(): only in the recovering phase of an owned team, never while running (spec 2.1 rule 5). */
  async recover() {
    const state = this.#machine.state;
    if (state === 'recovering') {
      if (this.#recovering) failWith('RECOVER_IN_PROGRESS', 'recover() is already running');
      return this.#runRecover();
    }
    if (state === 'running') failWith('RECOVER_NOT_ALLOWED', 'recover() is refused while running; this version defines no maintenance mode');
    failWith('INVALID_STATE', 'recover() needs an owned team in the recovering phase, got ' + state);
  }

  #runRecover() {
    if (this.#recovering) failWith('RECOVER_IN_PROGRESS', 'recover() is already running');
    const signal = this.#controller ? this.#controller.signal : null;
    // The recoverer gets a controlled capability, never the store, the gateway or the ownership handle.
    const capability = this.#writes.capability('recovery');
    const run = (async () => {
      const conclusion = await recoverOnce({
        recoverer: this.#config.recoverer, teamId: this.#teamId, dir: this.#dir, epoch: this.#epochValue, capability, signal, now: this.#now,
      });
      assertNotCancelled({ isolated: this.#isolated, revoked: Boolean(this.#token && this.#token.revoked), signal });
      this.#recovery = conclusion;
      return conclusion;
    })();
    this.#recovering = run.finally(() => {
      this.#recovering = null;
    });
    return this.#recovering;
  }

  /**
   * stop({ timeoutMs }): idempotent, one monotonic budget for everything. Options are validated before anything is
   * cached, the single-run latch is installed before any state notification, write eligibility is revoked before any
   * resource is touched, and the result reports what happened to the drain, the store and the lock.
   */
  stop(options = {}) {
    const timeoutMs = readStopTimeout(options);
    if (this.#stopPromise) return this.#stopPromise;
    let settle = null;
    // The latch exists before #runStop() notifies the 'stopping' listeners, so a listener that calls stop() again
    // joins this run instead of starting a second, interleaved shutdown.
    const latch = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    this.#stopPromise = latch;
    this.#runStop(timeoutMs).then(settle.resolve, settle.reject);
    return latch;
  }

  async #runStop(timeoutMs) {
    const startedAt = monotonicNow();
    const deadline = startedAt + timeoutMs;
    // Publish the drain barrier before state listeners, abort handlers or any other reentrant callback.
    // Reserve part of the same budget for closing the store and releasing the lock.
    const reserve = Math.min(500, Math.round(timeoutMs * 0.2));
    const drainDeadline = startedAt + Math.max(0, timeoutMs - reserve);
    this.#drainDeadline = drainDeadline;
    const state = this.#machine.state;
    if (state !== 'stopped' && isLegalTransition(state, 'stopping')) this.#machine.transition('stopping');

    this.#admission = false;
    // The cycle stops first: no new tick, drain or claim may start after this line, and its timer goes with it.
    if (this.#cycle) this.#cycle.stop();
    // The maintenance clock reports itself stopped too, instead of staying 'armed' until the shared clock clears it.
    if (this.#evidence) this.#evidence.stop();
    revokeLifecycleToken(this.#token, 'stop() revoked write eligibility');
    this.#hooks.unmountAll();
    this.#router.unregisterTeam(this.#teamId, { host: this });
    if (this.#controller) this.#controller.abort(stoppedError('stop() requested'));

    const pendingWork = drainSignal({ startPromise: this.#startPromise, hooks: this.#hooks, inflight: this.#inflight });
    const inFlight = await settleWithin(pendingWork, drainDeadline);
    const drain = inFlight === 'timeout' ? 'isolated' : inFlight === 'none' ? 'none' : 'settled';
    if (inFlight === 'timeout') this.#isolated = true;
    const managed = this.#inflight.stats();
    // Anything still open loses its write eligibility here; its receipts can no longer commit.
    this.#inflight.clear();
    // Every timer this host armed is cleared inside the same stop budget; a timer that survived stop() could write
    // against a released lock.
    this.#clock.stopAll();
    const store = await this.#closeStore(deadline);
    const ownership = await this.#releaseOwnership(deadline);
    if (this.#machine.state === 'stopping') this.#machine.transition('stopped');
    this.#stoppedAt = this.#now();
    return Object.freeze({
      teamId: this.#teamId,
      state: this.#machine.state,
      epoch: this.#epochValue,
      drain,
      inFlight,
      inflight: { opened: managed.opened, completed: managed.completed, withheld: managed.opened - managed.completed },
      store,
      ownership,
      timedOut: inFlight === 'timeout' || store === 'isolated' || ownership === 'isolated',
      isolated: this.#isolated,
      failed: this.#failed ? { ...this.#failed } : null,
      budgetMs: timeoutMs,
      durationMs: monotonicNow() - startedAt,
      at: this.#stoppedAt,
    });
  }

  /**
   * A completed operator verdict can reopen only a previously successful recovery, never a broken one.
   *
   * Three classes reach this gate: 'business' (a write: needs admission), 'operator' (an adjudication entry that keeps
   * admission irrelevant) and 'read' (an authorized query that mutates nothing: a live owned host is still required,
   * but a frozen team or a pending adjudication must not make inspection impossible - F1 R5-5).
   */
  executeAuthorized(kind, work) {
    if (this.#machine.state !== 'running' || !this.#ownership?.verify().ok || this.#token?.revoked) failWith('WRITE_REVOKED', 'host authority is revoked');
    if (!['business','operator','read'].includes(kind)) failWith('INVALID_COMMAND', 'unclassified write');
    if (kind === 'business' && !this.#admission) failWith('ADMISSION_CLOSED', 'recovery or completion holds admission closed');
    return work();
  }

  refreshAdmission() {
    if (this.#machine.state !== 'running' || !this.#ownership?.verify().ok) failWith('WRITE_REVOKED', 'admission refresh requires a live owner');
    this.#admission = this.#recovery?.status === 'ok' && !this.#config.core.store.list('completion:').some(row => ['prepared', 'authorized', 'unknown'].includes(row.status));
    return this.#admission;
  }

  /** The command gateway; the class comes from the registry and authorization runs inside it. */
  command(request, options = {}) {
    const result = this.#gateway.command(request, options);
    this.#cycle?.kick('gateway'); // Reached only after a successful external commit (including receipt replay).
    return result;
  }

  /**
   * Open a managed in-flight token bound to one dispatch: { operationId, command, entityId, actor }.
   * Opening runs the same authorization as dispatching that command, so a closed admission cannot mint a token that
   * bypasses it; the token can then only carry that operation's own receipt.
   */
  openInflight(spec = {}) {
    return openManagedOperation({ gateway: this.#gateway, inflight: this.#inflight, authorize: this.#authorize, spec,
      state: this.#machine.state, epoch: this.#epochValue, now: this.#now });
  }

  mountHook(name, handler) {
    return this.#hooks.mount(name, handler, () => this.#assertMountable());
  }

  unmountHook(name) {
    return this.#hooks.unmount(name);
  }

  onStateChange(listener) {
    if (typeof listener !== 'function') failWith('INVALID_HOOK', 'a state listener must be a function');
    return this.#machine.onChange(listener);
  }

  /** Read-only diagnostic source; installing it never installs a consumer or grants write authority. */
  observeVisibility(status) {
    if (this.#visibilityStatus) failWith('VISIBILITY_MOUNTED', 'one visibility observer per host');
    if (typeof status !== 'function') failWith('INVALID_CONFIG', 'visibility status must be a function');
    this.#visibilityStatus = status;
  }

  status() {
    const handle = this.#ownership;
    return buildStatus({
      teamId: this.#teamId,
      epoch: this.#epochValue,
      machineState: this.#machine.state,
      admission: this.#admission,
      failed: this.#failed,
      lastError: this.#lastError,
      listenerErrors: this.#listenerErrors,
      inflight: this.#inflight.stats(),
      recovery: this.#recovery,
      ownership: {
        dir: this.#dir,
        ...this.#ownerState.snapshot(),
        held: Boolean(handle && handle.owns()),
        released: this.#ownerState.phase === 'released',
        writeEligibility: this.#token && !this.#token.revoked ? 'granted' : 'revoked',
        kind: handle ? handle.kind : null,
        name: handle ? handle.name : null,
        record: handle ? handle.recordPath : null,
      },
      hooks: { mounted: this.#hooks.mounted, inflight: this.#hooks.inflight },
      hookErrors: this.#hooks.errors,
      cycle: this.#cycle ? this.#cycle.status() : null,
      evidenceRetention: this.#evidence ? this.#evidence.status() : null,
      access: this.#access.describe(),
      visibility: this.#visibilityStatus?.() ?? null,
      capability: {
        receipts: 'memory-only',
        receiptScope: 'instance',
        crossRestartIdempotency: false,
        durableWritePort: typeof this.#config.writeSink === 'function' ? 'injected' : 'none',
        persistence: 'M2',
      },
      startedAt: this.#startedAt,
      stoppedAt: this.#stoppedAt,
      history: this.#machine.history,
    });
  }

  #assertMountable() {
    assertMountable({ state: this.#machine.state, failed: this.#failed, token: this.#token, epoch: this.#epochValue });
  }

  async #closeStore(deadline) {
    const store = this.#store;
    this.#store = null;
    return closeStorePort(store, { deadline, record: error => this.#recordError(error) });
  }

  async #releaseOwnership(deadline) {
    return this.#ownerState.release(this.#ownership, {
      deadline,
      record: error => this.#recordError(error),
      onConfirmed: () => {
        this.#ownership = null;
      },
    });
  }

  #assertNotStopping() {
    assertNotStopping(this.#machine.state, this.#controller && this.#controller.signal);
  }

  #recordError(error) {
    this.#lastError = describeError(error, this.#now());
  }

  #recordListenerError(error, step) {
    const record = { ...describeError(error, this.#now()), transition: step.from + '>' + step.to };
    this.#listenerErrors.push(record);
    if (this.#listenerErrors.length > 5) this.#listenerErrors.shift();
    this.#lastError = { code: record.code, message: record.message, at: record.at };
  }
}

/** The only constructor a composition root needs; docs/host-protocol.md §2.1. */
export function createTeamHost(options) {
  return new TeamHost(options);
}