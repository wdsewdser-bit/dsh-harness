import { fail, GATE_RATIO } from '../contracts/index.mjs';

/**
 * The hard-limit ratio is defined once, in contracts, so the budget rule and the read-only projections cannot spell
 * two versions of it. The pre-request gate refuses once the estimated input ALONE reaches GATE_RATIO of the window:
 * 75% of it already leaves a quarter for the answer, so charging a full output cap on top counted the same headroom
 * twice (plan §1.2). Re-exported here because the budget rule is what gives the number its meaning.
 */
export { GATE_RATIO };

/** The refusal of a request whose input alone reaches the hard limit; the live transport raises the same code. */
export const GATE_CODE = 'CONTEXT_75_PERCENT_GATE_BEFORE_REQUEST';

/**
 * Serialize a request body exactly as it goes on the wire; 08 §3.2.
 *
 * Only the TOP-LEVEL `signal` of the caller's options is dropped: that is the transport-owned AbortSignal slot and
 * never payload. A `signal` anywhere else - a tool schema's `properties.signal`, a tool argument, a document - is
 * ordinary data and is preserved, because the string this function produces is the body that is sent; a global
 * exclusion would silently rewrite a caller's tool schema.
 */
const serialize = value => JSON.stringify(value, function (key, item) {
  return key === 'signal' && this === value ? undefined : item;
});

/**
 * Input parts whose cost the byte estimate cannot bound; 08 §3.2.
 *
 * Spelled out per protocol, because the payload's own media part must be recognized by its structure and not by a
 * substring in the serialized body: the Responses API carries `input_image`, `input_audio`, `input_file` and the
 * `image_generation_call` output item; chat completions carries `image_url`, `input_audio` and `file`; older
 * vocabularies spell the same parts `image`, `audio`, `video`, `audio_url`, `video_url`.
 */
const MEDIA_TYPES = new Set([
  'image', 'audio', 'video', 'image_url', 'audio_url', 'video_url',
  'input_image', 'input_audio', 'input_file', 'file', 'image_generation_call',
]);

/**
 * Every item list the body carries. A body that spells both `input` and `messages` is ambiguous about which list
 * would be sent, so both are inspected: the media check is about the payload as a whole, and a media part that sits
 * in the list the estimator did not pick must not be priced away.
 */
function itemLists(options) {
  if (!options || typeof options !== 'object') return [];
  return [options.input, options.messages].filter(Array.isArray);
}

/**
 * Bounds for the media scan. A payload past them cannot be inspected inside this budget, so it is UNPRICED (fail
 * closed) rather than priced as if it carried nothing. Real payloads sit orders of magnitude below both: the deepest
 * content part is a handful of levels in, and a 1 MB body is a few hundred thousand values at most.
 */
const SCAN_MAX_DEPTH = 512;
const SCAN_MAX_NODES = 2_000_000;

/**
 * True when the payload carries a content part whose cost is tokens, not bytes - or when it is too large or too deep
 * to be inspected at all. Reads `type` fields of the plain data, so a part is recognized however the protocol spells
 * it and wherever it is nested, while a string that merely mentions "image" is not a part and is never inspected.
 *
 * The walk is iterative with an explicit stack: recursion would blow the engine stack on a payload the serializer
 * itself accepts, and the depth/node budget turns "cannot be inspected" into the same refusal as "carries media".
 */
function unpriceableContent(lists) {
  const stack = [];
  for (const list of lists) stack.push([list, 0]);
  let nodes = 0;
  while (stack.length) {
    const [value, depth] = stack.pop();
    if (++nodes > SCAN_MAX_NODES || depth > SCAN_MAX_DEPTH) return true;
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      for (const entry of value) stack.push([entry, depth + 1]);
      continue;
    }
    if (typeof value.type === 'string' && MEDIA_TYPES.has(value.type)) return true;
    for (const key of Object.keys(value)) stack.push([value[key], depth + 1]);
  }
  return false;
}

