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

test('one ratio, spelled once per side of the bundle boundary', () => {
  assert.equal(GATE_RATIO, 0.75, 'the hard limit is 75% of the window');
  // The browser bundle strips imports and ui may not reach into the server packages, so the display layer states
  // the ratio once (packages/ui/src/projection.mjs). This assertion is what keeps the two copies from drifting.
  assert.equal(UI_GATE_RATIO, GATE_RATIO, 'the display layer must render the same hard limit the gate enforces');
});

test('the gate reads the input alone, and the cap is what the window leaves', () => {
  const cases = [
    // [committed input, verdict, expected cap]
    [0, 'allow', R],
    [642_000, 'allow', R],             // min(R, W-I) is still the route cap
    [642_001, 'allow', R - 1],         // one token past the route cap: the window starts to bite
    [749_000, 'allow', W - 749_000],   // 0.749W dispatches, cap = min(R, W-I) = 251000
    [749_999, 'allow', W - 749_999],
    [750_000, 'block', W - 750_000],   // exactly 0.75W is refused
    [750_001, 'block', W - 750_001],
    [W, 'block', 0],
  ];
  for (const [I, verdict, cap] of cases) {
    const plan = planRequest(null, configuration, { purpose: 'main', inputBound: I });
    assert.equal(plan.verdict, verdict, 'I=' + I);
    assert.equal(plan.code, verdict === 'block' ? GATE_CODE : null, 'I=' + I);
    assert.equal(plan.maxOutputTokens, Math.min(R, W - I), 'cap = min(R, W-I) at I=' + I);
    assert.equal(plan.maxOutputTokens, cap, 'I=' + I);
    // A full output cap on top of the input no longer enters the verdict: only the window is charged once.
    if (verdict === 'allow') assert(I < GATE_RATIO * W);
  }
});

test('the reservation is max(65536, bytes*4) + the cap that is really asked for', () => {
  const options = {
    model: 'deepseek-v4.1-flash',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(40000) }] }],
    tools: [],
    max_output_tokens: R,
    stream: false,
    store: false,
  };
  const plan = planRequest(options, configuration);
  const cap = Math.min(R, W - plan.I);
  const sent = Buffer.byteLength(JSON.stringify({ ...options, max_output_tokens: cap }));
  assert.equal(plan.I, Buffer.byteLength(JSON.stringify(options)), 'no previous sample: the estimate is the byte count');
  assert.equal(plan.method, 'full-bytes');
  assert.equal(plan.maxOutputTokens, cap);
  assert.equal(plan.payloadBytes, sent, 'the reservation prices the body that is really sent, not the provisional one');
  assert.equal(plan.reserve, Math.max(65536, sent * 4) + cap);
  assert(sent * 4 > 65536, 'this case is in the bytes*4 branch');
  // The floor branch: a small request reserves the fixed floor plus its cap, never less.
  const small = planRequest({ model: 'm', input: [], tools: [], max_output_tokens: 1000 }, { W: 200_000, R: 1000, M: 0 });
  const smallBytes = Buffer.byteLength(JSON.stringify({ model: 'm', input: [], tools: [], max_output_tokens: 1000 }));
  assert.equal(small.payloadBytes, smallBytes);
  assert.equal(small.reserve, 65536 + 1000);
});

test('prefix-delta is adopted only from a previous sample of the same session', () => {
  const a = { role: 'user', content: 'a'.repeat(2000) };
  const b = { role: 'assistant', content: 'b'.repeat(2000) };
  const c = { role: 'user', content: 'c'.repeat(2000) };
  const first = { model: 'm', input: [a, b], tools: [], max_output_tokens: 1000 };
  const second = { model: 'm', input: [a, b, c], tools: [], max_output_tokens: 1000 };

  const one = estimateInput(first);
  assert.equal(one.method, 'full-bytes');
  assert.equal(one.bound, Buffer.byteLength(JSON.stringify(first)));
  assert.match(one.evidence.reason, /no previous request/);

  // Without the sample the long session would be re-priced in full bytes, which is what fires the gate early.
  const previous = { items: one.items, input: 1234, overheadBytes: one.overheadBytes };
  const two = estimateInput(second, { previous });
  const added = Buffer.byteLength(JSON.stringify(c));
  assert.equal(two.method, 'prefix-delta');
  assert.equal(two.bound, 1234 + added);
  assert(two.bound < Buffer.byteLength(JSON.stringify(second)), 'the delta is smaller than the whole prompt it extends');
  assert.deepEqual(two.evidence, { previousInput: 1234, reusedItems: 2, addedItems: 1, addedBytes: added, nonInputBytes: 0 });

  // A sample that is not a prefix, a sample from nothing, and a body that grew are all priced in full bytes.
  const rewritten = estimateInput({ ...second, input: [c, b, a] }, { previous });
  assert.equal(rewritten.method, 'full-bytes');
  assert.match(rewritten.evidence.reason, /not a prefix/);
  assert.equal(rewritten.bound, Buffer.byteLength(JSON.stringify({ ...second, input: [c, b, a] })));

  // The transport keeps the sample itself; the plan hands it back in the shape the next call needs.
  const plan = planRequest(first, configuration);
  assert.deepEqual(plan.items, [JSON.stringify(a), JSON.stringify(b)]);
  assert.equal(plan.overheadBytes, Buffer.byteLength(JSON.stringify({ ...first, input: [] })));
});

