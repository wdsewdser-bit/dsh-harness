# Agent Team v14 Runtime Defect Register

Status: implemented and verified 2026-09-27; live DSH was not running during final verification.

Date: 2026-09-27

Scope:

- Root session: `D:\dsh-test\home\sessions\--D-dsh-test-workspaces-mc189-rs--\session-7a601594-66f6-4255-92ba-1ef6813cbf1a\session.v4.jsonl.zstd`
- Runtime profile: `D:\dsh-test\home\profiles\desktop`
- Control-plane state: `D:\dsh-test\home\team-control-plane\session-7a601594-66f6-4255-92ba-1ef6813cbf1a.json`

## Current Runtime Facts

- DSH desktop host is still running. The host Node process was observed at about 1.69 GiB working set.
- Root session last wrote at `2026-09-26 23:51:44`.
- Root turn 1119 failed before producing an assistant result:
  - `403 upstream: request illegal`
  - provider display text: content did not pass safety review.
- Root turn 1120 was aborted by the user.
- Control-plane totals:
  - 468 tasks
  - 390 completed
  - 63 active
  - 0 active leases
  - 89 open waiting tickets
  - 55 open approval waits
  - 52 of those approval waits already have `plan-approved`
  - `v12ReadyQueue.ready = []`
- Additional second-pass facts:
  - 20 Room rounds remain open; 17 are fully spoken and only awaiting host close.
  - The oldest awaiting-close round has been open for about 51.2 hours.
  - 209 dispatch rows exist: 200 completed and 9 terminal `timed-out` rows.
  - 24 tasks are `in_progress`; 11 have neither an active lease nor an open waiting ticket.

## Round 2 Addendum

This addendum records the second read-only pass completed after the original register.
It corrects stale findings where the runtime has already changed, adds the persistence
and compaction findings that were not in the first pass, and distinguishes intentional
behavior from defects.

### Verified Already Fixed Or No Longer Reproducible

These were real earlier problems but are not current defects in the inspected runtime:

- Frozen members no longer consume quota.
  - `D:\dsh-test\home\profiles\desktop\plugins\team-policy.mjs:82`
    now defaults to `maxTier1Leads: 8`, `maxMembersPerLead: 8`, `maxMembers: 30`.
  - `team-policy.mjs:284-287` excludes frozen and failed members from the global count.
  - `team-policy.mjs:295-320` excludes frozen and failed members from verifier,
    tier-1, and per-group counts.
- A tier-1 lead may now interrupt its own children.
  - `team-policy.mjs:268-273` permits tier 0 to interrupt anyone and permits a
    tier-1 lead to interrupt members it owns.
- The task-view schema now declares the fields that previously caused invalid output.
  - `D:\dsh-test\home\profiles\desktop\plugins\team-tools-v2-r10.mjs:206-208`
    declares `contractDigest`, `contract`, `lifecycle`, and `updatedAt`.
- The idle-watch lifetime cap is gone.
  - `D:\dsh-test\home\profiles\desktop\cordis.patch.yml:366-367` uses
    `settleMs: 30000` and `bootstrapScanMs: 30000` with an explicit no-lifetime-cap comment.
- Current snapshot path and wait counts were re-read using the correct nested path
  `v14Waiting.tickets`.
  - Revision `116678`.
  - 468 tasks.
  - 202 waiting tickets total; 89 open.
  - 55 open approval waits; 52 already have a `plan-approved` record.
  - 20 open Room rounds; 17 fully spoken and only awaiting host close.
  - 209 dispatch rows; 9 terminal `timed-out`.
  - 28 `in_progress` tasks; 0 active leases; 15 have neither a lease nor an open wait.
  - Ready queue remains `[]`.

### P1-8: Control-Plane Persistence Has Unbounded Orphan, Temp, And Audit Growth

This is the largest newly verified operational defect. It is currently consuming
several gigabytes and grows without a garbage-collection path.

Evidence:

- The control-plane directory currently contains:
  - 46,151 files, about 8.0 GiB total.
  - 44,985 `.cold-<sha256>.json` files, about 7.11 GiB.
  - 959 temp files matching `.tmp-<pid>-...`, about 669.42 MiB.
  - 86 `.audit.jsonl` files, about 157.46 MiB.
  - 103 current/old snapshot-like JSON files, about 37.38 MiB excluding cold/temp/audit.
- A global reachability check across every parseable snapshot found:
  - 28,031 referenced cold digests.
  - 24,767 cold files still referenced, about 64.61 MiB.
  - 20,218 cold files referenced by no existing snapshot, about 7,220.49 MiB.
- The largest orphaned cold files are about 30-32 MiB each and were written on
  2026-09-25. This is consistent with repeated full-room or transcript snapshots.
- `D:\dsh-test\home\profiles\desktop\plugins\team-control-plane.mjs:1063-1075`
  writes cold files content-addressed and returns an existing digest, but never
  removes an obsolete cold file.
- `team-control-plane.mjs:898-945` archives pruned rows into more cold chunks.
  It does not delete older chunks that are no longer reachable.
- `team-control-plane.mjs:1278-1306` writes the full room message array and full
  transcript arrays whenever history is hydrated. As a room grows, each full
  snapshot can create another multi-megabyte content-addressed file while the
  previous revision becomes orphaned.
