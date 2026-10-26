# 02 · 文档与功能/决策盘点（DSH 二次开发）

> 只读盘点，产出于 2026-10-26。范围：`docs/` 全量 481 个文件（含 `docs/old/`）+ `home/profiles/*/cordis.patch.yml` 抽查。
> 判定口径：**现役** = 在 `home/profiles/web/cordis.patch.yml` 里挂载且 enabled；**半成品** = 代码在盘、已实现部分能力，但默认 shadow/off/未挂载；**已废弃** = 文档明确否决或代码已不在盘。
> 凡未能直接验证的都标 **未证实**。

---

## 0. 结论先行

1. **"文档说的" 与 "线上跑的" 已经系统性分叉，且分叉方向是保守的**：最典型的是上下文压缩——文档反复强调 "milestone-only、20 万以下不折叠"（`agent-team-v9-handoff.md` §3、`agent-team-v14-runtime-defect-register-20260927.md` P2-4），但线上 `compaction-basic` 是 **`auto: true` + `thresholdRatio 0.75`**，与 `step-compaction-v4` 的 `minMilestoneFoldTokens: 200000` 同时存在。**当前真实策略是 "压力兜底 + milestone 优先" 的双路，不是纯 milestone-only。**
2. **Window 栈（W1/W2/W3）不是"没做完"，是"通不了电"**：真实回放里 projection handoff / fold / economicApplied 全是 **0**（`handoff-20261025-window-auto-and-cleanup.md` 验证表），根因是 usage 侧缺 cache-write 计量 → 经济层判成 unknown；再叠加 5s TTL 证据过期、price/quality/horizon 硬编码。所以 W1 只敢开 1 个 session 的 `scope: list`，W2 是 `shadow`，W3 默认关。
3. **大量"已实现"功能其实没挂载**：`team-v15-ptc-background.mjs`、`team-v15-plan-delivery.mjs`、`session-plan-delivery.mjs`、`team-v15-window-executor.mjs` 文件在盘但 `cordis.patch.yml` 里无条目；`team-v16-capabilities-runtime` 挂了但 `sdkCoreProjection: false`。**任何"已上线"的说法都必须限定到 web profile。**
4. **web 与 headless 的"必须同构"规则已经破了**：web 有 144 个 id、headless 只有 29 个，行数 1474 vs 341。这既是运维风险，也是文档里"两个 profile 配置必须一致"那条纪律失效的直接证据。
5. **文档自身的分类表不可信**：`doc-classification-20261012.csv` 567 行里 **306 行指向已不存在的文件**，261 行需要加 `old/` 前缀才对得上，且**完全没有收录 `CURRENT_STATE.md`**。真正可当权威锚点的只有三处：`CURRENT_STATE.md` 顶部、`handoff-20261025-window-auto-and-cleanup.md`、`context-runtime-unified-20261001/execution-ledger.md` 的尾部条目。

---

## 1. 功能清单

### 1.1 Team 调度与治理

