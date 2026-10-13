# C2 phase11 unified-* / v14-identity / delivery 重叠分析（只读）

总览：
- 34 个文件（259 条，基线合计约 16.7 s）；已读全部 phase11/phase6/7/9/10/usage 源文件 + 对照读 native 同主题 8 个文件。该批几乎无真正重复：phase11 是模块级（假宿主/fixture），native 是真宿主集成，断言层不同。
- 建议 DELETE 1 条、MERGE 2 条（均在同目录内，合计约 0.17 s）；跨 native 的可删：1 条整条 + 1 个子用例（约 0.32 s，归属 native 包，见末节）。
- SLOW-TESTS 明确 2 条（usage 真实 112 MB 日志 3.28 s；evidence-binding 含 1.3 s 真实 sleep 的 1.76 s）+ 可选 3 条（fsync 密集 fixture），合计约 5.0 s 可移入 slow 通道（可选再约 2 s）。
- 重要发现：phase6/milestone-tail-delivery 与 phase7/delivery-gate 导入的是生产目录 `D:\dsh-test\home\profiles\web\plugins\team-tools-v2.mjs`（不是 stage，且 cordis.patch.yml 加载的是 `team-tools-v2-r10.mjs`，plugins 内无任何文件 import team-tools-v2.mjs），测的是未加载版本；它们是 r10 的 tail/gate 契约仅有的脚本式覆盖，不可直接删，应重定向到 stage 的 r10（需主会话决定）。
- v14-identity-context（14 条，19 ms）全部 KEEP（S0 依赖）；没有任何 `B-nnn/D-n/§nn/batch/defect` 命名的 p11 用例在本批被提 DELETE。

生产加载依据（cordis.patch.yml）：`team-v12-runtime.mjs`、`team-tools-v2-r10.mjs`、`step-compaction-v4.mjs`、`team-policy.mjs`、`context-workspace.mjs`、`team-v15-window-*` 均在加载清单；team-v12-runtime.mjs 在第 25–42 行直接 import 全部 team-v15-*（plan-registry/plan-refs/delivery-service/delivery-source/delivery-debt/history-recall/execution-proof/implementation-proof/runtime-proof/hypothesis-runtime/active-identity/goal-delivery）、team-v14-context-delivery、team-v12-evidence-scheduler；step-compaction-v4 import team-v13-compaction-shadow（→ economics）、team-milestone-v2、team-v12-compaction。故本批除 `team-tools-v2.mjs` 外被测模块全部在生产加载链上。

---

### phase10-tests/compaction-economics.test.mjs  (tests=7, ms=1)
- 判定: KEEP
- 被测: team-v13-compaction-economics 的 decideCompaction / estimateRemainingRequests / summarizeCacheUsage（纯函数）
- 理由/证据: step-compaction-v4.mjs:36 import shadow，shadow:18 import economics，在生产链上；7 条合计 1 ms，无节省空间
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无；与 phase11 unified-window-economics 测的是不同模块（team-v15-window-economics），不重复

### phase10-tests/compaction-shadow.test.mjs  (tests=4, ms=67)
- 判定: KEEP
- 被测: team-v13-compaction-shadow.evaluateTimeline（写 telemetry 文件去重）+ team-milestone-v2.shouldCompact(pressure)
- 理由/证据: 同上在生产链；3 条各 ~21 ms 是 mkdtemp+写 JSON，非进程/睡眠
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无

