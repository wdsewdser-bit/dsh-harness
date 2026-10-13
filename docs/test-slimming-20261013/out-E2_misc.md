# E2_misc 取舍分析（只读；轮次用尽，部分文件仅做到 import/证据级，标“未读”者一律 KEEP）

## 总览
- 33 个文件（含 1 个清单外的 team-milestone-surface-dedup，属 C2 包，仅作交叉备注）；清单内文件基线合计约 10.2 s / 约 140 条，其中 >95% 是毫秒级纯函数断言，删除不省时间。
- 建议 DELETE：0 条（没有一条满足“读过替代用例且完全覆盖”）。建议 SLOW：manifest-acceptance 第 3 条（3428ms，起 node 子进程）、compact-test-runner 第 3 条（1010ms，起 node 子进程）约 4.4 s；其余按“生产数据依赖/可选实验台”归 OPTIONAL，不省时间。
- 两个文件测的是旧 stage（architecture-clm-20261001）的插件副本而非当前 stage：team-digest-progress（794ms）、team-efficiency（750ms）。必须改指向当前 stage，否则全量回归对当前代码零保护。
- phase9/phase10 的被测插件全部仍在生产加载链内（cordis.patch.yml：team-v12-runtime、step-compaction-v4、action-fusion-v2、observation-pack-v2、evidence-reducer、team-v13-cache-monitor、team-v13-failure-memory…），phase11 没有取代它们 -> 不能整体删。
- 重要环境事实：`tools/regression-slow.json` 在仓库中尚不存在（run-regression.mjs 已支持，缺清单文件）；建议的 SLOW 条目写进该清单即可。

## 逐文件

### architecture-tests/compact-test-runner.test.mjs  (基线 tests=3 ms=1025；当前文件已有 5 条，基线落后于 HEAD 94b5bdbf)
- 判定: KEEP+TRIM（SLOW-TESTS 候选）
- 被测: tools/run-regression.mjs（发现/慢清单/生产 home 隔离）与 tools/compact-test-reporter.mjs；两者存在，且正是全量回归的入口。
- 理由/证据: 读过全文。这是回归 runner 自身的契约（退出码传播、stdout 有界、不把生产 home 传给子进程），runner 刚在 HEAD 提交里被改动，必须保留。
- 可删用例: 无
- 可入 slow 的用例: “actual runner retains noisy full logs, bounds stdout and propagates failing exit” 1010ms——两次真起 node 子进程并各跑 1200 条用例；可保留但入 SLOW（只在改 runner 时跑），或把 1200 降到约 50（断言不依赖条数，但 summary.counts.tests===1200 要同步改）。当前文件新增的 2 条（slow 分组、生产 home）同为 spawnSync，各约数百 ms，基线中无耗时，未量化。
- 风险: 入 SLOW 后 runner 回归不在日常门禁里；另外三个用例用 mkdtempSync(stage/lab-runs/...) 且不清理，D:\dsh-test\staging 下 lab-runs 里已累积大量 compact-runner-*/compact-discovery-*/offline-family-durable-* 目录（反复回归即增长）；且 worktree 里没有 lab-runs 目录（untracked），在 worktree 跑会 ENOENT——需确认。

### architecture-tests/manifest-acceptance.test.mjs  (tests=3, ms=3651)
- 判定: SLOW-TESTS（其中 1 条）
- 被测: tools/stage-closeout.mjs、tools/native-patch-audit.mjs --check、tools/plugin-coupling-audit.mjs --check（三者均存在，且 2026-10-11/12 仍有提交）。
- 理由/证据: 读过全文。断言的是“manifest 基线 == 磁盘”的验收闸门（持久化格式/授权边界），属契约，不可删。
- 可删用例: 无
- 可入 slow 的用例: “the set of staged plugins that cannot be deployed alone matches the accepted baseline” 3428ms——真起 node 子进程做全量插件耦合审计。是本包最大单项，建议入 SLOW，并改在 stage-closeout/部署前必跑。
- 风险: 日常回归不再发现耦合基线漂移，须在收尾/部署门禁补跑。

