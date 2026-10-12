# Agent Team v13.1：代码与架构审查报告

> 日期：2026-09-25  
> 范围：v13.1 运行时插件、遥测与控制面辅助文件  
> 审查方式：只读静态检查、web/headless 文件哈希对比、现有健康报告与测试记录核对  
> 运行影响：本次审查没有重启 DSH、没有修改会话、没有清理遥测/归档/备份

## 1. 结论

v13.1 的主要机制已经落地，web 与 headless 的相关插件文件保持一致，现有离线验证为 phase1–9 `95/95`、phase10 `45/45`。但当前测试主要覆盖纯函数、fixture 和单进程路径，长驻多 Team 场景仍有几类风险：失败记忆可能误阻断其他任务，状态文件并发写会丢数据，ObservationPack 的进程内索引可能串观察，Reducer 可能把过大的日志再次送入模型，Action Fusion 可能并发占用构建资源。

这些问题不会说明当前系统已经失效，但会在长任务、热重载、多个 Team 并发或供应商不稳定时放大，优先级高于继续增加新的效率机制。

## 2. 已确认的问题

### P0：失败记忆的隔离范围过大

文件：

- `D:/dsh-test/home/profiles/web/plugins/team-v13-failure-memory.mjs`
- `D:/dsh-test/home/profiles/headless/plugins/team-v13-failure-memory.mjs`

`actionFingerprint()` 只使用工具名和参数，持久文件是全局的 `v13-failure-memory.json`。同一个调用在不同会话、工作区、分支或代码版本中失败三次后，可能被其他任务直接拒绝。网络超时、供应商 5xx、文件锁和进程资源不足也会进入失败计数。

建议：

1. 指纹加入 `sessionId`、工作区标识和可选代码版本；至少按工作区隔离。
2. 将错误分成确定性错误和瞬态错误，只有确定性错误进入阻断计数。
3. 增加带理由的 `clear/unblock` 操作，并记录操作者、时间和证据。
4. 采用连续失败窗口或 TTL，避免失败计数永久累积。

验收：两个不同会话使用相同参数时互不阻断；供应商超时不触发永久门禁；人工解锁后下一次调用可执行。

### P0：遥测和压缩债务文件存在并发覆盖

文件：

- `team-v13-mechanism-telemetry.mjs`
- `team-v13-compaction-shadow.mjs`

当前流程是读取 JSON、在进程内修改、再用 `writeFileSync` 写回。每个机制虽然有独立文件，但多个 Team、web/headless 进程仍可能同时更新同一个机制文件。后写入者可能覆盖前一个进程刚追加的计数、session 或 metrics。压缩债务文件还会整体重写 `sessions` 对象。

建议：

1. 以追加式事件日志作为事实源，汇总 JSON 作为可重建缓存。
2. 如果保留 JSON 写入，加入 `revision`、临时文件、原子替换和 CAS 重试；冲突时重新读取并合并。
3. 定义损坏恢复策略：保留坏文件、从事件日志重建，不静默清空计数。

验收：两个 Node 进程并发写入 100 次后，计数和 session 数量完整；强制中断写入时文件仍可恢复。

### P1：ObservationPack 的索引键没有会话隔离

文件：

- `observation-pack-v2.mjs`

`observations` 使用 `callId` 作为 Map 键。call ID 缺失、重复或被不同 Team 复用时，后一个观察会覆盖前一个观察。归档对象仍然存在，但 `llm/stream` 投影可能找不到正确的观察，或者把消息替换成另一条观察的 handle。

建议：

- 使用 `sessionId + callId` 作为复合键。
- call ID 缺失时生成进程内唯一且可追踪的 observation key。
- 在 handle 中保留 session、call ID 和 observation ID。
- 为进程内索引增加 TTL/上限，避免长驻进程持续增长。

验收：两个 Team 使用相同 call ID 时都能得到各自的 handle；缺少 call ID 时仍能稳定替换和召回；旧观察不会无限留在内存。

### P1：ObservationPack 热重载后索引丢失

`fullSends` 计数和观察索引只保存在内存。热重载或进程重启后，已归档的观察没有恢复索引，可能再次全文发送；归档文件本身没有丢失，但节省效果会暂时消失。

