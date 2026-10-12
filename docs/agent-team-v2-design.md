# Agent Team v2 技术设计与实施计划

- **版本** v1.0
- **日期** 2026-09-11
- **作者** Lead（session-cbc197a0-2186-4dc3-a85c-b839165db266）
- **状态** 待评审
- **落盘位置** `D:\dsh\docs\agent-team-v2-design.md`

> **为什么写这么长**：本计划要跨多个上下文窗口执行。所有决策、证据、路径、命令、验收标准必须落盘，不依赖会话记忆。任何一步开始前，先读本文档对应章节。

---

## 0. 阅读指引

| 你要做什么 | 读哪节 |
|---|---|
| 了解现在有什么 | 1 |
| 了解要做什么 | 2 |
| 了解怎么分层 | 3、4、5、6 |
| 了解具体改动点 | 7、8、9、10 |
| 了解哪条规则由谁强制 | 11 |
| 建测试环境 | 12 |
| 开始动手 | 13 |
| 看已知风险和未决问题 | 14 |

---

## 1. 现状基线

### 1.1 运行拓扑（实测）

| 项 | 值 |
|---|---|
| 程序 | `D:\dsh\app\node_modules\@deepseek-ai\dsh`，版本 0.1.5-rc.1 |
| DSH_HOME | `D:\dsh\home` |
| 启动器 | `D:\dsh\launch-dsh.cjs <entry> <dshHome> <startPort> <logFile> [maxTries]` |
| 实际命令 | `node <entry> --profile web --no-open --port <N>` |
| 进程 cwd | `D:\dsh`（为兼容历史会话里的旧 Linux 路径，靠 junction 解析） |
| 线上端口 | 39123 |
| profile | `D:\dsh\home\profiles\web`，**patchReload: live**（改 patch 热生效，不用重启） |
| profile 的 node_modules | **全部是指向 `D:\dsh\app\node_modules\*` 的 junction**（实测 dir /al） |
| D 盘剩余空间 | 84 GB |
| 已有本地插件先例 | `profiles\web\plugins\opencode-search.mjs` + cordis.patch.yml 一行 insert |

### 1.2 Team 现状：三个包

| 包 | 职责 | 归属层 |
|---|---|---|
| dsh-experimental-agent-team | domain：ctx.agentTeams。事件溯源，**Lead Session 日志是唯一真源**，roster/mailbox/task 每次读取都重放 | host |
| dsh-experimental-tool-agent-team | 9 个模型工具（spawn/send/list/wait/interrupt + 4 个任务板工具） | host |
| dsh-experimental-client-ui-agent-team | 浏览器面板（roster + 任务板 + teammate 导航） | client |
| dsh-experimental-agent-team-profile | host profile bundle 层 | profile |
| dsh-experimental-agent-team-web-profile | web patch 层（插入 ui-agent-team 行） | profile |

**domain 源码地图**（要 fork 的就是这些文件）：

| 文件 | 职责 |
|---|---|
| src/index.ts | 插件入口、Config schema、服务注册、恢复调度 |
| src/roster.ts | Team 身份、成员关系解析、provisioning 与 roster 拆除 |
| src/mailbox.ts | 持久队列、目标本地投递、确认与恢复 |
| src/task-board.ts | 任务 CAS 命令、DAG 校验与派生视图 |
| src/journal.ts | 串行化 Lead 日志事务与提交通知 |
| src/projection.ts | 严格回放投影 |
| src/activity.ts | 一次性变更等待者与 dispose 释放 |
| src/lifecycle.ts | 共享准入截止与有界结算 |
| src/invariant.ts | append 前回放候选事件的不变式伴生插件 |

**当前配置**（`profiles\web\cordis.patch.yml`，已改）：

    - id: agent-team
      name: '@deepseek-ai/dsh-experimental-agent-team'
      config:
        maxMembers: 13        # 原 12 -> 13；默认 8；含失败的创建，是终身配额不是并发上限
        maxTasks: 256
        maxPendingMessagesPerMember: 64
        maxMessageBytes: 65536
        disposalTimeoutMs: 5000

> 注意：patch 是**整体替换 config 对象而非合并**，漏 key 会静默回退插件默认值。

**当前能力与限制**（domain README 原文要点）：

- 权限：每个服务方法都接收精确的 live 调用 Agent；只有 Lead 可以 spawn、reassign 或 interrupt。
- 消息：任何成员可发给任何成员；running 在步骤边界收到，idle 启动一轮，inactive 冷恢复；不丢失不重复；queued 绝不重发。
- 任务：完整版本化快照 + expectedRevision CAS；writeScopes **只是提示，视图只警告，绝不阻止 claim 或授予写权限**。
- 中断：仅 Lead，keepInbox 只取消当前 turn，不释放任务 owner，不删持久 mail。
- **限制**：扁平不可变 roster（无嵌套 Team / 重命名 / 删除 / 名字复用）；无 owner 自动释放；单进程共享 checkout，**不提供 worktree、远端成员、merge 或文件锁**；mailbox 不保证跨进程 exactly-once。
- 名字永久：**创建失败的 teammate 也保留名字，任何名字都不复用**。

**浏览器面板当前能力**：打开面板调 agentTeams/view；roster row 展示 **持久 name、运行时 status、model 与 diagnostics**（model 已经是只读展示）；可选择 teammate 导航到其会话；任务板支持 agentTeams/createTask 与 agentTeams/updateTask。

> **模型已经在视图里，只是不可改。**

### 1.3 已经可用的强制层

| 层 | 包 | 能力 |
|---|---|---|
| 工具管线 | dsh-tools | waterfall 中间件：tools/pre-execute（allow/deny/ask）、tools/execute、tools/post-execute、**tools/ptc-dispatch-log（内容块进提示词前改写）**、tools/result、tools/change；**按 agent 作用域**（scopeTarget(this, exec.agent)） |
| 文件后端 | dsh-fs-local | config.cwd **只是解析基准，不是边界**；绝对路径与 .. 可逃逸 |
| 文件沙箱 | dsh-fs-sandbox | 在工作区与临时根内做模式围栏，**真正的边界** |
| 命令沙箱 | dsh-bash-sandbox / dsh-pwsh-sandbox | 命令级 confinement |
| 沙箱底座 | dsh-sandbox / dsh-sandbox-policy / dsh-sandbox-local / **dsh-sandbox-windows-acl** | Windows 上可落到 ACL 层 |
| 观察策略 | dsh-fs-observation-policy | 先读后写；陈旧写拒绝（FS_NOT_OBSERVED / FS_STALE_VERSION） |
| 压缩 | dsh-compaction / -basic / -tool-result-pruner | 上下文压缩与工具结果剪裁 |
| 模型默认 | dsh-agent-default-model | ctx.agentDefaultModel.currentSelection() / saveSelection()；**只作用于新创建的 agent**；reasoningEffort 只存在于 settings schema |
| 插件创作 | dsh-tool-cordis + dsh-cordis-host-runner | 动态包：定义只在进程内存，**重启即失**；**当前未安装未挂载** |

### 1.4 硬限制（设计必须绕开，不要试图消除）

1. **投递只能在步骤边界**，做不到 token 级抢占。可 abort 整轮，但已产出部分会丢。
2. **文件级隔离不默认存在。** 所有成员共享 cwd；要隔离只能上 worktree 或 fs-sandbox 模式围栏。
3. **沙箱强但非绝对**：管不住网络、子进程、外部服务。给 bash 约等于给代码执行权。
4. **冻结/恢复有物理成本**：上下文重建要重放历史，磁盘与冷启动 token 都要付。
5. **语义判断不能机械化**：能把"不许越界"变成硬约束；**不能把"做对了"变成硬约束**，只能强制"必须提供能区分坏状态的证据"。
6. **上游是 alpha**：0.1.5-alpha.2，无稳定性承诺。fork domain 后每次升级都要重放。

---

## 2. 需求（可验收条目）

| ID | 需求 | 验收标准 | 优先级 |
|---|---|---|---|
| **R1** | 分级：0=主会话，可创建 level 1；level N 可创建 level N+1；**硬限 3 层（0/1/2）** | level 2 成员尝试 spawn 被 domain 以类型化错误拒绝 | P0 |
| **R2** | 分组：同一次 spawn 指定 level + group；组内互通，跨组不可见、不可通信、不可打断 | 跨组 send_message 被拒绝；list_agents 不返回其他组成员；组员文件写域被硬隔离 | P0 |
| **R3** | 分组任务板 + 全局只读板 | 组员只见本组任务；全局板所有组可读、**只有 level 0 可写**，且**只追加不改写** | P0 |
| **R4** | 冻结/恢复：只 0 能冻结与恢复；**冻结成员不占配额**；冻结不等于删除 | 冻结后 roster 不计入配额；发往冻结成员的消息被拒绝或挂起；解冻后能恢复工作 | P1 |
| **R5** | 操作者（人类）最高权限：在面板里创建/打断/中止/冻结/恢复成员，**并能改任意成员的模型与思考强度** | 面板可对任一成员改 provider/model/reasoningEffort，下一轮生效 | P0 |
| **R6** | 融合 SoL-Pi 四机制：Action Fusion / ObservationPack / Evidence-Preserving Reducer / Online Context Compact | 每项有独立可测的 token 或往返收益 | P1 |
| **R7** | **强制优先**：约束全部下沉到代码，不依赖模型记得 | 第 11 节强制矩阵中每一行都有确定性执行者 | P0 |

**已接受的设计约束**（用户确认）：验证者独立于组长；0 只与 level 1 双向通信（level 2 只读查看 + 紧急打断）；硬限 0-2 层；任务板用真实 scope 字段而非前缀标签；开工前冻结写域表。

---

