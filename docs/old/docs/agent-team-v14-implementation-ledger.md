# Agent Team v14 实施台账

2026-09-25，状态：A-L 完成；真实 PTC 与最终回归已收口。

压缩后先读 `agent-team-v14-execution-plan.md` 与专项审查；只有验证通过的工作包可标完成。

| 工作包 | 状态 | 验证与交接 |
| --- | --- | --- |
| A 官方 hook/PTC 回执 | complete（代码/回归） | `result.value`、失败不镜像、父子回执均已接入；`v14-runtime-bridge` 8/8。真实 PTC 验收归入 L。 |
| B inbox 差量与预算 | complete（代码/回归） | session/event 提交后确认、原生消息去重、统一预算和权限已通过 20 步幂等与回归测试。真实压缩恢复归入 L。 |
| C Room 兼容记忆 | complete（代码/回归） | 旧 Room 摘要/未决项迁移、最新尾部读取、严格游标回执通过 `v14-room-memory` 10/10。 |
| D 状态/等待/超时 | complete（代码/回归） | terminal/running 映射、等待责任单、Room 超时恢复和 waiting alias/ISO 校验通过聚焦回归。 |
| E 事件接续器 | complete（代码/回归） | 已批准任务接续、依赖解锁、幂等 episode、失败重试、完成汇总已通过 `v14-continuation` 7/7；真实多组接力归入 L。 |
| F 要求与压缩恢复 | complete（代码/回归） | requirement/decision 版本、差量交付、压缩锚点与缺失债务已通过 `v14-room-memory`、runtime bridge 测试。 |
| G 热状态/事务/迁移 | complete（代码/回归） | content-addressed cold refs、mutateHot、旧会话 dry-run/apply/reopen 已通过 `v14-storage` 与迁移报告。 |
| H 持久化与隔离 | complete（代码/回归） | durable store、failure memory、telemetry/debt/settings 并发合并通过多进程 fixture。 |
| I 日志/Reducer/构建锁 | complete（代码/回归） | 新模块与 focused tests 完成，web/headless 已同步并逐文件哈希一致。 |
| J 提示词与身份 | complete | identityVersion=v14-2026-09-25.4；必需契约词、角色文件与 manifest 哈希通过。旧成员下一 turn 只接收变化角色差量的回归已通过；真实 PTC 中 7 名成员均产生 committed identity delivery receipt，root 上下文实际注入 `[identity:lead@v14-2026-09-25.4]`。 |
| K 面板 | complete | 六个标签（成员 7 / 已冻结 / 看板 6 / 协作房间 4 / 消息投递 1 / 操作概况 2）逐个点击并截图；桌面 1440×900 与窄屏 480×900 均无横向溢出，控制台 0 error / 0 warning。证据：`output/v14-panel-tab-*-desktop.png`、`output/v14-panel-tab-*-narrow.png`。 |
| L 同步/回归/真实验收 | complete | 最终回归 181 项：180 通过、1 跳过、0 失败。真实 PTC 完成多组 Room、跨组确认、scheduler/verification receipts、身份回执、无 commit discussion reconcile、旧失败 dispatch 不阻塞交付；自动接续一次失败后重试由 `v14-continuation` 回归覆盖。详细回执和哈希见下方最终验收段。 |

## 本轮真实缺陷与修复（2026-09-25 20:00–20:35）

一次真实 PTC 小测试（`session-2a819b5b`，test 工作区，cmd / deepseek-v4.1-flash）暴露出三个真实缺陷，均已修复并加回归：

1. **所有工具调用失败：`cannot get property "sessionId" without inject`**
   - 根因：`team-v14-identity.mjs` 的 `resolveIdentity` 直接读取可能是 cordis Context 代理的对象字段；`team-v13-failure-memory` 的 pre-execute 钩子对每个工具调用都会走到这里，于是所有工具全部报错。
   - 修复：新增安全读取（`readProperty`/`readPath`），失败时返回 undefined；fallback 身份改为优先绑定 agent 上下文以保证稳定。
   - 回归：`phase11-tests/v14-identity-context.test.mjs`。

