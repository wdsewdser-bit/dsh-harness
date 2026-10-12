# Agent Team v6 Implementation Handoff

更新时间：2026-09-16

本文记录当前真实实现，不重复 v5 的计划愿景。v5 是目标设计，v6 是已经把哪些约束下沉到代码、真实跑过什么、还有哪些升级易失点和已知缺口。

## 1. 当前运行基线

- DSH 测试实例：`D:\dsh-test`
- DSH 版本基线：`0.1.6-alpha.1`
- Web 启动：`D:\dsh-test\start-dsh-test.bat`
- Web 停止：`D:\dsh-test\stop-dsh-test.bat`
- 默认端口：`40123`
- 测试实例 home：`D:\dsh-test\home`
- 控制面持久目录：`D:\dsh-test\home\team-control-plane`
- 生产目录 `D:\dsh` 没有应用这些测试实例补丁。

测试验证必须使用真实的 `D:\dsh-test` 实例；只做 `node --check` 或 mock 单测不能视为浏览器、唤醒和 Room 全链路完成。

## 2. 当前已经实现的能力

### 2.1 Team 层级、配额和身份

- tier 0：会话 Lead。
- tier 1：组长和独立 verifier。
- tier 2：组员。
- 内置角色：`lead`、`member`、`verifier`、`custom`。
- 角色身份来自 `D:\dsh-test\home\team-roles`，任务简报与 standing identity 分离。
- 成员支持冻结、恢复、模型路由、可见性、消息和 interrupt 权限。
- Team 状态按 root session id 隔离，不会在两个会话间串 roster/board/room。
- 失败 spawn 保留诊断记录，但不占用公共名字、活动名额或 lifetime create budget。
- domain 现在持久化每个成员的 `level`、`groupId`、`parentName`；对应
  `teamMemberSnapshotSchema`、projection 和 invariant schema 同步允许这三个字段。
  成员层级因此可以跨 DSH 重启恢复，不会在重建时全部退化成 tier 1。

### 2.2 Room 和讨论协议

- Room 类型：`group:<group>:tier-2`、`level:1`、`root`、`task:<task-id>`。
- 每个 Room 最多 3 轮，第 4 轮直接拒绝。
- 每轮每人最多 1 次主发言 + 1 次短澄清。
- 主发言上限 4000 字符；澄清上限 800 字符。
- 发言严格按 `nextSpeaker` 顺序；非当前 speaker 不能发主发言。
- 澄清必须发生在本人主发言后，不推进下一位 speaker。
- host 始终是参与者；调用方没有列出 host 时，运行时自动把 host 追加到最后。
- 全部 `round.order` 成员完成主发言后，host 被唤醒关闭轮次。
- 关轮必须提供 `summary`；同时可提供 `unresolved`。
- 每轮摘要现在持久化在 round 上，便于面板按轮展示。
- 第 3 轮关闭后仍有 unresolved，不允许重开同一 Room，应使用 `team_escalate`。

### 2.3 看板和任务状态机

- 全局板、level 板、group 板，按层级和 group 隔离。
- 任务 revision + CAS 更新，避免并发覆盖。
- 状态：`pending`、`in_progress`、`completed`、`deleted`。
- phase 管线包含 `draft`、`room-discussion`、`plan-proposed`、`plan-approved`、`execution`、`member-check`、`group-check`、`verifier-review`、`integration-ready`、`integrated`、`accepted` 等阶段。
- 声明 `writeScopes` 的任务不能在没有批准 plan 时完成。
- 完成必须经过：批准 plan、execution phase、owner lease、commit SHA、已落库 evidence。
- `team_delivery_check` 收集所有 durable board 任务；已完成任务至少检查 owner 和 evidence，有 plan/scope 的再检查 commit、phase 和 acceptance packet。
- 成员 tick milestone 时，如果本人还有 open task，工具结果会返回 `openTasks` 和 board warning。
- 全队 idle 唤醒时，root 被明确要求先调用 `team_delivery_check`。

