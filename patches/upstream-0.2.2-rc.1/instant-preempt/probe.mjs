import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PRISTINE, C2 as BUILD_C2 } from '../paths.mjs';

/**
 * Offline proof for the instant-preempt candidate: cases A, B, C, D, E, G, and the switch-off parity P.
 *
 * Everything here runs the real published plugin stack (cordis, session, llm, tools, agent-loop) with a
 * scripted in-process adapter: no socket, no provider. The adapter yields chunk by chunk and can park the
 * stream between two reads, which is the only honest way to preempt at the same seam Codex uses
 * (turn.rs stream.next().or_cancel(&preempt)).
 *
 * The module is importable (the case file reuses boot/harness/chunks); it runs a mode only when its own file
 * is the process entry point.
 *
 * modes:
 *   original  upstream install, default scenario        -> default.json
 *   patched   C2 build, instantInterrupt off            -> default.json
 *   cold      C2 build, resumes the flushed session     -> cold.json
 *   instant   C2 build, instantInterrupt on             -> instant.json (A, B, C, D, E, F, G)
 */
export const ORIGINAL = PRISTINE;
export const C2 = (process.env.DSH_PREEMPT_TEST_BUILD ?? BUILD_C2) + '/node_modules/@deepseek-ai/';

export const digest = value => crypto.createHash('sha256')
  .update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const deferred = () => {
  const box = {};
  box.promise = new Promise((resolve, reject) => { box.resolve = resolve; box.reject = reject; });
  return box;
};
export const sleep = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

/** Boot the real stack from one build root; the agent-loop flag is the whole difference between builds. */
export async function boot(base, instantInterrupt, homeDir) {
  const load = name => import(pathToFileURL(base + name + '/lib/index.js'));
  const { Context } = await load('cordis');
  const ctx = new Context();
  const modules = ['dsh-session-projection', 'dsh-session', 'dsh-llm', 'dsh-tools', 'dsh-tool-executor-native', 'dsh-system-prompt',
    'dsh-agent', 'dsh-token-meter', 'dsh-session-persistence-jsonl', 'dsh-agent-loop'];
  for (const name of modules) {
    const plugin = name === 'dsh-tool-executor-native' && base !== ORIGINAL ? await load('dsh-tool-executor-preempt') : await load(name);
    const configuration = name === 'dsh-tool-executor-native' && base !== ORIGINAL ? {} : name === 'dsh-agent-loop'
      ? { agents: [], maxParallelToolCalls: 1, ...(instantInterrupt === void 0 ? {} : { instantInterrupt }) }
      : name === 'dsh-session-persistence-jsonl'
        ? { root: homeDir + '/sessions', compression: 'none', listConcurrency: 4 }
        : {};
    await ctx.plugin(plugin.default ?? plugin, configuration).await();
  }
  const { LlmAdapter } = await load('dsh-llm');
  return { ctx, LlmAdapter };
}

/**
 * One scripted adapter for the whole process. A case arms its own script and gets the request offset back, so
 * cases can run back to back on one context while each still counts its own requests.
 */
export function harness(LlmAdapter, evidence) {
  const state = { current: null, base: 0 };
  const adapter = new class extends LlmAdapter {
    providerInfo(id) { return { id, name: 'scripted-offline' }; }
    async prepareCall(provider, id) {
      return {
        model: { provider, id, name: id, contextWindow: 1000000, inputModalities: ['text'] },
        stream: options => this.stream(options),
      };
    }
    async *stream(options) {
      if (state.current === null) throw Error('SCRIPT_NOT_ARMED');
      const entry = state.current(evidence.requests.length - state.base, options, evidence);
      evidence.requests.push({ index: evidence.requests.length, purpose: entry.purpose,
        route: options.provider + '/' + options.model,
        tools: (options.tools ?? []).map(tool => tool.name), messages: summarise(options.messages) });
      for (const chunk of entry.chunks ?? []) yield chunk;
      if (entry.hold) {
        entry.onHold?.();
        await entry.hold.promise;
      }
      for (const chunk of entry.tail ?? []) yield chunk;
      await entry.onEnd?.();
    }
  }();
  return {
    adapter,
    /** Arm a script; the return value is the absolute request index the case's first request will occupy. */
    arm(script) { state.current = script.entry; state.base = evidence.requests.length; return state.base; },
  };
}