| 功能 | 做什么 | 状态 | 权威文档 |
|---|---|---|---|
| Tier 分层团队（tier0 root / tier1 lead / tier2 member）| 三层指挥链，配额 8 lead / 每组 8 / 活跃 30，另有 500 原生 roster 兜底 | 现役（`team-policy`: 8/1/8/30） | `agent-team-v5-full-plan.md`（目标架构）→ `agent-team-v12-architecture-improvement-plan.md`（改进项） |
| 任务/合同/需求/决策/租约/阶段 控制面 | 所有调度状态落控制面，不靠 prompt 自律 | 现役（`team-v12-runtime`） | `agent-team-v12-architecture-improvement-plan.md` §A–§M |
| `team_v12` 聚合工具 | 把大量控制面操作收敛成一个工具入口 | 现役 | `agent-team-v14-ptc-prompt-contract.md` |
| write-scope guard | 成员只能写自己 scope 内文件，越界拦截 | 现役 | `agent-team-platform-defects-fix-ledger-20260927.md` P0-A 系列 |
| exact-SHA merge + clearance | 合并要求精确 SHA + 清关，防"合的不是验的" | 现役 | 同上 + `agent-team-v5-full-plan.md` §worktree/merge |
| worktree 隔离 | 成员在独立 worktree 干活 | 现役 | `agent-team-v5-full-plan.md` |
| dispatch 生命周期 / run lease | 派发有状态机、有租约，防重复派发 | 现役（`team-v14-event-continuation` scanMs 30000） | `agent-team-v14-runtime-defect-register-20260927.md` |
| Wait 票据（`waiting_set/resolve/list`） | 阻塞诉求登记，可查询可解决 | 现役 | `agent-team-v14-ptc-prompt-contract.md` |
| 配额与冻结 | 冻结成员不计入配额 | 现役 | `agent-team-v10-handoff.md` |
| 权限由控制面强制（不靠 prompt） | 权限判定下沉到控制面 | 现役（设计原则） | `agent-team-v12-architecture-improvement-plan.md` |
| `team-runtime-guard` | 运行期守卫 | 现役 | `home/profiles/web/cordis.patch.yml` |
| `team-operator-v5` | 操作员通道 | 现役 | 同上 |
| `team-usage-projection` | 用量投影 | **已废弃/停用**（`disabled`） | 同上 |
| Team 全局快照 | `/team meta` 快照用于灾难恢复 | 现役（曾用它从 76 个快照里救回 10.8MB 被清零文件） | `agent-team-v10-handoff.md` |

### 1.2 Room 协作房间

| 功能 | 做什么 | 状态 | 权威文档 |
|---|---|---|---|
| 多轮房间（上限 3 轮） | 结构化多代理讨论，轮数封顶 | 现役（`team-policy.maxRoomRounds: 3`） | `agent-team-v5-full-plan.md` §Durable Room |
| 发言权交接 `waitAction`（speak/close/stop） | 明确的交棒协议 | 现役 | `agent-team-v14-ptc-prompt-contract.md` |
| Room Snapshot v2 | 语义 `snapshotId`、`latestClosedRound`、`recentMessages`、注入闸门 | 现役 | `agent-team-v9-handoff.md` |
| 父轮依赖 | 子轮挂在父轮下，防乱序 | 现役 | `agent-team-v14-runtime-defect-register-20260927.md` |
| seat 规则 `roomSeatVerdict` | 判断某成员能不能坐这个房间 | 现役（修过"把不可入座的 tier2 也算进去"的缺陷） | `agent-team-v14-local-closeout-20260925.md` |
| 房间与看板联动 | 房间结论要落到看板/验收 | 现役 | `agent-team-v5-full-plan.md` |

### 1.3 看板 + Goal Driver

| 功能 | 做什么 | 状态 | 权威文档 |
|---|---|---|---|
| 全局看板 + `group-*` 组看板 | 两套看板，组看板是后加的（R11） | 现役 | `context-runtime-unified-20261001/overnight-20261026-r8-r11.md` R11 |
| `ONE_NEW_TASK_PER_REQUIREMENT` | 一个需求只允许开一个新任务，防任务爆炸 | 现役 | `agent-team-v12-architecture-improvement-plan.md` |
| 完成需组验收 + verifier 复核 | 完成条件不是"自己说完了" | 现役 | `agent-team-v5-full-plan.md` §verification 分层 |
| nudge 节流（每轮≤2、终身 12） | 对组看板的催办限流 | 现役（R11，206/206 + 仿真 63/63） | `overnight-20261026-r8-r11.md` R11 |
| goal-driver（原生 `dsh-goal-round-driver`） | 自动续轮推进目标 | 现役但**原生包，非本项目代码**（`app/node_modules/@deepseek-ai/dsh-goal-round-driver`） | `CURRENT_STATE.md` 2026-10-23 条目 |
| 严格收敛策略 `GoalService.block` | 必须 3 次稳定 blocked 观察才允许置 block | 现役（2026-10-23 已修 3 条非语义分支） | `CURRENT_STATE.md` |
| strict-plan（封口前缀） | 计划段封口 | **半成品，默认关，未挂载** | `HANDOFF-START-HERE-20261013.md` "不建议做" |