### phase11-tests/unified-active-identity.test.mjs  (tests=12, ms=981)
- 判定: KEEP+TRIM
- 被测: team-v15-active-identity createActiveIdentityService（激活 CAS、role 映射、窗口栅栏）+ team-v14-context-delivery.buildContextDelivery 的 delta
- 理由/证据: 契约测试（CAS/权限/持久化）为主，保留。仅同文件内两处可合并（均为同一函数同一输入的子集）
- 可删用例（MERGE，保留全部断言并入另一条）:
  - 「A to B to A advances the identity epoch every time」(97 ms)：与「delivery revision changes on same-name activation and A to B to A」(109 ms) 是同一场景 A→B→A；前者断言 epoch=[1,2,3]、first.contentHash===third.contentHash，后者断言 revision 变化与 content hash 相等。把 `deepEqual([first.epoch,second.epoch,third.epoch],[1,2,3])` 与 `snapshot().epoch===3` 并入后者即可。约省 90 ms
  - 「common-only edit without regenerating the manifest hash is rejected…」(68 ms)：与「activation rejects full-manifest hash mismatch, stale CAS…」同路径（IDENTITY_HASH_MISMATCH，只是改的文件是 AGENTS.md 而非 verifier.md）；并入时需保留 `message: /AGENTS\.md/` 与 proposal() 同步抛错的断言。约省 60 ms
- 可入 slow 的用例: 无（每条 40–130 ms，control-plane fsync；「activation queues behind the real control-plane window fence」含 50 ms 真实 setTimeout）
- 风险: 合并后失去「common 文件」与「role 文件」两个独立失败用例名；断言保留则无覆盖损失。S0 无影响
- 跨文件: 与 native-tests/active-identity-runtime.test.mjs 见末节

### phase11-tests/unified-budget-admission.test.mjs  (tests=20, ms=843)
- 判定: KEEP
- 被测: step-compaction-v4 的 preStepBudget / summaryRequestBudget / compactOnIdle / 重试唤醒（持久化、HMR、取消）
- 理由/证据: 文件头注明钉住 2026-10-07 生产故障（914k 窗口溢出）；含重启后重试仍在盘上、HMR 存活、异步唤醒失败不变成 unhandled rejection 等恢复语义，属契约/缺陷反例。无其他测试覆盖同一 preStepBudget 输入
- 可删用例: 无
- 可入 slow 的用例: 无（唤醒类 7 条各 44–154 ms，用 `wait(20..120)` 真实 setTimeout 与 `budgetRetryBackoffMs:[10..40]`；最长 154 ms，不值得分流）
- 风险: —

### phase11-tests/unified-context-debt.test.mjs  (tests=3, ms=4)
- 判定: KEEP
- 被测: team-v14-context-delivery 的 buildContextDelivery / committedContextCursor / durableContextVersions / visibleContextVersions
- 理由/证据: 收据版本迁移（versions-only → 条目回执）与 scope 隔离，持久化格式契约；4 ms
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: v14-identity-context「durable delivery receipts suppress a source…」是本文件第 3 条与 context-dispatch 第 1 条的子集，但那条是 S0，不动

### phase11-tests/unified-context-dispatch.test.mjs  (tests=3, ms=14)
- 判定: KEEP
- 被测: installContextDispatchObserver + request-message-projection + 真实 LlmRuntime 适配器边界
- 理由/证据: 「只有 adapter 真实边界才回执」「abort 不产生回执」是契约；14 ms
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: —

### phase11-tests/unified-control-durability.test.mjs  (tests=3, ms=150)
- 判定: KEEP
- 被测: team-control-plane 发布路径的 fsync 顺序与失败回滚（注入 fs.fsyncSync）
- 理由/证据: 持久化/崩溃恢复契约；无其他文件覆盖 fsync 注入（本批 grep 无同类）
- 可删用例: 无
- 可入 slow 的用例: 无（50 ms 级）
- 风险: —

### phase11-tests/unified-control-writer.test.mjs  (tests=3, ms=232)
- 判定: KEEP
- 被测: persistControlPlaneSnapshot(Async) 的 CAS、窗口栅栏、目录别名共享栅栏
- 理由/证据: CAS/并发语义契约；含 1 个 40 ms 真实 setTimeout 与 1 个 junction
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: —