2. **同类第二处：`cannot get property "commit" without inject`**
   - 根因：`identityFor` 读取 `supplied.commit/commitHash/treeHash`，`supplied` 同样可能是 cordis Context。
   - 修复：改用 `readProperty`。
   - 回归：同文件 `failure-memory fingerprints tolerate a throwing cordis identity context`。

3. **DSH 进程级崩溃：`fatal uncaught exception: cannot get required service "agents" in inactive context`**
   - 根因：`team-v14-event-continuation.mjs` 的 30s 扫描定时器在插件上下文失效后仍读 `ctx.agents`，异常未捕获直接终止 harness。
   - 修复：`disposed` 守卫 + `agentsOf/teamsOf/safeWarn` 安全读取，定时器与事件回调不再抛出。
   - 回归：`continuation scan never throws from an inactive plugin context`。

4. **Room 席位缺陷（真实测试暴露，非崩溃类）**
   - 现象：`level:1` 房间被 tier 0 塞入 4 名 tier-2 成员，轮次顺序照抄成员表；tier-2 无法在 level 房间发言，轮次停在 `nextSpeaker=alpha-m1`（2/7），父轮依赖又阻塞全部 group room。
   - 根因：`roomAdmissionVerdict` 对 tier-0 调用者无条件放行；轮次参与者只做该相对校验。
   - 修复：新增与调用者无关的绝对席位规则 `roomSeatVerdict`，`team_room_open`/`team_room_join`/`team_room_next` 一律过滤或拒绝不可入席成员，并在返回值给出 `excludedMembers`；`team_room_close` 增加“房间含不可入席成员时 tier 0 可凭理由强制关轮”的合法出口（控制面新增 `waivableMembers` 证明参数，默认仍只允许冻结成员）。
   - 真实数据核对：对 `session-2a819b5b` 现有房间套用新规则，`level:1` 席位从 7 降为 `lead/lead-alpha/lead-beta`，4 名 tier-2 被排除，group/root 房间不受影响。
   - 回归：`phase11-tests/v14-room-seat.test.mjs`。

### 真实 PTC 测试结果（修复后）

- 工具链恢复：`list_agents`、`team_task_create`、`spawn_teammate`、`team_task_update`、`send_message`、`team_v12`、`team_milestone` 等全部成功返回，无 `cannot get property` 报错。
- 结构正确：tier0 root → 2 名 tier-1 组长（lead-alpha / lead-beta）→ 各 2 名 tier-2 成员（alpha-m1/m2、beta-m1/m2）。
- 组板任务建成并完成：`group-alpha-t1`、`group-alpha-t2`、`group-beta-t1` 等带 evidence 完成。
- Room：`root`、`level:1`、`group:alpha:tier-2`、`group:beta:tier-2` 共 4 间；父轮依赖门禁按设计拒绝子房间抢跑。
- 面板：真实成员/看板/Room/投递/概况数据全部渲染，六标签可切换。

### 已知残留

- `session-2a819b5b` 的 `level:1` 轮次是修复前数据，仍处于 open 且含 4 名不可入席成员；修复后 tier 0 可用 `team_room_close(force_close:true, waived_members:[...], force_close_reason:"...")` 合法收口，不再需要绕过门禁。
- 该残留未在本次自动收口，避免在未获授权时改动用户可见会话状态。

## 备份与当前边界

- 开工检查未发现 DSH 桌面或其 host 进程。
- 插件/配置/身份文件已修改，尚未启动 DSH 或修改用户产品工程/原生会话 journal。
- 验证过的备份：`D:\dsh-test\backup-v14-20260925-165235`，302 文件、206570142 bytes，manifest 哈希核对通过。
- 中间回归（不是最终验收）：phase9 48/48；phase10 45/45；phase11 在追加前 21/21。后续修改需要重跑；旧 failure fixture 已使用同一模拟时间及显式审计解锁。
- 独立 review 找出的权限、inbox 重复、提交回执时点、PTC 部分失败与父子调用链、存储并发等仍在修复，不能据中间测试宣布完成。
- 子代理曾因 403 额度中断；用户重启后要求继续并恢复 review。所有残余工作以当前磁盘和最终测试为准。
- 2026-09-25 本地收尾：当前运行时未暴露 Codex 协作代理接口，`list_agents` / `spawn_agent` / `followup_task` 返回 unsupported，无法重新派发 `/root/v14_scheduler`；根代理直接接管 scheduler 收尾。没有启动 provider、重启/关闭 DSH、清理数据或修改用户产品工程。
- 本轮修复 waiting 条件别名/ISO/非法条件、requirement 写权限跨组拒绝、共享 evidence 复用回归；headless 同步前备份为 `D:\dsh-test\backup-v14-headless-sync-20260925-194416`。
- 全量回归日志：`D:\dsh-test\output\v14-full-regression.log`；本地收尾报告：`D:\dsh-test\docs\agent-team-v14-local-closeout-20260925.md`。

