/**
 * The batching/context guidance section added to the system prompt.
 *
 * It restates the Claude Code ptc-run "Using run_code well" guidance for the
 * DSH tool surface (read, edit, write, glob, grep, pwsh, job_output, plus this
 * overlay's ref_text). It is additive: DSH's own prompt sections (the PTC-only
 * rule, the per-tool guidance, and the generated SDK declarations) stay exactly
 * where they are; this section is registered after the SDK block so the model
 * reads the declarations first and the working method second.
 *
 * @module dsh-ptc-boost/prompt
 */

/** Section name used in the system-prompt registry. */
export const BATCHING_SECTION_NAME = "ptc-boost:batching";

const HEADING = "## Using run_code well";

/** The shipped guidance body, one paragraph or bullet per array entry. */
const BODY = [
  "Every `run_code` call is one round trip through the model, and round trips — not the tool calls inside a program — are what cost time and tokens. A program can make dozens of tool calls; a turn can only make one program. So plan each program to finish a whole phase of the work, not a single step:",
  "",
  "- **Gather in bulk.** When you need to understand several files, find them (glob/grep) and read all of them in the same program with `Promise.all`. Ten or twenty reads at once is normal and fast. Do not read one file, look at it, then read the next.",
  "- **Print extracts, not dumps.** Slice out what you need (a function, a few lines around each match, a test's assertion) and print those with line numbers. Never print a whole tool result object: `read` returns every requested line and `glob`/`grep` return every match, so the model only ever needs the extraction.",
  "- **Change in bulk.** Once you know what to change, make every edit of that phase in one program — across all the files involved — then verify in that same program (run the affected tests, grep for leftovers) and print only a summary.",
  "- **Decide in code what you can predict.** Use loops, conditionals, regular expressions and `try/catch` to handle the cases you already foresee: skip files that are done, fall back to a second pattern, collect failures and keep going instead of stopping at the first one.",
  "- **End a program only when the next step truly depends on reading its output.** A typical task takes 3-6 programs: survey, read everything relevant, edit everything, verify, fix the stragglers.",
  "",
  "Anti-pattern (one tool per program, a dozen round trips): read a.py, look, read b.py, look, edit a.py, run the tests, read c.py, look, edit c.py, run the tests.",
  "",
  "Instead (three round trips): survey and read every relevant region at once; apply all the edits and run the tests; fix whatever is still failing.",
  "",
  "### What to print",
  "",
  "Everything a program prints becomes new context: it is billed in full once, then carried by every later turn. Before printing, ask who needs the text:",
  "",
  "- **Only the program needs it** (counting, listing names, collecting imports, checking a result against the files, comparing two lists): compute it in code and print the conclusion — `mismatches: 0`, or the count plus the first few offenders. Never print the data you are checking, the report you just wrote, or a full JSON result \"to look at it\".",
  "- **You need it to reason or edit** (a function you are about to change, the assertion a failing test makes, the code a traceback points at): print it once, completely enough to write the edit, with line numbers. Reading it fully now is right: it stays in context for the later turns.",
  "- **You are not sure yet** (a file that might matter, a document, a whole module): locate first — `grep` for the names and print the matching lines with a few lines of context — and read the full region in the next program only if it turns out to matter.",
  "- **Command output**: print the summary, not the stream. For pytest print `-q --tb=line` (or `--tb=short` for the few tests you will fix) and the tail; for a build print the error lines and the count.",
  "",
  "### Reading, paging and repeated reads",
  "",
  "- `read` takes `{ file_path, offset, limit }` and returns `{ path, offset, lines: [{ number, text }], totalLines }`. For a large file read the region you need instead of the whole file.",
  "- `read` always returns the real text to the program, so parsing, slicing and passing it to `edit` are safe. Dedup happens on the way out: when a program prints a whole read result back unchanged, and this session already printed those same lines, that stretch of the program's output is replaced by a single `[read-dedup]` line (or by a diff when the file changed in between), and the output ends with a `[read-dedup]` summary of the characters saved. Filtered, partial, re-numbered or otherwise transformed prints are never replaced. After a compaction or a resume the full text comes back.",
  "- Dedup runs before truncation: a big read that dedup already collapsed does not count against the output cap. One program's printed output over about 8000 characters keeps its first 70% and last 30%; the omitted middle is stored under a ref id named in the marker. Print less next time; to recover the middle, call `await tools.ref_text({ id, from, to })` with the offsets from the marker.",
].join("\n");

/**
 * Build the section text.
 * @param options - `override` replaces the shipped body verbatim.
 * @returns the section text (always non-empty for the shipped body).
 */
export function batchingGuidance(options = {}) {
  const override = typeof options.override === "string" ? options.override : "";
  if (override.trim().length > 0) return override;
  return `${HEADING}\n\n${BODY}`;
}
