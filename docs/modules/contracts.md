# 模块 · contracts

版本化的 ID、错误码、命令与事件 schema、deadline、工具定义、端口类型，以及跨模块共享的常量。它是**纯数据与纯函数**层：不碰 IO，不依赖任何其它包。

- 包名：`@dsh-v2/contracts`
- 公共入口：`packages/contracts/index.mjs`
- 允许依赖：无（矩阵第一行）
- 测试入口：无独立套件（包内没有 `test/`）；由 `npm test -- --only=core`、`--only=host`、`--only=profiles` 间接覆盖，规则本身由 `npm run check:deps` 与各包断言锁定。

## 职责

- ID 与错误：`id(kind)`、`hash(payload)`、`codes`、`fail(code)`、`failWith(code, detail)`、`operationIdPattern`。
- 配置与规则常量：`config(overrides)`、`collabConfig(overrides)`、`GATE_RATIO = 0.75`（唯一的 75% 常量，见 0004）。
- 领域类型：`canonical`、`digest`、`validateDependency`（`team.mjs`）、deadline 归一化（`deadline.mjs`）、执行身份与 scope（`execution.mjs`）、effect 结果形状（`effect-outcome.mjs`）、派发证据（`dispatch.mjs`）。
- 合同：团队自主化（`autonomy.mjs` + `autonomy.schema.json`）、super-agent 借鉴（`superagent-borrow.mjs` + schema）。

## 公共接口

`exports` 里有四个入口：`.`（`index.mjs`）、`./team.mjs`、`./deadline.mjs`、`./team-tools.mjs`。后三个是**显式声明**的公共子入口，跨包导入它们不算深导（`check-deps` 规则 b）。

## 边界

- 不写库、不读盘、不 import `store`/`core`。
- schema 是"拒绝不可解释输入"的地方：缺字段、别名冲突、越界值一律 `INVALID_CONFIG` / `UNKNOWN_BUDGET`，不静默取默认。