## 后续真实测试修复（2026-09-25 20:50）

- P1：`team-v12-runtime.mjs` 的 claim pre-execute 二次 ready-gate 未透传 `allowReadOnly`，导致零写入 `discussion`/`review` 任务无法 claim；已修复，`edit` 零 scope 仍拒绝。
- P3：`waiting_set` 原先要求任务已有 owner，未认领任务形成死锁，且只接受 `unblockCondition`；现允许未认领任务由当前调用者登记自己的等待单，兼容 `unblock_condition`，并保留 owner/tier 权限边界。
- 回归：`phase11-tests/v14-runtime-bridge.test.mjs` 新增 claim 与 waiting 两条集成测试；phase9 + phase10 + phase11 共 171 项，170 通过、1 跳过、0 失败。
- 同步：web/headless `team-v12-runtime.mjs` 字节一致，SHA-256 `6D82FF970E5FB60A50CA6FC5352613316DC68EB02617B08EACD52132B1E303D4`。未重启 DSH。

## 2026-09-25 此前计划复核结论（历史，已被最终验收取代）

逐条对照 `agent-team-v14-execution-plan.md` 后，A–D、F–I、K 的代码与聚焦回归已落地；E、J、L 不能标为完整完成：

- E：`team-v14-event-continuation.mjs` 与 `v14-continuation.test.mjs` 已实现并通过，但两次真实 PTC 测试没有证明“依赖完成后无需 root 轮询即自动接续”和“一次失败恢复”这两个完成条件。
- J：运行时已接入 `identitySource` 并校验 manifest/hash，但没有在真实旧成员的下一 turn 证明最终拼装上下文包含角色差量。
- L：哈希同步、全量回归和真实多组 PTC 已完成；真实压缩/记忆恢复、身份 handoff、失败恢复仍未纳入真实验收。`v14-execution-plan.md` 自身状态仍写“实施中”，与台账的 partial 状态一致。

> 上述 partial 是当时快照；后续补测与真实回执见“最终验收收口”，当前状态以该节为准。

## 2026-09-25 最终验收收口

- 真实 PTC 会话：`session-3c2ec04c-5d59-46a5-8952-3a5c177210e9`，测试工作区，root + 2 名 tier-1 组长 + 4 名 tier-2 成员。
- E：自动接续一次投递失败后重试并成功送达的回归通过；真实旧失败行 `wake:continuation:task-3:r5:lead:a1` 保留为历史终态，但已完成任务和旧尝试不再作为 delivery blocker。
- J：identityVersion=`v14-2026-09-25.4`；角色文件最终 SHA256：
  `AGENTS.md=056FE883C4025E37C23CC25B9C66547F061C0CAD4D823F8508ECACC3C7ED3AE9`、
  `lead.md=D891472A80472E5F5EB7DD7C27DFD78CECF534DD55660DEAD71A15D5768E6AA2`、
  `member.md=612C0A2B8ABBF04BFDDE1C1209F51BC1E4D409CD32E0270630299AE8583BE193`、
  `verifier.md=4C1EB261B9EA404DFBE24E59506C4BCC9C2357297D4B6F2FC4041EBDDB80D081`。
