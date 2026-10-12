# Agent Team v9 Handoff

更新时间：2026-09-18  
范围：`D:\dsh-test`。生产 `D:\dsh` 未修改。  
基线：`agent-team-v8-handoff.md`。  
本文记录 v8 之后到当前状态的差异、压缩问题根因、热重载边界、启动补丁、验证证据和接手注意事项。下一位接手者应先读 v8，再读本文；只关心最近的压缩问题时可从第 3 节开始。

## 1. 与旧文档的关系

### v7 已覆盖

- Room speaker handoff、parent round 依赖、未决项销账。
- `waitAction`、禁止 Room 内 `wait_agent`。
- `workKind`、write scope、plan、lease、完成顺序。
- global/domain 双状态源、worktree 推断、opaque shell write fail-closed。
- delivery reference 的源任务校验。

### v8 已覆盖

- 冻结与活跃容量：30 个 active slots，无终身创建上限。
- 一次性提权：request/review/activate/end。
- 普通 `send_message` 静默，阻塞升级用 `team_wake_superior`。
- Room 最多 3 轮，host 纳入 members，第三轮后必须升级。
- 里程碑 v3：Team 隔离、history、revision、独立 compaction job。
- 控制面板 tabs：Members、Frozen、Boards、Rooms、Dispatches。
- `in-history` system prompt update，避免动态 milestone 破坏缓存。
- pnpm 持久 patch：web/headless workspace + lock。
- Stagehand Anthropic 路由和原生 CUA 适配。

### v9 新增或明确变更

v9 不是新功能大版本，而是 v8 后对“里程碑与压缩生命周期”的一次系统纠偏，并补充了可重建的启动/热重载边界。

1. `step-compaction` 优先在 milestone job 处 fold；无 tick 时在 75% 压力阈值做 idle safety fold。
2. pre-step 只负责真正的物理预算保护，不再把 75% 压力当成拒绝用户消息的硬门。
3. 修复 milestone job 重复消费：Team tools 不再缓存旧 milestone 文档，pre-step 保存前重新读盘。
4. preset 内 `compaction-basic.auto` 统一为 `false`；手工 `/compact` 保留。
5. 新增启动补丁 `patch/ensure-milestone-only-compaction.cjs`，在每次启动时幂等确保上述 preset 配置。
6. Web 活动入口迁移到 `team-tools-v2-r3.mjs` 和 `step-compaction-v3.mjs`，避免 ESM 同 URL 缓存。
7. 新增 web 专属 `team-preset-hot-reload.mjs`，用于把 idle 的 `ptc` agent 重连到新的 preset generation。
8. Phase 5/6 测试已按 milestone 优先 + pressure safety 语义更新。
9. v8 中“hard-threshold 压缩不消费 milestone job”的表述已过期；v9 改为“job 优先，pressure safety 兜底”。
10. 修复显式用户 turn 在压力门下 `blocked` 后没有落成 `user/message` 的输入丢失问题。

## 2. v8 -> v9 差异表

| 项目 | v8 行为 | v9 当前行为 |
|---|---|---|
| 无 tick、上下文达到 75% | hard-threshold 自动 fold | idle safety fold，不吞用户 turn |
| 无 tick、上下文达到 80% | preset 内原生自动 compaction 可能触发 | `compaction-basic.auto=false`，原生自动链关闭 |
| 有旧 pending job、agent idle | 可能反复 `/compact` | job 成功后必须写回 `compacted/consumed`，且旧快照不能覆盖 |
| Team tools 读 milestone | 进程内只读一次并缓存 | 每次访问重新读盘 |
| pre-step 保存 reminder | 可能保存旧整份文档 | 保存前重新读取并只更新新的提醒状态 |
| Web 压缩插件入口 | `step-compaction.mjs` | `step-compaction-v3.mjs` |
| Web Team tools 入口 | `team-tools-v2-r2.mjs` | `team-tools-v2-r3.mjs` |
| Web 共享 milestone 模块 | `team-milestone.mjs` | `team-milestone-v2.mjs` |
| preset 压缩策略 | shipped default `auto:true` | startup ensure 补丁改成 `auto:false` |
| 热重载策略 | 同路径修改偶尔受 ESM cache | 新入口文件名；preset 变更优先重启验证 |