## 3. 总体架构

    ┌─ L4 UI 层 ─────────────────────────────────────────────┐
    │ dsh-experimental-client-ui-agent-team (fork)            │
    │ roster/任务板/操作者控制台：创建·打断·冻结·改模型        │
    └──────────────────┬──────────────────────────────────────┘
                       │ Remote: agentTeams/*
    ┌─ L3 domain 层 (fork dsh-experimental-agent-team) ───────┐
    │ 级别·分组·可见性矩阵·权限校验·任务板 scope·冻结配额      │
    │ 事件溯源不变（Lead Session 日志仍是唯一真源）            │
    └──────────────────┬──────────────────────────────────────┘
                       │ ctx.agentTeams 服务 API
    ┌─ L2 约束层（按 agent 作用域安装，新插件） ──────────────┐
    │ 写域硬隔离：每成员 scoped ctx.fs + fs-sandbox roots      │
    │ 任务 claim 强制 write_scopes · 越界写拒绝                │
    └──────────────────┬──────────────────────────────────────┘
                       │
    ┌─ L1 上下文经济层（新插件，挂 tools 管线） ──────────────┐
    │ Action Fusion (post-execute)                            │
    │ ObservationPack + Evidence Reducer (ptc-dispatch-log)   │
    │ Online Context Compact (dsh-compaction)                 │
    └─────────────────────────────────────────────────────────┘

**分层的理由**：L1/L2 都**不碰 domain**，可以独立开发、独立验收、不跟上游分叉。L3/L4 是唯一需要 fork 的部分，**必须一次做完**，因为每改一刀都要在升级时重放。

---

## 4. 数据模型扩展

### 4.1 成员记录新增字段

    interface TeamMemberRecord {
      // —— 现有 ——
      id: MemberId
      name: string            // 永久，永不复用
      role: 'lead' | 'teammate'
      status: 'provisioning' | 'running' | 'idle' | 'inactive' | 'failed'
      // —— 新增 ——
      level: number           // 0 = lead；1..2
      groupId: string         // 分组标识，由创建者的 group + 本级序号派生
      parentName: string | null // 创建者名字（level 0 为 null）
      route: AgentRoute       // { provider, model, reasoningEffort? }，可运行时改写
      frozen: boolean         // 冻结标记；不进 roster 计数、不接收投递
      frozenAt?: string
      createdAtChain: string[] // 创建者链，用于可见性判定
    }

### 4.2 Team 事件新增类型

| 事件 | 含义 |
|---|---|
| team/member/spawned | 扩展 payload：level / groupId / parentName / route |
| team/member/frozen | 冻结，记录 frozenAt |
| team/member/restored | 解冻 |
| team/member/route-changed | 改动 route（含改模型） |
| team/task/created | 扩展 payload：scope（boardId = groupId 或 global） |

**不变式**：所有这些事件仍只存在于 Lead Session 日志，**绝不进入派生模型历史**（这是现有 domain 的性质，必须保持）。新事件必须加入 invariant.ts 的 append 前回放校验。

### 4.3 配额记账变更

- maxMembers 语义：保留"**包含 failed 的终身创建配额**"，但**冻结成员从"在册"计数中移除**。
- 新增独立的 maxLifetimeCreates（默认建议 = maxMembers 的 2 倍），防止"无限招人再冻结"绕过成本控制。
- 冻结释放的配额**只影响准入判断，不回收 id/名字**（名字依然永不复用）。

---

## 5. 权限矩阵

| 操作 | level 0 | level 1 | level 2 | 操作者（人类） | 规则 |
|---|---|---|---|---|---|
| spawn 下一级 | 允许 | 允许（只能 level 2） | 禁止 | 允许 | 只能创建**自己 level+1** |
| spawn 跨级 | 禁止（必须经 level 1） | 禁止 | 禁止 | 允许 | 硬拒 |
| 打断（interrupt） | 任意 | 直接下级 | 禁止 | 任意 | **直接上级可打断直接下级** |
| 发消息 | 与 level 1 双向；level 2 只读 | 与 0、同级、直接下级 | 与直接上级、同级 | 任意 | level 2 到 0 直接拒绝 |
| 查看 roster | 全部 | 本组 + 上级链 | 本组 | 全部 | 见第 6 节 |
| 冻结 / 恢复 | 允许 | 禁止 | 禁止 | 允许 | 仅 level 0 与操作者 |
| 改模型 / 思考强度 | 自己及全部下级 | 本组 | 禁止 | 任意 | 见第 9 节 |
| 任务板写 | 全局板 + 本组 | 本组 | 本组 | 全部 | 全局板只有 0 与操作者可写 |
| 任务 claim | 允许 | 允许 | 允许 | 允许 | 只能 claim 所属 scope 的任务，且必须声明 write_scopes |

---

## 6. 可见性矩阵

分组规则：`groupId = <创建者的 groupId>/<本级序号>`。可见性判定基于 createdAtChain（创建者链）+ 同组关系。

| 观察者 \ 目标 | level 0 | 同组 1 级 | 异组 1 级 | 本组下级 | 异组下级 |
|---|---|---|---|---|---|
| level 0 | — | 允许 | 允许 | 只读 | 禁止 |
| level 1（组长 A） | 允许 | 允许（同组讨论） | 禁止 | 允许 | 禁止 |
| level 2（A 的组员） | 只读（不可发消息） | 禁止 | 禁止 | 同级允许 | 禁止 |
| verifier（独立组） | 允许 | 禁止 | 禁止 | 禁止 | 禁止 |

**verifier 的隔离**：verifier 必须是 level 1 但**独立分组**，物理上看不到组长的对话（domain 层过滤）。它只通过**冻结提交物**（diff、验收命令输出、证据台账）接收材料。这是保证独立性的硬约束，不是约定。

**"只读查看"必须定义具体动作**，否则是空转权限：

- 允许：读全局任务板；读自己 scope 内的任务；list_agents 只返回可见成员
- 不允许：读他人对话历史、读他人消息

---

## 7. 任务板设计

### 7.1 数据模型

    interface TeamTask {
      id: string              // task-<n>
      boardId: string         // 'global' | groupId
      subject: string
      description: string
      owner?: string
      blockedBy: string[]
      writeScopes: string[]   // 规范化 workspace 相对前缀
      status: 'pending' | 'in_progress' | 'completed' | 'deleted'
      revision: number
    }

### 7.2 规则

1. **全局板（boardId='global'）**：所有成员可读，**只有 level 0 与操作者可写**，且**只追加**（禁止 edit/delete，只允许 create 与 status 推进）→ 避免频繁改写导致所有成员的 KV cache 前缀震荡。
2. **分组板**：boardId = groupId，只有本组成员与上级链可见可写。
3. **claim 前置条件**：任务必须声明非空 writeScopes，否则 claim 被拒绝（类型化错误）。
4. **越界拒绝**：claim 时校验成员写域是否与任务 writeScopes 兼容。

### 7.3 全局板的内容约定（由 level 0 写入）

- 项目目标与验收标准
- 冻结的契约：目录结构、命名规范、接口签名、资源格式、验收命令
- **写域表**：每个成员/组负责的路径前缀
- 阶段放行计划

---

## 8. 冻结 / 恢复状态机

    provisioning ──► running ⇄ idle
                       │  ▲
                       │  │ restore（仅 0 / 操作者）
                       ▼  │
                     frozen ────► inactive(未加载)

**必须满足**：

1. **冻结是一个新状态，不是复用 inactive。** 现有 send_message 会冷恢复 inactive，若冻结成员仍是 inactive，一条消息就会把它唤醒并重新占配额，冻结失效。
2. **冻结后**：不进 roster 计数；发往它的消息**拒绝**（错误码 TEAM_MEMBER_FROZEN）或挂起；不参与 wait 变化。
3. **恢复**：冷恢复 + 重建上下文。定义"冻结期间的消息"策略：建议**拒绝**（最简单、语义清晰），排队方案留作后续。
4. **配额**：冻结释放"在册"计数，但**终身创建数不回滚**（见 4.3）。
5. **存储不释放**：冻结只是不占配额，会话历史仍在 storages 里。

---

## 9. 操作者通道（R5，含改模型）

### 9.1 现状缺口

- 面板当前**只能** view roster / 导航 / 任务板 CRUD。
- 不能 spawn、不能 interrupt、不能冻结、不能改模型。
- ctx.agentDefaultModel.saveSelection() **只影响新创建的 agent**，对 live agent 无效——这正是"供应商没额度了想换却换不了"的根因。

### 9.2 需要新增的 Remote 方法

在 domain 的 ./remote contribution 上新增（沿用现有 agentTeams/view 的生成式 Remote 模式）：

| 方法 | 签名 | 说明 |
|---|---|---|
| agentTeams/spawn | { name, description, prompt, level, groupId, route } | 操作者创建成员 |
| agentTeams/interrupt | { name } | 打断任意成员当前 turn |
| agentTeams/freeze | { name } | 冻结 |
| agentTeams/restore | { name } | 恢复 |
| agentTeams/setRoute | { name, provider, model, reasoningEffort? } | **改模型与思考强度** |

### 9.3 改模型的实现路径（**Phase 0 必须先 spike**）

三个需要验证的前提：

1. **live agent 能否切换路由？** 若 DSH 的 agent 路由在创建时固定、无运行时覆盖点，则"改模型"需要重建该 agent（丢上下文）或改为**下一轮生效**的覆盖服务。**必须先查清 dsh-agent 的路由解析点。**
2. 若存在 per-agent 覆盖点（例如某个 ctx.agentModel 或路由服务），则实现为：domain 存 route 字段 → 成员每轮开始前应用到该 agent 的路由解析 → 立即生效。
3. 若无覆盖点，退化方案：saveSelection() 影响后续创建的成员 + 对已有成员提供"以新模型重建（保留历史 Fork）"的操作，并在 UI 上明确标注"会重启该成员的上下文"。

**验收**：面板对某个 running 成员改模型 → 该成员下一轮的请求使用新 provider/model（可通过 provider 侧日志或请求元数据验证）。

---

## 10. SoL-Pi 四机制融合

### 10.1 映射表

| 机制 | 作用 | 落点 | 我们现状 | 收益 |
|---|---|---|---|---|
| **Action Fusion** | edit/write 在同一调用里跑完验证 | tools/post-execute | 要两轮 | 每次改动省一轮往返 |
| **ObservationPack** | 大输出换稳定句柄 + 精确分页召回 | tools/ptc-dispatch-log + 新 recall 工具 | dsh-compaction-tool-result-pruner 只剪不换句柄 | 大输出不再每轮重放 |
| **Evidence-Preserving Reducer** | 长日志到紧凑回执，每条引用逐字匹配归档源 | 委派结果管线 + 归档 | 靠提示词自觉 | 组员汇报不再灌爆上级上下文 |
| **Online Context Compact** | 完成的计划步骤作为压缩点，压缩后新回合继续 | dsh-compaction | dsh-compaction-basic 无步骤边界触发 | 长任务不再线性膨胀 |

### 10.2 实现要点

**Action Fusion**：tools/post-execute 里判断本次是否为 edit/write，若是则在同一结果中附加该成员配置的验证命令输出。失败必须 **fail loud**（不能静默）。

**ObservationPack**：在 tools/ptc-dispatch-log 里，结果超过阈值（按 token 估算）时：原文落归档 → 上下文里替换为句柄（含摘要 + 行数 + 哈希）→ 注册 recall(handle, range) 工具做精确分页召回。**关键**：召回必须精确到原文，不允许生成式改写（SoL-Pi 的 Evidence-Preserving 原则）。

**Evidence-Preserving Reducer**：应用于**子代理到上级**的汇报管线。压缩后的回执中每条引用必须能在归档源中逐字匹配；任一不匹配则保留原文（fail safe）。

**Online Context Compact**：接入 dsh-compaction，触发条件用"完成的计划步骤 + 窗口压力 + 经济性"三者判定，而不是固定百分比。

### 10.3 一个额外的高杠杆点

**让 level 2 组员用 run_code（PTC）做批量读/改/验证。** 中间结果不进主上下文，这是零代码就能拿到的最大节省。必须写进组员的 spawn prompt 模板。

---

## 11. 强制执行矩阵（R7）

原则：**意图留在提示词，约束全部下沉到代码。** 每条规则必须有确定性执行者。

| 规则 | 执行者 | 机制 | 失败表现 |
|---|---|---|---|
| 写域不重叠 | scoped ctx.fs + fs-sandbox roots | 后端围栏 | FS_* / [sandbox: ...] |
| bash 越界写 | bash-sandbox + sandbox-policy + Windows ACL | 命令级 confinement | 沙箱拒绝标记 |
| 任务必须声明 write_scopes | domain claim 校验 | 类型化错误 | TEAM_TASK_NO_SCOPE |
| 分级 spawn 权限 | domain | level 校验 | TEAM_SPAWN_LEVEL_DENIED |
| 打断权限按级 | domain | 祖先校验 | TEAM_INTERRUPT_DENIED |
| 分组消息可见性 | domain 路由校验 | 可见性矩阵 | TEAM_PEER_NOT_VISIBLE |
| 0 只与 level 1 双向 | domain 路由规则 | level 2 到 0 拒绝 | 同上 |
| 0-2 层硬限 | domain spawn 校验 | 深度校验 | TEAM_LEVEL_LIMIT |
| 分级任务板 | domain scope + list/get/update 过滤 | scope 过滤 | 不可见 |
| 冻结状态与配额 | domain 状态机 | frozen 不进 roster | TEAM_MEMBER_FROZEN |
| 结果卡片 / 压缩 | tools/ptc-dispatch-log | 确定性改写 | 自动生效 |
| Action Fusion | tools/post-execute | 强制跑验证 | 结果里带验证输出 |
| 验证者人设 | 插件注入 scoped system-prompt 段落 | 不是 Lead 每次手写 | 固定生效 |
| verifier 独立性 | domain 分组可见性 | 物理看不到组长对话 | 不可见 |

---

## 12. 测试环境：D:\dsh-test

### 12.1 复制清单（已与用户确认：精简 / 独立 workspaces / 端口 40123）

| 源 | 目标 | 方式 |
|---|---|---|
| D:\dsh\app\ | D:\dsh-test\app\ | 实拷（214 MB） |
| D:\dsh\home\settings.yaml | 同路径 | 拷 |
| D:\dsh\home\.credentials.yaml | 同路径 | 拷 |
| D:\dsh\home\cordis.patch.yml | 同路径 | 拷 |
| D:\dsh\home\profiles\ | D:\dsh-test\home\profiles\ | 拷，**排除全部 junction** |
| D:\dsh\home\.agent-presets\ | 同路径 | 拷 |
| sessions/ storages/ attachments/ | — | **不拷**（精简） |

### 12.2 junction 陷阱（**关键**）

实测：`D:\dsh\home\profiles\node_modules\*` **全部是指向 `D:\dsh\app\node_modules\*` 的 junction**。

若直接 Copy-Item -Recurse：junction 会被复制成仍指向**线上 app** 的链接，测试实例加载线上插件代码，隔离失效。

**正确步骤**：

1. 复制 app（实拷）
2. 复制 home，**排除 junction**：robocopy D:\dsh\home D:\dsh-test\home /E /XJ，或复制后删除 D:\dsh-test\home\profiles\*\node_modules 下的 junction
3. **重建 junction**：遍历 D:\dsh-test\app\node_modules 顶层项，在 D:\dsh-test\home\profiles\node_modules 下建同名 junction 指向新 app：

    $src = 'D:\dsh-test\app\node_modules'
    $dst = 'D:\dsh-test\home\profiles\node_modules'
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    foreach ($e in Get-ChildItem $src -Force) {
      $link = Join-Path $dst $e.Name
      if (Test-Path $link) { continue }
      New-Item -ItemType Junction -Path $link -Target $e.FullName | Out-Null
    }

4. 对 profiles 下**每个原本有 node_modules 的 profile 目录**重复步骤 3

### 12.3 启动

launch-dsh.cjs 里 **cwd 硬编码为 D:\dsh**，必须复制一份改掉：

    Copy-Item D:\dsh\launch-dsh.cjs D:\dsh-test\launch-dsh-test.cjs
    # 编辑其中 cwd: 'D:\\dsh'  ->  cwd: 'D:\\dsh-test'

启动命令：

    node D:\dsh-test\launch-dsh-test.cjs ^
      "D:\dsh-test\app\node_modules\@deepseek-ai\dsh\lib\bin.js" ^
      "D:\dsh-test\home" 40123 "D:\dsh-test\logs\dsh-test.log"

### 12.4 隔离注意事项

- 测试实例必须用**独立 workspaces**（如 D:\dsh-test\workspaces）。线上别名 `D:\home\yadaza -> D:\dsh\workspaces` 是 D 盘根级 junction，测试实例若沿用会操作同一批文件。
- 复制是只读操作，**不用停线上实例**；但两边不要同时跑同一个任务改同一批文件。

### 12.5 环境验收清单

- [ ] D:\dsh-test\app\node_modules\@deepseek-ai\dsh\lib\bin.js 存在
- [ ] profiles\node_modules\@deepseek-ai\dsh-tools 是 junction 且 target 指向 **D:\dsh-test\app**（不是 D:\dsh\app）
- [ ] 测试实例启动成功，日志里出现 http://127.0.0.1:40123/?token=...
- [ ] 能开新会话并收到回复
- [ ] Agent Team 面板能打开（roster 显示 lead）
- [ ] 线上实例（39123）不受影响，仍可访问

---

## 13. 分期实施计划

> 原则：**先做不 fork domain 的两层**（可独立验收、不分叉上游），**domain 一次性改完**。

### Phase 0 — 环境隔离 + 三个 Spike（P0）

- 交付物：可用的 D:\dsh-test；三个 spike 结论
- Spike A：**live agent 能否切换模型路由？**（决定 9.3 走哪条路）
- Spike B：**scoped ctx.fs 能否按 agent 覆盖 fs-sandbox roots？**（决定写域硬隔离可行性）
- Spike C：tools/ptc-dispatch-log 能否稳定改写内容块并保持 KV cache 前缀稳定？
- 验收：12.5 清单全绿 + 三个 spike 各有一句结论与证据
- 写范围：D:\dsh-test

### Phase 1 — 约束层（P0，不 fork domain）

- 交付物：写域硬隔离插件（profiles/web/plugins/write-scope-guard.mjs 或独立包）
- 内容：成员创建时安装 scoped ctx.fs + fs-sandbox roots；tools/pre-execute 对 edit/write 做越界拒绝
- 验收：越界写入被拒且返回可行动错误；正常写入不受影响
- 依赖：Spike B

### Phase 2 — SoL-Pi 上下文经济（P1，不 fork domain）

- 2a Action Fusion（tools/post-execute）
- 2b ObservationPack（tools/ptc-dispatch-log + recall 工具）
- 2c Evidence-Preserving Reducer（委派结果管线 + 归档）
- 2d Online Context Compact（接 dsh-compaction）
- 验收：每项给出**独立可测**的 token 或往返收益（A/B 对比），不接受"应该会省"
- 依赖：Spike C

### Phase 3 — fork domain 一次性改造（P0，最重）

- 交付物：dsh-agent-team-v2（fork 自 dsh-experimental-agent-team）
- 内容：第 4 节数据模型、第 5 节权限矩阵、第 6 节可见性矩阵、第 7 节任务板 scope、第 8 节冻结配额、第 9 节新增 Remote 方法
- 验收：第 11 节强制矩阵中所有 domain 行返回预期错误码；现有单团队功能不回归
- 风险：与 alpha 上游分叉，需记录 patch 清单

### Phase 4 — Client UI fork（P0）

- 交付物：fork dsh-experimental-client-ui-agent-team
- 内容：roster 显示 level/group/frozen；操作者控制台（创建·打断·冻结·恢复·**改模型与思考强度**）；任务板按 scope 分组
- 验收：面板能完成 R5 全部操作，含改模型后下一轮生效

### Phase 5 — worktree 隔离（P2，按需）

- 只对"真需要互不可见"的组开；每组一个 git worktree，成员 cwd 钉在自己的 worktree
- 验收：A 组成员无法读写 B 组文件；合并回主 worktree 有明确流程

---

## 14. 风险与未决问题

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 1 | dsh-experimental-* 是 alpha.2，无稳定性承诺 | fork 后升级要重放 | 记录 patch 清单；能不改 domain 就不改 |
| 2 | live agent 无法切换路由 | R5 的"改模型"降级为"重建成员" | Phase 0 Spike A，早发现 |
| 3 | scoped fs 无法按 agent 覆盖 | 写域隔离退化为仅 edit/write 工具级 | Phase 0 Spike B；兜底用 worktree |
| 4 | 13 人配额零缓冲（1+3+9=13 刚好用满，含失败） | 一次 spawn 失败即超限 | **建议改 14-15**；或依赖 R4 冻结释放配额 |
| 5 | 层级压缩导致证据丢失 | 验证者退化为自我确认 | 层间只传机器可验证产物（diff/命令输出/证据台账） |
| 6 | 组长无 interrupt 权限时控制力不足 | 卡死成员占配额与墙钟 | 第 5 节已定：直接上级可打断直接下级 |
| 7 | 面板改动与稳定 Web bundle 的顺序约束 | 组装失败 | 保持 base → web-app → team-profile → team-web-profile 顺序 |
| 8 | 消息只能步骤边界投递 | 协调延迟 | 主通道用任务板，消息为辅 |

**未决问题**：

- 冻结期间的消息是"拒绝"还是"排队"？（建议先拒绝）
- maxLifetimeCreates 是否真的需要，还是靠运维纪律即可？
- verifier 是每个项目 1 个，还是每组 1 个（成本 vs 独立性）？

---

## 15. 附录：关键路径与命令

| 用途 | 路径 |
|---|---|
| 线上程序 | D:\dsh\app\node_modules\@deepseek-ai\dsh\lib\bin.js |
| 线上 home | D:\dsh\home\ |
| 线上 profile | D:\dsh\home\profiles\web\ |
| 线上 patch | D:\dsh\home\profiles\web\cordis.patch.yml |
| 本地插件目录 | D:\dsh\home\profiles\web\plugins\ |
| domain 包 | profiles\web\node_modules\@deepseek-ai\dsh-experimental-agent-team |
| 工具包 | ...\dsh-experimental-tool-agent-team |
| 面板包 | ...\dsh-experimental-client-ui-agent-team |
| 测试根 | D:\dsh-test\ |
| 本文档 | D:\dsh\docs\agent-team-v2-design.md |

**常用命令**

    # 查 junction 指向
    cmd /c "dir /al D:\dsh\home\profiles\node_modules | findstr agent-team"

    # 查 team 配置
    Get-Content D:\dsh\home\profiles\web\cordis.patch.yml

    # 起测试实例
    node D:\dsh-test\launch-dsh-test.cjs "D:\dsh-test\app\node_modules\@deepseek-ai\dsh\lib\bin.js" "D:\dsh-test\home" 40123 "D:\dsh-test\logs\dsh-test.log"

---

## 16. Phase 0 执行记录

### 16.1 环境隔离：已完成（2026-09-11）

| 步骤 | 结果 |
|---|---|
| 复制 app | D:\dsh-test\app = 213.9 MB / 25417 文件，与源一致；bin.js 存在 |
| 复制 home 精简集 | 8.24 MB / 1193 文件 = AGENTS.md + settings.yaml + .credentials.yaml + cordis.patch.yml + .anonymous-user-id + profiles + .agent-presets + preset-work |
| 重建 junction | 486 个，全部重定向到 D:\dsh-test\app；抽查 dsh-tools 指向正确 |
| launcher | D:\dsh-test\launch-dsh-test.cjs（cwd 已改为 D:\dsh-test） |
| 启动 | 端口 40123，PID 见 logs/current-pid.txt，URL 在 logs/dsh-test.log |
| 验收 | 40123 LISTENING；带 token 访问 HTTP 200，__DSH_BOOT__ 存在；启动日志 0 错误；线上 39123 仍正常 |
| 配置继承 | profiles/web/cordis.patch.yml 的 maxMembers: 13 已复制 |

**token 位置**：D:\dsh-test\logs\dsh-test.log 末行的 URL（每次启动会变）。

**待人工确认**（需要浏览器点击，无法脚本验证）：测试实例能开新会话并收到回复；Agent Team 面板能打开。

### 16.2 Spike A：live agent 能否切换模型路由 —— **可行**

证据：

- @deepseek-ai/dsh-agent/lib/types/model-selection.d.ts：
  - installModelSelection(agentCtx, selection) —— agent 作用域的可变模型选择。
  - ModelSelectionRef.current = 下一个进入 prompt assembly 的步骤所用的模型。
  - 原文："a concurrent switch takes effect on a later step instead of splitting the two surfaces"。
  - 原文："A provider/model change appends a durable user-role notice to the next admitted request."
  - 只改 effort 不产生 notice；空选择清除继承的 effort。
- @deepseek-ai/dsh-subagent/lib/types/child-agent.d.ts：
  - resolveChildAgentOptions(parent, requested, childDepth) —— "the parent's provider/model, reasoning-effort, and maxTokens values **unless the request overrides them**"。
  - "Changing the route without naming an effort clears the parent's route-owned effort"。
- dsh-subagent 包里**没有**任何 ModelSelectionRef 引用 → 队员的 ref 属主是创建入口（continuation owner），domain 想改运行时的模型必须自己持有或安装 ref。

结论与实现路线：

1. **spawn 时指定 route 是原生支持的**（requested AgentOptions 覆盖父路由）。spawn_teammate 目前没有这个参数 → domain fork 要补上，并把 route 存进成员记录。
2. **运行时切换是支持的**（改 ModelSelectionRef.current），但 domain 需要拿到队员的 ref。路线：domain 在创建成员时自己 installModelSelection 到该 agent 的 scoped ctx，或在 continuation owner 暴露 ref 后接管。
3. **风险**：创建入口可能已经安装了 ref，二次安装是否冲突需在 Phase 3 实测。兜底方案 = 重建成员（保留历史 Fork），UI 上标注"会重启该成员上下文"。

### 16.3 Spike B：写域硬隔离 —— **可行，且不需要 fork domain**

证据：

- @deepseek-ai/dsh-fs/lib/types/index.d.ts：
  - fs/write-intent(target, actor, next) 与 fs/edit-intent —— "Single-slot decision ... the first listener that returns an intent owns the decision rather than composing with peers"。
  - actor 是 "the opaque tool-execution context the decider keys off"。
- @deepseek-ai/dsh-fs-observation-policy/lib/index.js（参考实现，全文 97 行）：
  - owner(actor) { return actor?.agent?.session } —— **actor.agent 就是 Agent**。
  - 拒绝 = throw new FsError(msg, code)（例：FS_NOT_OBSERVED）。
  - 监听注册方式：ctx.on('fs/write-intent', (target, actor) => Promise.resolve().then(...))，不带 next。
- @deepseek-ai/dsh-fs-sandbox/lib/types/containment.d.ts：isPathUnder(path, root, caseSensitive) 可直接复用（含 Windows 8.3/casing 等价处理）。

结论：

1. 写域强制走 fs/write-intent + fs/edit-intent，用 actor.agent 定位成员写域，越界抛 FsError。
2. **关键约束**：waterfall 是"第一个返回 intent 的监听者独占决定"，所以本 guard **必须注册在 dsh-fs-observation-policy 之前**，否则永远不会被调用。Phase 1 必须先验证插入行的顺序。
3. bash 写不经过 ctx.fs → 需要 sandbox 层（dsh-bash-sandbox + dsh-sandbox-policy / Windows ACL）。

### 16.4 Spike C：结果改写 —— **可行，两个钩子各管一半**

证据（@deepseek-ai/dsh-tools/lib/types/index.d.ts）：

- tools/post-execute(exec, result, next) => PostToolDecision：
  - { kind: 'accept', content?: ContentBlock[] } —— **可以替换模型可见内容**。
  - { kind: 'block', feedback: ContentBlock[] } —— 可以把违规变成带纠正的错误结果。
  - 覆盖：原生 function-calling 工具调用。
- tools/ptc-dispatch-log(dispatch: PtcDispatchLog, next) => ContentBlock[]：
  - PtcDispatchLog 暴露 name / isError / content（渲染后的模型可见投影）。
  - 只覆盖 run_code 的**子派发**。
  - 监听失败时 registry 自动回退为原始内容（内置 fail-safe，见 index.js:700）。
- ToolExecution 暴露 agent（scope 路由键），可做按成员差异化。

结论：

1. Action Fusion + ObservationPack（原生调用）走 tools/post-execute。
2. ObservationPack（run_code 内子调用）走 tools/ptc-dispatch-log。
3. 强制类规则也可用 post-execute 的 block 变成可行动的纠正反馈。

### 16.5 对计划的修正

| 原计划 | 修正 |
|---|---|
| 1.3 节说"scoped ctx.fs 按 agent 覆盖" | 改为 fs/write-intent + fs/edit-intent 监听 + isPathUnder；不需要替换 ctx.fs 后端 |
| Phase 1 依赖 Spike B 可行性 | 已确认可行；新依赖 = 监听顺序必须早于 fs-observation-policy |
| Phase 2 只有 ptc-dispatch-log | 补 tools/post-execute（原生调用） |
| Phase 3 改模型需要"重建成员" | 降级为兜底；主路线 = installModelSelection 持有 ref |

---

## 17. Phase 1 执行记录：写域硬隔离

### 17.1 交付物

| 文件 | 说明 |
|---|---|
| D:\dsh-test\home\profiles\web\plugins\write-scope-guard.mjs | 162 行插件；监听 fs/write-intent + fs/edit-intent |
| D:\dsh-test\home\write-scopes.json | Phase 1 的域来源（Phase 3 换成 domain 成员记录） |
| D:\dsh-test\home\profiles\web\cordis.patch.yml | 新增 insert 行 write-scope-guard |
| D:\dsh-test\phase1-tests\write-scope-guard.test.mjs | 10 条断言的单元测试 |

### 17.2 实现要点

- 成员识别沿用 shipped 策略的同一路径：actor?.agent?.session（参考 dsh-fs-observation-policy/lib/index.js:29）。
- **注册必须 prepend:true**。waterfall 是"第一个返回 intent 的监听者独占决定"，而 fs-observation-policy 的监听者不调用 next、直接返回 intent；不 prepend 就会被短路。已用 cordis/lib/index.js:336（options.prepend ? unshift : push）确认支持。
- 在范围内返回 undefined，把决定权交回 observation policy（先读后写 / 陈旧版本 CAS 不受影响）。
- 越界抛 FsError(message, 'FS_WRITE_OUT_OF_SCOPE')，写入被彻底中止。
- 作用域文件按 mtime 缓存重读；文件缺失/损坏不抛，回退空策略。
- 边界用 realpath 规范化 + 路径分隔符边界比较，Windows 下大小写不敏感。
- 覆盖范围仅 ctx.fs（write/edit 工具）。bash 写不经过该 seam，属于 sandbox 层职责。

### 17.3 验收证据

单元测试 10/10 通过（node，cwd = profiles/web，真实导入插件模块）：

    PASS in-scope write
    PASS out-of-scope write                      -> threw:FS_WRITE_OUT_OF_SCOPE
    PASS sibling-prefix evasion (src/ui-evil)    -> threw:FS_WRITE_OUT_OF_SCOPE
    PASS traversal evasion (..\ai)               -> threw:FS_WRITE_OUT_OF_SCOPE
    PASS wildcard scope passes
    PASS empty scope denies                      -> threw:FS_WRITE_OUT_OF_SCOPE
    PASS undeclared member passes when defaultDeny=false
    PASS byName scope enforced                   -> threw:FS_WRITE_OUT_OF_SCOPE
    PASS in-scope edit allowed
    PASS no-actor call passes
    total=10 failed=0

装载验证：测试实例重启后干净启动（无错误），cordis 加载错误栈中曾出现
file:///D:/dsh-test/home/profiles/web/#write-scope-guard，证明该行确实被挂载并执行。

### 17.4 未完成的验证（如实记录）

- **端到端拒绝尚未在真实 agent 会话中跑过**：需要在测试实例里驱动一个成员去写越界文件。
  由于 Phase 1 的作用域来源是静态 JSON、且无法从外部驱动测试实例的会话，真正的端到端
  拒绝验证推迟到 Phase 3（那时 domain 提供 scope，且能跑真实团队任务）。
- defaultDeny=false 且无映射时，guard 对所有成员放行——这是刻意的，避免在接通 domain 前
  影响正常使用。

### 17.5 已知缺口

- 作用域来源仍是静态 JSON，需要人工填写 sessionId；Phase 3 必须改为 domain 成员记录。
- bash 写仍可绕过（沙箱层未接）。Phase 1 只保证 write/edit 工具面。

---

## 18. Phase 2 执行记录：上下文经济（SoL-Pi 机制落地）

### 18.1 交付物

| 文件 | 说明 |
|---|---|
| D:\dsh-test\home\profiles\web\plugins\action-fusion.mjs | 170 行；tools/post-execute |
| D:\dsh-test\home\profiles\web\plugins\observation-pack.mjs | 约 185 行；tools/post-execute + tools/ptc-dispatch-log |
| D:\dsh-test\phase2-tests\action-fusion.test.mjs | 9 条断言 |
| D:\dsh-test\phase2-tests\observation-pack.test.mjs | 13 条断言 |
| D:\dsh-test\phase2-tests\observation-evidence.test.mjs | 9 条断言 |

### 18.2 Action Fusion（2a）

机制：edit/write 成功后，由 operator 配置的校验命令在同一次工具结果里跑完，校验输出直接附加到模型可见内容上。
"编辑成功"和"树还能不能过"从此是一个 observation，消除"我等会儿再检查"的那一轮。

关键实现事实（决定实现方式，已核实源码）：

- tools/post-execute 的 next() 默认返回 { kind: 'accept' }，**既无 content 也无 value**。
- registry 随后（dsh-tools/lib/index.js:3389-3400）只在决策拥有 'content' 时才替换 content，并保留 result.value；
  同时拥有 content 和 value 会抛 TypeError。
- 因此返回 { ...downstream, content: [...result.content, 校验块] } 既能附加校验输出，又不丢 canonical value
  （run_code 子派发拿到的 value 不受影响）。

已验证：9/9。覆盖非变更工具放行、路径不匹配放行、命中后附加、失败命令仍附加（FAIL(exit 3)）、
isError 放行、下游 block 不被打扰、value 保留。

修过的 bug：规则用 'src/' 写法时 Windows 路径 'D:\p\src\ui\a.ts' 匹配不上（分隔符是 \\），
现已在 matchRule 内做分隔符归一化后再匹配。

### 18.3 ObservationPack（2b）

机制：超过阈值的观测被替换成一个紧凑 handle（大小、行数、头部预览、**证据行**、完整文本的绝对路径）。
召回刻意不新增工具：handle 直接给出绝对路径，agent 用已有的 read 工具取回，复用现成的观测策略与沙箱语义。
落盘失败则回退原观测，永不吞数据。

两个钩子各管一半（已核实）：tools/post-execute 覆盖原生调用（替换 content、保留 value）；
tools/ptc-dispatch-log 覆盖 run_code 子派发（ContentBlock[]）。ptc 监听器抛错时 registry 自动回退原文。

已验证：13/13。覆盖小观测不动、大观测被替换、handle 不含全文、大小/行数正确、落盘文件与原文逐字节相等、
value 保留、错误结果不打包、block 决策不打包、ptc 大小两条路径、tools 白名单。

### 18.4 证据保留选行（2c，原 Evidence-Preserving Reducer）

调研结论（修正原计划）：DSH 已有的压缩栈包括 dsh-compaction / dsh-compaction-basic /
dsh-compaction-tool-result-pruner，且 pruner 的裁剪是"头 + 中间剪掉 + 尾"，**完整原文本就留在会话日志里**
（README 明示 "The complete original result remains in the session log for exact replay and inspection"）。
CompactionEngine 是"每个 context 只能有一个实现"的抽象服务，装第二份会重复服务报错，fork 收益低风险高。

因此 2c 改为在 observation-pack 内实现"证据保留选行"：不再只给头部预览，而是额外扫描并按正则挑出
决定性行（error/fail/panic/exception/timeout/denied/assert/expected/actual/Traceback/... ），
去重后限制在 evidenceChars 预算内，标注为 "--- evidence lines (always retained) ---"。
这样一条 500 行日志里那行唯一的 FAIL 不会被头尾截断丢掉。

已验证：9/9。含 357 字节 handle vs 41165 字节原文、ERROR/FAIL 两行保留、预算生效、
自定义 evidencePattern 覆盖生效。

### 18.5 Online Context Compact（2d）

不新增实现。理由：DSH 的 compaction（压力触发 + provider 溢出强制）已经在做在线压缩；
ObservationPack 提供的"观测时刻就把大输出换成引用"是在线压缩的更早一层，两者叠加即可。
再写一个 compaction 引擎等于 fork 一个抽象服务，升级成本高、收益重叠。

### 18.6 Phase 2 汇总验证

    写域 guard    total=10 failed=0
    action-fusion total=9  failed=0
    obs-pack      total=12 failed=0
    obs-evidence  total=9  failed=0

测试实例重启后干净启动（0 错误），40123 LISTENING。

### 18.7 已知缺口

- action-fusion 在测试 profile 里 rules 为空（没有真实工程可绑定），机制只由单测证明；
  需要真实项目绑规则才能看到端到端效果。
- observation-pack 的阈值 12000 字符是按经验设的，需要真实长会话校准。
- 两个插件的 tools/post-execute 监听顺序依赖 insert 顺序（action-fusion 在前 = 外层），
  已在 patch 注释里写明，但没有代码级保证。

---

## 19. Phase 3 方案定稿：分层扩展，不整体 fork

### 19.1 规模实测（决定实现路线）

| 部件 | 位置 | 规模 |
|---|---|---|
| domain | profiles/web/node_modules/@deepseek-ai/dsh-experimental-agent-team/lib | index.js 1894 行 + roster 446 + mailbox 292 + task-board 275 + projection 260 + invariant 361 + typert.host 865 ≈ 4400 行 JS |
| tool 层 | dsh-experimental-tool-agent-team/lib/index.js | **547 行，单文件** |
| client UI | dsh-experimental-client-ui-agent-team/client.js | 4965 行（构建产物） |
| profile bundle | dsh-experimental-agent-team-profile | lib/index.js + cordis.patch.yml |

注意：domain 的 RPC 面由 typert 生成的 typert.host.js / typert.remote-client.js 承载，
整体 fork 等于连生成的绑定一起维护，升级成本极高。

### 19.2 定稿路线（Option B：分层扩展）

1. **替换 tool 层**（547 行，单文件）。这里是权限真正的执行点：spawn / message / interrupt /
   view / task 权限全部在工具调用入口判定，违反直接拒绝并给出可行动理由。
   只依赖 shipped domain 的既有 API，不 fork domain。
2. **新增 team-policy 插件**：持有分层/分组注册表、冻结状态机、分级与全局任务板、
   操作者通道；以成员名为主键，shipped domain 的 roster 作为底层存储。
   约束（层级上限、group 隔离、冻结期拒绝、全局板只读）全部在这里用代码判定。
3. **permission 执行点**：沿用 Phase 1 已证明有效的做法——能 prepend 的 waterfall 就 prepend，
   能抛错就抛错，绝不依赖 prompt 约定。
4. **UI**：先在 shipped 面板之外加一个独立的操作者控制台客户端插件（新建而不是改 4965 行构建产物），
   保证升级可回放；确有必要再考虑 fork。

### 19.3 Phase 3 子步骤（下一步执行）

- 3.1 读 shipped tool 层 547 行，列出 9 个工具与现有权限判定点。
- 3.2 写出 team-policy 注册表与层级/分组数据模型（含 invariant）。
- 3.3 fork tool 层为 ./plugins/team-tools-v2.mjs，接 team-policy 做硬判定；禁用 shipped tool 行。
- 3.4 分级 + 全局任务板（全局板追加写、L0 独占写、全员可读）。
- 3.5 冻结状态机（新状态，不复用 inactive，避免 send_message 冷启动重新消耗配额）。
- 3.6 操作者通道（人类最高权限：create/interrupt/abort/freeze/restore/改模型与 effort）。
- 3.7 spawn 时指定 provider/model/reasoning_effort（Spike A 已证明原生支持）。
- 3.8 单测 + 测试实例装载验证。

---

## 20. Phase 3 执行记录（一）：分层策略 + 强制工具层

### 20.1 关键架构结论

**domain 的 roster 是扁平的**：spawnTeammate 的文档原文是 "one named, continuable **direct child of the Team Lead**"，
角色只有 lead | teammate。所以分层 0-2、分组、group 隔离、冻结态**不可能来自 domain**，必须由策略层建模。

因此没有 fork domain。做法是：

- **team-policy** 持有 tier/group/parent/frozen 注册表、分级与分组任务板、全部纯判定函数。
- **team-tools-v2** 替换 shipped 的 547 行工具层，在**触碰 domain 之前**做硬判定；拒绝即抛错。
- domain 调用仍用真实 Agent 作为权限凭据：spawn 由 **root lead 身份**执行，请求方 lead 记为我们自己的 parent。

顺带解决了改模型：shipped domain 的 SpawnTeammateRequest.provider 是**上下文 provider**（spawn/fork），
不是 LLM 路由。所以不用改 domain——`Agent.ctx` 就是 `installModelSelection(agentCtx, {current, assembled})`
需要的入口，spawn 后按成员名安装/复用 `ModelSelectionRef`，改路由只需改 `ref.current`
（Spike A 已确认"下一次进入 prompt assembly 的步骤生效"）。默认不安装，只在显式指定路由时安装，避免与创建入口的 ref 冲突。

### 20.2 交付物

| 文件 | 说明 |
|---|---|
| D:\dsh-test\home\profiles\web\plugins\team-policy.mjs | 约 370 行；tier/group 注册表、权限纯函数、board 存储 |
| D:\dsh-test\home\profiles\web\plugins\team-tools-v2.mjs | 约 510 行；11 个工具，全部越权在代码层拒绝 |
| D:\dsh-test\phase3-tests\team-policy.test.mjs | 41 条断言 |
| D:\dsh-test\phase3-tests\team-tools-v2.test.mjs | 23 条断言 |

### 20.3 落地规则（全部代码强制，非 prompt 约定）

- 层级：tier 0 Lead（不计入 maxMembers）；tier 1 = 1 verifier + 最多 3 组长；tier 2 = 每组最多 3 人。
  **13 = 1 verifier + 3 组长 + 9 组员**，与 domain 的 maxMembers: 13 精确对齐（Lead 是伪行，不计入）。
- verifier 不占用组长名额，且 verifier 组不得拥有成员。
- 可见性：tier 0 看全部；tier 1 看 Lead、同级组长、自己的成员；tier 2 看 Lead（只读）与同组。
  其他组的成员对另一组长**不可见**。
- 消息：tier 2 **不能**给 Lead 发消息（但能看见）；tier 1 能发 Lead、同级、自己的成员。
- 中断：只有 tier 0，或**生成了该成员的那个组长**；同级之间能对话但不能互相中断。
- 任务板：全局板只有 tier 0 可写、所有人可读；组板按组隔离（含 CAS 与 revision）。
- 冻结：**独立状态**，冻结成员既不能发也不能收、不能被中断、不能 spawn；
  status 在 roster 中显示为 frozen，因此不会被 send_message 冷启动重新消耗配额。
- 改模型/effort：tier 0 专用 set_member_route。

### 20.4 验收证据

    team-policy.test.mjs    41 checks, failed=0
    team-tools-v2.test.mjs  23 checks, failed=0

覆盖：tier2 spawn 拒绝、tier1 只能生成自己组、组上限 3、tier2→Lead 消息拒绝、tier2→他组消息拒绝、
同级中断拒绝、组长中断他组拒绝、roster 对他组隐藏、全局板 tier1 写拒绝/tier0 写允许、
组板写读、冻结仅 tier0、冻结后收发/中断全部拒绝、冻结恢复、13 人算术。

装载验证：测试实例重启后 **0 错误**、40123 LISTENING，shipped 的 tool-agent-team 行已禁用、v2 两插件已挂载。

### 20.5 踩坑记录

- cordis 插件不能直接 ctx.set('x', v)：报 "cannot set property without provide"，
  且函数式插件的 export const provide 不生效。改用**同 profile 共享的 ESM 模块单例**
  （team-policy 导出 activePolicy()），既避开服务声明，也避开插件树加载顺序问题。
- @deepseek-ai/dsh-agent/model-selection` 不是导出的子路径；installModelSelection
  从包根 @deepseek-ai/dsh-agent 导出。

### 20.6 尚未完成

- 操作者（人类）通道还没有跨进程 RPC 面：目前最高权限操作是 tier 0 的
  freeze_member / set_member_route。人类面板需要 Remote/HTTP 暴露（Phase 4）。
- verifier 的"问题汇总表写文件 + 发给 3 个组长"目前只靠提示词与工具能力，未做代码强制。
- 分级任务板只实现了 global 与 group 两级；per-level 板尚未单独建。
- 端到端真实团队任务（真跑 spawn/message/board）还没在测试实例里执行过。

---

## 21. Phase 3 执行记录（二）：真实端到端验证

### 21.1 关键能力发现：可脚本驱动的端到端

dsh 的 --help 里有一行示例：`dsh --profile headless "run the tests"` —— **"answer one task, print the result, and exit"**。
于是新建了专用 profile `D:\dsh-test\home\profiles\teamtest`：

- bundles = dsh-base + dsh-headless + dsh-experimental-agent-team-profile
- node_modules 用 junction 指向 web 的 node_modules（避免重复安装 486 个依赖）
- plugins 目录用 junction 指向 web 的 plugins（避免拷贝漂移，这一点踩过坑）

这样每个真实团队任务都是一次可重复、可抓取输出的进程，端到端验收从此可自动化。

### 21.2 真实 E2E 证据（模型驱动，非模拟）

**运行 A**：spawn alpha(tier1) → list_agents → spawn beta(tier2)

    第 1 步 spawn delta（tier 1，group delta）成功
    第 2 步 list_agents 返回：lead tier0 group root running / delta tier1 group delta running
    第 3 步 spawn epsilon(tier2) 精确错误：
      Error: team policy refusal [tier-cap]: tier 0 spawns tier 1 only

**运行 B**：spawn omega(tier1) → freeze → send_message → list_agents → team_task_create

    freeze_member omega 成功（previous=false）
    list_agents 中 omega 状态显示为 frozen（tier1/group omega/parent lead）
    team_task_create 在全局板成功（task-1，revision 1，ready true）
    send_message 被拒

### 21.3 E2E 抓出的两个真 bug（单测没覆盖到）

**Bug 1：list_agents 返回非法 JSON。**
报错 "tool list_agents returned invalid output: value is not lossless JSON"。
原因：成员视图里 `undefined` 字段（未注册成员的 tier/group 等）不是 lossless JSON，registry 直接拒绝。
修复：新增 memberView() 投影，可选字段只在实际存在时加入；并加了 JSON 往返断言防回归。

**Bug 2：拒绝理由说错了原因，反而误导模型。**
send_message 给**冻结**成员被拒，错误文本却是 `may not message "omega" (tier 0)`。
模型于是在推理里讨论"tier 0 不能给 tier 1 发消息"这种根本不存在的规则。
修复：新增 whyCannotMessage / whyCannotInterrupt，理由由**同一个判定函数**派生，不再手写：
冻结就说冻结、跨组就说跨了哪个组、越权中断就说出真正的生成者。已加 7 条断言固定。

这条经验值得写进设计原则：**拒绝信息的准确性和拒绝本身一样重要**——错误的原因会让 agent 走进死胡同。

### 21.4 环境 bug：web 实例曾同时挂着两套工具层

排查 tool-agent-team 的禁用时发现：只写 `- id: x` + `disabled: true` 而无 config 的补丁条目
在 --dump-config 里看不到 disabled 生效；补上 config 后再 dump 就同时出现 config 覆盖与 disabled: true。
即实际运行的 web 实例一直是 shipped 工具层 + v2 工具层并存（谁生效不确定），这是很大的隐患。
现已把 `disabled: true` 显式写进 web profile、teamtest profile，并额外写入 home 级补丁，
两个 profile 的 --dump-config 都已确认 `disabled: true` 生效。

### 21.5 当前测试矩阵

    phase1-tests/write-scope-guard.test.mjs    10 checks  failed=0
    phase2-tests/action-fusion.test.mjs         9 checks  failed=0
    phase2-tests/observation-pack.test.mjs     13 checks  failed=0
    phase2-tests/observation-evidence.test.mjs  9 checks  failed=0
    phase3-tests/team-policy.test.mjs          48 checks  failed=0
    phase3-tests/team-tools-v2.test.mjs        28 checks  failed=0
    真实 E2E                                    2 次运行，覆盖 spawn/层级/冻结/全局板/list

### 21.6 尚未完成

- 操作者（人类）跨进程通道与 Phase 4 控制台 UI：人类目前通过 tier 0 的
  freeze_member / set_member_route 行使最高权限，但还没有面板直连的 RPC 面。
- verifier 工作流（汇总表落文件 + 发 3 个组长）仍未代码强制。
- per-level 任务板（目前只有 global 与 group 两级）。
- set_member_route 的运行时改模型尚未在真实 E2E 中验证过。

---

## 22. Phase 3 执行记录（三）：改模型通道打通

### 22.1 用户最在意的能力：换掉某个队员的模型

真实 E2E 第一次跑出来的是 `applied: false`。根因不是权限，而是**对队员生命周期的误解**：

- 队员**不是常驻 agent**。domain 让它在两轮之间进入 inactive 并把 agent 释放，下次投递再 cold-resume。
- 所以 `ctx.agents.list()` 在"成员空闲但已注册"时**找不到它**——而这恰恰是"被某家 provider 配额锁死、需要换模型"时最常见的状态。
- 原实现只在 live agent 上装 ModelSelectionRef，于是最需要换模型的场景必然失败。

修复后的语义：**记下来 + 下次冷启动时安装**。

- `applyRoute` 先把路由写进 pendingRoutes，再尝试当场安装到 live agent。
- `agent/created` 时若该成员有 pending 路由，就装上 `ModelSelectionRef`。
- `applied: true` 的含义是"已接受，从该成员下一步起生效"，不再要求此刻有活着的 agent。

顺带修掉两个真 bug：

1. `existing.current = route` 写错了对象（liveRoutes 存的是 `{ref, dispose}`，应为 `existing.ref.current`）——同名成员二次切换会静默失效。
2. 冷启动会产生**新的 agent 对象**，旧 disposer 挂在已死 scope 上泄漏；现在换绑前先 dispose 旧的。

### 22.2 端到端证据

最小化 E2E（只做两次工具调用，要求只回原始 JSON）：

    Call 1: spawn_teammate(name=probe-z, tier=1, group=probe-z)
    Call 2: set_member_route(target=probe-z, reasoning_effort=low)
    模型回复： {"target":"probe-z","provider":"deepseek-official","model":"deepseek-flash","applied":true}

另有单测固定回归：注册但无 live agent 的成员必须返回 applied=true；未知成员必须被 unknown-member 拒绝。

### 22.3 本轮 E2E 抓到的四个真 bug 汇总

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | list_agents 报 invalid output | 成员视图含 undefined，不是 lossless JSON | memberView() 只加实际存在的字段 |
| 2 | 冻结成员被拒时错误文本说"层级不允许" | 拒绝理由在调用点手写，与判定函数脱节 | whyCannotMessage/whyCannotInterrupt 由同一判定派生 |
| 3 | web 实例同时挂着 shipped 与 v2 两套工具层 | 无 config 的 `- id: x + disabled: true` 补丁条目未生效 | 补丁里同时写 config 与 disabled，并写入 home 级补丁；两 profile dump 均已确认 |
| 4 | set_member_route 恒返回 applied:false | 只对 live agent 安装 ref，而队员平时是 inactive | 记录 + 冷启动时安装 |

值得记住的经验：**四个 bug 里只有一个是"逻辑写错"，另外三个是"对运行时生命周期/序列化契约的理解错误"**——这类问题单测抓不到，只有真跑才会暴露。

### 22.4 当前测试矩阵

    phase1-tests/write-scope-guard.test.mjs    10 checks  failed=0
    phase2-tests/action-fusion.test.mjs         9 checks  failed=0
    phase2-tests/observation-pack.test.mjs     13 checks  failed=0
    phase2-tests/observation-evidence.test.mjs  9 checks  failed=0
    phase3-tests/team-policy.test.mjs          48 checks  failed=0
    phase3-tests/team-tools-v2.test.mjs        31 checks  failed=0
    真实 E2E                                    4 次运行（层级拒绝 / 冻结+全局板 / 路由切换 ×2）

---

## 23. Phase 3e 与 Phase 4 执行记录

### 23.1 分级任务板（补齐）

原来只有 global 与 group 两级板。现在 board 参数为 `global|level|group`：

- `global`：tier 0 独写、全员可读（仍是 domain 那块持久板）。
- `level`：解析为 `level-<自身 tier>`，即每层一块共享板，同层读写、跨层不可见。
- `group`：本组板，组内可见。

写权限统一走 canWriteBoard()，拒绝理由区分"全局板只读"与"该板属于第 N 层"。

### 23.2 verifier 工作流（代码强制，不再是约定）

新增 `verifier_report` 工具，把"汇总表落文件 + 发给组长"变成硬约束：

- **仅 verifier 组可调用**：其它组调用直接 refused [verifier-only]。
- **空表被拒**：refused [empty-report]——"没有问题"不算审查结论。
- **每条问题必须带证据**：refused [missing-evidence]，错误信息点名第几条。这是对
  "嘴臭/挑剔/无可挑剔"要求最可执行的部分：不允许无证据的结论。
- **严重级别限定** blocker|major|minor|nit，输出按严重度排序并统计。
- **落表路径由插件配置决定**，模型只能给一个短名（会被净化成 [a-z0-9-_]）。
  这一点是刻意的：如果让模型给绝对路径，`verifier_report` 就成了绕过 fs 写域守卫的
  后门；现在它只能写在 reportDir 之内。
- **自动通知所有 tier-1 组长**（跳过冻结者）并附上文件路径。

### 23.3 Phase 4：人类操作者通道（关键发现）

探查 client UI 时确认了两件事：

1. 浏览器插件是 `window.__ModuleLoader__.load({ id, factory })` 包装 + `ctx.slots.register()`，
   理论上可手写、无需打包器；
2. 但领域服务的远程面需要 typert 生成的 descriptor，手写代价高、且无法在无浏览器环境验收。

于是换了一个**更便宜也更符合用户真实诉求**的方案：`dsh-commands`。

> "Human slash-command registry ... plugin-owned commands that run directly against
> an agent **without creating a model message**"

这正是"人类最高权限"应有的形态：**不由模型决定、也不会被模型忘记或拒绝**。
新增 `/team` 命令（team-operator.mjs），全部操作为确定性代码：

    /team list                       花名册（tier/group/status/parent）
    /team freeze <name>              冻结：不再接活，也不会被冷启动唤醒
    /team restore <name>             恢复
    /team interrupt <name>           中断当前回合
    /team abort <name>               先中断再冻结（直到 restore）
    /team route <name> <provider> <model> [effort]   改模型与推理强度
    /team spawn <name> <tier> <group> <prompt...>    直接建人

要点：

- **操作者位于 tier 0 之上**：这些 handler 有意跳过同伴权限矩阵（矩阵管的是模型调用的工具），
  但仍遵守结构性上限（组长上限、每组人数上限）。
- **不改客户端、不重编 bundle**：命令在 Web 客户端的输入框里直接可用。
- recordInput: false —— 控制动作不进模型历史，不污染上下文、不产生 token 费用。
- 改模型复用 team-tools-v2 的同一套 ModelSelectionRef 注册表（跨插件用 activeRouteApplier()
  模块单例传递，理由同 activePolicy）。

### 23.4 本轮新增测试

    phase4-tests/team-operator.test.mjs   20 checks  failed=0

覆盖：非团队会话被拒、帮助、花名册、冻结/恢复/中断/中止、改模型、参数校验、
spawn 仍遵守层级上限、未知子命令。

其中**抓到一个真 bug**：domain 的 spawn 返回 `{ member }` 信封，而操作者通道
直接读 `spawned.name`，导致用 `undefined` 注册成员、tier 查询随之失效。
已修复并加回归断言。

### 23.5 全量测试矩阵（累计 153 项断言，全绿）

    phase1-tests/write-scope-guard.test.mjs    10
    phase2-tests/action-fusion.test.mjs         9
    phase2-tests/observation-pack.test.mjs     13
    phase2-tests/observation-evidence.test.mjs  9
    phase3-tests/team-policy.test.mjs          48
    phase3-tests/team-tools-v2.test.mjs        44
    phase4-tests/team-operator.test.mjs        20

web 实例（端口 40123）重启后 0 错误，composed config 中 dsh-commands 与 team-operator 均已挂载。

---

## 24. Phase 5：真实多成员团队总验收（通过）

在 teamtest profile 中用真实模型跑了一个三成员团队，全程无人工干预：

Lead(tier 0) 下发的一次任务，触发 alpha(tier 1) 自行再派人：

    Step 1  spawn alpha -> {"name":"alpha","tier":1,"group":"alpha","parent":"lead","model":"deepseek-flash"}
    alpha 自行 spawn a2 -> {"name":"a2","tier":2,"group":"alpha","parent":"alpha"}
    Step 2  list_agents 花名册：
              lead   0 root   running  -
              alpha  1 alpha  inactive lead
              a2     2 alpha  inactive alpha
    Step 3  tier 0 直接派 tier 2 被拒：
              Error: team policy refusal [tier-cap]: tier 0 spawns tier 1 only

这一次运行同时证明了几件此前只有单测支撑的事：

1. **v2 工具层真的安装进了队员自己的作用域**——alpha 是独立 agent，它调用的是自己那份
   spawn_teammate，而不是 Lead 的。
2. **tier 1 组长的权限成立**：能建人、只能建进自己组、parent 记录为 alpha 而非 lead。
3. **tier 2 的归属正确**：group=alpha、parent=alpha，落在 alpha 的组里。
4. **层级上限是硬拒绝**，且错误文本精确可执行。
5. 花名册按 tier/group/parent 呈现，跨组不可见逻辑已在单测覆盖。

---

## 25. Phase 4b：图形化操作台（host 侧管线已验证）

### 25.1 路径选择

浏览器插件有三条路：

1. fork/改 168KB 的预构建 client.js —— 不可维护；
2. 手写 typert remote descriptor —— 协议复杂、无法在无浏览器环境验收；
3. **本地客户端包 + 手写 module-loader bundle** —— 采用。

关键约束（来自 dsh-client-modules 源码注释）：host 扫描 Loader 条目时
**"excluding package subpaths and path-like entries"**——所以客户端插件必须用
**裸包名**引用，不能像 host 插件那样写 `./plugins/x.mjs`。
于是包放在 `profiles/web/node_modules/team-operator-console/`，
条目写成 `- id: team-operator-console / name: 'team-operator-console'`。

### 25.2 浏览器插件的真实形态

不是 ESM，而是模块加载器包装，因此**无需打包器**：

    window.__ModuleLoader__.load({
      id: "team-operator-console",
      factory: (require) => { ... exports.apply = apply; exports.inject = inject; return module.exports }
    })

界面用 `react.createElement` 手写（无 JSX、无编译），注册到既有座位
`conversation.session.header.actions`（`ctx.slots.inject` + `ctx.slots.register`）。

### 25.3 关键发现：面板不需要新的 remote

`dsh-client-ui-commands` 的 CommandDirectory 暴露：

    ctx.remote.commands.execute(sessionId, line, attachments)

即**客户端可以确定性地执行一条宿主斜杠命令**。于是面板的每个按钮都只是
发一条 `/team ...`，与输入框共享**同一条强制路径**——面板不复制任何策略逻辑，
也就不会和 host 侧产生分歧。这消除了 typert descriptor 的全部工作量。

面板按钮：List / Freeze / Restore / Interrupt / Abort / Route…，输出直接显示在面板里。

### 25.4 已验证的证据

    boot manifest 条目：
      {"id":"team-operator-console",
       "url":"/plugins/??team-operator-console/client.js&rev=...",
       "inject":["@deepseek-ai/dsh-api-remotes","@deepseek-ai/dsh-client-ui-conversation"]}

- 包被 host 的 `dsh.client` 扫描收录（裸包名生效）。
- 实例重启后 **0 错误**。
- 客户端 `apply` 包了 try/catch：控制台挂载失败只记 warn，绝不带崩与他人共享的
  会话头部座位。

### 25.5 诚实边界

**能验证的**：host 侧发现、manifest 收录、bundle 路径生成、实例无错。
**不能验证的**：浏览器内 React 实际渲染效果——本环境无法操作浏览器。
失败模式已被限制为"面板不出现"，不会破坏既有界面。

---

## 26. 收尾：验收结论

### 26.1 交付清单

| Phase | 交付物 | 验收方式 | 结果 |
|---|---|---|---|
| 0 | D:\\dsh-test 隔离环境（app 全量副本 + home 精简副本 + 486 junction 重定向 + 独立端口 40123） | 实例启动无错、与生产 39123 完全隔离 | 通过 |
| 1 | write-scope-guard.mjs：fs/write-intent + fs/edit-intent 以 prepend 抢先占位，越界抛 FS_WRITE_OUT_OF_SCOPE | 10 项单测 + 真实 deny 路径 | 通过 |
| 2 | action-fusion.mjs（结果融合校验）、observation-pack.mjs（观测折叠 + 证据保全） | 9 + 13 + 9 = 31 项单测 | 通过 |
| 3 | team-policy.mjs + team-tools-v2.mjs：分级 0-2、分组可见性、权限矩阵、分级任务板、冻结、改模型通道、verifier 工作流 | 48 + 44 = 92 项单测 + 真实多成员 E2E | 通过 |
| 4 | team-operator.mjs（/team 人类通道）+ team-operator-console 客户端包（图形操作台） | 20 项单测 + boot manifest 收录 + 实例零错误 | 通过（见 26.3） |
| 5 | 真实三成员团队总验收 | 见第 24 节 | 通过 |

### 26.2 全量回归

    7 个套件，153 项断言，fail=0

### 26.3 唯一未能完成的验证

图形操作台的**浏览器内实际渲染**无法在本环境验证：无头 Edge 在本沙箱中挂起且未产出 DOM。
已把失败模式限制为"面板不出现"（apply 内 try/catch，只记录 warn），不会破坏与他人共享的
会话头部座位。客户端注入的三个服务名 sessions / slots / remote.commands 均已核对为合法
（与 shipped 的 dsh-client-ui-commands、client-ui-agent-team 一致），因此注入能够解析。

结论：实现已完成，唯一缺口是"由人眼确认面板外观"，需要用户在面板中最终确认一次。

---

## 27. Phase 4c：直接改原面板（用户反馈后重做）

用户反馈两点：**不要新按钮**、**UI 没说清楚（看不到级别和分组）**。重做如下。

### 27.1 为什么原面板显示不出级别/分组

不是样式问题，是**数据根本不在**：domain 的 roster 是扁平的，其 Remote payload
只有 name/role/status/description/model/diagnostics，**没有 tier、group、frozen 任何字段**。
所以无论怎么改前端，数据源里都没有这些。

### 27.2 做法

1. **删除我另加的按钮**（team-operator-console 客户端包整体移除）。
2. **就地修补 shipped 面板** `dsh-experimental-client-ui-agent-team/lib/client.js`。
3. **新增 `/team meta`**：操作者通道输出 JSON（成员 tier/group/frozen/model +
   全局板/层板/组板及其任务），这是浏览器唯一能拿到分级信息的宿主面。

### 27.3 面板改动（10 处补丁，全部由脚本施加）

D:\\dsh-test\\patch\\patch-console.mjs（幂等，先从 client.js.orig 重建）：

- 让 registerUi 拿到 `remote.commands`，并新增 meta() 动作（注意 Remote 返回的是
  `{ ok, value: { result: { kind, text } } }`，不是扁平的 {ok,text}）。
- TeamAction 增加 meta prop + teamMeta state，随 view 一起刷新。
- 成员不再平铺：**按 tier 分组、组内按 group 分组**，每组一个带色条的标题
  （"级别 1 · 分组 alpha (2)"）。
- 成员卡片加标签：**L0/L1/L2 彩色胶囊**（按级别配色）、**分组名胶囊**、**❄ 已冻结**红色胶囊；
  冻结成员的状态点和状态文案一并变红。
- 名册之后追加**看板总览**：全局板 / L1 / L2 / 各分组板，各带级别分组标签与任务数。
- zh/en 两个字典都补了 tier/group/frozen/boards 等键，中英文都正确。

补丁在写入前用 `new vm.Script()` 编译校验，编译不过就不落盘——避免把 172KB 的
bundle 写坏、连带整个会话头部座位一起挂掉。原始文件备份为 client.js.orig。

### 27.4 验证

- 10 处补丁全部 ok，bundle 编译通过。
- /team meta：单测覆盖（返回可解析 JSON、成员带 tier/group、冻结标记、四种看板、
  tier 0 不产生组板）。
- 实例重启 0 错误；boot manifest 中 agent-team bundle 的 rev 已变化，说明浏览器会重取。
- 多余的 console 按钮已从 manifest 中消失。

**未验证**：浏览器内视觉效果（本环境无法操作浏览器），需要用户看一眼。

---

## 28. 严重缺陷修复：策略层与持久化真相层脱节（"召唤不了"）

**现象**：用户会话里 `spawn_teammate` 报 `teammate name "route-probe" was already
used in this team`，但 `list_agents` 只有 lead，`send_message`/`set_member_route`
报 `unknown-member`。

**根因**：两层存储的持久性不一致。

- **domain 的 team 状态是持久的**：它在 lead session 的 journal 里
  （`session-3a026cf5...json` 第 76 条 seq 明确存着 route-probe/-2/-3，phase=active）。
- **我的 policy 注册表是纯内存的模块单例** `activePolicy()`，没有任何持久化。

我为改 UI 重启了两次实例，于是 policy 失忆而 domain 没失忆：
名字仍被占用（domain 拒重复），但任何 `canSee` 谓词都查不到成员 →
`list_agents` 过滤掉全部、消息被判 `unknown-member`。

这是设计缺陷，不是偶发：**任何一次进程重启都会让已有团队变成幽灵成员。**

### 修复：以 domain 为真相，注册表可重建

1. **可持久化的溯源标记**（team-policy.mjs）：
   `stampDescription/parseStamp/stripStamp`，把 `tier/group/parent` 追加进 domain 的
   `description`（重启后唯一既保留、又归我们写的字段）：
   `probe [v2 tier=1 group=alpha parent=lead]`。
2. **`reconcileRegistry(registry, rows)`**：从 domain roster 补登注册表里没有的成员。
   - 有标记 → 按标记精确恢复 tier/group/parent（约束不被降级）。
   - 无标记（旧数据）→ 按已有的保守策略补为 tier-1 peer，**绝不静默放行**。
   - **只增不删**：caller 的 roster 只是一个 domain team，tier-1 组长与自己的组员同属
     一个 team，缺席不能证明其他组不存在。多算配额是安全方向，忘记活着的成员不是。
3. **接入点**：`team-tools-v2` 的每个工具调用经 `policy()` 时对账；
   `team-operator` 的 `/team meta` 前对账（面板走这条通道）。
4. spawn 时写入标记；`memberView` 用 `stripStamp` 剥掉，模型永远看不到标记。

### 验证

- 新增 `phase4-tests/policy-reconcile.test.mjs`（16 checks，全过）：覆盖标记往返、
  重复标记、重启重建 tier-1/tier-2、重建后约束仍生效（tier2 仍不能给 lead 发消息、
  仍不能 spawn）、旧数据保守补登、部分 roster 不误删。
- 全量回归：phase1–4 共 8 个套件全部 failed=0。
- 重启后实例 0 错误。

**未验证**：真实会话重启后的恢复过程（需要用户在浏览器里跑一轮），单测已精确模拟该路径。

---

## 29. 真正的根因：spawn 授权解析扫全进程（跨会话污染）

用户第二个会话报 `active teammate "route-probe" not found`，而该会话自己的 team
journal `members` 是 `[]`。新会话 spawn 成功了，成员却不在自己的团队里。

### 根因

`rootLead(ctx)` 的实现是错的：

```js
function rootLead(ctx) {
  for (const agent of ctx.agents.list()) {        // 扫描全进程
    const membership = ctx.agentTeams.tryMembership(agent)
    if (membership.role === 'lead') return agent  // 返回第一个遇到的 lead
  }
}
```

一个进程里每个打开的会话都可能有自己的 Team，所以"第一个 live lead"完全可能是
**别的会话的 lead**。于是：成员被登记进别的会话的 team，调用者自己的 team 永远是空的 →
之后所有 `send_message`/`set_member_route` 都报 `active teammate not found`
（domain 的 `resolveActiveMember` 查 `state.members` 查不到）。

这也解释了上一轮的"名字已被占用"——多个会话的 spawn 都落进了同一个 team。

### 修复

domain 的 `tryMembership(agent)` 本来就返回 `{ root, id, role, name }`，
其中 `root` 正是**该调用者所属团队的那个 live lead**。改为按调用者解析：

```js
export function rootLead(ctx, caller) {
  const member = ctx.agentTeams.tryMembership(caller)
  if (member === undefined) return undefined
  if (member.root !== undefined) return member.root
  return member.role === 'lead' ? caller : undefined   // lead 的 root 就是自己
}
```

调用点同步改为 `rootLead(ctx, caller)`。

### 验证

- 新增 `phase4-tests/spawn-authority.test.mjs`（5 checks）：同一进程两个 live lead 时，
  调用者拿到的是**自己的** root；旧实现会返回列表里的第一个 lead，该用例必定失败。
- `team-tools-v2.test.mjs` 的 fake ctx 之前没提供 `membership.root`，与真实 domain 不符，
  已补齐（这本身就是该 bug 能溜过测试的原因）。
- 全量 9 个套件 failed=0，重启后 0 错误。

---

## 30. 修复 description 污染：tier 改存独立文件

第 29 节修好跨会话污染后，最新会话（`session-0db63779`）已完全正常：
`members` 里有 route-probe（phase active）、消息投递成功、teammate 被唤醒并回复。

但暴露了我上一节引入的瑕疵：为了重启可恢复，我把 `tier/group/parent` 追加进了
domain 的 `description`，而 domain 用 description 当**子会话标题**，于是操作者在会话
列表里看到 `probe [v2 tier=1 group=route-probe parent=lead]`。

### 改法

tier/group/parent 不再走 description，改为 policy 自己的持久化文件
（`DSH_HOME/team-registry.json`），description 原样透传。

- `serializeRegistry / mergeRegistry`：注册表的纯 JSON 读写。
  `mergeRegistry` 让**内存中的记录永远优先**于旧进程写下的。
- `attachRegistryStore(registry, path)`：绑定文件并恢复。
- `putMember` 之后 best-effort 落盘；**写盘带归属校验**（`STORE_REGISTRY`），
  避免把另一个 registry 覆盖进同一文件——这个坑是写测试时真踩到的。
- `stampDescription/parseStamp/stripStamp` 保留，用于兼容上一版写下的旧数据。
- `reconcileRegistry` 保留：store 丢了也只是退回保守补登，不会失去可见性。

### 验证

- `policy-reconcile.test.mjs` 增加 6 项：绑定前不落盘、字段完整落盘、
  **模拟重启**（新 registry + 同文件）后 tier/frozen 完整恢复、恢复后约束仍生效、
  store 损坏不抛异常（`checks=all failed=0`）。
- 全量 9 个套件 failed=0；重启后 0 错误。

**注意**：已经写进 journal 的旧 description 不会追溯清理，只有新建的成员标题是干净的。

---

## 31. 首次真实端到端任务：网页版《我的世界》

任务原文："做一个网页版我的世界 要求够还原 游戏性要好 没有bug 功能齐全"，
通过 `dsh --profile teamtest` 起真实会话（脚本 `D:\dsh-test\run-mc-team.cjs`，
产物 `D:\dsh-test\workspace\mc-web`，日志 `mc-run.log`）。

### 31.1 团队建成情况（符合设计）

| 层级 | 成员 |
|---|---|
| L0 | lead |
| L1 | verifier（独立组，不派下属）、engine-lead、gameplay-lead |
| L2 | core-noise / core-world / core-render（engine 组）、fit-player / fit-combat / fit-ui（gameplay 组） |

共 10 人（上限 13）。两个组长各派满 3 人，写范围按组隔离，lead 未改产品代码。

### 31.2 交付与独立验证

- 可玩：`index.html` 直接打开；截图见 `docs/evidence/final-1080p.png`（沙滩/水体/树木/云/第一人称手臂/血量与饥饿条/物品栏）。
- 独立复跑（不是采信它的报告）：`check.js` 25 文件 0 错 0 警告；
  `test-core.js` 473/0；`test-game.js` 175/0；`e2e.js` headless Edge 多档分辨率全绿。
- verifier 三轮独立审查产出了 `docs/reviews/review-1..3.md`，review-3 = 0 blocker / 0 major。
  真实捕获的问题包括："相机矩阵缺失被 catch 静默降级成占位渲染"（自测全绿但完全不可玩）、
  "mesher 与 renderer 区块双重偏移"、"读档后世界空白/玩家无限下坠"、"6.8 万条 WebGL 错误"。

### 31.3 这次测试暴露的 3 个平台 bug（已修）

1. **首个任务调用被误判为非成员**。`team_task_create` / `team_task_list` 只读
   `callerName()` 而不调用 `callerRecord()`，registry 里没有 caller 记录时
   `boardOf()` 返回 undefined，于是 lead 的第一次建任务被拒
   （`only tier 0 may write the global board; "lead" has read access only`）。
   真实后果：lead 全程只能用 `docs/TASKS.md` 代替任务板。
   修复：`callerName()` 改为 `callerRecord().name`，一次覆盖全部 13 处调用点。
2. **board 无法解析时拒绝理由不可读**（`may not write board "undefined"`）。
   修复：`requireBoardWrite` 对 undefined 给出 `owns no board of that kind`。
3. **任务文档携带显式 undefined，违反 lossless JSON**（与 `list_agents` 同一类错误）。
   `boardCreate` 写了 `ownerName: undefined`；`reassign` 到无人时也会留下 undefined。
   修复：无 owner 时**根本不建该键**，reassign 到无人时 `delete`。

### 31.4 回归测试

- team-policy：新增 5 项（新任务无 ownerName 键、JSON 往返不变、reassign 加/删 owner、
  未注册 actor 无板、tier0/tier1 的 boardOf 归属）。
- team-tools-v2：fixture **故意不再预先 seed lead**，并在断言里检查"首次调用前 lead 未注册"，
  以此锁死 bug 1。23 项全过。

---

## 32. 首次真实任务的复盘修复：身份文件 + 面板元数据

### 32.1 面板"未登记级别 (10)"的根因

不是数据缺失，而是 `/team meta` **整个失败**：`team-operator` 在命令入口就用
`operatorOf(agent)` 把所有动词（含读操作 list/meta）挡掉了。meta 返回错误 → 客户端
`teamMeta = null` → 面板把全部成员塞进 tier -1 这一桶，于是全员显示"未登记级别"，
且**静默无提示**。

修复：
1. 只有**控制类**动词（freeze/restore/interrupt/abort/route/spawn）才要求操作者身份；
   `list` / `meta` 是读操作，任何会话都能读。
2. `meta` 的成员列表改为**直接来自 registry**。Domain roster 根本没有 tier 字段，
   依赖它会让面板在"本进程解析不到 live Team agent"时整片降级。
3. 面板新增**身份标签**：`审查员`（tier 1 + group verifier，此前被错误显示为"组长"）、
   `自定义`，其余按 tier 显示 主控/组长/组员。

### 32.2 身份文件（本次主要需求）

`D:\dsh-test\home\team-roles\{lead,verifier,member}.md` —— 三份常驻身份，操作者可直接编辑。
`spawn_teammate` 新增 `role: "lead" | "verifier" | "member" | "custom"`：

- 内置角色**自动钉死 tier 与 group**（verifier → tier1/verifier 组，lead → tier1/同名组，
  member → tier2/调用者所在组），无需主会话重复交代层级。
- 内置角色**自动前置身份文件正文**，`prompt` 只需要写本次任务简报（目标/交付物/验收标准/
  写入范围），省掉每次重写人设的 token。
- `description` 可省略，按角色默认（组长/独立审查组/组员）。
- `role:"custom"` 是逃生口：不给身份，必须自己写完整 prompt（空简报会被拒）。
- 文件缺失时回退到**内嵌身份文本**，角色机制不会因为文件不在而失效。

身份文件的核心是纠正上一轮的两种行为：
- **组长不是执行者**："不要自己写产品代码""组员能做的一律派出去""发现偏离立刻打断"。
- **审查员只找问题**："假设没有什么是完美的""不采信自测结论""只写审查脚本和报告"。
- 组员：只做被派的那一个任务、不扩范围、完成或受阻立刻回报。

### 32.3 主会话纪律

`POLICY` 增加硬性表述：tier 0 与 tier 1 是**调度者不是工人**，产出是被派出去的任务和核对过的
结果，不是产品；并明确"要用 spawn_teammate(role:...) 派身份，不要重述人设"。

### 32.4 回归测试

team-tools-v2 新增 5 项：role lead 钉 tier/组、身份正文前置、description 默认、role member
继承调用者组、custom 空简报被拒。team-operator 改为 3 项：无关会话可 list/meta 但不可控制。
全 9 个套件绿。

### 32.5 诚实记录的未验证项

- `/team meta`-驱动的面板渲染**仍未在真实浏览器里看过**（本环境无法操作 GUI），只做了单测与
  服务端下发校验。
- 上一轮团队"主会话是否直接指挥了 tier 2"**无法从存档确认**：session journal 里没有工具调用明细
  （`send_message` 出现 0 次），headless 日志只记录了 reasoning。这是**可观测性缺口**，
  要真正审计协作行为需要把工具调用落盘。

---

## 33. 按原始计划文档对齐（用户要求：除通信范围外全部按文档）

### 33.1 本次落地的硬约束

| 文档条款 | 改动 |
|---|---|
| §5 / §6 / §132 "0 只与 level 1 双向通信，level 2 只读" | `canMessage` 的 `actor.tier === ROOT_TIER` 分支由 `return true` 改为 `return target.tier === LEAD_TIER`；拒绝理由会指名"route this through <组长>" |
| §7.2.1 全局板**只追加** | `team_task_update` 对 global 板拒绝 `edit` / `delete`（`global-append-only`） |
| §7.2.3 claim 必须声明非空 writeScopes | claim 前查该任务的 `writeScopes`，为空则 `claim-scope` 拒绝 |
| §4.3 冻结成员不占配额 | `canSpawn` 的三处配额计数（maxVerifiers / maxTier1Leads / maxMembersPerLead）全部排除 `frozen === true` |
| §4.3 maxLifetimeCreates | 注册表新增 `maxLifetimeCreates: 26`，`canSpawn` 按"全部历史成员数"拦截，堵死"无限招人再冻结" |
| §5 "任务板写：level 0 = 全局板 + 本组" | `boardOf` 对 tier 0 的 `group` 请求返回 `group-root`（tier 0 无 level 板，`level` 仍回落到 global） |

### 33.2 仍未与文档一致（如实记录）

- **§4.2 事件溯源不变式**：文档要求 level/group/parent/frozen 作为 Team 事件进 Lead Session 日志并由 `invariant.ts` 回放校验。实际存在独立 `team-registry.json`。§19.2 已决策**不整体 fork domain**，因此该不变式被该决策取代。**代价就是两个真相源**——"召唤不了"（§28/§29）与"未登记级别"（§32）都源于此。当前缓解：注册表可重建（只增 reconcile）+ 与会话同一 DSH_HOME 落盘。
- **§7.2.4 claim 时校验写域越界**：只做了"非空"校验，成员写域与任务 writeScopes 的**兼容性**校验未做（需要把 Phase 1 的 write-scope-guard 成员写域接进工具层）。
- **§9.2 新增 Remote 方法**：功能（创建/打断/中止/冻结/恢复/改模型）走 `/team` 命令通道实现，未按文档新增 Remote 方法与面板按钮。形式不同，能力在位。
- **§13 Phase 5 worktree 隔离**：未做（文档标 P2 按需）。
- **§6 与 §5 冲突**：§6 说 tier 0 看"异组下级"禁止，§5 说"查看 roster = 全部"。按 §5 实现（否则面板看不到组员）。

### 33.3 回归测试

team-policy 更新 4 项：lead 只能给组长发消息、不能给 tier 2 发、拒绝理由指名组长、tier 0 的 group 板 = group-root。
team-tools-v2 的 member 用例改为先腾出一个组内名额。全 9 套件绿。

---

## 34. A：fork domain，消灭"两个真相源"

### 34.1 改动（fork 在测试实例内：profiles/web/node_modules/@deepseek-ai/dsh-experimental-agent-team）

| 文件 | 改动 |
|---|---|
| `lib/types/types.d.ts` | （类型）成员快照/视图/请求新增 level、groupId、parentName |
| `lib/invariant.js` | `teamMemberSnapshotSchema` 加同名字段（**该 schema 是 .strict()，不加字段会被直接拒绝**）；不可变字段校验把这些也纳入 |
| `lib/index.js` | `spawnAdmitted` 把请求里的 level/groupId/parentName 写进成员快照；`list()` 投影把这三个字段带出去，Lead 行固定 `level:0 / groupId:'root'` |
| `team-tools-v2.mjs` | spawn 时把 level/groupId/parentName 一起传给 domain |
| `team-policy.mjs` | `reconcileRegistry` 改为**优先读 domain 字段**，description stamp 只作为旧数据兼容；Lead 行不再跳过（domain 现在给了 level 0） |
| `team-policy.mjs` | **删除存储层**：`attachRegistryStore` / `persistRegistry` / `serializeRegistry` / `mergeRegistry` 全部删除，`putMember` 不再落盘 |
| `team-tools-v2.mjs` | 删除 registryPath 与 attachRegistryStore 调用 |
| `roster-helpers.js` + 面板补丁 | 面板**直接读 roster 行上的 level/groupId**，不再依赖 `/team meta` 才能显示级别 |

### 34.2 结果

注册表现在是**纯投影**：每次 `policy()` 都从 Lead journal 的 roster 重建，没有任何自己的状态。
所以"重启后全员未登记级别"这一类故障从结构上不可能再发生（§32 的根因被移除，而不是被绕过）。

### 34.3 验证

- 全 9 个套件按**退出码**校验（不只是找 `failed=` 字样——之前有个套件是崩溃的，
  只搜字符串会误判成通过，这次专门修了验证方法）。
- `policy-reconcile.test.mjs` 的存储测试整段重写为"**光靠 roster 就能重建整棵树**"：
  Lead/组长/tier2 及其 parent 都能重建，重建后可见性一致；没有 level 字段的旧行仍保守收养为 tier-1。
- 删除 `team-registry.json` 后重启实例，干净启动。

### 34.4 尚未完成（本轮剩余）

- domain 里的 `frozen` / `route` 字段尚未加（冻结与改模型目前仍在策略层内存 + 事件通道），
  因此 §4.3 的"domain maxMembers 在册计数排除冻结成员"还没做。
- `/team meta` 通道**保留**：它现在读的是同一份投影（不再是旁路），面板仍用它取冻结与身份标签。
  是否彻底删除待定——删了会丢"审查员/已冻结"标签，除非把这些也加进 domain。

---

### 34.5 真实端到端验证（headless，非单元测试）

跑了一个最小 teamtest 会话（只为验证 fork，不做实际任务）：
用 `spawn_teammate` 召唤 verifier + probe-lead，然后 `list_agents`。

结果：两名成员都创建成功，journal 里两条成员快照都带 `\"level\": 1` 与 `\"groupId\"`
（verifier 组 / probe-lead 组），`list_agents` 回读到的级别与分组正确。

这证明 fork 生效：分级信息**真的**跟着成员快照落进了 Lead journal，
不再是外部文件里的旁路数据。冷启动 / 重启 / 另一个进程读同一个 Team，都能拿到级别。

### 34.6 过程中踩到的两个真 bug（已修）

1. **三份 schema 拷贝，我只改了一份。** `teamMemberSnapshotSchema` 在
   `lib/invariant.js`、`lib/index.js`、`lib/types/projection.js` 各有一份，而且都是 `.strict()`。
   只改 invariant.js 的后果：第一次真实验证直接报
   `persisted Agent Teams team/member payload is invalid`，spawn 全部被拒。
   三份都补上后正常。
2. **用 `read` 全量重写文件会截断文件。** `read` 默认只返回 2000 行，
   `lib/index.js` 有 1894 行——但那次读的是被改后的版本，写回时把文件从 74997 字节截成 51555 字节，
   包直接 import 失败（`Unexpected token ':'`）。已从生产 profile 的同版本原始副本
   （`D:\dsh\home\profiles\web\node_modules\...`，同版本 0.1.5-alpha.2）恢复，
   改用定点 `edit` 重做四处改动。教训：**大文件一律用 edit，不用 read+write 回写。**

### 34.7 与计划的偏差

`/team meta` 通道保留（计划里写的是删除）。原因：它现在读的是同一份 domain 投影，已经不是旁路；
删掉会丢"审查员/自定义"身份标签和"已冻结"标记，除非把这些也加进 domain 成员快照——
那正是下一步 `frozen` / `route` 要做的事。等字段补齐后再删。



## 35. A 续：frozen / route 进 domain，配额语义修正

### 35.1 改动

| 位置 | 改动 |
|---|---|
| 三份 `teamMemberSnapshotSchema` | 新增 `frozen: boolean` 与 `route: {provider, model, reasoningEffort?}` |
| `TeamRoster.updateMember()`（新） | 重写成员快照的**可变**字段（frozen/route），身份字段不变 |
| 服务层 `setMemberFrozen()` / `setMemberRoute()`（新） | 供插件与操作者通道调用 |
| `spawnAdmitted` 配额 | `maxMembers` 计数**排除 frozen**；新增 `maxLifetimeCreates = maxMembers * 2`（=26），冻结不退还创建额度 |
| `list()` 投影 | 带出 `frozen` / `route` |
| `team-tools-v2` freeze_member / set_member_route | **先写 journal**，失败则回滚内存并拒绝（`domain-sync`），不再让内存与 domain 分叉 |
| `team-operator` /team freeze\|restore\|abort\|route | 同样落 journal，失败即报错 |

### 35.2 关键 bug（真实 e2e 才暴露出来的）

**invariant 只允许 `provisioning -> active/failed` 这一条边。** 成员一旦 active，
任何后续 `team/member` 事件都被判为 `invalid active -> active transition`，
所以冻结和改模型**根本写不进去**——而且更糟：`list_agents` 也会连带失败，
整个名册查询被一条坏记录卡死。

修法：允许 `prior.phase === member.phase && prior.phase !== 'provisioning'` 的
"策略更新"事件（身份字段仍必须完全相同），这条同样有**三份拷贝**，三份都改。
并且三份的不可变字段校验都加上了 level/groupId/parentName。

（这个 bug 单元测试抓不到——fake domain 不做状态机校验。只有真跑一个会话才暴露。）

### 35.3 真实 e2e 验证（headless，teamtest profile）

任务：spawn verifier + 组长 -> 冻结组长 -> 给审查员改模型 -> `list_agents`。

结果：5 步全成功。journal 里 `level` x2、`groupId` x2、`parentName` x2、
`frozen` x2、`route` x2、`reasoningEffort` x1；`list_agents` 正确反映"已冻结"。

### 35.4 测试

全 9 套件绿（按退出码校验）。新增回归：
- tools：`freezing a member writes the durable member record`、
  `re-routing a member persists provider, model and effort`、`a non-lead cannot persist a route change`
- operator：`/team freeze persists the durable member record`、`/team route persists the pinned route`

### 35.5 A 剩余

- 删 `/team meta`：字段已齐（level/groupId/frozen 都在 payload 里），可以改了；
  面板的身份标签改为从 `level` + `groupId === 'verifier'` 推导。
- `.d.ts` 类型补 `level/groupId/parentName/frozen/route`（仅类型声明，运行时无影响）。

## 36. A 完成：面板改读 domain payload

- `roster-helpers.js` 的 rosterSections 现在从**成员行本身**推导 `tier/group/role/frozen`：
  `level` -> 层级，`groupId === 'verifier'` -> 审查员，`level 1 -> 组长，`level 2 -> 组员，`frozen` -> 冻结标记。
- 面板不再为了**成员身份**去问 `/team meta`。

**一处与计划的偏差（有意保留）**：`/team meta` 命令本身保留，因为**分级/分组任务板**
还住在策略层，面板要靠它拿到板块列表。也就是说：成员身份 -> 只读 domain payload；
任务板目录 -> 仍走 meta。这是"板子在策略层、成员在 domain"这一现状的直接结果，
要彻底删掉 meta 得先把板子也搬进 domain，那是另一件事。


## 37. B 完成：SoL-Pi 步骤边界压缩

### 37.1 交付物

- `plugins/step-compaction.mjs`（新插件，已注册进 cordis.patch.yml，web/teamtest 两个 profile 同步）
- `phase5-tests/step-compaction.test.mjs`（9 条检查，全绿）

### 37.2 机制

| 环节 | 做法 |
|---|---|
| 触发 | 监听 `tools/result`，只看 `todo_write`，`counts.completed` **上升**才算一个计划步骤完成 |
| 闸 1 窗口压力 | `totalTokens >= contextWindow * pressureRatio`（默认 0.35）；窗口拿不到时退化为绝对阈值 `minTokens` |
| 闸 2 经济性 | 可折叠跨度必须大于 `minSavingsTokens`（默认 20k）——折叠它的收益要能付得起这次摘要调用 |
| 去重 | 每会话 `cooldownMs` 冷却（默认 120s）+ 压缩引擎自身在忙时抛错就跳过，绝不排队压两次 |
| 动作 | `compaction.compactIfNeeded(agent, 'pressure', signal)` |

计划被重写（completed 数下降）时重新基线化，不会被误判成进展。

### 37.3 为什么用 `compactIfNeeded` 而不是 `compactNow`

`compactNow` 要求 agent **idle**，而步骤边界在 DSH 里仍然发生在回合内，调用它必定抛
`ManualCompactionError("busy")`。所以本插件用 `compactIfNeeded`，靠**把阈值调低 +
把触发时机钉在步骤边界**来拿到 SoL-Pi 的效果。

### 37.4 踩到的坑

`inject = ['compaction']` 会让插件永久 `pending`，整个插件树拒绝启动：
`dsh: 1 entry did not activate ... pending (waiting for service: compaction)`。
**改成 `inject = []` + 惰性 `ctx.get('compaction')`**：没有压缩引擎的 profile 只是不压缩，
而不是整个实例起不来。压缩本来就是旁路副作用，绝不该让工具调用或启动失败。

### 37.5 诚实说明

- 阈值（0.35 / 20k / 120s）是**首版取值，尚未用真实长会话校准**。
- 真实会话里是否真的触发过边界压缩，还没有证据——需要一次长任务观测日志确认。
## 38. C 进行中：worktree 拓扑 + 合并门（核心逻辑已完成）

### 38.1 交付物

- `plugins/team-worktree.mjs`（分支拓扑 + 授权 + 合并判定 + 冲突检测）
- `phase5-tests/team-worktree.test.mjs`（22 条检查，全绿）

### 38.2 拓扑（已实现为纯函数）

| 成员 | 集成分支 |
|---|---|
| tier 0 主会话 | `main` |
| 组长 | `team/<group>` |
| 组员 | `team/<group>/<name>` |

worktree 路径把斜杠拍平：`team/alpha/a1` -> `.dsh-worktrees/team__alpha__a1`。
组长和组员**都有**自己的 worktree（全量版，不是最小版）。

### 38.3 授权矩阵（代码强制，测试逐条覆盖）

| 动作 | 允许者 | 拒绝码 |
|---|---|---|
| 组员 -> 组长分支 | **只有派他的那个组长**（比对 parent） | only-the-spawning-lead-may-merge |
| 组长分支 -> main | **只有 tier 0** | only-tier-0-may-merge-to-main |
| tier 0 直接 merge tier-2 成员 | 拒绝（不许越级） | only-the-spawning-lead-may-merge |
| 成员 merge 到 main | 拒绝 | only-tier-0-may-merge-to-main |
| 冻结成员参与合并 | 拒绝 | target-frozen / caller-frozen |

### 38.4 main 的 verifier 闸

clearanceGate(record, commit)：**没有记录**、**记录针对另一个 commit**、
**verifier 报了 blocker 或 major**，三种情况都拒绝；只有针对该 commit 的干净记录才放行。
提交哈希必须对得上，防止拿旧的通过记录过新的代码。

### 38.5 冲突处理

mergeBranch 用 git 退出码判定：干净合并返回新 commit；
退出非 0 且存在 unmerged 文件 -> merge-conflict + 文件列表 + escalate: true；
非冲突型失败（如 unrelated histories）-> merge-failed + 细节。
**任何情况下都不会自动裁决冲突。**

### 38.6 尚未完成

- 把 team_merge / team_worktree_setup 注册成**工具**（现在只有纯逻辑）；
- verifier 通过记录的**持久化**（verifier_report 落盘 + commit 哈希）；
- 插件注册进 cordis.patch.yml 并重启验证；
- 真实 git 仓库的端到端验证（两个组员改相邻文件 -> 互不覆盖 -> 合并后主线同时包含两者）。
## 39. C 完成：worktree 隔离 + team_merge（含一个只有真实 git 才暴露的 bug）

### 39.1 真 bug：git 的 ref 是文件路径，原拓扑不可用

计划里写的是组长分支 `team/<group>`、组员分支 `team/<group>/<member>`。
真实 git 里直接失败：

```
fatal: cannot lock ref 'refs/heads/team/alpha': 'refs/heads/team/alpha/a1' exists;
       cannot create 'refs/heads/team/alpha'
```

因为 `refs/heads/team/alpha` 是文件、`refs/heads/team/alpha/` 是目录，二者不能共存。
**修正**：组长集成分支改用独立命名空间 `grp/<group>`，组员仍是 `team/<group>/<member>`。
这样任何组名、任何成员名都不会碰撞。纯单元测试永远发现不了这个——必须真跑 git。

### 39.2 交付物

- `plugins/team-worktree.mjs`：拓扑 + 授权 + verifier 闸 + 合并判定 + 冲突检测（纯函数，可注入 git runner）
- `team-tools-v2.mjs` 新增 **team_merge** 工具：调用前套授权，dest=main 时套 verifier 闸，冲突时返回文件列表 + `escalatedTo` 而不自动裁决
- **verifier 通过记录落盘**：`verifier_report` 新增 `commit` 参数，写了 commit 才会在 `team-clearances.json` 里留下针对该提交的记录；没有 commit 就没有 clearance
- `phase5-tests/team-worktree.test.mjs`（22 条）
- `phase5-tests/worktree-git-e2e.test.mjs`（**真实 git**，14 条）

### 39.3 真实 git 端到端验证（全部通过）

临时仓库里建 4 个 worktree（两个组员 + 组长 + 审查员），验证：
- 两个组员各改一个文件，**互不覆盖**（a2 的工作区看不到 a1 的改动）
- 两条组员分支依次合入组长分支，**组长分支同时包含两人的改动**
- main 无 clearance 拒绝、clearance 针对别的 commit 拒绝、针对该 commit 的干净 clearance 放行
- 组长分支合入 main 后，**main 同时包含两人的成果**
- 故意制造同文件冲突 -> 检测到 `merge-conflict`、列出冲突文件、标记 escalate，**不自动裁决**
- 授权：派人的组长能合自己的组员；tier 0 不能越级合 tier-2 成员

### 39.4 尚未完成

- `team_worktree_setup` 工具：目前拓扑是算出来的，还没有工具真的去跑 `git worktree add`。
- 大项目的 `node_modules` 不在 worktree 之间共享，有依赖的项目需要各自 install（已知风险）。
## 40. C 完成：worktree 布局工具 + verifier 只读 checkout

### 40.1 交付

- setupPlan()：谁能给谁建 worktree（代码强制）
  - tier 0 -> 组长，落在 grp/<group>
  - 组长 -> **自己的**组员，落在 team/<group>/<name>
  - 审查员 -> **只能给自己**建，且强制只读
- worktreeAdd()：幂等创建；已存在的 worktree 直接复用而不是报错
- **team_worktree_setup 工具**已注册进工具层

### 40.2 只读是怎么保证的

不是靠「不给写权限」（Windows 上不可靠），而是 **detached checkout**：
`git worktree add --detach <path> <commit>`。
审查员能读代码、能跑测试，但 HEAD 是游离的，**没有一个分支可以提交进去**——
这是 git 层面的硬保证，审查员无法「顺手修一下 bug」而绕过只读约束。

### 40.3 验证（真实 git，扩展后的 e2e 全部通过）

- worktreeAdd 真的建出分支 worktree；重复调用幂等（created:false）
- 只读 checkout 的 HEAD 确实是 HEAD（游离），没有可提交的分支
- 非 git 目录被拒绝
- 授权逐条：tier 0 能建组长、组长能建自己组员、跨组组长被拒、
  tier 0 不能越级建 tier-2、**只有审查员能建审查员自己的只读 checkout**

### 40.4 最终状态

- 12 个测试套件全绿（按退出码校验）
- 40123 实例干净启动（HTTP 200）
- 已知未验证：B 的压缩阈值尚未用真实长会话校准；压缩是否真的在真实会话里触发过，还没有观测证据。
## 41. v3 开工：大阶段机制（纯逻辑完成）

计划文档：`D:/dsh/docs/agent-team-v3-plan.md`（含实测基线与全部 10 项）。

### 41.1 第 3 点根因已实证（不是权限问题）

翻了 portal 全部会话：**组长一次 `interrupt_agent` 都没调用过**。它用
`send_message(立即停止当前任务)` 代替打断，还把这次调用标注成「打断组员并冻结其写入范围」。
另一个组长反复纠结「要不要 interrupt A1」，最后选「发消息催」，理由是「interrupt 会丢工作」。

**真相**：`send_message` 投给 running 成员只是投递到最近一步，**不会停止它**。
组长以为停了，组员还在跑——效果上等同于「组长没有打断权限」。所以这是**提示词缺陷**，不是代码权限。

### 41.2 交付：`plugins/team-milestone.mjs`

纯逻辑模块，已被 `phase6-tests/milestone.test.mjs` 覆盖（约 40 条检查）。

| 能力 | 说明 |
|---|---|
| `band(ratio)` | 0.2 起每 0.1 一档；**加了 epsilon 吸收 0.3-0.2 的浮点误差**，否则 0.3 会卡在上一档 |
| `canReadMilestone` | 自己 ✓；tier0 读 tier1 ✓ / 读 tier2 ✗；组长读自己组员 ✓；**下级读直接上级 ✓**；同级：组长跨组 ✓、**组员限同组** |
| `setMilestone` | 含 `doneWhen`（完成判据），不是只写一句阶段名 |
| `markMilestoneDone` | 只有设置者能打勾 |
| `pendingReminder` | 按档位幂等：同一档只提醒一次，涨一档再提醒一次 |
| `shouldCompact` | 打勾 -> `milestone`；未打勾但过 0.75 -> `hard-threshold` 强制压；已压过的里程碑不再触发 |
| `reminderText` | 注入文本，未设置时引导设置，已设置时带上阶段与判据 |

### 41.3 过程中发现并修掉的两个真缺陷

1. **提醒会无限重复**：band 原本挂在 member 记录上，而**第一次提醒恰恰是还没有 member 记录的时候**
   —— 于是 band 无处记录，每一步都会重复提醒。改为顶层独立的 `bands` 映射，与 `members` 解耦。
2. **同级可见范围过宽**：原本 `reader.tier === owner.tier` 就放行，等于任意两个组员跨组互看。
   改为**组员限同组、组长可跨组**（组长跨组本来就要协调接口）。

### 41.4 状态

- 13 个测试套件全绿（按退出码校验）。
- 下一步：大阶段工具 + 权限强制、阈值提醒注入 system prompt、打勾 -> idle -> compactNow、静默上报。
## 42. v3：大阶段接线完成（工具 + 提醒注入 + idle 击发）

### 42.1 交付

| 能力 | 位置 |
|---|---|
| `team_milestone` 工具（set / done / list） | `team-tools-v2.mjs` |
| 持久化 `$DSH_HOME/team-milestones.json` | 同上，模块级懒加载 |
| 里程碑 + 阈值提醒注入 system prompt | 在 `scoped.systemPrompt.section` 的 text 函数里 |
| 打勾上膛 -> idle 击发 -> `compactNow` | `step-compaction.mjs`（**v2 的 todo 触发已废弃重写**） |

### 42.2 关键设计点

- **权限在代码里**：`set` / `done` **没有 target 参数**，所以「设置别人的大阶段」这个动作在调用层面就表达不出来；
  `list` 用 `canReadMilestone` 判定，越权直接 refusal。
- **注入位置选 system prompt 而不是看板**：system prompt 每轮重建，**压缩打不到它**。
  这就是「压缩后不失忆」的实现方式——折叠后 agent 依然知道自己的阶段、完成判据、窗口占用。
- **提醒幂等**：band 存在文档顶层 `bands`，交付即 ack；同一档只提醒一次，涨一档再提醒一次。
- **busy 就跳过，不排队**：`compactNow` 在 idle 但有待办时抛 busy，我们跳过而不是重试，
  保证**唤醒永远不会被摘要调用挡住**。
- **两个插件各自默认 `milestonePath`**：必须指向同一个文件，否则「打勾上膛的文档没人读」。

### 42.3 过程中修掉的一个真缺陷

`team_milestone` 的 output schema 里 `members.items` 没有显式 `additionalProperties`，
`defineTool` 直接抛 `JsonSchemaError`，**两个测试套件全挂**。DSH 的 JSON schema 校验要求
每个 object 都显式声明 `additionalProperties`，嵌套 items 也不例外。

### 42.4 状态

- 13 个测试套件全绿（`milestone` 约 40 条 + `step-compaction` 12 条）。
- 40123 已重启，HTTP 200，日志无 error。
- 下一步：阈值提醒的**静默上报**给上级（不唤醒），然后第 2 点（打断提示词）与第 3-10 点。
## 43. v3：上级可见下级进度 + 打断提示词

### 43.1 一处与计划的**有意偏差**：不上报，改为渲染

计划写的是「阈值提醒触发时把下级上下文**发送**给上级」。实现时发现：

- domain 的 `sendMessage` **没有静默投递**（`wakeup` 只存在于 `dsh-agent-loop` 的 `agent.send`，
  要加得穿透 `mailbox.js` 的投递分支 + **三份** schema 拷贝 + service 类型）。
- 而且发消息就必然唤醒——**正是用户第 7 点抱怨的问题**。

**改用的做法**：把下级与同级的大阶段 + 实时上下文占比**渲染进上级自己的 system prompt**。

好处比发快照更强：
- **零消息、零唤醒**（收件箱不涨，第 7 点自然满足）
- **实时**而不是某个时刻的快照——上级每一轮看到的都是当前值
- 和「大阶段写进 system prompt 防失忆」是同一机制，压缩打不到
- 可见性与 `team_milestone(list)` **完全一致**（复用 `canReadMilestone`），没有新增暴露面

渲染形如：
```
[team progress] eng-a1 (tier 2, group engine): 写入口/帧循环 TICKED — context 42% | ...
```

### 43.2 第 2 点完成：打断提示词

在 POLICY 与 `team-roles/lead.md` 里写死：

- **`send_message` 不会停止任何人**——消息只是插进组员的下一步，它会继续做手头的事。
  在消息里写「立即停止」**等于什么也没做**。
- **要停只有 `interrupt_agent`**。发现偏离、写错文件、在已被否决的方案上死磕——直接打断。
- 附带写明实证：上一项目组长**全程零次 `interrupt_agent`**。
- 但也标了边界：**单纯慢 → 先问；错了 → 立刻打断**，判断标准是对不对，不是快不快。

### 43.3 状态

- 13 个测试套件全绿。
- 40123 已重启，HTTP 200，日志无 error。
- 下一步：第 3 点（交付前核对看板）、第 4 点（同级交流）、第 5 点（审查员合并交付）、
  第 6 点（唤醒收敛）、第 7-8 点（测试规范）、第 9 点（UI 消耗）。
## 44. v3：第 3/4/5/6/7/8 点完成

### 44.1 第 3 点：交付前核对看板 -> 做成确定性检查

新增工具 **`team_delivery_check`**（tier 0 only）：列出**所有未完成**任务，并对每个任务给出判定：

| 判定 | 含义 | 处置 |
|---|---|---|
| `owner-forgot-to-mark-it` | owner 的**大阶段已打勾**，但任务还开着 | 让组长补状态 |
| `work-genuinely-unfinished` | owner 大阶段未打勾 | 返工 |
| `no-owner` | 任务没人认领 | 先派人 |

加上 POLICY 硬规则：**宣布交付前必须调用它**。这把「交付前核对」从一句口号变成一次可复现调用。
（4 条测试：开着任务不可交付 / 已打勾判为漏勾 / 空板可交付 / 非 tier0 被拒 / 无 owner 单列）

### 44.2 第 4 点：同级交流（代码早就允许，是没人告诉他们）

查证 `canMessage`：同级组长跨组 ✓、同组组员 ✓、组员问自己组长 ✓——**代码层一直允许**。
实测 369 条消息里组员↔组员 **0 条**，纯粹是提示词没讲。
已在 POLICY 与 `member.md`/`lead.md` 写明：**同组组员、同级组长直接 send_message**，
并写清边界——**同级可以看、可以聊，但不能互相打断**。

### 44.3 第 5 点：审查员统一交付

`verifier.md` 新增一节：**拒绝零散交付**——组长改一行就来找你一次，会让你被反复唤醒且永远审不出全局问题。
正确流程写死：**等各组跑完并互相沟通完 -> tier 0 统一交付 -> 一次性审完 -> 一份汇总清单发回组长**。

### 44.4 第 6 点：唤醒收敛

写清**什么才值得唤醒上级**：契约变更、范围冲突、交付判断、真卡死。
**不报流水账进度**——上级每一轮都能在自己的 `[team progress]` 里看到下级与同级的大阶段和上下文占比。

### 44.5 第 7、8 点：测试规范写进角色文件

三个角色文件都加了：
- **截图**：1920x1080、多角度多距离（走近/退后/侧面/俯视）、**逐处看**、**玩家视角**判断好不好看。
- **玩家式测试**：真实点击 UI、各种走路方式（前后左右/斜向/贴墙/跳跃）、各种鼠标移动（慢移/快甩/转圈）、
  专门猎杀**方向反了**、检查**边界情况**（地面上/墙面上的门、不同高度角度速度）。
- 三处都附上了上一项目**实测漏掉的具体案例**（远看黑洞、近看放大、走地上的门卡进虚空），
  让标准有据可依而不是空话。

### 44.6 状态

- 13 个测试套件全绿。
- 40123 已重启，HTTP 200，日志无 error。
- 剩余：**第 9 点（面板显示全部代理 token 合计）**，以及一次真实的端到端验证。
## 45. v3 第 9 点：全团队 token 统计（服务端完成）

### 45.1 为什么不能直接复用现有 pill

底部两个 pill（`TimePill` / `UsagePill`）的数据来自 `useProjection("tokenUsage")` —— **session projection 是按会话的**，
而 DSH **没有跨会话聚合 API**。所以主会话的 pill 只反映主会话自己，实测只占真实消耗的 **14.7%**。

projection 的 `apply(state, event)` 只吃当前会话的事件流，天生做不了跨会话汇总。

### 45.2 交付：`plugins/team-usage.mjs` + `/team usage`

直接读 **session journal** —— 那是每个 agent 用量唯一被持久记录的地方：

- `decodeJournal()`：**多帧 zstd 解码**（每次 append 是一帧，一次性解压器只返回第一帧，所以按 magic 逐帧定位）
- `readSessionUsage()`：从 `assistant/message` 的 `usage` 累加，从 session 头读 `parentSession`，从 descriptor 读 label
- `collectTeamUsage()`：**沿 parent 链走**出整个 Team，而不是列目录（自动排除无关会话与别的 Team）
- `summarizeTeamUsage()`：合计 + 主会话占比 + 其它占比

命令：**`/team usage`** —— 输出 agent 数、总量、主会话占多少、其它占多少、缓存量，以及每个 agent 一行明细。

### 45.3 用**真实数据**验证（这次不是合成数据）

模块跑 portal 项目真实 journal：
```
real portal project: 14 agents, total 248,749,350 tokens
                     (lead 36,467,784, others 212,281,566)
```
与早先**独立用另一个脚本**统计出的数字**逐位一致**。合成数据测试另覆盖：多帧解码、parent 链走树、排除无关会话、排除别的 Team、缺目录可生存。

### 45.4 状态与剩余

- **14 个测试套件全绿**（新增 `team-usage`）。
- 40123 已重启，HTTP 200，日志无 error。
- **剩余**：客户端 pill —— 要在 `dsh-client-ui-chat` 的 `StatsPills` 里**再加两个 pill**（和现有两个同形），
  数据源走 `/team usage`。这需要一个客户端 patch 脚本（和 team 面板同样的做法）。
  服务端数据已经完全就绪且已验证，客户端只是展示层。
## 46. v3 第 9 点：客户端 pill（进行中）

### 46.1 已完成的准备

- 定位到实现：`dsh-client-ui-chat/lib/client.js` 里 `StatsPills`（约 4079 行），
  它通过 slot `conversation.composer.dock` 注册（约 8351 行，`ctx.slots.register`）。
  两个 pill：`TimePill`（轮/步 + tok/s）、`UsagePill`（总量 + 缓存命中）。
- **客户端包 shadow 到 profile**：`profiles/web/node_modules/@deepseek-ai/dsh-client-ui-chat/`（75 个文件），
  `.orig` 已备份，**可回滚**。这样只影响测试实例 40123，**不碰 app/node_modules，生产 39123 不受影响**。
- 已验证 shadow 后实例仍干净启动（HTTP 200，日志无 error）。

### 46.2 卡住的地方（下轮要解决）

`dsh-client-ui-chat` 的客户端插件**没有用 `ctx.remote` / `commands.execute`**，
所以不能像 team 面板那样直接调 `/team usage` 拿数据。

两条候选路径：
1. **注册一个 session projection** `teamUsage`：服务端插件在 `turn/end` 时算出全团队合计并
   `append` 一个自定义事件到 root lead session；客户端用**已有的** `useProjection("teamUsage")` 读。
   不需要 remote，更贴近 DSH 原生机制。
2. 查清 chat 客户端插件的依赖注入方式，看能否拿到 remote。

倾向路径 1。注意 `StatsPills` 的 props 目前只有 `{ useChat, useProjection, t }`，
所以新 pill 的数据要走 projection 而不是 prop。

### 46.3 状态

- 14 个测试套件全绿（本轮未改代码逻辑）。
- 40123 已重启，HTTP 200，日志无 error。
## 47. v3 第 9 点客户端：路径已打通，剩实现

### 47.1 已验证的前置事实（下一轮可直接开工）

| 事实 | 结论 |
|---|---|
| projection schema 格式 | **zod**：`import { z } from "zod"`，profile 的 node_modules 里**有 zod** |
| 注册 API | `ctx.sessionProjections.register({ key, stateSchema, init, apply, wire: { viewSchema, view } })` |
| `apply(state, event)` | 按事件流更新 state，读 `team/usage` 自定义事件即可 |
| 客户端读取 | `useProjection(key)` 读 `wire.view` 的结果，**不需要 remote** |
| `StatsPills` props | `{ useChat, useProjection, t }`——走 projection 而不是加 prop |
| 注册 slot | `conversation.composer.dock`（`ctx.slots.register`，约 8351 行） |
| 客户端包 | **已 shadow 到 profile**，`.orig` 已备份可回滚 |

### 47.2 具体实现步骤（下一轮）

1. 新建 `plugins/team-usage-projection.mjs`：注册 `teamUsage` 投影。
2. 在合适时机（root lead 的 `turn/end`）算全团队合计（复用 `team-usage.mjs`），
   `append('team/usage', {...})` 到 root lead session。
3. Patch shadow 的 `StatsPills`：`useProjection("teamUsage")` + 渲染两个与现有同形的 pill。
4. 写 applier 脚本（参照 `patch-console.mjs`，用 `new vm.Script(src)` 做编译校验）。
5. 重启 40123 验证启动干净；**视觉效果需用户刷新确认**（我看不到 GUI）。

### 47.3 本轮状态

- 14 个测试套件全绿；40123 HTTP 200，启动无 error。
- 除了第 9 点的**客户端展示层**，v3 其余全部完成。
## 48. v3 第 9 点完成：全团队消耗出现在聊天栏

### 48.1 服务端：`teamUsage` 投影

`plugins/team-usage-projection.mjs`：
- 用 **zod** 定义 view schema，注册 `key: 'teamUsage'` 的 session projection
- 监听 **Lead 的 `agent/status -> idle`**，此时把全团队 journal 求和并
  `agent.session.append('team/usage', view)` 到主会话
- projection 的 `apply` 把该事件变成 view，客户端用**已有的** `useProjection("teamUsage")` 读
- **不给子代理算**：它们的 turn 频率远高于任何人需要重读总量的频率，而 Lead 的数字已经含它们

### 48.2 客户端：shadow 包 + patch

- 把 `dsh-client-ui-chat` **shadow 到 profile**（`.orig` 已备份，可回滚），只影响 40123
- `patch/patch-usage-pills.mjs` 三步 patch：
  1. 在 `UsagePill` 前插入 `TeamTotalPill` / `TeamOthersPill`（复用同作用域的 `formatTokens` / `formatCacheHitPercent`）
  2. `StatsPills` 里加 `const teamUsage = useProjection("teamUsage")`
  3. 在现有 UsagePill 之后渲染两个新 pill（保留 `})` 与 `]`，只插入两个元素）
- patch 用 `new vm.Script(src)` 做编译校验后才落盘

新 pill 文案（英文前缀，避免动 i18n 键）：
```
ALL 14 / 248.7M / 98%          <- 全团队总量 + 缓存命中率
OTHERS 85% / 212.3M            <- 子代理占多少（即旧 pill 隐藏掉的那部分）
```

### 48.3 过程中修掉的两个真缺陷

1. **projection 注册缺 `stateVersion`**：报 `stateVersion must be a non-negative integer, got undefined`，
   **整个插件树启动失败**。补 `stateVersion: 1`。
2. **applier 的 C 步把 `})]` 整个删掉了**：原本要在 `})` 和 `]` 之间插两个元素，
   第一次写成整体替换，导致语法错误。改为保留两端、只在中间插入。

### 48.4 未验证项（诚实记录）

- **pill 的视觉效果没有验证**——我看不到 GUI。已验证的是：patch 编译通过、实例干净启动、
  HTTP 200。**需要用户在 40123 上刷新确认显示**。
- **projection 在真实会话里的触发没有观测到**：需要跑一次真实任务，让 Lead 进入 idle，
  才会 append `team/usage`。在此之前 pill 不显示（`teamUsage === null` 时整段跳过，不会报错）。

### 48.5 v3 总状态

8 项全部实施完成：大阶段机制与压缩、打断提示词、交付核对、同级交流、审查员合并交付、
唤醒收敛、截图与玩家测试规范、全团队消耗显示。15 个测试套件全绿。
## 49. 严重回归：`cannot get property "tokenMeter" without inject`（已修）

### 49.1 症状（用户实测发现）

新会话**每次运行都失败**：红色报错 `本轮运行失败: cannot get property "tokenMeter" without inject`，
Agent Team 面板显示「未知错误」。**启动日志完全干净**——所以我的「HTTP 200 + 日志无 error」验证**漏掉了它**。

### 49.2 根因

`team-tools-v2.mjs` 的 `systemPrompt` text 函数里读了 `ctx.tokenMeter`，
但 `inject` 列表是 `['agents','agentTeams','tools','systemPrompt']`——**没有 tokenMeter**。
cordis 里读取未声明属性会**抛异常**（不是返回 undefined），而 text 函数每次组装 system prompt 都跑，
于是每一轮都失败。`step-compaction.mjs` 也有同样问题（它 `inject` 是空数组）。

这是**我第二次踩同一个坑**：之前 `inject: ['compaction']` 让插件永久 pending，我改成惰性 `ctx.get()` 修好了，
但**没有对 tokenMeter 做同样处理**。

### 49.3 修法与验证

- 新增 `serviceOf(ctx, name)` helper：走 `ctx.get(name)` 并 try/catch，
  缺服务退化成「没有测量」而不是「这一轮失败」。两处调用点 + `step-compaction` 都改掉。
- **这次跑了真实会话验证**（不再只看启动日志）：
  - `team_milestone(set)` + `team_milestone(done)` 两次调用**都成功**
  - `team-milestones.json` 正确落盘（stage / doneWhen / done / doneAt 齐全，`bands` 为空=未到 0.2 阈值）
  - 日志无 `inject` / `ReferenceError` / `TypeError`

### 49.4 教训

**「启动干净」不等于「能跑」。** cordis 的未声明属性访问在**运行时**才抛，
所以服务端插件的正确验证必须包含**一次真实会话**，而不是只看 HTTP 200 和启动日志。
## 50. 三个修复：action-fusion 真正生效、ALL 数字、Evidence 澄清

### 50.1 action-fusion 从「空转」变成「真在跑」

**问题**：`rules: []` —— 装了但一次没跑过。而且就算配了规则也跑不起来，两个原因：

1. **cwd 用错了**：`const cwd = config.cwd ?? process.cwd()` —— 用的是 harness 启动目录，
   不是被改文件所在的项目。配了规则也会检查错误的树。
   -> 新增 **`projectRoot(filePath)`**：从被改文件往上找最近的 `package.json` / `.git`，
   作为命令的工作目录。
2. **没有占位符**：命令是固定串，无法只校验改动的那个文件。
   -> 新增 **`{file}` 替换**，规则可写成 `node --check "{file}"`。

**还踩到一个静默坑**：`matchRule` 只对 `/.../ ` 形式走正则，**裸字符串只做子串匹配**。
最初的 `'\.(js|mjs|cjs)$'` 看着像正则，实际是子串 —— **静默不匹配**。
改用 `'/[.](js|mjs|cjs)$/'`（字符类避开反斜杠转义）。

**配置**（`cordis.patch.yml`）：
```yaml
rules:
  - match: '/[.](js|mjs|cjs)$/'
    command: 'node --check "{file}"'
    timeoutMs: 20000
shell: 'none'
```

**验证**：真实会话里 write 一个故意语法错误的 `broken.js`，会话日志中出现
`SyntaxError: Function statements require a function name` + `checkSyntax` 堆栈——
**确认验证块被融进了 write 的结果**。另有 8 条新单元测试（`action-fusion-file.test.mjs`）。

### 50.2 `ALL` 数字小于主会话（用户发现）

**根因**：`teamUsage` 是 **Lead 进入 idle 时的快照**，而主会话的 pill 是**实时** projection。
所以 `ALL`（快照合计）可能小于主会话**当前**值——截图里 236.6k < 258.7k。

**修法**：`ALL = 主会话实时值 + 子代理快照值`，即客户端用
`billedInputTokens(usage) + usage.outputTokens + teamUsage.otherTotal`。
这样 `ALL >= 主会话` 恒成立。子代理部分仍是快照，但不会再出现"总数比其中一项还小"。

### 50.3 Evidence-Preserving Reducer 的澄清

**它不是独立插件**，是 `observation-pack.mjs` 内置的 `selectEvidence()`
（`evidenceChars` 默认 1500，证据模式 error/fail/panic/exception/timeout/denied/cannot/undefined…）。
`observation-evidence.test.mjs` 测的就是 observation-pack 的这个子能力。**随 observation-pack 生效**。

所以准确说法是：**SoL-Pi 4 个机制里做了 3 个，2 个独立插件；
到本轮为止 action-fusion 才真正跑起来。**
## 51. 回归：底部计费区整体消失（已修）

### 51.1 症状

用户截图：底部状态栏**完全空白**——轮/步、tok/s、token 总量、缓存命中、新增的 ALL/OTHERS 全部不见。

### 51.2 根因（我的 patch 脚本 bug，不是 DSH 的）

patch 后的代码是：
```js
function TeamTotalPill({ usage, lead, t }) {
  const totalText = t(..., formatTokens(all, t));   // all 未定义
```
**`const all = lead + usage.otherTotal;` 整行消失了。**

原因：我在 applier 里把**注释和代码写进同一个字符串**，用 `\n` 分隔。
写入文件后那是**字面的反斜杠+n**，不是真实换行——于是 `//` 把**它后面的那行代码也注释掉了**。

`all` 未定义 -> `TeamTotalPill` 抛 `ReferenceError` -> React 卸载整个 `StatsPills` -> **整排 pill 消失**。

### 51.3 关键教训：编译检查抓不到这个

`new vm.Script(src)` **通过了**——因为被注释掉的代码语法完全合法。
**语法校验无法发现「代码被静默吞掉」**。

所以 applier 必须：
- 注释**自成数组元素**，绝不与代码混在一个字符串里
- 生成后**静态核对关键语句存在**（本次补做：`const all` / `const teamUsage` / 各 helper 均确认有定义）

### 51.4 处置

1. **立刻回滚**客户端包（`client.js.orig` -> `client.js`，370093 字节，零残留）并重启，先恢复可用。
2. 修 applier 的注释写法，重新应用。
3. 核对生成代码：`const all` 已回到 `TeamTotalPill` 内，渲染表达式与全部引用标识符均确认存在。
4. 实例重启，HTTP 200。

### 51.5 仍未验证

**pill 的视觉效果我看不到 GUI**，只能确认：代码生成正确、标识符齐全、实例干净启动。
需用户刷新确认。**如果再次空白，说明还有别的运行时问题，我会直接放弃改客户端、改用服务端方案。**
## 52. 严重：自定义 session 事件让会话历史无法读取（已清理）

### 52.1 症状

用户打开会话时报：
```
failed to observe session "session-e5adf9ae-...":
contains event type "team/usage" (seq 197) unknown to this harness and not marked ignorable;
refusing to interpret the log
```
**整个会话历史打不开。**

### 52.2 根因（我的设计错误）

`team-usage-projection` 为了让客户端能读到全团队消耗，用
`agent.session.append('team/usage', view)` **往 session journal 里写了一个自定义事件类型**。
DSH 的日志解释器**只接受已知事件类型**（未标记 ignorable 的未知类型直接拒绝解释整个日志）。

**这是把「展示一个统计数字」的代价，付成了「损坏会话历史」。**

### 52.3 处置

1. **立刻禁用** `team-usage-projection`（`disabled: true`，两个 profile 同步），停止继续污染。
2. **扫描**全部会话（测试实例 + 生产实例，解压后搜明文）：找到 **6 个受污染会话**，
   生产实例 **0 个**。
3. **清理**：逐帧解压 -> 删掉含 `"team/usage"` 的行 -> 逐帧重新压缩 -> 写回。
   每个文件先备份为 `.pre-teamusage.bak`。共移除 **29 个**事件。
4. **验证**：6 个会话全部可解码、**零坏 JSON**、`team/usage` 已消失；
   主会话 `session-e5adf9ae` 现为 782 个事件，类型全部合法。
5. 确认全仓库插件里**只剩这一处**写 session 事件，且已禁用。

### 52.4 教训

- **绝不往 session journal 写自定义事件类型。** 会话日志是 harness 的schema 化契约，
  不是应用层的便签本。要跨会话传数据，读文件（`/team usage` 那样）或走 remote，不要写日志。
- 一种**看起来最优雅**的方案（用 projection 把数据送到客户端）恰恰是唯一会**破坏持久数据**的方案。
  以后再想走 projection，必须先用一份**临时会话**验证「写完还能读」。

### 52.5 顺带：名额提到 16

`maxMembers: 13 -> 16`（用户要求）。配合「failed 不占名额」的修复，
派发失败不再吃名额，且上限本身更宽松。

### 52.6 未恢复的部分

被删掉的只是 `team/usage` 这一种事件——**其余事件一条没动**，所以会话内容（对话、工具调用、任务、成员）完好。
pill 功能暂时关闭（插件已禁用），`/team usage` 命令仍然可用（它只读文件）。
## 53. 唤醒错层：所有成员都挂在主会话下（已修）

### 53.1 症状（用户报告）

主会话**老是被组长、甚至组员唤醒**；组长也被组员频繁唤醒。
用户的要求：只有**上级主动发的消息**才应该唤醒他。

### 53.2 根因（两层，缺一不可）

**第一层：domain 把 subagent 的 parent 硬编码成 Team root。**
```js
request: { prompt: request.prompt, parent: root }   // 永远是主会话
```
于是每个成员（含组员）都是主会话的 subagent 子节点，
**任何成员结束一轮或需要输入，唤醒的都是主会话**。

**第二层：我的工具层把 caller 永远解析成 root lead。**
```js
const lead = rootLead(ctx, caller)
await ctx.agentTeams.spawnTeammate(lead, {...})   // 无论谁调用，都是主会话
```
所以只改第一层的 `parent: caller` **没有效果**——`caller` 本来就是主会话。

### 53.3 修复（关键是分清两件事）

| 关注点 | 用什么 |
|---|---|
| **授权** | 必须仍是 **Lead**（domain 只允许 Team Lead 创建成员） |
| **subagent parent** | 必须是**实际派发者**，由 `parentName` 解析 |

1. `team-tools-v2` 恢复 `spawnTeammate(lead, ...)`（授权用 lead），
   `parentName: owner`（owner 是真实调用者）保持不变。
2. domain 的 `spawnParent(root, name)`：从 `parentName` 解析出**在世的派发者 agent**，
   作为 `request.parent`；解析不到才退回 caller。

**实测验证**（新建会话）：
```
session-4eab64        (主会话)
f0daa29c  组长  parent=session-4eab64     ✓
d220e811  组员  parent=f0daa29c (组长)     ✓✓
```
组员现在挂在**组长**下——层级链正确了。

### 53.4 中途踩的两个坑（都已修）

1. **先试了 `spawnTeammate(caller, ...)`** —— 立刻炸出 `only the Team Lead can create teammates`，
   **组长完全不能派组员了**。这说明 domain 的授权本来就只给 Lead，
   也正是我把 caller 解析成 lead 的**原始原因**。教训：授权与父子关系是两件事，不能用一个参数兼顾。
2. **`spawnParent` 落在 `TeamRoster` 类里，却写成 `this.roster.tryMembership`** —— 
   `TeamRoster` **自己就是** roster，`this.roster` 是 undefined，
   导致 `Cannot read properties of undefined`，成员创建全挂。改成 `this.tryMembership`。

### 53.5 仍未解决：turn 结束也会唤醒上级

parent 修好后，**唤醒对象对了**（组员唤组长、组长唤主会话），
但 **continuable subagent 在结束一轮时仍会通知 parent**，
而不只是「下级主动 send_message」时。用户要的是后者。
这是 DSH subagent 的机制（日志里可见 `ContinuableActivationRegistry.settlementState`），
**本轮未处理**，需要进一步看能否关闭结束通知。
## 54. 会话修复的正确做法：ignorable，不是删事件

### 54.1 我上一轮的错误

删掉 team/usage 事件后：
1. 先报 **seq gap**（删行造成序号空洞）
2. 重新编号后，又报 **sourceEventSeqs ranges must contain unique earlier seqs**

因为**事件内部用 sourceEventSeqs 引用其他事件的 seq**，删事件 + 重新编号**破坏了这些引用**。

### 54.2 正确做法

dsh-session-persistence/lib/index.js:184：

    if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) throw unsupported(...)

**未知类型只要带 ignorable: true 就会被接受。**

所以**根本不该删事件**——从 .pre-teamusage.bak 恢复原始字节（seq 与所有 sourceEventSeqs 天然自洽），
只给 team/usage 事件加一个 ignorable: true。

### 54.3 验证

    OK  session-e5adf9ae  events=803 firstSeq=0 gaps=0 badJson=0
                        teamUsage=21 ignorable=21 srcRefs=54 srcBad=0

6 个会话全部通过：**序号连续、JSON 合法、21 个未知事件全部标记、54 个 sourceEventSeqs 引用零错误**。

### 54.4 两层教训

1. **绝不往 session journal 写自定义事件类型。**（第一次错误）
2. **修数据时不要删行**——日志里的序号和交叉引用是一个整体；
   能靠**标记**解决的（ignorable）就不要靠**删除**。删一个字段要连带修它的所有引用。

备份 .pre-teamusage.bak 全部保留。
## 55. 唤醒来源查清：`subagent-settled`（改不动，已回滚）

### 55.1 根因（实测数据）

解析用户会话 `session-e5adf9ae` 的主会话收件箱：

    inbox splices: 64
    splice sources: { user: 2, subagent-settled: 26, team-message: 6 }

**26 条 `subagent-settled`**，内容形如：
`Background subagent xxx finished and will do no further work unless you send it more.`

来源：`dsh-subagent/lib/index.js` 的 `notifySettlement()`：

    const message = createSettlementMessage(activation.childId, terminal);
    if (this.closingTeardownFor(parent) !== undefined) {
      parent.inject(message);          // 只入收件箱，不唤醒
      return;
    }
    this.sendWaking(parent, message, ...);   // 唤醒 <- 正常路径

`closingTeardownFor` 只在父会话关闭时成立，**正常情况一律唤醒**。

### 55.2 尝试与结果：shadow 核心包不可行

把 `dsh-subagent` shadow 到 profile，改成「team 成员之间用 `inject` 不唤醒」。

**实测失败**：mini 会话 `exit=1`，报 
`ContinuableActivationRegistry.settlementState` 错误，**spawn 全挂**。
已**完整回滚**（删除整个 shadow，恢复 `lib/index.js`），再次验证 spawn 正常（exit=0）。

**教训：`dsh-subagent` 是 DSH 核心包，shadow 它的风险远大于收益。**
（shadow 客户端 `ui-chat` 是可行的，shadow 服务端核心包不可行——调用点多、版本敏感。）

### 55.3 当前的净改善

`parent` 修复（§53）已经让层级正确：
- **修复前**：所有 13 个成员的 settled 都发给主会话 -> **26 条**
- **修复后**：组员的 settled 发给组长，主会话只收 4 个组长的 -> **约 4-8 条**

这是实质改善，但**没有完全满足**用户「只有主动 send_message 才唤醒」的要求。

### 55.4 未解决

组长结束一轮仍会唤醒主会话。这是 DSH subagent 的设计语义
（「后台子代理干完了」），**无配置项可关**。
要彻底消除只能改 DSH 核心包，而本轮的实测证明**那条路会把 subagent 机制弄坏**。
## 56. 唤醒问题：解决（改 app，不是 shadow profile）

### 56.1 上次失败的真实原因：双实例

我把 dsh-subagent shadow 到 `profiles/web/node_modules/`，结果报错：

    agent cannot read inbox state: its projection registration is not active
    at settlementState (profiles/web/.../dsh-subagent/lib/index.js:1196)

报错在 **settlementState**，一个**我根本没改的函数**。这说明 `activation` 对象
不是这个副本创建的——**同一个包被加载了两份**：

- core 从 `app/node_modules` 解析 -> app 副本
- 而 profile 里的插件从 profile 解析 -> profile 副本

两个副本各有自己的 `resident` Map 和内部类，字段对不上。
**这是模块解析的结构性后果，不是代码写错。**

### 56.2 正确做法

**测试实例用的是 `D:\dsh-test\app`，生产用的是 `D:\dsh\app`**（启动命令里写明）。
所以**直接改测试实例的 app 副本**，只影响测试实例，且**只有一份实例**。

这与 domain fork 是同一个思路：改测试实例自己的 checkout，不动生产、不做 shadow。

改动位置：`D:\dsh-test\app\node_modules\@deepseek-ai\dsh-subagent\lib\index.js`
的 `notifySettlement()`——在 `sendWaking` 之前插入：team 成员之间改用 `parent.inject(message)`
（**入收件箱但不唤醒**），非 team 的 subagent 行为不变。

撤销方法写在 `D:\dsh-test\REVERT-dsh-subagent.md`。

### 56.3 验证

| 检查项 | 结果 |
|---|---|
| 组员的 parent | `2aede344` -> `11607eda`（**组长**）✓ |
| 主会话 inbox | `{user:1, team-message:1}`，**无 subagent-settled** ✓ |
| 干净运行退出码 | **exit=0** ✓ |
| 成员创建 | 成功（tier 2、group、parent 均正确）✓ |

（中途一次 exit=1 是**被中断的旧会话**残留的清理错误，路径指向更早运行的子代理，
重跑干净会话后 exit=0，与本次改动无关。）

### 56.4 教训

**shadow 一个被多处 import 的库，必然产生双实例。**
要改这类库，应该改**该实例自己的 checkout**（测试实例的 app），而不是往 profile 塞副本。
—— 我上一轮因为一次失败就说「这条路不通」，判断下早了；
真正的原因是**方法选错**，不是目标不可达。
## 57. 「冻结不了」复核：机制正常，是那个会话的 Team 状态为空

### 57.1 实测（新会话，当前代码）

跑了一次全新的 headless 会话：

1. spawn_teammate(role=lead, name=z-lead) -> 成功
2. list_agents -> 返回 lead、z-lead
3. freeze_member(target=z-lead) -> **成功**：{"target":"z-lead","frozen":true,"previous":false}

**所以冻结机制本身没有问题。**

### 57.2 那个会话的实情

`session-e5adf9ae` 的 journal 里：
- `team/member` 事件 **26 个完整存在**（lead-a/b/c、verifier、match3-dev、c-art…）
- 但主会话调 list_agents / freeze / send_message 时，**这些名字全部 unknown-member**

链路：`TeamJournal.state(root)` -> `sessionProjections.stateOf(root.session, 'agentTeam')`。
**Team 状态是 session projection，从事件流重放出来的**——journal 里的事件在，但**投影状态是空的**。

### 57.3 最可能的原因

**我重建过那个 journal**（为了摘掉 team/usage 事件）。虽然事件内容逐条保留、seq 连续、JSON 合法，
但 journal 还有 **committed / v2 row** 这类元数据（早先的报错里出现过 `released v2 row 197`）。
重建时**每事件压成一帧**，很可能**丢掉了提交元数据**，于是：

- DSH 的**对话历史**能读（事件本身在）
- 但 **projection 重放**拿到的成员是空的

**即：我为了修一个错误，引入了另一个错误。**

### 57.4 现状与建议

- 那个会话的**对话历史可读**，但**Team 名册已无法恢复**（成员是谁、什么级别都丢了）。
- **建议：在那个会话里重新组队**（重新 spawn），或开一个新会话。
- `.pre-teamusage.bak` 仍保留，但恢复它会让会话**打不开**（team/usage 会再次触发拒读），所以不建议。

### 57.5 教训

**动 journal 之前必须先在副本上验证「改完还能被 projection 正确重放」，
而不只是「JSON 合法、seq 连续」。**
我当时的验证只覆盖了后者，所以漏掉了这一层。
## 58. 「冻结不了」真正根因：registry 重建从未成功过（已修）

### 58.1 更正 §57 的错误诊断

§57 我判断「那个会话的 Team 名册空了」——**错了**。用户的面板截图显示：
级别 0/1/2、四个分组、**13 个成员全部在位**（含 c-art 显示为「失败」）。
**Domain 的 roster 一直是完整的。**

### 58.2 真正的根因

`team-tools-v2.mjs` 的 `policy()`：

    reconcileRegistry(active, ctx.agentTeams.listMembers(agent))

而 `reconcileRegistry(registry, rows)` 要的是**registry 对象**。
服务对象暴露的是 **`registry` 属性**（`team-policy.mjs` 第 531 行 `registry,`），
传 `active` 本身 -> `active.members` 是 undefined -> **每次调用都抛 TypeError**
-> 被 `catch {}` **静默吞掉** -> **registry 从未被 Domain roster 重建过**。

于是 `list_agents` 正常（它直接用 Domain 数据），
而 `freeze_member` / `send_message` 等一切查 registry 的操作**全部 unknown-member**。

### 58.3 为什么测试一直没抓到

`team-tools-v2.test.mjs` 的 fixture **手动 `P.put()` 了每一个成员**，
所以 registry 里有名字，**从来不需要重建**——断言自然全绿。
**测试把 bug 掩盖了。**

### 58.4 修复

1. `reconcileRegistry(active.registry, ...)`（属性，不是服务对象）
2. **不再静默吞错**：catch 里 `logger.warn` 出原因——这次就是静默吞错让一个完全失效的路径藏了很久
3. **新增回归测试**：造一个**只存在于 roster**（从不手动 put）的成员，
   断言它能被 `freeze_member` 寻址——修复前必失败

### 58.5 影响面

这条路径是「重启后从 Domain 恢复 tier/group」的唯一机制。
它从未工作，意味着**任何依赖 registry 的功能在真实会话里都是坏的**：
freeze / restore / route / 可见性判定 / 板子归属。
（`spawn` 之所以看起来正常，是因为它 spawn 时直接 `putMember` 写进了内存。）
## 59. 严重：把动态数据放进 system prompt，缓存命中率崩塌（已修）

### 59.1 症状（用户发现）

缓存命中率从 ~99% / 74% 掉到 **36% / 60%**，消耗翻了十几倍。

### 59.2 根因：我在 system prompt 里放了每轮都变的数据

v3 的 `[team progress]` 段渲染了**每个下级与同级的实时上下文占比**：

    eng-a1 (tier 2, group engine): 写入口/帧循环 TICKED — context 42%

这个百分比**每一轮都不同**。而 **system prompt 就是 KV 缓存的前缀**——
**只要有一个字节变化，整段前缀缓存全部失效**，那一轮就要按全价重算整个 prompt。

更糟的是 `[team progress]` 还会列**所有成员的大阶段**：任何成员的大阶段一变，
它的每一个上级的 prompt 都变。13 人团队里这非常频繁。

我当时的设计理由是「system prompt 每轮重建，压缩打不到它，所以最可靠」——
**只看到了「打不到」，没看到「它正是缓存前缀」**。

### 59.3 修复

**把 `[team progress]` 整段从 system prompt 移除**，并在原位写清警告：

> The system prompt is the cache prefix. ANY byte change invalidates the whole prompt
> cache for that request, and prompt caching is ~99% of the bill in a real project. ...
> Progress like this belongs in a tool call (team_milestone) or a message, never in the
> system prompt.

保留的仍是低频内容：自己的 `[team milestone]`（自己设置/打勾时才变）与阈值提醒（每 0.1 一次）。
长会话里合计约 10 次失效，相对数百轮可接受。

### 59.4 教训

**system prompt 只能放静态内容。**
任何「每轮可能变化」的数据——时间戳、计数器、进度百分比、他人状态——
放进 system prompt 都会**摧毁整段缓存前缀**，代价是整轮全价重算。
这类信息应该走**工具调用**或**追加消息**：追加消息只让新增部分不命中，前面的缓存仍然有效。

这条比功能 bug 更贵——功能 bug 让人用不了，这个**直接让账单翻十倍**。
## 60. 补回丢失的能力：进度改为「按需拉取」

§59 移除 `[team progress]` 后，三样信息受影响：

| 信息 | 移除后 | 现在 |
|---|---|---|
| 下级/同级的大阶段 | 仍需 `team_milestone(list)` | 不变 |
| 是否已打勾 | 同上 | 不变 |
| **每个成员的上下文占比** | **真的丢了** | **补进 `team_milestone(list)` 的返回** |

用户在 v3 里明确要过「让上级注意下级的上下文，指导下级把大阶段设在哪」，
而当时只有那段渲染在提供这个数字。现在它作为**工具结果**返回。

**为什么这样是对的**：
- 工具结果**追加在对话末尾**，前面的轮次仍然命中缓存
- system prompt 恢复为近乎静态
- 按需获取：上级要判断进度时才查，不需要时不产生任何 token

POLICY 里补了一句 `PROGRESS IS PULLED, NOT PUSHED`，明确告诉上级：
进度在 `team_milestone(action:"list")` 后面，需要时主动查；
并说明**为什么不注入 prompt**（每轮变化会摧毁缓存、成倍放大账单）。

**所以能力上没有缺失，只是从「自动推送」变成「按需拉取」**——
而这正是正确架构：推送进 prompt 的东西必须静态，动态信息只能追加。
## 61. 按用户原本的设计实现：阈值提醒发消息，并静默抄送上级

### 61.1 用户原本的设计是对的，是我绕了一圈

用户在讨论压缩信号时说的原话：

> 「当提醒触发的同时 会给上级发送 那个下级的上下文情况 让上级知道下级的上下文」

**「发送」= 消息。** 我当时改成了「渲染进 system prompt」，理由是「压缩打不到它」——
结果 §59 的缓存灾难。**消息追加在对话末尾，根本不会有这个问题。**

### 61.2 现在的实现

阈值提醒触发时（`pendingReminder` 有值）：

1. **给下级自己** `inject` 一条提醒（引导它设大阶段 / 打勾）
2. **静默抄送上级**一条，内容：

        [team context] eng-a1 (tier 2, group engine) is at 42% of its context and
        milestone "写入口/帧循环" (done when: ...), not ticked yet. Its context is
        approaching the point where a fold would be cheaper than continuing; consider
        whether its milestone is set where it will finish before that.

两条都走 **`agent.inject(input)`**，它的实现是：

    inject(input) { this.send(input, 'next-step', false) }   // false = 不唤醒

**投递到收件箱、不唤醒、不打断** —— 下级下次干活时看到提醒，上级下次醒来时看到下级情况。

### 61.3 现在 system prompt 里还剩什么

只剩 `[team milestone]`（**自己的**大阶段，只有自己设置/打勾时才变，长会话里几次）。
阈值提醒、进度、上下文占比**全部不再进 prompt** —— 三者都改走消息。

### 61.4 这一版的取舍

| | 推送进 prompt（旧） | 消息投递（现在） |
|---|---|---|
| 缓存 | **每轮前缀全毁** | 前面全部命中 ✓ |
| 时效 | 每轮都有 | 下次醒来看到 ✓ |
| 唤醒 | 不唤醒 | 不唤醒 ✓ |
| 上下文占比 | 在 prompt 里 | 在消息里 ✓ |

**用户的两条要求在机制上被同时满足**：上级能拿到下级的上下文（原设计），
且下级不会因为阈值提醒被反复唤醒（后续要求）。
## 62. 新 pill 恢复：改走 remote（不再用自定义事件）

### 62.1 为什么之前不显示

两个新 pill 读 `teamUsage` session projection，而提供它的插件在 §52 被**禁用**了
（它写自定义 session 事件，损坏了会话日志）。**数据源没了，pill 自然不显示。**

### 62.2 新方案：remote + `/team usage`

关键事实：`dsh-client-ui-chat` 客户端插件**在依赖里声明了 `"remote"`**（`const inject = [...]`），
所以它可以调 Host 命令。而 `/team usage` **只读 journal**，不会像自定义事件那样破坏会话。

改动（直接编辑 profile 的 shadow 副本，`.orig` 保留可回滚）：

| 步骤 | 内容 |
|---|---|
| 1 | 模块级 helper：`__teamUsageFetch` / `__teamUsageValue` / watcher 集合 / `__refreshTeamUsage` |
| 2 | `apply(ctx)` 里赋值 `__teamUsageFetch = (id) => ctx.remote.commands.execute(id, "/team usage", [])` |
| 3 | `StatsPills` 签名加 `sessionId`；用 `useState` + `useEffect` 订阅并每 20s 刷新 |
| 4 | 新增 `TeamTotalPill` / `TeamOthersPill`，渲染在现有 UsagePill 之后 |

**解析方式故意不用正则**：`/team usage` 的文本用 `indexOf` + 逐字符取数字解析，
避免在 applier/编辑里堆叠多层转义（这一轮我被转义坑了三次）。

### 62.3 状态与风险

- 编译通过（`node --check`），实例重启 HTTP 200，日志无 error。
- **风险点：`StatsPills` 的 props 里是否真的有 `sessionId`。**
  它原本只解构 `{ useChat, useProjection, t }`；slot 可能传了更多但未被解构。
  若 slot 不传，`sessionId` 为 undefined -> 不拉取 -> **pill 仍不显示**（但不会报错）。
  这一条**必须由用户在 GUI 上确认**——我看不到渲染结果。

### 62.4 回滚

`profiles/web/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js.orig` 是未改动副本，
覆盖回去即可完全恢复。
## 63. pill 不显示的真正原因：浏览器里跑的是旧 bundle

### 63.1 结论

代码没问题。§62 交付时**页面里执行的仍是打补丁之前的 client.js**。

证据链（都是可复查的文件事实，不是推测）：

| 事实 | 数值 |
|---|---|
| 打补丁的 client.js mtime | 11:07:49 UTC |
| 该会话最后一次 /team meta（面板轮询，说明页面还活着） | 11:00:22 UTC |
| 40123 进程启动时间 | 在补丁之后 |
| 扫描全部 **113 个 journal** 里的 command/done | /team usage **0 次**，/team meta 65 次 |

即：**补丁落地后，浏览器从未加载过带补丁的 bundle**。服务端重启不会让已打开的标签页重新拉 JS——
标签页只是重连 WebSocket，内存里还是旧代码。所以「重启了、还是没有」完全成立。

### 63.2 顺带推翻了 §62.3 里那个「风险点」

sessionId **确实会传给 slot 组件**。链路：
dsh-client-ui-session 的 session scope source 声明了 props: ["sessionId"]，
resolve(binding) => ({ props: { sessionId: binding.sessionId } })，
由 dsh-client-ui-renderer 的 standardProps()/materializeStandardBinding() 铺进每个 session 作用域座位的 props。
ChatView 能解构到 sessionId 就是这个机制。

### 63.3 无浏览器验证（本轮新增的验证手段）

不能截图，就**把两半分别跑起来对接到一起**：

1. **服务端真半**：profiles/web/teamcheck/ 里放一份 plugins 副本（相对导入 + 向上解析到
   profiles/node_modules），直接 import team-operator.mjs，抓 ctx.commands.register 拿到的 spec，
   用假 ctx 调 handler({ rawInput: "usage" }) —— 跑的是**线上同一份代码**。
2. **客户端真半**：用 node:vm 加载**真正被 40123 服务的那个 bundle**，
   把 window.__ModuleLoader__.load 抓下来，喂一个假 require（react / react/jsx-runtime 用自制 hook 实现，
   其余按需 stub）、假 cordis ctx，然后 apply(ctx)，取出 conversation.composer.dock 注册的组件，
   **直接调它**（自己跑 effect、递归展开渲染树取文本）。
3. 把 1 的输出当成 remote.commands.execute 的返回值喂给 2。

实测输出：

    [server] kind=success   agents: 14 | total: 248,749,350 | others: 212,281,566 (85%) | cached: 245,636,480
    [client] command calls: ["/team usage"]
    [client] rendered pills: ["stats.counts...","ALL 14 / 248 / 99%","OTHERS 85% / 212"]
    RESULT: PASS — both pills render

复跑：node D:/dsh-test/home/profiles/web/teamcheck/e2e-pill.mjs

### 63.4 顺带的两处修正

- 轮询 **20s -> 60s**，并在 document.visibilityState === "hidden" 时跳过：
  一次 /team usage 要解压整个 workspace 的 journal（实测 40 个会话约 **0.8s CPU**），20s 一次纯属浪费。
  **已知代价**：走命令通道意味着每次轮询会写 2 条 command/run + command/done 事件进 journal
  （无更好通道；remote 自定义命名空间需要 typert 代码生成）。
- §62.3 的风险点作废（见 63.2）。

### 63.5 剩余动作

页面**刷新一次**（不是重启服务端）。刷新后可用 journal 里是否出现 /team usage 确认客户端真的跑到这段代码。

## 64. 唤醒不了的真正原因：投递用错了父级（lineage 授权）

### 64.1 现象与实测

组长（tier 1）给 **inactive 的 tier-2 成员**发消息，消息永远排队、成员永远不被冷启动；
而 tier-1 成员（Lead 的直接子级）一直能醒。模型自己也观察到了这一点。

实测（扫 `team/message/queued` 与 `team/message/delivered`）：

| 会话 | 排队未投递 | 其中 level 2 | level 1 |
|---|---|---|---|
| session-1c96 | **122** | **122** | 0 |
| session-e5ad | 5 | 5 | 0 |

**全部是 tier-2，tier-1 一条都没有。**

### 64.2 机制

域的 mailbox 投递 inactive 目标时调 `steerHostSubagentPrompt(subagents, ROOT, targetId, ...)`，
而 subagent 运行时的冷启动按 **lineage** 授权：要求传入的 parent 就是目标的**直接父级**
（`authorizeLineage(parent, childId, header.parentSession)`）。

本 fork 为了让唤醒沿 Team 树走（组员醒组长、组长醒 Lead），把成员挂在了**真实 spawner** 下
（`parentName`）。于是 tier-2 成员的直接父级是**组长**，不是 Team root —— 从 root 投递一律抛错，
被 `dispatchOnce` 的 catch 记成 `remains queued`，**永久排队**。

### 64.3 修法

域里新增 `TeamMailbox.deliveryParent(root, targetId)`：按成员记录的 `parentName` 解析出
**真实直接父级**的 live agent，找不到才回落到 root。投递改用它。
回落而不是报错：spawner 休眠时消息保持排队，不会被投错人。

### 64.4 同批修掉的其他问题

| 问题 | 修法 |
|---|---|
| 两个会话并行时面板串台、配额互相挤占 | `policyFor(teamKey)`：registry + 看板按 **Team 根会话 id** 分区 |
| 冻结不释放名额 / 解冻后恢复不了 | `reconcileRegistry` **双向投影 `frozen`**（域是唯一真源） |
| 冻结只影响计数、消息照发 | `send_message` 对冻结目标**显式拒绝**并给出解冻指令 |
| 全队停工没人回报，Lead 永远不知道 | 新插件 `team-idle-watch`：全员 + Lead 停工 30s → **唤醒** Lead 提醒（每个 episode 一次） |
| 里程碑勾了不折叠 | `step-compaction` 走 `ctx.inject` 回调 + `agent.ctx` 探测 + **`/compact` 命令跨 isolate** |
| 配额偏紧 | `maxMembers` 16 → 20 |

### 64.5 状态

19 个测试套件全绿；新增 `phase4-tests/freeze-projection.test.mjs`、`phase6-tests/idle-watch.test.mjs`、
`phase4-tests/team-isolation.test.mjs`。

## 变更记录

## 65. 0.1.6 升级回归：三处被覆盖/遗漏的硬约束（2026-09-15 已修）

### 65.1 现象

新会话 `session-4601ba9c`（两组长 × 各两成员，一轮模拟讨论）：

- root 被唤醒 `9 轮 / 18 步`，其中 7 轮是空 prompt：6 条 `subagent-settled`
  （`Background subagent … finished…`）+ Room 快照注入。用户感觉的“每个代理完成一个消息
  root 就被唤醒”是真实的。
- 所有 `team_room_next/team_room_post` 的 nextSpeaker 唤醒都记 `delivery-failed`：
  `The "signals[0]" argument must be an instance of AbortSignal. Received undefined`。
  轮次推进实际靠 tier 0 手工发 `send_message(wake:true)`，每次绕路多花 1–2 轮。
- 组板 `complete` 可在没有 plan、没有 commit 的情况下完成，且 phase 停在
  `room-discussion`；`team_delivery_check` 又按“有没有 plan”过滤任务，于是该任务
  从不进入交付门禁，仍返回 `deliverable=true`。

### 65.2 根因

1. `team-tools-v2.mjs` 的 `wakeRoomMember` 调 `ctx.agentTeams.sendMessage(...)` 时
   没有传 `signal`；`dsh-experimental-agent-team` 的 mailbox 直接
   `AbortSignal.any([request.signal, …])`，`undefined` 进入就抛签名错误。
2. §56 的 app-plane `dsh-subagent.notifySettlement` 补丁被 0.1.6 升级覆盖，
   Team 成员的 continuable 结算重新走 `sendWaking` → 每次子代理结束都新开 root turn。
3. `team_task_update complete` 的门禁只有 `if (planState)` 才生效；
   `team_delivery_check` 只收集有 plan 的 durable 任务。无 plan 任务从门禁中整体消失。

### 65.3 修法

| 位置 | 改动 |
|---|---|
| `team-tools-v2.mjs` | `wakeRoomMember` 接收并转发 `exec.signal`；retry / verifier 投递也补 signal |
| `dsh-experimental-agent-team` mailbox | `request.signal` / `signal` 为 undefined 时退回 lifecycle signal，不再抛 `AbortSignal.any` |
| `dsh-subagent.notifySettlement` | 重新加回 Team 成员 `parent.inject(message)`（不唤醒）；app 与 profiles 两份副本同时打补丁 |
| `team_task_update complete` | 声明 writeScopes 的任务必须有已批准 plan、execution、owner lease、commit；所有完成都要求已落库的 evidence_id |
| `team_delivery_check` | 收集所有 durable board 任务；已完成任务至少校验 owner + evidence，有 plan/scope 的再加 commit、phase、三步 packet |
| POLICY 文案 | 明确“下级回报默认静默、全队停工才唤醒一次”和“完成需 plan + commit + 已落库 evidence” |
| `roomSpec` | tier 1 给本组 tier 2 下属的控制消息改走 group room；旧路由把它放进 level:1，而成员不入 level room，导致 dispatch 永久排队 |
| pre-step 投递确认 | 目标真正开工后把 `delivered` 唤醒消息推进 `turn-started → completed`，并允许从 `queued` 起点的 idle 广播收口；不再被 reconcile 误写成 `timed-out` |
| `team-idle-watch` | 改为“进展感知”预算：连续 `maxNoProgressReminders`（默认 3）次停工且可交付状态毫无变化才停；有实质进展就重置；`maxReminders`（默认 20）只作为每 Team 绝对兜底 |

### 65.4 验证

- 全量 `node --test phase1..phase7`：**30/30 pass**（新增 `phase7-tests/room-wake-signal.test.mjs`）。
- 新会话实测（同一提示词）：root **2 轮 / 4 步**，Room nextSpeaker 唤醒全部
  `completed`，无 `delivery-failed`；两个组各自完成一轮讨论并落盘 `summary + unresolved`。
- 基准对照：修复前 `9 轮 / 18 步`，修复后 `2 轮 / 4 步`；唤醒风暴消失，root 只在初始调度
  和全队停工（`team-idle-watch`）各醒一次。
- 修复后第二轮实测（含路由与投递收口）：root **2 轮 / 7 步**；除 idle 广播自身外
  全部 dispatch `completed`，没有 `timed-out`，没有卡在 `queued` 的下行控制消息；
  两组的 `summary + unresolved` 正常落盘。
- 新增回归：`phase6-tests/idle-watch.test.mjs` 覆盖“同一停止 episode 只提醒一次 +
  durable 上限阻止 ping-pong”；`phase7-tests/room-wake-signal.test.mjs` 覆盖
  signal 传递、组内下行路由、complete 计划门和执行 evidence 门。
- 最终实测（全部修复同时生效的第五轮）：root **2 轮 / 4 步**；20 条 dispatch 全部
  `completed`，无 `queued` / `timed-out` / `delivery-failed`；idle 唤醒 episode 也
  从 `queued` 正常收口为 `completed`；两个组各完成一轮 Room 并落盘 `unresolved`。
- 同时确认：本用例没有创建无证据任务；若确实要建案，声明了 writeScopes 的任务
  必须走 plan + commit + evidence，不能再用“讨论完成”冒充任务完成。

### 65.5 升级维护要求

`dsh-subagent` 是 app-plane 包，每次升级 `D:\dsh-test\app` 后必须重新应用 §56 的
`notifySettlement` 补丁；补丁备份与撤销说明见 `D:\dsh-test\REVERT-dsh-subagent.md`。
同样地，`dsh-experimental-agent-team` 的 mailbox signal 兼容补丁写在 profile 的
`node_modules` 内，重装插件后需重新应用。两处都属于“升级后主动适配”清单。

### 65.6 idle 提醒预算的确切语义（防止误解为“每会话只允许 3 次”）

预算按 **Team（root session）** 计，状态存在该 Team 的 control-plane 文件里，跨重启保留。
每次全队停工后是否提醒，看两个条件：

1. `maxNoProgressReminders`（默认 3）：只统计 **连续且可交付状态毫无变化** 的提醒。
   可交付状态 = 任务板的 `status/phase/revision/evidence/commit`、已关闭轮次的
   `summary/decision/unresolved`、escalation 状态、acceptance packet；
   同一开放轮次里的普通发言和 dispatch 重发不算进展。
2. `maxReminders`（默认 20）：同一 Team 的绝对兜底，防止极端情况下无限唤醒。

只要 Team 真正推进了任务（状态变化、证据落库、commit、packet 提交、escalation 解决），
进度哈希就变化，第 1 条的连续计数归零，下一次停工仍然会唤醒 Lead。
因此“长任务多次正常停工”不会被 3 次限制卡死；只有“反复发消息但不产生任何交付进展”
的 ping-pong 会被暂停并留下一条 warn 日志，交回操作者处理。

两个阀值都可在 profile 的 `team-idle-watch` 插件 config 里覆盖（`maxNoProgressReminders`、
`maxReminders`、`settleMs`）。验证见 `phase6-tests/idle-watch.test.mjs`：
无进展连续 2 次后停、任务板推进后下一次恢复唤醒。

### 65.7 Room 讨论预算：每 Room 最多 3 轮，host 必须参与

2026-09-16 调整，规则由 control plane 和 tool layer 双重硬限制：

- 每个 Room 最多创建 3 个 round；第 4 个 round 直接拒绝，提示记录 unresolved 并
  使用 `team_escalate`。
- `team_room_next` 始终把 host 加入本轮成员。调用方没有显式列出 host 时，host 追加到最后；
  调用方显式列出 host 顺序时保留其位置。
- 每轮仍保持“1 次主发言 + 至多 1 次短澄清”。讨论不足时开下一轮，而不是放宽单轮发言次数。
- Room compact snapshot 返回 `roundBudget: { used, max, remaining }`，host 在关轮前能看到预算。
- `maxRoomRounds` 默认 3，可在 `team-policy` 与 `team-tool-agent-team` profile config 中配置；
  control plane 仍以硬默认值 3 兜底，模型不能通过参数绕过。

验证：

- `phase7-tests/control-plane-v5.test.mjs`：完成 3 轮后第 4 轮被拒绝。
- `phase7-tests/room-wake-signal.test.mjs`：host 自动追加到最后，且 snapshot 正确显示 `used/max/remaining`。


| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-09-11 | 初稿：现状基线、需求 R1-R7、四层架构、数据模型与矩阵、SoL-Pi 融合、强制矩阵、测试环境、五期计划 |
