# Agent Team v13.2：全系统架构复核与优化建议

> 日期：2026-09-25  
> 范围：`D:\dsh\docs`、`D:\dsh-test\docs` 中的 Agent Team 设计/交接/实施文档，以及 v13.1 web/headless 运行时插件的静态复核。  
> 运行影响：本次只读审查；没有重启 DSH，没有修改会话，没有清理 session、spill、telemetry 或 backup。

## 1. 总结

当前系统已经形成比较完整的分层架构：DSH/Team domain 负责成员生命周期，policy 负责层级与权限，Room 负责受控讨论，任务板与 lease 负责交付状态，压缩/观察/Reducer 负责上下文成本，web/headless 两套 profile 保持同步。

v13.1 的离线验证已通过 phase1–9 `95/95`、phase10 `45/45`，核心机制已经具备上线条件。但历史文档与当前实现共同显示出一个边界：设计早期以“单进程、单写者、模型遵守流程”为隐含前提，后续虽然加入了硬门禁和持久化，仍有几处运行时没有把并发、隔离、恢复完全下沉到控制面。

因此下一阶段不应优先继续增加新机制，而应先做“运行时一致性层”：

1. 所有持久状态具备明确的 owner、revision、恢复路径。
2. 所有内存索引按 session/team 隔离，并能在 HMR/重启后恢复。
3. 所有失败都有分类、重试策略和可审计解锁。
4. 所有节省机制都暴露 applied/fallback/verify-failed，而不是只报 token 节省。

## 2. 已完成且应保留的设计

- tier/group/parent/lease/fail-closed 权限模型。
- Room 默认静默投递，只有 wake/escalate/系统停工提醒唤醒上级。
- 任务板 CAS、plan、contract、acceptance packet 和 exact SHA 证据链。
- milestone 与 75% 压力压缩强制路径。
- web/headless 插件同步与独立回滚。
- Action Fusion、ObservationPack、Evidence-Preserving Reducer、Compaction Economics 的独立开关。
- 失败时 fail-open 的日志归档与上下文处理策略。
- v13.1 机制遥测、缓存前缀监控、压缩锚点校验、自动研究候选筛选。

这些基础不应被大规模重构。下一阶段应采用兼容扩展，保持旧会话、旧 Room 游标、旧 task schema 可读。

## 3. P0：应优先修复

### 3.1 失败记忆必须按会话和工作区隔离

当前 `team-v13-failure-memory.mjs` 的 action fingerprint 主要由工具名和参数组成，持久文件是全局文件。相同工具调用在不同 session、workspace、分支或代码版本中失败三次，可能误触发另一项任务的门禁。

另外，供应商超时、5xx、文件锁、资源不足等瞬态错误不应与确定性 schema/权限/参数错误共用阻断计数。

建议：

- fingerprint 至少加入 `sessionId`、workspace identity、profile 和可选 commit/tree hash。
- 错误分类为 `deterministic`、`transient`、`permission`、`stale-state`、`provider`。
- 只有确定性错误进入硬阻断；瞬态错误使用有限退避，不永久计数。
- 增加带理由和证据的 `clear/unblock`，记录操作者、时间、原 fingerprint。
- 增加 TTL 或连续失败窗口，避免旧失败永久生效。

验收：两个 session 使用相同参数互不阻断；供应商超时不触发永久门禁；解锁后下一次调用可执行。

### 3.2 持久 JSON 状态不能继续使用无协调读改写

机制遥测、压缩债务、设置等文件目前存在“读取 JSON、内存修改、整体写回”的路径。多个 Team、web/headless 进程或设置页与命令并发更新时，后写入者可能覆盖先写入者。

建议优先级：

1. 以追加式事件日志作为事实源，JSON 仅作为可重建快照。
2. 如果暂时保留 JSON，加入 `revision`、原子临时文件、CAS 重试和冲突合并。
3. 保留损坏文件副本，从事件或上一个有效快照恢复，禁止静默清空。

验收：两个 Node 进程并发写入 100 次后计数完整；强制中断写入后仍能恢复最后一个有效状态。

## 4. P1：运行稳定性和隔离

### 4.1 ObservationPack 的索引必须 session 隔离

`observation-pack-v2.mjs` 目前使用 `callId` 作为进程内 Map key。不同 Team 复用 call ID、call ID 缺失或 HMR 后索引变化，都可能造成错误替换或全文重新发送。

