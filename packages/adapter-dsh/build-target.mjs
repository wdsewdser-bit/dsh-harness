import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * F2b: the build is never guessed. The suites run against a copy that carries the llm-dispatch candidate (the producer of
 * the llm/dispatch waterfall the visibility chain reads), prepared by verification/prepare-build.mjs. Naming a build that
 * lacks the contract is PATCH_MISSING, not a silent fall back to the unpatched one.
 */
const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const pointerFile = repoRoot + '/runs/m1b-build-current.txt';
const buildsFile = repoRoot + '/build/builds.json';
const failMissing = message => { throw Object.assign(Error('PATCH_MISSING: ' + message), { code: 'PATCH_MISSING' }); };

/**
 * Resolve the one switch that selects which upstream release this repository is wired to; 08 §1.2, §1.3.
 *
 * `DSH_UPSTREAM_BUILD` names a *build*: a copy of an upstream install plus patches. The release the build contains
 * decides how the host must be wired, so every decision below is read from that build's own
 * `@deepseek-ai/dsh/package.json` and from the plugin packages it actually ships, never from the build's path. That
 * is what keeps each 0.2.2 build byte-for-byte identical to its own release's wiring.
 *
 * F2 selects a prepared copy of the configured C1 build with llm-dispatch and instant-preempt added. The release that
 * copy contains is read from its own manifest, so a baseline bump is a change to build/builds.json, never to this file.
 * The explicit override must satisfy the same patch contract; an older or incomplete build fails closed.
 * Executor selection is centralized here rather than inferred from a path or duplicated by composition roots.
 *
 * The roots themselves are configuration, never literals in code: `build/builds.json` holds `default` (the prepared
 * C1 copy this repository runs against; `builds[version]` names the C1/C2 pair of a release; `patches` names the
 * active patch set) and `pristine[version]` (the read-only install a build of that release is a patched copy of). `DSH_BUILD_ROOT` overrides the recorded default. A missing or unreadable
 * builds.json is PATCH_MISSING, not a guessed path.
 */
export function buildConfig() {
  if (!fs.existsSync(buildsFile)) failMissing('build/builds.json is missing; it must name default and pristine builds');
  let config;
  try { config = JSON.parse(fs.readFileSync(buildsFile, 'utf8')); }
  catch (error) { failMissing('build/builds.json is not readable JSON: ' + error.message); }
  if (!config || typeof config !== 'object') failMissing('build/builds.json must be a JSON object');
  return config;
}

/** The build root used when nothing else names one, without a trailing separator; DSH_BUILD_ROOT wins. */
export const defaultBuild = () => {
  const named = process.env.DSH_BUILD_ROOT ?? buildConfig().default;
  if (typeof named !== 'string' || !named) failMissing('build/builds.json has no "default" build root and DSH_BUILD_ROOT is unset');
  return named.replace(/[/\\]+$/, '');
};

/** The selected build root without a trailing separator; no override and no recorded build means the configured default. */
export const selectedBuild = () => {
  const named = process.env.DSH_UPSTREAM_BUILD
    ?? (fs.existsSync(pointerFile) ? fs.readFileSync(pointerFile, 'utf8').trim() : '');
  if (!named) return defaultBuild();
  return named.replace(/[/\\]+$/, '');
};

/**
 * The pristine install of the release a build contains: the read-only boundary it was patched from, or null when the
 * configuration does not name one. Unlike the default build, this is a lookup, not a requirement: a source copy that
 * runs a build it names explicitly (DSH_UPSTREAM_BUILD) needs no configuration file to describe a boundary it never
 * reads, which is exactly what the copies the test fixtures make are.
 */
export const pristineBuild = version => {
  if (!fs.existsSync(buildsFile)) return null;
  const pristine = buildConfig().pristine;
  const root = pristine && typeof pristine === 'object' ? pristine[version] : undefined;
  return typeof root === 'string' && root ? root : null;
};

/**
 * The pristine root a composition is about to load a module from. A missing entry is PATCH_MISSING here, at the entry
 * that needs it, never a module URL built out of 'null' that fails later as "module not found".
 */
export function requirePristine(target = buildTarget()) {
  if (!target.pristine) {
    failMissing('build/builds.json names no pristine install for release ' + target.version + '; the adapter cannot compose the upstream it hashes');
  }
  return target.pristine;
}

/**
 * Describe one build: its release, its own `@deepseek-ai` root, and the executor plugins it ships.
 *
 * 0.2.2 moved tool execution out of `dsh-tools` into a plugin that must be mounted exactly once, and a build that
 * carries step-level preemption ships its own replacement (C2). Every supported release ships
 * `dsh-tool-executor-native`, and a build without it is PATCH_MISSING below rather than a second wiring: since
 * 0.2.1-rc.4 was dropped (M8) there is no release this tree supports that lacks the package.
 */
