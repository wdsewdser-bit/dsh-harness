# 模块 · store

SQLite 持久化：事务、CAS、事件日志、outbox/inbox、恢复游标、保留与压缩。它保存事实，但**不驱动业务**。

- 包名：`@dsh-v2/store`
- 公共入口：`packages/store/index.mjs`
- 允许依赖：`contracts`
- 测试入口：无独立套件（包内没有 `test/`）；由 `--only=core`、`--only=host`、`--only=profiles` 连带覆盖。

## 职责

- `ControlStore`：`node:sqlite`（Node 24 内置，不加第三方依赖）、WAL、`foreign_keys`、耐久提交。
- 版本常量 `TEAM_STORE_VERSION`、`BORROW_STORE_VERSION`；`DEFER_BASE_MS`/`DEFER_CAP_MS`（maintenance 延后的退避）。
- `retention.mjs`：引用闭包、回执压缩、归档与删除同事务。

## 公共接口

单一入口 `.`，主要导出是 `ControlStore` 类与版本常量；所有写入都由 core 的命令在同一事务里调用。

## 边界

- 不知道业务规则：租约 TTL、准入条件、完成判定都在 core。
- 不接受"先落快照后补日志"；一个事务同时更新实体、递增 revision、追加 events、写 outbox。
