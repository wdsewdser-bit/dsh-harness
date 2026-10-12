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
| 外部评审说了什么、哪些成立 | [external-review-20261011-verification.md](external-review-20261011-verification.md) | 只读核对，没有重跑测试；它说 W2 只有负面结果，漏了 10-11 的多段折叠实测，见第 3 节；它引用的 `implementation-plan.md` 行号是加提示前的，现在整体后移 2–4 行 |
| Team 的原始设计与历史事故 | [agent-team-v2-design.md](agent-team-v2-design.md) | 靠追加章节更正旧结论，旧章节上没有标记。见第 4 节 |
| 仓库里有什么、没有什么 | 根目录 `CLEANUP-AND-GIT-PLAN-20261012.md` 第三节 | 该文件写“私有”，仓库已在 2026-10-12 转为公开 |

## 2. 模块状态

整个 E0–E8 项目是 **partial**。下表每一行的“生产”都只指 `D:/dsh-test` 这一台机器上的生产文件。

| 模块 | staging | 生产 | 权威文档 | 还缺什么 |
|---|---|---|---|---|
| 多段窗口（W2）+ 权威基线投递 | accepted（隔离副本：真实折叠、冷恢复、页面历史、后继回合） | 已部署，名单模式，只含 1 个会话；原生产根没有发生过折叠 | [window-multi-acceptance-20261011.md](context-runtime-unified-20261001/window-multi-acceptance-20261011.md) | 费用收益未证明，见第 3 节 |
| W2 乐观提交 | accepted | 未部署，生产无调用方 | 计划第 16 节末行；[oracle-w2-optimistic-commit-20261006.md](context-runtime-unified-20261001/oracle-w2-optimistic-commit-20261006.md) | 调用方、路由证书续签、恢复重试 |
| Strict 空计划交付门禁 | accepted（真实普通会话 UI） | 完全未部署 | [strict-plan-delivery-20261011.md](context-runtime-unified-20261001/strict-plan-delivery-20261011.md) | 生产 opt-in 需用户授权 |
| Instant + 同实例 PTC 后台 | accepted（16 项运行时测试、真实 Web UI、原生 Team 邮箱 + 1 个真实子会话；LLM 是 fixture） | 完全未部署 | [ptc-background-20261011.md](context-runtime-unified-20261001/ptc-background-20261011.md) | 真实模型行为、交互审批交接、独立安全/并发审查 |
| 步级压缩与 hypothesis、active identity | — | 2026-10-06 已部署并核验（仅冷恢复会话和全新会话各 1 回合） | 计划第 16 节“生产部署 2026-10-06”行 | 未覆盖多成员 Team；回滚未演练 |
| E5 经济策略、E8 auto | partial / pending | off | 计划第 16 节 | 未启用 |
| Team 基础（权限、冻结、任务板、结算） | 历史版本 v2–v15 已在生产运行 | 在用 | [agent-team-v2-design.md](agent-team-v2-design.md) 及各版本 ledger | 权限是否在所有工具入口闭合，未证（核对文档 C 节） |

最新全量回归：232 文件 / 1494 项 / 1493 通过 / 0 失败 / 1 既有跳过（2026-10-12 05:39 UTC，实际重跑，`output/regressions/2026-10-12T05-39-48-266Z-726e9b0a`）。
比 10-11 多出的 2 个文件、9 项是 5.1 节新增的合同测试。

## 3. W2 的收益：三次实测和当前判断

| 时间 | 结果 |
|---|---|
| 10-08 第一次，已被压缩过两次的大根 | 提交成功，请求从约 667KB 变成约 687KB，变大 |
| 10-08 第二次，未压缩的大根 | 步区间只折到 2 条消息，被净收益门槛拒绝 |
| 10-11，同一个根的隔离副本，多段 + R | 模型正文减少 36.86%（2,158,609 B 变 1,362,998 B），原文冷恢复一致；折叠后第一个请求几乎零缓存命中 |
| 10-12，同一份副本离线复算（非真实折叠） | 10-11 有 28 个工具步共 56 万字节没折，两个原因都已在 staging 修掉；按新规则复算只剩 11 步 14 万字节（全在最后一个被打断的回合，按规则保护），折叠后正文推算约 93 万字节、缩减约 57% |

当前判断见 [w2-continue-decision-20261012.md](context-runtime-unified-20261001/w2-continue-decision-20261012.md)：W2 保留在名单模式，定位是“必须缩上下文时不丢原文”，不是省钱；不再加新能力；下一步是一次同任务对照实验（待用户批准）。
“提交成功”和“字节变少”都不等于“省钱”。在对照实验出结果之前，不要把 W2 写成有费用收益。

## 4. 已知过期或容易误读的地方

