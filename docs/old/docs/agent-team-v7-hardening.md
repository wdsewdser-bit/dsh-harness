# Agent Team v7 Hardening

更新时间：2026-09-16

本文记录 v6 之后的运行时加固，重点解释真实会话中暴露的 root 写权限、Room 等待空转和 provider 额度处理。实现只在 `D:\dsh-test` 测试实例；生产目录 `D:\dsh` 未应用。

## 1. Root 写作用域修复

真实故障：tier 0 的 root 已创建 `group-root` edit task、批准 plan、获取 active lease，但 `write` 仍被 `write-scope-guard` 拒绝：

```text
write denied: this member has no declared write scope
```

根因是成员名解析不一致。root Agent 没有 `agent.name`，旧 guard 回退到 `agent.id`（session id），而 plan lease 记录的是 Team membership 名 `lead`，因此 guard 找不到 lease，误判为无 scope。

修复：

- 从 `ctx.agentTeams.tryMembership(agent)` 或 agent-local Team service 解析稳定成员名。
- 成员名优先使用 membership.name，其次 agent.name，最后 agent.id。
- active plan scope 通过 `controlPlaneForMember()` 解析，保持与工具层一致的 Team root 候选逻辑。
- root 的 byName scope 不再受缺失 agentTeams service 的旧 fixture 影响。
- 错误信息现在包含解析出的成员名、任务 id 和 plan scope，便于定位。

回归：

- `phase1-tests/write-scope-guard.test.mjs`
- `phase7-tests/write-scope-active-plan.test.mjs`
- 新增 root 无 name、membership name=lead、lease member=lead 的真实形状测试。
- 真实工具链路 E2E：root 创建 edit task → plan propose/approve → acquire lease → 写入 `docs/probe.md` → evidence → complete，全部通过。

## 2. Room 等待硬门禁

Room 快照新增：

```text
waitAction = speak | close | stop
waitInstruction
```

- `speak`：立即用 `team_room_post` 发一次主发言。
- `close`：host 立即用 `team_room_close` 收口。
- `stop`：立即结束当前 turn，等待 Room handoff 主动唤醒。

同时：

- tier 2 调用 `wait_agent` 不再真正等待，立即返回 `room-turn-pending`。
- Room 参与者即使正好是 `nextSpeaker`，调用 `wait_agent` 也只收到“立即发言并结束”。
- 标准 `level:1` / group Room 尚未建立时，read 返回 `not-open + waitAction=stop`，不再抛 `room-not-found`。
- Room wake 文案明确要求结束 turn，不调用 `wait_agent`。

## 3. Provider 额度处理

- 带 reset 时间的 weekly/monthly quota 429 被视为 terminal provider failure。
- 普通短时 429 仍交给重试策略。
- Team 进入 provider-blocked 后，成员模型步骤被硬拒绝，必须修复额度后由 root 调用 `team_provider_resume`。

## 4. 提示词和角色文件

已同步：

- `D:\dsh-test\home\AGENTS.md`
- `D:\dsh-test\home\team-roles\AGENTS.md`
- `D:\dsh-test\home\team-roles\lead.md`
- `D:\dsh-test\home\team-roles\member.md`
- `D:\dsh-test\home\team-roles\verifier.md`

补上的规则：

- 所有角色严格按 `waitAction` 行动。
- Room 等待禁止 `wait_agent`、sleep、轮询、重复读取。
- discussion/review 任务凭 evidence 完成；edit 任务需要 write scopes、approved plan、active lease 和 commit SHA。
- 未决项用 `team_room_resolve` 销账。
- 创建预算与当前 profile 的 `maxMembers=20` 一致。

## 5. 关键文件

测试实例：

- `D:\dsh-test\home\profiles\web\plugins\write-scope-guard.mjs`
- `D:\dsh-test\home\profiles\headless\plugins\write-scope-guard.mjs`
- `D:\dsh-test\home\profiles\web\plugins\team-tools-v2.mjs`
- `D:\dsh-test\home\profiles\headless\plugins\team-tools-v2.mjs`
- `D:\dsh-test\home\profiles\web\plugins\team-runtime-guard.mjs`
- `D:\dsh-test\home\profiles\web\plugins\team-idle-watch.mjs`
- `D:\dsh-test\home\write-scopes.json`

