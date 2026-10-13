# pkg-L_legacy 取舍分析（只读；未改仓库）

总览（47 个文件）：
- 精读并给出判定 14 个（清单前 14 行）+ 另读 phase6/idle-watch 作为替代证据；其余 33 个文件只看了 import 行与 cases.txt 耗时，一律 KEEP/未读，仅附带线索。
- 建议 DELETE-FILE 4 个：phase2/observation-evidence、phase2/observation-pack、phase8/team-idle-watch-bootstrap、phase8/team-idle-watch-no-cap，合计 4 条用例，约 2.6 s（97+88+1269+1180 ms）。
- 重要纠偏：规范说的“仓库根 patch”（worktree 根 home\profiles\*\cordis.patch.yml）是 initial-import 快照。真正的生产 `D:\dsh-test\home\profiles\{web,headless}\cordis.patch.yml`（2026-10-12 07:32 修改）已加载 `constraint-ledger`。其余加载集合与 worktree 根一致（我对比了 `name: './plugins/` 行，唯一差异就是 constraint-ledger）。

## 加载事实（证据）
- web/headless 生产 patch 加载：action-fusion-v2、observation-pack-v2、step-compaction-v4、team-idle-watch-v6、team-tools-v2-r10、team-operator-v5、team-policy、team-runtime-guard、write-scope-guard、team-health、team-v12-runtime、team-v14-event-continuation 等；`team-usage-projection.mjs` 在 web（patch 第 477-478 行）和 headless（第 323-324 行）都是 `disabled: true`。
- 我对 stage `home\profiles\web\plugins` 做了 import 图（从已加载 root 做可达性）：不可达的有 action-fusion、constraint-ledger（仅 stage 工作树内；生产 patch 直接加载）、observation-pack、step-compaction(v1/v3)、team-idle-watch(v1-v5)、team-milestone(v1)、team-operator(v1-v4)、team-tools-v2、team-tools-v2-r2..r9、team-v15-window-economics(-runtime)、team-usage-projection。无任何插件 import `observation-pack.mjs`、`step-compaction.mjs`、`team-idle-watch.mjs`、`team-tools-v2.mjs`、`team-operator.mjs`。
- `team-milestone.mjs`(v1) 只被 step-compaction.mjs、team-tools-v2.mjs、team-tools-v2-r2.mjs 引用（均未加载）；`team-milestone-v2.mjs` 被 r10 和 step-compaction-v4 引用（已加载）。
- `team-worktree.mjs` 和 `team-usage.mjs` 经 r10 / evidence-reducer 可达，仍属加载面。
- 注意：多数旧测试以绝对路径 `D:\dsh-test\home\profiles\web\plugins\...` 导入（生产目录，不是 stage）；observation 两个测试还会 `rmSync/写入 D:\dsh-test\phase2-tests\spill*`（生产树）。
- 环境限制：我想把旧测试改指到继任模块运行（scratchpad 副本，加 `--import prepare-unified-lab-host.mjs`），因 `app\node_modules\js-yaml` 解析失败未成功；仅 milestone 两个文件在不借 lab host 时跑成（见各条）。因此“继任模块是否仍满足旧断言”未验证的一律不判 DELETE。

---

### native-tests/constraint-ledger.test.mjs  (tests=14, ms=119)
- 判定: KEEP
- 被测: `constraint-ledger.mjs`（standing-constraints 账本：增删、字符上限、compaction 后块注入、summary 严格解析/去重、apply 接线与卸载）。
- 理由/证据: 该插件已被生产 patch（`D:\dsh-test\home\profiles\web\cordis.patch.yml` 与 headless 同名文件，id: constraint-ledger，插在 request-message-projection 之后）加载；worktree 根 patch 缺它只是快照落后。git：70b9e8f5、7a923216 均为 2026-10-12 新增/修复，不是遗留。包含对外持久化格式、容量上限、失败开放（damaged document）契约。
- 可删用例: 无
- 可入 slow 的用例: 无（全文件 119 ms，纯内存+tmp）
- 风险: 删除会失去刚上线功能的唯一测试。

