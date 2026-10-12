# Agent Team v2 收尾计划（剩余三项）

> 立此文档的目的：把剩下要做的事、为什么做、怎么验收写死在这里，避免跨会话丢失上下文。
> 主设计文档见 agent-team-v2-design.md（§0-§33 是已完成部分）。

## 现状基线

- 已完成：分级/分组/配额/冻结、分级任务板、verifier 工作流、人类操作者通道、
  原面板就地改造（级别+分组+身份标签）、写域硬隔离、SoL-Pi 三机制 + 一个折中、
  身份文件（team-roles/lead.md, verifier.md, member.md + custom）。
- 已按文档对齐：tier 0 只与 tier 1 通信、tier 0 看不到 tier 2、全局板只追加（禁 edit/delete/reassign）、
  claim 必须非空 write_scopes 且不得越出成员声明写域、冻结不占配额、maxLifetimeCreates=26、
  tier 0 有 group-root 板。
- 全 9 个测试套件绿。测试实例 web profile，端口 40123，DSH_HOME=D:/dsh-test/home。
- **已知根本缺陷：两个真相源。** tier/group/parent/frozen 存在 DSH_HOME/team-registry.json，
  domain 的成员记录里没有；跨进程/重启读不到就退化成"未登记级别"（§32），
  早期还导致过"召唤不了"（§28/§29）。

---

## A. fork domain —— 根治两个真相源（做）

动机：不 fork 就加不了成员字段和事件类型，只能靠外部文件旁路，而旁路已经出过两次故障。

改动（fork @deepseek-ai/dsh-experimental-agent-team）：
1. MemberRecord 增加 level、groupId、parentName、route、frozen、frozenAt?。
2. 事件：team/member/spawned 扩展 payload；新增 team/member/frozen、team/member/restored、
   team/member/route-changed；team/task/created 增加 scope。
3. invariant.ts 把新事件加入 append 前回放校验。
4. 配额：maxMembers 的"在册"计数排除 frozen；新增 maxLifetimeCreates。
5. 删除旁路：删掉 team-registry.json、registry store（serialize/merge/attach/persist）、
   /team meta 的 Remote 旁路；面板改为直接从 remote.agentTeams.view() 读 level/groupId。

验收：
- 删掉 DSH_HOME/team-registry.json 后重启实例，面板仍正确显示级别/分组/身份。
- 两个并发会话各自的 Team 互不污染（spawn 不串台）。
- 域内测试 + 全 9 套件绿。
- 重启后 /team list 不依赖任何外部文件。

风险：上游升级需重放补丁 -> 用现有 patch 脚本模式（参照客户端面板 patch-console.mjs）。

---

## B. 步骤边界压缩（SoL-Pi Online Context Compact，做）

原理（官方）：完成的计划步骤成为原生 compaction 的候选点，附带经济性检查与窗口压力检查；
压缩成功后在新回合继续任务。核心价值是"在语义边界压缩"，而非固定百分比。

我们的差距：只有 DSH 原生的压力触发，没有"完成的计划步骤"这个触发点。

改动：
1. 触发信号：todo_write 中某项迁移到 completed。
2. 两道闸：经济性（预计节省 > 阈值）+ 窗口压力。
3. 动作：请求一次 compaction；压缩后开新回合继续任务。
4. 与 DSH 原生压力触发去重，避免同一轮压两次。

验收：长会话中 compaction 落在步骤边界而非百分比阈值；日志可证明经济性判断生效
（不划算时不压）。真实长会话校准阈值。

风险：与原生 compaction 冲突 -> 必须有优先级与去重。

---

## C. worktree 隔离 + 合并工具（做全量）

决策（用户已定）：不加专职合并角色（13 人上限不变），合并做成工具 + 审批。

拓扑：
- main 主线
- team/<group> 组长集成分支
- team/<group>/<member> 组员工作分支
- 组长也有自己的 worktree（全量版，不是最小版）
- verifier：只读 worktree，检出被验收的组长集成分支