- Temp files have no startup or periodic cleanup:
  - `team-control-plane.mjs:1377-1388` uses a synchronous temp-write plus rename
    for the main snapshot, with no `unlink` fallback.
  - `team-control-plane.mjs:1393-1404` unlinks the temp only when the async rename
    itself fails.
  - `team-control-plane.mjs:1071-1073` writes cold files through a temp path and
    has no failure cleanup.
  - The oldest temp file is from 2026-09-19; the newest is from 2026-09-26.
  - 902 temp files are zero bytes; the largest are 61.21 MiB, 12.27 MiB, and
    12.26 MiB. Multiple historical PIDs are represented, which confirms they
    survive process exit.
- Audit logs have no rotation or retention:
  - `team-control-plane.mjs:1411-1432` appends forever through a cached handle.
  - `team-control-plane.mjs:3068-3079` clears cache maps on reset but does not
    close audit handles or prune audit files.

Impact:

- Disk usage grows without a bound even when no new semantic history is retained.
- Startup, backup, antivirus, and directory traversal costs increase with every
  obsolete chunk.
- A future disk-full condition can reproduce the earlier session/compression
  failures without any new logical task volume.
- The current D: volume still has about 176.31 GiB free, so this is not an
  immediate outage, but it is a clear leak rather than harmless cache.

Required fix direction:

- Add a mark-and-sweep or generational cold-store GC:
  - mark all digests reachable from retained snapshots, manifests, and audit
    recovery metadata;
  - delete only unreachable cold files older than a safety grace period;
  - emit before/after counts and bytes to health output.
- Stop writing full room/transcript arrays on every history-hydrated snapshot.
  Use append-only history refs and periodic compaction instead.
- Clean `.tmp-<pid>-*` files on startup and after successful writes.
- Add audit rotation and retention by size or age, and close cached handles on
  plugin disposal.
- Expose `coldFiles`, `coldBytes`, `orphanBytes`, `tempFiles`, `tempBytes`,
  `auditBytes`, and oldest age in health output.

Acceptance:

- A repeated save of an unchanged or append-only room does not create a new
  full-history cold file.
- No unreachable cold file older than the configured grace period remains after
  GC.
- No temp file survives a clean process restart.
- Audit size is bounded by rotation policy.
- Health output can show the current retention and reclaimable bytes.

### P2-4: Compaction Documentation Contradicts The Actual Pressure Trigger

The reported “I did not call set/done, but it still compacted” symptom is
explained by the current runtime. The behavior is intentional in one path and
contradicted by another comment, so the system gives operators and agents
conflicting expectations.

Evidence:

- `D:\dsh-test\home\profiles\desktop\plugins\step-compaction-v4.mjs:13-15`
  says context pressure “never compacts without an armed milestone.”
- `D:\dsh-test\home\profiles\desktop\cordis.patch.yml:337-338` says
  `autoCompactRatio: 0.75` means an idle agent auto-folds even without a
  milestone tick.
- `D:\dsh-test\home\profiles\desktop\plugins\team-milestone-v2.mjs:270-279`
  returns `{ reason: 'pressure' }` when the ratio is at or above the threshold.
- `step-compaction-v4.mjs:476-522` treats that pressure verdict as a valid
  compaction request and calls `foldNow(... 'pressure' ...)`.

Impact:

- An agent can compact without any visible `team_milestone(set|done)` call.
- The compaction reason is not consistently exposed in the normal operator
  surface, so it looks like an unexplained context reset.
- The source comment and config comment disagree, making future fixes and
  acceptance tests ambiguous.

Required fix direction:

- Choose one policy explicitly:
  - milestone-only: remove the pressure auto-fold from the idle path and keep
    pressure only as a fail-closed pre-step guard; or
  - pressure-assisted: keep the 0.75 auto-fold and update all comments,
    prompts, status output, and acceptance tests to say so.
- Include `trigger: milestone|pressure|economic` and the measured ratio in
  compaction status, logs, and the post-compaction resume notice.
- Add a visible operator explanation when a pressure fold fires without a
  milestone.

Acceptance:

- Source comments, configuration comments, runtime behavior, and status output
  all describe the same trigger policy.
- An operator can distinguish milestone compaction from pressure compaction
  without reading the session journal.
- A pressure fold cannot be mistaken for a milestone tick.

### P2-5: Profile Drift Includes The Idle Watch

The original profile-drift finding remains valid and is broader than the first
report.

Current hashes:

- `team-tools-v2-r10.mjs`
  - desktop/web: `F60AD6BE42940E17`
  - headless: `388D12FE0F474ADB`
- `write-scope-guard.mjs`
  - desktop/web: `B385E0CA9DE67E03`
  - headless: `9616D20E6D7F30C1`
- `team-idle-watch-v6.mjs`
  - desktop/web: `F5D02277F7A0FEB3`
  - headless: `82649AF4856E0240`

Other checked shared plugins, including `team-v12-runtime.mjs`,
`team-control-plane.mjs`, and `step-compaction-v4.mjs`, currently match across
all three profiles. The drift is therefore selective and easy to miss.

Required fix direction:

- Treat any shared plugin mismatch as a deployment-health failure.
- Compare hashes, sizes, exports, and semantic markers.
- Install profile copies from one canonical source, or generate them from one
  source tree.

Acceptance:

- Every shared plugin has the same hash in desktop, web, and headless.
- A partial deployment fails health before agents can use the drifted profile.

### P2-6: Wake Aliases Are Still Undocumented In Role Files

The compatibility tools exist, and the runtime prompt explains their aliases,
but the role files still do not name them.

Evidence:

- `D:\dsh-test\home\profiles\desktop\plugins\team-tools-v2-r10.mjs:2572-2650`
  defines `team_wake` and `team_wake_superior` as compatibility aliases for
  `send_message(delivery:"action")` and `send_message(delivery:"decision")`.
