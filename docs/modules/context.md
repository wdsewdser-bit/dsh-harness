# 模块 · context

上下文子系统：预算与 75% 闸门、policy 结论、artifact 原文归档与 recall、折叠适配。**唯一**的闸门/预算实现就在这里（0005）。

- 包名：`@dsh-v2/context`
- 公共入口：`packages/context/index.mjs`
- 允许依赖：`contracts`
- 测试入口：`npm test -- --only=adapter-build` 里的 `verification/unit/context-budget.test.mjs` 与 `context-budget-transport.test.mjs`（358k 语义的回归表）。

## 职责

- `budget.mjs`：`estimateInput`（`full-bytes` / `prefix-delta` 两种估算）、`planRequest`（裁决、输出上限、预留）、`checkWire`（保留旧签名）、`measureUsage`、`GATE_RATIO`/`GATE_CODE`。
- `policy.mjs`：`evaluate` 只转述 `planRequest` 的结论，并给出 `optimizationPermit`；`Coordinator` 串行化同一 Session 的历史变更。
- `artifact-store.mjs`、`recall.mjs`：全文归档、带引用截断、ACL 每次重查。
- `fold-adapter.mjs`、`plugin.mjs`：折叠接缝与装配。

## 公共接口

单一入口 `.`，六块实现原样 re-export。

## 边界

- 不依赖 Team（不着色、不读成员）；需要证据时由调用方传入。
- 不碰持久化台账：跨进程"已花多少"归 `verification/real/budget.mjs`（测试侧事实），两者不合并。
- 折叠是**可选优化**，默认关闭；安全压缩是另一层，见 0003。
