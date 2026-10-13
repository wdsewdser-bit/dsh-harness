# pkg-N native-tests 宿主/运行时类测试 取舍分析（只读）

测试根：`D:\dsh-test\.claude\worktrees\intelligent-hawking-e47cda\staging\context-runtime-unified-20261001`（下称 STAGE）。证据中的 lab-runs 时间戳来自真实 stage `D:\dsh-test\staging\context-runtime-unified-20261001\lab-runs`（worktree 副本没有该目录）。

## 总览
- 26 个文件 / 256 条 / 基线 85.1 s（占全量 270 s 的 31%）；其中 5 个文件（subagent-durable 30.5、instant-history 20.6、ptc-background 10.9、session-plan-delivery 6.9、execution-proof 4.2）占 73.1 s。
- 建议 DELETE：0 条（读过 native 一侧，但 phase11 一侧未读，不满足铁律 2/4）；MERGE：1 条（约 0.1 s）+ 1 个"同宿主合并两场景"的 lab 重构（约 8.4 s，见 instant-history-runtime）。
- 建议进可选 SLOW 组：约 28 条 / 约 74 s（subagent 2 条 30.5、instant-history 2 条 20.6、ptc 全 16 条 10.9 或其中 5 条 4.5、session-plan 11 条 5.3、execution-proof 7 个真实 bash 用例 ≈4.2 含文件加载、team-execution-proof 1 条 0.8、其余 4 条真子进程 ≈1.7）。默认组只剩约 11 s。
- 不改语义即可省的等待：lab 子进程"跑完后 1.4–1.9 s 才退出"×4 次 ≈ 6.5 s；instant-history 两条合并一次宿主冷启动 ≈ 8.4 s；session-plan 4 条 compaction 用例去掉不必要的 `proof('test')` 真实 bash ≈ 1.2 s；strict-plan-scope 5 处 50 ms 睡眠 ≈ 0.2 s。
- 重要环境事实：session-plan-delivery / execution-proof-runtime / team-execution-proof 在 win32 硬编码 `C:/Program Files/Git/bin/bash.exe`；两个 lab 测试依赖预先生成的、未入库的 `lab-host-home`，且共用端口 40124 与 `lab-host-home/team-control-plane`，不可并行；真实 stage 的 `lab-runs` 已累积 549 个目录 / 806 MB（这些测试每次都往里写、从不清理）。

---

## 一、两条"各 10–16 秒"用例到底在等什么（核心问题 1）

两者都**没有 sleep/轮询/定时等待**。时间全是"真实 web profile 宿主冷启动 + 真实 Team/PTC 子进程 + 退出拖尾"。证据：lab-runs 目录里各 json 的创建/修改时间（毫秒）。

### A. subagent-durable-delivery 的 `--offline-rounds`（16.6 s），run `offline-family-durable-3ff34df1…`
| 时刻 | 事件 | 距上一事件 |
|---|---|---|
| 14:55:10.84 | 外层建输出目录（外层 node 已 import 完） | - |
| 11.22 | 内层 child 写 `storage-overlay.json`（即将 `runProfile`） | 0.38 s（含 child node 启动+import） |
| 15.08 | `query.sqlite` 创建（`session-query-sqlite openAt:'startup'`） | 3.9 s（runProfile 加载 web profile 全部插件） |
| 19.15 | 第一次 `family-evidence.json`（root 经 PTC `run_code` 真实生成 lead 完成） | 4.1 s（剩余插件装配 + composeAgent + create root + activate + 第 1 次 spawn_teammate） |
| 20.86–21.03 | 4 个角色的 binding/protocol 文件（又 2 次 spawn_teammate，每次一个真实 PTC node 子进程） | 1.7 s |
| 21.26 → 25.08 | 8 轮 offline 采样（每轮 `subagents.prompt` + `barrier.persist` + `whenIdle`） | 3.6 s，约 0.45 s/轮 |
| 25.19 | `result.json`（child 内逻辑结束） | 0.1 s |
| 27.08 | `host.stdout.log` 被外层写出（= child 进程真正退出） | **1.9 s 空转拖尾** |