### phase11-tests/unified-window-economics.test.mjs  (tests=12, ms=4)
- 判定: KEEP
- 被测: `team-v15-window-economics.mjs` 的 `aggregateWindowUsage` / `evaluateWindowEconomics`（窗口折叠经济学、单位一致性、unknown 不当 0、fail-closed 根成员）。
- 理由/证据: 生产 patch 未加载；但它被 `team-v15-window-economics-runtime.mjs` import，而该 runtime 被 `tools/prepare-unified-lab-host.mjs` 的 isolatedProfilePatch 挂为 `unified-economics-shadow`（`architecture-tests/unified-lab-host.test.mjs` 断言了该条目）。是 lab/unified 路线的新功能，尚未进生产，不能按“未加载”删。总耗时 4 ms，无节省价值。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 删了失去 unified 窗口经济的纯函数契约。附注：同模块还有 `native-tests/window-economics-runtime.test.mjs`、`phase11-tests/unified-window-economics-runtime.test.mjs`（各 3 条，16-17 ms）疑似成对重复，我未读，建议另包核对。

### phase2-tests/observation-evidence.test.mjs  (tests=1, ms=97)
- 判定: DELETE-FILE
- 被测: `observation-pack.mjs`(v1)：tools/post-execute 钩子把大输出换成 handle，并保留 ERROR/FAIL 证据行、evidencePattern 覆盖。
- 理由/证据: 生产加载的是 `observation-pack-v2.mjs`（id observation-pack，web patch 第 257-258 行），v1 无任何插件 import。v2 是另一套机制（content-addressed archive + 延迟 projection），v1 的证据行语义在 v2 由 `usage-tests/observation-pack-lineage.test.mjs`「evidence retains whitespace, CRLF source line numbers and order」和「current handle carries original lines 2/173/399 without an overlay」覆盖。v1 不在生产，且该脚本会写生产树 `D:\dsh-test\phase2-tests\spill2`。
- 可删用例: 全部 1 条（脚本内 9 个 check），替代覆盖见上。
- 可入 slow 的用例: 无
- 风险: 失去 v1 死代码的回归；不涉及 S0 缺陷反例（无 B-/D- 标记）。

### phase2-tests/observation-pack.test.mjs  (tests=1, ms=88)
- 判定: DELETE-FILE
- 被测: `observation-pack.mjs`(v1)：小结果直通、大结果 spill+handle、error/block 不打包、ptc-dispatch-log、tools 白名单。
- 理由/证据: 同上，v1 未加载。v2 对应：`phase10-tests/observation-pack-v2.test.mjs`「createObservation writes a content-addressed archive with a handle」「reducer receipts and small results are never archived」「an observation source marker prevents a second packing pass」「a corrupted archive fails open and keeps the original text」；error/block/allow-list/ptc 钩子面是 v1 特有（v2 走 projection，无该钩子）。
- 可删用例: 全部 1 条。
- 可入 slow 的用例: 无
- 风险: 失去 v1 的 tools 白名单/ptc 钩子回归，但该代码路径不在生产。

### phase4-tests/spawn-authority.test.mjs  (tests=1, ms=237)
- 判定: KEEP（建议改指到 team-tools-v2-r10 后保留）
- 被测: `team-tools-v2.mjs` 的 `rootLead(ctx, caller)`：teammate 解析到自己的 root lead，非成员无权限。
- 理由/证据: 被测 `team-tools-v2.mjs` 未加载（r10 加载）。但这是权限/授权边界契约（规则 3），我没能证明 r10 的 rootLead 有同等测试，也没跑通改指运行。
- 可删用例: 无
- 可入 slow 的用例: 无（237 ms 主要是模块导入）
- 风险: 删除会丢多 Team 并存时的授权隔离断言。

### phase5-tests/step-compaction.test.mjs  (tests=1, ms=379)
- 判定: KEEP（未验证；候选 DELETE/重定向）
- 被测: `step-compaction.mjs`(v1) + `team-milestone.mjs`(v1)：idle 过渡时 fold、压力阈值、busy 跳过/冷却、pre-step 不吞用户输入。
- 理由/证据: 两个被测模块都不在生产加载（加载的是 step-compaction-v4 + team-milestone-v2）。v4 有大量测试（native-tests/window-*、phase11/unified-milestone-runtime、unified-engine-compaction-recovery 等 import 它），但我没读它们，也没证明“fold 在 idle 时触发/pressure-cooldown/不吞用户步”被逐条覆盖。
- 可删用例: 无（待核对）
- 可入 slow 的用例: 无
- 风险: 若 v4 没覆盖“user step 不被 pre-step 门拒绝”，删了会丢这条。

