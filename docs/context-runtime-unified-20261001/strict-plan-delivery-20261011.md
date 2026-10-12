# Strict Plan Delivery Acceptance

## Result

The scoped strict-plan package is implemented and verified in staging. It has not been deployed or enabled in production. No external provider was called and no production Team was started.

`session-plan-delivery.requirePlan: true` opts an exact allowed ordinary session in. `team-v12-runtime.deliveryPolicy.requirePlan: true` applies only to its tier-0 root. Existing legacy clean-board behavior remains unchanged when strict mode has never been enabled.

## Implementation

- A version-1 `native/goal-policy-required` event carries `requiresPlan: true`. Requirements are monotonic across the complete durable journal, not just the latest configuration or a WeakMap.
- Empty registered-plan sets return `required: true`, `deliverable: false`, and `DELIVERY_PLAN_REQUIRED` in strict mode. The actual Team tool also emits a blocker when no shared service is available.
- Goal completion rejects a durable strict requirement when a legacy gate reports unbound. A missing gate after cold restoration remains fail-closed.
- The server publishes an empty-plan `partial` event with the explicit code. Accepted events must still have nonempty, complete, receipt-backed plans. JSONL rejects invalid strict-marker types, unknown empty-plan codes, and accepted empty plans.
- The Web chat shows the explicit missing-plan status separately from raw assistant claims. Real plan registration, proofs, source-revision checks, and durable delivery receipts are unchanged.

## Verification

- Focused: 66 tests passed, zero failed. Summary: `D:/dsh-test/output/regressions/2026-10-11T13-39-34-279Z-b42265bf/summary.json`.
- Serial full regression: 229 files, 1469 tests, 1468 passed, zero failed, one existing skipped test. Summary: `D:/dsh-test/output/regressions/2026-10-11T13-45-47-661Z-16fd0a51/summary.json`.
- Ten edited runtime/tool files passed `node --check`. The web and headless plugin copies and source manifests were synchronized by `stage-closeout.mjs`.
- Real isolated non-Team host with the official PTC transport and a deterministic adapter: 15 fixture requests, zero external requests, zero agent errors, no goal, no Team events, no pending input at completion.
- Browser verified unregistered partial despite "All requirements are complete", registered partial, receipt-backed accepted, then partial after changing the real source file. Console: zero errors and warnings. Temporary host and the dedicated browser were closed.
- Native JSONL tests verify cold config downgrade, missing plugin, a deliberately legacy gate, valid receipt recovery, changed-source invalidation, and schema negative controls.

The first full regression attempt overlapped the UI host's experiment HOME and failed four host tests (`HOST_WRITER_BUSY`). Its report is retained at `D:/dsh-test/output/regressions/2026-10-11T13-40-31-843Z-0d5ddb6f/summary.json`; it is not accepted as a successful run. The successful serial run was performed after closing the UI host. The first focused attempt failed only because the new fixture authored an invalid assistant event; that fixture was repaired using the real native message shape without weakening assertions.

## Evidence And Rollback

- Acceptance: `D:/dsh-test/output/strict-plan-delivery-20261011/acceptance.json`.
- Host evidence and screenshots: `D:/dsh-test/staging/context-runtime-unified-20261001/lab-runs/session-delivery-016ab88b-79bb-4457-b641-7cdaee4300bc/`.
- Isolated durable record: `strict-plan-delivery-20261011-0552e8bc56b2fe51`, status `passed`, under `D:/dsh-test/output/strict-plan-delivery-20261011/home/team-control-plane/default.json`. A new process used the native control-plane snapshot to independently match status, source hash, and fixture hash.
- Original staged files: `D:/dsh-test/backups/context-runtime-strict-plan-20261011/`. Headless, manifests, and pins: `D:/dsh-test/backups/context-runtime-strict-plan-closeout-20261011/`.

Independent security review was not obtained. This report does not claim the whole P1-06 requirement, the Instant/PTC joint path, production enablement, or E0-E8 complete.

## Next Priority

Update, 2026-10-11: the scoped same-instance background package is now implemented and verified in staging; see `ptc-background-20261011.md`. The following paragraph records the earlier triage, not the current code's capabilities. Production enablement and broader quality boundaries remain pending.

The user explicitly requires Instant for Team communication and same-instance PTC background transfer. Current source inspection proves that accepted preemption recognizes only `source.kind=user`, while real internal Team routes use `team-message` and `team-wake`. Native started tools already survive sampling cancellation, but `executeToolCalls` waits for the whole PTC run; this does not release foreground waiting. PTC dispatch logging also requires an open turn, and the existing local jobs journal is best-effort. The next package must address trusted Team input admission, wait/execution separation, exact background dispatch relationships, and durable result/outbox recovery together. It must not rerun a cancelled program to pretend it migrated.
