# DSH 架构复核与 CLM 适配路线

日期：2026-10-01，北京时间。状态：首轮架构审查基线；部署结果和当前运行态以 `change-summary-20261001.md` 与 `implementation-ledger.md` 的最终收口节为准。

数据快照：2026-10-01 06:42:47 北京时间，即 `2026-09-30T22:42:47.273Z`。
`snapshot.json` SHA256：`605ed7233917c4d4725a59e73dbf8ce960caf896fc6dda62defa18714c78748b`。
快照来源仍在追加；以下数字只代表捕获时点，不自动代表最新全天数据。

## 1. 结论

下一阶段应从“少发几段日志”升级为“减少无效模型轮次，统一最终请求与预算，
让模型有约束地管理自己的工作上下文”。不需要替换 DSH、减少 Team 并行度，
也不应直接复制 CLM 的自由文本历史编辑器。

推荐顺序：

1. 先补请求投影、压缩、token meter、缓存归因之间的一致性与计量。
2. 并行优化确定性的 Team 查询开销、重复消息和无新事实的通知。
3. 复用 context source、memory anchor、durable store 和投影桥，建立 scoped memo 仓库。
4. 增加模型可提议的结构化 context edit，先 shadow，再在隔离任务有限 apply。
5. 大参数引用、按角色加载 SDK、合法历史检查点分别验证，不能作为默认盲删规则。

首轮审查阶段没有改 profile 或启用 Reducer；随后按用户授权完成了 A/B/C 部署、Team 依赖 HMR、隔离 PTC 实测，并在 CLM shadow 验收后启用受信本地 Reducer。没有切换协议、重启 DSH 或清理原会话、备份、归档、telemetry。

## 2. 审查范围和当前架构

复核了先前 CLM/DS 文档、v12 架构、v13 计划和台账、v13.2 复核、v14 交付与 PTC
契约，以及当前实际 web 挂载的关键请求、调度、上下文、工具和统计源码。
不是逐行审计全部依赖包或全扫所有 session；代码可触发路径不等于实际发生频率。

| 层 | 当前能力 | 本轮判断 |
|---|---|---|
| 宿主和会话 | rc.2、Cordis、原始 journal、session surface、原生 tools/jobs/FS | 保留为底座，不另写一套会话 |
| 模型与协议 | pi-ai、opencodego 本地官方中转、Chat Completions、thinking/tools | 协议别名、配置与 wire 证据分开；Responses 未重新测试 |
| 权威控制面 | task/contract/requirements/decision、owner/scope、lease、phase、evidence、acceptance packet | 模型 memo 不得覆盖这些事实 |
| Team 调度 | tiers/groups、Room、wake/inbox/ack、waiting、event continuation、provider block | 已有事件驱动底座；仍存在冗余通知与查询路径 |
| 工具和执行 | PTC/run_code、canonical 子调用回执、Action Fusion、worktree/delivery、浏览器/电脑插件 | 优先扩紧凑读取和引用，不再增加无界全值输出 |
| 上下文 | v12 context sources/pack、v14 memory anchors、强制与机会压缩、OP、Reducer | 已有预算和恢复，不等于可编辑 memo 仓库 |
| 最终请求 | request-message-projection、已认证 SDK 保留、OP projection | 已有可移除的消费层投影桥，适合 CLM 适配 |
| 统计与验证 | per-request ledger、历史回填、机制 telemetry、cache monitor、离线/真实 fixture | 能观察实际请求；缺反事实费用、真实前缀、完整 Team 覆盖 |
| 部署 | web/headless/desktop/teamtest；desktop 和 teamtest/plugins junction | 上轮六模块已同步；磁盘、挂载、运行证据仍要分开 |

已有能力不应重新包装成新功能：context pack、memory anchor、waiting、continuation、
PTC receipts、精确 SHA evidence、OP 归档、压缩恢复、SDK 五版本去重和 milestone 去重。

## 3. 已出现自然生产收益，但不可外推账单

快照按 requestId 去重 terminal，只统计当前 RustMc root 和已观测后代，排除 mock。

