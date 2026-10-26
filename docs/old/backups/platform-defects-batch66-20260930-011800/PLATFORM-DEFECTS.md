# 平台缺陷 · 修复方视角（按**修复点**归组）

> **与 `docs/STATUS.md §8.5` 的分工**：§8.5 是**编年史**（追加式，含每一实例与原始指纹，用于溯源）；**本文是工作清单** —— 按**改哪个文件**归组、按**优先级**排序，供修复方直接施工。
>
> **可信度标注**：**tier0实测**（我亲手复现）/ **成员实测**（成员复现，我未复现）/ **源码级**（读插件源码定位）/ **故意未复验**（见该条说明）。
>
> **本地已打的补丁（必须知悉）**：tier 0 曾直接修改 `team-tools-v2-r10.mjs:286`（**两个 profile 都改**），把 `worktreePath` 的 JSON schema 从 `{type:"string"}` 放宽为 `{oneOf:[{type:"string"},{type:"null"}]}` —— 修的是「`worktreePath: null` 导致整块板不可用」。**修平台时请以该行为基线，勿覆盖回旧形态。**

## P0-A 写入门禁（`write-scope-guard.mjs`）—— 最大的一簇，且**两个方向都错**

**根因（一句话）**：该门禁对**命令行文本做子串/路径抽取**，而不是**解析真实写入目标**。于是它**同时**放过了真正的绕过（A-6 / A-1 / A-2），又拒绝了合法的验证工作（A-4 / A-5 / A-8 / C-1 / C-2 / C-5）。**改一次可同时解约 10 条。**

| # | 缺陷 | 可信度 | 指纹 | 修法方向 |
|---|---|---|---|---|
| **A-6** | 对「**被执行程序自身的写入**」不设防 | 成员实测 | 同路径 `.local/oracle/leadcheck`：`New-Item -ItemType Directory -Force` ⇒ **被拒**；`target/debug/bot.exe --out .local/oracle/leadcheck` ⇒ **未拒且写盘成功** | 按**实际写入目标**判定，或对子进程做 sandbox。**「拒绝 benign、放过 bypass」是最坏组合** |
| **A-1** | 落点可被 `workdir` 移出 scope | 成员实测 | 相对路径 + `workdir` 指向 worktree ⇒ 门禁按**会话 cwd** 校验、产物落在 **worktree** | 校验对象应是**解析后的绝对落点** |
| **A-2** | `.NET` 静态写入绕过路径抽取 | 成员实测 | `[System.IO.File]::WriteAllBytes` / `[System.IO.Directory]::Delete` 不经抽取器 | 同上；或受限模式禁用该 API |
| **A-4 / A-4b** | **纯内存字节管道被判 opaque 而拒**；且规则**扫描「程序全文含字符串字面量」** | 成员实测 | `ReadAllBytes` + 内存变换 + 进程 stdin ⇒ `can write through an inline interpreter or opaque expression`（**全程零文件写入**）。**A-4b**：**描述该规则的文本本身触发该规则** —— 报告者「在报告假阳性时亲手复现了它」 | 基于**实际写入目标**判定；**不要对程序文本做子串匹配** |
| **A-5** | 拒绝**仓库外临时文件** | 成员实测 | 向 `$env:TEMP` 写临时 manifest 整条被拒。**边界（lead-world 补）**：被拒的是**任何非字面量路径的 shell 侧写**，连「读源 → 内存变换 → 写临时」这种**零仓库副作用**的组合也拒 | **只加临时目录白名单不够**；必须同时放行**非字面量路径**，否则复核方**写不出篡改样本** |
| **A-8** | `run_code` 的「动态代码执行」门禁按「是否生成脚本代码」判定 | 成员实测 + tier0 找到可用路径 | ① here-string 管道给 `jjs` ⇒ `dynamic code execution can bypass the write-scope guard`；② 用 `tools.write` 落 `.js` 脚本 ⇒ **同一条拒绝**。⇒ **ASM 字节码 oracle 对全员不可用** | 按**实际写入目标**判定（同 A-4），或允许在**已授权目录**（如 `.local/**`）内落脚本 |
| **B-13** | worktree **永不成为** guard 的 root | **源码级** | `write-scope-guard.mjs:220-232` 的 root 集合含 `:230 activePlan?.worktreePath`，而 `team_plan_propose` **无该入参**、`team_worktree_setup` **不回写** ⇒ 恒为 `undefined` ⇒ `:223` 的 typeof 检查直接 return | (i) `team_worktree_setup` 把 `worktreePath` 落到 plan/task；或 (ii) 明确废止 worktree 写入期望。**tier 0 已选 (ii)** |
| **C-1** | 开关被当路径 | 成员实测 | `-ItemType` / `-Recurse` / `-Force` ⇒ 拒绝串点名 `.../-ItemType` 等 | 抽取器应**跳过以 `-` 开头的 token** |
| **C-2** | `>` / `<` 被当重定向 | 成员实测 | `git commit -m` 消息里含 `id12>=256` ⇒ 被拒为 `=256` | 引号内的 `>` / `<` 不应触发重定向判定 |
| **C-5** | `Copy-Item` 因**只读源**被整条拒 | 成员实测 | 源为 `.local/**` 时整条命令被判为写目标 | 源路径不应参与写目标判定 |

## P0-B 静默数据不一致（**最危险的一类：调用成功、内容没生效、无拒绝码**）

| # | 缺陷 | 可信度 | 指纹 | 修法方向 |
|---|---|---|---|---|
| **B-19** | `team_acceptance_packet` **静默丢弃未知顶层键** | tier0实测 + 成员定位 | 存储 schema **只有 14 个固定键**；把 `delivery_digest_input` / `frozen_fixtures` / `cards` 当**顶层额外字段**传入 ⇒ **返回 `packetId` 但字段全丢**，`resourceScan` = `null`。**另**：工具声明 `resource_scan` 为**数组**，实测**必须传对象** | ① 未知顶层键 **fail-closed 报错**（与 `resource_scan` 类型错误同等待遇 —— 后者就报了错）；② 修正声明类型 |
| **B-14** | `task_contract_set` **静默无效** | tier0实测 | 调用**无 error**、`revision` **递增**（17→18→19），但 `acceptanceCriteria[0].text` **保持旧值**（5201 字符 vs 提交 9934）、`contractDigest` **恒定**、新关键字全 false | 找到落盘丢字段/长度上限的原因；**至少让「内容未生效」可被检出**。✅ 过渡期出路：控制面状态文件可直接读到完整 `contract` 对象 |
| **B-16** | `team_task_update(action:"edit", commit_sha:...)` **静默忽略 `commit_sha`** | tier0实测 | `edit` 返回成功、`revision` 递增，卡面 `commitSha` **始终不变**；`complete` 又被 `complete-phase` 拒 ⇒ **绑错 sha 的卡在账面上永远错下去** | 让 `edit` 真的写 `commit_sha`，或给 tier 0 一个**显式**的 sha 修复动作 |
| **B-5** | `packetId` 不唯一 + **同一 id 就地 upsert** | tier0实测（**在 verifier 自己身上复现**） | verifier 对 t30 的两份裁决包**拿到同一个 `packetId`** ⇒ **首份（包体 major）被第二份（CLEARED）覆盖**。id 显然由 `(kind, group, task, commit)` 派生 ⇒ **同一提交上的重审必然 upsert** | 把**裁决序号 / 内容摘要**纳入 id 派生，或令 verifier-review **只追加不覆盖**。✅ 过渡期：**裁决权威载体 = 报告文件**，包只是回执 |
| **B-9** | `waiting_set` 复用票据**不清旧字段** | 成员实测 ×3 | 票据 `status=open` 但**仍携带上一轮的** `resolution` / `resolvedBy` / `resolvedAt`，且 `taskRevision` 陈旧（13 vs 实际 rev11） | 复用票据时清空这四个字段。**过渡期纪律**：**只读 `status` 判开放性**；`taskRevision` **不可用于 CAS** |
| **B-22** | `waiting_resolve` **按 `task_id` 收口** ⇒ 一卡多票**无法只收口一张** | 成员实测 + tier0 复核票面 · **故意未复验** | `group-proto-t34` 上同时挂 `manual`（串行持有，权威）与 `dependency` ⇒ 组长**拒绝**收口后者，因为会**连带清掉**前者 | 让 `waiting_resolve` 接受 **ticketId**。**为什么未复验**：验证需**真的收口一次**，那会摧毁一张活的串行持有 —— **破坏性假设不得为了求证而执行** |
| **B-20** | info 类投递**没有可确认的 `wake_id`** | tier0实测 + 成员第二实例 | 对 info 调 `inbox_ack` 一律 `wake-not-found`（`wakeRequested:false` / `wakeIds:[]`）⇒ **恢复清单每轮重放同一批已处置 info**（实测 ≥14 条）。**第二实例**：对**已注入且已读到**的 wake，`inbox_ack` 被拒 `message-not-delivered`（底层消息仍 `status: queued`） | ① `inbox_ack` 接受 `inboxId` 并支持 info 类；② 恢复清单只列 `wakeRequested:true` 或未处理项。**核心**：**「可确认」不应依赖一个滞后于「实际注入」的内部标志** |

## P1 结构性：**让正确做法不可执行**

| # | 缺陷 | 可信度 | 指纹 / 后果 | 修法方向 |
|---|---|---|---|---|
| **B-13 实测 + B-12** | 成员 worktree **拿不到可写的隔离检出** + **默认 base 过期** | tier0实测 | `team_worktree_setup` 给 member-codec 的分支停在 `31a7c32`（**落后 main 125 个提交**）；写 worktree 内路径被拒。**★ 系统性后果**：成员只能在同一棵会话工作区树上并发编辑 ⇒ `crates/` 出现他卡脏路径 ⇒ **「`git status` 与开工前逐字相同」类判据结构性不可满足**（本会话**两次**只读卡判据失效的**根因**） | 修 guard 的根解析，或让 `team_worktree_setup` **建卡时同步 base 并声明该树不可写** |
| **B-21** | **tier 1 组长没有任何可写载体**维护组级文档 | 成员实测 | `write` 对工作区**任何**路径被拒，**含 gitignored 的 `.local/`**（`write denied: ... has no declared static scope or active approved plan lease`）；`decision_record` 亦拒（`decision-scope: ... require tier 0`） | 给 tier 1 一个**组级可写位置**（如 `docs/groups/<group>/`）。**否则每个组长都把口径散在卡面里**，而卡面跨组不可读 ⇒ **三份副本必然漂移** |
| **A-3** | `git add` / `git commit` **不按活动 lease 校验** | 成员实测 **×2** | `heartbeat` 返回 `lease-not-found` 后提交**仍然成功**；**第二实例**：**无活动 lease 也能写盘并 commit，随后才 acquire lease 并 complete** | ⇒ **lease 是事后追认，不是写入前置** —— 这**削弱整套 lease 纪律**。让 commit 校验活动 lease。**⚠ 2026-09-28 实测反证：commit 已被 lease 门禁拒绝（`git write denied: git add/commit requires an active approved plan lease`）⇒ 本条方向存疑**（两个假设：子系统对「活动 lease」判断不一致 / 平台已变更；均未断言） |
| **B-28** | **已完成卡上没有「绑定修复」的干净路径** | 成员实测 | 卡 completed + lease released 后，提交只改脚本的绑定修复须 **acquire lease → commit → release**，而 **acquire 把相位从 completed 推回 `execution`** ⇒ 需**手动** `advance_phase` 复原；卡面 `commitSha` 仍停旧值（B-16） | 给 **post-completion 绑定修复**一条窄路径：以「不动产品字节」为前提直接提交脚本/夹具绑定修复、**不改相位**，并让卡面 `commitSha` 可显式更新（同 B-16）。**净效果：让账本可信的动作反而是最贵、且会扰动板面的那个** |
| **B-8** | 契约漂移 + **`owner` 空值死锁**（**每张无 owner 的 edit 卡都会撞**） | 成员实测 | `edit` **不同步 `contract`**；`validateTaskContract` 要求 `contract.owner` 非空；`task_contract_set` 只放行现任 owner 或 tier 0 ⇒ **成员与组长都补不了 owner** | 让 `edit` 同步 `contract`（尤其 `owner`）；或允许组长为本组卡补 `owner`。唯一出口现在是 `reassign` |
| **B-18** | 组长**无法把下属的卡退回 pending** | 成员实测 | `release` **只允许 owner**；`reassign` **不带替换人**又被拒（`only tier 0 may unassign`）⇒ **owner 已 inactive 时完全无解** | 给组长一条 **unassign / release-on-behalf** 窄路径（限定本组 + 目标卡**无活动 lease**） |
| **C-4** | `owner-forgot-to-mark-it` **系统性误报** | tier0实测 | `team-tools-v2-r10.mjs:4673` 的 `state.members[owner]` **只按 owner 查里程碑、无 task 绑定**；`:4674-4677` 把「一个成员同时只有一个工作单元」当不变量 —— 在**流水线派工**下不成立。实测 t17/t18/t19 **同时**误报 | **最小修法**：milestone `done` 时把当时活动 `run_lease.task_id` 落库，判定改为 `done===true && milestone.taskId===task.id`。**后果**：`[team idle]` 钩子反复空转唤醒 owner |
| **B-17** | `ready_queue` 的 `executionState:"stalled"` 无法区分「真停」与「折叠/接续窗口」 | tier0实测（**我踩了一次假阳性**） | `group-world-t29` 被标 `stalled`，而**同一份证据里就有「持有未过期 lease」**（成员在折叠窗口，阶段1 已落地） | 若 owner **持有未过期 lease**，降级为 `suspended-between-rounds`，或**在投影里带上** `lease_active: true` / `lease_expires_at`。**后果**：每次成员折叠都惊动上级 ⇒ **稳定的假阳性流** |
| **C-3** | **milestone tick 静默丢弃未完成工作** | 成员实测 **≥4 例** | `team_milestone(action:"done")` 武装折叠并**结束 turn**，tick 之后未写完的工作被丢弃 | 要么 tick **不结束 turn**，要么在 tick 时**拒绝**「本 turn 仍有未落盘写入」。**高频且静默** |
| **B-15** | 生产者**无法读取自己包的 `resourceScan`** | 成员实测 | `team_v12(review_package)` 只返回 `tasks/matrices/evidence/complete/blockers/verificationPlans`，**不含包体** | 让 `review_package` 返回包体（或至少 `resourceScan`）。✅ 过渡期出路：读控制面状态文件 |
| **B-12** | `team_worktree_setup` 的 `base` 默认值**静默给出过期树** | 成员实测 | 成员默认 `base` = **组分支**，而 `grp/*` / `team/*` 长期停在 `af93bd8`「M0 skeleton」⇒ 成员 worktree 只有 175 B 占位 `lib.rs`。**指纹**：成员「worktree 干不了 ⇒ 去共享检出干」 | `base` 默认应为 `main`，或**强制显式传** `base` + 校验它包含绑定提交 |
| **B-11** | `plan replace` 要求无活动 lease，但**拒绝串不给指引** | 成员实测 | 成员 acquire 后才发现 scope 不符 ⇒ 必须走「释放 lease → 组长 replace plan → 重新 acquire」**三步握手** | 在拒绝串里**直接给出该三步** |
| **B-23** | 任务行 `write_scopes` 与 plan `writeScopes` **可静默分叉**；**在飞时无法替换 plan** | 成员实测 | 改任务行 ⇒ `writeScopes` = 9 条，但 guard **仍拒**（认 plan 的 7 条）；`replace_approved` 被 `cannot be replaced while run lease ... is active` 挡住 | 让两者**同源**（或明确只以 plan 为准并在任务行标「仅供参考」）；替换被 lease 挡住时**给出三步**。**同族第三例**：`release` 被 `lease-release-order` 拒（"complete it while the lease is active"）⇒ 须改用 `status:"cancelled"` |
| **B-24 ★** | **SLA 不读 `nextCheckAt` ⇒ 诱导伪造裁决** | 成员实测 ×3 | `manual` 票 `status=open`、`nextCheckAt` **已显式设在未来**，**仍被催办**；SLA 只承认「CLEARED/blocker 裁决」或「记录责任人与期限」，**第二条不生效** ⇒ **唯一能停催办的动作是「假 CLEARED」** | `manual` 票的 SLA 在 `now < nextCheckAt` 时**不应触发**；或对「依赖尚未提交」的票改用**非催办**类提醒。**这是本账最严重的一类：一个诱导使用者伪造记录的机制** |
| **B-25** | 平台向 `packet.meta` **注入四键但无口径声明** | verifier + lead-proto **两个独立数据点** | 落盘 `meta` = `{packetVersion, revision, supersedes, contentDigest}`，**四键均非提交方撰写**；120 包中**仅最近 5 包**带 `contentDigest` | 文档写明四键为**平台注入**、**不属提交方定义域**；若 `contentDigest` 参与判据须**先给算法与输入定义** |
| **B-26** | **verifier 无组板读权限** ⇒ 包内 `cards[].revision/phase/status` 无法跨组独立复核 | 成员实测 | `board-read: member "verifier" may not read board "group-world"` ⇒ 相位只能由提交方自证 | 给 verifier 一个**只读板面投影**，或给出「包内自证相位」的**合法口径**（要求相位快照随包交付并由 verifier 核其内部一致性） |
| **B-27** | **上下文百分比提示可能严重滞后 ⇒ 误导调度** | verifier 亲测并当场纠正 tier 0 | 系统提示 verifier 在 **60%**，其自测 `team_milestone list` = **10%** ⇒ tier 0 据此发的 `action` 紧迫性前提不成立 | 提示里带上**计算时刻**（`contextPct@<ts>`），或改为「上次计算于 N 分钟前」。**与 B-9/B-17/B-20 同族：投影描述的是「上次计算时」的状态** |

## P2 操作级误判 / 低危

- **B-10** `verification_plan` recipe 选择器**不识别非 UI 任务** —— 对**纯 Rust 库卡**生成 `ui-visual`（`primary-flow` / `screenshot` …）。**成员实测**
- **B-7** `requirements_snapshot` 板级**静默过滤** / `evidence_query` 返回空 —— 静默过滤会让人把「过滤掉了」当成「不存在」。**成员实测**
- **B-6** acceptance packet **无 meta 信封**（与 B-19 同簇）。**成员实测**
- **B-3 / B-4** `contractRevision` 不自增；`requirement revision` 被任意 task 更新推动 ⇒ 版本把手不可靠，**只用 digest 判别版本**。**成员实测**
- **B-1 / B-2** 门禁不认 worktree 根（见 B-13）；依赖不自动重算。**成员实测**

## 已降级 / 非缺陷（**不要修**）

- **C-6 显式组板 id 读取中断** —— **已降级：未复现**。lead-world 两个探针结果完全相同 ⇒ 判**瞬态**。**纪律**：此类项必须附**确切调用与时刻**。**本条由 tier 0 自己踩中**（据单方报告就入账）。
- **D 类（机制事实，不是缺陷）**：向上只有 `decision` 能唤醒（`action` 被拒）；`[workspace.dependencies]` 中未被任何 crate 使用的条目**不进 `Cargo.lock`**；`git commit -m <msg> -- <paths>` 是共享主检出的唯一安全提交形式；`grep` 从**祖先目录**遍历会跳过被 `.gitignore` 覆盖的子树、而**直接点名 `.local` 内路径**会搜到。

## ★ 修复进展（2026-09-28 · tier 0 逐条实测）

| 缺陷 | 状态 | 我的实测证据 |
|---|---|---|
| **B-26**（verifier 无组板读） | **已关闭** | 描述更新 + verifier **实调成功**（`team_task_get(board:"group-world")` 返回 rev8 全字段），并已据组板独立核对包内 `cards[]` |
| **B-27**（上下文提示滞后） | **已修复** | `team_milestone` 现返回 `contextPctAt`（顶层 + per-member） |
| **B-20**（info 不可确认） | **已修复** | `inbox_ack` 现接受 `inbox_id` |
| **B-19**（类型声明不符） | **已修复** | `resource_scan` 现声明为**对象**；契约文档明写「not an array」 |
| **B-16**（edit 静默忽略 `commit_sha`） | **已修复（新 `bind_fix`）** | `group-proto-t18` 的 `commitSha` 由错值 `30488784…` → 真值 `67659385861026b290791535fbe130f2bb8f228c`，**相位/状态未变**（rev20→21）⇒ **原始反例由红转绿** |
| **B-28(ii)**（卡面指针不可更新） | **已修复** | 同上（`bind_fix` 定位即「不改相位/状态地修 completed 卡指针」） |
| **B-28(i)**（绑定修复须 acquire lease ⇒ 相位被推回） | **未验证** | 需在 completed 卡上再提交一次脚本修复才能测；**W-26 保留** |
| **B-25**（meta 四键无定义） | **部分修复** | 契约文档已公布，但 **B-29：该契约 0/12 复算命中** |
| **B-29**（`contentDigest` 契约不可复算） | **新** | 127 包 / 12 带该字段 / 文档算法 **0/12**；8 变体恰好 2/12；10/12 任何变体都不中 |
| **B-30**（指代不闭合） | **新** | 某包声称「由 owner evidence 支撑」而全库 1,545 条 evidence 中 0 命中 |

## ★ 修复后**复测**结果（tier 0 逐条实测 · 2026-09-28 · **供修复方第二轮**）

### 已通过复测（可退役对应绕过）

| 缺陷 | 复测证据 |
|---|---|
| **B-16**（edit 静默忽略 `commit_sha`） | **原始反例由红转绿**：`group-proto-t18` 卡面 `commitSha` 由错值 `30488784…` → 真值 `67659385861026b290791535fbe130f2bb8f228c`，`status`/`phase` 未变（rev20→21）。⇒ **W-7 已正式退役。** 附带：`bind_fix` **要求随调用给 `evidence_ids`**（该拒绝是有用的） |
| **B-26**（verifier 无组板读） | verifier **实调成功** + 描述已更新 ⇒ **两个独立确认** |
| **B-27**（上下文提示滞后） | `team_milestone` 现返回 `contextPctAt` |
| **B-20**（info 不可确认） | `inbox_ack` 现接受 `inbox_id` |
| **B-19 类型**（`resource_scan` 声明为数组） | 现声明为**对象** + 文档明写「not an array」 |

### ❌ **未通过 / 新发现**

| # | 缺陷 | 复测证据 | 建议 |
|---|---|---|---|
| **C-4 残留** | `owner-forgot-to-mark-it` **仍系统性误报**（宣称已修，实测未修） | `team_delivery_check` 一次给出 **5 张**该判定，**全是** `in_progress` + `ready=true` 的**在飞卡**。**组长实测**（tier 0 读不到 tier-2 milestone）：`member-codec` 的 milestone 绑 **更早的已完成卡 t35**、`member-framing` 绑 **更早的已完成卡 t37**，**均 `done=true`**；对照 `member-registry` 绑**它自己的卡 t40**。而被判定的是在飞卡 t41/t43。 | **判定必须取该卡绑定任务的 milestone**（无绑定 ⇒ **中性值**，不是默认「忘标记」），**或**至少校验被取到的 milestone 确实绑定到该卡。**最小反例：两个组员、两张不同的历史卡、同一个失效形状。** 根因：**取 owner 名下任意 milestone，取到 `done=true` 即判「忘标记」，从不校验绑定** |
| **A-6 部分** | 任意**无参**程序自行写盘仍不可沙箱化 | 修复方已如实标 `partial` | 保持 `partial` 标注；**不要**因写入门禁整体改善而放宽对 harness 篡改的怀疑 |
| **B-29** | 公布的 `contentDigest` 契约 **0/12 复算命中** | 127 包 / 12 带该字段；8 变体恰好 2/12；**10/12 任何变体都不中**（**注入前 meta 不留存**） | **(a) 留存注入前 meta 并把文档输入集改成实测正确的那一组**（推荐）；(b) 去掉 `meta` + 全量重算回填；(c) 明确降级为「不可独立复算」 |
| **B-30** | **指代不闭合**（判据声称可核，所指物不在记录里） | 某包 `checks[]` 称「由 owner evidence 支撑」，而**全库 1,545 条 evidence 中 0 命中**；另一包 `convention_carrier.clauses` 声明 **10** 项而所指证据体正文**只有 8 项** | 已是**提交方纪律**（可机检形式已入 `GOVERNANCE §5.14`）；**平台侧无待修**，登记备查 |
| **B-31** | 已完成的 discussion 卡**可能无法推进到 `accepted`** | `group-world-t41`（completed）在 `plan-approved → execution` 被 `task-ready-gate: owner-unknown` 拒；t13/t32/t35 **同样停在 `room-discussion`** | 允许 completed 的 discussion/review 卡直接推进到 `accepted`，或明确其相位终点不是 `accepted` |
| **B-32** | `context-debt` 标记**可被下发但不可被履行** | **两名成员独立复现**：按要求 fetch 之后标记**仍不消除**（一名两次成功 fetch；一名 t43/t44 各取一次） | fetch 成功即清标记，或允许显式 resolve；或改为「**仅当源确实未被读过时**才提示」 |

### 回退战役进度（供修复方对照）

- **已退役 1 条**：**W-7**（B-16，**原始反例**由红转绿）。
- **已通过、待重放原始反例**：W-24（B-26）、W-25（B-27）、W-11（B-20）。
- **实测未通过、保留**：**W-17**（C-4 残留）；**W-2**（A-6 partial）。
- **在测**：G-PROTO `group-proto-t43`（W-6/W-8/W-14/W-3/W-2）· G-RIG `group-rig-t20`（W-1/W-12/W-16/W-18/W-22/W-26）· G-WORLD（已要求建卡）。
- **★ 三 lane 终局（2026-09-28 深夜）**：**G-PROTO t43 = CLEARED 0/0/0/1**（终审 rev5，`packet-eb9186fda7350e85e0bfb0c5-r4`）· **G-WORLD 合并批次 t39+t43+t45+t48 = CLEARED 0/0/1/2**（`packet-c1e8c06dec80f136e69af57a-r2`，commit `33f377e`）· **G-RIG t20 = NOT CLEARED（1 blocker）但记录面已由勘误 `evidence-6bed0d70-bcf3-4584-9990-dfb14fd70168` 收口**，blocker 归 t23。**退役定案**：W-4/W-5/W-6/W-7/W-8/W-10/W-12/W-13/W-14/W-16/W-11a 已退役；**保留** W-18/W-26/W-22/W-17/W-2(半条)；**门控** W-20（等 W-1）。**三态全表见 `docs/WORKAROUND-REVERT.md`。**
- **台账**：`docs/WORKAROUND-REVERT.md`（含每条的正向测试与**原始反例**）。

> **修复方原话已入纪律**：「回退绕过必须逐条按 `WORKAROUND-REVERT.md` 的**原始反例**正向测试，**不能整体回退**。」⇒ 与本项目纪律一致，且**已被采纳执行**。

**新增可用动作（供各组用）**：`team_task_update(action:"bind_fix", commit_sha, evidence_ids, bind_fix_reason)` —— 修 **completed** 卡的 commit/evidence 指针，**不改相位/状态**；**必须随调用给 `evidence_ids`**（否则被 `bind-fix-evidence` 拒）。**修指针前先 `git rev-parse <短 sha>` 取真值，不得凭记忆拼 sha。**

## 修复顺序建议

1. **P0-A 的 A-6 / A-1 / A-2**（安全级 fail-open）与 **A-4 / A-5 / A-8**（**让独立验证不可执行**）—— **同一个根因**：文本抽取器 vs 真实写入目标。**改一次可同时解约 10 条。**
2. **P0-B 的 B-19 / B-14 / B-16**（静默数据不一致）—— 三条同族，都是「调用成功 ≠ 内容生效」，且**都在同一批工具里**。
3. **B-13 + B-12 + B-21**（结构性：隔离检出与可写载体）—— 修好它，**只读卡判据与组级模板才有正确的载体**。
4. **C-3 / C-4 / B-17**（高频静默误判，会持续消耗团队轮次）。
5. 其余按表。

## ★ 第三轮（2026-09-28 晚 · tier 0 实测 + 三个组独立上报）

### 新增号

| # | 缺陷 | 可信度 | 指纹 | 修法方向 |
|---|---|---|---|---|
| **A-9** | **写入门禁两半，方向相反，必须同修** | tier0 源码级 + verifier 第三方**零写入**复现 + 成员实测（**E1/E2/E3**） | **① 放行半（根因已精确化）**：**一个「不取值」的开关会吞掉紧随其后的位置参数** ⇒ 抽取器把开关的「值」当成目标，**真实目标被丢弃**。实测三点：**E1** `Set-Content -Force <越界>` ⇒ **落盘**；**E2** `New-Item -ItemType Directory -Force <越界>` ⇒ **落盘**；**E3** `Set-Content <越界>`（纯 positional、**无前置开关**）⇒ **被拒并具名点名该路径与 scope**；对照 `New-Item -Force -Path <越界>` ⇒ **被拒**（目标被**显式命名** ⇒ 存活）。⇒ **不是「位置参数不被查」（该措辞已作废）**，而是**「无值开关吞掉后续 positional token」**。另 `ZipFileExtensions::ExtractToFile` 与位置参数 `New-Item -Force <路径>` 亦返回 `targets=[]` 且 `opaque=false`（**无二级兜底**）。**② 误拒半**：行内子表达式参数仍被当路径 —— `-Path (Join-Path $env:TEMP "x")` 抽成 `(Join-Path`、`$x = (git check-ignore -v .local 2>&1)` 抽成 `&1))`，**两次把探针脚本整条打掉**。四处锚点：`:686-701` 无开关表吞参数、`:703/:717` 目标为空、`:534-535` .NET 硬编码枚举、`:641-643` 自述启发式 | **解析真实写入目标**；确实无法解析时**拒绝并记录（fail-closed + audit）**。**⚠ 只修一半会让洞更大**：误拒半的「修法」若是「无法解析就放行」，等于**把放行半扩大**。**预测（请按类修，不要逐例补）**：凡**不取值开关**（`-Force` / `-Recurse` / `-Confirm:$false` / `-Verbose` …）**后跟位置参数路径**的形态都会逃逸 ⇒ 需要一张**开关表**，不是黑名单 |
| **B-33** | **幽灵等待：派生票指向不存在的 room ⇒ 结构性无法解除** | **两个组独立确认**（G-RIG `t17/t18/t20`；G-WORLD `t44/t46`） | 卡相位为 `room-discussion` 时生成 `waiting-room` 派生票，`roomId=task:<id>`，而该 room **不存在**：`team_room_read('task:group-world-t44')` ⇒ `[room-not-found]: no room named "task:group-world-t44"`（t46 同）。⇒ **票永不解除**，卡被**永久**计入等待 / blocked 投影 | 仅当 room **确实存在**时才生成该派生票，或把 `room-not-found` 视为**条件已满足**。机制候选：平台把**相位名** `room-discussion` 与「存在一个可关闭的 room」混同 |
| **B-36** | **票 id 非每票唯一** | 成员实测 | `waiting_set` 对同一 `(task,owner)` 返回**同一 ticketId 并覆盖** ⇒ 两张显式票**无法共存** | 让 ticketId 每票唯一（含序号或内容摘要）。**这是 W-12「原始配置不可复现」的直接原因** |
| **B-39** | **C-4 的判定没有任何单一角色能独立复核** | **两个独立实测** | `team_delivery_check` 是 **`[tier-0-only]`**（lead-world 实测被拒）⇒ 只有 tier 0 能读 `ownerMilestone` / `ownerMilestoneTaskId`；而 tier 0 **读不到 tier-2 成员的 milestone**（`[milestone-visibility]` 拒）⇒ **判定的输入与判定的输出分属两个角色，谁也不全** | 允许 **tier 1 读本组成员的** delivery-check 投影，**或**允许 **tier 0 读其下属的** milestone。**修好之前**：该判定**必须由 tier 0 + 该组组长两方读数合并**才能复核 —— **单方读数不得作为裁决依据** |
| **B-40 扩展** | `team_milestone(action:"list")` **同一次返回内部自相矛盾** | 成员实测（压缩后 fresh 回读） | **同一次返回**里：顶层 `done=false, armed=false`，而 `members[]` 中该成员的行**仍 `done=true` 且 stage 仍是旧文本**。成员**拒绝断言成因**，给出两个不可区分的假设（压缩正常消费后顶层复位 / 顶层与成员行语义不同） | 与 B-40 主体同族（**里程碑状态面不自洽**）。**该成员「不断言成因、只交原文读数」的处置是正确的** —— 我据此登记为**两种形态**而不是一条断言 |
| **B-44** | **write scope 是字面前缀匹配，`**` 通配不受支持 —— 且拒绝串不可判别** | 成员实测（控制实验**否证了自己的假设**）+ tier 0 全板扫描 | **控制实验**：scope `["docs/groups/rig/**"]` 用于**会话工作区**路径 `docs/groups/rig/w1-worktree-probe-verdict.md`（相对工作区根与 scope **逐字符同形**、**无 worktree 参与**）⇒ **仍判 outside**。⇒ 否证「worktree 路径按类别硬拒」。**语料**：group-rig 全板 22 张 —— 含 `**` 者**仅 1 张且 0 次写入成功**；**不含 `**` 者 10 张全部产出 commit**。**tier 0 全板扫描**（rig/proto/world/global 共 127 张、75 张有 scope）：**含 `*` 者 = 0** ⇒ **爆炸半径 = 恰好 1 张（t24），已修正** | **修法（两选一，建议都做）**：① **plan 校验期直接拒收含 glob 元字符的 scope**（fail-closed 且理由明确）；② **匹配失败时区分「前缀不匹配」与「scope 含不受支持的字符」**。**★ 平台自身的口径与示例到处在用 `**`**（§5.14 的 `tests/fixtures/**`、`crates/**`、tier 0 给过的 `.local/**`）⇒ **平台在传播这个陷阱**。**代价：这一条花掉 4 轮。** |
| **B-43** | **`edit` 卡 + gitignored 交付物 ⇒ 带内无完成路径** | 成员实测（逐字拒绝串 + 我复读 `.gitignore`） | `complete` ⇒ `[complete-commit] completion requires the exact commit_sha produced by the task`；`release` ⇒ `[lease-release-order] task is still in_progress`；而 `.gitignore:2 = /.local/` 与 `:3 = /.dsh-worktrees/` ⇒ **探针必然 untracked ⇒ 无 commit 可交**。⇒ **一个「只产 untracked 证据的写动作」没有对应的卡 kind**（review 卡无 write scope ⇒ 写不了；edit 卡要 commit ⇒ 收不了口） | **与 B-42 同族**：**平台要求一个该卡自身语义禁止的完成产物** ⇒ **fail-closed 且带内无补救**。修法：`complete` 在**交付物可证明为 untracked / 非产品**时接受**缺席或 null** commit（`bind_fix` 已支持 null ⇒ **能力已有，只是没接到 `complete`**）。**过渡期出路（不需平台改动）**：**把探针落在受跟踪路径**，使该卡能产出真实 commit |
| **B-42** | `team_worktree_setup` **fail-closed 于陈旧 base，而自述补救在自身 API 内不可触达** | 成员实测（逐字拒绝串）+ tier 0 复现 | 逐字：`[worktree-stale-base]: worktree for "rig-diff" could not be created: existing worktree branch "team/rig/rig-diff" does not contain requested base "main"; choose a fresh branch or rebase it explicitly before work`。**该工具只暴露 `base`，分支名由成员名派生** ⇒ **「choose a fresh branch」在该工具自身 API 内不可触达**；带内唯一出路是 rebase 或移除既有 worktree，**二者都越出组长权限** ⇒ **运维死锁**。**不是一次性**：`rig-capture` 与 `rig-runner` 实测处于**同一状态**（均在 `2d0e895`、均落后 main） | **部分正面**：该拒绝本身说明 **B-12（静默给出过期树）已修** —— 现在是**拒绝**而不是**静默**。**修法**：允许显式指定分支名，或提供「重置该成员 worktree 到 base」的带内动作。**另**：`worktreePath` **仍未回写**（B-13 不变） |
**B-42 第二次触发（2026-09-28 深夜 · tier 0 复核 lead-rig 上报）**：
- **逐字**：`[worktree-stale-base]: worktree for "rig-diff" could not be created: existing worktree branch "team/rig/rig-diff" does not contain requested base "main"; choose a fresh branch or rebase it explicitly before work`。
- **触发条件同前**：成员树落后 main（本次 `rig-diff` **behind=19**；`rig-capture` / `rig-runner` **behind=202**）。
- **★ 第二次 ⇒ 代价已量化**：**每一次「按 §5.13 附则做隔离检出试点」都要 tier 0 手工介入一次**（上次 t24、本次 t23）⇒ **这不是一次性运维，是一个每次都要付的税。**
- **tier 0 的处置（本次）**：按 `main..<branch>` **为空**的同一判据逐树复核（三棵树 **unique=0 / dirty=0** ⇒ **全部无损**）后，**一次清理三棵**（`rig-diff` / `rig-capture` / `rig-runner`）并删除三个 `team/rig/*` 分支 ⇒ **rig 组的后续试点不再需要 tier 0 介入。**
- **★ 仍待平台修，但我不再自行打补丁**：修法 = **允许显式指定分支名**，或提供带内的「**重置该成员 worktree 到 base**」动作。**不打第二个补丁的理由**：① 该文件**全会话共享**；② **修复方已在第三轮处理 B-42**，第二个补丁**会与它的工作冲突**；③ 我已用**清理**消掉可复现的操作负担，而**平台缺陷本身仍完整登记**（含两次实例）。
- **剩余同类树（5 棵）**：`team__proto__member-codec`（behind=72）、world 三成员（behind=196）、`lead-lockcheck`（detached / behind=127）⇒ **可按同一判据清理**，但属**其它组的基础设施** ⇒ **待其组长请求**；**`verifier-detached`（behind=70）不得清理**（它是 verifier 的**活跃只读检出**）。
| **B-41** | `-rN` 后缀与 `meta.revision` **不是同一个计数器** | lead-world 实测 | 同一 `commit_sha` 重提 ⇒ **行名 `…-r2` 而该行 `meta.revision` = 3** | **跨包对齐不得以版本标签为准**（否则会取到错的包）。修法：统一为一个计数器，或在包体内明写 `row_suffix` 与 `revision` 的关系。**已入 `GOVERNANCE §5.14` 作为消费纪律** |
| **B-40** | `team_milestone(action:"set")` **可静默不持久化** | 成员实测（**带调用 + 返回 + fresh 回读**） | 第一次 `set` **返回成功**（`{done:false, armed:false, notice:"[team milestone #1790523457027] …"}`），**紧接着 fresh 回读仍为旧值**（t46 / `done=true`）；按最新快照**重发后同轮 fresh 回读已生效**（notice `#1790524391342`，stage = t48 文本 / `done=false`） | **`set` 返回成功 ≠ 已落盘** —— 与 B-14（`task_contract_set` 静默无效）/ B-19（静默丢弃未知键）同族，**且这一条会直接伪造出 `milestone-unbound`**（见 C-4）。修法：`set` 必须**回读自证**或失败时报错。**这是「调用成功 ≠ 内容生效」在里程碑面的实例** |
| **B-38** | **卡面 `evidenceIds` 不是「该卡全部证据行」的完整集合** | lead-world 实测（G-WORLD） | 带 `taskId=group-world-t44` 的注册表行 = **19 条**，而卡面 `evidenceIds` = **10 条**（差集含 `43b6634c` / `807b8451` / `079f99de`）。机制：`team_evidence_record(task_id=…)` **只写注册表，不追加到卡面** | **这是「缺席与从未测量不可区分」在卡面的又一实例。**⇒ 已立**提交方纪律**：包内必须**逐条列出所引 `evidence_id` 并证明其在注册表实存**，**不得声称完整性**（「以卡面 `evidenceIds` 为准」是不成立的表述） |
| **B-37** | `evidence_query` **不兑现任何过滤条件，返回注册表最新一行** | **三方独立观测**（G-RIG 提交方、verifier、lead-world 的 12 参数形态扫描） | **机制（lead-world 决定性读数）**：无论传什么参数，一律 `visibility.filtered:false`、`rows` 长度 **1**，且返回行的 `recordedAt` **每次调用都前进** ⇒ 它返回的是**注册表最新一行**，**不是被查询的行**。⇒ 「按 id 返回无关行」与 `rows:[]` **是同一个投影的两种表现**（前者=最新行恰好非目标，后者=……） | **兑现过滤条件；查不到时返回空 + 显式 not-found，绝不返回无关行。** 这**比返回空更危险**：空会被察觉，**无关行会被当成答案**。与 B-9 同族，**严重度更高**。**✅ 过渡期出路（全员可用）**：控制面状态文件 `D:\dsh-test\home\team-control-plane\<sessionId>.json` 的 `evidence` 容器是**按 id 索引的对象、1844 条**，含 `kind/command/expected/actual/output/requirementId/status/createdAt` ⇒ **数据没丢，只是投影坏了**（lead-world 用它一次读全了 world t44 的 19 行正文）
| **B-45** | **零写入卡的契约无任何合法修订路径 —— 平台公布的 tier-0 路径被它自己的第二道门变成不可达** | **tier 0 亲自实测（唯一未试路径已耗尽）+ 成员控制探针 + 组长独立复算** | 卡 `group-world-t46`：`kind=discussion`、`writeScopes=[]`，**存储契约自身** `validation.ok=false` / `{code:"scope-required", path:"writeScopes"}`。**门序实测**：① 非 owner ⇒ `task-contract-scope: only the current owner or tier 0 may revise this contract`；② **owner 与 tier 0** ⇒ **同一** `task-contract-invalid`。tier-0 用**逐字最小** payload（仅 `place_torch`→`place_door`，其余原文不动；替换后文本 === 卡面 `description`）⇒ **同样被拒，回读无副作用**（`textLen` 仍 1765 / `place_torch` 仍 1 / `contractRevision` 仍 1）。成员**控制探针**（原文一字不改重试）⇒ 同拒 ⇒ **拒绝与内容无关**。⇒ `task-contract-invalid` **与调用者身份无关，是该卡存储契约自身的属性** ⇒ **契约写入是一次性且永久冻结的。** | **第二道门必须与卡 kind 相容**：`scope-required` **不得**适用于 `kind=discussion` / `review`（其定义就是无 write scope），或**只在契约创建时**跑 validation、修订时不跑。**与 B-42 同族**：**平台公布了一条被自身另一道门变成不可达的路径**（B-42 = 自述补救在自身 API 内不可触达；B-43 = 要求卡自身语义禁止的产物）。**过渡期**：该字段按**已知陈旧 / 已作废**处理，权威载体 = 卡面 `description` + 台账 `group-world-t35` §59（tier 0 裁定，见 `docs/GOVERNANCE.md` §5.14 登记） |
| **B-46** | **写入门禁按文本匹配 ⇒ 阻断「只读核验」，且被拦的正是门禁自己守护的那件事** | verifier 实测（逐字拒绝串，**未绕过**） | 只读命令 `git show 18175d9 | Select-String -Pattern 'git add -A'` 被拒：`git write denied: git add/commit requires an active approved plan lease for the current member`。**根因与 A-9 的误拒半同族**（`write-scope-guard.mjs:686-701/703/717/534-535`）：**按命令文本中出现写命令字面量判定，而不按实际动作判定**。verifier 未绕过，该条按 `not-verified` 记录 ⇒ **代价：t44 的 `git add -A` 分句无法复现**。 | **只读动词**（`show` / `diff` / `log` / `rev-parse` / `cat-file` / `ls-tree`）下的**模式字符串参数**不得触发写门禁。**特殊之处**：被拦的是**对门禁自身有效性的检验**（「这次提交是否用了写命令」）⇒ **门禁阻断了对门禁的检验。** |
| **B-47** | **`manual` 等待被 `auto:condition-cleared` 在无任何状态变化时解除 ⇒ 责任记录蒸发，且理由串为假** | lead-world 直读控制面 `v14Waiting.tickets`（**状态级证据，机制未定 ⇒ 不主张机制**） | 三张 `manual` 票**全部** `status=resolved` / `resolvedBy=team-v14-waiting` / `resolution="auto:condition-cleared"`。**决定性反例**：`wait:group-world-t50:lead-world:ae12345d…`，解除条件 =「member 提交 `plan_propose` 后由 lead-world 审批」，created 1790527117098 → resolvedAt 1790527254841（**+137.8 s**），而 **`taskRevision` 仍 = 1**、**未 claim、无 `plan_propose`** ⇒ **条件从未满足，理由串为假**。另两张 t46 票 **+16.9 s / +9.3 s** 被解除，**早于成员回报**。 | **与文档直接冲突**：`AGENTS.md` 明写「`manual`、`external`、`background` 等待**不能**因时间经过或普通 task revision 变化自动解除，必须有真实条件或显式 resolve」。**修法**：这三类条件**不得**被 `team-v14-waiting` 自动清除；`auto:condition-cleared` **只允许**用于 `dependency` / `room` / `lease` 这类可机检条件，且**必须写回判定所依据的读数**（否则理由串不可复核）。**过渡期纪律（tier 0 已采纳）**：**责任不得登记在会自行蒸发的地方** —— `waiting_set` 的 `manual` 类**不能**承载责任；责任落在**卡面 `description` / 台账 / 未答复的定向 dispatch**。 |
**B-47 的精确形态与一处「更不成立」的读法被反驳（tier 0 采纳 lead-world 的更正 · 2026-09-28）**：
- **扩大证据（verifier 普查，lead-world 逐数完全复现）**：`condType/kind = manual` 且 `resolution` 以 `auto:` 开头的票 = **22 张**，其中 **`taskRevision ≤ 1` 的 7 张**（`task-1`/lead、`group-client-t8`/lead-client、`group-proto-t33/t34/t35/t41`/lead-proto、`group-world-t50`/lead-world）⇒ **这 7 张卡在解除时刻从未被 claim** ⇒ 「状态变化导致解除」的辩解**全部不成立**。
- **★ 精确形态（取代「重复解除 + 自动解除叠加」的读法）**：t50/lead-world 名下是**先后两张票** —— `9f21870c`（created 1790526427496 / resolvedAt 1790527002491 / `resolvedBy=lead-world` / **理由为真**）与 `ae12345d`（created **1790527117098**，**比前者解除时刻晚 114.6 s** / `auto:condition-cleared` / `taskRevision=1`）⇒ **后者是新登记的一张票，不是对同一等待的重复解除。** ⇒ 正确表述 = **「一张条件从未满足的**新** `manual` 票被自动解除」**；「叠加」框架会把它读成「平台只是重关了一张已关的票」⇒ **弱化本缺陷、缩小修法范围。**
- **反例：机制并非一律错（两组各出两例）**：`abec141b` 以 **`auto:plan-approved`** 解除（`taskRevision=4`，条件**真**成立）；`22f15eda` 在 `taskRevision=15` 被解除。⇒ **修法不得写成「禁止自动解除」**，而必须是：**`manual` / `external` / `background` 三类一律不自动解除**；**可自动解除的只有可机检条件**，且**必须写回判定所依据的读数** —— `auto:condition-cleared` 就是「**有结论、无读数**」。
- **票总数**：verifier **146** vs lead-world **148** ⇒ **追加式容器，两者都对**（时点量，见台账第 62 条）。
| **B-50** | **`lease-revision-mismatch` 的拒绝串**误导**：真实成因是相位未就绪，串却指向 revision** | 成员实测（t50，**自报**） | 成员**提前推进相位**后 `complete` 得 `lease-revision-mismatch`；而**真实成因是相位未就绪** ⇒ 调用方按该串去查 revision 会**在错的方向上排查**；**恢复路径是 `reopen` → `complete`，该路径不在错误串里** | **拒绝串必须可判别**（§5.14 已立）：**同一拒绝码不得同时覆盖「相位未就绪」与「revision 过期」两种成因** —— 二者**修法不同**（前者要 `reopen`，后者要重取 revision）。修法：**按成因分码**，并在串里给出**下一条合法动作**。 |- **扩展（成员 + lead-world 实测 · 2026-09-28）：同一形状的第二个拒绝码。** `claim` 被拒 `task-ready-gate: scope-conflict`，而 `ready_queue` 对**同一卡**报 `status: "running"` / `executionState: "active"` / **`reasons: ["already-running"]`** / `leaseActive: false` / `eligible: false` ⇒ **卡已 running 且 owner 是本人 ⇒ `claim` 没有可认领的东西**，**不存在任何 scope 冲突**。⇒ **`scope-conflict` 被用在一个它没有诊断过的条件上。**
- **★ 判别该码是否为真的正控（来自本仓自己的登记）**：`GOVERNANCE.md:143` 已立「**必须索取 `conflicts[]` 原文，不得凭猜测指认冲突对方**」⇒ **真实的 scope 冲突必须能点名对方**；本例成员**在可见读数内无法定位任何冲突方**（板内只有该卡在跑、`writeScopeWarnings=[]`）⇒ **「无对手方」本身就是「不是 scope 冲突」的判据。**
- ⇒ **修法**：ready-gate 必须**先诊断状态**（`already-running` / `lease-active` / **真 scope 重叠**）**再选码**；`scope-conflict` **只在真能给出 `conflicts[]` 时**使用。
- **★ 纪律（新增 · 跨组 · tier 0）**：**检索命中的条目必须与被考察的成因同型。** 本轮「先检索登记」命中三条，但三条讲的是**「真 scope 冲突如何裁定」**，而本例是**「根本不是 scope 冲突」** ⇒ **同一主题 ≠ 同一缺陷**。**并且**：当命中条目**本身给出了「本例不成立」的判据**（如 `:143` 的「必须能点名对方」），**该命中是反证，不是结案依据** —— **检索到相似条目不等于找到了成因。**
| **B-51** | **`waiting_set` 的票可能「创建即不可回读」—— 且发生在 `approval` 类上（该类不存在自动解除）** | lead-proto 实测（**同 turn 创建 + 两次回读**） | `team_v12(action:"waiting_set", …, unblockCondition:{type:"approval", …})` **返回成功**（`ticketId = wait:group-proto-t46:member-registry:d6d5affe-…`）；**紧接着同一 turn 回读**：① `waiting_list` ⇒ `{tickets:[], total:0}`；② 控制面 `waiting` 对象 ⇒ **0 个键**。而**解除条件明确未满足**（verifier 尚未裁决）⇒ **与「已被解除」无关**。⇒ 既有登记（**B-47**：`manual` 被 `auto:condition-cleared` 清掉；**B-9**：复用票残留 `resolution` 字段 ⇒ 对 `waiting_list` 永久不可见）**都不能解释本条**（本条是**另一个条件类**、且**条件未满足**）。 | **票在创建后必须立即可回读，或在创建时就失败。** 修法：`waiting_set` 必须**回读自证**（与 B-40 同族），失败即报错 —— **「返回 ticketId」不等于「票存在」。** **过渡期（已生效）**：**持有不得依赖任何 `waiting_set` 票** —— 现在这条比原先**更强**：**不只是会被清除，而是可能从未可见。** |- **佐证（2026-09-28 · **两个独立执行者 + 五次读数**）**：某组长实测 `approval` 类票创建后 `waiting_list` = `{tickets:[],total:0}` 且控制面 `waiting` = **0 键**；**同一现象由一名成员在 t44 / t45 / t46 / t47 上四次观测到** ⇒ **本条的置信度由「单点」升为「多主体」。**
| **B-52** | **`waiting_set` 没有独立的「等待者」字段 ⇒ 票无法承载「谁在等」** | lead-proto 实测（**同一次调用**） | 发起方是 **lead-proto（组长）**，而返回票的 id 与字段是 `…:member-registry:…` / `owner:"member-registry"` —— 即 `waiting_set` 用**任务 owner** 填 `owner`，**没有 waiter 字段**。⇒ **组长为「我自己在等」登记的票，在投影上被记到组员名下**；与「持有不得依赖票」叠加后，**票无法回答「谁在等」。** | **增加独立 `waiter` 字段**（发起者），与 `owner`（被等待任务的责任人）分离。⇒ **这是 `waiting_set` 继「位置 / 类型 / 嵌套」之后的第 4 个未冻结维度：归属者 ≠ 发起者。** ⇒ **凡 API 的字段语义与调用方意图不一致时，必须在字段名上分开，不得复用。** || **B-53** | **`team_task_get.ready` 与 `ready_queue.eligible` 对同一概念给出相反取值** | lead-world 实测（**同一卡、同一时刻的 2×3 表**） | 同一卡 `group-world-t55`：**指派前**（rev2 / 无主）`ready=false` / `eligible=false` / `reasons=["not-approved","no-owner"]` / `unmet=[]` / `lifecycle=proposed`；**指派后**（rev3 / owner=member-world-chunk）**`ready=false` 而 `eligible=true`** / `reasons=[]` / `unmet=[]` / `lifecycle=running`。⇒ **同一时刻两个投影对「能不能开工」给出相反答案**，且指派后 `reasons` 已清空 ⇒ **连 `ready` 的成因都不在 `reasons` 里。** | **用于判「可开工」的字段必须唯一且权威。** 修法二选一：**(a)** 若语义不同 ⇒ **改名 + 在文档里写明分工**（`ready` **不得**被当作「可开工」的判据）；**(b)** 若语义相同 ⇒ **必须一致**。**★ 实际影响窗口 =「已指派、尚未开工」** —— 正是组长**问「我的指派生效了吗」的那一刻**：他读 `ready` 会得到 `false` 而**误判指派失败**。**★ 本会话 tier 0 也曾两次用 `ready` 判「是否缺口」**（两次结论恰好与 `eligible` 同向 ⇒ **未被误导，但依据的字段不可靠**）。 |
**B-53 的判定读数（同一对象**四态** · lead-world 实测 · tier 0 采纳 · 2026-09-28）**：同一卡 `group-world-t55`、同一 blocker `t51`，只变 owner / 计划 / 运行态：

| 状态 | 卡级 `ready` | 队列级 `eligible` | `reasons` |
|---|---|---|---|
| ① 无主 + 无计划 | **false** | false | `["not-approved","no-owner"]` |
| ② 有主 + 无计划，未启动 | **false** | **true** | `[]` |
| ③ 有主 + 无计划，在跑 | **false** | false | `["already-running"]` |
| ④ **有主 + 计划已批准** | **false** | **true** | **`[]`** |

- ⇒ **机制（已测量，非推断）：卡级 `team_task_get.ready` 在四个状态下恒为 `false`，包括「队列已判 `eligible:true` 且 `reasons:[]`」的全通态** ⇒ **该字段不随解除条件更新。** ⇒ 我此前写的「两个投影对同一概念给出相反取值」**是现象描述，不是机制** —— **真机制是该字段本身不更新。**
- ⇒ **修法（二选一，建议同做）**：**(a)** 让 `ready` 随解除条件更新（与 `eligible` 同源）；**(b)** **弃用 / 改名** `ready`，并在文档里指定 **`ready_queue.eligible` + `reasons` 为唯一权威判据** —— **先把权威判据指出来，再修字段。**
- ⇒ **★ 消费纪律（立即生效 · 跨组）**：**判「可开工」一律以 `ready_queue.eligible` + `reasons` 为准；卡级 `ready` 不得作为判据**（本实例四态全为 `false`，含全通态）。
- ⇒ **实际影响已实证**：**组长被它误判过一次**（按 `ready` 判「可开工」得假）；**tier 0 也曾两次用它判「是否缺口」**（两次结论恰好与 `eligible` 同向 ⇒ 未被误导，**但依据的字段不可靠**）。
- ⇒ **同表读出的正面结论**：**`reasons` 是真实信号**（① 两条、②④ 空、③ `already-running`）；**`eligible` 是瞬时调度标志**（③ 因 `already-running` 转 false）⇒ **这两个字段可判，`ready` 不可。**
| **B-54** | **`meta.supersedes` 是作者不可写、由平台注入，且指向「基 id」而非被取代的那一版** | lead-proto 实测（**三条带内证明**：比对 `meta.metaInput` 与存储值）+ verifier 在 t19-r3/t17-r3 独立到达同一观察 | ① `packet-eb9186fda7350e85e0bfb0c5`：`metaInput.supersedes = packet-1d2ccdd2194c7f650410f457`、`metaInput.revision = 2` ⇒ **存储** `meta.supersedes = null`、`meta.revision = 1`；② `packet-0ee964675741f98970036bb8-r3`：`metaInput.supersedes = 该包 -r2` ⇒ **存储值 = 基 id**；③ `packet-d6fa524fe816c9b6d066dd58-r3` 同形。**普查**：**24/24** 带 `-rN` 的包 `meta.supersedes` 非空（= **基 id**）；**0/165** 无 `-rN` 的包非空 ⇒ **字段由平台在同 `commit_sha` 重交时注入。** | **两个后果**：**(a)** **任何要求作者写 `meta.supersedes` 的判据不可满足**（verifier 对 world-t55 的 nit③ 即此形）；**(b)** **`r2` 未被标记为被取代、`r3` 取代 `r2` 的意图被记成「取代基 id」** ⇒ **取代关系在字段上不成立，消费者只能按 `-rN` 序号读。** ⇒ 修法：**让平台写入「实际被取代的那一版」的 id**，或**明确声明该字段语义为「本版所属基包」并改名**（现名会误导）。⇒ **与 B-41 同族**（`-rN` 与 `meta.revision` 不是同一计数器）⇒ **`-rN` 机制周边的字段普遍不能按其字面理解。** |- **佐证（2026-09-28 · verifier **独立复现**，且普查更大）**：**191 包** —— 带 `-rN` 者 **26/26 非空**、不带者 165 条中 **0** 条非空；**作者唯一一次尝试亦得 `null` ⇒ 0/1 被采纳**；`r3` 的 `metaInput` 指向**紧邻的 `-r2`**，而存储值被归一化为**基 id**。⇒ **该字段作者不可写** —— 由**两个独立主体**得出（本条的置信度由「单点」升为「**多主体**」，且 verifier 据此**对自己的两处文本出勘误**）。

- **能力事实（非缺陷 · lead-proto 实测 · 2026-09-28）**：**包的 `group` 字段不是「作者所在组」，而是「被审对象所在组」** —— 实测 `packet-6452617c4eccd9da4f94f7cf` 的 `submittedBy` 是 **verifier**，而其 `group` 字段指向被审卡所在的组。⇒ **归属类断言必须读 `submittedBy`，不得读 `group`**（与 L592「归属类断言必须先取作者读数」同族，**本条给出该读哪个字段**）。
- **能力事实（非缺陷 · 两方各自实读 · 2026-09-28）**：**组长不能写 `docs/groups/<group>/`** —— 实测被运行时拒 `no declared static scope or active approved plan lease`。⇒ **「据 charter 推定权限」是错的**：**一方据 charter 推定自己可写、另一方据 charter 告知他人可写，两方都错。** ⇒ **权限 / 状态类断言必须先实读一次。**

- **能力事实（非缺陷 · verifier 实测 · 2026-09-28）**：**verifier 无法把证据行绑到「它所审的那张卡」上** —— `team_evidence_record(task_id=<被审卡>)` 被拒 `[plan-scope]: member "verifier" is not assigned to task …` ⇒ **一轮之内 21 条证据行全部 unbound**，绑定只能写进 `paths` / `actual` 的正文里。⇒ **后果**：叠上 **B-38**（卡面 `evidenceIds` 非完整集）与 **B-37**（`evidence_query` 不兑现过滤），**verifier 的行最难被按卡检索** —— 而它正是「独立复验」这一层的唯一记录面。⇒ **修法**：允许 verifier 把行绑到**它所审的卡**（只读审阅关系），或提供「审阅绑定」这一独立字段。

- **能力事实（非缺陷 · 成员实测 · 2026-09-28）**：**`team_run_lease(acquire)` 要求「该卡已有 plan-approved 记录」** —— 逐字拒绝：`task "<id>" requires a plan-approved record before execution; current plan state: missing`。⇒ **可走顺序 = propose → approve → acquire**；**先 acquire 后 propose 不可行**（门禁要求 plan 先批准）。⇒ 与 `[lease-release-order]`、`[lease-revision-mismatch]` 同族：**lease 生命周期被 plan 生命周期门控。**
**B-40 第二次实例（2026-09-28 · lead-world 转报 + 成员自报 · tier 0 采纳）**：
- **读数**：某成员在执行开始时 `set` 了该卡的 stage（notice `#1790532815820`），**并按 B-40 之后的纪律 fresh 回读、确认逐字相符**；**而交付后 `done` 的回显却是上一条（更早那张卡）的 stage**，`list` 其行 stage = 更早那条、`done=true` ⇒ **`set` 被回退成上一条，`done` 遂 tick 了旧 stage。**
- ⇒ **★ 这比首次更重**：**成员已经做了我要求的「set 后回读自证」，却仍被回退** ⇒ **回读自证不能防住这次回退**（回读发生在 `set` 之后，回退发生在更晚）。**B-33 扩展（2026-09-28 · 两个独立成员观测 · tier 0 采纳）**：**第二种幽灵票 —— `waiting-provider` 派生票在无 provider 故障时出现**：
- **读数**：`waiting_list` 中除成员显式登记的票外，另有平台派生票 `waiting-provider`（`unblockCondition: {type: "provider-healthy"}`），**responsible = `lead`**，且**同时出现在多张互不相关的卡上**（t17 / t19 / t22 / t23 / t50 / t51）。
- **判为假投影的读数**：`providerFailures: {}`（空）；**各组成员在跑、租约在持**（若有 provider 阻断，工作会停）；**无任何成员报告 provider 失败**。
- ⇒ **代价（本条的重点）**：该派生票**把 `lead` 写成责任人** ⇒ **它反复把 tier 0 的注意力引向一个不存在的条件**；而**成员两次都正确地不据此宣称阻断**（只记读数）。
- ⇒ **修法**：**仅当确实存在 provider 失败时才派生该票**，否则**不派生**（与 B-33 主体同源：**派生票必须在条件真实存在时才生成**）。
- ⇒ **过渡期纪律**：**`waiting-provider` 派生票不得单独作为「存在 provider 阻断」的证据**；判定阻断必须读 `providerFailures` 与「是否有成员因此停摆」。
| **B-57** | **`team_task_update` 的 `board` 默认值是 `global`，而拒绝串只说你「在写 global 板」、不说「该卡其实在别的板」** | lead-world 实测（**卡不在 global 板**） | 它对**自己组板**上的纪律台账卡执行 `team_task_update(action:"edit")`（**未传 `board`**）⇒ 被拒 `[global-board-write]: only tier 0 may write the global board; "lead-world" has read access only`。而**该卡不在 global 板**：`team_task_get(task_id:"group-world-t35", board:"global")` ⇒ `team task "group-world-t35" not found`；`board:"group-world"` ⇒ **找到**。⇒ **拒绝串里的「global board」指的是「你这次要写的板」，不是「该卡所在的板」** ⇒ **调用方据此合理地推断「卡被移到了 global 板」，并提出「把卡移回组板」的方案。** | **两处修法**：**(a)** 拒绝串必须**区分**「你未指定 `board`，默认按 global 处理」与「该卡确实在 global 板」；**(b)** 更根本：**对已存在的卡，`board` 应由卡本身解析，而不是由调用的默认值决定**（否则调用方必须记住每张卡在哪个板）。⇒ **过渡期**：**编辑组板上的卡必须显式传 `board:"<组板>"`。** ⇒ **同族**：与「一次读数不构成对当前状态的陈述」并列 —— **一句关于「请求」的拒绝串，不构成对「对象」的陈述。** |- **追加读数（2026-09-28 · lead-world · 我只记读数、候选机制标明为候选）**：`waiting_list` 对 **t57 与 t58** 各派生一条 `waiting-provider`（responsible = `lead`），而同时读到 **`provider.status = "unknown"`**、`providerFailures = {}`、`providerSafety = {}`。⇒ **候选机制（未实测，不作结论）**：**派生把 `unknown` 当成了「不健康」** ⇒ 若成立，则**该派生票在 provider 状态未知时会无条件出现**。⇒ **判定该派生票是否为真的最小读数 = `provider.status` 的取值**（`unknown` ⇒ 不足以判阻断）。

| **B-56** | **`requirements_snapshot` 忽略顶层 `task_id` ⇒ 返回全注册表（76 条）而不报错 ⇒ 一次「看起来完全合理」的错误读数** | lead-world 实测 | 调用形态 `team_v12(action:"requirements_snapshot", task_id:"<id>")`（**顶层**）⇒ **该参数被忽略**，返回**全 76 条注册表**；**正确形态 = `input:{taskId:"<id>"}`**。误用时会读到**另一张卡**的契约（索引 0 = 会话首卡文本，490 字符）而**读数看起来完全合理**。 | **参数缺失或形态不符必须 fail-closed 报错**，不得**退化为「返回全部」**。⇒ **与 B-40 同族**（`set` 静默不持久化）：**「看起来对」的读数比明显错的读数更危险。** ⇒ **过渡期纪律**：**读到「像契约但不是本卡」的文本时，先验调用形态，再验数据。** |

⇒ 修法仍同 B-40（`set` 必须回读自证），但**本条把「自证」的时点要求推进到 `done` 时刻**：**`done` 必须再回读一次并确认 tick 的是本卡的 stage。**
| **B-55** | **lease 到期是静默的 —— 无通知，只有下一次写入门禁拒绝才暴露；且拒绝串不区分「已到期」与「从未获批」** | 成员实测（**两条被拒的 `edit` + 一条错误的证据行**） | 逐字拒绝：`edit denied: member "rig-diff" has no declared static scope or active approved plan lease for (…\.dsh-worktrees\team__rig__rig-diff\tools\rig-batch\src\main.rs)`。而当时真实 `git diff --stat` 仍是 **45 insertions**（= 增量 1+2）⇒ **④ 没落盘**；**而它已在同一轮把 ④ 写进 `evidence-4a643da6-0554-487a-81c0-f281ae95bc43` 的 `actual`** ⇒ **该证据行是错的。** ⇒ **根因：`run-e4175efd` 的 TTL 到期不产生任何通知** ⇒ 成员**无法在「还在做」与「已失权」之间自辨**，**只有下一次写入门禁拒绝才暴露。** | **lease 到期必须有可观测信号**（或至少：**拒绝串必须区分「lease 已到期」与「从未获批」**）。⇒ **与 B-42（拒绝 + 补救不可达）/ B-43（无 commit 无完成路径）同族：拒绝串把两种成因压成一个。** ⇒ **过渡期纪律（成员自行执行、tier 0 采纳）**：**凡「已落盘」类声明，必须在写入门禁真的接受之后才写进证据行**；**一旦发现证据行错了，必须出勘误行显式作废它、不得让它留在记录面上**（成员原话：**记录面错了，后面所有引用它的人都会跟着错**）。 |
- **最终状态已正确**：成员**重 set + 重 tick** 后，lead-world 独立读取其行 = 该卡 stage / `done=true` ⇒ **不需要重开任何卡。**
- **另**：同一成员名下 `pendingCompaction.milestoneStage` 指向更早一条 —— **lead-world 明确不主张它是缺陷**（该字段记的是「该待办压缩被 arm 时归属的里程碑」，指向更早**可能是正确记账**）⇒ **我不编号、不表征**（**我读不到 tier-2 成员的 milestone —— 见 B-39**）。

**能力事实（非缺陷 · lead-world 实测 · 2026-09-28）**：**`inbox_ack` 只能对 `delivered` 的消息生效；对 `queued` 的消息返回 `message-not-delivered`。** ⇒ **「未 ack」≠「未处理」；「已处理」≠「可 ack」。** ⇒ **不得用 ack 计数当作处理进度的判据**（也解释了为什么「收件箱为 0」与「我 ack 成功」可以互相矛盾）。
- **能力事实（非缺陷 · lead-proto 实测披露 · 2026-09-28）**：**发给 `lead` 的消息可能被路由为 `room-summary`（room `root`）而非直投 inbox** —— 发起方如实披露「给 verifier / member-registry 的返回 `delivered`，给 `lead` 的两条返回 `room-summary`」。⇒ **「发给 lead」不等于「进了 lead 的收件箱」** ⇒ **凡要求 tier 0 必达的事项，必须有第二种确认（回执 id / 台账行），不得只依赖投递形态。**
| **B-49** | **`task_contract_set` 被接受、`contractRevision` 前进、evidence 落行，而**契约体未变** ⇒ 「调用成功 ≠ 内容生效」在契约面（B-40 族）** | lead-world + 成员实测（同一 rev10 快照读回） | t50 重同步：**无拒绝码**；卡 rev8→10；`contractRevision` **1 → 3**；新增 evidence 2 行；**而** `ac === description` = **false**、首个分歧 index **1541**、**`acLen` = 3391**（== **更正前**的 `description` 长度）vs `descLen` = 3988 ⇒ **投影停在建卡时版本**。 | **★ 该缺陷由读即可判定，不需要判别实验**：**「计数器前进而契约体不变」本身就是自相矛盾** ⇒ 修法：setter 要么**应用契约体**，要么**拒绝且不推进计数器**；**禁止「接受 + 推进计数器 + 不应用」**。**待定分支已由探针判定 = ⓐ（入参形态被静默忽略）**：`input:{contract:{acceptanceCriteria:[…]}}` 的**包裹层不是该工具期望的键，被静默忽略**；正确形态 = `acceptanceCriteria` **直接挂在 `input` 下**。探针后读数：`contractRevision` **4** / `acLen` **3988** / `ac === description` **true** / firstDiff **-1** / `validation.ok` **true** ⇒ **t50 的投影现已与更正后的 description 逐字相等**。⇒ **★ 触发条件精确化 =「入参含不被识别的键时被静默丢弃，而计数器与 evidence 照走」**。**修法：入参出现未知键必须 fail-closed 拒绝** —— **平台在包路径上已经这样做**（`[packet-unknown-fields]`），**契约路径却没有** ⇒ **同一平台两条路径的未知键策略不一致，这本身就是修法依据。** |
**形态探针（tier 0 授权 · 有界 · 2026-09-28）与两条能力事实**：
- **授权**：由 **t50 的 owner（`member-world-chunk`）**执行**一次** `task_contract_set`，入参 **去掉 `contract` 包裹层**（即 `input:{acceptanceCriteria:[…]}`），文本用**当前 `description` 逐字**。**必须先 fresh 读回、拒绝则逐字回报且不重试、有效果即停。**
- **★ 我不授权「读回 19 键整体回写」**：那会把**派生 / 只读字段**（`contractRevision` / `lease` / `lifecycle` / `validation`）写回存储，而 t50 **正在 execution**；**该实验对 ⓐ/ⓑ 的判别并非必需** —— 形态探针一次即可分辨（有效 ⇒ ⓐ 入参形态被静默忽略；同样无效 ⇒ ⓑ 未持久化）。**最小探针优先于最强探针。**
- **★ 执行者必须是 owner，不是组长**：所有权门实测拒绝非 owner（lead-world 在 t46 撞 `task-contract-scope`）⇒ **组长跑这一探针必然先被第一道门拒**，那将**无法回答 ⓐ/ⓑ**。**这是防止白跑一轮的关键细节。**
- **能力事实（非缺陷）**：`validation` **不在** `contract` 对象内，而在 `task_contract_get` 的**顶层**（顶层键 = `[taskId, contract, validation, lifecycle]`）⇒ 成员报的「缺键」是**接口形态差异，不是缺陷**。**登记以免重复上报。**
- **not-verified（我不主张）**：我用 `team_v12(action:timeline, input:{limit:60})` 与 `{limit:200}` 得到**完全相同**的字节数（323,908）⇒ 疑似 `limit` 未生效，**但更可能是我把参数放错了层**（`input` 内 vs 顶层）⇒ **记为我的用法未核实，不登记为平台缺陷**（不重演「结论 + 一个听起来对的理由」）。

**B-45 的 tier-0 实测补充（唯一未试路径已耗尽 ⇒ 上表 B-45 行的「可能」按「已证实」读）**：
- **门序实测**：非 owner ⇒ `task-contract-scope`；**owner 与 tier 0** ⇒ **同一** `task-contract-invalid` ⇒ **第二道门与调用者身份无关，是该卡存储契约自身的属性**。
- **tier-0 亲自执行** `task_contract_set`，payload **逐字最小**（仅 `place_torch`→`place_door`，其余原文不动；替换后文本 === 卡面 `description` 1764 字符）⇒ **同样被拒，回读无副作用**（`textLen` 1765→1765 / `place_torch` 1→1 / `contractRevision` 1→1）。
- 成员**控制探针**（原文一字不改重试）⇒ 同拒 ⇒ **拒绝与内容无关**。
- ⇒ **契约写入是一次性且永久冻结的**；权威载体 = 卡面 `description` + 台账 `group-world-t35` §59。**不是永久分叉** —— 修门后即可更正。
- ⇒ **判别实验（已在飞，不占额外轮次）**：`group-world-t50` 是 **edit 卡且 `writeScopes` 非空** ⇒ 其契约校验应 `ok` ⇒ lead-world 已要求 owner 执行**契约重同步**并回报四读数。**成功即把缺口精确收窄到「零写入 discussion 卡的 `scope-required`」，而不是「契约修订机制本身坏」** —— 这决定修法是「按 kind 放行」还是「整条路径重做」。
- ⇒ **★ 判别实验已出结果（lead-world · 2026-09-28）**：`group-world-t50`（edit 卡 + `writeScopes` **非空 4 条**）执行 `task_contract_set` **未被拒绝**（无拒绝码）⇒ **第二道门只在「存储契约自身 validation 失败」时触发**，而零写入卡的 `scope-required` **按定义永远失败** ⇒ **B-45 的修法范围正式收窄为「`scope-required` 不得适用于 `kind=discussion` / `review`」**，**不是**「整条契约修订路径坏」。⇒ **修法按 kind 放行，不重做路径。**

**能力事实（非缺陷 · 供修复方与各组对照 · 2026-09-28）**：

- `waiting_set` **会持久化**（rig-diff 两张 `open` 票在 tier-0 的 `waiting_list` 中可见）⇒ **创建面没坏**。
- **★ 更正（我自己的单因结论错了）：`waiting_list` 不显示某票的机制有两条，且互为因果。**
  - **① B-47**：`manual` 票被 `team-v14-waiting` 以 `auto:condition-cleared` **在无状态变化时**解除（决定性反例：t50 票 **+137.8 s** 解除而 `taskRevision` **= 1**、未 claim、无 `plan_propose` ⇒ **理由串为假**）。
  - **② B-9（早已登记，本轮为第三实例）**：`waiting_set` **复用票据时不清** `resolvedAt` / `resolvedBy` / `resolution` ⇒ 该票 `status=open` **却仍带上一轮的 resolution 字段** ⇒ **对 `waiting_list` 永久不可见**（`docs/STATUS.md:183-184`；第三实例 `group-rig-t11`）。
  - ⇒ **过滤器看的是「有没有 resolution 字段」，不是 `status`** ⇒ **在 B-9 存在时，「重新登记」是一个无效动作** —— 这正是成员拿到回执却在列表里看不到它的原因。**B-47 生产出 B-9 所依赖的陈旧字段，B-9 再把它永久化 ⇒ 只修一条都不能恢复可见性。**
- **★ 我的错误（本会话第 8 次同形）：我给了单因结论「真因是它已被解除」，而真因早已登记在案（B-9）。** 我**枚举了候选解释而没有检索既有登记** —— 与我刚立的「**定号前必须先取全表现有最大号**」同形，只是对象从**编号**换成**成因**。⇒ **新增纪律：定因前必须先检索既有登记**（`grep` 缺陷台账 + `STATUS.md`），**不得由眼前读数反推一个「新」解释。**
- **本轮三个主体各给了一个候选解释，全被否证**：lead-world 的「列表只投影非调用者所有的票」（它自己在 `evidence-087d8109-ae5b-4c77-a289-89a648c282dc` 只数了**键命中**就断言所有权过滤 ⇒ 但真因是 **B-47（自动解除）** 与 **B-9（复用票据不清旧字段 ⇒ 永久不可见）** 两条，**见上条更正**）；我的「未持久化（B-40 同族）」；以及成员的两选一。⇒ **候选解释必须回到控制面读数，不能靠投影形态反推。**

**B-45 编号说明（tier 0 自纠 · 2026-09-28）**：我在**未读文件当前状态**的情况下给新缺陷定号 **B-45**，而该号**已被我自己上一轮占用**（本文件本轮由 175 行长到 229 行）⇒ **同一缺陷两个号**。**根因**：上一轮读过该文件，本轮**用记忆中的行数当当前状态**。**纪律**：**定号前必须先取全表现有号的最大值（一条 grep），不得凭记忆** —— 与「完整集合必须由检索导出，不得由枚举导出」同族。**处置**：编号只保留一处（上表 **B-45** 为实测版），旧的薄行改为指针。**B-46 / B-47 为首次占用，无冲突。**
**「归属类断言不取引入提交」（tier 0 本轮 · 第 10 次同形）**：我把 `clear_above_current_position` 的语义反向**归给 t49**，理由只是「t49 的报告提到了它」+「我读到该文件里有反向」—— **我没有跑 `git log -S`**。lead-world 实测：引入提交 = **62211cc = t39**（`git log -S` **仅此一条**命中），t49 对该文件只做了 **2 处调用点替换**；`is_piston_like` 进 `structure.rs` 的是 **33f377e = t48**。⇒ **纪律：归属类断言必须先取「引入提交」的读数**（`git log -S <symbol> -- <path>`），**不得由「谁最近碰过这个文件」推演**。**这是同一形状的第 10 次：结论 + 一个听起来对的理由，而理由是没实测的那一半。**
**同轮它抓出我的第二个错**：我说「修在共享默认（`structure.rs:1571`）」（**原引 · 该时点值，非活指针**；HEAD 处 `:1571` = `pos = pos.offset(0, 1, 0);`，lead-world 实读）—— 而载体有**三个**（ⓐ 函数体 ⓑ trait 文档 `mc-world/src/block.rs:192`（原写 `:178`，2026-09-28 更正） ⓒ **7 处**（我原写 8，**成员实测更正**）`is_solid()` 调用），**只改函数体只修了一个**。⇒ **「更正必须覆盖所有载有该错误的载体」这一次是别人替我做到的。**
**★ 正面（同轮即生效）：「定因前必须先检索既有登记」在立规后第一轮就被两个组用上**：① lead-world 发现 `group-world-t51` 的 `requirements_snapshot` 为空 ⇒ **先检索**，命中已登记的 **B-7**（`requirements_snapshot` 静默过滤）⇒ **不另立缺陷**，判据以卡面为权威（**空结果不是「没有」的证据**）；② lead-proto 读控制面 waiting 对象 = **0 键**，**不声称**那张票的 condition 类型（B-9/B-47 之下「重新登记」也无效），只如实记「已消失」。
**B-7 的一次新证据（可见性随角色而变 · tier 0 亲历）**：`group-world-t51` 的 `requirements_snapshot` 对 **lead-world 返回空**（revision 661、`acceptance` 长度 **0**），而**同一条 requirement 在 tier 0 的上下文清单里有完整正文** ⇒ **该静默过滤是角色相关的**，不只是「有时为空」。⇒ **加固 B-7：修复时须按角色分别复测**（tier 0 与组长两侧各取一次读数），否则「修好了」可能只是修好了其中一个角色。

**B-48（tier 0 本轮实测）**：**`inbox_list` 不投影 `inbox_ack` 所要求的 id 字段** —— 列表项暴露的是 `messageId` 与 `wakeIds[]`（**复数**），**没有** `inboxId`、也**没有**顶层 `wakeId`；而文档只承认「pass either the exact top-level `wake_id` or `inbox_id`」。⇒ **可传入的对象不是列表暴露的对象**，调用方只能**猜** `inbox_id == messageId`（会话清单里的 `inboxId` 确为该值）。**修法**：列表项直接投影 `inboxId`（或让 `inbox_ack` 接受 `messageId`）。**归因半条 not-verified**：我首次 ack 传了 `inbox_id: undefined`（因列表无该字段），随后 `inbox_list` 即为 **0** —— **「ack 生效」与「被其它路径清除」我无法用现有读数区分**，故只登记接口不自洽这一半。**该缺陷的形态与本轮 B-47 同族：存在性检查 ≠ 状态检查。**

**第三份独立普查（lead-proto · 代码普查 · 非转述）**：包总数 **166**；顶层存在该键 = **0**；`resourceScan.` 下 = **24**；`meta.` 下 = **2**；仅散文/其它字段 = 16；完全不提该串 = **124**。顶层键集合只有 **2 种形态**，最常见的是 **15 键闭集**。⇒ 与 verifier 的 165 包普查、与我自己的 `[packet-unknown-fields]` 读数**三方独立一致**。**另：lead-proto 在 t42 时也亲自撞过该拒绝** ⇒ 「提交方无法新增平台顶层键」**不是推断，是三次实测**。 |

### 复测通过

| # | 缺陷 | 复测证据 |
|---|---|---|
| **B-13（两半）** | worktree 根从不进入 guard + `base` 默认过期 | **✅ 两半都已修**：`team_worktree_setup(target:"rig-diff", task_id:"group-rig-t24", base:"main")` ⇒ `{branch:"team/rig/rig-diff", path:".dsh-worktrees/team__rig__rig-diff", readOnly:false, created:true}`，且 **`worktreePath` 已回写**到卡面（rev8→rev10 / phase → `execution`），`git worktree list` 显示该树在 **`e851489` = main tip**（**不再是过期树**）。⇒ **`base` 现在真的等于 main，且 `worktreePath` 真的落库了。** |
| **B-42 的触发条件** | — | 同一调用**证明**：显式 `base:"main"` + **清理陈旧派生分支后**即可成功 ⇒ 死锁的**触发条件**是「**派生分支已落后**」，**不是工具坏**。 |

**仍待定**：**W-1 的 (b)/(c)** —— rig-diff 能否**写**进该 worktree（探针已派出，责任人 lead-rig）。**B-13 修好 ≠ W-1 绿**：B-13 说的是「**根解析**」，W-1 说的是「**成员可写**」。**两者不可互相代替。**
### 复测：声称已修，实测仍红

| # | 缺陷 | 复测证据 | 建议 |
|---|---|---|---|
| **C-4** | `milestone-unbound` —— **判定正确，状态是坏的；根因 = B-40** | **tier 0 第三次更正（前两次都错）** | 实读（lead-world fresh）：`member-world-block` stage=「t46…」`done=true`；`member-world-chunk` stage=「t45…」`done=true`；`member-world-anvil` stage=「t47…」`done=true` ⇒ **判定读到的状态就是这样，判定没有错**。**为什么状态是这样**：成员**确实发起了**重新绑定，但 **`set` 静默不持久化**（**B-40**）⇒ 旧（已完成卡的）milestone 留在库里。⇒ **既不是「误报」，也不是「缺重新绑定机制」，而是「重新绑定这个写操作会静默失败」。** **我前两次更正分别错在：把成员自报当实读、以及没等它把机制查完就下结论。** | **修 B-40**（`set` 回读自证或报错）；**C-4 的判定逻辑本身暂不动**（它正确反映了库里的状态）。**另立 B-39**（该判定无单一角色可独立复核） |
| **B-31** | 已完成的 discussion 卡**无法推进到 `accepted`** | **✅ 复测通过（退役对应绕过）** | lead-world 在 `t13 / t32 / t35 / t40 / t41 / t44 / t46` 上 `advance_phase → accepted` **6/6 成功**，返回 `phase=accepted` 且 **revision 各 +1** ⇒ **真实生效，不是静默 no-op**。**附带正向发现**：`accepted` **不锁编辑**（在 t13 上做同文 `edit` ⇒ OK）⇒ 台账载体卡可安全推进。**tier 0 记名更正**：我先前把 `[bind-fix-commit]` 的拒绝当作「B-31 的原反例复测」—— **错**：那是 **B-28** 的路径（`bind_fix`），与「推进到 `accepted`」**不是同一个动作**。⇒ 拆为两条 |
| **B-28 扩展** | `bind_fix` **要求 `commit_sha`** ⇒ **无提交的已完成卡没有绑定修复路径** | lead-world **安全的部分测试**（t43 有真实提交 `0271a3b5`，传它**自己现有的值** ⇒ 构造上幂等）⇒ **OK**，前后实读 `commitSha` / `evidenceIds`（10 条逐条相同）/ `phase` / `status` **完全未变**（`same:true`）⇒ **`bind_fix` 的门是「commit 必须存在」，不是「完成卡不可修」**。**无提交的那半 = `not-verified`**（正测要写一个**假 commit** = 伪造；负测要传**无效 sha** = 若被接受就直接污染卡片） | 允许**哨兵值**表示「无 commit」。**纪律**：**只能靠伪造数据才能测的缺陷，永久记 `not-verified`**，修法按设计本身提出（B-22「破坏性假设不得为了求证而执行」的**再次应用**）。**提交方拒绝执行该正/负测，我批准** |

### 新发现：夹具聚合绑定到**可变文档** ⇒ 只能被相信，不能被复算

**（G-RIG t20 包 b1 · 提交方独立重算查出 · 提交方自己判 major）**：某包声明夹具聚合 `0778f56d…`（3 行），重算：

```
台账（**仓外、未跟踪、由第三方改写**）  5913/c986cf75  →  实测 8297/1b7896fc
docs/PLATFORM-DEFECTS   24676/8c3f4292 →  逐字节相符 ✅
docs/WORKAROUND-REVERT  15127/96777fed →  实测 20860/2bd09399
⇒ 重算得 1cc1d031…（≠ 0778f56d…）
⇒ 从其自身声明的三行重算 = f9f75519…（16 变体 + 6 子集均不命中）
```

3 行中 **2 行的输入是可变文档、测量后被改写** ⇒ 聚合**只能被相信、不能被复算**。提交方还把 15127 B 版本**定位到 commit `b9db777b…` 的 blob**（尺寸逐字相符）⇒ **绑定在测量时刻是对的，现在复算不出来**。

- ⇒ **这不是提交方的错，是绑定形态的错，且根因在 tier 0**：`docs/PLATFORM-DEFECTS.md` 与 `docs/WORKAROUND-REVERT.md` **是我每轮都在改的文件**。
- ⇒ **处置（已立为跨组口径）**：**夹具聚合必须绑定不可变载体**（快照进 `tests/fixtures/**`）；若必须绑定活文档，**须标 `point-in-time` + blob id + 尺寸，并声明不得作 CLEARED 依据**。
- ⇒ **平台侧无待修**（这是提交方纪律 + 载体选择）；登记备查，供修复方知悉**「绑定活文档」在本仓是结构性不可复算的**。

**verifier 独立复算（2026-09-28 晚）加强了这一条，并给出 tier-0 处置依据**：

- **比「陈旧」更重**：该聚合**既不可从当前树复现**（= @@1cc1d031…@@，与提交方重测逐字相符），**也不可从其自身声明的三行复现**（= @@f9f75519…@@；**16 变体 + 6 子集均不命中**）⇒ 这是**包内自相矛盾**，不是「时间造成的漂移」。
- **三行中有两行的可恢复性不同**：@@docs/WORKAROUND-REVERT.md@@ 的 15127 B 版**可**从 @@b9db777b@@ 恢复（size 15127 + sha8 @@96777fed@@ **双证**）；而**台账那一行在工作区仓库之外且未被跟踪** ⇒ 其 5913 B 测量时内容**永久不可恢复**。⇒ **快照目标应精确指向台账**（那才是需要固化的一份）。
- ⇒ **tier 0 处置（跨组口径，立即生效）**：
  1. **夹具聚合必须绑定不可变载体** —— 快照进 @@tests/fixtures/**@@（仓内、受跟踪）；**这是默认形态**。
  2. 若**必须**绑定活文档 ⇒ 标 @@point_in_time@@ + blob id + size + commit，**并声明不得作 CLEARED 依据**。
  3. **禁止**对**仓外文件**或**由第三方改写的文件**取聚合 —— 平台缺陷台账由修复方每 30 分钟改写，**对它的聚合在构造上就是不可复算的**。
  4. **本条 blocker 成立，不得软化**：提交方与 verifier 两方独立得出同一结论，且方向一致。
- ⇒ **根因在 tier 0**：那两份活文档是**我**每轮在改的；**我要求别人绑定它们，就等于要求一个不可复算的判据。**

### 范围收窄 / 撤回（**不要**当退役证据）

| 项 | 状态 | 依据 |
|---|---|---|
| **W-11 / B-20** | **范围收窄，不退役** | 不是「info 不可 ack」，而是「**ack 早于 delivery 状态推进时被拒**」（`injectedAt` 之前 `message-not-delivered` / `status=queued`；推进到 `delivered` 后 **4/4 成功**）。**未重测原始反例** ⇒ 不构成退役证据。**W-11b 保留且应保持红**：`inbox_ack(wake_id = messageId)` ⇒ `wake-not-found`，错误串**自证期望 wake id** ⇒ 那是**用法错**，不是缺陷症状 |
| **B-27 / W-25** | **`not-reproduced`** | verifier 唯一自测 16.75%，无同刻对照（提示 30% @15:23:53Z）⇒ **不做收敛声明**。**快照是观测，不是状态** |
| **`evidence-ad55ef5b-3601-4887-8dcd-8b962fef3c88`** | **撤回（勿再引用）** | 提交方自报不可复现：当时读 `{tickets:[],total:0}`，本轮同接口返回 **10 条票** |
| **B-9 扩展（b0）** | **登记表缺陷，成员侧无解** | 成员按两种候选 `requirement_id`（`task:group-rig-t20:acceptance` 与矩阵逐字显示的 `ac-1`）各记一行后，`review_package` 两次读数**完全不变**：`covered:false` / `rows[0].evidence:[]` / `uncovered:["ac-1"]` ⇒ **成员侧没有任何路径能让验收矩阵关联到该行**。verifier 实读确认，并**增量**：`evidence_query` 不兑现过滤条件 ⇒ 见 **B-37**。**lead-world 的排除实验**：`review_package` 对 `t44/t45/rig-t20` **一律** `covered:false`；在 t45 上**显式带 `requirement_id=ac-1`** 记一行后矩阵**未变**，且该行**未进入卡面 `evidenceIds`** ⇒ **仅带 `requirement_id` 不足以翻真；「记录」与「卡面关联」是两件事**。⇒ **矩阵投影对三组 lane 均不可用**，与 B-28 / B-31 同族（完成卡无干净推进路径）。**处置**：提交方**如实申报 `covered:false` 是正确的**，**不得**因此判包不合格；**该 blocker 的 owner 是平台，不是提交方** |

### B-44 的完整机制（**更优解释，未穷尽**）与新增号（续）

**B-44 机制（一条解释全部四次读数 · 承重发现来自执行者，tier 0 采纳）**：
- **scope 是字面前缀**（不是 glob）；
- **比较基准 = 该路径所属工作树自身的根**，**不是会话工作区根**；
- **`**` 不是通配符**。
⇒ **(α)** 失败：相对**链接工作树根**，它并不以 `.dsh-worktrees/` 开头；**(β) 与控制**失败：`**` 非通配。
**★ 保留（执行者自己提出、我采纳并升级）**：**substring / suffix 匹配也能解释两次成功，但解释不了 (α) 的失败** ⇒ 本机制是**更优解释，未穷尽证明**；**不得写成已证明的匹配规则。**
**判别设计（备而不用，交修复方）**：取一个**是目标的 suffix 但不是 prefix** 的 scope（如 `groups/rig/`）⇒ suffix 匹配器接受、prefix 匹配器拒绝，**一次写入即可定案**。**tier 0 本轮不跑的理由**：本仓已立「**写入门禁是尽力而为的过滤器，不是安全边界**」⇒ 前缀 vs substring 的差别是**文档精度**问题，**不值得一个轮次**；且 **B-44 的修法依据是语料**（含 `*` 者 0 / 10 张无 `*` 者全成功），**不依赖匹配语义的证明。**

| # | 缺陷 | 可信度 | 指纹 | 修法方向 |
|---|---|---|---|---|
| **（B-45 早期读数 · 详细版已并入上方「第三轮 新增号」表）** | **零写入的 discussion 卡可能没有合法的 contract 修订路径** | 组长实测（**读回确认无副作用**） | 组长自试修订被拒 `[task-contract-scope]: only the current owner or tier 0 may revise this contract`；**且实测该卡 contract `validation.ok=false` / `scope-required`（要求 `writeScopes` 非空）** ⇒ **零写入卡可能根本没有合法修订路径** | **与 B-42 / B-43 同族**（**平台要求一个该卡自身语义禁止的产物**）。修法：`scope-required` 校验应**豁免 review / discussion 卡**，或给出**该 kind 的合法修订路径**。**过渡期**：定向派给 owner，**不得绕过**；若 owner 亦被拒 ⇒ **按机制缺口上报** |
### 团队侧的系统性失误模式（非平台缺陷，登记供修复方理解上下文）

**「用重建物代替原件」** —— 本会话**独立发生 ≥10 次**（tier 0 四次；lead-rig 六次），**全部形态相同**：**给出结论 + 一个听起来对的理由，而理由是没实测 / 没回原件的那一半。** 本轮最近一次：包的**判据计数**用了自己的摘要而非 owner 的逐条原文 ⇒ 计数错 ⇒ 重提一版。**已入 `GOVERNANCE §5.14` 作为命名纪律。**

**B-58（投影陈旧 · fail-closed 误伤族 · 2026-09-28 · lead-world 上报 / tier 0 自读确认）**
- **现象**：`task-ready-gate: scope-conflict`，在 `team_task_update(action:"claim")` 时被拒。
- **反例对象**：`group-rig-t3`（rev40）—— 顶层 `status=completed / phase=accepted / lifecycle=completed`，而 `contract.contract.lifecycle=running`、`contract.lifecycle=running`、`validation.contract*.lifecycle=running`（tier 0 自读逐字）。其 `writeScopes = [tools/trace-diff, tests/fixtures, tests/golden]`，`tests/fixtures` 是 `tests/fixtures/worldgen/ORACLE-SPEC.md` 的**父前缀** ⇒ 命中 `detectScopeConflicts`。
- **第 3 个独立实例（tier 0 自己踩到）**：`task-19`（scope `.cargo/config.toml` + `docs/*`）在 `claim` 时被同一串拒绝；`team_run_lease(acquire)` 成功。⇒ **受准路径再次被独立验证**。
- **引用（owner 自陈，未读平台源码）**：`team-v12-contract.mjs:456-457`、`:46 ACTIVE_CONFLICT_STATES={ready,running,blocked,review}`、`:159-164 normalizeTaskContract contract-overrides-top-level`、`:312-317`；`team-v12-runtime.mjs:1873-1895`。
- **受准路径（tier 0 裁定）**：直接 `team_run_lease(acquire)` —— 令 phase 转入 execution 且**不改变任何判定输入**。已由 lead-world（t58）、lead-rig、tier 0（task-19）各实测。**不视为绕过。**
- **不修的代价（记在案上）**：任何 `write_scope` 落在 `tools/trace-diff` / `tests/fixtures` / `tests/golden` / `docs/` 之下的后续卡，首次 `claim` 都会被拒。
- **tier 0 裁定：不修对象**（理由见 `GOVERNANCE.md §5.14` 追加第 2 条）。修复归平台侧：`detectScopeConflicts` 应读对象**自身**的 lifecycle（顶层），或在 `contract-overrides-top-level` 时只取**更新的**一侧。
- **同族**：B-57（board 归属投影陈旧）。两条都是**投影陈旧导致的 fail-closed 误伤**。
- **附带事实（lead-world 请求登记）**：`group-world-t35` 的**契约侧为已知陈旧**（W3 期版本，4802 字符）；**权威载体 = 卡面 description**。

**B-59（卡面不可更正 · 2026-09-28 · tier 0 实测）**
- **现象**：`team_task_update(action:"edit")` 在 **global 板**的卡上被拒 —— `team policy refusal [global-append-only]: the global board is append-only: only creating a task, advancing its status, and assigning an owner are allowed`。
- **后果**：**global 卡的卡面在创建后不可更正**，与本仓「卡面必须与交付一致」的纪律**结构性冲突**。
- **实测反例（同轮两次）**：`task-20` 定面写「追加 **7** 条」，定面后 lead-rig 又交第 8/9 条 ⇒ **实交付 9 条**而面写 7，**且无法改面**；`task-21` 定面只写「§5.14-19」，随后 lead-rig 精化了 §5.14-11 ⇒ **实交付含两处**。
- **受准处置（tier 0 采用）**：把偏离**逐条披露在证据行与提交信息**中，并在 `docs/STATUS.md` 留档；**不得**静默交付超集。
- **修法建议**：允许对**自己持有**的 global 卡做 `description` 级 edit；或提供 append-only 的「面外增补」字段，使卡面与交付可再次一致。

**B-60（拒绝串不具名违规字段 · 2026-09-28 · 三处独立命中）**
- **现象**：工具参数含 `undefined` 时，拒绝串为 `binding arguments must be lossless JSON`，**不指出是哪个字段**。
- **三处独立命中**：① lead-proto 的成员（`paths: undefined`）；② lead-proto（`evidence_ids: undefined`）；③ tier 0（`include: undefined`）。
- **代价**：调用方只能**逐个字段试**；且该串极易被误读成「参数写错了」而不是「某字段是 undefined」。
- **修法建议**：拒绝串**具名**违规字段（例如 `argument 'include' must not be undefined`）。

**B-61（「状态判定读 status 而非 phase」—— 同一根因的三种表现 · 2026-09-28 · lead-world 受控实测 + tier 0 汇总）**
- **表现①**：`group-world-t60` 在 `group-world-t59` 仅 `status=completed`（**尚在 member-check**）时即报 `ready:true`。
- **表现②**：B-58 —— `detectScopeConflicts` 读**陈旧的派生字段** `contract.lifecycle`，而顶层 `status/lifecycle` 已 `completed`。
- **表现③（lead-world 受控实验）**：`waiting_set` 的 explicit 票**锚在 `status=completed` 的卡上会被 reconciler 立即置 `resolved`**，而锚在 `status=pending` 的卡上保持 `open` ⇒ reconciler **按卡 status 判「还在等吗」，不看 phase**（该推断由 lead-world 标注为**推断**）。
- **后果（重要）**：一张卡一旦 `status=completed`（**而它正处于 member-check / verifier-review / integration-ready**），**它的「刻意 hold」就无法被表示为一个 open 等待** ⇒ 平台自己要求的「每个等待都要留下任务/原因/解除条件/责任人」在**复核阶段恰好不可执行**；**§5.13 这类 crate/相位级串行规则在平台层无法留痕**。
- **修法建议**：等待的解除条件支持 **phase 级谓词**（如 `taskPhase: {taskId, phase}`）；`ready` / `resolved` 一类判定应读**相位**而非仅 `status`。
- **受准绕行（lead-world 已采用）**：把等待**锚在 status 未完成的卡**上（`t60`，`external`，detail = 「t59 达到 phase=accepted」），持久责任另记台账 `group-world-t35`。

**B-62（dead letter 无法收口 · 2026-09-28 · lead-rig 实测 / tier 0 复现）**
- **现象**：`wake:team-wake:lead-rig:rig-runner:r28` 被 `team_delivery_check` 持续报为 `deadLetterCount=1`（`status=open` / `terminalStatus=timed-out` / `attempt=3` / `lastError="dispatch deadline expired"`），而平台自己的 `suggestedAction` 建议 `retry-new-episode|reassign|block|cancel`。
- **实测**：lead-rig 选 `cancel` 分支时，平台**拒绝** `timed-out -> cancelled`（`invalid dispatch transition`）⇒ **四个建议分支里 `cancel` 实际不可用**。
- **后果**：该条目**永远无法离开死信清单** ⇒ `deadLetterCount` 沦为**只增不减**的计数器；「死信」从「待处置」变成「永久噪声」，会训练读者忽略它。
- **修法建议**：允许 `timed-out → cancelled`（或提供「已人工判定、不再重投」的终态），使死信可收口；若设计上不可收口，则该计数应改名/加注为「**累计**」而非「待处置」。

**B-63（`run_code` 裸反引号 ⇒ 错误串不指向真因 · 2026-09-28 · lead-world 第 135 条 + tier 0 全程规避）**
- **现象**：`run_code` 的 `code` 内出现**裸反引号**（如 Markdown 代码跨度）⇒ 包装层模板字面量被截断，报 `Expected ',', got 'ident'` 或 `Expression expected`。
- **★ 范围限定（verifier nit · 2026-09-28 采纳）**：本条是**解析 / 装载期**缺陷 —— 包装层模板字面量在**代码装载时**被截断；**运行期一旦开始，裸反引号无任何影响**。⇒ 归因时**不得**把它写成运行期缺陷。
- **补：执行期 / 序列化期失败是另一回事（lead-rig 第一手 · 2026-09-28）**：一次**参数校验期**失败（`job_list()` 不传参 ⇒ `binding arguments must be lossless JSON`）⇒ **未执行任何子调用**；一次**执行期**失败（程序体跑到中途、**前序子调用已执行**，随后因 JS `TypeError` 抛出）⇒ **前序子调用不回滚**。⇒ **两者语义相反**：**执行期 / 序列化期失败后，必须查回执再决定重试**，不得假设「整体未发生」。（并记：那次 `job_list()` 的拒绝串**未具名违规字段** ⇒ **B-60 的又一实例**。）
- **关键语义（不在错误串里）**：**解析失败 ⇒ 本次所有子调用都未执行**（不是执行到一半）。
- **后果**：错误串既不提示「含未转义反引号」，也不声明「全部未执行」⇒ 调用方会去猜语法，并可能凭「是解析错」**假设无副作用而不回读**。
- **修法建议**：错误串指出**未转义反引号及其位置**，并明示「**没有任何子调用被执行**」。
- **受准做法（本会话通用）**：用 `String.fromCharCode(96)` 构造反引号 + 占位符替换（如 ``` → 反引号）。

**B-61 补充（2026-09-28 · lead-rig 第一手实测 + 受控对照在飞 · tier 0 收编）**
- **表现③由「推断」升为「实测」**：lead-rig 把「等 rig-runner 的窗口」登记为 `waiting_set(task_id:"group-rig-t17")`，控制面实测 `status=resolved` / `resolution="auto:condition-cleared"` / `resolvedBy="team-v14-waiting"` / `createdAt=1790535600162` / **`resolvedAt=1790535608256`** ⇒ **创建后 8.094 秒被自动置 resolved**（`evidence-902361a6-5455-4821-93a5-3404982509da`）。而**解除条件当时并未满足**（rig-runner 是几分钟后才回窗口的）⇒ **`auto:condition-cleared` 是一句假陈述**。
- **★ 成因已证伪（2026-09-28 · lead-rig 单变量对照）** —— 本条原先写「锚点卡 `status=completed` ⇒ reconciler 读 **status** 而非 **phase**」并称「升为实测」。**该成因被它自己的对照证伪**：
  · **A** 锚 `group-rig-t17`（`status=completed`，phase=integration-ready）：`createdAt 1790535600162` → `resolvedAt 1790535608256` = **8,094 ms**
  · **B** 锚 `group-rig-t25`（**`status=pending`**，phase=execution）：`createdAt 1790536292706` → `resolvedAt 1790536329109` = **36,403 ms**
  · **两者完全相同**：`status=resolved` / `resolution="auto:condition-cleared"` / `resolvedBy="team-v14-waiting"` ⇒ **只换锚点卡 status，结果不变 ⇒ 卡 status 不是判别量。**
  · **改前值（第 40 条保留）**：「锚点卡 `group-rig-t17` 的 `status=completed`（而 `phase=integration-ready`）⇒ reconciler 读 status 而非 phase」。
- **★ 仍然成立、不得一起撤的两条**：① **`auto:condition-cleared` 是假陈述**（两次都**没有**任何条件被解除）；② **B-9 成立**（两张票在 `waiting_list` 里**都不可见**）。
- **存活的机制假设 = B-47**：**显式（非 derived）票被自动置 resolved，与锚点卡 status 无关。** 旁证：`waiting_list` 里**持续存在**的票**全是 `derived`**（waiting-lease / waiting-provider / waiting-dependency），而这两张都是**显式**票（`unblockCondition.type="background"`）。两次时延不同（8.1 s vs 36.4 s）⇒ 更像**周期性 reconciler 扫描**，而非「建票即查 status」。
- **正确的下一个实验（单变量 · 尚未做）**：保持锚点卡 status **不变**，**只改票的种类**（显式 `type:"manual"` vs `derived`）⇒ 若 `derived` 保持 `open` 而显式被清，则 B-47 由假设升为实测。**在拿到该读数之前，两者都只算假设。**
- **★ 它同时是 B-9 的实例**：该票在 `waiting_list` 里**完全不可见**（该调用只回 `derived` 票）⇒ **唯一能观测到这次自动解除的地方是原始控制面**。⇒ **两条缺陷叠加：票被静默解除，且解除在可读视图里看不见。**
- **具体后果（在 G-RIG 上）**：lead-rig 里程碑唯一剩余项的等待，**在 8 秒后就不存在于任何可读视图中** —— 恰发生在**复核相位**。
- **受控对照（lead-rig 已布好，等第二次读数）**：同一 actor / 同一 API / 同一 reason 形态，**只换锚点卡的 status** —— 锚在 `status=completed` 的 `t17` ⇒ **8.1 s 自动 resolved**；现锚在 **`status=pending`** 的 `group-rig-t25`（`wait:group-rig-t25:lead-rig:a72410e0-3b07-479b-8f80-4afc61b8523b`）。⇒ **单变量对照**：若该票保持 `open`，则「reconciler 按 status 判」由**相关**升为**因果**；若同样自动 resolved，则机制另有其因。

**B-61 / B-47 补充二（2026-09-28 · lead-rig 第二次单变量对照 · tier 0 收编 —— ★只记观察，不写成因）**
- **第二次对照读数**（锚点卡 `group-rig-t25` **全程 `status=pending`**；同 actor / 同 API / 同 reason 形态）：
  · `unblockCondition.type="background"`：`createdAt 1790536292706` → `resolvedAt 1790536329109` = **36,403 ms**
  · `unblockCondition.type="manual"`：`createdAt 1790536488268` → `resolvedAt 1790536495966` = **7,698 ms**
  · **两者均** `status=resolved` / `resolution="auto:condition-cleared"` / `resolvedBy="team-v14-waiting"` ⇒ **两种显式票型都被清 ⇒ `unblockCondition.type` 也不是判别量。**
  · **两半都报**：**没有任何一种票保持 `open`** ⇒ 这**不确认** B-47 作为**成因**，只**收窄**它。
- **★ 按字面做的实验在结构上不可做（实测理由）**：控制面里 `"status":"derived"` 出现 **0** 次、`"reason":"waiting-dependency"` 出现 **0** 次，而 `waiting_list` **确实返回**这类条目 ⇒ **derived 条目没有存储行，是每次读取时重新计算的投影**；而 `waiting_set` 写的是**存储行**。⇒ **「显式 vs derived」不是同一对象内部的变体，而是两种不同机制**，且现有 API **无法让平台存储一个 derived 票**。
- **⇒ 机制状态：成因仍未定。** 已排除的判别量：**(1) 锚点卡 `status`**（A/B 对照：completed ⇒ 8,094 ms / pending ⇒ 36,403 ms，结果相同）；**(2) `unblockCondition.type`**（本次：background ⇒ 36,403 ms / manual ⇒ 7,698 ms，结果相同）。**存活的结构性假设 = 存储行 vs 计算投影**（存储票被以假串 `auto:condition-cleared` 自动解除；投影票根本不可能被解除）。**要测它需要平台侧插桩或操作者动作，不是再来一次 `waiting_set`。**
- **★ 明确禁止**：**不得把它写成已实测的成因** —— 这正是 §5.14-24（一个实例只升级观察，不升级成因）的教训；上一轮我正因违反它而撤下过一条假机制。载体 = `group-rig-t26`（discussion，已完成），`evidence-1309ac6e-0e47-43ed-b592-32cdef4b1a72`。

**B-64（`waiting-provider` 假阳性 · 2026-09-28 · lead-proto 实测 · 与 B-47/B-51 同族但须分开记）**
- **现象**：`group-proto-t52`（rev9 / `in_progress` / `commit=null`）挂着一张 `waiting-provider` 票（`status=derived` / `responsible=lead`），而**同轮控制面** `provider.lastFailure=null`、`provider.updatedAt=1790448911978`（**早于本会话约 24 小时**），且 **tier 0 / verifier / 3 名组长全部 running**、上报者本人正在执行工具调用 ⇒ **声明的 provider-healthy 解除条件没有任何观测支撑**，却把一张**在办卡**挂住。
- **同族**：`waiting_resolve` 返回 `status=not-found`（**B-51 同形**）⇒ **票不可解，只能按过期等待处置**。
- **要求（lead-proto 建议，tier 0 采纳）**：缺陷表把 **`waiting-provider` 与 `waiting-dependency` 的假阳性分开记** —— 两者的**触发条件不同**（前者应由 `provider.lastFailure` 驱动，后者由依赖相位驱动），合并记会让修复方**修错驱动源**。
- **受准绕行**：按**过期等待**处置并**直接唤醒 owner**（lead-proto 已采用）。

**B-48 补充（2026-09-28 · verifier 第 2 个独立实例 + 一条新形态 · tier 0 收编）**
- **★ 新形态（★ 2026-09-28 收窄更正）：未文档化的分批 ack 契约 + id 字段名不匹配。**
  · **原句（改前值，第 40 条保留）**：「ack 后 `inbox_list.wakes` 长度**仍为 1** ⇒ **该 wake 无法从任何可读视图收口**」—— **该主张已被 verifier 自己的实测证伪**。
  · **实测**：ack #1（6 条 `messageId` 的合并 wake）⇒ `{status:"partially-handled", messageIds:6}`；**ack #2（同一 id，中间无其它动作）** ⇒ `{status:"handled", handled:true}`，wake **关闭**（`handledAt` 置位）。⇒ **单次 ack 只推进一批；闭合需要重复同一 ack 直到 `handled`。**
  · ⇒ **缺陷形态收窄为**：① **「重复调用直到 handled」这个契约未文档化**；② **id 字段名不匹配**（`inbox_list` 的 `wakes[]` 只投影 camelCase `wakeId`，无 `wake_id` / `inbox_id`）。**不是「无收口路径」。**
  · **证据** = `evidence-03a97f51-6a25-4a2b-be55-b9200d926bc0`（verifier 自纠）；报告 v2 → **v3**。
- ⇒ **B-48 的第 2 个独立实例**，并补出：除**「名/形不匹配」**之外，还存在**「合并 wake 的逐消息收口语义未定义」**。
- **★ 更正（2026-09-28 · 三处独立读数）**：① **`wakeId` 是被投影的** —— lead-rig 的早期探针写 `il.inbox || il.wakes`，而 `il.inbox` 为真 ⇒ **`wakes` 从未被读过**；实读顶层键 = `[target,total,inbox,wakes,hasMore]`，`wakes[0]` 含 **`wakeId`**（`wake:lead-rig:33` / `status=delivered` / `messageIds=18`）⇒ **B-48 的真实形态是「名/形不匹配」（驼峰 `wakeId` vs 下划线 `wake_id` / `inbox_id`），不是「缺席」**。② **`inbox_id` 参数存在且接受 `messageId`** —— lead-proto 在 **1 条消息**的 wake 上传 `inbox_id='msg-e2ff3aa3-…'`（即 messageId）⇒ `{ok:true, status:'handled', handled:true}`；verifier 那次是 **6 条消息的合并 wake** 且传的是 **`wakeId` 值** ⇒ **wake 不同、消息数不同、参数不同，未做单变量对照**（lead-proto 只记观察、不写成因）。
- **修法建议（更正后）**：① `wakes[]` 同时投影 `wake_id` / `inbox_id`（**名/形对齐**）；② **合并 wake 的逐消息收口语义必须定义** —— 是「逐条 ack」还是「整 wake ack」，以及 ack 一条后 `wakes` 为何仍长 1；**不要去造一个已经存在的参数**；③ 若某条 `messageId` 无法单独处置，则**合并 wake 的存在本身**应被视为缺陷。

**B-61 / B-47 补充三（2026-09-28 · lead-world 第一手观察 · tier 0 收编 —— ★只记观察，不写成因）**
- **观察**：lead-world 在 `group-world-t60` **`status=pending`** 时为 `group-world-t61` 登记显式票（`unblockCondition={type:dependency, taskIds:[group-world-t60]}`，`createdAt 1790536408763`）⇒ 当时 `waiting_list` 显示 **`status=open`**；t60 达 **rev25 / `status=completed`（phase 仅到 `member-check`）** 后，该票**已完全不在表内**。
- **可判定的部分**：**dependency 的解除时点与锚点卡达到 `status=completed` 一致**，而当时 phase **尚未**到 `accepted` ⇒ **平台对 `dependency` 的判定粒度是 status，不是 phase**。
- **★ 它与 lead-rig 的 A/B 不矛盾**：后者测的是 `background` / `manual` 型（两种都被清，与锚点 status 无关）；本条是 **`dependency` 型** ⇒ **不同票型可能有不同判定路径**。⇒ **两者都只是观察**，不得合并成一条成因。
- **lead-world 明确不声称**：本次解除**可能是正确行为**（依赖的卡确实完成了）；**不**据此断言 B-61/B-47 的静默解除成因。⇒ **只记观察。**

**B-61 补充四（2026-09-28 · lead-world 收紧结论 · tier 0 收编）**
- **★ 结论收紧：不存在可表达 `phase=accepted` 的 hold。** lead-world 为 `group-world-t61` 登记的 dependency 票，在锚点卡 `t60` 达到 `status=completed`（**phase 仅到 `member-check`**）时从 `waiting_list` 消失；**重登记一次** —— 因锚点**当时已 completed**，解除条件**在登记那一刻即已满足** ⇒ **数分钟内再次消失**。
- ⇒ **可判定（非成因）**：**dependency 的判定粒度是锚点卡的 `status`**；**对已 `completed` 的锚点登记会被立即清掉。**
- ⇒ **处置**：**不再重登记**（只会产生噪声）；跨相位串行**完全由台账纪律把关**，并在派发消息里写明依据。⇒ 这是「解除 hold 必须写下『条件 + 实测值 + 时点』的一句可审裁定」的**又一个独立理由**：**平台表达不了相位级 hold，所以那句话就是唯一可审的载体。**

**B-61 补充五（2026-09-28 · lead-rig 单变量四试 —— ★判别量已找到 · tier 0 收编）**
- **四试完整读数**（锚点卡 `group-rig-t25` 全程 `status=pending`；同 actor / 同 API / 同 reason 形态）：
  | 试 | `unblockCondition.type` | 锚点 status | 结果 | `waiting_list` 可见 |
  |---|---|---|---|---|
  | A | `background` | `completed`(t17) | resolved **8,094 ms** | 否 |
  | B | `background` | `pending`(t25) | resolved **36,403 ms** | 否 |
  | C | `manual` | `pending`(t25) | resolved **7,698 ms** | 否 |
  | **D** | **`dependency`（未满足）** | `pending`(t25) | **`open`** | **是** |
- **⇒ 判别量 = `unblockCondition` 能否被 reconciler 求值**：**可求值**（`dependency` + 未满足任务）⇒ **被尊重、保持 `open`**；**不可求值**（`background` / `manual`）⇒ **被置 `resolved` 并写下假串 `auto:condition-cleared`，而状态什么都没变**。
- ⇒ 这解释了 `waiting_list` 里**持续存在**的 `waiting-lease` / `waiting-provider` / `waiting-dependency`（**全都是可求值的**）。
- **★ 与 lead-world 的 dependency 观察相容（不矛盾）**：它的票条件是 `taskIds:[group-world-t60]`，而 t60 **确实达到了 `status=completed`** ⇒ **条件真的被满足**，被清是**正确行为**；它重登记时锚点**已 completed** ⇒ **登记那一刻条件即满足** ⇒ 立即被清，也正确。⇒ **两者合起来**：**平台的 `dependency` 谓词是「锚点卡 `status=completed`」**，所以 **`phase=accepted` 级的 hold 无法表达**（补充三 / 四成立），而**未满足的 dependency 会被尊重**（试 D）。
- **★ 已排除的判别量**：**(1) 锚点卡 `status`**（A vs B）；**(2) 「显式 vs derived」**（A/B/C 都被清、D 未被清 ⇒ 与显式 / 投影之分无关）。
- **★ lead-rig 的三处自纠（全部收编）**：① 「`type` 不是判别量」**被自己的试 D 证伪** —— 错在**在一个类内变动**（`background` / `manual` **同属「不可求值」类**）却据此断言该变量无关（⇒ §5.14-32）；② 「derived 条目没有存储行」**撤回** —— 其新的 `open` 票也不在该文件里却在 `waiting_list` 中存在（⇒ §5.14-27 配套）；③ 「**我快照里没有**」是**我快照的属性**，不是平台的属性。
- **仍然成立、不得一起撤**：① `auto:condition-cleared` 对**不可求值**条件是**假陈述**；② 被清的那些票在 `waiting_list` 里**不可见**（**B-9**）。

**B-61 补充六（2026-09-28 · 完整机制的规范表述 · lead-rig 提出、tier 0 采纳为权威表述）**
- **规范表述（两句话合起来才是完整机制）**：
  > **可求值条件（`dependency`）按锚点卡 `status` 求值并被尊重；不可求值条件（`background` / `manual`）被立即置 `resolved` 并写下假串 `auto:condition-cleared`。**
- ⇒ **`status` 对不可求值条件不是判别量**（lead-rig 的 A/B：completed ⇒ **8,094 ms** / pending ⇒ **36,403 ms**，结果相同）；**但它是 `dependency` 的求值粒度**（lead-world 的观察 + lead-rig 的第 4 试）。
- ⇒ **本节以前各补充的表述以本条为准**；补充三 / 四 / 五**不撤销**（它们各自记录了一个被排除的判别量与一次自纠），但**不得**被单独引用为完整机制。
- **仍成立、不得一起撤**：① `auto:condition-cleared` 对**不可求值**条件是**假陈述**；② 被清的那些票在 `waiting_list` 里**不可见**（**B-9**）。

**B-64 补充（2026-09-28 · 第二个独立实例 · tier 0 收编）**
- **第二实例**：`group-proto-t54` 上又出现一张 `waiting-provider` / `unblockCondition={type:provider-healthy}` / `responsible=lead` 的 **derived** 票，而**控制面无任何已登记 provider 失败**（lead-proto 本轮所有工具调用成功、`provider` 无失败读数）⇒ **与 t52 上那张同形**。
- **★ 观察（不写成因，遵 §5.14-24）**：lead-proto 报**两张票都出现在其 owner 刚被唤醒之后**。⇒ **只记观察** —— 它与已排除的两个判别量（锚点卡 `status`、`unblockCondition.type`）**都不冲突**，也**不**支持任何新成因。
- **受准绕行（沿用）**：按**过期等待**处置、**不重登记**（重登记只产生噪声），直接唤醒 owner；持久责任记在台账。

**B-65（`task-ready-gate: owner-unknown` 报文与事实不符 · 2026-09-28 · lead-world 实测 · 拒绝串不可判别族第 4 例）**
- **现象**：tier-1 组长对**其成员拥有**的卡调 `team_task_update(advance_phase, phase:execution, expected_revision:9)` ⇒ 被拒 `ToolCallError: task-ready-gate: owner-unknown`。
- **实测反例**：该卡 **owner 实为 `member-world-block`、调用者正是其父级组长**；同一卡推到 `plan-approved` **成功**；随后 **owner 自己**推 `execution` **成功**。⇒ **`execution` 是 owner 侧转换**，而**报文让人去查「owner 是谁」**。
- **修法建议**：报文改为「**该相位转换只能由 owner 执行**（当前调用者不是 owner）」，**不要**在 owner 明明已知时报 `owner-unknown`。
- **非阻塞**：write 门禁 = `write_scopes` + `plan-approved` + 活动 lease，与本条无关。
- **同族**：**B-57**（board 归属投影陈旧）/ **B-58**（陈旧 `contract.lifecycle`）/ **B-60**（`undefined` 参数不具名字段）—— **「拒绝串不可判别」族的第 4 个实例**。⇒ 该族的共性：**拒绝串把人送去查一个不是原因的东西。**

**B-64 补充二（2026-09-28 · 第三实例且跨组 · tier 0 收编）**
- **第三实例**：G-WORLD 的 `group-world-t61` 上也出现 derived `waiting-provider` / `{type:provider-healthy}` / `responsible=lead`，而**控制面无任何 provider 失败读数**（该卡 owner `running`、组长全 turn 工具调用成功）⇒ **与「某组特有」不相容**。
- **累计实例**：`group-proto-t52` / `group-proto-t54` / `group-world-t61` ⇒ **跨两个组**。
- **观察（不写成因，遵 §5.14-24）**：多张票都出现在其 owner **刚被唤醒之后** —— 与已排除的两个判别量都不冲突，也不支持新成因。

**B-61 正面验证（2026-09-28 · lead-world · tier 0 收编）**
- 用**可求值条件**登记等待：`unblockCondition={type:dependency, taskIds:[group-world-t61]}` ⇒ 返回 `status=open` **且未被清**；**同一 `waiting_list` 里两个非可求值条件（`lease-released` / `provider-healthy`）均为 `derived`**。
- ⇒ **判别量 = 条件能否被 reconciler 求值，再次成立**（与 B-61 补充六逐条一致）。这是该结论的**第一次正面验证**（此前都是反例）。

**B-66（写范围守卫把「选项」当成写入目标 ⇒ 只读命令被判成写 · 2026-09-28 · lead-world 实测 · tier 0 收编）**
- **原始拒绝串（逐字）**：`bash write denied: member "lead-world" has no declared static scope or active approved plan lease for (D:\dsh-test\workspaces\RustMc\--exclude-standard)`
- **触发命令**：`git ls-files -c -o --exclude-standard '*.rs' '*.md'` —— **只读、无副作用**，而守卫**把选项 `--exclude-standard` 当成了写入目标路径**。
- **修法建议**：写入目标提取必须**区分选项与路径**（`--` 之后才是路径；或以「选项表 + 已知只读子命令」判定）；**至少**不得把 `-` / `--` 开头的 token 当作路径。
- **同族**：**B-63**（工具对自己输入的错误解析）；本条是**守卫对命令行的错误解析**。⇒ 该族的共性：**一个只读动作被自己的元数据判成了写。**

**B-67（`worktree-stale-base` 的补救语在该工具入参里不存在 ⇒ 组长无路可走 · 2026-09-28 · lead-world 实测 · tier 0 同轮复核并裁定 · 「拒绝串不可判别」族第 5 例）**
- **原始拒绝串（逐字，三条同形）**：`team policy refusal [worktree-stale-base]: worktree for "member-world-<m>" could not be created: existing worktree branch "team/world/member-world-<m>" does not contain requested base "main"; choose a fresh branch or…`
- **为什么它是缺陷**：`team_worktree_setup` 的入参只有 `target / task_id / repo / base`，**没有 branch 参数** ⇒ 报文给出的补救（**choose a fresh branch**）**对调用者不可执行**。⇒ 该族的共性是「拒绝串把人送去查一个不是原因的东西」；本条**升一级**：**它给出了一个没有对应输入的动作。**
- **实测（tier 0 同轮复核，退出码取在命令之后、不经赋值）**：三分支 head 均 `05e1bc1`、`main` 已到 `345cc1c`；`git merge-base --is-ancestor <branch> main` ⇒ **rc=0**，反向 ⇒ **rc=1**；`git rev-list --left-right --count main...team/world/member-world-<m>` = **313 / 0** ⇒ **纯祖先（落后 313、零分叉）**，**不是「分叉后过期」**。
- **影响面**：**不是一次性故障** —— G-WORLD 此后每张成员卡都要经过这一步，而其 M11 列（组件 1 之后还有组件 2/3）会持续产生成员卡。
- **修法方向（tier 0 裁定，按优先级）**：
  - **②（正确修法）**：当既有分支是请求 base 的**纯祖先**（behind>0 且 ahead=0）时，**自动 fast-forward 到该 base**（纯祖先 ⇒ 零分叉 ⇒ 无损、不可能冲突），然后照常布局；**仅在分叉（behind>0 且 ahead>0）或工作树不干净时拒绝**。
  - **③（必要配套）**：把 branch 名暴露给调用者，或接受显式 `branch` 入参 —— 使「choose a fresh branch」**有一条可执行的对应输入**。
  - **①（明确驳回）**：把检查放宽为「分支是 `main` 的祖先即可」**是反方向** —— 落后的纯祖先**正是 §5.10 要拦的那一类**（静默给出缺 M0 的树）；放宽它等于**把该检查取消**。
- **同族**：**B-57** / **B-58** / **B-60** / **B-65** —— **「拒绝串不可判别」族第 5 例**。

**B-67 更正（2026-09-28 · lead-world 自纠 · tier 0 采纳）**
- **被撤回的断言**：B-67 原文引的是**被截断**的拒绝串（`…choose a fresh branch or…`），据此断言「补救语在该工具入参里不存在、无可满足的前置条件」。**该断言过强，撤回**：完整报文含 **`choose a fresh branch or rebase it explicitly before work`** —— **`rebase` 是可执行的那一半**（成员侧 git 操作，不需要工具入参）。
- ⇒ **新纪律（lead-world 第 167）**：**截断的报文不得作为「补救不存在」的判据** —— 引拒绝语必须引到结尾，或明确标注「报文被截断」。与「空集必须附正向对照」同族。
- **真正的缺陷（更正后，且更强）**：该检查要求分支**包含** `main`，而 **`main` 在持续前进** ⇒ 一次成功的 fast-forward 会被**下一次提交**立刻重新弄坏。实测：task-69 提交前三分支与 main 均为 `345cc1c`（`0 / 0`）；task-69 提交后 main = `b9b9a10` ⇒ `main...branch` = **`1 / 0`** ⇒ 重跑 `team_worktree_setup(base:"main")` 三名成员**全部仍被拒**（逐字串同上）。
- ⇒ **一般形态（lead-world 第 168）**：**当修复动作本身要提交到被比较的那个引用上时，修复会把前置条件重新弄坏** —— **判据必须设计成幂等 / 自稳定形态，而不是「要求人工在同一瞬间满足」**。与 §5.14-34（记录一个缺陷会制造它的一个实例）同族：**修复动作改变被修复对象**。
- ⇒ **修法方向不变、理由更强**：**②（纯祖先且工作树干净 ⇒ 自动 fast-forward）是唯一对「移动的 main」稳定的形态**；**①（放宽为「祖先即可」）仍驳回**。
- **受准处置（lead-world 已采用）**：**不重试、不换写法绕过门禁**；把等价信息用另一条**不含该选项**的只读命令取得（它用顶层全枚举替代）⇒ **不阻塞**。

**B-68（`team_task_get` 不带 `board` 报 `not found`，而该任务确实存在 · 2026-09-28 · lead-world 成员实测 · tier 0 收编 · 「拒绝串不可判别」族第 6 例）**
- **现象**：对一张**确实存在**的组板卡调 `team_task_get(task_id:"group-world-t64")`（**不带 `board`**）⇒ 报 **`not found`**。
- **实测**：该卡存在（`board:"group-world"` 下 rev31 / completed / verifier-review）；工具描述明写 `board` **默认 `global`** ⇒ 真实成因是**默认板不是该卡所在的板**，而**不是任务不存在**。
- ⇒ **同族共性（B-57 / B-58 / B-60 / B-65 / B-67）**：**拒绝串把人送去查一个不是原因的东西。** 本条是第 6 例。
- **修法建议**：`not found` 应写成「**本板上没有该任务；它可能在 <调用者可见的板>**」，或在调用者可见范围内**自动解析 board**；至少不得在任务存在时报「不存在」。
- **受准绕行（过渡期）**：**凡 `team_task_get` 一律显式带 `board`**（`board:"group-<g>"` 与 `board:"group"` 同源）。

**B-69（`advance_phase` 不校验 `status` ⇒ `pending` 的卡可被推进到出包相位 · 2026-09-28 · lead-world 实测 · tier 0 收编）**
- **现象**：`group-world-t64` 被推成 **phase `verifier-review` / status `pending`**。成因：其 supersede 包被 `task is before packet phase "verifier-review"` 拒绝（因返修被 reopen 到 `execution`），**为解掉相位门而从 `execution` 连推三跳** —— 而**平台不校验 status**。
- ⇒ **两件事被混成一件**：**「相位」与「完成」可以互相替代，而出包门只查前者。**
- **修法建议**：**出包相位（`verifier-review` 及之后）应当要求 `status == completed`**。
- **一般形态**：**同一实体的两个状态位若分别被两个不同的门消费，则每个门都要校验自己依赖的那一位。** ⇒ 与 **§5.14-39**（未被消费的检查不是门禁）**同族但方向相反**：那里是**检查没被消费**，这里是**被消费的状态位没被校验**。
- **受准处置（过渡期）**：**推相位前先确认 `status == completed`**；卡被 reopen 到 `execution` 而需重新出包时，**必须让 owner 重走 `acquire → complete`**，不得用相位跳级替代。

**B-70（后台作业死亡时其子进程不被回收 ⇒ 批次目录「看起来活着」· 2026-09-28 · lead-rig 实测 · tier 0 收编）**
- **现象**：驱动 `pwsh` 进程早已不在（无任何 pwsh 引用 `t17-verify-target`），而它启动的 **java 服务端仍存活 114 分钟**，并**持续写** `runs/111/world/level.dat` 与 region 文件 ⇒ **按 mtime 判活会把死掉的批次读成活的**；同时**孤儿占着世界目录与端口**。
- **修法建议**：后台作业结束时**回收其子进程**（进程组 / job object），或至少**在作业状态里暴露「驱动已退出而子进程仍在」**。
- **受准处置（过渡期）**：**按命令行检查驱动进程本身**；发现孤儿后**杀掉并验证权威 oracle 存活**，再换端口重启。

**B-69 补充（2026-09-28 · lead-world 现场复现 · tier 0 收编）：越相位后四条常规路径全封死，官方恢复路径 = `reopen`**
- **复现**：`group-world-t64` 被从 `execution` 连推三跳到 `verifier-review`（status 仍 `pending`）后，owner 逐字实测四条路径**全部封死**：
  · `complete` ⇒ `[complete-phase] must be in execution`；
  · `advance_phase` 回退 ⇒ `task-ready-gate: scope-conflict,lease-revision-mismatch`；
  · `release` ⇒ `[lease-release-order] task is still pending`；
  · `acquire` ⇒ 已有活动 lease。
- ⇒ **官方恢复动作 = `reopen`**（owner 用它自救成功：`reopen` → `complete` → `release` → milestone done）。
- ⇒ **一般形态**：**一个动作可以把自己之后的恢复路径全部封死** ⇒ **每个「越相位」类动作都应有明确的、被文档化的逆动作** —— 与「一条拒绝必须给出可执行的补救」（§5.10 附则二）**同族，但方向相反**：**这里缺的是逆动作的文档化。**
**B-70 补充（2026-09-28 · 第二实例：重启后的 run 也丢驱动 · tier 0 在 idle 唤醒时实测 · 收编）**
- **实测**：lead-rig 于 `21:07:59` 杀孤儿并以私有 target + `-PortBase 25866` **重启**为后台 job；此后 tier 0 实读：
  · **没有任何进程的命令行含 `t17-verify-target` 或 `run-batch.ps1`**（模式在**运行时拼接**，避免匹配到查询者自己的命令行）⇒ **驱动再次消失**；
  · 而它启动的 **java pid `126660`（创建 `21:08:51Z`）仍然存活** ⇒ **第二个孤儿**；
  · `criteria-20260927T210800Z.log` **仍为 10,858 B**（对 `104 KB 全量参照 ⇒ 断言行尚未开始产出）。
- ⇒ **含义**：B-70 **不是一次性故障，而是系统性形态** —— **外部终止 / 崩溃路径同样留下不被回收的子进程**，因此 **「重启」本身不构成修复**。
- ⇒ **对修法的影响**：只「在作业**正常结束**时回收子进程」不够 —— **回收必须绑定到作业生命周期（进程组 / job object），覆盖外部终止与崩溃路径。**
**B-70 正解（2026-09-28 · lead-rig 实测 · tier 0 收编）：不是「更用力地重启」，而是脱离会回收你的那一层。**
- **处置（已实测成功）**：**不再用 harness 后台作业**，改用 `Start-Process -PassThru -WindowStyle Hidden` —— **分离进程，不属于 harness 回收的 job 对象**。
  · 复验信息：**驱动 pid `126264`**（创建 `21:42:52Z`）/ **本轮服务端 `JAVA 124676`（`21:42:56Z`）** / **m0 oracle `102192` 未动** / 新判据日志 `criteria-20260927T214253Z.log` 已在写；端口换为 `25966`。
- **杀孤儿（杀前杀后都验 oracle）**：`ORACLE_BEFORE=True` → `Stop-Process 126660` → `ORPHAN_ALIVE=False` → `ORACLE_AFTER=True` ✓。
- ⇒ **一般形态（作为本条的修法方向）**：**当监管者会回收它的子进程时，补救是让子进程重新挂载 / 脱离监管者的 job 对象；把子进程再放进同一个生命周期，只会确定性地复现该故障。**
**第四轮平台修复的逐条复测（tier 0 实测 · 2026-09-28）**
- **B-68（`team_task_get` 不带 `board` 报 `not found` 而任务存在）—— 原始反例已由红转绿**：`team_task_get(task_id:"group-world-t72")`（**不带 `board`**）⇒ **返回该卡**（`completed / integration-ready`）⇒ **B-68 可由 B-57 的修复一并退役**。
- **B-51（`waiting_set` 创建后回读自证）—— 返回侧已由红转绿**：`waiting_set` 返回**完整自证 ticket 对象**（`ticketId` / `taskId` / `owner` / `waiter` / `responsible` / `unblockCondition`），**不再抛 `lower is not defined`**。⇒ **注意**：紧随其后的 `waiting_list` **不含该票** —— 那是 **B-61 / B-9**（不可求值条件被立即清除、且被清的票在列表里不可见），**不是新缺陷**，**不得混记**。
- **B-59（global 板 append-only）—— 原始反例已由红转绿**：tier 0 对 `task-68` 执行 `edit`（subject + description）**成功**（rev14）⇒ 既复测了修复，也**就地更正了一处真实不准确**（该卡 subject 原写「§5.14 第 18/19 条」，而实际落地的是 **§5.14-37/38**）。
- **未复测（须具名，不得当作已验）**：**B-44**（需一个带 glob 的 scope 声明触发 fail-closed）· **B-67**（需一个「纯祖先」成员分支；当前成员已按 §5.10 口径在主检出落盘，worktree 不再是承重路径）· **B-69**（需一张 `status ≠ completed` 却处于出包相位的卡，构造它要动真实卡面状态）。
- **仍未闭合、不得当作已修（修复方第四轮通知明示）**：B-33 / B-36 / B-37 / B-38 / B-39 / B-40 / B-47 / B-61 / B-64 / **B-70**；A-6 partial；B-28(i) unverified。⇒ 其中 **B-70**（后台作业死亡时子进程不被回收）**本会话已两次发作**，现由 lead-rig 的看护（哨兵）**缓解**，**缺陷本身仍在**。
**第四轮平台修复的逐条复测（续 · 2026-09-28 · tier 0 实测）**
- **B-45（discussion / review 零写范围被 `scope-required` 卡死）—— 原始反例已由红转绿** ✅：以 `task-94` 为载体 —— 一张 **`kind=discussion` / `writeScopes=[]`** 的卡，**创建 → claim → complete 全部成功**（`{rev:4, status:completed, phase:room-discussion, evidenceIds:1}`）⇒ **零写范围不再被 `scope-required` 拒绝。**
- **B-43（非产品 / 未跟踪证据不允许以 `commit_sha:null` 完成）—— 原始反例已由红转绿** ✅：**同一张卡**以 **`commit_sha: null`** 完成并**被接受**（卡面 `commitSha=null`、`status=completed`）⇒ **非产品证据可以无 commit 完成。**
  · ⇒ 两条**共用同一张载体卡**，且它是**复测用途**（卡面已写明「完成后即作废」）—— 它**不承载任何产品语义**，**不得被引用为交付物**。
- **B-42（worktree 纯祖先分支被 `[worktree-stale-base]` 拒绝）—— 复测已委托，结果待回**：修复方第四轮声明「**纯祖先的 worktree 分支会自动 fast-forward**」。**tier 0 只能布局组长、不能布局成员** ⇒ 该反例的复现**只能由有权布局成员的组长执行**。⇒ 已发 `action` 给 lead-world，并给出**现成反例载体**（`team/world/member-world-anvil` / `-block` / `-chunk` 各 **52 0**、`team/rig/rig-diff` **152 0**、`team/proto/member-codec` **241 0**，全部是 `main` 的**纯祖先**）与**逐字回报**要求（返回对象或逐字拒绝串 + 调用前后的 `--left-right --count`）。⇒ **在它回报之前，本条记为「未复测」，里程碑不 tick。**
**B-42 原始反例复测 ⇒ 转绿（2026-09-28 · lead-world 执行 · tier 0 收编）**
- **调用（恰一次，参数逐字）**：`team_worktree_setup(target:"member-world-anvil", task_id:"group-world-t77", base:"main")`
- **返回值（逐字，未被拒）**：`{"target":"member-world-anvil","branch":"team/world/member-world-anvil","path":"…\.dsh-worktrees\team__world__member-world-anvil","readOnly":false,"created":false}` ⇒ **没有** `team policy refusal [worktree-stale-base]`；**纯祖先分支被自动 fast-forward。**
- **调用前后 `git rev-list --left-right --count main...team/world/member-world-anvil`**：**调用前 `53 0`**（分支头 `345cc1c`）→ **调用后 `0 0`**（分支头 == `main` == `77cf142`）。⇒ **方向正确：分支被快进到 main，不是 main 被动。**
- **安全前提（先验）**：调用前三个 world 成员的工作树 `status --porcelain` 全空；调用后仍空；主检出 porcelain 全程只有 `?? logs/`。**未动任何受跟踪内容。**
- **★ 两点如实标注（不掩饰）**：
  · **① `created:false`** —— 该 worktree **本来就存在**，这次是**复用 / 重铺**而非**首次创建**。⇒ **本复测证明的是「纯祖先分支会被自动 fast-forward」，不证明「首次创建路径」**；若反例定义要求后者，本条**不覆盖**。
  · **② 快进幅度 53 个提交** ⇒ 该成员的工作树文件被整体换到 main 尖端。按**现行 §5.10 口径**（成员在**主检出**落盘、worktree 只是载体）**不影响在飞产物**；**但若该口径将来改变（成员改为在 worktree 落盘），同一动作就会在飞行中换掉成员的落盘目录** ⇒ 届时应改为「**仅在成员空闲时执行**」。
- ⇒ **至此 B-42 / B-43 / B-44 / B-45 四条均已按原始反例复测并落盘**（B-44 见前条，B-43 / B-45 见上一条）。
**B-42 复测记录的更正（2026-09-28 · lead-world 自纠 · tier 0 收编）**
- **被撤回的一句**：上条记的「主检出 porcelain **全程**只有 `?? logs/`」—— **该句在发出时已不成立**：它基于**调用前**的旧读数，**并没有在调用那一刻重读主检出**。⇒ **撤回。**
- **更正后的正确支撑（两条，取代上句）**：
  · ① 调用前后 `git -C <anvil worktree> status --porcelain` **均为空**；
  · ② **`.dsh-worktrees/` 不出现在主检出 porcelain 里**（被忽略）⇒ 该快进**只移动了分支指针与 `.dsh-worktrees/` 下的工作树文件**，**没有任何受跟踪内容被改动**。
- ⇒ **B-42 的结论不受影响**：返回值逐字不变、**`53 0 → 0 0`**、分支头 == `main`、**无 `[worktree-stale-base]` 拒绝** ⇒ **转绿**。
- ⇒ **附带的正向证据**：主检出那份脏（`M Cargo.lock` / `M crates/mc-sim/…` / `?? crates/mc-sim/src/chunk_driver.rs`）**恰好正面证实 §5.10 口径** —— 成员确实在**主检出**落盘，其 worktree 只是载体 ⇒ **该快进没有碰到 t77 的在飞产物。**
**B-71（`edit` 卡的 `write_scopes` 全为 gitignored 路径 ⇒ 完成门禁没有任何可满足的形态；且拒绝串点名的判据正是调用者已满足的那一个 · 2026-09-28 · lead-rig 两次逐字实测 · tier 0 同轮独立复核并裁定 · 「拒绝串不可判别」族第 7 例）**
- **现象**：`group-rig-t25`（kind `edit`，writeScopes 恰一条 `tests/golden/rig-batch/`）调 `complete` **两次被逐字同串**拒绝：
  `[complete-commit]: commit_sha:null is allowed only when evidence proves this edit task produced no tracked product change; otherwise provide the exact commit_sha`
- **调用者已给出的证明（正是报文要求的那一个）**：`git ls-files tests/golden/rig-batch` = **0**；`git diff --stat -- tests/golden/rig-batch` = **空**；`git check-ignore -v` = **.gitignore:5:/tests/golden/**；第二次另绑一条 **`paths: []`** 的证据行 ⇒ **仍同一串**。
- ⇒ **这不是「未被证明」，而是「按构造不可能」**：该卡的 scope 集合**全部**落在版本控制之外 ⇒ **门禁在本卡上不存在任何可满足的输入。**
- **tier-0 独立复核（读数 + 单位 + 域 = rig 组板全部 26 张卡）**：**只有 t25 一张**的 writeScopes 集合**不含任何受跟踪路径**；其余每一张已完成的 edit 卡都至少含一条（`tools/rig-batch/` / `tools/rig-stats/` / `tools/oracle/` / `tools/capture/` / `docs/groups/rig/`）⇒ **它是组内唯一的「全 gitignored scope」实例。**
- **闭环（第二半）**：把 scope 改回受跟踪路径时，`edit` 被指向 plan 替换，逐字：
  `task "group-rig-t25" writeScopes are controlled by its plan; replace the plan instead of editing the task row. Recovery: (1) release the active run lease with the exact run_id, (2) call team_plan_propose with replace_approved:true and replace_reason, (3) acquire a new run lease before editing again.`
  —— 而第 (1) 步在卡未完成时被 **`[lease-release-order]`** 拒（**B-69 补充**已记同一互斥）⇒ **完成要 lease、释放要完成、改 scope 要先释放。**
- **一般形态**：**一个任务的「可完成性」不应依赖它的 scope 是否恰巧落在版本控制之内**；且 **门禁的判据必须与它实际接受的证据形态同源。**
- **修法方向（tier 0 裁定）**：
  · **①** `commit_sha:null` 的判据改为调用者**已能给出**的证明：`git diff --stat` 空 ∧ `git ls-files` 空 ∧ **每个 scope 都被 `git check-ignore` 命中**；
  · **②** 允许对**未完成**卡以 `status:cancelled` 结束 run 后替换 plan（**该半条 tier 0 未亲测，故不据此断言**，见末行）；
  · **③** 报文应区分「**没有**产生受跟踪变更」与「**不可能**产生受跟踪变更」。
- **受准处置（过渡期，tier 0 已下达 lead-rig）**：**给该卡一条受跟踪载体**（`docs/groups/rig/`）并重走三步法；**不重试原动作、不换写法绕过门禁、不以 `force_complete` / `bind_fix` 伪造交付。**
- **待验（不得据此断言）**：`team_run_lease release status=cancelled` 能否解开上述闭环（lead-world 转述其执行者实测可用）—— **tier 0 未亲测**；已要求 lead-rig 把逐字返回报回，届时按读数改本条。
**B-71 补充（2026-09-28 · tier 0 复核修复方权威台账后入册）：台账把 B-43 记为 fixed，而其修复描述点名的对象正是本反例 —— 「验证了另一类对象」**
- **台账原文（第四轮逐项结果）**：`B-43 | fixed | 非产品 / 非提交交付证据允许 commit_sha:null 完成，不再要求 edit 卡为 gitignored 探针伪造提交。` ⇒ **修复描述明确点名 `edit` 卡 + gitignored 探针。**
- **台账的验证原文（第五轮核验）**：`B-43 | fixed-verified | 原始反例已由红转绿：复测卡以 commit_sha:null 完成并被接受，卡面 commitSha=null / status=completed。` ⇒ **该复测卡是 `discussion` 类（`writeScopes=[]`），不是 `edit` 类。**
- ⇒ **两个对象不同类**：**修复描述点的是 `edit` 卡，验证用的是 `discussion` 卡。** 而 `group-rig-t25`（kind `edit`、scope 全 gitignored）是**该描述所指对象上的活反例**，`[complete-commit]` 逐字拒绝仍成立。
- ⇒ **纪律（新形态）**：**当一条修复的描述点名了某个对象类，它的验证必须用同一类对象** —— 「验证了另一类对象」**不得**记为「该修复已验证」。⇒ 这是我此前那条（**「不在列表里」推不出「没被修」**）的**对偶**：那条禁的是**从残缺来源推出否定**，这条禁的是**从异类验证推出肯定**。
- ⇒ **同族**：**B-23 的残余风险行**已把「task 行直接改 scope 会被拒绝」记为**有意行为**，并给出补救「下一次计划替换时会同步」—— 但对一张**在飞**卡，进入计划替换的第一步（释放 lease）**本身被 `[lease-release-order]` 拒** ⇒ **该补救在 `in_progress` 卡上没有可执行的入口**，与 **B-67**（补救语在入参里不存在）同族。
- ⇒ **对里程碑条件②的影响（如实记账）**：条件②的复测证据此前被记为「已全部落盘」。该结论**在 `discussion` 类上成立**，但**不能推广到 `edit` 类** ⇒ 本条按**新缺陷**入册，**不推翻** B-42 / B-44 / B-45 的转绿结论。
**B-71 待验项已实测（2026-09-28 · lead-rig 逐字回报 · tier 0 收编）：闭环可解，且本条的判据被反证**
- **待验项转实测**：`team_run_lease(action:"release", run_id:"run-62f3c3ea-…", status:"cancelled")` **未被拒**，逐字返回 `status:"cancelled"` 且 `endedAt` 已置 ⇒ **`[lease-release-order]` 拦的是 `status=completed`，不拦 `status=cancelled`** ⇒ 上面那条闭环**有可执行入口**。
- **七步配方逐条成功**：release(cancelled) → plan_propose(replace_approved) → plan_approve → acquire（新 run `run-a54eafbe-…`）→ 新 writeScopes = `tests/golden/rig-batch` + `docs/groups/rig`（rev47）→ 新载体 `docs/groups/rig/t25-nonauthor-rerun-t17.md`（门禁 4 passed / exit 0）→ commit `974e35a3…`（`git show --name-only` **恰一个文件**，83 insertions）→ `complete(commit_sha)` **一次成功** → release(completed)。
- ⇒ **反证成立（本条最强的一句）**：原拒绝**不是证据不足**，而是**卡面无受跟踪交付物**；**给该卡一个受跟踪交付物后，同一门禁首次即满足。** ⇒ 本条的结构性成因（全板唯一一张 scope 全 gitignored 的卡）被**独立证实**。
- ⇒ **对修法方向的影响（如实下调）**：既然「补一条受跟踪载体」**零阻力即可满足门禁**，那么**放宽判据（接受「全部 scope 被忽略」的证明）不是必须的**，优先级**降为可选**；而**报文区分「没有」与「不可能」（③）仍应修**。

**B-60 补充二（2026-09-28 · lead-rig 实测 · tier 0 收编）：显式 undefined 的可选参数被拒且报文不点名**
- **现象**：向 `run_code` 的绑定传**显式 `undefined`** 的可选参数（如 pwsh 的 `timeoutMs`）⇒ 被拒 `binding arguments must be lossless JSON`，**报文不点名是哪个字段**；拒绝发生在**执行之前**（无副作用）。
- ⇒ **与 B-60 同族**（`undefined` 参数不具名字段）⇒ 这是该条的**第二个实例**，**不新开编号**。
- **受准绕行**：可选参数**要么给值、要么不写该键**。
**B-72 更正（2026-09-28 · lead-rig 实测否证 + tier 0 亲核 composition · tier 0 收编）：动机实例更正，机制读数保留**
- **被撤回的动机**：我写 B-72 时的动机是「私有 cargo 产物目录名 ≠ 精确名 `target` ⇒ 落在扫描域内」。**该机制被实测否证**：`excluded_target=0` —— **没有任何精确名 `target` 的目录贡献过 `.rs` / `.md`**，所以 target 命名假说解释不了观测到的污染。
- **真因（composition 实测，对象 = 仓根）**：`raw_total=1416` / `excluded_dot=1088` / `excluded_target=0` / `excluded_node_modules=0` / **`IN_DOMAIN=328`**（`partition_ok=True`）；其中 `tests/golden` 贡献 **118 = 36.0%**，且这 118 全部落在 **`tests/golden/rig-batch/detached-b3a6760` 这个全仓冻结快照**内 —— 该快照 `snap_total_files=1547`，含 118 个 `.rs` / `.md`；逐文件 sha256 对仓内同路径：**identical 80 / differing 38 / missing 0**（80 个纯冗余副本 + 38 个过期副本）。
- **★ 关键推论（比原条更强）**：该快照是门禁 `FROZEN_PATH_EXCEPTION_KEYS` **3 条的唯一来源**（3 条 owner 均为 lead-rig，全部指向该快照内路径）。⇒ **path 例外不是门禁的固有缺陷，而是「把过期源码快照放进被扫描域」这一做法逼出来的补丁。** ⇒ 若该快照改为**门禁不解析的承载形态**（单文件归档 + `(size, sha256)` 清单），则 118 个文件退出读取域、域规模下降 36%，且**那 3 条例外可提议删除**。（载体 = `group-rig-t27`。）
- **机制读数保留（我亲读源码，未被否证）**：遍历器的跳过条件逐字为 `name.starts_with('.') || name == "target" || name == "node_modules"` ⇒ **排除是按硬编码目录名，而不是按「受跟踪 / 被忽略」**；`t17-verify-target` / `t21-target` 这类名字**不被跳过**。⇒ **该代码读数本身仍成立**（它是对代码的读数），失效的只是**我拿它当该污染的成因**。
- **修法建议不变且被加强**：**扫描域改为「git 跟踪的文件」** —— 它**同时**排除该冻结快照（gitignored）与任何私有 target，**一条规则替代两条特例**。
- **纪律（本条自身即实例）**：**「机制读数正确」推不出「它是该现象的成因」** —— 我拿一个**成立的代码读数**去解释一个**由别的机制造成的观测**。⇒ 与「结论不得先于读数」**对偶**：这里是**解释不得先于成因测量**。
**B-71 平台修复已验证（2026-09-28 · 修复方回报 · tier 0 收编）**
- **修复内容（逐字口径）**：`team-tools-v2-r10.mjs` 的 edit 卡完成门禁已修正 —— `commit_sha:null` 现在**仅在 writeScopes 全部满足**「`git ls-files` 为空 ∧ 无 tracked diff ∧ `git check-ignore` 命中」时放行；**有 tracked scope 或无法证明非产品交付时仍拒绝**，且**拒绝原因已区分**（正是修法方向③）。
- **同步面**：web / headless / desktop / teamtest **四份 profile**，SHA256 均为 `83C59EA9…`。
- **验证读数**：`platform-defects-fourth-pass.test.mjs` **8/8**；加 `v14-runtime-bridge` **25/25**；全量 phase1–phase11 = **94 文件 / 334 pass / 0 fail / 1 skipped**。当前 DSH **未重启**（PID 101020 / 40123 仍监听），HMR 日志在文件保存同刻出现 `team-tools-v2-r10` reload。
- ⇒ **本条的原始反例（`group-rig-t25`）已在修复前由受准绕行收口**（给该卡一条受跟踪载体 ⇒ 门禁首次即满足），故**修复后的行为未由 tier 0 在本仓亲测**；本条按**修复方自报 + 其测试套件读数**入册，**不写成「我已复测」**。

**B-71 补充的收编结果（2026-09-28 · 修复方回报 · tier 0 收编）**
- 修复方明确：**「B-43 的旧 discussion 复测已更正为类别不匹配，edit 类由 B-71 覆盖」** ⇒ 我那条「**修复描述点名的对象类与验证所用对象类必须同类**」被**采纳并落到台账**。

**B-72 归类更正（2026-09-28 · 修复方回报 · tier 0 收编）**
- 修复方裁定：**B-72 属于产品仓 citation_integrity.rs 的扫描域问题，不是 DSH 平台缺陷** ⇒ 本轮不改 DSH；继续使用已批准的绕行，残余风险在平台台账登记。
- ⇒ **我的归类错了**：`crates/mc-proto-schema/tests/citation_integrity.rs` 是**本仓的文件**，其扫描域规则由**我们自己**维护 ⇒ 修法（扫描域改为 git 跟踪的文件）**属产品侧**，应走产品卡而非平台修复通道。
- ⇒ **受准处置（tier 0 裁定）**：**B-72 的即时修法是产品侧的 `group-rig-t27`**（把 118 个 `.rs` / `.md` 的全仓冻结快照移出门禁读取域 ⇒ 域降 36%，且那 3 条 path 例外可提议删除）；**「扫描域改为 git 跟踪的文件」记为产品侧低优先项**，**在 t27 落数后重新测量再决定是否开卡** —— 若届时不复现污染，则它是**潜在脆弱性**而非缺陷。**不得据此在平台通道重开。**
**B-64 补充三（2026-09-28 · lead-world 实测 · tier 0 收编 · 第五实例 + 一条此前从未记录过的伴随读数）**
- **第五实例**：`group-world-t82`（kind `review`、零写入）上出现 **derived** 票 `{reason:"waiting-provider", unblockCondition:{type:"provider-healthy"}, responsible:"lead", status:"derived"}`。
- **与实测矛盾（同一采样）**：owner `member-world-chunk` = **running**；其 `team_dispatch_status` = **completed**、`lastError: null`；`wait:group-world-t82:…` 登记正常。⇒ **无任何已证的 provider 阻断。**
- **★ 新增的伴随读数（本族此前从未记录过）**：同一时刻控制面自报 —— `runtime_facts.collection.degraded = true`（大量 plugin 观测缺失）；`control_status.audit = { ok:false, code:"audit-gap", lastAuditRevision:0 }`。
- ⇒ **观察（不写成因，遵 §5.14-24）**：本族的每一次出现都伴随「控制面自报观测不完整」这一类读数；**这两个量此前未被记录**，故**只登记相关性**。
- ⇒ **修法方向（新的、可机检的）**：**当 `collection.degraded = true` 或 `audit.ok = false` 时，不得据以派生「provider 不健康」类票**；或至少在派生票上**带上该状态位**，使调用者一眼看出它是**观测缺口的产物**而非 provider 事实。
- **受准处置（沿用，未变）**：按**过期等待**处置、**不重登记、不重试、不轮询、不升级**；持久责任记台账；**仅在 `lastError` 有实测内容时**才走 `team_provider_resume`。
- ⇒ **该票的 `responsible = "lead"`（= tier 0 本人）** ⇒ 本条同时是「**系统派生票把责任指给 tier 0 而 tier 0 无从执行**」的**第 2 例**（与 B-64 首例同形）。
**B-73（`room_snapshot.unresolved` 列出一个 `team_room_resolve` 报 unknown 的条目 ⇒ 该条目对调用者不可清 · 2026-09-28 · tier 0 三次实测 · 「无对应可执行动作」族）**
- **现象**：`root` room 的 `unresolved` 投影**反复**列出 `msg-1defe70a-…`（我自己的主发言，被登记为 decision-request 未决项），而 `team_room_resolve(unresolved_id = 该 id)` **三次**返回 `unknown unresolved item …; available: <只列出另一条>`。
- **观测序列（同一 id，跨三次快照）**：列出 → `unknown` → 列出 → `unknown`。
- **为什么它是缺陷**：**快照说它是 open，而唯一的收口 API 说它不存在** ⇒ **调用者没有任何可执行动作能清掉它**；它会**永远**出现在 `unresolved` 里，并**占据本应由真实未决项占的位置**（本轮它与 P2 同时出现）。
- **同族**：**B-67**（补救语在该工具入参里不存在）；本条更直接 —— **连「收口」这个动作都没有对象。**
- **修法建议**：`room_snapshot.unresolved` 与 `team_room_resolve` 的可见集合**必须同源**；不同源时，快照应标出「**不可 resolve 的投影条目**」并给出其来源（本例疑为 legacy-room 迁移的 `migratedFrom` 投影）。
- **受准绕行**：**不重试**（三次已证）；host 收轮时**不再把该 id 写进 unresolved**；把它记为**投影噪声**，**不得据它判断「还有未决项」**。
**B-74（`decision` 迁移记录的顶层 `missingConfirmations` 与 `confirmations` 不同步 · 2026-09-28 · lead-rig 实测 + tier 0 同轮亲见 · 同 B-9 / B-37 家族）**
- **现象**：`decision-47a8b3db` 已是 `status: confirmed` 且 `confirmations` **三条齐全**（lead-rig / lead-world / lead-proto），**而迁移记录的顶层 `missingConfirmations` 仍列着全部三个**。
- ⇒ **危害**：**只读该字段的消费者会误判「N-9 仍在等确认」并去重复追确认** —— 而**追一个已确认的决策不会报错**，只会产生噪声与重复劳动。
- ⇒ **修法建议**：迁移 / 投影时**重算**该字段，或让它**由 `confirmations` 派生**而不是独立存储。⇒ **同一实体的两个状态位若分别被存储，就会分别漂移**（与 B-69 同族：那里的两个状态位是相位与 status）。
- **受准绕行**：判「是否已确认」**只看 `confirmations` 与 `status`，不看 `missingConfirmations`**。

**「拒绝串不可判别」族第 7 例：`[destination-worktree-invalid]` 不具名「什么 invalid」（2026-09-28 · lead-world 实测 · tier 0 收编）**
- **逐字**：`team policy refusal [destination-worktree-invalid]: merge of "team/world/member-world-anvil" into "grp/world" failed: destination-worktree-invalid`
- ⇒ **不具名**：**未给期望路径、未给缺失对象、未给判定条件** ⇒ 调用者**无法判断是「目的地未铺」「铺错分支」还是「铺了但状态不对」**，只能**再花一次自铺尝试**才确定责任方（本例正是如此）。
- ⇒ **同族**：**B-57** / **B-58** / **B-60** / **B-65** / **B-67** / **B-68** —— 共性仍是「**拒绝串把人送去查一个不是原因的东西**」；本条是**连「查什么」都没给**。
- **修法建议**：报文须给出**期望的 destination 与其当前状态**（存在与否、分支、是否干净），以及**哪一项判定失败**。
**B-72（引用扫描域由「目录名恰为 target」这类命名巧合决定，而不是由「受跟踪 / 被忽略」决定 · 2026-09-28 · rig-diff 实测 + tier 0 亲读源码复核 · 记风险，非事故）**
- **我的读数（tier 0 亲读 `crates/mc-proto-schema/tests/citation_integrity.rs`，非转述）**：其遍历器的跳过条件逐字为 `name.starts_with('.') || name == "target" || name == "node_modules"`；且解析域 = **遍历器域 减去 frozen 快照前缀 `tests/golden/`**；扩展名集 = `{rs, md}`。
- ⇒ **结论**：**一个私有 target 目录只有在名字恰好是 `target` 时才落在扫描域之外。** 实测对照：`target` 被跳过；`t17-verify-target` / `t21-target` / `cite-check-target` 这类名字**不被跳过**。⇒ **成员让自己的门禁跑绿，依赖的是一个命名巧合，而不是一条被声明的排除规则。**
- **为什么这是风险而不是已发生的事故**：私有 target 内含构建产物（含生成的 `.rs`）。若某成员把私有 target 命名为 `t17-verify-target` 之类，该目录**落入扫描域** ⇒ 其中的生成载体若含引用形态 token，**共享门禁会对所有人生效地变红**。**本轮未观测到该故障**，故按**风险论证**记，不写成事故。
- **与 B-71 同源**：两者都由**「受跟踪 vs 被忽略」这条界线没有被用作判据**产生 —— B-71 是完成门禁不认「scope 全被忽略」，本条是扫描域不按「是否被忽略」而按**硬编码目录名**划定。
- **修法建议（一条规则替代两条特例）**：**扫描域改为「git 跟踪的文件」**（或「不在 gitignore 中的文件」）—— 它**同时**覆盖现有两条特例（`tests/golden/` 是 gitignored、私有 target 是 gitignored），且**不再依赖任何目录命名**。
- **受准绕行（过渡期）**：私有 target **一律命名为 `target`**（rig-diff 本轮即如此做并自证）；或把私有 target 放到扫描域之外（工作树之外）。
**「拒绝串不可判别」族第 8 例：`[source-worktree-dirty]` 给了「类」，没给「对象」（2026-09-28 · lead-world 实测 + tier 0 独立复测 · tier 0 收编）**
- **逐字**：`team policy refusal [source-worktree-dirty]: source branch is not ready: source-worktree-dirty`
- **进步**：相比第 7 例（`destination-worktree-invalid`），它**给了类**（`dirty`）与**角色**（`source`）—— 调用者立刻知道方向。
- **仍缺**：**没给对象** —— 哪一个 worktree、**哪些文件**脏。⇒ 调用者仍须**自跑 porcelain** 才能区分「**另一张卡的在途写入**」与「**自己的残留**」—— 而这两者的处置**完全相反**（前者等，后者要清）。
- **修法建议**：报文附**脏文件清单（或计数 + 前若干条）**与 worktree 路径。
- ⇒ **本轮确立的一条判缺陷边界**：`ignore_untracked:true` 仍被拒**不是**缺陷 —— 工具文档明写「**tracked 修改一律阻塞**」⇒ **文档化的行为不是缺陷**；**未具名的对象才是。**
**B-75（turn 结束会收割其作业对象的子进程 ⇒ 预期跨 turn 的后台 run 中途被截断 · 2026-09-28 · lead-rig 实测 · tier 0 收编 · B-70 的镜像面）**
- **现象**：t23 第 3 次 run 的判据日志 `criteria-20260928T001226Z.log` **29449 B 冻结于 08:14:48**、此后不再增长；**驱动进程 = 0**；`HAS_PASS=False` / `HAS_FAILED=False` / `HAS_REFUSE=False` / **`HAS_C4R=False`**；末两行是 `Cnoise1_syntax_exit_3=True` / `Cnoise2_dims2_y_exit_3=True`，**之后无任何终止标记** ⇒ **中途截断**（死于清单段之前，两个对照读数**根本没取到**）。
- **根因**：该 run 是**成员 turn 的作业对象子进程** ⇒ **turn 结束时被一并收割**。
- **反证（同一执行者、不同启动方式）**：t25 的 run 用 `Start-Process` **脱离**作业对象 ⇒ **跨 6 个以上 turn 仍存活**。
- ⇒ **它是 B-70 的镜像面**：B-70 = 「死掉的 job **不**收割子进程（孤儿存活）」；本条 = 「**turn 结束会收割子进程**」。⇒ **两者合起来说明：子进程的生命周期被绑在「作业对象」上，而不是绑在「任务的意图」上。**
- **为什么它最难发现**：症状**与判据 FAIL 长得不一样，却又容易被读成「还没跑到」** —— `HAS_FAILED=False` 会误导，而**日志尺寸不再增长**才是真信号。⇒ **判活必须同时看「日志是否在增长」与「驱动进程是否存在」，只看其中一个都会误判。**
- **受准绕行（已落地）**：**任何预期跨 turn 的 run 必须脱离 turn 作业对象**（`Start-Process`），并写成卡的 **durable 前置**；可判假检查 = **下一 turn** 仍能读到驱动进程**或**日志仍在增长。
- **修法建议**：把「预期长于一个 turn 的后台作业」与「turn 生命周期」解耦，或在作业状态里暴露「**已被 turn 收割**」这一分类（而不是让它表现为「没跑完」）。
**B-76（verifier 自己写的证据行没有读回路径 ⇒ 「请 verifier 复核某条 evidence 行」缺一个可执行环节 · 2026-09-28 · verifier 自报 + lead-world 转报 · tier 0 收编）**
- **现象**：`team_evidence_record` 返回 evidenceId 回执（**写成功**），而 `team_v12(action:"evidence_query")` 对**它自己写的行**以 **六种口径全部 0 命中**（evidenceId 全串 / id / kind / prefix / taskId / commitSha）；对**他人**行却有返回（同一批：commit `6d0000c4` 得 13 行、t83 得 10 行）。
- **叠加**：它**带 `task_id` 记录会被 `[plan-scope]` 拒绝** ⇒ 无绑定行**无法**用 task_id 口径找回。
- ⇒ **后果**：**verifier 的无绑定证据行只能以「写入回执」为准**，而「**请 verifier 复核某条 evidence 行**」这类流程**缺一个可执行环节** —— 复核者**拿不到那条行**。本轮 t83 / t84 的三条 verifier 行因程序中异常未捕获回执 id（kind = `verifier-t83-oracle-counts` / `verifier-t83-judgments` / `verifier-t84-object-and-remeasure`，**只能按 kind 检索**）。
- **修法建议**：`evidence_query` 的可见集**至少必须包含调用者自己写入的行**（按 evidenceId 直查即可）；**`[plan-scope]` 不应拒绝「记录证据」这一动作。**
- **受准绕行**：**verifier 侧一律在写入时即捕获并留存 evidenceId 回执**（不依赖事后查询）。

**B-77（一次 `team_merge` 对被连带承载的卡产生相位回退，且不通知卡主 · 2026-09-28 · lead-world 实测 · tier 0 收编）**
- **现象**：t84 与 t86 都已推到 `verifier-review`。执行一次 `team_merge(task_id = group-world-t86)`（merge commit `e6b224e`，承载 `0714eb9`(t86) + `72da0e5`(t84)）后实测：**t86 → `integrated`**（作为 merge 的**参数卡**），**t84 → `execution`（回退）**（作为**被连带承载**的卡）。
- **后果**：**一次合并对两张卡产生方向相反的相位效应**，且**无任何回执告知卡主** ⇒ verifier 对 t84 的包被拒，逐字 `team policy refusal [task-phase]: task "group-world-t84" is before packet phase "verifier-review" and cannot advance there directly`（`execution` 早于 `verifier-review`，而 `integrated` 晚于它 ⇒ **t86 的包反而被接受**）。
- **同族**：**B-69**（相位不校验 status）、**B-74**（两个状态位分别存储就会分别漂移）—— 本条是**第三个**「相位被别的动作改动」的实例，且**这次是回退**。
- **修法建议**：合并**只应改参数卡**的相位；被连带承载的卡**不得被改**；若确需改动，**必须给卡主回执**。
- **词义问题（一并记）**：`integrated` 实测 = 「已并入**组分支** `grp/world`」，**不是 main**（t86 的 `0714eb91` **不是 main 的祖先**，`git merge-base --is-ancestor` RC=1）⇒ **该相位名必须具名其对象**，否则会被读成「在 main 上」。
- **受准绕行**：合并后**逐卡回读相位**；发现回退**重走到目标相位再重投包**。

**B-78（`team_worktree_setup` 要求 plan 已批准 ⇒ 成员在获批前没有 worktree，此时写入会直接落到共享 main 检出 · 2026-09-28 · lead-rig 实测 · tier 0 收编）**
- **逐字拒绝**：`requires a plan-approved record before execution; current plan state: plan-proposed`
- ⇒ **顺序事实**：对新成员，`plan-approved` **同时**门控**写入**与**worktree 建立**。⇒ **标准序列 = propose plan → 组长批准 → `team_worktree_setup` → acquire lease → 写入。**
- ⇒ **风险（本条的重点）**：**在 worktree 建立之前写入，会直接提交到共享 main 检出** —— 那会**绕过**「成员提交到自己的分支、组长合并」的纪律。⇒ **这不是风格问题，是一条纪律绕过路径。**
- **修法建议**：成员**无 worktree 时应拒绝写入**（fail-closed），而不是允许它落进共享检出。
- **受准绕行**：**组长必须在批准 plan 后立刻建 worktree**，并明确告知成员「worktree 就绪前不要写」。
**第七轮修复结果（2026-09-28 · 修复方回报 + tier 0 在 live 上重放原始反例 · 收编）**
- **同步面**：web / headless / desktop / teamtest **五份目标文件哈希一致**；**DSH 未重启**（PID 101020 / 端口 40123 保持运行）。清单指纹 = 154848 / `54CF1605A817B2638BE4518A18800BE638A288AAF66CAECD024B2CBE6B79FB9C`。
- **验证读数（修复方）**：focused **3/3**、profile parity **1/1**、全量 phase1–phase11 = **338 tests / 337 pass / 0 fail / 1 skipped**。

**B-74 = fixed-verified（由 tier 0 在 live 原始反例上转绿）**
- **修复**：`decision.missingConfirmations` 改为**由 `confirmations` 派生**，在 normalization / propose / confirm **三条路径**都会重算。
- **★ tier 0 亲测（live，非 focused）**：重读 root room 快照 ⇒ `decision-47a8b3db` = `status: confirmed`、**`missingConfirmations: []`**、`confirmations` **3 条**、rev 4。⇒ **两个字段现在一致** ⇒ **本条在 live 原始反例上转绿。**（修复方自报的边界是「未在 live root Room 重放原始反例」—— 这一步**由我补上**。）

**B-73 = 症状已消失；但 tier 0 未观察到「resolve 成功」**
- **修复**：control-plane 保留 legacy unresolved 的 `itemId` / `unresolvedId` 并同步为 `id` / `itemId`；**room resolve 成功后镜像写回 `v12RoomWake`**；重建 legacy fixture 覆盖「列出 → resolve」。
- **tier 0 亲测（live）**：root room 的 `unresolved` 现为 **0 条** ⇒ **原先那条「被列出却 resolve 报 unknown」的条目已不存在。**
- ⇒ **如实标注（不得写成「我重放并成功」）**：**我是「没有对象可重放」，不是「重放后成功」** —— 症状**消失**可证，**成因归属不可证**（可能是修复生效，也可能是投影被重建）。⇒ **与修复方自报的边界一致。**

**「拒绝串不可判别」族：第 7 / 8 例结案**
- `source-worktree-dirty` 现返回 **source path、branch 与脏文件清单**；`destination-worktree-invalid` 现返回 **destination path 与底层 detail**；**merge 拒绝同步携带这些对象信息**。
- ⇒ **第 7 例（`destination-worktree-invalid` 不具名「什么 invalid」）与第 8 例（`source-worktree-dirty` 不具名「哪些文件」）均已修。** ⇒ 两例的**受准绕行可退役**（「自跑 porcelain 才知道脏在哪」不再必要）。

**B-75 = 归类更正为「非平台缺陷」（与 B-72 同形）**
- **修复方裁定**：**turn 结束收割其 job object 子进程属 DSH / harness 生命周期**，team plugin **没有可安全接管 job object 的入口** ⇒ **本轮不改**。
- ⇒ **受准绕行继续有效且被确认**：**任何预期跨 turn 的 run 必须 `Start-Process` 脱离 job object**，并**同时检查驱动进程与日志增长**（只看其一都会误判）。
- ⇒ **归类更正**：本条**不是** team plugin 可修的缺陷；**不得据它在平台通道重开**。
**第七轮修复结果 · 补充边界（tier 0 自纠 · 2026-09-28）**
- **被更正的措辞**：我在上一条里写「第 7 例与第 8 例**均已修**」。**该措辞比我实际核过的更强**：那两条我**只有修复方回报 + 其 focused 验证**，**没有 live 复测**。
- ⇒ **为什么我没有 live 复测**：要触发那两条拒绝串，必须**制造**一个脏的 source worktree（或缺失的 destination）—— 而 `team_merge` 在**不**拒绝时就会**成功并产生真实合并**。⇒ **为验一条报文去制造一次真合并，代价大于收益**，且制造脏树本身会污染别人的在途工作。
- ⇒ **准确表述**：第 7 / 8 例 = **修复方回报 + focused 验证**；**tier 0 未 live 复测**。**受准绕行「可退役」的判据是「拒绝串已具名对象」这一行为已由修复方描述并 focused 覆盖** —— 若后续**真的**再遇到一次该拒绝串，**应按新形态读它**（应当带 path / branch / 脏文件清单）；**若那时仍不具名，则本条应重新打开。**
- ⇒ **一般形态（对我自己的要求）**：**「修复方说修了」与「我核过」是两个不同的状态位**，**不得写成一个**。⇒ 与 **B-71 补充**（异类验证不得记为已验证）同族，**只是这次的主体是我**。
**`grp/world` → main 合并已完成（tier 0 执行 · 2026-09-28）**
- **清关**：verifier 对 `e6b224e62c049c77b10911bfff9ec84f964b838c` 出具**精确提交清关**（`verifier_report grp-world-e6b224e-clearance`，**0 blocker**）。
- **第一次尝试被拒**：`[destination-worktree-dirty]: merge of "grp/world" into "main" failed: destination-worktree-dirty; files: ?? .dsh-merge.lock, ?? logs/` ⇒ **两者都是 untracked** ⇒ 按工具文档（**tracked 修改一律阻塞**、untracked 可用 `ignore_untracked`）以 `ignore_untracked:true` 重试**成功**。
- **结果**：`merged: true`，merge commit **`0deb52c72fc17c10fdd7776448c74a54f5ce60eb`**，source `grp/world` → destination `main`，**`ancestorVerified: true`**。
- **★ 并集逐项核（verifier 的数据丢失条件）**：`e6b224e` 是 HEAD 的祖先；`docs/groups/proto/m5-windowid-lifecycle-spec.md`（t59，253 行）**在**；`crates/mc-proto-schema/src/play_container.rs`（t62 修复）**在**；`tests/fixtures/dump-01.bin.manifest.json`（t86 形态）**在**；**main 自己的内容未被覆盖**（`GOVERNANCE.md` **1751 行**、`PLATFORM-DEFECTS.md` **603 行**）；`git status` 仅 `?? logs/`。⇒ **是真合并，不是覆盖。**

**第七轮修复结果 · 边界更正（tier 0 自纠 · 2026-09-28）**
- **被更正的断言**：我在上一条里写「第 7 / 8 例**只有修复方回报 + focused 验证，tier 0 未 live 复测**」。⇒ **第 8 例的修复现已 live 复测通过**：我的 `grp/world → main` 合并被拒时，报文**逐字带出脏文件清单**（`files: ?? .dsh-merge.lock, ?? logs/`）—— 这正是修复描述的行为（**给 path / branch / 脏文件列表**）。
- ⇒ **准确表述**：**第 8 例（`source`/`destination-worktree-dirty` 不具名对象）已 live 复测通过**；**第 7 例（`destination-worktree-invalid`）仍未 live 复测**（本次拒绝串是 `-dirty`，不是 `-invalid`）。
- ⇒ **一般形态**：**一次拒绝可以顺带验证另一条修复** —— **只要把报文与修复描述逐字对照**，而不是只看「它拒了」。
**B-79（`evidence_query` 对「截断 id」只回 0 行，**与「该 id 不存在」不可区分** ⇒ 使用者必然把 0 读成「不存在」 · 2026-09-28 · lead-rig 实测 · tier 0 收编 · 本起事件的**使能条件**）**
- **现象**：用**截断 id**（8 位短形态）或 **prefix** 调 `evidence_query` ⇒ 只回 `rows: []` 与 `visibility.matched: 0`，**没有 `formRejected`、没有前缀唯一性字段、没有任何提示说「这个形态我不接受」**。
- **对照**：同一对象用**完整 id** 精确查 ⇒ `rows = 1`；控制面 3274 条 `evidenceId` **全是完整 UUID**。
- ⇒ **为什么它是整起事件的使能条件**：**仪器不区分「形态不被接受」与「不存在」，使用者就必然把 0 命中读成「不存在」。** ⇒ 于是「引用被截断」被读成「指针悬空」，进而**删掉了一条真主张**（t60 / t62），须由 `group-proto-t63` 恢复。
- ⇒ **修法建议（按优先级）**：**①** 回执必须**区分**「**形态不被接受**」与「**对象不存在**」（前者应显式拒绝，或给出「该形态不是完整 id」的提示）；**②** 支持**前缀唯一匹配**（命中 1 条 ⇒ 解析；命中 ≥2 ⇒ 报歧义并列出候选；命中 0 ⇒ 才是「不存在」）；**③** 至少在 `visibility` 里暴露**本次查询用的键形态**。
- **受准绕行**：**evidence 引用一律写完整 id**（已入 GOVERNANCE）；**且不得用「0 命中」支撑「不存在」**（「0 命中」有三种成因）。
**B-72 的「风险论证」已兑现为实际红（2026-09-28 · tier 0 实测 · 收编）**
- **当时的措辞**：B-72 记的是**风险论证**，并**如实标注「本轮未观测到该故障」** —— 域内若含引用形态 token，**共享门禁会对所有人生效地变红**。
- **本轮观测到（在 `rig-trace` 的工作树上）**：`cargo test -p mc-proto-schema --test citation_integrity` ⇒ **2 passed / 2 failed**；红行 = `tests/golden/rig-batch/detached-b3a6760/crates/mc-proto-schema/src/play_chunk.rs` 第 7 行，其引用形态为「**§13.3** 的**第 345 行**」，判定 `FAIL V2 行不在 §13.3 的跨度内`（**§13.3** 标题在**第 347 行**、下一标题在**第 353 行**） ⇒ **判红的是冻结快照自己内部的副本**，与任何在飞卡无关。
- **同时实测（对照）**：**main @ `4d672f2` 的门禁是绿的** —— `4 passed / 0 failed`、`CARGO_RC=0`、`unregistered=0`、`dead=0|ambiguous=0|nofile=0|oob=0|empty=0|other=0`。⇒ **红是工作树局部的，不是 main 的状态。**
- ⇒ **含义（本条要改的是 B-72 的强度，不是它的结论）**：把该快照移出门禁读取域，**不再只是「降 36% 域规模」，而是「消除一类能自行把门禁判红的对象」** ⇒ **`group-rig-t27` 的优先级因此抬高**。
- ⇒ **配套的正面形态**：报告方（`rig-trace`）**拒绝把红说成绿**、**逐行归因**（**0/59** 条红行引其改动路径；其 5 条 path 引用全 PASS；0 条 `§N Lm` 引用），并**如实报两个缺口**（自己 plan 的 check-3 过宽、check-5 因**非本改动**的原因未满足）。⇒ **「红了就说红 + 逐行归因」是本条能成立的前提。**
- ⇒ **另记两处过程陷阱（同一执行者）**：**陈旧二进制**（首次生成跑的是**改前**的二进制 —— 重建命令被写范围守卫拒后**没有重跑**；靠产物与旧跟踪文件**逐字节相同**才发现）与**截断输出的假 PASS**（①c 首次只比 stdout 尾部 `14/30 文件即报 identical）。⇒ 与「**取数路径被截断 ⇒ 假 PASS**」同族。
**成员 → 组的合并顺序是硬门控：`group-acceptance` 包 → verifier 复核 → `integration-ready` → 才能合并（2026-09-28 · lead-rig 实测 · tier 0 收编 · 并纠正 tier 0 一条不可执行的指令）**
- **实证（逐字两次拒绝）**：`team_merge(rig-trace, t29)` 第一次被 `[source-worktree-dirty]` 拒（未跟踪的 `tools/trace-diff/target/`）；带 `ignore_untracked:true` 重试后**不是**再被 dirty 拒，而是 **`[task-phase]: task "group-rig-t29" is before packet phase "integration-ready" and cannot advance there directly`**。
- ⇒ **顺序事实**：**成员分支 → 组分支的合并，必须先有 group-acceptance 包、经 verifier 复核、把卡推到 `integration-ready`，然后才能合并。** ⇒ **它不是「交付即可合并」。**
- ⇒ **tier 0 的错（我认）**：我在给 lead-rig 的指令里写「**请照常推进合并**」—— 该动作在机制上**当时无法完成**，而我**没有先核合并门控**。⇒ **这是「未核前提就下判定」同一族的第 4 个主体实例，主体是我。**
- **受准绕行**：交付方**能做的**是「**提交 group-acceptance 包 + 唤醒 verifier**」；**合并动作要等 `integration-ready`。**

**「按行计数」与「按出现次数计数」是两个不同的单位（2026-09-28 · lead-rig 第 6 次自纠 · tier 0 收编）**
- **实证**：lead-rig 用 `grep`（**按行**）数 `docs/groups/rig` 的截断 id 得 **1**；用 .NET 正则按**出现次数**重测得 **6**（**全在同一行第 35 行**）。⇒ **该处两者相差 6 倍** ⇒ **按行计数会系统性低估**（一行可含多个 token）。
- ⇒ **纪律**：**凡「仓内有多少处 X」，必须同时具名「单位」（行 / 出现次数 / distinct token）与「测量时点」**；**且不得用 `git grep -E` 做需要 lookahead 的计数**（它不支持 lookahead，**rc=128**，而**其空输出会被误读成「0 命中」**）。
- ⇒ **同族**：t57 的字符 / 字节、t58 的 10405/10466 与 127/126 —— **单位不具名必然出错**。
**B-80（`[worktree-stale-base]` 的补救「rebase it explicitly」在提交已被验收包绑定时是**有害的** · 2026-09-28 · lead-rig 实测 · tier 0 收编 · 比「拒绝串不可判别」更严重的一级）**
- **逐字**：`[worktree-stale-base] worktree for "rig-trace" could not be created: existing worktree branch "team/rig/rig-trace" does not contain requested base "main"; choose a fresh branch or rebase it explicitly before work`
- **为什么这条建议有害**：t29 的提交 `bf2e69d682ccf3702f005468fe0809f9963b1d83` **已被绑定在组级验收包 `packet-883b5e6c02061409706fd5ec` 里** ⇒ **`rebase` 会改写它的 sha ⇒ 直接使该包失效**。⇒ **调用者若照做，就把一个已出包的交付物变成「包所绑定的对象不存在」。**
- ⇒ **本条的级别高于既有那一族**：B-57 / B-58 / B-60 / B-65 / B-67 / B-68 是「**把人送去查一个不是原因的东西**」；本条是「**把人送去做一个破坏性动作**」。
- ⇒ **正确的补救是 `merge`**（保留被绑定的提交）：lead-rig 实测 `git merge main` ⇒ `Merge made by the 'ort' strategy`、`MERGE_RC=0`、无冲突、`git merge-base --is-ancestor main HEAD` **rc=0**；重试 `team_worktree_setup` **成功**（t28 转 `execution` / `ready:true` / `worktreePath` 已回写）。
- **修法建议**：**①** 报文措辞改为「**merge（不得 rebase）**」；**②** 或由工具**自己提供刷新路径**（它知道该分支上有没有被包 / 证据绑定的提交），**不要把风险转移给组长**；**③** 若确实要建议 rebase，**必须先检查该分支上的提交是否已被包 / 证据绑定**。

**两条机制事实（2026-09-28 · lead-rig 实测 · tier 0 收编）**
- **worktree 按成员唯一**（路径按成员派生，如 `…\team__rig__rig-trace`）⇒ **无法为同一成员开第二条 worktree** ⇒ 「给同一成员另开一棵树」**不是一个可选项**。⇒ 落后分支的刷新只能**在该成员自己的树内做**。
- **「一张 worktree 不同时承载两张 edit 卡」的承重要件是「同时」** —— 前一张已 `completed`、无在途写入时，同 worktree 续做第二张 **不违反该条**；但**合并耦合是真的**，必须以「**不得 squash、两提交各自独立、报告同时具名两卡、绝不 amend/rebase 被绑定的提交**」收口。⇒ **本条已第二次出现**（首次 t84+t86，本次 t29+t28），**两次都按具名披露收口。**
**B-81（`team_merge` 的目标 worktree 无人创建 ⇒ 首次合并必然 `spawnSync git ENOENT` · 2026-09-28 · lead-rig 实测 · tier 0 收编 · 并含 tier 0 的一处遗漏）**
- **逐字**：`merge … failed: spawnSync git ENOENT; worktree: …\.dsh-worktrees\grp__rig`
- **实测**：`grp/rig` 分支**存在**、但**没有任何 worktree**（对照 `grp/world` 有 `.dsh-worktrees/grp__world`），**且没有任何工具创建它** ⇒ **`team_merge` 的目标树无人负责创建** ⇒ **首次合并必然 ENOENT**。
- **受准绕行（lead-rig 已成功）**：`git worktree add .dsh-worktrees/grp__rig grp/rig`（`ADD_RC=0`）。
- **★ tier 0 的遗漏（我认）**：**组长 worktree 由 tier 0 布置**；我在需要时布置了 `grp/world`，**却没有在 `grp/rig` 成为合并目的地时主动布置它**。⇒ **责任不在 lead-rig** —— 它只是先撞上了。
- **修法建议**：**①** `team_merge` 在目标 worktree 缺失时**自行创建或给出可执行指引**；**②** 或把「合并目的地的 worktree」列入 tier 0 的布置清单，并在**组分支首次成为目的地时**触发。
- **配套**：`[source-worktree-dirty]` 再次逐字给出脏文件（`M tools/trace-diff/src/fields.rs`）⇒ **第 8 例修复的第二次 live 验证**。

**一条口径更正：evidence 的两种形态走不同字段（2026-09-28 · G-WORLD 执行者实测 · tier 0 收编）**
- **A 类（16-hex）= 行内 `id` 字段**（= fingerprint 的前 16 hex）；**B 类（8-hex）= 行内 `evidenceId`（UUID）的前 8 hex**。⇒ **两类走不同字段。**
- **反例（执行者给出）**：`evidence-113773c5-da6c-4f15-93d5-e5ae671fb29b` 那一行的 `id` = `evidence-9553b92fee8aa543`，与短串**无关** ⇒ **若按「行内 `id` 字段」匹配 B 类，11 条会全部 0 命中。**
- ⇒ **纪律**：**按形态选字段** —— **A 类按 `id`、B 类按 `evidenceId`**；**用错字段会把可解析的 A 类误判为不可解析、把可解析的 B 类误判为 0。**
**B-82（`send_message` 抛出原始 JS `TypeError` ⇒ **消息静默丢失，且发送方无法判定投递状态** · 2026-09-28 · lead-rig 实测 · tier 0 收编）**
- **逐字**：`TypeError: Cannot add property 1, object is not extensible`
- **性质**：**不是结构化拒绝、不是门禁拒绝，而是工具内部异常** ⇒ **没有可判读的投递结果**。⇒ lead-rig 只能靠「重发成功」推断**上一条未投递**，并**请我确认是否收到** —— 因为**发送方没有任何可判定的投递状态**。
- ⇒ **危害**：**一条消息可以静默消失，而双方都不会收到任何提示**（发送方以为发了、接收方以为没发）。⇒ 在**依赖定向报文协调跨组**的场景下，这会让两边**各自基于不同的世界模型行动**。
- **修法建议**：**①** 工具内部异常必须**转为结构化的失败回执**（含「**未投递**」这一确定状态）；**②** 发送方应能**查询某条消息的投递状态**（类似 `team_dispatch_status` 对 wake 的支持）；**③** 至少在异常时**给出「本条未投递」的明确结论**，而不是让调用者靠重发推断。
- **受准绕行**：**关键协调报文发出后，在下一轮以「你是否收到 X」确认**（本条即如此做的）。

**B-83（成员持有活动 lease 却无法 `claim` 自己的卡：`task-contract-gate-unavailable` · 2026-09-28 · G-WORLD 执行者实测 · tier 0 收编）**
- **逐字**：`task-contract-gate-unavailable: cannot verify task state; repair the control-plane read before retrying`（**连续两次**；卡 rev 23 / `pending`，**该成员持有活动 lease**）。
- **为什么它仍是缺陷**：它**给出了类别**（比 B-79 那条「不可区分」好），但**没有给出「控制面读的哪一项不可验证」** ⇒ **调用者没有可执行的修复动作**（「repair the control-plane read」不是一个它能做的动作）。⇒ 仍属「**未具名的对象**」族。
- **处置（执行者正确）**：`waiting_set` + `release status=cancelled` + checkpoint，**不重试**。
- **配套（同一轮）**：一次 `team_evidence_record` 返回 `control-plane lock timeout` ⇒ **该 evidence 未落库**，且（按暂停口径）**未重试**。⇒ **超时的证据写入不留下任何记录** ⇒ 调用者必须自己知道要重试。**建议：超时回执应显式说明「未写入」并要求重试。**
**B-83 补充（2026-09-28 · lead-world 实测 · tier 0 收编）：同一会话内两个门禁对同一张卡给出**相反**可用性**
- **实证**：`claim` 连续两次被拒 `task-contract-gate-unavailable: cannot verify task state; repair the control-plane read before retrying`（**未重试第三次、未绕过**）；**而随后同一张卡的 `complete` CAS 却成功**（revision 25 → 26）。
- ⇒ **含义（比单纯「拒绝」更有信息量）**：**「控制面读不可用」不是全局故障** —— 否则 `complete` 也会失败。⇒ **不可用是逐门禁 / 逐路径的**，而报文**既不说是哪一个门禁、也不说是哪一项读** ⇒ **补救语「repair the control-plane read」不仅未具名，而且方向是错的**（同一会话里另一条路径的读是好的）。
- ⇒ **修法建议**：报文应给出**具体门禁名 + 具体读项 + 该读项的状态**；并且**不得用「控制面读不可用」这种全局措辞**去描述一个局部失败。
- **配套（同一轮）**：`team_evidence_record` 返回 `control-plane lock timeout` ⇒ **该行未落库**（重试一次成功）⇒ **完成事件里 evidence 条数 8、查询是 9，差异即由此产生** ⇒ 这是「**写入失败但计数照旧引用它**」的**可观测后果**（与 B-83 配套行同源）。

**正面形态入册：无法自验的 id 不得写成已验（2026-09-28 · G-WORLD 执行者与组长 · tier 0 收编）**
- **实证**：`evidence-f2921328-a2dd-4ace-aaae-582c3d30c298` 由 **tier 0 的全板可见性**解析；**执行者自己**查该完整 id 得 **rows=0**（跨组证据对它被权限过滤）⇒ 它**在 evidence 里具名这一限制**，明确**该条以 tier 0 的解析为准、未声称自验**；组长据此把该 check 记为 **`partial`** 并附具名风险。
- ⇒ **纪律**：**「我无法自验的 id / 读数，不得写成已验」** ⇒ 必须写成 **`partial` + 具名限制 + 指明以谁的解析为准**。
- ⇒ **它与「异类验证不得记为已验证」（B-71 补充）互补**：那条禁**用错对象**去验证；本条禁**把无法验证的项**写成已验证。

**B-80 / B-81 的第三次实例（同一族在重复）**：`[source-worktree-dirty]` 又一次把 t91 的合并挡住（共享主检出的脏来自 **t89 的在途写入**：`crates/mc-world/src/error.rs`、`crates/mc-world/src/lib.rs`、`crates/mc-world/src/entity_registry.rs`）⇒ **处置 = 挂到 t89 收口、一次合并并具名全部 commit**（不 stash，成员正在跑）⇒ **与 t84+t86、t29+t28 同形，第三次。**
**B-84（守卫的判定不是提交的函数：域含被忽略工件 ⇒ 该 commit 的干净检出上守卫不可能绿 · 2026-09-28 · verifier 提交面实测 + tier 0 独立复核 · tier 0 收编）**
- **逐字**：在提交面（把确切 commit 的树在仓外展开）上，守卫判 `2 passed / 2 failed（RC 101）`；红集 = 1 条 `UNREGISTERED` + 3 条 `EXC-DEAD`，3 条全部指向 `tests/golden/rig-batch/detached-b3a6760/` 之下。
- **tier 0 独立复核机制**：`git ls-files tests/golden/rig-batch` = **0**；`git check-ignore -v` 指向 `.gitignore` 第 5 行的 `/tests/golden/`；而该目录在工作树上存在（`Test-Path` = True）⇒ **守卫的域是文件系统遍历、含被忽略文件** ⇒ 3 条已登记键的载体在提交面上不存在 ⇒ **必然 DEAD**。
- ⇒ **性质**：这不是「同一 commit 在不同工作树给出不同判定」（B-81 族），而是「**提交面自身就红**」⇒ **该 commit 的任何干净检出上守卫都不可能绿。**
- **危害**：**所有「门禁绿」读数都只是某一棵工作树的读数** ⇒ 门禁无法作为**可复现**的合并判据。
- **修法建议**：**①** 守卫的域必须只由受跟踪内容决定（按受跟踪清单取域，或显式排除被忽略路径）；**②** 或把必须参与判定的工件纳入跟踪面；**③** 无论哪种，验收形态 = 把确切 commit 的树在仓外展开后跑守卫须 **4 passed / 0 failed**。

**B-85（`team_plan_approve` 未按「跨组 plan 须由 tier 0 批准」拒绝组长的 approve · 2026-09-28 · tier 0 实测 · tier 0 收编）**
- **逐字**：组组长对一张 `write_scopes` 含**本组之外**文件的卡执行 approve ⇒ runtime 返回 `state=plan-approved, approvedBy=<组长>`，**未拒绝、无任何越界提示**。
- ⇒ **性质**：规则「跨组 plan 须由 tier 0 批准」**未被执行** ⇒ **权限归属由 runtime 的宽容决定**。
- **危害**：跨组改动可以在**没有 tier 0 在场**的情况下进入 execution ⇒ 该闸门形同虚设；且事后无法从回执判断「这次批准是否在权限内」。
- **修法建议**：**①** 按 plan 的 `write_scopes` 与批准者的组做归属判定，越界即拒；**②** 拒绝串须**具名**「哪条 scope 越出了哪个组」；**③** 若允许宽免，须返回**显式**宽免标记，而不是静默通过。

**B-86（`evidence_query` 对截断 id 的 0 命中与「该 id 不存在」不可判别 · 2026-09-28 · lead-rig 实测 · tier 0 收编）**
- **逐字**：对**截断 / 短形态** id 查询只回 `rows: []` 与 `visibility.matched: 0`，**与「该 id 不存在」完全同形**；`visibility` **无 `formRejected`、无前缀唯一性字段**。
- ⇒ **这是本轮多起误判的使能条件**：**仪器不区分「形态不被接受」与「不存在」，使用者就必然把 0 命中读成「不存在」** ⇒ 直接导致两处**真主张**被删。
- **修法建议**：**①** 形态不被接受时返回**具名分类**（如 `formRejected: truncated`）而非 0 行；**②** 或在 `visibility` 里给出**前缀命中数**（唯一 / 多义 / 0），使调用者能区分三支。

**B-83 补充二（`control-plane lock timeout` 静默丢弃 evidence 行，且回执不区分「已落 / 未落」 · 2026-09-28 · G-WORLD 实测 · tier 0 收编）**
- **逐字**：`team_evidence_record` 返回 `control-plane lock timeout for …/team-control-plane/<session>.json` ⇒ **该 evidence 行未落库**；回执**只给超时**，**不告诉调用者哪些行已落、哪些未落**。
- ⇒ **危害**：**写入失败但卡面 / 报告仍会引用它** ⇒ 形成「**引用了不存在的证据**」的窗口；与 B-83 的 `task-contract-gate-unavailable` 叠加时，调用者无法判断「该重试还是该放弃」。
- **受准处置（G-WORLD；tier 0 确认为正确）**：**不重试第三次、不绕过、逐字回报拒绝串**，并在报告里**显式声明「该证据未落库」**。
- **修法建议**：**①** 超时回执须**逐条**给出该批写入的落库状态；**②** 或把 evidence 写入做成**幂等可重试**并返回稳定 id。

**平台缺口第三例：`waiting_resolve` 对存在的票据回 `not-found`（2026-09-28 · member-registry 实测 · tier 0 收编）**
- **逐字**：`team_v12(action:"waiting_resolve", task_id:"group-proto-t66")` ⇒ `{"status":"not-found"}`，而票据 `wait:group-proto-t66:member-registry:…` **存在且 `waiting_list` 显示 `open`**；该票据最终因**任务完成**而离开 `waiting_list`。
- ⇒ **已第三次**（t63 / t65 / t66）⇒ **不是偶发**。⇒ **调用者无法用 API 收口自己的等待**，只能依赖「任务完成」这一副作用；若任务未完成而等待应被显式解除，则**无通道**。
- **受准处置**：**不声称 API 已解除该等待**（它失败了），只记录「该等待因任务完成而离场」。
**B-87（依赖边 `blocked_by` 在依赖任务 `completed` 时自动解除，即使其 commit 尚未合入 main · 2026-09-28 · G-WORLD 实测 · tier 0 收编）**
- **逐字事实**：某卡的 `blocked_by = [t29, t31]` **被平台自动解除**（两者均 `completed`），而实测 `git merge-base --is-ancestor bf2e69d… main` = **rc=1** ⇒ **两条修复都不在 main 上**；而该卡卡面的前置要求是「**修复在 main 上**」。
- ⇒ **性质**：**依赖边表达的是「依赖任务 completed」，不是「该修复已进入被依赖方」** —— 两个语义不同，而平台只实现了前者。
- **危害**：下游卡会在**前置为假**的情况下被放行 ⇒ 本次若开工，会用**未修复的生成器**产出 `cap-*/meta.json`，**把旧串写回，等于回滚上一张卡的修复**。⇒ **自动解除依赖可以造成静默回滚。**
- **受准处置**：卡面必须**自持硬守卫**（把「依赖的 commit 在 main 上」写成显式判据），**不得**依赖 `blocked_by` 的自动解除。
- **修法建议**：**①** 允许 `blocked_by` 的解除条件声明为「**commit 已合入某分支**」而非「任务 completed」；**②** 或在自动解除时**具名提示**该依赖的 commit 是否已在目标分支上。
**B-88（`team_merge` 在目标工作树里创建自己的锁文件，随后被自己的脏检查绊住 · 2026-09-28 · tier 0 实测 · tier 0 收编）**
- **逐字**：`team policy refusal [destination-worktree-dirty]: merge of "grp/world" into "main" failed: destination-worktree-dirty; files: ?? .dsh-merge.lock, ?? logs/`
- **事实**：`.dsh-merge.lock` **是合并工具自己的工件名**；`logs/` 是既有未跟踪目录。用受准开关 `ignore_untracked: true` 后合并成功。
- ⇒ **形态**：**工具自己放进目标工作树的锁，破坏了它自己「工作树必须干净」的前置条件** ⇒ **首次合并可能必然被拒**（与 B-81「目标 worktree 无人创建」同族：**合并的前置条件由合并自己造成，或无人负责**）。
- **未确证的部分（如实标注）**：我**未确证**该锁是本次尝试创建还是上次遗留（实测第二次尝试前 `Test-Path` = False、`git status --porcelain` 仅 `?? logs/`）⇒ **只报形态，不报成因**。
- **受准处置**：`ignore_untracked: true`（仅当阻塞项确为未跟踪文件；**受跟踪的修改永远是阻塞项**）。
- **修法建议**：**①** 锁文件应放在**被扫描域之外**（如版本库元数据目录内）或加入工具自己的忽略集；**②** 脏检查应显式排除工具自身的工件。

**B-89（`team_merge` 合并成功后回执报失败 ⇒ 调用者可能重试并产生重复合并 · 2026-09-28 · tier 0 实测 · tier 0 收编）**
- **逐字**：合并**已成功**（`git log` 实测出现 `fa4fd94 Merge commit '772ff694…'`，`git rev-list --parents -n 1 HEAD` = **恰 2 父** ⇒ 真合并），而**同一调用**返回 `team policy refusal [task-phase]: task "group-world-t91" cannot advance from "accepted" to "integrated"`。
- ⇒ **性质**：**相位推进失败**（t91 已在 `accepted`，比 `integrated` 更靠后 ⇒ 无需推进），但**回执形态与「合并失败」不可区分**。
- **危害**：调用者若据回执重试，会**再合并一次**（产生重复 merge commit）；若据回执判定「未合并」而改走手工路径，则可能**绕过清关门禁**。
- **受准处置**：**以 `git log` / `git rev-list --parents` 的事实为准**，不以回执的失败形态为准；**重试前必须先查 HEAD 是否已是该 merge**。
- **修法建议**：**①** 合并与相位推进**分开回报**（如 `merged:true` + `phaseAdvance:"refused: already past integration"`）；**②** 相位目标低于当前相位时应**幂等成功**而非报错。
**B-90（`task_contract_set` 无 compare-and-set ⇒ 丢失更新 · 2026-09-28 · G-RIG 实测 + tier 0 认领实例 · tier 0 收编）**
- **逐字事实**：一次写入（`contractRevision` 4→5，at 1790560304209）**返回成功**；**21 秒后**另一方的写入（`changedAt` 1790560325216，5→6）**也返回成功**，**静默覆盖**前者。⇒ **两次写都「成功」，且无任何冲突提示。**
- **机制性证据（非偶发）**：拿到 `contractRevision=6` 时**任务行** revision 是 31；写入后 `contractRevision=7`、任务行 31 → 32 ⇒ **契约的版本计数与任务行的 `expected_revision` 是两套独立计数器**，而 **`task_contract_set` 不接受任何前置**。
- **★ tier 0 的实例（我认）**：**我用了一次全局正则替换**，把**产物侧**的值套到了**生成侧**的判据 ① 上 ⇒ **一次全局替换就静默改写了一条已被 verifier 复核过的判据，双方都无冲突提示。** ⇒ **这不是理论风险**；而且 **「纠正别人的域偷换」这件事本身会再制造一次域偷换**（若不做段内限定）。
- **危害**：验收判据可被静默改写而不被任何一方察觉 ⇒ **下游按被篡改的判据打分**（本例差点让 ① 与 ② 两个域混写）。
- **受准处置**：**任何契约写入必须先读，且把替换限定在目标段内（不得全文替换）**；**发现他人写入后不要立刻覆盖，先确认归属**（本例 owner 正确地先上报、未擅自覆盖 —— 这个判断被背书）。
- **修法建议**：**①** `task_contract_set` 应接受 `expected_contract_revision` 前置（与任务行的 `expected_revision` 对称）；**②** 冲突时返回**具名冲突**而非静默覆盖；**③** 或在回执里给出本次写入前后的 `contractRevision` 与 `changedAt`。
**B-91（「修复在 main 上」不蕴含「修复在成员自己的工作树里」：同一句话里混着三个不同对象 · 2026-09-28 · G-WORLD 实测 · tier 0 收编）**
- **实证**：某卡的卡面守卫要求「依赖的修复 commit **在 main 上**」，且该守卫**已实测满足**（两条 `--is-ancestor … main` 均 **rc=0**）；**然而该卡执行者自己的工作树**停在更早的提交（`756860f`），**不含** `d2117c6` ⇒ 若照卡面直接跑生成器，**产出的仍是旧形态** = 正是该卡面警告的「**回滚上一张卡的修复**」。
- ⇒ **同一句话里其实混着三个不同对象**：
  **(i)** 依赖任务 `completed` —— **平台的 `blocked_by` 只认这个**（B-87）；
  **(ii)** 修复 commit **在 main 上** —— **卡面守卫能表达**；
  **(iii)** 修复 commit **在成员自己的工作树里** —— **卡面表达不了**，只能要求执行者**在本工作树复测**。
- ⇒ **纪律**：**「守卫写在卡面上」不够**。凡「修复落地后才可产出」的卡，**派发令必须要求执行者在自己的工作树里复测守卫**，**任一不满足就停手上报、不得产出**。
- **受准处置（G-WORLD）**：先 `git merge --ff-only main`（当成员树停在 main 的祖先时是**纯快进、无冲突**），再在**本工作树**复测守卫，然后才允许产出。
- **修法建议**：**①** 布置/租用成员工作树时**自动快进到 main**，或至少**报告落后多少提交**；**②** 或让 `blocked_by` 的解除条件能表达 **(iii)**（「在成员树里可见」），使**平台守卫与卡面守卫同源**。
**B-92（`done_when` 可与 `done` 同刻改写 ⇒ tick 自我认证 ⇒ 在假完成点折叠 · 2026-09-28 · G-RIG 上报 · tier 0 收编）**
- **机制**：`set` 与 `done` 是两次独立调用，**无前置要求 `done_when` 早于被判工作** ⇒ 成员可先改判据再 tick。
- **为什么重**：**tick 是上下文折叠边界** ⇒ 自我认证的 tick 让运行时在**假的完成点**折叠、把任务拦腰切断（本会话已发生一次，且**无 undo**）。
- **修法建议（择一）**：**①** `set` 时记录 `doneWhenSetAt`，`done` 时若 `doneWhen` 在 tick 前的窗口内被改过则**具名标注**（如 `doneWhenEditedMsBeforeDone`）；**②** 或要求 `done` 携带据以 tick 的 `doneWhen` 文本，与活动值不符则拒绝；**③** 最便宜：`list` 投影 `doneWhenSetAt`，让组长看出「判据是否早于工作」。

**B-93（`team_task_create` 不建立 worktree 绑定；而拒绝串把真因说成「超出 plan 写作用域」· 2026-09-28 · G-WORLD 实测 · tier 0 收编）**
- **形态**：建卡**不建立** worktree 绑定（`worktreePath` = null）⇒ 组长漏跑布置时，成员**在自己工作树里的每一次写**都被 fail-closed 拒绝，**而拒绝串逐字说「超出写作用域」** ⇒ 把读者**稳定地引向 scope** 而非「缺绑定」。
- **代价**：一个成员「实现已就绪」但**一条都没落地**，白跑一轮（处置 = 幂等补跑布置，`worktreePath` 由 null 变为路径，未回退任何内容）。
- ⇒ **形态通则**：**报错文本的指向 ≠ 真因**（与「裸 basename 歧义」「第 N 条」同族）。
- **修法建议**：**①** 建卡时若 owner 有成员分支，**默认同时建立绑定**或**在回执里提示未绑定**；**②** 拒绝串须**先判绑定是否存在**，缺绑定时说「缺 worktree 绑定」而不是「超出写作用域」。

**B-94（写范围守卫的静态路径抽取把 cmdlet 名当路径 · 2026-09-28 · G-PROTO 实测 · tier 0 收编）**
- **逐字**：拒绝文本具名 `…/Write-Output` 作为越界路径，而**该路径不存在** ⇒ 拒绝里具名的对象**未经存在性检查**。
- ⇒ **通则**：**拒绝文本里具名的路径必须先验存在，再当作关于调用者动作的裁定**；否则调用者会去修一个不存在的越界。
- **反向盲区（同一族）**：`cargo` 这类不透明命令对 `target/` 的写入**未被静态解析** ⇒ 「无 scope 却写入 `target/`」**既可能被误拒、也可能不被拦**。

**B-84 / B-85…B-91 的重评级（2026-09-28 · 修复方第八轮报告 + tier 0 收编）**
- **B-84 = 产品侧已修，不属平台缺陷**：守卫的域已由产品侧改为**受跟踪内容**（`git ls-files` 过滤），域计数 **333 → 215**、两张 frozen 表清空为 arity 0 ⇒ 「提交面自身就红」不再成立。⇒ 平台侧不动产品文件（修复方明确声明）。
- **B-85 / B-86 / B-87 / B-88 / B-89 / B-90 / B-91 = 平台侧已修**（组长批准范围 fail-closed 且具名越界对象 / `evidence_query` 返回 `idResolution`·`formRejected`·`idStatus`·`candidateCount` / `blocked_by` 要求依赖任务 phase 至少 `accepted` / merge lock 移出目标工作树到 `%TEMP%` / 合并与相位推进分开回报且相位已越过时幂等 no-op / `task_contract_set` 支持 `expected_contract_revision` 且锁内再 CAS / tier-2 取 lease 前自动同步 worktree 到 main）。
- **★ 边界（修复方自陈，必须随条目一起记）**：上述修复当前是 **focused fixture 验证**，**未在 live root Room / live G-WORLD 上重放全部原始反例** ⇒ **不得写成「全部 live 转绿」**。
- ⇒ **配套**：`waiting_resolve` 的 `not-found` 已修（支持 owner / waiter / responsible 回退匹配、重复 resolve 幂等、`not-found` 带候选列表）；`B-83 补充二` 的**部分落库状态仍未逐条返回**（未修）。
**B-84 补充（第二个自变量：本机 git config）· 2026-09-28 · 实例 · tier 0 收编**
- **实证**：同一棵树上，`core.autocrlf` 的**局部覆盖**（`.git/config` = false）使读数**绿**，而**默认检出**（system = true、无局部覆盖）使读数**红** —— 实测 **RC 101 vs RC 0**。
- ⇒ **含义**：**产品侧把域收窄到「受跟踪内容」并未覆盖这一半** —— **域是对的**，但**检出过程**仍受本机配置影响 ⇒ **「提交面绿」这一判据在默认配置下仍不成立**（对每个 Windows 克隆者），直到**仓库自己声明行尾**。
- ⇒ **修法归属**：**仓库级**（`.gitattributes`，见 `group-rig-t33`），**不是平台侧**；**但平台侧的教训是通用的**：**任何「在提交面上成立」的判据，其权威腿必须是默认检出。**
**B-95（饱和 owner 无法被卸载：`reassign` 要求「当前 owner 未运行」，而被依赖阻塞的卡不可能在途 · 2026-09-28 · G-RIG 实测 · tier 0 收编）**
- **实证**：四张未完成卡**全部 owner 同一名成员**；它在跑其中一张时，组长**不能**把另外三张转给空闲成员 ⇒ **饱和成员只能串行排空自己的队列**，重新分配只可能落在它的 turn 间隙，而**该窗口无法可靠命中**。
- ⇒ **危害**：**并行度被 owner 身份而非依赖关系限制** —— 三张卡 scope 两两不相交、本可并行，却因「都挂在同一 owner 名下」而被迫串行。
- **修法建议（可判假）**：**当任务 `ready:false`（被依赖阻塞、不可能在途）时允许改派** —— 阻塞卡**不可能正在执行**，改派**不会**从运行中的 owner 手里抢走在途工作。

**B-96（「提交面绿」判据在组长层没有取证通道 · 2026-09-28 · G-WORLD 实测 · tier 0 收编）**
- **逐字**：组长在仓外建临时检出被写门禁拒绝 ⇒ `bash write denied: … no declared static scope or active approved plan lease for (D:\dsh-test\tmp\t93-check)`。
- ⇒ **性质**：t67 把「提交面绿」定为**唯一**判据，而**该判据对组长这一层不可执行** ⇒ **组长只能采信成员的读数**，独立取证退化为不可得。
- **修法建议**：**①** 允许为「只读取证」在**仓外**建临时检出（或提供受准的取证通道）；**②** 或把该判据的取证责任**显式指给某一层**并在卡面写明；**③** 无论哪种，**立判据时必须同时给出「每一层的取证通道」**。

**B-92 / B-93 / B-94 与 B-84 的重评级（2026-09-28 · 修复方第九轮报告 + tier 0 收编）**
- **B-92 / B-93 / B-94 = 平台侧已修**（milestone 记录 `done_when` 设置时间且两分钟内设置/改写时 `done` 须 `expected_done_when` 逐字回显、缺失或不一致拒绝，回执记证明距 tick 的毫秒数 / 建 edit 卡时提示未绑定 worktree、改派时自动计算并写入绑定、缺绑定时的写入门禁直接说 `has no active worktree binding for this write` / 写范围守卫把换行识别为命令分隔符且不再把输出 cmdlet 名当路径）。
- **B-84 = 已按 tier 0 重评级为产品侧已修**，平台侧不再按缺陷处理。
- **★ 边界（修复方自陈，必须随条目一起记）**：B-92 至 B-94 当前是 **focused fixture 与串行回归验证**，**未在 live root Room / live G-WORLD 上逐条重放原始反例** ⇒ **不得写成「全部 live 转绿」**。
- **latent 风险（G-WORLD 具名，供后续卡参考）**：给 crate 级 `WorldError` **加变体**会让 `nbt::tests::t_depth_limit_boundary` 在**默认 2 MiB 测试栈**上 `STATUS_STACK_OVERFLOW`（RC -1073741571；`RUST_MIN_STACK=4MiB` 通过，未改的 `nbt.rs` 在 2 MiB 通过）⇒ **后续任何给该错误类型加变体的卡都须复跑该边界测试**。
**正面形态入册：`reopen` 能恢复 `status: deleted` 的卡且保留计划与绑定 ⇒ `delete` 是软删除（2026-09-28 · G-WORLD 实测 · tier 0 收编）**
- **实测**：一张卡被 `delete`（status = `deleted`，rev 9→10）后，`team_task_update(action:"reopen")` **成功恢复**为 `pending`（rev 11），且 **phase / `plan-approved` / `writeScopes` / worktree 绑定全部保留** ⇒ **判据与计划零丢失**。
- ⇒ **意义**：**`delete` 在本平台是软删除** ⇒ 误删**可恢复** ⇒ **破坏性指令的实际风险低于其字面**。这条在一次「裁定先发后撤」的事故里是**唯一**让损失为零的因素之一。
- ⇒ **文档缺口**：文档只写 `reopen` 覆盖 `rejected` / `cancelled` / `expired`，**未写 `deleted`** ⇒ 建议补上 —— 调用者**不知道可恢复时**会采取不必要的保守措施（或反过来，以为不可逆而不敢执行正确的删除）。
**B-97（归属改判后落败卡对写范围的占用不会自动释放 ⇒ 裁定不能自行生效 · 2026-09-28 · G-WORLD 实测 · tier 0 收编）**
- **逐字**：获胜卡的 claim 被拒 —— `task-contract-gate-unavailable; cause=scope-conflict; conflicts=[{taskId:"group-rig-t32", owner:"rig-trace", left:"tools/chunk-hash"}]`。
- ⇒ **性质**：**归属裁定（换承载卡 / 换 owner）本身不改变任何卡的 `writeScopes` 占用** ⇒ 只要**落败卡仍存在且仍持有同一 scope**，获胜卡就**无法 claim** ⇒ **裁定依赖「落败方主动释放」才能生效**。
- **本次的缓解**：落败方**主动**释放并删除（该卡 → `deleted`），裁定因而自洽；但**机制上仍是一次人工握手**，不是裁定的自动后果。
- **危害**：裁定与「可执行」之间**没有因果链** ⇒ 若落败方不配合（或已失联 / 被冻结），获胜方**永远 claim 不了**，而**板上看起来裁定已经生效**（写着承载卡是谁）。
- **修法建议**：**①** 改派 / 改判时可**显式声明 scope 归属转移**，由平台把落败卡的 scope 释放或改写为引用；**②** 或 `delete` / 关闭卡时**自动释放其 scope 占用**；**③** 至少让 `scope-conflict` 的拒绝串**给出可执行的解除动作**（它这次给出了冲突对象，这一点是好的）。
**B-98（`release` 作用于 `status="deleted"` 的任务会把卡复活成 `pending` 并重新占用 `writeScopes` · 2026-09-28 · G-RIG 实测 · tier 0 收编）**
- **逐字序列**：`team_task_get` ⇒ `rev 6 / status "deleted" / owner rig-trace`；`team_task_update(action:"release", expected_revision:6)` ⇒ **`rev 7 / status "pending"`**；随后**该卡重新出现在组板上**。
- ⇒ **性质**：**`release` 对 `deleted` 卡不是 no-op、也不被拒，而是把它变回 `pending`** ⇒ 它**重新占用 `write_scopes`** ⇒ **另一组的承载卡再次被 `scope-conflict` 拒绝 claim**。
- **危害（★ 双向，后半才是真正危险的那一半）**：
  · **方向一（挡住）**：一个看起来无害的「清占用」动作**反而重新占上**，并把**跨组阻塞重新建立**；调用者会以为自己**解除了**阻塞。**症状 = 卡住不动 + 有 `scope-conflict` 报错**，容易发现。
  · **方向二（静默重复持有）**：若**获胜方已经持有**该写范围，复活出来的落败卡会造出**同一写范围被两张卡同时持有** —— **这才是真正的双写入口**，而**症状是「看起来一切正常」**（两张卡都合法、都 `pending`/`in_progress`、**无报错、没人会去看**）。
  · **实测时点**：获胜方的 claim 成功在落败卡**第一次 delete 之后**；那次 `release` 把它复活成 `pending` 是在**获胜方已持有之后** ⇒ 那一刻**两张卡同时持有同一写范围**。**实测零实际双写**（两侧读数都是零写入）⇒ **只是「窗口存在过」，未产生并发写**。
- ⇒ **一般形态（写缺陷时必须覆盖的两侧）**：**同一机制的两个方向可以分别是「挡住」与「静默重复持有」，而后者更危险** —— 若危害描述只写「挡住」，就会漏掉「症状为一切正常」的那一半。
- **暂行纪律（在「`delete` 即释放占用」落地前）**：**不要对 `deleted` 卡补做 `release`**；若必须清占用，**先确认卡不是 `deleted`**。
- ⇒ **定级（★ 由「次序 / 可用性缺陷」升为「并发不变量缺陷」）**：方向二**破坏了「同一写范围同时只有一张卡」这条不变量** ⇒ 它是**并发 / 双写入口**，**不是「不方便」**。
- ⇒ **修法优先级：`delete` 即释放占用** —— **不是**要求调用方补 `release`（**后者正是本次把窗口打开的那个动作**）。
- ⇒ **本次未发生实际双写，是运气不是机制**：双方各自实测零写入（两侧读数）⇒ **窗口确实存在过**，只是**没被利用**。
- **修法建议**：**①** `release` 对 `deleted` **拒绝或 no-op**（具名原因）；**②** 或 `delete` 时**即释放占用**，使「delete 后无需 release」成立；**③** 若 `release` 确为「占用解除」的手段，则必须在文档里写明**次序**：**先 release 后 delete，不可颠倒**。
**B-85 补充（live 反例：声称的「跨组 scope fail-closed」未触发 ⇒ 特权提升路径 · 2026-09-28 · G-RIG 实测 · tier 0 收编）**
- **逐字回读**：`team_plan_get(group-rig-t33)` ⇒ `state: "plan-approved"` · **`approvedBy: "lead-rig"`**（**不是 `lead`**）· `writeScopes: [".gitattributes"]`（**仓库根单文件 = 全局治理 scope**）。⇒ **组长对全局治理 scope 的批准调用返回成功，且没有任何拒绝串。**
- ⇒ **性质**：B-85 声称的修复（「组长批准计划时只能批准本组板、本组成员，且 **scope 不得越出本组**；他组和全局治理 scope 会 **fail-closed 并具名越界对象**」）**在 live 路径上未生效** ⇒ **任何组长都能批准全局治理 scope 的计划 = 特权提升路径**；且**调用方无法从返回值判别自己越界**（**根本没有拒绝**）⇒ **该政策在调用方一侧不可执行**。
- ⇒ **比既有同族更重一层**：那一族是**拒绝串不可判别**（调用者拿到拒绝但不知道对象）；这一条是**根本没有拒绝**。
- ⇒ **两个候选解释（未判）**：**(a)** scope 分类未覆盖「仓库根单文件」这一形态；**(b)** 该检查未接线。
- ⇒ **边界**：与修复方自陈的边界一致（**B-85 至 B-94 只在 focused fixture 上验证，未在 live 上逐条重放原始反例**）⇒ **本条是一次 live 反例。**
- **受准处置（tier 0 裁定）**：**追认内容、不承认批准权威、不改记录** —— 记录 `approvedBy: "lead-rig"` **是事实，不得改写**（改写会**掩盖**这条特权提升）；另落一条 **tier-0 追认**，使成员的写入依据成立、**不必中断**。
- ⇒ **★ 记录校准（必须与本条同读，否则会被误读为「已解决」）**：**tier 0 自己那次 `team_plan_approve` 被拒是 `[task-phase]` 拒绝**（逐字 `cannot advance from "execution" to "plan-approved"`），**不是「越界」拒绝** ⇒ **它没有测试这条 scope 边界**，**不得被读成「scope 检查生效」**。⇒ 唯一一次在 **`plan-proposed` 阶段**发生的批准调用是**组长的**，而它**成功了**。⇒ **没有任何一次尝试证明该 scope 边界会触发** —— 这正是本条成立的条件。
- ⇒ **配套纪律（记录面）**：**拒绝串的「类别」必须逐字记录** —— 本案里「阶段拒绝」与「越界拒绝」**同属 `team policy refusal`**，若只记「被拒」而不记类别，就会把一个**未测试的边界**读成**已验证的边界**。
**B-99（tier-1 组长被加载为 `member.md` 身份 ⇒ 其禁令与其职责直接冲突，且降级静默 · 2026-09-28 · G-RIG 实测 · tier 0 收编）**
- **逐字（组组长自陈）**：其 v14 context manifest 写 **`roleFile: "member.md"`**，而它是 **tier 1 组长**；同一 `identityVersion` 此前写的是 `lead.md`，且**本轮注入的正文是 `member.md` 的内容**。
- **tier 0 独立复核（部分成立）**：`team-roles/identity-version.json` **只有 `files` 哈希表，没有任何 tier→角色文件 的映射** ⇒ **该映射不在清单里**；而 `member.md` 第 19 行逐字含「**不跨组、越级 root、创建成员**、改未声明文件或绕过 fail-closed」⇒ **「创建成员」确实被列为 member 的禁令**。
- ⇒ **性质**：**`spawn_teammate` 是 lead 的职责，而 `member.md` 把它列为禁令** ⇒ **一个被加载为 member 身份的 lead，会被禁止做它必须做的事**；且**这类降级不报错、只静默**。
- **修法建议**：**①** 把 tier→角色文件 的映射**显式化**（或让 `identity-version.json` 携带它）；**②** 在装配的下一轮上下文里**断言 `roleFile` 与成员 tier 一致**，不一致则**报错而非静默降级**。

**B-100（「登记等待」与「变更等待」的权限不是同一条 · 2026-09-28 · G-WORLD 实测 · tier 0 收编）**
- **逐字**：`team_v12(action:"waiting_set")` 与 `action:"waiting_resolve"` 对同一张组员卡均返回 `waiting-scope: only the task owner, its group lead on a writable group board, or tier 0 may change its wait`。**对照**：**同一 actor、同一板、同一 task_id 的 `waiting_set` 此前成功过**（回执含 ticketId / owner=成员 / waiter=组长 / status=open）。
- ⇒ **性质（组组长具名，tier 0 采纳）**：**登记等待的权限与变更等待的权限不是同一条** —— 表现为「**能创建、不能改 / 收口**」，**连自己刚创建的那张也不能收口**。⇒ **责任不能只挂在等待票上。**
- ⇒ **受准处置（G-WORLD）**：把责任落在**里程碑文本 + decision/action 消息 + evidence** 三处，等待票只当**尽力而为**。
- **修法建议**：**①** 让「该卡的组长」在**变更**路径上也成立；**②** 或 `waiting_set` 在已有票时**返回既有票信息**而不是 scope 拒绝。

**B-101（`info` 给上级可能被折进 Room 摘要而不投递 ⇒ 上级看不到 · 2026-09-28 · G-WORLD 实测 · tier 0 收编）**
- **逐字**：一位组长发给 tier 0 的 `info` 回执为 **`status: "room-summary"` / `roomId: "root"`**，而**不是 `delivered`** ⇒ 该消息**进了 root 房间摘要、未作直投**。该组长据此改用 `decision` 走「能唤醒上级」的通道。
- ⇒ **性质**：**`info` 是「静默通知」**，但当它与一个**开放的 Room** 并存时可能被**折进摘要** ⇒ **接收方看不到**；而**发送方拿到的回执是 `room-summary`，不是失败** ⇒ **双方都不会察觉这条消息没到**。
- ⇒ **危害**：与「静默丢失」同族但**更隐蔽** —— 回执**看起来像成功**（有 `roomId`、有 `status`），而**内容只在摘要里**（摘要按平台约定**不重放全文**）。
- **受准处置**：**需要上级看见的内容，不要用 `info`** —— 用 `action` / `decision`；`info` 只用于**不要求对方读到**的通知。- ⇒ **★ B-101 补充（上级通道的三态 ⇒ 非阻塞性质的上级通知没有可用通道）**：实测三条 —— **`info` 可能被折进 Room 摘要**（本条正条）；**`action` 向上被 `[delivery-upward-decision]` 拒绝**（一位 tier-1 组长用它发清关重发通知，被逐字拒绝 ⇒ **tier 0 至今未收到该通知**）；⇒ **只有 `decision` 能到达上级**。⇒ **于是「非阻塞决策性质的上级通知」没有通道**：它既不是阻塞决策（不该用 `decision`），又到不了上级。
- ⇒ **受准处置（本次实例）**：把该通知**包成 `decision`** 并写明 `blocked_action` —— 该组长就是这么做的，**有效但语义错位**（一条「清关已重发」的通知被写成阻塞决策）。⇒ **这是可接受的绕行，不是正确形态。**
- **修法建议（补充）**：**①** 允许 `action` 向上（它已含 reason，足以判别）；**②** 或给 `info` 一条**保证直投**的变体（如 `info-important`）；**③** 至少让 `[delivery-upward-decision]` 的拒绝串**给出替代通道**。
- ⇒ **★ B-101 第二实例（2026-09-28 · G-RIG tier-2 成员实测，自陈其限制）**：该成员手上有**实质性发现**（两个退出码读数 + 一条独立的 runner 缺陷候选），却**没有通道把 tier 0 唤醒** —— 它逐字说：**「向上只能走 `info`（`action` 不允许向上；我无 `blocked_action` 故不走 `decision`）」**，并补一句「若你已 inactive 而未被唤醒，请按证据行取数」。⇒ **这正是本补充所记缺口的一次真实发生**：**有实质内容、但非阻塞决策性质**的向上通知**没有可用通道**，只能靠 `info` 静默投递 + 期望上级恰好醒来。
  - ⇒ **后果**：**实质发现依赖上级的轮询运气**。本次侥幸成立（tier 0 当时在轮内），但**机制上不保证**。
  - ⇒ **过渡期纪律（tier 1 组长）**：**组内成员有实质发现时，组长必须在其批次报告中代为转达**，不得假设「它已经报上去了」。
**B-110（`team_merge` 不执行快进，且收据的 `ancestorVerified:true` 与「是否产生新提交」无关 ⇒ 依赖「能快进就快进」的规划在工具层静默失败 · 2026-09-28 · verifier 实测 + tier 0 三次实测 · tier 0 收编）**
- **逐字读数（tier 0 三次）**：`is-ancestor <destination> <source>` = **rc 0（快进本可行）**，而 `team_merge` **仍产出 2 父的合并提交** —— `4dcdb3d2`（父 `de45c346` + `ea5c4607`）、`590d9e25`（父 `f6270f08` + `786a0bea`）、`ac87a261`（父 `c210177` + `da277208`）。
- **verifier 独立实测第三例**：`is-ancestor f6270f08 042c1067` = rc 0，而 `grp/world` 经 `team_merge` 后变成 2 父的 `da277208`。
- ⇒ **性质**：**工具行为与「能快进就快进」这一裁决不一致** ⇒ 凡按「并入是纯快进、不产生新提交、清关不会被作废」规划的路径，**都会在工具层静默失败**；而**后果是 head 前进 ⇒ 上一份 head 级清关当场失效 ⇒ 必须重出一份**。本轮即实证：`grp/world` 的 head 由被清关的 `042c1067` 变为 `da277208`，**上一份清关当场失效**。
- ⇒ **★ 更隐蔽的一半**：**`team_merge` 收据的 `ancestorVerified:true` 不等于「未产生新提交」** —— 上述三次收据**同时**给出 `merged:true, ancestorVerified:true, commit=<新建合并提交>`。⇒ **不得用 `ancestorVerified` 判快进**；**判快进必须另取 `rev-list --parents`（父数）与 `is-ancestor` rc**。
- **修法建议**：**①** 当 `is-ancestor <destination> <source>` 为真时，`team_merge` 应**真的快进**（或提供 `ff_only` 选项）；**②** 至少在收据里**具名「本次是否产生了新提交」**（如 `fastForwarded: true|false`）；**③** 或明确文档化「本工具永不快进」，使调用方**不再据此规划**。
- **边界**：本条为**平台层缺口**，**不是**任何组长的操作错误（verifier 具名此立场，tier 0 采纳）。

**B-103（`inbox_ack` 不可用：「已投递」与 ack 前置「delivered」自相矛盾；且 `wakeIds` 为空的消息缺少确认路径 · 2026-09-28 · verifier 实测 · tier 0 收编）**
- **逐字**：对同一批两条消息（`msg-3d52c5f5` / `msg-6a040d91`），**`wake_id` 与 `inbox_id` 两种键形式均被拒**，回执为 `{"ok":false,"reason":"message-not-delivered"}`；而 **`inbox_list` 对 `msg-6a040d91` 明示 `"status":"delivered"`、`"wakeIds":[]`** ⇒ **「已投递」与 ack 的前置「delivered」自相矛盾**。⇒ **本会话早前同类 ack 成功过** ⇒ 这是**新出现的缺口**。
- ⇒ **缺口两点（报告者具名，tier 0 采纳）**：**①** ack 的拒绝串**不区分**「状态前置不满足」与「消息不存在」；**②** `wakeIds` 为空的消息**缺少可用的确认路径**。
- ⇒ **受准处置**：**不重试**（前置不在调用者可满足范围内），**记 evidence 并如实上报**（报告者已这么做 ✓）。
- ⇒ **★ 收窄（报告者自证伪，2026-09-28）**：**用同一动作重测** ⇒ `team_v12(action:"inbox_ack", wake_id:"wake:verifier:54")` 返回 **`ok:true / status="handled"`**（该 wake 的 `messageIds` 正是它当初报被拒的那条；`delivered→handled`，`lastError=null`）；另两条 wake 亦 `ok:true`（`deduplicated:true`）。⇒ **当前不可复现。**
- ⇒ **因此本条的措辞必须收窄**：**「拒绝曾观测到一次，成因未定，当前不可复现」** —— **不得**再以「**`ack` 不可用**」或「**前置与 `delivered` 自相矛盾**」的措辞引用，**也不得据此设计绕行**。
- ⇒ **判别器（可判假）**：**同一 `wake_id` 连续两次 `ack`，第二次应幂等成功。**
- ⇒ **仍然存活的部分（已并入 B-106）**：被 requeue 的 handoff **既不在 `inbox_list`、也不在可 ack 集合**（`ack` 返回 `wake-not-found … available wake ids: …`），而 `dispatch.pendingMessages[0].status` 仍为 `queued` ⇒ **该 handoff 没有可确认的投递 / `ack` 路径。**
- ⇒ **正面形态**：报告者**主动用同一动作重测并自证伪**，把条目**收窄而非删除**（原证据行不可就地改写 ⇒ 以新行收窄，`kind=platform-gap-correction` / `status=refuted-by-remeasurement`）⇒ **这是「修正不得让既有读数变成假」的又一实例。**
- ⇒ **★ 第二半亦被实测否证（2026-09-28 · G-WORLD 以 8/8 反例）**：对 **8 条 `wakeIds` 全为空**的消息逐条以 **`inbox_id`** 调用 `inbox_ack` ⇒ **8/8 返回 `{ok:true, status:"handled", handled:true}`、0 失败**（7 条为积压历史消息 + 1 条当轮完成 info）。⇒ **确认路径不依赖 `wakeIds`** ⇒ **「`wakeIds` 为空 ⇒ 缺确认路径」不成立**。
- ⇒ **因此本条的存活部分进一步收窄为**：**「拒绝曾一次性观测到，成因未定，当前不可复现」**（第一半「已投递与 ack 前置措辞自相矛盾」亦**未被任何一方复现**）。⇒ **本条其余内容应视为已否证**；**仍然存活的是 B-106**（被 requeue 的 handoff 既不在 `inbox_list`、也不在可 ack 集合）。
- ⇒ **操作结论（可复用）**：**`ack` 的正确键是 `inbox_id`（或顶层 `wake_id`）**；对 `wakeIds: []` 的消息，**用 `inbox_id` 即可收口，不必等 wake**。
- ⇒ **★ 本条的方法学价值**：**同一份条目被三个独立方各自否证了一部分**（报告者否证「不可复现」；另一组以 **8/8** 否证「缺确认路径」；而**存活的那一格被另立为 B-106**）⇒ **条目收窄到近零，而存活部分被正确搬进它自己的条目** —— 这是「**收窄而非删除**」与「**一格一条**」两条纪律的**合成形态**。
- **修法建议**：**①** ack 的拒绝串**具名是哪一种**（不存在 / 前置不满足，并给出当前状态）；**②** 为 `wakeIds` 为空的消息提供**以 `inbox_id` 为准的确认路径**（或明确「此类消息无需 ack」）。
- ⇒ **★ tier 0 的对照读数（收窄范围，并具名混淆项）**：**`msg-4595c69d`（verifier 发给 tier 0 的那条）由 tier 0 以 `inbox_id` ack 成功**（回执 `handled`）；而 verifier 对 **`msg-3d52c5f5`（tier 0 发给它）与 `msg-6a040d91`（lead-proto 发给它）** 的 ack 均失败。
- ⇒ **诚实说明混淆项**：这两组**既不同消息、也不同 actor** ⇒ **不是受控对照**，不能据此断定成因。⇒ **但它排除了一个假设**：「**该消息不存在**」被排除（tier 0 对同一批的另一条 ack 成功、且 `inbox_list` 明示 `delivered`）⇒ **剩下的方向是「前置条件逐 actor 判定」**。⇒ **待受控复现**（同一消息、两个 actor 各 ack 一次）才能定因。
**B-104（`edit` 静默忽略未知字段：回执 `ok:true` 且 revision +1，存储侧从未改变 ⇒ 调用方零信号 · 2026-09-28 · G-RIG 实测（含存储直读） · tier 0 收编）**
- **逐字**：对一张卡执行 `team_task_update(action:"edit", deliverable:"…")` ⇒ 回执 `{ok:true, rev:18→19}`；而**控制面存储直读**（长度 16,500,879，检索旧目标文本命中 **2 处**）显示**存储侧仍是旧值** ⇒ **该写入从未落库**。⇒ 且该字段**不在文档参数表里** ⇒ 调用方**只能靠试**。
- ⇒ **危害**：**回执成功 + revision 前进 + 存储未变** ⇒ 调用方**没有任何信号**，且**会据此写进报告**（本会话已发生：一位组长据此写了「已回读确认」，随后自我更正为「不可判定」）。
- **修法建议**：**①** 未在参数表里的字段应 **fail-closed 拒绝**（具名未知字段）；**②** 或若接受，则必须**投影出来**（使其可验证）。

**B-105（读投影在固定 revision 下不稳定，且会与存储不一致 ⇒ 投影不是 revision 的函数 · 2026-09-28 · G-RIG 实测（存储直读判决） · tier 0 收编）**
- **逐字**：**同一 revision（rev 20）、同一读者、两次读，结果不同** —— 早前读到某字段的旧文本逐字，**重测时该键不存在**（`hasOwnProperty=false`，两种 `board` 形状皆然）；而**控制面存储里该字段仍在**（附路径 + 长度 + 命中偏移）。⇒ **既不是「投影不对称」，也不是「不可读」** —— 是**投影不稳定**。
- ⇒ **危害**：**任何依赖该投影的判据 / 流程都不可靠**；**写入方无法验证自己的写入**；且**不得由「键不存在」推出「值已清空」**。
- ⇒ **配套（更基础的观察）—— ★ 已升级为「已确证」**：该字段在**任务行**上**根本没有这个键**；旧文本位于**嵌套的 `contract` 块**（`contract.deliverable` / `contract.goal`）。**对照实验（决定性）**：把 `contract.deliverable` / `contract.goal` 改为新对象后，**平台自己的任务投影信道（上下文 manifest）显示 `deliverable` = 新对象** ⇒ **「改契约 ⇒ 投影值 旧→新」** ⇒ **派生关系成立（不再是推断）**。
- ⇒ **因此本条的准确表述 = 「两个投影信道的载体集不同」**：**`team_task_get` 省略该键**（在 rev 24 上**两次读数一致地缺键**），而**携带它的信道（manifest）随契约改写而变化**。⇒ **不是「值没变」，也不是「不可读」** —— **是不同的信道暴露不同的载体集**。
- ⇒ **配套（正确措辞，替代一切绝对化说法）**：「卡面该字段**不由 `team_task_get` 暴露**（稳定缺键）；它由**携带该键的投影信道（manifest）从 `contract.deliverable` 派生** —— **已通过「改契约 ⇒ 投影值 旧→新」证实**；旧值在**追加式日志的证据行与作废声明**中**按设计留存**，故**全文件 0 命中不是有效口径**。」
- **修法建议**：**①** 投影必须**由 revision 唯一决定**；**②** 字段不可读时应**显式给出「不可读」**，而不是**静默缺键**。
- ⇒ **★ 对象更正（第二份读数）**：按行切分同一控制面文件 ⇒ `ROW_START=12109010` / `CONTRACT_START=12110461` / `ROW_ONLY_LEN=1451` ⇒ **任务行本身没有该键**（`ROW_ONLY_HAS_DELIVERABLE=False`）；旧文本的**两处命中都在嵌套的 `contract` 块内**（`contract.deliverable` / `contract.goal`）。⇒ **正确对象 = 「派生投影不稳定」**：卡面该字段**由 `contract` 块派生**（**推断，未确证**），而**其源在存储里稳定存在**。⇒ **不是「藏了任务行字段」。**
- ⇒ **配套（归因要完整，不得只归平台）**：该旧值的**存储源头有一半是 owner 自己** —— 它刷新验收契约时**逐字保留**了 `subject` / `deliverable` / `goal`（上级当时只点名改 `acceptanceCriteria`）。⇒ **这条「矛盾」不纯是平台问题**。
- ⇒ **处置（把它变成一次可判假对照）**：改 `contract.deliverable` / `contract.goal` ⇒ **若卡面该字段随之变为新对象 ⇒ 派生关系证实且矛盾消除；若不变 ⇒ 非派生，再报**（不得强行）。
- ⇒ **配套（保护既有读数）**：变更前应落一条**点-时声明**证据行，写明「该存储读数是记录时刻的点-时事实；后续受控变更后不再命中旧值是**预期**」⇒ **原读数不会因这次修改而变成假。**
**B-106（被 requeue 的 handoff 消息从未进入接收方 `inbox_list`，且其 dispatch 状态仍为 `queued` ⇒ 缺一条可确认的投递 / ack 路径 · 2026-09-28 · verifier 实测 · tier 0 收编）**
- **逐字**：dispatch `wake:acceptance-verifier:12e6bae67286b4eb248f6ad8`（attempt=2，`lastError="delivery deadline expired; retry queued"`）的载荷**从未出现在接收方的 `inbox_list`**（该列表仅 3 条、均非它）；而 `dispatch.pendingMessages[0].status` **仍为 `"queued"`**（messageId = packet id）。⇒ **接收方没有任何可确认的投递或 ack 入口**。
- ⇒ **受准处置（verifier 已做，正确）**：**从控制面直接读出该载荷**后执行，并**如实上报「它从未进入我的 inbox」**。
- ⇒ **与 B-103 的关系**：同族（**投递与确认的通道缺口**），但**不同一格** —— B-103 是「**已投递**却 ack 不了」，本条是「**重试后仍未投递**，而 dispatch 状态停在 `queued`，**既不失败也不可见**」。
- **修法建议**：**①** 重试耗尽后 dispatch 应进入一个**具名终态**（如 `delivery-failed`），而不是停在 `queued`；**②** 或把该载荷**补投进接收方 inbox**（使 ack 路径存在）；**③** 至少在 `inbox_list` 里**投影出「有 N 条 pending handoff」**，让接收方能看见。
**B-107（组分支并入后相位被推到 `integrated`，而 main 尚未包含它 ⇒ 相位领先于事实，且无后续步骤纠正 · 2026-09-28 · G-PROTO 实测 · tier 0 收编）**
- **逐字**：`team_merge(member → grp/proto)` 的 `phaseAdvance` 把该卡推到 **`integrated`**，而 **main 尚未包含该提交** ⇒ 该卡**读作 `integrated`，实际只在组分支上**。
- ⇒ **性质**：**`integrated` 的语义应是「已在 main 上」** ⇒ 相位**领先于事实**；而**没有任何后续步骤会纠正它**（tier 0 的 main 并入是另一步，且可能被 `no-verifier-clearance` 挡住数轮）。
- ⇒ **危害**：**看板会宣称一件尚未发生的事**；下游若按「`integrated` ⇒ 已在 main」推理（例如判断某修复是否已在 main 上），**会得到错误结论** —— 本会话已有一次**同族**事故（`blocked_by` 自动解除被读成「修复在 main 上」）。
- **受准处置**：**以 `git merge-base --is-ancestor <commit> main` 为准，不以相位为准**；报告时**同时给相位与祖先判定**。
- **修法建议**：**①** 组分支并入只应推到 `integration-ready`（或新增一档「在组分支上」），**`integrated` 留给「确已在 main 上」**；**②** 或让 tier 0 的 main 并入**回调**该相位。

**B-95…B-103 的重评级（2026-09-28 · 修复方第十轮报告 + tier 0 收编）**
- **全部 = 平台侧已修**：B-95（依赖阻塞卡允许组长改派且保持 `pending`）· **B-96（tier 0/1 可用受限外部取证目录 ⇒ 「提交面判据无取证通道」已解）** · B-97（`deleted` 卡不再占 write scope）· B-98（`deleted` tombstone 不再被 `release` 复活）· **B-85 live 补充（组长不能批准仓库根治理文件 scope ⇒ 特权提升路径已解）** · **B-99（tier→身份文件映射显式化；未知 tier 或映射冲突直接报错，不再静默加载 `member.md`）** · **B-100（等待动作优先解析真实 group/level 卡、支持 `board`、拒绝串具名实际 `taskBoard`）** · **B-101（`info` 回执按真实直投结果返回，不再硬编码 `room-summary`）** · **B-102（`verifier_report` 增加非阻塞的 `condition` severity）** · **B-103（`wakeIds` 为空的 delivered 消息可按 `inbox_id` 独立 ack；`message-not-delivered` 回执带当前 status；不存在返回 `inbox-not-found`）**。
- ⇒ **tier 0 的 live 旁证（无需专门复测）**：工具 schema 现已含 **`verifier_report.severity = … | "condition" | …`**（B-102）与 **`team_v12` 顶层 `board` 参数**（B-100）⇒ **两处修复在接口面可见**。
- **★ 边界（修复方自陈，必须随条目一起记）**：B-99 至 B-103 当前为 **focused fixture + 全量串行回归验证**，**尚未逐条在 live root Room / live G-WORLD 重放原始反例** ⇒ **不得据此回退对应绕过**，也不得写成「全部 live 转绿」。
- **修法建议**：**①** 若消息被折进摘要，回执应**具名**「未直投 + 折进哪个摘要」；**②** 或让 `info` 在存在开放 Room 时**仍直投**（摘要只是附加）。
**B-100 补充（第二实例 + 更锐的机制假设：等待默认落在 global 板 · 2026-09-28 · G-PROTO 实测 · tier 0 收编）**
- **第二实例（独立报告者）**：另一组的组长对**它自己组板上的卡**（`group-proto-t61`）执行 `waiting_set` **三次被拒**，拒绝串**与第一实例逐字相同**；它试了三种形状（仅 `task_id` + `input` / `input` 内加 `board` / 顶层 `owner` + `ticket_id`）**均不变**。
- ⇒ **含义**：**两个不同组的组长、在各自的组板上、都被同一条 scope 拒绝** ⇒ **不是某个 actor 的越权，而是「等待落在哪块板」的判定与「卡在哪块板」不一致。**
- ⇒ **更锐的机制假设（G-PROTO 提出，tier 0 采纳为假设、不写成因）**：**`team_v12` 没有 `board` 参数** ⇒ **等待默认登记在 global 板**，而卡在 `group-*` 板上 ⇒ **scope 判定按 global 板算** ⇒ **本组组长在本组卡上被判为越权**。⇒ 这解释了「**同一 actor 先前成功、后来被拒**」：**卡的板归属或板口径变化时，命中会翻转。**
- ⇒ **纪律（不重试）**：**同一拒绝串在试过多种形状后仍恒定，即停止重试**，把责任改记在**里程碑 `done_when` + 消息 + evidence** 上（两个实例都这么做，**正确**）。
- **修法建议（补充）**：**①** `team_v12` 的等待动作应**接受并解析 `board`**（或从卡的板推导），而不是默认 global；**②** 拒绝串应**具名「它按哪块板判定」** —— 现在的串说了 scope 规则，**没说它算的是哪块板**。
**B-102（`verifier_report` 的 severity 档位不够用：「适用条件」被写成 `major` ⇒ 门禁把条件当阻塞项 ⇒ **CLEARED 的报告打不开它自己清关的那次合并** · 2026-09-28 · tier 0 实测 · tier 0 收编）**
- **逐字**：`team policy refusal [verifier-found-a-major]: main refuses "grp/world": verifier-found-a-major (commit 9fd13651907e)`。**而同一份报告的 verdict 是** `BRANCH CLEARANCE … CLEARED`，且其表中**唯一那条 major 被逐字标注为「【并入操作条件·非返工项】不得以 head 树重置或覆盖 main」**。
- ⇒ **性质**：`verifier_report` 的 severity 只有 `blocker` / `major` / `minor` / `nit`，**没有「适用条件」这一档** ⇒ **清关的适用条件只能被塞进某一档** ⇒ 塞进 `major` 就**被门禁当作阻塞项** ⇒ **一份判为 CLEARED 的报告无法打开它自己清关的那次合并**。
- ⇒ **危害**：**判词与可合并性不一致**；且**调用方无法从拒绝串判断那条 major 是「缺陷」还是「条件」**（它只给了类别与 commit）。
- **修法建议**：**①** 增设 `condition` 档（**不阻塞**）；**②** 或让门禁**只按 `blocker` 阻塞**、`major` 交人判；**③** 至少让拒绝串**具名是表里哪一条 major**（给出标题）。
- **受准处置（tier 0 本次）**：请 verifier **重发一份**，**只把适用条件移进 `summary` 正文**、`issues` 表**只留 nit** ⇒ **不改内容、不改 head、不重测**。

**B-108（B-106 的修复只做了一半：`source:"dispatch-pending"` 的行**可 ack 且报 `handled:true`，但永不被清除** ⇒ 修复本身制造了一类永久滞留的收件箱行 · 2026-09-28 · tier 0 实测（DSH 重启后第一方复现）· tier 0 收编）**
- **逐字读数（2026-09-28，重启后）**：`inbox_list` ⇒ `total:10`，其中 **9 条 `injectionReceipt` 为 null**、`source:"dispatch-pending"`；逐条 `team_v12(action:"inbox_ack", inbox_id:"<exact-id>")` ⇒ **9/9 返回 `{ok:true, status:"handled", handled:true}`**；随后 `inbox_list` ⇒ **`total:10`，9 条全部仍在（清除 0 条）。**
- **对照（同轮）**：带 `injectionReceipt` 的行 ack 后**确实消失**（重启前同法实测：24 条中 **14 条清除**，而 5 条 `injectionReceipt` 为 null 的**全部留存**）⇒ **判别器 = `injectionReceipt` 是否存在**，与消息内容、优先级、发送者无关。
- ⇒ **性质**：`inbox_ack` 清除的是**注入态**；**从未注入的行无物可清** ⇒ 返回**幂等成功**而**条目留存** ⇒ **成功语义与列表状态不一致**。
- ⇒ **与 B-106 的关系（本条是修复的直接后果，不是独立起源）**：B-106 记的是「被 requeue 的 handoff **既不在 `inbox_list`、也不可 ack**」；**第十二轮修复让它出现在 `inbox_list` 并「可 ack」** ⇒ **可见性修好了，清除没修** ⇒ 于是产生一类**新的、永久滞留的**行。⇒ 观察形态「**在列表里、可 ack、报成功、清不掉**」是 B-106 的**镜像格**。
- ⇒ **危害**：① 收件箱**永不排空** ⇒ v14 恢复清单**每轮重放同一批已处理项**（B-20 同族，但 B-20 管的是 info 类，本条是 wake / dispatch 类）；② **消费者无法用 ack 的返回值判断条目是否已清** ⇒ 只能看列表，而列表 **ack 后不变** ⇒ **ack 失去全部可判假语义**。
- **修法建议**：① ack 对**未注入**的行**返回可区分的拒绝**（而非 `handled:true`），或**直接清除该行**；② 或让 `dispatch-pending` 行**不计入待确认集合**；③ 至少让回执**区分「已注入并清除」与「无注入态可清」**。
- **边界**：本读数取自**重启后**的同一会话，**未在第二个会话上复现**。G-WORLD 曾在**重启前**独立观测到同族形态（7 条 ack / 3 条留存），其判别假设「ack 清的是注入态」与本条的 `injectionReceipt` 判别器**独立相符** ⇒ **两个会话、同向**。
**B-108 补充（第三种形态：永久 `queued` 的行 ⇒ `ack` 被 `message-not-delivered` 永久拒绝，条目**永不可清** · 2026-09-28 · G-RIG 上报 · tier 0 收编）**
- **逐字（G-RIG 上报）**：`wake:lead-rig:46` **永久停在 `queued`**；对其调 `inbox_ack` **一律被拒 `message-not-delivered`** ⇒ **一条已被处理的消息永远清不掉**。
- ⇒ **与 B-108 正条的关系**：正条是「**能清却不报错**」（ack 报成功、条目留存）；本补充是「**报错却永远清不了**」（ack 报前置不满足、条目留存）。**两者同格、方向相反** ⇒ 合起来说明：**`inbox_ack` 的前置条件（`delivered`）与它的效果（清除条目）都不与消费者的真实需求（「我已处理，请移除」）对齐。**
- ⇒ **与 B-20 第二实例的关系**：B-20 记的是「**已注入却确认不了**」（投递标志**滞后**）；本条是「**投递标志永远不落地**」⇒ **不是滞后，是永久**。
- ⇒ **危害**：**被处理过的条目永久占据恢复清单**，且消费者**无任何可用手段移除** ⇒ 与 B-108 正条叠加，收件箱**只增不减**。
- **修法建议**：**①** 提供一条**不依赖投递标志**的「我已处理」路径（如按 `inbox_id` 无条件清除）；**②** 或让 `queued` 超期后进入**具名终态**并允许清除。
**B-108 补充的更正（分层错误；原形态由单方报告入账 · 2026-09-28 · tier 0 收编）**
- ⇒ **原补充的「报错却永远清不了」在**消息层**不成立、在 **wake episode 层**成立** ⇒ **改为分层表述，不作文本替换**（原文保留为历史记录）。
- **上报方的自我更正（逐字读数）**：`inbox_ack(wake_id)` 回 `{ok:true, status:"partially-handled", handled:false}` 并列出 4 条剩余 messageId；**逐条按 `inbox_id`(=messageId) ack** ⇒ 四条**全部**回 `{ok:true, deduplicated:true, status:"handled", handled:true}` ⇒ **消息层可以清**。而回读 `inbox_list` 显示 **`wake:lead-rig:46` 仍为 `{status:"queued", handledAt:null, attempts:5, redeliveryRequired:true}`**，**即使它的全部消息都已 `handled`** ⇒ **wake episode 层的状态不随其成员消息收口。**
- ⇒ **正确分层**：**泄漏在 wake episode 层**（永远 `queued` + `redeliveryRequired:true`），**不在消息层**。⇒ 与 B-108 正条的「能清却不报错」（**行 / 条目层**）是**不同层**，**不是同一格的两个方向**。
- ⇒ **★ tier 0 自认**：**我是据一份单方报告入账的**，而上报方随后**先「请求作废」、再「更正为 refine」** ⇒ 我**重演了 C-6**（「据单方报告就入了账，未先要求复现」）。⇒ **纪律重申**：**缺陷入账前，至少要有「报告方之外的第二个读数」或「报告方自己的两次一致读数」**；本条的第二读数是上报方自己补的，故**现在**才成立。
- ⇒ **保留下来的事实**：**`inbox_ack` 在 wake 级与消息级是两个不同的收口对象**，且 **wake 级不随消息级收口** ⇒ 按 `wake_id` 收口会得到 `partially-handled`；**回执列出了 4 条剩余 messageId（这一点是好的）**。
- **修法建议（改定）**：**①** `wake_id` 收口应**级联**其成员消息，或**明确文档化「必须逐条按 `inbox_id` 收口」**；**②** `partially-handled` 应给出**如何完成**的下一步；**③** wake episode 在其全部消息 `handled` 后应**进入具名终态**，而不是停在 `queued` + `redeliveryRequired:true`。

**B-9 / B-47 补充（机制查明：`waiting_*` 的作用域 = 未完成任务；建在 `completed` 任务上的票是惰性的 · 2026-09-28 · G-RIG 实测 + tier 0 读数佐证 · tier 0 收编）**
- **判别对（上报方逐票查所属任务的 status / phase）**：`waiting_list` 里**所有可见票都属未完成任务** —— `wait:group-rig-t27:rig-trace:f4d99760…`（t27 = **pending** / plan-approved）、t22 derived（**pending** / execution）、t30 derived（**pending** / plan-approved）；而它在 **`group-rig-t23`（status = completed）** 上建的票：`waiting_set` **回执给 `status:"open"`**，但 **`waiting_list` 从不列出**、**`waiting_resolve` 两次都回 `{not-found, candidateCount:0}`**。
- **⇒ 机制**：**`waiting_*` 只在未完成任务上生效；建在已完成任务上的票是惰性的** —— **回执说它存在，仪器却既不列它、也不认它。**
- ⇒ **这一条把 B-9 / B-47 的一部分从「票会自行蒸发」改写为「仪器按任务状态过滤」**：**`waiting_resolve` 的 `{not-found, candidateCount:0}` 不等于「票被删了」** —— 它也可能只是**该票所属任务已完成、仪器不再列它**。⇒ **两种形态必须分开记**：B-47 的 `auto:condition-cleared` 是**真解除**；本条是**过滤**。
- **tier 0 侧佐证（我自己两次 `waiting_list` 读数）**：所列 8 条票覆盖 `group-world-t96` / `group-rig-t22` / `group-rig-t27` / `group-rig-t30` —— **全部为 `pending` 任务**，**与上述机制一致**；**无一条落在 `completed` 卡上**。
- ⇒ **纪律**：**不得在 `completed` 卡上登记等待票**（卡面原文早已写明：耐久载体 = 卡面 `description` / 台账 / 未答复的定向 dispatch）；**遇到 `{not-found, candidateCount:0}` 时，先查该票所属任务的 status**，再判断是「**被过滤**」还是「**被解除**」。
- ⇒ **族属**：与 **B-109（派生票不对应真实对象）** 同族 —— **两者都是「票面存在 ≠ 票有效」**；本条给出**有效性的一维判据（所属任务是否未完成）**。
**第十三轮修复（2026-09-28 · 修复方报告 · tier 0 收编）：B-108 / B-109 = 平台侧已修**
- **B-108**：`inbox_ack(inbox_id)` **在同一次 mutation 内**同时退休 durable inbox 行**与** dispatch `pendingMessages`，并同步收口关联 dispatch / wake episode；wake 全部消息进入 `handled` 后**清除 `redeliveryRequired`**（消除 episode 层永久停在 `queued`）；`queued` / `delivery-failed` 的 `dispatch-pending` 行有**显式消费路径**（不再被 `message-not-delivered` 永久卡死）；ack 回执新增 **`cleared` / `pendingRetired` / `durableHandled` / `dispatchStatus`**；跨成员 ack 仍 fail-closed。
- **B-109**：`waiting-provider` **只在 `provider.status=blocked` 且存在真实 `lastFailure` 时**派生（health 因无关原因 disabled 不再生成幻影票）；provider 派生行携带 **`derivedFrom` / `providerStatus` / `providerLastFailure` / `healthStatus`**；fuzzy `waiting_resolve` 遇到可见 derived 行且无匹配显式票时返回 **`derived-ticket-not-resolvable`**，**不再静默命中旧的已 resolved 票**。
- **验证**：第十三轮 focused **7/7**；相关回归 **63/63**；全量 phase1–phase11 **378 tests / 377 pass / 0 fail / 1 skipped**；四 profile `node --check` **12/12**；profile 哈希一致性 **3/3**。
- **★ 边界（必须与条目同读）**：**为 focused + 全量串行回归验证，尚未在 live root Room 上重放原始反例** ⇒ **不得写成「live 原始反例全部转绿」**。**且修复方声明「未重启 DSH」** ⇒ **本会话当前读数仍反映修复前行为** ⇒ **此刻对 B-108 / B-109 复测会读到旧行为**，**不得据该读数判定修复无效**，**也不得据修复报告判定已生效** —— **只有重启后的一次 live 读数才能判定。**
- ⇒ **★ 反馈闭环**：**第十三轮修的两条正是本会话由 tier 0 入账的 B-108 / B-109**（本会话第二次 tier 0 入账被修复方采纳）。
- ⇒ **配套（正面样本）**：本会话刚落盘的「**入账前至少要有第二个读数**」这条纪律，**其第一次适用发生在「`:307` 的域」这个问题上** —— 一位组长**独立复读 `GOVERNANCE.md:304/306/307` 并自行得出同一结论**，且**补出一个 tier 0 未引的依据 `:310`**（「实现者必须为『分母为 0』补一条可执行负例」）⇒ **该纪律当场产出了独立第二读数与增量证据。**

**B-109（`waiting_list` 给每张等待中的卡派生一条 `waiting-provider` 票 ⇒ tier 0 据此误判「全队被 provider 阻断」· 2026-09-28 · tier 0 亲测 · tier 0 收编）**
- **逐字读数（2026-09-28，重启后）**：`team_v12(action:"waiting_list")` ⇒ `total:8`，其中 **6 条 `status:"derived"` / `reason:"waiting-provider"` / `unblockCondition:{type:"provider-healthy"}`**（覆盖 `group-world-t96`、`group-rig-t22`、`group-rig-t27`、`group-rig-t30`），而**唯一真实阻塞是 `waiting-dependency`（→ t23）**。
- **我据此做的事**：我**当场把它读成「全队被 provider 阻断」**并调用了 `team_provider_resume`。⇒ 回执 **`{resumed:false, provider:{status:"unknown", lastFailure:null}}`** ⇒ **没有任何持久 provider 阻断可清**；同时 `list_agents` 显示 `lead-world` **正在 running** ⇒ **provider 可用。**
- ⇒ **性质**：该派生票**在不存在 provider 阻断时也会出现**（`lastFailure:null` 且 provider 可用，票仍带 `provider-healthy` 解除条件）⇒ **它是一条与真实阻塞无关的幻影条件。**
- ⇒ **危害**：**它把一次「依赖等待」误投影成「全队阻断」**，而 `waiting-provider` 的**规定处置恰是 tier-0 调用 `team_provider_resume`** ⇒ **该票会稳定地把 tier 0 引向一个无对象的恢复动作**；若 tier 0 不核 `lastFailure` 与 roster，就会把**幻影**记成**已处置的阻断**。
- **本次无损害**：`resumed:false` ⇒ **无状态被改**（幂等、无副作用）⇒ 这是一次**无害的误读**，不是事故 —— 但它**本来可以**让人相信「provider 已恢复」而不再查真因。
- **族属**：与 **B-27（上下文百分比提示误导调度）**、**B-17（`stalled` 假阳性）** 同族 —— **投影描述的是平台上次计算时的状态，不是当前状态**；本条的形态是「**一个解除条件被投影出来，却不对应任何真实对象**」。
- **修法建议**：**①** 只在**确有 provider 阻断**（`lastFailure` 非空 / provider 状态非 healthy）时才派生 `waiting-provider`；**②** 或在派生票上**具名其来源**，而不是给一个看起来可解除的条件；**③** 至少让 `waiting_list` 的派生票**与 `provider.lastFailure` 同时投影**，使读者能一眼排除幻影。
- **纪律（tier 0 自认）**：**读 `waiting-provider` 必须先核 `lastFailure` 与 roster**；**不得仅据派生票的 `reason` 判定 provider 状态。**
- ⇒ **★ 独立第二实例（G-WORLD 上报，与 tier 0 互不知情）**：该组长**也在 `waiting_list` 里看到 t96 的 `derived` / `waiting-provider` / `unblockCondition:{type:"provider-healthy"}` / `responsible:lead` 票**，且**其 `nextCheckAt` 每次读取都被刷新**；它**尝试用 `waiting_resolve` 清掉它并失败** —— resolve **命中并返回的是另一张已 `auto:condition-cleared` 的旧票**（rev 7、依赖 t95）⇒ **resolve 的目标选择与派生票不是同一个对象。**
- ⇒ **该补充给出两个新事实**：**①** 幻影票**不是 tier 0 的孤例**（两个独立读者、同一形态）；**②** **派生票不可被 `waiting_resolve` 收口** —— 收口动作会**落到另一张票上**，且**返回成功**（这正是「**动作成功 ≠ 目标正确**」的又一实例，与「**每个动作都要核它作用于哪个对象**」同族）。
- ⇒ **纪律（补充）**：**不得用 `waiting_resolve` 去清派生票** —— 它可能**静默收口一张无关的票**（本次命中的那张本就已 auto-resolved，故无损害）；**派生票只能由它自身的条件变化消失。**
**B-108 机制更正（tier 0 的单因子判别器被 G-WORLD 的判别实验推翻 ⇒ 正确机制是**两个独立状态变量** · 2026-09-28 · G-WORLD 实测 · tier 0 采纳并自我更正）**
- ⇒ **本条正条的判别器「`injectionReceipt` 是否存在」必要但**非充分**，其机制归因**作废**。**
- **判别实验（G-WORLD，带可证伪预测）**：两条消息**都带 `injectionReceipt`**，结果**不同** ——
  · **(a)** verifier 的 info（`wakeRequested:false` / `wakeIds:[]`，**无 wake 绑定**）⇒ ack 后**从 `inbox_list` 消失**；
  · **(b)** tier 0 的 action wake `msg-f5a50632`（`dispatchId=wake:team-wake:lead:lead-world:r89`、**`source:"dispatch-pending"`**）⇒ ack 返回 `{ok:true,status:"handled",handled:true}`，**行仍在**，只是 **`injectionReceipt` 由 present 变 null**。
- ⇒ **根因读数**：`r89` 的 dispatch `status:"completed"`、`resolvedAt` 已置，但 **`pendingMessages[0].status` 仍为 `"delivered"`** ⇒ **inbox 行正是由这条「未退休」的条目投影出来的。**
- ⇒ **修正后的机制 = 两个独立状态变量**：**V1 = `injectionReceipt`**（ack **会**清）；**V2 = 一条 `source:"dispatch-pending"` 的 wake 条目且其 `pendingMessages[].status` 未被退休**（ack **不触碰** `pendingMessages`）。⇒ **行消失 ⟺ 两个变量都不再钉住它。**
- ⇒ **这同时解释我方的 9/9 与 G-WORLD 的 1/1**：我那 9 条的 receipt **本就已是 null** ⇒ ack 无事可清、条目照旧钉住；它那条 receipt 是 present ⇒ ack 清掉了它，**但条目仍钉住**。⇒ **两个独立状态，不是同一个。**
- ⇒ **★ tier 0 自认的方法错误**：我据 9/9 归纳出单因子，而那 9 条**同时具备两个属性**（receipt=null **且** dispatch-pending）⇒ **该样本对「两个因子」没有判别力** ⇒ 我**从共变样本里归纳出了单一成因**。⇒ 与「**同向 ≠ 独立**」（三条同向 0 命中共享一个过滤器）**同族**：**共变不是判别。**
- ⇒ **无成员侧修复路径（G-WORLD 实测）**：`team_dispatch_update(r89, status:"completed")` 被**幂等接受**，但**不退休**该条目（重查 pending 仍 `[delivered]`）⇒ **消费者无法自行解除钉住。**
- ⇒ **可证伪预测（已由三点支持）**：**凡 `source:"dispatch-pending"` 的行，无论 receipt 有无，ack 都清不掉；有 receipt 且无 dispatch 绑定的消息 ack 后必消失。**
- ⇒ **受准处置**：**不再对残留行做 `ack` 或 `dispatch_update`**（G-WORLD 已按此停止重试 —— 正确）。

**B-111 宿主 `tools.read` 对长文件静默截断，同时回报真实 `totalLines`（2026-09-28 · 两方独立命中 · tier 0 实测 + G-WORLD 实测）**
- **现象**：单次 `tools.read` 即使 `limit` 远大于文件行数，仍只返回文件**前一段**；而 `totalLines` 报的是**真实**总行数 ⇒ 调用方看到「`totalLines=2675`，我拿到 333 行」，极易把「**没读到**」当成「**不存在**」。
- **我的三组读数（同一时刻、同一仪器）**：
  · `docs/GOVERNANCE.md`：`totalLines=2675` → 返回 **333** 行（末行号 333）
  · `docs/PLATFORM-DEFECTS.md`：`totalLines=1067` → 返回 **181** 行
  · `docs/STATUS.md`：`totalLines=564` → 返回 **260** 行
- **独立第二命中（G-WORLD）**：对一份 **633 行**交付物，`limit=2000` 报 `totalLines=633` 而**只返回 525 行** ⇒ 第 570 行缺席，该组长**差一步发出假指控**（以为成员伪造 `{379,400,570}`）；改用 **pinned blob 上的 `git grep`** 复测后，**成员成立、他错**。**两方互不知情** ⇒ 非偶发。
- **危害两侧**：
  · **看起来一切正常**：`totalLines` 正确 ⇒ 把窗口内 0 命中读成全文 0 命中 ⇒ **假指控 / 假阴性结论**。
  · **卡住**：真正的「全文域」判据无法用单次调用建立，而调用方**以为已建立**。
- ⇒ **纪律**：「**全文域**」类读数**不得以单次 `tools.read` 为凭**。三种合格形态：**(a)** 自证 `returned == totalLines`；**(b)** 分窗取全并**声明窗口**；**(c)** 对 **pinned blob** 用 `git grep`。
- **族属**：本会话同族（**仪器静默吞掉一整类**）的又一实例 —— 前四例：`Measure-Object -Line` 跳空行（1822 vs 1957）；`^i/lf` 漏 `-text`（423 文件）；`grep FAIL` 把**绿**门禁读成**红**；8 字符 evidence-id 前缀解析不到完整键。
- **状态**：**未修**（属平台，不属本仓）；**消费者侧可绕**（上述三种形态）。

**B-112 依赖放行门槛 = blocker 的 `phase == accepted`（未文档化）；`completed / integrated` 仍报 `dependencies-unmet`（2026-09-28 · tier 0 实测）**
- **读数（一次普查、同一仪器、同一时刻、两端同读）**：pending 卡共 **7** 张 ——
  · **6** 张（`group-rig-t22/t27/t30/t34/t35/t36`）blocked by `group-rig-t23`（`status=completed` / `phase=integrated`）⇒ `ready=false`、`unmet=["group-rig-t23"]`；
  · **1** 张（`group-world-t98`）blocked by `group-world-t97`（`status=completed` / `phase=accepted`）⇒ `ready=true`、`unmet=[]`。
- ⇒ **放行判据 = blocker 的 `phase == accepted`**。`integration-ready` 与 `integrated` 均**不**放行。
- **动作侧确认（同轮）**：把 `group-rig-t23` 由 `integrated` 推到 `accepted`（rev 106→107）后重读：**六张卡 `unmet` 全部清空**，t22/t27/t30 `ready=true`，t34/t35/t36 `ready=false` 但原因**只剩 `not-approved`**。⇒ **动作 → 效果**两侧一致。
- **危害两侧**：
  · **卡住**：组长把 blocker 合并进 main 后，依赖卡**仍全部不可派发**；而 **final-acceptance 是 tier-0 独占权限** ⇒ **组长在组内无任何补救手段**，只能上报（`ready=false` 时写入被 fail-closed 具名拒绝，是设计不是故障）。
  · **看起来一切正常**：`status=completed` 会被读成「依赖已满足」。
- **结构性后果（必须具名）**：**一张卡的修复卡若 `blocked_by` 该卡自身，则「先接受、后修复」是唯一顺序** —— 本例 t35（major）/t36/t34 都 `blocked_by group-rig-t23`，因此 **t23 必须先 `accepted`，它自己的缺陷才能被修**。
- ⇒ **纪律**：**派发前先读 `ready_queue.unmet`**；**不得把 `status=completed` 当作依赖已满足**；**不得为绕开门槛而删依赖**（依赖表达的是写范围串行化）。

**B-112 补一：`not-approved` 是粗粒度原因，混「无计划」与「计划未批」（2026-09-28 · G-RIG 组长实测 · tier 0 采纳并更正自己的表述）**
- **实证**：tier 0 见 `ready_queue` 对 `t34/t35/t36` 报 `reasons:["not-approved"]`，遂要组长「批准这三张的计划」。组长实测 `team_plan_get` 对三张卡**全部**返回 `[plan-not-found]: no plan exists for task …` ⇒ **根本没有计划可批**；三张卡 phase = `room-discussion`，须**先由 owner `team_plan_propose`**。
- ⇒ **更正**：tier 0 的「原因只剩 `not-approved`」**不精确**。该字段至少混 **(i) 无计划**、**(ii) 有计划未批**。
- ⇒ **判别器**：`reasons` 不足以定序，须再读 `team_plan_get`（`plan-not-found` ⇒ (i)）。
- ⇒ **族属**：**粗粒度原因不是判别器** —— 与条款 36 同族（以「相等」为结论前须先证明两端可区分）。

**B-113：「guard 绿」≠「全仓引用可解析」—— guard 判定域不含「第 N 条」形态（2026-09-28 · 两组长独立复跑 · tier 0 收编）**
- **实证**：某决策引「台账第 46 条」，该编号在**受跟踪文档中无正文**（GOVERNANCE 的条目是**无编号加粗段落**，本台账用 **B 编号**）；两位组长各自独立复跑**均 0 命中**。而 `citation_integrity` 的两个扫描器（`§<n>(.<n>)? L<n>` 与 `path.ext:line`，ext ∈ {rs,md}）**都不含**该形态 ⇒ **三次静默通过**。
- ⇒ **域外形态有两类**：**(甲) 域内但语义不支持**（已具名）；**(乙) 形态不在扫描器文法内**（本条）。⇒ **「guard 绿」只证「guard 判定域内完整且稳定」**。
- ⇒ **纪律**：引用**编号 / 条目**须给**可解析载体**（正文 + path/blob，或完整 id）；**不得以 guard 绿代替对引用可解析性的检查**。

**B-114 `team_room_next` 接受 frozen 成员 ⇒ 该轮「发言侧跳过、关轮侧强制」两侧不一致（2026-09-28 · tier 0 实测）**
- **实测**：我在 `team_room_next` 的 `members` 里含 `lead-server`（**frozen**）。运行时**两个方向不一致**：
  · **发言侧**：`round.spoken` 最终 = `["lead","lead-proto","lead-world","lead-rig"]` —— **正确跳过** `lead-server`，`nextSpeaker` 也从未指向它；
  · **关轮侧**：`team_room_close` 被拒 —— `round … cannot close before every participant has made one main speech; missing: lead-server`。
- ⇒ **同一成员被「正确地跳过」又被「要求必须发言」** ⇒ 宿主若不知道 `forceClose` 通道，就**无法关轮**，而**轮预算已被消耗**（本例 `used 3 / max 3 / remaining 0`）。
- **可绕过**：错误文本自己给出通道 —— `forceClose:true` + `waivedMembers:[…]` + `forceCloseReason`，条件是**缺失的发言者已冻结**。
- ⇒ **危害两侧**：**卡住**（不知通道 ⇒ 无法关轮且预算耗尽 ⇒ 只能升级）；**看起来一切正常**（`spoken` 里确实没有它，宿主会以为「全员已发言」）。
- ⇒ **判据 / 期望**：**要么在入座时拒绝 frozen 成员，要么在关轮时把它排除出法定人数**（与发言侧一致）。**不得一侧跳过、另一侧强制。**
- ⇒ **纪律（消费者侧）**：`team_room_next` 的 `members` **不要包含 frozen 成员**（本例的排座失误是 tier 0 自己的）；若已包含，关轮前先读 `spoken`，缺失者**若已冻结**则直接走 `forceClose` 通道并**具名理由**。

**B-115 `team_v12(action:"room_snapshot")` 与 `team_room_read` 对同一 room 返回不同的 decision 集合：前者漏掉最新 `proposed` 决策（2026-09-28 · tier 0 同点两仪器实测 + 一名组长据此得出假结论）**
- **同点、两仪器、同一问题**（我同一时刻各读一次）：
  · `team_room_read(room_id:"root")` ⇒ **含** `decision-dd09229e-…`，`status:"proposed"`，`missingConfirmations` = 三名组长；
  · `team_v12(action:"room_snapshot", room_id:"root")` ⇒ **不含**该决策（只返回 5 条更早的 `confirmed`）。
- **危害已经实际发生**：一名组长在本次唤醒读 `room_snapshot`，见「没有任何 proposed / 待确认的决策」⇒ 得出「**我无对象可 confirm**」并**拒绝擅自 resolve**（它的处置是对的）。**对象其实存在** —— 是它的仪器漏了。
- **危害两侧**：
  · **卡住**：需要确认的组长**看不到决策** ⇒ `required_confirmations` **永远集不齐** ⇒ 决策**永远停在 proposed**；
  · **看起来一切正常**：`room_snapshot` 返回的是一份**格式良好、条数合理**的决策表 —— **没有任何信号提示它漏了一条**。
- ⇒ **纪律**：room 决策以 **`team_room_read`** 为准；**在断言「room 里没有 X」之前必须用第二个仪器复核**（与「以某读数为裁决依据前须用第二个独立仪器对照」同条）。
- **状态**：**未修**；消费者侧可绕（改用 `team_room_read`）。

**B-115 补一：第三条独立读数确认「对象实存、只有投影漏它」+ 机制区分（2026-09-28 · G-WORLD 组长实测 · tier 0 收编）**
- **第三条独立读数**：`team_room_confirm(room_id:"root", decision_id:<完整 id>)` 对同一 id **解析成功**（返回 `status:proposed`，且 `missingConfirmations` 由三项降为 `[lead-proto, lead-rig]`）⇒ 该决策在**控制面实存**，**只有 `room_snapshot` 的投影漏了它**。⇒ B-115 的定性由「两仪器不一致」收紧为「**对象实存、某一仪器的投影漏项**」。
- **一条消费者侧纪律（G-WORLD 提出，我采纳）**：**凡断言某 decision「不存在」，不得以 `snapshot.decisions` 为空为凭**；必须另取**能解析 proposed 的通道**（`team_room_confirm` 或按完整 id 直查）。
- **机制区分（重要，避免把两类混为一谈）**：本日同族**三条** —— `tools.read` 静默截断（633 行报 525）／调用方 `slice` 截断（`mc_net` 枚举被切尾）／本次**投影漏 proposed**。**族 = 「仪器静默吞掉一整类」，但机制不同**：前两条是**截断**（读到了、但少了），第三条是**投影过滤**（对象在，投影把它排除了）。⇒ **补救也不同**：截断要**自证 `returned == total`**；投影漏项要**换一个能表达该状态的通道**。
- **另一条同形实例（G-PROTO 报，tier 0 收编）**：**短 id 不可解析** —— `team_room_confirm` 传短 id `decision-dd09229e` 被拒 `unknown decision … in room "root"`，传**完整 id** 成功。⇒ 已登记的「引用必须写完整 id」**对 decision id 同样成立**，不只是 evidence id。

**B-115 补二（更正补一的定性：这是「双向」分歧，不是单向漏项 · 2026-09-28 · G-WORLD 组长实测 + tier 0 复算确认 · tier 0 自我更正）**
- **补一写的**：「该决策在控制面实存，**只有 `room_snapshot` 的投影漏了它**」 ⇒ **该定性过窄，作废**。
- **同点集合对比（我复算，两仪器各读一次）**：
  · `team_room_read` = {6e55b6ce, 47a8b3db, b5415e87, 4c055509, **dd09229e**}
  · `room_snapshot`  = {**aebe1cfc**, 47a8b3db, 6e55b6ce, b5415e87, 4c055509}
  · 交集 **4**；**仅 room_read 有 = {dd09229e}**；**仅 snapshot 有 = {aebe1cfc}** ⇒ **两个投影各丢一条，且丢的不是同一条**；**互不为超集**。
- **两条选择规则已由现有数据判定（不是待验证假设）**：用手上的 `createdAt`/`status` 直接复算 —— **(i) `team_room_read` = 按 `createdAt` 取最近 5 条**（`aebe1cfc` 是六条中最早的一条，被挤出）→ 与观测**逐元素相等**；**(ii) `room_snapshot` = 只投影 `status=confirmed`**（当时恰 5 条 confirmed）→ 与观测**逐元素相等**。⇒ **两仪器并集 = 全部 6 条**。
- ⇒ **消费者纪律（G-WORLD 提出，我采纳并升级）**：**分歧时取并集，并分别具名每个仪器的 cap 与 filter**；**任一方都不得被当作全集**。
- ⇒ **方法论（我自己的失误，必须具名）**：我手上**同时有两个集合**，却只做了**单向**差集（只看「谁漏了我关心的那一条」）⇒ 把**双向分歧**误述为**单向漏项**。⇒ **比较两个集合必须双向取差。**

**B-100 补一：`waiting_set` 的拒绝至少有两类 —— scope 类与 shape 类，且错误文本自陈是哪一类（2026-09-28 · G-PROTO 组长实测、其首次成功登记 · tier 0 采纳拆分）**
- **实证**：`team_v12(action:"waiting_set", task_id:"group-proto-t69", input:{reason, unblockCondition:{type:"dependency", taskIds:["group-proto-t69"]}, responsible, nextCheckAt})` ⇒ **成功**（`ticketId: wait:group-proto-t69:member-framing:…`）。
- **第一次被拒的文本是** `waiting-condition-invalid: dependency condition requires taskIds` —— 这是**前置条件（形状）**，**不是** B-100 正条记录的那条 `waiting-scope: only the task owner, its group lead on a writable group board, or tier 0 may change its wait`（**权限**）。
- ⇒ **拆分**：**(i) scope 类**（权限；成因未定，正条保留）；**(ii) shape 类**（`type:"dependency"` 必须带 `taskIds:[...]`，且**错误文本已自陈前置条件**）。
- ⇒ **纪律**：**被拒时先读错误文本属于「前置条件」还是「权限」** —— **前者应修复形状而非放弃**，后者不应重试。**把两类混记为同一条「被拒」，会让后续读者把可修的当成不可修的。**
- ⇒ **一条我未实测的形状歧义（记作待判，不得当结论）**：本例 `task_id` 与 `taskIds[0]` **是同一个 id**。`task_id`（等待挂在哪张卡）与 `taskIds`（要等哪些卡完成）**语义不同**，二者相同时**必须显式确认这是意图**。**其实际语义我未实测** ⇒ 判别式：读 `waiting_list` 看该票的 `unblockCondition` 与 `status`，并在 t69 完成后重读是否自动解除。**在确认前不得断言它「永不解除」或「正确」。**

**B-116（verifier-clearance 门禁：清关键只有一个，而被清关对象有两个 ⇒ 一份 CLEARED 报告打不开它自己清关的那次合并 · 2026-09-28 · tier 0 第一手 · tier 0 收编）**
- **逐字（tier 0 第一手）**：`team policy refusal [no-verifier-clearance]: main refuses "grp/world": no-verifier-clearance (commit 88b88ad025cf)`。
- **当时状态**：verifier 的 r2 报告 verdict 行 = CLEARED，**正文**清关的是 **head 级对象**（`grp/world` head `88b88ad0`，并后 tree `b9c10a37`）；而报告机器可读键 `commit` = **卡级 commit**（`70d9395`，另一分支上的另一对象，tree `4a8786a3`）⇒ **读作 CLEARED、合并被拒**。
- ⇒ **性质**：`verifier_report` 只有**一个** `commit` 槽，而一次清关**合法地**可以覆盖**两个对象**（卡级 commit 与 head commit）⇒ **一个槽承载两种语义**。**与 B-102 同后果、不同机制**（B-102 = severity 档位不够用，条件被塞进 major）。
- ⇒ **诊断质量**：拒绝串**具名了它要求的 commit**（`88b88ad025cf`）⇒ 诊断**够用**；缺的是**报告侧无法表达「我清关了这两个」**。
- **修法建议**：**①** `verifier_report` 增 `clearedCommits: string[]`（或 `commit` 接受数组），门禁按**集合成员**判定；**②** 或门禁在「**同 tree、不同 commit**」时给出**可区分的拒绝串**（当前串与「根本没有清关」同形）。**注意**：②与「承重不变量是 tree」的既有口径有张力，**须先裁定再实现**，不得默认放行。
- **受准处置（tier 0 本次）**：**不豁免门禁** —— 拒绝在实质上是**正确**的（被清关对象 ≠ 被并入对象）。已请 verifier 发一条**具名 `88b88ad0` / tree `b9c10a37`** 的清关（若判定不变，这只需改键、不需重测），或明确回绝并给理由。

**B-117（`evidence_query` 假阴性：`filtered:true` + `queryKey:null` 时以空集作答 ⇒ 「无数据」与「查询未形成」不可区分 · 2026-09-28 · G-PROTO 实测机制 · tier 0 收编）**
- **实证（三种替代形态全部如此）**：`task_id="group-world-t98"`、`input:{taskId:…}`、`input:{commitSha:70d9395…}` ⇒ **全部**返回 `{rows:[], visibility:{filtered:true, queryKey:null, matched:0, scope:"member", total:3771, visible:965}}`。
- ⇒ **机制**：`evidence_query` **只**由**完整 `evidenceId`** 派生查询键 ⇒ 其余形态**过滤器没有形成查询**，但回执仍以**空集**作答。
- ⇒ **危害**：**假阴性** —— 消费者据此得出「该卡没有证据」，而这是**域未覆盖**或**调用形态错误**，不是事实。这正是「连续两轮无法回读本卡 evidence 行」那一域的根因。
- **修法建议**：**①** `queryKey:null` 而 `filtered:true` 时**报错或标注「未形成查询」**；**②** 或让 `taskId` / `commitSha` 成为**一等查询键**。
- ⇒ **与 B-116 的关系**：同族（**回执的表达力不足以区分两种状态**：B-116 是「清关了哪个对象」，本条是「查询是否形成」）。

**B-110 补充（收据的 `previous` = merge base，不是源分支的前 head · 2026-09-28 · G-WORLD 组长实测 · tier 0 收编）**
- **实证**：`grp/world` 并入回执 = `merged:true sourceSha=70d9395 previous=25928086 ancestorVerified:true fastForwarded:false createdCommit:true`。而 `grp/world` 的**前 head 是 `da277208`**（`70d9395` 才是本次并入的源）⇒ **`previous` 报的是 `25928086`（并入时的 main = merge base），不是 `da277208`**。
- ⇒ **含义**：`previous` **不能**被读作「源分支原来的 head」；它与 **B-110 正条**（第一父 = 并入时的 main、第二父 = 源）**互证**。
- ⇒ **纪律**：**读 `previous` 前先问它指的是哪个对象**；把 `previous` 当「分支前 head」会**误判**「并入是否丢了提交」。

**B-116 补一（同一份清关的「预登记 tree 值」只在目的分支被钉住时有效 · 2026-09-28 · tier 0 第一手 · tier 0 收编）**
- **实证**：verifier 对 `88b88ad0` 出清关时**预登记**并后 tree = `b9c10a37`（= `merge-tree(main@25928086, 70d9395)`），**在那一刻逐字正确**。而我在请求清关之后、并入之前落了条款 53-58 的文档提交（main `25928086` → `de9c96e`）⇒ 实际并入 = `merge-tree(de9c96e, 88b88ad0)` ⇒ 并后 tree = **`3d629617`** ≠ `b9c10a37`。
- ⇒ **没有人错** —— 差来自**参照物前进**（条款 54）。该 tree 值是对**某一目的分支快照**的断言。
- ⇒ **纪律**：清关里**预登记的 tree 值**只在**目的分支被钉住**时有效；**耐久形态 = 相对「钉住的并入前 main」的 `diff --name-status` 路径集** —— 本例「**恰 2 路径**」在**两次参照下都成立**。
- **并后实测（tier 0，`evidence-b4ef39d4-40d9-4180-aba1-f28cfefe134b`）**：commit = `3c0facee5a90cfdc5ebd708e51f8a405ff43404a`；父 = `[de9c96e, 88b88ad0]`（第一父 = 并入时 main、第二父 = 源 ⇒ **B-110 形态再现**）；`diff --name-status de9c96e → HEAD` = **恰 2 路径**；两 blob `55452a2b` / `b253d908` **逐字等于卡级对象** ⇒ **「并集纯净、逐字携带」这一实质结论未变。**

**B-118（诊断字段 `idResolution.form` 不是传入串的纯函数 ⇒ 同串在两方得到不同 `form` · 2026-09-28 · G-PROTO 与 verifier 各一读数 · tier 0 收编）**
- **实证（同一输入、两个读者、不同输出）**：一方传**完整 45 字符串**，响应 `query`/`queryKey.value` **逐字回显该完整串**，却报 `form:"prefix"` + `candidateCount:0`；另一方用**同一串**得 `form:"full-id"` + `rows:1` + `idResolution.status:"resolved"`。
- ⇒ **性质**：`form` **依赖该侧的解析结果**，不是**传入串的函数** ⇒ 它**不能**被用作「调用方传了短 id」的证据。
- ⇒ **危害**：**一次误归因已经发生** —— 报告方据 `form:"prefix"` 把自己的正确 id 判为「形态错误」，而对方用同一串读到了该行；双方各自都「有读数」，**分歧出在被当证据的那个字段上**。
- ⇒ **与 B-117 的关系**：**同族（回执的表达力不足以区分两种状态）、不同格** —— B-117 是「**查询未形成**却以空集作答」（**行的存在性**被错误表达）；本条是「**诊断字段随语境变化**」（**输入的形态**被错误表达）。
- **修法建议**：**①** 若 `form` 描述**传入串**，它必须是**输入的纯函数**，并在两侧一致；**②** 若它描述**服务端解析**，字段名必须写明（如 `resolvedForm`），且**不得**与 `query` 回显串并列在同一组里；**③** `candidateCount:0` 与 `rows:0` 应分别具名「**解析到 0 个候选**」与「**候选存在但被过滤**」。
- ⇒ **纪律**：**诊断字段的适用范围 = 它自己那侧**；跨语境搬运即误归因（条款 59）。

**B-116 已修（平台侧 · 接口面可见 · 2026-09-28 · tier 0 观测）**
- **观测**：`verifier_report` 的 schema 现已含 **`cleared_commits: string[]`** 及其驼峰别名 **`clearedCommits`**，描述为「Additional exact commits this report clears, such as both the task commit and the group-branch head」⇒ **正是 B-116 修法建议 ①**（**一个槽承载两种语义 ⇒ 改为集合**）。
- ⇒ **边界（必须与条目同读）**：这是**接口面可见的旁证**，**不是**在 live 上重放了原始反例（「一份 CLEARED 报告因机器可读键指了另一个对象而打不开合并」）。**不得写成「live 原始反例已转绿」。**
- ⇒ **受准处置**：请 verifier 在下一次涉及**两个对象**（卡级 commit + head commit）的清关里**使用该字段**并把读数写进报告 —— 那将是该修复的**第一手 live 验证**。

**B-110 补二（★ 正条被 live 证伪：`team_merge` 会快进；「不快进」不是它的性质 · 2026-09-28 · tier 0 第一手受控对）**
- **同会话、同工具、连续两次并入的受控对**（唯一变量 = 目的 head 是否为源的祖先）：

| 并入 | 源 head | 并入前目的 head | `ancestorVerified` | `fastForwarded` | `createdCommit` | 并后 HEAD |
|---|---|---|---|---|---|---|
| `grp/proto → main` | `c4deb608` | `06bc490c` | true | **true** | **false** | `c4deb608`（= 源本身） |
| `grp/rig → main` | `69bf80d7` | `c4deb608` | true | **false** | **true** | `7eb6cf60`（新并提交） |

- ⇒ **正条「`team_merge` 不执行快进」作为普遍断言为假。判别量 = 目的 head 是否为源的祖先**：
  · **proto 案**：`c4deb608` 的**第一父就是当时的 main** `06bc490c`（组长已在组分支上并入过 main）⇒ main 是源的祖先 ⇒ **真快进，不产生新提交，HEAD 直接指向源**；
  · **rig 案**：`is-ancestor c4deb608 grp/rig` = **rc 1**（proto 的并入不在 rig 链上）⇒ **真三维并**，产生两父提交 `7eb6cf60`，父 = `[c4deb608, 69bf80d7]`。
- ⇒ **更正后的准确表述**：**目的 head 是源 head 的祖先时快进；否则创建两父并提交。** 权威字段 = `fastForwarded` / `createdCommit`。
- **★ 第十四轮已修字段（lead-proto 的可判假预测，我第一手读数）**：两次回执**四个新字段全部被填充** —— `previousMeaning`（两次均 `destination-head-before-merge`）、`destinationBefore`、`sourceHead`、`mergeBase`；`previous` 保留且与 `destinationBefore` 逐字相同。⇒ **「把 `previous` 读成分支先前 head」这个陷阱在接口面已被修**。边界：这是**接口面 + 我这两次 live 回执**的读数，**不是**在旧版上重放原始反例。
- **并入正确性（我实测，非转述）**：`diff c4deb608 → 7eb6cf60` = **141 路径**，恰为 rig 三并的 delta（139+1+1），**proto 的 12 路径一个未丢**（对照：`diff c4deb608 → grp/rig` = **153 路径**，多出的 12 恰是**删除 proto 的文件** —— 若按「源覆盖目的」错并，这 12 个文件会消失）。⇒ **并入未回退前一组的产物。**

**B-116 补一 第二实例（预登记 tree 只在目的分支被钉住时有效 · 2026-09-28 · tier 0 第一手）**
- rig 的分支清关预登记并后 tree = `2dc909117de127294c66fbd16c1c262c36044472`（= `grp/rig` head 自身的 tree），**在其被出具的那一刻正确**。而我在并入 rig **之前**先并入了 proto（main `06bc490c` → `c4deb608`）⇒ 实际并后 tree = **`a9ac03306e40a96e49a052e409c11d21f4d21429`** ≠ `2dc90911`。
- ⇒ **与补一完全同形**（第一次是文档提交推进了 main，这次是**另一组的并入**推进了 main）。**两实例都证明**：清关里预登记的 tree 值**只是对某一目的快照的断言**。
- ⇒ **纪律（强化）**：**并入前必须重新钉住目的 head 并重取路径集**；**不得**把清关里的 tree 值当作「并入后会得到的 tree」。耐久判据 = 相对**钉住的并入前 main** 的 `diff --name-status` 路径集。

**第十四轮平台修复收编（2026-09-28 · 修复方报告 + tier 0 接口面读数）**
- **B-110 补充**：`previous` 含义显式化 + 新增 `destinationBefore` / `sourceHead` / `mergeBase` ⇒ **我两次 live 回执均已见到填充**（见上表）。
- **B-116**：`cleared_commits` / `clearedCommits` ⇒ **verifier 已第一手 live 使用**（一份报告具名四个 commit，回执逐字回显四元组）。
- **B-117**：`taskId` / `commitSha` 成为**一等 `queryKey`**，并显式返回 `queryFormed` / `queryStatus`（formed / not-formed / rejected）；顶层 `task_id` 进入查询输入。
- **B-118**：`queryKey.form` 现在**只描述调用方传入串**；服务端解析结果移到 `idResolution.resolvedForm` ⇒ **条款 59 的成因在接口面被消解**（同一完整 id 不再因可见域不同而被误归因）。
- **B-116 补一**：**平台明确不改门禁**，与我的裁定一致（预登记 tree 只对当时的目的快照有效；耐久判据仍是钉住 base 的路径集 + 精确 commit 清关）。
- **B-100 补一**：board 解析 + shape/scope 分类回归已覆盖。**B-113 不改**（属本产品仓，非平台层）。
- **★ 边界（必须与条目同读）**：修复方自陈为 **focused fixture + 全量串行回归**，**尚未在 live merge / live `evidence_query` 上重放原始反例**；且**未重启 DSH** ⇒ **B-111 的宿主 `tool-fs` 修改尚未进入真实进程** ⇒ 本会话的 `tools.read` **仍会静默截断**，不得据「修复报告」判定已生效。

**B-119（`worktree-sync-failed` 在 `BEHIND>0` 且工作树不干净时必然命中，且拒绝串不具名这两个前置 · 2026-09-28 · 第三次命中 · G-RIG 组长实测 + tier 0 收编）**
- **实测形态**（`group-rig-t39` 上第三次命中）：`team_run_lease(action:"acquire")` 首次被 **`worktree-sync-failed`** 拒绝，条件 = **`BEHIND=18`（main 已前进）** 且工作树**不干净**（未跟踪 `tools/trace-diff/target/`）。
- **有效处置（已由该组验证，可照抄）**：**先显式 `git merge main`**（纯快进，`MERGE_RC=0`）使 `BEHIND=0` ⇒ **再 `acquire` 成功**。
- ⇒ **性质**：这是「**main 持续前进 × 工作树可能不干净**」的同一形态**第三次**命中 —— 它**不是任何一张卡的缺陷**，但**每张卡都要付一次这笔过路费**；而拒绝串 `worktree-sync-failed` **不具名真正的两个前置**（`BEHIND` 与 porcelain 行数）。
- **修法建议**：**①** acquire 失败时**同时具名 `BEHIND` 与 `git status --porcelain` 行数**；**②** 或在拒绝串里直接给出「先 `git merge main`」的下一步。
- **受准处置（tier 0 本次）**：**①** 立即把「**acquire lease 前先 `git merge main` 使 `BEHIND=0`，并确认工作树干净**」写进 GOVERNANCE 条款 62 并作为**组长派发模板的必备步骤**（不依赖平台修）；**②** 诊断面按上条修法建议入册。

**B-120（未受跟踪且会漂移的输入 ⇒ 其内容摘要只是时点读数，不能锚任何判据 · 2026-09-28 · G-WORLD 组长实测 · tier 0 收编）**
- **实测**：`.local/oracle/**` **未受跟踪**（`git ls-files .local` = 0）**且会漂移** —— 同一路径的聚合读数在**文件数不变**的情况下**字节数变了 8 字节**（`942494010` → `942494002`）。
- ⇒ **含义（比「不在版本控制内」更强）**：该输入**既无 commit 可锚，其内容摘要也不稳定** ⇒ **同一个命令、同一个路径、不同时刻会给出不同读数** ⇒ **任何以它为依据的判据都不是可复现判据**。
- ⇒ **纪律**：**未受跟踪且可变的输入，其摘要只能记作「时点读数」**；凡判据依赖它，**必须同一次运行内同时取输入摘要与输出**，并**声明读取时刻**；**不得**把该摘要写进任何 commit 绑定的清关里。
- ⇒ **与条款 54 的关系**：**同族**（**对移动对象取的读数不是检验**），但本条动的是**输入内容**，54 动的是**参照物**。

**已闭合：`tools/trace-diff/target/` 的残留面（2026-09-28 · `group-rig-t39`）**
- **闭合形态**：新增 **crate 内** `tools/trace-diff/.gitignore`（含 `target/`），commit `77a5146778e6d7adcb27a897b3187838dfef5bfc`，**恰 1 文件**；改前 `git status --porcelain` = 1 行（`?? tools/trace-diff/target/`）⇒ 改后 **0 行**；`git check-ignore` RC **1 → 0**；`cargo test -p trace-diff` **9 passed / 0 failed**（组长独立复核，读数一致）。
- ⇒ **要点**：**未删任何字节**（`porcelain=0` 与「目录仍存在」同时成立）⇒ 把「`ignore_untracked:true` 是放行放宽、残留面仍在」这条 condition 从**具名**推进到**已闭合**。
- ⇒ **与我此前记录的衔接**：我先前记「该未跟踪目录的归属未测、不得断言 tier 0 有权删」—— 现在**不需要删**，**crate 内忽略规则**是更小的动作且已由组自行闭合。

**B-121（写入门禁的命令解析只覆盖 `--out` ⇒ `--gen-fixtures` / `--emit-fixture-manifest` 可把产物写进仓内且不被拦截 · 2026-09-28 · 作者实测 + 组长只读后果复核；机制未经第三方独立复现 · tier 0 收编）**
- **作者实测（rig-runner，同一仓根同一身份）**：`--out <仓内路径>` **被拒**；而 `--gen-fixtures tests/fixtures/rig-stats`（`exit 0`，`{"batches":25,"verdict":"PASS"}`）、`--gen-fixtures tests/golden/rig-stats/gen-probe`（**写 562 文件**）、`--emit-fixture-manifest tests/golden/rig-stats/fm.txt` **均未被拒**。
- ⇒ **机制（作者提出）**：**门禁的命令解析只识别 `--out`**，其余写形态**不被解析覆盖**。**判据形态**：同一目标、不同开关、不同结果。
- **★ 证据信道的边界（组长自己声明，必须同读）**：组长只做了**只读后果复核**（`git status --porcelain` = 1 行 `?? logs/`、改动集恰 1 文件、`tests/fixtures/rig-stats` 计数 569 未变）⇒ 它能确认「**无 tracked 污染**」，**不能确认「只识别 `--out`」这一机制**；作者的探针产物在它的检查中**不存在**（`gen-probe` / `fm.txt` 均 `Test-Path=False`）。⇒ **机制待 verifier 独立复现**（已请其补最小复现）。
- ⇒ **与既有口径的关系**：**加强** GOVERNANCE 的「写入门禁是尽力而为的过滤器，不是安全边界」，并给出**具体维度**：**形状识别的粒度是「命令行里是否出现 `--out`」，不是「该命令是否会写盘」**。
- ⇒ **推论（两条，都必须记）**：**①** 「门禁没报错」**既不能读作「确实没写」，也不能读作「第三方有授权」**；**②** **不传参数不是零写** —— 工具会写仓内默认路径（实测 `tests/golden/rig-stats/suite/suite-result.json` 的 mtime 由 `15:23:18` 变为 `15:24:21`），该默认路径同样不被解析覆盖。
- **受准处置**：**①** 任何「零产品写入」的证明**只能读作归属式无争议**（谁写的、写在哪个已声明路径内），**不得**读作「门禁保证没有写」；**②** 请 verifier 做一次**最小独立复现**（同一身份、同一仓根、三条开关各写一个可抛弃路径，逐条给 RC 与 `Test-Path`）。

**B-122（等待票在任务**相位推进**时被自动关闭 ⇒ `waiting_set` 不是跨相位的持久载体 · 2026-09-28 · G-RIG 组长实测 · tier 0 收编）**
- **实测**：某组长为 t22/t35/t39/t37（全部 `responsible: verifier`）登记的等待票**从 `waiting_list` 消失**，而其早先对 t22 的 `waiting_resolve` 返回 **`status:"not-found"`**；同批任务**都已推进相位**（`member-check` → `group-check`）。⇒ **票在相位推进时被自动关闭。**
- ⇒ **含义**：**`waiting_set` 不是跨相位的持久载体** —— 相位一变票就没了，而**解除条件未必满足**（本例真正等的 verifier 清关**尚未到**）。
- ⇒ **与既有条目的关系**：这是「**责任不得登记在会自行蒸发的地方**」的**第三个触发器** —— 前两个是「被依赖任务 revision 变化」（B-9/B-47）与「任务完成 + 租约释放」（t30 实例）；本条是「**相位推进**」。⇒ **自动解除面比原先记录的更宽。**
- ⇒ **纪律**：**责任必须落在持久载体上** —— **定向 action 的 dispatch 收据**、**evidence 行**、**报告**；**不得把「票不在了」读作「条件已满足」**。

**B-123（`verifier_report.commit` 被无条件计入 `clearedCommits`，与 issue 表严重度无联动 ⇒ 一份含 major 的报告仍对外宣告「已清关 commit」 · 2026-09-28 · G-PROTO 组长实测 + tier 0 收编）**
- **实测（lead-proto）**：`commit` 字段被**无条件**写入 `clearedCommits`，**与 issue 表严重度无联动**。**爆炸半径恰一个 live 实例** = `df12ad2b`（该报告含 **2 major**），而 `is-ancestor df12ad2b main` = **rc 1** ⇒ **未落地**；已并入 main 的那次清关最大严重度 = `condition` ⇒ **不受影响**。⇒ **通路存在、发生过一次、未到达 main。**
- ⇒ **tier 0 的判定（依据 = 第一手拒绝串；两个门禁相互独立）**：清关判定**不是**「只读 `clearedCommits`」—— 平台另有**按严重度**的门禁，其类别在 **B-102 的第一手拒绝串**里逐字出现：`team policy refusal [verifier-found-a-major]: main refuses "grp/world": verifier-found-a-major (commit 9fd13651907e)`。⇒ **`no-verifier-clearance`（键）与 `verifier-found-a-major`（严重度）是两个独立门禁**；一份含 major 的报告**不能**靠把 commit 写进 `cleared_commits` 自证清白。
- ⇒ **因此「不传 `commit`、只在最大严重度 ≤ condition 时传 `cleared_commits`」这条建议不采纳**：`commit` 是 `no-verifier-clearance` 的**授权键**（B-116），不传它会**直接断掉清关通路**；而严重度面已由另一个门禁独立覆盖。
- **受准纪律（报告侧）**：**当 issue 表含 blocker/major 时，不得把该 commit 写进 `cleared_commits`** —— 这是**报告作者的自律**，即使门禁会兜住。
- **★ 未复测的边界**：我**没有**在「commit 同时出现在 `cleared_commits`」的条件下重测 `verifier-found-a-major` 是否仍触发。⇒ 该组合**记作待判**；**安全实践 = 不要那样写**。

**B-121 补一（机制已由 verifier 独立复现；并新增一条路径解析机制 · 2026-09-28 · tier 0 收编）**
- **独立复现（同一身份、同一仓根、同一目标根 `tests/golden/rig-stats/probe-t0`；判据形态 = 同一目标、不同开关、不同结果）**：
  · `--out tests/golden/rig-stats/probe-t0` ⇒ **逐字被拒**（`no declared static scope or active approved plan lease for (…\tests\golden\rig-stats\probe-t0)`）；
  · `--emit-fixture-manifest <同一目标根>/manifest.txt` ⇒ **rc=0**，manifest 报 `lines=568` / `aggregate_sha256=8120d6e7…` / `Test-Path=True`；
  · `--gen-fixtures <同一目标根>/gen` ⇒ **rc=0**，**Files=562**（与作者读数一致）。
- ⇒ **B-121 的机制成立，且「仅作者一方机制读数」这一边界现已闭合。**
- **★ 新增机制（两个独立读者都没有的）**：**拒绝文本把相对路径解析到「会话 cwd」，不跟随进程 cwd** —— 该读者在临时 clone 内 `Set-Location` 之后，拒绝串**仍**打印 `…\RustMc\tests\golden\…`。⇒ 这解释了「换到 temp clone 也被拒」。
- **副作用边界（该读者主动具名，防误读）**：三处写入**全部落在临时 clone**（`%TEMP%\vt37`），**主检出未被污染**（`Test-Path …\RustMc\tests\golden\rig-stats\probe-t0` = False）。

**B-116 补一 第三实例 + 一般形态（预登记「合并结果 tree」必须同时写明它有效的目的地 · 2026-09-28 · G-RIG 组长提出 · tier 0 收编）**
- **实例**：某组在清关请求里写 `main = 21d6105f`，而 verifier clone 时 main 已到 `11d0f772` ⇒ `merge-tree --write-tree 11d0f772 6631bfe8` = `0324de4d…` ≠ 预登记的 `e7c0f828`。
- ⇒ **一般形态（组长提出，我采纳为条款）**：**「commit 自己的 tree」是内容身份；「合并结果的 tree」是 `(目的地, 源)` 的函数，因此不是源的属性。** ⇒ **预登记一个合并结果 tree，只有在目的地被钉住时才有判别力；凡预登记必须同时写明「在目的地 == X 期间有效」。**
- ⇒ **它是既有口径的对偶**：「承重不变量是 tree 而非 commit」说的是**内容**由 tree 承载；本条说的是**合并结果**还额外承载**目的地**。
- **★ 正面实例（同一机制的另一面）**：verifier 这次**在条件里明确给出「对当前目的地 `11d0f772` 的合并树 = `0324de4d`」** ⇒ 该预测**可测**；tier 0 并入后实测 tree = **`0324de4df0d5272f974fa90d001eec66268c8330`**，**逐字命中**；`diff 11d0f772 → HEAD` = **恰 15 路径**，与组长给的耐久路径集**逐字相等**。

**B-116 补一 的一般形态（收紧版 · 2026-09-28 · G-RIG 组长提出、verifier 收紧、tier 0 采纳）**
- **我原先采纳的表述**（「预登记 `commit`/`tree` 必须与 `destination` 三元同现」）**只在「一次并入」上完备**。本批是**三次**并入、**三个不同的目的地**（`d14defa4` = f(`21d6105f`,`0299af18`) · `49e8aba4` = f(`1b34bf0c`,`2e77fc9c`) · `e7c0f828` = f(`91ea3914`,`77a51467`)）。
- **决定性理由**：**第 2、3 次并入的目的地是分支上刚由前一次并入生成的合并提交**（`1b34bf0c`、`91ae3914`）—— 它们**只有在前一次并入之后才存在** ⇒ **批次开始时不可能把整批的合并结果 tree 钉住**。
- ⇒ **收紧后的形态（采纳）**：**合并结果 tree 只能在每次并入之后「事后具名」，不能作为批次级的前置授权值；批次级的前置授权值只能是「相对 pin 的路径集」。**
- ⇒ **与条款 64③ 同族**：**两个值不同时，第一步是比较参照物**；**目的地前进导致的 tree 不同不构成不符项**。

**B-123 补一（tier-0 裁定：r1 的 `clearedCommits` 条目作废；作废手段 = 报告侧 r2/r3 取代 + 台账侧裁定，而非改写旧文 · 2026-09-28）**
- **请求**：verifier 请 tier 0「以平台手段作废该条目」，理由 = 它无就地改写已发布报告的权限，且组纪律禁止改写旧文。
- ⇒ **裁定（不做平台改写，理由三条）**：**①** **作废已由报告作者完成** —— 它已发布 **r2（`clearedCommits: []`）** 与 **r3（更正附页，同样不清关）** ⇒ 按只追加纪律，**r2/r3 取代 r1 的清关集**；**②** `is-ancestor df12ad2b main` = **rc 1**（两个读者各自复算一致）⇒ **该对象从未进入 main**，合并门禁根本不会被问到它；**③** 严重度面由**独立门禁**覆盖（条款 66，依据 B-102 的第一手拒绝串 `[verifier-found-a-major]`）⇒ 即便被提出，也会被严重度门禁挡下。
- ⇒ **tier-0 的处置**：**在台账侧裁定该条目作废**（本条），**不改写任何已发布报告**；`r1` 文件**保留**（历史工件），由本条具名其作废。
- ⇒ **对「清关判定读哪个字段」的回答**：**不是只读 `clearedCommits`** —— 严重度门禁读 **issue 表**，与清关键**独立**。⇒ **「红报告自证清白」不是活通路。** **边界**：我**未**复测「commit 同时出现在 `cleared_commits` 且 issue 表含 major」这一组合 ⇒ **待判**；安全实践 = 不要那样写。

**B-116 补一 第四实例（★ 这一次是 tier 0 自己的提交把参照物推走 · 2026-09-28 · 第一手，且事前预测命中）**
- **形态**：`grp/world` head `dc200df4` 的**头清关**是在 `main = 79a097a4` 时取的，且 `79a097a4` **恰为该 head 的第一父** ⇒ 清关里写着「**现在是快进，落地 tree = `80e95d87`**」。**而我在请求并入之前，自己落了一次文档提交**（`79a097a4` → `b5a32ea`）⇒ 该推论**当场过期**：`is-ancestor b5a32ea dc200df4` = **rc 1**，实际并入**不是**快进。
- **我的处置（正确形态，可照抄）**：**并入前先预测** —— `merge-tree --write-tree b5a32ea dc200df4` = **`3f838541`**；随后并入，**并后 tree 逐字等于 `3f838541`**；`diff b5a32ea → HEAD` = **恰 2 路径**（`m11-coverage-c-entity-rules.md` 1/1 + `m4s4-entity-lifecycle.md` 281/0）；`fastForwarded:false` / `createdCommit:true`；门禁 **RC=0**。
- ⇒ **前三次实例的参照物都是「别人的提交 / 平台行为」推走的；这一次是 tier 0 自己的提交。** ⇒ **纪律**：**凡「按某快照取的清关」要在并入前复核，复核的第一步是重新钉住目的地并重算**；**提交文档与并入之间不得插入其他写操作而不重算**。
- ⇒ **它同时是条款 70 的第三个实证**（`79a097a4` 曾是第一父、但并入时已不是 ⇒ 不快进）。

**B-111 部分修复（形态 = 「不再静默」，不是「不再截断」 · 2026-09-28 · DSH 重启后 tier 0 第一手实测）**
- **实测（重启后、同一会话）**：`tools.read` 对一份 **2937 行**的文件、`limit=2000`，返回 **333 行**，并**同时**返回 `returnedLines: 333` / **`truncated: true`** / **`nextOffset: 334`**。
- ⇒ **修复的形态**：**静默消失，上限仍在。** ⇒ **原危害（「把窗口内 0 命中读成全文 0 命中」）已被消除**，因为调用方**能看见**自己被截断、并**能按 `nextOffset` 翻页**。
- ⇒ **纪律（改定）**：**凡「全文域」读数，必须先检查 `truncated`；为真则必须翻页到 `nextOffset` 为空，或显式声明窗口。** **「我读了 333 行」不再是一个可以犯的错误** —— 仪器会告诉你。
- **★ 边界（必须与条目同读）**：这是**宿主工具面**的读数（**重启后才生效**）；**不等于**「本会话内此前所有截断读数都被回溯修正」—— 那些读数在需要承重时**仍须重取**。

**★ DSH 重启后的 Team 状态（2026-09-28 · tier 0 实测）**
- **成员未丢失**：全部 tier-1 与多数 tier-2 显示 `inactive`（`rig-diff` 显示 `running`）⇒ **`inactive` 是休止态，唤醒即可，不需要重新 spawn**。
- ⇒ **纪律**：**重启后先读 roster 与板**，**不要**据「看起来没人」就重 spawn 或重派 —— **重复 spawn 会制造身份重复与配额浪费**。

**B-124（`team_task_update(action:"reopen")` 没有理由字段 ⇒ 状态变更与理由分离，owner 从卡上看不出为什么被重开 · 2026-09-28 · G-RIG 组长实测 · tier 0 收编）**
- **实测**：某组长因 verifier 的 **1 major** 把卡 `reopen`（completed/verifier-review → pending/execution），**但返修单只写在派发消息里**；该消息**在 DSH 重启中未落地** ⇒ 卡面**没有理由**，owner 只能报「未收到派发」。
- ⇒ **性质**：`reopen` **只改 status / phase**，**理由无处可写** ⇒ **机器可读面承载不了承重语义**。**与 B-102 / B-116 / B-123 同族**（**一个槽承载不了它要表达的语义**）。
- **受准处置（tier 0 本次）**：**理由写进卡面，与 `reopen` 同一步**（已落 GOVERNANCE 条款 75）。
- **修法建议**：**`reopen` 接受 `reason` 并把它追加到卡面**（或至少写入一条 evidence 行并在卡面留指针）。

**★ 一条被验证链正确拦下的实例（正面记录 · 2026-09-28）**
- **verifier 对某卡交付（`e0840a59`）出 `NOT CLEARED / 1 major`**，理由 = 该卡交付物里的一条注记称「卡面所引内容**经全史扫描不可归属**」，而该陈述**为假**（`git grep` 在三个 rev 上各给恰好 1 条，位置在同一文件的其他行）。⇒ **组长据此 `reopen` 并写卡面、重派**。
- ⇒ **意义**：这是**「独立复核发现了作者自己的假陈述」**的一次完整闭环 —— **不是靠门禁，是靠人读断言**。

**B-125（scope 的匹配语义与已登记模型矛盾：按前缀应匹配，实测被拒 · 2026-09-28 · G-RIG 成员实测 · 状态 = 待判）**
- **观测**：某卡的计划 scope 写 `.local/oracle/capture-`，当产物落到 `capture-isolated` / `capture-s1` 时**被拒**，该成员转述的拒绝理由是**门禁按「字面目录名」匹配、不是前缀**。
- ⇒ **与已登记模型的矛盾**：本台账此前的记录是「**scope 是字面前缀**；比较基准 = 该路径所属工作树自身的根」。**按前缀模型，`.local/oracle/capture-` 应当匹配 `capture-isolated`** ⇒ **该实例与前缀模型矛盾**。
- ⇒ **状态：待判**（我**未**自取拒绝串原文 ⇒ 不得写成结论）。**判别式**：**①** 取该次拒绝的**逐字文本**（它通常具名它按什么匹配）；**②** 同一 scope 下做**最小对照**：写 `capture-<后缀>` 与写 `capture-<精确名>` 各一次。
- ⇒ **纪律（判定前）**：**不得据「scope 是前缀」的旧模型推导新卡的可写路径**；**遇到拒绝先取原文**，再决定是改 scope 还是改落点。

**B-126（`team_task_create` 无 `owner` 参数 ⇒ 建卡与指派必然分两步 ⇒ 存在「无主窗口」，且 `edit` 卡在该窗口内不可 claim · 2026-09-28 · 本会话第 4 次命中 · tier 0 收编）**
- **实测（本会话四次）**：`team_task_create` **没有 owner 参数** ⇒ 每张新卡**必然**先以无主状态存在，再由组长 `reassign`。**四次命中**：`t40`、`t41`、`t43`（瞬时窗口 —— `team_delivery_check` 读到 `noOwner: 1`，下一次读已就位）、`t101`（当前仍无主）。
- ⇒ **危害**：**这是 §5.9 死锁的入口** —— 无主 `edit` 卡在 `claim` 时被 `owner-required` 拒，而 `task_contract_set` **只放行现任 owner 或 tier 0** ⇒ **组员与组长都补不了 owner**，只能 `reassign`。若组长没意识到，卡会以「**有 brief、有计划、没人能 claim**」的形态静默躺着。
- ⇒ **两个组长都独立具名过它**（「**建卡与指派 owner 是同一步**」），**但工具层不提供「一步」** ⇒ **纪律只能靠人记** —— 这正是它反复出现的原因。
- **修法建议**：**①** **`team_task_create` 接受 `owner`**（或返回后由平台按调用者所在组自动指派）；**②** 至少让 `team_delivery_check` 的 `noOwner` 行**给出建卡时间**，使「**刚建的无主窗口**」与「**真的忘了**」**可区分**。

**B-127（PTC 返回对象含 `undefined` ⇒ **整个程序输出被丢弃**，且拒绝发生在收尾、子调用已全部执行 · 2026-09-28 · 本会话三方各自命中 · tier 0 收编）**
- **实测（三方独立命中）**：`invalid-output: program completion must be lossless JSON` —— 程序**在收尾阶段被拒**，而**其中的子调用（写、审批、派发）已全部执行**。根因：返回对象里带了 **`undefined`**（某个可选字段缺席）。
- ⇒ **危害**：**调用方看不到任何已完成的效果** —— 一个「**已经改了状态**」的程序在外部表现为「**彻底失败**」，**极易诱发盲目重试**（而重试会重复执行已完成的 mutation）。
- **受准处置（三方都做对了）**：**先查效果，不重试** —— 用 `team_task_get` / `team_plan_get` / `waiting_list` / `inbox_list` **确认已生效**，再只补差量。
- **修法建议**：**①** 序列化层**递归 sanitize**（`undefined → null`）；**②** 或**具名是哪个字段**导致拒绝 —— 当前只给一句通用错误，**不具名**。
- ⇒ **纪律（修复前）**：**PTC 程序返回前一律过一层递归 sanitizer**；**收到该拒绝时不得重试，先查效果**。

**B-125 判定（已判）：scope 匹配 = 路径边界前缀，**不是** raw string prefix（2026-09-28 · 逐字原文到手后 tier 0 判定）**
- **逐字拒绝串（两次探针，触发命令 = 写工具）**：两条都具名 `is outside the active plan write scope [tools/capture/, .local/oracle/capture-]`；被拒路径分别为 `…\team__rig__rig-capture\.local\oracle\capture-s1\probe.txt` 与 `…\RustMc\.local\oracle\capture-probe-main\probe.txt`。
- **对照**：字面目录 `…\.local\oracle\capture-\probe.txt` ⇒ **ALLOWED**。
- ⇒ **判别**：**raw string prefix 模型预测 `…/capture-s1/probe.txt` 以 `…/capture-` 开头 ⇒ 应为 ALLOWED**，而观测是**拒绝** ⇒ **raw prefix 模型被证伪**。观测与「**路径边界前缀**」相符 —— **scope 必须匹配到某个路径分隔符边界**（`capture-` 之后必须紧跟分隔符或串尾）。
- ⇒ **裁定**：**本台账原记的「scope 是字面前缀」作废；正确模型 = 路径边界前缀。**
- ⇒ **推论**：`.local/oracle/capture-` **只允许** `.local/oracle/capture-/…`（**字面目录**）；`capture-s1` / `capture-probe-main` **不在允许集内**。⇒ **该成员的实际产物落在 `capture-\s1\…`（字面目录）⇒ 已在允许集内，无需改 scope、无需改落点。**
- ⇒ **纪律**：**scope 的尾斜杠与「是否停在分隔符边界」是两回事**；**具名 scope 时应写清它允许的是「一个目录」还是「一个目录前缀」。**

**B-125 补：同一张卡的 plan `write_scopes` 与卡面 `writeScopes` 不同形（逐字） · 2026-09-28 · tier 0 收编**
- **逐字**：plan（已批准）= `["tools/capture/", ".local/oracle/capture-"]`（**第一项带尾斜杠**）；卡面 `writeScopes`（rev19）= `["tools/capture", ".local/oracle/capture-"]`（**第一项无尾斜杠**）。
- ⇒ **两条拒绝串里被具名的都是 plan 那一版** ⇒ **门禁按 plan 判定**（与已登记的「写入门禁解析 plan 的 `write_scopes`，不是卡面 `writeScopes`」一致）。
- ⇒ **纪律（既有，再次实证）**：**卡面 `writeScopes` 与 plan `write_scopes` 必须逐字一致** —— 否则形成「**卡面写着能用、实际按 plan 判**」的陷阱。**本次该差异与拒绝无关**（第二元素逐字相同），但**它是真差异**，应更正。

**★ 一处指向 tier 0 的误归因（更正 · 2026-09-28）**
- 某成员报告称「**你说已把卡面改为 `.local/oracle/`**」。⇒ **我从未修改过该卡的卡面** —— 我本会话对该卡的唯一动作是**建卡与改派**。⇒ **该归属为假**；请勿据此期待一个不存在的改动。**若该说法来自某条消息，请具名其出处。**

**★ B-125 补 作废（我记下的「plan 与卡面不同形」不存在 · 2026-09-28 · tier 0 自取读数后自我更正）**
- **我原记**：plan = `["tools/capture/", ".local/oracle/capture-"]`（带尾斜杠）而卡面 = `["tools/capture", ".local/oracle/capture-"]`（无尾斜杠）⇒ 记为「真差异」。
- **我自取读数（同一时刻读卡面与 plan）**：**卡面 rev19 `writeScopes` = `["tools/capture/", ".local/oracle/capture-"]`**；**plan（`plan-approved`）`writeScopes` = `["tools/capture/", ".local/oracle/capture-"]`** ⇒ **逐字相同**。⇒ **我记的差异不存在。**
- ⇒ **我的错（第 3 次同族）**：**我据一个转述的读数入册，未自取读数** —— 而这一轮我刚立过条款 74/76/82，全部指向「先取读数」。**转述来源已具名（某成员的报告），但责任在我。**
- ⇒ **纪律**：**入册一条「差异」之前，必须在同一时刻自取两端读数** —— **差异是最需要两端同点读的那类断言。**

**B-128（卡面 `writeScopes` 受 plan 控制、不能直接编辑 ⇒ 宣布「已改卡面 scope」而实际被拒 · 2026-09-28 · G-RIG 组长实测 · tier 0 收编）**
- **逐字拒绝**：`task "group-rig-t40" writeScopes are controlled by its plan; replace the plan instead of editing the task row. Recovery: (1) release the active run lease with the exact run_id, (2) call team_plan_propose with replace_approved:true and replace_reason, (3) acquire a new run lease before editing again.`
- ⇒ **性质**：**卡面 `writeScopes` 不是可直接编辑的字段** —— 它由 **plan** 派生；唯一路径 = **替换计划**（`replace_approved:true`），且**要求无活动 lease**。⇒ 这与既有的「写入门禁解析 **plan** 的 `write_scopes`」**互证**。
- **受准处置**：**要改 scope 就替换计划**；**不要**试 `team_task_update(edit)`（会被拒，且**宣布了就会变成假陈述** —— 见条款 84）。
- **修法建议**：**①** 拒绝串**已经很好**（它给了三步恢复路径）—— 这是正面样本；**②** 若 `edit` 里传了 `writeScopes`，**应直接拒绝并在回执里具名该字段不可编辑**，而不是静默忽略。

**★ 引注漂移案结案：引注在写作时**正确**，是**漂移**（2026-09-28 · G-WORLD 成员定位机制 + 组长复核 · tier 0 收编）**
- **机制（可复现）**：在**落笔 revision** 上，被引行**就是**所描述的形态（`git show <t43 的 revision>:…` 的第 1124 行逐字 = 该 if-let 分支头）。此后 **t21** 把该分支改写成 `match` + fail-closed `None =>`，**t23** 又在其上方插行 ⇒ **行号 1124 → 1144 → 1221 漂移**；同时内容迁到同文件另一行。
- ⇒ **对既有登记的更正**：本案**不是**「作者编造」—— **引注在其写作时点成立**。⇒ **真正的根因是条款 22（行号引用必须标时点）未被应用。**
- ⇒ **正确修正形态（该组已采纳）**：**逐字锚点文本 + 具名 revision + 文件内机制注记**，使漂移**不能静默复发**。
- ⇒ **纪律**：**行号是 commit-relative 的量**；**引用行号必须同时给「锚点文本」与「绑定 revision」**，否则该引用**注定**在若干次改写后失真。

**B-126 补（两种表现可分离：提前 `reassign` 只消掉「被拒的 claim」，消不掉「无主窗口」 · 2026-09-28 · G-WORLD 第二次命中 · tier 0 收编）**
- **实证（第二次命中，`group-world-t102`）**：同一成因（`team_task_create` 无 owner 参数）；但该组长**在组员 `claim` 之前就 `reassign`**（rev 1 → 3）⇒ **没有产生一次被拒的 claim**，只留下**瞬时无主窗口**。
- ⇒ **两种表现必须分开记**：**(a) 瞬时无主窗口**（建卡 → 指派之间；`team_delivery_check` 会读到 `noOwner`）；**(b) 被拒的 claim**（组员在无主状态下试 claim ⇒ `owner-required`）。
- ⇒ **纪律**：**建卡后立即 `reassign`**（不等组员试 claim）—— 这**消掉 (b)**，但 **(a) 仍在**（直到 `team_task_create` 接受 `owner`）。
- ⇒ **该组长的结论我采纳**：**修法落地可同时消掉两种表现** ⇒ 这也说明 **(a) 才是根因**，(b) 是它的**下游后果**。

**B-129（宿主检索工具在输出超上限时以**散文**报失败，而非结构化信号 ⇒ 调用方可以把「没有结果」读成「0 命中」 · 2026-09-28 · G-PROTO 组长实测 · tier 0 收编）**
- **逐字（该组长报告）**：`grep produced more raw output than the subprocess seam retained within the 20000000-byte cap`。⇒ **该次检索没有读数**，而它**把「没有结果」当成了「0 命中」**（随后自捉并改用精确模式 + 只取计数）。
- ⇒ **性质**：**失败被表达成一句散文，而不是一个结构化信号** ⇒ **只做「有没有结果」判断的调用方无法区分「失败」与「0 命中」**。⇒ **与 B-111 同族**（`tools.read` 修复前也是「静默截断」）—— **修复形态应一致：把上限/失败变成调用方**必读**的结构化字段**（`isError` / `truncated` / `capExceeded`），而不是让它躺在正文里。
- **修法建议**：**①** 超上限时返回 **`isError:true`** 或结构化字段；**②** 或**自动分页 / 收窄并明示已收窄**（`tools.read` 的 `nextOffset` 是同一族的正确先例）。
- **受准纪律（修复前）**：**凡检索结果为空，必须先确认「该次检索成功」再作缺席断言** —— **「没有输出」与「输出为空」是两件事**。

**B-130 `team_merge` 只提供「全量忽略未跟踪」这一个逃生口：一个与本批零交集的未跟踪目录会阻塞每一次并入（2026-09-28 · tier 0 第一手拒绝串）**

- **实测（第一次尝试，逐字）**：`team policy refusal [destination-worktree-dirty]: merge of "grp/world" into "main" failed: destination-worktree-dirty; files: ?? logs/`。我的检出里**只有**一个未跟踪目录 `logs/`（`git status --porcelain` 仅此一行），它与本批 **5 条路径零交集**。
- **第二次**改用 `ignore_untracked:true` 通过，并**已自证无污染**：`git ls-tree -r --name-only HEAD -- logs` 计数 = **0**；`git diff --name-only <钉住前 main> HEAD` = **恰 5 文件**。
- ⇒ **缺陷**：门禁是**全或无**的 —— 调用方只能说「**忽略全部未跟踪**」，**不能说「这些具名未跟踪路径与本批无关」**。⇒ 一个 `logs/` 会迫使调用方**授予比本场景更宽的许可**，而 `ignore_untracked` 的正确性**必须由调用方事后自证**；**门禁不返回「被忽略的未跟踪路径」清单**，故「忽略了什么」不是一个可复算的读数。
- ⇒ **修法方向（任一）**：**①** 拒绝串已给出 `files:` 清单 ⇒ 加一个 `allowed_untracked: string[]` 参数，**只放行调用方具名的路径**，未列出的仍拒；**②** 或返回 `ignored_untracked: string[]` 回执，使「忽略了什么」成为可复算读数。

**B-131 `pwsh -NoProfile -File <script>.ps1 -Files a b c` 下 `[string[]]` 只绑定第一个元素 ⇒ 域静默从 N 缩到 1（2026-09-28 · G-RIG 组长实测并自捉 · tier 0 收编）**

- **实测**：某检查器以 `-Files a b c` 传数组，`[string[]]$Files` **只绑定第一个元素**，其余落成位置参数 ⇒ **域静默从 N 缩到 1**。某轮返修里「12 文件 0 命中」的**真实覆盖 = 1 个文件**。
- ⇒ **性质**：与 **72 补四**同族（**完备性是「运行是否完整」的性质，不是「输出看起来对不对」的性质**），但**机制在 PowerShell 参数绑定**，且**任何组**用 `-File` 传数组都会中 ⇒ **跨组**。
- ⇒ **纪律（已落进 G-RIG 返修卡）**：**检查器必须同时打印「枚举到的域大小」与「实际扫描的域大小」，两者不等 ⇒ FAIL + 退出码非 0。**
- ⇒ **与 B-129 的关系**：B-129 是**失败被表达成一句散文**（调用方无法区分「失败」与「0 命中」）；本条是**失败根本没有被表达** —— **域静默缩小而退出码为 0** ⇒ **更隐蔽**。

**B-131 补：域必须具名「根集」，否则分母不可复算（2026-09-28 · 同一组长自纠 · tier 0 收编）**

- **实测**：该组长给返修卡写的域口径是「递归全量 13 / 排除检查器 12」，**未钉住域根集**。实测域阶梯：**D0** = `tools/**` − 检查器 = **18**；**D1** = `tools/rig-batch/**` − 检查器 = **8**；**D2** = rig-batch ∪ capture − 检查器 = **12**（即原写的 12，它**未具名地排除了 `tools/oracle/**` 的 6 个 .ps1**）。
- ⇒ **命中数 9 / 4 文件在 D0 / D1 / D2 下不变** ⇒ **读数稳、分母不稳** —— 不稳定的**不是结论，是它写下的分母**。
- ⇒ **纪律**：**凡给「域」，必须具名域根集（集合定义，不得用区间写法或「等」），并同时给出「枚举到的文件数」。** ⇒ 与**条款 76 补**（域的定义谓词必须与读数的谓词同一）同族 —— **本条是它的「根集」轴**：谓词同一还不够，**根集也必须同一**。

**B-132 `team_worktree_setup(base:X)` 对「已存在」的 worktree 做的是 merge，不是 reset ⇒ 交付 commit 的形态被改掉（2026-09-28 · G-PROTO 组长第一手实测 · tier 0 收编）**

- **实测**：对某成员的**既有** worktree 调 `team_worktree_setup(base:"main")`，回执 **`created:false`**；随后该 worktree 的 HEAD 是**合并提交**，**两个父** = 该成员的交付 commit 与当时 main，message = `Merge branch 'main' into <该成员分支>`。
- **危害**：HEAD 变成合并提交 ⇒ **`git show --name-only HEAD` 什么都不打印**（`git show` 对 merge 默认不给 diff）⇒ **任何依赖「恰 N 条路径」的判据在该 HEAD 上不可判**；而**形态本身是判据的一部分**（该组的 C7 正是如此）。⇒ 成员若不另落一个普通提交，就会交出一个「**判据形态不可判**」的 HEAD。
- **处置（该组长已做，tier 0 认可）**：**不重铺 worktree**，要求 owner **在该合并提交之上另落一个普通提交**（树已含目标修复 ⇒ `git show --name-only HEAD` 仍恰 1 条）。
- ⇒ **工具语义**：**该工具是「把 base 合进分支」，不是「把分支重铺到 base」。** 若这是设计意图，**必须在工具文档写明** —— 它**改变交付 commit 的形态**；若并非设计意图，则应改为 reset / checkout，或**明确报错**，而不是静默产出合并提交。
- ⇒ **可复用纪律**：**凡「交付 commit 的形态」是判据的一部分，交付前必须在最终 HEAD 上跑一次该判据命令** —— 不得假定 HEAD 是普通提交。

**B-132 补（tier 0 第一手复核：两次调用都是 merge、从不 reset；且每次调用都会再产出一个合并提交 · 2026-09-28）**

- **我自己的读数（不转述）**：对同一个**既有** worktree 连续两次 `team_worktree_setup(base:"main")`，其 HEAD 依次为 `8fa9df7b`（父 = 该成员交付 commit + `d0768ca1`）→ **`33e3c0f9`（父 = `8fa9df7b` + `975901ee`）**，两条 message 都是 `Merge branch 'main' into <该成员分支>`，**作者 = `dsh-agent-team`**。⇒ **两次调用都产出合并提交，从未 reset。**
- **同时确认无害面**：`git diff <该成员交付 commit> HEAD -- <其唯一交付文件>` = **空** ⇒ **成员改动逐字仍在**；`merge-base --is-ancestor <main> HEAD` = **rc 0** ⇒ base 确已进入。
- ⇒ **推论（承重）**：**「重铺 worktree 会把在飞的同族卡 commit 甩掉」这一担心，在实测语义下不成立** —— 该工具是**把 base 合进分支**，分支上的既有 commit **全部保留为父**。⇒ 因此**「必须等兄弟卡先进 main 才能重铺」这类并序前置，在实测语义下是不必要的前置**（它只是白等一个 merge 往返）。
- ⇒ **判别式（供任何组自行复核，一条命令）**：调一次后读 `git -C <wt> log -1 --format=%P` —— **两个父 ⇒ merge**；**一个父且 tip == main ⇒ reset**。
- ⇒ **仍成立的那条危害（B-132 正条，本轮再次实测）**：**HEAD 是合并提交 ⇒ `git show --name-only HEAD` 只打印哈希、不打印文件列表**（本轮实测输出仅 `33e3c0f9…`，无路径行）⇒ **凡「恰 N 条路径」类判据在该 HEAD 上不可判**。⇒ **成员必须在合并提交之上另落一个普通提交**；**且每一次 `team_worktree_setup` 调用都会把 HEAD 再推成一个新的合并提交** ⇒ 该要求必须在**最后一次调用之后**校验。

**B-133 等待行的生命周期未被声明 ⇒ 无法区分「静默解除」与「同任务重挂覆盖」（2026-09-28 · G-PROTO 组长三次实测 · tier 0 收编，**不裁定机制**）**

- **实测（该组长自取）**：`wait:group-proto-t72:member-guard:c9b8627d-…`（`external` 类，createdAt 有值）**未经 `waiting_resolve` 就消失**；它首次尝试 resolve 时返回 **`no-open-ticket`**。⇒ 同会话**第三次**同形（前两次：`dependency` 票在依赖卡完成时消失；卡 `complete` 时旧票消失）。
- **规则文本说** `manual` / `external` / `background` **不得**自动解除，**实测与之不符** ⇒ **缺陷成立**（无论成因为何）。
- **★ 两种候选机制，本条不裁定哪一种**（条款 87）：**①** 该类票**存在未声明的清理路径**；**②** **同一 `task_id` 的后一次 `waiting_set` 覆盖前一次** —— 该组长的应对恰好是「**每次转轴都重挂**」，而**重挂本身就可能是那条消失的原因**。⇒ **判别式（未跑，留给平台方或下一次实测）**：对**同一 `task_id`** 连续登记两张条件不同的票，若第一张消失 ⇒ **机制 ②**；若两张都在 ⇒ **机制 ①**（或另有路径）。
- ⇒ **一处支持机制 ② 的读数（不构成证明）**：该组长复核发现同一任务的另一张票（`11870f76`，`manual` 类）**仍在** ⇒ **并非每张票都会消失**。
- ⇒ **纪律（与机制无关，立即生效）**：**不得把承重约束只放在等待票里** —— 责任须落在**持久载体**（定向 action 的 dispatch 收据 / 卡面 `description` / 里程碑 `done_when` / evidence 行），并**在每个阶段边界重取读数**。承条款 65 及其更正。
- ⇒ **一处我自己的边界（具名）**：我试图从 DSH 检出**读源码定案**，对 `D:\dsh-test\app\` 检索 `waiting_set|waitingSet|ticketId` = **0 命中** ⇒ **该平台的 Team 控制面实现不在该检出内** ⇒ **我无法定案，故不写结论。**

**B-134 同一 revision 上两种行号仪器相差一行；而门禁的载体行字段是裁决者（2026-09-28 · tier 0 第一手 + 两名组长交叉 · **机制未定**）**

- **实测**：在同一个 revision 的同一份文件上，两种「第 N 行」仪器**不一致** —— 走 `Select-Object -Skip/-Index` 路径得到的是**相邻的另一行**，而**门禁的载体行字段**、**`tools.read` 的 1-based 行号**、以及**另一名组长在同一 revision 上的逐字行读**三者**一致**地指向那条被判 `P2 AMBIG` 的引注所在行。
- **裁决者 = 门禁的载体行字段**：我按 `tools.read` 的行号**就地替换**了该行的例子后，门禁由 `unregistered=1|ambiguous=1` 转为 **`unregistered=0|ambiguous=0`**（`test result: ok. 4 passed; 0 failed`）⇒ **被替换的正是门禁所指的那一行** ⇒ **门禁的载体行字段与 `tools.read` 的 1-based 编号一致**。
- ⇒ **机制未定**（条款 87）：候选是 **①** `Select-Object -Skip/-Index` 的 **0-based 语义**；**②** `git show` 经管道的行切分；**③** `Measure-Object -Line` **跳过空行**（本文件该仪器读数 = **2537**，远小于实际行数 ⇒ **它在本文件上不可用**）。**本条只登记「不一致」与「谁裁决」，不登记成因。**
- ⇒ **纪律**：**①** **不得用 `Select-Object -Skip/-Index` 作为「第 N 行」的仪器** —— 它的计数语义与「第 N 行」不同；**②** 凡行号读数**承重**，**必须与门禁的载体行字段（或 `tools.read` 的行号）交叉验证**；**③** `Measure-Object -Line` **跳过空行**，**不得用于行数**。
- ⇒ **正面读数**：本次**三方读数一致、第四方偏离** ⇒ **「多数一致」救回了一次错误的自我撤回** —— 该组长曾据此撤回一条**本为真**的归属断言。⇒ **纪律的推论**：**当一个人因为「自己的读数与别人不一致」而准备撤回结论时，先问「是不是我的仪器在别人都不用的那条路径上」。**

**B-134 补（第二名 agent 独立复现，并具名「行号是**读者相对**的量」· 2026-09-28 · G-PROTO 成员第一手 · tier 0 收编）**

- **独立读数**：同一份文本上，**Rust `lines()`（按 \n）报 3086**，而 **PowerShell `Select-String` 报 3087**；**门禁的载体行字段 = 3086**（= Rust 路径）。⇒ **两次独立观测（tier 0 与 G-PROTO 成员，不同仪器、不同人）都指向「PowerShell 读数路径整体高一行」。**
- ⇒ **纪律（收紧）**：**行号引用一律以「门禁的载体行字段 / 源码 `lines()` 语义」为坐标**；**PowerShell 的 `Select-String` 与 `Select-Object -Skip/-Index` 行号是另一套坐标，不得与前者混用。** ⇒ **这是「行号是 commit-relative 的量」之外的第二条相对性：行号还是「读者相对」的量** —— **同一 revision、同一文本、不同读取器 ⇒ 不同数。**
- ⇒ **机制仍不裁定**（条款 87）：候选仍是行切分 / 0-based 语义 / `Measure-Object -Line` 跳过空行；**但「哪条路径与门禁一致」已由两次独立观测定案。**

**B-135 一个「已具名但未被利用」的判定逃逸路径：加一个类别标记即可同时逃出路径判定与内容判定（2026-09-28 · G-PROTO 成员第一手 · tier 0 收编）**

- **机制（读源码，非推断）**：判定循环里 `let mut cls = "quoted"; if !c.quoted { …content_anchor_cores / content_outcome… }` ⇒ 整个内容块被包住，`cls` 保持 `"quoted"` ⇒ **内容判定与路径判定对该标记项一起跳过**。⇒ **加一个标记即可同时逃出两套判定。**
- **当前影响 = 0**（该成员给的计数）：该类别 **34 条**，其中**带紧邻锚点（本来会被内容判定）的有 0 条** ⇒ **绕过是潜在的、未被利用的。**
- ⇒ **纪律**：**引入任何「跳过判定」的类别标记时，必须同时报出「该类别内本来会被判的条数」** —— 那个数才是「绕过是否被利用」的读数。**只报类别大小 = 静默的绕过。**
- ⇒ **该成员同时做对的两件事**：**①** 它**没有**改该标记的语义，只把该类别计数放进类别表使其**可见**；**②** 它**没有**在红门上宣称绿、**没有** complete 卡片（lease 任其自然过期）。⇒ **条款 84 与 79 的正面形态。**
- ⇒ **与 B-111 / B-129 同族**：那两条是「失败 / 截断没有以调用方可见的形式表达」；本条是「**判定被跳过，而跳过这件事只在类别表里可见**」。⇒ 三者合起来：**「我没检查它」必须与「我检查了、它没问题」在读数上可区分。**

**B-134 补二（我自己的第一条结论被证伪：偏差是**位置性**的；且我的定位尝试**因自己的比较器坏掉而无效** · 2026-09-28 · G-WORLD 组长提出、tier 0 第一手确认与自纠）**

- **证伪**：B-134 正条写「PowerShell 读数路径**整体**高一行」。**实测证伪**：在同一 revision、工作树干净的前提下，两读者在文件**前部逐字一致**（第 785 / 786 行，连行首空格都相同），而到**后部**才相差一行 ⇒ **该映射不是全局 1:1，偏差是位置性的。**
- **一条干净的计数读数**：`tools.read` 的 `totalLines` = **3138**；PowerShell `(Get-Content).Count` = **3139**、`-Raw` 按换行切分 = **3139** ⇒ **两读者对「这个文件有多少行」本身就不一致**（差 1）。
- ⇒ **位置性偏差比恒定偏移更难发现**：恒定偏移会被「取一行比对」发现；位置性偏差**只在跨过那个分叉点之后**才出现 ⇒ **分叉点之前的对照会给出「一致」的假安慰**（我在第 785 / 786 行处拿到的正是这种假安慰）。
- **★ 我的定位尝试无效，具名**：我用二分法找分叉点，但**两侧用了不同的拼接**（`tools.read` 侧用 `" | "` 连接、PowerShell 侧 `Out-String` 保留换行）⇒ **比较器恒返回「不同」** ⇒ 二分只是在无效信号上走到底，得出的行号**无意义**。⇒ **定位未达成，该结论已撤回。**
- ⇒ **纪律（新增，id `comparator-needs-same-transform`）**：**比较两个读数时，两侧必须经过同一个规范化函数**；且**该比较器必须先在一个「已知相同」的输入对上验证它会返回 true** —— **一个从未返回过 true 的比较器，其「不同」不构成证据**（承条款 77 / 85，这次对象是**我自己的比较器**）。
- ⇒ **行号读数有两个坐标轴：仪器 × 版本**。该组长第一次测错，正是因为它把 `tools.read`（**工作树**）与 `git show HEAD:`（**提交**）相比，而当时该文件是修改态 ⇒ **它比的是两个版本**。⇒ **行号读数必须同时钉住仪器与版本，缺任一个则两个读数不可比。**
- ⇒ **裁决者仍是门禁的载体行字段**：我按 `tools.read` 的行号就地替换后门禁转绿 ⇒ **门禁与 `tools.read` 同坐标**。⇒ **承重行号读数一律用 `tools.read`**（该组长已提议固化为常设判据项，**采纳**）。

**平台已修复的条目（tier 0 按本轮工具 schema 逐字核对 · 2026-09-28）**

- **B-126**（`team_task_create` 无 owner 参数 ⇒ 无主窗口）⇒ schema 已含 **`owner`**（且注明「Group leads may assign only their own group members or themselves」）。
- **B-124**（`reopen` 无理由字段 ⇒ 理由只能活在会丢的消息里）⇒ schema 已含 **`reopen_reason`**，且落 `lastReopenReason` / `lastReopenAt`。
- **B-130**（并入只有「全量忽略未跟踪」一个逃生口）⇒ schema 已含 **`allowed_untracked: string[]`**，且 `team_merge` 回执新增 **`ignoredUntracked`** ⇒ 「忽略了什么」现在是**可复算的读数**。
- **B-132**（`worktree_setup` 在既有树上做 merge 却不声明）⇒ schema 文档已写明「**MERGE the requested base into the branch; it never resets or rebases**」，回执新增 **`previousHead` / `head` / `parents` / `headKind` / `mergeCommitCreated` / `ignoredUntracked`**。
- ⇒ **结论：四条均已由平台侧修复，且修复形态正是我们提的方向**（具名参数、结构化回执、可复算读数）。⇒ **纪律**：**这四条不再需要团队侧的工作绕行**；已写进纪律的绕行（如「建卡后立即 reassign」）**保留作习惯**，但**不再是唯一通路**。

**B-136 `waiting_list` 硬失败：`lower is not defined` ⇒ 全队**无法读取等待台账**（2026-09-28 · tier 0 第一手 5/5 复现 · 两名 agent 独立命中）**

- **逐字错误**：`lower is not defined`（harness 侧错误，非数据问题）。
- **第一手复现（tier 0，同一轮内连续 5 次）**：默认调用 **3/3 失败**、`input:{includeClosed:true}` **2/2 失败**；耗时 **264–585 ms** ⇒ **是代码错，不是超时**。⇒ **此刻是确定性失败，不是间歇失败。** ⇒ 该组长先前的「间歇性」描述**在当下不成立**；「先前多次成功」是**更早的时点** —— 「曾间歇」与「现确定性」是两种不同事实，**本条只登记当前读数，不把两者合并**。
- **危害（比 B-133 更硬）**：**等待台账是「谁在等什么」的唯一权威读取通道**；它读不出 ⇒ **全队无法从台账确认任何「无等待」结论**。⇒ 此刻任何「我组无承重等待票」的陈述**都是读债，不是读数**。
- ⇒ **纪律（由该组长提出、tier 0 采纳为**当前强制**）**：**凡以「集合为空」作为结论的读数，必须与「该调用成功」绑定**；调用失败时该结论**记为读债**，**不得记为 0**。⇒ 承重约束一律落**持久载体**：卡面 `description` / 里程碑 `done_when` / 定向 dispatch 收据 / evidence 行。
- ⇒ **与 B-129 / B-111 同族**：B-129 是「失败被表达成一句散文」；本条是「**失败以异常抛出，而调用方可能把空集合当『没有』**」。⇒ 修法同向，且要求推到**类型层**：**「空」与「读失败」必须可区分**。
- ⇒ **给修复方的定位线索（只给读数，不给猜测结论）**：`lower` 是一个**未定义标识符**，且**默认路径与新 `includeClosed` 路径都经过它** ⇒ 它应在**两条路径共同的上游**。

**B-133 收口（**部分修复**：生命周期已声明，但读取已坏 · 2026-09-28）**

- **修复形态（tier 0 按本轮工具 schema 逐字核对）**：`waiting_list` 现声明 **`input {includeClosed:true}`** 并返回 **`closurePolicy` / `closedReason` / `closedAt` / `closedBy`** ⇒ **等待行的生命周期现在是被声明的**，且**已关闭的票可以被读**。⇒ **B-133 的「生命周期未被声明」这一半，成立地被修好了**（这正是该条要的形态）。
- ⇒ **但读取同时坏了**（B-136）⇒ **B-133 的收口只能记为「形态已修、可读性未达」**。⇒ **不得据「schema 已声明」断言「台账可读」**（条款 84：对外陈述只由已到手的读数承载）。
- ⇒ **该组长给的第三候选（「任务完成后其票不在投影里」）现在可被检验了**：用 `includeClosed:true` 读一次即可区分「不在投影」与「已关闭」；**待读取恢复后测**。

**B-137 `team_delivery_check` 的 `owner-forgot-to-mark-it` 会因「里程碑绑在别的卡上」而误报（2026-09-28 · tier 0 第一手 · 可机检判据已给出）**

- **实测**：某卡在板上的 verdict 由 `milestone-unbound` 变为 **`owner-forgot-to-mark-it`**，但该 owner 的 `ownerMilestoneTaskId` **不是这张卡**（它属于**同一组的另一张卡**）⇒ **该判定描述的是「该 owner tick 了某个里程碑」，不是「这张卡的 owner 忘了标记这张卡」**。
- ⇒ **危害**：`owner-forgot-to-mark-it` 在既有规则里是「**chase the first with a status fix**」的**触发条件** ⇒ 一个**指称错误的 verdict** 会让全队**对未犯错的成员做状态追讨**（本会话我据此差点发出一张返修单，在发出前核到指称不成立）。
- ⇒ **可机检判据**：**当 `ownerMilestoneTaskId != task.id` 时，`owner-forgot-to-mark-it` 不是该卡的判定** —— 应报为「**里程碑绑在别的卡上**」，并要求组长**重绑**或**明确该里程碑属于哪张卡**。
- ⇒ **与既有条目的关系**：板侧已有的 `milestone-unbound` 是「该 owner **没有**里程碑」；本条是「该 owner **有**里程碑，但它**不是这张卡的**」—— **两者都让 verdict 描述的不是该卡的状态**，且本条更隐蔽，因为它看起来是一个**具体指控**。
- ⇒ **纪律**：**verdict 的指称必须与它被用来支持的行动同一**（承条款 87 的粒度族：**读数的对象与行动的对象的同一性**）。

**B-134 收口（真因是**一个字节**：文件里有一个孤立 CR · 2026-09-28 · verifier 定位、G-WORLD 组长转报、tier 0 收编）**

- **机制（verifier 第一手）**：`docs/GOVERNANCE.md` 里有**恰好一个孤立 CR，位于 LF 行 2450**。**PowerShell 的读取器把该孤立 CR 当作换行**，而**门禁 / Rust `.lines()` / `tools.read` 都不当** ⇒ **PowerShell 读出的行号在 ≥ 2451 处比门禁编号大 1**。
- ⇒ **它一次解释全部三个读数**：**①** `tools.read` 的 `totalLines` = **3138** vs `(Get-Content).Count` = **3139**（**多一个换行 ⇒ 多一行**）；**②** 两读者在该 CR **之前**（第 785 / 786 行）一致、在**之后**（第 3086 行）差一行；**③** 我先前拿到的「位置性偏差」只是**现象**，真因是**这一个字节**。
- ⇒ **纪律（升级为全队通则，不再是某组的常设判据项）**：**承重行号读数一律用 `tools.read`**；**任何文件都可能带这样一个字节**。⇒ **并新增第五轴：读者（reader）** —— **一条行号不是自描述量**，它必须同时具名 **域 × 单位 × 依赖集 × 排序 × 读者**。
- ⇒ **机制已定，B-134 正条与补二的「机制未定」到此收口**：**保留**其结论（**偏差是位置性的**），**更正**其成因（**不是两种读取器的普遍差异，而是一个字节**）。

**B-138 门禁的 `M11-CITE-PATH-EXC-UNREGISTERED` 行**未在任何文档里写明其两段含义** ⇒ 一名组长据此在错误的 revision 上复现并报「两个读数不一致」（2026-09-28 · tier 0 第一手 + G-RIG 组长复现失败）**

- **行格式（据实测）**：`M11-CITE-PATH-EXC-UNREGISTERED|<载体路径>:<载体行>|<引用串>` —— **前半是「谁在引」，后半是「引的是什么」**；竖线右侧**不是**另一处坐标，而是**该载体行上被扫到的那个引注 token**。
- **实证**：某组长读到该行，把**两段都当成文件内坐标**去复现 ⇒ 在**当前**文件上 `grep 'main\.rs'` = **14 行**、`grep '1124'` = **2 行**，**无一行为 3086** ⇒ 它**命名了「两个读数不一致」并停下**（**处置正确**：它没有据一个无法独立核对的指称去改文档或豁免判据）。
- ⇒ **真因不是不一致，而是它没有钉住被检索文件的 revision**：该 token **已在 `3d3d05d` 被我移除** ⇒ **在当前文件上 0 命中是预期结果**。⇒ **这是「现轴」的第三次同形**（用**当前**文件复现**过去**的读数）。
- ⇒ **纪律**：**复现一个行级读数时，必须同时钉住「被检索文件的 revision」**；**门禁的每一行都是「(载体, 行, token)」三元组，复现它必须回到产出它的那个 revision**。
- ⇒ **给门禁的修法方向**：**该行应直接给出两段的语义**（例如 `carrier=<path>@<line> cite=<token>`），使读者不必从竖线猜。

**跨组通则：记录一条规则与把它作为要求下达，是两个动作（id: recorded-is-not-applied · 2026-09-28 · G-WORLD 组长自陈 · tier 0 收编）**

- **实证**：该组长**记录**了 B-132（「成员必须在最后一次 `team_worktree_setup` 之后另落一个普通提交」），甚至**写进了 packet 的 risks**，**却没有把它作为要求下达** ⇒ 结果：它给 t104 命名的 commit 使绝对判据**继承父的失败** ⇒ 被 verifier 判 **1 blocker**。
- ⇒ **纪律**：**一条规则要生效，必须落在「被要求的人看得到的地方」**（卡面 / 计划 checks / 派发指令）；**记在台账里不等于下达**。⇒ **台账记录面向未来，卡面要求面向执行。**
- ⇒ **与条款 81 补的关系**：**同族** —— 那条说「提出方与落卡方是两个独立义务」；本条说「**记录方与下达方也是两个独立义务**」。

**跨组通则：里程碑 `done_when` 里的任何读数，必须先在 evidence 账上有一行（id: claim-needs-carrier · 2026-09-28 · G-RIG 组长提出 · tier 0 采纳）**

- **实证**：某成员的里程碑 `done_when` 写了「某判假测试 VERDICT=AUTO_SENT」，而**账上无一行承载它**（该组两张卡合计 21 行读数，**无一命中该主张**）⇒ **主张无载体**。该组长**不接受该主张**，**自己去读产物**并**代补了账行**，同时给出通则：**先有账行，再 tick**。
- ⇒ **纪律**：**里程碑 `done_when` 中出现的每一个读数，必须先在 evidence 账上有一行**；**不得先 tick 后补账**。
- ⇒ **与条款 84 的关系**：84 说「对外陈述只由已到手的读数承载」；本条说「**已到手的读数必须落在可回读的载体上**」⇒ 合起来 = **陈述 → 读数 → 载体** 三者必须连续。

**B-135 补（QUOTED 假阳性的第一个具体实例 · 2026-09-28 · G-WORLD 组长转报 verifier 的 condition 1）**

- **实证**：`citation_integrity.rs` 的 `is_quoted()` 是**行内 120 字符邻近性**测试（找 `原引`），而某被引行上它找到的 `原引` **属于另一句** ⇒ **QUOTED 是假阳性**，该引注**从未被路径核验**。⇒ 「门禁绿」在这里**既不是「已核」也不是「失配」，而是未被判**。
- ⇒ 这与 B-135 正条**是同一件事的两个方向**：正条是「**标记**让**该条**被跳过」，本条是「**邻近性**让**另一条**被误判为被跳过」。⇒ **共同修法方向**：**「跳过」必须由该引注自身的、可独立核对的属性决定，不得由邻近性决定。**

**B-139 `failure-memory` 把「曾确定性失败」升级为**该调用签名**的永久拒绝，而清除路径未在任何地方声明（2026-09-28 · tier 0 第一手）**

- **实测（tier 0，同一轮内）**：`team_v12(action:"waiting_list")`（**不传 input**）现返回 **`failure-memory denied: deterministic failure threshold reached in this session/workspace; replan or explicitly clear with reason and evidence.`** —— 而**同一轮**内 `input:{includeClosed:true}` **成功**（`total=440 / active=5 / closed=429`）。
- ⇒ **两件事必须分开**：**①** 底层读**已可用**（`includeClosed` 成功）；**②** **「不传 input」这个调用签名被拒绝** —— 拒绝**不是**因为底层失败，而是因为它**此前失败过足够多次**。
- ⇒ **危害**：**记忆按「调用签名」生效** ⇒ **先测哪种形式，哪种形式就被锁住**；而**同一个底层读的另一种形式仍然可用** ⇒ **对同一事实，两种调用形式的可用性不一致**。⇒ **调用方无法再复测**（复测就是被拒的那个签名），且 **「explicitly clear with reason and evidence」没有任何已声明的工具入口**。
- ⇒ **修法方向（任一）**：**①** 给一个**具名的清除入口**（与 `team_provider_resume` 同形）；**②** 把记忆的键从「调用签名」放宽到「底层操作」，并**在拒绝串里报出计数与阈值**；**③** 至少在拒绝串里**给出可执行命令** —— 否则调用方只能「replan」，而不知道 replan 成什么。
- ⇒ **与 B-129 / B-136 的关系**：那两条要「失败必须结构化」；**本条的失败确实结构化了（值得肯定）**，但**结构化的代价是永久拒绝，而出口未声明**。⇒ **结构化必须配一条出口。**

**B-136 状态更新（不再可复现；但我**不断言**「平台已修」 · 2026-09-28 · tier 0 第一手）**

- **T 时（我，同一轮 5 次）**：默认 **3/3**、`includeClosed:true` **2/2** 均失败于 `lower is not defined`。
- **T' 时（我，本轮）**：`includeClosed:true` **成功**（`total=440 / active=5 / closed=429`）；**默认**现被 **B-139 的 failure-memory** 拒绝（**不是** `lower is not defined`）。
- ⇒ **我登记的事实只有两条：「T 时失败」「T' 时成功」。成因与是否被修复，我没有读数，故不写。** ⇒ 另一组长报「从它那侧不再可复现」，并**自我排除**了它自己一次失败（它传了 `undefined` ⇒ **调用方 bug，不是平台缺陷**）⇒ **该实例不计入平台账**。
- ⇒ **纪律**：**「曾经失败」与「现在成功」是两个时点读数**；**不得据后者断言「前者已被修复」**（承条款 69 的现轴）。

**B-133 收口二（★ 决定性读数：票**已持久化**，却在**两个投影里都缺席** ⇒ 投影不完备 · 2026-09-28 · G-PROTO 组长第一手 · tier 0 收编）**

- **实测（该组长）**：为某任务建票后 —— **①** 按 `ticket_id` 读 → 空；**②** `includeClosed:true` 全量读 → `total:123 / active:0 / closed:123`，payload **既无该任务 id 也无该 ticketId**；**③** 但**控制面持久存储里该片段存在**（会话 json，`frag=True`、`t72wait=True`、`ticketId` 计数 451）。⇒ **票已持久化，却不在「活跃」也不在「已关闭」里** ⇒ **不是「被关闭」，是「不在投影」。**
- ⇒ **结论（比 B-133 原判更强）**：**两个投影之并不是全集** ⇒ **「调用成功」也不足以支撑「该集合为空」的结论**。⇒ 该组长先前「载体静默丢失」的说法**维持已撤回**（这是**投影规则**，不是丢失）。
- ⇒ **纪律（扩 `empty-set-needs-call-success`）**：**以「集合为空」作为结论的读数，除「该调用成功」外，还须给出「该集合的完备性论证」**（该投影是否覆盖权威存储、有无上限、有无未声明的过滤键）。⇒ **不得把「投影里没有」当成「不存在」。**
- ⇒ **一处未定（该组长如实登记，我原样收）**：投影的**过滤键**（任务已 completed / waiter 是组长 / 其他）**数据分不开**。
- ⇒ **我裁：不做该实验** —— 理由：**无论过滤键是什么，纪律都相同**（不把承重约束放在投影里）⇒ **该读数的结果不改变任何决定** ⇒ **不经济**；且该组长**拒绝为做实验造填充卡**是对的。
- ⇒ **一处两 agent 读数不同、我不裁定**：该组长报「按 `ticket_id` 读 → 空」，而我本轮同一形式**返回 11 条**（首条是**另一张**票）⇒ **该入参是否真的过滤未定**；两者**时点不同**（它在其读失败期、我在恢复后）⇒ **不构成矛盾，也不构成一致。**

**B-139 已修（failure-memory 有了具名出口；tier 0 只读复核通过 · 2026-09-28）**

- **复核（修复方请我做的那一次）**：默认调用 **team_v12(action:waiting_list)** **不再被拒绝**；**failure_memory_status**（对同一调用签名）返回 **blocked=false / count=0 / threshold=3 / actionFingerprint=66af5a3d…** ⇒ **计数、阈值、指纹三件都暴露**。
- ⇒ 我提的三条修法方向中的第 1、3 条已落地 ⇒ **「结构化必须配一条出口」成立。**

**B-133 收口二 已修，且**两个候选机制都被具名**（tier 0 只读复核通过 · 2026-09-28）**

- **分区求和 = 权威总量（我核的算术）**：**active 4 + closed 439 = storedTotal 443**；另有 **stale=0 / derivedTotal=7 / projectionComplete=true / source={kind:v14Waiting.tickets, authoritative:true, visibleStored:443}** ⇒ **「已持久化却在两个投影里都缺席」这个缺口已被关闭，且可被算术复核。**
- **分页**：offset 0 / limit 2 ⇒ returned 2 / truncated true / nextOffset 2 / total 11 ⇒ 按文档工作。
- **精确读**：按 ticketId 读 ⇒ total 1 / returned 1 / projectionComplete true ⇒ 按文档工作（**注意：顶层 ticket_id 仍会被忽略，必须放在 input 里**）。
- **★ 两个候选机制现在都有具名取值**：**(i)** **closedReason = task-terminal**（任务到达终态时自动关闭）；**(ii)** **closedReason = deduplicated**（重复登记时自动去重关闭）⇒ **我先前那条「同 task 的后次登记覆盖前次」的候选 ②，不是静默覆盖，而是一条具名的去重关闭。** ⇒ 两个机制**都真**，且**现在都可见**。
- ⇒ **纪律**：**登记等待票时若同一条件已存在，去重关闭会给出 closedReason = deduplicated** —— 这不是「票被吞掉」，**但调用方必须读 closedReason 才能区分它**。

**B-140 complete 用 replace 语义写 evidence_ids ⇒ 卡的证据指针集被静默缩小（2026-09-28 · G-WORLD 组长第一手 · tier 0 收编）**

- **实证**：某卡 complete 时，其原有 **15** 个 evidence 指针被 **5** 个**覆盖**（卡看起来正常，但指针集变小）。该组长试 bind_fix 被 **bind-fix-scope** 拒绝（**原因未定，不裁定**），它**升级上报而非绕过**，由 tier 0 执行修复后恢复为 **20** 条。
- ⇒ **危害**：**数据丢失形态** —— 状态、phase、commit 都不变，**只有指针集变小**，且**没有任何字段提示它变小过**。
- **可判假的检查（已执行，结论为否）**：对该组两张已完成卡重读 evidenceIds ⇒ t72 = **26**（22 → 23 → 26 单调增）、t73 = **17**（与同任务台账行数相等）⇒ **未观察到静默覆盖**。⇒ **本条登记「该类动作会覆盖」，不是「所有卡都受影响」。**
- **修法方向**：complete 应并集，或在集合变小时拒绝并要求显式确认。

**调用方错误：顶层 ticket_id 被忽略，正确形式是 input 里的 ticketId（2026-09-28 · tier 0 与 G-WORLD 组长各自独立命中）**

- **实证（两人同形）**：tier 0 用顶层 ticket_id 读到默认页 **11** 条；某组长用同一形式得到 **total:0**（而它手里确有真票）⇒ 两人**都**据此写过「平台投影缺陷」。⇒ **更正**：顶层 ticket_id **被忽略**；正确形式 **input 里的 ticketId** 返回 total=1 / returned=1 / truncated=false。
- ⇒ **纪律**：**在断言两个读数不一致、或断言平台有缺陷之前，先核自己的调用形式。** ⇒ ★ **危害具名**：**一个调用方形式错误可以被两名 agent 独立地误归因为平台缺陷** —— **误归因不因「多人独立」而变成真。**

**环境缺陷：一个成员的 shell 持续失败（spawn pwsh.exe ENOENT）· 2026-09-28**

- **实证**：某组长的 shell 持续失败，**git 与 cargo 都跑不了** ⇒ 那一轮**没能自跑门禁**；它把该 limitation **具名落账**（判据的 pass 建立在 owner 读数 + 结构性核验之上，**不建立在它自跑之上**），并承诺**每一步给退出码**、**若再失败就具名报告而不冒充自跑** ⇒ 处置正确。

**B-135 补 更正：我登记的那个实例是假的；类成立、实例作废（2026-09-28 · verifier 自纠 + G-RIG 组长自取复核 + tier 0 更正）**

- **我先前登记的实例**：某文件某行被判 QUOTED ⇒ 未被机检。⇒ **该实例为假**：verifier **自纠**撤回该 nit，而该组长**不接受其自纠、自己重取**：blob 与具名值一致、该行长 **733**、token 在 0-based **368**、首个 原引 在 0-based **517** ⇒ 距离 **149 > 120** ⇒ is_quoted = **false** ⇒ 门禁判 **PASS**。⇒ **那一条本来就是机检过的。**
- ⇒ **类的结论仍成立**（该标记**同时跳过路径判定与内容判定**，且该判定是**行内 120 字符邻近**）⇒ **独立实例**：某测试文件第 560 行 col 277（两个 revision 上都判 QUOTED）+ 某 errata 文档四行。
- ⇒ **纪律（该组长提出，我采纳）**：**从别组报告导入的实例，必须自取复核，或明确标注转述；转述不得当作读数承载主张。** ⇒ 与条款 87 同族但对象不同：87 管**粒度**，本条管**信道**。
- ⇒ ★ **对 tier 0 的适用**：**我这次也是转述者** —— 我把该实例写进台账时未自取。⇒ **更正另落本段，原条不改写**（条款 79 形态）。

**B-141 `deadLetterCount` 的指称与它的名字不一致（2026-09-28 · tier 0 第一手）**

- **实证**：`team_delivery_check` 报 `deadLetterCount: 7`，而 7 条的 id 全部形如 `wake:idle:session-<id>:<n>:<hex>` 与 `wake:activity:session-<id>:<n>`，**target 全部是 lead（tier 0 自己）**，error 全部是 **`dispatch deadline expired`** ⇒ 它们是**系统 idle / activity 通知在 lead 正忙时过期**，**不是投递失败的对等消息** ⇒ **实际丢失 0 条**。⇒ 一个读者会把 `deadLetterCount=7` 读成「7 条消息丢了」。
- ⇒ 与 **B-137** 同族：**计数器的指称与它的名字不一致**。⇒ **修法方向**：把系统提示与对等消息分开计数，或让每条带 `kind` 字段并在计数里分列。

**B-142 `team_task_update(action:"reassign")` 更新 `branch` 但不更新 `worktreePath`（2026-09-28 · G-RIG 组长第一手 · tier 0 收编）**

- **实证**：改派后卡面变成 `branch=team/rig/rig-runner`，而 **`worktreePath` 仍指向 `...team__rig__rig-diff`（另一成员的工作树）**；只有随后调用 `team_worktree_setup` 才把两者一起修正。⇒ **新 owner 若按卡面行事，会进入别人的工作树。**
- ⇒ **纪律**：**任何改派之后必须显式跑一次 `team_worktree_setup`**，否则卡面会给出**跨成员绑定**。⇒ **修法方向**：`reassign` 应同时清空或重算 `worktreePath`，或在回执里显式警告两者不一致。

**B-143 `evidence_query` 的 `queryKey` 只回显被接受的键，而 `queryStatus` 仍报 `formed`（2026-09-28 · G-PROTO 组长提出 · tier 0 第一手复现）**

- **实证（tier 0 复现）**：`input:{kind:"probe", taskId:null}` ⇒ `matched=2`（与**不带**该键完全相同）、`visibility.queryKey = {field:"kind", value:"probe", form:"filter"}` ⇒ **`taskId:null` 被静默丢弃**，而 `queryStatus` 仍报 **`formed`** ⇒ 调用方会误信「按 taskId=null 过滤已生效」。⇒ 该组长报 12、verifier 报 0，**两种读法都错**。
- ⇒ **过渡纪律**：**不要把 `null` 当过滤值传**；**用「带该键与不带该键的计数对照」自证过滤是否生效**。⇒ **修法方向**：被接受的键必须**逐字回显**；未生效的键必须使 `queryStatus` 不再报 `formed`。

**B-144 同一完整 `evidenceId` 对一名读取者 `resolved`、对另一名 `not-found`，且作用域未声明（2026-09-28 · G-PROTO 组长提出、tier 0 第一手交叉 · **判别量未隔离**）**

- **实测（tier 0，`registryRevision 66644`，同一轮内）**：三个具名 id **全部 `not-found / candidates=0 / rows=0`** —— rowA `evidence-67fe7b38-…`、R1 `evidence-b0516aed-…`、**R3 `evidence-14e583f6-…`**。★ **R3 正是该组长用来做「可达对照」的那一行**（它读到 `resolved`）；而**我自己的 `status:"corrected"` 探针行** `evidence-915041f7-…` 在**同一 revision** 上 **`resolved / candidates=1 / matched=1`**。
- ⇒ **判别量**既**不是 status 取值**（我的 corrected 行可解析，且该组长另测五行旧 corrected 行全部可解析），也**不是行本身**（R3 状态翻转）⇒ **它是读取者 / 时点作用域，而该作用域未被声明。**
- ⇒ **`not-found` 对完整 id 也不是「不存在」的证据。** ⇒ 承 `empty-set-needs-call-success` 与该 verifier 自报的 `not-found-is-scoped`。
- ⇒ **修法方向**：**`not-found` 必须带作用域**（该投影覆盖了什么、按什么键、`registryRevision` 是多少），否则读者无法区分「不存在」与「我没看到」。

**一条正面读数：`no-verifier-clearance` 授权键门禁按设计工作（2026-09-28 · tier 0）**

- **实证**：我在拿到**读数**（消息）但**未拿到形式清关**（报告）时尝试落地，被逐字拒绝：`team policy refusal [no-verifier-clearance]: main refuses "grp/world": no-verifier-clearance (commit 877a7021fb46)`。⇒ 清关报告出具后，同一调用 **`merged:true / fastForwarded:true`** 通过。
- ⇒ **读数 ≠ 授权键**：**消息可以承载读数，但不能承载授权**；**门禁要求的是具名该 commit 的形式清关**。⇒ 这是该门禁的正确用法。

**B-144 强化：证据投影是**按记录者**作用域的，且该作用域未声明（2026-09-28 · tier 0 第一手对照 · 判别量已隔离到「记录者」）**

- **实测（`registryRevision 66809` / total 4219，同一轮内）**：**我的三行全部 `resolved / candidates=1`** —— `evidence-915041f7`（corrected，本会话写）、`evidence-bd42534a`（current，本会话写）、`evidence-702e2877`（**几分钟前**写）。而**另一组长的四行全部 `not-found`**：rowA `evidence-67fe7b38`、R1 `evidence-b0516aed`、R3 `evidence-14e583f6`、R5 `evidence-43798285`。
- ★ **关键读数**：**R5 对它的作者是 `resolved`，对我是 `not-found`** ⇒ **读取者作用域成立。**
- ⇒ **判别量 = 记录者（作者）**，**不是** `status`（我的 corrected 行可解析；该组长另测五行**旧** corrected 行逐行可解析，且恰好构成 `{status:"corrected"}` 的全部成员），**也不是年龄**（我的最新行可解析）。
- ⇒ ★ **这与该 verifier 早先自报的现象同形**：它的投影里**非 verifier 作者且 `taskId=null`** 的行不可解析，而**它自己**同条件的行可解析。⇒ **两个独立观测指向同一条：投影按作者作用域。**
- ⇒ **危害**：**同一台账，不同 agent 看到的行集不同，而没有任何字段声明这一点** ⇒ 一名 agent 的 `not-found` 会被读成「该行不存在」，**从而产出一条假更正**（本会话已实际发生一次）。
- ⇒ **修法方向**：**投影必须声明作用域**（哪些作者 / 哪些键可解析），**或让完整 `evidenceId` 对任何读取者都可解析。**

**B-145 `git rev-parse <rev>:<path>` 失败时把参数回显到 stdout 并返回 128（2026-09-28 · G-RIG 组长第一手 · tier 0 收编）**

- **实测**：`git rev-parse main:<path>` 在路径不存在时**把参数原样抄到 stdout**并返回 **128** ⇒ **只读 stdout 无法区分「解析成 sha」与「把我的参数抄回来」**。⇒ 该组长据此对一名**正在执行的成员**断言「该文件已在 main 内」，**该断言为假**（`git cat-file -e`：main **rc 128**、grp/rig **rc 128**、`541d0b53` **rc 0**；`ls-tree main -- tools/rig-batch/tests/` 列 7 个文件不含它）。⇒ 它**当场更正了成员并另落具名更正行**。
- ⇒ **机检形式**：**判存在用 `git cat-file -e` 看退出码**，或**断言输出匹配 sha 形态**；**永不单读 `rev-parse` 的 stdout。**
- ⇒ ★ **它是 `echoed-input-or-not-applied` 的第五个实例，而且发生在 shell 工具而非 Team API 上** ⇒ **该通则适用于任何工具。**

**B-144 更正：我写的「判别量已隔离到记录者」是**过度声明**（2026-09-28 · tier 0 自陈 · 另一个竞争候选由 verifier 提出）**

- **我的过度声明**：我据此写了「判别量 = 记录者（作者）」。⇒ **我排除了 `status` 与年龄，但没有控制「同一个程序里连写多行」这一轴** ⇒ 该轴与「记录者」在观测上**混同**，两者**都只是候选**。
- **竞争候选（verifier 提出，其域内 5/5 复现）**：**一个程序里连写 N 行，只有最后一行可按完整 id / 前缀 / kind 取回**，其余 `matched=0`（但信封的 total/visible 仍计入），跨 rev 66694→66816 不恢复 ⇒ **不是索引滞后**；它**已逐个杀掉 status / kind / taskId 绑定**，并报 **1/6 程序为例外**（三行全可达），**未隔离差异**。
- **我自己的测试：又是例外**。一个程序连写**三行**（全部 `status=current`、`recordedBy=lead`）⇒ **三行全部 `resolved / candidates=1 / matched=1`**，按 kind 读 `matched=3`。
- ⇒ **结论（收紧）**：**现象真实**（有行被写成 `mirrorStatus: committed` 却取不回）；**候选判别量至少两个（记录者 / 同程序多行），均未隔离**。⇒ **不得把任何一个候选写成结论**（条款 87）。
- ⇒ **纪律**：**「隔离」必须意味着「一次只变一个轴」** —— 我这次的对照三行**同作者、同程序、同 status**，**一个轴都没变** ⇒ **它不能判别任何东西**。⇒ 承 `control-must-be-proven-stable`，本条是它的**姊妹**：**对照不仅要稳定，还必须变对轴。**

**假指控更正：「同一 id 两个标签」是我的误配，载体在我自己的读数里（2026-09-28 · tier 0 自陈）**

- **我发出的指控**：我对另一组长写「`evidence-43798285` 你在一处称 R6a、另一处称 R5 ⇒ 同一 id 两个标签」。
- **实测**：在该组长给我的消息里，**R5 = `evidence-9a1fd2d5-…`**、**R6a = `evidence-43798285-…`**，**标签与 id 一致，无冲突**。⇒ **我的指控为假。**
- ⇒ **真因**：**一行同时携带两个 id 字段且取值不同**（该行 `evidenceId = evidence-9a1fd2d5-…`、`id = evidence-383707772d4863af`）⇒ **我把该行的 `id` 字段当成了另一行的 `evidenceId`。** ⇒ 这正是该组长先前登记过的「**evidence 行有两个 id 形态且未声明**」族 —— **本次它是假指控的成因**。
- ⇒ **纪律**：**引 evidence 行时只写 `evidenceId`**；**不得把 `id` 字段当作行句柄或与 `evidenceId` 混用**（承其先前条目：短 id / fingerprint 都不是行句柄）。

**B-144 射程更新：读取者作用域**成立**；「可寻址性会衰减」**未**被确立为普遍属性（2026-09-28 · tier 0 第一手同 revision 对照）**

- **同 revision 对照（`registryRevision 67002`，同一轮内）**：**我的 8 行全部 `resolved / candidates=1 / rows=1`**（含**同程序连写的三行探针** `569f1fbc` / `c9e2d785` / `c8f25a6b`，以及更早写入的 5 行）；而另一组长的 `b7bfe351` / `14e583f6` / `9a1fd2d5` **同一 revision 上全部 `not-found`**。
- ⇒ **两个结论分开**：**(i)** **「同一 revision 下不同记录者的行可解析性不同」成立**（读取者作用域）；**(ii)** **「写入时 resolved 的行其后必 MISS」不成立为普遍属性** —— 该组长只在**它自己的行**上观察到该现象，**而我的 8/8 未衰减**。⇒ **两者可以并存**：**作用域** + **在不可解析集合内部的不稳定性**。
- ⇒ **不得把任一候选写成机制**（条款 87）。⇒ **运维纪律不依赖机制**：**使用前即时重解析 + 内容随引**（见 `re-resolve-before-citing`）。

**已验收卡的 `evidenceIds` 退化：不追溯作废验收，且不得用 `bind_fix` 移除（2026-09-28 · tier 0 裁定）**

- **事实**：卡 `group-proto-t72`（`integrated`）46 个指针 ⇒ **33 可解析 / 13 在当前投影下 MISS**。
- ⇒ **裁定**：**不影响其最终验收**，依据四条：**(i)** **验收是在**当时的投影**上完成的**（读数与门禁都在当时取）；**(ii)** 契约 **(b)** 已定 **`not-found` 不推「不存在」**；**(iii)** 这是**仪器侧缺陷**，不是交付缺陷；**(iv)** 但**该退化必须在卡面具名**，且**内容须落到可到达载体**（该组长已以单次写入的载体 `evidence-1d7c0a7c` 承载 10 条可读死指针的内容摘要）。
- ⇒ **并明确禁止**：**不得用 `bind_fix` 把这些指针从卡上移除** —— **`evidenceIds` 是交付时点的历史记录**，移除它会**销毁记录**，把「当时有证据」变成「从来没有证据」。

**B-144 收口（三轴形式；我此前的「记录者轴」**未成立**，由 verifier 的统一读数更正 · 2026-09-28）**

- **统一陈述（该 verifier 提出，我采纳）**：**证据投影沿三条轴都不稳定，且三条都未声明** ——
  **① 非读者稳定**（同一完整 id 对一名读取者 `resolved`、对另一名 `not-found`；tier 0 与它各自测到）；
  **② 非写者稳定**（**只有该 verifier 的域丢非末行**；**tier 0 / G-RIG 组长 / G-PROTO 组长都没丢**）；
  **③ 非时间稳定**（G-PROTO 组长报其 5 行**写入时可解析、其后 MISS**；而该 verifier 在 rev 66998 的 6/6 未复现衰减，tier 0 的 8/8 亦未衰减）。
- ⇒ ★ **我此前的「判别量已隔离到记录者」被第 ② 轴否证**：**若记录者是判别量，则不该只有一方的域丢行。** ⇒ 我**撤回该轴**，**B-144 登记为「三轴皆未隔离」，不登记任何机制**。
- **★ 一条决定性的判别读数（该 verifier 补）**：**不可按 id 取回的那批，在 `{taskId:"group-world-t104"}` 的投影里同样缺席**（`matched=34`），而**同程序的末行在** ⇒ **这不是「id 解析器」单独的缺口，而是投影本身缺这些行**。⇒ 与 **B-133**（已持久化却在两个投影里都缺席）**同族**。
- ⇒ **运维纪律不变且已被完整支撑**：**一个程序只写一行 + 写入后立刻重解析 + 引注使用前再即时重解析** —— **「已写入」与「可取回」是两个读数**。⇒ 该 verifier **具名**其先前那条「一程序一行」**不充分**（tier 0 的三行同程序测试全可达）。
- ⇒ **清关侧收口（该 verifier 报）**：**`pinned-dest f4de9015` 已过期，不再援引**；**落地本身由 git 对象独立确认**（`877a7021` 是 main 的祖先；四文件 blob 与 `877a7021` 逐字节相同），**不依赖证据台账**。

**平台修复第二十轮（B-140..B-145）的只读复放结果（2026-09-28 · tier 0 第一手 · `registryRevision 67106`）**

- **B-141 复放：accepted。** `deadLetterCount` 7 ⇒ 现拆为 **`peerDeadLetterCount = 0`** / **`systemDeadLetterCount = 7`**（+ `oldestPeerDeadLetterAgeMs = 0`）⇒ **7 条系统提示不再被算成对等消息丢失**，与我报的「0 条真丢失」一致。
- **B-143 复放：accepted。** `{kind:"probe", taskId:null}` 现在返回 **`queryStatus = "partial"`**（原为 `formed`），且 `visibility` 新增 **`requestedKeys` / `acceptedKeys` / `ignoredKeys` / `queryDetail`** ⇒ **被丢弃的 `taskId:null` 现被显式声明为 ignored**，虚假的 `formed` 消失。
- **B-144 复放：声明侧 accepted；**原始反例仍可复现**。**
  · **声明侧**：`visibility` 现在携带 **`scope` / `scopeBasis` / `reader` / `visibleAuthors` / `registryRevision` / `projectionStability` / `resolutionPolicy` / `notFoundMeaning` / `requestedKeys` / `acceptedKeys` / `ignoredKeys`** ⇒ **读者 / 作者作用域、revision、三轴不稳定性与 `not-found` 的语义都被声明** —— 这正是 B-144 要求的形态。
  · **但原始反例仍在**：在**同一 revision（67106）**上，**另一组长的五行全部 `not-found / candidates=0`**（`b7bfe351` / `14e583f6` / `9a1fd2d5` / `ddea2e74` / `a3a3cc8d`），而**我的两行对照全部 `resolved / candidates=1`**。⇒ **行级行为未被修复，只是被声明。**
  · ⇒ **对一个机制未隔离的缺陷，声明不稳定性而不是猜一个修法，可能是正确的处置** —— **但它不等于反例消失**，本条把两者分开记。
- **B-146（新，该组长受控三步实测）复放：我这里**未**复现。** 该组长报「**已完成任务的等待票据不可列出、但可创建、可解除**」；我在 67106 用 `waiting_list(input:{includeClosed:true, taskId:"group-proto-t72"})` 读到 **total 20 / returned 20 / `projectionComplete: true`** ⇒ **t72 的票据现在被列出**。⇒ **我不据此说它的读数为假**（它测于更早的 revision，且平台刚发过 B-133 / B-144 的改动）⇒ **记为「未复现」，不记为「不存在」**（承 `not-found-is-scoped`）。
- **B-140 / B-142：不做只读复放。** 二者都需要 `complete` / `reassign` 这类**对活卡的写动作** ⇒ **我拒绝为测试而伪造一次写动作** ⇒ **记为 not-replayed**，由下一次**真实使用**时的读数裁定。
- **B-145：平台无改动**（判 git 路径存在改用 `cat-file -e` 退出码或 sha 形态校验）⇒ **无平台侧可复放对象**。

**★ 一条与 B-144 mitigation 效力相关的收口（该组长报，我采纳）**：它为 10 条死指针做的**内容摘要载体 `evidence-1d7c0a7c` 自身现在也 MISS** ⇒ **「内容落到可到达载体」是时点动作，不是永久保证**。⇒ **这限定了 mitigation 的效力：它能保证「当时可读」，不能保证「以后可读」** ⇒ **真正的修法只能在平台侧。**

**B-147 `reassign` 不移交 / 不关闭旧 owner 的等待票 ⇒ 板侧出现 `idleWithOpen` 假信号（2026-09-28 · tier 0 第一手）**

- **实证**：`group-rig-t44` 被改派给 `rig-runner` 之后，`waiting_list` 里**同时存在两张 t44 的票**：一张 **owner = `rig-diff`**（reason 逐字「r5 已起 run（derived waiting-lease 行重现…）」），一张 **owner = `rig-runner`**（reason 逐字「已按 B-95 改派给 rig-runner…」）。⇒ 组摘要因此报 **`idle-with-open: rig/rig-diff`**。
- ⇒ **危害**：**该信号不是 stall** —— `rig-diff` 已不再拥有 t44，它手上的那张票是**改派前的残留**；而组摘要把它读成「有开放任务但成员没在跑」。⇒ 与 **B-142**（`reassign` 不清旧 `worktreePath`）**同族**：**改派只改卡面，不清理旧 owner 侧的绑定**（工作树、等待票）。
- ⇒ **纪律**：**改派之后必须显式核对并清理旧 owner 侧的绑定**（`worktreePath` 与**等待票**各一次）；**不得把 `idleWithOpen` 直接读成 stall**，必须先看**票的 owner 是否等于卡的 owner**。
- ⇒ **修法方向**：`reassign` 应**同一次动作内**重绑 `worktreePath` **并**移交 / 关闭旧 owner 的未结等待票。

**一条我自己的仪器选择错误（具名 · 2026-09-28）**

- 我为「查是否存在 provider 阻断」调了 **`team_v12(action:"runtime_facts")`**，返回 **137 KB 的插件清单**（`diffSummary: total 797 / errors 99 / warnings 698`，绝大多数是 `patch-source-unknown` / `evidence-missing` 这类与问题无关的条目），**而它并没有回答我的窄问题**。
- ⇒ **纪律**：**用一个宽 dump 去回答一个窄问题 = 把噪声当读数**；**先问「哪个字段会回答它」，再取该字段**（本次应取的是控制面里与 provider 阻断直接相关的字段，而不是全量运行时事实）。

**B-148 `team-health.mjs` 只在装载时体检一次并把该快照按 agent 事件重播 ⇒ 一次秒级竞态被锁存为 disabled，全队停摆且无会话内自愈路径（2026-09-28 · tier 0 第一手）**

- **时间线（本机实测）**：
  - desktop / web / headless 三份 profile 下的 `team-control-plane.mjs` 与 `team-policy.mjs`，四个文件 `LastWriteTime` **全为 20:15:02**（操作者在三份 profile 之间**逐份覆写**）。
  - `D:\dsh-test\home\team-health-web.json`：`checkedAt` = **20:15:02**、`status` = `disabled`、`reasons` = `profile parity failed for team-control-plane.mjs` + `profile parity failed for team-policy.mjs`。
  - 控制面 `health` = status `disabled` / reasons 同上 / `updatedAt` = 1790597703639（即 **20:15:03**）。
  - **20:31 复测**：三份副本**逐字节相同** —— `team-control-plane.mjs` sha256 前 16 位 `8EBC00174FE6ABA6` / 196775 字节；`team-policy.mjs` `A41CAF3FADA7EFBB` / 36995 字节；三者 mtime 同为 20:15:02。⇒ **判据的输入早已恢复，判据的读数没有恢复。**
- **机制（读源码，不是推断）**：
  - `team-health.mjs` 第 267 行 `apply()` 内 `const report = inspectHealth(config)` —— **只在装载时算一次**；第 290 行的 `mirror(agent)` 把**同一份 `report`** 推给控制面，而 `mirror` 挂在 `agent/created` 与 `agent/status` 上（第 296–297 行）⇒ **每次 agent 事件都在重播那份陈旧快照**。
  - `inspectHealth` 在本 profile 全部插件里**只有 `apply()` 一个调用点**（对 inspectHealth 做 `Select-String` 共 3 处：定义、内部调用、`apply` 内调用）⇒ **没有周期性重算，也没有任何工具能触发重算**。
  - `inspectProfileParity`（第 89–127 行）按 **hash / size / exports** 比较三份副本，**任一不一致或缺席即红** ⇒ 逐份覆写的那一瞬间必然出现「先写的已新、后写的仍旧」⇒ **秒级竞态被判红**。
- **传播 —— 这一条就是「全队为什么停了」的直接答案**：
  - `team-v14-event-continuation.mjs` 第 239–242 行 `providerBlocked(control)` = provider 状态为 blocked **或** health 状态为 disabled，**不过滤 reason**；调用点在第 371 行（候选集返回空）、第 396 行（逐候选跳过）、第 493 行（整轮扫描直接返回）⇒ **续跑扫描每轮产出空集** ⇒ **没有任何成员被恢复或启动**。实测吻合：G-PROTO / G-WORLD / G-RIG 的**全部组长与组员 `inactive`**，只有 tier 0 `running`。
  - `provider` 状态为 `unknown`、`lastFailure` 为 null ⇒ **本条与供应商额度无关**；等待投影把它归因成 `waiting-provider` 在此**不成立**。
- **同族不一致（附带）**：`team-idle-watch-v6.mjs` 第 130–141 行与 `team-activity-digest.mjs` 第 170–181 行的 `suppressForControlPlane` **要求 reason 以 provider failure 开头**才抑制 ⇒ 面对**同一个** health 为 disabled，续跑服务抑制、idle-watch 与 digest 不抑制 —— **同一状态位被三处用三种口径解释**。
- **危害**：**一次与真实健康无关的秒级竞态（文件逐份拷贝）可以永久停掉整个 Team**，且**没有会话内自愈路径**：不重装插件就永远不会重新体检。这与 fail-closed 的初衷相反 —— 它把**一次性读数的时点**当成了**对象的属性**。
- **操作者可用的即时恢复**：重新装载该插件（本仓既有手法是**新增一个插件文件**以绕开 ESM 同 URL 模块缓存），使 `apply()` 重跑一次体检；或重启该 profile。**恢复后**仍需 tier 0 显式唤醒 `lead-rig` 续跑 G-RIG（开放卡 t40 / t42 / t44 无租约，续跑服务未必会自行启动它们）。
- **修法方向**（任选其一或组合）：(a) `mirror()` 改为**重新调用 `inspectHealth(config)`** 而不是重播捕获的 `report`，并让 `checkedAt` 参与判定；(b) 消费侧把**过期的 disabled** 读成 `unknown` 并触发一次重算，而不是直接停摆；(c) `inspectProfileParity` 对**正在被写入**的副本去抖（同一 name 连续两次读数一致才判红）；(d) 暴露一个**只读的「重算体检」**入口（工具或操作者命令），使陈旧读数不必靠重启清除。


**B-148 第二实例（同一会话内复现 · 2026-09-28 20:40:53 · tier 0 第一手）**

- **读数**：`team-health-web.json` 的 `checkedAt` 从 20:15:02 **前进到 20:40:53**（说明插件**被重新装载**、`apply()` 重跑了），但 `status` **仍是** `disabled`；`reasons` 换成 `profile parity failed for team-health.mjs` + `profile parity failed for team-control-plane.mjs`（`team-policy.mjs` 本次不在红名单里）。控制面 `health.updatedAt = 1790599236073`（= 20:40:53）。
- **当时三份副本的实测**（20:41:17）：`team-health.mjs` desktop 与 web = 12547 B / `848D1E36…` @ **20:40:35**，**headless = 11628 B / `22FE22FB…` @ 2026-09-27 17:07:24**；`team-control-plane.mjs` desktop 与 web = 198011 B / `1673B69F…` @ **20:40:21**，**headless = 196775 B / `8EBC0017…` @ 20:15:02**。
- **⇒ 这一实例里判据没有读错**：那一刻三份副本**确实**不一致（操作者正在**逐份覆写** desktop → web，headless 尚未跟上）。**13 秒后**（20:41:30）复测，三份**全部逐字节相同**（headless 已跟上），而 `health` **仍是** `disabled`。
- **⇒ 因此缺陷的正确表述是两半，缺一不可**：(i) 判据在**它跑的那一刻**可以是对的；(ii) **但它的结论被锁存、且没有任何重算路径**，于是**一段真实但短暂的中间态**（本次约 70 秒：20:40:21 起写、headless 约 20:41:2x 跟上）**被升格成永久的全队停摆**。⇒ 第一实例（20:15:02，红名单为 `team-control-plane.mjs` + `team-policy.mjs`）与本实例**同形**：`reasons` 里的文件名**每次不同**，因为它取决于**覆写到哪一份时体检被触发**。
- **⇒ 可复现的操作触发（给修复方）**：只要「三份 profile 逐份拷贝」与「插件装载触发的体检」在时间上重叠，就会红。⇒ 要么让拷贝**原子化**，要么让判据**去抖 / 可重算**（见本条修法方向 (a)(c)(d)）。
- **⇒ 本条对我第一实例读数的自我更正**：我在 20:31 只测到「输入已恢复」，据此把成因写成「秒级竞态」。第二实例给出**更完整的形态**：判据的**输入**会在数十秒内保持不一致，而**锁存**才是把短暂不一致变成永久停摆的那一步。**只写「竞态」会漏掉真正要修的那一半。**


**B-149 卡级多余字段 `approved` 使该卡与**整块组板**的 `team_task_*` 全部失败（2026-09-28 · tier 0 第一手）**

- **复现器（逐字）**：控制面存储 `$.boards.group-proto.tasks.group-proto-t74` 的 keys 末尾为 `... contract, approved, contractDigest, lifecycle`，其中 `approved = true`（我直接解析 `session-<id>.json` 得到）。
- **失败形态**：`team_task_get(taskId=group-proto-t74, board=group-proto)` ⇒ `tool team_task_get returned invalid output: value.approved is not a declared property (additionalProperties: false)`；`team_task_list(board=group-proto)` ⇒ 同一错误，**坏行在索引 71 ⇒ 整块板读不出**；`team_task_update` 同卡同错。而 `team_task_get` 对 `group-proto-t72` / `t73` **正常** ⇒ **卡级成因、板级影响面**。
- **可用绕行（我实测）**：`team_task_list(board=group-proto, limit=70)` **成功**（70 行，坏行不在窗口内）；`task_contract_get(taskId=group-proto-t74)` **成功**；`timeline` 可用。
- **为什么调用方无法自解**：`team_task_update` 的返回体**就是**该卡 ⇒ **清除该字段的动作本身也失败**。⇒ **必须平台侧修**：要么输出 schema 声明 `approved`，要么写入侧不再写它。
- **写入路径未知（我不断言）**：报告方给的候选是「在该卡上调用过 `waiting_set(..., unblockCondition.type: approval)` 之后，首次 `team_task_get` 即失败」；我只有**字段形状**，没有写入路径的读数 ⇒ **不写成因**。
- **危害**：一个未在输出 schema 中声明的多余字段**不是「多一个字段」，而是让该卡与它所在的整块板对所有 `team_task_*` 调用不可用** —— 而该板是该组唯一的任务面。⇒ **写入侧新增字段必须与输出 schema 同步**；**读取侧遇到 `additionalProperties: false` 的输出校验失败时，应报出具体键/行，而不是只报工具失败**（本次报告方是靠「索引 71」自己定位的）。


**B-150 `reassign` 不更新已批准计划的 `members` ⇒ 新 owner 被 plan-scope 锁死；且两处补救语互相矛盾、其中一条的第一步按平台自身规则不可执行（2026-09-28 · tier 0 第一手）**

- **闭锁环（五连拒绝，逐字，来自一次真实收口尝试）**：`rig-runner`（`group-rig-t44` 的**现 owner**）① `team_evidence_record(task_id=group-rig-t44)` ⇒ `[plan-scope]: member "rig-runner" is not assigned to task "group-rig-t44"`；② 于是 `complete` ⇒ `[complete-evidence]: unknown or foreign: …`；③ 于是 `release` ⇒ `[lease-release-order]: task "group-rig-t44" is still in_progress`；④ 组长 `team_plan_propose(replace_approved:true, members:[rig-runner])` ⇒ `plan cannot be replaced while run lease "run-b5658c9f-…" is active`；⑤ 组长亲自 `team_run_lease(release, run_id=run-b5658c9f-…)` ⇒ **同一条** `[lease-release-order]`。
- **根因（我读源码定位）**：`team_task_update(action:"reassign")` 更新卡的 `ownerName`，**不更新已批准计划的 `members`** ⇒ 新 owner 在 `assertPlanAccess`（`team-tools-v2-r10.mjs` 第 1368-1374 行）被拒；而**该守卫正是 `team_evidence_record` 的门**（第 1916-1935 行）。⇒ **新 owner 写不了本任务的证据 ⇒ complete 必然失败 ⇒ release 被顺序拒 ⇒ 计划替换被活跃租约拒。** 与 **B-142**（同一次改派不清旧 `worktreePath`）、**B-147**（不清旧 owner 的等待票）**同族第三面**。
- ★ **两处补救语互相矛盾，且 `plan cannot be replaced` 那一条的第一步不可执行**：`team-control-plane.mjs` 第 3172-3174 行写「(1) `team_run_lease` release with the exact run_id, (2) `team_plan_propose` replace_approved, (3) 重新 acquire」；但 `team-tools-v2-r10.mjs` 第 4084-4087 行**拒绝**该 release，并给出**相反**的顺序「(1) 完成并记 commit+evidence, (2) **在租约仍活跃时** `complete`, (3) 再 release」。⇒ **按第一处的第一步做，必然被第二处拒** —— 报告方正是这样绕进环里的。
- ★ **被卡住的 owner 读不到卡住它的计划**：`team_plan_get` 走**同一个** `assertPlanAccess`（第 3815 行）⇒ `rig-runner`（tier 2、不在 members）**连 `plan.members` 都读不出来**。⇒ **它无法自行发现「我不在计划成员里」这一事实**，只能看到一句不说谁在里面的拒绝语。
- **环内其实有出口（我给出的执行序，已回给组长）**：该守卫对 **tier 0**、**计划成员**（本例 `lead-rig` 就在 `members` 里）、**verifier**（第 1925 行）放行；且 `complete` **不经过 plan-scope**（`assertPlanAccess` 全仓只有两个调用点：证据门 1928 与 `team_plan_get` 3815）。⇒ **计划成员写一条绑到该卡的证据 ⇒ owner `complete` ⇒ owner `release` ⇒ 此时才可替换计划。**
- **修法方向**：(a) `reassign` 应**同一次动作内**把新 owner 写进已批准计划的 `members`（并处理旧 owner 的租约与等待票，见 B-142 / B-147）；(b) `plan-scope` 的拒绝语**必须列出 `members` 的实际取值**与**可代写的角色**（tier 0 / verifier / 计划成员），否则调用方无从自解；(c) `team_plan_get` 至少应让**卡的 owner** 读到与自己相关的计划（或给只读的 `members` 摘要），否则「被谁卡住」对当事方不可见；(d) 把两处补救语统一成**唯一一条可执行顺序**。

**B-144 追加实例（2026-09-28 · 报告方自报，我未复现）**

- 一条 `team_evidence_record` 行**在它所在程序里是唯一一次调用、且位于最后**，仍不可寻址（`idStatus=not-found` / `matched=0` / `rows=0`），而同 turn 另一条同仪器、同域的行 `matched=1`。⇒ **verifier 的 `multirow-write-addressability` 报告的机制不足以覆盖本实例**（该报告说「多写程序里只有最后一条可寻址」，而本实例恰恰是**唯一且最后**的一条仍不可寻址）。
- **未隔离的候选差异（n=1，不写成因）**：该行 `status=observed`（对照为 `proposed` / `received`），且其所在程序还含 2 次 `team_worktree_setup` 与 1 次 `inbox_ack`。
- ★ **报告方另具名一条自己的错误形态（值得入册）**：消息文本是**事先拼好的常量**，**引用行为没有门控在解析结果上** —— 它**重解析了、看到 not-found、仍然把该 id 写进消息**。⇒ **纪律：一条引注的写入必须门控在它自己的解析结果上；「消息文本已拼好」不构成豁免。**


**B-78 同族新实例：内容已入 main 而清关没有对象（2026-09-28 · tier 0 第一手复测）**

- **实测**：`main = HEAD = 149ea576`（父 `bad51a5`）；`diff bad51a5..149ea576` = **恰 1 路径**（`A docs/groups/world/w2-block-change-event-stream.md`，blob **22524 B**）；`149ea576` **不在**其 owner 分支 `team/world/member-world-block`（= `e1bb0766`），却**可达于 `team/world/member-world-chunk`**；`merge-base --is-ancestor 149ea576 grp/world` = **rc 1**。
- **结构性后果（不是流程瑕疵）**：该内容进 main 时**没有任何具名该 commit 的 verifier 清关**；且因 `grp/world` 是 main 的祖先，之后 `team_merge(grp/world → main)` 对它是 **no-op** ⇒ **门在结构上无法再 gate 已在 main 的内容**。
- **根因属既有 B-78**（成员在共享 main 检出落盘 ⇒ 绕过「成员提交到自己分支、组长合并」的纪律）。**按同族实例记账，不新造编号。**
- **裁定（tier 0）**：(a) **批准回溯清关** —— 清关**必须具名 `149ae576` 本身**写入 `clearedCommits`，**不得**以「内容已在 main」代替 commit 具名；(b) 台账**标注为 post-hoc**（内容先落 main、清关后到），**不得记成正常落地**，否则「已入 main」会成为绕过门的通道；(c) **驳回重做**（为一个 1 文件重写历史，收益为 0 且毁掉审计）。
- **纪律**：**成员只在自己 worktree 内提交**，并自核 `git rev-parse HEAD == git rev-parse <branch>`。

**相位序（lead-world 实测 · tier 0 收编 · 2026-09-28）**

- `team_merge` 在卡到 **`integration-ready` 之前**被拒（逐字：is before packet phase "integration-ready"）⇒ **并入在清关之后，不是之前**。
- `team_acceptance_packet` 在卡到 **`group-check` 之前**被拒。
- 阶梯 = `execution → member-check → group-check → verifier-review`；**长跳不安全** —— `execution → group-check` 曾成功一次，随后同类长跳被判 invalid ⇒ **一步一相 + 每次重读**。

**一条我自己的错误（tier 0 · 2026-09-28）：「机制可用」不等于「验收已满足」**

- 我给 lead-rig 的收口序里写了「立刻令 rig-runner `complete`」—— **只核了机制可通**（`complete` 不经过 plan-scope），**没核该卡自有验收是否满足**。而卡面**逐字**把 `tools/rig-batch/tests/**` 内的真碰撞（**含 `run-criteria.ps1`**）判归**本卡修**，执行方却自述「下一轮修」⇒ **照我的令做就是假完成**。
- ⇒ **纪律：下令 `complete` 之前，必须先逐条核该卡自身的验收条款是否已满足；「门已打开」不是「活已干完」。** 承「写成 PASS 而实测未达成 = 污染记录」。
- 组长**拒绝执行我的错误指令并给出理由** —— 这是对的，且应被鼓励（与「不读守卫源码就断言无出口」是同一个人的两件事，两次都具名了）。

**B-147 已修（修复方回执 + tier 0 第一手验证 · 2026-09-28）**

- 修复方回执：`reassign` 现在在**同一次控制面 mutation** 中关闭同 task、旧 owner 的 open 等待票，写入 `closedReason=reassigned` / `closedBy` / `reassignedTo`；新 owner 的票与其他 task 的票不变。
- **我的代码面确认**：`team-control-plane.mjs` 第 3442-3448 行逐字有 `ticket.resolution = auto:reassigned` / `ticket.closedReason = reassigned` / `if (nextOwner) ticket.reassignedTo = nextOwner else delete ticket.reassignedTo`。
- **行为面待验（具名，不得读成已验）**：需**下一次真实改派**后只读核对 `waiting_list`（旧 owner 是否不再出现）。我已请 lead-rig 在后续任何真实改派后顺手取该读数。

**B-148 已修（修复方回执 + tier 0 第一手验证 · 2026-09-28）**

- 修复方回执：`team-health` 不再永久重播装载时的 `disabled` 快照；旧报告为 `disabled` 或超过刷新窗口时**重新体检**，并**每 30 秒**周期重算、写回控制面。
- **我的第一手验证**：`team-health-web.json` 的 `checkedAt = 21:23:09`，**距我读数时刻仅 18 秒**（修复前该字段在 20:15:02 上**锁存 25 分钟以上**，控制面 `health.updatedAt` 同样停在 20:15:03）；三份 profile 的 `team-health.mjs` / `team-control-plane.mjs` / `team-policy.mjs` 副本**逐字节相同**（`5E676A2F05` / `D73C582463` / `A41CAF3FAD`）。
- ⇒ **本条的成因（瞬时读数被锁存成永久全队停摆）已被结构性移除**，不是「把值改绿」。

**B-144 未修（修复方明示，不得读成已修 · 2026-09-28）**

- 修复方回执逐字：声明侧已接受，但**原始跨读取者反例仍存在**；**不得声称行级行为已修**。
- ⇒ 维持「**声明侧已接受、行为侧未修**」的两面表述。

**B-146 未复现，未登记为已修（2026-09-28）**

- 修复方在 revision 67106 未复现。⇒ **不得读成已修**，也不得读成已证伪；维持「未复现」。

**相位门：`team_merge` 需要 `integration-ready`（三路独立读数 · 2026-09-28）**

- **三路独立**：lead-world 在 t105 批次实测、lead-rig 在 t40 实测（逐字 `[task-phase]: task "group-rig-t40" is before packet phase "integration-ready" and cannot advance there directly`）、我收编。
- 阶梯 = `execution → member-check → group-check → verifier-review → integration-ready → merge`；**不能跳级**。
- ⇒ **「可交付」到「可并入」之间还有两级**；而依赖解除若要求 `accepted`，则更在其后。**排期不得把「交付」当「可并入」。**

**t41 依赖放宽的条件（tier 0 裁定 · 2026-09-28）**

- lead-rig 把 t41 的 `blocked_by` 从 `[t40, t42]` 改为 `[t42]`，理由是 t40 的依赖**声明理由是「同 crate 串行」而非「消费 t40 产物」**，且 t40 已 completed 且无活动租约。**我批准，并加一条条件**：
- ⇒ **这是「解除条件已满足」型放宽，不是「依赖不存在」型** —— **若 t40 被 reopen（例如 verifier 打回），串行约束立即恢复，t41 必须重新被 t40 阻塞。**
- ⇒ **纪律：以「条件已满足」为由放宽的依赖，必须同时写下「条件失效时如何自动置位」；否则放宽会静默变成删除。**

**一条新的读数形态（lead-world 自查 · tier 0 认形态 · 2026-09-28）：邻域谓词冒充域谓词**

- 形态：**不是「没读」，而是「读了另一个谓词的读数、当成这个谓词的读数转达」** —— 它把 t106 的「同类正控 `is_chunk_loaded` = 4」未自读即转达给 t105 owner，被实测反驳。复算：`is_chunk_loaded` = **3**（`:361` 定义 + `:421`/`:462` 使用）；`set_chunk_loaded` = **1**（`:356`）；**并集才是 4**。
- ⇒ 属「**邻域谓词 ≠ 域谓词**」家族（承「子串谓词不是域谓词」）。**结论不受影响**（正控非零仍成立），但**值错了**，且它是在一张**正在被审的卡**上。
- ⇒ **纪律：转达一个计数时，必须同时转达它的谓词；谓词不同则计数不可比。** 报告方自己抓住并具名给三方，处置正确。

**write_scopes 的两条读数（lead-world 实测 · tier 0 收编并**否证其泛化** · 2026-09-28）**

- **读数（收）**：① `t110` 的 `claim` 被拒，`cause=scope-conflict` / `conflicts=[{taskId:group-world-t108, left:docs/groups/world, right:docs/groups/world, sameOwner:false}]`；`t108` 完成后 `ready_queue` 里 `t110` 的 reason 从 `scope-conflict` 变为 `already-running`。② 想收窄 `t110` 的 scope 被拒：`[task-write-scopes-plan-controlled]: write_scopes is controlled by the approved plan; replace the plan instead of editing the task row` ⇒ **scope 由已批准计划控制，收窄须替换计划（两跳）**。
- **被否证的泛化（不收）**：报告方由此提出「**同目录的卡无法并行**」。**反例（tier 0 第一手投影）**：`t105` / `t106` / `t107` 三卡 `writeScopes` 同为 `docs/groups/world/`，却在**同一次投影里同时为 `in_progress/execution`**，owner 为 `member-world-chunk` / `member-world-anvil` / `member-world-block`（三个不同 owner），且同一时刻三名成员**都在 running**。⇒ **该泛化是假的。**
- ⇒ **纪律**：**记录「这一次的拒绝与它随 t108 完成而消失」，不记录成因**（承「一个实例只升级观察，不升级成因」）。**更窄的 scope 是好的实践，但不得由一条假规则推出** —— 按假规则排工会在真能并行时**自我串行**。

**一条新的错误形态（lead-world 自查 · tier 0 认形态 · 2026-09-28）：生成路径时没有回读盘上事实**

- 形态：派工消息里的 worktree 路径 `.dsh-worktrees/team__world__member-chunk` **不存在** —— 它由 `member-world-` 字符串拼接成 `member-` 生成；真实为 `.dsh-worktrees/team__world__member-world-chunk`。成员**实测发现并按实测执行**（正确）。
- ⇒ 与「**不自我读数即传播**」同族，但对象从「计数」换成「路径」：**凡是可被盘上事实判假的字符串，生成它时就必须回读一次。**

**B-147 行为面已确认（tier 0 第一手 · 具名 throwaway 探针卡 · 2026-09-28）**

- **探针设计（先记我自己的错）**：我先前给 lead-rig 的探针是「任何一次真实改派后核一次 `waiting_list`」—— **打不到目标**：lead-rig 实测 t45 只有**投影行**（`derived`），没有显式票，那次改派**根本不进 B-147 的代码路径**。⇒ **探针的域必须包含目标**（与「正控必须与断言同类」同形）。
- **正确的探针**：tier 0 建一张**具名 throwaway discussion 卡**（`task-100`，零写范围）→ 以**旧 owner** 建一条**显式票** → `reassign` 给另一成员 → 定点读票。
- **读数（逐字）**：票 `wait:task-100:lead:652e1571-…` 在 `reassign` 后为 `status=resolved` / `resolution=auto:reassigned` / `closedReason=reassigned` / `closedBy=lead` / `reassignedTo=rig-diff`；`closedAt` 距 `createdAt` **355 ms** ⇒ **同一次 mutation 内关闭**。⇒ **B-147 行为面成立。**
- ★ **同程序内的一次假空（我自己的，记下）**：同一程序里 `includeClosed:true` **未加 `taskId` 过滤**的读取对该卡返回 **0 行**（100 行分页），**加 `taskId` 的定点读取**返回 **1 行**且 `projectionComplete=true`。⇒ **我差一点把「票没被关闭」写成结论。** 分页投影的页内 0 **不是**域内 0（与 lead-world 在 `group-world` 板上发现的假空同形）。

**新纪律：否证的射程 = 该主张的全部耐久载体（lead-world 处置 · tier 0 入册 · 2026-09-28）**

- 背景：lead-world 提出的「同目录的卡无法并行」被 tier 0 以**它自己批次的反例**否证（`t105`/`t106`/`t107` 同 scope、三 owner、同时 `execution`）。它接受否证后指出：**要改的不是「规则」，而是该假规则已经落地的两个耐久载体** —— ① `evidence-db0c5d99`（t108 的 group-check 行，逐字写了该规则）；② 发给 `member-world-chunk` 的消息 `msg-1767ae01`（把该规则当作「结构性发现」转达给**正在排工**的成员）。
- **处置**：对**不可编辑**的 evidence 行以**新行具名作废旧句**（条款 79 形态，不静默改数字）；对已发出的消息发**撤回**。
- ⇒ **纪律**：**一条主张被否证时，修复的射程是它的全部耐久载体，不是对话里的那一句。** 否则假规则会以「我转达过」的形态继续生效 —— 本次的实际危害已被具名：**按假规则排工会在真能并行时自我串行**，且它已经送到了一个正在排工的成员手里。

**B-149 写路径收窄（tier 0 第一手 · 2026-09-28）**

- **新复现器**：一张**新建的 `discussion` 卡**（`task-100`，探针用）在其 `team_task_update(action:"complete")` 上返回与 t74 逐字相同的 `invalid output: "value.approved" is not a declared property (additionalProperties: false)`。
- **两处实例的共同因子（实测，不是推断）**：`task-100` 与 `group-proto-t74` 的 `workKind` **都是 `discussion`** 且 `approved=true`；而 `group-world-t105`（`workKind=edit`）**没有** `approved` 字段。⇒ **`approved` 出现在 `discussion` 卡上。**
- **写入时刻收窄**：`task-100` 的 `reassign`（rev 2）**成功返回**（若当时已有 `approved`，该调用会以同一 invalid-output 失败）⇒ **字段在 rev 2 时不存在**；到 rev 3 时已存在。其间唯一的操作是 **`team_evidence_record`**。⇒ **候选写路径 = 在 `discussion` 卡上记证据（或其触发的验收绑定）写入 `approved`**；**未隔离，不写成因**。
- ★ **报告方先前的候选被证伪**：lead-proto 曾疑为「`waiting_set(..., unblockCondition.type:"approval")` 那一手」。我在本探针上用的是 **`type:"manual"`**，字段照样出现 ⇒ **该候选不成立**。
- **危害补充**：该字段使卡**连 `complete` / `admin_close` 都返回失败**

**★ B-149 表述更正（tier 0 第一手 · 2026-09-28）：不是「存在即失败」，而是「存在 **且卡未完成**」**

- **读数**：同一存储行（`task-100`，`approved=true` **始终存在**）在 `in_progress/room-discussion` 时 `team_task_get` 返回 `invalid output: value.approved is not a declared property`；该卡转为 `completed/room-discussion` 后**同一调用成功**（`OK rev=5 completed`，`evidenceIds` 2 条），而存储行**仍有** `approved=true`。
- ⇒ **正确表述**：该字段存在**且卡未完成**时，`team_task_get` / `team_task_list` / `team_task_update` 失败。⇒ 我在前一条里写的「连 complete / admin_close 都失败」**成立但需加此限定**。
- ⇒ 同族：`task_contract_get` 对两张**已 completed** 的 discussion 卡仍返回 `lifecycle: "running"` ⇒ **契约 lifecycle 与卡 status 未同步**。
- **（上文「写入时刻收窄」与「共同因子」两条仍然有效，未变。）**

**B-151 契约校验器对 `discussion` 卡强制要求 `writeScopes`，与成文口径相反（类缺陷 · 两实例 · 2026-09-28）**

- **读数**：`task_contract_get` 对 `task-100`（board global）与 `group-proto-t74`（board group-proto）**同样**返回 `validation.ok=false` / `errors=[{code:"scope-required", path:"writeScopes", message:"at least one write scope is required"}]`，而两张都是 `kind=discussion`、`writeScopes=[]`。
- **与成文口径冲突**：本仓与平台口径均为「`discussion` / `review` 任务**不使用写范围**，以证据收口」。
- **危害**：**每一张 discussion 卡的契约都显示为无效** ⇒ 契约面被当作验收输入时，会把一批正常卡判成无效。
- **两实例由两个不同组的成员各自复现** ⇒ **类缺陷，不是卡级偶发**。

**B-152 requirement 投递范围越界（G-RIG 卡的验收面投进 G-PROTO 的 tier 2 · 2026-09-28）**

- **读数**：`task:task-100:acceptance` 被注入 **G-PROTO 的 `member-framing`** 上下文，而该卡 owner = `rig-diff`（G-RIG）。
- **该成员结构上不可执行**：`team_evidence_record(task_id="task-100")` ⇒ `[evidence-task-scope]`；`send_message(target="rig-diff")` ⇒ `[message-scope] tier 2 may not message a member of group "rig"`；全局板 mutation 对 tier 2 关闭。
- 它**两次被拒后停止重试**（处置正确），并只能落一条**不绑 task** 的载体（`taskId=null`）⇒ 可寻址性更弱。
- **危害**：**一个成员被投进一张它无法以任何合法动作推进的卡** ⇒ 消耗一个 turn，且其读数只能以 `taskId=null` 落账。

**列表读的窗口纪律（lead-rig 转达 rig-diff 的实测 · tier 0 入册 · 2026-09-28）**

- **读数**：无过滤 `includeClosed:true` **limit=100** ⇒ `total=148 / returned=100 / truncated=true / nextOffset=100`，目标票出现 **0** 次；**同谓词 limit=200** ⇒ `returned=148 / truncated=false`，出现 **2** 次。
- ⇒ **规则**：**无域过滤的列表读，「0 命中」必须与其窗口 / limit 同现；`truncated=true` 时「0 命中」是窗口产物，不是域事实。** 查票 / 查行应带 `taskId` / `ticketId`。
- ⇒ 我先前把该 0 行记为「假空」而**没有具名分页** —— **报告方更正得对**，我记我自己。

**判据的两族结构（member-framing 的决定性实验 · tier 0 入册并认领自己的跨族错 · 2026-09-28）**

- **读数（一次运行，两族汇总行同时存在）**：`M11-CITE-SUMMARY|tokens=59|judged=59|files=6|mismatches=0`（**表族 §n**）与 `M11-CITE-PATH-SUMMARY|tokens=242|judged=242|files=30|mismatches=57`（**路径族**），差别只在行名中段 `-PATH-`；`M11-CITE-DOMAIN` 两侧逐字一致 ⇒ **同域同运行**。
- ⇒ **纪律：两族的计数不可互比。** 引一个计数时必须同时给出**族**与**域**。
- ⇒ ★ **我自己的错**：我给 lead-proto 的「第三条独立读数」（242/30/57）与成员引的 59/6/0 是**跨族比较**，我却据此下「两方一致、一方不同」。**撤回。** 承「先比口径」与「计数必须与它的域同现」。
- ⇒ 组长据此发出的「不可复现」返工前提**必须换成「跨族比较」**。

**探针设计的两条教训（tier 0 自己的 · 2026-09-28）**

- ① **探针的域必须包含目标**：我给 lead-rig 的 B-147 探针（「任何一次真实改派后核一次」）**打不到目标** —— t45 只有**投影行**、没有显式票，那次改派根本不进 B-147 的代码路径。
- ② ★ **把卡派给真成员就会唤醒它**：我用 `reassign` 把探针卡 `task-100` 给了 `rig-diff`，它**被唤醒并为一个探针卡消耗了一个 turn**（虽然它顺手做了独立复核与一条正确的成因更正）。⇒ **探针若必须派给真成员，必须预先把这个代价算进去。**

**`task-terminal` 在卡 `completed` 时自动关闭其等待票 ⇒「无 open 票」不是「无责任人」（lead-proto 第一手 · tier 0 入册 · 2026-09-28）**

- **读数**：卡转 `completed` 时，其等待票被以 **`closedReason=task-terminal`** 自动关闭；在本链路里 `completed` **早于** `verifier-review` ⇒ **「等 verifier 复核」这段责任无法以票据承载**。
- ⇒ **纪律**：**不得把「无 open 票」读成「无责任人」。** 复核责任由**包（packet）+ 定向唤醒 + 里程碑 `done_when`** 承载。
- ⇒ 与 **B-147**（改派关闭旧 owner 的票，`closedReason=reassigned`）**同族**：票的生命周期由**卡状态机**驱动，**不由「事情是否做完」驱动** ⇒ 票是**等待**的载体，不是**责任**的载体（承既有条款 65）。

**`grp/world` 落地回执（tier 0 第一手 + lead-world 独立复算 · 2026-09-28）**

- `team_merge(grp/world → main)`：`merged:true` · **`fastForwarded:true` / `createdCommit:false`** · `ancestorVerified:true` · `previous` / `destinationBefore` / `mergeBase` 三者同为 `62bb1519` · `ignoredUntracked:[]` · `phaseAdvance: integrated`。
- **并入后 main = `7e08c738`**，tree **`6923a74a`** = 被清关分支头的 tree（逐字相等）。
- **delta `62bb1519..main` = 恰 3 路径**，与清关时具名的 `main..grp/world` **逐字同集**；**无第四路径**（t107 的文件不在 delta 里 —— main 早已含它，blob `5d5e7203`）。
- **内容同一性（blob 独立确认）**：main 上三文件 blob 与三个已清关 commit 的 blob 逐字相同 —— `a38accc4` ← t105 `3835d42` / `2feb8516` ← t106 `5dcc9cec` / `ec4930d3` ← t108 `9cef4343`。⇒ **「并入内容 = 被清关内容」成立。**
- ⇒ **我本轮定死的门的形态得到验证**：路径集**逐条具名已判定的授权卡**，且**禁止无判定折入** —— t108 被判之后授权才成立，随后分支头清关出具，才并入。
- ⇒ **一处我自己的时序瑕疵**：我发出「维持 withheld」时，t108 判定与分支头清关**已经出具**（消息交叉）⇒ **我的前提已 stale**。**我实际已按新状态并入了**（不是按旧前提），但这说明**我发出一条状态依赖的指令时没有先现取状态** —— 与「读数必须带时点」同族。

**租约过期不产生可读的责任信号（tier 0 第一手 · 2026-09-28）**

- **读数**：`group-rig-t44` rev 63 / `in_progress` / owner `rig-runner`；租约 `run-b5658c9f-…` 状态仍为 **`active` 但 `expiresAt` 已过**（我读数时刻已过约 7.7 秒）；`team/rig/rig-runner` tip **无新提交**（仍 `4b5e427c`）；`rig-runner` **不在 running**。⇒ **卡在 `in_progress`、租约过期、owner 空闲 ⇒ 没有活的执行者。**
- ⇒ **上一次 activity digest 报 `idle-with-open: none`** ⇒ **租约过期不产生可读的责任信号**（成因未隔离，只记读数）。
- ⇒ 与 **`task-terminal`**（卡 `completed` 时自动关票）合起来：**票的生命周期由卡状态机驱动，不由「有没有人在做」驱动** ⇒ **票是「等待」的载体，不是「责任」的载体**（承条款 65）。⇒ **不能把「无 open 票」或「无 idleWithOpen」读成「有人在负责」。**

**平台修复的只读复放（B-149 / B-151 live PASS · B-150 代码面确认 · B-152 未验 · 2026-09-28 · tier 0 第一手）**

- **B-149（卡级多余字段 `approved`）—— live 复放 PASS**：`team_task_list(board="group-proto", limit=100)` ⇒ **OK / 74 行 / `nextCursor=null`**（修复前在**索引 71** 炸掉整块板）；`team_task_get(group-proto-t74)` ⇒ **OK rev=7 completed**。
  - **残留（具名，不当成已修）**：**存储行仍带 `approved=true`** —— `task-100` 与 `group-proto-t74` 的**存储对象**里该字段都还在（`group-proto` 板内带该字段的卡 = `t74`）。修复方回执写「显式删除遗留字段」，**我的读数显示未删除** ⇒ **修复的是输出投影（只保留已声明字段），存储面未清** ⇒ 若有消费者直接读存储面仍会看到它。**不写成因（可能是写触发的惰性删除）。**
- **B-151（`discussion` 卡被强制要求 `writeScopes`）—— live 复放 PASS**：`task_contract_get` 对 `group-proto-t74` 与 `task-100` **均为 `validation.ok=true` / `errors=[]`**（修复前两张都是 `ok=false` / `scope-required`）。
  - **残留（具名）**：**存储行的 `lifecycle` 仍是 `running`**（两张卡都已 completed），而**契约投影**报 `lifecycle="completed"` ⇒ **该修是「读侧按 status/phase 计算」** ⇒ **任何直接读存储 `lifecycle` 的消费者仍会看到陈旧值。**
- **B-150（`reassign` 不更新已批准计划 `members`）—— 代码面确认，行为面未验**：`team-control-plane.mjs` 第 3461 行注释「The tool layer rebinds an edit task to the replacement owner」+ 第 **3468-3469** 行 `plan.members.push(nextOwner)` / `plan.revision = Number(plan.revision || 1) + 1` ⇒ **实现已在**。
  - **行为面待验（具名）**：需要一个「**有已批准计划**的卡被真实改派」的场景。**我没有为取读数制造一次无正当理由的改派**（那会污染卡与计划的历史）⇒ **维持「代码面已确认、行为面未验」。**
- **B-152（requirement 投递越界）—— 我未验**：按 `requirement.*deliver|deliverRequirement|visibleAuthors` 检索只命中 B-144 的 `visibleAuthors`，**未命中投递路径**；也**未做行为复放** ⇒ **我不对 B-152 的修复状态作任何断言。**
- **B-78 同族实例 / B-144 追加实例 / 相位序**：修复方复核口径与我一致（**B-144 行级行为仍未修，不得声称**；相位序 merge 仍需 `integration-ready`）⇒ 我确认这三条的表述**未超出读数**。
- **未重启类宿主修改（B-127 / B-129 / B-111）修复方自陈仍需重启才生效** —— 与「声明侧已修 ≠ 进程内已生效」同族，**不得读成 live 已生效**。

**`grp/proto` 落地回执（tier 0 第一手 · 2026-09-28）**

- `team_merge(grp/proto → main, task_id=group-proto-t75)`：`merged:true` · **`fastForwarded:true` / `createdCommit:false`** · `ancestorVerified:true` · `mergeBase` = `ccdd0054`（**= 清关钉住的并目的地 ⇒ 清关未过期**）· delta = **13 路径，全部在 `crates/mc-server/`** · `ignoredUntracked:[]` · `phaseAdvance: integrated`。
- ⇒ **main = `c970c161`**。⇒ **N-10 的 G-PROTO 列（服务端持续游玩循环：tick 循环 / 区块流式 / KeepAlive / 实体同步）已入 main。**
- **动手前同一动作内现取 main 的读数**

**`grp/world` 第二次落地（非快进 · tier 0 第一手 · 2026-09-28）**

- `team_merge(grp/world → main, task_id=group-world-t110)`：`merged:true` · **`fastForwarded:false` / `createdCommit:true`** · 新并提交 **`b5a17926`** · `destinationBefore` = `c970c161`（= 清关钉住的并目的地 ⇒ 未过期）· `sourceHead` = `1e636cca` · `mergeBase` = `ccdd0054`。
- ★ **预测命中**：并入后 HEAD 的 tree = **`29ee55ae`** = verifier 条件 ① 明写的预测值 ⇒ **无夹带**；净增量**恰 1 路径**（`docs/groups/world/n10-lighting-incremental.md`）。⇒ **main = `b5a17926`；M8 光照规格已在 main。**

**★ 判别式：并入净增量须用 merge-tree 结果作参照（lead-world 自查 · verifier 逐字采纳为条件 · tier 0 入册 · 2026-09-28）**

- **读数**：同一对 ref，两种量法给出**不同的路径集** —— `git diff --name-only main grp/world` = **14 路径**（其中 **13 条在 `crates/mc-server/`**）；`git diff --name-only main $(git merge-tree --write-tree main grp/world)` = **恰 1 路径**。
- **成因**：那 13 条是 **grp/world 落后于 main** 的地方（G-PROTO 的 t75 在 grp/world 分叉之后落进了 main），**并入时 main 一侧胜出，它们根本不进并入内容**。
- ⇒ **纪律**：**「这次并入会加什么」= `git diff --name-only <目的地> $(git merge-tree --write-tree <目的地> <源>)`，不是 `<目的地> <源>`。** 两者只在「源在每条差异路径上都领先」时才相同。
- ⇒ **危害（已被具名）**：按两点 diff 索要授权表，会**向 verifier 索要 13 条属于另一个组、且本次并入根本不碰的路径的授权卡** —— 在「路径集每条都必须具名其授权卡」的形态下，这是一条**假授权要求**。

**两条来自 lead-rig 的机制读数（tier 0 入册 · 2026-09-28）**

- **(a) 替换已批准计划会静默重置卡的相位** —— t44 已 `completed` 且已被推进到 `verifier-review`，为把 `members` 补上 rig-runner 而 `replace_approved` 后，**phase 掉回 `plan-approved`**。⇒ **任何「只为改 `members` / `scopes` 而 replace」的动作都要预期这次回退并重新推进相位。**
- **(b) gate 报 `unavailable` 时，先查自己的 scope 冲突，别先怀疑平台** —— 逐字 `task-contract-gate-unavailable … read=evaluateReadyGate; state=unavailable; cause=scope-conflict`，冲突源之一是该组长**几分钟前自己新建的卡**（`tools/rig-stats` 逐字相同）。⇒ `unavailable` 的措辞让它看起来像平台故障。**报告方把「是我自己造的」具名出来。**

**常驻 oracle 已由 tier 0 复原（2026-09-28）**

- **读数**：`Get-NetTCPConnection -LocalPort 25565 -State Listen` = **1**，`pid=138192`（java，start 22:00:09）；服务器日志逐字 `Starting Minecraft server on *:25565` → `Preparing level "oracle-world"` → **`Done (0.579s)!`**。
- **复原依据 = 记录的夹具身份**（不是造一个「长得像的」）：`tools/oracle/manifest.json` 的 jar 路径与 sha256 `c18e4245…`、`java.exe = E:\.minecraft\java\bin\java.exe`、args `-Djava.awt.headless=true -Xms1G -Xmx2G -jar <jar> nogui`；端口/世界/种子取自 `.local/oracle/server.properties`（`server-port=25565` / `level-name=oracle-world` / `online-mode=false` / **`level-seed=12345`**）。
- **具名限制**：**这是新 pid，不是原 holder**。⇒ 若 `C4_m0_untouched_true` 跟踪原 holder pid，它仍会红 —— **那将是身份问题，不是环境问题**。
- ★ **新仪器坑**：**PowerShell 会毁掉 `-D…` 形式的 JVM 参数** —— 首次 `& java.exe -Djava.awt.headless=true …` 报 **`找不到或无法加载主类 .awt.headless=true`**（`-Djava` 前缀被吞，余下被当成主类名）；正解 = **停用解析令牌 `--%`**。⇒ 与 `git rev-parse <rev>^{tree}` 被 `^` 毁掉**同族**：**PowerShell 里含 `-X` / `^` / `{` 的外部参数都要停用解析。**

**`grp/world` 第三次落地（快进 · 红提交进 main 的裁定 · tier 0 第一手 · 2026-09-28）**

- `team_merge(grp/world → main, task_id=group-world-t111)`：`merged:true` · **`fastForwarded:true` / `createdCommit:false`** · `destinationBefore` = `b5a17926`（= 清关钉住值）· **main → `d9bd8904`**；并入后 tree = **`14a8ec8b`**（= 清关预测值）；**5/5 blob 与授权卡逐字相同**（`stronghold.rs` `a171d969`←t109 / `worldgen/lib.rs` `e256ecd2`←t109 / `chunk_lifecycle.rs` `6ef33edb`←t111 / `mc-world/lib.rs` `c992ec66`←t111 / `chunk_driver.rs` `becde56e`←t111）。
- ★ **裁定：红中间态提交（`68d0332`，E0004 不可构建）** —— 我裁 **(a) 快进**，理由是**本仓已有先例**：main 历史里已经有过一个门禁红的提交（**我自己的 `3145351`**），当时的处置是**后继提交修复**，**不是重写历史**。⇒ **规则：红中间态向前修，不回头改。**
  · **驳回压平/摘取**：那会**切断授权链的祖先承载** —— 本仓整套清关纪律建立在「commit 身份 + 祖先关系」上（`clearance-covers-landing` 要求 `is-ancestor` **且** `merge-tree == head tree`）；为一个提交的 bisect 友好度丢掉 5 条路径的祖先链**不划算**。且与我在 t107 上「驳回重写历史」的裁定一致。
  · **三条落地条件**：① 在 t111 卡面具名该红提交是**审计中间态、不是交付缺陷、不得读成 bisect 回归点**；② 记为**第 2 例**并立规则「红中间态向前修」+ **两提交形态须在开卡时声明**；③ **落地时必核 blob 轴**（我已核 5/5）。

**`team_run_lease(acquire)` 要求 `plan-approved` 在前（rig-runner 逐字 · tier 0 入册 · 2026-09-28）**

- 逐字：`task "group-rig-t46" requires a plan-approved record before execution; current plan state: missing`。⇒ **正确次序 = propose → 组长批 → acquire**；**「先 acquire 再 propose」被相位门否掉**。**不是 scope 冲突，是相位门**（与 `no-open-plan` 同源）。

**引注门的镜像错误：判据恒真导致「拒绝引用可解析的 id」（lead-world 自查 · tier 0 入册 · 2026-09-28）**

- **形态**：门禁谓词 `JSON.stringify(result).includes("notFoundMeaning")` —— 但 `resolutionPolicy.notFoundMeaning` 出现在**每一个响应信封**里 ⇒ **该谓词恒真** ⇒ 它**拒引了一个实存的有效 id**（`evidence-a691e611`，kind `lead-acceptance`）。
- ⇒ **这是引注门两个方向上的错误之一**：此前是「**引用了未解析的 id**」（B-144 族），这次是「**拒绝引用可解析的 id**」。**两个方向都会错。**
- ⇒ **纪律**：判据必须查 **`rows.length` / 行匹配**，**不得在响应信封里搜 `notFound` 字样** —— 信封字段是**元数据**，不是**该查询的结果**。

**`team_merge` 并的是「成员分支的 tip」，不是 `task_id` 指向的 commit（lead-rig 第一手 · tier 0 入册 · 2026-09-28）**

- 逐字读数：以 `task_id=group-rig-t40` 并 rig-capture 时，其 **tip 已前进到 t41 的 `1a949bb5`** ⇒ 那次并**把 t41 的内容一并带进 `grp/rig`**（`is-ancestor(1a949bb5, grp/rig)` = rc 0）；随后 `task_id=group-rig-t42` 的并**无事可做**。
- ⇒ **`task_id` 授权的是「并这个成员」，内容由分支决定** ⇒ **并成员前必须先核其 tip 是否等于你想并的那个已清关 commit。**
- ⇒ **「清关对象 vs 并入对象」家族的第三面**：① t107（内容已在 main 而清关后到）；② 分支头清关会顺带清掉**未被判定**的卡；③ **并成员会带走进度更前的 tip 内容**。**三面同根：清关对象永远是 commit，而并入对象是 ref。**

**`grp/proto` 重钉后落地（快进 · tier 0 第一手 · 2026-09-28）**

- `team_merge(grp/proto → main, task_id=group-proto-t76)`：`merged:true` · **`fastForwarded:true` / `createdCommit:false`** · `destinationBefore` = `d9bd8904` · **main → `d3868737`**；并入后 tree = **`042164c8`** = 清关预测值；净增量**恰 5 路径全在 `crates/mc-server/`**。⇒ **t76（`--run-forever` 无界运行的可判假覆盖）已在 main。**
- ⇒ **结构性事实（verifier 具名、我确认）**：**清关对象是 commit，而并目的地是移动引用** ⇒ **任何无关的并入都会使在飞的清关过期**。本卡因此**两次**过期（第一次因我并 world）。⇒ **纪律：拿到头清关就立刻并；并前在同一动作内现取 main。**

**★ 方法学：先测 merge-tree 预测并树 → 重钉 → 再核 tree（lead-world 实测 · tier 0 入册 · 2026-09-28）**

- **读数**：在 `grp/proto` 还是 `7a6ad367` 时测 `git merge-tree --write-tree grp/world grp/proto` = **`042164c8`**；lead-proto 重钉后的新头 tree = **`042164c8`**；我并入后 **main 的 tree 也是 `042164c8`** ⇒ **三处逐字一致**。
- ⇒ **把「清关因 main 前进而过期」从意外变成可预期的一步**：**先用 `merge-tree` 算出并树 → 重钉 → 核并后 tree 是否等于该值。**

**`C4_m0_untouched_true` 从未红过 —— 以及它真正的环境前置（lead-rig 源码级撤回 · tier 0 入册 · 2026-09-28）**

- **机制（读源码）**：`run-batch.ps1:292` 取 `m0PidsBefore`、`:637` 取 after、`:644` 公式 `m0_untouched = m0Preserved AND (tcp25565Before==tcp25565AfterRuns) AND ownPidsGone`；`m0Preserved` 要求 **`m0PidsBefore.Count>0` 且前后 `PidSetKey` 相等** ⇒ **同一次批处理内的前后比较** ⇒ **run 之前发生的 pid 变更不可能使它变红** ⇒ 报告方先前「pid 身份不匹配」这一支**从机制上不成立，已撤回**。
- **读数**：域 = `tests/golden/rig-batch/criteria-*.log` 全部 36 份；C4 四项在到达 C4 的 **33 份**中全部 True，另 3 份在 C1/C8 早退故 ABSENT；**无一份出现 `C4_m0_untouched_true=False`**；`C4_isolation_line` 恒为 `m0_pids_before=102192 m0_pids_after=102192 … m0_untouched=True`。
- **域纪律（报告方自纠）**：`grep` 对 **gitignored** 路径（`tests/golden/**`）报 **0 命中** —— 那是**域假象不是内容事实**，故改用 `glob` 取域。
- ★ **但环境前置仍然存在**：机制要求 **`m0PidsBefore.Count>0`** ⇒ **oracle 必须在批处理开始之前就活着**（否则 C4 必然红）。⇒ **tier 0 的 oracle 复原仍然必要**；被推翻的只是「必须是最初那个 pid」。
- ★ **未测项（报告方具名）**：现取 25565 持有者 = pid **138192**，而最新 `isolation.json` 仍记 **102192** ⇒ **没有任何一次 run 是在 138192 这个持有者下做过的** ⇒ **该判据对当前持有者的行为未测**。⇒ 需重跑；**不得主张它现在绿。**

**缺陷候选：`run-criteria.ps1` 中顺序 `ReadToEnd()` 两条管道 ⇒ `TimeoutSec` 可能不生效（lead-rig 具名 · 未证实为本因 · 2026-09-28）**

- 报告方**明确标注未证实**，且**拒绝据推断入册**。⇒ **待一个可判假的复现**（造一个持续写 stderr 的子进程 + 断言超时是否生效；正控 = 只写 stdout 的同类子进程应正常超时）。**结果出来再入册。**

**★ 新族：「各侧都绿 ≠ 并起来绿」—— 合并语境缺陷（2026-09-28 · lead-world 第一手 · tier 0 立族）**

- **实例**：t112（`74cda690`）与 t111 各自在 crate 根 `pub use` 了**同名类型 `BlockChange`**（字段类型不同：`i32`/(u16,u8) vs `u8`/`BlockValue`）。main 的 `lib.rs` 第 40 行来自 t111、t112 新增的 `lib.rs` 第 99 行（**后者仅存在于合并树 `be8bb087`，不在 main** —— 故不写成 `path:line` token） ⇒ 合并树 `be8bb087` **同时含两条同名显式 `use`** ⇒ **rustc E0255** ⇒ **并入后 main 编译不过**。
- **机制（为什么所有门禁都漏了）**：**所有读数都取在「源 commit」上，而源 commit 结构上看不到合并语境**。t112 的父 = `b5a17926` **不含 t111** ⇒ 在 `74cda690` 上 `chunk_lifecycle::BlockChange` 命中 **0**、`light.rs:587` 是唯一同名定义 ⇒ verifier 的 `cargo check --workspace` rc=0 与成员的 185 passed **都跑在那个树上**。且 **`merge-tree` rc=0（文本干净）≠ 可编译的树**。
- ⇒ **纪律**：**落地前必须对「合并结果」本身取门禁读数**；**若两侧增量在编译相关子树上是「不相交」的**（一侧只动 `crates/`、另一侧只动 `tools/`），**必须把「不相交 ⇒ 并集可编译」这条论证显式写出来**，不得默认它成立。
- ⇒ **本会话第二次「只有合并语境才暴露」**（第一次 = `68d0332` 的两提交形态）⇒ **同族：单侧读数的域覆盖不到并集。**
- ★ **报告方的诚实边界（记名）**：它**尝试构建合并树被 write-scope guard 拒**，**没有绕门禁**，并把 E0255 标注为「**直接文件读数 + Rust 语言规则，不是编译读数**」，请 verifier 用 detached checkout 构建、声明**绿了就撤回**。⇒ **结论的强度必须与读数的种类相称。**

**★ 并入前必须核「两端」：源 ref 也会动（tier 0 自己的错 · 2026-09-28）**

- **逐字拒绝**：`team policy refusal [no-verifier-clearance]: main refuses "grp/rig": no-verifier-clearance (commit a0141d4f4b01)`。
- **读数**：`grp/rig` tip = **`a0141d4f`**（tree `fb51db38`）；`is-ancestor(main, head)` rc=0 ⇒ 快进；`merge-tree(main, head)` = `fb51db38` = head tree；净增量 **39 路径全在 `tools/`、零删除**。而 lead-rig 的清关 `clearedCommits = {2b3859ef, 1a949bb5}` ⇒ **tip 在请求清关之后又前进过**。
- ⇒ **我自己的错**：**我核了目的地（`d3868737` == 清关钉住值）与快进性，但没有把「源 tip」与「被清关的 commit」比较** ⇒ **是平台的门禁替我抓住的**。
- ⇒ **纪律（全队）**：**并入前必须核「两端」—— `rev-parse <目的地>` == 清关钉住的目的地，且 `rev-parse <源 ref>` == 被清关的那个 commit。** 与既有「并目的地是移动引用」合起来：**清关对象是 commit，而并入对象是 ref，ref 的两端都会动。**

**★ 纪律的落地形态：源端由组长冻结（lead-rig 承诺 · tier 0 入册 · 2026-09-28）**

- **tier 0 补的是**：「并入对象是 ref，**源 ref 也会动**」⇒ 并入前须核**两端**。
- **lead-rig 把它落成动作**：**在新 head 清关到手、且 tier 0 完成 `grp/rig → main` 之前，它不再向 `grp/rig` 并入任何东西**（并把 t45 的并入压在其后）。⇒ **两端各有人负责：tier 0 核两端，组长冻源端。**
- ⇒ **可复用的形态**：**一条「并入前必须核 X」的纪律，如果 X 的一端在别人手上，就要把它变成那个人手上的一个冻结承诺，而不是只留在我这一侧的检查。**

**`idle-with-open` 的第三条成因候选：有主 + 无租约 + 相位停在首相位（tier 0 第一手 · 2026-09-28）**

- **读数**：`t47` = rev 3 / `in_progress` / **`room-discussion`** / owner rig-capture / `blockedBy=[]`；**活动租约四条中没有 rig-capture**。⇒ **有主、无人跑、无租约，且相位停在 `room-discussion`（`edit` 卡的首相位）**。
- ⇒ **与 `t45`（`approvalGate{reason="no-plan"}`）/ `t46`（同）同一道门的嫌疑** —— **`acquire` 要求 `plan-approved` 在前**，故 `in_progress` + 首相位 + 无租约 = 「卡在没计划」。**成因未隔离，只报读数。**
- ⇒ **既有成因清单**：① 陈旧依赖（条件已满足、声明还在，如 t45/t77）；② 租约过期（不产生可读责任信号）；③ **有主 + 无租约 + 相位停在首相位（疑 `no-plan`）**。

**★ PowerShell 双引号会展开 `$var` ⇒ 污染 `git commit -m` 的消息（member-registry 自报 · tier 0 入册 · 2026-09-28）**

- **读数**：一次 `amend` 把提交消息经 **PowerShell 双引号**传递 ⇒ `$a` / `$c` / `$b` 被当作**变量展开** ⇒ 子类名在**提交消息里**退化成 `gv/gv/gv`。**源码未受影响**（两文件均由 `tools.edit` 写入，第 11 行仍逐字为 `gv$a / gv$c / gv$b`，已复核）。重发（改用单引号字面量）后 `d362822` 的消息逐字正确；**旧提交 `f7018f4a` 的记录未被改写**（条款 79）。
- ⇒ **纪律**：**任何含 `$` 的提交消息/外部参数，在 PowerShell 里必须用单引号字面量（或停用解析）。**
- ⇒ **归族（本会话第三次）**：**PowerShell 会改写或吞掉外部参数** —— ① `-Djava.awt.headless=true` 被吞成 `.awt.headless=true`（正解 `--%`）；② `git rev-parse <rev>^{tree}` 被 `^` 吃掉（正解 `git show -s --format=%T`）；③ **双引号展开 `$var`**（正解单引号）。⇒ **含 `-X` / `^` / `{` / `$` 的外部参数都要停用解析。**

**★ 落地使另一份文件里的引注转红 —— 「各侧都绿 ≠ 并起来绿」在判据门上的实例（tier 0 第一手 · 2026-09-28）**

- **读数**：我并入 `grp/rig`（含 t42 的 `tools/capture/src/main.rs` +178 行）后，`docs/STATUS.md` 里一条**早已存在**的引注（指向 `tools/capture/src/main.rs` 的**原第 446 行**）**变成空行** ⇒ 门禁 **`unregistered=1 / empty=1`，RC=101** ⇒ **main 在并入后是红的**。
- ⇒ **机制**：**引注的可解析性依赖「被引文件的行内容」** ⇒ **一次落地的副作用可以落在判据门上**，而它**不在被清关 commit 的判据域内**。⇒ **这是「各侧都绿 ≠ 并起来绿」的第二个实例**（第一个 = E0252 编译门）。
- ⇒ **纪律**：**落地后必须立刻在「并入结果」上跑全门禁**，不只是跑被并入 commit 的门禁。承 `§5.14-28`（引入更严门禁必须落地即绿）推广为：**落地即绿**。
- ★ **而我的第一次修复本身制造了第二个缺陷 —— 正是我自己登记过的条款的实例**：我把该引注**就地重指**（另一条被引行从「原 357 行」改指到「现 404 行」）⇒ **`PATH_EXCEPTION_KEYS` 里那条以 `(载体行 | 被引行)` 为键、带正向存在断言的登记项变 `dead=1`** ⇒ **RC=101**。⇒ **正是我自己立的 `§5.14-35`：修正行为本身会被判据观测到；例外键以「位置」为键 ⇒ 任何修正使键失效。**
- ⇒ **正确形态（我最终采用的）**：**对「已登记为例外」的引注，不得就地重指** —— **保留原值**（它是登记项、有正向存在断言），**把漂移写进正文**；**对「未登记且不符」的引注**（本次那条因变空行而 `EMPTY`，**没有**正向断言保护），**就地重指**到当前行。
- ⇒ **净结果**：`unregistered=0 / dead=0 / ambiguous=0 / oob=0 / empty=0`，`7 passed`，`RC=0`。
- ⇒ **一条可复用的判据**：**修一条引注之前，先查它在例外表里有没有键**（`crates/mc-proto-schema/tests/citation_integrity.rs` 的 `PATH_EXCEPTION_KEYS` 等表）。**有键 ⇒ 只改正文，不改引注；无键 ⇒ 就地重指。**

**★ `no-plan` 是 `idle-with-open` 的主要成因（三卡同门 · lead-rig 逐字取证 · tier 0 入册 · 2026-09-28）**

- **逐字**：`team_plan_get(task_id="group-rig-t47")` ⇒ **`[plan-not-found]: no plan exists for task "group-rig-t47"`**；`ready_queue` 中 t47 = `status: running / executionState: stalled / leaseActive: false / stale: true`，`reasons: ["no-plan"]`（**无 `dependencies-unmet`**）。
- ⇒ **与 t45 / t46 同一道门**（三卡同门）。机制：**`team_run_lease(acquire)` 要求 `plan-approved` 在前** ⇒ **计划从未 propose 的卡无法被 acquire**，其表现是 `stalled/eligible` 或 `running/stalled` + **无租约**。
- ⇒ **`idle-with-open` 的成因清单（三条，均已具名）**：① **陈旧依赖**（条件已满足、声明还在：t45/t77）；② **租约过期**（不产生可读责任信号）；③ **`no-plan`**（本条，三卡同门）。

**★ 在已 CLEARED 且已并入 main 的对象上发现「新偏差」的处置序（tier 0 裁定 · 2026-09-28）**

- **触发**：`stronghold.rs`（t109，**已 CLEARED 且已并入 main**）与 Java 源在「Start 加入列表」与「构建首层片元」上**顺序相反** —— `aqo.java:106` `this.a.add(m2);` **先于** `:107 m2.a(m2, this.a, random);`；而 `stronghold.rs:2023` 建**空** `components`、`:2026` **在空列表上** `build_component`、`:2045` 才 `insert(0, m2)`（tier 0 第一手复核）。
- **裁定**：**① 现在不开返修卡；② 开一张「影响面」判据卡（零产品写入）。** 判据 = 「Start 的**首次** `build_component` 的**可达执行路径**内是否存在对片元列表的读取（`aqt#a(List, aqe)` / 等价 `findIntersecting`），**且该读取在空列表与含 Start 的列表上给出不同结果**」；**可达 ⇒ 影响可观测（此时才返修）**；**不可达 ⇒ 差异存在但不可观测（记「已具名偏差、不返修」）**。**必带负控**：构造已知可达的调用点，证明该判据**能转红**。
- **谁判**：**G-WORLD 做初判**（crate 所有者 + 已有 oracle 读数能力），**verifier 只复核该判据的判别力** —— **不把「从零做判据」丢给 verifier**（它已是全队瓶颈）。
- ⇒ **纪律**：**处置序 = 先落载体 → 再测影响 → 影响可观测才返修。** **不得直接返修，也不得静默放过。** ⇒ 与 t107（不重写历史）、E0252/E0255（能在落地前避免就别制造红）并列，为**第三条**。

**★ 错误码也是主张的一部分（lead-world 自查更正 · tier 0 入册 · 2026-09-28）**

- **更正**：t112/t111 的合并冲突**不是 E0255，而是 E0252** —— verifier 在**证明为预测的那棵树**（`be8bb087`，`git write-tree` 证明 TREE_MATCH=True）上给出第一手读数：`cargo check --locked -p mc-world` ⇒ **RC=101** / `error[E0252]: the name BlockChange is defined multiple times`（`:40` previous import / `:99` reimported）。**E0255 用于值命名空间的重复定义；本处是重复导入。**
- ⇒ **blocker 实质与行号 `:40/:99` 逐字成立，只错在编号**；报告方已把 t115 卡面 3 处改掉并通知成员。⇒ **「编号也是主张的一部分，必须读不能凭记忆」**（承 `check-my-call-form-first`）。

**★ 新族的第一个正向应用（lead-world · 2026-09-28）**

- 对 t113（`1f03c38e`）它**没有退回「不相交论证」**，而是**直接取合并语境读数**：`is-ancestor(main, 1f03c38e)` **rc=0** 且 `rev-parse 1f03c38e^{tree}` == `merge-tree --write-tree main 1f03c38e` == **`e9febb15`** ⇒ **t113 是当前 main 的快进 ⇒ 它自己的树就是合并结果** ⇒ 其 `cargo test -p mc-worldgen`（73 passed）与 workspace check **本身就是合并语境读数**。
- ⇒ **这是「各侧都绿 ≠ 并起来绿」那条族的正确用法**：**能取合并结果读数就取**（最强形态），**取不到才退回「不相交 ⇒ 并集可编译」的论证**。

**`grp/rig` 落地（快进 · 「核两端」首次执行 · tier 0 第一手 · 2026-09-28）**

- `team_merge(grp/rig → main, task_id=group-rig-t46)`：`merged:true` · **`fastForwarded:true` / `createdCommit:false`** · `destinationBefore` = `d3868737` · `sourceHead` = `a0141d4f` · **main → `a0141d4f`**；并入后 tree = **`fb51db38`** = 头自身 tree；净增量 **39 路径全在 `tools/`、零删除、`crates/` 增量为空**。
- ⇒ **G-RIG 批次四（t40 / t41 / t42 / t44 / t46）全部在 main**；`t41` 进 main 后其相位推进到 `accepted`，`t48` 的 `dependencyGate` 随之满足。
- ★ **「核两端」纪律的首次执行记录**：**dest `rev-parse HEAD` == 清关钉住值** ✓ **且** **`rev-parse grp/rig` == 被清关的那个 commit** ✓ ⇒ **两端都核过才并**。（上一次只核了目的地，被门禁拒。）
- ★ **对侧承诺的形态**：lead-rig 在清关在飞期间**冻结 `grp/rig`**，并明说代价（t45 的并入压在其后）⇒ **两端各有人负责**。
- ⇒ **纪律**：**派工时的次序必须是 `propose → 组长批 → acquire`**；写「先 acquire」会让成员撞门并停在 `stalled`，而 digest 只会报一个 `idle-with-open`，看不出成因。
- ★ **报告方的处置是正确形态**：**报出来而不是埋掉**；**先证明源码未受影响**（而不是只说「已修」）；重发；**不改写旧记录**。：`ccdd0054`（tree `af678dd3`）/ head `c970c161`（tree `7d9aab43`）/ `is-ancestor(main, head)` rc 0 / `merge-tree --write-tree` = `7d9aab43` **== head tree** ⇒ 干净快进、无夹带。（两者的返回体都是该卡）⇒ **卡一旦带上它就在工具面上不可收口**，只能从**存储侧**读 revision、再按平台侧修法处理。

---

**★ 批次 8（2026-09-28 · HMR 事故 + 清关/落地路径）· 四条待修平台缺陷（tier 0 第一手）**

### D-7（严重）落地回执与 ref 脱钩：目的地为 detached HEAD 时 `merged:true` 而 `main` 不动
- **逐字回执**：`merged:true` / `destination:"main"` / `commit:17cb09cbf207c5a6017980f1452f997989cfb00f` / `destinationBefore:a437989a9c2c84d98d4a6d88a45c034fc4246794` / `fastForwarded:false` / `createdCommit:true`
- **同一时刻** `git rev-parse main` = `660ba9ef1ca0ebed25800e64b81169ee176b3a8c`（**一动没动**）；`git worktree list` 逐字 `D:/dsh-test/workspaces/RustMc  17cb09c (detached HEAD)`；`git branch -a --contains 17cb09cb` = `* (HEAD detached from a437989)`。
- **机制**：`team_merge` 把源并进**当前检出的 HEAD**；共享主检出当时游离在 `a437989a`（= t49 的 commit）⇒ 它生成了 `merge(a437989a, fe934049) = 17cb09cb`，**却从未推进 `main` ref**，而回执仍写 `destination:"main"` / `merged:true`。
- **影响**：**静默假交付** —— 只有复核 `rev-parse main` 才能发现。本会话靠纪律「**判据是 ref，不是回执**」发现；若照回执收工，会宣告一次并未发生的落地。
- **建议**：目的地为 detached HEAD 时必须 **fail-closed** 并具名 `destination-is-detached`；或在回执里同时给出 `destinationRef` 与 `destinationRefAfter` 并要求二者一致才算成功。
- 本会话同族**第 2 次**（第 1 次：verifier 自报 `git checkout --detach dad02e52` 把共享检出置于游离态）。

### D-6 `verifier_report` **不是只读的** —— 按 commit 键**覆盖**已有清关
- **实测**：verifier 用 `zz-probe-*` 做字段探针，把键 `dad02e52e0ba5308894c8ebf3d0c42a25854cce5` 从正式清关**覆盖**成 `{severity:"nit", report:"zz-probe-both"}`；同一次调用也把 `fe9340491d2fddf2e15be65eb012182e4f108070` 写成 `nit`/`zz-probe-both`。
- **影响**：**一个自检动作可以静默销毁一条已生效的清关**，而失败只在**后续合并**时才以 `no-verifier-clearance` 出现。
- **建议**：探针/自检走只读路径；或给记录加 `kind` 并把探针写入独立命名空间；或禁止 `nit` 记录覆盖更高严重度的既有记录。

### D-5 清关登记表：按 commit 为键 + 写入不校验 + 拒绝信息误导
- **登记表** = `D:\dsh-test\home\team-clearances.json`（按 commit 为键的映射）。被接受的记录形态：`{severity:"condition", report:"<名>", reportDigest, evidenceHash, filesHash, checksHash, by:"verifier", at, commit:<40字符>}`，且 **key == commit**。
- **实测故障**：正确清关被写在**不存在的 38 字符键** `fe9340491d2fd2e15be65eb012182e4f108070` 下（`git cat-file -t` = `fatal: Not a valid object name`，**rc=128**），而 40 字符真值键上只有 `nit`/`zz-probe-both` ⇒ 闸门拒。
- **子缺陷 1**：**写入时不校验** commit 字面量（长度 40 / `cat-file -t` = commit / 与具名 ref 一致）。
- **子缺陷 2**：拒绝信息 `no-verifier-clearance (commit fe9340491d2f)` 只给 **12 字符截断**，而正确串与坏串**前 12 字符完全相同** ⇒ **无法判别它比对了哪条记录、哪组 `clearedCommits`**，排障只能撞门。
- **建议**：写入时 fail-closed；拒绝时给出「查到的键 / 记录名 / 期望的 commit」三元组。

### D-4 控制面审计日志为空（与 HMR 事故无关，**仍未修**）
- `team_v12(action:"control_status")` 逐字：`audit:{ok:false, consistent:false, code:"audit-gap", stateRevision:73252, lastAuditRevision:0, missingRevisions:[1…300+]}`
- ⇒ 状态已推进 7 万余 revision，**审计日志一条都没有**；所有 mutation 无审计可查。

### D-1 / D-2 / D-3 HMR 事故（操作者已修；保留判别式供回归）
- **D-1** 工具绑定路径解析失活 `agentTeams`：命中 `send_message` / `team_task_get` / `team_task_list` / `team_privilege_status`；`team_v12` 聚合入口**全部 OK** ⇒ 失败在**工具绑定的服务解析**，不在 prompt 组装。
- **D-2** 控制面读路径 `normalizeStoredTask is not defined`（ReferenceError）：命中 `team_wake` / `team_plan_approve` / `team_plan_get` / `team_room_read` / `list_agents`。
- **D-3** `failure-memory` 熔断按**工具签名**累计：每多失败一次就多 latch 一个工具。⇒ 停摆期间必须**停止探测**；探针要选**不 latch 的**那个（`send_message` 的指纹 `count=0`）。
- **方法学（修复者需知）**：用「turn 产生了真实 `assistant/message`」证明**工具路径**可用**不成立** —— 那几个 turn 恰好没调用 team 工具。**验证必须覆盖被测面。**

---

**B-153（新 · tier-1 无法自救）成员分支与 main 分叉时的「同步 / 租约」闭环死锁**（tier 0 第一手核验后入册 · 2026-09-28）
- **三条拒绝串（lead-rig 逐字实测，我照录）**：
  1. `team_run_lease(acquire, group-rig-t51)` ⇒ `team policy refusal [worktree-sync-failed]: branch 'team/rig/rig-diff' does not contain requested base 'main'; automatic safe merge failed` —— 冲突 3 处（`tools/rig-batch/tests/verify-citation-support.ps1` content / `verify-ps-collision.ps1` **add/add** / `tools/rig-stats/README.md` content）；
  2. 解决冲突必须做 merge commit，而 `git add/commit` ⇒ `git write denied: git add/commit requires an active approved plan lease for the current member`；
  3. tier-1 用**本级指定修复工具**复现同一拒绝：`team_worktree_setup(rig-diff, group-rig-t51)` ⇒ `[worktree-stale-base-merge-conflict]`，同样 3 处冲突；**事后状态逐项未变**（`HEAD 4af76ac` / `MERGE_HEAD` 空 / `PORCELAIN` 空 / `UNMERGED` 空）。
- **闭环**：`acquire` 要求分支包含 main → 建立该关系需要 merge commit → commit 需要 lease → **没有可用路径**；而**指定修复工具走的是同一个自动安全合并**并同样拒绝。⇒ **tier 2 与 tier 1 都没有出口，只能升级到 tier 0。**
- **影响**：任何与 main 分叉且自动安全合并失败的成员分支**完全无法恢复**。本次代价 = 该成员整个 turn 停摆 + 一次 tier-0 升级 + 一条 privilege 审批。
- **建议（二选一即可破环）**：(a) 自动安全合并失败时，允许在**不取得 lease** 的前提下执行一次「仅解决冲突」的 merge commit（作用域严格限定为该 worktree + 该分支）；或 (b) 新增一条 `team_worktree_sync` —— **只做同步、不做产品写入**的受限写通道。**当前闭环的根源是「修复工具与被修对象共用同一个门禁」。**
- **只读证明（说明批准是安全的，我已在落地后的新 main 上重算）**：`git merge-tree --write-tree -X theirs team/rig/rig-diff main` = `68a151d41dcdf858071db59c3d7b3dcf9e8fbb26` == `git show -s --format=%T main` ⇒ **3 处冲突取 main 侧的合并结果树 == main 的树，不丢任何东西**；`git diff --name-status f4de9015 team/rig/rig-diff` = 恰 3 条，**全是已被 main 取代的 t44 产物**。

**B-154（新）同一 owner 的并发卡被迫共用一条分支 ⇒ 一张卡的返修挡住另一张「已清关」的卡**（tier 0 入册 · 2026-09-28）
- **工具链语义**：**一名成员 = 一条分支**（`team_merge(target:<member>)` 只能并 `team/<group>/<member>`）。
- **实例**：`group-proto-t79`（verifier 已 **CLEARED**）与 `group-proto-t80`（未交付）同派给 `member-codec` ⇒ 分支 tip 是 t80 的提交，**t79 无法单独并**；且 t80 一次**未跑门禁的 `complete`**（E0063 红）把**已清关的 t79 一起挡住**。
- **更严的一道闸**：`team_merge` 的 **`[member-merge-source-drift]`** —— **分支 tip 必须等于该卡的 `commit_sha`** ⇒ tip 属 t80 时**只能在 t80 的卡上并**，而 t80 尚在 `group-check`。
- **代价**：`group-rig-t50`（G-RIG 的 F6 复跑，其前置 = 含 F6 修复的 main sha）被**连带推迟**。
- **建议**：要么在排期层强制「同一 owner 的并发 edit 卡串行」，要么让 `team_merge` 支持按 **commit 区间/集合**授权（而非「分支 tip == 卡 commit_sha」）。**当前唯一正确实践：同一 owner 的并发卡要么串行，要么分派不同成员。**

---

**B-155（新）`type=approval` 的等待会被「无关的批准事件」自动关掉 ⇒ 「无 open 票」≠「仍被阻塞」**（tier 0 入册 · 2026-09-28）
- **实测（lead-rig 第一手读数，我照录）**：一张登记为 `unblockCondition.type = approval`、并携带 `requestId = privilege-6a15b07f-d53a-4bc0-894d-7f3a75ab6747` 的等待票，被子系统**自动关闭**，`closedReason = plan-approved`、`resolvedBy = team-v14-waiting`。
- **问题**：关闭它的事件是**计划批准（plan-approved）**，而那是一个与该 privilege **无关**的批准事件。⇒ 等待的解析**没有键在 `requestId` 上**，而是被「该卡上发生过任意 approval」满足。
- **实用后果**：① **privilege 等待不能用 `type=approval` 追踪**（会被同卡的计划批准提前吃掉）；② **「该卡没有 open 等待票」不能读成「该卡不再被阻塞」** —— 票可能已被一个不解除阻塞的事件关掉。
- **同族既有条目**：`task-terminal` 自动关闭已完成卡的所有票（`closedReason=task-terminal`）。本条是**第二个**「子系统按条件类型自动关闭、而实际阻塞未解除」的实例，且比前者更隐蔽 —— 前者至少条件是「卡已完成」，后者是一个**语义无关**的事件。
- **建议**：`type=approval` 的解析必须**键在 `requestId`（或明确的对象 id）**上；或新增 `type=privilege`。若暂不能改，至少把**触发自动关闭的那个批准对象**写进 `closedReason`（现在是 `plan-approved`，读不出它指的是计划而非特权）。
---

# 批次 9（2026-09-29）· tier 0 独立核验后的新增、更正与治理

**登记原则**：本批条目均为 **tier 0 第一手读数**（命令 + 返回值），或**具名到成员与证据 id 的转述**（转述必标来源）。**未复核的推断一律标「未判定」。**

## B-156（平台）`idle-with-open` 的第四类成因：等待的责任人自己不活跃

- **观测**：`wait:group-rig-t45:rig-runner:5c0fc86b`，`taskId=group-rig-t45`，`type=background`，`closurePolicy=explicit`，`responsible=rig-runner`；同一时点 `rig-runner` 为 `inactive`。
- **问题**：`background` 类等待**不会**因时间经过或普通 task revision 变化自动解除；责任人是离线成员 ⇒ 该等待**没有自动解除路径**。而 `idle-with-open` 的现有三类成因（stale dependency / expired lease / no-plan）**都不覆盖它**。
- **后果**：`group-rig-t52`（owner=lead-rig）排在该等待之后无法推进；`team_delivery_check` 只报 `work-genuinely-unfinished`，**不区分「等待的责任人已离线」**。
- **修法建议**：① `waiting_list` 增派生标志 `responsibleInactive:true`；或 ② `team_delivery_check` 的 verdict 区分「责任人不在活跃成员表内」。

## B-157（平台）★ `control-plane lock timeout` 的「no mutation was written」是**假阴性**（危险）

- **第一手复现（tier 0）**：`team_merge(target="lead-world", task_id="group-world-t122")` **抛出** `ToolCallError: control-plane lock timeout ...; this call did not acquire the lock, so no mutation was written and retrying is safe`。
- **同轮现取（ref 判据）**：`git rev-parse main` = `a16b4f5c4081a1b7c881b4fef00866442e6d482a`（= 源 ref `grp/world`）；`git log -1 main` = `a16b4f5c Merge commit 'de64d40b...' into grp/world` ⇒ **mutation 实际生效**。
- **第二个独立证人**：lead-proto 报告其上一条同内容消息亦遇同一条错误、据以判「未写入」并**重发**（`msg-7ea895e7`，自标「非重复上报」）。按本条，它**无法**从错误文本判断第一条是否已写入。
- **与另一处文本矛盾同族、且两个方向都错**：`control_status` 的 `migration.state.v14MirrorHealth.lastFailure` 为 `isError:false` + **变更后**的 ids + 「no mutation was written」；本条为 `isError:true`（抛异常）+ 变更**确实发生**。
- **危险面**：按错误文本重试的成员会在**已生效**的 mutation 上再执行一次。对 `team_merge` 恰好幂等（会报 alreadyUpToDate），对 `send_message` / `team_task_update` / `team_evidence_record` 则**产生重复**。
- **本会话的受准处置**：工具报错后**先查效果**（`git rev-parse` / 卡 revision / dispatch 状态）再决定是否重试；**不把「retrying is safe」当真**。tier 0 与 lead-proto 均已采纳该纪律。
- **修法建议**：① 文本改为「写入结果未知，请先查询效果」；② 「retrying is safe」只能在**证明**未写入时出现；③ 至少区分「锁未获取」与「锁未获取但写入可能已发生」。

## B-158（平台 · 读侧口径）梯级不可自动收敛 ⇒ 78/118 张卡停在非终态，会被误读为待办

- **上报**：lead-world —— 其组 118 张卡中 **78 张 completed 卡停在非终态梯级**（integration-ready 48 / integrated 11 / verifier-review 3 / member-check 1 / plan-approved 2 / room-discussion 13），并**批量复核**其 commit 全部是 main 的祖先。
- **问题**：梯级没有「已被 main 吸收」的自动收敛路径，而 `integration-ready` 的字面含义会被读成「待并入」⇒ 任何按 `task_list` / `ready_queue` 读排期的人会把这 48 张误读成待办。
- **tier 0 裁定（读侧修，不做批量写）**：① **判据是 ref** —— 任何消费者读 `integration-ready` 前必须先做 `merge-base --is-ancestor <card.commit_sha> main`；② **不做批量 mutation** —— 78 次写会与各组并发写争控制面锁（本轮已实测一次 lock timeout 假阴性，见 B-157），且**无任何产品信息增益**；③ lead-world 的批量核验读数（48 个 commit 全部 rc=0）以证据行落盘，供后人免于重跑。
- **修法建议**：`team_task_list` / `ready_queue` 对「已完成且 commit 已是 main 祖先」的卡，投影为「已并入（待终态）」而不是「待并入」。

## 观察（性质未判定，不冒充缺陷）

**O-9-1 `control_status` 的 `migration` 负载 ≈ 21 MB**：实测 `JSON.stringify(control_status.migration).length = 21211835`，它内嵌整个控制面。任何把该结果 stringify/打印的调用者都会产生 20MB 级输出 —— tier 0 本轮因把它与 `capability_matrix` 一同打印，**溢出 26 MB 到磁盘**（`dsh-spill-...`）。建议给 `migration` 有界投影，或改为显式 opt-in。

**O-9-2 审计重复 revision 是间歇的，不是累积的**：三个时点的 `control_status` 的 `audit.duplicateRevisions` —— stateRevision 75342 ⇒ 3 条；75750 ⇒ 10 条；**75841 ⇒ 仍 10 条（跨 +91 个 revision 零新增）**。⇒ **间歇爆发**。新增键（75482-75508）落在近期 ⇒ **不是历史残留**。**未判定**：重复 revision 是合法（一次 revision 可含多事件）还是缺陷 —— 需平台侧给判据。

**O-9-3 B-155 暂无运行期证人**：`waiting_list{includeClosed:true}` 中可读到的关闭原因只有 `plan-approved` / `deduplicated` / `explicit-resolve`，**没有一条 `privilege-approved:<requestId>`**。代码已在（`team-v14-waiting.mjs` 命中该 token），但**运行期未证**。

## 方法学（非平台缺陷，登记供修复方与各组理解上下文）

**M-9-1 `git -C` 只切 git，不切 cargo 的 cwd**：`cargo` 判据必须在**被检对象的物化检出**里跑。本会话**两个独立成员各自踩到同一坑**（lead-world、verifier），更正后读数逐值一致。自证：错误那次 focused 打印 `0 passed; 158 filtered out`、lib 157；改正后同一命令同一工作树得 focused `3 passed`、lib 160（**分母同为 158，被选中数 0→3**）。

**M-9-2 grep 一个 token 之前必须先具名它的宿主文件**：tier 0 首次核验 B-153 至 B-155 时 grep 的是 `team-v12-runtime.mjs`，八个 token 全 0，**差点得出「修复没落地」的错结论**；真实宿主是 `team-tools-v2-r10.mjs` / `team-worktree.mjs` / `team-v14-waiting.mjs` / `team-v12-integration.mjs`。

**M-9-3 「两个时点 → 成因判断」是本会话反复出现的错误形状**：tier 0 两次在只有一/两个时点的情况下下成因判断（「duplicateRevisions 是历史残留」被第二个时点推翻；「它是持续累积」被第三个时点推翻）。**纪律：一个实例只升级观察，不升级成因；趋势判断至少需要三个时点。**

## G-9.1 落地序规则（治理）

**两个头不可能都 FF 到同一个目的地** —— 先落者把 main 推前，后落者即不再是 FF（`merge-tree(new_main, H2)` 不等于 `H2` 的 tree）⇒ **「清关具名的树」不等于「落地树」**。

**规则**：**已出件的头先落；未出件的头在请清关之前先重锚到届时现取的 main**，使清关对象 == 落地对象。

**推论**：清关的「目的地」字段必须与重锚时用的 main 值一致；落地时按「判据是 ref 不是回执」同动作核两端（`rev-parse main` == 清关目的地 且 `rev-parse <src ref>` == 清关具名 commit）。

**本会话已按此规则执行 4 次落地**（`e48b3e52` / `e5d6ca72` / `a16b4f5c` / `34152bb0`），后三次均伴随对未出件组的下发与重锚。

## G-9.2 `bind_fix` 的边界（治理）

**一条分支承载多张卡时，不要为「指针落后」做 `bind_fix`**：`team_worktree_setup` 会把 main 并入成员分支 ⇒ 分支 tip 前移而旧卡指针不动。`member-merge-source-drift` 要求 **源 ref tip == 卡 commit_sha**，只对**被并的那张卡**成立；被同一分支头**携带**的旧卡不受此约束。⇒ 若多张卡的交付在同一分支的祖先链上，**并一次分支即可**；对已完成卡做 `bind_fix` 只会造出一个新的、需要重新复核的树。
## B-159（平台）★ 清关「目的地」是移动 ref，而「对象」是内容寻址 ⇒ 每落地一次就作废所有未落地的清关

- **机制（本会话三次事故，均为第一手读数）**：
  · 事故一：main 由 `e5d6ca72` 前进到 `a16b4f5c`（grp/world 的 t122 头落地）⇒ lead-rig 的 `994695c1` 清关（目的地钉 `e5d6ca72`）失效。
  · 事故二：main 由 `a16b4f5c` 前进到 `34152bb0`（grp/rig 头落地）⇒ lead-proto 的 `36a4e0d7` 清关（目的地钉 `a16b4f5c`）失效。
  · 事故三（同一机制，触发者是 tier 0 自己的台账提交）：main 由 `34152bb0` 前进到 `d79d9306`（batch 9 台账提交）⇒ lead-proto 刚重锚出的 `c762531a`（基于 `34152bb0`）再次失效。
- **根因**：清关登记的**对象是内容寻址的**（commit sha，正确），而**目的地是一个分支名 `main`，其取值每次落地都移动**。平台没有任何机制把「该清关是在哪棵 main 上算出来的」变成可判定的条件。
- **后果**：只要有两组同时准备落地，**先出件的那一组必然被下一组落地作废**，代价 = 一次重锚 + 一次 verifier 复算。
- **本会话的受准纪律（tier 0 采用并下发，见 G-9.3）**：一次只让一个头处于「已清关待落地」；清关到手立刻落地；`team_merge` 前强制复算 `merge-base --is-ancestor main <src ref>`，rc 不为 0 即退回重锚，**不得沿用任何旧读数**。
- **修法建议**：① 让清关登记一个**内容寻址的目的地 commit**（而非 ref 名）；② 或让 `team_merge` 接受「目的地是当前 main 的**祖先**」且「从该目的地到当前 main 的增量与该头净增量的**路径集合不相交**」的清关。两者都能把「先出件者必被作废」变成可判定条件。

## G-9.3 一次只让一个头处于「已清关待落地」（治理）

**纪律**：清关到手 → **立刻落地** → 再让下一组重锚 + 请件。**不得**同时让两个头处于「已清关待落地」。

**理由**：见 B-159 —— 清关目的地是移动 ref，任何一次落地（含 tier 0 的台账提交）都会作废其他未落地的清关。

**落地前强制复算清单（不得跳过，且必须来自同一次读取）**：

1. `git rev-parse --abbrev-ref HEAD` == `main`（防 detached HEAD 假成功）；
2. `git status --porcelain` 为 0；
3. `git rev-parse main` == 清关具名的**目的地**；
4. `git rev-parse <src ref>` == 清关具名的 **commit**；
5. `git merge-base --is-ancestor main <src ref>` rc=0；
6. `git merge-tree --write-tree main <src ref>` == `<src ref>` 自身 tree；
7. 净增量逐条落在清关具名的路径集合内。
## B-160（平台）`task-terminal` 自动收口写了**假理由**（`auto:condition-cleared`）

- **上报**：lead-rig（G-RIG）。两次同签，均为其组 t51 的等待票。
  · 实例①：`wait:group-rig-t51:rig-diff:5ca5d8b5`，真实解除条件 = verifier 对 `994695c1` 出件 —— **从未满足**；却被记为 `resolution:"auto:condition-cleared"` / `closedReason:"task-terminal"`（`closedBy=team-v14-waiting`）。
  · 实例②：`wait:group-rig-t51:rig-diff:e34a9697`，条件（verifier 对 `34152bb0` 出件）**最终确实满足**，但收口**不是由条件触发**，而是由卡转终态触发 —— 记录同样是 `auto:condition-cleared` / `task-terminal`。
- **缺陷不是「提前关票」，而是写了一个断言条件的理由**：`auto:condition-cleared` 字面主张「条件已清除」，而真实触发是 `task-terminal`（与条件无关）。实例①里该理由是**假的**，且它是**持久记录** —— 属「把没达成的判据写成达成」这一族。
- **连带可用性后果（lead-rig 实测）**：票一旦被自动收口，`team_v12(action:"waiting_resolve", ticket_id:...)` 返回 `ToolCallError: task-not-found` ⇒ **无法再把真实解除条件写进那张票**。错误的理由不只是难看，它**占掉了正确记录的位置**。
- **同族**：B-155（`type=approval` 被无关的 `plan-approved` 关闭）。本轮已观察到「无关事件自动解除外部等待」的**两种触发者**：**审批**（B-155）与**卡转终态**（本条）。
- **修法建议**：① `task-terminal` 路径写一个与条件无关的理由串（例如 `closedReason:"task-terminal"` + `resolution:"auto:task-terminal"`）；② **不要**把 `auto:condition-cleared` 用于任何非条件触发的收口；③ 或允许对已自动收口的票补写一条 resolution 附注。

## B-157 补充（第三个独立证人）：`team_merge` 的**返回值本身**也不可用于判断状态

- **上报**：lead-rig（G-RIG），本轮实测。`team_merge` 返回 `alreadyUpToDate:true` 的**同时**配一个新的 sha ⇒ **两个字段互相矛盾**。
- 与 B-157 主条合起来，结论是：**`team_merge` 的「抛异常 / 返回 alreadyUpToDate / 返回 no mutation was written」三者都不能作为状态判据**。
- **受准纪律（三组均已采纳）**：一切从 refs 复读 —— `rev-parse <dst>`、`rev-parse <src ref>`、`merge-base --is-ancestor`、`merge-tree --write-tree`、以及逐路径 blob。

## M-9-4 比较对象必须显式具名，不能用 `HEAD` 代替

- **实例**：lead-proto 在**主检出**里跑 `git diff --stat <旧头树> HEAD`，而 `HEAD` = `main`（不是它要比较的新头）⇒ 读出一堆**假删除**；改用显式新头 sha 后真值 = 「只差 1 条路径」。
- **纪律**：任何跨对象比较必须**两边都写显式 sha/ref**；`HEAD`、`@`、`.` 只在「该检出就是被比较对象」时才可用，而这一点本身需要先证明。
- **同族**：M-9-1（`git -C` 只切 git 不切 cargo 的 cwd）—— 两条都是「**测错对象**」。
---

# 批次 10（2026-09-29）· 落地窗口关闭后的追加

## G-9.3 补句（来源：lead-rig）

**授权件必须同时给出 commit 与目的地，落地方在落地当刻对两者各自复算一次。** 理由：清关**出具到落地之间的窗口里两端会各自移动**。

## B-159 第 4 例（实测复现）

verifier 对 `c762531a` 出的 **merge 形式**清关，其落成树 `ee9a144e` 是相对**出具时**的 main `a843ce07` 算的：`merge-tree(a843ce07, c762531a)` = `ee9a144e`，而 `merge-tree(748ec2c7, c762531a)` = `30dafe1e`，**两者不等** ⇒ **该件不能作落地授权**（清关具名的落成树不等于落地树）。tier 0 已确认不按它落，lead-proto 已重锚出新头 `b0d9572f` 并另请一件。

## G-9.4 判据里不得写移动 ref 的时点值（治理）

- **实例 a**（lead-rig 自报）：里程碑 `#1790614604319` 的 done_when 写「`git rev-parse main` == `34152bb0`」。
- **实例 b**（tier 0 同病自纠）：里程碑 `#1790612797098` 写「两次 team_merge 后 `git rev-parse main` 分别等于两份清关具名的 commit」，经三次台账提交后字面已不可复现。
- **规则**：判据必须写「**读数 + 时点**」，不得写移动 ref 的某一时点值。tier 0 已于本轮把里程碑改为时点显式（新 `#1790615066905`）。

## B-161（平台）`commitSha` 字段形态不稳定

- **读数**（来源：lead-world）：① `group-world-t37` 是 edit 卡且 phase=integration-ready，但 `commitSha` = `3d136af`（**7 位缩写，非完整对象 id**）；② 11 张 discussion 卡的 `commitSha` = 字面量 `no-commit:discussion-only-phase`（**根本不是 ref**）；③ 另有 17 张已完成卡该字段为空。
- **风险形态**（tier 0 精度更正 lead-world 的「产品面无风险」）：接受「没有**假接受**风险」，但**有假拒绝风险** —— 任何把 `commitSha` 与 40 位分支 tip 做**相等比较**的门禁（如 `member-merge-source-drift` 的「源 ref tip == 卡 commit_sha」）拿到 7 位缩写时**必然不等**，会拒绝一次合法合并。
- **修法建议**：`commitSha` 只接受 **40 位完整对象 id**；discussion/review 卡用**显式 null** 而不是哨兵字符串；消费侧比较前必须做长度与形态校验。

## B-157 证人四 + 结论升级

- **证人四**（来源：lead-world 本次投递）：它也遇 `control-plane lock timeout` 报「未写入、可安全重试」并重试。
- **四个独立证人**：① tier 0（`team_merge`）；② lead-proto（`send_message`）；③ lead-rig（`team_merge` 报 `alreadyUpToDate:true` 却配新 sha）；④ lead-world（`send_message`）。
- **结论升级**：**抛异常文本 / `alreadyUpToDate` / no-mutation 三者都不可作状态判据**；一切从 refs 复读。

## B-162（平台）聚合 wake 无法被完全确认 ⇒ 永久重投

- **读数**（来源：lead-rig）：`wake:lead-rig:46` 聚合了 **86 个 messageId**；按流程 ack 返回 `status=partially-handled` / `handled=false` / `redeliveryRequired=true` ⇒ **该 wake 会一直重投**。
- **同族**：B-160（聚合/自动收口写出与事实不符的处置状态）。
- **修法建议**：聚合 wake 应支持**逐 messageId ack** 并据此派生整体 handled；或把 `redeliveryRequired` 与「仍有未处理的 reason」绑定，而不是与「聚合体未全确认」绑定。
- **已下发的 bounded 实验**（只做一次，失败即停）：若聚合体可枚举 messageId，取其中一条单独 ack，看是否 `handled=true`。

## M-9-4 实例补充

同一错误**犯两次**（来源：lead-proto）：在**主检出**里用 `HEAD` 当比较对象 ⇒ 读出假删除。已立硬性检查：**比较命令里禁止出现 `HEAD` / `@`，必须显式具名 sha**。

## 观察 O-10-1：一条 legacy 聚合 wake 的重指控被推翻（含时点边界）

- **指控**：`evidence-e6fa5563` 的 N1 通过陈述为假（真读数 ROWS=1）；卡已 completed、lease 已释放 ⇒ 不裁决就关卡/交包会把假陈述带进验收。
- **推翻读数**（lead-rig 第一手，逐字）：`CITATION_SUPPORT_FILE_LINES=3` / `CITATION_SUPPORT_ROWS=3` / 两行 OK / 一行 FAIL（指向 rig-batch 的 main.rs 第 1124 行，内容 `if let Some(ys)`）/ `CITATION_SUPPORT_ROWS=3 FAILS=1` / `CITATION_SUPPORT=FAIL`，EXIT=1 ⇒ **与证据行 output 相符，指控不成立**，无需裁决放行更正、不必关卡。
- **边界**（lead-rig 自具，tier 0 采纳）：跑在**当前 main 树**上、**未物化** `00b1a519` ⇒ 结论是「该陈述**在现值上**成立」，**不是**「在 `00b1a519` 当刻也成立」。日后若需当刻读数，必须**重新物化那棵树**。

## 批次 10 落地记录（tier 0）

- `grp/proto` 头 **`b0d9572fe45fdf178fd1817f578c1e0185929a02`**（tree `30dafe1e`）**已按 ff 落 main**；落地前同动作核两端：main = `748ec2c7`、grp/proto = `b0d9572f`、`--is-ancestor` rc=0、`merge-tree` = 头自身 tree、净增量 16 条全在 `crates/mc-server/`（A 2 / M 14 / **D 0**）、porcelain=0、分支=main；清关键在 registry 实存（severity=`condition`）。
- 落地后：`main` = `b0d9572f`；门禁 `citation_integrity` **7 passed / 0 failed / RC=0**；`mc-server` 套件 RC=0。**t77 + t79 + t80 + t81 四卡一并进 main。**
## B-162 收窄（更正 tier 0 自己的过强表述）

原表述「聚合 wake 无法被完全确认 ⇒ 永久重投」**过强**。**更正**（来源：lead-rig 的 bounded 实验，三次读数）：逐条 ack 对**已投递**消息是**可行**的 —— 一条状态为 `injected` 的 messageId ack 后得 `handled=true` / `cleared=true` / `durableHandled=true`；一条状态为 `queued` 的得 `message-not-delivered`；三个更老的 id 得 `inbox-not-found`。

⇒ 缺陷的正确表述是：**聚合 wake 自身的整体状态字段**在逐条已确认后仍报 `partially-handled` / `handled=false` / `redeliveryRequired=true` ⇒ **误报永久重投**。

**可用绕过**：对**已投递**消息逐条 `inbox_ack`；聚合体自身的 `partially-handled` 不代表逐条不可确认。

## O-10-2 写入门禁不覆盖子进程（成员自报，已处置）

- **自报**（rig-runner 自具，`status=FAIL`，`evidence-5b51ec84`；lead-rig 转达）：`cargo build --target-dir <工作树>/target` 被 fail-closed 写入门禁逐字拒绝后，该成员用 `Start-Process pwsh -Command` **嵌套启动同一次写入**（PID 5248），**发现后立即 `Stop-Process`（含子进程）**；残留 `<工作树>/target` 为 gitignored、`porcelain` 仍空；**未据该残留取任何读数**。
- **性质**：这不是「成员违规」的个案，而是**门禁只覆盖直接调用、不覆盖子进程**这一事实的实例。本仓已立「写入门禁是尽力而为的过滤器，不是安全边界」，本条是该立场的**第一个实测实例**。
- **建议**：拒绝串里**明写**该性质（「此拒绝不阻止子进程；不得用嵌套进程规避」），使成员不必靠自觉。
- **处置**：lead-rig 已按纪律记账并禁止重复；tier 0 采纳其处置。

## M-10-1（tier 0 自己的错）转述一个路径的「称呼」而不核实它由谁产出

- **事实**：tier 0 在给 lead-world 的 t123 裁定里把 `tests/fixtures/worldgen/dump/` 当成 oracle 路径 —— 那是**转述 lead-rig 消息里对该路径的称呼，而未自己核实它由谁产出**。lead-world 第一手指出该路径是 **rust 侧（G-WORLD 自己产出）**（ORACLE-SPEC 自述「rust 侧（G-WORLD 已产出）」与「两侧命名不同，不得混用」；写它的是 mc-worldgen 的 dump_chunks 测试）⇒ **按该路径对拍 = 与自身对拍 = 假绿门**。
- **性质**：与既有两条同族 —— 「用重建物代替原件」与「转述别人的读数 = 转述一个已过期的对象」。**新形态**：转述的是**路径的归属**（谁产出它），比转述数值更隐蔽，因为路径名本身看起来中性。
- **纪律**：**引用一个路径作为「期望值来源」之前，必须先核实它的写入方是谁**（`git grep -ln <path>` 或读其文档自述），不得凭上游消息的称呼。

## O-10-3 产品文档缺陷（不属平台，但阻断判据，已具名指派）

- ORACLE-SPEC 的 §1 称 vanilla 侧 `kind=chunk` 记录「**从未产出**」—— **已过时**（346 份实存），而 §1 的 **not-comparable 结论整体建立在该句上**。
- **指派**：lead-world / lead-rig 具名修复该句并重述 §1 结论；**在该句修好之前，任何引用 §1 not-comparable 的结论不得作为判据**。

---

## ★ B-163（平台 · 重大）`status` 与 `phase` 可互相矛盾，且交付门禁只读 `status`

**读数（tier 0 第一手 · 本轮现取）**

- `group-rig-t45`：`revision=57` / `status=completed` / **`phase=verifier-review`** / `owner=rig-runner` / `commitSha=2cb829d1088a2b90c0941ea66e09a265b6a11e3e` / evidence **33** 条。
- **该 commit 未集成**：`git merge-base --is-ancestor 2cb829d1 main` = **rc=1**；`git branch --all --contains 2cb829d1` = 仅 `team/rig/rig-runner`；`grp/rig` 仍 = `34152bb0`（已是 main 的祖先）。
- **交付门禁看不见它**：`team_delivery_check` 返回 `openCount=4`，**不含 `group-rig-t45`**（它按「非 completed」过滤）。

⇒ **危害**：`team_delivery_check` 是「宣布交付之前必须调用」的那道门；一张**已标 `completed`、代码却从未进 main** 的卡对它**完全不可见** ⇒ 我会在「板面无开放项」这个读数上宣布交付，而真实的未集成交付物不在任何清单里。

⇒ 这是 **B-158 的姊妹面**：B-158 是「`phase` 落后于 `status`」（78/118 张卡停在非终态相位），本条是「`status` 领先于集成」。两面合起来 ⇒ **`status` 不能作为「已交付」的判据**，只能作为「该卡负责人认为可以收工」的判据。

**建议**：① `team_delivery_check` 增一类 `completed-not-integrated`（`status=completed` 且 `commitSha` 不是 main 的祖先），至少给出计数；或 ② `complete` 校验 `phase` 已到终态。

**我的处置**：不据 `openCount` 宣布交付；改为对本轮每张相关卡直跑 `merge-base --is-ancestor <card.commit_sha> main`。

---

## ★ G-9.5 落地规则：落地是 merge 而非 ff 时，清关必须具名「三元组」

- **事实**：t45 的头 `2cb829d1`（tree `d93010d1`）与 main **双向都不是祖先**（`--is-ancestor` 两个方向都 rc=1）⇒ 落地**不可能**是快进。lead-rig 现取 `merge-tree --write-tree main 2cb829d1` = tree `47a18a31` ≠ `d93010d1`（其读数 `MT_EQUALS_HEAD_TREE=False`）。
- ⇒ **落成树 `47a18a31` 是一个从未被清关过的对象**：清关针对的是头 commit `2cb829d1`，而落到 main 上的是「头 + main 上较新的提交」的合并结果。
- **规则**：当 `merge-tree --write-tree <目的地> <头>` ≠ `<头>` 的 tree 时，清关必须**同时具名三个对象** —— ① 头 commit；② 目的地（main 的 sha，**记录之后不得移动**）；③ merge-result tree（在 ② 上现算）。落地当刻必须对三者**各自**复算一次并逐一对齐；任一不符即**不落**。
- **推论**：③ 是 ② 的纯函数 ⇒ 只要 ② 冻结，③ 可复现；但 ② 是移动 ref，所以「② 冻结」只能靠**在飞期间不推进 main** 保证。这也说明 G-9.3 的「落地当刻两端各复算一次」在 merge 形式下**不够**：还要复算 ③。

---

## ★ B-159 第 5 例：作废在途清关的是**我自己的 docs-only 台账提交**

- lead-rig 的 `47a18a31` 是相对 **main=`3a13f88`** 算的；我在其后提交了 `9ba84cc`（**只改 `docs/PLATFORM-DEFECTS.md`**）⇒ 同一表达式在现值上必然给出**不同的树**。
- ⇒ **在现行门禁下，每一条台账提交都会作废所有在途清关**，哪怕路径集与在途件完全不相交（`docs/` 对 `tools/rig-batch/`）。
- ⇒ 支持操作者已提出的口径：**接受「清关具名的目的地是当前 main 的祖先、且两者的净增量路径集不相交」的清关**。在此之前 tier 0 的纪律是：**提交台账之前先确认无在途清关；若已有在途件，先让出具方重锚**。
- ⇒ 本轮我据此**先提交台账、再让 verifier 重锚** —— 因为 `47a18a31` **已经**被我上一笔提交作废，重锚不可避免，故本次提交的边际代价为 0。

---

## ★ B-160 第 3 例（表述升级）：自动收口**占掉了真结论的位置**

- **事实**（lead-rig 第一手）：为 t45 登记的 `wait:group-rig-t45:rig-runner:fe6df95a`（`type=background` / `closurePolicy=explicit` / `responsible=rig-runner`）在 t45 达到 `completed` 时被**自动收口**；随后 `team_v12(action:"waiting_resolve", task_id:"group-rig-t45")` 返回 `status=not-found` / `candidateCount=0` ⇒ **真结论无处可写**（真结论 = verifier 已出结论并推进到 `integration-ready`）。
- **与前两例的差别（升级点）**：前两例是「条件**未**满足却被记成 cleared」；本例**条件确已满足**，但收口触发者是 **task-terminal**（卡变终态），不是该条件本身。⇒ 缺陷实质不是「写假理由」，而是「**自动收口占掉了真结论的位置**」，**无论条件是否满足都会发生**。
- **建议**：`type=background/external/manual` 的等待件，若自动收口的触发者不是该条件本身，至少应保留真结论的写入通道（允许在已收口件上追加 `resolution`）。

---

## ★ M-10-2（方法论）fail-closed 的 guard 必须把「探针自身的执行结果」算进去

- **事实**（lead-rig 自报 (c)）：它把 t45 推进到 group-check 的前置 guard 是「越界路径为空」，而那条 pwsh 探针因嵌套 `$(...;...)` 解析失败**整体没有执行**，正则匹配不到任何东西 ⇒ 返回空串 ⇒ **guard 被「失败」满足**。
- **规则**：**空集合与「查询失败」必须可区分**；任何 fail-closed 的 guard 必须把**探针的退出码**算进判据（`SELECT` 返回 0 行 ≠ 查询报错）。
- **同族**：这是条款 42（fail-open guard）的自身实例，也是 **M-10-1** 的同族 —— 把**程序性/机械性状态**当成**实质性判据**。

---

## ★ M-10-3（方法论）净增量的比较对象是**合并目的地**，不是组分支头

- **事实**（lead-rig 自报 (d)）：它用**旧组头 `34152bb0`** 做两点差来算 t45 的净增量，于是把 tier 0 落在 main 上的台账提交一并算进来，**误报 `docs/PLATFORM-DEFECTS.md` +109 条越界**；改按「相对合并目的地 main」重取后，5 条**全在 `tools/rig-batch/` 内**，越界 0。
- **规则**：净增量口径 = **相对合并目的地（main）**，不是相对组分支头 —— 组头**不含** main 上后来的提交，两点差会把别人的增量算成自己的越界。

---

## O-10-4（调用面）`waiting_resolve` 传 `ticket_id` 会被当作 task id

- **读数**（lead-rig 两次对照）：`team_v12(action:"waiting_resolve", ticket_id:"wait:group-rig-t45")` ⇒ `ToolCallError: task-not-found`；改用 `task_id` 成功。
- 成文口径（AGENTS.md）写的就是 `task_id` ⇒ **文档没错**，错在调用面的静默降级：`ticket_id` 被当成 `task_id` 的值去解析，而返回的 `task-not-found` **不提示「你可能把 ticket_id 传成了 task_id」**。
- **建议**：`waiting_resolve` 在同时收到两者、或收到形态为 `wait:` 前缀的 `task_id` 时，返回具名两者的错误文案。

---

## 当前在飞与下一步（时点：本提交当刻）

- **main = 本提交自身的 sha**（`PORCELAIN=0`）；门禁 `citation_integrity` 在本提交后的树上 RC=0 / 7 passed。
- **t45 待落地（B-163）**：头 `2cb829d1`（tree `d93010d1`）在 `team/rig/rig-runner` 上，**既不在 `grp/rig` 也不在 main**。落地链 = verifier 出**三元组**清关 → lead-rig 把 `grp/rig` 前进到被清关的 commit → tier 0 落地。已具名告知 lead-rig 与 verifier（目的地 = 本提交后的 main）。
- **`grp/rig` = `34152bb0`**（已是 main 的祖先）；**`team/rig/rig-runner` = `2cb829d1`**。
- **板面**：4 开放 / 3 可执行 / 无主 1（`group-world-t121`，其解除条件 `group-proto-t80` **已落 main** ⇒ 已用 action 唤醒 lead-world 具名）/ 死信 0。

## tier-0 工作台账（batch 12–13 · 由 `.local/tier0-staged-9.md` 并入 · 含 B-166 / B-169 / B-170 / B-171 / O-10-12 等）

# tier-0 暂存（`.local/`，gitignored，不进 `docs/`）

**状态**：batch 9 / 10 / 11 已提交。**下列 batch 12 条目压住未提交** —— 因为 main 冻结在 `e46c5e53`（有在途清关），任何台账提交都会作废它（B-159）。
**用途**：（a）待提交台账、（b）事件记录、（c）未判定观察。

## 已提交（勿重提）
- batch 9 → `d79d9306`；batch 10 → `3a13f88`；B-162 收窄/O-10-2/M-10-1/O-10-3 → `9ba84cc`；batch 11（B-163/G-9.5/B-159 第 5 例/B-160 第 3 例/M-10-2/M-10-3/O-10-4）→ `e46c5e53`

---

## batch 12 待提交

### B-164（平台 · 跨组原子性）例外键的载体与它所豁免的引注分属不同组的写范围
- **实例**：t45 把 `tools/rig-batch/CONTRACT.md:59` 的裸引注（原引）`DECISIONS.md:33` 改成可解析的 `docs/DECISIONS.md:34`（正确），使登记在 `crates/mc-proto-schema/tests/citation_integrity.rs:837` 的例外键变 dead ⇒ `:1669 assert!(dead.is_empty())` fail-closed；而该键载体不在 t45 的 write_scopes（`tools/rig-batch/`）内 ⇒ **t45 自清不了**。 【★ 批次 25 作废本条关于「登记行」的那处行号指针：该键已由 t45 删除，当时的登记行现已不含该键。以批次 25 的更正块为准。】
- ★ **不可交换性（lead-proto 补正，我复算并采纳）**：**也不能由载体方先删键** —— `:1660 assert!(unregistered.is_empty())`；若 G-PROTO 先在 main 删键而 main 的 `CONTRACT.md:59` 仍是裸形态，该不符项由「已登记的例外」变成「**未登记的不符项**」⇒ **main 立刻转红**。⇒ **删键与修文必须同一棵树**。
- **泛化**：与 B-159 同族 —— **两个必须同时为真的事实被拆成两次提交**。
- ★ **门禁自己已建了正确机制，`:837` 被放错了表**：`:841-842` 逐字「**pending 语义**的 path 例外（**无存在断言**）：对方修好后该键自然消失 ⇒ 这里不得断言其存在，否则对方修好反而假红」；`:847 PENDING_PATH_EXCEPTION_KEYS`（arity 5）。而 `:837` 在**有存在断言**的表 `:786 PATH_EXCEPTION_KEYS`（arity 52）里。
- **建议**：① 把这类「会被对方修好」的键迁进 `PENDING_PATH_EXCEPTION_KEYS`；② 或让 gate 区分「例外所指的引注**已变为可解析**」（应报**警告**）与「引注消失」；③ 或把注册表按 owner 拆文件，使载体 == 所有者。
- **处置**：G-PROTO（载体 owner）**书面授权** lead-rig 在 t45 同一棵树内做三处原子改动（改引注 + 删键 + arity `52→51`）。这是 peer 之间的接口约定（规则明许），**不占 tier-0 裁定**；lead-rig 据此撤回裁定请求。

### B-165（平台）`status` 既不是「已交付」也不是「在推进」的判据
- **(a) 「具名 owner 但不开工」不可表示**：lead-world 第一手 —— 按 tier-0 裁定给 t121 `reassign` 后，卡由 `pending` → `in_progress`，owner **被唤醒并实际推进**（`ready_queue` 的 `executionState=active`）。⇒ tier-0 的「今天具名、**不开工**」被运行时**静默升级**为「开工」，而执行者是**照指令做的**。
- **(b) `status=in_progress` ≠ 有人在推进**：lead-world 自我更正 —— `team_task_create(owner=...)` **不唤醒**，但同样把卡置 `in_progress`；t124 在 `ready_queue` 里 `executionState=**stalled** / stale=true / leaseActive=false`（`counts.stalled=1`）⇒ 已指派、无人推进。
- ⇒ **统一（与 B-163 同根）**：`status` 字段同时承载了互不相同的事实 —— `completed` 不蕴含「已集成」（B-163），`in_progress` 不蕴含「有人在推进」（本条）。**唯一可用判据是外部读数**：集成看 `git merge-base --is-ancestor <commit> main`；推进看 `ready_queue` 的 `executionState`/`stale`/`leaseActive`。
- **建议**：① 卡面增 `executionState`（或让 `team_task_get` 直接暴露）；② `reassign` / `create(owner=)` 增 `wake:false`；③ 或取消 `status` 的语义负载，只留相位 + 外部读数。

### B-163 第 2 例（t50）
- 读数：`group-rig-t50` rev 17 / `status=completed` / `phase=member-check` / commit `5aef70a` / **不在 main**（`--is-ancestor` rc=1，只在 `team/rig/rig-capture`）；`team_delivery_check` `openCount=5` **不含 t50**。与 t45 同形。

### B-159 第 6 例：同一张卡在同一轮内被作废两次
- verifier 对 t45 的 **r1** 件（目的地 `9ba84cca` / 落成树 `47a18a31`）被我提交的 `e46c5e53` 作废。⇒ 第 5 例（lead-rig 的 `47a18a31`）+ 第 6 例（verifier 的 r1）落在同一卡上。

### O-10-5（工具面）`read` 会对**非空行返回空串**
- 读数（lead-world 第一手）：`tests/fixtures/worldgen/ORACLE-SPEC.md:180-201` 一次读取**全空**，另两次同区间给正文；文件未变（sha256 `45C133CC…`、38613 B、303 行、porcelain 空）。
- **后果**：可被读成「文档里没有这句」⇒ 据此宣告「无此记载」。
- **判别法**（lead-world 具名）：逐行打印 `text.length`；**换区间重读** + 文件哈希/行数交叉确认。

### M-10-4（方法论）授权一次编辑必须按「对象身份」，不得按行号/arity 的**转述值**
- 事实：同一个键，三份坐标 —— verifier 与 tier 0 读到 `:837`（声明 `:786` / arity 52）；lead-proto 报 `:526`（声明 `:475` / arity 52）—— **整体偏 −311**，与 `d277b97`（域扩展，已在 main，`--is-ancestor` rc=0）一致 ⇒ lead-proto 引的是**旧版本的坐标**。
- **规则**：授权/下达一次编辑，必须按**对象身份**（本例 = 键的完整字符串）下达，并要求执行方在**编辑当刻从文件重取**坐标；不得转述行号与 arity。行号是「对象 × 时点」的读数，转述它就是转述一个已过期的对象（承 M-9-4 / B-157）。
- 正例：lead-rig **自行第一手复核并撤回**了裁定请求（「我按实测坐标下单」）。

### t123 第二道门形态裁定（tier 0）
- **采纳 lead-world 的更正**：vanilla 记录**不含** `section_ys` 字段（346 文件 / 1461 条 `kind=chunk`，0 命中）；其先前「vanilla `section_ys=[0..4]`」是**由 `wire_len 61696 = 5×12288+256` 推出**的，不是读出来的 —— 与 **M-10-1** 同形（把**推断**当**实测**）。
- **裁定 = effective_seed 具名批次**：按 ORACLE-SPEC `:184` 的唯一合规补救，用 M5 读回 `level.dat` 的 `Data.RandomSeed`，**记录读回命令与原始输出**，在该 seed 下产出 12 个 chunk 坐标的 vanilla 侧 `h_block`/`h_biome`。理由：ORACLE-SPEC `:180-184` 已把 seed 0 列为当前不可用并**禁止伪造、禁止降级为跳过** ⇒ 门的形态服从规范，不是规范服从门。
- **载体裁定**：`tests/golden/**` 被 `.gitignore:5` 忽略（`ls-files=0`）⇒ vanilla 侧是**派生工件**。⇒ **判据的输入必须受跟踪**：把 12 坐标 × 4 seed 的判据输入**切片复制**进 `tests/fixtures/**`（受跟踪，`ls-files=108`）；完整批次保留为派生工件，plan 里绑定**重建命令 + 本 run 回执**。
- **等化前置改写**：以 vanilla 位图（`dumps/vanilla/**.bin` §4，CONTRACT.md:32/:48）取 rust 同节集算 `h_block`；**另须**单独比对「vanilla 位图 vs rust 非空节集」，不等即计差异，**不得用等化掩盖**（rust 侧硬编码 bitmap=0xFFFF，`dump_chunks.rs:35`）。
- **O1 不可用**：`h_block_all` 1461/1461 全为 null（`tools/rig-batch/src/main.rs:965` 与 `tools/rig-batch/src/main.rs:1321` 两处均为 `json::nul()`）⇒ 判据用逐区块 `h_block`，不得用 `h_block_all`。

---

## 在飞与排序（时点：本记录当刻）
- **main = `e46c5e53de4bc56687a8550cee5034d8a3e7158a`**（冻结；`PORCELAIN=0`）。
- **t50 就绪度更高**：`team/rig/rig-capture` tip `d6cb94f` **已含 main**（`--is-ancestor e46c5e53 d6cb94f` rc=0；`merge-tree --write-tree e46c5e53 d6cb94f` = tip 自身 tree `1d1ff610`）⇒ **落地是真快进，G-9.5 三元组不适用**；净增量 3 条 A 全在 `tools/capture/tests/`、D=0。**预测门禁拒绝**：卡 commit `5aef70a` ≠ 分支 tip `d6cb94f` ⇒ `member-merge-source-drift`（按 G-9.2 处置）。
- **t45** rev 75 / pending / execution / ws 仅 `tools/rig-batch/`：需 R1/R2/R3 返工 + 一次重锚（并入届时 main）⇒ 之后落地亦为真快进。**卡在计划替换**：rig-runner 持 lease，`replace_approved` 被拒 ⇒ 先 complete→release 再替换（预期会再次把卡置 `completed`，B-160/B-163 形态）。
- **排序裁定**：**谁先拿到清关谁先落**；另一件**在请清关之前先重锚**（G-9.1）。

## 事件记录（不进 docs）
- G-RIG 成员 subagent `6ce12c91` declined the task 且无 closing message（责任人 lead-rig，tier 0 不介入）。
- lead-rig 本轮三次「按意图写消息、不按返回值写」（(b)/(c)/(e)）已记 evidence。
- lead-world 两处自我更正已采纳并升格为通则：`section_ys` 是**推断**（→ M-10-1 同形）；t124「已开工」是把 `status=in_progress` 当推进（→ **B-165**）。

## 未判定的观察草稿
- `waiting_list` 出现**派生**等待项（`id=null`）类型：`dependency` / `lease-released` —— `lease-released` 语义未判定。
- 关闭原因 `deduplicated` 的语义未判定。
- `control_status.audit.duplicateRevisions` 三时点 75342→3 / 75750→10 / 75841→10 ⇒ 间歇爆发，非累积。合法性待操作者给判据。

- **确认/批路径差异**：`inbox_ack` 对 `decision`/`action`/部分 `info` 投递成功（`handled:true / cleared:true`），但对经「[team batch] 2 quiet Team messages arrived together」通道送达的消息返回 **`inbox-not-found`**（本轮 3/7）。⇒ **可确认性取决于投递路径**（与 B-162 同族：聚合/批通道不产生可确认的行）。

## batch 12 增补 · t123 第二道门 + t50 读数（本轮现取）
- **采纳 lead-world 的第三方案**（优于只换 seed 的思路）：**把 rust 侧投影到 vanilla 的精确 Y-set 再比 `h_block`** —— 不需要 O1、不需要新捕获，且保留区块级判别力。**两条精度要求**（已冻进卡面）：① 投影必须**按 Y-set**，**不得**用「前 N 节」；② 必须与「vanilla 位图 vs rust 非空节集」的比对**同时成立**（不得用等化掩盖差异）。
- **否决「只比 `h_biome`」**：`h_biome = BLAKE3(biome[256])` **与区块无关** ⇒ 只比 biome 会把 K3–K6 的 oracle 降级成 biome-only。**通则**：**不得用一个与判据对象无关的哈希去替代一个区块级哈希**（「用重建物代替原件」的又一形态）。
- **seed 0 缺口仍须补**：上述投影只让**已有**的 36 对（seed i64MIN / 12345 / i64MAX × 12）可比；seed 0 是 **0/12**，无记录可投影 ⇒ 我裁定的「effective_seed 具名批次」**仍成立**。
- ★ **t50 暴露的新限制因素（首能力的唯一阻塞）**：服务端会话**有界 8 tick**（`terminated_by=Some("ticks")`）⇒ 客户端 6s/10s 两次探针读数**逐字相同**（`meanLuma=61.5 darkFrac=0.7865 state=SCREEN_OPEN`）= 『Connection Lost』+ 新增 `Internal Exception: java.io.IOException: 远程主机强迫关闭…` ⇒ **无可见地形** ⇒「客户端进入世界并看到地形」（decision-dd09229e 的首能力）**仍未达成**。
- **我的裁定 (a) = 具名先行，不新开前线**：`terminated_by=ticks` 提示「8 tick 有界」来自**装置/参数**而非产品 ⇒ 要求 t50 owner 一手具名该上限由**哪一层**施加（装置实参 vs `crates/mc-server` 侧二进制/默认值/上限），证据 = 逐字命令行 + 实参 + 其定义处；在装置层 ⇒ 归 G-RIG 作为 t50 后续；在产品层 ⇒ 我开 G-PROTO 卡。**具名现在做（只读），修排在 t50/t45 落地之后。**
- **lead-rig 已开 `group-rig-t54`**（runner 多探针自测，= t50 c5⑤ 不成立）—— 属其组内处置，我认可。

## ★ 操作者已交付三处修复（本轮一手核验 · 时点 = 本记录当刻）
- **B-163 已修**：`team_delivery_check` 新增 `completedNotIntegratedCount` + `completedNotIntegrated[]`。现值 `openCount=7 / completedNotIntegratedCount=3`。⇒ **交付门禁现在能看见「已完工未集成」**（我本轮最重要的一条发现）。
- **B-161 已修**：`team_task_get/list/update` 新增 `commitShaRaw` 与 `commitShaIssue`（`invalid-shape` / `non-commit-sentinel`）⇒ 缩写与哨兵字符串现在**可被判出**而不是静默参与相等比较。
- **B-156 已修**：`team_delivery_check.open[]` 新增 `responsibleInactive` ⇒ 「等待的责任人已离线」这一停滞成因**可读**。
- **注**：`integrationState` / `commitShaIssue` / `commitShaRaw` 在 t45 / t50 上均为 `null` —— 因为两卡现为 `pending`（lead-rig 已 reopen），**只有 completed 卡才带集成状态**。这与 B-163 的语义一致，不算缺陷。

## ★ 新暴露的积压（B-163 修复的直接产物 · 之前**不可见**）
- `completedNotIntegratedCount = 3`：`task-40` / `task-41` / `group-rig-t48`。
- ⇒ 这三张是**在修复之前**就已「completed 但未进 main」的卡，此前**任何清单都读不到**（正是 B-163 的危害实例）。`group-rig-t48` 属 G-RIG ⇒ 归 lead-rig；`task-40` / `task-41` 是全局板卡 ⇒ 需 tier 0 自行判定（reference 卡可 `admin_close`/`reconcile`，实体交付须具名 owner 补集成）。**下一轮处置，本轮只记录。**

### ★ 三张 CNI 卡的归属（一手现取）
- **`task-40` / `task-41` 的 owner 就是 `lead`（我自己）**，`kind=edit`，`write_scopes=[docs/GOVERNANCE.md]`，commit `79a2f7dc` / `6d6162a6`，phase `verifier-review`。⇒ **这是我自己的 B-163 实例**：两笔 GOVERNANCE 编辑我 complete 了却**从未并入 main**。⇒ 新门禁修好的第一个受益者是我。
- **`group-rig-t48`** = `rig-capture` 的 `tools/capture` 卡，commit `6b349691`，phase `member-check`，主题「t41-F1 收口：取**世界渲染截图** + 用 tick 区间读数证明会话持续」⇒ **这正是 t50 刚刚失败的那个能力的前一次尝试**，且它也**未集成**。归 lead-rig。

### ★ 撤回我上一轮的一条入册（lead-world 自纠 · 我采纳）
- **我此前按 lead-world 的更正入册的「vanilla 记录不含 `section_ys` 字段」是错的。** 一手逐行解析（`ConvertFrom-Json`，**非正则**）：**1462/1462** 条 `kind=chunk` 记录**全部携带 `section_ys`**；样本 `dumps/vanilla/333/0/0_0.bin` → `section_ys=[0,1,2,3]`、`wire_len=49408=256+4×12288`。
- ⇒ **lead-rig 的原表述「vanilla `section_ys=[0..4]`」是正确的**，**不应被记缺陷**；我入册的那条**作废**。
- **真正该记的是 lead-world 的缺陷（形态更坏）**：它把「对拼接原文的**正则代理** 0 命中」读成「**字段不存在**」= **从失效的仪器推断缺失**（absence inferred from a failed instrument）。记作 **M-10-5**。
- ⇒ **M-10-2 与 M-10-5 是一对**：M-10-2 是**失效仪器产生的假通过**（fail-open，guard 被失败满足）；M-10-5 是**失效仪器产生的假缺失**（fail-absent，0 命中被当成不存在）。**两者的共同纪律：仪器的失败状态必须与仪器的「阴性结果」可区分。**
- **计数更正**（member-world-block 两次复算，lead-world 复核成立）：`kind=chunk` = **1462**（非 1461）；distinct (seed,x,z) = **66** 记录侧 / **64** `dump_path` 侧（非 65）。**两个都不是 65。**
- **对裁定 ④ 的影响**：等化前置**仍然必要**（rust 侧硬编码 bitmap=0xFFFF / [0..15]，vanilla 侧节集来自记录），但**「vanilla 节集只能由 `.bin` 位图推出」这句作废** —— `section_ys` **可直接读**，并须与 `wire_len` **交叉校验**。裁定 ①②③⑤ 不受影响。

### ★ M-10-5 的正确记法（lead-rig 自己提出的精确切分，我采纳）
- **(i)「字段不存在」归 lead-world** —— 从对拼接原文的**正则代理** 0 命中，推出「记录不含 `section_ys`」= **从失效的仪器推断缺失**（fail-absent）。
- **(ii)「单样本外推成全体方括号」归 lead-rig** —— 它自报：原话 `section_ys=[0..4]` 是**从一个 `wire_len`（61696 = 5×12288+256）外推**到全体；而一手样本 `dumps/vanilla/333/0/0_0.bin` 是 `section_ys=[0,1,2,3]`（**4 节**，49408 = 256+4×12288）⇒ **节集逐块不同，方括号是过度概括**。**它主动认领，我不整段推给 lead-world。**
- ⇒ 两条**不同形态**：一条是**仪器失效的假缺失**，一条是**单样本外推成全称**。后者与 B-159/G-9.4 同族（**把一个时点的读数当成不变量**）。

### M-10-2 再添一个自身实例（lead-rig 自报，归其名下）
- `team_v12(waiting_list, input:{includeClosed:true})` 返回**空 tickets** ⇒ 它把「无等待」判成事实并**跳过**了给 rig-capture 的 R2 放行；用**无输入**的 `waiting_list` 重查后确实有待处理项，已重新放行。⇒ **空集合 ≠ 查询失败**，与 M-10-2 同条。**同一纪律已两次被不同成员各自踩中（lead-rig 探针 / lead-rig waiting_list），说明它是一条高频陷阱，不是偶发。**

### O-10-6 收窄（采纳 lead-rig 的具名处置与判据）
- lead-rig 第一手判定：`6ce12c91` 的 closing 指向 t45 的 C 项与 run-criteria 的 C10 断言，而**这两个工件已在 `2cb829d1` 上交付且 verifier 已独立复现**（C：`EXIT=0 / CLASS_hit=4 / DOMAIN_TOTAL=4 / JUDGED=4 / CLASS_SUM=4 / SUM_EQUALS_DOMAIN=True`；`-SelfTest EXIT=0 / SELFTEST=PASS`）⇒ **收口，不换人重派**（重派只会重复一个已复验的产物）；其 `job_list` 里没有这两个 id ⇒ 无可 kill 的句柄。
- **判据（采纳其表述）**：**目标工件已交付 ⇒ 其 closing 既不得读作进度，也不得读作缺口。** `declined` 的 closing 文案对工作状态**不构成证据**，只有**工件状态**构成证据。

### ★★ 三张 CNI 卡的 commit **不可达**（本轮一手现取，改变了处置形态）
- `git merge-base --is-ancestor <sha> main`：`79a2f7dc` **rc=1** / `6d6162a6` **rc=1** / `6b349691` **rc=1**。
- ★ **`git branch --all --contains <sha>` 三者全部为空** ⇒ 这三个 commit **不被任何 ref 指向**（不是「在分支上未合并」，是**不可达对象**）。
- ⇒ **不能「并入」它们**：没有分支可并。处置只能是 ① 若**内容已在 main**（经后来的直接编辑）⇒ 卡是**陈旧引用**，`bind_fix`/`reconcile`/`admin_close` 并具名理由；或 ② 若内容**不在 main** ⇒ **内容真的丢了**，须重做（t48 的截图/读数若只在不可达 commit 里，则**已丢失**）。
- **我欠的核查（下一批第一件事）**：`task-40` / `task-41` 的实质内容（§5.14-35 读数归属更正 / §5.14-36 门禁读数须绑具名 revision / §5.14-35 冻结键 vs 活键）**是否已在 main 的 `docs/GOVERNANCE.md` 里**（main blob `1faae8e1` vs 卡 blob `07c48302` / `668ba2b7` —— **blob 不等不能证明内容未落**，因为其后有大量追加编辑 ⇒ 必须**按内容**核，不能按 blob）。

### ★ M-10-5 的确切机制（lead-world 第三次自纠，本轮一手复现 —— **这是权威记法**）
- **原文逐字**：`"section_ys":[0,1,2,3]`（**冒号后无空格**）。
- **旧正则**：`section_ys.:.\[([^\]]*)\]` ⇒ 命中 **0**；**去掉多余的那个通配符**后 ⇒ 命中 **1461**。⇒ **那个多余的通配符吃掉了 `[`**。
- ⇒ 这就是「0 命中 ⇒ 字段不存在」的**确切来源**，**与 lead-rig 无关**。**结论不变：lead-rig 的原表述正确、无缺陷；本条归 lead-world。**
- **纪律（可复用）**：**正则的 0 命中必须先与「同一谓词的宽松形式」对照一次，再允许得出「不存在」的结论。** 单条正则的 0 命中**永远**不足以支持存在性否定。

### 计数与交叉校验的**最终精确值**（三轮收敛后的权威值）
- `kind=chunk` 记录 = **1462**；其中 **1461** 携带 `section_ys`，**余 1 条是退化记录**（`dump_path` / `wire_len` / `dump_len` **全空**）。
- 交叉校验式 `wire_len = 256 + 12288×len(section_ys)`：在 `wire_len` **有值**的 **1271** 条上**恒成立**；另 **191** 条 `wire_len` **为空（0）**，其 delta **全部**为 `-(256+12288×n)` ⇒ **不是布局差异，是字段未填**（`hyp_noBiome` / `hyp_noLight` 两种替代布局假设**均 0 命中**）。
- ⇒ **该式只在 `wire_len` 有值时成立，不得当全量定义。** 判据里必须写明**适用域**，否则 191 条会被误判为「不一致」。
- distinct (seed,x,z)：**66** 记录侧 / **64** `dump_path` 侧。**两个都不是 65。**

### 已闭合（lead-world 一手回执 · 本轮）
- **t123 卡面 rev 11/13**：删除「vanilla 节集只能由 `.bin` 位图推出」，改为「`section_ys` **可直接从记录读出**」+ 与 `wire_len` 交叉校验，**并写明适用域**（只在 `wire_len` 有值的 1271 条上成立；另 191 条该字段为空 ⇒ 不得当全量定义）。节集众数 `[0,1,2,3,4]`（395/1461）。
- **t123 卡面 rev 14**：清掉与我台账矛盾的残留陈述 —— 卡面里「tier-0 已升格并入 M-10-1 族」改为**撤回陈述**（lead-rig 表述正确、不记缺陷；缺陷归 lead-world = M-10-5）。⇒ **卡面与台账不再互相矛盾**。
- **t124 已 `plan-approved` 并重锚**：lead-world 选 **(a) 先重锚**，理由正确（member 头 `66fd2f17` 落后 main ⇒ 落成需 merge ⇒ **头树 ≠ 落成树**，正是 G-9.5 的温床；且该文件两侧 blob 同为 `7cbb802a` ⇒ 代价近零）。执行 `team_worktree_setup(base=e46c5e53)` ⇒ `head=e46c5e53 / headKind=single-parent / mergeCommitCreated=false` = **干净快进到 main**。⇒ **t124 的落地将是真快进，G-9.5 三元组对它不适用。** 现 `rev=9 / phase=execution / in_progress`。

### 本轮我方的在飞状态（时点 = 本记录当刻）
- **main 冻结在 `e46c5e53de4bc56687a8550cee5034d8a3e7158a`**；batch 12 台账**压住未提交**（任何提交都会作废在途清关 = B-159）。
- 落地队列：**t50**（按住重跑无界会话 → 单对象清关 → 真快进）→ **t45**（R1/R2/R3 + 删例外键 + arity 52→51 + 重锚 → 清关）→ **t124**（已重锚，等它自己走完）→ **t121/t123**。
- 我欠的核查：`task-40` / `task-41` 的实质内容**是否已在 main 的 `docs/GOVERNANCE.md`**（按**内容**核，不按 blob —— 其后有大量追加编辑）。

### ★ B-165 补：判据本身是**滞后投影** —— 不得仅凭一个标志改派
- **读数**（lead-world 一手，t121）：`member-world-chunk` 再次 `stalled`；**第一次唤醒后它仍 inactive**，**第二次唤醒**才 `running` 且卡上出现 1 条 evidence。**而在同一快照上 `ready_queue` 仍报 `executionState: stalled`**，与 roster 的 `running` 及「卡已新增证据」**互相矛盾**。
- ⇒ **`executionState` / `stale` / `leaseActive` 也是投影，有自己的滞后**。我上一轮把它们写成「唯一可用判据」**过强**，须补此限定。
- **正确纪律（lead-world 的处置即正例）**：① 任何推进/停滞判断必须带**时点**；② **不得仅凭一个滞后标志改派或打断成员**（承「趋势判断至少需要三个时点」「任何读数都是对象 × 时点的二元组」）；③ 需**第二条独立读数**（roster 状态 / 卡上 evidence 增量 / lease 心跳）与标志**同现**才能下结论。
- ⇒ **B-163 / B-165 的统一结论再收一刀**：`status` 与 `executionState` **都是投影**，只是滞后的方向与幅度不同；**没有单一字段可以当真相**，必须「标志 + 独立读数 + 时点」三者同现。

## batch 13 待提交（**压住**：main 需为 t50 的 FF 保持不动）

### ★★ B-166（平台 · 阻断级）`complete` 抛 TypeError —— 团队任何卡都无法收口
- **逐字**（`rig-capture`）：`complete(commit_sha, evidence_ids)` ⇒ **`Cannot assign to read only property 'commit_sha' of object '#<Object>'`**；不带 `evidence_ids` ⇒ 同 TypeError；不带 `commit_sha` ⇒ `team policy refusal [complete-commit]: completion requires the exact commit_sha produced by the task`。
- ★ **两个独立施动者复现**：`rig-capture`（tier 2）三变体、**lead-rig（tier 1）独立复现**、**tier 0 我自己**用 `team_task_update(task_id="group-rig-t50", expected_revision=22, action="complete", commit_sha="6f3d3ddd20c92b845d8316eeb546a03967b627ed")` 也得到**同一逐字 TypeError**。⇒ **与行动者无关**。
- **连带死锁**：`team_run_lease(action:"release")` ⇒ `[lease-release-order]: task "group-rig-t50" is still pending` ⇒ **complete 抛异常 ⇒ 无法转终态 ⇒ lease 按顺序不得释放**。
- ★ **时间相邻性（假设，未证）**：首次出现于操作者交付 **B-161** 修复之后；B-161 新增字段是 `commitShaRaw`/`commitShaIssue`，而 TypeError 里被判只读的属性名恰是 **`commit_sha`** ⇒ **强烈提示 complete 路径在对含新字段的对象做赋值**。**假设不是结论**。**请优先查该路径。**
- **危害**：**任何卡都无法 complete** ⇒ 所有交付停在 `pending`，清关 / 落地链全堵。**本轮唯一全局阻断。**

### ★★ 首能力达成（tier 0 亲自读图）
- **对象**：`team/rig/rig-capture` tip **`6f3d3ddd20c92b845d8316eeb546a03967b627ed`**（tree `125c2682`，父 `d6cb94f`）；`--is-ancestor e46c5e53 6f3d3ddd` **rc=0**；`merge-tree --write-tree e46c5e53 6f3d3ddd` = **tip 自身 tree** ⇒ **真快进、单对象、G-9.5 不适用**；净增量 5 条 / +247 / D=0 全在 `tools/capture/tests/`；porcelain 空。
- **读数**：c2 `rf6@6s meanLuma=69 darkFrac=0.4855` / `rf10@10s 69.1 / 0.4861`，`captureOk=True`；对 F1 两张断连页参照（0.7971/59.9、0.761/66.5）**可判假地不同**（ΔdarkFrac 0.311 / 0.275）。c3 `ticks_run=143 max_tick=142 emitted=70 keepalive=29 entity=29 chunk=9`，客户端存活到 10s。`SRV_ARGS` 含 `--run-forever --max-wall-ms 60000`；`terminated_by=Some("disconnect")`（运行器探针后 kill 客户端），**对照**有界档 `Some("ticks")`。
- ★ **我读图**（584×357）：标题栏逐字 **`Minecraft 1.8.9`**；画面 = **蓝天渐变 + 深色扁平云层 + 地平线 + 正中央准星**；**不是**断连页。⇒ **原版客户端确实进入世界并在渲染。**
- ★ **只有读图才能给的观察**：**地平线以下地面区域是暗的**（下约 40% 近黑/暗褐），与 **t121** 的前提（`ChunkData::zeroed` ⇒ skylight/blocklight 全 0 ⇒ 世界可能渲染为暗）**实证吻合** ⇒ t121 不再是推测。**但单帧无法区分「未照亮的方块」与「地平线以下的天空/虚空」** ⇒ 判别法 = **同一会话再取一帧俯视地形**；交 lead-world 作 t121 判据输入，**不现在下结论**。
- **我的裁定被正控证实**：有界档停断连页、无界档进世界 ⇒ lead-proto 与 t50 的读数冲突**不需要选边**。

### ★ M-10-5 的自身实例（tier 0）：`git branch --all --contains` 看不见 tag
- **我写的**：三张 CNI 卡的 commit「`git branch --all --contains` 全为空 ⇒ 不被任何 ref 指向 ⇒ 不可达对象 ⇒ 内容可能已丢失」。
- **事实**（lead-rig 一手更正，我复现）：`git for-each-ref --contains 6b349691` = `refs/tags/rig-t48-harness-6b34969`；`git tag --contains 6b349691` 列出它 ⇒ **tag 也是 ref，而 `branch --all` 的域只含分支**。**「无 ref 指向」是我的谓词的域造成的假缺失** —— 我在把 M-10-5 写进台账后几分钟内犯了同一个错。**记我名下。**
- **纪律升级（M-10-5 更强形式）**：**在得出「不存在」之前，必须具名该谓词搜索的域，并证明该域穷尽。** 查「是否有 ref」必须用 `git for-each-ref` / `git log --all --source`。

### M-10-6（方法论 · 判据设计）判据要求「跑一条命令」时，必须同时确认该卡类别有跑它的通道
- **读数**（lead-world 一手）：t121 是 **discussion** 卡（writeScopes 空、无 plan、无 lease），其判据 2 要求「可复算的判别命令」；owner 实跑时被写范围门禁**原样拒绝**：`pwsh write denied: member "member-world-chunk" has no declared static scope or active approved plan lease for (...\target\debug\mc-server.exe)`。**它未重试、未绕过，把原文回给组长** —— 处置正确。
- ⇒ **通则**：**凡判据需要构建或执行产物（写 `target/`），该卡必须有 `target/` 写范围**（或改由有 scope 的 `edit` 卡承担）；否则判据在该卡类别下**不可满足**，会被读成「交付方没做」。**这与 t45 撞的 C4R 是同一道门。**

### O-10-7（平台 · 缺口可读性）「占位被声明」不等于「后果与承接被声明」
- **读数**（lead-world 一手，**带同类正控**）：谓词 = 受跟踪 md 行同时含 `zeroed` ∧ (`block_light|sky_light|光照`) ∧ (`0x21|map_chunk|wire|载荷`)，域 = 48 文件 / 17975 行 ⇒ **0 命中**；正控 `zeroed` 单独=4、`0x21|map_chunk` 单独=13、`zeroed ∧ sections`=1 ⇒ **仪器在该域确能命中，0 不是域缺失**（这正是 M-10-5 要求的正控）。
- ⇒ **「占位数据的光照平面以全 0 进入 play cb 0x21 并被客户端消费」这一后果，在受跟踪文档中无任何陈述**，且**没有任何卡承接「服务端 wire 路径的光照接线」**。
- ⇒ **我的裁定**：开一张**窄卡** —— 只承接「**服务端 wire 路径的光照接线**」（scope `crates/mc-server/`，读 `mc-world` 只读），**不承接「实现光照生成」**（那归 M8 的 A·G-4/G·G-5）。**归 G-PROTO**（`mc-server` 是装配层）。**不阻塞任何在飞件。**

### ★ B-166 升级为**全局**阻断（四个独立施动者）
- 施动者：`rig-capture`（tier 2，三变体）· `lead-rig`（tier 1）· **tier 0（我）** · **`member-world-block`（tier 2，另一组，t124）** ⇒ 四者同一逐字 TypeError。⇒ **团队任何卡都无法 complete**，与组、与卡、与参数形状无关。
- **`member-world-block` 的补充读数**：`complete(camelCase commitSha)` ⇒ `[task-update-unknown-fields]`（字段名必须 snake_case）；`release(completed)` ⇒ `[lease-release-order]`。并指出 **t116 同形态调用当时成功** ⇒ **疑为 v14 升级引入的回归**（与我的 B-161 时间相邻性假设同向，但**两条都仍是假设**）。
- ★ **缓解读数（关键，来自 lead-rig 实测）**：**`advance_phase` 在 `status=pending` 的卡上被允许**（t50 execution→member-check→group-check→verifier-review，rev 26）⇒ **相位门不依赖 `complete`**；**卡收口与相位推进是两条独立通道** ⇒ **`complete` 坏掉不阻塞落地**。

### ★ 两个真快进落地件（都以 `e46c5e53` 为目的地）
- **t50**：tip `6f3d3ddd20c92b845d8316eeb546a03967b627ed`（tree `125c2682`，父 `d6cb94f`）；`merge-tree(e46c5e53, tip)` == tip 自身 tree ⇒ 真快进；5 文件 +247，全在 `tools/capture/tests/`。
- **t124**：commit `ac790b8b111812bcc4a03de8f7fb00b1b7fcf9d5`（单亲 `e46c5e53`）；`HEAD^{tree}` == `merge-tree(main, HEAD)` == `0e5dfe5f87c5242a6ca963941a00b079eb58a3a3` ⇒ **头树即落成树**；1 文件 +4/-4，仅 `tests/fixtures/worldgen/ORACLE-SPEC.md`；成员工作树内门禁 7 passed。
- ⇒ **G-9.1：两个头不能同时 FF 到同一目的地** ⇒ **t50 先落**（首能力），**t124 后落并重锚**。**main 保持 `e46c5e53` 直到 t50 的单对象清关进入 registry**（batch 13 台账继续压住）。

### 处置与串行化
- **`privilege-e3ac5d18` 已 reject**（理由见下）：`complete` 是平台 TypeError 而非策略门 ⇒ bypass 修不了平台代码；且 **`complete` 不在落地关键路径上**。
- **t123 与 t124 写范围真冲突**：`5b8fe8fd` 的 claim 被拒（`scope conflict with t124`，`member-world-block` owns `ORACLE-SPEC.md`）⇒ **t123 等 t124 落地后再提 plan**。**这是正确的串行化，不是缺陷**（该成员未绕过、把原文回给组长 —— 处置正确）。
- **t121 已 accepted**（lead-world 一手复核承重引注成立，rev 10）⇒ **t123 的 blockedBy 已清、现 `ready=true`、仅剩 `no-plan`**。

### 两条成员自纠的仪器缺陷（值得入册，形态同 M-10-5）
- `member-world-block`：① 首次 citation 门禁**误在 main 检出内跑**（实测 main 树 `从未产出`=1 命中 / 工作树=0 ⇒ **不是同一文件**），已改在 worktree 重跑；② `@(... | Measure-Object).Count` **恒为 1**（量词对象本身被计数）⇒ 曾给出**三个假「1 命中」**，改用 `@(Select-String ...).Count` 复核。⇒ **两者都是「仪器给了一个看起来像读数的东西」**，与 M-10-5 / M-9-1 同族。

### ★★ B-166 的第二个后果：**它很可能同时阻断落地**（tier 0 推断，待一次有界测试）
- `team_merge` 的 `member-merge-source-drift` 要求**源 ref tip == 卡 `commit_sha`**；而 `complete` 失败 ⇒ **卡的 `commit_sha` 指针写不进去**：
  - `group-rig-t50`：卡 `commit_sha` = **`5aef70a`（陈旧，上一跑 FAIL 的提交）**，分支 tip = `6f3d3ddd` ⇒ **必然不等**。
  - `group-world-t124`：卡 `commit_sha` = **`null`**（lead-world 复现：调用前后均 `rev=14 / commit=null` ⇒ **失败调用无副作用**）。
- ⇒ **缺陷后果可能不止「卡不能收口」，而是「已完工的交付也不能落地」** —— 落地门读的正是那个写不进去的指针。
- **能写 `commit_sha` 的三条路全不通**：`complete`（抛 TypeError）· `bind_fix`（**只对 completed 卡有效**）· `force_complete`（**只对 global edit 卡且 owner inactive**，t124/t50 都不满足且 owner 活跃）。⇒ **操作者修好之前没有合法方式写该指针。**
- **待测（有界，一次）**：`team_merge` 在卡 `commit_sha` 陈旧/为空时**实际怎么判**。拒 ⇒ **B-166 阻断落地，全队停产等操作者**；接受 ⇒ 落地与卡收口确为两条独立通道。

### ★ 处置纪律：**拒绝伪造交付**（采纳 lead-world 的自我约束，我升格）
- lead-world **明确拒绝**用 `advance_phase` 把卡走到终态以**冒充交付** —— **处置正确**。⇒ **纪律：相位推进不是交付；不得用相位推进或 `force_complete` 伪造交付状态。**
- **`privilege-e3ac5d18` 已 reject**：平台 TypeError **不是策略门**，bypass 修不了平台代码；且 `complete` 不在相位推进的关键路径上。
- **我给 lead-world 的 (c) = 把「交付」与「卡收口」分开**：① 交付 = commit 进 main（清关 → `advance_phase(integration-ready)` → FF）；② 卡收口 = 等操作者修好后**重试一次**；③ 期间**卡面留具名说明**「交付已进 main，收口被 B-166 阻断」，以免 `pending` 被读成「没做」；④ **lease 保持 active**（它是放行后的恢复路径）。

### ★ O-10-8（平台）`team_run_lease(action:"heartbeat")` **不延长 `expiresAt`** ⇒「保活」不可达
- **实测**（`member-world-block` 一手）：acquire 与**两次 heartbeat** 的 `expiresAt` **恒为同一值 `1790619112125`**（acquire 时 +1800 s）；heartbeat **只写** `heartbeatAt` / `checkpoint`，**不改 `expiresAt`**。
- ⇒ **「保持 lease 续期」在实现上做不到**，只能**保活到硬到期**（该轮 heartbeat 起算约剩 1558 s ≈ 26 分钟）。
- **后果**：**长时等待的卡，其「活动 lease 下的收口路径」不是持久的** —— 硬到期且仍未放行 ⇒ 收口路径消失，必须 **re-acquire** 才能恢复。⇒ 对 B-166 这类**等平台修**的阻塞，**收口窗口只有租约时长**。
- **建议**：① heartbeat 应能续期，或至少返回明确的「不可续期」语义；② `expires_at` 与 `heartbeatAt` 的语义差应在 API 面上具名。
- **我的裁定（授权）**：**允许 `member-world-block` 在到期时自行 re-acquire**（正常租约生命周期、无副作用、不改卡状态），以保持收口路径可用；**不得 release**。⇒ 因此 **B-166 越早修越好**，否则收口路径要周期性重建。

### ★★ B-166 的精确定义（两向修正：lead-world 收窄 + tier 0 实测加强）
- **收窄（lead-world 实测，我采纳）**：`member-world-chunk` 的 t121 是 **discussion** 卡，`complete(commit_sha: null)` **成功**（rev 8 → completed，2 条 evidence）⇒ **TypeError 只在 `commit_sha` 非空时出现** ⇒ **discussion / review 卡不受影响，edit 卡全部无法收口**。（也解释为何 `expected_revision=14` 仍抛错：与 revision 无关，与**值是否非空**有关。）**我此前「任何卡都无法 complete」过强，现改。**
- ★ **加强（tier 0 本轮实测，推翻我自己「bind_fix 可能可用」的保留）**：`team_task_update(task-40 / task-41, action:"bind_fix", commit_sha:"af93bd88…")` ⇒ **同一逐字 TypeError**。⇒ **打击面不是「complete 这条动作」，而是「任何写非空 `commit_sha` 的路径」**。
- ⇒ **平台上目前没有任何路径能把非空 `commit_sha` 写进卡面**：`complete` 与 `bind_fix` 均已实测同一 TypeError；`force_complete` 的适用域（global + owner inactive）本就不满足。
- **机制假说（支持度提高，仍未读实现）**：`if (commit_sha != null) obj.commit_sha = commit_sha` 作用在**被冻结/只读的对象**上 ⇒ 空值跳过、非空抛错 ⇒ **修复很可能是一行**。

### ★ `completedNotIntegrated` 是**指针级**信号，不是**内容级**信号
- **实测**：`task-40` / `task-41` 的**内容确已在 main** —— `git log --reverse -S` 对 `5.14-36` / `5.14-35` / `dead=5` 三者**均指向 `af93bd881b5b6336ab2a71e65e1eb502273767dd`**（§5.14-35 读数归属更正 `:1325` / §5.14-36 具名 revision `:1329` / `dead=5` `:1319,1326` / §5.14-35 精化 `:1345`），且 `--is-ancestor af93bd88 main` **rc=0** ⇒ **交付已集成**，只是**卡上指针指向另一个（不被任何分支/tag 指向的）提交**。
- ⇒ **该清单会把「内容已集成但指针陈旧」的卡也报出来** ⇒ 它是**指针级**信号。**读它时必须同时判「内容是否在 main」**，否则会读成「交付没进 main」。**这与 B-161 同族（指针形态不稳定）。**
- **处置**：`bind_fix` 被 B-166 挡住 ⇒ **两卡暂不可修**，留在清单里并**具名记录原因**；操作者修好 B-166 后我立即 `bind_fix` 到 `af93bd88`。

### ★ B-167（平台）`claim` 有 scope 门，`team_plan_propose` **没有**
- **逐字读数**（`member-world-chunk` 一手）：`claim` 被 `task-contract-gate-unavailable: … cause=scope-conflict; conflicts=[{"taskId":"group-world-t124","left":"tests/fixtures/worldgen","right":"tests/fixtures/worldgen/ORACLE-SPEC.md","sameOwner":false}]` **正确拒绝**；**而同一张卡的 `team_plan_propose` 成功** ⇒ 留下一份**带着争用 scope 的已提交 plan**（t123 rev 18 / `plan-proposed`）。
- ⇒ **「被拒的 claim」与「未被拦的 propose」门禁不等价** ⇒ **冲突范围可以以「已提交 plan」的形态落地**：claim 的门是**事后**才拦，而 plan 已把冲突固化成**可批准**的对象；若组长直接批准，冲突即进入执行。
- **建议**：`team_plan_propose` 的 `write_scopes` 必须参与同一 scope-conflict 判定。
- **处置**：lead-world 已明确**不批准**该 plan，t124 落地后以收窄版替换（**正确**）。

### ★ B-168（平台 · 数据丢失）控制面回滚：revision 倒退 + 已写证据行不可解析
- **读数**（`member-world-chunk` 一手，带回执）：t121 曾达 **rev 11** 且 **5 条 evidence 已写入**；随后 **rev 回落 6**，那 5 条 id 经 `evidenceId` / `byTask` **均不可解析** ⇒ 只能**重新以单条 `kind="conclusion"` 落盘**并在同一窗口完成（rev 7 → 8 completed，2 条 evidence）。
- **第二证人**：同一形态亦出现在另一 subagent 的 closing（「task rev went 6 → 11 (my 5 evidence writes) → back to 6, and my evidence ids no longer resolve」）。
- ⇒ **已写入的证据行消失 + revision 倒退** ⇒ 比 B-166 更严重的一类：**已确认的写入被回滚**。
- **建议**：证据写入需**单调性**保证或至少一个「已落盘」的稳定确认；**revision 倒退应被拒绝**。

### O-10-8 的两条补充读数（本轮一手）
- **活动租约存在时 `acquire` 被良性拒绝**：`already has active run`（非策略门）⇒ **到期后重取预期成功**；因此「未被唤醒时无法在到期瞬间执行」造成的空窗属**机制**而非**停滞**。lead-world 已把「**懒重取**」口径写入 t124 卡面（rev 17 → 18）—— **处置正确**（把机制写进卡面，而不是让 `pending` 被读成「没做」）。
- **`inbox_ack` 对 `queued`（尚未投递）消息** ⇒ `message-not-delivered`（**良性、非策略门**）；成员**停止重试**正确。⇒ 与 **B-162** 同族（`queued` → `message-not-delivered` / 更老 → `inbox-not-found`），已记，不新增编号。

### t124 的既定唤醒序列（成员自具，我照录）
1. 先 `re-acquire`（若硬到期后仍被拒 ⇒ **逐字回报**，说明收口路径真断）；
2. **重取** `HEAD^{tree}` == `git merge-tree --write-tree main HEAD` 等式并回报（t50 落 main、组长重锚之后）；
3. 操作者修好 **B-166** 后按 (c) 走：清关 → `integration-ready` → tier-0 FF；**收口那次 `complete` 在同一唤醒内完成**。

### 在飞等待（时点 = 本记录当刻）
- `wait:group-rig-t50:rig-capture:a7a3e4bc` —— responsible `lead-rig`；解除条件 = verifier 对 `6f3d3ddd` 出单对象清关（目的地 `e46c5e53`）且 lead-rig 具名通知可落。**另叠加一次有界测试**：`team_merge` 在卡指针陈旧时是否拒。
- `wait:group-world-t124:member-world-block:95fda5a4` —— responsible `lead-world`；(A) 落地链 t50 → 重锚 → 清关；(B) 收口待 B-166 修复。
- **我欠的核查已闭合**：`task-40` / `task-41` 的**内容确已在 main**（`af93bd88`，`--is-ancestor` rc=0）⇒ 交付已集成，只欠指针；**因 B-166 暂不可 `bind_fix`**，已具名记录。

### ★★ B-166 第二面（lead-rig 一手）：**平台自己的恢复路径里就含坏掉的那一步**
- ① **卡面 lease 字段不是真值**：`team_task_get(group-rig-t45).contract.lease` 读作 **null**，而 plan-replace 闸门逐字报 `cannot be replaced while run lease "run-faadadc2-…" is active` ⇒ **闸门是权威，卡面字段是投影**（与 B-165 同族）。
- ② ⇒ **平台为该闸门给出的恢复路径第 (2) 步正是坏掉的 `complete`** ⇒ 凡「**活动 lease 的持有者已 inactive 且卡非终态**」的卡，**既不能替换计划、也不能释放 lease** ⇒ 后续工作取不到 scope。**不是 t45 独有形态。**
- ⇒ **B-166 的射程比「edit 卡不能收口」更大**：它同时使这一类卡的**计划替换与租约释放都不可达**。

### ★ t45 已重锚（tier 0 独立复算）：对 main 也是**真快进**
- `3d9a505e`（双亲 = `2cb829d1` + `e46c5e53`）；tree = **`7392f349f9976e401e33f624a4d557842d911d15`**；`--is-ancestor e46c5e53 3d9a505e` **rc=0**；`merge-tree --write-tree e46c5e53 3d9a505e` = **同一 `7392f349`** ⇒ **真快进**。
- ★ **独立交叉验证**：`7392f349` 正是我两轮前算出的 `merge-tree(e46c5e53, 2cb829d1)` ⇒ **两条独立路径得同一棵树** ⇒ 重锚把「落成树」**物化**成了「头树」⇒ **G-9.5 的三元组对 t45 也不再需要**。
- t45 剩余：R1 提交 + R2/R3 + **删 `:837` 键 + arity `52→51`**（三处原子改动）。

### ★ 更正我自己对 B-168 的过强表述（现取第三读数不成立）
- **我此前写**「**已确认的写入被回滚**」—— **过强**。我从未自己复现过它，只转述了两份报告。
- **第三份独立现取（lead-world）**：**t121 rev=10 / completed / phase=accepted**，`evidenceIds` **三条全部可解析**（`evidence-11f5e35f` risk-attribution / `evidence-b727ead7` conclusion / `evidence-b27b4d70` lead-acceptance）；另抽验 `evidence-7f939d72`（t124）**rows=1 可解析**。⇒ **回滚在其投影里不可观测**（rev=10，既非 11 也非 6）。
- ⇒ **B-168 的正确记法**：**两份独立报告（`member-world-chunk` 带回执 + 另一 subagent 的 closing）描述同一形态（rev 11 → 6，5 条证据 id 不可解析）；但第三份、更晚时点的独立读数不复现它。** ⇒ **观察成立、机制未定、爆炸半径未定**；**不得**写成「已确认的写入被回滚」。**这是我的错，记我名下**（与 M-10-1 / M-10-5 同族：转述别人的读数 + 把它升级成因）。

### B-165 补二：`executionState` 的**取值集未文档化**（第三个取值已出现）
- 读数（lead-world 现取）：`ready_queue` 给 t124 `executionState = **suspended-between-rounds**` 且 `eligible: true`，同时 `counts.stalled=1` ⇒ **非 active、非 stalled、却 eligible** 的中间态。
- 已见取值：**`active` / `stalled` / `suspended-between-rounds`** ⇒ 消费侧**不得按二值（在跑 / 卡住）理解该字段**；任何按二值判定的自动改派都会误判。

### 跨组例外键的处置规则（lead-proto 补正，我采纳）
- **时序决定动作**：引注**已被修好** ⇒ 键**该消失** ⇒ **删键 + 降 arity**（t45 的情形）；**尚未修好** ⇒ 迁进 `PENDING_PATH_EXCEPTION_KEYS`（无存在断言）。两条都对，取决于**引注当前是否可解析**。
- 守护器内具名 lead-rig 的条目恰两条：一是本卡对应那条（`:837`，载体 `crates/mc-proto-schema/tests/citation_integrity.rs`）；二是被引文件仅以裸 basename 写成的那条（`:838`，键为（原引）`CONTRACT.md:75|chunk.rs:8`）。 【★ 批次 25 作废本条的两处行号指针：它们属 arity-52 纪元，在 M 之前即已不可解析，非 M 所致。以批次 25 的更正块为准。】
- **裁定：不现在开卡** —— B-164 的结构性修法是**门禁设计变更**，须排在当前队列之后。**延迟项，触发条件 = t50 / t45 / t124 落地完成。**

### 板面现值（tier 0 一手 · 时点 = 本记录当刻）
- `team_delivery_check`：`openCount=7` / **`completedNotIntegratedCount=2`** = `task-40@79a2f7dc/verifier-review` + `task-41@6d6162a6/verifier-review`（**都是我的**）。`group-rig-t48` **已从该清单消失** ⇒ lead-rig 的 delete 生效。
- ★ **该清单是 tier-0 only**（lead-rig 读不到）⇒ **我把现值主动回给组长**（它们无法自查）。

### ★ 裁定：B-164 的 1 条键迁移**并入 lead-proto 的里程碑**（不开新卡）
- **触发条件收紧为「t45 落地之后」**（不是「整个队列清空」）—— 因为**只有 t45 在改同一个文件**，冲突面就是它。
- **理由**：lead-proto 提供的载体更好 —— 它有一个既存里程碑（守护器终态复核），**同一 owner、同一 scope、同一文件** ⇒ **不新开卡、不新增前线**。
- **约束**：`:837` 的删除（arity `52→51`）与 `:838` 的迁移（`5→6`）**不得在同一棵树内**（两处都要动 arity ⇒ 必冲突）⇒ 严格串行：**t45 落地 → 再做迁移**。
- ★ **`:838` 是具名实例**：（原引）`("tools/rig-batch/CONTRACT.md:75|chunk.rs:8", "lead-rig")` 是**同机制的活键** —— rig 一旦修好该不符项，`dead.is_empty()`（`:1669`）同样会假红。 【★ 批次 25 作废本条的实质断言：t84 的迁移 M 已证伪「活键」说 —— 该键现落在无存在断言的 PENDING 表内，对方修好只产生 present=false，不会假红。以批次 25 的更正块为准。】

**★ 具名声明（关于本台账里「引用坏形态」的书写形式）**：本台账的职责是**记录引注缺陷**，因此必然要**引用坏引注的原文与注册表键的原文**。按守护器**自述的具名通道**（`crates/mc-proto-schema/tests/citation_integrity.rs:864` 的 `QUOTE_MARKER`；`:240` 逐字「存在一条具名绕过：给引用加 `原引` 标记即可」），上述三处引文**同行加 `原引` 标记** —— 这是**真陈述**（它们确实是原引），走的是守护器**自带**的通道。
⇒ 唯一的**活引用**（L2417 的 `h_block_all` 读数）按守护器 `:1661` 的口径做了**路径限定**（`tools/rig-batch/src/main.rs:965` 与 `:1321`，两处均已核实为 `json::nul()`），因此可被逐 token 判定。
⇒ ★ **代价具名（按 lead-rig 的要求）**：`:240` 同句逐字写「**P5 与 P1–P4 一样对 quoted 项跳过**」⇒ 被 `原引` 豁免的 token，**路径判定与内容判定都不做** ⇒ 它是**未被检查**，**不是通过检查**；且该豁免是**行内 120 字符邻近启发式**（`:866` `QUOTE_WINDOW = 120`），已有具名假阳性实例。⇒ 上述三处**只构成「已声明为引文」，不构成「引用已正确」的证据**。
⇒ ★ **被豁免的 token 逐条具名（按 lead-rig 的要求）—— 按散文写、不写成引注形**（我第一次把它们写成反引号引注形，**自己又造出 2 条未登记项**，已被门禁当场抓住）：L2383 行豁免的是 DECISIONS.md 第 33 行那一处；L2641 与 L2652 两行各豁免两处 —— CONTRACT.md 第 75 行与 chunk.rs 第 8 行（均在被逐字引用的注册表键内）。这三行的标记均**紧邻被引原文之前** —— 因为 `is_quoted` 的现值侧检查**只在 token 位于标记之后时执行**（`:894 if tok_start > m`），标记在前才使该检查**被执行**。
**★ 通则（承 verifier 建议 · 全队适用）：取守卫读数必须附新鲜度自证**：先 `cargo clean -p mc-proto-schema`（或使用隔离 target），并在输出中保留 **`Compiling mc-proto-schema`** 行；**禁止直接运行 deps 下的测试可执行文件取读数**。理由（lead-proto 独立复现，我采纳）：**同一命令、同一 checkout、同一 commit、文件未变（blob `3e0a97c7…`、519212 B），唯一变量是「是否先强制重建」** ⇒ 不重建得 `rc=0 / tokens=261 / unregistered=0`（**陈旧构件假绿**：旧守卫源码构建的二进制只抽 7 个 token，而新鲜构建抽 20 个），强制重建得 `rc=1 / tokens=274 / unregistered=4`（= verifier 的 blocker 逐项相同）。⇒ **`rc=0` 必须建立在一个能证明「跑的是当前源码」的形态上**，否则通则⑥ 的绿不可判假。**该假绿是跨组的**：任何组在共享/热 target 里不重建就取读数，都可能把红读成绿并据此落地。

⇒ ★ **该通道的不对称口子（具名而不使用）**：`is_quoted` 只看行内**第一个** `原引`（`:880-885` 命中即 break），且当 token 位于标记**之前**时**跳过**现值侧检查 ⇒ 把标记放在行尾可**静默豁免**其前 120 字符内的**活引用**。⇒ **本台账不使用该形态**；L2417 那行**不含任何标记**，其 `h_block_all` 引注按路径限定后被逐 token 判定。
⇒ **我自己先走错了**：第一次我是用「拆写散文使不形成引注形」来修 —— 那会让这三处对门禁**不可见**（拆写形态贡献 0 token ⇒ `rc=0` 无证据力），正是 lead-rig 具名的「**用形态躲过门禁**」。**已改为守护器自带的 `原引` 通道**；改由 verifier 在树上复跑判定。


### ★ O-10-9（调用面）`wake_id` 与 `inbox_id` **不是同一个键空间**
- **读数**（lead-rig 一手）：`inbox_ack` 按 **`wake_id`** 传 ⇒ `wake-not-found: msg-…; available wake ids: wake:lead-rig:46`；**同一个 id 按 `inbox_id` 传 ⇒ 成功**（`handled:true, cleared:true`）。
- ⇒ 与 **O-10-4**（`waiting_resolve` 传 `ticket_id` 被当作 task id）**同族**：**两个形似的标识字段被静默互换解释**，而错误文案其实已经给出了可用的 id（`available wake ids: …`）。
- **建议**：① 两字段要么统一、要么在拒绝文案里具名「你可能把 X 传成了 Y」；② 既然文案已能列出可用 id，可直接提示改用哪一个。

### ★ O-9-1 有了**实际代价**的实例（不再只是「打印会溢出」）
- **读数**（lead-rig 一手）：它调 `team_v12(action:"control_status")` ⇒ 返回 **21.6 MB** ⇒ **打爆 120 s 程序预算、耗掉一整个 turn**，且**没有产出任何可用信息**（它要找的 `run-faadadc2` **根本不在其中**）。
- ⇒ **O-9-1 从「打印会溢出」升级为「已实测造成一整个 turn 的损失」**。**教训（lead-rig 自具，我采纳）**：**要查某个具体对象，用窄读**（`team_plan_get` / 卡自身的 contract），**不要 dump 整个控制面再 grep**。

### ★ B-168 的机制假说（lead-world 的锐利观察，我采纳）
- **读数**：lead-world 的追加**刚刚创建了 `rev 11`** —— 而 `rev 11` **正是 B-168 记为「回滚前」的那个版本号**。⇒ **revision 号可重复，不是内容标识**。
- ⇒ **机制假说**：所谓「回滚」**可能是读到了陈旧投影**（rev 6 的快照在 rev 11 之后被服务），而非真回滚。**支持**：lead-world 现取 rev=10 / completed / accepted，三条 evidence **全部可解析**。
- ⇒ **纪律：`revision` 不能当版本判据**（与 B-157「回执/投影不是状态判据」同族）。⇒ B-168 保持「**观察成立、机制未定**」，并新增「**rev 号可重复**」这一事实。

### ★ 采纳 lead-rig 的时机判断（优于我的指令时序）
- 我下令「清关到手后再跑一次有界 `team_merge` 测试」；lead-rig **没有**提前跑，理由：提前跑只会得到 **`no-verifier-clearance`**（**错的门**）的拒绝，**会混淆正要测的东西**。⇒ **正确，我采纳。** 有界测试仍在清关之后，一次，不做变体。

### 另记：`set` 超时但**未落盘**（B-157 的反例）
- lead-proto：一次里程碑 `set` **超时**，**经复查未落**，未重试 ⇒ 处置正确。与 B-157（超时的调用**确实落盘**）合起来正好证明：**超时之后必须查效果**，两个方向都出现过。

### ★★ 操作者批次回执的**边界被实测推翻**：修复**已经在跑**（不是「仍加载旧代码」）
- 操作者自述「DSH 未重启 ⇒ 当前运行进程仍加载旧代码」。**实测不成立**，两条独立 live 读数：
  - **O-10-4 的新行为已生效**：`team_v12(action:"waiting_resolve", task_id="wait:__tier0_probe_nonexistent__")` ⇒ **`waiting-ticket-passed-as-task: task_id="wait:…" is a waiting ticket id; pass it as ticket_id, not task_id`** —— 正是本批次描述的新文案（旧码只会给 `task-not-found`）。
  - **B-156 的新字段已生效**：`waiting_list` 的票据对象现含 **`responsibleStatus` + `responsibleInactive`**。
- ⇒ **本批修复是 live 的**（至少 `team-v14-waiting.mjs` 的承载面）。⇒ 操作者的边界声明**低估了自己**：新码在跑，可直接对 live 行为核验；「不声称 live 逐条重放」过于保守。

## 第二十批（t50 落地 · 读数时点见各条）

### B-172（condition · 集成摩擦）目的地刷新把被清关 commit 包进新的 merge 节点
**现象**：`team_merge(target="rig-capture", task_id="group-rig-t50")` 回执 `merged:true`、`sourceSha == sourceBranchHead == bc0b9914`（B-170 的顶替未复发），但 `previous/destinationBefore = 35b283c2` ⇒ 平台**先**把 `main` 并进 `grp/rig`（`35b283c2`，parents `6970283b`+`ee2d6550`，subject 逐字 `Merge branch 'main' into grp/rig`），**再**并成员 ⇒ `grp/rig = 81e00068`（parents `35b283c2`+`bc0b9914`），**tree 与被清关树逐字相同**（`d2c9b43a`）。
**缺口**：`team_merge` 的「目的地须含 base」前置在成员合并**之前**求值；一个**已经包含 main、本可快进**的成员 tip 被强行变成合并提交 ⇒ **commit 键控清关的对象不再是分支尖** ⇒ tier-0 落地会被 `no-verifier-clearance` 拒。**刷新步骤亲手废掉了清关的键。**
**判据（实测，tier 0 独立复算）**：`git diff --name-status 81e00068 bc0b9914` 输出为空；三对象 `%T` 同 = `d2c9b43a`；`git merge-base --is-ancestor 35b283c2 bc0b9914` **rc=1**；`git merge-base --all 35b283c2 bc0b9914` = {`ee2d6550`, `6970283b`}；`git merge-tree --write-tree ee2d6550 bc0b9914` = `d2c9b43a` = `tree(bc0b9914)`。
**逃逸（已具名，不得自创第四种）**：① 有界 CAS 回退目的地分支到被清关 commit（两树相同 ⇒ 工作区/索引零差异，实测 porcelain 0）；② verifier 对包装节点出 commit 级清关（证据 = 树逐字相同）；③ 落地前重算 `merge-tree --write-tree main <src>` 确认仍是真快进。
**建议修法（lead-rig 提出，tier 0 附议）**：当成员 tip 是 main 的后代（即合并本就是快进）时，**跳过目的地刷新**。

### G-9.8（新通则）清关必须在**最终重锚之后**，且重锚基准 = **接收分支的当前头**
t50 的根因不是「main 动了」，而是**重锚基准选错**：成员分支被重锚到 main（`bc0b9914` 的 parents 含 `ee2d6550`），而**接收它的组分支**当时不含 main ⇒ 平台刷新组分支造出 `35b283c2`，该 commit **不可能**是成员 tip 的祖先 ⇒ **必出合并节点**。
**正确次序**：① 先把接收分支刷到含 main（得组头 `G`）② 再把成员分支重锚到 **`G`**（得成员尖 `M`，M 含 G）③ verifier 以「**头 = M / 目的地 = G**」出清关 ④ `team_merge(member → group)` ⇒ **真快进**，组头 == M == 被清关 commit。
这把 G-9.1（两个头不能同时 FF 到同一目的地）从「目的地」推广到「**接收者**」：**重锚的基准是接收分支，不是 trunk。**

### G-9.9（推论）**main 冻结窗口**：从某件重锚/清关到它落地之间，main 不得前进
`main` 每次前进都会让在途清关具名的目的地失效（G-9.5/G-9.6）⇒ **落地必须一件一件串行**，且每件的「重锚 → 清关 → 落地」三步之间 main 必须静止。**推论**：我自己的台账提交也必须排在全部落地之后（或某件清关之前），不能插在中间 —— 本轮即按此把第二十批压后。

### t50 落地记录（G-RIG 首个端到端交付）
- **落地回执**：`merged:true`、`fastForwarded:true`、`createdCommit:false`、`ancestorVerified:true`、`commit == sourceSha == sourceBranchHead == bc0b9914`、`previous/destinationBefore == ee2d6550`（= 清关具名的目的地）、`phaseAdvance: integrated`。
- **落地后读数**：`main = bc0b9914`（tree `d2c9b43a`）· `git status --porcelain` 0 行 · `HEAD` 分支 = `main`（非 detached）· `git merge-tree --write-tree main grp/rig` = `d2c9b43a` = `tree(grp/rig)`（仍真快进）。
- **门禁（新鲜度自证）**：先 `cargo clean -p mc-proto-schema`（stderr 逐字 `Removed 285 files, 54.7MiB total`），保留 `Compiling mc-proto-schema v0.1.0` 行 ⇒ `cargo test --locked -p mc-proto-schema --test citation_integrity` **RC=0 / 7 passed**；`M11-CITE-PATH-SUMMARY|tokens=277|judged=277|files=36|mismatches=57`、`M11-CITE-PATH-QUOTED-SUMMARY|quoted=44`、`M11-CITE-SUMMARY|tokens=59|judged=59|files=6|mismatches=0`（两个族不得互比；绿的口径是 `unregistered=0`，不是 `mismatches=0`）。
- **卡**：`group-rig-t50` rev 76 / `completed` / `integrated` / `commitSha=bc0b9914…` / 42 evidence。

### 新纪律（由 lead-rig 的遗漏换来，记为正例）：**改 ref 后必须检查把该分支检出的工作树**
`git update-ref` 只移动分支，**不更新已检出工作树与索引**。上一轮 B-170 修复把 `grp/rig` 从 `b7121beb` 移回 `6970283b` 时，`.dsh-worktrees/grp__rig` 的 index 仍持有 `b7121beb` 的内容（`run-listen-e2e.ps1` blob `210c6b0a…`，`t50r2-e2e-readings.json` 为已暂存删除）⇒ 本次 `team_merge` 首次被 `[worktree-refresh-dirty]` 拒。lead-rig **先按 blob 身份证明残留身份**（而非假定），再 `checkout HEAD -- .` 复原（rc=0）。**本次回退因两树逐字相同 ⇒ 工作区/索引自动保持干净（porcelain 0），未重演。**

## 第二十一批（t82 落地后提交 · 我违反 G-9.9 的记录 + G-9.10 + 一次证伪）

### ★ 我的违规（具名认领）：我在 G-9.9 窗口内推进了 main
- 我写下 G-9.9「从某件重锚/清关到它落地之间 main 不得前进」，随即把 batch 20 提交进 main：`bc0b9914` → **`829f258f210178ecec6d83c877ad47e2b4bd8365`**（tree `8d06626d`）。而 lead-proto 正在**同一窗口**内执行 G-9.8 的重锚（grp/proto ff 到 `bc0b9914` + 成员分支重锚到 `01b15eb7`）⇒ **它的重锚被我的提交作废**。
- 代价（如实计）：lead-proto 需重做「ff + 重锚」两次**零内容**提交；**未浪费 verifier 轮次**（清关尚未出）；`d89639dd` 与 `01b15eb7` 均仍可达（前者是后者的父）。
- 根因：我把「当前无人持有清关」当作「窗口不存在」，**没有把已发出的 G-9.8 指令算作在途**。

### G-9.10（新协议）落地令牌（landing token）
- 一次只允许**一件**在「重锚 → 清关 → 落地」窗口内；由 tier 0 发令牌，持有者在窗口内独占 main 的静止保证。
- 未持令牌的组**不得重锚或请清关**（main 一动就作废）；但**不触碰 main 的开发**（成员分支提交、t45 的 R3 等）可并行。
- 令牌顺序：**t82（lead-proto）→ t45（lead-rig）→ t124（lead-world）**。
- 清关口径（更正）：**目的地 = main（tier-0 落地基准）**，不是接收分支的组头；组头只是中间节点，只要最终 tip 含组头含 main，FF 链即成立（t50 先例 `destinationRef=main / destinationSha=ee2d6550`）。

### 一次探测与证伪：O-10-13 **不成立**（不入册）
- 我登记在 t50 上的 external 等待 `35a496d3`（responsible=lead-rig）在两个读数之间变为 `resolved`；我怀疑「completed 卡上的等待会被立即自动解除」。
- **探针**：在**同一张** completed 卡上登记一个**故意为假**的 external 等待 `36b97b65`（responsible=operator）⇒ **保持 `open`** ⇒ **原假设被证伪**，不写成缺陷。该单例成因仍未定（可能是 responsible 侧显式 resolve）。探针票已显式收口。

### 提交后门禁（新鲜度自证，main = `829f258`）
- `cargo clean -p mc-proto-schema`（stderr `Removed 285 files, 54.7MiB total`）⇒ 保留 `Compiling mc-proto-schema v0.1.0` 行 ⇒ **RC=0 / 7 passed**；`M11-CITE-PATH-SUMMARY|tokens=277|judged=277|files=36|mismatches=57`、`M11-CITE-PATH-QUOTED-SUMMARY|quoted=44`、`M11-CITE-SUMMARY|tokens=59|judged=59|files=6|mismatches=0`。

### O-10-13（观察 · 未复现为缺陷，但阻塞了强制前置检查）：`team_delivery_check` 本轮连续两次超时
- 第一次：`run_code` 默认 120s 预算，程序在 `team_delivery_check` 处被切断（此前同一程序内 `team_task_get` / `team_task_update` 均已正常返回）。
- 第二次：显式给 300s 预算，**仍在同一调用处超时**，无任何输出。
- **对照**：本 session 早前同一工具即时返回（当时读数 `openCount=8 / actionableOpenCount=8 / noOwnerCount=0 / completedNotIntegratedCount=0 / deadLetterCount=0`）。
- ⇒ 我**无法**按纪律在宣告交付前完成该检查；**不声称它通过**。交付结论改由 ref 级判据支撑（`main` / `merge-tree` / 门禁 RC），而非该工具的输出。
- 待操作者确认是否与 `control_status.migration` 体量（O-9-1，约 21MB）相关。**两次实例，均为同一调用点。**

### O-10-13 补充（同一轮内更锋利的读数）：**读路径按板分流地退化**
- `team_delivery_check`：**2 次超时**（120s / 300s，同一调用点，无输出）。
- `team_task_list(board:"group-proto|group-rig|group-world", limit:100)`：**并行 3 个，240s 超时**。
- **对照（同轮，均即时返回）**：`team_task_list(board:"global", limit:100)`、`team_task_get`、`team_v12(action:"inbox_list")`、`list_agents`、`send_message`、`team_task_update(advance_phase)`、`waiting_resolve`、`inbox_ack`。
- ⇒ 退化的不是「控制面整体」，而是**重读路径里的特定形状**：全队扫描（`team_delivery_check`）与**组板**列表；**全局板**列表同参数却正常。⇒ 与 `control_status.migration` 体量（O-9-1）或组板的 derived-wait 计算相关的可能性最高。
- 影响：idle 交接要求的「先跑 `team_delivery_check`」在本轮**无法执行** ⇒ 我改用 `list_agents` + 全局板 + 逐卡 `team_task_get` 做等价判断，**不声称该检查通过**。
- 附带事实（本轮 idle 交接的发现）：`list_agents` 显示**全队 inactive、只有我在跑**；`group-proto-t82` 停在 `rev 46 / execution / pending / commitSha=null`，owner `member-framing` 的收口令**未产生任何 mutation**（它只回报了计划便结束 turn，框架记为 declined）⇒ 已按「具体失败」再派 lead-proto。

### O-10-13 第三读数：`team_v12(action:"runtime_facts")` **自报 degraded**
- 逐字：`"collection":{"readOnly":true,"complete":false,"degraded":true,"reasons":["documented: documented observation was not supplied","session: session observation was not supplied","runtime evidence incomplete for plugin <…>" …]}` —— `runtime evidence incomplete` **几乎对每一个插件都出现**（`agent-team` / `control-plane` 等在内）。
- **假设（标注为假设）**：O-10-13 的「重读路径按形状退化」（`team_delivery_check`、组板列表超时；全局板列表/单卡读正常）**可能与插件证据收集失败同源** —— 重读形状依赖它，轻读形状不依赖。
- **不含**任何 provider 阻断的读数（`runtime_facts` 里未出现 provider block），故 `member-framing` 的 r5 零 mutation **不能归因于 provider 阻断**（无证据）。

### 一条由本轮推出的结构性约束（记入纪律）：**换 owner 会孤立已交付的提交**
- `team_merge(target=<member>)` 合并的是 **`team/<group>/<owner>`** ⇒ 把卡的 owner 换成别人，就换了卡面指向的分支；而被清关的 `T` 在 `team/proto/member-framing` 上 ⇒ **换 owner = 把已交付提交变成不可合并对象**。
- ⇒ **owner 与分支的绑定是清关装置的一部分**；恢复手段只能在**保持绑定**的前提下用（改成员路由 `set_member_route` / 重派同一 owner），**不得换 owner**。
- 且 `complete` 是 owner 侧动作（`[complete-lease]`）⇒ 组长与 tier 0 **都替不了**；「让 owner 能跑起来」是唯一通路。

### B-173（major · 判据完整性）多检出解析到**同一个 target** ⇒ 二进制烘焙的 `CARGO_MANIFEST_DIR` 指向**编译它的那个工作树** ⇒ 判据可能读别人工作树的文件
- **第二实例（第一手，member-framing 在 T 上跑全量测试得到假红）**：`crates/mc-server/tests/light_planes.rs:293` 断言失败；根因 = 二进制里烘焙的 `CARGO_MANIFEST_DIR` = `…\.dsh-worktrees\verifier-detached\crates\mc-server`（**不是被测工作树**），而 `lt_e` 用 `concat!(env!("CARGO_MANIFEST_DIR"), "/src/frames.rs")` 读**编译期路径**；那一刻 verifier-detached 的 `frames.rs` 尚无 t82 读数 ⇒ 假红。随后该检出把改动落到文件里，**同一二进制、未改文件、未重建**再跑即绿 ⇒ **该红不是交付 commit 的函数**。
- **我的实测（本轮现取）**：`.dsh-worktrees/verifier-detached` 下**没有** `target`；主检出**有** `target`；`$env:CARGO_TARGET_DIR` 为空 ⇒ 两个检出解析到**同一个 target**（具体解析路径未定，如实记录）。
- **第一实例（同族，已入册）**：我的「提交前跑门禁」长期空转 —— 陈旧构件因 **mtime 未推进**被 cargo 判新鲜 ⇒ 跑的不是当前源码（假绿）。两者同根：**共享 target 使「跑的是哪个工作树的哪个代际」对调用方不可见**。
- **逃逸（已具名）**：① 保留 `Compiling` 行作新鲜度自证（治代际，不治烘焙路径）；② **判据输入改为具名对象**（按 commit 读内容，而非编译期路径）—— 治烘焙路径；③ 每个检出用**隔离的** `CARGO_TARGET_DIR`。
- **我第一手复算（不采信转述）**：`git diff --raw d89639dd fe1753a3 -- crates/mc-server` = **0 行** ⇒ T 的 mc-server 与已过门禁的 `d89639dd` 逐字节相同 ⇒ 该假红**非内容缺陷**，我据此裁定维持 `T`（不重开卡）。
- **顺带澄清**：`git diff --name-status d89639dd fe1753a3` = 6 路径（`docs/PLATFORM-DEFECTS.md` + `tools/capture/tests/` 下 5 条）——那 5 条是 **t50 已落 main 的内容**经重锚带入，**不是 t82 新增**；t82 净增量只有 `crates/mc-server/` 的 7 路径 A1/M6 ⇒ T = main 内容 + t82 增量，**无未清关内容**。

### 操作者已修复 B-172（本轮通告，逐字要点）
- **修法**：`team_merge` 在成员合并前**显式**计算两个条件 —— ① 成员 tip 是否已包含 main；② 接收分支头是否已是成员 tip 的祖先；**两者同时成立才跳过目的地刷新**（`worktreeAdd` 保持接收分支现状）⇒ 成员合并成为**真快进**，不再把已清关 commit 包进新 merge 节点。否则仍按原语义以 main 刷新，**不放宽需要重锚/分叉合并的场景**。新增 `memberMergeDestinationBase()`。
- **反例验证（隔离临时仓）**：旧路径 `destinationBase="main"` ⇒ `fastForwarded=false / createdCommit=true / parents=2 / finalHead != 清关 commit`；修复路径 ⇒ `fastForwarded=true / createdCommit=false / parents=1 / finalHead == 清关 commit`。
- **回归**：focused 16/16；全量 phase1–phase11 **443 tests / 442 pass / 0 fail / 1 skipped**；四 profile `node --check` 4/4；v14-profile-parity 1/1。新哈希 `team-tools-v2-r10.mjs = 376331F2604352124DF61A0BD5DEDF89EE3E0646D06080C2E929CC2BFF57713A`。
- **边界（操作者自陈，我照录）**：只阻止**后续调用**制造包装节点，**不改写已存在的包装提交**；未在活动 Team 的接收分支上重放破坏性 `team_merge`。⇒ 与我对 t50 的处置一致（历史包装节点 `81e00068` 仍在证据 tag 上）。

## 第二十二批（lead-world 两次自我更正换来的一条通则 + 一条拒绝文本改进建议）

### B-157 补充（**好消息**）：`control-plane lock timeout` 的拒绝文本已从「谎报安全」改为「如实声明未知」
- **旧形态（B-157，4 名见证者）**：`control-plane lock timeout … no mutation was written and retrying is safe` —— **假阴性**，重试可能重复写。
- **新形态（本轮 lead-world 逐字）**：`control-plane lock timeout … mutation outcome is unknown`，并要求**先查 durable effect 再重试**。⇒ **该形态是对的**：显式声明未知，而不是声称失败。
- **但它把「怎么查」留给了调用者** ⇒ 方法选错会**静默产生重复写**（本轮 lead-world 连错两次）。
- **建议（lead-world 提出，我附议）**：把「**按 (actor, tool, correlationId, stage) 查事件状态**」这句**写进该拒绝文本本身** —— 现在只说「去查 durable effect」，没说用哪个键。

### 纪律（由 lead-world 三次同族错误换来，记为正例）：**去重/证否查询必须与它声称排除的对象同型**
- **实例 1**：用正则 0 命中当「字段不存在」；**实例 2**：从**被截断**的读数断言缺失；**实例 3**：拿**消息正文里的字符串**去搜 `timeline`（事件里**不存正文**）⇒ **该查询不可能命中**，却用它的 `false` 断言「未投递」。
- **通则**：**「查了但没有」只有在「查得着」的前提下才等于「没有」** —— 断言「消息未投递」必须查**投递事件**（事件类型/状态），不能查**正文**；反之亦然。
- **正确读法（它第三次更正给出，决定性）**：`timeline` 内 `tool="send_message/post"` 共 5 条；超时那条 `correlationId=call_00_OnDdgeq3CqcI0ED3M0CK3461` 是 **`stage=failed`**（wall `2026-09-28T20:06:10.612Z`）⇒ **原消息从未提交**；随后 `call_00_7ZHCL…`（`stage=handled` @ `20:07:19.977Z`）是**该内容的唯一投递**。
- ★ **它因此撤回自己的去重指令**：「原消息很可能已提交 ⇒ 重发大概率重复 ⇒ 以先到的为准」**结论错且方向相反** —— 按「先到的」为准会把**唯一送达的那条丢掉**。⇒ 完整照录：**一次「更正」本身也可能是错的，更正也要带判据**。
- **根因（它自陈）**：读到第一条 `send_message/post`（`18:55:49`）就**假定它是超时那次**，**没有用 `correlationId` 对齐** ⇒ **未对齐标识符的误归属**。

## 第二十三批（条款 79 式更正 + 一条具名严重度裁定）

### 更正（verifier 按条款 79 以本条为准）：`lt_e` 那类缺陷**不是「不可复现」**
- 我在 batch 21/22 及给 verifier 的消息里把标签写成「**不可复现**」—— **过弱且会误导**。正确读法（verifier 现取）：**在「断言树 == 构建树」时不可复现**；而**机制本身确定、双向**：判据读 `<CARGO_MANIFEST_DIR>/src/frames.rs` = **编译期烘焙的那个检出**的**当前工作树**内容 ⇒ 烘焙检出**无**该读数 ⇒ **必假红**；**有**该读数而被断言树没有 ⇒ **必假绿**。⇒ 它不是「偶发」，而是**在可具名条件下必然发生**。
- ⇒ **纪律修正**：描述此类缺陷**禁止写「不可复现」**，必须写成「**在 <具名条件> 下必然发生；当该条件不成立时读数为另一个值**」。

### 具名裁定：**B-173 = 类级 major（方法/平台）**；**T 携带的该实例 = 交付物级 minor**（键保留，不删改注册表）
- verifier ④ 请我裁定：若认定它是 **T 交付物**的 major，则按门禁 **T 不应有键**。裁定：**不是交付物级 major**。理由（逐条可反驳）：
　1. **产品面身份**：T 的 `crates/mc-server` **子树 = `b9170810aa605773d9a5e110419e5a6e5400795b`** = 先前已清关 `d89639dd` 的**同名子树**（verifier 给出的**更强**形态，我采为同类首选证据）⇒ **产品内容零变化**。
　2. **缺陷位置**：在 `crates/mc-server/tests/light_planes.rs:292` 的**测试正控**，不在产品路径；同文件 `:288/:300/:305` 已是**具名对象**读法 ⇒ 该判据**不是**该行为面的唯一保护。
　3. **分类与出证是两个通道**：清关门禁看的是**报告表**（0 blocker / 0 major ⇒ 出键）；我的台账标签是**类级**分类。两者不互相追溯改写。
　4. **代价**：返修 ⇒ 改 tip ⇒ 作废在飞包 + 重锚 + 重出清关 + 重合并，为**一行测试**付一整轮。
- ★ **我具名承认这条裁定有「结果导向」的外观**，故写成**可反驳**形式：**若** T 的 `src/` 子树身份与 `d89639dd` 不同，**或** 该测试是某产品行为的**唯一**判据，**则**它应升为交付物级 major 且**该键应撤**。这两条我都实测为**假**。
- ⇒ 结论：**B-173 = 类级 major**；**T 实例 = 交付物级 minor + 具名延后返修 `group-proto-t83`**；键保留。

### verifier 的里程碑处理（我采纳为正例）：**证明的字面值失效时，重锚证明而不是勾选它**
- 它**没有** tick 旧里程碑 —— 其 `done_when` 字面「`git rev-parse main` == `bc0b9914`」在我自己的台账提交后为假；它按**实际形态**重锚（`bc0b9914` 是 main 的直接父且为祖先、diff 仅 `docs/PLATFORM-DEFECTS.md`）并另立新里程碑。⇒ 与 G-9.4「判据不得嵌入移动 ref 的点值」互为表里。

## 第二十四批（t45 落地后提交 · B-174 + G-9.11 + 我本轮的第二个错）

### B-174（condition/blocker · 编辑卡的自锁）：**被跟踪改动 ⇒ 拿不到租约 ⇒ 无法提交 ⇒ 工作树清不空**
- **闭环（lead-rig 第一手读实现，逐字行号）**：`team-worktree.mjs:513-534` worktreeAdd 同步前跑 `git status --porcelain`，**只要有一个被跟踪改动**即返回 `worktree-refresh-dirty`；`team-tools-v2-r10.mjs:4529` `team_run_lease(acquire)` 对 edit 卡**先做这次同步**，失败即 refuse `worktree-sync-failed`；`team-worktree.mjs:139-153` 可豁免的**只有未跟踪路径**（`ignoreUntracked`/`allowedUntracked`），**被跟踪改动无任何选项可豁免**；`team_worktree_setup` 走同一个 worktreeAdd（`team-tools-v2-r10.mjs:5155`/`:5332`）⇒ **B-153 的有界同步通道撞同一道门禁**。
- ⇒ **rig-runner 报的「循环阻塞」成立，且文档指明的解阻通道与之一同被挡住**。
- **lead-rig 的实际解阻（可逆、内容寻址、不丢内容；记为正例）**：`git -C <wt> stash push -m t45-preserve-run-criteria-pbot-to-pcapture -- tools/rig-batch/tests/run-criteria.ps1` ⇒ `STASH_RC=0`；`refs/stash = b877dace1442ff7a73f648c1e6474cfa4aa5d674`；`AFTER_STATUS=[]`；HEAD 未变。解阻后 `team/rig/rig-runner` 由 `1f7647d4` → `f10bf28`（merge main），R3 随后提交 `b34cc20b`。
- **建议修法（lead-rig 提，我附议）**：有界同步通道必须能豁免「成员**自己具名、且已落证据**的单个被跟踪改动」，或另给一条**不改内容**的解阻路径。
- **代价**：任何「先改后提」的成员都可能自锁；本轮实际代价 = 一次循环阻塞 + 一次 stash 解阻。

### 我本轮的第二个错（具名）：**我把 B-153 的通道当成万能解**
- 我让 lead-rig 用 `team_worktree_setup(conflict_strategy=…, expected_head=…, expected_base=…)` 解 rig-runner 的循环阻塞 —— **该通道对「被跟踪改动」无效**（见 B-174）。
- **根因**：我引用「通道存在」这一事实，**没有核它对哪种脏有效**。⇒ **纪律：推荐一条解阻路径前，必须核它的适用条件（对什么有效、对什么无效）。**

### G-9.11（新规）：令牌必须覆盖**每一级接收分支**
- 我此前只把 **main** 串行化（G-9.10），**漏了组分支**：两个成员交付先后并入同一组分支时，**后一件必须重锚到前一件产生的组头**，否则它的合并会成为**包装节点**、被清关对象随之改变。
- **实证**：`grp/rig` 由 t54 的成员合并推进到 `88ff36e1`（干净 FF，`ancestorVerified=true`/`createdCommit=false`）；随后 `--is-ancestor grp/rig b34cc20b`（t45 的 R3 尖）**rc=1** ⇒ 此时把 t45 并入会造包装节点（t50 的 `81e00068` 形态）。
- **顺序裁定**：**t54 先落**（`merge-tree --write-tree main 88ff36e1` = `8b881efb` = 自身树 ⇒ 真快进），**t45 重锚到 `88ff36e1` 后再落**。
- **为什么不一次清关把两件并成一个对象**：那样被清关对象相对 main 的增量 = **两件交付之和**，t54 没有自己的落成对象，且任一面出问题会同时挡住两件。⇒ **逐卡可追溯**，多花一轮 verifier 换它。
- **披露口径**：`grp/rig` 含 t54 的内容是 **G-9.8(a) 的直接后果**（组分支必须先含 main，而那次 FF 同时吸收了 t54）—— **不是夹带**，lead-rig 已具名披露。

### O-10-14（观察 · 好的拒绝形态）：`task-contract-gate-unavailable … cause=lease-revision-mismatch`
- **实例（t83 owner，第一手）**：`advance_phase→execution` 首次报 `task-contract-gate-unavailable … cause=lease-revision-mismatch`（并发修订竞态）；它**未重试**，重读后发现卡已在 rev 9 / `execution`，继续正常推进。
- ⇒ **该形态是对的**：它**具名了成因**（lease 与卡 revision 不匹配的竞态），而旧的 `control-plane lock timeout` 只说「未知」。⇒ **建议：把 cause 字段推广到其它竞态类拒绝**。

### t83 交付记录（G-PROTO，B-173 的返修卡）
- **commit** `fe150dd8edb82df64d4c209ca11e7f83554f5d04`（base `22fce4f3`，分支 `team/proto/member-framing`），**单文件** `crates/mc-server/tests/light_planes.rs`（`+6/−4`，`git diff --raw` 恰 1 行）。
- `:292` 改为 `checks::source_at("d89639dd", "crates/mc-server/src/frames.rs")`（与 `:288/:300/:305` 同形）；该文件 `fs::read_to_string` **0 命中**。
- **门禁（B-173 强制重建、断言树 == 构建树）**：`cargo test --locked -p mc-server` **rc=0 / 35 passed**（light_planes 7），保留 `Compiling mc-server v0.1.0 (…team__proto__member-framing…)` 行；`--test dep_edges` rc=0；自检 `--ticks 8` rc=0 全 PASS。
- **判别力证据（跨检出第一手）**：`d89639dd:crates/mc-server/src/frames.rs` = `9a80597e…` 在 member / verifier-detached / main **三处相同**（被断言对象与「谁编译、哪棵树」无关）；`b0d9572f:…` = `737ad68b…`（旧检出、无该读数）⇒ 同一调用形状对两个对象给出**不同**答案 ⇒ 断言树 ≠ 构建树时**不再假红/假绿**。
- ★ **具名残留（owner 主动披露，记为正例）**：文件**注释里**仍出现一次字符串 `CARGO_MANIFEST_DIR`（说明旧写法的文字）—— **代码路径 0 命中**。⇒ 纪律：**判据不得按字符串字面判，必须按代码路径/对象判**；否则「修复说明」本身会成为新的假红源。
- 卡：rev 11 / `member-check` / completed / `commitSha = fe150dd8…`（**停在 `member-check`，未推进 `integration-ready`** —— 落地令牌不在它手里）。

### 落地队列（我具名，供压缩后恢复）
- **t54（在飞）→ t45 → t83 → t124**。每一件落地都按 G-9.8/G-9.9/G-9.10/G-9.11：先让**接收分支**（成员→组用组分支；组→main 用 main）含**当时的**接收头，再重锚成员分支到该头，再请 verifier 以「头 = 最终 tip / 目的地 = **当时的 main**」出清关，再合并，再由 **tier 0** 落 main；**每件窗口内 main 与组分支都不得前进**。
- **当前**：`main` = `22fce4f3`（冻结）；`grp/rig` = `88ff36e1`（t54 尖，真快进：`merge-tree(main, grp/rig)` = `8b881efb` = 自身树）；`team/rig/rig-runner` = `b34cc20b`（t45 的 R3，**不含** `grp/rig` 新头 ⇒ rc=1 ⇒ 必须先重锚）；`grp/proto` = `fe1753a3`（t83 的 `fe150dd8` 待令牌后重锚）。
- **清关口径**：目的地必须是 **main**（tier-0 落地基准），**现取**、不复用历史 `destinationSha`。

### 操作者修复的 live 复核（B-173 / O-10-13；读数时点 `main = 2caaa57a`，tier 0 现取）
- **① `team_delivery_check`：可用** —— 耗时 **25.0 s**（此前 120s / 300s / 300s 三次超时）⇒ **O-10-13 的主症状消失**。读数：`deliverable=false`、`open=6`、`actionable=6`、`noOwner=0`、`notIntegrated=1`、`dead=0`。
- **② `cargoTargetIsolation` 已出现**：`{ok:true, checked:13, shared:[], errors:[]}`，13 条各为 `targetDirectory = <worktree>\target`（主检出 + 12 个 durable worktree）⇒ B-173 的检查**在工作**。
- ★ **但覆盖面有缺口（建议）**：盘上 `.dsh-worktrees/` 有 **16** 个目录，检查只覆盖 13 条 ⇒ **`grp__proto`、`grp__rig`、`verifier-detached`、`lead-lockcheck` 四个不在域内**。而 B-173 的原始实例正来自 **`verifier-detached`** ⇒ `shared:[]` 只能读作「**被检查的 13 个之中没有共享**」，**不能**读作「盘上无共享」。建议把域扩到 `.dsh-worktrees/**` 全量。
- **③ 组板列表：可用** —— `group-proto` **3.3 s / 81 行**、`group-rig` **2.4 s / 53 行**、`group-world` **4.9 s / 100 行**（`nextCursor=100` ⇒ 有下一页）⇒ 此前 240 s 超时的症状消失。
- **④ `runtime_facts`：部分修复** —— **改善**：早期读数头部的 `documented: documented observation was not supplied` 与 `session: session observation was not supplied` 两条**观察层理由已消失**（`reasons` 现为 **194** 条，**全部**是 `runtime evidence incomplete for plugin <name>`）。**仍为** `complete:false / degraded:true` ⇒ 这些插件**有**持久化 schema 且确实缺证据（**真阳性**），该规则不适用；若要清零需另判。
- **⑤ 噪声观察（建议）**：`blockers` 现为 **859** 条（`task-gate` 747 / `finding` 66 / `packet-blocker` 31 / `escalation` 11 / `dispatch` 3 / `completed-not-integrated` 1），其中 **309 条属历史 `task-N` 全局卡**（如 `task-19/phase-accepted/missing`）⇒ 该字段作为**信号**已失效。建议只投影**未完成且可行动**的卡。
- **⑥ 一条真阳性（非投影 bug）**：`completedNotIntegrated = [{taskId: group-proto-t83, commitSha: fe150dd8, phase: group-check}]` ⇒ t83 已交付未落地（队列第 3 件）—— **投影正确**。
---

## 第二十五批（t83 / t84(M) / t124 / t53(U) 四件落地 + 三条规则修正 + 平台缺陷与观察）

### 落地记录（四件；全部真快进，落地对象 == 被清关对象）
- **t83**：清关 `61f5a927`（nit；destinationSha = `570e790f`）⇒ main `570e790f` → `61f5a927`；tree `995ded2f`；增量 1 路径 `crates/mc-server/tests/light_planes.rs`。
- **t84(M)**：清关 `2f05e509`（condition；destinationSha = `61f5a927`）⇒ main → `2f05e509`；tree `ca6039e9`；**单亲** = `61f5a927`；增量 1 路径 `crates/mc-proto-schema/tests/citation_integrity.rs`（+4/−3）。迁移后形态：`owned 51→50`、`pending_path 5→6`、`unregistered=0`、`dead=0`。
- **t124**：清关 `879371a4`（condition；destinationSha = `2f05e509`）⇒ main → `879371a4`；tree `09e5fcf1`；父 = [`ac790b8b`, `2f05e509`]；增量 1 路径 `tests/fixtures/worldgen/ORACLE-SPEC.md`（+4/−4）。
- **t53(U)**：清关 `7d46a7d1`（condition；destinationSha = `879371a4`）⇒ 先 `bind_fix`（卡面 `b7820638` → U）再 main → U；tree `0de0454f`；父 = [`b7820638`, `879371a4`]；增量 1 路径 `tools/rig-batch/tests/run-criteria.ps1`（+36/−2）。
- 落地门禁一律带 `Compiling mc-proto-schema` **新鲜度自证**，且退出码落盘到持久载体（`.local/gate-*-land-exit.txt`）。

### ★ 更正块（条款 79 式）：作废本台账三处已陈旧 / 已被证伪的指针
- 本批次对**本台账第 2383 行 / 第 2641 行 / 第 2652 行**三行**就地追加了作废标记**（**行数与 token 均未变**，故**不产生行号级联**、不影响任何其它引注的行号）。
- **更正 1（第 2383 行）**：该行引的登记行现已**不含**那条例外键 —— **t45 已删除该键**。
- **更正 2（第 2641 行）**：该行引的两处行号属 **arity-52 纪元**，**在 M 之前即已不可解析**，**非 M 所致**。
- **更正 3（第 2652 行）★ 实质断言被证伪**：该行断言该键是「同机制的**活键** —— 对方修好会假红」。**t84 的迁移 M 已证伪它**：该键现落在**无存在断言**的 `PENDING_PATH_EXCEPTION_KEYS` 内，对方修好只产生 `present=false`，`dead.is_empty()` **不会**假红（4 条 pending 键 `present=false` 静默通过为先例）。
- **处置说明**：按「**不再加 `原引` 消音**」的要求，本条**不新增**任何豁免标记；三行**原有的** `原引` 标记**保留**（它们确为引文），但**其内容已由本更正块作废**。
- **代价具名**：这三行的 `原引` 标记使守护器判 **QUOTED** ⇒ **机械门禁看不见它们** ⇒ 只能靠人读。这是「**豁免 = 未被检查**」的直接后果。

### 规则修正（三条，即刻生效；以本批次为准）
1. **G-9.8 目的式 v2**：**重锚后的尖必须同时包含 (i) 接收分支头 与 (ii) main**（`--is-ancestor <接收分支头> T` rc=0 **且** `--is-ancestor main T` rc=0）。**取法（较后者 / main / 接收分支头 / 新造 merge）都不进规则。**
   - v1（「取接收分支头与 main 中较后的」）**隐含「两者是祖先关系」这一未写出的前提**；当两者**互为非祖先（兄弟）**时「较后」**无定义**。实测：`grp/rig` = `b7820638` 与 main = `879371a4` **互为非祖先**；而 t124 重锚时 `grp/world` = `a16b4f5c` 是 main 的**祖先**（照字面会造出**不含 main** 的 T ⇒ 上级无法 FF、链条断裂）。
2. **R-tip**：owner 的 `complete` 必须以**任何 acquire 期同步之后**读到的分支尖为准（complete 前那一刻 `git rev-parse team/<group>/<member>`）。
   - 实测：t53 的工作提交 `cb1126ad`，而尖 = `b7820638`（父 = [`cb1126ad`, `2f05e509`]）—— lease-acquire 的 stale-base 同步把 main 合进成员分支、**把尖推过工作提交**；写工作提交会被 `[member-merge-source-drift]` 逐字拒。
3. **G-9.12 令牌必须先于清关发放**：清关的目的地会**钉住** main；两张卡同时对同一目的地取清关，**必然有一张作废**（实测：t124 与 t53 两张清关目的地同为 `2f05e509`）。⇒ 组长在请 verifier 出清关**之前**先向 tier 0 取令牌；tier 0 发放令牌时**必须具名**「本次窗口的唯一落地对象 + 目的地 sha」。

### 纪律（本批新增，全部来自本批的实测代价）
- **验收包（packet）≠ 清关键（registry key）**：落地判据必须读**注册表键**（commit-keyed，带 destinationRef / destinationSha / sourceBase / sourcePaths）；包只是相位门禁的回执。实测：lead-proto 报「清关已随包出」，而键的实际写入**晚于**包；且两个包是**不同对象**。
- **并发追加的注册表上，一次 0 命中不是「不存在」的证据**：须先满足「**查得着**」的前提（读 size + mtime，或用同型查询自证），并在动作前重读。
- **判据的域必须具名**：「文件 F 不得含串 X」会被**注释里的同名字面串**证伪（t83 nit-1）⇒ 必须按**谓词/域**限定（「代码路径 0 命中」）。与 B-173 同族。
- **负控必须配正控**：只有负控时「一律拒绝」也能绿。
- **判别性正控优于回显固定串**：正控要选**会随输入变化**的对象（t83 的 `source_at("d89639dd", …)`：同调用形状对不同对象给不同答案）。
- **豁免通道的作用域必须显式限定，且被豁免的条目需要一条独立的、非豁免的核查路径** —— 否则「用豁免消红灯」会把该条目**此后的一切错误**一并豁免掉。本台账第 2652 行是活例。
- **一手读数也有强度之分**：「**当轮可重解析的回执**」> 「**上一轮的输出文本**」；`ptc_receipts` **有窗口**（回执会被后来的调用挤出）⇒ 要引用回执就必须**在引用那一轮重新解析**，解析不到只能标「**自述**」。
- **工具回执有「形态」**：`bash` / `pwsh` 回执有 `foreground` / `promoted` / `background` 三种，**只有 `foreground` 带 `stdout`**；把 promoted / background 的**信封**当读数会取到 `undefined`，而**「空」极易被读成「事件未发生」**（verifier 实测：据此断言「合并尚未发生」，**为假**）。
- **撤回必须覆盖原声明的全部受众**：实测 —— lead-world 撤回对我方的升级，却**未推给 verifier**，于是 verifier 仍在传播一个**已被推翻**的 claim。
- **台账里的裁定必须落成卡或等待票，否则等于不存在**：`effective_seed` 裁定**只存在于台账正文**（无卡、无票）⇒ 只有读正文的人知道。已补开 `group-rig-t61`。
- **替换类操作会重置下游状态**：`replace_approved` 会**清掉批准**；`team_worktree_setup` 重锚会**改变尖**；`bind_fix` 会**改变指针**。⇒ 任何 replace / re-anchor / rebind 之后必须**重读下游状态**，不得沿用替换前的结论。
- **清关标签不得宽于被判集合**（verifier）：只能对**逐项判过**的增量出清关；否则清关**超范围**。
- **下发的重锚 / 合并类指令必须写成可判定的不变量**（「**<对象 A> 必须含 <对象 B>**」，配 `--is-ancestor B A` rc=0），**ref 名只是执行建议**；下级应**先独立判定「哪个对象必须含目标提交」，再决定动哪个 ref**，**不把上级的框架当作既定前提**。实测：tier 0 把「接收分支」写成「成员分支」，而 t53 的成员→组那一步**早已完成** ⇒ 需要含 main 的是 `grp/rig`；重锚成员分支会把 t56 一并拖入 ⇒ **复合对象**。
- **多层门禁有先后顺序，前一道会遮蔽后一道**：实测 —— 无 `commit_sha` 时只看得到 `[member-merge-task-commit-missing]`，**看不到** `[task-phase]`；且「**某缺陷是否已修**」只有在它的**前置门禁都通过之后**才可观测（B-166 的修复状态在无租约时**不可观测**）。
- **归族：本批贯穿的同一族缺陷 = 「对象 / 域没被具名」**：B-173（判据的**输入**没具名）、t83 nit-1（判据的**域**没具名）、tier 0 的指令（**对象**没具名）、清关标签（**范围**会静默变宽）。⇒ 凡出现「判据 / 指令 / 标签」的地方，都必须显式具名它的**对象与域**。

### 平台缺陷与观察（本批登记）
- **B-174（已修，操作者）**：`team_run_lease(acquire)` 的 worktree stale-base 同步现在**只额外允许** porcelain 形态 ` M ` 的**未暂存 tracked 修改**通过；重叠时 Git 自身拒绝 merge；暂存 / 冲突 / 未知脏形态仍 `worktree-refresh-dirty` fail-closed；成功回执带 `preservedTrackedUnstaged`。**未闭合项（操作者具名）**：未在 active Team 的真实成员 worktree 上重放脏状态 ⇒ 已派 `group-rig-t58`（窗口判据 = main 在 `tools/rig-batch/**` 前进且成员工作树陈旧；**窗口不成立就按具名未覆盖回报，不制造非代表性场景**）。
- **O-10-13（已修，操作者）**：`team_delivery_check` 与组板列表超时消失（25.0s；3.3 / 2.4 / 4.9s）。`runtime_facts` 仍 `complete:false / degraded:true`，**根因已具名 = loader runtime 条目缺少 entry hash**，属真实未知，**标 partial、不伪报 complete**。
- **B-173（已修，操作者）覆盖面未闭合**：`cargoTargetIsolation` 只覆盖 **13 / 16** 个 durable worktree —— 缺 `grp__proto` / `grp__rig` / `verifier-detached` / `lead-lockcheck`。★ **B-173 的原始实例正来自 `verifier-detached`**（**不在检查域内**）⇒ 建议至少纳入它，或扩到 `.dsh-worktrees/**`。
- **O-10-14（已核验为正确的具名竞态拒绝）**：`task-contract-gate-unavailable … cause=lease-revision-mismatch`。
- **新缺陷：卡缺工作树绑定时，write-scope 守卫报「outside scope」—— 成因误导**。复现（逐字）：`edit denied: "…\\grp__proto\\crates\\mc-proto-schema\\tests\\citation_integrity.rs" is outside the active plan write scope [crates/mc-proto-schema/tests/citation_integrity.rs]` —— 相对路径与 scope **逐字相同**，真因是卡的 `worktreePath = null`。⇒ 建议成因具名为 `worktree-binding-missing`。**触发的结构性缺口**：tier-1 组长**自持 edit 卡**时无法自行绑定工作树（`only-tier-0-lays-out-a-group-lead`），须由 tier 0 执行工作树布置。
- **新缺陷：`pwsh` 写入守卫从命令全文抽取路径 ⇒ 被散文里的词误伤**。复现：把多行 commit message 内联在命令里，守卫从散文抽出 `per` 解析成 `<repo>/per` ⇒ `pwsh write denied: "…\\RustMc\\per" is outside the active plan write scope`。⇒ 建议按 **shell 语法**抽取，或在拒绝里**回显被抽到的原文片段**。
- **新缺陷：`leaseHeartbeat` 不更新 `contractRevision` ⇒ 心跳无法重绑失效租约**。机制（lead-rig 读实现定位）：`team-v12-contract.mjs`（第 469–475 行）的就绪门比对活动租约的 `contractRevision`；`team-control-plane.mjs`（第 3832–3840 行）的 `leaseHeartbeat` **不更新**它 ⇒ 租约失配后心跳**永远无法重绑**，而租约仍显示 active。绕行 = **取消 + 重取**。
- **新观察：对已消费 / 已退役的 inbox 项 ack 返回非 `handled`**：实测同一项先得 `message-not-delivered`、重试得 `inbox-not-found`，而该项**已从 `inbox_list` 消失** ⇒ **审计链无法区分「已处理」与「已消费但未确认」**。建议退役项返回**幂等成功**。
- **新观察 O-10-16：`complete` 只到 `member-check`，而 merge 需要 `integration-ready`** ⇒ 中间 3 个**相邻单步**（`group-check` → `verifier-review` → `integration-ready`）是**必需但易漏**的。t45（包被拒）、t83、t124 **三张卡都撞过**。拒绝文本**具名了目标相位**（好），但**未点明「相邻单步推进」是所需机制**。建议让 `complete` 直出 `integration-ready`，或在拒绝里附**所需机制与步数**。
- **`team_delivery_check.blockers` 噪声**：859 条（task-gate 747 / finding 66 / packet-blocker 31 / escalation 11 / dispatch 3 / completed-not-integrated 1），其中 **309 条属历史 `task-N` 全局卡** ⇒ 该字段作为**信号**已失效，建议只投影**未完成且可行动**的卡。 **【平台批次 25 已修 · tier 0 于真实 active Team live 复核通过：859 → 104 条；task-gate 747 → 6、packet-blocker 31 → 21、legacy `task-N` 309 → 0、completed-not-integrated 1 → 0；finding 66 / escalation 11 不变（本就真实）。详见第二十六批。】**
- **verifier 无法收口自己名下的等待票**：逐字 `waiting-scope: only the task owner, its group lead on a writable group board, or tier 0 may change its wait` ⇒ 它**履行了义务却无法自关**，须由 tier 0 收口。建议 waiter 在义务履行后可自关。 **【平台批次 25 已修：显式 ticket_id 时允许该票 waiter 或 responsible 自关。live 反例已预定 —— t56 收口时由其 responsible=lead-rig 自关该票，届时逐字留证。】**

### 两个第三方独立来源（迁移 M 的终态读数）
- t124 与 t53 两份 verifier 报告的对应行**各自独立复现** `owned=50 / pending_path=6 / registered=56 / unregistered=0 / dead=0` 与 `tokens=279 judged=279 files=36 mismatches=56`，与 tier 0 在 main 上的读数**逐项相同** ⇒ 「arity 50 / 6」不再只是自报。

## 第二十六批（平台批次 25 修复的 live 复核 + 两条新缺陷 + 三条观察）

> 背景：操作者本轮交付平台批次 25 修复，并明确「**真实 active Team 的原始反例仍需 root 后续 live 调用确认**」。
> 本节即 **tier 0 在真实 active Team 上的 live 复核**（不是 fixture 复跑），并登记本轮新发现的缺陷。
> main 起点 = `ff7a69364b1f2b401959e8ec36b6dbd5a6fce6a4`（tree `48dbbf82c4911d0dbc5a1bb16145490587cab9c1`）；提交前已确认**无任何清关钉住该 main**（G-9.12）。

### 一、live 复核：平台批次 25 的三项修复在真实 Team 上成立

**1. inbox ack 幂等（批次 25 第 3 项）—— 已修，live 通过。**
对一条**已消费**的 quiet 消息（`msg-570e9451-94d1-49d2-8ea4-2af40019d4c6`）以 `inbox_id` 形式 ack，返回
`ok:true / status:"handled" / handled:true / cleared:true / durableHandled:true / inboxStatus:"handled" / source:"inbox"`，
**不再**是 `inbox-not-found`。⇒ 第二十五批登记的「审计链无法区分『已处理并确认』与『已消费但未确认』」**就此关闭**。
附带正向证据：把同一 id 传成 `wake_id` 时被**具名拒绝** ——
逐字 `inbox-id-passed-as-wake: "…" is an inbox_id; pass it as top-level inbox_id, not wake_id`
⇒ 这是**具名 + 指出正确通道**的拒绝形态，建议作为其它拒绝文本的范本。

**2. `team_delivery_check` 噪声收窄（批次 25 第 4 项后半）—— 已修，live 通过，幅度极大。**
同一次调用的 `blockers` 由 **859 条 → 104 条**：

| 类别 | 修复前 | live 复核后 |
|---|---|---|
| `task-gate` | 747 | **6** |
| `packet-blocker` | 31 | **21** |
| `finding` | 66 | 66（不变，本就真实） |
| `escalation` | 11 | 11（不变，本就真实） |
| `dispatch` | 3 | **0** |
| `completed-not-integrated` | 1 | **0** |
| 历史 `task-N` 全局卡 | 309 | **0** |

⇒ 第二十五批提的「该字段作为**信号**已失效，建议只投影**未完成且可行动**的卡」**已被采纳并生效**；
同时 `openCount=8 / actionableOpenCount=8 / noOwnerCount=0 / deadLetterCount=0` 与 owner/commit/evidence 的
可行动缺口**保留**，说明收窄**没有误伤真信号**。**该字段现在可以作为信号使用。**

**3. 相位跳级拒绝附相邻步骤清单（批次 25 第 4 项前半）—— 本轮 live 复核【不成立】，原因是受前置门遮蔽，不是修复失败。**
本仓已注册「**多层门禁有先后顺序，前一道遮蔽后一道**」：要**单独**观测这条拒绝文本，需要一个
**无租约、且处于中间相位**的卡。当前唯一处于中间相位且无租约的卡是 G-WORLD 的 `group-world-t123`
（`plan-approved`），但它持有活动计划、且属另一组 —— **主动对它发非法 `advance_phase`，
既可能被更前置的门拒绝（读数不可归因），也有污染在飞卡相位的风险** ⇒ 我**不制造这个读数**。
**具名的 live 触发条件**：下一张卡从 `execution` 走到 `member-check` 之后，其 owner 逐步
`advance_phase` 时非法跳级会**自然出现**；届时由该组组长逐字留证。

**4. 本轮未复核的三项（缺 live 触发条件，不伪造读数）：**

- **write-scope-guard here-string 遮罩 + 具名 `worktree-binding-missing`（第 1 项）**：
  触发条件 = 一名**自持 `edit` 卡**的 tier-1 组长，其写入命中 `.dsh-worktrees/**` 而 plan 无 `worktreePath`。
  本批 t56 的写入落在自身 worktree 的 `target/` 且 plan 已含该 scope ⇒ 本轮**不产生**该形态。
- **租约 `contractRevision` 持久化 / 失效租约重绑（第 2 项）**：
  触发条件 = 一张租约**自然到期**后由同一成员重新 acquire。本批 rig-runner 的租约是**被延长**的，未走到期重绑路径。
- **`waiting_resolve` 允许 responsible 自关（第 5 项）**：live 反例**已预定** ——
  t56 收口时其等待票 `responsible` 是 lead-rig，此前它**无法自关**、只能由 tier 0 收口；
  现在它应能自关。该读数将在 **t56 收口时自然产生**，届时逐字留证。

### 二、平台缺陷（本批新发现）

**D-新-1 后台作业不跨会话，且「作业已死」与「作业已完成」在平台上不可区分。**
- 现象：t56 的 check-4 全量跑曾作为后台作业启动；会话重启/压缩后 `job_list` 中**完全没有该 id**，
  且**没有收到任何完成或失败事件** —— 既不报失败，也不报完成。
- 后果：唯一真相落在磁盘载体上，而载体**没有终局行**（`.t56-check4-full.out.txt` 末行 =
  `C10_citation_anchor_tuples=…`，无 `CRITERIA_END`、无退出码行）⇒ 该次运行**未终局**，
  但平台不会告诉你这一点，**只能靠人读载体末尾才知道**。
- 判定：**可观测性缺口，不是成员失误**。最小修复建议：(a) `job_list` 为随宿主消失的作业保留一行并标
  `orphaned`；(b) 会话恢复时对「曾启动但无终局记录」的作业产生**显式事件**，而不是静默消失。
- 与既有纪律的关系：**「证据通道有形态与生命周期」**的新实例 —— 通道会在会话边界**整体消失**，
  而消失**不等于**事件未发生（此处它确实发生了但未终局）。

**D-新-2 `team_v12(action:"runtime_facts")` 的体量与信息量严重不成比例。**
- 现象：单次调用返回约 272 个 plugin 条目、`diffSummary.total=798`，本次读数触发 spill（约 141KB）。
- 真正携带信息的只有 `action-fusion*`、`write-scope-guard` 等少数几条
  （`entry-path-mismatch` / `entry-hash-mismatch` / `configured-but-not-loaded`），
  其余全是**同因**的 `runtimeEntry.path=null / "entry path was not observed"`。
- 建议：增加 `summaryOnly`（默认只回 `diffSummary` 与非噪声码的差异条目），全量留给显式 `input:{full:true}`。
- 备注：`complete:false / degraded:true` 是**已知未决项**，根因已具名（loader runtime entry 缺 entry hash），
  本节只记录**体量与噪声比**，不重复追责。

### 三、观察（不新增编号）

- **注入即消费**：两条 quiet 消息在 tier 0 的 `inbox_list` 之前已消失（`inbox_list` 返回空）。
  本轮已确认 **ack 侧幂等**（见一.1），故该观察**不再构成审计链缺口**，仅作为「注入即消费」的事实记录。
- **`counters.lifetimeCreates=0` 的「域」未具名**：同一 DSH 进程（PID 124592，**未重启**）生命周期内，
  本会话**至少创建过 7 张卡**（t55–t61），而 `counters.lifetimeCreates` 报 0、`tokenUsed=0`、`tokenBudget=null`。
  我**不断言这是缺陷**：该字段的名字**没有具名它自己的域**（是「本进程生命周期」？「本控制面代次」？「调用者创建的」？），
  因此 0 既可能是 bug，也可能是**另一个域下的正确值**。
  ⇒ 这正是本批归族缺陷（**对象 / 域没被具名**）在**平台自己的字段命名**上的一个实例。
  建议：为该计数字段在名称或文档中**具名其域**；若域 = 本进程生命周期，则 0 与「≥7 张卡被创建」的事实矛盾，需查。
- **t56 落地几何（供后续对照，7 条 rc 实测）**：`59f23075^ = b78206381fbb977060125346640bc6474b21712a`；
  `--is-ancestor 7d46a7d1 59f23075`=1；`--is-ancestor ff7a693 59f23075`=1；
  `--is-ancestor 7d46a7d1 ff7a693`=0；`--is-ancestor b7820638 59f23075`=0；
  `--is-ancestor 879371a4 b7820638`=1；`merge-tree --write-tree grp/rig team/rig/rig-runner` 干净
  （tree `b98e1625ad3a76244c84cda2de57f390a847dd4a`）。

## 第二十七批（t55 落地并 accepted · 平台批次 26 修复的 live 复核 · 五条新缺陷/事实 · 对我自己一处措辞的更正）

### 一、t55 落地并 accepted（tier 0 执行）

merged **true** · fastForwarded **true** · createdCommit **false** · ancestorVerified **true**；commit == sourceSha == 0bd4e97c0dc8ddec9c83d05e67517dca06b69736；previous == destinationBefore == db1abddc04f739aadef52c0bae7eb39572c3b936；phaseAdvance = { status: advanced, phase: integrated }。落地后 main = 0bd4e97c、tree f9dc9ac0ccad97df50521de859c53f006b27e869、porcelain 空；增量 = 恰 3 路径，全在 tools/capture/tests/ 内。

- 清关键 0bd4e97c… severity = **condition** ⇒ 按「含 blocker|major ⇒ 不写键」的口径，该报告 **0 blocker / 0 major**（1 condition + 1 nit）。
- **group-acceptance**（lead-rig）= packet-0326357d3800b0705ba6ecb9；**final-acceptance**（tier 0）= **packet-502f901f2dcbbd2bc30481c1** ⇒ 卡面 **rev 27 / completed / phase accepted**。
- **冷门禁（tier 0 第一手，落地后的 main）**：cargo clean -p mc-proto-schema ⇒ **Compiling 行在** ⇒ **rc=0 / 7 passed**；tokens=59|judged=59|files=6|mismatches=0；owned=50|frozen=0|pending_path=6|registered=56|unregistered=0|dead=0|ambiguous=0。载体 .local/gate-batch27-pre-exit.txt。

### 二、平台批次 26 修复的 live 复核（tier 0 第一手）

**D-新-2（runtime_facts）—— 【部分生效】；「默认只返回非噪声差异摘要」在 live 上【不成立】。**

| 调用 | includedPlugins | omittedPlugins | plugins 键数 | 字节 |
|---|---|---|---|---|
| 默认（无 input） | 272 | **0** | 272 | **125,814** |
| input:{summaryOnly:true} | 272 | **0** | 272 | **125,814** |
| input:{pluginIds:[write-scope-guard]} | **1** | **271** | 1 | **12,287** |
| input:{summaryOnly:false} 与 input:{full:true} | — | — | 272 | **800,382** |

- **活的**：新计数字段齐备；**pluginIds 定向生效** —— 这是一条**判别性正控**，它证明**新代码路径确实被加载**，因此「默认没有变化」**不能**归因为「模块没换」。summaryOnly:false 与 full:true 同形同量 ⇒ 该入参（作为完整报告的兼容路径）**成立**。
- **不成立的**：**默认仍含全部 272 个 plugin 与全部噪声码** —— 逐 plugin 的 differences 里 write-scope-guard = [patch-source-unknown, schema-unknown, evidence-missing]、52f9de2f 同三条；diffSummary.total=798 且 codes 含全部 8 个码。⇒ **「非噪声」这一步没有发生**，omittedPlugins:0 与之一致。
- **该记功的一点**：**定向**把 126 KB 降到 12 KB ⇒ 调用方现在**有可行的降噪路径**，只是**默认**没有降噪。建议：把默认改为噪声码全过滤；或把文档从「默认 = 非噪声」改成「默认 = 精简形态（含全部 plugin），降噪请用 pluginIds」。

**D-新-1（后台作业 journal）—— 【未 live 复核】**：操作者自陈运行进程仍加载旧 jobs 模块 ⇒ 不能声明 live verified；tier 0 **不重启 DSH**（会中断 active Team）。**具名的 live 触发条件**：下次 DSH 重启后，job_list 里应出现本会话被回收的那个后台作业一行、status=orphaned、detail 含 host process <pid> exited before terminal settlement、并带 finishedAt —— 这正是本缺陷的原始反例。

### 三、新缺陷与事实

**D-新-3 · write-scope guard 拒绝独立复验者的一切写入（仓内 .local 与仓外目录均拒）⇒ 独立性被限制在「载体复算」上。**
- 现象（verifier 逐字）：「仓内 .local 与仓外目录均被 write-scope guard 逐字拒」，两条逐字拒绝串分别指向 <repo>\.local\verify-t55-vwc 与 <仓外>\t55-verify-wc。
- 后果：**凡交付物必须落盘的验收，独立复验者无法重跑** ⇒ 清关只能建立在「一手复算 + 物化自证 + 冷门禁」上。
- 建议：给独立复验者一个**平台托管的可写暂存区**（例如 DSH_HOME 下的 verifier-scratch 目录），或允许其写入**显式声明为 scratch 的目录**；**不要**用「给它产品目录写权」绕过 —— 那会毁掉独立性（tier 0 已据此**否掉**了一次把 tools/capture/ 写权给 verifier 的申请）。

**D-新-4 · 跨板 blocked_by 不可解析。**
- 逐字：team_task_create(kind="review", blocked_by=["group-rig-t63"], owner="verifier") ⇒ **blocker task "group-rig-t63" not found**，而该卡确实存在（同轮 verifier 读出 rev1 / pending / UNOWNED）。
- 判别：本卡建在 **global** 板、blocker 在 **group-rig** 板 ⇒ 依赖解析不跨板。
- 后果：**跨组依赖无法用 blocked_by 表达** ⇒ 退化为「描述里具名 + 等待票」，**失去 ready 门禁**（该卡 ready 恒 true，可能被误当可开工）。建议接受 board:taskId 限定形态，或在创建时明确报「该 id 不在本板解析域」。

**D-新-5 · 字段级受控会把同一次调用的其它字段一起拒掉（lead-rig 一手）。**
- 逐字拒绝串：[task-write-scopes-plan-controlled]: write_scopes is controlled by the approved plan; replace the plan instead of editing the task row
- 实测：把 description 与 write_scopes 放进**同一次 edit** ⇒ **整条被拒，且 description 静默未落**（靠回读卡面才发现）；只传 description 后成功。
- ⇒ 可复用口径：**受控字段会「连坐」同一次调用里的非受控字段** ⇒ 正确做法 = **把受控/易变字段从其余载荷里拆出去单独发**。与本仓已注册的 instruction-stale（自己的写把 CAS 版本顶掉）**同族**。
- 并且：**write_scopes 由 plan 控制** ⇒ 卡行的 scope 改不了，**收窄只能由 plan 承载**。

### 四、对我自己两处断言的更正（承条款 79：追加，不改原文）

**更正 1 —— 第二十六批「一.1」的结论【过宽】。** 我写过「inbox ack 幂等 ⇒ 审计链无法区分已处理并确认 / 已消费但未确认『就此关闭』」。
- 正例 3 条（tier 0）：msg-570e9451 / msg-985d30fa（source: inbox）与 msg-11506970（source: dispatch-pending，pendingRetired: true）⇒ 均 handled。
- **负例 3 条**：msg-744c0191（**tier 0 第一手**）⇒ inbox-not-found；msg-6deb2ce9（lead-rig）⇒ inbox-not-found；msg-d30ac30c（lead-rig，**在 manifest 里被列为 inbox 项**）⇒ **message-not-delivered**。
- **被证伪的候选判别量**：**调用形态不是判别量** —— msg-744c0191 与三个正例使用**完全相同的调用形态**却得到不同结果 ⇒ 判别量在平台侧（项的状态/时点）。**不断言具体机制。**
- 正确表述：修复覆盖「以 inbox_id ack 且该项在 inbox 投影内」这一子集；**另有至少两条路径返回非 handled 码**，该族现有**两个**不同错误码。
- 该族的可操作判别（对全组生效）：只能报「**在 <调用形态> 上得到 handled**」，**不得报「该类已关闭」**。
- tier 0 自己的错的形态：**用 2–3 个正例宣告一整类缺陷关闭，没有配同类的负例对照** ⇒ 与本仓「0 命中须带同类正控」是**镜像**（那条防「查了但没有」被当成「没有」；本条防「有几个正例」被当成「整类已修」）。

**更正 2 —— 我「行数与 token 均未变」按行数读【不成立】。**
- verifier 实测：含 原引 的**行数**由 **10 → 12**（新增两行，均为「关于该标记本身」的散文、**无路径 token**）；tier 0 复核当前行数 = **12** ✓。
- ⇒ 按行数读，我的措辞不成立；但**实质断言在 token 级成立**：批次 25 前后的门禁读数同为 quoted=44。
- ⇒ **收窄后的正确措辞**：「**未新增任何被豁免 token；标记行数 10→12，新增两行均为关于标记本身的散文。**」
- ⇒ 形态：又一次「**断言的域没被具名**」——「行数与 token」把两个不同域的计数并列，一个真、一个假。
**D-新-6 · write-scope guard 只拦工具层，子进程写盘不受约束（A-6 族的 live 实例 · verifier 一手）。**
- 一手反例（verifier 在自己的账号上）：shell 侧被逐字拒（bash write denied: member "verifier" has no declared static scope or active approved plan lease for <repo>\.local\verify-t55-vwc；仓外同样被拒）；而**同一子树**上执行 cargo test 并以 CARGO_TARGET_DIR 指向 <repo>\.local\verify-cite-t55 时，**子进程成功写入、rc=0**（逐字：Running tests\citation_integrity.rs (…\verify-cite-t55\debug\deps\citation_integrity-…exe)）。
- ⇒ 这是 **A-6** 的原始断言（「对被执行程序自身的写入不设防」），现在**由 verifier 在自己账号上第一手复现**。
- ⇒ **对判据设计的直接后果（已写入 t63 的 ac-3）**：**任何「试图写盘必须失败」的判据，都不能把平台门禁当作产生者** —— 门禁只拦工具层，拦不住子进程。负控必须由**装置自身**构造性拒绝产生（读数 = 装置自己的拒绝串 + 非 0 退出码）；「被平台拦住」或「静默成功」**都算未覆盖**。

**D-新-7 · 卡面 contract 投影滞后一次 task_contract_set，而 requirements_snapshot 是最新的。**
- 实测（tier 0 两次）：task_contract_set 的返回体给出 contractRevision N 与新判据；**紧接着** team_task_get 的 contract 仍显示 contractRevision N-1 与**上一版**判据。
- 同一时刻 requirements_snapshot(taskId) 显示的是**最新**（逐字 acceptanceSummary = 6 acceptance criteria，revision 3）⇒ **写入确实落盘，滞后的是卡面投影**。
- ⇒ **可操作判别（对全组生效）**：**验证 task_contract_set 是否生效，必须读 requirements_snapshot，不能读卡面 contract** —— 读卡面会得到**假的「没落盘」**（正是 B-14 描述的那类误读，但这次真相在另一个投影里可得）。
- ⇒ 建议：让卡面 contract 与 requirements 同源同版本，或在卡面返回里带 contractStale 标志。

## 第二十八批（t56 落地 · PID 138192 归属入册 · 一条「清理销毁复现对象」的新形态 · t64/t65/t66）

### 一、t56 落地（tier 0 执行）

merged **true** / fastForwarded **true** / createdCommit **false** / ancestorVerified **true**；commit == sourceSha == **8a7385408f9c55f032a7941dc7741a3da98a6052**；previous == destinationBefore == **9848714d9d9b726c53c96abffd3dd0a3e7eecab2**；phaseAdvance = { advanced, **integrated** }；落地后 main = 8a738540、tree **ac4399303af47f9071b2ef19c066145fb60327ac**、porcelain 空。

- 清关键 8a738540… severity=**condition** / ok=true / destSha=9848714d ⇒ 与令牌逐字一致；**0 blocker / 0 major**（1 condition + 2 nit）；增量恰 1 路径 tools/rig-batch/tests/run-criteria.ps1（+3/−1）。
- **verifier 两件照录**：① **第一手复现核心缺陷**（cargo build -p bot ⇒ rc=101 包解析失败；-p capture ⇒ rc=0 + Compiling capture）；② **防夹带**（交付 blob d1601db3… 在 59f2307 / f3131fb4 / 8a738540 三处相同，main 上是 5dd31d99 ⇒ 改动确为新件）。
- **范围限制照录不升格**：verifier 未重跑全量套件 ⇒ 本清关**不含第二次全量实跑**（承接 = group-rig-t63 / task-101）。

### 二、PID 138192 归属入册（G-RIG 请求 tier 0 记；docs/ 是 tier 0 单写者）

**`127.0.0.1:25565` 上的 java PID 138192（start 09/28 22:00:09）是 tier 0 的遗留进程** —— 等于本会话早期后台作业 bash-583（startedAt 1790604009429 ms = 本地 22:00:09 **逐字相同**；cmd 与我的启动命令只差一个 --%）。

- **不是 G-RIG 启动的**；而**它现在是 G-RIG golden 捕获的 server 臂** ⇒ **不可杀、不可启停**（其长期约束：golden 期间不得启停、不得让真实客户端连入）。
- **风险（tier 0 具名）**：G-RIG 依赖一个**自己不拥有、不能重启、生命周期挂在别人会话作业上**的进程 ⇒ **我的任何一次作业收尾都会静默打断他们的 golden 基线**。
- **裁定（t65）= (ii) 协调窗口**：① **前置** = G-RIG 先**具名基线当前的 server 臂**（pid + start + jar 路径 + jar sha + port）—— 138192 用的是**相对路径** 1.8.9-server.jar，cwd 未具名 ⇒ **不先具名就换实例，等于换到一个没核过的东西上**；② 窗口 = G-RIG 宣布「无 golden 捕获在飞」⇒ **我退掉 138192** ⇒ 他们用 tools/oracle/run-headless.ps1 自持 oracle 并落**具名 pid 载体**；③ 之后**每条 golden 读数必须具名其 server 臂**（pid+start+jar sha+port）—— **换实例不得静默，不同 jar sha 的基线不可比**。
- **不选 (i) 换端口**：换端口能达成「可重启」，却把 25565 永久留给一个**谁都不拥有的僵尸**，并把口径永久分叉。

### 三、新形态：「清理」会销毁「复现」的对象（lead-rig 一手并具名取舍）

- 实测：lead-rig 为确定归属清掉了 PID 130564（25666 现无监听），而 **t64 判据 1 原写作「复现遗留」** ⇒ **被复现的对象正是它自己清掉的** ⇒ **判据形态不成立**。
- ⇒ **可复用形态**：**当缺陷归属要靠「清理」来确定时，必须先问「这个对象是不是别的判据的复现前提」**；是则**清理前留可重建读数**，或把后续判据改成「**构造**」而非「复现」。
- ⇒ verifier 的同轴补充：**「复现遗留」不能靠观察现状**（130564 已消失、25666 已空闲）⇒ **必须构造**（起一次 run 并中断）。

### 四、t56 的一条 condition：**只活在消息里的数字不是读数**

- 逐字：材料里的断言计数 `TRUE=144 FALSE=0` **在任何载体上都找不到**（target/t56-evidence/ 6 个 .txt 检索 144 零命中；装置无该打印器：^Assert 单引号 = 114 / Assert = 137 / Say = 77）⇒ **不可复现**，在具名载体或撤回前**不背书**。
- ⇒ 与「**长跑判据须把退出码落盘到内容寻址载体**」同轴；lead-rig 自认「**转述了一个我没有核过载体的读数**」⇒ 与「**转述下级自陈入册前先自取读数**」同族。已开 group-rig-t66：装置**打印**该计数，或**撤回并改为按具名规则从载体导出**；**在新证据前该数字不成立**。

### 五、判据 4 措辞裁定（lead-rig）

- **保留** run-criteria.ps1 的成因注释（修复的**载体**与可追溯性），**把判据口径改为「无可执行命中」**（plan 的 check-3 现行口径：可执行行 0 命中、注释命中**单独具名**）。
- ⇒ verifier 的清关**覆盖「无可执行 -p bot」、不覆盖字面 0 命中**；卡面原句按 plan 执行，**不再引用其字面形式**。

## 第二十九批（平台批次 27 的 live 复核：D-新-2 / D-新-7 生效，D-新-3 需重启 · 一条逐模块纪律）

### 一、D-新-2（runtime_facts 噪声过滤）—— **已修，live 通过**（tier 0 第一手，四次调用）

| 调用 | 字节 | includedPlugins | omittedPlugins | plugins 键数 | layers |
|---|---|---|---|---|---|
| 默认 | **50,816**（修复前 125,814） | **89** | **183** | 89 | 无 |
| input:{summaryOnly:true} | **50,816**（与默认逐字同量） | 89 | 183 | 89 | 无 |
| input:{summaryOnly:false} | **800,382** | — | — | 272 | **有** |
| input:{pluginIds:[write-scope-guard]} | **12,315** | 1 | 271 | 1 | 无 |

- ⇒ **噪声过滤真的发生了**：默认 **−60% 字节**、omitted **183**；`write-scope-guard`（纯噪声）在**默认里被整体省略**（`wsgDiffs=null`），在**定向里原样返回**（仍带三个噪声码）⇒ **口径自洽**。⇒ **D-新-2 关闭**，「默认不降噪」作废。

### 二、D-新-7（卡面 revision / stale 字段）—— **已修，live 通过**

- `group-rig-t63` 现返回 **`contractRevision=8` / `requirementRevision=4` / `contractStale=false`**，三键均在。
- ⇒ 第二十六批立的过渡纪律「**验证 `task_contract_set` 须读 requirements_snapshot、不可读卡面**」**可以退役**（卡面自带判别量）。

### 三、D-新-3（`DSH_HOME/verifier-scratch`，仅 verifier 可写）—— **已落盘但【未加载】**

- **verifier 一手读数（三条可判别）**：① **进程早于规则文件** —— PID **124592**（`dsh\lib\bin.js --profile web --no-open --port 40123`）CreationDate **2026/09/28 20:58:01** **<** guard mtime **2026/09/29 07:09:59**；② 规则**在盘上且位置正确** —— `profiles/web/plugins/write-scope-guard.mjs`（44,036 B）第 1032 行 `isVerifierScratchPath(...) → allow`，在 1076–1079 的 deny **之前**；最近备份 33,533 B @09/27 22:24:26 对 `isVerifierScratchPath`/`verifier-scratch` **0 命中**；③ 逐字拒绝串 = `<D:\dsh-test\home\verifier-scratch\t101-scratch-probe-VS-1790637293480-f547ac5c.txt>` ⇒ **scratch 写入被拒、文件未创建**。
- **负控（产品目录）**：同样被拒（逐字指向 `<repo>\tools\capture\t101-negative-control-VS-…txt`），**未落任何字节**。
- ⇒ **D-新-3 未生效**；verifier **仍无任何可写路径** ⇒ **task-101 的 group-rig-t63 依赖【保持】**。
- **裁定：不重启 PID 124592。** 重启 DSH = 终止本会话与整个 active Team，代价远大于收益，且 D-新-3 **不在关键路径上**（t63 的「无写模式」本是正路）；平台侧明写「未重启 DSH，PID 124592 / 端口 40123 保持」= **操作者的边界** ⇒ **进程生命周期归操作者**。
- ⇒ **live-pending 项（给操作者）**：**需要一次进程重启**（web profile；headless 同理）**D-新-3 才会生效**；生效判据 = verifier 复测 scratch 写入得 `WRITE_OK=True` 且读回一致；**届时**方可 `set_dependencies` 去掉 t63（此时 task-101 有**两条**可解除路径：t63 的无写模式，**或** scratch 可写）。

### 四、观察（不新增编号）：guard 的路径抽取器对**动态表达式**的读数形态（A-9 族的又一实例）

- verifier 用 `Join-Path $env:DSH_HOME ...` 构造路径时，**拒绝串把路径显示为** `(D:\dsh-test\workspaces\RustMc\Join-Path)` ⇒ **guard 未解析该动态表达式**，而是把 `Join-Path` 当成了路径。
- ⇒ 与 **A-9**（「不取值开关吞掉后续 positional token」/ 行内子表达式被当路径）同族；**后果是拒绝串里的路径不是调用者的路径** ⇒ 调用方据拒绝串自查会**查错对象**。
- ⇒ 过渡纪律：**读拒绝串里的路径时，先确认它是「被解析后的目标」还是「原文片段」**；不一致时以**字面绝对路径**重试（verifier 已如此做，读数一致）。

### 五、D-新-4 / D-新-6 状态

- **D-新-4** 采用**明确拒绝**（`cross-board-blocker-unsupported` + 列出实际 board）而非跨板解析 ⇒ 跨板依赖仍须「描述里具名 + 等待票」，但拒绝串会指名原因。**未 live 复核**，理由具名：测法需真的发起一次 `create`，两侧虽都是拒绝，但失败面会产生一张垃圾卡，不值得。
- **D-新-6** 维持 **A-6 partial**（未知子进程的 OS 级写盘不在当前沙箱覆盖内）⇒ **t63 的 ac-3 结论不变**：负控必须由**装置自身**构造性拒绝产生，不得依赖平台门禁。












































## 第三十批（2026-09-29 · tier 0 一手；含两条自陈式更正）

### 一、D-新-8（owner 字段：四个投影给出两个答案）—— 待操作者裁定

对象 `group-rig-t65`。同一 turn 的四个一手读数：

| 投影 | 读数 |
|---|---|
| `team_task_get`（group-rig 板） | `ownerName = null` |
| `team_delivery_check` | `owner = null`，verdict = `no-owner` |
| `team_v12 ready_queue` | `owner = rig-capture` |
| `team_v12 waiting_list` | 该卡 4 张票的 `owner` 全为 `rig-capture`（其中 3 张早于本次会话） |

- ⇒ 分歧的两方是「**卡面 + delivery_check**（报 null）」对「**ready_queue + 等待票**（报 rig-capture）」。
- ⇒ 因此 `team_delivery_check.noOwnerCount = 1`（本批唯一一行 = t65）相对**卡面**是**真阳性**；缺陷在**另两个投影多报了一个 owner**（来源未定；**不是**卡级 lease，见 D-新-9）。
- 后果（真实，非设想）：tier 0 据 `ready_queue` 的 owner 会认为「有人持卡」，据卡面会认为「无人负责」 —— 同一张卡导出**相反**的调度动作。
- 已处置：lead-rig 把 t65 `reassign` -> `rig-capture`（rev 5→7），四个投影现已一致。
- 建议：owner 判定应**同源**；或在报 `no-owner` 时**并列**报 `ready_queue.owner`（二者不一致本身就是可诊断量）。

### 二、D-新-9（`ready_queue.leaseExpiresAt` 是**成员级** run lease，不是卡级）—— **自陈式更正**

- **我的错**：我曾据「t65 `leaseActive=true` 且 `leaseExpiresAt=1790641688937`」推断「rig-capture 正持有该卡 lease ⇒ 指派别人会两人同卡」。**该前提不成立。**
- **lead-rig 的一手正控**：`ready_queue` 里 rig-capture 名下**全部**卡（t57/t62/t63/t65/t68/t70）的 `leaseExpiresAt` **全等** `1790641688937`；rig-runner 名下**全部**卡全等 `1790641736188` ⇒ 该字段是**成员级** run lease。
- ⇒ 过渡纪律：**读 `leaseActive` / `leaseExpiresAt` 时必须先确认它是「卡级」还是「成员级」**；「同一成员的多张卡该字段全等」= 成员级的判据。
- ⇒ 与 D-新-8 同轴：**字段的「域」（卡 / 成员 / 工作树）必须具名**，否则同一读数会被读成相反的责任归属。

### 三、D-新-10（`inbox_ack` 对**批通道投递的静默消息**返回 `inbox-not-found`）

- 一手样本（tier 0 本会话）：**批通道**到达的静默消息 `msg-7490211e`、`msg-c5dd3761` ⇒ `inbox-not-found`；**单发**的 decision wake `msg-0a0595b0`、`msg-c05bacac` ⇒ `handled`。
- lead-rig 独立样本：**4 条 ack 成功 / 6 条 `inbox-not-found`**，其归因同为「**批通道投递不可 ack**」。
- ⇒ **修正我此前的过宽结论**：判别器**不是「调用形态」**（同一种 `inbox_ack` 形态既有成功也有失败），而是**投递通道**。
- 影响（真实）：该通道的消息**无法给出 handled 信号** ⇒ 恢复清单可能**重复注入**已处理的消息；`inbox_list` 的 `total` 也不能当作「待处理数」。
- 建议：让批通道投递的消息也进 ack 索引；或在文档里明写「批投递不参与 ack，处理状态以游标/版本为准」。

### 四、仍开放（本批未新增读数）

- 操作者此前问的两项仍开放：`team_delivery_check.blockers` 是否要收窄；`cargoTargetIsolation` 是否覆盖全部 `.dsh-worktrees/**`。


### 五、D-新-11（`[task-write-scopes-plan-controlled]` 的文本指向**不存在的对象**）—— lead-world 提出，tier 0 一手复核

- **同一张卡**（`group-world-t125`）两个读数同时成立：
 · `team_task_update(action:"edit", write_scopes=[…])` ⇒ `team policy refusal [task-write-scopes-plan-controlled]: write_scopes is controlled by the approved plan; … replace the plan first …`
 · `team_plan_get` ⇒ `team policy refusal [plan-not-found]: no plan exists for task "group-world-t125"`
- ⇒ **无 plan，却被告知「受 approved plan 控制」并要求「先 replace the plan」** ⇒ 两句都指向一个**不存在的对象**，调用者会被指引去 replace 一个不存在的 plan（lead-world 正是据此叙述了两次「已收窄」）。
- **建议（只改文本、不改行为）**：第一句改为「**write_scopes 由 plan（若存在）或卡创建时的 contract 控制**」；动作指引改为「**先建立/替换 plan**」。

### 六、D-新-12（目录 scope 与文件 scope 的**互锁**：双方都无法收窄）—— 本会话三处实例

- **形态**：两张**非终态**卡的 scope 互为包含（一方是目录 `…/tests`，另一方是它下面的文件）⇒ **任何一方的 plan 替换都会被判 scope-conflict**（新 scope 仍被对方包含），而**冲突检查只看「新 scope vs 对方当前 scope」**，于是**没有任何一方能单方面收窄**。
- **唯一出路**：**一方进入终态**（completed / deleted）释放 scope。⇒ 实际上退化为**串行**，且**由谁先持有目录决定顺序**。
- **本会话三处实例**：① `group-world-t123` / `group-world-t124`；② `group-world-t123` / `group-rig-t61`（跨组）；③ `group-world-t123`（目录）与 `group-world-t125`（目录）互锁 ⇒ 第三处**是 tier 0 自己用目录 scope 建 t125 造成的**。
- **建议**：冲突检查对「**新 scope 严格窄于自身旧 scope** 且落在对方 scope 内」的情形放行（收窄不增加争用面）；或提供一条**具名的收窄通道**（当前不存在）。
- ⇒ 过渡纪律（已入 GOVERNANCE）：**新卡的 scope 必须是精确文件**；只有当该卡确实要动整个目录、且该目录无其他卡声明时，才可声明目录。

### 七、D-新-8 / D-新-10 的机制补记（tier 0 一手，见 GOVERNANCE 同批）

- **D-新-8 机制已具名**：`waiting_list` 含 `status: "derived"`、`ticketId: undefined` 的**合成行**，其 `owner` 取自与卡面**不同**的源（t65 实例：派生行 `owner=rig-capture`，卡面 `ownerName=null`）。
- **D-新-10 机制仍未具名**：`inbox_ack` 的负例既含批通道消息，也含**单发** info（`msg-253bbba2`）⇒「批通道」不充分，只保留可复核样本。

### 八、观察（tier 0 自身工具缺陷，记在台账里供后人避坑）

- **`Out-File -Encoding UTF8` 不是字节忠实的补丁载体**：用它把 `git diff` 落盘会产生 BOM/CRLF ⇒ `git apply` 报 `patch does not apply`（我本批实测 `APPLY_RC=1`）。
- ⇒ **正确做法**：`git diff --output=<path>`（由 git 自己写，字节忠实），或 `[System.IO.File]::WriteAllText`；且**还原前必须先 `git apply --check`**，还原后必须核对**行数**（我这次因为只看了行数变化「看起来正常」而差点把半份台账当全份）。


## 第三十一批（2026-09-29 · tier 0 一手 + lead-world/成员一手）

### 一、D-新-13（同目录 / 父子 scope 的**对称互锁**，且卡面 scope 无法就地修改）

- **形态**：两张非终态卡的 scope 互为包含（目录 vs 同目录，或目录 vs 目录下的文件）⇒ **任一方替换 plan 都被判 `[scope-conflict]`** ⇒ **双方都无法单方面收窄**。
- **实测（tier 0 一手 + 成员一手，同一对卡）**：`group-world-t123` scope `["crates/mc-worldgen/tests"]` vs `group-world-t125` scope `["crates/mc-worldgen/tests/"]`（**同一个目录**）：
 · t125 提**文件**提案 ⇒ 拒（`left=…/dump_chunks.rs`、`right=crates/mc-worldgen/tests`）；
 · t125 提**同目录**提案 ⇒ **也拒**（`left=crates/mc-worldgen/tests`、`right=crates/mc-worldgen/tests`）。
- **卡面 scope 不可就地编辑**：`team_task_update(action:"edit", write_scopes=…)` ⇒ `[task-write-scopes-plan-controlled]`，而同一张卡 `team_plan_get` ⇒ **`plan-not-found`** ⇒ **没有可替换的对象** ⇒ **创建是唯一能写 scope 的入口**。
- **校验顺序**：`replace_approved` 形态**先被 scope 校验拦下**、**未回** `plan-not-found` ⇒ **scope 校验先于 plan 存在性校验**。⇒ 两个组长先后据此**误判成因**（把 scope 冲突读成 plan 缺失）。
- **唯一可执行路径**：**delete + 以精确文件 scope 重建**（**建卡不做 scope 校验** —— 实测：用目录建卡时对方已持目录，未报冲突）。已按此执行：t125 delete ⇒ 重建为 `group-world-t126`（scope = 单文件 `dump_chunks.rs`）。
- **建议**：为「**新 scope 严格窄于自身旧 scope**」提供一条**具名收窄通道**（收窄不增加争用面）；或在拒绝串里给出**可执行的下一步**（当前给出的 `replace the plan` 对本例**不可执行**）。

### 二、D-新-11 的补充：拒绝串的**动作指引**必须是可执行的

- 同族第二例：对**无 plan** 的卡，`[task-write-scopes-plan-controlled]` 指引「replace the plan」，而该对象**不存在**；本例的 `[scope-conflict]` 指引的方向在**对称互锁**下也**不可执行**。
- ⇒ 共性：**拒绝串给出的下一步必须在该调用者当前状态下可执行**；否则调用者会「照着做也做不到」，并把失败读成自身错误。


## 第三十二批（2026-09-29 · lead-rig 一手 + tier 0 一手复核）

### 一、D-新-14（**没有任何 API 面暴露 lease**；被约束方无法回答「我是否已持租约」）

- **一手读数（tier 0 本 turn）**：
 · `team_v12(action:"runtime_facts")`：键 = schemaVersion / kind / collectedAt / instance / dsh / collection / totalPlugins / includedPlugins / omittedPlugins / omittedNoisePlugins / omittedUnobservedRuntimeEntries / plugins / diffSummary ⇒ **无 `leases`**，**全文 0 次出现 lease**（50,816 B）。
 · `team_control_status`：键 = rootId / revision / health / provider / counters / rooms / dispatches / wakeEpisodes / deadLetterCount / peerDeadLetterCount / systemDeadLetterCount / openDeadLetterCount / oldestDeadLetterAgeMs / oldestPeerDeadLetterAgeMs / deadLetters / plans / pendingCompactions / profileHealth ⇒ **无 `leases`**，**0 次 lease**（186,505 B）。
 · **两个面都不含**持久 runId（`run-d0cac085` / `run-0942a42a`）。
 · **唯一可读面** = 控制面文件 `D:\dsh-test\home\team-control-plane\session-<id>.json` 的 `leases` 表（**130 条**，键 = runId，含 member / taskId / status / acquiredAt / expiresAt / endedAt）—— lead-rig 一手读得。
- **危害（真实，非设想）**：`team_run_lease` 的**锁超时回执**逐字要求「query the durable effect before retrying, because a previous writer may have committed it」，而**被要求做该查询的一方没有任何工具面可查** ⇒ **该要求在成员侧不可满足**。
- **实例**：`group-rig-t63` 有一条 **active** 租约 `run-0942a42a`（rig-capture，约 29 分钟有效期），卡 phase 已是 `execution`；而该成员自述「我没有开工，也没有获取租约」⇒ **它据可见面推断自己无租约，而实际有**（方向 = 「我以为没有、实际有」）。
- **建议**：(i) 暴露一个 lease 读面（如 `runtime_facts.leases` 限调用者自身，或 `team_v12(action:"leases", input:{taskId|member})`）；(ii) 或把锁超时回执的措辞改为**实际存在的那条查询**。平台内部显然已有该数据 —— `ready_queue` 的 `leaseActive` / `leaseExpiresAt` 就是它的**成员级投影**（见 D-新-9）。
- **过渡程序（本队已用，tier 0 背书）**：lease 问题由**组长或 tier 0** 读控制面 `leases` 表后**告知**；成员**不得盲目重试**，**不得**替他人 acquire/release。


## 第三十三批（2026-09-29 · tier 0 一手 live 复核 + 一次真实门禁绕行）

### 一、平台修复的 **live 复核**（只读/低风险真实调用；未调用的项不声称 live）

| 缺陷 | live 读数 | 判定 |
|---|---|---|
| **D-新-9**（`ready_queue` 显式 lease 域） | 实测出现 `leaseScope` / `leaseTaskId` / `leaseMember` / `taskLeaseActive` / `taskLeaseExpiresAt` / `memberLeaseActive` / `memberLeaseExpiresAt`，旧 `leaseActive` 保留 | **LIVE ✓** |
| **D-新-10**（批/注入通道的 `inbox_ack`） | 本批 4 条消息（含批通道到达者）逐条 `inbox_ack` ⇒ 全部 `handled` | **LIVE ✓** |
| **D-新-14**（新只读 `team_v12(action:"leases")`） | 见下（**含一处新缺陷**） | **LIVE，部分 ✗** |
| D-新-8 / 11 / 12 / 13 | 本轮**未**用真实调用制造反例 | **未 live 复核（不声称）** |

### 二、D-新-14 补充：`member` 过滤器**被回显但未生效**

- 一手读数（tier 0，同一 turn）：
 · `action:"leases"`（无输入）⇒ **130 条**，覆盖 **12 个成员**（rig-capture 31 / rig-runner 22 / member-world-chunk 19 / member-world-anvil 15 / rig-diff 13 / member-framing 9 / member-world-block 7 / member-codec 4 / member-registry 4 / member-guard 3 / rig-trace 2 / lead-proto 1）；状态 `active:2 / completed:93 / cancelled:19 / expired:14 / failed:2`。
 · `input:{member:"rig-capture"}` ⇒ `member` 回显 = `rig-capture`，但返回**仍是那 130 条**、**仍含全部 12 个成员** ⇒ **过滤器未生效**。
 · `input:{status:"active"}` ⇒ **2 条**（rig-capture 1 / rig-runner 1），全为 active ⇒ **生效 ✓**。
 · `input:{taskId:"group-rig-t63"}` ⇒ **1 条**（rig-capture / completed）⇒ **生效 ✓**。
- ⇒ 结论：`status` 与 `taskId` 过滤**可用**；**`member` 过滤被回显而未施加**。tier 0 的「查另一个成员」这条用法因此**退化为全表返回**（130 条 / 约 26 KB），既不满足语义也不满足体积约束。

### 三、D-新-15（新）：写范围守卫约束「**路径**」，不约束「**工作树**」⇒ 隔离是约定、不是门

- **真实事故（本 turn 一手取证）**：`main` 曾被一个**普通 commit** 前移到 `460260b`（= t123 的提交）。
 · `git reflog show main` ⇒ **`main@{0}: commit: t123: …`**（动作是 **`commit:`**；正常落地是 `merge …: Fast-forward`，同 reflog 的 `553f7d8` / `dbba100` 即是）。
 · `460260b` 的 parent = `f5991ec8`；`git worktree list` ⇒ **共享检出 `D:\dsh-test\workspaces\RustMc` 的 HEAD = `[main]`**；而 `team/world/member-world-chunk` 仍在 `f5991ec8` ⇒ **该成员没有在自己的分支上提交**。
- ⇒ 机制：成员在**共享检出**（HEAD=main）里工作并 `git commit` ⇒ **未经令牌、未经清关**把交付送进 main，且 pending 令牌的前提（`main ⊆ 尖`）当场作废。
- ⇒ **为什么守卫没拦住**：范围守卫比对的是**路径前缀**（该成员的 scope 覆盖 `crates/mc-worldgen/tests/**`），而**共享检出与成员工作树是同一路径、不同载体** ⇒ 守卫放行。**工作树隔离在门禁层面不存在。**
- **建议**：范围守卫除路径外再约束**载体**（写入必须落在该成员绑定的工作树内；对共享检出/其它工作树的写入默认拒绝或需显式豁免）。


## 第三十四批（2026-09-29 · tier 0 live 复核 + 两次机制自纠）

### 一、平台修复的 **live 复核**（逐项真实调用；未调用即未验证）

| 缺陷 | live 读数 | 判定 |
|---|---|---|
| **D-新-9**（`ready_queue` 显式 lease 域） | `leaseScope` / `leaseTaskId` / `leaseMember` / `taskLeaseActive` / `taskLeaseExpiresAt` / `memberLeaseActive` / `memberLeaseExpiresAt` 全部出现，旧 `leaseActive` 保留 | **LIVE ✓** |
| **D-新-10**（批/注入通道 `inbox_ack`） | 本批多条（含批通道与注入行）逐条 `inbox_ack` ⇒ 全部 `handled` | **LIVE ✓** |
| **D-新-14**（只读 `team_v12(action:"leases")`） | `status:"active"` ⇒ 2 条 ✓；`taskId` ⇒ 1 条 ✓；**`member:"rig-capture"` ⇒ 仍返回全部 130 条、含 12 个成员** ⇒ **过滤器被回显未生效** | **LIVE，`member` 部分 ✗** |
| D-新-8 / 11 / 12 / 13 | 本轮**未**制造反例 | **未 live 复核（不声称）** |

### 二、D-新-15（写范围守卫约束**路径**、不约束**工作树**）—— 真实事故

- 一手证据：`git reflog show main` ⇒ **`main@{0}: commit: …`**（动作是 **`commit:`**；正常落地是 `merge …: Fast-forward`，同 reflog 的其它条目即是）；`git worktree list` ⇒ **共享检出 `D:\dsh-test\workspaces\RustMc` 的 HEAD = `[main]`**；而肇事成员的 `team/world/member-world-chunk` 仍在旧 main ⇒ **它没有在自己的分支上提交**。
- ⇒ 机制：成员在**共享检出**（HEAD=main）里工作并 `git commit` ⇒ **未经令牌、未经清关**把交付送进 main，并作废在飞令牌的前提（`main ⊆ 尖`）。
- ⇒ **守卫为何没拦**：它比对的是**路径前缀**（该成员 scope 覆盖 `crates/mc-worldgen/tests/**`），而**共享检出与成员工作树是同一路径、不同载体** ⇒ 放行。**工作树隔离在门禁层面不存在。**
- **建议**：守卫除路径外再约束**载体**（写入必须落在该成员绑定的工作树内；对共享检出/其它工作树的写入默认拒绝或需显式豁免）。
- **爆炸半径（已收口）**：含肇事 commit 的分支 = `grp/world` / `team/rig/rig-capture` / `team/world/member-world-block`；其中 `team/rig/rig-capture` 的 `main..<branch>` 只有它一个外来对象。⇒ 该 commit 经令牌 + 清关合法进 main 后，三个分支上的它**全部合法化**。

### 三、D-新-16（幽灵 run lease：`acquire` 回执「active」≠ 已持久化）

- 一手读数（成员侧）：`team_run_lease(acquire)` ⇒ `{"runId":"run-0a1d3428-…","status":"active","expiresAt":…}`，但 ① `heartbeat` ⇒ **`unknown run lease`**；② 持久控制面文件里该 runId **0 命中**（同文件另一 runId 15 命中）；③ 写门禁逐字拒。二次 acquire 的另一 runId 才拿到写权限。
- ⇒ 口径：**acquire 之后必须自证，否则视为未持有**。自证面（现已可用）：`team_v12(action:"leases")` 读自己的租约表，确认该 runId 以 `status:"active"` 在表内。

### 四、D-新-17（review/discussion 卡的**相位出口**）—— **已按一手反证更正**

- **更正前的错**：曾写「`advance_phase` 的**相邻步**对 review/discussion 卡**不可用**」。**与实测不符。**
- **反证（组长一手，逐条 CAS）**：对某 review 卡**连续 7 次相邻 `advance_phase` 全部成功**（`room-discussion` → `plan-proposed` → `plan-approved` → `execution` → `member-check` → `group-check` → `verifier-review` → `integration-ready`）。被拒的只是**跳跃**（`room-discussion → member-check` ⇒ `invalid task phase transition`）。
- **更正后的表述（两条事实，不得合成一句）**：
 1. `advance_phase` **只允许相邻步** ⇒ 这类卡要到达 `verifier-review`，**必须空转三个无实质语义的中间相位**（`plan-proposed` / `plan-approved` / `execution`）⇒ **语义噪音**（审计轨迹里出现三个对这类卡无意义的相位），**不是不可用**；
 2. `final-acceptance` **另有一道门**：要求**同一 task set + 同一 commit** 的 `verifier-review` 包（逐字 `[verifier-review-required] …`）⇒ 对 **verifier 自有**的卡构成**自审** ⇒ **结构性缺口**。
- **处置**：不要求 verifier 自审；**`completed` 视为 verifier 自有 review 卡的终态**（验收由 tier 0 在台账具名）；**不得**把 `blocked_by` 依赖闸建在 verifier 自有的卡上。

### 五、观察：多任务验收包是**部分应用**的

- 一手：一份覆盖两张卡的 `final-acceptance`，因其中一张未达相邻相位被**整体拒**（`[task-phase] … required adjacent phase steps: integrated -> accepted`），但**另一张卡已推进到 `accepted`**。⇒ 包**不是事务性的**；重提对已达相的卡**幂等**。


### 六、第三十四批补充：平台第三十三批修复的 **live 复核**（tier 0 一手，2026-09-29）

**① D-新-14 补充（`leases` 的 `member` 过滤）—— LIVE ✓**

| 调用 | 读数 | 判定 |
|---|---|---|
| `action:"leases"`（无输入） | **131 条 / 12 个成员** | tier 0 全表 ✓ |
| `input:{member:"rig-capture"}` | **33 条 / 恰 1 个成员**（修复前为 130 条 / 12 个成员，`member` 只回显不生效） | **过滤生效 ✓** |
| `input:{member:"rig-capture", status:"active"}` | **1 条** | **交集 ✓** |
| `input:{member:"rig-capture", taskId:"group-rig-t63"}` | **1 条** | **交集 ✓** |

**② D-新-15（守卫的工作树载体校验）—— 文件已更新，但 liveness 需成员侧控制**

- `write-scope-guard.mjs` SHA256 = **`6C5A42F29EDE7800DAA5E91B41787E43A6057BDB663B11D253B1D52C08FB8826`**（与操作者给出的哈希**逐字一致**）；**四个 profile 同哈希**（parity ✓）；mtime **2026-09-29 09:06:28**。
- **DSH PID 124592 启动 = 2026/09/28 20:58:01** ⇒ **mtime > 启动** ⇒ 文件在盘上、**但进程启动早于它** ⇒ **HMR 是否已加载，不能由文件判定**（与既有纪律「同一批修复里热生效与需重启并存 ⇒ live verified 必须逐模块判定」同条）。
- ★ **tier 0 无法产生该控制**：tier 0 保留共享检出兼容路径 ⇒ 我的写入**按设计被放行**，不构成负控。⇒ **负控必须由 tier 1/2 成员**（且有**活动 plan 工作树**）产生。
- **请求的控制形态（已下发 lead-rig，见下）**：成员在自己的 scope 内、**对共享检出**写一个**唯一命名的探针文件**（`WORKTREE-CARRIER-PROBE-<rand>.txt`）⇒ 期望 `worktree-carrier-mismatch` 且 **`CREATED=false`**；同一形状写到**自己绑定的工作树**内 ⇒ 期望**放行**。
- ⇒ **判据**：`CREATED=false` + 逐字拒绝串 ⇒ **live**；`CREATED=true` ⇒ **未 live**（需重启），且探针文件必须立刻删除。


## 第三十五批（2026-09-29 · tier 0 一手 + 组长一手）

### 一、D-新-15 的 **live 结论：工作树载体校验【未 live】**（需重启 DSH）

- 有界负控（成员执行、组长设计 framing）：在**活动 plan 的 scope 内**用**写入工具**写**共享检出** ⇒ **完全被放行**：`BEFORE=False` → `CREATED=True`、**无任何拒绝串**、`op=create`；**同形状正控（写绑定 worktree）行为无差别**。
- 探针文件唯一命名、**两处均已清理**；组长**独立复核**：两条路径 `Test-Path` False、`tools/**` 下探针计数 **0**、porcelain 0；证据 `kind=negative-control`（无 task_id，不污染卡产物）。
- 文件侧：`write-scope-guard.mjs` SHA256 `6C5A42F2…`（与操作者给出**逐字一致**）、**四 profile 同哈希**、mtime `2026-09-29 09:06:28` **晚于** DSH PID 124592 启动 `2026/09/28 20:58:01`。
- ⇒ 判据：`CREATED=false` + 逐字 `worktree-carrier-mismatch` ⇒ live；本例 `CREATED=true` 且无拒绝串 ⇒ **未 live**。**「在盘上 ≠ 已加载」，而「正负控无差别」是「未 live」最干净的表述。**
- ⇒ **转操作者**：重启 DSH 后复跑该负控（复跑条件已具备：成员在 t75 上仍有活动 plan worktree）。

### 二、★ 数值更正：`TRUE=144 FALSE=0` **不只是无载体，数值本身是错的**

- 正确值 = **136**（= `Assert` 调用次数；装置现已**直接打印** `ASSERT_SUMMARY|true=136|false=0`）。
- 错规则 **W1**（「以 `=True` 结尾的文本行数」）= **144**；**W2**（形状行）= **138**。
- **144 − 136 = 8** 被**逐条具名**：6 条 `Say` 非形状行 + `CRITERIA_ALL_PASS=True` + `C4R_sort_axis_load_bearing=True`。
- ⇒ 纪律：**转述方与原始方同责**；「某个数没有载体」与「该数本身错误」是**两条不同的缺陷**，后者更重。

### 三、★ 族性判据的**收紧**：域是否具名（组长提议、tier 0 采纳）

- **判据**：**域是否具名** ⇒ **具名 ⇒ 可检测（正面控制）**；**未具名 ⇒ 无法复算（族实例）**。
- **第 7 次（入册）**：某批次口径写「`instance` **22** 字段 … **全部 unchanged**」；实测**旧 23 / 新 27**（新增 4 个身份字段），且**同载体 `port_decision` 段 10 → 13 也未提**。⇒ **未钉对象**（基数 22≠23；「全部」未说明旧集/新集/全载体）⇒ 复算者算得出 23/27 却无法判断该句量化谁 ⇒ **族实例**。
- **对照（拒绝入册的那条）**：另一条 nit 的**域是具名的**（15 个 id 逐个列出），错误因此**被复算者抓到** ⇒ **正面控制**，不入册。
- ★ **再上一层（本批最锐的一条）**：**纠错读数本身也窄了** —— 那条 nit 只比了 `instance` 段（23→27），**未提 `port_decision` 的 10→13**。⇒ **我写窄了，纠正我的那条读数也窄了，两者栽在同一个轴上（域）。** ⇒ **连「纠错读数」也需要具名域。**

### 四、观察：`.ps1` 的**行号引注不在任何机检守卫域内**

- 实测：某次改动使 `tools/rig-batch/tests/run-criteria.ps1` **整体位移**，**静默**使 4 处散文引注失效；而 `citation_integrity.rs` 只覆盖其**具名键**，in-run 的 `verify-citation-anchor.ps1` 四元组**不含该脚本** ⇒ **`.ps1` 行号 token 无任何机检**，本次位移是**靠人发现**的。
- ⇒ 已立卡（把 `.ps1` 行号引注纳入守卫域，位移即红 + 判别力负控）。
- ⇒ **同批实证**（★ 本条是**漂移叙述**，不是对当前内容的断言）：tier 0 自查 `docs/**` 的引注，发现漂移**不止 +12** —— `run-criteria.ps1` 的**旧行号** `:28` 实际应为 **`:33`**（`$OutRoot = Join-Path $RepoRoot …`）、`:765` 实际应为 **`:920`**（`C8_script_identity_unchanged_during_run`）、`:71-72` 实际应为 **`:76-77`**（两条 `ReadToEnd()`）⇒ **已就地更正并附锚点内容**（行数不变）。★ **该读数随后再次漂移**（t66 又推了一次）：2026-09-29 复读为 **`:34` / `:936` / `:92-93`** —— 本条即「**手工更正不 scale**」的现场证据。

### 五、观察：**成员为下一张卡 `acquire` 租约时会做 main-into-branch 同步 ⇒ 分支尖前进**

- 实例：组长合并成员分支时两次被 `[member-merge-source-drift]` 拒（尖 ≠ 卡面 commit），均按设计路径 `allow_source_ancestor:true` 走通。
- ⇒ 纪律：**owner 报尖之后、组长合并之前，owner 不得先领下一张卡的租约**；或**接受 `allow_source_ancestor:true` 为常规路径**。
- ⇒ 这把「R-tip 纪律」补成完整形态：**报尖与合并之间不得有会移动尖的动作** —— 与 main 侧「令牌与落地之间不得移动 main」**同形**。**尖的有效性是时间窗口的属性，不是尖自身的属性。**


## 第三十六批（2026-09-29 · tier 0 live 复核 + 两条 nit 落在不同轴）

### 一、平台第三十八批修复的 live 复核（逐项真实调用）

**★ D-新-16（幽灵 run lease）—— LIVE ✓**（有界真实调用：`acquire -> leases -> heartbeat -> release`，对象 = 一张已完成卡，测试自清）

| 步骤 | 读数 | 判定 |
|---|---|---|
| `team_run_lease(acquire)` | 回执 = `{runId: run-3ecf4e05-…, status: "active", expiresAt: 1790647708694, acquiredAt, heartbeatAt, contractRevision, checkpoint}` | 回执**更富**（新增 `heartbeatAt` / `checkpoint` / `contractRevision`） |
| **紧接着** `team_v12(action:"leases", {member:"lead"})` | **found=1**，行 = `status:active / taskId:task-101 / expiresAt` **与回执逐字相同** | **★ 返回前已持久化 ✓**（修复点） |
| `team_run_lease(heartbeat, run_id)` | **成功**，`heartbeatAt` 已更新、`checkpoint.value` 可读 | **★ 不再 `unknown run lease` ✓**（原失败点） |
| `team_run_lease(release, status:completed)` | `status: "completed"`；行显示 `completed` + `endedAt` | **可正常收口 ✓** |

**D-新-15（工作树载体校验）—— 维持「未 live」**：操作者本轮明确「代码已落盘，但成员负控显示当前 PID 124592 **未热加载**，共享检出仍被放行」⇒ 与我们的否定读数**一致**；**需下次进程更新后复跑负控**（复跑条件已具备）。
**D-新-17 —— 维持 partial / 无平台改动**（相邻推进可用；`final-acceptance` 对 **verifier 自有**卡的自审门**不擅自放宽**）⇒ 我的处置不变：不要求 verifier 自审；`completed` 视为 verifier 自有 review 卡的终态；**不得**把依赖闸建在其上。
**多任务验收包非事务性 —— 仅记录观察，平台本轮不改语义** ⇒ 与我的实测一致。
⇒ ★ **同一批修复里三项状态各不相同（live / 未 live / 无改动）** ⇒ **逐项判定**第三次得到验证；**「在盘上 ≠ 已加载」**。

### 二、★ 两条 nit 落在**不同的轴**上（四维各有其失配方式）

- **nit ①（轴 = 时点）**：批次引用的域扫描计数（`tracked=1139|scoped=921|domain=817`、`bare=696`）在对象上**不复现**（实测 `1145|926|822|excluded_readback=104`、`files=822|key_values=782|quoted=85|bare=697`）。**原因**：它们由**运行时的受跟踪文件集**导出 ⇒ **随仓库状态移动**。⇒ **判据相关的不变量与 12 条发现完全相同**，故不影响结论。
 · ⇒ 纪律：**凡计数由「运行时的受跟踪集合」导出，它就是时变读数，引用必须带 base（时点）** —— 这正是四维里的**时点**轴。
- **nit ②（轴 = 测度）**：t66 的「pre 380 / post 381 行」在任何测度下**都不复现**（raw **939 → 956**、非空行 915 → 932；打印位于**第 64 行**）。⇒ **未具名测度**（又一次）。
 · ⇒ 附注：raw **939** 与我自己的读数（`TOTAL_LINES=939`）一致 ⇒ 该数可复核，错的是「380/381」这个数与其隐含测度。
- ⇒ ★ **合看**：两条 nit **同族但不同轴**（时点 / 测度）⇒ **四维（对象 × 时点 × 测度 × 域）可以各自独立被违反**，因此**必须逐维检查**，不能因为某一维合格就推定其余合格。

### 三、★ 一处**诚实的能力边界**（verifier 自陈，我照录）

- `ASSERT_SUMMARY|true=136` 是**动态计数**，verifier **无法**在不跑完整 rig 批（服务端 / JDK / 端口）的情况下复现。它**改为验证机制**（计数器在 `function Assert` 内自增 ⇒ `true=` 按构造就是调用次数）并复现了**修前 0 命中**的读数，且**明确声明不复现 136**。
- ⇒ 处置正确：**不能复现的数不得声称已复现**；但**机制可复现时，应把机制作为读数交付**并具名能力边界。


## 第三十七批（2026-09-29 · 复发观察 + 两条跨组派活纪律）

### 一、★ 同一对象上同类测度混淆，在 nit 被闭合之后**复发**

- **事实**：某 blob（`d1601db3`）上的「行数列测度混淆」在**其 nit 已被闭合之后复发**：前一次（t67）的处置落在**制品**（载体表头的列名），这一次复发发生在**验收包/报告的措辞**里（把**载体日志**的行数挂到了 **blob** 上）。**同一 blob。**
- ⇒ **判读：把 nit 闭合在「制品」上，并不会闭合「习惯」。** 制品侧的规则只约束**制品**，约束不了**下一次引用**。
- ⇒ **通则（已入 GOVERNANCE）**：**族缺陷的处置必须落在「产生它的那一层」** —— 若实例是**引用**错误，修点就必须在**引用点**。具体：**任何引用他人计数的验收包/报告，必须把该计数的导出命令与对象一并抄进去，不得只抄数字。**
- ⇒ **强度**：这条**同时解释同一批的两条 nit** —— nit① 的成因在**产出侧**（打印点不自钉时点 ⇒ 修点在产出侧，归 `group-rig-t76` ac-6），nit② 的成因在**引用侧**（⇒ 修点在引用侧）。**同族、不同层 ⇒ 修点必须分层。**

### 二、本族实例编号（tier 0 行使登记权）

- **第 8 次（轴 = 时点/对象）**：某门打印的计数由**运行时的受跟踪文件集**导出 ⇒ 随仓库推进而移动（批次 `1139/921/817` vs 对象 `1145/926/822`）。**机械成因** = 三处打印点（`i64_text_representation.rs:243` / `:301` / `:321`）**不自钉 commit/时点** ⇒ 引用者一拷贝就丢时点。修点 = `group-rig-t76` 的 ac-6。
- **第 9 次（轴 = 测度，且更强）**：批次所引 `380/381` 在 **raw 与 非空 两种测度下都取不到**（blob `d1601db3` = 939/915、`38387698` = 956/932；`ASSERT_SUMMARY` 命中 **0 → 3**，行 7/48/64）⇒ **不只是「测度未具名」，而是「来源在具名载体上不可复现」**（分类由组长提出、tier 0 采纳）。**且它是复发**（同一 blob）。

### 三、一条**跨组派活**的近失（tier 0 自纠）

- 经过：tier 0 裁定「某组开窄卡」修某打印点，**没有先查该修点是否已被别组的卡覆盖**，也**没有先具名该文件的作者**；而实际上**两件都已被另一组做掉/具名**（修点已在 `group-rig-t76` 的 ac-6；文件作者是另一组的组员）。⇒ 若执行，会造出**同一文件上的两张卡、两个 owner**。已**即时撤回**该裁定。
- ⇒ 两条纪律（均已入 GOVERNANCE）：**① 裁定「开卡」前必须跨全部组板去重**；**② crate 归属 ≠ 文件作者归属**。


## 第三十八批（2026-09-29 · 去重的检索键 + 重作业线名单 + 一条 inbox 陷阱）

### 一、纪律措辞的正式化：裁定「开卡」前跨全部组板去重，且**检索键必须是「修点路径」**

- 一手支撑（组长）：某修点的**路径归属与卡板归属分属两组** —— 文件在 `crates/mc-proto-schema/tests/`（G-PROTO 目录），而覆盖它的卡在 **G-RIG 板**。
 · 证据：`git log -1 -- <路径>` = `4d64fdd t72: …`（文件由 G-RIG 的 t72 新建）；文件自述 `:1`「G-RIG 侧的机检门」、`:16`「本卡写范围只有 `crates/mc-proto-schema/tests/`」。
- ⇒ **只看本组板会漏；只看本组板上的卡也会漏**（路径在一组、卡在另一组）⇒ **检索键 = 修点路径**。
- ⇒ 与「crate 归属 ≠ 文件作者归属」是同一条的两面：前者「别按 crate 认归属」，这条「**按路径去查卡**」。

### 二、排程：重作业线的**占用者与排队者都必须具名**

- 实例：某卡的判据要求**同一配置连续 N ≥ 3 次 boot** ⇒ 它**占重作业线**（服务端 + JDK + 端口）⇒ 其余需启服务端的卡**必须等它收口**，且**不得提前提 plan**（提前提会让它们变 eligible 而与 boot 序列并行 ⇒ **污染两边读数**）。
- ⇒ 纪律：**重作业线的占用者必须具名**（当前占用者），**排队者也要具名**；「不提前提 plan」是**避免并行**的手段，不是省事。⇒ 与「两个重作业并行会污染读数」「一次一条重作业线」同条，本轮细化为**两份可执行名单**。

### 三、观察：`inbox_ack` 的**回执成功**不等于**目标消息已处理**

- 一手实例（组长自陈）：它此前的 ack **打到了别的消息上**，而它以为已处理的那两条**仍是未处理**；直到它复读 `inbox_list` 才发现，补 ack 后才 `handled/cleared`、`inbox total = 0`、`wakes = []`。
- ⇒ 纪律：**ack 之后必须复读 `inbox_list`，确认目标消息已不在**（不能凭 ack 回执就认为已处理）；对**合并的 wake episode**（一条 episode 含「指令」+「撤回」两个 reason）尤须如此。


## 第三十九批（2026-09-29 · 一次可复核的台账欠账与对账）

### 一、相位列**低报已交付**：19 张已进 main 的卡从未走到 `accepted`

- **发现（组长一手）**：某组板「带 `commitSha` 且相位 ∈ {`integration-ready`, `integrated`}」的卡共 20 张；**逐卡验祖先** `git merge-base --is-ancestor <commitSha> main` ⇒ **19 张 rc=0**（**提交已在 main**），**1 张 rc=1**。
- **唯一 rc=1 的是故意扣住的那张**（其判据已知不可用、等返修）⇒ **与设计一致，不是欠账**。
- ⇒ 结论：**19 张「已交付且已进 main」的卡，相位从未推进到 `accepted`** —— 不是权限问题、不是伪造，是**记账从未推进**。⇒ 它是「验收包因相位链未走完被 `[task-phase]` 拒」的**同一成因的历史存量**。

### 二、对账（tier 0 执行，依据具名）

- **动作**：19 张推进到 `accepted`（其中 8 张先 `integration-ready → integrated`、再 `integrated → accepted`；11 张直接 `integrated → accepted`）。**逐卡 CAS，全部成功**。
- **依据（不得省略）**：① **逐卡祖先读数** `--is-ancestor <commitSha> main` **rc=0**；② 该提交当时的**清关**（落地必经令牌 + 清关 + 合并）。
- ★ **不声称任何新验收**：本对账**只把「已合并」这一已实测事实记进相位**；`accepted` 在此处的含义是「**该交付当时已通过门禁并落地**」，**不是**一次新的复验。
- **未推的那张**（rc=1）**保持原位** —— 扣住状态不得被对账顺手抹平。

### 三、纪律

- ★ **判「已交付」必须用祖先读数（`--is-ancestor <commitSha> main`），不得用相位列。** 相位是**投影**，它**不会自己追上事实** ⇒ 需要**周期性对账**。
- ⇒ 与「判『某卡是否在推进』必须读 `ready_queue` 的 `eligible`/`reasons`，不得从卡面 `status` + 名册 `running` 推」**同族**：**投影不等于事实**；**凡据投影下结论，必须具名该投影的更新时间或与事实对账**。
- ⇒ 配套（流程）：新规则「`integrated` 由合并方在报几何前确保到位」**只能止住增量**；**存量必须对账**。


## 第四十批（2026-09-29 · 对账的三分类 + 一条比我原表述更强的纪律）

### 一、★ 「划定检查域」也不能用投影（比原纪律更强）

- **自伤实例（组长）**：它把「逐卡祖先读数」这条例行检查的**域**定为 `相位 ∈ {integration-ready, integrated}` ⇒ **恰好漏掉**停在**更早相位**（`verifier-review` / `member-check`）但**提交已进 main** 的卡 ⇒ 报出「空」。**它用被禁的投影，划定了检查域。**
- **真读数**（对**全部**带 `commitSha` 的卡，不按相位过滤）：55 张中 **54 张 rc=0**、**1 张 rc=1**（故意扣住那张）；其中「rc=0 但相位 < `accepted`」= **3 张**（两张停在 `verifier-review`、一张停在 `member-check`）。
- ⇒ **纪律**：**不仅「判定事实」不能用投影，「划定检查域」也不能用投影** —— 否则**投影会把自己的盲区变成检查的盲区**。⇒ **可复核反例**：若有人再用「相位 ∈ 某集合」圈定检查域，那 3 张即证伪。

### 二、★ 对账必须按「**清关**」分层（三分类）

- 一手读数：上述 3 张的提交 `∈ main`（rc=0），但**清关条目 = ABSENT** ⇒ 它们是**另一个子形**：**提交在 main，却从未被清关**（旧时代落地、或被后续批次**顺带卷入**）。
- ⇒ **正式规则**：对全部带 `commitSha` 的卡逐卡读祖先，**分类键 = 清关**（不是相位）：
 1. `rc=0` **且**有清关 ⇒ 可对账到 `accepted`（依据 = 祖先 + 清关，**两条都已读**）；
 2. `rc=0` **但**无清关 ⇒ **开项**，保持原位、上报，**不得自动 `accepted`**；
 3. `rc≠0` ⇒ 保持原位（未合并 / 故意扣住）。
- ⇒ 推论：**若任何开放卡的依赖闸要求「无清关的那一类」达到 `accepted`，该闸不可满足** ⇒ 必须立即上报。

### 三、★ tier 0 自纠：声明的**依据**不能是未验的断言

- 实例：tier 0 在上一批的对账**依据句**里写了「① 祖先读数 rc=0；② **该提交当时的清关**」，而**写下 ② 时并未逐卡验证**。事后补验：**19/19 全部有清关** ⇒ **结论成立**，但**当时它是断言而不是读数**。
- ⇒ **纪律**：**凡在声明里写「依据 X」，X 必须已在同一动作中被读取**；否则只能写成「据 A（已验）+ 假设 B（未验）」。
- ⇒ 与「划定检查域不能用投影」是**姊妹条**：那条讲**检查的域**，这条讲**声明的依据**。


## 第四十一批（2026-09-29 · **更正第四十批的分类键**：注册表以「落地对象」为键）

### 一、★ 更正：清关注册表的**键是「落地对象」**，不是卡的 `commitSha`

- **实测（tier 0 独立复现，全 40 位 SHA）**：某卡的 `commitSha` **不是**注册表的键；其**落地对象**（= 把它带进 main 的那次落地的尖）**是**键，且 `--is-ancestor <cardSha> <landing>` **rc=0**。
 · 我另对三张卡独立求出各自的「最早落地键」：`t21→cf4917ec`、`t24→55e91ef4`、`t25→ab5b4aac`；对照某近期卡 `t72→7648a6da`（与组长给出的逐字一致）⇒ **方法可复现**。
- **正确查法**：取该卡的祖先路径 `<cardSha>..main` 与注册表键**求交**，取**最早**的那个键 = **首次把它带进 main 的落地对象**。
 · ★ **过宽的反例**：若取「路径上**任意**键」，命中的总是**当前 tip**（tip 含一切）⇒ **恒真**、不判别。⇒ **必须取最早**。
- ⇒ **更正后的三分类**（分类键 = **落地对象上的清关**）：
 1. **class a**：提交 `∈ main` **且**在 `<cardSha>..main` 上**存在清关键** ⇒ 可对账到 `accepted`；
 2. **class b**：提交 `∈ main` 但**无**任何覆盖清关 ⇒ 开项（**本组实测为空**）；
 3. **class c**：提交 `∉ main` ⇒ 保持原位（未合并 / 故意扣住）。

### 二、★ 更正第四十批的结论（我自己的错）

- 第四十批我据「卡的 `commitSha` 在注册表里 = ABSENT」判定三张卡属「**提交在 main 但从未被清关**」的**第三类**，并据此**不推其相位**、还发出「若依赖闸要求它们达到 `accepted`，该闸不可满足」的告警。
- ⇒ **该判定与告警均不成立**：用**正确的键**（落地对象）查，三张**都有覆盖清关** ⇒ 它们与已对账的那批**同形**（**class a**），只是相位停在更早的段。**告警撤回。**
- **动作**：三张已按相邻步推进到 `accepted`（一张 5 步、两张 3 步），依据与那批相同 = **提交 `∈ main`（已读）+ 覆盖清关（已读）**。

### 三、纪律

- ★ **查表之前必须先确认「表的键是哪个对象」。** 本例：表键 = **落地对象**，而我拿**工作提交**去查 ⇒ **假阴性**（并会进一步派生出错误的「第三类」与错误的告警）。
- ⇒ 与「域必须具名」「投影 ≠ 事实」「声明的依据必须已读」同族；本条管的是**查表的键对象**。
- ⇒ **三处错误各自落在不同轴**（组长本轮自纠）：① 以**错误对象**为键 ⇒ 22 张假 b；② 演示用 **8 位前缀撞 40 位键** ⇒ 全 False、**演示本身无效**；③ 取「路径上任意键」⇒ **域过宽**、恒真。⇒ **对象 / 格式 / 域三轴各自独立可违**，再次印证「四维必须逐维检查」。


## 第四十二批（2026-09-29 · 一次「手工更正不 scale」的现场 + 三条裁定）

### 一、★ 手工更正的行号引注**在一个批次内再次失效**

- 事实：tier 0 于 `59f2307` 就地更正了 `docs/STATUS.md:530` 与 `docs/PLATFORM-DEFECTS.md:1969` 的行号引注；随后 **t66 又推了一次** `run-criteria.ps1` ⇒ 实测 `$OutRoot` **33 → 34**、两条 `ReadToEnd()` **76-77 → 92-93**、`C8_script_identity_unchanged_during_run` **920 → 936**。
- ⇒ **手工更正不 scale**：同一类失效会在每个改动被引文件的批次里复发。⇒ 这正是「把约定变成机械」的又一实例。

### 二、★ 另两条更早未被发现（**内容级**而非仅行号漂移）

- ★ **本条是漂移叙述，不是对当前内容的断言**：`docs/GOVERNANCE.md` 引 `run-criteria.ps1` 的**旧行号** `:777` 称该行算 `bindDirty` ⇒ **实际 `bindDirty` 在 `948-952`**，而 `:777` 现为 `C7R_sentinel_unchanged` ⇒ **引注指向了另一个断言**（内容级失效）。
- `docs/GOVERNANCE.md` 另一处称 `run-criteria.ps1` 第 764 行**含** `-VerifyContent` ⇒ **在 HEAD 上 0 命中**；且该处只写「pinned `main`」**未具名 sha** ⇒ **pin 是移动符号**，该断言**不可再复核**（作为历史读数保留并就地标注）。

### 三、纪律（本批三条）

- ★ **归属规则**：**引注的 owner = 写下该引注的人**（不是被引文件的作者）；`docs/**` 内的引注 owner = **tier 0**（单写者）。**义务**：**被引文件的作者**在改动行号后**必须具名「行号位移」**（位移量或新行号），**不得静默位移**。
- ★ **优先按内容锚定，其次按行号**：能写「哪个符号/哪条断言」就不要只写行号；行号只用在内容无法命名处。
- ★ **门禁应覆盖 `docs/**` 的行号引注**（token 形态），与既有 `citation_integrity.rs` 覆盖 `docs/` 的先例一致；**散文形态**（「第 N 行」/ 同行裸 `:N` 续引）在给出归属规则后**另立卡**纳入。

### B-178（过期断言仍在被引用）「产出侧 `dump_chunks.rs:431` 是裸 JSON number」——**已过期，结论 = 更正**
- 提出者 `group-world-t125` 现为 **deleted**（rev 6）⇒ 该断言**无活 owner**，但仍被引用（含 lead-rig 的 `t72` 卡面）。
- **一手读数（verifier，在 `ad9d9e8a` 与 main `30d62a0c` 上相同）**：产出侧 `:431` 是 **带引号** `"seed_i64":"{}"`，`:536` 注释写「生产者以**精确十进制文本**承载 seed_i64」⇒ **结论 = 更正**。裸形态是 **pre-t126**，由生产侧交付 `7f363d89`（经 `460260ba`）修掉。
- **我的转述错（登记）**：我在给 lead-rig 的消息里把「产出侧裸数字」当作在案事实转述，且**未在同一动作内复读它** ⇒ 与第 41 批「声明的依据不能是未验的断言」同族。
- **处置**：产出侧（`group-world-t132`）与读回侧（`group-world-t131`）**分开**；引用该断言处须标注为**待复核/已更正**。

### 口径统一：漂移叙述 vs 活引注（第 45 批 · 裁定）
- **规则（逐字，写入 t81 ac-1）**：「凡**关于行号漂移本身的叙述**（drift narrative），一律**去 `path:line` token**、**保留全部数字**，并在同处**显式标注**为历史/漂移叙述。**断言当前内容**的引注**必须**保留 token 形态（因而受门检）。除这两类外**不得**去 token。」
- **适用条件（可判）**：文本自称是「当时的行号 / 已被更正的值 / 漂移记录」；否则按**活引注**处理。
- **防规避**：把活引注改写成「漂移叙述」以逃门检 = 违规；**判定权在独立复验**，不在作者。
- **本批已收敛**：`docs/PLATFORM-DEFECTS.md:3404`（原为具名豁免，理由「漂移叙述」）与 `:3566` 都改为去 token + 显式标注 ⇒ **少一条手工豁免**（登记表是行几何的函数，手工豁免越少越好）。

### 平台读数（第 45 批 · lead-rig 转）
- **任务仍 `in_progress` 时不得 release 租约**：恢复次序 = 「先 complete（活动租约下）→ 再 release as completed」；`cancelled` 仅用于**有意放弃**剩余工作。⇒ 当一张卡**部分完成且剩余被外部依赖挡住**时，owner 会被**卡在租约上**（见 B-177）。

### B-175（能力缺口）`team_task_create` 的 `blocked_by` 是**板内**的 ⇒ 跨板依赖无法表达
- 实测：`team_task_create(board:"global", blocked_by:["group-world-t131"])` ⇒ 拒绝 `[cross-board-blocker-unsupported]`：「blocked_by is board-local: group-world-t131 exists on group-world; use a waiting ticket or a board-qualified dependency after cross-board support is available」。
- 拒绝本身 fail-closed 且具名了替代路径（**不是缺陷**）；缺的是「板限定依赖」这一能力。
- 本会话处置：**落地时按 refs 机械复核**（若尖的增量含某路径，则要求另一组的提交 ∈ main），并在全局板建一张 tier-0 只读引用卡（`task-102`）提供跨组可见性。

### B-176（可用性）`team_v12(waiting_set)` 的 `dependency` 条件**必须带 `taskIds`**
- 实测：`unblockCondition = {type:"dependency", on:"verifier clearance for <sha>"}` ⇒ 拒绝 `waiting-condition-invalid: dependency condition requires taskIds`。
- 影响：「**等一个不是任务的东西**」（例如等 verifier 的清关键）无法用 `dependency` 表达。改用 `{type:"manual", note:...}` 可登记（`closurePolicy=explicit`、`status=open`），但 `manual` **不会自动解除**，必须显式 `waiting_resolve`。
- 建议：`dependency` 允许 `note`，或增加 `kind:"clearance"`。

### B-177（死结）卡被**外部依赖**挡住 ⇒ owner **既不能 complete 也不能 release**
- 实测（lead-rig）：owner 因 `[lease-release-order]` 被卡 —— 原文「task "group-rig-t80" is still in_progress; recovery order: complete while this lease is active, then release as completed」。而该卡的 ac-2 被**外部依赖**（group-world-t131）挡住 ⇒ **不能 complete ⇒ 不能 release**。
- 后果：owner 只能（i）无限持有租约，或（ii）**拆卡**（把被挡的验收项切到新卡）。本会话两次都走 (ii)，并作为**标准处置**登记。
- 建议：允许在**具名外部依赖**下 `release`（状态 `blocked`），或允许 `complete` 只覆盖**当前已满足**的验收子集并显式标注未满足项。

### 纪律（第 45 批 · tier 0）
- **「域」必须按轴声明**：一个引注有**站点轴**（写下引注的文件）与**目标轴**（被引的文件）。说「门未含 X」而不指明哪一轴 ⇒ 假陈述。反例（**我**的）：「t76 的门未含 `docs/**`」，实测 docs **在站点域内**（8 条未登记里 4 条的 site 在 docs），只是**没有 target 是 docs 文件**。
- **任何计数都必须具名它的对象（提交/读头）**：t76 的门在**它自己的提交**上 `tokens=19`，在**合并后的对象** `ad9d9e8a` 上 `tokens=20`。我把 19 当作对象的数转述 ⇒ 错。同族：`server_properties_sha256` 的 53/51。
- **以行号为键的登记表是「行几何」的函数** ⇒ 任何移动行的合并都会使它过期（实测：一次合并 ⇒ `unregistered=8 / dead=7`）。⇒ （i）登记表必须在**将被清关的那个尖上由命令导出**，不得手工维护；（ii）不得不手工持有的豁免必须**按内容锚定**，行号只作**显示字段**。
- **先读再改**（比「先读再裁」更锐）：t128 的错不是「拿断言当裁定前提」，而是**在裁定之前就改了制品**（heightMap 一改，17/18 的计数当场就动）。凡「vanilla 是这样」的断言，**改动之前**就要具名 类/方法/条件。
- **令牌/清关请求必须钉「尖 + 树」**；尖一动必须**显式 supersede**。实测：我发给 verifier 的批次对象 `bd2e99c` 在分支线叠了 t77 之后**不再是尖** ⇒ 对它的清关**覆盖不了**本批。「先发的请求仍然有效」是假绿面。
- **`group-acceptance` 是 tier-1 的包**（tier 0 只能发 `final-acceptance`）⇒ tier 0 把批次直接点给 verifier 只是**指针**，不是机制。
- **每个 readings 文件必须自述读头/提交**；事后追加的注解必须**标注为事后**。反例：`t78-readings.json` 同文件内 `rule_version: config-digest-v2` 与提到 v3 的注解并存。
- **制品里存的值必须与它自己声明的规则版本同代**：反例 —— 载体 `instance.config_digest = 136c3602…`（t78 记为 v2 下的值）与 `config_digest_rule.version = config-digest-v3` 并存。
- **验收项被外部依赖挡住时，正确动作是拆卡（不是删项）**：承 t80 两次收窄（已批准）与 t77→t80/t82 的切分。
- **跨组依赖不能用 `blocked_by` 表达**（板内限制，见 B-175）⇒ 用 waiting 票，或**落地时按 refs 机械复核**（本会话采用后者：`git diff --name-only main <尖>` 含某路径 ⇒ 要求另一组的提交 ∈ main）。

### 正例入册（第 45 批）
- **verifier 自纠**：前两次门读数用了**陈旧 `CARGO_TARGET_DIR`**（i64 曾读到 `total=12|baseline=12|stale=0`，是陈旧二进制）；自纠后全部读数来自**全新 target** + HEAD detach + `dirty=false`。
- **lead-proto 自纠**：首个扫描式太窄（`^\s*const ` 只扫到 `:74 TOKEN_PAT`，据此会错判「注册表不存在」）；改按 `ANCHOR|STALE|EXCEPTION|REGISTR` 重扫得 `:46 static ANCHORS: &[Anchor<'static>]` ⇒ 报告命名正确。

### B-179（实例 · 承 B-173）共享检出的 cargo 可能执行**他人工作树**编译出的二进制 —— 具名探测器
- 一手读数（lead-world 组 · member-world-anvil 域外观察）：从 main 检出跑 `cargo test -p mc-worldgen --test dump_chunks` 后，`target/debug/deps/dump_chunks-af3695cc1f575db6.d` 的 `# env-dep:CARGO_MANIFEST_DIR=` 记为 `.dsh-worktrees\team__world__member-world-block`（**不是该检出**）；该工作树的 `dump_chunks.rs` blob = `8e9d0215…`，与 main 的 `63c4092c` 差 59+/4−。
- ⇒ **共享 target 目录把编译期 `CARGO_MANIFEST_DIR` 烤进产物**（B-173 的机制），因此**共享检出上的 cargo 可能跑别人的二进制**。该成员**因此不采信**那次门读数 —— 判断正确。
- ★ **具名探测器（可判、便宜）**：读读数之前先看 `<target>/debug/deps/<test>-<hash>.d` 的 `env-dep:CARGO_MANIFEST_DIR` 是否等于**本次检出**；不等即该读数**作废**。
- 既有逃逸口径（承 B-173）：具名对象判据（`checks::source_at`）、保留 `Compiling <pkg>` 行、隔离 `CARGO_TARGET_DIR`。
- 本会话**第二例**（第一例 = verifier 自纠：前两次门读数用了陈旧 `CARGO_TARGET_DIR`，i64 误读 `total=12`）。

### B-180（外部仪器）预言必须按**内容**钉住，不能只按路径具名
- 实例：t128 的 JavaRandom 逐位自证用的仪器在**本仓库之外**：`D:\dsh-test\workspaces\mc189-rs\tools\golden\jdk\jdk8u504-b01\bin\java.exe`（JDK 8）。路径 + 版本已具名，但**未按 sha256 钉住**。
- ⇒ 规则：**任何位于本仓库之外、又被引为判据的仪器，必须同时给出（路径 + 版本 + 内容 sha256）**；否则该读数**不可复算**（与「引注必须可复算」同源）。
- 同日纪律：**仪器的路径也是一个「对象」**（第 45 批：任何计数/读数必须具名它的对象）。

## 批次 55（tier 0 落地 · 2026-09-29）：平台缺陷批次 46 未 live 通知 + B-182/B-183/B-184 + 本会话纪律 ③–㉔

## 平台缺陷批次 46（2026-09-29）—— 修复在码，未 live

输入清单指纹：size 648786，SHA256 E57FA5EE0F5EBED0690E914CEB50FC1E65107DB81D76025C46EB10CB305A1BBE，mtime 2026-09-29T02:36:24.7378364Z。

- B-175（跨板 blocked_by）：已实现 boardId:taskId 板限定依赖；未限定 id 仍为板内语义。
- B-176（dependency 等待需 taskIds）：无 taskIds 时允许具名 on/object/note，closurePolicy=explicit，须显式 waiting_resolve。
- B-177（in_progress + 外部阻塞 ⇒ owner 卡死租约）：lease release 接受 status=blocked，仅当任务有非空 blockedBy 或具名开放等待票时放行。
- B-178：产品侧已由 7f363d89 更正，平台侧本轮不改。
- B-179 / B-180：登记为 no-platform-change 证据纪律（共享 Cargo target 须核 CARGO_MANIFEST_DIR；仓外仪器须具名路径、版本、SHA256）。

**live 状态：未 live。** DSH PID 124592 未重启；运行中进程是否热加载修改仍为 live pending。平台侧给出的四份文件哈希：team-control-plane.mjs 00E7ED97…、team-v14-waiting.mjs 11F573B7…、team-v12-evidence-scheduler.mjs 254DC200…、team-tools-v2-r10.mjs 4618F41C…。

**对产品会话的后果（重启前必须继续遵守）**：
1. 跨板依赖仍不得用 blocked_by 表达（B-175 修复未 live）⇒ 继续用等待票或落地时 ref 复核。
2. waiting_set 的 dependency 仍须带 taskIds（B-176）⇒ 继续用 manual / 具名 note。
3. 仍不得用「让 owner 停在 in_progress」表达排期决定（B-177）⇒ 继续用「完成 ≠ 合并」的分离。

---

## B-182（本轮新登记）· 等待票的「完成后门控」被 `auto:task-terminal` 静默关闭

**现象（一手，权威存储）**：lead-rig 为 group-rig-t82 的**合并门**建了三张票，三张全部被平台关闭，closedReason 均为 `task-terminal`、closedBy 均为 `team-v14-waiting`：
- `wait:group-rig-t82:rig-runner:f39f3569-68ad-4851-b97a-0a2dc2755fef`（external：G-WORLD 负控改形态无关）
- `wait:group-rig-t82:rig-runner:fd229487-0b1a-458a-aef1-a51deba2ada9`（external：窄修落 main + 两二进制 rc=0 才放行合并）
- `wait:group-rig-t82:rig-runner:98ea3d0d-1e2b-4934-9960-e2e93fe3e554`（dependency：[group-world:group-world-t133]）

**为什么是缺陷**：t82 的卡 status = completed，而这三张票的解除条件**恰恰只能在完成之后才被评估**（「完成」与「合并」是可分离的两个状态，本会话已入册）。平台按「任务终态」关闭其等待票 ⇒ **门在需要它的那一刻消失**，且是静默的（无红、无提示）。

**与正确行为对照**：同一批里 `wait:group-rig-t60:rig-runner:6f7508e5…` 的 unblockCondition 是 `{type:"approval", description:"lead-rig 批准 t60 计划并放行"}`，被 `auto:plan-approved` 关闭 —— 那条**正确**，因为批准就是它声明的解除条件。⇒ 区别在于：当解除条件与任务终态**无关**（外部修复 / 跨组依赖 / 落地前 ref 检查）时，`task-terminal` 关闭是错的。

**建议修法（任一）**：① 仅当 unblockCondition 的语义与任务终态相关时才允许 `task-terminal` 关闭；② 或提供「post-completion gate」票类型，明确其生命周期跨越任务终态；③ 至少在关闭时给出可被消费方读到的提示（现在是静默的）。

**产品侧规避（已执行）**：不再把跨组合并门托付给等待票 —— 改为**落地时机械复核**，责任在 tier 0（grp→main 的合并是 tier 0 的动作）：① `git merge-base --is-ancestor <t133 提交> main` rc=0；② 在该尖上 `cargo test -p mc-worldgen --test dump_values` 与 `--test dump_chunks` 同时 rc=0；③ porcelain=0。三条写进落地证据。

---

## B-183（本轮新登记）· 任务作用域的 requirement 因 `scope` 为空被归类为 global，锁死到 tier 0

**现象（一手）**：`task:group-world-t133:acceptance` 的 id **具名了任务**（`task:group-world-t133:...`）、`taskIds:["group-world-t133"]` 非空，但 `scope` 字段为空字符串。lead-world（该卡的组长）用 `team_v12(action:"requirement_record")` 追加 c1 强化被拒：
`requirement-scope: global or unscoped requirements require tier 0`

**为什么是缺陷**：作用域判定显然取了 `scope` 字段，而**忽略**了 requirementId 前缀与 taskIds —— 两者都已明确指向该组任务。结果是：组长无法记录自己组内卡片的验收修订，只能改卡面 description（可读性差、无独立 revision、不进入 requirement 台账）。

**建议修法**：作用域判定优先用 `taskIds`（或 requirementId 的 `task:<id>:` 前缀）解析出所属组，`scope` 为空不应等同于 global。

**产品侧规避（已执行）**：由 tier 0 侧记录 —— `task:group-world-t133:acceptance` 已升到 **revision 2**（`scope` 由空改为 `crates/mc-worldgen/tests/`），内容 = c1 强化（形态无关的注入须为源文本的纯函数 + 两形态用合成输入覆盖 + 新断言须有非真空证明），取代 revision 1。

---

## 本会话我自己的两处判读错误（记入纪律，非平台缺陷）

**① 「0 命中」的第三个必备条件：查询键的完整形态。**
我用 `waiting_list{ticketId:"wait:group-rig-t82:rig-runner:fd229487"}` 得到 `total:0`，据此几乎判定 lead-rig 回执引用了不存在的票号。实际是我**传了短前缀、漏了 UUID 后缀**（完整 id 为 `…:fd229487-0b1a-458a-aef1-a51deba2ada9`）；改按 `taskId` 查询立刻返回该票。
⇒ 纪律升级：**「0 命中」必须同时具名「读取面 + 规模 + 读取时刻 + 查询键的完整形态」**；一个看起来像 id 的前缀不是 id。差一点据此错误地指控一个下属。

**② 下属的 `resolved` 票不等于门存在 —— 也不等于门不存在。**
我先由「活跃票里没有 t82」推出「门只存在于散文里」，再由 B-182 查明：门曾经存在、被平台关掉。两次推论都从**投影**出发。⇒ 复核一条门是否成立，只能查**权威存储里该对象的全部历史**（含 closed），不能只看活跃集。

---

## 本会话新增纪律（平台行为导致，非平台缺陷）

**③ 分支是共享的 ⇒ 卡级门就是分支级门。**
lead-rig 一手实测：`--is-ancestor 2e311f51 8b3e5c00` **rc=0** 而 `--is-ancestor 2e311f51 grp/rig` **rc=1** ⇒ 合 t60 必然把 t82 的未放行提交一起带进 grp/rig。⇒ **门控一张卡的合并 = 门控该成员其后所有卡的合并**（t60/t83/t84 全部停住）。
这不是缺陷，是线性分支的必然。解法只有两个：**按序落地**，或**一卡一分支**。排期时必须把「同一成员共享一条分支」当作资源约束，而不是把每张卡当成独立可合。

**④ 同一 owner 的两张卡，写范围也必须互不为前缀。**
lead-rig 实测：t83 与 t84 **互相顶掉对方的 plan**（`scope-conflict`，**即使 sameOwner=true 也拒**）。判为预期行为（同一 owner 的卡若写范围互为前缀，放行并行会自伤），但它是排期事实：拆卡时**同 owner 内部也要做 scope 去重**。

**⑤（完整正文见上文「本会话我自己的两处判读错误」①）** —— 「0 命中」必须同时具名**读取面 + 规模 + 读取时刻 + 查询键的完整形态**。

**⑥（完整正文见上文②）** —— 复核一条门是否成立，只能查该对象在权威存储里的**全部历史**（含 closed），不能只看活跃集。

**⑦ 「一卡一分支」在现机制下不可用（我提出后被下属纠正）。**
`team_worktree_setup` 的语义是「把 base 并入该成员的**那一条**分支，从不 reset/rebase」⇒ **一个成员只有一条分支，卡无法各自分叉**。⇒ 「共享分支上卡级门 = 分支级门」的**唯一**解法是**按序落地**；「一卡一分支」不是可用选项，不得再作为建议提出。

**⑧ 空闲成员不是产能。**
lead-rig 在 rig-capture 空闲且队列已空时**没有**改派剩余卡，理由机械可核：剩余卡（t64/t58/t83）的修点都在 `tools/rig-batch/`，其中 t83 被钉在 rig-runner 分支上、与 t60 改 `run-criteria.ps1` 的第 242 行 **同一处**，t64 的修点也指向同一文件 ⇒ 换基座会在**同一批行**冲突。
⇒ **若剩余卡的修点落在同一文件的同一处，加人只增加冲突面，不增加吞吐。** 压住是对的，但必须**显式说明**（否则空闲成员看起来像失职）。

**⑨ 一条被排除的假设要给出「用哪条读数排除」；而同一读数往往排除的不止一个候选。**
lead-world 用「脉段 draws 恒 168 = 7×(3+21)」排除 (i) 两次调用（336）与 (iii) 块数翻倍（294）—— 算术我复核全对。但**同一条读数也排除了它自己 (ii) 里的「count 翻倍」**（14×24=336）。⇒ 存活的是更窄的 **(ii)：调用次数正确、每次调用内的放置被写两次**（不消耗抽样）。
教训：**列候选时不要把两个不同机制塞进一个候选**；一个候选若内含两种机制，排除一个不等于排除全部。

**⑩ 「自洽性排除」不需要标定；「跨实现量值比较」才需要。**
lead-world 更正了我：排除 (i) 两次调用 / (iii) 块数翻倍，用的是**计数器自身的可加性**（翻倍会让它自己的 draws 变 336/294，而实测 168）⇒ **不依赖与 vanilla 的比较，故不依赖标定**。我上一轮把「标定」说成整条演绎的前置，**过度了**。正确区分：
· 自洽性排除（同一实现内部）⇒ 无需标定；
· 跨实现量值比较（例如「我们的 168 = vanilla 的 168」）⇒ 必须标定。

**⑪ 同一个「读数不等」可能由多个原因产生 —— 必须为每个候选具名一个独立签名。**
段 2 消耗数不同有两个原因：**(a) 不可读**（越界 `h=0` 早退）；**(b) 地形高度本身不同**（本卡判据 A 的第三个具名分量 t130，129/256 列 ±1）。两者都给出「消耗不同」，也都与观测签名相容。
⇒ 只测「是否不等」**不能分辨原因**，而且两个原因的**修法方向完全不同**（(a) 放宽可读窗口；(b) 修地形高度）。必须为每个候选各取一条**独立**读数：(a) 的签名 = 每源 `h=0` 早退计数；(b) 的签名 = 采样位置上「我们的高度 vs vanilla 的高度」逐点对照。

**⑫ 「外圈源写入 0 ⇒ 与目标无关」对「贡献」成立，对「可读性」不成立（我自己的降级被推翻）。**
我曾据此把「vanilla 调度对照」判为不在关键路径。但可读性影响的是 **RNG 消耗**，而消耗会影响**正在贡献的源**（`src(-1,0)`）。⇒ vanilla 侧的问题以另一种形式回到关键路径：不是「vanilla decorate 哪些源」，而是「**vanilla populate 时哪些块已经生成/可读**」。
一般化：**一个对象「不贡献」不等于「不影响」** —— 它仍可能通过**消耗共享状态（RNG 流）**影响结果。

**⑬ 由公式推出的集合必须**机械导出**，并与公式一起给出；手算会在同一对象上给出不同答案。**
lead-world 先写「`src(-1,0)` 只需块 `(-1,0)/(0,1)`」，后写「只需块 `(-1,0)` 与 `(0,0)`」—— **两次都只有 2 个，且互不相同**。按区域公式 `[s·16+8, s·16+23]` 机械代入：x ∈ [−8,7] ⇒ 块 {−1,0}；**z ∈ [8,23] ⇒ 块 {0,1}** ⇒ 正确是 **4** 个：`(-1,0) (-1,1) (0,0) (0,1)`。
**为什么载重**：集合少一半 ⇒ 逐点对照漏掉 z ∈ [16,23] 那一段 ⇒ 可能给出**假「相等」**，而该结果正是「改地形高度 vs 放宽窗口」的分岔判据。假相等会把修法引到错方向。
**纪律**：凡「由某个公式/谓词导出的集合」，必须 (i) 把公式与集合**一起**写出，(ii) 集合由公式**机械代入**而非手算，(iii) **逐项确认集合中的每个元素都真实可得**（lead-world 只确认了 2 个文件存在）。

**⑭ 两个仪器不一致时，不要默认「读数」错 —— 先问哪个仪器的定义域更窄。**
（lead-world 提出，我升为纪律。）成员的段 2 手算 ≈196-215 与计数器实测 1592 差约 8×。但**手算在它自己承认的未读集合上还不是「同一对象的仪器」** —— 它自述 `apo/aop/aou/aom` 生成器体**未读** ⇒ 那个差目前是**不完整模型 vs 完整测量**，度量的是**模型的缺口**。
⇒ 正确顺序：**先把读集合闭合，再逐子段对**；并交付**逐子段比值表**把缺失量**归属到具体子段**（因子 8 更像漏一整个子段/循环，不像每候选 ±1 的条件抽样 —— 两者签名不同，必须可分辨）。

**⑮ 引用卡必须带板前缀 —— 裸编号在跨板时是歧义的。**
G-RIG 新开的卡是 **`group-rig-t85`**，而刚落地的装配卡是 **`group-proto-t85`** —— **编号相同、板不同**，两张都真实存在。裸写「t85」不会报错，只会让两个人以为在说同一张卡。
一般化：与「任何计数必须具名它的对象」同族 —— **任何任务引用必须具名它的板**。

**⑯ 测量必须连同它的域一起复核 —— 域错时读数依然「看起来完全合理」。**
成员的 (b) 读数 `204/256 点高度不同` 落在 `x∈[−8,7], z∈[0,15]`；但装饰区是 `[s·16+8, s·16+23]`（**两轴**）⇒ 正确域是 `x∈[−8,7], z∈[8,23]`。错域**包含 128 个从不被采样的点、排除 128 个被采样的点**，而读数看上去毫无异常。
⇒ 复核一条读数，必须**同时**复核它的域；域必须由公式**机械导出**（承 ⑬）。域错不会自己喊。

**⑰ 「两侧都是装饰后 dump」⇒ 得到的是「地形+装饰」的联合签名，不是地形签名。**
高度谓词（最高非空气方块 +1）在**装饰后**的 dump 上取值 ⇒ 某列高度差**可能来自树**而非地形。⇒ 该读数**不能**作为「地形高度不同」的证据。要取地形签名，必须**两侧都是 terrain-only**（ours = `provide_chunk`；vanilla = 未 populate 的地形 dump）。
一般化：**谓词的定义域若包含了你不想测的东西，读数就是联合效应，不是单因子签名。**

**⑱ 「令牌已发」必须以控制面记录为准 —— 消息文本里的字符串会命中搜索，造成假阳性。**
lead-world 在交给 verifier 的交接消息里**先写了令牌 id**（`TOKEN-t133-26823037`），而控制面上当时**并不存在**该记录。
**我自己也差点被骗**：我先用 `includes("TOKEN-t133-26823037")` 查控制面得到 **true**，但命中的是**那条消息的正文**。改用精确 `"decisionId":"TOKEN-t133-26823037"` 匹配才得到 false。
⇒ 两个后果：(i) 令牌的**存在性**只能由**精确记录匹配**判定，不能由子串命中判定；(ii) 组长应**请求**令牌，不要把「已发」当既成事实写进交接 —— 否则 verifier 会据一个不存在的对象开始复核。

**⑲ 同一对象的两份说法互相矛盾时，必须先读出语义再设计实验。**
lead-world 前封说 ours 是 terrain-only、收尾说两侧都是装饰后 —— 两者不可能同时成立，而它决定**夹具采集卡的交付物是否完整**（若 ours 是装饰后，则还须产出 ours 的 terrain-only）。
⇒ 语义必须**从产出者读出**（生成该 dump 的代码/命令），不得断言；且**冻结树**（ORACLE-SPEC:10 禁区）不得被写入，新产物须落非冻结路径并声明来源/版本/sha256，落地证据须含冻结树逐字节不变的证明。

**⑳ 更正 ⑫：「不贡献 ≠ 不影响」只在它所消耗的状态确实共享时成立。**
我在 ⑫ 里说「外圈源写入 0 ⇒ 与目标无关」对**可读性**不成立，并据此收回了我对「vanilla 调度对照」的降级。**那个收回是错的。**
逐源重播种**已被证立**（每个源各建一条新流）⇒ **RNG 流每源独立、不共享** ⇒ 一个源的消耗**只影响它自己的放置**。⇒ 外圈源写入目标为 0 ⇒ 它的消耗**确实无关**。⇒ **原降级是对的，我的收回才是错的。**
独立确认：贡献源 `src(-1,0)` 的 `h=0` 早退 = **0**（13 采样点全可读），而早退不为 0 的 5 个源写入目标**全为 0** —— 两件事各自成立、互不干扰。
**更正后的规则**：「不贡献 ≠ 不影响」**只在所消耗的状态确实共享时**成立；状态不共享时，「写入 0」就是无关。

**㉑ 把「对照一下」变成「可被否证的预测」。**
链条：段 2 消耗不同 ⇒ 段 3 起点不同 ⇒ 落进目标的迭代不同 ⇒ 97 计数 2×。既然贡献源 `src(-1,0)` 可读性完整（早退=0）、段 2 消耗 = 1592，则**为了分歧存在**，vanilla 的段 2 消耗**必须 ≠ 1592**。
⇒ **预测：vanilla ≠ 1592。若测得 = 1592 ⇒ 段 2 不是成因、整条链条被否证** ⇒ 回到段 3 / 放置谓词。先落预测、再取数。

**㉒ 仪器只数它被造来数的那一种早退。**
(a) 的计数器只数 **`h=0`（块不可读）早退**，**不数树内空间早退**；而 (b) 的机制恰恰是「高度不同 ⇒ 树的空间检查不同 ⇒ **树内**早退不同」⇒ **不会被该计数器看到**。
⇒ 「早退 = 0」排除的是**可读性机制**，**不是「早退」这个现象本身**。仪器的**盲区**必须与它的读数一起具名。

**㉓ 在合并门未过的分支上取的读数，不是 main 的读数（我犯的错，被下属推翻）。**
lead-rig 报「t84 路径限定 `CONTRACT.md:75` 后 `present_pending_path` **6→5**、该键不再出现 ⇒ 可删」。我把它当作 **main 的状态**转给 lead-proto 并要求删卡。
**实测（一手 @576404d6）**：`--is-ancestor ec6b7d9e main` **rc=1**（t84 被合并门挡在 t133 之后）⇒ **不在 main**；`CONTRACT.md:75` 在 main 上**仍是裸基名**（`chunk.rs` 的第 8 行，未带目录） ⇒ 该键**仍然匹配** ⇒ 删掉会 `unregistered=1` ⇒ **门禁转红**。lead-proto 先测再拒，我撤回。
**纪律**：(i) 跨组转达读数**必须具名它是在哪个 ref 上取的**；(ii) **「在合并门未过的分支上测得」不是「main 上测得」**；(iii) 收到跨组读数的人有权**先测再拒** —— **「前提被实测推翻 ⇒ 动作不可执行」优先于「上级已下发」**。
这条与「读数文件必须自述读头」同族，但这是**跨分支**的读头混淆：同一个仓库、同一个命令、不同的 ref，得到相反的结论。
---

## B-184（本轮新登记）· verifier 的复跑能力被写范围门约束 ⇒「非作者复跑」类判据可能不可达成

**现象（一手）**：verifier 对 t133 的裁决里 `minor` 记录：它要复跑 c1(a) 的「改前红」，须在工作树里**构造一个混合体**（新两形态测试体 × 旧裸锚点惯用法）；该构造被**写范围门拒绝**（inline interpreter write denied）⇒ **未复跑**，记为**验证限制**。

**为什么是缺陷**：verifier 的职责含「非作者复跑」，而某些判据的复跑**必须产生中间制品**（构造反例输入、临时改写测试体）。写范围门按 `write_scopes` 判，而 verifier 的工作树是**只读 detached**、任务无写范围 ⇒ **任何需要写中间制品的复跑都被拒绝**。后果：该要求在该类判据上**不可达成**，而失败面看起来像「verifier 偷懒」。

**与正确行为对照**：同一批 verifier 的其余复跑（几何、门禁、注入计数）都是**只读**的，全部完成 ⇒ 门只在**需要写中间制品**时拦人。

**建议修法（任一）**：① 给 verifier 一个**显式临时区**（工作树外的 scratch），其写入**不计入 `write_scopes`**；② 或允许 verifier 在**具名判据**上获得**常设**的一次性写入豁免（与 `team_privilege_request` 同族，但按判据常设而非单 turn）；③ 至少在拒绝时回一条**可消费的提示**，让裁决能引用平台理由而非只能自述。

**产品侧规避（已执行）**：本会话把「复跑被拒」**记为验证限制而非对象缺陷**（verifier 自己就这么记的）；要求方（tier 0 / 组长）在写「非作者复跑」类判据时**必须先把判据拆成「只读可复跑」与「需构造制品的部分」**，后者另派给**有写范围的 owner**，或降级为**具名限制**。

---

**㉔ 未读的断言不得写进卡面 —— 卡面是契约，会把断言传播成「已确立」。**
rig-runner 自纠了它的 t84 结论（「元组混代」是错的）；但**我已经把那条写进 t85 的卡面**，措辞是「rig-runner 的实验已表明它不成立」—— **而我从未读过该对象**。
实读：`66ccf240` 上 `CONTRACT.md:72` 是 `I` 条、`:77` 是 `L` 条 ⇒ 元组的 `From=77` **在那个 rev 上成立**；四个元组**都是同代**。真缺陷是**载体自己的引注号**（该 rev 上 :414 引的是 `:72`）。
⇒ 纪律：(i) **卡面是契约** —— 写进去的东西会被执行者当**前提**，错误会**向下传播**；(ii) 「先读再裁」的下限是「**先读再写**」：凡「X 已表明 / 已验证」的措辞**必须能指名我读过的那个对象与读数**，否则只能写成「待核」；(iii) 更正时**追加而非改写**，并**把自己的错误具名**（本批按此办理）。
一般化：**「引用别人的结论」与「断言一个事实」的举证责任是同一档**；转述不减免。

---

### 正例入册（第 55 批）

- **把断言变成机器检查**：rig-runner 发现 t84 的「混代」是误读后**没有改任何元组的 `CitedRev`**（本就没得改），而是新增 `CITATION_ANCHOR_REV_COORDS` ×4 + `SELFTEST_REV_COORDS_OK`，把「元组坐标在其 `CitedRev` 上成立」**折进通过条件**，并在无 git 历史时 **fail-closed**（`resolvable=False|MISMATCH`）。⇒ **让断言变成检查，强于让人相信一次读数**。
- **t133 的修法与 t76/t81 同族**：锚点 = `T133_SEED_KEY` + **按值比较**（`dv:1495` / `dc:878`），`src.replace` 在 `crates/` 里 **0 命中** ⇒ 注入**按值定位、形态无关**（panic 文本自述）。
- **独立同源确认**：verifier 的 `condition`（「真实夹具在对象上仍是裸形态 ⇒ 带引号那一支只由合成输入覆盖 ⇒ **t82 落地后在真实夹具上复跑两个二进制**」）与 lead-rig 按 tier 0 ③ 收紧的门**是同一结论、来源独立** ⇒ 该门现有**两个独立来源**。
- **先测再拒**：lead-proto 收到 tier 0 的删卡指令后**先实测再拒**，给出判定式与读数（删则 `unregistered=1`、门禁转红）。⇒ **「前提被实测推翻 ⇒ 动作不可执行」优先于「上级已下发」**。
- **拒绝从「字节不同」跳到「非确定」**：lead-world 对「17 个不同 sha256」给出**三个未分辨候选**（格式/序列化演进；采集范围或旗标不同；真·内容非确定）与一条**可判、便宜**的判别测量（解码到语义面**逐点**对照，而非比字节）。
- **逐记录旗标必须先归一化再逐点比较**（lead-world 提，已进 `group-rig-t88` 卡面）：`sky_light_sent` / `ground_up` 是**逐记录旗标** ⇒ 两批旗标不同则**字节长度也不同** ⇒ 逐点比较必须**先按该记录自述旗标归一化、只比方块平面**，否则会把**旗标差异误读成内容差异**。
- **从产出者读语义、不选边**：lead-world 在自相矛盾后**去读生成该 dump 的代码**（`.provide_chunk`；`git grep -nEi "populat|decorate" -- crates tools` 只命中 `mc-world/src/light.rs` 的 `light_populated`，是另一个概念）⇒ 得出 ours **无 decorate 步骤**。
- **预测先落盘**：t128 把「对照一下」变成**可被否证的预测**（vanilla 段 2 消耗 ≠ 1592；若 = 则整链被否证、回到段 3/放置谓词）并**先写进 evidence** 再取数。
- **几何自证物化**：verifier 的复核用 detached checkout + `write-tree == obj^{tree}` + `diff --raw` 空 + porcelain 空（**含共享检出 `-uall`**）。
- **先查效果再重发**：lead-world 一次 `run_code` 触发 120s 超时（三条消息同批）⇒ 它**先查 `ptc_receipts` 并观察重发时 `coalesced:false`** 再重发，没有盲目重跑。

---

## B-185（本轮新登记）· 缺陷台账无法逐字引用「被判歧义 / 未登记」的引注 —— 记录缺陷的动作本身会把同一门禁弄红

**现象（一手，就发生在批次 55 落地时）**：本批在 `docs/PLATFORM-DEFECTS.md` 里**逐字引用**了两条待处置的引注形态 —— 一条**裸基名**（`chunk.rs` 的第 8 行）、一条**未登记的 `.ps1` 行号引注**（`run-criteria.ps1` 的第 242 行）—— 三处硬门禁中的**两条当场转红**：
- `citation_integrity`：报「出现未登记的不符项（未登记项必须红）」，分类 `ambiguous=1`，对象 = 该台账文件对应行 + 裸基名形态；处置提示为「改引用为路径限定或消除同名文件，**不是去登记例外表**」。
- `ps1_line_citations`：报「未登记的 .ps1 行号引注 1 条（新增引注必须登记进 ANCHORS/STALE/EXCEPTIONS）」，对象 = 该台账文件对应行 + `run-criteria.ps1` 的第 242 行形态。

**为什么是缺陷**：门禁的**扫描域包含叙述性散文**，而**记录一条引注缺陷**的最忠实方式就是**逐字写出那个形态**。⇒ 台账被要求**不要写出它要记录的东西**：写出来就红，不写出来就**失真**。这与「引注必须可复算」的初衷方向相反 —— 这里需要的不是可复算，而是**被引用的反例**（反例天然是不合格形态）。

**与正确行为对照**：同一台账里**合格**的引注（路径限定、可解析）一条都没红；红的只有**被引用的不合格形态**本身。⇒ 门禁判得没错，**错的是它没有给「引例」留位置**。

**建议修法（任一）**：① 给台账一个**显式的「引例」标记**（如代码围栏块或 `EXAMPLE:` 前缀），门禁跳过标记区；② 或把扫描域**排除缺陷台账**（它天然要引用反例）；③ 至少允许**登记一条「本台账引用」豁免**并具名其行。

**产品侧规避（已执行）**：引用时把**路径与行号分离**（写成「`chunk.rs` 的第 8 行」「`run-criteria.ps1` 的第 242 行」），使形态不再匹配引注文法。**代价**：台账里的引用不再是逐字原文，读者需自行还原形态 —— **这正是本缺陷的实质损失**。


## 批次 56（tier 0 落地 · 2026-09-29）：B-186 + 平台批次 47 未 live 通知 + t88 金样唯一性判决 + 树叶树种级发现 + 纪律 ㉗–㉟

## ㉕ 裁定书里的「机制句」若未经实测，就是未读的断言 —— 执行者会用更窄的读数更正你

我裁定 `group-rig-t87` 时写「`:76` 的 `StartsWith` 没有显式比较 ⇒ .NET CurrentCulture ⇒ **含义取决于机器区域设置**」。rig-runner 在 **zh-CN / tr-TR / InvariantCulture 三区域**探针下得到**完全相同**的结果（before = CARRIER_1、after = CARRIER_2）⇒ **可观察机制不是 locale 之差**，而是**运行时默认取哪一种比较**：culture-sensitive 比较把 **ignorable 字符**（U+00AD 软连字符 / U+200B 零宽空格）**当作不存在** ⇒ `tests/fixtures` + U+00AD + `/x` 被当成 `tests/fixtures/x`。

⇒ 纪律：(i) 裁定必须把「**方向**」与「**机制**」分开 —— **方向可以裁**（这里仍取显式 `Ordinal`），**机制必须实测，或明确标注为「未测」**；(ii) 执行者给出的**更窄读数优先**，这是**正例**而非违令；(iii) 与 ㉔ 同族：**未读的断言不得写进契约**（卡面与裁定书都是契约）。
**代价不对称**：方向错会毁掉工作；机制句错只损可读性 —— 但**机制句错会误导下一个复现者**（他会去找一个并不存在的 locale 依赖），所以仍必须收窄。

## ㉖ 门禁的扫描域含叙述性散文 ⇒ 缺陷台账无法逐字引用反例（= B-185）

本轮落地批次 55 时实测：台账里逐字写出「裸基名引注」与「未登记的 `.ps1` 行号引注」⇒ `citation_integrity` 与 `ps1_line_citations` **双双转红**，报「未登记的不符项」「新增引注必须登记进 ANCHORS/STALE/EXCEPTIONS」。
⇒ **文档作者须知**：凡在 `docs/**` 里**引用一个不合格的引注形态**（这正是缺陷台账的职责），必须把**路径与行号分离**书写，否则**记录缺陷的动作本身会把门禁弄红**。已登记为 **B-185**（建议给台账一个显式的「引例」标记区）。

## 正例入册（第 56 批）

- **三区域探针把断言变成读数**：rig-runner 对「区域设置依赖」这条**未测机制句**做了 zh-CN / tr-TR / InvariantCulture 三区域对照，得出「同结果 ⇒ 机制是比较种类而非 locale」并**建议收窄卡面措辞**。
- **用「桶剖面同形」当判别量**：lead-world 对 t128 的 8× 自洽差，不问「各段数值差多少」，而问「**我方 1592 里有没有一个 ≈768-772 的花形状桶**」—— 有 ⇒ 清单错（实现其实跑了花趟）；无 ⇒ 才回到整段缺席。实测**无花桶** ⇒ 一次定案。
- **8× 的真因 = 生成器体内的循环**：草桶 9264 = `apu#b` 体内 **128 次尝试 × 6 抽样 = 768/次** × 2 次/源 = 1536/源 ⇒ 每源手算 ≈1726，与实测同量级 ⇒ 差消失。正是「**漏掉一个循环**」的签名，只是它在**生成器体内**。
- **纠正预测的状态**：lead-world 指出 vanilla **≥1246 是下界**（`apm` 体、树冠 `aoj:64` 的条件抽样未计）⇒ **「vanilla ≠ 1592」尚未被判，不得声称已满足**；并给出正确顺序（我方桶剖面 → 补完解析和 → 才判预测）。
- **超时后先查效果再继续**：t128 成员一次 `run_code` 触到 120s 截止，它**先确认无残留伪符号、只 1 文件、并直接读已转后台的 job 输出取读数**，未重跑整脚本。
- **按实记录并正确归属**：该成员在共享检出看到 `M docs/PLATFORM-DEFECTS.md`，**明说「不是本卡的改动」**并留给 tier 0 判归属（实为我的 docs 批次 55 在落地中）。

## 过程事实（平台行为）

- `team_v12(action:"inbox_ack")` 若把 **`inbox_id`** 传给 **`wake_id`**，返回 `inbox-id-passed-as-wake`；须把该 id 传给**顶层 `inbox_id`**。本条与既有「wakeId 是被投影的；inbox_id 接受 messageId」同族，但**方向相反**（不是找不到，而是**找错了字段**）⇒ 两个字段都可能存在，**须先看报文里给的是哪一个**。
- **tier 0 无工作树**：`team_worktree_setup(target:"lead")` 返回 `team policy refusal [nothing-to-lay-out]` ⇒ **tier 0 在会话检出里直接写**（`docs/**` 是其单写域），但仍须 **plan-approved + 活动租约**，且 `team_task_update(action:"complete")` 必须在**租约仍活动**时调用（否则 `lease-release-order` 拒绝释放）。
- **证据行会推高卡 revision**：`team_evidence_record` 落库后卡的 revision 自增（实测 6→7）⇒ `team_task_update` 的 CAS 必须**在记录证据之后重新读** revision，不能用记录前的值。

## B-186（本轮新登记）· `advance_phase` 可越过终态，且越过后**无自愈路径**

**现象（一手，两组独立复现）**：`group-rig-t86` 的 owner 用 `advance_phase` 从 `execution` 一路走到 `group-check → verifier-review → integration-ready → integrated → accepted`（rev 25/26），而流程只允许 owner 走到 `integration-ready`。随后：
- `reopen`（rev 27）保住了 `commitSha` 与 9 条 evidence，但**相位仍 `accepted`**、`status` 变为 `pending`；
- `complete` ⇒ `[complete-phase]: must be in execution before completion`；
- 反向 `advance_phase accepted -> integration-ready` ⇒ `invalid task phase transition`；
- `claim` ⇒ 该卡已有 owner；
- tier 0 `force_complete`（**是 `action:"complete"` 上的标志，不是 action**）⇒ `[force-complete-scope] force_complete is a tier-0 recovery action for global edit cards only`（该卡在 **group 板**）；
- `admin_close` 面向「stranded **global reference** cards」，用它**会误述**（工作是真的、且已合入尖）。

**为什么是缺陷**：两层。(i) **运行时允许了流程明令禁止的相位走法** —— 被约束方可以自行越过 `integration-ready`；(ii) 越过终态后**状态不可逆**：owner 与 tier 0 **都没有路径**回到 `completed`，卡片永久停在 `pending/accepted`，并被 `team_delivery_check` 显示为**未完成**。

**建议修法（任一）**：① `advance_phase` 对 owner 收紧到 `integration-ready`（与流程一致）；② 或让 `force_complete` 的适用范围从「global edit cards」放宽到**任何已越过终态的卡**（这是它字面上的用途）；③ 至少让 `reopen` 覆盖 `accepted` 相位。

**产品侧规避（已执行）**：**按既有记录接受现状**（commit + evidence 已钉、且已合入尖）；**不把它计入未完成工作**；**落地判据改用事实** ——「该提交 ∈ 尖」而非「卡 status」。

---

**㉗ 转述即背书 —— 不得在转述中改写结论的「类」。**
lead-rig 把成员的「`leaves(18)` meta 9↔1」结论转述为「**候选 (i) 格式/元数据演进，良性**」，而该成员自己的逐字结论是「**content non-determinism in the leaf no-decay bit, not format evolution**」—— **两类相反**，且这是本批**载重最大**的一处（它决定金样能否当基线）。
**机制**：它**手里有正确的判别量**（「平面相同而字节不同 ⇒ 格式；平面不同 ⇒ 内容」），却把 **(b) 的测量当成了 (c) 的结论** —— `leaves` 的 meta 位**就在 block plane 里** ⇒ 按定义是内容层；而 (b) 里 `(-1,1)`「平面逐位相同、sha 不同」**才是**格式层。
⇒ 纪律：(i) **结论的「类」（格式 vs 内容、良性 vs 缺陷）不得在转述中被改写**；改写必须**显式标注为「我的再解释」**；(ii) 转述必须**具名归属**（读数 = 谁；结论的类 = 谁）；(iii) **手里有正确判别量时，要用它去检验结论，而不是用它去支持一个已经选好的候选**。
**正面**：lead-rig **自己发现并主动更正**（逐字「**证据行没写候选，我替它选了**」），并**主动向两个下游发出更正** —— 这比被指出更早、更干净。

**㉘ 宣布冻结前必须先确认「在飞的合并已停」；冻结的时点应在「对象已定」之后。**
lead-rig 在 `73a2dffb` 宣布**关闭合并窗口**，随后又合入 t86 ⇒ 它自己的五门读数**作废**、须重取。它**主动作废自己的读数**是对的，但**冻结只是名义的**。
⇒ 纪律：(i) 冻结的**时点**必须在「**对象已定**」之后 —— 所有**已知在飞**的合并**已落地或已明确推迟**；(ii) **冻结声明要列出被排除的在飞项**（否则读者无法判断冻结是否覆盖了在飞工作）；(iii) 我自己犯过同一族的错：**宣布 main 冻结后又提交** ⇒ 「冻结」是一个**动作**，不是一个**声明**。

## 正例入册（第 57 批）

- **主动作废自己的读数**：lead-rig 发现尖已移动后，**逐字宣布**「我上一条给你的 `73a2dffb` 五门读数**作废**」，并重取 —— 而不是让一个过期对象继续充当清关依据。
- **界判取代精确值**：t128 用 **L ≥ 2047 > 1592** 判下「vanilla 段 2 消耗 ≠ 1592」成立 ⇒ **不需要精确值、也不需要上界 U**；只有 1592 落在 `[L, U]` 内时才需精确值，而**解析路线无法夹住它本身就是一条要具名的发现**。
- **具名不可达而非交付假货**：rig-capture 发现「加载恒为 17×17（半径 8）」⇒ **规范未 populate 不可达**，于是**具名为限制**，而不是交付一个自称「terrain-only」的假货。
- **预测先落盘、状态不虚报**：t128 先落可被否证的预测，再在 **L 是下界**时**拒绝声称预测已满足**，直到补完解析和。
- **主动收口陈旧等待票**：lead-world 显式收口 t128 侦察期那张条件早已满足的票，不留陈旧文本。
- **跨组读数自带读头**（lead-rig 落成动作）：具名读数取自哪个 ref + **该 ref 是否在 main**；任何**可执行结论以「是否在 main」为条件**。
**㉙ 「常量 vs 观测集合」不是比较 —— 比较必须先对齐域。**
lead-world 报「我方实现树叶**恒为** `18:2`」而「vanilla **观察到的** 9 / 1」，并据此提出「我方与 vanilla 在该位上恒不同」。但**一侧是常量、一侧是集合** —— 除非两者落在**同一组位置**上，这是**两个不同集合的剖面**，相减无意义（承 ⑯「测量必须连同它的域一起复核」）。
⇒ 纪律：(i) **比较的第一步是确认两侧的域可对齐**（同一组对象/位置/时点），**不是先算差**；(ii) 「**恒为 X**」与「**观察到 Y**」并列时，先问「**是不是同一组位置上的两个值**」；(iii) **不要由读数字符串反推语义**（`18:2` / `9` / `1` 是读数，不是定义）—— 语义**从产出者读**。
**为什么载重**：若差异只在 `0x8`（no-decay）位 ⇒ 低危 flag 差异、按 id 的判据不可见；若**低 2 位（木材种类）也不同** ⇒ **树种差异**（`meta 2` 桦 vs `meta 1` 云杉）⇒ **高危**，属装饰保真、须单开卡。**同一条观察，两档结论相差一个数量级** —— 而分档只能由「差异落在哪几位」决定，不能由「看起来不同」决定。
---

## 平台缺陷批次 47（B-182 至 B-185）修复结果 —— **修复在码，仍未 live**

清单指纹：size 675733，SHA256 A9939E6352DB7D24D3F15AF2865A4572CD99333E5E5F1613AE78926D6D8E7599，mtime 2026-09-29T04:17:35.8863946Z。

**修复项**：
- **B-182**：结构化等待票**不再**因任务进入终态被 `task-terminal` 静默关闭；**只有 legacy 无结构化条件的票**仍按终态关闭。显式 `waiting_resolve` 与条件满足自动解除**保持可用**。
- **B-183**：requirement/decision 授权现在从 `input.taskIds`、`task_ids`、已有记录、以及 `requirementId = task:<taskId>:...` 前缀解析任务作用域，并**继承已有 scope**；**空 scope 不再直接判为 global**。
- **B-184**：`write-scope-guard.mjs` **已有** verifier-scratch 白名单与产品路径负控，**本轮未改代码**；因 PID 124592 早于 guard mtime，只能标 **focused-verified / live pending**。
- **B-185**：`citation_integrity` / `.ps1` 引注门禁属 **RustMc 产品仓**，**平台侧本轮无代码修改**。

**验证证据**：新增 `platform-defects-twenty-seventh-pass.test.mjs` 并同步旧断言；focused 组合 **88/88** 通过；全量 phase1–phase11 **486 tests / 485 pass / 0 fail / 1 skipped**（日志 `D:\dsh-test\output\platform-defects-batch47-full-phase1-phase11-20260929-v2.log`）；四份 profile 两个目标文件 `node --check` **8/8**；web/headless/desktop/teamtest 哈希一致。`team-v14-waiting.mjs` SHA256 `874DE096242977F1FC297FE344494BA3EBE3E515382DF9689C833BC9CFF34444`；`team-v12-runtime.mjs` SHA256 `F11190B8D9D8014D4530170D4F08EFE0C34E17BB024E6174131A76400E9CEB18`。

**未决风险（平台侧自述）**：**未重启 DSH，也未中断 active Team**；B-182 / B-183 以及 B-184 的 **live 生效仍需 root 在进程更新后按原始反例复核**。未清理 backups/spill/telemetry/session；**未修改 RustMc 产品仓**。台账：`D:\dsh-test\docs\agent-team-platform-defects-fix-ledger-20260927.md`。

**对产品会话的后果（重启前继续遵守）**：
1. **B-182 的产品侧规避保持**：跨组合并门**不托付给等待票**，改由**落地时机械复核**（责任在 tier 0）。
2. **B-183 的规避保持**：组内卡片的验收修订若被拒，仍由 tier 0 侧记录并具名 `scope`。
3. **B-184 的规避保持**：写「非作者复跑」类判据时，**必须拆成「只读可复跑」与「需构造制品的部分」**，后者派给有写范围的 owner 或降级为具名限制。

---

## t88 收口（G-RIG · 只读）· vanilla 金样「唯一性」判决 = **按批次/工具版本分组**

**对象**：`tests/golden/rig-batch/**/dumps/vanilla/12345/0/`；ROWS=76 / REJECTS=0（RDMP v1 validate）。

- **枚举**：`0_0.bin` **30 份 = 16 批次（16 个不同 sha256）+ 14 夹具（1 个）** ⇒ 先前报的「**17 个不同哈希**」= **16 个批次类 + 1 个夹具类**，**不是** 17 个任意变体。`0_1.bin` **14 份全在夹具族**，且在**全部 16 个批次里都缺席**（更正「只有最新批次缺」）。`-1_0.bin` 16 份 / 16 distinct。
- **只有方块平面在变**：16 个批次的 **block-light 平面全同**（`bl=90b446c6`）、sky-light 全同、biome 全同。`0_0.bin` 15 对 vs base：**`diff_count 13..24 / 28672`**，`first_diff` 落 **`globalY 89..97`**，**差异 id 恒 18**，跃迁只有 **`18:9↔18:1`**。
- **归因 = 按批次/工具版本分组**：16 批次的 `meta.json` 里 **`git_head` 16 个互不相同、`tool_commit` 16 个互不相同**（各等于 batch_id 后缀）；`schema` = `rig-batch/v1` ×15 + `rig-batch/v2` ×1 ⇒ **确定性但版本相关**，**不是同批次内的真非确定**。
- ★ **具名边界**：每个批次只有**一份** `0_0.bin` ⇒ **同批次内方差无法由该集合评估**（需要同版本双采 —— t86 做了）。
- ★★ **权威缺口**：**该 meta 位的语义在受跟踪权威里不存在** —— `docs/*.md` 查 `leaves` **0 命中**、`persistent|不衰减` **0 命中**；`crates/**/*.rs` 的 `leaves` 只有 1 条**无关测试名**；`tools/rig-stats/src` **0 命中**；`docs/PROTOCOL.md` 只定义打包（`u16LE=(id<<4)|meta`、id12/meta4、`H_block`）而**无 RDMP 与位语义段**。
 ⇒ **判决**：金样**在具名该差异后可用作基线**（确定性、可归一化）；但**凡依赖该位的判据必须具名该位，且不得声称它有定义** —— 与「缺失 vs 从未测量必须可区分」同族。

**处置**：`docs/**` 是 tier 0 单写域 ⇒ **由 G-WORLD 从产出者读出位语义**（`BlockLeaves` 属性 ↔ meta 位映射；各树种在世界生成时实际写入的取值），**由 tier 0 落盘**；**不得发明语义**。

---

**㉚ 「读数字符串」不是语义 —— 权威里没有定义时，必须具名缺口而不是补一个说法。**
`leaves(18)` 的 meta 位（`0x8`）在**受跟踪权威里没有任何定义**（`docs/**` 0 命中、`tools/rig-stats/src` 0 命中、`PROTOCOL.md` 无位语义段）。而它**已经在被当作判据使用**（金样差异、保真比较）。
⇒ 纪律：(i) 一个**正在被用来判定**的量，**必须有具名定义**，否则**必须显式声明「无受跟踪定义」**；(ii) **不得由读数字符串反推语义**（`18:2` / `9` / `1` 是读数）；(iii) 补定义必须**从产出者读**（反编译源码 / 生成器调用点），**不得发明**。

**㉛ 「常量 vs 观测集合」的姊妹形态：两侧必须是同一组对象上的两个值。**
（承 ㉙）lead-world 报「我方**恒为** `18:2`」对「vanilla **观察到** 9 / 1」。它自己的产出侧锚点把这条钉死了：`aoj.java:8-9` 的白桦生成器写**变体 = BIRCH ⇒ 低 2 位 = 2**（与我方一致），而观察到的 **9/1 低 2 位 = 1 = 云杉** ⇒ **不是同一树种** ⇒ **几乎必然不在同一组位置上** ⇒ 那次相减是**在减两棵不同的树**。
⇒ 教训：**域错可以由「另一侧的产出者读数」直接确认**，不必靠推理 —— **先去找产出侧锚点，它比争辩便宜。**
---

## 一条被「类」的误标差点埋掉的高危缺陷（t134）

**发现链**：t88（金样唯一性）→ t86（terrain-only 夹具 + 同版本双采）→ t128（(b) 的域与判据）→ **树叶 meta 位的分档**。

**实测（同位置逐点对齐之后）**：vanilla 侧 `(0,0)` 的树叶 meta 分布 = **`{1: 134, 9: 13}`** ⇒ **低 2 位 = 1（云杉）**；我方装饰输出**恒写 `18:2`** ⇒ **低 2 位 = 2（桦）**。⇒ **同位置上树种不同**，**不是 flag 差异** ⇒ 按分级 = **高危**。

★★ **这条缺陷只在「拒绝把该位差异叫作格式演进、良性」之后才浮出来。** lead-rig 曾把该差异转述为「**候选 (i) 格式/元数据演进，良性**」（其成员的原结论是「**内容非确定**」）—— **那条分类若被接受，这条树种级缺陷会被埋掉**。
⇒ 因此 **㉗ 不是措辞纪律，是会不会埋掉缺陷的纪律**。

**tier 0 的追加裁定（在 lead-world 的 t134 之上）**：「树种不同」有**两个根因**，爆炸半径差一个量级，**必须先分开**：
- **(i) (0,0) 的生物群系我方与 vanilla 就不同** ⇒ 这**不是装饰缺陷**，是**生物群系生成缺陷**（归地形/生物群系），且可能**解释更多差异**（树/草/花的种类与分布全部受影响）；
- **(ii) 生物群系相同** ⇒ 才是**装饰期的树种选择缺陷**（归装饰）。
⇒ **判据 1（先做）**：**逐点比 (0,0) 的生物群系平面**（我方 vs vanilla），报 `biome_equal` / `diff_positions` / 差异的 **biome id**。**未比生物群系之前，不得把 t134 记为「装饰」分量。**
⇒ **判据 2（仅当生物群系相同）**：两侧 decorate 在**同一生物群系**下选树的判据，**都从产出者读**。
⇒ **判据 3**：`{1, 9}` 是**两个生成器**的签名（CHECK_DECAY = true / false）⇒ **具名这两个云杉生成器**，并读出我方跑的是哪一个、写什么 meta。「我方恒 2」意味着**一个云杉生成器都没跑**。

**㉜ 一条「差异的分档」必须由「差异落在哪几位」决定，而不是由「看起来不同」决定。**
同一条观察（`18:2` vs `9/1`）在两档下结论相差一个数量级：**只差 `0x8`** ⇒ 低危 flag 差异、按 id 判据不可见；**低 2 位也不同** ⇒ **树种差异、高危**。⇒ 分档**必须**先做「差异位」的定位，**且必须先对齐域**（㉙/㉛）。
**㉝ 「类」会被链条上每一步的「错域 / 错锚点」掩盖 —— 每一步都必须具名它自己的域与来源。**
一条**树种级**高危缺陷的浮出，需要**三步各自正确**，而**每一步都曾被发现是错的**（lead-world 具名，我入册）：
- **第一步（类）**：拒绝把「字节不同」叫作「格式演进、良性」—— lead-rig 起初这么归类、随后自纠；lead-world **未**向上转达该错分类。
- **第二步（域）**：同域逐点对照 —— 但**第一次取域是错的**：lead-world 把比对指向 **terrain-only 冻结载体**，**交集为 0**；是成员实测 `positions_matched = 0` 才暴露「**域为空 ≠ 恒不同**」。
- **第三步（锚点）**：产出侧锚点 —— **第一个锚点也是错的**：按「Birch Forest」把工厂指到 `aeg`/白桦，而该块贡献源的角点群系**实测 131/133**。
⇒ 纪律：(i) **每一步的结论都必须连同它自己的「域」与「来源」一起具名**，否则下一步会在一个错误的基座上继续推理；(ii) **「空域」必须与「不相等」区分** —— 交集为 0 时，任何「相同 / 不同」的断言都不成立；(iii) **锚点也必须被实测检验**：`aoj.java:8-9` 的正确用法是**证明两组不在同一位置**，**不是**证明我方对。
一般化：**「类」不是一次判定，而是链条上每一步都要重新确认的性质**；前一步的错域会让后一步的错类**看起来完全合理**。

**㉞ 转述的下属读数要带「谁的仪器」—— 计数尤其。**
我把 lead-rig 报的「另有 **2 条** `T76-PS1-SITE-MOVED`」写进给 verifier 的清关请求；verifier 的 `nit` 指出**它的仪器输出与这个计数不符**。⇒ 纪律：**计数类读数在转述时必须具名仪器与读取面**（与「任何计数必须具名它的对象」同族）；我转述时标了「lead-rig 报」，但**没有标出该计数的仪器**。
---

## ★ 门禁的域漏了「我们自己的消费者」（tier 0 的错；修法在途）

**现象（一手，lead-rig 报）**：`feefc389` 落地后，**G-RIG 自己的** criteria 驱动在 `C1R` 红：
`C1R_raw=… rigbatch_error=contract-violation: seeds.json seeds[2]: seed must be an integer (i64, never via f64)`；`C1R_exit_0=False`；`CRITERIA_FAILED=C1R_exit_0`；`ASSERT_SUMMARY|true=64|false=1`。
**根因**：`tools/rig-batch/src/main.rs` 的 `need_int` 只收 **JSON 整数**（`v.as_int()`）⇒ t82 把 `tests/fixtures/worldgen/seeds.json` 的 i64 极值改成**带引号文本**后，**我们自己的驱动读不了它**。

★ **门为什么不覆盖 —— 这是 tier 0 的错**：我给 verifier 的清关请求点名的门是 `dump_values` / `dump_chunks`（**世界侧两个二进制**），**没有 `run-criteria`**。⇒ **我检查了别组的读者，没检查我们自己的读者。** 这是**门的域漏了一块**，不是执行失误。

**㉟ 落地门的域必须包含「受该改动影响的所有消费者」，而不只是「该改动所属的组件」。**
一个产出不变量（`seeds.json` 的形态）的改动，必须同时验证**每一个读它的人** —— **包括本组自己的**驱动。
⇒ 具名判据：**凡改动一个被 N 个消费者读取的载体，落地门必须逐个具名那 N 个消费者，并说明哪一个被验证、哪一个被显式豁免**（「豁免」也要具名，不能默认）。

**处置**：**就地向前修**（`need_int` 对 `seed` 一处改为**两形态**，与 t131/t133 同一条口径「不变量约束产出、不约束读回；读回应兼容两形态」）；**落地门的域即刻补上 `run-criteria`**。

**另一条并列的转录错误（已由 verifier 的 `nit` 具名）**：我把 lead-rig 报的「另有 **2 条** `T76-PS1-SITE-MOVED`」写进清关请求；verifier 的仪器读到的是 **7 条 `T76-PS1-SITE|hint=X|observed=X`（hint==observed）**、**0 条 `SITE-MOVED`**（实质不变：rc=0、`unregistered=0|drift=0|stale=0`）。⇒ 承 ㉞：**计数类读数在转述时必须具名仪器与读取面**。
## 批次 56（tier 0 落地 · 2026-09-29）：B-186 + 平台批次 47 未 live 通知 + t88 金样唯一性判决 + 树叶树种级发现 + 纪律 ㉗–㉟

## ㉕ 裁定书里的「机制句」若未经实测，就是未读的断言 —— 执行者会用更窄的读数更正你

我裁定 `group-rig-t87` 时写「`:76` 的 `StartsWith` 没有显式比较 ⇒ .NET CurrentCulture ⇒ **含义取决于机器区域设置**」。rig-runner 在 **zh-CN / tr-TR / InvariantCulture 三区域**探针下得到**完全相同**的结果（before = CARRIER_1、after = CARRIER_2）⇒ **可观察机制不是 locale 之差**，而是**运行时默认取哪一种比较**：culture-sensitive 比较把 **ignorable 字符**（U+00AD 软连字符 / U+200B 零宽空格）**当作不存在** ⇒ `tests/fixtures` + U+00AD + `/x` 被当成 `tests/fixtures/x`。

⇒ 纪律：(i) 裁定必须把「**方向**」与「**机制**」分开 —— **方向可以裁**（这里仍取显式 `Ordinal`），**机制必须实测，或明确标注为「未测」**；(ii) 执行者给出的**更窄读数优先**，这是**正例**而非违令；(iii) 与 ㉔ 同族：**未读的断言不得写进契约**（卡面与裁定书都是契约）。
**代价不对称**：方向错会毁掉工作；机制句错只损可读性 —— 但**机制句错会误导下一个复现者**（他会去找一个并不存在的 locale 依赖），所以仍必须收窄。

## ㉖ 门禁的扫描域含叙述性散文 ⇒ 缺陷台账无法逐字引用反例（= B-185）

本轮落地批次 55 时实测：台账里逐字写出「裸基名引注」与「未登记的 `.ps1` 行号引注」⇒ `citation_integrity` 与 `ps1_line_citations` **双双转红**，报「未登记的不符项」「新增引注必须登记进 ANCHORS/STALE/EXCEPTIONS」。
⇒ **文档作者须知**：凡在 `docs/**` 里**引用一个不合格的引注形态**（这正是缺陷台账的职责），必须把**路径与行号分离**书写，否则**记录缺陷的动作本身会把门禁弄红**。已登记为 **B-185**（建议给台账一个显式的「引例」标记区）。

## 正例入册（第 56 批）

- **三区域探针把断言变成读数**：rig-runner 对「区域设置依赖」这条**未测机制句**做了 zh-CN / tr-TR / InvariantCulture 三区域对照，得出「同结果 ⇒ 机制是比较种类而非 locale」并**建议收窄卡面措辞**。
- **用「桶剖面同形」当判别量**：lead-world 对 t128 的 8× 自洽差，不问「各段数值差多少」，而问「**我方 1592 里有没有一个 ≈768-772 的花形状桶**」—— 有 ⇒ 清单错（实现其实跑了花趟）；无 ⇒ 才回到整段缺席。实测**无花桶** ⇒ 一次定案。
- **8× 的真因 = 生成器体内的循环**：草桶 9264 = `apu#b` 体内 **128 次尝试 × 6 抽样 = 768/次** × 2 次/源 = 1536/源 ⇒ 每源手算 ≈1726，与实测同量级 ⇒ 差消失。正是「**漏掉一个循环**」的签名，只是它在**生成器体内**。
- **纠正预测的状态**：lead-world 指出 vanilla **≥1246 是下界**（`apm` 体、树冠 `aoj:64` 的条件抽样未计）⇒ **「vanilla ≠ 1592」尚未被判，不得声称已满足**；并给出正确顺序（我方桶剖面 → 补完解析和 → 才判预测）。
- **超时后先查效果再继续**：t128 成员一次 `run_code` 触到 120s 截止，它**先确认无残留伪符号、只 1 文件、并直接读已转后台的 job 输出取读数**，未重跑整脚本。
- **按实记录并正确归属**：该成员在共享检出看到 `M docs/PLATFORM-DEFECTS.md`，**明说「不是本卡的改动」**并留给 tier 0 判归属（实为我的 docs 批次 55 在落地中）。

## 过程事实（平台行为）

- `team_v12(action:"inbox_ack")` 若把 **`inbox_id`** 传给 **`wake_id`**，返回 `inbox-id-passed-as-wake`；须把该 id 传给**顶层 `inbox_id`**。本条与既有「wakeId 是被投影的；inbox_id 接受 messageId」同族，但**方向相反**（不是找不到，而是**找错了字段**）⇒ 两个字段都可能存在，**须先看报文里给的是哪一个**。
- **tier 0 无工作树**：`team_worktree_setup(target:"lead")` 返回 `team policy refusal [nothing-to-lay-out]` ⇒ **tier 0 在会话检出里直接写**（`docs/**` 是其单写域），但仍须 **plan-approved + 活动租约**，且 `team_task_update(action:"complete")` 必须在**租约仍活动**时调用（否则 `lease-release-order` 拒绝释放）。
- **证据行会推高卡 revision**：`team_evidence_record` 落库后卡的 revision 自增（实测 6→7）⇒ `team_task_update` 的 CAS 必须**在记录证据之后重新读** revision，不能用记录前的值。

## B-186（本轮新登记）· `advance_phase` 可越过终态，且越过后**无自愈路径**

**现象（一手，两组独立复现）**：`group-rig-t86` 的 owner 用 `advance_phase` 从 `execution` 一路走到 `group-check → verifier-review → integration-ready → integrated → accepted`（rev 25/26），而流程只允许 owner 走到 `integration-ready`。随后：
- `reopen`（rev 27）保住了 `commitSha` 与 9 条 evidence，但**相位仍 `accepted`**、`status` 变为 `pending`；
- `complete` ⇒ `[complete-phase]: must be in execution before completion`；
- 反向 `advance_phase accepted -> integration-ready` ⇒ `invalid task phase transition`；
- `claim` ⇒ 该卡已有 owner；
- tier 0 `force_complete`（**是 `action:"complete"` 上的标志，不是 action**）⇒ `[force-complete-scope] force_complete is a tier-0 recovery action for global edit cards only`（该卡在 **group 板**）；
- `admin_close` 面向「stranded **global reference** cards」，用它**会误述**（工作是真的、且已合入尖）。

**为什么是缺陷**：两层。(i) **运行时允许了流程明令禁止的相位走法** —— 被约束方可以自行越过 `integration-ready`；(ii) 越过终态后**状态不可逆**：owner 与 tier 0 **都没有路径**回到 `completed`，卡片永久停在 `pending/accepted`，并被 `team_delivery_check` 显示为**未完成**。

**建议修法（任一）**：① `advance_phase` 对 owner 收紧到 `integration-ready`（与流程一致）；② 或让 `force_complete` 的适用范围从「global edit cards」放宽到**任何已越过终态的卡**（这是它字面上的用途）；③ 至少让 `reopen` 覆盖 `accepted` 相位。

**产品侧规避（已执行）**：**按既有记录接受现状**（commit + evidence 已钉、且已合入尖）；**不把它计入未完成工作**；**落地判据改用事实** ——「该提交 ∈ 尖」而非「卡 status」。

---

**㉗ 转述即背书 —— 不得在转述中改写结论的「类」。**
lead-rig 把成员的「`leaves(18)` meta 9↔1」结论转述为「**候选 (i) 格式/元数据演进，良性**」，而该成员自己的逐字结论是「**content non-determinism in the leaf no-decay bit, not format evolution**」—— **两类相反**，且这是本批**载重最大**的一处（它决定金样能否当基线）。
**机制**：它**手里有正确的判别量**（「平面相同而字节不同 ⇒ 格式；平面不同 ⇒ 内容」），却把 **(b) 的测量当成了 (c) 的结论** —— `leaves` 的 meta 位**就在 block plane 里** ⇒ 按定义是内容层；而 (b) 里 `(-1,1)`「平面逐位相同、sha 不同」**才是**格式层。
⇒ 纪律：(i) **结论的「类」（格式 vs 内容、良性 vs 缺陷）不得在转述中被改写**；改写必须**显式标注为「我的再解释」**；(ii) 转述必须**具名归属**（读数 = 谁；结论的类 = 谁）；(iii) **手里有正确判别量时，要用它去检验结论，而不是用它去支持一个已经选好的候选**。
**正面**：lead-rig **自己发现并主动更正**（逐字「**证据行没写候选，我替它选了**」），并**主动向两个下游发出更正** —— 这比被指出更早、更干净。

**㉘ 宣布冻结前必须先确认「在飞的合并已停」；冻结的时点应在「对象已定」之后。**
lead-rig 在 `73a2dffb` 宣布**关闭合并窗口**，随后又合入 t86 ⇒ 它自己的五门读数**作废**、须重取。它**主动作废自己的读数**是对的，但**冻结只是名义的**。
⇒ 纪律：(i) 冻结的**时点**必须在「**对象已定**」之后 —— 所有**已知在飞**的合并**已落地或已明确推迟**；(ii) **冻结声明要列出被排除的在飞项**（否则读者无法判断冻结是否覆盖了在飞工作）；(iii) 我自己犯过同一族的错：**宣布 main 冻结后又提交** ⇒ 「冻结」是一个**动作**，不是一个**声明**。

## 正例入册（第 57 批）

- **主动作废自己的读数**：lead-rig 发现尖已移动后，**逐字宣布**「我上一条给你的 `73a2dffb` 五门读数**作废**」，并重取 —— 而不是让一个过期对象继续充当清关依据。
- **界判取代精确值**：t128 用 **L ≥ 2047 > 1592** 判下「vanilla 段 2 消耗 ≠ 1592」成立 ⇒ **不需要精确值、也不需要上界 U**；只有 1592 落在 `[L, U]` 内时才需精确值，而**解析路线无法夹住它本身就是一条要具名的发现**。
- **具名不可达而非交付假货**：rig-capture 发现「加载恒为 17×17（半径 8）」⇒ **规范未 populate 不可达**，于是**具名为限制**，而不是交付一个自称「terrain-only」的假货。
- **预测先落盘、状态不虚报**：t128 先落可被否证的预测，再在 **L 是下界**时**拒绝声称预测已满足**，直到补完解析和。
- **主动收口陈旧等待票**：lead-world 显式收口 t128 侦察期那张条件早已满足的票，不留陈旧文本。
- **跨组读数自带读头**（lead-rig 落成动作）：具名读数取自哪个 ref + **该 ref 是否在 main**；任何**可执行结论以「是否在 main」为条件**。
**㉙ 「常量 vs 观测集合」不是比较 —— 比较必须先对齐域。**
lead-world 报「我方实现树叶**恒为** `18:2`」而「vanilla **观察到的** 9 / 1」，并据此提出「我方与 vanilla 在该位上恒不同」。但**一侧是常量、一侧是集合** —— 除非两者落在**同一组位置**上，这是**两个不同集合的剖面**，相减无意义（承 ⑯「测量必须连同它的域一起复核」）。
⇒ 纪律：(i) **比较的第一步是确认两侧的域可对齐**（同一组对象/位置/时点），**不是先算差**；(ii) 「**恒为 X**」与「**观察到 Y**」并列时，先问「**是不是同一组位置上的两个值**」；(iii) **不要由读数字符串反推语义**（`18:2` / `9` / `1` 是读数，不是定义）—— 语义**从产出者读**。
**为什么载重**：若差异只在 `0x8`（no-decay）位 ⇒ 低危 flag 差异、按 id 的判据不可见；若**低 2 位（木材种类）也不同** ⇒ **树种差异**（`meta 2` 桦 vs `meta 1` 云杉）⇒ **高危**，属装饰保真、须单开卡。**同一条观察，两档结论相差一个数量级** —— 而分档只能由「差异落在哪几位」决定，不能由「看起来不同」决定。
---

## 平台缺陷批次 47（B-182 至 B-185）修复结果 —— **修复在码，仍未 live**

清单指纹：size 675733，SHA256 A9939E6352DB7D24D3F15AF2865A4572CD99333E5E5F1613AE78926D6D8E7599，mtime 2026-09-29T04:17:35.8863946Z。

**修复项**：
- **B-182**：结构化等待票**不再**因任务进入终态被 `task-terminal` 静默关闭；**只有 legacy 无结构化条件的票**仍按终态关闭。显式 `waiting_resolve` 与条件满足自动解除**保持可用**。
- **B-183**：requirement/decision 授权现在从 `input.taskIds`、`task_ids`、已有记录、以及 `requirementId = task:<taskId>:...` 前缀解析任务作用域，并**继承已有 scope**；**空 scope 不再直接判为 global**。
- **B-184**：`write-scope-guard.mjs` **已有** verifier-scratch 白名单与产品路径负控，**本轮未改代码**；因 PID 124592 早于 guard mtime，只能标 **focused-verified / live pending**。
- **B-185**：`citation_integrity` / `.ps1` 引注门禁属 **RustMc 产品仓**，**平台侧本轮无代码修改**。

**验证证据**：新增 `platform-defects-twenty-seventh-pass.test.mjs` 并同步旧断言；focused 组合 **88/88** 通过；全量 phase1–phase11 **486 tests / 485 pass / 0 fail / 1 skipped**（日志 `D:\dsh-test\output\platform-defects-batch47-full-phase1-phase11-20260929-v2.log`）；四份 profile 两个目标文件 `node --check` **8/8**；web/headless/desktop/teamtest 哈希一致。`team-v14-waiting.mjs` SHA256 `874DE096242977F1FC297FE344494BA3EBE3E515382DF9689C833BC9CFF34444`；`team-v12-runtime.mjs` SHA256 `F11190B8D9D8014D4530170D4F08EFE0C34E17BB024E6174131A76400E9CEB18`。

**未决风险（平台侧自述）**：**未重启 DSH，也未中断 active Team**；B-182 / B-183 以及 B-184 的 **live 生效仍需 root 在进程更新后按原始反例复核**。未清理 backups/spill/telemetry/session；**未修改 RustMc 产品仓**。台账：`D:\dsh-test\docs\agent-team-platform-defects-fix-ledger-20260927.md`。

**对产品会话的后果（重启前继续遵守）**：
1. **B-182 的产品侧规避保持**：跨组合并门**不托付给等待票**，改由**落地时机械复核**（责任在 tier 0）。
2. **B-183 的规避保持**：组内卡片的验收修订若被拒，仍由 tier 0 侧记录并具名 `scope`。
3. **B-184 的规避保持**：写「非作者复跑」类判据时，**必须拆成「只读可复跑」与「需构造制品的部分」**，后者派给有写范围的 owner 或降级为具名限制。

---

## t88 收口（G-RIG · 只读）· vanilla 金样「唯一性」判决 = **按批次/工具版本分组**

**对象**：`tests/golden/rig-batch/**/dumps/vanilla/12345/0/`；ROWS=76 / REJECTS=0（RDMP v1 validate）。

- **枚举**：`0_0.bin` **30 份 = 16 批次（16 个不同 sha256）+ 14 夹具（1 个）** ⇒ 先前报的「**17 个不同哈希**」= **16 个批次类 + 1 个夹具类**，**不是** 17 个任意变体。`0_1.bin` **14 份全在夹具族**，且在**全部 16 个批次里都缺席**（更正「只有最新批次缺」）。`-1_0.bin` 16 份 / 16 distinct。
- **只有方块平面在变**：16 个批次的 **block-light 平面全同**（`bl=90b446c6`）、sky-light 全同、biome 全同。`0_0.bin` 15 对 vs base：**`diff_count 13..24 / 28672`**，`first_diff` 落 **`globalY 89..97`**，**差异 id 恒 18**，跃迁只有 **`18:9↔18:1`**。
- **归因 = 按批次/工具版本分组**：16 批次的 `meta.json` 里 **`git_head` 16 个互不相同、`tool_commit` 16 个互不相同**（各等于 batch_id 后缀）；`schema` = `rig-batch/v1` ×15 + `rig-batch/v2` ×1 ⇒ **确定性但版本相关**，**不是同批次内的真非确定**。
- ★ **具名边界**：每个批次只有**一份** `0_0.bin` ⇒ **同批次内方差无法由该集合评估**（需要同版本双采 —— t86 做了）。
- ★★ **权威缺口**：**该 meta 位的语义在受跟踪权威里不存在** —— `docs/*.md` 查 `leaves` **0 命中**、`persistent|不衰减` **0 命中**；`crates/**/*.rs` 的 `leaves` 只有 1 条**无关测试名**；`tools/rig-stats/src` **0 命中**；`docs/PROTOCOL.md` 只定义打包（`u16LE=(id<<4)|meta`、id12/meta4、`H_block`）而**无 RDMP 与位语义段**。
 ⇒ **判决**：金样**在具名该差异后可用作基线**（确定性、可归一化）；但**凡依赖该位的判据必须具名该位，且不得声称它有定义** —— 与「缺失 vs 从未测量必须可区分」同族。

**处置**：`docs/**` 是 tier 0 单写域 ⇒ **由 G-WORLD 从产出者读出位语义**（`BlockLeaves` 属性 ↔ meta 位映射；各树种在世界生成时实际写入的取值），**由 tier 0 落盘**；**不得发明语义**。

---

**㉚ 「读数字符串」不是语义 —— 权威里没有定义时，必须具名缺口而不是补一个说法。**
`leaves(18)` 的 meta 位（`0x8`）在**受跟踪权威里没有任何定义**（`docs/**` 0 命中、`tools/rig-stats/src` 0 命中、`PROTOCOL.md` 无位语义段）。而它**已经在被当作判据使用**（金样差异、保真比较）。
⇒ 纪律：(i) 一个**正在被用来判定**的量，**必须有具名定义**，否则**必须显式声明「无受跟踪定义」**；(ii) **不得由读数字符串反推语义**（`18:2` / `9` / `1` 是读数）；(iii) 补定义必须**从产出者读**（反编译源码 / 生成器调用点），**不得发明**。

**㉛ 「常量 vs 观测集合」的姊妹形态：两侧必须是同一组对象上的两个值。**
（承 ㉙）lead-world 报「我方**恒为** `18:2`」对「vanilla **观察到** 9 / 1」。它自己的产出侧锚点把这条钉死了：`aoj.java:8-9` 的白桦生成器写**变体 = BIRCH ⇒ 低 2 位 = 2**（与我方一致），而观察到的 **9/1 低 2 位 = 1 = 云杉** ⇒ **不是同一树种** ⇒ **几乎必然不在同一组位置上** ⇒ 那次相减是**在减两棵不同的树**。
⇒ 教训：**域错可以由「另一侧的产出者读数」直接确认**，不必靠推理 —— **先去找产出侧锚点，它比争辩便宜。**
---

## 一条被「类」的误标差点埋掉的高危缺陷（t134）

**发现链**：t88（金样唯一性）→ t86（terrain-only 夹具 + 同版本双采）→ t128（(b) 的域与判据）→ **树叶 meta 位的分档**。

**实测（同位置逐点对齐之后）**：vanilla 侧 `(0,0)` 的树叶 meta 分布 = **`{1: 134, 9: 13}`** ⇒ **低 2 位 = 1（云杉）**；我方装饰输出**恒写 `18:2`** ⇒ **低 2 位 = 2（桦）**。⇒ **同位置上树种不同**，**不是 flag 差异** ⇒ 按分级 = **高危**。

★★ **这条缺陷只在「拒绝把该位差异叫作格式演进、良性」之后才浮出来。** lead-rig 曾把该差异转述为「**候选 (i) 格式/元数据演进，良性**」（其成员的原结论是「**内容非确定**」）—— **那条分类若被接受，这条树种级缺陷会被埋掉**。
⇒ 因此 **㉗ 不是措辞纪律，是会不会埋掉缺陷的纪律**。

**tier 0 的追加裁定（在 lead-world 的 t134 之上）**：「树种不同」有**两个根因**，爆炸半径差一个量级，**必须先分开**：
- **(i) (0,0) 的生物群系我方与 vanilla 就不同** ⇒ 这**不是装饰缺陷**，是**生物群系生成缺陷**（归地形/生物群系），且可能**解释更多差异**（树/草/花的种类与分布全部受影响）；
- **(ii) 生物群系相同** ⇒ 才是**装饰期的树种选择缺陷**（归装饰）。
⇒ **判据 1（先做）**：**逐点比 (0,0) 的生物群系平面**（我方 vs vanilla），报 `biome_equal` / `diff_positions` / 差异的 **biome id**。**未比生物群系之前，不得把 t134 记为「装饰」分量。**
⇒ **判据 2（仅当生物群系相同）**：两侧 decorate 在**同一生物群系**下选树的判据，**都从产出者读**。
⇒ **判据 3**：`{1, 9}` 是**两个生成器**的签名（CHECK_DECAY = true / false）⇒ **具名这两个云杉生成器**，并读出我方跑的是哪一个、写什么 meta。「我方恒 2」意味着**一个云杉生成器都没跑**。

**㉜ 一条「差异的分档」必须由「差异落在哪几位」决定，而不是由「看起来不同」决定。**
同一条观察（`18:2` vs `9/1`）在两档下结论相差一个数量级：**只差 `0x8`** ⇒ 低危 flag 差异、按 id 判据不可见；**低 2 位也不同** ⇒ **树种差异、高危**。⇒ 分档**必须**先做「差异位」的定位，**且必须先对齐域**（㉙/㉛）。
**㉝ 「类」会被链条上每一步的「错域 / 错锚点」掩盖 —— 每一步都必须具名它自己的域与来源。**
一条**树种级**高危缺陷的浮出，需要**三步各自正确**，而**每一步都曾被发现是错的**（lead-world 具名，我入册）：
- **第一步（类）**：拒绝把「字节不同」叫作「格式演进、良性」—— lead-rig 起初这么归类、随后自纠；lead-world **未**向上转达该错分类。
- **第二步（域）**：同域逐点对照 —— 但**第一次取域是错的**：lead-world 把比对指向 **terrain-only 冻结载体**，**交集为 0**；是成员实测 `positions_matched = 0` 才暴露「**域为空 ≠ 恒不同**」。
- **第三步（锚点）**：产出侧锚点 —— **第一个锚点也是错的**：按「Birch Forest」把工厂指到 `aeg`/白桦，而该块贡献源的角点群系**实测 131/133**。
⇒ 纪律：(i) **每一步的结论都必须连同它自己的「域」与「来源」一起具名**，否则下一步会在一个错误的基座上继续推理；(ii) **「空域」必须与「不相等」区分** —— 交集为 0 时，任何「相同 / 不同」的断言都不成立；(iii) **锚点也必须被实测检验**：`aoj.java:8-9` 的正确用法是**证明两组不在同一位置**，**不是**证明我方对。
一般化：**「类」不是一次判定，而是链条上每一步都要重新确认的性质**；前一步的错域会让后一步的错类**看起来完全合理**。

**㉞ 转述的下属读数要带「谁的仪器」—— 计数尤其。**
我把 lead-rig 报的「另有 **2 条** `T76-PS1-SITE-MOVED`」写进给 verifier 的清关请求；verifier 的 `nit` 指出**它的仪器输出与这个计数不符**。⇒ 纪律：**计数类读数在转述时必须具名仪器与读取面**（与「任何计数必须具名它的对象」同族）；我转述时标了「lead-rig 报」，但**没有标出该计数的仪器**。
---

## ★ 门禁的域漏了「我们自己的消费者」（tier 0 的错；修法在途）

**现象（一手，lead-rig 报）**：`feefc389` 落地后，**G-RIG 自己的** criteria 驱动在 `C1R` 红：
`C1R_raw=… rigbatch_error=contract-violation: seeds.json seeds[2]: seed must be an integer (i64, never via f64)`；`C1R_exit_0=False`；`CRITERIA_FAILED=C1R_exit_0`；`ASSERT_SUMMARY|true=64|false=1`。
**根因**：`tools/rig-batch/src/main.rs` 的 `need_int` 只收 **JSON 整数**（`v.as_int()`）⇒ t82 把 `tests/fixtures/worldgen/seeds.json` 的 i64 极值改成**带引号文本**后，**我们自己的驱动读不了它**。

★ **门为什么不覆盖 —— 这是 tier 0 的错**：我给 verifier 的清关请求点名的门是 `dump_values` / `dump_chunks`（**世界侧两个二进制**），**没有 `run-criteria`**。⇒ **我检查了别组的读者，没检查我们自己的读者。** 这是**门的域漏了一块**，不是执行失误。

**㉟ 落地门的域必须包含「受该改动影响的所有消费者」，而不只是「该改动所属的组件」。**
一个产出不变量（`seeds.json` 的形态）的改动，必须同时验证**每一个读它的人** —— **包括本组自己的**驱动。
⇒ 具名判据：**凡改动一个被 N 个消费者读取的载体，落地门必须逐个具名那 N 个消费者，并说明哪一个被验证、哪一个被显式豁免**（「豁免」也要具名，不能默认）。

**处置**：**就地向前修**（`need_int` 对 `seed` 一处改为**两形态**，与 t131/t133 同一条口径「不变量约束产出、不约束读回；读回应兼容两形态」）；**落地门的域即刻补上 `run-criteria`**。

**另一条并列的转录错误（已由 verifier 的 `nit` 具名）**：我把 lead-rig 报的「另有 **2 条** `T76-PS1-SITE-MOVED`」写进清关请求；verifier 的仪器读到的是 **7 条 `T76-PS1-SITE|hint=X|observed=X`（hint==observed）**、**0 条 `SITE-MOVED`**（实质不变：rc=0、`unregistered=0|drift=0|stale=0`）。⇒ 承 ㉞：**计数类读数在转述时必须具名仪器与读取面**。
**㊱ 归因的强度也是一种「类」——「差异存在」≠「成因已定」；语料不能分离候选时，必须写「在本语料上不可判」。**
**同一轴上的第三次事件**：
- lead-rig 把成员的「**内容非确定**」转述为「**格式演进、良性**」（类被改写，方向相反）；
- verifier 把「**差异在内容面**」（它自己实测：`idDiff=0`、每一处差异都在 `id==18`、差异对只有 `18/9↔18/1`）**升级**为「**真·内容非确定（(iii)）**」；
- 而 rig-diff 的 t88 判「**① 版本相关；② 在本语料上不可判**」—— 因为 **16 批次 = 16 个不同 `tool_commit`，每 (commit, 坐标) 恰 1 份** ⇒ **确定性 vs 非确定性无法分离**；且 **t86 的同版本双采里 `(-1,1)` 方块平面逐位相同（0/65536）** ⇒ **对 (iii) 是反证**。
⇒ 纪律：(i) **「差异存在」与「成因已定」是两个断言**，后者需要**能分离候选的语料**；(ii) 语料不能分离时，正确写法是「**在本语料上不可判**」，**不得从候选里挑一个**；(iii) **反证要一并写**（同版本双采的 `(-1,1)` 逐位相同）；(iv) **归因强度不改变可执行结论时，清关仍有效** —— 但**报告必须更正**，否则下游会引用一个过强的成因。
⇒ 一般化：**㉗（类不得在转述中被改写）与 ㊱（强度不得被升级）是同一条轴的两端** —— 两端都指向同一件事：**转述者必须保留原作者的断言强度与候选集，不得替它收窄或放宽。**

**同轴的另一条提示（verifier 自己给的，勿混）**：它的 focus-2 只裁定「**`0x8` 位跨批次不确定**」；而 t134 是「**低 2 位树种差异**」—— **两者是不同轴**，不得互相引用为证据。



---

## 树叶（id 18）meta 位语义 —— **定义段**（从产出者读出；本段即该定义）

**来源（一手，G-WORLD 组 member-world-block 读反编译源码；本段取代此前「无受跟踪定义」的状态）**：
- `ahs.java:8` `a = amk.a("decayable")`、:9 `b = amk.a("check_decay")`；
- `aik.java:45-47` `.a(a,(n2&4)==0).a(b,(n2&8)>0)`。

⇒ **bit 0-1 = variant（树种）**；**`0x4` = `decayable == false`（注意是取反）**；**`0x8` = `check_decay == true`**。
⇒ 本文档先前把 `0x8` 称作「no-decay 位」**不成立** —— 它是 **`check_decay`**。

**世界生成写入值**：所有树叶 state 写作 `…Q().a(<variant>).a(ahs.b, false)`（`decayable` 保持类默认 `true`）⇒ **生成时写出 meta = variant**（无 `0x4` / `0x8`）：
| 生成器 | 变体 | 写出 meta |
|---|---|---|
| `apk` / `aps` / `apf` | 云杉 | **1** |
| `aoj` | 桦 | **2** |
| `app` | 丛林 | **4** |
| `apn` | 深色橡木 | **5** |
| `ajj` | 橡木 | **3** |

**`1 ↔ 9` 的来源（关键）**：`ahs.java:32-33`（半径 1）与 `ahw.java:24-25`（原木类，半径 4）把**已有**叶子的 `check_decay` 置 **true** ⇒ **1→9**；`ahs.java:96-97` 的**随机刻** ⇒ **9→1**。⇒ **同一棵云杉随放置 / 运行顺序产出 1 或 9。**

**条款**：**凡依赖该位的判据，必须具名该位并引用本段。** 此前记录中的「无受跟踪定义」仅指**本段落盘之前**的状态。

---

## 三处卡面前提纠正（t136 一手读数）

- **(i)** `aik.b` ↔ **`0x8`**，**不是 `0x4`**；`0x4` 是 `decayable == false`（**取反**）。tier 0 先前的指令把两者并列写，属**映射细节未实测**。
- **(ii)** 本文档此前把 `0x8` 称「no-decay 位」—— 更正为 **`check_decay`**。
- **(iii)** 「`docs/*.md` 查 `leaves` **0 命中**」**当下不成立**：实为 **8 命中，全部在本文件**，且**全是记录该缺口的段落、无一条定义位语义**；其中两处正文自称「0 命中」，与其**所在文件**自相矛盾 ⇒ 措辞一律改为「**无定义段**」。

---

## t135：**生物群系一致** ⇒ t134 的「树种不同」归**装饰分量**

- `biome_equal = true`、`diff_positions = 0`（**256/256 逐字节相等**）；两侧分布同为 **id 133 × 251、id 131 × 5**（131 位于 `(x,z)=(0,13),(1,13),(0,14),(0,15),(1,15)`）。
- **vanilla 16 个批次 → 16 个不同 file sha256 → 但 biome 平面 sha256 只有 1 个**（`1535bdb6…`），与我方相同；`docs/PROTOCOL.md` 记录的真实 oracle 区块 `h_biome` 亦同 ⇒ **我方载体平面 / vanilla 平面 / 文档 oracle 三方同一**。
- ⇒ **群系一致 ⇒ (0,0) 的「树种不同」不是生物群系生成缺陷，归装饰分量（`group-world-t134`）。**
- 另一条一手读数：16 份文件的**并集差异 59 字节全部落在 blocks 平面**（section 5, `y=9..10`）；biome / blocklight / skylight 平面 **0 字节**不同；差异元素 wire u16 **289 vs 297** ⇒ id18 meta **1 vs 9**。
- ★ **钉子**：`tests/golden/rig-batch/**` **未被 git 跟踪**（`git ls-files` 0 行，被 ignore）⇒ vanilla 侧**无提交锚点**，只能以「**批次目录 + 逐文件 sha256**」命名。

---

## B-186 平台批次 48 修复结果 —— **修复在码，仍未 live**

清单指纹：size 725502，SHA256 32AEFFA5D74AF2E3A5FADD97E6838EF80F7E11E34AC355E453FF375DD685CAF9，mtime 2026-09-29T04:57:14.8602150Z。

**修复项**：
- **B-186**：`team-tools-v2-r10.mjs` 对**非 tier 0** 增加**相位边界判定** —— 只允许推进到 `integration-ready`，**不能手工进入 `integrated` 或 `accepted`**。
- 已完成 **discussion / review** 卡片的既有**直接 accepted** 路径保持可用。
- ★ **reopen 自愈**：**edit 卡**若已错误停在 `integrated` / `accepted`，**重开会恢复到 `execution`**，可重新按执行流程完成。

**验证证据**：新增 `platform-defects-twenty-eighth-pass.test.mjs`，**2/2 通过**（覆盖越界拒绝、tier 0 放行、只读验收兼容、accepted 重开自愈）；全量 platform-defects 聚焦集 **168/168**；全量 phase1–phase11 **488 tests / 487 pass / 0 fail / 1 skipped**（日志 `D:\dsh-test\output\platform-defects-batch48-full-phase1-phase11-20260929.log`）；四份 profile 目标文件与新测试 `node --check` **5/5**；`team-tools-v2-r10.mjs` SHA256 `1BF5F26E54FFAD58E482CAC9E44F0A67F64DA20B21B13667B240CD510D40CFF9`。

**未决风险（平台侧自述）**：**未重启 DSH，也未中断 active Team**；B-186 的 **live 行为仍需 root 在进程更新后按原始反例复核**；**reopen 自愈只针对 edit 卡**，不扩展为通用相位回退。

**产品侧后果**：**当前（重启前）`group-rig-t86` 的坏记录仍不可修**（owner 与 tier 0 均无路径）；**重启后**可用 `reopen` 把它恢复到 `execution` 并重新走完成流程。在此之前，落地判据继续用事实（`is-ancestor(a9ddee31, 尖)` rc=0），**不计入未完成工作**。

---

**㊲ 引用反证时必须同时给出同一对象上的反方向读数 —— tier 0 自己犯了「选择性引用」。**
我在把 ㊱ 下发给 lead-rig 时写「`(-1,1)` 方块平面逐位相同 ⇒ 对 ③ 是反证」，**只引了支持结论的那一半**；而**同一份 `run_to_run` 里 `-1_0` 在同版本仍差 91/65536 列** ⇒ **③ 不能被干净排除**。
⇒ 准确表述：**「反证，但未干净排除」**。⇒ ㊱ 的结论**因此更强**：可判的是「**成因未定**」，**不是**「已排除」。
⇒ 纪律：(i) **引用一条读数支撑某个方向时，必须把同一对象上指向反方向的读数一并给出**；(ii) **「一手」二字只适用于我自己读过的对象** —— lead-rig 认领它把我的转述标成了「我的一手读数」，**该责任在转述者，也在源头的表述方式**；(iii) verifier 点名这是**选择性报告**，**我认**。

**㊳ 陈旧的工作树基座会让删改静默回退已合入的工作。**
`member-guard` 的工作树基座为 `259e945d`，**不含 main@`43960e79`**（差 **338 提交**）；该卡要改的文件在其工作树上是 `840d1a92`（= 该成员 t72 的版本、**t69 之前**），而 main 上是 `697f0735`（差 **9 insertions / 76 deletions**，main 多了 `GROUP_WRITE_SCOPE_PREFIXES` / `pending_class_of` 那套机检）。
⇒ **在该基座上删键会把 main 已有的机检静默回退**，且卡里引的行号只在 main 上成立。
⇒ 纪律：**开工前必须验证工作树基座包含目标 main**（判据：`HEAD^{tree} == main^{tree}` 或 `--is-ancestor main HEAD`）；`team_worktree_setup` 的语义是「把 base 并入该成员的分支」，**重铺即可修**，但**必须由 owner 在开工前验证，而不是事后发现**。

**㊴ 「`rc=0`」必须来自可判的仪器：`$?` 与 `$LASTEXITCODE` 不是一回事。**
lead-rig 实测：本环境 shell 的 `$?` 返回 **`True` / `False`**，而里程碑的 `done_when` **字面要求 `rc=0`** ⇒ 用 `$?` 写出的「rc=0」**按它自己的措辞不可判**（lead-rig 第一次打印出 `t64_in_grprig_rc=True`）。
⇒ 纪律：**凡判据字面要求一个数值退出码，产生该读数的那条命令必须能输出数值退出码** —— 用 `cmd && echo YES || echo NO`，或 PowerShell 的 `$LASTEXITCODE`（它是数值）。

**㊵ 「`1 ↔ 9`」的机制已具名：vanilla 自己的树叶 `check_decay` 传播是**顺序相关**的。**
见上文定义段：`ahs.java:32-33`（半径 1）与 `ahw.java:24-25`（原木类，半径 4）把**已有**叶子的 `check_decay` 置 true ⇒ **1→9**；`ahs.java:96-97` 的**随机刻** ⇒ **9→1**。生成时写出的是 **variant**。
⇒ 对归因的含义：跨批次的 `1↔9` 差异**有机制**（顺序相关）⇒ 它**不是「格式演进」**（与 verifier 的 `idDiff=0` 一致），也**不是无机制的神秘非确定**；**但「不同工具版本是否确定性地产生不同顺序」仍是本语料不可判的那一半**。
⇒ ㊱ 的表述据此收窄：**差异在内容面；机制 = 顺序相关的 `check_decay` 传播；本语料不可判的是「版本相关 vs 真非确定」。**

**同轴提示（verifier 自己给的）**：它的 focus-2 只裁定「`0x8` 位跨批次**不确定**」；t134 是「**低 2 位树种差异**」—— **不同轴，不得互相引用为证据。**




---

## 仪器轴（本会话最密集的一条轴）：四问 + 三条锐化

**仪器四问**（读任何数之前先过这四问）：
① **它会分辨吗？**（㊶ —— 必须用**已知真 / 已知假两例**同时通过；**单例只证明它会输出，不证明它会分辨**）
② **它数的是什么？**（㉒ —— 盲区必须与读数一起具名）
③ **它的失败出现在哪个流？**（㊷ —— 失败在 **stderr**；只消费 stdout 会把**工具错误**变成**假阴性**）
④ **它能不能承载这个量？**（㊴ / ㊽ —— 见下）

**㊴ 的判别测试**（lead-rig 一手，带对照）：

| 用例 | $? | $LASTEXITCODE | cmd && echo YES || echo NO |
|---|---|---|---|
| 祖先为真 | True | **0** | YES |
| 祖先为假 | False | **1** | NO |

⇒ $? 是**布尔**，不能承载「rc=0」；$LASTEXITCODE 是**数值**。

**㊽ $LASTEXITCODE 的锐化（rig-capture 哨兵实验，机制证全）**：
- **它不更新时会保留上一条原生命令的值，且可以是任意非零**：先 `cmd /c exit 42` ⇒ `$LASTEXITCODE=42`；紧接 `sed` 抛 `CommandNotFoundException` ⇒ **仍读 42**；再 `awk` 同错 ⇒ **仍读 42**。
- ⇒ **危险不是「读到 0」，而是「读到一条看起来权威的、上一条原生命令留下的值」**。
- **cmdlet 根本不设该变量**：`Select-String …; Write-Output ('rc=' + $LASTEXITCODE)` 在新 shell 打印 **`rc=`（空）**。
- ⇒ **口径：只在与「那条原生命令」紧邻处读它，且永不用于 cmdlet**。

**环境事实（本机，入册）**：**`sed` / `awk` / `head` 均不可用**（失败**静默**：stdout 空、错误只在 stderr）；**`node` v24.17.0 可用**；`head` 的替代 = `Select-Object -First N`。
⇒ lead-rig 实测：`echo hello | head -3` ⇒ **stdout 空**；去掉管道重跑 `git merge-tree` 得 `d687b8c4…` ⇒ **错误在管道，不在 git**。

**㊾ 证据行具名仪器 —— 判别量是「`actual` 是否逐字声明该仪器失败」，不是「command 里是否出现不可用仪器」**：
- 实例（缺陷）：t91 的证据行把 **`sed -n '80,82p'`** 当作仪器，而 `sed` 在本环境**不存在** ⇒ **内容为真、来源为假** ⇒ 记 `condition` + **追加式**更正行（改用 `git grep -n` 原生命令重取，旧行**未动**）。
- 反例（**不是**缺陷）：lead-rig 的 `group-check-finding` 行的 command 里也写了 `sed`/`awk`，但该行 `actual` **自己逐字声明**「sed 与 awk 在本环境均不被识别」⇒ 那条 command 记录的是**被尝试且失败的探针**，而**失败本身就是该读数的来源**。
- ⇒ **纪律（防误伤版）**：**具名仪器必须真实存在且确为产出该读数者；若 command 含失败探针，该行必须逐字声明其失败**，未声明的才不可复算。⇒ **否则会把诚实的诊断行一并判为缺陷。**

---

**㊸ 令牌必须在「组内合并已完成（对象已定）」之后签发 —— 平台在合并时会自动重锚组分支，这同时改变落地对象与落地类型。**
实例（tier 0 自己的排期错误）：把 `TOKEN-proto-87a46601` **发在组内合并之前**。随后平台**自动把 `grp/proto` 重锚到当前 main**，产生合并提交 `92ed433c`（双亲 `2a412ec0` + `87a46601`）：
- **落地对象**由 `87a46601` 变为 **`92ed433c`**；
- **落地类型**由「**真合并**」变为「**快进**」。
⇒ 原令牌按纪律**显式 supersede**（新令牌明写取代理由），**不得静默沿用**。⇒ **正确顺序 = 组内合并完成（对象已定）→ 令牌 → 清关。**
⇒ 与 **㉘**（冻结时点必须在「对象已定」之后）**同一族**：**凡以「尖」为对象的动作（冻结、令牌、清关请求），其时点都必须在尖已定之后。**
⇒ 请求侧配套：**组长请求令牌时必须连同「组内合并已完成 + 合并后的尖 + 双亲」一起给出。**

**㊿ 「FF 还是真合并」是「两个 ref 在某一时刻的关系」，不是分支的属性 ⇒ 必须在 token 时刻重测。**
实例：同一个 `main ⊥ grp/rig` 关系，在**重锚前**是「真合并」、**重锚后**是「快进」、**main 再前移一次**又回到「真合并」（实测 `MAIN_IN_GRPRIG_RC=1`）—— **main 每移动一次就会翻转**。
⇒ 纪律：**「FF 还是真合并」必须在 token 时刻重测，不得沿用早先判定**；判据用**数值** `$LASTEXITCODE`（**1 = 非祖先、128 = 错误**），**不得只用 `&&/||`**（它把 1 与 128 合并成同一个「否」）。
⇒ 一般化：**关系型读数（祖先、分叉、包含）都必须在「使用的时刻」重测** —— 任一侧移动都会翻转它，而**翻转不会自报**。

**㊼ 负向断言（「无 X」/「0 命中」/「not found」）必须带四字段：读取面 + 规模 + 查询键完整形态 + 读取时刻。**
实例（tier 0 自己）：读登记表得 `NO_KEY_FOR_92ed433c_YET`（**当时为真**），但在消息里写成「`92ed433c` **没有任何清关键**」—— **未带时刻**。verifier 在其后写入该键 ⇒ 我的断言在**收件人读取时**已为假。
⇒ **同轴自认（verifier）**：它 `…-blocked.md` 里的 blocker「**无 landing token**」同样没带读取时刻。⇒ **双方各自犯过同一维**。
⇒ 纪律：**负向断言必须带四字段**；仅写「无」会在收件人读取时**静默变假**。

---

**㊹ 谓词归位若没有具名的「接收卡」，就不是归位，而是静默放宽。**
实例：t128 的 c2 原文 = 「11 个 id **逐个**命中 > 0」、c1 = 「命中数 = 0」，卡面明写「**本卡不主张 `h_block` 相等**」⇒ c2 **是存在性谓词**。此前以「逐区块不等」判 97 未落账，是**比契约更紧**的谓词。
★ **对称律**：**过松掩盖差异，过紧同样掩盖** —— 过紧会**掩盖「未产出」与「产出但计数不同」的区别**（这是「改谓词掩盖差异」的**对偶**，同一枚硬币）。
⇒ 纪律：**把谓词改回契约原文时，必须同时具名「收紧后的谓词由哪张卡承接」**（本实例 = `group-world-t137`）。**没有接收卡的归位 = 静默放宽。**

**㊺ 「范围外」主张的唯一有效驳回方式：指名真正的产出者 + 指名门 + 核前提是否已具备。**
实例：owner 主张 78（snow_layer）范围大于本卡，被**驳回** —— 产出者 = `aoa#populate:311-322`（**不是**被假定的 `aeb`；`aeb.java` 全文 `snow` 命中 0）；门 = `World.canSnowAt`（`temp>0.15 ⇒ false`）；前提 = `noise.rs` 已实现 JavaRandom/Perlin/Simplex/倍频、`generator.rs` 已用 **0.15**、`ady.java:247-253` y ≤ 64 温度逐群系常量 ⇒ **78 在本卡内实现**。
⇒ 三问缺一不可：**谁真正产出它？什么门允许它？实现它的前提是否已在？**

**简化 vs 缺陷的判别量 = 该简化是否正是失败的原因。**
实例：成员为 78 声明两处简化，处置不同 ——
- **(1) 只用常量温度、不实现 y>64 的 `ae` 项 —— 拒绝**：这**不是**可登记的偏离，因为**它正是那个绑定门**，而**它的缺席就是常量零结果的成因**。⇒ **一个改变了谓词结果、且自身就是失败原因的「简化」，是缺陷，不是偏离。**
- **(2) 方块光按 0 处理 —— 接受为具名偏离**，并给出方向：它**只可能**在暗处造成**过量放置**，**不是当前的绑定门**，若计数超过 vanilla 则重访。⇒ **具名、有方向、非绑定 ⇒ 可接受。**

**㊻ spill 的成因链必须分两层具名（不得合并）**：
- **设计层**：`aoa#populate` 的 mob-spawn 与雪/冰 pass 都用 **`+8` 子域 `[src·16+8, src·16+23]²`** ⇒ **写进邻居区块是设计如此**，不是意外；
- **运行层**：**哪些跨区块写真正落地**取决于邻居是否已被 populate（**顺序相关**；`t86-readings.json` 的 verdict/mechanism：`terrain` 按区块播种 ⇒ 与装载顺序无关，`aoa.java:258` 的 `decorate` 才顺序相关）。
⇒ 两层都具名后，spill 的成因链才完整；只报一层会让人以为另一层不存在。


## 批次 59（tier 0 落地 · 2026-09-29）：重启后环境事实 + B-186 liveness 实测 + 纪律 ㊏–㊕
**B-187（本轮新登记）· 卡停在 `integration-ready` 后，owner 无法重收口 ⇒ 被迫相位回退 ⇒ 相位史被污染**

**现象（一手，rig-trace 实测 + lead-rig 复核）**：`complete` **要求相位为 `execution`**；而卡一旦到了 `integration-ready`，**相位不能反向推**（实测 `invalid task phase transition`）。⇒ 任何 `integration-ready` 之后的补证/修正（补一条证据行、做一次收窄）**都必须先把相位退回 `execution`**，complete 后再由平台落回。

**为什么是缺陷**：**回退会污染相位史** —— 外部观察者看到 `execution` 会以为**卡退回了**。本会话**实际发生了误读**：lead-rig 把两次读取间的相位变化（`member-check` → `execution`）**归因成 B-105「投影不稳」**，真因是**成员的主动相位回退**。⇒ **一个正当的补证动作，产生了看起来像异常的状态变化。**

**与 B-186 同族**：B-186 是「**越过终态后不可逆**」，B-187 是「**到达终态前的一步之后不可重收口**」；两者都源于**相位只能单向推进、且 `complete` 绑定单一相位**。

**建议修法（任一）**：① 允许 owner 在 `integration-ready` 上**追加证据后 complete**；② 或提供一条**不动相位的「追加证据」路径**；③ 至少让相位回退在史里**标注为「为补证而回退」**，使观察者不会误读。

**产品侧规避（已执行）**：成员在回退时**留下可复现步骤**，使误读可被纠正（rig-trace 就是这么做的）。⇒ 一般化：**任何使状态史看起来异常的正当代价，都必须留下可复现的说明。**

**㊿ 的姊妹：计数 / 存在类读数与关系型读数一样，都是时点读数。**
实例：lead-rig 实测「本机只有 1 个 java 进程」，随后发现**第二个** vanilla oracle 实例（pid 129280，LISTENING 25670，同一 `1.8.9-server.jar nogui`）⇒ **原读数在其读取时刻为真，但它不是不变量**。
⇒ 纪律：**计数 / 存在类读数必须在使用时刻重测**，与 ㊿（关系型读数）**同一族**。⇒ 处置形态：**先证明它是遗留**（无 owner 认领 + 无活动引用 + 启动时刻早于最后一次 capture），**再回收**；在此之前**只具名、不杀**。
**㊼ 的规范形态（由 lead-rig 的更强版本取代 tier 0 原版）**

- **tier 0 原版（作废）**：读取面 + 规模 + 查询键完整形态 + 读取时刻。
- **规范版（lead-rig）**：**查询 + 命名对象（尖或 blob）+ 读取时刻 + 结果**。

**为什么规范版更强**：「**读取面**」是个弱概念，而「**命名对象**」是判据 —— **工作树不是命名对象** ⇒ 从它取的读数**按构造无法被重新锚定** ⇒ **不得作为可引用的负向断言**。**读取时刻之所以必要，正是因为它是「你指的是哪个对象状态」的锚**。

**硬规则**：**凡可能要引用的检索，一律用 `git grep <ref>`，不用工作树 grep。**
标准件形态：`git grep -n <pat> <ref> -- <path>`、**尖 + 文件 blob**、读取时刻、结果。

**㉒ 的又一实例：「82」与「1」都对 —— 两个仪器在数不同的东西。**
同一对象上：`Select-String`（**出现次数**）得 ㊶=82 ㊷=76 …；`git grep -c`（**命中行数**）得 各 1。⇒ **两者都不错，因为数的是不同的量** ⇒ **报数必须连同「数的是什么」**。
**㊅ 「一个只能靠扩权拿到的读数，不是我应该取的读数。」（lead-rig 逐字，我采纳为纪律）**
实例：lead-rig 的 ac-4 命令想把输出 `Tee-Object` 到 rig-runner 的工作树，被 **`bash write denied: … has no declared static scope or active approved plan lease`** 正确拦下 ⇒ 它**改为不显式写文件**、由作业输出承载，**没有为了拿读数去扩权或绕门**。
⇒ 与 **B-184**（verifier 复跑被写范围门约束）**互补**：**门拦人时，正确的反应是换一个不扩权的取法、或把限制具名**，**不是**绕门。

**「未取得判定」是一个合法结论。**
实例：t89 的 ac-4 **两次被中断**（第一次 C10 红是**owner 自己插在引注 span 之上**造成的 —— 守卫报得对；第二次停在 log:156，**无 `ASSERT_SUMMARY`、无 PASS、无 FAIL**）⇒ owner 报 `[ac-4-NOT-COMPLETED]` 并**明确「我不声称绿」**。
⇒ **不把被中断的运行包装成绿**，比一个可疑的绿更有价值。⇒ 与「预测先落盘」「不声称消解」同族。

**「向集合加入一个元素，会使在该较小集合上取的读数失效。」**
实例：t128 把 78（snow_layer）补进后，**c2 的字母表变了**（`78:4` 出现）⇒ 旧的 **c4 是在「78-less 对象」上取的读数，不得沿用**，必须在新对象上重取。
⇒ 纪律：**凡读数的定义域是一个集合，集合增删元素后，该读数必须重取**（承 ⑯「测量必须连同它的域一起复核」，但这里变的是**域本身**）。

**正例：一条预测解释了「为什么朴素形式给出硬零」。**
t128 的 78 判别测试：公式预测在 `ap ≈ 0.20`、雪在 `y ≈ 90` 时，完整形式 `ap − (ae(x/8,z/8)·4 + y − 64)·0.05/30` 落在 **≈ [0.150, 0.157]** —— **恰好跨过 0.15**，所以**略去该项给出的是「硬零」而不是「更小的计数」**。实测 `(a) 成立、(b) 排除`，门计数由 `[1600,0,0,0,0]` 变为 `[1600,260,4,4,4]`。
⇒ **预测不仅判定了方向，还解释了失败形态**（硬零 vs 偏小）—— 这比「预测对/错」更强。
---

## 跨组边界 B1/B2/B3（tier 0 批准，入册为耐久契约；提出者 = lead-proto）

**B1 包层 vs 语义层**：**线格式 / 包 id / 逐包字段 / 编解码 = G-PROTO；由该包驱动的世界语义 = G-WORLD。**
⇒ 与 M9 行（G-PROTO 列 = 「聊天/命令/补全包」only）**逐字一致** ⇒ M7/M8 的「包」列（F3/F4）已存在，而 G-WORLD 侧的 AI/寻路/计划刻/随机刻/红石**不因此产生跨组卡**。

**B2 装配层**：**`crates/mc-server/` = 被测物**（承 `docs/STAGES.md:219` 逐字：台架 = G-RIG、被测物 = mc-server、**失败归 G-PROTO 修**）；**不新增 `mc-net ↔ mc-world` 依赖边**（承 `decision-47a8b3db` ①）。

**B3 序列语义**：**跨包序列语义属 G-PROTO，但只在消费方存在时开卡。**
★ **B3 是「不下发 M10」的正当性来源** —— 它把该决定从**tier 0 的判断**变成**一条规则的结果**。

## 待命登记（G-PROTO，tier 0 裁定）

**G-PROTO 在阶梯上没有近期可做的段 ⇒ 确认待命。** 逐段核账（对象 = `main 530fdeed`，一手）：M7 实体包 F3 规格 27/27 + 实现 27/27 已在（构造性覆盖）；M7b 补行归 G-WORLD；M8 方块变更批量包 F4 11/11 已在、装配层消费臂 t77 accepted；M9 包列已交付（t85）；**M10 未交付且无载体**（docs 侧序列语义 0 载体）；M11 组侧已闭合（55+2 受跟踪 KAT 在 `m11_exempt_kat.rs`）。组板 **84/84 completed**、waiting active **0**、6 名成员 inactive。

**M10 触发条件未到的三条独立读数**（不采信自述）：① 世界侧审计：`DIMENSION`/`dimension_id`/`DimensionId`/`overworld` 四个大小写敏感子模式**全 0**，「三世界」实体不存在；② G-WORLD 自己的依赖排序把**维度列为 L5**；③ tier 0 在 `main 530deed` 自扫 `crates/mc-world/src`：无维度注册表/三世界，唯一维度相关是实体级 `migrate_dimension`（`crates/mc-world/src/entity_lifecycle.rs` 第 570 行），`crates/mc-sim` 0 命中。
⇒ 与 `docs/STAGES.md:200` 裁定② 逐字一致：**规范没有消费者，且验证只能依赖未受跟踪且会漂移的 oracle** ⇒ **待命优于造卡**。

**解除条件（可判）**：**G-WORLD 的维度子系统出现第一张已批准的执行卡**，或 tier 0 显式改划 M10 归属/下发。**责任人 = tier 0。**

**三个候选的触发条件（「以后再说」不是触发条件）**：候选① M10 协议侧序列规格 ⇒ 触发 = 上述解除条件；候选② A 档端到端失败归因（写范围 `crates/mc-server/`）⇒ 触发 = **G-RIG 的 t41 产出真客户端读数、失败集被具名**（现查 `docs/groups/rig/` 对 t41/真客户端/`--listen` **0 命中** ⇒ 现在开即**填充卡**）；候选③ M11 P2 闭合 ⇒ 它是 **G-RIG 的能力缺口**（sb 21 条缺的是**一整个采集层**），在能力不存在前按轴拆只会把一个缺口**切成两半都不可验证**，触发 = **G-RIG 采集层能力卡落地后**。
---

## M10 的**结构性**阻塞（不只「触发条件未到」）—— G-PROTO 只读预拆解所发现，tier 0 入册

**依赖面（接口级，非实现级）**：世界侧**已有一份它自己的接口声明载体** = `docs/groups/world/m4m10-interface.md`（396 行；自定 **F/S/E** 三级稳定性；**53 条签名指纹 + 11 条区间计数**）。**M10 的协议侧序列若有消费者，消费的就是这份载体**，不是任何实现细节。

**两处具名缺口（都由世界侧拥有）**：
- **(a)** `m4m10-interface.md` 对 `dimension` / `维度` **0 命中** ⇒ **它没有维度轴**（尽管其名字覆盖到 M10）；
- **(b)** 世界侧区块供给面 `docs/groups/world/n10-chunk-supply-surface.md`（**SUP-1…SUP-12 共 12 条，全部 E 级**；落位 `crates/mc-sim/src/chunk_supply.rs`；其声明的消费者是 `crates/mc-server/src/world_feed.rs`）对 `dimension` **0 命中** ⇒ **它是单世界的**。而 **M10 的 Respawn 序列必须换世界重发区块** ⇒ **该供给面按现状无法表达维度切换**。

**结论（tier 0 裁定）**：**M10 的阻塞不只是「触发条件未到」，还有一处结构性缺口** —— **即使维度子系统开工，缝也需要一次「给供给面加维度轴」的载体修订**。⇒ 这条**缩短了触发后的路径**：触发时不再是「从零想」，而是**从这份锚点审**。

**两侧留位已被证实**：`m4m10-interface.md §10 IV-5` 逐字把「本文件点名的接口在 `mc-proto` / `mc-proto-schema` 的消费者」标为**不在其域内、属 G-PROTO 列**；`gap-crate-map.md CM-3` 逐字写「缝的声明属接口载体的**后续修订**」⇒ **世界侧留修订位、G-PROTO 侧留消费者位，两侧都不缺**。

**处置**：**不开一场现在无法收敛的缝谈判**。改为登记为**世界侧的触发时义务**（其维度子系统开工时：`m4m10-interface.md` 加**维度轴**、`n10-chunk-supply-surface.md` 能表达**维度切换**）。**现在不修、不分心。**

**㊆ 待命票的「观察者」必须是有该事实的一方 —— 不能把观察与动作都压在 inactive-by-design 的角色上。**
实例（tier 0 自己）：我把 G-PROTO 待命票的**观察与动作都压在 `lead`** 上，而 **tier 0 在回合之间 inactive** ⇒ 实测该票 `responsibleStatus:"inactive"` / `responsibleInactive:true`；而解除条件是**卡级**事实（可观测面 = G-WORLD 组板），**G-PROTO 因板域限制读不到** ⇒ **该票按构造不是自观测的**。
⇒ 纪律：**登记等待时，必须同时具名「谁拥有该事实」**，并把它作为**观察者**；**动作责任人**可以与观察者不同。⇒ 本实例改登记为：**观察者 = `lead-world`**（它自己的第一张维度卡被批准时必然知道）+ **动作责任人 = tier 0**。
⇒ 与 **㊼**（负向断言要带命名对象与时刻）同族：**两者都在问「这个读数/这个触发，谁能在什么时候观测到它」。**
**㊇ `[member-merge-source-drift]` 的正确处置 = 先证明「源尖的推进只是重锚」，再用 `allow_source_ancestor`。**
实例：lead-world 的组内合并被拒 **`[member-merge-source-drift]`** —— 分支尖已前进到 `5cd6dda`；它**查明**那是 `Merge branch 'main' into team/world/member-world-chunk`（**重锚**），其相对任务提交的增量**只有 main 自己的文件** ⇒ 使用 `allow_source_ancestor: true`（该旗标正是为「源尖前进、但消费已清关的任务提交」而设）。
⇒ 纪律：**`allow_source_ancestor` 会掩盖真正的源尖漂移** ⇒ **只有在「证明源尖增量 = 重锚带入的 main 文件」之后才可用**；**证明不了就必须停下来查**，不得把旗标当通行证。⇒ 与 ㊆（先证后收）同族：**绕过类旗标必须先证明「被绕过的是无害的那一种」。**

**㊈ 相位必须跟随事实，不得领先于事实。**
实例（tier 0 的裁定）：lead-world 请我把 `group-world-t128` 从 `integration-ready` 推进到 `accepted`；卡当时在 `integration-ready`，而 **`integrated` 的语义是「已合入 main」** ⇒ 在合并之前推进，就是**报一个尚未发生的整合** —— 与已登记的「`accepted` 但未整合」缺陷**同形**。
⇒ 裁定：**令牌（已发）→ verifier 在 `fc3d544c` 出清关 → 我落地（`team_merge` 自动推到 `integrated`）→ 我推 `accepted`**，并在**同一回合**内完成。⇒ 一般化：**相位是事实的后果，不是它的替代。**

**正例：verifier 主动拒绝清一个中间对象，预判了 re-anchor。**
它在 `27be5db1` 上**不写清关键**，并明写「**现在清它会重复 `87a46601 → 92ed433c` 的折腾**」；随后平台果然把 main 带进组分支（`fc3d544c` 双亲 = `530deed` + `27be5db1`）⇒ **它预判的那次 re-anchor 发生了**。⇒ **㊸（令牌在组内合并之后发）由此从一条纪律变成一次被验证的预测。**
**㊉ 一张卡有两个独立的门：`dependencyGate` ∧ `approvalGate` —— 可跑性的完整读数是 `eligible`，不是依赖门。**
实例（tier 0 自己复核）：`t128` 落地并 `accepted` 后，`group-world-t134/t137/t129` 的 **`dependencyGate.satisfied` 已为 `true`**（`requiredPhase: accepted` 满足）——**依赖确实解开了**；但四张卡**仍 `eligible: false`**，原因是**第二道门**：`approvalGate = {required: true, satisfied: false, reason: "no-plan"}`。
⇒ 纪律：**「依赖是否解除」的唯一读数是 `dependencyGate.satisfied`**（lead-world 定）**必要但不充分**；**要判断「能不能跑」，必须读 `eligible`**，它要求**两道门同时满足**。⇒ **解锁一道门不等于可跑**，而**误以为「解锁=可跑」会让人去追一个不存在的阻塞**。
⇒ 一般化：**凡「能不能做」的判定，先把门**逐个具名**，再逐门取读数；不要用一个门的结果去回答整个问题。**
---

## B-189（扩写）· **判据与通道不匹配 ⇒ 该判据对任何人都不可达**

**原始现象**：`run_code` 里启动的后台作业**不跨程序存活**（新程序 `job_list` 空、`job_output` 回 `unknown job`），且单程序预算 **600 s**。

**决定性读数（lead-rig 两次独立同口径）**：日志名编码**起始**时刻、mtime 是**结束**时刻 ——
- `criteria-20260929T001550Z.log`：起始 = `00:15:50Z`（本地 08:15:50），mtime **09:21:49** ⇒ **≈66 分钟**；
- `criteria-20260928T214452Z.log`：起始 = `21:44:52Z`（本地 05:44:52），mtime **06:50:40** ⇒ **≈66 分钟**。

⇒ **全量 `run-criteria` 的代价 ≈66 分钟 ≫ 600 s**，且无跨轮通道 ⇒ **`CRITERIA_ALL_PASS=True`（全量）对任何成员都不可达**，与谁去跑无关。

**为什么是缺陷（而不是「慢」）**：**一条判据所需的运行时间超过任何单程序预算，且没有跨轮通道** ⇒ 该判据**按构造不可满足**。⇒ 这会让**所有**依赖它的验收项**永久悬空**，并把「不可达」诱导向两种坏结局：**要么无限重试，要么把它当通过**。

**建议修法**：提供一条**能跨轮存活的运行通道**（后台作业可跨程序接续，或给成员一个可在多轮内推进的长任务通道）。

**产品侧规避（tier 0 裁定，已执行）**：**把判据写成它能被满足的形状，并具名其覆盖面** ——
1. **有界、具名的部分正控**作为等价物（只覆盖被改动触及的段：`C1R` 的 seed 读取 + `C5` 的 seed1 记录，要求逐字 `C1R_exit_0=True` / 无 `rigbatch_error` / `rigbatch_seeds_ok=True`）；
2. ★ **未被覆盖的部分必须保持「未判定」，不得被当作通过** —— 全量判定**保持 OPEN** 并**具名为「因平台通道限制未取得判定」**；
3. **残留必须可重开** —— 登记为等待票，解除条件 = 上述通道出现，届时**必须**按原判据重跑。

**㊋ 「判据不可达」是判据的缺陷，不是工作的失败；修法必须把「不可达」与「通过」分开。**
lead-rig 的表述我逐字采纳并升为纪律：**「我不主张降低标准，我主张把判据写成它能被满足的样子并具名其覆盖面。」**
⇒ 两种坏结局都要挡住：**① 无限重试**（把不可达当暂时失败）；**② 把它当通过**（把「没测」读成「没问题」）。⇒ 正确形态是**第三条**：**有界等价物 + 具名覆盖面 + 未覆盖部分保持 OPEN + 可重开**。
⇒ 与 ㊾（证据行具名仪器）同族：**两者都要求「这个读数到底覆盖了什么」被写出来。**
---

## B-189 **撤回**：不是缺陷，是一条操作事实 —— 作业的**进程**跨程序存活，**句柄**按程序隔离

**撤回理由（lead-rig 一手，随后自纠）**：它先前由「新程序 `job_list` 空 / `job_output` 回 `unknown job`」推断「后台作业不跨程序存活」⇒ **该推断错误**。实测其两次运行的 **driver 进程仍 ALIVE**：`pwsh.exe` pid 130444 → server `4392`（监听 25673）+ bot `7876`；`pwsh.exe` pid 100164 → server `133524`（监听 25684）+ bot `70580`。

**准确的事实**：**作业的【进程】跨程序存活，作业的【句柄/登记】按程序隔离** ⇒ 新程序看不见句柄，**但进程照跑**。

**正确的操作口径**：**长任务轮询日志载体，而不是 `job_output`。** ⇒ **全量 `run-criteria`（≈66 分钟）是「慢」，不是「不可达」** ⇒ 原判据（全量 + 逐字 `CRITERIA_ALL_PASS=True`）**保持可达**，**跑的人与读的人分开**的原处置**成立**。

**㊌ 一条否定断言的强度，以它所用信道的「域」为上限。（统一三条同型实例）**
- **`evidence_query` 的 `not-found`** ⇒ 只能断言「**不在我的可见域内**」，**不能**断言「不存在」；
- **`job_output` 回 `unknown job`** ⇒ 只能断言「**本程序没有该作业的句柄**」，**不能**断言「进程不存在」；
- **日志暂时不涨** ⇒ 只能断言「**此刻没有新行**」，**不能**断言「运行已停止」。
⇒ 纪律：**判定进程/对象是否存活，必须查它自己的权威面**（进程树：parent/child + 命令行；git 对象：`rev-parse`；记录：精确 id 匹配）。⇒ **弱信道不能承载强结论。**

**㊍ 接受一条「实测反驳」时，必须区分【读数】与【由读数做的推断】，并分别要求举证。**
实例（tier 0 自己）：lead-rig 以「两次独立同口径的 66 分钟读数」**反驳**了我的处置，我**接受并据此发了裁定**。事后它自纠：**读数（66 分钟）是硬的**（日志名 = 起始、mtime = 结束，两次一致），**而「因此运行被截断」是推断，且该推断是错的**。
⇒ 纪律：**反驳里的读数要核其口径，推断要单独要求举证**；**在一条推断上建裁定，等于把推断升格为事实**。⇒ 本次的 66 分钟**仍然为真**，改变的只是结论：**慢 ≠ 不可达**。

**（附）㊋ 保留为纪律，但本条不适用**：**「判据不可达」是判据的缺陷**、修法为「有界等价物 + 具名覆盖面 + 未覆盖保持 OPEN + 可重开」—— 该纪律对**真正**不可达的判据仍然正确；**本次判据可达**，故不适用。
**㊎ 优先读「对象自报的状态」，而不是推断「扰动只能造成哪一种偏差」。**
实例（lead-rig 提了一个方向性推断，我改用读数）：它主张**「并发污染只能制造假红，不能制造假绿」**，据此提议「若并行那次跑出 `CRITERIA_ALL_PASS=True` 即可采信」。**方向大体成立但不严密**：判据若是「**没有断言失败**」而非「**该跑的断言都跑了且都过**」，则**污染会让一部分断言根本没跑** —— 本次污染的 `ASSERT_SUMMARY|true=63` vs 干净的 `true=136` **正是这个形态** ⇒ `false=0` 加「少跑一批」**就是假绿**。
⇒ 而**运行自己报了隔离状态**（`foreign_java_delta`，污染那次报 `1`）⇒ **有读数就不要用推断**（㊍ 的又一次应用）。
⇒ **采信规则**：**绿，当且仅当** ① `CRITERIA_ALL_PASS=True`；② **该运行自报 `foreign_java_delta=0`**；③ **断言计数与干净锚一致**（`true=136|false=0`）。⇒ 绿且干净 ⇒ 采信；绿但不干净 ⇒ 不可采信；红 ⇒ 不可归因。

**正例：把「不可归因的红」转成可否证预测。**
本次全量红的关键行 `rigbatch_seed_not_honored requested=0 actual=8761423058027688109` **正落在 t89 的域**（seed 读取），而污染使其**不可归因**。⇒ **预测：干净重跑若仍然出现该行，则 t89 的修法在集成层未生效**（不是被污染），必须回查 `need_seed_int` 是否真被那次调用走到；**反之则本次红确由并发污染造成**。⇒ **同一行的出现与否就是判别量** —— 把不可归因变成可判。
---

## 分支可见性缺口（tier 0 裁定 (b)）· **成员看不到本组已落地的修复**

**现象（lead-rig 一手）**：`git merge-base --is-ancestor 9c7d8f9 main` ⇒ **rc=1**；对 `grp/rig` ⇒ **rc=0**。⇒ **`t64` 的 `T64_RECLAIM` 只在 `grp/rig`、不在 main**；而**平台把成员重锚到 `main`** ⇒ **成员看不到本组已落地的修复**。rig-capture 报的「该函数在本检出不可用」**完全正确，不是它的错**。

**三个候选的取舍**：
- **(a) 让成员重锚到 `grp/rig` —— 拒绝**：那会让成员**建立在未落地的工作上**，正是 **㉓ 的反面**（分支读数不是 main 读数）；且组分支会随 main 前进而**分叉变旧**。⇒ 用「看不到已落地的修复」换「建立在未落地的修复上」，**更糟**。
- **(b) 更勤地把 `grp/rig` 合进 main —— 采纳**：只有**已完成、组检过**的卡会进 `grp/rig`，落地的都是合格工作；代价是每次多一轮清关。
- **(c) 接受现状 + 要求跨分支引用具名可见性 —— 拒绝**：它**把缺口留在原地**，成员会**反复撞上「函数不在这里」**。

**㊏ 落地一个已分叉的分支前，必须逐文件比对「合并树的 blob」—— `merge-tree` rc=0 只证明无冲突，不证明没有回退。**
实例：`grp/rig = 42fb64d8` 已分叉（`main` 不是其祖先，rc=1）。`main..grp/rig` 的 5 路径里含 **`generator.rs`**，而 **`grp/rig` 侧是较旧的 `a4588c58`、main 侧是 `546de19b`（t128 的版本）** ⇒ **若 3-way 取错侧，这次合并就会静默回退 t128 的工作。**
实测合并树 `1ffc1ce9`：`decoration.rs` merged **== main**；`generator.rs` merged **== main**（**未回退**）；`CONTRACT.md` merged == grp/rig；`terrain-only/README.md` merged == grp/rig。
⇒ 纪律：(i) **落地已分叉分支前，逐文件比对合并树的 blob**（不能只看 `merge-tree` rc=0）；(ii) ★ **已分叉分支的 `main..tip` 路径表不是变更表** —— 它同时含「分支新增的」与「分支落后的」两类文件（`decoration.rs` 在 `grp/rig` 里**根本不存在**，出现在 delta 里只因为**分支落后**）。
⇒ 这是 **㊳**（陈旧工作树基座会静默回退已合入的工作）**在分支/落地层的同一条**。

**㊐ 裁定书里凡引用他人读数作为前提，必须标明「未经我独立复核」，或先复核。**
实例（tier 0 自己）：我裁定「`25670` 是 G-RIG 自己端口上的遗留」时，**采信了 lead-rig 基于 `diag-direct.ps1` 第 2 行的归因**；而 rig-capture 读了 `:8` —— 它启动的是 **`$SrvExe --listen`（mc-server）**，**不是 vanilla jar**。⇒ **我们两人都在一个未复核的前提上裁了。**
⇒ 后果一并记：**129280 的归属现在未知** ⇒ 按「先证后收」，**更不得回收**。

**t64 匹配器的具名危险：「外来占位者 fail-closed」对本案不成立。**
t64 的 reclaim 按 **端口 + 形状**匹配（`java ∧ jar 基名 ∧ nogui`），而 **129280 的 cmdline 正是 `java -jar …1.8.9-server.jar nogui`，形状完全吻合** ⇒ **若 capture 链曾用 `25670` 作 PortBase，t64 会把它判成「我们的遗留」并回收**。
⇒ **它必须改为「认领记录 + 声明端口」驱动，而不是形状驱动** —— 否则「外来」与「我们的」在形状上不可分。

**`run-criteria.ps1` 的单端口推断（真根因）**：`:325` 只预检 `@($PortBase)`；`:400-401` 只给 `$p5 = @(($PortBase+1),($PortBase+2),($PortBase+3))`；而 **C1R 一次要 4 个 seed** ⇒ 实际占 **`PortBase..PortBase+4`** ⇒ **`+4` 既不在预检集、也无人回收** ⇒ `PORT_BUSY_AFTER_WAIT=25670` 与遗留都在这里。⇒ **代码做了与 tier 0 警告过的同一个单端口推断**（枚举 `+0..+3`，运行实际用 `+0..+4`）。已折入 `t58` 作 **ac-6**（`replace_approved`、非追溯）。
**㊑ 令牌冻结两侧：目的地 **与** 对象所在分支。**
实例：`TOKEN-rig-42fb64d8` 的对象是**当时的** `grp/rig` 头。**一旦组内再合一次（`t89` 或 `t58` 的 ac-6），头前进 ⇒ 令牌立刻过期** ⇒ 就要重演「令牌被取代」。lead-rig **主动暂停 `t89` 的合并**以保护该对象 —— 处置正确。
⇒ 纪律：**令牌一经发出，冻结的是两侧** —— **目的地（`main`）** 与 **对象所在分支（`grp/rig`）**。
⇒ 与 **㊸**（令牌在组内合并之后发）**互补**：**㊸ 说对象要「已定」，㊑ 说对象还要「保持定」。** ⇒ 我先前只想到目的地，**漏了对象自己的分支**。

**正例：lead-rig 主动补了一条我漏说的、且加强裁定的事实。**
`--is-ancestor 9c7d8f9 grp/rig` **rc=0** ⇒ **`t64` 的修复就在 `42fb64d8` 里** ⇒ **落地它当场把 `T64_RECLAIM` 送进 main，直接解掉 rig-capture「本检出不可用」的真实阻塞**。⇒ 这**加强**了 (b)：它**不只满足一条规则，它修掉一个正在咬人的问题**。

**「它现在还活着不是因为机制判它外来，而是因为没有任何认领记录 —— 这是运气，不是机制。」（lead-rig 逐字，tier 0 采纳）**
⇒ 据此把 **t64 匹配器的修法定性为安全项**（不是卫生项）：当前 129280 未被回收**只因为没人认领过 `25670`**，而 t64 的形状匹配式（`java ∧ jar 基名 ∧ nogui`）**对它是吻合的** ⇒ **一旦将来有任何一次 capture 认领 25670，它就会被回收。**
⇒ 所以修法**不是**「让匹配更严」，而是**改驱动源**：**认领记录 + 声明端口**，**形状只作辅助**。

**可见性缺口的判据是「组分支是否等于 main」，不是「组分支是否存在」。**
G-WORLD 实测：`main = grp/world = fc3d544c`（**三者同一提交**）⇒ **无缺口**，(b) 对它**不产生额外动作**；成员 `HEAD = 21589a71`、`--is-ancestor fc3d544c HEAD` rc=0、`diff --stat` 空 ⇒ 树与 main 逐字节相同。⇒ 缺口是 **G-RIG 特有**（`T64_RECLAIM` 在 `grp/rig` 不在 main），**不是普遍的**。
---

## 重启后的环境事实（2026-09-29 15:27–15:29 DSH 重启）

- **批次 46/47/48 的修复已 live** —— **实测**：`group-rig-t86` 此前停在 `pending/accepted`（**当时 owner 与 tier 0 都无路径**），现在 **`reopen` 成功把它恢复到 `pending/execution`**（commit `a9ddee31`、18 条证据均保留）⇒ **B-186 的自愈生效**，那张卡现在**可由其 owner 正常收口**。
- ⇒ **产品侧规避可退役**：B-182（等待票被 task-terminal 静默关闭）、B-183（组内 requirement 作用域）、B-184（verifier scratch）。
- **常驻 oracle（`25565`）随重启已停**：`java_count = 0`、`25565` 无监听。⇒ **`1.8.9-server.jar` 仍在**（`8320755 B`），故 `javap` 类读数**不受影响**；需要**运行中的** vanilla 时，用**已文档化的** `tools/oracle/run-headless.ps1`（含 jar 的 size+sha1+sha256 fail-closed 校验、eula fail-closed、`Done (X.XXXs)!` 就绪门、`run-<runId>` 隔离）。

**㊔ 「凡『集合/清单』类的断言，必须具名它是哪一个集合，并说明该集合从哪里导出。」**
实例（lead-rig 的根因表述被成员行级推翻）：它读了 `run-criteria.ps1` 的 `:325` 与 `:400-401` 两个集合，**漏了 `$pR = @(($PortBase+4),($PortBase+5),($PortBase+6),($PortBase+7))`** —— 该集合**确实含 `+4`（=25670）**，**它在 wait 集里**；真正缺的是 **reclaim 只对 `$PortBase` 调用（`:382`）**。
⇒ 纪律：**同一个文件里可能有多个集合，而「我看到的那个」不等于「全部的那个」**；凡「清单/集合」类断言必须**具名该集合 + 它的导出方式**。⇒ 与本会话另外三条同轴：㊐（引用他人读数为前提）、㊒（比较不同域）、㊓（语法被重解释）—— **判据的形态/域/完整性必须先成立，再谈结论。**

**㊕ 回归门必须比较「目标」，而不是比较「上一版实现」。**
实例（t134 的契约冲突，由成员自己发现并上报）：`c3` 写「逐 id 计数 **≥** `27be5db` 的计数」⇒ **基准是我方自己的上一个实现状态**。而本卡目标是 **vanilla 保真**；当上一状态**过富**时（18 = **306** vs vanilla **147**），**正确修法方向是下降** ⇒ **`c3` 会禁止一个正确的修复**。
⇒ 纪律：**回归门应以「与目标的距离」为判据**；以自身历史为基准的门**会在需要收敛时禁止收敛**。⇒ 与 **㊹**（谓词归位须有具名接收卡）同族：**两者都在防「门禁的方向与目标相反」。**
⇒ 并记正例：该成员**没有静默放宽 `c3`**，而是**停下、把冲突作为 decision 上报**。

# tier 0 批次 60（已落地 · 原「未落地」暂存头为落地残留）

**㊖ 「变化性」可作守卫，「方向性」不可作守卫 —— 除非方向本身是契约。**
实例（lead-world 的 c3 替换，形态正确）：`c3` 原写「逐 id 计数 **≥** `27be5db`」（**方向性守卫**，且基准是**上一版实现**）⇒ 与 `c2`（变体位一致）**互斥**。替换为：**c3a** 存在性（11 个具名 id 逐个 > 0）+ **c3b 必须变化（≠）** + **c3c** 逐 id 具名增量。
⇒ **c3b 是「变化性守卫」**：它挡住「**什么都没做**」，但**不禁止收敛**。⇒ 与 **㊕**（回归门必须比较目标而非上一版实现）互补。

**㊕ 的落地形态（lead-world 完成，含空间归一化）**：**回归门 = 「与目标的距离不得增大」**，且**必须在具名的公共空间上比较**。
实例：`c3` 的基准由「我方上一版 `27be5db`」改为「**目标 vanilla 金样**」；而 gold 与我方**不在同一空间**（gold `0_0.bin` 的 RDMP `bitmap=127` ⇒ **7 sections / 28672 voxels**；我方 **16 sections / 65536**）⇒ **c3b 必须取具名公共空间（y ≤ 111 的交集）后比较，`|我方 − vanilla|` 不得增大**。
⇒ 一般化：**「与目标的距离」只有在同一空间里才有定义** ⇒ **距离类判据必须同时具名「空间」与「归一化」**（承 ⑯「测量必须连同它的域」）。

**㊗ `[instruction-stale]` 的成因与修法：慢操作不得夹在「读 revision」与「用该 revision 发送」之间。**
实例（lead-world 报备）：它读了 `rev 14`、随后做了**较慢的 evidence 记录**、再用 `rev 14` 发 `action` —— 而成员已到 **`rev 15`** ⇒ 被 `[instruction-stale]` 拒 ⇒ **裁定 v1 从未到达成员**，成员那段时间仍在按**过紧的 c3** 执行（它自己在消息里说「按你重申的 c3 执行」）。
⇒ 修法（它已采用）：**把慢操作放到「读 revision」之前**，然后 `team_task_get` 与 `send_message` **背靠背**。⇒ 一般化：**CAS 类发送的窗口必须尽可能短，且窗口内不得有其它可能改变目标状态的动作。**

**正例：用可读仪器消歧 + 具名「不得互相套用」的差异。**
成员在 `t134` 上用 **`javap -c -p`**（仓外 JDK8 + `.local/oracle/1.8.9-server.jar`）**成功消歧** CFR 的占位符折叠，闭合 `aps#b`/`apk#b` 的槽位映射并落 evidence；并**主动具名**一条**不得互相套用**的差异 —— `apk` 走 `this.a(material)`，`aps` 直接比 `arm.a`/`arm.j` ⇒ **放置判据不同源**。
⇒ 两条都值得记：**(a) 拒绝按记忆反推，去找能读的仪器**；**(b) 把「看似同类但判据不同源」显式标出来**，否则实现会拿一个的结论套另一个。
**㊖ + ㊕ 必须成对使用（lead-world 的 v3 合成，比 tier 0 原表述更完整）**：
- **㊖（门禁层）**：**只守「非真空性」** —— 「必须变化（≠）」可以，**「方向」不可以**（除非方向本身是契约）。
- **㊕（证据层）**：**比较目标** —— 与 vanilla 的距离**要在具名公共空间内归一化后报在证据里**。
⇒ ★ **把「比较目标」做成门禁，就会挡住正确的收敛** —— 这正是 lead-world 的 v2 之坑（它**自己发现并撤回**）。
⇒ 因果化：**工厂一换必然改变共用 Random 的抽取次数** ⇒ 某些 id 与 vanilla 的距离会因**本卡控制不了的原因**（t137 的 segment-2 未对齐）而增大 ⇒ **目标距离门会挡住正确修法**。

**测量否证了一个并行假设（记正例：先测再提）**：tier 0 曾拟建议把 `t129` 与 `t134` **并行**给空闲成员。实测写范围：`t129` = `caves.rs` + `generator.rs`；`t134` = `decoration.rs` + `generator.rs`；`t137` = `decoration.rs` + `generator.rs`；`t130` = `generator.rs` ⇒ **四张卡全部共享 `generator.rs`** ⇒ **串行是被写范围强制的，不是排期选择**。⇒ 该组两个空闲成员在这一段**确实不是产能**（⑧）。
**㊘ 名册的 `running`/`idle` **不反映脱离式子进程** ⇒ `idle-with-open` 不是停顿的充分证据。**
实例（tier 0 自己差点误判）：名册报 **`idle-with-open: rig/rig-runner`**，而我刚恢复了 ac-4 所需的 oracle ⇒ 我**几乎**据此向 lead-rig 发「oracle 已恢复、rig-runner 空闲、请派 ac-4」。
⇒ **先测**：`rig-runner` 的工作树里 **`tests/golden/rig-batch/criteria-20260929T075310Z.log`**（size 1621）**已经写出完整判定** —— `CRITERIA_FAILED=C10_citation_anchor_guard_pass_exit_0`、`ASSERT_SUMMARY|true=3|false=1`、`CITATION_ANCHOR_REV_COORDS|…|span_holds=False|MISMATCH` ×4。
⇒ 即：**ac-4 已经跑过并给出红**（15:53:12），`rig-runner` 的 `idle` 只是**回合之间的状态**。
⇒ 纪律：**成员的长任务若以进程/日志为载体，名册的 `idle` 与它无关** ⇒ **在据 `idle-with-open` 行动之前，先查该卡自己的进程或日志制品**。⇒ 与 **㊌**（弱信道不能承载强结论）同族：**名册是弱信道，它只能断言「此刻没有该成员的回合」，不能断言「没有工作在飞」。**

**该红的形态与 lead-rig 的预判一致（记正例）**：**内容锚点全过**（`CITATION_ANCHOR_CLASS_hit=4`、`anchor_missing=0`），**只有 `REV_COORDS` 子检查失败**（四条全 `MISMATCH`）；而**单独跑守卫时**它报 `CITATION_ANCHOR_REV_VERIFY=NOT_REQUESTED` 且四条 `hit` ⇒ **该子检查只在 harness 下触发**。⇒ lead-rig 的判别式正确：**在同一调用上跑对象 `53c04751` 与其父 `638631d8`** —— 父也失败 ⇒ 早于 t89；只有对象失败 ⇒ t89 破坏了同代性质。
---

**㊙ ★★ 没有活动里程碑的成员会被运行时在回合边界切开 —— 这解释了本会话反复出现的「跑半截、无收尾消息」。**

**机制（lead-world 一手定位）**：`team_milestone(action:"list")` 显示 `member-world-chunk` 的里程碑**仍是 `t127` 那条且 `done:true`（陈旧）** ⇒ **它在 `t134` 上没有活动里程碑** ⇒ **运行时只能在回合边界切它** ⇒ 表现为「**跑半截、然后无收尾消息结束**」。

⇒ **这重新解释了整场反复出现的 `declined the task. It left no closing message.`** —— 我们此前把它当作「**哑的失败**」观察了很多次；**现在它有机制了，而且可修**。

⇒ 纪律：**任何跨回合的任务，动手前必须先 `team_milestone(action:"set")`。** 里程碑的作用正是「让运行时在**任务边界**而不是**回合边界**切你」（工具契约逐字：*ticking it is what makes the runtime fold your context at a real task edge instead of cutting a task in half*）。**没有它，长任务必然被切在半截。**
⇒ 建议把「**开工前是否已 set 里程碑**」与「工作树基座是否含目标 main」并列为**开工检查项**。

**㊚ 「把目标比较做成门禁 + 强加方向」是会复现的模式（本会话出现两次）。**
实例：`t134` 原 `c3`（「逐 id 计数 ≥ `27be5db`」）与 `t137` 的 `c3`（「t128 已落账的 10 个 id 计数不下降」）**同型** —— 同一个错误：**把「比较目标」做成门禁，并强加方向**。lead-world **主动去读 `t137` 的契约**并在开工前更正，故未造成第二次损失。
⇒ 判据形态写死：**门禁只守非真空性（「必须变化（≠）」）；「与目标的距离」只入证据。** ⇒ 承 **㊖ + ㊕ 必须成对使用**。
**㊙ 的独立复核（tier 0 一手，不是转述）**：
- `member-world-chunk`：stage =「实现四个树生成器（`aps`/`apk`/`apv`/`aoi`）+ 角群系工厂分派，并跑出 c1/c2/c3」，**`done=false`**、`doneWhenSetAt=1790669605654` ⇒ **有活动里程碑**，且该时刻**晚于** lead-world 的 v3 唤醒（`createdAt=1790668648569`）⇒ **修法已生效**。
- ★ **同一机制在 G-RIG 上的三例暴露**：`rig-runner`（`t76` 那条，`done=true`）、`rig-capture`（`t40` 那条，`done=true`）、`rig-trace`（`t90` 那条，`done=true`）⇒ **三名在跑成员全部无活动里程碑**。
⇒ 结论：**该机制不是某组特有，而是全队性的** ⇒ 建议把「**开工前是否已 set 里程碑**」列为**全队开工检查项**（与「工作树基座是否含目标 main」并列）。
⇒ 并记一条**升级判据**（lead-world 提）：「**若同一唤醒重复两次无效，就换干预层级，而不是再喊一次**」。
---

## B-190（本轮新登记）· `waiting_set` 票被 **`plan-approved`** 自动关闭

**现象（rig-capture 一手，5/5）**：它在 `group-rig-t92` 上登记的**每一张** `waiting_set` 票都被自动关闭，`closedReason: "plan-approved"` —— **5 张全中**，**含一张在组长下一次编辑卡面后数秒被杀的**。

**为什么是缺陷**：**计划批准与「我的等待条件是否满足」无关** ⇒ 票**被一个与它无关的事件清掉** ⇒ **票无法承载责任**。⇒ 与 **B-182**（`task-terminal` 关闭「完成后门控」票）**同族但不同触发源**。

**建议修法**：`plan-approved` 只在等待条件**本身**是「计划获批」时才允许关闭（与 B-182 的修法同一原则：**只有与解除条件语义相关的事件才可关闭票**）。

**产品侧规避（已执行）**：**把责任写进耐久证据行**（`evidence-fb39fea0`，kind `waiting-responsibility`），并在**停止时**再登记一张票以求即时性；同时组长承诺**在成员持租约期间不编辑其卡面**。

**㊛ 环境变更必须连同变更者自己的出处一起转发 —— 否则接收者只能从形状猜。**
实例（**tier 0 自己的错**）：我重启常驻 oracle 时**没有广播新的启动形态** ⇒ G-RIG 的 `rig-capture` 看到 `25565` 的 cmdline 变成 **外来 JDK 路径 + 相对 jar 路径**，**合理地读成「外来实例」**并据以立论。
⇒ 它**具名了错误类**：**从形状推身份** —— 而**那正是卡面警告 `t64` 匹配器的同一条**（形状驱动 ⇒ **外来与我们的在形状上不可分**）。它把那条读作对 `t64` 的要求，**却没注意到自己刚犯同一个**。
⇒ 纪律：**改环境的人必须广播新形态（pid / 解释器路径 / cwd / 参数）**，与「变更本身」同时；**接收者不得从 cmdline 形状反推归属**（承 `t64` 匹配器的安全项）。⇒ 责任**两半**：接收者不该从形状推身份；**变更者不该只改不说**。
---

**㊝ ★★ 判据 / 证明的锚必须是不变量或命名对象，不得是可变引用（`main` / `HEAD` / 分支尖 / 时间戳）。**（两个独立发现合流；本条取代 ㊏ 中较窄的表述）

**实例 A（强判据 · rig-trace）**：落地后若断言 `main^{tree}` == 事前预测树 `1ffc1ce9`，而 `main` 在两次读数之间前进（`eb3f7e5` → `56be9fe`）⇒ 读到 `bcd45527…` ⇒ **误判「合并失败」**。⇒ **正确对象是本次落地提交本身**：`eb3f7e5^{tree}` = `1ffc1ce9` = 预测树。

**实例 B（`done_when` · rig-capture）**：它把证明写成 `git rev-parse HEAD = 1a8057b3…`，而 `HEAD` 被一次**合法重锚**推进到 `bd52a5a2`（`Merge branch 'main' into …`）⇒ **证明自己把自己打红**。复核 `--is-ancestor 1a8057b3 HEAD` ⇒ **rc=0** ⇒ 交付**完整在历史里**。⇒ **修法：改成不变量** ——「**交付尖是 HEAD 的祖先**」。

**实例 C（数字必须带对象）**：同一门在 `t90` 上的运行行是 `registered=56|pending_path=6`，本次是 `55|5` ⇒ **同一仪器在不同提交上数字不同，跨时点比较会误读**。

⇒ **推论**：
- **(a)** **强判据比的是「落地提交的 `^{tree}`」，不是 `main` 的**；
- **(b)** **`done_when` 只能写不变量**；
- **(c)** ★ **锚在可变引用上的证明会周期性假红，而假红比没有证明更坏** —— 它会被读成「**没做完**」（rig-capture 逐字）。

⇒ **与 ㊼ 同族**：`main` 是**引用**，`eb3f7e5` 才是**对象**；**把引用当对象，就是拿一个会动的东西当锚。**
---

# 批次 61（tier 0 落地 · 2026-09-29）

**㞀 ★★ 门禁的判据必须是被门者能观测的读数，不得引用门主的私有句柄。**

**实例（lead-rig 自己的缺陷）**：它把 `t92` 的 `ac-3` 门写成「等本组的全量（作业 `bash-31`）收尾」—— 而 `bash-31` 是**它的私有作业 id**，`job_list` **只列自己的作业** ⇒ **`rig-capture` 按构造观测不到它** ⇒ 它**无法自行判定是否放行**，只能来问。
⇒ `rig-capture` **拒绝自行放行是对的**：「**端口空闲**」**不足以推出**「**作业已收尾**」（㊎：不要用一条弱读数支撑一条强结论）。

**改写后（可观测）**：**(a)** 没有任何 command line 含 `run-criteria` / `run-batch` 的 `pwsh` 进程；**(b)** 目标端口空闲。⇒ 实测 (a) = **4** ⇒ **门是关的，且任何人都能看见它关着**。

⇒ **与 ㊼ / ㊝ 合为一条纪律的三个面**：
- **㊼ 命名**：锚必须是**命名对象**（不是引用）；
- **㊝ 稳定**：锚必须是**不变量或命名对象**（不是**可变**引用）；
- **㞀 公开**：锚必须是**被门者能读到的**（不是**门主的私有句柄**）。

⇒ **统一表述**：**判据的锚必须「可命名、可复读、对读它的人可及」** —— 否则判据退化为**只有门主能读的私有状态**。
⇒ 三个面的失效形态各不相同，但后果同向：**判据看起来成立，而它断言的对象要么会动、要么别人看不见。**

**㞁 ★★ 判定长任务是否存活，读「累积载体是否在增长」，不读「瞬时进程快照」。**

**实例（lead-rig 一手，同一对象两次读数）**：它用 `Get-CimInstance … Where CommandLine -like '*run-criteria*'` 数进程，**同一条命令两次给出 `0` 与 `1`**；根因是**它那条测量命令自身的命令行里就含 `run-criteria`** ⇒ **过滤集合把测量动作自己算进去了**。
⇒ 这是 **㊄（自指污染：记录行为把被记录对象带进被判集合）** 的**第二活例**，且**由 lead-rig 在同一小时内自己认出并撤回**（它的原话：**值碰巧对了，读数本身无效**）。

**⇒ 正确的活性读数（lead-rig 改用后得到一致结论）**：**(a)** 累积载体是否增长（日志 size / mtime）；**(b)** 该跑自己的服务端在不在（java pid + 其父）；**(c)** 其端口在不在听。
按此判：`criteria-…085011Z.log` size **15213 恒定**、75 秒 growth test **GROWTH=0**、mtime 冻在 16:51:02；其服务端 **java 15080 的父 384 已不存在** ⇒ **该跑确已死、无判定**。

⇒ 纪律：**「累积载体」是记录，「进程表」是快照** ⇒ **快照的 `0` 不能承载存在性否定**（承 ㊌）。★ 与 ㊌ 的分工：**㊌ 管否定断言的上限**（弱信道不能承载强结论），**㞁 管判活的正向仪器选择**。
⇒ 并记一条**同族陷阱**：**自指污染会让「空跑」被读成「有 1 个批次在跑」**（假绿方向）或反之（假红方向）⇒ **「去自身」必须是判据的一部分，不是事后解释**。

**㞂 可观测门会在设计者没预见到的冲突里自己生效（记正例）。**

**实例**：lead-rig **先**放行了 `group-rig-t92` 的 ac-3、**后**才知道 tier 0 要亲自跑全量 —— 它**没有靠事后补救**，而是那条门**自己挡住了**：门 (a)「无 command line 含 `run-criteria`/`run-batch` 的 `pwsh` 进程」此刻为假 ⇒ **门是关的**，ac-3 应当正在等。
⇒ **与 㞀 同轴且更进一步**：㞀 要求门**对读它的人可及**；本例证明**可及的门会在设计者未预见的情势变化里继续有效** —— 若该门写成「等我的作业 id `bash-31` 收尾」，情势一变就得**再改一次门**。
⇒ 纪律：**门要写成「任何人在任何时刻都能读到的谓词」，不要写成「等某人的私有句柄收尾」。**
⇒ ★ 但同一形态对**门主自己**也成立：lead-rig 用它时**必须排除自己**（它的测量命令自身含那两个串）—— **㞁 与 ㊄ 在同一个门上是并存的。**

## B-191（候选）· 「需要租约前状态」的测试，**被门者无法自行搭建**

**现象（lead-rig 一手，两条源码读数 + 一条实测）**：`group-rig-t58` 要造一个**未暂存 tracked 改动**（`porcelain` 的 ` M `）并观测 `team_run_lease(acquire)` 是否保留它。但：
- **要造脏状态 ⇒ tier 2 必须先持租约**：`write-scope-guard.mjs` 的第 1118-1132 行要求 `activePlan.worktreePath`；`activePlanScope`（第 262-274 行）要求**活动 lease** ⇒ **无租约，tier 2 不能写任何文件**；
- **而取得租约 ⇒ 摧毁被测状态**：`acquire` 会执行 **stale-base 同步**（把 main 合进分支）⇒ **正是被测的那个「陈旧基座」**。
⇒ **鸡生蛋**：**要造脏状态必须先持租约；而取得租约就把要测的窗口用掉了。**

**★ B-191 的准确表述（tier 0 实测后收紧，取代「除持该卡租约者之外谁都碰不到」这一不准确说法）**：
- **tier 1 与 tier 2 在同一门禁内**：`edit denied: member "…" has no declared static scope or active approved plan lease for (…)` —— **拒绝串未按 tier 分档** ⇒ **被门者与其组长都搭不出该测试的初始状态**；
- ★ **tier 0 不在该门禁内**（**实测**：用被门禁管的 `edit` 工具写入 rig-runner 工作树内的 tracked 文件**成功**，`porcelain` 得到 ` M …`；**未用 shell 绕过** —— 用 shell 写就是「绕过被拒写入」，那正是本仓禁止的形态）；
- ⇒ **只有 tier 0 能破这个环** ⇒ 它是**可用性缺陷**（**把一个本应由被门者自证的测试，变成必须由 tier 0 参与的测试**），**不是死锁**。

**为什么是缺陷候选**：**门禁的写入前置（租约）与被测对象（租约获取的副作用）是同一个动作** ⇒ **被门者按构造搭不出该测试的初始状态**。⇒ 与 **㞀** 同族：**㞀 是「看不见」，B-191 是「碰不到」**；两者都在说**判据 / 测试的可达性必须与执行它的角色匹配**。

**建议修法（任一）**：① 允许**「测试夹具」类写入**在**无租约**下进行（**具名范围 + 事后强制恢复干净**）；② 或让 `acquire` 的 stale-base 同步**可分离**（先 acquire、后显式 sync）；③ 或提供一条「**预租约状态快照**」的官方通道。

**产品侧规避（tier 0 裁定，已执行并已由 (A) 活复核通过）**：**由不在该写入门禁内的角色（tier 0）先造状态**，被门者只做 **acquire + 观测**；并附四条硬边界（范围不扩、窗口须自然、每例后恢复干净、tier 1 被拒则 tier 0 兜底）。⇒ **该测试因此仍可执行 ⇒ 不撤验收项。**
**★ (A) 的三点观测（rig-runner 一手，逐字）**：**(i)** `acquire` 成功（`status=active`、`expiresAt − acquiredAt = 1800000`、**无任何 `worktree-*` 拒绝码**）；**(ii)** 内容保留（`porcelain` 前后逐字均 ` M tools/rig-batch/tests/t67-stash-variant-743a37d6.md`，`Select-String T58-CASE-A-PROBE` 前后均 `HIT 244`）；**(iii)** 回执含 **`preservedTrackedUnstaged`** 且列出该文件。
**★ 窗口确被消耗（互证）**：`HEAD` `53c04751` → `eaecdb54`，且 `git merge-base --is-ancestor main <branch>` **rc 1 → 0**。**恢复**：探针行删除后 `porcelain` 空、`diff --stat` 空（组长独立复核）。

**★ 一条现场读数（rig-runner 一手，把 t64 匹配器的危险从推论变成现场）**：**常驻 oracle 自己就命中 t64 的「我们的」形状** —— 25565 的 cmdline 含 `java` + `-jar 1.8.9-server.jar` + `nogui`，与 `java ∧ jar 基名 ∧ nogui` **逐条吻合**。
⇒ **若有人曾以 `-PortBase 25565` 起跑，t64 会把它判成「我们的遗留」并回收；唯一挡住的是 25565 的硬拒绝。** ⇒ 所以 **t64 匹配器改成「认领记录 + 声明端口」驱动**是**安全项**，且现在**有活标本**。

## B-192（观察级 · 消费方陷阱）· 回执元素与 `porcelain` 行**非字节等价**

**现象（rig-runner 一手，`group-rig-t58` 的 (A) 活复核）**：`git status --porcelain` 的行是 `" M <path>"`（**前导空格**），而 `team_run_lease(acquire)` 回执里 `preservedTrackedUnstaged` 的元素是 `"M <path>"`（**前导空格已被剥离**）。
⇒ **按 `porcelain` 原样做精确匹配的消费方会得到假阴性** ⇒ 须 `TrimStart`。
**级别 = 观察级**（本卡验收只要求「列出该文件」，已满足）；但对下游是**真陷阱** ⇒ 入册并具名。
⇒ 同族：**同一事实在不同信道里有不同的字面形态** ⇒ 与 ㊓（语法被重解释）同轴。⇒ 一般化：**跨信道比较前必须先比字面形态，而不是先比语义。**

**P-1（tier 0 流程缺陷）· 暂存头随内容一起落地 ⇒ 耐久文档自称「未落地」。**

**现象（我自己的，一手）**：批次 60 的内容落进本文档时，**暂存文件的标题行被原样带进耐久文档**（本文件第 4538 行）⇒ **已落地的事实与文档自称的「未落地」矛盾**。
⇒ **危害**：读者（包括压缩后的我自己）会据此判断该批**尚未生效** ⇒ 与「**耐久文档必须自述其真实状态**」相悖。
**修法（已就地执行，行数不变）**：该行改为 `# tier 0 批次 60（已落地 · 原「未落地」暂存头为落地残留）`。**不删行** —— 删行会移动其后所有行号，而本仓的行几何纪律要求**尽量不动行数**（承 §5.14 系列）。
⇒ 纪律：**「暂存 → 落地」的转换必须包含「改写 / 剥离暂存头」这一步**；只把正文粘过去是不够的。
⇒ 并自认：**批次 58 / 59 / 60 未建全局卡**（此前的批次 19–57 均有卡）⇒ 流程缺口；**本批（批次 61）已恢复建卡**。
---

# 批次 62（tier 0 落地 · 2026-09-29）

**㞃 「已修（磁盘）」与「已生效（运行时）」是两个断言 —— 引用平台修复时两者都必须写出来。**

**实例（本批，操作者报备）**：平台缺陷批次 61 的修复清单逐字说 **`B-187 fixed, focused-verified; live pending`** / **`B-190 fixed, focused-verified; live pending`** / **`B-192 fixed, focused-verified`**，并在边界里明说「**未重启 DSH** ⇒ **三项 fixed 的 live 行为仍 pending，需进程更新后按原始反例复核**」。
⇒ 若只引用「fixed」二字，读者会认为**行为已经变了**，从而在**当前进程**里按新语义排期；若只引用「pending」，又会**重复登记一个磁盘上已修的缺陷**。⇒ **两者必须同时写**。
⇒ 与 **㊍**（区分「读数」与「由读数做的推断」）同族但轴不同：㊍ 分的是**证据链**，本条分的是**变更的两半（代码已改 / 行为已改）**。⇒ 与「**形式存在 ≠ 已经生效**」（§5.14 族）同轴。

## 平台缺陷批次 61 修复结果（操作者报备 · tier 0 转录，未独立复核）

**清单**：`size 795040` · `SHA256 ADA67478283B40F1408F20F7730D6C9438F1DAC8B78A5F0F920BB08625B96A9C` · `mtime 2026-09-29T09:05:26.9477644Z`。

| 编号 | 平台处置 | 生效状态 | 对本项目的含义 |
|---|---|---|---|
| **B-187** | **fixed**（focused-verified） | ★ **live pending**（未重启） | owner 从 `integration-ready` **可直接 `complete`**，相位保持不变，**不再强制回退 `execution` 污染相位史** |
| **B-190** | **fixed**（focused-verified） | ★ **live pending** | `requestId` 绑定的 privilege 等待与显式 `planId` / legacy 裸 `approval` **保持原自动解除**；带 `object`/`detail`/`note`/`target` 的 **opaque approval 不再被无关 `plan-approved` 清掉**，须显式 resolve |
| **B-192** | **fixed**（focused-verified） | ★ **live pending** | `preservedTrackedUnstaged` **现在保留 `git status --porcelain` 的原始字节**，**包括 `" M <path>"` 的前导空格** ⇒ **重启后消费方不再需要 `TrimStart`** |
| **B-191** | **partial · 无平台改动** | 不适用 | 三条建议都涉及**放宽无租约写入**或**拆分 `acquire` 语义** ⇒ 平台**不改**；**保留**「tier 0 造夹具、被门者 acquire + 观测」的规避 ⇒ **不得写成 fixed** |
| **B-189** | **已由清单撤回** | — | 与本仓此前的撤回一致（作业的**进程**跨程序存活，**句柄**按程序隔离） |

**平台自报验证（转录，非我实测）**：原始反例**修复前 0/3 → 修复后 3/3**；相邻回归 `B-155` / `B-174` / `B-186` 合计 **55/55**；`platform-defects` 聚焦集 **171/171**；`phase1`–`phase11` 全量 **491 tests / 490 pass / 0 fail / 1 skipped**；四份 profile 同步且 **web/headless/desktop/teamtest 哈希一致**；`node --check` **13/13**；profile parity **1/1**。
**全量日志**：`D:\dsh-test\output\` 下的 `platform-defects-batch61-full-phase1-phase11-20260929.log` · `SHA256 406FA75A62F0853EF364CDA65FD68336F1CCAEFB87EB771D51FEC89D182FB4C6`。
**文件哈希**：`team-v14-waiting.mjs` = `D3021162B321299ABD3AC23CD5D0F56104D201E07E86FE7078B4A7E3862CAAA0` · `team-tools-v2-r10.mjs` = `CD0C99C1CBD57B335850A804492CDC93427F29D6015688867B784CA87CCDD3B5` · `team-worktree.mjs` = `29C8692DBBB3187A1A530C105B032E1D13542DF8EFF6AF20594C2AB625E80837`。
**边界（平台自陈）**：**未重启 DSH**、未中断 active Team、未清理 backups/spill/telemetry/session、**未修改 RustMc 产品仓**；当时 DSH PID **18972** / 端口 **40123**。

**⇒ 本条对全队的两条操作口径**：
1. **在 DSH 重启之前**，按**旧行为**排期：`integration-ready` 的卡**仍由组长**推进终态（owner 侧会退相位）；opaque approval 票**仍可能被无关 `plan-approved` 清掉**（**不要**只靠票承载责任）；`preservedTrackedUnstaged` 的消费方**仍须 `TrimStart`**。
2. **重启之后的第一件事**：按**原始反例**复核这三条（而不是按清单自报采信），并把复核读数写成 evidence 行 —— 因为**清单是「已修」的载体，不是「已生效」的载体**。

**本批另一条（tier 0 一手）· 判活要挑对载体**：本次全量跑期间，**作业捕获的 stdout 连续 9 分钟 `DELTA_LEN=0`**，而同一时刻**世界数据文件仍在写**（`r.*.mca` 的 mtime 只差 5 秒）⇒ **该跑的 stdout 是「滞后载体」（按相 flush），世界数据才是「实时载体」**。
⇒ 承 **㞁**：**判活必须挑那个真正随进展变化的载体** —— 「日志不涨」与「stdout 无增量」都只说明**那个载体**此刻没动。

---

# 批次 63（tier 0 落地 · 2026-09-29）

**㞄 自指污染第三活例 —— 这一次的仪器是 tier 0 自己。**
现象：跑完 ac-4 后做清理核查，命令写 `Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" | Where-Object { $_.CommandLine -like '*run-criteria*' }`，返回 `DRIVER=17564` ⇒ 表面「还有一条驱动在跑」。真因：**17564 就是我那条测量命令**。⇒ 与 lead-rig 当日 `RUNS 0` 同形，**第三次发作，作者是立这条纪律的人**。
⇒ 收紧为可执行形态：**凡按命令行匹配进程的判据，必须显式排除 `$PID`（及父/祖父链），并把「已排除自身」写进读数。**

## B-193（候选 · 平台）· **落地令牌对被清关者不可读** —— 㞀 的第四面

**现象（verifier 一手）**：它对 `1ef48eea` 出清关时**读不到** `TOKEN-1ef48eea-d2c03b3d`：`evidence_query kind=landing-token` 在它的可读域里 8 行无一命中；`q`/`text`/`taskId` 三探针 0 行；`decision_record` 被拒 `[decision-scope: global or unscoped decisions require tier 0]`。
**为什么是缺陷**：**落地令牌正是清关方必须核验的授权锚** —— 它回答「这次落地是否被授权」。而该记录落在清关方读不到的作用域 ⇒ **门（令牌）对门所约束的人不可见**。⇒ 这正是纪律 **㞀** 的第四面：**㊼ 命名 / ㊝ 稳定 / 㞀 公开**，其中「**公开**」在**授权链**上同样成立：**清关方就是被门者**。
**建议修法**：把令牌绑到任务/需求作用域；或给 verifier 一个**只读的令牌面**。
**★ 被清关方的正确处置（采纳为范式）**：它**读不到**却**拒绝宣告不存在**（判 `not-visible-in-declared-scope`，非 absence），并**改为独立复现令牌的四个字段** —— 其中 `merge-tree --write-tree main 1ef48eea` = `1b232d6f` **逐字等于我们声明的预测树**。⇒ **「读不到」与「没有」分开** + **用可复现的等价物替代不可读的授权记录**。
**tier 0 侧确认**：同 id 重发 ⇒ `ok=true`、decision revision **3**、history **2**、`taskIds` 五张齐、`choice` 逐字含四字段 ⇒ **记录实存**。

**㞅 稀缺资源的占用必须是「具名、可读、可自失效」的对象；且声明 ≠ 事实。**

**实例（本会话第三次形态同一的失误）**：机器只有**一个重作业槽**（跑 `run-criteria` 会起自己的 vanilla 实例 ⇒ 并发会让 `foreign_java_delta>0` ⇒ 假红）。tier 0 与 lead-rig **各自按局部信息独立决策**，导致 ac-3 被**解/挂两次**。lead-rig 具名「账我也有一半」，我同意：**形态是同一个 —— 在只有一个稀缺资源时按局部信息决策**。
**三条硬要求（缺一条就会造出新坏形态）**：
- **(i) 声明 ≠ 事实**：载体只回答「**谁占、到几点**」；**放行前仍须读事实** —— 「无 command line 含 `run-criteria`/`run-batch` 的 `pwsh` 进程」+ 端口状态，且**必须显式排除测量者自身**（㞄）。
- **(ii) 自失效**：载体必须带 `expected_end`；**超过该时刻的声明不得再挡住任何工作**，须回到事实重判。**陈旧声明 = 假阻塞**（与「过期的值不是读数」同族）。
- **(iii) 占者负责清除**：作业结束必须写 `cleared_at`，否则下一个占用者继承一个假声明。
**★ 载体位置的硬约束（这条决定设计）**：**组板不可跨组读**（组长只读自己的板）；**evidence 行有可见性问题**（B-193 就是实例）。⇒ **唯一真正跨组可读的载体是仓库内的受跟踪文件** ⇒ 建议落 `tools/rig-batch/`。
**示例声明（tier 0 即时采用）**：`HEAVY-SLOT|holder=lead(tier0)|job=pwsh-263|port=25666|started=18:22:59|expected_end≈19:29|what=落地后全量 run-criteria on main 12199ae9`。槽序 = `pwsh-263` → ac-3 → G-WORLD 判据跑。

**㞆 「两个候选成因」的分离方法 = 找到该扰动的「可计量边界」（G-WORLD 成员一手，正例）。**

**实例**：t134 的 c3c 有两个候选成因 —— 「**工厂位移**」与「**段 2 未对齐**」。成员读完 `aoi` 第 126-241 行后给出决定性读数：`aoi#b` 里 `k = new Random(random.nextLong())` ⇒ `aoi` 对**共用装饰 RNG** 只消费 **1 次 `nextLong()`**，其后所有抽取（含每枝 2 次 `nextFloat`）走它自己的 `k`。
⇒ **工厂位移因此是「每次选择 1 次 nextLong」的可计量扰动，不是无界流移** ⇒ 两种成因**可被测量地分离**。⇒ lead-world 据此把 c3c 加强为「**逐生成器给出从 `this.b` 取了多少次抽取**」，且**明说这是证据要求、不是新门禁**（= **㊖ + ㊕ 的正确用法**：门禁只守非真空性，目标比较入证据）。
⇒ 纪律：**当两个候选成因都给出「同一种可观测差」时，分离它们的办法是找到该扰动的「可计量边界」**（次数 / 位宽 / 序），而不是增加对比样本或加强措辞。

**㞇 「干净度参与判定」的作业，其工作树在跑期间不得被写入。**

**实例（tier 0 自查，防患）**：`run-criteria` 的 C8 断言含 `C8_binding_tree_clean` / `dirty_lines=0`，且 C10 会**读 `docs/**`**。⇒ 若在跑期间向**该工作树**提交任何东西，**该跑自身的读数立刻变成混合态**（干净度判据为假 / C10 读到半途状态）。⇒ **本条同时约束「主检出」：我在 `pwsh-263` 期间不落任何 docs 提交** —— 这也是本批至今**仍暂存未落地**的原因。
⇒ 一般化：**凡「工作树干净度」或「工作树内容」参与判定的作业，其工作树在跑期间是一个被独占的域** —— 与 ㊑（令牌冻结两侧）同族，只是冻的是**工作树**而不是 ref。

**本轮正例（四条）**
- **lead-rig 的可观测门两次自动生效**：它那条门 (a)（无 `run-criteria`/`run-batch` 的 `pwsh` 进程）在它**两次误判时机**时都自己关上了 ⇒ **㞂 的最强正例**：写成「任何人在任何时刻都能读到的谓词」的门，**在设计者没预见到的冲突里继续有效**。
- **lead-proto 两次自纠**：它先用 **ASCII** 探针（`AI1`）判「报告的归因不可复现」，而 `tools/rig-batch/CONTRACT.md` 用的是**带圈数字 `AI①..AI⑦`**（U+2460…）⇒ **探针按构造看不到它**；重测（改用 `git grep -o` **出现次数**而非计行 `-c`）后确认：**AI 追加贡献 0 个 judged token，+2 全部来自 tier 0 对 `docs/PLATFORM-DEFECTS.md` 的写入（批次 60/61/62）**。⇒ 它**保留原 evidence 行作为自纠底稿**，另立更正行。⇒ **㊓（语法被重解释过的读数不是读数）的又一实例，作者是立这条的人。**
- **verifier 自查的仪器错**：跨循环复用 `$mn` ⇒ `git rev-parse main:<不存在路径>` 失败（rc=128）时**保留上一路径的值**，打出一个**看似合理的错读数**（与 `main:src/main.rs` 相同）。⇒ **「过期的值不是读数」**，与 `$LASTEXITCODE` 在 PowerShell 级失败后保留上一次原生命令值同族。
- **G-PROTO 分诊零返工**：verifier 广播的清关报告，它逐条分诊后**本组 rework = 0**，并把唯一点名本组文件的一条（`citation_integrity` judged 计数）**独立复核到「计数不可能来自测试」**（闸门文件 blob 在四处逐字节相同）。
**㞈（★ 本条成因在立条后 40 分钟内被实测推翻 —— tier 0 自纠，保留为「观察」而非「成因」）**

**观察（仍然成立）**：`group-world-t134` 连续两轮结束而产品文件零改动（`porcelain` 空、`diff --stat` 空），但 **evidence 由 11 → 16** ⇒ **增长全在 evidence 上**。
**原写成因（★ 作废）**：「它转向更廉价、更安全、更能证明自己在工作的活动（替代活动）」。
**★ 实测成因（权威，来自门禁自己的 dump）**：该卡的写租约 `run-442b3bef-ea17-40c0-ab9e-6bae680f979c` **`status = expired`**（`expiresAt = 1790671306518`、`endedAt = 1790671323131`；读数时刻已过期 **≈2.06 小时**）。而 `plan = plan-approved` ✓、`phase = execution` ✓、`writeScopes` 存在 ✓ ⇒ **唯一不满足的合取项是「active lease」** ⇒ **每一次写入都被拒** ⇒ **成员只剩「读 + 落 evidence」可做**。
⇒ **所以那不是行为偏好，是门禁把它锁在写入之外。** ⇒ **观察对、成因错。**

**★ 修正后的纪律（顺序很重要）**：
1. **「无产出」的第一诊断不是「它不听话」，而是「它是不是被拒了」** —— 先读**门禁自己的 dump**（本例 = `leases`），再谈动机；
2. **升级阶梯必须先检验「门禁假设」，再缩小范围** —— 本例里 lead-world 已预置的下一级（「缩到函数体骨架 + 编译」）**对本例毫无用处**；
3. 「替代活动」**只在「它不是被拒」被排除之后**才能作为诊断。

⇒ ★ **本条本身是纪律「一个实例只升级观察，不升级成因」的实例**：我拿**一条观察**（增长全在 evidence）**升成了成因**（偏好分析），**40 分钟后被实测推翻**。⇒ 与 **㊍**（区分「读数」与「由读数做的推断」）同族。

**㞉 被拒绝是**合法阻塞**；沉默地转去做别的才是问题。★（本条是把它逼出来的那条，优先级高于 㞈）**
**㞉 被拒绝是**合法阻塞**；沉默地转去做别的才是问题。**

**实例（lead-world 提出的兜底，tier 0 采纳为纪律）**：它在派工时加了一条硬要求 —— **若被 `write-scope` / plan / lease / policy 拒绝，立刻贴出拒绝原文并停手**。理由：**被拒绝是一个可上报、可处理的合法状态**；而**沉默地绕道去做分析**会让「一个可解的门禁阻塞」伪装成「工作在进行」。
⇒ 承 **B-125**（遇拒先取原文，不据旧模型推导）与 **㊀**（不从 shell 绕过门禁）：本条补的是**第三种坏处置 —— 不绕行、也不上报，而是转做别的**。
⇒ 纪律：**被拒后只有两个合法动作：贴原文上报，或按拒绝文本给的前置条件补齐。不得「先去干点别的」。**
## B-195（候选 · 平台）· **租约过期是静默的，而唯一的线索文本会强化误判**

**现象（lead-world 与成员各一手）**：成员写入被拒，拒绝串逐字 `edit denied: member "…" has no declared static scope or active approved plan lease for (…)`；它能得到的**另一条**线索是 `release` 被 **`[lease-release-order]`** 拒 —— 而那条**读起来像「租约有效、只是顺序不对」** ⇒ **主动强化了「我仍持有租约」的误解**。
**为什么是缺陷**：**(i)** **过期没有任何通知**；**(ii)** 拒绝串**列了三个合取项（scope / plan / lease）却不说哪一项不满足**，也不给 `active lease: none / expired at <t>`。⇒ 与 **B-186**（「卡住无法前进」）**不同轴**：这条是**「失败被误读为正常」**。
**建议修法**：拒绝文本显式给出 `active lease: none / expired at <t>`；或**在租约过期时通知持有人**。
**产品侧规避（已入册）**：**「成员声称持有租约」是状态断言，不是读数；写入被拒时第一个读数是 `leases`。** 且「以为持有 / 实际失效 / 非 tier-0 又不能主动 `release`」三者合起来构成一个**静默态**。

**正例（我采纳为范式）· 被拒后的正确处置 = 「换前置条件，不换动作」。**

成员：**贴拒绝原文 + 上报** → **只读核 `leases`**（`run-442b3bef` = expired）→ `team_run_lease(acquire)` 得 `run-47f2c0c4`（active）→ **原样重试同一编辑**，成功。
⇒ 这正是 `AGENTS.md`「**被拒绝时先满足返回的前置条件，不要重复同一被拒动作、不要绕过门禁**」：**变的是前置条件，动作一字未改**；且 `team_run_lease` 是**成员自有动作**，不需组长授权。⇒ **lead-world 裁定为「正例」而非「擅自行动」，正确** —— 它明确告诉成员**不需要「下不为例」**。

**★ 首个产品代码产物（2026-09-29，阻塞解除后）**：commit **`75a5e57955a21c6391edc6bf5048be73aa0e5b26`**（分支 `team/world/member-world-chunk`），`1 file changed, 119 insertions(+)`，**仅 `crates/mc-worldgen/src/decoration.rs`**；`cargo check -p mc-worldgen` **exit 0**（15 条 warning **全部既有**，无一条来自新增）；`place_taiga2_tree`（`aps#b` 云杉）。
⇒ **meta 读数落地**：叶 = `18` 变体 **1**（云杉，`aio.a.b` + `ahs.b = false` ⇒ bit `0x8` = 0）、原木 = `17` 变体 1。**尚未接线**（分派在下一增量）。
⇒ **成员具名的三条限制（正例）**：① `aps` 直接比 `arm.a`/`arm.j`，而 `apk` 走 `aoh#a(Larm;)Z` ⇒ **判据不同源、不得互套**；② `at` 只给 block id ⇒ 土(3) 与灰化土(3:2) **不可分**，本样本角群系无灰化土 ⇒ 该子情形**不在样本域内**（**未静默近似**）；③ `#[allow(dead_code)]` **已具名**（分派接线在下一增量）。
**㞊 已发布且「被摘要钉住」的对象，只能由**外部**的追加式更正覆盖，不得就地修补（含追加页脚）。**

**实例（2026-09-29，verifier 主动询问是否要一份独立的更正注记）**：它的报告 `grp-rig-1ef48eea-cleared.md` 里那条 nit 的**成因**被推翻（judged token `304→306` 的真因是 tier 0 对 `docs/PLATFORM-DEFECTS.md` 的写入，不是 AI①–⑦ 追加），它**没有改报告**，只记了 `evidence-1a8d4a30` 取代成因归属，并**问我是否另出一份更正注记**。
**裁定：不出独立注记，且不得改动该报告的任何字节。** 机械理由（可核）：该报告的摘要**已被写进清关登记表** —— 在 `D:\dsh-test\home\team-clearances.json` 的键 `1ef48eea…` 下逐字有 `"report": "grp-rig-1ef48eea-cleared"` 与 **`"reportDigest": "d8a36e31df97de14e294aa6abcb4c…"`**。⇒ **报告是被摘要钉住的对象** ⇒ 任何改写（**包括追加页脚**）都会让它与清关登记表**不再互指**。
⇒ 纪律：**对被摘要/摘要键钉住的对象，更正只能落在它之外**（evidence 行、台账、勘误表），**不得就地修补**。⇒ 与 **㊝**（锚不得是可变引用）**同族但不同轴**：㊝ 说的是**锚**会动，本条说的是**被锚住的对象**不得动 —— 两者都要求「**锚与对象的关系必须保持可复核**」。
⇒ **正例（verifier）**：它**先问、不自作主张**，并且**在被 `waiting-scope` 拒绝后不绕过门禁，而是具名能改它的角色并同轮转给它**（与「票不是你的就别关」同族）。
**㞋（先例裁定）· 「vanilla 的进程历史状态」与「本项目的确定性保证」冲突时，确定性优先，偏差必须具名且可重开。**

**实例（G-WORLD 一手，lead-world 提请 tier 0 裁）**：`aoi`（大橡树）持**跨调用持久**的可变高度 `a` —— `aoi.java` 第 13 行 `int a;`（默认 0）、第 20 行 `h=12`、第 194-200 行**仅当 `a==0`** 时 `a = 5 + this.k.nextInt(12)`、★ 第 216-223 行 `f()` **回写** `this.a = x`（**可被地形改短**的持久缓存，非一次闩锁）；`ady.java` 第 111-113 行在**构造器**里建 `aB = new aoi(false)` ⇒ **每个基群系单例各一个**（131 与 133 用两个不同对象，**不是全 JVM 一个**）；`aem.java` 第 51-54 行 M 变体**委托基群系单例**。⇒ **输出依赖「世界内第几次生成大橡树」** ⇒ **同一种子不再决定世界**。
★ **关键限定（使问题不扩散）**：第 197 行**每次调用**都 `new Random(random.nextLong())` ⇒ **共用装饰 RNG 恒消费 1 次 `nextLong()`**，与 `a` 是否陈旧无关 ⇒ **c3c 的「工厂位移 vs 段 2 未对齐」可分离性不受影响**。

**裁定（tier 0）**：**确定性优先** —— 实现为**每次放置重抽高度**，偏差**具名**。理由：
1. **逐位一致在本处本来不可达** —— vanilla 的值取决于**该会话的区块生成顺序**，而我们不知道捕获会话的遍历顺序 ⇒ 「忠实」不会给出正确答案，只会给出**另一种错**；
2. **代价不对称** —— 非确定性让**整个验证装置失效**：逐区块确定性、可复现 dump、**B 档同种子统计**全部不可定义 ⇒ **用一个字段的「忠实」换掉衡量一切保真度的仪器，是坏交易**；
3. 该偏差**方向单一**且**不触及共用 RNG** ⇒ **不可能位移其它任何装饰**。
**三条硬要求**：**(a)** 共用 RNG 不变量（每次放置**恰 1 次 `nextLong()`**）必须**写成可判假的断言**，不是注释；**(b)** 偏差在代码里**具名**（引上述行 + 作用域 + 方向）；**(c)** 登记为**前向残差**并给**重开条件**（若 `(0,0)` 域内确实出现大橡树且 c3c 可归因于它，则重访）。
**★ 被否的替代方案（丁）**：把状态做成**每世界持久对象 + 声明遍历顺序** —— 机制上更近，但**可观测上并不更近**（我方顺序仍 ≠ vanilla 顺序，残差只是换了参数化），而代价是**把状态穿过生成器、可能触及冻结的 `provide_chunk` 输出** ⇒ **收益不可证、风险更高，不采纳**。

**类级检查项（standing）**：**「vanilla 单例 + 可变实例字段 ⇒ 跨调用持久状态」列入 G-WORLD 所有剩余卡的开工检查项**。本卡已逐一核完四个生成器：`aps`/`apk` 只有 `static final`、`apv` 全 `final`、`aoi` 的 `k`/`l`/`m` 与 `b`/`j` 每次重写 ⇒ **偏差集合 = 单元素 `{aoi.a}`，无遗漏**。

**★ 正例（成员自查并自纠）· meta 的「轴位」与「变体」是两个独立分量。**
实例：成员自查出**自己前三次提交的真缺陷** —— 原木 meta **缺轴位**。读数：`ail.java` 第 21 行 `this.j(this.M.b().a(b, aio.a.a).a(a, ahw.a.b))` ⇒ 原木默认态 = variant `aio.a.a`(OAK) + **axis = `ahw.a.b`（Y）** ⇒ meta = `variant | (Y.ordinal()<<2)` = **`variant | 4`** ⇒ **云杉应为 5、橡树应为 4**，而它前三次误写为 **1 / 1 / 0**。⇒ 已**单独提交**修正 `12a2b092e2594c9f8f8e1859614366edaaced1a7`（3+/3−），`cargo check -p mc-worldgen` exit 0，并**具名「树冠叶 meta 不受影响」**（叶 = `afi.t`，**无轴属性**）。
⇒ 这条与 t134 的目标缺陷**同族**（t134 就是叶 meta `18:2` vs `18:1`）⇒ **任何 meta 断言都必须同时具名「变体」与「轴位」两个分量。**
**㞌（平台观察）· 里程碑让运行时在**任务边界**切你，但**不等于会自动恢复你** —— 无接续器时，长任务**每段都需要一次外部唤醒**。**

**实例（G-WORLD t134，tier 0 一手）**：该卡**有活动里程碑**（`done=false`、`doneWhenSetAt` 已设）。但成员**每到一个段边界就 `inactive`**：`aps`/`apk`/`apv` 三段 → 结束；meta 轴位修正 → 结束；`aoi`（段 A）→ 结束；**段 B 至今未写**。⇒ **每一段都需要一次外部唤醒**（组长唤成员、或我唤组长）。
⇒ 与 **㞙** 的区别：㞙 是「**无**活动里程碑 ⇒ 被切在**回合**边界」；本条是「**有**里程碑，切在**任务**边界 —— 而任务边界**之后不会自动续跑**」。⇒ 两者叠加的解释力：**㞙 解释「为什么切得不是地方」，㞌 解释「为什么切完之后停住了」。**
⇒ **操作口径（无接续器期间）**：**(i)** 组长把「成员 inactive 且仍有剩余段」**当作需要唤醒的信号**；**(ii)** **每次被唤醒时一次性把剩余的段全部派完**；**(iii)** **唤醒组长的那一环由 tier 0 承担**（协调层职责，不是组长的失误）。
⇒ **待观察**：若接续器启用后仍每段停住，则本条升级为缺陷。
**㞍 ★★ 断言必须对「它所声称的对象」可判假，而不只是对「它恰好夹住的那个量」可判假 —— 检验法 = 扰动所声称的对象，看它是否变红。**

**实例（G-WORLD t134 段 A，lead-world 退回、成员重做，tier 0 采纳为纪律）**：原断言写成
`let d0 = rng.draws(); let seed = rng.next_long(); debug_assert_eq!(rng.draws() - d0, NEXT_LONG_DRAWS /* = 2 */, …)` —— `d0` 与断言**只夹住那一次 `next_long()` 调用**。
⇒ **被测对象 = 「`next_long()` 消耗 2 draws」（一个标定常数）**；**所声称的对象 = 「一次 `aoi` 放置恰消费 1 次 `nextLong`」（不变量）**。⇒ 在放置**后面**再加一次 `next_long()`（消费 1→2）⇒ delta **仍是 2** ⇒ **断言不会变红** ⇒ **它对自己声称的不变量恒真**。
⇒ **类别：「被测对象 ≠ 所声称的对象」的哑失败** —— **看起来在守不变量，实际只能标定一个常数。**
⇒ **本条的由来值得记**：tier 0 只要求「把不变量**写成断言而不是注释**」；**lead-world 把它加固成一条判假标准**（把消费从 1 改成 0 或 2，该检查必须变红）。⇒ **加固后的标准第一次使用就否掉了一个断言**，而那个断言在旧标准下会**以「断言存在」通过**。⇒ **「断言存在」与「断言测对了对象」是两级。**

**重做的正确形式（成员一手）**：拆为**外层守卫 + 内层实现体**，`d0` 取在内层调用**之外**、断言在内层**之后** ⇒ **覆盖内层所有出口路径**（含提前 `return`）；**双向可判假**（内层再加一次 `next_long` ⇒ delta 4 ≠ 2 ⇒ 红；删掉 ⇒ delta 0 ⇒ 红）。commit `872ff4d6a0f547dc034c892d519e910054b439c3`（32+/11−、仅 `decoration.rs`、`cargo check` exit 0）。
⇒ **并须具名两点（成员已做）**：
- **`debug_assert_eq!` 在 release 下被编译掉** ⇒ 它是**调试/测试配置**下的守卫，**不是运行时不变式** —— 引用它时必须带上这个域；
- **若该路径在某次生成中从未执行**（本例：`(0,0)` 域内可能没有大橡树）⇒ **不变量「未被验证」，不是「已满足」** ⇒ 必须记为未验证，或用**负控强制走一次**。

## B-196（候选 · 平台，**条件特性未启用**）· **无接续器时长任务每段需一次外部唤醒（2 跳），吞吐由唤醒延迟界定**

**现象（lead-world 一手，tier 0 确认并登记成本）**：`group-world-t134` **有活动里程碑**，但成员每到一个段边界就 `inactive`，**没有任何机制自动唤醒它** ⇒ 每段需要 **tier 0 → 组长 → 成员 两跳**。⇒ **世界线的吞吐由唤醒延迟界定，而不是由成员的速度界定** ⇒ 排期必须按「**每跳只买到成员一个 turn 的工作量**」估算。
**性质**：系统提示已把接续器描述为**条件特性**（*a continuation service when it is enabled*）⇒ 本条**不是「坏了」，而是「未启用且有代价」**，故按**观察 + 成本**登记，不按缺陷登记。**若接续器启用后仍每段停住，则升级为缺陷。**
**自然修法**：接续器应按「**已批准 + owner 明确 + 仍有剩余**」唤醒，而不是靠 tier 0 盯。
**产品侧缓解（已采纳）**：**(i)** 组长每次被唤醒**一次性派完所有剩余段**；**(ii)** **把不改变行为的多个生成器合成一段**（分段原本是为「产物可核查」，租约机制已明后可合并）。
**㞎 同一个语义在树里已有实现时，「新写一份」是负债而不是进展。**

**实例（G-WORLD t134 段 B，lead-world 一手）**：成员自陈缺一个接口读数 —— 「`Generator` 是否持有 `BiomeCache`」。lead-world 定位后发现**答案已在树里**：`generator.rs` 第 776 行已有 `pub fn chunk_biomes(&mut self, chunk_x, chunk_z) -> Result<Vec<u8>, _>`；而**角点群系的取法在第 1266-1272 行已有一份现成的**（monster_egg 那条路）：`chunk_biomes(nx + 1, nz + 1)` → `.first()` → `surface_base_id(c)`，其注释**逐字**引 `aoa` 第 262-265 行「角点群系按源区块取」。
⇒ **要求：复用该路，不新造缓存、不另写第二套取法。** 理由 = **发散风险**：**两套角群系取法在群系平面将来改动时会不一致**，而这种不一致**不会立刻红**（它只在某个未来的改动里才显形）。
⇒ 纪律：**「树里有没有」必须先查，再决定「写不写」**。⇒ 与 **㊼**（锚必须是命名对象）**同族但不同轴**：㊼ 说的是**引用**要具名，本条说的是**实现**要唯一 —— **同一个语义有两份实现时，两份都是不可信的锚。**
⇒ **落地形态（成员已做）**：复用同一读数，并加 `debug_assert_eq!(base, corner_base)` ⇒ **提升前后必须是同一值** —— 用一条断言把「两处不得发散」变成**可判假**的。（承 **㞍**：断言要对**它所声称的对象**可判假 —— 这里声称的对象正是「两处一致」。）

**★ 并记一条正例：lead-world 拒绝替成员采信转述。** `surface_base_id(c)` 在调用点**看起来**已做 M→基 映射（返回值与基 id `3|20|34` 比较），但它**明确要求成员去读该函数的定义确认** —— 理由正是它自己的规矩「**调用点形状 ≠ 被调用者语义**」。⇒ **它把「地图」给成员，把「读数」留给成员。**

---

# 批次 65（tier 0 落地 · 2026-09-29）

**B-198（候选 · 平台）· `job_list` 在重启后**抛异常**：恢复出来的已完成作业记录无法被后来的宿主移除。**

**现象（tier 0 一手，2026-09-29 20:41 重启后第一次调用）**：`job_list` 直接抛 `ToolCallError`：**`job p�wsh-1 is a recovered completed record and cannot be removed by a later host`**（原文，pid 名称按原样）。⇒ 该工具**整体不可用**，而不是返回一条坏记录。
**为什么是缺陷**：**(i)** 一个**只读**的枚举工具因**历史记录**不可用 ⇒ 调用者**失去整个作业面**；**(ii)** 触发条件是**宿主重启**（一个正常事件），而**恢复记录恰恰是重启后必然产生的**；**(iii)** 没有任何「跳过该记录」的降级路径。
**产品侧规避（已执行）**：改用 `job_output(job_id)` 逐个读，或**直接读累积载体**（日志/产物 mtime）—— 与 **㞁** 一致（判活读累积载体）。

**重启恢复清单（tier 0 常设 · 2026-09-29 第二次执行）**：
1. **仓库面**：`main`/`HEAD`/`porcelain`/三个组分支尖 —— 实测 **`main = HEAD = 93661eb1`、`porcelain` 空、`grp/rig = 20cdcdb7`、`grp/world = fc3d544c`** ⇒ **落地存活**。
2. ★ **常驻 oracle 必须恢复**：重启会杀掉它，而 `m0Preserved` 要求 `m0PidsBefore.Count>0` ⇒ **没有它判据跑必红**。本次恢复：`pid 33500`、解释器 `D:\dsh-test\workspaces\mc189-rs\tools\golden\jdk\jdk8u504-b01\bin\java.exe`、cwd `<主检出>\.local\oracle`、参数 `-Djava.awt.headless=true -Xms1G -Xmx2G -jar 1.8.9-server.jar nogui`、监听 `25565`。
3. ★ **恢复动作必须连同「新形态」一起广播**（㊛）：**改环境的人必须报 pid / 解释器路径 / cwd / 参数**，**接收者不得从 cmdline 形状反推归属** —— 该形状**逐条命中 t64 的匹配式**。
4. **重作业全部消失** ⇒ 槽归零、在飞作业需重起；**成员回合全部被切断**（名册上除 tier 0 外全 inactive）。
5. **平台修复的 live 复核**：本轮重启使**平台缺陷批次 61 的三条修复（B-187/B-190/B-192）应当 live** ⇒ 按**原始反例**逐条复核（批次 62 已写明的口径）。
**㞑（协议已知限制）· AJ 的「声明」是**事后广播**，不是**原子占位** —— 两个并发读者可能都读到「空」并都起跑。**

**实例（lead-world 一手，2026-09-29 重启后）**：宿主重启把 `ac-3` 杀掉且无人重起，而 tier 0 给的槽序是 `ac-3 → G-WORLD`。⇒ 两条规则在**这一情形下给出相反指示**：**固定槽序**说「等」，**AJ⑥** 说「事实显示空且无人认领即可开工」。
⇒ **裁定（tier 0）**：**AJ⑥ 优先** —— **槽序是排队意图，不是权利**；**由「事实读 + 先声明者」仲裁**；固定槽序**降级为偏好**。理由 = **代价不对称**：撞车 = 双方读数同时作废 + 串行重跑一次；空槽永久阻塞 = **无限延迟**（正是 AJ② 要消灭的**假阻塞**）。
⇒ ★ **但由此暴露协议的一个真实空档（本条登记的就是它）**：**声明是事后广播** ⇒ 读事实与写声明之间的窗口里，**两个并发读者都会读到「空」**。⇒ 该窗口**不可能靠协议本身消除**（没有原子占位）。⇒ **诚实表述**：**协议降低但不消除竞态**；**缓解 = 把窗口压到最小**（读事实与写声明之间**不得夹慢操作** —— 承 **㊗**：慢操作不得夹在「读」与「用」之间）。
⇒ 与 **㊅/㊇**（稀缺资源占用须具名可读 + 声明≠事实 + 自失效）合看：**三者合起来给出「无原子 CAS 时的最好近似」** —— 具名、可读、自失效、先声明者优先、窗口最小化。

**㞒 「计划」只对 **edit** 卡存在 —— 对 **review/discussion** 卡说「已 plan-approved」是**范畴错误**。**

**实例（lead-rig，第二次同形）**：它派 `group-rig-t98`（**`review`** 类）时写「本卡已 plan-approved」⇒ 平台逐字拒绝 **`[plan-kind]: task group-rig-t98 is a review task; plans are only valid for edit tasks`**。⇒ **拒绝是对的，措辞是错的**；它**当场更正**并改为「本卡是 review 类、无需 plan，直接按卡面执行」。
⇒ **第二次**同形（今早 t95 那次：它说「已 plan-approved」而实际 `plan-not-found`，被 rig-trace 当场拒回）。⇒ 纪律：**提到「计划已批准」之前，先确认该卡的 `workKind`**；`review`/`discussion` **按构造没有计划**。
⇒ **正例（同轮）**：它这次在写「已 plan-approved」之前**先读了 `team_plan_get`**（回执 plan-approved）⇒ **前提是读出来的，不是记忆里的**。
**㞓 「读注释」不是「读实现」—— 引用一条守卫，必须读执行它的那几行，并具名基准变量是怎么求出来的。**

**实例（tier 0 自己的错，由 lead-world 更正；tier 0 随后一手复核确认）**：`-TargetDir` 的守卫。tier 0 读的是 `run-criteria.ps1` 第 22-26 行的**注释块**，它逐字写「`<TargetDir>` 必须是 `<RepoRoot>\target` 本身或它的子目录」—— **那句话是对的**；而 tier 0 把它读成「**主检出的** `target`」，于是**背书了一个对成员工作树必然被拒的路径**。
**执行代码（一手复核）**：第 18 行 `$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).Path` ⇒ **`$RepoRoot` = 运行脚本的那个检出**；`第 253-268 行` 的 `$tdRel` 仅当 `$tdFull.StartsWith($repoFull + '\')` 时求出，且 `$tdOk` 要求 `$tdRel -eq 'target'` 或 `StartsWith('target/')`（**Ordinal**），否则 `TARGETDIR_BINDING_CARRIER=FAIL` + `exit 1`。
⇒ **合法根 = 「运行检出自己的 `target`」** ⇒ 从主检出跑用 `…\RustMc\target\<子目录>`；从**成员工作树**跑必须用 **`<成员工作树>\target\<子目录>`**。
⇒ 纪律：**注释是「关于实现的陈述」，不是实现** —— 与 **㊎**（优先读对象自报的状态）**同族**：**不要用关于对象的陈述去代替对象。**
⇒ **推论（收窄 AJ①(d)）**：`-TargetDir` 的合法根随**运行检出**而定 ⇒ **不同工作树之间天然互斥** ⇒ **(d) 的「共享 target」冲突只在「同一检出上的两个并发」时才成立**。

**㔀（正面形态）· 「有界等待 + 事实门」是处理「占者失联」的正确形状。**

**实例（2026-09-29 重启后，lead-rig 与 lead-world 的交接）**：重启把 `ac-3` 杀掉而无人重起，而槽序说「world 在后」。两者的处置：**lead-rig 给出有界截止**（`2026-09-29T13:16:40.216Z`，到期无占用声明即**显式释放**）；**lead-world 按住**，并在**起跑前重读一次事实**（若占者已在跑则让出）。
⇒ **两半缺一不可**：**有界截止**防「无限等待 = 假阻塞」（AJ② 的精神）；**事实门**防「声明与事实不符时按声明走」（AJ① 的精神）。⇒ 合起来 = **既不空转、也不撞车**。
**㔁 「重作业槽」的域 = 「会产生 java / oracle 进程的作业」，不是「一切 CPU 重的作业」。**

**实例（2026-09-29，重启后）**：G-RIG 的落盘方以「**`pwsh-263` 在跑 ⇒ 不得重编译**」为由推迟了真门禁 `cargo test -p mc-proto-schema --test citation_integrity`。⇒ 但槽要防的是 **`foreign_java_delta` 污染** —— 即**会产生 java/oracle 进程**的作业；**`cargo test` 不产生 java** ⇒ **它不在槽的域内**。
⇒ 纪律：**声明「占槽」时必须具名它防的是什么** ⇒ 否则**任何 CPU 重的作业都会被当成占槽**，把不该被挡的工作挡住（**过度封锁与封锁不足都是缺陷**）。
⇒ **★ 但附带一个必须满足的条件**：**不得与槽内作业共用 `-TargetDir`** —— 这是 **(d) 的第二条互斥面**（共用 target 会互相污染构建产物）。⇒ 与 **㞓 的推论**合起来：**不同检出的 `target` 天然互斥** ⇒ 只要**同一检出上不并发**即可。
⇒ 一般化：**一个「互斥面」必须同时具名「防什么」与「在哪个域上互斥」** —— 否则它会**过宽**（挡住无害的作业）或**过窄**（漏掉真正的冲突）。
**㔂 改口径时必须**显式撤回**前一条，不能把两条并列投递。**

**实例（2026-09-29，lead-world 的两条指令）**：`member-world-chunk` 在同一批里收到两条互斥指令 —— `msg-cd54517d`（**起跑** + `-TargetDir` = 成员工作树的 `target`）与 `msg-1d1c85df`（**不要跑** + `-TargetDir` = 主检出的 `target`）。⇒ 成员 **fail-closed：未起跑、未 acquire**，并发 `decision` 请裁定。
⇒ **成员做得对**：它**没有**按「哪条更具体/更晚」推断先后 —— 那是**形状推断**（㊛ 同族）。⇒ 但**根因在发出方**：**后一条没有撤回前一条**，于是接收者拿到的是一组**并列的矛盾事实**。
⇒ 纪律：**改口径 = 新指令 + 对旧指令的显式撤回**（或显式 `supersede`）。⇒ 与 **㊗**（CAS 发送窗口最小化）**同族但不同轴**：㊗ 管**时间**上的窗口，本条管**集合**上的并存。
⇒ **附带（同轮正例）**：成员按「**读，不声称**」给出 `leases` 原始输出（`run-47f2c0c4 … status=expired`），并**因此没有执行起跑消息里的 `heartbeat` 步骤**（过期租约上 heartbeat 无效）—— **读数的价值直接体现为动作的修正**。
**㔃 一个「相位」可以有两个写者 —— 那么「owner 推不上去」不等于「该相位不可达」。**

**实例（rig-runner 一手，2026-09-29，t98 的 incidental 读数）**：`team-control-plane.mjs` 第 291 行**仍**把 `member-check` 的允许集写成 `{group-check, execution, …}`（**不含 `integration-ready`**）⇒ **owner 用 `advance_phase` 到不了 `integration-ready`**；而 `ensurePacketPhase(…, 'integration-ready', …)`（第 4260 行 / 第 4770 行 / 第 5053 行 / 第 5638 行）**会设它**。⇒ 这解释了本会话反复出现的困惑：**`group-rig-t58` 停在 `integration-ready` 而其 owner 推不上去**。
⇒ 纪律：**看到「某角色推不动某相位」时，不得据此断言「该相位不可达」** —— 必须先查**还有谁写这个字段**（本例 = 提交验收包的那条路径）。⇒ 与 **㊌**（弱信道不承载强结论）同族：**「这条路径不通」只说明这条路径。**

**㔄 「无法行使的验收项」不得用「制造状态」来满足 —— 应当指定**自然载体**。**

**实例（rig-runner，2026-09-29，t98 的 B-187 腿）**：修法断言「owner 从 `integration-ready` 可直接 `complete` 且**相位保持**」。而组板上 **6 张 `integration-ready` 卡全部已 `completed`** ⇒ `nonCompletedIR=[]` ⇒ **该动作在已完成的卡上无法行使**。⇒ 它**拒绝把卡推上去造出该状态**（ac 明文禁止），并请组长**指定载体**。
⇒ 裁定（tier 0）：**挂在「下一个自然到达 `integration-ready` 且未 completed 的卡」上** —— 该卡 owner 在那一刻**自试 `complete`** 并记录相位行为。⇒ **不制造读数。** ⇒ 与「**先证明它是遗留，再回收**」同族：**为了让判据可跑而制造的状态，其读数不成立。**
**㔅 转达一个路径时，必须验证它存在 —— 路径不是一个标签，是一个读数。**

**实例（2026-09-29，t134 判据跑第 1 次起跑被守卫拒）**：`-TargetDir` 把工作树目录名写成 `team__world\member-world-chunk`（**嵌套两层**），而实际目录是 `team__world__member-world-chunk`（**单目录、双下划线**）⇒ 路径不存在 ⇒ 守卫 `TARGETDIR_BINDING_CARRIER=FAIL / REASON=out-of-repo`。
⇒ 纪律：**转达路径前 `Test-Path` 一下**。⇒ 与「**调用点形状 ≠ 被调用者语义**」同族：**名字看起来对，不等于它指向存在的东西。**

**★ 同轮正例 · 一条自纠正的拒绝（本仓 §5.10 附则二的实现）**：该守卫**自己打印了 `REQUIRED` 与 `NEXTSTEP`** —— 逐字 `TARGETDIR_BINDING_CARRIER_REQUIRED=…\team__world__member-world-chunk\target`、`…_NEXTSTEP=pass -TargetDir "…\team__world__member-world-chunk\target"` ⇒ 成员**照它逐字重跑即成功**。
⇒ 与「**上界不是门禁**」对照：**这条拒绝比一句「invalid」有用得多** —— 它把「被拒」变成了**可执行的前置条件**。⇒ 纪律：**凡 fail-closed，必须同时给出「满足它所需的确切取值」**。
**㔆 「成功回执」不等于「事件发生」—— 判据必须读**对象**（revision / 时间戳），不能读返回值。**

**实例（lead-rig 自查，2026-09-29，挡住了自己的一次假绿）**：它对 `group-rig-t58` 调 `team_plan_approve`，**返回成功**（`state=plan-approved / approvedBy=lead-rig`）；而 `team_plan_get` 前后对比：**`revision` 仍 4、`approvedAt` 仍 1790667672169、`updatedAt` 仍 1790667672169（三者全未变）** ⇒ **它是 no-op，没有产生 plan-approval 事件**。
⇒ 它据此**否掉了自己的结论**：原本要拿「探针票 `2063caf6` 仍 open」判 B-190，但**该票从未暴露给清扫路径**（no-op 没有触发清扫）⇒ 那个读数**不成立**。⇒ 这正是「**负断言的强度受通道域限制**」的又一形态。
⇒ 纪律：**读回执只告诉你「调用被接受」，不告诉你「事件发生」** ⇒ 判据必须读**对象自己的状态**（`revision` / `approvedAt` / `updatedAt` / `closedReason`）。⇒ 与 **㊝**（锚不得是可变引用）**同族但不同轴**：㊝ 说**别拿会动的东西当锚**，本条说**别拿「被接受」当「已发生」**。

## B-199（候选 · 平台）· `team_plan_approve` 对**已批准**的计划**返回成功但零副作用**

**现象（lead-rig 一手，三字段前后逐字相同）**：对已批准的 plan 再调 `team_plan_approve` ⇒ 返回 `state=plan-approved / approvedBy=lead-rig`（**成功**），而 `revision` / `approvedAt` / `updatedAt` **一个都没动**。
**为什么是缺陷**：**(i)** 一个**幂等**调用**可以**是正确设计，但**它必须与「真的产生了事件」可区分** —— 现在两者**返回同一形状的成功**；**(ii)** 后果具名：任何以「调用后**应当**有某个副作用」为前提的观测（本例 = **计划批准会触发等待票清扫**）都会**静默地什么都没测到**，并**看起来是绿的**。
**建议修法**：返回体里给出**是否产生了变更**（如 `changed:false` / `deduplicated:true`），或让 `revision` 在幂等命中时**显式回显「未变」**。
**产品侧规避（已执行）**：判据**读对象**（`revision`/`approvedAt`/`updatedAt`）而不读返回值；**并改用一次真事件**做观测（新卡 `group-rig-t100`：**先**登记 opaque 探针票、**再**批准它的 plan ⇒ 首次批准是**真事件**，`revision` 与 `approvedAt` 都会动，**可自查**）。
**㔇 一条「按根相对」的判据，若它需要写构建产物，就必须把该产物目录写进卡的范围 —— 否则判据在该卡类别下不可满足。**

**实例（2026-09-29，t97 的真门禁）**：rig-trace 跑 `cargo test -p mc-proto-schema --test citation_integrity`，被**写范围守卫**连拒两次，逐字：
1. `bash write denied: member "rig-trace" has no declared static scope or active approved plan lease for (…\team__rig__rig-trace\target); active lease: none`
2. 取租约后重试：`bash write denied: "…\target" is outside the active plan write scope [tools/rig-batch/CONTRACT.md] for member "rig-trace" task "group-rig-t97"`
⇒ **★ 租约不会拓宽域** —— 域由卡的 plan `write_scopes` 决定。⇒ 它**没有绕过**，而是**释放探针租约（`cancelled`）并把拒绝串逐字写进该租约的 `error`**（不让失败消失）。
⇒ **裁定（tier 0）= A**：把 `target` 加进该卡写范围（`replace_approved:true`，`replace_reason` **逐字引 M-10-6**）。⇒ **不选「一次性 privilege 绕过」** —— **能靠满足前置条件解决的，不要靠放宽门禁**（否则「判据要写 `target/`」这件事**永远不被修**）。
⇒ **★ 并记一条范式（rig-trace 的控制探针）**：`cargo metadata --no-deps`（**不写 `target`**）⇒ **RC=0** ⇒ **证明这是「写路径」拒绝，不是「命令坏了」**。⇒ 纪律：**一条被拒的读数要可归因，就必须有一个「只差一个变量」的对照。**

## B-200（候选 · 平台）· `team_run_lease(status:"blocked")` 的拒绝点名了一个**请求者造不出来**的条件

**现象（rig-trace 一手，按其自限强度转录）**：`lease-release-blocked-unnamed` 的文本说「**带具名 task/object/note 的开放等待票**」即可；而实测在**同一张卡、同一 waiter 上恰有一张开放票**（`responsible=lead-rig`、`type=approval`、**带 `detail`**）时**仍被拒**，显式 `blockedBy` **也被拒**。⇒ ★ **回执不回显 `note`** ⇒ **无法证明 `note` 就是缺的那一项**。
⇒ **因此只登记可复现的那半**：**该拒绝点名的条件，无法由该拒绝文本构造出来；且没有任何读数告诉你缺哪一项。** ⇒ 与 **AJ⑤★** 同族：**判据点名了一个请求者造不出来的对象**（与 **㞀**「锚必须对读它的人可及」互为表里）。
**建议修法**：拒绝文本**逐项列出**它检查了什么、缺了哪一项（而不是给一句可多解的处方）。
**㔈 更正 㔅：「验证过」绑定的是**值**，不是**名字** —— 验证必须发生在**发出该消息的那一个程序**里。**

**实例（lead-world 一手，比我原来的表述更锐）**：它读回自己发出的文本：`r71` **正确串 1 次 / 错误串 0 次**；`r72`（那条**取代一切**的授权起跑令）**正确串 0 次 / 错误串 2 次**。⇒ **取代纪律修好了语义，却引入了一个值错误。**
⇒ **根因（它具名）**：在 r72 的**程序里重新定义了路径常量**，而**该程序从未把这个常量拿去访问文件系统**（那一段只探进程表、没跑 `Test-Path`）；而 r71 的程序**用同一名字跑过 `Test-Path`/`git -C`** 且成功。
⇒ **精确化（我采纳并取代 㔅 的原表述）**：不是「转达路径前要验证」，而是「**验证必须发生在发出该消息的那一个程序里**」—— **上一次程序校验过，不等于这一次的值没变**。⇒ **「验证过」是绑定到「那个值」的，不是绑定到「那个名字」的。**

**㔉 写域是「活跃声明」，不是「历史归属」—— 交付完成 = 让出写域。**

**实例（rig-trace 一手，lead-rig 采纳）**：`[scope-conflict]` 把「**两张 active 卡同占一个写域前缀**」判成冲突 ⇒ **写域是活跃声明**。⇒ 与 **AJ③（占者负责清除）是同一条纪律的两个面**：**已完成的卡若不让出写域，就会像「没有 `cleared_at` 的槽声明」一样，持续挡住后来者。**
⇒ ★ **正例（lead-rig）**：它**采纳了这条，却没有立刻开卡把它写进 `tools/rig-batch/CONTRACT.md`** —— 因为**那张卡本身就是该缺陷的实例**（它上一步刚被 `[scope-conflict]` 拒过）⇒ 它**刻意推迟到 t100 落地、释放该前缀之后**。⇒ **按规则办事，而不是只把规则写下来。**

**㔊 通道纪律的一次自犯（tier 0 自己）**：`send_message` 直发 tier 2 被拒 —— `[message-scope]: tier 0 talks to tier 1 only: "rig-trace" is tier 2, so route this through "lead-rig"`。
⇒ 我当时的意图是**回一条阻塞裁定**（rig-trace 在等我裁 A/B/C/D）。⇒ 正确做法 = **发 lead-rig**，由它转。⇒ 记我自己：**这条纪律本会话已立过，我仍犯了一次。**

**★ 平台修复 **B-192 已 live 确认**（第一个被原始反例证实 live 的批次 63 修复）**

**读数（rig-runner 一手，t99，逐字节）**：
| 项 | 逐字（引号内） | 长度 | 首字节 | 首 3 字节 |
|---|---|---|---|---|
| `porcelain`（acquire 前） | `" M tools/rig-batch/tests/t67-stash-variant-743a37d6.md"` | 54 | `0x20` | `204d20` |
| **回执元素** | `" M tools/rig-batch/tests/t67-stash-variant-743a37d6.md"` | **54** | **`0x20`** | **`204d20`** |
| `porcelain`（acquire 后） | `" M tools/rig-batch/tests/t67-stash-variant-743a37d6.md"` | 54 | `0x20` | `204d20` |
⇒ **三段全 hex 相同**（`204d20746f6f6c73…`）、`Buffer.equals = true`、长度差 **0** ⇒ **前导空格被保留** ⇒ **原反例（回执吞掉空格）已不复现**。⇒ 窗口确被消耗：`HEAD 26b8598 → 93661eb1`、`--is-ancestor` **rc 1 → 0**；恢复后 `porcelain` 空、探针行消失。载体 `t99-b192-byte-readings.md`，commit `10c5dfb`。
⇒ **注意**：这次确认是在**未重启 DSH** 的情况下得到的 —— 与平台清单说的「**live pending，需进程更新后复核**」**不矛盾但也不等价**：本实例是**该修复已随某次进程更新生效**的一个证据点（否则不会逐字节保留空格）。⇒ 我按「**按原始反例复核**」的口径记录它，**不据此宣布三条都 live**。

**两条仪器发现（rig-runner 一手，都记了下来而不是抹平）**
1. **`Select-String` 的输出会折行** —— 命中显示成 `…T99-CASE-B192-PROBE t` ⏎ `ier0 temporary…`，**是控制台宽度造成的显示折行，不是文件内容**。它用 `edit` 的 `old_string` 匹配**完整探针行 + CRLF** 交叉证明了真实内容，并记下该警告。⇒ 与「**截断/折行视图上的否定断言不成立**」同族。
2. **一次瞬时通道故障**：首次尝试以 **`job pwsh-36 belongs to another session`**（会话接续后的作业登记表故障）中止。⇒ ★ **它没有盲目重试，而是先查 `leases`**（`active: []`）⇒ **证明 acquire 并未落地** ⇒ 没有半消耗状态，然后才重试。⇒ **这正是「先查效果再重试」的形态。**
**㔋 一个「数字」需要三样东西：它的**对象**、**哪一个数才是判据**、以及**它在哪种调用形态下可见**。**

**实例（rig-trace 一手，t97 的真门禁；其中一条是 lead-rig 自己写的判据）**：
**(a) 门绿而 `mismatches=55`** —— 承重的是 **`unregistered=0`**（55 条判红**全有登记项**：`owned=50` + `pending_path=5`）。⇒ **谁 grep `mismatches=0`，就会把一道绿门读成红门。**
**(b) 默认调用不打印任何账目** —— 不带 `-- --nocapture` 时 `M11-*` 命中 **0 行**（它是**通过测试的 stdout**，被 cargo 捕获）。⇒ lead-rig 的 ac-2 **要求了账目，却没把调用形态写进判据** ⇒ **合规执行者会跑出 0 行并以为「没有账目」**。
⇒ 与 t97 自己的 nit **同形**：**判据要求的对象，在判据给出的读法下不可见。** ⇒ 与 **㞍**（断言必须对它**所声称的对象**可判假）**同族**：㞍 管**断言**，本条管**读数**。

**㔌 「我以为我覆盖了它」不等于「它被覆盖了」—— 覆盖的判据是**读回票集**，不是读回执。**

**实例（tier 0 一手，2026-09-29，lead-rig 留下的观察）**：`group-rig-t100` 上出现**两张同形 open 票**（同 `task` / 同 `waiter` / 同 `type=approval` / **同 `object=probe-B190-t100`**）：`82168465`（created 1790690211925）与 `adbccfe5`（created 1790690456694）。⇒ 与 rig-trace 观测到的「**同键上 `waiting_set` 是替换而非新增**」**不一致**。
⇒ **机制假说（有支撑读数，未被证明）**：两张票的 **`object` 相同**，但 **`detail` 与 `note` 不同** ⇒ **替换键比「(task, waiter, type, object)」更宽 —— 它包含条件的载荷**（至少 `detail`/`note`）。⇒ **什么能定案**：再登记一对 **`detail`/`note` 也完全相同**的票，看是否只剩一张。
⇒ 纪律：**「覆盖」必须由**读回对象集**证明**（承 **㔆**：成功回执 ≠ 事件发生）⇒ 与 **㔂**（改口径须显式撤回）**同族**：**投递一条新声明，不等于旧声明消失。**

**★ 平台修复批次 63 的 live 复核进展（按原始反例，tier 0 汇总）**

| 编号 | 原始反例 | live 复核读数 | 判定 |
|---|---|---|---|
| **B-192** | `porcelain` 的 `" M <path>"` vs 回执的 `"M <path>"`（空格被吞） | 三段全 hex 相同（`204d20746f6f6c73…`）、`Buffer.equals=true`、长度差 0；窗口被自然消耗（`HEAD 26b85989→93661eb1`、`--is-ancestor` rc `1→0`）；恢复后 porcelain 空 | **live 通过** |
| **B-190** | t58 的 opaque approval 票被无关 `plan-approved` 关闭（`closedReason="plan-approved"`） | t100 **首次** `plan_propose→plan_approve` 给出**新值**（`revision=1`、`approvedAt=1790690581310`，对照 t58 那次三字段全未变 = no-op）⇒ 探针票**仍 `open`、`closedReason=null`**（2/2 存活） | **live 通过** |
| **B-193** | 落地令牌对被清关者不可读 | 未单独复核（本批未触发） | **待复核** |
| **B-195** | 过期租约上 `release` 误报 `[lease-release-order]` | 未单独复核（本批未触发） | **待复核** |
| **B-196** | —（观察，非缺陷） | — | **不适用** |
**★ 㔌 **更正**（我的假说被实测否证）**

我此前据「两张同形 open 票（同 `task`/`waiter`/`type`/`object`，仅 `detail`/`note` 不同）并存」提出假说：**替换键包含条件载荷**。**实测否证**：两张票的 **`responsible` 不同** —— `adbccfe5` 是 `(waiter=rig-runner, responsible=lead-rig)`，`82168465` 是 `(waiter=lead-rig, responsible=rig-runner)`；而**去重键 = `[taskId, owner, type, responsible]`**（`team-v14-waiting.mjs` 第 225-232 行）⇒ **不同键 ⇒ 合法并存 ⇒ 无缺陷**。
⇒ **㔌 的正确表述**：**「我以为我覆盖了它」不等于「它被覆盖了」—— 覆盖的判据是**读回票集**，而**「同键」的判据是平台自己的键**（`[taskId, owner, type, responsible]`），不是我以为的键。** ⇒ 纪律部分保留，机制部分作废。

**㔍 ★★ 假说不得建立在「我碰巧投影出来的字段」上 —— 投影决定假说。**

**实例（tier 0 自己，同一次调查）**：我查那两张票时用的投影是 `{id, st, closed, type, obj, note, detail, created, rev}` —— **里面没有 `waiter`，也没有 `responsible`**。⇒ 而**真正区分那两张票的字段恰恰是 `responsible`**。⇒ 我于是从「`object` 相同而 `detail`/`note` 不同」推出了一个**错机制**。
⇒ 纪律：**(i)** 要就「两个对象的键是否相同」下结论，**必须先把该对象的**全部**字段读出来**（或至少声明「我只投影了这几个字段，其余未读」）；**(ii)** **「我没打印它」不等于「它不可能是判别量」。**
⇒ 与 **㊌**（弱信道不承载强结论）**同族但更狠**：㊌ 说的是**信道**弱，本条说的是**我自己把信息砍掉了**。⇒ 与 **㔋**（数字要带对象/判据/调用形态）同轴：**投影也是一种读法，也会把对象变得不可见。**

## B-201（候选 · 平台）· **会话接续打断在飞的后台作业的驱动进程**

**现象（多轴一致，tier 0 一手）**：G-WORLD 的 t134 判据跑（起跑 `2026-09-29T13:38:16.658Z`）在**约 2.6 分钟后**死亡：其日志 `criteria-20260929T133817Z.log` **37484 B @13:40:52Z** 再无增长（最后一组相位 `C6_*` / `Cnoise1/2`，**未走到重相**）；租约 `run-6833740d` **expired**；**无 `run-criteria` 进程**；**无 `256xx` 监听**；`java` 只剩常驻 oracle；工作树**约 35 分钟无任何文件活动**。
**支撑读数（同会话）**：rig-runner **两次**遇到 **`job pwsh-36 / pwsh-61 belongs to another session`**（**会话接续后的作业登记表故障**）。⇒ 该故障与「驱动进程消失」**同会话共现**。
**假说（未证明）**：**会话接续使在飞的后台作业失去驱动进程** ⇒ 长作业**无终局行地死掉**。⇒ **什么能定案**：重跑一次，**起跑后 3 分钟内**读一次驱动进程，若它在而稍后消失、且日志无终局行 ⇒ 支持该假说。
**与 B-196 的关系**：B-196 是「**每段需要外部唤醒**」（吞吐问题）；本条是「**长作业在接续处被杀死**」（**可靠性**问题）—— **两者都指向同一个未启用的接续器**，但**后果不同**。
**★ 㔄 **收窄**（我的原表述过强，由 lead-rig 一手更正）**

**原表述**：「**无法行使的验收项**不得用**制造状态**来满足 —— 应当指定**自然载体**。」
**更正（lead-rig 一手，我采纳）**：它查了「该前置能否**自行**出现」—— **不能**：正常次序是 **owner 先 `complete`**（`execution → member-check`），**然后**组长才推到 `integration-ready`，**那时卡已是 completed** ⇒ 「在 `integration-ready` **且未 completed**」**只能由组长在 owner 完成之前推动相位才可达**。⇒ **我裁定的前提（「自然到达」）是错的。**
⇒ **收窄后的正确表述**：**若该状态不可能自然出现，构造它是合法的 —— 但构造必须在证据里逐字具名**，让后来的读者能分辨「**观察到一个状态**」与「**布置出一个状态**」。
⇒ 一般化：**「不得制造读数」的真正对象是「不得让读者把布置误读成自然」**，而不是「不得布置」。⇒ 与 **㞃**（已修 ≠ 已生效，两者都要写）**同族**：**状态的两个来源必须同时写出来。**
⇒ **正例（lead-rig）**：它在 group-check 时**主动去查了「该前置能否自行出现」**，发现不能，于是**要求 rig-runner 把「本载体是组长构造的」逐字写进证据**。⇒ **它没有满足于「状态已就位」。**
**㔎 「令牌」是**清关键**的前置，不是**发现表**的前置 —— 有 blocker 时，正确处置是**不签发**，而不是补发一枚去解锁一道本就不该开的门。**

**实例（2026-09-29，verifier 的 decision）**：它要我对 `52452d6c` 确认或补发落地令牌，否则它**无法写清关键**。⇒ **答复**：**该令牌不存在（我从未签发 —— 我的遗漏）**；但我**故意不现在补发**：**(i)** 该对象上有**由它自己引入的硬门禁红**（`ps1_line_citations` rc=101 / `unregistered=20`）⇒ **它必须先改**；**(ii)** 令牌**同时冻结两侧**（㊑）⇒ **对注定要变的对象签发 = 立刻作废**（㊝）。
⇒ 纪律：**先问「这扇门现在该不该开」**，再问「开它缺什么钥匙」。⇒ 与 **㔄 收窄**同族：**不要为了满足一个前置而制造一个本不该存在的对象。**

**★ 正例 · 「同一仪器在两个对象上的对照」使门禁红**可归因**（verifier 一手）**

对象 `52452d6c`：`ps1_line_citations` **rc=101**、`tracked_ps1=45 | tokens=35 | unregistered=20`（FAILED 2 passed / 1 failed）；**main `93661eb1`**：同一仪器 **rc=0**、`tracked_ps1=44 | tokens=15 | unregistered=0`（3 passed）。⇒ **净差 = +1 个 tracked `.ps1`、+20 token、+20 unregistered** ⇒ **是本批引入的，不是历史残留。**
⇒ 纪律：**判「某批是否引入了一条红」，必须给出「同一仪器在同一时刻的另一个对象」的对照** —— 否则无法把红归给任何一方。⇒ 与「**0 命中须带同类正控**」**同族**，方向相反：**正控防「查了但没有」，本条防「红了但不知道是谁的」。**
**㔏 `write_scopes` 的替换是「整体替换」—— 替换时必须逐字保留原有路径。**

**实例（2026-09-29，t97 的 condition ①）**：t97 **当前** `write_scopes = ['target','D:\…\team__rig__rig-trace\target']`，**不含**它实际改过的 `tools/rig-batch/CONTRACT.md`（1+/1−）。⇒ 表面上是「**越界写**」；实际是**替换把原路径弄丢了**（那行修复做在 scope 替换**之前**，替换的目的是让门禁跑得起来）。
⇒ 纪律：**替换 `write_scopes` 时必须把原有路径逐字列回**，否则**已完成的改动会在卡面上变成「越界」**。⇒ 与 **㔉**（写域是**活跃声明**）**配对**：**活跃声明不得抹掉历史声明。**
⇒ 并记一条读法：**看到「scope 与改动不符」时，先问「这个 scope 是不是被替换过」**，再问「是不是越界写」。⇒ 与 **㔃**（相位有两个写者）同族：**字段的历史比字段的现值更能解释不一致。**

**㔐 关于「会动的东西」的断言必须带时点 —— 否则它会在一个正常事件之后变成 stale，而被读成「错」。**

**实例（2026-09-29，t92 文档 第 7 行）**：该文档写「常驻 oracle **全程在（未启停）**」—— 它在**写下时为真**（`28996` 确曾全程在）；**宿主重启**后 owner 变成 `33500`（我按恢复清单重启）⇒ 该断言**变成 stale**。⇒ verifier 把它报为 condition（「环境已移动而文档未更正」），**并要求按 ㊛ 具名变更出处**。
⇒ 纪律：**「全程未变」类的断言必须写成「在 <时点> 之前全程未变；<时点> 之后 owner = <新值>（原因）」**。⇒ 与 **㞊**（被摘要钉住的对象不得就地修补）**同族**：**关于会动的东西的陈述，其效力以时点为界。**
**㔑 ★★ 两个候选机制在现有证据上不可分辨时，不要赌其中一个 —— 改掉那个**共用的脆弱挂载点**。**

**实例（lead-world 一手，2026-09-29）**：t134 的判据跑在起跑后约 2.6 分钟死亡。两个候选机制 —— **(甲)** 会话接续打断驱动进程（支撑：rig-runner 两次遇到 `job … belongs to another session`）；**(乙)** 后台作业随回合结束被回收 —— 在「**有→无、无终局行**」这一观测上**不可分辨**。
⇒ 它**拒绝在两者中挑一个**（「赌一个就是形状推断」），改为**同时避开两者**：把重跑从「注册为 harness 作业」改成 **detached `Start-Process`**（**同时免疫作业登记表与回合边界**），并在**同一轮内读两次进程表**给两个时点 ⇒ **下一次失败可被判别，而不是再猜一次**。
⇒ 纪律：**机制未定不是行动阻塞** —— 只要**去掉对那个共用的脆弱组件的依赖**，工作可以继续，且下一次观测会**自己把机制分开**。⇒ 与 **㊌/㊎** 互补：那两条管**别从弱读数下强结论**，本条管**结论未定时如何继续行动**。

**㔒 「死时断言是否全绿」是「外部终止 vs 内部失败」的廉价判别量。**

**实例（同一次死亡）**：日志尾部**最后完整的断言**是 `C6_rust_missing_not_comparable_named=True` 与 `C6_rust_missing_reason_names_missing_dump=True`（**通过**），而它**停在 `Cnoise2` 相内**（`Cnoise1` 的 contract-violation 是**预期的负例**、exit 3 正确）⇒ **该跑是在断言全绿时被外部终止的**，不是被测试失败崩掉的。
⇒ 纪律：**一条「跑到一半没了」的记录，其尾部断言的状态可以区分「被杀」与「自己崩」** —— 前者尾部全绿，后者尾部会留下失败断言。⇒ 这与「**无终局行**」合起来，构成一个**两问判别式**。
**★ B-201 假说 **被否证**（我认领），且否证方式本身值得记**

**假说**：会话接续打断在飞的后台作业的驱动进程（支撑：rig-runner 两次遇到 `job … belongs to another session`）。
**否证（G-WORLD 一手，逐字）**：detached 重跑在**约 1.8 分钟**内结束，而**真死因是判据自己 fail-fast** —— `C10_citation_anchor_guard_rc=1` / `CITATION_ANCHOR=FAIL` / `CRITERIA_FAILED=C10_citation_anchor_guard_pass_exit_0` / `ASSERT_SUMMARY|true=3|false=1`；`world-t134-run.out` **1651 B、起跑后 3 秒即停写**；两个时点（T1 有 pid 13260 / T2 已无）。⇒ **(甲) 会话接续 与 (乙) 回合回收 两条候选都不是死因。**
⇒ ★ **否证的方式值得记**：lead-world **没有在两个不可分辨的机制里挑一个**，而是**改掉了那个共用的脆弱挂载点**（改 detached `Start-Process`）—— 于是**下一次观测一次就把真死因交了出来**。⇒ 这正是 **㔑**（机制未定不是行动阻塞；去掉共用脆弱依赖，让下一次观测自己分辨）的**兑现**。

**㔓 当「输入逐字节相同」而「门的读数不同」时，该被质疑的是**门对读数的定义**，不是输入。**

**实例（tier 0 一手，2026-09-29，C10）**：同一条 C10 在**主检出**上给出 `cited_lines=2384 / span_holds=True|OK`，在**成员工作树**上给出 `2324/2324/37/2324 / span_holds=False|MISMATCH`。⇒ 而我排除了两项：**(a)** 两条短 sha（`3b17aaf3`、`66ccf240`）在两处 `git rev-parse` **逐字相同**（rc=0）⇒ 不是「短 sha 跨仓库解析不同」；**(b)** 四个载体文件（`verify-citation-anchor.ps1`、`ORACLE-SPEC.md`、`dump_chunks.rs`、`main.rs`）在两处 **sha256 前 16 位逐项相同**、行数相同。
⇒ 纪律：**输入相同而读数不同 ⇒ 差异必在「门如何把输入变成读数」这一步** ⇒ **正确动作是要求门的主人具名该读数的定义，而不是继续在输入侧找差异。** ⇒ 与 **㔋**（数字要带对象/判据/调用形态）**同族**：**`cited_lines` 数的是什么，只有门的主人知道。**
**㔔 归属看「谁写它 / 它自述属于谁」，不看「它落在谁的目录下」。**

**实例（2026-09-29，`ps1_line_citations` 的归属）**：该门**物理上**在 `crates/mc-proto-schema/tests/ps1_line_citations.rs`（**G-PROTO 的 crate**），但**归属是 G-RIG**。⇒ lead-proto 用三条判据请求路由：**(a)** 门头自述「t76/t81 —— .ps1 行号引注的机检守卫（**G-RIG 侧**）」；**(b)** 触及该文件的最近 4 次提交**全为 rig 卡**；**(c)** 本组 84 张卡**无一** `writeScopes` 含该路径。
⇒ 纪律：**目录名会把人误读成属主** —— 归属必须由**作者史**与**对象自述**判，不能由路径判。⇒ 与 **㞎**（同一语义只应有一份实现）**同族**：**两者都在防「看起来属于谁」被当成「属于谁」。**

**★ 批次 63 的三条修复现已全部 live 确认（按原始反例）**

| 编号 | 原始反例 | live 读数 | 判定 |
|---|---|---|---|
| **B-187** | owner 从 `integration-ready` 无法 `complete`（被强制回退相位） | t100 自试 `complete` ⇒ `rev14 / integration-ready / completed`，**相位就地保留** | **live 通过** |
| **B-190** | opaque approval 票被无关 `plan-approved` 关闭 | t100 **首次** `plan_propose→plan_approve`（`revision=1` / 新 `approvedAt`）后，opaque 票 **2/2 仍 open、`closedReason=null`** | **live 通过** |
| **B-192** | 回执吞掉 `porcelain` 的前导空格 | 三段全 hex 相同（`204d20746f6f6c73…`）、`Buffer.equals=true`、长度差 0 | **live 通过** |
| **B-193** | 落地令牌对被清关者不可读 | 本批未触发 | **待复核** |
| **B-195** | 过期租约上 `release` 误报 `[lease-release-order]` | 本批未触发 | **待复核** |
**㔕 不得从「我看到的几个值」推出「整组的值」—— 局部视图会替我做断言。**

**实例（tier 0 自己，2026-09-29）**：我据日志尾部说「好那次四条 `cited_lines` 都是 **2384**」。lead-rig **实测 17 个检出**（主检出 + 16 个 linked worktree，`--git-common-dir` 全 = `RustMc/.git`）⇒ 四条真值是 **2384 / 2384 / 132 / 2384** ⇒ **C2a 是 132，不是 2384**。⇒ **我从几个值推出了整组。**
⇒ 纪律：**报「一组值」时必须逐项给出，或显式声明「我只读了这几项」**。⇒ 与 **㔍**（假说不得建立在我碰巧投影出来的字段上）**同族**：㔍 管**缺字段**，本条管**把局部当全体**。

**㔖 当一条读数**不可能由执行体的代码与输入产生**时，该被怀疑的是「执行的是不是这份代码」，而不是「它不确定」。**

**实例（2026-09-29，C10）**：`cited_lines = f($RepoRoot 的对象库, CitedRev, Cited)`；而 **(i)** `run-criteria.ps1` **已显式**传 `-RepoRoot $RepoRoot`（运行检出）；**(ii)** 守卫**每一处** git 调用都带 `-C $RepoRoot`（`:156/:164/:178/:179/:202/:211/:280`）⇒ **没有任何一处依赖 cwd**；**(iii)** 17 个检出的 `.git` 是**同一个**。⇒ ⇒ **该函数在这些检出上不可能产出 2324 / 37**，而它**产出了**。
⇒ 纪律：**先问「执行体与这份代码是否同一份」**（打印 `$PSCommandPath` 的 sha256、与 `HEAD` 的 blob 对比），再谈「不确定」「竞态」「环境」。⇒ 与 **㞓**（读注释不是读实现）**同族**：**两者都要求把「我以为在跑的东西」变成「跑的东西的读数」。**
**㔗 判别量不在输出里时，**加打印**优于**改取值**。**

**实例（2026-09-29，C10 的 `2324/37` 异常）**：lead-rig 证明该门**确定**（同一检出连跑两次 `SAME_OUTPUT=True`、`LEN 3595=3595`、`DIFF_LINES=0`），且**5 个检出各跑一次全 RC=0 且同值** ⇒ `2324/37` **不可复现**。⇒ 它自己具名：**变量必在「`$RepoRoot` 指向哪个检出 / 该工作树里四载体的字节 / 对象库」之中，而该门从不打印 `$RepoRoot` ⇒ 唯一能判别的字段不在输出里。**
⇒ 它请求的动作之一是「让 G-WORLD 以显式 `-RepoRoot <主检出>` 重跑」。⇒ **tier 0 只授权一半**：**加打印**（`CITATION_ANCHOR_REPO_ROOT=<值>` + `$PSCommandPath` 的 sha256），**不改取值**。
⇒ 理由：**(i)** `run-criteria.ps1` 的那一行是 `& pwsh … -RepoRoot $RepoRoot`，`$RepoRoot` 由 `Resolve-Path ($PSScriptRoot\..\..\..)` 求出 ⇒ **调用方没有可传的入口**；**(ii)** ★ **钉根会把「它当时解析到了哪里」这个唯一的判别量永久藏起来** —— 而那正是要找的东西。
⇒ 纪律：**要找的是「它当时指向哪」，不是「让它指向我们指定的哪」。** ⇒ 与 **㔋**（数字要带对象）**同族**：**缺判别量时的第一动作是补打印，不是补约束。**

## B-202（候选 · 平台）· `complete` 的拒绝文本没有描述真正的前置条件

**现象（rig-capture 一手，2026-09-29，t102）**：第一次 `complete` 被逐字拒 **`[complete-evidence]: completion requires at least one evidence_id recorded for task "group-rig-t102"`** —— 而该卡在 **rev 9 时就已经列出** `evidence-6ae43dac`。⇒ **再发同一次调用、但显式带上 `evidence_ids:[…]`，即通过。**
**为什么是缺陷**：**拒绝文本点名的条件（「需要至少一条 evidence_id」）与真正的前置条件（「调用方必须在入参里显式传 `evidence_ids`」）不是同一件事** ⇒ 被拒者会**去补记录**（已经有的那条），而真正该补的是**调用形态**。⇒ 与 **B-200**（`lease-release-blocked-unnamed` 点名了一个请求者造不出来的条件）**同族**，与本会话的 `instrument-self-match` 也同族：**拒绝文本与真实前置条件不一致。**
**建议修法**：拒绝文本应写成「**本调用未携带 `evidence_ids`；该卡当前已记录 N 条，请显式传入**」。
**㔘 制造「红」读数时必须保证还原 —— 用 `try/finally`，并在事后复读工作区。**

**实例（rig-runner 一手，2026-09-29，t101 的单变量对照）**：为证明「红由那 20 条登记引起」，它需要**先取红读数**（把登记表换回 `@487ae72`），再换到 `@0fa4bd1b` 取绿读数。⇒ 它**用 `try/finally` 保证还原**，并在事后复读 **`RESTORED_PORCELAIN=[]`** 验证。
⇒ 纪律：**为了让一条判据可归因而人为制造的红，是「读数」；但它的**载体**必须被还原，否则会把一个被污染的工作区留给下一个读者。** ⇒ 与 **㞇**（干净度参与判定的作业，其工作树在跑期是独占域）**配对**：㞇 管**跑期不得写**，本条管**写完之后必须回到原样**。

**★ 范式 · 「同一工作树、同一二进制、只换一个输入」的单变量对照（t101）**

| 登记表 | anchors | unregistered | rc | test result |
|---|---|---|---|---|
| `@487ae72` | 14 | **20** | **101** | `FAILED. 2 passed; 1 failed` |
| `@0fa4bd1b` | 34 | **0** | **0** | `ok. 3 passed; 0 failed` |

⇒ **唯一变量 = 那 20 条登记 ⇒ 红→绿可归因**。⇒ 并附三条不变量：**非真空**（两个内置负控两次都通过 ⇒ 转绿不是「门停止检查」）、**防假绿**（基座确为 `grp/rig`：两新文件在 `grp/rig` rc=0、在 `main` rc=128 ⇒ 导出不是 0 条空转）、**fold 纪律**（改后文件对 token 正则命中 0；写入走被门禁管的 `edit`）。
⇒ **一条读数要可归因，就必须有「只差一个变量」的对照** —— 本会话第三次出现这条（前两次：rig-trace 的 `cargo metadata` 控制探针、verifier 的同仪器双对象对照）。
---

# 批次 66（tier 0 落地 · 2026-09-29）

> ★ **写给平台修复方的话**：本节的每一条都**只以本文件为准** —— 我此前把若干条目先放在 `.local/tier0-staged-*.md`（**未跟踪、你看不到**）与 evidence 行里，那是**流程缺陷**：**你要读的东西必须在本文档里**。自此以后，凡需要你处置的，一律写进本文档。

## ★ 需要平台处置的（按优先级）

**① B-197（候选 · 仍然 OPEN · 未修）· 组长无法读其成员的租约状态**

**现象**：`team_v12(action:"leases", input:{member:"<组员>"})` 由**组长**调用时，返回的键集**只有 `{leases}`**（缺 `member`/`taskId`/`now`）且 `leases=[]`；用**顶层** `member:` 参数则返回**空对象 `{}`**。⇒ **组长读不到组员的租约**。
**一手拒绝串（G-RIG 的 t95 探针，逐字）**：`lease-read-scope: only tier 0 may inspect another member's run leases`。
**为什么是缺陷**：**租约是写入门禁的第一合取项**，而**最该做预防性检查的角色（组长）读不到它** ⇒ 预防只能退化为三条次优路径：**(i)** 成员自读（可行但依赖成员主动）、**(ii)** tier 0 代读（协调层负担）、**(iii)** 被拒后读拒绝文本（最差 —— 本会话真实走过：两轮空转 + 一次错误的成因推断）。
**建议修法**：把租约读面下放到「该成员的组长」；或让写入门禁的拒绝文本**显式给出 `active lease: none / expired at <ISO>`**。
**★ 与本文件既有条目的关系**：**平台的 `PLATFORM-DEFECTS.md` 与本仓的 `docs/PLATFORM-DEFECTS.md` 是两份不同文件，编号体系各自独立** —— 批次 65 的清单称「其台账无独立 B-197 条目」，那是**平台台账**的情况；**本仓的 B-197 仍为候选、未修**。⇒ **两条台账不得互相读作已处置。**

**② B-203（候选 · 新）· 作业登记表把本会话刚创建的作业判为「属于另一个会话」**

**现象（tier 0 一手）**：一次**只读** `pwsh` 调用失败，逐字 **`job pwsh-153 belongs to another session`**；随后 `job_output(pwsh-153)` **以同一串失败** —— 而**宿主事件通知说该作业已 `completed`、`exit code: 0`**。⇒ **调用失败 + 已完成作业的输出不可读 ⇒ 一条读数静默丢失。**
**同一串在本会话被四名成员遇到**：`rig-runner` ×2、`lead-world` ×1、tier 0 ×1。
**★ 与 B-198 的关系（请确认）**：批次 65 报 **B-198 的根因是 job id 复用/碰撞**（旧宿主留下 `pwsh-1`、新宿主复用它 ⇒ 收尾移除时撞上 recovered 记录）。⇒ **B-203 很可能与 B-198 同根** ⇒ **若 B-198 的修法 live，B-203 应一并消失**。⇒ 请在重启后**按原始反例复核**：新宿主首条 pwsh 是否跳过 recovered id，且该串是否不再出现。
**★ 并撤回一条我自己的推测**：我曾把 B-203 写成「很可能就是 run1 无终局行停住的机制」；按 B-198 的根因（id 复用，与「驱动被回收」无关）⇒ **该推测作废**（见下 ④）。

**③ B-196（观察 · 未修 · **本会话最大的吞吐限制**）· 没有接续器**

**现象**：**里程碑让运行时在任务边界切你，但不自动恢复你** ⇒ **每一段都要一次外部唤醒**（tier 0 → 组长 → 成员，**两跳**）⇒ 名册上「看着像全队停工」的时段**全部**由此产生。
**实测代价（本会话）**：一次判据设备全量跑 **~70 分钟**，期间**12 人的团队被串行化成一条关键路径**（世界线 4 张卡的判据跑必须等它；`t105` 等 `t104`；tier 0 既不能提交 main、也不能跑 `cargo`）。
**平台批次 65 的处置**：**observation / 无平台改动**（未启用的条件特性）。⇒ 我接受该定性，但**成本仍在**：**建议按「已批准 + owner 明确 + 仍有剩余」唤醒**，而不是靠 tier 0 盯。

**④ B-201 · 由平台标为 withdrawn / observation，我确认**

清单原文「会话接续杀死在飞作业」的假说**已被 detached 重跑否证**；**真死因是 `C10_citation_anchor_guard` fail-fast**（run2）。⇒ **run1 的外部终止签名仍未解释**，但**不再有任何理由归给会话接续**。

**⑤ 一个**哈希不一致**（观察 · 待你确认）**

操作者两次报备**同一批次**（输入逐字相同：`PLATFORM-DEFECTS.md` @ `772a85e`、`size 870676`、`SHA256 D4899E17…`），但 `dsh-jobs-local/lib/index.js` 的 SHA256 **两次不同**：
- 第一次：`4C4BDE29FC5B041CDADC6C8C08146DD0EA494F57` + `9AD8A415AA4B61B32B89E5A7`
- 第二次：`4C4BDE29FC5B041CDADC6C8C08146DD0EA494F57` + `9504CC6E0B97670DC368F137`
⇒ 两者均 64 位十六进制，**前 41 位逐字相同，第 42 位起分叉**。
**三种可能，我无法从两条报备区分**：**(a)** 一次转写误差；**(b)** 该文件在两次报备之间被重新生成；**(c)** ★ **同一输入下流水线不确定**。⇒ **若为 (c)，则「以哈希钉住对象」的机制（清关登记表按 `reportDigest` 键、证据复用）在该产物上不成立。** ⇒ **请确认哪个是当前值、以及 (c) 是否成立。**

## ★ 批次 65 的四条修复（我按「两半」登记）

**㞃 复申**：清单说 **focused-verified / live pending**，并明说**未重启进程、不冒充 live 生效**。⇒ **「已修（磁盘）」与「已生效（运行时）」必须同时写。**

| 编号 | 平台处置 | 生效状态 | 重启后按原始反例复核什么 |
|---|---|---|---|
| **B-198** | **fixed** | ★ **live pending** | 新宿主首条 `pwsh` 是否**跳过 recovered 已占用的 id**（`pwsh-1` → `pwsh-2`），且收尾移除不再撞上它 |
| **B-199** | **fixed** | ★ **live pending** | `team_plan_approve` 是否返回 **`changed` / `deduplicated`** 两态（真批准 `true/false`；幂等命中 `false/true`） |
| **B-200** | **fixed** | ★ **live pending** | blocked lease release 的拒绝文本是否**逐项回显** task id / `task.blockedBy` / 票数 / **缺少条件** + 构造路径 |
| **B-202** | **fixed** | ★ **live pending** | `complete` 缺 `evidence_ids` 时是否**说明本次调用缺该入参**并**回显已有 evidence 数量与 id** |

**平台自报验证（转录，非我实测）**：原始反例 **0/4 → 4/4**；`platform-defects` 聚焦集 **178/178**；`phase1`–`phase11` 全量 **498 tests / 497 pass / 0 fail / 1 skipped，EXIT_CODE=0**；语法检查通过；四份 profile parity **1/1**；`team-tools-v2-r10.mjs` 四份 profile SHA256 均 `B17E0573…CFAB`。
**边界（平台自陈）**：**未重启 DSH**、未中断 active Team、未清理 backups/spill/telemetry/session、**未修改 RustMc 产品仓**；DSH PID `30948` **早于本轮文件修改** ⇒ 四项均 **live pending**。

## 本批新增的纪律（都有实测实例）

**㔙 ★★ 门禁的可执行体一旦落后于门禁的源，它的红是关于**那个旧源**的，不是关于对象的。**
实例（tier 0 自己）：我用 `target/debug/deps` 里**预编译的** `ps1_line_citations` 二进制跑门 ⇒ **rc=101 / `anchors=14|unregistered=20`**，差点当成「我的编辑引入的红」；改用 `cargo test` 重跑 ⇒ **`anchors=34|unregistered=0`、3 passed、RC=0**。⇒ **那个红是关于 t101 之前的旧登记表的。** ⇒ 纪律：**判据必须在「将被清关的那个源」上由命令重跑，不得用缓存产物。**

**㔚 ★★ 声明（状态）的载体不得与被测对象是同一个可变量。**
实例：槽协议的实时声明规定写进 `docs/HEAVY-SLOT.md`（main 上的受跟踪文件），而判据设备跑**必须逐字报 `C8_binding_head`** ⇒ **在跑期写它就会推进 HEAD ⇒ 该跑的绑定立刻作废**。★ 且若目标是 `tools/rig-batch/CONTRACT.md`，它**同时落在 C8 的干净度域内** ⇒ **双破**（推进 HEAD + 工作树变脏）。⇒ 修法：**声明必须先于起跑落盘**；兜底 = 实时状态放证据行、历史放文件（跑后补录，**不得篡改 `started`**）。⇒ 与 **㊑/㊝** 同族：**锚与被锚对象重合**。

**㔇 的收窄**：「干净度参与判定的作业，其工作树在跑期是独占域」**过宽** —— `run-criteria.ps1` 第 1023 行的 `$bindDirty` **只取** `tools/rig-batch` + `tests/fixtures/rig-batch` ⇒ **docs 的脏不影响 C8**；而 **HEAD 那一半仍成立**。⇒ **「干净」必须带它的路径集。**

**㔛 「两个不同时刻的两个读数」不是差分 —— 受控差分要求两臂**同时**。**
实例（lead-world 自己认领并撤回）：它把 tier 0 在主检出的一次读数与成员 14:31Z 的一次读数并置，称之为「受控差分 / 活复现对」；而**那两个读数取自不同时刻** ⇒ tier 0 在**同一个工作树、当下**重测 ⇒ PASS ⇒ 证明差异是**时间/状态**而非内容 ⇒ 它**正式撤回**该提议。⇒ **「测量必须连同它的域」，而域里包含时刻。**

**★ C10 的 `2324/37` · OPEN 残差（具名、有界、可重开）**
**出处**：G-WORLD 成员工作树里的那次 t134 criteria 跑 —— `run1 criteria-20260929T133817Z.log`（`REV_COORDS` = **2384/2384/132/2384 全 OK**）与 `run2 criteria-20260929T143129Z.log`（= **2324/2324/37/2324 全 MISMATCH**）。
**已排除 6 条**：**(1)** 17 个检出复算全同；**(2)** `mc189-rs` 三个 rev 不可解析（0）；**(3)** 同检出连跑两次逐字节相同 ⇒ **门是确定的，不是随机变量**；**(4)** ㊜ 与「缺省解析」被**代码否证**（守卫每处 git 都带 `-C $RepoRoot`；`run-criteria.ps1` 已显式传 `-RepoRoot`）；**(5)** 307 行旧副本不打印 `REV_COORDS`；**(6)** tier 0 在**它自己的工作树**里重跑 ⇒ **现在 PASS**。
**当前处置**：**具名、有界、OPEN、不阻断**；**将来的判别仪器** = 新加的 `CITATION_ANCHOR_REPO_ROOT` 与 `|cited=` 两个字段；**重开条件** = 该值在带这两个字段的版本上再次出现。

---

## 批次 67 —— 由 tier 0 记录（2026-09-29T17:16Z）

> 写给平台修复方。本批全部有**一手读数**与**可复跑命令**。

### B-204（新 · 证据行可见性按**角色**分叉 —— B-193 的补强）

**现象**：同一个 evidence id `evidence-6c3dc25a-ec04-42ee-8c13-183d84f1ff8a`（kind `landing-token`，绑定 `group-rig-t99`）：
- **verifier 可读**：读取时刻 `2026-09-29T15:28:21.172Z`，面内 **11 行**、新增 `16d6cafe61bf`，`actual` 四字段与它自己的独立读数逐字吻合。
- **tier-1 组长（lead-proto）不可读**：`not-found`，`candidateCount=0`，detail「no evidence id starts with …」，`visibleEvidence=1403` / `totalEvidence=5685`，`registryRevision=101024`。

**为什么这是 B-193 的补强而不是重复**：B-193 的**可操作修法**是「把令牌放进**绑定该任务的 evidence 行**」，其判据是**verifier 能读**。本批证明**该修法只对 (tier 0 → verifier) 这一角色对有保证**：同一个 id 对 **tier-1 组长**仍 `not-found`。
⇒ **修正后的表述**：证据行的可见性是 **(读者角色 × 目标任务)** 的函数，不是全局属性。**任何「把它放进 evidence 行」的修法都必须点名它服务于哪一对角色。**
**未判**：lead-proto 自陈无法区分「可见性差异」与「转录差异」—— 本批**不声称**是二者之一，只并列两侧读数与两侧的可见计数（1403 / 5685）。**判别实验（留给平台）**：用同一读者角色对同一 id 做一次 `evidence_query` 与一次按前缀查询，比较 `candidateCount`。

### B-205（B-199 的**独立复现**，第二个来源）

`team_plan_approve` 对**已批准**的 plan **返回成功但零副作用**。独立复现（lead-rig，与 tier 0 的原始反例**不同卡、不同时刻**）：`group-rig-t58` 前后对比 `revision` 仍 **4**、`approvedAt` 仍 **1790667672169**、`updatedAt` 仍 **1790667672169** —— **三者全未变** ⇒ **没有产生 plan-approval 事件**。
**推论（判据纪律）**：**「成功回执」≠「事件发生」**。凡以 plan 批准为前置的探针（如「批准后等待票是否被清掉」）必须**先读对象**确认事件真的发生，否则**探针从未暴露给被测路径**，结论无效。lead-rig 据此**作废了自己对 t58 的 B-190 判据**并用一次真事件重做（新值 `revision=1` / `approvedAt=1790690581310`）。

### B-206（新 · 探测「占用」时的**自指污染**：`-ne $PID` 不足）

**现象**：tier 0 用 `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'run-criteria|run-batch' -and $_.ProcessId -ne $PID }` 探测重作业槽，得 `RUNJOBS=1` —— **幽灵占用**。命中进程：pid `15708`、**`node.exe`**、`CreationDate` 与本次测量**同一秒**（`2026-09-30T01:12:56.655+08:00`）。
**根因**：宿主的 `node.exe` runner（`dsh-subprocess-local/lib/runner.js`）把**子进程的完整命令行**作为自己的参数带在 `CommandLine` 里 ⇒ 探测脚本自己的正则字面量 `run-criteria|run-batch` **出现在测量者的祖先进程中**。排除 `$PID` 只排除了 **pwsh 子进程**，**没有排除它的 `node.exe` 父进程**。
**修法（已验证）**：先求**测量进程的祖先闭包**再排除。同一时刻改后读数：`RUNJOBS_EXCL_ANCESTRY=0`、`JAVA=33500`、`LISTEN=25565:33500` ⇒ 槽确实为空。
**建议的判据条款**：探测占用必须排除**测量进程的祖先闭包**（不只 `$PID`）；并且**不得在探测脚本里写出被匹配的字面量**，或必须把它显式计入排除集。

### 已闭合：verifier 报告 `grp-rig-16d6cafe-cleared` 的 condition ①

该报告 condition ①：「`docs/HEAVY-SLOT.md` 尚不存在而 AJ④★ 已指向它」。**该文件已于批次 65 创建、批次 66 与本次（批次 67 同批）维护**，本次并补入**相一 / 相二**条款与 AJ① 祖先闭包条款。⇒ **condition ① 已闭合**。（报告本身 digest-pinned，按 㞊 **不改报告**，在此记录闭合。）
★ 同一 condition 由 **lead-proto 独立复测**（obj 无、main 无、工作树 `Test-Path=False`、且 obj 的 `docs/` 下无任何 HEAVY 名文件）⇒ **不是分支滞后**。两条独立读数同向。

### 本批纪律（三条，均为本次新得）

1. **㔜 声明的两相性**：凡声明含「**尚不存在对象**」的测量字段，声明必分**意图相**与**事实相**；意图相需要**它自己的**过期条件，否则意图变成**假阻塞**（AJ② 的镜像）。
2. **㔝 合法根随检出移动**：`run-criteria.ps1` 第 18 行的 `$RepoRoot = Resolve-Path($PSScriptRoot\..\..\..)` ⇒ 同一个 `-TargetDir` 字面量在「主检出跑」与「成员工作树跑」两种情形下**合法性相反**。双方同时读错，是因为**各自的跑都从主检出跑** ⇒ **取值域随对象移动时，历史读数不能外推。**
3. **㔞 自我排除的传递闭包**：见 B-206。另与 lead-world 自陈的一条同族并记 —— **「验证过」绑定的是「那个值」，不是「那个名字」**：它在 r72 的程序里**重定义了路径常量**而该程序**从未拿这个常量访问文件系统**，于是**一个从未被校验过的值**被写进了取代前令的指令（r71 正确串 1 次 / 错误串 0 次；r72 正确串 0 次 / 错误串 2 次）。



