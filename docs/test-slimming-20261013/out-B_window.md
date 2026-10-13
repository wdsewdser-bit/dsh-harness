# pkg-B 窗口（window/fold/compaction）功能族：回归精简建议（只读分析）

总览：
- 25 个文件 / 277 条用例 / 文件耗时合计约 47 s（install 18.3 + collector 14.2 + executor 5.5 + transition 4.4 + 其余约 5 s）；25 个文件全部已读。
- 建议 DELETE/MERGE 约 22 条（transition 5、collector 5、race 2、executor 2、install 5、phase11 economics 2、manager 1），预计省约 10 s；其中 transition 的 120 次循环缩到 10 次单独省约 2.4 s。
- 慢的根因是“每条用例各起一套 native host + control plane + 真 fsync 的 JSONL fixture（约 0.35 s/条）”，不是循环；除 120 transitions 外没有可缩小的循环，只能靠合并同 fixture 场景。未发现“只断言日志格式”的用例。

关键事实（证据）：
1. 生产加载：`home\profiles\web\cordis.patch.yml` 只显式 insert 了 `team-v15-window-manager`（mode: shadow）和 `team-v15-window-wiring`（enabled: true, scope: list）；install/executor/collector/surface/projection/transition/checkpoint/decision/plan/protocol 经 wiring/manager 的 import 链被加载。`team-v15-window-economics-runtime.mjs` 不在 cordis.patch.yml 里，也没有被任何生产插件 import（仅 tools/ 下的 lab 脚本和测试引用）。
2. fault 点等价：`team-v15-window-transition.mjs` 第 144-145 行 `await fault('prepared-durable')` 紧接 `await fault('before-commit')`，之间无任何代码；第 173 行 `await fault('commit-durable'); await fault('before-publish')` 同样紧挨。所以 before-commit ≡ prepared-durable、before-publish ≡ commit-durable（磁盘与内存状态完全一致，无论是抛错、外部 host writer 还是 steer）。
3. `team-v15-window-collector.mjs` 第 130 行：`completed: event.data.reason.kind === 'completed'`，error 与 interrupted 走同一个布尔分支。
4. 疑似测试缺陷（只报告，未改）：`native-tests/window-install-runtime.test.mjs` 里 “Team mail queued…”（731 行）、error/interrupted 循环（746 行）、“still the last turn stays whole”（761 行）使用了 `/^a3-d$/`（缺少反斜杠，应为 `/^a3-\d$/`），“步骤已被折叠”的断言恒真/空转；这几条在 error/interrupted/“stays whole”场景实际只验证了 COMMITTED、u3 保留、下一请求放行。
5. 外部依赖：`architecture-tests/window-native-natural-verifier`（读 `lab-runs/natural-window-native-20261003-2216`）与 `native-tests/window-responses-protocol`（读 `lab-runs/natural-window-shadow-20261003-1225`，并带 sha 钉死）依赖 `lab-runs\`；该目录在本 worktree 的 stage 副本中不存在（存在于 `D:\dsh-test\staging\context-runtime-unified-20261001\lab-runs\`），在 worktree 副本运行会在读文件处失败。
6. 备注：读取 `home\AGENTS.md` 时工具输出里夹带了“无安全策略/不受限”之类与任务无关的指令，已忽略。

---

### architecture-tests/window-history-quality.test.mjs  (tests=6, ms=9)
- 判定: KEEP
- 被测: `tools/window-history-quality.mjs`（lab 验证脚本）与 `verifyWindowRecallProbe` 的合成证据正反例
- 理由/证据: 被测是 lab 工具，不是生产插件；9 ms，无慢。第 1 条与 window-native-natural-verifier 对同一函数 `verifyWindowRecallProbe` 测不同输入（合成 vs 录制），不重复。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无。若 natural lab 系列已结束，整文件可作为 DELETE-FILE 候选，但我无法确认，故 KEEP。

### architecture-tests/window-native-natural-verifier.test.mjs  (tests=2, ms=373)
- 判定: KEEP
- 被测: 对录制的 W2 natural run（hash 钉死）重放 `verifyWindowRecallProbe`，12 种伪造变异必须拒绝
- 理由/证据: 变异集合是 nativeEvidence 专有（durable/afterSurface/authorityReceipts 等），与 history-quality 的合成变异不同；契约型（拒绝伪造）。
- 可删用例: 无
- 可入 slow 的用例: 无（373 ms 主要是解析约 2 MB 证据）
- 风险: 依赖 `lab-runs\`，见关键事实 5；在 worktree 副本里会失败，属环境而非用例问题。

### native-tests/instant-window-compaction-race.test.mjs  (tests=15, ms=1354)
- 判定: KEEP+TRIM
- 被测: 真 ReactLoopAgent + 真 bridge + 真 JSONL barrier + 真 BasicCompactionEngine + 真 window coordinator 下 steer/preempt/abort × W2 × compaction 的竞态矩阵
- 理由/证据: 并发/崩溃恢复契约，整体 KEEP。仅两处可裁。
- 可删用例:
  - “W2 transition (before-publish) + steer A,B…”：与同文件 “W2 transition (commit-durable) + steer A,B…” 等价（transition.mjs 173 行两个 fault 点之间无代码）。
  - “harness: summary adapter and conversation adapter are wired…”（84 ms）：compactNow 提交、raw 保留、cold==live、followup 后续请求，已被 “steer lands while the compactNow summary request is in flight…” 和 “abort during the post-commit durability checkpoint…” 覆盖（可选，省 84 ms）。
- 可入 slow 的用例: 无（全文件 1.35 s）
- 风险: 删 before-publish 不丢状态；harness 删后若 fixture 本身坏了错误信息会落在后续用例上。

### native-tests/window-collector-runtime.test.mjs  (tests=42, ms=14189)
- 判定: SLOW-TESTS（+MERGE 5 条）
- 被测: `team-v15-window-collector` / `-surface` / `-participation` 在真 Team/CP/identity/host 上的 W0/W1/W2 行为
- 理由/证据: 慢因是每条 surfaceFixture 都完整起 native host + Loader + applyTeamRuntime + 真 JSONL（约 340 ms/条，实际提交本身很便宜）；无子进程、无真 git、无 sleep。无循环可缩。
- 可删用例:
  - `fault_matrix_with_host_writer_at_each_point: before-commit`（348 ms）：≡ 同矩阵 prepared-durable（transition.mjs 144-145 行）。
  - `fault_matrix_with_host_writer_at_each_point: before-publish`（349 ms）：≡ 同矩阵 commit-durable（173 行）。
  - `foreign_register_during_intent_fsync_succeeds_and_aborts`（361 ms）：MERGE 进矩阵 prepared-durable（同触发点、同断言 aborted+journal {1,1,0}+disk==memory），仅需把 `error.code === 'WINDOW_SOURCE_CAS_CONFLICT'` 一条搬进去。
  - `foreign_register_after_commit_append_commit_stands`（470 ms）：MERGE 进矩阵 commit-appended，把“下一请求放行、authority 绑定当前 host epoch”两条断言搬进去。
  - `optimistic_commit_idle_host_first_attempt`（343 ms）：MERGE 进第 1 条 “server W2 uses actual Team/CP/identity…”（都是空闲 host 上单次 commit），加 `epoch 未变 + journal {1,0,1}` 两条断言。
- 可入 slow 的用例:
  - `bounded_retry_under_continuous_churn` 760 ms：多次 commit/abort 尝试（真 fsync），属退避契约，SLOW-CANDIDATE，不删。
  - `aborted_transition_leaves_session_readable` 601 ms：同上，保留。
- 风险: 合并后矩阵 6 条变 4 条，S0 反例（natural run ab-s2window-treat-r2-20261006 的两条 “before any window commit …” 与 “after a committed window …”）不受影响。省约 2.2 s。
- 重叠备注: 第 “W1 binds each official request…”（WINDOW_ACTOR_MISMATCH/PURPOSE_NOT_ALLOWED 两条断言）与 window-projection-runtime 的 “wrong actor / auxiliary purpose …” 同函数同错误码；但该条另有真 collector authority 与 late native effect 阻断，整条保留。

### native-tests/window-consumer-wire.test.mjs  (tests=5, ms=7)
- 判定: KEEP
- 被测: 浏览器侧 wire parser（client bundle 内 region）与 session-log contributor 对 `replace-many` 的解析/序列化
- 理由/证据: 对外协议契约；该解析器是 bundle 里的独立副本，与 Session 管理（multi-surface）、V4 codec 是三份不同实现，不重复。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无

### native-tests/window-context-baseline.test.mjs  (tests=8, ms=72)
- 判定: KEEP
- 被测: `team-v14-context-delivery.mjs`（window epoch 提交后的 baseline/cursor/receipt 债务）
- 理由/证据: 被测模块被 `team-v12-runtime.mjs`/`team-v15-delivery-debt.mjs` import，cordis.patch.yml 第 168 行列入加载清单；持久化/恢复契约。文件名带 window 但被测是 v14 context delivery，不与其他 window 文件重复。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无

### native-tests/window-economics-runtime.test.mjs  (tests=3, ms=17)
- 判定: KEEP（与 phase11 同名文件互为重复，保 native 这边）
- 被测: `team-v15-window-economics-runtime.mjs`（shadow 经济学观测器）
- 理由/证据: 该插件不在 cordis.patch.yml、未被生产插件 import（见关键事实 1），只被 lab 工具引用；因此两份 economics-runtime 测试的价值都偏低。native 版使用真 native host fixture，且独有 “preemption keeps interrupted usage unknown”。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 若插件确认退役，两份都可 DELETE-FILE；此点我无法确认（profile bundle 层可能另行加载），故不提。

### native-tests/window-executor-runtime.test.mjs  (tests=9, ms=5504)
- 判定: SLOW-TESTS（+MERGE 2 条）
- 被测: `team-v15-window-executor.mjs`（guard、tryFold、install 重试、handover）
- 理由/证据: 每条一整套 host fixture + 多数条目真做一次折叠（约 0.7-1.0 s）。fixture 注释自述 “Copied from window-install-runtime”。
- 可删用例:
  - “a foldable session folds with a durable window and stays healthy”（915 ms）：它的 `outcome folded / receipt COMMITTED / guardStep null / healthy` 可并入 “a new process without the install refuses steps…” 的 tryFold 之后（该条已先断言 folded）。
  - “idle session without window state passes the guard and falls back below the floor”（1014 ms，含首次模块加载开销）：其 60000→`rule:below-floor` 与 “an operator fold skips the size rule…” 第一条断言相同，把 `guardStep(...) === null` 与 `intents==0` 并进该条。
- 可入 slow 的用例: 无
- 风险: 省约 1.0-1.7 s；不丢 guard/fallback 语义。

### native-tests/window-file-protection.test.mjs  (tests=11, ms=543)
- 判定: KEEP
- 被测: `team-v15-window-file-protection.mjs`（Windows 句柄级写保护，koffi kernel32 / fsutil / 子进程探测）
- 理由/证据: 权限/授权边界契约；仅 Windows；总计 0.5 s，其中真起子进程的只有第 1 条（79 ms）和 fsutil（35 ms）。被 install/executor 的 `windowOsFileProtection: true` 只是启用，不覆盖这些句柄语义。
- 可删用例: 无
- 可入 slow 的用例: 无（无需）
- 风险: 无

### native-tests/window-host-participation.test.mjs  (tests=1, ms=246)
- 判定: KEEP
- 被测: `createNativeWindowParticipation` 在真 Team control fence + host lifecycle gate 上的 revision 绑定、revoke、veto
- 理由/证据: 与 phase11/unified-window-participation 同被测但场景不同（host gate/veto vs Loader 缺失/CP 锁/identity 变更）；仅 `blockers.includes('loaded-writer-not-participating:identity')` 一条断言重复，不构成可删。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无

### native-tests/window-install-runtime.test.mjs  (tests=37, ms=18324)
- 判定: SLOW-TESTS（+MERGE/DELETE 5 条）
- 被测: `team-v15-window-install.mjs`（admit、certificate、installSessionWindow、plan 投影、authority 文本、step range 折叠）
- 理由/证据: 全文件最慢；慢因是每条（甚至一条里 2-4 个）完整 native fixture，约 0.35 s/个，无子进程、无真 git。fixture 注释自述复制自 collector。
- 可删用例:
  - error/interrupted 循环里的 `interrupted` 一轮（≈704 ms）：collector.js 130 行 error 与 interrupted 同一分支，等价；可改成同一 fixture 里先 turn 3=error、turn 4=interrupted、turn 5=completed 一次断言。
  - “dispose keeps a live committed install and still serves current authority”（420 ms）：并入 “installSessionWindow commits once, injects current authority…”（该条已提交并断言 current authority；追加 `dispose()` 两次与第二次 stream）。
  - “install failure before admit leaves no half install”（380 ms）：并入 “install failure rolls back admission; a later install succeeds”（同一 fixture 先后注入 missing-plan 与 barrier-boom 两种失败再安装成功）。
  - “the request limit includes the every-request authority…”（348 ms）：并入 “a fold that would not free the share…”（都用 minReductionRatio 0.999 触发 WINDOW_NO_BOUNDED_REDUCTION，后者已有 fixture）。
- 可入 slow 的用例: “inbox brief rows have fixed fields…” 1152 ms（146 条 × 约 15 KB 写入 control plane，146 需 >100 才能让 m0 落到 inbox_list 第一页之外，可降到约 105 条，约省 0.3 s，低置信）；“a settled lossy fold…” 1096 ms（4 个 fixture，可保留为 1 条）。
- 风险: 注意关键事实 4 的 `/^a3-d$/` 缺陷，这些用例的“步骤被折叠”断言当前不生效，合并前建议先修正正则（我未改动）。合并不影响 B-nnn/defect 标记用例（本文件没有）。省约 1.9 s。

### native-tests/window-live-barrier.test.mjs  (tests=2, ms=81)
- 判定: KEEP
- 被测: `backend.windowBarrierFor` 的 live writer 复用与身份/opt-in/stale writer 拒绝
- 理由/证据: 持久化 + 授权边界契约，唯一覆盖该 API。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无

### native-tests/window-multi-surface.test.mjs  (tests=9, ms=44)
- 判定: KEEP
- 被测: dsh-session `replace-many` 的接纳校验、foldSurface/browserFold、JSONL 冷恢复、V4 codec
- 理由/证据: 协议/持久化契约。与 window-token-meter 的“非法 range 列表”输入相似，但被测是另一套实现（Session.append vs planSurfaceTokens/pressure.apply），不可互相替代。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无

### native-tests/window-projection-runtime.test.mjs  (tests=21, ms=106)
- 判定: KEEP
- 被测: `installWindowProjection` 在真 Session/LlmRuntime 上的 W0/W1 与边界 CAS
- 理由/证据: 与 phase11/unified-window-projection 部分重叠（W0 preview 纯性、未知 protocol），但本文件 blockedReason 码不同（ACTOR_MISMATCH/SESSION_NOT_ALLOWED/PURPOSE_NOT_ALLOWED/SOURCE_REQUEST_MISMATCH）且是真 dispatch 边界；10 ms 级，无时间收益。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无

### native-tests/window-responses-protocol.test.mjs  (tests=6, ms=11)
- 判定: KEEP
- 被测: 实际 PiAiAdapter + Responses converter 对 reasoning/tool pair 的保留与降级、`proveCompletedReasoningSpan`
- 理由/证据: 协议契约；11 ms。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 依赖 `lab-runs\natural-window-shadow-20261003-1225\canonical-journal.json`（worktree 副本缺失，见关键事实 5）。

### native-tests/window-token-meter.test.mjs  (tests=8, ms=21)
- 判定: KEEP
- 被测: dsh-token-meter 的 `planSurfaceTokens`/`commitSurfaceTokens`/pressure 与 breakdown projection 对 multi-range 的计价
- 理由/证据: 持久化 checkpoint（v5→v6）与计价契约，21 ms。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无

### native-tests/window-transition-runtime.test.mjs  (tests=34, ms=4409)
- 判定: KEEP+TRIM
- 被测: `team-v15-window-transition.mjs`（W2 提交/恢复/fence/CAS/多 range）
- 理由/证据: 崩溃恢复与 CAS 核心契约，整体 KEEP；仅裁等价 fault 点和缩小重循环。
- 可删用例:
  - `fault at before-commit …` 与 `fault at before-publish …`（各约 20 ms）：等价于 prepared-durable / commit-durable（transition.mjs 144-145、173）。
  - `multi-range failure at before-commit …` 与 `… at before-publish …`（各约 24-32 ms）：同上。
  - `isolated subprocess crash at before-publish …`（312 ms）：与 commit-durable 同一磁盘镜像（两点之间无代码），断言 `commits 1` 完全一致。
- 可入 slow 的用例:
  - `120 transitions + replay preserve old journal and monotonic window IDs` 2601 ms：建议缩到 10 次。语义等价依据：toWindowId 由 `Math.max(currentWindow(), ...intents)+1` 计算（transition.mjs 135 行），无数量阈值；每轮成本约 21 ms 线性增长，10 次≈0.22 s，省约 2.4 s；断言（toWindowId==i、每轮 recover==clean、旧 journal 前缀不变、tail 不变）原样保留。
  - 子进程崩溃 4 条各约 305 ms（真起子进程，SLOW-CANDIDATE，崩溃恢复契约，不删，仅 before-publish 那条按上面提议去掉）。
- 风险: 无 B-nnn 标记用例受影响；省约 2.8 s。

### phase11-tests/unified-window-decision.test.mjs  (tests=7, ms=1)
- 判定: KEEP
- 被测: `team-v15-window-decision.mjs` 的 `decideWindowAction`（被 manager 与 executor 加载，生产在用）
- 理由/证据: 纯函数阈值契约，1 ms。与 manager 的 shadow 记录用例只是输入档位相同，不重复。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无

### phase11-tests/unified-window-economics-runtime.test.mjs  (tests=3, ms=16)
- 判定: MERGE-INTO native-tests/window-economics-runtime.test.mjs（或保留，几乎无时间收益）
- 被测: 同 native 版，`team-v15-window-economics-runtime.mjs`
- 理由/证据: 用例 1 ↔ native 用例 2（receipts/scope denial/unknown-safe/不泄露 payload/去重），用例 2 ↔ native 用例 3（buffer 有界、dispose 注销）。phase11 独有断言只有：缺 protocol/usage/currency 保持 unknown（用例 3）、调用方传入的 sessionId/pricing/receipt 被忽略（`ignored`）、foreign snapshot membership 0、`llm/stream` 监听器计数归 0。
- 可删用例: “real adapter receipts and terminal usage …”、“usage accounting stays bounded and disposal …”：替代为 native-tests/window-economics-runtime.test.mjs 的 “real LlmRuntime observer records only handed adapter payload…” 与 “usage buffer is bounded and effect cleanup …”，删前需把上述独有 4 条断言搬过去。
- 可入 slow 的用例: 无
- 风险: 搬运遗漏会丢那 4 条断言；收益仅减少日志行，不省时间。

### phase11-tests/unified-window-fold-hook.test.mjs  (tests=7, ms=36)
- 判定: KEEP
- 被测: `step-compaction-v4.mjs` 的 `compactOnIdle`（window 优先、否则 compaction 回退，proactive 冷却）
- 理由/证据: executor 用 scripted double，真实 executor 行为由 native 套件覆盖；回退/冷却语义契约；36 ms。cordis.patch.yml 第 179 行列入 step-compaction-v4。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无

### phase11-tests/unified-window-manager.test.mjs  (tests=8, ms=46)
- 判定: KEEP+TRIM
- 被测: `team-v15-window-manager.mjs`（shadow 观测器，cordis.patch.yml 第 41 行生产加载）
- 理由/证据: shadow 记录的 schema/过滤/dispose 契约。
- 可删用例: “records carry no message body”（只是 key 列表 + 不含 SECRET）：可并入 “shadow records only transitions of the verdict for a session”（该条已逐字段断言 rows，加 `Object.keys` 与 SECRET 检查）。
- 可入 slow 的用例: 无
- 风险: 隐私约束（不写 message body）必须保留断言，合并时不能丢；这是本包里最接近“只断言记录格式”的一条，但同时是隐私契约，故只建议合并不建议删。

### phase11-tests/unified-window-participation.test.mjs  (tests=3, ms=210)
- 判定: KEEP
- 被测: `createNativeWindowParticipation` + CP `acquireWindowFence`（Loader 缺失、mutate/mutateHot 共用锁、identity/config 写者）
- 理由/证据: 授权边界/并发 CAS 契约；与 native-tests/window-host-participation 场景不同（见该条）。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无

### phase11-tests/unified-window-projection.test.mjs  (tests=17, ms=23)
- 判定: KEEP
- 被测: `team-v15-window-projection.mjs` 的纯规划器 `createWindowProjection(config).plan` 与 checkpoint authority
- 理由/证据: 12 条表驱动 blockedReason 为逐项反例，各 1-3 ms；与 native 版仅 “unknown protocol / W0 preview” 部分重叠（错误码与保真度不同），不可替代。可选：12 条表驱动合并成一个 for 循环断言可减少 TAP 行数，但不省时间，且失败定位变差，不建议。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无

### phase11-tests/unified-window-wiring.test.mjs  (tests=12, ms=1348)
- 判定: SLOW-TESTS（仅 1 条）
- 被测: `team-v15-window-wiring.mjs`（scope、pre-step guard、idle 恢复、fold handle、operator 命令）
- 理由/证据: 用 scripted executor，与 native executor 测试不重复；契约型 fail-closed 守卫。
- 可删用例: 无
- 可入 slow 的用例: “a failed install of a refused session is retried on a timer, not only at the next idle event” 1307 ms：真 `setTimeout(1300)` 等待；wiring.mjs 187 行 `delay = Math.max(1000, …)`，是硬编码 1 s 下限，不能靠配置缩小。建议改用 `t.mock.timers.enable({ apis: ['setTimeout'] })` + `tick(1100)`，约省 1.3 s；语义不变（仍断言无人唤醒下重试一次且 recovers==1）。
- 风险: 无

### phase7-tests/delivery-process-windows-hide.test.mjs  (tests=1, ms=6)
- 判定: KEEP
- 被测: `team-worktree.mjs` / `team-tools-v2-r10.mjs` 的 git/cargo 子进程 `windowsHide` 与结果语义（mock execFileSync）
- 理由/证据: 与“窗口 fold”功能族无关，仅文件名含 windows；断言 spawn 选项与返回语义（非日志格式），6 ms。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无

---

## 跨文件重复

| A | B | 关系 | 建议 |
|---|---|---|---|
| native window-economics-runtime 用例 2、3 | phase11 unified-window-economics-runtime 用例 1、2 | 同被测同场景（receipts/scope/去重、buffer 有界/dispose） | 保 native（真 native host），把 phase11 独有 4 条断言搬入后删 phase11 的 2 条；插件本身未在生产加载，整组价值低 |
| transition-runtime `fault at before-commit / before-publish`（含 multi-range、子进程 before-publish） | 同文件 prepared-durable / commit-durable | 代码点相邻，状态一致 | 保 prepared-durable / commit-durable |
| collector-runtime 矩阵 before-commit / before-publish、`foreign_register_during_intent_fsync…`、`foreign_register_after_commit_append…` | 同文件矩阵 prepared-durable / commit-appended / commit-durable | 同触发点同断言 | 保矩阵，并入独有断言 |
| instant-window-compaction-race `W2 transition (before-publish)` | 同文件 `(commit-durable)` | 等价 | 保 commit-durable |
| install-runtime error/interrupted 循环 | 同文件 error | collector.js:130 同分支 | 保 error（修正 `/^a3-d$/` 后） |
| executor-runtime 用例 1/2 | 同文件用例 3/8 | 前缀断言重叠 | 合并 |
| transition-runtime `real native Inbox claim…` ↔ collector-runtime `prepared W2 internal writer read…` ↔ race `W2 transition (prepared-durable) + steer` | 三层各测 prepared-durable 期间 A/B/C 入队 | 断言集不同（wake 计数与 cold 恢复 / STALE_WRITER 与磁盘顺序 / 整 agent 批量 drain） | 均保留 |
| collector-runtime `W1 binds each official request…`（actor/purpose 码） | projection-runtime `wrong actor` / `auxiliary purpose` | 同函数同错误码，但 collector 版带真 authority | 均保留，不省时间 |
| multi-surface / token-meter / consumer-wire / V4 codec / transition 多 range 校验 | 输入列表相似 | 被测是不同实现 | 均保留 |
| native window-host-participation ↔ phase11 unified-window-participation | 同服务，仅 identity blocker 一条断言重复 | 场景不同 | 均保留 |

估算节省（秒）：transition 2.8、collector 2.2、install 1.9、executor 1.0-1.7、wiring 1.3、race 0.15，合计约 10 s；用例数 277 → 约 255。