### 1.4 Activity Digest / 唤醒

| 功能 | 做什么 | 状态 | 权威文档 |
|---|---|---|---|
| Activity Digest | 周期性 root 汇总，无活跃组时静默 | 现役，**间隔 600000ms = 10 分钟**（`team-tools-v2-r10.mjs`） | `agent-team-v11-activity-digest.md`（该文写的是 20 分钟 → **已过期**） |
| `wakeClaim` 去重 | 每 slot 只唤醒一次（`activity:<teamKey>:<slot>`）| 现役 | `agent-team-v11-activity-digest.md` |
| team-idle-watch-v6 | 团队空闲监控（settleMs 30s / bootstrapScanMs 30s / 无终身上限）| 现役 | `agent-team-v9-handoff.md` + live config |
| 事件续跑 `team-v14-event-continuation` | 事件驱动续跑（scanMs 30s）| 现役 | live config |
| info / action / decision 三态投递 | 静默消息不许唤醒 | 现役 | `agent-team-v12-architecture-improvement-plan.md` |
| 死信 + 41 小时投递停滞 | 排队投递卡死 | **未解决**（`unfinished-summary-20261012.md` P1） | `context-runtime-unified-20261001/dead-letter-retirement-20261014.md`、`live-replay-plan-20261012.md` |

### 1.5 上下文压缩 / Window 折叠

| 功能 | 做什么 | 状态 | 权威文档 |
|---|---|---|---|
| milestone-only 压缩（`step-compaction-v4`）| 只有 milestone 完成后才允许折叠 | 现役（`minMilestoneFoldTokens: 200000`、`proactiveFoldTokens: 500000`、`windowTokens: 1048576`） | `agent-team-v9-handoff.md` §3–§4 |
| 原生 `compaction-basic` | 原生 8 段摘要压缩 | 现役，**`auto: true` / `thresholdRatio: 0.75`** | 与 v9/v14 文档矛盾，见 §4.3 |
| 压力兜底折叠 | 快撞硬上限时的安全折叠 | 现役（`enablePreStep: true`，pre-step 只按物理预算） | `agent-team-v9-handoff.md` §4 |
| `/compact` 手动压缩 | 手动触发 | 现役（`command-compact`） | live config |
| tool-result-pruner | 裁剪工具结果（8192/4096/1024 三档） | 现役 | `native-ptc-compaction-ds41f-audit-20261001.md` |
| opportunistic 压缩 | 空闲时顺便压 | 现役但 **shadow** | live config |
| cache prefix 裁剪 | 前缀对齐缓存 | 现役（`dropThreshold: 0.15`） | live config |
| **W1 请求投影** | 请求侧投影掉已折叠内容 | 现役但**只开 1 个 session**（`scope: list`、`spanMode: multiple`） | `context-runtime-unified-20261001/window-manager-design-20261006.md` |
| **W2 落盘折叠** | checkpoint + intent + CAS 提交 + 崩溃恢复 | **半成品（shadow）**，证据只到 list 模式 | `oracle-w2-optimistic-commit-20261006.md`、`writer-boundary-decision-20261002.md` |
| **W3 经济决策层** | 按净成本决定折不折 | **半成品，默认关**（真实回放 economicApplied = 0） | `handoff-20261025-window-auto-and-cleanup.md` |
| `team-v15-window-executor` | 折叠执行器 | **代码在盘，未挂载** | 文件核对 |

### 1.6 PTC

| 功能 | 做什么 | 状态 | 权威文档 |
|---|---|---|---|
| `run_code` SDK 桥 | 模型写 JS 调 `tools.*`，一次 round trip 干一批事 | 现役 | `agent-team-v14-ptc-prompt-contract.md` |
| 规范回执 `ptc_receipts` | isError / projectionBlocked / mirrorStatus 三态区分 | 现役 | 同上 |
| `ptc-sdk-retention` | 只保留 5 个认证 SDK 版本，fail-open | 现役（`mode: apply`） | `context-opt-20261001/README.md` CTX-SDK-01 |
| action-fusion-v2 / observation-pack-v2 | 动作融合、观测打包 | 现役 | live config |
| PTC background / 后台 PTC | 长任务脱离当前会话跑 | **半成品：文件在盘未挂载**，另有 `.unknown.json` 冷恢复路径 | `context-runtime-unified-20261001/ptc-background-20261011.md` |
| `sdkCoreProjection` | v16 能力运行时投影 | **半成品（`false`）** | live config |

