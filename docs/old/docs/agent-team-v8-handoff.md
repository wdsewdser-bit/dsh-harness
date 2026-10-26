# Agent Team v8 Handoff

更新时间：2026-09-17  
范围：`D:\dsh-test`。生产 `D:\dsh` 未修改。  
基线：`docs/agent-team-v7-hardening.md` 与 `docs/DSH-0.1.6-COMPATIBILITY-PLAN.md`。

本文不是重写历史，而是记录 v7 之后到当前状态的差异、新增能力、真实验证结果和接手入口。下一位接手者应先读本文，再按需要回看 v7 和 0.1.6 兼容计划。

后续更新：里程碑与压缩部分已被 `agent-team-v9-handoff.md` 修正并取代。本文保留 v8 当时状态；当前接手以 v9 和活动 `cordis.patch.yml` 为准。

## 1. 与旧文档的关系

### v7 已覆盖

v7 主要解决两级 Room 测试暴露的问题：

- Room speaker handoff、parent round 依赖、未决项销账。
- `waitAction` 与禁止 `wait_agent`。
- `workKind`、write scope、plan、lease、完成顺序。
- global/domain 双状态源、worktree 推断、shell opaque write fail-closed。
- delivery reference 的源任务校验。

### v8 新增或明确变更

v8 不是 Room 的补丁集，而是 v7 之后的系统级收口，主要新增：

1. 冻结语义和活跃容量语义。
2. 一次性提权（privilege request/review/activate/end）。
3. `team_wake_superior`，并明确普通消息静默。
4. Room 从“默认 1+1、可讨论不足”升级为“最多 3 轮，host 纳入 members，第三轮后必须升级”。
5. 里程碑 v3：Team 隔离、history、revision、独立 compaction job、stale 清理。
6. 压缩与里程碑解耦：hard-threshold 压缩不消耗 milestone job。
6. 压缩只接受已完成的 milestone job；75% 上下文压力改为硬拒绝门，不再自动 fold。
7. 普通 quiet dispatch 直接 completed，不再进入 5 分钟超时墙。
8. 新增 `team_compaction_reconcile`。
9. 控制面板 tabs：members、frozen、boards、rooms、dispatches。
10. `in-history` system prompt update 补丁，避免动态 milestone 改写缓存前缀。
11. pnpm 持久 patch：四套补丁登记到 web/headless workspace + lock。
12. Stagehand Anthropic 兼容路由和原生 CUA 安装适配。

## 2. 当前系统结构

### 2.1 配额与层级

当前配置以 `home/profiles/{web,headless}/cordis.patch.yml` 为准：

```yaml
maxTier1Leads: 3
maxVerifiers: 1
maxMembersPerLead: 3
maxMembers: 30
maxRoomRounds: 3
```

语义：

- tier 0 root 不占 teammate 配额。
- tier 1 最多 3 个组长 + 1 个 verifier。
- 每组最多 3 个 tier 2 成员。
- 活跃成员总容量 30。
- 已冻结成员不占活跃容量，保留 session，默认隐藏。
- 不再存在终身创建次数上限。
- spawn 失败不再永久占用名字或容量。

### 2.2 冻结

实现分布在：

- `home/profiles/web/plugins/team-policy.mjs`
- `home/profiles/web/plugins/team-control-plane.mjs`
- `home/profiles/web/plugins/team-tools-v2.mjs`
- `home/profiles/web/plugins/team-idle-watch.mjs`

行为：

- `freeze_member` 由 tier 0 控制。
- 冻结后不能收发消息、不能被打断、不能被冷启动唤醒、不能 spawn。
- `list_agents` 默认隐藏冻结成员；`include_frozen:true` 才显示。
- `/team list --frozen` 查看冻结成员。
- `/team restore <name>` 或 `freeze_member(frozen:false)` 恢复。
- 冻结是活跃容量控制，不是删除，也不清 session。

### 2.3 一次性提权

新增工具：

- `team_privilege_request`
- `team_privilege_review`
- `team_privilege_status`

流程：

1. 组长或组员被 fail-closed 门禁挡住且动作确实必要。
2. 提交 blocked action、reason、至少一条 evidence、可选 requested scope。
3. 只有 tier 0 能批准或拒绝；申请人不能自批。
4. 批准后不是立即生效，而是在该成员下一次唤醒时激活。
5. 授权只覆盖一个 turn，turn 结束或超时自动失效。
6. 它只绕过写范围等运行时门禁，不放宽身份、跨组、任务所有权或 Room 结构权限。

关键文件：

- `team-control-plane.mjs`：`privilegeRequest/Approve/Reject/Activate/End/Active`
- `team-tools-v2.mjs`：三个模型工具
- `write-scope-guard.mjs`：活动授权时跳过 scope 拒绝
- `team-runtime-guard.mjs`：活动授权时允许被阻断动作继续

