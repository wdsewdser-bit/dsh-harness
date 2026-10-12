# DSH Usage Audit

Status: historical backfill and passive observer delivered; bounded real trials
completed with explicit quality failures and diagnostic follow-ups. Full legacy
regression is not green. This is the recovery entry point.

## Current Conclusions

The user's root plus ALL descendant agents is one Team workflow. Daily usage of
about 5 billion tokens is supported by the historical records; the previous use
of individual-child averages to contradict it was wrong.

Historical backfill covers 138 source files and 105 session identities across
mc189-rs and RustMc. Strict zstd framing found no corrupt/truncated frames, invalid
JSON, or files changing while read. v3/v4 migration copies are merged, independent
same-millisecond requests are preserved, and failed-attempt usage uses the LAST
persisted usage snapshot rather than summing cumulative snapshots.

| Historical Metric | Result |
|---|---:|
| Ledger rows | 145,805 |
| Known total | 44,011,704,608 |
| Missing total | 181 calls |
| mc189-rs workspace known total | 33,246,934,466 |
| RustMc workspace known total | 10,764,770,142 |
| Peak Beijing day, 2026-09-23 | 5,538,603,165 |
| Average prompt / P50 / P95 | 300,453 / 239,169 / 716,669 |
| Known cacheRead / uncached input / output | 95.00% / 4.41% / 0.59% |
| Compaction-call share of known total | 1.78% |

Known total differs from the user's backend snapshot by 3,660,901,622. This is an
unreconciled gap, NOT fabricated backfilled usage. Missing raw protocol,
cacheWrite, reasoning and auxiliary-call totals stay unknown.

## Why Input Is Large

Two newly observed continuing RustMc root requests each read approximately 703K
total tokens, of which only 322/208 were uncached input. The main problem is a
large retained prompt multiplied by many calls, not mostly newly generated text.

The two-request content byte breakdown is system 32.01%, historical reasoning
23.05%, explicit Team messages 15.77%, tool-call arguments 14.25%, assistant text
6.51%, tool results 4.25%, and other/unknown injected content about 3.90%.
These are payload BYTES, not exact tokenizer or billed-cost percentages.

The system bucket is not all policy. Five retained `system-prompt` messages contain
five complete versions of the PTC `tools:sdk`, totaling 720,287 bytes out of
798,822 system bytes (90.17%). Local published runtime code confirms that
`systemPromptUpdate=in-history` appends the whole changed system prompt; PTC
exposes only run_code in the formal tool schema while embedding 134 tools in the
SDK system section. See `system-sdk-audit.json` for journal seq/hash and code chain.

ObservationPack's old approximately 742M savedTokens is a mechanism estimate, not
a measured counterfactual bill. Its ratio to the user's different-time 47.67B
snapshot is only a magnitude comparison. Compressing eligible tool outputs alone
does not remove repeated SDK, reasoning, Team traffic or tool-call parameters.

## New Observer

The existing DSH process PID 16440 hot-loaded the observer; creation time remained
2026-09-30T16:37:18.148579+08:00. Continuing existing root requests and an isolated
real DSH probe produced terminal receipts. The user does NOT need a new session.

Records are append-only under `D:/dsh-test/home/usage-ledger`. Aggregate terminal
events once by requestId; start events must not be added again. Whole-Team grouping
uses rootTeamId, not immediateTeamId. The observer does not rewrite model requests,
record raw bodies or secrets, cancel inflight requests on HMR, or infer absent usage.

It records canonical usage plus explicit route config, root/parent identity,
purpose, latency, content category byte sizes and hashes. The hook sees
`llm/stream`, not the exact outbound wire. Direct auxiliary HTTP calls outside this
hook are not claimed covered. Raw reasoning/cacheWrite may still be null because
the installed DSH adapter does not expose them.

All four logical profiles have one mount and identical module SHA256:
`C8BFEB5C020C57D162799E4350980644752D1DF7EE5BC8B287EA3B6801FCB087`.
desktop is an existing junction to web and intentionally shares its label;
teamtest plugins are also shared by an existing junction. No links were replaced.

## Real Experiments