- The runtime policy string at `team-v12-runtime.mjs:135` says the aliases remain
  compatibility paths.
- `D:\dsh-test\home\team-roles\AGENTS.md`, `lead.md`, `member.md`, and
  `verifier.md` teach `send_message` delivery modes but do not name either
  alias.

Impact:

- A member that searches its role file for a “wake” instruction can conclude
  that no wake tool exists.
- This is a documentation gap rather than a missing runtime capability, but it
  keeps the user-visible behavior inconsistent.

Required fix direction:

- Add one compact decision table to the shared role instructions:
  - quiet record: `send_message(delivery:"info")`;
  - immediate peer/downward work: `send_message(delivery:"action")` or
    `team_wake`;
  - blocked upward decision: `send_message(delivery:"decision")` or
    `team_wake_superior`.
- State explicitly that queued means durable delivery and must not be resent.

Acceptance:

- Every role can name the supported wake path.
- A stopped owner receives a wake when an actionable message is sent.

### P1-9: Mutations Await Full Snapshot Rewrites

This is a performance defect distinct from the storage leak. It explains why a
message or room transition can become slow even when the logical operation is
small.

Evidence:

- The main control-plane snapshot is 25.39 MiB and its panel cache is 6.96 MiB.
- `D:\dsh-test\home\profiles\desktop\plugins\team-control-plane.mjs:1730-1733`
  awaits `persistControlPlaneSnapshotAsync(...)` as part of the mutation.
- `team-control-plane.mjs:1390-1408` serializes the full `hot` object with
  `JSON.stringify`, writes a full temp file, renames it, and may then write a
  full panel-cache file.
- `team-control-plane.mjs:1698-1701` can switch a history-auto mutation to
  hydrated history and reload the full history before applying the mutation.
- `team-control-plane.mjs:1595-1612` serializes writes through one promise chain
  and a file lock, so a slow write delays later mutations.

Impact:

- A small wake, room append, or task mutation can pay for a multi-megabyte
  snapshot rewrite.
- Bursts of team messages can queue behind disk I/O and appear as tool timeouts.
- The cost grows with total task and history size even when the current mutation
  touches one row.
- `mutateHot` avoids some of this cost, but not every mutation path uses it.

Required fix direction:

- Introduce an append-only mutation journal or WAL for hot state.
- Make normal mutations append a bounded delta and return without rewriting the
  full snapshot.
- Checkpoint the full snapshot periodically or when explicitly flushed.
- Keep panel-cache updates independent from the authoritative mutation path.
- Add timing metrics for queue wait, serialization, file write, rename, and
  panel-cache write.

Acceptance:

- A normal wake or room append does not rewrite the full 25+ MiB snapshot.
- Tool latency does not grow linearly with total historical snapshot size.
- The write queue has a bounded p95 delay and exposes its depth in health output.

### P2-7: Policy Header Still Documents The Old 13-Person Cap

The executable quota is already updated, but the source header still describes
the old design.

Evidence:

- `D:\dsh-test\home\profiles\desktop\plugins\team-policy.mjs:12-18` says
  “agreed cap of 13 TEAMMATES”, with 3 group leads and 3 members per group.
- `team-policy.mjs:82` actually returns `maxTier1Leads: 8`,
  `maxMembersPerLead: 8`, and `maxMembers: 30`.
- `D:\dsh-test\home\team-roles\lead.md` correctly documents the 8/8/30 values.

Impact:

- A future maintainer reading only the policy header can reintroduce the old
  quota or write tests against the wrong limit.
- The code and its own design comment disagree, which is especially risky for a
  feature that previously blocked new teams.

Required fix direction:

- Update the header to describe the current configurable 8/8/30 defaults.
- Remove the fixed 13-person arithmetic or label it as historical.
- Add a test that reads the exported registry defaults and asserts the intended
  limits.

Acceptance:

- The policy header, role instructions, runtime defaults, and quota tests all
  agree on the current limits.

## P0-1: Team Context Is Re-injected On Every Step

Evidence:

- `D:\dsh-test\home\profiles\desktop\plugins\team-v12-runtime.mjs:1648`
  - `agent/pre-step` assembles and injects a Team context delta.
- `D:\dsh-test\home\profiles\desktop\plugins\team-v12-runtime.mjs:1727`
  - per-step maximum is `contextPackMaxTokens`, currently 32000.
- `D:\dsh-test\home\profiles\desktop\plugins\team-v12-runtime.mjs:184`
  - source dedupe only inspects the latest 512 derived messages.
- `D:\dsh-test\home\profiles\desktop\plugins\team-v12-runtime.mjs:822`
  - tier 0 receives the whole requirement ledger.

Observed impact:

- Root session contains about 83.4 MB compressed history and 98,331 events.
- 123 `compaction/start` events were observed.
- Turn 1094 had 24 steps and a peak input of 808,080 tokens.
- Turn 1101 had 39 steps, about 1.19M estimated tokens of Team context injection, and 3 compactions.
- Turn 1106 had 39 steps, about 1.16M estimated tokens of Team context injection, and 3 compactions.
- Turn 1110 had 43 steps, about 1.29M estimated tokens of Team context injection, and 2 compactions.
- The first step after the latest compaction still received a 44,432-character context pack.

Root cause:

- A manifest falls out of the 512-message dedupe window during long turns.
- Once it falls out, the same requirement or room content can be treated as new again.
- Full acceptance text is carried in the pack instead of compact IDs plus on-demand lookup.
- Root sees historical and terminal requirements as well as active work.

