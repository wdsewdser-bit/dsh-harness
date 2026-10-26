# Agent Team 性能热修记录（2026-09-26）

## 结论

本轮“发 Team 消息慢、会话加载慢、工具超时”的主要控制面原因已经定位并修复：

1. 控制面热写会把 `v12RoomWake.inbox` 的 256 条记录逐条写成 cold 文件。
   实测一次热持久化需要约 7.8–8.9 秒，期间 DSH 主线程被同步 I/O 占住，
   会连带造成消息投递、会话加载和普通 HTTP 响应一起变慢。
2. 性能补丁中的历史 append 逻辑把“本次新增行”当成完整历史执行
   `slice(previous)`，历史一长会漏掉新事件；已改为显式区分 `full:false`
   与 `full:true`。
3. Web profile 的 HMR 配置使用绝对 `root`，在 Windows/chokidar 的
   `cwd` 组合下曾解析到用户目录并撞 `NTUSER.DAT`。已改成
   `file:///D:/.../web/` 的 `base` + 相对 `plugins` 根目录，避免再次把
   HMR 锁到用户主目录。
4. 热状态文件本身已增长到约 `6.7 MB`，旧路径每次 mutation 都用
   `writeFileSync + renameSync` 同步写整份。已新增异步原子热快照写：
   大文件写入不再占住事件循环；面板缓存小文件走同步快路径，大文件走异步写。
5. cold raw 缓存原先只按路径复用，外部篡改或删除后可能继续返回旧字节。
   现在缓存原始字节和文件签名，签名变化即重新读取并校验 SHA-256，
   保留 fail-closed 语义。
6. `readTelemetry()` 原先每次 idle 都扫描整个控制面目录；该目录当前有
   `6490` 个文件。已增加 10 秒有界目录读取缓存，多个 agent 的 idle 事件
   不再重复全目录扫描。
7. `team-v13-compaction-shadow` 原先每个新 session 都递归扫描 sessions
   目录找自身目录；已增加 30 秒 session-dir 索引缓存，未命中时才强制重建。
8. `v14-event-continuation` 的 completion summary 状态是热状态，不再走
   带历史检测的 `mutate`，改为 `mutateHot`。

## 实测数据

- 修复前：真实控制面状态热持久化约 `8918.9 ms`。
- 修复后：同一状态热持久化约 `272.2 ms`，第二次约 `256.3 ms`。
- 修复后 Room append 路径约 `855.9 ms`（包含面板缓存写）。
- 热状态体积实测约 `6.7 MB`；主要字段为 `v12Requirements`、`boards`、
  `v12Evidence`、`evidence`、`dispatches`、`v12RoomWake`。
- 当前真实控制面目录约 `6490` 个文件、`8.27 GB`；其中 cold 约
  `7.39 GB`、临时文件约 `665 MB`、audit 约 `140 MB`。本次未清理这些
  旧文件，避免误删仍在恢复链上的数据。
- 热视图缓存命中约 `0.03 ms`；冷启动首次读取约 `1.1 s`。
- append 回环：Room 消息、v12 事件、room-wake 事件均恢复为
  `2 / 2 / 2` 条。
- inbox 批量回环：`m1`、`m2`、`m3` 全部可恢复。
- 独立验证实例（独立 home，端口 `40125`）：Web 根入口返回 `200`，耗时约
  `949 ms`；修改 probe 文件后日志出现 `reload-probe loaded v2`，HMR 实际重载成功。
  验证实例已停止，未触碰当前用户会话。

## 变更文件

- `home/profiles/web/plugins/team-control-plane.mjs`
- `home/profiles/headless/plugins/team-control-plane.mjs`
- `home/profiles/web/plugins/team-v13-mechanism-telemetry.mjs`
- `home/profiles/headless/plugins/team-v13-mechanism-telemetry.mjs`
- `home/profiles/web/plugins/team-v13-compaction-shadow.mjs`
- `home/profiles/headless/plugins/team-v13-compaction-shadow.mjs`
- `home/profiles/web/plugins/team-v14-event-continuation.mjs`
- `home/profiles/headless/plugins/team-v14-event-continuation.mjs`
- `home/profiles/web/plugins/team-v12-runtime.mjs`
- `home/profiles/headless/plugins/team-v12-runtime.mjs`
- `home/profiles/web/plugins/team-tools-v2-r10.mjs`
- `home/profiles/headless/plugins/team-tools-v2-r10.mjs`
- `home/profiles/web/cordis.patch.yml`

## 备份

- `team-control-plane.mjs.bak-20260926-perf3`
- `team-control-plane.mjs.bak-20260926-perf4`
- `team-v13-mechanism-telemetry.mjs.bak-20260926-perf4`
- `team-v13-compaction-shadow.mjs.bak-20260926-perf4`
- `team-v14-event-continuation.mjs.bak-20260926-perf4`
- `team-v12-runtime.mjs.bak-20260926-perf3`
- `team-tools-v2-r10.mjs.bak-20260926-perf3`
- `cordis.patch.yml.bak-hmr-base-20260926`

## 回归状态

- `v14-storage` + `v14-runtime-bridge`：`21 pass / 1 skip / 0 fail`。
- 最终聚焦回归（storage + runtime-bridge + failure-memory）：
  `30 pass / 1 skip / 0 fail`。
- 单并发 phase11 全量最近一次：`81 pass / 1 skip / 3 fail`。
- 剩余失败均为时间敏感断言：bounded wake 的 `<1500 ms` 返回窗口，以及
  continuation 的 `30 ms` 等待窗口；同一 bounded-wake 用旧备份模块验证也会
  超时，属于当前 Windows 文件 I/O 延迟下的既有测试脆弱点。核心 storage、
runtime、Room、scheduler、panel 回归通过。

最终双份部署哈希：

- `team-control-plane.mjs`: `99F3CC47CD3C6E510B0D0373A1669BDBBD43F82022486DBBE2F3FF1BF0A5718E`
- `team-v13-mechanism-telemetry.mjs`: `D78202FAE57A552E2EE8C5945CB5AA0DDF4A7C2D3CAE6621E58CED8D4C48C234`
- `team-v13-compaction-shadow.mjs`: `55F0F386913F8358792422CD0A4716A4C30E4ACB2AB3B37A168DC01D3E5B779F`
- `team-v14-event-continuation.mjs`: `FA77148399F0084715E33FAEC09F442148A7613445E0C1C57C5083995595CBD7`

## 部署边界

当前 DSH 进程没有实际热加载这些新文件；不能只凭磁盘哈希声称已生效。
应用补丁需要一次受控重启。重启前不要清理
`home/team-control-plane` 下的 cold、tmp、audit 或 session 数据。

## 第二轮运行态补丁（2026-09-26 05:30–07:10）

第一轮补丁已通过临时探针确认被当前 Web HMR 实际加载；本轮继续处理
消息投递和跨进程写竞争：

1. `team-control-plane.mjs` 的延迟持久化现在在 debounce 窗口内持有同一把
   跨进程文件锁，直到延迟快照写完才释放。此前 timer 在 commit 释放锁后
   重新拿锁，A 进程的旧快照可能覆盖 B 进程刚提交的状态。
2. mutation 合并窗口从 `75 ms` 提高到 `250 ms`，并让延迟写复用同一把锁；
   同一消息链上的 Room notice、dispatch、wake claim/ack 不再各写一遍热快照。
3. `team-v12-runtime.mjs` 的派生视图、observation、delivery receipt、
   post-mirror、mirror failure 等路径同步使用 `250 ms` 合并窗口。
4. 面板缓存增加内容指纹；房间、transcript、inbox 的实际内容未变化时，
   不再重写约 `3 MB` 的 `.panel-cache.json`。
5. `team-tools-v2-r10.mjs` 的 `deliverWake` 超时现在会真正 abort 底层
   `ctx.agentTeams.sendMessage`，避免调用方已经返回 `queued` 后，后台仍
   继续占用 PTC 执行预算。
6. 对“上级唤醒已激活的下级”增加直接 `Agent.steer()` 快路径，跳过核心
   mailbox 的 `Session.flush`；冷目标、越权目标和向上决策仍回退到原
   `ctx.agentTeams.sendMessage` 路径。

本轮验证：

- `node --check`：Web/headless 三份文件均通过。
- 聚焦回归：`51 tests / 50 pass / 1 skip / 0 fail`。
- HMR 探针：
  - `team-control-plane` `2026-09-26T06:50+08:00` 已出现在
    `logs/dsh-test.log`。
  - `team-tools-v2-r10` `2026-09-26T07:08+08:00` 已出现在
    `logs/dsh-test.log`。
- 运行中控制面采样：热状态约 `7.69 MB`，audit 约 `131.4 MB`；
  低活动窗口内 cold 文件增长从每 3 秒约 10 个降到偶发 1–2 个。
- 进程未重启；当前 Node 进程仍持有约 `8.5 GB` Working Set。该值主要来自
  已加载的长会话历史，插件热加载不会回收这部分堆内存。

最终双份部署哈希：

- `team-control-plane.mjs`:
  `5C79E24515BD870A2944EAED79E781AB2502F6A11FE627C1AC5F4744332032A4`
- `team-v12-runtime.mjs`:
  `B660D470920C0CA39D1DFB94E2D05F90E7452D121A8D42BDC24D8A5D30A91D42`
- `team-tools-v2-r10.mjs`:
  `8502AA1E0B9E66460FEACB2E02EA4E11610D24837906890FBF6ACCDDF32F8B2F`

剩余风险：

- 当前进程的堆高水位无法在不重启的情况下回收；若再次接近
  `12 GB` heap limit，应安排一次受控重启，不要清理 cold/audit/session。
- 直接 steer 快路径只覆盖“已激活的下级”；如果实际运行中发现目标未启动
  或版本不支持 `steer`，会回退 mailbox。
- 会话加载慢还包含 DSH 自身的 JSONL+zstd 持久化开销；本轮只降低了 Team
  控制面和消息投递的写放大，没有重启核心 session persistence。

## 第三轮运行态补丁（2026-09-26 06:10–06:25）

真实 UI 性能探针暴露出一个仍会触发热路径放大的问题：插件把直接唤醒和
静默通知写成核心 mailbox 的 `team-message` 来源。即使消息没有走 durable
mailbox，核心 `TeamMailbox.observeSessionEvent` 仍会在目标会话发布
`user/message` 后调用 `Session.flush`，等于绕过 mailbox 后重新触发同一笔
昂贵落盘。

本轮修改：

1. `team-tools-v2-r10.mjs` 的插件直投来源改为 `team-plugin-message`；
   quiet batch 同时兼容新旧来源，避免丢失通知合并。
2. `deliverWake` 的直接唤醒来源改为 `team-wake`，不再被核心 mailbox 观察。
3. 冷目标/未激活的直接下级新增 `ctx.subagents.steerPrompt(...)` 快路径：
   先尝试常驻目标的 `Agent.steer`，再尝试可续跑子代理直投；跨组 peer 或
   不可续跑目标仍回退 durable mailbox。
4. Room handoff 现在允许 direct fast path。常驻 peer 可直接 steer；不在
   进程中的 direct child 可 cold-resume；失败仍回退 mailbox。

真实 UI 探针（`session-280eba98`，`test` 工作区）：

- 向旧测试会话发送 `team_wake(target:"lead-a", message:"PONG probe",
  reason:"验证直投唤醒性能")`。
- root 本轮 `9 s` 完成，工具返回
  `{"target":"lead-a","status":"delivered","dispatchId":"wake:team-wake:lead:lead-a"}`。
- 控制面时间线：
  `wake/claimed` 1790374806126 →
  `wake/acknowledged(delivered)` 1790374806236（110 ms）→
  `wake/acknowledged(turn-started)` 1790374806288（52 ms）。
- 同一窗口没有 `team/message/queued` 或 `team/message/delivered`；证明直投
  没有重新进入核心 durable mailbox。
- `lead-a` 实际收到并回执 PONG，说明不是“只记录 delivered 没送达”。
- 同一浏览器冷加载采样从修复前首次 `15.15 s` 降到后续 `3.12 s` 到
  `networkidle`；这不表示所有会话加载都已解决，但确认首屏不再稳定卡在
  十几秒。

本轮验证：