/** Validate usage and reject conflicting metering aliases; 08 §3.2, §7.2 F. */
export function measureUsage(usage) {
  if (
    !usage ||
    !Number.isFinite(usage.inputTokens) ||
    !Number.isFinite(usage.outputTokens) ||
    usage.inputTokens < 0 ||
    usage.outputTokens < 0
  ) {
    fail('UNKNOWN_BUDGET');
  }
  const aliases = [
    ['cacheWriteTokens', 'cache_write_tokens'],
    ['cacheReadTokens', 'cache_read_tokens'],
  ];
  for (const [canonical, alias] of aliases) {
    if (
      usage[canonical] !== undefined &&
      usage[alias] !== undefined &&
      usage[canonical] !== usage[alias]
    ) {
      fail('UNKNOWN_BUDGET');
    }
  }
  return {
    input: usage.inputTokens,
    cacheWrite: usage.cacheWriteTokens ?? usage.cache_write_tokens ?? null,
    economics: 'unknown',
  };
}

/**
 * The pending items a request is built from: the transport's `input` (Responses API) or the adapter's
 * `messages`. Everything else in the body is overhead, and its growth is what a reused report adds on top.
 */
function inputOf(options) {
  if (!options || typeof options !== 'object') return null;
  if (Array.isArray(options.input)) return { field: 'input', items: options.input };
  if (Array.isArray(options.messages)) return { field: 'messages', items: options.messages };
  return null;
}

/**
 * Estimate the input this request will cost, in tokens, from the request body alone.
 *
 * Two methods, the same two the live transport has always recorded on its request rows:
 *  - `prefix-delta`, only with `previous` (the sample of the last request of this session the provider accepted):
 *    when the new items still begin with the previous request's items, item for item, the input the provider
 *    reported for that request is the measured cost of the shared prefix and only what was appended is unknown:
 *    reported input + UTF-8 bytes of the appended items + any growth of the non-input fields (tools, model, caps).
 *    Bytes of the appended items are again an upper bound on their tokens (a BPE token is at least one byte), so the
 *    sum still bounds the real prompt; the live soak reported 51,835 input tokens for a 159,104-byte prompt, i.e.
 *    the report covers the whole prompt and not only its text.
 *  - `full-bytes` (first request of a session, rewritten or folded history, rotated native session): the UTF-8 byte
 *    count of the whole body. It needs no calibration and is always safe.
 *
 * `baseline + delta` is a floor, never a replacement: tokens a committed sample already spent are inside the next
 * prompt's history, so the estimate may not fall below them. The offline guard passes the session total there; the
 * transport passes nothing and is estimated from its payload alone.
 *
 * A payload carrying a media part (image, audio, video, file, image generation) cannot be bounded this way and
 * refuses with UNKNOWN_BUDGET, as does a body with no item list or a non-finite sample. Both the price and that check
 * are taken from the serialized-and-parsed body (see the function), and a body that cannot be serialized or parsed,
 * or that is deeper/wider than the scan budget, refuses the same way instead of throwing.
 *
 * Known limit, inherited unchanged from the live transport this rule now owns: `prefix-delta` reuses the reported
 * input of the previous request whenever the item list still begins with its items, so a request that swaps the model
 * or the tool set at exactly the same byte length keeps the old measurement. Tools' *growth* is added (nonInputBytes),
 * a same-size replacement is not detected, and the old transport had the same blind spot. Fixing it would change the
 * live estimate, which this work package may not do.
 *
 * -> { bound, method, evidence, items, overheadBytes, payloadBytes }
 */