### 1.7 证据 reducer

| 功能 | 做什么 | 状态 | 权威文档 |
|---|---|---|---|
| evidence-reducer | 阈值触发的有界压缩，带 quote 回执 | 现役（`enabled: true`、`thresholdBytes: 32768`、`localProviders: [opencodego]`） | `old/docs/evidence-reducer-offline-replay-20261001.md`（注意该文结论是"离线 0 次触发"） |
| 路由闸门 | 本地/远端 provider 白名单 | 现役 | `context-opt-20261001/README.md` |
| settings 覆盖 + UI 设置页 | 用户可改 | 现役（`evidence-reducer-ui`） | live config |
| 真实收益证明 | 线上到底省了多少 | **未证实**：真机遥测 7855 次 route-not-allowed、151522 次 below-threshold，即**线上基本没触发过** | `evidence-reducer-offline-replay-20261001.md` |

### 1.8 UI 改动

| 功能 | 做什么 | 状态 | 权威文档 |
|---|---|---|---|
| Team 面板 6 个 tab | 成员/已冻结/看板/协作房间/消息投递/操作概况 | 现役（1440×900 与 480×900 验收，0 console 错误） | `agent-team-v14-local-closeout-20260925.md` |
| 设置页（证据 reducer） | 配置 UI | 现役 | live config |
| 缓存监控 `team-v13-cache-monitor.mjs` | 命中/省费统计 | 现役，但**归因有缺陷**（把节省算错） | `architecture-review-20261001/README.md` |
| `constraint-ledger` / `context-workspace` | 约束账本 / 上下文工作区 | 现役 / **shadow** | live config |

### 1.9 部署 / 回滚

| 功能 | 做什么 | 状态 | 权威文档 |
|---|---|---|---|
| `tools/deploy-production.mjs --plan/--apply --backup/--rollback` | 灰度 → 备份 → 应用 → 回滚 | 现役（2026-10-23 对 287 个目标做过 apply→rollback→reapply） | `CURRENT_STATE.md` 2026-10-23 |
| `deploy-production-config.mjs` / `-window-wiring.mjs` | 配置与 window 接线单独部署 | 现役 | `handoff-20261025-window-auto-and-cleanup.md` |
| `tools/stage-closeout.mjs` | 阶段收尾 | 现役 | `overnight-20261026-r8-r11.md` R10（注：R10 的 all-board 条件"实际永不触发"） |
| `tools/plugin-coupling-audit.mjs` | 插件耦合审计 | 现役 | `CURRENT_STATE.md` |
| `deploy-previous-chronological.txt` + 逆序回滚（3→2→1） | 回滚谱系 | 现役 | `HANDOFF-START-HERE-20261013.md` |
| 证据登记 `v13-register-ab-evidence.mjs` | 规范登记 A/B 证据 | 现役 | `CURRENT_STATE.md` |

---

## 2. 关键设计决策与约束（用户拍过的规则）

### 2.1 压缩 / 上下文

