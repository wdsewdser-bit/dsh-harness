# Agent Team v5 全量实施计划

> 目标：一次性把 Agent Team 从“树状代理 + 一对一异步消息 + 成员自行测试”升级为可控、可追踪、可恢复、可验收的协作系统。
>
> 本文件是实施计划，不是本轮实现记录。除非实施阶段明确开始，否则不修改插件、运行时、测试实例或生产环境。
>
> 初版编制：2026-09-14
> 本次通用化修订：2026-09-15
> 适用实例：优先 `D:\dsh-test`，完成验证后再由用户决定是否迁移到 `D:\dsh`

## 1. 现状结论

当前架构的方向基本正确，但控制平面、执行平面和证据平面还没有真正分离，导致协作规模扩大后出现以下问题：

1. 下级遇到局部问题就唤醒上级，root 和组长被大量低价值消息打断。
2. 只有一对一消息，没有同组讨论空间，成员不能先横向协商再执行。
3. 消息是异步投递，没有可靠的“已送达、已开始、已提交、已完成”生命周期。
4. 成员可以自行设计测试，重复测试和无效测试消耗大量 token。
5. 组长、组员、verifier 的验证责任边界不清，最终审查无法集中到最终集成结果。
6. 视觉审查缺少多角度、资源完整性和运行时异常分类，贴图丢失可能被误判成设计。
7. 压缩触发晚于模型请求预算，长会话仍然可能撞上下文上限。
8. 部分策略和状态仍然只在进程内存中，重启、崩溃或多进程后不能恢复完整事实。
9. 合并前的 verifier clearance 与实际 merge 使用可变分支引用，存在路径错误和 TOCTOU 风险。
10. 测试套件主要覆盖纯函数和工具替身，没有覆盖真实重启、长会话、消息闭环、最终合并和完整视觉验收。

### 1.1 已有基础，保留不推倒重来

- DSH 原生 Session journal 作为模型可见事实的来源。
- `ctx.agentTeams` 作为成员、邮箱和基础生命周期的底层域。
- `team-policy` 作为层级、分组和权限投影。
- `team-tools-v2` 作为模型侧工具入口和策略拒绝层。
- `team-operator` 作为不经过模型回合的人类控制通道。
- Git worktree 隔离与冲突不自动解决的原则。
- 里程碑、上下文压缩、用量统计和 idle watch 的方向。
- 动态进度不写入静态 system prompt，避免破坏缓存前缀。

## 2. v5 目标架构

将系统明确拆成三个平面和四类 durable truth：

```text
Control Plane
  Room、轮次、计划、决议、升级、任务状态、成员状态

Execution Plane
  Agent run、worktree、命令、锁、commit、merge、取消、重试

Evidence Plane
  验证清单、测试命令、原始输出、截图、资源扫描、verifier finding

Durable truth
  1. Team membership / policy projection source
  2. Room and dispatch ledger
  3. Task and milestone state
  4. Artifact and evidence ledger
```

任何会影响后续调度、权限、合并或验收的事实，都必须能够从 journal 或明确的 durable store 重建。进程内 Map 只能作为缓存，不能作为唯一事实来源。

### 2.1 团队层级

保留三层树，但限制跨层通信：

```text
tier 0  root / Lead
tier 1  group lead + verifier
tier 2  group member
```

默认拓扑仍然支持多个组长和每组多个成员，但实际并发人数由 active slot、任务复杂度和 token 预算共同决定，而不是盲目填满上限。

### 2.2 通信路由原则

| 场景 | 默认去向 | 是否立即唤醒 |
|---|---|---:|
| 同组成员讨论 | `group:<group>:tier-2` room | 否 |
| 组长之间讨论 | `level:1` room | 否 |
| root 与组长沟通 | `root` room | 否 |
| 普通进度汇报 | room 摘要/看板 | 否 |
| 需要上级做决定 | `team_escalate` | 是 |
| 真正阻塞、超时、安全风险 | `team_escalate` | 是 |
| 取消或冻结 | operator / 控制工具 | 是 |

普通 `send_message` 不得默认唤醒上级。立即唤醒必须使用独立的升级动作，并且带有结构化原因和证据。

## 3. 统一任务状态机

所有需要修改代码或资源的任务使用以下状态：

