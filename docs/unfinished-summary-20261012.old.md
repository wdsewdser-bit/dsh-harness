# 未完成事项汇总（2026-10-12）

来源：337 份归档文档的全文通读（Haiku 12 组）。统计：未完成 61、仍需保留 11、计划中 3、已实现 214、过时 48。

注意：未完成 61 份是“全文读完后，文中没有完成证据”的判定。它们在归档区 docs\old 之外（已还原到原位），需要人工逐项确认。

## 一、未完成 61 份，按原因分类

分类依据是各份“依据”一栏的关键词，属于启发式归类，逐份可能有偏差。

| 原因 | 数量 | 含义 |
|---|---:|---|
| A 还没做到（无完成记录） | 11 | 文档只有目标、基线或标题，文中没写完成，多半是还没做到那里 |
| B 做到一半或缺少验证证据 | 50 | 文中有修复或实施，但仍 open、pending、live 未验证或残差未关 |
| C 放弃或被取代 | 0 | 文中写明撤回、取代、更正或不再做 |

### A 还没做到（无完成记录）

| 文档 | 依据 | 误归档风险 |
|---|---|---|
| app-gov23.md | 条款22的行号扫描收尾步骤仅作建议，文中无落地记录 | 是 |
| app-gov36.md | 第34条的 durable 修法须并入 t54，文中 t54 仍 blocked_by t52，未见完成证据 | 是 |
| app-gov39.md | 条款 35 为规则，但含 5 条 dead 键由 lead-proto 清理的待办，文中无完成证据 | 是 |
| app-gov45.md | 门禁裁定为规则，但“修完后门禁应当 ok”的修红动作文中无完成证据 | 是 |
| backups\perf-20260927-storage-membership-generation-perf29-20260927-080237\agent-team-performance-hotfix-20260926.md | 多轮性能补丁写明需下次受控重启才生效（会话列表缓存、core包补丁），未见重启后验证 | 是 |
| commitmsg-69.txt | B-67仅记录缺陷与修法方向，文中仅有过渡期worktree快进，修法未见落地 | 是 |
| commitmsg-parking2.md | t35 升 major 为裁定但未见闭环；G3 域覆盖缺口活例仍在 | 是 |
| docs\architecture-review-20261001\full-regression-ui-fix-20261001-correct.txt | 全量回归117项中112通过5失败（SCHEMA_DRIFT与品牌守卫断言），文末无修复结论 | 是 |
| docs\context-runtime-unified-20261001\consult-final-review-20261007.md | W2 开启与权威瘦身等终审问题无回复记录；constraint-ledger.mjs 注释引用该目录 | 是 |
| docs\usage-audit-20261001\lab-plan.md | 实验在length停止、disabled续跑停在第16次；targeted阶段未记录执行与结果 | 是 |
| t57msg.txt | 记录:303仅按名字过滤的代码根因，文中无修复记录，门禁代码缺陷未闭 | 是 |

### B 做到一半或缺少验证证据

