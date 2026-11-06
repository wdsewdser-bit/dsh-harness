import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunks, deferred } from './probe.mjs';
import { bootProfile } from '../profile-host.mjs';
import { PREPARED } from '../paths.mjs';
import { snapshot } from '../../../packages/core/snapshot.mjs';
import { recordInjection } from '../../../packages/core/provenance.mjs';

/**
 * End-to-end proof of the plugin half: a durable team message is delivered while the recipient's step is
 * streaming, and the whole chain fires — tools.mjs commits, notifies outside the transaction, the watcher admits
 * the delivery, the driver closes the step, and the turn continues with one more request.
 *
 * This is the case that the driver probe cannot cover and that a fake workload cannot reliably produce, because a
 * fake provider streams instantly and the recipient is usually idle when a peer sends. Here the stream parks, so
 * the delivery lands inside a live step by construction.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] ?? '');
assert(root, 'a run directory is required');
fs.mkdirSync(root, { recursive: true });
// The Team runtime resolves dsh-llm through buildTarget, which requires the dispatch contract: the candidate is the
// prepared build, exactly as build-target.mjs selects it, not the bare C2 copy.
process.env.DSH_UPSTREAM_BUILD = PREPARED;
const C2 = PREPARED + '/node_modules/@deepseek-ai/';

const evidence = { case: 'H', requests: [] };
const host = await bootProfile(root + '/host', { team: true, guard: true, goalCheck: true });
// profile-host only boots the Loader; the Team plugin's own initialize() fills the runtime afterwards. Awaiting it is
// what makes a refused host fail here instead of as an undefined core one line later.
await host.ctx.teamRuntime.ready;
const runtime = host.ctx.teamRuntime;
const core = runtime.core;
const { LlmAdapter } = await import('file://' + C2 + 'dsh-llm/lib/index.js');

const hold = deferred();
const held = deferred();
let request = 0;
host.ctx.llm.registerAdapter(['offline'], new class extends LlmAdapter {
  providerInfo(id) { return { id, name: 'scripted-offline' }; }
  async prepareCall(provider, id) {
    // The options must be forwarded: `stream: () => this.stream()` silently hands the adapter an empty call, and
    // every assertion about "what the follow-up request carried" would then be checking an empty array.
    return { model: { provider, id, name: id, contextWindow: 1000000, inputModalities: ['text'] },
      stream: request => this.stream(request) };
  }
  async *stream(options) {
    const index = request++;
    // Record what the model would have seen, which is the only place partial text could leak into a request.
    evidence.requests.push({ index, messages: JSON.stringify((options?.messages ?? []).map(m => m.content)) });
    if (index === 0) {
      // The open text is the partial item a preemption must drop; the hold is what makes the delivery land live.
      for (const chunk of chunks.text(0, 'partial answer that must not survive')) yield chunk;
      held.resolve(true);
      await hold.promise;
      return;
    }
    for (const chunk of chunks.text(0, 'final answer')) yield chunk;
    yield chunks.textEnd(0, 'final answer');
    yield chunks.usage(13, 4);
    yield chunks.finish('stop');
  }
}());


try {
  core.member('member:root', 'root');
  core.member('member:b', 'worker');
  // The harness-only lifecycle() outlet was removed: member lifecycle is driven by the host's durable intents and the
  // ports it installs. Creating through the create port is the same path a host intent takes, and it is what registers
  // the handle this probe reads.
  await core.ports.create({ memberId: 'member:b', sessionId: 'team-preempt-b', cwd: root });
  // The watcher judges a member live only while it carries a host binding; the host driver sets it when it starts the
  // attempt, so the probe supplies the same shape instead of relying on the removed lifecycle() outlet.
  runtime.bindAgent('member:b', { attemptId: 'attempt-h', fence: 1, generation: 1 });
  const agent = runtime.handles.get('member:b').agent;
  runtime.preempt.bind('member:b', agent);

  agent.followup({ id: 'user-h-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'work on the long task' }] });
  await held.promise;
  assert.equal(agent.preemptStats.fired, 0, 'H: nothing has preempted yet');
  assert.equal(agent.phase.kind, 'running', 'H: the step is live while the peer sends');

  // The product's real path: core.send commits the message, and the host's durable delivery effect is the one caller
  // of the arbiter, with the committed id (host-driver.mjs:654/675). core.notifyDelivery is not wired by the product
  // any more - the host is the only dispatcher (packages/profiles/test/profile-driver.test.mjs:34 pins it undefined) -
  // so a probe that relied on the removed fast path observed zero deliveries, not a refused one.
  const first = core.send('member:root', 'member:b', 'info', 'a newer instruction arrived');
  const delivered = runtime.preempt.deliverMail('member:b', first.result.entityId);
  assert.deepEqual({ fired: delivered.fired, wake: delivered.wake }, { fired: true, wake: 'live' },
    'H: the host delivery reached the live step and preempted it');
  const counters = runtime.preempt.snapshot();
  assert.equal(counters.preempts, 1, 'H: one delivery to a live member preempted exactly once');
  // The driver settles the preempted step when the stream closes, so its counters are read after whenIdle();
  // the watcher's counter is what proves the request was accepted while the step was still live.
  assert.equal(agent.preemptSignal?.aborted, true, 'H: the live step closed as soon as the delivery arrived');

  // This delivery lands inside the 2s window the first one opened, so it must be folded, not re-fired.
  const second = core.send('member:root', 'member:b', 'info', 'and a second one');
  const folded = runtime.preempt.deliverMail('member:b', second.result.entityId);
  assert.equal(folded.wake, 'coalesced', 'H: the second host delivery merges into the turn the first one bought');
  assert.equal(runtime.preempt.snapshot().preempts, 1, 'H: two deliveries inside the window buy one request');
  assert.equal(runtime.preempt.snapshot().coalesced, 1, 'H: the second delivery is counted as coalesced');

  hold.resolve();
  await agent.whenIdle();

  assert.equal(evidence.requests.length, 2, 'H: the preempted step is followed by exactly one more request');
  evidence.secondRequest = JSON.parse(evidence.requests[1].messages);
  const journal = agent.session.snapshotEvents();
  const turns = journal.filter(event => event.type === 'turn/end');
  assert.equal(turns.length, 1, 'H: the preemption did not open a second turn');
  assert.notEqual(turns[0].data.reason.kind, 'aborted', 'H: the turn was not aborted');
  // assistant/attempt is the audit record of the raw provider stream and is never part of the derived surface;
  // what matters is that the partial text is not model-visible, so the check is on the derived history and on
  // what the follow-up request would have carried.
  const derived = JSON.stringify(agent.session.deriveMessages());
  assert(!derived.includes('partial answer that must not survive'),
    'H: the half-streamed text never became model-visible content');
  assert(!JSON.stringify(evidence.secondRequest ?? []).includes('partial answer that must not survive'),
    'H: the follow-up request does not carry the abandoned text');
  assert.equal(agent.preemptStats.extraRequests, 1, 'H: the extra request is attributed to the preemption');
  assert.equal(agent.preemptStats.discardedPartialItems, 1, 'H: the open text item is counted as discarded');

  // The message is durable and still claimable at the next ordinary boundary.
  const pending = core.pending('member:b');
  assert(pending.length >= 1, 'H: the delivered message is durable after the preemption');

  // ---- I: a durable delivery to an IDLE member opens its next turn by itself.
  // This is the other half of the real-run gap: five of nine deliveries in the c2 model-contracts run were
  // stored while the recipient sat between turns, and nothing in the plugin started that turn, so each one
  // waited 5.0-6.2 s for whatever scheduled the member next. The wake is the driver's idle edge; what makes it
  // produce a request is the trusted pre-step snapshot, which is the production arrangement.
  {
    core.member('member:c', 'worker');
    // The same creation path as member:b: the removed harness lifecycle() outlet is replaced by the port the host's
    // create intent uses, and the host binds the live agent it just started (host-driver.mjs:928).
    await core.ports.create({ memberId: 'member:c', sessionId: 'team-wake-c', cwd: root });
    runtime.bindAgent('member:c', { attemptId: 'attempt-i', fence: 1, generation: 1 });
    const idle = runtime.handles.get('member:c').agent;
    runtime.preempt.bind('member:c', idle);
    let snapshots = 0;
    host.ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next();
      if (payload.agent !== idle) return decision;
      snapshots++;
      return { ...decision, messages: [...decision.messages, { id: 'snapshot-wake-' + snapshots, role: 'user',
        source: { kind: 'trusted-team-plugin' }, content: [{ type: 'text', text: 'mailbox snapshot' }] }] };
    });
    assert.equal(idle.phase.kind, 'idle', 'I: the member starts idle, with no live step to preempt');
    const requestsBefore = evidence.requests.length;
    const base = runtime.preempt.snapshot();
    const action = core.send('member:root', 'member:c', 'action', 'a durable responsibility',
      { expectedOutcome: 'do the thing', deadline: new Date(Date.now() + 300000).toISOString() });
    const actionId = action.result.entityId;
    // The idle half of the host's delivery: the arbiter sees no live step and opens exactly one turn.
    const woke = runtime.preempt.deliverMail('member:c', actionId);
    assert.equal(woke.wake, 'woke', 'I: the durable delivery opened the idle member at the idle edge');
    const after = runtime.preempt.snapshot();
    assert.equal(after.notLive, base.notLive + 1, 'I: the idle delivery is counted exactly once, as notLive');
    assert.equal(after.woke, base.woke + 1, 'I: and that one notLive became a wake');
    assert.equal(after.preempts, base.preempts, 'I: a wake is not a preemption and buys no preemption count');
    await idle.whenIdle();
    assert.equal(evidence.requests.length, requestsBefore + 1, 'I: the woken turn reached the adapter exactly once');
    // The wake only helps if the woken turn actually carries the mailbox: without that the message would still be
    // invisible and the extra request would be pure cost.
    assert.equal(snapshots, 1, 'I: the woken turn passed through pre-step exactly once and got a mailbox snapshot');
    assert(evidence.requests.at(-1).messages.includes('mailbox snapshot'),
      'I: the only request of the woken turn carried the mailbox snapshot');
    const wakeJournal = idle.session.snapshotEvents();
    assert.equal(wakeJournal.filter(e => e.type === 'turn/start').length, 1, 'I: exactly one turn was opened');
    const ends = wakeJournal.filter(e => e.type === 'turn/end');
    assert.equal(ends.length, 1, 'I: and it closed');
    assert.equal(ends[0].data.reason.kind, 'completed', 'I: the woken turn completed normally');
    assert.equal(idle.preemptStats.fired, 0, 'I: nothing was preempted, so nothing is charged to a preemption');
    // The snapshot hook above stands in for the production request boundary; mark the responsibility visible the
    // way provenance.requestBoundary does, so the next delivery is judged against an empty mailbox.
    // The boundary's evidence must name a manifest the probe really injected (invariant 8): the pre-step port does
    // exactly this at a request boundary, so the probe records the same snapshot and points the visibility at it.
    const candidate = snapshot(core, 'member:c');
    recordInjection(core, candidate, 'native:preempt-wake', ['test-seq']);
    core.visible(actionId, { requestId: 'request-wake-1', manifestHash: candidate.manifest.hash, sessionSeq: 1,
      requestedAt: Date.now() });
    assert.equal(core.ready('member:c'), false, 'I: nothing is left to pick up once the responsibility is visible');
    // An info note is not a responsibility: it must not wake anyone into a paid turn.
    const settled = runtime.preempt.snapshot();
    const requestsSettled = evidence.requests.length;
    const note = core.send('member:root', 'member:c', 'info', 'just so you know');
    assert.equal(runtime.preempt.deliverMail('member:c', note.result.entityId).wake, 'unavailable',
      'I: an info note is not a responsibility, so the idle edge has nothing to wake for');
    const afterInfo = runtime.preempt.snapshot();
    assert.equal(afterInfo.woke, settled.woke, 'I: an info note never buys a request');
    assert.equal(afterInfo.notLive, settled.notLive + 1, 'I: it is still counted as a delivery with no live step');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(evidence.requests.length, requestsSettled, 'I: and no request followed it');
    evidence.idleWake = { counters: after, requests: evidence.requests.length - requestsBefore,
      snapshots, wakeCounters: afterInfo };
    console.log('PASS idle delivery wakes the member: one turn, one request, no preemption charged');
  }

  evidence.ok = true;
  evidence.counters = counters;
  evidence.stats = agent.preemptStats;
  evidence.events = journal.map(event => event.type);
  fs.writeFileSync(root + '/team-preempt.json', JSON.stringify(evidence, null, 2));
  console.log('PASS team delivery preempts a live step: one preemption, one follow-up request, no partial text, turn intact');
} finally {
  // Teardown is bounded and never masks an assertion: a host that cannot stop would otherwise surface as an
  // unsettled top-level await, which hides the failure that got us here.
  const outcome = await Promise.race([
    host.ctx.fiber.dispose().then(() => 'disposed', error => 'dispose-failed: ' + (error?.message ?? error)),
    new Promise(resolve => { const timer = setTimeout(() => resolve('dispose-timeout'), 15000); void timer; })]);
  if (outcome !== 'disposed') console.error('TEARDOWN: ' + outcome);
}