# Durable Delivery Stall Continuation

## Authorized Scope

Continue the next recorded P1 after the completed scratch backend. Current-code
triage, reproduction, repair if needed, service-level verification and staging
integration only. No production change/start/restart, active-Team intervention,
privilege widening, credentials, provider request, commit or push.

Historical input is the41-hour queued stall and old-recipient retry/recovery
observations recorded in the defect ledger1786/1810/1859/1898 and unfinished
summary P1#2. These old notes do not prove the current code is still defective.
Manual ack/retirement is not delivery recovery and cannot count as a fix.

## Acceptance

Trace actual service consumption of retry/recovery, not only pure state helpers.
Preserve canonical pending-message/ack state through durable reload and clock
advancement. Show eventual real service injection or an explicit truthful
blocked/stale/failed outcome, not indefinitely queued or falsely delivered.
No duplicate injection or resurrection of handled/rejected messages.

Recipient revocation or same-name/new-session membership must not inject into
the old native session. Do not silently retarget private messages to another
person. New routing requires explicit authorized durable binding; ambiguous
recovery must fail closed with an actionable status rather than a retry storm.

Canonical regression must exercise real plugin/service asynchronous consumption
and persistence with simulated native services/time if needed, marking that
simulation honestly. No model requests are needed for such delivery mechanics.
Review cross-session authorization/duplicate risks independently if changed,
then freeze source, run relevant full offline regression and final manifest/
headless/coupling checks. Preserve negative evidence and report exact hashes.

## Evidence Ownership

Implementation evidence: `output/delivery-stall-20261017`.
Backups: `backups/delivery-stall-20261017`.
Root-only production guard: `output/delivery-stall-closeout-20261017`.
This task does not rewrite the previous scratch backend evidence or baseline.

## First Review: Three Reproduced Gaps

Initial focused50 checks passed, but independent reviewer reproduced three
gaps in control15542372/tools2417e74e. Evidence:
`output/delivery-stall-review-20261017/review-result.json` and executable
`review-repros.mjs` (actual plugin/disk control-plane, simulated transport/flush).

1. Legal team_escalate does not supply the newly required target/message
   admission identity; native send0 while the tool returns delivered.
2. Only the immediately preceding episode is checked for an unconfirmed payload.
   A-failed, B-failed, A creates a duplicate native message for A.
3. Dispatch becomes terminal while admission persistence is awaited; send still
   occurs after flush returns, before any native admission existed.

These are current failed cases, not the documented allowed late completion of
already admitted native mail. Do not close this P1 from the first50 checks or
an unrelated all-green full run. Freeze until the running full really ends,
then repair all three with canonical regressions and targeted recheck.

## Final Staging Result

Completed this bounded repair package. Original historical41-hour incident has
no exact message/trigger, so this is not a claim that every historical incident
was reproduced. Current-code3 baseline red cases and the independent3 review
counterexamples were repaired with retained red/green evidence.

Final control hash8B21D33C5484E1931604E8250E1F22D524D8AF3F1152092B955A90286873AF0A;
tools hash9C5BBDB942D08DDDE0F9B196F208083102AEA95E864856E63DAA60DFEC6B08EC.
Escalation uses the same authorized admission and truthful status; persistent
cross-generation unconfirmed-payload index prevents repeat admission and fails
closed at4096 capacity or migration scan overflow. Flush return revalidates
dispatch/message/fence/index/target before any native send. Settled legitimate
later business episodes remain possible. Independent reviewer reran the original
counterexamples and boundary cases: all three findings closed, no new finding.

55 focused tests passed. Frozen final full241 files:1607 tests,1606 passed,
0 failed,1 existing skip; actual process exit0. Summary:
`output/regressions/2026-10-17T05-01-18-999Z-c631b56f/summary.json`.
Aggregate `output/delivery-stall-closeout-20261017/final-result.json` passed,
all pinned source hashes stable, web/headless and manifests synchronized,
stage closeout pending0, production8-file baseline unchanged. No host/provider,
credentials, live Team operation or production deployment occurred.

Boundaries: pre-index already archived history and production migration were
not verified. Already admitted native mail can still reach its original
authorized session after plugin timeout; delivery-failed is not native transport
cancellation. Native-service/persistence/transport fixtures are clearly separate
from a real-model or production delivery experiment.
