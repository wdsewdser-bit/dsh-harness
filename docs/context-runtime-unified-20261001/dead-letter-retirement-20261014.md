# Dead-Letter Retirement Probe

Fresh isolated home dead-letter-20261014, byte-identical production plugins,
port40125. Prepare one root without prompting the model, stop the host, and
use the canonical isolated control-plane API to seed dispatch fixture
dead-letter-probe, target lead-a, from queued to timed-out. This is an explicit
seeded precondition, not evidence of a naturally occurring delivery timeout.

Restart the same home, 10 minutes and 24 cumulative terminal requests maximum.
Root spawns one tier-1 group lead, whose first action is to attempt expired on
its own dead-letter row. Expect dispatch-retire-scope, not dispatch-scope.
Root then reads the unchanged timed-out row, retires it to expired, and reads
it back. Require exact native tool returns and final durable CP state. No
permissions changes, task plans or production writes. Stop host and delete
isolated credentials after collecting receipts. Does not close the historical
41-hour stalled queue or the full S2 matrix.

## Result

Passed: 11 machine assertions, 9 real-provider requests. Scope is isolated-live
against byte-identical production plugins with an explicitly seeded timeout.
The fixture's first setup attempt was correctly rejected for jumping directly
from dispatch-created to timed-out; the valid queued intermediate was then used.
That setup error is not a production defect and was not counted as a successful test.

Root session-b7d6ec2b-d85b-4e8d-9cee-77f0242c70f6. Original tier-1 lead-a member
431f932e-f32c-4bbe-8658-862694d51150 targeted the row itself, so the ordinary
target/sender ownership check passed. Child native call sequence 16 was refused
specifically by dispatch-retire-scope. Root's subsequent native read still
returned timed-out. Root native update sequence 41 succeeded with expired,
follow-up read and independent final-control.json confirmed expired.

Machine evidence: output/live-replay-20261012/dead-letter-20261014/verdict.json.
Original receipts are in tool-events.jsonl; seed.json labels the precondition.
Initial host stopped before offline seeding, second host stopped at 08:35:39 UTC.
Both runs preserve six key production plugin hashes and their copies. The
production-file guard did not trigger, and isolated credentials were deleted.
No runtime code change, production deployment, or broader permission grant.

This closes the scoped dead-letter retirement authorization check only. It
does not show a naturally occurring timeout, repair the historical stale-target
incident, or complete S2/S3/S4. Next are the oversized deliverable and cross-turn
background-job probes; scratch sandbox design remains separate.