Required fix direction:

- Store source version cursors durably per member and session.
- Dedupe against durable delivery receipts, not a bounded recent-message scan.
- For tier 0, inject only active, blocking, or decision-relevant requirements.
- Replace full acceptance text with a compact summary and fetch details through a tool.
- Add a per-turn injection budget, for example one full pack per turn plus a small delta.
- Reduce Root's per-step context-pack cap from 32000 to a bounded operational value.

Acceptance:

- A long turn with 30+ steps must not inject the same source twice unless its revision changed.
- Post-compaction context must not immediately exceed the normal idle baseline by tens of thousands of tokens.
- Root must be able to inspect the full requirement ledger explicitly without carrying it in every prompt.

## P0-2: Approval Waits Do Not Auto-Resolve

Evidence:

- `D:\dsh-test\home\profiles\desktop\plugins\team-v14-waiting.mjs:26`
  - `approval` is in `EXPLICIT_ONLY`.
- `D:\dsh-test\home\profiles\desktop\plugins\team-v14-waiting.mjs:93`
  - explicit-only conditions remain open until `waiting_resolve`.
- `D:\dsh-test\home\profiles\desktop\plugins\team-v14-event-continuation.mjs:53`
  - continuation skips a task when any active waiting ticket exists.

Observed impact:

- 55 open approval waits exist.
- 52 of them already have `plan-approved`.
- `v12ReadyQueue.ready` is empty while active tasks and approved plans remain.
- Active examples include:
  - `group-g-core-t95`
  - `group-g-nbt-t88`
  - `group-g-nbt-t89`
  - `group-g-nbt-t90`

Failure sequence:

1. Member waits for plan approval.
2. Lead approves the plan.
3. The approval wait remains open.
4. Continuation sees an active wait and refuses to wake the member.
5. The task stops indefinitely unless a human or tier 0 explicitly resolves the wait.

Required fix direction:

- Auto-resolve an approval wait when the referenced plan reaches `plan-approved`.
- Auto-close waiting tickets for completed, cancelled, expired, deleted, or accepted tasks.
- Treat approval as a machine-checkable condition, not an explicit-only human condition.
- Add a recovery scan that reports stale open waits by age, owner, and responsible member.

Acceptance:

- After `team_plan_approve`, the corresponding approval wait closes automatically.
- Continuation wakes the owner in the next scan without a human message.
- No open approval wait remains for a task whose plan is already approved.

## P0-3: Root Write Scope Is Too Narrow, And `run_code` Bypasses The Guard

Current config:

`D:\dsh-test\home\write-scopes.json`

```json
{"rootDir":"D:\\dsh-test\\workspaces","defaultDeny":true,"bySession":{},"byName":{"lead":["reports"]}}
```

Observed impact:

- Root writes outside `reports` are denied.
- A root attempt to write `D:\dsh-test\HANDOFF-mc189-rs.md` was rejected.
- Root then wrote a file successfully through direct `node:fs` code inside `run_code`.

Why this is two problems:

- The declared scope is too narrow for tier-0 operational work such as handoff documents and downloads.
- The enforcement layer can be bypassed through code execution.

Relevant code:

- `D:\dsh-test\home\profiles\desktop\plugins\write-scope-guard.mjs:338`
  - the tool pre-execute hook only checks `bash` and `pwsh`.
- `D:\dsh-test\home\profiles\desktop\plugins\write-scope-guard.mjs:347`
  - opaque shell writes are denied, but direct file writes from `run_code` are not covered by the same rule.

Network finding:

- Network is not globally blocked.
- A prior Root `Invoke-WebRequest` HEAD request to crates.io returned `HTTP=200`.
- Download failures are therefore more likely caused by the destination write scope, tool timeout, or an unclassified write path.

Required fix direction:

- First close the `run_code` write bypass.
- Give tier 0 an explicit operator scope for operational artifacts, for example:
  - `reports`
  - `docs`
  - `scratch`
  - `tmp`
  - download cache
- Do not grant unrestricted `*` until the bypass is fixed.
- Keep product-code writes behind plan and lease.

Acceptance:

- Root can create handoff and diagnostic documents without using an unsafe bypass.
- Root can download into an allowed cache directory and verify the resulting hash.
- Root cannot write outside the tier-0 scope through `run_code`, shell, or indirect interpreters.

## P0-4: Tier 0 Uses The Tier-1 Lead Identity

Evidence:

- `D:\dsh-test\home\profiles\desktop\plugins\team-v14-context-delivery.mjs:65`
  - role selection uses `lead.md` for every member with `tier <= 1`.
- There is no `root.md`.
- `D:\dsh-test\home\team-roles\lead.md` describes a tier-1 group lead.

Observed impact:

- Root is told it is a group lead even though it is tier 0.
- Root's operational privileges, global recovery duties, and cross-group responsibilities are not represented accurately.
- This contributes to incorrect decisions about what Root may write, wake, merge, or repair.

Required fix direction:

- Add a separate `root.md`.
- Keep `lead.md` for tier-1 group leads only.
- Give Root explicit responsibilities for:
  - global scheduling
  - escalation resolution
  - provider and runtime recovery
  - operational document and artifact writes
  - merge and acceptance coordination
- State clearly which product writes still require a task, plan, and lease.

Acceptance:

- Root receives `root.md`, not `lead.md`.
- A tier-0 identity change is visible through the identity version mechanism.
- Root can explain its own write scope and recovery powers without guessing.