### phase6-tests/milestone-scope.test.mjs  (tests=1, ms=90)
- 判定: KEEP+重定向到 team-milestone-v2（可顺势作为 milestone.test 的合并目标）
- 被测: `team-milestone.mjs`(v1)：按 Team 分桶的 milestone 存储、旧 v1 文档迁移、通知标记。
- 理由/证据: v1 未加载；我把 import 改指 `team-milestone-v2.mjs` 后在 scratchpad 副本里实跑，全部 7 项 PASS、exit 0（说明 v2 仍满足这些断言，可无损重定向）。但没有找到 v2 侧同名断言，故不判 DELETE。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 直接删会失去 Team 分桶隔离（跨 session 同名成员不串）断言。

### phase6-tests/milestone.test.mjs  (tests=1, ms=85)
- 判定: KEEP（建议核对后重定向到 v2）
- 被测: `team-milestone.mjs`(v1)：reminder band、可读范围、set/tick、compaction arming、reminderText。
- 理由/证据: v1 未加载。改指 v2 后实跑：13 项里 1 项 FAIL（日志只显示尾部，未定位具体项，`checks=all failed=1`），其余 PASS；说明 v2 行为与 v1 在某处已有差异，需人工确认是预期变更。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 贸然删除会丢 stale job/重新 set 不重获提醒这类并发/幂等语义。

### phase7-tests/team-tools-v5.test.mjs  (tests=1, ms=231)
- 判定: KEEP（未验证；建议重定向 r10）
- 被测: `team-tools-v2.mjs`：`roomKindVerdict`、`roomAdmissionVerdict`（房间准入/权限）、`compactRoomSnapshot`。
- 理由/证据: team-tools-v2.mjs 未加载。准入矩阵属权限边界（规则 3）；未验证 r10 导出相同函数，也未找到同等覆盖。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 丢房间准入矩阵。

### phase8-tests/room-snapshot-injection-priority.test.mjs  (tests=1, ms=236)
- 判定: KEEP（未验证；建议重定向 r10）
- 被测: `team-tools-v2-r7.mjs` 的 `compactRoomSnapshot`/`shouldInjectRoomSnapshot`：空闲 room 的闲聊不覆盖 team-idle 唤醒。
- 理由/证据: r7 未加载（r10 加载）；r10 是否保留同名导出、是否有等价测试未验证。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 丢“idle room chatter 不注入 stop”的回归。

### phase8-tests/team-idle-watch-bootstrap.test.mjs  (tests=1, ms=1269)
- 判定: DELETE-FILE
- 被测: `team-idle-watch-v5.mjs`：已停止的 Team 在没有 status 事件时被 bootstrap 扫描提醒。
- 理由/证据: v5 未加载，生产是 v6。v6 把该语义**反转**：`phase11-tests/v14-startup-arming.test.mjs`「idle watch ignores restored stopped Teams until the current process sees that Team running」断言重启后的已停止 Team 在本进程未见 running 前**不**提醒（先 delivered.length===0）；同文件「idle watch periodic scan recovers a missed idle transition after the root is armed」覆盖 bootstrap 扫描在 armed 后的恢复。旧测试与现行契约冲突，已无法在 v6 上成立。
- 可删用例: 全部 1 条（替代：v14-startup-arming 上述两条）。
- 可入 slow 的用例: 无（删除即省 1.27 s，含 1 s waitFor 轮询）
- 风险: 无现行契约损失；非缺陷反例。

