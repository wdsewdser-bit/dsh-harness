# S2 queued info retains original target across restart

Fresh isolated home output/live-replay-20261012/s2-queued-target-20261014.
Two serial hosts, each12min, cumulative32 actual provider-terminal cap,
port40125, production-plugin-byte-identical/no overlay/workspace-write/ask.
No staging runtime or production writes, task cards, permissions or rerouting.

Initial real root spawns two tier1 leads target-a/group alpha and target-b/group
beta. Both end initial turns, then root sends exactly one info to target-a.
Require native queued receipt and cold persisted inbox queued with target-a,
exact original body/message ID, and non-waking dispatch completed with matching
messageHash; both original child identities are
recorded from native spawn receipts. End initial host, no further provider work.

Restart same home. Independent cold snapshot must preserve that exact queue
row/dispatch target and original roster identities. Root confirms native roster
then sends exactly one action to original target-a, waits once. Original A must
read exact queued message ID/body through native inbox_list and return response.
Original B must have no new user input or turn beyond pre-restart event baseline,
and no target marker. No respawn/change target/retry. Cold final info row remains
bound to target-a. Stop both hosts, verify hash guards and delete credentials.

Scope: ordinary queued info continuity to original target with a negative-control
member across restart. Not same-name replacement, parent reassignment, a natural
41-hour incident, or proof of all stale-target variants. No ACK requested, so
final wake closure is outside this scenario. Preserve failed evidence.

Before restart prompt, the first precondition check incorrectly required info
dispatch status queued. It failed and stopped before any prompt was sent.
Production reconcileState explicitly completes non-waking notices because no
target turn acknowledgement is required; queued body stays in v12RoomWake inbox.
Production dispatchCreate stores messageHash, not plaintext. Update harness to
these consuming contracts, retaining exact body/target/ID in inbox and exact
hash/target/non-waking/completed in dispatch. Preserve precondition-failure.json;
do not modify production code or weaken recipient/negative-control checks.

## Result

Passed18/18 machine assertions,17 cumulative actual provider terminals(cap32).
Root session-e0c4301e-f552-4f07-a622-795546356049. Original A
f5c90a31-a42e-42d3-8d07-f67d47834483/tier1/alpha; original B
2a7ca451-10d5-49d8-8d5a-b5ff053f42bb/tier1/beta.
Info msg-e1292650-9c40-4056-9e4e-0d8127726786 / dispatch
dispatch-4229a7fe-854c-4fc0-8761-5e2938245197 remained byte-structurally identical
in cold before/after-restart snapshots: inbox queued/target-a/fullbody, dispatch
completed/non-waking/target-a/matching SHA256(JSON string). No premature wake.

Real restarted root roster retained both IDs and inactive status. Only action
to original A was sent. Original A native user input seq23 and inbox_list
result seq28 contain the queued info's exact message ID/body/target; response
and child turn-end seq33 completed, root turn-end seq95 completed. B's exported
user/assistant/tool/turn events stayed identical to pre-restart baseline, with
no target-A marker or new turn. No respawn/retry/target changes or extra sends.

Evidence: output/live-replay-20261012/s2-queued-target-20261014/verdict.json,
before-restart-events.jsonl, before/after-restart-control.json, tool-events.jsonl,
final-control.json, state.json, r2-state.json, plugin hash/signature files.
Initial host exec84798/PID9676 stopped20:06:32.447Z with10terminals; restart
exec64033/PID42184 stopped20:09:12.359Z with17cumulative terminals, requested-stop.
Waits31722/23244 terminal; cleanup credentialCopyDeleted=true/stillPresent=false.
Six key plugin copies remained equal to production and762-file guards saw no
production writes. Runtime/staging source was not modified; no deployment.

This closes ordinary queued-recipient continuity across restart. It does not
resolve historical41hour stale-target incident, same-name replacement or
parent-reassignment variants. Messages were intentionally not ACKed, so no
claim is made about final wake closure.
