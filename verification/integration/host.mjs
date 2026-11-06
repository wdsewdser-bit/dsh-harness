import fs from 'node:fs';
import assert from 'node:assert/strict';
import { host } from '../../packages/adapter-dsh/index.mjs';
import { config, hash } from '../../packages/contracts/index.mjs';
import {
  ArtifactStore, Coordinator, checkWire, recall, wireGuard, archiveText, recordPolicy,
} from '../../packages/context/index.mjs';
import { provider, chunks } from '../fixtures/fake-provider.mjs';
import { installAdapter } from './host-adapter.mjs';

const [mode, root] = process.argv.slice(2);
fs.mkdirSync(root, { recursive: true });
const adapter = await host(root);
const { ctx: context } = adapter;
const configuration = config({ W: 1000000 });
const store = new ArtifactStore(root);
let executions = 0;
let main = 0;
let aux = 0;
const wires = [];
const errors = [];
const refs = [];
let current;
let coordinator;
const user = text => adapter.createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
});

context.on('agent/error', payload => errors.push(String(payload.error)));
wireGuard(adapter, configuration, () => current, observation => wires.push(observation));
const stop = await provider(40271, body => {
  const purpose = adapter.isAgentLoopRequest(body) ? 'main' : 'unknown';
  // Process-local identity is classified before HTTP, never inferred from labels.
  fs.appendFileSync(root + '/payloads.jsonl', JSON.stringify({ seed: 1, body }) + String.fromCharCode(10));
  const last = wires.at(-1);
  if (last.purpose === 'summary') {
    aux++;
    if (mode === 'summary-fail') {
      throw Error('injected summary failure');
    }
    return chunks({ type: 'text', text: 'Durable summary of completed offline steps.' }, 100);
  }
  main++;
  const block = main <= 205 ? {
    type: 'tool-call',
    id: 'call-' + main,
    name: main === 3 ? 'recall' : 'large',
    arguments: main === 3
      ? JSON.stringify({ ref: refs[0].artifactRef, offset: 0, length: 4096 })
      : '{}',
  } : { type: 'text', text: 'done' };
  return chunks(block, main % 35 === 0 ? 750050 : 1000);
});
installAdapter(adapter, context, configuration);

context.tools.register({
  name: 'large',
  description: 'offline large output',
  parameters: { type: 'object', properties: {} },
  output: {
    schema: { type: 'string' },
    render: (unused, value) => [{ type: 'text', text: value }],
  },
  execute() {
    executions++;
    return '原文 evidence ' + String(executions) + ' ' + 'DATA-'.repeat(4000);
  },
});
context.tools.register({
  name: 'recall',
  description: 'bounded original artifact read',
  parameters: {
    type: 'object',
    properties: { ref: { type: 'string' }, offset: { type: 'number' }, length: { type: 'number' } },
    required: ['ref'],
  },
  output: {
    schema: { type: 'string' },
    render: (unused, value) => [{ type: 'text', text: value }],
  },
  execute(args) {
    executions++;
    return JSON.stringify(recall(store, args.ref, args, {
      session: current.session.id,
      agent: current.id,
    }));
  },
});
context.on('tools/post-execute', async (execution, result, next) => {
  if (execution.name !== 'large') {
    return next();
  }
  const text = result.content.map(block => block.text ?? '').join('');
  const archived = archiveText(store, configuration, {
    text,
    callId: 'call-' + executions,
    principal: { session: current.session.id, agent: current.id },
  });
  if (!archived) {
    return next();
  }
  if (archived.ref) {
    refs.push({ ...archived.ref, text });
  }
  return archived.decision;
});

