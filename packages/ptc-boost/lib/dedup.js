/**
 * Read dedup at the **output layer**.
 *
 * `tools.read` always returns the real file text — the program may parse it,
 * slice it, count it or feed it to `edit`. Nothing here touches a tool result.
 * Dedup only rewrites the program's own output (what `console.log` printed plus
 * the serialised return value) *after* the program finished:
 *
 * - a read result that the program printed back **whole, unmodified and
 *   contiguous** (anchored on its first line, every following line in order) is
 *   a candidate; a slice, a filter, a per-line concatenation or a numbered
 *   form is a transformation and never matches,
 * - the candidate is replaced by one `[read-dedup]` line when the same file
 *   lines were already printed in this session and the text is unchanged,
 * - if the file changed, it is replaced by a compact diff (only when the diff
 *   is smaller than the text),
 * - everything else keeps the text, and the lines it shows are recorded as
 *   "the model has seen this".
 *
 * The record therefore only ever contains text that really reached the
 * conversation, which is what makes the replacement safe. Lines that fall into
 * a truncation middle are never recorded (see `pruneKept`), and a compaction
 * drops the whole record.
 *
 * @module dsh-ptc-boost/dedup
 */

/** Minimum size (chars) of a printed run before it is worth replacing. */
export const DEFAULT_MIN_REPLACE_CHARS = 300;

/** Stable key for a path (case-insensitive on Windows). */
export function pathKey(path) {
  const text = String(path);
  return process.platform === "win32" ? text.toLowerCase() : text;
}

/** The text a program prints for a whole read: its lines joined by newlines. */
export function blockOf(lines) {
  return lines.map((line) => line.text).join("\n");
}

/**
 * Find, in `text`, every complete read result printed back unchanged.
 * A candidate must match every line of the read, in order, separated by
 * newlines (a CR before the LF is tolerated). Overlapping candidates resolve
 * leftmost-longest so one stretch of output is replaced at most once.
 * @param text - the program's output.
 * @param reads - the reads this program performed, in call order.
 * @returns `[{ read, start, end }]` with `end` exclusive.
 */
