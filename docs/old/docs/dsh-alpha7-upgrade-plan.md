# DSH 0.1.6-alpha.2 → 0.1.7-alpha.1 升级计划

范围：`D:\dsh-test`。生产 `D:\dsh` 不改。

## 结论

- 官方没有公开的 `0.1.6-alpha.3`，当前最新为 `0.1.7-alpha.1`。
- 这是大版本迁移，不是普通依赖更新。
- 最大风险：Session V4、Agent preset 声明式迁移、Settings 导入一次、Team Web profile 合并、本地 Team/缓存/Stagehand patch 适配。

## 回滚点

```text
D:\dsh-test\backup-alpha7-20260922-201531
```

已备份：

- `app`：0.538GB
- `home`：2.185GB，含 settings、凭据、sessions、profiles、presets、Team 控制面

## 升级顺序

1. 更新 `app/package.json` 到 `@deepseek-ai/dsh@0.1.7-alpha.1` 并安装。
2. 更新 `profiles/web/package.json`：
   - browser-use、computer-use、stagehand、CUA、team-profile、llm-pi-ai 全部升到 `0.1.7-alpha.1`
   - 删除 `@deepseek-ai/dsh-experimental-agent-team-web-profile`
   - `dsh.profile.bundles` 删除 web-profile
3. 更新 `profiles/headless/package.json`：
   - team-profile、llm-pi-ai 升到 `0.1.7-alpha.1`
4. 重新生成本地 patch：
   - `@deepseek-ai/dsh-experimental-agent-team`：保留 frozen/level/group/parent 支持
   - `@deepseek-ai/dsh-experimental-browser-use-stagehand-native`：保留 Anthropic baseURL/apiKeyEnv 支持
   - `@deepseek-ai/dsh-llm-pi-ai`：保留 `systemPromptUpdate: in-history`
   - `@deepseek-ai/dsh-experimental-client-ui-agent-team`：保留 Room/Frozen/Tabs/消息投递面板扩展
5. 迁移 Agent presets：
   - 以官方 `ptc` patch 为基线
   - 将当前有效自定义 preset 转为 `@deepseek-ai/dsh-agent-preset`
6. 迁移 Settings：
   - 备份后让 0.1.7 导入一次
   - 核对 `llm-pi-ai`、`llm-deepseek`、默认模型、权限、web search
7. 兼容本地 Team 工具：
   - `team-tools-v2-r9`
   - `team-policy`
   - `team-control-plane`
   - `team-operator-v4`
   - idle watch / digest
8. 验证：
   - `--dump-config`
   - Web/headless 启动
   - V3 会话副本迁移
   - provider/model、搜索、浏览器、Team spawn/room/task/reopen/idle-watch
   - 全部本地 Phase 1–8 测试

## 回滚

失败时恢复备份中的 `app` 与 `home`。如果 alpha7 已写 V4 会话，必须连 sessions 一起恢复，不能只降级程序文件。

## 已知阻塞

`@deepseek-ai/dsh-experimental-agent-team-web-profile` 没有 `0.1.7-alpha.1`。其 Web UI 已并入 `@deepseek-ai/dsh-experimental-agent-team-profile@0.1.7-alpha.1`。