## P1-1: Completion Does Not Require Group Acceptance Or Verifier Review

Evidence:

- `D:\dsh-test\home\profiles\desktop\plugins\team-tools-v2-r10.mjs:4337`
  - `complete` checks plan, lease, commit, and evidence.
- `D:\dsh-test\home\profiles\desktop\plugins\team-tools-v2-r10.mjs:4414`
  - a completed planned task moves to `member-check`.
- `D:\dsh-test\home\profiles\desktop\plugins\team-tools-v2-r10.mjs:3153`
  - `team_acceptance_packet` stores a packet but does not automatically wake the verifier.
- `D:\dsh-test\home\team-roles\verifier.md:9`
  - the verifier starts only after a complete acceptance packet is submitted.

Observed impact:

- Authors can mark tasks complete after self-testing.
- Group acceptance and verifier review happen later, often after repeated work has already accumulated.
- The verifier becomes a late bottleneck instead of a batch gate.
- In the current control-plane snapshot there are 103 `group-acceptance` packets and 87 `verifier-review` packets. 39 group packets do not have an exact verifier packet with the same commit SHA and task-id set. Some may be superseded or intentionally split, but the count is a useful lower-bound signal of review backlog.

Required fix direction:

- On group acceptance packet submission, automatically enqueue one verifier wake for the batch.
- Make the review episode idempotent and tied to task IDs plus exact commit SHA.
- Prevent a batch from advancing to final integration until its verifier episode has a terminal result.
- Keep author evidence necessary but not sufficient.

Acceptance:

- Submitting a group acceptance packet creates exactly one verifier wake.
- A verifier result binds to the same batch and commit SHA.
- The main merge gate can reject a batch whose review episode is missing or stale.

## P1-2: Continuation Is Too Small And Has No Aging Or SLA

Evidence:

- `D:\dsh-test\home\profiles\desktop\plugins\team-v14-event-continuation.mjs:163`
  - default `maxPerScan` is 4.
- `D:\dsh-test\home\profiles\desktop\plugins\team-v14-event-continuation.mjs:193`
  - one scan processes at most 4 candidates.
- `D:\dsh-test\home\profiles\desktop\plugins\team-v14-event-continuation.mjs:217`
  - completion summaries are sent to the parent lead.
- `D:\dsh-test\home\team-roles\AGENTS.md:14`
  - scheduler advice is explicitly shadow and does not replace owner, plan, scope, or lease gates.

Observed impact:

- A large backlog can wait many scans while only four candidates are handled.
- There is no visible priority aging rule for old blocked work.
- There is no review SLA or escalation after a verifier wait exceeds a threshold.
- A stalled owner can remain inactive while the queue contains actionable work.

Required fix direction:

- Add queue aging and priority classes.
- Increase or dynamically size `maxPerScan` when the ready queue is non-empty.
- Add review SLA escalation for verifier waits.
- Add lease-loss and owner-inactive recovery with an auditable reassign or wake decision.
- Make scheduler output actionable, not only advisory, for approved tasks.

Acceptance:

- Every runnable approved task has a current owner wake or a recorded terminal reason.
- A task cannot remain in `in_progress` with no active lease and no open wait indefinitely.
- Verifier waits produce an escalation after a configured threshold.

## P1-3: Waiting State Accumulates Stale And Duplicate Tickets

Evidence:

- 89 open waiting tickets were present in the latest control-plane snapshot.
- Many tickets refer to tasks that are already `completed` or `integrated`.
- Some tasks have multiple open tickets for the same approval or responsibility transition.

Observed impact:

- `waiting_list` becomes noisy.
- Continuation can be blocked by a ticket that no longer represents real work.
- Root spends context and tool calls filtering stale bookkeeping.

Required fix direction:

- Auto-close tickets when their task reaches a terminal state.
- Deduplicate tickets by task, owner, condition type, and responsible member.
- Keep a compact history entry after closing.
- Expose stale ticket counts in health output.

Acceptance:

- A completed task has zero open waiting tickets.
- Repeated approval records for one task collapse into one current ticket.
- The waiting list is a current responsibility view, not an append-only backlog.

## P1-4: Root Session Ended On A Provider Safety Refusal

Evidence:

- Turn 1119 requested a model response after compaction.
- The provider returned:
  - `403`
  - `upstream: request illegal`
  - safety review failed.
- Turn 1120 was aborted by the user.

Interpretation:

- This is a provider-side refusal observed in the current session.
- It is not proof by itself that the context-pack defect caused the refusal.
- It does block verification of the compaction fix until the request can pass again.

Required investigation:

- Capture the exact request size, context-pack contents, and provider response.
- Compare a minimal retry with and without the latest Team context pack.
- Add a bounded fallback pack if the provider rejects the full context payload.

Acceptance:

- Root can resume a normal turn after compaction.
- A provider refusal is recorded with request size and context-pack receipt.
- The system does not silently leave Root idle after a failed post-compaction step.

## P0-5: Room Rounds Stay Open After Every Speaker Has Finished

Evidence:

- Current control-plane snapshot: 20 rounds are still `open`.
- 17 of those 20 rounds have `nextSpeaker = null` and every member in `order` already present in `mainSpoken`.
- The oldest such round has been open for about 51.2 hours.
- `D:\dsh-test\home\profiles\desktop\plugins\team-tools-v2-r10.mjs:2180`
  - after the final main speech, the runtime only attempts one host-close wake.
- `D:\dsh-test\home\profiles\desktop\plugins\team-tools-v2-r10.mjs:2250`
  - `team_room_timeout_recover` refuses when `nextSpeaker` is empty with `round-speaker: room round is awaiting host close, not a speaker recovery`.