- `node --check`：Web/headless 通过。
- 聚焦回归：
  `v14-storage` 10 pass / 1 skip、
  `v14-runtime-bridge` 11 pass、
  `v14-room-seat` 2 pass；
  `v14-bounded-wake` 4/4 harness checks。
- 直投单元探针：`send_message(delivery:"action")` 调用
  `subagents.steerPrompt` 一次，`mailboxSends=0`，来源为 `team-wake`。
- HMR 探针：`[team-tools-v2-r10] HMR perf5 2026-09-26T06:22+08:00`
  已出现在 `logs/dsh-test.log`。
- Web/headless `team-tools-v2-r10.mjs` 最终字节一致：
  `CAE32E84ACC37274E56A3200143BCFF77999F20E188CD8FC7BC2A3A35920D2C3`。
- 本轮修改前备份：
  `team-tools-v2-r10.mjs.bak-perf5-20260926-061815`（Web/headless 各一份）。

仍未热修的核心层：

- `dsh-session-persistence-jsonl` 的 `appendLines()` 每批
  `open/write/fsync/close`，没有复用 append handle。
- `dsh-experimental-agent-team` 的 durable mailbox fallback 仍会在
  queued/delivered 时调用 `Session.flush`。
- 这两处只能通过受控重启加载；当前没有为了修它们而重启正在运行的
  `PID 35728`。

## 第四轮运行态补丁（2026-09-26 06:30–06:50）

真实运行中又确认了两个不同层面的慢点：

1. `deliverWake` 仍保留的冷目标 `ctx.subagents.steerPrompt(...)` 路径没有
   上限。冷恢复大会话时会连续占用 PTC 执行预算，最终表现为
   `execution deadline reached (115000ms)`，后面的 `send_message` 也会被
   abort。
2. 主进程 Heap 已到约 `9.6 GB`，接近 `--max-old-space-size=12288` 的
   上限；即使 Team 控制面没有高频 mutation，主线程仍持续 GC，采样到约
   `86%` CPU，网页请求和会话加载都被拖慢。

本轮修改：

1. `team-tools-v2-r10.mjs` 删除冷目标的无上限 `steerPrompt` 等待。
   活跃目标仍可走 `Agent.steer` 快路径，但最多等待 `500 ms`；超时后保留
   durable mailbox 行并返回 `queued`，同时 abort 调用方不再等待的
   mailbox delivery。
2. 增加临时一次性 V8 GC 钩子，只用于回收当前进程已积累的垃圾对象；
   验证完成后已从源码移除，不会在后续启动或 HMR 中重复执行。
3. 用文件事件触发了 Web profile 的真实 HMR reload，确认磁盘补丁已进入
   当前 `PID 35728`，不是只改了文件。

实测结果：

- HMR 日志已出现：
  `[team-tools-v2-r10] HMR perf6 loaded 2026-09-26T06:40+08:00`。
- 一次性 GC 前后：
  `heapUsed 7099 MB -> 6518 MB`；
  Working Set 约 `8.85 GB -> 6.78 GB`；
  空闲采样 CPU 约 `86% -> 14%`。
- 第二次对照 GC：
  `heapUsed 6280 MB -> 5700 MB`，随后 20 秒 CPU 采样约 `29.4%`；
  说明长会话堆在继续增长时仍会重新触发 GC 抖动，临时 GC 只能缓解，
  不能替代受控重启或减少长会话驻留。
- 冷唤醒修复后的新 wake 回执（`wake/claimed -> wake/acknowledged`）：
  `387 ms`、`685 ms`、`2019 ms`；不再出现新的 115 秒工具超时。
- 根页面 HTTP 连续 5 次：
  `78.4 / 4.3 / 2.4 / 2.8 / 2.6 ms`（状态码均为 `200`）。
- 聚焦回归：
  `node --test D:/dsh-test/phase11-tests/v14-bounded-wake.test.mjs`
  `1 suite / 1 pass / 0 fail`，5 个 harness checks 全部通过。

本轮最终双份部署哈希：

- `team-tools-v2-r10.mjs`（Web/headless 字节一致）：
  `155524E5E5961753F3F4D1A3487CA296CB473807E320A3EE007A8DC4C0002ADD`
- `team-control-plane.mjs`：
  `5C79E24515BD870A2944EAED79E781AB2502F6A11FE627C1AC5F4744332032A4`
- `team-v12-runtime.mjs`：
  `B660D470920C0CA39D1DFB94E2D05F90E7452D121A8D42BDC24D8A5D30A91D42`

本轮修改前备份：

- `team-tools-v2-r10.mjs.bak-perf6-coldwake-20260926`（Web/headless 各一份）

未处理边界：

- 这次 GC 只回收了当前堆中的可回收对象，不会缩小已经驻留的长会话
  历史；如果 Heap 再次逼近 12 GB，仍应安排一次受控重启。
- `dsh-session-persistence-jsonl` 的 append handle 复用和
  `dsh-experimental-agent-team` durable mailbox 的 `Session.flush`
  仍未热加载，原因是它们位于 `node_modules` 核心包，需要重启后验证。

## 第五轮运行态补丁（2026-09-26 08:05）

本轮继续审计“消息发送慢、会话加载慢、普通响应慢”的重复放大点，新增
两处热加载修复：

1. `controlPlaneForMember()` 原先在每次 Team root 选择时调用
   `readDurableJson(file)`，对约 `7.5 MB` 的控制面热快照做一次同步
   `readFileSync + JSON.parse`。该函数位于 `cp()`、pre-step 和工具调用
   附近，热状态频繁变化时会让缓存持续失效。

   现在改为紧凑的 `rootIndex`：每次状态进入内存或成功发布时，只提取
   active privilege / active lease 的成员名和文件签名。签名一致时直接
   查索引；未命中才回退到原文件读取。这样既去掉重复解析，也保留
   “损坏候选必须报错”的 fail-closed 语义。

   稳定文件基准（同一份真实控制面快照，1000 次调用）：

   - 旧路径等价读取：约 `31.7 ms/次`。
   - 新 root index：`51.9 ms / 1000` 次，约 `0.052 ms/次`。

2. `team-tools-v2-r10.mjs` 的直接 `steer` 快路径从“仅允许下级”扩展为
   所有已登记且活跃的 Team 目标。此前同级/上级的 `delivery:"action"` 和
   `delivery:"decision"` 仍会落入核心 durable mailbox，并触发目标
   Session 的昂贵 `flush`。现在活跃目标直接注入，未激活、越权或版本
   不支持时仍回退原 mailbox。

3. 控制面异步快照的原子 `rename` 在 Windows 下观察到瞬时 `EPERM`
   （文件被占用），会造成持久化失败和状态滞后。现已增加
   `EPERM/EACCES/EBUSY` 有界重试，并在最终失败时清理临时文件。

本轮验证：

- `node --check`：Web/headless 的 `team-control-plane.mjs` 与
  `team-tools-v2-r10.mjs` 全部通过。
- 完整 phase11 回归：`87 tests / 86 pass / 1 skip / 0 fail`，其中新增
  2 个 session artifact cache 回归测试。
- HMR 运行态日志已出现：
  - `[team-control-plane] HMR perf12 loaded 2026-09-26T08:18+08:00`
  - `[team-tools-v2-r10] HMR perf9 loaded 2026-09-26T07:45+08:00`
- 根 HTTP 热请求仍为 `200`，采样约 `3–5 ms`（首次约 `114–141 ms`）。
- 最近 25 条真实 wake 回执（修复前/切换期混合窗口）平均约 `1.11 s`，
  最大 `3.78 s`；新修复后的实时流量尚未形成足够样本。

最终双份部署哈希：

- `team-control-plane.mjs`（Web/headless 字节一致）：
  `3ACEF1DE1EEFB7E34E64C5E8F166E3D98E24BD95F88CC9BC471C21B724DB5DFA`
- `team-tools-v2-r10.mjs`（Web/headless 字节一致）：
  `3831585A4F14EBEBAEA1972AB1DAFF47544912FA42C5A4D8CAF13E61DE288154`

当前仍未热加载的核心层：

- `dsh-session-persistence-jsonl/lib/index.js` 的 `appendLines()` 仍然每批
  `open -> write -> fsync -> close`。
- `dsh-experimental-agent-team/lib/index.js` 的 `checkpointDelivered()` 仍在
  每次 durable mailbox 投递后调用 `Session.flush`。

这两处位于 `node_modules` 核心包，不能靠 profile HMR 生效；需要一次受控
重启后再做真实消息回环验证。当前 `PID 35728` 未重启，Working Set 约
`6.1–6.4 GB`，不能通过继续热加载回收已经驻留的长会话历史。

## 第六轮持久补丁（2026-09-26 08:30–08:55，待重启生效）

本轮继续定位“加载会话、响应、发 Team 消息都慢”的系统级原因，确认
`/api/session/list` 仍会在每次调用时重新扫描整个会话仓库：

- 会话根目录有 430 个会话目录、128 个 `session.v4.jsonl.zstd`，压缩文件
  合计约 725 MB。
- 冷请求实测为 `5347 ms`，在并发/主线程繁忙时出现 `37779 ms`、
  `29372 ms`；热请求仍约 `473–644 ms`。
- `dsh-session-persistence-jsonl` 的 `listArtifacts()` 每次都枚举目录、逐个
  `stat`、读取每个 zstd 文件的第一行并解析 header，且并发请求不会合并。

已写入持久 `pnpm patch`（当前进程未加载，重启后生效）：

1. `dsh-session-persistence-jsonl@0.1.7-rc.2`
   - 增加 5 秒 artifact listing 缓存。
   - 同一批并发 `listArtifacts()` 合并为一个实际扫描。
   - 本地 append/materialize/repair 时使缓存失效。
   - patch：
     `D:/dsh-test/app/patches/@deepseek-ai__dsh-session-persistence-jsonl@0.1.7-rc.2.patch`
   - SHA256：
     `D55D1909E93CAE6172A3BDFC266B0E4471C37AD965DF4A6B40D3F2894CB498A2`

2. `dsh-experimental-agent-team@0.1.7-rc.2`
   - `checkpointDelivered()` 在目标 Session 已记录 message ID 时，不再先调用
     昂贵的 `ctx.sessions.flush(target)`，直接补 durable delivered 边。
   - Web/headless 两份 patch 字节一致：
     `D:/dsh-test/home/profiles/{web,headless}/patches/@deepseek-ai__dsh-experimental-agent-team@0.1.7-rc.2.patch`
   - SHA256：
     `758C843A9773113F7848EDDE0F468B823ADF0E0E3B24992DFA32A2ED6EA60127`

本轮验证：

- `node --check`：核心 persistence、Web/headless Team package 全部通过。
- artifact cache 探针：并发两次 + 顺序一次只扫描 1 次；显式失效后再扫描
  1 次，符合预期。
- 完整 phase11 回归：`85 tests / 84 pass / 1 skip / 0 fail`。
- 运行态 HMR 热修哈希保持不变：
  - `team-control-plane.mjs`：
    `3ACEF1DE1EEFB7E34E64C5E8F166E3D98E24BD95F88CC9BC471C21B724DB5DFA`
  - `team-tools-v2-r10.mjs`：
    `3831585A4F14EBEBAEA1972AB1DAFF47544912FA42C5A4D8CAF13E61DE288154`

当前边界：

- 这两项位于 `node_modules` 核心包，不能靠 profile HMR 生效；`PID 35728`
  未重启，所以当前请求仍走旧实现。
- 曾尝试通过 profile 插件从 `ctx.root` 包装 `sessionQuery.listSessions`，
  实测实际 API 不经过该包装，已完整回滚，未留下运行态插件改动。
- 当前主进程 Working Set 约 `7.0 GB`、Private Memory 约 `8.2 GB`。长会话
  历史驻留仍是“响应慢、工具偶发超时”的主要系统级风险；重启会同时加载
  上述持久补丁并回收这部分堆，但本轮未在未获批准的情况下重启。

## 第七轮运行态优化（2026-09-26 08:55–09:05）

本轮在 `PID 35728` 上继续做了只影响运行态的补丁，目标是先压住“发 Team
消息慢”和主进程持续 GC 抖动；核心 persistence 的会话列表补丁仍然需要
下一次受控重启才生效。

实时观测：

- 会话仓库：`128` 个 `session.v4.jsonl.zstd`，压缩日志合计约 `741 MB`；
  最大单会话约 `55 MB`。