### phase11-tests/unified-delivery-authority.test.mjs  (tests=13, ms=608)
- 判定: KEEP
- 被测: team-v15-delivery-authority（commit/ackOutbox/authorizeGoal）+ delivery-service.checkAll/deliveryCheckCoverage
- 理由/证据: 「持久化先于 consumer」「崩溃重放幂等」「回读不一致拒绝」属持久化/崩溃恢复契约。对照 native-goal-delivery：那边是 GoalService+JSONL flush 层（NATIVE_DURABILITY_UNAVAILABLE、ACK_FAILURE），本文件是 authority 层，断言码不同，不重复
- 可删用例: 无
- 可入 slow 的用例: 无（40–76 ms/条，control-plane 写盘）
- 风险: —

### phase11-tests/unified-delivery-debt.test.mjs  (tests=8, ms=54)
- 判定: KEEP
- 被测: team-v15-delivery-debt（collectRuntimeDeliveryDebt / readDeliveryMilestones / deliveryPendingInput）
- 理由/证据: 授权边界（junction 逃逸 DENIED）、权威债务不可被 notice 隐藏、compaction epoch 旧游标不可清债，均为 fail-closed 契约
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: —

### phase11-tests/unified-delivery-source.test.mjs  (tests=4, ms=65)
- 判定: KEEP
- 被测: team-v15-delivery-source collectDeliverySource / collectDeliveryContext（物理 manifest）
- 理由/证据: 路径越界/junction/预算溢出为授权边界；无其他测试覆盖
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: —

### phase11-tests/unified-engine-compaction-recovery.test.mjs  (tests=11, ms=47)
- 判定: KEEP
- 被测: step-compaction-v4 的引擎 compaction/end 观察者（锚点检查、账本行、恢复通知、去重）
- 理由/证据: 11 条各 2–11 ms；与 unified-native-summary/milestone-runtime 同样调用 compactOnIdle，但本文件测的是 session/event 观察者路径（emit compaction/end），输入不同
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: —

### phase11-tests/unified-evidence-binding.test.mjs  (tests=20, ms=2836)
- 判定: KEEP+SLOW-TESTS
- 被测: team-v12-evidence-scheduler（acceptance matrix/verification plan/reuse）+ 经真实 team_v12 工具与 control-plane 的 reuse_receipt_put / review_package / verification_plan（含 v15 server proof 作为 reuse 来源）
- 理由/证据: 绑定/防篡改/防伪造回执/仅 lead 或 tier0 可记录，授权与持久化契约；前 10 条纯函数 0–4 ms。本文件内无同输入重复
- 可删用例: 无
- 可入 slow 的用例:
  - 「stored receipts stop covering after tree change, expiry, tampering or requirement change, with readable reasons」1762 ms：含 `ttl:1200, wait:1300` 真实 sleep 1.3 s + 9 次 reuseHarness（每次 applyRuntime + cp.flush）。原因 = 睡眠 + 重复建 fixture。建议整条入 slow；若要提速需让回执过期时间可注入（改被测/测试，不在本任务范围）
  - 「v15 reuse stops when the current source, plan or proof no longer matches…」643 ms：12 次 harness，无 sleep，fsync 密集（可选入 slow）
- 风险: 入 slow 不丢覆盖；若 slow 通道默认不跑，则「回执过期（reuse-receipt-expired）」会在默认回归里缺失，建议保留一个不 sleep 的过期断言（直接在 seed 里把 expiresAt 写成过去）后再分流

### phase11-tests/unified-execution-proof.test.mjs  (tests=28, ms=3501)
- 判定: KEEP（SLOW-TESTS 可选）
- 被测: team-v15-execution-proof createExecutionProofProducer（假 toolRuntime）
- 理由/证据: 授权边界+fail-closed 契约：调用方不得提供 status/command/hash，11 种执行期间状态变化均拒绝。与 native-tests/execution-proof-runtime 的重叠见末节：断言层不同（native 走真 ToolRuntime+真 bash）
- 可删用例: 无（与 native 的重叠只建议删 native 侧子用例）
- 可入 slow 的用例（可选，无进程、纯 fsync fixture，约 63–70 ms/个子用例 × 25）:
  - 「zero exit, prose passed… fail closed」637 ms（10 个子用例，每个重建 fixture）
  - 「changes during actual execution invalidate…」762 ms（11 个子用例）
