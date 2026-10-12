# Agent Team v12 Implementation Ledger

> 压缩恢复后的第一动作：重新读取本文件与
> `D:/dsh-test/docs/agent-team-v12-architecture-improvement-plan.md`，
> 确认当前阶段、已完成项、未完成项和下一步，然后才继续实施或验收。

## Baseline

- Authorized plan: `D:/dsh-test/docs/agent-team-v12-architecture-improvement-plan.md`
- Backup: `D:/dsh-backups/v12-full-20260924-131555`
- Runtime follow-up backup: `D:/dsh-backups/v12-runtime-fix-20260924-153505`
- Live web entry before migration: `team-tools-v2-r10.mjs`
- Live shared control plane before migration: `team-control-plane.mjs`
- Migration rule: new modules and isolated tests first; live config switches only
  after tests pass and existing session compatibility is checked.
- Compatibility rule: old task, Room, wake, lease, evidence and milestone rows
  are migrated or treated as legacy; no active session is reset.

## Stage Status

| Stage | Status | Implementation | Verification |
|---|---|---|---|
| A runtime facts | complete | `team-v12-runtime-facts.mjs` | phase9 runtime facts tests PASS |
| B task contract/state | complete | `team-v12-contract.mjs` | phase9 contract tests PASS |
| C persistence/recovery | complete | `team-v12-persistence.mjs` | phase9 persistence tests PASS |
| D Room cursor/ledger | complete | `team-v12-room-wake.mjs` | 游标/决策 ledger PASS；`required_confirmations` + `team_room_confirm` 已由控制面强制，全部受影响组长确认前保持 `proposed`；真实 PTC 回执见下方 |
| E wake/inbox | complete | `team-v12-room-wake.mjs` | phase9 wake tests PASS |
| F compaction handoff | complete | `team-v12-compaction.mjs` | phase9 compaction tests PASS |
| G evidence/cost | complete | `team-v12-evidence-scheduler.mjs` | 证据登记/审查包 PASS；`verification_plan` 按任务类型选择 recipe，并绑定 revision、recipe fingerprint、exact SHA/tree 后才允许复用 |
| H ready queue/stall | complete | `team-v12-evidence-scheduler.mjs` | ready queue/stall/cost PASS；`scheduler_advice` 提供 fan-out 收益检查、历史工时中位数、置信度、关键路径和 shadow 自适应并发建议 |
| I integration transaction | complete | `team-v12-integration.mjs` | phase9 integration tests PASS |
| J context pack | complete | `team-v12-context.mjs` | phase9 context tests PASS |
| K capability matrix | complete | `team-v12-observability.mjs` | phase9 capability tests PASS |
| L replay fixtures | complete | `team-v12-replay.mjs` | phase9 replay tests PASS |
| M correlation timeline | complete | `team-v12-observability.mjs` | phase9 timeline tests PASS |

## Integration Checklist

- [x] Merge all phase9 modules into web and headless profile copies.
- [x] Add tool-layer registration for contract, ready queue, inbox, context pack,
      evidence query, merge operation, runtime facts, capability matrix and timeline.
- [x] Extend control-plane migration and persisted fields without breaking old rows.
- [x] Replace milestone compaction arming with the v12 compaction state machine.
- [x] Add the post-compaction recovery instruction to the active compaction plugin.
- [x] Switch web/headless configs atomically after tests pass.
- [x] Run phase1-phase9 tests.
- [x] Run isolated headless and web smoke tests.
- [x] Verify isolated plugin entry hashes and runtime/disk path consistency.
- [x] Activate v12 in the current long-running PID 5232 process. User verified
      `team_v12` is callable and the runtime/disk hash matched.
- [x] Record final hashes and rollback command here.

## 2026-09-25 D/G/H 完成与真实验收

