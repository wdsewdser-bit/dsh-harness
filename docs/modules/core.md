# 模块 · core

纯领域规则与**唯一的命令 reducer**。工具、API、UI、宿主都只把请求翻译成命令，领域写入只在这里发生（[architecture.md](../architecture.md) 规则 2）。

- 包名：`@dsh-v2/core`
- 公共入口：`packages/core/index.mjs`
- 允许依赖：`contracts`
- 测试入口：`npm test -- --only=core`（`packages/core/test`，32 个文件）；聚合回归 `--only=domain/p3-core`、`--only=domain/p3-regressions`。

## 职责

- 组织与授权：`authorize`、`toolDescription`、`rolePrompt`、`borrowGuidance`、`authority.mjs`、`authorization.mjs`。
- 调度与租约：`commands/`（任务、合同、attempt、lease、release）、`control-capacity.mjs`（人类保留容量与 provider 限流占用）。
- 消息与线程：`mailbox.mjs`、`collab.mjs`、`threads.mjs`、`commands/messages.mjs`、`commands/intents.mjs`（沉默即同意窗口）、`commands/decisions.mjs`。
- 驱动用的纯逻辑：`runtime.mjs`（`drain`、`heartbeat`、`sweepInterruptedClaims`）、`provenance.mjs`（`preStep`、`requestBoundary`、批处理版本）、`snapshot.mjs`（快照内容生成）、`effects.mjs`、`native.mjs`。
- goal 与交付：`goal-gate.mjs`、`commands/goals.mjs`、`commands/execution.mjs`、`read-model.mjs`、`operator-command.mjs`（`COMPLETION_FROZEN` 的唯一出处）。

## 公共接口

单一入口 `.`。导出按用途分组：命令（`commands/*`）、驱动纯函数（`drain`/`heartbeat`/`preStep`/`requestBoundary`）、快照、授权、容量、recovery（`recoverFacts`、`systemRecover`、`createRecoveryScope`）。

## 边界

- **不驱动自己**：`drain`/`heartbeat` 是纯函数，调用方是 `host`。测试直接测 reducer 是允许的（规则 3），产品级集成测试不得替产品驱动。
- 不碰 SQLite 句柄、不碰 Git、不碰上游 API；这些经端口类型从 `contracts` 取得。
- 快照**内容**在这里生成；注入与请求边界观测在 `host` + `adapter-dsh`。
