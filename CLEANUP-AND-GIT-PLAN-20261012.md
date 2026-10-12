# dsh-test 清理与上传方案（待确认，尚未删除或提交任何东西）

盘点时间：2026-10-12。根目录合计约 240 GB、约 150 万个文件；D 盘只剩约 40 GB 可用。
体积全部是实测；“是否仍被引用”依据 `docs/context-runtime-unified-20261001/CLAUDE-HANDOFF-20261011.md`。

## 一、清理清单

### A. 建议删除：可再生的构建产物和已无改动的旧验证克隆（约 38 GB）

| 路径 | 体积 | 说明 |
|---|---|---|
| `targets/` | 21.9 GB | 9 月 23–26 日的 cargo 构建输出（g-boot-build 13.7 GB 等） |
| `tmp/` | 12.0 GB | 9 月下旬的验证克隆 v-core* / v-net* / v-nbt* 和 rigb target |
| `cargo-target-t61-*`、`cargo-target-t69-verify`（5 个） | 1.66 GB | cargo 构建输出 |
| `tmp-t93-target/` | 0.54 GB | cargo 构建输出 |
| `rig-check/` | 0.25 GB | 9 月 27 日的检查产物 |
| `.t33-clone-after/before/parent/parent2` | 0.68 GB | RustMc 的本地克隆，工作区均干净，origin 就是 `workspaces/RustMc` |
| `wt-t6-negctl/`、`wt-t69-verify/` | 0.60 GB | git worktree，均无未提交改动 |
| `home/verifier-target-w3/`、`home/rig-trace-cargo-target/` | 0.23 GB | 构建输出 |
| `harness-T78Dig-*.jsonl`、`harness-T81Dig-*.jsonl` | 91 MB | 9 月 26 日的一次性抓取日志 |
| `tools/godot47.zip` | 82 MB | 已解压到 `tools/godot/` |
| 根目录 `.team-control-runtime-<pid>`（约 188 个） | <20 MB | 进程已不存在的运行时残留；另有 5 个 PID 与现存进程重号，先不动 |
| 根目录 `tmp-desktop-*.png`、`tmp-devtools-*.png` 等截图 | 约 1 MB | 9 月 24 日的调试截图 |

需要先看一眼再定：`wt-verifier-9fae1eb1/`（1.59 GB）有 1 处未提交改动，删之前我会把那处改动列给你。

### B. 建议删除：含登录数据的浏览器档案（约 0.66 GB）

`edgeprofile/`（513 MB，含 Cookies 和 Login Data）、`edgeprof/`、`.playwright-cli/`、`tmp-dsh-desktop-leveldb-copy/`。
这些是测试用的浏览器档案，留着只有泄露风险。无论删不删，都不会进 git。

### C. 体积最大但我不建议现在动：工作区里的 agent worktree（约 118 GB）

| 路径 | 体积 |
|---|---|
| `workspaces/mc189-rs/.dsh-worktrees/` | 69.3 GB |
| `workspaces/RustMc/.dsh-worktrees/` | 30.0 GB |
| `workspaces/RustMc/.local/` | 14.7 GB |
| `workspaces/test/.dsh-worktrees/` | 3.2 GB |

交接文档明确写了“不碰 RustMc”。这些 worktree 里可能有未合并的分支，我还没有逐个检查。
如果你想腾空间，稳妥做法是只删其中的 `target/` 构建目录（源码和分支都保留），我先逐个核对再给你数字。

### D. 保留不动

- `home/`（51.9 GB）：生产运行数据。`team-control-plane/` 39 GB、`sessions/`、`spill/`、`evidence-archive/`、`usage-ledger/`。交接文档禁止清理 session、cold refs、telemetry。
- `backups/`（268 个目录，200 MB）和根目录 `backup-*`（约 30 MB）：部署回滚链 `deploy-previous-chronological.txt` 依赖它们，体积也很小。
- `output/`（274 MB）、`staging/.../lab-runs/`（754 MB）、`staging/.../lab-host-home/`：最新验收证据，交接文档逐条引用。
- `docs/usage-audit-20261001/` 的 4 个请求历史 jsonl（938 MB）：审计原始数据，保留在本地，不进 git。
- `app/node_modules/`（1.65 GB）：生产运行时，`staging/.../node_modules` 是指向它的 junction，不是副本。
- `tools/godot/`（3.4 GB）、`tools/chrome-for-testing/`、`perlica-bike/`（3.3 GB）、`mc-client/`、`workspaces/cod_clone`（有 144 处未提交改动）：不属于 harness，但仍可能在用，不进 git。

