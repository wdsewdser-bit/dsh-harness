# Real usage attribution lab results

Completed authorized observations with an original OP evidence-location failure retained. No more provider calls are scheduled. This is a direct HTTP isolated lab, not live DSH hook validation.

Workspace: `D:/dsh-test/workspaces/usage-lab-20261001`.
Provider/model/protocol: `opencodego` / `deepseek-v4.1-flash` / `openai-completions`, via `http://127.0.0.1:8788/v1/chat/completions`. Every request was sequential with max output 1,500. All returned the requested model. No production settings, active Team state or product were modified; no DSH restart occurred.

## Total real provider usage

| Calls | Input | Cache hit | Cache miss | Output | Reasoning detail | Total | Sum request latency ms |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 21 | 130044 | 5248 | 124796 | 7929 | 4846 | 137973 | 98153 |

Reasoning is a subset/detail of output, not an extra addition. Every usage field above was present in all 21 responses; no inferred grand total or missing-field substitution is used. Input equals reported hit+miss in these responses. The sum of request latencies excludes inter-request setup and human/agent waits.

Ledger postconditions: 42 events, 21 unique request-start IDs, 21 request-complete IDs, no request-failed events; the provider length failure is a completed HTTP response with finish_reason=length. Actual calls 21/24 and input 130044/200000. Failed and diagnostic calls are included in the total. An earlier progress message manually mis-summed cache hit as 5376; authoritative raw ledger and final report have the correct 5248.

## Controlled comparisons

| Batch | Input per arm | Replication and output | Evidence quality and limitation |
|---|---|---|---|
| Actual root schema | off 237; on 913 | Two counterbalanced pairs; +676 input in both. Output delta -888 / +389. | All exact error/line/checksum/status/three-quote checks passed. Provider-default thinking; output/latency are variable. Only one real run_code schema was attached. This does not measure the much larger PTC SDK block. |
| Representative Team injection | off 212; on 410 | Two disabled-thinking pairs; +198 input in both. Output delta 0 / -46. | All strict checks passed. Synthetic representative task/decision/inbox content; no real Team action. The prior default-thinking baseline is excluded from these pairs. |
| Prior history length | short 276; long 4244 | Two disabled-thinking pairs; +3968 input in both; output 146 each. | All strict checks passed. Synthetic 2 vs 48 prior messages. Repeated long prompt had 4096 cache-hit tokens and latency 2713ms vs first long 8181ms. Short repeat had 128 hit tokens. This is observed cache heat, not a proven isolated cache experiment. |
| Full log | input 8937; output 192; total 9129; latency 2070ms | One successful full baseline. | All exact source-line and quote checks passed. Synthetic 400-line fixture. |
| Existing OP handle | input 773; output 146; total 919; latency 6057ms | One observed failure, no retry. | FAILED: source-file location :41 was returned as original log line 41 instead of 173. Critical exact line/text recall 2/3. The current renderHandle preserved critical text but omitted its original source line index. Lower input is not a valid quality-preserving savings claim. |
| Real Reducer, all costs included | reduce input 1255/output 192 + answer input 677/output 146; aggregate input 1932/output 338/total 2270 | One targeted receipt+answer arm, two actual HTTP calls; aggregate latency 6417ms. | Plugin verifyReceipt passed, complete critical exact line/text receipt recall=1, final answer recall=1. Relative to full: input -7005, output +146, total -6859, latency +4347ms. No mock receipt was substituted. |
| OP line-index overlay candidate | input 886; output 146; total 1032; latency 2405ms | One diagnostic candidate call. | All strict checks passed. Overlay comes only from immutable fixture line/text pairs. New candidate, not production: no renderHandle fix or active runtime deployment was made. Original OP failure remains. |
| Real PTC SDK copies | one 34769; two 69491 | One independent disabled-thinking pair, output 11 each; input +34722. Latencies 4767/3249ms. | Fixed sentinel exact, no tools exposed or executed, both reported cache hit 0. This checks context sizing and basic task completion, not complex SDK-tool recall. Do not extrapolate to five copies or historical corpus savings. |

