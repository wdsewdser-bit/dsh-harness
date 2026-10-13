# 未完成事项汇总（2026-10-12，已逐项核实）

## 修改说明（请先读）

- 原版（Haiku 按关键词归类）的“A 没做到 / B 做一半 / C 放弃”不可靠，本版已作废。2026-10-12 重新逐项核实：打开来源文档，对照执行账本 `context-runtime-unified-20261001\execution-ledger.md`、分支 `claude/project-thread-qfam5f` 上的 `docs/CURRENT_STATE.md`、平台缺陷总台账 `agent-team-platform-defects-fix-ledger-20260927.md`（79 轮，止于 2026-10-01）和相关代码/脚本。
- 原版 61 + 11 + 3 = 75 份，现在每份都有“真实状态 + 一句原因 + 证据”（见第六节附表）。原 A/B 分类保留在附表“原判”一列，仅作对照。
- 核实方式：缺陷批文档 16 份和根目录治理文档 20 份由 Haiku 子代理读原文、查台账，状态判断由我做并抽查了台账行号；架构复审、用量审计、咨询、v13/v14 计划与缺陷登记、保留 11 项我自己核对。
- 本版只改这一份文件，没有移动或修改任何其他文件，没有启动宿主、回归，没碰生产和 staging junction。原文备份在会话临时目录（不入库）。
- 局限：RustMc 产品仓不在本机，其中约 17 份“产品线”文档只能转引 `D:\dsh-test\app-status66.md`（2026-09-28 快照）和台账文字，没有重跑任何测试；凡“live”结论都只是台账自述。

## 一、状态数量变化

| 真实状态 | 文档数 | 说明 |
|---|---:|---|
| 其实已完成 | 12 | 10 份原“未完成” + 2 份原“计划中”（均已有答复并被后续实现承接）→ 并入已完成节 |
| 放弃或被取代 | 22 | 21 份原“未完成” + 1 份原“仍需保留”（`platform-defects-final-hash-update.txt`）；其中 15 份是现行台账/热修日志的旧轮次快照 |
| 仍需保留 | 10 | 原“仍需保留” 11 份中 10 份依据成立（其中 2 份依据有出入，见第五节） |
| 做一半（缺 live 验证或缺一步） | 20 | 全部来自原“未完成” |
| 没开始 | 4 | 全部来自原“未完成” |
| 不确定 | 7 | 6 份原“未完成” + `t36msg.txt`（原“计划中”）；多数是 RustMc 产品线、本机无法核实 |
| 合计 | 75 | 12 + 22 + 10 + 20 + 4 + 7 = 75 |

原“未完成 61”现为：已完成 10、被取代 21、做一半 20、没开始 4、不确定 6。真正还悬着的是 20 + 4 + 7 = 31 份文档，合并去重后是第二节的 10 条事项。

两个影响大的事实：
1. 生产宿主已停（`CLAUDE-HANDOFF-20261011.md:13`：40123/40124 无监听），平台缺陷线的“live pending”只代表“源码已落盘、从未在真实进程复核”，不是“没修”。
2. 平台缺陷线在 2026-10-01 第 79 轮后整体冻结，工作转入 context-runtime 统一项目；当前权威状态以 `CURRENT_STATE.md` 为准，其第 5.2 节另有 5 个候选（pnpm 补丁化、PTC 进生产三门槛、`unknown` 去处、两个崩溃切点测试、工具入口权限架构测试），不在本表重复。

## 二、仍然悬着的事项（合并去重，按优先级和主题）

状态词：做一半 = 源码已改但缺验证或缺一步；没开始 = 只有登记/诊断；不确定 = 本机无法核实。

### P1：建议先做