| 位置 | 问题 | 处理 |
|---|---|---|
| `implementation-plan.md` “版本：2026-10-01 / reviewed-2”一段（原第 31 行）| 写着“W2/Instant 尚未启用”，实际 W2 已在生产名单模式启用 | 已在该行前加过期提示，原文保留 |
| `implementation-plan.md` 第 1 节之前的各段“补充” | 十几段“补充”按时间倒序堆叠，其中的回归数字都已被后面的覆盖 | 已在文件开头加指向本页的提示 |
| `CLAUDE-HANDOFF-20261006.md` | 旧交接，容易被当成最新入口 | 已在开头加提示 |
| `agent-team-v2-design.md` §57 | 结论被 §58 推翻（真因是 `reconcileRegistry` 传错对象且异常被空 `catch` 吞掉） | 未改原文；读 §57 时接着读 §58 |
| `agent-team-v2-design.md` 文件头 | “状态：待评审”“落盘位置 `D:\dsh\docs\`” 都是 2026-09-11 的原始值 | 未改原文 |
| `CLEANUP-AND-GIT-PLAN-20261012.md` | 写仓库是私有；第四、五节顺序颠倒 | 未改；仓库现为公开 |
| 外部评审核对文档 D 第 2 条 | 写“被改的原生包 19 个，只有 10 个登记在 `patchedDependencies`” | 数字不准：实测 19 个包只有 4 个登记，见 5.1 |

## 5. 下一阶段候选

### 5.1 已完成（2026-10-12，仅 staging，未部署生产）

- **`stage-closeout` 改写清单必须给原因。** 非 `--check` 运行必须带 `--reason=<至少 10 个字符>`，否则在写任何文件前以 `REASON_REQUIRED` 退出；每次改写追加一行到 `manifest-rewrite-log.jsonl`（时间、原因、每个条目的前后哈希）。旧用法 `stage-closeout.mjs <备份目录>` 不再可用。
- **原生补丁审计。** 新工具 `tools/native-patch-audit.mjs`：列出每个被改原生包的上游版本和承载方式，`--check` 对照 `native-patch-baseline.json`，上游版本或承载方式一变就失败。首份基线：19 个包里 4 个由 pnpm 补丁承载，15 个只是 staging 副本；6 个登记了补丁的包不在清单里；`app/patches/` 有 10 个未登记的补丁文件（9 个是旧版本残留，1 个是 `dsh-tool-fs@0.1.7-rc.2`）。
- **三条语义合同测试。** `architecture-tests/upstream-compat-contract.test.mjs`：§65 Team 成员的子代理结算不唤醒父级（staging 规范副本和已安装副本各测一遍）、§58 registry 重建失败会进日志且仅存在于名册的成员可寻址、§59 Team 的 system prompt 段在 Team 状态变化时字节不变。三条都做过变异验证，破坏实现后会变红。`architecture-tests/manifest-acceptance.test.mjs` 把上面两个工具的行为也纳入全量回归。

- **W2 步折叠的两处漏折。** Team 邮件入队记录（`team/message/queued`，没有 `role`）不再被当成对话消息，它夹在工具调用和结果之间时不再让这一步被判成“无结果”；以 error / interrupted 结束的回合里已完成的步成为折叠候选（整回合折叠仍只认正常结束，最后一个未正常结束的回合仍整体保护）。细节和复算数字见 [w2-continue-decision-20261012.md](context-runtime-unified-20261001/w2-continue-decision-20261012.md) 补记三。生产里的 W2 仍是修之前的版本。

这一步**没有**做的：没有把那 15 个包转成 pnpm 补丁。所以“上游升级后改动会丢”的问题仍在，现在只是升级时会被 `native-patch-audit --check` 和合同测试拦下来，而不是悄悄发生。§59 的测试只覆盖 Team 插件自己贡献的那一段，不组装整份原生 prompt。

上游升级时的顺序：升级前跑 `node tools/native-patch-audit.mjs --check`；升级并重打改动后跑合同测试；确认后 `--write-baseline --reason=...`，再 `node tools/stage-closeout.mjs <备份目录> --reason=...`。

注意：staging 的 `app/node_modules/@deepseek-ai/` 下，不带 `-v15` 后缀的包目录可能是指向生产安装的 junction，往里写就是改生产。写之前先看 `native-change-manifest.json` 里登记的路径。

### 5.2 待选（均未开工）

1. **把 15 个 staging 副本承载的包转成登记的 pnpm 补丁**，并清掉 9 个旧版本补丁残留、处理未登记的 `dsh-tool-fs` 补丁。这会改变生产 `pnpm install` 的结果，需要用户授权，并在隔离目录里先验证“干净安装 + 打补丁 = 当前 staging 字节”。
2. **PTC 后台进生产前的三个门槛**（交接文档 P1）：交互审批交接的真实回执；有界的真实模型行为测试（`opencodego/deepseek-v4.1-flash`，首批 16 个请求上限）；独立安全/并发审查。其中真实模型测试会消耗额度，需要用户点头。
3. **`unknown` 结果要有去处。** 现在只落一个 `.unknown.json` 加一条通知，没有给人看的未决清单。时机：PTC 后台生产启用之前。
4. **补两个崩溃切点测试。** 临时文件已写未改名、改名后入账前，目前靠幂等分支兜底，没有单独测试。照现有 crash-child 的写法补。
5. **工具入口权限的架构测试。** 枚举运行时注册的全部工具，每个要么命中策略检查，要么在显式豁免表里。
6. **W2 对照实验**（先在隔离副本上用修过的步折叠真实重跑一次，确认补记三的推算；不折 / 摘要压缩 / W2 多段 / 单代理会话的“小交接 + 按编号取回”，四组约 64 个真实模型请求）。设计和事先写死的判定规则见 [w2-continue-decision-20261012.md](context-runtime-unified-20261001/w2-continue-decision-20261012.md)。会消耗额度，需要用户批准。在它出结果之前，不做规则 T、权威瘦身和 E5 auto。

不建议做的（理由见核对文档 E 节）：全量状态权威矩阵、另起一份 happens-before 图、逐模块六维度记分、七项指标联合置信边界。

## 6. 不能碰的边界

摘自最新交接，仍然有效：不碰 RustMc 和其他生产 Team/原根；不清理 session、cold refs、备份或 telemetry；不启动原生产宿主；不扩大 `team-roots`；多段窗口的部署授权不延伸到 Strict/PTC 新包。
full 回归和 lab 宿主共用 `lab-host-home`，必须串行。
