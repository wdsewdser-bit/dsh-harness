# Verifier Native Staging Completion

## Goal And Boundary

User corrected repeated phase-end deliveries and requested continuous completion.
Finish the usable staging implementation, not another isolated output-only
prototype. Production home/app, active Teams, sandbox permissions and token
privileges remain unchanged. No commit, push or production activation.

Required delta from the previous accepted prototype:

- Install maintainable runtime files in staging, with complete web/headless
  parity and deployment manifest coverage of module/C#/PowerShell assets.
- Provide an explicit opt-in profile patch from the staging tooling, keeping
  default behavior off and not enabling unrelated staged features.
- Remove manual per-session mkdir from the consuming workflow. Native execution
  identity and a trusted workspace handle must derive/create/capture only its
  own scratch session root, with handle-relative containment and fail-closed
  root/namespace changes. No model-supplied root capability or path-write fallback.
- Keep native text create/read/edit, sandbox, observation/version, cancellation,
  teardown and guard veto contracts; reject unsupported metadata and boundaries.

## Verification Gates

1. Complete implementation plus focused disposable fixtures. Test new automatic
   bootstrap, readonly/off no creation, scope/session revocation, peer/product,
   ancestor/junction swaps and helper disposal/transport failure. Include all
   runtime assets in the staging manifests and closeout checks.
2. Targeted independent review of the new bootstrap/handle lifetime boundary
   and staging wiring, not a whole-platform audit. Fix concrete findings with
   matching regression checks before real host use.
3. One final frozen-source full offline regression via the established isolated
   runner, then a consuming-surface host acceptance. Existing138/30 tests belong
   to the prior prototype and must not be relabelled as this changed source.

## Bounded Actual Host Protocol

Fresh isolated home `output/live-replay-20261012/verifier-native-stage-20261016`.
Use the existing s1-host driver, port40125 only, maximum12 minutes and24 actual
provider terminals. Keep workspace-write/ask, no extra token privileges, no
40123/40124 or unrelated8788 service changes. Copy only frozen approved staging
backend bundle and the unchanged scratch guard; record exact overlays/hashes.
Other experimental staging features remain disabled in this test.

Controller may configure Git ignore in this isolated repository before the
run, but MUST NOT pre-create the scratch namespace or session root. Preserve
the initial absence as evidence. Locator remains read-only. No credential or
provider use before the implementation/review/offline gates pass.

Root spawns exactly one real verifier v1. In one bounded assignment v1 calls
the locator once; native reads its artifact initially absent, writes an exact
BEFORE marker, reads, edits to AFTER and reads again. One native product-path
write must be refused. On a scratch error stop, do not repair/escalate permission
or retry. No shell/run_code/Git/scope/lease changes. Record root/member completed
turns, true helper bootstrap receipt, filesystem identity and exact final bytes.

Stop host, reap helper, remove copied credentials, confirm ports idle, compare
production8-file baseline plus driver's762 resource signatures, ordinary Git
add-A excludes scratch artifacts, and check exact staged bundle stability.
Preserve failures as failures; new provider runs need a concrete new hypothesis
and bounded protocol, never unbounded retry.

## Acceptance Limit

Windows x64 NTFS scratch text only; audit SACL preservation is not promised.
No general LocalFS parity, complete shell/external-concurrency proof or
production release approval is implied. These are scope limits, not excuses to
leave staging packaging or ordinary create/read/edit unimplemented.

## Initial Review Findings (Not Accepted Yet)

Independent reviewer completed against initial stage host5e4df212,
transportd2154fc1,Capability3ba8c15f,Runtimeeb6ff6c2, matching the initial
stage-result. Local helper fixture, simulated native identity only:
`output/verifier-native-review-20261016/revocation-window.mjs` and
`revocation-result.json`. No actual host/provider use.

- P1: after bootstrap challenge, current sandbox can switch to read-only while
  the native tool's previously supplied policy still authorizes publication.
  Repair must honor BOTH current native policy and supplied policy; do not
  substitute one stale permit for a newer deny.
- P2: a postinitialization identity failure drops the session cache but leaves
  the newly registered controller/helper/ancestor handles alive until plugin
  disposal. Failed initialization must close/reap the controller immediately,
  without requiring global disposal or leaking more helpers on later retry.

