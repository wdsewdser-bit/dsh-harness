# DSH 效率优化与 CLM 工作上下文实施清单

日期：2026-10-01，北京时间。
状态：用户已授权施工，并要求完成后开新 DSH 会话实测。批次 A/B/C 已部署到四逻辑 profile，并通过无重启 HMR；Team 依赖也已在同一 PID 上受控热加载。新 PTC 会话已完成 shadow 全量 canonical 验收，有限 apply 已到达真实 allowlist 边界但模型未完成二次提交，因此 apply 标记 partial；Reducer 已在 CLM 验收后启用，仅允许 `opencodego` 且保持 `remoteAllowed=false`。本轮进度与证据见同目录 implementation-ledger.md。

## 1. 恢复时先读

1. 本文件：范围、顺序、状态、验收和边界。
2. `D:/dsh-test/docs/architecture-review-20261001/README.md`：架构审查、源码依据和 CLM 接入设计。
3. 同目录 `snapshot.json`：2026-10-01 06:42:47 的有界生产请求快照，不是持续更新的全天报告。
4. `D:/dsh-test/docs/context-opt-20261001/README.md`：上轮已经完成的 SDK/OP/Team/window 优化。
5. `D:/dsh-test/docs/usage-audit-20261001/README.md`：历史回填、root 加全部后代的计量口径。

恢复后先核对当前挂载、源码和运行状态，不把旧 PID、配置、哈希或文档状态当成最新事实。
不要重跑已完成的历史回填或真实 golden，只追新改动需要的验证。

## 2. 已完成基线

| 项目 | 状态 | 不应重复实施 |
|---|---|---|
| 两个工作区历史回填与按 root Team 聚合 | 已完成，仍有原报告注明的缺失数据 | 不把旧40-session cache当完整历史 |
| per-request usage ledger | 已接入，已有自然请求 | 保留原始记录，缺失费用/usage不能补成0 |
| 已认证五版本 SDK 保留 | 已部署、真实两组 golden 和运行态核验通过 | 未知新 SDK 仍 fail-open，需要新兼容证书 |
| OP 原始行号和 mixed-content 安全 | 已部署，真实四次 golden 和运行态核验通过 | 保留 L2/L173/L399、原文归档和错误/图片内容 |
| 相同可信 milestone 全当前 surface 去重 | 已完成聚焦验证 | 不删除已有 journal，不跨 episode 按文本去重 |
| team_delivery_check Windows 隐藏窗口 | 用户已确认当前 Team 实际使用不弹窗 | 用户明确不用再测，不追加 delivery/window probe |

现有 context pack、memory anchor、durable store、waiting、event continuation、PTC receipts、
task/lease/evidence 权威接口均已存在；后续应复用，不另造平行控制面。

## 3. 新工作包与优先级

| ID | 优先级 | 内容 | 状态 |
|---|---|---|---|
| CTX-PLAN-01 | P0 | 主请求/compaction/预算使用一致的最终请求计划 | 已部署/HMR/聚焦通过 |
| CTX-METER-02 | P0 | 原始安全上限与投影后经济计量分开 | 已部署/HMR/聚焦通过 |
| CTX-RECEIPT-03 | P0 | 投影删除量、缓存前缀和实际请求归因 | 已部署/HMR/聚焦通过 |
| TEAM-QUERY-01 | P1 | 一次权威快照构造 ready queue，紧凑查询 | 已部署/HMR/隔离 PTC 实测通过 |
| TEAM-NOTIFY-02 | P1 | 无新事实 digest 抑制、消息 operationId | 已部署/HMR/隔离 PTC 实测通过 |
| CLM-MEMO-01 | P1 | task/member scoped memo 仓库和精确版本召回 | 已部署/HMR/隔离 PTC shadow 实测通过 |
| CLM-VIEW-02 | P1 | 模型可提议的结构化上下文编辑，先 shadow | shadow 完成；隔离 apply partial |
| TOOL-REF-01 | P2 | 大 payload/code 的权限和 hash 绑定引用 | 待评估 |
| SDK-CATALOG-02 | P2 | 稳定核心 SDK、角色目录和按需 describe | 待评估 |
| CLM-CHECKPOINT-03 | P2 | 合法历史检查点和 completed episode 分层 | 待协议/质量验证 |

