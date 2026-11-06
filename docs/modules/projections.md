# 模块 · projections

只读投影与 HTTP/SSE 读接口。它是**可删除重建的读模型**，不是事实所有者。

- 包名：`@dsh-v2/projections`
- 公共入口：`packages/projections/index.mjs`
- 允许依赖：`contracts`、`core`（只读）、`store`（只读）
- 测试入口：`npm test -- --only=p4-projections`（e2e），以及 `--only=adapter-build` 里的 `p4-web-poll`、`p4-retention-*`。

## 职责

- `view`、`panel.mjs`、`activity.mjs`、`capabilities.mjs`、`retention.mjs`：看板、面板、记录页、能力与保留视图。
- `serve`（`http.mjs`）：读接口；M6 新增绑定/活动等只读端点。
- `schema.mjs`：投影的形状断言；`schema.md` 是它的说明。

## 公共接口

单一入口 `.`；`Projection` 类、`serve`、`view`、`capabilitiesFor`。

## 边界

- **不再有写命令**：`submit` 只是把请求交给 host 的写网关（0007）。历史上它直接调 `submitReconciliation/submitMailbox/handleTool`，那是第二条写入口，已上移。
- 不允许从投影修复写回权威状态。
