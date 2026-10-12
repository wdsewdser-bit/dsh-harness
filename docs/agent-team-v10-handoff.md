# Agent Team v10 Handoff

更新时间：2026-09-20  
范围：`D:\dsh-test`。生产 `D:\dsh` 未修改。  
基线：`agent-team-v9-handoff.md`。  
目标：修完最近一次真实运行暴露的 14 类 Agent Team 问题，并把因停电损坏的当前会话控制面恢复为可继续使用的状态。

## 1. 与 v9 的关系

v9 解决的是 milestone / compaction 生命周期，v10 解决的是实际运行后暴露的协作、相位、租约、合并和状态恢复问题。

### v9 已有且保留

- Room 每轮一名主发言、最多一次澄清、最多 3 轮。
- host 是参与者，child Room 依赖 parent Room 关闭。
- 普通消息静默，行动消息才唤醒。
- milestone job 优先，75% pressure safety 兜底。
- frozen member 不占活跃容量。
- 一次性提权和 turn 结束自动失效。

### v10 新增或修正

1. approved/rejected/blocked plan 在无 active lease 时可显式替换。
2. task phase 支持受控 `recover_phase`，不再只能前进。
3. acceptance packet 接受已越过目标 phase 的任务，不再强迫回退。
4. 组长可对本组 inactive 直属成员执行 `interrupt_agent`。
5. `interrupt_agent` 使用真实 root Team Lead 作为 domain authority，不再错误依赖组长与成员的 subagent ancestry。
6. group lead 可在 owner inactive 时把组板任务 reassign 给本组 tier-2 成员。
7. tier-1 / group / active-slot 配额改为 8 / 8 / 30；冻结成员不占有效配额。
8. `reconcileRegistry` 在旧 roster 不带 `frozen` 字段时保留冻结投影；显式 `frozen:false` 才清除，避免一次 `/team list` 或重启把冻结状态冲掉。
8. `team_merge` 支持 `ignore_untracked`；tracked dirty 永远仍被拒绝。
9. merge 成功必须通过 `merge-base --is-ancestor` 后置校验，并返回 `ancestorVerified`、`sourceSha`、`previous`、`changed`。
10. `team_room_resolve` 支持真实 unresolved id、空白归一化文本匹配和可用 id 错误提示。
11. dispatch 终态竞争改为幂等 no-op，不再产生 `completed -> delivery-failed` 噪声。
12. `team_delivery_check` 分开 `actionableOpenCount` 与 `noOwnerCount`，支持 `verdict` 过滤。
13. task view 返回 owner 推导出的 `branch`、`worktreePath`。
14. 带 `task_id` 的 `team_wake` / `team_wake_superior` 新增强制状态绑定：
    - 必须传 `based_on_revision` 与 `based_on_phase`。
    - 发送前状态已前进时硬拒绝 `instruction-stale`。
    - 投递消息携带 state snapshot 和收件前复核规则。
15. 修复 legacy milestone record 没有独立 compaction job 时的 idle fold 崩溃。
16. 修复 lifecycle 测试仍在加载 v9 以前的 milestone / step-compaction 入口。
17. 恢复 `session-7a601594-66f6-4255-92ba-1ef6813cbf1a` 因停电变成全零的 control-plane JSON。

### 2.1 统一消息投递（v10 后续补丁）

- `send_message` 现在必须传 `delivery`：`info` 为静默通知，`action` 为同级/向下唤醒，`decision` 为向上阻塞决策。
- 缺少 `delivery` 直接返回 `delivery-intent-required`，不会再默认静默成功。
- `action` 复用 `team-wake` dispatch/episode；`decision` 复用 `superior-wake` 并要求 direct superior、blocked_action、reason、evidence。
- 旧 `team_wake` 与 `team_wake_superior` 保留兼容，`wake:true` 映射为 `delivery:"action"`。
- 带 `task_id` 的 action/decision 继续要求 `based_on_revision` 与 `based_on_phase`。
- Web 活动入口由 `team-tools-v2-r6.mjs` 切到 `team-tools-v2-r7.mjs`；DSH 的 HMR 只监听 profile patch/config，不监听未列入 `hmr.root` 的插件源码，因此模块更新必须换新文件名并通过 patch 热重载。

