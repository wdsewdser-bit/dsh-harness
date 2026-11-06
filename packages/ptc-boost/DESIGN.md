# ptc-boost — design and extension points (DSH 0.2.2-alpha.2)

Overlay that adds three Claude Code ptc-run behaviours to the stock DSH PTC
executor without touching the installation, node_modules, or any upstream file:

1. a batching/context section in the system prompt,
2. output truncation with a ref for the omitted middle,
3. read dedup at the output layer (a whole printed read becomes a notice or a diff).

Everything is loaded as one extra Cordis plugin through a `--patch` overlay.

## 1. What the survey found

Install: `<path-to-dsh-upstream-0.2.2-alpha.2>/install` (read-only).
Relevant packages under `node_modules/@deepseek-ai/`:

| package | role |
|---|---|
| `dsh-base` / `dsh-headless` | bundle patches; `cordis.patch.yml` lists every entry |
| `dsh-tools` | tool registry + execution pipeline (`lib/pipeline.js`) |
| `dsh-tool-executor-ptc` | `run_code` transport, SDK prompt rendering, nested dispatch |
| `dsh-ptc-runtime-node` | program execution (`maxOutputBytes` 64 MiB — no useful cap) |
| `dsh-system-prompt` | ordered prompt section registry |
| `dsh-tool-fs` | `read`/`write`/`edit` definitions and their render functions |
| `dsh-compaction-*`, `dsh-spill-*` | compaction and spill neighbours that share the same result path |

### The extension points that actually exist

1. **`tools/post-execute` waterfall** — `dsh-tools/lib/pipeline.js:673`
   ```js
   const decision = await this.ctx.waterfall(scopeTarget(this.tools, exec.agent),
     "tools/post-execute", exec, result, () => Promise.resolve({ kind: "accept" }));
   ```
   A listener returns `{ kind: "accept", content }` to replace the model-facing
   content, or `{ kind: "accept", value }` to replace the canonical value (the
   replacement is re-validated against the tool's output schema and re-rendered
   by the tool's own `render`). It runs for **every** dispatch, including nested
   PTC sub-calls (`exec.parent` set) and the outer `run_code` call
   (`exec.parent === undefined`). `dsh-tools/lib/types/contracts.d.ts:341`
   declares the decision type. This overlay only ever replaces the `content` of
   the outer `run_code`; it must not replace a read's `value` (see section 5).

2. **`ctx.systemPrompt.section({ name, order, text, interpolate })`** —
   `dsh-system-prompt/lib/index.js:253`. Sections are sorted by `order`;
   `SECTION_ORDERS.TOOLS_SDK = 5000` is where the generated SDK declarations
   live (`dsh-tool-executor-ptc/lib/index.js:1727`). Registering at 5100 puts
   the guidance immediately after the declarations and deletes nothing.
   `interpolate: false` keeps literal text safe from `{{variable}}` parsing.

3. **`ctx.tools.register(definition)`** — `dsh-tools/lib/index.js:433`. A plain
   definition `{ name, description, parameters(JSON Schema), output: { schema, render }, execute }`
   is accepted (only `output.schema` is asserted). The PTC executor renders every
   visible tool into the SDK block, so the new tool automatically becomes a
   `tools.<name>(...)` binding inside programs
   (`renderSdk` → `dsh-tool-executor-ptc/lib/index.js:1744`).

4. **`session/event`** (with `{ global: true }`) — compaction appends
   `compaction/start`, `compaction/summary`, `compaction/end`
   (`dsh-compaction-basic/lib/index.js:469,484,634`). Observing them is how the
   overlay learns that content it remembered is no longer in the model's context.

5. **`tools/ptc-dispatch-log` waterfall** — `dsh-tool-executor-ptc/lib/index.js:310`;
   it shapes only the *logged* copy of a nested dispatch, never the value the
   program receives, so it cannot save context. Not used.

### What does not exist (and what was rejected)

- **No way to edit the `run_code` tool description.** It is a module constant
  (`TYPESCRIPT_FLAVOR` / `TYPESCRIPT_FUNCTION_FLAVOR`,
  `dsh-tool-executor-ptc/lib/index.js:103-108`) used when the transport is built.
  Replacing it would mean patching upstream — excluded by the task. The additive
  prompt section is the supported equivalent (and is where Claude Code keeps the
  same text).
- **`personaPrefix`/`personaSuffix`** (a `system-prompt` config key) could have
  carried the text, but the headless bundle already sets `personaPrefix`; an
  overlay would have to restate the whole persona and would collide with the
  deployment persona. Rejected in favour of a new named section.
- **`system-prompt/assemble` waterfall** could rewrite any section, including
  upstream text. Rejected: rewriting is exactly the "delete upstream constraints"
  failure mode the task forbids.
- **Rewriting a read result** (the read tool's value or content through
  `tools/post-execute`) is what this overlay did first, and it is wrong: a PTC
  program receives the canonical value, so a replacement silently changes what
  the program parses, slices and writes back (section 5). Dedup therefore lives
  on the program's output (section 2.3).
- **A `tools/execute` wrapper** could short-circuit `read` before dispatch, but
  it would need to synthesize a full `ToolExecutionSuccess` and to duplicate the
  read tool's path resolution. `post-execute` already has the parsed value and
  the session identity.
- **Writing the omitted middle to a file** and telling the model to `read` it
  was rejected: the read tool resolves through the sandbox (`fs-sandbox`,
  workspace-write), so a file outside the workspace is not a reliable recovery
  path. A registered tool has no such restriction.

## 2. Chosen design

```
packages/ptc-boost/
  index.js            Cordis plugin: section, tool, post-execute hook, session events
  lib/config.js       three switches, defaults, strict validation
  lib/prompt.js       the "Using run_code well" section, adapted to the DSH SDK
  lib/truncate.js     head/middle/tail plan + marker/hint rendering
  lib/refstore.js     in-memory ref store (absolute offsets, caps, eviction)
  lib/dedup.js        output scan (whole printed runs), notice/diff plan, summary line
  lib/boost.js        the runtime tying the above together (no DSH imports)
  test/*.test.js      node:test unit + wiring tests
```

No file imports a DSH or Cordis package: the plugin only uses `ctx` services, so
the overlay cannot pull a second harness copy into the process and the whole
policy layer is testable with plain `node --test`.

### 2.1 Batching guidance

`ctx.systemPrompt.section({ name: "ptc-boost:batching", order: TOOLS_SDK + 100,
interpolate: false, text })`. The body restates Claude Code's "Using run_code
well" (round trips vs sub-calls, gather in bulk with `Promise.all`, print
extracts not dumps, change in bulk, decide in code, when to end a program, the
anti-pattern, what to print) plus the DSH specifics: `read`/`edit`/`write`/
`glob`/`grep`/`pwsh`/`job_output`/`ref_text`, and the dedup/truncation
behaviour so the notices are not mistaken for errors. Switch: `batching.enabled`;
`batching.text` replaces the body verbatim.