### architecture-tests/team-digest-progress.test.mjs  (tests=1, ms=794)
- 判定: KEEP+TRIM（先修目标，勿删）
- 被测: team-activity-digest.apply 的定时 followup/去重；但 import 的是 `D:/dsh-test/staging/architecture-clm-20261001/home/profiles/web/plugins/` 的旧副本。
- 理由/证据: 已核对 SHA256——旧副本 team-activity-digest.mjs（16708B，46A57F…）与当前 stage（17151B，9CCCC8…）不同，team-control-plane.mjs 亦不同（222413B vs 234385B）。即这条测的不是当前代码；且依赖已退役 stage 目录是否存在。单条脚本式，794ms 里含真实 setTimeout 等待（约 130+80+100+90ms 窗口）。
- 可删用例: 无。可能被 phase8-tests/team-activity-digest-timer.test.mjs（448ms）与 phase8-tests/team-activity-digest.test.mjs（111ms）覆盖，但我没读到它们的断言，不能提 DELETE。
- 可入 slow 的用例: 整文件含真实计时轮询（794ms），修好后可入 SLOW-FILE；目前是“假绿”。
- 风险: 修正为 `../home/profiles/web/plugins/` 后可能暴露真实失败（旧副本→新副本的行为差异）。

### architecture-tests/team-efficiency.test.mjs  (tests=1, ms=750)
- 判定: KEEP+TRIM（先修目标，勿删）
- 被测: team-control-plane / team-policy / team-tools-v2-r10 / team-query-efficiency / team-message-operation / team-v12-runtime 的查询快照与 send_message 幂等（operation_id、recovery、stale 校验）。
- 理由/证据: 读过前 120 行（共约 22KB）。同样从 architecture-clm-20261001 旧 stage 导入（第 6 行 base），不是当前代码。其断言（operation_id 幂等、reserved-before-effect 崩溃恢复、snapshotRevision CAS、跨组读拒绝）属契约/崩溃恢复。我在 native-tests、phase1-8、phase11、usage-tests 里搜 operation_id/operation_recovery/snapshotRevision/changed_since/createTaskQuerySnapshot/messageOperationBegin，命中 0 个文件 -> 没有替代覆盖。
- 可删用例: 无
- 可入 slow 的用例: 无（750ms 为单条脚本，内含真实 flush/崩溃夹具）
- 风险: 同上；这是唯一覆盖 send_message 幂等契约的测试，且当前指向旧代码，优先级最高，应先改指向当前 stage 再评估。

### architecture-tests/context-runtime-receipt.test.mjs  (tests=4, ms=210)
- 判定: KEEP
- 被测: context-workspace 的 consumption receipt 绑定（真实 LlmRuntime 适配器边界、request-message-projection 桥）。context-workspace、request-message-projection 均在 cordis.patch.yml 加载。
- 理由/证据: 仅读 import；4 条均为授权/回执边界契约，210ms。
- 可删用例: 无 / 可入 slow: 无
- 风险: 无（未逐条读）。

### architecture-tests/context-workspace.test.mjs  (tests=14, ms=719)
- 判定: KEEP
- 被测: context-workspace 插件（CAS、TTL、ACL、跨进程写入锁、fail-open/fail-closed）；cordis.patch.yml 中 mode: shadow 加载。
- 理由/证据: 仅读用例名与 import。含 “review regression” 反例与 CAS/并发语义，全部属契约。
- 可删用例: 无
- 可入 slow 的用例: “cross-process writers reload under v14 lock; exactly one wins the object CAS” 203ms（spawn 子进程 worker）——是并发/CAS 契约，不动；仅 SLOW-CANDIDATE，节省 0.2 s 不值得。
- 风险: —

