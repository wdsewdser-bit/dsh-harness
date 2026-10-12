# CLM / DeepSeek-V4.1-Flash / DSH 后续工作上下文

> 目的：作为上下文压缩后的恢复入口，记录本轮对 CLM、DSH 当前架构、DeepSeek-V4.1-Flash 路由和 Evidence Reducer 运行证据的结论。
> 
> 证据快照截止：2026-09-30 15:36:51Z（北京时间 23:36:51）。文档实际写入时间以文件 mtime 为准；telemetry 仍可能继续增长。

## 用户确认的运行前提

- 三个 DSH provider 都是官方模型的中转，不把 `127.0.0.1:8788/v1` 自动解释成非官方模型。
- 当前主要使用 `opencodego`，配置中的 endpoint 是 `http://127.0.0.1:8788/v1`。
- 用户可以把 Chat Completions 切换为 Responses；是否切换要以真实协议回归和运行态回执为准。
- 用户希望先保留本文档，避免上下文压缩后遗失判断、证据和下一步。

## 当前结论

1. DeepSeek-V4.1-Flash 适合 DSH 的长上下文、工具调用和多轮 Agent 工作流。
2. CLM 最值得借鉴的是模型可维护的工作记忆、主动整理和有界预算；不能直接把 CLM 的自由文本 transcript 重写接管 DSH 的权威状态。
3. DSH 已有 context pack、增量 delivery、durable receipts、compaction handoff/recovery、ObservationPack、Reducer、cache monitor 和 compaction economics。下一步应在这些边界内增量改造。
4. DeepSeek 的官方 API 名称是 `deepseek-flash`，DSH 中同时存在 `deepseek-v4.1-flash`、`deepseek/deepseek-v4.1-flash` 和 `deepseek-flash` 这些路由别名。必须记录 requested provider/model、resolved model、endpoint/protocol，不能只看显示名。

## Evidence Reducer 实际审计

### 运行配置

- [web cordis.patch.yml](D:/dsh-test/home/profiles/web/cordis.patch.yml) 的 `evidence-reducer` 静态配置：
  - `enabled: false`
  - `routeMode: session`
  - `localProviders: []`
  - `remoteAllowed: false`
  - `thresholdBytes: 20480`
  - `maxInputBytes: 262144`
  - `maxInputLines: 4000`
- [evidence-reducer.json](D:/dsh-test/home/evidence-reducer.json) 当前内容显示 `enabled: true`、`route: session`、`revision: 175`。Reducer 代码会优先读取 Settings live section，再把 JSON 当兼容镜像，因此这个文件不能单独证明运行态已启用。
- `opencodego` 未列入 `localProviders`，而 `remoteAllowed` 仍为 false。对于 session route，这会把实际 provider 判为 `route-not-allowed`；这解释了大量拒绝，但不能在未做安全审查前直接放开远程路由。

### 真实运行遥测

文件：[mechanism-telemetry-evidence-reducer.json](D:/dsh-test/home/team-control-plane/mechanism-telemetry-evidence-reducer.json)

- SHA256：`CC4B677B758CF5D6985A7A21C833706D0175F9C8F1B72475B812FE1FB85B0D9D`
- size：`19019`
- mtime：`2026-09-30T15:36:51.4331514Z`
- 判定事件：`159280`
- session：`64`
- `fired/reduced`：`0`
- `lastFiredAt`：`null`
- skipped：`disabled=3`、`below-threshold=151432`、`route-not-allowed=7845`
- `inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens/savedTokens/modelTurns/toolCalls/qualityPassed/qualityFailed` 全部为 `0`

结论：线上 Evidence Reducer 没有完成过一次真实 reducer 调用、receipt 验证或质量登记。持续数天的上百亿 token 不能作为 Reducer A/B 样本。

### 对照：真正运行的是 ObservationPack

文件：[mechanism-telemetry-observation-pack.json](D:/dsh-test/home/team-control-plane/mechanism-telemetry-observation-pack.json)

