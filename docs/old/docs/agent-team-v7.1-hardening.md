# Agent Team v7 Hardening Handoff

更新时间：2026-09-16

本文记录 v6 后针对真实两级 Room 测试暴露的问题所做的硬约束修复。生产目录 `D:\dsh` 未修改。

## 已修复

1. `lead` 作为 Room 下一位 speaker 时，由上一实际发言者投递唤醒，不再被 mailbox 判定为 self-message。
2. 任务增加 `workKind`：
   - `discussion` / `review`：无 write scope，凭已落库 evidence 完成。
   - `edit`：必须声明 write scope，并继续经过 plan、lease、commit 门禁。
3. group Room 在有 `level:1` 父轮次时自动继承依赖；父轮次关闭前，子轮次启动被硬拒绝。
4. tier 2 不能自行创建或预开 Room。
5. 组员在 Room 尚未创建时 join/read 返回 pending/stop 语义，不再产生 `room-not-found` 错误；之后由 Room handoff 正常唤醒。
6. 未决项改为结构化 durable 条目，并新增 `team_room_resolve` 销账。
7. idle 进度哈希忽略任务创建、claim 和 revision-only 变化，只认终态任务、room 摘要/决议/未决项解析、escalation 和 packet。
8. 非当前 speaker 调用 `wait_agent` 时返回 `room-turn-pending`，明确要求结束当前 turn。
9. 带 reset 时间的 weekly/monthly 429 被 runtime guard 判定为 terminal provider failure，不再反复重试。
10. Room ID 错误会返回 canonical 示例，例如 `level:1`。
11. `team_room_read` 新增 `waitAction`：
    - `speak`：立即发一次主发言；
    - `close`：host 立即关闭轮次；
    - `stop`：立即结束 turn，由 Room handoff 主动唤醒。
12. Room 等待硬禁止 `wait_agent`：
    - tier 2 调用 `wait_agent` 时永远即时返回 no-progress，不会真正等待；
    - Room 参与者即使正好是 `nextSpeaker`，调用 `wait_agent` 也只会收到“现在发言并结束 turn”；
    - 系统提示词、`AGENTS.md`、`lead.md`、`member.md`、`verifier.md` 已同步。
13. 标准 `level:1` 或 group Room 尚未创建时，`join/read` 返回 `not-open + waitAction=stop`，避免启动竞态产生 `room-not-found`。
14. global/domain 双状态源修复：
    - `advance_phase` 只写本地 control plane；domain 调用在执行前重新绑定 domain revision，不再把本地 revision 当作 domain CAS。
    - `team_task_list`、`team_delivery_check`、`/team meta` 以本地 status/phase/revision 覆盖 domain 的旧状态，避免本地已完成但面板仍显示 pending。
    - `team_task_reconcile` 不再接受凭空 evidence；它只能把 global 引用任务关联到同 Team 已完成、带 exact commit 和 evidence 的组板/level 板源任务。
15. `team_plan_propose` 允许在计划仍是 `plan-proposed` 时原位修订；批准后的计划不可静默改写。
16. worktree/merge 默认仓库根从 caller session cwd 与 approved plan 的 write scope 推断，不再默认落到 DSH worker 的 `process.cwd()`；显式 repo 必须是 git 仓库。
17. shell 写入门禁改为 fail-closed：内联解释器、动态变量目标、管道执行等无法证明目标在 scope 内的写法直接拒绝，必须使用受控 `write/edit`。
18. 任务完成顺序在 AGENTS.md 和角色文件中固定为：写入 → evidence → 持租约 complete → release lease。
19. `team_run_lease release(status="completed")` 现在会在关联任务仍未 completed 时硬拒绝；不再允许“先释放租约，再完成任务”的旧顺序。
20. delivery gate 对 `delivery-reference` 做源任务二次校验：只有引用任务和目标源任务都 completed、且 exact commit 一致时才视为已交付，避免面板/domain 旧状态重新阻塞已完成的 global 引用任务。

## 主要文件

- `home/profiles/web/plugins/team-control-plane.mjs`
- `home/profiles/web/plugins/team-tools-v2.mjs`
- `home/profiles/web/plugins/team-idle-watch.mjs`
- `home/profiles/web/plugins/team-runtime-guard.mjs`
- `home/profiles/web/plugins/team-policy.mjs`
- `home/profiles/web/node_modules/@deepseek-ai/dsh-experimental-client-ui-agent-team/lib/client.js`
- `phase8-tests/team-hardening.test.mjs`

headless 目录中的 control plane、tools、idle watch、runtime guard 和 policy 已与 web 版本逐文件同步。

## 验证

全量回归：

```powershell
$tests = Get-ChildItem .\phase1-tests,.\phase2-tests,.\phase3-tests,.\phase4-tests,.\phase5-tests,.\phase6-tests,.\phase7-tests,.\phase8-tests -Recurse -File -Filter *.test.mjs | ForEach-Object FullName
node --test $tests
```

结果：`31 tests / 31 pass / 0 fail`（新增覆盖 phase/revision 分叉、global reference reconcile、shell opaque write、面板/列表状态投影）。

真实 Web 测试使用原始提示词：

```text
召唤两个组长 然后再让两个组长先进行模拟讨论一轮后让他们分别召唤两个组员 进行模拟讨论一轮 进行测试 不要太长 本次只是测试系统
```

成功会话：`session-581afa6e-ea62-414f-be0c-e96ed688a3d1`。

- `level:1` 于 `23:17:16` 关闭。
- 两个 group round 分别在 `23:17:18` 和 `23:17:19` 开启。
- 三条 round 全部关闭，无 unresolved。
- 无 delivery failure、run failure 或 room dependency 泄漏。
- 6 名参与成员停止，root `team_delivery_check` 返回 `deliverable=true/openCount=0`。
- 无文件写入。

`waitAction`/no-wait 复测又连续运行两次：

- `session-73f91de1-338d-4b69-a71b-c17d19a7145d`
- `session-7c48b8d1-007b-4d58-a2fa-d6a99c37aef4`
- `session-0671b403-1666-4e5b-ba1d-e0d0fb0a7d12`

三个会话的子代理 `wait_agent` 调用数均为 `0`。最后一次复测无 Room 启动竞态；唯一工具拒绝是组员未携带 evidence 完成 discussion task，门禁要求补证据，属于预期硬约束。

另有一次 `cmd` 真实测试因供应商 weekly usage limit 在业务链路完成前终止。该 429 已用于补强 runtime guard 测试；正式验证随后临时使用官方 DS，验证后已恢复原 `cmd` 优先配置。