- 控制面热快照：约 `8.86 MB`；审计侧车约 `127 MB`；panel cache 约
  `3.26 MB`。
- 主进程：Working Set 约 `7.2 GB`，Private Memory 约 `8.6 GB`；空闲采样
  CPU 约 `12–35%`，短窗口最高采样到 `251%`，说明 GC/长会话驻留仍是主要
  抖动源。
- 面板根 HTTP：冷请求约 `1523 ms`，热请求约 `2–10 ms`；这证明 HTTP
  服务本身不是主瓶颈，请求成本主要落在会话列表、控制面大对象和 GC。

本轮热加载修改：

1. `team-tools-v2-r10.mjs`：`team_wake`、`team_wake_superior` 和
   `team_escalate` 对已登记且活跃的目标也走 bounded direct steer，不再
   无条件进入 core durable mailbox；未激活目标仍回退 mailbox。
2. `team-control-plane.mjs`：审计追加改为复用 append fd，不再每条事件
   `open -> write -> close`；默认快照合并窗口由 `250 ms` 调整为 `1000 ms`，
   减少 8.8 MB JSON 快照的重复序列化/落盘。
3. `dsh-session-persistence-jsonl` 持久补丁：普通 `persistBatch` 追加不再
   使 artifact-list cache 失效；只有首次 materialize、header 写入和 repair
   才失效。这样 Team 持续追加日志时，5 秒列表缓存不会被每条 append 清空。
   该改动在当前进程未加载，仍待重启。

一次性运行态验证：

- 临时 GC 钩子只用于当前进程：heap `6499 MB -> 6461 MB`；
  Working Set 约 `7.2 GB -> 6.3–6.5 GB`，Private Memory 约
  `8.6 GB -> 7.4–7.6 GB`。钩子已从源码移除，不会在后续启动或 HMR 中执行。
- HMR 日志已出现：
  `[team-control-plane] HMR perf14 loaded`；
  `[team-tools-v2-r10] HMR perf14 loaded`。
- `node --check`：Web/headless 两个热修文件及核心 persistence 文件全部通过。
- 完整 phase11 回归：`87 tests / 86 pass / 1 skip / 0 fail`。

本轮最终哈希：

- `team-tools-v2-r10.mjs`（Web/headless 字节一致）：
  `E559F8BDB423FEBB8DF57A5D3C9353D7E3747030DDBB960BF511652A2AC57CFE`
- `team-control-plane.mjs`（Web/headless 字节一致）：
  `83901717AD2A238084305935570332B455D2E8F10D9E18CCBB1F054098308341`
- `dsh-session-persistence-jsonl/lib/index.js`：
  `EB2204DC4E8F16F37BAA8CCE89A3BB7F90B795947E29CC4950A57A85281C73B6`
- persistence patch：
  `2D7393886776775BDB721FD1030A133573C6126D828497B132D157FE6FC0E349`

边界：

- `team-tools` 和 `team-control-plane` 的 perf14 已热加载到当前 Web 进程；
  持久化会话列表缓存仍必须重启后才能验证真实 `/api/session/list` 冷/热
  请求。
- GC 只能回收可回收对象，不能解决 128 个会话和长历史继续驻留的问题。
  如果 heap 再次接近上限，下一次受控重启仍是必要的。

## 第八轮运行态热点修复（2026-09-26 08:09–08:20）

本轮用真实控制面状态和两次 5 秒 CPU profile 继续定位，没有重启
`PID 35728`，也没有清理任何会话、cold、audit 或临时数据。

### 根因与修复

1. `team-v14-event-continuation.mjs` 的 `continuationCandidates()` 原先为
   每个 pending/approved/in_progress 候选都调用一次 `buildReadyQueue()`。
   291 张卡、55 个候选时，每次 continuation 扫描会重复处理整块 task/
   member/lease 状态并计算摘要。
   - 现在由 `team-v12-evidence-scheduler.mjs` 新增
     `createReadyQueueContext()` / `evaluateReadyTask()`，整轮只建一次
     queue context；idle-resume 只对候选任务做局部 status/running 覆盖。
   - continuation 使用无 digest 模式，不再为内部判定计算
     `stableJson + sha256`。
   - `apply()` 内的当前候选检查复用同一份成员列表，不再对每个候选重复
     `teams.listMembers(root)`。

2. `team-tools-v2-r10.mjs` 的 `policy()` 原先每次工具调用都会重新
   `tryMembership()`、`listMembers()` 和 `reconcileRegistry()`。真实 profile
   中 5 秒内 `foldSubagentDescriptor` 约占 `1.7 s`。
   - `team-policy.mjs` 对稳定 agent 对象缓存 Team membership id。
   - `team-tools-v2-r10.mjs` 对 Team policy projection 增加 500 ms 有界
     cache；同一工具调用链不再反复折叠完整 roster。

3. `team-control-plane.mjs` 的 `counters()`、`health()`、`providerState()`
   原先使用默认 `clone:true`，每次只读取一个小对象却
   `structuredClone` 整个约 9 MB 热状态。profile 中 5 秒内整状态
   `structuredClone` 约占 `1.25 s`。
   - 三个只读访问器改为 `clone:false` 读取热状态，仅 clone 返回的小投影。

### 实测结果

- continuation 真实状态基准：
  - 修复前：`470.06 / 498.70 / 520.69 ms`。
  - 修复后：`5.10 / 3.09 / 2.91 / 5.19 / 2.73 ms`。
- 同进程 20 秒 CPU 采样（工作负载不完全相同，仅作趋势判断）：
  - 修复前：平均 `181.2%`，最低 `84.7%`，最高 `404.2%`。
  - 修复后：平均 `45.1%`，最低 `0%`，最高 `374.5%`。
  - Working Set 从约 `8.0 GB` 降到约 `6.1 GB`。
- 5 秒 CPU profile：
  - 修复前：`foldSubagentDescriptor` 约 `1.69 s`，
    `structuredClone` 约 `1.25 s`。
  - 修复后：`structuredClone` 约 `31.5 ms`，`foldSubagentDescriptor`
    已退出主要热点；同窗口 idle 约 `2.85 s`。

### 回归

```text
phase11: 87 tests / 86 pass / 1 skip / 0 fail
phase9:  54 tests / 54 pass / 0 fail
```

continuation 新实现与备份旧实现针对真实控制面状态做了深比较，候选结果
完全一致；`buildReadyQueue` 的 `ready`、`blocked`、`revision` 也与旧实现
一致。

### 当前部署哈希

以下 Web/headless 两套文件均字节一致：

```text
team-v12-evidence-scheduler.mjs =
  E96284E26C823AF837F05AC9ECBD33643D8D167BCDBD2ACDC972D37D5823C6C4
team-v14-event-continuation.mjs =
  B434D086E5EA432906CBB9702AB8F4004FA954A2E5F29DD701E260A48F7DA7AD
team-control-plane.mjs =
  5DA7578019AA448CCE95F11593C2F5C14C0665E2B855C751522A8C3E465300E7
team-policy.mjs =
  A9A5A9A6775155EBDA177C3348F04318AC35FC5B1D7B8D4B1F92AFD4DD6F4CF4
team-tools-v2-r10.mjs =
  A5E6AF812F8FA0F8A27D58F672EDF40D5EF1490E740B4603081E34BF9F03676C
```

核心 persistence 的会话列表缓存补丁哈希仍为：

```text
EB2204DC4E8F16F37BAA8CCE89A3BB7F90B795947E29CC4950A57A85281C73B6
```

### 备份

- `D:/dsh-backups/perf-continuation-20260926-080901`
- `D:/dsh-backups/perf-policy-20260926-081749`

### 边界

- 本轮运行态修复已通过 HMR/profile 和真实状态基准验证；核心
  `dsh-session-persistence-jsonl` 的会话列表缓存仍需要下一次受控重启
  才会进入核心模块。
- `PID 35728` 未重启、未停止。后续如果重启，必须按持久补丁部署边界
  验证 `/api/session/list` 冷/热请求。

## 第九轮运行态热点修复（2026-09-26 08:49）

第八轮之后，真实运行态的 `structuredClone` 仍然是最大可归因热点：

- 5 秒 CPU profile 中，全部 `structuredClone` 采样约 `20.6%`（773/3747）；
- 单个最热调用点约 `8.4%`（316/3747），调用栈为：
  `cloneCachedState -> load -> deferred commit -> withFileLock`；
- 原因是延迟写事务虽然已经合并磁盘快照，但每笔 Room/wake 热更新进入
  `commit()` 时仍会先把约 `10 MB` 的完整控制面状态深拷贝一次；
- `send_message` 会连续触发 `roomNotice -> wakeClaim -> dispatchCreate`
  等多笔热更新，因此一次消息会重复支付多次整状态复制。

修复内容：

1. Web/headless 两份 `team-control-plane.mjs` 的 deferred commit 路径改为
   `load(..., { history: historyHydrated, clone: false })`。
   该路径已经由进程内 mutation queue 和跨进程文件锁串行化，内存热状态
   仍是权威状态；延迟快照、审计追加、锁持有和 `flush()` 语义保持不变。
2. HMR marker：
   `[team-control-plane] HMR perf16 clone-free loaded 2026-09-26T08:49+08:00`
   已出现在 `D:\dsh-test\logs\dsh-test.log`。
3. Web/headless 两份文件字节一致，SHA256：
   `3F7A9081C66692065BEE617E3966E45E0E45649E86094D6417360CA6878AB5EE`。
4. 本轮修改前备份：
   `team-control-plane.mjs.bak-20260926-perf15-clone`（Web/headless 各一份）。

验证：

- 同进程 10 MB 合成控制面状态，连续执行 120 笔
  `roomOpen + roomNotice + wakeClaim`：
  `commitMs=672.9`、`flushMs=47.7`、`revision=121`、
  热快照 `10,534,127 bytes`。
  这表示热更新阶段平均约 `5.6 ms/笔`，不再等待整状态深拷贝。
- 完整回归：
  - `phase11`: `87 tests / 86 pass / 1 skip / 0 fail`
  - `phase9`: `54 tests / 54 pass / 0 fail`
- `node --check`：Web/headless 两份 `team-control-plane.mjs` 均通过。
- `PID 35728` 未重启、未停止；当前 Working Set 约 `8.1 GB`，Private
  Memory 约 `9.6 GB`。

剩余边界：

- 会话列表慢的核心修复仍在 `dsh-session-persistence-jsonl` 的持久
  `pnpm patch` 中，当前进程没有加载；下一次受控重启后才能验证
  `/api/session/list` 的冷/热请求。
- 长会话历史仍驻留在当前 Node 堆中，`perf16` 只能消除控制面热写复制，
  不能回收约 8 GB 的既有堆高水位。

## 第十轮：v14 context manifest 去重修复（2026-09-26 16:02）

root 会话出现高频压缩的根因不是 75% 阈值，而是 v14 context delta 重复
注入：

- `team-v12-runtime.mjs` 的 pre-step 只在 `pendingInbox === true` 时读取
  已提交历史，正常情况下 `visible` 看不到上一步的 context manifest；
- `buildContextDelivery()` 的 `id + hash` 去重因此失效，每一步重新发送
  接近 `contextPackMaxTokens` 上限的完整 manifest；
- 实测 root 最近每份 manifest 约 7.6 万字符、3.0 万到 3.2 万 estimated
  tokens，最近 10 份合计约 31 万 tokens，直接造成“压完很快再爆”。

修复：

1. pre-step 始终读取有界的 `recentDerivedMessages(stepped.session)`；
2. `visible` 始终包含已提交历史与当前输入；
3. `nativeMessageIds` 复用同一份可见历史，不再走 64 条旁路；
4. 新增回归
   `pre-step deduplicates a committed context manifest when no inbox is pending`。

验证：

- `node --check`：desktop/web/headless 三份 runtime 均通过；
- `v14-runtime-bridge.test.mjs`：`12 pass / 0 fail`；
- phase9 Room/compaction context：`9 pass / 0 fail`；
- 三份 runtime 字节一致，SHA256：
  `53A5D373D635176C10E57F0E3510B1BD04C09DB88D76CB86C1F3F2D5FCBF6A0F`；
- HMR 后 root 日志继续推进但未再出现新的重复 manifest。

备份：

- `D:/dsh-test/backup-v14-context-dedupe-20260926-155334`