### architecture-tests/request-plan.test.mjs  (tests=12, ms=232)
- 判定: KEEP
- 被测: request-message-projection 桥的 prepare/receipt/审计，及与 ledger、cache monitor、ptc-sdk-retention 的联动。
- 理由/证据: 读过 296–395 行。
  - 第 12 条 “compaction SDK policy…” 读取生产 session 日志（audit.sourceSnapshot.journal，103MB 的 `D:/dsh-test/home/sessions/--D-dsh-test-workspaces-RustMc--/session-028e6f5b-…/session.v4.jsonl.zstd`，仅读 5 个压缩帧）、以及 D:/dsh-test/docs/... 的审计/认证清单；首行 fixture 读 `D:/dsh-test/workspaces/usage-lab-20261001/fixture.json`。均存在（已核对），但属生产数据依赖。
  - 第 11 条 “ledger start/terminal and cache attribution share the exact request receipt…” 与 phase10-tests/v13.1-core “cache monitor binds a hit-rate drop…” 都调用 detectCacheAnomalies，但断言面不同（前者走真实 ledger 文件，后者是纯函数真值表），不构成完全覆盖。
- 可删用例: 无
- 可入 slow 的用例: 第 12 条（102ms，依赖生产日志）建议标记 OPTIONAL/PROD-DATA；省时可忽略。
- 风险: 生产日志被清理/轮转后该条失败，应改为 skip-if-missing。

### architecture-tests/instant-natural-lab.test.mjs  (tests=3, ms=9)
- 判定: KEEP（OPTIONAL 实验台组）
- 被测: tools/instant-natural-lab.mjs（verifyInstantNatural/observeInstantStream）；脚本存在，且被 tools/natural-ab-batch.mjs（'inst' 场景）与 tools/natural-lab-launch.mjs 调用，tools-change-manifest.json 仍登记。
- 理由/证据: 读过 import 与 grep。自检的是 oracle 校验函数，非生产行为，但实验台仍在用；9ms，删除无收益。
- 可删用例: 无 / 可入 slow: 无
- 风险: 删了会让 natural-ab-batch 的验收口径无回归保护。

### architecture-tests/lab-ptc-binding.test.mjs  (tests=3, ms=21)
- 判定: KEEP（OPTIONAL 实验台组，未读正文）
- 被测: tools/capture-lab-ptc-binding.mjs（存在；被 instant/native-compaction/team-family/unified 四个 lab 共用）与 context-workspace 的加载 schema。
- 理由/证据: 仅读 import；真实 stage 服务的 TypeScript schema 渲染，离线、21ms。
- 可删用例: 无 / 可入 slow: 无
- 风险: 共用模块，删了四个 lab 都失去绑定自检。

### architecture-tests/live-lab-runner.test.mjs  (tests=14, ms=182)
- 判定: SLOW-FILE（OPTIONAL 实验台组；不省时间，理由是生产路径写入与实验台已停用）
- 被测: tools/clm-live-session-lab.mjs（存在）。证据：该脚本除 tools-change-manifest.json 和本测试外无任何引用（natural-ab-batch/natural-lab-launch 均不调用它）；其实际运行痕迹只有 `D:\dsh-test\workspaces\clm-lab-20261001-a…g`（最后修改 2026-09-30），之后的实验台是 *-natural-lab 系列（window-large* 到 10-07）。属第一代实验台。
- 理由/证据: 读过 1–60、108–207 行。副作用：用例在生产 `D:/dsh-test/workspaces/` 下创建并删除 `clm-lab-20261001-offline-*`/`-template-*`/`-gate-*`；读生产 `D:/dsh-test/app/node_modules/@deepseek-ai/dsh-api-*-controller/lib/typert.host.js`（“installed rc2 gateway descriptor”，130ms，随 app 升级会漂）与 `D:/dsh-test/docs/architecture-review-20261001/live-lab-stage-template.json`、`D:/dsh-test/home/profiles/web/plugins/context-workspace.mjs`。
- 可删用例: 无（不满足覆盖证据）
- 可入 slow 的用例: 整文件（182ms）；最耗时是 “logical RPC adapter matches every installed rc2 gateway descriptor parameter” 130ms（读生产 app）。
- 风险: 若第一代实验台确认退役，可由负责人 DELETE-FILE（同时在 tools-change-manifest 里退役 clm-live-session-lab.mjs）；未确认前保守归 OPTIONAL。

