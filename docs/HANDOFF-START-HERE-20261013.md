# DSH 总交接：从这里开始（2026-10-13）

接手方：GPT。本文件是三份交接文档的汇总索引，只汇总和引用，不替代原文。凡标注“待核实”的，是没有在材料或仓库里直接确认过的内容，动手前先验证。

## 1. 一屏概览

- **项目是什么**：DSH 是一套由 Claude 驱动的多成员团队（agent-team）运行时。当前工作集中在“上下文运行时”：约束清单、压缩请求的缓存前缀、Team 交付的摘要与相关性排序、严格计划交付。
- **生产**：`D:\dsh-test\home` 和 `D:\dsh-test\app`，正在被使用。**未经用户本人明确同意，不写生产、不部署、不启动生产宿主。**
- **现在在哪一步**：
  1. 10-12 已把四项改动部署到生产（分三次写入）：约束清单、压缩前缀投影、Team 摘要回退、按相关性交付加 `contextPackMaxTokens: 80000`。这些只做过哈希、配置解析和导入核对，没有长时间运行观察。
  2. 未部署：W2 步折叠修复、严格计划交付（开关关闭）、PTC 后台（进生产前有三个门槛）。
  3. 25 项“源码已修、未在真实进程复核”的缺陷，隔离重放做到 S1：16 通过、1 复现（D-新-3）、6 无法判定。S2、S3+S4 未做。
  4. 回归测试精简：分析完成，基础设施已提交到分支，真正的删除和缩规模**还没做**。
  5. 所有开发分支都未合并到 `main`，由协调线程统一处理。

## 2. 必读文件清单（按顺序）

