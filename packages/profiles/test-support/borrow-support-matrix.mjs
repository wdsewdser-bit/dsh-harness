import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generate, borrowEntrySupport, BORROW_TRANSPORT_CONTRACT } from '../index.mjs';
import { buildTarget, loadBuild } from '../../adapter-dsh/index.mjs';
import { openMatrixProfile, createTimeoutClock, completedTurn, MATRIX_SPEC } from './borrow-matrix-fixture.mjs';
import { cleanupOrThrow } from './temp-roots.mjs';

/**
 * Public-entry support matrix of super-agent borrow v1 (gap 2 of docs/decisions/superagent-borrow-integration.md).
 *
 * The matrix is derived, not invented: buildTarget(build, { boundaryWakeOnly: true }) is the only build decision point
 * and BORROW_TRANSPORT_CONTRACT is the only transport the profile drives through the managed execution path. In this
 * tree exactly one combination is supported (a prepared 0.2.2-alpha.2 build with a trusted execution-permit/1
 * transport); every other combination is refused at the public entry with PATCH_MISSING or
 * EXECUTION_TRANSPORT_UNCONTROLLED.
 *
 * The rejection half runs in-process. The restart/reclaim half uses a child process that boots the same public profile
 * and exits while an owner turn and a real gc effect are still in flight: nothing is torn down, so the second boot is a
 * real restart, not a stop/start pair.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const worker = path.join(here, 'borrow-matrix-worker.mjs');
const replayWorker = path.join(here, 'borrow-matrix-replay-worker.mjs');
// The mutation wrapper re-runs this file directly (no extra test-runner process) with one scenario selected.
const only = process.env.MATRIX_ONLY ?? null;
const selected = name => !only || name.includes(only);
const dirs = [];
const fresh = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borrow-matrix-')); dirs.push(dir); return dir; };
test.after(() => cleanupOrThrow(dirs));

/** A second build path whose dsh-llm is a physical copy and whose other packages are junctions: the module instance is
 * distinct from the selected build, while its imports still resolve. Used to prove registry answers are build-local. */
function isolatedLlmBuild() {
  const build = fs.mkdtempSync(path.join(os.tmpdir(), 'borrow-build-llm-'));
  dirs.push(build);
  const source = buildTarget().base;
  const base = build + '/node_modules/@deepseek-ai/';
  fs.mkdirSync(base, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(base, entry.name);
    if (entry.name === 'dsh-llm') fs.cpSync(from, to, { recursive: true, dereference: true });
    else fs.symlinkSync(fs.realpathSync(from), to, 'junction');
  }
  return build;
}

