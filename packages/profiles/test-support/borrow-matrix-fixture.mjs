import fs from 'node:fs';
import path from 'node:path';
import { generate, applyTeamProfile } from '../index.mjs';
import { host, loadBuild } from '../../adapter-dsh/index.mjs';
import { createClock } from '../../host/index.mjs';

/**
 * Shared composition for the public-entry support-matrix acceptance.
 *
 * Everything here goes through the product's public entry: the generated profile (packages/profiles/index.mjs generate),
 * the native host adapter and applyTeamProfile. No internal runtime/host function is assembled by the test.
 */
export const MATRIX_SPEC = Object.freeze({ team: true, guard: true, goalCheck: true, autonomy: 'on', collab: 'on',
  superagentBorrow: 'v1', intentSemantics: 'root-decision-v1' });

/** A clock whose only deviation is that the effect runner's own timeout fires in 5 ms once armed. */
export function createTimeoutClock() {
  const base = createClock();
  let compressed = false;
  return Object.freeze({
    now: () => base.now(),
    every: (ms, fn, label) => base.every(ms, fn, label),
    after: (ms, fn, label) => base.after(compressed && label === 'effect-timeout' ? 5 : ms, fn, label),
    stopAll: () => base.stopAll(),
    get stopped() { return base.stopped; },
    get size() { return base.size; },
    compressTimeouts() { compressed = true; },
  });
}

export async function* completedTurn() {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text: 'safe' };
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'safe' } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}
export const never = () => new Promise(() => {});

/**
 * Boot one public profile instance. Options are the documented profile seam (clock/gc/ftp guards/verifiers); the
 * transport is a fake adapter registered on the public llm service, never a gateway.
 */
export async function openMatrixProfile(root, options = {}) {
  const { sessionId, transportContract = 'execution-permit/1', trusted = true, stream = null, gc = null, gcIntervalMs = 20,
    clock = null, verifyOwnerTerminated = null, verifyExternalStop = null, resume = false } = options;
  if (!fs.existsSync(path.join(root, 'cordis.patch.yml'))) generate(root, MATRIX_SPEC);
  const entries = JSON.parse(fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8'))[0].insert;
  const stack = await host(root, { prepared: true });
  // The Loader would apply the generated entries; this in-process composition does the same two steps by hand, as the
  // existing public candidate does: boundary-only loop and a completion-guard service.
  stack.ctx.agentLoop.config.instantInterrupt = false;
  Object.defineProperty(stack.ctx, 'goals', { value: { registerCompletionGuard: () => () => {} }, configurable: true });
  const handle = resume
    ? await stack.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'offline', model: 'model' } })
    : await stack.create({ sessionId, agentOptions: { provider: 'offline', model: 'model' }, meta: { cwd: root } });
  const module = await loadBuild('dsh-llm');
  let requests = 0;
  const adapter = new class extends stack.LlmAdapter {
    providerInfo(id) { return { id, name: 'offline matrix' }; }
    async prepareCall(provider, id) {
      return { model: { provider, id, name: id, contextWindow: 1e6, inputModalities: ['text'] }, stream: call => this.stream(call) };
    }
    async *stream(call) {
      requests += 1;
      const chosen = stream ? stream(call, requests) : completedTurn();
      if (chosen && typeof chosen[Symbol.asyncIterator] === 'function') { for await (const chunk of chosen) yield chunk; }
      else { await chosen; yield* completedTurn(); }
    }
  }();
  if (transportContract !== null) adapter.executionPermitContract = transportContract;
  // The trusted-execution-target registration is a separate gate from the declared contract: an adapter can declare
  // execution-permit/1 and still not be a target this build has admitted through registerExecutionTarget.
  if (trusted) module.registerExecutionTarget(adapter);
  stack.ctx.llm.registerAdapter(['offline'], adapter);
  const credential = {};
  let runtime = null, serial = 0;
  const configuration = {
    ...entries.find(entry => entry.id === 'team-runtime').config,
    home: root, ownerSessionId: sessionId, lifecycleIntervalMs: 20, gcIntervalMs,
    ...(clock ? { clock } : {}), ...(gc ? { gc } : {}),
    ...(verifyOwnerTerminated ? { verifyOwnerTerminated } : {}),
    ...(verifyExternalStop ? { verifyExternalStop } : {}),
    authenticateHumanInput: candidate => candidate === credential
      ? { teamId: runtime?.core?.configuration?.teamId ?? '', ownerSessionId: sessionId, authenticatedEntry: 'owner-user-input' }
      : null,
  };
  applyTeamProfile(stack.ctx, configuration);
  runtime = stack.ctx.teamRuntime;
  await runtime.ready;
  let stopped = false;
  return Object.freeze({
    stack, handle, runtime, credential, teamId: runtime.core.configuration.teamId,
    requests: () => requests,
    agent: handle.agent,
    async send(summary) {
      const operationId = 'v1:operation:matrix-' + Date.now() + '-' + (++serial);
      const result = await runtime.humanInput.send({ operationId, recipient: 'member:root', purpose: 'status', summary }, credential);
      return { operationId, result };
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      try { await runtime.stop(); } finally {
        try { await handle.dispose(); } finally { await stack.ctx.fiber.dispose(); }
      }
    },
  });
}

/** Poll a public status condition without touching the store. */
export async function until(predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) throw Error('timeout waiting for ' + label);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