`--offline-error`（13.9 s）同构：boot+3 次 spawn ≈ 9.1 s，3 次请求 1.4 s，`result.json` 38.79 → 进程退出 40.96，**拖尾 1.4–1.9 s**（3 个样本 1.89/1.90/1.41 s）。拖尾的持有者我没能定位（未运行，只读）；`team-control-plane.mjs:93` 的 `DEFAULT_MUTATION_DEFER_MS = 1000` 是嫌疑之一，但未证实。

### B. instant-history-runtime（每条 10.3 s）
`tools/instant-history-lab.mjs` 同样走 `runProfile({profile:'web'})`（line 51）→ composeAgent('ptc')（72）→ create agent（73）→ activate identity（81）→ 两次 `bounded(...)`（默认 6 s 超时，仅为上限，不是等待）。没有 sleep（唯一的 `setTimeout 45000` 在 `--ui` 分支 line 102，测试不走）。10.3 s ≈ 冷启动宿主 ~8.3 s + 退出拖尾 ~1.9 s + 场景 <0.2 s（推断，与 A 的时间轴同构，未直接测）。两条用例的唯一差别是 line 94–98 的 `--queue-steer` 分支，断言只多一行 `admissions.filter(promote).length === (queueSteer?1:0)`（`instant-history-runtime.test.mjs:34`）。

### C. 具体可改位置（不改语义）
1. **退出拖尾（约 1.4–1.9 s × 4 个子进程 ≈ 6.5 s）**
   - `tools/team-family-natural-lab.mjs:411`：`main().catch(...)` 之后追加一个 `.then(()=>{ if (process.argv.includes('--child')) process.stdout.write('', () => process.exit(process.exitCode ?? 0)) })`。此时 line 382–385 的所有 `save(...)`（全是 `writeFileSync`）和 `console.log(result)` 已完成，进程里没有需要等待的东西。
   - `tools/instant-history-lab.mjs:121`（最外层 `finally` 之后、非 `--ui`）：追加 `process.stdout.write('', () => process.exit(0))`。证据行 `INSTANT_HISTORY_EVIDENCE=` 在 line 105 已打印；出错路径在 line 114–117 重新抛出，不会走到这一行。
   - 风险：若拖尾是某个 handle 的"优雅关闭"，强退会跳过它；`result.hostDisposed`/`cleanupErrors`（line 359–380）已在此前完成并落盘，所以断言不受影响。建议先用一次性诊断 `process._getActiveHandles()` 在 line 385 之后打印确认持有者再决定。
2. **instant-history 两场景共用一次宿主冷启动（约 8.4 s）**：把 `instant-history-lab.mjs` line 72–103 抽成 `scenario(queueSteer)`，host 只 `runProfile` 一次；`requests`/`started`/`successor`/`finish`（line 17、32）改成 per-scenario；测试里一次 `spawnSync`，输出两段 evidence，两个 `test()` 分别断言各自那段。风险点：第二个 root 会话与第一个共用 `DSH_HOME/team-control-plane`（line 77）与 `teamIdentityRuntime`，需先确认 `controlPlaneForMember` 按 agent 隔离；若不隔离，退而求其次只做第 1 项（省 3.4 s）。
3. **subagent-durable 的两个 lab 用例不能合并宿主**（error 用例以 `agent/error → abort` 收尾，line 226–230），也不能并行（共享 lab-host-home/端口）；只做第 1 项（约 3.4 s），其余整体归 SLOW。
4. **冷启动本身（~8 s/次）**：唯一可砍的是关闭与本场景无关的插件（例如 `storage-overlay` 里 `session-query-sqlite openAt:'startup'`，team-family-natural-lab.mjs:162）。这会改变"actual host"的含义，**我不建议**；列出仅供知悉。
5. 两个测试文件里的 `timeout:45000/35000`（subagent:16,49；instant-history:12）只是上限，缩短不省时间。

---

## 二、逐文件