| # | 事项 | 真实状态 | 原因与证据 | 涉及文档 |
|---|---|---|---|---|
| 1 | 宿主下次受控启动后，按原始反例批量 live 复核 25 项“源码已修” | 做一半 | 台账自述 live pending，之后无关闭记录：B-182/183（台账 1382/1402）、B-186（1414-1438）、B-187/190/192（1470-1493）、B-207/210/213/213b（1616-1724）、B-221（1781）、批次 182 死信退役（1834）、D-新-3/4/5（1178-1213）、第 4 号 profile 修复（2082/2098）、第 6 号后台作业不跨 turn（2084/2098）、批次 204 -File 诊断（1994/2010）、B-227～B-232/B-234（2249-2281）。其中 B-182～B-213b 的源码修改时间早于 PID 31528 启动（2026-09-30T03:37:13Z，台账 2011），按台账判据应已被加载但没做 live 复核。一次启动可一并关闭，不必逐条各开一次 | 13 份缺陷批文档 |
| 2 | 投递停滞：41 小时 queued 停滞；旧接收者死信重试与恢复后自动续投指向旧目标 | 没开始 | 台账多处标为“独立未闭合项”（1786/1810/1859/1898），无后续关闭记录。这是缺陷里影响最实的一条（消息可能卡死） | batch148、batch170-183 |
| 3 | 从未修复且已从残余风险清单消失的老缺陷：waiting reconciler 对不可求值条件的自动解除/幽灵派生票/假理由（B-33/B-47/B-61/B-64）、等待票 id 未按票唯一（B-36）、evidence 查询/卡面证据完整性/delivery-check 角色缺口/milestone 持久化（B-37～B-40） | 没开始 | 台账 170-172、194（第五轮）标 open；此后不再被提及，第 79 轮“残余风险”节（2342-2350）也不再列。第 79 轮 B-243（2366）只做了“单一开放责任票 upsert”，不等于关闭这些条目。先要用现行代码确认是否还能复现，再决定关闭或补修 | commitmsg-ack、t30msg 等引用的同源问题 |

### P2：有价值，不紧

| # | 事项 | 真实状态 | 原因与证据 | 涉及文档 |
|---|---|---|---|---|
| 4 | 协调态共享锁写入路径（批次 180 缺陷二） | 做一半 | 台账 1835/1858/1898 一直是独立 partial | batch170-183 |
| 5 | 台账里的 partial/矛盾清点：B-214（目录前缀 scope 缺文件集合，2348）、B-233（2255）、B-235（2257）、B-191（1472/1880）、O-10-13（超时症状 live 已消失，`runtime_facts` 仍 degraded，loader 条目缺 entry hash，1065）；B-189 台账 1474 写“已由清单撤回”而 1880/1897 写 partial；B-185 在批次 47 文档（1385）与台账 1879 编号冲突 | 做一半 / 不确定 | 需要先在台账里一次性校正编号和状态，不涉及代码 | batch47、61-fix、67-105、b173-o10-13 |
| 6 | 运行态热路径二次优化：增量 token 统计（O(n²)）、停止每步线性扫 inbox、idle 同步写盘、operationId 生命周期；另有 usage 未知值待自然样本、Reducer 生产质量闸门 | 没开始（第 4–7 项）/ 做一半（第 2、8 项） | `second-pass-optimization.md` 8 项里：第 1、3 项已验收/实施，第 2、8 项半成，第 4–7 项后续文档无任何提及 | second-pass-optimization |
| 7 | RustMc 产品线（仓不在本机，只能由产品侧核实）：B-72/`:303` 引用扫描域按目录名排除（`app-status66.md:20` 仍有 753 个点开头目录被跳过；台账 2346）；G3/t35 覆盖缺口与升 major（commitmsg-parking2，仅见快照）；M10/M11 收口（commitmsg-m10/m10b，仓内找不到 t70 收口账卡结果）；B-101 第二实例（tier-2 无向上通道，台账 358 修的是别的事）；B-48 `wakes[]` 单条收口（台账 136 未提）；B-70 存活周期性复验规则（台账 2347 只部分认可）；B-67 暴露 branch 名（台账 124 只做了快进）；B-103 受控复现（台账 383 未 live）；§5.14-22 的行号扫描收尾 | 没开始 / 做一半 / 不确定 | 见各文档第六节附表；`commitmsg-102` 与 `t57msg` 是同一根因 | 约 10 份根目录文档 |

### P3：记录风险，不必主动做