- D：`team_room_decide` 支持 `required_confirmations`；首个确认后仍为 `proposed`，全部确认后才变为 `confirmed`。`team_room_confirm` 和 `team_v12(action:"room_confirm_decision")` 均可调用。单确认人兼容路径也已修复，`confirmed` 时不会残留 stale `missingConfirmations`。
- G：新增 `verification_plan`、`selectVerificationRecipe`、`buildVerificationPlan`、`recipeFingerprint`、`reuseEvidenceForPlan`。覆盖 API/state machine、persistence/migration、UI/visual、build/integration、generic fallback；复用必须匹配 task revision、recipe fingerprint、exact SHA/tree。
- H：新增 `scheduler_advice`、`estimateTaskEffort`、`checkFanOut`、`buildSchedulerAdvice`。默认 `mode:"shadow"`、`applyAllowed:false`，包含 fan-out 独立性/验收/owner/scope 冲突检查、历史工时与 confidence、critical path 和稳定并发建议。
- 真实 PTC（`session-3c2ec04c-5d59-46a5-8952-3a5c177210e9`）：`scheduler_advice` 返回非空 fan-out 与 high confidence；两组均返回 verification plan；`level:1` 跨组 decision 经 `lead-alpha`/`lead-beta` 两次确认后才生效。
- 真实 reconcile 复验：`group-root-t1` 是无 commit、仅 evidence 的 discussion 任务，成功被 `team_task_reconcile` 引用到 global `task-4`；目标返回 `completed`、`commitSha:null`，并写入 linkage evidence。
- 失败恢复：旧 `wake:continuation:task-3:r5:lead:a1` 保留为历史 `delivery-failed`，但 `team_delivery_check` 返回 `deliverable:true`、`blockers:[]`；已完成任务或已被后续尝试替代的旧失败不再阻塞交付。
- 最终回归：`D:\dsh-test\output\v14-final-regression-20260925-2137.log`，181 tests / 180 pass / 1 skip / 0 fail。
- 最终 web/headless 同哈希：`team-v12-room-wake.mjs B6B81F39…`、`team-v12-evidence-scheduler.mjs 914987F4…`、`team-v12-runtime.mjs 5189B927…`、`team-tools-v2-r10.mjs 1B216492…`、`team-control-plane.mjs 528861DA…`。

## Verification Commands

```powershell
$env:NODE_OPTIONS='--import=file:///D:/dsh-test/test-runtime-resolver.mjs'
node --test D:/dsh-test/phase1-tests/*.test.mjs D:/dsh-test/phase2-tests/*.test.mjs D:/dsh-test/phase3-tests/*.test.mjs D:/dsh-test/phase4-tests/*.test.mjs D:/dsh-test/phase5-tests/*.test.mjs D:/dsh-test/phase6-tests/*.test.mjs D:/dsh-test/phase7-tests/*.test.mjs D:/dsh-test/phase8-tests/*.test.mjs D:/dsh-test/phase9-tests/*.test.mjs
node --test D:/dsh-test/phase9-tests/v12-runtime-authorization-context.test.mjs
```

Pre-fix full regression: `92 passed, 0 failed`. Focused v12 regression:
`12 passed, 0 failed`. Post-fix phase9 regression: `46 passed, 0 failed`.
Runtime authorization/default-action regression: `6 passed, 0 failed`.
Syntax checks passed for all v12 modules.

## Final Runtime Evidence

- DSH version: `0.1.7-rc.1`.
- Isolated headless smoke: `team_v12` callable, plugins `130`, pre-fix runtime
  hash `2293b696`.
- Isolated web smoke: plugins `242`, pre-fix runtime hash `2293b696`; runtime and disk
  paths matched. The temporary instance was closed.
- Active web process: PID `5232`, port `40123`. User restarted it and verified
  `team_v12` is callable, runtime facts are complete, and runtime/disk hashes
  match.
- Post-fix HMR verification: omitted `action` returns compact runtime facts;
  `capability_matrix` returns 23 non-empty rows for the current profile;
  `control_status` returns `source: disk`, `read.ok: true`, `read.code: valid`;
  runtime and disk hashes both equal `7c92aeca...`; room-wake copies both equal
  `086efe34...`.
- `session-7a601594-66f6-4255-92ba-1ef6813cbf1a.json` was previously reported
  as NUL-corrupt, but the latest read-only check found a well-formed JSON state.
  Do not modify it unless a future corruption check proves a concrete defect.

## 2026-09-24 Runtime Follow-Up Fixes

The first post-activation verification found three differences:

1. `team_v12` required an explicit `action`. This was intentional schema
   behavior, but the tool now accepts omission and defaults to compact
   `runtime_facts`, matching the documented default behavior.
2. `capability_matrix` returned empty when called without an input. It now
   collects current runtime facts and returns the current profile's declared
   and callable v12 capability rows; explicit `input.profiles` remains supported.
3. `control_status` passed its `{file, fallback, now}` response envelope into
   the state validator, producing a false `corrupt` verdict. It now reads and
   validates the actual control-plane file, reports `source: disk|fallback`,
   and omits the full state document from the response.

