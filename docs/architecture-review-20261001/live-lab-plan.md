# CLM isolated live session experiment

Status: runner prepared; no session created and no model request sent by preparation. Root must finalize schemas and stage prompts before live execution.

## Boundaries and commands

Only a new `D:/dsh-test/workspaces/clm-lab-20261001-*` directory and its fresh session may participate. Original root, provider resume, activeTeam, global thinking and provider configuration are excluded. Use the existing safe cookie/RPC helper; never print credentials, complete settings or raw journals.

```powershell
node D:/dsh-test/tools/clm-live-session-lab.mjs prepare --workspace D:/dsh-test/workspaces/clm-lab-20261001-<unique>
node D:/dsh-test/tools/clm-live-session-lab.mjs validate --workspace D:/dsh-test/workspaces/clm-lab-20261001-<unique>
# The next command requires explicit root execution authorization.
node D:/dsh-test/tools/clm-live-session-lab.mjs create --run --workspace D:/dsh-test/workspaces/clm-lab-20261001-<unique>
# Root then sets only the exact new session in context-workspace.appliedSessionIds.
node D:/dsh-test/tools/clm-live-session-lab.mjs run --run --workspace D:/dsh-test/workspaces/clm-lab-20261001-<unique> --stage <schema-bound-stage-id> --runtimeReceipt D:/dsh-test/docs/architecture-review-20261001/runtime-services.json
node D:/dsh-test/tools/clm-live-session-lab.mjs collect --workspace D:/dsh-test/workspaces/clm-lab-20261001-<unique>
```

The runner persists the minted session ID before create and prompt request ID before submit. Interrupted submissions are not automatically retried. Repeated completed stages are reported without another prompt; ambiguous attempts require collect/inspection. One exclusive workspace lock prevents concurrent runners. Creation never prompts the model. `prepare` and `validate` never use RPC.

Before every prompt require a <=60-second runtime receipt with `{source:'loaded-runtime-services',capturedAt,pid,labSessionId,services:{contextWorkspace:{pid,moduleHash,instanceId,config:{mode,appliedSessionIds},limits}}}`. `labSessionId` is the exact newly created root. PID must still be live; loaded module hash must match deployed web/context-workspace.mjs; apply requires its mode and exact allowlist. Root generates this through the loaded runtime service, after session creation and after any mode change. Disk configuration is not accepted as evidence. `settings/describe` verifies only the safe current provider route facts; C need not register a settings namespace.

## Verified rc2 API

Source: installed `D:/dsh-test/app/node_modules/@deepseek-ai/dsh-api-{session,workspace}-controller/lib/types/types.d.ts` and `typert.remote-client.d.ts`.

| RPC | Request | Result and use |
| --- | --- | --- |
| workspace/create | `{path}` | `{workspace:{workspaceId,path,...},created}`; adopt only new lab directory |
| session/create | `{workspaceId,sessionId}` | `{sessionId}`; exact pre-minted ID allows idempotent adoption |
| session/selectModel | `{sessionId,provider:'opencodego',model:'deepseek-v4.1-flash'}` | `{selected}`; session-local only, reasoning effort omitted |
| session/prompt | `{requestId,sessionId,mode:'queue',content:[{type:'text',text}],clientTimeZone:'Asia/Shanghai'}` | `{accepted:true}`; persisted user source.rpcId verifies admission |
| session/list | `{}` | `{items}`; running state, no status/config endpoint |
| session/projections | `{sessionId}` | `{asOfSeq,values}` or null; model selection/state support |
| session/updateQueue | `{sessionId,itemId,action}` | edit/remove/steer only; not used to submit this experiment |
| session/cancel | `{sessionId}` | `{accepted:true}`; only exact lab root/verified direct child |
| settings/describe | `{}` | Read namespace internally; retain only mode/allowlist route facts needed for gate checks |

The tool API must use final schema, not guessed fields. C source is `D:/dsh-test/staging/architecture-clm-20261001/home/profiles/web/plugins/context-workspace.mjs`; it exports `contextManageJsonSchema`. `context_manage` accepts `{action,input}`. Actions: state, memo_put, memo_get, memo_diff, propose, preview, commit, rollback. C requires a live Team membership plus control boards; a fresh ordinary session alone returns TEAM_IDENTITY_REQUIRED. Normal tools must establish isolated Team/task/goal/plan/lease as required; fresh root is not blanket authorized for product writes.

The table describes logical requests. The installed generated Host `TYPERT.invocations` exposes wire parameter names: wrap workspace/create and session/create/selectModel/prompt/projections/cancel/updateQueue as `{request:<logical request>}`; session/list as `{_request:{}}`; settings/describe has no parameters and remains `{}`. Only this runner adapts the existing raw RPC helper. The offline descriptor test compares every adapter method to the installed schema, so a TypeScript signature is never mistaken for a gateway body.

Final rc2 `agentTeams.tryMembership` automatically recognizes the fresh ordinary root as its own Team lead; a fictional team_create call is not needed. Normal team_control_status and review-task creation initialize its isolated control data. The final C tool now installs on all agents, then verifies Team/control authority during execution. The stage template uses only evidence-only tasks and fixture reads; it requests no product-file write, goal-driver activation, privileged override, edit plan, worktree, milestone compaction or run lease.

## Planned coverage