| # | 事项 | 真实状态 | 原因与证据 |
|---|---|---|---|
| 8 | 回滚备份缺失：`docs\dsh-alpha7-upgrade-handoff.md` 点名的 `D:\dsh-test\backup-alpha7-20260922-201531` 实测不存在（根目录只剩 `backup-alpha7-latest.txt`），alpha7 回滚实际不可用 | 做一半（记录风险） | 目录实测不存在；该文档仍须保留，因为 `app/package.json:6` 的 postinstall 调用 `scripts/apply-local-session-compat.cjs` |
| 9 | `usage-audit-20261001\README.md` 的 Next Decisions（保留一个权威 SDK 段/按需工具文档、Team 消息去重单测等）从未被任何后续文档接手；生产 Reducer 仍 `route-blocked` | 没开始 | 仅 `context-opt-20261001\README.md` 引用该目录；`tools/usage-audit-snapshot.mjs` 仍按目录名引用，不要移动 |
| 10 | 设计边界，不再当缺陷追：A-6（插件层无法 OS 级沙箱任意子进程，台账 2344）、B-247/B-250/B-251/B-252/B-256/B-257（平台/策略/产品仓边界，台账 2392）、D-新-6 | 放弃（按设计） | 台账自己已写“partial / no platform change” |

## 三、其实已完成，移入已完成节（12 份）

| 文档 | 原判 | 依据 |
|---|---|---|
| `docs\platform-defects-batch184-195-root-result-20260930.md` | B 未闭合 | B-184（-File 修复加载，台账 2081 live verified，推断）、B-193（1875/1910）、批次 194 escalation（1876）均 live verified；B-189 是“按设计不改平台”，不属本批待修 |
| `docs\platform-defects-batch223-225-root-result-20260930.md` | B 未闭合 | 本批唯一新项 B-213c 已 live verified（台账 2148/2169）；其余项并入 batch209-222 |
| `docs\agent-team-v14-runtime-defect-register-20260927.md` | B 无修复证据 | 文末“Implementation Status (2026-09-27)”（933-957 行）P0-1～P2-7 全部 implemented。唯一没演练的是真实 provider 安全拒绝后的 live 重试，文中已自述 |
| `docs\architecture-review-20261001\context-workspace-validation.md` | B 仅离线 | `second-pass-optimization.md:5` “最终事实覆盖”：同 PID HMR + 新 PTC 会话已看到 `context_manage`；执行账本 562 行有真实自然 CLM SDK 消费证据 |
| `docs\usage-audit-20261001\lab-plan.md` | A 无 targeted 记录 | `lab-results.md` 的“Artifact binding”节记录了 targeted 阶段（`report.before-targeted.json`、`targeted-reducer-receipt.json`），10/10 聚焦测试通过 |
| `docs\usage-audit-20261001\lab-results.md` | B OP 失败未修 | 实验已结束，OP 证据定位失败是已记录的负结果，文中明确“候选方案非生产” |
| `app-gov39.md`、`t39msg.txt` | A/B 5 个 dead 键待清 | `app-status66.md:5`（2026-09-28 快照）`owned=53 … dead=0`，门禁 `GUARD_RC=0`；仅快照，产品仓未复核 |
| `app-gov41.md`、`app-gov45.md` | B/A 红信号待复跑、门禁须 ok | 同上快照 `unregistered=0`、`test result: ok. 3 passed`；`app-status66.md:32` 已采用“具名提交上 unregistered=0 且 ok”为验收谓词 |
| `docs\context-runtime-unified-20261001\consult-fold-design-20261007.md`（原计划中） | 计划中 | 已有 `-answer.md`（13.7KB）；方案后来落成多段/步折叠，隔离副本真实重跑见 `CURRENT_STATE.md:44` |
| `docs\context-runtime-unified-20261001\consult-step-spans-20261008.md`（原计划中） | 计划中 | 已有 `-answer.md`；“多段 + R”已实现并验收，规则 T 决定不启动（`CURRENT_STATE.md` 5.2.6） |

注：`app-gov*` 与 `t39msg` 属于 citation_integrity 门禁线（t52 errata / t54 durable / dead 键 / §5.14-34～36）。`docs\old\t54msg.txt` 的 task-54 是 DSH 侧另一件事，不要混淆。

## 四、被取代 / 放弃（22 份）

