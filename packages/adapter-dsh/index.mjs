import { pathToFileURL } from 'node:url';
import { failWith } from '../contracts/index.mjs';
import { buildTarget, requirePristine } from './build-target.mjs';
export { buildConfig, buildTarget } from './build-target.mjs';
export { createRoleToolBoundary } from './role-tool-boundary.mjs';

/** The read-only upstream the running build is a patched copy of; selected by DSH_UPSTREAM_BUILD. */
export const upstream = {
  get version() { return buildTarget().version; },
  get root() { return requirePristine(); },
};

/**
 * Load a frozen upstream module through the version boundary; 08 §1.2.
 *
 * The pristine install, not the build: this adapter composes the unpatched upstream host, and the frozen manifest that
 * pins those hashes is computed from the same root. A build only supplies the release the pristine copy must match.
 */
export const load = moduleName => import(pathToFileURL(requirePristine() + moduleName + '/lib/index.js'));

/**
 * Load the module instance the Loader actually boots: the selected build's own copy.
 *
 * `load` above is the pristine reference the frozen hashes are computed from, and for some modules the instance is
 * part of the behaviour: dsh-llm records every agent-loop request in a module-level WeakSet, so a predicate imported
 * from the pristine copy answers false for the build's own requests. Anything compared against a live request must
 * come from this copy (F2b: the visibility main-request gate was wired to the pristine predicate and never matched).
 */
export const loadBuild = moduleName => import(pathToFileURL(buildTarget().base + moduleName + '/lib/index.js'));

/**
 * The offline session log port; design §3.8, host-protocol invariant 7 rule 7.
 *
 * One session's committed journal, read without taking write ownership: the live session when the store already has
 * it, otherwise a read handle on the durable per-session log the mounted persistence plugin owns (the raw file format
 * stays the plugin's business - this adapter never parses a storage generation itself). A journal that cannot be read
 * is reported as null, a log that could only be read in part is reported with complete: false, and the caller must treat
 * either as a missing capability, never as "nothing was completed"; review finding 4.
 */
export async function openSessionLog({ sessionId, context = null, signal = null } = {}) {
  if (typeof sessionId !== 'string' || !sessionId) failWith('INVALID_SESSION', 'openSessionLog needs a session id');
  if (!context) failWith('INVALID_CONFIG', 'openSessionLog needs the composed context');
  const view = (events, complete) => Object.freeze({ sessionId, seq: events.at(-1)?.seq ?? null, events: Object.freeze(events),
    complete, snapshotEvents() { return events; } });
  try {
    const live = context.sessions?.get?.(sessionId);
    // A live in-memory session view is the committed journal by construction, so it is complete by construction.
    if (live && typeof live.snapshotEvents === 'function') return view(live.snapshotEvents(), true);
  } catch {
    /* a store that cannot answer is treated like one that does not have the session */
  }
  const persistence = context.sessionPersistence;
  if (!persistence || typeof persistence.open !== 'function') return null;
  let handle = null;
  try {
    handle = await persistence.open(sessionId, 'read', signal ? { signal } : {});
    const read = await handle.read(signal ? { signal } : {});
    const events = Array.isArray(read?.events) ? read.events : null;
    if (!events) return null;
    // Completeness is proven, not assumed (review finding 4): the handle must declare the read complete, or expose an
    // event count this adapter can compare with what came back. A truncated read is returned with complete: false and
    // the caller treats it as unreadable - never as "nothing was completed".
    const declared = read.complete ?? handle.complete;
    const truncated = read.truncated === true || handle.truncated === true;
    const counted = Number.isInteger(read.eventCount) ? read.eventCount : Number.isInteger(handle.eventCount) ? handle.eventCount : null;
    const complete = truncated ? false : declared === true ? true : declared === false ? false : counted !== null && counted === events.length;
    return view(events, complete);
  } catch {
    return null;
  } finally {
    try {
      await handle?.close?.();
    } catch {
      /* closing a read handle cannot change the answer it already produced */
    }
  }
}