## 3. 为什么 20 万上下文也会压缩

### 3.1 现象

用户观察到某个成员上下文约 20 万 token，却仍出现：

```text
compact · 已压缩 62 条历史记录（约 126175 tokens）
```

这个量级不可能命中：

```text
1,000,000 * 0.75 = 750,000
```

因此它不是一个 75% 阈值误判，也不是“窗口只有 20 万”的假设。

### 3.2 实测证据

以 web 会话 `81e4f948-46e1-4d3e-a149-66b26ece976d` 为例：

- 2026-09-18 20:31 压缩前最后一次真实请求 usage：`totalTokens ≈ 125374`。
- 对应上下文窗口：`1,000,000`。
- 同一成员更早已经 tick 过 milestone，并留下了 `pending-idle` compaction job。
- 18:49、20:16、20:31、20:46 连续出现压缩，间隔和 idle 时点吻合。
- 这不是“每次任务结束都该压缩”，而是同一个旧 job 在多次 idle 中反复被执行。

### 3.3 根因链

1. milestone `done` 写入 `compactions[owner] = pending-idle`。
2. `step-compaction` 在 idle 读取 job，执行 `/compact`，成功后写 `compacted/consumed`。
3. `team-tools` 之前把 `team-milestones.json` 缓存在进程内，且会保存整份旧文档。
4. 后续 pre-step reminder、milestone tool 或 reconcile 保存旧快照时，把 `consumed` 状态覆盖回 `pending-idle`。
5. 下一次 idle 又看到一个“合法”的 pending job，于是重复压缩。
6. 模型看不到新的 `team_milestone` 调用，只是因为旧 job 已经足够；不需要重新 tick。

### 3.4 修复思路

不是再给“20 万触发”加阈值，而是修复状态机：

- job 必须有明确 revision。
- 成功压缩必须能原子地写回完成状态。
- 任何其他插件不能拿旧快照覆盖该状态。
- 无 job 时，任何上下文压力都不能生成 fold。
- 达到压力门禁时，宁可阻断下一步，也不能偷偷压缩。

## 4. 当前压缩架构

### 4.1 两条路径

当前只保留两种上下文动作：

```text
milestone done
  -> arm compaction job
  -> agent idle
  -> step-compaction consumes job
  -> /compact
  -> mark consumed

no armed milestone
  + pressure >= autoCompactRatio
  -> idle safety fold
  -> mark pressure job compacted

physical budget insufficient
  -> reject only the unsafe next step
```

### 4.2 当前常量

`step-compaction-v3.mjs` 默认：

```js
windowTokens: 1048576
autoCompactRatio: 0.75
reservedOutputTokens: 32768
safetyMarginTokens: 8192
enablePreStep: true
```

`team-milestone-v2.mjs`：

```js
MILESTONE_REQUIRED_RATIO = 0.75
HARD_RATIO = MILESTONE_REQUIRED_RATIO
```

注意：`HARD_RATIO` 现在只是兼容名称，表示硬拒绝门禁，不再是自动 fold 阈值。

### 4.3 Job 状态

典型状态：

```text
pending-idle
  -> compacting
  -> compacted

failure
  -> retryable
  -> backoff / stale / consumed
```

关键约束：

- `milestoneSetAt` 必须匹配当前或 history 中已完成 revision。
- 没有可证明完成的 revision，job 不能消费。
- `retryable` 有 5 分钟退避，避免 idle 循环反复压缩。
- `markCompacted()` 只允许给具体 milestone revision 打完成标记。
- 手工 `/compact` 仍是逃生阀；它不会替代 milestone 状态机。

### 4.4 preset 自动链

`@deepseek-ai/dsh-compaction-basic` 内建：

```text
auto: true
thresholdRatio: 0.8
```

preset 级 `auto:true` 会在 pre-step 独立于我们的 milestone 逻辑做压力压缩。v9 通过启动补丁将其关闭：

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  config:
    auto: false # compaction-policy: milestone-only