- 风险: 这两条是 proof 防伪核心，宁可保留在默认通道；它们不是进程/睡眠型，按规范第 6 条不判 SLOW，仅列为候选

### phase11-tests/unified-failure-telemetry.test.mjs  (tests=3, ms=47)
- 判定: KEEP
- 被测: team-v13-mechanism-telemetry createTelemetry / normalizeTelemetryState / dormantVerdict
- 理由/证据: 持久化格式迁移（旧 kinds → fired）；模块被 action-fusion-v2/evidence-reducer/step 链等加载插件 import
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: —

### phase11-tests/unified-history-recall.test.mjs  (tests=7, ms=617)
- 判定: KEEP
- 被测: team-v15-history-recall createHistoryRecall（假 sessionQuery）
- 理由/证据: 7 条中 4 条在 native 侧没有对应（large artifacts/provider 不可用、unrelated 引用不得制造 pairing-complete、源过期回滚收据、byte-page 的末页不完整与 debt 状态）。其余 3 条与 native-history-recall-runtime 部分重叠，见末节
- 可删用例: 无
- 可入 slow 的用例: 无（55–130 ms，control-plane 写盘）
- 风险: —

### phase11-tests/unified-hypothesis-memory.test.mjs  (tests=8, ms=470)
- 判定: KEEP
- 被测: team-v15-hypothesis-memory createHypothesisMemory（持久文件、证据 server 读取、预算、并发）
- 理由/证据: 「bad and old durable files are rejected without replacing their bytes」「parallel processes preserve durable attempts…」是持久化/并发契约
- 可删用例: 无
- 可入 slow 的用例: 无（「parallel processes」140 ms，起 4 个 node 子进程，但 <0.2 s，且是并发契约，不分流）
- 风险: —

### phase11-tests/unified-hypothesis-runtime.test.mjs  (tests=8, ms=181)
- 判定: KEEP
- 被测: team-v15-hypothesis-runtime apply（pre-execute/result 钩子，假 ctx.on）
- 理由/证据: 与 native-tests/hypothesis-runtime 对照：native 走真 ToolRuntime + durable intent（bind/clear/generation/CAS），p11 走 readAttempt 回调 + 假钩子；durable-proof 十种篡改（「only a durable, current proof…」）与「lease 缺失/歧义/过期」在 native 无对应
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: —

### phase11-tests/unified-implementation-proof.test.mjs  (tests=3, ms=247)
- 判定: KEEP
- 被测: team-v15-implementation-proof createImplementationProofProducer
- 理由/证据: 授权边界（slot/lease/写范围）；仅此文件覆盖 implementation proof
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: —

### phase11-tests/unified-memory-truncation.test.mjs  (tests=10, ms=17)
- 判定: KEEP
- 被测: team-v14-memory-anchor captureMemberMemory / buildMemberRecoveryPack（截断债务、定位符、hash）
- 理由/证据: 纯函数 17 ms；断言 locator/hash/单位，属持久化格式契约
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: —

### phase11-tests/unified-milestone-runtime.test.mjs  (tests=6, ms=36)
- 判定: KEEP+TRIM
- 被测: step-compaction-v4 apply 的 runtimeFacts（路径/hash/instance/HMR）与 compactOnIdle 的 floor 门槛
- 理由/证据: 其中一条被同目录另一文件完全覆盖
- 可删用例:
  - 「compactOnIdle still folds the pending milestone from its configured path」(8 ms)：同一函数 compactOnIdle、同一夹具（doc.members.a1 done、compactions.a1 pending-idle、tokens 500000、windowTokens 1000000、summary `a1 S W next action`），断言 `/^folded:milestone:/` 与 `summaryAvailable===true`。被 phase11-tests/unified-native-summary.test.mjs「native summary object remains visible to the real idle compaction anchor path」完全覆盖（该条断言更严：`/^folded:milestone:committed/`、summaryAvailable、missingAnchors 含 `source:unavailable`、notices.length===1）
