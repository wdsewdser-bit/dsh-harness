import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  DISPATCH_CONTRACT, DispatchEvidenceLedger, classifyAccepted, dispatchDigest, summariseDispatchMessages,
} from '../../packages/contracts/index.mjs';
import { Transport } from '../real/transport.mjs';
import { buildConfig, selectedBuild } from '../../packages/adapter-dsh/build-target.mjs';

/**
 * A-pack probe: dispatch-phase evidence over the supported paths; M1b design §1.4, §2.2, §6 A pack.
 *
 * Everything runs offline against a controlled HTTP receiver on 127.0.0.1 with an ephemeral port. Nothing here talks
 * to the live gateway (127.0.0.1:<gateway-port>) or to any external endpoint, and no credentials are read or spent.
 *
 * The build under test is DSH_UPSTREAM_BUILD (a *copy* with the llm-dispatch candidate applied). The build audit runs
 * first; when the anchors do not match verbatim, or the patch is not in the build, the probe reports patch-missing and
 * stops. It never degrades into "diagnostic only".
 */
const REPO = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const BUILD = path.resolve(selectedBuild());
const MODULES = BUILD + '/node_modules/@deepseek-ai/';
const moduleUrl = file => pathToFileURL(MODULES + file + '/lib/index.js').href;

const results = [];
const ok = (id, detail) => {
  results.push({ id, ok: true, detail });
  console.log('PASS (' + id + ') ' + detail);
};
const fail = (id, error) => {
  results.push({ id, ok: false, detail: String(error && error.message ? error.message : error) });
  console.log('FAIL (' + id + ') ' + (error && error.stack ? error.stack : error));
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate, label, timeoutMs = 2000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error('timed out waiting for ' + label);
};

/**
 * A controlled receiver: 127.0.0.1, ephemeral port, closed by the caller. close() also destroys any connection a
 * scenario deliberately left hanging, so a blocked body can never keep the probe alive.
 */
async function receiver(handler) {
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    sockets.add(request.socket);
    request.socket.on('close', () => sockets.delete(request.socket));
    handler(request, response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    url: 'http://127.0.0.1:' + port,
    close: () => new Promise(resolve => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

async function loadBuild() {
  const cordis = await import(moduleUrl('cordis'));
  const llm = await import(moduleUrl('dsh-llm'));
  const deepseek = await import(moduleUrl('dsh-llm-deepseek'));
  if (typeof llm.dispatchAttemptOf !== 'function') throw new Error('the build has no dispatchAttemptOf: the llm-dispatch patch is not applied');
  return { cordis, llm, deepseek };
}

/**
 * One DeepSeek Messages attempt through the shipped registerDeepSeekProvider wiring, against a controlled receiver.
 */
async function deepseekAttempt(build, { port, sessionId = 'session:probe', markMain = true, signal = null, body = 'hello', onEvent = null }) {
  const { cordis, llm, deepseek } = build;
  const ctx = new cordis.Context();
  const events = [];
  ctx.on('llm/dispatch', event => {
    events.push(event);
    onEvent?.(event);
  });
  const runtime = new llm.LlmRuntime(ctx);
  const connection = deepseek.resolveAdapterOptions({ baseURL: 'http://127.0.0.1:' + port }, undefined);
  deepseek.registerDeepSeekProvider(ctx, 'deepseek', {
    options: () => connection,
    resolveAuth: async () => ({ headers: {} }),
    resolveUserId: () => 'probe-user',
    resolveAttachments: () => undefined,
  });
  const message = llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: body }] });
  const options = { provider: 'deepseek', model: 'probe-model', sessionId, messages: [message] };
  if (markMain) llm.markAgentLoopRequest(options);
  if (signal) options.signal = signal;
  return { ctx, runtime, events, options, message };
}

/**
 * Run one attempt until the expected phase appears (or the wait expires), then abort it and let the stream settle.
 * The abort is what makes a hanging body or a hanging response end: every scenario closes its own request.
 */
async function runAttempt(attempt, { until = event => event.phase === 'committed', abort = () => {}, waitMs = 600 } = {}) {
  const iterator = attempt.runtime.stream(attempt.options)[Symbol.asyncIterator]();
  let failure = null;
  const pump = (async () => {
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
      }
    } catch (error) {
      failure = error;
    }
  })();
  const settled = Promise.race([pump, sleep(waitMs + 750)]);
  try {
    await waitFor(() => attempt.events.some(until), 'phase', waitMs);
  } finally {
    abort();
    await settled.catch(() => {});
  }
  return { failure };
}

/**
 * The real chain the review asks for: the patched runtime mints the attempt, an offline adapter that declares the
 * contract hands that attempt to the real Transport, and the Transport answers a controlled receiver on 127.0.0.1.
 * Nothing in this helper fills in an attempt id, a kind or a session: every field of every event comes from the patch.
 */