已知残余：phase11 全量中 `v14-bounded-wake.test.mjs` 的
“background delivery acknowledges the wake”仍失败；该测试不导入本轮修改的
`team-v12-runtime.mjs`，属于既有独立问题。

## 第十一轮：frozen nextSpeaker 房间死锁修复（2026-09-26 16:06）

实测房间 `task:g-boot-wake-3` 进入不可收口状态：

- `nextSpeaker = lead-boot2`，但该成员已 frozen；
- `force_close(waived:["lead-boot2"])` 后仍缺 host `lead`；
- host 补发言被 `round expects "lead-boot2" to speak next` 拒绝；
- 因此形成 `close -> host speak -> frozen speaker -> close` 循环。

修复：

1. `team-control-plane.mjs` 新增 `nextEligibleSpeaker()`；
2. `roomNext` 从起点开始跳过 frozen 成员；
3. `roomPost` 发现当前 `nextSpeaker` 已 frozen 时，先推进到下一个未发言且
   未冻结的成员，再校验 author；
4. 已存在的坏房因此可由 host 直接补发言，再用原 force-close 机制豁免
   frozen 成员并收口。

回归：

- 新增 `frozen next speaker is skipped so the host can finish and force-close`；
- `node --check`：desktop/web/headless 三份 control-plane 均通过；
- `v14-room-seat.test.mjs`：`3 pass / 0 fail`；
- 三份 control-plane 字节一致，SHA256：
  `DB7A8FFA38B766BAF0688CBB330048E7495BBF26D410F6493BA478D6447A666E`。

备份：

- `D:/dsh-test/backup-v14-frozen-speaker-20260926-160300`

## 第十二轮：requirements ledger copy-on-write（2026-09-27）

大会话
`session-7a601594-66f6-4255-92ba-1ef6813cbf1a.json`
的 `v12Requirements` 已增长到约 `11.2 MB`，包含 258 条 requirement 和
1000 条 event。原实现每次 requirement/decision mutation 都通过
`createRequirementLedger()` 对整个 ledger 执行
`JSON.parse(JSON.stringify(...))`；`diffRequirements()` 还会额外生成一次
未使用的完整快照，形成主要写入与读取热点。

修复：

1. `createRequirementLedger()` 改为 copy-on-write 容器复制，不再深拷贝所有行；
2. `recordRequirement()` / `recordDecision()` 只深拷贝即将替换的单行；
3. `supersedeRequirement()` 显式 clone current/replacement 两行，保证旧快照隔离；
4. `requirementSnapshot()` 直接从共享 ledger 读取并只 clone 选中的结果；
5. `diffRequirements()` 删除未使用的全量快照，并只扫描 event 与命中行；
6. 补充 copy-on-write 回归，验证 mutation 不会修改旧 ledger。

真实大会话基准（同一 11.2 MB ledger，7 次中位数）：

- `createRequirementLedger`：`20.7 ms -> 0.11 ms`
- `recordRequirement`：`19.9 ms -> 0.23 ms`
- `diffRequirements`：`97.8 ms -> 0.39 ms`

验证：

- `v14-room-memory.test.mjs`：`12 pass / 0 fail`
- `v14-identity-context.test.mjs`：`13 pass / 0 fail`
- `v14-runtime-bridge.test.mjs`：`16 pass / 0 fail`
- phase11 全量：`120 tests / 119 pass / 1 skip / 0 fail`
- Web/headless/desktop 三份 `team-v14-requirements.mjs` 字节一致
- profile parity 与 team health 均为 `healthy`
- 运行中 PID `45532` 的 `dsh-test.log` 已出现
  `[team-v14-requirements] HMR perf-ledger loaded 2026-09-27`
- DSH Web 根入口使用当前启动 token 返回 `200`；HMR 标记之后的日志尾部
  没有新增 error / exception / EPERM / timeout

最终哈希：

- `team-v14-requirements.mjs`（三份）：
  `68B5AB393E2B338024DC78EC8809F02E3A3C2D775E8A7680C8D243F110406592`
- `v14-room-memory.test.mjs`：
  `F3CB35B45BCC260545AD2C4A728A1D360602ACDBD7C4313E9984D9848533C248`

备份：

- `team-v14-requirements.mjs.bak-20260927-perf-ledger`

同轮检查的 scheduler/continuation 大会话基准均不是主要瓶颈：

- `createReadyQueueContext`：中位约 `0.28 ms`
- `continuationCandidates`：中位约 `1.03 ms`
- `continuationSlaCandidates`：中位约 `0.19 ms`
- `buildReadyQueue`：中位约 `16.4 ms`

当前 PID `45532` 未重启；Working Set 约 `3.8 GB`，Private Memory 约
`5.7 GB`。既有长会话堆高水位仍无法仅靠 HMR 回收。

## 第十三轮：活会话历史窗口与 prompt 去重有界读取（2026-09-27）

大会话加载慢的下一层根因已确认在
`@deepseek-ai/dsh-api-session-controller`：

1. `SessionHistoryController.page()` 和 `follow()` 只需要最近
   `DEFAULT_MAX_MESSAGES`（50）条消息，却先访问 `source.events`，
   让 live observation 执行 `session.snapshotEvents()` 物化整条会话日志。
   当前 root 的 `session.v4.jsonl.zstd` 为约 `80.14 MB`，旧代备份达到
   `199.85 MB`，因此每次打开/重连都会重复支付全量历史构造成本。
2. `hasPromptRequest()` 每次发送 prompt 都用
   `session.snapshotEvents().some(...)` 扫描整条日志，只为确认当前
   `rpcId` 是否已提交；这会把“发消息”也拉进同一全量物化热点。

修复：

- 新增 `paginateLive(session, cursor, ...)`，从 `throughSeq` 反向按
  `session.eventAt(seq)` 扫描，只物化最终返回的连续窗口；
- `page()` 在 live observation 上走有界扫描，cold/prepared source 保持
  原有 `paginate(events, ...)` 语义；
- `follow()` 的初始 snapshot 在 live observation 上走有界扫描，后续
  仍由 gap-free `session/event` 流补齐；
- `hasPromptRequest()` 改为从日志尾部按 seq 反查 `user/message`，命中
  即返回，不再创建完整事件快照。

等价性验证：

- `paginateLive` 与旧 `paginate` 在 5 组边界输入上逐项相同，包括
  `throughSeq=-1`、`beforeSeq`、`turnWindow` 和 `sourceEventSeqs`；
- `hasPromptRequest` 与旧实现覆盖 tail / middle / first / missing /
  inbox 五类结果一致；
- phase11 全量：`120 tests / 119 pass / 1 skip / 0 fail`；
- `node --check`：安装后的 controller 通过。

持久化：

- 新增
  `D:/dsh-test/app/patches/@deepseek-ai__dsh-api-session-controller@0.1.7-rc.2.patch`；
- `pnpm-workspace.yaml` 与 `pnpm-lock.yaml` 已登记该 patched dependency；
- 当前安装文件：
  `D:/dsh-test/app/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js`；
- patch SHA256：
  `3B6F2CA05BFCF20E0ADD189C15CBE4AC06B003A48B2A7DB272988B8155742C5F`；
- 安装文件 SHA256：
  `EBFD8464150950CB2EE1BD9D3EA4E0C40B8CA3C02C16D88CB9F813F51EF684A7`。

边界：

- 当前 PID `45532` 未重启，已加载的 controller 仍是旧代码；该修复会在
  下一次受控启动时进入运行态。
- append handle 复用只测得每批约 `0.63 ms` 收益，本轮没有为了这点收益
  引入额外文件句柄生命周期风险。
- 备份：`D:/dsh-test/backups/perf-20260927-live-history/`。

## 第十四轮：Team 成员会话有界读取（2026-09-27）

继续检查 `@deepseek-ai/dsh-experimental-agent-team` 后，发现两条成员热路径
仍会把整条子会话物化：

1. `subagentDescriptor(agent)` 只需要判断是否有一枚
   `subagent/descriptor`，却先执行
   `session.snapshotEvents(inheritedEventCount)`；该调用会随成员会话增长
   复制整段后缀。
2. `sessionMessageAccepted()` 原先在消息投递确认路径上通过
   `snapshotEvents(inheritedEventCount)` 复制整个成员会话，再线性扫描
   `user/message` 与 `agent/inbox/spliced`。

修复：

- `subagentDescriptor()` 改为从 `inheritedEventCount` 按 `eventAt()` 正向
  扫描，只把首个描述事件交给 `foldSubagentDescriptor([event])`；
- `sessionMessageAccepted()` 改为从尾部按 seq 反查 `user/message`，同时
  只收集相关的 `agent/inbox/spliced`，再复用原有 inbox 折叠语义；
- `lib/index.js` 与 `lib/types/roster.js` 两份实现同步更新。

验证：

- `subagentDescriptor` 旧/新实现 6 组边界输入一致；
- `node --check`：安装后的 `lib/index.js` 与 `lib/types/roster.js` 均通过；
- phase11 全量：`120 tests / 119 pass / 1 skip / 0 fail`。

持久化：

- patch：
  `D:/dsh-test/app/patches/@deepseek-ai__dsh-experimental-agent-team@0.1.7-rc.2.patch`；
- patch SHA256：
  `80BDB64B973A1330A7CBFF9F92C2D1CD43F94E91F0719EEE7901D6868080D14A`；
- 安装文件 SHA256：
  - `lib/index.js`：
    `00A850DE11FFC22D41497391FAD984D01378E96A7149662FE759B38A094359EC`
  - `lib/types/roster.js`：
    `C9C28ED05A330172B9A7F17701F20E19AFE41A307F4978BCF7BD59540A33D402`
- 备份：
  `D:/dsh-test/backups/perf-20260927-roster-descriptor-20260927-051911/`。

边界：

- 当前 PID `45532` 未重启，已加载的 Team 模块仍是旧代码；该修复会在
  下一次受控启动时进入运行态。

## 第十五轮：会话标题 live 读取去除全量历史物化（2026-09-27）

会话标题服务原先在 `SessionTitleService.get(session)` 中执行
`foldSessionTitle(session.snapshotEvents())`。该函数只取最后一条
`session/title`，但每次读取标题都会物化整条会话；在会话列表、标题刷新和
重命名路径中会重复放大大会话成本。

同时，`@deepseek-ai/dsh-session-query` 的 `readTitleSnapshots()` 对 live
会话也会先通过 `source.events` 全量快照。

修复：

1. `@deepseek-ai/dsh-session-title` 新增 live 反向扫描，直接从
   `session.seq - 1` 查找最后一条 `session/title`；
2. `SessionTitleService.get()` 改用该有界路径，不再调用
   `snapshotEvents()`；
3. `@deepseek-ai/dsh-session-query` 的 live source 改为惰性 `events`
   getter，只有真正需要完整事件的投影才物化；
4. `readTitleSnapshots()` 对 live source 使用同样的尾部反向扫描，cold
   source 保持原逻辑。

验证：

- live title fold 旧/新实现 4 组边界输入一致；
- `node --check`：两个包安装后的 `lib/index.js` 均通过；
- phase11 全量：`120 tests / 119 pass / 1 skip / 0 fail`。

持久化：

- session-title patch：
  `D:/dsh-test/app/patches/@deepseek-ai__dsh-session-title@0.1.7-rc.2.patch`；
  patch SHA256：
  `D81040CE7B7D42CD7CA2F760ABE4D0F1B0F8A4D4A5D3709F082831D246A896E6`；
  安装文件 SHA256：
  - `lib/index.js`：
    `3FBE7EE66038EF20A5BB639D25D8BD470463B0B66C7827DBA0D171F8D3F7F53B`
  - `lib/types/index.js`：
    `1975257EF0F39A18507F71408BB557A250523861C1F54A7F7DF91E096613A8CF`
- session-query patch：
  `D:/dsh-test/app/patches/@deepseek-ai__dsh-session-query@0.1.7-rc.2.patch`；
  patch SHA256：
  `B70675FB03EB1A28F8FF0ADBE2F1C3E8C03ED56A6687695F90E42B37905B58AB`；
  安装文件 SHA256：
  `AD9CE2DFBB21B468D071258A22E1447D38E9B6BC1F2EF55F1B76B08F52A7A1D8`
- `pnpm-workspace.yaml` 与 `pnpm-lock.yaml` 已登记两个 patched dependency；
- 备份：
  `D:/dsh-test/backups/perf-20260927-live-title-20260927-052358/`。