```text
draft
  -> room-discussion
  -> plan-proposed
  -> plan-approved
  -> execution
  -> member-check
  -> group-check
  -> verifier-review
  -> integration-ready
  -> integrated
  -> accepted

任意阶段 -> blocked / rejected / cancelled / expired
```

### 3.1 状态转换规则

- `draft -> room-discussion`：任务创建后自动打开对应 room 轮次。
- `room-discussion -> plan-proposed`：参与者提交事实、依赖、方案和验证计划。
- `plan-proposed -> plan-approved`：对应组长批准；跨组任务需要 level room 决议；影响产品取舍的任务需要 root 批准。
- `plan-approved -> execution`：系统生成 run lease、写入 worktree 和作用域，成员才能开始修改。
- `execution -> member-check`：成员只完成局部、便宜、与自身修改直接相关的检查。
- `member-check -> group-check`：成员提交 commit 和检查结果给组长，不直接找 verifier。
- `group-check -> verifier-review`：组长提交一份完整 acceptance packet。
- `verifier-review -> integration-ready`：verifier 对明确 commit SHA 出具 finding 清单。
- `integration-ready -> integrated`：持有目标分支的角色按 exact SHA 合并。
- `integrated -> accepted`：在最终集成 commit 上运行统一验收。

### 3.2 执行前强制协商

`team_worktree_setup` 和实际文件写入前必须存在 `plan-approved` 记录。计划最少包含：

- 任务目标和 requirement id。
- 参与成员及其职责。
- 允许修改的文件范围。
- 依赖和接口约定。
- 方案选项和选择理由。
- 成员自检命令。
- 组长验收命令。
- verifier 验收命令。
- 预期 commit、报告和截图路径。
- 风险、回滚点和升级条件。

没有计划批准时，成员只能参与 room 讨论，不能开始代码执行。

## 4. Durable Room 群聊

### 4.1 Room 类型

```text
group:<group>:tier-2   同组组员横向协商
level:1                组长之间和 verifier 协商跨组接口
root                   root 与组长之间的决策沟通
task:<task-id>         单一复杂任务的临时讨论空间
```

Room 必须按 Team root session id 隔离，不能使用进程全局单例混合两个任务。

### 4.2 Durable 事件

新增或扩展以下事件类型，具体命名需与当前 DSH `SessionEventMap` 和事件迁移机制对齐：

```text
team/room/open
team/room/member-added
team/room/round-start
team/room/message
team/room/message-ack
team/room/round-close
team/room/decision
team/room/escalation
team/room/summary
team/room/archive
```

每条消息至少包含：

```json
{
  "roomId": "group:gameplay:tier-2",
  "roundId": "gameplay-17",
  "author": "gp-weapons",
  "kind": "fact|proposal|risk|question|decision-request",
  "content": "...",
  "references": ["commit", "file", "report", "test-output"],
  "replyTo": null,
  "createdAt": 0
}
```

### 4.3 轮流发言

每个 room 使用主持人和轮次：

1. 主持人提出主题和本轮问题。
2. 每个参与者最多一次主发言，可有一次短澄清。
3. 主持人始终是参与者；调用方未显式给出 host 时，运行时把 host 追加到最后。
4. 每个 Room 最多 3 轮。每轮仍保持一次主发言 + 至多一次短澄清。
5. 发言按固定成员顺序或 round-robin 顺序进行。
6. 单条发言限制长度，超长内容必须写入报告并引用路径。
7. 主持人关闭轮次，生成摘要和待决策项。
8. 第 3 轮关闭后仍有未解决项时，不允许重开同一 Room，必须转成 `team_escalate`。

模型请求不直接注入完整历史，而是注入：

```text
当前轮次摘要
当前决议
未解决问题
依赖和冲突
最近证据引用
下一位发言者
```

原始 room transcript 只供按需读取或 verifier 审计。

### 4.4 群聊工具

新增工具：

- `team_room_open`
- `team_room_join`
- `team_room_post`
- `team_room_read`
- `team_room_next`
- `team_room_close`
- `team_room_decide`
- `team_escalate`

现有 `send_message` 改为兼容层：

- 同组同级目标默认转换为 room message。
- 上级目标默认转换为静默 room 摘要。
- 需要立即打断时拒绝普通消息并提示使用 `team_escalate` 或 interrupt 工具。
- 直接一对一消息仅用于明确的短确认、控制回执或 room 主持人分发。

## 5. 升级和唤醒协议

### 5.1 `team_escalate` 请求格式