### 2.2 Output truncation

Hook: `tools/post-execute` on `run_code` with `exec.parent === undefined`
(the model-facing transport call). Over `maxChars` (8000):

- head ≈ 70 %, tail ≈ 30 %, both cut on line boundaries,
- the middle goes into the ref store keyed by id `r1`, `r2`, … (absolute
  offset = `headEnd`), capped by entry count / total chars,
- the result content is replaced by head + marker + tail + one hint line:
  `await tools.ref_text({ id, from, to })` with the exact offsets.

`ref_text` (`ctx.tools.register`) returns slices of up to 16 KiB and appends a
continuation note when more remains, so a 30 KB middle is recovered in two calls.
Refs live only in the process and session that created them; a resumed session
just truncates again. Switch: `truncation.enabled` (with the tool and the hint).

### 2.3 Read dedup (output layer)

**`tools.read` always returns the real file text.** The read result is only
*observed* (path, range, lines) and never rewritten: a program may
`JSON.parse` it, slice it, join it, or hand a line to `edit`, and it must get
the file, not a placeholder. (An earlier version of this overlay replaced the
read *value*; a long4 run then wrote the replacement text back over a source
file — see section 5. That design is gone.)

Dedup lives on the program's **output** — what `console.log` printed plus the
serialised return value — and runs inside the same `run_code` post-execute hook
as truncation, in this order: **dedup, then truncation, then the summary line**.

A printed stretch is a candidate only when it is one read result printed back
**whole, unmodified and contiguous**: anchored on its first line, every
following line present in order and separated by a newline (CR tolerated).
A slice, a filter, a different join, a numbered form (`12| line`) or a
`JSON.stringify` all fail to match and are left alone. Candidates resolve
leftmost-longest, so no stretch is replaced twice.

The replacement decision compares the printed lines with the session record —
the lines this session has actually shown:

