# DSH Harness 当前状态索引

最后更新：2026-10-12。更新规则：每次写交接文档或改动“生产 / staging / 验收”任一状态时，同步改这一页。
这一页只放指针和状态，不放论证。和下面任何文档冲突时，以“权威文档”一列指向的文档为准，并回来修这一页。

状态用词沿用 `context-runtime-unified-20261001/implementation-plan.md` 第 1 节的定义：
implemented（写了代码）、tested（有测试）、enabled（在某个范围内打开）、accepted（有验收证据）、partial（未完成）。

## 1. 先读什么

| 你想知道 | 读这个 | 注意 |
|---|---|---|
| 现在做到哪了、下一步是什么 | [CLAUDE-HANDOFF-20261011.md](context-runtime-unified-20261001/CLAUDE-HANDOFF-20261011.md) | 最新交接，107 行 |
| 各检查点 E0–E8 的登记状态 | [implementation-plan.md 第 16 节](context-runtime-unified-20261001/implementation-plan.md)（“## 16. 施工登记与最终交付”下的表） | 文件开头 30 多行是按时间倒序堆叠的历史补充，不是当前状态 |
| 某一步具体做了什么、证据在哪 | [execution-ledger.md](context-runtime-unified-20261001/execution-ledger.md) | 2313 行、约 60 万字节。从文件末尾往回读，不要通读 |
| 外部评审说了什么、哪些成立 | [external-review-20261011-verification.md](external-review-20261011-verification.md) | 只读核对，没有重跑测试；它引用的 `implementation-plan.md` 行号是加提示前的，现在整体后移 2–4 行 |
| Team 的原始设计与历史事故 | [agent-team-v2-design.md](agent-team-v2-design.md) | 靠追加章节更正旧结论，旧章节上没有标记。见第 4 节 |
| 仓库里有什么、没有什么 | 根目录 `CLEANUP-AND-GIT-PLAN-20261012.md` 第三节 | 该文件写“私有”，仓库已在 2026-10-12 转为公开 |

## 2. 模块状态

整个 E0–E8 项目是 **partial**。下表每一行的“生产”都只指 `D:/dsh-test` 这一台机器上的生产文件。

| 模块 | staging | 生产 | 权威文档 | 还缺什么 |
|---|---|---|---|---|
| 多段窗口（W2）+ 权威基线投递 | accepted（隔离副本：真实折叠、冷恢复、页面历史、后继回合） | 已部署，名单模式，只含 1 个会话；原生产根没有发生过折叠 | [window-multi-acceptance-20261011.md](context-runtime-unified-20261001/window-multi-acceptance-20261011.md) | 净收益未证明，见第 3 节 |
| W2 乐观提交 | accepted | 未部署，生产无调用方 | 计划第 16 节末行；[oracle-w2-optimistic-commit-20261006.md](context-runtime-unified-20261001/oracle-w2-optimistic-commit-20261006.md) | 调用方、路由证书续签、恢复重试 |
| Strict 空计划交付门禁 | accepted（真实普通会话 UI） | 完全未部署 | [strict-plan-delivery-20261011.md](context-runtime-unified-20261001/strict-plan-delivery-20261011.md) | 生产 opt-in 需用户授权 |
| Instant + 同实例 PTC 后台 | accepted（16 项运行时测试、真实 Web UI、原生 Team 邮箱 + 1 个真实子会话；LLM 是 fixture） | 完全未部署 | [ptc-background-20261011.md](context-runtime-unified-20261001/ptc-background-20261011.md) | 真实模型行为、交互审批交接、独立安全/并发审查 |
| 步级压缩与 hypothesis、active identity | — | 2026-10-06 已部署并核验（仅冷恢复会话和全新会话各 1 回合） | 计划第 16 节“生产部署 2026-10-06”行 | 未覆盖多成员 Team；回滚未演练 |
| E5 经济策略、E8 auto | partial / pending | off | 计划第 16 节 | 未启用 |
| Team 基础（权限、冻结、任务板、结算） | 历史版本 v2–v15 已在生产运行 | 在用 | [agent-team-v2-design.md](agent-team-v2-design.md) 及各版本 ledger | 权限是否在所有工具入口闭合，未证（核对文档 C 节） |

最新全量回归：230 文件 / 1485 项 / 1484 通过 / 0 失败 / 1 既有跳过（2026-10-11 23:06 UTC）。
数字来自仓库自己的记录，本页更新时没有重跑。

## 3. 一条必须知道的负面结果

2026-10-08 在真实大 Team 上切窗提交成功，但请求从约 667KB 变成约 687KB：检查点正文 261KB，外加每个请求约 63KB 的权威消息。
出处：`execution-ledger.md` “检查点（10-08 约 00:00）”一节；
[consult-window-economics-20261008-answer.md](context-runtime-unified-20261001/consult-window-economics-20261008-answer.md)。
结论是继续限名单，不全面开放。“提交成功”不等于“省钱”，在这条被推翻之前，不要把 W2 写成有收益。