| 规则 | 内容 | 出处 |
|---|---|---|
| **20 万以下不折叠** | `T < 200k` 一律不动 | `context-runtime-unified-20261001/window-manager-design-20261006.md` §3；live `minMilestoneFoldTokens: 200000` |
| **75% 硬上限** | `T ≥ 0.75W` 必须压，不受 milestone 约束 | 同上 §3；live `autoCompactRatio: 0.75` + `compaction-basic.thresholdRatio: 0.75` |
| 200k–500k 之间**只在 idle + milestone 完成**时折叠 | 忙时不许折 | 同上 §3 + `agent-team-v9-handoff.md` §4 |
| `≥500k` 主动折叠 | proactive | live `proactiveFoldTokens: 500000` |
| window 总量 1048576 | 1M 窗口 | live `windowTokens: 1048576` |
| 输出预留从 32768 提到 128000 | 防截断 | live `reservedOutputTokens: 128000`（v9 文档写 32768，**已过期**） |
| 安全边界 32768 | 预算余量 | live `safetyMarginTokens: 32768`（v9 写 8192，**已过期**） |
| 折叠前必须"消费掉" pending-idle job | 防旧快照写回把 job 复活 | `agent-team-v9-handoff.md` §3 |

### 2.2 缓存经济学

| 规则 | 内容 | 出处 |
|---|---|---|
| **缓存命中:未命中 ≈ 1:50** | 0.003 vs 0.15 USD/M（输出 0.60），故**破坏前缀缓存极贵** | `window-manager-design-20261006.md` §1；live `cacheWriteReadRatio: 50`（原 12.5） |
| 前缀必须对齐 | 缓存按前缀匹配，任何前缀改动全废 | 同上 §1 |
| 3–6 万 token 的 W1 反而贵 ~71% | 小上下文折叠不划算 | 同上 §1 |
| 计量在 500k 之后开始退化 | 计数不准 | 同上 §1 |
| 净成本公式 | 净收益 = 省下的 miss 成本 − 折叠本身的 miss 成本 − 额外 round trip | `handoff-20261025-window-auto-and-cleanup.md` §经济 |
| usage 未知时**不许当 0** | unknown ≠ zero，必须显式 unknown | 同上；`context-opt-20261001/README.md` |

### 2.3 一致性与写入

| 规则 | 内容 | 出处 |
|---|---|---|
| 写入顺序固定：host read lease → CP fence → 原生 Session writer | 顺序不许改 | `writer-boundary-decision-20261002.md` |
| 身份激活是**不可变 bundle** | 不许热改 | 同上 |
| 单绑定：`WINDOW_COORDINATOR_ALREADY_INSTALLED` | 一个 session 只能装一个协调器 | `window-manager-design-20261006.md` §10–12 |
| W2 提交用乐观 CAS，且必须在同步段内完成 | 不许异步窗口 | `oracle-w2-optimistic-commit-20261006.md` |
| CAS 必须补 4 件事 | inline ABORTED / recover() 排除 host epoch / committed 分支持久化 redo / 有界重试 | 同上 |
| 进程内证书绑定 module hash + route | 防换了代码还用旧证据 | `window-manager-design-20261006.md` |
| 轮次副本 cap 4096，默认 2048 | 防内存爆 | 同上 |

### 2.4 团队 / 证据纪律

| 规则 | 内容 | 出处 |
|---|---|---|
| 权限由控制面强制，不靠 prompt | 提示词不是权限 | `agent-team-v12-architecture-improvement-plan.md` |
| 静默消息不许唤醒 | info 投递不说话 | 同上 |
| 配额 8 lead / 每组 8 / 活跃 30 | 冻结不算 | live `team-policy`；`agent-team-v10-handoff.md` |
| 房间最多 3 轮 | 防无限讨论 | live `maxRoomRounds: 3` |
| 一个需求只能开一个新任务 | 防任务爆炸 | `agent-team-v12-architecture-improvement-plan.md` |
| 完成 = 组验收 + verifier 复核 | 自评不算 | `agent-team-v5-full-plan.md` |
| 证据必须**独立进程回读**、结果文件用 wx 创建、可冻结绑定 | 自查不算证据 | `CURRENT_STATE.md`；`context-opt-20261001/README.md` |
| 证据证书绑定 module hash + route | 换代码即失效 | `window-manager-design-20261006.md` |
| **unknown 不是 0** | 缺数据必须标 unknown | `handoff-20261025-window-auto-and-cleanup.md` |
| 原始冷恢复用 `readStoredLog` + `Session.fromRestore` | 不用二次加工数据 | `CURRENT_STATE.md` |

### 2.5 明确"不做"的决定（重要，避免重复讨论）