async function realChain(build, { message, sessionId = 'session:chain', markMain = true, purpose = null }) {
  const { llm, cordis } = build;
  const ctx = new cordis.Context();
  const events = [];
  ctx.on('llm/dispatch', event => events.push(event));
  const runtime = new llm.LlmRuntime(ctx);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm1b-probe-chain-'));
  const facts = { requests: [], latency: {} };
  const budget = { canAdmit: () => true, reserve: () => ({}), settle: () => {} };
  const received = [];
  const server = await receiver((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      received.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 3, output_tokens:
        1 } }));
    });
  });
  const transport = new Transport({
    root, budget, mode: 'live', key: 'probe-key-0123456789', fake: null, facts, stopped: () => null,
  });
  // The provider route is never contacted: the transport's own fetch goes to the controlled receiver.
  transport.fetch = (url, init) => {
    assert.ok(url.endsWith('/responses'), 'the transport addresses the Responses route');
    return fetch(server.url + '/responses', init);
  };
  class OfflineChain extends llm.LlmAdapter {
    // This adapter publishes send-started and committed itself, so it declares the contract.
    dispatchContract = DISPATCH_CONTRACT;
    providerInfo(id) { return { id, name: 'offline-chain' }; }
    async resolveModel(provider, id) { return { provider, id, name: id, context: { contextWindow: 100000 } }; }
    async prepareCall(provider, id) {
      return {
        model: { provider, id, name: id, context: { contextWindow: 100000 }, inputModalities: ['text'] },
        stream(options) {
          return (async function* () {
            const attempt = llm.dispatchAttemptOf(options);
            assert.ok(attempt, 'the patched runtime minted an attempt for the final options');
            const input = options.messages.map(item => ({
              type: 'message', role: item.role, content: item.content.map(block => ({ type: 'input_text', text: block.text })),
            }));
            yield { type: 'text-delta', text: 'chain' };
            await transport.call('member:probe', input, [], { attempt, attemptId: attempt.id, requestId: 'probe-chain' });
          })();
        },
      };
    }
  }
  runtime.registerAdapter(['offline-chain'], new OfflineChain());
  const options = { provider: 'offline-chain', model: 'probe-chain-model', sessionId, messages: [message] };
  if (markMain) llm.markAgentLoopRequest(options);
  if (purpose !== null) options.purpose = purpose;
  let failure = null;
  try {
    for await (const chunk of runtime.stream(options)) void chunk;
  } catch (error) {
    failure = error;
  }
  return {
    events, received, facts, transport, failure,
    cleanup: async () => {
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** One minimal, valid Messages SSE stream: the adapter translator requires message_stop to complete. */
function okSse(text = "ok") {
  const frames = [
    { type: 'message_start', message: { id: 'msg_probe', type: 'message', role: 'assistant', model: 'probe-image-model', content: [], stop_reason: null, usage:
      {
          input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  return frames.map(frame => "event: " + frame.type + "\ndata: " + JSON.stringify(frame) + "\n\n").join("");
}

/** A controlled attachment store: one normalized version per durable reference, small enough to stay inline. */
function imageAttachments(ref) {
  const data = Buffer.from('probe-image-bytes');
  return {
    readImageRequest(request) {
      assert.equal(request.attachmentId, ref.attachmentId);
      return {
        variantId: 'variant:' + ref.attachmentId,
        attachment: { attachmentId: ref.attachmentId, name: ref.name },
        mediaType: 'image/png', width: 32, height: 32, bytes: data.byteLength, data, hasAlpha: false,
      };
    },
  };
}

/**
 * One DeepSeek Messages attempt with an image, through the shipped registerDeepSeekProvider wiring. The image makes
 * the request go through prepareFileIds / RequestFiles, which is where files.retry and the inline fallback live.
 */
async function deepseekImageAttempt(build, { port, ref, fileStore }) {
  const { cordis, llm, deepseek } = build;
  const ctx = new cordis.Context();
  const events = [];
  ctx.on('llm/dispatch', event => events.push(event));
  const runtime = new llm.LlmRuntime(ctx);
  const connection = deepseek.resolveAdapterOptions({
    baseURL: 'http://127.0.0.1:' + port,
    models: [{ id: 'probe-image-model', inputModalities: ['image', 'text'] }],
  }, undefined);
  // The shipped DeepSeekAdapter, built with the same dependency shape registerDeepSeekProvider builds, minus the image
  // access path: this probe mounts no filesystem process service, so the image handle text simply carries no normalized
  // path. The retry and inline fallback under test live in the adapter, not in the registration wrapper.
  const adapter = new deepseek.DeepSeekAdapter({
    options: () => connection,
    resolveAuth: async () => ({ headers: {} }),
    resolveUserId: () => 'probe-user',
    resolveAttachments: () => imageAttachments(ref),
    resolveFiles: () => fileStore,
    prepareExtensions: () => Promise.resolve({ fields: {}, accept: () => Promise.resolve() }),
    onDispatchPhase: (options, phase, extra) => llm.dispatchAttemptOf(options)?.phase(phase, extra),
  });
  runtime.registerAdapter(['deepseek'], adapter);
  const message = llm.createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'what is in this image?' }, { type: 'image', attachment: ref }],
  });
  const options = { provider: 'deepseek', model: 'probe-image-model', sessionId: 'session:image', messages: [message] };
  llm.markAgentLoopRequest(options);
  return { ctx, runtime, events, options, message };
}

// ----------------------------------------------------------------------------------------------------------------
// (a) one adapterStream = one prepared; the lookup comes from the runtime's module instance
async function probeA(build) {
  const { llm } = build;
  const ctx = new build.cordis.Context();
  const events = [];
  ctx.on('llm/dispatch', event => events.push(event));
  const runtime = new llm.LlmRuntime(ctx);
  let streams = 0;
  class Local extends llm.LlmAdapter {
    providerInfo(id) { return { id, name: id }; }
    async resolveModel(provider, id) { return { provider, id, name: id, context: { contextWindow: 100000 } }; }
    async prepareCall(provider, id) {
      return {
        model: { provider, id, name: id, context: { contextWindow: 100000 }, inputModalities: ['text'] },
        stream() {
          streams += 1;
          return (async function* () { yield { type: 'text-delta', text: 'ok' }; })();
        },
      };
    }
  }
  runtime.registerAdapter(['local-probe'], new Local());
  const sent = [];
  for (let index = 0; index < 3; index++) {
    const message = llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello ' + index }] });
    const options = { provider: 'local-probe', model: 'm', sessionId: 'session:a-' + index, messages: [message] };
    llm.markAgentLoopRequest(options);
    sent.push(message);
    for await (const chunk of runtime.stream(options)) void chunk;
  }
  const prepared = events.filter(event => event.phase === 'prepared');
  assert.equal(prepared.length, streams, 'one prepared per adapterStream (' + prepared.length + ' vs ' + streams + ')');
  assert.equal(streams, 3, 'three adapterStream calls');
  for (const event of prepared) {
    const index = Number(event.sessionId.split('-').at(-1));
    assert.equal(event.contract, DISPATCH_CONTRACT);
    assert.match(event.attempt, /^dispatch:\d+$/);
    assert.equal(event.kind, 'main');
    assert.equal(event.messages.length, 1);
    assert.equal(event.messages[0].digest, dispatchDigest(sent[index]), 'the patch digest equals the host digest');
    assert.equal(event.messages[0].digest, summariseDispatchMessages([sent[index]])[0].digest);
  }
  // The WeakMap is shared only when the provider resolves the very file the runtime was loaded from.
  const resolved = fs.realpathSync(createRequire(MODULES + 'dsh-llm-deepseek/lib/index.js').resolve('@deepseek-ai/dsh-llm'));
  assert.equal(resolved, fs.realpathSync(MODULES + 'dsh-llm/lib/index.js'), 'the provider and the runtime share one dsh-llm module');
  ok('a', 'one prepared per adapterStream, patch digest equals host digest, provider and runtime share one module instance');
}

// ----------------------------------------------------------------------------------------------------------------
// (b) send-started with no committed: RST, refused connection, and a cancel before fetch
async function probeB(build) {
  // 1. The receiver accepts and resets the connection.
  {
    const server = await receiver(request => { request.socket.destroy(); });
    try {
      const attempt = await deepseekAttempt(build, { port: server.port });
      const controller = new AbortController();
      await runAttempt(attempt, { until: () => false, abort: () => controller.abort(), waitMs: 400 }).catch(() => {});
      const phases = attempt.events.map(event => event.phase);
      assert.ok(phases.includes('prepared'), 'prepared is always reported');
      assert.ok(phases.includes('send-started'), 'send-started was reported before the fetch');
      assert.ok(!phases.includes('committed'), 'a reset connection produced no committed event');
      const ledger = new DispatchEvidenceLedger({ leaseMs: 60000 });
      for (const event of attempt.events) ledger.observe(event, { sessionSeq: 7, epoch: 'e1' });
      assert.equal(ledger.slot(attempt.events[0].attempt).committedCount, 0);
      assert.equal(ledger.status().visible, 0, 'no visible without committed');
    } finally {
      await server.close();
    }
  }
  // 2. The route points at a closed port.
  {
    const closed = await receiver(() => {});
    const port = closed.port;
    await closed.close();
    const attempt = await deepseekAttempt(build, { port });
    const controller = new AbortController();
    await runAttempt(attempt, { until: () => false, abort: () => controller.abort(), waitMs: 400 }).catch(() => {});
    const phases = attempt.events.map(event => event.phase);
    assert.ok(phases.includes('prepared') && phases.includes('send-started'), 'prepared + send-started on a refused connection');
    assert.ok(!phases.includes('committed'), 'a refused connection cannot be committed');
  }
  // 3. Cancelled before fetch: never send-started, and the attempt is failed(notSent).
  {
    const attempt = await deepseekAttempt(build, { port: 1, signal: AbortSignal.abort() });
    await runAttempt(attempt, { until: () => false, waitMs: 300 }).catch(() => {});
    const phases = attempt.events.map(event => event.phase);
    assert.ok(!phases.includes('send-started'), 'a pre-fetch cancel never reaches send-started');
    assert.ok(!phases.includes('committed'), 'a pre-fetch cancel is not committed');
    assert.equal(phases.filter(phase => phase === 'failed').length, 1, 'the pre-fetch cancel is one failed(notSent)');
    const ledger = new DispatchEvidenceLedger({ leaseMs: 60000 });
    for (const event of attempt.events) ledger.observe(event, { sessionSeq: 1, epoch: 'e1' });
    assert.equal(ledger.status().visible, 0);
  }
  ok('b', 'reset, refused connection and a pre-fetch cancel: prepared (+ send-started) only, no committed, zero visible');
}

// ----------------------------------------------------------------------------------------------------------------
// (c) headers first, body hangs: committed holds while the body is still open
async function probeC(build) {
  let bodyEnded = false;
  let atCommitted = null;
  const server = await receiver((request, response) => {
    request.on('data', () => {});
    response.on('close', () => { bodyEnded = true; });
    // Headers and one comment chunk, then nothing: the body stays open.
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders?.();
    response.write(': ping\n\n');
  });
  try {
    const attempt = await deepseekAttempt(build, {
      port: server.port,
      onEvent: event => { if (event.phase === 'committed' && atCommitted === null) atCommitted = { bodyEnded, at: Date.now() }; },
    });
    const controller = new AbortController();
    const started = Date.now();
    await runAttempt(attempt, { abort: () => controller.abort(), waitMs: 3000 });
    const committed = attempt.events.find(event => event.phase === 'committed');
    assert.ok(committed, 'committed was reported although the body never ended');
    assert.equal(atCommitted?.bodyEnded, false, 'the body was still open when committed arrived');
    assert.ok(atCommitted.at - started < 3000, 'committed did not wait for the body');
    assert.equal(committed.httpStatus, 200);
  } finally {
    await server.close();
  }
  ok('c', 'headers first and a hanging body: committed holds immediately, while the body is still open');
}

// ----------------------------------------------------------------------------------------------------------------
// (d) accepted but never answered: send-started only, unknown once the evidence lease expires
async function probeD(build) {
  const server = await receiver(request => { request.on('data', () => {}); });
  try {
    const attempt = await deepseekAttempt(build, { port: server.port });
    const controller = new AbortController();
    await runAttempt(attempt, { until: () => false, abort: () => controller.abort(), waitMs: 400 }).catch(() => {});
    const phases = attempt.events.map(event => event.phase);
    assert.ok(phases.includes('send-started'), 'send-started is reported');
    assert.ok(!phases.includes('committed'), 'no response headers means no committed');
    let clock = Date.now();
    const ledger = new DispatchEvidenceLedger({ leaseMs: 25, now: () => clock });
    for (const event of attempt.events) ledger.observe(event, { sessionSeq: 3, epoch: 'e1' });
    clock += 100;
    assert.deepEqual(ledger.expire(), [attempt.events[0].attempt], 'the attempt turned unknown when the lease expired');
    assert.equal(ledger.status().visible, 0, 'an expired attempt is never visible');
    assert.equal(ledger.missing().at(-1).reason, 'evidence-lease-expired');
  } finally {
    await server.close();
  }
  ok('d', 'accepted connection with no response headers: send-started only, unknown after the evidence lease');
}

// ----------------------------------------------------------------------------------------------------------------
// (e) accepted classification: every status commits; the classification is diagnostic
async function probeE(build) {
  const cases = [
    { status: 200, body: '{}', expected: 'accepted' },
    { status: 401, body: '{}', expected: 'auth-rejected' },
    { status: 403, body: '{}', expected: 'auth-rejected' },
    { status: 502, body: '<html>proxy error</html>', expected: 'proxy-error' },
  ];
  for (const item of cases) {
    const server = await receiver((request, response) => {
      request.on('data', () => {});
      request.on('end', () => {
        response.writeHead(item.status, { 'content-type': 'application/json' });
        response.end(item.body);
      });
    });
    try {
      const attempt = await deepseekAttempt(build, { port: server.port });
      const controller = new AbortController();
      await runAttempt(attempt, { abort: () => controller.abort(), waitMs: 3000 });
      const committed = attempt.events.find(event => event.phase === 'committed');
      assert.ok(committed, 'committed for HTTP ' + item.status);
      assert.equal(committed.httpStatus, item.status);
      assert.equal(classifyAccepted(committed.httpStatus), item.expected);
      const ledger = new DispatchEvidenceLedger({ leaseMs: 60000 });
      for (const event of attempt.events) ledger.observe(event, { sessionSeq: 2, epoch: 'e1' });
      assert.equal(ledger.status().visible, 1, 'committed is visible whatever the classification');
      assert.equal(ledger.receipts()[0].accepted, null, 'the patch supplies httpStatus; the host classifies');
      // The request-side watermark is captured at send-started and echoed at committed; it is never re-read later.
      assert.equal(ledger.receipts()[0].sessionSeq, 2, 'committed echoes the send-started sessionSeq');
      assert.equal(ledger.receipts()[0].confirmedSessionSeq, null, 'confirmedSessionSeq stays a separate diagnostic');
    } finally {
      await server.close();
    }
  }
  ok('e', '200/401/403/502 all commit; accepted classification stays diagnostic and never changes visibility');
}

// ----------------------------------------------------------------------------------------------------------------
// (f) the three supported paths, and the real/CPA attemptId through meta, gate and dispatch
async function probeF(build) {
  // 1. DeepSeek adapter path.
  {
    const server = await receiver((request, response) => {
      request.on('data', () => {});
      request.on('end', () => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(''); });
    });
    try {
      const attempt = await deepseekAttempt(build, { port: server.port });
      const controller = new AbortController();
      await runAttempt(attempt, { abort: () => controller.abort(), waitMs: 3000 });
      assert.ok(attempt.events.some(event => event.phase === 'committed' && event.httpStatus === 200), 'deepseek-adapter committed');
    } finally {
      await server.close();
    }
  }

  // 2. real/CPA transport: the attempt travels in meta and is reported after the gate and the awaited fetch.
  const { Transport } = await import('../real/transport.mjs');
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm1b-probe-cpa-'));
    const server = await receiver((request, response) => {
      request.on('data', () => {});
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 10, output_tokens:
          2 } }));
      });
    });
    try {
      const events = [];
      const budget = { canAdmit: () => true, reserve: () => ({ token: true }), settle: () => {} };
      const facts = { requests: [], latency: {} };
      const transport = new Transport({ root, budget, mode: 'live', key: 'probe-key-0123456789', fake: null, facts,
        stopped: () => null, onDispatchPhase: event => events.push(event) });
      // The route is never contacted: the injected fetch redirects to the controlled receiver.
      transport.fetch = (url, init) => {
        assert.ok(url.endsWith('/responses'), 'the transport addresses the Responses route');
        return fetch(server.url + '/responses', init);
      };
      const attemptId = 'dispatch:probe-meta';
      await transport.call('member:root', [], [], { attemptId, requestId: 'request:probe' });
      assert.deepEqual(events.map(event => event.phase), ['send-started', 'committed'], 'send-started then committed through the gate');
      assert.equal(events[0].attemptId, attemptId);
      assert.equal(events[1].attemptId, attemptId, 'the attempt id travels in meta');
      assert.equal(events[1].httpStatus, 200);
      assert.equal(facts.requests.length, 1, 'exactly one real request was made');
      assert.ok(!JSON.stringify(facts.requests[0].body ?? {}).includes(attemptId), 'the attempt id never enters the wire body');
      assert.equal(facts.requests[0].httpStatus, 200);
    } finally {
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // 3. fake provider path: the controlled receiver is the fake itself.
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm1b-probe-fake-'));
    try {
      const events = [];
      const budget = { canAdmit: () => true, reserve: () => ({}), settle: () => {} };
      const facts = { requests: [], latency: {} };
      let received = 0;
      const transport = new Transport({ root, budget, mode: 'fake', key: '', facts, stopped: () => null,
        fake: async () => { received += 1; return { output: [], usage: { input_tokens: 1, output_tokens: 1 } }; },
        onDispatchPhase: event => events.push(event) });
      await transport.call('member:root', [], [], { attemptId: 'dispatch:probe-fake' });
      assert.equal(received, 1, 'the fake receiver took the body');
      assert.deepEqual(events.map(event => event.phase), ['send-started', 'committed'], 'fake: committed after the receiver answered');
      assert.equal(events[1].httpStatus, 200);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  // Parts 2 and 3 are unit level: they drive the Transport directly with a hand-written attempt id. The end-to-end
  // chain (runtime -> adapter -> Transport -> receiver) is probe g, and DeepSeek's own recovery is probes i and j.
  ok('f', 'unit: deepseek adapter, a hand-driven transport and the fake provider all confirm; the meta attempt id stays off the wire');
}

// ----------------------------------------------------------------------------------------------------------------
// (g) auxiliary vs main through the real chain, consumed by the ledger's own filter
async function probeG(build) {
  const { llm } = build;
  const auxiliary = await realChain(build, {
    message: llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'compact this transcript' }] }),
    markMain: false, purpose: 'compaction', sessionId: 'session:aux-chain',
  });
  const main = await realChain(build, {
    message: llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'answer this question' }] }),
    sessionId: 'session:main-chain',
  });
  try {
    assert.equal(auxiliary.failure, null, 'the auxiliary request completed');
    assert.equal(main.failure, null, 'the main request completed');
    assert.equal(auxiliary.received.length, 1, 'the receiver took exactly one auxiliary request');
    assert.equal(main.received.length, 1, 'the receiver took exactly one main request');
    for (const event of auxiliary.events) assert.equal(event.kind, 'auxiliary', 'every phase says auxiliary');
    for (const event of main.events) assert.equal(event.kind, 'main', 'every phase says main');
    const ledger = new DispatchEvidenceLedger({ leaseMs: 60000 });
    for (const event of [...auxiliary.events, ...main.events]) ledger.observe(event, { sessionSeq: 1, epoch: 'e1' });
    // No caller-side filter here: the ledger observes both attempts and the consumer is what decides.
    assert.equal(ledger.status().attempts, 2, 'both attempts were observed');
    assert.equal(ledger.status().auxiliary, 1);
    assert.equal(ledger.status().visible, 2, 'both attempts committed');
    const consumable = ledger.consumable();
    assert.equal(consumable.length, 1, 'exactly one request is consumable evidence');
    assert.equal(consumable[0].slot.kind, 'main');
    assert.equal(consumable[0].attempt, main.events[0].attempt);
  } finally {
    await auxiliary.cleanup();
    await main.cleanup();
  }
  ok('g', 'auxiliary and main both observed; the ledger consumer, not the probe, filters auxiliary out of evidence');
}