if (mode === 'cold') {
  const saved = JSON.parse(fs.readFileSync(root + '/hot.json'));
  const handle = await adapter.resume({
    resumeSessionId: saved.sessionId,
    agentOptions: { provider: 'offline', model: 'model' },
  });
  current = handle.agent;
  assert.deepEqual(adapter.derive(current.session), saved.derived);
  assert.equal(executions, 0);
  assert.equal(main, 0);
  for (const reference of saved.refs) {
    const parts = [];
    for (let offset = 0; offset < Buffer.byteLength(reference.text); offset += 4096) {
      const chunk = recall(store, reference.artifactRef, { offset, length: 4096 }, {
        session: current.session.id,
        agent: current.id,
      });
      assert.equal(chunk.status, 'ok');
      parts.push(Buffer.from(chunk.dataBase64, 'base64'));
    }
    assert.equal(hash(Buffer.concat(parts)), reference.sha256);
  }
  fs.writeFileSync(root + '/cold.json', JSON.stringify({
    equal: true, executions, main, artifacts: saved.refs.length,
  }));
  await handle.dispose();
} else {
  await adapter.pressure();
  const handle = await adapter.create({
    sessionId: 'p2-' + Date.now(),
    agentOptions: { provider: 'offline', model: 'model' },
    meta: { cwd: root },
  });
  current = handle.agent;
  coordinator = new Coordinator(current.session.id);
  context.on('agent/pre-step', async (payload, next) => {
    await coordinator.run(async () => {
      const before = adapter.measure(payload.agent.session);
      recordPolicy(store, payload.agent.session.id, {
        logRevision: before.logRevision, phase: 'before-safety',
      }, configuration, before.totalTokens);
      await adapter.compactIfNeeded(payload.agent, payload.signal);
      const measurement = adapter.measure(payload.agent.session);
      recordPolicy(store, payload.agent.session.id, {
        logRevision: measurement.logRevision,
      }, configuration, measurement.totalTokens);
    });
    return next();
  });
  current.followup(user('Run 205 tool steps offline'));
  await current.whenIdle();
  await adapter.flush(current.session);
  const failed = mode === 'summary-fail';
  assert.equal(executions, failed ? 35 : 205, JSON.stringify({ errors, wires }));
  assert.equal(main, failed ? 35 : 206);
  assert.equal(refs.length, failed ? 34 : 204);
  assert(aux > 0);
  assert.equal(errors.length, failed ? 1 : 0, JSON.stringify(errors));
  const events = current.session.snapshotEvents();
  assert(events.some(event => (
    event.type === 'compaction/end' && (failed ? !!event.data.error : !event.data.error)
  )));
  assert(JSON.stringify(events).includes('Run 205 tool steps offline'));
  for (const reference of refs) {
    assert.equal(hash(reference.text), reference.sha256);
  }
  if (!failed) {
    const source = adapter.measure(current.session).logRevision;
    const nodes = [...current.session.surface.nodes];
    let active = 0;
    let maxActive = 0;
    const compact = coordinator.run(async () => {
      maxActive = Math.max(maxActive, ++active);
      try {
        return await adapter.compactNow(current, new AbortController().signal);
      } finally {
        active--;
      }
    });
    const stale = coordinator.run(async () => {
      maxActive = Math.max(maxActive, ++active);
      try {
        await assert.rejects(() => adapter.replaceSurface(
          current.session, user('must not commit stale replacement'), nodes, source,
        ), /CAS_CONFLICT/);
      } finally {
        active--;
      }
    });
    await Promise.all([compact, stale]);
    assert.equal(maxActive, 1);
    const retryOptions = {
      provider: 'offline', model: 'model', maxTokens: 1024,
      messages: [user('explicit bounded retry payload')],
    };
    const before = wires.length;
    for (let retry = 0; retry < 2; retry++) {
      for await (const chunk of context.llm.stream(retryOptions)) {}
    }
    assert.equal(wires.length, before + 2);
    const sent = main + aux;
    // M3a: the guard now estimates the input as the transport does (UTF-8 bytes, no *2 + 1024) and refuses on the
    // input alone, so the payload that is past 75% of the 1,000,000-token window is 800,000 bytes, not 375,000. The
    // assertion is still "a prompt past the line is refused before the provider is called".
    await assert.rejects(async () => {
      for await (const chunk of context.llm.stream({
        ...retryOptions, messages: [user('x'.repeat(800000))],
      })) {}
    }, /BLOCKED_BUDGET/);
    assert.equal(main + aux, sent);
  }
  fs.writeFileSync(root + '/hot.json', JSON.stringify({
    sessionId: current.session.id,
    derived: adapter.derive(current.session),
    refs, wires, main, aux, executions, errors,
    blocked: mode === 'summary-fail',
    nativeReplaceSerialization: mode !== 'summary-fail',
    explicitRetryGate: mode !== 'summary-fail',
    optionalFolds: 0,
  }));
  await handle.dispose();
  coordinator.close();
}
store.close();
await stop();
console.log(JSON.stringify({ mode, main, aux, executions, wires: wires.length }));