- 29 次 terminal，28 success、1 error，observed total `18,240,080`。
- 实际只观测到 root 与一位后代；后代只有 AUTH error，不是完整长期 Team 样本。
- 12 次成功自然生产请求带 SDK applied receipt，OP 在这些请求均为 unchanged。
- 12 次合计：uncached `576,041`，cacheRead `6,344,960`，output `3,646`，total `6,924,647`。
- 首次冷请求之后的 11 次：uncached 仅 `3,177`，cacheRead `6,343,424`。
- cacheWrite 和 reasoning usage 在这批均未知，不把 observedSum=0 解释为真实零。
- AUTH error 的 ledger 将 input/output/total 记录为0，但没有原始 provider receipt，
  本报告仅保留该记录值，不据此证明供应商未计费。

相邻真实请求的缓存变化：

| 请求 | Uncached | Cache Read | Output | Total |
|---|---:|---:|---:|---:|
| 投影前 | 199 | 711,808 | 227 | 712,234 |
| 首次 SDK 投影 | 572,864 | 1,536 | 263 | 574,663 |
| 下一次投影 | 226 | 574,464 | 192 | 574,882 |

输入约 `712,007 -> 574,400`，减少约 19.33%；这是相邻调用观察，不是同任务反事实 A/B。
首次改写早期历史伴随明显缓存失热，下一次恢复。后续 raw input 下降不代表首次或累计
费用下降；缓存冷债和实际单价须一起计算。

只比较头两次、暂忽略未知 cacheWrite，费用差表达式为：
`572665 * P_uncached - 710272 * P_cache + 36 * P_output`。
价格未知，不能据此给实际金额。假设 uncached/cache 单价比为 10、忽略输出差和其他变化，
约需 37 个后续暖请求的输入节省回本；这是示例，不是当前供应商报价或收益证明。
这说明 CLM 的上下文重写必须考虑缓存冷债，不能每一步随意整理旧前缀。

### 当前上下文的大头

最新捕获生产请求：`d1aa5278-136f-467e-b82f-8994885ca1c0`，约 `1,968,421` bytes。

| 分类 | Bytes | 占比 | 优化边界 |
|---|---:|---:|---|
| 历史 reasoning | 591,873 | 30.07% | 不直接删；先验证合法 compaction/checkpoint |
| 明确 Team 注入 | 397,497 | 20.19% | 优先减少未来冗余通知，当前事实/ack 不可盲删 |
| 工具调用参数 | 365,598 | 18.57% | 先改未来大 payload/code 的引用型接口 |
| System | 223,928 | 11.38% | SDK 已裁减；仍可评估按角色工具目录 |
| Assistant 正文 | 175,623 | 8.92% | 完成阶段后摘要，保留用户约束和结论来源 |
| 普通工具结果 | 106,976 | 5.43% | OP/Reducer 只能覆盖这一部分及其适用子集 |
| 未分类注入 | 96,969 | 4.93% | 先补来源归因，不猜成 Team 开销 |

这是内容字节占比，不是 token 或费用占比。继续只处理长日志不会覆盖最大的三块。
历史峰值日 `5,538,603,165` total，cacheRead/uncached/output 约 95.00%/4.41%/0.59%，
仍以历史回填报告为准；40-session 旧 usage cache 不是完整历史。

## 4. 当前代码确认的优化机会

### P0：统一请求计划与实际预算

`ptc-sdk-retention.mjs:105` 对 auxiliary purpose 跳过；compaction-basic
`lib/index.js:312` 设置 purpose=compaction，`:695` 重放原 surface。
因此主请求已裁剪 SDK，压缩请求仍携带旧 SDK，改写位置后的字节前缀不一致。
实际 compaction miss 增量尚未知。不能直接删除 purpose 防线：摘要看见的历史文档、
tools、toolHistory、reasoning 和证书契约须单独验收。

`step-compaction-v4.mjs:217/:506/:623` 仍 meter.measure(session)；官方 token-meter
`:646/:654` 测原 surface，usage 小于原估算时不会自动采用下降后的 baseline。
可能保守高估并提前压缩/拒绝，实际发生次数未知。

建议统一 RequestPlan：保留原始安全上限，同时单独计算最终投影后的消费大小、
编辑成本、预计缓存破坏。native adapter 和账本消费同一个已准备快照，不能计量时
再调用一遍有状态 projector。OP sentCount 当前在投影函数 `:318` 递增，尚未确认
adapter 已实际发送；应明确 attempted/handed-to-adapter/provider-receipt 的计数语义，
不要把取消、拦截或辅助请求算成“模型已经看过全文”。

### P0：修正缓存和节省归因