// ----------------------------------------------------------------------------------------------------------------
// (h) a second real transmission in one attempt; listeners cannot change the request
async function probeH(build) {
  const { llm } = build;
  const ctx = new build.cordis.Context();
  const events = [];
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on('unhandledRejection', onUnhandled);
  ctx.on('llm/dispatch', () => { throw new Error('a throwing listener must not change the request'); });
  ctx.on('llm/dispatch', () => Promise.reject(new Error('a rejecting listener must not change the request')));
  ctx.on('llm/dispatch', event => events.push(event));
  const runtime = new llm.LlmRuntime(ctx);
  let served = 0;
  const server = await receiver((request, response) => {
    request.on('data', () => {});
    request.on('end', () => {
      served += 1;
      if (served === 1) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('');
        return;
      }
      // The second transmission is answered with a reset: a real failure after its send-started.
      request.socket.destroy();
    });
  });
  try {
    class TwoTransmissions extends llm.LlmAdapter {
      providerInfo(id) { return { id, name: id }; }
      async resolveModel(provider, id) { return { provider, id, name: id, context: { contextWindow: 100000 } }; }
      async prepareCall(provider, id) {
        const url = server.url + '/messages';
        return {
          model: { provider, id, name: id, context: { contextWindow: 100000 }, inputModalities: ['text'] },
          stream(options) {
            return (async function* () {
              const attempt = llm.dispatchAttemptOf(options);
              if (!attempt) throw new Error('MISSING_ATTEMPT');
              attempt.phase('send-started', { transmission: 1, sendStartedAt: Date.now() });
              const first = await fetch(url, { method: 'POST', body: '{}' });
              attempt.phase('committed', { transmission: 1, httpStatus: first.status });
              yield { type: 'text-delta', text: 'first' };
              attempt.phase('send-started', { transmission: 2, sendStartedAt: Date.now() });
              try {
                const second = await fetch(url + '/retry', { method: 'POST', body: '{}' });
                if (!second.ok) throw new Error('SECOND_TRANSMISSION_REJECTED');
              } catch (error) {
                attempt.phase('failed', { reason: error.message, transmission: 2 });
                throw error;
              }
            })();
          },
        };
      }
    }
    runtime.registerAdapter(['two-transmissions'], new TwoTransmissions());
    const message = llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] });
    const options = { provider: 'two-transmissions', model: 'm', sessionId: 'session:h', messages: [message] };
    llm.markAgentLoopRequest(options);
    let failure = null;
    try {
      for await (const chunk of runtime.stream(options)) void chunk;
    } catch (error) {
      failure = error;
    }
    assert.ok(failure === null || !/listener/.test(String(failure.message)), 'a listener failure did not change the request outcome');
    await sleep(50);
    assert.equal(unhandled, 0, 'no unhandled rejection from a listener');
    assert.equal(served, 2, 'the attempt made two real transmissions');
    const committed = events.filter(event => event.phase === 'committed');
    assert.equal(committed.length, 1, 'one committed event for the attempt');
    assert.equal(committed[0].transmission, 1);
    const ledger = new DispatchEvidenceLedger({ leaseMs: 60000 });
    for (const event of events) ledger.observe(event, { sessionSeq: 5, epoch: 'e1' });
    assert.equal(ledger.status().visible, 1, 'only the first committed transmission is visible');
    assert.equal(ledger.status().receipts, 1);
    assert.equal(ledger.receipts()[0].visible, true, 'a later failure did not revoke the confirmed transmission');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    await server.close();
  }
  // Unit level: this adapter publishes its two transmissions by hand, so this asserts listener isolation and the
  // ledger's first-committed rule, not that DeepSeek's own retry path reaches them (probe i does that).
  ok('h', 'unit: hand-published two transmissions - one visible receipt, no revocation, listener isolation');
}