边界：

- 当前 PID `45532` 未重启，已加载的 session-title/session-query 仍是旧
  代码；该修复会在下一次受控启动时进入运行态。

## 第十六轮：图片附件授权避免全量会话快照（2026-09-27）

历史图片加载路径
`SessionCommandController.attachment()` 原先每次都调用
`readSessionState()`；live 会话因此执行 `session.snapshotEvents()`，
只为在日志中寻找目标 `attachmentId`。图片较多的大会话会按每张图片重复
支付整条历史复制成本。

修复：

- live 会话改为 `referencedImageLive()`，按 `eventAt()` 扫描附件引用；
- cold 会话继续使用 `readSessionState()`，保留原有持久化与错误语义；
- 同步更新内联运行时 `lib/index.js` 与源码形态
  `lib/types/commands.js`；
- 同一 patch 同步补上 `hasPromptRequest()` 的源码形态反向读取，使
  source/package 两种入口保持一致。

验证：

- `node --check`：安装后的 `lib/index.js` 与 `lib/types/commands.js` 均
  通过；
- phase11 全量：`120 tests / 119 pass / 1 skip / 0 fail`。

持久化：

- 更新后的 patch：
  `D:/dsh-test/app/patches/@deepseek-ai__dsh-api-session-controller@0.1.7-rc.2.patch`；
- patch SHA256：
  `BA7A3110D163FE3B28B1FA40CDCF40197E9464B70D6FE2EB5B8BA8D24DF282F9`；
- 安装文件 SHA256：
  - `lib/index.js`：
    `AC0884C828E37C9728BA5263D8513F3A5985B755FFA11772115128D6F339832D`
  - `lib/types/commands.js`：
    `82F5B1854FD9AE78E0E4D737E4BBBF677269611934B7CB23BDBBAB224D07844B`
- 备份：
  `D:/dsh-test/backups/perf-20260927-attachment-live-20260927-052611/`。

边界：

- 第十三轮记录的 controller patch/安装文件哈希已被本轮 supersede；当前
  有效哈希以本节为准。
- 当前 PID `45532` 未重启，已加载的 controller 仍是旧代码；该修复会在
  下一次受控启动时进入运行态。

## 第十七轮：控制面读 API 去除整状态深拷贝（2026-09-27）

大会话的控制面快照约 `27.4 MB`，解析后的 JSON 文本约 `20.7 MB`。旧读路径
虽然已经避免从磁盘重复解析，但部分 API 仍对整份状态执行
`structuredClone`，只为返回一个 plan、task 或 board 切片。

修复：

- `planState`、`planList`、`planRequireApproved` 改为无复制读取整状态，
  只复制实际返回的 plan 行；
- `boardList`、`boardGet` 只复制目标 board/task；
- `boardSnapshot` 保留显式整板复制语义；
- `escalationList`、`packetList`、`frozenMembers`、`frozenNames`、
  `frozenIs` 同步改为按需切片。

真实状态基准（7 次中位数）：

- 旧路径整状态 `structuredClone`：约 `52-58 ms`
- 新 plan slice：约 `0.004 ms`
- 新 task slice：约 `0.005 ms`

验证：

- `node --check`：desktop/web/headless 三份 control-plane 均通过；
- phase11 全量：`120 tests / 119 pass / 1 skip / 0 fail`；
- 三份 control-plane 字节一致，SHA256：
  `4AC556F206E53C2B2D202BC803FEAA184B13C37B49FBD3E42416AEE27CEA11C0`；
- 当前 PID `45532` 的日志已出现
  `[team-control-plane] HMR storage-gc+perf17 loaded 2026-09-27`。

边界：

- 本轮没有单独备份 control-plane 文件，因此没有把这一轮描述为可回滚
  的独立变更；后续第十八轮修改前已为 team-tools 建立完整备份。
- 当前 PID 未重启；control-plane 通过 HMR 已加载，核心包 patch 仍要等
  下一次受控启动。

## 第十八轮：任务列表/单卡读取直接走控制面（2026-09-27）

`team_task_list` 在读取组板或等级板时，先调用
`policy().refreshBoards()`。该调用会在控制面 revision 变化后重建本地全部
board/task Map；随后只读取其中一张 board。`team_task_get` 也会读取本地
镜像，而不是直接读控制面。

修复：

- `team_task_list` 对非全局 board 改为
  `control().boardList(boardId)`；
- `team_task_get` 对非全局 board 改为
  `control().boardGet(boardId, task_id)`；
- 本地 board 镜像仍保留给写路径和 CAS 使用，但只读工具不再触发整板
  重建；
- web/headless/desktop 三份 `team-tools-v2-r10.mjs` 同步更新。

验证：

- `node --check`：三份 team-tools 均通过；
- 真实 `27.4 MB` 状态、7 张 board 的本地基准（7 次中位数）：
  全部 board 复制约 `5.63 ms`，单 board 行复制约 `0.97 ms`；
- phase11 全量：`120 tests / 119 pass / 1 skip / 0 fail`；
- 三份 team-tools 字节一致，SHA256：
  `F2614AAF724E51742FAEC13FE9A0AB6B6305214EAA58163C1B4DFB85942909C2`；
- 当前 PID `45532` 的日志已出现
  `[team-tools-v2-r10] HMR perf18-board-read-direct loaded 2026-09-27`；
- 该 HMR 标记之后没有新增 error / exception / timeout。

备份：

- `D:/dsh-test/backups/perf-20260927-board-read-direct-20260927-053330/`
  （web/headless/desktop 三份原文件）。

边界：

- 当前 PID `45532` 未重启；profile 插件已通过 HMR 加载，核心包 patch
  仍需下一次受控启动验证。

## 第十九轮：PTC 栈弹出避免逐次 defineProperty（2026-09-27）

CPU 采样中 `dsh-ptc-runtime-node` 的 `takeLast` 和
`defineEnumerableDataProperty` 是 PTC 控制通道的主要应用层热点。旧实现
每次从任务栈弹出一个 JSON 测量节点时，都创建一个 descriptor 并调用
`Object.defineProperty(target, "length", ...)`；在大会话或大工具结果
的 JSON 大小测量中会重复数十万次。

修复：

- `takeLast$1()` 与 `takeLast()` 改为直接执行 `target.length = index`；
- 数组的 `length` 是每个数组自己的不可配置数据属性，不经过
  `Array.prototype` 查找，因此保留原有隔离语义；
- 两个重复实现同步更新；
- 新增持久 pnpm patch，避免下一次安装丢失。

局部基准（200 万次栈弹出，7 次中位数）：

- 旧 `Object.defineProperty` 路径：约 `248.8 ms`
- 新直接长度收缩路径：约 `66.2 ms`

验证：

- `pnpm install --frozen-lockfile --offline`：patch 可重放；
- `node --check`：安装后的 PTC runtime 通过；
- 包导入成功，导出仍为 `NodePtcRuntime,default`；
- phase11 全量：`120 tests / 119 pass / 1 skip / 0 fail`。

持久化：

- patch：
  `D:/dsh-test/app/patches/@deepseek-ai__dsh-ptc-runtime-node@0.1.7-rc.2.patch`
- patch SHA256：
  `122A0E553E060ABC0AD1CA4A18C83974E250A928F2E2D94660000B3DDDF5E7B0`
- 安装文件：
  `D:/dsh-test/app/node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/index.js`
- 安装文件 SHA256：
  `99C341219B0AA71D73C3A537FA7246EB7A99FF43441807D38A6BB714A3837C98`

备份：

- `D:/dsh-test/backups/perf-20260927-ptc-takelast-20260927-0550/`
  （`pnpm-workspace.yaml` 与 `pnpm-lock.yaml`）。

边界：

- 当前 PID `45532` 未重启，已加载的 PTC runtime 仍是旧代码；该 patch
  会在下一次受控启动时进入运行态。

## 第二十轮：Session 查询、索引与持久化缓冲避免重复深拷贝（2026-09-27）

大会话的读取和搜索索引仍有一条重复物化链：

1. `dsh-session-query` 的 `snapshotLive()` 在每次 live corpus read 时执行
   `session.snapshotEvents().map((event) => structuredClone(event))`；
2. `dsh-session-query-sqlite` 的 `observeSession()` 在建立搜索文档和
   fingerprint 前，又对同一批 events 执行一次全量 `structuredClone`；
   fingerprint 本身还会先序列化完整 events；
3. `dsh-session-persistence-jsonl` 的 `enqueueLive()` 对每个新事件先复制，
   批量落盘时 `materializeAppendBatch()` 还会再次做独立快照；
4. `readSurface()` 对 live Session 仍重新对完整事件日志执行一次
   `foldSurface`，即使 Session 已有增量维护的 surface。

这些调用点的后续操作都是只读：事件折叠、文本提取和 JSON 指纹都只读取
event；live Session 返回的 events 已经是深层冻结对象，持久化冷读返回的
events 也是本次调用独占的数据。持久化缓冲持有的 Session event 同样已经
深层冻结，真正写盘前仍会经过 `materializeAppendBatch()` 的独立快照校验。
因此不再复制每个 event。

修复：

- `snapshotLive()` 改为只复制事件数组外壳 `[...session.snapshotEvents()]`，
  保留调用方对数组本身的隔离，同时复用深层冻结的事件对象；
- 冷读 fallback 同样改为只复制事件数组外壳；
- `observeSession()` 直接使用传入 events 构建搜索文档；
- fingerprint 不再序列化完整 events，只哈希 header、继承事件数、事件数量，
  以及最后一个事件的 `seq/time/type`。Session 日志是 append-only 且事件
  不可变，因此该尾部指纹仍能在追加事件时可靠失效，同时避免大会话的重复
  全量 JSON 序列化；
- `enqueueLive()` 直接把不可变 Session event 放入持久化缓冲；
- `readSurface()` 对 live Session 直接读取已经验证过的
  `session.surface.nodes`，只复制当前 surface events；冷会话仍保留原来的
  全量校验折叠路径；
- 为 `dsh-session-query-sqlite` 新增持久 pnpm patch；
- 更新已有 `dsh-session-persistence-jsonl` patch；
- 更新 `pnpm-workspace.yaml` 的 `patchedDependencies` 和
  `pnpm-lock.yaml` 的 patch hash。

局部基准（3 万条、每条约 512 字节事件，7 次中位数）：

- 旧路径全量 `structuredClone`：约 `83.24 ms`
- 新路径事件数组浅拷贝：约 `0.17 ms`

验证：

- 三份 patch 均可对原始包 dry-run 应用；
- 三个安装后的包 `node --check` 和 ESM import 均通过；
- `pnpm install --lockfile-only --frozen-lockfile --offline` 通过；
- phase11 全量：`120 tests / 119 pass / 1 skip / 0 fail`。
  其中两个测试在 WSL 下硬编码 `D:/...`，已用临时路径映射单独复跑通过，
  临时映射已删除。

持久化：

- session-query patch：
  `D:/dsh-test/app/patches/@deepseek-ai__dsh-session-query@0.1.7-rc.2.patch`
  SHA256 `A16941FDC98192B79889BC714EEC6D94D7122B54B8ECFF2D1C0D3BBF6E835495`
- session-query 安装文件：
  `D:/dsh-test/app/node_modules/@deepseek-ai/dsh-session-query/lib/index.js`
  SHA256 `5D8D98943EFE0C9F9DE969E5B248D426B27D999E730F7E74C291838029EF6354`
- session-query-sqlite patch：
  `D:/dsh-test/app/patches/@deepseek-ai__dsh-session-query-sqlite@0.1.7-rc.2.patch`
  SHA256 `B6032AE39939389339F363B8431DC1DAF846E25D3702A225AC973F2B28AC6729`
- session-query-sqlite 安装文件：
  `D:/dsh-test/app/node_modules/@deepseek-ai/dsh-session-query-sqlite/lib/index.js`
  SHA256 `ACB0CED8BF9ED68A8C7DA720C9751674B9020C9B660DE09435636357109B7737`
- persistence-jsonl patch：
  `D:/dsh-test/app/patches/@deepseek-ai__dsh-session-persistence-jsonl@0.1.7-rc.2.patch`
  SHA256 `EAA99BEBB1BC18A7CFFB24566000F938D066D96BC3764EB900397A7C06D6D54B`