- 可入 slow 的用例: 无
- 风险: 无覆盖损失；其余 5 条（runtimeFacts/HMR/junction/floor）无替代，保留

### phase11-tests/unified-milestone-source.test.mjs  (tests=1, ms=15)
- 判定: KEEP
- 被测: team-v15-delivery-debt readRuntimeDeliveryMilestones（运行时 configuredPath 必须与严格交付源匹配）
- 理由/证据: 授权/绑定边界，唯一覆盖
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: —

### phase11-tests/unified-native-summary.test.mjs  (tests=6, ms=15)
- 判定: KEEP
- 被测: step-compaction-v4 compactionSummaryText / compactionResultStatus / compactOnIdle 的结果分类
- 理由/证据: 是上面被删用例的替代覆盖方，必须保留
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: —

### phase11-tests/unified-plan-delivery.test.mjs  (tests=14, ms=35)
- 判定: KEEP
- 被测: team-v15-plan-delivery normalizePlan / registerPlan / evaluatePlanDelivery / commitPlanDelivery（纯函数）
- 理由/证据: 14 条合计 35 ms；与 native-tests/session-plan-delivery 的「ten-item plan with six proven」同主题但不同层：此处是纯评估器的 partial/remainingScope，native 是真 compaction 摘要声称全完成时的债务与 gate。纯函数这条更直接、依赖更少，保留 p11；native 那条多出的 compaction claim 断言不可被替代
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: —

### phase11-tests/unified-plan-refs.test.mjs  (tests=5, ms=29)
- 判定: KEEP
- 被测: team-v15-plan-refs readTaskPlanRef / recordPlanRead / confirmPlanReadDispatch / installPlanReadDispatchObserver
- 理由/证据: 路径授权 + 分发回执契约；唯一覆盖
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: —

### phase11-tests/unified-plan-registry.test.mjs  (tests=7, ms=409)
- 判定: KEEP
- 被测: team-v15-plan-registry createPlanRegistry / parsePlanSource / verifyRegisteredPlanSource
- 理由/证据: 授权边界（root/路径/预算/junction）与持久化读回；唯一覆盖
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: —

### phase11-tests/unified-prestep-reject-log.test.mjs  (tests=4, ms=294)
- 判定: KEEP
- 被测: team-v12-runtime 的 agent/pre-step 拒绝日志（pre-step-rejects.jsonl，version:1 行格式）
- 理由/证据: 用真 SessionStore/ReactLoopAgent/ToolRuntime；首条 123 ms 为真宿主启动。日志行是持久化格式（code/session/step/不含消息体），不止是文本格式；「不可写日志不改变拒绝」为 fail-closed 契约
- 可删用例: 无
- 可入 slow 的用例: 无（<0.13 s）
- 风险: —

### phase11-tests/unified-runtime-proof.test.mjs  (tests=4, ms=576)
- 判定: KEEP
- 被测: team-v15-runtime-proof createRuntimeProofProducer / runtimeProofDebt + 生产 context-workspace.mjs
- 理由/证据: 用真 context-workspace（在 cordis.patch.yml 第 23–24 行加载）；「已持久化 passed 回执不能掩盖后续禁用」是 fail-closed 契约
- 可删用例: 无
- 可入 slow 的用例: 无（~140 ms/条）
- 风险: —

### phase11-tests/unified-team-delivery-gate.test.mjs  (tests=4, ms=333)
- 判定: KEEP
- 被测: team-tools-v2-r10 的 team_delivery_check（生产加载版本）+ team-policy
- 理由/证据: 这是 r10 gate 的真实工具测试；末条「every field … declared in its output schema」钉住宿主输出 schema 校验
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 它不覆盖 queued dispatch / major finding 阻断（见 phase7/delivery-gate）