// ----------------------------------------------------------------------------------------------------------------
// (i) DeepSeek Files recovery: a rejected file id is invalidated and the request is transmitted again
async function probeI(build) {
  const ref = { attachmentId: 'attachment:probe-image', name: 'probe.png', mediaType: 'image/png', width: 32, height: 32 };
  const uploads = [];
  const invalidated = [];
  const fileStore = {
    async ensureUploaded(version) {
      const fileId = 'file-' + (uploads.length + 1);
      uploads.push({ fileId, mediaType: version.mediaType, bytes: version.bytes });
      return { record: { fileId } };
    },
    async invalidate(mappings) {
      invalidated.push(...mappings);
    },
  };
  const bodies = [];
  let served = 0;
  const server = await receiver((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      served += 1;
      bodies.push(JSON.parse(body));
      if (served === 1) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'file_not_found', message: 'file file-1 expired' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(okSse());
    });
  });
  try {
    const attempt = await deepseekImageAttempt(build, { port: server.port, ref, fileStore });
    const controller = new AbortController();
    await runAttempt(attempt, { abort: () => controller.abort(), waitMs: 4000 });
    assert.equal(served, 2, 'the adapter retried once after the provider rejected the file id');
    assert.equal(uploads.length, 2, 'the stale mapping was uploaded again instead of reused');
    assert.equal(invalidated.length, 1, 'exactly one mapping was invalidated');
    assert.equal(invalidated[0].fileId, 'file-1');
    const imageSource = body => body.messages.flatMap(item => item.content).filter(block => block.type === 'image')[0]?.source;
    assert.deepEqual(imageSource(bodies[0]), { type: 'file', file_id: 'file-1' }, 'the first transmission carried the first file id');
    assert.deepEqual(imageSource(bodies[1]), { type: 'file', file_id: 'file-2' }, 'the second transmission carried the replacement id');
    const started = attempt.events.filter(event => event.phase === 'send-started');
    const committed = attempt.events.filter(event => event.phase === 'committed');
    assert.equal(started.length, 2, 'two transmissions were announced');
    assert.deepEqual(committed.map(event => [event.transmission, event.httpStatus]), [[1, 400], [2, 200]]);
    assert.equal(committed[1].sendStartedAt, started[1].sendStartedAt, 'the second transmission echoes its own send time');
    assert.ok(started[1].sendStartedAt >= committed[0].at, 'the retry started after the first response');
  } finally {
    await server.close();
  }
  ok('i', 'DeepSeek files.retry: stale file id invalidated, one retransmission, each with its own send time');
}