4. `inbox_ack` now requires an explicit top-level `wake_id`. Missing IDs return
   `wake-id-required`, `input.all` returns `bulk-ack-unsupported`, unknown IDs
   list the visible available wake IDs, and re-acknowledging a handled wake is
   idempotent.

The same `inbox_list -> exact top-level wake_id -> inbox_ack` rule was added to
`AGENTS.md`, `team-roles/AGENTS.md`, `lead.md`, `member.md`, `verifier.md`, and
the v12 runtime system-policy text so existing and newly spawned agents see it.

The fix was applied identically to web and headless runtime copies. The active
process was rechecked after HMR and now reports the new runtime hash below; no
restart is required for this follow-up fix.

Final entry hashes:

```text
team-v12-runtime.mjs (web) = adca7da0806a74d908637a8629b573ea83ec42557518b3e1b1529b2869c191ac
team-v12-runtime.mjs (headless) = 30aa872abfe09e158a00c787670bd151a7bc585caeea45bd86aa6381c7f3e9c4
team-v12-runtime-facts.mjs = d3aa83bce8995c498c4d57ab0d044e627cdd7f46cdb2082a0eb11660c2b31cbf
team-v12-room-wake.mjs = 086efe34fb8a13d9db56f3de1079da189be426e122c685af35d650f70d4c2427
team-v12-compaction.mjs = e64aac5dabc752ae3ad57ddb5aeaceb24653e84620c0ce53a376c0b94ab13d32
team-v12-context.mjs = bee6fb062df8adfd5eb95a6bcca2a62f8ed5969b2148722ed512a0386dd429a2
team-v12-contract.mjs = 15f9ed9bf61de0dd9c7665cdc8f4e3322b8c1703d40a81ab319c759ae31559e8
team-v12-evidence-scheduler.mjs = 65f25c3829257bb8c43ee172b4a8cdd00bc56aa46e7213c02acbb372062df1c4
team-v12-integration.mjs = caa8254c4a336da3b26feb9fee1a20723c64abaecc4a715824d6acbcf8efb787
team-v12-observability.mjs = 0d6a4ac11247572aac9970c7e466c534c024c499fbb0e4256c6d639b325b3d5a
team-v12-persistence.mjs = eef3b63e9507daffdefc5495196f001c6df2452ed2c906afb4e6bc33cb533a1e
team-v12-replay.mjs = 1b4e07718ee9f3411578e0e7f475292bcc93f792f220c7e4b987a07b122387b5
```

## 2026-09-24 Control-Plane Recovery Fixes

This follow-up addresses the live defects reported after the v12 activation.
All changes were applied to both web and headless where the module exists.

- `TASK_VIEW_SCHEMA` now declares `contract`, `contractDigest`, `lifecycle`
  and `updatedAt`, so task reads and writes no longer report a false
  `invalid output` after the mutation has already committed.
- `write-scopes.json` grants the tier-0 Team identity `lead` write access to
  `reports/` only; the default remains fail-closed.
- Room recovery: tier 0 can replace a frozen host with
  `team_room_open(host, replace_host:true)`, or force-close a round only when
  every missing speaker is frozen. Forced closes persist `waivedMembers`,
  `forceClosedBy`, `forceCloseReason` and `forceClosedAt`.
- Global edit-card recovery: tier 0 can use
  `team_task_update(action:"complete", force_complete:true,
  force_complete_reason:"...", commit_sha, evidence_ids)` when the owner is
  inactive and no active lease exists. Evidence and commit validation still
  apply.
- Plan handling: approval is idempotent, group leads can read plans for their
  own group, and plans are rejected for `discussion` / `review` tasks.
- Lease handling: release/heartbeat can resolve the caller's single active
  lease when `run_id` is omitted; multiple active leases return
  `lease-ambiguous`.
- Merge handling: phase preflight to `integration-ready` runs before the Git
  merge, preventing the previous half-complete state where the branch merged
  and the phase update then failed.
- Group lead replacement: message/visibility/interrupt scope follows the stable
  group membership, so a replacement lead can manage the same tier-2 members.
- Unowned claim: a contract with no owner accepts the exact claiming member as
  the owner at the ready gate instead of deadlocking on `owner-required`.
- Evidence errors now list the evidence IDs already recorded for the task.

The role files `AGENTS.md`, `team-roles/AGENTS.md`, `lead.md`, `member.md` and
`verifier.md` were updated with these hard controls.

Focused regression:

```text
node --test D:/dsh-test/phase9-tests/*.test.mjs
48 passed, 0 failed
```

Full phase1-phase9 regression after the fixes:

