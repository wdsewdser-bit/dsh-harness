# TEAM-QUERY-01 / TEAM-NOTIFY-02 staging validation

Date: 2026-10-01. State: staged implementation; offline focused validation passed.
This report does not assert live deployment, HMR loading, SDK certification, or model savings.

## Boundary

- Changed only `D:/dsh-test/staging/architecture-clm-20261001/home/profiles/web/plugins` Team modules, `D:/dsh-test/architecture-tests/team-*`, and this report.
- Baseline backup: `D:/dsh-backups/architecture-clm-20261001-071217` (prepared by the parent).
- No live profile/session/installed-app write, live DSH tool invocation, model HTTP, service restart, or full regression was performed.
- Real Team policy, roster parallelism, provider blocking, Room, wake, idle, inbox and acknowledgement controls remain active.

## Behavior

Task list/get capture one copied control-plane snapshot and one ready queue/index for a query.
All task projections share this snapshot; `limit=1` does not rebuild the full queue for every card.
Board authorization precedes task projection. The existing domain read still supplies global visibility;
local authority overlays phase/status/revision as before. Ready-row ID selection retains the legacy first-match behavior.

Default task and evidence views retain full values. Compact task output keeps required legacy fields,
uses an empty description, omits large contract/body fields, and declares `completionEvidence:false`.
Evidence metadata projection runs after the existing author/task ACL, ID resolution and exact filters.
`changed_since` is a strictly-greater epoch-millisecond timestamp, not a task revision.
`snapshotRevision` is an exact current control-plane CAS precondition; a moved snapshot is refused.
`snapshotId` is `rootId@revision`; this does not create a historical snapshot archive.

Direct messages validate delivery policy, task board access, task revision and phase before Room effects.
Optional operation IDs bind sender, target, task ID/revision, event ID, delivery and a payload hash.
Reusing an ID with a different payload/scope is refused and exposes the existing actual receipt in the error.
No text-only permanent deduplication is introduced; identical text in a new completed episode remains legal.

Operation reservation/checkpoints use the existing control-plane lock and atomic persistence. Room notice,
quiet dispatch creation and wake claim bind real message/dispatch/episode IDs to the operation in the same mutation.
A synchronous per-key process gate is acquired before any awaited reservation/recovery. Normal duplicate
callers wait for that execution and read its receipt; concurrent recovery is refused. The gate is retained
across HMR through a global symbol. An operation owned by another still-existing process cannot be recovered.

Recoverable caught failures resume known missing steps, retaining the confirmed Room notice and injection.
For a durable reservation interrupted before completion, the same sender can supply
`operation_recovery:{expected_revision:<operationRevision>,reason:<audit reason>}` with the exact original
operation/payload. Current ACL and task snapshot validation still run first. Recovery itself is durable CAS,
with actor/reason/fromRevision recorded. It can resume missing stages or confirm a matching real delivered/completed
dispatch without another delivery. It does not infer absence of an effect from TTL or elapsed time.
If an external delivery was attempted and no matching confirmed dispatch receipt exists, recovery is refused
with the current partial receipt. This unresolved outcome requires inspection of the consuming session/mailbox;
the tool does not claim exactly-once external delivery or fabricate a confirmation.

Activity digest compares member/task/lease/requirement/deadline facts. Pure control timestamps, metadata-only
task revisions, time slots and the digest's own root status change do not create progress episodes.
New blockers, completed task facts, changed user task content and actual responsibility deadlines change the
signature. The last delivered signature and episode sequence persist in the control plane. Independent
Room timeout, idle/SLA, provider blocking, wake episodes and acknowledgement behavior remain on their existing paths.

## SDK / schema changes

| Tool/schema | Added input | Added output / compatibility |
|---|---|---|
| `team_task_list` | Optional `view:compact/full`, `taskIds:string[]`, `changed_since:integer`, `snapshotRevision:integer` | Optional envelope `snapshotRevision`, `snapshotId`. Default full rows and cursor semantics retained. |
| `team_task_get` | Optional `view:compact/full`, `snapshotRevision:integer` | Optional row `snapshotRevision`, `snapshotId`. Default full task values retained. |
| Shared `TASK_VIEW_SCHEMA` | None | Optional `queryView:compact`, `completionEvidence:boolean`, `snapshotRevision:integer`, `snapshotId:string`; other task tools inherit only these optional schema fields. |
| `send_message` | Optional `operation_id:string`, `operation_recovery:{expected_revision:integer,reason:string}` | Optional `operationId`, `operationRevision`, `duplicate`, `partial`, `externalAttempted`, `externalConfirmed`; real existing receipt fields retained. |
| `team_v12` evidence query | Existing arbitrary `input` accepts `view:full/compact/metadata`, `taskIds`/`task_ids`, `changed_since`, `snapshotRevision` | `snapshotRevision`/`snapshotId` plus metadata rows when explicitly selected. Aggregate input/output schema is already open, so no new action enum/schema was required. |
| `team_wake` / `team_wake_superior` | None | No schema changes. Actual `team_wake` alias regression passed. |