```json
{
  "category": "contract-conflict|blocked|timeout|security|merge-risk|product-decision",
  "summary": "一句话描述",
  "decisionNeeded": "上级必须选择什么",
  "attemptedRoom": "room + roundId",
  "options": [
    { "id": "A", "tradeoff": "..." },
    { "id": "B", "tradeoff": "..." }
  ],
  "references": ["task", "commit", "test", "screenshot"],
  "urgency": "normal|high|critical"
}
```

### 5.2 升级门禁

除 `critical` 外，升级必须满足：

- 已经完成至少一轮横向讨论；
- 已明确未解决问题；
- 已提供至少一条可复现证据；
- 已列出可选方案或说明为什么没有方案；
- 已确认不是普通进度汇报。

违反门禁时不唤醒上级，只把请求退回 room 并提示缺少字段。

### 5.3 唤醒收敛

每个 root、组长和成员维护 durable wake episode：

```text
queued -> delivered -> started -> acknowledged -> resolved
```

同一 episode 内的普通消息合并成一条摘要，只允许一条唤醒。上级在处理完一轮后统一读取所有未决摘要，不为每条消息单独启动模型回合。

## 6. Dispatch 生命周期和可靠性

当前异步消息没有 per-message completion，必须新增 dispatch ledger：

```text
dispatch-created
  -> queued
  -> delivered
  -> turn-started
  -> first-observation
  -> checkpointed
  -> response-recorded
  -> completed

失败状态：delivery-failed / run-failed / timed-out / cancelled / expired
```

### 6.1 每个 dispatch 的字段

- `dispatchId`
- `teamRootId`
- `roomId` / `taskId`
- `sender` / `target`
- `messageHash`
- `createdAt` / `deadlineAt`
- `wakeup`
- `status`
- `attempt`
- `runId`
- `firstCheckpoint`
- `lastError`
- `resolvedAt`

### 6.2 Run lease

成员开始执行时必须领取一个 run lease：

- 一个成员同一时间只能有一个 active run。
- lease 必须有 heartbeat 或阶段 checkpoint。
- 超时后进入 `expired`，不能仅依赖 `agent/status` 推断完成。
- 中断必须等待状态收敛，并记录 `cancelled` 或 `interrupted` 的实际结果。
- `spawn_teammate` 成功只代表成员已登记，不代表成员已经开始工作。

### 6.3 最小可观测指标

每个任务和成员记录：

- queue age；
- delivered time；
- turn started time；
- first checkpoint time；
- last checkpoint；
- last commit SHA；
- last test result；
- last verifier finding；
- frozen / failed / active 状态；
- token、缓存 token、重试、上下文拒绝次数。

## 7. 持久化和状态恢复

### 7.1 Board 持久化

当前 level/group board 使用进程内 `Map`，必须改为 durable board store：

- global、level、group 使用统一 CAS 数据模型；
- task create/update/reopen/delete/claim/complete 都落 durable event；
- 每个 board 有 monotonic revision；
- 重启后从事件重放恢复；
- 多进程读取不能看到各自独立的内存副本；
- `/team meta` 只能读取恢复后的 projection。

如果 DSH 现有 global board 事件不足，新增正式 `team/board/*` 事件，不再把 group/level board 作为“临时辅助状态”。

### 7.2 Policy projection

`team-policy` 继续作为 projection，但必须区分：

- durable membership fields：tier、group、parent、route、frozen；
- runtime cache：当前 Agent 对象、定时器、监听器；
- counters：lifetime creates、active slots、token budget。

重建失败不能静默吞掉。`team-operator` 和 `team-tools-v2` 必须使用同一个 `reconcileRegistry(active.registry, roster)` 路径，并对失败写出结构化日志和健康状态。

### 7.3 配额分离

严格拆分三个指标：

```text
activeSlots       当前非 frozen、非 failed 成员数量
lifetimeCreates   从 Team 创建开始单调递增的创建次数
tokenBudget       Team / group / task 的 token 预算
```

冻结只释放 `activeSlots`，不减少 `lifetimeCreates`。失败 spawn 是否消耗 lifetime create 必须在域层统一定义并测试；不能由策略层另行猜测。

## 8. 上下文预算和压缩

### 8.1 请求前预算

压缩不能只在 idle 后尽力而为，必须在 `agent/pre-step` 或 `agent/request` 之前做预算检查：