1. 本文件 `D:\dsh-test\docs\HANDOFF-START-HERE-20261013.md`。
2. `docs/handoff-continuation-20261013.md`：上下文运行时线程的交接，含现状表、已做决定、共享资源坑、下一步顺序。主检出区 `D:\dsh-test\docs\` 下有，分支 `claude/project-thread-qfam5f` 的 `docs/` 下也有。
3. `docs/CURRENT_STATE.md`：状态索引页（92 行）。模块状态、W2 结论、未做事项都在这里。与其他文档冲突时以它指向的权威文档为准。它在 `main` 和 `claude/project-thread-qfam5f` 里都有。
4. `docs/handoff-live-replay-20261013.md`：25 项缺陷隔离重放的交接（S0、S1 结果，S2、S3+S4 步骤，驱动用法，已知坑）。主检出区有。
5. `docs/unfinished-summary-20261012.md`：全项目未完成事项，已逐项核实，合并去重为 P1 至 P3 共约 10 条。主检出区有。本文第 4 节直接引用它的编号。
6. `docs/live-replay-plan-20261012.md`：重放方案全文。只读开头和第 6.5 节（S0 记录）即可。主检出区有。
7. 分支 `claude/intelligent-hawking-e47cda` 的 `docs/handoff-test-slimming-20261013.md` 与 `docs/test-slimming-20261013/`：回归测试精简的交接、基线和七份取舍报告。**这个分支还没推送，也没合并。**
8. `context-runtime-unified-20261001/execution-ledger.md`：约 60 万字节，**不要通读**。只做 `grep -n "^## " execution-ledger.md | tail -20`，然后读最后几个检查点。
9. 按需：`docs/agent-team-platform-defects-fix-ledger-20260927.md`（平台缺陷总台账，79 轮，止于 2026-10-01）。

## 3. 现状表（模块 × staging / 生产 / 验证）

“生产”只指这台机器。

| 模块 | staging | 生产 | 验证状态 |
|---|---|---|---|
| 约束清单（`constraint-ledger.mjs`） | 完成，14 条单测 | 10-12 已部署 | 单测 + Team 运行，结果见 `constraint-ledger-team-run-20261012-result.md` |
| 压缩请求的缓存前缀（`request-message-projection.mjs`） | 完成 | 10-12 已部署 | 团队运行 followup 文档 |
| Team 交付装不下时改用摘要形态（`team-v12-runtime`、`team-v14-context-delivery`） | 完成 | 10-12 已部署 | `compact-fallback-live-test-20261012-result.md` |
| Team 交付按相关性排序、用到时补全文 | 完成 | 10-12 已部署 | `context-delivery-relevance-live-test-20261012-result.md` |
| `contextPackMaxTokens` 32000 → 80000 | — | 10-12 已改 | **没有单独的真实运行验证**（据 handoff-continuation 第 7 节） |
| W2 步折叠修复（`team-v15-window-collector`） | 完成，隔离副本实测过 | 未部署 | 结论：维持名单模式，不再投入（见第 4 节“不建议做”） |
| 严格计划交付（6 个插件 + 4 个原生文件） | 完成，真实模型验证过 | 未部署，开关关闭 | `strict-plan-live-test-20261012-result.md`；**不单独部署** |
| 严格计划开关范围收窄（方案 A，`ca6ccdb7`） | 完成 | 未部署 | 真实宿主里“成员建成后标记立即写入”**未验证**，单测用的是模拟成员表 |
| PTC 后台（`team-v15-ptc-background.mjs`） | 据记录已验收，但模型是假的（待核实） | 未部署 | `ptc-background-20261011.md`；进生产前三个门槛（见第 4 节） |
| 回归运行器隔离 `DSH_HOME`（`39fb01e5`、`94b5bdbf`） | 完成 | 不涉及 | 已在 `output/regressions/` 下跑通过 |
| 回归 slow 分组与日志精简（分支 `intelligent-hawking`） | 基础设施完成，未删用例 | 不涉及 | 默认组耗时“约 195 s”是**估算，未实测** |
| 25 项缺陷隔离重放 | S0：71/71 通过 | 生产未在真实进程复核 | S1：16 通过、1 复现（D-新-3）、6 无法判定；S2、S3+S4 未做 |
| 生产 home 的 647 个残留测试目录 | — | 未清理，33M | 需用户本人决定，见第 4 节 P0 |

最新全量回归（2026-10-12 21:47 UTC）：237 个文件、1554 条，1553 通过、0 失败、1 条既有跳过。之后只改了一个测试文件并单独跑过，没有再跑全量。

**生产与 staging 的差异**：运行 `node tools/plugin-coupling-audit.mjs` 可列出不同的插件。它只检查导入能否解析，查不出运行时依赖。生产的 `team-v12-runtime.mjs`（`86A82128`）是“旧生产版本 + 两项优化”拼出来的，不等于任何 staging 历史版本。staging 当前版本（`41E7816F`）依赖未部署的 `team-v15-delivery-service.mjs`，**不能单独拷到生产**，否则宿主会静默缺插件。

## 4. 未完成事项（按优先级，引用原文不重复）

### P0：需要用户本人决定或授权的事

1. **647 个残留测试目录**（`.team-control-runtime-<进程号>`）。清单在 `docs/stale-team-control-runtime-20261012.csv`（分支 `claude/project-thread-qfam5f` 里有，主检出区是否有待核实）。没删也没移：移动也被权限检查判为不可恢复操作。其中进程号 23452、37708 当时对应的进程还在，处理时跳过。**需用户在对话里明确说。**
2. **启动生产宿主做短时核对。** 目的：确认四项改动在真实进程里生效，并批量复核 25 项“源码已修”缺陷。启动会加载用户正在用的团队，`team-activity-digest` 每 10 分钟触发一次，只开几分钟。**需用户同意。**
3. **S2 的凭据副本。** `s1-host.mjs --prepare` 会复制 `D:\dsh-test\home\.credentials.yaml`，权限检查会拦（理由“敏感来源”）。**需用户自己在终端里运行 `--prepare`。** 不要尝试绕过。
4. **分支合并到 `main`。** 协调线程说由它统一做。见第 5 节。

### P1：建议优先做

5. **25 项缺陷的真实进程复核**（`unfinished-summary` P1 #1）。S0 通过，S1 完成。
   - S1 复现 D-新-3：verifier 的平台 scratch 例外在真实进程里未生效，错误是 `write denied: member "v1" has no declared static scope…`。**根因未定位。** 原始测试 `phase11-tests\platform-defects-twenty-second-pass.test.mjs:69` 在进程内通过。两个猜测：live 的 membership 不带 `group`，或 `DSH_HOME` 形态与夹具不同。先读 `write-scope-guard.mjs` 里 `verifier-scratch` 的判定条件。若确认是生产缺陷，另立任务，不在重放线程里修生产。
   - S1 六项无法判定：B-187、B-192、B-228、B-231、B-230、D-新-5。具体做法见 `handoff-live-replay-20261013.md` 第 3 节。
6. **S2：重启与投递**（新建独立 home，宿主两次）。覆盖 B-221、批次 182 死信退役、B-222，以及“41 小时 queued 停滞”探针。**探针没有触发条件记录，没复现只能写“未能复现”，不能写“已修复”。**
7. **S3 + S4**（同一宿主，两个独立会话）。S3：64,475 字符超大 deliverable 的投递。S4：后台作业跨 turn 不被取消。两者都要自己写清单，`prompts\` 里没有。
8. **投递停滞**（`unfinished-summary` P1 #2）：旧接收者死信重试与恢复后续投指向旧目标。**没开始。** 台账标为“独立未闭合项”。
9. **老缺陷是否仍能复现**（`unfinished-summary` P1 #3）：B-33、B-47、B-61、B-64（waiting reconciler）、B-36（等待票 id 唯一性）、B-37 至 B-40（evidence、milestone 持久化等）。台账 170 至 172、194 标 open，之后无关闭记录。先用现行代码确认，再决定关闭还是补修。
10. **回归精简的实际落地**（分支 `intelligent-hawking` 的交接第 2、3、4 项）：缩 `window-transition-runtime` 的 120 次循环；删约 20 条可替代的重复用例；修 `native-tests/window-install-runtime.test.mjs` 里 4 处 `/^a3-d$/` 缺反斜杠、空转的断言。**删除前逐条对照报告。**
11. **验证默认组耗时**（预期约 1507 条、约 195 s，**均为估算**）。
12. **`contextPackMaxTokens: 80000` 的真实运行验证**。

### P2：有价值，不紧

13. **补齐部署备份，核对正式工具**：把 10-12 的三个备份目录补进 `docs\context-runtime-unified-20261001\deploy-previous-chronological.txt`，并核对 `tools/deploy-production.mjs` 是否还认得生产现状。不做这一步，下次部署只能继续手写一次性脚本。**这是作者认为最该先还的债。**
14. **`v14-identity-context.test.mjs` 生产树版本落后**：`D:\dsh-test\phase11-tests\` 里那份在生产树中是 13/14，失败项是测试比 10-12 部署的插件旧。staging 版对同一份插件 14/14。覆盖动作**没做**，需单独决定。
15. **严格计划的回滚隐患**（读代码得出，**未实测**）：开关打开过的会话日志会出现 `plans` 为空的 `native/delivery-status`，生产日志校验会判非法。之后退回旧版原生文件，这些会话可能读不回。
16. **PTC 进生产的三个门槛**（据 10-11 交接，**未核实**）：审批交接的真实回执；有上限的真实模型测试；独立的安全与并发审查。这是让 staging 与生产重新对齐的唯一出路，工作量最大，真实模型测试要花额度。
17. **方案 A 的真实宿主验证**：成员建成后标记立刻写入的时机。
18. **`team-policy.mjs:673` 回退路径**：未配置 `controlDir` 时回落到 `DSH_HOME ?? cwd`。直接 `node --test` 仍会写生产 home。彻底堵住要改这里，会让 staging 与生产多一处不一致，没做。
19. **运行态热路径二次优化**（`second-pass-optimization.md` 8 项）：第 4 至 7 项没开始，第 2、8 项半成。
20. **台账编号校正**：B-185 在批次 47 与台账 1879 编号冲突；B-189 台账 1474 与 1880 状态矛盾；B-214、B-233、B-235、B-191、O-10-13 等为 partial。需先在台账里一次性校正。
21. **RustMc 产品线**（约 10 份根目录文档）：仓不在本机，只能由产品侧核实。

### P3：记录风险

22. **alpha7 回滚备份缺失**：`docs\dsh-alpha7-upgrade-handoff.md` 点名的 `D:\dsh-test\backup-alpha7-20260922-201531` 实测不存在。该文档仍须保留，因为 `app/package.json:6` 的 postinstall 调用 `scripts/apply-local-session-compat.cjs`。
23. **`usage-audit-20261001\README.md` 的 Next Decisions** 没有被后续文档接手。仅 `context-opt-20261001\README.md` 引用它，`tools/usage-audit-snapshot.mjs` 按目录名引用，**不要移动**。

### 不建议做（已有决定，不要重新讨论，除非有新证据）

- **严格计划开关不打开。** 真实模型验证的结论：只开开关而不配别的，团队能干完活，但目标永远完成不了。还缺 `planReadRoots` 和一整套证明配置。
- **严格计划这组不单独部署**，等 PTC 过了门槛一起上。
- **方案 A 已做，方案 B 搁置。** B 是给一条不依赖预先配方文件的证明路径。作者的看法是不值得做。
- **W2 维持名单模式，不再投入。** 步折叠修复已在 staging，可单独部署，但收益有限。把范围扩到所有团队根是用户的决定，没有做。
- **不为对齐而单独部署严格计划组。**

## 5. 分支、HEAD 与合并状态

HEAD 为本次核对时（2026-10-13）的实测值。

| 分支 | HEAD | 相对本地 `main` | 远端 | 说明 |
|---|---|---|---|---|
| `main` | `bcc588f4` | — | `origin/main` 存在 | 初始导入提交。主检出区 `D:\dsh-test` 停在 main，但有大量未提交改动（见第 6 节） |
| `claude/project-thread-qfam5f` | `2d8c4bc5` | 领先 40，**未合并** | `origin/claude/project-thread-qfam5f` 存在 | 上下文运行时主线。从 `94b5bdbf` 分叉，独有 3 个提交：`8a0f0ca8`、`127f8b13`、`2d8c4bc5` |
| `claude/intelligent-hawking-e47cda` | `5dae7f68` | 领先 40，**未合并、未推送** | 无 | 回归精简。从 `94b5bdbf` 分叉，独有 3 个提交：`ffcdd786`、`d96cc146`、`5dae7f68` |
| `claude/frosty-kalam-3f90fc` | `bcc588f4` | 0 | — | 25 项重放的驱动与清单在此 worktree 的 `output\live-replay-20261012\` 下，未跟踪（`.gitignore` 是白名单，需 `git add -f`）。**待核实**：这些未跟踪文件是否只在该 worktree 里 |
| `claude/hungry-aryabhata-59fbb8` | `bcc588f4` | 0 | — | handoff-continuation 称它是“我的工作树”，但 HEAD 与 main 相同，**与文档描述不符，待核实** |
| `claude/distracted-carson-4bb31f` | `bcc588f4` | 0 | — | 本次接手的 worktree。本次只产出本总交接文档，没有提交或推送 |
| `claude/affectionate-gates-c9072b`、`claude/funny-turing-f92699`、`claude/serene-mendel-5c212b` | `bcc588f4` | 0 | — | 无独有提交 |

**未合并提交要合并推送（待用户或协调者决定，本次没有执行）**：
- `claude/intelligent-hawking-e47cda` 的 3 个提交需要先汇入 `claude/project-thread-qfam5f`（两者共享 `94b5bdbf` 之前的历史），然后推送，再合并到 `main`。推送要用 `git push -u origin <分支>`。
- `claude/project-thread-qfam5f` 领先远端的部分，推送前核对。
- 合并到 `main` 之前，先弄清楚主检出区那些未提交改动的来源，**不要直接 `git checkout -- .` 或 `git reset --hard`**，权限检查会拦，也可能丢掉别人的工作。

## 6. 坑与规则

**共享资源**
- **staging 与隔离副本里的 junction 指向生产。** `staging\...\app\node_modules` 下不带 `-v15` 的包目录是指向生产的 junction；隔离副本的 `app` 和 profile `node_modules` 也是。写之前先 `lstat` / `realpath` 确认真实路径不在生产里。
- **端口**：
  - `40123`：生产宿主。不启动、不连接。
  - `40125`：S1、S2 重放专用，每次启动前确认无监听。
  - `40124`：**文档之间冲突，待核实。** `handoff-live-replay` 说它被“项目续推准备”线程占用，不要用；`handoff-continuation` 和 `test-slimming` 又说隔离宿主和 instant-history lab 用它。宿主一次只能跑一个，全量回归里有测试会起宿主，并行会报 `HOST_WRITER_BUSY`。
- **环境变量**：终端全局导出 `DSH_HOME=D:\dsh-test\home`，指向生产。没显式指定目录的脚本和 `node --test` 会落到生产 home。回归运行器已处理。写新脚本时自己设 `DSH_HOME`。
- **启动生产宿主有副作用**：它加载已有会话（包括用户正在用的团队）。40 分钟上限，没有空闲检测。
- **隔离副本的权限**：副本权限收紧为只能写工作区，裸 `node --test` 会报 `spawn EPERM`。模型可能申请完全访问，**拒绝**即可，它会改用 `--test-isolation=none`。
- **预加载用命令行 `--import`，不用 `NODE_OPTIONS`**。后者会被模型在沙箱里启动的 node 子进程继承，作者因此作废过一次运行。

**权限检查与 hook**
- 自动权限检查会拦：写生产、删除或移动生产目录里的东西、部署、启动生产宿主（“生产部署”）、派 worker 建隔离宿主（“不安全代理”，用户说“放行”后通过）、复制生产凭据（“敏感来源”，只能用户自己跑）、`git checkout -- .`、`git reset --hard`、链式 `git commit && git rebase`。
- **拦截后不要换写法绕过**，需要用户在对话里明确说出那件事。协调线程的转述不算用户的话。
- Write 工具对 `D:\dsh-test\output\...` 有 hook 拦截，改用 worktree 路径；node 脚本自己写该目录不受影响。
- **本次实测**：worktree 会话的 Write 工具写主检出区 `D:\dsh-test\docs\` 被 hook 拦截，提示改用 worktree 路径。handoff-continuation 里也有同样的记载。

**生产数据与插件**
- 生产 home 下 `team-control-plane` 有约 23.9 万个 `session-*` 条目，在那里 `ls` 会卡死，扫描前先限定范围。
- 插件在 `home/profiles/web/plugins` 与 `home/profiles/headless/plugins` 各有一份，必须一致。改完 web 后跑 `node tools/stage-closeout.mjs <新备份目录> --reason=<原因>`，它同步 headless、更新清单和哈希。之后跑 `node tools/plugin-coupling-audit.mjs --write-baseline --reason=<原因>`，否则清单验收测试会失败。`--check` 只报告不改。
- 同名插件可能有多个版本（例如团队工具实际加载 `team-tools-v2-r10.mjs`）。以 `home/profiles/<profile>/cordis.patch.yml` 登记的为准。
- 回滚要**倒着来**：3 → 2 → 1。每个一次性部署脚本还原的是它运行之前的状态，跳着回滚会留下半截改动。

**凭据与会话日志**
- 凭据按敏感信息处理：不读出、不打印、不写进任何文档和提交。收尾 `--cleanup` 删副本，结果文件里写“已删除”。
- 会话日志 `session.v4.jsonl.zstd` 是多个 zstd 帧拼起来的，一次解压只得到第一帧。要按魔数 `28 B5 2F FD` 切开逐帧解。

**浏览器与压缩**
- 宿主日志最后一行是带 token 的地址。往输入框填字要用粘贴事件（构造 `ClipboardEvent('paste')`），直接设值不生效。发之前确认输入框是空的。
- 压缩：用新建的小会话。不要复制那个约 49% 上下文的大根，它一回合后会越过 50% 线自动 compact。

**用户偏好**
- 额度紧张：读大量文档用便宜的模型；真实模型运行每次都要有请求上限，并事先写好方案。昨天两次严格计划运行各约 140 个请求。
- 中文沟通；低风险事项自行决定，有风险的先问。
- **待核实**：协调线程说“DeepSeek 额度不限”。三份交接文档里没有这句话，来源只有协调者的 note。live 运行用的模型是 `deepseek-v4.1-flash`（provider `opencodego`，reasoningEffort `high`），来自生产 `cordis.patch.yml`。

**其他**
- 所有“live”结论都是 **isolated-live**（隔离 home、生产插件字节不变、真实模型请求），**不等同于生产 live**。不要在台账里写成生产已验证。
- 缺陷编号 B-id 在不同 pass 里复用（B-187、B-190、B-193、B-237、B-238），**不能按编号去重**。
- 生产 `D:\dsh-test\phase11-tests\platform-defects-*` 的测试 import 的是生产插件，它们在进程内通过，不等于真实进程通过。

## 7. 下一步建议顺序

1. **先问用户 647 个残留目录怎么处理。** 这一句话的事，需要用户本人说。
2. **弄清主检出区未提交改动的来源**，再决定合并顺序。把 `intelligent-hawking` 的 3 个提交汇入 `qfam5f`，推送，合并到 `main`。合并和推送是对外动作，先确认。
3. **补部署备份到 `deploy-previous-chronological.txt`，核对正式部署工具。** 这一步不碰生产，可以先做。
4. **经用户同意后，开一次生产宿主做短时核对。** 确认四项改动在真实进程里生效（启动日志无导入失败，新会话里约束清单工具可用）。可以并入 25 项缺陷的批量 live 复核。
5. **S2、S3+S4 隔离重放**，前提是用户在终端跑完 `--prepare`。先解决 D-新-3 的根因，它可能影响后面所有 Team 场景的判定。
6. **回归精简的实际删除与缩规模**，然后实测默认组耗时。修掉 `window-install-runtime` 的空转断言。
7. **PTC 三个门槛**。先写有上限的测试方案，再花额度。
8. PTC 过后，严格计划那组和方案 A 跟着一起部署，开关仍然关着。
9. **不建议做的**：方案 B；继续投入 W2；为对齐而单独部署严格计划组。

## 8. 待核实清单（汇总）

- `docs/CURRENT_STATE.md` 在 `main` 与 `qfam5f` 中的内容是否一致。
- `stale-team-control-runtime-20261012.csv` 在主检出区是否存在。
- `claude/hungry-aryabhata-59fbb8` 的 HEAD 与文档描述不符。
- `frosty-kalam-3f90fc` 的未跟踪驱动文件是否只在该 worktree 里。
- 端口 40124 的占用者（三份文档说法不一致）。
- `contextPackMaxTokens: 80000` 是否有真实运行验证（文档说没有）。
- PTC 后台是否真的通过了 staging 验收（据记录，模型是假的）。
- 生产宿主当前是否确实无监听（据 10-13 交接；本次未核实）。
- “DeepSeek 额度不限”这一用户偏好的来源。
- 台账中的 B-185、B-189、B-214 等编号和状态冲突。