- persistence-jsonl 安装文件：
  `D:/dsh-test/app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js`
  SHA256 `8D2C705D0254232C1FCF8E60704E3A6502D51B7F888CA1EC0DF77D68E5C7C474`

备份：

- `D:/dsh-test/backups/perf-20260927-session-snapshot-0615/`
  （两个原始安装文件、原 session-query patch、lockfile 和 workspace 文件）。
- `D:/dsh-test/backups/perf-20260927-live-buffer-0625/`
  （原始 persistence-jsonl 安装文件与 patch、lockfile 和 workspace 文件）。

边界：

- 当前 PID `45532` 未重启；核心 session-query / SQLite /
  persistence-jsonl 包不会通过插件 HMR 更新，本轮改动会在下一次受控启动
  时进入运行态。
- 当前进程内仍使用旧的 deep-clone 实现；本次没有停止或重启 DSH，也没有
  清理 sessions、cache、spill 或 team-control-plane 数据。

## 第二十一轮：当前进程的 Session 列表运行态缓存桥接（2026-09-27）

第二十轮的核心包补丁解决了下一次启动后的查询、索引和持久化缓冲重复
物化，但当前 PID `45532` 仍加载旧核心模块。真实浏览器资源时序显示：

- 首次页面导航：`responseEnd 4.75s`、`DOMContentLoaded 4.92s`、
  `load 5.33s`；
- `/api/session/list`：`9.085s`，直到约 `14.56s` 才返回；
- 首次有意义绘制约 `14.8s`。

这说明“会话列表加载慢”在当前进程里主要是列表 RPC 冷扫描，而不是前端
资源下载。为避免等待重启，`team-runtime-guard.mjs` 增加了一个可热加载的
读穿缓存桥接：

1. 在 `ctx.sessionQuery.listSessions` 前增加内存缓存；
2. 首次读取后写入 `D:/dsh-test/home/session-list-cache.json`，进程重启后
   可先返回磁盘快照；
3. 读取命中时立即返回，缓存标脏后只在真实读取时安排后台刷新，不因
   `session/flush` 持续触发全量扫描；
4. `session/created`、`session/disposed`、`session/end-seed`、
   `session/title`、`user/message` 会标记缓存失效；
5. HMR dispose 会恢复原 `listSessions` 方法；并发读取只保留一个底层
   查询，失败时若已有快照则回退到旧快照。

运行态实测：

- HMR 标记：
  `[team-runtime-guard] HMR session-list-cache loaded 2026-09-27`；
- 缓存文件：`117,539 bytes`，`427` 条 Session 摘要；
- 第二次真实页面加载：导航 `load 200.6ms`，
  `/api/session/list` `66.7ms`；
- 独立复测：导航 `load 249.1ms`，
  `/api/session/list` `65.2ms`；
- 同源 RPC 校验：HTTP `200`、`427` 条、约 `29.1ms`。

回归：

- 新增 `phase11-tests/session-list-cache.test.mjs`：2 pass；
- phase11 全量：`122 tests / 121 pass / 0 fail / 1 skip`。

持久化：

- Web/headless/desktop 三份
  `D:/dsh-test/home/profiles/*/plugins/team-runtime-guard.mjs` 字节一致，
  SHA256：
  `A1DD3F6C04CD4A743268D1538F6302ED61313CDED98A6234A347A68EBAC33E17`。
- 备份：
  `D:/dsh-test/backups/perf-20260927-session-list-bridge-manual/`
  （三份修改前文件）。

边界：

- 该桥接已进入当前 Web PID，HMR 标记和真实 `/api/session/list` 均已验证；
- 核心 `session-query`、SQLite 和 persistence-jsonl 补丁仍会在下一次受控
  启动时进入运行态；
- 本次没有停止或重启 DSH，也没有清理 sessions、cache、spill 或
  team-control-plane 数据。

## 第二十二轮：Cold GC 可达性纠正与延迟分位数审计（2026-09-27）

### 控制面消息延迟

新增只读审计脚本：

`D:/dsh-test/phase11-tests/control-plane-latency-report.mjs`

扫描 90 个 audit 文件、39,388 个事件，得到：

- `claimed -> delivered`：p50 `179 ms`、p90 `14.293 s`、
  p95 `45.587 s`、p99 `488.611 s`、max `2,068,070 ms`；
- `claimed -> turn-started`：p50 `917 ms`、p90 `75.794 s`、
  p95 `267.339 s`、p99 `1,387.237 s`、max `1,805,259 ms`；
- `delivery-failed`：36 次，p50 `222 ms`。

结论：

- 普通消息投递本身通常很快；
- 长尾主要来自目标正忙、cold resume、continuation 和 room-close 恢复；
- `turn-started` 不能代表发送完成，不能把目标稍后开始处理误报为发送卡死；
- 当前最大投递延迟样本是 continuation，约 34 分钟；最大 room-close
  样本约 22 分钟。

### 当前进程真实 UI/RPC

测试 Edge profile：`D:/dsh-test/edgeprofile`。

- 页面导航 `load`：约 `679.6 ms`；
- `session/list` 初始资源：约 `362.5 ms`；
- 连续 5 次同源 RPC：`25.2 / 23.9 / 28.7 / 20.8 / 22.5 ms`；
- 大会话切换：`98 ms`、`159 ms`。

此前 9 秒级的 session-list 冷扫描在当前 PID 中已消失。

### Cold GC 根因

`collectReachableColdDigests()` 原先把 audit JSONL 中出现过的 digest 也
当作存活引用。audit 是诊断历史，不是状态根，因此一个 orphan 的 audit
记录会永久把它保活，cold 存储实际变成 append-only。

修复：

- 默认可达性只读取当前快照和恢复快照，不再读取 audit；
- `includeAudit:true` 仅保留给显式诊断；
- `gcControlPlaneStorage()` 增加 `allowDelete`；
- 自动 GC 改为 `allowDelete:false`，只统计和报告可回收项，不删除用户数据；
- 显式 `cp.gc()` 仍可执行真实清理；
- dry-run 返回 `reclaimableColdFiles`、`reclaimableColdBytes` 和
  `deletionSuppressed`；
- 没有自动删除任何 cold、audit、session、cache 或 spill 数据。

当前大 Team 状态：

- 主文件 `27,392,536 bytes`；
- 24,309 个 cold 文件，`65,332,276 bytes`；
- audit 2 个文件，`155,357,917 bytes`；
- cold 全部可达，当前 reclaimable / orphan 均为 0；
- 健康扫描约 `870 ms`。

### 进程资源采样

对 PID `45532` 连续采样 6 分钟：

- Working Set：`6.577 GB` 到 `6.614 GB`；
- Private Memory：`7.665 GB` 到 `7.701 GB`；
- CPU：`6,841.16 s` 到 `6,960.86 s`，约 `0.36` 核。

内存没有持续增长，CPU 也没有进入单核饱和；当前高内存更像大会话加载后的
缓存驻留，而不是本轮修复引入的持续泄漏。

临时取消测试会话：

`D:/dsh-test/home/sessions/--D-dsh-test-workspaces-test--/session-a35ba03e-0346-41d4-8557-a0f38e23713a`

只有 1 个 `session.v4.jsonl.zstd`，`72,426 bytes`，没有加载巨型历史。
未删除该临时会话。

### 验证

- `node --check`：web/headless/desktop 三份 control-plane 通过；
- `v14-storage.test.mjs`：14 pass、0 fail、1 skip；
- `session-list-cache.test.mjs`：2 pass、0 fail；
- phase11 全量：`122 tests / 121 pass / 0 fail / 1 skip`；
- 三份 `team-control-plane.mjs` 字节一致，SHA256：
  `55F8B23A4254031B44D1B507058D61EB03A0285A3A4C324389EE4433C5DAF788`。

修改前备份：

`D:/dsh-test/backups/perf-20260927-cold-gc-reachability-20260927-063744/`

边界：

- 当前 PID `45532` 未重启、未停止；
- 本轮没有清理 cold、audit、session、cache 或 spill；
- cold 扫描仍会 stat 约 2.4 万个文件，约 0.9 秒；后续如需继续优化，
  应优先做无损 manifest / 增量索引，而不是直接删除历史。

## 第二十三轮：存储清单缓存与当前进程热加载验证（2026-09-27）

### 实现

`team-control-plane.mjs` 增加两层进程内缓存：

- `storagePathCache`：按控制面目录缓存文件路径清单，避免每次 health/GC
  都重新执行 `readdirSync`；
- `storageInventoryCache`：缓存 cold 文件路径、文件元数据和从文件名解析的
  digest；
- 两层缓存均以目录 `mtime/ctime` 作为失效依据；
- 显式创建或删除 cold/temp/audit 文件时会调用
  `invalidateStorageInventory()`；
- `resetControlPlaneCache()` 会清空两层缓存，不改变持久状态；
- 不缓存 hot 状态内容、audit 内容或 cold 正文，避免引入跨版本状态陈旧。

新增回归用例覆盖：

- cold 文件新增后清单立即增加；
- cold 文件删除后清单立即减少；
- 现有 audit 文件增长后 `auditBytes` 立即刷新。

### 当前大会话实测

对当前真实控制面文件：

`D:/dsh-test/home/team-control-plane/session-7a601594-66f6-4255-92ba-1ef6813cbf1a.json`

连续调用 `controlPlaneStorageHealth()`：

- 独立进程首次：`556.985 ms`（包含模块加载与首次目录扫描）；
- 热态：`183.775 / 207.422 / 185.101 / 197.615 ms`；
- 对照第二十二轮同一规模扫描：约 `870-915 ms`；
- 热态降幅约 `77%-80%`。

状态核验：

- cold 文件：`24,309`；
- cold 字节：`65,332,276`；
- audit 字节：`155,358,129`；
- orphan / reclaimable：`0`；
- `reachabilityError: null`。

### 运行态与 UI 验证

当前 DSH PID 仍为 `45532`，未重启。

`D:/dsh-test/logs/dsh-test.log` 已出现：

`[team-control-plane] HMR storage-gc-authoritative+perf23 loaded 2026-09-27`

说明热加载已进入当前运行进程。测试 Edge profile
`D:/dsh-test/edgeprofile` 的真实页面重载：

- `DOMContentLoaded`：`90 ms`；
- 页面 `load`：`412 ms`；
- `/api/session/list`：`57 ms`，请求详情记录 `58 ms`；
- 当前页面资源数：`36`。

### 进程资源采样

对 PID `45532` 每 10 秒采样一次，共 6 次：

- Working Set：`6,692.5 MB` 到 `6,852.2 MB`；
- Private Memory：`7,801.4 MB` 到 `7,962.1 MB`；
- CPU 累计秒：`7,278.95` 到 `7,284.55`；
- 采样窗口内无单调增长，内存有正常上下波动，CPU 大部分时间接近空闲。

### 验证

- `node --check`：web/headless/desktop 三份控制面通过；
- `v14-storage.test.mjs`：`16 tests / 15 pass / 1 skip / 0 fail`；
- phase11 全量：`123 tests / 122 pass / 1 skip / 0 fail`；
- 三份 `team-control-plane.mjs` 字节一致，SHA256：
  `E53A8E3FCB1A9021680D64175B65950498A92E56B9E3BD1C648434D41708982A`。

修改前备份：

`D:/dsh-test/backups/perf-20260927-storage-inventory-cache-20260927-0715/`

边界：

- 本轮未停止或重启 DSH；
- 未删除 sessions、cold、audit、cache、spill 或 team-control-plane 数据；
- 自动 GC 仍只统计可回收项，不执行删除；
- 临时取消测试会话
  `D:/dsh-test/home/sessions/--D-dsh-test-workspaces-test--/session-a35ba03e-0346-41d4-8557-a0f38e23713a`
  仍保留，未清理。

## 第二十四轮：Cold 可达性扫描缓存（2026-09-27）

### 根因

第二十三轮消除了 2.4 万个 cold 文件的重复 `readdir/stat`，但
`controlPlaneStorageHealth()` 仍会在每次调用时读取并正则扫描 27 MB 主状态
文件，用于收集可达 cold digest。热态扫描仍为约 `184-207 ms`。

### 修复

新增 `reachableColdCache`：

- 对当前状态和恢复快照生成由路径、`dev/ino/size/mtimeNs/ctimeNs` 组成的
  签名；
