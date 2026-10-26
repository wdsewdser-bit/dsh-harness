# Long-test driver repair,2026-10-19

## Scope

The user asked to continue fixing the exposed issues. This change creates a NEW
output-only driver at`output/agent-team-longtest-repair-20261019/driver`. It does
not edit the immutable prior driver, trial journals or failed report. It does not
change product code, production permissions, active Teams or the global model
configuration. No paid model request or new three-hour test is part of validation.

The old primary trial stopped after approximately61 minutes. Its initial response
was truncated at4096 tokens. During phase2 its own lease was expired, but physical
native records show the model LEGALLY reacquired a fresh lease for the same task.
The final abort came from repeated attempts at directory inspection not in the
fixture's command allowlist. Therefore the repair does not bypass, disable or
artificially renew native write leases, and does not claim a core lease defect.

## Changes

- One16384-token campaign output contract is checked against the actual local
  model declaration, applied at creation/resume and at the transport boundary.
  Requests within16384 are no longer clipped to4096; malformed settings remain
  fail closed. This reduces this known clipping cause, not a guarantee against
  all future max-tokens responses.
- Each genuine scheduled user requirement asks the model to create its own NEW
  native Goal. Native goal-round-driver is enabled, retaining its intrinsic
  default256-round safety limit. The driver waits for the NEW Goal to complete
  and the Team to settle, rather than treating whenIdle as task completion. Old
  completed Goals, missing Goals, active/disarmed, paused or blocked Goals cannot
  pass. No corrective operator followups or operator-written completion state.
- Physical acceptance and cold verification require model Goal creation before
  task creation, real task completion, the completed lease receipt, and only THEN
  model Goal completion. The four existing phases, exact Git artifacts, two
  original independent peers, final-file checks and report consumption remain.
  A failed finite phase fails the attempt rather than admitting later requirements
  on top of unfinished work. Early exit is never described as three-hour success.
- Native read/glob discovery is unchanged. A small exact allowlist admits only
  read-only directory inspection of the current fixture. Redirects, suffix
  commands, outside paths, arbitrary shell, peer writes/Git/spawns/lease mutation
  and quiet-time shell polling remain denied. A valid PowerShell inspection is
  tested against an actual isolated directory. Normal native sandbox enforcement
  and all exact write paths remain intact; no universal shell/TOCTOU safety claim.
- Lease release acceptance recognizes the real SDK receipt when addressed by
  task_id as well as run_id. It still requires the exact returned runId/taskId
  and completed status. It does not fabricate a missing release or alter native
  state. Model instructions use ordinary own-lease acquisition/recovery only.
- Preflight pins the three actual native Goal modules as well as the unchanged
  product/production inventory. The same pins are checked on teardown and cold
  restore. Isolated native port40144, dedicated TEMP, bounded cancellation and
  owned-child watchdog remain; launch still creates one fixed10800000ms clock.

## Validation and Remaining Gate

Validation runs only local syntax checks, the budget/oracle selftest, focused
behavior tests and immutable historical native-log replay. The selftest admits
more than300 logical/transport fixture records, enforces one-time clock creation
and rejects an expired deadline; these are synthetic local admissions, NOT model
requests. Existing max-tokens and sandbox capability failures remain recorded.

The validator freezes the new driver without launching it or initializing its
real budget. The validation result is scoped to the driver repair. Three-hour
natural acceptance, current production code loading, production deployment and
the old unknown temporary-directory deletion owner remain unaccepted/unresolved.
No new recurring automation or monitoring is created. A newly authorized natural
trial must use its own once-only budget; no historical clock is restarted.

## Actual Local Closeout

The validator actually completed exit0 at21:22 UTC:53 behavior tests passed,0
failed/cancelled/skipped; all13 driver mjs/cjs sources parsed; the budget/oracle
selftest passed. The real-directory PowerShell inspection and historical native
Goal/lease receipt replay passed. No provider model request, native host startup,
real driver budget initialization or production write occurred.

The new immutable report binds50 artifacts, including the frozen driver and its
snapshot. Canonical isolated evidence record:
`longtest-driver-repair-20261019-2973129be55dca5a`, status **passed** in the limited
driver-repair scope. Fresh readbackPID45120 verified50 new and1635 previous
artifacts; the prior long-test canonical remainsfailed. Product365+11,
production227 and baseline600 facts are unchanged.

Report SHA256:`a86a6628365b54a13079b252a878ccedb65dacabf38b588cf4b42122a9b3c9ae`.
Fingerprint:`260dcf119a94d9a85619e57500e7c60786e36a9039533464c791761e2b693c5e`.
No three-hour natural acceptance, new native Goal-round firing, production loading
or old temporary-directory root-cause repair is inferred from these local tests.
