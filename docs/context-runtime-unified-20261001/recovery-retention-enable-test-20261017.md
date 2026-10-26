# Recovery retention and isolated enablement

## Authorization and scope

User: implement the automatic recovery-retention capability described as item 2,
then enable existing features and test them. Changes are staging-only. Feature
enablement is restricted to fresh isolated instances, not production or active
Teams. No commit/push, sandbox weakening, global configuration change, or
unbounded provider run. No compatible Ready Workflow is installed. Prior
subagent task-context failures prohibit further dispatch for this task.

## Contract

- Separate projection selection pins from durable exact-revision recovery pins.
- A checkpoint-owned durable pin preserves its exact memo revision beyond normal
  TTL, while current Team/member/task ACL and explicit source revocation win.
- Admission is all-or-nothing, server-owned, bounded, durable and read back.
- Revalidation/renewal, explicit retirement/release, and fresh-process recovery
  must work without changing source history or its 64-content-revision limit.
- Collector previews remain read-only. Retention preparation acquires pins;
  checkpoint/transition validation rechecks them under the existing write fence.
- Missing, foreign, tampered, revoked, oversized or released dependencies refuse
  the transition. No fallback to expired unretained content.

## Execution and verification

1. Back up the bounded staging source/test set and record production hashes.
2. Add service and collector regressions, demonstrate red, then implement and
   run focused tests including adversarial and fresh-process checks.
3. Synchronize headless copies/manifests and freeze source for full regression.
4. Prepare an isolated feature matrix. Enable available compatible features by
   dependency; mutually exclusive modes use separate sessions. Strict plan
   tests must register the actual plan/proof prerequisites. Economics automatic
   decisions stay off while required prices/usage are unknown.
5. Verify actual loaded configuration and consumed effects, including Web/UI
   where relevant, then cold recovery and cleanup. Any provider experiment must
   first record its exact request/time cap; previous exhausted runs are not
   resubmitted or relabeled.

## Baseline

Previous retained staging package: 6457ba5eb9d4d606, 162 source carriers,
242 test files, 1646 passed / 0 failed / 1 existing skip. That immutable report
does not automatically cover this new implementation. Prior reports and bound
specification documents remain untouched; new evidence belongs in
`output/recovery-retention-enable-20261017`.

## Current status

Implementation is frozen at source inventory v3, hash
`5abe1d8a32276ad64b26318577400dd2751cbfab572961626a1ffa360ddbefc2`.
Full regression: 243 files, 1663 tests, 1662 passed, zero failed, one existing
skip. The isolated enabled core, browser rendering, Instant/detached completion,
manual safe-tail compaction, exact history consumption and three independent
physical JSONL cold recoveries passed. Final aggregate and isolated evidence
registration/readback are complete.

Final report: `output/recovery-retention-enable-20261017/final-result.json`.
Durable evidence: `recovery-retention-isolated-5abe1d8a32276ad6` in the isolated
`evidence-home/team-control-plane/default.json`, resolved through its validated
content-addressed cold reference using `readControlPlaneSnapshot`. No production
registry was written. Source inventory has 162 verified carriers;
`stage-closeout --check` reports zero pending changes. Twelve production files
remain unchanged, all owned test hosts are disposed, and ports 40123-40126 are
idle. The existing user process on 8788 (PID 16472) was preserved.

### Results And Limits

- Automatic retention is server-owned, atomic and bounded; exact revisions and
  transitive dependencies survive TTL while ACL, revocation and release win.
  The collector prepares/renews/retire-checks pins without exposing model pin
  authority, and transition fencing includes the memo document.
- Integration testing caught two defects beyond the initial unit tests:
  expired pinned content was still rejected by the projection expiry filter;
  and a newly eligible unretained turn wrongly prevented already-retained
  spans from folding. Both received real red/green regressions and are covered
  by the final frozen full run. Failed runs remain preserved.
- Core run: actual registered-plan refusal/physical proof/accepted receipt,
  active identity, apply-mode memo consumption, W0/W1/W2 and following request,
  plus actual Edge rendering with zero page/console errors. Twenty-four fixture
  requests, zero external requests.
- Instant run: the actual SessionController `mode: "steer"` handled new input
  before the original PTC hold completed. Original body ran once; lifecycle
  started/detached/settled/notified/consumed, result 37, no live background jobs.
  Four fixture requests. The earlier driver used the unsupported literal
  `instant`, which falls back to followup; it was corrected without changing
  product behavior.
- Manual compaction run: real compaction-purpose LLM stream, balanced tool
  pairing, preserved recent constraints, unchanged original journal prefix,
  exact paged history assembly and consumption in the next request. Six
  fixture requests. Separate-process native JSONL reloads passed for core,
  Instant and compaction; expired pinned core memo recovered exactly.
- One real-provider request consumed the applied expired-but-retained memo and
  derived the exact unpredictable nonce and correct remaining count. It did
  not invoke the requested SDK, so the stronger oracle failed and was not
  retried. Reported usage: 29,971 input, 38 output; price/billing unknown.
  Earlier failed pilot preparations made zero external requests.
- Economics remains shadow with automatic actions off. Hypothesis/constraint
  support was loaded and regression-tested, not newly proven in an autonomous
  multi-agent behavioral experiment. Mutually exclusive W1/W2 modes were
  exercised separately in the isolated root.
- The core's business receipt was accepted before W2, then correctly returned
  to partial after its current source vector changed. It requires a fresh
  receipt; the historical accepted record was not rewritten as current.

Acceptance is explicitly `implementationAccepted=true`,
`isolatedCoreTestsAccepted=true`, `allFeaturesAccepted=false`,
`productionEnabled=false`. No production deployment, active-Team interruption,
credential copy, commit or push occurred.

### Separate bounded real-provider pilot (registered before execution)

Objective: a current real model reads an exact automatically retained memo after
normal TTL, using the real SDK and current apply-mode projection, and derives
its final answer from the unpredictable original. This is a new retention test,
not a reset or continuation of the exhausted original integrated experiment.

- Existing configured route: `opencodego/deepseek-v4.1-flash` through local 8788.
- At most 4 external requests, 2048 output tokens/request, 1 MiB payload/request,
  300 seconds wall time, zero retries. All purposes count toward the cap.
- Credentials read only into the isolated child process environment, never
  copied to a fixture file or logged. No parent environment mutation.
- Only the exact read-only SDK program and its exact memo read are admitted.
  No shell, edits, approval escalation, polling, or alternate provider.
- Source-bound raw request/usage, original result, derived answer and cleanup
  are retained. Exhaustion or failure remains a failure, with no resubmission.