### architecture-tests/native-compaction-natural-lab.test.mjs  (tests=8, ms=294)
- 判定: KEEP（OPTIONAL 实验台组）
- 被测: tools/native-compaction-natural-lab.mjs（存在；被 natural-ab-batch 的 s1-treat/s1-base 与 unified-natural-lab 动态 import）。
- 理由/证据: 仅读 import 与引用；纯 oracle/限额函数，唯一较慢的是 “actual three-summary/recovery canonical fixture…” 221ms（读固定 fixture 做哈希，非子进程）。
- 可删用例: 无 / 可入 slow: 221ms 那条为 SLOW-CANDIDATE（省 0.2 s，不建议）
- 风险: —

### architecture-tests/team-family-natural-lab.test.mjs  (tests=3, ms=2) 与 architecture-tests/team-family-natural-verifier.test.mjs  (tests=16, ms=169)
- 判定: KEEP；其中 verifier 的 13 个 “family verifier rejects X” 为同一 verifyFamily 的负例矩阵，可 MERGE-INTO 同文件成一条表驱动用例（仅减少日志行，不省时）。
- 被测: tools/team-family-natural-lab.mjs（存在；被 natural-ab-batch 'team' 场景与 native-tests/subagent-durable-delivery.test.mjs 引用）。
- 理由/证据: 仅读 import 与用例名；2 个文件都只 import verifyFamily/familyAdmission/familyLimits，单文件已够，二者可合并为一个文件（不删用例）。
- 可删用例: 无 / 可入 slow: 无
- 风险: 表驱动合并要保证每个负例仍独立断言。

### architecture-tests/unified-lab-host.test.mjs  (tests=9, ms=178)
- 判定: KEEP（不可降级）
- 被测: tools/prepare-unified-lab-host.mjs。该脚本被 tools/run-regression.mjs 作为 `--import` 预加载（全量回归每个测试进程都经它），也被 native-tests 多个文件使用——是回归基础设施，不是普通实验台。
- 理由/证据: 用例断言“隔离 home/禁止写生产路径”(PRODUCTION_WRITABLE_PATH)、native alias 映射，属授权边界契约。第 8 条 129ms 起 node 子进程（spawnSync）。
- 可删用例: 无
- 可入 slow 的用例: “canonical preload resolves real CJS requires to all five exact native aliases” 129ms（spawnSync），保留，SLOW-CANDIDATE 仅 0.13 s。
- 风险: 删除即失去对生产写入保护的回归。

### architecture-tests/unified-natural-lab.test.mjs  (tests=10, ms=7)
- 判定: KEEP（OPTIONAL 实验台组，未读正文）
- 被测: tools/unified-natural-lab.mjs（存在，被 4 个 lab 与 native-tests/lab-tool-admission.test.mjs 导入）+ team-v15-window-checkpoint.windowHash。
- 理由/证据: 仅读 import；7ms。
- 可删用例: 无 / 可入 slow: 无 / 风险: —

### architecture-tests/upstream-compat-contract.test.mjs  (tests=7, ms=895)
- 判定: KEEP
- 被测: 安装的 dsh-subagent 构建（app/node_modules/@deepseek-ai/dsh-subagent*）与 staged canonical 的上游补丁契约（§58/§59/§65）。
- 理由/证据: 仅读 import 与用例名；全部带 § 标记，依规默认 KEEP。
- 可删用例: 无
- 可入 slow 的用例: “§58 a failed registry rebuild is logged, and a roster-only member becomes addressable” 875ms——缺陷反例，仅标 SLOW-CANDIDATE，不判删。
- 风险: —

