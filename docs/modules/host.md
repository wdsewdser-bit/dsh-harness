# 模块 · host

应用服务与**唯一驱动**：所有权与 epoch、周期、effect 消费、定时、pre-step/请求边界钩子、恢复、写命令网关、会话路由。协议见 [host-protocol.md](../host-protocol.md)。

- 包名：`@dsh-v2/host`
- 公共入口：`packages/host/index.mjs`
- 允许依赖：`contracts`、`core`、`store`、`context`、`delivery`、`adapter-dsh`
- 测试入口：`npm test -- --only=host`（`packages/host/test`，76 个文件）；profile 级端到端在 `--only=m1b-profile-e2e`、`--only=p3-team`、`--only=p4-projections`。

## 职责

- 生命周期：`createTeamHost`/`TeamHost`、`HOST_STATES`/`HostStateMachine`、`acquireOwnership`（进程内注册 + OS 级独占锁 + 持久 epoch）。
- 驱动：`createCycle`（`CYCLE_STEPS`）、`createClock`、`effect-runner.mjs`（claim → 外部动作 → 回写，含 deferred/unknown）、`src/guard/`（tool-guard，写域与只读工具分类）。
- 写入与路由：`CommandGateway`、`createHumanInputGateway`、`COMMAND_KINDS`/`createCommandAuthorization`、`SessionRouter`（`teamId + memberId + generation` 路由，未路由即 `UNROUTED`）。
- 可见性：`createVisibility`、`visibilityDirty` —— 快照生成与"真实请求载荷确认可见"分开。
- 多团队：`TeamRegistry`、`TeamManager`、`assertSingleMount`。

## 公共接口

单一入口 `.`（另有 `./package.json`）。组合根只通过宿主对象与命令网关接触产品。

## 边界

- 不改领域规则（租约 TTL、准入条件、完成判定归 core），只按规则调用。
- 不生成快照文本（内容归 core），只做注入与确认。
- 不开第二条写路径：所有写命令都经网关 → reducer，`projections` 不再直接调业务写方法。
