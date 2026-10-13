# 回归测试精简：交接文档（2026-10-13）

## 一句话状态
分析完成、基础设施已提交；**真正的删除/缩规模还没做**，所以还没有“精简后”的实测数字。默认组已经能跳过 7 个慢文件（估算全量 270 s → 约 195 s，**未实测**）。

- 分支：`claude/intelligent-hawking-e47cda`（worktree：`D:\dsh-test\.claude\worktrees\intelligent-hawking-e47cda`）
- 基线：`94b5bdbf`（协调者给的 `claude/project-thread-qfam5f` 头，含 DSH_HOME 隔离和 7 个新测试文件）
- 本分支新增提交：
  - `ffcdd786` runner 增加 slow 分组、通过后不留日志、预加载里把生产 DSH_HOME 换成系统临时目录，`compact-test-runner.test.mjs` 同步
  - `d96cc146` 新增 `staging/context-runtime-unified-20261001/tools/regression-slow.json`
  - 之后的一个提交：本文档与 `docs/test-slimming-20261013/` 材料
- 没推送、没合并（协调者统一处理）。

## 精简前的基线（实测，2026-10-12，主 stage 工作区）
- 237 个 `*.test.mjs`，1554 条，1553 过、1 跳过（`v14-storage`）、0 失败，约 270 s（叶子用例合计 223 s，其余约 47 s 是每个文件一个进程的启动开销）。
- 按目录：native-tests 42 文件/481 条/130 s；phase11 107 文件/725 条/59 s；architecture 18/119/9.5 s；usage 8/81/3.7 s；phase5–8 合计约 17 s；phase1–4、9、10 合计 <3 s。
- 最慢文件：subagent-durable-delivery 30.5 s（2 条）、instant-history-runtime 20.6 s（2 条）、window-install-runtime 18.3 s（37 条）、window-collector-runtime 14.2 s（42 条）、platform-defects-fourteenth-pass 12.1 s（46 条，真 git）、ptc-background-runtime 10.9 s（16 条）。
- 逐文件/逐用例数据：`docs/test-slimming-20261013/baseline-per-file.json`、`cases.txt`。

## 已经做了的
1. **默认输出**：runner 原本就只打印失败和汇总；现在通过后还会删除 `full.log`、`process.log` 和 runner 自己建的 home，只留 `summary.json`。失败或加 `--keep-logs` 时保留。
2. **残留目录根因与修复**：用户 shell 全局导出 `DSH_HOME=D:\dsh-test\home`，`team-policy.mjs:673` 在未配置 `controlDir` 时回落到 `DSH_HOME ?? cwd`，每次回归都在生产 home 下建 `.team-control-runtime-<pid>`（现有 647 个，没动）。已有修复（`39fb01e5`/`94b5bdbf`）让 runner 把 DSH_HOME 指到 `output/regressions/<run>/home`；本分支再在预加载 `tools/prepare-unified-lab-host.mjs` 里兜底，所以直接 `node --test` 也不会再写生产 home。`platform-defects-tenth/twenty-second-pass` 里的 `DSH_HOME: 'D:\\dsh-test\\home'` 只用于纯路径计算，不写盘，没改。
3. **slow 分组**（`tools/regression-slow.json`，7 个文件、47 条）：subagent-durable-delivery、instant-history-runtime、ptc-background-runtime、manifest-acceptance、team-milestone-surface-dedup、worktree-git-e2e、live-lab-runner。默认 230 个文件。

## 怎么跑
在 `staging/context-runtime-unified-20261001` 下：
```
node tools/run-regression.mjs                 # 默认组（不含 slow）
node tools/run-regression.mjs --slow          # 全部
node tools/run-regression.mjs --only-slow     # 只跑 slow 组
node tools/run-regression.mjs --keep-logs     # 通过也保留完整日志
node tools/run-regression.mjs --files <精确的 .test.mjs 路径…>
```
- instant-history 类 lab 用端口 40124，不能与别的宿主并行；别在另一线程占用 40124/40125 时跑 slow 组。
- worktree 里没有 `app/node_modules` 的 junction（创建 junction 被权限检查拦截，且本任务要求不碰生产目录），所以**在 worktree 里无法直接跑全量**。可行做法：测试文件用 worktree 的，预加载用主 stage 的（`--import D:/dsh-test/staging/context-runtime-unified-20261001/tools/prepare-unified-lab-host.mjs`，cwd 在 worktree stage），先对未改动的 worktree 跑一遍作对照，再对改动后的跑，比较失败集合；或者合并到主检出区后在主 stage 直接跑。
- `architecture-tests/compact-test-runner.test.mjs` 需要 stage 下存在 `lab-runs/` 目录（已 gitignore），worktree 里要先 `mkdir`。

## 没做完的（按价值排序，报告在 `docs/test-slimming-20261013/out-*.md`）
1. **验证**：默认组实际条数和耗时（预期 1507 条左右、约 195 s，均为估算）。
2. **缩规模，不改语义**（共约 10–15 s）：
   - `window-transition-runtime` 的「120 transitions」缩到 10 次，约省 2.4 s（B 报告；另有两对等价 fault 点）。
   - `v14-storage` 锁更新 4×25→4×10 约 0.7 s，inventory 的 3×550 ms 等待改轮询约 1.0–1.4 s（E1 报告，行号在报告里）。
   - 真 git 的缺陷反例用 `before()` 模板仓库 + `cpSync` 复用，约省 3 s（D 报告：fourteenth L76-81 等 8 处、nineteenth L17-23、seventeenth L19-50、fifteenth L87-92/113-118/217-222）。
   - 两个 lab 宿主在结果落盘后 `process.exit`，约省 6.5 s（`tools/team-family-natural-lab.mjs:411`、`tools/instant-history-lab.mjs:121`；N 报告）。