- 签名未变化时直接复用可达 digest `Set`；
- 主状态或恢复快照任一变化时自动失效；
- `includeAudit` 使用独立缓存键，避免诊断扫描污染正常扫描；
- `resetControlPlaneCache()` 会清空该缓存；
- 不缓存 cold 正文，不改变 cold 引用语义。

新增回归：

- 恢复快照新增 digest 后，orphan 立即变为可达；
- 恢复快照移除 digest 后，缓存立即失效并重新报告 orphan；
- 保持 `cold GC`、迁移、重开和并发更新回归通过。

### 实测

同一 27 MB 主状态文件连续扫描 7 次：

- 首次：`571.796 ms`（包含独立进程模块加载和首次全量扫描）；
- 热态：`20.207 / 24.004 / 27.694 / 29.074 / 32.125 / 26.655 ms`；
- 第二十三轮热态对照：`183.775-207.422 ms`；
- 热态进一步降低约 `84%-90%`。

### 验证

- `node --check`：web/headless/desktop 三份控制面通过；
- `v14-storage.test.mjs`：`17 tests / 16 pass / 1 skip / 0 fail`；
- phase11 全量：`124 tests / 123 pass / 1 skip / 0 fail`；
- HMR 日志确认：
  `[team-control-plane] HMR storage-gc-authoritative+perf24 loaded 2026-09-27`；
- 三份 `team-control-plane.mjs` 字节一致，SHA256：
  `4FF5D7C470EBBC895AB477B7B5AD9F3D0AFEA0DBD3B31E274714FCC5BB78FCF5`。

本轮快照备份：

`D:/dsh-test/backups/perf-20260927-reachability-cache-20260927-071555/`

边界：

- 本轮仍未重启、未停止 DSH；
- 未删除或清理 sessions、cold、audit、cache、spill、team-control-plane 数据；
- 本轮缓存只减少重复只读扫描，不改变 GC 的显式删除授权。

## 第二十五轮：存储路径分类缓存（2026-09-27）

### 根因

第二十四轮后，健康扫描仍约 `20-32 ms`。剩余热点是
`controlPlaneFiles()` 每次都对 2.5 万条目录路径重新执行 cold/temp/audit/root
谓词过滤，即使目录没有变化。

### 修复

将 `storagePathCache` 扩展为“目录快照 + 分类结果”：

- 目录签名变化时一次性重建完整路径列表和空分类表；
- 按 `cold`、`temp`、`audit`、`roots-live`、`roots-audit` 分类；
- 首次访问某类时只过滤一次，后续直接复用该分类数组；
- `invalidateStorageInventory()` 仍删除整个目录缓存；
- 分类只缓存路径，不缓存 stat、cold 内容或 hot 状态；
- 保持 audit 仅作为显式 `includeAudit` 诊断根，不改变可达性语义。

### 实测

同一 27 MB 主状态文件连续扫描 9 次：

- 首次：`554.877 ms`（包含独立进程模块加载和首次全量扫描）；
- 热态：`7.117 / 6.777 / 13.623 / 8.566 / 9.391 / 7.419 / 5.332 / 5.179 ms`；
- 第二十四轮热态对照：`20.207-32.125 ms`；
- 热态进一步降低约 `60%-84%`。

### 验证

- `node --check`：web/headless/desktop 三份控制面通过；
- `v14-storage.test.mjs`：`17 tests / 16 pass / 1 skip / 0 fail`；
- phase11 全量：`124 tests / 123 pass / 1 skip / 0 fail`；
- 测试浏览器再次重载：`DOMContentLoaded 65 ms`、页面 `load 267 ms`、
  `/api/session/list 58 ms`；
- 控制面投递审计仍显示普通投递中位数 `179 ms`、turn 启动中位数 `917 ms`；
  长尾来自目标正在执行、cold resume 和 room-close 恢复，不是本轮扫描缓存回归；
- HMR 日志确认：
  `[team-control-plane] HMR storage-gc-authoritative+perf25 loaded 2026-09-27`；
- 三份 `team-control-plane.mjs` 字节一致，SHA256：
  `8C412F9FCAD9DF873D1AC9A9FDC5885793603B670F784945C78C34432DB9AF56`。

本轮快照备份：

`D:/dsh-test/backups/perf-20260927-storage-path-categories-20260927-071833/`

边界：

- 未重启、未停止、未清理任何 DSH 数据；
- 仍保留显式 `cp.gc()` 删除授权，自动 GC 不删除；
- 首次进程内扫描仍需构建完整目录快照，后续热路径已消除重复过滤。

## 第二十六轮：Hydrated History 快照缓存与只读边界（2026-09-27）

### 根因

`controlPlane.snapshot({ history: true })` 每次都会重新解析主状态文件、读取并
hydrate 全部 cold Room/wake 历史，再生成完整快照。当前大会话主状态约 `27 MB`、
`52` 个 Room，单次完整快照约 `3.3 s`；频繁查看历史或恢复 Room 时会重复支付
这部分成本。

同时，历史快照缓存不能直接暴露给 `clone:false` 调用。内部 mutation 若拿到共享
状态并原地修改，会污染后续只读快照，因此缓存必须只服务于 `clone:true` 的调用。

### 修复

- 增加有界的 `historyCache`，按文件签名缓存已 hydrate 的完整历史快照；
- 文件签名使用纳秒级 `mtimeNs/ctimeNs`，避免 Windows 毫秒时间戳在同一秒内
  连续写入时漏失效；
- 写入、文件签名变化或显式重置缓存时删除对应历史缓存；
- 只有 `history:true && clone:true` 读取和写入缓存；
- `history:true && clone:false` 始终绕过缓存并重新加载，防止内部 mutation
  修改共享缓存对象；
- 增加回归用例验证 Room mutation 后失效，以及 `copy:false` 不能污染后续
  `copy:true` 快照。

### 实测

同一 `session-7a601594-66f6-4255-92ba-1ef6813cbf1a` 完整历史快照连续 6 次：

- 首次：`3310.370 ms`（包含解析、全部 cold hydrate 与快照克隆）；
- 缓存热态：`137.215 / 161.827 / 133.696 / 135.186 / 141.645 ms`；
- hot `view({ history:false })`：首次 `97.633 ms`，后续
  `0.106 / 0.019 / 0.011 / 0.009 ms`。

### 验证

- `node --check`：web/headless/desktop 三份控制面通过；
- `v14-storage.test.mjs`：`19 tests / 18 pass / 1 skip / 0 fail`；
- audit 快速写入循环：连续 `100` 次 mutation 后每次 `auditBytes` 均严格增长，
  最终 `12,875 bytes`；
- phase11 全量：`126 tests / 125 pass / 1 skip / 0 fail`；
- 浏览器真实页面重载：`DOMContentLoaded 61 ms`、`load 410 ms`、
  `/api/session/list 54 ms`，页面完整显示；
- HMR 日志确认：
  `[team-control-plane] HMR storage-gc-authoritative+perf26 loaded 2026-09-27`；
- 三份 `team-control-plane.mjs` 字节一致，SHA256：
  `12643B30F219DACD3E0FED531496E0A4E47E82A80DE4ED09CFD385FACDA8DD0F`。

本轮快照备份：

`D:/dsh-test/backups/perf-20260927-history-cache-20260927-073157/`

边界：

- 未重启、未停止、未清理任何 DSH 数据；
- 完整历史首次 hydrate 仍需约 `3.3 s`，本轮只消除重复 hydrate；
- 缓存只保存当前进程内的一份完整历史快照，不改变 cold 文件格式或持久化语义。

## 第二十七轮：Requirements 冷引用与主快照瘦身（2026-09-27）

### 根因

主控制面状态 `27,392,536 bytes` 中，`v12Requirements` 单独占
`11,155,040 bytes`。该 ledger 是版本化需求/决定审计数据，Room append
和大多数 Team mutation 不会改变它，但旧写路径仍会在每个热 checkpoint
里重复 `JSON.stringify`、写临时文件并 rename 整份状态。

### 修复

- 增加 `v12RequirementsRef` 内容寻址引用；
- 主快照只保留 `{ version, digest }`，ledger 正文写入 cold 文件；
- `readControlPlaneSnapshot()` 与普通 `load()` 在读取时透明 hydrate，
  调用方仍拿到原来的 `state.v12Requirements` 对象；
- 写入时先比较 digest；ledger 未变化就复用旧 cold 引用，不重写正文；
- `rememberPublishedHotState()` 在进程内缓存完整 ledger，避免 HMR/热读
  因主快照引用化而丢失内存态；
- 引用 digest 会进入既有 reachability 扫描，cold GC 不会误删当前 ledger。

### 实测

以真实大会话主状态临时副本写入：

- 修复前主文件：`27,392,536 bytes`；
- 首次写入后：`16,237,559 bytes`，减少 `11,154,977 bytes`；
- 首次写入（含 requirements cold blob）：`252.065 ms`；
- 第二次普通 mutation：`87.824 ms`；
- 第二次写入的 `last` 指标：
  `prepare 23.381 ms / serialize 28.503 ms / write 24.582 ms /
  rename 1.446 ms / total 77.996 ms`；
- 第二次 mutation 后主文件大小保持不变，说明未重复写入 requirements 正文。

### 验证

- `node --check`：web/headless/desktop 三份控制面通过；
- `v14-storage.test.mjs`：`20 tests / 19 pass / 1 skip / 0 fail`；
- 新增回归验证主文件不含 inline requirements、cold blob 存在且 cache reset
  后可透明重载；
- phase11 全量：`127 tests / 126 pass / 1 skip / 0 fail`；
- 浏览器真实页面重载：`DOMContentLoaded 91 ms`、`load 628 ms`、
  `/api/session/list 43 ms`，页面完整显示；
- HMR 日志确认：
  `[team-control-plane] HMR storage-gc-authoritative+perf27 loaded 2026-09-27`；
- 三份 `team-control-plane.mjs` 字节一致，SHA256：
  `58022D93CD7F4D8F3629A8158BA726DDBA82C207566A2C0C333D91A04278966C`。

本轮快照备份：

`D:/dsh-test/backups/perf-20260927-requirements-cold-ref-20260927-074030/`

边界：

- 当前 PID `45532` 未重启、未停止、未清理 DSH 数据；
- 首次写入仍需要生成 requirements cold blob；后续热 mutation 只写约
  `16.2 MB` 主快照；
- 本轮不改变 ledger 语义、活跃 requirements 数量或上下文注入内容。

## 第二十八轮：Requirements Digest 缓存与存储清单 TTL（2026-09-27）

### 根因

第二十七轮已经避免重复写 requirements cold blob，但每次 checkpoint 仍会为了
判断 ledger 是否变化而重新序列化约 `11 MB` 的 `v12Requirements`，导致
`prepareMs` 长期占在 `23 ms` 左右。

存储路径/库存缓存原先只比较 Windows 目录的 `mtime/ctime`。Windows 在同一
时间粒度内的外部新增或删除文件可能不改变目录签名，使清单继续返回旧结果。
控制面自身写入仍会显式失效缓存，但外部维护和回归测试需要有限度的刷新上限。

### 修复

- 增加 `requirementsDigestCache`，按 ledger 对象和 revision 复用 SHA256；
- ledger 未变化时，后续 checkpoint 不再重复序列化整个 requirements 正文；
- `storagePathCache` 与 `storageInventoryCache` 增加 `500 ms` 刷新上限；
- 控制面写入、轮转和显式失效仍立即清除缓存，不等待 TTL；
- `v14-storage.test.mjs` 的外部目录变更用例等待一个 TTL 窗口后再断言，
  覆盖 Windows 同粒度时间戳场景。

### 实测

以真实大会话
`session-7a601594-66f6-4255-92ba-1ef6813cbf1a.json` 的临时副本执行
requirements 冷引用与连续 mutation：

- 原始主文件：`27,392,536 bytes`；
- 冷引用化后：`16,237,588 bytes`；
- 首轮 mutation：`188.096 ms`，`prepare 26.212 ms / total 81.692 ms`；
- 第二轮 mutation：`67.494 ms`，`prepare 0.996 ms / total 56.726 ms`；
- 第三轮 mutation：`67.206 ms`，`prepare 0.951 ms / total 55.797 ms`；
- 主快照保持 `16,237,548 bytes`，requirements cold blob 数量保持 `1`。

### 验证

