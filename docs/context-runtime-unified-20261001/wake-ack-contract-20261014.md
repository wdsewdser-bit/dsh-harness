# Wake-ID Acknowledgement Contract Repair

## Scope

Staging only. Fix the successful acknowledgement-input result, retain all actor
and target authorization gates, and test the actual registered team_v12 tool.
No production deployment, full sandbox access, or copy of the coupled staged
runtime into production. Backups: backups/wake-ack-contract-20261014 and
backups/wake-ack-closeout-20261014.

## Counterexample And Fix

The native registered tool rejected a valid own wake with
`undefined: wake:alice:1`, matching the live S2 error. Its caller checks
ackInput.ok, but the successful helper omitted that field. The helper now
returns ok=true after the caller-supplied input spread. Invalid caller/target
branches are unchanged and still return refusal. Caller input cannot override
the successful status, and runtime cross-target authorization remains ahead of
this helper.

Added registered-tool tests cover a successful own wake, durable wake/inbox
handling, repeated idempotent acknowledgement, and denial of a foreign wake
even with allowOtherTarget=true in untrusted caller input.

Before fix: 32/33, exact own-wake test fails;
output/regressions/2026-10-14T02-59-52-316Z-2fed9e1a.
After fix: 33/33;
output/regressions/2026-10-14T03-00-20-049Z-f0bfc4b4.
Full regression: 237 files, 1562 tests, 1561 passed, zero failed/cancelled,
one existing skip. Machine summary:
output/regressions/2026-10-14T03-00-27-013Z-d18d514f/summary.json.

## Isolated-Live Protocol

Fresh home wake-id-fix-20261014, port40125, one root and one group lead. Reuse
the successful S2 decision-marker scenario, but acknowledge by the returned
exact wake ID only, with no inbox-ID fallback. Overlay only the staged
team-v12-room-wake.mjs helper. Keep production runtime/native/other plugins.
Label the result changed-copy isolated-live, not production-byte-identical.

Do not start before full regression finishes. One host, 10 minutes maximum,
24 completed requests maximum. Require a successful native inbox_ack tool
receipt with wake_id arguments and the matching durable handled wake/inbox
state. Model prose is insufficient. Stop after that observation, collect
events, delete isolated credentials and verify plugin/source hashes and ports.

## First Live Probe And Carrier Gap

The single-helper overlay used 9 real requests. Native wake-ID acknowledgement
returned ok=true without inbox-ID fallback, and room wake/inbox became handled.
However the same message remained delivered in dispatch.pendingMessages and
appeared again in inbox_list. This is not complete acknowledgement. Evidence:
output/live-replay-20261012/wake-id-fix-20261014. Its 10-check verdict covers
only the initial return-contract criteria, not carrier retirement. Host stopped
and credentials were deleted; these original receipts are preserved.

The registered-tool regression was strengthened with a duplicate dispatch
carrier and an empty post-ack inbox requirement. Before retirement fix: 32/33,
delivered versus handled failure,
output/regressions/2026-10-14T03-08-04-287Z-e808f500.

The staged runtime now invokes existing acknowledgeInboxEntry for each handled
message inside the same authorized mutateHot operation, after handleWakeBatch.
Failure aborts that mutation rather than accepting partial acknowledgement.
Actor/target gates remain unchanged. Post-fix: 33/33,
output/regressions/2026-10-14T03-09-13-058Z-8e68ca37.
Second full regression passed: 237 files, 1562 tests, 1561 passed,
zero failed/cancelled, one existing skip:
output/regressions/2026-10-14T03-09-19-737Z-ee7af6c5/summary.json.

Final live probe uses the same 10-minute/24-request limits in fresh home
wake-ack-complete-20261014. Overlay the corrected helper plus only the 11-line
acknowledgement retirement block in the production-runtime copy. Do not copy
the whole coupled staged runtime. Require native wake-ID success, both room
and dispatch carriers handled, and empty post-ack inbox. No production deployment.

## Final Acceptance

Final changed-copy isolated-live passed all 12 assertions, 9 real-provider
requests, with no inbox-ID fallback. Root:
session-77e54cd9-8195-48b3-b91a-85c04a099008. Exact wake-ID call sequence 44
returned native success; the matching room and dispatch message
msg-bf3fa05f-19a7-4316-8db0-9b0a35a72900 was durably handled in both carriers.
The following native inbox_list returned total=0, inbox=[], wakes=[].

Machine verdict and original tool events:
output/live-replay-20261012/wake-ack-complete-20261014/verdict.json and
tool-events.jsonl. The isolated runtime was independently compared against
production plus exactly the staged acknowledgement block; unrelated Strict
code was not imported. Source copies were stable during the run, production
helper remained its original hash, and other key production plugins did not
change. The host stopped at 03:15:40 UTC; credentials deleted. No listener
remains on 40123/40124/40125. User-owned 8788 route was left running.

Both fixes are accepted for this scoped staging/isolated-live repair only.
They are not deployed to production, and do not close all S2 or historical
stale-target incidents. Independent security review and live foreign-actor
negative testing were not performed; the registered-tool regression includes
the foreign-target rejection. Stage full regression and closeout are current.
