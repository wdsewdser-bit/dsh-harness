/**
 * The ptc-boost runtime: pure policy plus the small amount of state the DSH
 * hooks need. Nothing here imports Cordis or any DSH package, so the whole
 * overlay is testable with plain Node and cannot drag a second copy of the
 * harness into the process.
 *
 * Hook shape:
 *
 * - `read` (nested inside a program) is only **observed**: the read result the
 *   program receives is never modified, so parsing, slicing and `edit` keep
 *   working on real text.
 * - `run_code` (the outer, model-facing call) post-processes the program's own
 *   output: first read dedup (whole printed runs already shown earlier in the
 *   session become one line or a diff), then truncation of what is still too
 *   long, then the `[read-dedup]` summary line.
 *
 * @module dsh-ptc-boost/boost
 */

import { resolveConfig } from "./config.js";
import { pathKey, planReplacement, scanSegments, summaryLine } from "./dedup.js";
import { batchingGuidance, BATCHING_SECTION_NAME } from "./prompt.js";
import { RefStore } from "./refstore.js";
import { formatTruncated, truncateOutput } from "./truncate.js";

/** Reserved PTC transport name. */
export const RUN_CODE_TOOL = "run_code";
/** The filesystem read tool whose printed runs are deduplicated. */
export const READ_TOOL = "read";
/** Hard cap on reads remembered for one program. */
const MAX_READS_PER_PROGRAM = 200;

/** Concatenate a content block array when it is text-only; otherwise undefined. */
export function textOfContent(content) {
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") return undefined;
    parts.push(block.text);
  }
  return parts.join("\n");
}

/** Narrow a read tool's canonical value to the fields the output scan needs. */
export function parseReadValue(value, args) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (!Array.isArray(value.lines) || typeof value.offset !== "number") return undefined;
  const lines = [];
  for (const line of value.lines) {
    if (line === null || typeof line !== "object" || typeof line.number !== "number" || typeof line.text !== "string") return undefined;
    lines.push({ number: line.number, text: line.text });
  }
  const path = typeof value.path === "string" ? value.path : args && typeof args.file_path === "string" ? args.file_path : undefined;
  if (path === undefined) return undefined;
  const totalLines = typeof value.totalLines === "number" ? value.totalLines : value.offset + lines.length - 1;
  const endLine = lines.length > 0 ? lines[lines.length - 1].number : value.offset - 1;
  return { path, offset: value.offset, endLine, totalLines, lines };
}

/** Session key of an execution; `undefined` when the call has no agent. */
export function sessionIdOf(exec) {
  const session = exec && exec.agent ? exec.agent.session : undefined;
  if (session && typeof session.id === "string" && session.id.length > 0) return session.id;
  return undefined;
}

/**
 * Build one overlay instance.
 * @param rawConfig - overlay config (validated by {@link resolveConfig}).
 * @param options - `now` clock override and `makeRefId` for tests.
 */
