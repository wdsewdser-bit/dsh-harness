# Agent Team v14 本地收尾报告

日期：2026-09-25。范围：scheduler 代码收尾、web/headless 同步、本地回归，以及**第二轮真实 PTC 小会话与浏览器面板验收**。

## 结论

代码、提示词契约、本地回归、真实 PTC 多组会话和浏览器面板验收均已完成。第二轮真实测试（test 工作区，cmd / deepseek-v4.1-flash）暴露出 4 个真实缺陷并全部修复；修复后工具链、两级派发、组板任务、Room、wake 与面板均实证可用。当前运行时没有暴露 Codex 协作代理接口，`list_agents` / `spawn_agent` / `followup_task` 均返回 unsupported，因此无法重新派发 `/root/v14_scheduler`，由根代理直接接管。没有清理 backup/session/spill/telemetry，没有修改用户产品工程。

## 第二轮：真实测试暴露的缺陷与修复

| 缺陷 | 根因 | 修复与证据 |
| --- | --- | --- |
| 所有工具调用返回 `cannot get property "sessionId" without inject` | `team-v14-identity.mjs` 的 `resolveIdentity` 直接读 cordis Context 代理字段；failure-memory 的 pre-execute 钩子每个工具都会走到这里 | 安全读取 `readProperty`/`readPath`；agent 上下文优先以保证 fallback 稳定。回归：`phase11-tests/v14-identity-context.test.mjs` |
| 同类 `cannot get property "commit" without inject` | `identityFor` 读取 `supplied.commit/commitHash/treeHash` | 改用 `readProperty`。回归：同文件 failure-memory 用例 |
| DSH 进程崩溃 `cannot get required service "agents" in inactive context` | `team-v14-event-continuation.mjs` 30s 扫描定时器在插件上下文失效后仍读 `ctx.agents`，异常未捕获 | `disposed` 守卫 + `agentsOf`/`teamsOf`/`safeWarn` 安全读取。回归：continuation inactive-context 用例 |
| `level:1` 房间塞入 tier-2 成员导致轮次无法关闭并阻塞组房间 | `roomAdmissionVerdict` 对 tier-0 调用者无条件放行，轮次顺序照抄成员表 | 新增绝对席位规则 `roomSeatVerdict`；open/join/next 过滤或拒绝不可入席成员并返回 `excludedMembers`；`team_room_close` 为“含不可入席成员”的房间提供 tier-0 凭理由强关的合法出口（控制面新增 `waivableMembers` 证明参数）。回归：`phase11-tests/v14-room-seat.test.mjs` |

真实数据核对：对 `session-2a819b5b` 的现有房间套用新规则，`level:1` 席位由 7 降为 `lead/lead-alpha/lead-beta`，4 名 tier-2 成员被排除；group 与 root 房间不受影响。

## 第二轮：真实 PTC 测试与面板验收

- 工具链：`list_agents`、`team_task_create`、`spawn_teammate`、`team_task_update`、`send_message`、`team_v12`、`team_milestone` 全部成功，无 `cannot get property` 报错。
- 结构：tier0 root → 2 名 tier-1 组长 → 各 2 名 tier-2 成员；组板任务带 evidence 完成；4 间 Room 建立，父轮依赖门禁按设计拒绝子房间抢跑。
- 面板：六个标签（成员 / 已冻结 / 看板 / 协作房间 / 消息投递 / 操作概况）逐个点击成功并渲染真实数据；桌面 1440×900 与窄屏 480×900 均无横向溢出；控制台 0 error / 0 warning。截图：`output/v14-panel-tab-*-desktop.png`、`output/v14-panel-tab-*-narrow.png`。
- 回归：phase9 48/48、phase10 45/45、phase11 76 项（75 通过、1 跳过、0 失败）。

## 本轮修复