### 2.4 上级唤醒

新增 `team_wake_superior`：

- tier 2 只能唤醒自己的直属组长。
- tier 1 只能唤醒 tier 0。
- 必须附 blocked action、reason、evidence。
- 同一未处理请求按 member/target 合并，避免重复轰炸。
- 普通进度继续用静默 `send_message`，不得唤醒上级。

### 2.5 Room

Room 当前规则：

- 一个 Room 同时只能有一个 open round。
- 最多 3 轮。
- host 必须是本轮参与者；未显式列出 host 时 runtime 追加到最后。
- 每名参与者一次主发言，一次最多 800 字符澄清。
- 只有 host 或 tier 0 能开/关轮次。
- host 只有在所有参与者完成主发言后才能关闭，并写 summary + unresolved。
- 第三轮关闭后仍有 unresolved，不得重开同一 Room，必须 `team_escalate`。
- 已解决的 unresolved 用 `team_room_resolve` 销账。
- group room 在 `level:1` parent round 未关闭前不能开轮。

`team_room_read` 返回 `waitAction`：

- `speak`：发一次主发言。
- `close`：host 关轮。
- `stop`：立即结束 turn，系统会在轮到该成员时主动 handoff。

Room 等待禁止 `wait_agent`、sleep、轮询和重复读取。

### 2.6 控制面板

上游 `@deepseek-ai/dsh-experimental-client-ui-agent-team` 的 panel 通过 pnpm patch 扩展为 tabs：

- Members
- Frozen
- Boards
- Rooms
- Dispatches

Rooms tab 支持查看 room 列表、round、speaker、summary、messages、unresolved、decisions。

Dispatches tab 显示状态、sender/target、queue age、attempt、last error；quiet notice 不再长期显示为 timed-out。

## 3. 里程碑与压缩

### 3.1 里程碑 v3

文件：`home/team-milestones.json`

结构：

```json
{
  "version": 3,
  "teams": {
    "<team-membership-id>": {
      "members": {},
      "bands": {},
      "compactions": {},
      "history": {}
    }
  },
  "members": {},
  "bands": {},
  "compactions": {},
  "history": {}
}
```

要点：

- Team 按 membership.id 隔离，`lead` 等同名成员不再跨会话污染。
- `history` 保存最近 20 个 milestone revision，支持“先 done，再 set 下一个”的正常工作流。
- `compactions[owner]` 独立保存 pending job，不再挂在 milestone record 上。
- job 记录 `milestoneSetAt`，只有能证明该 revision 已完成时才可消费。
- 只有已完成并 armed 的 milestone job 会触发 fold；上下文压力本身永远不产生 fold。
- 达到 `rejectRatio`（默认 75%）且没有 armed milestone 时，pre-step 硬拒绝下一步，不压上下文、不自动折。
- preset 内的 `compaction-basic.auto` 必须为 false；`/compact` 手工命令仍保留。启动器用 `patch/ensure-milestone-only-compaction.cjs` 幂等维持该配置。
- `team_compaction_reconcile` 用于清理/收敛 stale 或误挂的压缩作业。

### 3.1.1 20 万上下文仍反复压缩的根因（2026-09-18）

这不是 75% 阈值被 20 万 token 提前命中。实际原因是一个旧 milestone job 在成功后没有被稳定消费，随后每个 idle 都重复执行：

- `team-tools` 曾把 `team-milestones.json` 缓存在进程内，并在后续 pre-step 保存整个旧快照；`step-compaction` 写回的 `compacted/consumed` 状态因此可能被覆盖，pending job 复活。
- 实例 `81e4f948...` 在 20:31 压缩前最后一次真实 usage 只有约 125k，窗口为 1M，绝不可能命中 75%；但它有一个更早 tick 的 member-math job，属于重复消费。
- 修复：`team-tools` 每次访问 milestone 文件都重新读取，并在阈值提醒保存前再次刷新；`step-compaction` 只接受 pending milestone job；`compaction-basic.auto=false` 阻断原生自动链。

### 3.2 缓存与 system prompt

动态 milestone 不再注入 system prefix，而是通过 pre-step 追加到请求尾部。

配套的 `llm-pi-ai` patch 增加 `systemPromptUpdate: "in-history"`，使系统提示变化按历史消息处理，避免破坏服务端缓存前缀。

### 3.3 当前里程碑数据

截至 2026-09-17 21:23：