- `D:\dsh-test\home\profiles\desktop\plugins\team-control-plane.mjs:2081`
  - `room.currentRoundId` is cleared only when the host actually closes the round.

Observed impact:

- A room cannot start another round while its previous round remains open.
- Group-room round budgets are consumed by rounds that are logically finished but never closed.
- When the host is inactive, frozen, or its close wake is lost, there is no bounded recovery path for the `awaiting-close` state.
- Tier 0 is forced to create replacement task rooms, increasing room sprawl and coordination cost.

Required fix direction:

- Treat `awaiting-close` as a first-class durable responsibility, not as an untracked prompt.
- Add a close deadline and automatic host wake/re-wake while the round is open and all speakers are done.
- Let `team_room_timeout_recover` handle `awaiting-close`: wake the host, replace the host, or force-close after a bounded grace period.
- When `replace_host` changes an active round's host, migrate the close responsibility and do not leave the old host in the required speaker set unless it is a real participant.
- Record a room-close evidence row with host, deadline, recovery action, and final summary.

Acceptance:

- No round remains open with all speakers complete beyond the configured close grace period.
- A frozen or inactive host cannot permanently block a room.
- A replaced host can close the existing round or be explicitly waived with an audit reason.

## P0-6: Scheduler Treats Every `in_progress` Task As Actively Running

Evidence:

- Current snapshot: 24 tasks are `in_progress`.
- 11 of those tasks have no active run lease and no open waiting ticket.
- `D:\dsh-test\home\profiles\desktop\plugins\team-v12-evidence-scheduler.mjs:530`
  - the ready-queue context defines `running` as every task whose board status maps to `running`.
- `D:\dsh-test\home\profiles\desktop\plugins\team-v12-evidence-scheduler.mjs:556`
  - every such task receives the blocking reason `already-running`, regardless of lease or owner activity.
- `D:\dsh-test\home\profiles\desktop\plugins\team-v12-evidence-scheduler.mjs:568`
  - scope conflicts are checked against that same status-only `running` set.
- `D:\dsh-test\home\profiles\desktop\plugins\team-v14-event-continuation.mjs:64`
  - idle-resume evaluation reuses the same context and therefore inherits stale running/conflict entries.

Observed impact:

- The current derived ready queue has `ready = []` while multiple approved or in-progress tasks have no lease and no recorded blocker.
- Stale `in_progress` rows can block otherwise independent work through false `scope-conflict` reasons.
- Owners can be left idle because the scheduler believes the task is still running.
- Recovery scans can spend their small per-scan budget on rows that are not genuinely runnable.

Required fix direction:

- Define active execution from a live run lease, a live agent turn, and a heartbeat deadline, not from board status alone.
- Treat `in_progress` without an active lease as `idle-resume`, `stalled`, or `needs-owner`, depending on age and owner state.
- Exclude terminal lifecycle rows such as `cancelled` from the active conflict set even if the board projection still says `in_progress`.
- Add a stale-execution timeout that creates a durable recovery ticket with owner, deadline, and escalation target.
- Make the ready queue expose separate counts for `runnable`, `active`, `stalled`, and `blocked`.

Acceptance:

- A task cannot be marked `already-running` solely because its board status is `in_progress`.
- An idle owner with an approved task receives a continuation wake or a recorded blocker.
- A stale task no longer blocks another task's write scope.

## P1-5: Timed-Out Wake Dispatches Have No Dead-Letter Escalation

Evidence:

- Current snapshot: 209 dispatch rows, 200 completed and 9 `timed-out`.
- The timed-out rows all reached attempt 3 and ended with `dispatch deadline expired`.
- `D:\dsh-test\home\profiles\desktop\plugins\team-control-plane.mjs:648`
  - reconciliation turns terminal dispatches into `timed-out` or `expired`.
- `D:\dsh-test\home\profiles\desktop\plugins\team-tools-v2-r10.mjs:1232`
  - the recovery loop only acts on `dispatch-retry`; terminal `dispatch-timeout` changes are not escalated.

Observed impact:

- A wake can disappear after retry exhaustion without a durable root/lead escalation.
- The sender may believe the message was queued, while the target never receives a turn.
- The red delivery panel is a symptom record, but there is no recovery action attached to the terminal row.

Required fix direction:

- Add a dead-letter state or terminal recovery ticket for timed-out wakes.
- Notify the sender and tier 0 when a wake reaches terminal failure.
- Include target, task, room, attempt count, last error, and a suggested recovery action.
- Let recovery choose exactly one of: retry with a new episode, reassign, mark the task blocked with a wait, or explicitly cancel.

Acceptance:

- No terminal wake disappears without an owner-visible dead-letter record.
- `team_delivery_check` and health output expose terminal wake counts and oldest age.
- A terminal wake cannot be silently retried by reusing the same episode ID.

## P1-6: Wake Coalescing Can Drop A Different Pending Message

Status: code risk, not observed as a multi-hash episode in the current snapshot.

Evidence:

- `D:\dsh-test\home\profiles\desktop\plugins\team-tools-v2-r10.mjs:1898`
  - `send_message(delivery:"action")` derives the episode ID only from sender and target.
- `D:\dsh-test\home\profiles\desktop\plugins\team-tools-v2-r10.mjs:2623`
  - `team_wake` uses the same sender/target-only episode ID.
- `D:\dsh-test\home\profiles\desktop\plugins\team-control-plane.mjs:2888`
  - when an active episode exists, `wakeClaim` returns `claimed:false` and only appends the new message hash to `messageHashes`.