| 决定 | 出处 |
|---|---|
| strict-plan 开关**永不打开** | `HANDOFF-START-HERE-20261013.md` "不建议做" |
| plan B（封口前缀）搁置 | 同上；`overnight-20261026-r8-r11.md` 待决 |
| W2 **长期停在 list 模式** | 同上 |
| strict-plan 组不单独部署 | 同上 |
| 回滚保留集（12+11 个文档）必须留 | `doc-classification-20261012.csv` 的 "保留(代码或回滚集依赖)" |
| 不应再被当"没写完"的项目：恢复保留、PTC 范围证据、W1 regular / W2 widening / strict-plan B / 经济自动——都是**故意 OFF** | `CURRENT_STATE.md` 专节 |

---

## 3. 反复出现的缺陷 / 坑（按根因归类）

主要来源：`agent-team-platform-defects-fix-ledger-20260927.md`（79 轮、B-1..B-257）、`agent-team-v14-runtime-defect-register-20260927.md`（P0-1..P2-7）、`unfinished-summary-20261012.md`。

| 根因类别 | 表现 | 代表文档 |
|---|---|---|
| **A. 旧快照写回复活已消费状态** | stale pending-idle job 被旧快照救活 → "20 万也压缩" 假象 | `agent-team-v9-handoff.md` §3 |
| **B. 静默丢输入 / 丢消息** | blocked turn 丢掉 `user/message`；41 小时投递停滞；死信堆积 | `agent-team-v9-handoff.md`；`unfinished-summary-20261012.md` P1 |
| **C. 写者边界争用** | host read lease / CP fence / 原生 writer 三方冲突 → 数据被覆盖 | `writer-boundary-decision-20261002.md` |
| **D. epoch / CAS 冲突** | 提交时 epoch 过期、恢复时把 host epoch 算进来 | `oracle-w2-optimistic-commit-20261006.md` |
| **E. 状态机死胡同** | 阶段进不去/出不来；`recover_phase` 缺失；终态 no-op 不幂等 | `agent-team-v10-handoff.md` |
| **F. 口径/计量错误** | 缓存节省归因错、selected/blocked/handed 计数混淆、price/quality/horizon 硬编码、raw cache-write 0 vs 7 别名冲突 | `architecture-review-20261001/README.md`；`handoff-20261025...` 的 7 个真问题 |
| **G. 沙箱/作用域漏判** | 未参数化子进程（A-6 至今仍是残余风险）、scan scope、`ignore_untracked` | `agent-team-platform-defects-fix-ledger-20260927.md` 残余风险 |
| **H. 判据/谓词写错** | 完成判据"永远不成立"（R10 all-board）、seat verdict 误算、`trimEnd()` 测试观察器 bug | `overnight-20261026-r8-r11.md` R10；`handoff-20261025...` |
| **I. profile 漂移** | web/headless 配置不同构（144 vs 29 id）；staging→production 复制/junction 指向错 | `HANDOFF-START-HERE-20261013.md`；本次 live 核对 |
| **J. 持久化 / 崩溃恢复缺口** | 写入无 fsync、冷恢复丢 owner、`.unknown.json` 处理不全 | `ptc-background-20261011.md`；`writer-boundary-decision-20261002.md` |
| **K. 文档/ID 冲突** | B-185/189/214/233/235/O-10-13 编号撞车；v13 账本被引用了却已删除 | `unfinished-summary-20261012.md` P2 |

**元结论**：79 轮里被标 "已修" 的条目，绝大多数只到"单测通过 + 定向仿真"，**从未做过真机复验**；`unfinished-summary-20261012.md` P1 直接把"25 个标为 source-fixed 的缺陷需要一次性真机复验"列为第一优先级。

---

## 4. 文档治理

### 4.1 权威链（只信这三层）