### phase8-tests/team-idle-watch-no-cap.test.mjs  (tests=1, ms=1180)
- 判定: DELETE-FILE
- 被测: `team-idle-watch-v3.mjs`：连续 4 个无进展 stop episode 都提醒（无终身上限，`DEFAULTS.maxNoProgressReminders===undefined`）。
- 理由/证据: v3 未加载。v6 的 `phase6-tests/idle-watch.test.mjs`（apply 的就是 v6）含「no-progress stop episodes keep reminding without a lifetime cap」（3 个 episode，且设置 maxNoProgressReminders:2 仍继续提醒）与「deliverable progress still wakes the Lead on the next stop episode」；v6 `DEFAULTS.maxReminders = Number.POSITIVE_INFINITY`。
- 可删用例: 全部 1 条。
- 可入 slow 的用例: 无（省 1.18 s，轮询睡眠）
- 风险: 仅失去“DEFAULTS 不含 maxNoProgressReminders”这个 v3 专有断言。

### phase8-tests/team-idle-watch.test.mjs  (tests=1, ms=185)
- 判定: KEEP（可 MERGE-INTO phase6-tests/idle-watch.test.mjs 的候选，未证实）
- 被测: `team-idle-watch-v3.mjs`：`stoppedState` 语义 + “最后一个成员静默变 idle，watchdog 仍唤醒 root”。
- 理由/证据: v3 未加载。`stoppedState` 5 项在 `phase6-tests/idle-watch.test.mjs` 第 16-22 行（对 v6）几乎逐项覆盖；但“无新事件、timer 周期扫描唤醒 root”这条只在 v14-startup-arming 的 periodic scan 里有相近而非相同的测试，且我没在 v6 上跑通它，故不判 DELETE。
- 可删用例: 无（stoppedState 5 个 check 与 phase6/idle-watch 重复，若合并可去掉）
- 可入 slow 的用例: 无
- 风险: 丢 late-stop 路径回归。

### phase8-tests/team-tools-v2-reopen-scope.test.mjs  (tests=1, ms=86)
- 判定: KEEP（候选重定向到 r10 或删除，待核对）
- 被测: 对 `team-tools-v2-r9.mjs`、`-r8.mjs` 和 headless `team-tools-v2.mjs` 读源文本，断言 `recoverTaskPhaseForReopen` 在模块作用域、先于 `assertTaskPhaseCanAdvance`。
- 理由/证据: 三个目标文件都不是已加载的 r10（web/headless patch 均为 team-tools-v2-r10.mjs）；断言只是源码行/缩进，不含运行时语义。但它是一个“缩进把 helper 嵌进别函数”的缺陷反例，规则 2 要求保留，除非确认 `phase8-tests/team-tools-r9-reopen.test.mjs`（r9，未读）对同一缺陷有运行时覆盖。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 丢该缺陷的源码结构守卫；r10 当前未被守卫。

---

## 其余 33 个文件（未读正文，仅 KEEP/未读；附线索）
只核对了 import 行与 cases.txt 耗时，未读断言，不给 DELETE。下列“线索”仅供下一步核对：