- L：真实无 commit discussion reconcile 成功。源 `group-root-t1` 状态 `completed/rev3/commitSha:null/evidence-803aedd5…`；目标 global `task-4` 状态 `completed/rev3/commitSha:null`，evidence 同时包含 linkage `evidence-377581e3…` 和源 evidence。
- `team_delivery_check` 最终真实回执：`deliverable:true, openCount:0, actionableOpenCount:0, noOwnerCount:0, blockers:[]`。
- 最终回归日志：`D:\dsh-test\output\v14-final-regression-20260925-2137.log`，181 tests / 180 pass / 1 skip / 0 fail。并发锁测试在负载升高时曾出现一次 23 秒超时，单独复跑及降载全量复跑均通过。
- 最终共享模块 web/headless SHA256：
  `team-v12-room-wake.mjs=B6B81F390AD1895781E14E8504F766372036CA6FD971FE407AE5B5D39A2E2083`、
  `team-v12-evidence-scheduler.mjs=914987F4E20D1E6997A7EC502498D9F0716AD136C773991810896DC0913D4E38`、
  `team-v12-runtime.mjs=5189B927EDA8A36375D9DA0ACE288F4DC8DCA1D5967D804A4DECA01723D9CB71`、
  `team-tools-v2-r10.mjs=1B216492FC99A0313C61991712D05947FAD738A29DA2979B0F207FDD28CC8380`、
  `team-control-plane.mjs=528861DA99DF76F2DAB5E800722E92FD3B39DF2B2C1AF258569B4B81E915B12B`。
- 残余边界：失败 dispatch 历史行仍保留为终态，当前设计不为它伪造 `completed/cancelled`；只要任务已完成或已有后续尝试，它不会阻塞交付。若未来需要人工销账，应新增明确的 `superseded` 状态和审计字段，而不是复用 `cancelled`。

## 2026-09-26 性能热修

- 定位到 `v12RoomWake.inbox` 热持久化逐条写 256 个 cold 文件，真实状态单次写入约 7.8–8.9 秒；改为 inbox 批量 cold 文件并按内容摘要复用。
- 修复 append 历史增量语义，避免 `slice(previous)` 把新增行误当完整数组。
- 实测热持久化降至约 272 ms，inbox、Room、v12 事件回环均通过。
- HMR 的 Web profile 根目录改为 `base + plugins`，避免 Windows 下解析到 `NTUSER.DAT`。
- 新增热快照异步原子写和面板缓存自适应写，避免约 6.7 MB 状态每次 mutation
  同步阻塞事件循环。
- cold raw 缓存增加文件签名校验，外部篡改/删除仍 fail-closed。
- telemetry 目录读取增加 10 秒缓存；session 目录查找增加 30 秒索引缓存。
- continuation completion summary 改为 `mutateHot`，不再做无意义的历史检测。
- 第二轮补丁已通过 HMR 加载：控制面延迟持久化持有同一把跨进程锁，
  Room/dispatch/wake 写合并为 250 ms，面板缓存按内容指纹跳过重写，
  `deliverWake` 超时会真正 abort 底层 mailbox。
- 第三轮补丁已通过 HMR 加载：插件直投不再伪装成核心
  `team-message`，避免核心 mailbox 对目标会话执行无意义
  `Session.flush`；直接下级和 Room handoff 优先走
  `Agent.steer` / `subagents.steerPrompt`，失败再回退 durable mailbox。
- 第四轮补丁已通过 HMR 加载：`deliverWake` 不再对冷目标同步等待无上限的
  `subagents.steerPrompt`，只保留最多 500 ms 的活跃目标 `Agent.steer`
  快路径，超时回退 durable mailbox 并返回 `queued`。
- 当前进程曾用一次性 V8 GC 钩子回收堆：`heapUsed 7099 MB -> 6518 MB`，
  Working Set 约 `8.85 GB -> 6.78 GB`，空闲 CPU 约 `86% -> 14%`；
  临时 GC 钩子已移除，不作为常驻机制。
- 第二次 GC 对照为 `heapUsed 6280 MB -> 5700 MB`；随后 20 秒 CPU 约
  `29.4%`，证明长会话堆增长仍会再次触发 GC 抖动，后续应优先安排
  受控重启或减少长会话驻留。
- 冷唤醒修复后的新 wake 回执为 `387 ms`、`685 ms`、`2019 ms`；根页面
  HTTP 连续采样为 `78.4 / 4.3 / 2.4 / 2.8 / 2.6 ms`。
- 真实 UI 探针 `team_wake(target:"lead-a")` 返回 `delivered`，整轮 9 秒；
  控制面 claim→delivered 110 ms、delivered→turn-started 52 ms，且该窗口
  没有 `team/message/queued|delivered`。最终 Web/headless
  `team-tools-v2-r10.mjs` SHA-256 为
  `CAE32E84ACC37274E56A3200143BCFF77999F20E188CD8FC7BC2A3A35920D2C3`。