These are reproduced failures, not passed checks. The implementation worker is
repairing them with regressions. Other reviewed new handle capture/RootLease
lifetime and reparse checks had no explicit actionable finding. Default full
regression must also gain a real native bootstrap/authorization test entry, as
standalone tools/*-test.mjs scripts are not automatically discovered by it.

## Targeted Repairs And Recheck

The worker retained red authorization evidence, implemented current+supplied
policy intersection at bootstrap-ready, queued execution and mutation checks,
and actively closes/reaps controllers on postready or waiter identity failure.
Close is idempotent; session/controller caches are cleared on failure.
New36 authorization checks verify refusal after policy/membership revocation,
no artifact, helper termination and workspace-handle release BEFORE whole
plugin disposal, one healthy helper after identity recovery, and queued denial.

Final initial-delivery source is main plugin
`C55A74191AF8893563BBBD467AB0AD283E1C271D26C2E56531E0124BF11A42FB`.
`phase11-tests/verifier-native-bootstrap.test.mjs` now enters the default runner
and exercises real native bootstrap/tool paths and the revocation/cleanup cases;
its two canonical checks passed separately. Fixture count189 (not153 plus189),
manifest acceptance3. All runtime assets have web/headless parity and pinned
manifest entries; previous unrelated manifest/coupling entries remain unchanged.

The same independent reviewer completed a focused recheck of the two defects:
both closed, no new explicit issue found. Five runtime hashes and authorization
and canonical test hashes match the current stage-result. Reviewer read red/green
evidence and source, but did not rerun tests or start a host/provider. This is
not an expanded whole-platform approval. Full regression and real native
session acceptance remain separate required gates, not inferred from this result.

## Completed Acceptance

Full offline runner exited0:239 files,1593 tests,1592 passed,0 failed,1 existing
skip. Evidence `output/regressions/2026-10-16T11-41-28-293Z-5f97ccfe/summary.json`.
The five runtime files stayed frozen through review, full regression and live.

Fresh actual host run passed31/31 assertions:
`output/live-replay-20261012/verifier-native-stage-20261016/verdict.json`.
Before host startup the namespace did not exist, and no controller session-root
mkdir was performed. One native v1 `71b28036-1865-4c37-85be-74ad9584bf92` called
locator once, then native initial-absent read22, create27, BEFORE read32, edit37,
AFTER read42, product-write refusal47, child completed52. Root completed39.
Exact physical final bytes: `STAGE_NATIVE_AFTER_20261016`. No product file,
pending temp, extra spawn, shell, scope/lease or permission change.

Actual usage13/24 provider terminals. Host started11:47:14.518UTC and stopped
11:49:41.656UTC. Driver exited0; host exit1 is the existing forced taskkill stop
method, not graceful exit0. Credentials deleted;40123/40124/40125 idle, no helper
remains; unrelated8788 PID48096 preserved. Eight key production hashes unchanged,
driver protected762 resource signatures, isolated git add-A staged0/tracked0.

The first controller assertion failed only because it required exitCode on the
canonical summary's success/tests schema; its failed JSON is retained as
`assert-metadata-schema-failure.json`. Matching the actual typed schema passed
all31 without changing runtime/source permissions or reissuing model requests.

## Configuration Entry And Final Follow-Up

Staging source profile directories are plugin mirrors, not standalone runnable
profiles. The formal entry is `tools/verifier-native-profile-patch.mjs`:

```js
const patch = verifierNativeProfilePatch(existingProfilePatch, {
  enabled: true,
  isolatedHost: true,
});
```

Default invocation returns an unchanged clone. Explicit opt-in now adds BOTH
the existing `write-scope-guard` session-workspace mode override and the native
backend insert. It does not alter enforcement/scopes/sandbox, enable unrelated
features, copy credentials, start a host or deploy production. The selected
base profile must already register the existing write-scope guard. Optional
pluginPath selects a copied isolated bundle, as used by the consuming lab.

This final tooling-only correction removed the caller's separate guard-mode
step. Backend five-file hashes are unchanged. Bootstrap checks were rerun in
fresh `output/verifier-native-stage-20261016/profile-activation`, and canonical
bootstrap/config/revocation checks3/3 passed in
`output/regressions/2026-10-16T11-52-59-694Z-a3539426/summary.json`.
Manifest acceptance3/3 passed in `2026-10-16T11-54-20-968Z-e666bfd0`.
No new model run or full-suite rerun was needed for this tooling-only change;
the full-suite counts above belong to the unchanged accepted backend snapshot.
All final source/tool hashes in stage-result match disk, web/headless runtime
parity is intact, closeout pending0 and coupling baseline matches. New plugin
dependency on its transport is declared coupled, not misreported alone-safe.
Backup `backups/verifier-native-stage-20261016/profile-activation` and the
manifest rewrite log preserve the tooling update's prior hashes and reason.

## Final Scope

Unified final record: `output/verifier-native-stage-20261016/final-result.json`.
This aggregates worker fixture provenance and the separate real consuming gate;
it does not change the worker's historical "no host/provider used" declaration.

Formal staging integration and automatic-root usable workflow are complete.
There is no remaining required manual session-root bootstrap or experimental
output-only install step. Production activation remains outside authorization.
Readonly does not initialize a new controller, including for an existing root;
ordinary non-scratch native delegation still works. Windows x64 NTFS/text-only,
fail-closed directory writer conflicts, audit-SACL and general-security-audit
limits remain explicit, not claims of missing staging implementation.