### phase9-tests/control-plane-recovery.test.mjs  (tests=4, ms=22)
- 判定: KEEP
- 被测: team-control-plane（Room host 替换、frozen-speaker 强制关闭审计、跨组确认）+ team-v12-contract.validateTaskContract。两模块均在加载链（team-v12-runtime、team-tools-v2-r10 导入 contract；team-control-plane 为核心）。
- 理由/证据: 读过前 60 行；崩溃恢复/授权边界契约；phase11 未取代（phase11 引用 team-control-plane 的是缺陷反例）。
- 可删用例: 无 / 可入 slow: 无 / 风险: —

### phase9-tests/v12-contract-persistence-integration.test.mjs  (tests=19, ms=8)
- 判定: KEEP（含 1 个“休眠模块”标注）
- 被测: team-v12-contract（被 team-control-plane/team-tools-v2-r10/team-v12-persistence/team-v12-runtime 导入）、team-v12-persistence（被 team-control-plane/team-v12-runtime 导入）、team-v12-integration。
- 理由/证据: 读过 import。phase11 与其它测试对 persistence/integration 的导入为 0 个文件（grep），所以没有被 phase11 取代。注意：team-v12-integration.mjs 的函数（prepareMergeOperation/verifyMergeOperation/evaluateMergePostcondition/advanceMergedTask/recoverMergeOperation）在整个仓库里除本测试和模块自身外无任何引用（grep 仅命中 web/headless 两份 integration 文件和该测试），cordis.patch.yml 里 team-health 的 requiredFiles 只检查其存在。故其中 7 条 merge 用例（“merge operation preparation… / merge postcondition… / merge crash recovery… / merge recovery does not repeat…” 等）测的是生产未调用的模块。
- 可删用例: 无（每条 0–1ms，删了也不省时；是否随 integration 模块一并退役由模块负责人决定）
- 可入 slow 的用例: 无
- 风险: 若将来 team_merge 接入该模块，这批 merge 后置条件/崩溃恢复用例即是契约。

### phase9-tests/v12-evidence-scheduler.test.mjs  (tests=9, ms=15)
- 判定: KEEP
- 被测: team-v12-evidence-scheduler（被 evidence-reducer、team-query-efficiency、team-v12-runtime、team-v14-event-continuation 导入，均加载）。
- 理由/证据: 仅 grep；phase11 有 10 个文件导入该模块，但多为缺陷反例，未读到完全覆盖证据 -> KEEP。
- 可删用例/可入 slow: 无 / 风险: —

### phase9-tests/v12-runtime-authorization-context.test.mjs  (tests=6, ms=30)
- 判定: KEEP（未读正文）
- 被测: team-v12-runtime（cordis.patch.yml 加载）、team-v12-context、team-v12-runtime-facts。授权 fail-closed 契约。
- 可删用例/可入 slow: 无 / 风险: —

### phase9-tests/v12-runtime-observability-replay.test.mjs  (tests=7, ms=13)
- 判定: KEEP（未读正文）
- 被测: team-v12-runtime-facts / team-v12-observability / team-v12-replay，三者仅被 team-v12-runtime（已加载）导入；phase11 对 observability/replay 导入为 0 个文件 -> 未被取代。
- 可删用例/可入 slow: 无 / 风险: —

### phase10-tests/action-fusion-v2.test.mjs  (tests=6, ms=297)
- 判定: KEEP
- 被测: action-fusion-v2.mjs（cordis.patch.yml id: action-fusion 加载）。
- 理由/证据: 仅 grep。164ms 与 86ms 两条疑似真起 cargo/外部命令（“fusion appends one validation block…” “a successful crate check enters the per-crate cooldown”），我没读正文，不能确认；phase11/v14-observation 仅 1 个文件导入该模块。
- 可删用例: 无
- 可入 slow 的用例: 164ms 与 86ms 两条（可能起子进程；未确认）
- 风险: —