### 2.4 唤醒和投递

- `send_message` 为静默 durable mailbox；不应唤醒上级。
- `team_escalate` 是普通流程里唯一允许唤醒上级的动作。
- Room 交接消息带 `AbortSignal`，不会再次出现 `signals[0] ... undefined`。
- mailbox 在 signal 缺失时回退 lifecycle signal。
- 目标真正开始 step 后，已投递控制消息推进到 `turn-started -> completed`，不再被误判 `timed-out`。
- tier 1 给本组 tier 2 的控制消息走 group room，不再错误进入 member 不能加入的 `level:1`。
- Team 成员的 continuable subagent settlement 使用 `parent.inject`，不再每次子代理结束都开新的 parent turn。
- `team-idle-watch` 使用进展感知预算：连续无交付进展才停止提醒；任务、Room 摘要/决策、escalation、packet 有变化会重置计数。
- idle 绝对兜底为 20 次/Team；连续无进展阈值默认 3。

### 2.5 Web 控制面板

面板顶部标签：

- 成员
- 看板
- 协作房间
- 消息投递

Room tab 现在是可交互的：

- 每个 Room 行可点击进入详情。
- 详情展示 room id、host、状态、讨论预算 `used/3`。
- 展示最新摘要、未决项、决议。
- 按 round 展示 topic、状态、该轮摘要、未决项和消息。
- 每条消息显示 author、kind、主发言/澄清/通知、时间和正文。
- 有专门返回房间列表按钮。

相关客户端文件是 profile 下的 `node_modules` 安装副本，升级依赖会覆盖。

### 2.6 失败 spawn 的名称和额度回收

背景问题：并发 spawn 时 `beta-m1` 首次失败后 domain 写入 `phase=failed`，旧逻辑把它当成永久名字和永久名额。

当前语义：

- failed 记录继续保留，运行诊断时仍能看到失败原因。
- spawn 唯一性忽略 `phase=failed` 记录，同名可以重新创建。
- domain `maxMembers` 只计算非 failed 成员。
- policy registry 不把 failed 行投影为活跃成员。
- `canSpawn`、tier cap、group cap、lifetimeCreates 均忽略 failed。
- counters 现在允许 lifetimeCreates 下降，修复历史 failed 占用。
- 成功的新成员如果复用了旧 failed 名字，active 解析优先查找 `phase=active` 的记录。
- 已实测：一个因旧 schema 拒绝层级字段而 `agentTeam.failure` 的会话，在重启并修复
  schema 后自动恢复；随后 `lead-x` 成功创建 `x-m1`，再次重启仍得到
  `lead-x tier1 / x-m1 tier2 parent=lead-x`。

## 3. 与 v5 的主要差异

| 领域 | v5 计划 | v6 当前实现 |
|---|---|---|
| Room 轮次 | 每轮 1 主发言 + 1 澄清，可多轮但未定上限 | 每 Room 硬上限 3 轮，第 4 轮拒绝 |
| Host | 主持人关闭轮次，是否参与未强制 | host 必入 round，调用者漏写时自动追加最后 |
| Room 摘要 | room 上保留最新摘要，round 摘要形态未明确 | `round.summary` 持久化；面板按轮显示 |
| Room UI | 计划有 room/round 呈现 | 已完成 tab、可点击房间、按轮查看完整消息 |
| 完成门禁 | 目标有完整 delivery gate | scoped/planned task 的 plan、commit、evidence 已硬拒；所有 completion 要求 evidence |
| 看板遗漏 | root 手工判断 | milestone tick 返回 openTasks；idle reminder 明确要求 delivery_check |
| 唤醒 | 逻辑上尽量少唤醒 | signal 崩溃修复；settlement 降噪；idle 进展预算防 ping-pong |
| 失败 spawn | 未定义 | 失败保留诊断但不占名字、active slot、lifetime quota |
| 路由 | 同组 peer 默认 Room | tier1 -> tier2 控制消息修正为 group room |
| 空 Room | 旧 task room 可能残留 | hostless empty task room 自动清理 |

