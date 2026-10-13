# E1 包：phase11 v14-* 系列 + session-list-cache 精简分析（只读）

## 总览
- 29 个文件全部读过（v14-identity-context 不在本包）；该包基线合计约 12.4 s / 约 170 条，其中 90% 的耗时集中在 v14-storage(4.7s)、runtime-bridge(1.6s)、acceptance-verifier(1.6s)、failure-memory(1.4s)、startup-arming(0.9s)、bounded-wake(0.8s)、global-task-completion(0.76s)、continuation(0.5s)。
- 建议 DELETE：0 条（本包没有任何一条被另一文件完整覆盖；多处相似但被测函数/输入不同）。MERGE（仅代码整理，不省时间）：约 3 处。SLOW-TESTS/缩规模：5 项，预计节省约 2.3-2.9 s（storage 锁更新 ~0.7s、inventory 3×550ms 等待 ~1.0-1.4s、bounded-wake ~0.4s、git fixture 合并调用 ~0.25s）。
- v14-session-list-cache 与 session-list-cache **不重复**（被测模块不同）；v14-profile-parity 与 v14-identity-context 的“byte-identical”断言**不重复**。
- 重要发现：v14-acceptance-verifier、v14-bounded-wake、v14-usage-cache 用绝对路径 `D:/dsh-test/home/profiles/web/plugins/...` 导入，测的是**仓库根**插件而非 stage 内插件（实测 `team-tools-v2-r10.mjs` 根与 stage 的 SHA256 不同，`team-policy.mjs` 相同）。精简时请知晓这三个文件并不验证 stage 代码。
- 实测（我在 scratchpad 跑探针，未改仓库）：locked update 4x25=1305ms，4x10=613ms，2x10=303ms；7 次 git=277ms，3 次=158ms。

---

### phase11-tests/session-list-cache.test.mjs  (tests=2, ms=129)
- 判定: KEEP
- 被测: `team-runtime-guard.mjs` 的 `createSessionListCache`（包装 service.listSessions，磁盘快照 + 后台 revalidate + dispose 还原）。team-runtime-guard 在 cordis.patch.yml 中 id=team-runtime-guard（第 468 行）已加载。
- 理由/证据: 与 v14-session-list-cache 被测模块不同（后者测 `app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl` 的 `JsonlSessionPersistence.listArtifacts` 及 `invalidateArtifactListCache`）。两层缓存各自契约（插件层“磁盘快照先返回、后台再拉”，后端层“并发合并 + 本地写失效”）互不覆盖。
- 可删用例: 无
- 可入 slow 的用例: 无（84ms/45ms，含 20ms 假延迟与 40ms 等待，可忽略）
- 风险: 无

### phase11-tests/v14-session-list-cache.test.mjs  (tests=2, ms=86)
- 判定: KEEP
- 被测: JSONL persistence backend 的 `listArtifacts` 并发合并缓存与 `invalidateArtifactListCache`。
- 理由/证据: 见上，不重复。两条用例共用 backendWithProbe，可写成同文件内参数化，但仅省几十行，不省时间（26ms+60ms）。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无

### phase11-tests/v14-profile-parity.test.mjs  (tests=1, ms=7)
- 判定: KEEP
- 被测: `team-health.mjs` 的 `inspectProfileParity`（合成 3 个 profile 目录，healthy / drift → disabled）。
- 理由/证据: 与 v14-identity-context.test.mjs 的 “web and headless identity modules stay byte-identical”（直接 readFileSync 比较真实的 web/headless `team-v14-identity.mjs`）不同：前者测检查器函数的 fail-closed 逻辑，后者测真实文件一致。全仓库 grep `inspectProfileParity` 仅此一处测试；grep 测试名含 parity/byte-identical/headless 的仅这 2 条 + phase8 的 room-snapshot-v2-headless（测 headless 函数行为，不是字节比较）。无重复。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 删了就没人测 parity 检查器本身。

