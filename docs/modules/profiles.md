# 模块 · profiles

组合根：生成 profile patch、装配端口、固定插件顺序、挂载宿主。它是唯一允许知道所有模块的地方。

- 包名：`@dsh-v2/profiles`
- 公共入口：`packages/profiles/index.mjs`
- 允许依赖：全部
- 测试入口：`--only=profiles`、`--only=profiles-retention`、`--only=profiles-mutation`（后两条是 deep，默认跳过，用 `npm run test:deep`）；profile 级端到端 `--only=m1b-profile-e2e`。

## 职责

- `generate(root, specification)` / `bootProfile`：按调用方给的 specification 生成并启动；specification 就是唯一的类型化配置（包不再导出未使用的 `ProfileSpec` 常量）。
- `team-plugin.mjs`、`projections-plugin.mjs`：插件入口；`host-driver.mjs`：把宿主挂到会话上（`activateHost`、`mainRequestPredicate`）。
- `shell-entries.mjs` / `shell-bash-pin.mjs`：Git Bash 的唯一 shell 提供者（0008）。
- `borrow-*.mjs`、`llm-execution.mjs`、`execution-*.mjs`：super-agent 借鉴与执行域接线。

## 公共接口

单一入口 `.`：`generate`、`bootProfile`、`applyTeamProfile`、`applyTeamProjections`、`activateTeamHost`、`borrowEntrySupport`、`v1BuildCapability`、`registerBusinessTool`。

## 边界

- 配置错误一律 fail-closed：未知 shell、缺必要 guard、版本不符都是 `INVALID_CONFIG` / `PATCH_MISSING`，不退回"能跑就行"。
