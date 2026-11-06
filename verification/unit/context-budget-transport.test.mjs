import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GATE_RATIO, GATE_CODE, checkWire, estimateInput, estimateRequest, planRequest,
} from '../../packages/context/index.mjs';
import { GATE_RATIO as UI_GATE_RATIO } from '../../packages/ui/src/projection.mjs';

/**
 * M3a: the gate, the cap and the reservation are ONE rule (packages/context/budget.mjs), and it is the rule the
 * live transport has always run. These are fixed cases, not properties: §1.2 records the exact arithmetic the
 * 358k semantics uses, and the table below pins it so a later refactor cannot quietly restore the old
 * "input + full output cap + margin <= window" gate.
 */

const W = 1_000_000;
const R = 358_000;
const configuration = { W, R, M: 0 };

test('the transport keeps the sample per session and only from responses it accepted', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { Budget } = await import('../real/budget.mjs');
  const { Transport } = await import('../real/transport.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wpa-budget-'));
  const budget = new Budget(path.join(root, 'budget.json'), 'p2-replay');
  const facts = { requests: [], latency: {} };
  const p1 = { role: 'user', content: [{ type: 'input_text', text: 'p'.repeat(1000) }] };
  const p2 = { role: 'user', content: [{ type: 'input_text', text: 'q'.repeat(1000) }] };
  let answer = { output: [], usage: { input_tokens: 1000, output_tokens: 10 } };
  try {
    const t = new Transport({ root, budget, mode: 'fake', facts, stopped: () => null,
      fake: async () => answer });
    // 1. an accepted request teaches the session its prefix cost.
    await t.call('root', [p1], [], { nativeSessionId: 's1' });
    const one = facts.requests[0];
    assert.equal(one.estimateMethod, 'full-bytes');
    // 2. a rejected response reports a huge usage; it must not become the next request's sample.
    answer = { error: 'injected', usage: { input_tokens: 111111, output_tokens: 1 } };
    await assert.rejects(() => t.call('root', [p1, p2], [], { nativeSessionId: 's1' }), /PROVIDER_REJECTED/);
    answer = { output: [], usage: { input_tokens: 1200, output_tokens: 10 } };
    await t.call('root', [p1, p2], [], { nativeSessionId: 's1' });
    const three = facts.requests[2];
    assert.equal(three.estimateMethod, 'prefix-delta');
    assert.equal(three.estimateEvidence.previousInput, 1000, 'the sample is still the last ACCEPTED request');
    // 3. another session never inherits this one's report.
    await t.call('root', [p1, p2], [], { nativeSessionId: 's2' });
    const four = facts.requests[3];
    assert.equal(four.estimateMethod, 'full-bytes');
    assert.equal(four.inputUpperBound, four.requestBytes);
  } finally {
    budget.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('the media check reads the same representation that is priced and sent', () => {
  // Six shapes where a scan of the raw objects and the bytes of the serialized body would disagree.
  const small = { W: 1000, R: 358, M: 0 };
  const ask = payload => planRequest(payload, small).verdict;

  // 1. a media part that only exists AFTER toJSON(): the body carries it, so it must be refused.
  const invented = { role: 'user', content: [{ type: 'text', text: 'hello' }] };
  invented.toJSON = () => ({ type: 'image', source: 'x' });
  const one = { messages: [invented] };
  assert.equal(ask(one), 'unknown', 'a part invented by toJSON() is sent, so it is priced');
  assert.throws(() => checkWire(one, small), /UNKNOWN_BUDGET/);

  // 2. an own type:'image' that toJSON() replaces with a text block is never sent: no refusal (HEAD allowed it).
  const replaced = { type: 'image', toJSON: () => ({ type: 'text', text: 'just text' }) };
  const two = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }, replaced] }] };
  assert.equal(ask(two), 'allow', 'a part toJSON() removes is not part of the request');

  // 3. only the TOP-LEVEL signal is transport plumbing; a nested `signal` is ordinary data and stays in the body.
  const three = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], signal: { type: 'image' } };
  assert.equal(ask(three), 'allow', 'the top-level signal never reaches the wire, so it is not a content part');
  assert(!('signal' in JSON.parse(planRequest(three, small).body)), 'the top-level signal is excluded from the body');
  const nestedSignal = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello', signal: { note: 'business field' } }] }] };
  const nestedPlan = planRequest(nestedSignal, small);
  assert.equal(nestedPlan.verdict, 'allow');
  assert.deepEqual(JSON.parse(nestedPlan.body).messages[0].content[0].signal, { note: 'business field' },
    'a nested signal is payload, so it is priced and sent');
  // ...and if that nested part is media, it is a media part like any other.
  const nestedMedia = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello', signal: { type: 'image' } }] }] };
  assert.equal(ask(nestedMedia), 'unknown', 'a nested signal carrying media is still media');

  // 4. a non-enumerable type never reaches the wire either.
  const hidden = {};
  Object.defineProperty(hidden, 'type', { value: 'image', enumerable: false });
  hidden.text = 'hello';
  const four = { messages: [{ role: 'user', content: [hidden] }] };
  assert.equal(ask(four), 'allow', 'a non-enumerable field is not sent');

  // 5. nesting past the scan budget is UNKNOWN - never a RangeError out of the estimator (HEAD let the raw
  //    recursive walk overflow; the iterative scan plus the budget turns it into the same refusal as media).
  let deep = { type: 'text', text: 'x' };
  for (let i = 0; i < 4500; i++) deep = { nested: deep };
  const five = { messages: [{ role: 'user', content: [deep] }] };
  assert.equal(ask(five), 'unknown', 'a payload too deep to inspect cannot be priced');
  assert.throws(() => checkWire(five, small), /UNKNOWN_BUDGET/);

  // 6. a body that cannot be serialized at all (a cycle) is UNKNOWN, never a TypeError out of the estimator.
  const cyclic = { role: 'user', content: [{ type: 'text', text: 'hello' }] };
  cyclic.self = cyclic;
  const six = { messages: [cyclic] };
  assert.equal(ask(six), 'unknown', 'a body that cannot be serialized cannot be priced');
  assert.throws(() => checkWire(six, small), /UNKNOWN_BUDGET/);
});
test('one serialization on the whole path: a toJSON() that answers twice cannot split price from payload', async () => {
  const small = { W: 1000, R: 358, M: 0 };
  const textItem = { role: 'user', content: [{ type: 'text', text: 'hello' }] };
  // One object that answers "text" the first time it is serialized and "image" every time after.
  const makeFlaky = () => {
    const item = { role: 'user', content: [{ type: 'text', text: 'hello' }] };
    let calls = 0;
    item.toJSON = () => {
      calls++;
      return calls === 1 ? textItem : { role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/x.png' }] };
    };
    item.serializations = () => calls;
    return item;
  };
  const flaky = makeFlaky();
  const plan = planRequest({ messages: [flaky] }, small);
  const calls = flaky.serializations();
  assert.equal(calls, 1, 'the caller\'s object is serialized exactly once on the whole path');
  assert.equal(plan.verdict, 'allow', 'the body that was priced carries no media part');
  assert(!plan.body.includes('input_image'), 'the body that is sent is the one that was priced');
  assert.deepEqual(JSON.parse(plan.body).messages, [textItem]);
  assert.equal(plan.payloadBytes, Buffer.byteLength(plan.body));

  // ...and the transport really sends it: the receiver sees the text body, never the image.
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { Budget } = await import('../real/budget.mjs');
  const { Transport } = await import('../real/transport.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wpa-flaky-'));
  const budget = new Budget(path.join(root, 'budget.json'), 'p2-replay');
  const seen = [];
  try {
    const t = new Transport({ root, budget, mode: 'fake', facts: { requests: [], latency: {} }, stopped: () => null,
      fake: async sent => { seen.push(JSON.stringify(sent)); return { output: [], usage: { input_tokens: 10, output_tokens: 1 } }; } });
    await t.call('root', [makeFlaky()], [], { nativeSessionId: 'flaky' });
    assert.equal(seen.length, 1);
    assert(!seen[0].includes('input_image'), 'the provider receives the priced body, not a second serialization');
    assert(seen[0].includes('hello'));
  } finally {
    budget.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a signal carrying a cycle is priced as if it were not there', () => {
  const small = { W: 1000, R: 358, M: 0 };
  const signal = { aborted: false };
  signal.self = signal; // the shape a plain JSON.stringify used to choke on
  const withSignal = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], signal };
  const plan = planRequest(withSignal, small);
  assert.equal(plan.verdict, 'allow', 'a transport-only field never fails the price');
  assert(!('signal' in JSON.parse(plan.body)), 'the body that is sent excludes the signal');
  const without = planRequest({ messages: withSignal.messages }, small);
  assert.equal(plan.I, without.I, 'priced exactly as if the signal were absent');
  assert.equal(plan.payloadBytes, without.payloadBytes);
  assert.equal(plan.reserve, without.reserve);
});
test('a tool schema that spells "signal" survives, and the log fields describe the body that is sent', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { digest } = await import('../real/protocol.mjs');
  const { Budget } = await import('../real/budget.mjs');
  const { Transport } = await import('../real/transport.mjs');

  const schema = { type: 'object', properties: { signal: { type: 'string', enum: ['SIGTERM', 'SIGINT'] } }, required: ['signal'] };
  const tools = [{ type: 'function', name: 'send_signal', parameters: schema }];
  const makeItem = () => {
    const item = { role: 'user', content: [{ type: 'input_text', text: 'kill it' }] };
    let calls = 0;
    item.toJSON = () => { calls++; return { role: 'user', content: [{ type: 'input_text', text: 'kill it' }] }; };
    item.serializations = () => calls;
    return item;
  };
  const configurationForPlan = { W: 1_000_000, R: 358_000, M: 0 };

  // The plan's body IS the request: dropping a nested `signal` would rewrite the caller's tool schema.
  const plannedItem = makeItem();
  const plan = planRequest({ model: 'm', input: [plannedItem], tools, max_output_tokens: 100 }, configurationForPlan);
  const planned = JSON.parse(plan.body);
  assert.deepEqual(planned.tools[0].parameters, schema, 'properties.signal survives serialization');
  assert.deepEqual(planned.tools[0].parameters.required, ['signal']);
  assert.equal(plannedItem.serializations(), 1);

  // Through the real transport: the provider receives that schema, and inputHash is the digest of that input.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wpa-signal-'));
  const budget = new Budget(path.join(root, 'budget.json'), 'p2-replay');
  const facts = { requests: [], latency: {} };
  const seen = [];
  const transportItem = makeItem();
  try {
    const t = new Transport({ root, budget, mode: 'fake', facts, stopped: () => null,
      fake: async sent => { seen.push(sent); return { output: [], usage: { input_tokens: 10, output_tokens: 1 } }; } });
    await t.call('root', [transportItem], tools, { nativeSessionId: 'signal-schema' });
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].tools[0].parameters, schema, 'the provider receives the schema the caller passed');
    assert.deepEqual(seen[0].tools[0].parameters.required, ['signal']);
    assert.equal(transportItem.serializations(), 1, 'the caller\'s items are serialized once, for the body that is sent');
    assert.equal(facts.requests[0].inputHash, digest(seen[0].input), 'inputHash is the digest of the input actually sent');
    assert.equal(facts.requests[0].requestBytes, Buffer.byteLength(JSON.stringify(seen[0])), 'requestBytes is the body that was sent');
  } finally {
    budget.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