Raw call-level model, cache, output, reasoning, total and latency are in workspace `report.json`, `report.md` and append-only `calls.jsonl`. No tool schema/SDK text or authentication headers are present in final reports.

## Failures and settings boundaries

The initial local validator accepted quote arrays only, while the prompt did not constrain collection shape. Call 3 returned all exact quotes as named object values. Parent authorized accepting array or named-object values with identical strict line/text gates. The original stop remains in `report.pre-validator-fix.json`; `revalidation.json` records zero new provider calls. Three prior responses were revalidated before any resume, with no repeat requests.

Call 6 Team-on had finish_reason=length, output=1500 and reasoning=1500, and empty final text. It remains in `report.length-stop.json` and the final ledger/report. Parent then authorized request-only `thinking:{type:"disabled"}` with new matched Team baselines. Installed pi-ai explicitly implements this DeepSeek wire parameter; source evidence is recorded in `disabled-plan.json`. Every new disabled-thinking call reported reasoning=0. Schema results retain provider-default thinking; they cannot be presented as the same setting as Team/history/log/Reducer/candidate/SDK.

Call 16 OP handle had a genuine evidence-location failure. `report.before-targeted.json` preserves the stop. Parent authorized separate Reducer, candidate line-overlay and SDK hypotheses, not a blind repeat of the original plan. No exact-line validator was relaxed. The evidence supports preserving original source-line indexes in a candidate OP projection; it does not establish a production change or live DSH acceptance.

## Artifact binding and verification

- Run ID: `usage-lab-873f706d-79b1-4c89-bbaa-a60c083fc0fa`.
- Final report: `D:/dsh-test/workspaces/usage-lab-20261001/report.json`; SHA256 `697f1852d752ca8350b774625d93b672e1d508750d4e04f8497d4c419aff4441`.
- Raw ledger: `D:/dsh-test/workspaces/usage-lab-20261001/calls.jsonl`; SHA256 `9e8a4080259fada3a1d2eb072e5bbfec3576447e2f6f631becf461ae7e264aa6`.
- Runner: `D:/dsh-test/tools/usage-lab.mjs`; SHA256 `a3feb75197347d59a0bc77e6ff0e976d3504e7cb190b23859fab27133e257ffd`.
- Focused tests: `D:/dsh-test/usage-tests/usage-lab.test.mjs`; SHA256 `734dbd8592874c36dfb37e670e48ef8721db30c314b0ab202f4233904ea05d9a`.
- Private extracted root schema: 1 tool; SHA256 `88434e6bcb2cea12f30b73bb432cb8977b1fc6c97a291848a3f915e3872c1b01`; content excluded.
- Private SDK supplied by root: 144589 bytes per copy; SHA256 `36fb549199503b202530c0acc2f51f1a84e4dad808f1ccf6a05762d406ef215e`; source metadata `D:/dsh-test/docs/usage-audit-20261001/system-sdk-audit.json`; content excluded.
- Reducer receipt: `D:/dsh-test/workspaces/usage-lab-20261001/targeted-reducer-receipt.json`.
- `node --check D:/dsh-test/tools/usage-lab.mjs`: passed.
- `node --test D:/dsh-test/usage-tests/usage-lab.test.mjs`: 10/10 passed, including object/array quotes, missing/wrong quotes, null usage semantics, budget, disabled continuation plan and no-call execution gate.
- Prepared execution, explicit verified resume, disabled-thinking continuation and independent targeted execution all preserved one monotonic append-only call ledger without duplicate IDs.

## Interpretation limits

These are observed token differences, not known monetary savings. Prices and cached/uncached billing are unknown. Counterbalanced order does not establish cold caches or prevent cross-arm prefix reuse, and SDK has only one pair. The synthetic fixture is narrow and does not represent all tasks; the Reducer and candidate results are each one targeted arm, not a replicated success-rate estimate. The direct HTTP runner does not exercise DSH runtime hooks. Live DSH hook evidence belongs to the parent's separate session verification. No claim is made to precisely explain or reduce the historical 47-billion-token corpus.