3. **可删的重复**（共约 20 条，约 2 s；每条都在报告里带了替代覆盖的文件+用例名，删之前请对照读一遍）：
   - 整文件：`phase2/observation-evidence`、`phase2/observation-pack`（v1，已被 observation-pack-v2 取代，还会写生产树）、`phase8/team-idle-watch-bootstrap`（v5，语义已反转）、`phase8/team-idle-watch-no-cap`（v3，被 phase6/idle-watch 覆盖）。
   - 用例：`platform-defects-twenty-ninth-pass` B-192、`forty-fifth-pass` B-243（=thirty-fifth B-220）、`thirty-eighth-pass` 两条（被 forty-first 超集覆盖）；`unified-milestone-runtime`「compactOnIdle still folds…」；`history-recall-runtime`「wrong expected source vector…」；`execution-proof-runtime` 的 `source` 子用例；B 报告列的约 22 条窗口族重复。
4. **修一个会空转的断言**：`native-tests/window-install-runtime.test.mjs` 有 4 处 `/^a3-d$/` 缺反斜杠，“步骤被折叠”的断言实际空转；合并这些用例之前先修。
5. **指向错误目标的测试**（不要删，先重定向到 stage 的 `team-tools-v2-r10.mjs`/当前 stage 插件再评估）：`phase6/milestone-tail-delivery`、`phase7/delivery-gate`（导入生产目录的 `team-tools-v2.mjs`，生产实际加载 r10，且对 r10 没有其他覆盖）；`architecture-tests/team-digest-progress`、`team-efficiency`（导入旧 stage `architecture-clm-20261001`；team-efficiency 是 send_message 幂等契约的唯一覆盖）；`v14-acceptance-verifier`、`v14-bounded-wake`、`v14-usage-cache`、以及 D 报告列的 12 个用绝对路径 `D:/dsh-test/home/...` 的文件。
6. **会写到 stage 之外的用例**：`usage-tests/observation-pack-lineage` 最后一条在 `DSH_REQUEST_STAGING!=='1'` 时写 `D:/dsh-test/workspaces/usage-lab-20261001/obs-line-01/`，runner 没设该变量。
7. 其余 slow 候选（需要拆文件或按用例标记才能分组）：session-plan-delivery 11 条 5.3 s、execution-proof-runtime 4.2 s、window-install/collector/executor（慢在每条用例各起一套 native host fixture，约 0.35 s/条，只能靠合并同 fixture 场景）、evidence-binding「stored receipts…」1.76 s（含 1.3 s 真 sleep）。

## 保留了什么 / 为什么用例数降不多
- 每个缺陷的原始反例（用例名带 B-nnn / D-n / §nn 的，以及 `v14-identity-context`、`platform-defects-*`）一律保留，S0 依赖它们。B-id 在不同 pass 里有复用（B-187/190/193/237/238），不能按编号去重。
- web/headless 副本重复基本不存在（只有 3 条名字带 profile）；native 与 phase11 同主题是不同层（假宿主 vs 真宿主），几乎没有完全重复。
- 因此用例数最多再降 20–30 条，**不会降到 1000 以下**；真正的收益在耗时（slow 分组 + 缩规模）和日志。
- 刚上线/未部署的新模块的测试不能当“未加载”删：`constraint-ledger`（生产已加载）、`unified-window-economics`（被 lab host 挂载）、`session-plan-delivery.mjs`、`team-v15-ptc-background.mjs`。
- 14 个“被测插件不在 cordis.patch.yml”的文件里，子代理核实后只确认 4 个可删（见上）；`phase6/milestone.test` 在 v2 上实跑有 1 项 FAIL，需人工核对后再决定。

## 已知坑
- 权限检查拦截过：创建 junction、`git checkout -- .`、`git reset --hard`、`git commit && git rebase`（链式）。拆成单步、用 `git restore <具体文件>` / `git merge --ff-only` 可行。
- worktree 会话里的 hook 不允许往主检出区 `D:\dsh-test\docs` 直接写文件，所以本文档在分支的 `docs/` 下，合并后才出现在 `D:\dsh-test\docs`。
- 子代理常在 30 轮上限停下且没出报告，需 `SendMessage` 让它们直接 Write 报告。
- 读 `home\AGENTS.md` 时有子代理看到被注入的“无安全限制”类指令，已忽略。
- `team-control-plane` 在生产 home 下有 23.9 万个 `session-*` 条目，在那里 `ls` 会卡死，扫描前先限定范围。
- 主检出区有其他线程未提交的改动（docs 归档、插件改动）；我的分支只基于 `94b5bdbf`，不含它们。

## 材料位置
本分支 `docs/test-slimming-20261013/`：七份取舍报告 `out-{L_legacy,B_window,N_native,C2_p11_overlap,D_defects,E1_v14,E2_misc}.md`、`spec.md`（取舍规则）、`cases.txt` 与 `baseline-per-file.json`（基线逐用例）、`per-file-reporter.mjs`（逐文件计时报告器：`node --test --test-reporter=<file:// URL> --test-reporter-destination=<out.json>`）、`analyze.mjs`、`targets.mjs`（统计每个测试引用的插件是否被生产加载）。