### phase11-tests/v14-storage.test.mjs  (tests=21, ms=4699)
- 判定: KEEP+TRIM + SLOW-TESTS
- 被测: `team-v14-durable-store.mjs`（锁/修订/崩溃恢复）、`team-control-plane.mjs`（cold 历史、迁移、GC、inventory/reachability 缓存、审计轮转、延迟 checkpoint）、`team-v14-identity.mjs`。
- 理由/证据: 绝大多数是持久化格式/并发/崩溃恢复契约，保留。可缩规模项如下（语义不变）：
  1. **L53-72 “separate processes preserve 100 locked updates”（1327ms）**：4 进程 × 25 次。语义是“多进程跨锁无丢更新、revision 连续”，进程数 4 才制造竞争，次数不是关键。建议把 L60 的 `i<25` 改为 `i<10`（总 40 次），L68-69 改 `count===40`、`revision===40`。实测 4x10≈613ms，省约 0.7s。不要减进程数（2 进程竞争变弱）。
  2. **L14 `waitForStorageCacheRefresh = 550ms`，在 L299/L305/L309 共 3 次（用例 1705ms）**：被测常量 `STORAGE_CACHE_REFRESH_MS = 500`（team-control-plane.mjs L104，不可注入）。三处等待是为了让 TTL（500ms）过期后重扫目录。建议改为轮询：`for(≤1000ms, 每 25ms) 直到 cp.health().coldFiles === 期望值`。断言的最终值不变，且仍能发现“永不刷新”的回归。预计省 1.0-1.4s。**不确定点**：signature 为目录 mtimeNs/ctimeNs，NTFS 目录时间戳可能延迟更新，轮询上限给 1000ms 比 550ms 更安全；若出现间歇失败就回退。
  3. L143 “60 MB synthetic history benchmark” 已默认 skip（环境变量 DSH_V14_HEAVY_BENCH），0ms，无需处理。
  4. L97-141 “cold history is content-addressed…”（215ms）内含 20 次 hot mutate + `console.log` 基准 JSON（L139）。该 console.log 是日志噪声，可删掉那行（不影响断言），elapsedMs 变量也可同时去掉。
  5. L498-520 “audit rotation…”（79ms）20 次 mutate，auditMaxBytes=220；可降到 10 次（只要超 220 字节轮转一次即可），省 <40ms，收益太小，不建议。
- 可删用例: 无
- 可入 slow 的用例: “separate processes preserve 100 locked updates”（1327ms，4 个子进程）；“storage inventory cache follows directory membership and audit size changes”（1705ms，3×550ms 睡眠）。若不缩规模就整体入 slow。
- 风险: 缩规模后仍保留 4 进程竞争；轮询改写只要 coldFiles 的期望值保持就不丢契约。L74-95 两条 identity 用例（0ms）与 v14-identity-context 的 resolveIdentity 用例有同函数不同输入，不重复（storage 里测“shared fallback/嵌套 membership/未解析 session 隔离”，identity-context 测“throwing 代理/稳定 fallback id/纯字段”），保留。

### phase11-tests/v14-runtime-bridge.test.mjs  (tests=31, ms=1634)
- 判定: KEEP（可选代码层合并）
- 被测: `team-v12-runtime.mjs`（已在 cordis 加载，id=team-v12-runtime）的 registered hooks / team_v12 tool / pre-step 上下文交付 / 授权函数。
- 理由/证据: 所有用例单条 ≤209ms，总时间由每条 harness（apply + 控制面）约 40-60ms 的固定成本构成，没有“同一函数、近似参数多次重复”的用例。4 条 tier-1 `req1` 种子相同的用例（L552 manifest dedupe、L579 durable receipt、L614 post-compaction baseline、L793 “new requirement is delivered without a new Room message”）每条断言点不同，可抽 `seedReq1(h,text)` 辅助函数去重代码，但不省时间。
- 可删用例: 无。（L793 “new requirement is delivered…” 43ms 只断言 `includes('req1')`，与 L552 的 `first.messages` 同一输入近似；若要合并，应把该 assert 加入 L552 后删之，约省 43ms。我没有逐字验证 L552 的消息体一定包含 'req1' 文本，不确定，故仅列为可选 MERGE。）
- 可入 slow 的用例: 无（最大 209ms “actual registered delivery preview…”，是长链路契约场景，不要拆）。
- 风险: 契约/授权/CAS 类（`task_contract_set rejects a stale revision…`、`authorizeRequirementRecord`、`authorizeWaitingAction`）均须保留。