export function buildTarget(build = selectedBuild(), { boundaryWakeOnly = false } = {}) {
  const base = build + '/node_modules/@deepseek-ai/';
  const manifest = base + 'dsh/package.json';
  if (!fs.existsSync(manifest)) throw Error('NO_UPSTREAM_BUILD:' + build);
  const llm = base + 'dsh-llm/lib/index.js';
  if (!fs.existsSync(llm) || !fs.readFileSync(llm, 'utf8').includes('DISPATCH_CONTRACT')) {
    failMissing(build + ' has no dispatch contract (dsh-llm does not export DISPATCH_CONTRACT); prepare it with verification/prepare-build.mjs');
  }
  const version = JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
  const ships = name => fs.existsSync(base + name + '/package.json');
  const loop = base + 'dsh-agent-loop/lib/index.js';
  const executor = base + 'dsh-tool-executor-preempt';
  const sourceHas = (file, ...markers) => fs.existsSync(file) && markers.every(marker => fs.readFileSync(file, 'utf8').includes(marker));
  let executorManifest = null;
  try { executorManifest = JSON.parse(fs.readFileSync(executor + '/package.json', 'utf8')); } catch {}
  if (!boundaryWakeOnly && (!sourceHas(loop, 'preemptStep(reason = "preempted")', 'const PREEMPTED = Symbol("instant-preempt")',
        'beginPreempt()', 'settlePreempt(', 'instantInterrupt', 'preemptSignal') ||
      !ships('dsh-tool-executor-native') || !fs.existsSync(base + 'dsh-tool-executor-native/lib/index.js') ||
      executorManifest?.name !== '@deepseek-ai/dsh-tool-executor-preempt' || executorManifest?.exports !== './lib/index.js' ||
      !sourceHas(executor + '/lib/index.js', 'NativeToolExecutor', 'executeToolBatch', 'input.agent?.preemptSignal',
        'AbortSignal.any([input.signal, halt])', 'signal: input.signal'))) {
    failMissing(build + ' has no complete instant-preempt agent-loop and executor; prepare it with verification/prepare-build.mjs');
  }
  // S3 (§5.4): the wake edge is a capability of its own, never implied by step preemption.
  //
  // The v1 protocol keeps the atomic idle latch (wakeDriver on an idle phase opens exactly one turn) and stops using
  // the step seam. Reading the two apart is what lets a composition pick 'queue' without pretending the build lost
  // preemption, and what makes a build whose latch is missing fail here instead of at the first wake. The markers are
  // the driver's own published surface (wakeDriver, the phase kind and its idle state), not a new contract string the
  // patch would have to add.
  const loopSource = fs.readFileSync(loop, 'utf8');
  const start = loopSource.indexOf('wakeDriver(wakeAfterAbort = false) {');
  const end = loopSource.indexOf('async whenIdle()', start);
  const wake = start < 0 || end < start ? '' : loopSource.slice(start, end);
  const reserve = wake.indexOf('this.setPhase({');
  const kick = wake.indexOf('this.kick()');
  const atomicIdleLatch = ['if (this.phase.kind !== "idle")', 'return;', 'kind: "running"',
    'new AbortController()', 'this.activityDone = driver.promise'].every(marker => wake.includes(marker)) &&
    reserve >= 0 && kick > reserve && !/instantInterrupt|preemptSignal|preemptStep/.test(wake);
  if (boundaryWakeOnly && !sourceHas(base + 'dsh-tool-executor-native/lib/index.js', 'NativeToolExecutor')) {
    failMissing(build + ' has no native boundary executor');
  }
  if (!atomicIdleLatch) {
    failMissing(build + ' has no atomic idle wake edge (wakeDriver/phase/idle); the boundary-wake capability cannot be used');
  }
  const boundaryWake = Object.freeze({ contract: 'boundary-wake/1', atomicIdleLatch: true,
    stepAbort: loopSource.includes('instantInterrupt') && loopSource.includes('preemptSignal'), wakeOnly: true });
  const pristine = pristineBuild(version);
  return {
    build,
    base,
    version,
    boundaryWake,
    pristine,
    nativeExecutor: ships('dsh-tool-executor-native') ? 'dsh-tool-executor-native' : null,
    preemptExecutor: ships('dsh-tool-executor-preempt') ? 'dsh-tool-executor-preempt' : null,
  };
}
