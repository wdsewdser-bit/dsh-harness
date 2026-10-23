# Board-aware Driver Repair,2026-10-20

The human requested `解决修复问题然后继续`. Only NEW isolated output is changed;
production,product modules,previous reports and original failed drivers remain
unchanged. This repair does not retroactively accept any three-hour test.

## Findings and Implementation

The actual policy module documents that ONLY the global board belongs to the
native Team domain; group/level boards are durable control-plane CAS boards.
The tool implementation routes global updates through ctx.agentTeams.updateTask
but group/level updates through policy.boardUpdateAsync. Control board mutations
persist and append board/task-updated audit records. Therefore requiring native
team/task on all board types was a wrong observer assumption,not missing product
persistence. No product patch or synthetic task projection was added.

New board-contract.mjs enumerates all boards,refuses ambiguous/mismatched task
identities and binds exactly one new completed task to each phase's admission.
Global still requires its real native projection. Group/level requires the
physical completion receipt and actual durable audit matching board,root,task,
actor,CAS revision,commit,evidence,time and current control revision. Unsupported
boards,missing/fake audit and mismatches fail. Existing native plan/evidence,
exact Git artifact,lease,peer tests/report-consumption and Goal gates remain.

Replaying the previous72-call run further exposed a legitimate failure: after
both peers' reports the root edited source/test again without final independent
rechecks. The old full phase remains rejected as PEER_SOURCE_READ_REQUIRED even
after correct board handling. Tests explicitly preserve that failure.

New review-contract.mjs prevents premature team_task_update complete admission
until both original peers read the final source,execute both commands after the
latest source/test edit and send complete reports consumed in a later actual
root request. Model must resolve denials through ordinary SDK within the same
requirement. Initial prompt states this contract. No runtime corrective human
input or operator state repair is supplied. Existing five-denial protection,
workspace/shell restrictions and native sandbox are unchanged.

## Actual Local Validation

94 tests passed,0 failed/cancelled/skipped; syntax17 files and exclusive-clock,
301 local admissions,deadline denial,four positive/negative oracle selftests all
passed. Includes full synthetic group completion plus all six physical shell
bindings,real historical group audit/Goal replay,old failure retention and live
admission negative cases. Validation made zero model calls and did not start a
host or initialize the real campaign budget. It is not a natural long test.

Result:output/agent-team-board-aware-repair-20261020/result.json,
SHA25607e2d2cef759fbaff030b72c024db2036d79a19b51147f6b54dc60a8d635b96e,
59 bound artifacts. Canonical board-aware-driver-repair-20261020-6fb5de783f20dc21
passed,independent readbackPID47408 passed. Previous266-artifact failed record and
365+11 source/227 production/600 baseline facts match. Native Goal modules are
pinned. Original TEMP deletion owner remains unknown; no general safety claim.

## Continuation

One new natural three-hour trial is authorized by the same direct human request.
Use a separate directory:output/agent-team-board-aware-retest-20261020. Its17
driver files are byte-identical to the frozen locally validated repair. Do not
launch or mutate the repair bundle itself. The new run's preflight has completed,
but acceptance requires its own actual terminal,four phases,native cold restore
and fixed duration. Previous failures never become success through this repair.