建议：

- 使用 `sessionId + callId` 复合键。
- 缺失 call ID 时生成可追踪的唯一 key。
- handle 记录 session、call ID、observation ID、sha256。
- 为内存索引增加 TTL 和数量上限。
- 把最小索引写入会话目录，或在请求组装时根据 observation source 重建。

### 4.2 Reducer 必须有输入上限和分块策略

当前超过阈值后可能把整份长日志拼进 reducer prompt。超大日志会让 Reducer 自己超出模型窗口，失败后主会话仍承担完整日志成本。

建议：

- 增加 `maxInputBytes`、`maxInputLines`。
- 超限时确定性选取头部、尾部、错误行和时间窗口分块。
- receipt 增加 `scannedRanges` 和未扫描区间。
- 单独记录 prompt bytes、耗时、失败原因和回退字节数。
- 归档缺失或引用校验失败时继续 fail-open，但在健康报告中显示 `verify-failed`。

### 4.3 Action Fusion 需要跨进程项目锁

当前内容哈希去重和 crate 冷却主要是进程内状态。多个 Team 可能同时对同一 Rust crate 执行 `cargo check`，造成 CPU、磁盘和构建锁竞争。

建议：

- 按 workspace/crate 建立带 TTL 的跨进程锁。
- 等待超过上限后返回“验证排队/跳过”证据，不阻断编辑。
- 记录 `active`、`queued`、`skipped`、`timeout`、`passed`、`failed`。
- 对不同 crate 保持并行，对同一 crate 串行。

### 4.4 设置更新必须有单一合并语义

设置页和 `/team reducer-route` 同时更新时可能互相覆盖。建议使用带 revision 的单一 settings service，所有入口提交 patch，由服务端合并并广播；不要让 UI 和命令各自读写完整 JSON。

## 5. 控制面和任务流程改进

### 5.1 Room 增加“当前摘要 + 历史折叠”两层读取

Room 应把最新未读消息、当前轮次、决策、未决项作为热层；早期已解决消息进入可检索历史层。注入 Team 的内容只包含：

- 上次 cursor 之后的新消息；
- 当前 Room 摘要；
- 未决项和最近决策；
- 被引用的历史消息。

这样可以避免旧消息重复注入，也避免压缩后丢失决策上下文。

### 5.2 任务板、Room、lease 建立一致性检查

定期生成单一 `control-plane health` 结果，检查：

- task owner 是否仍有有效 lease；
- lease 是否对应活跃 session；
- Room host 是否冻结或失效；
- plan phase 是否与 acceptance packet 相容；
- open task 是否确实有可达 owner；
- done milestone 是否具备压缩锚点。

发现不一致时生成可恢复的 repair action，不直接改写事实源。

### 5.3 失败恢复从“重试”升级为“分类动作”

不同错误不应统一让模型重复调用：

| 类别 | 默认动作 |
|---|---|
| deterministic | 阻止原样重试，要求改参数/计划 |
| transient | 有界退避重试，记录次数 |
| permission | 返回缺少 scope/lease/role 的修复建议 |
| stale-state | 重新读取 revision，要求 CAS |
| provider | 保留请求证据，等待或切换已授权路由 |

## 6. 上下文、缓存和压缩优化

### 6.1 继续保持动态数据追加，不重写 system prefix

Room 摘要、idle 提醒、机制遥测和压缩原因都应作为末尾消息或结构化 context pack 注入。禁止把动态状态拼进静态 system prompt，避免缓存前缀被持续破坏。

### 6.2 Reducer 与 ObservationPack 保持明确优先级

固定顺序应为：

`Reducer 成功并验证 -> 使用 receipt，跳过二次 ObservationPack`

`Reducer 禁用/失败/超限 -> ObservationPack 处理原文`

receipt 必须有唯一 marker、archive id、sha256 和引用范围，避免同一份日志被二次压缩。

### 6.3 机会性压缩与 Reducer 独立启用

当前 Reducer 默认关闭、机会性压缩保持 shadow 是正确的。开启任一机制都要独立做 A/B，不能把“离线 token 下降”直接视为线上质量通过。milestone done 和 75% 压力路径必须始终绕过经济闸门。

### 6.4 增加上下文预算预警层