### native-tests/subagent-durable-delivery.test.mjs  (tests=6, ms=30541)
- 判定: SLOW-TESTS（前 2 条入 slow；后 4 条 6 ms 留默认）
- 被测: Team 子代理跟进消息的持久化屏障（`SubagentInbox` + 真实 Team 宿主 lab：`prepare-unified-lab-host.mjs` → `team-family-natural-lab.mjs --offline-rounds/--offline-error`）。
- 理由/证据: `runFixture`（line 11–24）双层 `spawnSync(node)`，内层 `runProfile('web')` 真宿主，3 次真实 PTC `spawn_teammate`，8/3 次 offline 采样；时间轴见第一节 A。
- 可删用例: 无。
- 可入 slow 的用例: `actual Team follow-up waits for durable acceptance and cold resumes every child for its next identity turn` 16643 ms（真宿主冷启动+8 轮）；`actual Team child transport failure retains terminal evidence and closes without a late writer flush` 13894 ms（真宿主+传输失败收尾，崩溃恢复类契约）。
- 风险: 两条是 durable-ack / 传输失败 / 冷恢复契约，不可删；仅分组。4 条纯内存 `SubagentInbox` 用例（line 57–99）应留默认组（建议拆文件或用环境变量 skip 前 2 条）。

### native-tests/instant-history-runtime.test.mjs  (tests=2, ms=20612)
- 判定: SLOW-FILE（并建议合并两场景）
- 被测: 真实 SessionController `follow` 流 + 直接 steer / 排队提升 steer，重连后保留 native generation 与被取代前驱的终态。
- 理由/证据: 真子进程 + 真 web 宿主（instant-history-lab.mjs:51），每条 10.3 s，无 sleep（第一节 B）。两条断言除 `promote` 计数外完全相同（test.mjs:22–34）。
- 可删用例: 无（不删）；MERGE 方式见第一节 C-2：同一宿主依次跑两种场景，省约 8.4 s。
- 可入 slow 的用例: 两条均入：`actual SessionController direct steer reconnect…` 10367 ms；`actual SessionController queued-input promotion reconnect…` 10245 ms（真宿主冷启动 + 退出拖尾）。
- 风险: 这是同主题里唯一走真实 `SessionController.follow/updateQueue` 的集成用例；in-process 侧由 instant-stream-accumulator / instant-web-presentation / instant-follow-codec / native-bridge 覆盖 generation 语义，但**不覆盖** SessionController 这一层，故不判 DELETE。S0 标记无。

### native-tests/ptc-background-runtime.test.mjs  (tests=16, ms=10929)
- 判定: SLOW-TESTS（建议整文件放 slow，或至少把标 ★ 的 5 条放 slow）
- 被测: `team-v15-ptc-background.mjs` 的 `PtcBackground`：脱离 PTC 实例的后台结果收集、通知恢复、崩溃后 unknown 效果、伪造收据回放拒绝。
- 理由/证据: 每条用例都用真实 `NodePtcRuntime`（fixture 里 `runtime.run`，line 69–72）起真实 node 子进程，且两次（原程序 + 收据收集程序）；`graceMs:100`/`pumpPollMs:10` 已是最小，每条 ≈0.4–0.8 s 为进程冷启动，无可缩的 sleep。两条崩溃用例（line 420–452）再 `spawn` 一个重跑本文件的 `node --test` 子进程并 `kill()`（`setInterval(…,60000)` 是被杀的占位，不是实际等待）。
- 可删用例: 无。
- 可入 slow 的用例: ★`real process death during a started tool recovers unknown effects…` 1431 ms；★`real process death after artifact fsync but before terminal receipt…` 1135 ms（spawn 子进程并杀死）；★`structured timeout is not misreported…` 635 ms（真实超时+kill）；★`structured output-limit is not misreported…` 626 ms；★`large output remains intact in its durable artifact…` 681 ms（128 KB 产物）。其余 11 条各 0.36–0.79 s，同样真起 PTC 子进程，但是本文件核心契约，建议保留默认或整体 slow 由主线决定。
- 风险: 崩溃恢复/CAS/授权边界契约，全部 KEEP。被测模块 `team-v15-ptc-background.mjs` 在 `plugin-change-manifest.json:297` 为 `before:null`（新增），且 `home/profiles/web/cordis.patch.yml` 与 stage 内任何插件都未引用它——属于待部署的在建功能，**不能**据"未加载"删除。