### phase10-tests/auto-research.test.mjs  (tests=3, ms=9) 与 phase10-tests/cost-attribution.test.mjs  (tests=2, ms=2)
- 判定: KEEP（OPTIONAL：离线分析工具）
- 被测: team-v13-auto-research、team-v13-cost-attribution——插件目录内无任何插件导入它们，仅 tools/v13-auto-research.mjs、tools/v13-cost-report.mjs、tools/v13-mechanism-ab.mjs 使用，cordis.patch.yml 未加载（仅 team-health requiredFiles 检查存在）。
- 理由/证据: 离线 A/B 分析工具，不在生产路径；合计 11ms，删除无收益。
- 可删用例/可入 slow: 无 / 风险: 工具若退役可随之退役。

### phase10-tests/evidence-reducer.test.mjs  (tests=7, ms=72)
- 判定: KEEP
- 被测: evidence-reducer.mjs（cordis.patch.yml id: evidence-reducer 加载，含 enabled/路由安全）。
- 理由/证据: 读过全文。receipt 校验、本地路由限制、fail-open、设置往返均为契约；phase11 仅 v14-failure-memory/v14-observation 导入，断言不同。
- 可删用例/可入 slow: 无 / 风险: —

### phase10-tests/observation-pack-v2.test.mjs  (tests=7, ms=124)
- 判定: KEEP
- 被测: observation-pack-v2.mjs（id: observation-pack 加载）。
- 理由/证据: 读过全文。与 usage-tests/observation-pack-lineage 有局部重叠但输入不同：本文件用 `toolResult` 角色和真实 spill 目录断言“前两次发送保留、第三次替换”“损坏归档 fail-open”“符号链接拒绝”，lineage 断言行号/CRLF/会话隔离/真实 Cordis 桥。逐条未达“完全覆盖”，故不提 DELETE。
- 可删用例/可入 slow: 无 / 风险: —

### phase10-tests/v13.1-core.test.mjs  (tests=10, ms=104)
- 判定: KEEP+TRIM（候选合并，收益极小）
- 被测: 汇总冒烟 8 个 v13 模块（evidence-reducer、team-v12-compaction、mechanism-telemetry、observation-source、observation-pack-v2、failure-memory、cache-monitor、compaction-anchors），均在加载链内。
- 理由/证据: 读过全文并对照：
  - “telemetry migration backfills fired counts from historical kind histograms”（cache-hit-drop:2, skipped:1 -> fired 2）与 phase11-tests/unified-failure-telemetry.test.mjs “cache-hit-drop remains a firing kind for old telemetry migration”（cache-hit-drop:4 -> fired 4, lastFiredAt, dormantVerdict false）及 “legacy failure kinds migrate…”（含 skipped:4 -> dormant）基本覆盖，缺“skipped 与 fired 混合时 skipped 不计”这一点 -> 未满足“完全覆盖”，仅作 MERGE 候选。
  - “failure memory blocks only the same action plus failure fingerprint”与 phase11-tests/v14-failure-memory.test.mjs “audited clear removes deterministic block and permits retry” 重叠（recordFailure×3 -> block -> clearAction -> 解除），但“相同命令不同参数不阻断”“readFailureMemory().actions 为空”未被其覆盖 -> KEEP。
  - “compaction anchors…”与 phase11 v14-room-memory 的 validateCompactionAnchors 输入格式不同 -> KEEP。
- 可删用例: 无（仅 “telemetry migration backfills…” 为 MERGE 候选，0ms）
- 可入 slow: 无 / 风险: —