`team-v13-cache-monitor.mjs:32/:37/:91/:100` 选最新机制事件，不限定 session/严格
时间窗口；time=null 时可把未来事件当关联。已观察首轮 SDK applied、OP unchanged
却被标为 observation-pack/ptc，机制时间还晚于请求。

应以同 requestId 的实际 projection receipt 归因，unknown 就 unknown。
补 before/after bytes、source hash、最长共同前缀/最早改写位置、workflow/turn/task ID、
providerRequestId、价格版本和 quality/evidence 关联。预测字节/估算 token 与 provider
usage 分开；OP 的 modeled savedTokens 不能当账单反事实。

### P1：确定性 Team 查询性能

`team-tools-v2-r10.mjs:6965` 对整板每卡 projectReady，`:3464` 每卡再构造全 Team
ready queue，分页在 `:6977` 才做。limit=1 也不能避免多次全量派生。
改为本次查询共用一个权威 revision 快照，构造一次 ID->ready-row 索引；不跨 revision
偷用旧缓存。属于直接降低 Node 工作和等待，不依赖模型学会新流程。

### P1：减少无新事实的唤醒和重复消息

`team-activity-digest.mjs:236-253` 只看 snapshot.active，把十分钟时间槽放进新 episode
后 followup，未比较上次有效进展。同事实下个槽仍可唤醒。应改为按事实变化与真正
到期责任判定；保留独立 idle/Room/SLA/provider-blocked 和 wake/ack 机制。
此处尚未量化实际浪费轮次，不能用配置推断每天发生 144 次。

`team-tools-v2-r10.mjs:3854-3893` 先 roomNotice，后验证 action/decision task snapshot；
quiet info 每次 inject/dispatch，无 caller operationId。
建议先鉴权和 revision 验证，再以 sender/target/task revision/event/delivery 的业务键
幂等提交，返回已有真实回执。不能按相同文本永久去重合法的新 episode。

### P1：紧凑且可按需展开的工具读取

task_list/get、evidence_query 多为全值，缺 view/fields/changed_since。
建议统一只读 control_query：精确 taskIds、compact/full、snapshotId/revision、分页游标，
先做权限过滤再投影。查询只给当前决策字段，全文用 ID/revision 展开。
这比让模型拿全板再在 run_code 中过滤更稳健，也不会把 compact view 当完成证据。

### P2：大 payload/code 引用与工具目录按需加载

未来新增受权限约束的 artifact/payload 引用：path/objectId + SHA256 + size + schema。
先在运行时校验并还原 canonical 参数，再交给现有工具权限门禁；记录真实解析值与回执。
代码文件执行需显式授权、预期 hash 和同工作区路径，不自动执行任意检索到的文件。
不要直接改旧 assistant tool-call 参数为 locator，尤其不要破坏历史 call/result 对齐。

可评估静态核心 SDK + 角色/namespace 工具目录 + 按需 describe，避免每个成员携带
全部工具文档。先统计实际工具覆盖，再测试 schema 找回率和额外 lookup 轮次。
现有 SDK 证书只有五个 hash，新工具生成未知 SDK 会 fail-open 保留旧版本；每次 schema
变更必须有兼容性迁移和 golden，不能假设旧 SDK 去重仍命中。

### P2：Reducer 先证明净收益，再按受信路由打开

首轮审查时 enabled=true 但 localProviders=[]、remoteAllowed=false，生产 fired=0；最终按用户授权改为仅 allowlist `opencodego`，仍保持 `remoteAllowed=false`。当前历史 fired 仍为0，不能把配置启用误报成真实 receipt 收益。
候选先归档再 routeAllowed，存在无 reduction 的 I/O；是否提前 skip 要保留留证用途。
已有真实 fixture/离线回放不等于生产质量。应只对受信任 route、任务相关长日志做
小规模 shadow，比较主会话+Reducer+召回+缓存冷债的总量与质量。

## 5. CLM 到底该借什么

