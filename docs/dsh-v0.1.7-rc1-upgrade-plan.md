# DSH 0.1.7-rc.1 升级与 Agent Team 适配计划

## 目标

- 将 `D:\dsh-test` 从当前确认的 `0.1.7-alpha.2` 升级到官方 `0.1.7-rc.1`。
- 保留现有 web/headless Profile、会话数据、启动脚本、Agent Team/Room/唤醒/冻结/里程碑硬化补丁。
- 让本地补丁以 RC 版本重新生成并通过语法、加载和最小 Team 测试。
- 不使用用户当前 Minecraft 会话做升级验证；另开独立小测试，供应商使用现有 OpenCodeGo DeepSeek 4.1 配置。
- 升级后启动 DSH，确认原会话可继续，并向 root 说明版本变化、工具变化和当前无需用户验收时可推进的任务边界。

## 官方变化摘要（alpha.2 -> rc.1）

- Agent Team：实验模式统一使用 `spawn_teammate`；默认 teammate 创建上限从 8 提高到 16；任务板改为只读展示，状态通过 Team 工具更新；工具支持按成员名操作，并改善初始任务指引。
- 运行时：插件兼容检查、插件安装/卸载等待与失败隔离、配置/注册初始化串行化、后台长任务与完成唤醒、会话重连/恢复、活动压缩预算保护。
- 交互与工具：MCP 资源发现/读取、Playwright/Chrome DevTools/Stagehand/Cua 实验后端、远程 SSH 工具、归档会话、实时 Team 面板、图片预览和更多 Office 预览。
- 破坏性变化：DeepSeek 官方适配改为 Messages API；PTC 包名统一为 `ptc-runtime`；旧 `subagent`/`subagent_fork` 关闭；旧会话同步 API 弃用；插件/预设与设置的装载方式有迁移要求。

## 执行顺序

1. 确认 DSH 进程停止、D 盘空间和当前安装/补丁清单。
2. 创建带时间戳的备份，至少包含 `app`、`home`、Profile manifests/lockfiles/patches、`patch`、启动脚本、日志和会话控制面数据；不删除旧备份。
3. 保存当前版本与补丁摘要，更新 app/web/headless manifests 和 lockfiles 到 `0.1.7-rc.1`。
4. 在每个 Profile 安装依赖并重新生成/调整本地补丁，避免继续引用 `alpha.2` 的 patch 文件。
5. 检查 `spawn_teammate`、Team task/Room/wake、`in-history`、里程碑压缩、冻结配额和会话格式兼容；对新 API 保留旧会话可恢复路径。
6. 启动 DSH，先做无用户会话影响的健康检查，再开独立小 Team smoke test（OpenCodeGo DeepSeek 4.1）。
7. 恢复/打开用户当前会话，发送升级说明和“用户暂不可验收”的任务边界；核对 root 能收到消息且旧 Team 状态未丢失。

## 验收条件

- app、web、headless 实际加载版本均为 `0.1.7-rc.1`，没有遗留指向 `alpha.2` 的活动 manifest/lock 条目。
- 所有本地补丁可应用，Profile 启动无插件加载错误；`in-history` 和会话格式兼容补丁仍生效。
- 独立 smoke test 能创建/查看/结束一个小 Team，消息和 `team_wake` 投递正常，且不触碰用户当前会话。
- 原会话可以继续，历史、Team roster、Room、任务板和 provider 配置未丢失。
- 若任何破坏性变化无法在不破坏现有会话的情况下适配，停止在该步骤并保留备份，不强行迁移。

## 回滚

- 停止 DSH 后，用本次备份恢复 app/profile manifests、lockfiles、patches、启动脚本和会话控制面数据。
- 不删除或覆盖原有历史备份；回滚后重新运行版本、插件加载和会话可读性检查。

## 参考

- 官方 RC 发布说明：<https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1>