export function estimateInput(options, { baseline = 0, delta = 0, previous = null } = {}) {
  // One representation for every question asked here: the body as it would be sent - serialized with the same
  // serializer that drops the abort signal, then parsed back into plain data. The bytes, the item list and the media
  // check all read from it, so nothing that exists only before serialization (a toJSON() that invents a part, a
  // non-enumerable field, the signal object) or only after it can make any two answers disagree.
  let wire, data;
  try {
    wire = serialize(options);
    if (typeof wire !== 'string') fail('UNKNOWN_BUDGET');
    data = JSON.parse(wire);
  } catch (error) {
    if (error?.code === 'UNKNOWN_BUDGET') throw error;
    // A body that cannot be serialized or parsed (a cycle, a BigInt, nesting past the engine's stack) cannot be
    // priced; 08 §3.2 makes unpriced UNKNOWN, never "small".
    fail('UNKNOWN_BUDGET');
  }
  const shape = inputOf(data);
  if (!shape || !Number.isFinite(baseline) || !Number.isFinite(delta)) {
    fail('UNKNOWN_BUDGET');
  }
  // Every item list the body carries is inspected, not only the one this estimate prices: an image URL costs tokens,
  // not bytes, so its request cannot be priced by the byte bound at all and refuses with UNKNOWN_BUDGET.
  if (unpriceableContent(itemLists(data))) {
    fail('UNKNOWN_BUDGET');
  }
  const items = shape.items.map(item => JSON.stringify(item));
  const payloadBytes = Buffer.byteLength(wire);
  // Measured on the body with its item list emptied, so the cost of the history itself never enters the overhead.
  const overheadBytes = Buffer.byteLength(serialize({ ...data, [shape.field]: [] }));
  let bound = payloadBytes;
  let method = 'full-bytes';
  let evidence = {
    reason: previous ? 'the previous input is not a prefix of this one' : 'no previous request for this session',
  };
  if (
    previous &&
    Array.isArray(previous.items) &&
    Number.isFinite(previous.input) &&
    Number.isFinite(previous.overheadBytes) &&
    previous.items.length <= items.length &&
    previous.items.every((text, index) => text === items[index])
  ) {
    const addedBytes = items
      .slice(previous.items.length)
      .reduce((total, text) => total + Buffer.byteLength(text), 0);
    // A body that grew (a tool added, a model swapped) is not part of the reused report either.
    const nonInputBytes = Math.max(0, overheadBytes - previous.overheadBytes);
    bound = previous.input + addedBytes + nonInputBytes;
    method = 'prefix-delta';
    evidence = {
      previousInput: previous.input,
      reusedItems: previous.items.length,
      addedItems: items.length - previous.items.length,
      addedBytes,
      nonInputBytes,
    };
  }
  const measured = baseline + delta;
  if (measured > bound) {
    bound = measured;
    evidence = { ...evidence, measuredFloor: measured };
  }
  return { bound, method, evidence, items, overheadBytes, payloadBytes, wire, data };
}

/**
 * Plan one request: the input estimate, the verdict, and what the request may ask for.
 *
 * The gate reads the input alone — `I >= GATE_RATIO * W` refuses — because 75% of the window already leaves a
 * quarter of it for the answer. The cap the request then asks for is `min(R, W - I)`: a long prompt shortens the
 * answer instead of ending the run. The reservation must stay an upper bound on what the request can spend:
 * `max(65536, payloadBytes * 4) + maxOutputTokens`. The actual input cannot exceed the estimate the gate just
 * bounded and the actual output cannot exceed the cap asked for here (the provider stops at it and says so in
 * incomplete_details), so the reservation covers every usage this request can produce; reserving the full route cap
 * instead would hold 358,000 tokens for a request whose input already spent most of the window.
 *
 * `configuration` is `{ W, R, M }`: the context window, the route's output cap, and the uncertified-folding
 * margin. M is reported, never part of the gate (§1.2). `inputBound` is a committed input measurement the product
 * policy path already holds: it replaces the payload when there is no request body to measure.
 *
 * -> { I, W, R, M, maxOutputTokens, reserve, payloadBytes, body, verdict, code, purpose, method, evidence, items,
 *      overheadBytes }; verdict is 'allow' | 'block' | 'unknown' and code is the refusal or null. `body` is the
 *      request as it will be sent (a string built from the plan's own data, with the cap applied) - a caller that
 *      sends a request sends this one, so the price, the media scan and the wire can never describe different bytes.
 */