### phase11-tests/v14-identity-context.test.mjs  (tests=14, ms=19)
- 判定: KEEP（S0 依赖的缺陷反例，不得动）
- 被测: team-v14-identity.resolveIdentity、failure-memory actionFingerprint、event-continuation 扫描、identitySource/buildContextDelivery/taskContext、policy 默认值
- 理由/证据: 14 条 19 ms，纯函数/源码字节比对，无节省空间
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 其中「old members receive only the changed role identity…」「durable delivery receipts suppress…」「required context debt is visible…」与 p11 active-identity/context-dispatch/native context-delivery-* 有主题重叠，但按 S0 规则一律不动；重叠方（p11/native）保留，不会因此被替代。

### phase6-tests/milestone-tail-delivery.test.mjs  (tests=1, ms=259)
- 判定: KEEP（需重定向目标；主会话需决定：重定向到 stage 的 r10，或确认后 DELETE-FILE）
- 被测: team-tools-v2.mjs（生产目录绝对路径 `D:\dsh-test\home\profiles\web\plugins\`）的 milestone 追加到请求尾部、不进 system prompt 前缀、不用 inject 队列、可视面去重、compaction 后恢复
- 理由/证据: 脚本式（PASS/FAIL 文本）单 test，子进程运行。(1) 导入生产 home 而非 stage，被测的不是本次 stage 代码；(2) cordis.patch.yml:345 加载 `team-tools-v2-r10.mjs`，plugins 内无任何文件 import `team-tools-v2.mjs`，所以此脚本测的是未加载的旧版本。但 r10 的同一契约（pre-step 尾部追加 `[team milestone #N]`、system prompt section 与 milestone 无关）我在本批与 usage 测试中只找到 hasCurrentMilestoneSnapshot 级别的覆盖（usage-tests/team-milestone-surface-dedup），没有 hook 级与「前缀不变」的覆盖，因此不能凭此判 DELETE
- 可删用例: 无
- 可入 slow 的用例: 无（259 ms，起子进程；是否分流取决于是否重定向）
- 风险: 直接删会失去 r10 的「milestone 不污染可缓存前缀」唯一脚本验证；不确定点：r10 当前行为是否仍满足该脚本断言（未运行，只读）

### phase7-tests/delivery-gate.test.mjs  (tests=1, ms=403)
- 判定: KEEP（需重定向目标，同上）
- 被测: 生产目录 team-tools-v2.mjs 的 team_delivery_check 全链路（plan→claim→complete→packet→accepted），随后 queued dispatch 与 major finding 关门
- 理由/证据: 同样导入 `D:\dsh-test\home\profiles\web\plugins\team-tools-v2.mjs` 与 team-policy.mjs（生产目录），测未加载版本。对 r10：phase11-tests/unified-team-delivery-gate 只测 legacy clean-board、strict 无 plan、共享 verdict、输出 schema；本批 grep 全测试目录，`row.kind === 'dispatch' && status === 'queued'` 与 `kind === 'finding' && status === 'major'` 仅出现在此脚本（phase3 team-tools-v2.test 只测 deliverable 的基本路径，且同样导入 team-tools-v2.mjs），所以 queued dispatch/major finding 阻断对 r10 没有替代覆盖
- 可删用例: 无
- 可入 slow 的用例: 无（403 ms，子进程脚本 + 全链路 board/packet，是整批里 phase6/7 的最贵单项，但不属于缺陷反例以外可随意分流项）
- 风险: 同上；若主会话重定向到 stage 路径，应同时消除对生产 home 的路径依赖（与「regression 进程不进入生产 home」的近期提交一致）

### phase9-tests/v12-room-wake-compaction-context.test.mjs  (tests=9, ms=15)
- 判定: KEEP
- 被测: team-v12-room-wake / team-v12-compaction / team-v12-context（纯状态机）
- 理由/证据: 三个模块被 team-v12-runtime.mjs:87/109/115 与 step-compaction-v4.mjs:35 import，在生产链上；9 条合计 15 ms；对照 native context-delivery-* 测的是 team-v14 的 buildContextDelivery，不是 team-v12 的 buildContextPack，输入不同
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: —

### usage-tests/team-milestone-surface-dedup.test.mjs  (tests=5, ms=3280)
- 判定: SLOW-TESTS（1 条）
- 被测: team-tools-v2-r10.hasCurrentMilestoneSnapshot + team-milestone-v2.milestoneNotice（生产加载版本）
- 理由/证据: 前 4 条 0–1 ms，纯函数，全部保留
- 可删用例: 无
- 可入 slow 的用例: 「real root seq 69510 prevents the duplicate at seq 70686 (513 bytes)」3278 ms：读取并 zstd 解压 `D:/dsh-test/home/sessions/--D-dsh-test-workspaces-RustMc--/session-028e6f5b-…/session.v4.jsonl.zstd`（实测 112,920,634 字节，生产 home 的真实会话日志）逐帧扫描到 seq 70686。原因 = 大文件读取+解压+JSON 解析，宿主文件依赖（日志被清理/轮转即失败）。它是真实缺陷（69510/70686 重复注入）的原始反例，按规范只标 SLOW-CANDIDATE，不判 DELETE；前 4 条的合成用例已覆盖同一函数的 256-node 尾窗外去重逻辑，可作为默认通道的代理
- 风险: 分流后默认回归不再校验真实日志；若该日志不可得，本条应改为 skip 而非 fail（建议主会话确认）

---

## 跨文件重复（native-tests ↔ phase11）

> 以下 native 文件不在本包，只给建议供主会话/对应包参考。判定均基于我读过两侧源码。

| # | A（native） | B（phase11） | 重叠程度 | 建议 |
|---|---|---|---|---|
| 1 | history-recall-runtime「wrong expected source vector, missing references and caller source fabrication never clear raw recall debt」(71 ms) | unified-history-recall「wrong revision/hash, unknown/missing locator, missing seq and changed source remain durable debt」+「caller cannot supply original text, passed status…」 | 完全覆盖：stale→HISTORY_SOURCE_CAS_CONFLICT、unknown locator→debt required、missing seq→SESSION_QUERY_EVENT_NOT_FOUND、fabricated original/status→拒绝，p11 更全（还有 changed source、sourceRevision/content 注入、scope denied before query） | 保 p11；native 该条可删。唯一 p11 侧未有的断言是 `reads[locator] === undefined`，可顺手加到 p11 第 2 条 |
| 2 | history-recall-runtime「registered raw Query recall restores original bytes after two actual compactions…」(262 ms) | unified-history-recall「raw JSON byte pages, full fetched only after every page…」 | 部分重叠（分页、hash、full-fetched、幂等）；native 独有真实两次 compaction 与 replacementChain trace，p11 独有末页 complete=false、debt 状态 returned-awaiting-dispatch、locate 幂等 | 两边都保留 |
| 3 | history-recall-runtime「actual Query tool pairing…」 | unified-history-recall「tool call/result references…」 | 部分重叠（完整配对）；p11 独有「incomplete call 不可 full fetch」 | 两边都保留 |
| 4 | execution-proof-runtime「native bridge cancellation after drained shell success and physical change after execution reject proof」子用例 `source`（252 ms，真 bash） | unified-execution-proof「changes during actual execution invalidate source…」子用例 `source` | 同一 producer 检查（执行后重新采集 source 不一致即拒），触发时机差异不影响被测分支 | 保 p11；native `source` 子用例可删（约 252 ms）。native `callerCancel`/`hardAbort` 断言真实 `captureProofCancellation`/`bridge.abortTurn` 语义，p11 无，必须保留 |
| 5 | execution-proof-runtime「actual native ToolRuntime executes official bash and durable test/acceptance proof…」 | unified-execution-proof「test and acceptance proofs bind exact server recipe…」 | 同场景，断言不交叉（p11：provenance.quality、leaseRef、manifestHash 长度、parent token；native：pre/body/post 顺序、tool-effect 事件） | 两边都保留 |
| 6 | execution-proof-runtime「real zero-exit is insufficient…」 | unified-execution-proof 同名意图的 case 7（exitCode=1） | 仅 p11 一个 case 重叠；native 价值在真 checker | 两边都保留 |
| 7 | team-execution-proof「registered Team action rejects extra caller fields and foreign proof slots」(95 ms) | unified-execution-proof「caller cannot supply results, status, hashes, commands or foreign slots」 | 同错误码（EXECUTION_PROOF_INPUT_INVALID / EXECUTION_SLOT_DENIED），native 多验证经 team_v12 注册工具透传 | 保留 native（接线测试，便宜）；p11 为主断言 |
| 8 | active-identity-runtime「native pre-step: a common-only (AGENTS.md) change waits for activation, then reaches the next turn without the old common」(108 ms) | unified-active-identity「common-only identity change re-versions every role…」+「activation in the middle of a step…」 | 同场景不同层：p11 经 buildContextDelivery 覆盖 4 个 role 的 revision/redeliver/幂等；native 经真 pre-step 验证接线与已捕获消息不被改写 | 若必须二选一，p11 依赖更少、断言更直接；但 native 是唯一的真 pre-step 接线验证，建议都保留 |
| 9 | active-identity-runtime「native ToolRuntime activation and real agent pre-step consume only the approved durable role bundle」 | unified-active-identity「active bundle is durable, disk edits wait for explicit activation…」 | 同主题，层不同 | 都保留 |
| 10 | session-plan-delivery「ten-item plan with six proven stays partial although the summary claims everything is complete」(361 ms) | unified-plan-delivery「ten requirements with six proven cannot complete…」(13 ms) | partial/remainingScope 重叠；native 独有 compaction 摘要声称全完成时的 compactionDebt 与 gate | 保 p11（纯函数）；native 因 compaction 断言保留 |
| 11 | hypothesis-runtime「native repeated probes wait for durable final observations and stop before the next body」 | unified-hypothesis-runtime「changing wrapper or path does not reset…」、unified-hypothesis-memory「identity is task-level, wrapper changes…」 | 三层（真 ToolRuntime / 钩子 / 内存）同一 no-progress 预算规则 | 都保留（层不同，每条 <0.12 s） |
| 12 | context-delivery-compact-fallback / context-delivery-relevance（纯 buildContextDelivery 的 compact 与 rank） | unified-context-debt / unified-context-dispatch / v14-identity-context | 同模块不同功能（compact 形式 vs 收据/分发），无同输入重复 | 都保留 |

## 同目录内部重复（本包内）

| # | 文件 | 用例 A | 用例 B | 建议 |
|---|---|---|---|---|
| a | unified-active-identity | 「A to B to A advances the identity epoch every time」 | 「delivery revision changes on same-name activation and A to B to A」 | MERGE：保 B，把 epoch 断言并入，删 A（约 90 ms） |
| b | unified-active-identity | 「common-only edit without regenerating the manifest hash is rejected…」 | 「activation rejects full-manifest hash mismatch…」 | MERGE：并入 `AGENTS.md` 消息断言（约 60 ms） |
| c | unified-milestone-runtime | 「compactOnIdle still folds the pending milestone…」 | unified-native-summary「native summary object remains visible…」 | DELETE 前者（8 ms） |

## 节省估算
- DELETE/MERGE（本包内）≈ 0.17 s；跨 native 建议（#1、#4）≈ 0.32 s，归属 native 包。
- SLOW 通道：usage 真实日志 3.28 s + evidence-binding 过期用例 1.76 s ≈ 5.0 s；可选 evidence-binding v15（0.64 s）+ execution-proof 两大组（1.4 s）≈ 2.0 s。
- phase6/7 两个脚本合计 0.66 s，视重定向结论再定；不计入节省。