## 4. 关键文件地图

### 4.1 Agent Team profile 插件

Web 和 headless 各有一份，改一处必须同步另一个：

- `D:\dsh-test\home\profiles\web\plugins\team-control-plane.mjs`
- `D:\dsh-test\home\profiles\web\plugins\team-policy.mjs`
- `D:\dsh-test\home\profiles\web\plugins\team-tools-v2.mjs`
- `D:\dsh-test\home\profiles\web\plugins\team-idle-watch.mjs`
- 对应的 `headless\plugins` 副本

职责：

- `team-control-plane`：room、round、dispatch、lease、escalation、evidence、packet、board 持久状态。
- `team-policy`：tier/group 权限、配额、父子关系、冻结投影。
- `team-tools-v2`：模型可见工具和所有工具级硬限制。
- `team-idle-watch`：全队停工时进展感知唤醒。

### 4.2 Web 客户端

- `D:\dsh-test\home\profiles\web\node_modules\@deepseek-ai\dsh-experimental-client-ui-agent-team\lib\client.js`

该文件是直接修改的安装副本，包含：

- 四个顶部标签。
- Room row 点击。
- Room detail 轮次、摘要、消息展示。

### 4.3 app-plane subagent 核心补丁

- `D:\dsh-test\app\node_modules\@deepseek-ai\dsh-subagent\lib\index.js`
- `D:\dsh-test\home\profiles\node_modules\@deepseek-ai\dsh-subagent\lib\index.js`

补丁点：Team 成员 settlement 使用 `parent.inject`，避免子代理每次结束都唤醒 parent。

回滚/重应用说明：

- `D:\dsh-test\REVERT-dsh-subagent.md`

### 4.4 agent-team domain

- `D:\dsh-test\home\profiles\web\node_modules\@deepseek-ai\dsh-experimental-agent-team\lib\index.js`
- `D:\dsh-test\home\profiles\web\node_modules\@deepseek-ai\dsh-experimental-agent-team\lib\types\roster.js`
- 对应 headless 副本

补丁点：

- signal 缺失兼容。
- failed spawn 释放名字和配额。
- active name resolution 只选择 active phase。

### 4.5 配置

- `D:\dsh-test\home\profiles\web\cordis.patch.yml`
- `D:\dsh-test\home\profiles\headless\cordis.patch.yml`

关键配置：

```yaml
maxRoomRounds: 3
```

idle watch:

```yaml
settleMs: 30000
maxNoProgressReminders: 3
maxReminders: 20
```

## 5. 验证

全量回归命令：

```powershell
$tests = Get-ChildItem -Path .\phase1-tests,.\phase2-tests,.\phase3-tests,.\phase4-tests,.\phase5-tests,.\phase6-tests,.\phase7-tests -Recurse -File -Filter *.test.mjs | ForEach-Object { $_.FullName }
node --test $tests
```

当前基线：30 个测试文件全部通过。

重点回归：

- `phase7-tests/room-wake-signal.test.mjs`
- `phase7-tests/control-plane-v5.test.mjs`
- `phase7-tests/delivery-gate.test.mjs`
- `phase6-tests/idle-watch.test.mjs`
- `phase4-tests/policy-reconcile.test.mjs`
- `phase3-tests/team-tools-v2.test.mjs`

真实浏览器验收至少覆盖：

1. 启动 `start-dsh-test.bat`。
2. 打开 Agent Team。
3. 四个 tab 可以切换。
4. Room tab 可以点击进入。
5. 详情能看到 round、summary、unresolved、逐条消息。
6. Room 预算展示不超过 3。
7. 新 Team 的 round order 包含 host。
8. 完成 scoped task 没有 plan/evidence 时被拒绝。
9. 全队停工后 root 收到 idle，且 idle 本身会完成。

## 6. 升级时的易失点

DSH/插件重装后，以下直接 patch 很可能丢失，必须重新检查：