```text
inputTokens + reservedOutputTokens + safetyMargin <= contextWindow
```

其中 `reservedOutputTokens` 不能固定取满模型上限，应根据路由和任务类型配置上限；`safetyMargin` 用于工具结果、系统段和传输包装的误差。

### 8.2 压缩状态机

```text
armed
  -> pending-idle
  -> compacting
  -> compacted
  -> acknowledged

失败：retryable / blocked-by-running / failed-permanent
```

`pending-idle` 必须 durable。一次压缩因为 busy、服务不可用、写 marker 失败而跳过后，下一次请求前必须重试或明确拒绝继续扩大上下文。

### 8.3 里程碑边界

- 成员必须在执行前声明自己的阶段和 `done_when`。
- `done` 只表示已具备压缩条件，不在回合中强行压缩。
- idle 时触发折叠；到 hard threshold 时无条件进入 pending。
- 压缩前必须确保任务板、room decision、commit、验证结果已经落盘。
- 压缩后模型只能依靠 durable summary、board 和 evidence index 恢复工作。

### 8.4 避免互相污染

- 阈值提醒进入 room 或短消息，不写动态 system prompt。
- 上级只收到成员的结构化摘要，不收到每次阈值提醒全文。
- 多个提醒在同一 episode 合并为一条。
- 上下文接近硬上限时禁止继续开启新的子任务，先完成压缩或升级。

## 9. 验证责任分层

### 9.1 成员自检

成员只能运行与自身修改直接相关的低成本检查：

- 语法和类型；
- 目标模块单测；
- 直接接口存在性；
- 最小 smoke test；
- 资源路径存在性。

成员不得重复全项目验收，不得自行声称最终交付，不得把无关探索测试当作验收证据。

### 9.2 组长 Group Acceptance Packet

每个组只允许向 verifier 提交一份汇总包：

```text
group
task ids
commit SHA
changed files
requirement ids
member checks
group checks
commands
expected / actual
screenshots
resource scan result
known risks
remaining blockers
```

组长必须先和同组成员、其他组长完成必要的 room 协商，再把跨组结论一次性提交给 verifier。

### 9.3 Verifier Review Packet

verifier 只对明确的 commit SHA 或最终集成 SHA 工作，输出结构化 finding：

```text
findingId
severity: blocker|major|minor|nit
commitSha
requirementId
reproCommand
expected
actual
rawOutput
screenshotPath
resourcePath
owner
status
```

verifier 不接受“看起来没问题”“自测通过”作为独立证据。

### 9.4 一次性审查原则

- 组员不直接打扰 verifier。
- 组长先收齐本组结果，再向 verifier 提交。
- verifier 一次性审查当前集成候选，集中输出问题清单。
- 修复后只重测受影响的 finding 和最终回归集合，不重复跑无关探索。

## 10. 呈现、资源和领域适配验收

这一节不是游戏专用规则，而是所有需要人或其他系统消费的产出都必须遵守的通用验收框架。它适用于 Web/UI、API/服务、CLI/自动化、文档/表格/媒体、数据可视化、3D/游戏等领域。具体领域只负责提供自己的适配检查器。

### 10.1 多视角、多状态和边界覆盖

对每个交付对象、页面、接口输出、文档、数据集或媒体结果，至少覆盖：

- 正常路径、空输入、最小值、最大值、异常值和缺失值；
- 初始、处理中、成功、失败、取消、重试和恢复状态；
- 权限不同、角色不同、配置不同和依赖不可用时的行为；
- 主视图与替代视图、不同尺寸、不同分辨率、不同编码或不同客户端；
- 前后关系、边界位置、遮挡/裁剪、溢出、分页、排序和并发变化；
- 任何领域特有的方向、维度、坐标、时序或输入方式。

如果交付物具有空间或视觉维度，再补充正面、背面、侧面、顶部、底部、近景、中景、远景、不同光照和不同背景等视角。三维六面检查只是一个适配案例，不能成为所有任务的默认测试模板。

证据必须来自真实入口、真实运行态或真实消费链路。截图、录屏、API 响应、命令输出、导出文件和日志都可以作为证据；缩略图、静态 mock 或仅对内部函数的检查不能替代最终消费面证据。

### 10.2 资源、依赖和输出完整性扫描

在最终审查前必须执行与领域匹配的完整性扫描：