```text
95 passed, 0 failed
```

Current entry hashes:

```text
team-tools-v2-r10.mjs = 9dabc7c2a76dc07c96649aee9b3b1723acf7e852dd2fefb8dcc957ac25d4f3fb
team-tools-v2.mjs = 629c634679290248816b913b4d900c6919a0ef130d115402a29b96db9a9b5e75
team-control-plane.mjs = 28c0a68649720185a88877479ba22b2f703b499d5e30b652f24de51ba3b8b8c8
team-v12-runtime.mjs (web) = adca7da0806a74d908637a8629b573ea83ec42557518b3e1b1529b2869c191ac
team-v12-runtime.mjs (headless) = 30aa872abfe09e158a00c787670bd151a7bc585caeea45bd86aa6381c7f3e9c4
team-v12-contract.mjs = 346e69c8c9d82d9cbc691810b699dbc3cc5343d1d01b09db3196a9e96d57ca92
team-policy.mjs = aa881afed667c0cfa141cd07216db7e64a8b4b4cf86652b0f57d4e04b755cbf4
```

Backup:

```text
D:/dsh-backups/v12-control-plane-fix-20260924-194248
```

## 2026-09-24 Context Pack Pruning Hotfix

Root cause of the oversized root session: ten `[team v12 context pack]`
messages had accumulated in one live transcript. Each pack was roughly
127k-160k characters. The packs were full wake snapshots, so every wake cycle
added another copy instead of replacing the previous one.

Changes:

- The runtime context-pack budget is capped at `32000` tokens.
- Task and inbox sources are optional, so one large source cannot block the
  whole pack.
- Before injecting a new pack, `pruneHistoricalContextPacks(stepped, 0)`
  replaces all older packs with short placeholders. The current pack is then
  injected as the only full snapshot.
- The offline repair replaced nine old packs and four old tool results in the
  root session. Character count dropped from `1286311` to `1723`; the latest
  pack and the most recent 15 tool results were retained.

Backup:

```text
D:/dsh-backups/context-prune-offline-20260924-201114
```

## Post-Compaction Checklist

1. Re-read this ledger and the v12 architecture plan before continuing.
2. Confirm all A-M stages are complete and that no implementation step was lost.
3. Check whether the active DSH process has been restarted normally and exposes
   `team_v12`; do not infer activation from disk files alone.
4. Preserve active control-plane, Room, milestone, freeze and user history state.
5. Continue only from the remaining deployment item or a newly reported defect.

## Rollback

Restore the files listed in the backup directory above, then reload or restart
DSH. Do not delete live control-plane or milestone state during rollback.

## 2026-09-26 Performance Patch Pending Restart

The live process (`PID 35728`) remained up. Two core performance fixes were
written as persistent pnpm patches but were not claimed as active in the
running process:

- `dsh-session-persistence-jsonl@0.1.7-rc.2`: short-lived artifact-list cache,
  concurrent listing coalescing, and local-write invalidation. This targets the
  repeated 430-directory / 128-log scan behind `/api/session/list`.
- `dsh-experimental-agent-team@0.1.7-rc.2`: skip `Session.flush` when a target
  receipt is already recorded, then only append the durable delivered edge.

Exact patch hashes and measurements are recorded in
`D:/dsh-test/docs/agent-team-performance-hotfix-20260926.md`, section
“第六轮持久补丁”.

Verification completed without restart:

- artifact cache probe: one scan for concurrent + sequential cache hits, one
  scan after explicit invalidation;
- `node --check` for the patched core/package files;
- full phase11 regression: `87 tests / 86 pass / 1 skip / 0 fail`, including
  two new session artifact cache tests.

Deployment boundary: these patches require the next controlled DSH restart to
load. Do not report them as active in the current process.

## 2026-09-26 Runtime Performance Hotfix

After the persistent patches were written, the live process was further
optimized without restart:

- `team-tools-v2-r10.mjs` now uses bounded direct steer for live
  `team_wake`, `team_wake_superior` and `team_escalate` targets, falling back
  to the durable mailbox only when the target is not live.
- `team-control-plane.mjs` now reuses audit append handles and coalesces
  snapshots for up to 1000 ms instead of 250 ms.
- The pending persistence patch was tightened: ordinary `persistBatch`
  appends no longer invalidate the artifact-list cache; only materialization,
  header persistence and repair do.

Live HMR confirmed:

```text
[team-control-plane] HMR perf14 loaded
[team-tools-v2-r10] HMR perf14 loaded
```