/** Compose the isolated native host and its public adapter ports; 08 §1.2, §3.1, §7.3. */
export async function host(root, { prepared = false } = {}) {
  const runtimeLoad = prepared ? loadBuild : load;
  process.env.DSH_HOME = root + '/home';
  const target = buildTarget();
  const { Context } = await runtimeLoad('cordis');
  const context = new Context();
  const moduleNames = [
    'dsh-session-projection',
    'dsh-session',
    'dsh-llm',
    'dsh-tools',
    // 0.2.2 moved tool execution out of dsh-tools into a plugin that must be mounted exactly once. buildTarget() above
    // makes that package a requirement of the build (PATCH_MISSING without it), so the row is never absent.
    target.nativeExecutor,
    'dsh-system-prompt',
    'dsh-agent',
    'dsh-token-meter',
    'dsh-session-persistence-jsonl',
    'dsh-agent-loop',
  ];
  for (const moduleName of moduleNames) {
    const configuration = moduleName === 'dsh-agent-loop'
      ? { agents: [], maxParallelToolCalls: 1 }
      : moduleName === 'dsh-session-persistence-jsonl'
        ? { root: root + '/home/sessions', compression: 'none', listConcurrency: 4 }
        : moduleName === 'dsh-system-prompt'
          ? {
              includeHarnessIdentity: false,
              includeRuntimeContext: false,
              personaPrefix: 'offline P2',
            }
          // dsh-tools takes no configuration: 0.2.2 declares Config.mode as z.never(), and the executor plugin
          // mounted above is the selection instead.
          : {};
    const plugin = await runtimeLoad(moduleName);
    await context.plugin(plugin.default ?? plugin, configuration).await();
  }
  // The predicate must come from the instance that assembles the requests. This adapter composes the *pristine*
  // upstream host (everything above boots through load), so the marked request objects live in the pristine copy's
  // module-level WeakSet; asking the build's copy answers false for every one of them and the context plugin then
  // classifies every main request as a summary (the P2 context suite caught exactly that after F2b moved this line to
  // loadBuild). The composition root that boots the build asks its own copy (host-driver's mainRequestPredicate).
  const llm = await runtimeLoad('dsh-llm');
  return {
    ctx: context,
    ...llm,
    openSessionLog: options => openSessionLog({ ...options, context }),
    onStream: listener => context.on('llm/stream', listener),
    isMain: llm.isAgentLoopRequest,
    compactNow: (agent, signal) => context.compaction.compactNow(agent, signal),
    replaceSurface: async (session, message, nodes, expectedRevision) => {
      if (context.tokenMeter.measure(session).logRevision !== expectedRevision) {
        throw Error('CAS_CONFLICT');
      }
      const event = session.append('user/message', message, {
        surfaceOp: { op: 'replace', startSeq: nodes[0], endSeq: nodes.at(-1) },
        sourceEventSeqs: nodes,
      });
      await context.sessions.flush(session);
      return event;
    },
    create: options => context.agents.create(options),
    resume: options => context.agents.resume(options),
    derive: session => session.deriveMessages(),
    flush: session => context.sessions.flush(session),
    measure: session => context.tokenMeter.measure(session),
    compactIfNeeded: (agent, signal) => context.compaction.compactIfNeeded(agent, 'pressure', signal),
    async pressure() {
      await context.plugin((await load('dsh-compaction-basic')).default, {
        auto: false,
        thresholdRatio: 0.75,
        retainTokens: 100,
        maxTokens: 1024,
        compactionRetries: 0,
        maxOverflowRetries: 0,
      }).await();
    },
  };
}

/**
 * P6 §8.2.2 / §12 U2 of the team-autonomy design: one reading of what a session has spent, or null when nothing can be
 * measured at all.
 *
 * The source decides what the number means, and the caller must not blur the two:
 *
 *   'usage-event'  the token meter anchored this measurement on provider-reported usage - an exact count;
 *   'delta'        there was no such fact, so this is the meter's own estimate of the request representation. It is
 *                  marked approximate, and no reader may present it as an exact count.
 *
 * A meter that cannot answer at all returns null rather than 0: an unmeasured session is unknown, never free (§8.3).
 */
export function sessionUsage(context, session) {
  if (!context || !session) return null;
  const count = value => (Number.isFinite(value) && value >= 0 ? value : null);
  const revision = Number.isFinite(session.seq) ? session.seq : null;
  let totals = null;
  try {
    // The meter's durable usage fold is the exact answer: one provider-reported sample per settled assistant message,
    // summed with the retry replacement rule, so it is cumulative session spend and it rebuilds from the session log
    // after a restart. stateOf is the supported read (native-observations already reads contextPressure this way); a
    // context whose sessionProjections does not know the unit answers null and falls through to the estimate below.
    totals = typeof context.sessionProjections?.stateOf === 'function' ? context.sessionProjections.stateOf(session, 'tokenUsage') : null;
  } catch { totals = null; }
  if (totals) {
    // Cache traffic is prompt side, exactly as the meter's own pressure definition treats it (input + cache read +
    // cache write); output is the completion side. Both are cumulative, so the caller turns them into an increment.
    const input = (count(totals.uncachedInputTokens) ?? 0) + (count(totals.cacheReadTokens) ?? 0) + (count(totals.cacheWriteTokens) ?? 0);
    const output = count(totals.outputTokens) ?? 0;
    if (input > 0 || output > 0) return Object.freeze({ input, output, source: 'usage-event', approximate: false, logRevision: revision });
  }
  let measured = null;
  try { measured = typeof context.tokenMeter?.measure === 'function' ? context.tokenMeter.measure(session) : null; } catch { measured = null; }
  if (!measured) return null;
  const total = count(measured.totalTokens);
  if (total === null) return null;
  return Object.freeze({ input: total, output: 0, source: 'delta', approximate: true,
    logRevision: Number.isFinite(measured.logRevision) ? measured.logRevision : revision });
}

/**
 * §7.2.2 / §11 item 5 of the team-autonomy design: the OS identity of a session, as this adapter can honestly answer it.
 *
 * The question the design left open ("is a member session an independent OS process?") has one answer for this
 * adapter, and it is no: host() composes a cordis Context in this very process and create/resume are
 * context.agents.create()/resume(), so an agent is an in-process object with a session id and no pid. This function
 * therefore returns null for everything this adapter builds, and exists so that a future adapter which really does
 * start a child process has one place to report { pid, createdAt } from -- the stop proof (§7.2.3) needs a creation
 * time as much as a pid, because a pid alone is reusable.
 */
export function nativeProcessIdentity(session) {
  const handle = session?.process ?? session?.proc ?? null;
  const pid = handle?.pid ?? session?.pid ?? null;
  const createdAt = handle?.createdAt ?? session?.createdAt ?? null;
  if (!Number.isSafeInteger(pid) || pid <= 0 || createdAt === undefined || createdAt === null || createdAt === '') return null;
  return Object.freeze({ pid, createdAt: String(createdAt), image: handle?.image ?? session?.image ?? null });
}

/** Reserve the unimplemented authenticated provider replay port; 08 §3.4, §7.3. */
export function providerReplay() {
  throw Error('TODO_REAL_PROVIDER_REPLAY');
}