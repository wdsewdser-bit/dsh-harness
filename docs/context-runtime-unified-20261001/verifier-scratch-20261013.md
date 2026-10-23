# Verifier Scratch D-3 Follow-Up

## Scope And Authorization

The user authorized work and one quota-reset continuation in this chat. Changes
remain in staging. No production deployment, host start, Team-root expansion,
commit or push is authorized by this milestone.

## Confirmed Cause

The actual Web-profile native Team roster returns membership with `root`, `id`,
`role` and `name`. It does not return `group`. The durable member-list row carries
`level`, `groupId` and `parentName`. The old guard passed raw membership directly
to `isVerifierScratchPath`, so a legitimate verifier was classified as a
non-verifier. The S1 original refusal is retained in
`output/live-replay-20261012/s1-a/tool-events.jsonl`, verifier session
`c57c56bb-8618-4b93-abe0-41050fdbc73e`, sequence 165.

## Staged Fix

Only the verifier-scratch exception now resolves the durable roster group when
raw membership lacks it. The lookup requires both the exact live agent ID and
the membership name, through that caller's native Team service. Missing
membership, missing rows, lookup failure, mismatched identities and non-verifier
groups remain denied. Product paths and similarly named sibling directories
remain denied. Write, edit and shell-carrier checks use the same resolution.

The generic tier/worktree membership behavior is not changed by this fix.
Broader membership-field omissions are outside this milestone.

Modified runtime: both staged profile copies of `write-scope-guard.mjs`.
Regression: `phase11-tests/v14-write-scope.test.mjs`, including the actual native
`TeamRoster` class with fixture registry/journal data. That test is not a real
host or a real-provider run. The plugin is now registered in the change
manifest; production remains unchanged.

Backups: `D:/dsh-test/backups/verifier-scratch-20261013/` and
`D:/dsh-test/backups/verifier-scratch-closeout-20261013/`.

## Validation

- Focused run before the final historical-expression assertion: 14/14 passed,
  `output/regressions/2026-10-13T04-43-17-436Z-b3b6f07e/summary.json`.
- Syntax checks passed. Staging closeout reports zero pending changes.
- Production-copy coupling check: guard is `alone-ok`; existing Strict-package
  coupling remains unchanged.
- First full regression completed with 1558 passed, 1 failed, 1 existing skip:
  `output/regressions/2026-10-13T04-44-38-807Z-83bce087`. The unrelated shadow
  milestone observer missed the final file update due to its mtime-only cache.
- The milestone test was strengthened to force equal modification times across
  updates. Old runtime then failed deterministically (7/8):
  `output/regressions/2026-10-13T04-50-27-506Z-794959b5`.
- The staged window manager now checks change time and size as well as mtime.
  The original three-transition assertion is unchanged; no sleeps or retries
  were added. Focused post-fix verification: 22/22,
  `output/regressions/2026-10-13T04-50-58-536Z-a34d46fe/summary.json`.
- Second full regression completed: 237 files, 1560 tests, **1559 passed,
  zero failed/cancelled, one existing skip**. Machine summary:
  `output/regressions/2026-10-13T04-51-02-653Z-8cec4ea8/summary.json`.

This incidental fix also modifies both staged copies of
`team-v15-window-manager.mjs` and `phase11-tests/unified-window-manager.test.mjs`.
Its extra closeout backup is `backups/verifier-scratch-milestone-closeout-20261013`.
It is not included in the isolated scratch overlay or deployed to production.

## Bounded Isolated-Live Follow-Up Plan

After full regression finishes, prepare a fresh isolated home using the existing
S1 driver, named `verifier-fix-20261013`. Keep production native code and all
other production plugins unchanged; overlay only the staged guard. Record the
before/after guard hash and explicitly label this a changed-copy verification,
not a byte-identical production replay.

Use port 40125 only after verifying it and 40123/40124 are free. Run one host,
12 minutes maximum and 48 completed requests maximum. Existing local route:
`opencodego/deepseek-v4.1-flash`. Do not silently relax sandbox permissions,
grant wildcard write scopes or widen a lease to make the probe pass.

Create one verifier, instruct it to read the nonexistent scratch file, write one
unique marker, then read it back. Also request a product-path write, which must
be rejected and must not create a file. Record exact native tool returns and
the child roster identity. Stop immediately when these observations are
available or on a limit/guard failure; do not repeat a whole Team scenario.

A successful result requires actual scratch-file contents plus native successful
write/read receipts and a product-path refusal. Hook-unit success alone does
not close the S1 isolated-live finding. Any downstream sandbox refusal is a new
specific finding, not evidence that scope permission should be bypassed.

Stop the isolated host, collect durable events, remove only the isolated
credential copy using the existing cleanup path, and verify production guard
hashes and protected signatures remain unchanged. S2/S3/S4 are still pending.

## Isolated-Live Result

The run used the real `opencodego/deepseek-v4.1-flash` route, 11 request-dump
entries / 11 terminal requests, one root and one native verifier child. Root:
`session-e56c3b04-5a7f-4993-9072-a9fa4456c3b2`; verifier:
`4c2e33ef-2325-4f0c-9501-83a36b3544aa`.

**End-to-end result: not passed.** The original guard refusal disappeared, but
the next enforcement layer refused the scratch write:

```
Error: [sandbox: file access denied under workspace-write mode]
```

Native child call/result sequences 23/24 show this exact scratch attempt.
The scratch tree is outside the child workspace. No wider sandbox mode was
requested or granted. Product write sequences 30/31 remained rejected by the
scope guard, and the product file was not created. The model faithfully reported
the refusal; no assistant completion text was treated as proof of success.

Machine verdict:
`output/live-replay-20261012/verifier-fix-20261013/verdict.json`. Exact verifier
identity, negative product write, absence of the product file, source stability,
single-guard overlay, request bounds, host stop and credential cleanup all
passed. Scratch success/readback/file-content checks failed.

The guard fix is therefore staged and regression-tested, but D-3 is still
**partial** under a workspace-write host. Closing it needs a separate decision
on how a platform-owned scratch directory is represented in the sandbox policy.
Do not retry with danger-full-access, wildcard scopes, an actor-independent
extra write root, or a fabricated successful receipt. A process-wide single
workspace scratch path would also be wrong for multiple Teams/worktrees.

The host stopped at 04:58:31 UTC, reason `requested-stop`; protected-production
guard reported no change. The isolated credential copy was deleted. All six
key plugin before/after hashes match, with only the staged guard overlay
different from production. Staging closeout remains zero pending changes;
40123/40124/40125 have no listener. No production deployment occurred.
