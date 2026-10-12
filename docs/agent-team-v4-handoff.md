# Agent Team 改造交接文档（v4 汇总）

> 生成时间：2026-09-14 21:50（本地）· 环境：测试实例 `D:\dsh-test`（生产 `D:\dsh` 未动）

## 0. 一句话

把 DSH 的 Agent Team 从「扁平 roster + 提示词约定」改造成**分层、可强制、可观测、省钱**的多智能体调度系统：
所有约束由**代码**执行，人类操作者拥有最高权限，UI 复用出厂面板就地改造。

## 1. 为什么要做（目标与硬约束）

### 1.1 要解决的痛点

| # | 现象 | 根因 |
|---|---|---|
| 1 | 主会话（tier 0）自己干活、不派活；组长也自己干活 | 只有提示词在说「你是调度者」，没有结构约束 |
| 2 | 压缩把任务拦腰截断 | DSH 只按窗口压力在任意 step 压缩，没有「任务边界」概念 |
| 3 | 上下文到 70% 没人提醒 | 只依赖运行时自己的机制 |
| 4 | 面板看不见层级/分组/里程碑；看不到全队真实消耗 | 出厂面板只有扁平 roster；用量只按会话统计 |
| 5 | 组员被消息唤醒乱套 | 消息投递 = 唤醒 |
| 6 | 全队停工没人回报，Lead 永远不知道 | 没有「停机」这个概念 |
| 7 | 冻结了还是召唤不了人 / 解冻后恢复不了 | 配额与冻结语义没打通 |
| 8 | 两个会话并行时面板串台、配额互相挤占 | 策略层是**进程级单例** |
| 9 | dormant 的 tier-2 成员永远醒不来 | mailbox 投递用错父级（lineage 授权） |

### 1.2 硬约束（用户原话）

- **「最后不要纯约定 要不然容易注意力丢失忘记了 然后打破」** → 每条规则必须有确定性执行者，能拒绝就拒绝；
- **成本**：system prompt 是 KV 缓存前缀，**动态数据绝不能进去**（实测把成员上下文占比写进 prompt，缓存命中 99% → 36%）；
- **人类最高权限**：可改任何成员的模型/推理强度、冻结、打断、直接召唤；
- **UI**：不要新加按钮，就改**出厂那个面板**；显示层级与分组；
- **团队形态**：tier 0 主会话；tier 1 = 1 个审查员 + ≤3 个组长；tier 2 = 每组 ≤3 人。

## 2. 系统现在长什么样

### 2.1 分层

```
tier 0  Lead（主会话，伪行，不占名额）
  ├─ tier 1  verifier ×1        （独立审查员，不占组长位）
  └─ tier 1  group lead ×≤3
        └─ tier 2  member ×≤3/组
```