## 二、密钥扫描结果

- `home/.credentials.yaml` 含 6 个 API key（DEEPSEEK / DS / GPT / OPENCODEGO / CMD / DD）和 DeepSeek 账号 token、浏览器会话 secret。
  同类文件另有 6 处副本：`output/window-isolated-live-20261011/home/`、`home-alpha7-smoke/`、`perf-verify-home/`、`tmp-host-probe/home/`、`staging/.../lab-host-home/`、`backup-desktop-home-switch-20260925-080916/`。
- 其他敏感文件：`home/tmp-dsh-session-auth.xml`、多份 `settings.yaml*`、`dumpcfg-*.txt`、`logs/` 下 3 个 smoke 日志（命中 token 特征）、浏览器档案。
- 待提交的源码、测试、文档中没有命中 `sk-`、`ghp_`、`Bearer`、私钥头等特征（最初命中的都是 `task-scope-…` 这类标识符的误报，已复核）。
- 提交前我会再做一次“按真实密钥值反查”：把 `.credentials.yaml` 里的值逐个在暂存区里搜索，命中即中止。

以上全部通过 `.gitignore` 白名单方式排除：默认忽略一切，只放行下面列出的路径。

## 三、计划提交到 GitHub 的内容（预计 2–3 千个文件、约 40 MB）

| 路径 | 内容 |
|---|---|
| `docs/` | 设计、台账、交接、验收报告（去掉 4 个 jsonl 和 `docs.7z`） |
| `staging/context-runtime-unified-20261001/` | 当前施工根：`native-tests/`、`phase*-tests/`、`architecture-tests/`、`usage-tests/`、`tools/*.mjs`、三个 change manifest、`home/profiles/*/plugins`、`app/node_modules/@deepseek-ai` 下被修改的 622 个文件（6.5 MB） |
| `staging/architecture-clm-20261001/` | 3.8 MB 的上一轮 staging |
| `home/profiles/web/` 和 `headless/` | 生产插件 `plugins/`、`patches/`、`cordis.patch.yml`、`presets/`；不含 `node_modules` 和 `*.bak-*`（`desktop` 是指向 `web` 的 junction，不重复提交） |
| `home/AGENTS.md` | |
| `app/` | `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`patches/`、`scripts/` |
| 根目录 | `phase*-tests/`、`architecture-tests/`、`usage-tests/`、`tools/` 下的脚本、`patch/`、`launch-dsh-test.cjs` 等 `.cjs/.mjs/.ps1/.bat/.md/.yml` |

不提交：`workspaces/`、`home/` 的其余部分、`backups/`、`output/`、`lab-runs/`、所有 `node_modules`（上面那 622 个改动文件除外）、根目录零散的 `.txt/.png/.log/.jsonl/.bin/.lnk`。

两点需要你知道：

1. 生产 `app/node_modules/@deepseek-ai`（239 MB、5984 个文件）默认不提交，只提交 staging 里被改过的 622 个文件和 `app/patches/`。代价是：仅凭仓库不能还原生产目录，还需要按 `pnpm-lock.yaml` 重新安装再套补丁。
2. 仓库里会有 DeepSeek 官方包的代码（被修改的那部分）。上游 `deepseek-ai/deepseek-harness` 是 MIT 许可的公开仓库，许可上允许公开；是否公开取决于你是否介意文档和台账里的本机路径、会话 ID 等运行细节。

## 五、执行结果（2026-10-12）

- A 类已删除，D 盘可用空间 42 GB → 74 GB。`wt-verifier-9fae1eb1/` 因有未提交改动保留；B、C 类未动。
- 仓库：https://github.com/wdsewdser-bit/dsh-harness （私有），首个提交 2278 个文件。
- 提交前用 `.credentials.yaml` 的真实值反查暂存区，零命中。

## 四、GitHub

- GitHub 没有“不公开但凭链接可见”的模式；私有仓库就是你要的效果：搜不到、看不到，只有你邀请的人能访问。
- 本机 git 2.54 已装，`gh` 未装。建议用 `winget install GitHub.cli` 安装，然后 `gh auth login --web` 在 Edge 里点一下授权。
- 仓库名建议 `dsh-harness`，私有。