### phase11-tests/v14-continuation.test.mjs  (tests=16, ms=514)
- 判定: KEEP
- 被测: `team-v14-event-continuation.mjs`（已加载，id=team-v14-event-continuation）的 continuationCandidates/Attempt/SLA 与 post-execute、idle hook。
- 理由/证据: 前 8 条纯函数 0-6ms；后 8 条带 controlPlane 的集成用例（43-93ms）各自对应不同路径（正常、legacy root、plan approve、summary 重试、target-missing、崩溃 uncertain、慢邮箱、单次失败恢复）。其中“summary 重试”(L310) 与“continuation recovers from one delivery failure”(L436) 都是“首次 send 抛错、二次 hook 成功”，但被测记录不同（`v14Continuation.summaries` vs `wakeEpisodes`），不能互相替代。L38 “successful terminal dependency only”（buildReadyQueue/taskStatus）与 v14-scheduler 的 buildReadyQueue 用例输入、断言不同，不重复。
- 可删用例: 无
- 可入 slow 的用例: 无（最大 93ms）
- 风险: 这些均为崩溃恢复/幂等契约。8 条集成用例的脚手架（root/members/teams/ctx/cp.mutate）重复，可抽 helper，仅减 LOC。

### phase11-tests/v14-startup-arming.test.mjs  (tests=9, ms=913)
- 判定: KEEP
- 被测: `team-idle-watch-v6.mjs`（已加载，id=team-idle-watch）、`team-v14-event-continuation.mjs`、`team-activity-digest.mjs`（不是独立插件 id，由 team-tools-v2-r10 导入并通过 cordis 的 team-health sharedPluginFiles 列表出现；随 tool-agent-team-v2 加载）、`team-armed-roots.mjs`。
- 理由/证据: 5 条 idle-watch 用例的 fixture + host + applyIdleWatch 装配 100% 相同（L109-366），仅 options（retryAfterMs）与种子任务差异，断言各为不同行为（restored stopped 忽略 / 周期扫描恢复 / reload 不重复 / retry 窗口 / operator-owned）。可抽 `startIdleWatch(f, opts)` 辅助函数，不能参数化成一条。时间 60-130ms 每条，来源是 sleep(30..50)+checkpoint，缩 sleep 到 20 可省约 0.1-0.15s，收益小且有时序风险，不建议。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: L463 “switching roots…” 与 v14-armed-roots 的 2 条同属 focusRoot/markBackgroundWake 语义，但前者走 applyIdleWatch 集成，后者是 0ms 纯函数单测，层次不同，两边保留。

### phase11-tests/v14-armed-roots.test.mjs  (tests=2, ms=1)
- 判定: KEEP
- 被测: `team-armed-roots.mjs` 的 focusRoot/isArmed/disarmRoot/markBackgroundWake/consumeBackgroundWake。
- 理由/证据: 纯函数 0ms，与 startup-arming L463 互补，无时间收益。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无

### phase11-tests/v14-failure-memory.test.mjs  (tests=11, ms=1358)
- 判定: KEEP+TRIM
- 被测: `team-v13-failure-memory.mjs`（cordis id=failure-memory）、`team-v13-mechanism-telemetry.mjs`、`team-v13-compaction-shadow.mjs`、`evidence-reducer.mjs` 设置读写。
- 理由/证据: L27/L63/L77/L195 都是“3 次 recordFailure + shouldBlockAction”的近似输入，但断言分别是跨 session 隔离、audited clear、fingerprint clear 的 count/threshold、窗口过期，各有独立契约，不可合并。L40 “transient and provider failures…” 是同一 exec 的两段 classify，内部已是循环。唯一重的是 **L161-193 “telemetry, debt and settings merge across concurrent processes”（930ms）**：2 个子进程 × (20 telemetry 事件 + 1 次 evaluateTimeline + 20 次 writeReducerSettings)。建议循环从 20 降为 8（L170、L173，并把 L185-187/L191 的 40 改为 16）。语义（两进程交错写同一文件无丢失）不变，预计省约 0.4-0.5s。
- 可删用例: 无
- 可入 slow 的用例: “telemetry, debt and settings merge across concurrent processes” 930ms，起 2 个 node 子进程 + 真文件锁并发。
- 风险: 并发合并契约保留；不减进程数。

### phase11-tests/v14-acceptance-verifier.test.mjs  (tests=1, ms=1637)
- 判定: SLOW-FILE
- 被测: `team-tools-v2-r10.mjs` 的 `team_acceptance_packet`（group-acceptance → verifier wake 合并 → final-acceptance 需 verifier-review）。
- 理由/证据: 脚本式（单条，进程 import 后 assert）；真起 git 7 次（测试自身 init/config×2/add/commit/rev-parse/branch，实测约 280ms），被测工具再通过 `team-worktree.mjs` 的 `execFileSync('git')` 校验 commit/branch，所以不能 mock。耗时无法由睡眠解释，属真 git 子进程。注意：导入路径是 `D:/dsh-test/home/profiles/web/plugins/`（仓库根），不是 stage。
- 可删用例: 无
- 可入 slow 的用例: 整文件（1637ms，真 git）。可选缩减：fixture 用 `git init -q -b main` + `git -c user.email=... -c user.name=... commit --allow-empty -m base` + `git branch grp/group-a`，实测 7→3 次约省 120ms；若工具需要 base.txt 内容则不要这么改（不确定，未读工具内部实现）。
- 风险: 它是 verifier-review-required 的授权边界契约，必须保留。