| 文件 | 修复 |
| --- | --- |
| `home/profiles/web/plugins/team-v14-waiting.mjs` | 统一等待条件别名（`room`/`room-closed`、`provider`/`provider-healthy`、`manual`/`manual-resolve`、`approval`/`approval-granted` 等）；ISO-8601 与 epoch 时间解析；非法条件和空 dependency 显式拒绝；`approval` 与人工/外部/后台等待只由显式 resolve 解除；兼容 legacy rooms 与 v12RoomWake rooms。 |
| `home/profiles/web/plugins/team-v12-runtime.mjs` | 新增 `authorizeRequirementRecord`：tier 1 只能写本组可写 board、本组任务或本组 scope；全局/无 scope requirement 与 decision 仍为 tier 0。`requirement_record` 和 `decision_record` 已接入该检查。 |
| `home/profiles/web/plugins/team-v12-evidence-scheduler.mjs` | 修复共享 requirement 证据复用：acceptance matrix 按 requirementId 查询证据，不再因 taskId 过滤而丢失第二个任务的共享证据。 |
| `home/profiles/headless/plugins/*` | 将 web 的 V14 与共享模块同步到 headless，共 21 个模块；web/headless SHA-256 全部一致。同步前备份见下。 |

## 验证证据

- 语法：web 21/21、headless 21/21 `node --check` 通过。
- 导入：headless 的 V14 runtime、continuation、context delivery、waiting、memory anchor、panel 模块动态导入通过。
- 聚焦回归：`phase11-tests/v14-waiting.test.mjs`、`v14-continuation.test.mjs`、`v14-runtime-bridge.test.mjs`、`v14-room-memory.test.mjs`、`v14-storage.test.mjs` 共 45 项，44 通过、1 跳过、0 失败。
- 全量回归：`phase9-tests/*.test.mjs phase10-tests/*.test.mjs phase11-tests/*.test.mjs` 共 171 项，170 通过、1 跳过、0 失败；日志 `D:\dsh-test\output\v14-final-regression.log`。
- 提示词/身份静态检查：`home/AGENTS.md`、`team-roles/AGENTS.md`、`lead.md`、`member.md`、`verifier.md` 必需契约词齐全，`identity-version.json` 四个角色哈希匹配，检查通过。
- 新增测试：等待别名、ISO 时间、非法条件、approval 显式解除、requirement 写权限跨组拒绝均已覆盖。

## 最终 profile 哈希

| 模块 | SHA-256（web 与 headless 相同） |
| --- | --- |
| `team-control-plane.mjs` | `17FE1E6514BEC016ACD33DEA17609A701178AA7AAA139CE2DCC6E43C361138FE` |
| `team-tools-v2-r10.mjs` | `AF22238DD3C6D3FC82231CB57ED208F19AEE53CEBEE90B87B2730DF83D9AF94C` |
| `team-v12-runtime.mjs` | `6D82FF970E5FB60A50CA6FC5352613316DC68EB02617B08EACD52132B1E303D4` |
| `team-v12-evidence-scheduler.mjs` | `A0BE229A45D0B41A6DD1D305D74F9DD0A9F3269CC10B73F6D6532C656969CAD6` |
| `team-v12-room-wake.mjs` | `A0CC67A905C08383175CAB94308184C0CA8A399917541AD189B055926C9554D4` |
| `team-v14-context-delivery.mjs` | `15E98189E0BADA56349610F332C83514CA66E77EE80924032BDFB5C98001AC96` |
| `team-v14-durable-store.mjs` | `7895B19A41EF8E2A9D461C6416F68C7CA0F11B550403642EED95E17D8C4376E5` |
| `team-v14-event-continuation.mjs` | `F750BC3D032E32A75FA7C5B7382DEA1D707A5EB00052D7B76FA7DBA9464480F7` |
| `team-v14-identity.mjs` | `8EEF5957985F7A24C8A5E9E0BFA333C2DEBAEE1D150813A5669884614A58576E` |
| `team-v13-failure-memory.mjs` | `9A9C464D65D8C07D440C33913470B25CB10E426E4806EEDD52F027B99DF91F97` |
| `team-v13-mechanism-telemetry.mjs` | `1228C95AC79D522F0735649F055BF7809CBCE83D617FE9EB27EA9F057AD95A50` |
| `team-v14-memory-anchor.mjs` | `C314A3BB5FE22AAA286D24CA3BE3D6322134D4BF6B4EA0906B7FAA87E1893407` |
| `team-v14-panel.mjs` | `BC772122DA667291BE5E5745DAE65314E7BF9819B301F39CC074813ADA98D1F4` |
| `team-v14-requirements.mjs` | `8957C88AA29A7D04A5EB21C0964397E52ED6D1C8B74BEA1D96ACC265A74C7A71` |
| `team-v14-waiting.mjs` | `D480A106206FFF90D3596894E849165BE64AE7771A120E4C48A0C0FDE4A8F790` |
| `step-compaction-v4.mjs` | `871EC2E76379003598FF105182851DCD4F4A48FE344A17D5132E05932188B77A` |

