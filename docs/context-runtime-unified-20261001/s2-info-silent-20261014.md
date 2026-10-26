# S2 inactive info/action isolated-live

Pre-register fresh home output/live-replay-20261012/s2-info-20261014,
production-plugin-byte-identical, workspace-write/ask, port40125, one host
12min/32 cumulative provider-terminal cap. No production writes or staging
runtime edits. Use real native roster, send receipts and persisted child events.

Phase1: root spawns exactly one lead member and waits for its initial final.
Record child's exact ID and initial turn/event baseline. Phase2: root verifies
member inactive, sends info only, then ends without waiting or action. Observe
at least 30 seconds after root turn end: no new child user input/turn/dispatch,
while native send receipt and durable control state retain exact info marker.
Phase3: root sends action once to that same member and waits once. Require
original child receives action, reads persisted info using supported inbox
tool, and reports both markers. No respawn, target changes, permission
expansion or retries. Preserve failures, stop host and delete clone credentials.

Scope: info does not wake inactive member, subsequent action delivery to that
same identity. Not stale-target rebinding or historical 41-hour incident.

## Result

Passed 15/15 assertions; actual provider terminals15 (cap32), one isolated host.
Root session-1ae677a4-2ce4-4ac0-bbb5-1ae2f83cc4b2 spawned exactly one child
517d9f9f-e973-4f4b-8fd5-3490eccf1ba0, info-probe/tier1/group probe.
Native roster confirmed inactive before info. Info receipt seq52 queued
msg-c3217823-824c-4943-86b8-5cfe1054d4a4. An independent cold snapshot retained
exact info body/status queued and no wake; child persisted event export remained
identical to initial baseline for35,446ms after root info turn end.

One native action subsequently targeted original info-probe; the same child
recorded native user input seq23, inbox_list result seq28 containing the exact
info marker and completed response/turn-end seq33. Root final turn ended seq83.
No respawn, extra sends, polling or permission expansion. This intentionally
does not ACK those messages and therefore does not assert final wake closure.

Evidence directory output/live-replay-20261012/s2-info-20261014 includes
initial-events.jsonl, silent-events.jsonl, silent-control.json, tool-events.jsonl,
final-control.json and verdict.json. Native user-message content is under
event.data.content, unlike tool/assistant messages under event.data.message;
assertion parser handles both without weakening the exact marker check.

Host exec18495/PID42288 stopped requested-stop at2026-10-14T17:55:15.065Z;
waits62089/47538/54420 all reached terminal state. Cleanup deleted the clone
credential copy. Six key plugin hashes stayed byte-equal to production before
and after;762 protected production files remained unchanged. No staging
runtime changes, production deployment, commit or push.
