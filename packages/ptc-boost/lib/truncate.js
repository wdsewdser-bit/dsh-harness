/**
 * Head/middle/tail truncation for one program's model-facing output.
 *
 * The plan is pure: `truncateOutput` decides what is kept and what is dropped,
 * the caller stores the middle under a ref id, and `formatTruncated` renders
 * the text the model sees. Cuts are made on line boundaries when the text has
 * newlines, so the model never gets half a line, and the marker names the exact
 * character range the ref call has to ask for.
 *
 * @module dsh-ptc-boost/truncate
 */

const NL = "\n";

/** Default output cap in chars, matching the Claude Code ptc-run behaviour. */
export const DEFAULT_MAX_CHARS = 8000;
/** Default share of the cap kept at the head (the tail takes the rest). */
export const DEFAULT_HEAD_RATIO = 0.7;

/** Number of lines in `text` (a trailing newline opens one empty line). */
export function countLines(text) {
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) lines += 1;
  return lines;
}

/**
 * Split an oversized output into the parts that stay inline and the middle that
 * is saved under a ref.
 * @param text - the complete model-facing output.
 * @param options - `maxChars` cap and `headRatio` share kept at the head.
 * @returns the plan; `truncated: false` carries the untouched text.
 */
export function truncateOutput(text, options = {}) {
  if (typeof text !== "string") throw new TypeError("ptc-boost: truncateOutput expects a string");
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const headRatio = options.headRatio ?? DEFAULT_HEAD_RATIO;
  if (!Number.isInteger(maxChars) || maxChars < 2) throw new RangeError("ptc-boost: maxChars must be an integer >= 2");
  if (!(headRatio > 0 && headRatio < 1)) throw new RangeError("ptc-boost: headRatio must be strictly between 0 and 1");

  const totalChars = text.length;
  const totalLines = countLines(text);
  if (totalChars <= maxChars) return { truncated: false, text, totalChars, totalLines, maxChars };

  const headBudget = Math.max(1, Math.round(maxChars * headRatio));
  const tailBudget = Math.max(1, maxChars - headBudget);

  // Head: end on the last newline at or before the head budget (or the budget).
  let headEnd = text.lastIndexOf(NL, headBudget);
  if (headEnd <= 0) headEnd = Math.min(headBudget, totalChars - 1);
  // Tail: start on the first newline at or after (length - tail budget).
  let tailStart = text.indexOf(NL, Math.max(0, totalChars - tailBudget));
  if (tailStart < 0 || tailStart <= headEnd) tailStart = totalChars - tailBudget;
  if (tailStart <= headEnd) tailStart = Math.min(totalChars - 1, headEnd + 1);
  if (tailStart <= headEnd) headEnd = Math.max(0, tailStart - 1);

  const middle = text.slice(headEnd, tailStart);
  const head = text.slice(0, headEnd);
  const tail = text.slice(tailStart);
  return {
    truncated: true,
    totalChars,
    totalLines,
    maxChars,
    head,
    tail,
    middle,
    headEnd,
    tailStart,
    omittedChars: middle.length,
    fromLine: countLines(head) + 1,
    toLine: countLines(text.slice(0, tailStart)),
  };
}

/**
 * Render the truncated text: head, a marker naming the omitted lines and the
 * ref, the tail, and one line telling the model how to page the middle back.
 * @param plan - the result of {@link truncateOutput} (`truncated: true`).
 * @param options - the ref id and the binding name used in the hint.
 * @returns the model-facing replacement text.
 */
export function formatTruncated(plan, options = {}) {
  if (!plan || plan.truncated !== true) throw new TypeError("ptc-boost: formatTruncated expects a truncated plan");
  const refId = options.refId;
  if (typeof refId !== "string" || refId.length === 0) throw new TypeError("ptc-boost: formatTruncated expects a refId");
  const toolName = options.toolName ?? "ref_text";
  const marker =
    `${NL}…[truncated: output lines ${plan.fromLine}-${plan.toLine} of ${plan.totalLines} omitted (` +
    `${plan.omittedChars} of ${plan.totalChars} chars), full text in ref "${refId}"]…${NL}`;
  const hint =
    `${NL}Output truncated (cap ${plan.maxChars} chars). Print less next time. To read only the omitted middle: ` +
    `await tools.${toolName}({ id: "${refId}", from: ${plan.headEnd}, to: ${plan.tailStart} }).`;
  return `${plan.head}${marker}${plan.tail}${hint}`;
}
