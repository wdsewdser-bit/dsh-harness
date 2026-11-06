import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * The instant-preempt cases. Every assertion is on the real agent loop's durable journal or on what the next
 * request would have shown the model, never on an internal flag, so a pass is evidence about behaviour.
 *
 *  A  preempt mid-stream    -> the step ends, one more request follows inside the same turn, turn/end is not aborted
 *  B  closed items kept     -> a completed reasoning item survives byte-identically; no truncated reasoning exists
 *  C  tool drain           -> exactly one output per call_id; a dispatched call keeps its real result
 *  D  maintenance + queue   -> a compaction window is never preemptible and queued input survives a preemption
 *  E  steer + preempt      -> converges in two requests, with the new message visible in the second
 *  G  preempt with pending -> preemptStep reports true while work is pending and the turn is not ended
 *  P  switch off           -> the default scenario is identical between the original and the patched build
 */

/** Create one agent under an exact id and hand back journal helpers plus its own teardown. */
async function open(ctx, home, id) {
  const handle = await ctx.agents.create({ sessionId: id,
    agentOptions: { provider: 'offline', model: 'model' }, meta: { cwd: home } });
  const agent = handle.agent;
  return { handle, agent, close: () => handle.dispose(),
    events: () => agent.session.snapshotEvents(),
    of: type => agent.session.snapshotEvents().filter(event => event.type === type) };
}

const user = text => ({ id: 'user-' + randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });

/** One streaming script that parks at its tail so a preemption can win the next read. */
const parked = (head, hold, onHold) => ({ chunks: head, hold, onHold });

/** Every tool call in the journal must be answered exactly once, by a result with the same call id. */
function assertOneOutputPerCall(events) {
  const calls = events.filter(event => event.type === 'tool/call').map(event => event.data.callId);
  const results = events.filter(event => event.type === 'tool/result').map(event => event.data.message.toolCallId);
  assert.equal(new Set(calls).size, calls.length, 'a call id was appended twice');
  assert.equal(results.length, calls.length, 'call/result counts differ: ' + calls.length + ' vs ' + results.length);
  for (const id of calls) {
    const count = results.filter(result => result === id).length;
    assert.equal(count, 1, 'call ' + id + ' has ' + count + ' outputs');
  }
  return { calls, results };
}

/** No assistant message may contain a reasoning block the adapter never closed. */
function assertNoTruncatedReasoning(events, closed) {
  for (const event of events.filter(e => e.type === 'assistant/message')) {
    for (const block of event.data.message.content) {
      if (block.type !== 'reasoning') continue;
      assert(closed.has(block.text), 'truncated reasoning was persisted: ' + JSON.stringify(block.text));
    }
  }
}

/** Position of one request relative to the case's own script, so cases never count each other's traffic. */
const relative = (evidence, base) => evidence.requests.slice(base);