在硬门禁前增加三档状态：`normal`、`compact-soon`、`compact-required`。面板显示触发原因、预计剩余请求、最近压缩债务和可恢复锚点。这样可以避免达到门禁后直接无法继续派发任务。

## 7. 可观测性和面板

当前健康报告如果只显示“节省 token”，容易掩盖机制一直 fallback。每个机制至少显示：

- enabled / shadow / disabled；
- applied；
- fallback；
- verify-failed；
- oversize；
- disabled-by-policy；
- 最近 session、最近时间和最近原因。

Room 页面建议显示“当前轮次、未读数量、摘要、未决项、最近决策、历史消息折叠”，并提供按 session/team/task 过滤，避免几百条消息堆在一个列表里。

## 8. 代码重构建议

### 8.1 抽出共享持久化内核

把 failure memory、telemetry、compaction debt、settings 中重复的 JSON 原子写入、revision、恢复和备份逻辑抽成一个小型 `durable-store` 模块。只保留领域层的 schema 与 merge 函数，避免每个插件各自实现一套不一致的写入策略。

### 8.2 抽出统一身份上下文

所有插件统一读取：`sessionId`、`teamId`、`workspaceId`、`profile`、`agentName`、`runId`。禁止各插件使用不同 fallback（例如 agent id 代替 session id），否则审计和隔离会失真。

### 8.3 把状态机转换做成纯函数 + 事务提交

Room、task、lease、compaction 的状态转换先由纯函数验证，再通过单一 durable commit 写入事件。拒绝原因必须包含当前状态、目标状态、缺少条件和推荐恢复动作。

### 8.4 web/headless 只保留一份源码

如果部署结构允许，改为共享源文件并在 profile 层引用；若 DSH 要求双副本，则用生成脚本同步并在 CI/启动前校验哈希，避免手工修改一边。

## 9. 必须补充的测试

在打开机会性压缩或 Reducer 前增加：

1. 两个进程同时写 telemetry/debt，验证计数不丢。
2. 相同 call ID 跨 Team，验证 handle 不串线。
3. HMR/重启后继续 ObservationPack 投影，验证索引恢复。
4. 超过 Reducer 输入上限，验证分块、receipt 范围和 fail-open。
5. 相同工具调用跨 session，验证 failure memory 不误阻断。
6. 多个 Team 同时触发同一 crate，验证项目锁和排队上限。
7. 设置页与命令并发修改，验证 patch 合并不丢字段。
8. 归档被删除、替换、部分写入时，验证 hash/size 校验和恢复。
9. Room host 冻结、lease 过期、task owner 消失时，验证 repair action 可解释且不死锁。
10. 压缩后校验 task/owner/milestone/Room/cursor/blocker 全部恢复。

## 10. 推荐实施顺序

### 阶段 1：一致性底座

失败记忆隔离与分类；共享 durable-store；telemetry/debt/settings 的 revision/CAS；先补并发测试。

### 阶段 2：长驻运行稳定性

ObservationPack 复合键与索引恢复；Reducer 输入上限与分块；Action Fusion 跨进程项目锁。

### 阶段 3：控制面体验

Room 热层/历史层、control-plane health、错误分类修复动作、上下文预算预警。

### 阶段 4：性能机制启用

仅在前述回归通过后，分别评估 Reducer 和机会性压缩；两者分开启用、分开回滚、分开统计质量。

## 11. 暂不建议做的事情

- 不替换 DSH/Team domain 底座。
- 不把 v13 机制重新做成另一套 swarm 拓扑。
- 不让模型提示词承担权限、phase、lease 和隔离判断。
- 不直接删除历史 session、spill、telemetry 或 backup 来“解决”容量问题。
- 不为了降低 token 而取消 milestone、75% 压力、Room 决策和 exact evidence。
- 不在没有跨进程测试前打开所有自动机制。

## 12. 当前风险边界

- 当前 v13.1 离线测试通过，但尚未覆盖上述多进程、重载和超大输入场景。
- Reducer 默认关闭，机会性压缩仍为 shadow，当前行为保持保守。
- web/headless 相关插件哈希一致，但运行中的 headless 实例是否已加载最新文件需单独核验，不应仅凭磁盘哈希判断。
- 本报告是架构复核和实施建议，不表示上述 P0/P1 修复已经完成。