## 4. 已知过期或容易误读的地方

| 位置 | 问题 | 处理 |
|---|---|---|
| `implementation-plan.md` “版本：2026-10-01 / reviewed-2”一段（原第 31 行）| 写着“W2/Instant 尚未启用”，实际 W2 已在生产名单模式启用 | 已在该行前加过期提示，原文保留 |
| `implementation-plan.md` 第 1 节之前的各段“补充” | 十几段“补充”按时间倒序堆叠，其中的回归数字都已被后面的覆盖 | 已在文件开头加指向本页的提示 |
| `CLAUDE-HANDOFF-20261006.md` | 旧交接，容易被当成最新入口 | 已在开头加提示 |
| `agent-team-v2-design.md` §57 | 结论被 §58 推翻（真因是 `reconcileRegistry` 传错对象且异常被空 `catch` 吞掉） | 未改原文；读 §57 时接着读 §58 |
| `agent-team-v2-design.md` 文件头 | “状态：待评审”“落盘位置 `D:\dsh\docs\`” 都是 2026-09-11 的原始值 | 未改原文 |
| `CLEANUP-AND-GIT-PLAN-20261012.md` | 写仓库是私有；第四、五节顺序颠倒 | 未改；仓库现为公开 |
| 外部评审核对文档 D 第 2 条 | 写“被改的原生包 19 个，只有 10 个登记在 `patchedDependencies`” | 数字不准，见第 5 节候选 1 |

## 5. 下一阶段候选（待用户选择，均未开工）

按我的建议顺序排列。前三条是交接文档里已有的 P1，后面是外部评审核对后新增的。

1. **统一原生补丁通道并补清单字段。** 本次实测：`native-change-manifest.json` 的 51 条覆盖 19 个包，其中只有 4 个在 `app/pnpm-workspace.yaml` 的 `patchedDependencies` 里，另外 15 个是直接改 staging 副本（`cordis`、`cordis-plugin-loader`、`dsh-agent`、`dsh-session`、`dsh-tools`、`dsh-goal`、`dsh-subagent`、`dsh-system-prompt` 等）。反过来有 6 个登记了补丁的包不在清单里。`app/patches/` 下 `dsh-tool-fs` 的补丁文件没有登记。上游升级后没有重打补丁的脚本，`deploy --apply` 只会拒绝。清单里也没有上游版本号。时机：下一次跟上游升级之前。
2. **让 `stage-closeout` 不再静默改写清单。** `tools/stage-closeout.mjs` 第 82–102 行在非 `--check` 模式下把清单的 `after` 直接改成磁盘现状，所以清单只证明“磁盘和记录一致”，不证明“这个改动被审过”。最小改法是改写时强制留一条带原因的记录，或者拆成“登记新改动”和“校验”两个命令。
3. **三条窄的语义合同测试。** 只固定已经坏过的三件事：子代理结算不唤醒 root（§65）、system prompt 跨回合字节稳定（§59）、registry 重建出错不被吞（§58）。和第 1 条一起做，升级时才有东西可跑。
4. **PTC 后台进生产前的三个门槛**（交接文档 P1）：交互审批交接的真实回执；有界的真实模型行为测试（`opencodego/deepseek-v4.1-flash`，首批 16 个请求上限）；独立安全/并发审查。其中真实模型测试会消耗额度，需要用户点头。
5. **`unknown` 结果要有去处。** 现在只落一个 `.unknown.json` 加一条通知，没有给人看的未决清单。时机：PTC 后台生产启用之前。
6. **补两个崩溃切点测试。** 临时文件已写未改名、改名后入账前，目前靠幂等分支兜底，没有单独测试。照现有 crash-child 的写法补。
7. **工具入口权限的架构测试。** 枚举运行时注册的全部工具，每个要么命中策略检查，要么在显式豁免表里。
8. **先回答 W2 还值不值得继续投入。** 在给 W2 加“回合内分段折叠”之前，在普通单代理会话上试一版“小绑定头 + 非权威工作摘要 + 按编号取回”的形状（astra 在窗口经济性咨询第 2 点提的方向）。这是方向性决定，不是施工项。

不建议做的（理由见核对文档 E 节）：全量状态权威矩阵、另起一份 happens-before 图、逐模块六维度记分、七项指标联合置信边界。

## 6. 不能碰的边界

摘自最新交接，仍然有效：不碰 RustMc 和其他生产 Team/原根；不清理 session、cold refs、备份或 telemetry；不启动原生产宿主；不扩大 `team-roots`；多段窗口的部署授权不延伸到 Strict/PTC 新包。
full 回归和 lab 宿主共用 `lab-host-home`，必须串行。