/** A build shaped like a release this tree cannot drive: copy the capability markers, then break one contract. */
function syntheticBuild(mutate) {
  const build = fs.mkdtempSync(path.join(os.tmpdir(), 'borrow-build-'));
  dirs.push(build);
  const base = build + '/node_modules/@deepseek-ai/';
  for (const rel of ['dsh/package.json', 'dsh-llm/lib/index.js', 'dsh-agent-loop/lib/index.js',
    'dsh-tool-executor-native/package.json', 'dsh-tool-executor-native/lib/index.js',
    'dsh-tool-executor-preempt/package.json', 'dsh-tool-executor-preempt/lib/index.js']) {
    const from = path.join(buildTarget().build, 'node_modules/@deepseek-ai', rel);
    const to = path.join(base, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  mutate({ base, build });
  return build;
}

test('matrix: one supported build x transport is declared, every other combination is refused at the public entry',
  { skip: !selected('matrix: one supported build') }, async () => {
  const selected = buildTarget().build;
  // No real adapter: the build is supported, but transport trust is explicitly unverified. A declaration string can
  // never stand in for a registration.
  const supported = await borrowEntrySupport({ build: selected });
  assert.equal(supported.supported, true, JSON.stringify(supported));
  assert.equal(supported.version, buildTarget().version);
  assert.equal(supported.executor, 'dsh-tool-executor-native');
  assert.equal(supported.boundaryWake?.contract, 'boundary-wake/1');
  assert.equal(supported.runtimeTrust, 'unverified');
  assert.equal(supported.activation, 'runtime-trust-unverified');

  // Only a real adapter registered in this build's own registry may be called verified.
  const module = await loadBuild('dsh-llm');
  const adapter = module.registerExecutionTarget({ executionPermitContract: BORROW_TRANSPORT_CONTRACT });
  const verified = await borrowEntrySupport({ build: selected, transport: adapter });
  assert.equal(verified.supported, true, JSON.stringify(verified));
  assert.equal(verified.runtimeTrust, 'verified');
  assert.equal(verified.transport, BORROW_TRANSPORT_CONTRACT);
  assert.equal(module.isExecutionTargetTrusted(adapter), true);

  // A caller-supplied boolean is ignored: an unregistered object that claims to be trusted stays untrusted.
  const selfReported = { executionPermitContract: BORROW_TRANSPORT_CONTRACT, trusted: true };
  const untrusted = await borrowEntrySupport({ build: selected, transport: selfReported });
  assert.equal(untrusted.supported, false);
  assert.equal(untrusted.runtimeTrust, 'untrusted');
  assert.equal(untrusted.code, 'EXECUTION_TRANSPORT_UNCONTROLLED');
  assert.equal(module.isExecutionTargetTrusted(selfReported), false);

  // An adapter registered with build A is not a target of build B: the answer comes from the queried build's registry.
  const otherBuild = isolatedLlmBuild();
  const crossBuild = await borrowEntrySupport({ build: otherBuild, transport: adapter });
  assert.equal(crossBuild.supported, false, JSON.stringify(crossBuild));
  assert.equal(crossBuild.runtimeTrust, 'untrusted');
  assert.equal(crossBuild.code, 'EXECUTION_TRANSPORT_UNCONTROLLED');

  // Registered but without the contract declaration is still refused; the object's own declaration wins and there is
  // no argument that can override it.
  const noContract = module.registerExecutionTarget({});
  const mismatch = await borrowEntrySupport({ build: selected, transport: noContract, transportContract: BORROW_TRANSPORT_CONTRACT });
  assert.equal(mismatch.supported, false);
  assert.equal(mismatch.code, 'EXECUTION_TRANSPORT_UNCONTROLLED');
  assert.equal(mismatch.transport, null);

  // A contract changed while the registry import is pending must not be combined with the later registration: the
  // result must describe one instant, not the pre-await declaration plus the post-await identity.
  const raceBuild = isolatedLlmBuild();
  const raceModule = await import(pathToFileURL(path.join(raceBuild,
    'node_modules/@deepseek-ai/dsh-llm/lib/index.js')).href);
  const raceAdapter = { executionPermitContract: BORROW_TRANSPORT_CONTRACT };
  const pending = borrowEntrySupport({ build: raceBuild, transport: raceAdapter });
  raceAdapter.executionPermitContract = 'legacy';
  raceModule.registerExecutionTarget(raceAdapter);
  const raced = await pending;
  assert.equal(raced.transport, 'legacy', 'the current declaration, not the pre-await one');
  assert.equal(raced.supported, false, JSON.stringify(raced));
  assert.equal(raced.runtimeTrust, 'verified', 'the adapter is registered now');
  assert.equal(raced.code, 'EXECUTION_TRANSPORT_UNCONTROLLED');

  // An unregistered object's contract getter is never executed: the registry check comes first and the query resolves
  // to a refusal instead of rejecting.
  const hostile = { get executionPermitContract() { throw Error('getter must not run'); } };
  let getterResult;
  await assert.doesNotReject(async () => { getterResult = await borrowEntrySupport({ build: selected, transport: hostile }); },
    'an unregistered contract getter must not be executed');
  assert.equal(getterResult.supported, false);
  assert.equal(getterResult.runtimeTrust, 'untrusted');
  assert.equal(getterResult.code, 'EXECUTION_TRANSPORT_UNCONTROLLED');
  const badBuild = syntheticBuild(({ base }) => fs.writeFileSync(base + 'dsh-llm/lib/index.js', 'export const nothing = true;\n'));
  let badGet = 0;
  const badGetter = { get executionPermitContract() { badGet += 1; return BORROW_TRANSPORT_CONTRACT; } };
  const badResult = await borrowEntrySupport({ build: badBuild, transport: badGetter });
  assert.equal(badResult.supported, false);
  assert.equal(badResult.code, 'PATCH_MISSING');
  assert.equal(badGet, 0, 'a build refused before the transport must not read its contract');
  assert.equal(badResult.transport, null);

  // Supported build, unsupported transport: the same adapter gate the profile applies per call.
  const transport = await borrowEntrySupport({ build: selected, transport: { executionPermitContract: null } });
  assert.equal(transport.supported, false);
  assert.equal(transport.code, 'EXECUTION_TRANSPORT_UNCONTROLLED');

  // The release before 0.2.2 has no dispatch contract and no executor packages; a prepared copy that lost a marker is
  // refused by the identical predicate, before any store, profile or host is created. The last three break capabilities
  // the boundary-wake branch alone does not read: execution-permit, the declared version and the instantInterrupt loop
  // surface.
  const variants = {
    'no-dispatch-contract': ({ base }) => fs.writeFileSync(base + 'dsh-llm/lib/index.js', 'export const nothing = true;\n'),
    'no-native-executor': ({ base }) => fs.rmSync(base + 'dsh-tool-executor-native/package.json'),
    'no-atomic-idle-latch': ({ base }) => {
      const file = base + 'dsh-agent-loop/lib/index.js';
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('this.activityDone = driver.promise', 'this.activityDone = null'));
    },
    'no-execution-permit': ({ base }) => {
      const file = base + 'dsh-llm/lib/index.js';
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('withExecutionCall', 'legacyExecutionCall'));
    },
    'wrong-version': ({ base }) => {
      const file = base + 'dsh/package.json';
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...manifest, version: '0.2.2-alpha.3' }));
    },
    'no-instant-preempt-surface': ({ base }) => {
      const file = base + 'dsh-agent-loop/lib/index.js';
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('preemptSignal', 'legacySignal'));
    },
  };
  for (const [label, mutate] of Object.entries(variants)) {
    const build = syntheticBuild(mutate);
    const refused = await borrowEntrySupport({ build });
    assert.equal(refused.supported, false, label);
    assert.equal(refused.code, 'PATCH_MISSING', label + ': ' + JSON.stringify(refused));
    const root = path.join(fresh(), 'profile');
    const prior = process.env.DSH_UPSTREAM_BUILD;
    process.env.DSH_UPSTREAM_BUILD = build;
    try {
      assert.throws(() => generate(root, MATRIX_SPEC), error => error.code === 'PATCH_MISSING', label);
    } finally {
      if (prior === undefined) delete process.env.DSH_UPSTREAM_BUILD; else process.env.DSH_UPSTREAM_BUILD = prior;
    }
    assert.equal(fs.existsSync(path.join(root, 'cordis.patch.yml')), false, 'a refused build writes no profile');
  }
});