工具 team_merge(target)：
- 动作是代码：合回父分支、用 git 退出码判定干净/冲突、干净则自动跑该任务的验收命令。
- 组员 -> 其组长分支：只能由派他的那个组长发起。
- 组长分支 -> main：只能由 tier 0 发起，且必须已有 verifier 对该 commit 的无 blocker/major 记录，
  否则直接拒绝。
- 冲突不自动裁决：把冲突文件 + 双方 diff 交给共同上级（同组 -> 组长；跨组 -> tier 0），
  他们只做"选哪边"的审批，不写代码。

硬约束（代码强制）：
- tier 0 开工前必须 git init 并建立分支拓扑（属于"冻结契约"的一部分），否则拒绝开 worktree。
- 只有 spawning lead 能 merge 自己的组员。
- 只有 tier 0 能 merge 到 main。
- 无 verifier 通过记录时 merge 到 main 被拒。

验收证据：
- e2e：两个组员改相邻文件 -> 互不覆盖 -> 合并后主线同时包含两者。
- 冲突场景：制造冲突 -> 被拒且升级给正确上级。
- 工作目录不是 git 仓库时明确拒绝。

风险：worktree 之间 node_modules 不共享（有依赖的项目需各自 install）；磁盘占用 × worktree 数。

---

## 执行顺序

A -> B -> C。A 是根（先解决真相源），B 独立，C 依赖 A 的分组/父子关系（合并归属要用到 parent）。

---

## B 补充：上游 API 勘察结论（2026-09-13，实测）

包：`@D:/dsh-test/app/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js`@

### 已有能力

1. `@compactIfNeeded(agent, trigger, signal)`@ —— trigger 只接受 `@"pressure"`@ / `@"context-overflow"`@。
   内部是**纯阈值**判断：`@{totalTokens < spec.thresholdTokens} -> return null`@。
   **没有经济性判断，也没有"计划步骤完成"这个触发点。**
   它的 JSDoc 写的是 "replayed **step-boundary** pressure"，但那指的是
   *在*步骤边界被调用，不是*因为*步骤完成而触发。这正是 SoL-Pi 与我们的差距。
2. `@compactNow(agent, signal, sourceCommandId)`@ —— **低于阈值也能强制压一次**的钩子。
   要求 agent 处于 idle（有排队唤醒工作时抛 `ManualCompactionError("busy")`@）。
   内部用当前 token 测量选一个可压缩区间（`selectCompactableRange`），没有经济性门。
3. `@compactRegion(start, end, agent, signal)`@ —— 压显式区间。
4. `assertNoActiveCompaction(session, reason)`@ —— 已有压缩在跑时抛错，
   **原生压力路径的去重就靠它**。
5. `@dsh-command-compact`@ 包已经存在 —— `/compact` 走的就是 `compactNow`。

### 因此 B 的实现方案（收敛了）

- **触发点**：`todo_write` 里某一项迁移到 `completed`（这是"完成的计划步骤"信号）。
- **动作**：调 `@ctx.compaction.compactNow(agent, signal, cmdId)`@。
- **两道闸**（我们补的，上游没有）：
  1. **经济性**：预计节省（可压缩区间的 token 量）必须超过阈值，否则不压 ——
     这是 SoL-Pi 的核心，避免"压了但没省"。
  2. **窗口压力**：只有在窗口压力超过某下限时才值得压（压力很低时压缩收益为负）。
- **去重**：调用前检查 `assertNoActiveCompaction` / 捕获 `ManualCompactionError("busy")`，
  并且给同一回合打标记，避免原生压力路径紧接着又压一次。
- **不需要新增触发事件、不需要改 domain**：`todo_write` 在我方工具层，
  拿得到 `exec.agent`。

### 待确认

- `todo_write` 是否只是 DSH 内置工具（能否从插件层观察到它的调用/结果）。
  若不能，退路是：我方 Team 层提供自己的 todo 工具，或在 `tools/post-execute` 类事件上挂观察。


## 每次改动后的固定动作

1. 跑全 9 个套件，必须全绿。
2. 重启测试实例（40123），确认干净启动。
3. 把执行记录追加到 agent-team-v2-design.md（含诚实记录的未验证项）。