| Team | Members | Pending | Compacted | Stale |
|---|---:|---:|---:|---:|
| `session-97fc2cc5-e304-4faf-b042-10388fde41ea` | 1 | 0 | 1 | 0 |
| `session-af99edf0-9d6c-412f-82f8-1d5b99c52dc6` | 1 | 0 | 1 | 0 |
| `session-6cb90936-03b9-4c8f-9328-0f2bcdaa94a4` | 10 | 0 | 2 | 0 |
| `session-7a601594-66f6-4255-92ba-1ef6813cbf1a` | 14 | 7 | 3 | 3 |

`session-7a601594...` 的 pending/stale 是历史迁移残留，不是当前正常运行中的任务。不要直接删除文件；先备份，再用 `team_compaction_reconcile` 或针对该 Team 的确认脚本处理。

## 4. 投递与 idle

### 4.1 quiet dispatch

修复前：普通 `send_message` 写为 delivered/queued 后无人唤醒，5 分钟后变成 timed-out。

修复后：

- `wakeup:false` 的普通通知写入后直接 completed。
- reconcile 会把历史 quiet delivered 行收口为 completed。
- `session-7a601594...` 的 502 条 dispatch 已全部为 completed，timed-out 0、failed 0、open 0。

### 4.2 idle watch

`team-idle-watch.mjs` 当前参数：

```yaml
settleMs: 30000
maxNoProgressReminders: 3
maxReminders: 100
```

含义：

- 所有非冻结 subordinate 和 root 都停止 30 秒后，才提醒 root。
- 连续 3 次“无交付进展”的提醒后暂停；任务、room summary/decision、escalation、packet 的真实进展会重置。
- `maxReminders:100` 只是每 Team 的绝对兜底，不是正常的 3 次停止。
- 冻结成员和 failed 成员不参与 stopped 判定。
- provider blocked 时 suppress。

## 5. 持久 pnpm patch

### 5.1 为什么做

此前 web 的 `node_modules` 里有可用改动，但重装后无法复现。尤其是旧 `llm-pi-ai` patch 不是 pnpm 标准格式，导致 `pnpm install` 报 `ERR_PNPM_PATCH_FAILED`。

### 5.2 当前登记

web：

- `@deepseek-ai/dsh-experimental-agent-team@0.1.6-alpha.1`
- `@deepseek-ai/dsh-experimental-browser-use-stagehand-native@0.1.6-alpha.1`
- `@deepseek-ai/dsh-experimental-client-ui-agent-team@0.1.6-alpha.1`
- `@deepseek-ai/dsh-llm-pi-ai@0.1.6-alpha.1`

headless：

- `@deepseek-ai/dsh-experimental-agent-team@0.1.6-alpha.1`
- `@deepseek-ai/dsh-llm-pi-ai@0.1.6-alpha.1`

关键路径：

- `home/profiles/web/pnpm-workspace.yaml`
- `home/profiles/web/pnpm-lock.yaml`
- `home/profiles/web/patches/`
- `home/profiles/headless/pnpm-workspace.yaml`
- `home/profiles/headless/pnpm-lock.yaml`
- `home/profiles/headless/patches/`

### 5.3 补丁 hash

| Patch | SHA-256 |
|---|---|
| agent-team | `be04625b4a76c8aba759b04c1a8f1eace6c3de5e5e095e389df16299c2160cdc` |
| stagehand-native | `8328ed22fa5c5ee22a2bac9d1c627cab1da8a9f46b9717fc14f1048b9fbdee55` |
| client-ui-agent-team | `07cc1068942479bdd9257fa7e9426f2f514765e179357d412da821d6f6040bf2` |
| llm-pi-ai | `fa7fbc33ad12dfe69644a263ae1ee86b825dcbe62a2e0739159d2efad82e3249` |

### 5.4 重装验证

已用隔离副本执行：

```powershell
pnpm install --ignore-scripts --config.minimumReleaseAge=0 --frozen-lockfile
```

web 和 headless 均通过。

### 5.5 备份

本轮 patch 落盘前备份：

`D:\dsh-test\backup-pnpm-patches-20260917-211837`

### 5.6 已知杂物

`home/profiles/web/patches/` 还保留三个未被 workspace 引用的旧分片：

- `@deepseek-ai__dsh-experimental-agent-team@0.1.6-alpha.1.lib_index.js.patch`
- `...lib_types_projection.js.patch`
- `...lib_types_roster.js.patch`

它们不会被 pnpm 加载，也不影响 install。当前环境策略拦截了删除操作，未强行绕过；接手者可在确认 workspace 无引用后手工清理。

## 6. Stagehand、CUA 与浏览器

当前浏览器操控使用 Stagehand：

```yaml
executablePath: D:\dsh-test\tools\chrome-for-testing\chrome-win64\chrome.exe
headless: true
```

Stagehand 的 `anthropic-model.js` 通过 pnpm patch 持久化，支持自定义 Anthropic baseURL/model。

