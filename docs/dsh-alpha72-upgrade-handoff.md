# DSH 0.1.7-alpha.2 升级交接

范围：`D:\dsh-test`。生产 `D:\dsh`（仍为 `0.1.5-rc.1`）本次未改动。

## 结论

- 已从 `0.1.7-alpha.1` 升级到官方最新 `0.1.7-alpha.2`（2026-09-22 23:49 北京时间发布，不存在 alpha.3）。
- app、web profile、headless profile 三处安装均成功，本地全部持久补丁已在 alpha.2 源上重新生效。
- 运行期验证通过：所有必需插件 active，Team 本地插件全部 enabled，带 token 的 Web 页面 HTTP 200，
  UI 与插件页正常渲染，当前启动日志无 error。
- 过程中发现并修掉一个**长期失效**的本地策略：里程碑专用压缩以前一直打在已废弃的 npm 扁平副本上，
  对真实 preset 无效。现在改为打到 alpha.2 真实位置，自定义 preset 也已显式配置。

## 备份与回滚

```text
D:\dsh-test\backup-alpha72-20260923-132700     完整 app + home + 启动脚本
D:\dsh-test\backup-alpha72-latest.txt          最新备份路径
D:\dsh-test\docs\dsh-alpha72-upgrade-plan.md   升级计划
```

回滚必须同时恢复 `app`、`home` 与 sessions；V4 会话迁移不可逆，不能只降级程序文件。

## alpha.2 主要变化与影响

对我们有实际收益：

1. 完成后唤醒默认无上限（可显式配上限），修复连续完成多个后台命令/一次性子代理后会话停住。
2. Agent Team 成员初始任务内置“找队友 / 联系 Lead / 按成员名发消息”指引。
3. 修复 Web 服务重启后“显示已连接但不再刷新回复”，重启后恢复连接并保留历史与草稿。
4. 修复持久 PowerShell 命令完成后仍需额外等待。
5. 会话滚动跟随、历史分页、轮次跳转、代码块样式改善。
6. 工具结果按 token 预算保留首尾，被省略内容提供读取地址。

破坏性/需适配：

1. `spill-policy`：`maxInlineBytes` → `maxInlineTokens`（alpha.2 自带 `maxInlineTokens: 12500`）。
   我们未覆盖该项，实际生效值已确认是 12500。
2. vendor 依赖改为精确/补丁级约束：`cordis ~4.0.4`、`cordis-plugin-include ~1.0.9`、
   `cordis-plugin-loader ~1.0.5`、`cordis-plugin-timer ~1.1.6`、`schemastery ~3.18.4`、
   `cosmokit ~1.8.5`。对应 `minimumReleaseAgeExclude` 已同步；`cordis-plugin-group` 由 pnpm 自动补到 1.0.4。
3. **预设位置迁移**：`dsh-agent-presets/presets/<name>/agent.cordis.yml`
   → `dsh-web-app/presets/<name>.patch.yml`。这一条是本次最关键的兼容点。

## 本次实际改动

### 版本与安装

- `app/package.json`、`app/pnpm-workspace.yaml`：`@deepseek-ai/dsh@0.1.7-alpha.2`，全部 `dsh-*` 版本同步。
- `home/profiles/{web,headless}/package.json` 与 `pnpm-workspace.yaml`：同步 alpha.2，并重建锁文件。
- 旧锁文件保留为 `pnpm-lock.yaml.alpha1-bak`。
- 供应链策略曾用旧锁拦截（alpha.1 包距发布不足 24h），处理方式：移走旧锁 +
  移除 `node_modules/.pnpm/lock.yaml` 后重新解析。
- **app 做过一次干净重装**：旧树里残留 266 个 alpha.1 扁平包（早期 npm 安装遗留），
  hoisted 根目录与 `.pnpm` 不一致。重装后 0 个 alpha.1 残留。

### 持久补丁（web）

```text
patches/@deepseek-ai__dsh-experimental-agent-team@0.1.7-alpha.2.patch
patches/@deepseek-ai__dsh-experimental-client-ui-agent-team@0.1.7-alpha.2.patch
patches/@deepseek-ai__dsh-experimental-browser-use-stagehand-native@0.1.7-alpha.2.patch
patches/@deepseek-ai__dsh-llm-pi-ai@0.1.7-alpha.2.patch
```

