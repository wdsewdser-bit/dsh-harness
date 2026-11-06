import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pairs } from '../fixtures/fake-provider.mjs';
import { pathToFileURL } from 'node:url';
import { bootProfile } from '../../packages/profiles/index.mjs';
import { buildTarget } from '../../packages/adapter-dsh/build-target.mjs';
import { id } from '../../packages/contracts/index.mjs';
import { applyLifecycle } from '../../packages/core/native.mjs';
import { snapshot, bindManifest } from '../../packages/core/snapshot.mjs';
import { chunks } from '../fixtures/fake-provider.mjs';

/** Run replaceable scripted transport through native Cordis AgentLoop; 08 §7.3. */
export async function hostScenario(root, provider = null) {
  // F2a: there is one driver. This script exercises the product profile itself - the F1 harness switch and its
// `lifecycle()` outlet are gone; member lifecycle below goes through the core domain function the host ports use.
const { ctx, actual } = await bootProfile(root, { team: true, guard: true, goalCheck: true });
  // The scripted adapter must extend the same dsh-llm instance the selected build registered; a second copy would
  // pass its own instanceof checks and silently drive a different release. buildTarget() is the same switch bootProfile
  // reads, so the adapter and the boot can never disagree about which build is under test.
  const { LlmAdapter, DISPATCH_CONTRACT, dispatchAttemptOf } = await import(pathToFileURL(buildTarget().base + 'dsh-llm/lib/index.js'));
  const runtime = ctx.teamRuntime;
  let requests = 0;
  let active = null;
  const payloads = [];
  const started = Date.now();
  const script = async (options, state) => {
    pairs(options);
    payloads.push(structuredClone({ ...options, signal: undefined }));
    const ordinal = state.calls++;
    // Members 1 and 2 act on their second call; the other two only read and answer.
    if (ordinal > 1 || (ordinal === 1 && state.index !== 1 && state.index !== 2)) return chunks({ type: 'text', text: 'offline complete' }, 100);
    // Every member reads the team first. The read is what commits a request context: a responsibility is visible to
    // its recipient only after the request that carried the snapshot committed, so the acting step has to be the
    // second one - the same order a real model follows (read, then answer).
    let name = 'team_read';
    let argumentsValue = { view: 'team' };
    if (ordinal === 1 && state.index === 1) {
      name = 'team_message';
      argumentsValue = { operationId: id('operation'), expectedRevision: 0, op: 'send', to: 'member:host-2', kind: 'action',
        summary: 'publish cross-group interface', expectedOutcome: 'interface checkpoint', deadline: new Date(Date.now() + 30000).toISOString() };
    }
    if (ordinal === 1 && state.index === 2) {
      // The visibility flush is asynchronous: wait for the record to land, then read the revision it produced (accept
      // carries an expectedRevision, and a revision read before the flush is a CAS_CONFLICT against our own work).
      const target = runtime.store.list('message:')[0];
      await until(() => runtime.store.read(target.entityId)?.visible === true, 'message visible');
      const message = runtime.store.read(target.entityId);
      name = 'team_message';
      argumentsValue = { operationId: id('operation'), expectedRevision: message.revision, op: 'accept',
        messageId: message.entityId, checkpointRef: 'checkpoint:interface' };
    }
    return chunks({ type: 'tool-call', id: 'call-' + state.index, name, arguments: JSON.stringify(argumentsValue) }, 100);
  };

  // F2b: the adapter joins the dispatch-phase contract exactly as the production DeepSeek adapter does. The host's
  // flush reads those phases (prepared -> send-started -> committed) and writes the manifest through
  // lifecycle().visibility(...); the script never writes a visibility record or a manifest itself.
  ctx.llm.registerAdapter(['offline'], new class extends LlmAdapter {
    dispatchContract = DISPATCH_CONTRACT;
    providerInfo(id) { return { id, name: id }; }
    async prepareCall(providerName, id) {
      return { model: { provider: providerName, id, name: id, contextWindow: 100000, inputModalities: ['text'] },
        stream(options) { return (async function* () {
          requests++;
          const attempt = dispatchAttemptOf(options);
          if (process.env.P3B_DEBUG) trace.push(['attempt', Boolean(attempt), options.sessionId, Object.keys(options).length]);
          attempt?.phase('send-started', { transmission: 1, sendStartedAt: Date.now() });
          attempt?.phase('committed', { transmission: 1, httpStatus: 200, accepted: 'accepted' });
          // F2b: the injection is the product's. The script asserts what the host put in front of the model and never
          // writes the visibility record itself (the manifest row, the visible write and its audit row all belong to
          // the host's lifecycle route - design §F 接线约束 3).
          const team = (options.messages ?? []).filter(m => m.source?.kind === 'trusted-team-plugin');
          for (const message of team) assert(message.content?.[0]?.text?.length > 0, 'the host injected a team snapshot');
          if (team.length) injected += 1;
          // Two turns can be live at once (a mailbox delivery opens the recipient's turn while the sender is still
          // running), so the scripted state is resolved from the snapshot message this request carries, not from
          // whichever agent stepped last.
          const state = bySession.get(options.sessionId) ?? active;
          if (process.env.P3B_DEBUG) trace.push([options.sessionId ?? null, state?.index ?? null, (options.messages ?? []).length]);
          yield* await (provider ?? script)(options, state);
        })(); } };
    }
  }());
  // F2b: the script submits public commands and observes. Member creation, native agent creation, attempt scheduling
  // and the dispatch wake are the host cycle's work; the script never calls schedule(), tick() or a lifecycle outlet.
  let injected = 0;
  const states = new Map();
  const until = async (predicate, what) => {
    for (let tries = 0; tries < 1500; tries += 1) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw Error('TIMEOUT: ' + what + ' ' + JSON.stringify({ msgs: runtime.store.list('message:').length, requests, r1: handles[1]?.agent.session.snapshotEvents(
    )
          .filter(e => e.type === 'turn/end' || e.type === 'tool/result').map(e => [e.type, JSON.stringify(e.data ?? {}).slice(0, 200)]), state:
            runtime.host.state,
          intents: runtime.store.list('member-intent:').map(i => [i.entityId, i.status]), attempts: runtime.store.list('attempt:').map(a => [a.taskId ?? null,
            a.status,
              a
              .entityId]), effects: runtime.store.list('task:').map(t => [t.entityId, t.status]) }));
  };
  const trace = [];
  const raw = [];
  ctx.on('llm/dispatch', event => { if (raw.length < 2) raw.push(structuredClone(event)); });
  const bySession = new Map();
  ctx.on('agent/pre-step', async (payload, next) => {
    const state = [...runtime.handles].filter(([, handle]) => handle.agent === payload.agent)
      .map(([memberId]) => states.get(Number(memberId.slice('member:host-'.length)))).find(Boolean) ?? null;
    if (state) { active = state; bySession.set(payload.agent.session.id, state); }
    return next();
  });
  const command = (name, entityId, extra = {}) => runtime.host.command({ teamId: runtime.host.teamId, actor: 'root',
    requestId: entityId, operationId: 'v1:operation:' + entityId.replaceAll(':', '-').padEnd(20, 'x'),
    payload: { command: name, entityId, ...extra } });
  const handles = [];
  // The whole roster exists before any work starts: a later member is the recipient of an earlier member's message, and
  // the product refuses a message to a member that is not on the roster yet (UNKNOWN_MEMBER).
  for (const [index, role] of ['worker', 'worker', 'worker', 'verifier'].entries()) {
    command('team.member.request', 'member-intent:host-' + index, { role });
    await until(() => runtime.store.read('member-intent:host-' + index)?.status === 'confirmed', 'member intent ' + index);
    await until(() => runtime.handles.get('member:host-' + index), 'native agent ' + index);
    const h = runtime.handles.get('member:host-' + index);
    states.set(index, { index, calls: 0, agent: h.agent });
    handles.push(h);
  }
  // Member 2 is given its work by member 1's message: the product turns the delivery into a mailbox task of its own,
  // so asking for a second task for the same member would queue behind the turn the message already opened.
  for (const index of [0, 1, 3]) {
    command('team.task.request', 'task:host-' + index, { owner: 'member:host-' + index });
    // A mailbox delivery may open the turn before this loop reaches it, so the fact to wait for is the attempt the
    // host scheduled for the task - not that it is still running when we look.
    await until(() => runtime.store.list('attempt:').some(row => row.taskId === 'task:host-' + index), 'host-scheduled attempt ' + index);
    await handles[index].agent.whenIdle();
    await ctx.sessions.flush(handles[index].agent.session);
    if (index === 1) {
      await until(() => runtime.store.list('attempt:').some(row => row.owner === 'member:host-2'), 'mailbox attempt for member 2');
      await handles[2].agent.whenIdle();
      await ctx.sessions.flush(handles[2].agent.session);
    }
  }
  if (process.env.P3B_DEBUG) {
    const dispatch = runtime.store.effects().find(e => e.id.startsWith('dispatch:'));
    console.log(JSON.stringify({ requests, calls: [...states].map(([i, s]) => i + ':' + s.calls).join(','),
      phases: handles.map(h => [h.agent.session.id, h.agent.phase]),
      bindings: [...(runtime.preempt?.bindings?.keys?.() ?? [])],
      counters: runtime.preempt?.counters ?? null,
      messages: runtime.store.list('message:').map(m => [m.entityId.slice(-6), m.status, m.visible, m.accepted]),
      manifests: runtime.store.list('manifest:').length,
      visibility: runtime.visibility?.status?.() ?? null,
      audit: runtime.visibility?.audit?.().filter(a => a.type === 'evidenceMissing').map(a => [a.reason, a.name, String(a.message).slice(0, 120)]).slice(0, 3),
      raw: raw.map(e => [e.contract ?? null, e.phase ?? null, e.kind ?? null, typeof e.attempt, typeof e.sessionId, e.purpose ?? null, e.transmission ?? null]),
      trace: trace.slice(0, 6),
      results: handles.map((h, i) => [i, h.agent.session.snapshotEvents().filter(e => e.type === 'tool/result').map(e => e.data.message.content[0].text.slice(0,
              70))]) }));
  }
  if (!provider) assert.equal(requests, 10, 'two reads plus the coordinating pair, one call per member turn');
  assert(injected >= 4);
  const messages = runtime.store.list('message:');
  if (!provider) assert(messages[0].accepted && messages[0].visible);
  const decisionStart = Date.now();
  const issue = runtime.core.thread('member:host-0', ['member:host-3'], 'scripted independent review', new Date(Date.now() + 30000).toISOString()).result;
  runtime.core.reply(issue.entityId, 'member:host-3', 1, 'artifact:scripted-review');
  runtime.core.decide(issue.entityId, 'member:host-0', 1, 'artifact:scripted-conclusion');
  const decisionLatencyMs = Date.now() - decisionStart;
  const events = runtime.store.events();
  const latency = messages.map(m => {
    const visible = events.find(e => e.entity === m.entityId && e.payload.visible);
    const accepted = events.find(e => e.entity === m.entityId && e.payload.accepted);
    return { messageId: m.entityId, storedToVisibleMs: visible.payload.updatedAt - m.createdAt, storedToAcceptedMs: accepted.payload.updatedAt - m.createdAt };
  });
  fs.writeFileSync(root + '/payloads.json', JSON.stringify(payloads, null, 2));
  const metrics = { decisionLatencyMs, latency, workerPeerMessages: messages.length, responsibilityAcceptanceRate: messages.length ? messages.filter(m => m
      .accepted).length / messages.length : null,
    elapsedMs: Date.now() - started, rootRequestChars: payloads.filter((p, i) => i < 2).map(p => JSON.stringify(p).length) };
  metrics.rootContextGrowth = metrics.rootRequestChars.at(-1) - metrics.rootRequestChars[0];
  for (const [index] of handles.entries()) {
    await applyLifecycle(runtime.core, 'member:host-' + index, 'cancel', { keepInbox: index % 2 === 0 });
    await applyLifecycle(runtime.core, 'member:host-' + index, 'dispose');
  }
  await applyLifecycle(runtime.core, 'member:host-1', 'resume');
  const resumed = runtime.handles.get('member:host-1');
  runtime.gate.reconcile(resumed.agent.session);
  await applyLifecycle(runtime.core, 'member:host-1', 'dispose');
  await ctx.fiber.dispose();
  return { requests, injected, actual, metrics, nativeAgents: 4, transport: 'scripted', modelCommunicationValidated: false };
}