优先级不是节省百分比。实际收益按真实请求、冷缓存债、编辑/召回开销和任务质量验证。

## 4. 批次 A：请求、预算和统计一致性

### 范围

- `request-message-projection.mjs`、`ptc-sdk-retention.mjs`、`observation-pack-v2.mjs`。
- `step-compaction-v4.mjs`、`request-usage-ledger.mjs`、`team-v13-cache-monitor.mjs`。
- 官方 compaction/token-meter 接口只作契约参考；优先 profile 层兼容扩展，不直接改已安装应用包。

### 实施要求

- native adapter、预算观察和账本使用同一份准备好的请求快照；保留 provider/prepared generation。
- 不因 preview 或计量再跑一次有状态投影，不额外消耗 OP fullSends、Room/inbox cursor。
- compaction 是否采用 SDK 投影单独设策略并验证；不得仅删除 auxiliary purpose 防线。
- 原始窗口保护与投影后成本估计分别记录；未知图片/路由/tokenizer计量继续保守处理。
- 明确 attempted、handed-to-adapter、provider receipt；不能把投影次数叫“模型已读全文次数”。
- 归因以同 requestId 的 applied/unchanged receipt 为主，不选其他会话或未来的机制事件。
- 记录 before/after bytes、内容hash、最早改写位置或共同前缀、业务 turn/task/workflow关联。
- 原始 provider usage、价格或 cacheWrite 未知时明确 unknown，不伪造现金节省。

### 验收

- ordinary 与 compaction、取消/拦截、辅助请求、图片、错误结果、prepared A/B generation 均覆盖。
- 不修改原消息、signal、tools、toolHistory；不拆 tool-call/result，不删除历史 reasoning。
- meter/preview 不产生额外 adapter dispatch，不改变发送计数或持久权威状态。
- 同 request 的真实账本能说明哪些投影生效、改了多少、哪些指标未知。
- 保留当前 SDK 证书、OP精确引用和 fail-open；压缩质量用原始反例验证。

## 5. 批次 B：Team 确定性效率

### 范围

`team-tools-v2-r10.mjs`、`team-activity-digest.mjs`、控制面的消息提交和证据查询接口。

### 实施要求

- 单次查询共用一个权威 revision 快照和 ready-row 索引，不对每张卡重复派生全队列。
- compact/full、精确 IDs、changed_since、稳定 snapshotId/revision；权限过滤先于投影。
- activity digest 比较新增可行动事实，不只按下一时间槽唤醒；仍保留真正到期的责任提醒。
- 消息先权限与任务revision校验，再按 caller operationId/事件键幂等提交。
- 幂等键包含 sender/target/task revision/event/delivery；返回已有真实回执，不按文本永久去重。

### 验收

- 同 revision 的查询结果与现有全值语义等价，limit=1 不再重复构造全队列。
- 跨组读取/写入依旧被拒绝，compact view 不可充当完成证据。
- 无变化不追加无意义通知；新 blocker、完成、责任到期、用户要求变化仍能正常推进。
- Room timeout、idle/SLA、provider-blocked、inbox ack 和已有 wake episode 不回归。
- 部分失败后重试只处理未确认步骤，不重放整段 PTC 或重复产生 Room notice。

## 6. 批次 C：CLM 适配底座与 shadow

### 数据分层

| 层 | 可编辑性 |
|---|---|
| 原 journal / task / lease / phase / permission / evidence | 保持现有平台权威，不让 memo 或 context edit 覆盖 |
| Scoped memo / context object | 成员提交，平台鉴权、CAS、版本化存储，保留原文 |
| 下一轮工作视图 | 模型提议，平台校验和编译；只改变消费视图，可回退 |

复用 `team-v12-context` 的来源/预算选择、`team-v14-memory-anchor` 的锚点/omission/debt、
`team-v14-durable-store` 的锁和原子落盘，以及当前最终请求投影桥。

### 最小接口

优先一个 `context_manage` 命名空间，具体名称实施时以当前工具契约为准：

- `state`：紧凑列可选 sourceId@revision、范围、来源、pins、bytes和locator。
- `memo_put/get/diff`：task/member ACL、expectedRevision、parentRevision、SHA256、evidenceRefs和TTL。
- `propose`：select/pin/exclude/replace_summary 等受限操作。
- `preview`：本地校验锚点、协议完整性、大小、改写位置和预计冷债，不调用模型。
- `commit/rollback`：CAS 更新 view revision，在下一安全请求边界应用，不取消现有执行。