/** Stable, comparable request summary: no ids, no timestamps, no opaque replay state. */
export function summarise(messages) {
  return (messages ?? []).map(message => ({ role: message.role,
    blocks: (message.content ?? []).map(block => block.type === 'text' ? { type: 'text', text: block.text }
      : block.type === 'reasoning' ? { type: 'reasoning', text: block.text }
        : block.type === 'tool-call' ? { type: 'tool-call', name: block.name, arguments: block.arguments }
          : { type: block.type }) }));
}

export const chunks = {
  reasoning: (index, text) => [{ type: 'block-start', index, blockType: 'reasoning' },
    { type: 'reasoning-delta', index, text }],
  reasoningEnd: (index, text) => ({ type: 'block-end', index, block: { type: 'reasoning', text } }),
  text: (index, text) => [{ type: 'block-start', index, blockType: 'text' }, { type: 'text-delta', index, text }],
  textEnd: (index, text) => ({ type: 'block-end', index, block: { type: 'text', text } }),
  toolCall: (index, id, name, args) => [{ type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id, name, argumentsDelta: args },
    { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: args } }],
  usage: (input, output) => ({ type: 'usage', usage: { inputTokens: input, outputTokens: output, totalTokens: input + output } }),
  finish: kind => ({ type: 'finish', reason: { kind } }),
};

/** Normalize durable events for cross-build comparison: identities and timestamps carry no behaviour. */
const IGNORED = new Set(['id', 'messageId', 'attemptId', 'callId', 'stream', 'time', 'at', 'timestamp',
  'sessionId', 'createdAt', 'updatedAt', 'replayState', 'nativeRef', 'toolCallId', 'sourceEventSeqs',
  'provider', 'model']);
const normalize = value => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (IGNORED.has(key)) continue;
      out[key] = normalize(item);
    }
    return out;
  }
  return value;
};
export const stable = session => session.snapshotEvents().map(event => ({ type: event.type, data: normalize(event.data) }));

/** The default scenario both builds must reproduce identically: reasoning, text, one tool call, a second step. */
export const defaultScript = () => ({ entry(index) {
  if (index === 0) return { purpose: 'workload', chunks: [
    ...chunks.reasoning(0, 'look at the request'), chunks.reasoningEnd(0, 'look at the request'),
    ...chunks.text(1, 'calling echo'), chunks.textEnd(1, 'calling echo'),
    ...chunks.toolCall(2, 'call-echo-1', 'echo', JSON.stringify({ value: 'ping' })),
    chunks.usage(9, 4), chunks.finish('tool-calls')] };
  return { purpose: 'workload', chunks: [...chunks.text(0, 'done'), chunks.textEnd(0, 'done'),
    chunks.usage(12, 3), chunks.finish('stop')] };
} });

/** One offline echo tool, registered on the root context so every agent sees the same surface. */
export function registerEcho(ctx, calls) {
  // Cases share one process; the tool is registered once because a second identical registration is rejected.
  // Every caller gets the same live call list back, so "which calls ran" never depends on registration order.
  if (ctx.__echoCalls !== undefined) return ctx.__echoCalls;
  ctx.__echoCalls = calls;
  ctx.tools.register({
    name: 'echo',
    description: 'offline echo',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    output: { schema: { type: 'string' }, render: (unused, value) => [{ type: 'text', text: value }] },
    execute(args) {
      ctx.__echoCalls.push(args.value);
      return 'echo:' + args.value;
    },
  });
  return ctx.__echoCalls;
}