test('UNKNOWN_BUDGET: the five paths that cannot be priced', () => {
  const cases = [
    ['no item list', { model: 'm' }, configuration, {}],
    ['a non-finite sample', { messages: [] }, configuration, { baseline: Number.NaN }],
    ['a media payload', { messages: [{ role: 'user', content: [{ type: 'image', source: 'x' }] }] }, configuration, {}],
    ['two different output caps', { messages: [], maxTokens: 1, maxOutputTokens: 2 }, configuration, {}],
    ['an invalid window', { messages: [] }, { W: undefined, R, M: 0 }, {}],
  ];
  for (const [name, options, settings, options2] of cases) {
    const plan = planRequest(options, settings, options2);
    assert.equal(plan.verdict, 'unknown', name);
    assert.equal(plan.code, 'UNKNOWN_BUDGET', name);
    assert.equal(plan.I, null, name);
    assert.throws(() => checkWire(options, settings, 'main', options2.baseline ?? 0), /UNKNOWN_BUDGET/, name);
  }
  // The other three shapes of an unusable configuration are the same path.
  for (const settings of [{ W: 0, R, M: 0 }, { W, R: 0, M: 0 }, { W, R, M: -1 }, { W: 1024.5, R, M: 0 }]) {
    assert.equal(planRequest({ messages: [] }, settings).verdict, 'unknown', JSON.stringify(settings));
    assert.throws(() => checkWire({ messages: [] }, settings), /UNKNOWN_BUDGET/);
  }
});

test('checkWire keeps its shape and its codes on top of the same rule', () => {
  const payload = { messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(2000) }] }] };
  const settings = { W, R: 4096, M: 4096 };
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  const allowed = checkWire(payload, settings);
  assert.equal(allowed.I, bytes, 'the estimate is the transport byte bound, with no *2 + 1024 inflation');
  assert.equal(allowed.W, W);
  assert.equal(allowed.M, 4096);
  assert.equal(allowed.purpose, 'main');
  assert(Number.isFinite(allowed.R) && allowed.R > 0, 'R is the durable reservation');
  // A committed sample is a floor on the next prompt, so it is what the gate reads when it is larger.
  assert.equal(checkWire(payload, settings, 'retry', 749_999).I, 749_999);
  assert.throws(() => checkWire(payload, settings, 'retry', 750_000), /BLOCKED_BUDGET/);
  assert.equal(estimateRequest(payload, 1), bytes, 'the pre-M3a estimator name returns the same bound');
});
// --- media budget: a part whose cost is tokens, not bytes, can never be priced by the byte bound --------------
const mediaCases = [
  ['chat completions image_url', { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/cat.png' } }] }] }],
  ['Responses input_image', { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/cat.png' }] }] }],
  ['Responses input_file', { messages: [{ role: 'user', content: [{ type: 'input_file', file_id: 'file-1' }] }] }],
  ['Responses input_audio', { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'AAA', format: 'wav' } }] }] }],
  ['legacy image part', { messages: [{ role: 'user', content: [{ type: 'image', source: 'x' }] }] }],
  ['media nested in a tool output', { input: [{ type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_image',
              image_url: 'https://e/x.png' }] }] }],
];
test('a media part refuses with UNKNOWN_BUDGET in every protocol spelling', () => {
  // The window is small on purpose: the byte count of these payloads is far below 75% of it, so a refusal can only
  // come from the media rule. (Before the fix the image URL was priced at I=103 and dispatched.)
  const small = { W: 1000, R: 358, M: 0 };
  for (const [name, payload] of mediaCases) {
    assert(Buffer.byteLength(JSON.stringify(payload)) < GATE_RATIO * small.W, name + ': the bytes alone would pass');
    const plan = planRequest(payload, small);
    assert.equal(plan.verdict, 'unknown', name);
    assert.equal(plan.code, 'UNKNOWN_BUDGET', name);
    assert.throws(() => checkWire(payload, small), /UNKNOWN_BUDGET/, name);
  }
  // An image URL is a cost in tokens, not bytes: the one case the reviewer reproduced must not be dispatched.
  const url = mediaCases[0][1];
  const bytes = Buffer.byteLength(JSON.stringify(url));
  assert(bytes < 0.75 * small.W, 'the pre-fix estimate of this payload was ' + bytes + ' bytes and dispatched');
});