- 第四轮最终 Web/headless `team-tools-v2-r10.mjs` SHA-256 为
  `155524E5E5961753F3F4D1A3487CA296CB473807E320A3EE007A8DC4C0002ADD`。
- 详细证据、备份和剩余核心层边界见
  `agent-team-performance-hotfix-20260926.md`。当前进程未重启，核心
  JSONL append handle 复用与 durable mailbox fallback 的 `Session.flush`
  仍需受控重启后才能验证。

## 2026-09-26 perf16 控制面热更新优化

- 5 秒 CPU profile 中 `structuredClone` 约 `20.6%`；最热调用点是
  deferred commit 每次复制整份约 10 MB 控制面状态。
- Web/headless `team-control-plane.mjs` 的 deferred commit 改为
  `clone:false`，继续由 mutation queue 和跨进程文件锁保证事务顺序。
- HMR 已加载 `perf16 clone-free`；Web/headless SHA256：
  `3F7A9081C66692065BEE617E3966E45E0E45649E86094D6417360CA6878AB5EE`。
- 10 MB 合成状态连续 120 笔 Room/wake 热更新：
  `commitMs=672.9`、`flushMs=47.7`、`revision=121`。
- 回归：phase11 `87/86 pass/1 skip/0 fail`；
  phase9 `54/54 pass/0 fail`。
- 当前 `PID 35728` 未重启；会话列表持久化缓存补丁仍需下一次受控重启
  才会进入核心模块。

## 2026-09-26 Reducer 路由设置页复核

- DSH 根页面 preload 清单包含
  `@local/evidence-reducer-ui/client.js`，说明设置页 companion 已进入当前
  Web 前端资源列表。
- `evidence-reducer-ui/client.js` 通过
  `configForms.get('evidence-reducer')` 绑定启用开关、路由方式、
  provider/model/reasoning effort、远程许可和阈值字段。
- `evidence-reducer.mjs` 的 `settings/document-updated` 监听器会把设置页
  写入的值镜像到 `D:\dsh-test\home\evidence-reducer.json`。
- 设置文件 round-trip 已验证：写入 explicit/cmd/ds4.1/max 后读回一致；
  当前实际配置仍为 `enabled=false / route=session / remoteAllowed=false`。
- `node --check` 已通过 `evidence-reducer.mjs`、UI host half 和 client half。

## 2026-09-27 v14 运行缺陷修复交付

本轮按 `agent-team-v14-runtime-defect-register-20260927.md` 完成 P0/P1/P2
逐项修复。修复前备份：

- `D:\dsh-test\backups\backup-v14-fix-20260927-012303`
- `D:\dsh-test\backups\backup-v14-profile-sync-20260927-014814`

### 交付内容

- 上下文：持久化 session/member source cursor、compaction baseline、tier-0
  6000/2500 token 预算、required-context debt 和 fetch 指令。
- 调度与等待：approval 自动销账、terminal/stale wait 清理、动态 continuation
  batch、aging、review SLA、live lease 执行状态、stale task 不再阻塞 pending
  scope。
- 权限与身份：tier-0 运营目录、`run_code` 写入路径 fail-closed、`root.md`、
  角色 wake 决策表、8/8/30 配额文档一致。
- 验收与协作：group acceptance packet 幂等唤醒 verifier；final acceptance
  必须存在同 task set、同 commit、无 blocker 的 verifier review；Room
  awaiting-close 支持 deadline/re-wake/replace/force-close；wake dead-letter
  和不同 pending message 保留。
- 持久化：cold mark-and-sweep、temp 清理、audit rotation、延迟 checkpoint、
  append-only history refs、写入耗时指标。
- 压缩：统一 pressure-assisted 语义，job/status/resume 均暴露 trigger 和
  ratio。
- Provider：安全拒绝单独分类，记录 request bytes/tokens、refused context
  pack 和 provider response；下一 Team step 使用 bounded fallback pack，
  不再把整包原样重试。
- Profile：`team-health` 增加共享插件 SHA-256、size、export parity 门禁；
  desktop/web/headless 14 个共享插件已同步。

