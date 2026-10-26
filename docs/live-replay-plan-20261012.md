# 25 项“源码已修未 live 复核”缺陷与 41 小时停滞：隔离副本重放方案（只是方案，未执行）

日期：2026-10-12。配套文件：`unfinished-summary-20261012.md`（第二节 #1、#2）。
状态：待用户批准后执行。本文不启动任何宿主，不碰生产与 staging junction。

## 0. 结论与前提

- 不启动生产宿主（协调者 2026-10-12 21:23Z 决定）。在隔离副本上用真实 Team 场景，按原始反例重放。
- 25 项里约 20 项在台账里已有“纯函数/模块级”原始反例测试，且测试里 import 的就是 `D:/dsh-test/home/profiles/web/plugins/` 的生产文件。所以真正缺的不是“代码对不对”，而是“真实进程里工具层、钩子、成员身份串起来后是否一样”。方案因此分两层：
  - **L0 进程内复跑**（无宿主、无模型）：把原始反例测试在当前生产插件文件上重跑一遍。生产的 `team-tools-v2-r10.mjs`（10-07）、`team-control-plane.mjs`（10-06）、`team-v12-runtime.mjs`（10-12）都晚于第 79 轮，需要确认没有回退。
  - **L1 隔离宿主重放**：新进程、生产插件字节不变、真实模型驱动、真实成员身份和工具层。
- 41 小时 queued 停滞触发条件在台账里没有记录（旧接收者、消息 ID 都没写），本方案只能给“假设性探针”，不能保证复现，见第 6 节。
- “关闭”的口径：L0 + L1 通过记为 `isolated-live verified`，与台账里“生产 live”区分，不冒充后者。

## 1. 项目到场景的分组（25 项 + 附带 + 41 小时）

| 场景 | 覆盖项 | 运行方式 |
|---|---|---|
| **S0 进程内复跑** | 全部有测试的项（见下表“测试”列） | 一次 `node --test`，串行，无宿主 |
| **S1 控制面与权限场景**（一个 Team，一次宿主运行，分 A/B/C 三轮清单） | B-183、B-186（两项）、B-207、B-210、B-227、B-228、B-229、B-230、B-231、B-232、B-234、D-新-4、D-新-5；B-182、B-190、B-220（等待票）；B-187、B-192（计划+租约+git）；B-213、B-213b、B-219（shell 写守卫）；D-新-3（verifier 成员） | 1 次宿主运行，预计重跑 1 次 |
| **S2 重启与投递场景**（同一隔离 home，宿主运行两次） | 批次 182 死信退役、B-221（legacy wake 重水合）、41 小时 queued 探针、B-222 冷启动（附带，台账 1836 已 live 观察） | 2 次宿主运行 |
| **S3 超大 deliverable** | 第 4 号（world 组 64,475 字符 deliverable 的上下文投递） | 与 S4 同一宿主运行、不同会话 |
| **S4 后台作业不跨 turn** | 第 6 号（owner 回收后 running job 仍可读，仅 session/disposed 才取消） | 同上 |
| 已 live 验证，不重跑 | B-218、批次 204 -File 诊断（批次 210 三臂，台账 2081/2099）、B-213c（2148/2169）、B-193、B-184 | — |

### 项目明细（原始反例来源均为 `D:\dsh-test\phase11-tests\` 下的测试，行号为测试文件内）

