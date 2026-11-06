import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildConfig, buildTarget } from '../adapter-dsh/index.mjs';

/**
 * The public entry support matrix of super-agent borrow v1.
 *
 * This module does not invent a second decision: it projects the capabilities the product already applies, so a
 * deployment, a test and the documentation read the same answer.
 *
 *  - Build. buildTarget(build, { boundaryWakeOnly: true }) is the one version decision point for the boundary-wake
 *    profile (packages/adapter-dsh/build-target.mjs). v1 additionally needs the execution-permit/1 layer to exist in
 *    the selected build (the module that withExecutionCall/isExecutionTargetTrusted come from), the native executor
 *    package generate() mounts, and the agent-loop surface that honours instantInterrupt=false. A build that passes
 *    the boundary-wake check but lacks any of these would otherwise generate a profile that boots and only fails at
 *    the first request, i.e. after the deployment believed v1 was supported.
 *  - Transport. A run is accepted only through a trusted execution target that declares execution-permit/1
 *    (packages/profiles/llm-execution.mjs). The query is asynchronous when a real adapter is supplied: it loads the
 *    selected build's own dsh-llm and asks that module's registry (isExecutionTargetTrusted). A caller's boolean or a
 *    declaration string never upgrades the answer; without a real adapter the only honest result is 'unverified'.
 *
 * The matrix therefore has exactly one supported combination in this tree: a prepared build of the release build/builds.json
 * names (currently 0.2.2-rc.1), carrying
 * llm-dispatch, the boundary wake edge, the native executor and execution-permit, used with a trusted
 * execution-permit/1 transport. Everything else is fail-closed with the code below.
 */
export const BORROW_TRANSPORT_CONTRACT = 'execution-permit/1';
const EXECUTION_PERMIT_MARKERS = Object.freeze(['EXECUTION_PERMIT_CONTRACT', 'withExecutionCall',
  'isExecutionTargetTrusted', 'execution-permit/1']);
const missing = message => Object.assign(Error('PATCH_MISSING: ' + message), { code: 'PATCH_MISSING' });

/**
 * The release borrow v1 is declared for, from build/builds.json — the same configuration every build decision reads.
 * It is never a literal in this file: a release the repository names is a position the product takes, and a missing
 * entry is PATCH_MISSING rather than a silent "the previous release".
 */
export function borrowRelease(config = buildConfig()) {
  const version = config?.borrow?.release;
  if (typeof version !== 'string' || !version) throw missing('build/builds.json names no borrow.release');
  return version;
}

/** Read once for callers that display it; a bad config leaves it null and v1BuildCapability throws on use. */
export const BORROW_BUILD_VERSION = (() => { try { return borrowRelease(); } catch { return null; } })();

/**
 * The shared v1 build-capability check. generate(), the direct team-plugin apply and every recovery start call this
 * one function, so none of them can admit a build the others refuse.
 */
export function v1BuildCapability(build) {
  const target = buildTarget(build, { boundaryWakeOnly: true });
  const declared = borrowRelease();
  if (target.version !== declared) {
    throw missing('borrow v1 is declared only for ' + declared + '; this build is ' + target.version);
  }
  if (target.nativeExecutor !== 'dsh-tool-executor-native') {
    throw missing('the v1 boundary-wake profile needs the dsh-tool-executor-native package');
  }
  if (target.boundaryWake?.contract !== 'boundary-wake/1' || target.boundaryWake?.atomicIdleLatch !== true ||
    target.boundaryWake?.stepAbort !== true) {
    throw missing('the v1 boundary-wake profile needs the atomic idle latch and the instantInterrupt/preemptSignal loop surface');
  }
  const llm = target.base + 'dsh-llm/lib/index.js';
  const source = fs.existsSync(llm) ? fs.readFileSync(llm, 'utf8') : '';
  const absent = EXECUTION_PERMIT_MARKERS.filter(marker => !source.includes(marker));
  if (absent.length) {
    throw missing('the build has no execution-permit/1 layer (dsh-llm lacks ' + absent.join(', ') + ')');
  }
  return target;
}

export async function borrowEntrySupport({ build, transport = null } = {}) {
  let target;
  try {
    target = v1BuildCapability(build);
  } catch (error) {
    // Do not touch the transport here: an invalid build must not execute an unregistered object's getter.
    return Object.freeze({ supported: false, code: error?.code ?? 'PATCH_MISSING',
      reason: String(error?.message ?? error), build: build ?? null, transport: null, runtimeTrust: 'unavailable' });
  }
  const buildFacts = { build: target.build, version: target.version,
    executor: target.nativeExecutor, boundaryWake: target.boundaryWake };
  if (transport === null || transport === undefined) {
    return Object.freeze({ ...buildFacts, transport: null, supported: true, code: null, runtimeTrust: 'unverified',
      activation: 'runtime-trust-unverified',
      reason: 'no real adapter supplied; the build is supported but its transport registration is unverified' });
  }
  // Ask the selected build's own registry. Loading a second build's module answers for that build: an adapter
  // registered with build A is not a trusted target of build B. No property of the transport is read before this
  // registration check, and no await may be inserted after it.
  let module;
  try {
    module = await import(pathToFileURL(target.base + 'dsh-llm/lib/index.js').href);
  } catch (error) {
    return Object.freeze({ ...buildFacts, transport: null, supported: false, code: 'PATCH_MISSING',
      runtimeTrust: 'unavailable',
      reason: 'the selected build cannot load its execution target registry: ' + String(error?.message ?? error) });
  }
  if (typeof module.isExecutionTargetTrusted !== 'function') {
    return Object.freeze({ ...buildFacts, transport: null, supported: false, code: 'PATCH_MISSING',
      runtimeTrust: 'unavailable', reason: 'the selected build has no isExecutionTargetTrusted registry' });
  }
  if (module.isExecutionTargetTrusted(transport) !== true) {
    return Object.freeze({ ...buildFacts, transport: null, supported: false, code: 'EXECUTION_TRANSPORT_UNCONTROLLED',
      runtimeTrust: 'untrusted', reason: 'the adapter is not registered as a trusted execution target of this build' });
  }
  // Registered identity is established; only now read the current declaration, synchronously, so registration and
  // contract describe the same instant.
  const declared = transport.executionPermitContract;
  if (declared !== BORROW_TRANSPORT_CONTRACT) {
    return Object.freeze({ ...buildFacts, transport: declared ?? null, supported: false,
      code: 'EXECUTION_TRANSPORT_UNCONTROLLED',
      runtimeTrust: 'verified', reason: 'the registered adapter does not declare ' + BORROW_TRANSPORT_CONTRACT });
  }
  return Object.freeze({ ...buildFacts, transport: declared, supported: true, code: null,
    runtimeTrust: 'verified', activation: 'supported' });
}