| 文档 | 被谁取代 | 依据 |
|---|---|---|
| `backups\perf-20260927-*\agent-team-performance-hotfix-20260926.md`（storage-membership-generation-perf29、activity-digest-health-status、continuation-post-execute、idle-health-status、reachability-cache、storage-path-categories、wake-status-dedupe，共 7 份） | 现行 `docs\agent-team-performance-hotfix-20260926.md`（65 轮） | 7 份分别停在第 23～33 轮，是旧快照；“待受控重启生效”后来已被加载（台账 PID 101020→124592→18972→30948→31528→4004→16440，≥6 次换进程），无专门 live 复核记录 |
| `backups\platform-defects-{b174-o10-14, batch26, batch48, batch61, batch62, batch63, batch65, batch66}-*\…ledger*.md`（8 份） | 现行台账（79 轮） | 快照分别停在第 30～54 轮，里面的 open/partial/live pending 都以现行台账为准（见第二节） |
| `docs\architecture-review-20261001\full-regression-ui-fix-20261001-correct.txt` | 2026-10-12 全量回归 | 它是 20KB 的节选；5 个 SCHEMA_DRIFT/品牌守卫失败是 2026-10-01 的既有基线失败，最新全量 1494 项 1493 通过 0 失败（`CURRENT_STATE.md:34`） |
| `docs\architecture-review-20261001\change-summary-20261001.md` | `context-runtime-unified-20261001\implementation-plan.md` | CLM apply 并入该计划 C-01（106 行：“已部署生产；apply / 窗口恢复未验”）；二轮优化见 second-pass；5 个基线失败已不再失败 |
| `docs\usage-audit-20261001\validation.md` | 2026-10-12 全量回归 | 561 项中 2 失败已不再失败（0 失败）；“健康脚本 3 项 FAIL”未单独复核，但随宿主停机已不可复现 |
| `docs\context-runtime-unified-20261001\consult-final-review-20261007.md` | `w2-continue-decision-20261012.md`、`strict-plan-live-test-20261012-result.md` | 已有 `-answer.md`（终审：①②有条件交付、③不交付真实 Team）；W2 保持名单模式、严格计划开关不开、权威瘦身不启动，均见 `CURRENT_STATE.md` 第 2、5.2.6 节。原汇总说“无回复记录”不成立 |
| `docs\context-runtime-unified-20261001\consult-window-economics-20261008.md` | `w2-continue-decision-20261012.md`、`w2-experiment-20261012-result.md` | 已有 `-answer.md`（继续限名单）；五项未决已由 10-11、10-12 实测和决定回答 |
| `docs\agent-team-v13-sol-pi-adaptation-plan.md` | context-runtime 的 E5 经济策略 | R1–R12 与阶段 D 影子验收已完成；D2“机会性压缩”未启用，现并入 E5，状态 off（`CURRENT_STATE.md` 第 2 节；`implementation-plan.md:56` 明确不全局自动启用） |
| `docs\platform-defects-final-hash-update.txt`（原“仍需保留”） | 台账第 58～79 轮 | 台账每轮自带输入清单指纹和四 profile SHA256（如 2315-2321），第五十七轮指纹已被后续覆盖，原文“台账未记录其替代者”不成立 |

## 五、仍需保留（10 份，逐项核实）

| 文档 | 核实结果 |
|---|---|
| `backups\perf-20260927-storage-cache-ttl-perf28-…\agent-team-performance-hotfix-20260926.md` | 保留整个备份目录作回滚集；其中这份 md 是第 26 轮旧快照，可不单独引用。依据中“app/patches 的 rc.2 补丁仍在”属实（`CURRENT_STATE.md` 5.1） |
| `CLEANUP-mc189-rs.md` | 依据成立：`HANDOFF-mc189-rs.md`（24.4K）仍在根目录 |
| `docs\agent-team-performance-hotfix-20260926.md` | 现行 65 轮热修日志；“PID 45532 未重启”已过期，此后进程换过多次，补丁已被加载（推断，见第四节） |
| `docs\agent-team-v14-local-closeout-20260925.md` | 回滚路径与 profile 哈希仍引用；“session-2a819b5b 的 level:1 房间未收口”未核实 |
| `docs\agent-team-v6-implementation.md` | 依据有出入：`REVERT-dsh-subagent.md` 实际仍在根目录，`.gitignore:18` 用 `!/REVERT-dsh-subagent.md` 白名单，不是“只存 docs/old”；结论（保留）成立 |
| `docs\agent-team-v9-handoff.md` | 依据已过期：它引用的 `patch/ensure-milestone-only-compaction.cjs` 已改名为 `.superseded-by-milestone-only-compaction`，现行是 `patch/milestone-only-compaction.cjs`。作历史回滚参考保留，不能再当“现行接手依据” |
| `docs\context-opt-20261001\bridge-tests.txt` | 依据成立：`tools/context-opt-delivery-snapshot.mjs:83` 按原路径引用 |
| `docs\dsh-alpha7-upgrade-handoff.md` | `app/package.json:6` postinstall 调用 `scripts/apply-local-session-compat.cjs`（存在）；回滚备份目录不存在（见第二节 #8） |
| `docs\dsh-rc2-upgrade-handoff.md` | 含 rc1 回滚说明，未发现冲突 |
| `REVERT-dsh-subagent.md` | 依据成立：根目录存在，`.gitignore:18` 引用，升级 DSH 后需检查补丁是否还在 |

