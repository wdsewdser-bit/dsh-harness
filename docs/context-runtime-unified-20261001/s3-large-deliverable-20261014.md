# S3 large deliverable isolated-live

Scope: production-byte-identical plugins in a fresh isolated home, no production deployment or permission expansion. Fixture setup is not a live model result.

- Home: output/live-replay-20261012/s3-large-20261014; port 40125.
- Budget: 12 minutes per host, at most 40 cumulative provider terminal records. Hosts run serially.
- Create a root session without a model prompt, stop the host, then use canonical isolated control-plane boardCreate/boardUpdate APIs to seed a group-world task owned by world-a. Deliverable is exactly 64,475 ASCII characters with deterministic markers and SHA256.
- Restart the same home. Root spawns a world group lead; that lead spawns one tier2 member world-a. Member reads task_contract_get only and returns length plus markers, not 64k text.
- Isolated observer records actual projected messages and context manifests, plus adapter-dispatch receipt when supported. It does not change messages or runtime plugins. Capture the injected task JSON and confirm preview <=4096, original length 64475, matching digest, fetch pointer, no safety debt. A transmitted valid context pack with empty manifest debt demonstrates no fail-closed rejection for that request, not a global runtime assertion.
- Native tool result must contain all 64,475 original characters with exact SHA256, in the actual tier2/group-world member session. Model statements alone do not count.
- Collect native events and cold control-plane snapshot. Stop both hosts, delete isolated credential copy, check production/copy plugin parity and provider budget. Preserve failed evidence without rewriting it into success.

Observed full-result transport: native tool result exceeds the inline limit and carries an original spill-path receipt. Full retrieval acceptance therefore checks the original spill body SHA256 and actual member read of that same receipt path, not the truncated inline text alone. This is normal bounded-output transport, not a reduced fixture.

Wait helper caveat: old s1-rpc wait reads state.json even for --run r2, so it returned host-stopped from the already stopped initial host while r2 was still running. No prompt was resent. Actual r2-state and durable turn/tool events are used for completion.

## Result

Scoped S3 isolated-live PASS: verdict.json has 11/11 checks true. Actual provider is opencodego/deepseek-v4.1-flash; original member world-a id 8ebf6a80-4c7b-4a99-8b55-ea39bad54b63, tier2/groupworld, spawned by world-lead.

- Native task_contract_get seq16/result17 carried the full-result spill receipt. Actual member pwsh seq21/result22 read the same file, parsed JSON and returned DELIV_LEN=64475 with correct head/tail. Independently captured full native result body matches original deliverable exactly, SHA256 e9ef7c9e2864d94cf38b66af0a70d79ff0fc0ca9ece23da8df2cb237f9b90544.
- Three task preview records in actual adapter dispatches show length bounded at 4096, truncated=true, originalChars=64475, matching digest and task_contract_get pointer. Corresponding task source appears in manifest.items and manifest.debt is empty. Receipt stage handed-to-adapter, requestId present. This establishes no fail-closed rejection of those specific actual requests; it is not provider-wire byte instrumentation or a global claim that all delivery decisions have failClosed=false.
- Cold final-control task is unchanged. No task/plan/contract mutation calls occurred. Model final is not the acceptance evidence.
- initial host exec56959/PID2976 stopped 08:43:42Z with 0 terminals; r2 exec4855/PID33384 stopped 08:48:40Z, requested-stop, 22 cumulative provider terminals. requests.jsonl has 18 projection dump rows; these counts are different measures, the 40-request budget is checked against provider terminal count.
- Native collector exported 73 events/3 sessions. Six production/copy key plugins match before/after. Guard protected 762 production files; credentialCopyDeleted=true/stillPresent=false. No staging or production runtime edits, deployment, commit, push or new automation.

Artifacts: output/live-replay-20261012/s3-large-20261014/{verdict.json,wire-context.jsonl,tool-events.jsonl,native-full-result.txt,original.txt,seed.json,final-control.json,cleanup.json,r2-state.json}.

Residual scope: not a full S1-S4 acceptance, not the historical S2 incident, no external security review. S4 background-job cross-turn behavior and verifier scratch sandbox boundary remain separate pending work.
