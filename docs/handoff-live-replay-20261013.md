# 交接：25 项缺陷隔离副本重放（S0、S1 已做，S2、S3+S4 未做）

日期：2026-10-13。接手方：GPT。前置材料：`live-replay-plan-20261012.md`（方案全文，第 6.5 节有 S0 记录）、`unfinished-summary-20261012.md`（第二节 #1、#2）。

## 1. 一句话现状

- **S0 做完**：原始反例测试在当前生产插件上 71/71 通过，代码级没有回退。
- **S1 做完**：隔离宿主跑了 A/B/C 三轮加 D/E 两个补测轮，23 项里 **16 通过、1 复现（D-新-3）、6 无法判定**。
- **S2（重启与投递）、S3+S4（超大 deliverable、后台作业）没做**。
- 宿主已停，40123/40124/40125 均无监听，凭据副本已删除（`cleanup.json` 里 `credentialCopyDeleted=true`），生产目录、真实工作区、6 个关键插件哈希启动前后都没变。

口径：以上都是 **isolated-live**（隔离 home、生产插件字节不变、真实模型请求），不等同于“生产 live”，不要在台账里写成生产已验证。

## 2. 已经做了什么

| 步骤 | 做法 | 产物 |
|---|---|---|
| S0 | `phase11-tests` 里 14 个 platform-defects 文件 + `v14-profile-parity` 串行 `node --test`，只读 import 生产插件 | 71/71 通过；记录在方案第 6.5 节 |
| S1 准备 | `s1-host.mjs --prepare --name s1-a`（用户在自己终端跑的，因为凭据复制会被 Claude Code 的权限检查拦） | `D:\dsh-test\output\live-replay-20261012\s1-a\prepare.json` |
| S1 运行 | `s1-host.mjs --start --name s1-a`，端口 40125，40 分钟/400 请求；`s1-rpc.mjs` 建 tier 0 会话并逐轮发清单 A、B、C、D、E | `s1-a\requests.jsonl`（终态请求 273）、`tool-events.jsonl`、`rounds.log` |
| S1 判定 | `s1-collect.mjs` 导出会话工具事件，`s1-assert.mjs` 对工具返回文本做字符串断言 | `s1-a\s1-result.md`、`s1-a\s1-verdicts.json` |
| 收尾 | stop 文件停宿主，核对端口、生产签名、HEAD、插件哈希，`--cleanup` 删凭据副本 | `s1-a\state.json`（status=stopped，reason=requested-stop）、`s1-a\cleanup.json` |

模型配置（来自生产 `cordis.patch.yml` 的 `agent-default-model`）：provider `opencodego`，model `deepseek-v4.1-flash`，reasoningEffort `high`；会话 agentPreset 为 `standard`。

## 3. S1 结果

### 通过（16）
B-227、B-207、B-186（tier 2 推进到 integrated 被拒 `phase-owner-terminal`）、B-186（edit 卡 accepted 后 reopen 回 pending/execution）、B-232、B-234、D-新-4、B-182（external/dependency 票在任务完成后保持 open）、B-190（opaque 票保持 open，planId 票 `plan-approved` 关闭）、B-229（D 轮只传 ticket_id 后通过）、B-220（同任务只有 1 张票）、B-183、B-210（同 owner 第二张卡 `plan-proposed`）、B-213、B-213b、B-219。

### 复现（1）：D-新-3
v1（tier 1、group verifier）写 `<home>\verifier-scratch\t55\probe.txt` 被拒，原样返回：

```
Error: write denied: member "v1" has no declared static scope or active approved plan lease for (D:\dsh-test\output\live-replay-20261012\s1-a\home\verifier-scratch\t55\probe.txt); active lease: none
```

含义：verifier 的平台 scratch 例外在真实进程里没生效。原始测试 `phase11-tests\platform-defects-twenty-second-pass.test.mjs:69` 是进程内通过的。**根因没有定位**，worker 的猜测：live 的 membership 对象不带 `group`，或 `DSH_HOME` 形态（大小写、斜杠）与测试夹具不同。