- 文件、引用、依赖、配置、schema、字体、媒体、模型或数据源是否存在；
- 文件大小、编码、格式、版本、校验和、metadata 和序列化是否有效；
- 输入到输出的映射是否完整，是否存在默认值、截断、丢字段或空结果；
- 运行时 fallback、降级、缓存、重试和错误返回是否符合契约；
- 输出是否出现空白、全零、全空、乱码、异常格式、重复数据或不可解释的默认结果；
- 日志、warning、异常、依赖加载失败、权限拒绝和超时是否被完整记录。

### 10.3 呈现和结果问题分类

Verifier 必须先区分“设计如此”和“实现异常”，不能根据单个结果直接下结论：

```text
intentional-output
missing-asset
fallback-output
formatting-or-rendering-failure
data-binding-or-serialization-error
layout-or-geometry-issue
occlusion-or-clipping
dependency-or-import-failure
permission-or-configuration-error
runtime-error
accessibility-or-localization-issue
```

### 10.4 真实使用者式端到端验收

验收必须模拟实际消费者，而不是只验证内部函数：

- Web/UI：真实打开、点击、输入、导航、刷新、返回、空态、错误态和恢复；
- API/服务：真实请求、鉴权、超时、重试、并发、幂等、错误码和响应 schema；
- CLI/自动化：真实命令行入口、参数组合、标准输入输出、退出码、信号、中断和重跑；
- 文档/表格/媒体：真实打开、导入、导出、分页、渲染、编码、打印或下游消费；
- 数据/分析：真实数据源、空集、异常值、边界范围、排序聚合和结果可追溯性；
- 3D/游戏：真实入口、输入方向、碰撞、视角、资源加载和玩家流程，作为上述通用规则的一个适配器。

每条流程都要覆盖正常、失败、取消、重启、恢复、依赖缺失和权限变化路径。必须记录可重放的输入/请求序列、版本或 commit、关键状态、原始输出和最终结论，不能只看一个静态截图、单个正面结果或一次偶然成功。

## 11. Worktree、合并和 verifier clearance

### 11.1 绝对路径解析

所有 source/destination worktree 必须根据 branch 解析成绝对路径。禁止使用当前进程 cwd 作为隐含目标。

### 11.2 Exact SHA 合并协议

```text
resolve source branch
resolve source worktree
read source SHA
verify source worktree clean / expected state
acquire repository merge lock
load verifier clearance for exact SHA
re-read source branch SHA
if SHA changed: abort and request new review
merge exact SHA, never mutable branch ref
verify destination HEAD
write merge result and evidence
release lock
```

### 11.3 Clearance 绑定

verifier clearance 至少绑定：

- commit SHA；
- tree hash；
- 受审文件集合；
- 验证命令 digest；
- 证据包 digest；
- finding 状态。

任一项变化都必须重新审查。不能只检查“分支名相同”。

### 11.4 合并失败处理

- 冲突只报告，不自动猜测解决。
- 目标 worktree 出现冲突时进入 `merge-conflict`，禁止继续写入。
- 合并工具返回 source、destination、SHA、lock、冲突文件和回滚状态。
- 主分支合并后必须重新运行最终 acceptance gate。

## 12. Write scope 和安全边界

write-scope guard 必须 fail-closed：

- scope 文件缺失、JSON 损坏、字段类型错误时，拒绝写入；
- `enforce: true` 自动等价于 `defaultDeny: true`，除非显式声明相反且经过配置校验；
- 不允许继续使用上一次缓存 scope 掩盖当前配置损坏；
- 读取、校验、替换缓存必须原子化；
- 作用域路径必须 canonicalize，防止 junction、`..`、大小写和短路径绕过；
- shell、编辑器、文件写入和 worktree 操作使用同一份授权来源；
- 每次拒绝记录 actor、target、scope version 和 reason code。

启动时必须验证 scope 配置，错误要让 profile 进入明确的 degraded/disabled 状态，而不是悄悄放行。

## 13. Operator 通道

`/team` 保留，但必须调用与模型工具相同的 durable action API，只在 actor kind 上明确区分 `human-operator`：

- operator 可越过模型级 peer policy；
- 不能绕过 worktree、数据一致性、merge lock 和 evidence gate；
- freeze/restore、abort、route、spawn 失败时必须回滚内存投影或标记 pending；
- `/team list/meta/usage` 读取持久化 projection，不读取未恢复的临时 Map；
- `/team abort` 必须有完整的 interrupt result、freeze result 和失败回滚。