Task-bound informational messages now enforce the documented revision/phase requirement too. This is an
intentional validation tightening of the previous info-path loophole. Untasked legacy sends and default full
queries continue to work. The new generated SDK hash is not one of the existing certified five: the retained
SDK module remains unchanged and unknown hashes must continue to fail open. Parent-owned SDK certification
and applicable isolated golden validation are required before deployment; this report is not that certificate.

## Validation

All commands used Node v24.17.0 and local fixture directories under the system temp directory.
Those fixture directories were removed after verification. The loader maps existing test imports to staging;
the existing test source files were not edited.

```powershell
node D:/dsh-test/architecture-tests/team-efficiency.test.mjs
node D:/dsh-test/architecture-tests/team-digest-progress.test.mjs
node --no-warnings --loader file:///D:/dsh-test/architecture-tests/team-staging-loader.mjs <focused-existing-test>
node --check <each-of-the-seven-changed-plugin-modules>
```

- Main integration fixture: 41 checks passed, exit 0. Covers intended tool schema placement, same-revision page/get equality, one ready queue
  construction, compact/IDs/time filtering, denied cross-group reads/writes, stale-before-Room, duplicate/conflict,
  quiet no-wake, new action episodes, actual legacy wake alias, partial failures, reservation/notice/delivery crash
  recovery, operation CAS, persistent actual receipts and the reviewer's concurrent normal/recovery counterexample.
- Timer fixture: 5 checks passed, exit 0. Multiple unchanged slots remain silent, new facts produce one episode,
  metadata-only revisions stay silent, a real responsibility expiry emits one due reminder and sequence persists.
- Syntax: all 7 changed plugin modules passed `node --check`.
- Existing staged focused regression files: all exit 0:
  `phase8-tests/team-activity-digest.test.mjs`, `phase8-tests/team-activity-digest-timer.test.mjs`,
  `phase8-tests/team-idle-watch-no-cap.test.mjs`, `phase11-tests/v14-wake-claim-atomic.test.mjs` (1 node:test),
  `phase9-tests/v12-room-wake-compaction-context.test.mjs` (9 node:test),
  `phase11-tests/v14-bounded-wake.test.mjs` (bounded mailbox, distinct pending messages, background acknowledgement,
  awaiting-close timeout/host replacement/force close, existing-room reuse).

The concurrency review counterexample now returns `message-operation-inflight` for the recovery caller and
executes the first side effect once (`effects=1`), rather than both callers reporting completed effects.

## Files and SHA256

Plugin directory: `D:/dsh-test/staging/architecture-clm-20261001/home/profiles/web/plugins/`.

| File | SHA256 |
|---|---|
| `team-tools-v2-r10.mjs` | `A6ED5321123FC044ECA0D4624A45E15981B8D961780FA925F6BB755C82EC2961` |
| `team-control-plane.mjs` | `8071559742AEB62CB8C1EFE6813BAD3522AF97BEA8A39ABC1BE0B911CB9FF10C` |
| `team-message-operation.mjs` (new) | `0A9C4924D33B84CA391EC6AC4B3B4AE6D4134CCB53DC0E8FBFCAF075A9D93BBF` |
| `team-query-efficiency.mjs` (new) | `F9B66E81004D6B90C6054312F0E7CB362B5FB2F385D305FB1A5D270A66E15E31` |
| `team-activity-digest.mjs` | `46A57F42CD49ACA738236A9722987DF9C355FFA08DF4FDCE2AEE3BFC83CCF38F` |
| `team-v12-runtime.mjs` (query only) | `3C6BBABDBB431DD213D79BFD669904717F7D9921E4A1F357F3B04F9CAB1ECD85` |
| `team-v12-evidence-scheduler.mjs` | `DE2AC8658F58FAD1A66CA308061192F5DD925A64E16745A7B4007816EEA1B776` |

New tests: `D:/dsh-test/architecture-tests/team-efficiency.test.mjs`,
`D:/dsh-test/architecture-tests/team-digest-progress.test.mjs`,
`D:/dsh-test/architecture-tests/team-staging-loader.mjs`.

## Remaining limits

No live loading, full offline regression, runtime profile parity, SDK certificate, real model A/B or savings
estimate has been claimed. An unconfirmed external effect without an authoritative dispatch remains partial
and cannot be automatically retried. Durable operation keys are retained without a TTL; lifecycle archival
and storage growth policy are outside this batch. A single copied hot snapshot still has a cloning cost;
the proven reduction is one ready derivation per query, not a measured whole-Team monetary saving.