export function createBoost(rawConfig = {}, options = {}) {
  const config = resolveConfig(rawConfig);
  const now = options.now ?? (() => Date.now());
  const refs = new RefStore({
    maxEntries: config.truncation.maxEntries,
    maxTotalChars: config.truncation.maxTotalChars,
    maxSliceChars: config.truncation.maxSliceChars,
    makeId: options.makeRefId,
  });
  const stats = {
    truncation: { outputs: 0, truncated: 0, savedChars: 0 },
    dedup: { programs: 0, reads: 0, hits: 0, notices: 0, diffs: 0, savedChars: 0 },
  };
  /** sessionId -> { seen: Map<key, {lines: Map<number,string>, total}>, pending: Map<rootCallId, read[]> } */
  const sessions = new Map();

  function stateOf(sessionId) {
    let state = sessions.get(sessionId);
    if (state === undefined) {
      state = { seen: new Map(), pending: new Map() };
      sessions.set(sessionId, state);
    }
    return state;
  }

  function dropSession(sessionId) {
    sessions.delete(sessionId);
    refs.clear(sessionId);
  }

  /** Record one read so a later program's output scan can recognise its text. */
  function observeRead(exec, result) {
    if (result.isError === true) return;
    const sessionId = sessionIdOf(exec);
    if (sessionId === undefined) return;
    const value = parseReadValue(result.value, exec.arguments);
    if (value === undefined) return;
    stats.dedup.reads += 1;
    if (!config.dedup.enabled) return;
    const state = stateOf(sessionId);
    const key = exec.rootCallId ?? exec.callId;
    if (key === undefined) return;
    const pending = state.pending.get(key) ?? [];
    if (pending.length >= MAX_READS_PER_PROGRAM) return;
    pending.push({
      key: pathKey(value.path),
      label: value.path,
      offset: value.offset,
      endLine: value.endLine,
      totalLines: value.totalLines,
      lines: value.lines,
      at: now(),
    });
    state.pending.set(key, pending);
  }

  /** The session record of one file, created on demand. */
  function seenEntry(state, key) {
    let entry = state.seen.get(key);
    if (entry === undefined) {
      entry = { lines: new Map(), total: 0 };
      state.seen.set(key, entry);
    }
    return entry;
  }

  /**
   * Remember the lines of one printed read as text the model has now been shown.
   * `segment` carries the run's position in the deduplicated output; `dropped`
   * is the truncation middle, whose lines never reached the model.
   */
  function recordShown(state, segment, dropped) {
    const entry = seenEntry(state, segment.read.key);
    let pos = segment.start;
    for (const line of segment.read.lines) {
      const start = pos;
      const end = start + line.text.length;
      pos = end + 1;
      if (dropped !== undefined && start < dropped.to && end + 1 >= dropped.from) continue;
      entry.lines.set(line.number, line.text);
    }
    entry.total = segment.read.totalLines;
    while (entry.lines.size > config.dedup.maxLinesPerFile) {
      const oldest = entry.lines.keys().next();
      if (oldest.done) break;
      entry.lines.delete(oldest.value);
    }
  }

  /**
   * Replace whole printed read runs in the program's output.
   * @returns the rewritten text, the kept segments (positions in the returned
   *   text) and the reads whose content the model now knows through a diff.
   */
  function applyDedup(text, reads, state) {
    const kept = [];
    const commits = [];
    let out = "";
    let cursor = 0;
    let hits = 0;
    let savedChars = 0;
    for (const candidate of scanSegments(text, reads)) {
      const segment = text.slice(candidate.start, candidate.end);
      const entry = state.seen.get(candidate.read.key);
      const plan = segment.length < config.dedup.minReplaceChars
        ? { kind: "full", reason: "small" }
        : planReplacement(entry, candidate.read, segment.length, config.dedup);
      if (plan.kind === "full") {
        const start = out.length + (candidate.start - cursor);
        kept.push({ read: candidate.read, start, end: start + segment.length });
        continue;
      }
      const start = out.length;
      out += text.slice(cursor, candidate.start) + plan.text;
      cursor = candidate.end;
      hits += 1;
      savedChars += plan.savedChars;
      stats.dedup.hits += 1;
      stats.dedup.savedChars += plan.savedChars;
      stats.dedup[plan.kind === "notice" ? "notices" : "diffs"] += 1;
      if (plan.kind === "diff") commits.push({ read: candidate.read, start, end: start + plan.text.length });
    }
    out += text.slice(cursor);
    return { text: out, kept, commits, hits, savedChars };
  }

  function handleRunCode(exec, result) {
    const sessionId = sessionIdOf(exec);
    const state = sessionId === undefined ? undefined : sessions.get(sessionId);
    const reads = state === undefined ? [] : state.pending.get(exec.callId) ?? [];
    if (state !== undefined) state.pending.delete(exec.callId);
    if (result.isError === true) return undefined;

    const text = textOfContent(result.content);
    if (text === undefined) return undefined;

    const run = { hits: 0, savedChars: 0 };
    let working = text;
    let kept = [];
    let commits = [];
    if (config.dedup.enabled && state !== undefined && reads.length > 0) {
      stats.dedup.programs += 1;
      const applied = applyDedup(text, reads, state);
      working = applied.text;
      kept = applied.kept;
      commits = applied.commits;
      run.hits = applied.hits;
      run.savedChars = applied.savedChars;
    }

    let rendered = working;
    let dropped;
    stats.truncation.outputs += 1;
    if (config.truncation.enabled) {
      const plan = truncateOutput(working, { maxChars: config.truncation.maxChars, headRatio: config.truncation.headRatio });
      if (plan.truncated) {
        const refId = refs.put(plan.middle, { session: sessionId ?? "", base: plan.headEnd, at: now() });
        rendered = formatTruncated(plan, { refId, toolName: config.truncation.toolName });
        dropped = { from: plan.headEnd, to: plan.tailStart };
        stats.truncation.truncated += 1;
        stats.truncation.savedChars += Math.max(0, working.length - rendered.length);
      }
    }

    if (state !== undefined) {
      // Only text that survived truncation counts as shown.
      for (const segment of kept) recordShown(state, segment, dropped);
      for (const commit of commits) recordShown(state, commit, dropped);
    }

    if (run.hits > 0) rendered += `${rendered.length > 0 ? "\n\n" : ""}${summaryLine(run, stats.dedup)}`;
    if (rendered === text) return undefined;
    return { content: [{ type: "text", text: rendered }] };
  }

  function handleRead(exec, result) {
    observeRead(exec, result);
    // Never rewrite a read result: the program may parse it, slice it or pass it
    // to edit, so it must always receive the real file text.
    return undefined;
  }

  /**
   * The single hook the Cordis bridge calls for `tools/post-execute`.
   * @returns a replacement ({ content }) or undefined to keep the result as is.
   */
  function postExecute(exec, result) {
    if (exec === null || typeof exec !== "object" || result === null || typeof result !== "object") return undefined;
    if (exec.name === RUN_CODE_TOOL && exec.parent === undefined) return handleRunCode(exec, result);
    if (exec.name === READ_TOOL) return handleRead(exec, result);
    return undefined;
  }

  /** Compaction rewrites the conversation: nothing recorded before it is still visible. */
  function onSessionEvent(session, event) {
    const sessionId = session && typeof session.id === "string" ? session.id : undefined;
    if (sessionId === undefined || event === null || typeof event !== "object") return;
    const type = event.type;
    if (type === "compaction/start" || type === "compaction/end" || type === "compaction/summary") dropSession(sessionId);
  }

  /** The system-prompt section this overlay contributes, or undefined when off. */
  function batchingSection() {
    if (!config.batching.enabled) return undefined;
    const text = batchingGuidance({ override: config.batching.text });
    if (text.trim().length === 0) return undefined;
    return { name: BATCHING_SECTION_NAME, text };
  }

  /** The `ref_text` tool definition, or undefined when truncation is off. */
  function refToolDefinition() {
    if (!config.truncation.enabled) return undefined;
    const toolName = config.truncation.toolName;
    return {
      name: toolName,
      description:
        "Return a slice of a run_code output that was truncated and stored under a ref id. " +
        "Refs exist only in this DSH process and session; they are meant only for recovering the omitted middle of a large output.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "Ref id from the truncation marker." },
          from: { type: "integer", description: "0-based offset of the first character to return (default 0)." },
          to: {
            type: "integer",
            description: `Exclusive end offset (default from + ${config.truncation.maxSliceChars}, which is also the maximum span).`,
          },
        },
        required: ["id"],
      },
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: value }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const slice = refs.slice(args === null || typeof args !== "object" ? undefined : args.id, {
          from: args && typeof args === "object" ? args.from : undefined,
          to: args && typeof args === "object" ? args.to : undefined,
        });
        if (!slice.truncated) return slice.text;
        return (
          `${slice.text}\n…[ref ${slice.id}: chars ${slice.from}-${slice.to} of ${slice.total}; ` +
          `continue with { id: "${slice.id}", from: ${slice.nextFrom} }]…`
        );
      },
    };
  }

  /** Human-readable counters, e.g. for the log line on unload. */
  function statsLine() {
    return (
      `ptc-boost: truncation ${stats.truncation.truncated}/${stats.truncation.outputs} outputs, ` +
      `${stats.truncation.savedChars} chars saved; read-dedup ${stats.dedup.hits} hit(s) ` +
      `(${stats.dedup.notices} notice, ${stats.dedup.diffs} diff) over ${stats.dedup.reads} read(s), ` +
      `${stats.dedup.savedChars} chars saved`
    );
  }

  return {
    config,
    refs,
    stats,
    postExecute,
    onSessionEvent,
    batchingSection,
    refToolDefinition,
    statsLine,
    dropSession,
    reset() {
      sessions.clear();
      refs.clear();
    },
  };
}