## 六、逐文档对照附表（61 + 11 + 3 = 75 份）

原判：A = 原“还没做到”，B = 原“做一半或缺验证”，保 = 原“仍需保留”，计 = 原“计划中”。去向指第二～五节的编号或节。

### 6.1 平台缺陷批文档（`docs\`，15 份）

| 文档 | 原判 | 真实状态 | 原因与证据 | 去向 |
|---|---|---|---|---|
| platform-defects-b173-o10-13-fix-message.txt | B | 做一半 | B-173 已 live 关闭（台账 1044/1066）；O-10-13 超时症状 live 已消失（1065），`runtime_facts` degraded 仍 partial | 二 #5 |
| platform-defects-batch106-111-correction.txt | B | 做一半 | B-207/210/213/213b live pending；B-214 partial；B-215 撤回（1656/1683）；B-209 属产品线 | 二 #1、#5 |
| platform-defects-batch112-122-fix-message.txt | B | 做一半 | 同上；C10 模式 A 样本开放对应 B-216（1739/1758，产品线） | 二 #1、#7 |
| platform-defects-batch148-root-result-20260930.md | B | 做一半 | B-222 已 recovered/live observed（1836）；B-221 live pending（1781）；41 小时停滞仍 open | 二 #1、#2 |
| platform-defects-batch170-183-root-result-20260930.md | B | 做一半 | -File 入口已 live（2081，推断）；共享锁写入路径 partial（1835）；批次 182 死信退役 live pending（1834） | 二 #1、#4 |
| platform-defects-batch184-195-root-result-20260930.md | B | 其实已完成 | B-184/B-193/批次 194 均 live verified（2081/1875/1876）；B-189 台账内矛盾 | 三；二 #5 |
| platform-defects-batch206-root-result-20260930.md | B | 做一半 | 第 3 号 -File 已 live（2081/2099）；第 4 号 profile 修复、批次 204 诊断仍 live pending（2082/2098） | 二 #1 |
| platform-defects-batch209-222-root-result-20260930.md | B | 做一半 | 第 3 号已 live、第 5 号前提被否证（2083/2090）；第 4、6 号仍 live pending | 二 #1 |
| platform-defects-batch223-225-root-result-20260930.md | B | 其实已完成 | B-213c live verified（2148/2169） | 三 |
| platform-defects-batch253-271-root-result-20260930.md | B | 做一半 | B-227～B-232/B-234 live pending；B-233/B-235 partial（2249-2281） | 二 #1、#5 |
| platform-defects-batch27-root-repair-note-20260929.txt | B | 做一半 | D-新-2/7 已 live（1210/1211）；D-新-3/4 live pending；D-新-5 未标 live；D-新-6 并入 A-6 | 二 #1、#10 |
| platform-defects-batch47-root-result-20260929.md | B | 做一半 | B-182/183 live pending；B-184 已关；B-185 编号冲突 | 二 #1、#5 |
| platform-defects-batch48-root-result-20260929.md | B | 做一半 | B-186 live pending（1414-1438） | 二 #1 |
| platform-defects-batch61-fix-message.txt | B | 做一半 | B-187/190/192 live pending；B-191 partial；B-189 矛盾 | 二 #1、#5 |
| platform-defects-batch67-105-fix-message.txt | B | 做一半 | B-207/210/213/213b live pending；B-214 partial；B-215 撤回；B-209 产品线 | 二 #1、#5 |

### 6.2 备份快照（15 份）

全部为“被取代”，被谁取代与依据见第四节前两行，原判：perf 7 份（1 份 A、6 份 B）、ledger-before 8 份（B）。

### 6.3 架构复审、用量审计、咨询、v13/v14（12 份）

