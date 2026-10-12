# Context Optimization And Delivery Window Fix

Status: implemented, four logical profiles synchronized, and loaded without
restarting DSH. Focused checks and live mock wiring pass. Full regression is
not green: the same two known baseline failures remain. This is the recovery entry.

## Scope

- CTX-SDK-01: keep the latest complete tools:sdk for current calls, remove only
  old SDK sections in explicitly certified historical versions. Non-SDK rules,
  reasoning, tool-call/result values and toolHistory remain unchanged.
- OBS-LINE-01: preserve original observation line numbers, handle cache version,
  current canonical tool role and mixed-content safety.
- CTX-TEAM-AUDIT: deduplicate only an identical trusted milestone snapshot still
  present in the full current surface, not just the last 256 messages.
- User addition: suppress Git/Cargo console windows from team_delivery_check.
- Do not restart DSH, interrupt active Teams, change provider/global thinking,
  enable production Reducer, switch protocol or clean original data.

## Changes

The rc.2 immutable request API means the old llm/stream options.messages mutation
did not reliably reach the adapter. A local, removable request-message-projection
service wraps only the actual runtime instance entry before the native waterfall.
It preserves prepared adapter registration, configuration, caller scope, signals,
tool definitions/history and the correct installed runtime's WeakSet brand.
No installed application package or class prototype was edited.

SDK uses explicit mode=apply, policy=latest and sdk-compatibility-manifest.json.
Only the audited five-version chain is certified; new, unknown, reordered or
otherwise incompatible SDK versions retain their historical text. This is a
documentation projection, not lossless historical compaction.

ObservationPack carries real L2/L173/L399 source line indices rather than guessing
src/cache.ts:41 as log line 41. It keeps two original full sends, validates the
archive and invalidates old cached handle formatting. Non-text mixed content and
failed tool results remain complete, not compressed.

Milestone checks the full CURRENT retained surface for the exact trusted source
and text. Replacement/compaction removing an old marker allows re-injection;
different stage, doneWhen, marker or source is not merged. The proved duplicate
was 513 bytes; no global token savings estimate is claimed.

team-worktree runGit and runCargo execFileSync now pass windowsHide=true, without
changing argv, timeouts, outputs or exit-code handling. Tests capture five Git
and five Cargo paths. No shell or cmd helper was added. The user subsequently
confirmed the current Team had just used team_delivery_check without windows
appearing, and explicitly requested no more testing. Further window probe work
was stopped. This is user-reported actual-use acceptance, not an independent
visual observation by this agent.

## Real Trials

- SDK: two completed pairs, including the latest/full reverse pair after the
  user repaired the relay. Full each 174,177 input / 78 output; certified latest
  each 36,259 / 78. Strict SDK argument and recorded call/result facts are
  identical. Each pair removes 137,918 input tokens (79.18% of this SDK fixture).
  The original HTTP 403, failed report and ledger remain unchanged, with unknown
  usage rather than zero. Five HTTP attempts, four successful: known input
  420,872 and output 312; all-attempt totals are unknown. See
  workspaces/context-sdk-01/combined-post-repair-report.json and the original,
  post-repair reports and ledgers. The post-repair bodies match the original
  successful arms' hashes. This verifies a documentation/recorded-protocol fixture,
  not arbitrary tool execution or all-task quality.
- ObservationPack: four real calls in full/handle/handle/full order. Full each
  8,937 input / 146 output; corrected handle each 820 / 146. Every original
  line, quote, checksum and status passes the unchanged strict validator,
  without a manually added overlay. Source: usage-lab-20261001/obs-line-01.
  Each comparison removes 8,117 input tokens (90.82% of this log fixture).
  The subsequent mixed-content guard changed source hash but issued no extra HTTP
  and did not reattribute the original golden calls.
- Provider prices are unknown. Token differences are not money savings; cache
  heat differs between calls. These are bounded fixtures, not all-task proofs.
- Runtime canaries issued no upstream HTTP. Production Reducer route, global
  thinking and protocol remain unchanged; request-level thinking was disabled
  only for these authorized bounded golden calls.

## Deployment And Evidence