- `node --check`：web/headless/desktop 三份控制面通过；
- `v14-storage.test.mjs`：`20 tests / 19 pass / 1 skip / 0 fail`；
- phase11 全量：`127 tests / 126 pass / 1 skip / 0 fail`；
- 浏览器真实页面加载：`DOMContentLoaded 307 ms`、`load 664 ms`、
  `/api/session/list 57 ms`，侧栏、会话列表和输入区完整显示；
- HMR 日志确认：
  `[team-control-plane] HMR storage-gc-authoritative+perf28 loaded 2026-09-27`；
- 三份 `team-control-plane.mjs` 字节一致，SHA256：
  `FB2EBE694F7F56DEF898889970F747DBAA66399BCA31D67A8226D9602A12DA15`。

本轮快照备份：

`D:/dsh-test/backups/perf-20260927-storage-cache-ttl-perf28-20260927-075241/`

边界：

- 当前 PID `45532` 未重启、未停止、未清理 DSH 数据；
- 外部直接修改存储目录的可见性最多延迟 `500 ms`；控制面自身写入不受此延迟；
- digest 缓存按 ledger 对象和 revision 生效，不改变 requirements 内容、
  cold GC reachability 或会话兼容性。

## 第二十九轮：存储成员代际缓存（2026-09-27）

### 根因

第二十八轮的 `500 ms` TTL 虽然修复了 Windows 同粒度目录时间戳漏检，但让
`storageInventoryFor()` 每 500ms 对全部 cold 文件重新执行 `statSync`。当前
大会话约有 2.4 万个 cold 文件，这会把重复健康扫描重新拖到数百毫秒。

同时，路径缓存每轮 TTL 都会重新 `join()` 2.4 万条完整路径，即使目录成员
完全没变，仍产生大量临时字符串和数组分配。

### 修复

- 路径缓存增加 `generation`，只在目录成员集合变化时递增；
- TTL 到期后只读取并比较文件名列表，不再无条件构造完整路径；
- 成员未变时保留已有分类数组，仅刷新目录签名和 `checkedAt`；
- cold 库存缓存按路径代际复用；成员未变时不再重复 `stat` 全部 cold 文件；
- 控制面自身新增 cold 文件时立即递增代际，外部变化仍在 TTL 后可见；
- 目录消失时同步清除路径和库存缓存，避免旧代际误复用。

### 实测

隔离目录基准：

- `5,000` 个 cold 文件：
  - 修复前热态：约 `69 ms`；
  - 修复后热态：约 `7 ms`；
  - 降低约 `90%`；
- `24,000` 个 cold 文件：
  - 首次扫描：`269.7 ms`；
  - 后续热态：`29.1 / 28.4 ms`；
- 成员新增、删除与 audit 大小变化回归均保持正确。

### 验证

- `node --check`：web/headless/desktop 三份控制面通过；
- `v14-storage.test.mjs`：`20 tests / 19 pass / 1 skip / 0 fail`；
- phase11 全量：`127 tests / 126 pass / 1 skip / 0 fail`；
- 浏览器真实页面加载：`DOMContentLoaded 78 ms`、`load 569 ms`、
  `/api/session/list 54 ms`，页面完整显示；
- HMR 日志确认：
  `[team-control-plane] HMR storage-gc-authoritative+perf29 loaded 2026-09-27`；
- 三份 `team-control-plane.mjs` 字节一致，SHA256：
  `4E9D3419A2018B9862D22CDEFA93C74BE2F8B94CE3B6F182E87A811338454291`。

本轮快照备份：

`D:/dsh-test/backups/perf-20260927-storage-membership-generation-perf29-20260927-080237/`

边界：

- 当前 PID `45532` 未重启、未停止、未清理 DSH 数据；
- 外部直接修改目录成员最多延迟 `500 ms` 可见；控制面自身写入立即更新；
- cold 文件按内容寻址且视为不可变；覆盖同一 cold 路径不属于支持语义。

## 第三十轮：完成回执后置执行（2026-09-27）

### 根因

`team-v14-event-continuation.mjs` 的 `tools/post-execute` 钩子会在
`team_task_update(action:"complete")` 后同步等待：

- `reportCompletion()` 完成 summary 持久化；
- `teams.sendMessage()` 完成慢邮箱投递；
- `schedule()` 完成 continuation 扫描。

当目标成员冷恢复、邮箱慢或 continuation I/O 排队时，这些工作会拖住
`complete` 工具本身的返回。调用方看到的不是业务失败，而是工具长时间无响应，
进而放大 Team 通信延迟。

### 修复

- 增加 `settlePostExecute()` 有界后置执行；
- 工具结果先放行，快速本地操作仍可在当前事件循环窗口内完成；
- 一旦操作在首个异步让出点后仍未完成，就让其继续在后台执行；
- 后台异常仍通过原有 warning 路径记录，不产生未处理 Promise rejection；
- 新增慢邮箱回归：`sendMessage` 被门闩阻塞时，`post-execute` 必须提前返回，
  放行后 summary 仍必须最终进入 `delivered`。

### 实测

- 慢邮箱回归测试中，投递被阻塞 `250 ms`，`post-execute` 在 `<150 ms`
  内返回；随后后台发送继续完成；
- 聚焦测试：`v14-continuation.test.mjs` `16 tests / 16 pass / 0 fail`；
- phase11 全量：`128 tests / 127 pass / 1 skip / 0 fail`；
- 真实浏览器页面加载：`DOMContentLoaded 60 ms`、`load 403 ms`、
  `/api/session/list 56 ms`，页面、侧栏和会话内容完整显示。

### 验证

- `node --check`：web/headless/desktop 三份 continuation 通过；
- HMR 日志确认运行进程已重新加载 continuation：
  `[team-v14-event-continuation] startup-arming active`；
- 三份 `team-v14-event-continuation.mjs` 字节一致，SHA256：
  `51940F8FAC9C3F99195339FDA1E5FCCB20B4E8181EB0B75B77ADD617D6299819`；
- 回归测试 SHA256：
  `E073947CCC90A8039141914B77654C5D8FAC4249979EB883F7D97B3748D6290F`；
- 当前 DSH PID 仍为 `45532`，未重启。

本轮快照备份：

`D:/dsh-test/backups/perf-20260927-continuation-post-execute-20260927-081027/`

边界：

- 未重启、未停止、未清理 DSH 数据；
- 工具返回不再承诺后台 completion summary 已经投递完成；durable
  `sending/delivered/delivery-failed` 状态仍按原状态机收敛；
- `dispose()` 后已在后台运行的操作仍会尝试收敛，异常只记 warning，
  不重新挂起工具调用。

## 第三十一轮：唤醒 pending 状态去重（2026-09-27）

### 根因

`team-tools-v2-r10.mjs` 的 `deliverWake()` 已经会在以下路径更新同一
`dispatch.pendingMessages` 行：

- 直接 steer 成功；
- 邮箱投递成功；
- 邮箱投递失败；
- 后台超时后最终收敛。

但 `send_message(delivery:"action"/"decision")`、`team_wake`、
`team_wake_superior`、acceptance verifier 唤醒和 Room 轮次唤醒，在
`deliverWake()` 返回后又调用了一次 `markWakePendingMessage()`。每次调用
都会走一次 `wake/message-status` 控制面 mutation，重复 append audit，并
触发 16 MB 级主快照的 checkpoint。

### 修复

- 删除 5 处调用方重复状态写；
- 保留 `deliverWake()` 内部唯一的终态状态机；
- 调用方返回时 pending 行仍由 `wakeClaim()` 初始化为 `queued`；
- 新增审计回归：调用方返回时同一消息的 `wake/message-status` 必须为 0，
  后台完成后必须恰好为 1。

### 实测

- 慢邮箱测试的调用方返回时间：`51 ms`；
- 调用方返回时重复状态写：`0`；
- 后台投递完成后的终态状态写：`1`；
- `v14-bounded-wake.test.mjs`：`checks=all failed=0`；
- phase11 全量：`128 tests / 127 pass / 1 skip / 0 fail`；
- 真实浏览器第一次冷态：`DOMContentLoaded 97 ms`、`load 827 ms`、
  `/api/session/list 2347 ms`；
- 紧接着的同源热态：`DOMContentLoaded 45 ms`、`load 214 ms`、
  `/api/session/list 48 ms`，页面和会话列表完整显示。

### 验证

- `node --check`：web/headless/desktop 三份 `team-tools-v2-r10.mjs`
  通过；
- HMR 日志确认当前 PID 已加载：
  `[team-tools-v2-r10] HMR perf31-wake-status-dedupe loaded 2026-09-27`；
- 三份 `team-tools-v2-r10.mjs` 字节一致，SHA256：
  `102CCB95D60ADC383D875D7C1C10D6EF5B92C19F404D3967C5F7C051C9794E93`；
- 回归测试 SHA256：
  `2A4407DC7415CC00354E59A765C92836BA24EB5A1173C385D62AC153B2B7D23A`；
- 当前 DSH PID 仍为 `45532`，未重启。

本轮快照备份：

`D:/dsh-test/backups/perf-20260927-wake-status-dedupe-20260927-081638/`

边界：

- 未重启、未停止、未清理 DSH 数据；
- 只删除重复状态写，不改变 durable dispatch、pending message、wake
  episode 或投递重试语义；
- 第一次浏览器冷态仍可能等待 session-list 的真实底层刷新；第二轮热态
  由现有磁盘/内存缓存桥接返回。

## 第三十二轮：已有 Room 复用（2026-09-27）

### 根因

`team-tools-v2-r10.mjs` 的 `ensureRoom()` 在每次 `send_message` 和
`team_wake` 路径都会先检查 Room，但只要调用方带上了
`dependsOnRooms`，就会无条件再次调用 `cp.roomOpen()`；同时每个成员都
无条件尝试 `cp.roomJoin()`，即使 Room 和成员已经存在。热路径因此持续产生
重复 mutation、audit 行、revision 变更和 16 MB 级快照 checkpoint 调度。

### 修复

- 已有 Room 且 host 完整时，仅在该次调用确实存在以下变化才调用
  `roomOpen()`：
  - `kind` 与现有 Room 不一致；
  - 请求包含新的 `dependsOnRooms`；
  - 显式要求 `replaceHost`；
  - Room 缺少 host。
- `roomJoin()` 改为只对尚未在 `room.members` 中的成员调用；
- 保留控制面原有拒绝语义：已有 Room 的 kind 不一致仍然报错，不静默复用；
- 相同 `dependsOnRooms` 重复出现时不再递增 revision。

### 实测

- 第 32 轮聚焦回归：`checks=all failed=0`；
- 第二条不同消息复用时：
  - `roomOpenCalls` 保持 `1`；
  - `roomJoinCalls` 保持 `0`；
- 已有 Room 的 kind mismatch 仍被拒绝：
  `room "root" already exists with kind "task"`；
- phase11 全量：`128 tests / 127 pass / 1 skip / 0 fail`；
- 真实 Edge/Playwright：
  - 会话 `根据文档实施计划完成任务` 打开成功；
  - Agent Team 面板打开成功，协作房间页签显示 `12` 个房间；
  - `DOMContentLoaded 85 ms`、`load 569 ms`；
  - 浏览器控制台 `Errors: 0, Warnings: 0`；
  - 截图：`D:/dsh-test/output/perf32-room-panel.png`。

### 验证

- `node --check`：web/headless/desktop 三份
  `team-tools-v2-r10.mjs` 通过；
- HMR 日志确认当前 PID 已加载：
  `[team-tools-v2-r10] HMR perf32-existing-room-reuse loaded 2026-09-27`；
- 三份 `team-tools-v2-r10.mjs` 字节一致，SHA256：
  `D35D1580565D5AF6356F22A27A79D97A2A9A3737200DBD1698FF8F87E474E37B`；
- 回归测试 SHA256：
  `642B8C4AF282BB1EB662CF2903941538A8A0DE95689B3443F004FA6C0CCC9D1C`；
- 当前 DSH PID 仍为 `45532`，未重启。

本轮快照备份：

`D:/dsh-test/backups/perf-20260927-existing-room-reuse-20260927-082435/`

边界：

- 未重启、未停止、未清理 DSH 数据；
- 只复用已存在的 Room 和成员，不改变 Room 访问控制、轮次语义、依赖门禁
  或投递重试状态机；
- 依赖新增时仍走控制面 `roomOpen()`，因此缺失父 Room、父轮次未关闭等
  拒绝仍由原逻辑执行。