### native-tests/session-plan-delivery.test.mjs  (tests=22, ms=6918)
- 判定: SLOW-TESTS（11 条）+ KEEP+TRIM（4 条 compaction 用例去 `proof('test')`）
- 被测: `session-plan-delivery.mjs` 非 Team 会话的计划交付闸门：严格策略、真实 shell 证明、UI remote、compaction 债务、被拒提交的 unknown-effect 分类。
- 理由/证据: `f.proof('test')` 走真实 `FixtureBash`（line 83–85，win32 写死 Git bash）+ node oracle.cjs 子进程，每次 ≈0.25–0.4 s；其余用例 67–185 ms 纯内存。`bigPlan`（line 275–289）只做 implementation 证明、不起子进程。
- 可删用例: 无。
- 可入 slow 的用例（每条含 1–2 个真实 bash+node）: `strict policy retains the existing receipt-backed accepted and stale-source paths` 541；`ordinary non-Team plan uses actual shell proofs…` 493；`ordinary plan without goal cannot turn partial evidence…` 517；`compacted summary that lost the plan identity…` 426；`explicit compaction_anchor repairs the debt…` 534；`a later complete summary clears the compaction debt…` 436；`a complete summary or no compaction at all…` 462；`a premature commit that the gate refused…` 480；`repeated refused commits stay recoverable…` 561；`refused commits never clear another tool's unknown effect` 450；`a session_delivery failure after the write began…` 448。合计 ≈5.35 s。
- 可 TRIM（不入 slow、直接变快）: line 293、306、325、357 的 `await f.register(); await f.proof('impl'); await f.proof('test')` 仅为让计划"可交付"以便隔离出 compaction debt；可改用像 `bigPlan` 那样 `requiredDimensions:['implemented']` 的计划，省去真实 bash（4×≈0.3 s ≈ 1.2 s）。line 373/386（premature/repeated refused）**不能**这样改——它们靠"缺 test 证明"制造拒绝。属测试装配微调，需实跑确认断言不变。
- 风险: 全部是交付闸门/崩溃恢复/CAS 契约；`ten-item plan with six proven…`（line 334）与 phase11 `unified-plan-delivery` 的"ten requirements with six proven"同场景但层不同（见第三节）。被测模块 `session-plan-delivery.mjs` 在 `plugin-change-manifest.json:231` 为 `before:null`（新增），生产 cordis.patch.yml 未引用；`work-context-checkpoint-20261005.md:24` 明确这是在建功能，勿据"未加载"删。

### native-tests/execution-proof-runtime.test.mjs  (tests=13, ms=4158)
- 判定: SLOW-FILE（真实 Git bash + node oracle，7 次子进程；文件加载约 1.8 s）
- 被测: `team-v15-execution-proof.mjs` 的 `createExecutionProofProducer` 经真实 `ToolRuntime` + 官方 bash 工具产出 test/acceptance 持久证明。
- 理由/证据: `fixture`（line 28–99）真 `LocalBashExecutor`（line 47–49，win32 写死 Git bash）。真起进程的用例：`test`330、`acceptance`285、`callerCancel`264、`hardAbort`261、`source`252、`proof cancellation observer…`279、`real zero-exit…`275（pre/acl/post 三个子用例被 deny，不起 bash，≈70 ms）。
- 可删用例: 无（不凭标题删）。候选（待 phase11 侧确认）：子用例 `source`（252 ms）与 `real zero-exit is insufficient…`（275 ms）分别与 phase11 `unified-execution-proof` 的"changes during actual execution invalidate source…"和"zero exit, prose passed, incomplete/duplicate/failed checks…"同主题。
- 可入 slow 的用例: 上述 7 个真实 bash 用例（≈1.95 s 用例时间；其余为文件加载）。
- 风险: `callerCancel`/`hardAbort` 是 native bridge 取消语义，phase11 不会有；`pre-execute/ACL/post-execute deny` 是原生 ToolRuntime 钩子契约。KEEP。

### native-tests/team-execution-proof.test.mjs  (tests=5, ms=1102)
- 判定: KEEP（`registered team_v12 execution_prove…` 803 ms 入 slow）
- 被测: `team-v12-runtime.mjs` 的 `team_v12 execution_prove` 动作（tier 授权、固定 recipe、取消方法缺失、额外字段/外来 slot 拒绝）。
- 理由/证据: 与 execution-proof-runtime 的第一条同样对 test/acceptance 各跑一次真实 bash，但入口是 `team_v12` 插件动作并断言 `deliveryAuthorityReceipts[...].leaseRef`、`provenance.kind`（line 117–130），不是同一断言。
- 可删用例: 无。
- 可入 slow 的用例: `registered team_v12 execution_prove executes real fixed recipes…` 803 ms（2 次真实 bash；Git bash 路径写死）。
- 风险: 授权边界（tier2 不得证明 root）、输入白名单契约，KEEP。可选微优化：该用例与 execution-proof-runtime 第一条各只跑 1 个 kind（省约 0.3 s），收益小，不建议。