// ----------------------------------------------------------------------------------------------------------------
// (j) DeepSeek inline fallback: an upload failure turns the same request into an inline image, one transmission
async function probeJ(build) {
  const ref = { attachmentId: 'attachment:probe-image-inline', name: 'inline.png', mediaType: 'image/png', width: 32, height: 32 };
  const fileStore = {
    async ensureUploaded() { throw new Error('FILES_API_UNAVAILABLE'); },
    async invalidate() { throw new Error('an inline fallback never invalidates a mapping'); },
  };
  const bodies = [];
  let served = 0;
  const server = await receiver((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      served += 1;
      bodies.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(okSse());
    });
  });
  try {
    const attempt = await deepseekImageAttempt(build, { port: server.port, ref, fileStore });
    const controller = new AbortController();
    await runAttempt(attempt, { abort: () => controller.abort(), waitMs: 4000 });
    assert.equal(served, 1, 'the inline fallback sends once, not twice');
    const source = bodies[0].messages.flatMap(item => item.content).filter(block => block.type === 'image')[0]?.source;
    assert.equal(source.type, 'base64', 'the request fell back to an inline image');
    assert.equal(source.media_type, 'image/png');
    assert.equal(Buffer.from(source.data, 'base64').toString(), 'probe-image-bytes', 'the inline bytes are the prepared version');
    const committed = attempt.events.filter(event => event.phase === 'committed');
    assert.equal(committed.length, 1);
    assert.equal(committed[0].transmission, 1);
  } finally {
    await server.close();
  }
  ok('j', 'DeepSeek inline fallback: one transmission carrying base64 bytes after a Files API failure');
}