export function planRequest(options, configuration, {
  purpose = 'main',
  baseline = 0,
  delta = 0,
  previous = null,
  inputBound = null,
} = {}) {
  const W = configuration?.W;
  const R = configuration?.R;
  const M = configuration?.M ?? 0;
  const refused = {
    I: null,
    W: Number.isFinite(W) ? W : null,
    R: Number.isFinite(R) ? R : null,
    M: Number.isFinite(M) ? M : null,
    maxOutputTokens: null,
    reserve: null,
    payloadBytes: null,
    body: null,
    verdict: 'unknown',
    code: 'UNKNOWN_BUDGET',
    purpose,
    method: null,
    evidence: null,
    items: [],
    overheadBytes: 0,
  };
  if (
    !Number.isSafeInteger(W) ||
    W <= 0 ||
    !Number.isFinite(R) ||
    R <= 0 ||
    !Number.isSafeInteger(M) ||
    M < 0
  ) {
    return refused;
  }
  // Two different output caps in one body is a caller error, not a request to price; 08 §3.2.
  if (
    options &&
    options.maxTokens !== undefined &&
    options.maxOutputTokens !== undefined &&
    options.maxTokens !== options.maxOutputTokens
  ) {
    return refused;
  }
  let estimate;
  if (Number.isFinite(inputBound)) {
    // No body to measure: the committed measurement is the estimate.
    estimate = {
      bound: inputBound,
      method: 'measured-input',
      evidence: { reason: 'committed input measurement' },
      items: [],
      overheadBytes: 0,
      wire: null,
      data: null,
    };
  } else {
    try {
      estimate = estimateInput(options, { baseline, delta, previous });
    } catch (error) {
      if (error?.code !== 'UNKNOWN_BUDGET') throw error;
      return refused;
    }
  }
  const I = estimate.bound;
  const maxOutputTokens = Math.min(R, W - I);
  // The request that will be sent, built from the SAME parsed data the estimate and the media scan read: the
  // caller's object is serialized exactly once (inside estimateInput), and every later string - this body, the
  // overhead, the bytes the reservation is priced on - is produced from plain data. A toJSON() that answers
  // differently on a second call therefore cannot price one body and send another.
  let body = null;
  try {
    if (estimate.data && typeof estimate.data === 'object') {
      const capKey = ('max_output_tokens' in estimate.data)
        ? 'max_output_tokens'
        : ('max_tokens' in estimate.data ? 'max_tokens' : 'maxOutputTokens');
      body = serialize({ ...estimate.data, [capKey]: maxOutputTokens });
    }
  } catch {
    // Plain data cannot fail to serialize (no cycles, no BigInt); if it ever does, the request is unpriced.
    return refused;
  }
  const payloadBytes = body === null ? 0 : Buffer.byteLength(body);
  const reserve = Math.max(65536, payloadBytes * 4) + maxOutputTokens;
  const blocked = I >= GATE_RATIO * W;
  return {
    ...refused,
    I,
    maxOutputTokens,
    reserve,
    payloadBytes,
    body,
    verdict: blocked ? 'block' : 'allow',
    code: blocked ? GATE_CODE : null,
    method: estimate.method,
    evidence: estimate.evidence,
    items: estimate.items,
    overheadBytes: estimate.overheadBytes,
  };
}

/**
 * Enforce the request budget without changing the wire options; the rule is planRequest's, once.
 *
 * The pre-M3a signature and shape are kept for the offline callers: I is the input estimate, R the durable
 * reservation, M the uncertified-folding margin. The numbers differ from the old inline formula in the two ways
 * §1.2 records — the estimate is the transport's byte bound (no `*2 + 1024` inflation) and the gate reads the
 * input alone — and nothing on the live path calls this.
 */
export function checkWire(options, configuration, purpose = 'main', baseline = 0, delta = 0) {
  const plan = planRequest(options, configuration, { purpose, baseline, delta });
  if (plan.verdict === 'unknown') {
    fail('UNKNOWN_BUDGET');
  }
  if (plan.verdict === 'block') {
    fail('BLOCKED_BUDGET');
  }
  return { I: plan.I, W: plan.W, R: plan.reserve, M: plan.M, purpose };
}

/** The pre-M3a estimator name, kept for the offline callers: the same input bound estimateInput returns. */
export function estimateRequest(options, baseline = 0, delta = 0) {
  return estimateInput(options, { baseline, delta }).bound;
}
