import { refreshContext } from './context-reader.mjs';
import { Projection, ownerSessionLive, serve, submit } from '../projections/index.mjs';
import { submitDeliveryReconciliation } from '../host/index.mjs';
export const inject = ['teamRuntime'];
/** Wire read-only projections and isolated authorized transport; 08 §1.2, §5. */
export async function apply(ctx, config) {
  await ctx.teamRuntime.ready;
  const runtime = ctx.teamRuntime, core = runtime.core;
  const pricing = config.pricing ?? runtime.pricing ?? core.configuration?.pricing ?? null;
  const projection = new Projection(core.store, {
    recentLimit: config.recentLimit ?? 256, pricing, protocol: core.configuration?.superagentBorrow === 'v1' ? 'v1' : 'off',
    maxRuns: core.configuration?.maxRuns ?? null, roleGuard: () => runtime.roleGuard ? runtime.roleGuard.status() : null,
    ownerSession: ownerSessionLive(runtime.host ? { host: runtime.host, router: runtime.router } : {}),
    routeSession: sessionId => runtime.router?.route(sessionId),
    leaderSession: () => {
      const route = runtime.router?.routeOwner(runtime.host?.ownerSessionId);
      return route?.routed && route.teamId === runtime.host.teamId ? runtime.host.ownerSessionId : null;
    },
    commandPolicy: { enabled: core.configuration.enabled, collab: core.configuration.collab ?? 'off',
      intentProtocol: core.configuration.superagentBorrow === 'v1' ? 'root-decision-v1' : null },
    readerIdentity: { teamId: runtime.host?.teamId ?? core.configuration?.teamId ?? null,
      serviceId: 'projection-http:' + (config.port ?? 40292) },
  });
  // Ownership starts in the constructor, not after listen(): every subsequent initialization step is covered.
  let transport = null, projectionTimer = null, contextTimer = null, disposing = null;
  let phase = 'initializing', initializationError = null, lastSyncAt = null, lastFailure = null, syncFailures = 0, stoppedAt = null;
  let lastSuccessfulSyncSeq = projection.seq;
  const describe = error => error ? { code: error.code ?? error.message, message: error.message } : null;
  const status = () => ({ state: phase, readerId: projection.reader.id, identity: projection.reader.identity ?? null,
    appliedSeq: projection.seq, lastSuccessfulSyncSeq, lastSyncAt, stoppedAt, syncFailures,
    initializationError, lastSyncError: describe(projection.lastSyncError), lastFailure,
    warnings: initializationError ? [{ code: 'PROJECTION_INITIALIZATION_FAILED', reader: projection.reader.id, error: initializationError }]
      : projection.lastSyncError && phase === 'running' ? [{ code: 'PROJECTION_SYNC_FAILED', reader: projection.reader.id, error: describe(projection.lastSyncError) }] : [],
  });
  const dispose = () => {
    clearInterval(projectionTimer); clearInterval(contextTimer);
    if (!disposing) disposing = (async () => {
      let primary = null;
      try { await transport?.close(); } catch (error) { primary = error; }
      try { projection.close(); } catch (error) { if (!primary) primary = error; else primary.cleanupErrors = [...(primary.cleanupErrors ?? []), error]; }
      stoppedAt = Date.now(); if (phase !== 'failed') phase = 'stopped';
      if (primary) throw primary;
    })();
    return disposing;
  };
  try {
    runtime.projectionStatus = status;
    ctx.on('dispose', dispose);
    contextTimer = config.contextDatabase ? setInterval(() => refreshContext(core, config.contextDatabase), 250) : null;
    contextTimer?.unref();
    const principals = new Map(Object.entries(config.sessions).map(([token, binding]) => [token,
      runtime.bindPrincipal(typeof binding === 'string' ? { teamId: runtime.host.teamId, memberId: binding } : binding)]));
    const local = identity => identity?.teamId === runtime.host.teamId ? identity.memberId : null;
    const scoped = {
      snapshot(identity) { const actor = local(identity); return actor ? { ...projection.snapshot(actor), teamId: runtime.host.teamId, viewer: identity } : { teamId: null, data: null }; },
      events(identity, seq, options) { const actor = local(identity); return actor ? projection.events(actor, seq, options).map(event => ({ ...event, teamId: runtime.host.teamId })) : []; },
      // M6 P12/P2: the two read-only routes. They go through the same scoped identity as snapshot/events, so a
      // principal that is not local to this team can read neither the timeline nor a binding.
      activity(identity, query) { const actor = local(identity); return actor ? projection.activity(actor, query) : { events: [], total: 0, categories: [] }; },
      binding(identity, sessionId) { const actor = local(identity); return actor ? projection.binding(actor, sessionId) : null; },
      recentLimit: projection.recentLimit, replayBoundary: () => projection.replayBoundary(),
    };
    const command = (identity, payload) => {
      const actor = local(identity); if (!actor) throw Error('NOT_ROUTED');
      if (payload.name === 'completion.resolve') return runtime.adjudicate(payload.args, identity);
      const receipt = runtime.host.executeAuthorized(['mailbox.resolveUnknown','delivery.reconcile'].includes(payload.name) ? 'operator' : 'business', () => submit(core, actor, payload, { reconcile: submitDeliveryReconciliation }));
      if (receipt.status === 'accepted') runtime.kickLifecycle?.();
      return receipt;
    };
    transport = await serve(scoped, command, { port: config.port, sessions: principals, origin: config.origin, origins: config.origins });
    if (disposing) {
      await transport.close();
      throw Object.assign(Error('projection disposed during initialization'), { code: 'PROJECTION_INITIALIZATION_CANCELLED' });
    }
    // Consume while idle, and publish failures even when no HTTP request is made.
    projectionTimer = setInterval(() => {
      try { projection.sync(); projection.lastSyncError = null; lastSyncAt = Date.now(); lastSuccessfulSyncSeq = projection.seq; }
      catch (error) { projection.lastSyncError = error; syncFailures++; lastFailure = { ...describe(error), at: Date.now() }; }
    }, 100);
    projectionTimer.unref?.();
    ctx.provide('teamProjections', { projection, transport, status });
    if (disposing) throw Object.assign(Error('projection disposed during publication'), { code: 'PROJECTION_INITIALIZATION_CANCELLED' });
    phase = 'running';
  } catch (error) {
    phase = 'failed'; initializationError = { ...describe(error), at: Date.now() };
    try { await dispose(); } catch (failure) { error.cleanupErrors = [...(error.cleanupErrors ?? []), failure]; }
    throw error;
  }
}