1. `dsh-subagent.notifySettlement` 的 Team 不唤醒补丁。
2. `dsh-experimental-agent-team` mailbox 的 undefined signal 兼容。
3. domain 的 failed spawn 名字/配额回收。
4. Web client 的 tabs 和 Room detail。
5. team tools、control plane、idle watch 和两个 profile 的配置。
6. domain 持久化 schema 与 roster 类型中的 `level/groupId/parentName` 必须同时存在；
   只给 spawn 逻辑加字段而漏掉 zod schema，会让整个 Team 投影进入 failure。

建议的升级顺序：

1. 备份 `D:\dsh-test\app`、profile plugins、profile node_modules、`cordis.patch.yml`。
2. 升级 DSH 和插件。
3. 先跑原始 30 项测试，判断基线。
4. 重放控制面/工具层改动。
5. 重放 subagent/domain 核心补丁。
6. 重放 client.js UI 改动。
7. 重启 web/headless，做真实 Room 和 spawn 验证。
8. 更新本文档，记录新的版本号和覆盖点。

## 7. 已知缺口和风险

- `client.js` 是安装副本修改，不是上游源码 patch，重装依赖会覆盖。
- 2026-09-16 之前的旧 round 没有 `round.summary`，面板只能展示 room 最新摘要和消息；历史轮次摘要无法追溯恢复。
- 3 轮预算按 Room 生命周期计算。已经用满 3 轮的旧 Room 升级后会直接锁定，需要新 Room 或升级，不会自动重置。
- failed 记录仍存在于 domain roster；原始 roster 中可能出现同名 failed 与 active 两条。需要看诊断时按 phase 区分。
- 本次修复前已经创建、且 journal 中从未写入 `level/groupId/parentName` 的旧 Team，
  重启后仍会扁平化。此类旧 Team 需要在修复版本中重新创建，或手工修复历史事件，
  不能只靠新 schema 反推原层级。
- 看板提醒是强制可见 warning，不会自动代替 owner 完成或 reopen task。任务状态仍必须由有权限的成员显式变更。
- Room detail 当前展示完整 room messages，暂未做分页；超长会话需要后续增加懒加载或截断。
- Room detail 的圆桌预算文案固定显示 `/3`；若 profile 修改 `maxRoomRounds`，UI 文案也应同步，当前实现没有读远端配置。
- `team-idle-watch` 的无进展判断是语义近似：任务、已关闭轮次摘要/决策、escalation、packet 变化算进展；普通 room 消息和 dispatch 不算。

## 8. 下一阶段建议

优先级从高到低：

1. 把 client.js 改动固化成可重放 patch 或 fork 包，避免升级覆盖。
2. 给 Room detail 增加轮次筛选、作者筛选和消息分页，处理超大 transcript。
3. 让面板显示 failed spawn 的诊断原因，并提供一键“清理失败记录/重试同名 spawn”操作。
4. 将 board warning 升级成 owner 下一步的强制检查：有 evidence 但 status 仍 in_progress 时，不允许声明 milestone done。
5. 把 `maxRoomRounds` 从控制面传给 Web client，动态显示真实预算。
6. 为 domain failed spawn、同 session 同名复用、counters 回落增加真实实例 E2E，而不只依赖 policy mock。

## 9. 接手入口

先读：

1. 本文。
2. `D:\dsh\docs\agent-team-v5-full-plan.md`：目标设计。
3. `D:\dsh\docs\agent-team-v2-design.md`：历史踩坑和修复原因，重点看 §56、§64、§65。
4. `D:\dsh-test\REVERT-dsh-subagent.md`：app-plane 核心补丁回滚方法。

然后运行：

```powershell
D:\dsh-test\stop-dsh-test.bat
D:\dsh-test\start-dsh-test.bat
```

最后用 Web UI 打开 Agent Team，至少验证 Room 详情、3 轮预算、host 参与、board warning 和 spawn 失败恢复。