Backups: D:/dsh-backups/context-opt-20261001. Existing desktop-to-web and
teamtest/plugins-to-web junctions are preserved. All affected mounted modules
are synchronized across the four logical profiles, leaving unrelated profile
limits and platform settings untouched. Teamtest's actual old OP/tool mounts
were updated to v2/r10 so file parity also reaches its consuming entries.

The usage ledger includes a whitelisted requestProjection receipt with actual
bridge pid/hash, applied/skipped status and processor IDs, without raw bodies.
SDK has a separate bounded metadata audit under home/ptc-sdk-retention-audit.

Live canary: docs/context-opt-20261001/runtime-canary.json, actual DSH PID 16440.
The same process started 2026-09-30T16:37:18.148+08:00 (millisecond precision)
and remains alive. Win32 and Get-Process differ only in sub-millisecond rounding.
Actual adapter input: SDK 5 -> 1; 852,939 original message bytes become
263,350 / 263,350 / 232,200 on three dispatches. The third dispatch contains the
OP handle and original L2/L173/L399. Non-SDK chain, reasoning, tool calls/results,
toolHistory, signal, canonical request brand and prepared A/B/B generation pass.
Actual native usage-ledger hook persisted all three projection receipts with
rootTeamId=null and explicitly mock usage=0. The temporary provider was
unregistered and one-shot probe mount removed. This proves current runtime
wiring, not model quality or financial savings. The fixture/archive is retained.

Live canary SHA256:
`b14d92f84f4d56f5fea6961fdd13a6b87b22eb0b36b636313af7c8fbf92eab2b`.

## Verification

- Syntax checks cover the six affected modules' distinct physical profile copies,
  the runtime canary and real SDK runner. YAML is parsed structurally, profile
  changes compared to pre-change backups, and unrelated configuration preserved.
- Focused: 56/56 pass. Bridge 11/11 must run without test-runtime-resolver because
  its module-copy tests require separate app/profile WeakSets. The other 45/45 use
  the resolver. Preserve focused-tests.txt: its two earlier module-copy failures
  were a resolver identity collision, corrected without weakening assertions.
- Post-repair SDK runner syntax and 2/2 offline tests pass.
- OP/core/observation combined suite: 28/28 pass; independent mixed-content review
  covers six fail-open examples. SDK/bridge independent review accepted.
- Full regression: 133 files, 562 tests, 559 pass, 2 fail, 1 skip. The failures are
  the prior B96 artificial DSH_HOME assertion and legacy GROUP LEAD identity
  assertion. Health script also prints three FAIL lines while exiting zero.
  No unrelated prompt/health assertions were modified to force a green result.
- Window fix: 1/1 focused process-option test captures five Git and five Cargo
  paths with windowsHide=true; existing delivery gate/milestone tests pass.
  User confirmed the actual current Team check no longer opens windows;
  no subsequent window tool or probe was executed.

Logs: bridge-tests.txt, focused-tests-correct-resolver.txt, regression.txt.
Manifest and reproducible verification: delivery-manifest.json and
D:/dsh-test/tools/context-opt-delivery-snapshot.mjs.

The repair result was queued to the existing root session, without steering:
session-028e6f5b-1716-4c23-a232-af16d853d191. Server accepted=true is recorded in
dsh-root-notice-receipt.json, request 9d424283-6666-40d6-9fc1-80ee25f3cf0b.
Queue acceptance is not a claim that a model has already processed the notice.
Its original statement that window visual acceptance was pending is superseded
by the user's later actual-use confirmation; the accepted notice is not rewritten.

## Boundaries And Follow-Up

- Do not extrapolate fixture percentages to the user's 5-billion-token day.
  SDK-only 79.18% is not whole-context 79.18%; historical usage is not rewritten.
- Only the five explicit SDK hashes are certified. Unknown future SDK changes
  retain old text (fail-open) until separately reviewed and validated.
- Existing journals, old backups, spill/telemetry/session data and active Team
  authority were not removed. No blind reasoning or argument trimming occurred.
- Production Reducer allowlist is unchanged, so this is not a claim that Reducer
  now has production samples. Cache/uncached costs and all-task quality still
  require natural usage receipts from the existing root and its descendants.
- The separate historical backfill and complete-token accounting entry remains
  docs/usage-audit-20261001/README.md. This work improves current request projection;
  it does not change previously billed historical token totals.
