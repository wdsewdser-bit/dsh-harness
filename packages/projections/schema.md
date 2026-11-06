# Projection schema v1: additive delivery binding

TeamView.tasks[].delivery.certificateBinding is optional, not null. No certificate evidence => property absent.

Fields: certificateHash (SHA-256 of canonical signed certificate), taskId, verifier (member ID), contractRevision, candidate (commit SHA), tree (tree SHA), deliveryId, deliveryRevision, status (committed delivery state). attemptId is present ONLY when the signed certificate explicitly binds it and its committed attempt belongs to taskId. Legacy certificates without an attempt do not acquire one by inference. New Delivery.verify certificates sign taskId and the task's committed attemptId when present.

Projection checks canonical hash and signature. This binding describes the historical certificate, NOT an authorization or claim that the current contract/candidate is still valid; delivery.certificate remains the current validity indicator. No filesystem or Git read is performed by the projection. ACL follows the delivery and task rows.

## Memory retention
Team projection config `recentLimit` defaults to 256 (positive safe integer). Envelope retention reports this limit and historicalReplay=durable-event-log. Current nonterminal task/message/active or unknown attempt facts remain; terminal tasks/messages/attempts and internal checkpoints/intents/audits/manifests/claims/settlements share a latest-N archive window (updatedAt descending, id tie-break). This is projection eviction only: SQLite entities, event log and control semantics are unchanged. Pending current facts can legitimately grow and are not silently deleted. History and latency diagnostics are separately capped at N. Late archived message updates recover receipt times from durable history.
SSE keeps global seq, including ACL-empty deltas. Old cursors replay SQLite via streaming iterator; HTTP batches at most N deltas per pump and honors socket backpressure. Replay is CPU-linear in cursor age; there is no persistent projection checkpoint or event-log deletion. Cold rebuild applies exactly the same retention. Non-HTTP events() callers may request an explicit batch limit; unlimited compatibility calls can allocate a large result.