export function scanSegments(text, reads) {
  if (typeof text !== "string" || text.length === 0 || !Array.isArray(reads)) return [];
  const found = [];
  for (const read of reads) {
    if (read === undefined || !Array.isArray(read.lines) || read.lines.length === 0) continue;
    const first = read.lines[0].text;
    if (first.trim().length === 0) continue;
    let from = 0;
    let guard = 0;
    while (guard < 50) {
      guard += 1;
      const start = text.indexOf(first, from);
      if (start < 0) break;
      let cursor = start + first.length;
      let matched = 1;
      while (matched < read.lines.length) {
        let p = cursor;
        while (p < text.length && text.charCodeAt(p) === 13) p += 1;
        if (text.charCodeAt(p) !== 10) break;
        p += 1;
        const line = read.lines[matched].text;
        if (!text.startsWith(line, p)) break;
        cursor = p + line.length;
        matched += 1;
      }
      if (matched === read.lines.length) found.push({ read, start, end: cursor });
      from = start + 1;
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const chosen = [];
  let cursor = 0;
  for (const candidate of found) {
    if (candidate.start < cursor) continue;
    chosen.push(candidate);
    cursor = candidate.end;
  }
  return chosen;
}

/** The one-line replacement for an unchanged, already-printed range. */
export function noticeText(label, read, savedChars) {
  const range = read.offset === read.endLine ? `line ${read.offset}` : `lines ${read.offset}-${read.endLine}`;
  return (
    `[read-dedup] ${label}: ${range} of ${read.totalLines} already printed in this session, file unchanged — ` +
    `copy omitted (${savedChars} chars saved). Print a transformed form to see it again; ` +
    `transformed output is never deduplicated.`
  );
}

/**
 * Line-aligned diff for a changed range: common prefix and suffix collapse,
 * only the changed block is listed, rows are capped by `maxChars`.
 */
export function diffWindow(entry, read, options = {}) {
  const maxChars = options.maxChars ?? 4000;
  const old = read.lines.map((line) => entry.lines.get(line.number));
  const fresh = read.lines.map((line) => line.text);
  let prefix = 0;
  while (prefix < fresh.length && old[prefix] !== undefined && old[prefix] === fresh[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < fresh.length - prefix &&
    old[fresh.length - 1 - suffix] !== undefined &&
    old[fresh.length - 1 - suffix] === fresh[fresh.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const rows = [];
  let used = 0;
  let omitted = 0;
  const push = (row) => {
    if (used + row.length + 1 > maxChars) {
      omitted += 1;
      return;
    }
    rows.push(row);
    used += row.length + 1;
  };
  let changed = 0;
  for (let i = prefix; i < fresh.length - suffix; i += 1) {
    const number = read.lines[i].number;
    if (old[i] !== undefined && old[i] !== fresh[i]) {
      push(`- ${number}: ${old[i]}`);
      changed += 1;
    }
    push(`+ ${number}: ${fresh[i]}`);
    changed += 1;
  }
  return { rows, omitted, prefix, suffix, changed, compared: fresh.length - prefix - suffix };
}

/** The diff replacement for a range that changed since it was last printed. */
export function diffText(label, read, diff) {
  const range = read.offset === read.endLine ? `line ${read.offset}` : `lines ${read.offset}-${read.endLine}`;
  const head =
    `[read-dedup] ${label}: ${range} of ${read.totalLines} changed since it was printed. ` +
    `Only the differences follow; unlisted lines match what you already have:`;
  const body = diff.rows.length > 0 ? `\n${diff.rows.join("\n")}` : "\n(nothing differs in this range)";
  const tail =
    `\n(${diff.prefix} leading, ${diff.suffix} trailing lines unchanged` +
    `${diff.omitted > 0 ? `, ${diff.omitted} further changed lines omitted — print a smaller range` : ""}).`;
  return `${head}${body}${tail}`;
}

/**
 * Decide what one printed read run becomes.
 * @param entry - the session record for the file (may be undefined).
 * @param read - the read whose text was found in the output.
 * @param segmentLength - the printed segment's length in chars.
 * @param config - dedup configuration.
 * @returns `full` (keep the text), `notice` or `diff`, plus the replacement.
 */
export function planReplacement(entry, read, segmentLength, config) {
  if (entry === undefined || entry.lines.size === 0) return { kind: "full", reason: "no-record" };
  let known = 0;
  for (const line of read.lines) if (entry.lines.has(line.number)) known += 1;
  if (known === 0) return { kind: "full", reason: "no-overlap" };
  if (known < read.lines.length * (config.minSeenRatio ?? 0.5)) return { kind: "full", reason: "partial-overlap" };

  // A notice claims the whole range is already in context, so it needs every
  // line known; a partly-known range can only become a diff.
  let identical = known === read.lines.length;
  if (identical) {
    for (const line of read.lines) {
      if (entry.lines.get(line.number) !== line.text) {
        identical = false;
        break;
      }
    }
  }
  if (identical) {
    const draft = noticeText(read.label, read, 0);
    const text = noticeText(read.label, read, Math.max(0, segmentLength - draft.length));
    return { kind: "notice", text, savedChars: Math.max(0, segmentLength - text.length) };
  }

  const diff = diffWindow(entry, read, { maxChars: config.maxDiffChars ?? 4000 });
  if (diff.changed > (config.maxChangedRatio ?? 0.3) * Math.max(1, read.lines.length)) {
    return { kind: "full", reason: "changed-too-much" };
  }
  const text = diffText(read.label, read, diff);
  if (text.length >= segmentLength * (config.maxDiffRatio ?? 0.5)) return { kind: "full", reason: "diff-not-smaller" };
  return { kind: "diff", text, savedChars: Math.max(0, segmentLength - text.length), diff };
}

/** Summary line appended to the output when at least one segment was replaced. */
export function summaryLine(run, session) {
  return (
    `[read-dedup] this program: ${run.hits} segment(s) replaced, ${run.savedChars} chars saved; ` +
    `session total: ${session.hits} hit(s) / ${session.savedChars} chars.`
  );
}