| 项 | 一句话缺陷 | 测试 | 通过判据（修复后） | 场景 |
|---|---|---|---|---|
| B-182 | task-terminal 不再静默关闭带结构化条件的等待票 | twenty-seventh-pass:12 | external/dependency 票保持 open；legacy 票 `closedReason=task-terminal` | S1-B |
| B-183 | requirement 授权继承 task 作用域，空 scope 不当 global | twenty-seventh-pass:65 | 范围内 `ok:true`（含空 scope）；跨板 `requirement-task-scope` | S1-B |
| B-186 | 非 tier 0 不能把卡手工推进到 integrated/accepted；reopen 能修 accepted 的 edit 卡 | twenty-eighth-pass:26、44 | tier 2 被拒 `phase-owner-terminal`，lead 放行；reopen 后 pending/execution | S1-A |
| B-187 | owner 从 integration-ready 完成不回退 execution | twenty-ninth-pass:31 | status=completed 且 phase 保持 integration-ready | S1-C（需 git） |
| B-190 | opaque approval 票（带 object/note）不被无关 plan-approved 清掉 | twenty-ninth-pass:148 | opaque 票仍 open；planId 票 closedReason=plan-approved | S1-B |
| B-192 | `preservedTrackedUnstaged` 保留 porcelain 前导空格 | twenty-ninth-pass:199 | 值为 `[' M local.txt']` | S1-C（需 git） |
| B-207 | 依赖可按 completed 相位放行 | thirty-third-pass:84 | `dependency_phase:"completed"` 生效 | S1-A |
| B-210 | 同 owner 计划提案冲突不再 fail-closed | thirty-third-pass:116 | `same-owner-plan` ok；异 owner 仍 scope-conflict | S1-C |
| B-213 / B-213b | Join-Path/括号 RHS 路径解析；未知 Verb-Noun 写类开关与 `& $c` 动态调用判 opaque | thirty-fourth-pass:12、37 | 目标正确；三种形态 opaque=true，`Test-Path -LiteralPath` 保持 false | S1-C |
| B-219 / B-220（附带） | 表达式写目标不生成仓根假路径；同 task waiting_set 不产生第二张开放票 | thirty-fifth-pass:90、99 | opaque、targets=[]；仅 1 张票 | S1-C / S1-B |
| B-221 | legacy wake 重水合不复活已 ack 行 | thirty-sixth-pass:12 | acked 行保持 handled，无同 dedupeKey 风暴 | S2 |
| 批次 182 | timed-out 死信有 tier 0 退役路径 | fourth-pass:85（测试名 B-182b） | tier 0 可 timed-out→expired，tier 1 不可 | S2 |
| B-227 | 全局板 owner 必须 tier 0 | forty-third-pass:133 | create 与 reassign 都被拒 | S1-A |
| B-228 | 声明为依赖的 active 卡不制造假 scope 冲突 | forty-third-pass:169 | b 不报 `scope-conflict:a`；无依赖真冲突仍报 | S1-A |
| B-229 | waiting_resolve 支持 `superseded`+`superseded_by` | forty-third-pass:283 | closedReason=superseded；缺 supersededBy 抛错 | S1-B |
| B-230 | 相位出边与 reopen 恢复动作可见 | forty-third-pass:232 | blocked 含 room-discussion，恢复动作=['reopen'] | S1-A |
| B-231 | scheduler advice 具名停滞任务与 executorInactive | forty-third-pass:256 | `stalledTasks` 含 taskId/owner | S1-A |
| B-232 | decision 投递 message 可选 | forty-third-pass:283 | schema 无 required message | S1-A |
| B-234 | 只读完成卡可绑定 evidence（无 commit） | forty-third-pass:313 | `commit_sha:null` 绑定 evidence 成功；edit 卡仍需 40 位 commit | S1-A |
| D-新-3 | verifier 有平台管理的 scratch 根 | twenty-second-pass:69 | 写 `DSH_HOME\verifier-scratch\...` 成功并读回；rig/产品路径仍拒 | S1-C（verifier 成员，真实写钩子） |
| D-新-4 | 跨板 blocker 明确拒绝 | twenty-second-pass:79 | `group-rig-t63 exists on group-rig`；失败 create 会留垃圾卡，需清 | S1-A |
| D-新-5 | 受控字段与普通字段混合 edit 明确拒绝 | twenty-second-pass:91 | `atomic=true`、`unappliedFields=['description']`，description 未被写入 | S1-A |
| 第 4 号 | 超大 task deliverable 不再撑爆 safety-critical 上下文 | v14-identity-context.test.mjs:284 | preview 4096 字符、debt=false、failClosed=false、fetch 保留 | S3 |
| 第 6 号 | owner 回收不取消仍存活 Session 的 running job | thirty-ninth-pass:73-106 | 回收后 job 仍 running 可 read，仅 session/disposed 才 cancelled | S4 |