| 文档 | 依据 | 误归档风险 |
|---|---|---|
| app-gov40.md | t54 须先落地，两个红信号须在 t54 验收中复跑，尚未闭合 | 是 |
| app-gov41.md | t54 两个红信号待 t54 验收以域已测读数复跑，未闭合 | 是 |
| backups\perf-20260927-activity-digest-health-status-20260927-083054\agent-team-performance-hotfix-20260926.md | 第六至第七轮持久补丁写明待重启生效；核心 persistence 与 mailbox flush 未热加载；末节仍 PID 45532 未重启 | 是 |
| backups\perf-20260927-continuation-post-execute-20260927-081027\docs\agent-team-performance-hotfix-20260926.md | 核心包 persistence 与 session 补丁需受控重启才生效，多轮记录写明未重启 | 是 |
| backups\perf-20260927-idle-health-status-20260927-082857\agent-team-performance-hotfix-20260926.md | 核心包补丁标注待重启生效，多轮写明当前进程未加载 | 是 |
| backups\perf-20260927-reachability-cache-20260927-071555\agent-team-performance-hotfix-20260926.md | 核心包补丁须受控重启后才生效，文中自述未 live 验证；回归仍有时间敏感失败 | 是 |
| backups\perf-20260927-storage-path-categories-20260927-071833\agent-team-performance-hotfix-20260926.md | 止于第二十四轮；核心 session-query/persistence 补丁仍待下次受控启动 | 是 |
| backups\perf-20260927-wake-status-dedupe-20260927-081638\docs\agent-team-performance-hotfix-20260926.md | 多处称核心 session 列表与 persistence 补丁需下次受控重启才生效，运行态未验证 | 是 |
| backups\platform-defects-b174-o10-14-20260928-204630\ledger-before.md | 台账快照；仍列 B-33/B-36/B-37~40/B-61/B-64 为 open；B-111/B-127/B-129 待重启 | 是 |
| backups\platform-defects-batch26-20260929-064000\ledger-before.md | 台账多项仍为open/partial/live pending（B-33、B-36至B-40、A-6、B-28(i)、B-111宿主改动待重启） | 是 |
| backups\platform-defects-batch48-20260929-130200\agent-team-platform-defects-fix-ledger-20260927.md | 第四十七轮 B-182 B-183 标 live pending；B-33 至 B-40 等项仍 open；A-6 仅 partial | 是 |
| backups\platform-defects-batch61-20260929-172849\__agent-team-platform-defects-fix-ledger-20260927.md | B-33 等十项仍 open，A-6 partial，多项 live pending | 是 |
| backups\platform-defects-batch62-20260929-182859\agent-team-platform-defects-fix-ledger-20260927.md | 第五十一轮仍有 B-191 partial、B-187/B-190/B-192 live pending，A-6 残余未闭合 | 是 |
| backups\platform-defects-batch63-20260929-204620\agent-team-platform-defects-fix-ledger-20260927.md | 台账至第五十二轮仍列 live pending（B-187、B-190、B-192、D-新-3/15）、partial（A-6、B-191）与 open 项，未闭合 | 是 |
| backups\platform-defects-batch65-20260930-003432\agent-team-platform-defects-fix-ledger-20260927.md | 第五十三轮 B-193/B-195 仍为 live pending；B-191 partial；A-6 残余风险未闭合 | 是 |
| backups\platform-defects-batch66-20260930-011800\agent-team-platform-defects-fix-ledger-20260927.md | 第五十四轮仍有四项 live pending，残余风险含 A-6 partial 与多项 open 票据 | 是 |
| commitmsg-102.txt | 记录 B-72 引用扫描域问题，产品仓未改，台账仍列为残余风险 | 是 |
| commitmsg-45-47-b114.txt | 条款45–47已成文；B-114仅记录frozen成员入座与关轮不一致及期望，无修复证据 | 是 |
| commitmsg-83.txt | 记录 B-70 第二实例（重启后驱动再次消失）；回收须绑定作业生命周期，台账仍将 B-70 列为残余风险 | 是 |
| commitmsg-ack.txt | B-103对照读数非受控，文中明确未定因，结论为待受控复现 | 是 |
| commitmsg-b101b.md | 仅过渡期纪律（组长代为转达），文中无向上通道根因修复；与台账B-101是否同一未核实 | 是 |
| commitmsg-m10.txt | M11残余97/112无独立向量，文中未判收口 | 是 |
| commitmsg-m10b.txt | M10归属裁定已写；M11仅下发只读收口账卡，文中未判收口 | 是 |
| docs\agent-team-v13-sol-pi-adaptation-plan.md | R1–R12标注已完成；D2机会性压缩仅影子模式未启用；实施台账文件不在清单内 | 是 |
| docs\agent-team-v14-runtime-defect-register-20260927.md | P0-1至P1-6仅有修复方向与验收，无修复证据；仅Round2四项已修 | 是 |
| docs\architecture-review-20261001\change-summary-20261001.md | CLM apply 仅 partial 未完成二次提交；第二轮只读优化仅列建议未实施；5 个既有基线失败未修 | 是 |
| docs\architecture-review-20261001\context-workspace-validation.md | 仅离线验证；文称 live HMR 与新会话模型消费须 root 部署复核 | 是 |
| docs\architecture-review-20261001\second-pass-optimization.md | 8 项优先建议中仅第 3、8 项已实施；第 1、2 项待受控验收与真实 usage 证据，第 4 至 7 项未实施 | 是 |
| docs\context-runtime-unified-20261001\consult-window-economics-20261008.md | W2 切窗收益与剩余问题待判断，文末五项未决，大 Team B 进行中 | 是 |
| docs\platform-defects-b173-o10-13-fix-message.txt | 请求 live 复核；台账第三十轮 O-10-13 仅 partial 且 runtime_facts 仍 degraded | 是 |
| docs\platform-defects-batch106-111-correction.txt | B-207/B-210/B-213/B-213b仍live pending，B-214 partial，PID 30948未重启 | 是 |
| docs\platform-defects-batch112-122-fix-message.txt | B-207、B-210、B-213、B-213b 仍 live pending，C10 样本开放 | 是 |
| docs\platform-defects-batch148-root-result-20260930.md | 源码fixed/focused-verified但live pending；B-222与41小时queued停滞文中明确未闭合 | 是 |
| docs\platform-defects-batch170-183-root-result-20260930.md | 多项仅focused-verified且live pending；共享锁写入路径标为partial，41小时queued为未决风险 | 是 |
| docs\platform-defects-batch184-195-root-result-20260930.md | 批次184与194标注live pending；B-189仍partial，文中自述未闭合 | 是 |
| docs\platform-defects-batch206-root-result-20260930.md | 第3号仍partial待t114对照跑，第4号live pending；台账引用路径已不存在 | 是 |
| docs\platform-defects-batch209-222-root-result-20260930.md | 第4、6号仍写 live pending，PID 早于源码修改，不宣称 live 已验证 | 是 |
| docs\platform-defects-batch223-225-root-result-20260930.md | B-213c 写明 live pending，修复晚于 PID 31528 启动 | 是 |
| docs\platform-defects-batch253-271-root-result-20260930.md | B-227 至 B-232 与 B-234 仅 source fixed 且 live pending；B-233 B-235 明确 partial | 是 |
| docs\platform-defects-batch27-root-repair-note-20260929.txt | 离线回归通过；自述运行中进程是否加载新代码仍 live pending；A-6 partial | 是 |
| docs\platform-defects-batch47-root-result-20260929.md | B-182 至 B-185 修复已落盘且 focused 通过，但 live 生效待进程更新后复核，B-184 受 guard 启动时间限制 | 是 |
| docs\platform-defects-batch48-root-result-20260929.md | B-186 写明 live 行为仍需 root 按原始反例复核 | 是 |
| docs\platform-defects-batch61-fix-message.txt | B-187、B-190、B-192 三项 live pending，B-191 仍为 partial | 是 |
| docs\platform-defects-batch67-105-fix-message.txt | B-207、B-210、B-213、B-215待live验证，B-214为partial，B-209属产品线未修 | 是 |
| docs\usage-audit-20261001\lab-results.md | 实验已结束但OP证据定位失败仍未修复（Original OP failure remains），候选方案非生产 | 是 |
| docs\usage-audit-20261001\README.md | 自述完整回归未绿；Next Decisions 仅为建议未落地；live 工具仍引用该目录名 | 是 |
| docs\usage-audit-20261001\validation.md | 全量回归 561 中 2 失败；健康脚本 3 项 FAIL 未收口 | 是 |
| t27msg.txt | B-48补充：ack后wakes长度仍为1无法收口，文中未报修复 | 是 |
| t30msg.txt | 仅记B-61四试诊断；台账第五轮起B-61保持开放 | 是 |
| t39msg.txt | 文中仍有5个dead键未清，清键由lead-proto在后续t52提交内完成，尚未落地 | 是 |