```

补丁目标：

- `app/node_modules/@deepseek-ai/dsh-agent-presets/presets/ptc/agent.cordis.yml`
- `app/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml`
- `app/node_modules/@deepseek-ai/dsh-agent-presets/presets/cordis/agent.cordis.yml`

启动时执行：

```powershell
node D:\dsh-test\patch\ensure-milestone-only-compaction.cjs
```

脚本幂等；首次修改前会生成：

```text
agent.cordis.yml.bak-before-milestone-only-compaction
```

## 5. 文件与入口映射

### 5.1 Web 活动入口

`home/profiles/web/cordis.patch.yml` 当前活动行：

```yaml
- id: tool-agent-team-v2
  name: './plugins/team-tools-v2-r3.mjs'

- id: step-compaction
  name: './plugins/step-compaction-v3.mjs'

- id: team-preset-hot-reload
  name: './plugins/team-preset-hot-reload.mjs'
```

依赖关系：

```text
team-tools-v2-r3.mjs
  -> team-milestone-v2.mjs

step-compaction-v3.mjs
  -> team-milestone-v2.mjs
```

### 5.2 保留的旧/基准文件

这些文件仍然存在，方便比较、测试和后续合并：

| 文件 | 状态 |
|---|---|
| `team-tools-v2-r2.mjs` | 已同步修复逻辑，但 web 不再作为活动入口 |
| `step-compaction.mjs` | 已同步修复逻辑，但 web 不再作为活动入口 |
| `team-milestone.mjs` | 已同步修复逻辑，headless/旧引用仍可能使用 |
| `team-tools-v2-r3.mjs` | web 活动入口 |
| `step-compaction-v3.mjs` | web 活动入口 |
| `team-milestone-v2.mjs` | web v3 入口共享模块 |

接手者注意：不要只改 `*-r2.mjs` 或旧 `step-compaction.mjs` 就认为当前 web 实例已经变更。先看 `cordis.patch.yml`。

### 5.3 Headless 状态

headless 仍以原文件名为准：

- `home/profiles/headless/plugins/team-tools-v2.mjs`
- `home/profiles/headless/plugins/step-compaction.mjs`
- `home/profiles/headless/plugins/team-milestone.mjs`

这些文件已经同步逻辑，但没有采用 web 的 r3/v3 文件名。若以后启用 headless 热重载，仍建议复制出新入口名，不要假设同路径修改一定生效。

## 6. 热重载边界

### 6.1 已验证可靠的

host 插件可以通过“新入口文件名 + 更新 `cordis.patch.yml`”触发热重载，避免同 URL ESM cache。

典型流程：

1. 复制 `foo.mjs` 为 `foo-v2.mjs`。
2. 修改新文件，包括它的相对 import。
3. 更新 `cordis.patch.yml` 的 `name`。
4. 等待 loader 重新挂载。
5. 检查 `--dump-config` 和 `compatibility-health.json`。

### 6.2 不可靠的

agent preset 文件属于 agent 内部 composition：

- 修改 `app/node_modules/@deepseek-ai/dsh-agent-presets/presets/...`。
- 新 session 可以拿新 generation。
- 已有 session 继续用旧 generation。
- `agent.ctx` 内的 `compaction-basic` 已经挂载后，不保证自动重连。

`team-preset-hot-reload.mjs` 提供一层补偿：

- 只在 host 插件激活时执行一次。
- 只处理 status 不是 running 的 agent。
- 只处理当前 preset id 为 `ptc` 的 agent。
- 通过 `ctx.agentPresets.recompose()` 重新绑定到新 generation。

如果以后默认 preset 改成别的 id，必须同步修改这个文件，否则不会覆盖。

### 6.3 本次采用的处理

这次修改 compact/preset 后，最可靠的验证是干净重启：

- 停止旧 DSH。
- 确保 `40123` 没有监听。
- 通过 `launch-dsh-test.cjs` 启动。
- 验证新入口和 `auto:false` 已真实加载。

不要只看“文件已改”或“插件 active”就宣称 preset 已生效。

## 7. 启动脚本变化

`launch-dsh-test.cjs` 现在启动前做两件事：

```js
ensureSubagentSettlementGuard()
ensureMilestoneOnlyCompaction()
```

### 7.1 settlement guard

先前的 `patch/ensure-subagent-settlement-guard.cjs` 仍保留，避免 Team 成员 settlement 又变成向上级 waking。

### 7.2 milestone-only compaction

新脚本：

```text
D:\dsh-test\patch\ensure-milestone-only-compaction.cjs
```

职责：

- 检查 `ptc`、`standard`、`cordis` 三个 preset。
- 找到 `compaction-basic` 行。
- 没有 marker 时插入 `auto: false`。
- 幂等，不重复插入。
- 首次修改保留 `.bak-before-milestone-only-compaction` 备份。

如果升级 `@deepseek-ai/dsh-agent-presets` 后 preset 被覆盖，不需要手工记忆命令；只要正常通过启动器启动，脚本会自动重新补齐。

## 8. 测试与验证

### 8.1 静态检查

已通过：

```powershell
node --check home\profiles\web\plugins\team-milestone-v2.mjs
node --check home\profiles\web\plugins\step-compaction-v3.mjs
node --check home\profiles\web\plugins\team-tools-v2-r3.mjs
node --check home\profiles\web\plugins\team-preset-hot-reload.mjs
```

### 8.2 聚焦测试

已通过：

```powershell
node phase5-tests\step-compaction.test.mjs
node phase6-tests\milestone.test.mjs
```

phase5 当前语义：

- ticked milestone 在 idle fold。
- unticked milestone 不 fold。
- 800k/1M 只有压力时也不 fold。
- busy engine 被跳过并退避。
- 已失败的 fold 不会在同一时刻无限重试。

phase6 当前语义：

- context pressure alone 不 compact。
- pressure 超过门禁只返回 `milestone-required`。
- replaced milestone 不擦除已 armed 的旧 revision。
- consumed job 不会复活。

### 8.3 启动后验证

当前验证实例：

- PID：`8928`（发稿前实测）
- 端口：`40123`
- `compatibility-health.json`：`ready:true`、`failures:[]`、`inactive:[]`
- 活动入口：`team-tools-v2-r3.mjs`
- 活动入口：`step-compaction-v3.mjs`
- `step-compaction` 配置：`autoCompactRatio: 0.75`，`windowTokens: 1048576`
- `team-preset-hot-reload.mjs` 已在 dump config 中
- 三个 preset 均为 `compaction-basic.auto:false`

当前 token URL 以 `logs/current-port.txt` 和最新一条 `logs/dsh-test.log` 为准，不要写死进脚本。

### 8.4 team-health

`home/team-health-web.json` 当前 healthy：

- `team-tools-v2-r3.mjs` critical enabled
- `step-compaction-v3.mjs` critical enabled
- `write-scope-guard.mjs` enabled
- `team-operator-v2.mjs` enabled

## 9. 当前 milestone 数据状态

截至本文更新时，`home/team-milestones.json` 的主要桶：

| Team | Pending / Retryable | Compacted | Stale |
|---|---:|---:|---:|
| `session-97fc2cc5-e304-4faf-b042-10388fde41ea` | 0 | 1 | 0 |
| `session-af99edf0-9d6c-412f-82f8-1d5b99c52dc6` | 0 | 1 | 0 |
| `session-6cb90936-03b9-4c8f-9328-0f2bcdaa94a4` | 0 | 2 | 0 |
| `session-7a601594-66f6-4255-92ba-1ef6813cbf1a` | 8 | 5 | 1 |
| `session-6dd2bd43-7d84-4ef3-90ea-449817ee8c0c` | 0 | 0 | 0 |

`session-7a601594...` 是历史大项目测试留下的桶，pending/stale 不能直接假设是当前任务。

接手原则：

1. 不直接删 `team-milestones.json`。
2. 先备份。
3. 先判断 job 的 `milestoneSetAt` 是否在 history 中可证明完成。
4. 已完成的旧 job 最多会在修复后触发一次真实 fold，之后必须写 `compacted/consumed`。
5. 不会再用旧快照把它复活。
6. 仍建议在真实测试前用 `team_compaction_reconcile` 收敛明显 stale 项。

## 10. 文档同步

本次同步更新的文档：

- `docs/agent-team-v8-handoff.md`
  - 修正 hard-threshold 描述。
  - 新增“20 万上下文仍反复压缩”的根因小节。
- `docs/agent-team-v9-handoff.md`
  - 本文。

旧文档中的以下说法只保留历史意义：

- “hard-threshold 压缩不消费 milestone job”
- 旧文档中“75% 只硬拒绝、不自动 fold”的说法已过期；当前是 idle safety fold。
- “web 活动入口是 step-compaction.mjs / team-tools-v2-r2.mjs”

当前接手以 v9 和 `cordis.patch.yml` 为准。

## 11. 已知风险与杂物

1. Web 和 headless 现在不是相同文件名映射；逻辑已同步，但入口名不同。
2. `team-preset-hot-reload.mjs` 只处理 `ptc` 且只处理 idle agent；不要把它当成通用 preset HMR。
3. `ensure-milestone-only-compaction.cjs` 修改的是 `app/node_modules` 内 shipped preset。它是启动期可重放补丁，不是 pnpm patch。
4. 升级 DSH 后要重新跑启动器或手工跑 ensure 脚本，否则 preset 可能恢复 `auto:true`。
5. v8 记录的老测试失败中，phase5 已经在本轮修正；其他旧测试仍需按当前语义单独复核。
6. `team-milestones.json` 的 `session-7a...` 仍有历史 pending/stale；不要在未理解 revision 的情况下批量清空。
7. `team-tools` 现在每次访问都读 milestone 文件。该文件很小，优先保证状态一致性，不为了微优化重新加缓存。
8. 当前验证覆盖静态检查、聚焦测试和启动健康；本轮没有重新跑大型真实 Team 任务。
9. 当前实例 PID/端口可能随下一次重启变化；接手时以 `logs/current-pid.txt`、`logs/current-port.txt` 为准。

## 12. 接手步骤

1. 确认生产隔离：只操作 `D:\dsh-test`，不要改 `D:\dsh`。
2. 先读 v8，再读本文；只处理压缩问题时重点看 v9 第 3-6 节。
3. 检查当前运行态：

```powershell
Get-Content D:\dsh-test\logs\current-pid.txt
Get-Content D:\dsh-test\logs\current-port.txt
Get-Content -Raw D:\dsh-test\home\compatibility-health.json
Get-Content -Raw D:\dsh-test\home\team-health-web.json
```

4. 检查活动入口：

```powershell
$env:DSH_HOME='D:\dsh-test\home'
node D:\dsh-test\app\node_modules\@deepseek-ai\dsh\lib\bin.js --profile web --dump-config |
  Select-String -Pattern 'team-tools-v2-r3|step-compaction-v3|autoCompactRatio|team-preset-hot-reload'
