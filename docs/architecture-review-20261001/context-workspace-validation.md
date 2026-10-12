# Context workspace: CLM-MEMO-01 / CLM-VIEW-02

Date: 2026-10-01. Implementation and offline validation only. Production defaults to `shadow`.

## Scope and actual behavior

`staging/architecture-clm-20261001/home/profiles/web/plugins/context-workspace.mjs` implements one `context_manage` tool and `contextWorkspace` service. Actions: `state`, `memo_put`, `memo_get`, `memo_diff`, `propose`, `preview`, `commit`, `rollback`.

Tool schemas register on every real agent, including fresh sessions before Team creation. Registration grants no storage access: every execution resolves current live identity/Team/control permissions. A fresh standalone agent returns `TEAM_IDENTITY_REQUIRED`; after the same agent joins a normal Team, the already registered tool works without an additional `agent/created` event or HMR.

Identity comes from the exact live agent in `ctx.agents.list()`, `ctx.agentTeams.tryMembership`, `team-policy`, and the existing `controlPlaneForMember`. Tool arguments cannot choose caller identity, Team, owner, tier, or store paths. Each Team has a SHA256-named durable workspace file. Member memos are private even from other Team members with root tier. Task memos use canonical board occurrences (not global mirror copies) and current read permissions; creating/updating a task memo also requires the task owner or root tier. A memo remains writable only by its creator.

Object writes reuse v14 lock + atomic durable JSON writes, reload under the lock, and require `expectedRevision`. Optional `parentRevision` must match. Each object keeps bounded immutable version history, text SHA256, bytes, provenance refs, TTL, and tombstones. History/quota exhaustion refuses new writes rather than discarding originals. Tombstones and current TTL revoke old public locators; the owner can explicitly recall a tombstoned exact version with `includeDeleted:true`. Expired objects are retained on disk but are not returned or applied.

Every stored object requires all metadata fields with exact types and bounded revisions/TTL, and a canonical `integritySha256` covering text hash, scope, owner, provenance, timestamps and tombstone. Missing TTL/deleted/ACL fields refuse recall and application; text corruption reports `STORED_HASH_MISMATCH`, changed metadata reports `STORED_METADATA_HASH_MISMATCH`. Old rows without this integrity field fail closed; there is no implicit legacy repair. View/candidate metadata also has canonical integrity hashes, and rollback validates the selected historical view hash before compiling or signing another revision.

Locators are only `context://<team-hash-24>/<sourceId>@<revision>/<sha256>`. They resolve known stored objects and verify the stored original bytes/hash under current ACL. They never open arbitrary filesystem paths. `memo_diff` returns the two exact versions, not a lossy patch. `evidenceRefs` currently bind other stored memo objects by ID/revision/hash; task memo refs must point to the same task scope, preventing private memo hash/locator disclosure. Existing authoritative evidence remains in its original platform surface; this tool does not import arbitrary evidence files or create acceptance proof.

Views have independent CAS revisions, parent revisions, SHA256, and rollback history. A proposal expires after one hour; each member/session has one pending candidate. Commit validates the candidate against current object hashes, ACL/TTL, provenance, recovery anchors, and source pack budget. It does not interrupt execution. Every request boundary reloads the committed view; preview and request transformation only read storage.

The compiler reuses v12 `createContextSource` / `buildContextPack` and v14 `captureMemberMemory` / `buildMemberRecoveryPack`. A summary requires a stored task memo whose current authoritative task is completed/resolved. Its exact original locator/hash and refs survive. Unknown source IDs, unverified completion, missing/truncated recovery anchors, expired/revoked provenance, unknown message blocks, pending tool chains, source loss, required-source budget loss, and corruption reject the candidate or return the unchanged request with a reason.

**Partial CLM integration:** select/pin/exclude/replace_summary operate only on stored memo sources. They do not remove or rewrite existing user, assistant, reasoning, tool call/result, or Team authority injection. The original journal/task/lease/permission/phase/evidence remain unchanged. Applying a view appends a canonical `user` message with `source.kind=context-workspace-data` and JSON-quoted non-authoritative notes. Literal memo `<system>` text cannot change message roles or platform permissions. This is not a free history editor or a legal history checkpoint implementation.

## Loading and schema

Register the profile plugin after the request projection bridge and Team identity/control services are available. Bridge registration is `register('context-workspace', service.project, {order:30, preview:service.project})`. The transform is pure; no dispatch hook or delivery cursor is required.

The bridge must expose `isAgentLoopRequest(options)` bound to its actual official LLM module. Context projection requires that WeakSet brand before resolving any session or reading workspace state; an unbranded request cannot borrow an allowlisted session ID. `contextWorkspace.runtimeFacts()` (also `stats()`) returns read-only pid/moduleHash/instanceId/config mode and allowlist/actions/limits, without note contents or secrets, for the root's loaded-runtime receipt.

