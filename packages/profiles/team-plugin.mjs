import { installRuntime, installOwnerGuard } from './runtime.mjs';
import { v1BuildCapability } from './borrow-entry-support.mjs';
import { resolveOwnerModel } from './llm-execution.mjs';
import { activateHost, prepareHost } from './host-driver.mjs';
import { ControlStore } from '../store/index.mjs';
import { initializeBorrowPolicy } from './borrow-policy.mjs';
import { TeamCore, GoalGate } from '../core/index.mjs';
import { createGitGuardRunner } from '../delivery/index.mjs';
import { collabConfig, autonomyConfig, superagentBorrowConfig, borrowOptions, assertProtocolSupported, assertBorrowPreconditions } from '../contracts/index.mjs';

export const name = 'p3b-team-runtime';

/** Inert D-pack wiring factory. F must stop the old driver before calling this.
 * sessionIdOf resolves the hook's initiating agent through the supported native adapter, never currentInitiator.
 */
export function registerHostVisibility(ctx, visibility, { sessionIdOf, newMessageId, markDirty, host = null, pathOf }) {
  // F2b: the dispatch capability is reported per production path, so the caller must say which path a request took.
  // A silent 'other' default made every capability read "adapter-unconfirmed" no matter what actually carried the
  // request; the composition root is the only place that knows the answer.
  if (typeof pathOf !== 'function') {
    throw Object.assign(Error('INVALID_CONFIG: registerHostVisibility needs pathOf(event) to classify the dispatch path'), { code: 'INVALID_CONFIG' });
  }
  // One check at registration. markDirty is visibilityDirty and needs the host; discovering a mis-wiring inside
  // tools/pre-execute would turn "the tool gap is never marked" into "every tool call fails after its result was
  // produced", which is the worse of the two failures (review 2 #2).
  visibility.dirty.assert(markDirty, host);
  const disposers = [];
  disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    const message = await visibility.preStep(sessionIdOf(payload), newMessageId());
    return message ? { ...decision, messages: [...(decision.messages ?? []), message] } : decision;
  }));
  disposers.push(ctx.on('llm/stream', (options, next) => {
    return (async function* () {
      const release = visibility.candidate(options);
      try { yield* next(); } finally { release(); }
    })();
  }));
  // A forwarded event has no proof of which adapter call created it. Never infer it from
  // the context firing this callback. Unidentified auxiliary prepared is refused by visibility;
  // transports supporting auxiliary retention must keep the call's source-bound dispatch closure.
  disposers.push(ctx.on('llm/dispatch', event => { visibility.dispatch(event, pathOf(event)); }));
  disposers.push(ctx.on('tools/pre-execute', async (execution, next) => {
    const decision = await next();
    // The mark is audit-side: a failing kick is swallowed here so the tool's own decision always stands (review 2 #2).
    visibility.dirty.mark(markDirty, sessionIdOf(execution), host);
    return decision;
  }));
  return () => { visibility.stop(); for (const dispose of disposers) if (typeof dispose === 'function') dispose(); };
}
// tokenMeter is injected so the native observation can read the supported context-pressure API directly instead of
// reaching through the projection registry, which 0.2.2 deprecated. Cordis refuses an uninjected service access, so the
// observation would silently record nothing rather than fall back.
/**
 * Resolve the member-workspace hook the profile was configured with.
 *
 * The Loader writes the profile entry as JSON, so a deployment cannot hand a function across the boundary: the
 * config names a module (a file URL) and the export inside it. A test or a plugin that applies the profile
 * in-process may pass the function itself, which is the same hook one step earlier.
 */
async function resolveMemberWorkspace(configuration) {
  const value = configuration.memberWorkspace;
  if (value === undefined || value === null) return { memberWorkspace: null, workspaceRoot: configuration.workspaceRoot ?? null };
  if (typeof value === 'function') {
    return { memberWorkspace: value, workspaceRoot: configuration.workspaceRoot ?? null };
  }
  if (typeof value === 'object' && typeof value.module === 'string' && value.module !== '') {
    const loaded = await import(value.module);
    const hook = loaded[value.export ?? 'memberWorkspace'];
    if (typeof hook !== 'function') {
      throw Object.assign(Error('INVALID_CONFIG: ' + value.module + ' does not export a memberWorkspace function'), { code: 'INVALID_CONFIG' });
    }
    return { memberWorkspace: hook, workspaceRoot: value.workspaceRoot ?? configuration.workspaceRoot ?? null };
  }
  throw Object.assign(Error('INVALID_CONFIG: memberWorkspace must be a function or { module, export }'), { code: 'INVALID_CONFIG' });
}

export const inject = ['goals', 'tools', 'agents', 'sessionProjections', 'tokenMeter', 'sessions', 'llm'];

/**
 * Install a fail-closed committed-state completion guard; 08 §4.9.
 *
 * The collaboration switch (11 §2) lives in this profile's config, validated by the same frozen-contract style the
 * rest of the repository uses. Omitted, it is "off": no new tool, no intent guard, no snapshot block, and the tool
 * catalog is the object it was before the experiment existed.
 */