- 前三个补丁改动的 `lib/*.js` 在 alpha.1→alpha.2 之间**逐字节相同**，只需换版本键与文件名。
- stagehand 补丁的 `package.json` hunk 必须重写：alpha.2 把依赖从 caret 改成精确 pin，
  原上下文已失配。新 hunk 对齐 alpha.2，并保留 `lib/anthropic-model.js` 与
  `@deepseek-ai/dsh-credentials` peer 依赖。
- headless 的两个补丁同步更名。

### 启动器强制补丁（重要）

旧脚本按固定路径写死，alpha.2 换布局后会直接让启动器 `exit(1)`。两个脚本已重写为**遍历发现目标**：

```text
D:\dsh-test\patch\settlement-guard.cjs            （原 ensure-subagent-settlement-guard.cjs）
D:\dsh-test\patch\milestone-only-compaction.cjs   （原 ensure-milestone-only-compaction.cjs）
```

- 结算守卫：团队成员的子代理结算不再打断上级开新回合，改为 `inject` 到下一步。
  上游 alpha.2 **没有**采纳这个行为，守卫仍必须保留。
- 里程碑专用压缩：给 `compaction-basic` 行加 `auto: false`。
  - 目标涵盖 `dsh-web-app/presets/{ptc,standard,cordis,minimal}.patch.yml`（alpha.2 新位置）
    与旧 `dsh-agent-presets/...` 布局。
  - 找不到目标或锚点时只告警、不再阻断启动，避免版本漂移把 DSH 卡死。
- 我们自己的两个 preset（`minimal-zh-ptc`、`minimal-zh-ptc-catgirl`）已在
  `home/profiles/web/cordis.patch.yml` 里显式写入 `auto: false`（由
  `tools/apply-profile-milestone-policy.cjs` 幂等写入）。

> **历史问题**：升级前的里程碑补丁一直打在 `dsh-agent-presets@0.1.6-alpha.2`（早期 npm 扁平遗留），
> 而真正生效的 preset 来自 `.pnpm/@deepseek-ai+dsh-web-app*`。所以“没勾里程碑却压缩”并非模型忘记用工具，
> 而是策略从未真正生效。本次已修正。

## 验证结果

- `app`：`@deepseek-ai/dsh 0.1.7-alpha.2`；app 树 alpha.1 残留 0 个。
- 补丁标记全部命中：`agent-team.setMemberFrozen`、`client-ui` Room 面板、stagehand
  `lib/anthropic-model.js`、`llm-pi-ai in-history`（web 与 headless 均验证）。
- Web/Headless `--dump-config`：均 exit 0，无 error；web 配置里 `maxInlineTokens: 12500`、
  `auto: false` 共 5 处。
- 运行中的实例：PID 36240，端口 40123，`--max-old-space-size=12288`。
- `home/compatibility-health.json`：`ready=true`、`failures=[]`、12 项 required 全 active
  （agent-team、team-policy、tool-agent-team-v2、write-scope-guard、team-runtime-guard、
  team-health、step-compaction、team-operator、browser-use、stagehand、computer-use、cua）。
- `home/team-health-web.json`：`status=healthy`，`team-tools-v2-r10.mjs`、`team-operator-v5.mjs`
  等本地插件全部 enabled。
- 浏览器冒烟（Edge + playwright-cli）：页面标题 DeepSeek Harness，HTTP 200，会话侧栏、
  “插件”全局面板、插件页（官方 5 项 + 已安装“智能体团队”开关打开）均正常渲染，无新 console 日志。
- 未打开任何旧会话，因此没有触发旧 Team 自动恢复；进程表只有 DSH 服务本体。

## 已知边界与后续

- 本地 Team 面板补丁体量大，升级 0.1.8 时必须重新对官方 `client-ui-agent-team/lib/client.js` 做 diff。
- `minimal.patch.yml` 没有 `compaction-basic` 行，属预期（极简 preset 不挂压缩链）。
- `D:\dsh-test\tmp\t120` 残留约 3 MB，被残留 java 进程占用，未强杀。
- 生产 `D:\dsh` 仍是 `0.1.5-rc.1`，若要升级是跨大版本（会话格式 V3→V4），需另做计划。
- 启动器强制补丁现在“发现不到目标只告警”，如果将来上游改了 `dsh-subagent` 结算逻辑，
  需要人工确认守卫是否仍必要。
