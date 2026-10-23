# S2 B-221 legacy ACK-row rehydration isolated-live

Pre-registration: fresh isolated home output/live-replay-20261012/s2-legacy-20261014,port40125,production-plugin-byte-identical/workspace-write/ask. Two serial hosts12min/24cumulative provider-terminal budget. No production/staging runtime changes, deployment or permission expansion.

Initial host only creates an ordinary root session through native RPC, then stops with zero model requests. While stopped, canonical isolated CP mutateHot seeds v12RoomWake using production createWakeState/requestWake/deliverWakeBatch/handleInboxMessage helpers. Two short message IDs share one dedupe wake; first is acknowledged, second remains delivered. Remove only the first inbox row to reproduce the exact legacy missing-row precondition. ACK evidence and shared wake messageIds remain. Record this as a fixture, not model-authored history/natural incident. Durable seed snapshot MUST show the first row absent and its acknowledgedInbox evidence handled before proceeding.

Restart same isolated home; real root consumes native runtime rehydration. Model calls inbox_list pending-only, acknowledges only the open row by exact inbox_id, then inbox_list include_handled:true. Require first row reconstructed handled and never pending, second visible/acknowledged through native tool, both final handled, one shared wake/dedupe row, no fresh Team members or new sends, no duplicate storm. Isolated projection observer records actual adapter context/source IDs and snapshots, not model assertions. Independent cold final snapshot and stable production/plugin hashes establish persistent result. Stop/cleanup both hosts; preserve failures.

Scope: exact B-221 legacy shared-wake row variant. Not the historical41hour/stale-target incident, info semantics, full S2 or total release acceptance.

First probe s2-legacy-20261014:13/14 checks passed; old ACK row stayed handled, no duplicate wake, but open-body positive control failed. Native pending read seq20/result21 reconstructed open row with empty body; final cold state also carried that empty stub. Both hosts stopped,5terminals,credentials deleted. Do not count this as completed acceptance.

Focused source inspection identified fixture publication omission: native send-message mirror mutations calculate panelCache=true; native inbox_ack explicitly uses panelCache:true. The fixture generic mutateHot used only deferMs:0, so it persisted the cold full body but omitted the hot panel-cache publication that native runtime reads. This is a fixture error, not sufficient evidence of a product defect. No runtime code is changed to work around it.

Replacement fresh home s2-legacy-published-20261014 repeats exact same IDs/shared-wake/missing-ACK-row scenario and assertions. Only fixture mutateHot publication now includes panelCache:true, matching the consuming native writer. An independent fresh process must confirm hot history:false reads contain open original body while old row remains absent and acknowledged evidence handled BEFORE starting real provider revalidation. Preserve first failed verdict. Protocol remains12min/24requests per home,serial hosts,workspace-write/ask and byte-identical runtime.

## Result

Replacement passed all 14 checks with 5 actual provider terminals. Root session
session-6f05b1e1-e9a3-4d05-a64d-f1e01270e9e5 performed pending inbox_list at seq20,
only msg-legacy-open ACK at seq25, and include_handled inbox_list at seq30.
The legacy ACK row was never pending or reinjected into adapter context; the open
body was present in actual adapter context and native results. Both final rows
and the single shared wake are handled in an independent cold snapshot.

Evidence: output/live-replay-20261012/s2-legacy-published-20261014/verdict.json,
publication-check.json, tool-events.jsonl, wire-context.jsonl, final-control.json.
No send/spawn tools were called. Six key plugins remained equal to production
before/after both hosts, and the guard protected 762 production files unchanged.
Initial host used zero requests. Restart host stopped on requested-stop at
2026-10-14T17:49:58.145Z; cleanup confirmed its credential copy absent.
40123/40124/40125 are unbound; user's 8788 service is untouched.

This closes only the canonical seeded legacy shared-wake ACK-row scenario.
It does not prove a natural historical 41-hour incident or all S2 scenarios.