### phase11-tests/v14-bounded-wake.test.mjs  (tests=1, ms=835)
- 判定: KEEP+TRIM（SLOW-CANDIDATE）
- 被测: `team-tools-v2-r10.mjs` 的 send_message 有界 wake（队列返回 <1500ms、后台 ack）及 `team_room_timeout_recover`（wake-host / replace-host / force-close）。
- 理由/证据: 单条脚本式测试，含 9 个 check。耗时来自：mailbox 假延迟 250ms（L73）+ 固定 sleep 350ms（L158）。可把 L158 改为轮询“episode.status==='delivered'”（每 20ms，上限 1500ms），并把 L73 的 250ms 降为 120ms（仍需大于 wakeAckWaitMs=40 才能保持“queued 先返回”的语义）。预计省 0.35-0.45s。L53 的 `steerPrompt` 5s 定时器从不被 await（断言 steerPromptCalls===0），无影响。注意：导入路径为仓库根 `D:/dsh-test/...`。
- 可删用例: 无
- 可入 slow 的用例: 无（整体 835ms，睡眠/轮询）
- 风险: 保持 wakeAckWaitMs < mailbox 延迟，否则“queued/coalesced/distinct”语义失效。

### phase11-tests/v14-global-task-completion.test.mjs  (tests=9, ms=756)
- 判定: KEEP
- 被测: `team-tools-v2-r10.mjs` 的 team_task_update complete / team_task_get / team_task_create 与 HMR 重装。
- 理由/证据: L137/L147/L156 三条用同一 harness+seedGlobalTask+complete，仅 actor/domainStatus 不同（tier0 / owner / 已完成域任务），可写成 3 行表驱动，但不省时间（71-100ms）。**B-166（L167）323ms**：真起 git 6 次（init/config×2/add/commit/rev-parse）只为取一个非空 commit_sha；属原始缺陷反例，只标 SLOW-CANDIDATE：可用 `git init` + `git -c user.* commit --allow-empty` + `rev-parse` 3 次，约省 120-150ms，但我未读 repoRoot 校验是否要求 base.txt 内容（不确定），不自行判定。D-新-7、D-新-4 同样为缺陷反例，KEEP。
- 可删用例: 无
- 可入 slow 的用例: B-166 complete accepts frozen args with a non-null commit_sha（323ms，真 git）——SLOW-CANDIDATE，不删。
- 风险: S0 反例 B-166 / D-新-7 / D-新-4 不得动。

### phase11-tests/v14-room-memory.test.mjs  (tests=12, ms=12)
- 判定: KEEP
- 被测: `team-v12-room-wake.mjs`、`team-v14-requirements.mjs`、`team-v14-memory-anchor.mjs`、`team-v13-compaction-anchors.mjs`。
- 理由/证据: 合计 12ms，无节省空间。L34 与 L167 都调用 `migrateLegacyRoomState`，但输入与断言（messages/summaries/decisions vs 访问权限/resolved 状态/round facts）不同；L194/L206 都测 `advanceRoomCursor requireInjection`，场景（回执缺失 vs latest-first 批次缺口）不同。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无

### phase11-tests/v14-scheduler.test.mjs  (tests=9, ms=5)
- 判定: KEEP
- 被测: `team-v12-evidence-scheduler.mjs` buildReadyQueue、`team-idle-watch-v6.mjs` 房间超时函数、`team-tools-v2-r10.mjs` 的 activeDispatchBlockers/deadLetterRows/reconcileSourceRequirement。
- 理由/证据: 全部 0ms 纯函数；L63/L85/L102 三个 room timeout 用例各自不同函数（timedOutRoomSpeakers / roomTimeoutAttempt / timedOutRoomClosures+roomCloseAttempt）。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无

