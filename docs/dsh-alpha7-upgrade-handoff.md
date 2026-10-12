# DSH 0.1.7-alpha.1 升级交接

范围：`D:\dsh-test`。生产 `D:\dsh` 未修改。

## 结论

- 当前实际最新版本是 `0.1.7-alpha.1`；不存在官方公开的 `0.1.6-alpha.3`。
- 已完成从 `0.1.6-alpha.2` 到 `0.1.7-alpha.1` 的主体升级、持久补丁重建、旧会话兼容、Team Web 面板适配和 preset 声明式迁移。
- Web 与 Headless 配置均可加载；现有 Team、Stagehand、CUA、pi-ai 与浏览器能力均在。
- 旧 Team 会话已用真实 Web 界面验证：成员、冻结、看板、协作房间、消息投递五个标签都能打开，房间详情可见，浏览器控制台 0 error。
- 验证完成后没有留下测试服务进程。最终验收使用不含旧 sessions 的临时 Home，避免自动唤醒旧 Team 继续消耗额度。

## 备份与回滚

完整升级前备份：

```text
D:\dsh-test\backup-alpha7-20260922-201531
D:\dsh-test\backup-alpha7-latest.txt
```

回滚时必须同时恢复 `app`、`home` 和 sessions。0.1.7 已对旧会话做 V4 迁移，不能只降级程序文件。

## 0.1.7 主体变化

### 包与 profile

- `D:\dsh-test\app` 升级到 `@deepseek-ai/dsh@0.1.7-alpha.1`，使用 hoisted 安装。
- `profiles/web` 与 `profiles/headless` 的核心及 Team 依赖升级到 `0.1.7-alpha.1`。
- 官方不再发布 `@deepseek-ai/dsh-experimental-agent-team-web-profile@0.1.7`。Web UI 已合并进 `@deepseek-ai/dsh-experimental-agent-team-profile`，旧 web-profile 行已删除。
- 0.1.6 的 `settings.yaml` 已导入并把配置写进 active profile 的 `cordis.patch.yml`。根目录现在只剩 `settings.yaml.imported`，启动器改为检查 `home\profiles\web\cordis.patch.yml`。

### 旧会话兼容

`D:\dsh-test\app\scripts\apply-local-session-compat.cjs`：

- 由 `app/package.json` 的 `postinstall` 自动执行。
- 只放行旧上下文裁剪曾产生的精确历史形态：`surfaceOp.op === "replace"` 且 `sourceEventSeqs` 非空。
- 覆盖 V0→V1、V3→V4 和 JSONL persistence worker 的所有安装副本。
- 脚本幂等；重复执行没有额外文件变化。

旧会话 `session-7a601594-66f6-4255-92ba-1ef6813cbf1a` 已成功迁移并打开为 V4。不得删除 V3 原始 JSONL。

## 本地持久补丁

Web profile 的 `pnpm-workspace.yaml` 维护：

- `dsh-experimental-agent-team@0.1.7-alpha.1`
  - 保留 `frozen`、`level`、`groupId`、`parentName`、`setMemberFrozen`。
  - 恢复 Team 任务面板所需的 `remoteCreateTask` / `remoteUpdateTask`、host invocation 与 remote descriptor。
- `dsh-experimental-client-ui-agent-team@0.1.7-alpha.1`
  - 重建 Room、Frozen、Boards、Dispatches 标签和任务编辑/完成/重开/删除界面。
  - 修复 0.1.7 primitives 图标改名导致的 React invalid element：映射到 `Icon*Regular`。
  - 保留 `/team meta` 读取 tier/group/board/room/dispatch 数据。
- `dsh-experimental-browser-use-stagehand-native@0.1.7-alpha.1`
  - 保留 Anthropic `baseURL` / `apiKeyEnv` 支持。
- `dsh-llm-pi-ai@0.1.7-alpha.1`
  - 保留 `systemPromptUpdate: in-history`，避免动态系统提示变化破坏前缀缓存。

Headless profile 的 Agent Team 补丁已同步 web 版本，保证两侧领域行为相同。

补丁文件：

```text
D:\dsh-test\home\profiles\web\patches\@deepseek-ai__dsh-experimental-agent-team@0.1.7-alpha.1.patch
D:\dsh-test\home\profiles\web\patches\@deepseek-ai__dsh-experimental-client-ui-agent-team@0.1.7-alpha.1.patch
D:\dsh-test\home\profiles\web\patches\@deepseek-ai__dsh-experimental-browser-use-stagehand-native@0.1.7-alpha.1.patch
D:\dsh-test\home\profiles\web\patches\@deepseek-ai__dsh-llm-pi-ai@0.1.7-alpha.1.patch
```

## Preset 迁移

0.1.7 不再扫描 `$DSH_HOME/.agent-presets`。旧目录已迁移为声明式 `@deepseek-ai/dsh-agent-preset`：