## 14. 启动和插件依赖

当前日志显示 `step-compaction`、`team-usage-projection` 的依赖或 projection 配置错误曾经导致整个 profile 无法启动。v5 必须：

- 为每个实验插件声明强制依赖和可选依赖；
- 启动前做配置 schema 校验；
- projection 必须提供合法非负 `stateVersion`；
- 可选 observability/compaction 插件失败时不能静默破坏整个 Team；
- profile 启动输出健康报告：enabled、disabled、degraded、reason；
- 关键安全插件失败时 fail-closed；非关键统计插件失败时只禁用其功能；
- 所有插件卸载必须取消 timer、listener、retry 和后台任务，直到真正 quiescent。

## 15. UI 和可观测性

面板需要从“成员列表”升级为“团队控制台”，至少显示：

- Team root id；
- 每个成员的 tier/group/parent/status/frozen；
- 当前 room、round、主持人和下一位发言者；
- 任务状态和 board revision；
- dispatch 状态和 queue age；
- last checkpoint、last commit、last test；
- verifier finding 数量和最高 severity；
- 当前 token、缓存 token、剩余预算和上下文比例；
- pending compaction；
- 未送达、超时、失败和需要人工决定的项目。

所有数字按 Team root 隔离，不再只显示 root session 自身消耗。

## 16. 测试计划

### 16.1 单元测试

- room 权限、轮次、发言顺序、摘要和关闭。
- escalation 字段和升级门禁。
- dispatch 状态转换和幂等重试。
- active slot / lifetime creates / token budget 分离。
- board CAS、revision、重放和 tombstone。
- policy rebuild 使用 `active.registry`。
- write-scope 缺失、损坏、过期、路径绕过全部拒绝。
- compaction pending、busy、retry、hard threshold。
- merge path、exact SHA、clearance、lock 和 TOCTOU。

### 16.2 集成测试

- 两个 Team 并发运行，成员、room、board、usage 不串线。
- 进程重启后 roster、room、board、dispatch、milestone 可恢复。
- 消息入队后 recipient dormant、running、failed、frozen 各状态的行为。
- 上级只收到 room 摘要和升级，不收到普通噪音唤醒。
- 一个成员没有启动时，系统可以检测 `delivered but not started` 并重试或升级。
- 中断、冻结、恢复和 abort 的 durable/live 状态一致。
- profile 插件依赖缺失时输出健康状态，不产生隐性启动失败。

### 16.3 Worktree 和合并测试

- source/destination 路径分别在 root、group、member worktree 下正确解析。
- source branch 在 clearance 后移动时 merge 必须拒绝。
- exact SHA 合并成功、冲突、目标脏、锁超时、进程中断均有明确结果。
- verifier detached checkout 不得产生隐式提交。

### 16.4 真实长会话测试

- 至少一个超过上下文窗口 80% 的长任务。
- 至少一次里程碑折叠，确认折叠前事实已落盘，折叠后可以恢复。
- 至少一次成员 dormant、消息排队、重新唤醒和 checkpoint。
- 至少一次进程停止后恢复。
- 记录总 token、有效产出 token、重复测试 token、无效唤醒次数和最终交付时间。

### 16.5 真实用户和领域适配验收

- 使用真实入口和真实消费链路，不使用仅测试页面、内部 stub 或局部函数替代。
- 按领域适配矩阵覆盖正常、边界、异常、取消、恢复、权限和依赖缺失状态。
- 对视觉或空间产出执行多视角、多尺寸、多距离检查；对非视觉产出执行多格式、多 schema、多客户端或多下游检查。
- 资源/依赖扫描、运行日志、原始输出和截图或录屏必须互相绑定。
- 输入、请求、命令、数据和环境配置必须可重放。
- verifier 报告必须引用原始文件、命令、输出、版本、状态和对应证据。

## 17. Delivery Gate

任何 Team 只有满足以下条件才能向 root 报告“可交付”：

1. 所有必要任务在正确 board 上为 `completed`。
2. 所有任务都有 owner、commit、验证记录和 evidence reference。
3. 没有 `delivered but not started`、`queued`、`expired` 或未解释的 frozen 成员。
4. 组长已经提交完整 Group Acceptance Packet。
5. verifier 已对 exact SHA 完成审查，没有 blocker/major finding。
6. 所有跨组接口已在 level room 决议并验证。
7. 目标分支已经按 exact SHA 集成，目标 HEAD 与记录一致。
8. 最终构建、启动、功能、错误路径和视觉资源扫描通过。
9. 最终集成 commit 上的测试不是成员分支上的旧结果。
10. Team 总 token、重试、上下文拒绝和未解决风险已汇总。