Isolated workspace: `D:/dsh-test/workspaces/usage-lab-20261001`.
21 actual opencodego HTTP calls, 130,044 input, 7,929 output, 137,973 total;
reasoning 4,846 is already a subset of output. Raw provider usage exists for 21/21.
The separate real DSH integration probe cost 52,796 total. Ongoing user root
requests are integration evidence, not part of the lab's controlled call budget.

- Original schema trials used the default thinking configuration. A Team call
  exhausted its 1,500-token output budget entirely in reasoning and failed.
  Subsequent controlled pairs used request-level thinking disabled, verified by
  the installed adapter and a returned reasoning_tokens=0. Global settings did not change.
- Current ObservationPack handle: 773 input / 919 total, FAILED exact source-line
  recall (code line 41 was mistaken for original log line 173). This is not a
  quality-neutral savings result.
- Diagnostic handle plus explicit immutable source-line mapping: 886 input /
  1,032 total, passed all strict evidence checks. This is a NEW CANDIDATE, not the
  production mechanism and not a deployed fix.
- Full log: 8,937 input / 9,129 total. Real Reducer plus final answer: 1,932 input /
  2,270 total, both receipt verification and exact critical quote/line recall
  passed. This saved 6,859 total tokens (75.13%) on ONE fixture, while latency
  increased from 2,070ms to 6,417ms. This is not a whole-workflow savings rate.
- One real PTC SDK copy: 34,769 input; two copies: 69,491 input, delta 34,722.
  Both had zero cache hits and returned the fixed sentinel. This isolates
  duplicate SDK input, not correctness of arbitrary tasks with one versus five versions.
- The initial quote-shape validator stop was corrected locally and all existing
  responses revalidated without repeat HTTP calls. The genuine output-budget
  and ObservationPack evidence failures remain in the raw ledger and report.

See the lab workspace's `report.json`, `report.md`, `calls.jsonl`, and
`revalidation.json`, plus this audit directory's `lab-results.md`.
Missing price/fee rules prevent a monetary savings claim.

## Next Decisions

Prioritize bounded evaluation of retaining one authoritative current SDK section,
or on-demand versioned tool documentation, over treating all system text as policy.
Do not blindly remove reasoning or tool-call history: protocol correctness and
task/lease/evidence authority must survive valid checkpoints and compaction.
Test Team message/digest dedup and code-argument locators separately. Preserve
ObservationPack source-line mapping before counting its quality-neutral savings.

These are recommendations, not production changes. Production Reducer remains
enabled=true but route-blocked by localProviders=[] and remoteAllowed=false;
the audit did not change those settings, Responses, or compaction strategy.

## Evidence

- Final history: `history-2026-09-30T19-40-10-849Z-report.json` and `-requests.jsonl`.
- History corrections: same prefix `-correction-delta.json`.
- Identity lookup: `history-identities.json`.
- Runtime, receipts and profile parity: `live-verification.json`.
- System SDK provenance: `system-sdk-audit.json`.
- Focused/full checks and remaining legacy failures: `validation.md`, `regression.txt`.
- Regenerate a current metadata snapshot: `node D:/dsh-test/tools/usage-audit-snapshot.mjs`.

## Boundaries

- The unit is one root Team plus all descendants, not the root agent alone.
- The user's backend snapshot is 47,672,606,230 total, consisting of
  47,401,706,869 input and 270,899,361 output. Reasoning is not added again.
- Original sessions, cache, spill, telemetry and backups remain untouched.
- Do not restart DSH or interrupt an active Team.
- Keep production Reducer and compaction switches unchanged.
- History fields that were not recorded remain null/unknown.
- Payload byte/character measurements are estimates, not provider tokens.
- Source-version duplicates and fork-inherited history must not be counted twice.

## Work Items

1. Historical request ledger: tools/usage-history-backfill.mjs and history-* outputs.
2. Live observer: profiles/*/plugins/request-usage-ledger.mjs.
3. Independent workspace: workspaces/usage-lab-20261001 and tools/usage-lab.mjs.
4. Syntax, focused tests, regression, profile parity and live HMR checks.

Runtime RPC helper: tools/usage-runtime-rpc.mjs. Credentials are read only for
local authentication and never written into evidence or printed.