## 2. 真实问题对应表

| 反馈 | 当前行为 |
|---|---|
| plan approved 后永久锁死 | `team_plan_propose(replace_approved:true, replace_reason:...)`，要求无 active lease |
| rejected 无法恢复 | `team_task_update(action:"reopen")` 可恢复 rejected/cancelled/expired |
| phase 不可回退导致 packet 死锁 | `recover_phase` 受控恢复；packet 对已越过阶段直接接受 |
| 组长不能打断成员 | tier-1 只能打断直属成员；授权由 root Team Lead 执行 |
| tier/group 配额不足 | tier-1 8、每组 8、active slots 30 |
| frozen 仍占容量 | policy 只统计未冻结、未 failed 成员 |
| untracked dirty 阻塞 merge | `ignore_untracked:true`；tracked dirty 仍拒绝 |
| merge 返回成功但未落树 | ancestry 后置校验；失败返回 `merge-postcondition-failed` |
| unresolved 用 `msg-*` 被拒 | 支持真实 `unresolved-round-...-n`，错误列出可用 id |
| packet 权限不明确 | tool description 和错误里明确谁可提交 |
| dispatch 状态噪声 | 终态竞争用 `ignoreTerminal` 幂等处理 |
| task id 猜测 | `team_task_create` 明确要求使用返回的实际 id |
| no-owner REF 混入待办 | `noOwnerCount`、`actionableOpenCount`、`verdict` 分离 |
| tier-0 指令基于过期状态 | task wake 必须带 revision/phase，过期硬拒绝；收件方也要复核 |
| 经常忘记使用 wake | `send_message` 的 `delivery` 必填；action/decision 直接进入唤醒路径，缺少 intent 硬拒绝 |

## 3. 关键文件

### Web

- `D:\dsh-test\home\profiles\web\plugins\team-control-plane.mjs`
- `D:\dsh-test\home\profiles\web\plugins\team-policy.mjs`
- `D:\dsh-test\home\profiles\web\plugins\team-tools-v2-r7.mjs`
- `D:\dsh-test\home\profiles\web\plugins\team-worktree.mjs`
- `D:\dsh-test\home\profiles\web\plugins\write-scope-guard.mjs`
- `D:\dsh-test\home\profiles\web\plugins\team-operator.mjs`
- `D:\dsh-test\home\profiles\web\plugins\step-compaction-v3.mjs`
- `D:\dsh-test\home\profiles\web\cordis.patch.yml`

### Headless

- `D:\dsh-test\home\profiles\headless\plugins\team-control-plane.mjs`
- `D:\dsh-test\home\profiles\headless\plugins\team-policy.mjs`
- `D:\dsh-test\home\profiles\headless\plugins\team-tools-v2.mjs`
- `D:\dsh-test\home\profiles\headless\plugins\team-worktree.mjs`
- `D:\dsh-test\home\profiles\headless\plugins\write-scope-guard.mjs`
- `D:\dsh-test\home\profiles\headless\plugins\step-compaction.mjs`
- `D:\dsh-test\home\profiles\headless\cordis.patch.yml`

Headless 的 tool entry 是 web r6 的同步副本，唯一允许的差异是：

```js
'./team-milestone-v2.mjs'
```

在 headless 中改回：

```js
'./team-milestone.mjs'
```

同步时不能只复制文件，复制完必须再次检查这一处 import。

### 身份与全局规则

- `D:\dsh-test\home\AGENTS.md`
- `D:\dsh-test\home\team-roles\AGENTS.md`
- `D:\dsh-test\home\team-roles\lead.md`
- `D:\dsh-test\home\team-roles\member.md`
- `D:\dsh-test\home\team-roles\verifier.md`