test('a body that carries both item lists is inspected in full', () => {
  // Ambiguous payloads are the caller's bug, but the media check is about the payload, not about the list the
  // estimator happened to pick: an image in `messages` beside an empty `input` refuses, exactly as HEAD's checkWire
  // did for the same body (it read `messages` and found \"type\":\"image\").
  const both = { input: [], messages: [{ role: 'user', content: [{ type: 'image', source: 'x' }] }] };
  assert.equal(planRequest(both, { W: 1000, R: 358, M: 0 }).verdict, 'unknown');
  assert.throws(() => checkWire(both, { W: 1000, R: 358, M: 0 }), /UNKNOWN_BUDGET/);
});

test('text that merely mentions a media type is not a media part', () => {
  const text = { messages: [{ role: 'user', content: [{ type: 'text', text: 'see \"type\":\"image\" and image_url in the docs' }] }] };
  const plan = planRequest(text, configuration);
  assert.equal(plan.verdict, 'allow');
  assert.equal(plan.I, Buffer.byteLength(JSON.stringify(text)));
});

// --- the estimator's other boundaries ------------------------------------------------------------------------
test('baseline and delta together form the floor', () => {
  const payload = { messages: [{ role: 'user', content: [{ type: 'text', text: 'short' }] }] };
  const small = estimateInput(payload, { baseline: 1, delta: 2 });
  assert.equal(small.bound, Buffer.byteLength(JSON.stringify(payload)), 'a small sample is not a ceiling');
  const floored = estimateInput(payload, { baseline: 400_000, delta: 400_000 });
  assert.equal(floored.bound, 800_000, 'baseline + delta, not either alone');
  assert.deepEqual(floored.evidence.measuredFloor, 800_000);
  assert.equal(planRequest(null, configuration, { inputBound: 0 }).verdict, 'allow');
  // Two halves that are each under the line together refuse: the policy path reads the same floor.
  assert.equal(estimateInput(payload, { baseline: 300_000, delta: 0 }).bound, 300_000);
  assert.equal(estimateInput(payload, { baseline: 300_000, delta: 500_000 }).bound, 800_000);
});

test('overhead growth is added to a reused report', () => {
  const a = { role: 'user', content: 'a'.repeat(1000) };
  const small = { model: 'm', input: [a], tools: [], max_output_tokens: 100 };
  const one = estimateInput(small);
  const grown = { ...small, tools: [{ type: 'function', name: 't', parameters: { type: 'object', properties: {} } }] };
  const two = estimateInput(grown, { previous: { items: one.items, input: 1000, overheadBytes: one.overheadBytes } });
  const growth = two.overheadBytes - one.overheadBytes;
  assert(growth > 0, 'the tool list grew');
  assert.equal(two.method, 'prefix-delta');
  assert.equal(two.evidence.addedBytes, 0, 'no item was appended');
  assert.equal(two.evidence.nonInputBytes, growth);
  assert.equal(two.bound, 1000 + growth, 'the body growth is charged on top of the reused report');
  // A body that only shrank is never credited below the report.
  const shrunk = estimateInput(small, { previous: { items: one.items, input: 1000, overheadBytes: one.overheadBytes + 50 } });
  assert.equal(shrunk.evidence.nonInputBytes, 0);
  assert.equal(shrunk.bound, 1000);
});