export async function runInstant({ ctx, arm, evidence, chunks, deferred, home, registerEcho }) {
  const cases = {};
  const echoCalls = registerEcho(ctx, []);

  console.error("case A");
  // ---- A: preempt between two stream reads; the step ends and the turn continues into one more request.
  {
    const hold = deferred();
    const held = deferred();
    const base = arm({ entry(index) {
      if (index === 0) return { purpose: 'workload', ...parked([...chunks.text(0, 'partial answer that must not survive')], hold, () => held.resolve(true)) };
      return { purpose: 'workload', chunks: [...chunks.text(0, 'second answer'), chunks.textEnd(0, 'second answer'),
        chunks.usage(11, 5), chunks.finish('stop')] };
    } });
    const { agent, events, of, close } = await open(ctx, home, 'instant-a');
    agent.followup(user('answer briefly'));
    await held.promise;
    const fired = agent.preemptStep('member-message');
    assert.equal(fired, true, 'A: a live step must accept a preemption');
    hold.resolve();
    await agent.whenIdle();
    const journal = events();
    const requests = relative(evidence, base);
    assert.equal(requests.length, 2, 'A: a preempted step must be followed by exactly one more request');
    const ends = of('turn/end');
    assert.equal(ends.length, 1, 'A: a preemption must not open a second turn');
    assert.notEqual(ends[0].data.reason.kind, 'aborted', 'A: the turn must not be aborted');
    assert.equal(of('step/end').length, 2, 'A: the preempted step still closes, and the follow-up step closes');
    assert.equal(agent.preemptStats.fired, 1, 'A: one preemption fired');
    assert.equal(agent.preemptStats.extraRequests, 1, 'A: the follow-up request is attributed to the preemption');
    assert(!JSON.stringify(requests[1].messages).includes('partial answer that must not survive'),
      'A: half-streamed text must never reach the next request');
    cases.A = { ok: true, fired, requests: requests.length, events: journal.map(e => e.type), stats: agent.preemptStats };
    await close();
  }

  console.error("case B");
  // ---- B: a closed item survives byte-identically; open items are dropped, never truncated.
  {
    const hold = deferred();
    const held = deferred();
    const closed = 'closed reasoning item ' + randomUUID();
    const openTail = 'open reasoning tail that must be dropped';
    arm({ entry(index) {
      if (index === 0) return { purpose: 'workload', ...parked([
        ...chunks.reasoning(0, closed), chunks.reasoningEnd(0, closed),
        ...chunks.reasoning(1, openTail), ...chunks.text(2, 'open text tail')], hold, () => held.resolve(true)) };
      return { purpose: 'workload', chunks: [...chunks.text(0, 'done'), chunks.textEnd(0, 'done'),
        chunks.usage(7, 3), chunks.finish('stop')] };
    } });
    const { agent, events, of, close } = await open(ctx, home, 'instant-b');
    agent.followup(user('think, then answer'));
    await held.promise;
    assert.equal(agent.preemptStep('member-message'), true, 'B: the parked step accepts the preemption');
    hold.resolve();
    await agent.whenIdle();
    const journal = events();
    const reasoning = journal.filter(e => e.type === 'assistant/message')
      .flatMap(e => e.data.message.content.filter(block => block.type === 'reasoning').map(block => block.text));
    assert(reasoning.includes(closed), 'B: the closed reasoning item must be kept verbatim');
    assert(!reasoning.includes(openTail), 'B: an open reasoning block must never be persisted');
    assertNoTruncatedReasoning(journal, new Set([closed]));
    assert(agent.preemptStats.discardedPartialItems >= 2, 'B: the two open items are counted as discarded');
    assert(of('assistant/message').some(e => e.data.interrupted === true), 'B: the preempted settlement is marked interrupted');
    cases.B = { ok: true, keptReasoning: reasoning, discarded: agent.preemptStats.discardedPartialItems };
    await close();
  }

  console.error("case C");
  // ---- C: an undispatched tool call is answered "aborted before dispatch"; a dispatched one keeps its result.
  {
    const hold = deferred();
    const held = deferred();
    arm({ entry(index) {
      if (index === 0) return { purpose: 'workload', chunks: [...chunks.toolCall(0, 'call-c-1', 'echo', JSON.stringify({ value: 'one' })),
        chunks.usage(5, 2), chunks.finish('tool-calls')] };
      if (index === 1) return { purpose: 'workload', ...parked([...chunks.toolCall(0, 'call-c-2', 'echo', JSON.stringify({ value: 'two' }))],
        hold, () => held.resolve(true)) };
      return { purpose: 'workload', chunks: [...chunks.text(0, 'done'), chunks.textEnd(0, 'done'), chunks.finish('stop')] };
    } });
    const echoBase = echoCalls.length;
    const { agent, events, close } = await open(ctx, home, 'instant-c');
    agent.followup(user('call echo twice'));
    await held.promise;
    assert.equal(events().filter(e => e.type === 'tool/result').length, 1, 'C: the first call already has its real result');
    assert.equal(agent.preemptStep('member-message'), true, 'C: the parked third request accepts the preemption');
    hold.resolve();
    await agent.whenIdle();
    const final = events();
    const { calls, results } = assertOneOutputPerCall(final);
    assert.deepEqual(echoCalls.slice(echoBase), ['one'], 'C: only the dispatched call ran');
    const first = final.find(e => e.type === 'tool/result' && e.data.message.toolCallId === calls[0]);
    assert.equal(first.data.message.isError, false, 'C: the dispatched call keeps its real, non-error result');
    assert(!calls.includes('call-c-2'), 'C: a call streamed but never dispatched must not appear as a call');
    cases.C = { ok: true, calls, results, echoes: echoCalls.slice(echoBase), stats: agent.preemptStats };
    await close();
  }

  console.error("case D");
  // ---- D: a maintenance (compaction) window is never preemptible, and queued input survives a preemption.
  {
    const hold = deferred();
    const held = deferred();
    const marker = 'user text that must survive the preemption';
    arm({ entry(index) {
      if (index === 0) return { purpose: 'workload', chunks: [...chunks.text(0, 'first answer'), chunks.textEnd(0, 'first answer'),
        chunks.usage(6, 3), chunks.finish('stop')] };
      if (index === 1) return { purpose: 'workload', ...parked([...chunks.text(0, 'answer being preempted')], hold, () => held.resolve(true)) };
      return { purpose: 'workload', chunks: [...chunks.text(0, 'final answer'), chunks.textEnd(0, 'final answer'),
        chunks.usage(8, 4), chunks.finish('stop')] };
    } });
    const { agent, events, close } = await open(ctx, home, 'instant-d');
    agent.followup(user('first question'));
    await agent.whenIdle();
    // A compaction job owns a maintenance phase; preemptStep must refuse so the job is never cut in half.
    const compacting = deferred();
    const finished = deferred();
    const maintenance = agent.runMaintenance(async () => {
      compacting.resolve(true);
      assert.equal(agent.preemptStep('during-compaction'), false, 'D: a maintenance phase is never preemptible');
      await finished.promise;
      return { compacted: true };
    });
    await compacting.promise;
    assert.equal(agent.preemptStep('during-compaction'), false, 'D: still refused from outside the job');
    finished.resolve(true);
    assert.deepEqual(await maintenance, { compacted: true }, 'D: the job finished exactly once');
    agent.followup(user(marker));
    await held.promise;
    const turnsBefore = events().filter(e => e.type === 'turn/start').length;
    assert.equal(agent.preemptStep('team-wake'), true, 'D: a live step of the next turn accepts the preemption');
    hold.resolve();
    await agent.whenIdle();
    await ctx.sessions.flush(agent.session);
    const final = events();
    const flat = JSON.stringify(final);
    assert(flat.includes(marker), 'D: the queued user message is still in the journal');
    assert(flat.includes('first answer'), 'D: the completed earlier message is untouched');
    assert.equal(final.filter(e => e.type === 'turn/start').length, turnsBefore, 'D: the preempted turn is not duplicated');
    assert.notEqual(final.filter(e => e.type === 'turn/end').at(-1).data.reason.kind, 'aborted', 'D: the turn completes');
    assertOneOutputPerCall(final);
    cases.D = { ok: true, turns: turnsBefore, requests: evidence.requests.length };
    await close();
  }

  console.error("case E");
  // ---- E: steer plus preemption converges in two requests with the new message in the second.
  {
    const hold = deferred();
    const held = deferred();
    const base = arm({ entry(index) {
      if (index === 0) return { purpose: 'workload', ...parked([...chunks.text(0, 'stale plan')], hold, () => held.resolve(true)) };
      return { purpose: 'workload', chunks: [...chunks.text(0, 'revised answer'), chunks.textEnd(0, 'revised answer'),
        chunks.usage(10, 4), chunks.finish('stop')] };
    } });
    const { agent, close } = await open(ctx, home, 'instant-e');
    const steer = 'please answer the corrected question';
    agent.followup(user('answer the first question'));
    await held.promise;
    agent.steer(user(steer));
    assert.equal(agent.preemptStep('user-input'), true, 'E: steer is visible because the live step preempted');
    hold.resolve();
    await agent.whenIdle();
    const requests = relative(evidence, base);
    assert.equal(requests.length, 2, 'E: convergence takes exactly two requests');
    const second = JSON.stringify(requests[1].messages);
    assert(second.includes(steer), 'E: the steered message is in the second request');
    assert(!second.includes('stale plan'), 'E: the abandoned partial text is not');
    assert.equal(agent.preemptStats.extraRequests, 1, 'E: exactly one request is attributed to the preemption');
    cases.E = { ok: true, requests: requests.length, second: requests[1].messages };
    await close();
  }

  console.error("case F");
  // ---- F: the follow-up request must not wait for the abandoned stream to close.
  // This is the real-run symptom: with a live provider, the pending next() cannot settle until the response
  // arrives, so a preemption that awaited iterator.return() cost the abandoned request's own latency (measured
  // as exactly the 2 s bound on every preempted delivery, 1.1-2.2 s of stored->visible). Here the abandoned
  // generator takes 1200 ms to finish after the preemption; the next request must still start immediately, and
  // return() must still have been called exactly once so the connection is released.
  {
    const hold = deferred();
    const held = deferred();
    const closed = deferred();
    const closing = { entered: 0, finished: false, closedAt: null };
    arm({ entry(index) {
      if (index === 0) return { purpose: 'workload', ...parked([...chunks.text(0, 'abandoned answer')], hold, () => held.resolve(true)),
        // The generator's body cannot reach its end until this resolves, so iterator.return() — which waits for
        // the body to unwind — cannot resolve before it. That is the await the candidate must not sit on.
        onEnd: async () => { closing.entered++; await closed.promise; closing.finished = true; closing.closedAt = Date.now(); } };
      return { purpose: 'workload', chunks: [...chunks.text(0, 'second answer'), chunks.textEnd(0, 'second answer'),
        chunks.usage(9, 3), chunks.finish('stop')] };
    } });
    const base = evidence.requests.length;
    const { agent, events, close } = await open(ctx, home, 'instant-f');
    const started = Date.now();
    agent.followup(user('answer, then switch course'));
    await held.promise;
    const preemptedAt = Date.now();
    assert.equal(agent.preemptStep('member-message'), true, 'F: the parked step accepts the preemption');
    hold.resolve();
    // Wait for the driver to issue its follow-up request while the abandoned stream is still open. The bound
    // is short on purpose: a candidate that waits for the abandoned stream cannot issue it at all until the
    // stream is released, so the timeout has to expire before the release happens, and it does so here.
    const deadline = Date.now() + 400;
    // A referenced timer: this wait must keep the process alive, or a candidate that never issues the request
    // would end the probe run with an unsettled-await warning instead of a failed assertion.
    const tick = () => new Promise(resolve => { setTimeout(resolve, 5); });
    while (evidence.requests.length - base < 2 && Date.now() < deadline) await tick();
    const waited = Date.now() - preemptedAt;
    const issuedBeforeRelease = evidence.requests.length - base >= 2;
    const streamOpenWhenIssued = !closing.finished;
    // The release still happens, later: return() runs and the generator unwinds once the provider answers.
    closed.resolve(true);
    await agent.whenIdle();
    assert(issuedBeforeRelease, 'F: the follow-up request waited for the abandoned stream to close (' + waited + 'ms)');
    assert(waited < 400, 'F: the follow-up request waited ' + waited + 'ms for the abandoned stream to close');
    assert(streamOpenWhenIssued, 'F: the follow-up request was issued while the abandoned stream was still open');
    assert.equal(closing.entered, 1, 'F: the abandoned stream was closed exactly once');
    assert.equal(closing.finished, true, 'F: the abandoned stream did reach its own end');
    const journal = events();
    assert.equal(journal.filter(e => e.type === 'turn/end').length, 1, 'F: one turn');
    assert.notEqual(journal.filter(e => e.type === 'turn/end')[0].data.reason.kind, 'aborted', 'F: the turn completed');
    assert(!JSON.stringify(agent.session.deriveMessages()).includes('abandoned answer'), 'F: the partial text is not model-visible');
    cases.F = { ok: true, followUpWaitMs: waited, streamClosedAfter: closing.closedAt - preemptedAt, stats: agent.preemptStats };
    await close();
  }

  console.error("case G");
  // ---- G: preemptStep refuses when no live step can accept it, and a refusal never ends the turn.
  {
    const hold = deferred();
    const held = deferred();
    arm({ entry(index) {
      if (index === 0) return { purpose: 'workload', ...parked([...chunks.text(0, 'pending work')], hold, () => held.resolve(true)) };
      return { purpose: 'workload', chunks: [...chunks.text(0, 'ok'), chunks.textEnd(0, 'ok'), chunks.finish('stop')] };
    } });
    const { agent, events, close } = await open(ctx, home, 'instant-g');
    assert.equal(agent.preemptStep('idle'), false, 'G: outside a step there is nothing to preempt');
    agent.followup(user('do work'));
    await held.promise;
    assert.equal(agent.preemptStep('member-message'), true, 'G: the first request while a step is live succeeds');
    assert.equal(agent.preemptStep('member-message'), false, 'G: at most one preemption per step');
    hold.resolve();
    await agent.whenIdle();
    const ends = events().filter(e => e.type === 'turn/end');
    assert.equal(ends.length, 1, 'G: the refused second preemption did not end anything extra');
    assert.notEqual(ends[0].data.reason.kind, 'aborted', 'G: the turn still completed');
    assert.equal(agent.preemptStep('after-idle'), false, 'G: after the turn there is no latch');
    cases.G = { ok: true, stats: agent.preemptStats };
    await close();
  }

  return cases;
}

export async function runDefault(host, { cold = false, tag = 'patched' } = {}) {
  const { runDefaultCase, coldResume } = host;
  const { agent, handle, result } = await runDefaultCase(host, { tag });
  const cases = { journal: result };
  const sessionId = agent.session.id;
  await handle.dispose();
  if (cold) {
    const resumed = await coldResume(host, sessionId, result);
    assert.equal(resumed.resumed.replayEqualsJournal, true, 'cold: the resumed journal replays the flushed one exactly');
    assert.equal(resumed.resumed.requests, 0, 'cold: resuming issues no request');
    assert.deepEqual(resumed.resumed.afterFollowup.echoes, result.echoes, 'cold: the resumed agent still runs the tool');
    cases.cold = { replayEqualsJournal: true, requestsWhileResuming: resumed.resumed.requests,
      requestsAfterFollowup: resumed.resumed.afterFollowup.requests,
      extraEvents: resumed.resumed.extra, echoes: resumed.resumed.afterFollowup.echoes };
    await resumed.handle.dispose();
  }
  return cases;
}