- There is no subsequent code path that re-delivers the newer message after the first episode completes.

Observed impact:

- Two different actionable messages from the same sender to the same target can be collapsed while one is still queued.
- The target may see the first message only; the second message exists as a hash but not as a guaranteed delivered payload.
- This matches the reported symptom where a later message appears delayed or only becomes visible after another wake.

Required fix direction:

- Make the queue key message-level, or maintain a bounded pending-message list inside the episode.
- On coalescing, either preserve and deliver every distinct message or explicitly replace the queued payload and record the superseded hash.
- Expose `mergedCount`, distinct message count, and latest message ID in dispatch status.

Acceptance:

- Different message bodies from the same sender/target cannot be silently lost.
- The target receives the latest actionable instruction or a deterministic supersession notice.
- Dispatch status distinguishes merged duplicates from distinct pending messages.

## P1-7: Required Context Can Be Silently Omitted

Evidence:

- `D:\dsh-test\home\profiles\desktop\plugins\team-v14-context-delivery.mjs:85`
  - `buildContextDelivery` tracks `omitted` sources and sets `debt` when any omitted source is required.
- `D:\dsh-test\home\profiles\desktop\plugins\team-v12-runtime.mjs:1725`
  - the runtime passes the delivery body into the prompt but does not inspect or act on `delivery.debt`.
- The same code sorts required and optional sources together by priority, then stops adding once the token budget is exhausted.

Observed impact:

- A task contract, requirement, identity update, or room decision can be omitted without telling the model that required context is missing.
- The agent may continue from an incomplete view, which is consistent with repeated forgotten requirements and stale instructions after compaction.
- A larger pack on the next step may eventually include the omitted source, but there is no deterministic guarantee or debt acknowledgement.

Required fix direction:

- Reserve budget for required sources first, with a deterministic per-class cap and a compact omission summary.
- If required context cannot fit, inject an explicit `context-debt` record naming each omitted source and the tool call required to read it.
- Fail closed only for safety-critical identity or task contract debt; for non-critical debt, continue with a visible read-before-act requirement.
- Acknowledge debt only after the omitted source is actually delivered or explicitly fetched.

Acceptance:

- Required identity, task contract, and active requirement context cannot disappear without a visible debt record.
- The model can name every omitted required source and fetch it on demand.
- A post-compaction step does not silently proceed with a partial requirement set.

## P2-1: Role Files Do Not Teach The Actual `team_wake` Path

Evidence:

- `D:\dsh-test\home\team-roles\AGENTS.md:9`
- `D:\dsh-test\home\team-roles\lead.md:12`
- `D:\dsh-test\home\team-roles\member.md:11`
- `D:\dsh-test\home\team-roles\verifier.md:13`

All four identity files teach `send_message(delivery:"info|action|decision")`, but none names `team_wake` or `team_wake_superior` as the compatibility path.

Observed impact:

- Members continue to send quiet messages when they need a real wake.
- A normal peer/action message may be queued without starting a turn, so the sender waits until an unrelated event wakes the target.
- The user-visible symptom is “the team is stopped, but nobody woke it.”

Required fix direction:

- Add an explicit decision table to the shared role instructions:
  - `info`: record only; no wake.
  - `action` or `team_wake`: wake one peer/downward target for immediate work.
  - `decision` or `team_wake_superior`: wake the direct superior with blocked action, reason, and evidence.
- State that `queued` is durable and must not be resent.
- Have `send_message(delivery:"info")` return a short reminder that quiet delivery cannot wake a stopped target.

Acceptance:

- Every role can name the exact tool for a normal wake and an upward decision wake.
- A stopped owner receives a wake when an actionable message is sent.
- No role describes a quiet message as an action request.

## P2-2: Desktop/Web/Headless Plugin Copies Have Drifted

Evidence:

- `team-tools-v2-r10.mjs`
  - desktop/web SHA256 prefix: `F60AD6BE4294`
  - headless SHA256 prefix: `388D12FE0F47`
- `write-scope-guard.mjs`
  - desktop/web SHA256 prefix: `B385E0CA9DE6`
  - headless SHA256 prefix: `9616D20E6D7F`
- The headless `team-tools-v2-r10.mjs` copy lacks the web/desktop `admin_close` stale-revision check and the latest HMR markers.
- The headless `write-scope-guard.mjs` copy lacks the web/desktop Java classpath false-positive fix.

Observed impact:

- The same tool call can have different guard semantics depending on whether Root, Web, or Headless executes it.
- A fix verified in the desktop profile is not automatically present in the member/headless profile.
- Health output can report healthy while the profiles disagree on enforcement behavior.

Required fix direction:

- Add a deployment parity check for every shared plugin, comparing hash, size, exported symbols, and selected semantic markers.
- Treat profile drift as a deployment health failure, not a warning.
- Install one canonical plugin copy or generate all profile copies from one source.

Acceptance:

- Shared plugins have identical hashes across profiles.
- The health check fails when a semantic marker or exported symbol differs.
- A profile upgrade cannot partially install only one side.

## P2-3: Idle-Watch Config Contains An Ignored Field

Evidence:

- `D:\dsh-test\home\profiles\desktop\cordis.patch.yml:372` sets `intervalMs: 1200000` on `team-idle-watch`.
- `D:\dsh-test\home\profiles\desktop\plugins\team-idle-watch-v6.mjs` reads `settleMs` and `bootstrapScanMs`, but does not read `intervalMs`.