Example profile plugin configuration (root-controlled, not a tool argument):

```json
{
  "mode": "shadow",
  "appliedSessionIds": [],
  "controlDir": "D:/dsh-test/home/team-control-plane",
  "directory": "D:/dsh-test/home/team-control-plane/context-workspace"
}
```

Only explicit `mode:"apply"` together with the exact current isolated session ID in `appliedSessionIds` enables append-only apply. Empty/missing allowlists keep all sessions in shadow. Auxiliary/compaction purposes remain unchanged. A `conversation` purpose is accepted.

`contextManageJsonSchema` exports the complete standard JSON schema. `contextManageParameters` exports its parameter property map. The installed `@deepseek-ai/dsh-tools` DSL rejects maxLength/minimum/maxItems and requires property-level `required:true`, so tool registration converts only shape/enum/required fields. The service independently enforces all count, byte, type, revision, TTL, and ACL limits.

The generated review artifact is `D:/dsh-test/architecture-tests/context-workspace.schema.json` (serialized directly from `contextManageJsonSchema`; 8 actions, top-level additionalProperties=false).

Limits: 32 KiB input; 16 KiB per original memo; 64 KiB output; 8 MiB Team document; 256 objects; 64 object/view historical versions; 32 view sources/operations; 16 provenance refs; 16 KiB compiled suffix; 3000 estimated v12 pack tokens; TTL up to 30 days (default 7 days). These token estimates are not provider token counts or cash savings. Cache debt reports suffix bytes, with provider cost unknown.

## Isolated new-session calls

Use a newly created, authorized Team member session. A standalone session without real Team membership returns `TEAM_IDENTITY_REQUIRED` and is not silently assigned root authority. Invoke `context_manage` through normal canonical tool calls with these JSON argument shapes:

```json
{"action":"state"}
```

```json
{"action":"memo_put","input":{"sourceId":"memo:investigation","scope":"member","text":"Observed result and exact citation notes","expectedRevision":0,"ttlMs":86400000}}
```

The put result returns revision, SHA256 and locator. Pass those actual values, not placeholder hashes:

```json
{"action":"memo_get","input":{"locator":"<returned context locator>"}}
```

```json
{"action":"propose","input":{"expectedRevision":0,"operations":[{"op":"select","sourceId":"memo:investigation","revision":1,"sha256":"<returned sha256>"}]}}
```

```json
{"action":"preview","input":{"proposalId":"<returned proposalId>","expectedRevision":0}}
```

```json
{"action":"commit","input":{"proposalId":"<returned proposalId>","expectedRevision":0}}
```

The next ordinary request reports shadow metadata and keeps the same message list. For an explicitly allowlisted isolated apply session, the next boundary appends scoped JSON data. `rollback` with `expectedRevision:1,targetRevision:0` creates a new revision whose source set is empty. Do not enable apply for production sessions as part of plugin loading.

## Offline validation

```powershell
node --check D:/dsh-test/staging/architecture-clm-20261001/home/profiles/web/plugins/context-workspace.mjs
node --test D:/dsh-test/architecture-tests/context-workspace.test.mjs
```

Result: 13 tests passed, 0 failed, 0 skipped. Fixtures use temporary isolated `DSH_HOME`, the real staged policy/control-plane/tool definitions, and v14 durable store. Cross-process fixture launches two concurrent writers for one object revision: one succeeds, one gets `CAS_CONFLICT`, and the original version remains readable. Tests also cover Team/member/group ACL including global board mirrors; caller spoof rejection; exact history/HMR service recreation; TTL/tombstones/hash mismatch; private-reference disclosure; view CAS/rollback/pins; summary source completion; pure preview and request projection; shadow/allowlist behavior; literal memo role preservation; unknown protocol/pending tool calls; loss/budget bounds; missing/truncated recovery anchors; and actual tool/schema/bridge registration. Three reviewer regression cases cover unbranded allowlisted session access, missing/changed TTL and other metadata on get/apply, and corrupted old view rollback without a new signed revision. A bootstrap regression verifies the same agent's tool exists before Team membership, refuses reads then, and supports private memo CRUD after normal Team identity becomes available without re-registering. Fixture controls are checked unchanged before the final explicit anchor-loss fixture modification.

No model calls, real Team changes, production configuration writes, service restart, transcript edits, authority updates, delegation, or cleanup of production data were performed. Live HMR installation and canonical new-session model consumption require root-level deployment verification; offline tests alone do not claim those runtime outcomes.