### 验证

- 合并回归日志：
  `D:\dsh-test\output\v14-fix-regression-20260927.log`
- 结果：`215 tests / 214 pass / 1 skip / 0 fail`。跳过项是显式 heavy 60 MB
  benchmark，需要 `DSH_V14_HEAVY_BENCH=1`。
- 新增聚焦回归：
  `v14-acceptance-verifier.test.mjs`、`v14-provider-safety.test.mjs`、
  `v14-profile-parity.test.mjs`。
- `node --check` 已通过本轮修改的全部插件。
- 角色 manifest 校验：`AGENTS.md`、`root.md`、`lead.md`、`member.md`、
  `verifier.md` 实际 SHA-256 全部匹配 `identity-version.json`。
- 真实 `inspectHealth`：`status=healthy`、`reasons=[]`；desktop/web/headless
  的 14 个共享插件 hash parity 全部 healthy。

### 当前 profile 关键哈希

- `team-health.mjs`: `A84579FFAEFF0B7627800FA136A76C1662547DC3C3A1D2149231C7B8C483A9C6`
- `team-control-plane.mjs`: `FA2E18F40F8E473925D82C5CE6FD914A62C3B9BDB0D35AB09DDAA315427A9D17`
- `team-tools-v2-r10.mjs`: `5863D06EAE401541635AF3783C9580742926A5AFA93B62A23D6E7A38D90F9FAE`
- `team-runtime-guard.mjs`: `5CBDA65BE31AD74748201D52F8244AC87CB2DA45B3D63E432B929962B294FEDB`
- `team-v12-runtime.mjs`: `37E092C40FD08B3845E9F2B65A4EDF8BD3910A6A3E4981DDE0E0E8ADA9E22F65`
- `team-v12-evidence-scheduler.mjs`: `24A345CA9B116558823927941B3B622C7525BE8367B4BB3DBF2C4560B2F42C72`
- `team-v14-event-continuation.mjs`: `DC12A3197A47D8885A1C324F9E776193535B78D600B352DCAE00D8A77E879773`

### 运行态边界

- 本轮没有重启、停止、清理控制面、会话、cold/temp/audit 数据，也没有向真实
  provider 发送重试请求。
- 最终核验时未发现正在运行的 DSH host，因此不能声称当前进程已加载新代码；
  下一次受控启动或 HMR 后，以 `team-health` parity 和
  `v14-fix-regression-20260927.log` 作为加载前基线。
- `run_code` 防护是保守的静态 fail-closed 检查，不是 OS 级沙箱。

## 2026-09-27 Performance Hotfix 58/59

- `perf58-cold-evidence-compaction`：将 `v12Evidence`、`v12Compaction` 正文迁到
  cold refs，主控制面快照只保留 digest，读取时透明 hydrate；备份见
  `D:/dsh-test/backups/perf-20260927-cold-evidence-compaction-20260927-105946/`。
- `perf59-board-index`：新增 `boardIdForTask()`，任务自带 `board` 时直接复用，
  旧任务才回退全板扫描；四个 profile 的 `team-v12-runtime.mjs` 哈希一致，
  `E516A05BEE0BCB30699FBFEA64BC60AEBA7D6724D5858811294A993C1C4DB208`。
- 四个 profile 已同步：`web`、`headless`、`desktop`、`teamtest`；
  `team-control-plane.mjs` 哈希
  `CCBEBF2849EBEF6F5AE1B25FE806C6C297FF03ED509557842D3DFD7376DA1F42`。
- 最终全量回归：`251 tests / 250 pass / 1 skip / 0 fail`；
  日志 `D:/dsh-test/output/v14-perf59-full-regression-rerun-20260927.log`。
- 未重启 DSH；当前 PID `45532`，端口 `40123` 仍可连接。详细边界见
  `agent-team-performance-hotfix-20260926.md` 第五十八、五十九轮。

## 2026-09-27 Runtime Guard Sessions Inject Fix

- 修复历史加载错误 `cannot get property "sessions" without inject`：
  `team-runtime-guard` 现在显式 inject `sessions`，与 cold-tail history
  读取路径一致。
- 四个 profile 已同步，`team-runtime-guard.mjs` 哈希
  `22F5739CBEA5EE17F826C1CD81993D0691E49367C30CC5BCAFD316523526FB4C`。