- SHA256：`CD2D29033142B086F590C7AEABB7460111980F9245913B5C850B1ABE722AE927`
- 事件：`220980`
- fired：`49990`
- fired sessions：`90 / 101`
- `archived=34224`、`replaced=15766`
- `savedTokens=742232697`，约 `7.42 亿`，不是上百亿

这证明 ObservationPack 已经真实工作，但不能替代 Reducer 的线上验证。

### 全 Team usage 口径

文件：[team-usage-cache.json](D:/dsh-test/home/cache/team-usage-cache.json)

- 40 个 session 汇总：
  - input：`473890340`
  - output：`90676048`
  - cached：`16381402483`
  - total：`16945968871`，约 `169.46 亿`
- model：`deepseek-v4.1-flash=36`、空 model=3、`deepseek/deepseek-v4.1-flash=1`
- provider 字段为空，当前 usage cache 不能可靠区分 `opencodego`、`cmd` 和官方 provider，也不能按 Chat Completions/Responses 分组。

这确认用户说的“上百亿 token”在全 Team usage 口径成立，但这些 token 主要来自主会话、工具链和缓存累计，不是 Evidence Reducer 调用。

## 现有 A/B 证据边界

文件：[v13-mechanism-ab.json](D:/dsh-test/home/team-control-plane/v13-mechanism-ab.json)

- SHA256：`49C66A85F9653F478A320DDCCB02DCCC91801CB8390DB690D2E90528C1755DDB`
- 只有一个离线 fixture，`model=offline-fixture`、`fixtureVersion=1`。
- ObservationPack：`19764 -> 450 tokens`。
- Reducer：`19764 -> 352 tokens`，其中含 reducer 输入/输出成本。
- `qualityRegression=false`，但这只证明离线 fixture 机制可行，不能证明 opencodego/DeepSeek-V4.1-Flash 线上收益。
- durable evidence 目前登记的是 `v13-mechanism-ab-d6843bcd4fc015b2`，不是线上 Reducer 运行证据。

另有 compaction economics 影子遥测：`events=3247`、`would_compact=1124`、`deferred=2121`、`compacted=2`。它是压缩决策影子统计，不是 Reducer 质量 A/B。

## 对 CLM 的安全改造方向

### 适合加入 DSH

- `memo_put / memo_get / memo_diff` 形式的 task/member scoped scratch。
- memo revision、parentRevision、SHA256、evidenceRefs、locator、TTL 和 source manifest。
- memo 作为 non-authoritative context source，接入现有 `buildContextDelivery` 和 compaction recovery。
- 模型提交 memo 后走现有 handoff/acceptance gate；原文保留在 durable store/journal，可按 locator 精确召回。
- 保留 CLM 的预算 nudge、rollback/retry、observation handle 和 receipt 思路。

### 不能直接照搬

- 不把整段 DSH transcript 解析成普通 role/text；必须保留 tool-call、tool_call_id、reasoning_content、tool result 顺序和证据结构。
- 不让 memo 修改 task、phase、lease、permission、evidence 或 ledger。
- 不把 CLM suffix KV reuse 直接接入中转 API；只有拿到 provider/server 的真实 KV contract 后才单独评估。

## DeepSeek-V4.1-Flash 适配重点

- 官方 API 名称：`deepseek-flash`；当前 DSH 的 provider/model 别名需要在 request/header receipt 中归一化记录。
- 1M 是输入上下文上限，输出上限应单独记账；当前不同中转配置的 `maxTokens` 不能混为一个数字。
- 带 tools 的 thinking 请求必须保留所有相关 `reasoning_content`，不能只留下最终 content。
- V4.1 DSML 编码与 V4 不兼容；应以官方 encoding/deepseek-recipe 做 golden fixtures。
- 如果要在历史中间插入 tool calls，优先验证 Responses 或 Anthropic 协议；Chat Completions 的中途 tool-event 语义不同。
- 稳定的 system/tool schema/身份策略放在 prefix 前部；动态 Room、wake、任务进度、成本和 memo 放在尾部，以保留 prefix cache 命中。