### phase11-tests/v14-waiting.test.mjs  (tests=9, ms=5)
- 判定: KEEP
- 被测: `team-v14-waiting.mjs`（在 cordis team-health sharedPluginFiles 列表中）、`continuationCandidates`。
- 理由/证据: 0-2ms。L86 “approval waits auto-close after plan-approved” 与 v14-continuation L271 “plan approval reconciles its wait…” 都断言 `resolution === 'auto:plan-approved'`，但前者是纯函数 + reconcile 计数、后者是 hook 集成同扫描唤醒，层次不同，保留。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无

### phase11-tests/v14-panel.test.mjs  (tests=7, ms=61)
- 判定: KEEP（含 3 条源码文本断言，标注）
- 被测: `team-v14-panel.mjs` buildTeamPanelOverview/projectPanelRooms、`team-operator-v5.mjs` readPanelJsonCached、client.js 组件（vm 渲染）。
- 理由/证据: L58、L67 以及 L54-55 通过 `assert.match(源码文本)` 断言 operator 源文件内容，属“只断言源码文本”，脆弱但 0-1ms，没有节省价值；是否删属用户风格判断，我不建议在“省时间”目标下动。L102 panel JSON cache 与 v14-tool-doc-cache 的 `readTeamJsonCached` 是**两份独立拷贝**的实现（`team-operator-v5.mjs` 的 panelDocCache 与 `team-tools-v2-r10.mjs` 的 teamDocCache，实现逐行相同），各自需要一条测试，不是重复覆盖。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无

### phase11-tests/v14-tool-doc-cache.test.mjs  (tests=1, ms=3)
- 判定: KEEP（可选 MERGE-INTO v14-panel.test.mjs 的表驱动 cache 用例，仅整理）
- 被测: `readTeamJsonCached`（team-tools-v2-r10.mjs）。
- 理由/证据: 见 v14-panel；web/desktop/teamtest 目录下还有其他拷贝，但测试只导入 web 根拷贝。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无

### phase11-tests/v14-usage-cache.test.mjs  (tests=1, ms=11)
- 判定: KEEP
- 被测: `team-usage.mjs` 的 usage 缓存 256 条上限（`usageCacheStats`）。
- 理由/证据: 300→256 的有界性，与 v14-telemetry-session-lru（telemetry sessions）、v14-cache-monitor-lru（cache anomaly）是三个不同模块的同类 LRU 契约，不可互替。导入路径是仓库根 `D:/dsh-test/home/profiles/web/plugins/team-usage.mjs`，非 stage。我未核对 team-usage.mjs 是否被 cordis 加载（cordis 里有 team-usage-projection 插件，不确定其是否导入 team-usage）。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 若 team-usage.mjs 实际未被生产加载，则此用例可能是候选 DELETE，需要另行核对后再提；本包未证实。

### phase11-tests/v14-telemetry-session-lru.test.mjs  (tests=1, ms=18)
- 判定: KEEP
- 被测: `team-v13-mechanism-telemetry.mjs` normalizeTelemetryState / createTelemetry.skipped 的 256 session 上限。
- 理由/证据: 见 usage-cache；该模块在 cordis 加载（mechanism telemetry 目录配置出现多处）。
- 可删用例: 无 | 可入 slow: 无 | 风险: 无

### phase11-tests/v14-cache-monitor-lru.test.mjs  (tests=1, ms=0)
- 判定: KEEP
- 被测: `team-v13-cache-monitor.mjs`（cordis id=cache-prefix）的 rememberCacheAnomaly LRU。
- 理由/证据: 0ms，无收益。
- 可删用例: 无 | 可入 slow: 无 | 风险: 无

### phase11-tests/v14-provider-safety.test.mjs  (tests=4, ms=54)
- 判定: KEEP
- 被测: `team-runtime-guard.mjs` classifyProviderFailure；control plane providerFailure/providerSafety；idle-watch/activity-digest 的 suppressForControlPlane；operator panelHealth。
- 理由/证据: L197 与 L239 都是“优先 healthStatus，缺失回退 legacy health()”，但分别是 idle-watch+digest 与 panelHealth 三个不同函数。可合成一条表驱动，不省时间。
- 可删用例: 无 | 可入 slow: 无 | 风险: 无

### phase11-tests/v14-reconcile-fastpath.test.mjs  (tests=2, ms=48)
- 判定: KEEP
- 被测: control plane `reconcileDispatches` 只读性、`reconcileHasWork`。
- 理由/证据: 并发/修订契约，47ms 来自 mutate+flush，无节省空间。L298 同函数 3 个近似输入（active/due/queued）为边界表，已在同一条内，无需处理。
- 可删用例: 无 | 可入 slow: 无 | 风险: 无

