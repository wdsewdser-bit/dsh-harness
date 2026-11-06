# dsh-ptc-boost

A DSH 0.2.2 overlay for the PTC executor. It adds, as one Cordis plugin:

1. **Batching guidance** — a `ptc-boost:batching` system-prompt section with the
   Claude Code ptc-run "Using run_code well" method, rewritten for the DSH SDK
   (`read`, `edit`, `write`, `glob`, `grep`, `pwsh`, `job_output`, `ref_text`).
2. **Output truncation** — a `run_code` result over 8000 chars keeps its first
   70 % and last 30 %; the middle is stored under a ref id and served by the
   `ref_text` binding.
3. **Read dedup at the output layer** — `read` always returns the real text to
   the program; when a program prints a whole read result back unchanged and the
   session already printed those lines, that stretch of the *output* becomes one
   `[read-dedup]` line (or a diff, if the file changed), and the output ends with
   a `[read-dedup]` summary of the characters saved. Filtered, partial or
   re-numbered prints are never replaced.

Nothing in DSH is patched: the overlay only uses `tools/post-execute`,
`systemPrompt.section`, `tools.register` and `session/event`. See `DESIGN.md`
for the extension points and the reasoning.

## Load it

```yaml
# overlay applied with: dsh --profile headless --patch <this file> ...
- insert:
    - id: ptc-boost
      name: 'file:///<path-to-dsh-v2>/packages/ptc-boost/index.js'
      config:
        batching:   { enabled: true }
        truncation: { enabled: true, maxChars: 8000, headRatio: 0.7, toolName: ref_text }
        dedup:      { enabled: true, minReplaceChars: 300, maxChangedRatio: 0.3 }
```

Combine it with the PTC executor switch of the deployment:

```yaml
- id: tool-executor-native
  disabled: true
- id: tool-executor-ptc
  disabled: false
```

Every key is optional. Unknown keys and invalid values fail at load time.

## Configuration

| key | default | meaning |
|---|---|---|
| `batching.enabled` | `true` | register the prompt section |
| `batching.text` | `""` | replace the shipped body verbatim |
| `truncation.enabled` | `true` | truncate `run_code` output and register `ref_text` |
| `truncation.maxChars` | `8000` | cap in chars |
| `truncation.headRatio` | `0.7` | share kept at the head |
| `truncation.toolName` | `ref_text` | binding used by the paging hint |
| `truncation.maxEntries` / `maxTotalChars` | `64` / `4000000` | ref-store caps |
| `truncation.maxSliceChars` | `16384` | largest slice one `ref_text` call returns |
| `dedup.enabled` | `true` | switch the whole dedup behaviour off when false |
| `dedup.minReplaceChars` | `300` | printed runs smaller than this are never replaced |
| `dedup.minSeenRatio` | `0.5` | share of a run's lines that must be known before a diff is attempted |
| `dedup.maxChangedRatio` | `0.3` | more changed lines than this (share of the run) keeps the text |
| `dedup.maxDiffRatio` | `0.5` | a diff at least this long (share of the run) keeps the text |
| `dedup.maxDiffChars` | `4000` | diff size cap |
| `dedup.maxLinesPerFile` | `20000` | per-file line record cap in one session |

## Test

```bash
cd packages/ptc-boost
npm test        # node --test "test/**/*.test.js"
```

47 tests cover the truncation boundaries (8000 / 8001, line cuts, ref paging),
the ref store (absolute offsets, caps, eviction, unknown ids), the output-layer
dedup rules (whole-run match only, slice/filter/numbered prints never match,
notice, diff, small runs, changed-too-much, diff-not-smaller, toggle off,
compaction, fresh process), the ordering (dedup before truncation, lines dropped
by truncation are never recorded) and the invariant that a read result is never
modified.

## Smoke

`<path-to-probe-results>/long4-ab/ptc-boost-smoke/` holds the composed-config check and the
real-request smoke (see its `README.md`).