接着做：
1. 在 `D:\dsh-test\home\profiles\web\plugins\write-scope-guard.mjs` 里 grep `verifier-scratch`，找出判定条件（成员 group/role、`DSH_HOME` 取值、路径规范化），对照 live 会话里 v1 的实际成员记录（用 `team_members` 或等价只读工具读出）。
2. 在隔离副本里插桩定位（不要改生产文件；复制到隔离 home 的 `profiles\web\plugins\` 里改，改完在结果里标明“这是改过的副本”）。
3. 若确认是生产代码缺陷，这是一个**新缺陷**，交协调者另立任务，不在本线程里修生产。

### 无法判定（6）
| 项 | 为什么没判 | 接着怎么做 |
|---|---|---|
| B-187 | 需要完整“计划提案 → 批准 → 租约 → evidence → complete”流程，S1 没走到 | 在 C 轮清单里补全，成员必须在隔离仓的 worktree 里，且 integration-ready 阶段 complete 后应保持该相位 |
| B-192 | 需要 worktree 内未暂存修改且 main 前进后再建 worktree | 同上，判据是 `preservedTrackedUnstaged` 值为 `[' M local.txt']`（保留前导空格） |
| B-228 | 纯调度函数，需要“依赖一张 active 卡”的场景 | 布置 a 卡 active、b 卡声明依赖 a，看 b 是否不再报 `scope-conflict:a`；布置不出来就引用 S0 的进程内通过作为证据，并标注 live 未复核 |
| B-231 | scheduler advice 要有“具名停滞任务 + executorInactive”，需要活跃租约卡且 owner inactive | 先让 owner 成员变 inactive（停掉其会话），再读 advice 里 `stalledTasks`；同 B-228 的退路 |
| B-230 | `team_task_get` 输出不带相位出边和恢复动作 | 先 grep 生产 `team-tools-v2-r10.mjs`，确认这些字段由哪个工具返回（可能不是 `team_task_get`），改用对应工具再判；若确认任何工具都不返回，则可能是真缺陷 |
| D-新-5 | 混合 edit 被整体拒绝且 description 未落盘（没有静默丢字段），但拒绝原因文本是 `task-scope-recovery-actor` / `owner-active` 分支，不含 `atomic` / “no fields were applied” | 换一个非 owner 且不触发 recovery-actor 的调用者重做一次，目标分支是“受控字段与普通字段混合”；若仍进错误分支，写成文本偏差而非缺陷 |

## 4. 没做完的：S2、S3+S4（命令与步骤）

### 先决条件：凭据副本
凭据副本已删。Claude Code 的权限检查会拦截“把 `D:\dsh-test\home\.credentials.yaml` 复制进隔离 home”（理由 `[Sensitive-Source Provenance]`），**需要用户在自己的终端里跑 `--prepare`**；否则要在 Claude Code 设置里给该命令加放行规则。这是已知行为，不要尝试绕过。

### S2：重启与投递（新建独立 home，宿主两次）
方案第 2 节的 S2 不与 S1 共用控制面状态，所以用新名字：

```bash
# 用户在自己终端：准备（会复制凭据副本）
node "D:\dsh-test\.claude\worktrees\frosty-kalam-3f90fc\output\live-replay-20261012\driver\s1-host.mjs" --prepare --name s2-a
# 运行 1（后台，40 分钟 / 400 请求上限）
node ...\driver\s1-host.mjs --start --name s2-a --port 40125 --minutes 40 --max-requests 400
# 经 RPC 建会话并发清单（见下面“驱动用法”），做完创建 stop 文件停宿主
# 运行 2：同一 home 重启
node ...\driver\s1-host.mjs --start --name s2-a --run r2 --port 40125 --minutes 40 --max-requests 400
```

运行 1 要做：建一个成员并让它 inactive/冻结；对它发 `info` 与 `action`；创建 dispatch 到不存在成员（`missing-member`）推进到 timed-out；制造若干已 ack 的 wake；然后停宿主。
运行 2 要观察：①acked 行是否被复活（B-221，应保持 handled，无同 dedupeKey 风暴）；②timed-out 死信 tier 0 能退役为 expired、tier 1 被拒（批次 182）；③对 inactive 成员发 `action` 是否冷启动（B-222，附带）；④运行 1 留下的 queued 行是否续投到原目标，还是“指向旧目标”（41 小时探针）。

**41 小时 queued 停滞是假设性探针**：台账没有记录触发条件、旧接收者和消息 ID，探针没复现时只能写“未能复现”，不能写“已修复”。可以在运行 1 与运行 2 之间重新分配成员的 parent 或 spawn 同名新成员来制造“旧目标”。

### S3 + S4（同一宿主、两个独立会话）
- S3：group world 的 tier 2 成员，一张任务带 64,475 字符 deliverable（合成数据，必须真正喂大数据，因为原始 live 反例是 root 把 deliverable 缩到 632 字符绕过的）。判据：请求里 task 上下文 preview 4096 字符、`debt=false`、`failClosed=false`，`task_contract_get` 能全量取回。
- S4：一个非 Team 会话，turn 1 启动 90 秒后台作业，turn 2 读取状态与输出；判据是 turn 之间作业仍 running、可 read，仅 session/disposed 才 cancelled。
- 这两个都要自己写清单（`prompts\` 里没有），断言脚本仿 `s1-assert.mjs`。

### 驱动用法
目录：`D:\dsh-test\.claude\worktrees\frosty-kalam-3f90fc\output\live-replay-20261012\driver\`

| 文件 | 用法 |
|---|---|
| `s1-host.mjs` | `--prepare|--start|--cleanup --name <n> [--run r2] [--port 40125] [--minutes 40] [--max-requests 400]`。隔离根在 `D:/dsh-test/output/live-replay-20261012/<n>/`；`--start` 前检查 40123/40124/端口无监听，并每 5 秒核对生产签名（变了就自停） |
| `s1-rpc.mjs` | `create --name <n>`（写 `<root>\session.json`）；`send --name <n> --file <txt>`；`wait --name <n> --max 900 --quiet 120 --baseline <requests.jsonl 行数>`；`rounds --name <n> --rounds A,B,C --dir <prompts 目录>`。`session.json` 已存在会复用旧会话，换会话先删 |
| `s1-collect.mjs` | `--name <n>`：把会话 jsonl（zstd）导出为 `<root>\tool-events.jsonl` |
| `s1-assert.mjs` | `--name <n>`：字符串断言，生成 `s1-result.md` 与 `s1-verdicts.json`；**重跑会覆盖 `s1-result.md` 末尾手写补充，先备份** |
| `prompts\A..E.txt` | S1 各轮清单原文（A 板与相位，B 等待票，C 计划租约 git 守卫，D/E 补测） |

## 5. 路径清单

| 内容 | 路径 |
|---|---|
| 方案 | `D:\dsh-test\docs\live-replay-plan-20261012.md`（worktree 同名副本在 `D:\dsh-test\.claude\worktrees\frosty-kalam-3f90fc\docs\`） |
| 未完成汇总 | `D:\dsh-test\docs\unfinished-summary-20261012.md` |
| 驱动与清单 | `D:\dsh-test\.claude\worktrees\frosty-kalam-3f90fc\output\live-replay-20261012\driver\`（`D:\dsh-test\output\live-replay-20261012\driver\` 是空目录，因为 Write 工具对 `D:\dsh-test\output\...` 有 hook 拦截） |
| S1 隔离根 | `D:\dsh-test\output\live-replay-20261012\s1-a\`（保留为证据；`home\` 里凭据已删） |
| S1 结果 | `...\s1-a\s1-result.md`、`...\s1-a\s1-verdicts.json`、`...\s1-a\tool-events.jsonl`、`...\s1-a\requests.jsonl` |
| 原始反例测试 | `D:\dsh-test\phase11-tests\platform-defects-*-pass.test.mjs`、`v14-identity-context.test.mjs`、`v14-profile-parity.test.mjs` |
| 生产插件（只读） | `D:\dsh-test\home\profiles\web\plugins\` |
| 台账 | `D:\dsh-test\docs\agent-team-platform-defects-fix-ledger-20260927.md`、`platform-defects-batch148-root-result-20260930.md` |
| 参考驱动（只读） | `D:\dsh-test\.claude\worktrees\hungry-aryabhata-59fbb8\output\{constraint-ledger-team-20261012,strict-plan-live-20261012}\driver\`（分支 `claude/project-thread-qfam5f`） |

## 6. 端口与共享资源

- **40123**：生产宿主，不启动、不连接。
- **40124**：另一线程（项目续推准备）使用，驱动不检查它之外的占用，**不要用**。
- **40125**：本重放专用；每次启动前确认无监听。
- 宿主运行必须串行：`lab-host-home` 与 full 回归共用，并行出现过 `HOST_WRITER_BUSY`；S0 与宿主运行也不并行。
- 隔离根里的 `app` 与 profile `node_modules` 是指向生产的 junction，宿主不得写入；staging 的 `app\node_modules` 下不带 `-v15` 的包目录也是指向生产的 junction，写之前先 lstat/realpath。
- 真实工作区 `D:\dsh-test\workspaces\window-large2-20261008` HEAD 应为 `ab5de82`，收尾时核对。

## 7. 已知坑

1. **权限检查**：Claude Code 的 auto mode 分类器拦过三类操作：启动生产宿主（“生产部署”）、派 worker 创建隔离宿主（“不安全代理”，用户直接说“放行”后通过）、复制生产凭据进隔离 home（“敏感来源”，只能用户自己跑）。拦截后不要换方式绕过。
2. **Write 工具 hook**：对 `D:\dsh-test\output\...` 的写会被拦，要求改用 worktree 路径；node 脚本自己写该目录不受影响。
3. **工具层身份**：tier 0 只能直接给 tier 1 发消息，给 tier 2 要经 lead-a 转发。
4. **清单写法**：成员会自发处理 inbox 和 waiting ticket，清单里要写“忽略它们”；一步只做“一次具体工具调用 + 原样回报返回值”；B-229 在 B 轮曾因同时传 task_id 和 ticket_id 被拒（`waiting-task-and-ticket-ambiguous`），只传 ticket_id 才对。
5. **B-182 的 legacy(manual) 票**：waiting_set 必须带 `unblockCondition`，原测试里“无结构化条件”的票在 live 里构造不出，判据以 external/dependency 票保持 open 为主。
6. **宿主 40 分钟上限**：S1 约 34 分钟用完，S2 要重新开跑；没有空闲检测。
7. **压缩**：用新建小会话；不要复制那个约 49% 上下文的大根，它一回合后会越 50% 线自动 compact。
8. **`v14-identity-context.test.mjs`**：`D:\dsh-test\phase11-tests\` 下这份在生产树里是 13/14，失败的 `durable delivery receipts…`（175 行）是测试比 10-12 部署的插件旧；staging 同名测试对同一份生产插件（`cmp` 逐字节相同）14/14。生产树里那份该用 staging 版覆盖，这个动作**没做**，需要单独决定。
9. **预加载**：一律命令行 `--import`，不用 `NODE_OPTIONS`（会传给沙箱子进程）。
10. 凭据按敏感信息处理：不读出、不打印、不写进任何文档和提交；收尾 `--cleanup` 删副本，结果文件里写“已删除”。

## 8. 提交与合并

没有提交也没有推送。当前 worktree 里未跟踪的文件：`docs\live-replay-plan-20261012.md`、`docs\unfinished-summary-20261012.md`、本文件、`output\live-replay-20261012\`（驱动与清单，`.gitignore` 是白名单，需 `git add -f`）。用户要求：现有线程都完工后由协调者统一提交、合并、推送。