注意：测试里 `B-182b` 是批次 182 的死信退役，不是台账 B-182（等待票）。B-185 在批次 47 文档与台账 1879 编号冲突，不列入本方案。

## 2. 场景细节

### S0：进程内复跑（先做，几分钟，无宿主）
- 命令形态：对上表的 8 个测试文件（twenty-second、twenty-seventh、twenty-eighth、twenty-ninth、thirty-third～thirty-sixth、thirty-ninth、forty-third、fourth、v14-identity-context）串行 `node --test`，加上台账第 79 轮的 `platform-defects-forty-fifth-pass` 与 profile parity。测试只读 import 生产插件，在临时目录里建 git 仓。
- 判据：全绿即“代码级无回退”；有红灯则立刻标出是哪次部署（10-06/10-07/10-12）带来的。
- 已知限制：硬编码 base 路径为生产 `web` 插件目录，所以不需要改写；`thirty-ninth` 依赖 app node_modules 路径。

### S1：控制面与权限（一个隔离 Team，三轮清单）
成员：lead（tier 0）、lead-a（tier 1，group g）、a1（tier 2，group g）、v1（tier 2，group verifier）；板：global + group-g；隔离工作区里有一个真实 git 仓。
- **A 轮（板与相位，无需计划）**：B-227 → B-207 → B-228 → B-186（a1 claim → advance_phase integrated 被拒 → lead 放行 → reopen accepted 卡）→ B-230 → B-231 → B-232 → B-234 → D-新-4 → D-新-5。
- **B 轮（等待票与要求）**：B-182（external/dependency/legacy 三种票，推进任务到终态后 waiting_list）→ B-190（三种 approval 票，再批准一个无关计划）→ B-229 → B-220 → B-183（范围内、空 scope、跨板）。每组用独立任务，避免 reconcile 的全局扫描互相污染。
- **C 轮（计划、租约、git、守卫）**：B-187（plan_propose → approve → 租约 → evidence → complete）→ B-192（worktree 内未暂存修改、main 前进后建 worktree）→ B-210 → B-213/B-213b/B-219（成员用 pwsh 执行五种写形态，读拒绝串）→ D-新-3（v1 写 verifier-scratch 并读回，再试 rig 与产品路径）。
- 每一步只做“一次工具调用 + 原样回报返回值”，禁止模型自行总结；通过判据由收集脚本对 `requests.jsonl`/会话 jsonl 里的工具返回文本做字符串断言，不由模型判断。

### S2：重启与投递（同一隔离 home，宿主两次）
- 运行 1：建一个成员并让其变 inactive/冻结；对它发 `info` 与 `action`；创建 dispatch 到不存在成员（`missing-member`）并推进到 timed-out；制造若干已 ack 的 wake（B-221 的前置）。随后写 stop 文件停宿主。
- 运行 2（`--run r2`，同一 home）：宿主重启，观察 ①控制面水合后 acked 行是否被复活（B-221）；②timed-out 死信由 tier 0 退役为 expired、tier 1 被拒（批次 182）；③对 inactive 成员发 `action` 是否冷启动（B-222，台账 1836 已 live 观察，这里只是附带确认）；④之前留下的 queued 行是否自动续投到原目标，还是“指向旧目标”（41 小时探针，见第 6 节）。
- 这一场景必须单独，不与 S1 共用控制面状态。

### S3 + S4：超大 deliverable 与后台作业（同一宿主、不同会话）
- S3：group world 的 tier 2 成员，一张任务带 64,475 字符 deliverable（合成数据）。判据取自请求里 task 上下文的 preview/debt/failClosed 字段与 `task_contract_get` 全量取回。台账 2058 说明原始 live 反例是 root 把 deliverable 缩到 632 字符绕过的，所以这里需要真正喂大数据。
- S4：一个非 Team 会话，turn 1 启动一个 90 秒的后台作业，turn 2 读取其状态与输出。测试里只覆盖回收逻辑，live 判据是“turn 之间作业仍 running、可 read”。

## 3. 隔离方式