1. no record for the file, or no line of the range in it, keeps the text,
2. fewer than `minSeenRatio` (50 %) of the lines known keeps the text,
3. every line known and identical gives one `[read-dedup]` line ("already
   printed in this session ... omitted (N chars saved)") plus the hint that a
   *transformed* print is never deduplicated,
4. otherwise a compact diff: common prefix/suffix collapse, only the changed
   rows are listed (`- n:` old, `+ n:` new), capped by `maxDiffChars`; if more
   than `maxChangedRatio` (30 %) of the lines changed, or the diff is not
   smaller than `maxDiffRatio` (50 %) of the run, the text is kept,
5. runs under `minReplaceChars` (300) are never replaced.

The record is what makes the replacement safe, so it only ever holds text that
reached the conversation:

- a kept run records its lines **only where they survive truncation** — lines
  that fall into the omitted middle are not recorded, so a later program still
  gets them in full,
- a diff also records the new lines (old text + diff lets the model
  reconstruct them), again only if the diff itself survived truncation,
- a notice records nothing new (the lines were already known),
- a `compaction/*` event drops the whole session record (and its refs),
- a new process starts empty, so a resumed session gets full text.

Ordering matters: dedup runs first, so a read that collapses to one line does
not spend the 8000-char output cap; the `[read-dedup]` summary is appended
after truncation so it always survives. When at least one segment was replaced
the output ends with `[read-dedup] this program: N segment(s) replaced, X chars
saved; session total: M hit(s) / Y chars.`

`dedup.enabled` switches the whole behaviour off: the output is then
byte-identical to stock DSH.

### 2.4 Loading

```yaml
- insert:
    - id: ptc-boost
      name: 'file:///<path-to-dsh-v2>/packages/ptc-boost/index.js'
      config: { batching: { enabled: true }, truncation: { enabled: true, maxChars: 8000 }, dedup: { enabled: true } }
```

`cordis-plugin-loader` imports a bare specifier otherwise, but a `file://` URL is
accepted by `import.meta.resolve` from the profile's base URL, which is how the
overlay points at the working tree without installing anything. Removing the
`insert` block restores stock DSH; nothing else in the profile changes.

## 3. Interaction with neighbouring plugins

- `spill-policy` (`maxInlineTokens` 12500) and `tool-result-pruner`
  (`thresholdChars` 8192) run on the same result. The overlay computes its
  decision *after`next()` and yields to any downstream listener that already
  replaced content or value, so it never fights them; a truncated 8 KB result is
  below both thresholds, so spill does not fire for it.
- The post-execute listener is registered in the root scope; the pipeline
  dispatches on `scopeTarget(tools, agent)`, so the listener sees nested and
  outer calls of every agent and session.

## 4. Known limits / risks

- Dedup only triggers for a read printed back whole and unmodified; a program
  that prints a summary, a slice or a numbered form keeps the next read in full
  (chosen over risking a wrong replacement).
- The record is per DSH process and session; a resumed session prints full text.
- Refs are process-local; after a restart or compaction, recovery means re-running
  the program (the truncation message says so).
- `ref_text` adds one tool to the SDK block (the declarations grow by a few lines).
- A deduplicated stretch of the output is annotated text; the model reads the
  marker, never a file that the program wrote.
- Byte-level line splitting follows the read tool's own line model (`\n`); files
  with only `\r` separators behave like the stock read tool.

## 5. Why dedup may not touch a read result

The first version of this overlay replaced the read tool's canonical value, so a
repeated read came back to the program as a one-line notice. The long4 run in
`<path-to-probe-results>/long4-ab/logs/dsh3.events.jsonl` (score 75.4, 171 requests) shows what
that does:

- steps 11, 12 and 18: the program printed a read it had already printed, got the
  notice, and the model spent three steps trying different ranges to obtain text
  it was told it already had (its own reasoning: "the read tool dedupe blocks").
- step 108: a rename program read the file, joined its lines into one string,
  string-replaced a few fragments and wrote the string back. The read returned
  the notice, so the notice was written over `core/logger.py` (233 bytes) and the
  program reported success.
- steps 110, 112 and 113: the model read the damaged file, checked it with
  `pwsh`, wondered whether the runtime caches file content by path, and had to
  rewrite the whole 5.5 KB module from memory (all 18 original functions
  survived, but the file is now a reconstruction).

None of those failures is possible with output-layer dedup: the program always
gets the file, and only the text printed into the conversation is rewritten.