### native-tests/history-recall-runtime.test.mjs  (tests=14, ms=2615)
- 判定: KEEP（1 条入 slow）
- 被测: `team-v15-history-recall.mjs` 的 history_recall 工具：原始 Query 召回、分页收据、组装产物、LlmRuntime adapter 确认、ACL/源变更复检（`team-v12-runtime.mjs:31` 在生产加载链上）。
- 理由/证据: 全部内存（`SessionQueryEngine` + 控制面），70–280 ms；仅 `ptc:true` 用例起真实 NodePtcRuntime 子进程。
- 可删用例: 无。
- 可入 slow 的用例: `official Node PTC returns server assembly through a native parent; only complete outer dispatch clears debt` 523 ms（真实 PTC node 子进程）。
- 风险: 与 phase11 `unified-history-recall.test.mjs`（7 条）主题重叠，但本文件有 phase11 标题里没有的"assemble → artifactDeliveryReceipt / modelDeliveryReceipt / branded adapter"整条链（line 195–392），不可整体删。

### native-tests/native-goal-delivery.test.mjs  (tests=14, ms=2144)
- 判定: KEEP+TRIM（1 条 MERGE，1 条入 slow）
- 被测: `GoalService` 完成闸门 + `team-v15-goal-delivery.mjs` 的 outbox 恢复；JSONL 刷盘失败/确认失败/进程崩溃恢复。
- 理由/证据: 内存用例 83–220 ms（主要是 `goalFixture` 每次重建 JSONL+计划注册+控制面）。
- 可删用例: `cold non-Team restoration cannot forget a previously bound goal completion requirement`（99 ms，line 112–118）→ 被 `goal-durable-requirement.test.mjs` 的 `the actual UI Remote endpoint cannot bypass a missing gate after cold non-Team restoration`（line 81–87）覆盖：同样 `native:false` + `reload({completionGate:false})`、同样 `GOAL_DELIVERY_BRIDGE_UNAVAILABLE`、同样 phase 仍 active；唯一差别是本条额外断言 `outbox(f).length === 0`。**先把这条 outbox 断言补进替代用例再删**。
- 可入 slow 的用例: `abrupt process exit after goal flush recovers only durable matching outbox effect` 500 ms（line 159–172，`spawnSync` 子进程以退出码 19 崩溃）。
- 风险: 删 MERGE 项只失去一个重复入口；崩溃/持久化/收据契约全部 KEEP。

### native-tests/goal-durable-requirement.test.mjs  (tests=13, ms=1274)
- 判定: KEEP
- 被测: 目标 `native/delivery-required` 持久化要求、绑定 flush 失败、UI Remote 完成端点、JSONL 非法标记拒绝。
- 理由/证据: 全内存，77–147 ms；5 条 `JSONL rejects malformed…`（line 98–106）每条要新建 fixture（毒化后不能复用），属持久化格式契约。
- 可删用例: 无。可入 slow: 无。
- 风险: 无。

### native-tests/goal-convergence.test.mjs  (tests=15, ms=1642)
- 判定: KEEP
- 被测: `dsh-goal` 的 blocked/progress 收敛链（pure fold + JSONL replay + `goal_progress`/`update_goal` 实际工具）。
- 理由/证据: 全内存，82–145 ms/条（fixture 重建占大头）；每条断言不同的错误码/链路径，无同入口同断言重复。
- 可删用例: 无。可入 slow: 无。
- 风险: 无。

### native-tests/strict-plan-scope.test.mjs  (tests=6, ms=809)
- 判定: KEEP+TRIM
- 被测: `team-v12-runtime.mjs` 的 `deliveryPolicy.requirePlan` 严格开关只绑定"真有队友的 root"（R1–R5 为需求编号，视作原始反例，默认 KEEP）。
- 理由/证据: `joinEvent`（line 72–75）每次固定 `setTimeout 50` 等事件钩子生效，共 5 处 ≈250 ms。
- 可删用例: 无。可入 slow: 无。
- 可 TRIM: line 74 的 50 ms 改为"最多 N 个 `setImmediate` tick 后检查 `strictMarkers()`"（正向用例）；负向用例（R2-provisioning、R5）仍需一个很短的固定等待，可降到 10–15 ms。预计省 ≈0.15–0.2 s。
- 风险: 改成轮询时必须保证负向用例仍等到钩子"本应触发"的时间点，否则会假通过。

