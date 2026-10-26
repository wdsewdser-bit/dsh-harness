# DSH 0.1.7-alpha.1 → 0.1.7-alpha.2 升级计划

范围：`D:\dsh-test`。生产 `D:\dsh`（当前 `0.1.5-rc.1`）本次不动。

## 目标

把测试实例从 `0.1.7-alpha.1` 升到官方最新 `0.1.7-alpha.2`，保持我们全部本地能力可用：
Team 领域/工具/面板、Stagehand 浏览器、CUA、pi-ai（`in-history` 缓存策略）、preset、
启动器与 12GB 堆设置，并保证旧会话可继续打开。

## 版本事实（2026-09-23 核对）

- GitHub 最新 release：`dsh-v0.1.7-alpha.2`（2026-09-22 23:49 北京时间）。不存在 alpha.3。
- npm `alpha` dist-tag：`0.1.7-alpha.2`。
- 抽查 `dsh`、`dsh-base`、`dsh-web-app`、`dsh-headless`、`dsh-brand`、`dsh-util-values`、
  `dsh-mcp-client`、`dsh-subprocess`、`dsh-tool-pwsh`、`dsh-spill-policy`、
  `dsh-session-format-v3-to-v4`、`dsh-session-persistence-jsonl`、
  `dsh-experimental-agent-team-profile`：全部存在 `0.1.7-alpha.2`。
  monorepo 同步发版，`@deepseek-ai/dsh-*` 可整体替换版本号。
- 非 monorepo 的 vendor 包（`@deepseek-ai/cordis*`、`cosmokit`、`schemastery`）版本号独立，
  替换时必须只改 `0.1.7-alpha.1` 这个字面量，不得连带调整。

## alpha.2 变更与影响

对我们有直接收益：

1. 修复连续完成多个后台命令/一次性子代理任务后会话停住；**完成后唤醒默认无上限**，可选配上限。
   与我们之前手工放宽 `team-idle-watch` 上限的方向一致。
2. Agent Team 成员初始任务新增“查找队友 / 联系 Lead / 按成员名发消息”指引，减少模型忘记 `wake` 的情况。
3. 修复 Web 服务重启后“显示已连接但不再刷新回复”，重启后会恢复连接并保留历史与草稿。
   我们当前的 `token-url.cjs` + 启动脚本 workaround 可以保留，但不再是唯一补救手段。
4. 修复持久 PowerShell 命令完成后仍要额外等待（impact `minimal-zh-ptc` 的 persistent pwsh）。
5. 会话滚动跟随、历史分页、轮次跳转、代码块样式改善。
6. 工具结果按统一 token 预算保留首尾，并提供被省略内容的读取地址。

需要适配：

1. **`spill-policy` 破坏性变更**：`maxInlineBytes` → `maxInlineTokens`。
   我们自己的 profile patch 未覆盖该项（只有 `dsh-base` 自带默认值，新版自带新写法）；
   本地 `observation-pack` 用的是 `maxInlineChars`，不受影响。升级后复查一遍即可。
2. **四个 web 持久补丁 + 两个 headless 补丁必须以 alpha.2 源重建**，不能直接沿用 alpha.1 的 diff：
   - `dsh-experimental-agent-team`
   - `dsh-experimental-client-ui-agent-team`
   - `dsh-experimental-browser-use-stagehand-native`
   - `dsh-llm-pi-ai`
3. `app/pnpm-workspace.yaml`（282 行）、`profiles/{web,headless}/pnpm-workspace.yaml` 的
   `minimumReleaseAgeExclude` 与 `patchedDependencies` 需同步到 alpha.2。
4. `app/patches/` 三个会话兼容补丁（`session-format-v0-to-v1`、`v3-to-v4`、
   `session-persistence-jsonl`）需重新核对 alpha.2 源是否仍匹配。
5. 启动器 `--max-old-space-size=12288`、`start-dsh-test.bat` 的 token 重取逻辑必须保留。

## 前置条件

D 盘原先 0 可用，升级无法写入。已完成清理（仅删除旧备份与临时产物）：

- 删除：`dsh-test-backup-alpha1-20260917-230505`、`recovery-20260920`、
  `backup-inbox-recovery-20260919-050730`、`backup-context-prune-20260919-044226`、
  `dsh-test\tmp`（含 `cargo-target`、`scratch`）。
- 回收约 52.9 GB，清理后 D 盘可用约 46 GB。
- 未动：`workspaces`、`targets`、`Downloads`、`BaiduNetdiskDownload`、`app`、`home`、`tools`。
- 残留：`D:\dsh-test\tmp\t120`（约 3 MB）被两个残留 java 进程占用（MC 客户端 + golden server），未强杀。

## 执行步骤

1. 备份 `app` + `home` + 三个启动脚本到 `backup-alpha72-<时间戳>`，并写 `backup-alpha72-latest.txt`。
2. 建 `upgrade-alpha72-lab`，下载 alpha.1/alpha.2 源码 tarball，逐包 diff 被补丁改动的文件。
3. 按 diff 结果重建六个补丁；补丁目标未变时仅重命名并更新 key。
4. 全量替换 `0.1.7-alpha.1` → `0.1.7-alpha.2`（app、web、headless）。
5. `pnpm install`：app、profiles/web、profiles/headless。
6. 校验：三处 `--dump-config` exit 0；`compatibility-health.json` failures 为空；
   Team r10/operator v5 enabled；本地回归测试；旧会话可打开。
7. 启停烟测，确认无遗留进程，更新交接文档。

## 回滚

- 回滚必须同时恢复 `app`、`home` 与 sessions，不能只降级程序文件（V4 会话迁移不可逆）。
- 备份路径写在 `D:\dsh-test\backup-alpha72-latest.txt`。

## 验收标准

- Web/Headless 配置可加载且无 error。
- Team、Stagehand、CUA、pi-ai、Write Scope、Compaction、Operator 全部 active。
- 两个自定义 preset 可见且可解析。
- 旧真实 Team 会话可打开，五个面板标签正常，浏览器控制台 0 error。
- 启动器仍能取到真实 token URL，堆上限 12GB 生效。