## 下一步顺序

2026-10-01 更新：历史回填与新只读请求账本已经落地，当前恢复入口改为
`D:\dsh-test\docs\usage-audit-20261001\README.md`。
严格历史报告为 `history-2026-09-30T19-40-10-849Z-report.json`；
四份 profile 新账本 hash 为 `C8BFEB5C020C57D162799E4350980644752D1DF7EE5BC8B287EA3B6801FCB087`。
已有 root 的真实后续调用与独立 probe 已记录，DSH PID 16440 未改变。
此前上百亿的 Team usage 不是 Reducer 真实样本；当前 live Reducer enabled=true，
但 localProviders=[]、remoteAllowed=false 阻止 opencodego route，本轮没有修改这些开关。
原静态 enabled=false 和兼容 JSON 不能代表现在的 live Settings。
隔离实验不等于生产启用；以最新实验报告的质量、真实 usage 和边界为准。

1. 先做只读协议和路由探针：保存 provider、resolved model、endpoint、protocol、reasoning effort、usage cache 字段。
2. 明确 `opencodego` 是受信任的本地中转后，只把 `opencodego` 加入 Reducer 的显式安全 allowlist，继续保持 `remoteAllowed=false`；这一点需要单独备份、聚焦回归和运行态验证。
3. 在真实 opencodego/DeepSeek-V4.1-Flash 上跑小批次 Reducer shadow/applied A/B，记录 `reduced`、fallback、receipt-unverified、provider/model/endpoint、input/output/cacheRead/cacheWrite、耗时和质量回执。
4. 先验证 Responses 的工具/思维/中途事件 golden fixtures，再决定是否切换主路由。
5. Reducer 只有在线上产生足够的真实 applied、verified receipt 和质量样本后，才讨论从 shadow/off 提升为默认路径。

## 运行边界

- 本文档创建和审计没有修改 DSH profile、没有切换 Responses、没有启用 Reducer、没有重启 DSH、没有中断 active Team、没有清理 backup/spill/telemetry/session，也没有修改 RustMc 产品仓。
- 继续工作前应重新读取本文件、最新 reducer telemetry、`evidence-reducer.json`、当前四份 `cordis.patch.yml` 和最新修复台账；不要用压缩摘要替代这些证据。

## 公开参考

2026-10-01 架构复核入口：
`D:/dsh-test/docs/architecture-review-20261001/README.md` 和 `snapshot.json`。
本次已重查 CLM 固定 commit、实际 context 编辑行为及 DSH 当前代码与自然请求。
仅 memo CRUD 不等于完整 CLM；推荐在权威 journal 之外实现结构化工作上下文编辑。
新文档明确请求/压缩/预算差异、缓存冷债、Team 查询/通知机会和分阶段验收，均为待实施。
此前 runtime/telemetry/hash 数字仍为各自旧快照，不代表本次最新状态。

- CLM：[repository](https://github.com/facebookresearch/context-language-models)、[harness README](https://github.com/facebookresearch/context-language-models/blob/main/clm/clm_harness/README.md)、[suffix cache reuse](https://github.com/facebookresearch/context-language-models/tree/main/suffix_cache_reuse)
- DeepSeek：[V4.1-Flash model card](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash)、[encoding](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/tree/main/encoding)、[deepseek-recipe](https://github.com/deepseek-ai/deepseek-recipe)、[thinking mode](https://api-docs.deepseek.com/guides/thinking_mode)、[tool calls](https://api-docs.deepseek.com/guides/tool_calls)、[context caching](https://api-docs.deepseek.com/guides/kv_cache)、[DeepSeek-V4 paper](https://arxiv.org/abs/2606.19348)