Observed impact:

- The configured 20-minute interval is not the timer that actually drives stop detection.
- Operators may believe the idle watchdog is running on a different cadence than it is.

Required fix direction:

- Either implement `intervalMs` explicitly or remove the field and document the real `settleMs`/`bootstrapScanMs` behavior.
- Add config-schema validation that rejects unknown plugin fields.

Acceptance:

- Every configured field has a reader.
- Changing the idle-watch cadence in config changes the actual timer.

## Recommended Repair Order

1. Auto-resolve approval waits and stale terminal waits.
2. Fix durable context-source dedupe and reduce tier-0 context injection.
3. Close the `run_code` write-guard bypass.
4. Add `root.md` and a bounded tier-0 operational scope.
5. Auto-wake the verifier from group acceptance packets.
6. Add queue aging, review SLA, and lease-loss recovery.
7. Add Room `awaiting-close` recovery and stop stale rooms from consuming round budgets.
8. Fix status-only active-task detection in the scheduler.
9. Add terminal wake dead-letter escalation.
10. Add message-level wake coalescing and correct the role prompt tool names.
11. Make required-context omission explicit and fetchable.
12. Add cross-profile deployment parity checks.
13. Add cold-store GC, temp cleanup, and audit rotation.
14. Reconcile the milestone-versus-pressure compaction policy and expose the trigger.
15. Move hot mutations off full-snapshot rewrites and add write-latency metrics.
16. Retest compaction and provider acceptance with a bounded context pack.

## Verification Checklist

- No duplicate context source appears in two steps without a revision change.
- A 30-step turn stays below the configured context budget.
- `team_plan_approve` closes its approval wait automatically.
- Continuation wakes the task owner after approval.
- Root can write allowed operational documents without `run_code` bypass.
- Root cannot write outside the declared tier-0 scope.
- A group acceptance packet creates one verifier wake.
- A completed task has no open waiting ticket.
- A task cannot remain `in_progress` without a lease, wait, or recorded blocker.
- A round with all speakers complete closes within the configured grace period.
- A task cannot be treated as `already-running` without a live lease or live owner turn.
- A terminal wake produces a visible dead-letter record.
- Different sender/target wake messages are not silently collapsed.
- Required context omission produces a visible debt record.
- All shared plugin copies have matching hashes.
- No unreachable cold file older than the retention grace period remains.
- No temp file survives a clean restart.
- Audit storage is bounded and health output reports reclaimable bytes.
- Milestone and pressure compaction triggers are distinguishable in status output.
- A small mutation does not await a full snapshot rewrite.
- Policy headers and runtime quota defaults agree.
- Root can complete a normal turn after compaction.

## Implementation Status (2026-09-27)

All P0/P1/P2 items in this register have a code path and a focused regression.
The final phase9/phase10/phase11 regression is `215 tests / 214 pass / 1 skip /
0 fail`; the skip is the explicit heavy 60 MB benchmark that requires
`DSH_V14_HEAVY_BENCH=1`. Evidence log:
`D:\dsh-test\output\v14-fix-regression-20260927.log`.

| Item | Status | Evidence |
| --- | --- | --- |
| P0-1 | implemented | durable session/member context cursors, bounded baseline/delta, `v14-runtime-bridge` |
| P0-2 | implemented | approval waits auto-close after plan approval, `v14-waiting` |
| P0-3 | implemented | operational tier-0 scope plus `run_code` write-path refusal, `v14-write-scope` |
| P0-4 | implemented | `root.md`, tier-0 identity routing, identity hash checks |
| P0-5 | implemented | awaiting-close deadline/re-wake/replace/force-close, `v14-scheduler` and `v14-bounded-wake` |
| P0-6 | implemented | live lease/turn execution state, stalled task recovery, `v14-scheduler` |
| P1-1 | implemented | deterministic group packet, one verifier wake, final gate requires matching verifier review, `v14-acceptance-verifier` |
| P1-2 | implemented | dynamic continuation batch, aging, review SLA, `v14-continuation` |
| P1-3 | implemented | terminal/stale wait reconciliation and dedupe, `v14-waiting` |
| P1-4 | implemented | safety-refusal classification, request/context/provider evidence, bounded fallback pack, `v14-provider-safety` and `v14-runtime-bridge` |
| P1-5 | implemented | terminal wake dead letters and escalation, `v14-bounded-wake` |
| P1-6 | implemented | distinct pending wake messages are retained and delivered, `v14-bounded-wake` |
| P1-7 | implemented | required-context debt/fetch/fail-closed behavior, `v14-runtime-bridge` |
| P1-8 | implemented | cold GC, temp cleanup, audit rotation, `v14-storage` |
| P1-9 | implemented | delayed checkpoint plus append-only history refs and write metrics, `v14-storage` |
| P2-1/P2-6 | implemented | role decision tables name `team_wake` and `team_wake_superior` |
| P2-2/P2-5 | implemented | `team-health` profile parity gate; desktop/web/headless shared-plugin hashes match |
| P2-3 | implemented | idle-watch `intervalMs` drives stop re-check |
| P2-4 | implemented | pressure-assisted compaction exposes trigger and ratio |
| P2-7 | implemented | policy header, defaults, role docs, and quota test agree on 8/8/30 |

The only intentionally unexercised part is a live provider retry after a real
safety refusal: no provider request was sent during this verification. The
fallback path, request evidence capture, and bounded reduced pack are covered
by deterministic tests. The running DSH process was not restarted or cleared;
the on-disk profile is ready for the next controlled start/HMR.