- `minimal-zh-ptc`
- `minimal-zh-ptc-catgirl`

迁移工具：

```text
D:\dsh-test\tools\migrate-alpha7-agent-preset.cjs
```

迁移后位置：

```text
D:\dsh-test\home\profiles\web\presets\minimal-zh-ptc
D:\dsh-test\home\profiles\web\presets\minimal-zh-ptc-catgirl
```

`minimal-zh-ptc` 已补 Windows shell 分叉：

- POSIX 使用 persistent bash。
- Windows 使用 persistent pwsh。
- warmup 的 `shellTools` 已改为 `[bash, pwsh]`。

旧 `.agent-presets` 目录仍保留作人工回退和来源证据，尚未删除。迁移工具是幂等的；重新运行会替换标记之间的声明，不会重复插入。

Web 新会话选择器已确认能看到“极简·中文预热 PTC”和“猫娘·中文预热 PTC”。

## Team Web 面板

0.1.7 官方面板只有成员与共享任务。目前本地面板包含：

- 成员：按 tier/group 分组，显示 frozen、模型、状态。
- 已冻结：默认与活动成员分开。
- 看板：global / level / group board 和任务操作。
- 协作房间：房间列表、轮次、主持人、消息、摘要、决议、未决项。
- 消息投递：dispatch 状态、目标、重试次数和错误。

实现基于官方 tag `dsh-v0.1.7-alpha.1` 与旧面板能力回移。它已经是持久 patch，不依赖 `node_modules` 的一次性手改。

面板底色使用不透明 `bg-base` 垫底，再叠加原来的半透明 menu tint，因此仍保留玻璃质感，但会话正文不会再从面板背后透出。Room 详情的 sticky header 使用同一策略。

## v4 消息来源兼容

0.1.7 的 Session V4 拒绝 `source.kind = "plugin"`。旧 Team 工具生成的提醒消息仍使用这个已退役包装，因此 `send_message` 会在 PTC 中抛：

```text
format v4 message requires a producer-owned source kind
```

- Web 活动实现已切到 `team-tools-v2-r10.mjs`。
- Headless 实现已直接修正 `team-tools-v2.mjs`。
- 所有 Team reminder、milestone snapshot、room snapshot、quiet batch、privilege notice 改为 `kind: 'team-message'`。
- `team-operator-v5.mjs` 与 r10 同步切换，route applier 指向新模块。
- 新回归测试同时断言 `team-message` 被 V4 接受，且旧 `plugin` 包装仍被拒绝。

## 启动器

`D:\dsh-test\start-dsh-test.bat` 已修正：

- 不再要求已迁移消失的 `home\settings.yaml`。
- 改为检查 `home\profiles\web\cordis.patch.yml`。
- 保留 `launch-dsh-test.cjs` 的端口探测、真实 TCP 健康检查、PID/URL 落盘。
- Node old-space 上限从 8GB 调到 12GB：`--max-old-space-size=12288`。

## 验证结果

已执行：

- `app` 与 Web/Headless profile 安装成功。
- Web/Headless `--dump-config`：exit 0，无 error。
- `compatibility-health.json`：`failures=[]`，Team、Stagehand、CUA、Write Scope、Compaction、Operator 全部 active。
- 本地 Phase 1–8：47 个测试文件全部通过，最终输出 `PHASE1_8_ALL_TESTS_PASS`。
- Team host/client Remote：`createTask`、`updateTask`、`view` 三面齐全。
- 两个迁移 preset：JSON 全部可解析，全部 `.mjs` 通过 `node --check`。
- 临时 Web 实例：插件页正常、两个自定义 preset 可见、浏览器控制台 0 error。
- 旧真实 Team 会话：五标签面板和 Room 详情可加载，控制台 0 error。
- Team v4 消息来源回归：`team-message` accepted、retired `plugin` rejected。
- 热重载后 `team-health-web.json` 已确认 r10 与 operator v5 为 enabled。
- 面板截图复查：正文不再透过面板；浏览器控制台 0 error。

## 已知边界

- 本地 Team 面板 patch 较大。升级 0.1.8 时必须对官方 `client-ui-agent-team/lib/client.js` 重新 diff，不能直接套 0.1.7 patch。
- 0.1.7 上游把 Team 任务 Remote 缩成只读；本地补丁恢复了旧写接口。后续升级要核对 `createTask` / `updateTask` 的 wire schema 是否变化。
- `minimal-zh-ptc-catgirl` 的自定义中文工具说明表与上游工具描述可能随版本漂移；仅告警，不阻断启动。
- 临时验收目录 `D:\dsh-test\home-alpha7-smoke` 是本次为安全验收创建的，不含 sessions。确认不再需要后再由用户决定是否删除。
- 最终不要直接双击启动并放任旧 Team 自行恢复；如果旧任务已经不该继续，先处理对应 Team/session 状态再启动。