建议把最小索引写入会话目录，或在每次 `llm/stream` 根据当前消息中的 observation source 重新建立索引。恢复失败时保持原文，且记录一次可诊断事件。

### P1：Reducer 没有输入上限和分块策略

文件：

- `evidence-reducer.mjs`

阈值是 `thresholdBytes`，但触发后会把整份日志拼进 reducer prompt。超大日志可能让 reducer 自己超过上下文窗口或请求限制；此时虽然 fail-open，但主会话仍承担完整日志成本。

建议：

1. 增加 `maxInputBytes` 和 `maxInputLines`。
2. 超过上限时按头部、尾部、错误行和时间窗口确定性分块。
3. receipt 标明 `scannedRanges` 和未扫描区间，避免摘要被误认为覆盖全文。
4. 对 reducer 的 prompt 大小、耗时和失败原因单独计量。

### P1：Action Fusion 缺少跨进程项目锁

文件：

- `action-fusion-v2.mjs`

已有内容哈希去重和 crate 冷却，但这些状态是进程内 Map。不同 Team 或 web/headless 进程仍可能同时执行同一 crate 的 `cargo check`，造成 CPU、磁盘和锁竞争，延长模型 turn。

建议：

- 按项目/crate 建立带 TTL 的跨进程锁。
- 增加排队上限和等待超时；超出时返回“验证排队/跳过”证据，不阻断编辑。
- 记录 active、queued、skipped、timeout 四类状态。

## 3. 其他风险与改进

### 3.1 设置文件更新的读改写竞态

`evidence-reducer.mjs` 的设置更新是读取、合并、整文件写入。设置页和命令同时更新时，后写入者可能覆盖前一个字段。建议加入 revision/CAS，或将每个可变设置写成独立字段并由单一协调者合并。

### 3.2 Fail-open 需要可见的质量信号

ObservationPack、Reducer、经济判断失败时会保留原文或旧行为，这是正确的安全选择，但如果只看 token 报表，使用者可能误以为机制正常节省。应在面板和健康报告中分别显示 `applied`、`fallback`、`verify-failed`、`oversize` 与 `disabled`。

### 3.3 机会性压缩和 Reducer 的启用门槛应继续独立

当前 Reducer 默认关闭、机会性压缩保持 `shadow`，符合安全策略。打开任一机制时仍需保留强制 milestone/75% 压缩路径，并分别做 A/B 与质量门槛验证，不能把离线结果直接当成线上收益。

### 3.4 失败重试策略应加入基础设施分类

工具失败记忆、wake 投递失败、供应商错误和文件锁错误的恢复方式不同。建议统一错误分类字段：`deterministic`、`transient`、`permission`、`stale-state`、`provider`，由分类决定重试、唤醒、人工介入或门禁。

## 4. 现有测试缺口

当前 `95 + 45` 个离线测试没有覆盖以下真实场景：

- 多进程同时写遥测和压缩债务文件；
- 相同 call ID 跨 Team；
- 热重载后继续 ObservationPack 投影；
- Reducer 输入超过模型上下文；
- 失败记忆跨会话误阻断；
- 多个 Rust crate 并发触发验证；
- 设置页与 `/team reducer-route` 并发更新；
- 归档文件被删除、替换或部分写入后的恢复。

建议先补这些回归，再考虑打开机会性压缩或启用 Reducer。

## 5. 推荐实施顺序

1. 失败记忆隔离、错误分类和可审计解锁。
2. 遥测/债务文件的 CAS 或追加日志协议。
3. ObservationPack 复合键、索引恢复和 TTL。
4. Reducer 输入上限、分块和扫描范围标记。
5. Action Fusion 跨进程项目锁与排队限制。
6. 补齐并发、重载、超大输入和跨会话测试。
7. 通过新增回归后，再评估是否打开机会性压缩或 Reducer。

## 6. 当前状态与风险边界

- 本报告是审查结果，不代表上述修复已经实施。
- web/headless 的 v13 插件文件当前哈希一致。
- v13.1 既有离线测试保持通过，但不覆盖本报告的并发与重载场景。
- 当前没有重启 DSH，也没有清理任何 session、spill、telemetry 或 backup 文件。
- 备份目录仍为 `D:/dsh-test/backup-v13-20260925-140123`。