### phase11-tests/v14-observation.test.mjs  (tests=3, ms=63)
- 判定: KEEP
- 被测: observation-pack-v2 createObservation/projectMessages、evidence-reducer buildBoundedInput、action-fusion-v2 acquireWorkspaceLock。
- 理由/证据: 58ms 为 acquireWorkspaceLock 的有界等待（40ms 超时）；可降到 20ms 省约 20ms，不值。
- 可删用例: 无 | 可入 slow: 无 | 风险: 无

### phase11-tests/v14-live-observation-lazy.test.mjs  (tests=7, ms=10)
- 判定: KEEP
- 被测: team-runtime-guard createLazyLiveEvents / createLiveObservationLazy / createTailBackedEvents。
- 理由/证据: 合计 10ms；L137（tail-backed events 页操作）与 L153（cold bridge）测同一 tail reader 的不同入口，保留。
- 可删用例: 无 | 可入 slow: 无 | 风险: 无

### phase11-tests/v14-policy-cache.test.mjs  (tests=3, ms=12)
- 判定: KEEP
- 被测: team-policy.mjs policyFor LRU(16) / refreshBoards 复用与增量克隆。
- 理由/证据: 合计 12ms，无节省。
- 可删用例: 无 | 可入 slow: 无 | 风险: 无

### phase11-tests/v14-member-route.test.mjs  (tests=1, ms=56)
- 判定: KEEP
- 被测: control plane memberRouteSet/memberRoute 持久化与重启。
- 理由/证据: 持久化格式契约。
- 可删用例: 无 | 可入 slow: 无 | 风险: 无

### phase11-tests/v14-room-seat.test.mjs  (tests=3, ms=17)
- 判定: KEEP
- 被测: roomSeatVerdict、roomClose forceClose/waive。
- 理由/证据: 含 `B-`/force-close 类缺陷反例（task:g-boot-wake-3），合计 17ms。
- 可删用例: 无 | 可入 slow: 无 | 风险: 无

### phase11-tests/v14-wake-claim-atomic.test.mjs  (tests=1, ms=55)
- 判定: KEEP
- 被测: control plane wakeClaim 原子性与审计类型。
- 理由/证据: 原子/CAS 契约。
- 可删用例: 无 | 可入 slow: 无 | 风险: 无

### phase11-tests/v14-write-scope.test.mjs  (tests=4, ms=20)
- 判定: KEEP
- 被测: write-scope-guard 的 fs/write-intent 与 run_code 风险。
- 理由/证据: 权限边界契约；D-新-3 是原始缺陷反例。L44/L58/L135 三条 “doesNotThrow + throws FS_WRITE_OUT_OF_SCOPE” 的脚手架重复（不同 scope 配置），可抽 helper，不省时间。
- 可删用例: 无 | 可入 slow: 无 | 风险: 无

---

## 跨文件重复
- 无可 DELETE 的跨文件重复。已核对并排除的“疑似重复”：
  - session-list-cache.test.mjs ↔ v14-session-list-cache.test.mjs：被测模块不同（插件 `createSessionListCache` vs 后端 `listArtifacts`），两边都保留。
  - v14-profile-parity ↔ v14-identity-context 的“web and headless byte-identical”：前者测检查器函数、后者测真实文件，两边保留。
  - v14-tool-doc-cache ↔ v14-panel “panel JSON cache”：被测是两份独立拷贝的实现，各保留；可在同文件内表驱动合并（仅整理）。
  - v14-armed-roots ↔ v14-startup-arming L463：单元 vs 集成，保留两者（armed-roots 0ms）。
  - v14-waiting L86 ↔ v14-continuation L271：纯函数 vs hook 集成，保留两者。
  - v14-storage identity 两条 ↔ v14-identity-context（本包外）：同 resolveIdentity 不同输入，未发现完全覆盖，保留。
- 精简建议汇总（按收益）：storage inventory 轮询替代 3×550ms（~1.0-1.4s）；storage 100→40 次锁更新（~0.7s）；failure-memory 并发进程 20→8 次（~0.4-0.5s）；bounded-wake 轮询 + mailbox 120ms（~0.4s）；acceptance-verifier/B-166 git 调用 7/6→3（~0.12s+0.12s，需先确认工具不依赖 base.txt）。