test('matrix: restart keeps in-flight H and real IO unknown, refuses unproven/timeout/stop reclaim, then a bound proof reclaims and re-admits',
  { timeout: 180000, skip: !selected('matrix: restart keeps') }, async () => {
  const root = fresh();
  const child = spawnSync(process.execPath, [worker, root], { encoding: 'utf8', timeout: 90000, env: process.env });
  const errorFile = path.join(root, 'matrix-receipt-error.json');
  assert.equal(child.status, 0, (fs.existsSync(errorFile) ? fs.readFileSync(errorFile, 'utf8') : '') + child.stdout + child.stderr);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, 'matrix-receipt.json'), 'utf8'));
  const teamId = receipt.teamId;
  const ownerEpoch = receipt.slotHostEpoch;
  const ioEpoch = receipt.effectHostEpoch;
  assert.equal(receipt.effectTeamId, teamId);

  // The trusted operator proof. It binds the exact claim: effect identity, call/attempt identity, team and the claim's
  // own host epoch. A proof for another identity is not accepted, and the product passes the persisted claim identity
  // (not the restarted host's current epoch) to this verifier.
  const ownerProof = evidenceRef => async ({ slot, evidenceRef: ref }) => slot?.holderKind === 'owner-request' &&
    slot.teamId === teamId && slot.hostEpoch === ownerEpoch && slot.callIdentity === receipt.callIdentity &&
    slot.originRef === receipt.originRef && ref === evidenceRef;
  const ioProof = evidenceRef => async args => args.effectId === receipt.gcEffectId && args.fence === receipt.gcFence &&
    args.startedAt === receipt.gcStartedAt && args.teamId === teamId && args.hostEpoch === ioEpoch &&
    args.attemptId === receipt.effectAttemptId && args.evidenceRef === evidenceRef;
  const goodOwnerRef = 'external-owner:' + receipt.callIdentity + ':terminated';
  const goodIoRef = 'external-io:' + receipt.gcEffectId + ':' + receipt.gcFence;

  const mode = { hold: false, release: null };
  const stream = () => {
    if (!mode.hold) return completedTurn();
    return new Promise(resolve => { mode.release = () => { mode.hold = false; resolve(); }; });
  };
  const clock = createTimeoutClock();
  const profile = await openMatrixProfile(root, { sessionId: 'matrix-owner', gc: () => new Promise(() => {}),
    gcIntervalMs: 1000000, clock, stream,
    verifyOwnerTerminated: ownerProof(goodOwnerRef), verifyExternalStop: ioProof(goodIoRef) });
  try {
    const status = () => profile.runtime.status();

    // 1. Restart is not a stop proof: both durable occupations survived, unknown, and new admission is closed.
    assert.equal(status().capacity.admissionClosed, true, JSON.stringify(status().capacity));
    assert.equal(status().capacity.human.current, 1);
    const ownerOccupant = status().capacity.occupants.find(row => row.ref === receipt.slotRef);
    assert(ownerOccupant, 'the owner control slot is recovered, not dropped');
    assert.equal(ownerOccupant.state, 'unknown');
    assert.equal(status().effects.admissionClosed, true);
    const ioOccupant = status().effects.occupants.find(row => row.effectId === receipt.gcEffectId);
    assert(ioOccupant, 'the real gc IO is recovered as occupied');
    assert.equal(ioOccupant.unknown, true);

    // 1b. Admission attempts while the unknown is unsettled never start a turn or a provider request: the gate is the
    //     durable occupation, not the caller's willingness to ask again.
    const whileUnknown = profile.requests();
    for (let attempt = 0; attempt < 3; attempt += 1) await profile.send('attempt while unknown ' + attempt);
    assert.equal(profile.requests(), whileUnknown, 'no provider request while an unknown occupies a lane');
    assert.equal(status().capacity.human.current, 1);
    assert.equal(status().capacity.admissionClosed, true);

    // 2. No proof (a timeout/elapsed label, a forged ref, a ref bound to another call) never releases and never opens
    //    admission; the same holds for the effect lane and for a replayed claim identity.
    for (const ref of ['timeout', 'elapsed', 'external-owner:forged:terminated',
      'external-owner:' + receipt.callIdentity + ':replayed-for-another-call']) {
      await assert.rejects(profile.runtime.ownerControl.reclaim(receipt.slotRef, ref),
        error => error.code === 'STOP_NOT_CONFIRMED', ref);
    }
    assert.equal(status().capacity.human.current, 1);
    assert.equal(status().capacity.admissionClosed, true);
    await assert.rejects(profile.runtime.runner.reclaim(receipt.gcEffectId, 'elapsed'),
      error => error.code === 'STOP_NOT_CONFIRMED');
    await assert.rejects(profile.runtime.runner.reclaim(receipt.gcEffectId,
      'external-io:' + receipt.gcEffectId + ':' + (receipt.gcFence + 1)), error => error.code === 'STOP_NOT_CONFIRMED');
    assert.equal(status().effects.activeIO, 1, 'timeout-like evidence must not free real IO');

    // 3. The bound proof reclaims the effect lane, and replaying it is refused.
    await assert.doesNotReject(profile.runtime.runner.reclaim(receipt.gcEffectId, goodIoRef));
    assert.equal(status().effects.activeIO, 0);
    await assert.rejects(profile.runtime.runner.reclaim(receipt.gcEffectId, goodIoRef), error => error.code === 'UNKNOWN_IO');

    // 4. The bound proof reclaims H; admission opens only after every unknown occupation is gone.
    await assert.doesNotReject(profile.runtime.ownerControl.reclaim(receipt.slotRef, goodOwnerRef));
    assert.equal(status().capacity.human.current, 0);
    assert.equal(status().capacity.unknown, 0);
    assert.equal(status().capacity.admissionClosed, false);
    await assert.rejects(profile.runtime.ownerControl.reclaim(receipt.slotRef, goodOwnerRef),
      error => error.code === 'STOP_NOT_CONFIRMED');

    // 5. Re-admission through the same public entry: a new authenticated human input opens one owner turn, the trusted
    //    transport terminates, and H is returned.
    const before = profile.requests();
    await profile.send('after trusted reclaim');
    await assertEventually(() => profile.requests() > before, 'a new owner request is admitted');
    await assertEventually(() => status().capacity.human.current === 0 && status().capacity.admissionClosed === false,
      'the re-admitted turn releases H');
    assert(profile.runtime.store.list('control-slot:').filter(row => row.state === 'released').length >= 1);

    // 6. A real effect timeout and runner.stop are logical isolation only: unknown occupancy stays, admission stays
    //    closed, and timeout-like evidence still cannot reclaim.
    mode.hold = true;
    const held = profile.requests();
    await profile.send('hold after re-admission');
    await assertEventually(() => profile.requests() > held, 'the second owner turn starts');
    clock.compressTimeouts();
    const triggered = profile.runtime.gc.trigger('matrix-timeout');
    assert.equal(triggered.ok, true);
    await assertEventually(() => status().effects.occupants.some(row => row.effectId === triggered.effectId && row.unknown === true),
      'the timed-out gc IO stays occupied');
    await assert.rejects(profile.runtime.runner.reclaim(triggered.effectId, 'elapsed'),
      error => error.code === 'STOP_NOT_CONFIRMED');
    const beforeStop = status().effects.activeIO;
    assert(beforeStop >= 1);
    profile.runtime.runner.stop();
    assert.equal(status().effects.activeIO, beforeStop, 'runner.stop never returns a real IO slot');
    assert.equal(status().effects.occupants.some(row => row.effectId === triggered.effectId), true);
    assert.equal(status().capacity.admissionClosed, true);

    // 7. A second restart after a successful reclaim cannot replay the old proof. The released claim is not an
    //    occupation any more, and the restarted host must not accept the evidence that released its predecessor. It
    //    runs in a fresh process: the live session id belongs to the parent process until it disposes its host.
    mode.release?.();
    await profile.stop();
    const replay = spawnSync(process.execPath, [replayWorker, root], { encoding: 'utf8', timeout: 60000, env: process.env });
    const replayError = path.join(root, 'matrix-replay.json');
    assert.equal(replay.status, 0, (fs.existsSync(replayError) ? fs.readFileSync(replayError, 'utf8') : '') + replay.stdout + replay.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(replayError, 'utf8')), { ok: true, bad: [] });
  } finally {
    mode.release?.();
    await profile.stop();
  }
});

