# Evidence Reducer 离线历史回放

## 后续更正

本文是 2026-09-30 的离线 mock 快照，不是当前运行态或真实效果报告。
最新恢复入口：`D:\dsh-test\docs\usage-audit-20261001\README.md`。
历史回填已覆盖两个工作区并按 root Team 聚合，已记录 total 为 44,011,704,608，
仍有 181 条 total 缺失；旧 169.46 亿 cache 是子集，不能当全部历史。
本文的 90.571% 只是 mock 引用渲染后的估算单位变化，未验证任务关键证据召回，
不能当作 DS4.1Flash 的真实压缩收益或线上部署验收。
本轮真实实验在独立 `usage-lab-20261001` 工作区进行，不启用生产 Reducer。

## 结论

Evidence Reducer 当前没有线上真实调用。问题主要是部署验收没有完成真实路由闭环，而不是历史数据不足：当前会话路由解析到 `opencodego`，但运行配置 `localProviders: []` 且 `remoteAllowed: false`，所以每个超过阈值的结果都在 `route-not-allowed` 门禁处停止。

本次使用本地历史归档做了隔离回放。回放没有调用 provider、没有修改 session/spill/telemetry、没有修改 profile、没有重启 DSH，也没有中断活动 Team。

## 当前运行态快照

- Reducer telemetry: `D:\dsh-test\home\team-control-plane\mechanism-telemetry-evidence-reducer.json`
  - mtime: `2026-09-30T16:38:48.366Z`
  - SHA256: `DDD83359E78286A9500EC5B29FE8A72A46D7E0C2DA27886EF82AA41E0546D929`
  - events: `159320`
  - fired/reduced: `0`
  - skipped: `below-threshold=151522`、`route-not-allowed=7855`、`disabled=3`
  - reducer input/output/cache/saved/quality metrics: all `0`
- ObservationPack telemetry: `D:\dsh-test\home\team-control-plane\mechanism-telemetry-observation-pack.json`
  - mtime: `2026-09-30T16:33:07.433Z`
  - SHA256: `013FBB41EB2AC80E63919FBFAC9964DF2568C937CBE411723DFE200A6D86E552`
  - events: `221031`
  - fired: `50021`
  - archived: `34245`
  - replaced: `15776`
  - estimated savedTokens: `742359130`
- Team usage cache: `D:\dsh-test\home\cache\team-usage-cache.json`
  - 40 sessions, input `473890340`、output `90676048`、cached `16381402483`、total `16945968871`
  - model fields: `deepseek-v4.1-flash` and `deepseek/deepseek-v4.1-flash`
  - provider fields are empty, so this cache cannot prove which provider/protocol produced the total.

## 离线回放

### 输入

- source: `D:\dsh-test\home\evidence-archive\objects`
- objects scanned: `5893`
- all `5893` objects exceeded the `20480` byte reducer threshold
- total archived bytes: `3358246640`
- approximate original units (`text.length / 4`): `662977159`

The archive is the unique long-observation store. The 16.95B Team usage total includes repeated context/cache reads and is not equivalent to unique archive bytes.

### Method

For each archived object, the replay used the current reducer pure functions `buildBoundedInput`, `buildReducerPrompt`, `verifyReceipt`, and `renderReceipt`. A deterministic local mock generated at most three exact line quotations (up to 240 characters each). No LLM or HTTP request was made.

### Results

- receipt verification: `5887/5893` passed (`99.898%`)
- six failures were empty-first-line fixtures in the mock fallback, not provider failures; this replay cannot establish how a real model would recover or whether critical evidence would be retained.
- main-session-only estimate: `661401785` units saved (`99.762%`)
- reducer-inclusive estimate: `600467282` units net saved (`90.571%`)
- average original object: `112502` units
- average reducer prompt: `10237` units
- average reducer output: `103` units
- average bounded input: `50959` bytes

These are offline context-unit estimates, not tokenizer output, billing, KV-cache savings, or quality proof. The high reduction is an upper-bound replay over already archived long observations; it must not be projected directly onto all 16.95B usage units.

## ObservationPack 的 7.42 亿是否太少

不能单凭这个数字判断异常。原 4.38%/4.40% 使用不完整旧 cache 分母，现已废弃为收益结论。
机制 savedTokens 与 provider 累计 usage 不是同口径反事实；ObservationPack 只覆盖部分大工具输出，
不能覆盖历史 system SDK、思维内容、Team 消息与调用参数。

还要注意：

- ObservationPack 的 `savedTokens` 是 `Math.ceil(text.length / 4)` 的估算单位，不是 provider tokenizer token。
- 同一个 observation 在前两次全文发送后，每次后续携带 handle 都可能再次计入 savedTokens；它是未来上下文回传减少量，不是一次性去重后的唯一节省。
- telemetry 没有 provider/model/cache usage 对照，因此不能单独证明账单或真实 KV cache 下降。

## 交付判断

1. “之前部署没做好”需要精确表述为：离线机制与挂载完成了，但线上路由闭环和真实 reducer 验收没有完成；当前遥测明确证明 `0` 次真实 reducer。
2. 这次历史回放证明了 reducer 在本地归档上可以触发、能通过引用校验，并且在长日志上有很大潜在主上下文收益。
3. 还不能据此打开线上 Reducer。下一步若授权，应只把已确认的本地中转 `opencodego` 加入显式 allowlist，保持 `remoteAllowed=false`，先做极小批量真实调用并记录 verified receipt、provider/model/endpoint/protocol、主会话与 reducer 成本和质量回执。

## 边界

- 本轮未改变 `D:\dsh-test\home\profiles\{web,headless,desktop,teamtest}`。
- 本轮未启用线上 Reducer、未切换 Chat Completions/Responses、未重启 DSH、未清理 backup/spill/telemetry/session。