```

5. 改 host 插件时复制新入口名，不要只改旧活动文件。
6. 改 agent preset 时优先重启验证；若必须热重载，确认 `team-preset-hot-reload` 覆盖目标 preset 和 idle agent。
7. 每次启动后检查 `compatibility-health.json`，不要以端口可连接单独作为完成证据。
8. 压缩相关修改必须同时跑 phase5/phase6，并检查 `team-milestones.json` 的 job 是否成功从 pending 转入 consumed。
9. 大任务前用短 smoke 验证 milestone -> idle -> fold -> consumed 链路，再跑大型项目。

## 13. 回滚点

本轮压缩修复前备份：

```text
D:\dsh-test\backup-milestone-only-compaction-20260918-211429
```

该备份包含：

- web/headless 的 `step-compaction.mjs`
- web/headless 的 `team-milestone.mjs`
- web/headless 的 `cordis.patch.yml`
- `launch-dsh-test.cjs`
- `ptc`、`standard`、`cordis` 的 preset YAML 原始副本

preset 自动补丁自身备份：

```text
agent.cordis.yml.bak-before-milestone-only-compaction
```

v8 之前回滚点仍有效：

- `backup-pnpm-patches-20260917-211837`
- `backup-freeze-limit-20260917-182740`
- `backup-agent-team-v8-20260916-183211`
- `backup-milestone-done-set-20260917-101116`
- `backup-pi-ai-in-history-20260917-064735`

回滚时只恢复具体文件、patch 和 lock，不要使用 `git reset --hard`。

## 14. 当前最终状态摘要
## 14. 2026-09-19 上下文裁剪记录

`session-7a601594-66f6-4255-92ba-1ef6813cbf1a` 切换到 `cmd/deepseek/deepseek-v4.1-flash` 时，provider 报告：

```text
maximum context length is 1048576
requested 1150409 (766409 messages + 384000 completion)
```

为让该会话先恢复正常请求/手工压缩，已做两项处理：

1. 使用 `tools/prune-session-tool-results.mjs` 对旧 tool result 做 surface replace，保留最近 15 条 tool result，其余替换为短占位；原始日志不删除。实测替换 150 条，正文字符从 168322 降到 15000，净减少 153322 字符。
2. 将 cmd 模型的 completion reservation 从 384000 降到 65536，并把 contextWindow 改为 provider 实际 1048576。这样长会话不会因为 completion 预留过大而无法发请求。

备份：

```text
D:\dsh-test\backup-context-prune-20260919-044226
```

prune 脚本支持 dry-run；只有显式 `--write` 才会追加替换帧。替换使用 `compaction/prune` + `tool/result` replacement surfaceOp，保持 tool call/result 配对和 append-only journal。

随后又发现并修复一个更严重的输入丢失问题：root 到达 milestone 压力门时，pre-step 会把显式用户 turn 直接判为 `blocked`，用户消息因此没有落成 `user/message`，前端表现为“发送后消失、历史里没有、也没有唤醒”。

- 当前 75% 不再拒绝用户或自动步骤，而是在 idle 触发 safety fold；pre-step 只负责真正的物理 context-budget 保护。
- milestone 仍是更早、更理想的 fold 锚点；pressure safety 是无 tick 时的兜底。
- 新增 `tools/recover-session-inbox.mjs`，从 `agent/inbox/spliced` 中恢复已经被 blocked turn 丢弃、但未成为 surface `user/message` 的消息。
- 已恢复本次两条丢失消息，并在真实 UI 中验证可见；随后 `/compact` 成功，日志为 `Compacted 572 history items (~492092 tokens)`。

恢复前备份：

```text
D:\dsh-test\backup-inbox-recovery-20260919-050730
```

phase5 新增回归用例，验证 75% 步骤不被拒绝且 idle safety fold 会触发；phase8 新增 room snapshot v2 回归。

## 15. Room Snapshot v2（2026-09-19）

旧逻辑的问题：`compactRoomSnapshot()` 只取 `room.summary`、全部 unresolved、decisions 和少量 risk；closed room 里已经 resolved 的 unresolved 仍会让它满足注入条件。notice 又不断增加 `room.revision`，旧摘要因此随新 marker 反复注入。

当前实现：

- `latestClosedRound()` 从 `rounds` 按 `closedAt/openedAt` 取最近一个有摘要的 closed round；旧 `room.summary` 仍保留作兼容 fallback。
- `compactRoomSnapshot()` 的 `summary` 使用最近 closed round 摘要，并新增 `latestClosedRound`。
- 注入和 `unresolved` 字段只包含 `status !== "resolved"` 的条目；resolved 条目仍在控制面面板/原始数据里保留。
- 快照新增 `recentMessages`（最后 6 条，每条正文最多 600 字符）和 `activity`。
- 去重改成语义 `snapshotId`：由 active/latest round、open unresolved、decisions、pending escalations、recent message ids 计算；单纯 notice 增加 `room.revision` 不再单独产生新快照。
- `/team meta` 把最近 closed round 摘要投影到面板使用的 `room.summary`，不迁移旧 room 数据。
- 无 closed round 的 room 保持空摘要；没有 active round/open unresolved/pending escalation 的 room 不再自动注入。
- web 与 headless 的 `team-control-plane`、`team-operator`、`team-tools-v2` 都使用同一快照契约；headless 不再保留旧的 revision-only marker 和 resolved-unresolved 注入。

兼容性：

- 旧 `room.summary`、`room.rounds`、`room.messages`、`unresolved` 不删除。
- 旧会话无需数据迁移；重启后由新代码按现有 `rounds` 自动派生最新摘要。
- 已有 `@revision:closed` 历史 marker 不影响新 session；新 marker 使用 `snapshotId`。旧 history 不需要重写。
- 新增回归：`phase8-tests/room-snapshot-v2.test.mjs`。
- 新增 parity 回归：`phase8-tests/room-snapshot-v2-headless.test.mjs`。

## 15.1 Team Idle Watch 无进展上限修复（2026-09-19）

现象：同一 Team 多次停工但 root 不再收到 `[team idle]`。审计证据显示 `08:07 / 09:37 / 09:48` 三次 idle wake 的 progress hash 都是 `befc38f6`，活动配置仍写着 `maxNoProgressReminders: 3`，因此后续同状态停工被静默抑制。

修复：

- 新入口 `home/profiles/web/plugins/team-idle-watch-v3.mjs`；保留“一次停工 episode 只提醒一次”，删除默认的连续无进展封顶。
- `maxReminders` 默认仍是 `Infinity`；仅当 operator 显式配置正数时才作为绝对 backstop。
- `home/profiles/web/cordis.patch.yml` 改挂 `team-idle-watch-v3.mjs`，并移除 `maxNoProgressReminders: 3`。
- 新增 `phase8-tests/team-idle-watch-no-cap.test.mjs`，验证连续 4 次无进展停工都会提醒。

热重载：DSH HMR 监听 `cordis.patch.yml` 并原地调用 patch reconcile；本次未重启服务，PID 保持不变。

备份：`D:\dsh-test\backup-idle-watch-no-cap-20260919-180500`。

## 15.2 Room 快照与 idle 优先级修复（2026-09-19）

现象：`[team idle]` 已注入，但同一上下文还注入了 closed/idle Room 的近期消息快照；该快照带有 `waitAction: stop`，模型因此结束 turn，没有执行 `team_delivery_check`。

根因：Room Snapshot v2 的自动注入条件包含 `snapshot.recentMessages.length > 0`，导致仅有历史 chatter 的 Room 也会注入面向 turn 的 stop 指令。

修复：

- 新入口 `team-tools-v2-r4.mjs`。
- 新增 `shouldInjectRoomSnapshot()`；只有 `round.status === "open"`、pending escalation 或 open unresolved 才自动注入。
- 近期消息仍留在快照字段中，但 closed/idle Room 的历史消息不再单独触发自动注入。
- `cordis.patch.yml` 的活动 tool layer 与 health required/critical files 均切到 r4。
- `$DSH_HOME/AGENTS.md` 明确 `[team idle]` 是 system wake；closed/idle Room 的 `waitAction=stop` 只是背景，不得跳过 `team_delivery_check`。
- 新增 `phase8-tests/room-snapshot-injection-priority.test.mjs`。

备份：`D:\dsh-test\backup-room-injection-priority-20260919-200500`。

## 15.3 静默 send_message 的唤醒提醒（2026-09-20）

现象：成员经常把 `send_message` 当成唤醒工具，收到 `delivered` 后误以为对方会回复，实际对方不会启动新 turn。

修复：

- 新入口 `team-tools-v2-r5.mjs`。
- `send_message` 输出新增必填 `wakeReminder`；静默发送时明确返回：silent delivery 不启动目标 turn，需要回复/行动请用 `team_wake`，向上阻塞用 `team_wake_superior`。
- `wake:true` 的控制投递返回 waking delivery 说明。
- `$DSH_HOME/AGENTS.md` 要求每次静默发送后读取并遵守 `wakeReminder`。
- `phase7-tests/room-wake-signal.test.mjs` 已切到 r5 并新增返回值断言。

备份：`D:\dsh-test\backup-send-message-wake-hint-20260920-101500`。

## 16. 当前最终状态摘要

一句话：

> v9 的核心变化是：milestone job 是优先 fold 锚点，75% 压力阈值是 idle safety fold；压缩不再拒编用户 turn，若 pre-step 因物理预算必须拒绝，也绝不能吞掉消息。

当前可接受的运行状态：

- `compaction-basic.auto=false`
- `autoCompactRatio=0.75`
- `step-compaction-v3.mjs` active
- `team-tools-v2-r5.mjs` active
- `team-preset-hot-reload.mjs` active
- `team-idle-watch-v3.mjs` active（无默认无进展上限）
- `compatibility-health.json` ready
- `phase5` / `phase6` green