## 6. 验证

全量：

```powershell
$tests = Get-ChildItem 'D:\dsh-test\phase1-tests','D:\dsh-test\phase2-tests','D:\dsh-test\phase3-tests','D:\dsh-test\phase4-tests','D:\dsh-test\phase5-tests','D:\dsh-test\phase6-tests','D:\dsh-test\phase7-tests','D:\dsh-test\phase8-tests' -Recurse -File -Filter '*.test.mjs' | ForEach-Object FullName
node --test $tests
```

当前基线：31 个测试文件全部通过。

真实浏览器测试至少覆盖：

1. 两个组长在 `level:1` 各一次主发言，host 收口。
2. 两个组长各 spawn 两个组员，组内 Room 各一轮。
3. 父 Room 关闭前子 Room 被 `room-dependency` 拒绝。
4. 子代理 `wait_agent` 调用数为 0，全部由 Room handoff 唤醒。
5. root edit task 能在 active plan lease 下真实写入。

## 7. 升级易失点

重装 `@deepseek-ai/dsh-experimental-*` 后必须重新检查：

- `write-scope-guard.mjs` 的 membership 名解析和 root plan lease 解析。
- web/headless 两份 guard 哈希一致。
- `write-scopes.json` 必须保持 `defaultDeny:true`，否则 web profile 健康检查会进入 degraded。
- `team-tools-v2.mjs` 的 `waitAction`、room dependency、discussion/edit task 分流。
- `team-runtime-guard.mjs` 的 terminal quota 分类。

## 8. v7.1 Worktree / Scope 修复

真实会话 `session-6cb90936-03b9-4c8f-9328-0f2bcdaa94a4` 暴露了 worktree 与 scope 锚点不一致：

- 子会话 cwd 继承父会话 `D:\dsh-test\workspaces`，而仓库实际在 `mc189-rs`。
- `team_worktree_setup` 默认 `repo=process.cwd()`，因此 worktree 创建在 `workspaces/.dsh-worktrees`，不是仓库下。
- plan 中的相对 scope（如 `docs/plan/07-roadmap.md`）按全局 rootDir 解析到 `workspaces/docs/plan/...`，成员写仓库路径时被拒。
- 部分成员改用 `bash`/`pwsh` 写文件，绕过 `write-scope-guard`，把文档静默写到错误目录。

修复：

- `write-scope-guard` 同时按配置 rootDir 和 session cwd 解析 plan/static scope。
- shell 工具增加 `tools/pre-execute` 写入检查，覆盖重定向、Set-Content/Out-File、cp/mv/rm/touch/mkdir 等显式写入。
- lease 默认从 10 分钟延长到 30 分钟，并在成员每次 `agent/pre-step` 自动 heartbeat。
- `send_message.message` 接受 content-block 数组并规范化为字符串。
- `team_plan_propose.checks` 接受数组并规范化为对象，避免 schema 校验中断。

回归：

- `phase7-tests/write-scope-active-plan.test.mjs` 覆盖 repo cwd scope 与 shell 越界拒绝。
- 全量 31 个测试文件通过。
- 真实 E2E：`mc189-rs/docs/plan` 写入成功；`mc189-rs/src/escape.md` shell 写入被 `FS_WRITE_OUT_OF_SCOPE` 拒绝；lease 正常完成。

旧会话残留：

- `D:\dsh-test\workspaces\docs\plan\06-porting-strategy.md`、`07-roadmap.md`、`08-verification.md`、`09-risks.md` 等文件是旧 scope 错位时写下的副本。
- 它们未自动迁移，避免覆盖成员 worktree 中可能存在的正确版本。需要按任务 owner 与 worktree 内容人工比对后合并。