### usage-tests/observation-pack-lineage.test.mjs  (tests=8, ms=108)
- 判定: KEEP+TRIM（副作用与生产数据依赖需处理）
- 被测: observation-pack-v2 + request-message-projection + request-usage-ledger 的真实 Cordis 桥；usage-lab.mjs 的 validateAnswer 等（tools/usage-lab.mjs 存在）。
- 理由/证据: 读过全文。
  - 模块顶部读 `D:/dsh-test/workspaces/usage-lab-20261001/fixture.json`（存在，生产工作区数据）；`createRequire('D:/dsh-test/home/profiles/web/package.json')` 解析生产 profile 的 cordis/dsh-llm。
  - 最后一条（49ms）在 `DSH_REQUEST_STAGING!=='1'` 时会**写** `D:/dsh-test/workspaces/usage-lab-20261001/obs-line-01/runtime-integration.json`（并在 report.json 存在时再写 source-update.json）——测试写生产工作区。run-regression.mjs 没有设置 DSH_REQUEST_STAGING，需确认。
  - 文件底部还有 `runRealObservationLineage`（真实 HTTP，仅 `--real` 触发，回归不跑），读 `D:/dsh-test/home/.credentials.yaml`——应移出测试文件。
- 可删用例: 无
- 可入 slow 的用例: 最后一条 “real Cordis bridge sends current tool handle…”（49ms，依赖生产 profile + 写生产目录）归 OPTIONAL/PROD-DATA。
- 风险: 保持全部覆盖；建议先把写入重定向到 tmp。

### usage-tests/ptc-sdk-retention-real.test.mjs  (tests=2, ms=28)
- 判定: SLOW-FILE（OPTIONAL，生产数据依赖；不省时间）
- 被测: projectSdkRetention 的“golden”夹具与真实 HTTP 驱动脚本（`--real`/`--post-repair`，打 127.0.0.1:8788 中继）。
- 理由/证据: 读过全文。第 1 条 “golden fixture uses five exact frame SDKs…” 依赖 `D:/dsh-test/docs/usage-audit-20261001/system-sdk-audit.json` 里 sourceSnapshot.journal（生产 session 日志，103MB）、sdk-compatibility-manifest.json、`D:/dsh-test/workspaces/usage-lab-20261001/tools-schema.private.json`（均存在）。其“removedCopies=4、certificate.verified、历史消息身份不变”断言被 usage-tests/ptc-sdk-retention.test.mjs “explicit latest candidate removes four real historical SDK versions with version hash markers”“real changed SDK versions keep all five full historical sections”“multi-system and full tool/reasoning chain retain all unaffected message and block identities”(未读正文) 基本覆盖，唯独 `toWire` 的 reasoning_content 形态是本文件独有。第 2 条测的是一次性真实调用驱动的校验器（`validateSdkGolden`），驱动已因 ledger 存在而拒绝重跑。
- 可删用例: 无（第 1 条 wire 形态未被覆盖；第 2 条属驱动自检）
- 可入 slow 的用例: 整文件 28ms，归 OPTIONAL（生产数据依赖 + 一次性实验驱动）。
- 风险: 无时间收益，仅减少对生产日志的耦合；若生产日志轮转，两个文件同时失败。

### usage-tests/ptc-sdk-retention.test.mjs  (tests=11, ms=168)
- 判定: KEEP
- 被测: ptc-sdk-retention.mjs（id: ptc-sdk-retention，mode: apply 加载）。
- 理由/证据: 读过前 130 行。契约（apply 只剥离相同历史 SDK、证书缺失 fail-open）。注意：模块顶层 `await readFile('D:/dsh-test/workspaces/usage-lab-20261001/ptc-sdk.private.txt')`、audit 与 manifest，三条（“real changed SDK versions…”“explicit latest candidate…”“changed latest requires explicit certificate…”）读生产 session 日志；缺文件时整文件失败而非 skip。
- 可删用例: 无
- 可入 slow 的用例: 这 3 条 9–24ms，标 PROD-DATA；不省时间。
- 风险: 建议改为缺失即 skip。