### native-tests/hypothesis-runtime.test.mjs  (tests=9, ms=744)
- 判定: KEEP
- 被测: `team-v15-hypothesis-runtime.mjs` 经原生 ToolRuntime/before-final 钩子的假设预算、持久意图 CAS、重装恢复。
- 理由/证据: 全内存 54–113 ms。与 phase11 `unified-hypothesis-runtime`/`unified-hypothesis-memory` 主题相近（见第三节），但本文件走真实 `ToolRuntime` 与原生 `HarnessError` 码路径。
- 可删用例: 无。可入 slow: 无。
- 风险: `authority change after admitted body records unknown historical outcome…`、`concurrent same-hypothesis calls…` 为并发/CAS 契约，KEEP。

### native-tests/active-identity-runtime.test.mjs  (tests=5, ms=512)
- 判定: KEEP
- 被测: `team-v12-runtime.mjs` 的 activeIdentity（激活/pre-step 交付/hostBootstrap/上限预算）。
- 理由/证据: 全内存 75–139 ms，走真实 ToolRuntime + `agent/pre-step` waterfall，只有 team 成员关系是 fixture。后两条（mid-turn delta cap、超大 pending message）是预算反例，KEEP。
- 可删用例: 无。可入 slow: 无。
- 风险: 与 phase11 `unified-active-identity.test.mjs` 同主题，见第三节。

### native-tests/native-bridge.test.mjs  (tests=24, ms=439)
- 判定: KEEP（1 条真子进程，309 ms）
- 被测: `installNativeSessionBridge` 的 accepted-before-ack、抢占、提升、writer 围栏、崩溃恢复。
- 理由/证据: 其余 23 条 2–32 ms；本文件行 230–233 `spawnSync` 崩溃子进程（退出码 17）。未通读全文，按用例名与耗时判断。
- 可删用例: 无。
- 可入 slow 的用例: `actual JSONL persisted accepted input survives abrupt subprocess exit and claim recovery` 309 ms（真子进程；崩溃恢复契约，仅分组）。
- 风险: 协议/崩溃/CAS 契约，KEEP。

### native-tests/deployment-copy-lineage.test.mjs  (tests=3, ms=376)
- 判定: KEEP（可选 slow）
- 被测: `tools/deploy-production.mjs --plan` 的物理拷贝谱系校验。
- 理由/证据: 每条 `spawnSync(node deploy-production.mjs)`（line 33），用 `tmpdir` 假目录；不起 git。耗时 115–134 ms/条。
- 可删用例: 无。可入 slow: 3 条各 ≈0.13 s（真子进程，量小，非必须）。
- 风险: 部署授权边界契约，KEEP。

### native-tests/host-lifecycle.test.mjs  (tests=19, ms=109)
- 判定: KEEP
- 被测: 宿主 writer/read-lease 栅栏与异步插件安装。全内存、≤42 ms；未通读，按用例名/耗时 KEEP（并发/CAS 契约）。
- 可删用例: 无。可入 slow: 无。风险: 无。

### native-tests/host-lifecycle-disposer-race.test.mjs  (tests=15, ms=27)
- 判定: KEEP
- 被测: 延迟 disposer 与 writer/lease/gate 的竞态。全内存、≤8 ms；唯一 `setTimeout` 是 3000 ms 的超时上限（line 6，`clearTimeout` 于 finally）。竞态/死锁契约，KEEP。
- 可删用例: 无。可入 slow: 无。风险: 无。

### native-tests/agent-lifecycle.test.mjs  (tests=4, ms=16)
- 判定: KEEP — AgentRegistry 创建/恢复在转换栅栏下的顺序，≤9 ms，并发契约。可删/可入 slow：无。

### native-tests/compaction-prefix-projection.test.mjs  (tests=7, ms=23)
- 判定: KEEP — 压缩前缀投影（含 fail-open），≤9 ms，未通读，按用例名/耗时 KEEP。可删/可入 slow：无。

