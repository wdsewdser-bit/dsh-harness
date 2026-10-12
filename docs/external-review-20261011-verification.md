# 对外部 DSH Harness 观察文档的核对

核对日期：2026-10-12。核对对象：《DSH Harness：外部观察、架构理解与技术建议》（2026-10-11）。
方法：只读。对照 `D:\dsh-test` 的文档、staging 源码、测试文件和 `CLAUDE-HANDOFF-20261011.md`。没有改任何文件，没有重跑测试，所有测试数字都来自仓库自己的记录。
路径约定：`docs\` 指 `D:\dsh-test\docs\`；`ctx\` 指 `docs\context-runtime-unified-20261001\`；`STAGE\` 指 `D:\dsh-test\staging\context-runtime-unified-20261001\`；`P\` 指 `STAGE\home\profiles\web\plugins\`。

## 总评

评审的事实部分大体准确，三个引用的历史案例都能在文档里找到。它的问题在建议部分：七条建议里有两条项目已经做了一大半，有一条（状态权威矩阵，评审排在最高优先级）被它自己举的例子否定。它也漏掉了仓库里最有分量的一条负面证据：10-08 在真实大 Team 上切窗之后请求反而变大。我认为值得现在做的只有一件事，就是加一页当前状态索引。

## A. 明确正确的观察

- 观点：第 6 节的各模块状态（多段窗口已部署、Strict 和 PTC 后台停在 staging、真实模型与独立审查未完成、1485 项 / 1484 通过 / 1 跳过）。
  - 仓库证据：`ctx\CLAUDE-HANDOFF-20261011.md:7-12`，数字和状态逐条一致。
  - 当前实现阶段：整体 E0–E8 仍是 partial（`ctx\implementation-plan.md:470-478` 登记表）。

- 观点：R2 的案例，上游升级覆盖结算适配导致 Root 重复唤醒。
  - 仓库证据：`docs\agent-team-v2-design.md:2769-2806`（§65）。0.1.6 升级覆盖了 `dsh-subagent.notifySettlement` 的补丁，root 被唤醒 9 轮 18 步，其中 7 轮是空 prompt。
  - 当前实现阶段：已修（2026-09-15）。

- 观点：R4 的案例，动态内容进 System Prompt 导致缓存收益下降。
  - 仓库证据：`docs\agent-team-v2-design.md:2513-2550`（§59），命中率从约 99% 掉到 36%。评审把出处列在 `prompt-memory-audit-20261001.md`，那个文件里没有这件事。
  - 当前实现阶段：已修，后续版本有 `systemPromptUpdate: "in-history"` 规则。

- 观点：3.3 节，崩溃后保留 `unknown`，不认成功、不重跑。
  - 仓库证据：`P\team-v15-ptc-background.mjs:119-130`（临时文件、fsync、rename、SHA 回读）和 `:152-175`（恢复时把孤儿结果只记为未提交证据，另写 `.unknown.json`）。测试 `STAGE\native-tests\ptc-background-runtime.test.mjs:420` 用真实子进程加 `kill` 模拟，断言程序只跑过一次。
  - 当前实现阶段：staging 有测试证据，生产未部署。

- 观点：3.5 节，证据要和计划版本绑定。
  - 仓库证据：`P\team-v12-evidence-scheduler.mjs:153` 的绑定字段含 `commitSha`、`treeHash`、`planRevision`、`environmentFingerprint`，不一致时返回 `reuse-binding-mismatch`；测试 `STAGE\phase11-tests\unified-evidence-binding.test.mjs:101`。
  - 当前实现阶段：有测试证据。

- 观点：3.6 节，implemented / tested / enabled / accepted / partial 不混用。
  - 仓库证据：`ctx\implementation-plan.md:39` 有明确定义。

- 观点：R3 里“不要只靠墙上时间戳”。
  - 仓库证据：PTC 后台用 `generation`、`triggerSeq`、事件 `seq` 排序和归属，文件里没有 `Date.now`。这一条在 PTC 上已经是现状。

## B. 错误或已过时的观察

- 原文观点：R1 说恢复故障“并非最初怀疑的原生 Journal 损坏”。
  - 实际情况：最初怀疑的是自己重建 journal 时丢了行元数据，不是原生 Journal 损坏。真因是 `reconcileRegistry` 传错对象，每次抛 TypeError 被空 `catch {}` 吞掉。
  - 证据：`docs\agent-team-v2-design.md:2429-2471`（§57）和 `:2472-2512`（§58）。

- 原文观点：建议 B 级“补丁 manifest”，暗示目前没有。
  - 实际情况：已有三份清单，native 51 条、plugin 50 条、tools 32 条，每条带前后 SHA-256。`STAGE\tools\deploy-production.mjs` 的 `--apply` 要求生产文件处于清单记录的 before 状态，否则拒绝，另有 `--rollback`。
  - 真正缺的：清单里没有上游版本号和预期行为；见 D 第 2 条。

- 原文观点：把 `team-policy.mjs` 当作权限强制点来抽查。
  - 实际情况：`team-policy.mjs` 只导出纯判断函数。真正的强制点在 `P\team-tools-v2-r10.mjs` 各工具的 execute 里（如 `:3778` 派生、`:3899` 发消息、`:5973` 中断、`:6003` 冻结），以及 `P\write-scope-guard.mjs:1602-1604` 的统一写入钩子。这两个文件不在评审的阅读清单里，所以它对权限闭合的判断依据不足。

- 原文观点：概念地图把 contract tests、version pin 列为“DSH Compatibility 的典型机制”。
  - 实际情况：没有任何“上游基线对补丁后行为”的合同测试。项目里的 pin 指的是 pnpm 的 `patchedDependencies` 和 closeout 里硬编码的文件哈希，不是语义合同。这一格写的是评审希望有的东西，不是现有的东西。

- 原文观点：R4 说“有些 A/B 记录指出对照不完整时不能宣称收益”。
  - 实际情况：说轻了。除了对照不完整，仓库里有一条明确的负面结果：10-08 在真实大 Team 上切窗提交成功，但请求从约 667KB 变成 687KB（检查点正文 261KB，再加每个请求 63KB 的权威消息）。
  - 证据：`ctx\execution-ledger.md:1934-1952`，`ctx\consult-window-economics-20261008-answer.md:1`。

- 原文观点：Strict 门禁“尚未全面生产启用”。
  - 实际情况：是完全没有生产部署，不是部分启用。多段窗口的生产范围是名单模式，只含一个会话。证据：`ctx\CLAUDE-HANDOFF-20261011.md:8、20`。

## C. 尚无法确认的判断

- 问题：权限是否在所有工具入口闭合。
  - 缺少的证据：跨组、冻结、层级检查分散在每个工具里，没有看到一个测试枚举全部已注册工具并断言每个都过检查。
  - 最小验证方案：加一个架构测试，列出运行时注册的全部工具，每个要么命中策略检查，要么在一张显式豁免表里。

- 问题：崩溃切点覆盖是否足够。
  - 缺少的证据：PTC 后台只测了两个杀进程点（工具执行中、结果落盘后终态入账前）。临时文件已写未改名、改名后入账前这两个点靠幂等分支兜底，没有单独测试。计划里的故障矩阵（`ctx\implementation-plan.md:337`）登记为“多时点 crash 通过”，我没有逐项核对。
  - 最小验证方案：照现有 crash-child 的写法补这两个切点。

- 问题：Registry 能否从 journal 真实重建。
  - 缺少的证据：现有测试走的是“从 Domain 名册重建”，名册本身是 mock。没找到从 journal 或磁盘重放出名册再重建的测试。

- 问题：控制面里按时间戳排序的地方是否影响正确性。
  - 缺少的证据：`P\team-control-plane.mjs:834、1835-1861、4520` 按 `closedAt`、`updatedAt`、`approvedAt` 排序，没核实是只用于展示归档还是参与判定。

- 问题：真实模型拿到后台任务句柄和完成通知后能否可靠收取。
  - 缺少的证据：全部是 fixture adapter，交接文档自己也写明未测真实 provider。

- 问题：3.4 节提到的 memory debt 和检查点 ACL。
  - 这次没有核查，不下结论。

## D. 值得采纳的建议

1. 建议：加一页当前状态索引（评审的 `docs/CURRENT_STATE.md`）。
   - 价值：这是评审里最实在的一条。仓库是公开给云端智能体看的，但入口很难找对：`execution-ledger.md` 有 60 万字节；`implementation-plan.md:31` 的文件头还写着“W2/Instant 尚未启用”，和后面第 16 节的表不一致；`agent-team-v2-design.md` 靠追加“更正”来取代旧结论，旧章节上没有标记。
   - 成本与风险：一页纸。风险是它自己过期，所以应当只放指针和一张状态表，并写进交接流程，每次写交接时更新。
   - 时机：现在。

2. 建议：给 native 清单补“上游版本”和“预期行为”，并把补丁通道统一。
   - 价值：被改的原生包有 19 个，只有 10 个登记在 `app\pnpm-workspace.yaml` 的 `patchedDependencies` 里，其余是直接改 staging 副本。`app\patches\` 下的 `dsh-tool-fs` 补丁文件没有登记。上游升级后没有重打补丁的脚本，`deploy --apply` 只会拒绝。§65 说明这种事已经发生过一次。
   - 要知道的一点：`STAGE\tools\stage-closeout.mjs:82-102` 在非 check 模式下会把清单的 after 改写成磁盘现状。所以清单证明的是“磁盘和记录一致”，不是“这个改动被审过”。
   - 时机：下一次跟上游升级之前。

3. 建议：语义兼容合同测试，但只做窄版。
   - 价值：不需要评审列的七类语义全做。先固定已经坏过的三件事：子代理结算不唤醒 root（§65）、system prompt 跨回合字节稳定（§59）、registry 重建出错不被吞（§58）。
   - 时机：和第 2 条一起。

4. 建议：`unknown` 之后要有去处。
   - 价值：现在只落一个文件加一条通知，解释和处置全留给模型。没有给人看的未决清单。
   - 时机：PTC 后台生产启用之前。

## E. 不建议采纳的建议

1. 建议：整理全量状态权威矩阵（评审排 A 级）。
   - 理由：评审拿 §58 当论据，但那次的根因是异常被吞，不是两个模块争同一份状态，矩阵拦不住它。上下文运行时这一块已有 `ctx\writer-boundary-decision-20261002.md`（固定顺序和唯一提交权威）和计划 10.3 节的恢复决策表。给 Team 全域补一张表是不小的文档工程，而且会和代码漂移。
   - 更好的方案：只在某个机制要进生产时，给它新碰到的实体写这一小段。

2. 建议：另起一份跨模块 happens-before 图和故障注入矩阵。
   - 理由：矩阵已经在计划里（`ctx\implementation-plan.md:305-337`）。缺的是按它执行并登记结果，不是再写一份设计。

3. 建议：逐模块六维度记分。
   - 理由：计划第 16 节的登记表已经在做同一件事，再加一套维度只会多一处要同步的地方。

4. 建议：七项指标联合衡量并给置信边界。
   - 理由：现有真实样本每组只有 1 个，预算是每批十几个请求，谈不上置信边界。更该先回答的是 10-08 那个负面结果之后，切窗这条路还值不值得继续投入。

## 关于你提到的换窗 mod

读了 `ctx-mod` 的 README、开发笔记和 DSH 这边的 `window-manager-design-20261006.md`，两者目标相同（换窗不写摘要、原文可取回），做法差别很大。

- mod 的做法：模型自己记账本，历史按编号落盘，换窗时代码拼一份目标 1.5 万 token 的交接，其余靠模型按编号去取。
- DSH W2 的做法：宿主把完整权威状态做成检查点和每请求的权威消息塞给模型，外加回合副本、协议证书、按会话的采集器。10-08 变大的 63–90KB 权威消息和 261KB 检查点就出在这里。
- astra 在 `consult-window-economics-20261008-answer.md` 第 2 点提的“小绑定头、非权威工作摘要、精确取回指引”，实际上就是 mod 的形状。

我的看法：在继续给 W2 加“回合内分段折叠”之前，值得先在 DSH 的普通单代理会话上试一版 mod 的形状。设计文档第 5 节本来就说普通会话只用压缩，那里没有租约和任务板要带，风险最小。两个保留：mod 依赖模型自觉记账，DS v4.1-flash 能不能做到要实测；Team 的租约、任务、冻结这类状态不能交给模型的账本，仍应留在宿主。这是讨论意见，不是施工建议。

## 这次核对的局限

- 测试没有重跑；`execution-ledger.md` 只按关键词读了相关段落。
- 源码一路的核查在几处停在“代码里看到了”，没有确认测试覆盖：证据里的 taskId 比对、“源变化后 partial”的对应测试、Team 消息幂等的代码位置。
- `prompt-memory-audit` 和 `native-ptc-compaction-ds41f-audit` 两份文件只做了关键词搜索。