### 首版边界

- 默认 shadow，不直接动原 transcript。
- 先处理已完成普通调查、已解决讨论和按需 memo；reasoning/工具历史检查点另立验证。
- 必须保留用户最新要求、活跃任务 contract、owner/scope/lease、未处理 wake/inbox、未决决定。
- 证据有精确原文引用和版本；摘要不是新的权威完成证明。
- 检索内容是资料，不自动成为指令；跨成员/跨组访问先按现有权限过滤。
- 不增加每轮常驻编辑代理；优先由当前成员在现有工具阶段提交紧凑 memo/edit。
- 稳定前缀在前、动态记忆在后，避免每轮改早期前缀。

### 验收

- CAS冲突、scope/ACL、revision history、HMR恢复、locator/hash召回、软删除原文保留。
- shadow 能给可验证预览、拒绝原因和回执，不修改权威状态或实际请求。
- 缺失锚点、未知消息类型、协议不兼容或原文不可回读时安全回退。
- 后续apply需在隔离任务对照完整上下文/现有投影/CLM-view，任务验收与精确引用不下降。

## 7. 批次 D：实验性工具与合法检查点

本批不与前三批捆绑默认上线。

- artifact/payload引用需 SHA256、size、schema和权限；运行时解析后仍走 canonical 工具门禁。
- 代码文件执行需显式授权、预期hash和范围限制，不执行任意检索到的文件。
- 不改旧 assistant tool-call 参数为 locator，不人工插入非法历史工具事件。
- 工具目录先统计角色实际覆盖率，验证 schema 找回率、额外 lookup 次数和累计成本。
- 新工具/SDK版本须更新兼容证书并重做相关golden；未知版本保持fail-open。
- DeepSeek reasoning/tool-history、compaction/checkpoint须做协议验证；不因字节最多就直接删除。
- Responses仅在真实中转协议测试后考虑；普通memo不要求先切协议。
- CLM suffix KV reuse不在当前范围，没有中转服务端contract就不接。

## 8. 统一实验和交付规则

- 按用户口径合并 root 和全部后代；同时报告观测覆盖范围，不把两个session当整个Team。
- baseline包括原任务质量、总调用数、输入、cacheRead/cacheWrite、输出、耗时、编辑/召回成本。
- reasoning属于输出子集时不得再加一次；未知字段不当0，字节估计不冒充provider token。
- 把一次性缓存冷债与后续暖请求收益分开，不用CLM论文或单fixture百分比外推470亿历史。
- 使用本地已存记录制作有界fixture；不把完整470亿token历史重发到API。
- 真实A/B先明确调用/输入/输出/时间预算，失败停止，不为凑样本唤醒活跃Team。
- 代码实现时备份并同步四逻辑profile，语法/聚焦/适用全量回归、parity和真实HMR分别验证。
- 原有全量回归的2个失败、1个跳过以及health打印FAIL但退出0要保留说明，不伪报全绿。
- 用户授权开始修复时，按既有要求先建立明确缺陷/验证目标和100000000 token预算的goal；
  文档准备不创建修复goal，也不以goal预算替代真实模型实验的独立预算。
- 完成后更新实施状态、证据和回滚信息，并向已有DSH root发送queue模式结果，不steer。

## 9. 禁止操作

- 不重启DSH、不中断当前root或active Team、不擅自恢复provider阻断。
- 不清理旧backup/spill/telemetry/session，不修改RustMc产品仓。
- 不自动启用机会压缩on、Responses或改变全局thinking；Reducer 仅在 CLM shadow 验收后按用户授权启用，且只允许 opencodego 本地中转。
- 不让memo/context edit写权威task、lease、phase、permission或evidence状态。
- 不自由flatten/rebuild历史role/tool/reasoning，不把“文件已写”当“已运行生效”。
- 不使用Terra；后续派发沿用用户指定的可用Sol模型，不静默回退。

## 10. 当前收尾状态

文档和审查快照已经持久化；A/B/C已开始staging实现，尚未部署，没有新DSH模型实验。
按包逐项改状态，不一次性标记全部完成；新增风险和范围变化写在对应包内和实施台账。
