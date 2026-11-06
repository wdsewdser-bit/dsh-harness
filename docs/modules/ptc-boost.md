# 模块 · ptc-boost

- 包名：`dsh-ptc-boost`（`private`）
- 公共入口：`packages/ptc-boost/index.js` 与 `./lib/*`
- 允许依赖：**不在依赖矩阵内**（上游插件叠层，纯 `.js`，依赖都在上游包里；`check-deps` 不扫描它，见 `verification/check-deps.mjs` 的 `OUTSIDE_MATRIX`）
- 测试入口：无独立套件（包内没有 `test/`）；它随上游插件一起加载，行为由 `--only=adapter-build` 与 `--only=core` 里的工具合同断言间接覆盖

本模块的权威规格在包里，这里不复制：

- [packages/ptc-boost/README.md](../../packages/ptc-boost/README.md) —— 是什么、怎么装、边界
- [packages/ptc-boost/DESIGN.md](../../packages/ptc-boost/DESIGN.md) —— 设计

一句话：PTC 沿用上游运行时（`dsh-ptc-runtime` / `dsh-ptc-runtime-node`），PTC 内每次 `tools.*` 调用都走同一工具执行链、同一 `post-execute` 归档与同一角色授权，不建立第二套业务语义，也不是额外调度器。