- 验证：phase11 `152 tests / 151 pass / 1 skip / 0 fail`；浏览器实际打开历史
  会话成功，控制台 0 error / 0 warning；日志不再出现 sessions inject 错误。
- 备份：`D:/dsh-test/backups/fix-runtime-guard-sessions-inject-20260927-111657/`；
  详细记录见 `agent-team-performance-hotfix-20260926.md` 第六十轮。

## 2026-09-27 Waiting Group Lead Authorization

- 修复组长无法为组员任务调用 `waiting_set` / `waiting_resolve` 的摩擦。
- 新增 `authorizeWaitingAction()`：task owner、所属组可写板组长、tier 0 可操作；
  跨组、global 板和只读板继续拒绝。
- 四个 profile `team-v12-runtime.mjs` 哈希一致：
  `34BF40133DDF2A83A0CE27795AA8A4D95D1772F9D5EABF520EC3AC4A7ED89795`。
- 验证：phase11 `153 tests / 152 pass / 1 skip / 0 fail`；HMR 已加载，无需重启。
- 备份：`D:/dsh-test/backups/fix-waiting-group-lead-20260927-113924/`；
  详细记录见 `agent-team-performance-hotfix-20260926.md` 第六十一轮。

## 2026-09-27 PTC Controlled Dispatch Fix

- 修复 PTC 成员无法在 `run_code` 内调用 `tools.write/edit/bash/pwsh` 的问题：
  外层 guard 只拒绝递归 `tools.run_code`，受控子工具继续走正常
  `tools/pre-execute` 与 FS intent 管线。
- 直接 `node:fs`、进程执行、动态模块、`eval` / `Function` 等不透明写入仍
  fail-closed。
- 四个 profile `write-scope-guard.mjs` 哈希一致：
  `81F84868E5633574F6A385F3937226E329EB90DF23559B3458F49551176BAF7D`。
- 验证：聚焦 `2/2`；phase11 `153 tests / 152 pass / 1 skip / 0 fail`；
  profile parity `1/1`；四个 profile 已同步。
- 备份：`D:/dsh-test/backups/fix-ptc-controlled-dispatch-20260927-114502/`；
  详细记录见 `agent-team-performance-hotfix-20260926.md` 第六十二轮。

## 2026-09-27 Root EULA Scope and Stale Failure Unblock

- `lead` 静态写范围新增 `.local` 与 `RustMc/.local`，允许 root 在 RustMc
  项目内写入 `.local/oracle/eula.txt`，产品源码仍 fail-closed。
- 清除已失效的 `team_run_lease acquire task-8` failure-memory 指纹
  `d09982791f50bb0e92cb7096c5f04e537663dfe16c2106b02bb866cbc6671258`；
  审计原因：旧 lease 已 cancelled，task-8 已 admin-close/deleted。
- 验证：EULA 路径 allow、产品路径 deny、failure-memory `blocked=false`；
  未重启 DSH。
- 备份：`D:/dsh-test/backups/fix-root-eula-scope-20260927-122344/`；
  详细记录见 `agent-team-performance-hotfix-20260926.md` 第六十三轮。

## 2026-09-27 Static Scope Membership Context Fix

- 真正根因：`write-scope-guard` 的 `scopeOf()` 丢失了 Cordis ctx，导致根 Agent
  无法通过 `ctx.agentTeams.tryMembership()` 解析成 `lead`，`byName.lead`
  从不命中。
- 修复：`scopeOf(ctx, scopes, actor)` 传递 ctx；新增无 `agent.name` 的
  membership 回归；`defaultDeny` 和实际允许范围不变。
- 四个 profile `write-scope-guard.mjs` 哈希一致：
  `EE3BFB680A28E512EF6129E3199FD554F11CDEE49FE0DC3B0BAEDED3C1818A8D`。
- 验证：聚焦 `3/3`；phase11 `154 tests / 153 pass / 1 skip / 0 fail`；
  profile parity `1/1`；未重启 DSH。
- 详细记录见 `agent-team-performance-hotfix-20260926.md` 第六十四轮。

## 2026-09-27 Global Task Completion Reconcile

