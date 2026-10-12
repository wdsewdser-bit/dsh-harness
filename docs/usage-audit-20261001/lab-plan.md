# Bounded real-usage lab

Workspace: `D:/dsh-test/workspaces/usage-lab-20261001`.

Preparation performs no provider requests. Execution requires explicit parent notification that the history backfill is finished and recorder installed. No DSH restart, profile mutation, Team action, product change, global protocol switch, or Reducer enable occurs.

Commands:

```powershell
node D:/dsh-test/tools/usage-lab.mjs prepare
node --test D:/dsh-test/usage-tests/usage-lab.test.mjs
# Only after the explicit parent notification:
node D:/dsh-test/tools/usage-lab.mjs run --ready history-backfilled-recorder-installed
```

The planned 20 sequential HTTP calls use the current web opencodego route, `http://127.0.0.1:8788/v1/chat/completions`, model `deepseek-v4.1-flash`, protocol `openai-completions`. Every call has `max_tokens=1500`, `temperature=0`, concurrency 1. The hard maximum is 24 calls and 200,000 input tokens, with conservative input reservation before every call and actual provider prompt usage after completion. Estimates are UTF-8 bytes/4, not a tokenizer measurement; a 1.6 multiplier plus 600 tokens/call bounds the plan conservatively. Authentication and quota failures stop immediately with no automatic retry. Existing nonempty ledgers refuse reruns.

| Batch | Controlled change | Trial order | Calls |
|---|---|---|---:|
| schema | Real root tool schema attached/absent, fixed fixture and prompt | off/on, on/off | 4 |
| Team | Synthetic representative task/decision/inbox context injected/absent | off/on, on/off | 4 |
| history | 2 vs 48 synthetic prior messages, same latest task and system | short/long, long/short | 4 |
| logs | Full synthetic log vs existing pure ObservationPack handle vs verified real Reducer receipt | full/pack/reducer, reducer/pack/full | 8 |

The schema is extracted from one actual root request/header in the assigned RustMc journal. Private schema is saved in the isolated workspace; final reports contain only source, request sequence, hash, count and byte size. No original request body or headers are copied to reports. Credential value comes from `OPENCODEGO_API_KEY` or the trusted home credentials `refs.OPENCODEGO_API_KEY`; keys and HTTP headers are never printed. The isolated HTTP session header is a fresh lab ID rather than the active Team/root identity.

Every answer must return the sole error code and original line, both checksums, blocked final status, and exact full-line CONFIG/ERROR/FINAL quotes. A shorter input with lost evidence is a quality failure. Reducer receipts must pass the current plugin verifier plus stricter exact critical quote recall before the answer call. Reduction uses the plugin's buildBoundedInput/buildReducerPrompt/callReducer/verifyReceipt/renderReceipt and an isolated llm.stream adapter whose payload reaches the same real HTTP provider; no apply hook or global settings change.

ObservationPack uses its existing pure projectMessages API with role `toolResult` for the local fixture; current DSH core GenerateOptions uses role `tool`. This is a mechanism experiment, not an assertion that the live hook projected a current core tool message. Active-session integration is the parent's separate verification.

Reports retain every call's raw usage and normalized prompt_tokens, prompt_cache_hit_tokens, prompt_cache_miss_tokens, completion_tokens, reasoning_tokens, total_tokens, returned model and latency. Missing fields remain null. Reasoning is not added again. Reducer arm totals include both reducer and final answer. Counterbalanced pairs do not guarantee cold caches or exclude prefix reuse; report cache fields per call and avoid a monetary savings claim without known prices. The fixture, Team context and history are explicitly synthetic. No attribution of the full historical 47-billion-token corpus is claimed.

Outputs: workspace plan.json, fixture.json, tools-schema.private.json, material.json, archive objects, append-only calls.jsonl, progress.json, per-reducer receipt JSON, report.json and report.md. The runner stops at the first provider or quality failure and preserves all acquired usage evidence.

Execution note: the initial run stopped after three provider calls because the local validator accepted only quote arrays while the task prompt did not constrain quote collection shape. The third response had all three exact line/text quotations as named object values. Parent explicitly authorized a bounded validator correction and continuation of only the 17 unexecuted calls. Array and named-object quotes now use the same strict exact quotation gates. `report.pre-validator-fix.json` retains the initial stop; `revalidation.json` records offline revalidation with zero added provider calls. Explicit `--resume verified-completed` rejects unsettled/failed calls, duplicate call IDs, noncontiguous trial completion and payload drift, then skips only fully validated completed trials. No prepared request payload or global configuration changed.

The resumed run reached six calls, then Team-on stopped with `finish_reason=length`, output=1,500 and reasoning=1,500, with empty final text. This is a genuine provider output-limit failure. Parent authorized one targeted Team-on request with `thinking:{type:"disabled"}`; installed pi-ai `dist/api/openai-completions.js` explicitly implements this DeepSeek wire parameter (lines 681 and 686; SHA256 `1e2097ced37cf0e21aa5711297eecc77916de8a4ed81a9019bc7d97b22825fa3`). The current custom opencodego route does not necessarily detect DeepSeek's automatic compatibility branch, so direct HTTP makes the parameter explicit. This is only a request-level experiment, not a production compatibility/configuration change.

```powershell
node D:/dsh-test/tools/usage-lab.mjs continue-disabled --ready history-backfilled-recorder-installed
```

Continuation preserves `report.length-stop.json`, runs new matched Team arms on/off and off/on, then history and logs with identical disabled thinking, including reducer calls. Six historical plus sixteen new calls total 22, within the original hard limits. The first new on call must pass all exact evidence checks and report zero reasoning before remaining calls execute. The original default-thinking Team-off is reported as incomplete and is never paired against disabled-thinking data. Schema remains under original provider-default thinking. `disabled-plan.json` records the authorized settings boundary, code evidence and complete revised call plan. Failure or unconfirmed thinking disable stops execution.

The disabled continuation stopped after call 16: current production OP handle preserved all three critical texts but its evidence excerpt omitted original line numbers. The model reported source-file position 41 as the log line instead of original line 173. Exact critical line/text recall was 2/3. This original OP quality failure remains authoritative; the validator is unchanged and production renderHandle is untouched.

Parent authorized independent follow-up hypotheses within the same 24-call/200k-input ceiling: one real reducer+answer arm (two calls), one diagnostic OP handle with a line-index overlay derived exclusively from the immutable fixture (one call, explicitly new candidate not production), and a one-copy/two-copy real PTC SDK sentinel pair (two calls). An individual critical quality failure stops that arm; later independent experiments can proceed. Provider or budget failures stop subsequent requests. SDK content is supplied privately by the root, never scanned again or copied into reports; metadata SHA is pinned. A candidate pass does not turn the original OP failure into a pass. Expected cumulative calls are 21, with no repeats of previous requests.

```powershell
node D:/dsh-test/tools/usage-lab.mjs targeted --ready history-backfilled-recorder-installed
```
