# 模块 · adapter-dsh

上游版本适配层：把公开的 agent/session/compaction/llm 接口、离线会话日志、executor、shell 封装起来，隔离版本差异。

- 包名：`@dsh-v2/adapter-dsh`
- 公共入口：`packages/adapter-dsh/index.mjs`
- 允许依赖：`contracts`
- 测试入口：`npm test -- --only=adapter-build`（`verification/unit/build-target.test.mjs`、`driver-surface.test.mjs` 等）。

## 职责

- `buildTarget(build, { boundaryWakeOnly })`：**唯一的版本判定点**，读构建里的 dsh 版本并探测 executor 包；见 0001。
- `load`（只读上游安装）、`loadBuild`（本次构建副本）、`host(root)`（组合宿主）、`openSessionLog`（冷启动读持久日志）、`sessionUsage`、`nativeProcessIdentity`、`providerReplay`。
- `role-tool-boundary.mjs`：按角色裁剪模型可见工具。

## 公共接口

单一入口 `.`；`buildTarget` 与 `load` 是跨包使用的关键符号（`profiles` 用它、`core` 的变异测试用它）。

## 边界

- 不实现团队语义；只提供上游能力与版本适配。
- 构建路径来自 `build/builds.json`（`default` + `pristine` 两个键），不写死在代码里。