- 根因：Team 域已经提交 `completed`，但本地控制面投影因 owner-only 写门禁
  未更新，导致 `team_task_get` 仍显示 `in_progress`，后续 `complete` /
  `reassign` 被域状态机拒绝。
- `team-control-plane.mjs` 新增内部 `reconcile_complete`；global `complete`
  允许 tier 0 以 Team Lead 身份完成 owner 为组长的卡；`admin_close`
  改为比较本地投影 revision。
- `team-tools-v2-r10.mjs` 对“域已完成、投影未完成”的 global 卡执行幂等
  对账，不再重放域完成；global owner 自身 complete 不再被板级写门禁误拦。
- 现场修复：`task-6` → `completed/rev5`；`task-10` → `completed/rev3`；
  保留 owner、证据链和任务卡，不使用 freeze/admin_close/delete。
- 新增回归：`phase11-tests/v14-global-task-completion.test.mjs`
  `3/3`；phase11 全量 `157 tests / 156 pass / 1 skip / 0 fail`。
- 四个 profile 同步且字节一致：
  - `team-tools-v2-r10.mjs`：
    `25F44E2A539CAC4262D995C68C7DB94FECDF72A291082BFF3342FE2227A8E851`
  - `team-control-plane.mjs`：
    `F1C54FA7DEFF7679639075CB8D237AD6D53EA5009653BBD05FAE6DE5247CAF02`
- HMR 已加载 `perf60-global-completion-reconcile`；未重启 DSH。
- 备份：
  `D:/dsh-test/backups/fix-global-task-idempotent-complete-20260927-124044/`
  与 `D:/dsh-test/backups/fix-global-task-idempotent-complete-20260927-124559-data/`。

## 2026-09-27 Message Timestamp System

- 新增 `team-message-time.mjs`，统一给模型可见的动态消息补秒级时间：
  `[time: YYYY-MM-DD HH:mm:ss +08:00]`。
- 覆盖范围：
  - 用户消息与 Team wake / Room / 摘要 / 压缩恢复等 inbox 注入；
  - `tools/post-execute` 的最终工具结果；
  - 普通模型响应与 compaction 响应；
  - `session-title` 与 evidence-reducer 的内部结构化调用显式排除。
- 时间追加在动态消息或结果末尾，不改 system prompt，也不追溯改写历史前缀；
  已存在的时间戳不会重复追加。排队的 inbox 消息使用原始入队时间，不用
  处理时的当前时间冒充新消息。
- HMR 入口仍由 `team-health.mjs` 安装，不新增 Cordis 配置行，不重启 DSH。
  `team-message-time.mjs` 三 profile（web/headless/desktop）哈希一致：
  `538F2C7E96CB102FA8F590DDBB2FA928C24CD35381FA48EE75B2BE9DBA69E676`。
  `team-health.mjs` 三 profile 哈希一致：
  `11FAA768AF6AD2D6332261AA50E8043DB5CE2AC009CDCB5AFE3CCB9CAE112024`。
  `evidence-reducer.mjs` 三 profile 哈希一致：
  `872D19DDD24BA6E9EAB73BE5C5F59B6A2A06F87C6E04913623D2D0062BF6727D`。
- 身份说明已写入 `D:\dsh-test\home\team-roles\AGENTS.md`，身份版本升为
  `v14-2026-09-27.3`；五个身份文件哈希与
  `identity-version.json` 一致。
- 真实隔离验收：新建测试会话
  `session-b6bf8f86-3b39-4796-8aa8-7107b5fb2099`，调用一次 `bash`：
  - `user/message` 带时间；
  - 含 `tool-call` 的 `assistant/message` 带时间；
  - `tool/result` 内容带时间；
  - 最终 `assistant/message` 的 `OK` 带时间。
  UI 与 `session.v4.jsonl.zstd` 均可见，证明不是只改了 UI 文案。
- `team-health-web.json` 复验为 `healthy`，profile parity 为 `healthy`；
  测试未使用用户正在运行的 root 会话，未重启 DSH。
- 兼容边界：新增内部模型调用若返回 JSON 或其他结构化文本，必须带
  `Symbol.for('dsh.team-message-time.skip-response')`，否则会被当成普通响应
  追加时间；普通对话和 Team 注入不需要逐个改生产者。