test('matrix: an uncontrolled transport fails closed before any provider request and never becomes success',
  { timeout: 60000, skip: !selected('matrix: an uncontrolled transport') }, async () => {
  const root = fresh();
  let requests = 0;
  const profile = await openMatrixProfile(root, { sessionId: 'matrix-uncontrolled', transportContract: null,
    stream: () => { requests += 1; return completedTurn(); } });
  try {
    await profile.send('uncontrolled transport');
    // Wait for either outcome: the refusal closes admission, or a broken gate asks the provider. The assertion that
    // follows is the security property, and it is the one a mutation must break.
    await assertEventually(() => profile.requests() > 0 || profile.runtime.status().capacity.admissionClosed === true,
      'the unmanaged transport closes admission without a provider request');
    assert.equal(requests, 0, 'no provider request is made');
    // The owner turn is the product's own wake; the refusal happens at the transport boundary, so the turn carries no
    // provider response and the durable outcome can only be unknown. The refusal code is published on the turn event.
    const events = JSON.stringify(profile.agent.session.snapshotEvents());
    assert.match(events, /EXECUTION_TRANSPORT_UNCONTROLLED/);
    assert.doesNotMatch(events, /block-end/);
    assert.equal(profile.runtime.status().ownerControl.unknown, true);
    assert.equal(profile.runtime.status().capacity.human.unknown, 1);
    assert.equal(profile.runtime.store.list('execution-outcome:').every(row => row.state === 'unknown'), true);
    assert.equal(profile.runtime.status().ownerControl.transportContract, BORROW_TRANSPORT_CONTRACT);
  } finally {
    await profile.stop();
  }

  // The second gate: the adapter declares execution-permit/1 but was never registered as a trusted execution target.
  // The build patch accepts the contract, so only the profile's trust check can refuse this one.
  const untrustedRoot = fresh();
  let untrustedRequests = 0;
  const untrusted = await openMatrixProfile(untrustedRoot, { sessionId: 'matrix-untrusted', trusted: false,
    stream: () => { untrustedRequests += 1; return completedTurn(); } });
  try {
    await untrusted.send('untrusted execution target');
    await assertEventually(() => untrusted.requests() > 0 || untrusted.runtime.status().capacity.admissionClosed === true,
      'the untrusted transport closes admission without a provider request');
    assert.equal(untrustedRequests, 0, 'an unregistered execution target is never asked for a request');
    assert.match(JSON.stringify(untrusted.agent.session.snapshotEvents()), /EXECUTION_TRANSPORT_UNCONTROLLED/);
    assert.equal(untrusted.runtime.status().ownerControl.unknown, true);
  } finally {
    await untrusted.stop();
  }
});

async function assertEventually(predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) assert.fail('timed out: ' + label);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
