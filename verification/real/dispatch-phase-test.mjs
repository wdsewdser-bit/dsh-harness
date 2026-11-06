import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transport } from './transport.mjs';
import {
  DISPATCH_CONTRACT, DispatchEvidenceLedger, createDispatchContexts, dispatchDigest, publishDispatchPhase,
  summariseDispatchMessages,
} from '../../packages/contracts/index.mjs';

/**
 * Unit tests for the host-side dispatch publication: the per-attempt context registry, the Transport confirmation
 * points and the ledger consumer. These do not boot a runtime and do not talk to a provider; the end-to-end chain
 * (patched runtime -> offline adapter -> Transport -> controlled receiver) is what verification/probes/llm-dispatch.mjs
 * proves, and these tests deliberately do not claim to cover it.
 */

const root = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-phase-'));
fs.mkdirSync(root, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let passed = 0;
const ok = name => {
  passed += 1;
  console.log('ok ' + passed + ' - ' + name);
};

/** A stand-in for the attempt object the patched runtime mints: same fields, same per-transmission send time. */
function patchLikeAttempt({ id, kind = 'main', purpose = null, sessionId = 'session:' + id, messages = [], sink }) {
  const sendStartedAt = new Map();
  return {
    id,
    sendStartedCount: 0,
    base: { sessionId, kind, purpose, provider: 'probe-provider', model: 'probe-model', messages: summariseDispatchMessages(messages) },
    phase(name, extra = {}) {
      const transmission = Number.isSafeInteger(extra.transmission) ? extra.transmission : null;
      if (name === 'send-started') {
        this.sendStartedCount += 1;
        sendStartedAt.set(transmission, Number.isFinite(extra.sendStartedAt) ? extra.sendStartedAt : Date.now());
      }
      sink.push({
        contract: DISPATCH_CONTRACT, phase: name, attempt: id, ...this.base, transmission,
        sendStartedAt: transmission === null ? null : sendStartedAt.get(transmission) ?? null,
        at: Date.now(), accepted: extra.accepted ?? null,
        httpStatus: Number.isInteger(extra.httpStatus) ? extra.httpStatus : null, reason: extra.reason ?? null,
      });
    },
  };
}

function bus() {
  const published = [];
  return {
    published,
    // The shape publishDispatchEvent supports for a plain collector.
    on: () => [],
    listeners: () => [],
    events: { dispatch: () => [] },
  };
}

function collector() {
  const events = [];
  return {
    events,
    on: () => [],
    listeners: name => (name === 'llm/dispatch' ? [event => events.push(event)] : []),
  };
}

function transportFor({ mode = 'live', onDispatchPhase = null, gate = null, fetchImpl = null } = {}) {
  const facts = { requests: [], latency: {} };
  const budget = { canAdmit: () => true, reserve: () => ({}), settle: () => {} };
  const transport = new Transport({
    root, budget, mode, key: 'phase-test-key-0123456789', fake: null, facts, stopped: () => null,
    gate, onDispatchPhase,
  });
  if (fetchImpl) transport.fetch = fetchImpl;
  return { transport, facts };
}

const message = text => ({ id: 'm-' + text, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });

// ---------------------------------------------------------------------------------------------------------------
// 1. the registry: keyed by attempt, first registration wins, a miss is null
{
  const contexts = createDispatchContexts({ limit: 2 });
  const a = contexts.register('dispatch:1', { sessionId: 'session:a', kind: 'main', messages: [message('a')] });
  const b = contexts.register('dispatch:2', { sessionId: 'session:b', kind: 'auxiliary', purpose: 'compaction', messages: [message('b')] });
  assert.equal(contexts.size, 2);
  assert.equal(contexts.get('dispatch:1').sessionId, 'session:a');
  assert.equal(contexts.get('dispatch:2').kind, 'auxiliary');
  assert.equal(contexts.get('dispatch:2').purpose, 'compaction');
  assert.equal(contexts.get('dispatch:2').messages[0].digest, dispatchDigest(message('b')));
  // A retry cannot re-point the identity of the attempt that was actually sent.
  contexts.register('dispatch:1', { sessionId: 'session:other', messages: [message('a')] });
  assert.equal(contexts.get('dispatch:1').sessionId, 'session:a');
  // No attempt id, no context: nothing to key on, so nothing is invented.
  assert.equal(contexts.register(null, { messages: [] }), null);
  assert.equal(contexts.get(null), null);
  assert.equal(contexts.get('dispatch:unknown'), null);
  // Full in-flight capacity rejects explicitly without evicting either confirmation context.
  assert.throws(() => contexts.register('dispatch:blocked', { messages: [] }), { code: 'DISPATCH_CONTEXT_CAPACITY' });
  assert.equal(contexts.audit.at(-1).attemptId, 'dispatch:blocked');
  assert.equal(contexts.get('dispatch:1'), a);
  assert.equal(contexts.get('dispatch:2'), b);
  assert.equal(contexts.forget('dispatch:1'), false);
  contexts.finish('dispatch:1');
  // Bounded: only a terminal entry is dropped, not an in-flight entry.
  contexts.register('dispatch:3', { messages: [message('c')] });
  assert.equal(contexts.has('dispatch:1'), false);
  assert.equal(contexts.has('dispatch:3'), true);
  contexts.clear();
  assert.equal(contexts.size, 0);
  ok('dispatch contexts are keyed by attempt, immutable and bounded');
}

// ---------------------------------------------------------------------------------------------------------------
// 2. the host-side fallback publisher keys by attempt: reverse-order completion cannot relabel a request
{
  const target = collector();
  const contexts = createDispatchContexts();
  contexts.register('dispatch:a', { sessionId: 'session:a', kind: 'main', messages: [message('a')] });
  contexts.register('dispatch:b', { sessionId: 'session:b', kind: 'main', messages: [message('b')] });
  // b answers first, then a, then an attempt this host never dispatched.
  publishDispatchPhase(target, contexts, { attemptId: 'dispatch:b', phase: 'committed', transmission: 1, httpStatus: 200, accepted: 'accepted' });
  publishDispatchPhase(target, contexts, { attemptId: 'dispatch:a', phase: 'committed', transmission: 1, httpStatus: 200, accepted: 'accepted' });
  publishDispatchPhase(target, contexts, { attemptId: 'dispatch:zzz', phase: 'committed', transmission: 1, httpStatus: 200 });
  assert.equal(target.events.length, 2, 'the unknown attempt published nothing');
  const byAttempt = new Map(target.events.map(event => [event.attempt, event]));
  assert.equal(byAttempt.get('dispatch:a').sessionId, 'session:a');
  assert.equal(byAttempt.get('dispatch:b').sessionId, 'session:b');
  assert.equal(byAttempt.get('dispatch:a').messages[0].digest, dispatchDigest(message('a')));
  assert.equal(byAttempt.get('dispatch:b').messages[0].digest, dispatchDigest(message('b')));
  ok('the fallback publisher never attributes an event to another attempt');
}

// ---------------------------------------------------------------------------------------------------------------
// 3. the transport calls the attempt the patched runtime minted, including inside the real fetch branch
{
  const events = [];
  const attemptA = patchLikeAttempt({ id: 'dispatch:ta', messages: [message('A')], sink: events });
  const attemptB = patchLikeAttempt({ id: 'dispatch:tb', messages: [message('B')], sink: events });
  const bodies = [];
  const { ConcurrencyGate: Gate } = await import('./concurrency.mjs');
  const { transport, facts } = transportFor({
    gate: new Gate({ maxConcurrent: 2, globalConcurrency: 2 }),
    fetchImpl: async (url, init) => {
      assert.ok(url.endsWith('/responses'));
      const body = JSON.parse(init.body);
      bodies.push(body);
      const text = JSON.stringify(body.input);
      // The first request answers last: the two attempts finish in reverse order.
      await sleep(text.includes('A') ? 60 : 10);
      return new Response(JSON.stringify({ output: [], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    },
  });
  const run = (input, attempt) => transport.call('member:root', input, [], { attempt, attemptId: attempt.id, requestId: 'r-' + attempt.id });
  await Promise.all([run([message('A')], attemptA), run([message('B')], attemptB)]);
  assert.equal(facts.requests.length, 2, 'two real requests were made');
  const forA = events.filter(event => event.attempt === 'dispatch:ta').map(event => event.phase);
  const forB = events.filter(event => event.attempt === 'dispatch:tb').map(event => event.phase);
  assert.deepEqual(forA, ['send-started', 'committed']);
  assert.deepEqual(forB, ['send-started', 'committed']);
  const committedA = events.find(event => event.attempt === 'dispatch:ta' && event.phase === 'committed');
  const committedB = events.find(event => event.attempt === 'dispatch:tb' && event.phase === 'committed');
  assert.ok(committedB.at <= committedA.at, 'the second request answered first');
  for (const event of events) {
    assert.equal(event.contract, DISPATCH_CONTRACT);
    assert.equal(event.transmission, 1);
    assert.equal(event.httpStatus, event.phase === 'committed' ? 200 : null);
    assert.equal(event.accepted, event.phase === 'committed' ? 'accepted' : null);
    // The send time is echoed per transmission from the attempt's own table, not re-read at commit time.
    assert.ok(Number.isFinite(event.sendStartedAt));
  }
  assert.ok(committedA.sendStartedAt <= committedA.at);
  ok('two interleaved requests answer in reverse order without swapping attempts, kinds or send times');
}

// ---------------------------------------------------------------------------------------------------------------
// 4. a queued request (one slot per actor) keeps its own context while it waits
{
  const events = [];
  const first = patchLikeAttempt({ id: 'dispatch:q1', messages: [message('first')], sink: events });
  const second = patchLikeAttempt({ id: 'dispatch:q2', messages: [message('second')], sink: events });
  const { ConcurrencyGate } = await import('./concurrency.mjs');
  const gate = new ConcurrencyGate({ maxConcurrent: 1, globalConcurrency: 1 });
  let inFlight = 0;
  let maxInFlight = 0;
  const { transport } = transportFor({
    gate,
    fetchImpl: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(20);
      inFlight -= 1;
      return new Response(JSON.stringify({ output: [], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    },
  });
  await Promise.all([
    transport.call('member:root', [message('first')], [], { attempt: first, attemptId: first.id }),
    transport.call('member:root', [message('second')], [], { attempt: second, attemptId: second.id }),
  ]);
  assert.equal(maxInFlight, 1, 'the second request queued behind the first');
  const committedFirst = events.find(event => event.attempt === 'dispatch:q1' && event.phase === 'committed');
  const startedSecond = events.find(event => event.attempt === 'dispatch:q2' && event.phase === 'send-started');
  assert.ok(startedSecond.at >= committedFirst.at, 'the queued request only started after the first one answered');
  assert.equal(events.find(event => event.attempt === 'dispatch:q2' && event.phase === 'committed').messages[0].digest, dispatchDigest(message('second')));
  ok('a queued request keeps its own context and starts after the first request answered');
}

// ---------------------------------------------------------------------------------------------------------------
// 5. fake mode (a controlled receiver inside the process) publishes the same two phases
{
  const events = [];
  const attempt = patchLikeAttempt({ id: 'dispatch:fake', messages: [message('fake')], sink: events });
  const { transport } = transportFor({ mode: 'fake' });
  transport.fake = async () => ({ output: [], usage: { input_tokens: 1, output_tokens: 1 } });
  await transport.call('member:root', [message('fake')], [], { attempt, attemptId: attempt.id });
  assert.deepEqual(events.map(event => event.phase), ['send-started', 'committed']);
  assert.equal(events[1].accepted, 'accepted');
  ok('fake mode commits after the controlled receiver answered');
}

// ---------------------------------------------------------------------------------------------------------------
// 6. an auxiliary request is observed but never consumed; the filter is the ledger's own
{
  const sink = [];
  const auxiliary = patchLikeAttempt({ id: 'dispatch:aux', kind: 'auxiliary', purpose: 'compaction', messages: [message('aux')], sink });
  const main = patchLikeAttempt({ id: 'dispatch:main', messages: [message('main')], sink });
  const ledger = new DispatchEvidenceLedger({ leaseMs: 60000 });
  const feed = attempt => {
    sink.push({ contract: DISPATCH_CONTRACT, phase: 'prepared', attempt: attempt.id, ...attempt.base, transmission: null, sendStartedAt: null, at: Date.now(),
        accepted: null, httpStatus: null, reason: null });
    attempt.phase('send-started', { transmission: 1, sendStartedAt: Date.now() });
    attempt.phase('committed', { transmission: 1, httpStatus: 200 });
  };
  feed(auxiliary);
  feed(main);
  for (const event of sink) ledger.observe(event, { sessionSeq: 5, epoch: 'epoch-9' });
  const status = ledger.status();
  assert.equal(status.attempts, 2, 'both attempts were observed');
  assert.equal(status.auxiliary, 1);
  assert.equal(status.visible, 2, 'both attempts committed');
  const consumable = ledger.consumable();
  assert.equal(consumable.length, 1, 'only the main request is consumable evidence');
  assert.equal(consumable[0].attempt, 'dispatch:main');
  assert.equal(consumable[0].sessionSeq, 5);
  ok('the ledger consumer, not the caller, filters auxiliary requests out of visible evidence');
}

// ---------------------------------------------------------------------------------------------------------------
// 7. the ledger refuses a second receipt for one transmission and never resurrects a failed one
{
  const sink = [];
  const attempt = patchLikeAttempt({ id: 'dispatch:dup', messages: [message('dup')], sink });
  const ledger = new DispatchEvidenceLedger({ leaseMs: 60000 });
  ledger.observe({ contract: DISPATCH_CONTRACT, phase: 'prepared', attempt: attempt.id, ...attempt.base, transmission: null, sendStartedAt: null, at: Date.now(
    ),
      accepted: null, httpStatus: null, reason: null }, { sessionSeq: 1, epoch: 'e' });
  attempt.phase('send-started', { transmission: 1, sendStartedAt: Date.now() });
  attempt.phase('committed', { transmission: 1, httpStatus: 200 });
  attempt.phase('committed', { transmission: 1, httpStatus: 200 });
  for (const event of sink) ledger.observe(event, { sessionSeq: 1, epoch: 'e' });
  assert.equal(ledger.receipts().length, 1, 'one receipt per transmission');
  assert.equal(ledger.consumable().length, 1);
  ok('a duplicate committed transmission does not create a second receipt');
}

fs.rmSync(root, { recursive: true, force: true });
console.log('dispatch phase tests PASS (' + passed + ' checks)');