1. Bootstrap isolated Team and one direct child through normal tools only; ensure the scope permits fixture-only work. Do not bypass goal/plan/lease gates. Use no additional descendant.
2. Shadow memo put/get: sourceId, exact checksum, revision and parentRevision; second version; diff compares exact original versions. Reuse stale expectedRevision and verify canonical CAS_CONFLICT plus unchanged source revision.
3. Scope denial: the normal child attempts to read root-private member memo and receives MEMBER_SCOPE_DENIED; root-only synthetic cross-Team locator receives INVALID_LOCATOR. Preserve denied state and verify original memo checksum.
4. Shadow proposal/preview/commit: exact source references, expected view revision, pinned/select source. Receipt must say partial, originalHistoryPreserved, authorityPreserved, nextBoundaryOnly, shadow where specified. Compare subsequent request/ledger projection receipt to shadow before state.
5. Limited apply: root explicitly installs config.mode=apply with only the new lab session ID allowlisted. Repeat projection after boundary, verify context-workspace receipt in live request accounting, original authority/history preserved and exact fixture quotations recovered. Child remains excluded from apply unless root explicitly names it.
6. Team compact list/get: final compact and operation_id schema; verify stable tool output receipts and repeated same operation ID behavior against task/evidence revision. Query must not create a task transition or consume a pending action accidentally.

No stage prompt is emitted until final schema files are hashed and bound in lab-plan.json. Each stage contains id, mode (shadow/apply), prompt, reserve `{requests,inputTokens,outputTokens}`, receipts `{tool,action?,isError?,sessionId?,pointer,equals}`, optional projectionChecks `{transformId,status,sessionId?,minCount?}`, optional relationships between canonical receipts, and optional checkOracle. Assertions target canonical tool results; model prose is not proof. Root can supply schema-bound stages without changing runner mechanics. Projection checks inspect actual ledger context-workspace transform statuses `unchanged` or `applied` at the next model boundary. The bridge hashes C's semantic status into metadata; mode is established through live runtime facts plus canonical state/commit receipts, not a nonexistent ledger shadow/applied-allowlisted status field.

The final executable three-stage template is `live-lab-stage-template.json`: shadow-bootstrap, apply-child-operation, rollback-oracle. It reserves 15 logical requests, 920,000 input and 22,500 output; expected basic flow is eight logical calls, with any natural continuation included in the same monitored budget. The single verifier child makes one private memo read and stops. Root gets one ordinary wait_agent and one subsequent roster verification; wait_agent means one status change, so an active child after that verification aborts the stage without retry/poll. Quiet operation-id calls target that completed child and never use an action wake or team_delivery_check. Canonical duplicate message/dispatch IDs and task ID/revision/status/phase relationships are verified independently by the runner.

## Oracle and evidence

Fixture has 400 lines. Exact decisive source lines are 2 (expected checksum 7e2a), 173 (E_CLM_173, actual checksum 91bf, src/cache.ts:41), and 399 (blocked/checksum-mismatch). Archive SHA-256, complete quotations and original 1-based line numbers are independent of model conclusions. `fixture.json` includes the expected final JSON answer; validation also requires fixture.log remain byte-identical. Read full fixture through ordinary bounded file tools; memo_put uses the exact decisive quotations with explicit original line numbers, because a full 400-line memo exceeds C's 16,384-byte per-text bound. Keep the immutable oracle file intact and use separately named scratch files for allowed write fixtures.

Read only the newly encoded workspace journal directory. Require fresh non-seeded root header with exact cwd; child requires exact parent, origin=subagent, delegationDepth=1 and same cwd. For a normally forked child, use its last tagged `session/end-seed {inherited:true}` cut and exclude ancestor-prefix tool/usage events; retain the cut seq so aggregation never double-counts inherited history. Preserve journal hashes, canonical tool call/result callId+seq pairs, plus real `tool/ptc-dispatch-start` / `tool/ptc-dispatch` pairs with rootCallId/parentCallId/subCallId and structured child receipts. Preserve errors, session/turn/step, assistant settlements and final turn reason. Never emit raw journal. Usage ledger binds each assistant settlement to a unique same-session time window; missing or ambiguous correlation keeps evidenceComplete false. Aggregate root plus the verified direct child. Preserve ledger request IDs, session/root IDs, file paths, actual provider/model, request projection transform receipts and terminal token counters. Require successful terminal and fixture assertions, not only model-reported success.

## Budget and stop rules

At most 16 observable logical LLM requests across root and one child, input <= 1,000,000 (input+cache read+cache write), output <= 24,000 (reasoning already included), concurrency 1, total elapsed <= 10 minutes from first prompt. Reserve conservatively before each stage and poll live receipts each second. Unknown usage, provider failure, failed turn, limit, extra descendants or validation failure stop further prompts and cancel only minted lab root plus positively verified lab child. Cancellation and persisted stop reason prevent continuation without inspection.

This is an observable-budget monitor, not an HTTP hard cap: provider internal retries can exceed recorded logical requests; wire HTTP request count is unknown unless an explicit wire receipt proves it. Tokens spent between observation and cancellation can exceed a limit. A provider-level hard per-request output cap and retry cap would require separate verified integration, and are not silently enabled here.

## P2 protocol fixtures

TOOL-REF: plan a fixture that stores a canonical tool output identity/hash and requests exact bounded retrieval plus a missing/stale locator denial. SDK-CATALOG: plan exact schema manifest/hash version and missing/unknown tool rejection. CHECKPOINT: plan durable latest completed boundary ID, repeat-read and stale-boundary refusal. These are protocol fixture evaluations only; do not activate any new runtime feature or alter checkpoint/projection settings.

## Offline validation

`node --check D:/dsh-test/tools/clm-live-session-lab.mjs`

`node --test D:/dsh-test/architecture-tests/live-lab-runner.test.mjs`

Checks cover path/fresh-lineage isolation, exact fixture oracle, no RPC on prepare/validate, explicit run guard, route/limits/schema binding, cached token accounting, stop conditions, duplicate request receipt rejection and canonical tool evidence matching. Live outcome remains untested until root authorizes execution and final stages are bound.