### native-tests/context-delivery-compact-fallback.test.mjs  (tests=10, ms=17)
- 判定: KEEP — 紧凑回退投递（含 `regression pin` 与 `safety-critical 不压缩`）。与 context-delivery-relevance 在"tie order priority→reverse id"上有 1–2 条主题重叠（`tie order…` ↔ `rank is only the first key…`），未通读两个文件的断言，且合计 42 ms，不提 DELETE。可入 slow：无。

### native-tests/context-delivery-relevance.test.mjs  (tests=18, ms=25)
- 判定: KEEP — 同上，含 `memberTaskUse`/`requirementCompactRank` 纯函数用例，≤13 ms。可入 slow：无。

### native-tests/instant-follow-codec.test.mjs  (tests=2, ms=25)
- 判定: KEEP — host/remote follow wire codec 保留 generation，协议契约。

### native-tests/instant-stream-accumulator.test.mjs  (tests=5, ms=2)
- 判定: KEEP — 流累加器按 generation 的不可变被取代片段与失败关闭，2 ms。

### native-tests/instant-web-presentation.test.mjs  (tests=2, ms=2)
- 判定: KEEP — Web 实际 assistant 定义渲染被取代尝试，2 ms。

### native-tests/lab-tool-admission.test.mjs  (tests=2, ms=16)
- 判定: KEEP — 实验室工具准入单调拒绝（强制 allow 的 listener 也不能放行），权限边界契约。

### native-tests/native-compaction-tail.test.mjs  (tests=5, ms=20)
- 判定: KEEP — 手动/溢出压缩保留尾部与持久化不可用时不报成功，≤13 ms。

（以上 9 个小文件未逐条通读，均因"≤25 ms 且为契约/并发类"而 KEEP；无删减收益。）

---

## 三、跨文件重复（native-tests 一侧 vs phase11 unified-*）

说明：phase11 一侧我只读了用例标题（grep `test(` 行），**没读断言**；下表"重复度"是按标题+本侧断言推断，**均需 phase11 读者确认后才可提 DELETE**。保哪边的总原则：native 一侧走真实 ToolRuntime/SessionStore/原生钩子，phase11 一侧多为插件模块级；重叠时优先保 native，phase11 若确认逐条断言同入口则删 phase11 侧。