| 项 | 做法 | 理由 |
|---|---|---|
| 驱动 | 复制 `claude/project-thread-qfam5f` 上的 `output\constraint-ledger-team-20261012\driver\team-host.mjs` 和 `output\strict-plan-live-20261012\driver\{plan-host,native-overlay,watch.sh}`（worktree：`.claude\worktrees\hungry-aryabhata-59fbb8`）到新输出目录，去掉 staging overlay，**只用生产 profile 插件原样**；port 参数化 | 现有两个驱动要么换入 staging 插件，要么写死 40124 |
| 端口 | 用 **40125**（启动前检查无监听），不用 40124 | 驱动不检查端口占用；“项目续推准备”线程也会用 40124 |
| DSH_HOME | 每次 `--prepare --name <新名>`（目录已存在会报 `ISOLATED_OUTPUT_EXISTS`），只放 profile、配置、凭据副本，不复制生产会话 | 不继承生产 747 个会话和 RustMc Team 根，宿主启动不会唤醒它们 |
| 工作区 | 隔离根下新建的空 git 仓（team/strict 驱动已是这样），不指向 `D:\dsh-test\workspaces\*` | 已知坑：隔离的只有 DSH_HOME，指向真实工作区的会话会改真实文件 |
| 权限 | `cordis.patch.yml` 里 preset 从 `danger-full-access` 换成 `workspace-write`，并断言替换成功（沿用驱动里的 `PERMISSION_PATCH_FAILED` 检查） | 材料里没有更严格的“只读”preset；越界写会弹批准，无人批准就卡住，不会落盘 |
| 压缩坑 | 全部用**新建小会话**，不复制那个约 49% 上下文的大根；S3 的 64k 字符约 1.6 万 token，远低于 50% 主动压缩线 | 已知坑针对“大根副本一回合后越 50% 线自动 compact 并让模型去调工具” |
| 凭据 | 驱动会把生产 `.credentials.yaml` 复制进隔离 home。按凭据处理：目录不入库，收尾后删除副本 | 模型请求需要 |
| 预加载 | 一律用命令行 `--import`，不用 `NODE_OPTIONS` | 已知坑：`NODE_OPTIONS` 会传给沙箱子进程使实测作废 |
| 停止 | 每次启动都设 `--minutes 40 --max-requests 400`，并留 `<root>\stop` 文件手动停；停后核对端口无监听、生产签名未变 | 驱动没有空闲检测，空闲判断靠人 |
| junction | 隔离根的 `app` 与 profile `node_modules` 是指向生产的 junction，宿主不得写入；启动前后各记一次生产签名（驱动已支持） | 写进去就是改生产 |
| 串行 | 所有宿主运行串行；S0 与宿主运行也不并行 | `lab-host-home` 与 full 回归共用，并行出现过 `HOST_WRITER_BUSY` |

## 4. 运行次数与预算

| 运行 | 次数 | 单次上限 | 备注 |
|---|---:|---|---|
| S0 进程内复跑 | 1 | 几分钟，无请求 | 先做；失败则先查回退再决定是否继续 |
| S1 控制面 | 1（预计重跑 1 次） | 40 分钟 / 400 请求 | 模型可能在多步清单里跑偏，重跑只补没通过的轮 |
| S2 重启（r1 + r2） | 2（可能 +1） | 各 30 分钟 / 200 请求 | 同一 home，`--run r2` |
| S3 + S4 | 1（可能 +1） | 30 分钟 / 200 请求 | 两个独立会话 |
| 合计 | 宿主运行 4 次起，最多约 7 次 | 请求总量最多约 2,000 | DeepSeek 额度不是约束 |

Claude 侧成本：建议派一个 Sonnet medium 的 worker 负责“准备 → 启动 → 经 RPC 注入清单 → 收集”，主会话只做验收；清单 prompt 与断言脚本只写一次。预计主会话约 10 个来回，worker 每次运行 3–5 个来回。模型名与 route 在 prepare 时从生产配置读取，两份旧材料都没写出具体模型名，需要执行时确认。

## 5. 观测、判定与收尾