// ----------------------------------------------------------------------------------------------------------------
// (k) only a declared adapter may be summarised as notSent; an undeclared one that sent then threw stays unknown
async function probeK(build) {
  const { llm, cordis } = build;
  const run = async name => {
    const ctx = new cordis.Context();
    const events = [];
    ctx.on('llm/dispatch', event => events.push(event));
    const runtime = new llm.LlmRuntime(ctx);
    let served = 0;
    const server = await receiver((request, response) => {
      served += 1;
      request.on('data', () => {});
      request.on('end', () => { request.socket.destroy(); });
    });
    class SendsThenThrows extends llm.LlmAdapter {
      providerInfo(id) { return { id, name }; }
      async resolveModel(provider, id) { return { provider, id, name: id, context: { contextWindow: 100000 } }; }
      async prepareCall(provider, id) {
        const url = server.url + '/messages';
        return { model: { provider, id, name: id, context: { contextWindow: 100000 }, inputModalities: ['text'] },
          stream: () => (async function* () {
            await fetch(url, { method: 'POST', body: '{}' }).catch(() => {});
            throw new Error('SENT_THEN_FAILED');
          })() };
      }
    }
    const adapter = new SendsThenThrows();
    // The declared variant joins the contract; the undeclared one never does, which is the whole point.
    if (name.startsWith('declared')) adapter.dispatchContract = DISPATCH_CONTRACT;
    runtime.registerAdapter([name], adapter);
    const message = llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'k' }] });
    const options = { provider: name, model: 'm', sessionId: 'session:k-' + name, messages: [message] };
    llm.markAgentLoopRequest(options);
    try { for await (const chunk of runtime.stream(options)) void chunk; } catch { /* the adapter failed on purpose */ }
    await server.close();
    return { served, phases: events.map(event => event.phase), events };
  };
  const undeclared = await run('undeclared-send');
  assert.equal(undeclared.served, 1, 'the undeclared adapter did reach the receiver');
  assert.deepEqual(undeclared.phases, ['prepared'], 'an undeclared adapter is never summarised as failed(notSent)');
  const declared = await run('declared-send');
  assert.equal(declared.served, 1, 'the declared adapter also reached the receiver');
  assert.ok(declared.phases.includes('failed'), 'a declared adapter that threw before send-started is failed(notSent)');
  ok('k', 'notSent needs a declared send-started contract: 1 request each, only the declared adapter is summarised');
}