| native 用例（文件） | phase11 对应文件 / 用例标题 | 重复度 | 建议 |
|---|---|---|---|
| history-recall-runtime：`registered raw Query recall restores original bytes after two actual compactions…`(262 ms) | `unified-history-recall.test.mjs`：`raw JSON byte pages, full fetched only after every page, durable hashes and repeat idempotency` | 中：同"分页→full-fetched→幂等"，native 另加两次真实压缩与 journal 前缀不变 | 保 native；phase11 侧由读者判断 |
| history-recall-runtime：`actual Query tool pairing retains complete nonadjacent raw invocation and result`(205 ms) | `unified-history-recall`：`tool call/result references include exact non-adjacent pair; incomplete call cannot full fetch` | 高（标题几乎相同） | 待确认：保一边即可，约 0.2 s |
| history-recall-runtime：`wrong expected source vector, missing references and caller source fabrication never clear raw recall debt`(79 ms) | `unified-history-recall`：`wrong revision/hash, unknown/missing locator, missing seq and changed source remain durable debt` + `caller cannot supply original text, passed status or source revision; cross scope denied before query` | 高（CAS 冲突/未知 locator/缺 seq/伪造 全覆盖） | 待确认：保 native（走真实注册 ACL），phase11 两条里重叠部分可裁 |
| history-recall-runtime：`real registered ACL denies foreign Query reads…`、`raw source changed after return and current cross-session ACL revoked…` | `unified-history-recall`：`expired or unavailable raw source invalidates a previously full-fetched receipt…`；`…cross scope denied before query` | 低–中 | KEEP 双方 |
| history-recall-runtime：assemble/artifactDeliveryReceipt/branded adapter 6 条 | （无标题对应） | 无 | KEEP |
| execution-proof-runtime：`actual native ToolRuntime executes official bash and durable test/acceptance proof with real parent tokens`(615 ms) | `unified-execution-proof.test.mjs`：`test and acceptance proofs bind exact server recipe, physical sources and durable authority`；另 `team-execution-proof.test.mjs` 同主题（本包内） | 中：同样 test/acceptance 两 kind；native 特有 stage 顺序 + parent token 链 | 保 native；phase11 如用假 bash 则不算重复 |
| execution-proof-runtime：子用例 `source`(252 ms)、`real zero-exit…`(275 ms) | `unified-execution-proof`：`changes during actual execution invalidate source…`、`zero exit, prose passed, incomplete/duplicate/failed checks…` | 中 | 待确认；各自 ≈0.26 s，收益小 |
| team-execution-proof：`registered team_v12 execution_prove…`(803 ms) | `unified-execution-proof` / `unified-team-delivery-gate`（`actual Team gate consumes the shared server verdict…`） | 低–中：入口是 team_v12 动作，授权/租约断言独有 | KEEP |
| hypothesis-runtime：`server intent cannot bind caller evidence, foreign requirement…` | `unified-hypothesis-runtime`：`caller cannot supply identity, status, progress or evidence claims…`、`attempt metadata requires a server callback and a declared current task requirement` | 中（native 另含 CAS 与持久意图） | 待确认 |
| hypothesis-runtime：`native stable error codes count as new observations…`、`native repeated probes wait for durable final observations…` | `unified-hypothesis-memory`：`a new server error code or explicit observed progress resets the no-progress streak`；`attempt, key, audit and time budgets are explicit and bounded` | 中：phase11 是内存模块 API，native 是经 ToolRuntime 的原生错误码/终态观察 | 保 native；phase11 视确认 |
| hypothesis-runtime：`concurrent same-hypothesis calls…` | `unified-hypothesis-memory`：`parallel processes preserve durable attempts and duplicate attemptId is idempotent` | 低（一个同进程并发，一个多进程） | KEEP 双方 |
| active-identity-runtime：`native pre-step: a common-only (AGENTS.md) change waits for activation…` | `unified-active-identity.test.mjs`：`common-only identity change re-versions every role and delivers the new common…`、`activation in the middle of a step does not alter the captured identity…` | 高（主题与"捕获消息不被改写"断言同） | 待确认；保 native 真实 pre-step waterfall |
| active-identity-runtime：`native ToolRuntime activation and real agent pre-step consume only the approved durable role bundle` | `unified-active-identity`：`A to B to A advances the identity epoch every time`、`active bundle is durable, disk edits wait for explicit activation…` | 中 | 待确认 |
| active-identity-runtime：`host bootstrap…`、两条上限预算 | （无标题对应；预算类可能在 `unified-budget-admission.test.mjs`，未核） | 未知 | KEEP |
| session-plan-delivery：`ten-item plan with six proven stays partial although the summary claims everything is complete` | `unified-plan-delivery.test.mjs`：`ten requirements with six proven cannot complete; preview reports accurate partial scope without writes` | 场景同，层不同（本条叠加 compaction 摘要声称全完成） | KEEP 双方 |
| session-plan-delivery：`strict no-goal session persists an empty-plan partial verdict…`、`strict policy cannot be downgraded…` | `unified-team-delivery-gate.test.mjs`：`actual Team check fails closed for durable strict policy with no registered plan or service`；本包 `strict-plan-scope`(R3) | 低–中（入口分别为本地会话/Team/team-v12） | KEEP |
| session-plan-delivery：compaction 债务 4–5 条 | `unified-delivery-debt.test.mjs`：`current-plan Room, waiting, compaction, plan-read and descendant input debt cannot be hidden by notices` | 低（phase11 为纯函数债务收集） | KEEP |
| native-goal-delivery：`durable goal effect survives ack failure…`、`abrupt process exit…` | `unified-delivery-authority.test.mjs`：`queued crash replay is idempotent; callback failure keeps receipt recoverable…`、`actual control-plane persistence precedes sync consumer…` | 低（phase11 为 authority 层，native 为 GoalService 层） | KEEP |
| native-goal-delivery `cold non-Team restoration…`(99 ms) | 本包 `goal-durable-requirement`：`…UI Remote endpoint cannot bypass a missing gate after cold non-Team restoration` | 高（本包内，已读两侧） | MERGE：补 outbox 断言后删前者 |
| instant-history-runtime 两条 | 本包内同文件两条 | 高（见第二节） | 合并宿主，不删 |

DELETE 汇总：0 条确认。可节省的"重复"总量（待 phase11 确认后）≤ 约 1.2 s；真正的收益在 SLOW 分组与 lab 退出拖尾/宿主合并。
