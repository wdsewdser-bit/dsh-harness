/**
 * dsh-ptc-boost — a DSH 0.2.2 overlay that adds the three Claude Code ptc-run
 * behaviours to the stock PTC executor, without patching any upstream package:
 *
 * 1. `ptc-boost:batching` — an additive system-prompt section with the
 *    "Using run_code well" batching/context guidance, written for the DSH SDK.
 * 2. Output truncation — a `run_code` result over 8000 chars keeps its first
 *    70% and last 30%; the middle is stored under a ref id served by the
 *    `ref_text` tool.
 * 3. Read dedup — a repeated read of an unchanged, already-delivered range
 *    becomes a one-line notice; a changed range becomes a diff; everything
 *    uncertain stays in full.
 *
 * Both behaviours hook `tools/post-execute`, the documented tool-result
 * policy waterfall in `@deepseek-ai/dsh-tools`. Load with an overlay entry:
 *
 *     - insert:
 *         - id: ptc-boost
 *           name: 'file:///<path-to-dsh-v2>/packages/ptc-boost/index.js'
 *
 * @module dsh-ptc-boost
 */

import { createBoost } from "./lib/boost.js";

export { createBoost } from "./lib/boost.js";
export { resolveConfig, DEFAULT_CONFIG } from "./lib/config.js";
export { truncateOutput, formatTruncated } from "./lib/truncate.js";
export { RefStore } from "./lib/refstore.js";
export { planReplacement, scanSegments, diffWindow, summaryLine, pathKey } from "./lib/dedup.js";
export { batchingGuidance, BATCHING_SECTION_NAME } from "./lib/prompt.js";

/** Cordis plugin name. */
export const name = "ptc-boost";

/** The services this overlay needs; it adds nothing the base bundle lacks. */
export const inject = ["tools", "systemPrompt"];

/** Placement of the batching section: right after the generated SDK block. */
const SECTION_OFFSET = 100;

/**
 * Mount the overlay on a profile context.
 * @param ctx - Cordis context providing the tool registry and prompt registry.
 * @param rawConfig - the overlay entry's config (all keys optional).
 */
export function apply(ctx, rawConfig) {
  const boost = createBoost(rawConfig ?? {});
  const logger = ctx.logger;
  const log = (level, message) => {
    try {
      const sink = logger === undefined ? undefined : logger[level];
      if (typeof sink === "function") sink.call(logger, message);
    } catch {
      /* logging must never break the overlay */
    }
  };

  const section = boost.batchingSection();
  if (section !== undefined) {
    ctx.systemPrompt.section({
      name: section.name,
      order: ctx.systemPrompt.getSectionOrder("TOOLS_SDK") + SECTION_OFFSET,
      interpolate: false,
      text: section.text,
    });
  }

  const refTool = boost.refToolDefinition();
  if (refTool !== undefined) ctx.tools.register(refTool);

  // Tool-result policy: everything downstream decides first; this overlay only
  // takes over a plain accept that nobody else replaced.
  ctx.on("tools/post-execute", async (exec, result, next) => {
    const downstream = await next();
    const replacement = boost.postExecute(exec, result);
    if (replacement === undefined) return downstream;
    if (downstream !== undefined && downstream.kind !== "accept") return downstream;
    if (downstream !== undefined && (downstream.content !== undefined || downstream.value !== undefined)) return downstream;
    return { kind: "accept", ...replacement };
  });

  // A compaction rewrites the conversation, so nothing recorded before it is
  // still visible to the model.
  ctx.on("session/event", (session, event) => boost.onSessionEvent(session, event), { global: true });

  ctx.effect(
    () => () => {
      log("info", boost.statsLine());
      boost.reset();
    },
    "ptc-boost",
  );
}