1. `CURRENT_STATE.md` 顶部（最新 2026-10-25）——它自己就是"反向时序快照日志"，读到后面即过期。
2. `context-runtime-unified-20261001/handoff-20261025-window-auto-and-cleanup.md` —— 最新交接，含验证表。
3. `context-runtime-unified-20261001/execution-ledger.md` 的**尾部条目**（文件极大，只读尾）。
   - 再往下才是专题报告：`window-manager-design-20261006.md`（触发策略唯一权威）、`writer-boundary-decision-20261002.md`、`oracle-w2-optimistic-commit-20261006.md`。

### 4.2 可归档（过程日志 / 已被超越）

| 类别 | 文件 | 理由 |
|---|---|---|
| 逐轮修复日志 | `platform-defects-batch*-root-result-*.md`（约 20+ 个） | 已被 79 轮总账 `agent-team-platform-defects-fix-ledger-20260927.md` 吸收 |
| 旧版 handoff | `agent-team-v4..v13-handoff.md` | v9/v10 已被 v14 现状超越；仅作历史 |
| 被移动的重名副本 | `docs/old/` 全量 262 个 | 其中 `old/backups/*` 是各轮修复前的快照（有取证价值但非权威） |
| 中间分类 | `unfinished-summary-20261012.old.md`、`todo-summary-20261012.md` | 被 `unfinished-summary-20261012.md` 取代 |
| 已被代码取代的设计 | `agent-team-v5-full-plan.md` | 目标架构，实际实现已偏（但仍是"为什么这么设计"的最好来源，**建议保留为设计史**） |

### 4.3 明确的矛盾点（必须择一为准）

| # | 矛盾 | A 方 | B 方 | 建议采纳 |
|---|---|---|---|---|
| 1 | **压缩触发策略** | v9/v14 P2-4：milestone-only，"没有 armed milestone 绝不压" | live `compaction-basic.auto: true @0.75` + v14 P2-4 决议"压力兜底 + 暴露 trigger" | **B（现状）**，并把 `trigger: milestone|pressure|economic` 写进文档 |
| 2 | **activity digest 间隔** | `agent-team-v11-activity-digest.md`：20 分钟 | live：600000ms = 10 分钟 | **live** |
| 3 | **reservedOutput / safetyMargin** | v9：32768 / 8192 | live：128000 / 32768 | **live** |
| 4 | **生产是否在跑** | `CURRENT_STATE.md` 2026-10-23 说已部署 287 目标 | 2026-10-25：`window-real-adapter-repair-20261025-f642...` = failed，40123 无监听 | **视端口与时间点而定，标"未证实"** |
| 5 | **部署目标数** | 269 / 285 / 287 三个数字都出现过 | — | 以 `deploy-previous-chronological.txt` 最后一次为准（本次未逐条核） |
| 6 | **生产文件数** | 227 vs 287 | — | 未证实 |
| 7 | **端口归属** | 40124 在两份文档里指不同服务 | — | 未证实 |
| 8 | **web/headless 同构** | 纪律：两 profile 配置必须一致 | live：144 id vs 29 id | **规则已破**，重构成必须先修 |
| 9 | **`doc-classification-20261012.csv`** | 声称覆盖全量分类 | 567 行中 306 行指向已删文件、261 行需加 `old/`、无 `CURRENT_STATE.md` | **作废**，重建 |
| 10 | **CSC "未完成" 状态** | CSV 里标未完成的条目 | 后续版本已完成 | 以版本 handoff 为准 |
| 11 | **v13 账本** | 多处引用 | 文件已不存在 | 引用需改指 `platform-defects-fix-ledger-20260927.md` |
| 12 | **evidence-reducer 价值** | 现役启用 | 真机遥测触发率≈0（7855 route-not-allowed / 151522 below-threshold） | 需重新评估是否保留 |

### 4.4 建议的重构后文档结构（简短）