已要求所有带 `task_id` 的行动唤醒先读取最新 `team_task_get`，并携带 `based_on_revision` / `based_on_phase`。

## 4. 当前会话控制面恢复

目标会话：

```text
session-7a601594-66f6-4255-92ba-1ef6813cbf1a
```

恢复前状态：

```text
D:\dsh-test\home\team-control-plane\session-7a601594-66f6-4255-92ba-1ef6813cbf1a.json
```

文件大小 10,824,842 B，全部为 `0x00`，无法解析。

恢复来源：

1. 会话自身 `session.v3.jsonl.zstd` 中的 76 份完整 `/team meta` 快照，选最新 `seq=32165`。
2. 最后一次完整 backup：
   `D:\dsh-test\backup-freeze-limit-20260917-182740\team-control-plane.before-quiet-timeout-migration.json`
3. 34 MB audit：
   `D:\dsh-test\home\team-control-plane\session-7a601594-...json.audit.jsonl`
4. audit 中重新回放 plan/proposed 与 plan/approved，补齐 483 份计划记录。

恢复结果：

```text
Bytes:       8,056,617
SHA-256:     9761685DD71421FCA0F6D75C3EC8D1F36103DA4F1CA5E4C201F8714C5104F462
Root:        session-7a601594-66f6-4255-92ba-1ef6813cbf1a
revision:    81968
rooms:       7
rounds:      3
plans:       483
boards:      6
dispatches:  1430
leases:      92
activeLease: 0
health:      healthy
```

恢复后检查：77 个 open task；open task 中没有引用不存在 evidence 的记录；18 个 open scoped task 中有 8 个历史任务没有 plan 记录，因此若继续这些旧任务，应先重新 `team_plan_propose` / `team_plan_approve`，不要直接执行。历史 completed task 的 evidence 引用有部分只剩 ID、原始 payload 不在旧 backup 中，但不阻塞新任务和当前 open task。

损坏文件与 audit 已在覆盖前备份：

```text
D:\dsh-test\recovery-20260920\session-7a601594.zeroed-before-restore.json
D:\dsh-test\recovery-20260920\session-7a601594.audit-before-restore.jsonl
```

可重复执行的恢复工具：

```text
D:\dsh-test\tools\inspect-zstd-jsonl.mjs
D:\dsh-test\tools\extract-team-state-from-session.mjs
D:\dsh-test\tools\build-team-state-from-meta.mjs
```

恢复脚本只用于这次掉电恢复。不要在没有新备份的情况下对生产 `D:\dsh` 直接执行。

## 5. 验证

已执行：

```powershell
node --check home\profiles\web\plugins\team-tools-v2-r6.mjs
node --check home\profiles\headless\plugins\team-tools-v2.mjs
node --check home\profiles\web\plugins\step-compaction-v3.mjs
node --check home\profiles\headless\plugins\step-compaction.mjs

Get-ChildItem D:\dsh-test\phase1-tests,D:\dsh-test\phase2-tests,D:\dsh-test\phase3-tests,D:\dsh-test\phase4-tests,D:\dsh-test\phase5-tests,D:\dsh-test\phase6-tests,D:\dsh-test\phase7-tests,D:\dsh-test\phase8-tests -Filter *.test.mjs -File |
  ForEach-Object { node $_.FullName }
```

结果：

```text
PHASE1_8_ALL_TESTS_PASS
```

恢复后的 control-plane 已用当前 web 插件重新加载，未启动 DSH 进程；加载结果见第 4 节。

## 6. 下一步接手

1. DSH 启动后先打开 `session-7a601594`，确认 Team / Room / Board 页面能加载。
2. 如果恢复后的旧 dispatch 仍产生红色历史记录，先检查其 `resolvedAt`，不要重新投递已终态消息。
3. 任何新 task wake 必须带当前 revision/phase，不能省略。
4. 不要把 `team-tools-v2-r6.mjs` 直接复制到 headless 后忘记修改 milestone import。
5. 不在 `D:\dsh` 生产目录上修复，除非用户明确要求同步。
