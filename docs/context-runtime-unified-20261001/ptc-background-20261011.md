# Instant And Same-Instance PTC Background Acceptance

## Result

The scoped runtime package is implemented and verified in staging. It has not been deployed or enabled in production. Both a real Web host and a real Team host with one spawned child passed. Their LLM adapters were deterministic fixtures, not external providers.

An accepted steering input can release the foreground waiter while the exact already-started PTC runtime and child tool continue. The original program is never cancelled and rerun to simulate migration. New child effects from its superseded generation are refused.

## Implementation

- `team-v15-ptc-background.mjs` reuses the existing `LocalJobRegistry` and the original `NodePtcRuntime.run` promise. Exact session IDs are mandatory; the default actor is a live root, not a descendant. Ordinary-session access requires a separate explicit opt-in.
- Native input preemption recognizes user input and scoped, authorized Team mailbox/wake sources. Existing queue promotion remains a durable operation. Only a detached job's already-started child result may settle outside an open turn; new dispatches remain prohibited.
- Started, detached, terminal, notified and consumed job markers bind the same session/root call/job/generation/turn/step. Detach requires its exact durable preempt input. Notification requires a durable input receipt. Collection requires a successful canonical tool effect and matching receipt/artifact reference.
- Result artifacts are fsynced, renamed and SHA256-read back before their terminal marker and notification. Notification failure is replayed idempotently, without rerunning the program. Large results remain in their complete artifact; collection returns a bounded receipt.
- Cold recovery cannot prove a lost owner's outcome and reports `unknown`. A file saved before a missing terminal marker remains uncommitted evidence; a separate unknown artifact preserves its reference instead of overwriting it or calling it successful.
- Native Goal completion, delivery coverage and window writers retain pending background debt until canonical collection. Raw assistant claims cannot discharge it.
- Installation without an existing bridge now obtains the real JSONL owner barrier. The service keeps its installation context for host dependencies, avoiding Cordis caller-context injection failures in actual tool execution.

## Verification

- Runtime matrix: 16/16 passed, including user and Team steering, late child settlement, superseded admission, result tampering, forged lifecycle receipts, explicit cancellation, ownership, teardown, timeout, large output, partial mutation, duplicate collection, notification replay, and two real process-death boundaries.
- Shared-contract focused run: 5 files, 70/70 passed. Summary: `D:/dsh-test/output/regressions/2026-10-11T22-58-55-235Z-7e3ae1f2/summary.json`.
- Full serial regression: 230 files, 1485 tests, 1484 passed, zero failed/cancelled, one existing skip. Summary: `D:/dsh-test/output/regressions/2026-10-11T23-06-35-454Z-c50589e2/summary.json`.
- Fifteen runtime/tool files passed syntax checks. The new plugin, typed PTC files and lab tools are manifest-registered. Web/headless parity and `stage-closeout --check` report zero pending changes.
- Web UI: real queue insertion and "Steer queued message" handled `NEW_DIRECTION` before fixture release. The original program/body each started once; the pending background badge remained visible. After release, a durable notification and result collection completed, and the badge cleared. Four fixture requests, zero external requests, zero agent/browser errors. Source hashes were unchanged across acceptance.
- Team host: the native Team service spawned one real child; that child sent through the actual Team mailbox to the root. Sender, Team and message identities matched cold receipts. The original program/body each started once. Root requests=5, child requests=2, external requests=0; the additional root input was a real subagent-settled notice, not polling.
- Dedicated browsers and both hosts were closed; ports 40123/40124 were left unbound. The optional pre-existing OpenTelemetry plugin import warning was not treated as a failure or as resolved by this package.

The artifact-before-terminal-marker crash was first reproduced as `PTC_RESULT_CONFLICT`; its failed report is retained at `output/regressions/2026-10-11T22-54-45-509Z-fed2eaa9`. The first real Web host also exposed the caller-context injection error. Neither failed attempt is counted as acceptance. Initial Team-lab setup used the wrong prompt shape and roster-return field; it was repaired against the native API, not by changing Team behavior.

## Evidence And Rollback

- Machine acceptance: `D:/dsh-test/output/ptc-background-20261011/acceptance.json`.
- Source hash: `e963d7b04a01c88c2f6d3b467f35a475983a0d4bb8108c484f3254fb1e079535`.
- Fixture hash: `50a63c8c963d4e83983c66af51ff58a0149a8780d9118b15b5e422519aae0a20`.
- Durable isolated record: `ptc-background-20261011-e963d7b04a01c88c`, status `passed`, under `D:/dsh-test/output/ptc-background-20261011/home/team-control-plane/default.json`. A separate process read the canonical snapshot and matched status/source/fixture hashes.
- Original staged source backups: `D:/dsh-test/backups/context-runtime-ptc-background-20261011/`. Headless, manifests, pins and original type declarations: `D:/dsh-test/backups/context-runtime-ptc-background-closeout-20261011/`.
- Web evidence: `staging/context-runtime-unified-20261001/lab-runs/ptc-background-e3229be6-fae5-4d07-aadd-0ff900f556fe/evidence.json`.
- Native Team evidence: `staging/context-runtime-unified-20261001/lab-runs/ptc-background-team-1360972d-e6a1-4f7b-9cce-eae3210cb0bb/evidence.json`.

Do not remove native readers, markers or artifacts after enabling sessions that have pending jobs. Disable new opt-ins, drain or reconcile existing owned work, preserve receipts, and then prepare a scoped rollback. No production rollback or live HMR is claimed here.

## Remaining Boundaries

Independent security review was not obtained. Live interactive approval handoff and real-provider response quality were not established by these fixtures. Production opt-in remains off; this report does not claim whole E0-E8 completion or token/cost savings.

Sampling preemption releases only foreground waiting. Explicit job kill or owner teardown aborts the original runtime; already-started child effects drain and receive individual receipts before settlement. A non-cooperative child is not promised to stop instantaneously.