// ----------------------------------------------------------------------------------------------------------------
async function main() {
  const audit = spawnSync(process.execPath, [path.join(REPO, 'patches', buildConfig().patches, 'llm-dispatch/audit.mjs'), BUILD], { encoding: 'utf8' });
  let report = null;
  try { report = JSON.parse(audit.stdout); } catch { report = null; }
  if (!report || report.status !== 'patch-present') {
    console.log('patch-missing: the build audit did not accept ' + BUILD);
    if (report) console.log(JSON.stringify({ status: report.status, anchorStatus: report.anchorStatus, missing: report.missing, files: report.files }, null,
      2));
    else console.log(audit.stdout + audit.stderr);
    process.exitCode = 1;
    return;
  }
  console.log('build audit: ' + report.status + ' (' + report.anchorStatus + ', ' + report.moduleIdentity + ')');
  const build = await loadBuild();
  for (const group of [probeA, probeB, probeC, probeD, probeE, probeF, probeG, probeH, probeI, probeJ, probeK]) {
    const id = group.name.replace('probe', '').toLowerCase();
    // A bounded group: one hanging receiver must fail its own group, not stall the probe.
    let timer = null;
    try {
      await Promise.race([
        group(build),
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('group timed out')), 30000); }),
      ]);
    } catch (error) {
      fail(id, error);
    } finally {
      clearTimeout(timer);
    }
  }
  const passed = results.filter(item => item.ok).length;
  console.log('llm-dispatch probes: ' + passed + '/' + results.length + ' groups passed');
  for (const item of results.filter(entry => !entry.ok)) console.log('  failed (' + item.id + '): ' + item.detail);
  // The probe has no background work worth waiting for; exit explicitly so a stranded socket cannot hang it.
  process.exit(passed === results.length ? 0 : 1);
}

await main();