/** Run the default scenario end to end and return everything a cross-build comparison needs. */
export async function runDefaultCase(host, options = {}) {
  const { ctx, arm, evidence, home } = host;
  const calls = registerEcho(ctx, []);
  const base = calls.length;
  arm(options.script ?? defaultScript());
  const sessionId = 'default-' + (options.tag ?? 'probe');
  const handle = await ctx.agents.create({ sessionId,
    agentOptions: { provider: 'offline', model: 'model' }, meta: { cwd: home } });
  const agent = handle.agent;
  agent.followup({ id: 'user-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'run the echo tool' }] });
  await agent.whenIdle();
  await ctx.sessions.flush(agent.session);
  const result = {
    events: stable(agent.session),
    messages: summarise(agent.session.deriveMessages()),
    echoes: calls.slice(base),
  };
  return { agent, handle, result };
}

/** Resume a flushed session on the same build and prove the journal replays before any new request. */
export async function coldResume(host, sessionId, journal) {
  const { ctx, arm, evidence } = host;
  const calls = registerEcho(ctx, []);
  const callBase = calls.length;
  arm(defaultScript());
  const base = evidence.requests.length;
  const handle = await ctx.agents.resume({ resumeSessionId: sessionId,
    agentOptions: { provider: 'offline', model: 'model' } });
  const events = stable(handle.agent.session);
  // Resume must replay the flushed journal exactly; anything after it is a seed marker, never new work.
  const replayed = events.slice(0, journal.events.length);
  const extra = events.slice(journal.events.length).map(event => event.type);
  const resumed = { requests: evidence.requests.length - base, events, replayed,
    extra, replayEqualsJournal: JSON.stringify(replayed) === JSON.stringify(journal.events) };
  handle.agent.followup({ id: 'user-2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'run the echo tool' }] });
  await handle.agent.whenIdle();
  await ctx.sessions.flush(handle.agent.session);
  resumed.afterFollowup = { requests: evidence.requests.length - base, echoes: calls.slice(callBase),
    events: stable(handle.agent.session) };
  return { handle, resumed };
}

const run = async () => {
  const [mode, home] = process.argv.slice(2);
  if (!['original', 'patched', 'cold', 'instant'].includes(mode)) throw Error('USE_ORIGINAL_PATCHED_COLD_OR_INSTANT');
  fs.mkdirSync(home, { recursive: true });
  process.env.DSH_HOME = home;
  const base = mode === 'original' ? ORIGINAL : C2;
  const evidence = { mode, base, requests: [], cases: {} };
  const host = await boot(base, mode === 'instant' ? true : void 0, home);
  const { adapter, arm } = harness(host.LlmAdapter, evidence);
  host.ctx.llm.registerAdapter(['offline'], adapter);
  const shared = { ...host, evidence, chunks, deferred, sleep, digest, stable, home, arm, registerEcho,
    runDefaultCase, coldResume };
  let cases;
  if (mode === 'instant') cases = await (await import('./probe-cases.mjs')).runInstant(shared);
  else cases = await (await import('./probe-cases.mjs')).runDefault(shared, { cold: mode === 'cold', tag: mode });
  evidence.cases = cases;
  // default.json / cold.json hold ONLY the cross-build comparable journal, so the parity assertion is an exact
  // deepEqual of two files; the full evidence (requests, counters, mode) is written beside it.
  const name = mode === 'instant' ? 'instant.json' : mode === 'cold' ? 'cold.json' : 'default.json';
  const target = home + '/' + name;
  const payload = mode === 'instant' ? cases : mode === 'cold' ? cases.cold : cases.journal;
  fs.writeFileSync(target, JSON.stringify(payload, null, 2));
  fs.writeFileSync(home + '/evidence.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ mode, cases: Object.keys(cases), requests: evidence.requests.length, file: target }, null, 2));
};

const asPath = p => p.replaceAll('\\', '/').toLowerCase();
if (process.argv[1] && asPath(fileURLToPath(import.meta.url)) === asPath(process.argv[1])) await run();