## 二、仍需保留（被现行代码、脚本或回滚集引用，共 11 份）

| 文档 | 依据 |
|---|---|
| backups\perf-20260927-storage-cache-ttl-perf28-20260927-075241\agent-team-performance-hotfix-20260926.md | 记录 perf 补丁与备份路径；app/patches 中 rc.2 补丁仍在；核心补丁需重启才生效 |
| CLEANUP-mc189-rs.md | 列明有意保留的team-reports证据与tmp子目录；交接文件HANDOFF-mc189-rs.md仍在根目录 |
| docs\agent-team-performance-hotfix-20260926.md | 第1–65轮热修日志；核心包补丁写明待受控重启生效且PID 45532未重启，回滚备份与补丁哈希仍被引用 |
| docs\agent-team-v14-local-closeout-20260925.md | 含回滚备份路径与当前 profile 哈希；自述 session-2a819b5b 的 level:1 房间仍未收口 |
| docs\agent-team-v6-implementation.md | 文中回滚入口REVERT-dsh-subagent.md已不在根目录只存docs/old；.gitignore仍引用该路径 |
| docs\agent-team-v9-handoff.md | 文中启动补丁与ensure-milestone-only-compaction流程为现行接手依据，列有回滚点，压缩路径仍有效 |
| docs\context-opt-20261001\bridge-tests.txt | 桥接测试 11 项全部通过；tools/context-opt-delivery-snapshot.mjs 仍按原路径引用，移出会致交付快照缺件 |
| docs\dsh-alpha7-upgrade-handoff.md | apply-local-session-compat.cjs被package.json postinstall调用；回滚备份目录实测不存在 |
| docs\dsh-rc2-upgrade-handoff.md | 含 rc1 回滚集与备份路径；指向现行启动脚本与桌面版本门禁 |
| docs\platform-defects-final-hash-update.txt | 第五十七轮为台账之后最新指纹，台账未记录其替代者 |
| REVERT-dsh-subagent.md | 运行中 dsh-subagent 守卫的回滚集；升级 DSH 后须检查补丁是否还在 |

## 三、计划中（3 份）

| 文档 | 依据 |
|---|---|
| docs\context-runtime-unified-20261001\consult-fold-design-20261007.md | 纯设计咨询提示词，三方向仍在讨论，要求只读分析，无已定决策与实施 |
| docs\context-runtime-unified-20261001\consult-step-spans-20261008.md | 咨询待决：规则T未获同意，折叠后请求仍未过 25% 门槛，检查点 435KB 未解 |
| t36msg.txt | 裁定选B，但durable修法明确并入t54，文中未见t54已完成 |

## 四、已完成（214 份，归档区 docs\old 中）

全部列在 docs\verdict-full-read-20261012.csv，状态为“已实现”。这里只列数量，不逐条展开。过时（48 份）同样在归档区，不列入未完成。