- 观测：`requests.jsonl` 的 terminal 事件、会话 jsonl 里的工具返回、`<run>-host.log`、控制面落盘文件、usage ledger。
- 判定规则（每项一行）：
  - **关闭**：S0 绿，且 S1/S2/S3/S4 中该项的字符串断言通过，且返回值里的拒绝码/字段与上表一致。
  - **复现**：断言显示修复前行为（例如 tier 2 能推进到 integrated、opaque 票被清）。记下原始工具返回，不当场修。
  - **不确定**：模型没按清单执行、中途压缩或超时。不记为关闭。
- 收尾：停宿主；核对 40125 无监听、真实工作区 HEAD 与生产签名未变；把结果写入 `docs\live-replay-result-<日期>.md`，并把关闭项回填 `unfinished-summary` 第二节 #1 和台账；隔离副本保留为证据，凭据副本删除。

## 6. 41 小时 queued 停滞：假设性探针，不保证复现

已知事实（台账 1786/1810/1859/1898、batch148 文档 23/58 行）：“投递既不发生也不失败”，伴随“死信向旧接收者重试”“恢复后自动续投仍指向旧目标”。台账没有记录触发条件、旧接收者和消息 ID，也没有专门测试；`inbox_ack` 出口已在批次 149(c) 修过，不是根因。

S2 里的探针：向已 inactive/冻结的成员发 `action`，让 dispatch 进入 queued 后停宿主，重启后观察 queued 行是否推进、dispatch 重试的目标是否仍是旧接收者（可以在运行 1 与运行 2 之间重新分配成员的 parent 或 spawn 同名新成员来制造“旧目标”）。如果探针没复现，只能写“未能复现”，不能写“已修复”。

## 6.5 执行记录

- **S0 已做（2026-10-12）**：`phase11-tests` 里 14 个 platform-defects 文件（fourth、twenty-second～twenty-ninth 中的 5 个、thirty-third～thirty-seventh、thirty-ninth、forty-first、forty-third、forty-fifth）加 `v14-profile-parity`，串行共 71/71 通过，针对的是当前生产插件文件，只读 import。`v14-identity-context.test.mjs` 生产树版本 13/14：失败的是 `durable delivery receipts suppress a source after visible history is gone`（175 行），原因是该测试比生产插件旧——staging 同名测试在回执里多带了 `dispatch:{handedToAdapter…}`，对同一份生产插件（`cmp` 逐字节相同）14/14 通过；第 4 号的 `large task deliverables…` 用例两版都通过。结论：代码级没有回退，生产树里这份测试该用 staging 版覆盖（未改，需单独决定）。
- **S1 已做（2026-10-12 21:43–22:17Z，用户直接放行并自己跑了 `--prepare`）**：隔离宿主 `s1-a`、端口 40125、生产插件字节不变，A/B/C 三轮加 D/E 补测，23 项里 PASS 16、FAIL(复现) 1（D-新-3：verifier 写 `verifier-scratch` 被拒，scratch 例外在 live 未生效，根因未定位）、INCONCLUSIVE 6（B-187、B-192、B-228、B-231、B-230、D-新-5）。证据在 `D:\dsh-test\output\live-replay-20261012\s1-a\s1-result.md` 与 `s1-verdicts.json`；凭据副本已 `--cleanup` 删除。口径是 isolated-live，不是生产 live。
- **S2 / S3+S4 未执行**：2026-10-13 项目交接 GPT，接着做的步骤与命令见 `handoff-live-replay-20261013.md`。

## 7. 需要用户拍板的点

1. 端口用 40125（推荐）还是等 40124 空出来。
2. 允许驱动把生产凭据副本放进隔离 home（模型请求必需）。
3. 允许在隔离副本上使用真实模型请求，并确认模型/route（执行前从生产配置读出后给你确认）。
4. S0 是否单独先批：它不启动宿主、不发模型请求，只在当前生产插件上读取运行测试，建议立即做。
5. 这套驱动在分支 `claude/project-thread-qfam5f` 上，不在 main；复制进新输出目录后才会改，不会动那个分支。