Full phase11 regression:

```text
87 tests / 86 pass / 1 skip / 0 fail
```

Current live hashes:

```text
team-tools-v2-r10.mjs = E559F8BDB423FEBB8DF57A5D3C9353D7E3747030DDBB960BF511652A2AC57CFE
team-control-plane.mjs = 83901717AD2A238084305935570332B455D2E8F10D9E18CCBB1F054098308341
```

The persistence cache change still requires the next controlled restart; it
is not active in PID 35728.

## 2026-09-26 Live Continuation / Policy Hotfix

The live process was profiled again after the perf14 runtime patches. The
remaining dominant costs were not network or HTTP:

- continuation rebuilt the full ready queue once per candidate;
- `team-tools-v2-r10` rebuilt the Team policy registry on nearly every
  `record()` call;
- `counters()`, `health()` and `providerState()` cloned the full ~9 MB control
  plane to return a tiny projection.

Applied without restart:

- `team-v12-evidence-scheduler.mjs` now exposes
  `createReadyQueueContext()` and `evaluateReadyTask()`; `buildReadyQueue()`
  preserves its previous output and supports `{ digest:false }`.
- `team-v14-event-continuation.mjs` builds one queue context per scan and uses
  a local status/running override for idle-resume candidates.
- `team-policy.mjs` caches the stable Team membership id per live agent object.
- `team-tools-v2-r10.mjs` caches the policy projection for 500 ms inside each
  tool-plugin instance.
- `team-control-plane.mjs` reads `counters`, `health` and `providerState`
  with `clone:false` and only clones the small returned projection.

Measured live-state continuation:

```text
before: 470-521 ms
after:  2.7-5.2 ms
```

Twenty-second process sample:

```text
before: average 181.2% CPU, working set ~8.0 GB
after:  average  45.1% CPU, working set ~6.1 GB
```

Five-second CPU profile:

```text
before: foldSubagentDescriptor ~1.69 s; structuredClone ~1.25 s
after:  structuredClone ~31.5 ms; foldSubagentDescriptor no longer a top frame
```

Regression:

```text
phase11: 87 tests / 86 pass / 1 skip / 0 fail
phase9:  54 tests / 54 pass / 0 fail
```

Current Web/headless hashes:

```text
team-v12-evidence-scheduler.mjs = E96284E26C823AF837F05AC9ECBD33643D8D167BCDBD2ACDC972D37D5823C6C4
team-v14-event-continuation.mjs = B434D086E5EA432906CBB9702AB8F4004FA954A2E5F29DD701E260A48F7DA7AD
team-control-plane.mjs = 5DA7578019AA448CCE95F11593C2F5C14C0665E2B855C751522A8C3E465300E7
team-policy.mjs = A9A5A9A6775155EBDA177C3348F04318AC35FC5B1D7B8D4B1F92AFD4DD6F4CF4
team-tools-v2-r10.mjs = A5E6AF812F8FA0F8A27D58F672EDF40D5EF1490E740B4603081E34BF9F03676C
```

Backups:

```text
D:/dsh-backups/perf-continuation-20260926-080901
D:/dsh-backups/perf-policy-20260926-081749
```

Deployment boundary: these runtime fixes are live in PID 35728. The core
session-persistence artifact-list cache remains pending the next controlled
restart.

## 2026-09-26 perf16 Clone-Free Hot Mutation

The live profile after the continuation/policy fix showed the deferred
control-plane commit path still copying the complete ~10 MB hot state before
every Room/wake mutation. All `structuredClone` frames were about 20.6% of a
five-second sample; the hottest single call site was about 8.4%.

Applied without restart:

- Web/headless `team-control-plane.mjs` deferred commit now loads with
  `clone:false`; the mutation queue and cross-process file lock remain the
  transaction boundary.
- HMR confirmed:
  `[team-control-plane] HMR perf16 clone-free loaded 2026-09-26T08:49+08:00`.
- Web/headless hash:
  `3F7A9081C66692065BEE617E3966E45E0E45649E86094D6417360CA6878AB5EE`.

Benchmark on a synthetic 10 MB control-plane state:

```text
120 room/wake mutations: commitMs=672.9, flushMs=47.7
revision=121, hot file=10,534,127 bytes
```

Regression:

```text
phase11: 87 tests / 86 pass / 1 skip / 0 fail
phase9:  54 tests / 54 pass / 0 fail
```

Deployment boundary: `PID 35728` was not restarted. The session-list
persistence cache patch still requires the next controlled restart.