本轮重新生成的 `D:\dsh-test\output\v14-final-hashes.json` 覆盖 web/headless 共 54 对同名模块：V14 与共享模块 16/16 完全一致。另有 5 个**历史遗留**模块（`team-tools-v2.mjs`、`team-idle-watch.mjs`、`team-idle-watch-v2.mjs`、`team-idle-watch-v4.mjs`、`team-operator.mjs`）web/headless 本就不同，属于旧版本/被 r10 取代的模块，不是本轮改动引入，本轮未触碰。

## 备份与回滚

- 本轮 identity/continuation 修复前备份：`D:\dsh-test\backup-v14-identity-fix-20260925-200932`。
- 本轮 room 席位修复前备份：`D:\dsh-test\backup-v14-room-seat-20260925-203051`。
- 本轮 headless 同步前备份：`D:\dsh-test\backup-v14-headless-sync-20260925-194416`。
- V14 开工备份：`D:\dsh-test\backup-v14-20260925-165235`。
- 回滚 headless：将同步前备份中的同名文件复制回 `D:\dsh-test\home\profiles\headless\plugins`。
- 回滚 web：identity/continuation 用 `backup-v14-identity-fix-20260925-200932`，room 席位用 `backup-v14-room-seat-20260925-203051`，更早的 waiting/runtime/evidence scheduler 用 `backup-v14-20260925-165235`。

## 运行中的测试实例

- 测试实例：`http://127.0.0.1:40124/?token=wbh-PWFg6Gw0u0qmJRPzj9Sxz_h1ek3LlzNrk8N_O8o`（DSH_HOME `D:\dsh-test\home`，PID 见 `logs/current-pid.txt`）。
- 该实例已加载本轮修复后的代码，供用户复查面板与测试会话。

## 后续真实测试修复（2026-09-25 20:50）

第二轮真实 PTC 小测试在 claim/等待路径又暴露两处真实缺陷，已修复：

- **P1**：零写入 `discussion`/`review` 任务在 `claim` 时被二次 ready-gate 误判为 `scope-required`。根因是 pre-execute 第一次校验使用 `allowReadOnly:true`，调用 `evaluateReadyGate` 时漏传同一选项；现已透传，且 `edit` 零 scope 仍按原规则拒绝。
- **P3**：未认领任务的 `waiting_set` 因要求已有 owner 而死锁；同时只接受驼峰 `unblockCondition`。现允许调用者给未认领任务登记自己的等待单，兼容 `unblock_condition`，并保留“非 owner / 非 tier 0 不能改他人等待单”的权限边界。

验证：新增 `claim gate allows zero-scope discussion/review tasks...` 与 `waiting_set accepts an unowned task...` 两条回归；phase9 + phase10 + phase11 全量 171 项，170 通过、1 跳过、0 失败。web/headless `team-v12-runtime.mjs` 哈希一致：`6D82FF970E5FB60A50CA6FC5352613316DC68EB02617B08EACD52132B1E303D4`。未重启当前 DSH 实例。

## 剩余项与限制

- `session-2a819b5b` 的 `level:1` 轮次是修复前数据，仍为 open 且含 4 名不可入席成员；修复后 tier 0 可用 `team_room_close(force_close:true, waived_members:[...], force_close_reason:"...")` 合法收口。本次未自动改动该会话状态。
- 本轮真实测试为 cmd 供应商小额验证，未做更大规模压力测试；多进程存储、迁移和旧会话回读由本地 fixture 回归覆盖。
- `/root/v14_scheduler` 未重新派发，原因是当前运行时协作代理接口不可用；本报告记录的是根代理直接接管后的结果。