### usage-tests/request-message-projection.test.mjs  (tests=13, ms=29)、usage-tests/request-usage-ledger.test.mjs  (tests=20, ms=28)、usage-tests/usage-history-backfill.test.mjs  (tests=12, ms=7)、usage-tests/usage-lab.test.mjs  (tests=10, ms=4)
- 判定: KEEP（均未读正文，仅 import/grep）
- 被测: request-message-projection.mjs、request-usage-ledger.mjs（均 cordis.patch.yml 加载）；usage-history-backfill.mjs 的持久化/迁移契约（tools/usage-history-backfill.mjs 存在，被 team-milestone-surface-dedup 与 ledger 迁移使用）；usage-lab.mjs（tools/usage-lab.mjs 存在；被 observation-pack-lineage 导入 normalizeUsage/validateAnswer/estimateInput/assertBudget）。
- 理由/证据: 合计 68ms；request-usage-ledger 的 20 条涉及 identity manifest/终态唯一性/HMR detach，属契约；usage-lab 的 10 条测的是实验驱动自身的 oracle（4ms，OPTIONAL），无时间收益。
- 可删用例/可入 slow: 无 / 风险: —

## 交叉备注（不属本包文件，但用户点名）
### usage-tests/team-milestone-surface-dedup.test.mjs  (tests=5, ms=3280；C2 包)
- 判定: SLOW-TESTS（仅最后一条）
- 被测: team-tools-v2-r10.hasCurrentMilestoneSnapshot 与 team-milestone-v2.milestoneNotice；前 4 条（0–1ms）为纯函数契约，保留。
- 可入 slow 的用例: “real root seq 69510 prevents the duplicate at seq 70686 (513 bytes)” 3278ms——硬编码读取生产日志 `D:/dsh-test/home/sessions/--D-dsh-test-workspaces-RustMc--/session-028e6f5b-1716-4c23-a232-af16d853d191/session.v4.jsonl.zstd`（103MB，文件存在），整文件解压扫描到 seq 70686 才停；这是单一缺陷（seq 69510/70686）的原始反例，不判 DELETE，只归 SLOW-CANDIDATE（生产数据依赖 + 全日志解压）。前 4 条已用合成数据覆盖同一函数的语义（256-node tail 之外仍识别、compaction 后允许重注入），仅缺“真实日志”这个事实证明。节省约 3.3 s。

## 跨文件重复
- phase10-tests/v13.1-core “telemetry migration backfills…” ↔ phase11-tests/unified-failure-telemetry “cache-hit-drop remains a firing kind…/legacy failure kinds migrate…”：保 phase11（更细），v13.1-core 那条可在确认“skipped 混合不计”不重要后并入。
- phase10-tests/v13.1-core “failure memory blocks only the same action…” ↔ phase11-tests/v14-failure-memory “audited clear…”“same action in separate sessions never cross-blocks”：部分重叠，两边都留。
- phase10-tests/v13.1-core “ObservationPack produces measured savings…” ↔ phase10-tests/observation-pack-v2 “createObservation writes a content-addressed archive…” ↔ usage-tests/observation-pack-lineage “stale verified cached handles rebuild…”：同一 createObservation/verifyArchive/projectMessages 链，三处各有独有断言（savedTokens>0、归档内容寻址、版本重建），保留。
- usage-tests/ptc-sdk-retention-real 第 1 条 ↔ usage-tests/ptc-sdk-retention “explicit latest candidate removes four…”：保后者，前者归 OPTIONAL。
- architecture-tests/request-plan 第 12 条 ↔ usage-tests/ptc-sdk-retention 同一份生产 audit/journal 夹具：加载夹具的 loadHistoricalSystems 重复实现，可抽公共 helper，不影响断言。
- architecture-tests/team-family-natural-lab ↔ team-family-natural-verifier：同一 tools/team-family-natural-lab.mjs，可合并为一个文件。

## 未读/未确认清单（均判 KEEP）
unified-natural-lab、lab-ptc-binding、native-compaction-natural-lab、team-family-*、upstream-compat-contract、context-runtime-receipt、context-workspace 正文；phase9 的 v12-evidence-scheduler/authorization-context/observability-replay 正文；phase10 的 action-fusion-v2/auto-research/cost-attribution 正文；usage 的 request-message-projection/request-usage-ledger/usage-history-backfill/usage-lab 正文。phase8 的 team-activity-digest(-timer) 与 team-digest-progress 的重复关系也未读证。