export function assertBoundaryInputRuntime(ctx) {
  const target = v1BuildCapability(undefined);
  const loop = ctx.get?.('agentLoop') ?? ctx.agentLoop;
  if (loop?.config?.instantInterrupt !== false) {
    throw Object.assign(Error('PATCH_MISSING: v1 requires the boundary-only agent loop (instantInterrupt=false)'), { code: 'PATCH_MISSING' });
  }
  return target.boundaryWake;
}

export function apply(ctx, configuration) {
  // F2a: there is one driver. The F1 switch is deleted, and a configuration that still names one is refused before
  // anything is created - a stale profile patch must not be able to boot a different execution shape silently.
  if (configuration.driver !== undefined) {
    throw Object.assign(Error('INVALID_CONFIG: the driver option was removed in F2'), { code: 'INVALID_CONFIG' });
  }
  // P0: the autonomy contract is resolved before the mount creates anything, so a profile patch carrying a value the
  // contract refuses fails the profile instead of a command later. Nothing reads the result yet - P1-P6 do - and every
  // default is today's behaviour, so an existing configuration resolves to the runtime it already had.
  const autonomy = autonomyConfig({
    ...(configuration.autonomy === undefined ? {} : { autonomy: configuration.autonomy }),
    ...(configuration.goalGate === undefined ? {} : { goalGate: configuration.goalGate }),
    ...(configuration.stopGraceMs === undefined ? {} : { stopGraceMs: configuration.stopGraceMs }),
    ...(configuration.stopProofTimeoutMs === undefined ? {} : { stopProofTimeoutMs: configuration.stopProofTimeoutMs }),
    ...(configuration.decisionTtlMs === undefined ? {} : { decisionTtlMs: configuration.decisionTtlMs }),
    ...(configuration.budget === undefined ? {} : { budget: configuration.budget }),
    ...(configuration.pricing === undefined ? {} : { pricing: configuration.pricing }),
  });
  // P0 of the super-agent borrow design (§2): the protocol position is resolved and refused before the mount creates
  // anything. A build that has no v1 consumer, or that cannot point the owner at the model the deployment named, fails
  // here instead of running HEAD's behaviour while reporting the new protocol; an omitted option writes nothing, so a
  // profile that never names the borrow resolves to the runtime it already had.
  const borrowGiven = borrowOptions(configuration);
  const borrow = Object.keys(borrowGiven).length ? superagentBorrowConfig(borrowGiven) : null;
  if (borrow) assertProtocolSupported(borrow);
  if (borrow?.superagentBorrow === 'v1') {
    assertBorrowPreconditions({ team: true, guard: typeof ctx.tools?.guard === 'function' && typeof ctx.tools?.definitions === 'function', goalCheck: typeof ctx.goals?.registerCompletionGuard === 'function', autonomy: autonomy.autonomy, collab: configuration.collab ?? 'off' });
    assertBoundaryInputRuntime(ctx);
  }
  // F1: one team runtime per context. A second apply would install a second driver, a second store handle and a second
  // completion guard on the same context; the first line refuses it before anything is created. ctx.get is the only
  // safe probe: reading ctx.teamRuntime without declare() throws in cordis, which would fail the first, legitimate
  // apply as well.
  let already = null;
  try {
    already = typeof ctx.get === 'function' ? ctx.get('teamRuntime') : null;
  } catch {
    already = null;
  }
  if (already) {
    throw Object.assign(Error('TEAM_HOST_MOUNTED: this context already provides teamRuntime'), { code: 'TEAM_HOST_MOUNTED' });
  }
  const runtime = {};
  ctx.provide('teamRuntime', runtime);
  const initialize = async () => {
    // The hook is resolved before anything is created, so a bad configuration fails the profile instead of
    // failing one member's lifecycle effect later.
    const workspace = await resolveMemberWorkspace(configuration);
    const prepared = await prepareHost(ctx, { ...configuration, ...workspace });
    const root = prepared.root;
    // Include construction in the cleanup boundary: even an open failure must release host ownership.
    let store;
    try {
      store = new ControlStore(root);
      // §2: the stored policy is read before admission opens, and a team whose history was written under another
      // protocol is refused instead of being reinterpreted. Off over an old no-policy database writes nothing; only
      // a proved pristine v1 team gets an initial row. Existing history needs an explicit saved migration.
      initializeBorrowPolicy(store, prepared.teamId, borrow?.superagentBorrow ?? 'off');
      const collab = collabConfig({ collab: configuration.collab ?? 'off', ...(configuration.decisionLimit === undefined ? {} : {decisionLimit: configuration.decisionLimit}), ...(configuration.assumptionDeadline === undefined ? {} : {assumptionDeadline: configuration.assumptionDeadline}) });
      // §22: the intent window is a documented tunable of the collaboration switch (collab.mjs: five minutes by
      // default, bounded 1s..1h) but the profile never forwarded it, so a deployment could not shorten it. The offline
      // collaboration stage needs exactly that: it closes each window by moving the one server clock past it, and a
      // five-minute move also expires every attempt lease (60s), which the stage is not measuring. Forwarding the same
      // option the contract test already sets keeps the policy in the configuration instead of in a script.
      const core = new TeamCore(store, {}, { enabled: true, attach: true, teamId: prepared.teamId,
        lifecycleIntentTimeoutMs: configuration.lifecycleTimeoutMs ?? 120000,
        ...(configuration.intentWindowMs === undefined ? {} : { intentWindowMs: configuration.intentWindowMs }), ...collab,
        // P1: the switch and its TTL reach the core, which is the only place that reads them. Off is the default, so
        // a profile that names nothing resolves to the runtime it had before this package existed.
        autonomy: autonomy.autonomy, decisionTtlMs: autonomy.decisionTtlMs,
        ...(borrow?.superagentBorrow === 'v1' ? { ...borrow, repositories: configuration.repositories ?? [], threadEventLimit: configuration.threadEventLimit } : {}),
        // P6 appendix 6 deviation 2, closed in P2: the validated budget and price table reach the core. Without these
        // two lines a deployment's unknownGraceMs and pricing were validated and then dropped, so every team silently
        // ran on the contract defaults.
        budget: autonomy.budget, pricing: autonomy.pricing,
        // P3 §12 U5 / P5 §7.2.3: the other three validated fields had the same defect. `goalGate` is what
        // commands/goals.mjs goalGateSettings() and tools.mjs read (a deployment that asked for strict was silently given
        // the default false), and the two stop budgets are what native.mjs reads before it asks the platform for a proof.
        goalGate: autonomy.goalGate, stopGraceMs: autonomy.stopGraceMs, stopProofTimeoutMs: autonomy.stopProofTimeoutMs });
      // The Git runner is a port (core reads configuration.ports.gitGuard): delivery exports the factory, the profile
      // injects it here, so core no longer imports delivery (check-deps: cycle broken, §WP-C 3).
      const gate = new GoalGate(core, violation => ctx.emit('team/goal-violation', violation),
        { gitGuard: createGitGuardRunner({ roots: configuration.gitRoots ?? [root] }) });
      // P3 §12 U7: the model entry may adjudicate a completion token, but only on the session journal. The gate is the
      // one reader of that journal (a live session from this context's registry, or the offline log port it was given),
      // so the profile publishes it as a port: the tool entry asks the same reader instead of either believing a
      // model-supplied proof or being unable to answer at all.
      if (typeof core.ports.sessionJournal !== 'function') core.ports.sessionJournal = options => {
        const sessionId = typeof options === 'string' ? options : options?.sessionId ?? null;
        const live = sessionId ? ctx.sessions.get(sessionId) ?? null : null;
        return gate.journal(live ?? sessionId);
      };
      // P9: the resolved switch table (the price table included) is published with the runtime, so a sibling plugin reads
      // what this profile validated instead of reaching into the core's configuration.
      const preparedRoleGuard = borrow?.superagentBorrow === 'v1' ? installOwnerGuard({ ctx, core,
        authorize: (kind, work) => runtime.host.executeAuthorized(kind, work), route: id => runtime.router?.route(id),
        borrow: { ...borrow, teamId: prepared.teamId }, currentScope: () => runtime.executionScopes?.current() }) : null;
      if (preparedRoleGuard) {
        preparedRoleGuard.bindOwnerSession(prepared.ownerSessionId);
        runtime.roleGuard = preparedRoleGuard;
      }
      const ownerModelSelection = borrow?.ownerModel ? await resolveOwnerModel({ ownerModel: borrow.ownerModel,
        ctx, ownerSessionId: prepared.ownerSessionId }) : null;
      Object.assign(runtime, { core, gate, store, collab: collab.collab, autonomy, pricing: autonomy.pricing }, installRuntime(ctx, core, { authorize: (kind, work) => runtime.host.executeAuthorized(kind, work), route: id => runtime.router?.route(id), ownerSessionId: prepared.ownerSessionId, ownerModelSelection, preparedRoleGuard }));
      Object.assign(runtime, await activateHost({ ctx, core, gate, runtime, configuration: { ...configuration, ...workspace, root }, registerVisibility: registerHostVisibility, prepared }));
      return runtime;
    } catch (error) {
      // Each cleanup is attempted even if another fails; preserve the original refusal (and its code).
      // Close our store before relinquishing ownership so a new host cannot race this handle.
      const cleanupErrors = [];
      for (const close of [() => runtime.roleGuard?.revoke(), () => (runtime.store ?? store)?.close(),
        () => prepared.ownership.release(), () => prepared.manager.close()]) {
        try { await close(); } catch (failure) { cleanupErrors.push(failure); }
      }
      if (cleanupErrors.length) error.cleanupErrors = cleanupErrors;
      throw error;
    }
  };
  runtime.ready = initialize();
  runtime.kickLifecycle = () => runtime.host?.cycle?.kick('command');
  ctx.on('dispose', async () => { await runtime.ready; await runtime.stop(); });
}