```
docs/
  README.md                  # 唯一入口：现状一句话 + 权威链 + 如何查
  00-current-state.md        # 只留最近 10 条，滚动截断（替代 CURRENT_STATE.md）
  10-architecture/           # 目标架构与原则（v5 + v12 合并成一份）
  20-subsystems/             # 每子系统一份"现状 + 为什么 + 开关"
    team-scheduling.md  room.md  boards-goal-driver.md  wake-digest.md
    compaction-window.md  ptc.md  evidence-reducer.md  ui.md
    deploy-rollback.md
  30-decisions/              # ADR，一条一文件，含被否决方案与日期
  40-ledger/                 # execution-ledger + 缺陷总账（只追加）
  90-archive/                # = 现 docs/old，冻结只读，加 ARCHIVED.md 说明
```
硬规则：**每个开关状态（on/shadow/off）在 `20-subsystems` 里写死，并以 `cordis.patch.yml` 为准逐季核对；任何"已上线"必须标注 profile。**

---

## 5. 已知未解决问题

| # | 问题 | 严重度 | 出处 |
|---|---|---|---|
| 1 | 25 个标为 source-fixed 的缺陷从未真机复验 | 高 | `unfinished-summary-20261012.md` P1 |
| 2 | 排队投递 41 小时停滞 + 死信未清 | 高 | 同上；`dead-letter-retirement-20261014.md` |
| 3 | Window 栈通不了电：usage 缺 cache-write → 经济层 unknown；5s TTL 证据过期；price/quality/horizon 硬编码 | 高 | `handoff-20261025-window-auto-and-cleanup.md` 7 个真问题 |
| 4 | W2 只到 list 模式，durable surface 未真正开启 | 高 | 同上 + `HANDOFF-START-HERE` |
| 5 | web/headless profile 漂移未收敛 | 高 | 本次 live 核对 |
| 6 | 未挂载功能（PTC background / plan-delivery / window-executor / v16 sdkCoreProjection）状态不明——挂上会怎样没人验过 | 中 | 文件核对，**未证实其风险** |
| 7 | 647 个残留 `.team-control-runtime-*` 目录待用户决策 | 中 | `HANDOFF-START-HERE-20261013.md` P0 |
| 8 | S2/S3 + S4 重放未做；老缺陷 B-33/36/37-40/47/61/64 从未修 | 中 | 同上 |
| 9 | 协调层共享锁写路径未做 | 中 | `unfinished-summary-20261012.md` P2 |
| 10 | 账本 B-id 撞车（B-185/189/214/233/235/O-10-13） | 中 | 同上 |
| 11 | 未参数化子进程（A-6）仍是残余安全风险 | 中 | `platform-defects-fix-ledger` 残余风险 |
| 12 | RustMc 产品线未决 | 中 | `unfinished-summary-20261012.md` P2 |
| 13 | alpha7 回滚备份缺失 | 中 | 同上 P3 |
| 14 | usage-audit 的 Next Decisions 从未采纳；3,660,901,622 token 未对账 | 中 | `usage-audit-20261001/README.md` |
| 15 | SDK 系统提示重复 90.17%（720,287/798,822 字节） | 低-中 | 同上 |
| 16 | `team-v13-cache-monitor` 节省归因错误未修 | 低-中 | `architecture-review-20261001/README.md` |
| 17 | evidence-reducer 线上基本不触发，是否保留未决 | 低 | `evidence-reducer-offline-replay-20261001.md` |
| 18 | `stage-closeout` R10 的 all-board 条件"实际永不触发" | 低 | `overnight-20261026-r8-r11.md` R10 |
| 19 | 真机验证被 429 阻塞（仅 3 次 smoke），window 真机结论全部**未证实** | 中 | 同上 |
| 20 | 两项待用户决策：验证节奏、plan B "封口前缀" | 中 | 同上 |
| 21 | `doc-classification-20261012.csv` 需整体作废重建 | 低 | §4.3 #9 |

---

### 附：本报告的证据边界

- 功能"现役/半成品/废弃"的判定**基于 `home/profiles/web/cordis.patch.yml` 单点快照**；headless/desktop/teamtest 未逐一核对，其状态**未证实**。
- 所有"线上表现"（折叠次数、触发率、economicApplied）均引自文档中记录的历史回放，本次**未重新运行**。
- 缺陷归类是从 79 轮账本 + v14 登记表归纳的**根因类**，不是逐条清单；每条的代表文档只给 1–2 个，不代表全部出处。