| 文件 | tests/ms | 线索 |
|---|---|---|
| phase1-tests/write-scope-guard | 1/140 | 被测 write-scope-guard 已加载；KEEP/未读 |
| phase2-tests/action-fusion-file, action-fusion | 1/217, 1/249 | import `action-fusion.mjs`(v1，未加载；生产是 action-fusion-v2)；`phase10-tests/action-fusion-v2.test.mjs`(6 条) 可能覆盖，未读 → KEEP/未读 |
| phase3-tests/team-policy | 1/99 | team-policy 已加载；KEEP/未读 |
| phase3-tests/team-tools-v2 | 1/568 | import `team-tools-v2.mjs`(未加载)，384 行；KEEP/未读 |
| phase4-tests/freeze-capacity, freeze-projection, policy-reconcile, spawn-budget, team-isolation | 各 1/~100 | 均 import team-policy（已加载）；可能可 MERGE 为一个 team-policy 文件，未读 → KEEP/未读 |
| phase4-tests/team-operator | 1/271 | import team-operator-v2 + team-tools-v2-r7（均未加载）；KEEP/未读 |
| phase5-tests/team-worktree | 1/88 | team-worktree.mjs 经 r10 可达（仍在加载面）；KEEP/未读 |
| phase5-tests/worktree-git-e2e | 1/3466 | `execFileSync` 真 git；SLOW-FILE 候选（本包最大单项，3.5 s）；KEEP/未读 |
| phase6-tests/idle-watch | 1/702 | 被测 v6（已加载），是上面几条的替代覆盖；内含 setTimeout 睡眠 ~0.5 s；KEEP |
| phase6-tests/team-usage | 1/1828 | import team-usage.mjs（经 evidence-reducer 可达）；耗时 1.8 s 原因未读（可能是 zstd/journal 读取）；SLOW 候选，KEEP/未读 |
| phase6-tests/usage-projection | 1/320 | 被测 `team-usage-projection.mjs` 在 web/headless patch 均 `disabled: true`（web 第 477-478 行，headless 第 323-324 行）；候选 DELETE，但未读未核对替代 → KEEP/未读 |
| phase7-tests/control-plane-v5 | 1/447 | 含 `spawn`；import team-control-plane（已加载）；字符串里出现 step-compaction.mjs；KEEP/未读 |
| phase7-tests/health, runtime-guard | 1/104, 1/222 | team-health/team-runtime-guard 已加载；KEEP/未读 |
| phase7-tests/lifecycle-restart-dual | 1/591 | 含 `spawn`；引用 step-compaction-v3 + team-milestone-v2；崩溃恢复，KEEP/未读 |
| phase7-tests/room-wake-signal | 1/385 | import team-tools-v2-r7（未加载）；KEEP/未读 |
| phase7-tests/write-scope-active-plan | 1/1194 | write-scope-guard + control-plane；1.2 s 原因未读；KEEP/未读 |
| phase8-tests/dispatch-quiet-reconcile, plan-recovery-v2 | 1/100, 1/199 | control-plane（已加载）；KEEP/未读 |
| phase8-tests/privilege-grant | 1/1346 | import team-tools-v2.mjs（未加载）；授权类；1.3 s；KEEP/未读 |
| phase8-tests/room-snapshot-v2, room-snapshot-v2-headless | 1/238, 1/250 | import team-tools-v2-r3（未加载）/headless team-tools-v2.mjs；两者很可能互为重复（同一断言跑 web+headless），未读 → KEEP/未读 |
| phase8-tests/team-activity-digest, -timer | 1/111, 1/448 | team-activity-digest 经 r10 可达；KEEP/未读 |
| phase8-tests/team-hardening | 1/549 | 597 行，r10（已加载）；KEEP/未读 |
| phase8-tests/team-message-batch | 1/126 | r10 源码 + session-format 校验；KEEP/未读 |
| phase8-tests/team-tools-r9-reopen | 1/319 | import team-tools-v2-r9（未加载）；是 reopen-scope 的候选替代，未读；KEEP/未读 |
| phase8-tests/worktree-merge-postcondition | 1/84 | team-worktree；KEEP/未读 |

## 跨文件重复
1. phase8/team-idle-watch-no-cap + team-idle-watch-bootstrap（v3/v5）与 phase6/idle-watch（v6）+ phase11/v14-startup-arming：保 v6 侧，删旧两个（已证据化，见上）。
2. phase8/team-idle-watch 的 `stoppedState` 5 项与 phase6/idle-watch 第 16-22 行重复：保 phase6 侧；late-stop 路径未证实，所以不删文件。
3. phase2/observation-* 与 phase10/observation-pack-v2 + usage-tests/observation-pack-lineage：机制不同，仅“证据行保留”概念重复；保 v2 侧。
4. phase6/milestone-scope、phase6/milestone 与 phase10/compaction-shadow、usage-tests/team-milestone-surface-dedup（后两者 import team-milestone-v2）：未读后两者，不能定重复；milestone-scope 在 v2 上实跑通过，适合重定向后保留。
5. native-tests/window-economics-runtime vs phase11/unified-window-economics-runtime（各 3 条）：疑似重复，未读。
6. phase8/room-snapshot-v2 与 room-snapshot-v2-headless：疑似同断言双跑，未读。

## 汇总
- DELETE-FILE：4 个文件 / 4 条 / ≈2.6 s（observation-evidence 97、observation-pack 88、idle-watch-bootstrap 1269、idle-watch-no-cap 1180 ms）。
- SLOW-FILE 候选（未读，仅凭 cases.txt 与 import）：worktree-git-e2e 3466 ms（真 git）、team-usage 1828 ms、privilege-grant 1346 ms、write-scope-active-plan 1194 ms。
- 注意：我写的 scratchpad 实验副本在 `SP\retarget`，仓库未被修改。