| 文档 | 原判 | 真实状态 | 去向 |
|---|---|---|---|
| architecture-review\full-regression-ui-fix-20261001-correct.txt | A | 被取代 | 四 |
| architecture-review\change-summary-20261001.md | B | 被取代 | 四 |
| architecture-review\context-workspace-validation.md | B | 其实已完成 | 三 |
| architecture-review\second-pass-optimization.md | B | 做一半（第 4–7 项没开始） | 二 #6 |
| usage-audit\lab-plan.md | A | 其实已完成 | 三 |
| usage-audit\lab-results.md | B | 其实已完成 | 三 |
| usage-audit\validation.md | B | 被取代 | 四 |
| usage-audit\README.md | B | 没开始 | 二 #9 |
| context-runtime-unified\consult-final-review-20261007.md | A | 被取代 | 四 |
| context-runtime-unified\consult-window-economics-20261008.md | B | 被取代 | 四 |
| agent-team-v13-sol-pi-adaptation-plan.md | B | 被取代 | 四 |
| agent-team-v14-runtime-defect-register-20260927.md | B | 其实已完成 | 三 |

### 6.4 根目录治理与提交说明（`D:\dsh-test\`，20 份，含 1 份原“计划中”）

| 文档 | 原判 | 真实状态 | 原因与证据 | 去向 |
|---|---|---|---|---|
| app-gov23.md | A | 做一半 | 条款 22 的①标注“原引”已做（`app-gov39.md:3`），②行号位移后扫 docs 作为固定收尾无记录 | 二 #7 |
| app-gov36.md | A | 不确定 | 门禁快照 ok（`app-status66.md:5`），“被标注引文豁免”的 durable 机制未核 | 本节 |
| app-gov39.md | A | 其实已完成（快照级） | `app-status66.md:5` dead=0 | 三 |
| app-gov40.md | B | 不确定（偏已完成） | 同 36；“t54 先落地、PATH 键去列号”未在 DSH 侧核 | 本节 |
| app-gov41.md | B | 其实已完成（快照级） | 三条完整形态读数已采用 | 三 |
| app-gov45.md | A | 其实已完成（规则已成文并被采用） | `app-status66.md:32` | 三 |
| commitmsg-69.txt | A | 做一半 | B-67 快进修法已做（台账 124），③暴露 branch 名无记录；编号与台账 124 是否同一条待确认 | 二 #7 |
| commitmsg-102.txt | B | 没开始 | B-72 台账 210/2346 仅登记残余风险，修在产品仓 | 二 #7 |
| commitmsg-45-47-b114.txt | B | 不确定 | 回归有 B-114 用例（`context-opt-20261001\regression.txt:179`），提交所述 live 现象未见复验 | 本节 |
| commitmsg-83.txt | B | 做一半 | B-70 台账 173/2347 部分认可，周期性复验规则无落地 | 二 #7 |
| commitmsg-ack.txt | B | 做一半 | B-103 台账 360 focused fixed、383 未 live，无受控复现 | 二 #7 |
| commitmsg-b101b.md | B | 没开始 | 台账 358 的 B-101 修的是回执状态，不是向上通道 | 二 #7 |
| commitmsg-m10.txt | B | 不确定 | 仓内找不到 t70 收口账卡结果 | 二 #7 |
| commitmsg-m10b.txt | B | 不确定 | M10 “待命”裁定无后续；M11 同上 | 二 #7 |
| commitmsg-parking2.md | A | 做一半 | 裁定已写，t35 升 major 与 G3 覆盖缺口无闭环 | 二 #7 |
| t27msg.txt | B | 不确定 | 台账 136 B-48 标 fixed，但补充指出的 `wakes[]` 单条收口无记录 | 二 #7 |
| t30msg.txt | B | 做一半 | B-61 诊断完成，修复未见（台账 170/194） | 二 #3 |
| t36msg.txt | 计 | 不确定（偏已完成） | 同 app-gov36，t52 选 B 已成文，durable 修法并入 t54 未核 | 本节 |
| t39msg.txt | B | 其实已完成（快照级） | 同 app-gov39 | 三 |
| t57msg.txt | A | 没开始 | `:303` 只按名字过滤，`app-status66.md:20` 仍在跳目录 | 二 #7 |

### 6.5 仍需保留（11 份）与计划中（3 份）

见第五节（保留 10 + 被取代 1）和第三节（计划中 3：fold-design、step-spans 已完成；t36msg 见 6.4）。

## 七、已完成

原 214 份（归档区 `docs\old`，全部在 `docs\verdict-full-read-20261012.csv`，状态“已实现”）不变，另新增第三节 12 份，合计 226 份。过时 48 份不变。