| 层 | 组件 | 职责 |
|---|---|---|
| 域（fork） | `@deepseek-ai/dsh-experimental-agent-team`（profile 内 fork） | roster / 生命周期 / journal。fork 增加 `level` `groupId` `parentName` `frozen` `route`；配额排除 `frozen`+`failed`；**mailbox 投递父级修复** |
| 策略层 | `team-policy.mjs` | tier/group/权限矩阵；**按 Team 隔离**；spawn 上限与终身预算；`frozen` 双向投影 |
| 工具层 | `team-tools-v2.mjs`（16 个工具） | 替换出厂扁平工具层；每个 agent 作用域注册；**在触碰域之前硬拒绝** |
| 人类通道 | `team-operator.mjs` | `/team list\|freeze\|restore\|interrupt\|abort\|route\|spawn\|meta\|usage`；越过模型级预算 |
| 里程碑/压缩 | `team-milestone.mjs` + `step-compaction.mjs` | 自声明里程碑、提醒分带、**按里程碑折叠** |
| 停机保底 | `team-idle-watch.mjs` | 全队停工 → **唤醒** Lead |
| 用量 | `team-usage.mjs` | 直接读 journal 汇总**全队** token |
| 客户端 | 面板 bundle（就地 patch） | 层级/分组/**里程碑**显示；数据来自 `/team meta` |
| 辅助 | `write-scope-guard.mjs` / `action-fusion.mjs` / `observation-pack.mjs` | 写范围硬约束 / 编辑即校验 / 大观测打包 |
| 子代理 | `@deepseek-ai/dsh-subagent`（patch） | Team 成员的结算通知走 `inject`（**不唤醒**） |

### 2.2 工具清单（16 个，`team-tools-v2.mjs`）

`spawn_teammate` `send_message` `list_agents` `wait_agent` `interrupt_agent` `freeze_member` `set_member_route`
`team_milestone` `team_task_create` `team_task_list` `team_task_get` `team_task_update` `team_delivery_check`
`team_worktree_setup` `team_merge` `verifier_report`

### 2.3 文件清单

**插件（`profiles/web/plugins/`，14 个）**：
`team-policy` `team-tools-v2` `team-operator` `team-milestone` `step-compaction` `team-idle-watch` `team-usage`
`team-worktree` `write-scope-guard` `action-fusion` `observation-pack` `opencode-search` `team-usage-projection`(禁用)

**测试（`D:\dsh-test\phase{1..6}-tests/`，20 个套件）**：见 §6

**文档**：`D:\dsh\docs\agent-team-v2-design.md`（§31–64，逐步记录）、`D:\dsh\docs\agent-team-v3-plan.md`、本文档。
## 3. 机制清单（问题 → 机制 → 落点 → 怎么验证）

### A. 分层与权限矩阵（强制，不靠提示词）

- **机制**：`canSee` / `canMessage` / `canInterrupt` / `canSpawn` / `canReadBoard` / `canWriteBoard` 全部返回布尔或拒绝理由；
  同级**能看能聊、不能互相打断**；组员只能跟自己组长和同组同伴；tier 0 能看全队。
- **落点**：`team-policy.mjs` + `team-tools-v2.mjs`（每个工具 execute 第一件事就是判定）。
- **验证**：`phase3-tests/team-policy.test.mjs`、`phase3-tests/team-tools-v2.test.mjs`。

### B. 里程碑与「按边界压缩」

- **机制**：每个 agent 自己声明 milestone（stage + doneWhen）；`team_milestone(action:"done")` **只 arm**；
  `agent/status → idle` 才真正折叠；超过硬阈值（75%）无条件折叠兜底。
- **关键实现**：折叠引擎在 **agent preset 作用域的 isolate 里**，宿主平面（含 `agent.ctx`）都拿不到 → 只能走
  `ctx.commands.execute(agent, "/compact", [], signal)` 跨边界调用。
- **落点**：`team-milestone.mjs`（`shouldCompact` / `band` / `reminderText`）、`step-compaction.mjs`。
- **验证**：`phase5-tests/step-compaction.test.mjs`、`phase6-tests/milestone.test.mjs`；实测 trace 见 §7。

### C. 上下文阈值提醒（省钱的关键）

- **机制**：按 band（20% 起、每 10% 一档）发**消息**提醒该 agent 声明/勾里程碑，并**静默抄送**其上级；
  消息**只投递不唤醒**（`agent.inject` = `send(input, "next-step", false)`）。
- **绝不进 system prompt**：动态数据进 prompt = 缓存前缀全毁。
- **落点**：`team-tools-v2.mjs` 的 `deliverThreshold` / `deliverQuietly`。
- **验证**：`phase6-tests/milestone.test.mjs`；缓存命中率可由会话 journal 的 `request/header` 复核。

### D. 看板（压缩后信息不丢）

- **机制**：global / level-N / group-X 三种板，CAS 更新（`expected_revision`）；
  阈值提醒里明确要求「折叠前把必须留下的东西写进看板」。
- **落点**：`team-policy.mjs` 的 board* + `team-tools-v2.mjs` 的 `team_task_*`。

### E. 配额（三层，语义分清楚）

| 层 | 额度 | 冻结的影响 |
|---|---|---|
| 域 | `maxMembers = 20`（同时存在的非 frozen、非 failed 成员） | **释放** |
| 策略层 | 每组 ≤3、组长 ≤3、审查员 1 | **释放** |
| 两层 | 终身创建预算 `maxLifetimeCreates = maxMembers × 2 = 40` | **退还**（本次改动：frozen 不占预算） |

- 人类操作员的 `/team spawn` **越过模型级预算**（域仍兜底）。
- **落点**：`cordis.patch.yml` 的 `agent-team` / `team-policy` 两行 + `team-policy.canSpawn` + fork 域 583 行。
- **验证**：`phase4-tests/spawn-budget.test.mjs`。

### F. 冻结（域是唯一真源）

- **机制**：`reconcileRegistry` **双向投影** `frozen`；`send_message` 对冻结目标显式拒绝并给出解冻指令；
  `list_agents` 显示 `frozen` 状态。
- **落点**：`team-policy.mjs`、`team-tools-v2.mjs`。
- **验证**：`phase4-tests/freeze-projection.test.mjs`。

### G. 每个会话独立的 Team

- **机制**：`policyFor(teamKey)`，key = 域给的 `membership.id`（**Team 根会话 id**，全体成员相同）；
  registry 与看板 store 都按 key 分区。
- **落点**：`team-policy.mjs`（`policyFor` / `teamKeyOf`）、`team-tools-v2.mjs`、`team-operator.mjs`。
- **验证**：`phase4-tests/team-isolation.test.mjs`。

### H. dormant 成员冷启动（mailbox lineage）

- **机制**：投递 dormant 成员时，父级必须是该成员的**真实直接父级**（组长），不能一律用 Team root；
  新增 `TeamMailbox.deliveryParent(root, targetId)` 按 `parentName` 解析，找不到才回落 root。
- **落点**：fork 域 `lib/index.js`。
- **验证**：journal 里 `team/message/queued` vs `delivered`（见 §7 实测）。

### I. 停机保底

- **机制**：Lead + 所有存活下属都非 running、且无 provisioning、且至少一个存活下属 → 静置 `settleMs=30s` →
  **唤醒** Lead 发一条提醒（「已交付还是被中断」）；每个 stop episode 只提醒一次。
- **落点**：`team-idle-watch.mjs`。
- **验证**：`phase6-tests/idle-watch.test.mjs`。

### J. 唤醒收敛

- **机制**：Team 成员的结算通知走 `parent.inject()`（投递不唤醒）；只有主动 `send_message` 才唤醒。
- **落点**：`@deepseek-ai/dsh-subagent`（patch，回滚说明见 `D:\dsh-test\REVERT-dsh-subagent.md`）。

### K. 全队用量

- **机制**：直接读 session journal（**多帧 zstd 逐帧解码**），沿 `parentSession` 链走出整个 Team，汇总 token；
  命令 `/team usage`。
- **落点**：`team-usage.mjs`。**注意**：曾用「自定义 session 事件 + projection」实现，**损坏了会话日志**，已废弃（`team-usage-projection.mjs` 禁用）。
## 4. 踩过的坑 / 必须遵守的不变量

| # | 不变量 | 代价 |
|---|---|---|
| 1 | **cordis 读未声明属性会抛异常**（`cannot get property "X" without inject`）；`ctx.get(name)` **只能读到声明过 inject 的服务** | 客户端 pill 三次「什么都没发生」都是被 catch 吞掉的这个异常 |
| 2 | 需要服务用 **`ctx.inject(deps, cb)` 回调形式**；**静态 `inject` 缺服务 → entry pending → 整棵插件树拒绝启动**（`dsh: 1 entry did not activate`） | 我把测试实例启动搞崩过一次 |
| 3 | 压缩引擎被 preset `isolate: { compaction: true }` **隔离**，宿主平面连 `agent.ctx` 都拿不到 | 只有 `/compact` 命令能跨过去 |
| 4 | subagent 冷启动按 **直接父级** 授权 lineage | 122 条消息永久排队 |
| 5 | **动态数据进 system prompt = 缓存前缀全毁**（实测 99% → 36%） | 提醒/进度一律走消息或工具结果 |
| 6 | **绝不写自定义 session 事件**（日志读取器会拒绝解释整个会话）；修复只能标 `ignorable`，**绝不删行/改 seq** | 曾 brick 6 个会话历史 |
| 7 | 测试替身必须符合**真实契约**：`membership.id` 是 **Team 根 id**（全体成员相同）；roster 会带 `frozen` | 两处都被这条坑过，替身错了会「修好的功能被测试判死」 |

## 5. 配置（`profiles/web/cordis.patch.yml`，`teamtest` 同步）

| 行 | id | 关键配置 |
|---|---|---|
| insert | `web-search-opencode` | 本地 search provider（历史遗留） |
| insert | `write-scope-guard` | 写范围硬约束，`enforce: true` |
| insert | `action-fusion` | 编辑即校验：`match: /[.](js\|mjs\|cjs)$/` → `node --check "{file}"`，`shell: none` |
| insert | `observation-pack` | 大观测打包，`maxInlineChars: 12000` |
| disable | `tool-agent-team` | 出厂扁平工具层，被 v2 取代 |
| insert | `team-policy` | `maxTier1Leads: 3` / `maxVerifiers: 1` / `maxMembersPerLead: 3` / `maxMembers: 20` |
| insert | `tool-agent-team-v2` | 16 个工具 + 角色文件/报告/spill/milestone 路径 |
| insert | `step-compaction` | `windowTokens: 1000000` / `hardRatio: 0.75` |
| insert | `team-idle-watch` | `settleMs: 30000` |
| disable | `team-usage-projection` | 写自定义事件，损坏日志，**永久禁用** |
| insert | `team-operator` | `reportDir` / `milestonePath` |
| 覆盖 | `agent-team`（域） | `maxMembers: 20` / `maxTasks: 256` / `maxPendingMessagesPerMember: 64` / `maxMessageBytes: 65536` / `disposalTimeoutMs: 5000` |

## 6. 验证手段（怎么证明它对）

### 6.1 测试：20 个套件，全绿

```
phase1  write-scope-guard
phase2  action-fusion, action-fusion-file, observation-evidence, observation-pack
phase3  team-policy, team-tools-v2
phase4  policy-reconcile, spawn-authority, spawn-budget, freeze-projection, team-isolation, team-operator
phase5  step-compaction, team-worktree, worktree-git-e2e
phase6  milestone, team-usage, usage-projection, idle-watch
```

```
Get-ChildItem D:\dsh-test -Directory -Name | Where-Object { $_ -like "*tests" } | ForEach-Object {
  Get-ChildItem "D:\dsh-test\$_" -Filter *.test.mjs -Name | ForEach-Object {
    node "D:\dsh-test\$_\$_"  # 每个都应 exit 0
  }
}
```

### 6.2 无浏览器验证（这次新加的手段）

- **真 bundle + 自制 React hook**：用 `node:vm` 加载**真正被 40123 服务的那个 `client.js`**，抓 `window.__ModuleLoader__.load`，
  喂假 `require`（自制 `useState/useEffect/useMemo/useSyncExternalStore`）与假 cordis ctx，直接调 slot 组件并递归展开渲染树。
  → 证明了「组件能渲染出 `ALL 14 / 248 / 99%`」，也证明 `sessionId` 确实会传给 slot。
- **域离线 harness**：`profiles/web/teamcheck/`（临时目录 + 相对导入 + 向上解析到 `profiles/node_modules`），
  直接 `import team-operator.mjs`、抓 `ctx.commands.register` 的 spec、用假 ctx 调真 handler。
  → 证明 `/team usage` 输出格式、`/team meta` 带 12 条 milestones。
- **journal 取证**（最常用）：多帧 zstd 逐帧解码，扫 `command/done`、`team/member`、`team/message/queued|delivered`、
  `compaction/*`、`step-compaction.log` trace。所有「到底发生了没有」的结论都来自这里。
- **托管后台 job**：实例日志用 `job_output` 读（注意只给**增量**）。
## 7. 当前实测状态（证据）

| 结论 | 证据 |
|---|---|
| 里程碑勾了不折叠 → 已修 | trace 从 `no-compaction-service` → `nothing-armed(name=c-render, tokens=323072, ratio=0.32, armed=false)`，判定链恢复 |
| dormant 成员唤不醒 → 已修 | `session-1c96` 排队未投递 **124 → 39**；期间新发 103 条、投递 885 条 |
| 唤醒层级对上了 | 实测「tier 1 一直能醒、只有 tier 2 不行」与代码分析（lineage 用错父级）完全一致 |
| 冻结/配额语义 | 里程碑/成员数据实测：`session-1c96` 25 个成员，多数 `frozen=true`，`phase=active` |

## 8. 未完成 / 需要注意

### 8.1 临时物（要清）

- `D:\dsh-test\home\team-mailbox.log` + fork 域里两处 `appendFileSync` 诊断（`dispatchOnce` 的 catch、
  `persistedTargetRecorded` 的 catch）→ **积压清零后删掉**，同时删本文件里的对应日志代码；
- `D:\dsh-test\home\profiles\web\teamcheck\`（离线验证脚手架，可选保留）；
- `D:\dsh\workspaces\test\*.mjs`（journal 扫描脚本：`queue-scan` / `frozen-scan` / `fold-check` 等，可留作工具）。

### 8.2 已回滚（不要再改回去）

- **底部 composer 的 `ALL/OTHERS` 两个 pill**：用户要求撤掉，`ui-chat/lib/client.js` 已从 `.orig` 还原（现为原版，
  `TeamTotalPill` 不存在）。原因：它要周期性跑 `/team usage`（每次解压整个 workspace 的 journal ≈ 0.8s），
  而且每次轮询会往会话写 2 条事件、在聊天里留一行 `/team usage`。
- 面板内的**里程碑显示保留**（不同 bundle，无副作用）；
- `team-usage-projection.mjs` **永久禁用**（写自定义事件损坏日志）。

### 8.3 尚未在生产验证

- `team-idle-watch` 的真实触发（目前只有集成测试 + 纯判定测试）；
- 冻结退还创建名额（刚重启，等你下次召唤）；
- `step-compaction` 的「按里程碑真折叠一次」还没有在长会话里被观测到（判定链已通）。

### 8.4 环境风险

- **C 盘曾经 100% 满**，导致实例 `ENOSPC` 崩溃。已清 ~25 GB（Temp 里 6 小时以上的旧文件/目录），现约 18 GB 可用；
  建议再清 `AppData\Local\wsl`(15.6G) / `NVIDIA`(14.7G) / `npm-cache`(3.3G)。（写文档时最新读数：C 约 **15.9 GB** 可用）
- D 盘 73 GB 可用，DSH 数据都在 D，不受影响。

## 9. 明天继续的最短路径

### 9.1 起实例

```
$env:DSH_HOME='D:\dsh-test\home'
& 'C:\Program Files\nodejs\node.exe' 'D:\dsh-test\app\node_modules\@deepseek-ai\dsh\lib\bin.js' --profile web --no-open --port 40123
```

启动后终端会打印 `dsh web: http://127.0.0.1:40123/?token=...`（**每次重启 token 都会变**）。
**不要动 39123（生产）**，也不要按进程名杀 msedge。

### 9.2 验证清单

| 要看什么 | 怎么验证 |
|---|---|
| 面板里程碑 | 打开面板，成员行下方应有 `○/✓ + stage`，已折叠的带 `· folded` |
| dormant 唤醒 | 让一个组长给 dormant 的 tier-2 成员发消息，看它是否醒来；同时扫 journal 的 `team/message/delivered` |
| 配额/冻结 | 冻结一个成员后尝试召唤，应当成功；`D:\dsh-test\home\team-mailbox.log` 不应新增 |
| 按里程碑折叠 | 勾一个里程碑 → 该 agent 空闲后，journal 应出现 `compaction/start|summary|end`，里程碑文件出现 `compactedAt` |
| 停机保底 | 让整个 Team 都停下且无人回报，30s 后 Lead 应被唤醒并收到「目前所有 team 已停工…」 |

### 9.3 清临时诊断

```
Remove-Item D:\dsh-test\home\team-mailbox.log -ErrorAction SilentlyContinue
# 然后删掉 fork 域 lib/index.js 里两处 appendFileSync 诊断块（搜索 "TEMPORARY DIAGNOSTIC"）
```

## 10. 环境事实

| 项 | 值 |
|---|---|
| 测试实例 | `D:\dsh-test\app`（fork），`DSH_HOME=D:\dsh-test\home`，端口 **40123** · **当前已停止**（端口未监听，需按 §9.1 启动） |
| 生产实例 | `D:\dsh\app`，`DSH_HOME=D:\dsh\home`，端口 **39123** —— **未改动** |
| 域 fork | `D:\dsh-test\home\profiles\web\node_modules\@deepseek-ai\dsh-experimental-agent-team\lib\index.js` |
| 子代理 patch | `D:\dsh-test\app\node_modules\@deepseek-ai\dsh-subagent\lib\index.js`（回滚说明 `D:\dsh-test\REVERT-dsh-subagent.md`） |
| 客户端 patch | `...\dsh-experimental-client-ui-agent-team\lib\client.js`（里程碑显示） |
| 角色文件 | `D:\dsh-test\home\team-roles\{lead,verifier,member}.md` |
| 报告目录 | `D:\dsh-test\home\team-reports` |
| 里程碑文件 | `D:\dsh-test\home\team-milestones.json` |
| 测试 | `D:\dsh-test\phase{1..6}-tests`（20 套件） |

---

## 附录：本次会话新增/修改的文件

| 文件 | 改动 |
|---|---|
| `team-policy.mjs` | 按 Team 隔离（`policyFor`/`teamKeyOf`）、`frozen` 双向投影、预算对齐 + 冻结退款 + 人类越权 |
| `team-tools-v2.mjs` | 配额拒绝文案（冻结/人类越权引导）、`send_message` 拒绝冻结目标、阈值提醒加看板提示 |
| `team-milestone.mjs` | 提醒文本加「折叠前先落看板」 |
| `step-compaction.mjs` | 服务走 `ctx.inject` 回调、引擎走 `/compact` 跨 isolate（重写为干净版） |
| `team-operator.mjs` | 按 Team 取策略、`/team meta` 带 `milestones`、spawn 走 operator 越权 |
| `team-idle-watch.mjs` | **新增**：全队停工保底唤醒 |
| `cordis.patch.yml`（web + teamtest） | `maxMembers: 20`、`team-policy.maxMembers`、`team-idle-watch` 注册 |
| fork 域 `lib/index.js` | `deliveryParent()` 投递父级修复、预算退还 frozen、临时诊断 |
| 面板 `client.js` | 成员行显示里程碑 |
| `ui-chat/client.js` | **已回滚为原版**（pills 撤掉） |
| 测试 | 新增 `spawn-budget` / `freeze-projection` / `team-isolation` / `idle-watch`；修 3 处替身契约 |
| 文档 | `agent-team-v2-design.md` §64、本文档 |



