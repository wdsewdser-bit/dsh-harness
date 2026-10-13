# DSH Harness 接续交接（2026-10-13，“持续优化 harness”线程）

写给接手的人。这份文档只覆盖我这个线程经手的部分：上下文运行时（约束清单、压缩缓存、Team 上下文交付、W2、严格计划交付）。别的线程（文档归档、未完成事项汇总、精简回归测试）有各自的交接。

凡是我没有亲自验证、只是读代码或从旧记录得到的结论，文中都标了“未实测”或“据记录”。

## 0. 动手之前必读

按顺序读，前三个读完再做任何事：

1. `docs/CURRENT_STATE.md`：状态索引页，92 行。模块状态表、W2 的结论、未做事项都在这里。和别的文档冲突时以它指向的权威文档为准。
2. 本文第 5 节“共享资源与权限坑”。这里的每一条都是踩过的。
3. `docs/context-runtime-unified-20261001/execution-ledger.md` 的**末尾**。这个文件约 60 万字节，不要通读：`grep -n "^## " execution-ledger.md | tail -20`，然后只读最后几个检查点。
4. `docs/unfinished-summary-20261012.md`（在主检出区 `D:\dsh-test\docs\`，是另一个线程写的）：全项目未完成事项合并成的 10 条。
5. 要碰哪个模块，再读它的结果文档（第 2 节表格最后一列）。每组实验是 `*-protocol.md`（事先登记）加 `*-result.md`（结果），只读 result 就够。

## 1. 目录和分支

| 东西 | 位置 | 说明 |
|---|---|---|
| 生产 | `D:\dsh-test\home`、`D:\dsh-test\app` | 正在使用的 DSH。**未经用户本人同意不要写** |
| staging | `D:\dsh-test\staging\context-runtime-unified-20261001` | 所有开发在这里做。只有这里有 `node_modules`，测试只能在这里跑 |
| 我的分支 | `claude/project-thread-qfam5f`，HEAD `8a0f0ca8`，已推送 | 工作树 `D:\dsh-test\.claude\worktrees\hungry-aryabhata-59fbb8`，干净 |
| 主检出区 | `D:\dsh-test`，停在 `main` | 显示大量未提交改动：staging 文件与我的分支内容相同（已在分支上提交）；`home/profiles` 下是生产部署的结果；`docs` 下是归档线程的工作 |
| 仓库 | `wdsewdser-bit/dsh-harness`，公开 | `.gitignore` 是白名单式的，staging 下的文件要 `git add -f` |
| 隔离实验 | `D:\dsh-test\output\<实验名>\` | 每个实验一个目录，含驱动脚本、副本、日志 |
| 备份 | `D:\dsh-test\backups\` | 每次部署和每次 closeout 一个目录 |

分支还没有合并到 `main`，协调线程说由它统一做。

## 2. 各模块现状

“生产”只指这台机器。哈希是 SHA256 前 8 位。

| 模块 | staging | 生产 | 结果文档 |
|---|---|---|---|
| 约束清单（`constraint-ledger.mjs`） | 完成，14 条单测 | **10-12 已部署** | `constraint-ledger-design-20261012.md`、`constraint-ledger-team-run-20261012-result.md` |
| 压缩请求的缓存前缀（`request-message-projection.mjs`） | 完成 | **10-12 已部署** | `constraint-ledger-team-run-20261012-followup.md` |
| Team 交付装不下时改用摘要形态 | 完成 | **10-12 已部署** | `compact-fallback-live-test-20261012-result.md` |
| Team 交付按相关性决定先压谁、用到时补全文 | 完成 | **10-12 已部署** | `context-delivery-relevance-live-test-20261012-result.md` |
| `contextPackMaxTokens` 32000 → 80000 | — | **10-12 已改**，这个值没有单独实测过 | execution-ledger |
| W2 步折叠修复（`team-v15-window-collector`、`-protocol`） | 完成，隔离副本实测过 | 未部署 | `w2-experiment-20261012-result.md`、`w2-continue-decision-20261012.md` |
| 严格计划交付（6 个插件 + 4 个原生文件） | 完成，真实模型验证过 | 未部署，开关未开 | `strict-plan-live-test-20261012-result.md` |
| 严格计划开关范围收窄（方案 A） | 完成（`ca6ccdb7`） | 未部署 | 同上文档末尾 |
| PTC 后台 | 据记录已在 staging 验收，但模型是假的 | 未部署 | `ptc-background-20261011.md`（我没有碰过） |
| 回归运行器不再把生产 home 交给测试 | 完成（`39fb01e5`、`94b5bdbf`） | 不涉及 | execution-ledger 末尾 |

最新全量回归：237 个文件 1554 条，1553 通过、0 失败、1 条既有跳过（2026-10-12 21:47 UTC，`output/regressions/2026-10-12T21-47-06-687Z-bf5516f9`）。之后只改了一个测试文件并单独跑过，没有再跑全量。

### 生产和 staging 现在差在哪

在 staging 根目录跑 `node tools/plugin-coupling-audit.mjs`，它列出所有和生产不同的插件，并说明每个能否单独部署。上次的结果（方案 A 之前）是 9 个插件不同。要注意它只检查导入能否解析，查不出运行时的依赖：我曾据此说严格计划那组是“三个插件”，实际是 6 个插件加 4 个原生文件。

生产的 `team-v12-runtime.mjs`（`86A82128`）是“旧生产版本 + 今天的两项优化”拼出来的，不等于任何一个 staging 历史版本，源文件在 `tools-oneoff/relevance-only/`。staging 当前版本（`41E7816F`）是它的超集，但依赖未部署的 `team-v15-delivery-service.mjs` 新导出，**不能单独拷到生产**，拷了会导入失败，而且宿主不会因此停下，只是静默缺这个插件。

## 3. 今天的四次生产部署和回滚方式

都是一次性脚本，在我分支的 `tools-oneoff/` 下。每个脚本都支持 `--rollback`，会从它自己的备份目录还原。

| 顺序 | 脚本 | 写了什么 | 备份目录（`D:\dsh-test\backups\` 下） |
|---|---|---|---|
| 1 | `deploy-ledger-and-compaction-prefix-20261012.mjs` | 两个 profile 的 `constraint-ledger.mjs`、`request-message-projection.mjs`，两份 `cordis.patch.yml` 登记清单插件 | `context-runtime-production-constraint-ledger-20261012` |
| 2 | `deploy-compact-fallback-20261012.mjs` | 两个 profile 的 `team-v12-runtime.mjs`、`team-v14-context-delivery.mjs` | `context-runtime-production-compact-fallback-20261012` |
| 3 | `deploy-delivery-relevance-20261012.mjs` | 同上两个插件的新版本，加两份配置里的 `contextPackMaxTokens: 80000` | `context-runtime-production-delivery-relevance-20261012` |

（第 3 个脚本一次做了“优化”和“改上限”两件事，所以算四项改动、三次写入。）

回滚要**倒着来**：3 → 2 → 1。每个脚本还原的是它运行之前的状态，跳着回滚会把后面的改动留成半截。

为什么没用正式的 `tools/deploy-production.mjs`：它按清单把 staging 的全部差异一起部署，而 staging 里有不该上的东西（严格计划、PTC、W2）。正式工具的用法和它要求的历史备份顺序表见 `docs/context-runtime-unified-20261001/deploy-previous-chronological.txt`。今天这三个备份目录**没有**追加进那张表，下次用正式工具之前要先核对它是否还认得生产现在的文件。

部署后生产宿主没有做过长时间运行验证。每次只核对了写入后的哈希、配置能解析、插件能导入。

## 4. 已经做出的决定

这些是用户或协调线程定下来的，接手后不要重新讨论，除非有新证据。

- **严格计划开关不打开。** 真实模型验证的结论：只开开关而不配别的，团队能把活干完，但目标永远完成不了；模型没有谎报，如实报告了受阻。还缺 `planReadRoots` 和一整套证明配置（配方文件、环境文件、里程碑文件）。
- **严格计划这组不单独部署**，等 PTC 过了门槛一起上。原生文件里两者的日志格式改动写在一起，拆不开。
- **方案 A 已做，方案 B 搁置。** A 是把开关范围收窄到“确有其他团队成员的根”，避免空白普通会话被打上永久标记。B 是给一条不依赖预先配好配方文件的证明路径。我的看法是 B 不值得做：2000 多个请求的真实团队没登记过一个计划也照样交付了，现有的任务卡验收、独立验证方放行、合并门禁已经在起作用，而严格计划想解决的问题（模型口头说完成其实没完成）在两次真实运行里没有出现。
- **W2 维持名单模式，不再投入。** 步折叠修复已在 staging，可以单独部署，但收益有限。把范围扩大到所有团队根是用户的决定，没有做。
- **PTC 进生产前有三个门槛**（据 10-11 的交接记录，我没有核实）：审批交接的真实回执、有上限的真实模型测试、独立的安全与并发审查。

方案 A 还欠的验证：没有在真实宿主里看过“成员建成后标记立刻写入”，单测里的成员表是模拟的。如果真实时机和推断的不同，标记会推迟到下一次完成目标检查时才写，不会漏写。读成员表出错时按“没有成员”处理，这是有意的：宁可漏开，不把普通会话永久锁死。

回滚隐患（读代码得出，未实测）：开关一旦打开过，会话日志里会有 `plans` 为空的 `native/delivery-status`，生产现有的日志校验把它判为非法。之后再把原生文件退回旧版，这些会话可能读不回来。

## 5. 共享资源与权限坑

**环境变量。** 这台机器的终端里 `DSH_HOME=D:\dsh-test\home`，指向生产。任何没有显式指定目录的脚本和测试都会落到生产 home 里。回归运行器已经处理了这一点，但直接用 `node --test <文件>` 跑仍然会沿用它。写新脚本时自己设 `DSH_HOME`。

**生产 home 里有 647 个测试残留目录**（`.team-control-runtime-<进程号>`，共 33M）。清单在 `docs/stale-team-control-runtime-20261012.csv`。没有删也没有移走：自动权限检查把移动也判成不可恢复操作拦下了，要等用户本人明确说。其中两个（进程号 23452、37708）当时对应的进程还在，处理时跳过。

**端口。** 隔离宿主都用 40124，一次只能跑一个。生产宿主用 40123。全量回归里有测试会起宿主，不能和隔离宿主同时跑，否则报 `HOST_WRITER_BUSY`。

**启动生产宿主有副作用。** 它会加载已有会话，包括用户正在用的团队；`team-activity-digest` 启动后每 10 分钟触发一次，长时间开着可能唤醒用户的团队。做核对只开几分钟。启动命令和注意事项在 `C:\Users\yadaz\.claude\projects\D--dsh-test\memory\dsh-context-runtime-resume.md`。

**隔离副本怎么建。** 用现成的驱动，不要手搭：
- `output/strict-plan-live-20261012/driver/plan-host.mjs`（最新，`--prepare --name <n> --strict on|off`，`--start --name <n> --run <r> --minutes N --max-requests N`，停止是在副本目录下建 `<run>-stop` 文件）。它带生产文件签名守护、导入失败自动停、请求数上限。
- 需要换原生文件时用同目录的 `native-overlay.mjs`。**它必须用命令行参数 `--import` 传给宿主，不能用 `NODE_OPTIONS`**：后者会被模型在沙箱里启动的每个 node 子进程继承，我因此作废过一次运行。
- 副本的 `app` 和 `node_modules` 是指向生产的链接。写任何东西之前先确认真实路径不在生产里。
- 副本权限收紧为只能写工作区。这会让裸 `node --test` 报 `spawn EPERM`，模型会申请放宽到完全访问，**拒绝**即可，它会改用 `--test-isolation=none`。

**浏览器驱动。** 宿主日志最后一行是带 token 的地址。往输入框里填字要用粘贴事件，直接设值不生效；发之前确认输入框是空的，否则文字会重复。可用的脚本在我会话记录里，核心是：聚焦可编辑区、构造 `ClipboardEvent('paste')`、核对文字、点 `aria-label="Send message"` 的按钮。

**会话日志是多帧 zstd。** `session.v4.jsonl.zstd` 是多个压缩帧拼起来的，一次解压只能得到第一帧（两三百字节的文件头）。要按魔数 `28 B5 2F FD` 切开逐帧解。我在这上面浪费过两轮。

**staging 的两个副本。** 插件在 `home/profiles/web/plugins` 和 `home/profiles/headless/plugins` 各有一份，必须一致。改完 web 之后跑 `node tools/stage-closeout.mjs <新备份目录> --reason=<原因>`，它同步 headless、更新三份清单和钉住的哈希；`--check` 只报告不改。之后跑 `node tools/plugin-coupling-audit.mjs --write-baseline --reason=<原因>`，否则清单验收测试会失败。

**改哪个文件先确认。** 同名插件可能有多个版本（例如团队工具实际加载的是 `team-tools-v2-r10.mjs`）。以 `home/profiles/<profile>/cordis.patch.yml` 里登记的为准。

**自动权限检查会拦三类事**：写生产、删除或移动生产目录里的东西、部署。拦下之后不要换个写法绕过去，需要用户本人在对话里明确说出那件事。协调线程的转述不算用户的话。

**额度。** 用户的额度紧张。读大量文档用便宜的模型；真实模型运行每次都要有请求上限，并且事先写好方案。昨天的两次严格计划运行各约 140 个请求。

## 6. 建议的下一步顺序

1. **先决定 647 个残留目录**（一句话的事，需要用户本人说）。
2. **把分支合并到 `main`**（协调线程说它来做）。之后主检出区的“未提交改动”才会消失，别的线程才能在干净的基础上工作。
3. **把今天三个部署备份补进 `deploy-previous-chronological.txt`，并核对正式部署工具是否还认得生产现状。** 不做这一步，下次任何部署都只能继续手写一次性脚本。这是我认为最该先还的债。
4. **开一次生产宿主做短时核对**，确认今天的四项改动在真实进程里都生效（看启动日志无导入失败，新会话里约束清单工具可用）。另一个线程的“25 个源码已修但未在真实进程验证的缺陷”可以并在同一次里做。需要用户同意才启动。
5. **PTC 的三个门槛**，这是让 staging 和生产重新对齐的唯一出路。工作量最大，其中真实模型测试要花额度。
6. PTC 过了之后，严格计划那组和方案 A 跟着一起部署（开关仍然关着）。
7. 不建议做的：方案 B；继续投入 W2；为了对齐而单独部署严格计划那组。

## 7. 我这个线程没做完或没验证的

- `contextPackMaxTokens: 80000` 没有单独的真实运行验证。
- “每个上限都必须有降级路径”的通用架构测试没有做。我判断它无法机械地定义，已知的两处情形各有单测。
- 方案 A 的成员事件时机未在真实宿主里实测（见第 4 节）。
- 不经运行器直接跑测试时仍会写生产 home。彻底堵住要改 `team-policy.mjs:673` 的回退路径，那会让 staging 和生产再多一处不一致，没有做。
- 生产部署之后没有做过长时间运行的观察。