Root 的最终工具应当返回结构化 gate，而不是依赖模型阅读几十条汇报后自行判断。

## 18. 实施顺序

这是一次完整升级，但仍按依赖顺序实施，避免新协议建立在未修复的事实层上：

1. **Durable 基础**：board、room、dispatch、policy projection、counter 和事件迁移。
2. **状态机和执行租约**：plan approval、run lease、checkpoint、超时、取消和恢复。
3. **群聊和升级**：room、round-robin、summary、`team_escalate`、唤醒合并。
4. **验证管线**：member check、Group Acceptance Packet、verifier review packet、delivery gate。
5. **合并安全**：绝对路径、repo lock、exact SHA、clearance digest、冲突处理。
6. **上下文经济**：请求前预算、durable pending compaction、摘要恢复、Team 级预算。
7. **呈现、资源和领域适配验收**：多状态、多视角或多格式检查、资源扫描、真实使用流程和证据绑定。
8. **安全和启动**：write-scope fail-closed、插件健康状态、卸载 quiescence。
9. **UI 和指标**：room、dispatch、board、finding、usage 和风险可视化。
10. **完整回归**：单元、集成、重启、长会话、双 Team 并发、最终真实入口验收。

不能在第 1 到第 4 步未完成时继续通过增加成员、增加提示词或增加工具来解决效率问题。否则系统会把未解决的协调成本扩大到更多 agent。

## 19. 实施阶段的文件责任边界

预计涉及文件，实施时需先重新确认当前代码位置：

```text
D:\dsh-test\home\profiles\web\plugins\team-policy.mjs
D:\dsh-test\home\profiles\web\plugins\team-tools-v2.mjs
D:\dsh-test\home\profiles\web\plugins\team-operator.mjs
D:\dsh-test\home\profiles\web\plugins\team-worktree.mjs
D:\dsh-test\home\profiles\web\plugins\write-scope-guard.mjs
D:\dsh-test\home\profiles\web\plugins\step-compaction.mjs
D:\dsh-test\home\profiles\web\plugins\team-idle-watch.mjs
D:\dsh-test\home\profiles\web\plugins\team-milestone.mjs
D:\dsh-test\home\profiles\web\plugins\team-usage.mjs
D:\dsh-test\home\profiles\web\plugins\team-usage-projection.mjs
D:\dsh-test\home\profiles\teamtest\cordis.patch.yml
D:\dsh-test\phase1-tests\ ... \phase6-tests\
D:\dsh\workspaces\deepseek-harness\packages\ ...
D:\dsh\docs\agent-team-v2-design.md
D:\dsh\docs\agent-team-v3-plan.md
D:\dsh\docs\agent-team-v4-handoff.md
```

实施时必须遵守：

- 先在 `D:\dsh-test` 完成和验证；
- 不直接改 `D:\dsh` 生产实例；
- 不重启正在运行的用户任务；
- 每个事件格式修改都要保留迁移和回滚路径；
- 每个 durable state 都要做冷启动恢复验证；
- 所有“完成”声明必须来自真实命令、journal、commit 或截图证据。

## 20. 完成定义

v5 只有在以下条件同时满足时才算完成：

- 普通协作默认在 room 内横向完成，不再频繁唤醒上级。
- 上级只收到摘要和结构化升级。
- 每个执行任务都有 plan、run、checkpoint、commit 和 evidence 链。
- room、board、dispatch、milestone 和 policy 在重启后可恢复。
- 成员不再自行重复完整验收，verifier 对最终 SHA 一次性集中审查。
- 呈现验收覆盖领域所需的多状态、多视角或多格式，资源完整性和真实使用流程。
- 上下文请求不会因为迟到的压缩再次撞上限。
- write-scope 和 merge gate 失败时默认拒绝，不会静默放行。
- 最终 delivery gate 能机器化判断“是否真的完成”。
- 长会话的有效产出、总 token、无效测试、无效唤醒和交付时间都有可比较指标。

达到以上定义后，再根据实测数据调整模型、组员数量和默认预算；不要在协议未稳定前继续扩大团队规模。