CUA 的桌面/电脑操控可用；浏览器操控不要用 `cua_driver_native__browser_*`，原因是本机中文 Edge 远程调试确认框和 Edge 153 兼容问题。背景见 `patch/README-cua-grant-and-chrome.md`。

## 7. 角色文件与 AGENTS

当前角色文件：

- `home/AGENTS.md`
- `home/team-roles/AGENTS.md`
- `home/team-roles/lead.md`
- `home/team-roles/member.md`
- `home/team-roles/verifier.md`

v8 相比 v7 新增/强调：

- 冻结不占容量、默认隐藏、可恢复。
- 30 活跃容量，无终身创建上限。
- 提权申请和一次性授权。
- `team_wake_superior` 与静默 `send_message` 的边界。
- Room 最多 3 轮，host 在 members 中。
- 进度通过 `team_milestone(action:"list")` 拉取，不注入 system prefix。
- verifier 一次接收完整 acceptance packet，一次返回汇总问题表。

注意：`home/AGENTS.md` 很长，包含历史约束和运行环境说明。接手时不要只看片段；代码门禁仍高于提示词。

## 8. 验证结果

### 8.1 已通过

全量测试：`36` 个文件，`33` pass，`3` fail。

通过的核心覆盖包括：

- write scope、action fusion、observation pack。
- team policy、freeze capacity、freeze projection。
- control plane durability、lease/plan/dispatch、room handoff。
- runtime guard、delivery gate、health。
- privilege grant。
- quiet dispatch reconcile。
- team idle watch。
- message batch。

### 8.2 当前失败

三个失败文件：

- `phase4-tests/spawn-budget.test.mjs`
- `phase4-tests/team-operator.test.mjs`
- `phase5-tests/step-compaction.test.mjs`

失败原因类别：

- 旧测试仍断言“终身创建预算/旧 counters”行为，而当前已经改成活跃容量 + 无终身上限。
- 旧测试仍使用旧 milestone/compaction 接口或旧字段，而当前是 v3 job/revision。

这不是生产逻辑回归证据，但必须在下一轮测试维护中更新。接手者不要为了“全绿”恢复已经明确取消的终身上限。

### 8.3 当前运行态

- web 实例 PID `78840`，监听 `127.0.0.1:40123`。
- `compatibility-health.json`：`ready:true`。
- required 插件全部 active：agent-team、team-policy、tool-agent-team-v2、write-scope-guard、team-runtime-guard、team-health、step-compaction、team-operator、browser-use、stagehand-native、computer-use、cua-native。
- `team-health-web.json` 和 `team-health-headless.json` 均为 healthy。
- web/headless 的 Team 核心插件逐文件 SHA-256 一致。

## 9. 接手步骤

1. 先确认生产边界：只操作 `D:\dsh-test`，不要改 `D:\dsh`。
2. 读本文，再按需读 v7 和 0.1.6 兼容计划。
3. 检查实例：

```powershell
Get-Process -Id 78840
Get-Content -Raw D:\dsh-test\home\compatibility-health.json
Get-Content -Raw D:\dsh-test\home\team-health-web.json
```

4. 改依赖或插件前先备份 package、lock、workspace、patches。
5. 任何 patch 变更都走 pnpm 官方 `patch` / `patch-commit`，不要直接改 `node_modules` 当作完成。
6. 变更后用隔离副本跑 `pnpm install --frozen-lockfile`，再装实际 profile。
7. Room、提权、冻结、milestone 变更必须补对应 phase8 测试，并同步 web/headless。
8. 大任务前先跑聚焦 smoke；不要用大型游戏任务做日常回归。

## 10. 已知风险与待办

1. 三个旧测试失败，需要更新测试预期，不应恢复终身预算。
2. `session-7a601594...` 有 7 pending、3 stale milestone compaction job，需要确认后收敛。
3. 三个未引用的旧分片 patch 文件待清理。
4. `team-milestones.json` 有 4 个 Team 桶，接手者不要跨 Team 合并或按名字迁移。
5. Stagehand/CUA 的能力边界依赖本机 Edge/Chrome 和中文环境，不要只看插件 active 就宣称浏览器路径可用。
6. 当前验证是全量 phase 测试和隔离 install；没有在本轮重新跑大型真实 Team 任务。

## 11. 回滚点

- patch 落盘前：`backup-pnpm-patches-20260917-211837`
- 冻结/预算改造前：`backup-freeze-limit-20260917-182740`
- v8 hardening 前：`backup-agent-team-v8-20260916-183211`
- 里程碑 done/set 修复前：`backup-milestone-done-set-20260917-101116`
- `llm-pi-ai` in-history 前：`backup-pi-ai-in-history-20260917-064735`

回滚时只针对 `D:\dsh-test`，优先恢复具体文件和 lock/patch，不要用 `git reset --hard`。
