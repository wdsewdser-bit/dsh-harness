import { pathToFileURL } from 'node:url';
import { chunks } from '../fixtures/fake-provider.mjs';
import { buildTarget } from '../../packages/adapter-dsh/build-target.mjs';

/**
 * The product-path helpers shared by the two P4 acceptance plugins.
 *
 * F2b: the scripts drive the team the way the product does - public commands, the host's own cycle and effect runner,
 * and durable messages. The removed harness outlets (runtime.lifecycle, core.schedule, bindAgent) have no stand-in
 * here on purpose: a member exists because its intent was confirmed, and its native execution is the host's effect.
 */

/** Submit one public command the way the gateway does; the operation id is the caller's durable request identity. */
export function commands(runtime) {
  return (name, entityId, extra = {}) => runtime.host.command({ teamId: runtime.host.teamId, actor: 'root',
    requestId: entityId, operationId: 'v1:operation:' + entityId.replaceAll(':', '-').padEnd(20, 'x'),
    payload: { command: name, entityId, ...extra } });
}

/** Poll a committed fact; the acceptance hosts take most of a minute cold, so the budget is generous. */
export async function until(predicate, what, timeoutMs = 90000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > end) throw Error('TIMEOUT: ' + what);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/**
 * Ask the host for one member and return its bound execution once the intent is confirmed.
 *
 * Only members the team does not have yet are requested: the intent reducer refuses a second intent for the same
 * member, and the fixture and the scenario can both run against one host.
 */
export async function requestMember(runtime, name, role) {
  const memberId = 'member:' + name;
  if (!runtime.store.read(memberId)?.nativeRef) {
    commands(runtime)('team.member.request', 'member-intent:' + name, { role });
    await until(() => runtime.store.read('member-intent:' + name)?.status === 'confirmed', 'member-intent:' + name + ' confirmed');
  }
  return until(() => runtime.handles.get(memberId), 'native execution for ' + memberId);
}

/**
 * The scripted offline provider both acceptance hosts answer their sessions with.
 *
 * The class must come from the same build the host loaded, or its instanceof checks reject the instance; buildTarget()
 * is that build, so the plugins run unchanged on the 0.2.2-alpha.2 C1 build and on 0.2.2-rc.1. The adapter joins the team-dispatch/2 contract
 * exactly as the production adapters do: the host's visibility flush decides from those phases alone, and no script
 * writes a manifest row or a visible fact itself (design §F 接线约束 2/3).
 *
 * Plugins load concurrently and both halves of the acceptance host may ask for it, so a duplicate registration is not
 * fatal: the first one wins and answers every session identically.
 */
export async function registerOfflineAdapter(ctx, text) {
  const { LlmAdapter, DISPATCH_CONTRACT, dispatchAttemptOf } = await import(pathToFileURL(buildTarget().base + 'dsh-llm/lib/index.js'));
  let requests = 0;
  const adapter = new class extends LlmAdapter {
    dispatchContract = DISPATCH_CONTRACT;
    providerInfo(id) { return { id, name: id }; }
    async prepareCall(provider, id) { return { model: { provider, id, name: id, context: { contextWindow: 100000 }, inputModalities: ['text'] },
      stream(options) { return (async function* () {
        requests++;
        const attempt = dispatchAttemptOf(options);
        attempt?.phase('send-started', { transmission: 1, sendStartedAt: Date.now() });
        attempt?.phase('committed', { transmission: 1, httpStatus: 200, accepted: 'accepted' });
        yield* chunks({ type: 'text', text }, 100);
      })(); } }; }
  }();
  try { ctx.llm.registerAdapter(['offline'], adapter); }
  catch (error) { if (!/already registered/.test(String(error?.message))) throw error; }
  return { requests: () => requests };
}