官方固定 commit：`c979956b75d16f4c734a778ad832cbbcd20d78f5`，提交于 2026-09-30。
论文：[arXiv 2609.37725v1](https://arxiv.org/html/2609.37725v1)。

CLM 不只是 memo：模型修改一个上下文文件，下一轮直接消费修改后的历史。
[context_string.py:104](https://github.com/facebookresearch/context-language-models/blob/c979956b75d16f4c734a778ad832cbbcd20d78f5/clm/clm_harness/context_utils/context_string.py#L104)
把 assistant 以外角色重建成 user；reasoning/tool calls 被拼成正文，不复原独立协议字段。
[env.py:260](https://github.com/facebookresearch/context-language-models/blob/c979956b75d16f4c734a778ad832cbbcd20d78f5/clm/clm_harness/context_env/env.py#L260)
接受编辑后替换 messages。[edit gate](https://github.com/facebookresearch/context-language-models/blob/c979956b75d16f4c734a778ad832cbbcd20d78f5/clm/clm_harness/context_env/edit_gate.py#L53)
检查的是长度，不是 task/evidence/权限正确性。

因此“只加 memo CRUD”是第一步借鉴，不是完整 CLM；更接近 CLM 的第二步，是模型
主动选择、摘要或排除下一轮工作上下文，但由平台编译成合法结构化请求。

CLM 的 API harness 本身可使用 OpenAI/LiteLLM 中转；不需要 suffix KV 控制才能编辑。
但原 parser 不能直接用于 DSH。DeepSeek [thinking 文档](https://api-docs.deepseek.com/guides/thinking_mode)
要求 thinking+tools 回传历史 reasoning；[工具调用文档](https://api-docs.deepseek.com/guides/tool_calls)
区分 Chat Completions 人工中段 tool events 与 Responses/Anthropic。
普通 memo 文本不要求换协议；Responses 也不会自动修好被 flatten 的历史。

[Suffix cache reuse](https://github.com/facebookresearch/context-language-models/blob/c979956b75d16f4c734a778ad832cbbcd20d78f5/suffix_cache_reuse/README.md)
是 SGLang/Qwen 单 GPU 的服务端近似优化，保留 suffix 的旧 KV 仍带旧 prefix 信息。
DeepSeek [缓存接口](https://api-docs.deepseek.com/guides/kv_cache)是完整 prefix unit 匹配；
中转 API 没有已验证的 suffix 重定位 contract，不列入当前接入范围。
论文 FLOPs、swarm API USD 和 Qwen serving 数字不是 DS 中转节省承诺。

## 6. DSH 版工作上下文编辑器

### 6.1 复用已有底座

- `team-v12-context.mjs:130` 已有 sourceId/revision/hash/locator、team/task/member/权限、
  retention/freshness、预算选择；`:250/:283/:302/:382` 已做最新 revision、去重和取舍。
- `team_v12 context_pack` 只是调用者提供 sources 后组装，不是对象仓库；locator 没有
 通用 sourceId@revision fetch resolver。
- `team-v14-memory-anchor.mjs:38/:144` 是权威事实恢复快照，含 omissions/debt；不是任意 memo。
- `team-v14-durable-store.mjs:152` 已有锁内读改写、revision 和原子落盘；需扩领域对象的
  expectedRevision、history、ACL，不另造无锁 JSON 存储。
- `request-message-projection` 是最终消费层入口；新 compiler 应接此桥，不改 journal。

### 6.2 三层数据模型

| 层 | 所有者 | 允许行为 |
|---|---|---|
| 原始 journal / 权威事实 | 平台 | 不由模型编辑；task/lease/phase/permission/evidence 保持原工具更新 |
| Scoped memo / context objects | 成员提交、平台存储 | task/member 范围；独立 revision/parentRevision/hash/evidenceRefs/TTL/ACL；软删除保留原文 |
| 下一轮工作视图 | 模型提议、平台验证和编译 | 选择相关对象、摘要已完成普通片段、固定必要锚点；生成 view revision 与回执 |

memo 记录“调查过什么、哪些方案失败、当前假设、下一步依据”；权威任务状态从控制面
实时读取，不能由 memo 中的“任务已完成”覆盖真实任务。

### 6.3 新接口的最小集合

优先一个 `context_manage` 命名空间，而非一批反复注入的长说明工具。

| Action | 用途 |
|---|---|
| state | 紧凑列出可选 sourceId@revision、bytes/估算、来源、pins、权限、locator |
| memo_put/get/diff | CAS 写 scoped memo，取精确版本或变更；证据正文另按 locator 回读 |
| propose | 提议 pin/select/exclude/replace_summary；只改消费视图，非删除原数据 |
| preview | 本地预览保留锚点、协议完整性、大小变化、最早改写位置和预计缓存债；不调用模型 |
| commit/rollback | expectedRevision 提交或退回旧 view；只在下一安全请求边界应用，不取消现有执行 |

第一版不可任意重排 role、删 reasoning 或拆开工具调用与结果。用户最新要求、活跃任务
contract、owner/scope/lease、未处理 wake/inbox、未决决定和待验收证据必须保留。
只先允许摘要普通已完成调查正文/已解决讨论，按版本引用原文；critical facts 有精确 refs。
保留全文检索/展开，检索结果是资料，不自动成为新指令。

### 6.4 自由度逐步扩大

Stage A：持久 memo 与 fetch resolver，模型可维护工作记忆但不改原历史。
Stage B：context edit shadow；让模型给操作，编译器只记录会改什么、损失什么、费用预测。
Stage C：隔离任务有限 apply，只处理允许的普通内容，比较完整上下文、现有投影、CLM-view。
Stage D：验证合法 checkpoint/compaction 后的 episode 分层，才讨论移走大段 reasoning/调用历史。

不要为了整理上下文单独每轮唤醒一个编辑代理。先让当前成员在本来就有的工具阶段提交
紧凑 memo/edit；只有复用收益足够才增加独立摘要请求，并计入全部子代理成本。

### 6.5 缓存与预算闸门

稳定 system/核心工具/身份在前，动态 memo/Room/任务变化在后。优先追加小差量，不每轮
改早期大前缀。只有重复负担、压力或阶段结束达到门槛才编辑；记录 edit cost、冷债、
预计剩余请求和召回开销。preview 不得消耗 OP fullSends 或修改持久 delivery cursor。
不降低强制窗口保护，不让经济判断绕过权限或验收。

## 7. 实施和验收建议

| 批次 | 工作 | 最小验收 |
|---|---|---|
| A | RequestPlan/压缩一致性、预算双计量、cache归因和计数语义 | ordinary/compaction/取消/拦截/图片/prepared generation；保留原SDK证书与tool chain |
| B | 一次 ready快照、compact query、operationId、无变化digest抑制 | 同revision等价；跨组权限拒绝；相同/新episode不混；Room/SLA/provider/wake/ack不回归 |
| C | scoped memo/fetch/history/CAS/ACL + context edit shadow | 跨成员/跨组不泄露；旧revision冲突；证据hash可回读；重启/HMR恢复；不改权威数据 |
| D | 小批 context view apply、artifact refs、SDK按需目录 | 原任务验收/精确引用/历史call对齐/思维协议；全Team成本和缓存冷债；失败回退 |

基准至少包含长调查、Rust编辑构建、Room决策/阻塞、多个成员交付、失败重试、图片、
compaction后继续和不同模型路由。使用已有记录制作有界 fixture，不能把所有470亿token
重发一遍。运行真实A/B时预先设置调用/输入/输出/时间预算，成本合并root和全部后代。

必须报告 raw input、uncached/cacheRead/cacheWrite、output/reasoning、调用次数、耗时、
编辑/召回开销、质量和完成证据。采样不足或价格未知，不出整会话节省百分比/金额。

## 8. 当前不会直接做的事

- 不自由改写真实 transcript，不用字符串 parser 重建 tool/role/reasoning。
- 不因为 reasoning 字节最多就删历史 reasoning，不自动切 Responses。
- 不自动开启 Reducer 或机会压缩 on，不增加无界常驻上下文编辑代理。
- 不复制 SCR 到中转客户端，不承诺 CLM论文百分比。
- 不清理旧文件或按mtime推断已加载，不把旧文档哈希当当前运行态。

## 9. 恢复入口

- `implementation-plan.md`：后续实施清单，明确已完成基线、待实施工作包、验收和禁止操作。
- 本文：当前审查、优先级、CLM设计和验收边界。
- `snapshot.json`：本轮29条真实terminal的捕获结果、来源行号、usage缺失和字节构成。
- `D:/dsh-test/tools/system-architecture-audit-snapshot.mjs`：只读生成器；当前文件wx防覆盖。
- `D:/dsh-test/docs/context-opt-20261001/README.md`：已经完成的SDK/OP/milestone/window修复。
- `D:/dsh-test/docs/usage-audit-20261001/README.md`：历史回填和统一Team口径。
- `D:/dsh-test/docs/clm-ds41flash-dsh-followup-20260930.md`：首次CLM/DS评估，旧快照不覆盖本文。

本轮仅审查和文档交付。上述Stage/批次均为待实施，不得在交接后误认成已部署。
